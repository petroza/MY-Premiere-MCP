"""Přepis (faster-whisper) s časy slov, slovníkem oprav a přiřazením mluvčích."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from . import gpu
from .common import CONFIG, ROOT, Cancelled, cache_file, index_get, index_set, log, read_json, write_json

PUNCT_END = (".", "!", "?", "…")


def load_corrections():
    path = ROOT / CONFIG.get("correctionsFile", "corrections.txt")
    rules = []
    if not path.exists():
        return rules
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        wrong, right = (x.strip() for x in line.split("=", 1))
        if wrong and right:
            rules.append((re.compile(r"(?<!\w)" + re.escape(wrong) + r"(?!\w)", re.IGNORECASE), right))
    return rules


def group_segments(words: list[dict], max_dur: float = 20.0, max_gap: float = 0.9) -> list[dict]:
    """Slova -> věty/promluvy (konec věty, pauza, změna mluvčího)."""
    segs: list[dict] = []
    cur: list[dict] = []

    def flush() -> None:
        if not cur:
            return
        text = re.sub(r"\s+([,.;:!?…])", r"\1", " ".join(x["w"] for x in cur)).strip()
        seg = {"id": len(segs) + 1, "start": cur[0]["s"], "end": cur[-1]["e"], "text": text}
        if cur[0].get("spk"):
            seg["speaker"] = cur[0]["spk"]
        seg["words"] = [dict(x) for x in cur]
        segs.append(seg)
        cur.clear()

    for w in words:
        if cur:
            gap = w["s"] - cur[-1]["e"]
            if gap > max_gap or w["e"] - cur[0]["s"] > max_dur or w.get("spk") != cur[-1].get("spk"):
                flush()
        cur.append(w)
        if w["w"].endswith(PUNCT_END) and (w["e"] - cur[0]["s"]) >= 1.2:
            flush()
    flush()
    return segs


def smooth_speakers(words: list[dict]) -> None:
    for i in range(1, len(words) - 1):
        if words[i - 1].get("spk") == words[i + 1].get("spk") != words[i].get("spk"):
            words[i]["spk"] = words[i - 1]["spk"]


def _ends_sentence(w: dict) -> bool:
    return w["w"].rstrip().endswith(PUNCT_END)


def attach_boundary_words(words: list[dict], max_words: int = 2) -> None:
    """Hranice z diarizace jsou nepřesné o slovo či dvě. Časy slov z Whisperu na předělu taky,
    proto rozhoduje hlavně interpunkce:
      - "…podle sebe. A | dá se…": slova za koncem věty na konci úseku patří dalšímu mluvčímu,
      - "…to je | pravda. Když…": slova dokončující větu na začátku úseku patří předchozímu.
    Osamocený krátký úsek bez interpunkce připadne bližšímu sousedovi podle časové mezery."""
    for b in range(1, len(words)):
        x, y = words[b - 1].get("spk"), words[b].get("spk")
        if x == y:
            continue
        # konec úseku X: najdi poslední konec věty v posledních max_words+1 slovech
        for k in range(1, max_words + 1):
            i = b - k
            if i - 1 < 0 or words[i - 1].get("spk") != x:
                break
            tail = words[i:b]
            if _ends_sentence(words[i - 1]) and not any(_ends_sentence(w) for w in tail):
                for w in tail:
                    w["spk"] = y
                break
        else:
            # začátek úseku Y: slova, která dokončují větu X
            for k in range(1, max_words + 1):
                j = b + k - 1
                if j >= len(words) or words[j].get("spk") != y:
                    break
                if _ends_sentence(words[j]) and not _ends_sentence(words[b - 1]):
                    for w in words[b: j + 1]:
                        w["spk"] = x
                    break

    i = 0
    while i < len(words):
        j = i
        while j + 1 < len(words) and words[j + 1].get("spk") == words[i].get("spk"):
            j += 1
        if 0 < i and j + 1 < len(words) and (j - i + 1) <= max_words:
            prev_w, next_w = words[i - 1], words[j + 1]
            if prev_w.get("spk") != words[i].get("spk") or next_w.get("spk") != words[i].get("spk"):
                gap_prev = words[i]["s"] - prev_w["e"]
                gap_next = next_w["s"] - words[j]["e"]
                target = prev_w["spk"] if gap_prev < gap_next else next_w["spk"]
                for k in range(i, j + 1):
                    words[k]["spk"] = target
        i = j + 1


def attribute_by_mics(words: list[dict], tracks: list[dict], progress) -> list[str]:
    """Každé slovo dostane mluvčího s nejvyšší energií na jeho mikrofonu (s hysterezí)."""
    import numpy as np
    from faster_whisper import decode_audio

    sr = 16000
    audio = []
    for i, t in enumerate(tracks):
        progress(0.9 + 0.05 * i / max(1, len(tracks)), f"načítám mikrofon {t['name']}")
        audio.append((t["name"], decode_audio(t["path"], sampling_rate=sr), float(t.get("offset", 0.0))))
    prev = None
    for w in words:
        energies = []
        for name, x, off in audio:
            a = int(max(0.0, w["s"] - off) * sr)
            b = max(a + 1, int(max(0.0, w["e"] - off) * sr))
            chunk = x[a:b]
            e = float(np.sqrt(np.mean(np.square(chunk, dtype="float64")))) if chunk.size else 0.0
            energies.append((e, name))
        energies.sort(reverse=True)
        best = energies[0][1]
        if prev and len(energies) > 1 and energies[1][0] > 0 and energies[0][0] / energies[1][0] < 1.3:
            best = prev
        w["spk"] = best
        prev = best
    smooth_speakers(words)
    attach_boundary_words(words)
    return [t["name"] for t in tracks]


def _probe_language(model, src: str, samples: int = 4, secs: float = 30.0) -> dict | None:
    """Převažující jazyk řeči: detekce na několika 30s ukázkách z celé délky (10–85 %, úvodní titulky a hudbu
    přeskočí), většinovým hlasováním. None, když ukázky nejdou načíst."""
    import av
    import numpy as np

    try:
        with av.open(src) as c:
            dur = float(c.duration / av.time_base) if c.duration else 0.0
        if dur <= 0:
            return None
        votes: dict[str, float] = {}
        starts = [dur * (0.10 + 0.75 * i / max(1, samples - 1)) for i in range(samples)] if dur > secs * 2 else [0.0]
        for t in starts:
            with av.open(src) as c:
                a = c.streams.audio[0]
                c.seek(int(t / a.time_base), stream=a)
                rs = av.AudioResampler(format="flt", layout="mono", rate=16000)
                buf: list = []
                got = 0
                for fr in c.decode(a):
                    for o in rs.resample(fr):
                        arr = o.to_ndarray().reshape(-1)
                        buf.append(arr)
                        got += arr.size
                    if got >= secs * 16000:
                        break
            if not buf:
                continue
            audio = np.concatenate(buf)[: int(secs * 16000)].astype("float32")
            try:
                lang, prob, _ = model.detect_language(audio, vad_filter=True)
            except Exception:  # noqa: BLE001 – ukázka bez řeči (hudba, titulky) – přeskočit
                continue
            votes[lang] = votes.get(lang, 0.0) + float(prob)
        if not votes:
            return None
        best = max(votes, key=votes.get)
        return {"language": best, "votes": {k: round(v, 2) for k, v in sorted(votes.items(), key=lambda kv: -kv[1])}}
    except Exception as e:  # noqa: BLE001 – detekce je jen pojistka, přepis poběží s výchozím jazykem
        log(f"asr: detekce jazyka selhala ({e}) – ponechávám výchozí jazyk")
        return None


def transcribe(params: dict, ctx) -> dict:
    src = params["path"]
    if not os.path.exists(src):
        raise FileNotFoundError(f"Soubor neexistuje: {src}")
    w = CONFIG["whisper"]
    opts = {
        "model": params.get("model") or w["model"],
        "language": params.get("language", w["language"]) or None,
        "prompt": params.get("prompt") or None,
        "speakers": params.get("speakerTracks") or None,
    }
    if opts["language"] is None:
        opts["multilingual"] = True  # nový klíč cache: starší automatický přepis byl celý v jednom jazyce
    # Přepis už existuje a agent nechce výslovně jiný model/jazyk/mikrofony -> vrať ho. Jinak by samotný jiný
    # `prompt` (agent ho posílá "pro jistotu") spustil nový přepis celého videa (42 min ~ 5 min), přepnul index
    # na přepis bez diarizace a změnil číslování vět – rozbil by hotové osnovy, plány i jména mluvčích.
    explicit = (params.get("model") or params.get("speakerTracks")
                or params.get("language", w["language"]) != w["language"])
    existing = index_get("transcripts", src)
    if existing and existing.exists() and not params.get("force") and not explicit:
        return {"file": str(existing), "cached": True}
    t0 = time.time()
    ctx.progress(0.01, f"načítám Whisper {opts['model']}")
    model, device = gpu.whisper(opts["model"])
    probe = None
    if "language" not in params and opts["language"]:
        # Jazyk nikdo nezadal -> výchozí z configu (cs) jen tehdy, když materiál opravdu je v něm. Anglický film
        # s vynucenou češtinou Whisper „přeložil“: Robin Hood 2 h = 1857 slov nesmyslů, Gummo, Putin (2026-09-28/29).
        # Jinak rozpoznávání po úsecích (i smíšený materiál: ukrajinský dokument s anglickým vypravěčem).
        probe = _probe_language(model, src)
        if probe and probe["language"] != opts["language"]:
            log(f"asr: {os.path.basename(src)} – převažuje jazyk {probe['language']} ({probe['votes']}), "
                f"ne {opts['language']} -> rozpoznávání jazyka po úsecích")
            opts["language"] = None
            opts["multilingual"] = True
    out = cache_file("transcripts", src, opts)
    if out.exists() and not params.get("force"):
        index_set("transcripts", src, out)
        return {"file": str(out), "cached": True}
    ctx.progress(0.03, "přepisuji")
    ctx.progress(0.04, f"přepisuji ({device})")
    # automatický jazyk = zjišťovat pro každý úsek zvlášť: jinak Whisper podle prvních 30 s určí jeden jazyk pro
    # celý soubor a zbytek do něj "přeloží" (film EN+UK s ruským úvodem dal i anglického vypravěče rusky)
    common = dict(language=opts["language"], word_timestamps=True, vad_filter=True,
                  vad_parameters={"min_silence_duration_ms": 400}, beam_size=w.get("beamSize", 5),
                  initial_prompt=opts["prompt"], multilingual=opts["language"] is None)
    batch = int(w.get("batchSize", 8) or 0)
    if device == "cuda" and batch > 1:
        # dávkově: úseky řeči (VAD) jdou na GPU po několika najednou – změřeno na 10 min debaty 3,8× rychleji
        # (68 s -> 18 s), přesnost textu i časů slov stejná (průměr 25 ms). Dávka 16 byla vedle Hermese pomalejší
        # (nevejde se do VRAM). Věty se skládají ze slov (group_segments), dělení segmentů Whisperem nevadí.
        from faster_whisper import BatchedInferencePipeline
        segments, info = BatchedInferencePipeline(model).transcribe(src, batch_size=batch, **common)
    else:
        segments, info = model.transcribe(src, condition_on_previous_text=False, **common)
    duration = float(info.duration or 0.0)
    words: list[dict] = []
    for seg in segments:
        ctx.check()
        for wd in seg.words or []:
            token = (wd.word or "").strip()
            if token:
                words.append({"w": token, "s": round(float(wd.start), 3), "e": round(float(wd.end), 3), "p": round(float(wd.probability), 3)})
        if duration:
            ctx.progress(0.05 + 0.85 * min(1.0, seg.end / duration), f"přepis {seg.end:.0f}/{duration:.0f} s")

    rules = load_corrections()
    for wd in words:
        for rx, right in rules:
            wd["w"] = rx.sub(right, wd["w"])

    speakers = None
    if opts["speakers"]:
        speakers = attribute_by_mics(words, opts["speakers"], ctx.progress)

    result = {
        "version": 2,
        "source": os.path.abspath(src),
        "duration": round(duration, 3),
        "language": getattr(info, "language", opts["language"]),
        "multilingual": bool(opts.get("multilingual")),
        "model": opts["model"],
        "device": device,
        "speakers": speakers,
        "speakerSource": "mics" if speakers else None,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsedSec": round(time.time() - t0, 1),
        "wordCount": len(words),
        "segments": group_segments(words),
    }
    write_json(out, result)
    index_set("transcripts", src, out)
    return {"file": str(out), "cached": False}


def apply_speaker_turns(transcript_file: Path, turns: list[dict], label_source: str) -> dict:
    """Přiřadí slovům mluvčí z diarizace (největší překryv) a znovu rozdělí věty."""
    tr = read_json(transcript_file)
    words = [dict(wd) for s in tr["segments"] for wd in s.get("words", [])]
    ti = 0
    prev = None
    for wd in words:
        while ti < len(turns) and turns[ti]["end"] < wd["s"] - 1.0:
            ti += 1
        best, best_ov = None, 0.0
        for t in turns[ti: ti + 8]:
            ov = min(wd["e"], t["end"]) - max(wd["s"], t["start"])
            if ov > best_ov:
                best, best_ov = t["speaker"], ov
        if best is None:
            near = min(turns, key=lambda t: min(abs(t["start"] - wd["e"]), abs(t["end"] - wd["s"])), default=None)
            best = near["speaker"] if near and min(abs(near["start"] - wd["e"]), abs(near["end"] - wd["s"])) < 0.6 else prev
        wd["spk"] = best or prev or "S1"
        prev = wd["spk"]
    smooth_speakers(words)
    attach_boundary_words(words)
    tr["segments"] = group_segments(words)
    tr["speakers"] = sorted({wd["spk"] for wd in words})
    tr["speakerSource"] = label_source
    write_json(transcript_file, tr)
    return tr


def find_transcript(path: str) -> Path | None:
    return index_get("transcripts", path)


def ensure_cancel_safe(ctx) -> None:
    if ctx.cancelled:
        raise Cancelled()
