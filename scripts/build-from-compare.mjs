// Postaví v Premiere sekvenci z plánu uloženého v test/llm-compare/results.json
// node scripts/build-from-compare.mjs <backend> "<nazev sekvence>" [cesta k videu]
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const backend = process.argv[2] || 'hermes';
const name = process.argv[3] || `STRIH ${backend.toUpperCase()}`;
const source = process.argv[4] || 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';

const res = JSON.parse(fs.readFileSync(`${ROOT}/test/llm-compare/results.json`, 'utf8'));
const plan = res[backend]?.plan;
if (!plan) throw new Error(`V results.json není plán pro backend "${backend}"`);
console.log(`${backend}: ${plan.picks.length} vět, ${plan.estimatedSec} s`);

const c = new Client({ name: 'build-from-compare', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const r = await c.callTool(
  { name: 'build_sequence_from_transcript', arguments: { name, source, picks: plan.picks } },
  undefined,
  { timeout: 1800000, resetTimeoutOnProgress: true },
);
console.log(r.content[0].text);
await c.close();
