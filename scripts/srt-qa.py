"""Kontrola kvality titulků (.srt): délka řádků, počet řádků, jednopísmenné slovo na konci řádku/titulku,
překryvy, příliš krátké/dlouhé titulky, rychlost čtení (znaků/s), osiřelá slova, malé písmeno po konci věty.
.venv\\Scripts\\python.exe scripts\\srt-qa.py soubor.srt [znaků_na_řádek=40] [řádků=2]"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")


def t(s: str) -> float:
    h, m, rest = s.split(":")
    sec, ms = rest.split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


def main(path: str, cpl: int = 40, lines_max: int = 2) -> int:
    blocks = [b for b in open(path, encoding="utf-8").read().strip().split("\n\n") if b.strip()]
    cues = []
    for b in blocks:
        ls = b.split("\n")
        a, z = ls[1].split(" --> ")
        cues.append({"n": ls[0], "t0": t(a), "t1": t(z), "lines": ls[2:]})
    issues = []
    prev = None
    for c in cues:
        text = " ".join(c["lines"])
        dur = c["t1"] - c["t0"]
        tag = f"#{c['n']} „{text[:50]}“"
        if len(c["lines"]) > lines_max:
            issues.append(f"{tag}: {len(c['lines'])} řádky")
        for ln in c["lines"]:
            if len(ln) > cpl:
                issues.append(f"{tag}: řádek {len(ln)} znaků > {cpl}")
            if re.search(r"(^|\s)[^\W\d_]$", ln) and ln is not c["lines"][-1]:
                issues.append(f"{tag}: jednopísmenné slovo na konci řádku")
        if re.search(r"(^|\s)(v|s|z|k|o|u|a|i)$", text, re.I):
            issues.append(f"{tag}: titulek končí předložkou/spojkou")
        if dur < 0.7:
            issues.append(f"{tag}: jen {dur:.2f} s")
        if dur > 7.5:
            issues.append(f"{tag}: {dur:.1f} s (dlouho)")
        if dur > 0 and len(text) / dur > 21:
            issues.append(f"{tag}: rychlost čtení {len(text) / dur:.0f} znaků/s")
        if len(text.split()) == 1 and not re.search(r"[.!?…]$", text):
            issues.append(f"{tag}: osiřelé slovo")
        if prev:
            if c["t0"] < prev["t1"] - 0.001:
                issues.append(f"{tag}: překryv s předchozím ({prev['t1'] - c['t0']:.2f} s)")
            pt = " ".join(prev["lines"])
            if re.search(r"[.!?…][\"“”»]?$", pt) and re.match(r"\w", text) and text[0].islower():
                issues.append(f"{tag}: malé písmeno po konci věty")
        prev = c
    cps = sum(len(" ".join(c["lines"])) for c in cues) / max(0.01, sum(c["t1"] - c["t0"] for c in cues))
    print(f"{path}: {len(cues)} titulků, průměr {cps:.1f} znaků/s, problémů {len(issues)}")
    for i in issues:
        print("  ⚠", i)
    return len(issues)


if __name__ == "__main__":
    main(sys.argv[1], *(int(x) for x in sys.argv[2:4]))
