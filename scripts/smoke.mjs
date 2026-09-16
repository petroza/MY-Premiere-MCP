import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'test', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const { tools } = await c.listTools();
console.log(tools.length + ' tools: ' + tools.map(t => t.name).join(', '));
const r = await c.callTool({ name: 'premiere_status', arguments: {} });
console.log('premiere_status ->', r.isError ? 'ERROR ' : '', r.content[0].text);
await c.close();
