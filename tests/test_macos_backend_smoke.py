from __future__ import annotations

import json
import math
import os
import platform
import secrets
import subprocess
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

    @unittest.skipUnless(os.name == "posix", "process-group cleanup requires POSIX signals")
    def test_cleanup_kills_descendant_group_after_leader_exits(self):
        script = (
            "import subprocess,sys; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
            "print(child.pid, flush=True)"
        )
        capture = self._start_fixture(script)
        child_pid = capture.wait_for_output(
            lambda name, line: (
                int(line.strip())
                if name == "stdout" and line.strip().isdigit()
                else None
            ),
            2.0,
        )
        self.assertIsInstance(child_pid, int)
        self.assertTrue(capture.wait_for_exit(2.0))
        self.assertTrue(capture._process_group_exists(capture.process.pid))

        self.assertTrue(capture.terminate_process_group(kill_timeout=2.0))
        self.assertFalse(capture._process_group_exists(capture.process.pid))


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
    def _packaged_backend_executable(self) -> Path:
        override_exe = os.getenv("BILIKARA_TEST_BACKEND_EXE", "").strip()
        if override_exe:
            return Path(override_exe).resolve()
        return ROOT_DIR / "dist" / "bilikara.app" / "Contents" / "MacOS" / "bilikara"

    def _require_packaged_backend_executable(self) -> Path:
        executable = self._packaged_backend_executable()
        if not executable.is_file():
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                raise AssertionError(f"Required backend executable not found: {executable}")
            raise unittest.SkipTest(
                f"Backend executable not found at {executable}; skipping smoke test."
            )
        if not os.access(executable, os.X_OK):
            raise AssertionError(f"Backend binary is not executable: {executable}")
        return executable

    @staticmethod
    def _assert_tool_version(binary_path: Path, tool_name: str, *, cwd: Path, env: dict[str, str]) -> None:
        process = subprocess.run(
            [str(binary_path), "-version"],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        output = (process.stdout or "") + (process.stderr or "")
        if process.returncode != 0 or f"{tool_name} version" not in output.lower():
            raise AssertionError(
                f"{tool_name} -version failed for {binary_path}\n"
                f"exit_code={process.returncode}\noutput={output}"
            )

    def test_packaged_ffmpeg_and_runtime_copy_execute(self):
        if platform.system() != "Darwin":
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                self.fail("Required packaged FFmpeg smoke test must run on macOS")
            raise unittest.SkipTest("Packaged FFmpeg smoke test requires macOS")

        executable = self._require_packaged_backend_executable()
        contents_dir = executable.parent.parent
        vendor_dir = contents_dir / "Frameworks" / "vendor"

        with tempfile.TemporaryDirectory(prefix="bilikara-ffmpeg-smoke-") as temp_dir_value:
            temp_dir = Path(temp_dir_value)
            runtime_dir = (
                temp_dir
                / "Library"
                / "Application Support"
                / "bilikara"
                / "tools"
                / "bbdown"
            )
            runtime_dir.mkdir(parents=True)
            minimal_env = {
                "HOME": str(temp_dir),
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": str(temp_dir),
            }

            from bilikara.cache import CacheManager

            for tool_name in ("ffmpeg", "ffprobe"):
                packaged_tool = vendor_dir / tool_name
                if not packaged_tool.is_file():
                    self.fail(f"Packaged {tool_name} not found: {packaged_tool}")
                if not os.access(packaged_tool, os.X_OK):
                    self.fail(f"Packaged {tool_name} is not executable: {packaged_tool}")
                self._assert_tool_version(
                    packaged_tool,
                    tool_name,
                    cwd=temp_dir,
                    env=minimal_env,
                )

                runtime_tool = runtime_dir / tool_name
                CacheManager._sync_runtime_tool(
                    packaged_tool,
                    runtime_tool,
                    force_refresh=True,
                )
                self.assertTrue(os.access(runtime_tool, os.X_OK))
                self._assert_tool_version(
                    runtime_tool,
                    tool_name,
                    cwd=temp_dir,
                    env=minimal_env,
                )

    def _run_packaged_tool_smoke(self, tool_name: str) -> tuple[dict, Path, dict[str, str]]:
        executable = self._require_packaged_backend_executable()
        home = os.getenv("HOME", "").strip()
        if not home:
            self.fail("Packaged tool smoke requires HOME")
        smoke_root = self._tool_smoke_root.resolve()
        app_home = (smoke_root / f"{tool_name}-app-home").resolve()
        app_home.mkdir(parents=True, exist_ok=True)
        minimal_env = {
            "BILIKARA_HOME": str(app_home),
            "HOME": home,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONUNBUFFERED": "1",
            "TMPDIR": str(smoke_root),
        }
        process = subprocess.run(
            [str(executable), "--tool-smoke", tool_name],
            cwd=smoke_root,
            env=minimal_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            check=False,
        )
        marker = None
        for line in process.stdout.splitlines():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and payload.get("event") == "bilikara.tool_smoke":
                marker = payload
                break
        if process.returncode != 0 or marker is None:
            self.fail(
                f"Packaged {tool_name} deployment smoke failed.\n"
                f"exit_code={process.returncode}\nstdout={process.stdout}\nstderr={process.stderr}"
            )
        self.assertEqual(marker.get("tool"), tool_name)
        runtime_path = Path(str(marker.get("path") or "")).resolve()
        self.assertTrue(runtime_path.is_file(), f"Runtime tool is missing: {runtime_path}")
        self.assertTrue(os.access(runtime_path, os.X_OK), f"Runtime tool is not executable: {runtime_path}")
        self.assertTrue(runtime_path.is_relative_to(app_home))
        return marker, runtime_path, minimal_env

    def test_packaged_bbdown_restores_offline_vendor_to_clean_runtime(self):
        if platform.system() != "Darwin":
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                self.fail("Required packaged BBDown smoke test must run on macOS")
            raise unittest.SkipTest("Packaged BBDown smoke test requires macOS")
        executable = self._require_packaged_backend_executable()
        vendor = executable.parent.parent / "Frameworks" / "vendor" / "BBDown"
        self.assertTrue(vendor.is_file(), f"Packaged BBDown vendor is missing: {vendor}")
        with tempfile.TemporaryDirectory(prefix="bilikara-bbdown-smoke-") as temp_dir:
            self._tool_smoke_root = Path(temp_dir)
            marker, runtime, env = self._run_packaged_tool_smoke("bbdown")
            process = subprocess.run(
                [str(runtime), "--help"],
                cwd=temp_dir,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            self.assertEqual(marker.get("version"), "1.6.3")

    def test_packaged_macos_aria2_prepares_on_demand_with_minimal_path(self):
        if platform.system() != "Darwin":
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                self.fail("Required packaged aria2c smoke test must run on macOS")
            raise unittest.SkipTest("Packaged aria2c smoke test requires macOS")
        with tempfile.TemporaryDirectory(prefix="bilikara-aria2-smoke-") as temp_dir:
            self._tool_smoke_root = Path(temp_dir)
            marker, runtime, env = self._run_packaged_tool_smoke("aria2c")
            process = subprocess.run(
                [str(runtime), "--version"],
                cwd=temp_dir,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                check=False,
            )
            output = (process.stdout or "") + (process.stderr or "")
            self.assertEqual(process.returncode, 0, output)
            self.assertIn("aria2 version 1.37.0", output)
            self.assertEqual(marker.get("version"), "1.37.0")

    def test_packaged_https_uses_macos_system_trust(self):
        if platform.system() != "Darwin":
            if os.getenv("BILIKARA_REQUIRE_BACKEND_SMOKE") == "1":
                self.fail("Required packaged HTTPS smoke test must run on macOS")
            raise unittest.SkipTest("Packaged HTTPS smoke test requires macOS")

        executable = self._require_packaged_backend_executable()
        home = os.getenv("HOME", "").strip()
        if not home:
            self.fail("Packaged HTTPS smoke test requires HOME for macOS system trust")

        with tempfile.TemporaryDirectory(prefix="bilikara-https-smoke-") as temp_dir:
            startup_log = Path(temp_dir) / "startup.log"
            minimal_env = {
                "BILIKARA_STARTUP_LOG": "1",
                "DEBUG_LOG_FILE": str(startup_log),
                "HOME": home,
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "PYTHONUNBUFFERED": "1",
                "TMPDIR": temp_dir,
            }
            process = subprocess.run(
                [str(executable), "--https-smoke"],
                cwd=temp_dir,
                env=minimal_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )
            marker = None
            for line in process.stdout.splitlines():
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict) and payload.get("event") == "bilikara.https_smoke":
                    marker = payload
                    break

            if process.returncode != 0 or marker is None:
                startup_text = (
                    startup_log.read_text(encoding="utf-8", errors="replace")
                    if startup_log.is_file()
                    else "<missing>"
                )
                self.fail(
                    "Packaged HTTPS smoke failed.\n"
                    f"exit_code={process.returncode}\n"
                    f"stdout={process.stdout}\n"
                    f"stderr={process.stderr}\n"
                    f"startup_log={startup_text}"
                )

            self.assertEqual(marker.get("trustBackend"), "macos-system")
            self.assertEqual(marker.get("verifyMode"), "CERT_REQUIRED")
            self.assertIs(marker.get("checkHostname"), True)
            self.assertGreaterEqual(int(marker.get("status", 0)), 200)
            self.assertLess(int(marker.get("status", 0)), 400)

    def test_backend_ready_handshake_and_graceful_shutdown(self):
        executable = self._require_packaged_backend_executable()

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
