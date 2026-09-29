"""Diarizace (kdo kdy mluví).

Výchozí metoda "chunks" (když existuje přepis): hlasové otisky kousků vět (~2,5 s) modelem 3D-Speaker CAM++
a vlastní shlukování (sférický k-means + aglomerace podle kosinové podobnosti). Na skutečném záznamu
z místnosti je výrazně přesnější a ~15× rychlejší než plná sherpa-onnx pipeline (pyannote segmentace),
která zůstává jako záloha pro zvuk bez přepisu (method="sherpa").
"""
from __future__ import annotations

import os
import time

import numpy as np

from . import asr
from .common import CONFIG, ROOT, cache_file, index_get, index_set, log, model_path, read_json, write_json

SR = 16000


# ------------------------------------------------------------------ knihovna hlasů (kdo je kdo)

def _library_path():
    return ROOT / CONFIG.get("diarization", {}).get("voiceLibrary", "models/voices/library.json")


def load_voices() -> list[dict]:
    try:
        return read_json(_library_path()).get("voices", [])
    except (OSError, ValueError):
        return []


def save_voices(voices: list[dict]) -> None:
    write_json(_library_path(), {"version": 1, "voices": voices})


def upsert_voice(name: str, vec: list[float], source: str = "") -> None:
    """Uloží/zprůměruje hlasový otisk pod jménem – příště se mluvčí pozná sám."""
    voices = load_voices()
    a = np.asarray(vec, dtype="float32")
    for v in voices:
        if v["name"].casefold() == name.casefold():
            b = np.asarray(v["vec"], dtype="float32")
            n = int(v.get("n", 1))
            merged = (b * n + a) / (n + 1)
            merged = merged / (np.linalg.norm(merged) + 1e-9)
            v.update(vec=[round(float(x), 5) for x in merged], n=n + 1, updated=time.strftime("%Y-%m-%d"))
            if source and source not in v.get("sources", []):
                v.setdefault("sources", []).append(source)
            break
    else:
        voices.append({"name": name, "vec": [round(float(x), 5) for x in a], "n": 1,
                       "updated": time.strftime("%Y-%m-%d"), "sources": [source] if source else []})
    save_voices(voices)
    log(f"Knihovna hlasů: uložen otisk „{name}“")


def _match_voices(centroids: dict[str, list[float]], threshold: float) -> dict[str, str]:
    """Přiřadí shlukům jména z knihovny (nejpodobnější dvojice první, každé jméno jen jednou)."""
    lib = load_voices()
    if not lib or not centroids:
        return {}
    pairs = []
    for spk, vec in centroids.items():
        a = np.asarray(vec, dtype="float32")
        for entry in lib:
            b = np.asarray(entry["vec"], dtype="float32")
            pairs.append((float(a @ b), spk, entry["name"]))
    pairs.sort(key=lambda p: -p[0])
    used_spk, used_name, mapping = set(), set(), {}
    for score, spk, name in pairs:
        if score < threshold or spk in used_spk or name in used_name:
            continue
        mapping[spk] = name
        used_spk.add(spk)
        used_name.add(name)
    return mapping


# ------------------------------------------------------------------ metoda "chunks"

def _chunks(tr: dict, max_len: float = 2.5, min_len: float = 0.6) -> list[list]:
    """Kousky vět [start, end, index_věty]; krátký zbytek se připojí k předchozímu kousku téže věty."""
    out: list[list] = []
    for si, s in enumerate(tr["segments"]):
        cur = []
        for w in s.get("words", []):
            cur.append(w)
            if cur[-1]["e"] - cur[0]["s"] >= max_len:
                out.append([cur[0]["s"], cur[-1]["e"], si])
                cur = []
        if cur:
            if cur[-1]["e"] - cur[0]["s"] < min_len and out and out[-1][2] == si:
                out[-1][1] = cur[-1]["e"]
            else:
                out.append([cur[0]["s"], cur[-1]["e"], si])
    return out


def _embed(samples: np.ndarray, chunks: list[list], ctx) -> np.ndarray:
    import sherpa_onnx

    threads = int(CONFIG.get("diarization", {}).get("threads", 6))
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(model_path("embedding")), num_threads=threads, provider="cpu"))
    embs = []
    total = len(samples) / SR
    for i, (a, b, _) in enumerate(chunks):
        if i % 50 == 0:
            ctx.progress(0.05 + 0.8 * i / len(chunks), f"hlasové otisky {i}/{len(chunks)}")
        mid, half = (a + b) / 2, max((b - a) / 2, 0.75)  # aspoň 1,5 s zvuku
        st = ex.create_stream()
        st.accept_waveform(SR, samples[int(max(0.0, mid - half) * SR): int(min(total, mid + half) * SR)])
        st.input_finished()
        v = np.asarray(ex.compute(st), dtype="float32")
        embs.append(v / (np.linalg.norm(v) + 1e-9))
    return np.stack(embs)


def _spherical_kmeans(E: np.ndarray, k: int, iters: int = 30, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = len(E)
    C = [E[rng.integers(n)]]
    for _ in range(1, k):
        d = np.clip(1 - np.max(E @ np.array(C).T, axis=1), 0, None) ** 2
        C.append(E[rng.choice(n, p=d / d.sum())] if d.sum() > 0 else E[rng.integers(n)])
    C = np.array(C)
    for _ in range(iters):
        lab = np.argmax(E @ C.T, axis=1)
        for j in range(k):
            m = E[lab == j]
            if len(m):
                c = m.sum(0)
                C[j] = c / np.linalg.norm(c)
    return np.argmax(E @ C.T, axis=1)


def _cluster(E: np.ndarray, durs: np.ndarray, sim_th: float, n_speakers: int | None, min_speech: float = 4.0) -> np.ndarray:
    lab = _spherical_kmeans(E, min(48, len(E)))
    groups = [np.where(lab == j)[0] for j in range(lab.max() + 1) if (lab == j).any()]
    sums = [E[g].sum(0) for g in groups]

    def normed():
        return np.array([s / np.linalg.norm(s) for s in sums])

    while len(groups) > 1:
        S = normed() @ normed().T
        np.fill_diagonal(S, -1)
        i, j = np.unravel_index(np.argmax(S), S.shape)
        if (n_speakers is not None and len(groups) <= n_speakers) or (n_speakers is None and S[i, j] < sim_th):
            break
        groups[i] = np.concatenate([groups[i], groups[j]])
        sums[i] = sums[i] + sums[j]
        del groups[j], sums[j]

    if n_speakers is None:  # drobné shluky (šum, smích, odkašlání) přiřaď nejpodobnějšímu mluvčímu
        while len(groups) > 1:
            small = [gi for gi, g in enumerate(groups) if durs[g].sum() < min_speech]
            if not small:
                break
            gi = small[0]
            N = normed()
            sims = N @ N[gi]
            sims[gi] = -1
            j = int(np.argmax(sims))
            groups[j] = np.concatenate([groups[j], groups[gi]])
            sums[j] = sums[j] + sums[gi]
            del groups[gi], sums[gi]

    labels = np.empty(len(E), int)
    for gi, g in enumerate(groups):
        labels[g] = gi
    return labels


def _smooth(chunks: list[list], labels: np.ndarray, durs: np.ndarray) -> None:
    by_seg: dict[int, list[int]] = {}
    for i, c in enumerate(chunks):
        by_seg.setdefault(c[2], []).append(i)
    for idxs in by_seg.values():
        if len(idxs) == 2:
            best = max(idxs, key=lambda i: durs[i])
            labels[idxs] = labels[best]
        for k in range(1, len(idxs) - 1):
            a, b, c = idxs[k - 1], idxs[k], idxs[k + 1]
            if labels[a] == labels[c] != labels[b]:
                labels[b] = labels[a]


def _diarize_chunks(src: str, tr_file, num: int | None, sim: float, ctx) -> dict:
    from faster_whisper import decode_audio

    t0 = time.time()
    tr = read_json(tr_file)
    ctx.progress(0.02, "načítám zvuk")
    samples = decode_audio(src, sampling_rate=SR)
    chunks = _chunks(tr)
    if not chunks:
        raise RuntimeError("Přepis neobsahuje slova s časy.")
    E = _embed(samples, chunks, ctx)
    ctx.check()
    durs = np.array([c[1] - c[0] for c in chunks])
    ctx.progress(0.9, "shlukuji hlasy")
    labels = _cluster(E, durs, sim, num)
    _smooth(chunks, labels, durs)
    # pojmenování S1, S2… podle celkového času řeči
    order = sorted(set(labels.tolist()), key=lambda k: -durs[labels == k].sum())
    name = {k: f"S{r + 1}" for r, k in enumerate(order)}
    turns: list[dict] = []
    for (a, b, _), lab in zip(chunks, labels):
        spk = name[int(lab)]
        if turns and turns[-1]["speaker"] == spk and a - turns[-1]["end"] < 1.0:
            turns[-1]["end"] = round(b, 3)
        else:
            turns.append({"start": round(a, 3), "end": round(b, 3), "speaker": spk})
    # průměrný hlasový otisk mluvčího – porovná se s knihovnou hlasů a uloží pro pozdější pojmenování
    centroids: dict[str, list[float]] = {}
    for lab in sorted(set(labels.tolist())):
        v = E[labels == lab].mean(axis=0)
        v = v / (np.linalg.norm(v) + 1e-9)
        centroids[name[int(lab)]] = [round(float(x), 5) for x in v]
    matched = _match_voices(centroids, float(CONFIG.get("diarization", {}).get("voiceMatch", 0.55)))
    if matched:
        log(f"Knihovna hlasů: rozpoznáno {matched}")
        for t in turns:
            t["speaker"] = matched.get(t["speaker"], t["speaker"])
        centroids = {matched.get(k, k): v for k, v in centroids.items()}

    stats: dict[str, float] = {}
    for t in turns:
        stats[t["speaker"]] = stats.get(t["speaker"], 0.0) + t["end"] - t["start"]
    return {
        "source": os.path.abspath(src),
        "method": "chunks",
        "centroids": centroids,
        "matchedVoices": matched,
        "model": CONFIG["models"]["embedding"],
        "duration": round(len(samples) / SR, 3),
        "numSpeakers": len(stats),
        "speakingTime": {k: round(v, 1) for k, v in sorted(stats.items(), key=lambda kv: -kv[1])},
        "elapsedSec": round(time.time() - t0, 1),
        "turns": turns,
    }


# ------------------------------------------------------------------ metoda "sherpa" (bez přepisu)

def _diarize_sherpa(src: str, num: int | None, threshold: float, ctx) -> dict:
    import sherpa_onnx
    from faster_whisper import decode_audio

    seg_model, emb_model = model_path("segmentation"), model_path("embedding")
    for m in (seg_model, emb_model):
        if not m.exists():
            raise RuntimeError(f"Chybí model diarizace: {m}")
    threads = int(CONFIG.get("diarization", {}).get("threads", 6))
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg_model)),
            num_threads=threads,
            provider="cpu",
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb_model), num_threads=threads, provider="cpu"),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num or -1, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Neplatná konfigurace diarizace (zkontroluj modely v models/diarization)")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    t0 = time.time()
    ctx.progress(0.02, "načítám zvuk")
    samples = decode_audio(src, sampling_rate=sd.sample_rate)

    def callback(done, total):
        ctx.progress(0.05 + 0.9 * done / max(1, total), f"diarizace {done}/{total}")
        return 1 if ctx.cancelled else 0

    result = sd.process(samples, callback=callback).sort_by_start_time()
    ctx.check()
    turns = [{"start": round(r.start, 3), "end": round(r.end, 3), "speaker": f"S{r.speaker + 1}"} for r in result]
    stats: dict[str, float] = {}
    for t in turns:
        stats[t["speaker"]] = stats.get(t["speaker"], 0.0) + t["end"] - t["start"]
    return {
        "source": os.path.abspath(src),
        "method": "sherpa",
        "duration": round(len(samples) / sd.sample_rate, 3),
        "numSpeakers": len(stats),
        "speakingTime": {k: round(v, 1) for k, v in sorted(stats.items())},
        "elapsedSec": round(time.time() - t0, 1),
        "turns": turns,
    }


# ------------------------------------------------------------------ úlohy Workeru

def diarize(params: dict, ctx) -> dict:
    src = params["path"]
    if not os.path.exists(src):
        raise FileNotFoundError(f"Soubor neexistuje: {src}")
    dcfg = CONFIG.get("diarization", {})
    num = int(params.get("numSpeakers") or 0) or None
    tr_file = asr.find_transcript(src)
    method = params.get("method") or ("chunks" if tr_file else "sherpa")
    if method == "chunks" and not tr_file:
        raise RuntimeError("Metoda chunks potřebuje přepis – nejdřív transcribe_media (nebo method=sherpa).")
    sim = float(params.get("similarity") or dcfg.get("similarity", 0.55))
    threshold = float(params.get("threshold") or dcfg.get("threshold", 0.5))
    key = {"m": method, "n": num, "emb": CONFIG["models"]["embedding"]}
    key.update({"sim": sim, "tr": str(tr_file)} if method == "chunks" else {"th": threshold})
    out = cache_file("diarization", src, key)

    if out.exists() and not params.get("force"):
        data = read_json(out)
    else:
        data = _diarize_chunks(src, tr_file, num, sim, ctx) if method == "chunks" else _diarize_sherpa(src, num, threshold, ctx)
        write_json(out, data)
    index_set("diarization", src, out)

    merged = False
    if tr_file and params.get("applyToTranscript", True):
        asr.apply_speaker_turns(tr_file, data["turns"], "diarization")
        merged = True
    return {"file": str(out), "method": data.get("method"), "transcript": str(tr_file) if tr_file else None,
            "mergedIntoTranscript": merged, "numSpeakers": data["numSpeakers"], "speakingTime": data["speakingTime"],
            "elapsedSec": data.get("elapsedSec")}


def list_voices(params: dict, ctx) -> dict:
    return {"voices": [{k: v.get(k) for k in ("name", "n", "updated", "sources")} for v in load_voices()],
            "file": str(_library_path())}


def forget_voice(params: dict, ctx) -> dict:
    name = params["name"]
    voices = load_voices()
    left = [v for v in voices if v["name"].casefold() != name.casefold()]
    save_voices(left)
    return {"removed": len(voices) - len(left), "remaining": [v["name"] for v in left]}


def rename_speakers(params: dict, ctx) -> dict:
    """Přejmenuje S1/S2… na jména v přepisu i diarizaci; zároveň si zapamatuje hlas (enroll)."""
    mapping = params["mapping"]
    enroll = params.get("enroll", True)
    changed: list[str] = []
    enrolled: list[str] = []
    for kind in ("transcripts", "diarization"):
        f = index_get(kind, params["path"])
        if not f:
            continue
        data = read_json(f)
        if kind == "transcripts":
            for s in data["segments"]:
                if s.get("speaker") in mapping:
                    s["speaker"] = mapping[s["speaker"]]
                for wd in s.get("words", []):
                    if wd.get("spk") in mapping:
                        wd["spk"] = mapping[wd["spk"]]
            if data.get("speakers"):
                data["speakers"] = [mapping.get(x, x) for x in data["speakers"]]
        else:
            for t in data["turns"]:
                t["speaker"] = mapping.get(t["speaker"], t["speaker"])
            data["speakingTime"] = {mapping.get(k, k): v for k, v in data["speakingTime"].items()}
            cents = data.get("centroids") or {}
            if cents:
                data["centroids"] = {mapping.get(k, k): v for k, v in cents.items()}
                if enroll:
                    for old, new in mapping.items():
                        vec = data["centroids"].get(new) or cents.get(old)
                        if vec:
                            upsert_voice(new, vec, os.path.basename(params["path"]))
                            enrolled.append(new)
        write_json(f, data)
        changed.append(str(f))
    return {"changed": changed, "enrolled": enrolled,
            "note": "Uložené hlasy se příště rozpoznají samy (diarize_media). Seznam: list_voices."}
