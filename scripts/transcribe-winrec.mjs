import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const files = ['20-17-09', '20-46-11', '20-47-14', '20-59-29'].map(s => `C:/Users/Petr/Videos/WINREC/WINREC_2026-09-14_${s}_mikrofon.wav`);
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
for (const f of files) {
  const t0 = Date.now();
  const r = await c.callTool({ name: 'transcribe_media', arguments: { path: f, maxChars: 200 } }, undefined, { timeout: 1800000 });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s ${r.isError ? 'ERROR ' : ''}${r.content[0].text.split('\n').slice(0, 2).join(' | ')}`);
}
await c.close();
