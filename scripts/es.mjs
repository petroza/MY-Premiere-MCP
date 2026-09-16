// Spustí ExtendScript v Premiere přes panel: node scripts/es.mjs soubor.jsx   (nebo --reload)
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const token = fs.readFileSync(path.join(process.env.APPDATA, 'MYpremiereMCP', 'token.txt'), 'utf8').trim();
const arg = process.argv[2];
const url = arg === '--reload' ? '/reload' : '/eval';
const body = arg === '--reload' ? {} : { code: fs.readFileSync(arg, 'utf8') };

const res = await fetch(`http://127.0.0.1:${cfg.port}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-PMCP-Token': token },
  body: JSON.stringify(body),
});
const out = await res.json();
console.log(res.status, out.raw ?? out.error);
