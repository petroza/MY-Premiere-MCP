// Offline kontrola panelu: zakázané znaky ve zdrojích + JSON serializace z host.jsx.
import fs from 'node:fs';

let bad = 0;
for (const f of ['panel/main.js', 'panel/host/host.jsx', 'server/index.js']) {
  const t = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const n = [...t].filter((ch) => {
    const c = ch.codePointAt(0);
    return c === 0x2028 || c === 0x2029 || (c < 32 && c !== 9 && c !== 10 && c !== 13);
  }).length;
  console.log(f, n ? `BAD ${n}` : 'ok');
  bad += n;
}

const src = fs.readFileSync(new URL('../panel/host/host.jsx', import.meta.url), 'utf8');
const PMCP = new Function(`${src}; return PMCP;`)();
const value = {
  a: 'uvozovka " zpetne \\ radek\n tab\t ls' + String.fromCharCode(0x2028) + ' nul' + String.fromCharCode(1),
  n: [1, 2.5, null, true],
  o: { x: 'žluťoučký kůň' },
};
const s = PMCP.toJSON(value);
const ok = JSON.stringify(JSON.parse(s)) === JSON.stringify(value);
console.log(ok ? 'toJSON roundtrip OK' : `toJSON MISMATCH ${s}`);
const r = JSON.parse(PMCP.call('neexistuje', '{}'));
console.log('call neznámé funkce ->', r.ok, r.error);
process.exit(bad || !ok ? 1 : 0);
