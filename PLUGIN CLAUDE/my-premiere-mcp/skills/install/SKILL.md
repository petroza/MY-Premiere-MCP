---
name: install
description: Nainstaluje nebo opraví MY Premiere MCP na tomhle počítači (např. po přenesení složky MYpremiereMCP na flash disku) – panel v Premiere, Worker, modely, registrace MCP serveru. Použij, když nástroje premiere chybí, panel v Premiere není nebo to uživatel výslovně chce.
---

Nainstaluj MY Premiere MCP ze složky aplikace na tomhle počítači:

1. Najdi složku aplikace – obsahuje `server\index.js`, `panel\index.html` a `INSTALL\install.ps1`. Hledej v tomhle pořadí: proměnná `MYPREMIEREMCP_ROOT`, cesta v `%APPDATA%\MYpremiereMCP\root.txt`, `X:\MYpremiereMCP` na všech discích (včetně flash disku), `%USERPROFILE%\MYpremiereMCP`. Když ji nenajdeš, zeptej se uživatele na cestu.
2. Doporuč spouštět ze složky na pevném disku (flash disk je pomalý a po vytažení by panel i Worker přestaly fungovat). Když je složka jen na flash disku, nabídni zkopírování na pevný disk (např. `D:\MYpremiereMCP`, složky `cache` a `test` kopírovat netřeba) a pokračuj s kopií.
3. Spusť instalátor (běží bez dotazů, trvá minuty až desítky minut podle toho, co se stahuje – spouštěj s dlouhým timeoutem nebo na pozadí a sleduj `INSTALL\install-log.txt`):
   `powershell -NoProfile -ExecutionPolicy Bypass -File "<složka>\INSTALL\install.ps1"`
   Je-li ve složce `INSTALL\offline`, nic se nestahuje z internetu. Přepínače: `-SkipModels` (jen panel + MCP), `-NoLocalLLM` (bez lokálních modelů), `-CheckOnly` (jen kontrola).
4. Shrň výsledek z části „4/4 Vysledek“ (chyby a co s nimi udělat – např. chybějící Node.js / Python 3.11 nebo proxy ve firemní síti).
5. Řekni uživateli: restartovat Premiere a otevřít panel (Okno › Rozšíření › MY Premiere MCP), v aplikaci Claude začít novou relaci (načte se MCP server `premiere`) a pak napsat `/my-premiere-mcp:panel` nebo rovnou zadání.
