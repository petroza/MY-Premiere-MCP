// Ladění plánu lokálním modelem bez stavby: vypíše režim, vybrané věty, žebříček pasáží a úvahu finále.
//   node scripts/plan-debug.mjs <video> <cílová délka s> "<zadání>"
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'x', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['O:/ADOBEPREMIERESTRIH/server/index.js'] }));
const [p, t, ins] = process.argv.slice(2);
const r = await c.callTool({ name: 'plan_edit_local', arguments: { path: p, targetSec: Number(t), instruction: ins, backend: 'hermes' } }, undefined, { timeout: 1800000 });
const j = JSON.parse(r.content[0].text);
console.log(j.mode, j.picks.join(','), j.estimatedSec, JSON.stringify(j.ranked));
console.log('   úvaha:', j.reason, '| čas', j.elapsedSec, 's');
await c.close();
