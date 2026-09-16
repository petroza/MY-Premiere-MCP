"""
Prepis mluveneho slova pro MYpremiereMCP.

faster-whisper na GPU, casy u kazdeho slova, VAD, slovnik oprav
(stejny format jako v PZ_AI_DAB_ALL: "chybne = spravne") a volitelne
prirazeni mluvcich podle hlasitosti na oddelenych mikrofonnich stopach.

Vystup (JSON):
  {source, duration, language, model, device, speakers,
   segments: [{id, start, end, text, speaker?, words: [{w, s, e, p, spk?}]}]}

Prubeh se hlasi na stderr radky "PROGRESS 0.420 zprava".
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

try:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PUNCT_END = (".", "!", "?", "…")


def _add_nvidia_dll_dirs() -> None:
    """cuBLAS/cuDNN z pip balicku nvidia-* nejsou v PATH - CTranslate2 je jinak nenajde."""
    if os.name != "nt":
        return
    import site

    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    for root in roots:
        nv = Path(root) / "nvidia"
        if not nv.is_dir():
            continue
        for bin_dir in nv.glob("*/bin"):
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError:
                pass
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def progress(p: float, msg: str = "") -> None:
    print(f"PROGRESS {max(0.0, min(1.0, p)):.3f} {msg}", file=sys.stderr, flush=True)


def load_corrections(path: str | None):
    rules = []
    if not path or not os.path.exists(path):
        return rules
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        wrong, right = (x.strip() for x in line.split("=", 1))
        if wrong and right:
            rx = re.compile(r"(?<!\w)" + re.escape(wrong) + r"(?!\w)", re.IGNORECASE)
            rules.append((rx, right))
    return rules


def load_model(name: str, device: str, compute: str):
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(name, device=device, compute_type=compute), device
    except Exception as e:  # noqa: BLE001
        if device == "cpu":
            raise
        log(f"Model na {device} selhal ({e}); zkousim CPU int8")
        return WhisperModel(name, device="cpu", compute_type="int8"), "cpu"


def run_asr(model, args) -> tuple[list[dict], object]:
    segments, info = model.transcribe(
        args.input,
        language=args.language or None,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=args.beam_size,
        condition_on_previous_text=False,
        initial_prompt=args.prompt or None,
    )
    duration = float(info.duration or 0.0)
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            token = (w.word or "").strip()
            if token:
                words.append({
                    "w": token,
                    "s": round(float(w.start), 3),
                    "e": round(float(w.end), 3),
                    "p": round(float(w.probability), 3),
                })
        if duration:
            progress(0.05 + 0.85 * min(1.0, seg.end / duration), f"{seg.end:.0f}/{duration:.0f} s")
    return words, info


def attribute_speakers(words: list[dict], tracks: list[dict]) -> None:
    """Kazdemu slovu priradi mluvciho s nejvetsi energii na jeho mikrofonu."""
    import numpy as np
    from faster_whisper import decode_audio

    sr = 16000
    audio = []
    for i, t in enumerate(tracks):
        progress(0.9 + 0.05 * i / max(1, len(tracks)), f"nacitam stopu {t['name']}")
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
        # hystereze: kdyz jsou mikrofony skoro stejne hlasite, drz predchoziho mluvciho
        if prev and len(energies) > 1 and energies[1][0] > 0 and energies[0][0] / energies[1][0] < 1.3:
            best = prev
        w["spk"] = best
        prev = best

    # vyhlazeni: osamocene slovo jineho mluvciho prevezme mluvciho okoli
    for i in range(1, len(words) - 1):
        if words[i - 1]["spk"] == words[i + 1]["spk"] != words[i]["spk"]:
            words[i]["spk"] = words[i - 1]["spk"]


def group_segments(words: list[dict], max_dur: float = 20.0, max_gap: float = 0.9) -> list[dict]:
    """Slova -> vety/promluvy vhodne pro strih (konec vety, pauza, zmena mluvciho)."""
    segs: list[dict] = []
    cur: list[dict] = []

    def flush() -> None:
        if not cur:
            return
        text = re.sub(r"\s+([,.;:!?…])", r"\1", " ".join(x["w"] for x in cur)).strip()
        seg = {"id": len(segs) + 1, "start": cur[0]["s"], "end": cur[-1]["e"], "text": text}
        if "spk" in cur[0]:
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute", default="float16")
    ap.add_argument("--language", default="cs")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--corrections", default=None)
    ap.add_argument("--prompt", default=None, help="kontext/jmena pro Whisper (initial_prompt)")
    ap.add_argument("--speakers", default=None, help="JSON soubor: [{name, path, offset}]")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        log(f"Soubor neexistuje: {args.input}")
        return 2

    t0 = time.time()
    progress(0.01, f"nacitam model {args.model}")
    model, device = load_model(args.model, args.device, args.compute)
    progress(0.04, f"prepisuji ({device})")
    try:
        words, info = run_asr(model, args)
    except Exception as e:  # noqa: BLE001
        if device == "cpu":
            raise
        log(f"Prepis na GPU selhal ({e}); opakuji na CPU")
        model, device = load_model(args.model, "cpu", "int8")
        words, info = run_asr(model, args)

    rules = load_corrections(args.corrections)
    if rules:
        for w in words:
            for rx, right in rules:
                w["w"] = rx.sub(right, w["w"])

    speakers = None
    if args.speakers:
        tracks = json.loads(Path(args.speakers).read_text(encoding="utf-8"))
        if tracks:
            attribute_speakers(words, tracks)
            speakers = [t["name"] for t in tracks]

    segments = group_segments(words)
    result = {
        "version": 1,
        "source": os.path.abspath(args.input),
        "duration": round(float(info.duration or 0.0), 3),
        "language": getattr(info, "language", args.language),
        "languageProbability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
        "model": args.model,
        "device": device,
        "speakers": speakers,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "elapsedSec": round(time.time() - t0, 1),
        "wordCount": len(words),
        "segments": segments,
    }
    tmp = args.out + ".tmp"
    Path(tmp).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, args.out)
    progress(1.0, f"hotovo: {len(segments)} segmentu, {len(words)} slov")
    return 0


if __name__ == "__main__":
    sys.exit(main())
