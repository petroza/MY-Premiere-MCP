# MY Premiere MCP – instalace na nový počítač

## Jak na to

1. Zkopíruj **celou složku projektu** (včetně `INSTALL`) kamkoli na disk – cesta může být libovolná, instalátor si ji sám dopočítá.
2. Ve složce `INSTALL` poklepej na **`instalace.bat`**.
3. Na konci restartuj Premiere Pro a otevři **Okno → Rozšíření → MY Premiere MCP**.

Nic nepotřebuje práva správce a všechno se instaluje do složky aplikace (`.venv`, `models`, `tools`) – nikam jinam po systému se nesahá.

## Offline balík (bez internetu)

Pokud je vedle `instalace.bat` složka **`offline`** (~15 GB), instaluje se úplně **bez internetu** – modely, `llama.cpp`, Python balíčky (wheels) i `node_modules` se berou z ní. Instalátor to sám pozná a vypíše `Offline balik nalezen`.

Co je uvnitř:

| Složka | Obsah | Velikost |
|---|---|---|
| `offline/models/whisper-large-v3` | přepis řeči | 2,9 GB |
| `offline/models/llm` | gemma3 12B (osnovy, lokální plán střihu) | 6,8 GB |
| `offline/models/llm-vision` | Qwen3-VL (popis obrazu) | 2,8 GB |
| `offline/models/diarization` | kdo kdy mluví | 0,1 GB |
| `offline/tools/llama.cpp` | llama.cpp + CUDA runtime | 1,1 GB |
| `offline/models/hermes` | Hermes – Qwen3.6-35B-A3B + mmproj (silnější lokální plánování střihu) | 21,7 GB |
| `offline/tools/llama.cpp-hermes` | llama.cpp build 11118 pro Hermese | 1,1 GB |
| `offline/wheels` | Python balíčky (.whl) | 1,4 GB |
| `offline/node_modules` | Node závislosti | 20 MB |

Celkem ~38 GB, na cílovém disku je potřeba ~39 GB volných (instalátor to zkontroluje předem).

Bez složky `offline` se všechno stáhne z internetu – funguje obojí.

Na cílovém počítači je pořád potřeba mít **Node.js 18+** a **Python 3.11 (64-bit)** – ty balík neobsahuje.

### Hermes po instalaci
Nainstaluje se, ale **nespouští se sám** (na 12GB GPU by se pral s Whisperem o paměť). Spustíš ho:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\hermes.ps1 start
```

`plan_edit_local` si ho pak vezme automaticky. Potřebuje NVIDIA GPU s ~12 GB VRAM; na slabším stroji
poběží na CPU (~9 tok/s), což je pro plánování střihu prakticky nepoužitelné – tam nech plánovat gemma3
(`backend: "local"`) nebo rovnou Clauda.

## Volitelné přepínače

Spouští se z příkazové řádky, běžně nejsou potřeba:

| Příkaz | Co udělá |
|---|---|
| `instalace.bat -CheckOnly` | Jen otestuje prostředí, **nic nemění**. Dobré pustit, když něco nefunguje. |
| `instalace.bat -NoLocalLLM` | Bez lokálního LLM (ušetří ~10 GB, nepotřebuje silnou GPU). Přepis i střih přes Claude/GPT fungují; nepoběží jen `analyze_transcript`, `plan_edit_local` a `describe_frame`. |
| `instalace.bat -SkipModels` | Jen panel a MCP, bez modelů (přepis pak nefunguje). |

## Co instalátor kontroluje předem

Nic se nezačne instalovat, dokud neprojdou kontroly – takže nezůstane rozdělaná půlka instalace:

- soubory projektu (jestli se kopírováním něco neztratilo),
- volné místo na disku,
- Node.js 18+ a npm,
- Python 3.11,
- `curl` a `tar` (součást Windows 10/11),
- offline balík, nebo – když chybí – dostupnost sítě (npm registry, huggingface.co, github.com),
- jestli `%APPDATA%` není přesměrované na síťový disk (pak nejde propojit CEP panel),
- jestli je nainstalované Premiere Pro,
- přítomnost NVIDIA GPU,
- volné porty 7880 a 7881.

Po instalaci se navíc ověří, že to opravdu funguje: importy Python balíčků, velikost modelů, propojení panelu, klíč v registru, a že `mcp.json` ukazuje na existující soubor.

## Co dělat, když to selže

Každá chyba vypíše i návod, co s ní. Kompletní záznam je v **`INSTALL\install-log.txt`** – ten stačí poslat k diagnostice.

| Hláška | Řešení |
|---|---|
| `Node.js neni nainstalovany` | Nainstaluj Node.js LTS z nodejs.org, pak otevři **nové** okno a spusť instalaci znovu. |
| `Python 3.11 nenalezen` | Nainstaluj Python 3.11 (64-bit) a zaškrtni „Add python.exe to PATH“. |
| `Sit: ... je nedostupny` | Buď použij verzi se složkou `offline`, nebo nastav firemní proxy: `setx HTTPS_PROXY http://proxy:port`, otevři nové okno a spusť znovu. |
| `APPDATA je na sitovem disku` | Přesměrovaný profil – bez pomoci IT to nepůjde, CEP panel potřebuje lokální `%APPDATA%`. |
| `... existuje a neni to propojeni (junction)` | Smaž ručně `%APPDATA%\Adobe\CEP\extensions\com.pz.premieremcp` a spusť znovu. |
| Stahování spadne v půlce | Spusť instalaci znovu – hotové soubory přeskočí, dotáhne jen zbytek. |

## Poznámka k přenositelnosti

Instalátor při každém běhu přegeneruje `mcp.json` podle skutečného umístění projektu. Dřív tam byla natvrdo cesta `O:/MYpremiereMCP/...`, takže po zkopírování projektu jinam panel nenašel MCP server a nástroje se vůbec nepřipojily – tohle byla nejspíš příčina, proč instalace na jiném počítači nefungovala.

Bez NVIDIA GPU instalátor sám přepne Whisper do CPU režimu (`device=cpu`, `compute=int8`) – přepis pak běží pomaleji, ale funguje.
