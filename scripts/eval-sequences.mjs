// Obsahové vyhodnocení hotových sekvencí: node scripts/eval-sequences.mjs "NAZEV1" "NAZEV2" ...
// U každé: délka, počet vět, vady (věty moderátora, useknuté začátky, opakování), poměr témat, ukázka.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const SRC = 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';
const MODERATOR = new Set([5, 39, 40, 59, 60, 77, 78, 127, 149, 173, 174, 175, 181, 203, 206, 272, 294, 295, 338, 356, 357, 360]);
const names = process.argv.slice(2);

const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const tr = JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
const segs = tr.segments;
const byId = new Map(segs.map((s) => [s.id, s]));

const c = new Client({ name: 'eval-seq', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));

for (const name of names) {
  let seq;
  try {
    const r = await c.callTool({ name: 'get_sequence', arguments: { sequence: name } }, undefined, { timeout: 600000 });
    if (r.isError) throw new Error(r.content[0].text);
    seq = JSON.parse(r.content[0].text);
  } catch (e) {
    console.log(`\n### ${name}: ✖ ${e.message.slice(0, 120)}`);
    continue;
  }
  const ids = [];
  for (const cl of (seq.clips || []).filter((x) => x.kind === 'video')) {
    for (const s of segs) {
      const ov = Math.min(cl.outPoint, s.end) - Math.max(cl.inPoint, s.start);
      if (ov > 0.35 * Math.min(s.end - s.start, cl.outPoint - cl.inPoint)) ids.push(s.id);
    }
  }
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  const t = (i) => (byId.get(i)?.text || '').trim();
  const frag = uniq.filter((i) => t(i)[0] && t(i)[0] === t(i)[0].toLowerCase() && !uniq.includes(i - 1));
  const mod = uniq.filter((i) => MODERATOR.has(i));
  const park = uniq.filter((i) => /park|tramvaj|zón|automat|doprav|štenbersk/i.test(t(i)));
  const hous = uniq.filter((i) => /byt|bydlen|develop|nájem|pozemk|výstavb|senior|nemovit/i.test(t(i)));
  const neither = uniq.filter((i) => !park.includes(i) && !hous.includes(i));
  console.log(`\n### ${name}`);
  console.log(`délka ${seq.duration.toFixed(1)} s · vět ${uniq.length} · parkování ${park.length} · bydlení ${hous.length} · mimo obě témata ${neither.length}`);
  if (mod.length) console.log(`  ✖ moderátor: ${mod.map((i) => `#${i} ${t(i).slice(0, 60)}`).join(' | ')}`);
  if (frag.length) console.log(`  ✖ useknutý začátek: ${frag.map((i) => `#${i} ${t(i).slice(0, 55)}`).join(' | ')}`);
  if (neither.length) console.log(`  ~ mimo téma: ${neither.slice(0, 4).map((i) => `#${i} ${t(i).slice(0, 55)}`).join(' | ')}`);
  console.log(`  ukázka: ${uniq.slice(0, 3).map((i) => `#${i} ${t(i).slice(0, 70)}`).join(' | ')}`);
}
await c.close();
