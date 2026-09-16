// Test Workeru a střihu více kamer na syntetickém rozhovoru (test/multicam/gt.json).
// node scripts/test-worker.mjs [status transcribe diarize sync names multicam analyze llm premiere]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const GT = JSON.parse(fs.readFileSync(`${ROOT}/test/multicam/gt.json`, 'utf8'));
const REF = GT.reference;
const steps = process.argv.slice(2);
const want = (s) => !steps.length || steps.includes(s);
const normKey = (p) => path.resolve(p).toLowerCase();

const c = new Client({ name: 'test-worker', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
let failed = 0;
async function call(name, args = {}, max = 2500) {
  const t0 = Date.now();
  let lastP = -1;
  const r = await c.callTool({ name, arguments: args }, undefined, {
    timeout: 3600000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      if (p.progress - lastP >= 0.25) {
        lastP = p.progress;
        console.log(`   .. ${Math.round(p.progress * 100)}% ${p.message || ''}`);
      }
    },
  });
  const text = r.content[0].text;
  console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ✖ ERROR' : ''}\n${text.slice(0, max)}`);
  if (r.isError) failed++;
  return r.isError ? null : text;
}

const speakersAt = (turns, t) => [...new Set(turns.filter((x) => t >= x.start && t < x.end).map((x) => x.speaker))];

if (want('status')) await call('worker_status');
if (want('transcribe')) await call('transcribe_media', { path: REF, maxChars: 1500 });

let mapping = null;
if (want('diarize')) {
  await call('diarize_media', { path: REF, numSpeakers: 2 });
  const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/diarization/index.json`, 'utf8'));
  const dia = JSON.parse(fs.readFileSync(idx[normKey(REF)], 'utf8'));
  const co = {};
  let total = 0;
  let good = 0;
  for (let t = 0; t < GT.duration; t += 0.1) {
    const g = speakersAt(GT.turns, t);
    const p = speakersAt(dia.turns, t);
    if (g.length === 1 && p.length === 1) (co[p[0]] ??= {})[g[0]] = (co[p[0]][g[0]] || 0) + 1;
  }
  mapping = Object.fromEntries(Object.entries(co).map(([s, m]) => [s, Object.entries(m).sort((x, y) => y[1] - x[1])[0][0]]));
  for (let t = 0; t < GT.duration; t += 0.1) {
    const g = speakersAt(GT.turns, t);
    if (g.length !== 1) continue;
    total++;
    const p = speakersAt(dia.turns, t);
    if (p.length && p.some((s) => mapping[s] === g[0])) good++;
  }
  console.log(`   DIARIZACE: mapování ${JSON.stringify(mapping)} · shoda ${((100 * good) / total).toFixed(1)} % času řeči`);
  fs.writeFileSync(`${ROOT}/test/multicam/mapping.json`, JSON.stringify(mapping));
}

if (want('sync')) {
  const others = [...GT.cameras.map((x) => x.source), ...GT.mics.map((x) => x.path)];
  const text = await call('sync_media', { reference: REF, others });
  if (text) {
    for (const cam of GT.cameras) {
      const m = text.match(new RegExp(`${path.basename(cam.source)}: offset (-?[\\d.]+)`));
      const got = m ? Number(m[1]) : NaN;
      console.log(`   SYNC ${path.basename(cam.source)}: čekáno ${cam.offset}, zjištěno ${got}, chyba ${Math.abs(got - cam.offset).toFixed(3)} s`);
    }
  }
}

if (want('names')) {
  mapping ??= JSON.parse(fs.readFileSync(`${ROOT}/test/multicam/mapping.json`, 'utf8'));
  await call('rename_speakers', { path: REF, mapping });
  await call('get_transcript', { path: REF, format: 'compact' }, 1800);
}

const cameras = GT.cameras.map((x) => ({ source: x.source, role: x.role, speakers: x.speakers }));
if (want('multicam')) {
  const text = await call('build_multicam_sequence', { name: 'TEST multicam', reference: REF, cameras, dryRun: true }, 1800);
  if (text) {
    const plan = JSON.parse(text);
    let total = 0;
    let good = 0;
    for (let t = 0; t < GT.duration; t += 0.1) {
      const g = speakersAt(GT.turns, t);
      const near = GT.turns.some((x) => Math.abs(x.start - t) < 0.7 || Math.abs(x.end - t) < 0.7);
      if (!g.length || near) continue;
      const expected = g.length >= 2 ? 0 : GT.cameras.findIndex((x) => x.speakers.includes(g[0]));
      const run = plan.runs.find((r) => t >= r.start && t < r.end);
      if (run?.cutaway) continue;
      total++;
      if (run && run.cam === expected) good++;
    }
    console.log(`   MULTICAM: správná kamera ${((100 * good) / total).toFixed(1)} % času (mimo 0,7 s kolem střídání a prostřihy)`);
  }
}

if (want('analyze')) await call('analyze_transcript', { path: REF, llm: false });
if (want('llm')) {
  await call('analyze_transcript', { path: REF, force: true }, 3000);
  await call('plan_edit_local', { path: REF, instruction: 'Krátká verze rozhovoru jen o tom, jak dělat videa zdarma a na jakém hardwaru', targetSec: 40 }, 2000);
}
if (want('premiere')) await call('build_multicam_sequence', { name: 'TEST multicam', reference: REF, cameras });

await c.close();
console.log(failed ? `\n✖ ${failed} chyb` : '\n✔ vše prošlo');
process.exit(failed ? 1 : 0);
