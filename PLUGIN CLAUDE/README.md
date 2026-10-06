# Plugin MY Premiere MCP pro aplikaci Claude

`my-premiere-mcp.zip` – nahraj v aplikaci Claude: **Settings › Plugins › Upload local plugin**.

Obsahuje:
- **skill `premiere-strih`** – návod ke střihu (stejný jako `CLAUDE.md`), Claude ho použije, kdykoli má stříhat v Premiere,
- **příkaz `/my-premiere-mcp:panel`** – napojí relaci na panel MY Premiere MCP v Premiere.

Potřebuje nainstalovaný MY Premiere MCP (instalátor zaregistruje MCP server `premiere`).

## Napojení na panel

1. V aplikaci Claude otevři relaci v Claude Code a napiš `/my-premiere-mcp:panel`
   (nebo v panelu klikni na **○ Připojit Claude** – otevře se relace s napojením, potvrď složku a Enter).
2. Při prvním volání nástrojů `premiere` zvol **Vždy povolit**, ať se aplikace neptá u každého zadání.
3. Panel ukáže **● Claude čeká na zadání**. Pak stačí v panelu vybrat agenta **Claude (aplikace)**, napsat zadání
   a **Spustit** – Claude ho provede a průběh i výsledek se vypíše v panelu.

Nová verze pluginu: `.venv\Scripts\python.exe scripts\build-claude-plugin.py` (vezme aktuální `CLAUDE.md`).
