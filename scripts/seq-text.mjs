// Vypíše, co je ve střihu: klipy sekvence -> věty přepisu (text, mluvčí, délka). Pro srovnání agentů.
//   node scripts/seq-text.mjs "<sekvence>" ["<sekvence2>" ...]
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cesta s mezerami: .pathname by nechal %20
const c = new Client({ name: 'seq-text', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server', 'index.js')], env: { ...process.env } }));
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'transcripts', 'index.json'), 'utf8'));
for (const name of process.argv.slice(2)) {
  const r = await c.callTool({ name: 'get_sequence', arguments: { sequence: name } });
  const seq = JSON.parse(r.content[0].text);
  console.log(`\n=== ${seq.name} (${seq.duration?.toFixed?.(1) ?? seq.duration} s)`);
  for (const cl of (seq.clips || []).filter((x) => x.kind === 'video' && x.mediaPath)) {
    const tr = JSON.parse(fs.readFileSync(idx[path.resolve(cl.mediaPath).toLowerCase()], 'utf8'));
    const words = tr.segments.flatMap((s) => (s.words || []).map((w) => ({ ...w, id: s.id, spk: s.speaker })));
    // slovo patří do klipu, když je v něm většina jeho délky (časy z Whisperu přesahují o desítky ms)
    const inside = words.filter((w) => Math.min(w.e, cl.outPoint) - Math.max(w.s, cl.inPoint) > 0.5 * (w.e - w.s));
    const ids = [...new Set(inside.map((w) => w.id))];
    console.log(`  [${cl.inPoint.toFixed(2)}–${cl.outPoint.toFixed(2)}] #${ids.join(',#')} (${inside[0]?.spk || '?'}): ${inside.map((w) => w.w).join(' ')}`);
  }
}
await c.close();
