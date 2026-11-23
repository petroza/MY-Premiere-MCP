"""Správa modelů na GPU: vždy jen jeden velký model (Whisper nebo LLM), 12 GB VRAM na oba nestačí.

LLM běží jako llama-server.exe (llama.cpp, CUDA) ze složky tools/ – bez Ollamy, spouští se jen na dobu potřeby.
"""
from __future__ import annotations

import gc
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request

from .common import CONFIG, ORIG_PATH, ROOT, add_nvidia_dll_dirs, log, model_path, write_json

add_nvidia_dll_dirs()

_lock = threading.RLock()
_whisper = None
_whisper_key = None
_llm_proc: subprocess.Popen | None = None
_vision_proc: subprocess.Popen | None = None


def _free_whisper() -> None:
    global _whisper, _whisper_key
    if _whisper is not None:
        log("GPU: uvolňuji Whisper")
        _whisper = None
        _whisper_key = None
        gc.collect()


def kill_orphan_llama() -> int:
    """Ukončí llama-server z naší složky tools, který nepatří tomuto procesu (zůstal po pádu/restartu Workeru)."""
    if os.name != "nt":
        return 0
    exe = str((ROOT / CONFIG["llm"]["server"]).resolve()).lower()
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | "
          "Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress")
    no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True,
                             timeout=30, creationflags=no_window).stdout.strip()
        items = json.loads(out) if out else []
    except Exception:  # noqa: BLE001
        return 0
    ours = {p.pid for p in (_llm_proc, _vision_proc) if p is not None}
    killed = 0
    for it in items if isinstance(items, list) else [items]:
        pid = it.get("ProcessId")
        if (it.get("ExecutablePath") or "").lower() == exe and pid not in ours:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=no_window)
            killed += 1
    if killed:
        log(f"GPU: ukončeno osiřelých llama-server: {killed}")
    return killed


def free_foreign_ai(reason: str) -> list[str]:
    """Uvolní grafiku od cizích AI modelů, než se načte náš (Whisper, Hermes): na 12 GB se dva velké modely
    nevejdou a ovladač pak přelévá do sdílené RAM – vše je několikrát pomalejší a Premiere se seká
    (2026-11-20: Hermes 20 tok/s místo ~50 při 11 z 12 GB obsazených).
    - Ollama: modely se jen vyloží z paměti (keep_alive 0), server běží dál – jiné aplikace ho dál použijí
    - cizí llama-server.exe (jiná instalace, např. O:\\Hermes na jiném portu) se ukončí"""
    done: list[str] = []
    no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=1.5) as r:
            loaded = [m.get("name") for m in json.load(r).get("models", []) if m.get("name")]
        for name in loaded:
            req = urllib.request.Request("http://127.0.0.1:11434/api/generate", method="POST",
                                         data=json.dumps({"model": name, "keep_alive": 0}).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=20).read()
            done.append(f"Ollama {name} vyložena")
    except Exception:  # noqa: BLE001 – Ollama neběží
        pass
    if os.name == "nt":
        ours = {str((ROOT / p).resolve()).lower() for p in (
            CONFIG["llm"]["server"], (CONFIG.get("llmBackends", {}).get("hermes") or {}).get("server", "tools/llama.cpp-hermes/llama-server.exe"),
            "tools/llama.cpp-hermes/llama-server.exe")}
        ps = ("Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | "
              "Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress")
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True,
                                 timeout=30, creationflags=no_window).stdout.strip()
            items = json.loads(out) if out else []
        except Exception:  # noqa: BLE001
            items = []
        for it in items if isinstance(items, list) else [items]:
            path = (it.get("ExecutablePath") or "").lower()
            if path and path not in ours:
                subprocess.run(["taskkill", "/PID", str(it.get("ProcessId")), "/T", "/F"], capture_output=True,
                               creationflags=no_window)
                done.append(f"cizí llama-server ukončen ({it.get('ExecutablePath')})")
    if done:
        log(f"GPU: uvolnění grafiky ({reason}): " + "; ".join(done))
    return done


def _free_llm() -> None:
    global _llm_proc
    if _llm_proc is None and _llm_ready():
        kill_orphan_llama()
    if _llm_proc is not None:
        log("GPU: vypínám llama-server")
        _llm_proc.terminate()
        try:
            _llm_proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _llm_proc.kill()
        _llm_proc = None


def _free_vision() -> None:
    global _vision_proc
    if _vision_proc is None and _vision_ready():
        kill_orphan_llama()
    if _vision_proc is not None:
        log("GPU: vypínám vision llama-server")
        _vision_proc.terminate()
        try:
            _vision_proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _vision_proc.kill()
        _vision_proc = None


def free_vram_mb() -> int | None:
    """Volná paměť GPU v MB (nvidia-smi), None když nejde zjistit."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return int(out.stdout.strip().splitlines()[0])
    except Exception:  # noqa: BLE001
        return None


def whisper(name: str | None = None):
    """Vrátí (model, device). Výchozí model je ve složce models/, jiné se stáhnou do models/whisper-extra."""
    global _whisper, _whisper_key
    from faster_whisper import WhisperModel

    w = CONFIG["whisper"]
    name = name or w["model"]
    if name in ("large-v3-czech", "czech", "cs"):
        czech = model_path("whisperCzech")
        source = str(czech) if czech.exists() else name
    else:
        local = model_path("whisper")
        source = str(local) if name == w["model"] and local.exists() else name
    with _lock:
        # načtený model stejného zdroje ber, i když se liší typ výpočtu (volná VRAM se mění) nebo běží po záloze
        # na CPU – jinak by se model načítal znovu při každém přepisu
        if _whisper is not None and _whisper_key[0] == source and _whisper_key[1] in (w["device"], "cpu"):
            return _whisper, _whisper_key[1]
        stop_owned_hermes("přepis potřebuje grafiku")  # 35B model + Whisper se do 12 GB nevejdou (přepis visel na 4 %)
        free_foreign_ai("přepis")
        _free_llm()
        _free_vision()
        _free_whisper()
        compute = w["compute"]
        if w["device"] == "cuda" and compute == "float16":
            # vedle cizího modelu na GPU (Hermes ~8–11 GB) se float16 (~4 GB) nemusí vejít – ovladač pak přelévá do RAM
            # a přepis je ~4× pomalejší (změřeno: 3 min zvuku 87 s místo 22 s). int8_float16 potřebuje polovinu,
            # přesnost stejná. Měří se až po uvolnění vlastních modelů.
            free = free_vram_mb()
            if free is not None and free < 4500:
                compute = "int8_float16"
        key = (source, w["device"], compute)
        download_root = str(ROOT / CONFIG["models"]["whisperDownloadRoot"])
        log(f"GPU: načítám Whisper {source} ({key[1]}/{key[2]})")
        try:
            _whisper = WhisperModel(source, device=key[1], compute_type=key[2], download_root=download_root)
            _whisper_key = key
        except Exception as e:  # noqa: BLE001
            if key[1] == "cpu":
                raise
            log(f"Whisper na GPU selhal ({e}); používám CPU int8")
            _whisper = WhisperModel(source, device="cpu", compute_type="int8", download_root=download_root)
            _whisper_key = (source, "cpu", "int8")
        return _whisper, _whisper_key[1]


def _llm_url() -> str:
    return f"http://127.0.0.1:{CONFIG['llm'].get('port', 7882)}"


def _llm_ready() -> bool:
    try:
        with urllib.request.urlopen(_llm_url() + "/health", timeout=0.4) as r:
            return json.loads(r.read() or b"{}").get("status") == "ok"
    except Exception:
        return False


def ensure_llm() -> str:
    """Spustí llama-server s modelem z models/llm (pokud neběží) a vrátí jeho URL."""
    global _llm_proc
    with _lock:
        if _llm_proc is not None and _llm_proc.poll() is None and _llm_ready():
            return _llm_url()
        _free_whisper()
        _free_vision()
        _free_llm()
        exe = ROOT / CONFIG["llm"]["server"]
        model = model_path("llm")
        for p in (exe, model):
            if not p.exists():
                raise RuntimeError(f"Chybí soubor pro lokální LLM: {p}")
        cfg = CONFIG["llm"]
        # když část VRAM drží něco jiného (např. uživatelův Hermes), zkus model s méně vrstvami na GPU.
        # Na Windows -ngl 99 při plné VRAM neselže – ovladač přelévá do sdílené RAM a vytlačí i cizí model
        # (Hermes spadl z 11 GB na 2 GB) –, proto se o počtu vrstev rozhoduje podle volné VRAM předem.
        layer_options = [cfg.get("gpuLayers", 99), cfg.get("gpuLayersFallback", 12)]
        free = free_vram_mb()
        if free is not None and free < cfg.get("needVramMb", 9000):
            log(f"GPU: volných jen {free} MB VRAM – gemma3 poběží z větší části na CPU")
            layer_options = layer_options[1:]
        for attempt, ngl in enumerate(layer_options):
            args = [str(exe), "-m", str(model), "--host", "127.0.0.1", "--port", str(cfg.get("port", 7882)),
                    "-c", str(cfg.get("nCtx", 12288)), "-ngl", str(ngl), "--jinja", "-fa", "on", "--no-webui"]
            log(f"GPU: spouštím llama-server {model.name} (-ngl {ngl})")
            logf = open(ROOT / CONFIG.get("cacheRoot", "cache") / "llama-server.log", "ab")
            _llm_proc = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=str(exe.parent),
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            t0 = time.time()
            failed = None
            while time.time() - t0 < 180:
                if _llm_proc.poll() is not None:
                    failed = f"llama-server skončil (kód {_llm_proc.returncode})"
                    break
                if _llm_ready():
                    log(f"GPU: llama-server připraven za {time.time() - t0:.1f} s")
                    return _llm_url()
                time.sleep(1)
            failed = failed or "llama-server se nespustil do 180 s"
            _free_llm()
            if attempt + 1 < len(layer_options):
                log(f"GPU: {failed} – zkouším méně vrstev na GPU (nedostatek VRAM?)")
            else:
                raise RuntimeError(f"{failed}, viz cache/llama-server.log")


def _vision_url() -> str:
    return f"http://127.0.0.1:{CONFIG['llmVision'].get('port', 7883)}"


def _vision_ready() -> bool:
    try:
        with urllib.request.urlopen(_vision_url() + "/health", timeout=2) as r:
            return json.loads(r.read() or b"{}").get("status") == "ok"
    except Exception:
        return False


def ensure_vision_llm() -> str:
    """Spustí llama-server s vision modelem (models/llm-vision) a vrátí jeho URL."""
    global _vision_proc
    with _lock:
        if _vision_proc is not None and _vision_proc.poll() is None and _vision_ready():
            return _vision_url()
        _free_whisper()
        _free_llm()
        _free_vision()
        exe = ROOT / CONFIG["llmVision"]["server"]
        model = model_path("llmVision")
        mmproj = model_path("llmVisionMmproj")
        for p in (exe, model, mmproj):
            if not p.exists():
                raise RuntimeError(f"Chybí soubor pro lokální vision LLM: {p}")
        cfg = CONFIG["llmVision"]
        args = [str(exe), "-m", str(model), "--mmproj", str(mmproj), "--host", "127.0.0.1",
                "--port", str(cfg.get("port", 7883)), "-c", str(cfg.get("nCtx", 8192)),
                "-ngl", str(cfg.get("gpuLayers", 99)), "--no-webui"]
        log(f"GPU: spouštím vision llama-server {model.name}")
        logf = open(ROOT / CONFIG.get("cacheRoot", "cache") / "llama-server-vision.log", "ab")
        _vision_proc = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=str(exe.parent),
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        t0 = time.time()
        while time.time() - t0 < 180:
            if _vision_proc.poll() is not None:
                raise RuntimeError(f"vision llama-server skončil (kód {_vision_proc.returncode}), viz cache/llama-server-vision.log")
            if _vision_ready():
                log(f"GPU: vision llama-server připraven za {time.time() - t0:.1f} s")
                return _vision_url()
            time.sleep(1)
        raise RuntimeError("vision llama-server se nespustil do 180 s")


def describe_image(image_path: str, prompt: str, max_tokens: int = 400) -> str:
    """Popíše obrázek lokálním vision modelem (Qwen3-VL). Vrací čistý text odpovědi."""
    import base64

    url = ensure_vision_llm() + "/v1/chat/completions"
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    body = json.dumps({
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ],
        }],
        "temperature": CONFIG["llmVision"].get("temperature", 0.2),
        "max_tokens": max_tokens,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"].strip()


def llm_backends() -> dict:
    """Externí OpenAI-kompatibilní servery (např. lokální Hermes). Worker je nespouští ani nevypíná."""
    return CONFIG.get("llmBackends") or {}


_backend_cache: tuple[float, list[dict]] = (0.0, [])


# ---------------------------------------------------------------- Hermes na požádání
# Hermes (35B) drží ~9 GB grafiky. Když běžel trvale (autostart), Premiere se 4K záznamy měla 2 GB a sekal se celý
# počítač (2026-10-05). Worker ho proto spouští, jen když ho úloha potřebuje, a po nečinnosti sám vypne. Hermese
# spuštěného ručně (ne Workerem) nevypíná – ten patří uživateli.
_hermes_owned = False
_hermes_last = 0.0


def _hermes_ready(b: dict) -> bool:
    try:
        with urllib.request.urlopen(str(b["url"]).rstrip("/") + "/health", timeout=0.6) as r:
            return json.loads(r.read() or b"{}").get("status") == "ok"
    except Exception:  # noqa: BLE001
        return False


def _hermes_script(b: dict, action: str, *extra: str) -> None:
    # bez zachytávání výstupu: llama-server spuštěný přes Start-Process by zdědil rouru a čekání by nikdy neskončilo
    # původní PATH (bez knihoven CUDA z pip, které přidal Whisper) – viz common.ORIG_PATH
    env = dict(os.environ, PATH=ORIG_PATH)
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / b["start"]), action, *extra],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=480, env=env,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def hermes_touch() -> None:
    global _hermes_last
    _hermes_last = time.time()


def ensure_hermes() -> bool:
    """Hermes běží (případně ho spustí s viděním – hodí se na text i obraz). False = není nainstalovaný / nejde."""
    global _hermes_owned, _backend_cache
    b = llm_backends().get("hermes")
    if not b:
        return False
    if _hermes_ready(b):
        hermes_touch()
        return True
    if b.get("autoStart") is False or not b.get("start") or not (ROOT / str(b.get("modelFile", ""))).exists():
        return False
    with _lock:
        _free_whisper()  # Whisper na GPU by se s 35B modelem do 12 GB nevešel
        _free_llm()
        _free_vision()
        free_foreign_ai("start Hermese")
    # Kolik MoE vrstev nechat v RAM podle volné grafiky: model se nesmí přelít do sdílené paměti (Windows to dělá
    # potichu a rychlost spadne na polovinu i méně). Změřeno 2026-11-20 (4070 Ti 12 GB, s viděním):
    # 30 vrstev v RAM = 8,7 GB VRAM, 42 tok/s · 36 = 6,5 GB, 38 tok/s · 40 = 4,6 GB, 33 tok/s; přelitý model
    # (30 vrstev při 11 z 12 GB obsazených jinými programy) jen 20 tok/s a vstup 8× pomaleji.
    free = free_vram_mb()
    n_cpu_moe = 30 if free is None or free >= 9600 else 36 if free >= 7400 else 40
    log(f"GPU: spouštím Hermese na požádání (s viděním, volná VRAM {free} MB -> {n_cpu_moe} MoE vrstev v RAM)")
    t0 = time.time()
    try:
        _hermes_script(b, "start", "-Vize", "-NCpuMoe", str(n_cpu_moe))
    except Exception as e:  # noqa: BLE001
        log(f"GPU: Hermes se nespustil: {e}")
    _backend_cache = (0.0, [])
    if _hermes_ready(b):
        _hermes_owned = True
        hermes_touch()
        log(f"GPU: Hermes připraven za {time.time() - t0:.0f} s")
        return True
    log("GPU: Hermes nenaběhl – pokračuji s vlastním modelem")
    return False


def stop_owned_hermes(reason: str) -> None:
    """Vypne Hermese, kterého spustil Worker (ručně spuštěného nechá být)."""
    global _hermes_owned, _backend_cache
    if not _hermes_owned:
        return
    b = llm_backends().get("hermes") or {}
    try:
        _hermes_script(b, "stop")
    except Exception as e:  # noqa: BLE001
        log(f"GPU: zastavení Hermese selhalo: {e}")
    _hermes_owned = False
    _backend_cache = (0.0, [])
    log(f"GPU: Hermes vypnut ({reason}) – grafika a paměť uvolněny")


def hermes_idle_check(busy: bool) -> None:
    """Volá Worker pravidelně: po nečinnosti (výchozí 5 min) Hermese spuštěného Workerem vypne."""
    idle = float((llm_backends().get("hermes") or {}).get("idleStopSec", 300))
    if _hermes_owned and not busy and time.time() - _hermes_last > idle:
        stop_owned_hermes(f"{idle / 60:.0f} min bez úlohy")


def auto_backend() -> str:
    """Backend „auto“: běžící externí model (Hermes), jinak ho spustit na požádání, jinak vlastní model."""
    for b in backend_status(max_age=0):
        if b["name"] != "local" and b["running"]:
            if b["name"] == "hermes":
                hermes_touch()
            return b["name"]
    return "hermes" if ensure_hermes() else "local"


def backend_status(max_age: float = 15.0) -> list[dict]:
    """Pro worker_status: co je nakonfigurované a jestli to zrovna běží.

    Výsledek se krátce cachuje a dotaz má malý timeout – /health musí být okamžité,
    jinak si ho MCP server vyhodnotí jako nedostupný Worker (nepoužitelný model na
    cizím portu jinak zdržel odpověď o celé sekundy)."""
    global _backend_cache
    now = time.time()
    if now - _backend_cache[0] < max_age and _backend_cache[1]:
        return _backend_cache[1]
    out = [{"name": "local", "label": f"vlastní llama-server ({model_path('llm').name})", "running": _llm_ready()}]
    for name, b in llm_backends().items():
        url = str(b.get("url", "")).rstrip("/")
        running = False
        try:
            with urllib.request.urlopen(url + "/health", timeout=0.4) as r:
                running = json.loads(r.read() or b"{}").get("status") == "ok"
        except Exception:  # noqa: BLE001
            running = False
        out.append({"name": name, "label": b.get("label", name), "url": url, "model": b.get("model"), "running": running})
    _backend_cache = (now, out)
    return out


# měření volání LLM (llama-server vrací "timings") – plan_edit z toho skládá, kde se ztrácí čas
CALL_STATS: list[dict] = []
STAT_PHASE = ""


def stats_summary(calls: list[dict]) -> dict:
    by: dict[str, dict] = {}
    for c in calls:
        d = by.setdefault(c["phase"] or "-", {"calls": 0, "sec": 0.0, "prompt": 0, "cached": 0, "gen": 0})
        d["calls"] += 1
        d["sec"] = round(d["sec"] + c["sec"], 1)
        for k in ("prompt", "cached", "gen"):
            d[k] += c.get(k) or 0
    return by


def chat_json(prompt: str, max_tokens: int = 1500, schema: dict | None = None, backend: str | None = None) -> dict:
    ext = None
    if backend and backend != "local":
        if backend == "hermes" and not ensure_hermes():  # panel posílá "hermes" napřímo – spustit na požádání
            raise RuntimeError("Hermes neběží a nepodařilo se ho spustit (scripts\\hermes.ps1 start, viz cache\\hermes\\llama-server.log).")
        ext = llm_backends().get(backend)
        if not ext:
            raise RuntimeError(f"Neznámý LLM backend '{backend}'. Dostupné: local, " + ", ".join(llm_backends()) or "local")
        url = str(ext["url"]).rstrip("/") + "/v1/chat/completions"
    else:
        url = ensure_llm() + "/v1/chat/completions"
    # se schématem llama-server generování gramaticky omezí (GBNF) – model fyzicky nemůže
    # vrátit nic jiného než objekt podle schématu (bez schématu jen "json_object", model se
    # občas netrefí do objektu vůbec, viz worker/analysis.py).
    response_format = (
        {"type": "json_schema", "json_schema": {"name": "response", "schema": schema}}
        if schema else {"type": "json_object"}
    )
    # odsazený JSON (model ho sám od sebe dělá) stojí na každém řádku tokeny navíc – generování je nejdražší část
    prompt += "\n(Odpověz kompaktním JSON na jednom řádku, bez odsazení.)"
    payload = {
        "messages": [{"role": "user", "content": prompt}],
        "temperature": CONFIG["llm"].get("temperature", 0.1),
        "max_tokens": max_tokens,
        "response_format": response_format,
    }
    if ext:
        if ext.get("model"):
            payload["model"] = ext["model"]
        if ext.get("temperature") is not None:
            payload["temperature"] = ext["temperature"]
        if ext.get("thinking") is False:
            # uvažovací modely (Qwen3) jinak spotřebují limit tokenů na přemýšlení a vrátí prázdný content
            payload["chat_template_kwargs"] = {"enable_thinking": False}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                resp = json.loads(r.read())
        except urllib.error.HTTPError:
            raise  # odpověď serveru (např. překročený kontext) není pád modelu – nerestartovat (revize #13)
        except (ConnectionError, urllib.error.URLError) as e0:
            # Hermes spadl („CUDA error“ na čerstvém serveru u některých dotazů, 2026-11-22): znovu spustit (hermes.ps1
            # ho po startu zahřeje krátkým dotazem) a zkusit ještě jednou
            if backend != "hermes":
                raise
            log(f"GPU: Hermes během dotazu spadl ({e0}) – spouštím znovu a opakuji dotaz")
            time.sleep(2)
            if not ensure_hermes():
                raise
            req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=900) as r:
                resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"lokální model ({backend or 'local'}) odmítl dotaz: HTTP {e.code} {body}") from e
    except (ConnectionError, urllib.error.URLError) as e:
        # model během dotazu spadl (llama-server: „CUDA error“) – dotaz uložit k ladění a ohlásit srozumitelně
        try:
            write_json(ROOT / CONFIG.get("cacheRoot", "cache") / "llm-failed-request.json", {"url": url, "payload": payload, "error": str(e)})
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"lokální model ({backend or 'local'}) během dotazu spadl – viz cache/hermes/llama-server.log; "
                           f"dotaz uložen v cache/llm-failed-request.json ({e})") from e
    msg = resp["choices"][0]["message"]
    tm = resp.get("timings") or {}
    CALL_STATS.append({
        "phase": STAT_PHASE, "sec": round(time.time() - t0, 2),
        "prompt": tm.get("prompt_n"), "cached": tm.get("cache_n"), "gen": tm.get("predicted_n"),
        "promptMs": round(tm.get("prompt_ms") or 0), "genMs": round(tm.get("predicted_ms") or 0),
    })
    content = msg.get("content") or ""
    if not content and msg.get("reasoning_content"):
        log("LLM vrátil odpověď jen v reasoning_content – zkouším z něj vytáhnout JSON")
        content = msg["reasoning_content"]
    try:
        result = json.loads(content)
    except ValueError:
        log(f"LLM vrátil neplatný/uříznutý JSON ({len(content)} znaků) – opravuji")
        result = repair_json(content)
    if not isinstance(result, dict):
        # response_format=json_object si model občas neuhlídá (např. vrátí jen řetězec) –
        # volající vždy dělá result.get(...), takže bez dict by spadl s AttributeError.
        log(f"LLM vrátil JSON, ale ne objekt ({type(result).__name__}) – ignoruji: {str(content)[:200]}")
        return {}
    return result


def repair_json(content: str) -> dict:
    """Uříznutý JSON (limit tokenů): vezmi text po poslední úplnou hodnotu a doplň zavírací závorky."""
    start = content.find("{")
    if start < 0:
        return {}
    s = content[start:]
    stack: list[str] = []
    in_str = esc = False
    last_ok = None
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
            last_ok = (i, list(stack))
    if last_ok is None:
        return {}
    i, rest = last_ok
    try:
        return json.loads(s[: i + 1] + "".join(reversed(rest)))
    except ValueError:
        return {}


def release_all() -> None:
    with _lock:
        _free_llm()
        _free_vision()
        _free_whisper()


def status() -> dict:
    return {
        "whisperLoaded": _whisper is not None,
        "whisperDevice": _whisper_key[1] if _whisper_key else None,
        "llmRunning": _llm_proc is not None and _llm_proc.poll() is None,
        "visionLlmRunning": _vision_proc is not None and _vision_proc.poll() is None,
    }
