"""Packaged shared FFmpeg manifest validation; file-copy glue, no media policy."""
from __future__ import annotations

import json
import re
from pathlib import Path

MANIFEST = "ffmpeg-runtime.json"


def runtime_files(vendor: Path) -> list[Path] | None:
    manifest = vendor / MANIFEST
    if not manifest.is_file():
        return None
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Invalid packaged FFmpeg manifest")
    names = data.get("runtime_files")
    target = data.get("target", "")
    targets = {f"{arch}-{suffix}" for arch in ("x86_64", "aarch64")
               for suffix in ("pc-windows-msvc", "apple-darwin", "unknown-linux-gnu")}
    windows = isinstance(target, str) and target.endswith("-windows-msvc")
    tools = {"ffmpeg.exe", "ffprobe.exe"} if windows else {"ffmpeg", "ffprobe"}
    if (data.get("schema_version") != 1 or data.get("version") != "9.0.1"
            or not isinstance(target, str) or target not in targets
            or not isinstance(names, list) or len(names) > 64 or not all(isinstance(n, str) for n in names)
            or not tools.issubset(names)):
        raise RuntimeError("Invalid packaged FFmpeg manifest")
    files = []
    for name in names:
        if (not isinstance(name, str) or not name.isascii()
                or any(c in name for c in '/\\:') or name in {".", ".."}
                or not (name in tools or (windows and name.lower().endswith(".dll"))
                        or (not windows and re.fullmatch(r"lib[A-Za-z0-9_.-]+(?:\.dylib|\.so(?:\.[0-9]+)*)", name)))):
            raise RuntimeError("Invalid packaged runtime filename")
        path = vendor / name
        if not path.is_file() or path.resolve().parent != vendor.resolve():
            raise RuntimeError("Packaged FFmpeg runtime dependency is missing")
        files.append(path)
    if len(set(names)) != len(names) or not any(n.startswith("avcodec-" if windows else "libavcodec.") for n in names):
        raise RuntimeError("Incomplete packaged FFmpeg manifest")
    return files
