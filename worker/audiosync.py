"""Synchronizace kamer a mikrofonů podle zvuku (křížová korelace obálky nástupů, FFT)."""
from __future__ import annotations

import os

from .common import cache_file, write_json, read_json

SR = 16000
HOP = 80  # 5 ms


def _onset_envelope(x):
    import numpy as np

    n = len(x) // HOP
    frames = x[: n * HOP].astype("float32").reshape(n, HOP)
    e = np.log1p(np.sqrt(np.mean(frames * frames, axis=1)) * 100.0)
    d = np.diff(e, prepend=e[:1])
    d[d < 0] = 0
    return (d - d.mean()) / (d.std() + 1e-9)


def _energy_envelope(x):
    import numpy as np

    n = len(x) // HOP
    frames = x[: n * HOP].astype("float32").reshape(n, HOP)
    return np.sqrt(np.mean(frames * frames, axis=1))


def _has_audio(path: str) -> bool:
    import av

    with av.open(path) as c:
        return len(c.streams.audio) > 0


def _offset(ref_env, other_env, max_lag: int):
    """Vrátí (lag v hopech, jistota). lag = čas reference, kdy začíná 'other'."""
    import numpy as np

    n = 1
    while n < len(ref_env) + len(other_env):
        n *= 2
    corr = np.fft.irfft(np.fft.rfft(ref_env, n) * np.conj(np.fft.rfft(other_env, n)), n)
    lags = np.arange(n)
    lags[lags >= n // 2] -= n
    mask = np.abs(lags) <= max_lag
    cand = np.where(mask, corr, -np.inf)
    k = int(np.argmax(cand))
    peak = cand[k]
    guard = int(0.5 * SR / HOP)
    excl = cand.copy()
    idx = np.arange(n)
    near = np.minimum(np.abs(idx - k), n - np.abs(idx - k)) <= guard
    excl[near] = -np.inf
    second = np.max(excl)
    confidence = float(peak / second) if second > 0 else float("inf")
    return int(lags[k]), confidence


def sync(params: dict, ctx) -> dict:
    from faster_whisper import decode_audio

    ref = params["reference"]
    others = params["others"]
    max_offset = float(params.get("maxOffset", 600))
    for p in [ref, *others]:
        if not os.path.exists(p):
            raise FileNotFoundError(f"Soubor neexistuje: {p}")
        if not _has_audio(p):
            raise ValueError(f"Soubor nemá zvukovou stopu, nelze synchronizovat podle zvuku: {p}")
    out = cache_file("sync", ref, {"others": sorted(others), "max": max_offset})
    if out.exists() and not params.get("force"):
        return read_json(out)

    ctx.progress(0.02, "načítám referenční zvuk")
    ref_env = _onset_envelope(decode_audio(ref, sampling_rate=SR))
    results = []
    for i, p in enumerate(others):
        ctx.check()
        ctx.progress(0.1 + 0.85 * i / len(others), f"synchronizuji {os.path.basename(p)}")
        env = _onset_envelope(decode_audio(p, sampling_rate=SR))
        lag, conf = _offset(ref_env, env, int(max_offset * SR / HOP))
        results.append({
            "path": os.path.abspath(p),
            "offset": round(lag * HOP / SR, 3),
            "confidence": round(conf, 2),
            "reliable": conf >= 1.5,
            "duration": round(len(env) * HOP / SR, 2),
        })
    data = {"reference": os.path.abspath(ref), "note": "offset = čas v referenci, kdy soubor začíná", "results": results}
    write_json(out, data)
    return data


def refine_edges(params: dict, ctx) -> dict:
    """Doladí konce/začátky střihů podle skutečné energie zvuku, ne jen podle časů slov z Whisperu
    (ty mívají u krátkých/tichých hlásek na konci věty systematickou nepřesnost). Pro každý požadovaný
    bod najde v okolí buď konec řeči (hledá dopředu od 'at', kde energie klesne pod práh ticha), nebo
    začátek (hledá zpátky). Nikdy neposune přes 'maxExtend' a nikdy 'proti' směru hledání (jen prodlužuje)."""
    import numpy as np
    from faster_whisper import decode_audio

    path = params["path"]
    points = params["points"]  # [{at, direction: "end"|"start", maxExtend}]
    if not os.path.exists(path):
        raise FileNotFoundError(f"Soubor neexistuje: {path}")
    if not _has_audio(path):
        raise ValueError(f"Soubor nemá zvukovou stopu: {path}")

    audio = decode_audio(path, sampling_rate=SR)
    total = len(audio) / SR
    out = []
    for pt in points:
        at = float(pt["at"])
        direction = pt.get("direction", "end")
        max_extend = float(pt.get("maxExtend", 0.4))
        pad = 0.25
        lo = max(0.0, at - pad)
        hi = min(total, at + max_extend + pad)
        seg = audio[int(lo * SR): int(hi * SR)]
        if len(seg) < SR * 0.05:
            out.append({"at": at, "time": round(at, 3)})
            continue
        env = _energy_envelope(seg)
        if not len(env):
            out.append({"at": at, "time": round(at, 3)})
            continue
        noise_floor = float(np.percentile(env, 20))
        peak = float(np.max(env))
        threshold = max(noise_floor * 2.5, peak * 0.05, 1e-6)
        frame_s = HOP / SR
        at_idx = min(len(env) - 1, max(0, round((at - lo) / frame_s)))
        if direction == "end":
            i = at_idx
            while i < len(env) - 1 and env[i] > threshold:
                i += 1
            refined = lo + i * frame_s
            refined = min(max(refined, at), at + max_extend)
        else:
            i = at_idx
            while i > 0 and env[i] > threshold:
                i -= 1
            refined = lo + i * frame_s
            refined = max(min(refined, at), at - max_extend)
        out.append({"at": at, "time": round(refined, 3)})
    return {"points": out}
