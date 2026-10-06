# Plugin MY Premiere MCP pro aplikaci Claude

`my-premiere-mcp.zip` – nahraj v aplikaci Claude: **Settings › Plugins › Upload local plugin**.

Obsahuje:
- **skill `premiere-strih`** – návod ke střihu (stejný jako `CLAUDE.md`), Claude ho použije, kdykoli má stříhat v Premiere,
- **`/my-premiere-mcp:panel`** – napojí relaci na panel MY Premiere MCP v Premiere,
- **`/my-premiere-mcp:install`** – nainstaluje MY Premiere MCP na tomhle počítači (panel, Worker, modely, registrace),
- **MCP server `premiere`** – spouštěč najde složku `MYpremiereMCP` na kterémkoli disku. Když už server zaregistroval
  instalátor, plugin nástroje nenabízí podruhé.

## Na jiném počítači (flash disk)

1. Zkopíruj složku `MYpremiereMCP` na pevný disk, nejlépe `D:\MYpremiereMCP` (z flash disku je to pomalé
   a po vytažení disku by to přestalo fungovat). Složky `cache` a `test` kopírovat netřeba.
   `INSTALL\offline` zkopíruj, když tam není internet (jinak se modely stáhnou, ~10–35 GB).
2. V aplikaci Claude nahraj plugin (`PLUGIN CLAUDE\my-premiere-mcp.zip`).
3. V nové relaci Claude Code napiš `/my-premiere-mcp:install` – Claude najde složku a spustí instalátor.
   (Ručně: `INSTALL\instalace.bat`.) Potřeba je Node.js a Python 3.11 – instalátor řekne, co chybí.
4. Restartuj Premiere a otevři panel (Okno › Rozšíření › MY Premiere MCP), v aplikaci Claude začni novou relaci.

Složka na jiném místě než `X:\MYpremiereMCP`: instalátor si cestu zapamatuje (`%APPDATA%\MYpremiereMCP\root.txt`),
případně nastav proměnnou `MYPREMIEREMCP_ROOT`.

## Napojení na panel

1. V aplikaci Claude otevři relaci v Claude Code a napiš `/my-premiere-mcp:panel`
   (nebo v panelu klikni na **○ Připojit Claude** – otevře se relace s napojením, potvrď složku a Enter).
2. Při prvním volání nástrojů `premiere` zvol **Vždy povolit**, ať se aplikace neptá u každého zadání.
3. Panel ukáže **● Claude čeká na zadání**. Pak stačí v panelu vybrat agenta **Claude (aplikace)**, napsat zadání
   a **Spustit** – Claude ho provede a průběh i výsledek se vypíše v panelu.

Nová verze pluginu: `.venv\Scripts\python.exe scripts\build-claude-plugin.py` (vezme aktuální `CLAUDE.md`
a `scripts\plugin-start.mjs`). Starý plugin v aplikaci odinstaluj a nahraj nový zip.
