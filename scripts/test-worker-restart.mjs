// Test: MCP server restartuje Worker se starým kódem a přepnutí LLM -> Whisper nenechá viset llama-server.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const REF = `${ROOT}/test/multicam/master_mix.wav`;
const llamaCount = () =>
  Number(execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\").Count"], { encoding: 'utf8' }).trim());

const c = new Client({ name: 'restart', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✔' : '✖'} ${msg}`);
  if (!ok) failed++;
};

const pid1 = JSON.parse(await call('worker_status')).health.pid;
const now = new Date();
fs.utimesSync(`${ROOT}/worker/common.py`, now, now); // „nová verze" kódu
await new Promise((r) => setTimeout(r, 1200));
const pid2 = JSON.parse(await call('worker_status')).health.pid;
check(pid1 !== pid2, `Worker se starým kódem restartován (pid ${pid1} → ${pid2})`);

await call('analyze_transcript', { path: REF, force: true }); // spustí llama-server
check(llamaCount() === 1, `během analýzy běží právě jeden llama-server (${llamaCount()})`);
await call('transcribe_media', { path: REF, force: true, maxChars: 100 }); // Whisper musí llama-server vypnout
check(llamaCount() === 0, `po přepnutí na Whisper nezůstal llama-server (${llamaCount()})`);

await c.close();
console.log(failed ? `\n✖ ${failed} chyb` : '\n✔ vše prošlo');
process.exit(failed ? 1 : 0);
