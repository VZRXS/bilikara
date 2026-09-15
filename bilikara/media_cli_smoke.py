"""Packaged experiment proof: blocked real spawn attempts + real libav reads."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
from pathlib import Path


def run() -> str:
    from . import media_cli, rust_runtime
    from .cache import CacheManager
    from .config import VENDOR_DIR, INTERNAL_VENDOR_DIR

    if not media_cli.DISABLED:
        raise RuntimeError("This is not a no-media-CLI build")
    blocked = []
    for tool in ("ffmpeg", "ffprobe"):
        try:
            subprocess.run([tool, "-version"], check=True, capture_output=True, timeout=2)
        except media_cli.MediaCliDisabledError:
            blocked.append(tool)
        else:
            raise RuntimeError(f"External media process was not blocked: {tool}")
    manager = CacheManager.__new__(CacheManager)
    for prepare in (manager._ensure_ffmpeg,):
        try:
            prepare()
        except media_cli.MediaCliDisabledError:
            pass
        else:
            raise RuntimeError("External media preparation was not blocked")
    for tool in ("BBDown", "yt-dlp", "aria2c"):
        media_cli.require_media_cli(tool)
    suffix = ".exe" if os.name == "nt" else ""
    bbdown = next((directory / ("BBDown" + suffix) for directory in (VENDOR_DIR, INTERNAL_VENDOR_DIR)
                   if (directory / ("BBDown" + suffix)).is_file()), None)
    if bbdown is None:
        raise RuntimeError("Bundled BBDown is missing")
    subprocess.run([str(bbdown), "--help"], check=True, capture_output=True, timeout=30)
    # Reuse media_backend.rs::REAL_FLAC_FIXTURE_BASE64. No encoder CLI is needed
    # to create this accepted single-frame synthetic FLAC test input.
    sample = base64.b64decode("ZkxhQ4AAACISABIAAAANAAANC7gA8AAAA8A9oVgtoi71SQek9M1tXRpg//h6CAADv8wAAAADsg==")
    diagnostics = []
    with tempfile.TemporaryDirectory(prefix="bilikara-no-cli-") as directory:
        source = Path(directory) / "synthetic.flac"
        source.write_bytes(sample)
        for operation in ("metadata", "validate", "packet_scan"):
            result = rust_runtime.inspect_media(source=source, expected_kind="audio", operation=operation)
            if result.get("action") != "completed" or result["diagnostic"]["backend"] != "libav":
                raise RuntimeError(f"Packaged libav did not complete {operation}: {result}")
            diagnostics.append(result["diagnostic"])
    report = json.dumps({"event": "bilikara.no_media_cli_smoke", "disabled": True,
                         "blocked": blocked, "allowed": ["BBDown", "yt-dlp", "aria2c"],
                         "bbdown_executed": True, "media": diagnostics}, ensure_ascii=False)
    # Windowed Windows backends may have no usable stdout handle. Reuse the
    # existing packaged-smoke result path convention as the durable evidence.
    result_path = os.environ.get("BILIKARA_LIBAV_SMOKE_RESULT")
    if result_path:
        Path(result_path).write_text(report, encoding="utf-8")
    return report
