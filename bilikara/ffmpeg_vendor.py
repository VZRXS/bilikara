"""Windows preview vendor manifest validation; file-copy glue, no media policy."""
from __future__ import annotations

import json
from pathlib import Path

MANIFEST = "ffmpeg-runtime.json"


def runtime_files(vendor: Path) -> list[Path] | None:
    manifest = vendor / MANIFEST
    if not manifest.is_file():
        return None
    data = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Invalid Windows preview FFmpeg manifest")
    names = data.get("runtime_files")
    if (data.get("schema_version") != 1 or data.get("version") != "9.0.1"
            or data.get("target") != "x86_64-pc-windows-msvc"
            or not isinstance(names, list) or len(names) > 64 or not all(isinstance(n, str) for n in names)
            or not {"ffmpeg.exe", "ffprobe.exe"}.issubset(names)):
        raise RuntimeError("Invalid Windows preview FFmpeg manifest")
    files = []
    for name in names:
        if (not isinstance(name, str) or not name.isascii()
                or any(c in name for c in '/\\:') or name in {".", ".."}
                or not name.lower().endswith((".exe", ".dll"))):
            raise RuntimeError("Invalid Windows preview runtime filename")
        path = vendor / name
        if not path.is_file() or path.resolve().parent != vendor.resolve():
            raise RuntimeError("Windows preview FFmpeg runtime dependency is missing")
        files.append(path)
    if len(set(names)) != len(names) or not any(n.startswith("avcodec-") for n in names):
        raise RuntimeError("Incomplete Windows preview FFmpeg manifest")
    return files
