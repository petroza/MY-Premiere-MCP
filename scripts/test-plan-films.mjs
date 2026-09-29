// Sada zadání na dokumentárních filmech (lokální plán, Hermes): různé typy – upoutávka, téma, delší stopáž.
// Výstup: test/hermes-loop/films.md (texty vybraných vět pro ruční posouzení kvality) + stručný řádek na konzoli.
//   node scripts/test-plan-films.mjs [filtr]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const PEOPLE = 'D:/FILMY/UA/Ukraine.The.Peoples.Fight.2023.1080p.WEBRip.x265-LAMA/Ukraine.The.Peoples.Fight.2023.1080p.WEBRip.x265-LAMA.mp4';
const ANDR = 'C:/Users/Petr/Downloads/01-video/2000.Meters.To.Andriivka.2025.1080p.WEBRip.x264.AAC-WORLD.mp4';
const TASKS = [
  { src: PEOPLE, target: 30, task: 'Třicetisekundová upoutávka na tento dokument, ať diváka navnadí.' },
  { src: PEOPLE, target: 120, task: 'Dvouminutový sestřih o dobrovolnících: kdo jsou a proč bojují.' },
  { src: PEOPLE, target: 180, task: 'Tři minuty o dronech a nových zbraních ve válce.' },
  { src: ANDR, target: 90, task: 'Minuta a půl: příběh bitvy o Andrijivku od začátku do konce.' },
  { src: ANDR, target: 45, task: 'Krátký sestřih o ceně, kterou vojáci za postup platí, 45 sekund.' },
].filter((t) => !process.argv[2] || t.task.includes(process.argv[2]));

const c = new Client({ name: 'plan-films', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const md = ['# Filmy – plan_edit_local', ''];
for (const t of TASKS) {
  const tr = JSON.parse(fs.readFileSync(idx[path.resolve(t.src).toLowerCase()], 'utf8'));
  const byId = new Map(tr.segments.map((s) => [s.id, s]));
  const t0 = Date.now();
  const r = await c.callTool({ name: 'plan_edit_local', arguments: { path: t.src, instruction: t.task, targetSec: t.target } },
    undefined, { timeout: 3600000, resetTimeoutOnProgress: true });
  const sec = (Date.now() - t0) / 1000;
  if (r.isError) { console.log(`✖ ${t.task}: ${r.content[0].text}`); continue; }
  const p = JSON.parse(r.content[0].text);
  const frag = p.picks.filter((i) => /^\p{Ll}/u.test(byId.get(i).text.trim()) && !p.picks.includes(i - 1)).length;
  console.log(`${sec.toFixed(0).padStart(4)} s · ${p.estimatedSec} s / ${t.target} · ${p.picks.length} vět · useknuté ${frag} · ${t.task}`);
  md.push(`## ${t.task}`, '', `${p.estimatedSec} s (cíl ${t.target}), ${sec.toFixed(0)} s, teze: ${p.thesis || '—'}`, '',
    ...p.picks.map((i) => `- #${i} [${byId.get(i).speaker || '?'}] ${byId.get(i).text.trim()}`), '');
}
fs.writeFileSync(`${ROOT}/test/hermes-loop/films.md`, md.join('\n'), 'utf8');
await c.close();
