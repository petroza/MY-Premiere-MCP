// Automatický střih více kamer podle toho, kdo mluví – čistá logika bez Premiere (testovatelná offline).
//
// Vstup: intervaly řeči mluvčích v čase reference, kamery {source, role: 'wide'|'close', speakers[], offset, duration?}.
// offset = čas v referenci, kdy kamera začíná (zdrojový čas kamery = t - offset).

export const DEFAULT_RULES = {
  minShot: 1.8, // nejkratší záběr (s)
  preRoll: 0.3, // přepnout na mluvčího kousek před tím, než začne mluvit
  postRoll: 0.5, // po domluvení chvíli držet záběr
  maxShot: 14, // delší monolog prostřihnout do celku / reakce
  reactionLen: 2.4, // délka prostřihu
  silenceToWide: 3.5, // delší ticho -> celek
  overlapWide: true, // mluví-li víc lidí najednou -> celek
  overlapMin: 0.8, // překryv musí trvat aspoň tolik, aby šel do celku
  step: 0.05,
};

export function intervalsFromTurns(turns, mergeGap = 0.4) {
  const by = new Map();
  for (const t of [...turns].sort((a, b) => a.start - b.start)) {
    const arr = by.get(t.speaker) || [];
    const last = arr.at(-1);
    if (last && t.start - last.end <= mergeGap) last.end = Math.max(last.end, t.end);
    else arr.push({ start: t.start, end: t.end });
    by.set(t.speaker, arr);
  }
  return by;
}

export function intervalsFromTranscript(tr, mergeGap = 0.6) {
  const turns = [];
  for (const s of tr.segments) {
    for (const w of s.words || []) {
      const spk = w.spk || s.speaker;
      if (spk) turns.push({ speaker: spk, start: w.s, end: w.e });
    }
  }
  return intervalsFromTurns(turns, mergeGap);
}

/** Dotaz „kdo mluví v čase t" pro monotónně rostoucí t (ukazatel na interval pro každého mluvčího). */
function speakingAt(intervals, pre, post) {
  const ptr = new Map([...intervals.keys()].map((k) => [k, 0]));
  return (t) => {
    const out = [];
    for (const [spk, arr] of intervals) {
      let i = ptr.get(spk);
      while (i < arr.length && arr[i].end + post < t) i++;
      ptr.set(spk, i);
      if (i < arr.length && t >= arr[i].start - pre && t < arr[i].end + post) out.push({ spk, iv: arr[i] });
    }
    return out;
  };
}

export function planRuns({ intervals, cameras, start, end, rules = {} }) {
  const R = { ...DEFAULT_RULES, ...rules };
  const wide = cameras.findIndex((c) => c.role === 'wide');
  const fallback = wide >= 0 ? wide : 0;
  const camFor = (spk) => {
    const i = cameras.findIndex((c) => c.role !== 'wide' && (c.speakers || []).includes(spk));
    return i >= 0 ? i : fallback;
  };
  const covers = (ci, t) => {
    const c = cameras[ci];
    const st = t - (c.offset || 0);
    return st >= 0 && (c.duration == null || st <= c.duration);
  };
  const raw = speakingAt(intervals, 0, 0);
  const rolled = speakingAt(intervals, R.preRoll, R.postRoll);

  const steps = [];
  let cur = null;
  let silentSince = null;
  let overlapSince = null;
  const n = Math.max(1, Math.round((end - start) / R.step));
  for (let k = 0; k < n; k++) {
    const t = start + k * R.step;
    const now = raw(t).map((x) => x.spk);
    const soon = rolled(t);
    let want = null;
    if (now.length >= 2) {
      overlapSince ??= t;
      silentSince = null;
      want = R.overlapWide && wide >= 0 && t - overlapSince >= R.overlapMin ? wide : cur;
    } else {
      overlapSince = null;
      if (now.length === 1) {
        silentSince = null;
        want = camFor(now[0]);
      } else {
        const upcoming = soon.filter((x) => x.iv.start > t);
        if (upcoming.length) {
          silentSince = null;
          want = camFor(upcoming[0].spk);
        } else if (soon.length) {
          silentSince = null;
          want = cur;
        } else {
          silentSince ??= t;
          want = wide >= 0 && t - silentSince >= R.silenceToWide ? wide : cur;
        }
      }
    }
    if (want == null) want = fallback;
    if (!covers(want, t)) {
      const alt = [fallback, ...cameras.keys()].find((ci) => covers(ci, t));
      if (alt !== undefined) want = alt;
    }
    cur = want;
    steps.push(want);
  }

  let runs = [];
  steps.forEach((cam, k) => {
    const t = start + k * R.step;
    const last = runs.at(-1);
    if (last && last.cam === cam) last.end = t + R.step;
    else runs.push({ cam, start: t, end: t + R.step });
  });
  if (runs.length) runs.at(-1).end = end;

  // nejkratší záběr: krátký úsek se připojí k předchozímu záběru (u prvního k následujícímu)
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    const i = runs.findIndex((r) => r.end - r.start < R.minShot);
    if (i >= 0) {
      if (i > 0) runs[i - 1].end = runs[i].end;
      else runs[1].start = runs[0].start;
      runs.splice(i, 1);
      changed = true;
    }
    for (let j = 1; j < runs.length; j++) {
      if (runs[j].cam === runs[j - 1].cam) {
        runs[j - 1].end = runs[j].end;
        runs.splice(j, 1);
        j--;
        changed = true;
      }
    }
  }

  // dlouhý detail prostřihnout do celku (nebo do jiné kamery)
  const out = [];
  for (const r of runs) {
    const len = r.end - r.start;
    const alt = wide >= 0 ? wide : cameras.findIndex((c, ci) => ci !== r.cam);
    if (cameras[r.cam].role === 'wide' || len <= R.maxShot || alt < 0 || alt === r.cam) {
      out.push(r);
      continue;
    }
    const pieces = Math.floor(len / R.maxShot);
    let s = r.start;
    for (let k = 1; k <= pieces; k++) {
      const mid = r.start + (len * k) / (pieces + 1);
      const cs = mid - R.reactionLen / 2;
      const ce = mid + R.reactionLen / 2;
      if (cs - s < R.minShot || r.end - ce < R.minShot || !covers(alt, cs) || !covers(alt, ce)) continue;
      out.push({ cam: r.cam, start: s, end: cs }, { cam: alt, start: cs, end: ce, cutaway: true });
      s = ce;
    }
    out.push({ cam: r.cam, start: s, end: r.end });
  }
  return out.map((r) => ({ ...r, start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 }));
}

/** Klipy pro Premiere: obraz kamer na V1 (bez jejich zvuku), pod tím souvislý hlavní zvuk. */
export function multicamClips({ ranges, cameras, audio, runsPerRange }) {
  const clips = [];
  let cursor = 0;
  ranges.forEach((range, i) => {
    for (const r of runsPerRange[i]) {
      const cam = cameras[r.cam];
      clips.push({ kind: 'video', track: 0, videoOnly: true, source: cam.source, in: r.start - cam.offset, at: cursor + (r.start - range.start), dur: r.end - r.start });
    }
    for (const a of audio) {
      clips.push({ kind: 'audio', track: a.audioTrack ?? 0, source: a.source, in: range.start - a.offset, at: cursor, dur: range.end - range.start });
    }
    cursor += range.end - range.start;
  });
  return clips
    .map((c) => (c.in < 0 ? { ...c, at: c.at - c.in, dur: c.dur + c.in, in: 0 } : c))
    .filter((c) => c.dur > 0.02)
    .map((c) => ({ ...c, in: Math.round(c.in * 10000) / 10000, at: Math.round(c.at * 10000) / 10000, dur: Math.round(c.dur * 10000) / 10000 }));
}

export function summarizeRuns(runs, cameras) {
  const per = cameras.map((c) => ({ camera: c.source.split(/[\\/]/).pop(), role: c.role, shots: 0, seconds: 0 }));
  for (const r of runs) {
    per[r.cam].shots++;
    per[r.cam].seconds += r.end - r.start;
  }
  const lens = runs.map((r) => r.end - r.start);
  return {
    shots: runs.length,
    avgShot: Math.round((lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)) * 100) / 100,
    shortestShot: lens.length ? Math.round(Math.min(...lens) * 100) / 100 : 0,
    cameras: per.map((p) => ({ ...p, seconds: Math.round(p.seconds * 10) / 10 })),
  };
}
