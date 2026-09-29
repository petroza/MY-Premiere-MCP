# MY Premiere MCP

Střih v Adobe Premiere Pro pomocí Claude (Claude Code / Claude Desktop) nebo Codex (GPT):
**střih podle toho, co kdo říká** (český přepis s časy slov), **automatický střih více kamer podle mluvčího**
a **lokální porozumění dlouhému materiálu**, které šetří kredity. Vše běží na tomhle PC, bez Ollamy a bez cloudu.

```
Claude / Codex ──stdio──► server/index.js (MCP) ──HTTP :7880 + token──► CEP panel ──► host.jsx (ExtendScript v Premiere)
                                   │
                                   └──HTTP :7881 + token──► worker/server.py (lokální Worker, fronta úloh)
                                                              ├─ faster-whisper large-v3 (CUDA)      přepis + časy slov
                                                              ├─ sherpa-onnx pyannote + WeSpeaker    kdo kdy mluví
                                                              ├─ FFT korelace zvuku                   synchronizace kamer
                                                              └─ llama-server + gemma3 12B (CUDA)    kapitoly, slabá místa, plán střihu
```

## Instalace
```powershell
powershell -ExecutionPolicy Bypass -File O:\MYpremiereMCP\install.ps1
```
Vše se ukládá do složky aplikace: `.venv` (Python 3.11), `models/` (Whisper, diarizace, LLM), `tools/llama.cpp`.
Pak restartuj Premiere a otevři **Okno > Rozšíření > MY Premiere MCP**. Worker se spouští sám při prvním použití.

| Model | Složka | Velikost |
|---|---|---|
| Whisper large-v3 (CTranslate2) | `models/whisper-large-v3` | 2,9 GB |
| pyannote segmentace 3.0 (ONNX) | `models/diarization/sherpa-onnx-pyannote-segmentation-3-0` | 6 MB |
| 3D-Speaker CAM++ zh/en advanced (ONNX, hlasové otisky) | `models/diarization` | 27 MB |
| gemma3 12B Q4_K_M (GGUF) | `models/llm` | 6,8 GB |
| llama.cpp b10984 CUDA 12.4 | `tools/llama.cpp` | 1,1 GB |
| Hermes – Qwen3.6-35B-A3B Q4_K_XL + mmproj (GGUF) | `models/hermes` | 21,7 GB |
| llama.cpp build 11118 (pro Hermese) | `tools/llama.cpp-hermes` | 1,1 GB |

### Hermes (silnější lokální model)
Kvalitnější lokální plánování střihu (`plan_edit_local`) než gemma3. Je součástí složky projektu, spouští se ručně:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\hermes.ps1 start     # textově
powershell -ExecutionPolicy Bypass -File scripts\hermes.ps1 start -Vize   # + vidění (mmproj)
powershell -ExecutionPolicy Bypass -File scripts\hermes.ps1 stop|status
```

Běží na `127.0.0.1:8000`; `plan_edit_local` si ho vezme sám, jakmile odpovídá (`backend` se nezadává).
Worker ho **záměrně nespouští ani nevypíná** – na 12GB GPU by se pral s Whisperem o paměť. Nastavení je
ověřené: 30 ze 40 MoE vrstev v RAM, zbytek na GPU (~42–54 tok/s); automatické `--fit` na Windows VRAM
přeplní a rychlost spadne na ~10 tok/s.

## Použití
Příklady zadání (panel v Premiere, `claude` v terminálu, Claude Desktop):
- „Přepiš rozhovor, rozpoznej mluvčí a udělej 3minutovou verzi o cenách. Ať to dává smysl."
- „Tady jsou 3 kamery a zvuk od zvukaře – sestříhej to automaticky podle toho, kdo mluví."
- „Hodinový materiál: udělej osnovu a navrhni střih lokálně, ať nepálíme kredity."

Zadání jde i nadiktovat – tlačítko 🎤 v panelu nahraje řeč a lokálně ji přepíše (stejný Whisper jako na video, žádný cloud).

### Dlouhý materiál a kredity
1. `transcribe_media` + `diarize_media` / `speakerTracks` + `rename_speakers` – vše lokálně.
2. `analyze_transcript` – lokální LLM vrátí **kompaktní osnovu** (kapitoly, shrnutí, nejsilnější a slabé věty).
   Claude pracuje s osnovou (stovky tokenů místo desítek tisíc) a plný text čte jen u vybraných kapitol
   (`get_transcript` s `format: "compact"`).
3. `plan_edit_local` – plán střihu lokálním modelem (Hermes/Qwen3.6-35B, když běží, jinak vlastní gemma3):
   hodnocení kapitol, výběr vět, kontrola tématu, vyvážení mluvčích a témat, dorovnání na cílovou délku (±3 %).
   S `format: "review"` vrátí krátký návrh s texty vět a náhradníky – **hybrid**: lokální model navrhne, Claude
   jen zkontroluje a postaví (změřeno ~4–5× levnější než vlastní čtení kapitol, stejná kvalita). S `build`
   postaví sekvenci úplně bez Claude (panel → „Hermes (lokálně, zdarma)“).

Panel spouští Claude v úsporném režimu (`--tools=ToolSearch --effort medium` + krátký prompt
`panel/agent-system.md`): popisy nástrojů se načítají až na vyžádání. Typický 3min sestřih hodinového
materiálu ~1 min a ~$0,10–0,16 (původně ~2 min a $0,85). Celá cesta u nového 42min videa (přepis, mluvčí,
osnova, plán, sekvence) ~5 min.

### Titulky a překlad titulků (cizojazyčný materiál)
- Přepis vícejazyčného videa: `transcribe_media` s `language: ""` – jazyk se zjišťuje po úsecích (film EN+UK+RU).
- `add_captions` s `translate: "cs"` – titulky rovnou česky (překlad lokálním modelem po celých větách, časy z řeči).
  V panelu tlačítko „💬 Přidat titulky“ s volbou „jen přepis“ / „překlad do češtiny“ – běží přímo bez AI agenta, zdarma.

### Více kamer
`build_multicam_sequence`: reference = hlavní zvuk, kamery `{source, role: wide|close, speakers:[jméno]}`.
Offsety kamer se dopočítají ze zvuku, obraz se přepíná na detail mluvčího (s náběhem 0,3 s), překryv řeči
a delší ticho jdou do celku, monology delší než 14 s se prostřihnou, nejkratší záběr 1,8 s.
Výsledek je obyčejná sekvence (V1 = obraz kamer bez jejich zvuku, A1 = hlavní zvuk) – dá se dál ručně upravit.
`dryRun: true` vrátí plán bez Premiere; `picks` kombinují střih příběhu s přepínáním kamer.

## Nástroje (43)
| Skupina | Nástroje |
|---|---|
| Stav a projekt | `premiere_status`, `get_project`, `list_project_items`, `import_media`, `save_project`, `undo`, `worker_status`, `job_status` |
| Sekvence | `get_sequence`, `open_sequence`, `set_playhead`, `add_markers`, `get_markers`, `export_sequence` |
| Přepis a mluvčí | `transcribe_media`, `transcribe_sequence`, `get_transcript`, `search_transcript`, `find_pauses`, `diarize_media`, `rename_speakers` |
| Porozumění (lokálně) | `analyze_transcript`, `get_outline`, `plan_edit_local` |
| Obrazová analýza | `get_frame` (vrátí snímek jako obrázek – pro Claude vidění), `describe_frame` (popis lokálním vision modelem Qwen3-VL, zdarma) |
| Externí AI (ChatGPT apod.) | `export_analysis` (jeden samostatný .md soubor – instrukce z `EXTERNI_AI_INSTRUKCE.md` + osnova + přepis, stačí vložit celý do ChatGPT v jedné zprávě), `build_from_plan` (sestříhá podle JSON plánu, co AI vrátí) |
| Střih (nedestruktivní) | `build_sequence_from_transcript`, `build_sequence_without_pauses`, `build_sequence`, `build_multicam_sequence`, `sync_media` |
| Detekce střihu (obraz) | `detect_scene_cuts` (najde skutečné vizuální řezy kamer zapečené v jednom zdroji – Premierina Scene Edit Detection, jen na výslovné přání) |
| Titulky | `add_captions` (titulky z přepisu podle timeline, s `translate` rovnou přeložené do češtiny) |
| Střih (destruktivní) | `remove_timeline_ranges`, `razor`, `remove_clips` |
| Vývoj | `run_extendscript`, `reload_bridge` |

## Konfigurace
- `config.json` – porty, cesty k modelům, Whisper, LLM (kontext, GPU vrstvy), diarizace.
- `corrections.txt` – slovník oprav přepisu (`chybně = správně`).
- `cache/` – přepisy, diarizace, synchronizace, analýzy, stav úloh (`jobs/`), `worker.log`, `llama-server.log`.

## Testy a ladění
| Skript | Co dělá |
|---|---|
| `py -3.11 scripts/make_multicam_test.py` | vyrobí testovací rozhovor na 3 kamery se známým výsledkem (`test/multicam/gt.json`) |
| `node scripts/test-worker.mjs [status transcribe diarize sync names multicam analyze llm premiere]` | Worker + více kamer, porovnání se správným výsledkem |
| `node scripts/verify-multicam.mjs` | kontrola vytvořené multicam sekvence v Premiere (sync, mezery, zvuk) |
| `node scripts/test-premiere.mjs [status build pauses seq markers remove]` | živé testy střihu v otevřeném projektu |
| `node scripts/smoke.mjs`, `node scripts/verify-host.mjs` | MCP handshake, kontrola host.jsx |
| `node scripts/es.mjs soubor.jsx` / `--reload`, `node scripts/cdp.mjs`, `node scripts/panel-run.mjs "zadání"` | ExtendScript, DevTools panelu, AI z panelu |

| `scripts\restart-worker.ps1` | natvrdo ukončí Worker a llama-server (MCP server jinak restartuje Worker se starým kódem sám) |
| `node scripts/test-multicam-unit.mjs` | jednotkové testy přepínání kamer (bez celku, pozdě zapnutá kamera, rychlé střídání, hodina za 18 ms) |
| `node scripts/test-worker-restart.mjs` | restart Workeru se starým kódem, žádný osiřelý llama-server |
| `node scripts/test-podcast2.mjs` | skutečný podcast: diarizace, osnova, lokální 5min střih, sestavení a export |
| `.venv\Scripts\python.exe scripts\diar_experiment.py` | srovnání modelů hlasových otisků a prahů |
| `node scripts/test-hermes-loop.mjs [kol]` | plán střihu lokálním modelem na debatě: délka, moderátor, useknuté věty, odbočky, vyvážení |
| `node scripts/test-plan-diskuse.mjs [kol] [backend]` | totéž na jiném materiálu a zadání (pojistka proti přeladění na jeden test) |
| `node scripts/test-plan-battery.mjs` | 6 různých zadání na 2 materiálech, texty do `test/hermes-loop/battery.md` k ručnímu posouzení |
| `node scripts/test-fresh-pipeline.mjs video "zadání" s` | celá cesta u nového videa s časy jednotlivých kroků |
| `node scripts/compare-agents.mjs "claude:sonnet:lean2:medium,codex:gpt-5.5"` | agenti na stejném střihu: čas, cena, tokeny, kvalita; průběh do `test/agent-compare/*.jsonl` |
| `.venv\Scripts\python.exe scripts\asr-batch-bench.py` | Whisper klasicky vs. dávkově: rychlost, přesnost textu a časů slov |
| `.venv\Scripts\python.exe scripts\srt-qa.py soubor.srt [znaků] [řádků]` | kontrola kvality titulků (délka řádků, předložky, rychlost čtení, osiřelá slova) |
| `node scripts/tool-sizes.mjs` | velikost popisů MCP nástrojů (tokeny, které agent platí) |
| `node scripts/panel-reload.mjs` | znovu načte stránku panelu (po úpravě `panel/main.js`) bez restartu Premiere |

### Naměřeno
| Test | Výsledek |
|---|---|
| Syntetický rozhovor, 3 kamery | synchronizace 0 ms, kdo mluví (jen hlas) 92 %, (mikrofony) 100 %, správná kamera 99,7 % |
| Skutečná panelová diskuse 26:39 (archive.org, CC BY-NC-ND) | přepis 116 s, diarizace 15 s (moderátor + 2 panelisté rozlišeni), osnova 112 s, lokální plán 47 s, střih + export 5:15 za 30 s |

Diarizace „chunks“ (výchozí, když existuje přepis): hlasové otisky kousků vět modelem 3D-Speaker CAM++ a shlukování.
Na záznamu z místnosti je výrazně lepší než klasická pyannote pipeline (ta vše přiřadila jednomu mluvčímu).
Pro natáčení na více kamer je nejspolehlivější, když má každý host vlastní mikrofon (`speakerTracks`).

## Poznámky
- CEP/ExtendScript Adobe podporuje v Premiere do září 2026; architektura (MCP ↔ HTTP most) umožní přejít na UXP.
- `Time.getFormatted()` vrací u nestandardních fps špatný timecode, `razor` proto čte timecode z QE přehrávací hlavy.
- `panel/.debug` zapíná DevTools panelu na `127.0.0.1:8098` (jen pro vývoj).
