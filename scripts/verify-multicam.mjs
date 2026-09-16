import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
const GT = JSON.parse(fs.readFileSync('test/multicam/gt.json', 'utf8'));
const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const r = await c.callTool({ name: 'get_sequence', arguments: {} });
const seq = JSON.parse(r.content[0].text);
console.log(`sekvence ${seq.name} ${seq.duration}s fps ${seq.fps} ${seq.width}x${seq.height}`);
const off = Object.fromEntries(GT.cameras.map(x => [x.source.toLowerCase(), x.offset]));
let prevEnd = 0, bad = 0;
for (const cl of seq.clips.filter(x => x.kind === 'video')) {
  const o = off[cl.mediaPath.toLowerCase()];
  const expIn = cl.start - o;
  const gap = +(cl.start - prevEnd).toFixed(3);
  const err = Math.abs(cl.inPoint - expIn);
  if (err > 0.05 || Math.abs(gap) > 0.001) bad++;
  console.log(`V${cl.track + 1} ${cl.start.toFixed(2)}-${cl.end.toFixed(2)} ${cl.name.padEnd(18)} in ${cl.inPoint.toFixed(3)} (čekáno ${expIn.toFixed(3)}, chyba ${err.toFixed(3)}) mezera ${gap}`);
  prevEnd = cl.end;
}
const audio = seq.clips.filter(x => x.kind === 'audio');
console.log('audio klipy:', audio.map(a => `A${a.track + 1} ${a.name} ${a.start}-${a.end} in ${a.inPoint}`).join(' | '));
console.log(bad ? `✖ ${bad} problémů` : '✔ obraz navazuje a sync sedí', audio.every(a => a.name === 'master_mix.wav') ? '· na audio stopách jen master' : '· ✖ ZŮSTAL ZVUK KAMER');
await c.close();
