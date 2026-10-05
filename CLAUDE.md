# MYpremiereMCP – pokyny pro AI střihače

Ovládáš Adobe Premiere Pro přes MCP server `premiere`. Uživatel píše česky, odpovídej česky a stručně.

## Rytmus, pauzy a tempo (teorie střihu)
- **Nikdy neřízni doprostřed slova.** Řež na přirozené mezeře mezi slovy/frázemi/nádechem – `padBefore`/`padAfter`/`cutBounds` už tohle hlídají automaticky, ale u ručních úprav (`fromWord`/`toWord`, `remove_timeline_ranges`) na to dávej pozor sám.
- **Nemaž úplně všechny pauzy a "ehm".** Přeplácaný střih bez jediné pauzy zní nepřirozeně a strojově – nech trochu prostoru na dech, hlavně před důležitou myšlenkou nebo po pointě. Váhání/pauza před odpovědí může být obsahově důležitá (ukazuje rozvahu) – neruš ji automaticky jen proto, že je to pauza.
- **J-cut/L-cut u rozhovorů**: zvuk další repliky může začít těsně před obrazovým střihem (J-cut, dodá to dynamiku/spád) nebo naopak zvuk předchozí repliky doznívá přes nový záběr (L-cut, dá to důraz/plynulost). Offset 1–2 s je obvykle ideální, nad 3 s diváka ruší nesoulad zvuku a obrazu.
- **Tempo pro sociální sítě / krátký obsah**: úvodní hák (0–3 s) na plnou intenzitu, pak častější střihy (řádově 1,5–5 s podle platformy) v první třetině, později se rozestupy mezi střihy můžou zvětšovat (25–40 s), jakmile diváka "hák" chytil. U zpravodajství/delšího obsahu tohle neplatí tak přísně – tam vede obsah a smysl, ne rychlost střihů.

## Postup střihu podle obsahu
1. `premiere_status` → `get_project` / `get_sequence` (zjisti zdrojové soubory a stopy).
2. `transcribe_media` pro každý zdroj s řečí. U dlouhého přepisu vrátí jen začátek – dál čti cíleně
   (`search_transcript`, `get_outline`, `get_transcript` s `fromId`/`toId`), ne celý přepis.
   - Má-li každý mluvčí vlastní mikrofon, předej `speakerTracks` – v přepisu pak uvidíš `[jméno]`.
   - Jména a značky předej v `prompt`, zlepší to přesnost.
3. Přečti CELÝ přepis a teprve pak navrhni střih:
   - zachovej celé myšlenky, věty neutínej uprostřed (jen přes `fromWord`/`toWord`, když to dává smysl),
   - vyhoď přeřeknutí, opakované pokusy (ber poslední povedenou verzi), vatu a dlouhé pauzy,
   - hlídej, aby na sebe věty logicky navazovaly a kontext nebyl zkreslený,
   - u rozhovoru zachovej otázku i odpověď.
4. `build_sequence_from_transcript` – vytvoří NOVOU sekvenci, původní střih zůstává. Vrátí-li `continuity`
   (výběr utnul souvětí), postav ji znovu s doplněným pokračováním/začátkem.
5. Shrň uživateli, co jsi vybral a proč (ID vět + délka výsledku).
6. **Povinná kontrola hranic u krátkých/punchy sestřihů** (upoutávky, highlight, jednotlivé silné výroky do ~1 min) ze zpravodajského/produkovaného materiálu (grafiky, infografiky, přebaly) – NE u běžných rozhovorů/schůzek se statickou kamerou (tam se přeskočí, viz sekce Více kamer):
   - Stav sekvenci přes `build_sequence_from_transcript` s `sceneCuts: true`: server detekuje skryté střihy obrazu
     v oknech kolem hranic klipů a hranici, kde střih padne do 1,5 s uvnitř klipu, na něj sám přichytí (jen když mezi
     nimi není řeč – slovo se nikdy neuřízne). Ruční `detect_scene_cuts` není potřeba (a nikdy ne přes celý zdroj –
     detekce neroste lineárně, 350 s nestihlo ani 15 min a zablokovalo Premiere).
   - Výsledek vrátí `sceneCuts`: posunuté hranice a upozornění „⚠ … uvnitř řeči – obraz jen bleskne“. U upozornění
     zvaž výměnu věty za sousední se stejným smyslem, která leží celá v klidném záběru (reálně se osvědčilo 2026-09-17).
   - Zmiň v shrnutí, že jsi hranice ověřil (i když nic neopravoval), ať je vidět, že se to nepřeskočilo.

## Dlouhý materiál (hodina a víc) – šetři kredity
1. `transcribe_media` (běží v lokálním Workeru, cache) → `diarize_media` nebo `speakerTracks` → `rename_speakers`.
2. `analyze_transcript` – lokální LLM udělá osnovu kapitol a označí slabé věty. Pracuj s osnovou, ne s celým textem.
3. Plný text čti jen u kapitol, které do střihu patří: `get_transcript` s `fromId`/`toId` a `format: "compact"`.
4. Sestřih podle obsahu (verze na X minut o tématu): `plan_edit_local` s `format: "review"` – lokální model navrhne
   věty i náhradníky, ty návrh jen zkontroluješ a postavíš. Změřeno: ~4× levnější než vlastní čtení kapitol, kvalita stejná.
   `backend` vynech (auto = Hermes, když běží) a `instruction` předej doslova, jak ho napsal uživatel.
5. Chce-li uživatel střih úplně bez kreditů: `plan_edit_local` s `build`.

## Více kamer
1. Reference = hlavní zvuk (mix/zvukař). Přepis + mluvčí reference (mikrofony nebo diarizace, pojmenuj je).
2. `build_multicam_sequence` s kamerami `{source, role: wide|close, speakers:[jméno]}` – offsety se dopočítají ze zvuku.
   Nejdřív `dryRun: true`, zkontroluj nejisté synchronizace a nenamapované mluvčí, pak ostrý běh.
3. Lze kombinovat se střihem příběhu: `picks` (ID vět reference) → kamery se přepínají jen ve vybraných úsecích.
4. `detect_scene_cuts` najde skutečné vizuální střihy kamer zapečené uvnitř jednoho zdrojového souboru (ne podle zvuku). Jako obecný nástroj na hledání řezů volej jen na výslovné přání (např. "najdi řezy kamer v tomhle záznamu") – vytvoří dočasnou sekvenci, u dlouhého úseku může trvat přes minutu. Proaktivní použití u krátkých sestřihů ze zpravodajského materiálu viz bod 6 výš v "Postup střihu podle obsahu".

## Dabing / dodatečně namluvený komentář (obraz pod komentář)
Když je řeč jen na samostatné zvukové stopě (komentář namluvený dodatečně) a obraz jsou záznamy bez řeči
(záznam obrazovky, b-roll), NEstříhej podle řeči ve videu – tam žádná není. Postup:
1. `transcribe_media` komentáře (zvuk ze sekvence) – věty s časy.
2. `index_broll` (bez `paths` = obrazové zdroje z aktivní sekvence; další záznamy přidej do `paths`).
   Když vidíš obrázky, dej `sheets: true` (a klidně `describe: false`) a archy si prohlédni sám – přesnější než popis.
3. Ke každé větě vyber záběr, který ukazuje přesně to, o čem věta mluví; dlouhé věty a výčty („stovky variant“)
   rozděl na víc různých záběrů; nepoužívej stejné místo dvakrát; drž logiku děje (zadání → práce → výsledek).
4. `build_voiceover_sequence` se `segments` (`source`, `in` = čas ve zdroji, `sentence` = ID věty, nebo `at` = čas
   v komentáři pro další záběr uvnitř dlouhé věty) – NOVÁ sekvence, komentář beze změny, střih těsně před větou.
   Bez `segments` to udělá lokální model sám (pomalejší, méně přesné).

## Pravidla
- Časy jsou v sekundách. Časy přepisu jsou ve zdroji, `transcribe_sequence` vrací časy timeline.
- Destruktivní nástroje (`remove_timeline_ranges`, `remove_clips`) jen na výslovné přání – a předtím vždy zavolej `backup_project` (tlačítko "↶ Zpět" v panelu není spolehlivé, viz jeho popis).
- `run_extendscript` jen když na úkol neexistuje nástroj.
- Když uživatel mluví o "nově vloženém"/"právě naimportovaném" videu bez udání jména/cesty, zjisti ho přes `list_project_items` se `sort: "recent"` (nebo `get_sequence` na aktivní sekvenci, pokud už je na timeline) – NEZKOUŠEJ shell příkazy (Get-ChildItem/ls/dir) na hledání souborů mimo `O:\MYpremiereMCP`, jsou bezpečnostním sandboxem blokované a stejně by to nebyl spolehlivý postup.
- Když cituješ nebo shrnuješ čísla/tvrzení z přepisu, piš přesně to, co tam je (co model skutečně slyšel/napsal) – neopravuj si potichu čísla podle vlastního dopočtu (např. "1250 €" nepřepisuj na "12,50 €", i kdyby to z kontextu dávalo větší smysl). Pokud přepis vypadá jako chyba ASR, řekni to výslovně vedle citace, ale nenahrazuj hodnotu tiše.
- Cizojazyčný materiál: `add_captions` s `translate: "cs"` = titulky rovnou přeložené do češtiny (řeč v jakémkoli
  jazyce i mixu, lokálním modelem, po celých větách). U přepisu cizojazyčného nebo vícejazyčného videa dej `transcribe_media` `language: ""`
  (jazyk se zjišťuje po úsecích – jinak Whisper celý soubor „přeloží“ do jednoho jazyka).
- `add_captions` (české titulky) volej až po dokončeném střihu dané sekvence – časy se počítají z aktuálního stavu timeline, další úpravy střihu by je rozjely. Premiera umí zobrazit jen úplně první titulkovou stopu v sekvenci, proto nástroj druhé volání na stejnou sekvenci sám odmítne (dokud uživatel ručně nesmaže starou "CC" stopu v Premiere, nebo nepošleš `force: true`, což ale výsledek nezobrazí).
