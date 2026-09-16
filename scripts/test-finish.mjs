// Dokončovací živé testy v Premiere: export, přepis sekvence přes Worker, střih kamer jen ve vybraných větách.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const GT = JSON.parse(fs.readFileSync(`${ROOT}/test/multicam/gt.json`, 'utf8'));
const REF = GT.reference;
const FFPROBE = 'C:/Program Files/Shutter Encoder/Library/ffprobe.exe';
const c = new Client({ name: 'test-finish', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
let failed = 0;
async function call(name, args = {}, max = 1500) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 3600000 });
  const text = r.content[0].text;
  console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ✖ ERROR' : ''}\n${text.slice(0, max)}`);
  if (r.isError) failed++;
  return r.isError ? null : text;
}

// 1) střih kamer jen ve vybraných větách (plán z plan_edit_local)
const cameras = GT.cameras.map((x) => ({ source: x.source, role: x.role, speakers: x.speakers }));
const story = await call('build_multicam_sequence', { name: 'TEST multicam pribeh', reference: REF, cameras, picks: [7, 8, 9, 11, 12] }, 900);
if (story) {
  const seq = JSON.parse(await call('get_sequence', {}, 0));
  const v = seq.clips.filter((x) => x.kind === 'video');
  const a = seq.clips.filter((x) => x.kind === 'audio');
  const gaps = v.slice(1).filter((x, i) => Math.abs(x.start - v[i].end) > 0.001).length;
  console.log(`   PŘÍBĚH: délka ${seq.duration} s · záběrů ${v.length} · mezery v obraze ${gaps} · zvukových úseků ${a.length} (${a.map((x) => `${x.start}-${x.end}`).join(', ')})`);
  if (gaps) failed++;
}

// 2) přepis sekvence přes Worker (časy timeline)
await call('transcribe_sequence', { audioTracks: [0] }, 1200);

// 3) export aktivní sekvence
const out = `${ROOT}/test/export/multicam_pribeh.mp4`;
fs.mkdirSync(`${ROOT}/test/export`, { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);
const exp = await call('export_sequence', { output: out }, 600);
if (exp) {
  try {
    const probe = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'compact', out], { encoding: 'utf8' });
    console.log(`   EXPORT: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB\n${probe.trim()}`);
  } catch (e) {
    console.log(`   ✖ EXPORT soubor chybí nebo je vadný: ${e.message}`);
    failed++;
  }
}

await c.callTool({ name: 'save_project', arguments: {} });
await c.close();
console.log(failed ? `\n✖ ${failed} chyb` : '\n✔ vše prošlo');
process.exit(failed ? 1 : 0);
