import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const token = fs.readFileSync(process.env.APPDATA + '/MYpremiereMCP/token.txt', 'utf8').trim();
try { await fetch('http://127.0.0.1:7881/shutdown', { method: 'POST', headers: { 'X-PMCP-Token': token } }); console.log('worker zastaven'); } catch { console.log('worker neběžel'); }
await new Promise(r => setTimeout(r, 2000));
const REF = 'O:/MYpremiereMCP/test/multicam/master_mix.wav';
const mapping = JSON.parse(fs.readFileSync('test/multicam/mapping.json', 'utf8'));
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 }); console.log(`\n=== ${name}${r.isError ? ' ERROR' : ''}\n` + r.content[0].text.slice(0, 1800)); };
await call('transcribe_media', { path: REF, force: true, maxChars: 300 });
await call('diarize_media', { path: REF, numSpeakers: 2 });
await call('rename_speakers', { path: REF, mapping });
await call('get_transcript', { path: REF, format: 'compact' });
await c.close();
