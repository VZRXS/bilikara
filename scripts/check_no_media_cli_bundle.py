"""Verify the libav-only policy in the actual extracted frozen backend."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    executable = Path(sys.argv[1]).resolve(strict=True)
    # Inspect the real extracted package, not only subprocess admission.
    package = executable.parent
    for parent in executable.parents:
        if parent.suffix == ".app":
            package = parent
            break
    forbidden = [path for path in package.rglob("*") if path.is_file()
                 and path.name.lower() in {"ffmpeg", "ffprobe", "ffmpeg.exe", "ffprobe.exe"}]
    if forbidden:
        raise RuntimeError(f"Forbidden media CLI in bundle: {forbidden}")
    with tempfile.TemporaryDirectory(prefix="bilikara-no-cli-check-") as directory:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("BILIKARA_", "FFMPEG_", "FFPROBE_"))}
        report_path = Path(directory) / "no-cli-result.json"
        env.update(BILIKARA_HOME=directory, BILIKARA_DISABLE_MEDIA_CLI="0", BILIKARA_MEDIA_BACKEND="default",
                   BILIKARA_LIBAV_SMOKE_RESULT=str(report_path), DEBUG_LOG_FILE=str(Path(directory) / "startup.log"))
        env["PATH"] = directory  # No system or user media-tool discovery.
        result = subprocess.run([str(executable), "--tool-smoke", "no-media-cli"],
                                env=env, cwd=directory, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=120)
        if result.returncode:
            raise RuntimeError(f"Packaged CLI prohibition failed ({result.returncode}): {result.stdout}\n{result.stderr}")
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else None
        if not report or report.get("event") != "bilikara.no_media_cli_smoke" or report.get("disabled") is not True or set(report.get("blocked", [])) != {"ffmpeg", "ffprobe"}:
            raise RuntimeError(f"Missing packaged prohibition evidence: {result.stdout}\n{result.stderr}")
        if report.get("bbdown_executed") is not True:
            raise RuntimeError("Missing downloader execution evidence")
        if set(report.get("allowed", [])) != {"BBDown", "yt-dlp", "aria2c"}:
            raise RuntimeError("Download tools were not allowed")
        if len(report.get("media", [])) != 3 or any(d.get("backend") != "libav" or d.get("outcome") != "success" for d in report["media"]):
            raise RuntimeError(f"Missing packaged libav evidence: {report}")
        print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
