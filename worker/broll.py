"""Obraz pod dodatečně namluvený komentář (dabing / voiceover).

Běžný střih vybírá věty z řeči uvnitř videa. Tady je to obráceně: řeč je samostatná zvuková stopa (komentář
namluvený dodatečně) a obraz se vybírá ze záznamů bez řeči (záznamy obrazovky, b-roll). Panelový Hermes
v takové sekvenci vzal za zdroj záznam obrazovky a hlásil „vybráno 0 vět“ (prezentace, 2026-10-05).

index  – vzorky záznamů po několika sekundách, sloučení téměř stejných snímků do záběrů, popis každého záběru
         (Hermes s viděním, jinak vlastní Qwen3-VL) a náhledové archy pro agenty, kteří vidí obrázky (Claude, GPT).
plan   – lokální LLM přiřadí každé větě komentáře záběr(y), které ukazují, o čem věta mluví.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.request
from pathlib import Path

from . import gpu
from .common import CONFIG, cache_dir, log, read_json, write_json

DESCRIBE_PROMPT = (
    "Co je na tomhle snímku obrazovky nebo záběru? Česky, nejvýš 2 krátké věty: jaká aplikace nebo okno, co se "
    "v něm právě děje, a doslova vypiš výrazné texty v obraze (titulky, nadpisy, popisky grafiky). Bez úvodu."
)


def _key(path: str, step: float) -> str:
    st = os.stat(path)
    raw = f"{os.path.normcase(os.path.abspath(path))}|{st.st_size}|{int(st.st_mtime)}|{step}|v1"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _sample(path: str, step: float, out_dir: Path, ctx, p0: float, p1: float) -> list[dict]:
    """Klíčové snímky (rychlé – dekóduje se jen každý keyframe) nejblíž časům 0, step, 2·step…; téměř stejné
    po sobě jdoucí snímky (statická obrazovka) se slijí do jednoho záběru."""
    import av
    import cv2
    import numpy as np

    shots: list[dict] = []
    with av.open(path) as c:
        v = c.streams.video[0]
        dur = float(c.duration / av.time_base) if c.duration else 0.0
        v.codec_context.skip_frame = "NONKEY"
        nxt = 0.0
        prev_small = None
        for fr in c.decode(v):
            t = float(fr.time or 0.0)
            if t + 0.001 < nxt:
                continue
            nxt = t + step
            img = fr.to_ndarray(format="bgr24")
            small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (64, 36), interpolation=cv2.INTER_AREA)
            if prev_small is not None and float(np.mean(cv2.absdiff(small, prev_small))) < 2.5 and shots:
                shots[-1]["to"] = round(t + step, 2)
                continue
            prev_small = small
            h, w = img.shape[:2]
            img = cv2.resize(img, (1280, int(h * 1280 / w)), interpolation=cv2.INTER_AREA)
            f = out_dir / f"{len(shots):04d}.jpg"
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 82])
            if ok:
                f.write_bytes(buf.tobytes())
            shots.append({"source": os.path.abspath(path), "from": round(t, 2), "to": round(t + step, 2),
                          "image": str(f)})
            if dur:
                ctx.progress(p0 + (p1 - p0) * min(1.0, t / dur), f"vzorky {os.path.basename(path)} {t / 60:.0f}/{dur / 60:.0f} min")
    if shots:
        shots[-1]["to"] = round(min(shots[-1]["to"], dur or shots[-1]["to"]), 2)
    return shots


def _vision_backend() -> tuple[str, dict] | None:
    """Běžící externí backend (Hermes) – jestli umí obrázky, se pozná až prvním pokusem."""
    for b in gpu.backend_status():
        if b["name"] != "local" and b.get("running"):
            return b["name"], gpu.llm_backends().get(b["name"], {})
    return None


def _describe_ext(cfg: dict, image: str) -> str:
    b64 = base64.b64encode(Path(image).read_bytes()).decode("ascii")
    payload = {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": DESCRIBE_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}],
        "temperature": 0.2, "max_tokens": 160,
    }
    if cfg.get("model"):
        payload["model"] = cfg["model"]
    if cfg.get("thinking") is False:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    req = urllib.request.Request(str(cfg["url"]).rstrip("/") + "/v1/chat/completions",
                                 data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"].strip()


def _sheets(shots: list[dict], out_dir: Path, per: int = 12) -> list[str]:
    """Archy 4×3 s číslem záběru a časem – pro agenty, kteří vidí obrázky (stejně jako to dělá střihač)."""
    import cv2
    import numpy as np

    files = []
    for s0 in range(0, len(shots), per):
        tiles = []
        for s in shots[s0: s0 + per]:
            img = cv2.imdecode(np.fromfile(s["image"], dtype=np.uint8), cv2.IMREAD_COLOR)
            img = cv2.resize(img, (640, int(img.shape[0] * 640 / img.shape[1])))
            label = f"S{s['id']} {Path(s['source']).stem[-8:]} {int(s['from'] // 60):02d}:{int(s['from'] % 60):02d}"
            cv2.rectangle(img, (0, 0), (len(label) * 15 + 12, 34), (0, 0, 0), -1)
            cv2.putText(img, label, (6, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 230, 255), 2, cv2.LINE_AA)
            tiles.append(img)
        h = max(t.shape[0] for t in tiles)
        tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT) for t in tiles]
        while len(tiles) % 4:
            tiles.append(np.zeros_like(tiles[0]))
        rows = [np.hstack(tiles[i: i + 4]) for i in range(0, len(tiles), 4)]
        sheet = np.vstack(rows)
        f = out_dir / f"sheet_{s0 // per + 1:02d}.jpg"
        ok, buf = cv2.imencode(".jpg", sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            f.write_bytes(buf.tobytes())
            files.append(str(f))
    return files


def index(params: dict, ctx) -> dict:
    paths = [p for p in params.get("paths") or [] if os.path.isfile(p)]
    if not paths:
        raise FileNotFoundError("Žádný z obrazových zdrojů neexistuje.")
    describe = params.get("describe", True)
    shots: list[dict] = []
    vision = None  # ("hermes", cfg) | ("local", None)
    for pi, path in enumerate(paths):
        import av
        with av.open(path) as c:
            dur = float(c.duration / av.time_base) if c.duration else 0.0
        step = float(params.get("step") or min(20.0, max(6.0, dur / 90)))  # ~90 vzorků na záznam
        d = cache_dir("broll") / f"{Path(path).stem[:40]}.{_key(path, step)}"
        d.mkdir(parents=True, exist_ok=True)
        idx_file = d / "index.json"
        span = (pi / len(paths), (pi + 1) / len(paths))
        cached = read_json(idx_file) if idx_file.exists() else None
        own = cached["shots"] if cached else _sample(path, step, d, ctx, span[0], span[0] + (span[1] - span[0]) * 0.3)
        if describe and any(not s.get("desc") for s in own):
            for i, s in enumerate(own):
                if s.get("desc"):
                    continue
                ctx.progress(span[0] + (span[1] - span[0]) * (0.3 + 0.7 * i / len(own)),
                             f"popis záběrů {Path(path).name} {i + 1}/{len(own)}")
                if vision is None:
                    ext = _vision_backend()
                    vision = ext if ext else ("local", None)
                try:
                    if vision[0] == "local":
                        s["desc"] = gpu.describe_image(s["image"], DESCRIBE_PROMPT, 160)
                    else:
                        try:
                            s["desc"] = _describe_ext(vision[1], s["image"])
                        except TimeoutError:  # Hermes jednou zaváhal (2026-10-05) – ještě jeden pokus
                            s["desc"] = _describe_ext(vision[1], s["image"])
                except Exception as e:  # noqa: BLE001
                    if vision[0] != "local":
                        # Hermes bez mmproj (spuštěný bez -Vize) obrázky neumí – zkusit vlastní vision model
                        log(f"broll: {vision[0]} obrázek nepřijal ({str(e)[:100]}) – zkouším vlastní vision model")
                        vision = ("local", None)
                        try:
                            s["desc"] = gpu.describe_image(s["image"], DESCRIBE_PROMPT, 160)
                        except Exception as e2:  # noqa: BLE001
                            raise RuntimeError(
                                "Popis obrazu nejde: Hermes běží bez vidění a vlastní vision model se nevejde na GPU "
                                f"({str(e2)[:120]}). Spusť Hermese s viděním (scripts\\hermes.ps1 start -Vize), nebo "
                                "ho zastav (scripts\\hermes.ps1 stop). Claude/GPT můžou místo popisu použít archy "
                                "(describe: false, sheets: true).") from e2
                    else:
                        raise
                write_json(idx_file, {"source": os.path.abspath(path), "step": step, "duration": dur, "shots": own})
        write_json(idx_file, {"source": os.path.abspath(path), "step": step, "duration": dur, "shots": own})
        shots.extend(own)
    for i, s in enumerate(shots, 1):
        s["id"] = i
    out = {"shots": shots, "vision": vision[0] if vision else None}
    if params.get("sheets"):
        d = cache_dir("broll") / ("sheets." + hashlib.sha1("|".join(paths).encode()).hexdigest()[:10])
        d.mkdir(parents=True, exist_ok=True)
        out["sheets"] = _sheets(shots, d)
    return out


def plan(params: dict, ctx) -> dict:
    """Ke každé větě komentáře záběr(y). Vstup: sentences [{id,start,end,text}] (časy komentáře), shots
    z indexu. Výstup: segments [{source, in, at, dur, sentence}] v čase komentáře (0 = začátek komentáře)."""
    sents = params["sentences"]
    shots = {s["id"]: s for s in params["shots"]}
    total = float(params.get("duration") or (sents[-1]["end"] if sents else 0))
    backend = params.get("backend") or "auto"
    if backend == "auto":
        backend = next((b["name"] for b in gpu.backend_status() if b["name"] != "local" and b["running"]), "local")
    shot_lines = [f"S{s['id']} [{Path(s['source']).stem[-8:]} {s['from']:.0f}–{s['to']:.0f} s]: {s.get('desc') or '?'}"
                  for s in params["shots"]]
    sent_lines = [f"V{s['id']} ({s['start']:.1f}–{s['end']:.1f} s, {s['end'] - s['start']:.0f} s): {s['text'].strip()}"
                  for s in sents]
    ctx.progress(0.1, "LLM vybírá ke každé větě kandidátní záběry")
    # Jedním tahem „vyber záběry“ model šel prostě po pořadí čísel (19 záběrů z jednoho záznamu, prezentace
    # 2026-10-05). Proto jen kandidáti podle obsahu; pestrost a rozdělení dlouhých vět řeší deterministicky
    # _assign (bez opakování, víc záběrů u dlouhé věty).
    data = gpu.chat_json(
        "Jsi střihač. Pod dodatečně namluvený komentář hledáš obraz v záznamech obrazovky. Ke KAŽDÉ větě komentáře "
        "vypiš 3–4 záběry, které nejlépe ukazují to, o čem věta mluví, seřazené od nejlepšího. Rozhoduje jen obsah: "
        "věta zmiňuje Premiere → záběr, kde je Premiere; After Effects → After Effects; titulek / lower third / "
        "animace / chyba v animaci → záběr s titulkem v grafice; galerie / MOGRT / šablona → Premiere s nabídkou "
        "grafik; zadání / prompt / chat / Claude → záběr s chatem nebo zadáváním textu; výsledek / opraveno → hotová "
        "grafika; varianty / tisíce variant → různé titulky s jinými jmény. Obecná věta → celkový záběr pracoviště. "
        "Ber záběry z celého materiálu a ze všech záznamů – NE podle pořadí čísel.\n\nZáběry:\n" + "\n".join(shot_lines)
        + "\n\nVěty komentáře:\n" + "\n".join(sent_lines)
        + '\n\nVrať JSON {"v":[{"veta":1,"kandidati":[3,17,40]}, …]} – pro každou větu.',
        160 + 40 * len(sents),
        schema={"type": "object", "properties": {"v": {"type": "array", "items": {
            "type": "object", "properties": {"veta": {"type": "integer"},
                                             "kandidati": {"type": "array", "items": {"type": "integer"}, "maxItems": 5}},
            "required": ["veta", "kandidati"]}}}, "required": ["v"]},
        backend=backend,
    )
    cand = {int(x["veta"]): [z for z in x.get("kandidati") or [] if z in shots] for x in data.get("v") or []
            if isinstance(x, dict) and "veta" in x}
    return {"segments": segments_from_picks(sents, _assign(sents, cand), shots, total), "backend": backend,
            "candidates": cand}


def _assign(sents: list[dict], cand: dict) -> dict:
    """Kandidáti -> konkrétní záběry: dlouhá věta dostane víc záběrů (~1 na 5 s, nejvýš 4), záběr se použije
    znovu až po vyčerpání nepoužitých kandidátů a dva po sobě jdoucí úseky nejsou z téhož záběru."""
    used: dict[int, int] = {}
    out: dict[int, list[int]] = {}
    prev = None
    for s in sents:
        want = max(1, min(4, round((s["end"] - s["start"]) / 5)))
        pool = cand.get(s["id"]) or []
        picks: list[int] = []
        for sid in sorted(pool, key=lambda z: (used.get(z, 0), pool.index(z))):
            if len(picks) >= want:
                break
            if sid != prev and sid not in picks:
                picks.append(sid)
                prev = sid
        for sid in picks:
            used[sid] = used.get(sid, 0) + 1
        out[s["id"]] = picks
    return out


def segments_from_picks(sents: list[dict], pick: dict, shots: dict, total: float) -> list[dict]:
    """Věty + vybrané záběry -> souvislá obrazová stopa. Střih těsně před začátkem věty (0,25 s), záběr trvá do
    začátku další věty; víc záběrů u jedné věty se dělí rovnoměrně. Věta bez záběru drží předchozí obraz."""
    lead = 0.25
    starts = [max(0.0, s["start"] - lead) for s in sents]
    starts[0] = 0.0
    used: dict[int, float] = {}
    segs: list[dict] = []
    last_shot = None
    for i, s in enumerate(sents):
        a = starts[i]
        b = starts[i + 1] if i + 1 < len(sents) else total
        if b - a < 0.2:
            continue
        ids = pick.get(s["id"]) or ([last_shot] if last_shot else [])
        if not ids:
            ids = [next(iter(shots))]
        part = (b - a) / len(ids)
        for k, sid in enumerate(ids):
            sh = shots[sid]
            # opakovaný záběr pokračuje dál (jiný úsek téhož místa), ne znovu od začátku
            start_in = used.get(sid, sh["from"])
            segs.append({"source": sh["source"], "in": round(start_in, 3), "at": round(a + k * part, 3),
                         "dur": round(part, 3), "sentence": s["id"], "shot": sid})
            used[sid] = start_in + part
            last_shot = sid
    return segs


def media_info(params: dict, ctx) -> dict:
    """Délky médií (s) – aby obraz pod komentářem nesahal za konec záznamu."""
    import av

    out = {}
    for p in params.get("paths") or []:
        try:
            with av.open(p) as c:
                out[p] = float(c.duration / av.time_base) if c.duration else None
        except Exception:  # noqa: BLE001
            out[p] = None
    return {"durations": out}
