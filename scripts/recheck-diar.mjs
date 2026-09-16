import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const t0 = Date.now();
const r = await c.callTool({ name: 'diarize_media', arguments: { path: 'O:/MYpremiereMCP/test/podcast/Diskuse1.mp4', force: true } }, undefined, { timeout: 900000 });
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ERROR' : ''}\n` + r.content[0].text.slice(0, 1400));
await c.callTool({ name: 'save_project', arguments: {} });
await c.close();
