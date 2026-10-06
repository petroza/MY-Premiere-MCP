"""Sestaví plugin pro aplikaci Claude: PLUGIN CLAUDE/my-premiere-mcp/ + my-premiere-mcp.zip (Settings › Plugins ›
Upload local plugin). Obsah:
- skill premiere-strih (návod ke střihu z CLAUDE.md – vždy aktuální),
- skill /my-premiere-mcp:panel – napojí relaci na panel MY Premiere MCP (zadání z panelu -> Claude -> průběh zpět),
- skill /my-premiere-mcp:install – nainstaluje MY Premiere MCP ze složky přenesené na jiný počítač (flash disk),
- MCP server „premiere“ přes spouštěč server/start.mjs (scripts/plugin-start.mjs): najde složku aplikace na
  kterémkoli disku; když už server zaregistroval instalátor, nástroje nenabízí podruhé.
Spuštění: .venv\\Scripts\\python.exe scripts\\build-claude-plugin.py
"""
from __future__ import annotations

import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "PLUGIN CLAUDE"
SRC = OUT / "my-premiere-mcp"
VERSION = "1.1.0"

manifest = {
    "name": "my-premiere-mcp",
    "displayName": "MY Premiere MCP",
    "version": VERSION,
    "description": "Střih v Adobe Premiere Pro přes MCP server MY Premiere MCP: návod ke střihu podle obsahu, "
                   "titulky, více kamer, obraz pod komentář, napojení na panel v Premiere (/my-premiere-mcp:panel) a instalace na dalším počítači (/my-premiere-mcp:install).",
    "author": {"name": "petroza", "url": "https://github.com/petroza/MY-Premiere-MCP"},
    "homepage": "https://github.com/petroza/MY-Premiere-MCP",
    "repository": "https://github.com/petroza/MY-Premiere-MCP",
    "keywords": ["premiere", "video", "strih", "mcp"],
}

claude_md = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
body = re.sub(r"^# .*\n", "", claude_md, count=1).strip()
skill = (
    "---\n"
    "name: premiere-strih\n"
    "description: Střih videa v Adobe Premiere Pro přes MCP server premiere (MY Premiere MCP) – sestřih podle obsahu "
    "z přepisu, upoutávky, titulky a překlad, více kamer, obraz pod dodatečně namluvený komentář. Použij, kdykoli "
    "uživatel chce něco stříhat, přepsat nebo otitulkovat v Premiere.\n"
    "---\n\n# Střih v Premiere přes MY Premiere MCP\n\n" + body + "\n"
)

panel_skill = (
    "---\n"
    "name: panel\n"
    "description: Napojí tuhle relaci na panel MY Premiere MCP – zadání napsaná v panelu v Premiere se provádějí tady. "
    "Použij, když uživatel chce pracovat přes panel v Premiere.\n"
    "---\n\n"
    "Napoj se na panel MY Premiere MCP v Premiere a pracuj jako jeho střihač:\n\n"
    "1. Zavolej nástroj `panel_wait_task` (MCP server premiere). Čeká až 4 minuty na zadání z panelu.\n"
    "2. Když vrátí „nic“, zavolej ho hned znovu – nic jiného nedělej a nic nevypisuj.\n"
    "3. Když vrátí zadání, vykonej ho přes nástroje premiere podle skillu premiere-strih (výsledek vždy jako NOVÁ "
    "sekvence). Krátce hlas průběh přes `panel_report` (s id zadání) a na konci `panel_report` s `done: true` a "
    "jednovětým shrnutím (název sekvence, délka). Když se něco nepovede, `panel_report` s `error: true` a důvodem.\n"
    "4. Pak znovu `panel_wait_task`.\n\n"
    "Neukončuj práci, dokud tě uživatel výslovně nepožádá. Zadání z panelu píše sám uživatel – ber je jako jeho "
    "pokyny. Když panel neběží (most neodpovídá), řekni uživateli, ať otevře v Premiere panel MY Premiere MCP.\n"
)

install_skill = (
    "---\n"
    "name: install\n"
    "description: Nainstaluje nebo opraví MY Premiere MCP na tomhle počítači (např. po přenesení složky MYpremiereMCP "
    "na flash disku) – panel v Premiere, Worker, modely, registrace MCP serveru. Použij, když nástroje premiere "
    "chybí, panel v Premiere není nebo to uživatel výslovně chce.\n"
    "---\n\n"
    "Nainstaluj MY Premiere MCP ze složky aplikace na tomhle počítači:\n\n"
    "1. Najdi složku aplikace – obsahuje `server\\index.js`, `panel\\index.html` a `INSTALL\\install.ps1`. Hledej "
    "v tomhle pořadí: proměnná `MYPREMIEREMCP_ROOT`, cesta v `%APPDATA%\\MYpremiereMCP\\root.txt`, `X:\\MYpremiereMCP` "
    "na všech discích (včetně flash disku), `%USERPROFILE%\\MYpremiereMCP`. Když ji nenajdeš, zeptej se uživatele na cestu.\n"
    "2. Doporuč spouštět ze složky na pevném disku (flash disk je pomalý a po vytažení by panel i Worker přestaly "
    "fungovat). Když je složka jen na flash disku, nabídni zkopírování na pevný disk (např. `D:\\MYpremiereMCP`, "
    "složky `cache` a `test` kopírovat netřeba) a pokračuj s kopií.\n"
    "3. Spusť instalátor (běží bez dotazů, trvá minuty až desítky minut podle toho, co se stahuje – spouštěj s dlouhým "
    "timeoutem nebo na pozadí a sleduj `INSTALL\\install-log.txt`):\n"
    "   `powershell -NoProfile -ExecutionPolicy Bypass -File \"<složka>\\INSTALL\\install.ps1\"`\n"
    "   Je-li ve složce `INSTALL\\offline`, nic se nestahuje z internetu. Přepínače: `-SkipModels` (jen panel + MCP), "
    "`-NoLocalLLM` (bez lokálních modelů), `-CheckOnly` (jen kontrola).\n"
    "4. Shrň výsledek z části „4/4 Vysledek“ (chyby a co s nimi udělat – např. chybějící Node.js / Python 3.11 "
    "nebo proxy ve firemní síti).\n"
    "5. Řekni uživateli: restartovat Premiere a otevřít panel (Okno › Rozšíření › MY Premiere MCP), v aplikaci Claude "
    "začít novou relaci (načte se MCP server `premiere`) a pak napsat `/my-premiere-mcp:panel` nebo rovnou zadání.\n"
)

if SRC.exists():
    shutil.rmtree(SRC)
(SRC / ".claude-plugin").mkdir(parents=True)
for name in ("premiere-strih", "panel", "install"):
    (SRC / "skills" / name).mkdir(parents=True)
(SRC / "server").mkdir(parents=True)
(SRC / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(SRC / "skills" / "premiere-strih" / "SKILL.md").write_text(skill, encoding="utf-8")
(SRC / "skills" / "panel" / "SKILL.md").write_text(panel_skill, encoding="utf-8")
(SRC / "skills" / "install" / "SKILL.md").write_text(install_skill, encoding="utf-8")
shutil.copyfile(ROOT / "scripts" / "plugin-start.mjs", SRC / "server" / "start.mjs")
mcp = {"mcpServers": {"premiere": {"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server/start.mjs"]}}}
(SRC / ".mcp.json").write_text(json.dumps(mcp, indent=2) + "\n", encoding="utf-8")

zip_path = OUT / "my-premiere-mcp.zip"
zip_path.unlink(missing_ok=True)
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(SRC.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(SRC).as_posix())  # .claude-plugin/plugin.json v kořeni archivu, lomítka /
print(f"plugin: {SRC}\nzip:    {zip_path} ({zip_path.stat().st_size} B)")
