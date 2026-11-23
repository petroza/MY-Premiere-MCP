// QA hotové sekvence: technické drobnosti střihu, které nesmí projít (useknuté slovo, utnutá věta, začátek na
// nevyřčené, moderátor bez odpovědi, chybějící prolnutí, délka, mezery, odpad přepisu). JEN ČTE – nic nemění.
//   node scripts/qa-sequence.mjs "<název sekvence>" [cílová délka s] [--no-cuts] [--json]
// Výstup: ✔ v pořádku · ✖ chyba (exit kód 1) · ⚠ upozornění (nerozhoduje o exit kódu) · – nelze ověřit.
// Texty úseků se berou stejně jako ve scripts/seq-text.mjs (slova přepisu uvnitř klipu); souvětí stejně jako
// continuityWarnings v server/index.js (věta s . ! ? a pauzou ≥ 0,8 s je uzavřená).
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // cesta s mezerami: .pathname by nechal %20
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
let noCuts = flag('--no-cuts');
// --from-json <soubor>: výstup get_sequence ze souboru (offline test bez Premiere; prolnutí se pak neověřují)
const fjAt = args.indexOf('--from-json');
const fromJson = fjAt >= 0 ? args.splice(fjAt, 2)[1] : null;
if (fromJson) noCuts = true;
const asJson = flag('--json');
const seqName = args[0];
const target = args[1] !== undefined ? Number(args[1]) : null;
if (!seqName) {
  console.error('Použití: node scripts/qa-sequence.mjs "<název sekvence>" [cílová délka s] [--no-cuts] [--json]');
  process.exit(2);
}

/* ---------------------------------------------------------------- data ze sekvence */

const c = new Client({ name: 'qa-sequence', version: '0' });
if (!fromJson) await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'server', 'index.js')], env: { ...process.env } }));
const call = async (name, a) => {
  const r = await c.callTool({ name, arguments: a }, undefined, { timeout: 120000 });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].text;
};
let host = null;
if (!fromJson) {
  try { host = JSON.parse(await call('premiere_status', {})); } catch { /* get_sequence níž ohlásí, že most neodpovídá */ }
}
const seq = fromJson ? JSON.parse(fs.readFileSync(fromJson, 'utf8')) : JSON.parse(await call('get_sequence', { sequence: seqName }));

// zvuková prolnutí: v get_sequence nejsou, čte se z Premiere přes ExtendScript (Track.transitions, jen čtení)
let fadeInfo;
if (fromJson) fadeInfo = { err: 'offline test (--from-json)' };
else try {
  const code = `(function(){var N=${JSON.stringify(seq.name)};var s=null,i,k,t;` +
    `for(i=0;i<app.project.sequences.numSequences;i++){if(app.project.sequences[i].name===N){s=app.project.sequences[i];break;}}` +
    `if(!s)return 'ERR sekvence nenalezena';var out=[];` +
    `for(t=0;t<s.audioTracks.numTracks;t++){var tr;try{tr=s.audioTracks[t].transitions;}catch(e){return 'ERR Track.transitions: '+e;}` +
    `if(!tr)return 'ERR Track.transitions chybí';for(k=0;k<tr.numItems;k++){out.push(t+':'+tr[k].start.seconds+':'+tr[k].end.seconds);}}` +
    `return 'OK '+out.join(',');})()`;
  const txt = (await call('run_extendscript', { code })).trim();
  const body = txt.replace(/^"|"$/g, '');
  if (body.startsWith('OK')) {
    fadeInfo = { items: body.slice(2).trim().split(',').filter(Boolean).map((x) => { const [t, s, e] = x.split(':').map(Number); return { t, s, e }; }) };
  } else fadeInfo = { err: body };
} catch (e) {
  fadeInfo = { err: String(e.message).replace(/^run_extendscript:\s*/, '').replace(/^.*?"error":"/, '').slice(0, 160) };
}
if (!fromJson) await c.close();

const fps = seq.fps || 25;
const fr = 1 / fps;
const clips = seq.clips || [];
const sorted = (kind, t) => clips.filter((x) => x.kind === kind && x.track === t).sort((a, b) => a.start - b.start);
const textKind = sorted('video', 0).some((x) => x.mediaPath) ? 'video' : 'audio';
const main = sorted(textKind, 0).filter((x) => x.mediaPath);

const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', 'transcripts', 'index.json'), 'utf8'));
const trCache = new Map();
const transcriptOf = (p) => {
  const k = path.resolve(p).toLowerCase();
  if (!trCache.has(k)) {
    const f = idx[k];
    trCache.set(k, f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  }
  return trCache.get(k);
};

/** Pro klip: slova přepisu uvnitř (většina délky slova), věty, mluvčí. */
function analyseClip(cl) {
  const tr = transcriptOf(cl.mediaPath);
  if (!tr) return { cl, tr: null, words: [] };
  const byId = new Map(tr.segments.map((s) => [s.id, s]));
  const words = [];
  for (const s of tr.segments) {
    (s.words || []).forEach((w, wi) => {
      if (Math.min(w.e, cl.outPoint) - Math.max(w.s, cl.inPoint) > 0.5 * (w.e - w.s)) words.push({ ...w, id: s.id, wi, spk: w.spk || s.speaker });
    });
  }
  const ids = [...new Set(words.map((w) => w.id))];
  const cnt = new Map();
  for (const w of words) cnt.set(w.spk, (cnt.get(w.spk) || 0) + 1);
  const speaker = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { cl, tr, byId, words, ids, speaker };
}
const A = main.map(analyseClip);
const allIds = new Set(A.flatMap((a) => a.ids || []));

/* ---------------------------------------------------------------- pomocné */

const T = (x) => `${x.toFixed(2)}`;
const label = (i) => `úsek ${i + 1} [${T(A[i].cl.inPoint)}–${T(A[i].cl.outPoint)}]`;
const isTerminal = (w) => /[.!?]["”“)»]*$/.test(w) && !/(\.\.\.|…)["”“)»]*$/.test(w);
const isEllipsis = (w) => /(\.\.\.|…)["”“)»]*$/.test(w);
const lowerStart = (w) => /^\p{Ll}/u.test((w || '').replace(/^["„“”(»-]+/, ''));
const norm = (w) => (w || '').toLowerCase().replace(/[^\p{L}]+/gu, '');
// věta uzavřená . ! ? (ne „…“) + pauza ≥ 0,8 s = samostatná myšlenka (stejně jako server/index.js continuityWarnings)
const closed = (a, b) => isTerminal((a?.text || '').trim()) && Number(b?.start) - Number(a?.end) >= 0.8;
const MODERATOR = /moder[aá]tor|moderuje|hostitel|redaktor|reportér/i;

const results = [];
const add = (name, status, details = []) => results.push({ name, status, details });

/* ---------------------------------------------------------------- 1. hranice podle zvuku (check-cuts) */

if (noCuts) {
  add('slyšitelné hranice / useknuté slovo', '–', ['přeskočeno (--no-cuts)']);
} else {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'check-cuts.mjs'), seq.name], { encoding: 'utf8', cwd: ROOT, timeout: 600000, maxBuffer: 1 << 24 });
  const lines = (r.stdout || '').split(/\r?\n/);
  const sum = [...lines].reverse().find((l) => /hranic/.test(l) && /^[✔✖]/.test(l));
  const edges = lines.filter((l) => /^[✔✖] (začátek|konec)/.test(l));
  const fails = edges.filter((l) => l.startsWith('✖'));
  if (r.status !== 0 && !fails.length) add('slyšitelné hranice / useknuté slovo', '✖', ['check-cuts selhal: ' + ((r.stderr || r.stdout || 'bez výstupu').trim().split('\n').slice(-3).join(' | ')).slice(0, 300)]);
  else add('slyšitelné hranice / useknuté slovo', fails.length ? '✖' : '✔', fails.length ? fails.map((l) => l.replace(/\s+/g, ' ')) : [(sum || '').replace(/^[✔✖]\s*/, '')]);
}

/* ---------------------------------------------------------------- 2. utnuté souvětí / věty na krajích */

{
  const errs = [];
  const warns = [];
  const missing = [];
  A.forEach((a, i) => {
    if (!a.tr) { missing.push(`${label(i)}: zdroj bez přepisu`); return; }
    if (!a.words.length) { warns.push(`${label(i)}: v klipu nejsou žádná slova přepisu (ticho / jiný zdroj)`); return; }
    const first = a.words[0];
    const last = a.words.at(-1);
    const L = a.byId.get(last.id);
    const F = a.byId.get(first.id);
    // --- konec
    const lastTxt = last.w.trim();
    const endsMid = last.wi < (L.words || []).length - 1;
    if (isEllipsis(lastTxt)) errs.push(`${label(i)}: končí „${lastTxt}“ – nedořečená věta (#${last.id})`);
    else if (!isTerminal(lastTxt)) {
      if (endsMid || /,$/.test(lastTxt)) errs.push(`${label(i)}: končí uprostřed věty – poslední slovo „${lastTxt}“ (#${last.id})`);
      else warns.push(`${label(i)}: poslední věta #${last.id} bez koncové interpunkce („${lastTxt}“)`);
    }
    if (!endsMid) {
      const next = a.byId.get(last.id + 1);
      if (next && lowerStart(next.text.trim()) && next.speaker === L.speaker && !allIds.has(next.id) && !closed(L, next)) {
        errs.push(`${label(i)}: #${L.id} pokračuje větou #${next.id} („${next.text.trim().slice(0, 40)}${next.text.trim().length > 40 ? '…' : ''}“), která ve střihu chybí`);
      }
    }
    // --- začátek
    if (first.wi === 0) {
      const prev = a.byId.get(first.id - 1);
      if (prev && prev.speaker === F.speaker && !closed(prev, F)) {
        const pe = isEllipsis(prev.text.trim());
        if (pe) errs.push(`${label(i)}: začíná druhou půlkou souvětí – předchozí věta #${prev.id} končí „…“ („${prev.text.trim().slice(-30)}“)`);
        else if (lowerStart(F.text.trim()) && !allIds.has(prev.id)) errs.push(`${label(i)}: #${F.id} začíná malým písmenem uprostřed souvětí – chybí #${prev.id}`);
      }
    } else {
      const pw = F.words[first.wi - 1]?.w || '';
      if (lowerStart(first.w) && !isTerminal(pw)) errs.push(`${label(i)}: začíná uprostřed věty – „${first.w}“ po „${pw}“ (#${first.id})`);
    }
  });
  const det = [...errs.map((x) => x), ...warns.map((x) => '⚠ ' + x), ...missing.map((x) => '– ' + x)];
  add('utnutá věta / souvětí na krajích úseků', errs.length ? '✖' : warns.length || missing.length ? '⚠' : '✔', det.length ? det : ['všechny kraje úseků na hranici věty']);
}

/* ---------------------------------------------------------------- 3. začátek na nevyřčené */

{
  const errs = [];
  const warns = [];
  const REACT = new Set(['jo', 'ano', 'ne', 'no', 'jasně', 'absolutně', 'přesně', 'právě', 'určitě', 'samozřejmě', 'hm', 'hmm', 'aha', 'dobře', 'správně', 'tak', 'takže', 'výborně', 'fajn', 'super']);
  const STARTER = new Set([...REACT, 'a', 'protože', 'jenže']);
  // „Ale už jsem měla takový pocit…“ obstojí i samo (analysis.dependent), proto jen upozornění – i u úvodní věty
  const SOFT = new Set(['ale', 'pak', 'potom', 'tedy', 'tudíž', 'čili']);
  A.forEach((a, i) => {
    if (!a.words.length) return;
    // první věta úseku (po první koncovou interpunkci)
    const fs_ = [];
    for (const w of a.words) { fs_.push(w); if (isTerminal(w.w.trim()) || isEllipsis(w.w.trim())) break; }
    const w0 = norm(fs_[0].w);
    const isFirst = i === 0;
    const shortReact = fs_.length <= 3 && fs_.length < a.words.length && REACT.has(w0);
    const txt = fs_.map((w) => w.w).join(' ');
    if (shortReact) errs.push(`${label(i)}: začíná reakcí „${txt}“ – navazuje na nevyřčené`);
    else if (STARTER.has(w0)) (isFirst ? errs : warns).push(`${label(i)}: ${isFirst ? 'úvodní' : ''} věta začíná „${fs_[0].w}“ (navazuje?): „${txt.slice(0, 60)}“`.replace(': ', ': ').replace('  ', ' '));
    else if (SOFT.has(w0)) warns.push(`${label(i)}: věta začíná „${fs_[0].w}“ – navazuje na předchozí?: „${txt.slice(0, 60)}“`);
    else if (isFirst && w0 === 'to') warns.push(`${label(i)}: úvodní věta začíná „To“ – bez kontextu?: „${txt.slice(0, 60)}“`);
  });
  add('začátek klipu navazuje na nevyřčené', errs.length ? '✖' : warns.length ? '⚠' : '✔',
    errs.length || warns.length ? [...errs, ...warns.map((x) => '⚠ ' + x)] : ['žádný úsek nezačíná spojkou/reakcí']);
}

/* ---------------------------------------------------------------- 4. moderátor / otázka bez odpovědi */

{
  const spk = new Set(A.flatMap((a) => a.words.map((w) => w.spk)).filter(Boolean));
  const allSpk = new Set((A.find((a) => a.tr)?.tr?.segments || []).map((s) => s.speaker).filter(Boolean));
  const mods = new Set([...allSpk].filter((s) => MODERATOR.test(s)));
  if (!A.some((a) => a.tr)) add('moderátor / otázka bez odpovědi', '–', ['bez přepisu']);
  else if (!mods.size) add('moderátor / otázka bez odpovědi', '–', [`moderátor v přepisu nerozpoznán (mluvčí: ${[...allSpk].join(', ') || '?'})`]);
  else {
    const errs = [];
    const warns = [];
    const isMod = (a) => mods.has(a.speaker);
    const modIdx = A.map((a, i) => (isMod(a) ? i : -1)).filter((i) => i >= 0);
    if (A.length && A.every(isMod)) errs.push('celý střih je od moderátora');
    for (const i of modIdx) {
      const a = A[i];
      const nxt = A[i + 1];
      // odpověď = další úsek od hosta, navazující ve zdroji (do 4 s za koncem otázky)
      const answered = nxt && !isMod(nxt) && nxt.cl.mediaPath === a.cl.mediaPath && nxt.cl.inPoint - a.cl.outPoint < 4 && nxt.cl.inPoint >= a.cl.outPoint - 0.5;
      if (!answered && A.length > 1) errs.push(`${label(i)}: moderátor (${a.speaker}) bez odpovědi hosta hned za otázkou`);
      else if (!nxt) errs.push(`${label(i)}: střih končí moderátorem`);
      else if (seq.duration <= 60) warns.push(`${label(i)}: moderátor v krátkém výroku (${(a.cl.end - a.cl.start).toFixed(1)} s) – je otázka nutná?`);
    }
    A.forEach((a, i) => {
      if (isMod(a) || !a.words.length) return;
      const mw = a.words.filter((w) => mods.has(w.spk));
      if (!mw.length) return;
      const sec = mw.reduce((x, w) => x + (w.e - w.s), 0);
      const atStart = mods.has(a.words[0].spk);
      if (seq.duration <= 60 || !atStart) warns.push(`${label(i)}: ${atStart ? 'začíná otázkou moderátora' : 'uvnitř mluví moderátor'} (${sec.toFixed(1)} s: „${mw.map((w) => w.w).join(' ').slice(0, 50)}“)`);
    });
    if (A[0] && isMod(A[0]) && A.length > 1 && !errs.length && seq.duration <= 60) warns.push('krátký střih začíná moderátorem');
    add('moderátor / otázka bez odpovědi', errs.length ? '✖' : warns.length ? '⚠' : '✔',
      [...errs, ...warns.map((x) => '⚠ ' + x)].concat(errs.length || warns.length ? [] : [`mluví: ${[...spk].join(', ')}`]));
  }
}

/* ---------------------------------------------------------------- 5. zvuková prolnutí */

{
  const aud = sorted('audio', 0);
  if (aud.length < 2) add('zvuková prolnutí na střizích', '–', ['jednoklipová sekvence – bez střihu']);
  else if (fadeInfo.err) add('zvuková prolnutí na střizích', '–', [`nelze ověřit: ${fadeInfo.err}`]);
  else {
    const tol = 0.1;
    const miss = [];
    aud.forEach((cl, i) => {
      const near = (t) => fadeInfo.items.some((x) => x.t === 0 && (Math.abs(x.s - t) < tol || Math.abs(x.e - t) < tol || (x.s - tol <= t && t <= x.e + tol)));
      const lenOk = cl.end - cl.start >= 0;
      if (lenOk && !near(cl.start) && !near(cl.end)) miss.push(`zvukový klip ${i + 1} [${T(cl.start)}–${T(cl.end)}] bez prolnutí`);
    });
    add('zvuková prolnutí na střizích', miss.length ? '✖' : '✔', miss.length ? miss : [`přechody na zvuku: ${fadeInfo.items.length} (klipů ${aud.length})`]);
  }
}

/* ---------------------------------------------------------------- 6. délka proti cíli */

{
  const d = seq.duration;
  if (target === null || Number.isNaN(target)) add('délka proti cíli', '–', [`${T(d)} s, cíl nezadán`]);
  else {
    const dev = (d - target) / target;
    add('délka proti cíli (±25 %)', Math.abs(dev) <= 0.25 ? '✔' : '✖', [`${T(d)} s proti cíli ${target} s (${dev >= 0 ? '+' : ''}${Math.round(dev * 100)} %)`]);
  }
}

/* ---------------------------------------------------------------- 7. časová osa: mezery, překryvy, útržky, A/V */

{
  const errs = [];
  const warns = [];
  const tracks = [...new Set(clips.map((x) => `${x.kind}:${x.track}`))];
  for (const key of tracks) {
    const [kind, t] = key.split(':');
    const list = sorted(kind, Number(t));
    list.forEach((cl, i) => {
      const dur = cl.end - cl.start;
      if (dur <= 1.5 * fr) errs.push(`${kind} ${t}, klip ${i + 1} [${T(cl.start)}–${T(cl.end)}]: útržek ${Math.round(dur * fps)} sn.`);
      else if (dur < 0.5 && kind === textKind) warns.push(`${kind} ${t}, klip ${i + 1}: velmi krátký (${dur.toFixed(2)} s)`);
      if (i > 0) {
        const d = cl.start - list[i - 1].end;
        if (d > 0.5 * fr) errs.push(`${kind} ${t}: mezera ${d.toFixed(2)} s před klipem ${i + 1} (${T(list[i - 1].end)}→${T(cl.start)})`);
        else if (d < -0.5 * fr) errs.push(`${kind} ${t}: překryv ${(-d).toFixed(2)} s u klipu ${i + 1} (${T(cl.start)})`);
      }
    });
    if (list[0] && list[0].start > 0.5 * fr && kind === textKind && Number(t) === 0) warns.push(`${kind} ${t}: první klip začíná až ve ${T(list[0].start)} s`);
  }
  const v0 = sorted('video', 0);
  const a0 = sorted('audio', 0);
  if (v0.length && a0.length) {
    if (v0.length !== a0.length) warns.push(`obraz (${v0.length}) a zvuk (${a0.length}) mají různý počet klipů`);
    else v0.forEach((v, i) => {
      if (Math.abs(v.start - a0[i].start) > 0.5 * fr || Math.abs(v.end - a0[i].end) > 0.5 * fr || Math.abs(v.inPoint - a0[i].inPoint) > 0.5 * fr) {
        errs.push(`A/V nesedí u klipu ${i + 1}: obraz ${T(v.start)}–${T(v.end)} (zdroj ${T(v.inPoint)}), zvuk ${T(a0[i].start)}–${T(a0[i].end)} (zdroj ${T(a0[i].inPoint)})`);
      }
    });
  }
  const maxEnd = Math.max(0, ...clips.map((x) => x.end));
  if (Math.abs(maxEnd - seq.duration) > 0.1) warns.push(`délka sekvence ${T(seq.duration)} s ≠ konec posledního klipu ${T(maxEnd)} s`);
  if (clips.some((x) => x.disabled)) warns.push(`vypnutých klipů: ${clips.filter((x) => x.disabled).length}`);
  add('časová osa (mezery, překryvy, útržky, A/V)', errs.length ? '✖' : warns.length ? '⚠' : '✔',
    errs.length || warns.length ? [...errs, ...warns.map((x) => '⚠ ' + x)] : [`${main.length} úseků, ${clips.length} klipů, bez mezer a překryvů`]);
}

/* ---------------------------------------------------------------- 8. odpad přepisu v textu */

{
  const errs = [];
  const JUNK = [
    [/\.{4,}|…{2,}|(\.\s?){4,}/, 'řada teček'],
    [/titulky\s+(vytvo|připrav|upravil|přeložil)/i, '„Titulky vytvořil…“'],
    [/(děkuji|díky|thank you|thanks)\s+(za\s+(pozornost|sledování)|for\s+watching)/i, 'halucinace „děkuji za sledování“'],
    [/subtitles?\s+by|amara\.org|www\.|https?:\/\//i, 'subtitles by / URL'],
    [/\[(hudba|music|smích|potlesk)\]|♪/i, 'značka hudby / smíchu'],
  ];
  A.forEach((a, i) => {
    if (!a.words.length) return;
    const text = a.words.map((w) => w.w).join(' ');
    for (const [re, name] of JUNK) {
      const m = text.match(re);
      if (m) errs.push(`${label(i)}: ${name} („${m[0].slice(0, 40)}“)`);
    }
    const noLetter = a.words.filter((w) => !/\p{L}|\p{N}/u.test(w.w));
    if (noLetter.length) errs.push(`${label(i)}: slova bez písmen: ${noLetter.map((w) => `„${w.w}“`).join(' ').slice(0, 60)}`);
    // několikanásobné opakování téhož slova (smyčka ASR)
    const ws = a.words.map((w) => norm(w.w));
    for (let k = 0; k + 3 < ws.length; k++) if (ws[k] && ws[k] === ws[k + 1] && ws[k] === ws[k + 2] && ws[k] === ws[k + 3]) { errs.push(`${label(i)}: smyčka „${a.words[k].w}“ ×4`); break; }
  });
  add('odpad přepisu v textu', errs.length ? '✖' : '✔', errs.length ? errs : ['bez halucinací a odpadu']);
}

/* ---------------------------------------------------------------- výstup */

const fails = results.filter((r) => r.status === '✖');
if (asJson) {
  console.log(JSON.stringify({ sequence: seq.name, duration: seq.duration, target, clips: main.length, ok: !fails.length, results }, null, 1));
} else {
  if (host) console.log(`Hostitel: ${host.app || '?'}${host.version ? ' ' + host.version : ''}${host.build ? ` (${host.build})` : ''}, projekt „${host.project?.name || '?'}“`);
  console.log(`QA „${seq.name}“ – ${T(seq.duration)} s, ${main.length} úseků, ${fps} fps${target ? `, cíl ${target} s` : ''}`);
  for (const r of results) {
    console.log(`${r.status} ${r.name}`);
    for (const d of r.details) console.log(`     ${d}`);
  }
  console.log(fails.length ? `\n✖ ${fails.length} z ${results.length} kontrol selhalo: ${fails.map((f) => f.name).join('; ')}` : `\n✔ všechny kontroly v pořádku (${results.filter((r) => r.status === '⚠').length}× upozornění)`);
}
process.exit(fails.length ? 1 : 0);
