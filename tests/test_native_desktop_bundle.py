"""Native product layout and compiled installed-entry regressions."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_bundle
from scripts import native_desktop_bundle as builder
from scripts.check_native_desktop_bundle import RunningHost, check, isolated_environment, resources


class NativeBundleBuildTests(unittest.TestCase):
    def test_target_selection_rejects_host_target_mixing(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(builder.libav_bundle, "native_target", return_value="aarch64-apple-darwin"):
            self.assertIsNone(builder.selected_target(None))
            self.assertEqual(builder.selected_target("aarch64-apple-darwin"), "aarch64-apple-darwin")
            with self.assertRaisesRegex(RuntimeError, "matching target"):
                builder.selected_target("x86_64-apple-darwin")

    def test_cargo_profile_target_and_custom_output_directory_are_respected(self):
        with patch.object(builder.subprocess, "check_output", return_value=json.dumps({"target_directory": "/tmp/custom-output"})):
            self.assertEqual(builder.target_output("src-tauri", "debug", None), Path("/tmp/custom-output/debug"))
            self.assertEqual(builder.target_output("rust-runtime", "release", "x86_64-pc-windows-msvc"), Path("/tmp/custom-output/x86_64-pc-windows-msvc/release"))

    def test_native_libav_layout_keeps_dependency_closure_without_legacy_programs(self):
        from scripts import libav_bundle, windows_libav_preview
        for system, companion, dependency in [("Darwin", "libbilikara_media_libav.dylib", "libavcodec.63.dylib"), ("Windows", "bilikara_media_libav.dll", "avcodec-63.dll")]:
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                prefix, output = root / "prefix", root / "product"
                for name in ("bin", "licenses", "source"):
                    (prefix / name).mkdir(parents=True)
                files = [companion, dependency]
                for name in [*files, "ffmpeg"]:
                    (prefix / "bin" / name).write_bytes(b"native")
                (prefix / "bin/ffmpeg-runtime.json").write_text(json.dumps({"schema_version": 1,
                    "kind": "libav", "version": "9.0.1", "target": "fixture",
                    "runtime_files": files, "binaries": {n: {} for n in [*files, "ffmpeg"]},
                    "pe": {n: {} for n in [*files, "ffmpeg"]}}))
                with patch("platform.system", return_value=system), patch.object(libav_bundle, "binary_info", return_value={"imports": []}), patch.object(windows_libav_preview, "pe_info", return_value={"imports": []}):
                    libav_bundle.stage(prefix, output, native=True)
                vendor = output / ("Contents/Frameworks/vendor" if system == "Darwin" else "vendor")
                for name in files:
                    self.assertEqual((vendor / name).read_bytes(), b"native")
                self.assertFalse((vendor / "ffmpeg").exists())
                self.assertFalse((output / "_internal").exists())
                if system == "Darwin":
                    resource_vendor = output / "Contents/Resources/vendor"
                    self.assertTrue((resource_vendor / companion).is_symlink())
                    self.assertEqual((resource_vendor / companion).resolve(), vendor / companion)
                    self.assertTrue((vendor / "ffmpeg-runtime.json").is_symlink())

    def test_staging_selects_only_explicit_resources_and_native_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "static/fonts").mkdir(parents=True)
            (root / "static/fonts/font.ttf").write_bytes(b"font")
            (root / "start_bilikara.py").write_text("obsolete runtime")
            executable = root / "native"
            executable.write_bytes(b"native code")
            for system, name in [("Linux", "bilikara-desktop-host"), ("Windows", "bilikara-desktop-host.exe"), ("Darwin", "bilikara-desktop-host")]:
                with self.subTest(system=system), patch.object(build_bundle, "ROOT_DIR", root), patch.object(builder.platform, "system", return_value=system), patch.object(builder.libav_bundle, "native_target", return_value="x86_64-apple-darwin"), patch.object(build_bundle, "_bundle_version", return_value="v0.8.0-preview.2"), patch.object(build_bundle, "_resolved_bundle_binary_paths", return_value=({}, ["BBDown"])), patch.object(build_bundle, "_macos_aria2_metadata_args", return_value=[]):
                    output = root / system
                    builder.stage_resources(output, executable, development=True, macos_app=system == "Darwin", prefix=None)
                    code = output / "Contents/MacOS" if system == "Darwin" else output
                    assets = resources(code / name)
                    self.assertEqual((code / name).read_bytes(), b"native code")
                    self.assertTrue((assets / "static/fonts/font.ttf").is_file())
                    self.assertEqual(json.loads((assets / "native-desktop.json").read_text())["version"], "v0.8.0-preview.2")
                    self.assertFalse(list(output.rglob("*.py")))
                    self.assertFalse((assets / "rust").exists())
                    if system == "Darwin":
                        import plistlib
                        with (output / "Contents/Info.plist").open("rb") as handle:
                            info = plistlib.load(handle)
                        self.assertEqual(info["CFBundleExecutable"], "bilikara-desktop-host")
                        self.assertEqual(info["CFBundleShortVersionString"], "0.8.0")
                    # A shared CARGO_TARGET_DIR can already contain the backend
                    # at its destination. Preparing that layout is idempotent.
                    builder.stage_resources(output, code / name, development=True, macos_app=system == "Darwin", prefix=None)


@unittest.skipUnless(os.environ.get("BILIKARA_TEST_NATIVE_PACKAGE"), "Requires an actual staged release package")
class InstalledNativeDesktopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="relocated-native-package-")
        cls.root = Path(cls.temporary.name)
        original = Path(os.environ["BILIKARA_TEST_NATIVE_PACKAGE"]).resolve(strict=True)
        cls.package = cls.root / "Installed product 空"
        # Relocate all product files, without repository/build paths or helpers.
        source = original.parent.parent.parent if original.parent.name == "MacOS" else original.parent
        shutil.copytree(source, cls.package, symlinks=True)
        cls.executable = cls.package / original.relative_to(source)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_real_release_bootstrap_assets_sse_and_reopen_without_python(self):
        self.assertTrue(check(self.executable)["shutdownAndReopen"])

    def test_explicit_import_preserves_source_and_never_reimports_native_changes(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            home = Path(directory)
            source = home / "legacy"
            (source / "data").mkdir(parents=True)
            record = source / "data/player_state.json"
            record.write_text(json.dumps({"playback_mode": "local", "player_settings": {"volume_percent": 43}}))
            source_bytes = record.read_bytes()
            native = home / "native"
            args = ("--data-dir", str(native), "--import-from", str(source))
            host = RunningHost(self.executable, home, *args)
            try:
                self.assertEqual(host.api("/api/state")["player_settings"]["volume_percent"], 43)
            finally:
                host.close()
            self.assertEqual(source_bytes, record.read_bytes())
            record.write_text("malformed old records must not be read again")
            host = RunningHost(self.executable, home, *args)
            try:
                self.assertEqual(host.api("/api/state")["player_settings"]["volume_percent"], 43)
            finally:
                host.close()
            self.assertEqual(record.read_text(), "malformed old records must not be read again")

    def test_malformed_unmarked_and_legacy_roots_fail_without_enrollment(self):
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            home = Path(directory)
            root = home / "records"
            root.mkdir()
            (root / "data").mkdir()
            env = isolated_environment(home)
            failed = subprocess.run([str(self.executable), "--data-dir", str(root)], cwd=home, env=env, capture_output=True, timeout=30)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn(b"--import-from", failed.stderr)
            self.assertFalse((root / ".bilikara-desktop-rust-preview").exists())
            (root / ".bilikara-desktop-rust-preview").write_text("desktop-rust-preview-v1\n")
            (root / "host-state.json").write_text("broken native records")
            failed = subprocess.run([str(self.executable), "--data-dir", str(root)], cwd=home, env=env, capture_output=True, timeout=30)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual((root / "host-state.json").read_text(), "broken native records")

    def test_missing_or_incompatible_package_has_no_source_tree_fallback(self):
        assets = resources(self.executable)
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            home = Path(directory)
            for option in ("--data-dir", "--static-dir"):
                result = subprocess.run([str(self.executable), option], cwd=home, env=isolated_environment(home), capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"requires", result.stderr)
        for relative in ["native-desktop.json", "APP_VERSION", "static/app.js", "vendor/libbilikara_media_libav.so"]:
            target = assets / relative
            if not target.exists():
                continue  # The libav filename is platform specific.
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(dir=self.root) as directory:
                hidden = target.with_name(target.name + ".test-hidden")
                target.rename(hidden)
                try:
                    home = Path(directory)
                    result = subprocess.run([str(self.executable)], cwd=home, env=isolated_environment(home), capture_output=True, timeout=30)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn(b"bilikara.ready", result.stdout)
                finally:
                    hidden.rename(target)
        manifest = assets / "native-desktop.json"
        original = manifest.read_bytes()
        try:
            value = json.loads(original)
            value["arch"] = "incompatible"
            manifest.write_text(json.dumps(value))
            with tempfile.TemporaryDirectory(dir=self.root) as directory:
                home = Path(directory)
                result = subprocess.run([str(self.executable)], cwd=home, env=isolated_environment(home), capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"Incompatible", result.stderr)
        finally:
            manifest.write_bytes(original)
