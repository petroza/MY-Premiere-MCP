// Celá cesta u NOVÉHO videa (nic v cache): přepis → mluvčí (diarizace) → osnova → plán → sekvence.
// node scripts/test-fresh-pipeline.mjs <video> "<zadání>" <cílová délka s>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [SRC, TASK, TARGET] = process.argv.slice(2);
const c = new Client({ name: 'fresh', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const sec = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(22)} ${sec.toFixed(1).padStart(6)} s  ${r.content[0].text.split('\n').slice(0, 2).join(' | ').slice(0, 150)}`);
  return { sec, text: r.content[0].text };
};
const steps = [
  ['transcribe_media', { path: SRC, maxChars: 1 }],
  ['diarize_media', { path: SRC }],
  ['analyze_transcript', { path: SRC }],
  ['plan_edit_local', { path: SRC, instruction: TASK, targetSec: Number(TARGET), build: { name: `FRESH ${new Date().toTimeString().slice(0, 5)}` } }],
];
let total = 0;
for (const [n, a] of steps) total += (await call(n, a)).sec;
console.log(`CELKEM ${total.toFixed(1)} s`);
await c.close();
