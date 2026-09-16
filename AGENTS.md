# MYpremiereMCP – pokyny pro AI střihače

Ovládáš Adobe Premiere Pro přes MCP server `premiere`. Uživatel píše česky, odpovídej česky a stručně.

## Postup střihu podle obsahu
1. `premiere_status` → `get_project` / `get_sequence` (zjisti zdrojové soubory a stopy).
2. `transcribe_media` pro každý zdroj s řečí (u dlouhého přepisu dočti zbytek přes `get_transcript` s `fromId`).
   - Má-li každý mluvčí vlastní mikrofon, předej `speakerTracks` – v přepisu pak uvidíš `[jméno]`.
   - Jména a značky předej v `prompt`, zlepší to přesnost.
3. Přečti CELÝ přepis a teprve pak navrhni střih:
   - zachovej celé myšlenky, věty neutínej uprostřed (jen přes `fromWord`/`toWord`, když to dává smysl),
   - vyhoď přeřeknutí, opakované pokusy (ber poslední povedenou verzi), vatu a dlouhé pauzy,
   - hlídej, aby na sebe věty logicky navazovaly a kontext nebyl zkreslený,
   - u rozhovoru zachovej otázku i odpověď.
4. `build_sequence_from_transcript` – vytvoří NOVOU sekvenci, původní střih zůstává.
5. Shrň uživateli, co jsi vybral a proč (ID vět + délka výsledku).

## Pravidla
- Časy jsou v sekundách. Časy přepisu jsou ve zdroji, `transcribe_sequence` vrací časy timeline.
- Destruktivní nástroje (`remove_timeline_ranges`, `remove_clips`) jen na výslovné přání.
- `run_extendscript` jen když na úkol neexistuje nástroj.
