// Lokální střih bez kreditů: zadání ze stdin -> lokální model (backend "hermes") vybere věty -> nová sekvence.
// Používá panel (volba "Hermes (lokálně, zdarma)"); ručně: echo "zadani" | node scripts/local-edit.mjs [backend]
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const BACKEND = process.argv[2] || 'hermes';
const say = (s) => process.stdout.write(s + '\n');

const instruction = fs.readFileSync(0, 'utf8').trim();
if (!instruction) {
  say('✖ Chybí zadání.');
  process.exit(1);
}

/** "3 minuty", "90 sekund", "2,5 min", ale i "tříminutový", "půlminutový", "třicetisekundová" -> sekundy */
function targetSeconds(text) {
  const words = {
    půl: 0.5, pul: 0.5, jedno: 1, dvou: 2, tří: 3, tri: 3, čtyř: 4, ctyr: 4, pěti: 5, peti: 5,
    šesti: 6, sesti: 6, sedmi: 7, osmi: 8, devíti: 9, deviti: 9, desíti: 10, desiti: 10, patnácti: 15, patnacti: 15,
    dvaceti: 20, pětadvaceti: 25, třiceti: 30, triceti: 30, čtyřiceti: 40, ctyriceti: 40, pětačtyřiceti: 45,
    padesáti: 50, padesati: 50, šedesáti: 60, sedesati: 60, devadesáti: 90, devadesati: 90,
  };
  const names = Object.keys(words).sort((a, b) => b.length - a.length).join('|');
  const low = text.toLowerCase();
  const w = low.match(new RegExp(`(${names})?(minutov|sekundov|vteřinov|vterinov)`));
  if (w) return Math.round((words[w[1]] ?? 1) * (w[2].startsWith('minut') ? 60 : 1));
  // číslovka slovy před jednotkou: „do jedné minuty“, „minutu“, „dvě minuty“, „pět minut“, „půl minuty“,
  // „minuta a půl“, „třicet sekund“ (dřív se nepoznalo → plán bez cílové délky, 17 min místo 1 min)
  const num = {
    půl: 0.5, pul: 0.5, jedna: 1, jedné: 1, jedne: 1, jednu: 1, jeden: 1, dvě: 2, dve: 2, dva: 2, dvou: 2, tři: 3, tri: 3,
    tří: 3, čtyři: 4, ctyri: 4, čtyř: 4, pět: 5, pet: 5, pěti: 5, šest: 6, sest: 6, sedm: 7, osm: 8, devět: 9, deset: 10,
    patnáct: 15, patnact: 15, dvacet: 20, třicet: 30, tricet: 30, čtyřicet: 40, ctyricet: 40, padesát: 50, padesat: 50,
    šedesát: 60, devadesát: 90,
  };
  const nn = Object.keys(num).sort((a, b) => b.length - a.length).join('|');
  const u = low.match(new RegExp(`(?:^|[^\\p{L}])(?:(${nn})\\s+)?(minut\\p{L}*|sekund\\p{L}*|vteřin\\p{L}*|vterin\\p{L}*)(\\s+a\\s+půl)?`, 'u'));
  if (u && !/\d/.test(low.slice(Math.max(0, u.index - 6), u.index + 1))) {
    const n = (num[u[1]] ?? 1) + (u[3] ? 0.5 : 0);
    return Math.round(n * (u[2].startsWith('minut') ? 60 : 1));
  }
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(minut\w*|min\b|sekund\w*|s\b|vte\w*)/i);
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  return /^m/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
}

const c = new Client({ name: 'local-edit', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server', 'index.js')] }));
const call = async (name, args, onprogress) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 7200000, resetTimeoutOnProgress: true, onprogress });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};

try {
  const target = targetSeconds(instruction);
  say(`⚙ lokální model (${BACKEND})${target ? `, cílová délka ${target} s` : ''} – kredity se nečerpají`);

  // zdroj: médium z aktivní sekvence, jinak jediné video v projektu
  let source = null;
  try {
    const seq = JSON.parse(await call('get_sequence', {}));
    source = (seq.clips || []).find((x) => x.mediaPath)?.mediaPath || null;
    if (source) say(`⚙ zdroj z aktivní sekvence „${seq.name}": ${path.basename(source)}`);
  } catch {
    /* bez aktivní sekvence */
  }
  if (!source) {
    const items = JSON.parse(await call('list_project_items', {}));
    const vids = items.filter((i) => /\.(mp4|mov|mxf|mkv|avi|wav|mp3|m4a)$/i.test(i.mediaPath || ''));
    if (vids.length !== 1) throw new Error(`Nevím, ze kterého souboru stříhat (${vids.length} médií). Otevři sekvenci s klipem.`);
    source = vids[0].mediaPath;
    say(`⚙ zdroj z projektu: ${path.basename(source)}`);
  }

  let last = -1;
  const progress = (p) => {
    if ((p.progress || 0) - last >= 0.15 || p.progress >= 1) {
      last = p.progress || 0;
      say(`   ${Math.round(last * 100)} % ${p.message || ''}`);
    }
  };

  say('⚙ přepis (z cache, pokud už existuje)');
  await call('transcribe_media', { path: source, maxChars: 1 }, progress);

  const name = `STRIH ${BACKEND.toUpperCase()} ${new Date().toTimeString().slice(0, 5)}`;
  say('⚙ osnova + výběr vět lokálním modelem (u dlouhého videa to trvá minuty)');
  last = -1;
  const res = JSON.parse(
    await call('plan_edit_local', {
      path: source, instruction, targetSec: target, backend: BACKEND,
      // krátký sestřih (upoutávka, výrok): hranice přichytit ke skrytým střihům obrazu, ať grafika na kraji nebliká
      build: { name, source, sceneCuts: Boolean(target && target <= 90) },
    }, progress),
  );

  const plan = res.plan || res;
  const built = res.built;
  say(`✔ vybráno ${plan.picks.length} vět, odhad ${Math.round(plan.estimatedSec)} s`);
  if (built) say(`✔ hotovo: sekvence „${built.name}" (${built.summary || ''})`);
  else say('✖ sekvence se nevytvořila (žádné vybrané věty?)');
  // srozumitelné shrnutí místo seznamu skóre kapitol
  const notes = [];
  if (plan.topics?.length) {
    notes.push(`témata: ${plan.topics.map((t) => (plan.topicSec?.[t] ? `${t} ${Math.round(plan.topicSec[t])} s` : t)).join(', ')}`);
  }
  if (plan.removedModerator?.length) notes.push(`vynechány věty moderátora / jiných mluvčích (${plan.removedModerator.length})`);
  if (plan.offTopic?.length) notes.push(`vyřazeno mimo téma: ${plan.offTopic.length} vět`);
  if (plan.fixedFragments?.length) notes.push(`doplněny začátky souvětí: ${plan.fixedFragments.length}`);
  if (plan.elapsedSec) notes.push(`plán ${Math.round(plan.elapsedSec)} s`);
  if (notes.length) say(`ℹ ${notes.join(' · ')}`);
  if (plan.note) say(`⚠ ${plan.note}`);
  for (const n of built?.sceneCuts || []) say(`🎞 ${n}`);
  for (const n of built?.continuity || []) say(`⚠ ${n}`);
} catch (e) {
  say('✖ ' + (e?.message || e));
  process.exitCode = 1;
} finally {
  await c.close();
}
