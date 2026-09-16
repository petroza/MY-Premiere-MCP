import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
for (const name of ['save_project', 'get_project']) {
  const r = await c.callTool({ name, arguments: {} });
  console.log(name, r.isError ? 'ERROR' : '', r.content[0].text);
}
await c.close();
