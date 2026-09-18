#!/usr/bin/env node
/*
 * MYpremiereMCP - MCP server pro strih v Adobe Premiere Pro.
 *
 * Claude/Codex <-stdio-> tento server <-HTTP 127.0.0.1-> CEP panel v Premiere <-> ExtendScript (host.jsx)
 *                                    \-> python/transcribe.py (faster-whisper, cestina, casy slov)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { intervalsFromTranscript, intervalsFromTurns, multicamClips, planRuns, summarizeRuns } from './multicam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const W = CONFIG.whisper;
const CACHE_DIR = path.resolve(ROOT, CONFIG.cacheDir);
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');
const TOKEN_FILE = path.join(process.env.APPDATA || ROOT, 'MYpremiereMCP', 'token.txt');
const NOT_RUNNING =
  'Panel MY Premiere MCP neodpovídá. Otevři Premiere Pro a panel Okno > Rozšíření > MY Premiere MCP.';

/* ------------------------------------------------------------------ most do Premiere */

// Node globální fetch má defaultní headersTimeout/bodyTimeout 300000 ms bez ohledu na AbortSignal –
// u dlouhých operací (buildTimeline na stovkách klipů, export) by spojení tvrdě spadlo (UND_ERR_HEADERS_TIMEOUT)
// dřív, než skript v Premiere doběhne. Global fetch nejde takhle nakonfigurovat (a dispatcher z npm
// balíčku undici není kompatibilní s vestavěnou verzí v node: - "invalid onRequestStart method") –
// proto tu vlastní undiciFetch + Agent ze stejného balíčku.
const bridgeDispatcher = new Agent({ headersTimeout: 7200000, bodyTimeout: 7200000 });

async function bridge(url, payload, timeoutMs = 120000) {
  let token;
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new Error(NOT_RUNNING + ' (token zatím neexistuje – panel se ještě nespustil)');
  }
  let res;
  try {
    res = await undiciFetch(`http://127.0.0.1:${CONFIG.port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PMCP-Token': token },
      body: JSON.stringify({ ...payload, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10000),
      dispatcher: bridgeDispatcher,
    });
  } catch (e) {
    throw new Error(`${NOT_RUNNING} (${e.cause?.code || e.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.raw;
}

async function premiere(fn, args = {}, timeoutMs) {
  const raw = await bridge('/call', { fn, args }, timeoutMs);
  let out;
  try {
    out = JSON.parse(raw);
  } catch {
    throw new Error('Neplatná odpověď z ExtendScriptu: ' + String(raw).slice(0, 400));
  }
  if (!out.ok) throw new Error(`Premiere (${fn}): ${out.error}${out.line ? ` [host.jsx:${out.line}]` : ''}`);
  return out.result;
}

/* ------------------------------------------------------------------ přepis */

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const normKey = (p) => path.resolve(p).toLowerCase();

function loadIndex() {
  try {
    return readJson(INDEX_FILE);
  } catch {
    return {};
  }
}

// Slabší modely (např. Haiku) při delší konverzaci občas zapomenou předat povinné "path"/"source" -
// místo syrové zod chyby ("expected string, received undefined") zkus dohledat jednoznačný zdroj sám.
function singleTranscribedSource() {
  const keys = Object.keys(loadIndex());
  return keys.length === 1 ? keys[0] : null;
}
function missingSourceError(candidates) {
  return new Error(
    candidates.length
      ? `Cesta k videu nebyla zadána a v cache je přepisů víc – urči "path" (jeden z: ${candidates.join(', ')}).`
      : 'Cesta k videu nebyla zadána a v cache ještě není žádný přepis – urči "path" (zkus list_project_items).',
  );
}
async function singleProjectMediaSource() {
  const items = await premiere('listItems');
  const media = items.filter((i) => i.mediaPath && !i.isSequence);
  return media.length === 1 ? media[0].mediaPath : null;
}

function runPython(args, extra) {
  return new Promise((resolve, reject) => {
    const cmd = /[\\/]/.test(CONFIG.python[0]) ? path.resolve(ROOT, CONFIG.python[0]) : CONFIG.python[0];
    const p = spawn(cmd, [...CONFIG.python.slice(1), ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const progressToken = extra?._meta?.progressToken;
    let tail = '';
    let pending = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = line.match(/^PROGRESS ([\d.]+)\s*(.*)$/);
        if (m) {
          if (progressToken !== undefined) {
            extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: Number(m[1]), total: 1, message: m[2] },
              })
              .catch(() => {});
          }
        } else {
          tail = (tail + line + '\n').slice(-6000);
        }
      }
    });
    p.stdout.resume();
    p.on('error', (e) => reject(new Error(`Nelze spustit Python (${CONFIG.python.join(' ')}): ${e.message}`)));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Přepis selhal (exit ${code}):\n${tail.trim().slice(-2500)}`)),
    );
  });
}

/* ------------------------------------------------------------------ lokální Worker */

const WORKER_URL = `http://127.0.0.1:${CONFIG.worker?.port || 7881}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workerToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

async function workerFetch(pathname, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(WORKER_URL + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PMCP-Token': workerToken() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Worker ${pathname}: ${data.error || res.status}`);
  return data;
}

function workerCodeStamp() {
  const dir = path.join(ROOT, 'worker');
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith('.py')).map((f) => path.join(dir, f)), path.join(ROOT, 'config.json')];
  return Math.max(...files.map((f) => Math.floor(fs.statSync(f).mtimeMs / 1000)));
}

let workerStarting = null;
async function ensureWorker() {
  try {
    const h = await workerFetch('/health', { timeoutMs: 3000 });
    // Worker se starší verzí kódu, který zrovna nic nedělá → restart (jinak by běžel starý kód)
    if (h.codeStamp === undefined || h.codeStamp === workerCodeStamp() || h.running?.length || h.queued) return;
    await workerFetch('/shutdown', { method: 'POST', timeoutMs: 5000 }).catch(() => {});
    await sleep(2000);
    if (h.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(h.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* už skončil */
      }
    }
    await sleep(1000);
  } catch {
    /* spustíme */
  }
  workerStarting ??= (async () => {
    const py = path.resolve(ROOT, CONFIG.worker?.python || '.venv/Scripts/python.exe');
    if (!fs.existsSync(py)) throw new Error(`Python Workeru nenalezen: ${py} – spusť install.ps1`);
    const child = spawn(py, [path.join(ROOT, 'worker', 'server.py')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try {
        await workerFetch('/health', { timeoutMs: 2000 });
        return;
      } catch {
        /* ještě startuje */
      }
    }
    throw new Error('Worker se nespustil do 90 s – viz cache/worker.log');
  })().finally(() => {
    workerStarting = null;
  });
  return workerStarting;
}

async function runJob(type, params, extra, { wait = true } = {}) {
  await ensureWorker();
  let job = await workerFetch('/jobs', { method: 'POST', body: { type, params } });
  if (!wait) return job;
  const progressToken = extra?._meta?.progressToken;
  let last = '';
  const onAbort = () => workerFetch(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {});
  extra?.signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(`${type} selhal: ${job.error}`);
      if (job.status === 'cancelled') throw new Error(`${type}: úloha zrušena`);
      const key = `${job.progress}|${job.message}`;
      if (progressToken !== undefined && key !== last) {
        last = key;
        extra
          .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: job.progress || 0, total: 1, message: job.message } })
          .catch(() => {});
      }
      await sleep(1000);
      // těžký výpočet může Worker na chvíli zdržet – krátký výpadek odpovědi úlohu neruší
      for (let attempt = 1; ; attempt++) {
        try {
          job = await workerFetch(`/jobs/${job.id}`, { timeoutMs: 60000 });
          break;
        } catch (e) {
          if (attempt >= 5) throw new Error(`Worker neodpovídá (${e.message}); úloha ${job.id} možná běží dál – ověř přes job_status`);
          await sleep(3000);
        }
      }
    }
  } finally {
    extra?.signal?.removeEventListener?.('abort', onAbort);
  }
}

const cacheIndex = (kind) => {
  try {
    return readJson(path.join(ROOT, CONFIG.cacheRoot || 'cache', kind, 'index.json'));
  } catch {
    return {};
  }
};

function loadIndexed(kind, source) {
  const f = cacheIndex(kind)[normKey(source)];
  return f && fs.existsSync(f) ? readJson(f) : null;
}

async function transcribe(source, opts = {}, extra) {
  if (!fs.existsSync(source)) throw new Error('Soubor neexistuje: ' + source);
  const r = await runJob(
    'transcribe',
    { path: source, model: opts.model, language: opts.language, prompt: opts.prompt, speakerTracks: opts.speakerTracks, force: opts.force },
    extra,
  );
  return { data: readJson(r.file), file: r.file, cached: r.cached };
}

// Doladí konec vybraného úseku podle skutečné energie zvuku – Whisperovy časy slov mívají u konce
// věty drobnou nepřesnost (viz leadIn u titulků, tady je to stejný jev na druhé straně). Jen
// PRODLUŽUJE (nikdy nezkracuje pod to, co spočítal cutBounds) a nikdy nepřeteče do dalšího úseku.
async function refineOutPoints(source, ranges, extra) {
  if (!fs.existsSync(source) || !ranges.length) return;
  const points = ranges.map((r, i) => {
    const nextIn = ranges[i + 1]?.in ?? Infinity;
    // Nikdy neprodloužit přes další skutečné slovo v přepisu (maxOut, spočítané v cutBounds) - i když
    // zrovna nejde o další vybraný úsek. Bez týhle meze doladění podle vlny umělo "ukousnout" kousek
    // slova vyloučeného přes toWord, protože o hranicích uvnitř věty jinak vůbec nevědělo.
    const ceiling = Math.min(nextIn, r.maxOut ?? Infinity);
    return { at: r.out, direction: 'end', maxExtend: Math.max(0, Math.min(0.4, ceiling - r.out - 0.02)) };
  });
  try {
    const res = await runJob('refine_edges', { path: source, points }, extra);
    res.points.forEach((p, i) => { ranges[i].out = p.time; });
  } catch {
    // zvuková analýza selhala (např. soubor bez zvuku) – necháme původní časy z cutBounds
  }
}

// Původní přepis bez Workeru (přímé spuštění transcribe.py) – záloha
async function transcribeLocal(source, opts = {}, extra) {
  if (!fs.existsSync(source)) throw new Error('Soubor neexistuje: ' + source);
  const st = fs.statSync(source);
  const o = {
    model: opts.model || W.model,
    language: opts.language ?? W.language,
    speakers: opts.speakerTracks?.length ? opts.speakerTracks : null,
    prompt: opts.prompt || null,
  };
  const key = crypto
    .createHash('sha1')
    .update(JSON.stringify([normKey(source), st.size, st.mtimeMs, o]))
    .digest('hex')
    .slice(0, 12);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = path.join(CACHE_DIR, `${path.basename(source).replace(/[^\w.-]+/g, '_')}.${key}.json`);

  if (!opts.force && fs.existsSync(out)) {
    rememberTranscript(source, out);
    return { data: readJson(out), file: out, cached: true };
  }

  const args = [
    path.join(ROOT, 'python', 'transcribe.py'),
    '--input', source,
    '--out', out,
    '--model', o.model,
    '--device', W.device,
    '--compute', W.compute,
    '--beam-size', String(W.beamSize ?? 5),
    '--corrections', path.resolve(ROOT, CONFIG.correctionsFile),
    '--language', o.language || '',
  ];
  if (o.prompt) args.push('--prompt', o.prompt);
  if (o.speakers) {
    const spk = out + '.speakers.json';
    fs.writeFileSync(spk, JSON.stringify(o.speakers), 'utf8');
    args.push('--speakers', spk);
  }
  await runPython(args, extra);
  rememberTranscript(source, out);
  return { data: readJson(out), file: out, cached: false };
}

function rememberTranscript(source, file) {
  const idx = loadIndex();
  idx[normKey(source)] = file;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 1), 'utf8');
}

function loadTranscript(source) {
  const file = loadIndex()[normKey(source)];
  if (!file || !fs.existsSync(file)) {
    throw new Error(`Pro ${source} ještě neexistuje přepis. Nejdřív zavolej transcribe_media.`);
  }
  return readJson(file);
}

/* ------------------------------------------------------------------ formát a výpočty */

function tc(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

const segLine = (s, offset = 0) =>
  `#${s.id} ${tc(s.start + offset)}–${tc(s.end + offset)}${s.speaker ? ` [${s.speaker}]` : ''} ${s.text}`;

function wrapCue(text, charsPerLine, lineCount) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && t.length > charsPerLine && lines.length < lineCount - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

function srtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function paginate(lines, maxChars) {
  let used = 0;
  const outLines = [];
  for (const l of lines) {
    if (used + l.length + 1 > maxChars && outLines.length) {
      outLines.push(`… (zkráceno, zbývá ${lines.length - outLines.length} řádků – použij fromId/from)`);
      break;
    }
    outLines.push(l);
    used += l.length + 1;
  }
  return outLines.join('\n');
}

const stripDiacritics = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function allWords(tr) {
  return tr.segments.flatMap((s) => s.words || []);
}

/** Bezpečná hranice střihu: odsazení, ale nikdy nezasáhne do sousedního slova. */
function cutBounds(words, a, b, padBefore, padAfter) {
  let prevEnd = -Infinity;
  let nextStart = Infinity;
  for (const w of words) {
    if (w.e <= a + 1e-3 && w.e > prevEnd) prevEnd = w.e;
    if (w.s >= b - 1e-3 && w.s < nextStart) nextStart = w.s;
  }
  // Bezpečnostní rezerva k sousednímu (nevybranému) slovu - jen ať se s ním střih nepřekrývá,
  // ne půlka mezery. Při plynulé řeči (mezera mezi větami < 2*pad) dřív ubírala zbytečně
  // hodně z padAfter/padBefore, takže věta zněla uťatě, i když místo na dokončení bylo.
  const GUARD = 0.02;
  const lo = prevEnd === -Infinity ? a - padBefore : Math.max(a - padBefore, prevEnd + GUARD);
  // hiCeiling = absolutní strop (další slovo v přepisu, i mimo tenhle výběr) - refine_edges (doladění
  // podle zvukové vlny) přes něj nesmí prodloužit, jinak by mohl "ukousnout" začátek vyloučeného
  // slova (např. za toWord), i když cutBounds sám o sobě hranici spočítal správně.
  const hiCeiling = nextStart === Infinity ? Infinity : nextStart - GUARD;
  const hi = Math.min(b + padAfter, hiCeiling);
  return [Math.max(0, Math.min(lo, a)), Math.max(hi, b), Math.max(hiCeiling, b)];
}

function mergeRanges(ranges, mergeGap) {
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.in >= last.in && r.in - last.out <= mergeGap) {
      if (r.out > last.out) {
        last.out = r.out;
        last.maxOut = r.maxOut;
      }
      last.ids.push(...r.ids);
    } else {
      merged.push({ ...r, ids: [...r.ids] });
    }
  }
  return merged;
}

function picksToRanges(tr, picks, { padBefore, padAfter, mergeGap }) {
  const byId = new Map(tr.segments.map((s) => [s.id, s]));
  const words = allWords(tr);
  const ranges = picks.map((p0) => {
    const p = typeof p0 === 'number' ? { id: p0 } : p0;
    const s = byId.get(p.id);
    if (!s) throw new Error(`Segment #${p.id} v přepisu neexistuje`);
    let a = s.start;
    let b = s.end;
    const ws = s.words || [];
    if (ws.length && (p.fromWord !== undefined || p.toWord !== undefined)) {
      const fw = p.fromWord ?? 0;
      const tw = p.toWord ?? ws.length - 1;
      if (!ws[fw] || !ws[tw] || tw < fw) throw new Error(`Segment #${p.id}: neplatný rozsah slov ${fw}–${tw}`);
      a = ws[fw].s;
      b = ws[tw].e;
    }
    const [lo, hi, hiCeiling] = cutBounds(words, a, b, padBefore, padAfter);
    const dur = tr.duration || hi;
    return { in: lo, out: Math.min(hi, dur), maxOut: Math.min(hiCeiling, dur), ids: [p.id] };
  });
  return mergeRanges(ranges, mergeGap);
}

function speechIslands(tr, minPause, pad) {
  const words = allWords(tr);
  const islands = [];
  let cur = null;
  for (const w of words) {
    if (cur && w.s - cur.b < minPause) cur.b = w.e;
    else {
      if (cur) islands.push(cur);
      cur = { a: w.s, b: w.e };
    }
  }
  if (cur) islands.push(cur);
  return islands.map((i) => {
    const [lo, hi, hiCeiling] = cutBounds(words, i.a, i.b, pad, pad);
    const dur = tr.duration || hi;
    return { in: lo, out: Math.min(hi, dur), maxOut: Math.min(hiCeiling, dur), ids: [] };
  });
}

function withExtras(ranges, source, extraAudio) {
  return ranges.map((r) => ({
    source,
    in: Math.round(r.in * 1000) / 1000,
    out: Math.round(r.out * 1000) / 1000,
    extra: (extraAudio || []).map((x) => ({ source: x.source, offset: x.offset ?? 0, audioTrack: x.audioTrack ?? 1 })),
  }));
}

async function buildAndReport(name, segments, gap, extraInfo) {
  const res = await premiere('buildSequence', { name, segments, gap }, 600000);
  return {
    ...res,
    placed: undefined,
    summary: `Vytvořena sekvence „${res.name}“ (${tc(res.duration)}) z ${res.segments} úseků.`,
    ...extraInfo,
  };
}

/* ------------------------------------------------------------------ MCP server */

const server = new McpServer(
  { name: 'premiere', version: '0.1.0' },
  {
    instructions: [
      'Nástroje pro střih v Adobe Premiere Pro (čeština). Časy jsou vždy v sekundách.',
      'Postup: 1) premiere_status/get_project, 2) get_sequence pro zdrojové soubory a klipy,',
      '3) transcribe_media (nebo transcribe_sequence) – přepis s ID vět, 4) přečti přepis celý (get_transcript),',
      '5) vyber věty tak, aby výsledek dával smysl (celé myšlenky, žádné utnuté věty, bez přeřeknutí a opakování),',
      '6) build_sequence_from_transcript vytvoří NOVOU sekvenci – původní střih zůstává netknutý.',
      'Destruktivní úpravy (remove_timeline_ranges, remove_clips) používej jen na výslovné přání.',
      'Když má každý mluvčí vlastní mikrofon, předej speakerTracks – přepis pak obsahuje [jméno].',
      'Bez oddělených mikrofonů použij diarize_media a pojmenuj mluvčí přes rename_speakers.',
      'DLOUHÝ MATERIÁL (šetři tokeny): analyze_transcript vrátí kompaktní osnovu kapitol (lokální LLM, zdarma);',
      'plný text čti jen u vybraných kapitol přes get_transcript s format "compact". plan_edit_local navrhne střih úplně lokálně.',
      'VÍCE KAMER: build_multicam_sequence – synchronizuje kamery podle zvuku a přepíná podle mluvčího (nejdřív dryRun).',
      'Dlouhé úlohy běží v lokálním Workeru; worker_status ukazuje frontu.',
    ].join(' '),
  },
);

function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args, extra) => {
    try {
      const r = await handler(args, extra);
      return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
    }
  });
}

const seqArg = z.string().optional().describe('Název nebo sequenceID; bez zadání = aktivní sekvence');
const speakerTracks = z
  .array(
    z.object({
      name: z.string().describe('Jméno mluvčího'),
      path: z.string().describe('Zvuková stopa jeho mikrofonu'),
      offset: z.number().optional().describe('Posun stopy vůči zdroji v sekundách (výchozí 0)'),
    }),
  )
  .optional()
  .describe('Oddělené mikrofony mluvčích pro přiřazení kdo mluví');
const extraAudio = z
  .array(
    z.object({
      source: z.string().describe('Cesta nebo nodeId doplňkového zvuku (např. samostatný mikrofon)'),
      audioTrack: z.number().int().optional().describe('Index audio stopy (0 = A1, výchozí 1 = A2)'),
      offset: z.number().optional().describe('Posun v sekundách vůči hlavnímu zdroji'),
    }),
  )
  .optional()
  .describe('Synchronní zvuky vložené pod každý úsek (stejný časový rozsah)');

tool('premiere_status', 'Ověří spojení s Premiere a vrátí verzi, otevřený projekt a aktivní sekvenci.', {}, () =>
  premiere('ping', {}, 15000),
);

tool('get_project', 'Informace o projektu a seznam sekvencí.', {}, () => premiere('projectInfo'));

tool(
  'list_project_items',
  'Položky projektu (klipy, sekvence, biny) s nodeId a cestou k médiu. Pro zjištění nově vloženého/naimportovaného ' +
    'souboru použij sort: "recent" (řadí podle data změny souboru na disku) – NE shell příkazy (Get-ChildItem/ls apod.), ' +
    'ty jsou mimo pracovní adresář zablokované bezpečnostním sandboxem a stejně by to nebyl spolehlivý způsob.',
  {
    filter: z.string().optional().describe('Filtr podle názvu nebo cesty'),
    sort: z.enum(['recent']).optional().describe('"recent" = nejnovější soubor na disku první (podle data poslední změny)'),
  },
  async ({ filter, sort }) => {
    let items = await premiere('listItems');
    if (filter) {
      const f = stripDiacritics(filter);
      items = items.filter((i) => stripDiacritics(`${i.name} ${i.mediaPath || ''}`).includes(f));
    }
    if (sort === 'recent') {
      items = items.map((i) => {
        try {
          return { ...i, modified: fs.statSync(i.mediaPath).mtime.toISOString() };
        } catch {
          return i;
        }
      });
      items.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    }
    return items;
  },
);

tool(
  'import_media',
  'Importuje soubory do projektu.',
  { paths: z.array(z.string()), bin: z.string().optional().describe('Název binu (vytvoří se)') },
  ({ paths, bin }) => premiere('importFiles', { paths, bin }, 300000),
);

tool(
  'get_sequence',
  'Detail sekvence: fps, rozlišení, délka, playhead a všechny klipy (stopa, start/end na timeline, inPoint/outPoint ve zdroji, cesta k médiu).',
  { sequence: seqArg, clips: z.boolean().optional().describe('Vypsat klipy (výchozí true)') },
  (a) => premiere('getSequence', a),
);

tool('open_sequence', 'Otevře sekvenci a nastaví ji jako aktivní.', { sequence: z.string() }, (a) =>
  premiere('openSequence', a),
);

tool(
  'transcribe_media',
  'Přepíše mluvené slovo souboru (Whisper large-v3 na GPU, výchozí čeština) s časy slov. Výsledek se cachuje. Vrací věty s ID a časy ve zdroji.',
  {
    path: z.string().optional().describe('Cesta k videu/zvuku; bez zadání použije jediné video/zvuk v projektu (je-li jen jedno)'),
    language: z.string().optional().describe('Kód jazyka, výchozí "cs"; prázdný řetězec = autodetekce'),
    model: z.string().optional().describe('Whisper model (large-v3, large-v3-turbo, medium…)'),
    prompt: z.string().optional().describe('Kontext pro přepis: jména, značky, odborné termíny'),
    speakerTracks,
    force: z.boolean().optional().describe('Ignorovat cache a přepsat znovu'),
    maxChars: z.number().int().optional().describe('Max. délka vráceného textu (výchozí 20000)'),
  },
  async (a, extra) => {
    const p = a.path || (await singleProjectMediaSource());
    if (!p) throw new Error('Cesta k videu/zvuku nebyla zadána a v projektu je médií víc/žádné – urči "path" (zkus list_project_items).');
    const { data, file, cached } = await transcribe(p, a, extra);
    const head = [
      `Přepis: ${p}`,
      `Délka ${tc(data.duration)} · jazyk ${data.language} · ${data.segments.length} vět · ${data.wordCount} slov · ${data.model}/${data.device}${cached ? ' · z cache' : ` · ${data.elapsedSec} s`}`,
      data.speakers ? `Mluvčí: ${data.speakers.join(', ')}` : null,
      `Soubor: ${file}`,
      '',
    ].filter((x) => x !== null);
    return head.join('\n') + paginate(data.segments.map((s) => segLine(s)), a.maxChars || 20000);
  },
);

tool(
  'get_transcript',
  'Vrátí (část) uloženého přepisu. Volitelně i jednotlivá slova s indexy pro přesný střih uvnitř věty.',
  {
    path: z.string().optional().describe('Cesta k videu; bez zadání použije jediný existující přepis (je-li jen jeden)'),
    fromId: z.number().int().optional(),
    toId: z.number().int().optional(),
    from: z.number().optional().describe('Od času ve zdroji (s)'),
    to: z.number().optional().describe('Do času ve zdroji (s)'),
    words: z.boolean().optional().describe('Vypsat slova s indexy a časy'),
    format: z.enum(['full', 'compact']).optional().describe('compact = jen #id [mluvčí] text (šetří tokeny)'),
    maxChars: z.number().int().optional(),
  },
  async (a) => {
    const p = a.path || singleTranscribedSource();
    if (!p) throw missingSourceError(Object.keys(loadIndex()));
    const tr = loadTranscript(p);
    const segs = tr.segments.filter(
      (s) =>
        (a.fromId === undefined || s.id >= a.fromId) &&
        (a.toId === undefined || s.id <= a.toId) &&
        (a.from === undefined || s.end >= a.from) &&
        (a.to === undefined || s.start <= a.to),
    );
    const lines = segs.map((s) => {
      if (a.format === 'compact' && !a.words) return `#${s.id}${s.speaker ? ` [${s.speaker}]` : ''} ${s.text}`;
      if (!a.words) return segLine(s);
      const ws = (s.words || []).map((w, i) => `${i}:${w.w}@${w.s.toFixed(2)}`).join(' ');
      return `${segLine(s)}\n    ${ws}`;
    });
    return paginate(lines, a.maxChars || 40000);
  },
);

tool(
  'search_transcript',
  'Najde v přepisu věty obsahující text jako celé slovo/frázi na hranicích slov (bez ohledu na diakritiku a velikost písmen). ' +
    'Hledání "já" tedy nenajde "jaký" ani "jazyk" – jen samostatné slovo "já".',
  {
    path: z.string().optional().describe('Cesta k videu; bez zadání použije jediný existující přepis (je-li jen jeden)'),
    query: z.string(),
    context: z.number().int().optional().describe('Počet okolních vět (výchozí 1)'),
  },
  async ({ path: pathArg, query, context = 1 }) => {
    const p = pathArg || singleTranscribedSource();
    if (!p) throw missingSourceError(Object.keys(loadIndex()));
    const tr = loadTranscript(p);
    const q = stripDiacritics(query).trim();
    if (!q) throw new Error('Prázdný dotaz.');
    const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const hits = new Set();
    tr.segments.forEach((s, i) => {
      if (re.test(stripDiacritics(s.text))) {
        for (let k = Math.max(0, i - context); k <= Math.min(tr.segments.length - 1, i + context); k++) hits.add(k);
      }
    });
    if (!hits.size) return `„${query}“ v přepisu nenalezeno.`;
    return [...hits].sort((x, y) => x - y).map((i) => segLine(tr.segments[i])).join('\n');
  },
);

tool(
  'find_pauses',
  'Najde pauzy v řeči delší než minPause (z časů slov).',
  { path: z.string(), minPause: z.number().optional().describe('Minimální pauza v s (výchozí 1.0)') },
  async ({ path: p, minPause = 1.0 }) => {
    const tr = loadTranscript(p);
    const words = allWords(tr);
    const pauses = [];
    if (words.length && words[0].s >= minPause) pauses.push({ start: 0, end: words[0].s });
    for (let i = 1; i < words.length; i++) {
      if (words[i].s - words[i - 1].e >= minPause) pauses.push({ start: words[i - 1].e, end: words[i].s });
    }
    const last = words.at(-1);
    if (last && tr.duration - last.e >= minPause) pauses.push({ start: last.e, end: tr.duration });
    const total = pauses.reduce((acc, x) => acc + x.end - x.start, 0);
    return `${pauses.length} pauz, celkem ${tc(total)}\n` +
      pauses.map((x) => `${tc(x.start)}–${tc(x.end)} (${(x.end - x.start).toFixed(2)} s)`).join('\n');
  },
);

tool(
  'transcribe_sequence',
  'Přepíše všechny zdroje v sekvenci a vrátí přepis v ČASECH TIMELINE (co zazní kde na timeline). Hodí se pro úpravy existujícího střihu.',
  {
    sequence: seqArg,
    audioTracks: z.array(z.number().int()).optional().describe('Které audio stopy (0 = A1); výchozí všechny'),
    language: z.string().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    maxChars: z.number().int().optional(),
  },
  async (a, extra) => {
    const seq = await premiere('getSequence', { sequence: a.sequence });
    let clips = seq.clips.filter((c) => c.kind === 'audio' && c.mediaPath && !c.disabled);
    if (a.audioTracks) clips = clips.filter((c) => a.audioTracks.includes(c.track));
    if (!clips.length) clips = seq.clips.filter((c) => c.kind === 'video' && c.mediaPath && !c.disabled);
    const seen = new Set();
    clips = clips.filter((c) => {
      const k = `${c.mediaPath}|${c.start}|${c.inPoint}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const sources = [...new Set(clips.map((c) => c.mediaPath))];
    const transcripts = {};
    for (const src of sources) transcripts[src] = (await transcribe(src, a, extra)).data;

    const rows = [];
    for (const c of clips) {
      const tr = transcripts[c.mediaPath];
      const speed = c.speed || 1;
      for (const s of tr.segments) {
        const ws = (s.words || []).filter((w) => w.s >= c.inPoint - 0.01 && w.e <= c.outPoint + 0.01);
        if (!ws.length) continue;
        const map = (t) => c.start + (t - c.inPoint) / speed;
        rows.push({
          t: map(ws[0].s),
          line: `${tc(map(ws[0].s))}–${tc(map(ws.at(-1).e))} A${c.track + 1}${s.speaker ? ` [${s.speaker}]` : ''} (#${s.id} ${path.basename(c.mediaPath)}) ${ws.map((w) => w.w).join(' ')}`,
        });
      }
    }
    rows.sort((x, y) => x.t - y.t);
    return `Sekvence „${seq.name}“ ${tc(seq.duration)} · zdroje: ${sources.map((s) => path.basename(s)).join(', ')}\n` +
      paginate(rows.map((r) => r.line), a.maxChars || 40000);
  },
);

const CAPTIONS_INDEX_FILE = path.join(CACHE_DIR, 'captions', 'index.json');
function loadCaptionsIndex() {
  try {
    return readJson(CAPTIONS_INDEX_FILE);
  } catch {
    return {};
  }
}
function saveCaptionsIndex(idx) {
  fs.mkdirSync(path.dirname(CAPTIONS_INDEX_FILE), { recursive: true });
  fs.writeFileSync(CAPTIONS_INDEX_FILE, JSON.stringify(idx, null, 1), 'utf8');
}
// Otisk OBSAHU sekvence (ne jen jejího ID) – když uživatel ve stejné sekvenci smaže
// staré klipy a vloží jiné video, sequenceID zůstane stejné, ale otisk se změní,
// takže pojistka níž správně pozná, že jde o nový obsah, ne o opakované volání.
function contentFingerprint(seq) {
  const shape = seq.clips.map((c) => [c.mediaPath, c.track, c.start, c.end, c.inPoint, c.outPoint]);
  return crypto.createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

tool(
  'add_captions',
  'Vygeneruje české titulky z přepisu podle AKTUÁLNÍHO stavu sekvence (co je teď na timeline) a přidá je do Premiery ' +
    'jako nativní titulkovou stopu (import .srt + titulková stopa v sekvenci, vidět v Program monitoru). ' +
    'Spustit až po hotovém střihu – při dalším střihání by se časy titulků a obrazu rozjely. ' +
    'POZOR: Premiera umí zobrazit jen úplně PRVNÍ titulkovou stopu vytvořenou v sekvenci – další přidaná by byla neviditelná. ' +
    'Proto nástroj podruhé na stejný OBSAH sekvence odmítne běžet (dokud v Premiere ručně nesmažeš starou CC stopu, nebo nepošleš force: true) – ' +
    'pojistka sleduje otisk klipů na timeline, ne jen ID sekvence, takže po výměně obsahu (smazání starého videa, vložení jiného) ve stejné sekvenci proběhne normálně znovu.',
  {
    sequence: seqArg,
    audioTracks: z.array(z.number().int()).optional().describe('Které audio stopy (0 = A1); výchozí všechny'),
    language: z.string().optional(),
    charsPerLine: z.number().int().optional().describe('Max znaků na jeden řádek titulku (výchozí 40)'),
    lines: z.union([z.literal(1), z.literal(2)]).optional().describe('Počet řádků titulku: 1 nebo 2 (výchozí 2)'),
    maxSecPerCue: z.number().optional().describe('Max délka jednoho titulku v s (výchozí 6)'),
    leadIn: z
      .number()
      .optional()
      .describe('O kolik s předsadit začátek titulku dopředu (kompenzace typického zpoždění Whisperu u začátku slova po tichu; výchozí 0.12, 0 = vypnuto)'),
    force: z
      .boolean()
      .optional()
      .describe('Vytvořit další titulkovou stopu, i když sekvence už jednou titulky dostala (POZOR: v Premiere se nezobrazí, dokud starou stopu ručně nesmažeš)'),
  },
  async (a, extra) => {
    const seq = await premiere('getSequence', { sequence: a.sequence });
    const fingerprint = contentFingerprint(seq);
    const capIdx = loadCaptionsIndex();
    const prev = capIdx[seq.sequenceID];
    if (prev && prev.fingerprint === fingerprint && !a.force) {
      throw new Error(
        `Sekvence „${seq.name}“ už titulky jednou dostala (${prev.when}). Premiera bohužel umí zobrazit jen úplně PRVNÍ ` +
          'vytvořenou titulkovou stopu – další přidaná by zůstala v projektu, ale neviditelná. Smaž nejdřív v Premiere ' +
          'starou "CC" stopu (v Timeline panelu pravým tlačítkem na její hlavičku vlevo → Delete Track), pak spusť znovu. ' +
          'Pokud víš, co děláš, můžeš to obejít parametrem force: true (výsledek ale nebude v Premiere vidět, dokud staré stopy nesmažeš).',
      );
    }
    let clips = seq.clips.filter((c) => c.kind === 'audio' && c.mediaPath && !c.disabled);
    if (a.audioTracks) clips = clips.filter((c) => a.audioTracks.includes(c.track));
    if (!clips.length) clips = seq.clips.filter((c) => c.kind === 'video' && c.mediaPath && !c.disabled);
    const seen = new Set();
    clips = clips.filter((c) => {
      const k = `${c.mediaPath}|${c.start}|${c.inPoint}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!clips.length) throw new Error('Sekvence nemá žádné klipy se zvukem/řečí.');
    const sources = [...new Set(clips.map((c) => c.mediaPath))];
    const transcripts = {};
    for (const src of sources) transcripts[src] = (await transcribe(src, a, extra)).data;

    const words = [];
    clips.forEach((c, ci) => {
      const tr = transcripts[c.mediaPath];
      const speed = c.speed || 1;
      const map = (t) => c.start + (t - c.inPoint) / speed;
      for (const s of tr.segments) {
        for (const w of s.words || []) {
          // clip = ze kterého klipu na timeline slovo pochází; titulek se na střihu musí zalomit,
          // jinak by jeden titulek mísil text ze dvou různých míst zdroje (viz split níž).
          if (w.s >= c.inPoint - 0.01 && w.e <= c.outPoint + 0.01) words.push({ t0: map(w.s), t1: map(w.e), text: w.w, clip: ci });
        }
      }
    });
    words.sort((x, y) => x.t0 - y.t0);
    if (!words.length) throw new Error('V sekvenci nejsou žádná rozpoznaná slova k titulkování.');

    const charsPerLine = a.charsPerLine || 40;
    const lineCount = a.lines === 1 ? 1 : 2;
    const maxChars = charsPerLine * lineCount;
    const maxSec = a.maxSecPerCue || 6;
    const gapSplit = 0.6;
    const cues = [];
    let cur = null;
    for (const w of words) {
      const text = cur ? `${cur.text} ${w.text}` : w.text;
      const gapTooBig = cur && w.t0 - cur.t1 > gapSplit;
      const tooLong = cur && (text.length > maxChars || w.t1 - cur.t0 > maxSec);
      // Na střihu se titulek vždy zalomí: u těsných střihů (což je po ladění hranic běžné) mezi
      // posledním slovem jednoho klipu a prvním slovem dalšího prakticky není mezera, takže by
      // gapTooBig nezabral a jeden titulek by ukazoval text ze dvou nesouvisejících pasáží.
      const clipChanged = cur && w.clip !== cur.clip;
      if (!cur || gapTooBig || tooLong || clipChanged) {
        if (cur) cues.push(cur);
        cur = { t0: w.t0, t1: w.t1, text: w.text, clip: w.clip };
      } else {
        cur.t1 = w.t1;
        cur.text = text;
      }
    }
    if (cur) cues.push(cur);

    // Whisper hlásí začátek slova po tichu typicky s malým zpožděním oproti skutečnému
    // začátku řeči (běžná vlastnost ASR zarovnání) – titulek proto předsadíme dopředu,
    // ale nikdy před konec předchozího titulku (aby se nepřekrývaly).
    const leadIn = a.leadIn ?? 0.12;
    if (leadIn > 0) {
      let prevEnd = 0;
      for (const c of cues) {
        c.t0 = Math.max(prevEnd, c.t0 - leadIn);
        prevEnd = c.t1;
      }
    }

    const srtLines = [];
    cues.forEach((c, i) => {
      srtLines.push(String(i + 1), `${srtTime(c.t0)} --> ${srtTime(c.t1)}`, wrapCue(c.text.trim(), charsPerLine, lineCount), '');
    });
    const dir = path.join(CACHE_DIR, 'captions');
    fs.mkdirSync(dir, { recursive: true });
    const srtPath = path.join(dir, `${(seq.name || 'sequence').replace(/[^\w.-]+/g, '_')}.${seq.sequenceID.slice(0, 8)}.srt`);
    fs.writeFileSync(srtPath, srtLines.join('\n'), 'utf8');

    await premiere('addCaptions', { sequence: seq.sequenceID, srtPath });
    capIdx[seq.sequenceID] = { when: new Date().toISOString(), srt: srtPath, sequence: seq.name, fingerprint };
    saveCaptionsIndex(capIdx);
    return { cues: cues.length, srt: srtPath, sequence: seq.name };
  },
);

tool(
  'build_sequence_from_transcript',
  'HLAVNÍ STŘIHOVÝ NÁSTROJ. Vytvoří novou sekvenci z vybraných vět přepisu v zadaném pořadí. Věty lze zkrátit na rozsah slov (fromWord/toWord). Hranice střihu se počítají z časů slov s bezpečným odsazením, navazující věty se spojí.',
  {
    name: z.string().describe('Název nové sekvence'),
    source: z.string().optional().describe('Zdroj, který se vkládá na timeline (video); bez zadání použije jediný existující přepis (je-li jen jeden)'),
    transcriptSource: z
      .string()
      .optional()
      .describe('Soubor, jehož přepis se použije, když řeč je v jiném souboru (např. samostatný mikrofon.wav se stejným časem). Výchozí = source'),
    picks: z
      .array(
        z.union([
          z.number().int(),
          z.object({ id: z.number().int(), fromWord: z.number().int().optional(), toWord: z.number().int().optional() }),
        ]),
      )
      .min(1)
      .describe('ID vět v pořadí, v jakém mají být ve střihu'),
    padBefore: z.number().optional().describe('Odsazení před větou v s (výchozí 0.08)'),
    padAfter: z.number().optional().describe('Odsazení za větou v s (výchozí 0.15)'),
    mergeGap: z.number().optional().describe('Navazující úseky blíž než toto se spojí (výchozí 0.4)'),
    gap: z.number().optional().describe('Mezera mezi úseky na timeline v s (výchozí 0)'),
    extraAudio,
  },
  async (a, extra) => {
    const source = a.source || singleTranscribedSource();
    if (!source) throw missingSourceError(Object.keys(loadIndex()));
    const tr = loadTranscript(a.transcriptSource || source);
    const ranges = picksToRanges(tr, a.picks, {
      padBefore: a.padBefore ?? 0.08,
      padAfter: a.padAfter ?? 0.15,
      mergeGap: a.mergeGap ?? 0.4,
    });
    await refineOutPoints(a.transcriptSource || source, ranges, extra);
    const segments = withExtras(ranges, source, a.extraAudio);
    return buildAndReport(a.name, segments, a.gap ?? 0, {
      ranges: ranges.map((r) => `${tc(r.in)}–${tc(r.out)} věty ${r.ids.join(',')}`),
    });
  },
);

tool(
  'build_sequence_without_pauses',
  'Vytvoří novou sekvenci ze zdroje bez hluchých míst (ponechá jen řeč, pauzy delší než minPause vystřihne).',
  {
    name: z.string(),
    source: z.string().optional().describe('Bez zadání použije jediný existující přepis (je-li jen jeden)'),
    transcriptSource: z.string().optional().describe('Soubor s přepisem, když řeč je v jiném souboru (výchozí = source)'),
    minPause: z.number().optional().describe('Pauza delší než toto se vystřihne (výchozí 0.7 s)'),
    pad: z.number().optional().describe('Odsazení kolem řeči (výchozí 0.15 s)'),
    extraAudio,
  },
  async (a, extra) => {
    const source = a.source || singleTranscribedSource();
    if (!source) throw missingSourceError(Object.keys(loadIndex()));
    const tr = loadTranscript(a.transcriptSource || source);
    const ranges = mergeRanges(speechIslands(tr, a.minPause ?? 0.7, a.pad ?? 0.15), 0);
    await refineOutPoints(a.transcriptSource || source, ranges, extra);
    const kept = ranges.reduce((acc, r) => acc + r.out - r.in, 0);
    const segments = withExtras(ranges, source, a.extraAudio);
    return buildAndReport(a.name, segments, 0, {
      original: tc(tr.duration),
      removed: tc(Math.max(0, tr.duration - kept)),
    });
  },
);

tool(
  'build_sequence',
  'Obecné sestavení nové sekvence z libovolných úseků zdrojů (in/out v sekundách zdroje).',
  {
    name: z.string(),
    segments: z
      .array(
        z.object({
          source: z.string().describe('Cesta k médiu nebo nodeId položky projektu'),
          in: z.number(),
          out: z.number(),
          audioOnly: z.boolean().optional(),
          extra: z
            .array(z.object({ source: z.string(), offset: z.number().optional(), audioTrack: z.number().int().optional() }))
            .optional(),
        }),
      )
      .min(1),
    gap: z.number().optional(),
  },
  (a) => buildAndReport(a.name, a.segments, a.gap ?? 0, {}),
);

tool(
  'detect_scene_cuts',
  'Najde skutečné vizuální střihy kamer zapečené uvnitř JEDNOHO spojitého zdrojového souboru (Premierina Scene Edit Detection – ' +
    'pozná změnu obrazu, ne kdo mluví). Spustit jen na výslovné přání uživatele – vytvoří dočasnou pracovní sekvenci se zadaným ' +
    'zdrojem a rozsahem. U delšího úseku (přes ~5 min) to může trvat přes minutu, radši zvol kratší rozsah přes "to". ' +
    'Vrací časy střihů VE ZDROJI (ne v timeline). Hodí se jako doplňkový signál ke zvukové diarizaci pro multicam, nebo na ' +
    'nalezení skrytých řezů v jednom dlouhém záběru.',
  {
    source: z.string().describe('Cesta ke zdrojovému video souboru'),
    to: z.number().optional().describe('Do kolika sekund od začátku zdroje analyzovat (výchozí celý soubor – pozor, může být pomalé)'),
    sensitivity: z.string().optional().describe('Citlivost detekce v Premiere, výchozí "LowSensitivity" (jediná ověřená hodnota)'),
  },
  (a) => premiere('detectSceneCuts', a, 300000),
);

tool(
  'remove_timeline_ranges',
  'DESTRUKTIVNÍ: vyřízne časové úseky (časy timeline) ze všech stop aktivní/zadané sekvence. ripple=true dotáhne zbytek, synchronizace stop zůstane. Doporučeno nejdřív duplikovat sekvenci.',
  {
    sequence: seqArg,
    ranges: z.array(z.object({ start: z.number(), end: z.number() })).min(1),
    ripple: z.boolean().optional().describe('Výchozí true'),
  },
  (a) => premiere('removeRanges', a, 600000),
);

tool(
  'razor',
  'Rozstřihne všechny stopy sekvence v zadaných časech timeline.',
  { sequence: seqArg, times: z.array(z.number()).min(1) },
  (a) => premiere('razor', a),
);

tool(
  'remove_clips',
  'Smaže konkrétní klipy (kind/track/index z get_sequence).',
  {
    sequence: seqArg,
    clips: z.array(z.object({ kind: z.enum(['video', 'audio']), track: z.number().int(), index: z.number().int() })).min(1),
    ripple: z.boolean().optional(),
  },
  (a) => premiere('removeClips', a),
);

tool(
  'add_markers',
  'Přidá značky do sekvence (např. pro označení témat nebo míst k revizi).',
  {
    sequence: seqArg,
    markers: z
      .array(
        z.object({
          time: z.number(),
          name: z.string().optional(),
          comment: z.string().optional(),
          duration: z.number().optional(),
          color: z.number().int().min(0).max(7).optional().describe('0 zelená,1 červená,2 fialová,3 oranžová,4 žlutá,5 bílá,6 modrá,7 azurová'),
        }),
      )
      .min(1),
  },
  (a) => premiere('addMarkers', a),
);

tool('get_markers', 'Vypíše značky sekvence.', { sequence: seqArg }, (a) => premiere('getMarkers', a));

tool('set_playhead', 'Posune přehrávací hlavu na čas timeline.', { sequence: seqArg, time: z.number() }, (a) =>
  premiere('setPlayhead', a),
);

tool(
  'export_sequence',
  'Exportuje sekvenci do souboru (přímo z Premiere, nebo zařadí do Media Encoderu).',
  {
    sequence: seqArg,
    output: z.string().describe('Výstupní soubor, např. O:/export/strih.mp4'),
    preset: z.string().optional().describe('Cesta k .epr (výchozí H.264 Match Source High bitrate)'),
    range: z.enum(['entire', 'inout', 'workarea']).optional(),
    useAME: z.boolean().optional().describe('Zařadit do Adobe Media Encoder místo přímého exportu'),
  },
  (a) => premiere('exportSequence', { ...a, preset: a.preset || CONFIG.defaultExportPreset }, 3600000),
);

tool('save_project', 'Uloží projekt.', {}, () => premiere('saveProject'));

tool('undo', 'Vrátí poslední akci v Premiere zpět (jako Ctrl+Z).', {}, () => premiere('undo'));

tool(
  'backup_project',
  'Uloží projekt a udělá časovou zálohu .prproj souboru (do podsložky backups vedle projektu). ' +
    'Spolehlivější pojistka než undo (viz undo) – zavolej PŘED destruktivní akcí (remove_timeline_ranges, remove_clips, razor), ' +
    'nebo kdykoliv o to uživatel požádá. Obnova je zatím ruční – otevřít zálohu v Premiere.',
  {},
  async () => {
    const info = await premiere('projectInfo');
    if (!info.path) throw new Error('Projekt nemá cestu na disku (ještě neuložen?).');
    await premiere('saveProject');
    const src = info.path;
    const dir = path.join(path.dirname(src), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${path.basename(src, '.prproj')}.${stamp}.prproj`);
    fs.copyFileSync(src, dest);
    return { backup: dest, sizeMB: Math.round((fs.statSync(dest).size / 1048576) * 10) / 10 };
  },
);

tool(
  'run_extendscript',
  'Spustí libovolný ExtendScript (ES3) v Premiere a vrátí výsledek posledního výrazu jako text. Pro operace, na které není nástroj.',
  { code: z.string() },
  ({ code }) => bridge('/eval', { code }),
);

tool('reload_bridge', 'Znovu načte host.jsx v panelu (po úpravě kódu, bez restartu Premiere).', {}, async () =>
  JSON.parse(await bridge('/reload', {}, 30000)),
);

/* ------------------------------------------------------------------ Worker: mluvčí, synchronizace, porozumění, více kamer */

function outlineText(source) {
  const an = loadIndexed('analysis', source);
  if (!an) throw new Error(`Pro ${source} ještě není analýza – zavolej analyze_transcript.`);
  const lines = [
    `Osnova: ${path.basename(source)} · ${tc(an.duration)} · ${an.sentences} vět${an.speakers?.length ? ` · mluvčí ${an.speakers.join(', ')}` : ''}${an.llm ? '' : ' · bez LLM'}`,
  ];
  an.chapters.forEach((c, i) =>
    lines.push(
      `K${i + 1} #${c.from}–#${c.to} ${tc(c.start)}–${tc(c.end)} (${Math.round(c.end - c.start)} s)` +
        `${c.speakers?.length ? ` [${c.speakers.join(', ')}]` : ''} ${c.title}${c.summary ? ` – ${c.summary}` : ''}` +
        `${c.best?.length ? ` · nejlepší #${c.best.join(', #')}` : ''}`,
    ),
  );
  const weak = Object.entries(an.weak || {});
  if (weak.length) {
    lines.push('', `Slabé věty (${weak.length}):`);
    for (const [id, why] of weak) lines.push(`#${id}: ${why.join('; ')}`);
  }
  lines.push('', 'Detail kapitoly: get_transcript s fromId/toId a format "compact".');
  return lines.join('\n');
}

tool('worker_status', 'Stav lokálního Workeru (modely, GPU, fronta úloh). Spustí ho, pokud neběží.', {}, async () => {
  await ensureWorker();
  const [health, jobs] = await Promise.all([workerFetch('/health'), workerFetch('/jobs')]);
  return { health, jobs: jobs.slice(0, 10) };
});

tool(
  'job_status',
  'Stav úlohy Workeru; cancel=true ji zruší.',
  { id: z.string(), cancel: z.boolean().optional() },
  async ({ id, cancel }) => {
    await ensureWorker();
    if (cancel) await workerFetch(`/jobs/${id}/cancel`, { method: 'POST' });
    const j = await workerFetch(`/jobs/${id}`);
    return { ...j, trace: undefined, key: undefined };
  },
);

tool(
  'diarize_media',
  'Rozpozná, kdo kdy mluví, jen z hlasu (bez oddělených mikrofonů). Mluvčí S1, S2… se zapíší i do přepisu. Vrací ukázkové věty pro pojmenování.',
  {
    path: z.string(),
    numSpeakers: z.number().int().min(1).optional().describe('Počet mluvčích, pokud je znám (přesnější)'),
    threshold: z.number().optional().describe('Práh shlukování (výchozí 0.5; nižší = víc mluvčích)'),
    force: z.boolean().optional(),
  },
  async (a, extra) => {
    const r = await runJob('diarize', { path: a.path, numSpeakers: a.numSpeakers, threshold: a.threshold, force: a.force }, extra);
    const lines = [`Mluvčí: ${r.numSpeakers} · čas řeči: ${Object.entries(r.speakingTime).map(([k, v]) => `${k} ${tc(v)}`).join(', ')}`];
    if (r.mergedIntoTranscript) {
      const tr = loadTranscript(a.path);
      lines.push('Ukázky vět (pojmenuj přes rename_speakers):');
      const shown = new Map();
      for (const s of tr.segments) {
        const n = shown.get(s.speaker) || 0;
        if (n < 3 && s.text.length > 25) {
          lines.push(segLine(s));
          shown.set(s.speaker, n + 1);
        }
      }
    } else {
      lines.push('Přepis zatím neexistuje – po transcribe_media zavolej diarize_media znovu (z cache je okamžité).');
    }
    return lines.join('\n');
  },
);

tool(
  'rename_speakers',
  'Přejmenuje mluvčí (např. {"S1":"Petr","S2":"Moderátor"}) v přepisu i diarizaci.',
  { path: z.string(), mapping: z.record(z.string(), z.string()) },
  (a, extra) => runJob('rename_speakers', a, extra),
);

server.registerTool(
  'get_frame',
  {
    description: 'Vytáhne snímek z videa v daném čase a vrátí ho jako obrázek (obrazová analýza – ověř kompozici, ostrost, kdo je v záběru, kvalitu kamery apod.). Použij střídmě, obrázky stojí víc tokenů.',
    inputSchema: { path: z.string(), at: z.number().describe('Čas ve zdroji (s)') },
  },
  async (a) => {
    try {
      const r = await runJob('frame', { path: a.path, at: a.at });
      const data = fs.readFileSync(r.file).toString('base64');
      return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `snímek z ${tc(r.t)}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
    }
  },
);

tool(
  'describe_frame',
  'Vytáhne snímek z videa v daném čase a POPÍŠE ho lokálním vision modelem (Qwen3-VL, zdarma, bez Claude kreditů) – kompozice, ostrost, kdo/co je v záběru. ' +
    'Levnější alternativa ke get_frame, když stačí textový popis a ne se dívat na obrázek sám.',
  {
    path: z.string(),
    at: z.number().describe('Čas ve zdroji (s)'),
    prompt: z.string().optional().describe('Vlastní otázka k obrázku (výchozí: obecný popis kompozice)'),
  },
  (a) => runJob('describe_frame', a),
);

tool(
  'sync_media',
  'Synchronizuje kamery a mikrofony podle zvuku. Vrací offset = čas v referenci, kdy daný soubor začíná.',
  {
    reference: z.string().describe('Referenční zvuk (hlavní mix / zvukař)'),
    others: z.array(z.string()).min(1),
    maxOffset: z.number().optional().describe('Max. hledaný posun v s (výchozí 600)'),
    force: z.boolean().optional(),
  },
  async (a, extra) => {
    const r = await runJob('sync', a, extra);
    return r.results
      .map((x) => `${path.basename(x.path)}: offset ${x.offset.toFixed(3)} s · jistota ${x.confidence}${x.reliable ? '' : ' ⚠ NEJISTÉ'} · délka ${tc(x.duration)}`)
      .join('\n');
  },
);

tool(
  'analyze_transcript',
  'Porozumění dlouhému dialogu LOKÁLNĚ (bez kreditů): kapitoly s shrnutím, nejsilnější věty, slabá místa (přeřeknutí, opakované pokusy, vata, nedokončené věty). Vrací kompaktní osnovu.',
  {
    path: z.string(),
    llm: z.boolean().optional().describe('false = jen rychlá heuristika bez jazykového modelu'),
    force: z.boolean().optional(),
  },
  async (a, extra) => {
    await runJob('analyze', { path: a.path, llm: a.llm ?? true, force: a.force }, extra);
    return outlineText(a.path);
  },
);

tool('get_outline', 'Vrátí uloženou osnovu z analyze_transcript.', { path: z.string() }, ({ path: p }) => outlineText(p));

tool(
  'export_analysis',
  'Uloží kompletní, samostatný .md soubor (instrukce + osnova + celý přepis) pro použití mimo Claude – ' +
    'stačí ho vložit do ChatGPT (nebo jiné AI) v jedné zprávě, sama pozná, co má dělat, a zeptá se uživatele, co chce nastříhat.',
  {
    path: z.string().describe('Zdroj (musí mít uložený přepis, ideálně i analyze_transcript)'),
    output: z.string().optional().describe('Kam uložit .md (výchozí = vedle zdroje)'),
  },
  ({ path: p, output }) => {
    const tr = loadTranscript(p);
    let outline = '';
    try {
      outline = outlineText(p);
    } catch {
      outline = `(Osnova není k dispozici – nejdřív zavolej analyze_transcript, pokud ji chceš. Přepis níže stačí i bez ní.)`;
    }
    const lines = tr.segments.map((s) => {
      const ws = (s.words || []).map((w, i) => `${i}:${w.w}`).join(' ');
      return `${segLine(s)}${ws ? `\n    slova: ${ws}` : ''}`;
    });
    // Instrukce se vkládají přímo do exportu (jeden soubor, jedna zpráva do ChatGPT) - dřív si je
    // uživatel musel otevřít a vložit zvlášť, což bylo krokem navíc a matlo to.
    const instrukce = fs.readFileSync(path.join(ROOT, 'EXTERNI_AI_INSTRUKCE.md'), 'utf8');
    const out = [
      instrukce.trim(),
      '',
      '---',
      '',
      `# Přepis a osnova: ${path.basename(p)}`,
      '',
      '## Osnova',
      outline,
      '',
      '## Plný přepis',
      ...lines,
      '',
      '---',
      '',
      'Teď se uživatele zeptej česky, co chce nastříhat (jakou délku, o čem, styl) – teprve pak vrať JSON plán podle formátu výše.',
    ].join('\n');
    const dest = output ? path.resolve(output) : `${p}.analyza.md`;
    fs.writeFileSync(dest, out, 'utf8');
    return { file: dest, sentences: tr.segments.length, sizeKB: Math.round(Buffer.byteLength(out) / 1024) };
  },
);

tool(
  'build_from_plan',
  'Načte plán střihu z .md/.json souboru (formát viz EXTERNI_AI_INSTRUKCE.md – {"name":..,"picks":[..]}) a vytvoří z něj novou sekvenci. ' +
    'Pro výstup z externí AI (ChatGPT apod.), když si uživatel udělal výběr vět mimo Claude.',
  {
    planFile: z.string().describe('Cesta k souboru s JSON plánem (může mít kolem JSON i další text, vezme se první {...} blok)'),
    source: z.string().describe('Zdrojové video/zvuk, ke kterému se plán vztahuje'),
    name: z.string().optional().describe('Přebije "name" z plánu, pokud je zadané'),
  },
  async (a, extra) => {
    const raw = fs.readFileSync(a.planFile, 'utf8');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`V souboru ${a.planFile} nebyl nalezen žádný JSON blok {...}.`);
    let plan;
    try {
      plan = JSON.parse(m[0]);
    } catch (e) {
      throw new Error(`JSON v ${a.planFile} se nepodařilo naparsovat: ${e.message}`);
    }
    if (!Array.isArray(plan.picks) || !plan.picks.length) throw new Error(`Plán v ${a.planFile} neobsahuje neprázdné pole "picks".`);
    const name = a.name || plan.name || `Plán z ${path.basename(a.planFile)}`;
    const tr = loadTranscript(a.source);
    const ranges = picksToRanges(tr, plan.picks, { padBefore: 0.08, padAfter: 0.15, mergeGap: 0.4 });
    const segments = withExtras(ranges, a.source);
    return buildAndReport(name, segments, 0, {
      ranges: ranges.map((r) => `${tc(r.in)}–${tc(r.out)} věty ${r.ids.join(',')}`),
      planFile: a.planFile,
    });
  },
);

tool(
  'plan_edit_local',
  'Navrhne střih úplně lokálně (lokální LLM vybere kapitoly a věty podle zadání, dorovná délku). Volitelně rovnou vytvoří sekvenci.',
  {
    path: z.string().describe('Zdroj s přepisem'),
    instruction: z.string().describe('Zadání střihu česky'),
    targetSec: z.number().optional(),
    build: z
      .object({ name: z.string(), source: z.string().optional().describe('Video na timeline (výchozí = path)'), extraAudio })
      .optional(),
  },
  async (a, extra) => {
    const plan = await runJob('plan_edit', { path: a.path, instruction: a.instruction, targetSec: a.targetSec }, extra);
    if (!a.build || !plan.picks.length) return plan;
    const tr = loadTranscript(a.path);
    const ranges = picksToRanges(tr, plan.picks, { padBefore: 0.08, padAfter: 0.15, mergeGap: 0.4 });
    const built = await buildAndReport(a.build.name, withExtras(ranges, a.build.source || a.path, a.build.extraAudio), 0, {});
    return { plan, built };
  },
);

tool(
  'build_multicam_sequence',
  'AUTOMATICKÝ STŘIH VÍCE KAMER podle mluvčího. Kamery se synchronizují podle zvuku (není-li zadán offset), obraz se přepíná na detail toho, kdo mluví; překryv a delší ticho jdou do celku, dlouhé monology se prostřihnou. Zvuk z reference je souvislý pod obrazem. dryRun vrátí plán bez Premiere.',
  {
    name: z.string(),
    reference: z.string().describe('Referenční zvuk – z jeho přepisu/diarizace se určí, kdo mluví'),
    cameras: z
      .array(
        z.object({
          source: z.string(),
          role: z.enum(['wide', 'close']).optional().describe('wide = celek, close = detail (výchozí)'),
          speakers: z.array(z.string()).optional().describe('Kdo je na detailu (jména jako v přepisu)'),
          offset: z.number().optional().describe('Čas v referenci, kdy kamera začíná; bez zadání se dopočítá'),
        }),
      )
      .min(1),
    audio: z
      .array(z.object({ source: z.string(), audioTrack: z.number().int().optional(), offset: z.number().optional() }))
      .optional()
      .describe('Zvuk na timeline (výchozí reference na A1)'),
    speakerSource: z.enum(['auto', 'diarization', 'transcript']).optional(),
    picks: z.array(z.number().int()).optional().describe('Jen vybrané věty reference (střih příběhu + kamery)'),
    ranges: z.array(z.object({ start: z.number(), end: z.number() })).optional().describe('Úseky reference v s'),
    rules: z
      .object({
        minShot: z.number(),
        preRoll: z.number(),
        postRoll: z.number(),
        maxShot: z.number(),
        reactionLen: z.number(),
        silenceToWide: z.number(),
        overlapWide: z.boolean(),
      })
      .partial()
      .optional(),
    dryRun: z.boolean().optional(),
  },
  async (a, extra) => {
    const cams = a.cameras.map((c) => ({ role: 'close', speakers: [], ...c }));
    const audio = (a.audio?.length ? a.audio : [{ source: a.reference, audioTrack: 0 }]).map((x) => ({ audioTrack: 0, ...x }));
    const all = [...cams, ...audio];
    const needSync = all.filter((x) => x.offset === undefined && normKey(x.source) !== normKey(a.reference));
    if (needSync.length) {
      const s = await runJob('sync', { reference: a.reference, others: [...new Set(needSync.map((x) => x.source))] }, extra);
      const bySrc = new Map(s.results.map((r) => [normKey(r.path), r]));
      for (const x of needSync) {
        const r = bySrc.get(normKey(x.source));
        Object.assign(x, { offset: r.offset, duration: r.duration, syncConfidence: r.confidence });
      }
    }
    for (const x of all) x.offset ??= 0;

    let tr = null;
    try {
      tr = loadTranscript(a.reference);
    } catch {
      /* bez přepisu */
    }
    const dia = loadIndexed('diarization', a.reference);
    const mode = a.speakerSource || 'auto';
    let intervals;
    if (dia && (mode === 'diarization' || (mode === 'auto' && tr?.speakerSource !== 'mics'))) intervals = intervalsFromTurns(dia.turns);
    else if (tr?.speakers?.length) intervals = intervalsFromTranscript(tr);
    else throw new Error('Reference nemá mluvčí: použij transcribe_media se speakerTracks, nebo diarize_media.');

    const names = [...intervals.keys()];
    const duration = tr?.duration ?? dia?.duration;
    let ranges = a.ranges;
    if (!ranges && a.picks) {
      if (!tr) throw new Error('picks vyžadují přepis reference');
      ranges = picksToRanges(tr, a.picks, { padBefore: 0.08, padAfter: 0.15, mergeGap: 0.4 }).map((r) => ({ start: r.in, end: r.out }));
    }
    ranges ??= [{ start: 0, end: duration }];
    const runsPerRange = ranges.map((r) => planRuns({ intervals, cameras: cams, start: r.start, end: r.end, rules: a.rules }));
    const flat = runsPerRange.flat();
    const report = {
      speakers: names,
      unmappedSpeakers: names.filter((n) => !cams.some((c) => c.speakers.includes(n))),
      offsets: all.map((x) => `${path.basename(x.source)} ${x.offset.toFixed(3)} s${x.syncConfidence !== undefined ? ` (jistota ${x.syncConfidence})` : ''}`),
      warnings: all.filter((x) => x.syncConfidence !== undefined && x.syncConfidence < 1.5).map((x) => `Nejistá synchronizace: ${path.basename(x.source)}`),
      ...summarizeRuns(flat, cams),
    };
    if (a.dryRun) {
      return {
        ...report,
        cuts: flat.slice(0, 80).map((r) => `${tc(r.start)}–${tc(r.end)} ${path.basename(cams[r.cam].source)}${r.cutaway ? ' (prostřih)' : ''}`),
        runs: flat.slice(0, 3000),
      };
    }
    const clips = multicamClips({ ranges, cameras: cams, audio, runsPerRange });
    const res = await premiere('buildTimeline', { name: a.name, clips }, 1800000);
    return { ...report, sequence: res.name, sequenceID: res.sequenceID, duration: tc(res.duration), clipsPlaced: `${res.clips}/${res.total}`, premiereWarnings: res.warnings };
  },
);

await server.connect(new StdioServerTransport());
