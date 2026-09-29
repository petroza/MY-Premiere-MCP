# MY Premiere MCP – malá online instalace

Dva malé soubory, všechno ostatní se stáhne z internetu.

## Použití

1. Zkopíruj složku `INSTALL_SMALL` na cílový počítač (nebo stáhni `Instalace.cmd` a `install-online.ps1` z GitHubu).
2. Poklepej na **`Instalace.cmd`**.
3. Zeptá se, kam instalovat (Enter = `%USERPROFILE%\MYpremiereMCP`) a jestli stáhnout i Hermes.
4. Po dokončení restartuj Premiere Pro → **Okno › Rozšíření › MY Premiere MCP**.

## Co se stáhne

| Co | Odkud | Velikost |
|---|---|---|
| Kód aplikace | github.com/petroza/MY-Premiere-MCP | < 1 MB |
| Node.js LTS, Python 3.11 (jen když chybí) | winget | ~100 MB |
| npm a pip balíčky (faster-whisper, CUDA knihovny…) | npmjs.org, pypi.org | ~1,5 GB |
| Whisper large-v3 (přepis) | huggingface.co | 3 GB |
| Diarizace (kdo kdy mluví) | github.com (sherpa-onnx) | 40 MB |
| Lokální LLM gemma3 12B + vision model + llama.cpp | huggingface.co, github.com | ~10 GB |
| Hermes – volitelně (`-Hermes`) | huggingface.co (unsloth), github.com | ~23 GB |

Potřeba je Windows 10/11, ~15 GB volného místa (+23 GB s Hermesem) a internet. NVIDIA GPU výrazně zrychlí přepis.

## Přepínače

```
Instalace.cmd -Target D:\MYpremiereMCP   jiná složka
Instalace.cmd -Hermes                    i Hermes bez ptaní
Instalace.cmd -NoLocalLLM                bez lokálního LLM (ušetří ~10 GB)
Instalace.cmd -SkipModels                jen panel a MCP, bez modelů
```

**Aktualizace:** spusť `Instalace.cmd` znovu se stejnou složkou – stáhne nový kód, modely, cache a `config.json` nechá.

Ve firemní síti s proxy nastav před spuštěním `HTTPS_PROXY` (a pro npm/pip jejich proxy). Bez internetu použij velkou offline instalaci ze složky `INSTALL`.
