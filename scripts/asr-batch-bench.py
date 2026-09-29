"""Whisper: klasický vs. dávkový přepis (BatchedInferencePipeline) – rychlost, přesnost textu a časů slov.
Reference = přepis stejného úseku z cache (large-v3, klasicky). .venv\Scripts\python.exe scripts\asr-batch-bench.py"""
import json
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
ROOT = "O:/MYpremiereMCP"
sys.path.insert(0, ROOT)
from worker.common import add_nvidia_dll_dirs  # noqa: E402

add_nvidia_dll_dirs()
from faster_whisper import BatchedInferencePipeline, WhisperModel  # noqa: E402

CLIP = f"{ROOT}/test/asr-bench/debata-10min.wav"
SRC = "C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4"
OFFSET, LEN = 1200.0, 600.0
idx = json.load(open(f"{ROOT}/cache/transcripts/index.json", encoding="utf8"))
tr = json.load(open(idx[os.path.abspath(SRC).lower()], encoding="utf8"))
ref = [(w["w"], w["s"] - OFFSET, w["e"] - OFFSET) for s in tr["segments"] for w in s.get("words", [])
       if OFFSET + 1.0 <= w["s"] and w["e"] <= OFFSET + LEN - 1.0]


def norm(x):
    return re.sub(r"[^\w]", "", x.lower())


def align(ref, hyp):
    """WER a průměrná odchylka časů u shodných slov (Levenshtein s návratem)."""
    r = [norm(w) for w, *_ in ref]
    h = [norm(w) for w, *_ in hyp]
    n, m = len(r), len(h)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    i, j, deltas = n, m, []
    while i and j:
        if r[i - 1] == h[j - 1] and d[i][j] == d[i - 1][j - 1]:
            deltas.append((abs(ref[i - 1][1] - hyp[j - 1][1]), abs(ref[i - 1][2] - hyp[j - 1][2])))
            i, j = i - 1, j - 1
        elif d[i][j] == d[i - 1][j] + 1:
            i -= 1
        elif d[i][j] == d[i][j - 1] + 1:
            j -= 1
        else:
            i, j = i - 1, j - 1
    ds = sorted(x for a, b in deltas for x in (a, b))
    return d[n][m] / max(1, n), (sum(ds) / len(ds) if ds else 0), (ds[int(0.95 * len(ds))] if ds else 0)


model = WhisperModel(f"{ROOT}/models/whisper-large-v3", device="cuda", compute_type=sys.argv[1] if len(sys.argv) > 1 else "float16")
runs = [("klasicky", None)] + [(f"dávkově {b}", b) for b in (8, 16)]
for name, bs in runs:
    t = time.time()
    if bs:
        segs, _ = BatchedInferencePipeline(model).transcribe(CLIP, language="cs", beam_size=5, word_timestamps=True,
                                                               vad_filter=True, batch_size=bs)
    else:
        segs, _ = model.transcribe(CLIP, language="cs", beam_size=5, word_timestamps=True, vad_filter=True)
    hyp = [(w.word, w.start, w.end) for s in segs for w in (s.words or []) if 1.0 <= w.start and w.end <= LEN - 1.0]
    sec = time.time() - t
    wer, mean_dt, p95 = align(ref, hyp)
    print(f"{name}: {sec:.1f} s ({LEN / sec:.1f}× realtime) · WER {100 * wer:.1f} % · časy slov: průměr {1000 * mean_dt:.0f} ms, "
          f"95 % do {1000 * p95:.0f} ms · {len(hyp)} slov (ref {len(ref)})", flush=True)
