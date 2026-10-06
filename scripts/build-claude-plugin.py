"""Sestaví plugin pro aplikaci Claude: PLUGIN CLAUDE/my-premiere-mcp/ + my-premiere-mcp.zip (Settings › Plugins ›
Upload local plugin). Obsah: návod ke střihu (skill z CLAUDE.md – vždy aktuální) a příkaz /my-premiere-mcp:panel,
který relaci napojí na panel MY Premiere MCP (zadání z panelu -> Claude v aplikaci -> průběh zpět do panelu).
MCP server „premiere“ plugin NEobsahuje – registruje ho instalátor (INSTALL), v pluginu by běžel podruhé.
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
VERSION = "1.0.0"

manifest = {
    "name": "my-premiere-mcp",
    "displayName": "MY Premiere MCP",
    "version": VERSION,
    "description": "Střih v Adobe Premiere Pro přes MCP server MY Premiere MCP: návod ke střihu podle obsahu, "
                   "titulky, více kamer, obraz pod komentář, a napojení na panel v Premiere (/my-premiere-mcp:panel).",
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

panel_cmd = (
    "---\n"
    "description: Napojí tuhle relaci na panel MY Premiere MCP – zadání napsaná v panelu v Premiere se provádějí tady\n"
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

if SRC.exists():
    shutil.rmtree(SRC)
(SRC / ".claude-plugin").mkdir(parents=True)
(SRC / "skills" / "premiere-strih").mkdir(parents=True)
(SRC / "commands").mkdir(parents=True)
(SRC / ".claude-plugin" / "plugin.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(SRC / "skills" / "premiere-strih" / "SKILL.md").write_text(skill, encoding="utf-8")
(SRC / "commands" / "panel.md").write_text(panel_cmd, encoding="utf-8")

zip_path = OUT / "my-premiere-mcp.zip"
zip_path.unlink(missing_ok=True)
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(SRC.rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(SRC).as_posix())  # .claude-plugin/plugin.json v kořeni archivu, lomítka /
print(f"plugin: {SRC}\nzip:    {zip_path} ({zip_path.stat().st_size} B)")
