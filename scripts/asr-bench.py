"""Rychlost a přesnost přepisu v různých režimech (GPU/CPU, compute type, vlákna) na 3min úseku debaty.
Reference = přepis stejného úseku z cache (large-v3, GPU). Spouštět přes .venv:
    .venv\\Scripts\\python.exe scripts\\asr-bench.py [režim ...]   režimy: cuda-fp16 cuda-int8 cpu-int8-16 cpu-int8-32
"""
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
from faster_whisper import WhisperModel  # noqa: E402

CLIP = f"{ROOT}/test/asr-bench/debata-3min.wav"
SRC = "C:/Users/Petr/Downloads/01-video/tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4"
OFFSET, LEN = 1560.0, 180.0
MODEL = f"{ROOT}/models/whisper-large-v3"

idx = json.load(open(f"{ROOT}/cache/transcripts/index.json", encoding="utf8"))
tr = json.load(open(idx[os.path.abspath(SRC).lower()], encoding="utf8"))
ref_words = [w["w"] for s in tr["segments"] for w in s.get("words", [])
             if OFFSET + 1.0 <= w["s"] and w["e"] <= OFFSET + LEN - 1.0]


def norm(ws):
    return [x for x in (re.sub(r"[^\w]", "", w.lower()) for w in ws) if x]


def wer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


MODES = {
    "cuda-fp16": dict(device="cuda", compute_type="float16"),
    "cuda-int8": dict(device="cuda", compute_type="int8_float16"),
    "cpu-int8-16": dict(device="cpu", compute_type="int8", cpu_threads=16),
    "cpu-int8-32": dict(device="cpu", compute_type="int8", cpu_threads=32),
}
for mode in sys.argv[1:] or list(MODES):
    kw = MODES[mode]
    t0 = time.time()
    try:
        m = WhisperModel(MODEL, **kw)
    except Exception as e:  # noqa: BLE001
        print(f"{mode}: načtení selhalo – {str(e)[:120]}")
        continue
    t_load = time.time() - t0
    t1 = time.time()
    segs, _ = m.transcribe(CLIP, language="cs", beam_size=5, word_timestamps=True, vad_filter=True)
    hyp = [w.word for s in segs for w in (s.words or []) if 1.0 <= w.start and w.end <= LEN - 1.0]
    t_run = time.time() - t1
    print(f"{mode}: načtení {t_load:.1f} s, přepis {t_run:.1f} s (RTF {LEN / t_run:.1f}× rychleji než realtime), "
          f"WER proti referenci {100 * wer(ref_words, hyp):.1f} % ({len(hyp)} slov / ref {len(ref_words)})", flush=True)
    del m
