// Srovnání jazykových modelů na stejném střihu: node scripts/compare-llm.mjs [backend1,backend2] [cesta] [cílSekund]
// Pro každý model: osnova (analyze) + plán střihu (plan_edit) nad stejným přepisem a stejným zadáním.
// Výstup: tabulka + vybrané věty + report v test/llm-compare/report.md
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const backends = (process.argv[2] || 'local,hermes').split(',');
const SRC = process.argv[3] || `${ROOT}/test/podcast/Diskuse1.mp4`;
const TARGET = Number(process.argv[4] || 300);
const INSTRUCTION = process.env.INSTRUCTION ||
  'Pětiminutový sestřih diskuse: nejdůležitější myšlenky panelistů o vzdělávání, sociálním učení a neoliberalismu. Bez organizačních vět moderátora.';
const OUT = `${ROOT}/test/llm-compare`;
fs.mkdirSync(OUT, { recursive: true });

const c = new Client({ name: 'compare-llm', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true });
  return { sec: (Date.now() - t0) / 1000, text: r.content[0].text, error: r.isError };
};

const status = JSON.parse((await call('worker_status', {})).text);
console.log('Dostupné modely:');
for (const b of status.health.llmBackends || []) console.log(`  ${b.name}: ${b.label} · ${b.running ? 'běží' : 'neběží'}`);

const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const tr = JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
const segById = new Map(tr.segments.map((s) => [s.id, s]));

const results = {};
for (const backend of backends) {
  console.log(`\n##### ${backend}`);
  const an = await call('analyze_transcript', { path: SRC, backend, force: true });
  if (an.error) {
    console.log(`  ✖ osnova selhala: ${an.text.slice(0, 300)}`);
    results[backend] = { failed: an.text.slice(0, 300) };
    continue;
  }
  const chapters = an.text.split('\n').filter((l) => /^K\d+ /.test(l));
  console.log(`  osnova: ${an.sec.toFixed(1)} s, ${chapters.length} kapitol`);
  const pl = await call('plan_edit_local', { path: SRC, instruction: INSTRUCTION, targetSec: TARGET, backend });
  if (pl.error) {
    console.log(`  ✖ plán selhal: ${pl.text.slice(0, 300)}`);
    results[backend] = { failed: pl.text.slice(0, 300), outline: an.text };
    continue;
  }
  const plan = JSON.parse(pl.text);
  console.log(`  plán: ${pl.sec.toFixed(1)} s, ${plan.picks.length} vět, ${plan.estimatedSec} s (cíl ${TARGET} s)`);
  results[backend] = { outlineSec: an.sec, chapters: chapters.length, outline: an.text, planSec: pl.sec, plan };
}

const ok = Object.entries(results).filter(([, r]) => r.plan);
if (ok.length === 2) {
  const [a, b] = ok.map(([, r]) => new Set(r.plan.picks));
  const both = [...a].filter((x) => b.has(x));
  console.log(`\nShoda výběru vět: ${both.length} společných, jen ${ok[0][0]}: ${[...a].filter((x) => !b.has(x)).length}, jen ${ok[1][0]}: ${[...b].filter((x) => !a.has(x)).length}`);
}

const md = [`# Srovnání jazykových modelů – ${path.basename(SRC)}`, '', `Zadání: *${INSTRUCTION}* (cíl ${TARGET} s)`, '',
  '| Model | Osnova | Kapitol | Plán | Vět | Délka střihu |', '|---|---|---|---|---|---|'];
for (const [name, r] of Object.entries(results)) {
  md.push(r.plan
    ? `| ${name} | ${r.outlineSec.toFixed(1)} s | ${r.chapters} | ${r.planSec.toFixed(1)} s | ${r.plan.picks.length} | ${r.plan.estimatedSec} s |`
    : `| ${name} | — | — | — | — | CHYBA: ${r.failed} |`);
}
for (const [name, r] of Object.entries(results)) {
  if (!r.plan) continue;
  md.push('', `## ${name} – vybrané věty`, '', `Hodnocení kapitol: ${r.plan.why}`, '');
  for (const id of r.plan.picks) {
    const s = segById.get(id);
    md.push(`- **#${id}** ${s?.speaker ? `[${s.speaker}] ` : ''}${s?.text || ''}`);
  }
  md.push('', `## ${name} – osnova`, '', '```', r.outline.slice(0, 6000), '```');
}
fs.writeFileSync(`${OUT}/report.md`, md.join('\n'), 'utf8');
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1), 'utf8');
console.log(`\nReport: ${OUT}/report.md`);
await c.close();
