import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const SRC = 'O:/MYpremiereMCP/test/podcast/Diskuse1.mp4';
const c = new Client({ name: 'podcast', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));
async function call(name, args, max = 2500) {
  const t0 = Date.now();
  let last = -1;
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true,
    onprogress: (p) => { if (p.progress - last >= 0.2) { last = p.progress; console.log(`   .. ${Math.round(p.progress * 100)}% ${p.message || ''}`); } } });
  console.log(`\n=== ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ✖ ERROR' : ''}\n${r.content[0].text.slice(0, max)}`);
  return r;
}
await call('transcribe_media', { path: SRC, maxChars: 2500 });
await call('diarize_media', { path: SRC }, 2500);
await call('analyze_transcript', { path: SRC }, 6000);
await c.close();
