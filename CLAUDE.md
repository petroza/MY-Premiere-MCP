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

## Dlouhý materiál (hodina a víc) – šetři kredity
1. `transcribe_media` (běží v lokálním Workeru, cache) → `diarize_media` nebo `speakerTracks` → `rename_speakers`.
2. `analyze_transcript` – lokální LLM udělá osnovu kapitol a označí slabé věty. Pracuj s osnovou, ne s celým textem.
3. Plný text čti jen u kapitol, které do střihu patří: `get_transcript` s `fromId`/`toId` a `format: "compact"`.
4. Chce-li uživatel střih úplně bez kreditů: `plan_edit_local` (volitelně `build`).

## Více kamer
1. Reference = hlavní zvuk (mix/zvukař). Přepis + mluvčí reference (mikrofony nebo diarizace, pojmenuj je).
2. `build_multicam_sequence` s kamerami `{source, role: wide|close, speakers:[jméno]}` – offsety se dopočítají ze zvuku.
   Nejdřív `dryRun: true`, zkontroluj nejisté synchronizace a nenamapované mluvčí, pak ostrý běh.
3. Lze kombinovat se střihem příběhu: `picks` (ID vět reference) → kamery se přepínají jen ve vybraných úsecích.

## Pravidla
- Časy jsou v sekundách. Časy přepisu jsou ve zdroji, `transcribe_sequence` vrací časy timeline.
- Destruktivní nástroje (`remove_timeline_ranges`, `remove_clips`) jen na výslovné přání – a předtím vždy zavolej `backup_project` (tlačítko "↶ Zpět" v panelu není spolehlivé, viz jeho popis).
- `run_extendscript` jen když na úkol neexistuje nástroj.
- Když cituješ nebo shrnuješ čísla/tvrzení z přepisu, piš přesně to, co tam je (co model skutečně slyšel/napsal) – neopravuj si potichu čísla podle vlastního dopočtu (např. "1250 €" nepřepisuj na "12,50 €", i kdyby to z kontextu dávalo větší smysl). Pokud přepis vypadá jako chyba ASR, řekni to výslovně vedle citace, ale nenahrazuj hodnotu tiše.
- `add_captions` (české titulky) volej až po dokončeném střihu dané sekvence – časy se počítají z aktuálního stavu timeline, další úpravy střihu by je rozjely. Premiera umí zobrazit jen úplně první titulkovou stopu v sekvenci, proto nástroj druhé volání na stejnou sekvenci sám odmítne (dokud uživatel ručně nesmaže starou "CC" stopu v Premiere, nebo nepošleš `force: true`, což ale výsledek nezobrazí).
