// Velikost definic MCP nástrojů (popis + schéma) – každý agentní běh je posílá celé, stojí to tokeny.
// node scripts/tool-sizes.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'sizes', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'], env: { ...process.env } }));
const { tools } = await c.listTools();
const rows = tools.map((t) => ({ name: t.name, desc: t.description.length, schema: JSON.stringify(t.inputSchema).length }));
rows.sort((a, b) => b.desc + b.schema - a.desc - a.schema);
let tot = 0;
for (const r of rows) { tot += r.desc + r.schema; console.log(String(r.desc + r.schema).padStart(6), String(r.desc).padStart(6), r.name); }
console.log('celkem znaků', tot, '≈ tokenů', Math.round(tot / 3.2), '| nástrojů', rows.length);
await c.close();
