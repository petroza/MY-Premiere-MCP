// Srovnání modelů na STEJNÉM střihovém úkolu. Každý model dostane identické zadání přes stejné CLI,
// jaké používá panel, postaví vlastní sekvenci v Premiere a skript pak u všech změří stejná kritéria.
//
//   node scripts/compare-agents.mjs [claude:haiku,claude:sonnet,codex:gpt-5.5,hermes:local]
//   Profil Claude jako 3. část: claude:sonnet:lean (bez vestavěných nástrojů + panel/agent-system.md),
//   claude:sonnet (výchozí = dnešní nastavení panelu). Průběh každého běhu: test/agent-compare/<TAG>.jsonl
//
// Výsledky: test/agent-compare/results.json + report.md (průběžně se ukládá po každém běhu).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const SRC = 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';
const OUT = `${ROOT}/test/agent-compare`;
const RUNS = (process.argv[2] || 'claude:haiku,claude:sonnet,claude:opus,codex:gpt-6-astra,codex:gpt-5.5,hermes:local')
  .split(',')
  .map((s) => {
    const [agent, model, profile, effort] = s.split(':');
    return { agent, model, profile, effort, tag: [agent, model, profile, effort].filter(Boolean).join('-').toUpperCase() };
  });
const TASK =
  'Tříminutový sestřih o bydlení a parkování: nejkonkrétnější argumenty obou hostů (co chtějí udělat a čím to zdůvodňují), ' +
  'bez úvodních a organizačních vět moderátora, bez opakování.';
const prompt = (tag) =>
  `Video ${SRC} už má hotový přepis v cache – NEPŘEPISUJ ho znovu (nevolej transcribe_media s force). ` +
  `Úkol: ${TASK} Výsledek vytvoř jako novou sekvenci s názvem přesně "STRIH ${tag}" ` +
  `(nástroj build_sequence_from_transcript, source = to video). Na závěr vypiš čísla vybraných vět.`;

fs.mkdirSync(OUT, { recursive: true });
const resultsFile = `${OUT}/results.json`;
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};

/* ---------- pomocné: MCP klient pro měření výsledku ---------- */
const mcp = new Client({ name: 'compare-agents', version: '0' });
await mcp.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 1800000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};

const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const tr = JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
const segs = tr.segments;


/** klipy sekvence -> ID vět přepisu (překryv zdrojových časů) */
function sentencesOf(clips) {
  const ids = [];
  for (const c of clips.filter((x) => x.kind === 'video')) {
    for (const s of segs) {
      const ov = Math.min(c.outPoint, s.end) - Math.max(c.inPoint, s.start);
      if (ov > 0.35 * Math.min(s.end - s.start, c.outPoint - c.inPoint)) ids.push(s.id);
    }
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function metrics(seq) {
  const ids = sentencesOf(seq.clips || []);
  const byId = new Map(segs.map((s) => [s.id, s]));
  const frag = ids.filter((i) => byId.get(i)?.text.trim()[0]?.toLowerCase() === byId.get(i)?.text.trim()[0] && !ids.includes(i - 1));
  const text = (i) => (byId.get(i)?.text || '').toLowerCase();
  return {
    duration: Math.round(seq.duration * 10) / 10,
    clips: (seq.clips || []).filter((c) => c.kind === 'video').length,
    sentences: ids.length,
    ids,
    moderator: ids.filter((i) => /moder/i.test(byId.get(i)?.speaker || '')).length,
    fragments: frag.length,
    unfinished: ids.filter((i) => byId.get(i + 1) && byId.get(i + 1).speaker === byId.get(i)?.speaker &&
      /^\p{Ll}/u.test(byId.get(i + 1).text.trim()) && !ids.includes(i + 1)).length,
    parking: ids.filter((i) => /park|zón|automat|štenbersk|p plus r/.test(text(i))).length,
    offtopic: ids.filter((i) => [20, 21, 30, 31, 32, 38].includes(i) || (i >= 243 && i <= 271)).length,
    ferShare: (() => {
      const d = (i) => byId.get(i).end - byId.get(i).start;
      const g = ids.filter((i) => /feranc|vaš/i.test(byId.get(i)?.speaker || ''));
      const f = g.filter((i) => /feranc/i.test(byId.get(i).speaker)).reduce((a, i) => a + d(i), 0);
      return Math.round((100 * f) / Math.max(1, g.reduce((a, i) => a + d(i), 0)));
    })(),
    housing: ids.filter((i) => /byt|bydlen|develop|nájem|pozemk|výstavb|senior/.test(text(i))).length,
  };
}

// podle ID: opakovaný běh vytvoří sekvenci se stejným názvem a hledání podle jména by vzalo tu starou
const sequenceList = async () => JSON.parse(await call('get_project')).sequences.map((s) => ({ name: s.name, id: s.sequenceID }));

/* ---------- spuštění jednoho modelu ---------- */
function findExe(name) {
  try {
    const lines = execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const hit = lines.find((l) => /\.exe$/i.test(l)) || lines[0];
    if (hit) return hit;
  } catch {
    /* není v PATH – zkus známá místa */
  }
  if (name === 'codex') {
    // CLI dodávané s aplikací Codex: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (není v PATH)
    const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      const dirs = fs.readdirSync(base).map((d) => path.join(base, d, 'codex.exe')).filter((p) => fs.existsSync(p));
      if (dirs.length) return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch {
      /* není nainstalované */
    }
  }
  return null;
}

function runAgent({ agent, model, profile, effort, tag }) {
  return new Promise((resolve) => {
    const exe = findExe(agent === 'hermes' ? 'node' : agent);
    if (!exe) return resolve({ error: `${agent} CLI nenalezeno` });
    let args;
    if (agent === 'claude') {
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', path.join(ROOT, 'mcp.json'),
        '--strict-mcp-config', '--allowedTools', 'mcp__premiere', '--model', model];
      if (profile === 'lean' || profile === 'lean2') {
        // lean2: jediný vestavěný nástroj ToolSearch -> popisy MCP nástrojů se načtou až na vyžádání
        args.push(profile === 'lean2' ? '--tools=ToolSearch' : '--tools=',
          '--system-prompt', fs.readFileSync(path.join(ROOT, 'panel', 'agent-system.md'), 'utf8'));
      }
      if (effort) args.push('--effort', effort); // 4. část tagu: claude:sonnet:lean2:low
    } else if (agent === 'codex') {
      args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
        '-c', 'mcp_servers.premiere.command="node"', '-c', `mcp_servers.premiere.args=["${ROOT}/server/index.js"]`,
        '-c', 'mcp_servers.premiere.default_tools_approval_mode="approve"', '-m', model, '-'];
    } else {
      args = [path.join(ROOT, 'scripts', 'local-edit.mjs'), 'hermes'];
    }
    const t0 = Date.now();
    const child = spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: /\.(cmd|bat)$/i.test(exe) });
    child.stdin.end(agent === 'hermes' ? `${TASK} Název sekvence: STRIH ${tag}.` : prompt(tag), 'utf8');
    let cost = null;
    let usage = null;
    let turns = 0;
    const log = fs.createWriteStream(`${OUT}/${tag}.jsonl`);
    let buf = '';
    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        tail = (tail + line + '\n').slice(-4000);
        log.write(line + '\n');
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant') turns++;
          if (ev.type === 'result') {
            cost = ev.total_cost_usd ?? cost;
            usage = ev.usage || null;
          }
        } catch {
          /* prostý text (hermes) */
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (tail = (tail + d).slice(-4000)));
    child.on('close', (code) => {
      log.end();
      resolve({ sec: (Date.now() - t0) / 1000, cost, usage, turns, code, tail: tail.slice(-1500) });
    });
  });
}

/* ---------- hlavní smyčka ---------- */
for (const run of RUNS) {
  const name = `STRIH ${run.tag}`;
  console.log(`\n##### ${run.tag}`);
  const before = await sequenceList();
  const r = await runAgent(run);
  if (r.error) {
    console.log(`  ✖ ${r.error}`);
    results[run.tag] = { ...run, error: r.error };
  } else {
    let seq = null;
    const after = await sequenceList();
    const fresh = after.filter((x) => !before.some((b) => b.id === x.id));
    const hit = fresh.find((x) => x.name === name) || fresh[0];
    const created = hit?.id;
    if (created) {
      seq = JSON.parse(await call('get_sequence', { sequence: created }));
      const tokens = r.usage ? {
        input: r.usage.input_tokens, cacheWrite: r.usage.cache_creation_input_tokens,
        cacheRead: r.usage.cache_read_input_tokens, output: r.usage.output_tokens } : null;
      results[run.tag] = { ...run, sec: r.sec, cost: r.cost, turns: r.turns, tokens, sequence: hit.name, ...metrics(seq) };
      const m = results[run.tag];
      console.log(`  ${r.sec.toFixed(1)} s${r.cost ? `, $${r.cost.toFixed(3)}` : ''}, ${r.turns} kroků` +
        (tokens ? `, tokeny zápis ${tokens.cacheWrite} / čtení ${tokens.cacheRead} / výstup ${tokens.output}` : '') +
        ` → „${hit.name}" ${m.duration} s, ${m.sentences} vět, moderátor ${m.moderator}, useknuté ${m.fragments}, nedokončené ${m.unfinished}, odbočky ${m.offtopic}, Ferancová ${m.ferShare} %`);
    } else {
      results[run.tag] = { ...run, sec: r.sec, cost: r.cost, turns: r.turns, error: 'sekvence nevznikla', tail: r.tail };
      console.log(`  ✖ sekvence nevznikla (${r.sec.toFixed(1)} s). Konec výstupu:\n${r.tail.slice(-600)}`);
    }
  }
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1), 'utf8');
}

/* ---------- tabulka ---------- */
const rows = Object.values(results);
const md = ['# Srovnání modelů na stejném střihu', '', `Materiál: ${path.basename(SRC)} (${Math.round(tr.duration / 60)} min, ${segs.length} vět)`,
  '', `Zadání: *${TASK}*`, '', '| Model | Čas | Cena | Délka střihu | Vět | Moderátor | Useknuté věty | Parkování | Bydlení |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  md.push(r.error
    ? `| ${r.tag} | ${r.sec ? r.sec.toFixed(0) + ' s' : '—'} | ${r.cost ? '$' + r.cost.toFixed(3) : '—'} | ✖ ${r.error} | | | | | |`
    : `| ${r.tag} | ${r.sec.toFixed(0)} s | ${r.cost ? '$' + r.cost.toFixed(3) : '—'} | ${r.duration} s | ${r.sentences} | ${r.moderator} | ${r.fragments} | ${r.parking} | ${r.housing} |`);
}
for (const r of rows) if (r.ids) md.push('', `**${r.tag}** (${r.sequence}): ${r.ids.join(', ')}`);
fs.writeFileSync(`${OUT}/report.md`, md.join('\n'), 'utf8');
console.log(`\nReport: ${OUT}/report.md`);
await mcp.close();
