// 5 kol testu Hermese na stejném zadání: měří kvalitu i stabilitu výsledku.
// node scripts/test-hermes-loop.mjs [počet kol]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const SRC = 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';
const ROUNDS = Number(process.argv[2] || 5);
const TARGET = 180;
const TASK =
  'Tříminutový sestřih o bydlení a parkování: nejkonkrétnější argumenty obou hostů (co chtějí udělat a čím to zdůvodňují), ' +
  'bez úvodních a organizačních vět moderátora, bez opakování.';
// moderátor se pozná podle mluvčího v přepisu (dřívější pevný seznam ID pocházel ze starší verze přepisu a obsahoval i věty hostů)
// ručně ověřené odbočky mimo bydlení/parkování (výstava, sloup UNESCO, "Olomouc rozkvetla", zkrácení tramvajové linky 243–271)
// čísla podle přepisu s diarizací (01a7…, 365 vět); starší přepisy bez diarizace mají 362 vět a jiné číslování
const OFFTOPIC_IDS = new Set([20, 21, 30, 31, 32, 38, ...Array.from({ length: 29 }, (_, i) => 243 + i)]);

const c = new Client({ name: 'hermes-loop', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return { sec: (Date.now() - t0) / 1000, text: r.content[0].text };
};
const transcript = () => {
  const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
  return JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
};

// 0) mluvčí do přepisu (z cache diarizace) – bez nich nejde pravidlo "bez moderátora"
console.log('0) mluvčí v přepisu');
let tr = transcript();
if (!tr.speakers?.length) {
  const d = await call('diarize_media', { path: SRC });
  console.log('  ', d.text.split('\n')[0]);
  tr = transcript();
}
console.log('   mluvčí v přepisu:', tr.speakers?.join(', ') || '— žádní');

const metrics = (plan, tr2) => {
  const byId = new Map(tr2.segments.map((s) => [s.id, s]));
  const ids = plan.picks;
  const text = (i) => (byId.get(i)?.text || '').trim();
  const speaker = (i) => byId.get(i)?.speaker || '';
  return {
    dur: plan.estimatedSec,
    n: ids.length,
    moderator: ids.filter((i) => /moder/i.test(speaker(i))).length,
    offtopic: ids.filter((i) => OFFTOPIC_IDS.has(i)).length,
    // podíl řeči Ferancové mezi oběma hosty (zadání chce "argumenty obou hostů")
    ferShare: (() => { const d = (i) => byId.get(i).end - byId.get(i).start; const g = ids.filter((i) => /feranc|vaš/i.test(speaker(i))); return Math.round((100 * g.filter((i) => /feranc/i.test(speaker(i))).reduce((a, i) => a + d(i), 0)) / Math.max(1, g.reduce((a, i) => a + d(i), 0))); })(),
    fragments: ids.filter((i) => /\p{Ll}/u.test(text(i)[0] || '') && !ids.includes(i - 1)).length,
    parking: ids.filter((i) => /park|zón|automat|štenbersk|P plus R/i.test(text(i))).length,
    housing: ids.filter((i) => /byt|bydlen|develop|nájem|pozemk|výstavb|senior|nemovit/i.test(text(i))).length,
    removedModerator: (plan.removedModerator || []).length,
    fixedFragments: (plan.fixedFragments || []).length,
  };
};

const rows = [];
for (let i = 1; i <= ROUNDS; i++) {
  process.stdout.write(`\n${i}) plán střihu (Hermes)… `);
  try {
    const r = await call('plan_edit_local', { path: SRC, instruction: TASK, targetSec: TARGET, backend: 'hermes' });
    const plan = JSON.parse(r.text);
    const m = metrics(plan, transcript());
    rows.push({ round: i, sec: r.sec, ...m, topicSec: plan.topicSec, picks: plan.picks });
    console.log(
      `${r.sec.toFixed(0)} s · ${m.dur} s (cíl ${TARGET}) · ${m.n} vět · moderátor ${m.moderator} · useknuté ${m.fragments} · odbočky ${m.offtopic} · Ferancová ${m.ferShare} %` +
        ` · parkování ${m.parking} / bydlení ${m.housing} · automaticky vyhozeno: moderátor ${m.removedModerator}, opraveno vět ${m.fixedFragments}` +
        (plan.topicSec ? ` · témata ${Object.entries(plan.topicSec).map(([k, v]) => `${k} ${Math.round(v)} s`).join(" / ")}` : ""),
    );
  } catch (e) {
    console.log(`✖ ${e.message.slice(0, 200)}`);
    rows.push({ round: i, error: e.message.slice(0, 200) });
  }
}

const ok = rows.filter((r) => !r.error);
if (ok.length) {
  const avg = (k) => (ok.reduce((a, r) => a + r[k], 0) / ok.length).toFixed(1);
  const rng = (k) => `${Math.min(...ok.map((r) => r[k]))}–${Math.max(...ok.map((r) => r[k]))}`;
  console.log(`\n=== ${ok.length}/${ROUNDS} kol prošlo`);
  console.log(`délka: průměr ${avg('dur')} s (rozptyl ${rng('dur')}), cíl ${TARGET}`);
  console.log(`vět: průměr ${avg('n')} (${rng('n')}) · čas: průměr ${avg('sec')} s`);
  console.log(`vady: moderátor ${ok.reduce((a, r) => a + r.moderator, 0)}× celkem, useknuté ${ok.reduce((a, r) => a + r.fragments, 0)}× celkem, odbočky ${ok.reduce((a, r) => a + r.offtopic, 0)}× celkem`);
  const all = ok.map((r) => new Set(r.picks));
  const common = [...all[0]].filter((id) => all.every((s) => s.has(id)));
  const union = new Set(ok.flatMap((r) => r.picks));
  console.log(`stabilita výběru: ${common.length} vět ve všech kolech, dohromady použito ${union.size} různých vět`);
}
fs.mkdirSync(`${ROOT}/test/hermes-loop`, { recursive: true });
fs.writeFileSync(`${ROOT}/test/hermes-loop/results.json`, JSON.stringify(rows, null, 1), 'utf8');
await c.close();
process.exit(rows.some((r) => r.error) ? 1 : 0);
