// Spouštěč MCP serveru MY Premiere MCP pro plugin aplikace Claude (PLUGIN CLAUDE). Kopíruje se do pluginu jako
// server/start.mjs a .mcp.json ho spouští přes `node`. Najde složku aplikace kdekoli (flash disk, jiný disk) a spustí
// její server/index.js. Bez závislostí – plugin sám nemá node_modules.
//  - složka: MYPREMIEREMCP_ROOT, %APPDATA%\MYpremiereMCP\root.txt (zapisuje instalátor), X:\MYpremiereMCP na všech
//    discích, %USERPROFILE%\MYpremiereMCP
//  - když je server „premiere“ už zaregistrovaný instalátorem pro Claude Code (~/.claude.json), tenhle nástroje
//    nenabízí – jinak by v aplikaci byly všechny nástroje dvakrát
//  - když složka chybí, odpoví prázdným MCP serverem s pokynem (místo pádu, který aplikace hlásí jako chybu)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isRoot = (d) => !!d && fs.existsSync(path.join(d, 'server', 'index.js')) && fs.existsSync(path.join(d, 'panel', 'index.html'));

function findRoot() {
  const c = [process.env.MYPREMIEREMCP_ROOT];
  try {
    c.push(fs.readFileSync(path.join(process.env.APPDATA || '', 'MYpremiereMCP', 'root.txt'), 'utf8').trim());
  } catch {
    /* instalátor tu ještě neběžel */
  }
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') c.push(`${L}:\\MYpremiereMCP`);
  c.push(path.join(os.homedir(), 'MYpremiereMCP'));
  return c.find(isRoot) || null;
}

function registeredElsewhere() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const s = cfg.mcpServers?.premiere;
    return !!s && (s.args || []).some((a) => typeof a === 'string' && fs.existsSync(a));
  } catch {
    return false;
  }
}

// Minimální MCP server bez nástrojů (JSON-RPC přes stdio) – jen s pokynem pro Clauda
function stub(instructions) {
  let buf = '';
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; // notifikace
      if (m.method === 'initialize') {
        reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} },
          serverInfo: { name: 'my-premiere-mcp', version: '1.0' }, instructions });
      } else if (m.method === 'tools/list') reply(m.id, { tools: [] });
      else reply(m.id, {});
    }
  });
}

const root = findRoot();
if (root && !registeredElsewhere()) {
  await import(pathToFileURL(path.join(root, 'server', 'index.js')).href);
} else if (root) {
  stub('Nástroje MY Premiere MCP poskytuje MCP server „premiere“ zaregistrovaný instalátorem – použij ty.');
} else {
  stub('MY Premiere MCP na tomhle počítači nenašel. Zkopíruj složku MYpremiereMCP na disk (např. D:\\MYpremiereMCP) ' +
    'a spusť /my-premiere-mcp:install, nebo nastav proměnnou MYPREMIEREMCP_ROOT na její cestu.');
}
