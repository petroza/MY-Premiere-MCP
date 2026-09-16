// Živý test v Premiere: node scripts/test-premiere.mjs [krok...]
// Kroky: status, build, pauses, seq, markers, remove  (výchozí všechny)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WINREC = 'C:/Users/Petr/Videos/WINREC/WINREC_2026-09-14_20-54-52';
const steps = process.argv.slice(2);
const want = (s) => !steps.length || steps.includes(s);

const c = new Client({ name: 'test-premiere', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['O:/MYpremiereMCP/server/index.js'] }));

let failed = 0;
async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  const text = r.content[0].text;
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 120)} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r.isError ? ' ✖ ERROR' : ''}\n${text.slice(0, 2500)}`);
  if (r.isError) failed++;
  return r.isError ? null : text;
}
const json = (t) => (t ? JSON.parse(t) : null);

if (want('status')) {
  await call('premiere_status');
  await call('get_project');
}

let built = null;
if (want('build')) {
  // přepis mikrofonu (z cache), střih videa podle vět 4–6 a 15, mikrofon pod video na A2
  await call('transcribe_media', { path: `${WINREC}_mikrofon.wav`, maxChars: 400 });
  built = json(
    await call('build_sequence_from_transcript', {
      name: 'TEST strih podle vet',
      source: `${WINREC}.mp4`,
      transcriptSource: `${WINREC}_mikrofon.wav`,
      picks: [4, 5, 6, { id: 15, fromWord: 0, toWord: 7 }],
      extraAudio: [{ source: `${WINREC}_mikrofon.wav`, audioTrack: 1 }],
    }),
  );
}

if (want('pauses')) {
  await call('build_sequence_without_pauses', {
    name: 'TEST bez pauz',
    source: `${WINREC}.mp4`,
    transcriptSource: `${WINREC}_mikrofon.wav`,
    minPause: 0.8,
  });
}

if (want('seq')) {
  const s = json(await call('get_sequence', {}));
  if (s) console.log(`   klipů: ${s.clips.length}, délka ${s.duration}s, fps ${s.fps}`);
}

if (want('markers')) {
  await call('add_markers', { markers: [{ time: 1, name: 'MCP test', comment: 'značka z testu', color: 3 }] });
  await call('get_markers', {});
  await call('set_playhead', { time: 2.5 });
}

if (want('remove')) {
  const before = json(await call('get_sequence', { clips: false }));
  await call('remove_timeline_ranges', { ranges: [{ start: 2, end: 4 }] });
  const after = json(await call('get_sequence', {}));
  if (before && after) {
    const d = Math.round((before.duration - after.duration) * 100) / 100;
    console.log(`   délka ${before.duration} → ${after.duration} (rozdíl ${d}, čekáno ~2)`);
    const starts = after.clips.map((x) => `${x.kind[0]}${x.track + 1}:${x.start}-${x.end}`).join('  ');
    console.log(`   klipy: ${starts}`);
  }
}

await c.close();
console.log(failed ? `\n✖ ${failed} chyb` : '\n✔ vše prošlo');
process.exit(failed ? 1 : 0);
