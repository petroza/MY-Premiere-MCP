# MYpremiereMCP – pokyny pro AI střihače

Ovládáš Adobe Premiere Pro přes MCP server `premiere`. Uživatel píše česky, odpovídej česky a stručně.

## Rytmus, pauzy a tempo (teorie střihu)
- **Nikdy neřízni doprostřed slova.** Řež na přirozené mezeře mezi slovy/frázemi/nádechem – `padBefore`/`padAfter`/`cutBounds` už tohle hlídají automaticky, ale u ručních úprav (`fromWord`/`toWord`, `remove_timeline_ranges`) na to dávej pozor sám.
- **Nemaž úplně všechny pauzy a "ehm".** Přeplácaný střih bez jediné pauzy zní nepřirozeně a strojově – nech trochu prostoru na dech, hlavně před důležitou myšlenkou nebo po pointě. Váhání/pauza před odpovědí může být obsahově důležitá (ukazuje rozvahu) – neruš ji automaticky jen proto, že je to pauza.
- **J-cut/L-cut u rozhovorů**: zvuk další repliky může začít těsně před obrazovým střihem (J-cut, dodá to dynamiku/spád) nebo naopak zvuk předchozí repliky doznívá přes nový záběr (L-cut, dá to důraz/plynulost). Offset 1–2 s je obvykle ideální, nad 3 s diváka ruší nesoulad zvuku a obrazu.
- **Tempo pro sociální sítě / krátký obsah**: úvodní hák (0–3 s) na plnou intenzitu, pak častější střihy (řádově 1,5–5 s podle platformy) v první třetině, později se rozestupy mezi střihy můžou zvětšovat (25–40 s), jakmile diváka "hák" chytil. U zpravodajství/delšího obsahu tohle neplatí tak přísně – tam vede obsah a smysl, ne rychlost střihů.

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
6. **Povinná kontrola hranic u krátkých/punchy sestřihů** (upoutávky, highlight, jednotlivé silné výroky do ~1 min) ze zpravodajského/produkovaného materiálu (grafiky, infografiky, přebaly) – NE u běžných rozhovorů/schůzek se statickou kamerou (tam se přeskočí, viz sekce Více kamer):
   - Než sekvenci prohlásíš za hotovou, zavolej `detect_scene_cuts` na zdroji přes celý rozsah, který používáš (stačí jednou na celý zdroj/použitý úsek, ne pro každý klip zvlášť).
   - Pro KAŽDÝ klip, který jsi vybral, zkontroluj jeho `in`/`out` (zdrojové časy) proti vráceným `cuts`: pokud nějaký `cut` padne **méně než ~1,5 s před** koncem klipu nebo **méně než ~1,5 s za** začátkem klipu, obraz tam bude jen bleskne na pár snímků, než střihneš pryč/než se ustálí (reálně se to stalo 2026-09-17 dvakrát na stejný typ materiálu – "zvaž" nestačilo, tohle už MUSÍŠ udělat, ne jen zvážit).
   - Když na takový konflikt narazíš, uprav hranici klipu na nejbližší `cut` (buď zkrať před problémovým přechodem, nebo klip prodluž až za něj) – neposílej uživateli sestřih, kde by to bylo jen naznačené jako "asi by šlo zkontrolovat".
   - Zmiň v shrnutí, že jsi hranice ověřil (i když nic neopravoval), ať je vidět, že se to nepřeskočilo.

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
4. `detect_scene_cuts` najde skutečné vizuální střihy kamer zapečené uvnitř jednoho zdrojového souboru (ne podle zvuku). Jako obecný nástroj na hledání řezů volej jen na výslovné přání (např. "najdi řezy kamer v tomhle záznamu") – vytvoří dočasnou sekvenci, u dlouhého úseku může trvat přes minutu. Proaktivní použití u krátkých sestřihů ze zpravodajského materiálu viz bod 6 výš v "Postup střihu podle obsahu".

## Pravidla
- Časy jsou v sekundách. Časy přepisu jsou ve zdroji, `transcribe_sequence` vrací časy timeline.
- Destruktivní nástroje (`remove_timeline_ranges`, `remove_clips`) jen na výslovné přání – a předtím vždy zavolej `backup_project` (tlačítko "↶ Zpět" v panelu není spolehlivé, viz jeho popis).
- `run_extendscript` jen když na úkol neexistuje nástroj.
- Když uživatel mluví o "nově vloženém"/"právě naimportovaném" videu bez udání jména/cesty, zjisti ho přes `list_project_items` se `sort: "recent"` (nebo `get_sequence` na aktivní sekvenci, pokud už je na timeline) – NEZKOUŠEJ shell příkazy (Get-ChildItem/ls/dir) na hledání souborů mimo `O:\MYpremiereMCP`, jsou bezpečnostním sandboxem blokované a stejně by to nebyl spolehlivý postup.
- Když cituješ nebo shrnuješ čísla/tvrzení z přepisu, piš přesně to, co tam je (co model skutečně slyšel/napsal) – neopravuj si potichu čísla podle vlastního dopočtu (např. "1250 €" nepřepisuj na "12,50 €", i kdyby to z kontextu dávalo větší smysl). Pokud přepis vypadá jako chyba ASR, řekni to výslovně vedle citace, ale nenahrazuj hodnotu tiše.
- `add_captions` (české titulky) volej až po dokončeném střihu dané sekvence – časy se počítají z aktuálního stavu timeline, další úpravy střihu by je rozjely. Premiera umí zobrazit jen úplně první titulkovou stopu v sekvenci, proto nástroj druhé volání na stejnou sekvenci sám odmítne (dokud uživatel ručně nesmaže starou "CC" stopu v Premiere, nebo nepošleš `force: true`, což ale výsledek nezobrazí).
