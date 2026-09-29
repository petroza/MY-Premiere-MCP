"""Příprava médií pro Premiere: MKV/WebM -> MP4.

Premiere na MKV padá už při importu (x265 filmy z internetu, 2026-09-29) a poškozená data v souboru ji shodí
i později při přehrávání (Putin: vadný EBML blok na 56:31–56:34). Převod proto běží dřív, než soubor Premiere
vůbec uvidí:
  - obraz H.264/HEVC se jen přebalí (bez ztráty kvality; HEVC s tagem hvc1, jinak ho Premiere v MP4 nečte),
  - zvuk jiný než AAC se převede na AAC,
  - když demux hlásí poškozená data (nebo je obraz v kodeku, který MP4 neunese), obraz se překóduje – dekodér
    vadná políčka zamaskuje a Premiere dostane čistý soubor.
Časy zůstávají stejné jako v originálu (stejné pts), takže přepis originálu platí i pro převedený soubor.
Výstup: vedle originálu jako <název>.mp4; když se tam nevejde, cache/media/<klíč>/<název>.mp4 (viz _target).
"""
from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

import av

from .common import cache_dir, log, read_json, write_json

CONVERT_EXT = {".mkv", ".webm"}
COPY_VIDEO = {"h264", "hevc"}


def _key(path: str) -> str:
    st = os.stat(path)
    raw = f"{os.path.normcase(os.path.abspath(path))}|{st.st_size}|{int(st.st_mtime)}|v1"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _index_file() -> Path:
    return cache_dir("media") / "index.json"


def _remember(src: str, out: Path) -> None:
    f = _index_file()
    try:
        idx = read_json(f)
    except (OSError, ValueError):
        idx = {}
    idx[os.path.normcase(os.path.abspath(str(out)))] = os.path.abspath(src)
    write_json(f, idx)


def _convert(src: str, tmp: Path, reencode: bool, ctx) -> tuple[list[str], bool]:
    """Jeden průchod. Vrátí (chybové hlášky demuxeru/dekodéru – prázdné = čistý soubor, obraz jen přebalen)."""
    errors: list[str] = []
    # PyAV má log FFmpegu ve výchozím stavu vypnutý – bez toho Capture nic nezachytí a poškozené MKV
    # („invalid as first byte of an EBML number“) by prošlo jako čisté
    av.logging.set_level(av.logging.ERROR)
    with av.logging.Capture() as logs:
        inp = av.open(src)
        out = av.open(str(tmp), "w", format="mp4", options={"movflags": "+faststart"})
        try:
            # obal filmu (mjpeg „attached picture“) je taky obrazová stopa – ten ne
            vin = next((s for s in inp.streams.video
                        if not (s.disposition & av.stream.Disposition.attached_pic)
                        and s.codec_context.name not in ("mjpeg", "png")), None)
            ains = list(inp.streams.audio)
            if vin is None:
                raise ValueError("Soubor nemá obrazovou stopu.")
            dur = float(inp.duration / av.time_base) if inp.duration else 0.0
            if reencode or vin.codec_context.name not in COPY_VIDEO:
                vout = None
                for enc, opts in (("h264_nvenc", {"preset": "p5", "rc": "vbr", "cq": "19"}),
                                  ("libx264", {"preset": "fast", "crf": "18"})):
                    try:
                        vout = out.add_stream(enc, rate=vin.average_rate or 25)
                        vout.options = opts
                        break
                    except Exception:  # noqa: BLE001 – enkodér na tomhle stroji chybí, zkus další
                        vout = None
                vout.width = vin.codec_context.width
                vout.height = vin.codec_context.height
                vout.pix_fmt = "yuv420p"
                vout.time_base = vin.time_base
                v_copy = False
            else:
                vout = out.add_stream_from_template(vin)
                if vin.codec_context.name == "hevc":
                    vout.codec_tag = "hvc1"
                v_copy = True
            a_map = {}
            for a in ains:
                if a.codec_context.name == "aac":
                    a_map[a.index] = (out.add_stream_from_template(a), True)
                else:
                    ao = out.add_stream("aac", rate=a.codec_context.sample_rate or 48000)
                    ao.bit_rate = 256000
                    a_map[a.index] = (ao, False)
            last = -1.0
            for pkt in inp.demux([vin, *ains]):
                if pkt.dts is None and pkt.pts is None:
                    continue
                st = pkt.stream
                if st.index == vin.index:
                    if v_copy:
                        pkt.stream = vout
                        out.mux(pkt)
                    else:
                        try:
                            frames = pkt.decode()
                        except av.error.InvalidDataError as e:
                            errors.append(str(e))
                            continue
                        for fr in frames:
                            out.mux(vout.encode(fr.reformat(format="yuv420p")))
                    if pkt.pts is not None and dur:
                        t = float(pkt.pts * vin.time_base)
                        if t - last > 5:
                            last = t
                            ctx.progress(min(0.99, t / dur), f"{'překódování' if not v_copy else 'přebalení'} "
                                                             f"{t / 60:.0f}/{dur / 60:.0f} min")
                elif st.index in a_map:
                    ao, copy = a_map[st.index]
                    if copy:
                        pkt.stream = ao
                        out.mux(pkt)
                    else:
                        try:
                            for fr in pkt.decode():
                                fr.pts = None
                                out.mux(ao.encode(fr))
                        except av.error.InvalidDataError as e:
                            errors.append(str(e))
            if not v_copy:
                out.mux(vout.encode(None))
            for ao, copy in a_map.values():
                if not copy:
                    out.mux(ao.encode(None))
        finally:
            out.close()
            inp.close()
    errors += [f"{name}: {msg}" for level, name, msg in logs if level <= av.logging.ERROR]
    return errors, v_copy


def _ours(out: Path, src: str) -> bool:
    """Soubor vznikl naším převodem z tohoto originálu (a originál se od té doby nezměnil)."""
    try:
        idx = read_json(_index_file())
    except (OSError, ValueError):
        return False
    return (idx.get(os.path.normcase(os.path.abspath(str(out)))) == os.path.abspath(src)
            and out.stat().st_size > 0 and out.stat().st_mtime >= os.stat(src).st_mtime)


def _target(src: str) -> tuple[Path, str]:
    """Kam uložit MP4: vedle originálu (přání uživatele 2026-09-29), stejné jméno s .mp4. Cizí stejnojmenný soubor
    se nepřepíše („… (převedeno).mp4“). Když se tam převod nevejde (plný disk – D: měl 2 GB) nebo složka není
    zapisovatelná, jde do cache/media na disku s projektem. Vrací (cesta, důvod záložního umístění nebo "")."""
    s = Path(src)
    for name in (s.stem + ".mp4", s.stem + " (převedeno).mp4"):
        cand = s.with_name(name)
        if not cand.exists() or _ours(cand, src):
            break
    else:
        cand = None
    reason = ""
    if cand is None:
        reason = "vedle originálu už jsou stejnojmenné soubory"
    else:
        need = os.stat(src).st_size * 1.3 + 1e9  # překódování bývá větší než originál + rezerva
        try:
            free = shutil.disk_usage(s.parent).free
            if not cand.exists() and free < need:
                reason = f"na disku originálu je volno jen {free / 1e9:.1f} GB"
            elif not os.access(s.parent, os.W_OK):
                reason = "do složky originálu nejde zapisovat"
        except OSError as e:
            reason = f"složka originálu není dostupná ({e})"
    if reason:
        d = cache_dir("media") / _key(src)
        d.mkdir(parents=True, exist_ok=True)
        return d / (s.stem + ".mp4"), reason
    return cand, ""


def prepare(params: dict, ctx) -> dict:
    src = params["path"]
    if not os.path.isfile(src):
        raise FileNotFoundError(f"Soubor neexistuje: {src}")
    if Path(src).suffix.lower() not in CONVERT_EXT and not params.get("force"):
        return {"file": src, "converted": False}
    # dřívější převod do cache/media (před 2026-09-29) – projekty se na něj odkazují, nepřevádět znovu
    old = cache_dir("media") / _key(src) / (Path(src).stem + ".mp4")
    if old.exists() and old.stat().st_size > 0:
        _remember(src, old)
        return {"file": str(old), "converted": True, "cached": True}
    out, fallback = _target(src)
    if out.exists() and _ours(out, src):
        return {"file": str(out), "converted": True, "cached": True}
    if fallback:
        log(f"media: {Path(src).name} – {fallback}, ukládám do {out.parent}")
    tmp = out.with_name(out.stem + ".part.mp4")
    try:
        ctx.progress(0.0, "přebalení do MP4")
        errors, copied = _convert(src, tmp, reencode=bool(params.get("reencode")), ctx=ctx)
        damaged = errors[:5]
        if errors and copied:
            log(f"media: {Path(src).name} má poškozená data ({len(errors)}×, např. {errors[0][:120]}) – překódovávám obraz")
            ctx.progress(0.0, "soubor je poškozený – překódování obrazu")
            tmp.unlink(missing_ok=True)
            _, copied = _convert(src, tmp, reencode=True, ctx=ctx)
        os.replace(tmp, out)
    except BaseException:
        tmp.unlink(missing_ok=True)  # nedokončený soubor nenechávat vedle originálu
        raise
    _remember(src, out)
    return {"file": str(out), "converted": True, "cached": False, "videoCopied": copied, "damaged": damaged,
            "fallback": fallback or None}
