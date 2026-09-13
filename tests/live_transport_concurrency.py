#!/usr/bin/env python3
"""Isolated real Chromium/WebRTC + HTTP/FFI baseline; nonzero for contract failures."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bilikara-concurrency-browser-") as home:
        os.environ.update(BILIKARA_HOME=home, BILIKARA_REQUIRE_RUST_LIB="1")
        from tests.live_immutable_recache_acceptance import _chromium_executable, _playwright_module_root
        from tests.test_transport_concurrency import DesktopFixture
        # A seekable synthetic clip, never remote media or production catalog data.
        media = output / "synthetic.webm"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=0x224466:s=640x360:r=10:d=60",
            "-c:v", "libvpx", "-deadline", "realtime", "-pix_fmt", "yuv420p", str(media)], check=True)
        with DesktopFixture(media_path=media) as fixture:
            env = dict(os.environ, NODE_PATH=str(_playwright_module_root(None)))
            result = subprocess.run(["node", str(ROOT / "tests/live_transport_concurrency.js"),
                fixture.base, str(_chromium_executable(None)), str(output)],
                env=env, cwd=ROOT, capture_output=True, text=True, timeout=150)
        (output / "browser.stdout.log").write_text(result.stdout)
        (output / "browser.stderr.log").write_text(result.stderr)
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
