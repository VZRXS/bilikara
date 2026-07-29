from __future__ import annotations

import os
import platform
import tempfile
import unittest
import urllib.request
from pathlib import Path

from tests.macos_smoke_process import CapturedProcess

ROOT_DIR = Path(__file__).resolve().parent.parent


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
                    30.0,
                )

                if not ready_url:
                    self.fail(
                        "Tauri app did not report the backend ready handshake.\n"
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
