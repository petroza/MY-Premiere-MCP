"""Vyrobí testovací rozhovor na 3 kamery se známým správným výsledkem.

Mluvčí: Moderátor = český TTS hlas Jakub, Petr = skutečné věty z mikrofonu WINREC.
Výstup (test/multicam): master_mix.wav, mic_petr.wav, mic_moderator.wav,
cam_wide.mp4, cam_petr.mp4, cam_moderator.mp4 (každá začíná jindy, má vlastní zvuk kamery), gt.json.
Spouštět: py -3.11 scripts/make_multicam_test.py
"""
from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

import numpy as np
from faster_whisper import decode_audio

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "test" / "multicam"
FF = r"C:\Program Files\Shutter Encoder\Library\ffmpeg.exe"
MIC = r"C:\Users\Petr\Videos\WINREC\WINREC_2026-09-14_20-54-52_mikrofon.wav"
SR = 48000

SCRIPT = [
    ("Moderátor", "Dobrý den, vítejte u rozhovoru. K čemu se vlastně hodí ComfyUI?"),
    ("Petr", [4, 5]),
    ("Moderátor", "A dá se to nějak zjednodušit, když nechci řešit nody?"),
    ("Petr", [6]),
    ("Moderátor", "Jasně."),  # krátký souhlas přes Petrovu řeč -> překryv
    ("Moderátor", "Na jakém hardwaru to běží a jak je to rychlé?"),
    ("Petr", [11, 13, 14]),
    ("Moderátor", "Takže se tím dají dělat videa zadarmo?"),
    ("Petr", [15]),
    ("Moderátor", "Děkuji za rozhovor a na shledanou."),
]
CAMERAS = [
    {"file": "cam_wide.mp4", "label": "KAMERA 1 - CELEK", "color": "0x2a3b4c", "offset": -2.0, "speakers": [], "role": "wide"},
    {"file": "cam_petr.mp4", "label": "KAMERA 2 - PETR detail", "color": "0x3c5a2a", "offset": 1.3, "speakers": ["Petr"], "role": "close"},
    {"file": "cam_moderator.mp4", "label": "KAMERA 3 - MODERATOR detail", "color": "0x5a2a3c", "offset": -0.7, "speakers": ["Moderátor"], "role": "close"},
]


def load(path: str) -> np.ndarray:
    return decode_audio(path, sampling_rate=SR).astype("float32")


def norm_rms(x: np.ndarray, target: float = 0.08) -> np.ndarray:
    r = float(np.sqrt(np.mean(x * x))) or 1.0
    return np.clip(x * (target / r), -1, 1)


def write_wav(path: Path, x: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    idx = json.loads((ROOT / "cache" / "transcripts" / "index.json").read_text(encoding="utf-8"))
    tr_file = next(v for k, v in idx.items() if "20-54-52_mikrofon" in k)
    segs = {s["id"]: s for s in json.loads(Path(tr_file).read_text(encoding="utf-8"))["segments"]}

    tts_items = [{"text": t, "path": str(OUT / f"tts_{i}.wav")} for i, (who, t) in enumerate(SCRIPT) if isinstance(t, str)]
    (OUT / "tts.json").write_text(json.dumps(tts_items, ensure_ascii=False), encoding="utf-8")
    subprocess.run(["powershell", "-ExecutionPolicy", "Bypass", "-File", str(OUT / "tts_batch.ps1"), str(OUT / "tts.json")], check=True)

    mic = load(MIC)
    clips = []  # (speaker, audio)
    for i, (who, what) in enumerate(SCRIPT):
        if isinstance(what, str):
            clips.append((who, norm_rms(load(str(OUT / f"tts_{i}.wav")))))
        else:
            parts = [mic[int((segs[sid]["start"] - 0.1) * SR): int((segs[sid]["end"] + 0.15) * SR)] for sid in what]
            gap = np.zeros(int(0.35 * SR), dtype="float32")
            clips.append((who, norm_rms(np.concatenate([p if k == 0 else np.concatenate([gap, p]) for k, p in enumerate(parts)]))))

    t = 1.0
    placed = []
    for i, (who, audio) in enumerate(clips):
        if SCRIPT[i][1] == "Jasně.":
            start = placed[-1]["start"] + (placed[-1]["end"] - placed[-1]["start"]) * 0.55  # překryv uprostřed odpovědi
        else:
            start = t
        placed.append({"speaker": who, "start": round(start, 3), "end": round(start + len(audio) / SR, 3), "audio": audio})
        if SCRIPT[i][1] != "Jasně.":
            t = start + len(audio) / SR + 0.45
    total = max(p["end"] for p in placed) + 1.5
    n = int(total * SR)
    tracks = {"Petr": np.zeros(n, "float32"), "Moderátor": np.zeros(n, "float32")}
    for p in placed:
        a = int(p["start"] * SR)
        tracks[p["speaker"]][a: a + len(p["audio"])] += p["audio"]
    rng = np.random.default_rng(1)
    noise = lambda k: rng.normal(0, 0.002, k).astype("float32")  # noqa: E731
    master = tracks["Petr"] + tracks["Moderátor"] + noise(n)
    write_wav(OUT / "master_mix.wav", master)
    write_wav(OUT / "mic_petr.wav", tracks["Petr"] + 0.12 * tracks["Moderátor"] + noise(n))
    write_wav(OUT / "mic_moderator.wav", tracks["Moderátor"] + 0.12 * tracks["Petr"] + noise(n))

    for cam in CAMERAS:
        off = cam["offset"]
        dur = total - off + 1.0
        k = int(dur * SR)
        scratch = np.zeros(k, "float32")
        src_a = int(off * SR)
        for i in range(k):
            break
        lo = max(0, -src_a)
        hi = min(k, n - src_a)
        if hi > lo:
            scratch[lo:hi] = 0.4 * master[src_a + lo: src_a + hi]
        scratch += rng.normal(0, 0.01, k).astype("float32")
        wav = OUT / (cam["file"] + ".scratch.wav")
        write_wav(wav, scratch)
        vf = (
            f"drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='{cam['label']}':fontsize=100:fontcolor=white:"
            "x=(w-tw)/2:y=(h-th)/2-90,"
            "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{pts\\:hms}':fontsize=80:fontcolor=white:"
            "x=(w-tw)/2:y=(h-th)/2+90"
        )
        subprocess.run([
            FF, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c={cam['color']}:s=1920x1080:r=25:d={dur:.3f}",
            "-i", str(wav), "-vf", vf,
            "-c:v", "h264_nvenc", "-preset", "p4", "-b:v", "4M", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-shortest", str(OUT / cam["file"]),
        ], check=True)
        wav.unlink()

    gt = {
        "reference": str(OUT / "master_mix.wav"),
        "duration": round(total, 3),
        "turns": [{k: v for k, v in p.items() if k != "audio"} for p in placed],
        "mics": [{"name": "Petr", "path": str(OUT / "mic_petr.wav")}, {"name": "Moderátor", "path": str(OUT / "mic_moderator.wav")}],
        "cameras": [{"source": str(OUT / c["file"]), "offset": c["offset"], "speakers": c["speakers"], "role": c["role"]} for c in CAMERAS],
    }
    (OUT / "gt.json").write_text(json.dumps(gt, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: gt[k] for k in ("duration", "turns")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
