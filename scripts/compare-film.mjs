// Srovnání Claude / Codex (GPT) na stejném zadání, jaké dostal Hermes z panelu – film 2000 Meters to Andriivka.
// Každý agent běží přes stejné CLI a nastavení jako panel, postaví vlastní sekvenci; skript změří čas, tokeny,
// délku střihu, useknuté/nedokončené věty a jazyky. Hermes (hotová sekvence z panelu) se přidá podle názvu.
//
//   node scripts/compare-film.mjs [claude:sonnet,codex:gpt-6-astra] ["název Hermesovy sekvence"]
// Výsledky: test/agent-compare-film/results.json + report.md, průběh <TAG>.jsonl
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const SRC = process.env.SRC || 'C:/Users/Petr/Downloads/01-video/2000.Meters.To.Andriivka.2025.1080p.WEBRip.x264.AAC-WORLD.mp4';
const OUT = process.env.OUT || `${ROOT}/test/agent-compare-film`;
const TASK = process.env.TASK || 'Sestříhej to nejdůležitější jako nejsrozumitelnější sdelění o válce na ukrajině. do jedné minuty';
const RUNS = (process.argv[2] || 'claude:sonnet,codex:gpt-5.6-sol').replace(/^-$/, '').split(',').filter(Boolean).map((s) => {
  const [agent, model] = s.split(':');
  return { agent, model, tag: `${agent}-${model}`.toUpperCase() };
});
const HERMES_SEQ = process.argv[3] || null;
// stejné jako panel: zadání uživatele + kontext (zdroj), agent sám zvolí postup
const prompt = (tag) =>
  `Video ${SRC} už má hotový přepis v cache – NEPŘEPISUJ ho znovu. Úkol: ${TASK} ` +
  `Výsledek vytvoř jako novou sekvenci s názvem přesně "STRIH ${tag}".`;

fs.mkdirSync(OUT, { recursive: true });
const resultsFile = `${OUT}/results.json`;
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};

const mcp = new Client({ name: 'compare-film', version: '0' });
await mcp.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 1800000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
const idx = JSON.parse(fs.readFileSync(`${ROOT}/cache/transcripts/index.json`, 'utf8'));
const tr = JSON.parse(fs.readFileSync(idx[path.resolve(SRC).toLowerCase()], 'utf8'));
const segs = tr.segments;
const byId = new Map(segs.map((s) => [s.id, s]));

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
  const lang = (t) => (/[а-яіїєґ]/i.test(t) ? 'UA/RU' : 'EN');
  const langs = {};
  for (const i of ids) langs[lang(byId.get(i).text)] = (langs[lang(byId.get(i).text)] || 0) + 1;
  return {
    duration: Math.round(seq.duration * 10) / 10,
    clips: (seq.clips || []).filter((c) => c.kind === 'video').length,
    sentences: ids.length,
    ids,
    // začíná malým písmenem a předchozí věta ve výběru není = useknutý začátek
    fragments: ids.filter((i) => /^\p{Ll}/u.test(byId.get(i).text.trim()) && !ids.includes(i - 1)).length,
    unfinished: ids.filter((i) => byId.get(i + 1) && /^\p{Ll}/u.test(byId.get(i + 1).text.trim()) && !ids.includes(i + 1)).length,
    langs,
    text: ids.map((i) => `#${i} ${byId.get(i).text.trim()}`),
  };
}
const sequenceList = async () => JSON.parse(await call('get_project')).sequences.map((s) => ({ name: s.name, id: s.sequenceID }));

function findExe(name) {
  try {
    const lines = execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const hit = lines.find((l) => /\.exe$/i.test(l)) || lines[0];
    if (hit) return hit;
  } catch { /* není v PATH */ }
  if (name === 'codex') {
    const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    try {
      const dirs = fs.readdirSync(base).map((d) => path.join(base, d, 'codex.exe')).filter((p) => fs.existsSync(p));
      if (dirs.length) return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    } catch { /* není */ }
  }
  return null;
}

function runAgent({ agent, model, tag }) {
  return new Promise((resolve) => {
    const exe = findExe(agent);
    if (!exe) return resolve({ error: `${agent} CLI nenalezeno` });
    const args = agent === 'claude'
      // stejně jako panel: jen ToolSearch, effort medium, krátký systémový prompt
      ? ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', path.join(ROOT, 'mcp.json'),
        '--strict-mcp-config', '--allowedTools', 'mcp__premiere', '--model', model, '--tools=ToolSearch',
        '--effort', 'medium', '--system-prompt', fs.readFileSync(path.join(ROOT, 'panel', 'agent-system.md'), 'utf8')]
      : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
        '-c', 'mcp_servers.premiere.command="node"', '-c', `mcp_servers.premiere.args=["${ROOT}/server/index.js"]`,
        '-c', 'mcp_servers.premiere.default_tools_approval_mode="approve"', '-m', model, '-'];
    const t0 = Date.now();
    const child = spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: /\.(cmd|bat)$/i.test(exe) });
    child.stdin.end(prompt(tag), 'utf8');
    let cost = null;
    const tok = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    let turns = 0;
    let tools = 0;
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
          if (ev.type === 'assistant') {
            turns++;
            tools += (ev.message?.content || []).filter((c) => c.type === 'tool_use').length;
          }
          if (ev.type === 'result') {
            cost = ev.total_cost_usd ?? cost;
            const u = ev.usage || {};
            Object.assign(tok, { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0,
              cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0 });
          }
          // Codex: usage po každém tahu (input zahrnuje i cached)
          if (ev.type === 'turn.completed' && ev.usage) {
            turns++;
            tok.input += (ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0);
            tok.cached += ev.usage.cached_input_tokens || 0;
            tok.output += ev.usage.output_tokens || 0;
          }
          if (ev.type === 'item.completed' && ev.item?.type === 'mcp_tool_call') tools++;
        } catch { /* prostý text */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (tail = (tail + d).slice(-4000)));
    child.on('close', (code) => {
      log.end();
      resolve({ sec: (Date.now() - t0) / 1000, cost, tok, turns, tools, code, tail: tail.slice(-1500) });
    });
  });
}

if (HERMES_SEQ) {
  const seq = JSON.parse(await call('get_sequence', { sequence: HERMES_SEQ }));
  results.HERMES = { ...(results.HERMES || {}), agent: 'hermes', model: 'Qwen3.6-35B (lokálně)', tag: 'HERMES',
    sequence: seq.name, ...metrics(seq) };
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1), 'utf8');
}

for (const run of RUNS) {
  console.log(`\n##### ${run.tag}`);
  const before = await sequenceList();
  const r = await runAgent(run);
  if (r.error) { results[run.tag] = { ...run, error: r.error }; console.log(`  ✖ ${r.error}`); continue; }
  const after = await sequenceList();
  const fresh = after.filter((x) => !before.some((b) => b.id === x.id));
  const hit = fresh.find((x) => x.name === `STRIH ${run.tag}`) || fresh[0];
  if (hit) {
    const seq = JSON.parse(await call('get_sequence', { sequence: hit.id }));
    results[run.tag] = { ...run, sec: r.sec, cost: r.cost, turns: r.turns, tools: r.tools, tokens: r.tok, sequence: hit.name, ...metrics(seq) };
    const m = results[run.tag];
    console.log(`  ${r.sec.toFixed(0)} s, ${r.cost ? '$' + r.cost.toFixed(3) + ', ' : ''}tokeny ${JSON.stringify(r.tok)}, ` +
      `${r.tools} nástrojů → ${m.duration} s, ${m.sentences} vět, useknuté ${m.fragments}, nedokončené ${m.unfinished}`);
  } else {
    results[run.tag] = { ...run, sec: r.sec, cost: r.cost, tokens: r.tok, error: 'sekvence nevznikla', tail: r.tail };
    console.log(`  ✖ sekvence nevznikla (${r.sec.toFixed(0)} s)\n${r.tail.slice(-600)}`);
  }
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1), 'utf8');
}
fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1), 'utf8');
console.log(`\nVýsledky: ${resultsFile}`);
await mcp.close();
