from __future__ import annotations

import json
import math
import os
import platform
import secrets
import sys
import tempfile
import time
import urllib.request
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

from tests.macos_smoke_process import CapturedProcess

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_SMOKE_TIMEOUT_ENV = "BILIKARA_BACKEND_SMOKE_TIMEOUT_SECONDS"
DEFAULT_BACKEND_SMOKE_TIMEOUT_SECONDS = 60.0
MAX_BACKEND_SMOKE_TIMEOUT_SECONDS = 300.0


def _backend_smoke_timeout_seconds() -> float:
    raw_value = os.getenv(BACKEND_SMOKE_TIMEOUT_ENV, "").strip()
    if not raw_value:
        return DEFAULT_BACKEND_SMOKE_TIMEOUT_SECONDS
    try:
        timeout = float(raw_value)
    except ValueError as exc:
        raise AssertionError(f"{BACKEND_SMOKE_TIMEOUT_ENV} must be a number") from exc
    if not math.isfinite(timeout) or timeout <= 0 or timeout > MAX_BACKEND_SMOKE_TIMEOUT_SECONDS:
        raise AssertionError(
            f"{BACKEND_SMOKE_TIMEOUT_ENV} must be greater than 0 and no greater than "
            f"{MAX_BACKEND_SMOKE_TIMEOUT_SECONDS:g}"
        )
    return timeout


def _ready_event_from_output(stream_name: str, line: str) -> dict | None:
    if stream_name != "stdout":
        return None
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict) and parsed.get("event") == "bilikara.ready":
        return parsed
    return None


def _failure_report(capture: CapturedProcess, startup_log_path: Path) -> str:
    startup_log = ""
    if startup_log_path.is_file():
        try:
            startup_log = startup_log_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            startup_log = f"<unable to read startup log: {exc}>"
    return (
        f"exit_code={capture.process.poll()}\n"
        f"Captured stdout:\n{capture.captured_text('stdout')}\n"
        f"Captured stderr:\n{capture.captured_text('stderr')}\n"
        f"Startup log path: {startup_log_path}\n"
        f"Startup log:\n{startup_log}"
    )


class SmokeProcessReaderTest(unittest.TestCase):
    def _start_fixture(self, script: str) -> CapturedProcess:
        return CapturedProcess.start([sys.executable, "-u", "-c", script])

    def test_reads_status_before_ready_json(self):
        capture = self._start_fixture(
            "import json; print('starting', flush=True); "
            "print(json.dumps({'event':'bilikara.ready','port':1}), flush=True)"
        )
        try:
            ready = capture.wait_for_output(_ready_event_from_output, 2.0)
            self.assertEqual(ready["port"], 1)
            self.assertIn("starting", capture.captured_text("stdout"))
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_detects_delayed_ready_json(self):
        capture = self._start_fixture(
            "import json,time; time.sleep(0.15); "
            "print(json.dumps({'event':'bilikara.ready','port':2}), flush=True)"
        )
        try:
            ready = capture.wait_for_output(_ready_event_from_output, 2.0)
            self.assertEqual(ready["port"], 2)
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_drains_stderr_concurrently(self):
        capture = self._start_fixture(
            "import json,sys; print('warning', file=sys.stderr, flush=True); "
            "print(json.dumps({'event':'bilikara.ready','port':3}), flush=True)"
        )
        try:
            ready = capture.wait_for_output(_ready_event_from_output, 2.0)
            self.assertEqual(ready["port"], 3)
        finally:
            self.assertTrue(capture.terminate_process_group())
        self.assertIn("warning", capture.captured_text("stderr"))

    def test_reports_process_exit_before_ready(self):
        capture = self._start_fixture("import sys; print('before exit', flush=True); sys.exit(7)")
        try:
            self.assertIsNone(capture.wait_for_output(_ready_event_from_output, 2.0))
            self.assertTrue(capture.wait_for_exit(1.0))
            self.assertEqual(capture.process.returncode, 7)
            self.assertIn("before exit", capture.captured_text("stdout"))
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_cleanup_is_idempotent_after_process_exit(self):
        capture = self._start_fixture("print('done', flush=True)")
        self.assertTrue(capture.wait_for_exit(2.0))
        self.assertTrue(capture.terminate_process_group())
        self.assertTrue(capture.terminate_process_group())

    @unittest.skipUnless(os.name == "posix", "process-group cleanup requires POSIX signals")
    def test_posix_permission_error_for_live_process_returns_false(self):
        capture = self._start_fixture("import time; time.sleep(30)")
        try:
            with patch("tests.macos_smoke_process.os.killpg", side_effect=PermissionError):
                self.assertFalse(capture.terminate_process_group())
            self.assertIsNone(capture.process.poll())

            with (
                patch.object(capture, "_wait_for_process_group_exit", return_value=False),
                patch(
                    "tests.macos_smoke_process.os.killpg",
                    side_effect=[None, PermissionError],
                ),
            ):
                self.assertFalse(capture.terminate_process_group())
            self.assertIsNone(capture.process.poll())
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_closed_streams_do_not_wait_unboundedly_for_live_process(self):
        capture = self._start_fixture(
            "import os,time; os.close(1); os.close(2); time.sleep(30)"
        )
        started = time.monotonic()
        try:
            self.assertIsNone(capture.wait_for_output(_ready_event_from_output, 2.0))
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertIsNone(capture.process.poll())
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_timeout_is_bounded_when_ready_never_arrives(self):
        capture = self._start_fixture("import time; print('waiting', flush=True); time.sleep(30)")
        started = time.monotonic()
        try:
            self.assertIsNone(capture.wait_for_output(_ready_event_from_output, 0.2))
            self.assertLess(time.monotonic() - started, 1.0)
        finally:
            self.assertTrue(capture.terminate_process_group())

    def test_ignores_malformed_json_before_valid_ready_json(self):
        capture = self._start_fixture(
            "import json; print('{malformed', flush=True); "
            "print(json.dumps({'event':'bilikara.ready','port':4}), flush=True)"
        )
        try:
            ready = capture.wait_for_output(_ready_event_from_output, 2.0)
            self.assertEqual(ready["port"], 4)
        finally:
            self.assertTrue(capture.terminate_process_group())

    @unittest.skipUnless(os.name == "posix", "process-group cleanup requires POSIX signals")
    def test_timeout_cleanup_kills_complete_process_group(self):
        script = (
            "import os,signal,subprocess,sys,time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "child=subprocess.Popen([sys.executable,'-c',"
            "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)']); "
            "print(child.pid, flush=True); time.sleep(30)"
        )
        capture = self._start_fixture(script)
        child_pid = None
        try:
            child_pid = capture.wait_for_output(
                lambda name, line: (
                    int(line.strip())
                    if name == "stdout" and line.strip().isdigit()
                    else None
                ),
                2.0,
            )
            self.assertIsInstance(child_pid, int)
        finally:
            cleaned_up = capture.terminate_process_group(
                terminate_timeout=0.1,
                kill_timeout=2.0,
            )
        self.assertTrue(cleaned_up)
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail(f"child process {child_pid} survived process-group cleanup")


class BackendSmokeTimeoutPolicyTest(unittest.TestCase):
    def test_default_and_valid_override(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(BACKEND_SMOKE_TIMEOUT_ENV, None)
            self.assertEqual(_backend_smoke_timeout_seconds(), 60.0)
        with patch.dict(os.environ, {BACKEND_SMOKE_TIMEOUT_ENV: "12.5"}):
            self.assertEqual(_backend_smoke_timeout_seconds(), 12.5)

    def test_invalid_timeout_values_are_rejected(self):
        for value in ("0", "-1", "301", "nan", "not-a-number"):
            with self.subTest(value=value), patch.dict(
                os.environ, {BACKEND_SMOKE_TIMEOUT_ENV: value}
            ):
                with self.assertRaisesRegex(AssertionError, BACKEND_SMOKE_TIMEOUT_ENV):
                    _backend_smoke_timeout_seconds()


class MacOSBackendSmokeTest(unittest.TestCase):
    def test_backend_ready_handshake_and_graceful_shutdown(self):
        override_exe = os.getenv("BILIKARA_TEST_BACKEND_EXE", "").strip()
        if override_exe:
            executable = Path(override_exe).resolve()
        else:
            executable = ROOT_DIR / "dist" / "bilikara.app" / "Contents" / "MacOS" / "bilikara"

        if not executable.is_file():
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                raise AssertionError(f"Required backend executable not found: {executable}")
            raise unittest.SkipTest(
                f"Backend executable not found at {executable}; skipping smoke test."
            )

        if not os.access(executable, os.X_OK):
            raise AssertionError(f"Backend binary is not executable: {executable}")

        shutdown_token = secrets.token_urlsafe(32)
        cmd = [
            str(executable),
            "--no-browser",
            "--headless",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
        ]
        env = os.environ.copy()
        env["BILIKARA_SHUTDOWN_TOKEN"] = shutdown_token
        env["BILIKARA_STARTUP_LOG"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        env["BILIKARA_LAUNCH_MODE"] = "tauri"

        with tempfile.TemporaryDirectory(prefix="bilikara-backend-smoke-") as temp_dir:
            startup_log_path = Path(temp_dir) / "startup.log"
            env["DEBUG_LOG_FILE"] = str(startup_log_path)
            capture = CapturedProcess.start(cmd, env=env)
            failure: BaseException | None = None
            cleanup_error: Exception | None = None
            cleaned_up = False
            try:
                ready_data = capture.wait_for_output(
                    _ready_event_from_output,
                    _backend_smoke_timeout_seconds(),
                )
                if not isinstance(ready_data, dict):
                    if capture.process.poll() is None:
                        raise AssertionError("Backend did not emit bilikara.ready before the timeout")
                    raise AssertionError(
                        f"Backend exited before emitting bilikara.ready (exit_code={capture.process.returncode})"
                    )

                if ready_data.get("event") != "bilikara.ready":
                    raise AssertionError(f"Unexpected ready event: {ready_data.get('event')!r}")
                port = ready_data.get("port")
                base_url = ready_data.get("baseUrl")
                if isinstance(port, bool) or not isinstance(port, int) or port <= 0:
                    raise AssertionError(f"Invalid backend ready port: {port!r}")
                if not isinstance(base_url, str):
                    raise AssertionError(f"Invalid backend baseUrl: {base_url!r}")
                parsed_base_url = urlparse(base_url)
                if (
                    parsed_base_url.scheme != "http"
                    or parsed_base_url.hostname != "127.0.0.1"
                    or parsed_base_url.port != port
                    or parsed_base_url.path not in {"", "/"}
                ):
                    raise AssertionError(f"Backend baseUrl is not the reported local endpoint: {base_url!r}")

                with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/health", timeout=5) as response:
                    health = json.load(response)
                    if response.status != 200 or health != {"ok": True, "status": "ready"}:
                        raise AssertionError(f"Unexpected backend health response: {health!r}")

                shutdown_url = f"{base_url.rstrip('/')}/api/app/shutdown"
                request = urllib.request.Request(
                    shutdown_url,
                    data=b"{}",
                    headers={
                        "Content-Type": "application/json",
                        "X-Bilikara-Shutdown-Token": shutdown_token,
                    },
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    if response.status != 200:
                        raise AssertionError(f"Unexpected shutdown response status: {response.status}")
                if not capture.wait_for_exit(15.0):
                    raise AssertionError("Backend process did not exit after authenticated shutdown")
            except BaseException as exc:
                failure = exc
            finally:
                try:
                    cleaned_up = capture.terminate_process_group()
                except Exception as exc:
                    cleanup_error = exc

            if failure is not None:
                cleanup_report = f"cleanup_succeeded={cleaned_up}"
                if cleanup_error is not None:
                    cleanup_report += f"\ncleanup_error={cleanup_error!r}"
                raise AssertionError(
                    f"{failure}\n{cleanup_report}\n{_failure_report(capture, startup_log_path)}"
                ) from failure
            if cleanup_error is not None:
                raise AssertionError(
                    "Backend process cleanup raised unexpectedly.\n"
                    f"cleanup_succeeded={cleaned_up}\n"
                    f"cleanup_error={cleanup_error!r}\n"
                    + _failure_report(capture, startup_log_path)
                ) from cleanup_error
            if not cleaned_up:
                raise AssertionError(
                    "Backend process group did not terminate cleanly.\n"
                    f"cleanup_succeeded={cleaned_up}\n"
                    + _failure_report(capture, startup_log_path)
                )


if __name__ == "__main__":
    unittest.main()
