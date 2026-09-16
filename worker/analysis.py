"""Porozumění dialogu: deterministická analýza (opakované pokusy, vata, nedokončené věty)
+ lokální LLM (gemma3 přes llama.cpp) pro kapitoly a plán střihu. Bez Ollamy a bez cloudu."""
from __future__ import annotations

import json
import re
import time
import unicodedata
from difflib import SequenceMatcher

from . import gpu
from .common import CONFIG, cache_file, index_get, index_set, read_json, write_json

FILLERS = {"ehm", "eh", "eee", "ee", "e", "hm", "hmm", "mhm", "ehh", "em", "emm"}
SOFT_FILLERS = {"jako", "vlastne", "proste", "takze", "no", "jo", "teda", "tak", "tady"}


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFD", text.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^\w\s]", " ", t)


def _words(text: str) -> list[str]:
    return _norm(text).split()


def load_transcript(path: str) -> tuple[dict, str]:
    f = index_get("transcripts", path)
    if not f:
        raise RuntimeError(f"Pro {path} neexistuje přepis – nejdřív transcribe.")
    return read_json(f), str(f)


def heuristics(segs: list[dict]) -> dict[int, list[str]]:
    flags: dict[int, list[str]] = {}

    def add(i, reason):
        flags.setdefault(i, [])
        if reason not in flags[i]:
            flags[i].append(reason)

    for i, s in enumerate(segs):
        ws = _words(s["text"])
        if not ws:
            add(s["id"], "prázdné")
            continue
        hard = sum(1 for w in ws if w in FILLERS)
        soft = sum(1 for w in ws if w in SOFT_FILLERS)
        if hard / len(ws) > 0.25 or (len(ws) <= 3 and (hard + soft) == len(ws)):
            add(s["id"], "vata")
        # opakovaný pokus: podobný začátek věty v následujících 45 s -> ponech pozdější verzi
        for j in range(i + 1, min(i + 4, len(segs))):
            t = segs[j]
            if t["start"] - s["end"] > 45:
                break
            wt = _words(t["text"])
            n = min(len(ws), len(wt), 8)
            if n >= 3 and SequenceMatcher(None, ws[:n], wt[:n]).ratio() >= 0.7:
                add(s["id"], f"opakovaný pokus (lepší #{t['id']})")
                break
        nxt = segs[i + 1] if i + 1 < len(segs) else None
        if not s["text"].rstrip().endswith((".", "!", "?", "…")) and nxt and nxt["start"] - s["end"] > 1.2:
            add(s["id"], "nedokončená věta")
    return flags


def _chat_json(prompt: str, max_tokens: int = 1500, schema: dict | None = None) -> dict:
    return gpu.chat_json(prompt, max_tokens, schema)


# gramatická schémata pro llama-server (GBNF) – model fyzicky nemůže vrátit jiný tvar
_CHAPTERS_SCHEMA = {
    "type": "object",
    "properties": {
        "chapters": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "from": {"type": "integer"}, "to": {"type": "integer"},
                "title": {"type": "string"}, "summary": {"type": "string"},
                "best": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["from", "to"],
        }},
        "weak": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "integer"}, "reason": {"type": "string"}},
            "required": ["id"],
        }},
    },
    "required": ["chapters"],
}
_SCORES_SCHEMA = {
    "type": "object",
    "properties": {"scores": {"type": "array", "items": {
        "type": "object",
        "properties": {"k": {"type": "integer"}, "score": {"type": "integer"}, "why": {"type": "string"}},
        "required": ["k", "score"],
    }}},
    "required": ["scores"],
}
_PICKS_SCHEMA = {
    "type": "object",
    "properties": {"picks": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "integer"}, "priority": {"type": "integer"}},
        "required": ["id"],
    }}},
    "required": ["picks"],
}


def _line(s: dict) -> str:
    spk = f" [{s['speaker']}]" if s.get("speaker") else ""
    return f"{s['id']}{spk} ({s['end'] - s['start']:.1f}s) {s['text']}"


def _chunks(segs: list[dict], max_chars: int) -> list[list[dict]]:
    out, cur, size = [], [], 0
    for s in segs:
        if cur and size + len(s["text"]) > max_chars:
            out.append(cur)
            cur, size = [], 0
        cur.append(s)
        size += len(s["text"]) + 12
    if cur:
        out.append(cur)
    return out


def _fix_chapters(raw, first: int, last: int) -> list[dict]:
    ch = []
    for c in raw or []:
        try:
            a, b = int(c.get("from")), int(c.get("to"))
        except (TypeError, ValueError, AttributeError):
            continue
        if b < a:
            a, b = b, a
        a, b = max(a, first), min(b, last)
        if a <= b:
            ch.append({"from": a, "to": b, "title": str(c.get("title") or "").strip()[:80],
                       "summary": str(c.get("summary") or "").strip()[:300],
                       "best": [int(x) for x in (c.get("best") or []) if str(x).isdigit() and a <= int(x) <= b][:3]})
    ch.sort(key=lambda c: c["from"])
    if not ch:
        return [{"from": first, "to": last, "title": "", "summary": "", "best": []}]
    ch[0]["from"] = first
    for prev, nxt in zip(ch, ch[1:]):
        nxt["from"] = prev["to"] + 1 if nxt["from"] > prev["to"] + 1 or nxt["from"] <= prev["to"] else nxt["from"]
    ch = [c for c in ch if c["from"] <= c["to"]]
    ch[-1]["to"] = last
    return ch


def analyze(params: dict, ctx) -> dict:
    path = params["path"]
    tr, tr_file = load_transcript(path)
    segs = tr["segments"]
    use_llm = params.get("llm", True)
    out = cache_file("analysis", path, {"tr": tr_file, "n": len(segs), "llm": use_llm,
                                         "spk": tr.get("speakerSource"), "v": 2})
    if out.exists() and not params.get("force"):
        index_set("analysis", path, out)
        return {"file": str(out), "cached": True}

    t0 = time.time()
    flags = heuristics(segs)
    chapters: list[dict] = []
    if use_llm and segs:
        chunks = _chunks(segs, int(CONFIG["llm"].get("chunkChars", 3200)))
        for ci, chunk in enumerate(chunks):
            ctx.check()
            ctx.progress(0.05 + 0.9 * ci / len(chunks), f"LLM kapitoly {ci + 1}/{len(chunks)}")
            first, last = chunk[0]["id"], chunk[-1]["id"]
            prompt = (
                "Jsi zkušený český střihač dokumentů a rozhovorů. Níže je úsek přepisu "
                "(číslo věty, [mluvčí], délka, text).\n\n"
                + "\n".join(_line(s) for s in chunk)
                + "\n\nÚkol: rozděl věty na souvislé tematické kapitoly (obvykle 1–4 na úsek). "
                f"Kapitoly musí navazovat a pokrýt všechny věty od {first} do {last}. "
                "Ke každé kapitole: title (max 6 slov), summary (jedna věta česky), best (1–3 čísla nejsilnějších vět). "
                "Dále weak: čísla vět, které jsou přeřeknutí, nedokončené, zbytečné opakování nebo vata, s krátkým důvodem. "
                'Vrať pouze JSON: {"chapters":[{"from":1,"to":5,"title":"","summary":"","best":[2]}],'
                '"weak":[{"id":3,"reason":""}]}'
            )
            data = _chat_json(prompt, schema=_CHAPTERS_SCHEMA)
            chapters.extend(_fix_chapters(data.get("chapters"), first, last))
            for wk in data.get("weak") or []:
                try:
                    wid = int(wk.get("id"))
                except (TypeError, ValueError, AttributeError):
                    continue
                if first <= wid <= last:
                    flags.setdefault(wid, []).append("LLM: " + str(wk.get("reason") or "slabé")[:60])
    else:
        chapters = [{"from": segs[0]["id"], "to": segs[-1]["id"], "title": "", "summary": "", "best": []}] if segs else []

    by_id = {s["id"]: s for s in segs}
    for c in chapters:
        if not c["title"]:  # LLM občas název vynechá – použij začátek první věty
            words = by_id[c["from"]]["text"].split()
            c["title"] = " ".join(words[:6]) + ("…" if len(words) > 6 else "")
        c["start"] = by_id[c["from"]]["start"]
        c["end"] = by_id[c["to"]]["end"]
        c["speakers"] = sorted({by_id[i].get("speaker") for i in range(c["from"], c["to"] + 1) if i in by_id and by_id[i].get("speaker")})
    result = {
        "source": tr["source"],
        "transcript": tr_file,
        "duration": tr["duration"],
        "sentences": len(segs),
        "speakers": tr.get("speakers"),
        "llm": CONFIG["models"]["llm"] if use_llm else None,
        "elapsedSec": round(time.time() - t0, 1),
        "chapters": chapters,
        "weak": {str(k): v for k, v in sorted(flags.items())},
    }
    write_json(out, result)
    index_set("analysis", path, out)
    return {"file": str(out), "cached": False}


def plan_edit(params: dict, ctx) -> dict:
    """Plán střihu čistě lokálně: LLM vybere kapitoly a věty podle zadání, pak dorovnání na cílovou délku."""
    path = params["path"]
    instruction = params["instruction"]
    target = float(params.get("targetSec") or 0)
    tr, _ = load_transcript(path)
    af = index_get("analysis", path)
    if not af:
        analyze({"path": path}, ctx)
        af = index_get("analysis", path)
    an = read_json(af)
    segs = {s["id"]: s for s in tr["segments"]}
    weak = an.get("weak", {})

    outline = "\n".join(
        f"K{i + 1}: věty {c['from']}–{c['to']} ({c['end'] - c['start']:.0f}s) [{', '.join(c.get('speakers') or [])}] "
        f"{c['title']} – {c['summary']}"
        for i, c in enumerate(an["chapters"])
    )
    ctx.progress(0.1, "LLM hodnotí kapitoly")
    goal = f" Cílová délka přibližně {target:.0f} s." if target else ""
    # hodnocení každé kapitoly zvlášť je u menšího modelu spolehlivější než volný výběr
    sel = _chat_json(
        f"Jsi střihač. Zadání střihu: {instruction}.{goal}\n\nOsnova materiálu:\n{outline}\n\n"
        "Ohodnoť KAŽDOU kapitolu, jak moc patří do střihu podle zadání: 0 = nesouvisí, 1 = okrajově, "
        "2 = souvisí, 3 = přímo jádro zadání. Posuzuj podle názvu i shrnutí kapitoly. "
        'Vrať JSON {"scores":[{"k":1,"score":0,"why":"krátce"}]}',
        900,
        schema=_SCORES_SCHEMA,
    )
    scores: dict[int, int] = {}
    reasons = []
    for it in sel.get("scores") or []:
        try:
            k, sc = int(it.get("k")), int(it.get("score"))
        except (TypeError, ValueError, AttributeError):
            continue
        if 1 <= k <= len(an["chapters"]):
            scores[k] = sc
            reasons.append(f"K{k}={sc} {str(it.get('why') or '')[:80]}")
    n_ch = len(an["chapters"])
    chosen = [k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 2] or [k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 1]
    if not chosen:
        chosen = list(range(1, n_ch + 1))

    picks: list[dict] = []
    for n, k in enumerate(chosen):
        ctx.check()
        ctx.progress(0.2 + 0.7 * n / len(chosen), f"LLM vybírá věty v kapitole {k}")
        c = an["chapters"][k - 1]
        ids = [i for i in range(c["from"], c["to"] + 1) if i in segs]
        # velké kapitoly po částech, aby se odpověď modelu nevešla do limitu tokenů jen napůl
        for part in range(0, len(ids), 14):
            window = ids[part: part + 14]
            lines = []
            for i in window:
                w = weak.get(str(i))
                lines.append(_line(segs[i]) + (f"  <-- slabé: {'; '.join(w)}" if w else ""))
            data = _chat_json(
                f"Jsi střihač. Zadání: {instruction}.\nKapitola „{c['title']}“ (část):\n" + "\n".join(lines)
                + "\n\nVyber věty, které zachovají smysl a srozumitelnost (celé myšlenky, otázka i odpověď, bez přeřeknutí a opakování). "
                'Každé dej prioritu 1 (nutné) až 3 (lze vynechat). Vrať pouze JSON {"picks":[{"id":12,"priority":1}]} bez komentářů.',
                1600,
                schema=_PICKS_SCHEMA,
            )
            for p in data.get("picks") or []:
                try:
                    pid, pr = int(p.get("id")), int(p.get("priority", 2))
                except (TypeError, ValueError, AttributeError):
                    continue
                if pid in window:
                    picks.append({"id": pid, "priority": max(1, min(3, pr)), "chapter": k})

    seen = set()
    picks = [p for p in picks if not (p["id"] in seen or seen.add(p["id"]))]
    picks.sort(key=lambda p: p["id"])  # chronologicky – rozhovor zůstane srozumitelný
    for p in picks:
        p["dur"] = segs[p["id"]]["end"] - segs[p["id"]]["start"]

    def is_question(sid: int) -> bool:
        s, nxt = segs.get(sid), segs.get(sid + 1)
        if not (s and nxt and s["text"].rstrip().endswith("?")):
            return False
        # bez diarizace/speakerTracks věty nemají mluvčího vůbec – pak nejde poznat,
        # že odpovídá někdo jiný, ale otázka pořád potřebuje odpověď, tak to nekontrolovat.
        if not s.get("speaker") and not nxt.get("speaker"):
            return True
        return bool(nxt.get("speaker") and nxt.get("speaker") != s.get("speaker"))

    # otázka a odpověď patří k sobě: chybějící polovinu doplň (se stejnou prioritou)
    kept = {p["id"] for p in picks}
    added = []
    for sid in sorted(segs):
        if is_question(sid) and ((sid in kept) != ((sid + 1) in kept)):
            add = sid + 1 if sid in kept else sid
            src = next(p for p in picks if p["id"] in (sid, sid + 1))
            picks.append({"id": add, "priority": src["priority"], "chapter": src.get("chapter"),
                          "dur": segs[add]["end"] - segs[add]["start"]})
            kept.add(add)
            added.append(add)
    picks.sort(key=lambda p: p["id"])

    # zkracování na cílovou délku po celcích (dvojice otázka–odpověď se nikdy nerozdělí)
    units: list[dict] = []
    for p in picks:
        if units and is_question(units[-1]["ids"][-1]) and p["id"] == units[-1]["ids"][-1] + 1:
            u = units[-1]
            u["ids"].append(p["id"])
            u["priority"] = min(u["priority"], p["priority"])
            u["dur"] += p["dur"]
        else:
            units.append({"ids": [p["id"]], "priority": p["priority"], "dur": p["dur"], "score": scores.get(p.get("chapter"), 2)})
    total = sum(u["dur"] for u in units)
    dropped = []
    if target and total > target * 1.1:
        # nejdřív celky z kapitol méně souvisejících se zadáním, v nich nejnižší priorita a nejdelší;
        # jádro zadání (skóre 3) přijde na řadu až nakonec
        for u in sorted(list(units), key=lambda u: (u["score"], -u["priority"], -u["dur"])):
            if total <= target * 1.05 or len(units) == 1:
                break
            units.remove(u)
            dropped.extend(u["ids"])
            total -= u["dur"]
    picks = [{"id": i} for u in units for i in u["ids"]]
    return {
        "picks": [p["id"] for p in picks],
        "addedForQuestionAnswer": added,
        "chapters": chosen,
        "why": "; ".join(reasons),
        "estimatedSec": round(total, 1),
        "dropped": dropped,
    }
