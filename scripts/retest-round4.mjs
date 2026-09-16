import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const token = fs.readFileSync(process.env.APPDATA + '/MYpremiereMCP/token.txt', 'utf8').trim();
try { await fetch('http://127.0.0.1:7881/shutdown', { method: 'POST', headers: { 'X-PMCP-Token': token } }); } catch {}
await new Promise(r => setTimeout(r, 3000));
const REF = 'O:/MYpremiereMCP/test/multicam/master_mix.wav';
const GT = JSON.parse(fs.readFileSync('test/multicam/gt.json', 'utf8'));
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const call = async (name, args, max = 1600) => { const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 }); console.log(`\n=== ${name} (${((Date.now()-t0)/1000).toFixed(1)} s)${r.isError ? ' ERROR' : ''}\n` + r.content[0].text.slice(0, max)); return r; };
await call('transcribe_media', { path: REF, force: true, speakerTracks: GT.mics.map(m => ({ name: m.name, path: m.path })), maxChars: 1600 });
await call('analyze_transcript', { path: REF }, 1200);
await call('plan_edit_local', { path: REF, instruction: 'Krátká verze rozhovoru jen o tom, jak dělat videa zdarma a na jakém hardwaru', targetSec: 40 });
await c.close();
