import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const token = fs.readFileSync(process.env.APPDATA + '/MYpremiereMCP/token.txt', 'utf8').trim();
try { await fetch('http://127.0.0.1:7881/shutdown', { method: 'POST', headers: { 'X-PMCP-Token': token } }); } catch {}
await new Promise(r => setTimeout(r, 3000));
const REF = 'O:/MYpremiereMCP/test/multicam/master_mix.wav';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const t0 = Date.now();
const r = await c.callTool({ name: 'plan_edit_local', arguments: { path: REF, instruction: 'Krátká verze rozhovoru jen o tom, jak dělat videa zdarma a na jakém hardwaru', targetSec: 40 } }, undefined, { timeout: 900000 });
console.log(`=== plan_edit_local (${((Date.now()-t0)/1000).toFixed(1)} s)${r.isError ? ' ERROR' : ''}\n` + r.content[0].text);
if (!r.isError) {
  const plan = JSON.parse(r.content[0].text);
  const idx = JSON.parse(fs.readFileSync('cache/transcripts/index.json', 'utf8'));
  const tr = JSON.parse(fs.readFileSync(Object.entries(idx).find(([k]) => k.includes('master_mix'))[1], 'utf8'));
  const by = new Map(tr.segments.map(s => [s.id, s]));
  console.log('\nVýsledný střih:');
  for (const id of plan.picks) console.log(`#${id} [${by.get(id).speaker}] ${by.get(id).text}`);
}
await c.close();
