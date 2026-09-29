// Přímé spuštění jednoho nástroje MCP serveru bez AI agenta (panel: titulky, dabing) – zdarma a rychleji než
// přes Clauda, s průběhem. node scripts/run-tool.mjs <nástroj> '<json argumenty>'
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
const [tool, rawArgs] = process.argv.slice(2);
const say = (s) => process.stdout.write(s + '\n');
if (!tool) {
  say('✖ Chybí název nástroje.');
  process.exit(1);
}

/** Srozumitelné shrnutí výsledku pro panel (místo surového JSON). */
function summary(name, r) {
  if (name === 'add_captions') {
    return [
      `✔ Titulky přidány do „${r.sequence}“ – ${r.cues} titulků${r.translated ? ` (přeloženo do ${r.translated.target})` : ''}`,
      ...(r.sample || []).map((t) => `   „${t}“`),
    ];
  }
  if (name === 'import_media') {
    const seqs = (Array.isArray(r) ? r : Object.values(r).filter((x) => x && typeof x === 'object' && x.path))
      .filter((x) => x.sequence).map((x) => `   na timeline: sekvence „${x.sequence}“`);
    return [`✔ Vloženo do projektu${r.converted ? ' (převedeno na MP4):' : '.'}`, ...(r.converted || []).map((t) => `   ${t}`), ...seqs];
  }
  return [`✔ ${JSON.stringify(r).slice(0, 600)}`];
}

const c = new Client({ name: 'run-tool', version: '0' });
// env: SDK jinak předá serveru jen pár systémových proměnných (PATH, HOME…) – ladicí PLAN_DEBUG apod. by se ztratily
await c.connect(new StdioClientTransport({ command: 'node', args: [path.join(ROOT, 'server', 'index.js')], env: process.env }));
let last = '';
try {
  const r = await c.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} }, undefined, {
    timeout: 7200000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => {
      const m = `   ${Math.round((p.progress || 0) * 100)} % ${p.message || ''}`;
      // jen při změně popisu nebo každých ~10 %, ať se panel nezahltí
      if (m.replace(/\d+/g, '') !== last.replace(/\d+/g, '') || Math.abs(parseInt(m, 10) - parseInt(last, 10)) >= 10) {
        last = m;
        say(m);
      }
    },
  });
  const text = r.content?.[0]?.text || '';
  if (r.isError) {
    say('✖ ' + text);
    process.exitCode = 1;
  } else {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    for (const l of data ? summary(tool, data) : [text]) say(l);
  }
} catch (e) {
  say('✖ ' + (e?.message || e));
  process.exitCode = 1;
} finally {
  await c.close();
}
