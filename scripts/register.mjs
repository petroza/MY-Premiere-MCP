// Registrace MCP serveru "premiere" do Claude Code, Claude Desktop a Codexu (se zálohou konfigurací).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.js').replace(/\\/g, '/');
const NODE = process.execPath.replace(/\\/g, '/');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function backup(file) {
  const b = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, b);
  return b;
}

// Claude Code (user scope)
try {
  const claude = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  let exists = true;
  let registered = '';
  try {
    registered = execFileSync(claude, ['mcp', 'get', 'premiere'], { stdio: 'pipe', encoding: 'utf8' });
  } catch {
    exists = false;
  }
  // registrace ze staré instalace, která už neexistuje (přesunutá/smazaná složka) – přeregistrovat;
  // živou jinou instalaci nechat být (např. zkušební instalace nesmí přebrat tu hlavní)
  const oldPath = (registered.match(/^\s*Args:\s*(.+?)\s*$/m) || [])[1];
  if (exists && oldPath && !fs.existsSync(oldPath)) {
    execFileSync(claude, ['mcp', 'remove', 'premiere', '-s', 'user'], { stdio: 'pipe' });
    console.log(`Claude Code: stará registrace ukazovala na neexistující ${oldPath} – registruji znovu`);
    exists = false;
  }
  if (exists) console.log('Claude Code: "premiere" už je zaregistrovaný');
  else {
    // "node" z PATH: cesta "C:/Program Files/..." by se v konfiguraci Claude Code rozdelila na mezere
    execFileSync(claude, ['mcp', 'add', '--scope', 'user', 'premiere', '--', 'node', SERVER], { stdio: 'inherit' });
    console.log('Claude Code: zaregistrováno');
  }
} catch (e) {
  console.log('Claude Code: přeskočeno –', e.message);
}

// Claude Desktop
const desktop = path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
if (fs.existsSync(desktop)) {
  const cfg = JSON.parse(fs.readFileSync(desktop, 'utf8'));
  cfg.mcpServers ??= {};
  const dead = cfg.mcpServers.premiere && !fs.existsSync(cfg.mcpServers.premiere.args?.[0] || '');
  if (cfg.mcpServers.premiere && !dead) console.log('Claude Desktop: už je zaregistrovaný');
  else {
    const b = backup(desktop);
    cfg.mcpServers.premiere = { command: NODE, args: [SERVER] };
    fs.writeFileSync(desktop, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`Claude Desktop: zaregistrováno (záloha ${b}) – restartuj Claude Desktop`);
  }
}

// Codex
const codex = path.join(os.homedir(), '.codex', 'config.toml');
if (fs.existsSync(codex)) {
  let txt = fs.readFileSync(codex, 'utf8');
  const sect = txt.match(/^\[mcp_servers\.premiere\][^\[]*/m);
  const codexOld = sect && (sect[0].match(/^args\s*=\s*\["([^"]+)"/m) || [])[1];
  const codexDead = sect && codexOld && !fs.existsSync(codexOld);
  if (sect && !codexDead) console.log('Codex: už je zaregistrovaný');
  else {
    const b = backup(codex);
    if (codexDead) {
      // registrace ze smazané/přesunuté instalace – nahradit
      txt = txt.replace(sect[0], '');
      fs.writeFileSync(codex, txt, 'utf8');
    }
    const block = `\n[mcp_servers.premiere]\ncommand = "${NODE}"\nargs = ["${SERVER}"]\nstartup_timeout_sec = 20\ntool_timeout_sec = 1800\n`;
    fs.appendFileSync(codex, block, 'utf8');
    console.log(`Codex: zaregistrováno (záloha ${b})`);
  }
}
