from __future__ import annotations

import math
import os
import platform
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tests.macos_smoke_process import CapturedProcess

ROOT_DIR = Path(__file__).resolve().parent.parent
TAURI_SMOKE_TIMEOUT_ENV = "BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS"
DEFAULT_TAURI_SMOKE_TIMEOUT_SECONDS = 90.0
MAX_TAURI_SMOKE_TIMEOUT_SECONDS = 300.0


def _tauri_smoke_timeout_seconds() -> float:
    raw_value = os.getenv(TAURI_SMOKE_TIMEOUT_ENV, "").strip()
    if not raw_value:
        return DEFAULT_TAURI_SMOKE_TIMEOUT_SECONDS
    try:
        timeout = float(raw_value)
    except ValueError as exc:
        raise AssertionError(f"{TAURI_SMOKE_TIMEOUT_ENV} must be a number") from exc
    if not math.isfinite(timeout) or timeout <= 0 or timeout > MAX_TAURI_SMOKE_TIMEOUT_SECONDS:
        raise AssertionError(
            f"{TAURI_SMOKE_TIMEOUT_ENV} must be greater than 0 and no greater than "
            f"{MAX_TAURI_SMOKE_TIMEOUT_SECONDS:g}"
        )
    return timeout


class TauriSmokeTimeoutPolicyTest(unittest.TestCase):
    def test_default_and_valid_override(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(TAURI_SMOKE_TIMEOUT_ENV, None)
            self.assertEqual(_tauri_smoke_timeout_seconds(), 90.0)
        with patch.dict(os.environ, {TAURI_SMOKE_TIMEOUT_ENV: "120.5"}):
            self.assertEqual(_tauri_smoke_timeout_seconds(), 120.5)

    def test_invalid_timeout_values_are_rejected(self):
        for value in ("0", "-1", "301", "nan", "not-a-number"):
            with self.subTest(value=value), patch.dict(
                os.environ, {TAURI_SMOKE_TIMEOUT_ENV: value}
            ):
                with self.assertRaisesRegex(AssertionError, TAURI_SMOKE_TIMEOUT_ENV):
                    _tauri_smoke_timeout_seconds()


class MacOSTauriSmokeTest(unittest.TestCase):
    def test_tauri_resolves_backend_and_completes_ready_handshake(self):
        required = os.getenv("BILIKARA_REQUIRE_TAURI_SMOKE") == "1"
        if platform.system() != "Darwin":
            if required:
                self.fail("Required Tauri smoke test must run on macOS")
            raise unittest.SkipTest("Tauri application smoke test requires macOS")

        override_exe = os.getenv("BILIKARA_TEST_TAURI_EXE", "").strip()
        executable = (
            Path(override_exe).resolve()
            if override_exe
            else ROOT_DIR
            / "dist_release"
            / "Bilikara-Desktop.app"
            / "Contents"
            / "MacOS"
            / "bilikara"
        )
        if not executable.is_file():
            if required:
                self.fail(f"Required Tauri executable not found: {executable}")
            raise unittest.SkipTest(f"Tauri executable not found: {executable}")
        if not os.access(executable, os.X_OK):
            self.fail(f"Tauri executable is not executable: {executable}")

        with tempfile.TemporaryDirectory(prefix="bilikara-tauri-smoke-") as unrelated_cwd:
            timeout_seconds = _tauri_smoke_timeout_seconds()
            start_time = time.monotonic()
            capture = CapturedProcess.start(
                [str(executable)],
                cwd=unrelated_cwd,
                env={**os.environ, "RUST_BACKTRACE": "1"},
            )
            ready_url = None
            try:
                marker = "Backend ready at "
                ready_url = capture.wait_for_output(
                    lambda name, line: (
                        line.split(marker, 1)[1].strip()
                        if name == "stdout" and marker in line
                        else None
                    ),
                    timeout_seconds,
                )

                if not ready_url:
                    elapsed = time.monotonic() - start_time
                    self.fail(
                        "Tauri app did not report the backend ready handshake.\n"
                        f"executable={executable}\n"
                        f"cwd={unrelated_cwd}\n"
                        f"timeout_configured={timeout_seconds}s\n"
                        f"elapsed={elapsed:.2f}s\n"
                        f"exit_code={capture.process.poll()}\n"
                        f"stdout={capture.captured_text('stdout')}\n"
                        f"stderr={capture.captured_text('stderr')}"
                    )

                with urllib.request.urlopen(f"{str(ready_url).rstrip('/')}/", timeout=5) as response:
                    self.assertEqual(response.status, 200)
                self.assertIsNone(capture.process.poll(), "Tauri exited immediately after backend readiness")
            finally:
                if not capture.terminate_process_group():
                    self.fail("Tauri process group did not terminate cleanly")


if __name__ == "__main__":
    unittest.main()
