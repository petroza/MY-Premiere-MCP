import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const SRC = 'O:/MYpremiereMCP/test/podcast/Diskuse1.mp4';
const c = new Client({ name: 'podcast2', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
async function call(name, args, max = 3000) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true });
  console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ✖ ERROR' : ''}\n${r.content[0].text.slice(0, max)}`);
  return r.isError ? null : r.content[0].text;
}
await call('diarize_media', { path: SRC }, 2500);
await call('analyze_transcript', { path: SRC, force: true }, 4000);
const res = await call('plan_edit_local', { path: SRC, instruction: 'Pětiminutový sestřih diskuse: nejdůležitější myšlenky panelistů o vzdělávání, sociálním učení a neoliberalismu. Bez organizačních vět moderátora.', targetSec: 300, build: { name: 'PODCAST 5 min (lokalne)' } }, 2500);
if (res) {
  const out = 'O:/MYpremiereMCP/test/export/podcast_5min.mp4';
  if (fs.existsSync(out)) fs.unlinkSync(out);
  await call('export_sequence', { output: out }, 800);
  if (fs.existsSync(out)) console.log(execFileSync('C:/Program Files/Shutter Encoder/Library/ffprobe.exe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'compact', out], { encoding: 'utf8' }));
}
await c.callTool({ name: 'save_project', arguments: {} });
await c.close();
