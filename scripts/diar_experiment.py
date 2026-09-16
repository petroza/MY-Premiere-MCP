"""Experiment: diarizace po kouscích vět z přepisu (hlasové otisky + vlastní shlukování) vs. modely otisků.

Spouštět: .venv\\Scripts\\python.exe scripts\\diar_experiment.py
Vyhodnocuje syntetický rozhovor (test/multicam/gt.json, známý výsledek) a skutečnou diskusi (test/podcast/Diskuse1.mp4).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from worker import gpu  # noqa: E402,F401  (CUDA DLL cesty)
from worker.common import index_get, read_json  # noqa: E402

import sherpa_onnx  # noqa: E402
from faster_whisper import decode_audio  # noqa: E402

SR = 16000
MODELS = [
    "wespeaker_en_voxceleb_resnet34_LM.onnx",
    "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "nemo_en_titanet_small.onnx",
]


def chunks_from_transcript(tr: dict, max_len: float = 2.5, min_len: float = 0.6):
    out = []
    for s in tr["segments"]:
        cur = []
        for w in s.get("words", []):
            cur.append(w)
            if cur[-1]["e"] - cur[0]["s"] >= max_len:
                out.append((cur[0]["s"], cur[-1]["e"]))
                cur = []
        if cur:
            if cur[-1]["e"] - cur[0]["s"] < min_len and out and abs(out[-1][1] - cur[0]["s"]) < 0.5:
                out[-1] = (out[-1][0], cur[-1]["e"])
            else:
                out.append((cur[0]["s"], cur[-1]["e"]))
    return out


def embed_all(model: str, samples: np.ndarray, chunks):
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(ROOT / "models" / "diarization" / model), num_threads=6, provider="cpu"))
    embs = []
    for a, b in chunks:
        mid, half = (a + b) / 2, max((b - a) / 2, 0.75)
        ia, ib = int(max(0, mid - half) * SR), int(min(len(samples) / SR, mid + half) * SR)
        st = ex.create_stream()
        st.accept_waveform(SR, samples[ia:ib])
        st.input_finished()
        v = np.array(ex.compute(st), dtype="float32")
        embs.append(v / (np.linalg.norm(v) + 1e-9))
    return np.stack(embs)


def spherical_kmeans(E, k, iters=30, seed=0):
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


def cluster(E, durations, sim_th=0.5, n_speakers=None, micro=48):
    lab = spherical_kmeans(E, min(micro, len(E)))
    groups = [np.where(lab == j)[0] for j in range(lab.max() + 1) if (lab == j).any()]
    sums = [E[g].sum(0) for g in groups]
    while len(groups) > 1:
        N = np.array([s / np.linalg.norm(s) for s in sums])
        S = N @ N.T
        np.fill_diagonal(S, -1)
        i, j = np.unravel_index(np.argmax(S), S.shape)
        if n_speakers is not None:
            if len(groups) <= n_speakers:
                break
        elif S[i, j] < sim_th:
            break
        groups[i] = np.concatenate([groups[i], groups[j]])
        sums[i] = sums[i] + sums[j]
        del groups[j], sums[j]
    order = sorted(range(len(groups)), key=lambda g: -durations[groups[g]].sum())
    labels = np.empty(len(E), int)
    for rank, g in enumerate(order):
        labels[groups[g]] = rank
    return labels


def accuracy_vs_gt(chunks, labels, gt):
    def gt_speaker(a, b):
        best, ov_best = None, 0
        for t in gt["turns"]:
            ov = min(b, t["end"]) - max(a, t["start"])
            if ov > ov_best:
                best, ov_best = t["speaker"], ov
        return best

    pairs = [(labels[i], gt_speaker(a, b), b - a) for i, (a, b) in enumerate(chunks)]
    co = {}
    for lab, g, d in pairs:
        if g:
            co.setdefault(lab, {}).setdefault(g, 0)
            co[lab][g] += d
    mapping = {lab: max(m, key=m.get) for lab, m in co.items()}
    total = sum(d for _, g, d in pairs if g)
    good = sum(d for lab, g, d in pairs if g and mapping.get(lab) == g)
    return good / total


def main():
    gt = json.loads((ROOT / "test" / "multicam" / "gt.json").read_text(encoding="utf-8"))
    sets = [("syntetický rozhovor", gt["reference"], gt), ("Diskuse1 (skutečná)", str(ROOT / "test" / "podcast" / "Diskuse1.mp4"), None)]
    best_labels = {}
    for name, path, g in sets:
        tr = read_json(index_get("transcripts", path))
        chunks = chunks_from_transcript(tr)
        durs = np.array([b - a for a, b in chunks])
        samples = decode_audio(path, sampling_rate=SR)
        print(f"\n##### {name}: {len(chunks)} kousků, {len(tr['segments'])} vět", flush=True)
        for model in MODELS:
            t0 = time.time()
            try:
                E = embed_all(model, samples, chunks)
            except Exception as e:  # noqa: BLE001
                print(f"  {model}: CHYBA {e}")
                continue
            t_emb = time.time() - t0
            for th in (0.35, 0.45, 0.55, 0.65):
                labels = cluster(E, durs, sim_th=th)
                share = sorted([durs[labels == k].sum() / durs.sum() for k in range(labels.max() + 1)], reverse=True)
                acc = f" · přesnost {accuracy_vs_gt(chunks, labels, g) * 100:.1f} %" if g else ""
                print(f"  {model[:40]:40s} th={th}: {labels.max() + 1} mluvčích, podíly {[round(x * 100) for x in share[:6]]}{acc} ({t_emb:.1f} s)", flush=True)
                if not g:
                    best_labels[(model, th)] = (chunks, labels)
            if g:
                labels = cluster(E, durs, n_speakers=2)
                print(f"  {model[:40]:40s} n=2: přesnost {accuracy_vs_gt(chunks, labels, g) * 100:.1f} %", flush=True)

    # ukázka textu s mluvčími pro kontrolu smyslu (Diskuse1, CAM++, th 0.55)
    key = next((k for k in best_labels if k[0].startswith("3dspeaker") and k[1] == 0.55), None) or next(iter(best_labels))
    chunks, labels = best_labels[key]
    tr = read_json(index_get("transcripts", str(ROOT / "test" / "podcast" / "Diskuse1.mp4")))
    print(f"\n##### ukázka Diskuse1 ({key[0][:30]}, th={key[1]})")
    for s in tr["segments"][:45] + tr["segments"][100:120]:
        mid = (s["start"] + s["end"]) / 2
        idx = min(range(len(chunks)), key=lambda i: 0 if chunks[i][0] <= mid <= chunks[i][1] else min(abs(chunks[i][0] - mid), abs(chunks[i][1] - mid)))
        print(f"#{s['id']:3d} {s['start']:7.1f} S{labels[idx] + 1} {s['text'][:110]}")


if __name__ == "__main__":
    main()
