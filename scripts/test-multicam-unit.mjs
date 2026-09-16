// Jednotkové testy logiky střihu více kamer (bez Premiere, bez Workeru): node scripts/test-multicam-unit.mjs
import assert from 'node:assert/strict';
import { intervalsFromTurns, multicamClips, planRuns } from '../server/multicam.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✔ ${name}`);
  } catch (e) {
    console.log(`✖ ${name}\n   ${e.message}`);
    process.exitCode = 1;
  }
}

const camsWide = [
  { source: 'wide.mp4', role: 'wide', speakers: [], offset: 0 },
  { source: 'a.mp4', role: 'close', speakers: ['A'], offset: 0 },
  { source: 'b.mp4', role: 'close', speakers: ['B'], offset: 0 },
];
const camAt = (runs, t) => runs.find((r) => t >= r.start && t < r.end)?.cam;

test('střídání mluvčích přepíná na detail', () => {
  const iv = intervalsFromTurns([
    { speaker: 'A', start: 1, end: 6 },
    { speaker: 'B', start: 7, end: 12 },
  ]);
  const runs = planRuns({ intervals: iv, cameras: camsWide, start: 0, end: 13 });
  assert.equal(camAt(runs, 3), 1);
  assert.equal(camAt(runs, 9), 2);
  const cut = runs.find((r) => r.cam === 2).start;
  assert.ok(cut <= 7 && cut >= 6.5, `střih na B má být s náběhem před 7 s, je ${cut}`);
});

test('souvislé záběry bez mezer a překryvů, pokrývají celý rozsah', () => {
  const iv = intervalsFromTurns([
    { speaker: 'A', start: 0, end: 20 },
    { speaker: 'B', start: 21, end: 40 },
  ]);
  const runs = planRuns({ intervals: iv, cameras: camsWide, start: 0, end: 45 });
  assert.equal(runs[0].start, 0);
  assert.equal(runs.at(-1).end, 45);
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i].start, runs[i - 1].end);
});

test('rychlé střídání nevytvoří záběr kratší než minShot', () => {
  const turns = [];
  for (let t = 0; t < 30; t += 1) turns.push({ speaker: t % 2 ? 'B' : 'A', start: t, end: t + 0.9 });
  const runs = planRuns({ intervals: intervalsFromTurns(turns, 0.05), cameras: camsWide, start: 0, end: 30 });
  for (const r of runs.slice(0, -1)) assert.ok(r.end - r.start >= 1.8 - 1e-6, `krátký záběr ${r.start}-${r.end}`);
});

test('dlouhý překryv řeči jde do celku', () => {
  const iv = intervalsFromTurns([
    { speaker: 'A', start: 0, end: 10 },
    { speaker: 'B', start: 4, end: 9 },
  ]);
  const runs = planRuns({ intervals: iv, cameras: camsWide, start: 0, end: 10 });
  assert.equal(camAt(runs, 7), 0);
});

test('monolog delší než maxShot dostane prostřih', () => {
  const iv = intervalsFromTurns([{ speaker: 'A', start: 0, end: 40 }]);
  const runs = planRuns({ intervals: iv, cameras: camsWide, start: 0, end: 40 });
  assert.ok(runs.some((r) => r.cutaway), 'chybí prostřih');
  assert.ok(runs.filter((r) => !r.cutaway).every((r) => r.end - r.start <= 14 + 2.4));
});

test('bez celku: překryv drží aktuální kameru, prostřih jde na druhý detail', () => {
  const cams = camsWide.slice(1);
  const iv = intervalsFromTurns([{ speaker: 'A', start: 0, end: 40 }]);
  const runs = planRuns({ intervals: iv, cameras: cams, start: 0, end: 40 });
  assert.ok(runs.every((r) => r.cam === 0 || r.cutaway));
  assert.ok(runs.some((r) => r.cutaway && r.cam === 1));
});

test('kamera, která ještě nenahrává, se nepoužije', () => {
  const cams = [
    { source: 'wide.mp4', role: 'wide', speakers: [], offset: 0 },
    { source: 'a.mp4', role: 'close', speakers: ['A'], offset: 10 },
  ];
  const iv = intervalsFromTurns([{ speaker: 'A', start: 0, end: 20 }]);
  const runs = planRuns({ intervals: iv, cameras: cams, start: 0, end: 20, rules: { maxShot: 100 } });
  assert.equal(camAt(runs, 5), 0);
  assert.equal(camAt(runs, 15), 1);
});

test('nenamapovaný mluvčí dostane celek', () => {
  const iv = intervalsFromTurns([{ speaker: 'X', start: 0, end: 10 }]);
  const runs = planRuns({ intervals: iv, cameras: camsWide, start: 0, end: 10 });
  assert.ok(runs.every((r) => r.cam === 0));
});

test('klipy: posun kamery, více úseků za sebou, zvuk nezačíná před zdrojem', () => {
  const cams = [{ source: 'wide.mp4', role: 'wide', speakers: [], offset: -2 }];
  const ranges = [
    { start: 10, end: 20 },
    { start: 50, end: 55 },
  ];
  const runsPerRange = ranges.map((r) => [{ cam: 0, start: r.start, end: r.end }]);
  const clips = multicamClips({ ranges, cameras: cams, audio: [{ source: 'mix.wav', offset: 12, audioTrack: 0 }], runsPerRange });
  const v = clips.filter((c) => c.kind === 'video');
  assert.deepEqual(v.map((c) => [c.in, c.at, c.dur]), [[12, 0, 10], [52, 10, 5]]);
  const a = clips.filter((c) => c.kind === 'audio');
  assert.deepEqual(a.map((c) => [c.in, c.at, c.dur]), [[0, 2, 8], [38, 10, 5]]);
});

test('výkon: hodina rozhovoru se naplánuje rychle', () => {
  const turns = [];
  let t = 0;
  while (t < 3600) {
    const len = 2 + ((t * 7) % 25);
    turns.push({ speaker: turns.length % 2 ? 'B' : 'A', start: t, end: t + len });
    t += len + 0.4;
  }
  const t0 = Date.now();
  const runs = planRuns({ intervals: intervalsFromTurns(turns), cameras: camsWide, start: 0, end: 3600 });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `plánování trvalo ${ms} ms`);
  console.log(`   (${turns.length} promluv → ${runs.length} záběrů za ${ms} ms)`);
});

console.log(`\n${passed} testů prošlo`);
