"""MYpremiereMCP Worker – lokální HTTP služba s frontou úloh (127.0.0.1, token).

Spuštění:  .venv\\Scripts\\python.exe worker\\server.py
Úlohy běží postupně v jednom vlákně (GPU sdílí Whisper a LLM), stav je v cache/jobs.
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from worker.common import CONFIG, Cancelled, cache_dir, log, original_media, read_json, read_token, write_json  # noqa: E402
from worker import analysis, asr, audiosync, diarize, frame, gpu, media  # noqa: E402

VERSION = "0.2.0"
HANDLERS = {
    "transcribe": asr.transcribe,
    "diarize": diarize.diarize,
    "rename_speakers": diarize.rename_speakers,
    "list_voices": diarize.list_voices,
    "forget_voice": diarize.forget_voice,
    "sync": audiosync.sync,
    "refine_edges": audiosync.refine_edges,
    "analyze": analysis.analyze,
    "plan_edit": analysis.plan_edit,
    "translate": analysis.translate,
    "frame": frame.get_frame,
    "describe_frame": frame.describe_frame,
    "prepare_media": media.prepare,
}
TOKEN = read_token()
JOBS_DIR = cache_dir("jobs")
_ROOT = Path(__file__).resolve().parent.parent
# razítko kódu: MCP server podle něj pozná Worker spuštěný se starší verzí souborů a restartuje ho
CODE_STAMP = max(int(p.stat().st_mtime) for p in [*(_ROOT / "worker").glob("*.py"), _ROOT / "config.json"])


class Ctx:
    def __init__(self, job: dict, store: "Store"):
        self.job = job
        self.store = store

    @property
    def cancelled(self) -> bool:
        return bool(self.job.get("cancel"))

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled()

    def progress(self, p: float, msg: str = "") -> None:
        self.job["progress"] = round(max(0.0, min(1.0, p)), 3)
        self.job["message"] = msg
        self.check()


class Store:
    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.q: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        for f in sorted(JOBS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)[-200:]:
            try:
                j = read_json(f)
            except (OSError, ValueError):
                continue
            if j.get("status") in ("queued", "running"):
                j.update(status="error", error="Úloha přerušena restartem Workeru.")
                write_json(f, j)
            self.jobs[j["id"]] = j
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, jtype: str, params: dict) -> dict:
        if jtype not in HANDLERS:
            raise ValueError(f"Neznámý typ úlohy: {jtype}")
        key = hashlib.sha1(json.dumps([jtype, params], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            for j in self.jobs.values():
                if j["key"] == key and j["status"] in ("queued", "running"):
                    return j
            job = {"id": uuid.uuid4().hex[:12], "key": key, "type": jtype, "params": params, "status": "queued",
                   "progress": 0.0, "message": "ve frontě", "created": time.time()}
            self.jobs[job["id"]] = job
        self._save(job)
        self.q.put(job["id"])
        return job

    def _save(self, job: dict) -> None:
        write_json(JOBS_DIR / f"{job['id']}.json", job)

    def _loop(self) -> None:
        while True:
            jid = self.q.get()
            job = self.jobs.get(jid)
            if not job or job.get("cancel"):
                if job:
                    job.update(status="cancelled")
                    self._save(job)
                continue
            job.update(status="running", started=time.time(), message="běží")
            self._save(job)
            log(f"úloha {jid} {job['type']} start")
            try:
                params = job["params"]
                if job["type"] != "prepare_media" and isinstance(params.get("path"), str):
                    params = {**params, "path": original_media(params["path"])}
                job["result"] = HANDLERS[job["type"]](params, Ctx(job, self))
                job.update(status="done", progress=1.0, message="hotovo")
            except Cancelled:
                job.update(status="cancelled", message="zrušeno")
            except Exception as e:  # noqa: BLE001
                job.update(status="error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-3000:])
                log(f"úloha {jid} chyba: {e}")
            job["finished"] = time.time()
            self._save(job)
            log(f"úloha {jid} {job['status']} za {job['finished'] - job['started']:.1f} s")


STORE = Store()


class Handler(BaseHTTPRequestHandler):
    server_version = "MYpremiereWorker/" + VERSION

    def log_message(self, fmt, *args):  # tichý log
        pass

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        if self.headers.get("Origin") or not re.match(r"^(127\.0\.0\.1|localhost):\d+$", self.headers.get("Host", "")):
            self._send(403, {"error": "forbidden"})
            return False
        if self.path != "/health" and self.headers.get("X-PMCP-Token") != TOKEN:
            self._send(401, {"error": "bad token"})
            return False
        return True

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if not self._auth():
            return
        if self.path == "/health":
            models = {k: (Path(__file__).resolve().parent.parent / v).exists() for k, v in CONFIG["models"].items() if k != "whisperDownloadRoot"}
            running = [j["id"] for j in STORE.jobs.values() if j["status"] == "running"]
            return self._send(200, {"ok": True, "version": VERSION, "pid": os.getpid(), "codeStamp": CODE_STAMP,
                                    "models": models, "llmBackends": gpu.backend_status(), "running": running,
                                    "queued": STORE.q.qsize(), **gpu.status()})
        m = re.match(r"^/jobs/([0-9a-f]{12})$", self.path)
        if m:
            job = STORE.jobs.get(m.group(1))
            return self._send(200, job) if job else self._send(404, {"error": "job not found"})
        if self.path == "/jobs":
            items = sorted(STORE.jobs.values(), key=lambda j: -j["created"])[:50]
            return self._send(200, [{k: j.get(k) for k in ("id", "type", "status", "progress", "message", "error")} for j in items])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return
        try:
            data = self._body()
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if self.path == "/jobs":
            try:
                job = STORE.submit(data.get("type", ""), data.get("params") or {})
            except ValueError as e:
                return self._send(400, {"error": str(e)})
            return self._send(200, job)
        m = re.match(r"^/jobs/([0-9a-f]{12})/cancel$", self.path)
        if m and m.group(1) in STORE.jobs:
            STORE.jobs[m.group(1)]["cancel"] = True
            return self._send(200, {"ok": True})
        if self.path == "/release":
            gpu.release_all()
            return self._send(200, {"ok": True})
        if self.path == "/shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self._send(404, {"error": "not found"})


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Windows jinak (SO_REUSEADDR) pustí na stejný port DVA Workery zároveň – dotazy pak chodí
    náhodně jednomu z nich a restart po změně kódu se nikdy neprojeví. Port držíme výhradně."""

    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    port = int(CONFIG["worker"]["port"])
    gpu.kill_orphan_llama()
    httpd = None
    for attempt in range(15):  # předchozí Worker mohl port ještě držet (restart po změně kódu)
        try:
            httpd = ExclusiveHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            if attempt == 14:
                log(f"Worker nelze spustit, port {port} je obsazený: {e}")
                sys.exit(1)
            time.sleep(1)
    httpd.daemon_threads = True
    log(f"Worker {VERSION} (pid {os.getpid()}) poslouchá na 127.0.0.1:{port}")
    httpd.serve_forever()
    log("Worker se ukončuje – uvolňuji GPU")
    gpu.release_all()
    os._exit(0)


if __name__ == "__main__":
    main()
