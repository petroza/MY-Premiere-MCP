import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'test', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000, onprogress: p => process.stdout.write(`  .. ${Math.round(p.progress*100)}% ${p.message||''}\n`) });
  console.log(`\n=== ${name} (${((Date.now()-t0)/1000).toFixed(1)} s)${r.isError ? ' ERROR' : ''}\n` + r.content[0].text.slice(0, 3000));
};
const base = 'C:/Users/Petr/Videos/WINREC/WINREC_2026-09-15_07-53-15';
await call('transcribe_media', { path: base + '_mikrofon.wav' });
await call('transcribe_media', { path: base + '.mp4', speakerTracks: [{ name: 'Mikrofon', path: base + '_mikrofon.wav' }] });
await call('find_pauses', { path: base + '_mikrofon.wav', minPause: 0.5 });
await call('get_transcript', { path: base + '_mikrofon.wav', words: true, maxChars: 1500 });
await c.close();
