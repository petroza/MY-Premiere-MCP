// Sada různých zadání na dvou materiálech (plan_edit_local) – pojistka, že ladění na jednom zadání nerozbilo jiná.
// Vypíše metriky a zapíše texty vybraných vět do test/hermes-loop/battery.md k ručnímu posouzení.
// node scripts/test-plan-battery.mjs [backend]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const DEBATE = 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';
const DISK = `${ROOT}/test/podcast/Diskuse1.mp4`;
const BACKEND = process.argv[2] || 'auto';
const TASKS = [
  { src: DEBATE, target: 120, task: 'Dvouminutový sestřih: jak chce každý z kandidátů řešit parkování v Olomouci, bez moderátora.' },
  { src: DEBATE, target: 90, task: 'Devadesátisekundový sestřih o seniorském bydlení a domovech pro seniory.' },
  { src: DEBATE, target: 60, task: 'Minutový sestřih o tramvajové trati do Pavloviček: co se s ní plánuje a proč, bez moderátora.' },
  { src: DEBATE, target: 180, task: 'Tříminutový přehled celé debaty: nejdůležitější témata a postoje obou kandidátů.' },
  { src: DISK, target: 60, task: 'Minutový sestřih o sociálním učení a efektu ráčny (ratchet effect).' },
  { src: DISK, target: 120, task: 'Dvouminutová verze o neoliberalismu ve vzdělávání, bez moderátora.' },
];

const c = new Client({ name: 'plan-battery', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const md = ['# Sada zadání – plan_edit_local', ''];
for (const t of TASKS) {
  const tr = JSON.parse(fs.readFileSync(idx[path.resolve(t.src).toLowerCase()], 'utf8'));
  const byId = new Map(tr.segments.map((s) => [s.id, s]));
  const t0 = Date.now();
  const r = await c.callTool({ name: 'plan_edit_local', arguments: { path: t.src, instruction: t.task, targetSec: t.target, backend: BACKEND } },
    undefined, { timeout: 3600000, resetTimeoutOnProgress: true });
  const sec = (Date.now() - t0) / 1000;
  if (r.isError) {
    console.log(`✖ ${t.task.slice(0, 50)}… ${r.content[0].text.slice(0, 200)}`);
    continue;
  }
  const plan = JSON.parse(r.content[0].text);
  const ids = plan.picks;
  const text = (i) => byId.get(i).text.trim();
  const mod = ids.filter((i) => /moder/i.test(byId.get(i).speaker || '')).length;
  const frag = ids.filter((i) => /\p{Ll}/u.test(text(i)[0] || '') && !ids.includes(i - 1)).length;
  // nedokončený konec: další věta téhož mluvčího je pokračování (malé písmeno), ale ve střihu chybí
  const unfinished = ids.filter((i) => byId.get(i + 1) && byId.get(i + 1).speaker === byId.get(i).speaker &&
    /^\p{Ll}/u.test(byId.get(i + 1).text.trim()) && !ids.includes(i + 1)).length;
  const dev = Math.round((100 * (plan.estimatedSec - t.target)) / t.target);
  console.log(`${sec.toFixed(0).padStart(4)} s · ${String(plan.estimatedSec).padStart(6)} s / ${t.target} (${dev >= 0 ? '+' : ''}${dev} %) · ${ids.length} vět · ` +
    `moderátor ${mod} · useknuté ${frag} · nedokončené ${unfinished} · témata ${JSON.stringify(plan.topics)}${plan.balanceTopics ? ' (vyvažuje)' : ''} · ${t.task.slice(0, 60)}`);
  md.push(`## ${t.task}`, '', `${plan.estimatedSec} s (cíl ${t.target}), ${ids.length} vět, ${sec.toFixed(0)} s, témata ${JSON.stringify(plan.topicSec)}, ` +
    `mimo téma vyřazeno ${JSON.stringify(plan.offTopic)}`, '');
  for (const i of ids) md.push(`- #${i} [${byId.get(i).speaker || '?'}] ${text(i)}`);
  md.push('');
}
fs.writeFileSync(`${ROOT}/test/hermes-loop/battery.md`, md.join('\n'), 'utf8');
await c.close();
