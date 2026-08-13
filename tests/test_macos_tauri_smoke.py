from __future__ import annotations

import json
import math
import os
import platform
import subprocess
import tempfile
import time
import tomllib
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tests.macos_smoke_process import CapturedProcess

ROOT_DIR = Path(__file__).resolve().parent.parent
TAURI_SMOKE_TIMEOUT_ENV = "BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS"
DEFAULT_TAURI_SMOKE_TIMEOUT_SECONDS = 90.0
MAX_TAURI_SMOKE_TIMEOUT_SECONDS = 300.0
FINDER_LIKE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
DESKTOP_STARTUP_LOG_NAME = "desktop-startup.log"


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


def _finder_like_environment(home: str, temp_dir: Path, startup_log: Path) -> dict[str, str]:
    return {
        "BILIKARA_DESKTOP_STARTUP_LOG": str(startup_log),
        "HOME": home,
        "PATH": FINDER_LIKE_PATH,
        "RUST_BACKTRACE": "1",
        "TMPDIR": str(temp_dir),
    }


def _read_startup_log(path: Path) -> str:
    if not path.is_file():
        return "<missing>"
    return path.read_text(encoding="utf-8", errors="replace")


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

    def test_finder_like_environment_is_minimal_and_preserves_home(self):
        environment = _finder_like_environment(
            "/Users/runner",
            Path("/tmp/finder-smoke"),
            Path("/tmp/finder-smoke/desktop-startup.log"),
        )

        self.assertEqual(environment["HOME"], "/Users/runner")
        self.assertEqual(environment["PATH"], FINDER_LIKE_PATH)
        self.assertEqual(
            set(environment),
            {
                "BILIKARA_DESKTOP_STARTUP_LOG",
                "HOME",
                "PATH",
                "RUST_BACKTRACE",
                "TMPDIR",
            },
        )


class MacOSTauriAutoplayConfigurationTest(unittest.TestCase):
    def test_macos_defers_exactly_one_configured_main_window(self):
        base_config = json.loads(
            (ROOT_DIR / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        macos_config = json.loads(
            (ROOT_DIR / "src-tauri" / "tauri.macos.conf.json").read_text(
                encoding="utf-8"
            )
        )
        capability = json.loads(
            (ROOT_DIR / "src-tauri" / "capabilities" / "main.json").read_text(
                encoding="utf-8"
            )
        )
        base_windows = [
            window
            for window in base_config["app"]["windows"]
            if window["label"] == "main"
        ]
        macos_windows = [
            window
            for window in macos_config["app"]["windows"]
            if window["label"] == "main"
        ]

        self.assertEqual(len(base_windows), 1)
        self.assertEqual(len(macos_windows), 1)
        self.assertNotIn("create", base_windows[0])
        self.assertFalse(macos_windows[0]["create"])
        self.assertEqual(
            {key: value for key, value in macos_windows[0].items() if key != "create"},
            base_windows[0],
        )
        self.assertEqual(capability["windows"], ["main"])

    def test_macos_main_webview_uses_creation_time_autoplay_policy(self):
        source = (ROOT_DIR / "src-tauri" / "src" / "main.rs").read_text(
            encoding="utf-8"
        )
        configuration_start = source.index("fn macos_autoplay_webview_configuration")
        creation_start = source.index("fn create_macos_main_webview_window")
        main_start = source.index("fn main()")
        configuration = source[configuration_start:creation_start]
        creation = source[creation_start:main_start]
        setup_start = source.index(".setup(move |app| {")
        backend_start = source.index("let mut resolution", setup_start)
        setup = source[setup_start:backend_start]

        self.assertIn('#[cfg(target_os = "macos")]', source[:configuration_start][-80:])
        self.assertIn("WKWebViewConfiguration::new(main_thread)", configuration)
        self.assertIn(
            ".setMediaTypesRequiringUserActionForPlayback(", configuration
        )
        self.assertIn("WKAudiovisualMediaTypes::None", configuration)
        self.assertIn('#[cfg(target_os = "macos")]', source[:creation_start][-80:])
        self.assertIn('app.get_webview_window("main").is_some()', creation)
        self.assertIn('.find(|config| config.label == "main")', creation)
        self.assertIn("WebviewWindowBuilder::from_config", creation)
        self.assertIn(".with_webview_configuration(", creation)
        self.assertEqual(creation.count(".build()?;"), 1)
        self.assertIn('#[cfg(target_os = "macos")]', setup)
        self.assertLess(
            setup.index("create_macos_main_webview_window(app)?;"),
            setup.index('app.get_webview_window("main")'),
        )

    def test_native_dependencies_remain_pinned_to_the_locked_graph(self):
        cargo_toml = tomllib.loads(
            (ROOT_DIR / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
        )
        cargo_lock = tomllib.loads(
            (ROOT_DIR / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
        )
        macos_dependencies = cargo_toml["target"][
            'cfg(target_os = "macos")'
        ]["dependencies"]
        self.assertEqual(macos_dependencies["objc2"], "=0.6.4")
        self.assertEqual(macos_dependencies["objc2-web-kit"]["version"], "=0.3.2")
        self.assertFalse(macos_dependencies["objc2-web-kit"]["default-features"])
        self.assertEqual(
            macos_dependencies["objc2-web-kit"]["features"],
            ["std", "WKWebViewConfiguration"],
        )

        locked_versions = {
            package["name"]: package["version"] for package in cargo_lock["package"]
        }
        self.assertEqual(locked_versions["tauri"], "2.11.2")
        self.assertEqual(locked_versions["tauri-runtime-wry"], "2.11.2")
        self.assertEqual(locked_versions["wry"], "0.55.1")
        self.assertEqual(locked_versions["objc2"], "0.6.4")
        self.assertEqual(locked_versions["objc2-web-kit"], "0.3.2")


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
        source_app = executable.parent.parent.parent
        embedded_relative = Path(
            "Contents/Frameworks/bilikara-backend.app/Contents/MacOS/bilikara"
        )
        source_embedded_backend = source_app / embedded_relative
        if not source_embedded_backend.is_file():
            self.fail(f"Embedded backend executable is missing: {source_embedded_backend}")
        if not os.access(source_embedded_backend, os.X_OK):
            self.fail(f"Embedded backend is not executable: {source_embedded_backend}")

        home = os.getenv("HOME", "").strip()
        if not home:
            self.fail("Tauri smoke test requires HOME for Finder-like launch coverage")

        with tempfile.TemporaryDirectory(prefix="bilikara-tauri-smoke-") as smoke_root:
            timeout_seconds = _tauri_smoke_timeout_seconds()
            smoke_root_path = Path(smoke_root)
            for profile_name in ("shell-environment", "finder-like-environment"):
                with self.subTest(profile=profile_name):
                    profile_root = smoke_root_path / profile_name
                    isolated_dir = profile_root / "isolated-app"
                    isolated_app = isolated_dir / "Bilikara-Desktop.app"
                    isolated_dir.mkdir(parents=True)
                    copied = subprocess.run(
                        ["/usr/bin/ditto", str(source_app), str(isolated_app)],
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        check=False,
                    )
                    self.assertEqual(copied.returncode, 0, copied.stdout + copied.stderr)
                    isolated_executable = (
                        isolated_app / "Contents" / "MacOS" / "bilikara"
                    )
                    isolated_backend = isolated_app / embedded_relative
                    self.assertTrue(isolated_executable.is_file())
                    self.assertTrue(os.access(isolated_executable, os.X_OK))
                    self.assertTrue(isolated_backend.is_file())
                    self.assertTrue(os.access(isolated_backend, os.X_OK))
                    self.assertFalse(
                        (isolated_dir / "bilikara.app").exists(),
                        "isolated Desktop smoke must not have a sibling backend app",
                    )

                    unrelated_cwd = profile_root / "unrelated-cwd"
                    unrelated_cwd.mkdir()
                    startup_log = unrelated_cwd / DESKTOP_STARTUP_LOG_NAME
                    if profile_name == "finder-like-environment":
                        launch_env = _finder_like_environment(
                            home,
                            unrelated_cwd,
                            startup_log,
                        )
                    else:
                        launch_env = {
                            **os.environ,
                            "BILIKARA_DESKTOP_STARTUP_LOG": str(startup_log),
                            "RUST_BACKTRACE": "1",
                        }

                    start_time = time.monotonic()
                    capture = CapturedProcess.start(
                        [str(isolated_executable)],
                        cwd=unrelated_cwd,
                        env=launch_env,
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
                                f"profile={profile_name}\n"
                                f"executable={isolated_executable}\n"
                                f"cwd={unrelated_cwd}\n"
                                f"timeout_configured={timeout_seconds}s\n"
                                f"elapsed={elapsed:.2f}s\n"
                                f"exit_code={capture.process.poll()}\n"
                                f"stdout={capture.captured_text('stdout')}\n"
                                f"stderr={capture.captured_text('stderr')}\n"
                                f"startup_log={_read_startup_log(startup_log)}"
                            )

                        with urllib.request.urlopen(
                            f"{str(ready_url).rstrip('/')}/", timeout=5
                        ) as response:
                            self.assertEqual(response.status, 200)
                        self.assertIsNone(
                            capture.process.poll(),
                            "Tauri exited immediately after backend readiness",
                        )

                        startup_text = _read_startup_log(startup_log)
                        self.assertNotEqual(startup_text, "<missing>")
                        self.assertIn("event=desktop_start", startup_text)
                        self.assertIn("event=backend_resolved", startup_text)
                        self.assertIn("candidate_type=macos-embedded-backend", startup_text)
                        self.assertIn("candidate_exists=true", startup_text)
                        self.assertIn("candidate_executable=true", startup_text)
                        self.assertIn("event=backend_spawn status=ok child_pid=", startup_text)
                        self.assertIn("event=backend_ready", startup_text)
                        self.assertIn("ready_marker_received=true", startup_text)
                        self.assertNotIn("event=packaged_backend_missing", startup_text)
                        for sensitive_marker in (
                            "Authorization:",
                            "BILIKARA_SHUTDOWN_TOKEN",
                            "Cookie:",
                            "SESSDATA=",
                            "qrcode_key=",
                        ):
                            self.assertNotIn(sensitive_marker, startup_text)
                    finally:
                        if not capture.terminate_process_group():
                            self.fail(
                                f"Tauri process group did not terminate cleanly ({profile_name})"
                            )


if __name__ == "__main__":
    unittest.main()
