"""Střihy obrazu ve zdrojovém souboru neuronovou sítí TransNetV2 (Souček & Lokoč 2020, MIT) přes onnxruntime.

Náhrada Premierina Scene Edit Detection (dočasná sekvence, 6 min zdroje za 5 min, blokovala Premiere) a ffmpeg
„scene score“ (falešné střihy u blesků, rychlého pohybu a švenků). Snímky dekóduje ffmpeg rovnou v 48×27 RGB,
síť bere okna po 100 snímcích (posun 50, 25 snímků kontextu z každé strany) jako původní implementace
soCzech/TransNetV2. Model: models/transnetv2/transnetv2.onnx (huggingface.co/elya5/transnetv2, SHA-256 c4d54a68…).

Vstup:  {path, ranges?: [{from, to}], to?, sensitivity?}
Výstup: {cuts: [s ve zdroji – začátek nového záběru], transitions: [{from, to}] (prolínačky), count, analyzed, fps, engine}
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from worker.common import ROOT

MODEL = ROOT / "models" / "transnetv2" / "transnetv2.onnx"
W, H = 48, 27
FRAME = W * H * 3
# citlivost jako u Premiere (LowSensitivity = jen jisté střihy); práh pravděpodobnosti střihu na snímku
THRESH = {"lowsensitivity": 0.5, "mediumsensitivity": 0.35, "highsensitivity": 0.2}

_session = None


def available() -> bool:
    return MODEL.exists()


def _sess():
    global _session
    if _session is None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, min(16, (os.cpu_count() or 4) // 2))  # 16 vláken: 114 ms / 50 snímků (8: 189 ms)
        so.log_severity_level = 3
        _session = ort.InferenceSession(str(MODEL), sess_options=so, providers=["CPUExecutionProvider"])
    return _session


def _probe(path: str) -> tuple[float, float]:
    """fps a délka (s) přes ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate:format=duration",
         "-of", "json", path], capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    d = json.loads(out.stdout or "{}")
    st = (d.get("streams") or [{}])[0]

    def rate(s):
        try:
            a, b = str(s).split("/")
            return float(a) / float(b) if float(b) else 0.0
        except Exception:  # noqa: BLE001
            return 0.0
    fps = rate(st.get("avg_frame_rate")) or rate(st.get("r_frame_rate")) or 25.0
    if fps > 120 or fps < 5:
        fps = rate(st.get("r_frame_rate")) or 25.0
    dur = float((d.get("format") or {}).get("duration") or 0)
    return fps, dur


def _frames(path: str, start: float, length: float, ctx):
    """Generátor snímků 27×48×3 (uint8) úseku [start, start+length)."""
    import numpy as np

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if length > 0:
        cmd += ["-t", f"{length:.3f}"]
    cmd += ["-an", "-sn", "-dn", "-vf", f"scale={W}:{H}:flags=area,format=rgb24", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        while True:
            buf = p.stdout.read(FRAME * 250)
            if not buf:
                break
            n = len(buf) // FRAME
            if n:
                yield np.frombuffer(buf[: n * FRAME], dtype=np.uint8).reshape(n, H, W, 3)
            ctx.check()
    finally:
        p.kill() if p.poll() is None else None
        p.stdout.close()


def _predict(path: str, start: float, length: float, ctx, on_frames=None):
    """Pravděpodobnosti po snímcích (single = střih na snímku, many = uvnitř přechodu) – okna jako upstream."""
    import numpy as np

    sess = _sess()
    inp = sess.get_inputs()[0].name
    outs = [o.name for o in sess.get_outputs()]
    single, many = [], []
    thumbs = []  # šedé náhledy 12×9 (rozpoznání blesku fotoaparátu, ~100 B / snímek)
    buf = None  # snímky čekající na zpracování (s levým kontextem)
    total = 0

    def run(win):
        r = sess.run(outs, {inp: win[None].astype(np.float32)})
        s = np.asarray(r[0]).reshape(-1)
        m = np.asarray(r[1]).reshape(-1) if len(r) > 1 else s
        return s[25:75], m[25:75]

    for chunk in _frames(path, start, length, ctx):
        g = chunk.astype(np.float32).mean(axis=3)  # n × 27 × 48
        thumbs.append(g.reshape(len(g), 9, 3, 12, 4).mean(axis=(2, 4)))
        if buf is None:
            buf = np.concatenate([np.repeat(chunk[:1], 25, axis=0), chunk])  # levý okraj: 25× první snímek
        else:
            buf = np.concatenate([buf, chunk])
        total += len(chunk)
        while len(buf) >= 100:
            s, m = run(buf[:100])
            single.append(s); many.append(m)
            buf = buf[50:]
        if on_frames:
            on_frames(total)
    if buf is None:
        return np.zeros(0), np.zeros(0), 0, np.zeros((0, 9, 12))
    # pravý okraj: doplnit posledním snímkem, dokud nejsou spočítané všechny skutečné snímky
    done = sum(len(x) for x in single)
    while done < total:
        need = 100 - len(buf)
        if need > 0:
            buf = np.concatenate([buf, np.repeat(buf[-1:], need, axis=0)])
        s, m = run(buf[:100])
        single.append(s); many.append(m)
        done += 50
        buf = buf[50:]
    return np.concatenate(single)[:total], np.concatenate(many)[:total], total, np.concatenate(thumbs)[:total]


def _is_flash(th, k: int) -> bool:
    """Blesk fotoaparátu / záblesk místo střihu: 1–3 snímky kolem k náhle světlejší a obraz před nimi a po nich
    stejný (S14: dvousnímkový blesk TransNetV2 označil jako střih). Jump cut na stejné kameře zjasnění nemá – zůstane."""
    import numpy as np

    n = len(th)
    if n < 6:
        return False
    lum = th.reshape(n, -1).mean(axis=1)
    for a in range(max(0, k - 3), k + 1):           # začátek záblesku
        for b in range(k, min(n - 1, k + 3)):       # konec záblesku (poslední světlý snímek)
            pre, post = a - 1, b + 1
            if pre < 0 or post >= n:
                continue
            same = float(np.abs(th[pre] - th[post]).mean())
            spike = float(lum[a:b + 1].min()) - max(float(lum[pre]), float(lum[post]))
            if same < 10 and spike > 25:
                return True
    return False


def _peaks(p, thr: float, min_gap: int) -> list[int]:
    """Indexy snímků s vrcholem nad prahem (jeden střih = jeden vrchol)."""
    out, i, n = [], 0, len(p)
    while i < n:
        if p[i] >= thr:
            j = i
            while j + 1 < n and p[j + 1] >= thr:
                j += 1
            k = i + int(max(range(j - i + 1), key=lambda q: p[i + q]))
            if not out or k - out[-1] >= min_gap:
                out.append(k)
            i = j + 1
        else:
            i += 1
    return out


def detect(params: dict, ctx) -> dict:
    import time

    path = params["path"]
    if not os.path.exists(path):
        raise FileNotFoundError(f"Soubor neexistuje: {path}")
    if not available():
        raise FileNotFoundError("Chybí model TransNetV2 (models/transnetv2/transnetv2.onnx) – spusť instalaci MY Premiere MCP znovu.")
    fps, dur = _probe(path)
    thr = THRESH.get(str(params.get("sensitivity") or "LowSensitivity").lower(), 0.5)
    ranges = params.get("ranges") or [{"from": 0.0, "to": float(params["to"]) if params.get("to") else dur}]
    ranges = [(max(0.0, float(r["from"])), min(dur or float(r["to"]), float(r["to"]))) for r in ranges]
    ranges = [(a, b) for a, b in ranges if b - a >= 0.2]
    todo = sum(b - a for a, b in ranges) or 1.0
    t0 = time.time()
    cuts: list[float] = []
    transitions: list[dict] = []
    analyzed = 0.0
    flashes = 0  # vyřazené záblesky (blesk fotoaparátu)
    min_gap = max(2, int(round(fps * 0.2)))  # dva střihy nejméně 0,2 s od sebe
    for a, b in ranges:
        base = analyzed

        def prog(n, base=base):
            ctx.progress(min(0.99, (base + n / fps) / todo), f"střihy obrazu: {base + n / fps:.0f} / {todo:.0f} s")
        single, many, n, th = _predict(path, a, b - a, ctx, prog)
        analyzed += b - a
        if not n:
            continue
        for k in _peaks(single, thr, min_gap):
            if _is_flash(th, k):
                flashes += 1
                continue
            t = a + (k + 1) / fps  # k = poslední snímek odcházejícího záběru → nový záběr od k+1
            if a + 0.04 < t < b - 0.04:
                cuts.append(round(t, 3))
        # prolínačky: souvislý úsek „uvnitř přechodu“ (many ≥ práh) delší než 3 snímky bez ostrého střihu uvnitř
        i = 0
        while i < n:
            if many[i] >= max(thr, 0.5):
                j = i
                while j + 1 < n and many[j + 1] >= max(thr, 0.5):
                    j += 1
                if j - i >= 3:
                    ta, tb = a + i / fps, a + (j + 1) / fps
                    mid = round((ta + tb) / 2, 3)
                    if not any(ta - 0.1 <= c <= tb + 0.1 for c in cuts) and a + 0.04 < mid < b - 0.04:
                        cuts.append(mid)
                        transitions.append({"from": round(ta, 3), "to": round(tb, 3)})
                i = j + 1
            else:
                i += 1
    cuts = sorted(set(cuts))
    secs = time.time() - t0
    return {
        "cuts": cuts, "count": len(cuts), "transitions": transitions, "analyzed": round(analyzed, 3), "fps": round(fps, 3),
        "duration": round(dur, 3), "engine": "transnetv2", "flashesIgnored": flashes, "seconds": round(secs, 2),
        "speed": round(analyzed / secs, 1) if secs > 0 else None,
    }
