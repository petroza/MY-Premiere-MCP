import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'test', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
let last = 0;
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000, onprogress: p => { if (p.progress - last >= 0.2 || p.progress >= 1 || p.progress < 0.05) { last = p.progress; console.log(`  .. ${Math.round(p.progress*100)}% ${p.message||''}`); } } });
  console.log(`\n=== ${name} (${((Date.now()-t0)/1000).toFixed(1)} s)${r.isError ? ' ERROR' : ''}\n` + r.content[0].text.slice(0, 2500));
};
await call('transcribe_media', { path: 'C:/Users/Petr/Videos/WINREC/WINREC_2026-09-14_20-54-52_mikrofon.wav', force: true });
await c.close();
