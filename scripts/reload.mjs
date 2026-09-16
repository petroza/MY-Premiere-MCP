import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const r = await c.callTool({ name: 'reload_bridge', arguments: {} });
console.log('reload_bridge ->', r.content[0].text);
await c.close();
