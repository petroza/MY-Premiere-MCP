// Samostatný repozitář github.com/petroza/MY-Premiere-MCP (z něj stahuje kód online instalátor INSTALL\Instalace.cmd)
// = kopie složky „MY Premiere MCP - plugin do Premiere - zdrojovy kod“ z monorepa AI-EDIT-for-all-.
// Vezme commitnutý stav složky (git archive HEAD:<složka>), přepíše jím klon MY-Premiere-MCP, commitne a pošle.
//   node scripts/sync-standalone-repo.mjs [--dry]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY = process.argv.includes('--dry');
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONO = path.resolve(APP, '..');
const PREFIX = path.basename(APP);
const URL = 'https://github.com/petroza/MY-Premiere-MCP.git';
const WORK = path.join(os.tmpdir(), 'my-premiere-mcp-sync');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

const head = git(MONO, 'rev-parse', '--short', 'HEAD').trim();
const msg = git(MONO, 'log', '-1', '--format=%s', '--', PREFIX).trim();
if (fs.existsSync(path.join(WORK, '.git'))) { git(WORK, 'fetch', '-q', 'origin'); git(WORK, 'reset', '-q', '--hard', 'origin/main'); }
else { fs.rmSync(WORK, { recursive: true, force: true }); git(os.tmpdir(), 'clone', '-q', URL, WORK); }

// vyčistit klon (kromě .git) a rozbalit commitnutý stav složky z monorepa
for (const f of fs.readdirSync(WORK)) if (f !== '.git') fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
const tar = path.join(os.tmpdir(), 'my-premiere-mcp-sync.tar');
execFileSync('git', ['archive', '--format=tar', '-o', tar, `HEAD:${PREFIX}`], { cwd: MONO });
// tar z Windows (bsdtar); GNU tar z Gitu bere „C:“ jako síťový počítač
const TAR = fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';
execFileSync(TAR, ['-xf', tar, '-C', WORK]);
fs.rmSync(tar, { force: true });

git(WORK, 'add', '-A');
const changed = git(WORK, 'status', '--porcelain').trim();
if (!changed) { console.log('MY-Premiere-MCP: beze změny'); process.exit(0); }
console.log(`MY-Premiere-MCP: ${changed.split('\n').length} změněných souborů`);
if (DRY) { console.log(changed.split('\n').slice(0, 20).join('\n')); process.exit(0); }
git(WORK, 'commit', '-q', '-m', `${msg}\n\nSynchronizováno z AI-EDIT-for-all- (${head}).`);
git(WORK, 'push', '-q', 'origin', 'HEAD:main');
console.log('MY-Premiere-MCP: nahráno');
