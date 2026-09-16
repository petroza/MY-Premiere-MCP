"""Dlouhý testovací rozhovor na 3 kamery (výchozí 60 min) pro zátěžový test.

Odpovědi = skutečné věty z přepsaných WINREC mikrofonů (Petr), otázky = český TTS hlas (Moderátor).
16 kHz zvuk (šetří paměť), kamery 1280x720/25p s nízkým bitrate, známý správný výsledek v gt.json.
Spouštět: py -3.11 scripts/make_long_test.py [minuty]
"""
from __future__ import annotations

import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from faster_whisper import decode_audio

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "long"
FF = r"C:\Program Files\Shutter Encoder\Library\ffmpeg.exe"
SR = 16000
MINUTES = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0

QUESTIONS = [
    "Dobrý den, vítejte u dnešního rozhovoru. Můžete se na úvod krátce představit?",
    "Jak jste se k této práci vlastně dostal?",
    "Můžete to trochu rozvést?",
    "A jak to funguje v praxi?",
    "Co je na tom nejtěžší?",
    "Na jakém hardwaru to celé běží?",
    "Kolik času vám to ušetří?",
    "Dá se to použít i v menším studiu?",
    "Jaké máte zkušenosti s umělou inteligencí ve střižně?",
    "Co byste doporučil začátečníkům?",
    "Setkal jste se s nějakými problémy?",
    "Jak na to reagují kolegové?",
    "Kam se podle vás tahle technologie posune?",
    "Je to drahé?",
    "Dá se to propojit s dalšími programy?",
    "Jak dlouho trvá, než se to člověk naučí?",
    "Co vás na tom nejvíc baví?",
    "Máte nějaký konkrétní příklad?",
    "A co bezpečnost dat?",
    "Pracujete na tom sám, nebo v týmu?",
]
CAMERAS = [
    {"file": "cam_wide.mp4", "label": "KAMERA 1 - CELEK", "color": "0x2a3b4c", "offset": -3.0, "speakers": [], "role": "wide"},
    {"file": "cam_petr.mp4", "label": "KAMERA 2 - PETR detail", "color": "0x3c5a2a", "offset": 2.4, "speakers": ["Petr"], "role": "close"},
    {"file": "cam_moderator.mp4", "label": "KAMERA 3 - MODERATOR detail", "color": "0x5a2a3c", "offset": -1.1, "speakers": ["Moderátor"], "role": "close"},
]


def rms_norm(x: np.ndarray, target: float = 0.08) -> np.ndarray:
    r = float(np.sqrt(np.mean(x * x))) or 1.0
    return np.clip(x * (target / r), -1, 1).astype("float32")


def write_wav(path: Path, x: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def answer_blocks() -> list[np.ndarray]:
    idx = json.loads((ROOT / "cache" / "transcripts" / "index.json").read_text(encoding="utf-8"))
    blocks = []
    for key, f in idx.items():
        if "winrec" not in key or not key.endswith("_mikrofon.wav"):
            continue
        tr = json.loads(Path(f).read_text(encoding="utf-8"))
        if tr.get("speakerSource"):
            continue
        audio = decode_audio(tr["source"], sampling_rate=SR)
        cur, cur_len = [], 0.0
        for s in tr["segments"]:
            if s["end"] - s["start"] < 0.8:
                continue
            cur.append(s)
            cur_len += s["end"] - s["start"]
            if cur_len >= 18 or (cur_len >= 8 and s["text"].rstrip().endswith((".", "?", "!"))):
                parts = [audio[int(max(0, x["start"] - 0.1) * SR): int((x["end"] + 0.15) * SR)] for x in cur]
                gap = np.zeros(int(0.35 * SR), dtype="float32")
                joined = np.concatenate([np.concatenate([p, gap]) for p in parts])[: -len(gap)]
                blocks.append(rms_norm(joined))
                cur, cur_len = [], 0.0
    if not blocks:
        raise RuntimeError("Žádné přepsané WINREC mikrofony – nejdřív node scripts/transcribe-winrec.mjs")
    return blocks


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tts = [{"text": q, "path": str(OUT / f"q_{i:02d}.wav")} for i, q in enumerate(QUESTIONS)]
    if not all(Path(t["path"]).exists() for t in tts):
        (OUT / "tts.json").write_text(json.dumps(tts, ensure_ascii=False), encoding="utf-8")
        subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "test" / "multicam" / "tts_batch.ps1"),
                        str(OUT / "tts.json")], check=True)
    questions = [rms_norm(decode_audio(t["path"], sampling_rate=SR)) for t in tts]
    answers = answer_blocks()
    print(f"odpovědí: {len(answers)} ({sum(len(a) for a in answers) / SR / 60:.1f} min unikátní řeči), otázek {len(questions)}")

    target = MINUTES * 60
    n = int((target + 30) * SR)
    petr = np.zeros(n, "float32")
    mod = np.zeros(n, "float32")
    turns = []
    t, qi, ai = 1.0, 0, 0
    while t < target:
        q = questions[qi % len(questions)]
        a0 = int(t * SR)
        if a0 + len(q) >= n:
            break
        mod[a0: a0 + len(q)] += q
        turns.append({"speaker": "Moderátor", "start": round(t, 3), "end": round(t + len(q) / SR, 3)})
        t += len(q) / SR + 0.45
        for _ in range(1 + (qi % 3)):  # 1–3 bloky odpovědi
            a = answers[ai % len(answers)]
            a0 = int(t * SR)
            if a0 + len(a) >= n:
                break
            petr[a0: a0 + len(a)] += a
            turns.append({"speaker": "Petr", "start": round(t, 3), "end": round(t + len(a) / SR, 3)})
            t += len(a) / SR + 0.35
            ai += 1
        t += 0.4
        qi += 1
    total = min(t + 1.0, n / SR)
    k = int(total * SR)
    rng = np.random.default_rng(7)
    write_wav(OUT / "master_mix.wav", petr[:k] + mod[:k] + rng.normal(0, 0.002, k).astype("float32"))
    write_wav(OUT / "mic_petr.wav", petr[:k] + 0.12 * mod[:k])
    write_wav(OUT / "mic_moderator.wav", mod[:k] + 0.12 * petr[:k])
    del petr, mod

    master = str(OUT / "master_mix.wav")
    for cam in CAMERAS:
        off = cam["offset"]
        dur = total - off + 1.0
        # zvuk kamery: posunutá kopie masteru (kamera začala o `off` s později / dříve)
        af = f"atrim=start={off:.3f},asetpts=PTS-STARTPTS" if off > 0 else f"adelay={int(-off * 1000)}"
        vf = (
            f"drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='{cam['label']}':fontsize=64:fontcolor=white:"
            "x=(w-tw)/2:y=(h-th)/2-60,"
            "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{pts\\:hms}':fontsize=56:fontcolor=white:"
            "x=(w-tw)/2:y=(h-th)/2+60"
        )
        subprocess.run([
            FF, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c={cam['color']}:s=1280x720:r=25:d={dur:.3f}",
            "-i", master, "-filter_complex", f"[1:a]{af},volume=0.4,apad[a]", "-vf", vf,
            "-map", "0:v", "-map", "[a]", "-t", f"{dur:.3f}",
            "-c:v", "h264_nvenc", "-preset", "p1", "-b:v", "700k", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", str(OUT / cam["file"]),
        ], check=True)
        print(f"hotovo {cam['file']}")

    gt = {
        "reference": master,
        "duration": round(total, 3),
        "turns": turns,
        "mics": [{"name": "Petr", "path": str(OUT / "mic_petr.wav")}, {"name": "Moderátor", "path": str(OUT / "mic_moderator.wav")}],
        "cameras": [{"source": str(OUT / c["file"]), "offset": c["offset"], "speakers": c["speakers"], "role": c["role"]} for c in CAMERAS],
    }
    (OUT / "gt.json").write_text(json.dumps(gt, ensure_ascii=False), encoding="utf-8")
    print(f"délka {total / 60:.1f} min, promluv {len(turns)}")


if __name__ == "__main__":
    main()
