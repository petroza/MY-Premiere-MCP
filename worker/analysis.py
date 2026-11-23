"""Porozumění dialogu: deterministická analýza (opakované pokusy, vata, nedokončené věty)
+ lokální LLM (gemma3 přes llama.cpp) pro kapitoly a plán střihu. Bez Ollamy a bez cloudu."""
from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from difflib import SequenceMatcher

from . import audiosync, gpu
from .common import CONFIG, cache_file, index_get, index_set, log, read_json, write_json

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


def _moderator_speakers(segs: dict[int, dict]) -> set[str]:
    """Kdo je moderátor: podle jména, jinak ten, kdo mluví nejmíň a nejčastěji se ptá."""
    stats: dict[str, dict] = {}
    for s in segs.values():
        sp = s.get("speaker")
        if not sp:
            continue
        d = stats.setdefault(sp, {"n": 0, "q": 0, "dur": 0.0})
        d["n"] += 1
        d["dur"] += s["end"] - s["start"]
        if s["text"].rstrip().endswith("?"):
            d["q"] += 1
    named = {sp for sp in stats if re.search(r"moder|reportér|reporter|redaktor|hlasatel|host(itel)?ka?\b", sp, re.I)}
    if named or len(stats) < 3:
        return named
    quiet = min(stats, key=lambda k: stats[k]["dur"])
    return {quiet} if stats[quiet]["q"] / max(1, stats[quiet]["n"]) >= 0.2 else set()


def _speakers_named(instruction: str, speakers: set[str]) -> set[str]:
    """Mluvčí, na které zadání výslovně omezuje ("jen Vašíř", "co říká vypravěč", "výroky Ferancové").
    Automatické značky S1, S2… se nehledají; jméno podle kmene (bez posledních 2 písmen), víceslovné podle prvního slova."""
    ins = _norm(instruction)
    cue = r"(jen|pouze|vyhradne|rika|rikaji|rekl|rekla|vyrok\w*|slova|promluv\w*|mluvi)"
    out = set()
    for sp in speakers:
        if re.fullmatch(r"S\d+", sp or ""):
            continue
        first = _norm(sp).split()
        if not first:
            continue
        w = first[0]
        stem = w[: max(4, len(w) - 2)] if len(w) > 4 else w
        if re.search(rf"\b{cue}\W+(\w+\W+){{0,3}}{re.escape(stem)}\w*", ins):
            out.add(sp)
    return out


_LANG_NAMES = {"cs": "češtiny", "sk": "slovenštiny", "en": "angličtiny", "de": "němčiny", "pl": "polštiny",
               "uk": "ukrajinštiny", "ru": "ruštiny", "fr": "francouzštiny", "es": "španělštiny"}


def translate(params: dict, ctx) -> dict:
    """Překlad krátkých textů (titulky) lokálním modelem. Po dávkách s číslováním a kontextem předchozích titulků;
    počet výstupů hlídá gramatika (minItems = maxItems), takže se titulky nerozjedou s časy."""
    texts = [str(t) for t in params["texts"]]
    maxlen = params.get("maxLen") if len(params.get("maxLen") or []) == len(texts) else None
    target = params.get("target") or "cs"
    backend = params.get("backend") or "auto"
    if backend == "auto":
        backend = gpu.auto_backend()
    gpu.CALL_STATS.clear()
    gpu.STAT_PHASE = "translate"
    name = _LANG_NAMES.get(target, target)
    out = list(texts)
    B = 30
    for b0 in range(0, len(texts), B):
        ctx.check()
        ctx.progress(b0 / max(1, len(texts)), f"překlad titulků {b0 + 1}–{min(len(texts), b0 + B)} z {len(texts)}")
        batch = texts[b0: b0 + B]
        prev = texts[max(0, b0 - 3): b0]
        d = _chat_json(
            f"Přelož titulky do {name}. Jsou to po sobě jdoucí úseky jedné řeči – věta může pokračovat v dalším titulku, "
            "proto překládej v kontextu, přirozeně a stručně, jak se píšou titulky. Zachovej tón i vulgarismy; jména "
            "a místní názvy přepiš obvyklým způsobem. Každý titulek přelož zvlášť – stejný počet a pořadí, nic "
            "nespojuj ani nevynechávej. Už přeložený text jen zkontroluj."
            + (("\nPředchozí titulky (jen kontext, nepřekládej): " + " / ".join(prev)) if prev else "")
            + ("\nU titulku je v závorce nejvýš znaků, které divák stihne přečíst – překlad drž do té délky "
               "(zhusti formulaci, vynech vatu, smysl zachovej)." if maxlen else "")
            + "\n\n" + "\n".join(f"{i + 1}. " + (f"(max {maxlen[b0 + i]} zn.) " if maxlen else "") + t
                                 for i, t in enumerate(batch))
            + f'\n\nVrať JSON {{"t":[{{"i":1,"t":"…"}}]}} – u každého titulku jeho číslo i a překlad t, všech {len(batch)}.',
            90 * len(batch) + 200,
            # s číslem titulku: jen pole textů se jednou posunulo o jeden (model spojil dva titulky, gramatika
            # vynutila počet a poslední doplnil originálem) – časy pak dostaly cizí věty
            schema={"type": "object", "properties": {"t": {"type": "array", "items": {
                "type": "object", "properties": {"i": {"type": "integer"}, "t": {"type": "string"}},
                "required": ["i", "t"]}, "minItems": len(batch), "maxItems": len(batch)}}, "required": ["t"]},
            backend=backend,
        )
        for it in d.get("t") or []:
            try:
                k = int(it.get("i")) - 1
            except (TypeError, ValueError, AttributeError):
                continue
            t = str(it.get("t") or "").strip()
            if 0 <= k < len(batch) and t:
                out[b0 + k] = t
    def runaway(src: str, t: str) -> bool:
        # model občas místo krátkého titulku „přeloží“ celý kontext (šum „1.30“ → odstavec předchozích titulků)
        return len(t) > 3 * len(src) + 25 or " / " in t

    # nepřeložené (chybí, model vrátil originál) nebo přerostlé -> každý zvlášť; text bez písmen se nepřekládá
    retried = 0
    for i, (src, t) in enumerate(zip(texts, out)):
        if not re.search(r"[^\W\d_]{2}", src):
            out[i] = src
            continue
        if (_norm(t) == _norm(src) and re.search(r"[^\W\d_]{3}", src)) or runaway(src, t):
            ctx.check()
            d = _chat_json(
                f"Přelož do {name} (titulek, přirozeně a stručně; vrať jen překlad tohoto textu, nic navíc):\n{src}"
                + (f"\n(kontext před: {texts[i - 1]})" if i and not runaway(src, t) else "")
                + '\nVrať JSON {"t":"…"}', 300,
                schema={"type": "object", "properties": {"t": {"type": "string"}}, "required": ["t"]}, backend=backend)
            nt = str(d.get("t") or "").strip()
            if nt and not runaway(src, nt):
                out[i] = nt
                retried += 1
            elif runaway(src, t):
                out[i] = src
    return {"texts": out, "target": target, "backend": backend, "retried": retried,
            "llmStats": gpu.stats_summary(gpu.CALL_STATS)}


def _chat_json(prompt: str, max_tokens: int = 1500, schema: dict | None = None, backend: str | None = None) -> dict:
    return gpu.chat_json(prompt, max_tokens, schema, backend)


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
        # důvod jen jako kód: volně psané důvody byly dlouhé věty (~25 tokenů) a osnovu zpomalovaly ~4×
        "weak": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "integer"},
                           "reason": {"type": "string",
                                      "enum": ["přeřeknutí", "nedokončené", "opakování", "vata", "nesrozumitelné"]}},
            "required": ["id"],
        }},
    },
    "required": ["chapters"],
}


def _line(s: dict) -> str:
    spk = f" [{s['speaker']}]" if s.get("speaker") else ""
    return f"{s['id']}{spk} ({s['end'] - s['start']:.1f}s) {s['text']}"


def _median_dur(units: list[dict]) -> float:
    ds = sorted(u["dur"] for u in units if u.get("dur"))
    return ds[len(ds) // 2] if ds else 8.0


# Vady, kvůli kterým je věta do střihu opravdu nepoužitelná. "přeřeknutí"/"nedokončené" mezi ně NEPATŘÍ:
# u reálného materiálu to bývá hlavně šum přepisu (Whisper zkomolí slovo) nebo zápal řečníka – a právě
# nejostřejší výroky v debatě takovou drobnou vadu mívají. Dřív je prompt plošně zakazoval ("bez přeřeknutí"),
# takže se do střihu nedostalo to nejpodstatnější (2026-09-26: vyčítaná zastavená parkovací politika).
_HARD_WEAK = ("vata", "prázdné", "prazdne", "nesrozumitelné", "nesrozumitelne", "opakování", "opakovani")


def _weak_note(reasons: list[str] | None, is_best: bool) -> str:
    """Popisek vady za větu pro LLM. Věta, kterou osnova označila za nejlepší v kapitole, se
    za slabou neoznačuje vůbec – jinak si model protiřečí sám se sebou."""
    if not reasons or is_best:
        return ""
    txt = "; ".join(reasons)
    hard = any(h in r.lower() for r in reasons for h in _HARD_WEAK)
    return f"  <-- {'nepoužitelné' if hard else 'drobná vada'}: {txt}"


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
    backend = params.get("backend") or "auto"
    if backend == "auto":  # Hermes, když běží (vedle něj se vlastní gemma3 do VRAM nevejde a běží pomalu)
        backend = gpu.auto_backend()
    out = cache_file("analysis", path, {"tr": tr_file, "n": len(segs), "llm": use_llm,
                                         "spk": tr.get("speakerSource"), "be": backend, "v": 2})
    if out.exists() and not params.get("force"):
        index_set("analysis", path, out)
        return {"file": str(out), "cached": True}

    t0 = time.time()
    flags = heuristics(segs)
    gpu.CALL_STATS.clear()
    gpu.STAT_PHASE = "outline"
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
                "Ke každé kapitole: title (max 6 slov), summary (jedna krátká věta česky, max 20 slov), "
                "best (1–3 čísla nejsilnějších vět). Dále weak: čísla vět, které jsou přeřeknutí, nedokončené, "
                "zbytečné opakování, vata nebo nesrozumitelné, s kódem důvodu. "
                'Vrať pouze JSON: {"chapters":[{"from":1,"to":5,"title":"","summary":"","best":[2]}],'
                '"weak":[{"id":3,"reason":"vata"}]}'
            )
            data = _chat_json(prompt, schema=_CHAPTERS_SCHEMA, backend=backend)
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
        "llm": (gpu.llm_backends().get(backend, {}).get("label", backend) if backend != "local"
                else CONFIG["models"]["llm"]) if use_llm else None,
        "backend": backend if use_llm else None,
        "elapsedSec": round(time.time() - t0, 1),
        "llmStats": gpu.stats_summary(gpu.CALL_STATS),
        "chapters": chapters,
        "weak": {str(k): v for k, v in sorted(flags.items())},
    }
    write_json(out, result)
    index_set("analysis", path, out)
    return {"file": str(out), "cached": False}


def _instruction_topics(instruction: str, backend: str) -> tuple[list[str], bool, bool, bool]:
    """Témata, která zadání výslovně jmenuje ("o bydlení a parkování" -> [bydlení, parkování]), zda jde
    o samostatná témata vedle sebe (pak se vyvažují), nebo jen o aspekty jednoho tématu ("cena ovladače"),
    zda je zadání obecné bez konkrétního tématu ("přehled celé debaty") – pak se téma nekontroluje vůbec –
    a zda je vztahové ("hlavní spor", "co si vyčítají"): téma se taky nekontroluje, ale NENÍ to přehled,
    takže se výběr nesmí roztahovat po kapitolách – spor je naopak potřeba ukázat do hloubky."""
    d = _chat_json(
        f"Zadání střihu: {instruction}\n\nVypiš obsahová témata, která zadání výslovně jmenuje (0–4 krátká hesla, "
        "každé zvlášť) – věcné oblasti, o kterých se má ve střihu mluvit, např. „školství“, „doprava“. Nejsou to "
        "témata: co se z řeči vybírá (argumenty, názory, výroky, postoje, kdo mluví) ani formální požadavky (délka, "
        "bez moderátora, bez opakování). Pak urči samostatna: true jen když zadání výslovně chce víc různých témat "
        "vedle sebe (např. „o školství a dopravě“); false, když jde o jedno téma a hesla jsou jeho části. "
        "Nakonec obecne: true jen když zadání obsah na žádné téma neomezuje (přehled celého pořadu, nejsilnější "
        "momenty, shrnutí); jinak false. "
        'Vrať JSON {"temata":["…"],"samostatna":false,"obecne":false}',
        200,
        schema={"type": "object", "properties": {
            "temata": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
            "samostatna": {"type": "boolean"},
            "obecne": {"type": "boolean"}}, "required": ["temata", "samostatna", "obecne"]},
        backend=backend,
    )
    # "sestřih o seniorském bydlení" obecný není, i když ho model tak jednou označil – obrat "o …" je omezení obsahu
    about = re.search(r"\b(o|ohledně|na téma|k tématu|týkající se)\s+\w", instruction, re.I)
    general = bool(d.get("obecne")) and not about
    out: list[str] = []
    for t in d.get("temata") or []:
        t = str(t).strip().strip(".").lower()[:40]
        if t and t not in out and t not in ("jiné", "okrajově"):
            out.append(t)
    # Vztahová/rétorická hesla nejsou obsahová témata, i když je model jako témata vrátí (prompt to zakazuje,
    # ale neudrží to). "Hlavní spor" není věcná oblast, je to druh výroku – kontrola tématu pak zahodí právě
    # konkrétní důkazy sporu ("za tu kampaň se utratilo tři čtvrtě milionu"), protože ty "o sporu" nejsou.
    # Nezbude-li po odfiltrování nic, zadání obsah tématem neomezuje -> chová se jako obecné.
    meta = ("spor", "konflikt", "polemik", "hádk", "výčitk", "vycitk", "kritik", "rozdíl", "rozdil", "odlišn",
            "odlisn", "argument", "názor", "nazor", "postoj", "výrok", "vyrok", "moment", "vzkaz", "sdělení",
            "sdeleni", "atmosfér", "atmosfer", "vyjádřen", "vyjadren")
    # Styl a forma střihu taky nejsou témata: „akční upoutávka“ dala téma „akce“ a kontrola tématu vyřadila 34 vět
    # (Robin Hood, 2026-09-29) – zbylo 37 s z 60. Upoutávka o čemkoli je výběr podle síly a tempa, ne podle obsahu.
    style = ("akc", "akčn", "akcn", "upoutáv", "upoutav", "trailer", "teaser", "promo", "dynami", "napět", "napet",
             "napín", "napin", "tempo", "rychl", "dramat", "vtip", "humor", "emoc", "strhuj", "sestřih", "sestrih",
             # „krátké střihy“ (debata, 2026-10-06) – forma střihu, ne obsah
             "krátk", "kratk", "střih", "strih", "údern", "udern", "svižn", "svizn")
    styled = [t for t in out if any(m in _norm(t) for m in style)]
    out = [t for t in out if t not in styled]
    filtered = [t for t in out if not any(m in _norm(t) for m in meta)]
    relational = bool(out) and not filtered
    if styled and not out and not about:
        general = True  # jen styl, žádné téma -> obsah neomezovat (jako „nejsilnější momenty“)
    out = [] if general else filtered[:4]
    # "o bydlení a parkování": témata spojená přímo spojkou jsou samostatná vždy – úsudek modelu tady kolísal
    # (stejné zadání jednou true, po úpravě promptu false). "masifikací a skutečnou demokratizací" (slovo mezi) ne.
    stems = [_norm(t).split()[0][:5] for t in out if _norm(t).split()]
    norm_ins = _norm(instruction)
    joined = any(re.search(rf"\b{re.escape(a)}\w*\s+(a|i|nebo)\s+{re.escape(b)}", norm_ins)
                 for a in stems for b in stems if a != b)
    return out, (bool(d.get("samostatna")) or joined) and len(out) >= 2, general, relational


def _verify_topic(instruction: str, topics: list[str], separate: bool, ids: list[int], segs: dict, an: dict,
                  chapter_of: dict, backend: str, dependent: set[int] | None = None) -> dict[int, str]:
    """Kontrola tématu bez kontextu výběru: v souvislé pasáži (např. o dopravě) model označí za téma zadání i věty
    o příbuzném tématu (tramvaje místo parkování). Úzká otázka na každou větu zvlášť je spolehlivější.
    Vrací {id věty: téma zadání nebo "jiné"}. Hesla jednoho tématu (separate=False) se nerozlišují – přiřazování
    k jemným heslům ("masifikace" vs. "demokratizace") bylo zbytečně přísné a vyřazovalo věty k věci."""
    separate = separate and len(topics) >= 2
    # Bez popisu "o čem věta je": s názvem kapitoly jako kontextem vycházel verdikt stejně (5/5 běhů) a 2,3× rychleji.
    # U jednoho tématu otázka ano/ne – popisek typu "téma zadání" v enumu model mátl (jednou dal "jiné" všemu).
    verdict_field = ({"tema": {"type": "string", "enum": topics + ["jiné"]}} if separate
                     else {"k_tematu": {"type": "string", "enum": ["ano", "ne"]}})
    # "odkaz": věta stojí na předchozí ("Tím si to zhoršujeme.", "ten partner") – do `dependent` (volitelně)
    odkaz = {"odkaz": {"type": "string", "enum": ["ne", "ano"]}}
    schema = {
        "type": "object",
        "properties": {"items": {"type": "array", "items": {
            "type": "object",
            "properties": {"id": {"type": "integer"}, **verdict_field, **odkaz},
            "required": ["id", *verdict_field, "odkaz"],
        }}},
        "required": ["items"],
    }
    task = ("přiřaď ji k tématu zadání, kterému slouží – i nepřímo, jako prostředek, podmínka nebo zdůvodnění. "
            "Je-li o jiném tématu, i když ze stejné oblasti a ve stejné pasáži, dej \"jiné\". "
            'Vrať JSON {"items":[{"id":12,"tema":"…","odkaz":"ne"}]}') if separate else (
            "rozhodni, zda slouží tématu zadání (ano) – i nepřímo, jako prostředek, podmínka nebo zdůvodnění – "
            "nebo je o jiném tématu, i když ze stejné oblasti a ve stejné pasáži (ne). "
            'Vrať JSON {"items":[{"id":12,"k_tematu":"ano","odkaz":"ne"}]}')
    task = ("odkaz = ano, když věta odkazuje na něco, co v ní samotné není řečeno (začíná „Tím…“, „To…“, „Proto…“, "
            "mluví o „tom partnerovi“ apod.), takže bez předchozí věty nedává smysl; jinak ne. Pak " + task)
    res: dict[int, str] = {}
    batches = [ids[b0: b0 + 40] for b0 in range(0, len(ids), 40)]
    retried = False
    while batches:
        batch = batches.pop(0)
        verdict = _chat_json(
            f"Zadání střihu: {instruction}\nTémata zadání: {', '.join(topics) or 'viz zadání'}\n\nVěty vybrané do střihu:\n"
            + "\n".join(f"{i} [kapitola: {an['chapters'][chapter_of[i] - 1]['title'] if chapter_of.get(i) else '?'}]: "
                        f"{segs[i]['text'].strip()}" for i in batch)
            + "\n\nU KAŽDÉ věty (ber v úvahu kapitolu) " + task,
            1200,
            schema=schema,
            backend=backend,
        )
        got: dict[int, str] = {}
        for it in verdict.get("items") or []:
            try:
                vid = int(it.get("id"))
            except (TypeError, ValueError, AttributeError):
                continue
            if vid not in batch:
                continue
            if dependent is not None and it.get("odkaz") == "ano":
                dependent.add(vid)
            if separate and it.get("tema") in topics + ["jiné"]:
                got[vid] = it["tema"]
            elif not separate and it.get("k_tematu") in ("ano", "ne"):
                got[vid] = "jiné" if it["k_tematu"] == "ne" else "téma zadání"
        # pojistka: vyřadit (skoro) všechny věty vybrané jako téma zadání je selhání modelu, ne výsledek
        # (stalo se: "jiné" u všech). Práh 90 %: při 60 % zahazovala i správný verdikt, když kandidáti z kapitoly
        # o příbuzném tématu (tramvaj) tvořili většinu – a ty pak prošly do střihu.
        if len(batch) >= 5 and sum(1 for t in got.values() if t == "jiné") >= 0.9 * len(batch):
            log(f"kontrola tématu vyřadila {sum(1 for t in got.values() if t == 'jiné')}/{len(batch)} vět – ignoruji ji")
            got = {i: t for i, t in got.items() if t != "jiné"}
        res.update(got)
        # věty, u kterých model verdikt vynechal, by jinak prošly bez kontroly – jednou se zeptej znovu jen na ně
        missing = [i for i in batch if i not in got]
        if missing and not retried:
            retried = True
            batches.append(missing)
    return res


def _pause_map(path: str, segs: dict[int, dict]) -> dict[int, bool]:
    """id věty -> je za ní skutečná pauza (ticho ve zvuku, ne jen mezera v časech Whisperu). Bez zvuku podle mezery."""
    ids = sorted(segs)

    def fs(i):
        w = segs[i].get("words") or []
        return w[0]["s"] if w else segs[i]["start"]

    def le(i):
        w = segs[i].get("words") or []
        return w[-1]["e"] if w else segs[i]["end"]

    pairs = [(le(ids[n]), fs(ids[n + 1])) for n in range(len(ids) - 1)]
    # úzké okno a 40 ms – střih tu pak padne na hranici podle časů slov a dolaďování ji najde v tomtéž tichu
    audio = audiosync.boundary_pauses(path, pairs, before=0.08, after=0.08, min_ms=40)
    out = {ids[-1]: True} if ids else {}
    for n in range(len(ids) - 1):
        # obojí: mezera v přepisu ≥ 0,12 s A ticho ve zvuku – samotný zvuk mate závěr souhlásky („nic.|Jsem“ 0,08 s),
        # samotná mezera přeslechne mluvení přes sebe („zlomilo?|Jo“ 0,14 s); ověřeno na 12 přechodech Talku
        # (čistě zvukové široké okno dalo v regresi 3/6 čistých hranic – ticho našlo jinde, než pak padl střih)
        gap_ok = pairs[n][1] - pairs[n][0] >= 0.12
        out[ids[n]] = gap_ok and (audio[n] if audio is not None else True)
    return out


def _snap_units_to_pauses(units: list[dict], segs: dict[int, dict], exclude: set,
                          pause_map: dict[int, bool] | None = None, budget: float = float("inf")) -> int:
    """Kraje vybraných celků dotáhne ke skutečné pauze (mezera ≥ 0,12 s): o větu dál (max. 3 věty,
    max. 16 s), jinak o větu zpět. Věta vystřižená ze souvislé řeči bez nádechu zní useknutě, i když střih neprotne
    slovo (Talk 2 min, 2026-11-20: 4 z 22 hranic slyšitelné). Vrací počet upravených krajů."""
    ids = sorted(segs)
    pos = {i: n for n, i in enumerate(ids)}
    PAUSE = 0.12

    def first_s(i):
        w = segs[i].get("words") or []
        return w[0]["s"] if w else segs[i]["start"]

    def last_e(i):
        w = segs[i].get("words") or []
        return w[-1]["e"] if w else segs[i]["end"]

    def pause_before(i):
        n = pos[i]
        if n == 0:
            return True
        p = ids[n - 1]
        if pause_map is not None and p in pause_map:
            return pause_map[p]
        gap = first_s(i) - last_e(p)
        # i při změně mluvčího jen skutečná mezera – v rozhovoru na sebe navazují i do 20 ms a mluví přes sebe
        return gap >= PAUSE

    def pause_after(j):
        n = pos[j]
        if n == len(ids) - 1:
            return True
        if pause_map is not None and j in pause_map:
            return pause_map[j]
        q = ids[n + 1]
        gap = first_s(q) - last_e(j)
        return gap >= PAUSE

    def usable(i, spk, taken):
        # i jiný mluvčí (otázka před odpovědí, souhlas za ní) – v rozhovoru na sebe navazují bez mezery a celá výměna
        # zní přirozeněji než střih doprostřed; jen ne mluvčí vyřazený zadáním („bez moderátora“)
        return i in segs and i not in taken and segs[i].get("speaker") not in exclude

    def dur(i):
        return segs[i]["end"] - segs[i]["start"]

    taken = {i for u in units for i in u["ids"]}
    fixed = 0
    # budget = kolik sekund smí dotažení přidat: když by prodloužení přesáhlo cíl, má přednost zkrácení o větu
    # (taky končí v pauze) – dřív se pak dorovnávalo vyhozením celých celků a ze střihu zmizelo celé téma
    left = budget
    for u in units:
        if not u.get("ids"):
            continue
        spk = segs[u["ids"][0]].get("speaker")
        # začátek
        a = u["ids"][0]
        if not pause_before(a):
            ext, n, add = [], pos[a], 0.0
            for k in range(1, 4):
                if n - k < 0 or not usable(ids[n - k], spk, taken):
                    break
                ext.insert(0, ids[n - k])
                add += dur(ids[n - k])
                if add > 16:
                    ext = []
                    break
                if pause_before(ids[n - k]):
                    break
            can_shrink = len(u["ids"]) > 1 and pause_before(u["ids"][1])
            grow = sum(dur(i) for i in ext) if ext else 0.0
            if ext and pause_before(ext[0]) and not (grow > left and can_shrink):
                u["ids"][:0] = ext
                taken.update(ext)
                left -= grow
                fixed += 1
            elif can_shrink:
                left += dur(u["ids"][0])
                taken.discard(u["ids"].pop(0))
                fixed += 1
        # konec
        b = u["ids"][-1]
        if not pause_after(b):
            ext, n, add, merged = [], pos[b], 0.0, False
            for k in range(1, 4):
                if n + k >= len(ids):
                    break
                nxt = ids[n + k]
                # dotahování narazilo na další vybraný celek -> spojit (souvislá řeč #20–#22, Talk 2 min)
                owner = next((x for x in units if x is not u and x.get("ids") and x["ids"][0] == nxt), None)
                if owner is not None:
                    u["ids"].extend(ext + owner["ids"])
                    taken.update(ext)
                    owner["ids"] = []
                    fixed += 1
                    merged = True
                    break
                if not usable(nxt, spk, taken):
                    break
                ext.append(nxt)
                add += dur(nxt)
                if add > 16:
                    ext = []
                    break
                if pause_after(nxt):
                    break
            end_ok = ext and pause_after(ext[-1]) and not re.search(r"(\.\.\.|…)\W*$", segs[ext[-1]]["text"].strip())
            can_shrink = len(u["ids"]) > 1 and pause_after(u["ids"][-2])
            grow = sum(dur(i) for i in ext) if ext else 0.0
            if merged:
                pass
            elif end_ok and not (grow > left and can_shrink):
                u["ids"].extend(ext)
                taken.update(ext)
                left -= grow
                fixed += 1
            elif can_shrink:
                left += dur(u["ids"][-1])
                taken.discard(u["ids"].pop())
                fixed += 1
        u["dur"] = sum(dur(i) for i in u["ids"])
    units[:] = [u for u in units if u.get("ids")]  # celky spojené do předchozího
    return fixed


def _passage_candidates(target: float, segs: dict[int, dict], chapters: list[dict], chosen: list[int],
                        exclude: set, pause_map: dict[int, bool] | None = None,
                        avoid: set | None = None, edge_map: dict[int, tuple[bool, bool]] | None = None) -> list[dict]:
    """Souvislé pasáže jednoho mluvčího kolem cílové délky, které začínají i končí ve skutečné pauze
    (mezi větami bez nádechu zní každý střih useknutě, i když neprotne slovo)."""
    ids = sorted(segs)
    pos = {i: n for n, i in enumerate(ids)}

    def first_s(i):
        w = segs[i].get("words") or []
        return w[0]["s"] if w else segs[i]["start"]

    def last_e(i):
        w = segs[i].get("words") or []
        return w[-1]["e"] if w else segs[i]["end"]

    # 0,12 s: v ní už bývá ticho na čistý střih (ověří refine_edges + check-cuts); 0,25 s nechalo u plynulé
    # mluvčí jen 3 kandidáty na 5 minut
    PAUSE = 0.12
    ch_score = {}
    for k, c in enumerate(chapters, 1):
        for i in range(c["from"], c["to"] + 1):
            ch_score[i] = k
    allowed_ch = set(chosen)

    def clean_start(i):
        n = pos[i]
        if segs[i].get("speaker") in exclude or ch_score.get(i) not in allowed_ch:
            return False
        txt = segs[i]["text"].strip()
        if not txt or txt[0].islower():
            return False  # pokračování předchozí věty
        if n == 0:
            return True
        if edge_map is not None and i in edge_map:
            return not edge_map[i][0]  # rozhoduje stejné měření jako kontrola po stavbě
        prev = segs[ids[n - 1]]
        if pause_map is not None and ids[n - 1] in pause_map:
            return pause_map[ids[n - 1]]
        gap = first_s(i) - last_e(ids[n - 1])
        return gap >= PAUSE

    def clean_end(j):
        n = pos[j]
        t = segs[j]["text"].strip()
        # konec věty, ne přerušená myšlenka („…v nejhorší možnou chvíli, kdy...“)
        if not re.search(r"[.!?]\W*$", t) or re.search(r"(\.\.\.|…)\W*$", t):
            return False
        if n == len(ids) - 1:
            return True
        nxt = segs[ids[n + 1]]
        # souvětí pokračuje malým písmenem u stejného mluvčího bez delší pauzy („…mohla moderovat na TN Live.“ +
        # 0,7 s + „mě posunul jako neuvěřitelně.“ – Talk IG 30 s 2026-11-21 skončil uprostřed myšlenky)
        if (nxt.get("speaker") == segs[j].get("speaker") and nxt["text"].strip()[:1].islower()
                and first_s(ids[n + 1]) - last_e(j) < 0.8):
            return False
        if edge_map is not None and j in edge_map:
            return not edge_map[j][1]
        if pause_map is not None and j in pause_map:
            return pause_map[j]
        gap = first_s(ids[n + 1]) - last_e(j)
        return gap >= PAUSE

    lo, hi = 0.6 * target, 1.25 * target
    avoid = avoid or set()
    cands = []
    for i in ids:
        # věta se slyšitelnou hranicí (avoid) nesmí být krajem pasáže, uvnitř smí. Musí se to hlídat už tady:
        # z každého začátku zůstává jen konec nejblíž cíli, takže po dodatečném vyřazení #266–271 (vadný konec #271)
        # zmizel i dobrý začátek #266 a varianta #266–270 vůbec nevznikla (Talk IG 45 s -> pasáž mimo téma)
        if i in avoid or not clean_start(i):
            continue
        spk = segs[i].get("speaker")
        best = None
        for j in ids[pos[i]:]:
            if segs[j].get("speaker") != spk or segs[j].get("speaker") in exclude:
                break
            dur = last_e(j) - first_s(i)
            if dur > hi:
                break
            if dur >= lo and j not in avoid and clean_end(j):
                if best is None or abs(dur - target) < abs(best["dur"] - target):
                    best = {"ids": ids[pos[i]: pos[j] + 1], "dur": round(dur, 1)}
        if best:
            cands.append(best)
    # stejný konec = stejná pointa, nech jen variantu nejbližší cíli
    by_end: dict[int, dict] = {}
    for c in cands:
        e = c["ids"][-1]
        if e not in by_end or abs(c["dur"] - target) < abs(by_end[e]["dur"] - target):
            by_end[e] = c
    return sorted(by_end.values(), key=lambda c: c["ids"][0])


def _plan_passage(instruction: str, target: float, segs: dict[int, dict], chapters: list[dict], chosen: list[int],
                  scores: dict[int, int], exclude: set, backend: str, ctx,
                  pause_map: dict[int, bool] | None = None, avoid: set | None = None,
                  path: str | None = None) -> dict | None:
    # avoid = věty na slyšitelné hranici (server: první věta úseku u začátku, poslední u konce). U pasáže vadí jen
    # na krajích – dřív se vyřadila každá pasáž, která ji obsahovala, a opakovaný plán sáhl po pasáži mimo téma
    # (Talk IG 30 s: správně #40–45 skóre 18,5 → po hranici #111–115 otázka moderátorky skóre 3,5)
    # Úzké téma: kraje pasáží podle stejného měření jako kontrola po stavbě (_edge_map), ne podle pauzy z přepisu –
    # dřív vznikl z každého začátku jen konec nejbližší cíli (#266–271, konec −10 dB) a čistá #265–267 vůbec ne;
    # opakování kvůli hranici pak sáhlo po pasáži mimo téma (IG 45 s: #189–196 „Ty se zabiješ?“). Obecné
    # „nejsilnější výrok“ beze změny.
    emap = _edge_map(path, segs) if path and not _GENERIC_RE.search(instruction) else None
    cands = _passage_candidates(target, segs, chapters, chosen, exclude, pause_map, avoid, emap)
    # Pasáž, kterou celou mluví moderátor (otázka, rekapitulace), není výrok ani reel – bez „bez moderátora“
    # v zadání se dřív vybral 33s monolog moderátorky „…jak vypadá tvůj pracovní den“ (Talk IG 30 s 2026-11-21).
    # Ponechá se jen, když zadání moderátora jmenuje, nebo jiná pasáž není.
    mods = _moderator_speakers(segs)
    if mods and not re.search(r"moder", instruction, re.I):
        guest = [c for c in cands if segs[c["ids"][0]].get("speaker") not in mods]
        cands = guest or cands
    if path and target <= 15:
        # Výrok do 15 s: celé „věty“ přepisu bývají dlouhé (Whisper slepí 2–3 věty), na 10 s pak nic nesedí
        # (Talk B 10 s: jediná slabá věta 7 s). Navíc jemné jednotky = věty uvnitř segmentu (fromWord/toWord).
        for c in _teaser_candidates(path, segs, exclude, avoid, lo=0.6 * target, hi1=1.25 * target,
                                    hi2=1.25 * target, max_units=6):
            c["ids"] = sorted({u["id"] for u in c["units"]})
            cands.append(c)
    if not cands:
        return None
    if len(cands) > 60:  # dlouhý materiál: přednost jádrovým kapitolám
        ch_of = {i: k for k, c in enumerate(chapters, 1) for i in range(c["from"], c["to"] + 1)}
        cands = sorted(cands, key=lambda c: -scores.get(ch_of.get(c["ids"][0]), 0))[:60]
        cands.sort(key=lambda c: c["ids"][0])
    text = lambda c: (" ".join(u["text"] for u in c["units"]) if c.get("units")  # noqa: E731
                      else " ".join(segs[i]["text"].strip() for i in c["ids"]))
    gpu.STAT_PHASE = "passage"
    rated: list[tuple[int, dict]] = []
    B = 10
    for b0 in range(0, len(cands), B):
        ctx.check()
        part = cands[b0: b0 + B]
        ctx.progress(0.3 + 0.5 * b0 / len(cands), f"LLM hodnotí pasáže {b0 + 1}–{b0 + len(part)} z {len(cands)}")
        lines = "\n".join(f"P{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(part))
        # Hodnocení po kritériích (0–3): jedno číslo 0–9 bylo u lokálního modelu nestabilní – stejný úsek dal
        # při opakování jinou vítěznou pasáž. Váhy: samostatnost, síla a zadání 2×, pointa 1,5×.
        r = _chat_json(
            f"Jsi střihač televizních pořadů. Zadání: {instruction}. Cílová délka přibližně {target:.0f} s.\n\n"
            f"Kandidáti – souvislé pasáže z rozhovoru:\n{lines}\n\n"
            "Každou pasáž ohodnoť čtyřmi čísly 0–3 jako SAMOSTATNÝ klip pro sociální sítě:\n"
            "1) samostatnost – rozumí divák hned první větě bez předchozího kontextu? (0 = začíná odkazem na dřív "
            "řečené: to, tohle, proto, takže, taky, jo, nebo jako odpověď na otázku; 3 = úplně srozumitelné)\n"
            "2) síla – jak silný, konkrétní, emotivní nebo překvapivý je obsah (0 = úvod, zdvořilost, vata; 3 = výrazný)\n"
            "3) pointa – končí uzavřenou myšlenkou nebo pointou (0 = myšlenka zůstane viset; 3 = jasná pointa)\n"
            "4) zadání – jak přesně odpovídá zadání (0 = nesouvisí; 3 = přesně)\n"
            f'Vrať JSON {{"k":[[s,i,p,z], …]}} – {len(part)} čtveřic ve stejném pořadí jako pasáže.',
            40 + 14 * len(part),
            schema={"type": "object", "properties": {"k": {"type": "array", "minItems": len(part), "maxItems": len(part),
                    "items": {"type": "array", "minItems": 4, "maxItems": 4,
                              "items": {"type": "integer", "minimum": 0, "maximum": 3}}}}, "required": ["k"]},
            backend=backend)
        for n, k4 in enumerate((r.get("k") or [])[: len(part)]):
            if isinstance(k4, list) and len(k4) == 4 and all(isinstance(x, int) for x in k4):
                part[n]["fit"] = k4[3]
                rated.append((2 * k4[0] + 2 * k4[1] + 1.5 * k4[2] + 2 * k4[3], part[n]))
    if not rated:
        return None
    # zadání jako brána, ne jen váha: silná pasáž mimo téma („Ty se zabiješ?“ o vyrovnání se smrtí) jinak přebila
    # přesnou odpověď na úzké zadání („co neříkat pozůstalým“), když ta vypadla kvůli hranici (Talk IG 45 s)
    if any(c.get("fit", 0) >= 2 for _, c in rated):
        rated = [(sc, c) for sc, c in rated if c.get("fit", 0) >= 2]

    def dependent(c: dict) -> bool:
        """Začátek navazuje na něco, co v klipu není („A najednou byl pryč.“, „Takže to bylo v tom životopise…“,
        „Absolutně.“). „Ale už jsem měla takový pocit…“ obstojí i samo – „ale“ a „pak“ se nepočítají."""
        first = (c["units"][0]["text"] if c.get("units") else segs[c["ids"][0]]["text"]).strip().lower()
        # předchozí věta téhož mluvčího skončila nedořečená („…hlavně to teda přišlo...“) a hned navazuje
        # („V nejhorším období v mém životě…“) – velké písmeno, ale je to druhá půlka souvětí (Talk IG 30 s)
        i0 = c["units"][0]["id"] if c.get("units") else c["ids"][0]
        prev = segs.get(i0 - 1)
        if (not c.get("units") and prev and prev.get("speaker") == segs[i0].get("speaker")
                and re.search(r"(\.\.\.|…)\W*$", prev["text"].strip())
                and segs[i0]["start"] - prev["end"] < 0.8):
            return True
        return bool(re.match(r"(a|takže|tak|proto|protože|no|jo|taky|to|tohle|tím|že)\b", first)) or len(first.split()) <= 2

    # Žádná samostatná pasáž neodpovídá zadání přesně (fit 3): úzké téma je v plynulé řeči rozdělené do víc míst ->
    # krátký klip složený z vět jádrových kapitol (_plan_focus). Talk IG 30 s „ze Snídaně do zpravodajství“: jediná
    # pasáž s fit 3 začínala „Jo, je to tak, takže…“ a po hranici spadla na Suchoně a běh (#61–64). Obecné skládání
    # vět (plan_edit) bylo na krátké délce horší (otázka moderátorky, útržky „Takže... Z minimum času.“).
    # Brána podle jádrových kapitol (skóre 3), ne podle fit 3 – fit u stejné pasáže kolísá mezi 2 a 3 a „focus“ pak
    # bral i obecná zadání (talk A „nejsilnější výrok o cestě k televizi“: 11 s výčtu z životopisu místo #21–25).
    core = [k for k in chosen if scores.get(k, 0) >= 3] or list(chosen)
    ch_of = {i: k for k, c in enumerate(chapters, 1) for i in range(c["from"], c["to"] + 1)}
    # Jen u úzkého tématu. Obecné „nejsilnější výrok (o …)“ hledá nejlepší místo celého materiálu – tam brána
    # i u kapitol se skóre 3 vedla do „focus“ (talk A: 4 útržky životopisu místo ucelené pasáže #21–25).
    generic = bool(_GENERIC_RE.search(instruction))

    def in_core(c: dict, ks: list[int] | None = None) -> bool:
        # podle většiny vět, ne jen první: #265–267 začíná poslední větou K30 (odpověď na otázku), zbytek je K31
        return 2 * sum(ch_of.get(i) in (ks or core) for i in c["ids"]) >= len(c["ids"])

    # jádro + sousední kapitoly téhož příběhu (skóre ≥ 2): K20 přeřazení -> K21 „Kamile, proč mi to děláš“
    near = sorted(set(core) | {k for k0 in core for k in (k0 - 1, k0 + 1) if scores.get(k, 0) >= 2})

    good = [(sc, c) for sc, c in rated if c.get("fit", 0) >= 2 and not dependent(c)
            and (generic or in_core(c))]
    if generic:
        good = good or rated  # beze změny proti dřívějšku: žádný focus
    elif good:
        # samostatná pasáž v jádru existuje -> ostatní (vedlejší kapitoly, navazující začátky) jen jako záloha finále
        rated = good + [x for x in rated if x not in good and in_core(x[1])]
    if path and not good:
        res = _plan_focus(instruction, target, segs, chapters, core, exclude, backend, ctx, path, avoid)
        if not res:
            # Jádro nemá čisté výroky, nebo je vyčerpalo opakování kvůli hranici (K20: začátek #169 −17 dB, konec #172
            # −11 dB, jinak jen #164–168 za 46 s) -> příběh pokračuje v sousední kapitole se skóre ≥ 2 (K21 Houska)
            if near != sorted(core):
                res = _plan_focus(instruction, target, segs, chapters, near, exclude, backend, ctx, path, avoid)
        if res:
            res["ranked"] = [[round(sc, 1), f"{c['ids'][0]}–{c['ids'][-1]}", c["dur"], c.get("fit")]
                             for sc, c in sorted(rated, key=lambda x: -x[0])[:8]]
            return res
        if not generic:
            # bez samostatné pasáže v jádru: záloha jen z jádra a sousedních kapitol – jinak vyhrála pasáž jiného
            # tématu bez srážky za navazující začátek (IG 30 s: #228–231 „práce jako útočiště“ po smrti mámy místo
            # #166–168 „v nejhorším období… obrovská pozitivní zkušenost“)
            rated = [x for x in rated if in_core(x[1], near)] or rated
        if avoid and not any(c.get("fit", 0) >= 2 for _, c in rated):
            # Při opakování nikdy pasáž mimo téma: Talk IG 30 s „ze Snídaně do zpravodajství“ po vyřazení #169/#172
            # spadl na běh se Suchoněm (#59–64, fit 1). Prázdný plán = server nechá předchozí verzi i s varováním.
            log(f"passage: po hranici {sorted(avoid)} nic k zadání (fit ≥ 2) – ponechá se předchozí plán")
            return {"note": "Po vyřazení vět se slyšitelnou hranicí nezbyla žádná pasáž k zadání.", "picks": [],
                    "estimatedSec": 0, "alternates": [], "dropped": [], "mode": "passage", "passages": len(cands),
                    "ranked": [[round(sc, 1), f"{c['ids'][0]}–{c['ids'][-1]}", c["dur"], c.get("fit")]
                               for sc, c in sorted(rated, key=lambda x: -x[0])[:8]],
                    "editorial": [], "thesis": None, "keyChapters": core, "offTopic": [], "topics": [],
                    "balanceTopics": False, "general": False, "topicSec": {}, "addedForQuestionAnswer": [],
                    "fixedFragments": []}

    def adjusted(sc: float, c: dict) -> float:
        # model začátky odkazující dozadu podle promptu nestrhává
        if dependent(c):
            sc -= 3
        if c["dur"] > 1.15 * target or c["dur"] < 0.75 * target:
            sc -= 1.5
        return sc

    rated = [(adjusted(sc, c), c) for sc, c in rated]
    rated.sort(key=lambda x: (-x[0], abs(x[1]["dur"] - target)))
    # do finále jen pasáže, které po srážkách zůstaly nahoře – jinak model v přímém srovnání vrátil vyřazený
    # začátek („Absolutně. My jsme nechápali…“) a srážky by nic neznamenaly
    # Finále rozhoduje líp než dávkové hodnocení (to u úseku A dalo ucelené pasáži 13 bodů z 22), proto do něj
    # jde širší výběr. Navazující začátky jen tehdy, když jiné nejsou – v přímém srovnání je model bral za „dramatické“.
    near = [(sc, c) for sc, c in rated if sc >= rated[0][0] - 8]
    top = [c for _, c in near if not dependent(c)][:5] or [c for _, c in near][:4]
    pick = top[0]
    reason = None
    if len(top) > 1:
        # finále: přímé srovnání nejlepších (hodnocení po dávkách nemá společné měřítko). Model nejdřív krátce
        # zdůvodní (pole „uvaha“ před číslem = přemýšlení v mezích gramatiky) – bez toho bral doslovnou shodu
        # se slovy zadání („cesta na Novu“ z výčtu životopisu) před ucelenou myšlenkou s pointou.
        ctx.progress(0.85, "LLM vybírá nejlepší pasáž")
        lines = "\n".join(f"P{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(top))
        r = _chat_json(
            f"Jsi zkušený střihač televizních pořadů. Zadání: {instruction}. Cílová délka přibližně {target:.0f} s.\n\n"
            f"{lines}\n\n"
            "Vyber pasáž, která bude nejlepší jako samostatný klip na sociální sítě. Rozhoduje: 1) první věta je "
            "srozumitelná bez předchozího kontextu, 2) jde o osobní, silnou nebo překvapivou myšlenku (ne výčet faktů), "
            "3) končí pointou, 4) odpovídá zadání. Nejdřív v poli uvaha krátce (2–3 věty) porovnej pasáže, pak dej číslo.",
            350, schema={"type": "object", "properties": {"uvaha": {"type": "string", "maxLength": 600},
                                                          "p": {"type": "integer", "minimum": 1, "maximum": len(top)}},
                         "required": ["uvaha", "p"]}, backend=backend)
        if isinstance(r.get("p"), int) and 1 <= r["p"] <= len(top):
            pick = top[r["p"] - 1]
            reason = r.get("uvaha")
    alts = [i for c in top if c is not pick for i in c["ids"]]
    return {
        "note": None, "picks": _teaser_picks(pick) if pick.get("units") else pick["ids"], "estimatedSec": pick["dur"],
        "alternates": alts, "dropped": [],
        "mode": "passage", "passages": len(cands),
        # žebříček pro ladění: [skóre po srážkách, první–poslední věta, délka]
        "ranked": [[round(sc, 1), f"{c['ids'][0]}–{c['ids'][-1]}", c["dur"], c.get("fit")] for sc, c in rated[:8]],
        "reason": reason,
        "editorial": [], "thesis": None, "keyChapters": [],
        "offTopic": [], "topics": [], "balanceTopics": False, "general": False, "topicSec": {},
        "addedForQuestionAnswer": [], "fixedFragments": [],
    }


# obecné zadání „nejsilnější/nejlepší výrok (o …)“ = nejlepší místo celého materiálu, ne úzké téma
_GENERIC_RE = re.compile(r"nejsiln|nejzajímav|nejzajimav|nejlepší|nejlepsi|nejvtipn|nejemotivn|nejpůsobiv|"
                         r"nejpusobiv|nejvýrazn|nejvyrazn", re.I)
# příběh v kostce přes víc etap („cesta od herečky přes stáž až k moderátorce“) – jedna pasáž ho nepokryje
_STORY_RE = re.compile(r"v kostce|ve zkratce|celý příběh|celou cestu|\bod\s[^.;:]{2,60}?\s(přes|až)\s", re.I)
_ANSWER_WORDS = re.compile(r"^(absolutně|jo|ano|ne|jasně|určitě|přesně|no|dobře|tak)\W*$", re.I)
_TEASER_SCORES: dict[tuple, float] = {}  # (zdroj, zadání, text úderu) -> skóre; platí po dobu běhu Workeru


def _teaser_candidates(path: str, segs: dict[int, dict], exclude: set, avoid: set | None = None,
                       lo: float = 1.2, hi1: float = 8.0, hi2: float = 9.0, max_units: int = 2,
                       loose_start: bool = False, closed_before: bool = False) -> list[dict]:
    """Krátké samostatné výroky pro upoutávku. Jednotka = věta podle interpunkce slov, i uvnitř segmentu přepisu
    (Whisper slepí „Za tři týdny. Takže to přišlo…“ do jednoho – úder „Za tři týdny.“ by jinak neexistoval).
    Kandidát = 1–2 navazující věty jednoho mluvčího, 1,2–8 s, začátek i konec ve skutečné pauze (mezera ≥ 0,12 s
    a ticho ve zvuku), dokončená věta, za ní nepokračuje souvětí. „A najednou byl pryč.“ smí – v upoutávce je to úder."""
    units = []  # {id, w0, w1, s, e, text, spk}
    for sid in sorted(segs):
        ws = segs[sid].get("words") or []
        start = 0
        for k, w in enumerate(ws):
            end_tok = re.search(r"[.!?]$", w["w"]) and not re.search(r"(\.\.\.|…)$", w["w"])
            if end_tok or k == len(ws) - 1:
                piece = ws[start: k + 1]
                if piece:
                    units.append({"id": sid, "w0": start, "w1": k, "s": piece[0]["s"], "e": piece[-1]["e"],
                                  "text": " ".join(x["w"] for x in piece), "spk": segs[sid].get("speaker"),
                                  "full": start == 0 and k == len(ws) - 1, "closed": bool(end_tok)})
                start = k + 1
    if not units:
        return []
    pairs = [(units[n]["e"], units[n + 1]["s"]) for n in range(len(units) - 1)]
    pause_ms = audiosync.boundary_pauses(path, pairs, return_ms=True)
    # 70 ms: plynulá mluvčí dělá mezi větami nejčastěji 60–100 ms (Talk C: s 90 ms jediný kandidát na 5 minut);
    # vadné hranice pak zachytí kontrola zvuku v plan_edit_local (opakování / vyřazení úderu)
    pause_after = [(pause_ms[n] >= 70 if pause_ms is not None else pairs[n][1] - pairs[n][0] >= 0.12)
                   for n in range(len(pairs))] + [True]
    edge_ms = (pause_ms or [500.0] * len(pairs)) + [500.0]  # délka ticha za jednotkou (poslední = konec souboru)

    def ok_start(n):
        u = units[n]
        t = u["text"].strip()
        if u["spk"] in exclude or not t or t[0].islower() or _ANSWER_WORDS.match(t):
            return False
        if n and not pause_after[n - 1]:
            return False
        # skládaný příběh: předchozí věta téhož mluvčího musí být dořečená („…ten jeho sen je ve finále potom
        # jako...“ + „Moderovat nějaký pořad…“ jako hák reelu navazoval na nevyřčené – Talk IG 60 s)
        if closed_before and n and units[n - 1]["spk"] == u["spk"] and not units[n - 1]["closed"]:
            return False
        if loose_start:  # skládaný klip (focus): navazovat smí, samostatnost prvního výroku hodnotí model
            return True
        # „To byl prostě můj nejbližší člověk.“ je v upoutávce úder (zvědavost) – „to/tohle“ se nevyřazuje, zkreslení
        # hlídá kontrola kontextu; spojky navazující na předchozí myšlenku ano
        # výčet („Za třetí je to…“, „Navíc…“) bez předchozího bodu nedává smysl (debata 2026-11-20)
        return not re.match(r"(takže|tak|proto|protože|no|jo|taky|tím|že|za (prvé|druhé|třetí|čtvrté)|zaprvé|zadruhé|"
                            r"zatřetí|navíc|dále|zároveň|také|další)\b", t.lower())

    def ok_end(n):
        u = units[n]
        if not u["closed"] or not pause_after[n]:
            return False
        nxt = units[n + 1] if n + 1 < len(units) else None
        # souvětí pokračuje malým písmenem u stejného mluvčího -> myšlenka by zůstala viset
        return not (nxt and nxt["spk"] == u["spk"] and nxt["text"][:1].islower())

    out = []
    for n in range(len(units)):
        if not ok_start(n) or (avoid and units[n]["id"] in avoid):
            continue
        for k in range(max_units):
            m = n + k
            if m >= len(units) or units[m]["spk"] != units[n]["spk"] or (avoid and units[m]["id"] in avoid):
                break
            d = units[m]["e"] - units[n]["s"]
            if d > hi2:
                break
            if lo <= d <= (hi1 if k == 0 else hi2) and ok_end(m):
                out.append({"units": units[n: m + 1], "dur": round(d, 1),
                            # nejkratší ticho na krajích (ms): krátká pauza = větší riziko slyšitelné hranice
                            "edge_ms": min(edge_ms[n - 1] if n else 500.0, edge_ms[m]),
                            # těsně před úderem otázka jiného mluvčího (úder je odpověď – sám bez ní nedává smysl)
                            "prev_q": bool(n and units[n - 1]["text"].strip().endswith("?")
                                           and (units[n - 1]["spk"] != units[n]["spk"] or units[n]["spk"] is None)
                                           and units[n]["s"] - units[n - 1]["e"] < 1.5),
                            # okolí pro kontrolu vytržení z kontextu
                            "before": " ".join(u["text"] for u in units[max(0, n - 2): n]),
                            "after": " ".join(u["text"] for u in units[m + 1: m + 3])})
    return out


def _clean_reason(t):
    """Úvaha modelu pro uživatele: schéma ji utne na maxLength uprostřed slova a model tam občas sklouzne do azbuky
    („…otázka -> vysvětл“, AI tok S8) – slova s azbukou pryč, utnutý konec zkrátit na poslední celou větu."""
    if not isinstance(t, str):
        return t
    t = " ".join(w for w in t.split() if not re.search(r"[\u0400-\u04FF]", w)).strip()
    if t and not re.search(r"[.!?…)\]]$", t):
        k = max(t.rfind(". "), t.rfind("! "), t.rfind("? "))
        t = t[: k + 1] if k > len(t) // 3 else t + "…"
    return t


def _teaser_cut_check(path: str, segs: dict[int, dict], cands: list[dict]) -> list[dict]:
    """Vyřadí kandidáty, jejichž hranice by kontrola po stavbě (server edgeWarnings) označila za střih skrz řeč –
    stejná předpověď jako u skládaného reelu (_edge_check: poloha střihu jako server + doladění podle zvuku).
    Pauza nalezená až za dalším slovem (boundary_pauses hledá 0,3 s za ním – „životopis.|Ale“, ticho až za „Ale“)
    se střihem nedá zasáhnout: dřív takové údery prošly, po stavbě je vyřadilo opakování plánu a z upoutávky 20 s
    zbylo 6,5 s (noc 2026-11-23). Když by zbyly méně než 2 údery, nechá všechny (rozhodne server)."""
    chk = _edge_check(path, segs, [(c["units"][0]["s"], c["units"][-1]["e"]) for c in cands])
    if chk is None:
        return cands
    good = [c for c, (bi, bo) in zip(cands, chk) if not (bi or bo)]
    return good if len(good) >= 2 else cands


def _teaser_picks(c: dict) -> list:
    """Kandidát -> picks pro stavbu: celá věta přepisu jako číslo, část věty jako {id, fromWord, toWord}."""
    out = []
    for u in c["units"]:
        if out and isinstance(out[-1], dict) and out[-1]["id"] == u["id"] and out[-1]["toWord"] == u["w0"] - 1:
            out[-1]["toWord"] = u["w1"]  # dvě věty z jednoho segmentu za sebou
        else:
            out.append(u["id"] if u["full"] else {"id": u["id"], "fromWord": u["w0"], "toWord": u["w1"]})
    return out


def _plan_focus(instruction: str, target: float, segs: dict[int, dict], chapters: list[dict], core: list[int],
                exclude: set, backend: str, ctx, path: str, avoid: set | None = None) -> dict | None:
    """Krátký klip na úzké téma, které v plynulé řeči neleží v jedné pasáži s pauzou na krajích (Talk IG 30 s
    „ze Snídaně do zpravodajství“: šok #164 → škola #169 → zpětně pozitivní #172). Věty z jádrových kapitol se
    ohodnotí podle zadání a 2–4 se složí v pořadí, jak zazněly (logika děje, žádné přeskládání)."""
    ch_of = {i: k for k, c in enumerate(chapters, 1) for i in range(c["from"], c["to"] + 1)}
    mods = _moderator_speakers(segs) if not re.search(r"moder", instruction, re.I) else set()
    cands = [c for c in _teaser_candidates(path, segs, exclude | mods, avoid, lo=2.0, hi1=0.7 * target,
                                           hi2=0.7 * target, max_units=4, loose_start=True,
                                           closed_before=True)
             if all(ch_of.get(u["id"]) in core for u in c["units"])]
    if len(cands) < 2:
        return None
    # výroky s předvídatelně slyšitelnou hranicí pryč (K20: začátek #169 −17 dB, konec #172 −11 dB) – bez čistých
    # výroků v jádru zkusí volající i sousední kapitolu příběhu
    chk = _edge_check(path, segs, [_cand_span(c, segs) for c in cands])
    if chk:
        n0 = len(cands)
        cands = [c for c, (b0, b1) in zip(cands, chk) if not (b0 or b1)]
        log(f"focus: kapitoly {core}, čisté hranice {len(cands)}/{n0} výroků")
        if len(cands) < 2:
            return None
    # stejný začátek: nech nejdelší variantu do 0,7× cíle (méně kandidátů = rychlejší a stabilnější hodnocení)
    by_start: dict[tuple, dict] = {}
    for c in cands:
        k = (c["units"][0]["id"], c["units"][0]["w0"])
        if k not in by_start or c["dur"] > by_start[k]["dur"]:
            by_start[k] = c
    cands = sorted(by_start.values(), key=lambda c: (c["units"][0]["s"]))[:40]
    text = lambda c: " ".join(u["text"] for u in c["units"])  # noqa: E731
    gpu.STAT_PHASE = "focus"
    rated: list[tuple[float, dict]] = []
    B = 12
    for b0 in range(0, len(cands), B):
        ctx.check()
        part = cands[b0: b0 + B]
        ctx.progress(0.4 + 0.35 * b0 / len(cands), f"LLM hodnotí věty k zadání {b0 + 1}–{b0 + len(part)} z {len(cands)}")
        lines = "\n".join(f"V{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(part))
        r = _chat_json(
            f"Jsi střihač. Zadání krátkého klipu: {instruction}\n\nVýroky z rozhovoru:\n{lines}\n\n"
            "Každý výrok ohodnoť dvěma čísly 0–3: 1) zadání – jak přímo říká to, o čem má klip být (0 = jiné téma, "
            "3 = přesně jádro); 2) srozumitelnost – rozumí mu divák bez předchozího kontextu, bez vaty a odboček.\n"
            f'Vrať JSON {{"k":[[z,s], …]}} – {len(part)} dvojic ve stejném pořadí.',
            30 + 8 * len(part),
            schema={"type": "object", "properties": {"k": {"type": "array", "minItems": len(part), "maxItems": len(part),
                    "items": {"type": "array", "minItems": 2, "maxItems": 2,
                              "items": {"type": "integer", "minimum": 0, "maximum": 3}}}}, "required": ["k"]},
            backend=backend)
        for n, k2 in enumerate((r.get("k") or [])[: len(part)]):
            if isinstance(k2, list) and len(k2) == 2 and all(isinstance(x, int) for x in k2) and k2[0] >= 2:
                rated.append((3 * k2[0] + 2 * k2[1], part[n]))
    if len(rated) < 2:
        return None
    key = lambda c: {(u["id"], u["w0"]) for u in c["units"]}  # noqa: E731
    rated.sort(key=lambda x: -x[0])
    top: list[dict] = []
    for _, c in rated:
        if not any(key(c) & key(t) for t in top):
            top.append(c)
        if len(top) >= 10:
            break
    top.sort(key=lambda c: c["units"][0]["s"])  # v pořadí, jak zazněly
    ctx.progress(0.8, "LLM skládá klip")
    lines = "\n".join(f"V{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(top))
    r = _chat_json(
        f"Jsi střihač sociálních sítí. Zadání: {instruction}. Cílová délka {target:.0f} s.\n\n"
        f"Výroky v pořadí, jak v rozhovoru zazněly:\n{lines}\n\n"
        f"Vyber 2–4 výroky, které dohromady srozumitelně vypoví to, co chce zadání (začátek → vývoj → pointa), "
        f"součet délek co nejblíž {target:.0f} s. Výroky se nesmí opakovat ani říkat totéž. První musí být srozumitelný "
        'bez kontextu. Nejdřív v poli uvaha krátce zdůvodni, pak čísla. JSON {"uvaha": "…", "vyber": [čísla]}.',
        350, schema={"type": "object", "properties": {"uvaha": {"type": "string", "maxLength": 600},
                                                      "vyber": {"type": "array", "minItems": 1, "maxItems": 4,
                                                                "items": {"type": "integer", "minimum": 1, "maximum": len(top)}}},
                     "required": ["uvaha", "vyber"]}, backend=backend)
    order = sorted({n for n in (r.get("vyber") or []) if isinstance(n, int) and 1 <= n <= len(top)})
    chosen = [top[n - 1] for n in order] or top[:2]
    # délka: přidej další nejlépe hodnocený (v časovém pořadí), který se vejde; nad 1,25× ubírej nejslabší vnitřní
    by_score = [c for _, c in rated if c in top]
    for c in by_score:
        if sum(x["dur"] for x in chosen) >= 0.85 * target:
            break
        if c not in chosen and sum(x["dur"] for x in chosen) + c["dur"] <= 1.15 * target:
            chosen.append(c)
    chosen.sort(key=lambda c: c["units"][0]["s"])
    while len(chosen) > 2 and sum(c["dur"] for c in chosen) > 1.25 * target:
        chosen.remove(max(chosen[1:-1] or chosen[1:], key=by_score.index))  # nejhůř hodnocený vnitřní
    total = sum(c["dur"] for c in chosen)
    return {
        "note": None, "picks": [p for c in chosen for p in _teaser_picks(c)], "estimatedSec": round(total, 1),
        "alternates": [u["id"] for c in top if c not in chosen for u in c["units"]], "dropped": [],
        "mode": "focus", "passages": len(cands), "reason": _clean_reason(r.get("uvaha")),
        "spares": [{"picks": _teaser_picks(c), "dur": c["dur"], "ids": sorted({u["id"] for u in c["units"]})}
                   for c in top if c not in chosen][:6],
        "editorial": [], "thesis": None, "keyChapters": core,
        "offTopic": [], "topics": [], "balanceTopics": False, "general": False, "topicSec": {},
        "addedForQuestionAnswer": [], "fixedFragments": [],
    }


def _edge_check(path: str, segs: dict[int, dict], spans: list[tuple[float, float]]) -> list[tuple[bool, bool]] | None:
    """Předpověď kontroly hranic po stavbě (server: cutBounds -> refineOutPoints -> edgeWarnings) pro úseky
    (začátek prvního slova, konec posledního): [(vadný začátek, vadný konec)]; vadná = nad -12 dB proti řeči, nebo nad -20 dB
    uvnitř slova. Výběr podle pauzy ≥ 70 ms jinak pouštěl hranice, které stavba pak hlásila – u skládaného reelu
    (5 úseků = 10 hranic) vadných 5 z 10 a dvě opakování plánu nestačila (Talk IG 60 s, #169/#172 u IG 30 s)."""
    words = sorted((w for s in segs.values() for w in (s.get("words") or [])), key=lambda w: w["s"])
    if not words or not spans:
        return None
    import bisect
    starts = [w["s"] for w in words]
    ends_sorted = sorted(w["e"] for w in words)
    G = 0.02
    pts, meta = [], []
    for a, b in spans:
        k = bisect.bisect_right(ends_sorted, a + 1e-3)
        prev_end = ends_sorted[k - 1] if k else None
        k2 = bisect.bisect_left(starts, b - 1e-3)
        next_start = starts[k2] if k2 < len(starts) else None
        lo = a - 0.08 if prev_end is None else max(a - 0.08, prev_end + G)
        t_in = max(0.0, min(lo, a))
        min_in = 0.0 if prev_end is None else min(prev_end + G, a)
        ceil = float("inf") if next_start is None else next_start - G
        t_out = max(min(b + 0.15, ceil), b)
        max_out = max(ceil, b)
        pts.append({"at": t_out, "direction": "end",
                    "maxExtend": max(0.0, min(0.4, max_out - t_out - 0.02)) if max_out != float("inf") else 0.4})
        pts.append({"at": t_in, "direction": "start", "maxExtend": max(0.0, min(0.3, t_in - min_in + 0.1)),
                    "fallbackExtend": max(0.0, min(0.3, t_in - min_in - 0.02)), "word": a})
    try:
        ref = audiosync.refine_edges({"path": path, "points": pts}, None)["points"]
        edges = []
        for n in range(len(spans)):
            edges += [{"t": ref[2 * n + 1]["time"], "kind": "in"}, {"t": ref[2 * n]["time"], "kind": "out"}]
        lev = audiosync.edge_levels({"path": path, "edges": edges}, None)["edges"]
    except Exception as e:  # noqa: BLE001 – bez zvuku se nepředpovídá
        log(f"edge_check: {e}")
        return None

    def bad(e: dict) -> bool:
        t = e["t"]
        k = bisect.bisect_right(starts, t - 0.01)
        inside = any(w["s"] < t - 0.01 and w["e"] > t + 0.01 for w in words[max(0, k - 3): k])
        return e["rel"] > -12 or (inside and e["rel"] > -20)

    if len(lev) != 2 * len(spans):
        return None
    return [(bad(lev[2 * n]), bad(lev[2 * n + 1])) for n in range(len(spans))]


_EDGE_MAPS: dict[tuple, dict[int, tuple[bool, bool]]] = {}


def _edge_map(path: str, segs: dict[int, dict]) -> dict[int, tuple[bool, bool]] | None:
    """Věta -> (vadný začátek, vadný konec), když se stříhá na její kraj (celá věta, časy segmentu jako ve stavbě)."""
    try:
        key = (os.path.abspath(path), os.path.getmtime(path), len(segs), max(segs))
    except OSError:
        return None
    if key not in _EDGE_MAPS:
        ids = sorted(segs)
        chk = _edge_check(path, segs, [(segs[i]["start"], segs[i]["end"]) for i in ids])
        if chk is None:
            return None
        _EDGE_MAPS.clear()
        _EDGE_MAPS[key] = dict(zip(ids, chk))
    return _EDGE_MAPS[key]


def _cand_span(c: dict, segs: dict[int, dict]) -> tuple[float, float]:
    """Časy úseku tak, jak je postaví server: celá věta = časy segmentu, část věty = časy slov."""
    if c.get("units"):
        u0, u1 = c["units"][0], c["units"][-1]
        return (segs[u0["id"]]["start"] if u0.get("full") else u0["s"],
                segs[u1["id"]]["end"] if u1.get("full") else u1["e"])
    return segs[c["ids"][0]]["start"], segs[c["ids"][-1]]["end"]


def _chapter_text(c: dict, segs: dict[int, dict], skip_speakers: set, limit: int = 700) -> str:
    """Co v kapitole skutečně zaznělo (bez moderátora), zkrácené: začátek + konec (pointa bývá na konci)."""
    t = " ".join(segs[i]["text"].strip() for i in range(c["from"], c["to"] + 1)
                 if i in segs and segs[i].get("speaker") not in skip_speakers)
    t = re.sub(r"\s+", " ", t)
    return t if len(t) <= limit else t[: int(limit * 0.65)] + " … " + t[-int(limit * 0.35):]


def _verify_core(instruction: str, chapters: list[dict], scores: dict[int, int], segs: dict[int, dict],
                 exclude: set, backend: str) -> dict[int, int]:
    """Druhé hodnocení kapitol se skóre ≥ 2 podle jejich TEXTU, všechny v jednom dotazu (srovnání vedle sebe).
    Hodnocení podle názvu a shrnutí osnovy kolísá: K8 „Reakce rodiny a první reportáž“ dostala pro „ze Snídaně do
    zpravodajství – šok a slzy“ jednou 2, jindy 3 a pasáž o běhu se Suchoněm (#61–64) pak přebila K20 (Talk IG 30 s)."""
    cand = sorted((k for k in scores if scores[k] >= 2), key=lambda k: (-scores[k], k))[:8]
    if not cand:
        return {}
    cand.sort()
    skip = exclude | _moderator_speakers(segs)
    lines = "\n".join(f"{n + 1}) {chapters[k - 1]['title']}: „{_chapter_text(chapters[k - 1], segs, skip)}“"
                      for n, k in enumerate(cand))
    gpu.STAT_PHASE = "verify"
    r = _chat_json(
        f"Jsi střihač. Zadání krátkého klipu: {instruction}\n\nKapitoly rozhovoru (název a co v nich host skutečně "
        f"říká):\n{lines}\n\n"
        "U každé kapitoly urči 0–3, jak přímo její TEXT vypráví to, o čem má klip být: 3 = přesně téma zadání (klip "
        "se dá postavit z ní), 2 = souvisí, téma zazní jen částečně, 1 = jen společné slovo, osoba nebo období, "
        "0 = jiné téma. Rozhoduje, o čem kapitola opravdu je, ne shoda jednoho slova. "
        f'Vrať JSON {{"s":[…]}} – {len(cand)} čísel ve stejném pořadí jako kapitoly.',
        60, schema={"type": "object", "properties": {"s": {"type": "array", "items": {"type": "integer",
                    "enum": [0, 1, 2, 3]}, "minItems": len(cand), "maxItems": len(cand)}}, "required": ["s"]},
        backend=backend)
    ver = {k: v for k, v in zip(cand, r.get("s") or []) if isinstance(v, int)}
    if len(ver) != len(cand) or max(ver.values()) < 2:
        return {}  # model shodil všechno (zadání formulované jinak než kapitoly) -> nevěřit mu
    # Jen potvrzení nebo shození jádra (skóre 3), nikdy povýšení: druhé hodnocení povýšilo K21 (Houska, „proč mě
    # odtrháváš“) na 3 a focus pak vzal #173–175 místo K20 se šokem a školou. Vedlejší kapitoly (2) jsou v dotazu
    # jen pro srovnání vedle sebe.
    core = [k for k in cand if scores[k] >= 3]
    # Shodit jde jen kapitolu, kde host opravdu mluví: K30 (otázka moderátorky + „Často rozhodně nezahojí.“) vyšla
    # z textu na 2 a pasáž #265–267, která v ní začíná, pak vypadla z jádra (Talk IG 45 s)
    talk = {k: len(_chapter_text(chapters[k - 1], segs, skip, 10 ** 6)) for k in core}
    out = {k: min(scores[k], ver[k]) for k in core if ver[k] < scores[k] and talk[k] >= 200}
    if core and all(k in out for k in core):
        keep = max(core, key=lambda k: (ver[k], -k))  # aspoň jedna jádrová zůstane – ta, kterou text potvrdil nejvíc
        out.pop(keep)
    return out


def _plan_story(instruction: str, target: float, segs: dict[int, dict], chapters: list[dict], scores: dict[int, int],
                exclude: set, backend: str, ctx, path: str, avoid: set | None = None) -> dict | None:
    """Krátký reel, který v kostce vypráví příběh přes víc etap („cesta od herečky přes neplacenou stáž až
    k moderátorce“). Zadání -> 2–4 etapy v časovém pořadí, kapitoly -> etapy, v každé etapě samostatné uzavřené
    výroky hosta (jednotky z _teaser_candidates: začátek i konec v pauze, souvětí nepokračuje), model ohodnotí
    etapu, samostatnost a hák. Pořadí: hák, pak etapy chronologicky; moderátorka jen při „otázka/odpověď“.
    Obecné skládání vět tu dávalo otázku moderátorky na začátek a utnuté souvětí na konec (Talk IG 60 s)."""
    gpu.STAT_PHASE = "story"
    ctx.progress(0.12, "LLM dělí zadání na etapy")
    r = _chat_json(
        f"Zadání krátkého klipu: {instruction}\n\nRozděl příběh, který má klip vyprávět, na 2–4 etapy v časovém pořadí "
        '(každá krátce, 2–6 slov, podle zadání). JSON {"etapy": ["…", …]}.',
        120, schema={"type": "object", "properties": {"etapy": {"type": "array", "minItems": 2, "maxItems": 4,
                     "items": {"type": "string", "maxLength": 60}}}, "required": ["etapy"]}, backend=backend)
    stages = [str(x).strip() for x in (r.get("etapy") or []) if str(x).strip()][:4]
    if len(stages) < 2:
        return None
    st_list = "\n".join(f"{n}) {s}" for n, s in enumerate(stages, 1))
    ks = [k for k in range(1, len(chapters) + 1) if scores.get(k, 0) >= 1] or list(range(1, len(chapters) + 1))
    # kapitola -> etapy. Pro každou etapu zvlášť čísla kapitol (celá osnova najednou, rozhovor jde chronologicky):
    # pole „etapa ke každé kapitole“ po dávkách 12 bylo nespolehlivé – etapa „moderátorka“ nedostala nic
    # a „Kariérní cesta a moderování“ skončila v etapě „herečka“ (Talk IG 60 s)
    outline = "\n".join(f"K{k}: {chapters[k - 1]['title']} – {chapters[k - 1]['summary']}" for k in ks)
    stage_of: dict[int, set[int]] = {}
    for e, st in enumerate(stages, 1):
        ctx.check()
        r = _chat_json(
            f"Zadání klipu: {instruction}\nEtapy příběhu (v časovém pořadí):\n{st_list}\n\n"
            f"Osnova rozhovoru (kapitoly jdou za sebou, jak zazněly):\n{outline}\n\n"
            f"Ve kterých kapitolách host vypráví etapu {e}) {st}? Jen kapitoly, ze kterých jde tuhle etapu "
            'odvyprávět jeho slovy (ne kapitoly, kde je jen zmíněná). JSON {"k": [čísla kapitol]}.',
            80, schema={"type": "object", "properties": {"k": {"type": "array", "maxItems": 8, "items": {
                "type": "integer", "enum": ks}}}, "required": ["k"]}, backend=backend)
        for k in r.get("k") or []:
            if isinstance(k, int) and k in ks:
                stage_of.setdefault(k, set()).add(e)
    if len({e for v in stage_of.values() for e in v}) < 2:
        log(f"story: etapy {stages}, kapitoly {stage_of} – málo etap")
        return None
    ch_of = {i: k for k, c in enumerate(chapters, 1) for i in range(c["from"], c["to"] + 1)}
    # moderátorka jen u otázky a odpovědi – „k moderátorce“ v zadání je etapa příběhu, ne mluvčí
    mods = set() if re.search(r"otázk|otazk", instruction, re.I) else _moderator_speakers(segs)
    n_st = len(stages)
    ideal = target / (n_st + 0.5)
    # až 6 vět a 0,45× cíle: v plynulé řeči má čisté hranice jen asi čtvrtina výroků (IG 60 s: 9 z 35)
    raw = _teaser_candidates(path, segs, exclude | mods, avoid, lo=2.5, hi1=min(0.45 * target, 27.0),
                             hi2=min(0.45 * target, 27.0), max_units=6, closed_before=True)
    best_ids = {i for c in chapters for i in (c.get("best") or [])}
    # etapy kandidáta = sjednocení etap kapitol jeho vět: výrok přes hranici kapitol („A potom mě vlastně dali do
    # Snídaně s Novou…“ #127 v K15 + „A tam se začala formovat moje moderátorská zkušenost.“ #128 v K16) by průnik zahodil
    per_stage: dict[int, list[dict]] = {}
    for c in raw:
        # pozdrav a poděkování za úvod („Krásný den, Kristýnku, děkuji…“) model hodnotil jako etapu i hák
        # „Jsi byla malička.“ = vstup moderátorky, který Whisper přilepil k větě hostky (oslovení na začátku výroku)
        if re.match(r"(krásný|dobrý) (den|večer)|ahoj|děkuj|díky|dobré ráno|(ty )?(jsi|seš|jseš) ",
                    c["units"][0]["text"].strip(), re.I):
            continue
        c["stages"] = set().union(*(stage_of.get(ch_of.get(u["id"]), set()) for u in c["units"]))
        for e in c["stages"]:
            per_stage.setdefault(e, []).append(c)
    # Výroky s předvídatelně slyšitelnou hranicí pryč ještě před hodnocením (první plán IG 60 s měl po stavbě vadných
    # 5 z 10 hranic, opakování pak skládalo z čím dál horších zbytků). Etapa bez čistého výroku si nechá původní.
    staged = [c for c in raw if c.get("stages")]
    chk = _edge_check(path, segs, [_cand_span(c, segs) for c in staged])
    if chk:
        ok = {id(c) for c, (b0, b1) in zip(staged, chk) if not (b0 or b1)}
        # Jen čisté. Zkoušeno: etapa s < 3 čistými výroky si nechá i vadné se srážkou ve skóre – hák a závěr pak
        # vyšly z vadných („…pamatuju.|Jsi byla“ −2 dB, „debat.|Já jsem“ −7 dB) a opakování plánu to nespravilo.
        # Etapa bez čistého výroku radši vypadne (reel je kratší, ale bez useknutého slova).
        for e in list(per_stage):
            per_stage[e] = [c for c in per_stage[e] if id(c) in ok]
            if not per_stage[e]:
                del per_stage[e]
        log(f"story: čisté hranice {len(ok)}/{len(staged)} výroků")
    pool: list[dict] = []
    for e, lst in per_stage.items():
        # ze stejného začátku nejkratší (hák) a nejbližší ideální délce etapy
        by_start: dict[tuple, list[dict]] = {}
        for c in lst:
            by_start.setdefault((c["units"][0]["id"], c["units"][0]["w0"]), []).append(c)
        keep = []
        for vs in by_start.values():
            keep.append(min(vs, key=lambda c: c["dur"]))
            near = min(vs, key=lambda c: abs(c["dur"] - ideal))
            if near is not keep[-1]:
                keep.append(near)
        # nejvýš 20 na etapu: přednost výrokům s nejlepšími větami kapitol (osnova), pak časové pořadí
        keep.sort(key=lambda c: (-len({u["id"] for u in c["units"]} & best_ids), c["units"][0]["s"]))
        pool += [c for c in keep[:20] if not any(c is x for x in pool)]
    pool.sort(key=lambda c: (c["units"][0]["s"], c["dur"]))
    log(f"story: etapy {stages}, kapitoly {dict(sorted((k, sorted(v)) for k, v in stage_of.items()))}, "
        f"kandidáti {dict(sorted((e, len(v)) for e, v in per_stage.items()))}, hodnotí se {len(pool)}")
    if len(per_stage) < 2:
        return None
    text = lambda c: " ".join(u["text"] for u in c["units"])  # noqa: E731
    key = lambda c: {(u["id"], u["w0"]) for u in c["units"]}  # noqa: E731
    # Hodnocení jedním průchodem se všemi etapami: model řekne, KTEROU etapu výrok vypráví. Hodnocení po etapách
    # zvlášť bylo mírné – „nikomu jsem to neřekla a poslala životopis“ dostalo 3 i pro etapu „herečka“.
    rated: list[tuple[float, dict]] = []
    B = 12
    for b0 in range(0, len(pool), B):
        ctx.check()
        part = pool[b0: b0 + B]
        ctx.progress(0.3 + 0.45 * b0 / max(1, len(pool)), f"LLM hodnotí výroky {b0 + 1}–{b0 + len(part)} z {len(pool)}")
        lines = "\n".join(f"V{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(part))
        r = _chat_json(
            f"Jsi střihač sociálních sítí. Zadání: {instruction}\nEtapy příběhu:\n{st_list}\n\n"
            f"Výroky hosta:\n{lines}\n\n"
            "Každý výrok ohodnoť čtyřmi čísly: 1) etapa – číslo etapy, kterou výrok vypráví (0 = žádnou, jiné téma "
            "nebo jen zmínka); 2) síla 0–3 – jak přímo a výstižně tu etapu vypráví; 3) samostatnost 0–3 – rozumí mu "
            "divák bez předchozího kontextu, nezačíná ani nekončí uprostřed myšlenky, bez vaty a odboček; "
            "4) hák 0–3 – vzbudí emoci nebo zvědavost hned na začátku klipu. "
            f'Vrať JSON {{"k":[[etapa,sila,samostatnost,hak], …]}} – {len(part)} čtveřic ve stejném pořadí.',
            30 + 13 * len(part),
            schema={"type": "object", "properties": {"k": {"type": "array", "minItems": len(part),
                    "maxItems": len(part), "items": {"type": "array", "minItems": 4, "maxItems": 4,
                                                     "items": {"type": "integer", "minimum": 0, "maximum": 3}}}},
                    "required": ["k"]}, backend=backend)
        for n, k4 in enumerate((r.get("k") or [])[: len(part)]):
            if not (isinstance(k4, list) and len(k4) == 4 and all(isinstance(x, int) for x in k4)):
                continue
            e, sila, samo, hak = k4
            c = part[n]
            # etapa musí sedět i s kapitolou (model občas přiřadí etapu podle jednoho slova)
            if e in c["stages"] and sila >= 2 and samo >= 2:
                c["stage"], c["hook"] = e, hak
                rated.append((3 * sila + 2 * samo + hak, c))
    if len({c["stage"] for _, c in rated}) < 2:
        log(f"story: ohodnoceno {len(rated)} výroků v etapách {sorted({c['stage'] for _, c in rated})} – málo")
        return None
    rated.sort(key=lambda x: -x[0])
    score = {id(c): sc for sc, c in rated}
    top: list[dict] = []  # nejvýš 4 nepřekrývající se na etapu
    for _, c in rated:
        if sum(1 for t in top if t["stage"] == c["stage"]) < 4 and not any(key(c) & key(t) for t in top):
            top.append(c)
    top.sort(key=lambda c: c["units"][0]["s"])
    ctx.progress(0.8, "LLM skládá příběh")
    # hák = krátký úder; 22s výklad o konzervatoři jako „hák“ (Talk IG 60 s) diváka v prvních vteřinách nechytí
    hook_max = max(8.0, 0.2 * target)
    # kandidáti na hák: krátké výroky s hodnocením háku ≥ 2 (i mimo nejlepší čtyři své etapy)
    hooks = [c for _, c in rated if c["dur"] <= hook_max and c.get("hook", 0) >= 2]
    for c in sorted(hooks, key=lambda c: (-c["hook"], -score[id(c)]))[:3]:
        if c not in top and not any(key(c) & key(t) for t in top):
            top.append(c)
    top.sort(key=lambda c: c["units"][0]["s"])
    can_hook = lambda c: (c in hooks) if hooks else c["dur"] <= hook_max  # noqa: E731
    lines = "\n".join(f"V{n + 1} [etapa {c['stage']}] ({c['dur']:.0f} s{', může být hák' if can_hook(c) else ''})"
                      f": {text(c)}" for n, c in enumerate(top))
    r = _chat_json(
        f"Jsi střihač sociálních sítí. Zadání: {instruction}. Cílová délka {target:.0f} s.\nEtapy:\n{st_list}\n\n"
        f"Výroky v pořadí, jak v rozhovoru zazněly:\n{lines}\n\n"
        "Sestav reel: první výrok je hák (jen výrok označený „může být hák“ – silná emoce nebo "
        "zvědavost, chytí diváka v prvních vteřinách), pak z každé etapy 1, nejvýš 2 výroky v časovém pořadí, které "
        "ji srozumitelně vypoví. Poslední výrok je pointa: cíl, ke kterému cesta vede, už dosažený – ne jen přání "
        f"nebo plán. Výroky se nesmí opakovat ani říkat totéž, součet délek co nejblíž {target:.0f} s. "
        'Nejdřív v poli uvaha krátce zdůvodni, pak číslo háku a čísla ostatních výroků. '
        'JSON {"uvaha": "…", "hak": číslo, "vyber": [čísla]}.',
        400, schema={"type": "object", "properties": {
            "uvaha": {"type": "string", "maxLength": 600},
            "hak": {"type": "integer", "minimum": 1, "maximum": len(top)},
            "vyber": {"type": "array", "minItems": 1, "maxItems": 2 * n_st,
                      "items": {"type": "integer", "minimum": 1, "maximum": len(top)}}},
            "required": ["uvaha", "hak", "vyber"]}, backend=backend)
    hk = r.get("hak")
    picked = [hk] + list(r.get("vyber") or [])
    hook = top[hk - 1] if isinstance(hk, int) and 1 <= hk <= len(top) else None
    if hook is None or not can_hook(hook):
        # dlouhý nebo slabý „hák“ zůstane ve výběru jako výrok etapy, hákem bude nejsilnější krátký
        short = [c for c in top if can_hook(c)]
        hook = max(short or top, key=lambda c: (c.get("hook", 0), score[id(c)], -c["dur"]))
    body: list[dict] = []
    for n in picked:
        if isinstance(n, int) and 1 <= n <= len(top):
            c = top[n - 1]
            if c is not hook and c not in body and not any(key(c) & key(x) for x in body + [hook]):
                body.append(c)
    # hák z pozdější etapy jde dopředu (flash-forward) – svou etapu v chronologii nezastoupí
    hook_covers = hook["stage"] == min(c["stage"] for c in top)
    covered = lambda: ({hook["stage"]} if hook_covers else set()) | {c["stage"] for c in body}  # noqa: E731
    # každá etapa aspoň jedním výrokem (model občas etapu vynechá – pak to není „cesta od … přes … až“)
    for e in sorted({c["stage"] for c in top} - covered()):
        alt = [c for c in top if c["stage"] == e and not any(key(c) & key(x) for x in body + [hook])]
        if alt:
            body.append(max(alt, key=lambda c: score[id(c)]))
    total = lambda: hook["dur"] + sum(c["dur"] for c in body)  # noqa: E731
    # délka: nad 1,2× ubírej nejslabší výrok etapy, která má víc výroků; pod 0,85× přidej nejlepší, který se vejde,
    # do etapy s nejmenším zastoupením
    while total() > 1.2 * target:
        extra = [c for c in body if sum(1 for x in body if x["stage"] == c["stage"])
                 + (hook_covers and hook["stage"] == c["stage"]) > 1]
        if not extra:
            break
        body.remove(min(extra, key=lambda c: score[id(c)]))
    # pořád nad 1,25× (každá etapa má jen jeden, ale dlouhý výrok): uber nejslabší, i za cenu etapy – 60s reel
    # nesmí mít 80 s
    while total() > 1.25 * target and len(body) > 1:
        body.remove(min(body, key=lambda c: score[id(c)]))
    while total() < 0.85 * target:
        secs = {e: sum(c["dur"] for c in body + [hook] if c["stage"] == e) for e in {c["stage"] for c in top}}
        add = [c for c in top if c is not hook and c not in body and not any(key(c) & key(x) for x in body + [hook])
               and total() + c["dur"] <= 1.15 * target]
        if not add:
            break
        body.append(min(add, key=lambda c: (secs.get(c["stage"], 0), -score[id(c)])))
    body.sort(key=lambda c: c["units"][0]["s"])
    order = [hook] + body
    return {
        "note": None, "picks": [p for c in order for p in _teaser_picks(c)], "estimatedSec": round(total(), 1),
        "alternates": [u["id"] for c in top if c not in order for u in c["units"]], "dropped": [],
        "mode": "story", "passages": len(raw), "reason": _clean_reason(r.get("uvaha")), "stages": stages,
        "stageChapters": {e: sorted(k for k, s in stage_of.items() if e in s) for e in range(1, n_st + 1)},
        "spares": [{"picks": _teaser_picks(c), "dur": c["dur"], "ids": sorted({u["id"] for u in c["units"]})}
                   for c in top if c not in order][:6],
        "ranked": [[round(sc, 1), c["stage"], text(c)[:60], c["dur"]] for sc, c in rated[:10]],
        "editorial": [], "thesis": None, "keyChapters": sorted(stage_of),
        "offTopic": [], "topics": [], "balanceTopics": False, "general": False, "topicSec": {},
        "addedForQuestionAnswer": [], "fixedFragments": [],
    }


_CONJ_START = re.compile(r"(a|ale|i|aby|a pak|a najednou|a tak|a proto|takže)\b", re.I)
# příčinná souvislost uvnitř úderu („…a proto jsem se dostala na Novu“) – za pozdějším úderem vyzní jako jeho důsledek
# začátek odpovědi, která bez své otázky nedává smysl („Všechno, naprosto všechno…“ na „Co všechno se zbortí?“, AI tok S11)
_ANSWER_START = re.compile(r"(všechno|nic|nikdy|vždycky|jo|ne|ano|určitě|rozhodně|asi|přesně|samozřejmě|jasně|vůbec|absolutně|"
                           r"hodně|strašně|no|tak určitě|to je)\b", re.I)
# úder začínající odkazem na předchozí („To je jedna z nejlepších věcí…“ za „…byla pryč“ – AI tok S12): jen jako první (hák)
# nebo hned za svou původní předchozí větou, jinak ho divák vztáhne k cizímu úderu
_REF_START = re.compile(r"(to ne\w+|to je|to byl|to byla|to bylo|to byly|tohle|tohleto|tenhle|tahle|tohle je|právě to|takže to)\b", re.I)
_PAD = 0.3  # rezerva střihu na úder (padBefore + padAfter + doladění) – odhad délky stavby
_CAUSAL = re.compile(r"\b(proto|takže|díky tomu|kvůli tomu|tím pádem|a tak)\b", re.I)
# zdvořilosti na začátku a konci rozhovoru – v upoutávce nejsou úder (noc 2026-11-23: 30s upoutávka končila
# „Děkuji moc za pozvání, Kristýnko.“)
# zdvořilosti a organizace pořadu – jen ustálené fráze (revize S14: „Nestihli jsme se s mámou rozloučit“, „Na závěr…“,
# „Příště…“, „Děkujeme všem hasičům…“ jsou silné údery, ne zdvořilost)
_SMALLTALK = re.compile(r"(^|[.!?]\s+)(děkuj\w*( moc| mockrát| vám| ti)* za (pozvání|rozhovor|příležitost)|ahoj\b|dobrý (den|večer)\b|na shledanou|vítej\w*\b|vítám\w*\b|mějte se|krásný zbytek|to je pro dnešek|v příštím díle|(uvidíme|slyšíme|těšíme) se( zase)? (příště|za týden|v dalším)|děkujeme( vám| všem)? (za (pozornost|sledování|pozvání|rozhovor)|že jste (se dívali|byli))|máme (ještě )?(dvě|pár|tři|jen|už) minut\w*|nestihli jsme (to )?(rozebrat|probrat|všechno))|za pozvání", re.I)
# organizace pořadu – vyřadí i úder, který na ni přímo navazuje („Máme dvě minuty.“ → „To vždycky uteče…“)
_SHOW_LOGISTICS = re.compile(r"máme (ještě )?(dvě|pár|tři|jen|už) minut\w*|nestihli jsme (to )?(rozebrat|probrat|všechno)|čas (nám )?(utíká|vypršel|došel)", re.I)


# krátká věta se zájmenem bez předchůdce („My jsme neměli možnost se na to připravit.“, „Není věc, kterou bych ji
# neřekla.“) nebo úlomek („Často rozhodně nezahojí.“) – mimo hák jen hned za svou předchozí větou (AI tok S15: máma ani
# úmrtí v upoutávce nezazněly, „na to“ znělo jako nástup na Novu)
_ANAPHOR = re.compile(r"\b(ji|jí|ona|ho|mu|jemu|její|jeho|na to|o tom|kvůli tomu|s ním|s ní|po tom|před tím)\b", re.I)


def _is_ref(t: str) -> bool:
    t = (t or "").strip()
    if _REF_START.match(t):
        return True
    first = re.split(r"(?<=[.!?…])\s+", t)[0]
    words = first.split()
    if len(re.findall(r"\w+", t)) <= 4:
        return True
    return len(words) <= 12 and bool(_ANAPHOR.search(first))


def _teaser_host(cands: list, instruction: str):
    """Moderátor/ka = mluvčí s nejkratší řečí mezi kandidáty (aspoň 2 mluvčí). None, když zadání moderátora výslovně chce
    („bez moderátorky“ ho naopak vylučuje – revize #14)."""
    if re.search(r"moder", instruction, re.I) and not re.search(r"\bbez\s+moder", instruction, re.I):
        return None
    spk: dict = {}
    for c in cands:
        for u in c["units"]:
            if u.get("spk"):
                spk[u["spk"]] = spk.get(u["spk"], 0.0) + (u["e"] - u["s"])
    return min(spk, key=lambda k: spk[k]) if len(spk) >= 2 else None


def _teaser_bad_spare(c: dict, text, host) -> bool:
    """Náhradník, který server vkládá po vyřazení úderu kvůli hranici, nesmí být otázka ani úder moderátora (AI tok S8)."""
    return text(c).strip().endswith("?") or (host is not None and c["units"][0].get("spk") == host)


def _teaser_guard(order: list, cands: list, top: list, instruction: str, target: float, text, key) -> list:
    """Kontrola složené upoutávky bez modelu (AI tok S3/S4/S8 – Hermes pravidla v zadání ignoroval):
    1) úder začínající spojkou („A najednou byl pryč.“) bez vlastního podmětu divák vztáhne k předchozímu úderu
       („…věci s ním.“ → zemřel respondent, ne máma). Když před ním ve střihu nestojí jeho původní předchozí věta,
       nahradí se delší variantou, která ji obsahuje, jinak vypadne;
    2) otázka (končí „?“) jen se svou odpovědí (úder, který v rozhovoru následuje hned po ní); jinak vypadne, a když
       by zbyl jediný úder, nahradí ji nejlepší úder hosta;
    3) moderátor/ka nejvýš jedním úderem, když zadání moderátora výslovně nechce; délka se doplní údery hosta tam,
       kam časově patří (mezi údery nebo za poslední)."""
    first = lambda c: c["units"][0]["id"]  # noqa: E731
    last = lambda c: c["units"][-1]["id"]  # noqa: E731
    st0 = lambda c: c["units"][0]["s"]  # noqa: E731
    host = _teaser_host(cands, instruction)
    out: list = []
    for c in order:
        prev = out[-1] if out else None
        if _CONJ_START.match(text(c).strip()) and not (prev and last(prev) == first(c) - 1):
            alt = [x for x in cands if last(x) == last(c) and first(x) == first(c) - 1
                   and x["units"][0].get("spk") == c["units"][0].get("spk") and not any(key(x) & key(y) for y in out)]
            if alt:
                out.append(min(alt, key=lambda x: x["dur"]))
                continue
            if len(order) > 2:
                continue
        out.append(c)
    order = out or order
    fixed: list = []
    for i, c in enumerate(order):
        nxt = order[i + 1] if i + 1 < len(order) else None
        if text(c).strip().endswith("?") and not (nxt and 0 < first(nxt) - last(c) <= 2):
            # nejdřív dohledat skutečnou odpověď (úder hned po otázce v rozhovoru) a dát ji za otázku (AI tok S8)
            ans = [x for x in cands if 0 < first(x) - last(c) <= 2 and x["units"][0].get("spk") != c["units"][0].get("spk")
                   and not any(key(x) & key(y) for y in order)]
            if ans:
                fixed.extend([c, min(ans, key=lambda x: (first(x), x["dur"]))])
                continue
            alt = [x for x in top if x not in order and not _teaser_bad_spare(x, text, host)
                   and not _CONJ_START.match(text(x).strip()) and not any(key(x) & key(y) for y in order)]
            if alt and len(order) - 1 < 2:
                fixed.append(alt[0])  # top je seřazené podle hodnocení modelu
                continue
            if len(order) > 1:
                continue  # otázka s cizí odpovědí zavádí – radši kratší upoutávka (AI tok S8)
        fixed.append(c)
    if fixed != order:
        order = sorted(fixed, key=st0)
    # 4) úder s příčinnou spojkou, který v rozhovoru zazněl DŘÍV než úder před ním (noc 2026-11-23: krize z 21. minuty →
    #    „…a proto jsem se dostala na Novu“ ze 2. minuty – Hermes pravidlo v zadání ignoroval): vypadne, při dvou úderech
    #    se pořadí srovná podle času (délku pak doplní údery hosta na chronologická místa)
    for i in range(len(order) - 1, 0, -1):
        if i < len(order) and st0(order[i]) < st0(order[i - 1]) and _CAUSAL.search(text(order[i])):
            if len(order) > 2:
                order.pop(i)
            else:
                order = sorted(order, key=st0)
    if host is not None:
        # moderátor/ka nejvýš jedním úderem – přednost má otázka, za kterou hned stojí její odpověď (jinak by vypadla otázka
        # a v upoutávce zůstala osamělá odpověď „Všechno, naprosto všechno…“, AI tok S11)
        hosts = [c for c in order if c["units"][0].get("spk") == host]
        def _answered(c):
            i = order.index(c)
            return text(c).strip().endswith("?") and i + 1 < len(order) and 0 < first(order[i + 1]) - last(c) <= 2
        keep = next((c for c in hosts if _answered(c)), hosts[0] if hosts else None)
        for c in hosts:
            if c is not keep and len(order) > 2:
                order.remove(c)
        # dlouhý úder moderátora (AI tok S11: 9 s z 19 s = 48 %) – upoutávka je o hostovi
        for c in [c for c in order if c["units"][0].get("spk") == host]:
            if len(order) >= 2 and c["dur"] > 0.3 * target:  # délku pak dorovná doplnění níž
                order.remove(c)
    # 5) odpověď bez své otázky („Všechno, naprosto všechno…“ bez „Co všechno se zbortí?“) – vypadne
    for c in list(order):
        i = order.index(c)
        asked = i > 0 and 0 < first(c) - last(order[i - 1]) <= 1
        if c.get("prev_q") and _ANSWER_START.match(text(c).strip()) and not asked and len(order) >= 2:
            order.remove(c)
    if not order:  # pojistka – pravidla nesmí upoutávku vyprázdnit (Hermes vybral jen otázky a úvod moderátorky)
        ok = [x for x in top if not _teaser_bad_spare(x, text, host) and not _CONJ_START.match(text(x).strip())
              and not (x.get("prev_q") and _ANSWER_START.match(text(x).strip()))]
        order = sorted((ok or top)[:2], key=st0)
    # 6) odkazovací začátek mimo první místo bez své předchozí věty – vypadne (doplnění délky pak dorovná)
    for c in list(order):
        i = order.index(c)
        if i > 0 and _is_ref(text(c)) and last(order[i - 1]) != first(c) - 1 and len(order) >= 2:
            order.remove(c)
    est = lambda o: sum(x["dur"] for x in o) + _PAD * len(o)  # noqa: E731 – délka stavby i s rezervami střihu
    for c in top:
        if est(order) >= 0.85 * target:
            break
        if c in order or _teaser_bad_spare(c, text, host) or any(key(c) & key(y) for y in order) \
                or _CONJ_START.match(text(c).strip()) or est(order) + c["dur"] + _PAD > 1.1 * target \
                or (c.get("prev_q") and _ANSWER_START.match(text(c).strip())) or _is_ref(text(c)):
            continue
        slot = next((i for i in range(1, len(order)) if st0(order[i - 1]) < st0(c) < st0(order[i])), None)
        if slot is None and order and st0(c) > st0(order[-1]):
            slot = len(order)  # za poslední úder, když zazněl později (AI tok S4: upoutávka jen 10,7 s z 20)
        if slot is None and order and st0(c) < st0(order[0]) and all(st0(a) < st0(b) for a, b in zip(order, order[1:])) \
                and not _is_ref(text(order[0])):
            slot = 0  # před první úder, jen když jdou údery chronologicky – jinak je první hák z pozdější části (revize)
        if slot is not None:
            order.insert(slot, c)
    if order and _is_ref(text(order[0])) and est(order) < 0.7 * target and len(order) >= 2:
        order.pop(0)
        for c in top:
            if est(order) >= 0.85 * target:
                break
            if c in order or _teaser_bad_spare(c, text, host) or any(key(c) & key(y) for y in order) \
                    or _CONJ_START.match(text(c).strip()) or _is_ref(text(c)) \
                    or est(order) + c["dur"] + _PAD > 1.1 * target or (c.get("prev_q") and _ANSWER_START.match(text(c).strip())):
                continue
            order.append(c)
            order.sort(key=st0)
    # odkazující začátek se mohl po doplnění dostat za cizí úder – znovu (AI tok S12)
    for c in list(order):
        i = order.index(c)
        if i > 0 and _is_ref(text(c)) and last(order[i - 1]) != first(c) - 1 and len(order) > 2:
            order.remove(c)
    # pojistka: žádná věta dvakrát (náhrada úderu se spojkou hlídala překryv jen s údery před ní – noc 2026-11-23:
    # 30s upoutávka měla #213 dvakrát za sebou)
    uniq: list = []
    for c in order:
        if not any(key(c) & key(y) or {u["id"] for u in c["units"]} & {u["id"] for u in y["units"]} for y in uniq):
            uniq.append(c)
    return uniq


def _plan_teaser(instruction: str, target: float, segs: dict[int, dict], exclude: set, backend: str, ctx,
                 path: str, avoid: set | None = None) -> dict | None:
    """Upoutávka ve stylu zpravodajství: údery ohodnotí model (hák, samostatnost, údernost), pak z nejlepších složí
    2–4 v pořadí hák → … → napětí na konec (s krátkou úvahou), délka se dorovná celými údery."""
    cands = _teaser_candidates(path, segs, exclude, avoid)
    if len(cands) < 2:
        return None
    # zdvořilosti a organizace pořadu – i úder, který na takovou větu přímo navazuje („Máme dvě minuty.“ → „To vždycky uteče…“)
    cands = [c for c in cands if not _SMALLTALK.search(" ".join(u["text"] for u in c["units"]))
             and not _SHOW_LOGISTICS.search(re.split(r"(?<=[.!?…])\s+", (c.get("before") or "").strip())[-1] if c.get("before") else "")] or cands
    n_all = len(cands)
    cands = _teaser_cut_check(path, segs, cands)
    ctx.progress(0.28, f"Hranice úderů ověřené podle zvuku: {len(cands)} z {n_all} kandidátů lze čistě střihnout")
    text = lambda c: " ".join(u["text"] for u in c["units"])  # noqa: E731
    key = lambda c: {(u["id"], u["w0"]) for u in c["units"]}  # noqa: E731
    gpu.STAT_PHASE = "teaser"
    rated: list[tuple[float, dict]] = []
    # hodnocení úderů z dřívějšího plánu (opakování kvůli slyšitelné hranici) se nepočítá znovu – ušetří ~20 s
    todo = []
    for c in cands:
        sc = _TEASER_SCORES.get((path, instruction, text(c)))
        if sc is None:
            todo.append(c)
        else:
            rated.append((sc, c))
    B = 15
    for b0 in range(0, len(todo), B):
        ctx.check()
        part = todo[b0: b0 + B]
        ctx.progress(0.3 + 0.45 * b0 / max(1, len(todo)), f"LLM hodnotí údery {b0 + 1}–{b0 + len(part)} z {len(todo)}")
        lines = "\n".join(f"U{n + 1} ({c['dur']:.0f} s): {text(c)}" for n, c in enumerate(part))
        r = _chat_json(
            f"Jsi střihač zpravodajských upoutávek. Zadání: {instruction}\n\nKrátké výroky z rozhovoru:\n{lines}\n\n"
            "Každý výrok ohodnoť třemi čísly 0–3 jako ÚDER do upoutávky:\n"
            "1) hák – vzbudí emoci, napětí nebo zvědavost, chce se divák dívat dál? (0 = informační/nudné, 3 = silné)\n"
            "2) samostatnost – je srozumitelný sám a vytržený z kontextu NEZMĚNÍ význam? (0 = navazuje na něco "
            "nevyřčeného, nebo je to citace cizích slov, ironie či fráze, kterou mluvčí odmítá – např. co jí říkají "
            "druzí a ona to nechce slyšet; 3 = jasný vlastní výrok)\n"
            "3) údernost – krátký, citovatelný, bez vaty a odboček (0 = rozvláčný, 3 = úderný)\n"
            f'Vrať JSON {{"k":[[h,s,u], …]}} – {len(part)} trojic ve stejném pořadí.',
            30 + 11 * len(part),
            schema={"type": "object", "properties": {"k": {"type": "array", "minItems": len(part), "maxItems": len(part),
                    "items": {"type": "array", "minItems": 3, "maxItems": 3,
                              "items": {"type": "integer", "minimum": 0, "maximum": 3}}}}, "required": ["k"]},
            backend=backend)
        for n, k3 in enumerate((r.get("k") or [])[: len(part)]):
            if isinstance(k3, list) and len(k3) == 3 and all(isinstance(x, int) for x in k3):
                sc = 3 * k3[0] + 2 * k3[1] + 1.5 * k3[2]
                _TEASER_SCORES[(path, instruction, text(part[n]))] = sc
                rated.append((sc, part[n]))
    if len(rated) < 2:
        return None
    # úder s krátkou pauzou na kraji (< 150 ms) často vyjde se slyšitelnou hranicí, pak se vyřadí a upoutávka zkrátí
    # (20s upoutávka po vyřazení 12 s) – radši rovnou přednost úderům s výraznou pauzou
    rated = [(sc - (1.5 if c.get("edge_ms", 500) < 150 else 0), c) for sc, c in rated]
    rated.sort(key=lambda x: -x[0])
    top: list[dict] = []  # bez překryvů (věta sama i s následující) – nechat lepšího
    for _, c in rated:
        if not any(key(c) & key(t) for t in top):
            top.append(c)
        if len(top) >= 12:
            break
    # Kontrola vytržení z kontextu s okolními větami: bez nich model nepozná citovanou frázi („Jí už je teď dobře.“ –
    # Bára tak cituje, co truchlící slyšet nechtějí; vytržené to zní, jako by máma byla v pořádku).
    ctx.progress(0.75, "LLM kontroluje kontext úderů")
    lines = "\n".join(f"U{n + 1}: „{text(c)}“\n   před: …{c['before'][-160:]}\n   po: {c['after'][:160]}…"
                      for n, c in enumerate(top))
    r = _chat_json(
        "Jsi editor zpravodajství a hlídáš, aby střih nezkreslil, co člověk řekl. U každého úderu vidíš, co zaznělo "
        f"před ním a po něm:\n{lines}\n\n"
        "Které údery by vytržené z kontextu změnily význam? Typicky: citace cizích slov nebo frází, které mluvčí "
        "odmítá (následuje „to nepotřebujeme slyšet“, „to nepomáhá“), ironie, nadsázka, řečnická otázka, na kterou "
        "hned odpoví opak, nebo věta, kterou okolí popírá. Vrať JSON {\"spatne\": [čísla úderů]} (prázdné pole, když nic).",
        80, schema={"type": "object", "properties": {"spatne": {"type": "array", "items": {"type": "integer",
                    "minimum": 1, "maximum": len(top)}}}, "required": ["spatne"]}, backend=backend)
    bad = {n for n in (r.get("spatne") or []) if isinstance(n, int) and 1 <= n <= len(top)}
    distorted = [text(top[n - 1]) for n in sorted(bad)]
    bad_keys = set().union(*[key(top[n - 1]) for n in bad]) if bad else set()
    if len([c for c in top if not key(c) & bad_keys]) >= 2:
        top = [c for c in top if not key(c) & bad_keys]
    elif len(top) - len(bad) >= 2:
        top = [c for n, c in enumerate(top, 1) if n not in bad]
    # zásoba pro doplnění délky v kontrole bez modelu: dalších (horších) až 30 úderů bez překryvů – po vyřazení úderů
    # moderátora a osamělých odpovědí 12 nestačilo (30s upoutávka 18,9 s); zkreslující (kontrola kontextu) ne
    pool: list[dict] = list(top)
    for _, c in rated:
        if len(pool) >= 30:
            break
        if c not in pool and text(c) not in distorted and not key(c) & bad_keys and not any(key(c) & key(t) for t in pool):
            pool.append(c)
    ctx.progress(0.8, "LLM skládá upoutávku")
    # čas v rozhovoru u každého úderu: model vidí, co zaznělo dřív a co později (AI tok S2: „…a proto jsem se dostala
    # na Novu“ z 2. minuty stálo hned za smrtí mámy z 21. minuty a vyznělo jako její důsledek)
    mmss = lambda x: f"{int(x // 60)}:{int(x % 60):02d}"  # noqa: E731
    lines = "\n".join(f"U{n + 1} [{c['units'][0].get('spk') or '?'}] ({c['dur']:.0f} s, v rozhovoru {mmss(c['units'][0]['s'])}): {text(c)}"
                      for n, c in enumerate(top))
    speakers = {c["units"][0].get("spk") for c in top if c["units"][0].get("spk")}
    r = _chat_json(
        f"Jsi střihač zpravodajských upoutávek (TV Nova). Zadání: {instruction}. Cílová délka {target:.0f} s.\n\n"
        f"Vybrané údery (v hranatých závorkách mluvčí):\n{lines}\n\n"
        f"Sestav upoutávku ze 2–4 úderů v pořadí, jak půjdou za sebou, součet délek co nejblíž {target:.0f} s. "
        "První úder je hák (nejsilnější emoce nebo otázka), poslední nechá diváka v napětí a neprozradí rozuzlení. "
        + ("Mluví víc lidí: ukaž střet názorů – postav proti sobě údery různých mluvčích. " if len(speakers) > 1 else "") +
        "Údery se nesmí opakovat ani říkat totéž; dohromady mají naznačit příběh. Nesmí zkreslit, co mluvčí myslí: "
        "žádné citace cizích slov, ironie ani věty, které mluvčí odmítá (vytržené by znamenaly opak). Pořadí nesmí "
        "vytvořit souvislost, která v rozhovoru není: úder, který zazněl dřív a týká se jiného období nebo tématu, "
        "nedávej hned za pozdější tak, aby vyzněl jako jeho důsledek (např. „…a proto…“ po větě o úmrtí). Úder bez "
        "vlastního podmětu („A najednou byl pryč.“) divák vztáhne k osobě z předchozího úderu – dej ho jen za úder o "
        "téže osobě. Upoutávka je hlavně o hostovi: moderátor/ka nejvýš jeden krátký úder (otázka), když je potřeba. "
        'Nejdřív v poli uvaha krátce zdůvodni, pak dej pořadí čísel úderů. JSON {"uvaha": "…", "poradi": [čísla]}.',
        400, schema={"type": "object", "properties": {"uvaha": {"type": "string", "maxLength": 600},
                                                      "poradi": {"type": "array", "minItems": 1, "maxItems": 5,
                                                                 "items": {"type": "integer", "minimum": 1, "maximum": len(top)}}},
                     "required": ["uvaha", "poradi"]}, backend=backend)
    order: list[dict] = []
    for n in r.get("poradi") or []:
        if isinstance(n, int) and 1 <= n <= len(top) and top[n - 1] not in order:
            order.append(top[n - 1])
    if not order:
        order = top[:2]
    # délka: nad 1,25× cíle ubírej prostřední údery (hák a konec drž), pod 0,85× přidej další nejlepší, který se vejde
    # (20s upoutávka měla s mezí 0,7× jen 15,5 s)
    while len(order) > 2 and sum(c["dur"] for c in order) > 1.2 * target:
        order.remove(max(order[1:-1], key=lambda c: c["dur"]))
    # Pozn.: výměna delšího úderu za kratší „podle skóre“ (kvůli délce) rozbila děj – doprostřed upoutávky o smrti
    # mámy vložila větu o práci reportérky. Raději o pár sekund delší upoutávka než nesouvislá (2026-11-20).
    # doplnění délky: jen tam, kam úder časově patří (mezi dva údery, které zazněly před ním a po něm) – jinak by
    # vznikla souvislost, která v rozhovoru není (AI tok S2, viz výš)
    st0 = lambda c: c["units"][0]["s"]  # noqa: E731
    for c in top:
        if sum(x["dur"] for x in order) + _PAD * len(order) >= 0.85 * target:
            break
        if c in order or sum(x["dur"] for x in order) + _PAD * (len(order) + 1) + c["dur"] > 1.1 * target:
            continue
        slot = next((i for i in range(1, len(order)) if st0(order[i - 1]) < st0(c) < st0(order[i])), None)
        if slot is None and order and st0(c) > st0(order[-1]):
            slot = len(order)
        if slot is not None:
            order.insert(slot, c)
    before = [id(c) for c in order]
    order = _teaser_guard(order, cands, pool, instruction, target, text, key)
    total = sum(c["dur"] for c in order)
    reason = _clean_reason(r.get("uvaha"))
    if [id(c) for c in order] != before:
        # kontrola bez modelu výběr změnila – úvaha modelu by popisovala jiné věty (AI tok S11)
        reason = "Údery (výběr upravila kontrola bez modelu): " + " → ".join(f"„{text(c)[:60]}{'…' if len(text(c)) > 60 else ''}“" for c in order)
    return {
        "note": None, "picks": [p for c in order for p in _teaser_picks(c)], "estimatedSec": round(total, 1),
        "alternates": [u["id"] for c in top if c not in order for u in c["units"]], "dropped": [],
        "mode": "teaser", "passages": len(cands), "reason": reason, "distorted": distorted,
        # náhradní údery (nejlépe hodnocené mimo upoutávku): server je vloží, když kvůli slyšitelné hranici vyřadí úder
        "spares": [{"picks": _teaser_picks(c), "dur": c["dur"], "ids": sorted({u["id"] for u in c["units"]})}
                   for c in top if c not in order and not _teaser_bad_spare(c, text, _teaser_host(cands, instruction))][:6],
        "ranked": [[round(sc, 1), text(c)[:60], c["dur"]] for sc, c in rated[:8]],
        "editorial": [], "thesis": None, "keyChapters": [], "offTopic": [], "topics": [], "balanceTopics": False,
        "general": False, "topicSec": {}, "addedForQuestionAnswer": [], "fixedFragments": [],
    }


def plan_edit(params: dict, ctx) -> dict:
    """Plán střihu čistě lokálně: LLM vybere kapitoly a věty podle zadání, pak dorovnání na cílovou délku."""
    path = params["path"]
    instruction = params["instruction"]
    target = float(params.get("targetSec") or 0)
    # věty, jejichž hranice stavba nahlásila jako slyšitelné (server je pošle při opakovaném plánu – uzavřená smyčka)
    avoid = {int(i) for i in (params.get("avoid") or [])}
    backend = params.get("backend") or "auto"
    if backend == "auto":  # Hermes (externí, rychlejší a přesnější), když běží; jinak vlastní model
        backend = gpu.auto_backend()
    t_start = time.time()
    gpu.CALL_STATS.clear()
    tr, _ = load_transcript(path)
    # skutečné pauzy mezi větami ze zvuku (jednou na plán, ~3 s u 30 min) – střih jen tam, kde je ticho
    pause_map = _pause_map(path, {s["id"]: s for s in tr["segments"]})
    segs = {s["id"]: s for s in tr["segments"]}
    # "bez moderátora" v zadání -> jeho věty vyhoď natvrdo (model to sám nedodrží spolehlivě).
    # "bez úvodních a organizačních vět moderátora" – mezi "bez" a "moder…" může být víc slov (v rámci jedné fráze)
    # agent zadání občas přeformuluje ("Vynech … věty moderátora") – nejen "bez"
    no_moderator = re.search(r"(\bbez\b|vynech|nechci|žádn|nevybírej|nedávej)[^.;:(),]{0,60}?(moder|otázek|organiza)",
                             instruction, re.I)
    exclude = _moderator_speakers(segs) if no_moderator else set()
    # "co říká vypravěč", "jen výroky Vašíře" -> ostatní mluvčí model vůbec neuvidí. Sám to u filmu nedržel
    # (u "co říká vypravěč" vzal i 60 s jiného mluvčího). Jméno se hledá podle kmene (skloňování).
    only = _speakers_named(instruction, {s.get("speaker") for s in segs.values() if s.get("speaker")})
    if only:
        exclude |= {s.get("speaker") for s in segs.values() if s.get("speaker") and s.get("speaker") not in only}

    # Upoutávka osnovu nepotřebuje (údery bere přímo z přepisu) – na novém videu ušetří krok osnovy (28 min ~2 min)
    if target and target <= 40 and re.search(r"upoutáv|upoutav|trailer|teaser|promo|pozvánk|pozvank", instruction, re.I):
        res = _plan_teaser(instruction, target, segs, exclude, backend, ctx, path, avoid)
        if res:
            res.update({"chapters": [], "why": "", "backend": backend,
                        "removedModerator": sorted(i for i in segs if segs[i].get("speaker") in exclude),
                        "elapsedSec": round(time.time() - t_start, 1), "llmStats": gpu.stats_summary(gpu.CALL_STATS)})
            return res

    # osnova musí být od stejného modelu (každý backend má vlastní cache; z cache je to okamžité)
    an = read_json(analyze({"path": path, "backend": backend}, ctx)["file"])
    weak = an.get("weak", {})
    chapters = an["chapters"]
    best_ids = {i for c in chapters for i in (c.get("best") or [])}
    n_ch = len(chapters)
    chapter_of = {i: k + 1 for k, c in enumerate(chapters) for i in range(c["from"], c["to"] + 1)}

    outline_lines = [
        f"K{i + 1}: věty {c['from']}–{c['to']} ({c['end'] - c['start']:.0f}s) [{', '.join(c.get('speakers') or [])}] "
        f"{c['title']} – {c['summary']}"
        for i, c in enumerate(chapters)
    ]
    goal = f" Cílová délka přibližně {target:.0f} s." if target else ""
    # hodnocení každé kapitoly zvlášť je u menšího modelu spolehlivější než volný výběr.
    # Po dávkách: u hodinového materiálu (50+ kapitol) se odpověď do limitu tokenů nevešla a kapitoly
    # za ~K16 dostaly automaticky 0 – celá druhá půlka pořadu se do výběru vůbec nedostala.
    # Bez zdůvodnění: generování je nejdražší část (~38 tok/s) a zdůvodnění psané až po skóre přesnosti nepomáhá.
    scores: dict[int, int] = {}
    BATCH = 12
    gpu.STAT_PHASE = "score"
    for b0 in range(0, n_ch, BATCH):
        ctx.check()
        m = min(BATCH, n_ch - b0)
        ctx.progress(0.02 + 0.08 * b0 / max(1, n_ch), f"LLM hodnotí kapitoly {b0 + 1}–{b0 + m}")
        # jen pole čísel v pořadí kapitol (délku hlídá gramatika): 1–2 tokeny na kapitolu místo ~18 u {"k":…,"score":…},
        # změřeno 2–3× rychleji při stejném výběru kapitol; u dávky 25 už model ke konci ztrácel pořadí
        sel = _chat_json(
            f"Jsi střihač. Zadání střihu: {instruction}.{goal}\n\nČást osnovy materiálu ({m} kapitol):\n"
            + "\n".join(outline_lines[b0: b0 + m]) + "\n\n"
            f"Ohodnoť každou z těchto {m} kapitol, jak moc patří do střihu podle zadání: 0 = nesouvisí, 1 = okrajově, "
            "2 = souvisí, 3 = přímo jádro zadání. Posuzuj podle názvu i shrnutí kapitoly. "
            f'Vrať JSON {{"s":[…]}} – pole {m} čísel ve stejném pořadí jako kapitoly (K{b0 + 1} až K{b0 + m}).',
            200,
            schema={"type": "object", "properties": {"s": {"type": "array", "items": {"type": "integer", "enum": [0, 1, 2, 3]},
                                                           "minItems": m, "maxItems": m}}, "required": ["s"]},
            backend=backend,
        )
        for j, sc in enumerate((sel.get("s") or [])[:m]):
            if isinstance(sc, int):
                scores[b0 + j + 1] = sc
    reasons = [f"K{k}={scores[k]}" for k in sorted(scores)]

    # i kapitoly se skóre 2: jen jádrové (3) zkusmo zrychlily plán, ale vzaly materiál vedlejšímu tématu
    # (bydlení vs. parkování 5:13) a krátkému materiálu (Diskuse1 74 s místo 120 s)
    chosen = ([k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 2]
              or [k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 1] or list(range(1, n_ch + 1)))

    # Krátký výrok / highlight (do 60 s): jedna souvislá pasáž místo skládání vět z celého materiálu.
    # Skládání vybralo „…napadlo mě úplně z ničeho nic.“ a pak skočilo jinam – to, co ji napadlo, vypadlo
    # (Talk 2026-11-20, 20 s); Claude bral jednu ucelenou pasáž s pointou. Upoutávka má vlastní dramaturgii.
    short = bool(target and target <= 60 and not params.get("noPassage")
                 # „sestřih“ ne – česky tak zní skoro každé zadání („třicetisekundový sestřih: nejsilnější výrok…“)
                 and not re.search(r"upoutáv|upoutav|trailer|teaser|promo|přehled|prehled|shrnut|víc témat|vic temat|"
                                   r"všech", instruction, re.I))
    # příběh v kostce přes víc etap („cesta od herečky přes stáž až k moderátorce“) jedna pasáž nepokryje –
    # Hermes vzal 50 s o kolezích ze Snídaně; obecné skládání vět pak dalo otázku moderátorky na začátek a utnuté
    # souvětí na konec (#166–167 bez #168, Talk IG 60 s 2026-11-21) -> vlastní dramaturgie etap (_plan_story)
    story = bool(_STORY_RE.search(instruction))
    if short and story:
        res = _plan_story(instruction, target, segs, chapters, scores, exclude, backend, ctx, path, avoid)
        if res:
            res.update({"chapters": chosen, "why": "; ".join(reasons), "backend": backend,
                        "removedModerator": sorted(i for i in segs if segs[i].get("speaker") in exclude),
                        "elapsedSec": round(time.time() - t_start, 1), "llmStats": gpu.stats_summary(gpu.CALL_STATS)})
            return res
        if avoid:
            # opakování kvůli hranici nesložilo příběh -> server nechá předchozí verzi (obecné skládání vět tu dávalo
            # otázku moderátorky na začátek a utnuté souvětí #166–167 bez #168)
            log("story: opakování nesložilo příběh – ponechá se předchozí plán")
            return {"note": "Po vyřazení vět se slyšitelnou hranicí nezbyl příběh.", "picks": [], "estimatedSec": 0,
                    "mode": "story", "alternates": [], "dropped": [], "chapters": chosen, "why": "; ".join(reasons),
                    "backend": backend, "editorial": [], "thesis": None, "keyChapters": [], "offTopic": [],
                    "topics": [], "balanceTopics": False, "general": False, "topicSec": {},
                    "addedForQuestionAnswer": [], "fixedFragments": []}
        # příběh nejde složit (málo etap / čistých výroků) -> radši jedna pasáž než obecné skládání vět
        story = False
    if short and not story and not _GENERIC_RE.search(instruction):
        # Úzké téma: hodnocení kapitol jen podle názvu a shrnutí mezi běhy kolísá (K8 „rodina, první reportáž“
        # dostala pro „ze Snídaně do zpravodajství“ jednou 2, jindy 3 a vybrala se pasáž o běhu se Suchoněm) –
        # kandidáty se skóre ≥ 2 posoudí model ještě jednou podle skutečného textu kapitol, všechny naráz.
        ver = _verify_core(instruction, chapters, scores, segs, exclude, backend)
        if ver:
            reasons.append("ověřeno textem: " + ", ".join(f"K{k}={v}" for k, v in sorted(ver.items())))
            scores.update(ver)
            chosen = ([k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 2]
                      or [k for k in range(1, n_ch + 1) if scores.get(k, 0) >= 1] or list(range(1, n_ch + 1)))
    if short and not story:
        res = _plan_passage(instruction, target, segs, chapters, chosen, scores, exclude, backend, ctx, pause_map, avoid,
                            path)
        if res:
            res.update({"chapters": chosen, "why": "; ".join(reasons), "backend": backend,
                        "removedModerator": sorted(i for i in segs if segs[i].get("speaker") in exclude),
                        "elapsedSec": round(time.time() - t_start, 1), "llmStats": gpu.stats_summary(gpu.CALL_STATS)})
            return res

    gpu.STAT_PHASE = "topics"
    topics, balance_topics, general, relational = _instruction_topics(instruction, backend)
    # vztahové zadání ("hlavní spor", "co si vyčítají"): téma se nekontroluje (viz _instruction_topics),
    # ale na rozdíl od přehledu se výběr NEroztahuje po kapitolách – jinak z každé kapitoly vezme drobek
    # a nejostřejší pasáž (obvinění + obhajoba) se do střihu vůbec nevejde.
    no_topic_check = general or relational
    # Zadání na nejotřesnější/nejstrašnější místa: rozhoduje síla dopadu na diváka, ne informační hodnota.
    # Bez toho model odvodil obecnou tezi filmu („asymetrický boj, technologie“) a vybral drony a 3D tisk místo
    # Buči, E40 a divadla v Mariupolu (Ukraine from Above, Putin 2026-09-28). Samotné „nejsilnější“ to nespouští
    # – u debaty znamená silné argumenty, ne násilí.
    intense = bool(re.search(r"otřes|strašn|pekeln|krut|drastic|brutál|šokuj|děsiv|hrůz|horor", instruction, re.I))
    # upoutávka: jiná dramaturgie než sestřih – nekončí pointou, ale napětím, a nesmí prozradit konec
    trailer = bool(re.search(r"upoutáv|upoutav|trailer|teaser|promo", instruction, re.I))
    # výběr jen jako tři pole ID (2–3 tokeny na větu místo ~20 u objektu s tématem a prioritou – generování je
    # u lokálního modelu nejdražší); k tématům věty přiřadí až kontrola tématu
    ids_arr = {"type": "array", "items": {"type": "integer"}}
    pick_schema = {"type": "object", "properties": {"nutne": ids_arr, "dobre": ids_arr, "okrajove": ids_arr},
                   "required": ["nutne", "dobre", "okrajove"]}
    topic_hint = f" (témata zadání: {', '.join(topics)})" if topics else ""

    removed_moderator: list[int] = []
    WINDOW = 24

    def select(ks: list[int], skip: set[int], extra_rule: str = "") -> list[dict]:
        """LLM vybere věty v kapitolách ks (kromě vět ze skip); moderátora model ani nevidí.
        Malé kapitoly za sebou jdou do jednoho okna (s nadpisy) – pravidla v promptu se neopakují pro každou
        kapitolu o 7 větách zvlášť; velké kapitoly se dělí, aby se odpověď vešla do limitu tokenů."""
        windows: list[list[tuple[int, int]]] = [[]]  # okno = [(kapitola, id věty)]
        for k in ks:
            c = chapters[k - 1]
            ids = [i for i in range(c["from"], c["to"] + 1) if i in segs and i not in skip]
            removed_moderator.extend(i for i in ids if segs[i].get("speaker") in exclude and i not in removed_moderator)
            # avoid = věty se slyšitelnou hranicí z předchozího pokusu (uzavřená smyčka v plan_edit_local)
            ids = [i for i in ids if segs[i].get("speaker") not in exclude and i not in avoid]
            for i in ids:
                if len(windows[-1]) >= WINDOW:
                    windows.append([])
                windows[-1].append((k, i))
        windows = [w for w in windows if w]
        out: list[dict] = []
        for n, win in enumerate(windows):
            ctx.check()
            ctx.progress(0.12 + 0.7 * n / len(windows), f"LLM vybírá věty ({n + 1}/{len(windows)})")
            lines, prev_k = [], None
            for k, i in win:
                if k != prev_k:
                    lines.append(f"— Kapitola „{chapters[k - 1]['title']}“ —")
                    prev_k = k
                lines.append(_line(segs[i]) + _weak_note(weak.get(str(i)), i in best_ids))
            ids_in = {i: k for k, i in win}
            data = _chat_json(
                f"Jsi střihač. Zadání: {instruction}.\n"
                "Z vět níže vyber ty, které se hodí do střihu: celé myšlenky, otázka i odpověď. "
                "Věty označené „nepoužitelné“ nevybírej. Označení „drobná vada“ znamená jen přeřeknutí nebo chybu "
                "přepisu – takovou větu klidně vyber, pokud obsahově patří k zadání (nejsilnější výroky v debatě "
                "bývají řečené v zápalu, tedy s drobnou vadou). "
                "Nevybírej otázky ani organizační věty moderátora. Nevybírej věty začínající malým písmenem "
                "(jsou to pokračování předchozí věty), ledaže vybereš i tu předchozí. "
                "Vyber všechny věty, které k tématu zadání říkají něco podstatného – raději víc, na délku se zkracuje "
                "až potom. Věty o jiném tématu, i když jsou ve stejné kapitole, nevybírej. " + extra_rule
                + f"Rozděl vybrané věty: nutne = přímo k tématu zadání{topic_hint} a silné, dobre = přímo k tématu, "
                "okrajove = jen příbuzné téma, obecný výčet nebo kontext.\n\n"
                + "\n".join(lines)
                + '\n\nVrať pouze JSON {"nutne":[čísla vět],"dobre":[…],"okrajove":[…]} bez komentářů.',
                1500,
                schema=pick_schema,
                backend=backend,
            )
            for field, pr in (("nutne", 1), ("dobre", 2), ("okrajove", 3)):  # okrajové při zkracování půjdou první
                for pid in data.get(field) or []:
                    if isinstance(pid, int) and pid in ids_in:
                        out.append({"id": pid, "priority": pr, "chapter": ids_in[pid], "core": pr < 3, "topic": None})
        seen = set()
        out = [p for p in out if not (p["id"] in seen or seen.add(p["id"]))]
        out.sort(key=lambda p: p["id"])  # chronologicky – rozhovor zůstane srozumitelný
        for p in out:
            p["dur"] = segs[p["id"]]["end"] - segs[p["id"]]["start"]
        return out

    def is_question(sid: int) -> bool:
        s, nxt = segs.get(sid), segs.get(sid + 1)
        if not (s and nxt and s["text"].rstrip().endswith("?")):
            return False
        # bez diarizace/speakerTracks věty nemají mluvčího vůbec – pak nejde poznat,
        # že odpovídá někdo jiný, ale otázka pořád potřebuje odpověď, tak to nekontrolovat.
        if not s.get("speaker") and not nxt.get("speaker"):
            return True
        return bool(nxt.get("speaker") and nxt.get("speaker") != s.get("speaker"))

    def continues(sid: int) -> bool:
        """Věta navazuje na předchozí a bez ní nedává smysl: začíná malým písmenem (pokračování souvětí),
        nebo výčtem/odkazem ("Za druhé…", "Tím…") – dvakrát "Za druhé" za sebou bez "za prvé" zní jako chyba střihu."""
        text = segs[sid]["text"].strip()
        # i začátek interpunkcí: Whisper rozdělí „U.S.“ na „…u“ + „.s officials say…“
        return bool(text) and (text[0].islower() or re.match(r"[.,;:–-]", text) is not None
                               or bool(re.match(r"(za (druhé|třetí|další)|tím)\b", text, re.I)))

    added: list[int] = []
    fixed_fragments: list[int] = []

    def complete(picks: list[dict]) -> list[dict]:
        """Doplň k výběru, co k němu nutně patří: druhou polovinu dvojice otázka–odpověď a začátek souvětí."""
        # otázka a odpověď patří k sobě: chybějící polovinu doplň (se stejnou prioritou)
        kept = {p["id"] for p in picks}
        for sid in sorted(segs):
            if is_question(sid) and ((sid in kept) != ((sid + 1) in kept)):
                add = sid + 1 if sid in kept else sid
                if segs[add].get("speaker") in exclude:  # otázku moderátora zpět nepřidávej
                    continue
                src = next(p for p in picks if p["id"] in (sid, sid + 1))
                picks.append({"id": add, "priority": src["priority"], "chapter": src.get("chapter"), "core": src.get("core"),
                              "topic": src.get("topic"), "dur": segs[add]["end"] - segs[add]["start"]})
                kept.add(add)
                added.append(add)
        picks.sort(key=lambda p: p["id"])
        # věta začínající malým písmenem je pokračování předchozí – buď doplň předchozí, nebo ji vyhoď,
        # jinak střih začne uprostřed souvětí ("…možnost pro své investice někde jinde.")
        # A naopak: když vybraná věta pokračuje další (ta začíná malým písmenem – "…pro seniory," + "což je něco,
        # co bychom rádi napravili"), doplň i to pokračování, jinak souvětí skončí uprostřed.
        for _ in range(2):  # doplněná věta může sama být pokračováním
            kept = {p["id"] for p in picks}
            for p in list(picks):
                sid = p["id"]
                nxt = segs.get(sid + 1)
                if (nxt and (sid + 1) not in kept and nxt.get("speaker") == segs[sid].get("speaker")
                        and nxt["text"].strip()[:1].islower()):
                    picks.append({"id": sid + 1, "priority": p["priority"], "chapter": p.get("chapter"), "core": p.get("core"),
                                  "topic": p.get("topic"), "dur": nxt["end"] - nxt["start"]})
                    fixed_fragments.append(sid + 1)
                    kept.add(sid + 1)
                if not continues(sid) or (sid - 1) in kept:
                    continue
                prev = segs.get(sid - 1)
                if prev and prev.get("speaker") not in exclude:
                    picks.append({"id": sid - 1, "priority": p["priority"], "chapter": p.get("chapter"), "core": p.get("core"),
                                  "topic": p.get("topic"), "dur": prev["end"] - prev["start"]})
                    fixed_fragments.append(sid - 1)
                    kept.add(sid - 1)
                else:
                    picks = [q for q in picks if q["id"] != sid]
            picks.sort(key=lambda p: p["id"])
        return picks

    def to_units(picks: list[dict]) -> list[dict]:
        """Celky pro zkracování: dvojice otázka–odpověď ani věta s pokračováním se nikdy nerozdělí."""
        out: list[dict] = []
        for p in picks:
            prev_id = out[-1]["ids"][-1] if out else None
            if prev_id is not None and p["id"] == prev_id + 1 and (is_question(prev_id) or continues(p["id"])):
                u = out[-1]
                u["ids"].append(p["id"])
                u["priority"] = min(u["priority"], p["priority"])
                u["core"] = u["core"] or bool(p.get("core"))
                u["topic"] = u["topic"] or p.get("topic")
                u["dur"] += p["dur"]
            else:
                out.append({"ids": [p["id"]], "priority": p["priority"], "dur": p["dur"],
                            "score": scores.get(p.get("chapter"), 2), "core": bool(p.get("core")), "topic": p.get("topic")})
        for u in out:  # hlavní mluvčí celku (podle délky řeči)
            spk: dict[str, float] = {}
            for i in u["ids"]:
                spk[segs[i].get("speaker") or ""] = spk.get(segs[i].get("speaker") or "", 0) + segs[i]["end"] - segs[i]["start"]
            u["speaker"] = max(spk, key=spk.get)
        return out

    gpu.STAT_PHASE = "select"
    units = to_units(complete(select(chosen, set())))

    # "argumenty obou hostů" -> při zkracování hlídej, aby jeden mluvčí nepřevážil (jinak model i zkracování
    # sklouznou k tomu, kdo mluví víc a delšími větami)
    balance = bool(re.search(r"\b(ob(ou|a|ě)|všech|každ\w*)\b[^.;:]{0,30}?(host|mluvčí|stran|účastník|kandidát|řečník)",
                             instruction, re.I))
    speakers = {u["speaker"] for u in units if u["speaker"]}
    balance = balance and len(speakers) >= 2

    def over(u: dict) -> bool:
        """Mluvčí celku má v aktuálním výběru víc než férový podíl (+5 procentních bodů)."""
        if not balance or not u["speaker"]:
            return False
        cur = sum(x["dur"] for x in units)
        mine = sum(x["dur"] for x in units if x["speaker"] == u["speaker"])
        return cur > 0 and mine / cur > 1 / len(speakers) + 0.05

    topics_with_material: set[str] = set()  # témata, ke kterým ověření našlo aspoň jeden celek (viz verify)

    def over_topic(u: dict) -> bool:
        """Téma celku má víc než férový podíl (+10 bodů) – zadání "o bydlení a parkování" chce obojí.
        Počítají se jen témata, ke kterým je materiál (prázdné téma by férový podíl rozmělnilo) – i ten, který zatím
        jen leží mezi ověřenými kandidáty: dřív se téma s 0 s ve výběru nepočítalo, a tak se nikdy nedoplnilo
        (Talk 2 min: „televize“ 0 s, herectví 57 s, přestože materiál o televizi byl)."""
        live = {x["topic"] for x in units if x.get("topic")} | topics_with_material
        if not balance_topics or len(live) < 2 or not u.get("topic"):
            return False
        cur = sum(x["dur"] for x in units if x.get("topic"))
        mine = sum(x["dur"] for x in units if x.get("topic") == u["topic"])
        return cur > 0 and mine / cur > 1 / len(live) + 0.1

    def over_chapter(u: dict) -> bool:
        """Obecné zadání (přehled celého pořadu): kapitola celku už je ve výběru zastoupená jiným celkem –
        přehled má pokrýt víc témat, ne tři úryvky z jedné pasáže."""
        if not general:
            return False
        k = chapter_of.get(u["ids"][0])
        return any(x is not u and chapter_of.get(x["ids"][0]) == k for x in units)

    viol = lambda u: int(over(u)) + int(over_topic(u)) + int(over_chapter(u))  # noqa: E731
    drop_key = lambda u: (u["core"], -viol(u), u["score"], -u["priority"], u["dur"])  # noqa: E731
    keep_key = lambda u: (not u["core"], viol(u), -u["score"], u["priority"])  # noqa: E731

    def verify(cand: list[dict]) -> list[int]:
        """Ověř téma vět v celcích; celky mimo téma vrať jako vyřazené ID, ostatním zpřesni téma."""
        if no_topic_check:  # přehled ani vztahové zadání nemají téma, podle kterého by se dalo vyřazovat
            return []
        dependent: set[int] = set()
        res = _verify_topic(instruction, topics, balance_topics, [i for u in cand for i in u["ids"]], segs, an,
                            chapter_of, backend, dependent)
        bad = [i for i, t in res.items() if t == "jiné"]
        taken = {i for x in units + cand for i in x["ids"]}
        merged: list[dict] = []
        for u in cand:
            got = [res[i] for i in u["ids"] if res.get(i) in topics]
            if got:
                u["topic"] = got[0]
                topics_with_material.add(got[0])
            # celek začíná větou, která stojí na předchozí ("Tím si to zhoršujeme.") -> musí jít s předchozí větou
            # téhož mluvčího: je-li ta v jiném celku, celky se sloučí (jinak zkracování vyhodí jen ji a věta zůstane
            # viset), jinak se předchozí věta předřadí. Odpověď na otázku řeší párování otázka–odpověď.
            first = u["ids"][0]
            prev = segs.get(first - 1)
            if (first not in dependent or first in bad or not prev
                    or prev.get("speaker") != segs[first].get("speaker") or prev.get("speaker") in exclude):
                continue
            owner = next((x for x in cand if x is not u and x not in merged and (first - 1) in x["ids"]), None)
            if owner:
                owner["ids"] += u["ids"]
                owner["dur"] += u["dur"]
                owner["core"] = owner["core"] or u["core"]
                owner["priority"] = min(owner["priority"], u["priority"])
                merged.append(u)
            elif (first - 1) not in taken:
                u["ids"].insert(0, first - 1)
                u["dur"] += prev["end"] - prev["start"]
                taken.add(first - 1)
                fixed_fragments.append(first - 1)
                # předřazená věta může být sama pokračováním („But“ + „despite months of this…“) – doplň řetězově
                for _ in range(3):
                    h = u["ids"][0]
                    pp = segs.get(h - 1)
                    if not continues(h) or not pp or (h - 1) in taken or pp.get("speaker") in exclude:
                        break
                    u["ids"].insert(0, h - 1)
                    u["dur"] += pp["end"] - pp["start"]
                    taken.add(h - 1)
                    fixed_fragments.append(h - 1)
        if merged:
            cand[:] = [x for x in cand if not any(x is m for m in merged)]
        return bad

    def trim(hi: float, lo: float) -> list[dict]:
        """Vyhazuj celky, dokud se výběr nevejde pod hi. Nejdřív celky, které nejsou přímo o tématu zadání
        (okrajově), pak nadměrně zastoupeného mluvčího, pak z kapitol méně souvisejících se zadáním, v nich nejnižší
        priorita a nejkratší (vytržené krátké věty = víc střihů, méně myšlenky); jádro zadání přijde na řadu až nakonec. Celek, jehož vyhozením by střih spadl pod lo,
        se přeskočí (když to jde) – jinak by jedna dlouhá věta utnula stopáž o 20 s."""
        out = []
        total = sum(u["dur"] for u in units)
        while total > hi and len(units) > 1:
            order = sorted(units, key=drop_key)
            # vstup a pointa redakčního výběru (skóre 4) až úplně nakonec: dřív se přeskočil dlouhý střední úsek
            # (spadlo by to pod lo) a místo něj šly krátká pointa a vstup
            free = [u for u in order if u["score"] < 4]
            if free and len(free) < len(order):
                u = next((u for u in free if total - u["dur"] >= lo), None)
                if u is None:
                    if total <= hi * 1.09:
                        break
                    u = min(free, key=lambda u: abs(total - u["dur"] - (hi + lo) / 2))
                units.remove(u)
                out.append(u)
                total -= u["dur"]
                continue
            u = next((u for u in order if total - u["dur"] >= lo), None)
            if u is None:
                # nic nejde vyhodit bez pádu pod dolní mez: mírné přetažení (do +9 % nad horní mez) je lepší než
                # vyhodit vstup/pointu (skóre 4) – dřív „nejbližší k cíli“ vyhodilo právě pointu
                if total <= hi * 1.09:
                    break
                u = min(order, key=lambda u: (u["score"] >= 4, abs(total - u["dur"] - (hi + lo) / 2)))
            units.remove(u)
            out.append(u)
            total -= u["dur"]
        return out

    def refill(pool: list[dict], hi: float, lo: float) -> None:
        """Krátký výběr dorovnej celky z poolu (nejrelevantnější první), dokud se vejdou do horní meze."""
        for u in sorted(pool, key=keep_key):
            total = sum(x["dur"] for x in units)
            if total >= lo:
                break
            if total + u["dur"] <= hi:
                units.append(u)
                pool.remove(u)

    def rebalance(pool: list[dict], hi: float, lo: float) -> None:
        """Vyvážení výměnou: celek nadměrně zastoupeného mluvčího/tématu nahraď celky z poolu, které to nezhorší.
        Samotné zkracování to nezvládne, když jsou celky převažující strany dlouhé – vyhozením kteréhokoli by střih
        spadl pod dolní mez, a tak místo nich vyhazovalo krátké celky slabší strany (bydlení 140 s : parkování 35 s)."""
        def imbalance() -> float:
            return sum(u["dur"] for u in units if viol(u))

        for _ in range(8):
            before = imbalance()
            if not before:
                return
            improved = False
            for out_u in sorted([u for u in units if viol(u)], key=lambda u: (u["core"], -u["priority"], u["dur"])):
                base = sum(u["dur"] for u in units) - out_u["dur"]
                units.remove(out_u)  # podíly se počítají bez vyměňovaného celku
                add, t = [], base
                present = {u.get("topic") for u in units}
                # celek tématu, které ve výběru úplně chybí, smí nahradit i jádrový celek – jinak by téma ze zadání
                # nikdy nedostalo prostor (Talk 2 min: 19 celků o televizi v zásobě, všechny „nejádrové“, 0 s ve střihu)
                ok = lambda c: c["core"] or not out_u["core"] or (c.get("topic") and c["topic"] not in present)  # noqa: E731
                for c in sorted([c for c in pool if not viol(c) and ok(c)],
                                key=lambda c: (c.get("topic") in present, *keep_key(c))):
                    if t + c["dur"] <= hi:
                        add.append(c)
                        t += c["dur"]
                        if t >= lo:
                            break
                units.extend(add)
                if t >= lo and imbalance() < before:
                    pool.append(out_u)
                    for c in add:
                        pool.remove(c)
                    improved = True
                    break
                for c in add:  # nevyšlo – vrátit
                    units.remove(c)
                units.append(out_u)
            if not improved:
                return

    # Redakční výběr: kandidátů je mnohem víc než cíl (film 90 min → 1 min: 900 s kandidátů) – zkracování podle
    # priority kapitol a délek pak nechá cokoli „k tématu“ (výkřiky z bojiště „Vylezte! Vylezte!“) a nevznikne
    # srozumitelný celek. Model proto uvidí kandidáty jako celky s textem a délkou a sestaví střih jako střihač:
    # úvod/kontext, jádro, pointa; souvislý komentář místo útržků. (Srovnání 2026-09-24: GPT, který přepis četl
    # sám a vybíral takhle, 8/10; lokální výběr bez tohoto kroku 4/10.)
    editorial: list[int] = []
    ed_left: list[dict] = []
    thesis = ""
    key_ch: set[int] = set()
    key_ch_pointa: set[int] = set()
    if target and len(units) > 6 and sum(u["dur"] for u in units) > 2 * target:
        gpu.STAT_PHASE = "thesis"
        ctx.progress(0.83, "LLM hledá hlavní myšlenku a pointu")
        # teze a klíčové kapitoly z osnovy: výběr vět po oknech nevidí celek – pointu filmu („stínová armáda
        # dobrovolníků… nevzdají se“) v kapitole se skóre 2 nevybral, i když na ni celý film směřuje
        th = _chat_json(
            f"Jsi střihač. Zadání: {instruction}. Cílová délka {target:.0f} s.\nOsnova materiálu:\n"
            + "\n".join(outline_lines)
            + "\n\nNapiš jednou větou hlavní myšlenku, kterou má střih divákovi předat (co je odpověď materiálu na "
            "zadání), a vyber kapitoly: úvod = nejlepší vstup do tématu (kontext, otázka), pointa = kde materiál "
            "tu myšlenku nejsilněji vysloví nebo shrne (často ke konci). "
            + ("Zadání nechce shrnutí poselství filmu, ale jeho nejotřesnější místa: myšlenka má pojmenovat to "
               "nejhorší, co materiál konkrétně dokládá (zločiny, oběti, svědectví), ne obecné téma (technika, "
               "strategie). " if intense else "")
            + 'Vrať JSON {"teze":"…","uvod":[čísla kapitol],"pointa":[čísla kapitol]}.',
            300,
            schema={"type": "object", "properties": {
                "teze": {"type": "string"},
                "uvod": {"type": "array", "items": {"type": "integer"}, "maxItems": 2},
                "pointa": {"type": "array", "items": {"type": "integer"}, "maxItems": 2}},
                "required": ["teze", "uvod", "pointa"]},
            backend=backend,
        )
        thesis = str(th.get("teze") or "").strip()
        key_ch_pointa = {k for k in (th.get("pointa") or []) if isinstance(k, int)}
        key_ch = {k for k in (th.get("uvod") or []) + (th.get("pointa") or []) if isinstance(k, int) and 1 <= k <= n_ch}
        # věty klíčových kapitol, které výběr po oknech nevzal, se přidají jako kandidáti (celé kapitoly, bez
        # moderátora/vyloučených mluvčích a bez slabých vět)
        have_ids = {i for u in units for i in u["ids"]}
        extra = []
        for k in sorted(key_ch):
            c = chapters[k - 1]
            for i in range(c["from"], c["to"] + 1):
                if i in segs and i not in have_ids and segs[i].get("speaker") not in exclude and not weak.get(str(i)):
                    extra.append({"id": i, "priority": 2, "chapter": k, "core": True, "topic": None,
                                  "dur": segs[i]["end"] - segs[i]["start"]})
        if extra:
            units[:] = sorted(units + [u for u in to_units(complete(extra)) if not set(u["ids"]) & have_ids],
                              key=lambda u: u["ids"][0])
        # výkřiky a povely („Гагарин! Пацани тримаєм!“, „OK, guys, jump in.“) do redakčního výběru nepouštěj –
        # model je i přes pokyn vybíral do „příběhu“; neplatí, když zadání chce atmosféru/akci
        if not re.search(r"atmosf|akc|emoc|bojov\w* scén|výkřik", instruction, re.I):
            def shout(u: dict) -> bool:
                text = " ".join(segs[i]["text"].strip() for i in u["ids"])
                nw = len(re.findall(r"\w+", text))
                if "!" in text and nw <= 10:
                    return True
                # krátká oznamovací věta („That person was shot.“) je u otřesného zadání pointa, ne výkřik
                return nw <= 6 and not (intense and nw >= 3 and text.rstrip().endswith("."))
            loud = [u for u in units if shout(u)]
            if len(units) - len(loud) >= 4:
                units[:] = [u for u in units if not shout(u)]
        # upoutávka = krátké střihy: dlouhé monology (Gummo: 11 s o otrávených kočkách, 30 s vyprávění) do ní
        # nepatří, i když jsou silné – model je bral, přestože prompt chce krátké údery
        if trailer:
            short_units = [u for u in units if u["dur"] <= 8.0]
            if sum(u["dur"] for u in short_units) >= 2 * target:
                units[:] = short_units
        # Uvozovací a organizační věty moderátora ("Začíná další vydání pořadu…", "Magistrát má 45 členů",
        # "vašich třicet vteřin pro diváky") nejsou obsah, ale mechanika pořadu – a model je i přes výslovný
        # zákaz v promptu bral jako "vstup s kontextem". Proto se do redakce vůbec nenabízejí. Otázky moderátora
        # zůstávají: když se vybere odpověď, complete() otázku sám doplní zpět.
        hosts = _moderator_speakers(segs)
        if hosts and len({s.get("speaker") for s in segs.values() if s.get("speaker")}) >= 3:
            def host_filler(u: dict) -> bool:
                if u.get("speaker") not in hosts:
                    return False
                return "?" not in " ".join(segs[i]["text"] for i in u["ids"])
            kept_units = [u for u in units if not host_filler(u)]
            if len(kept_units) >= 4:
                units[:] = kept_units
        gpu.STAT_PHASE = "edit"
        ctx.progress(0.85, "LLM skládá střih jako celek")
        _dbg = os.environ.get("PLAN_DEBUG")  # ladění redakční fáze: PLAN_DEBUG=<soubor> (vypíše celky + výběr)
        cand_lines = []
        unit_line: dict[int, str] = {}
        prev_k = None
        for n, u in enumerate(units, 1):
            k = chapter_of.get(u["ids"][0])
            if k != prev_k and k:
                cand_lines.append(f"— K{k} „{chapters[k - 1]['title']}“{' (klíčová)' if k in key_ch else ''} —")
                prev_k = k
            text = " ".join(segs[i]["text"].strip() for i in u["ids"])
            unit_line[n] = (f"U{n} ({u['dur']:.0f} s){' [' + u['speaker'] + ']' if u.get('speaker') else ''}: "
                            + (text[:420] + "…" if len(text) > 420 else text))
            cand_lines.append(unit_line[n])
        # podíl řeči mluvčích – model z toho pozná vypravěče (S2 = 45 % řeči) od hlasů z bojiště
        spk_dur: dict[str, float] = {}
        for x in segs.values():
            if x.get("speaker"):
                spk_dur[x["speaker"]] = spk_dur.get(x["speaker"], 0) + x["end"] - x["start"]
        tot_spk = sum(spk_dur.values()) or 1
        spk_line = ", ".join(f"{k} {100 * v / tot_spk:.0f} %" for k, v in sorted(spk_dur.items(), key=lambda kv: -kv[1])[:6])
        data = _chat_json(
            f"Jsi zkušený střihač dokumentu a zpravodajství. Zadání: {instruction}. Cílová délka {target:.0f} s.\n"
            + (f"Hlavní myšlenka, kterou má střih předat: {thesis}\n" if thesis else "")
            + (f"Podíl řeči mluvčích v materiálu: {spk_line} (kdo mluví nejvíc a souvisle, bývá vypravěč).\n"
               if len(spk_dur) > 1 else "")
            + "Níže jsou kandidátní úseky (v pořadí, jak jdou v materiálu, s nadpisy kapitol) s délkou v sekundách. "
            "Sestav z nich nejlepší střih jako mistr střihu: musí dávat smysl i divákovi, který materiál neviděl – "
            "silný vstup, jádro, které na něj odpovídá, a pointa na konec, která hlavní "
            "myšlenku vysloví (ne náhodná informace). Úseky na sebe logicky navazují, žádná myšlenka se neopakuje. "
            # "vstup (kontext nebo otázka)" svádělo model k moderátorovu úvodnímu výčtu ("Magistrát má 45 členů,
            # k většině je potřeba 23 křesel…") – divák z toho nepozná, o co ve střihu jde.
            "Vstup musí být výrok, který rovnou nastolí téma zadání (silné tvrzení, konkrétní výtka, jasně "
            "pojmenovaný problém) – NE uvozovací a organizační věty moderátora, představování hostů ani výčty "
            "čísel o složení zastupitelstva a podobná administrativa. "
            + ("Je to UPOUTÁVKA, ne shrnutí: začni hákem (nejsilnější replika nebo otázka), pak krátké úderné "
               "repliky, které stupňují napětí a naznačí konflikt a sázky. Krátké věty, výkřiky a repliky z akce "
               "jsou tu žádoucí. NEPROZRAZUJ rozuzlení ani konec příběhu (nic z poslední čtvrtiny, co odhaluje, "
               "jak to dopadne) a neskončí pointou – skonči napínavou replikou nebo otázkou. "
               if trailer else "")
            + ("Zadání chce nejotřesnější místa: řaď úseky podle síly dopadu na diváka, ne podle informační "
               "hodnoty. Přednost mají konkrétní svědectví o násilí, obětech a zločinech (co se komu stalo, kolik "
               "mrtvých, kdo to udělal) a výpovědi očitých svědků v první osobě – i krátká věta jako „Ten člověk "
               "byl zastřelen.“ Techniku, zbraně, strategii a historické pozadí nevybírej, nanejvýš jednu větu jako "
               "nutný kontext. Pokryj několik různých nejsilnějších událostí z celého materiálu (každou pár "
               "úseky), ne jeden dlouhý souvislý blok. Postavu uveď, než promluví. "
               if intense else
               "Dej přednost souvislým větám vypravěče, komentáře a výpovědím, které samy o sobě něco sdělí (fakta, "
               "souvislosti, osobní zkušenost); postavu uveď, než promluví. ")
            + "Nevybírej výkřiky, povely, citoslovce, "
            "krátké repliky bez kontextu, útržky ani opakování – ledaže zadání výslovně chce atmosféru nebo akci. "
            f"Součet délek vybraných úseků drž kolem {target:.0f} s (nejvýš {target * 1.15:.0f} s), "
            # Samotný součet sekund model neuhlídá (z 180 celků vybral 52 = 3× cíl) a mechanické zkracování
            # pak vyhodí právě ty nejostřejší krátké úseky. Konkrétní počet drží výběr mnohem líp.
            f"to je přibližně {max(3, round(target / max(4.0, _median_dur(units)))):.0f} úseků – vybírej po jednom "
            "to nejsilnější, neber souvislé bloky za sebou. Když je kapitola označená „(klíčová)“, musí v střihu "
            "být zastoupená konkrétním výrokem (jmenovaná věc, číslo, konkrétní výtka), ne obecnou větou.\n"
            # Vztahové zadání (spor, výčitky, rozdíly) bez tohohle sklouzlo k souvislému programu jedné strany
            # (Ferancová 75 s ze 119) – divák pak nevidí spor, ale monolog.
            + ("Zadání je o sporu/rozdílech: obě strany musí dostat zhruba stejný prostor a musí na sebe "
               "reagovat (tvrzení – protitvrzení), ne dva oddělené monology. Konkrétní vzájemná výtka má "
               "přednost před obecným popisem vlastního programu.\n" if relational else "")
            + "\n"
            + "\n".join(cand_lines)
            + '\n\nNejdřív jednou větou osnova střihu (čím začne, co je jádro, čím skončí), pak čísla úseků. '
            'Vrať JSON {"osnova":"…","u":[čísla vybraných úseků]}.',
            500,
            schema={"type": "object", "properties": {"osnova": {"type": "string"},
                                                     "u": {"type": "array", "items": {"type": "integer"}, "maxItems": 60}},
                    "required": ["osnova", "u"]},
            backend=backend,
        )
        pick = {n for n in (data.get("u") or []) if isinstance(n, int) and 1 <= n <= len(units)}
        psum = sum(units[n - 1]["dur"] for n in pick)
        if _dbg:
            with open(_dbg, "w", encoding="utf-8") as fh:
                fh.write("=== CELKY, KTERE REDAKCE VIDI ===\n" + "\n".join(cand_lines))
                fh.write(f"\n\n=== OSNOVA MODELU ===\n{data.get('osnova')}\n")
                fh.write(f"\n=== VYBRANE CELKY ===\n{sorted(pick)}\n")
                fh.write("\n".join(unit_line[n] for n in sorted(pick)))
        for _round in range(2):
            if not (pick and psum > 1.3 * target):
                break
            # model délku přestřelil (film: 37 úseků místo ~10) – mechanické zkracování by pak vyhodilo pointu;
            # ať svůj výběr zkrátí sám, se součtem délek před očima
            sub = sorted(pick)
            data = _chat_json(
                f"Jsi střihač. Zadání: {instruction}. Tvůj výběr má {psum:.0f} s, cíl je {target:.0f} s. Zkrať ho: "
                "nech jen úseky, bez kterých by střih nedával smysl – úvod, jádro a pointu na konec zachovej, "
                + ("vyhoď nejdřív techniku, strategii a obecný komentář, svědectví o obětech a zločinech nech, "
                   if intense else "")
                + f"součet délek {target * 0.9:.0f}–{target * 1.1:.0f} s.\n\n"
                + "\n".join(unit_line[n] for n in sub)
                + '\n\nVrať JSON {"u":[čísla ponechaných úseků]}.',
                300,
                schema={"type": "object", "properties": {"u": {"type": "array", "items": {"type": "integer"},
                                                               "maxItems": 40}}, "required": ["u"]},
                backend=backend,
            )
            short = {n for n in (data.get("u") or []) if isinstance(n, int) and n in pick}
            if short and sum(units[n - 1]["dur"] for n in short) >= 0.5 * target:
                pick = short
            psum = sum(units[n - 1]["dur"] for n in pick)
        # pointa je povinná: výběr bez jediného úseku z kapitol, které model sám označil za pointu, končil
        # náhodnou zprávou – doplň z poslední pointové kapitoly (až ~20 % cíle)
        # (u upoutávky ne – pointová kapitola bývá u konce filmu a prozradila by rozuzlení)
        if not trailer and pick and key_ch_pointa and not any(chapter_of.get(units[n - 1]["ids"][0]) in key_ch_pointa for n in pick):
            cand = [n for n, u in enumerate(units, 1) if chapter_of.get(u["ids"][0]) in key_ch_pointa]
            budget = 0.2 * target
            for n in reversed(cand):
                if units[n - 1]["dur"] <= budget:
                    pick.add(n)
                    budget -= units[n - 1]["dur"]
        # Stejně povinná je i každá další klíčová kapitola: model ji sám označil za nosnou, přesto ji uměl
        # přeskočit (u debaty vynechal celou "Kritika parkovací politiky" i s konkrétní výtkou a čísly
        # a nahradil ji obecným popisem programu). Doplň z ní jeden úsek – přednost má ten s číslem,
        # protože konkrétní výtka ("utratilo se tři čtvrtě milionu") unese víc než obecná věta.
        for k in sorted(key_ch - key_ch_pointa):
            if not pick or any(chapter_of.get(units[n - 1]["ids"][0]) == k for n in pick):
                continue
            # moderátora sem nepouštěj: kapitola "Úvod a hosté pořadu" bývá klíčová (thesis ji označí za vstup)
            # a její jediný úsek je znělka ("Začíná další vydání pořadu…", končí otazníkem, takže projde i
            # filtrem mechaniky) – vynucený vstup pak divákovi neřekne vůbec nic o tématu
            cand = [n for n, u in enumerate(units, 1)
                    if chapter_of.get(u["ids"][0]) == k and u["dur"] <= 0.2 * target
                    and u.get("speaker") not in hosts]
            if not cand:
                continue
            with_num = [n for n in cand if re.search(r"\d|milion|tisíc|procent",
                                                     " ".join(segs[i]["text"] for i in units[n - 1]["ids"]), re.I)]
            pick.add((with_num or sorted(cand, key=lambda n: -units[n - 1]["dur"]))[0])
        if pick and sum(units[n - 1]["dur"] for n in pick) >= 0.5 * target:
            ed_left = [u for n, u in enumerate(units, 1) if n not in pick]
            units[:] = [u for n, u in enumerate(units, 1) if n in pick]
            for u in units:  # redakčně vybrané mají při dorovnání délky přednost
                u["core"] = True
                u["priority"] = 1
                u["score"] = 3  # skóre kapitoly už nerozhoduje – vybíral redaktor celek
            # vstup a pointa se při dorovnání délky zahazují až úplně nakonec (zkracuje se ze středu)
            pointa_u = [u for u in units if chapter_of.get(u["ids"][0]) in key_ch_pointa] or units[-1:]
            for u in units[:1] + pointa_u[-1:]:
                u["score"] = 4
            editorial = [i for u in units for i in u["ids"]]


    def refers_back(sid: int) -> bool:
        """Věta stojí na předchozí: začíná spojkou nebo zájmenem, které odkazuje dozadu („And the question remains, how
        is this possible?“, „It's who they are.“, „Proto…“, „Tohle…“) – bez předchozí věty divák neví, o co jde."""
        t = segs[sid]["text"].strip()
        return bool(re.match(r"(and|but|so|then|this|that|these|those|it|it's|they|he|she|there|a|ale|proto|tak|tohle|"
                             r"to|ten|ta|ti|on|ona|oni|takže|tím|potom)\b", t, re.I))

    def attach_context(refs: bool = True) -> None:
        """Pojistka souvětí a kontextu, připojená PŘÍMO do celku (zkracování pak počítá se skutečnou délkou a kontext
        vyhodí jen spolu s jeho větou): začátek souvětí (řetězově), pokračování začínající malým písmenem a krátká
        předchozí věta téhož mluvčího u věty, která na ni odkazuje („how is THIS possible?“). Z plánu nikdy neodejde
        useknutá věta (Andrijivka: „medics could not believe…“ bez „But the / further they advanced…“)."""
        owner = {i: u for u in units for i in u["ids"]}
        for _ in range(4):
            grown = False
            for i in sorted(owner):
                u = owner[i]
                prv, nxt = segs.get(i - 1), segs.get(i + 1)
                if prv and (i - 1) not in owner and prv.get("speaker") not in exclude and (
                        continues(i) or (refs and refers_back(i) and prv.get("speaker") == segs[i].get("speaker")
                                         and segs[i]["start"] - prv["end"] < 2.5 and prv["end"] - prv["start"] < 9
                                         and not any(w in ("vata", "prázdné") for w in weak.get(str(i - 1), [])))):
                    u["ids"].insert(u["ids"].index(i), i - 1)
                    u["dur"] += prv["end"] - prv["start"]
                    owner[i - 1] = u
                    fixed_fragments.append(i - 1)
                    grown = True
                if (nxt and (i + 1) not in owner and nxt.get("speaker") == segs[i].get("speaker")
                        and re.match(r"[a-zà-ž]", nxt["text"].strip())):
                    u["ids"].insert(u["ids"].index(i) + 1, i + 1)
                    u["dur"] += nxt["end"] - nxt["start"]
                    owner[i + 1] = u
                    fixed_fragments.append(i + 1)
                    grown = True
            if not grown:
                break

    if editorial:
        attach_context()
    hi, lo = (target * 1.03, target * 0.97) if target else (float("inf"), 0.0)
    # kontrola tématu jen u celků, které mají šanci projít (~1,6× cíle), ne u všech kandidátů
    pre_pool = (trim(target * 1.6, target * 1.5) if target else []) + ed_left
    gpu.STAT_PHASE = "verify"
    ctx.progress(0.9, "LLM kontroluje téma vybraných vět")
    off_topic = verify(units) if units else []
    units[:] = [u for u in units if not any(i in off_topic for i in u["ids"])]
    pool = trim(hi, lo)
    refill(pool, hi, lo)
    if sum(u["dur"] for u in units) < lo and pre_pool:
        # po vyřazení mimo téma chybí materiál: ověř i nejlepší z předběžně vyřazených a dorovnej jimi
        cand = sorted(pre_pool, key=keep_key)[:12]
        pre_pool = [u for u in pre_pool if u not in cand]
        bad = verify(cand)
        off_topic += bad
        cand = [u for u in cand if not any(i in bad for i in u["ids"])]
        refill(cand, hi, lo)
        pool += cand
    if target and sum(u["dur"] for u in units) < lo:
        # málo materiálu (model byl přísný, kontrola tématu něco vyřadila): doplňkový výběr z vět jádrových
        # kapitol, které zatím nikdo nevybral
        gpu.STAT_PHASE = "topup"
        ctx.progress(0.95, "LLM doplňuje krátký střih")
        have = {i for u in units + pool + pre_pool for i in u["ids"]} | set(off_topic)
        ks = [k for k in chosen if scores.get(k, 0) >= 3] or chosen
        extra = [u for u in to_units(complete(select(ks, have, "Střih je zatím krátký – vyber další věty, které k tématu "
                                                               "zadání něco přidávají. ")))
                 if not any(i in have for i in u["ids"])]
        if extra:
            bad = verify(extra)
            off_topic += bad
            extra = [u for u in extra if not any(i in bad for i in u["ids"])]
            refill(extra, hi, lo)
            pool += extra
    if target:
        rebalance(pool, hi, lo)
        # téma ze zadání, které ve výběru úplně chybí: jeho materiál může ležet jen mezi předběžně vyřazenými, které
        # ještě nemají ověřené téma – bez ověření by se o něm vyvažování nedozvědělo (Talk 2 min: „televize“ 0 s)
        missing = bool(balance_topics and set(topics) - {u.get("topic") for u in units} - topics_with_material)
        if (any(viol(u) for u in units) or missing) and pre_pool:
            # slabší strana může mít materiál jen mezi předběžně vyřazenými (ty ještě nemají ověřené téma) –
            # ověř nejlepší z nich a zkus výměnu znovu
            gpu.STAT_PHASE = "rebalance"
            cand = sorted(pre_pool, key=keep_key)[:24 if missing else 14]
            pre_pool = [u for u in pre_pool if u not in cand]
            bad = verify(cand)
            off_topic += bad
            pool += [u for u in cand if not any(i in bad for i in u["ids"])]
            rebalance(pool, hi, lo)
        miss = (set(topics) - {u.get("topic") for u in units} - topics_with_material) if balance_topics else set()
        if miss:
            # pořád chybí: výběr vět z kapitol k tématu ho vůbec nenabídl. Kapitoly k němu najde ověření tématu jejich
            # nejlepších vět (z osnovy), pak cílený výběr v nich a výměna (Talk 2 min: kariéra v televizi 0 s)
            gpu.STAT_PHASE = "coverage"
            ctx.progress(0.96, f"LLM doplňuje chybějící téma: {', '.join(sorted(miss))}")
            best = [i for c in chapters for i in (c.get("best") or [])[:2] if i in segs and segs[i].get("speaker") not in exclude]
            lab = _verify_topic(instruction, topics, balance_topics, best, segs, an, chapter_of, backend, set())
            ks = sorted({chapter_of[i] for i, t in lab.items() if t in miss and i in chapter_of})
            if ks:
                have = {i for u in units + pool + pre_pool for i in u["ids"]} | set(off_topic)
                extra = [u for u in to_units(complete(select(ks, have, f"Vyber věty o tématu: {', '.join(sorted(miss))}. ")))
                         if not any(i in have for i in u["ids"])]
                bad = verify(extra)
                off_topic += bad
                pool += [u for u in extra if not any(i in bad for i in u["ids"])]
                rebalance(pool, hi, lo)
    attach_context(refs=False)
    units.sort(key=lambda u: u["ids"][0])
    snapped = _snap_units_to_pauses(units, segs, exclude, pause_map,
                                    budget=(target * 1.05 - sum(u["dur"] for u in units)) if target else float("inf"))
    if target and sum(u["dur"] for u in units) > target * 1.08:
        trim(target * 1.05, target * 0.9)  # dotažení k pauzám střih prodloužilo – dorovnat celými celky
    total = sum(u["dur"] for u in units)
    note = None
    if target and total < 0.85 * target:
        note = (f"K zadání se v materiálu našlo jen {total:.0f} s vhodného obsahu (cíl {target:.0f} s)"
                + (f" – omezeno na mluvčí {', '.join(sorted(only))}" if only else "") + ".")
    return {
        "note": note,
        "picks": [i for u in units for i in u["ids"]],
        "addedForQuestionAnswer": added,
        "chapters": chosen,
        "why": "; ".join(reasons),
        "estimatedSec": round(total, 1),
        "dropped": [i for u in pool + pre_pool for i in u["ids"]],
        # ověření náhradníci k tématu, nejrelevantnější první (pro kontrolu agentem)
        "alternates": [i for u in sorted(pool, key=keep_key) for i in u["ids"]],
        "removedModerator": removed_moderator,
        "fixedFragments": fixed_fragments,
        "snappedEdges": snapped,
        "editorial": editorial,
        "thesis": thesis,
        "keyChapters": sorted(key_ch),
        "offTopic": off_topic,
        "topics": topics,
        "balanceTopics": balance_topics,
        "general": general,
        "topicSec": {t: round(sum(u["dur"] for u in units if u.get("topic") == t), 1) for t in topics},
        # ladění vyvážení: kolik ověřeného materiálu k tématu zbylo v zásobě [počet celků, sekund, nejkratší celek]
        "topicPool": {t: [len([u for u in pool if u.get("topic") == t]),
                          round(sum(u["dur"] for u in pool if u.get("topic") == t), 1),
                          round(min([u["dur"] for u in pool if u.get("topic") == t] or [0]), 1)] for t in topics},
        "backend": backend,
        "elapsedSec": round(time.time() - t_start, 1),
        "llmStats": gpu.stats_summary(gpu.CALL_STATS),
    }
