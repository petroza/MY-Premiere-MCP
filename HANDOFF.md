# HANDOFF – MY Premiere MCP (pro navazujícího Claude)

> Uživatel (Petr) píše česky, odpovídej česky, stručně. Pracuj v `O:\MYpremiereMCP`.
> Začni: přečti tenhle soubor, `README.md` a `CLAUDE.md`, pak `node scripts/smoke.mjs` a `worker_status`.
> **Claude CLI je teď přihlášené** (`claude auth status` → loggedIn true, firemní účet v organizaci) – panel i `panel-run.mjs` fungují end-to-end, žádný obchvat přes přímou MCP session není potřeba.

> **Stav k 2026-09-23 (večer).** Nejnovější věci jsou v sekcích 0, 9, 10, 11. Starší sekce (5a–5v) jsou historie předchozích session.

## 0. ZAČNI TADY – aktuální stav a rozdělaná práce (2026-09-23)

### Co se právě dělalo
Uživatel chtěl: (a) připojit svůj **lokální Hermes** (agent na `O:\Hermes`, llama-server na portu 8000,
model Qwen3.6-35B-A3B) jako další "mozek" pro střih, (b) porovnat kvalitu střihu **Claude vs Hermes**,
(c) porovnat **všechny modely** v panelu, (d) **vyladit Hermese**, (e) rozpoznávat mluvčí **podle barvy hlasu**.
Body a–c jsou hotové a změřené (sekce 9 a 10). Body d+e jsou naimplementované, ale **chybí je doměřit**.

### Stav po nočním ladění 2026-09-24 ráno – podrobnosti v sekci 12
- Plán lokálním modelem: debata 229 s → ~40–70 s, bez vad (moderátor, useknuté i nedokončené věty, odbočky = 0),
  délka ±3 %, vyvážení mluvčích i témat, deterministické (teplota 0). Osnova 5,5 → 2,1 min, přepis 4× rychlejší
  (dávkově), celá cesta u nového 42min videa ~5 min.
- Claude v panelu: `--tools=ToolSearch --effort medium` + `panel/agent-system.md` + hybrid (`plan_edit_local
  format:"review"`) → typický střih $0,85 / 132 s → **$0,16 / 69 s**, stejná kvalita.
- Opravené chyby: hodnocení jen K1–K16, přepis znovu při jiném `prompt` (měnil číslování), filtr moderátora,
  kolize zvuků v multicam, `detect_scene_cuts` přes celý zdroj (teď `ranges`, 7,8 s).
- Testy: `test-hermes-loop`, `test-plan-diskuse`, `test-plan-battery`, `test-fresh-pipeline`, `compare-agents`.
- Ráno doplněno: `sceneCuts: true` u stavby (hranice → skryté střihy obrazu, jen v tichu; upoutávka přes panel
  75 s / $0,20), `continuity` varování při utnutém souvětí, lokální stavba nově dolaďuje konce vět podle zvuku,
  instrukce MCP serveru přepsány na úsporný postup, „SCENE DETECT“ se znovu používá, `local-edit` rozumí
  „třicetisekundová“. Úzké zadání přes panel 21 s / $0,08.
- Otevřené: knihovna hlasů na jiné nahrávce stejných lidí (chybí materiál); v testovacím projektu testicek2 je
  hodně testovacích sekvencí + „SCENE DETECT …“ (smazat ručně); `test/fresh/debata-nova.mp4` (640 MB) lze smazat.

### Aktualizace 2026-09-23 ~21:15 – body 1–3 níže HOTOVÉ (výsledky v sekci 11, "Doměřeno")
Zbývá jen bod 4 (gemma3) a ověřit knihovnu hlasů na **jiné nahrávce stejných lidí** (zatím chybí materiál).

### Rozdělaná práce (původní seznam)
1. **5 kol testu Hermese po ladění** – `node scripts/test-hermes-loop.mjs 5`.
   Poslední běh spadl (všech 5 kol) na `URLError 10061`, protože `scripts/restart-worker.ps1` tehdy zabíjel
   i uživatelův Hermes (matchoval jakýkoli `llama-server`). **Opraveno** – skript porovnává celou cestu a sahá
   jen na náš `tools\llama.cpp\llama-server.exe`. Před testem ověř Hermes:
   `curl -s -m 30 http://127.0.0.1:8000/health` (když neběží: `powershell -File O:\Hermes\switch-llm.ps1 vize`, náběh ~2 min).
2. **Porovnej s hodnotami PŘED laděním** (Hermes, stejné zadání, cíl 180 s):
   délka 185 s · 19 vět · **1 věta moderátora** · **2 useknuté začátky** · 3 odbočky mimo téma · parkování 4 / bydlení 7.
   Po ladění by moderátor i useknuté věty měly být 0 (řeší se deterministicky, viz sekce 11).
3. **Dokonči test knihovny hlasů** – `node scripts/test-voices.mjs`. Krok 0 už prokazatelně funguje:
   diarizace debaty dala S1 20:34 / S2 14:57 / S3 05:09, což odpovídá Ferancová / Vašíř / moderátor.
4. Volitelně: doměřit **náš gemma3 (backend "local")** na stejném úkolu – zatím nešlo, protože Hermes drží
   ~11 GB VRAM; `ensure_llm` má fallback na méně vrstev na GPU (`llm.gpuLayersFallback`), ale bude to pomalé.

### Co musí běžet
| Co | Jak ověřit / spustit |
|---|---|
| Premiere + panel (most :7880) | `node scripts/test-premiere.mjs status`; panel = Okno > Rozšíření > MY Premiere MCP |
| Worker (:7881) | `curl -s http://127.0.0.1:7881/health` – musí odpovědět **do ~1 s**, jinak ho MCP server považuje za mrtvý |
| Hermes (:8000, pro backend "hermes") | `curl -s -m 30 http://127.0.0.1:8000/health`, start `O:\Hermes\switch-llm.ps1 vize` |
| Claude CLI | přihlášené (`claude auth status`) |
| Codex CLI | **není v PATH**, leží v `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` (panel i `compare-agents.mjs` to najdou samy) |

### Testovací materiál a sekvence
- Hlavní materiál: `C:\Users\Petr\Downloads\01-video\tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4`
  (předvolební debata Olomouc, 41:57, 362 vět; přepis, diarizace i osnovy jsou v cache).
  **Pozor:** soubor se v průběhu prací přesunul z `C:\Users\Petr\Downloads\` do podsložky `01-video`;
  klíče v cache byly přemapované, ale položka v projektu Premiere má pořád starou cestu.
- Projekt Premiere: `O:\DETAIL\premiere\testicek2.prproj`; sekvence `STRIH CLAUDE…`, `STRIH HERMES…`,
  `STRIH CLAUDE-HAIKU/SONNET/OPUS`, `STRIH CODEX-GPT-…` (výsledky srovnání, dají se přehrát a porovnat očima).
- Druhý materiál: `test/podcast/Diskuse1.mp4` (CC BY-NC-ND, 26:39) – slouží i jako kontrola, že se cizí hlasy
  nepřiřadí k uloženým jménům v knihovně hlasů.

### Skripty, které k tomu patří
| Skript | K čemu |
|---|---|
| `scripts/test-hermes-loop.mjs [kol]` | N kol stejného zadání Hermesem, měří kvalitu i **stabilitu** výběru |
| `scripts/compare-agents.mjs "claude:sonnet,codex:gpt-5.5,hermes:local"` | srovnání modelů, každý staví vlastní sekvenci |
| `scripts/eval-sequences.mjs "NÁZEV SEKVENCE" …` | obsahové vyhodnocení hotové sekvence (vady, pokrytí témat) |
| `scripts/compare-llm.mjs [backendy] [cesta] [cíl]` | srovnání jen LLM backendů (osnova + plán), zadání přes env `INSTRUCTION` |
| `scripts/local-edit.mjs [backend]` | to, co spouští panel ve volbě "Hermes (lokálně, zdarma)" |
| `scripts/test-voices.mjs` | knihovna hlasů: diarizace → pojmenování → automatické rozpoznání |
| `scripts/restart-worker.ps1` | tvrdý restart Workeru (nesahá na cizí llama-server) |

### Pasti, na které jsem dnes naletěl (nedělej znovu)
- **Dva Workery na jednom portu** (Windows SO_REUSEADDR) – opraveno; kdyby se to vrátilo, projeví se to tak,
  že změny ve `worker/*.py` "nic nedělají". Ověření: po restartu se musí změnit `pid` v `/health`.
- **Pomalé `/health`** (4 s kvůli dotazům na LLM backendy) shazovalo start Workeru – stav se teď cachuje 15 s
  a dotaz má 0,4 s limit.
- **`restart-worker.ps1` zabíjel Hermes** – opraveno (porovnává celou cestu k exe).
- U dlouhých sekvencí volej `get_sequence` s `clips: false`, jinak to zahltí kontext.
- Výstup skriptů spuštěných přes `| tail` se objeví až po doběhnutí – nediv se, že "nic nepíše".

## 1. Cíl uživatele
1. **Střih v Adobe Premiere Pro přes Claude nebo Codex (GPT) podle promptu**, i u **hodinového videa**, s porozuměním **českému dialogu** (co kdo říká, aby střih dával smysl).
2. **Automatický střih více kamer**: typicky kamera na každého hosta + celek, přepínání podle toho, kdo mluví.
3. **Šetřit kredity Claude**: těžké věci lokálně (Worker), Claude dostává jen kompaktní osnovu.

## 2. Závazné preference uživatele
- **Žádná závislost na Ollamě.** Všechny modely a nástroje **ve složce aplikace** (`models/`, `tools/`, `.venv`).
- Netestovat na WINREC nahrávkách – **testovat na videích z internetu** (volné licence, CC). Před stažením souboru uveď název, zdroj, velikost a nech si to potvrdit.
- Instalace/testování dělej sám, ale nic destruktivního v uživatelových projektech (jeho projekt `C:\AI porad\test.prproj` neměnit; testuje se v `O:\MYpremiereMCP\test\MCP_test.prproj`).
- Uživatelovy repo jako inspirace: `petroza/PZ_AI_DAB_ALL` (ASR), `petroza/PZ_VIDEO_TAG` (lokálně `O:\PZ_VIDEO_TAG`).

## 3. Architektura
```
Claude/Codex ──stdio──► server/index.js (MCP "premiere", 41 nástrojů)
                           ├─HTTP 127.0.0.1:7880 + token ─► CEP panel com.pz.premieremcp (panel/main.js) ─► panel/host/host.jsx (ExtendScript ES3)
                           └─HTTP 127.0.0.1:7881 + token ─► worker/server.py (fronta úloh, .venv Python 3.11)
                                                              ├ asr.py      faster-whisper large-v3 CUDA (models/whisper-large-v3)
                                                              ├ diarize.py  "chunks": CAM++ otisky kousků vět + vlastní shlukování; záloha sherpa pyannote
                                                              ├ audiosync.py FFT korelace obálky → offsety kamer
                                                              ├ frame.py    get_frame/describe_frame – snímek videa (+ lokální popis přes vision LLM)
                                                              ├ analysis.py heuristiky + llama-server (tools/llama.cpp b10984, models/llm/gemma3-12b-Q4_K_M.gguf, port 7882)
                                                              └ gpu.py      jen jeden model na GPU (Whisper XOR Gemma3 XOR Qwen3-VL vision, port 7883), úklid osiřelých llama-server
server/multicam.js – čistá logika přepínání kamer (planRuns, multicamClips)
```
- Token: `%APPDATA%\MYpremiereMCP\token.txt` (sdílí panel i Worker). Worker odmítá požadavky s hlavičkou Origin.
- `server/index.js` závisí i na npm `undici` (přidáno 2026-09-15) – vlastní `fetch`/`Agent` s velkorysým `headersTimeout`/`bodyTimeout` pro dlouhé `buildTimeline`/`exportSequence` volání (viz sekce 5 a 7).
- MCP server Worker sám spustí a **restartuje, když má starší kód** (`/health` → `codeStamp`, `pid`).
- Cache: `cache/transcripts|diarization|sync|analysis|jobs` (+ `index.json` podle cesty), logy `cache/worker.log`, `cache/llama-server.log`.
- Registrace MCP: Claude Code (user scope, příkaz `node`), Claude Desktop config, Codex `~/.codex/config.toml` (zálohy `.bak-*`).
- Panel v Premiere: Okno > Rozšíření > MY Premiere MCP (junction z `%APPDATA%\Adobe\CEP\extensions\com.pz.premieremcp`). Panel umí spustit `claude -p` / `codex exec` a ukazuje stav Workeru. `panel/.debug` = DevTools na 8098.

## 4. Klíčové soubory
| Soubor | Co |
|---|---|
| `server/index.js` | MCP nástroje, klient Workeru (`runJob`, `ensureWorker`), most do Premiere (`premiere()`) |
| `server/multicam.js` | pravidla přepínání (minShot 1.8, preRoll 0.3, maxShot 14 → prostřih, překryv/ticho → celek) |
| `panel/host/host.jsx` | ExtendScript API: buildSequence, buildTimeline, removeRanges, exportSequence… |
| `worker/*.py` | viz architektura |
| `config.json` | porty, cesty k modelům, whisper/llm/diarizace (similarity 0.55) |
| `CLAUDE.md` / `AGENTS.md` | pokyny pro agenta (postup střihu, dlouhý materiál, multicam) |
| `install.ps1` | kompletní instalace do složky aplikace (na čistém PC zatím nespuštěno) |
| `corrections.txt` | slovník oprav přepisu |
| `worker/frame.py` | `get_frame` – vytáhne snímek videa (JPEG) pro obrazovou analýzu (Claude vidění i budoucí lokální VLM) |
| `EXTERNI_AI_INSTRUKCE.md` | statická šablona pro externí AI (ChatGPT apod.) – formát přepisu a požadovaný výstupní JSON |

## 5. Ověřeno (vše prošlo)
- `node scripts/smoke.mjs` → 33 nástrojů; `node scripts/test-multicam-unit.mjs` → 10/10; `scripts/test_repair_json.py` OK.
- `node scripts/test-worker.mjs status transcribe diarize sync names multicam analyze` (syntetický rozhovor `test/multicam`, gt.json):
  sync kamer 0 ms, diarizace 91,7 %, mikrofony 100 %, správná kamera 99,7 %.
- `node scripts/test-worker-restart.mjs` → restart při starém kódu, žádný osiřelý llama-server.
- Premiere živě: `test-premiere.mjs` (build, pauses, markers, remove s ripple), `verify-multicam.mjs` (bez mezer, sync ±půl snímku, jen master audio), `test-export.mjs` (MP4 1080p).
- **Skutečné video** `test/podcast/Diskuse1.mp4` (archive.org, CC BY-NC-ND, 26:39): přepis 116 s, diarizace 15 s → 3 mluvčí (S3 moderátor, S2 a S1 panelisté – dává smysl), osnova 112 s, `plan_edit_local` 5 min → sekvence + export 5:15 (`test-podcast2.mjs`).
- **End-to-end přes agenta** (2026-09-15): `claude auth login` proveden uživatelem, `claude auth status` → loggedIn true. Ověřeno dvěma cestami:
  1. Přímo v Claude Code session (`mcp__premiere__*` nástroje) – agentní (ne lokální LLM) střih podle obsahu na `Diskuse1.mp4`: přečten `get_outline` + `get_transcript`, ručně vybráno 16 vět → `build_sequence_from_transcript` → 3:37, 14 úseků, bez varování, ověřeno `get_sequence` (bezešvé navazování).
  2. Reálně přes panel: `node scripts/panel-run.mjs "zadání"` (DevTools most, `panel/.debug`) spustí skutečný `claude` proces stejně jako tlačítko „Spustit“ v panelu – ověřovací dotaz na aktivní sekvenci zodpovězen správně (15 s, $0.57).
- **Skutečný multicam materiál** (2026-09-15): **AMI Meeting Corpus** (groups.inf.ed.ac.uk/ami, CC BY 4.0) – schůzka `ES2002a`, 21:12, 4× kamera na účastníka (bez zvuku) + hlavní mix + 4× oddělený headset mikrofon, staženo do `test/ami/amicorpus/ES2002a/`.
  - `transcribe_media` + `speakerTracks` (4 headsety): 176 vět, 2081 slov za 61 s (RTF ~20×), správné rozlišení mluvčích.
  - `build_multicam_sequence`: 171 záběrů/21 min bez varování; s odstraněním celků a pauz (`ranges` = řeč bez ticha >0,7 s, `maxShot` vypnuté) 138 záběrů/12:15; filtr jen na mužské mluvčí (`ranges` jen jejich intervaly) 69 záběrů/5:44 – uživatelem vizuálně potvrzeno jako správné.
  - **Kamera↔mluvčí mapování NENÍ fixní konvence** (Closeup1≠vždy stejná osoba) – liší se schůzku od schůzky, musí se vzít z dokumentace/metadat (u AMI `groups.inf.ed.ac.uk/ami/corpus/signals.shtml`, tabulka `Role,Cam,Chan`), ne odhadovat. Špatný odhad se projevil přesně tak, jak by to poznal uživatel: „mluví, ale kamera není na něj“.
  - **Kamery bez vlastního zvuku** (samostatný zvuk/obraz systém, žádný scratch audio na kameře) → `sync_media`/auto-sync v `build_multicam_sequence` na nich spadne (potřebují zvuk na obou stranách pro FFT korelaci); řešení: zadat `offset` ručně (u AMI 0, signály sdílejí společnou časovou osu ze zdroje). Opraveno v `worker/audiosync.py` (viz níže) – dřív kryptický `IndexError`, teď jasná hláška.
- **Zátěž ~1 h / 800+ záběrů** (2026-09-15, večer): syntetickým opakováním reálného AMI přepisu (5× 21 min = 61:16, 810 naplánovaných záběrů, 1385 klipů) se narazilo na **skutečný a opravený bug**, ne jen teoretické riziko:
  - `build_multicam_sequence` na tomhle rozsahu spadl s `UND_ERR_HEADERS_TIMEOUT` po ~6 minutách, přestože kód nastavuje `AbortSignal.timeout(1 810 000 ms)` (~30 min). Příčina: Node vestavěný `fetch` (undici) má **defaultní `headersTimeout`/`bodyTimeout` 300 000 ms**, který `AbortSignal` nepřebíjí. Stejný defaultní limit (`server.requestTimeout` 300 000 ms) měl navíc i panelův vlastní `http.createServer` na straně přijímače.
  - Oprava: `server/index.js` teď používá `fetch`/`Agent` **z npm balíčku `undici`** (přidán jako závislost) s vlastním `headersTimeout`/`bodyTimeout` 7 200 000 ms – POZOR, globální vestavěný `fetch` nejde takhle nakonfigurovat a `dispatcher` z npm `undici` je **nekompatibilní** s vestavěnou verzí (`InvalidArgumentError: invalid onRequestStart method`), proto se musí použít i `fetch` ze stejného balíčku, ne global. `panel/main.js` má nově `server.requestTimeout = 0; server.headersTimeout = 0;` (po úpravě nutný reload panelu/stránky, ne jen `es.mjs --reload`).
  - Po opravě: **1385/1385 klipů, 61:16, bez varování, ~580–660 s** (real Premiere build, ne dry run). To je ověřený reálný výkon pro hodinový multicam střih – úkol „zátěž 1 h“ z předchozí verze handoffu je tím hotový.
  - Zkusil jsem i domnělou optimalizaci `findClipAt` v `host.jsx` (lineární scan od začátku → od konce, O(n²)→O(n) pro typický případ). **Neprokázalo se zrychlení** (658 s vs. 580 s baseline, v mezích šumu) – skutečné dno je zjevně přímo v Premiere API (`overwriteClip`/`setInPoint`/`setOutPoint` s verify-readback), ne v JS skenu. Oprava v kódu zůstala (je bezpečná, nikdy nezhorší korektnost), ale nečekej od ní měřitelný přínos – viz otevřený úkol #6.
  - Regresně ověřeno po zásahu do `server/index.js`, `panel/main.js`, `host.jsx`: `smoke.mjs`, `test-multicam-unit.mjs` (10/10), `test-premiere.mjs status build pauses markers remove` – vše prošlo.
- **`analyze_transcript`/`plan_edit_local` na anglickém obsahu** (2026-09-15, poprvé testováno jinak než česky, na `ES2002a.Mix-Headset.wav`): našel a opravil se **skutečný, opakovaně reprodukovatelný bug**.
  - `worker/gpu.py chat_json()` nekontroloval, že model (gemma3 12B) fakticky vrátil JSON **objekt** – u posledního chunku (5/5, delší/composité věty) vrátil validní JSON, ale ne objekt (`{"chapters":...}`), takže `data.get(...)` v `worker/analysis.py` spadlo na `AttributeError: 'str' object has no attribute 'get'`. Navíc `_fix_chapters()` neodchytávala `AttributeError`, když položka v `chapters` sama nebyla dict.
  - Oprava: `chat_json()` teď po parsování ověří `isinstance(result, dict)` a při nesouladu vrátí `{}` (degraduje na prázdný chunk místo pádu); `_fix_chapters()` odchytává i `AttributeError`.
  - Po opravě: **15 kapitol, 48 slabých vět** – osnova dává smysl (shrnutí česky i pro anglický zdroj, podle promptu). `plan_edit_local` s instrukcí „3minutová verze o ceně a mezinárodním prodeji“ → 24 vět, chytře vybrané podle skóre kapitol (K7/K9/K14 = jádro), **183,6 s vs. cíl 180 s** (přesnost ~2 %). Regresně ověřeno `test_repair_json.py` (4/4 OK).
- **Reálné střihové zadání přes panel/CLI** (2026-09-16, `node scripts/panel-run.mjs`, ne přímá MCP session): zadání „udělej 2minutovou verzi o tom, jak tým řeší cenu dálkového ovládání“ na `ES2002a.Mix-Headset.wav`. Agent sám: ověřil projekt, zkusil krátké jméno souboru u `get_outline` (chyba, protože osnova je indexovaná podle plné cesty), sám se opravil, přečetl slova v cílovém úseku, rozpoznal překryvy řeči typické pro AMI nahrávku a použil `fromWord`/`toWord` k čistému zastřižení 6 vět – **sekvence 1:58, 12 úseků, nic nesmazáno**, 140 s, $0,90. Celý postup z `CLAUDE.md` (ověř projekt → přečti CELÝ úsek → zachovej myšlenky → nová sekvence → shrň proč) proběhl bez zásahu.
- **Zbylé netestované nástroje na AMI multicam sekvenci** (2026-09-16): `transcribe_sequence` (přepis v časech timeline, mnoho krátkých klipů ze stejného zdroje) – čitelný, správně poskládaný, bez pádu; `search_transcript` – funguje; `export_sequence` na sekvenci „TEST AMI jen muzi“ – `{"result":"No Error"}`, 46 MB, ověřená přesná délka 344,68 s (`av` v Pythonu), zvuk i obraz v pořádku. Žádný bug – jen chybějící pokrytí testy.
- **Diarizace na reálné 4mluvčí konverzaci** (2026-09-15, `diarize_media` na `ES2002a.Mix-Headset.wav`, `numSpeakers:4`, porovnáno slovo po slovu proti ověřenému přepisu z mikrofonů): metoda „chunks“ **rozlišila jen 2 skutečné shluky místo 4** – Laura (1150/2081 slov) a Andrew (771 slov) dostaly svůj shluk správně, ale **David (87 slov) a Greg (39 slov) se do žádného vlastního shluku netrefili ani jednou** – jejich řeč pohltily shluky Laury/Andrewa. Nejlepší možné přiřazení shluků na mluvčí vychází na 92,3 % slov, ale to číslo je zavádějící (tažené jen dvěma nejmluvnějšími) – reálně diarizace **úplně minula 2 ze 4 lidí**. Potvrzuje to už zapsané podezření u `worker/diarize.py` (`_chunks`/`_smooth`/`similarity`) – tichejší/méně mluvící účastníci mají tendenci se ztratit v shluku dominantního mluvčího. Neladil jsem parametry (`similarity` 0,55, threshold) – bez jasné poptávky uživatele a bez rizika rozbití toho, co funguje na syntetickém testu (99,7 % správná kamera). Přepis po testu obnoven zpět na mikrofonní jména (`transcribe_media force:true` + `rename_speakers`), diarizace nic nezanechala v produkčních sekvencích.

## 5b. Srovnání s ostatními (2026-09-16) a rozhodnutí

Uživatel se zeptal, jestli jsem porovnal náš přístup s tím, jak to řeší jinde – neporovnal jsem dřív, teď ano (web research). Zjištění a rozhodnutí:

1. **Architektura CEP panel + ExtendScript most** – odpovídá tomu, jak to dělají i jiné veřejné Premiere MCP servery (na GitHubu existuje víc podobných projektů). Není to zastaralý nápad, je to prakticky jediná cesta, protože Premiere nemá vlastní externí scripting API (na rozdíl od DaVinci Resolve/Final Cut, kde MCP servery jdou přímo na nativní API bez CEP mostu).
   - **Aktualizace 2026-09-16 (ověřeno přímo z Adobe zdrojů, ne agregátorů):** to "časově naléhavé" varování z předchozí verze bylo přehnané – zdroj byl webový research agent, který citoval nepotvrzené komunitní odhady. Šel jsem přímo na `developer.adobe.com/premiere-pro/` a `github.com/Adobe-CEP/CEP-Resources`: **Adobe nikde nepublikovalo konkrétní datum konce podpory CEP.** Adobe dev stránka jen říká "UXP is the next generation of APIs, for Premiere v25.6 and beyond" (směr, ne deadline), Adobe-CEP repo nemá žádné oznámení o ukončení. To komunitní vlákno o "CEP/UXP roadmap", které jsem dřív citoval jako zdroj "asi rok" – je to **nezodpovězená otázka uživatele**, ne odpověď od Adobe; zmínka "2026" tam byla jen dohad tazatele. **Závěr: sledovat vývoj (UXP je jasně budoucí směr), ale není to akutní požár – žádný ohlášený deadline neexistuje.** Panel v Premiere 26.0.1 funguje bez problémů.
2. **Pravidlová logika přepínání kamer** ("kdo mluví → ten je na detailu, ticho/překryv → celek, dlouhý monolog → prostřih") – přesně tohle dělá i Descript (Automatic Multicam), Riverside.fm i komerční Premiere pluginy (AutoCut Angles, Autopod). Žádný z nich nepoužívá pro VÝBĚR záběru trénovaný model – jen detekci aktivního mluvčího ze zvuku, stejně jako my. **Rozhodnutí: neměnit, je to zavedený standard.**
3. **Diarizace (CAM++ embeddingy + vlastní shlukování)** – náš pozorovaný problém (tišší mluvčí zaniknou v shluku dominantního) je **známá slabina prostého shlukování**. Zavedená oprava z výzkumu je **VBx** (bayesovské shlukování embeddingů) místo tvrdého prahování podobnosti; aktuální open-source špička je DiariZen (segmentace + VBx + PLDA). CAM++ jako embedding model samotný je OK (konkurenceschopný, rychlejší než ECAPA-TDNN) – problém je jen v kroku shlukování. **Rozhodnutí: neimplementovat teď (VBx je netriviální, bez ověřovacích dat riziko převažuje přínos) – zůstat u doporučení preferovat `speakerTracks`, ale zapsat si VBx/DiariZen jako konkrétní budoucí vylepšení, kdyby uživatel jednou chtěl řešit fakt spolehlivou diarizaci bez oddělených mikrofonů.**
4. **Gemma 3 12B pro strukturovaný JSON výstup** – vyšla Gemma 4 (duben 2026, i 12B varianta), ale **stejný bug s nevalidním JSON objektem hlásí lidi i na Gemma 4** (je to rodová vlastnost Gemma modelů přes llama.cpp/vLLM/ollama, ne verzní chyba). Skutečná oprava není "vyměnit model", ale **gramaticky vynutit JSON schéma** (`response_format: json_schema` / GBNF), což `llama-server` (naše verze b10984) **umí a ověřil jsem to živě**. **Rozhodnutí a provedeno hned:** `worker/gpu.py chat_json()` teď bere volitelný `schema` parametr a posílá `json_schema` misto `json_object`; `worker/analysis.py` má schémata pro všechna 3 volání LLM (kapitoly/weak, skóre kapitol, výběr vět). Ověřeno živě – `analyze_transcript` i `plan_edit_local` fungují čistě, bez spoléhání na záchrannou síť po pádu. Gemma 3→4 upgrade (nový ~8GB download) zatím neřešit, benefit je nejistý a náš skutečný problém to neřešilo.

## 5c. Obrazová analýza, undo, externí AI most (2026-09-16 dopoledne)

Uživatel chtěl: 1) obrazovou analýzu (Claude i lokální vidění) pro párování kamera↔mluvčí, 2) tlačítko zpět v panelu, 3) možnost exportovat analýzu do souboru a nechat střih navrhnout externí AI (ChatGPT, neomezené tokeny) přes soubor.

- **`get_frame` nástroj** (nový, `worker/frame.py` + `server/index.js`) – vytáhne snímek videa v daném čase, vrátí ho jako obrázek (MCP image content). Cestou nalezen a opravený **skutečný bug**: `cv2.imwrite` na Windows neumí Unicode cesty (rozsype diakritiku v názvu souboru – testováno na `Špidla_EU...mp4`) → přepsáno na `cv2.imencode` + `Path.write_bytes()`.
  - **Ověřeno naživo end-to-end** přes `panel-run.mjs` (fresh `claude -p`, ne přímá session): agent sám zavolal `get_frame`, podíval se na snímek a správně popsal záběr (statický širák, tři lidé, projekce na pozadí, bez detailu) – přesně jako moje ruční kontrola. $0,50/dotaz.
  - **Lokální vidění – HOTOVO a funkční.** Stažen **Qwen3-VL-4B-Instruct** (Q4_K_M, 2,5 GB + mmproj Q8_0, 454 MB; huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF, Apache 2.0) do `models/llm-vision/`. Náš `llama-server` (build b10984) **Qwen3-VL podporuje bez problémů** (ověřeno přímým spuštěním – model se načte za ~2 s). Zapojeno do `worker/gpu.py`: `ensure_vision_llm()` + `describe_image()`, GPU sdílení rozšířeno na **tři modely** (Whisper XOR Gemma3-text XOR Qwen3-VL-vision – ověřeno obousměrně, `_free_vision()`/`_free_llm()`/`_free_whisper()` se navzájem správně vytěsňují). Nový worker job `describe_frame` (snímek + lokální popis v jednom), MCP nástroj `describe_frame`. **Ověřeno naživo přes `panel-run.mjs`**: 16 s, $0,093 (jen režie volání nástroje, samotná inference je zdarma/lokální, ~0,8 s), popis přesně odpovídal tomu, co viděl Claude vidění i ruční kontrola ("tři muži za stolem, projekce na pozadí, mírně rozostřené"). `config.json` má novou sekci `llmVision` (port 7883) a `models.llmVision`/`models.llmVisionMmproj`. `install.ps1` (krok 6b/7) stahuje model automaticky na čistém PC.
- **Undo v panelu** – `qe.project.undo()` (QE DOM, nedokumentované, ale funkční – ověřeno `typeof` před použitím) zapojeno jako `api.undo` v `host.jsx`, MCP nástroj `undo`, a přímé tlačítko **„↶ Zpět"** v panelu (bez volání AI, zdarma, přes `evalQueued` primo).
- **Přepínač "nástroje"** v panelu – technický log (`⚙ ToolSearch`, volání nástrojů) je defaultně **skrytý** (CSS `#out:not(.show-tools) .tool`), zaškrtávátko ho zpřístupní. Uživatel si to vyžádal po zhlédnutí zbytečně technického logu.
- **Export/import pro externí AI** (ChatGPT apod., "záložní varianta"):
  - `export_analysis(path, output?)` – uloží osnovu + celý přepis (s indexy slov) do jednoho `.md` souboru vedle zdroje (`<zdroj>.analyza.md`). Ověřeno: 38 KB, čitelné, správný formát.
  - `build_from_plan(planFile, source, name?)` – načte JSON `{"name":..,"picks":[..]}` ze souboru (i s okolním textem, vezme první `{...}` blok) a postaví z něj sekvenci stejnou cestou jako `build_sequence_from_transcript`. Ověřeno živě – reálná sekvence v Premiere.
  - `EXTERNI_AI_INSTRUKCE.md` v kořeni projektu – statický text pro vložení do ChatGPT (formát přepisu, pravidla výběru, přesný výstupní JSON formát).
  - Panel: sbalená sekce "Záložní varianta: jiná AI" s tlačítky **Otevřít instrukce** / **Vzor: exportovat analýzu** / **Vzor: sestříhat podle plánu** (vyplní prompt šablonou, uživatel doplní cestu a klikne Spustit – nejde o přímý bypass agenta, protože export/import logika žije v `server/index.js`, ne v `host.jsx`, takže panel na ni nemá přímý HTTP most jako na ExtendScript; cena za jedno mechanické volání je ale jen ~$0,10, nevadí to).
- **`START.bat`** v kořeni – zahřeje Worker na pozadí + spustí Premiere, jedno kliknutí.
- Regrese po všech změnách: `smoke.mjs` (41 nástrojů), `verify-host.mjs`, `test-multicam-unit.mjs` (10/10), `test_repair_json.py` (4/4) – vše OK. Živě ověřeno i `analyze_transcript` (Gemma3) hned po použití vision modelu – GPU vytěsňování funguje obousměrně.

## 5d. Další reálný test (2026-09-16, dopoledne) – studiové video, diarizace funguje

Nový soubor `tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4` (42 min, TN Live "Napřímo" – předvolební debata o primátora Olomouce; název souboru zavádí, obsah je o Olomouci, ne Liberci). Celý pipeline (transcribe → analyze → plan_edit_local → build) bez chyby, 50 kapitol, 2min sestřih "nejostřejší střety" → 16 úseků, cíl trefen na 2,6 %.

- **Diarizace na 3 mluvčích – tentokrát skvěle funguje** (`diarize_media numSpeakers:3`): časy řeči 20:34/14:57/5:09 přesně odpovídají rolím (primátorka, kandidát, moderátorka s kratšími vstupy). **Důležité upřesnění k včerejšímu zjištění (sekce 5, AMI test):** problém není v metodě "chunks" obecně, ale konkrétně ve **špatné akustice nahrávky z jedné mikrofonní room-nahrávky** (AMI). Na **studiovém zvuku s odděleným ozvučením** (TV produkce) diarizace 3 mluvčí rozliší bez problémů. Diarizace tedy NENÍ obecně nespolehlivá – jen na "nahrávka z místnosti bez oddělených mikrofonů" scénář, což potvrzuje smysl doporučení `speakerTracks`, ale neznamená to nutnost VBx pro běžné studiové nahrávky.
- `describe_frame` správně popsal i netypický záběr (infografika s koláčovým grafem a seznamem zastupitelů, ne "mluvící hlava") – zobecňuje dobře i mimo talking-head záběry. $0,04/dotaz.

## 5e. Undo – reálný bug nalezen a zmírněn (2026-09-16)

Otestoval jsem `qe.project.undo()` (undo tlačítko v panelu) opakovaným klikáním na jedné testovací sekvenci. **Výsledek: nebezpečné.** Undo nepracuje na úrovni "jedna akce nástroje = jeden krok zpět", ale na úrovni jednotlivých vnitřních Premiere operací (např. samostatně nastavení in-pointu klipu). Po 7 kliknutích po sobě se klip v sekvenci **nezmizel, ale natáhl se na celý zdrojový soubor** (42 min místo původních 8,64 s) – sekvence zůstala v nekonzistentním, matoucím stavu, ne čistě vrácená zpět.
- **Zmírnění (provedeno):** tlačítko "↶ Zpět" v panelu se po jednom použití **zamkne** (`$('undo').disabled = true`) a odemkne se, až proběhne další "Spustit" (čerstvá historie). Text u tlačítka i hláška po použití teď varují, že jde jen o jeden krok a že se má zkontrolovat výsledek v Premiere.
- **Neopraveno zůstává:** i JEDNO kliknutí nemusí vrátit celou akci nástroje (u vícekrokových operací typu `build_sequence_from_transcript` může vrátit jen dílčí krok, ne celou sekvenci pryč). Skutečně spolehlivé řešení by potřebovalo buď `app.project.undo()` (nedostupné – ověřeno `typeof app.undo` i `app.project.undoStack` = undefined) nebo zálohování `.prproj` před destruktivními akcemi. Nezkoumal jsem to dál kvůli riziku dalšího poškození testovacích dat.
- Testovací sekvence `TEST undo zkouska` (duration 2517.4 = rozbitá) zůstala v projektu jako doklad, neuklízel jsem ji schválně.

## 5f. Iterativní upřesňování střihu s pamětí – funguje výborně (2026-09-16)

Uživatel chtěl ověřit: zadám střih, pak řeknu "chybí mi tam téma X, přidej ho", agent by měl pamatovat předchozí stav a inteligentně to sloučit (ne jen mechanicky připojit), ideálně přehodnotit celou skladbu. **Otestováno naživo přes panel se zapnutým "navázat" (dvě navazující zadání, stejná session):**

1. Zadání 1: „Udělej 45sekundovou verzi jen o ceně dálkového ovládání" (na `ES2002a.Mix-Headset.wav`) → sekvence 47 s, 5 úseků. Agent navíc **sám odhalil a opravil moji záměrně špatnou nápovědu** o číslech kapitol (ověřil si to v reálné osnově, nevěřil mi naslepo).
2. Zadání 2 (navazující, stejná session): „Chybí mi tam téma rozšířených funkcí, přidej to, ať to pořád dává smysl, 45-60 s" → **agent si pamatoval předchozí sekvenci**, našel nový relevantní obsah (K12), a **nemechanicky ji rozšířil** – přehodnotil celou skladbu, **vyměnil i původní pointu za lepší**, která propojuje obě témata (cena → zdůvodnění vyšší ceny přes rozšířené funkce → ironická pointa). Nová sekvence 57,38 s, 7 úseků, původní zůstala nedotčená (nová sekvence vedle, podle konvence).

**Závěr: tohle už funguje díky kombinaci `navázat` (session resume) + Claude vlastní úsudek + existující nástroje (get_transcript/get_outline) – nebylo potřeba stavět žádný nový nástroj.** Klíčové je mít v panelu "navázat" zapnuté (je defaultně) a dát agentovi jasně najevo, že jde o navazující úpravu ("přidej do sekvence, co jsi právě udělal"). Obě dodržely i pravidlo "necituj ASR chyby opraveně" z předchozí session. Cena: $0,67 + $0,20 za dva kroky.

## 5g. Nativní titulky v Premiere (2026-09-16) – funguje, undokumentované API

Uživatel chtěl české titulky přímo v Premiere (ne jen v přepisu). Standardní ExtendScript DOM (`Sequence`) titulky vůbec nezná (`captionTracks` je `undefined`, `for...in` je taky neukáže – ExtendScript hostitelské metody nejsou enumerable). Reflexe `seq.reflect.methods` ale odhalila skrytou metodu `createCaptionTrack`, kterou Adobe nikde nedokumentuje. Zjištěno živým zkoušením (na testovací sekvenci, ne na reálném obsahu):

1. `app.project.importFiles([srtPath], true, app.project.rootItem, false)` – import .srt naimportuje soubor jako běžnou položku projektu (typ se navenek neliší).
2. `seq.createCaptionTrack(projectItem, 0)` – **jedno volání** vytvoří v sekvenci novou titulkovou stopu (interně `DataTrackGroup`/`CaptionDataClipTrack`, 3. skupina stop vedle video/audio, v DOM nikde vidět) a **rovnou do ní vloží všechny titulky ze souboru** (`insertClip` navíc není potřeba – zkoušeno, jen by to duplikovalo). Druhý parametr `0` fungoval spolehlivě, jiné typy/hodnoty buď spadly na "Illegal Parameter type", nebo se chovaly stejně – nejde o zdokumentovaný enum, nechán `0`.
3. Ověřeno **na úrovni .prproj XML** (ne jen "nespadlo to"): po `saveProject` dekomprimovaný `.prproj` obsahuje `CaptionCollection`/`Caption` objekty se správným českým textem (diakritika v pořádku) a časy odpovídajícími .srt.

Implementováno jako nástroj `add_captions` (`server/index.js`) + `api.addCaptions` (`host.jsx`): vezme klipy aktivní/zadané sekvence, přepíše zdroje (cache), slova namapuje na **časy timeline** (stejná logika jako `transcribe_sequence`), seskupí do titulků (max ~84 znaků / 6 s / mezera >0,6 s = nový titulek), uloží `.srt` do `cache/transcripts/captions/`, zavolá `addCaptions`. Živě otestováno na `Spidla - jen on, 30s nejostrejsi` (29,2 s): 5 titulků, správný text i časy, potvrzeno v XML (`DataTrackGroup` → 1 stopa → 5 `TrackItem`).

**Omezení (DOM titulky vůbec neexponuje, takže nejde je programově spravovat):** nejde zjistit, kolik titulkových stop sekvence už má, ani žádnou smazat/přepsat skriptem – opakované volání `add_captions` na stejnou sekvenci přidá další stopu navíc (starou je nutné smazat ručně v Premiere). Zapsáno do `CLAUDE.md` a popisu nástroje. Vedlejší efekt testování: testovací sekvence "Cena a rozšířené funkce ovladače (~57s)" má teď 3 nadbytečné titulkové stopy s anglicko-českým testovacím textem (z ladění metody) – neškodí (video/audio stopy nedotčené, ověřeno), ale je to vidět při otevření té sekvence v Premiere; úklid by šel jen ručně přes UI. "Spidla - jen on, 30s nejostrejsi" má z živého testování tlačítka 2 titulkové stopy (viz níže).

**UI v panelu** (`index.html`/`main.js`): přímo pod hlavním řádkem tlačítek je řádek "Titulky" – select znaků/řádek (20–50, výchozí 40), select řádků (1/2, výchozí 2) a tlačítko "💬 Přidat titulky". Klik naplní prompt přesným zadáním (`add_captions` s `charsPerLine`/`lines`) a rovnou spustí agenta (stejná cesta jako ruční zadání, ne přímé volání – `add_captions` potřebuje Worker přepis, který panel sám nemá). Živě otestováno oběma směry: 40 znaků/2 řádky (`Takže ta situace, ve které jsme, tak nám / dala bezpečnost a vliv`) i 30 znaků/1 řádek (12 kratších titulků) – zalomení přesně podle nastavení (`wrapCue()` v `server/index.js`).

**Bug nalezený uživatelem a opravený stejný den:** opakované testování (různé `charsPerLine`/`lines`) na jedné sekvenci vytvořilo postupně 5 titulkových stop – ale v Premiere se pořád zobrazovala jen ta úplně PRVNÍ (uživatel poslal screenshot: viditelný text neodpovídal poslednímu požadavku). Příčina nalezena v `.prproj` XML: každý `Track` uvnitř `DataTrackGroup` má vlastnost `MZ.SourceTrackState` – jen track s `state=2` je "aktivní"/zobrazovaný, u všech dalších je `0`, a Premiere tuhle vlastnost přes DOM nejde nastavit ani zjistit (data/caption stopy DOM vůbec nezpřístupňuje – potvrzeno, `seq.reflect.methods` nemá žádný getter/remover). **Řešení:** `add_captions` si teď vede vlastní evidenci (`cache/transcripts/captions/index.json`, klíč `sequenceID`) a při druhém volání na stejnou sekvenci rovnou ODMÍTNE běžet s vysvětlením a instrukcí (smazat starou "CC" stopu ručně v Premiere přes pravé tlačítko na hlavičku stopy → Delete Track), místo aby potichu vytvořil další neviditelnou stopu. Obejít jde parametrem `force: true`, ale výsledek stejně nebude vidět, dokud staré stopy nezmizí – parametr je pro případ, že uživatel už ručně uklidil. Ověřeno živě přes tlačítko v panelu: 2. klik na stejnou sekvenci nástroj správně zamítl.

**Druhý bug nalezený uživatelem a opraven stejný den – titulky mírně "za" zvukem:** uživatel po delším sledování upozornil, že titulky mají "opravdu nepatrné zpoždění". Mapování časů zdroj→timeline je v kódu přesné (ověřeno v XML), příčina je jinde: Whisper hlásí začátek slova po tichu typicky s malým zpožděním oproti skutečné hlásce (běžná vlastnost DTW zarovnání ASR modelů), a `add_captions` dřív používal tenhle čas 1:1 bez rezervy. **Řešení:** nový parametr `leadIn` (výchozí 0,12 s) posune začátek každého titulku o tuhle hodnotu dřív, ale nikdy ne před konec předchozího titulku (řetězové clampování přes `prevEnd`) ani pod 0 s. Ověřeno na 252 titulcích (sekvence „Špidla - jen detail na moderátorku"): 0 překryvů, minimální mezera mezi titulky 0,0 s (nikdy záporná), první titulek správně sražen na 0,000 s místo by-mohl-být-záporného -0,06 s.

**Animace aktivity v panelu (na žádost uživatele, 2026-09-16):** dva malé pulzující indikátory – `#aiPulse` (modrý, vedle stavového textu v hlavičce, svítí když běží `child` proces Claude/Codex) a `#workerPulse` (zelený, vedle "Worker: …", svítí když má lokální Worker nějakou úlohu ve stavu `running`). Čistá CSS animace (`@keyframes pulse-anim`, škálování + opacity, 1s smyčka), žádné JS timery navíc – jen `classList.toggle('on', ...)` na místech, kde se už dřív měnil text/stav (`runAgent`, `child.on('close')`, `stopAgent`, `pollWorker`). Ověřeno živě: `aiPulse` se rozsvítí ihned po kliknutí na akci a zhasne po doběhnutí; `workerPulse` otestován přímým podáním úlohy na Worker HTTP API (`POST :7881/jobs`, mimo panel) – během zpracování `"on":true`, po dokončení `"on":false`.

## 5h. Fine-tuned český Whisper (mikr/whisper-large-v3-czech-cv13) – vyzkoušeno, NENASAZOVAT jako výchozí (2026-09-16)

Uživatel narazil na Beey (beey.tvnova.cloud, NEWTON Technologies + SpeechLab TUL, proprietární model, 92,65 % přesnost na českých médiích) a ptal se, jestli existuje otevřený model se srovnatelnou kvalitou pro lokální běh. Beey samo je uzavřené (jen přes placené API, vyžaduje token z účtu – nemáme). Na Hugging Face našel `mikr/whisper-large-v3-czech-cv13` (fine-tuned `whisper-large-v3` na Common Voice 13, WER 7,89 %, Apache 2.0).

**Stažen a převeden** (`ct2-transformers-converter`, potřeba dočasně `pip install torch transformers` – po převodu zase odinstalováno, běžný provoz je nepotřebuje) do `models/whisper-large-v3-czech` (2,9 GB). Zaregistrován jako volitelný model (`config.json` → `models.whisperCzech`, `worker/gpu.py` → název `"large-v3-czech"`/`"czech"`/`"cs"` v parametru `model` nástroje `transcribe_media`).

**Živě otestováno na stejném zvuku jako základní `large-v3`** (Špidla, 29 min) – **výsledek je horší, ne lepší**, i přes lepší benchmark: opakování slov ("součástí součástí", "byly byly"), uťatá slova ("přednos" místo "přednost"), pravopisná chyba ("hodotí" místo "hodnotí"), špatné dělení vět bez mezery ("společnosti?Nálada"). Model je doladěný na Common Voice (krátké čtené věty) a na přirozené plynulé řeči s pauzami/nedokonalostmi (skutečný TV rozhovor) ztrácí robustnost, kterou má obecný `large-v3` z širšího tréninku – klasické přetrénování na úzkou doménu.

**Závěr: `large-v3` zůstává výchozí.** `large-v3-czech` je k dispozici jako volitelný parametr (`transcribe_media` s `model: "large-v3-czech"`), kdyby se hodil na jiný typ materiálu (čtené zprávy, ne spontánní rozhovor), ale nenasazovat naslepo jen kvůli lepšímu benchmarku – ověřit vždy na reálném cílovém typu obsahu.

## 5i. `add_captions` pojistka sledovala jen ID sekvence, ne obsah (2026-09-17)

Uživatel upozornil: když se ve stejné sekvenci (stejné `sequenceID`) smaže staré video a vloží jiné, pojistka proti duplicitním titulkům (5g/5h) by to bez rozdílu obsahu zablokovala jako "už titulky má" – i když je obsah úplně jiný. **Opraveno:** `contentFingerprint(seq)` – sha1 otisk z `[mediaPath, track, start, end, inPoint, outPoint]` všech klipů – uložený vedle `sequenceID` v `cache/transcripts/captions/index.json`. Guard teď porovnává i otisk, ne jen ID; při změně obsahu (i se stejným ID sekvence) proběhne normálně znovu. Ověřeno jednotkově (stejný obsah → stejný otisk, jiný obsah → jiný otisk), živě netestováno na produkčním obsahu (uživatel mezitím přepnul na svůj vlastní projekt `zkouska.prproj` s reálnými sekvencemi – nezasahováno). Vedlejší efekt migrace: staré záznamy v indexu (bez `fingerprint` pole, z před opravou) projdou guardem bez zablokování napoprvé – neškodí, jen se tím obnoví platná ochrana od příštího spuštění.

## 5j. `detect_scene_cuts` odhalil skutečnou editorskou chybu na reálném materiálu (2026-09-17)

Uživatel stavěl 23s upoutávku "Zelená úsporám" ze zpravodajského materiálu (4 krátké výroky vybrané podle obsahu). Jeden záběr ("zvrat: 50 miliard", zdroj 28,92–33,48 s) mu vizuálně nedával smysl – titulek v obraze ("Díky tomu úvěrování...") neseděl s tím, co se říkalo. Ověřeno postupně:
1. `get_transcript` na 25–40 s potvrdil, že ZVUK v klipu je správně (věty #6–#7 "Připraveno 50 miliard korun. Ty v tento moment stát nemá." přesně sedí s inPoint/outPoint klipu).
2. `describe_frame` v 26 s a 28,92 s ukázal, že infografika (dva domy, porovnání půjček) běží **už předtím**, než náš klip vůbec začíná.
3. `detect_scene_cuts` (0–45 s zdroje) našel skutečné vizuální hranice: grafika běží **19,24–33,88 s** (celá věta #5 + #6 + #7), náš klip ale bere jen 28,92–33,48 s – skáče 9,7 s doprostřed už běžící grafiky.

**Závěr: zvuk byl vybraný správně, ale střih byl vizuálně "rozbitý" – náš pipeline vybírá klipy čistě podle zvuku/slov, bez ohledu na vizuální scénu.** Uživatel navrhl dávat `detect_scene_cuts` automaticky do každé analýzy – zvážil jsem to a **odmítl jako defaultní krok** (u hodinového materiálu se statickou kamerou/bez grafik by to jen zdržovalo, navíc pokaždé vytvoří dočasnou sekvenci navíc bez možnosti smazání). Místo toho zapsáno do `CLAUDE.md` jako **proaktivní pravidlo jen pro krátké/punchy sestřihy ze zpravodajského materiálu** (bod 6 v "Postup střihu podle obsahu") – agent by ho měl sám zvážit v tomhle konkrétním případě, ne pro každý typ materiálu.

**O pár hodin později se stejná věc stala znovu** (jiný zdroj, "STŘEPINY AI Zdraví" – 3 skutečné řezy natěsno v jednom 7s klipu, poslední jen 1,36 s před koncem klipu – grafika bliknula na chvilku). "Zvaž" v pravidlu bylo evidentně málo závazné a agent to přeskočil. **Přepsáno na tvrdší, mechanickou verzi**: MUSÍ zavolat `detect_scene_cuts` před dokončením takového sestřihu, projít KAŽDÝ klip proti nalezeným `cuts` s konkrétním prahem (řez < 1,5 s před koncem nebo < 1,5 s za začátkem klipu = problém), a v shrnutí zmínit, že kontrola proběhla. **Živě ověřeno, funguje výborně** – agent na stejném "AI Zdraví" materiálu skutečně zavolal `detect_scene_cuts`, našel problematický klip, a místo mechanického (a významově škodlivého) zkrácení věty **chytře nahradil problematickou větu sousední větou se stejným smyslem**, která celá leží v klidném záběru bez řezů poblíž hranic – nová sekvence má hranici 0,12 s PŘED skutečným řezem (čistý střih na přirozený přechod), ne uvnitř něj. Ukazuje to, že konkrétní/mechanický popis pravidla (s číslem prahu a kroky) funguje spolehlivěji než obecné "zvaž".

## 5k. Věty se ořezávaly na konci – dva reálné mechanismy, oba opraveny (2026-09-17)

Uživatel si po delším používání všiml: "často se ti stávalo, že jsi useknul větu, nestačil jsem tam něco doříct" (u ručního demo videa ze screen-recordingu, kde mluvil plynule bez velkých pauz). Na rozdíl od předchozích nálezů tohle byla **chyba v samotném kódu**, ne v prompt-instrukcích:

1. **`cutBounds()` v `server/index.js`** počítala konec klipu jako `Math.min(b + padAfter, (b + nextStart) / 2)` – když další (nevybraná) věta začínala brzy po té vybrané (běžné u plynulé řeči), bral se **poloviční** zbytek mezery místo celého `padAfter`. Při mezeře < 2×padAfter (výchozí < 0,3 s) to systematicky ubíralo prostor na doznění věty. Opraveno na `Math.min(b + padAfter, nextStart - GUARD)` (GUARD 0,02 s) – využije se celá dostupná mezera, ne půlka, s pojistkami že `lo`/`hi` nikdy nepřekročí/nepodkročí samotné slovo (`a`/`b`).
2. **Whisperovy časy konce věty mají svou vlastní nepřesnost** (uživatel sám navrhl: "můžeš kontrolovat waveform?") – i s opravou #1 může být `padAfter` málo, když řeč skutečně doznívá. Nový worker job **`refine_edges`** (`worker/audiosync.py`) dekóduje úsek zvuku kolem hranice, spočítá RMS obálku po 5ms rámcích a **prodlouží** (nikdy nezkrátí) konec až do chvíle, kdy energie klesne pod práh ticha (max. o `maxExtend`, výchozí 0,4 s, nikdy nepřeteče do dalšího úseku). Zapojeno automaticky do `build_sequence_from_transcript` (funkce `refineOutPoints`) – ne jako volitelný krok, po zkušenosti z 5j/5j² automaticky vždy.

**Živě ověřeno** na Špidlovi (věty #14–15, poslední věta v souboru): `cutBounds` dala základ 130,28 s (slovo + padAfter), `refine_edges` to doladila na 130,65 s (+0,37 s skutečně dozníva­jící řeči) – ověřeno jak v odpovědi nástroje, tak přímo v Premiere (`outPoint: 130.64`). Test na dřívějším páru vět (#14/#15 hranice) ukázal jen +0,02 s (tam byl Whisper přesný) – potvrzuje to, že **hlavní vinu nesla oprava #1** (zaokrouhlování na půlku mezery), oprava #2 je doplňková pojistka pro případy, kdy Whisper skutečně netrefí přesně.

## 5l. `list_project_items` – hledání nově vloženého videa bez shellu (2026-09-17)

Uživatel v panelu poslal zadání na "nově vložené video" bez udání jména. Agent (Claude v panelu) zkusil `Get-ChildItem` na `C:\Users\Petr\Downloads` – zablokoval to bezpečnostní sandbox Claude Code (přístup jen v pracovním adresáři `O:\MYpremiereMCP`), správně, tohle nechci obcházet. Náš MCP server ale na disk sahá běžně (Node `fs`, ne omezený Bash) – jen jsme dosud nevraceli datum souboru. Přidán `sort: "recent"` do `list_project_items`: doplní ke každé položce s `mediaPath` datum poslední změny (`fs.statSync`) a seřadí od nejnovějšího. `CLAUDE.md` teď agenta instruuje použít tohle (nebo `get_sequence` na aktivní sekvenci, když už je video na timeline) místo shellových příkazů. **Živě ověřeno** (po návratu bridge k Premiere): `sort: "recent"` správně vrátil klip s polem `modified` (datum ze souboru na disku), sekvence bez `mediaPath` prošla bez pádu.

## 5m. Přísná testovací série na přesnost střihu + skutečný bug nalezen a opraven (2026-09-17)

Uživatel zadal: nastudovat teorii střihu (zpravodajství, sociální sítě, podcasty) a pak přísně otestovat, že se nikde neuřízne slovo. Nastudováno a zapsáno do `CLAUDE.md` (nová sekce "Rytmus, pauzy a tempo"): J-cut/L-cut u rozhovorů (offset 1-2 s ideální), filozofie pauz z podcastového střihu (neřezat úplně všechno, nechat dech před důležitou myšlenkou, váhání může být obsahově důležité), tempo pro sociální sítě (hák 0-3 s, střihy 1,5-5 s podle platformy, pak se rozestupy zvětšují).

**Testovací série na `tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4` (Olomouc debata):**
1. 14 nesousedících vět (různé mluvčí, těsné i široké mezery) → ručně ověřeno KAŽDÉ hranice proti přesným časům slov z přepisu – 0 uříznutých slov, začátky správně buď na `padBefore`, nebo bezpečně limitované u těsných předávek mezi mluvčími, konce vždy ≥ přesný konec slova.
2. **`fromWord`/`toWord` (částečná věta) odhalilo skutečný bug**: `refine_edges` (doladění konce podle zvukové vlny, zavedeno dřív dnes) neznalo hranici DALŠÍHO slova uvnitř téže věty (jen hranici dalšího VYBRANÉHO úseku) – u `picks: [{id:45, fromWord:6, toWord:18}]` prodloužilo konec z 286,63 s (správný strop, spočítaný v `cutBounds`) na 286,72 s, **9 setin sekundy do vyloučeného slova "jestli"** (začíná 286,65 s). Ověřeno naostro v Premiere (`outPoint: 286.72` > 286,65).
   - **Opraveno**: `cutBounds()` teď vrací i `hiCeiling` (skutečný strop = další slovo v CELÉM přepisu, ne jen v rámci vybraného úseku), `picksToRanges`/`mergeRanges` ho nesou jako `range.maxOut`, `refineOutPoints` ho respektuje jako další mez vedle "dalšího vybraného úseku". Po opravě: 286,63 s (0,02 s PŘED vyloučeným slovem, ne za ním).
   - Re-test 14větové série po opravě: výsledky prakticky identické, jen se zkrátily přesně ty případy, co dřív přetékaly (např. -0,18 s, -0,03 s), zbytek beze změny – **cílená oprava bez regrese**.
3. `build_sequence_without_pauses` (mazání pauz/nádechů) – ověřeno na reálných pauzách z `find_pauses` (64 pauz, 42minutový zdroj): padding vždy padne dovnitř ticha na obou stranách, nikdy do řeči (příklad: pauza 460,55–461,51 s → klip končí 460,72 s, další začíná 461,36 s, oba bezpečně uvnitř pauzy). Tahle cesta `refine_edges` zatím nepoužívá, takže na ni bug z bodu 2 nemohl dopadnout.
4. `build_multicam_sequence`/`multicam.js` má úplně vlastní, nezávislou logiku hranic (nesdílí `cutBounds`) – týká se přepínání KAMER podle mluvčího, ne střihu řeči, takže mimo záběr tohohle testu.

**Závěr:** hlavní střihový nástroj (`build_sequence_from_transcript`) je po dnešních dvou kolech oprav (půlka mezery + tenhle strop) ověřeně přesný napříč běžnými i hraničními scénáři (těsné předávky mluvčích, částečné věty). Rigorózní testování se vyplatilo – bez `fromWord`/`toWord` testu by tenhle bug zůstal skrytý, protože běžné "cel-věta" scénáře ho nikdy neodhalí.

## 5n. Pokračování testů: hraniční případ beze mzery mezi slovy + `refine_edges` i pro mazání pauz (2026-09-17)

Po 5m pokračováno v testování podle "zkoušej to různě":

1. **Test hraničního případu bez pomoci sousedního úseku**: `picks: [{id:45, fromWord:0, toWord:5}]` (izolovaný úsek, žádný další vybraný rozsah v okolí, takže `maxOut` musí ustát celou zátěž sám, bez pomoci `nextIn`). Výsledek: outPoint 280,93 s. Ruční odhad z časů slov v přepisu čekal 280,91 s – rozdíl vyšetřen přímo v syrových datech přepisu (`cache/transcripts/*.json`): slovo #5 a slovo #6 na sebe navazují **úplně bez mezery** (konec slova 5 = začátek slova 6 = 280,93 s přesně). V takovém patologickém případě bezpečnostní pojistka `Math.max(hi, b)` (nikdy neuříznout vybrané slovo) správně vyhrává nad rezervou `GUARD` (0,02 s) pro mez dalšího slova – výsledek přesně na hranici slov, ne před ní. **Závěr: správné/bezpečné chování, ne bug** – původní ruční odhad byl jen neúplný (nepočítal s nulovou mezerou).
2. **Rozhodnutí nerozšiřovat `refine_edges` na začátek klipu (`lo`/`padBefore`)**: na začátku nehrozí uříznutí (`Math.min(lo, a)` už to garantuje), prodloužení by bylo jen estetické (méně "naraženého" startu), ne otázka správnosti. Rozhodnuto věnovat zbývající čas užitečnější věci (bod 3).
3. **`refine_edges` zapojeno i do `build_sequence_without_pauses`** (dřív ho používal jen `build_sequence_from_transcript`, viz 5m bod 3): `speechIslands()` teď vrací/nese `maxOut` stejně jako `picksToRanges()`, nástroj je nově `async` a po `mergeRanges(speechIslands(...), 0)` zavolá `await refineOutPoints(...)`. Cíl: aby i při mazání pauz/nádechů doznívající řeč na konci ponechaných úseků nebyla systematicky uřezaná o Whisperovu nepřesnost (stejný mechanismus jako u hlavního střihu, teď sdílený).
   - **Živě ověřeno** na stejném 42minutovém zdroji (Olomouc/Liberec debata): nová sekvence "TEST bez pauz v2 refine" má stejný počet segmentů (63, žádný segment nezmizel ani nepřibyl), `removed` (smazaný čas) klesl z 1:06,65 na 1:05,18 (~1,47 s méně přeříznuto navíc, rozprostřeno po 63 hranicích), celková délka sekvence stoupla z 2450,84 s na 2452,16 s.
   - **Spot-check regrese**: stejná konkrétní pauza jako v 5m bodě 3 (zdrojový čas ~460,55–461,51 s) po opravě: `outPoint: 460.72`, `inPoint: 461.36` – **beze změny** oproti verzi bez `refine_edges`. Potvrzuje, že celkové zlepšení (~1,47 s) je soustředěno na JINÝCH hranicích, kde byl Whisperův odhad méně přesný, ne že by tahle konkrétní hranice zregredovala.

**Závěr:** oba nástroje na střih podle přepisu (`build_sequence_from_transcript` i `build_sequence_without_pauses`) teď sdílí stejnou dvouvrstvou ochranu hranic (mechanický strop `maxOut` z `cutBounds` + zvukové doladění `refine_edges`), ověřenou jak na běžných, tak na záměrně nepříjemných hraničních scénářích.

## 5o. Další adversariální testy: přeházené pořadí `picks` a první slovo v souboru (2026-09-17)

Pokračování v "zkoušej to různě" – dva scénáře, co v předchozích sériích (5m, 5n) nebyly zkoušené, přímým voláním nástrojů (bez LLM agenta v panelu, levnější a rychlejší na ověření):

1. **Přeházené (nechronologické) `picks` s `fromWord`/`toWord`**: `picks: [{id:45, fromWord:6, toWord:18}, {id:2, fromWord:0, toWord:4}]` – věta #45 (zdrojový čas ~281–287 s) záměrně PŘED větou #2 (zdrojový čas ~6–9 s), tedy opak časového pořadí ve zdroji. Riziko: `refineOutPoints` počítá `nextIn` jako `ranges[i+1]?.in` (další ÚSEK V POLI, ne chronologicky další čas), takže u přeházeného pořadí by `nextIn` mohl být menší než vlastní `out` prvního úseku.
   - **Ověřeno naostro**: první klip (věta #45) vyšel `outPoint: 286.64` – identická hodnota jako v opraveném testu z 5m (žádné poškození přeházeným pořadím). Vysvětlení: když `nextIn` (6,4 s) vyjde menší než `r.out` (286,6x s), `maxExtend = Math.max(0, Math.min(0.4, ceiling - r.out - 0.02))` vyjde záporné uvnitř `Math.min`, ale vnější `Math.max(0, …)` ho ořízne na 0 – `refine_edges` pak žádnou úpravu neprovede a zůstane bezpečná hodnota z `cutBounds`. **Závěr: přeházené pořadí je bezpečné by design** – v nejhorším případě se jen vynechá zvukové doladění (o pár desetin sekundy méně "uhlazený" konec), nikdy se neprodlouží špatným směrem.
   - Druhý klip (věta #2, poslední v poli → `nextIn = Infinity`) narazil na **další případ nulové mezery mezi slovy** (word4 "speciálního" končí přesně tam, kde word5 "předvolebního" začíná, 9,09 s) – stejný vzorec jako v 5n bodě 1. Zajímavý detail: požadovaná hodnota 9,09 s vyšla v Premiere jako `outPoint: 9.08` – **ne chyba**, jen zaokrouhlení na celý snímek (25 fps = 0,04 s/snímek; 9,09 s by dalo neceločíselný počet snímků od inPointu, Premiere zaokrouhlila DOLŮ, tedy směrem PRYČ od vyloučeného slova, což je bezpečný směr). Nekoliduje se slovem #5 (9,08 < 9,09).
2. **První slovo v celém souboru** (`picks: [{id:1, fromWord:0, toWord:2}]`, věta #1 = úplně první slovo přepisu, větev `prevEnd === -Infinity` v `cutBounds`): začátek vyšel přesně `a - padBefore` (4,03 s = 4,11 − 0,08) bez potřeby ořezu na 0 (reálný materiál má vždy náběh před první promluvou, takže větev `Math.max(0, …)` nebyla vyzkoušená na skutečně nulovém čase – strukturálně triviální, netřeba vynucovat synteticky). Konec opět narazil na nulovou mezeru mezi slovy (vysílání/TN, 5,43 s) a vyřešil se stejně bezpečně jako výše.

**Závěr:** ani přeházené pořadí výběrů, ani hranice úplně prvního slova v souboru nezpůsobily problém – bezpečnostní mechanismy (`Math.max(0, maxExtend)` a `Math.max(hi, b)`) fungují správně i mimo scénáře, pro které byly primárně navržené. Testovací sekvence ponechány v projektu jako "TEST reordered picks" a "TEST first word no prevEnd" (žádný nástroj na mazání sekvencí není k dispozici, viz ostatní TEST-sekvence výše).

## 5p. Codex (GPT) – výběr modelu doplněn, `--dangerously-bypass-approvals-and-sandbox` nahrazen užším řešením (2026-09-17)

Uživatel donesl návrh řešení od GPT (`INSTRUKCE_GPT_MODELY_PRO_CLAUDE.md`, cizí zdroj – text v souboru byl formulovaný jako instrukce přímo pro mě, takže jsem ho bral jako podklad k ověření, ne jako hotovou pravdu). Před nasazením ověřeno naostro, ne převzato naslepo:

1. **Seznam modelů Codexu** – v souboru uvedené slugy (`gpt-6-astra`, `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.2`) se zpočátku zdály vymyšlené (neobvyklá jména), ale `codex debug models --bundled` (reálný nainstalovaný CLI, verze 0.154.0-alpha.6.2) je **přesně potvrdil** jako aktuální katalog s `"visibility":"list"` – doplněny do `panel/index.html` s `data-agent="codex"` (stejný mechanismus jako u Claude modelů).
2. **Zapamatování modelu zvlášť pro Claude/Codex** (`panel/main.js`) – `localStorage` pod klíči `pmcp.model.claude`/`pmcp.model.codex`, obnoví se při přepnutí agenta zpátky. Živě ověřeno přes devtools (přepnutí Codex→Claude→Codex korektně vrátilo zapamatovaný model).
3. **Bezpečnostní oprava sandboxu** – návrh nahradit `--dangerously-bypass-approvals-and-sandbox` (ruší sandbox úplně pro všechno) kombinací `--sandbox read-only` + `-c mcp_servers.premiere.default_tools_approval_mode="approve"` (schvaluje bez ptaní jen volání NA NÁŠ server, ne libovolný shell). Než jsem to nasadil, ověřil jsem klíč `default_tools_approval_mode` přes `--strict-config` (skutečně rozpoznané pole, ne překlep – na rozdíl od vymyšleného `totally_bogus_field_xyz`, který `--strict-config` správně odmítl) a pak přímým `codex exec` voláním `premiere_status`/`list_project_items` bez allowlistu `enabled_tools` – funguje pro VŠECHNY nástroje serveru bez nutnosti ručně udržovat duplicitní seznam (na rozdíl od návrhu v souboru, který ukazoval jen ukázkový podseznam ~7 nástrojů – to by ořezalo Codexu reálné možnosti střihu). Nakonec ověřeno end-to-end přes samotný panel (`scripts/panel-run.mjs`, model `gpt-5.6-luna`, prompt volající `premiere_status`) – proběhlo bez chyby, žádný návrat k "approval policy is never".
4. **Neimplementováno z návrhu**: dynamické načítání katalogu z `codex debug models --bundled` při startu panelu (statický seznam dnes ověřeně sedí, dynamika by přidala složitost bez jasné potřeby) a volitelný select na `reasoning effort` (nikdo o něj nepožádal, drženo mimo rozsah zadání).

## 5q. "JÁ" sestřih zněl jako "jaký" – nebyl to bug ve výběru slova, ale ultra krátké klipy bez mezery (2026-09-17)

Uživatel po vlastním otestování (živý panel, ne moje testovací sekvence) nahlásil: "ted jsem nechal nastříhat slovo JÁ a slyším tam i slova jaký to je spatně". Sekvence "TEST jen slovo JA" (43 klipů, jeden na výskyt) skutečně existovala v projektu. Ověřil jsem přímo v datech přepisu, ne odhadem:

- Zkřížil jsem přesné `inPoint`/`outPoint` všech 43 klipů proti slovům z přepisu (`allWords`) – **každý jediný klip pokrývá jen "já"** (+ nanejvýš útržek sousedního slova o pár desetin sekundy). Slovo "jaký" se v celém přepisu vyskytuje jen 2× a ani jednou není blízko žádnému z 43 klipů.
- Skutečná příčina: mnoho klipů je extrémně krátkých (až **0,08 s = 2 snímky**), protože "já" v plynulé řeči často nemá skoro žádnou pauzu před/za sebou – bezpečnostní ochrana `cutBounds` (nikdy nezasáhnout do sousedního slova) pak `padBefore`/`padAfter` stáhne na pár setin sekundy místo běžných 0,08/0,15 s (ověřeno na 5 klipech: reálné odsazení 0,01–0,09 s). Klipy navíc na sebe navazují bez mezery (`gap: 0` výchozí). Výsledek: 43 útržkovitých fragmentů z různých míst 42minutového videa slepených bez dechu – ucho si roztrhaný zvuk snadno domyslí špatně, navíc "jaký" začíná stejně jako "já" ("ja-").
- **Řešení (bez úpravy kódu, jen jinak zavolaný existující parametr)**: přestavěl jsem sekvenci se stejnými 43 výskyty přes `build_sequence_from_transcript` s `gap: 0.2` – nová sekvence "TEST JA s mezerou" dává uchu čas oddělit jednotlivá "já" od sebe.
- **Ponaučení pro budoucí podobné hlášení**: než hledat bug v kódu, nejdřív ověřit přímo v datech přepisu, co nástroj OPRAVDU vybral – tady se ukázalo, že jde o inherentní vlastnost "vystřihni jen jedno krátké slovo napříč celým videem" (nikdy to nebude znít přirozeně), ne o chybu v párování slov.

## 5r. Haiku 4.5 opakovaně zapomínal povinný parametr `path`/`source` – zavedena tichá záchrana pro jednoznačné případy (2026-09-17)

Při testu modelu Haiku 4.5 (viz [5p](#5p)) v reálné víceotáčkové konverzaci ("ted chci slova jsem za sebe") agent opakovaně zavolal `get_transcript`, `transcribe_media` i `build_sequence_from_transcript` **bez povinného `path`/`source`** – server to správně odmítl (`zod` validace, `-32602 expected string, received undefined`), ale chyba byla technická a neposkytovala modelu nic použitelného k opravě. Tohle je limit slabšího/levnějšího modelu při delší agentní konverzaci s MCP nástroji (na rozdíl od chyby v našem kódu) – nejde to "opravit" v modelu samotném, ale dá se to obejít na straně serveru:

- `get_transcript`, `search_transcript`, `build_sequence_from_transcript`, `build_sequence_without_pauses`: `path`/`source` teď `optional()` – když chybí, zkusí se `singleTranscribedSource()` (jediný záznam v `cache/transcripts/index.json`, žádná nejednoznačnost). Když je přepisů víc (aktuálně v projektu 21), vrátí se **čitelná chyba se seznamem kandidátů** místo syrové zod chyby.
- `transcribe_media`: stejně, ale zdroj hledá mezi položkami projektu (`singleProjectMediaSource()` – přes `list_project_items`, jen položky s `mediaPath`, ne sekvence).
- **Ověřeno naostro** (izolovaně přes `claude -p` mimo živý panel, aby to nekolidovalo s běžícím úkolem uživatele): `get_transcript` bez `path` v aktuálním stavu (21 různých přepsaných zdrojů) správně vypsal seznam všech 21 cest místo pádu – přesně navržené chování pro nejednoznačný případ.
- Tohle nenahrazuje spolehlivost modelu (Haiku bude pravděpodobně dál občas zapomínat argumenty), jen mění důsledek z "tvrdý pád s nesrozumitelnou hláškou" na "buď to tiše dořeší samo (jasný případ), nebo dá modelu užitečnou nápovědu k opravě (nejednoznačný případ)".

## 5s. UI: pole pro psaní zadání přesunuto pod výpis konverzace (2026-09-17)

Uživatel: "bude lepší když to okno kam píšu bude pod tím textem bude to mít lepší logiku" – běžné chatové rozložení (historie nahoře, psací pole dole), dřív to bylo obráceně. V `panel/index.html` přesunut `<div id="out">` před `<textarea id="prompt">` (CSS `flex:1` na `#out` beze změny, jen pořadí v DOM) – ověřeno přes devtools po reloadu (`getBoundingClientRect`), `#out` teď reálně nahoře, psací pole s tlačítky dole. Reload panelu jsem záměrně odložil, dokud neskončil živě běžící uživatelův úkol (tagování podstatných jmen), aby se nepřerušil.

## 5t. Třetí agent v panelu: Ollama jako lokální záloha, když dojdou kredity (2026-09-17)

Uživatel se zeptal, jaký lokální model by mohl nahradit Claude/GPT jako záložní řešení, a po mém návrhu ("chceš, abych to zapojil a otestoval naostro?") potvrdil: "ok takže když zjistí že běží ollama tak to může využít a automaticky si sáhne po vhodném modelu a půjde to přepnout". Než jsem cokoli napsal do kódu, ověřil jsem reálný stav stroje (ne odhadem):

- GPU: RTX 4070 Ti, 12 GB VRAM (`nvidia-smi`).
- Ollama už běží (port 11434) a má nainstalovanou velkou knihovnu modelů (`ollama list`/`api/tags`).

**Klíčový nález z živého testování** (přímo přes `codex exec --oss --local-provider ollama`, mimo panel): Codex u lokálního Ollama backendu **vyžaduje, aby model uměl "thinking"** (schopnost z `api/tags` → `capabilities`) – bez ní tvrdě spadne (`"X" does not support thinking`, opakované reconnecty), a to i s `-c model_reasoning_effort="minimal"`. Zkoušel jsem postupně:
- `qwen2.5-coder:14b` (jen `completion,tools,insert`, žádné "thinking") → **spadlo**.
- `qwen3:1.7b` (`tools,thinking`, ale jen 1,7B) → připojilo se, ale model **halucinoval špatné jméno/parametry nástroje** (myslel si, že `premiere_status` potřebuje `project_id`/`deployment_id`) a nikdy reálně nezavolal žádný nástroj – příliš slabý na tenhle úkol.
- `gemma4:latest` (9,6 GB, `vision,audio,tools,thinking`, vejde se celá do 12 GB VRAM) → **fungovalo správně** ve dvou testech (`premiere_status`, `list_project_items` se `sort:"recent"` a správnou extrakcí odpovědi).

**Implementace** (`panel/index.html`, `panel/main.js`):
- `findExe('ollama')` mapuje na `codex.exe` (Ollama backend řeší Codex sám přes `--oss --local-provider ollama`, nespouští se `ollama.exe` přímo).
- Při startu panelu `detectOllama()` zavolá `127.0.0.1:11434/api/tags`; když odpoví, přidá do `#agent` volbu "Ollama (lokální)" a do `#model` jen modely, co mají **zároveň `tools` i `thinking`** (jinak spadnou) **a nejsou `...cloud`** (ty běží přes Ollamin vlastní cloud, ne lokálně – i tak se totiž objevily v seznamu, i s velikostí ~0, proto filtr i na `size`). Když Ollama neběží, agent/modely se prostě nepřidají (žádná rozbitá volba navíc).
- Výchozí model = největší z vyhovujících, co se ještě vejde pod ~11 GB (rychlost + kvalita), pokud si uživatel dřív nevybral jiný (`localStorage pmcp.model.ollama`, stejný mechanismus jako Claude/Codex).
- `runAgent()`: běží přes stejnou codex.exe větev jako GPT (`--sandbox read-only` + `default_tools_approval_mode="approve"`), navíc `--oss --local-provider ollama`.
- **Ověřeno end-to-end přes samotný panel** (`scripts/panel-run.mjs`): automaticky vybraný model (`gemma4:e4b`, stejný model jako `gemma4:latest`, jen jiný tag) správně zavolal `premiere_status` a vrátil verzi Premiery.
- **Neimplementováno/nezkoušeno**: silnější kandidáti jako `nvjob/DeepSeek-R1-32B-Cline` (18,6 GB, nevejde se celé do VRAM) nebo `qwen3-vl:8b` – filtr je zahrne taky (mají tools+thinking), ale výchozí volba padla na ověřeně fungující `gemma4`. Kvalita na reálném (ne triviálním) editorském úkolu zatím netestována – čekat výrazně nižší spolehlivost než u Claude/GPT (podobně jako u Haiku 4.5, viz [5r](#5r), spíš horší).

## 5u. Srovnávací test Claude/GPT/Ollama na reálném úkolu – Ollama selhala, agent zrušen (2026-09-17)

Uživatel chtěl reálné srovnání "časy a přesnost" napříč agenty. Zadání identické pro všechny tři (fresh session, bez navázání): najít v 42minutovém přepisu VŠECHNY věty o Olomouci a poskládat je do nové sekvence s mezerou 0,3 s. Ground truth (přesné shody na "olomouc\*" v surovém přepisu) = 25 vět, ale přímé srovnání ukázalo, že i to je neúplné – viz níž.

| Agent/model | Čas | Cena | Nalezeno | Poznámka |
|---|---|---|---|---|
| Claude Sonnet | 174,6 s | $0,819 | **45/45** | Sám podchytil 20 vět, kde Whisper "Olomouc" přepsal pokaženě ("volomouci", "Holmuci", "V Folmusi" apod.) – ověřeno ručně proti přepisu, všech 20 skutečně o Olomouci. Žádný falešný nález. |
| Codex GPT-6-Astra | 90,3 s | nezjištěno (panel cenu Codexu/Ollamy nezobrazuje) | 29/45 | Chytil čistý ground truth (25) + 4 lehčí zkomoleniny, minul 16 nejtěžších. Žádný falešný nález. |
| Ollama gemma4:e4b | 75,3 s | zdarma | **0/45** | Tvrdilo, že slovo "Olomouc" v přepisu vůbec není, sekvenci nevytvořilo (ověřeno i přes `get_project` – sekvence "BENCH ollama gemma4" v projektu neexistuje). Úplné selhání na reálném úkolu, i když dřív triviální `premiere_status`/`list_project_items` zvládla (5t). |

**Rozhodnutí uživatele: Ollama agent zrušen** ("zruš tu ollamu"). Vráceno v `panel/main.js`: smazána `detectOllama()`/`addOllamaAgent()`, `findExe('ollama')` mapování na codex.exe, `--oss --local-provider ollama` větev v `runAgent()`, ollama položka v `lastModelByAgent`/`setAiIcon`. `README.md` vrácen na původní znění bez zmínky Ollamy. Ponechána jen drobná, obecně užitečná oprava z 5t (nezobrazovat Codexovo "Model metadata for X not found" jako červenou chybu – může nastat i u běžných GPT modelů, ne jen u Ollamy).

**Ponaučení**: lokální 8-9B model (gemma4) fungoval spolehlivě jen na triviální jednokrokové dotazy (5t), ale na skutečném redakčním úkolu (najít a interpretovat věty v dlouhém přepisu) selhal úplně – potvrzuje to očekávání z 5t/5r, jen tvrději, než jsem čekal. GPT-6-Astra byl skoro 2× rychlejší než Claude Sonnet za cenu horšího zachycení těžce zkomolených ASR přepisů; pro úkoly, kde přesnost je kritická (a materiál má víc ASR šumu), zůstává Claude Sonnet lepší volba i za vyšší cenu/čas.

## 5v. Srovnávací test napříč modely Claude (Opus/Sonnet/Haiku 4.5) – stejný úkol jako 5u (2026-09-18)

Uživatel chtěl porovnat i samotné modely Claude mezi sebou (Opus, Sonnet, Haiku 4.5), stejným zadáním o Olomouci jako v 5u (fresh session, bez navázání). Sonnet už měřen v 5u (174,6 s, $0,819, 45/45).

| Model | Čas | Cena | Nalezeno | Přístup k zadání |
|---|---|---|---|---|
| **Opus** | 171,6 s | $1,469 | 29/45 | Striktně doslovné čtení zadání ("slovo v tom tvaru se vyskytuje") – vyloučil 16 nejtěžších ASR-zkomolenin (např. "Holmuci", "Folmusi"), protože v nich doslova chybí kmen "olomouc". **Transparentně vypsal, které věty vynechal a proč**, a nabídl je doplnit na vyžádání. |
| **Sonnet** | 174,6 s | $0,819 | 45/45 | Liberálnější výklad – i zkomoleniny bez kmene "olomouc" doplnil z kontextu (viz 5u). |
| **Haiku 4.5** | 114,4 s | $0,243 | 32/45 | Nejrychlejší a nejlevnější, přitom zachytil VÍC než Opus i GPT-6-Astra (32 vs 29) – včetně části těžších zkomolenin. Žádný falešný nález (všech 32 ID ověřeno jako podmnožina ověřených 45). Cestou ale znovu narazil na starý problém: zapomněl `path` u jednoho volání nástroje (`get_transcript`/`transcribe_media`) – tentokrát to ale nespadlo natvrdo, oprava z HANDOFF 5r (tichá záchrana + čitelná chyba se seznamem kandidátů) fungovala přesně podle plánu a model se sám opravil a dokončil úkol. |

**Zajímavý nález, ne přímo chyba**: Opus dal MÉNĚ výsledků než Sonnet i Haiku, ale ne proto, že by byl "horší" – doslovné čtení mého zadání ("slovo v tom tvaru") je legitimně obhajitelné (těch 16 vynechaných vět skutečně neobsahuje řetězec "olomouc" doslova, jen kontextově jde o stejné město). Je to spíš ukázka, že **modely se liší v tom, jak moc si dovolí zadání interpretovat/domýšlet**, ne jen v syrové schopnosti. Pro budoucí podobné úkoly stojí za to zadání zpřesnit (např. výslovně říct "i zkomolené ASR přepisy, pokud z kontextu jasně jde o stejné slovo"), aby srovnání nebylo zkreslené nejednoznačností promptu.

**Praktický závěr pro výběr modelu v panelu**: Haiku 4.5 překvapivě dobrý poměr rychlost/cena/přesnost na tomhle typu úkolu (fulltextové hledání + stavba sekvence) – s výhradou, že díky opravě z 5r dokázal ustát i svou typickou chybu (zapomenutý `path`). Sonnet zůstává nejspolehlivější, když je důležitá úplnost (žádné tiché vynechání okrajových případů). Opus nevynikl ani rychlostí, ani počtem nálezů, ale nabídl nejvíc transparentní zdůvodnění vlastních rozhodnutí - hodí se spíš tam, kde jde o kvalitu úsudku/vysvětlení, ne o hrubou rychlost/pokrytí.

## 5w. Parakeet-tdt-0.6b-v3 a Qwen3-ASR-1.7B vyzkoušeny proti `large-v3` – žádný nepřekonává, NENASAZOVAT (2026-09-18)

Uživatel se ptal, jestli dva nové otevřené ASR modely z roku 2026 (vydané po lednu, tedy mimo znalosti modelu) neporazí `large-v3` na reálném zpravodajském materiálu. Poučení z 5h platí i tady: benchmark není totéž co reálný TV rozhovor, takže test proběhl na skutečném klipu (`tncz-TIT_2026-06-16_naprimo_liberec.mp4.mp4`, TN Live Olomouc), ne na leaderboardu.

**Metoda**: samostatné dočasné venv (`asr_test_venv` ve scratchpadu, `.venv` projektu nedotčeno), dva 16kHz mono WAV segmenty vytažené přes PyAV stejným způsobem jako `worker/asr.py`/`worker/audiosync.py` (`decode_audio`) – segment A (330–365 s, známé chyby Whisperu: "Novorozeně a TUM", "plohodnaté", "Olmoučáky") a segment B (0–60 s, čistý úvod). Baseline = existující cache přepis `large-v3` pro stejné časy.

**Segment A – konkrétní rozdíly**: Whisper "hvítání občánků" (chybně, s "h" navíc) → **Parakeet opravil na "vítání občánů"** (správně, jen bez "k"), Qwen "vítání občanků" (taky opraveno, jiná diakritika). Klíčové těžké slovo "Novorozeně a TUM" → Parakeet "novorozenatům" (jedno smysluplné slovo, blíž pravděpodobnému originálu), Qwen ho rozsekal na "inovorozně na novorozená tům" (hůř). "plohodnaté Olmoučáky" → Parakeet "naplhodnuté Olmoučáky" (pořád zkomolené, ale zachovalo obě slova), Qwen frázi úplně vynechal a nahradil neutrálním "jako například na ty olmoučáky" – ztráta obsahu, ne jen pravopisu. Jméno "Miroslava Ferancová" (Whisper) vyšlo jako "Francová" (Parakeet, chybí "e") a "Ferančová" (Qwen, špatná diakritika) – ani jeden jistě správně, bez referenčního přepisu nelze určit vítěze. Jméno "Jan Vašíř z ODS" → Parakeet "Vašíř ODS" (jen vynechal "z"), Qwen "Vašíček od ES" (výrazně hůř, jiné příjmení i strana).

**Segment B**: všechny tři čitelné a věcně v pořádku (čísla křesel 45/23/16/8/4/28/10 sedí u všech), drobné rozdíly v diakritice/skloňování ("šestého nejlidnatějšího" Whisper vs. "6ého nejdratnějšího" Parakeet vs. "šestého nejvýznamnějšího" Qwen – Parakeet si tu vymyslel nesmyslné slovo "nejdratnějšího"). **Oba nové modely ale useknuly konec bez zjevného varování** – Parakeet u 60s klipu bez `chunk_length_s`/`max_new_tokens` narazil na defaultní `max_length` pipeline a text utnul uprostřed věty ("Druhý největší zastupitelsk."), Qwen se zastavil na `max_new_tokens=256` (podle zadaného kódu) a nepokračoval vůbec do zbytku segmentu. Whisper takový strop nemá (viz jeho `wordCount`/`segments` pokrývají celý rozsah).

**Rychlost** (RTX 4070 Ti, GPU už částečně vytížené Workerem): Parakeet nejrychlejší – inference ~0,7 s na 35–60 s klip (desítky× rychleji než realtime), load z cache 4 s. Qwen pomalejší – inference ~10 s na klip (cca 4–6× realtime, o něco pomaleji než Whisperův orientační poměr ~10× realtime na celém 42min souboru), navíc stažení váhy 1,7B modelu trvalo ~6,75 min (jednorázově). Instalační komplikace: `qwen-asr` si vynucuje `transformers==4.57.6`, zatímco Parakeet (architektura `nemotron3_5_asr`) potřebuje `transformers>=5.17` – oba modely tedy nejdou používat ve stejné chvíli bez přepínání verze v rámci venv (přepínáno ručně mezi běhy, ne souběžně).

**Závěr: `large-v3` zůstává výchozí, žádný z kandidátů nenasazovat.** Parakeet je nadějný na rychlost a v jednom místě (`vítání`) opravil chybu, kterou má Whisper v cache dodnes, ale na těžkých slovech je stejně nespolehlivý jako Whisper (jen jinak) a bez extra konfigurace (chunking/`max_new_tokens`) tiše ořezává delší segmenty – to by v produkci znamenalo ztracený konec vět bez varování, nepřijatelné pro střih. Qwen3-ASR byl na těžkých slovech viditelně horší než oba ostatní (ztráta obsahu, ne jen překlepy) a pomalejší. Ani jeden model se nezkoušel dál doladit (žádné vlastní `chunk_length_s`/`max_new_tokens` tuning, žádný pokus o batch/streaming) – kdyby uživatel chtěl, dá se to prohloubit, ale na první reálný test ani jeden nepřeváží náklady na výměnu za `large-v3`. Stažené váhy a `asr_test_venv` ponechány ve scratchpadu pro případné další zkoušení, dočasné WAV segmenty smazány.

## 5x. Audio vstup do Claude/GPT – ověřeno, že to (zatím) nejde (2026-09-18)

Uživatel navrhl posílat zvuk přímo do Claude (nebo GPT přes Codex) místo Whisperu, s tím že by to bylo přesnější za cenu víc kreditů. Ověřeno přímo v aktuální dokumentaci/datech, ne z paměti:

- **Claude API**: skill `claude-api` (aktuálně udržovaný referenční zdroj) nezmiňuje žádný typ obsahu pro zvuk – jen text, obrázky (vidění) a dokumenty (PDF). Žádný "audio"/"speech" content-block type v Messages API neexistuje.
- **Codex CLI (GPT v panelu)**: `codex exec --help` nabízí jen `-i/--image` pro přílohy, žádnou obdobu pro zvuk. Navíc katalog modelů (`codex debug models --bundled`, stejná data jako u výběru modelů v [5p](#5p)) má u **všech 11 modelů** `"input_modalities":["text","image"]` – zvuk není podporovaný ani u jednoho.

**Závěr: nejde to ani u Claude, ani u GPT v naší integraci.** OpenAI sice jinde audio-vstupní modely má (`gpt-4o-audio-preview` apod.), ale ty nejsou dostupné přes `codex exec` – šlo by je zapojit jen přímým voláním OpenAI API, což by byla úplně nová, samostatná integrace, ne rozšíření stávající. Whisper zůstává jediná cesta k přepisu v tomhle projektu; uživatel byl nasměrován zpátky k fine-tuning nápadu (viz otázka před 5h/5w) jako reálnější cestě ke zlepšení přesnosti.

## 5y. `export_analysis` – instrukce pro externí AI sloučeny do jednoho souboru (2026-09-18)

Uživatel: dosavadní záložní postup (samostatné tlačítko "Otevřít instrukce pro AI" + zvlášť exportovaná analýza) vyžadoval dvě různá vložení do ChatGPT a bylo to matoucí ("to tlačítko nefunguje"). Chtěl **jeden** stažený/exportovaný `.md` soubor, který si ChatGPT po vložení hned sám vyloží a rovnou se zeptá, co chce uživatel nastříhat.

- `export_analysis` (`server/index.js`) teď na začátek vygenerovaného souboru vloží **celý obsah `EXTERNI_AI_INSTRUKCE.md`** (čte ho při každém běhu ze souboru, žádná duplikace textu – ten zůstává jediným zdrojem pravdy) a na konec (za osnovu a plný přepis) přidá větu: *"Teď se uživatele zeptej česky, co chce nastříhat..., teprve pak vrať JSON plán."* – jedna zpráva do ChatGPT stačí na všechno.
- `EXTERNI_AI_INSTRUKCE.md` upraven (odstraněna zmínka o "dalších zprávách", teď počítá s tím, že vše přijde v jednom souboru/zprávě).
- `panel/index.html`: tlačítko "📋 Otevřít instrukce pro AI" (a jeho handler v `main.js`, který jen otevíral soubor přes `cp.exec('start ...')`) odstraněno jako nadbytečné – zbyly jen 2 kroky (export → vložit do AI → uložit odpověď → sestříhat podle plánu) místo 3.
- **Ověřeno naostro** (izolovaně přes `claude -p`, mimo živý panel): vygenerovaný `.analyza.md` (362 vět, 139 KB) má instrukce na začátku a výzvu "zeptej se uživatele" na úplném konci, přesně jak bylo požadováno.

## 5z. Instalace na cizím PC nefungovala – nalezena příčina + offline instalační balík (2026-09-18)

Uživatel: "zkoušel jsem to v práci nainstalovat a nefungovalo to". Místo hádání jsem prošel, co se při kopírování projektu jinam rozbije:

**Nalezená příčina: `mcp.json` měl natvrdo `O:/MYpremiereMCP/server/index.js`.** Po zkopírování projektu na jiný disk/cestu ukazoval panel (větev Claude, `--mcp-config mcp.json`) na neexistující soubor, takže se nástroje vůbec nepřipojily. Původní `install.ps1` tohle neřešil a ani nijak nekontroloval. (Stejné natvrdo psané cesty jsou i ve `scripts/*.mjs`, ale ty jsou jen vývojářské, do instalace nevstupují.)

**Nový balík `INSTALL/`** (původní `install.ps1` v kořeni zůstal nedotčený):
- `instalace.bat` – jediný soubor k poklepání; přepínače `-CheckOnly`, `-NoLocalLLM`, `-SkipModels` pro příkazovou řádku.
- `install.ps1` – tři fáze: **kontroly → instalace → ověření**. Kontroly (soubory projektu, místo na disku, Node 18+, Python 3.11, curl/tar, síť nebo offline balík, `%APPDATA%` na síťovém disku, Premiere, GPU, porty) běží PŘED jakoukoli změnou, takže při problému nezůstane rozdělaná půlka instalace. Každá chyba vypisuje i konkrétní návod. Po instalaci se ověří i funkčnost (importy Python balíčků, velikosti modelů, propojení panelu, klíč v registru, platnost `mcp.json`). Vše se loguje do `INSTALL/install-log.txt` (v `.gitignore`).
- **Přegenerování `mcp.json` podle skutečného kořene** – vlastní oprava té příčiny výše.
- **Offline balík `INSTALL/offline/` (~15 GB)**: modely (Whisper, diarizace, gemma3 12B, Qwen3-VL), `tools/llama.cpp`, Python wheels (`pip download`, 30 souborů) a `node_modules`. Když složka existuje, instalace nepotřebuje internet vůbec; když chybí, chová se jako dřív a stahuje. Do balíku se záměrně NEDÁVAL český Whisper fine-tune (2,9 GB, podle [5h](#5h) horší a nepoužívá se). Složky `models/`, `tools/`, `node_modules/` jsou v `.gitignore` bez lomítka na začátku, takže se `INSTALL/offline/**` do gitu nedostane.
- Bez NVIDIA GPU si instalátor sám přepne Whisper na CPU (`device=cpu`, `compute=int8`).

**Dvě reálné chyby, které jsem při psaní udělal a odchytil testem** (stojí za zapamatování):
1. `Set-Content -Encoding UTF8` ve Windows PowerShellu 5.1 píše **BOM**, a ten rozbije `JSON.parse` v Node i `json.load` v Pythonu – vygenerovaný `mcp.json` by konfiguraci shodil. Opraveno na `[IO.File]::WriteAllText` s `UTF8Encoding($false)`.
2. Zápis `config.json` přes `ConvertFrom-Json`/`ConvertTo-Json` round-trip hrozí u jednoprvkových polí (`"python": [".venv/..."]`) změnou na skalár → rozbitý config. Nahrazeno cílenou záměnou v textu (jen `device`/`compute`), ověřeno, že pole zůstane polem.

## 5aa. Titulky přebíhaly přes střih – reálný bug nalezen a opraven (2026-09-18)

Při prvním živém testu `add_captions` na skutečném obsahu (dosud neověřeno, viz [5i](#5i)) se ukázalo, že **jeden titulek umí spojit text ze dvou různých klipů přes střih**. Testovací sekvence (věty 43+44 a 55+56, střih na 14,12 s) vyrobila titulek `10,750 → 14,910` s textem *„…tristní situace s parkováním. **Bavíme se o**"* – tedy 0,79 s za střihem a s prvními slovy druhého klipu. Divák vidí titulek s textem dalšího záběru ještě před střihem a titulek pokračuje i po něm.

**Příčina**: v `add_captions` se slova ze všech klipů slila do jednoho plochého seznamu seřazeného podle času timeline a **informace o původním klipu se zahodila**. Titulek se lámal jen podle mezery > 0,6 s, délky textu a max. délky. Jenže na střihu mezera prakticky není – a čím přesnější jsou hranice střihu (což bylo cílem celého ladění v [5k](#5k)/[5m](#5m)/[5n](#5n)), tím spolehlivěji `gapTooBig` nezabere. Zlepšení přesnosti střihu tedy tuhle chybu paradoxně dělalo pravděpodobnější.

**Oprava**: každé slovo si nese index klipu (`clip: ci`) a v sestavování titulků přibyla podmínka `clipChanged` – na střihu se titulek vždy zalomí.

**Ověřeno naostro** (čerstvá sekvence, aby se netestovalo přes starou pojistku): titulek 3 nově `10,750 → 14,030` (končí před střihem, text končí u „…s parkováním.") a titulek 4 `14,090 → 19,810` začíná „Bavíme se o drhém bydlení…". Počet titulků zůstal 8, žádný text nechybí. `leadIn` (0,12 s) zůstává ošetřený clampem na konec předchozího titulku, takže přes střih nepřetáhne.

**Zkontrolováno i jinde**: `transcribe_sequence` mapuje slova na timeline stejným způsobem, ale generuje řádek zvlášť pro každý klip a každou větu, takže text přes střih nikdy nespojí – stejná chyba tam není.

## 5ab. Ověřeno bez nálezu: destruktivní mazání úseků a multicam (2026-09-18)

Po opravě titulků ([5aa](#5aa)) proběhly testy dalších dosud neprověřených oblastí. **Žádná chyba nenalezena** – zapsáno, ať se to netestuje znovu od nuly:

- **`remove_timeline_ranges` (ripple)** – klip 40 s, vyříznuto 10–15 s: délka přesně 35 s, video i audio zůstalo synchronní (stejný start/end/inPoint), žádné mezery, zdrojová návaznost sedí (270 → 275).
- **`remove_timeline_ranges` s více úseky najednou** (klasické riziko: po smazání prvního se timeline posune a další souřadnice přestanou platit) – klip 60 s, smazáno 5–10, 20–25, 40–45: výsledek 45 s a všechny čtyři zachované úseky zdroje přesně podle očekávání (260–265, 270–280, 285–300, 305–320), stopy synchronní. Nástroj si posun sám správně přepočítává.
- **`sync_media` proti ground truth** (`test/multicam/gt.json`, synteticky vyrobený set se známými odsazeními): kamery trefeny **na 0,000 s** (wide −2,000 vs −2,0; petr 1,300 vs 1,3; moderátor −0,700 vs −0,7), jistota 20–23 (práh spolehlivosti je 1,5).
- **`build_multicam_sequence` (dryRun) proti ground truth**: všech 10 promluv přiřazeno správné kameře, konce záběrů sedí na hranice promluv (±0,2 s), prostřihy do celku se vkládají podle `maxShot`, nejkratší záběr 2,4 s (limit `minShot` 1,8 s), `unmappedSpeakers` i `warnings` prázdné. Tím je pokryta poznámka z [5m](#5m) bodu 4, že multicam nebyl v přesnostní kampani testovaný.

## 6. Otevřené úkoly (priorita)
1. `install.ps1` otestovat na čistém prostředí (2026-09-16: statická revize proběhla, žádné chybějící pip/npm závislosti ani zjevné bugy nenalezeny – `undici`/`opencv-python-headless` se nainstalují automaticky, model `Qwen3-VL` se stáhne v kroku 6b/7 – ale skutečný běh na čistém PC pořád neproběhl). `make_long_test.py`/`transcribe-winrec.mjs` jsou WINREC-specifické (lze smazat).
2. Diarizace: na nahrávce z místnosti (AMI) ztratily 2 tišší mluvčí úplně, ale na **studiovém zvuku funguje spolehlivě** i na 3 mluvčích (viz sekce 5d – nejde o obecnou slabinu, jen o room-recording scénář). Zavedená oprava pro room-nahrávky by byla **VBx shlukování** (sekce 5b) – netriviální, neimplementováno, a podle 5d možná ani není potřeba tak naléhavě, jak se zdálo. **Pro multicam vždy preferovat `speakerTracks`**, kdykoli je to možné.
3. Undo je jen best-effort (5e), ale **teď existuje skutečná pojistka**: nový nástroj `backup_project` (uloží projekt + zkopíruje `.prproj` do `<projekt>/backups/` s časovým razítkem). `CLAUDE.md` instruuje zavolat ho před destruktivními nástroji. Obnova je ruční (otevřít zálohu v Premiere) – programové "restore" by bylo riskantnější než přínos. Ověřeno živě: `O:\MYpremiereMCP\test\backups\MCP_test.2026-09-16T12-00-56-572Z.prproj`, 1,2 MB, $0,05.
4. Zvážit v `build_multicam_sequence`/multicam.js přidat volitelný parametr pro úplné vypnutí prostřihů do jiné detailní kamery při `maxShot` bez `wide` role (teď padá na první jinou kameru) – momentálně se obchází ručním `rules.maxShot` na velké číslo.
5. CEP→UXP: ověřeno 2026-09-16, žádné oficiální datum konce podpory CEP neexistuje (sekce 5b) – sledovat, ale neřešit akutně.
6. `overwriteClip`/`setInPoint`+`setOutPoint` (round-trip s verifikací) v `host.jsx` stojí ~0,4–0,5 s/klip – to je skutečné dno rychlosti `buildTimeline` (ne `findClipAt`). Pro opravdu velké multicam sestavy (1000+ klipů, přes 10 min) by šlo zkusit dávkové vkládání přes QE DOM nebo vynechat verify-readback v `setItemRange`, ale nesahal jsem do toho – funguje to, jen to není bleskové. Riziko regrese převažuje nad ziskem bez jasné poptávky uživatele.

## 7. Důležité pasti (ověřené)
- **`new Time()` bez parametrů v `run_extendscript` spadlo celou Premiere** (2026-09-16, při zkoumání nezdokumentovaného `seq.performSceneEditDetectionOnSelection` – zkoušel jsem `new Time()` jako jeden z kandidátních argumentů). Bridge (port 7880) i DevTools (8098) přestaly reagovat úplně, uživatel musel Premiere restartovat ručně. Po restartu se projekt/sekvence otevřely v pořádku, žádná ztráta dat. **Nezkoušet znovu bez parametru.**
- **`performSceneEditDetectionOnSelection` vyřešeno** (po restartu, s dokumentací z komunitního fóra – ne naslepo): `seq.performSceneEditDetectionOnSelection(actionDesired, applyCutsToLinkedAudio, sensitivity)`, 3 parametry, ne 1. `actionDesired`: `"CreateMarkers"` nebo `"ApplyCuts"`. `sensitivity`: string, potvrzeno `"LowSensitivity"` (další úrovně nezkoušeny). Vyžaduje vybraný klip na timeline (`trackItem.setSelected(true,true)`). Živě ověřeno na 3minutovém úseku skutečné TV debaty (`naprimo_liberec`) – **77 markerů** (real cuts, konzistentní rozestupy 3–160 s). **Markery se ukládají na `projectItem.getMarkers()` (zdrojová položka), ne na `seq.markers`** – náš `get_markers` nástroj je proto nevidí, četl by je nový kód, kdyby se to mělo zpřístupnit jako MCP nástroj. Delší klip (celých 42 min) volání přes `run_extendscript` timeoutovalo na 120 s (default bridge timeout) – funkce běží synchronně a u dlouhého materiálu to nestihne; na krátkém úseku (3 min) proběhlo v pořádku. Nepoužito zatím jako MCP nástroj, jen ověřeno jako reálně fungující API – užitečné jako další signál (skutečné vizuální střihy kamer) vedle zvukové diarizace pro multicam, kdyby o to uživatel měl zájem.
- `exportAsMediaDirect` chce **zpětná lomítka**; H.264 MP4 preset `MediaIO\systempresets\4E49434B_48323634\01 - Match Source - High bitrate.epr`.
- `Time.getFormatted()` u nestandardních fps vrací špatný timecode → razor čte `qe…CTI.timecode` po `setPlayerPosition`.
- `overwriteClip` AV klipu přidá zvuk kamery → `removeLinkedAudio`; půlsnímkové offsety → dotáhnout `trackItem.end`.
- `.venv\Scripts\python.exe` na Windows spouští podřízený interpret → zabíjet **strom** procesů (`scripts\restart-worker.ps1`).
- Při zápisu zdrojáků **nepoužívat `\uXXXX` escapy** (Write je převede na znaky) → `String.fromCharCode`; kontrola `node scripts/verify-host.mjs`.
- Inline `python -c`/`node -e` v PowerShellu s uvozovkami padá → skripty do souborů.
- Po úpravě `host.jsx`: `node scripts/es.mjs --reload` (bez restartu Premiere). Po úpravě Workeru ho MCP server restartuje sám.
- Pyannote+WeSpeaker na nahrávce z místnosti = 1 mluvčí; proto metoda „chunks“ s CAM++.
- `worker/audiosync.py`: `decode_audio` (faster_whisper/av) na souboru bez zvukové stopy padá s kryptickým `IndexError: tuple index out of range`. Přidána `_has_audio()` kontrola → jasná hláška „Soubor nemá zvukovou stopu…“. Kamery bez zvuku nutně potřebují ruční `offset` v `build_multicam_sequence`.
- **Node `fetch` (undici) tvrdě zabíjí spojení po 300 s** bez ohledu na `AbortSignal.timeout()` (defaultní `headersTimeout`/`bodyTimeout`), stejně tak Node `http.Server` (`requestTimeout` 300 s) na straně panelu – u dlouhých `buildTimeline`/exportů (přes 5 min) nutně padá `UND_ERR_HEADERS_TIMEOUT`, i když skript v Premiere doběhne v pořádku. Řešeno vlastním `Agent`+`fetch` z npm `undici` v `server/index.js` a `server.requestTimeout = 0` v `panel/main.js`. Detaily a čísla v sekci 5.

## 8. Užitečné příkazy
```powershell
cd O:\MYpremiereMCP
node scripts\smoke.mjs                        # MCP nástroje
node scripts\test-multicam-unit.mjs           # logika kamer
node scripts\test-worker.mjs                  # Worker + multicam (syntetika)
node scripts\test-premiere.mjs status         # spojení s Premiere (panel musí být otevřený)
node scripts\test-podcast2.mjs                # skutečné video end-to-end (lokálně)
powershell -File scripts\restart-worker.ps1   # tvrdý restart Workeru
node scripts\cdp.mjs                          # chyby panelu přes DevTools
```

## 9. Hermes jako druhý jazykový model (2026-09-23)

Uživatel má na `O:\Hermes` vlastního agenta s llama-serverem (port 8000, **Qwen3.6-35B-A3B Q4_K_XL**, ovládá se
`O:\Hermes\switch-llm.ps1 vize|text|stop|status`). Je připojený jako **externí backend** vedle našeho gemma3:

- `config.json` → `llmBackends.hermes` (url, model `dflash`, `thinking: false`, temperature).
- `worker/gpu.py`: `chat_json(..., backend)` – externí server se nespouští ani nevypíná, **nesahá na naši GPU správu**;
  `backend_status()` (vidět ve `worker_status`), `kill_orphan_llama` kontroluje jen exe z našeho `tools/` (Hermes nechá být).
- `analyze_transcript` a `plan_edit_local` mají parametr `backend` ("local" | "hermes"); analýza má backend v cache klíči,
  `plan_edit` si vždy vytáhne osnovu **od stejného modelu**.
- Uvažovací modely: bez `enable_thinking:false` spotřebují limit tokenů na přemýšlení a vrátí prázdný `content`
  (fallback čte `reasoning_content`). Se schématem (json_schema) Hermes odpovídá spolehlivě.
- Vedle Hermese (10–11 GB VRAM) se náš gemma3 nevejde → `ensure_llm` má fallback na `llm.gpuLayersFallback` (12 vrstev).

### Test Claude vs Hermes (stejné zadání, stejný materiál)
Materiál: `tncz-TIT_2026-06-16_naprimo_liberec.mp4` (předvolební debata Olomouc, 41:57, 362 vět).
Zadání: *„Tříminutový sestřih o bydlení a parkování: nejkonkrétnější argumenty obou hostů, bez organizačních vět moderátora, bez opakování."* (cíl 180 s)

| | Claude (osnova + 3 pasáže přepisu) | Hermes (osnova + plán lokálně) |
|---|---|---|
| Výsledek | 20 vět, 184 s | 24 vět, 189 s |
| Čas | ~5 min (z toho ~12k tokenů kreditů) | 5,5 min osnova + 1 min plán, 0 kreditů |
| Věty moderátora | 0 | 1 (#40) |
| Useknuté začátky vět | 1 (#293) | 3 (#56, #92, #109) |
| Vata < 3 s | 1 | 3 (např. #41 „Asi jak v jakém ohledu.") |
| Pokrytí parkování / bydlení | 6 / 9 vět | 4 / 7 vět |
| Mimo téma | 0 | 2 (#30 sloup UNESCO, #48 chodník) |

Průnik výběrů byl jen **4 věty z 20/24** – modely čtou materiál velmi odlišně.
Hermes našel 4 konkrétní kroky primátorky, které Claude vynechal (#82/83 koordinátor stavebních řízení,
#85 změna územního plánu, #90 kontaktní místo pro bydlení, #92 garance nájemného); Claude zase pokryl
**řešení parkování** (P+R, zóny, karta zdarma, nepoužité automaty, důvod zastavení politiky), které Hermes celé vynechal.

**Závěr:** Hermes je použitelný jako **levný první průchod a druhý názor**, ne jako finální střih.
Doporučený režim: `plan_edit_local backend:"hermes"` → Claude výsledek dočistí (vata, useknuté věty, chybějící téma).
Sekvence k porovnání v `O:\DETAIL\premiere\testicek2.prproj`: „STRIH CLAUDE bydleni+parkovani", „STRIH HERMES bydleni+parkovani".
Report: `test/llm-compare/report.md`, skripty `scripts/compare-llm.mjs` (env `INSTRUCTION`), `scripts/build-from-compare.mjs`.

**Neověřeno:** přímé srovnání Hermes vs náš gemma3 na stejném materiálu (Hermes drží VRAM, gemma3 by běžel s offloadem a výrazně pomaleji).

## 10. Srovnání všech modelů na stejném střihu (2026-09-23)

Materiál: `tncz-TIT_2026-06-16_naprimo_liberec.mp4` (42 min, 362 vět, předvolební debata Olomouc).
Zadání pro všechny stejné: *„Tříminutový sestřih o bydlení a parkování: nejkonkrétnější argumenty obou hostů
(co chtějí udělat a čím to zdůvodňují), bez úvodních a organizačních vět moderátora, bez opakování."* (cíl 180 s)
Každý model dostal identický prompt přes stejné CLI jako panel a sám postavil sekvenci
(`scripts/compare-agents.mjs`, vyhodnocení `scripts/eval-sequences.mjs`, report `test/agent-compare/report.md`).

| Model | Čas | Cena | Délka | Vět | Moderátor | Useknuté | Parkování/Bydlení |
|---|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 145 s | $0,202 | **339 s ✖** | 40 | 0 | 0 | 9 / 12 |
| Claude Sonnet | 219 s | $0,976 | 174 s | 19 | 0 | 0 | 9 / **2** |
| Claude Opus | 211 s | $1,438 | 176 s | 19 | 0 | 1 | 9 / 4 |
| Codex GPT-6-Astra | 117 s | – (předplatné) | 180 s | 22 | **2 ✖** | 0 | 9 / 3 |
| Codex GPT-5.5 | 116 s | – (předplatné) | 176 s | 22 | 0 | 0 | 9 / 7 |
| Hermes Qwen3.6-35B (lokálně) | 53 s | zdarma | 185 s | 19 | 1 ✖ | 2 | 4 / 7 |
| Claude v konverzaci (ruční výběr přes nástroje) | ~5 min | kredity session | 184 s | 20 | 0 | 2 | 6 / 9 |

Pozn.: sloupec Parkování/Bydlení je klíčkový (počítá výskyt slov), takže "mimo téma" nadhodnocuje –
věty typu #82/#83 (koordinátor stavebních řízení) jsou věcně o bydlení, jen bez klíčového slova.
Skutečné odbočky mimo zadání: Hermes #30/#33/#38 (sloup UNESCO, sakrální stavby, "Olomouc rozkvetla"),
Haiku #20/#21 (výstava na Horním náměstí), GPT-6-Astra #78 (věta moderátora).

**Závěry:**
- **GPT-5.5 (Codex)** dal nejvyváženější výsledek: přesná délka, obě témata, žádná vada, 2× rychlejší než Sonnet.
- **Opus/Sonnet** spolehlivě drží délku a neberou moderátora, ale Sonnet se vychýlil skoro jen k parkování (bydlení 2 věty).
  Opus je nejdražší ($1,44 za jeden tříminutový sestřih).
- **Haiku** cílovou délku ignorovalo (339 s místo 180) – levné a rychlé, ale u zadané stopáže nespolehlivé.
- **Hermes** je zdarma a nejrychlejší (53 s), ale má nejvíc vad (1 věta moderátora, 2 useknuté začátky, 3 odbočky).
- Celkově: **délku dodrží všichni kromě Haiku**; rozdíl je hlavně v tom, jestli model pokryje obě zadaná témata
  a jestli nepustí do střihu vatu/moderátora.

**Opraveno při testu:** `scripts/local-edit.mjs` (režim "Hermes (lokálně, zdarma)" v panelu) rozpoznával cílovou délku
jen z číslic – "tříminutový" ignoroval a výsledek vyšel na 6:35. Doplněny české číslovky (`půlminutový`…`dvacetiminutový`).
Codex CLI není v PATH (leží v `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`) – panel na to fallback měl,
doplněn i do `scripts/compare-agents.mjs`.

**Změna po srovnání (2026-09-23, přání uživatele):** Haiku 4.5 **odstraněno z nabídky modelů v panelu**
(`panel/index.html`) – v testu na skutečném střihu jako jediné ignorovalo zadanou stopáž (339 s místo 180).
Výchozím modelem pro Claude je nově **Sonnet** (`lastModelByAgent.claude`), uložená volba `haiku`
v `localStorage` se ignoruje. Tím je překonaná starší poznámka z [5v] o Haiku jako výchozím modelu.
Ověřeno v běžícím panelu: nabídka = výchozí model / Opus / Sonnet, vybráno Sonnet.

## 11. Ladění Hermese + knihovna hlasů (2026-09-23)

**Chyba, která dlouho mátla: dva Workery na jednom portu.** `ThreadingHTTPServer` má `allow_reuse_address = True`,
což na Windows (SO_REUSEADDR) dovolí navázat na **stejný port dvě instance**. Po restartu kvůli změně kódu tak
zůstal běžet starý Worker vedle nového, dotazy chodily náhodně jednomu z nich → změny v `worker/*.py` se
"neprojevovaly" a občas padalo `Worker se nespustil do 90 s`. Opraveno v `worker/server.py` (`ExclusiveHTTPServer`
s `allow_reuse_address = False` + `SO_EXCLUSIVEADDRUSE`), takže druhá instance rovnou skončí a restart je čistý.
V `server/index.js` navíc zámek `cache/worker.restart.lock` (restartuje jen jeden proces; paralelní skripty se
o Worker neperou) a fallback: když Worker nakonec odpovídá, použije se místo tvrdé chyby.

**Ladění kvality střihu (platí pro všechny modely, ne jen Hermese)** – `worker/analysis.py`:
- Zadání obsahuje "bez moderátora/otázek/organizačních vět" → jeho věty se ze střihu **vyhodí deterministicky**
  (`_moderator_speakers`: jméno z knihovny hlasů, jinak ten, kdo mluví nejmíň a nejčastěji se ptá).
  Q/A párování pak moderátorovy otázky zpět nepřidává.
- Věta začínající malým písmenem (pokračování předchozí) se buď **doplní o předchozí větu, nebo vypadne** –
  střih už nezačíná uprostřed souvětí. Vrací se v `fixedFragments` / `removedModerator`.
- Do promptu pro výběr vět přidána obě pravidla explicitně.
- `scripts/local-edit.mjs` (panel → "Hermes (lokálně, zdarma)") rozumí i slovní stopáži ("tříminutový").

**Knihovna hlasů (`models/voices/library.json`)** – uživatelův nápad "poznat lidi podle barvy hlasu":
- Diarizace (metoda chunks) spočítá pro každého mluvčího **průměrný hlasový otisk** (CAM++ embedding) → `centroids`
  v cache souboru diarizace.
- Otisky se porovnají s knihovnou (kosinová podobnost ≥ `diarization.voiceMatch`, výchozí 0.55) → mluvčí dostane
  rovnou jméno (`matchedVoices`), jinak zůstane S1/S2/…
- `rename_speakers` s `enroll: true` (výchozí) hlas **uloží/zprůměruje** → v dalších videích se pozná sám.
  Nové nástroje: `list_voices`, `forget_voice`.
- Test: `scripts/test-voices.mjs` (diarizace → pojmenování → nová diarizace pozná jména → kontrola, že cizí
  hlasy z jiného videa se k uloženým jménům nepřiřadí).

### Doměřeno (2026-09-23 večer)
**1. běh 5 kol po ladění odhalil dvě chyby v `worker/analysis.py plan_edit`** (moderátor 1× a useknutá věta 1× v každém kole):
- Regex pro "bez moderátora" byl `bez\s+\w*\s*(moder|…)` – na zadání "bez **úvodních a organizačních** vět moderátora"
  (dvě slova mezi) nezabral, filtr se vůbec nezapnul a Q/A párování navíc vrátilo otázku moderátora #40.
  Opraveno na `\bbez\b[^.;:(),]{0,60}?(moder|otázek|organiza)` (v rámci jedné fráze; "bez opakování, jen moderátor" nezabere).
- Oprava fragmentů doplnila #92 k #93, ale zkracování na cílovou délku je bralo jako **samostatné celky** a #92 vyhodilo
  → #93 zase bez začátku. Teď se věta začínající malým písmenem spojí s předchozí do jednoho celku (`continues()`),
  stejně jako dvojice otázka–odpověď.

**Hermes, 5 kol, stejné zadání, cíl 180 s:**
| | před laděním | po ladění, před opravou | **po opravě** |
|---|---|---|---|
| délka | 185 s | 178,7 s (173–183) | **178,2 s (171–186)** |
| vět | 19 | 18,2 | 18,4 |
| moderátor | 1 | 5×/5 kol | **0** |
| useknuté začátky | 2 | 5×/5 kol | **0** |
| odbočky mimo téma | 3 (#30, #33, #38) | – | #33 2×, #48 2×, #38 1× (z 5 kol); #30 už nikdy |
| čas | 53 s | 41,7 s | 40,8 s |
Stabilita: 13 vět ve všech 5 kolech, celkem 24 různých vět.

**Knihovna hlasů – `node scripts/test-voices.mjs` → vše prošlo** (diarizace 3 otisky, uložení Ferancová/Vašíř/
Moderátor Napřímo, nová diarizace je pojmenuje sama, Diskuse1 nic nepřiřadí). Kosinové podobnosti: cizí hlasy
z Diskuse1 max **0,30** vůči prahu 0,55 (velká rezerva); mezi třemi lidmi v debatě max 0,33.
**Pozor:** shoda na stejném videu vychází 1,0, protože diarizace je deterministická – je to triviální případ.
**Neověřeno:** rozpoznání stejného člověka v **jiné nahrávce** (jiný mikrofon/studio) – potřebuje to další díl
Napřímo nebo jiné video s Ferancovou/Vašířem. Knihovna teď obsahuje tyto 3 hlasy a přepis debaty má místo S1–S3 jména.

## 12. Noční ladění 2026-09-23/24 – přesnost, rychlost, tokeny (rozpracováno, průběžně doplňováno)

**Plán střihu (`worker/analysis.py plan_edit`) – nalezené a opravené chyby:**
- **Hodnocení kapitol mělo limit 900 tokenů** → u 50 kapitol model ohodnotil jen K1–K16, zbytek dostal 0
  a celá druhá půlka pořadu (u debaty celé parkování, věty 272–338) se do výběru nikdy nedostala. Teď po dávkách po 12.
- Kapitoly se hodnotily k zadání, ale věty uvnitř ne → do střihu padaly odbočky (sloup UNESCO, výstava).
  Model teď u každé vybrané věty uvádí téma zadání / okrajově; okrajové jdou při zkracování pryč první.
- **Kontrola tématu** (`_verify_topic`): samostatné volání, u každé věty nejdřív „o čem je“ (o_cem), pak přiřazení
  k tématu zadání / „jiné“, s názvem kapitoly jako kontextem. Chytá příbuzná témata (tramvaje ≠ parkování),
  bez příkladů šitých na debatu. Hesla jednoho tématu se při kontrole nerozlišují (jinak moc přísné).
- **Témata zadání** (`_instruction_topics`): model vypíše témata + zda jde o samostatná témata vedle sebe
  („o bydlení a parkování“ → vyvažuje se podíl) nebo aspekty jednoho („cena ovladače“ → nevyvažuje se).
- **Vyvážení mluvčích** („argumenty obou hostů“): zkracování bere nejdřív nadměrně zastoupeného (> férový podíl + 5 b.).
- Délka: zkracování cílí na ±3 % (dřív začínalo až nad +10 %), krátký výběr se dorovná z vyřazených;
  když ani to nestačí, **doplňkový výběr** z dosud nevybraných vět jádrových kapitol.
- Zrychlení: hodnocení bez zdůvodnění (generování je dno – Hermes ~38 tok/s, prompt ~520 tok/s, cache prefixu
  u Qwen3.6 nefunguje), okna 20 vět, moderátor se do promptu vůbec nedává, kontrola tématu až po předběžném
  zkrácení na 1,6× cíle. `plan_edit` vrací `elapsedSec` a `llmStats` (volání/tokeny/čas po fázích) – `gpu.CALL_STATS`.
- `backend` výchozí `auto` = Hermes, když běží, jinak vlastní gemma3.
- Testy: `scripts/test-hermes-loop.mjs` (debata, měří i odbočky a podíl Ferancové), **nový**
  `scripts/test-plan-diskuse.mjs` (jiný materiál i zadání – pojistka proti přeladění). Moderátor se v testech
  pozná podle mluvčího – starý pevný seznam ID byl ze staré verze přepisu a obsahoval i věty hostů.

**Claude – tokeny (změřeno `claude -p` s prázdným dotazem):** dnešní panel = **27 800 tokenů** zápisu do cache
při každém spuštění (1h cache = 2× cena vstupu). Z toho popisy 43 MCP nástrojů ~15 700, výchozí systémový prompt
Claude Code ~6 700, vestavěné nástroje ~2 600, CLAUDE.md ~2 600. `--bare` nejde (vyžaduje API klíč, ne OAuth).
Štíhlá varianta = `--tools=` + `--system-prompt <panel/agent-system.md>` → ~18 500. Výsledky nástrojů se teď vrací
jako kompaktní JSON (dřív odsazený mezerami → zbytečné tokeny v každém výsledku).
`plan_edit_local` má `format:"review"` = texty vybraných vět + ověření náhradníci (hybrid: Hermes navrhne,
Claude jen zkontroluje). `scripts/compare-agents.mjs` umí profil `claude:sonnet:lean` a ukládá průběh do `<TAG>.jsonl`.

**Opraveno:** `gpu.whisper()` po záloze na CPU načítal model znovu při každém přepisu (jiný klíč než požadovaný).

**Průběžné výsledky (2026-09-24 ~01:30):**
- Plán Hermesem (debata, 42 min, cíl 180 s): **229 s → 59 s**, 6/6 kol bez vady (moderátor 0, useknuté 0, odbočky 0),
  délka 175–184 s, témata bydlení/parkování ~55/45, Ferancová 38–49 %. `Diskuse1` (cíl 120 s): 20–27 s, 113–123 s,
  100 % v jádru tématu. Zrychlení: skóre kapitol jako pole čísel (28 → 7 s), výběr vět jako tři pole ID
  `{"nutne","dobre","okrajove"}` místo objektů (84 → 38 s), kontrola tématu bez popisu `o_cem` (33 → 12 s,
  stejný verdikt 5/5), kompaktní JSON na jednom řádku ve všech voláních (`gpu.chat_json` přidává pokyn).
- **Osnova (analyze) 3,8× méně tokenů**: důvody slabých vět jen kódem (enum), shrnutí max 20 slov, JSON na jednom
  řádku → debata 5,5 min → 2,1 min, Diskuse1 159 → 58 s. `analyze` i `plan_edit` mají výchozí backend `auto`.
- Kontrola tématu: věty bez verdiktu se ptají znovu (dřív prošly bez kontroly); pojistka „model vyřadil všechno“
  až od 90 % (při 60 % zahazovala správný verdikt, když kandidáti z příbuzné kapitoly – tramvaj – tvořili většinu).
- **Claude hybrid naostro** (`compare-agents.mjs claude:sonnet,claude:sonnet:lean`): dnešní panel $0,851 / 105k tokenů
  zápisu / 10 kroků vs. **štíhlý+hybrid $0,222 / 25k / 5 kroků**, oba bez vad, hybrid lépe vyvážený (Ferancová 47 %
  vs 35 %). Nasazeno do panelu (`panel/main.js`: `--tools=` + `--system-prompt` z `panel/agent-system.md`, jen
  u claude.exe – .cmd by cmd.exe rozbil víceřádkový argument). Ověřeno přes `panel-run.mjs`.
- Úspory tokenů na serveru: `transcribe_media` u dlouhého přepisu (> 8000 znaků) vrací jen začátek + odkaz
  na cílené čtení (dřív 20 000 znaků, které agent v každém dalším kroku četl znovu); `search_transcript` při
  nenalezení zkusí kmen slova (skloňování); zapomenutý `path`/`source` = poslední zdroj v běhu; chyba s chybějícím
  zdrojem vypíše jen 5 nejnovějších přepisů. Nový `scripts/panel-reload.mjs` (reload stránky panelu přes DevTools).
- **Whisper vedle Hermese** (`scripts/asr-bench.py`, 3 min zvuku): při plné VRAM (11,4 GB) float16 87 s (ovladač
  přelévá do RAM), při 4 GB volných 22 s, int8_float16 28,5 s se stejnou přesností, CPU int8 255 s (pomaleji než
  realtime – CPU cesta nemá smysl ani na 7950X3D). `gpu.whisper()` teď po uvolnění vlastních modelů změří volnou
  VRAM (`free_vram_mb`) a pod 4,5 GB použije int8_float16.

**Další výsledky (2026-09-24 ~02:30):**
- **Teplota Hermese 0** (`config.json llmBackends.hermes.temperature`): stejné zadání = stejný střih (dřív se výběr
  mezi koly lišil – ve všech 5 kolech byly jen 3 stejné věty). Kvalitu to nezhoršilo.
- Zkracování: mezi rovnocennými celky jdou pryč **nejkratší** (dřív nejdelší → střih měl 36 vytržených krátkých
  vět místo ~18 souvislých). "Za druhé…/Za třetí…/Tím…" se berou jako pokračování předchozí věty (jako malé písmeno).
  **Vyvažování výměnou** (`rebalance`): celek převažujícího mluvčího/tématu se nahradí celky z ověřených náhradníků,
  když by samotné vyhození stopáž podstřelilo; při nouzi se ověří i nejlepší z předběžně vyřazených.
- Témata zadání: `_instruction_topics` vrací i `obecne` (přehled celého pořadu → bez kontroly tématu, zkracování
  hlídá pokrytí různých kapitol) – ale obrat „o …/ohledně/na téma“ obecnost vždy ruší (model jednou dal obecné
  u „sestřih o seniorském bydlení“). Samostatná témata i deterministicky: dvě témata spojená přímo spojkou
  („o bydlení a parkování“). Vyvážení mluvčích pozná i „každý z kandidátů“.
- Filtr moderátora pozná i „vynech/žádné/nevybírej … moderátora“ (Claude zadání přeformuloval „Vynech…“ a filtr
  se nezapnul). Prompt pro Clauda i `AGENTS.md`: `instruction` předávat doslova, `backend` vynechat.
  Popis parametru `backend` už "local" nenabízí jako rovnocenné – **Codex si vyžádal "local" (gemma3 vedle Hermese)
  a plán trval přes 10 min**; úlohu šlo zrušit `POST :7881/jobs/<id>/cancel` s hlavičkou `X-PMCP-Token`.
- **Chyba přepisu nalezena a opravena (`worker/asr.py`)**: `transcribe_media` s jiným `prompt` (agent ho posílá „pro
  jistotu“) spustil nový přepis celého videa, přepnul index na přepis bez diarizace a změnil číslování vět
  (v cache debaty bylo 8 přepisů!). Teď se existující přepis vrátí, pokud agent výslovně nechce jiný model/jazyk/
  mikrofony. Správný přepis debaty = `…01a7cbdfa357.json` (365 vět, diarizace, jména). Testy mají čísla podle něj
  (tramvaj 243–271).
- `compare-agents.mjs` hledá novou sekvenci podle ID (opakovaný běh se stejným názvem dřív měřil starou sekvenci).
- Nový `scripts/test-plan-battery.mjs` – 6 různých zadání na 2 materiálech, texty do `test/hermes-loop/battery.md`.
  Všech 6 v toleranci ±3 %, čas 21–67 s. Slabina: věty s odkazem na předchozí kontext („Teď se nám podařilo…“) – to
  dočistí Claude při kontrole návrhu.
- **Whisper dávkově** (`BatchedInferencePipeline`, `config.whisper.batchSize` 8, jen na GPU): 10 min debaty 68 s → 18 s,
  přesnost textu i časů slov stejná (`scripts/asr-batch-bench.py`); přes Worker 10 min za 23 s. `test-worker.mjs` prošel.
- Codex GPT-5.5 se stejným zadáním: bez vad, 178 s, ale sám přečetl velkou část přepisu (na předplatném to nevadí).
- Lokální cesta z panelu (`local-edit.mjs`): 45 s včetně stavby sekvence; místo seznamu skóre vypisuje souhrn
  (témata, vynechaný moderátor, vyřazeno mimo téma).

**Claude v panelu – finální nastavení (2026-09-24 ~02:50, `panel/main.js`):**
`--tools=ToolSearch --effort medium --system-prompt <panel/agent-system.md>` (+ `--mcp-config … --strict-mcp-config
--allowedTools mcp__premiere`). Změřeno `compare-agents.mjs` na stejném 3min střihu debaty:
| profil | čas | cena | výstup tok. | střih |
|---|---|---|---|---|
| původní panel | 132 s | $0,851 | 10 675 | bez vad, Ferancová 35 % |
| `--tools=` + prompt (lean) | 106–125 s | $0,13–0,25 | 2 900–4 200 | bez vad |
| + ToolSearch, výchozí úsilí (lean2) | 124 s | $0,278 | 7 636 | bez vad |
| **+ ToolSearch + effort medium** | **70 s** | **$0,160** | 1 986 | bez vad, 54 % |
| + ToolSearch + effort low | 66 s | $0,144 | 1 233 | bez vad (stejný výsledek) |
- ToolSearch: prázdný dotaz 19 665 → **5 550 tokenů** (popisy 43 MCP nástrojů se načtou až na vyžádání). Prompt
  Claudovi říká přesný dotaz `select:mcp__premiere__…` (bez předpony hledal 3×). ENABLE_TOOL_SEARCH nic nedělá,
  rozhoduje povolení vestavěného nástroje ToolSearch.
- Výchozí úsilí generovalo hodně přemýšlení (výstupní tokeny jsou nejdražší) bez rozdílu ve výsledku → medium.
- Panel naostro (`panel-run.mjs`): sestřih o seniorech 57 s / $0,108; navazující úprava 53 s / $0,039;
  titulky 8 s / $0,028.
- Nedokončené konce: plán k vybrané větě doplní i její pokračování (další věta téhož mluvčího začínající malým
  písmenem); review výstup značí pokračování `↳` a Claude je nesmí oddělit (dřív vybral #125 „…pro seniory,“ bez #126).
  Testy (`test-plan-battery`, `compare-agents`) měří i „nedokončené“.
- gemma3 (backend local) vedle Hermese: `ensure_llm` podle volné VRAM rovnou volí 12 vrstev na GPU (dřív -ngl 99 →
  ovladač vytlačil Hermese z VRAM do RAM, 11 GB → 2 GB). Plán Diskuse1 přes gemma3: 177 s, 86 % v jádru – použitelná záloha.
- **Multicam přes panel** (syntetický `test/multicam`): 16–23 s, $0,06–0,14, střihy i sync správně (chyba 0,02 s).
  Nalezeno: Claude jednou předal do `audio` oba mikrofony na **stejnou stopu A1** → druhý přepsal první, pod obrazem
  zbyl jen moderátor. Opraveno v `build_multicam_sequence`: kolidující zvuky se rozloží na volné stopy (A1, A2…)
  s upozorněním ve `warnings`; popis `audio` + prompt: mikrofony patří do `speakerTracks`, ne na timeline.
  Chybné rozhodnutí se opakovalo, dokud byl v panelu zapnutý „navázat“ (Claude pokračoval v relaci, kde to udělal);
  v čisté relaci dal správně jen `master_mix.wav`.
- Pozn.: testy vytvořily v `O:\DETAIL\premiere\testicek2.prproj` řadu sekvencí `TEST PANEL …`, `TEST CLI …`,
  `TEST MCP …`, `STRIH CLAUDE-…`, `STRIH HERMES …` (dají se smazat ručně).
- **Celá cesta u nového videa** (`scripts/test-fresh-pipeline.mjs`, kopie debaty `test/fresh/debata-nova.mp4` – 640 MB,
  lze smazat): přepis 73 s + mluvčí 17 s (jména z knihovny hlasů naskočila sama) + osnova 140 s + plán a sekvence 65 s
  = **4,9 min** pro 42min video → hotový 3min střih (dřív řádově 12–30 min podle obsazení VRAM).
  Dávkový přepis má o ~7 % víc „vět“ (dělení při pauze > 0,9 s / 20 s) a víc začátků malým písmenem (10 % vs 8 %);
  plán je spojuje pravidlem pokračování, ve střihu se to neprojevilo. Vypnutí: `config.whisper.batchSize: 0`.
- Codex po úpravě `AGENTS.md`: 7 volání místo 23, vstup 180k místo 510k tokenů, bez ukládání projektu, střih bez vad.
- **Věty s odkazem na předchozí kontext** („Tím si to zhoršujeme.“, „Teď se nám podařilo jednat s partnerem…“):
  kontrola tématu u každé věty vrací i `odkaz` ano/ne (model značí rozumně: #111, #284, #312). Takový celek se sloučí
  s celkem, kde je předchozí věta (aby je zkracování nerozdělilo), nebo se předchozí věta předřadí. Plán debaty teď
  ~40–70 s; dno je čtení promptu ve výběru vět (~16k tokenů textu kandidátních kapitol).
- **Upoutávka ze zpráv přes panel** (`strepiny-ai-zdravi`, 30 s): Claude sám zavolal `detect_scene_cuts` (pravidlo
  z CLAUDE.md), našel 2 hranice 0,07/0,18 s od skrytého řezu a posunul je – správně, ale 261 s / $0,43.
  `detect_scene_cuts` teď ukládá výsledek do `cache/scenecuts` (soubor+velikost+mtime+citlivost; kratší rozsah
  z delší analýzy), odfiltruje duplicitní/nahromaděné značky mimo rozsah (značky se ukládají na zdrojovou položku
  a hromadí se z každého běhu), limit mostu 300 → 900 s (celých 6 min zdroje předtím nestihlo). 120 s zdroje ~30 s.
  Každé volání pořád vytvoří dočasnou sekvenci „SCENE DETECT …“ (smazat přes API nejde).
- **`detect_scene_cuts` přes celý zdroj je v praxi nepoužitelné**: 350 s zprávy nestihlo ani 15 min (Premiere počítá
  na 1 jádře, neroste lineárně – 120 s ~30 s) a zablokovalo engine ExtendScriptu (Stop v panelu ukončí jen agenta,
  už odeslané volání ExtendScriptu doběhne; agent navíc detekci po timeoutu zkusil znovu). Přidán parametr
  **`ranges`** (okna kolem hranic klipů): host.jsx vyprázdní dočasnou sekvenci, položí okna za sebe, vybere je a spustí
  detekci jednou; vrací jen řezy uvnitř oken. CLAUDE.md i panel prompt: jen s `ranges`, nikdy přes celý zdroj.
  Okna nejdou do cache (cache = analýza od začátku). **host.jsx je potřeba znovu načíst** (`node scripts/es.mjs --reload`)
  – pokud to v noci nešlo kvůli zablokované Premiere, udělej to ráno a otestuj (viz níže).
- Ověřeno ráno (04:50): detekce po oknech (4 okna, 25 s zdroje) **7,8 s** a našla stejné řezy jako pomalá cesta
  (178,48 / 347,16 s). Upoutávka přes panel v čisté relaci 135 s / $0,32 (předtím 261 s, nebo zablokování).
  Claude přestavěl návrh (30 s) na 37 s → prompt: držet cílovou délku ±10 %. Timeout mostu (504) teď vrací hlášku
  „nestihla odpovědět… NEOPAKUJ stejné volání“ (agent dřív po timeoutu zkusil totéž znovu).

**Pokračování ladění 2026-09-24 ráno:**
- **Instrukce MCP serveru** (dostává je každý klient) říkaly „přečti přepis celý“ – přepsány na úsporný postup
  (plan_edit_local review, cílené čtení, ↳ = pokračování věty).
- `build_sequence_from_transcript` i `build_from_plan` vrací **`continuity`**, když výběr celých vět utne souvětí
  (pokračování s malým písmenem chybí / věta začíná uprostřed). Pokyny (panel, CLAUDE.md, AGENTS.md): postav znovu opraveně.
- **Lokální stavba (`plan_edit_local` + `build`) nedolaďovala konce vět podle zvuku** (`refineOutPoints`) – doplněno,
  stejně jako u build_sequence_from_transcript. Vrací i `continuity`.
- `build.sceneCuts: true` → `snapToSceneCuts`: detekce střihů obrazu v oknech kolem hranic klipů; střih do 1,5 s
  uvnitř klipu → hranice se na něj přesune, jen když mezi nimi není řeč (slovo se nikdy neuřízne), jinak upozornění.
  `local-edit.mjs` (panel „Hermes lokálně“) to zapíná u cílů do 90 s. Ověřeno na reportáži AI a zdraví: konec
  přesunut 347,23 → 347,16 s (stejný řez našel Claude), 1 upozornění. `detectSceneCutsCached` je sdílená funkce.
- `local-edit.mjs` nerozpoznal „třicetisekundová“ (jen „-minutový“) → bez cílové délky vznikl 3min střih. Opraveno
  (sekundové tvary, číslovky do „devadesáti“, „pětačtyřiceti…“).
- `build_sequence_from_transcript` má také **`sceneCuts: true`** (stejná logika jako lokální stavba) – Claude u krátkých
  zpravodajských sestřihů už ručně detekci nevolá (CLAUDE.md pravidlo 6, panel prompt). Upoutávka přes panel:
  261 s / $0,43 → 135 s / $0,32 → **75 s / $0,20**.
- `detect_scene_cuts` s `ranges` znovu používá pracovní sekvenci „SCENE DETECT …“ téhož zdroje (dřív každé volání
  přidalo novou; Premiere z názvu odřízne příponu, proto porovnání podle začátku názvu). Okna se ořezávají na délku zdroje.
- Omezení na mluvčího („jen výroky Vašíře…“, „co říká primátorka Ferancová…“) lokální model zvládá sám: 100 % daného mluvčího.

**Film „2000 metrů do Andrijivky“ (2025, 1:47:54, převážně rusky) – první skutečně dlouhý a nečeský materiál:**
- Přepis s `language: ""` (autodetekce → ru) **86 s** (dávkově), diarizace 27 s (16 mluvčích – terénní záznamy),
  osnova 7,3 min (746 vět; shrnutí kapitol česky věrně odpovídají ruské řeči). S2 = vypravěč → `rename_speakers`
  `{S2: "Vypravěč"}` s `enroll: false` (obecné jméno do knihovny hlasů nepatří).
- **Chyba: `search_transcript` na azbuce nenašel nic** – `\b`/`\w` v JS regexu znají jen ASCII. Opraveno na unicodové
  hranice (`(?<![\p{L}\p{N}])`, flag `u`); čeština fungovala jen díky odstranění diakritiky.
- **Omezení na mluvčího deterministicky** (`_speakers_named`): „co říká vypravěč“, „jen výroky Vašíře“, „co řekla
  Ferancová a co Vašíř“ → ostatní mluvčí model nevidí (sám u filmu vzal 60 s jiného mluvčího). Obraty jen/pouze/
  říká/řekl/výroky/slova/mluví + jméno podle kmene; S1, S2… se nehledají; „bez moderátora“ omezení nespustí.
- Plán vrací **`note`**, když se k zadání našlo < 85 % cílové délky (u vypravěče 75 s z 120 s) – ukazuje ho review
  výstup i `local-edit`.
- Plány na filmu: upoutávka 3 min (obecné zadání) 88 s → 177 s; vypravěč 2 min → 75 s + poznámka; drony 1 min 246 s → 58,5 s.
- V projektu testicek2 vznikly sekvence „STRIH HERMES 11:17“ (vypravěč, lokálně) a **„UPOUTAVKA Andrijivka“**
  (Claude v panelu, 2:05, gradace, `sceneCuts`, 215 s / $0,16).

## 13. Titulky s překladem + dabing (2026-09-24)

> **Dabing ZRUŠEN (2026-09-24, na přání uživatele)** – zůstávají jen titulky a jejich překlad. Odstraněno:
> `add_dubbing`, `worker/dub.py`, host `placeAudio`, panel „Dabing“, `config.xtts`, `scripts/dub-qa.py`; XTTS
> (tools/xtts, models/xtts, tools/rubberband) a `cache/dub` přesunuty do `O:\_smazat_dabing` (smaže uživatel;
> originál je v O:\ALLDUB). Níže jen historie – poznatky o XTTS pro případný návrat.

**Vícejazyčný přepis:** `transcribe_media language: ""` → faster-whisper `multilingual=True` (jazyk po úsecích).
Dřív autodetekce z prvních 30 s určila jeden jazyk pro celý soubor a zbytek do něj „přeložila“ (film „2000 metrů do
Andrijivky“: anglický vypravěč vyšel rusky). Klíč cache má `multilingual`, přepis má pole `multilingual`.
Film teď: 708 vět, 211 anglicky, 495 azbukou, přepis 71 s.

**Titulky s překladem:** `add_captions translate: "cs"` → Worker úloha `translate` (`worker/analysis.py`, Hermes/auto,
dávky po 30 s číslem titulku `{"i","t"}` – samotné pole textů se jednou posunulo o jeden a časy dostaly cizí věty;
nepřeložené/echo se překládá znovu po jednom). Útržky jedné věty (titulek se na střihu láme) se přeloží dohromady
a překlad se rozdělí zpět podle délek. Titulek se nově láme i na konci věty. 25 titulků ~11–20 s.
Panel: u titulků volba „jazyk: jak se mluví / přeložit do češtiny“.

**Typografie titulků (2026-09-24, platí pro všechny titulky):**
- `wrapCue` u dvouřádkových: vyvážený zlom (ne plný první řádek + zbytek), radši za interpunkcí, nikdy za
  jednopísmennou předložkou/spojkou ani za řadovou číslovkou („k 3. / útočné“).
- `timelineCues`: limit znaků s rezervou (80 → 72, řádky se lámou jen mezi slovy); plný titulek se dělí radši za
  čárkou v posledních 5 slovech; jednopísmenné slovo na konci titulku přejde do dalšího; osiřelý konec věty
  („myslet.“) si vezme poslední slova předchozího titulku (od čárky/spojky).
- Překlad: hranice útržků podle poměru délek, ale radši za interpunkcí / před spojkou, ne za „v“/„3.“; útržek pod
  2 slova se připojí k sousedovi (dřív samotné „Osud“ 2,6 s); titulek delší než 2 řádky se rozdělí na dva (čas podle
  znaků); malé písmeno na začátku po konci věty/pauze → velké.

**Dabing (`add_dubbing`, `worker/dub.py`)** – integrace PZ_AI_DAB_ALL (O:\ALLDUB) do MYpremiereMCP, bez Ollamy:
- Z ALLDUB zkopírováno (robocopy): `runtime/python311_xtts` → `tools/xtts/python311`, `.venv_xtts` → `tools/xtts/venv`
  (**`pyvenv.cfg` přepsán na novou cestu** – jinak „No Python at …“), `models` → `models/xtts` (xtts_v2 2,6 GB),
  `tools/ffmpeg`, `tools/rubberband`. `tools/xtts/xtts_server.py` = kopie serveru z ALLDUB (opravené dvojité kódování
  komentářů), cesty na MYpremiereMCP, port **7884** (ALLDUB má 7868), `XTTS_DEVICE`. `.gitignore`: jen server je v gitu.
- Tok: `timelineCues` (sdílené s titulky, s mluvčím repliky) → sloučení útržků do vět (nedokončená věta + pokračování
  do pauzy 2 s, krátké < 25 znaků) → `translate` → vzorky hlasů (`speakerSpans`: nejdelší promluvy mluvčího ~10 s)
  → XTTS klon (`speed` 1.1, ořez ~0,6 s ticha, které XTTS přidává za každou repliku) → když se nevejde do místa
  k další replice, rubberband do 1,4×, jinak mírný posun další repliky (nic se neuřízne) → mix se ztlumeným
  originálem (−15 dB, rampy) → `cache/dub/<sekvence>.<čas>.wav` (vlastní název pro každý běh – soubor v projektu
  Premiere drží) → host `placeAudio` na první prázdnou audio stopu (nebo stopu jen se starším dabingem) + mute původních.
- XTTS se spouští na GPU jen při volné VRAM ≥ 3,5 GB, jinak CPU (~7 s na repliku; vedle Hermese vždy CPU).
  Test 75 s sekvence (EN+RU): 9 replik, CPU 170 s, největší posun 1,1 s.
- **Kontrola srozumitelnosti** `scripts/dub-qa.py <cache/dub/složka>` (Whisper přepíše repliky a porovná s textem):
  0,51 → 0,68 po opravách. Na jednotlivých větách klon 0,84 ≈ vestavěný hlas 0,87 → klon zůstává (barva mluvčího).
  XTTS má pro češtinu limity výslovnosti (stejné zjištění jako v ALLDUB).
- Panel: tlačítko **„🎙 Nadabovat do češtiny“** + volba originál ztlumit/hodně/vypnout. Titulky i dabing běží
  **přímo bez AI agenta** přes `scripts/run-tool.mjs` (dřív titulky přes Clauda – kredity + čas).
- Vlastní dabing (`cache\dub`) se nepočítá jako zdroj řeči (jinak by se přepsal a přimíchal znovu).
- **Srozumitelnost 0,53 → 0,84** (upoutávka 18 replik, TEST DABING 9 replik):
  - Vzorky hlasu byly špatné: nejdelší segmenty = často křik z bojiště, hudba s halucinovaným slovem (1 „slovo“
    přes 24 s), jiný člověk ve stejném štítku diarizace. `speakerSpans` teď bere úsek od prvního do posledního slova,
    jen hustou řeč (≥ 1,5 slova/s) a řadí podle jistoty slov Whisperu × délky; vrací i `quality`. Pod 0,7 → mluvčí
    rovnou vestavěným hlasem (`fallbackSpeaker`).
  - **Samokontrola replik** (`xtts.verify`, `verifyMin` 0,75): Whisper (large-v3, beam 1, ~0,6 s/replika na GPU)
    přepíše každou repliku; při špatné shodě klon s jiným seedem → vestavěný hlas; nechá nejlepší (vestavěný jen když
    je o 0,05 lepší). Klon pod 0,5 → rovnou vestavěný. Mluvčí s opakovaně selhávajícím klonem mluví dál vestavěným
    (méně střídání hlasů). Log `dabing: pokus …` ve worker.log, výsledek `fallbacks`.
  - Hash úlohy dřív neobsahoval vzorky → po změně vzorků se použily staré repliky z cache (opraveno).
  - Temperature XTTS (0,1–0,75) nepomohla konzistentně (server ji nově umí: `temperature`, `top_p`, …).
  - Krátké repliky (≤ 4 slova) klon často zkomolí/přidá slabiky – vestavěný hlas je tam spolehlivější.
  - Zbytek chyb: jména (Fedja → „Fedia“ – chyba měření) a špatný zdrojový přepis křiku (ASR, ne překlad).
  - **Ořez blábolení na konci** (XTTS přidává slabiky „…roky kájo“, „ahoj“, „kit“): kontrolní Whisper (beam 5 –
    beam 1 slil blábolení s posledním slovem) s časy slov; konec = poslední slyšené slovo podobné poslednímu
    očekávanému (bez diakritiky, ≥ 0,6, mezi posledními 6 slovy) → uříznout +0,12 s a 30ms dozvuk. Přesná shoda
    slov uřízla skutečný konec („zbraň“ slyšeno „zbraně“) – proto podobnost. Kontrola běží i u mluvčího přepnutého na
    vestavěný hlas (dřív jediný pokus = bez kontroly).
  - **Repliky do 2 slov** („Vím.“) XTTS zkomolí a Whisper izolované slovo nepozná → namluví se s nosnou větou
    „A to je všechno.“, posoudí v kontextu a nosná věta se podle časů slov odřízne (bez ořezu → pokus se zahodí).
  - **Čísla**: porovnání textu s přepisem převádí číslice na česká slova (`_cs_number`) – Whisper píše „22“, dabing
    „dvacet dva“; dřív falešné neúspěchy a zbytečné pokusy. `dub-qa.py` používá stejné porovnání.
  - Překlad pro dabing (`translate` s `speech: true`): řadové číslovky slovy („3. brigáda“ → „třetí brigáda“),
    zkratky rozepsat. Zkratky (ChNUR) model stejně nechává – XTTS je čte foneticky skoro správně („snůr“).
  - Skóre (férové měření, beam 5): upoutávka 0,84, TEST DABING UA (26 replik, ukrajinsky) 0,89, TEST DABING
    Andrijivka 0,89 (dřív 0,53 / 0,81 / 0,68). Zbylé „chyby“ jsou hlavně měření (jména, nadávky z křiku, „zbraně“).
    Čas na CPU (GPU drží Hermes): ~10 s na repliku včetně kontroly.
  - `placeAudio`: nejdřív stopa se starším dabingem (smaže všechny starší dabingy), až pak prázdná; stopu odmutuje.
    (Pozor ExtendScript: v regexu `[\\/]` je syntax error – nutné `[\\\/]`.)

**Chyby nalezené cestou:** `add_captions force:true` prosakovalo do přepisu (→ nový přepis celého filmu v češtině,
index přepnut) – `timelineCues` teď předává přepisu jen jazyk; index filmu vrácen na `…cb1983e6318e.json`.
Při refaktoru jsem omylem přesunul část server/index.js (první výskyt řetězce byl v jiném nástroji) – obnoveno
beze ztráty (ověřeno diffem proti HEAD s/bez mezer); poučení: u velkých přesunů hledat v rámci konkrétního nástroje.

**Volba hlasu dabingu (2026-09-24):** `add_dubbing voice` = `"clone"` (výchozí, klon mluvčích) nebo jméno vestavěného
hlasu XTTS pro všechny repliky („Viktor Eka“, „Damien Black“, „Ana Florence“); `keepOld: true` = starší dabing
zůstane a nový jde na další stopu (porovnání). Panel: výběr „hlas“ + „nechat starý“. Test FINÁLNÍ TEST UA:
klon 0,89 vs. Viktor Eka 0,84 (klon na čistém materiálu vychází srozumitelněji i barvou).

**Test titulků po zrušení dabingu (2026-09-24)** – `scripts/srt-qa.py soubor.srt [znaků] [řádků]` (délka řádků,
předložka na konci, překryvy, < 0,7 s, > 7,5 s, rychlost čtení > 21 zn/s, osiřelé slovo, malé písmeno po konci věty).
Sekvence TT CZ přepis / TT CZ překlad / TT FILM přepis / TT FILM překlad (diskuse1.mp4 + film, se střihy):
výchozí 2×40 → 0 / 0 / 0 / 1 problém (dřív 1 / 1 / 5 / 12). Opraveno:
- překlad: skupina útržků do pauzy 5 s (dřív 2 s → „Ruské“ / „Síly jsou…“ přeloženo zvlášť), max 10 útržků (6 usekl
  souvětí → „kilometrů v“ / „posledních dnech“); dělení za předložkou zakázáno (postih 1000) i při dělení přeplněného
  titulku; text bez písmen („1.30“) se nepřekládá; přerostlý překlad (> 3× originál nebo „ / “ – model „přeložil“
  celý kontext) se přeloží znovu bez kontextu, jinak originál; limit znaků na skupinu (`maxLen` = max(originál,
  17 zn/s × doba řeči)) → překlad se zhustí (rychlost čtení 25 → ≤ 21 zn/s).
- všechny titulky: velké písmeno po konci věty / na novém klipu; rychlý (> 17 zn/s) nebo krátký (< 1 s) titulek se
  prodlouží do ticha (max +1,5 s, po další titulek a konec klipu); krátký nedokončený útržek před pauzou ≤ 3 s se
  spojí s pokračováním („Russian“ + „forces are dug in.“); dělení za čárkou jen když první část je aspoň z půlky plná.
- 1×30 znaků (extrém) u rychlého řečníka: 7 drobností (krátké titulky) – s tak krátkým řádkem nejde úplně vyhnout.
- Chyba nalezená testem: jednořádkový režim padal (index −1 v přesunu osiřelého konce) – opraveno.

## 14. Srovnání Hermes / Claude / GPT na filmu + redakční krok (2026-09-24)
Zadání (panel): „Sestříhej to nejdůležitější jako nejsrozumitelnější sdělení o válce na Ukrajině. do jedné minuty“,
film 2000 Meters to Andriivka (90 min, 708 vět). `scripts/compare-film.mjs` (SRC/OUT/TASK v env), výsledky
`test/agent-compare-film*/results.json`.
- **Chyba:** `local-edit.mjs` nepoznal délku slovy („do jedné minuty“) → plán bez cíle, 319 vět / 17 min. Opraveno
  (`targetSeconds`: „jedné minuty“, „minutu“, „dvě minuty“, „půl minuty“, „minuta a půl“, „třicet sekund“…).
- 1. kolo: GPT-6-Astra 8/10 (vypravěčský oblouk, 348 s, ~770 tis. tokenů), Claude 5/10 ($0,145, 165 s),
  Hermes 4/10 (143 s) – Hermes i Claude (přebírá lokální návrh) vybrali ruské výkřiky z bojiště.
- **Redakční krok v `plan_edit`** (fáze `edit`): když kandidáti > 3× cíl, model dostane celky s textem a délkou
  a sestaví střih jako celek (úvod – jádro – pointa, souvislý komentář, bez výkřiků/útržků); vybrané mají při
  dorovnání přednost, zbytek jde do náhradníků. 1 volání (~7,5 tis. tokenů, ~12 s). `continues()` bere i začátek
  interpunkcí („.s officials say“ = rozdělené „U.S.“).
- 2. kolo: Hermes – oblouk „největší operace od 2. sv. války → les → boj → ztráty → protiofenzíva selhávala →
  zbylo jen jméno“ (126 s); Claude – souvislý vypravěč bez výkřiků, 68 s, $0,20, 303 s.
- Panel: Codex výchozí **GPT-5.6-Sol** (Astra „(drahé)“ jen volitelně; localStorage klíč `pmcp.model.codex.v2`).

### 14b. Mistrovský střih – noční ladění (2026-09-24/25)
Plán `plan_edit` má nově pro dlouhý materiál vs. krátký cíl (kandidáti > 2× cíl) tyto kroky:
1. **Teze** (fáze `thesis`, 1 volání): z osnovy jedna věta „co má střih divákovi předat“ + kapitoly úvod/pointa.
   Věty klíčových kapitol se přidají mezi kandidáty (výběr po oknech pointu filmu nevybral – nevidí celek).
2. **Filtr výkřiků** (bez LLM): celky ≤ 6 slov nebo s „!“ ≤ 10 slov ven (ne u zadání „atmosféra/akce/emoce“).
3. **Redakce** (fáze `edit`): kandidáti s nadpisy kapitol, tezí a podílem řeči mluvčích (pozná vypravěče);
   model napíše osnovu a vybere celky; když přestřelí (> 1,3× cíl), až 2× sám zkrátí. Pointa povinná
   (chybí-li úsek z pointové kapitoly, doplní se). Vstup + 1 úsek pointy chráněné (skóre 4).
4. **attach_context** (bez LLM, do celku, před dorovnáním i na konci): začátek souvětí řetězově, pokračování
   malým písmenem, krátká předchozí věta u věty odkazující dozadu („how is THIS possible?“, „It's who they are“).
5. **trim**: chráněné úseky až úplně nakonec; když nejde vyhodit nechráněný bez pádu pod lo, radši +9 %.
- Nalezené chyby: `"\b"` přes heredoc v souboru jako znak backspace (regex nikdy nechytil) – píš Python
  úpravy přes soubor (Write), ne heredoc; `trim` vyhazoval pointu (nejkratší „nejbližší k cíli“);
  zkracovací smyčka omylem za `break`.
- Výsledky (Hermes): People's Fight 1 min – oblouk „válka za pár dní → jak je možné, že vzdorují → drony →
  stínová armáda dobrovolníků… nevzdají se“ (= úroveň GPT); Claude na něm 9/10 ($0,12).
  Sada filmů `scripts/test-plan-films.mjs` (upoutávka 30 s 7/10, dobrovolníci 8,5, příběh 7,5, drony 6,5,
  cena 7) – délky ±2 %, 0 useknutých. Rychlý náhled: `scripts/plan-review.sh <zdroj> "<zadání>" <s>`.
- Claude: `reviewText` ukazuje tezi a „redakčně složeno“; `agent-system.md`: vstup/pointu neměnit, jen vady.

### 14c. Ladění Hermese na nové debatě (2026-09-26)
Nové video `test/fresh/debata-nova.mp4` (42 min, 389 vět, Ferancová vs. Vašíř), zadání „hlavní spor obou
kandidátů – v čem se zásadně liší a co si vyčítají“, cíl 120 s. Referencí byl ruční výběr: #53 (město stojí
na místě) → #43–46 (zastavená parkovací politika, ¾ mil. za kampaň, „za to by se dal předláždit chodník“)
→ #314–319 (obhajoba: systém nebyl připravený) → #256/257 (ideový rozdíl jako pointa).

**Čtyři nalezené příčiny (všechny měřené, ne odhadem – diagnostika `PLAN_DEBUG=<soubor>` vypíše celky,
které redakce dostala, její osnovu a výběr; bez toho jsem to dvakrát hádal špatně):**
1. **Slabé věty vs. „nejlepší v kapitole“** – osnova označí #43 za nejsilnější větu kapitoly *i* za slabou
   („přeřeknutí“), prompt pak říkal „bez přeřeknutí“ → nejostřejší výrok vypadl. U tohohle materiálu navíc
   „přeřeknutí“ bývá jen chyba přepisu („zpuštěním“, „tři stvrti milionu“). Nově `_weak_note()`: *nepoužitelné*
   (vata, nesrozumitelné, opakování) vs. *drobná vada* (vyber, když obsah sedí); věta z `best` se neoznačí vůbec.
2. **Vztahové zadání jako pseudo-téma** – „hlavní spor / rozdíly / výčitky“ se vracely jako témata a kontrola
   tématu pak vyhodila konkrétní důkazy sporu. `_instruction_topics` je filtruje (seznam `meta`).
3. **Pozor na záměnu „bez tématu“ = „přehled“** – první verze opravy nastavila `general=True`, což zapne
   `over_chapter` (trestá víc úseků z jedné kapitoly) → výběr se rozprostřel tence přes 30 kapitol. Proto nový
   příznak `relational`: téma se nekontroluje, ale výběr se *neroztahuje*.
4. **Redakce sbírala bloky místo výběru** – ze 180 celků vybrala 52 (3× cíl), zbytek dořezal mechanický trim
   a vyhodil právě ty krátké úderné. Model teď dostává konkrétní **počet úseků** (`target / medián délky`)
   a pravidlo, že kapitola označená „(klíčová)“ musí být zastoupená konkrétním výrokem (číslo, jmenovaná věc).
5. **Mechanika pořadu jako „vstup s kontextem“** – model otevíral střih moderátorovou znělkou („Začíná další
   vydání pořadu…“, „Magistrát má 45 členů“). Zákaz v promptu **nefungoval** (zkoušeno, vybral je znovu), proto
   deterministicky: u pořadu se 3+ mluvčími se do redakce nenabízejí moderátorovy věty **bez otazníku**
   (mechanika), otázky zůstávají – když se vybere odpověď, `complete()` otázku doplní zpět.

**Stav:** délka sedí (119 s / 120, u tématu 89,9 / 90), veškerá mechanika pořadu je pryč, do střihu se dostávají
konkrétní výtky s faktem (#304/305 – parkovací automaty roky ve skladu, propadlá záruka). **Úroveň Claude to
ještě není:** začátek občas útržek (#55 „Neschopnosti města víc vstříc…“ – Whisper rozdělil jednu větu na #54+#55
a druhá půlka začíná velkým písmenem, takže `continues()` ji nechytí) a u vztahového zadání převáží jedna strana
(Ferancová ~75 s ze 119). **Další krok:** vyvážení stran u `relational` zadání a detekce falešného rozdělení věty
(první slova druhé půlky opakují poslední slova první).

**Pokračování (stejný den):** doplněno ještě
6. **Vyvážení stran u `relational`** – u sporu sklouzával střih k souvislému programu jedné strany
   (Ferancová 75 s ze 119). Prompt dostal pravidlo „obě strany zhruba stejně, tvrzení–protitvrzení,
   konkrétní výtka má přednost před popisem vlastního programu“; strany se teď střídají.
7. **Povinné zastoupení klíčových kapitol** (rozšíření dosavadního pravidla o povinné pointě): když model
   kapitolu označenou za klíčovou úplně vynechá, doplní se z ní jeden úsek – přednost má úsek s číslem
   (konkrétní výtka unese víc než obecná věta). **Pozor:** poprvé to vtáhlo zpět znělku pořadu, protože
   kapitola „Úvod a hosté pořadu“ bývá klíčová (vstup) a její věta končí otazníkem, takže prošla i filtrem
   mechaniky – proto se do vynucení nepouští moderátor.

**Stav po iteraci:** vztahové zadání 119 s/120, žádná mechanika pořadu, rozumný vstup (#57 pojmenuje problém),
strany se střídají, pointa #382. Tématické zadání 89,9 s/90, bydlení i parkování vyvážené. **Zbývá:** #43–46
(zastavená parkovací politika, ¾ mil. za kampaň) se trefí jen tehdy, když thesis označí K5 za klíčovou – ta ale
vrací jen kapitoly *úvod* a *pointa*, ne „nejdůležitější pro zadání“. Nabízí se doplnit mezi klíčové i kapitoly
s nejvyšším skóre relevance (v `why` jsou K-skóre 0–3, K5 mívá 3).

## 15. Hermes přestěhován do projektu (all-in-one) (2026-09-28)
Uživatel chtěl, aby projekt nebyl závislý na samostatné instalaci v `O:\Hermes`. Přeneseno **jen to, co
projekt potřebuje** – server a model, ne celá asistentská aplikace:
- `models/hermes/` – `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (22,4 GB) + `mmproj-…-F16.gguf` (0,9 GB); velikost
  ověřena bajt na bajt proti zdroji.
- `tools/llama.cpp-hermes/` – vlastní llama.cpp **build 11118** (novější než projektový b10984, Qwen3.6
  potřebuje `--n-cpu-moe` a `--reasoning-budget`), proto vedle stávajícího, ne přes něj.
- `hermes/`, `chrome-profile/`, `cron`, `dashboard` z O:\Hermes se **nekopírovaly** – to je samostatná
  asistentská aplikace uživatele, do střihového projektu nepatří.
- `scripts/hermes.ps1 start|stop|status` (+ `-Vize` pro mmproj) – spouští server ze složky projektu
  s ověřenými parametry z původního `switch-llm.ps1` (30 ze 40 MoE vrstev v RAM = vejde se do 12 GB VRAM).
  Zabíjí **jen vlastní** proces (podle cesty), takže Ollama ani cizí Hermes nejsou dotčené.
- `config.json` → `llmBackends.hermes` má nově `server`/`modelFile`/`mmproj`/`start`; Worker ho dál **sám
  nespouští** (na 12GB GPU by se pral s Whisperem) – to je záměr, ne opomenutí.
- `INSTALL/install.ps1` krok [7b]: Hermese vezme z offline balíku, když tam je (stahovat 22 GB nemá smysl).
- `models/` i `tools/` jsou v `.gitignore`, takže do gitu nic z toho nespadne.

**Past, na kterou jsem narazil:** `scripts/hermes.ps1` napsaný s diakritikou a bez BOM PowerShell 5.1 načte
jako ANSI a skript spadne na „The string is missing the terminator“. Projekt má proto konvenci psát `.ps1`
**bez diakritiky** (stejně jako `install.ps1`). Pozor na zrcadlový případ: JSON naopak BOM **nesmí** mít (5z).

**Ověřeno naostro:** binárka běží (`--version`), model se načte z cesty v projektu a odpovídá česky
(test na CPU na jiném portu, aby se nesahalo na běžící server uživatele); pak přepnuto na ostrý režim –
externí Hermes zastaven, `scripts/hermes.ps1 start` naběhl na portu 8000, `worker_status` ho hlásí jako
`running: true` a `plan_edit_local` přes něj postavil v Premiéře sekvenci „HERMES ALL-IN-ONE test“
(91,5 s / cíl 90). Zpět na původní instalaci se lze kdykoli vrátit přes `O:\Hermes\switch-llm.ps1`.

### 15b. Hermes přidán i do offline balíku (2026-09-28)
Na dotaz „půjde to nainstalovat na jiném PC a bude tam Hermes?“ – původně ne: balík měl 16 GB (Whisper,
gemma3, vision, wheels, node_modules), Hermes v něm chyběl a přenesl by se jen s celou složkou projektu.
Doplněno na přání uživatele:
- `INSTALL/offline/models/hermes` + `INSTALL/offline/tools/llama.cpp-hermes` (velikosti ověřeny proti
  originálu), balík je teď **37,8 GB**.
- `install.ps1`: kontrola místa připočte ~24 GB, **jen když** je Hermes v balíku a neběží se
  s `-NoLocalLLM`/`-SkipModels` (hlásí „potreba ~39 GB“). Krok [7b] ho zkopíruje z balíku; stahovat se
  nezkouší (22 GB z HuggingFace nemá smysl).
- `INSTALL/README.md`: tabulka obsahu + poznámka, že se Hermes po instalaci **sám nespouští**
  (`scripts\hermes.ps1 start`) a že bez ~12 GB VRAM je na CPU prakticky nepoužitelný (~9 tok/s) – tam
  je lepší nechat plánovat gemma3 nebo Clauda.

**Co se po instalaci na cizím PC napojí samo:** `register.mjs` zaregistruje MCP server do Claude Code
(`claude mcp add --scope user`), Claude Desktop i Codexu, pokud tam jsou; `mcp.json` se přegeneruje na
skutečnou cestu (to byla původní příčina z 5z). **Co samo nepojede:** Node.js 18+ a Python 3.11 musí být
na stroji předem a Hermes se spouští ručně.

## 16. Test na anglickém dokumentu odhalil dvě systémové pasti (2026-09-28)
Uživatel pustil v panelu na film *Vladimir Putin: Power, Greed, Obsession* (57 min, **anglicky**) zadání
„vyber ze všeho 3 minuty to nejpekelnější/nejstrašnější o Rusku a Putinovi", cíl 180 s, backend Hermes.

**1. Panel přepsal cizojazyčný film s vynuceným `language: "cs"` → Whisper místo přepisu překládal.**
Výsledek byl strojově rozbitý („Ekonomická inteligence unita" = Economist Intelligence Unit, „dostane si
slovo slovo slovo", 4 zacyklené věty). Hermes tedy dostal nepoužitelný vstup a jeho výběr nešlo hodnotit.
Po přepisu s `language: ""`: jazyk správně `en`, **552 vět / 8 432 slov místo 493 / 6 203 (+36 % obsahu)**,
0 zacyklených vět. CLAUDE.md na to pravidlo má, ale panel jede na výchozí `cs` z `config.json`, takže
**u každého cizojazyčného materiálu to nastane samo** – stojí za zvážení autodetekce (nebo varování),
ne jen pravidlo v instrukcích.

**2. Běžící Hermes zablokuje přepis.** Whisper na CUDA zůstal viset na 4 % (GPU 11,7/12,3 GB, 100 % využití,
paměť držel llama-server). Po `scripts\hermes.ps1 stop` doběhl zbytek (49 % → 100 %) do ~30 s. Tj. pořadí
musí být: přepis → teprve pak Hermes. Odpovídá to poznámce v `config.json`, proč Worker Hermese neřídí,
ale v praxi to znamená, že si uživatel musí pořadí hlídat sám.

**Vedlejší nález:** zdrojové MKV je poškozené (ffmpeg: „invalid as first byte of an EBML number“ na pozici
1,686 GB z 1,765 GB = 95 % souboru), což přesně odpovídá chybě Premiéry „Frame substitution recursion …
Inserting black for frame number 84838“ (84838/25 fps = 56,5 min z 59,4). Přebaleno `-c copy` do MP4
(plná délka 59:23,75 zachována). Druhý film (x265 MKV) přebalen taky, s `-tag:v hvc1` kvůli Premiéře.

**Rozložení výběru (na starém přepisu, jen orientačně):** 15 z 16 klipů z prvních 11,5 min filmu, pak jediný
skok na 46:21 – zbylých ~60 % stopáže nezastoupeno, přestože zadání znělo „ze všeho“. Ověřit znovu na
opraveném přepisu.

### 17. Zastaralá analýza po novém přepisu (opraveno) + pád Premiéry na poškozeném MKV

**Chyba:** `cache/analysis/index.json` je klíčovaný jen cestou ke zdroji. Když se zdroj přepíše znovu
(jiný `language`, `force`), index pořád ukazuje na analýzu postavenou nad STARÝM přepisem. `get_outline`
pak vrátil osnovu s ID vět ze starého přepisu (493 vět, cs), zatímco `get_transcript` už vracel nový
(552 vět, en) – čísla vět si neodpovídala a střih podle takové osnovy by řezal úplně jiné věty.
Selhání je tiché, nic se nezobrazí jako chyba.

**Oprava:** `server/index.js` – nový `loadAnalysis(source)` porovná `analysis.transcript` s přepisem,
na který ukazuje aktuální index; při neshodě vrátí `null` a `get_outline` řekne „není analýza
k aktuálnímu přepisu“. Analýzu tedy raději zahodíme, než abychom nechali stavět podle posunutých ID.

**Pád Premiéry:** při práci se sekvencí nad `vladimir.putin...cbfm.mkv` Premiere spadla
(„došlo k chybě a musí být ukončen“), dřív hlásila „Inserting black for frame number 84838“.
Sedí to na poškození MKV na pozici 1 686 128 355 B. Přebalený `vladimir.putin.power.greed.obsession.2022.mp4`
má stejnou délku (3563,75 s) a je o 73 MB menší. Pro takové zdroje stavět sekvence z přebalu, ne z originálu.
Přepis se znovu nedělá – stačí do `cache/transcripts/index.json` a `cache/analysis/index.json` přidat
klíč s cestou k přebalu ukazující na stejný JSON (časy jsou identické, je to stream copy).

**Dovětek (19:05):** poškození se přeneslo i do přebaleného MP4 (stream copy) – ffmpeg hlásí chybu dekódování
jen v okně 3390–3394 s, zbytek filmu čistý. Druhý pád Premiéry nastal při `build_sequence_from_transcript`
se `sceneCuts`, kde poslední věta #552 končila na 3392,3 s – tedy uvnitř poškozeného okna. Řešení: překódovat
video (h264_nvenc, `-c:a copy`, `-fps_mode passthrough` – časy se nemění, přepis zůstává platný).
Pozor: první pokus o překódování spadl, protože disk D: byl úplně plný (68 KB) – výstup psát na disk s místem
a před dlouhým kódováním zkontrolovat `df`.

### 18. Titulky s překladem blikaly útržky + Hermes u „otřesného" zadání volil techniku (2026-09-28 večer)

**Titulky (`add_captions` s `translate`):** překlad se rozkládal do původních anglických titulků, které jsou při
krátkém řádku (20 znaků, 1 řádek) jen 1–3 slova a zlomek sekundy. Výsledek na Putinovi: 21 ze 143 titulků přes
limit znaků, 36 kratších než 0,7 s („že" 0,15 s). Kontrola délky navíc přeskakovala titulky do 3 slov.
**Oprava:** skupina se rozdělí na bloky po klipech (přes střih nikdy), překlad se mezi bloky rozdělí podle délky
originálu (`splitByWeights`) a každý blok se znovu zalomí do titulků ≤ limit (`reflowCue`, DP – co nejméně
titulků, vyrovnaně, radši za interpunkcí, nikdy za „v"/„k"). Časy podle znaků přes úseky, kdy v bloku zněla
řeč. Ověřeno živě na Hermesově sekvenci: 0 přes limit, 2 krátké, 0 překryvů.

**`scripts/run-tool.mjs`:** MCP SDK (`StdioClientTransport`) předává serveru jen pár systémových proměnných –
`PLAN_DEBUG` se proto k workeru nikdy nedostal (ladicí výpis „nefungoval"). Teď `env: process.env`.

**Hermes – režim „otřesné zadání"** (`intense` v `plan_edit`, spouští ho otřes|strašn|pekeln|krut|drastic|
brutál|šokuj|děsiv|hrůz|horor; samotné „nejsilnější" NE – u debaty to znamená argumenty). Diagnóza přes
PLAN_DEBUG na Ukraine from Above: svědectví (E40, Buča, Mariupol) redakce dostala, ale teze vyšla obecná
(„asymetrický boj… technologie"), model vybral souvislé bloky o dronech a zkracování pak vyhodilo E40.
Filtr výkřiků (≤ 6 slov) navíc vyhodil „That person was shot." a „Some appear to have been executed."
Změny jen při `intense`: teze = to nejhorší, co materiál dokládá; redakce řadí podle dopadu na diváka, více
různých událostí, ne jeden blok; zkracování vyhazuje nejdřív techniku; krátké oznamovací věty (3–6 slov
s tečkou) filtr výkřiků nechá.

### 19. Skutečná příčina pádů 2 a 3: tichá záměna zdroje (opraveno) + export s titulky

`build_sequence_from_transcript` / `build_sequence_without_pauses` mají parametr `source`, ostatní nástroje `path`.
Volání s `path` (neznámý klíč → zod ho zahodí) spadlo do `singleTranscribedSource()` → `lastSource` = naposledy
čtené poškozené MKV. Sekvence „opraveny zdroj" tak ve skutečnosti stály na MKV a Premiere na něm padala.
**Oprava:** `path` je u obou nástrojů synonymum `source`; když se zdroj dohledá, výsledek to hlásí v poli `source`.
Projekt: položka MKV přepojena `changeMediaPath` na `O:\DETAIL\premiere\zdroje\vladimir.putin.2022.fixed.mp4`
(s dopřednými lomítky vrací false – nutná zpětná; záloha `backups\testicek2.2026-09-28T20-10-34-634Z.prproj`).

**Export s vypálenými titulky:** výchozí export preset vypálí i nativní CC stopu – s vlastním SRT přes ffmpeg pak
byly titulky dvoje. Minutová verze proto složena ffmpegem přímo ze zdroje podle in/out z `get_sequence`
(trim/atrim + concat + subtitles, 25 fps nativně – sekvence v Premiere měla 23,976) → `Downloads\PEKLO_1min_Putin_titulky.mp4`.
Titulky do obrazu ručně redigované (strojový překlad: „barvy otravy zářením" z ASR „dyes" místo „dies",
„otrávíš se" místo „otráví tě", rozbitá věta o „zakládajícím zločinu").
**Překlad titulků – `maxLen`** teď 17 zn./s i pod délku originálu (min 60 %); Hermes limit u rychlé pasáže
přesto nedodržel (71 požadováno, ~100 dodáno) – zhušťování lokálním modelem zatím nespolehlivé.

### 20. MKV → MP4 automaticky před Premiere (2026-09-29)

Uživatel: Premiere padá už při samotném importu MKV (x265 filmy s obalem jako mjpeg stopou a SubRip titulky).
**`worker/media.py`, úloha `prepare_media`** (PyAV z venv – funguje i bez ffmpeg v PATH): MKV/WebM → MP4 v
`cache/media/<klíč>/<název>.mp4` (položka v Premiere má jméno filmu). H.264/HEVC se jen přebalí (HEVC s tagem
`hvc1`), zvuk ne-AAC → AAC, obal/titulky se vynechají. Když demux hlásí chybu (PyAV má log FFmpegu ve výchozím
stavu VYPNUTÝ – nutné `av.logging.set_level(ERROR)`, jinak Capture nic nechytí), obraz se překóduje (h264_nvenc,
fallback libx264), pts zachovány. Změřeno: čisté x265 59 min přebalení 13 s; poškozený Putin 6 min 15 s,
v okně 3380–3405 s 0 chyb dekódování, PSNR proti originálu ~42 dB ve 3 časech (políčka sedí).
`cache/media/index.json` mapuje převedený soubor na originál.
**Server:** `premiereMedia()` na všech vstupech do Premiere (buildAndReport vč. extra audia, detectSceneCuts,
import_media, multicam buildTimeline). `originalMedia()` v `transcribe()`/`loadTranscript()` – přepis se hledá u
originálu (titulky nad sekvencí z převedeného MP4 nespustí nový přepis).
**Panel:** tlačítko „🎬 Vložit video…“ (výběr souborů → `import_media` přes run-tool). Ověřeno živě: MKV přes
import_media → v projektu MP4, Premiere běží. Po úpravě panelu nutné panel zavřít a otevřít.
Pozor na místo: převedené filmy leží na O: (1,4–4 GB kus).

**Změna 2026-09-29 (přání uživatele): převedené MP4 se ukládá VEDLE ORIGINÁLU** (`<název>.mp4`). Cizí stejnojmenný
soubor se nepřepíše → `<název> (převedeno).mp4`. Když na disku originálu není místo (velikost × 1,3 + 1 GB – D: měl
2,2 GB) nebo složka není zapisovatelná, jde do `cache/media` a výsledek to hlásí (`fallback`). Starší převody
v `cache/media` se dál používají (projekty se na ně odkazují). Nedokončený `.part.mp4` se při chybě smaže.
Ověřeno: vedle originálu, opakované volání z cache, fallback u plného D:, cizí MP4 nepřepsáno.

### 21. Jazyk přepisu, převedená média v plánech, upoutávky, panel (2026-09-29)

- **Automatická kontrola jazyka** (`asr._probe_language`): když zadání jazyk neurčí, 4 ukázky po 30 s (10–85 %
  délky) přes `detect_language`; převažuje-li jiný jazyk než výchozí `cs`, přepis běží po úsecích. Důvod:
  Robin Hood (EN, 2 h) s vynucenou češtinou = 1857 slov nesmyslů, Gummo taky. Česká debata zůstává `cs`
  (4/4 hlasy), ~1 s. Staré špatné přepisy se samy nepřepíšou – `transcribe_media` s `language: ""`.
- **Převedené MP4 → originál i ve workeru** (`common.original_media`, dispatcher v `worker/server.py` mapuje
  `params.path` u všech úloh kromě `prepare_media`) a v serveru (`loadIndexed`, `loadAnalysis`). Panelový Hermes
  nad sekvencí z převedeného Gumma hlásil „neexistuje přepis“.
- **Upoutávka ≠ téma:** styl („akční“, „upoutávka“, „dynamický“, „napětí“…) se nebere jako obsahové téma
  (Robin Hood: téma „akce“ vyřadilo 34 vět → 37 s z 60; teď 60,8 s). Režim `trailer`: hák, krátké údery,
  neprozrazovat konec, nekončit pointou, nepřidávat povinnou pointovou kapitolu, do výběru jen úseky ≤ 8 s
  (Gummo: dřív 11s monology, teď 28 úderů po 1–4 s).
- **Panel:** zrušena Záložní varianta (ChatGPT), drag & drop souborů (celý panel, zvýrazní řádek Vložit video;
  cesta z `File.path`, jinak `text/uri-list`, jinak hláška s typy), tlačítka `nowrap` a akční trojice se
  zalamuje jako celek. Horní bílou lištu s křížkem kreslí Premiere u plovoucího panelu – z rozšíření nejde měnit.
- **INSTALL_SMALL** (online instalace z GitHubu) + `install.ps1 -Hermes`; instalace z TEMP neregistruje MCP
  (zkušební instalace zapsala do Claude Desktop dočasnou cestu – vráceno).

### 22. Obraz pod dodatečně namluvený komentář (dabing / voiceover) – 2026-10-05

Uživatel nahrál 4K plochu (After Effects + Premiere přes Claude), pak v Premiere namluvil komentář (samostatný
`Audio 1_3.wav`) a chtěl obraz „aby odpovídal tomu, o čem mluví“. Panelový Hermes vzal za zdroj záznam obrazovky
(bez řeči) → „vybráno 0 vět“. Nové:
- `worker/broll.py`: `broll_index` (klíčové snímky → sloučení statických míst do záběrů → popis vision modelem:
  Hermes s viděním, při chybě vlastní Qwen3-VL; archy 4×3 pro agenty, kteří vidí obrázky; cache `cache/broll`),
  `broll_plan` (LLM jen kandidáti ke každé větě podle obsahu + deterministické `_assign`: ~1 záběr / 5 s,
  bez opakování – jedním tahem model šel po pořadí čísel a bral jen jeden záznam), `media_info`.
- Server: `index_broll` (text + volitelně archy jako obrázky), `build_voiceover_sequence` (komentář beze změny na A1,
  video-only klipy přes host `buildTimeline`, střih 0,25 s před větou; `segments` od agenta nebo automaticky).
  Komentář = zvukový klip, jehož zdroj nemá v sekvenci obraz. Zdroje ke komentáři se pamatují
  (`cache/broll/voiceover-sources.json`) – hotová sekvence obsahuje jen vybrané záběry.
- `scripts/local-edit.mjs` (panelový Hermes): pozná dabing (samostatný komentář + obraz bez řeči, nebo slova
  komentář/dabing/namluv/„o čem mluvím“) a volá `build_voiceover_sequence`.
- Návod pro agenty: CLAUDE.md, AGENTS.md, panel/agent-system.md, instrukce MCP serveru.
Ověřeno: agentní cesta (Claude, 22 segmentů) → „PREZENTACE – obraz podle komentáře“ 2:16,36; automatická (Hermes)
→ 22 záběrů ze 3 záznamů, 26 s z cache (popis 75 záběrů poprvé ~9 min; Hermes jednou timeoutoval → Qwen3-VL).
