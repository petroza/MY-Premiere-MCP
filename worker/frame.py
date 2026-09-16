"""Vytáhne jeden snímek z videa v daném čase a volitelně ho rovnou popíše lokálním vision modelem."""
from __future__ import annotations

import os

from . import gpu
from .common import cache_file, log


def _extract(path: str, at: float, force: bool = False) -> tuple[str, float]:
    import av
    import cv2

    if not os.path.exists(path):
        raise FileNotFoundError(f"Soubor neexistuje: {path}")

    out = cache_file("frames", path, {"at": round(at, 2)}).with_suffix(".jpg")
    if out.exists() and not force:
        return str(out), at

    container = av.open(path)
    vstream = container.streams.video[0]
    tb = vstream.time_base
    container.seek(int(at / tb), stream=vstream)
    frame = None
    for f in container.decode(vstream):
        if f.time is not None and f.time >= max(0, at - 0.5):
            frame = f
            break
    container.close()
    if frame is None:
        raise RuntimeError(f"Snímek v čase {at}s se nepodařilo najít (konec videa?): {path}")

    img = frame.to_ndarray(format="bgr24")
    out.parent.mkdir(parents=True, exist_ok=True)
    # cv2.imwrite neumí unikódové cesty na Windows (rozsype diakritiku) – zakódovat do bajtů
    # a zapsat přes normální Python I/O, to Unicode cesty zvládá správně.
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("Nepodařilo se zakódovat snímek do JPEG")
    out.write_bytes(buf.tobytes())
    log(f"frame: {os.path.basename(path)} @ {at:.2f}s -> {out.name}")
    return str(out), round(frame.time, 2)


def get_frame(params: dict, ctx) -> dict:
    file, t = _extract(params["path"], float(params.get("at", 0)), params.get("force", False))
    return {"file": file, "t": t}


def describe_frame(params: dict, ctx) -> dict:
    """Vytáhne snímek a rovnou ho popíše lokálním vision modelem (Qwen3-VL) – bez Claude kreditů."""
    file, t = _extract(params["path"], float(params.get("at", 0)), params.get("force", False))
    prompt = params.get("prompt") or (
        "Popiš stručně česky tenhle záběr z videa: kompozice, ostrost, kdo/co je v obraze, "
        "jak blízko, co je v pozadí. Jedna až dvě věty."
    )
    ctx.progress(0.3, "lokální vision model popisuje snímek")
    description = gpu.describe_image(file, prompt, params.get("maxTokens", 400))
    return {"file": file, "t": t, "description": description}
