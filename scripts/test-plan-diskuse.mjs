// Kontrolní test plánu střihu na JINÉM materiálu a zadání než test-hermes-loop (proti přeladění na jednu debatu).
// node scripts/test-plan-diskuse.mjs [počet kol] [backend]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const SRC = `${ROOT}/test/podcast/Diskuse1.mp4`;
const ROUNDS = Number(process.argv[2] || 3);
const BACKEND = process.argv[3] || 'hermes';
const TARGET = 120;
const TASK =
  'Dvouminutový sestřih o masifikaci vysokého školství: kolik lidí dnes studuje oproti minulosti a jaký je rozdíl ' +
  'mezi masifikací a skutečnou demokratizací vzdělání, bez moderátora a organizačních vět.';
// ručně ověřené: jádro zadání = věty 122–163 (čísla o studentech, masifikace vs. demokratizace, komodifikace diplomu)
const CORE = (i) => i >= 122 && i <= 163;

const c = new Client({ name: 'plan-diskuse', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return { sec: (Date.now() - t0) / 1000, text: r.content[0].text };
};
const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const tr = JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
const byId = new Map(tr.segments.map((s) => [s.id, s]));

const rows = [];
for (let i = 1; i <= ROUNDS; i++) {
  process.stdout.write(`\n${i}) plán (${BACKEND})… `);
  try {
    const r = await call('plan_edit_local', { path: SRC, instruction: TASK, targetSec: TARGET, backend: BACKEND });
    const plan = JSON.parse(r.text);
    const ids = plan.picks;
    const dur = (i) => byId.get(i).end - byId.get(i).start;
    const text = (i) => byId.get(i).text.trim();
    const total = ids.reduce((a, i) => a + dur(i), 0);
    const coreSec = ids.filter(CORE).reduce((a, i) => a + dur(i), 0);
    const m = {
      dur: plan.estimatedSec,
      n: ids.length,
      coreShare: Math.round((100 * coreSec) / Math.max(1, total)),
      moderator: ids.filter((i) => byId.get(i).speaker === 'S3').length,
      fragments: ids.filter((i) => text(i)[0] === text(i)[0].toLowerCase() && /\p{L}/u.test(text(i)[0]) && !ids.includes(i - 1)).length,
    };
    rows.push({ round: i, sec: r.sec, ...m, picks: ids });
    console.log(`${r.sec.toFixed(0)} s · ${m.dur} s (cíl ${TARGET}) · ${m.n} vět · v jádru ${m.coreShare} % · moderátor ${m.moderator} · useknuté ${m.fragments}`);
    console.log('   mimo jádro:', ids.filter((i) => !CORE(i)).map((i) => `#${i} ${text(i).slice(0, 50)}`).join(' | ') || '—');
  } catch (e) {
    console.log(`✖ ${e.message.slice(0, 200)}`);
    rows.push({ round: i, error: e.message.slice(0, 200) });
  }
}
fs.mkdirSync(`${ROOT}/test/hermes-loop`, { recursive: true });
fs.writeFileSync(`${ROOT}/test/hermes-loop/diskuse-results.json`, JSON.stringify(rows, null, 1));
await c.close();
