"""Sdílené cesty, konfigurace, cache a pomocné funkce Workeru."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG: dict = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
CACHE = ROOT / CONFIG.get("cacheRoot", "cache")
TOKEN_FILE = Path(os.environ.get("APPDATA", str(ROOT))) / "MYpremiereMCP" / "token.txt"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, file=sys.stderr, flush=True)
    try:
        (CACHE / "worker.log").parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE / "worker.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def model_path(key: str) -> Path:
    return (ROOT / CONFIG["models"][key]).resolve()


def cache_dir(kind: str) -> Path:
    d = CACHE / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def read_token() -> str:
    try:
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        tok = secrets.token_hex(24)
        TOKEN_FILE.write_text(tok, encoding="utf-8")
        return tok


def norm_key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path)).lower()


def original_media(path: str) -> str:
    """Převedené MP4 (worker/media.py) -> originální MKV. Přepis, osnova i diarizace patří originálu – časy jsou
    stejné. Bez tohoto plan_edit nad sekvencí z převedeného souboru hlásil „neexistuje přepis“ (Gummo, 2026-09-29)."""
    try:
        idx = read_json(CACHE / "media" / "index.json")
    except (OSError, ValueError):
        return path
    return idx.get(os.path.normcase(os.path.abspath(path))) or idx.get(norm_key(path)) or path


def file_key(path: str, extra) -> str:
    st = os.stat(path)
    raw = json.dumps([norm_key(path), st.st_size, int(st.st_mtime), extra], ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def cache_file(kind: str, path: str, extra) -> Path:
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in os.path.basename(path))
    return cache_dir(kind) / f"{safe}.{file_key(path, extra)}.json"


def read_json(p: Path):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def write_json(p: Path, data) -> None:
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def index_get(kind: str, path: str) -> Path | None:
    idx_file = cache_dir(kind) / "index.json"
    try:
        f = read_json(idx_file).get(norm_key(path))
    except (OSError, ValueError):
        return None
    return Path(f) if f and Path(f).exists() else None


def index_set(kind: str, path: str, file: Path) -> None:
    idx_file = cache_dir(kind) / "index.json"
    try:
        idx = read_json(idx_file)
    except (OSError, ValueError):
        idx = {}
    idx[norm_key(path)] = str(file)
    write_json(idx_file, idx)


def add_nvidia_dll_dirs() -> None:
    """cuBLAS/cuDNN z pip balíčků nvidia-* nejsou v PATH – CTranslate2 i llama.cpp by je nenašly."""
    if os.name != "nt":
        return
    import site

    roots = list(site.getsitepackages()) + [site.getusersitepackages()]
    for root in roots:
        nv = Path(root) / "nvidia"
        if not nv.is_dir():
            continue
        for bin_dir in nv.glob("*/bin"):
            try:
                os.add_dll_directory(str(bin_dir))
            except OSError:
                pass
            os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")


class Cancelled(Exception):
    pass
