// Regresní test krátkých střihů (výrok / highlight do 60 s): Hermes vs. referenční výběr Clauda.
// Pro každý případ pustí lokální střih (scripts/local-edit.mjs, stejně jako panel), pak změří:
//   shoda s referencí (překryv vět), délka proti cíli, čisté hranice (scripts/check-cuts.mjs), čas plánu.
//   node scripts/test-highlight.mjs [filtr názvu případu]
// Případy: scripts/highlight-cases.json (sekvence v otevřeném projektu, zadání, cílová délka, reference = ID vět).
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cesta s mezerami: .pathname by nechal %20
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'highlight-cases.json'), 'utf8'))
  .filter((c) => !process.argv[2] || c.name.includes(process.argv[2]));
const rows = [];
for (const c of cases) {
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'local-edit.mjs'), 'hermes'], {
    input: c.instruction, encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, PMCP_SEQUENCE: c.sequence, PMCP_TARGET_SEC: String(c.target) },
  });
  const sec = (Date.now() - t0) / 1000;
  const name = (r.stdout.match(/hotovo: sekvence „([^“"]+)["“]/) || [])[1];
  if (!name) {
    rows.push({ case: c.name, error: (r.stdout + r.stderr).slice(-400) });
    console.log(`✖ ${c.name}: sekvence nevznikla\n${(r.stdout + r.stderr).slice(-400)}`);
    continue;
  }
  const txt = execFileSync('node', [path.join(ROOT, 'scripts', 'seq-text.mjs'), name], { encoding: 'utf8', cwd: ROOT });
  const ids = [...txt.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const dur = Number((txt.match(/\(([\d.]+) s\)/) || [])[1] || 0);
  const chk = spawnSync('node', [path.join(ROOT, 'scripts', 'check-cuts.mjs'), name], { encoding: 'utf8', cwd: ROOT });
  const clean = chk.status === 0;
  // další technické drobnosti (utnutá věta, začátek na nevyřčené, moderátor, délka ±25 %, mezery, odpad přepisu) – scripts/qa-sequence.mjs
  const qa = spawnSync('node', [path.join(ROOT, 'scripts', 'qa-sequence.mjs'), name, String(c.target), '--no-cuts'], { encoding: 'utf8', cwd: ROOT });
  const qaFails = qa.status === 0 ? [] : (qa.stdout.match(/^✖ .+$/gm) || ['✖ qa-sequence selhal']).filter((l) => !/^✖ \d+ z \d+ kontrol/.test(l));
  // shoda = nejlepší překryv s referencí nebo s jednou z rovnocenných alternativ (dobrých výroků bývá víc)
  const ov = (set) => Math.round((100 * ids.filter((i) => set.includes(i)).length) / new Set([...ids, ...set]).size);
  // upoutávky reference nemají (dobrých kombinací úderů je mnoho) – shoda se nepočítá
  const overlap = c.reference.length ? Math.max(ov(c.reference), ...(c.acceptable || []).map(ov)) : null;
  const row = { case: c.name, target: c.target, dur, ids: ids.join(','), ref: c.reference.join(','), overlap, clean, qa: qaFails.length ? qaFails.map((l) => l.slice(2)).join('; ') : 'ok', sec: Math.round(sec) };
  rows.push(row);
  console.log(`${clean ? '✔' : '✖'} ${c.name}: ${dur} s (cíl ${c.target}) · věty ${row.ids} · reference ${row.ref} · shoda ${overlap} % · ` +
    `hranice ${clean ? 'čisté' : 'PODEZŘELÉ'} · QA ${row.qa} · ${row.sec} s\n${txt.split('\n').filter((l) => l.startsWith('  [')).join('\n')}`);
  if (!clean) console.log(chk.stdout.split('\n').filter((l) => l.startsWith('✖')).join('\n'));
}
const ok = rows.filter((r) => !r.error);
console.log(`\nShrnutí: ${ok.length}/${rows.length} vzniklo · čisté hranice ${ok.filter((r) => r.clean).length}/${ok.length} · QA bez ✖ ${ok.filter((r) => r.qa === 'ok').length}/${ok.length} · ` +
  `průměrná shoda s referencí ${Math.round(ok.filter((r) => r.overlap !== null).reduce((a, r) => a + r.overlap, 0) / Math.max(1, ok.filter((r) => r.overlap !== null).length))} % · ` +
  `průměrná odchylka délky ${Math.round(ok.reduce((a, r) => a + Math.abs(r.dur - r.target) / r.target, 0) / Math.max(1, ok.length) * 100)} %`);
fs.mkdirSync(path.join(ROOT, 'cache', 'test-highlight'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'cache', 'test-highlight', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  JSON.stringify(rows, null, 1));
