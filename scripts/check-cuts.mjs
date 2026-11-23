// Kontrola hranic střihu: neusekne se slovo? Pro každý zvukový klip sekvence změří hlasitost těsně u začátku
// a konce (proti řeči v okolí) a hledá slova přepisu, která hranice protíná.
//   node scripts/check-cuts.mjs "<název nebo ID sekvence>"
// Výstup: řádek na hranici; ✖ = hranice protíná slovo nebo je tam hlasitý zvuk (> -12 dB proti řeči).
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cesta s mezerami: .pathname by nechal %20
const seqArg = process.argv[2];
const c = new Client({ name: 'check-cuts', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server', 'index.js')], env: { ...process.env } }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
const seq = JSON.parse(await call('get_sequence', seqArg ? { sequence: seqArg } : {}));
await c.close();

const clips = (seq.clips || []).filter((x) => x.kind === 'audio' && x.mediaPath);
const bySrc = new Map();
for (const cl of clips) {
  if (!bySrc.has(cl.mediaPath)) bySrc.set(cl.mediaPath, []);
  bySrc.get(cl.mediaPath).push(cl);
}
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'transcripts', 'index.json'), 'utf8'));
let bad = 0;
let n = 0;
console.log(`Sekvence „${seq.name}" – ${clips.length} zvukových klipů`);
for (const [src, cls] of bySrc) {
  const trFile = idx[path.resolve(src).toLowerCase()];
  const words = trFile && fs.existsSync(trFile)
    ? JSON.parse(fs.readFileSync(trFile, 'utf8')).segments.flatMap((s) => s.words || []) : [];
  const edges = cls.flatMap((cl) => [{ t: cl.inPoint, kind: 'in' }, { t: cl.outPoint, kind: 'out' }]);
  const py = spawnSync(path.join(ROOT, '.venv', 'Scripts', 'python.exe'), [path.join(ROOT, 'scripts', 'edge_check.py')],
    { input: JSON.stringify({ path: src, edges }), encoding: 'utf8', maxBuffer: 1 << 24 });
  if (py.status) throw new Error(py.stderr.slice(-800));
  const res = JSON.parse(py.stdout.trim().split(/\r?\n/).pop());
  for (const r of res) {
    n++;
    const cut = words.find((w) => w.s < r.t - 0.01 && w.e > r.t + 0.01);
    const near = words.filter((w) => Math.abs((r.kind === 'in' ? w.s : w.e) - r.t) < 0.6)
      .map((w) => `${w.w}(${(((r.kind === 'in' ? w.s : w.e) - r.t) * 1000).toFixed(0)}ms)`).join(' ');
    const loud = r.rel > -12;
    // časy slov z Whisperu bývají o desítky ms vedle (konce pozdě) – „protíná slovo“ je chyba, jen když je hranice
    // i slyšitelná; ve zvuku tichá hranice uvnitř slova podle přepisu je v pořádku
    const cutAudible = cut && r.rel > -20;
    const fail = cutAudible || loud;
    if (fail) bad++;
    console.log(`${fail ? '✖' : '✔'} ${r.kind === 'in' ? 'začátek' : 'konec  '} ${r.t.toFixed(3)} s  ` +
      `hranice ${r.rel} dB proti řeči${cut ? (cutAudible ? `  · protíná slovo „${cut.w}"` : `  · (podle přepisu ve slově „${cut.w}", zvuk ticho)`) : ''}${loud ? '  · hlasitý zvuk na hranici' : ''}  [${near}]`);
  }
}
console.log(bad ? `\n✖ ${bad} z ${n} hranic podezřelých` : `\n✔ všech ${n} hranic čistých`);
process.exit(bad ? 1 : 0);
