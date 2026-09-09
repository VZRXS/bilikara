"""Test-only entry into normal Host/Runtime media calls, including in PyInstaller.

Synthetic fixture acquisition belongs to the existing M1-M5/Windows harness.
This adapter never activates libav, selects a companion, or simulates media I/O.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch


def run() -> str:
    from . import rust_runtime
    from .cache import CacheManager, DOWNLOAD_SOURCE_BBDOWN
    from .config import BACKUP_FILE, CACHE_DIR, PLAYED_SESSION_DIR, STATE_FILE, BB_DOWN_DIR
    from .store import PlaylistStore

    if not os.environ.get("BILIKARA_HOME"):
        raise RuntimeError("media smoke requires a disposable BILIKARA_HOME")
    fixtures = Path(os.environ["BILIKARA_LIBAV_FIXTURES"]).resolve(strict=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
    manager = CacheManager(PlaylistStore(STATE_FILE, BACKUP_FILE, PLAYED_SESSION_DIR), max_cache_items=0)
    records = []
    try:
        with tempfile.TemporaryDirectory(dir=CACHE_DIR, prefix="media-smoke-") as temporary:
            work = Path(temporary)
            log = work / "media.log"
            ffmpeg = rust_runtime.media_compatibility_tool("ffmpeg", None)
            if ffmpeg is None:
                raise RuntimeError("same-build CLI fixture path required")

            def measure(operation, call):
                before = log.read_text(encoding="utf-8").count("media_diagnostic: ") if log.exists() else 0
                # Observe real subprocess effects without replacing any media
                # operation. Runtime native calls cannot be implemented here.
                with patch("subprocess.run", wraps=subprocess.run) as commands:
                    result = call()
                if isinstance(result, dict) and "diagnostic" in result:
                    diagnostic = result["diagnostic"]
                else:
                    diagnostics = [json.loads(line.split("media_diagnostic: ", 1)[1])
                                   for line in log.read_text(encoding="utf-8").splitlines() if "media_diagnostic: " in line]
                    diagnostic = next(d for d in reversed(diagnostics[before:]) if d["operation"] == operation)
                if diagnostic["backend"] == "libav" and commands.call_count:
                    raise RuntimeError("successful libav operation repeated a CLI effect")
                if os.environ.get("BILIKARA_MEDIA_BACKEND") == "legacy" and diagnostic["backend"] == "libav":
                    raise RuntimeError("legacy rollback executed libav")
                records.append({**diagnostic, "cli_calls": commands.call_count})
                return result

            source = fixtures / "aac.m4a"
            measure("metadata", lambda: manager._probe_original_audio_duration(
                None, ffmpeg, source, label="synthetic", log_path=log))
            measure("packet_scan", lambda: manager._validate_demux_file(
                ffmpeg, source, label="synthetic", stream_kind="audio", log_path=log))
            validated = measure("validate", lambda: manager._validate_media_file(
                None, ffmpeg, source, label="synthetic", required_streams={"audio"}, log_path=log,
                diagnostic_context={"download_source": DOWNLOAD_SOURCE_BBDOWN, "stream_kind": "audio"}))
            if validated["backend"] == "libav" and validated["inspection_level"] != "packet_scan":
                raise RuntimeError("cache validation lost packet traversal")
            for name, kind, suffix, operation in [("video.mp4", "video", "mp4", "mp4"),
                ("aac.m4a", "audio", "m4a", "mp4"), ("flac.mp4", "audio", "flac", "flac")]:
                source = fixtures / name
                original = source.read_bytes()
                destination = work / ("normalized." + suffix)
                result = measure(operation, lambda: rust_runtime.normalize_media(
                    source=source, destination=destination, expected_kind=kind))
                if source.read_bytes() != original or not destination.is_file() or result["output"]["file_bytes"] != destination.stat().st_size:
                    raise RuntimeError("normalization did not preserve the source/candidate contract")
                if suffix == "flac" and destination.read_bytes()[:4] != b"fLaC":
                    raise RuntimeError("normalization did not produce native FLAC")
            return json.dumps({"event": "bilikara.media_smoke", "outcome": "success", "operations": records})
    finally:
        manager.shutdown()
