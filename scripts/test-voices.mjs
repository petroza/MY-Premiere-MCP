// Test knihovny hlasů: diarizace -> pojmenování (uloží otisk) -> nová diarizace pozná jména sama
// + kontrola, že jiné video s jinými lidmi se nepřiřadí omylem.  node scripts/test-voices.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'O:/MYpremiereMCP';
const DEBATE = 'C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4';
const OTHER = `${ROOT}/test/podcast/Diskuse1.mp4`;
const NAMES = ['Ferancová', 'Vašíř', 'Moderátor Napřímo']; // podle času řeči sestupně

const c = new Client({ name: 'test-voices', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: [`${ROOT}/server/index.js`] }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 3600000, resetTimeoutOnProgress: true });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
const diaFile = (src) => JSON.parse(fs.readFileSync(`${ROOT}/cache/diarization/index.json`, 'utf8'))[path.resolve(src).toLowerCase()];
const dia = (src) => JSON.parse(fs.readFileSync(diaFile(src), 'utf8'));
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✖'} ${msg}`); if (!ok) failed++; };

console.log('1) diarizace debaty (bez knihovny)');
await call('diarize_media', { path: DEBATE, force: true });
let d = dia(DEBATE);
console.log('   mluvčí:', JSON.stringify(d.speakingTime));
check(Object.keys(d.centroids || {}).length >= 2, `spočítány hlasové otisky (${Object.keys(d.centroids || {}).length})`);

console.log('2) pojmenování + uložení hlasů');
const order = Object.entries(d.speakingTime).sort((a, b) => b[1] - a[1]).map(([k]) => k);
const mapping = Object.fromEntries(order.slice(0, NAMES.length).map((k, i) => [k, NAMES[i]]));
console.log('   mapování:', JSON.stringify(mapping));
console.log('  ', (await call('rename_speakers', { path: DEBATE, mapping })).slice(0, 200).replace(/\s+/g, ' '));
const voices = JSON.parse(await call('list_voices', {}));
check(voices.voices.length >= NAMES.length, `knihovna má ${voices.voices.length} hlasů: ${voices.voices.map((v) => v.name).join(', ')}`);

console.log('3) nová diarizace téhož videa – jména by měla naskočit sama');
await call('diarize_media', { path: DEBATE, force: true });
d = dia(DEBATE);
console.log('   rozpoznáno:', JSON.stringify(d.matchedVoices || {}));
check(Object.values(d.matchedVoices || {}).length >= 2, 'hlasy z knihovny se přiřadily automaticky');
check(NAMES.some((n) => Object.keys(d.speakingTime).includes(n)), `mluvčí mají jména: ${Object.keys(d.speakingTime).join(', ')}`);

console.log('4) jiné video s jinými lidmi – nesmí si je splést');
await call('diarize_media', { path: OTHER, force: true });
const o = dia(OTHER);
console.log('   rozpoznáno:', JSON.stringify(o.matchedVoices || {}), '| mluvčí:', Object.keys(o.speakingTime).join(', '));
check(Object.keys(o.matchedVoices || {}).length === 0, 'cizí hlasy se k uloženým jménům nepřiřadily');

await c.close();
console.log(failed ? `\n✖ ${failed} chyb` : '\n✔ vše prošlo');
process.exit(failed ? 1 : 0);
