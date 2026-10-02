"""Independent old/new development-preparation contract, using native fixtures.

Python is only the reference/test driver. The Rust command's descendants use a
compiled Cargo/BBDown fixture, not a Python mock executable. Real application
compilation and GUI acceptance are separate from these fast matrix checks.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_bundle
from scripts import libav_bundle

ROOT = Path(__file__).resolve().parents[1]
SUFFIX = ".exe" if os.name == "nt" else ""


class DesktopPrepareContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="desktop-prep-fixtures-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.fixture = Path(cls.temporary.name) / ("fixture" + SUFFIX)
        # Do not let selected-path input overrides cross-compile the test tool.
        environment = dict(os.environ)
        environment.pop("CARGO_BUILD_TARGET", None)
        subprocess.run(["cargo", "build", "--manifest-path", str(ROOT / "xtask/Cargo.toml"), "--locked"],
                       cwd=ROOT, env=environment, check=True)
        metadata = json.loads(subprocess.check_output([
            "cargo", "metadata", "--manifest-path", str(ROOT / "xtask/Cargo.toml"),
            "--locked", "--format-version", "1", "--no-deps"], cwd=ROOT, env=environment, encoding="utf-8"))
        cls.tool = Path(metadata["target_directory"]) / "debug" / ("bilikara-xtask" + SUFFIX)
        subprocess.run(["rustc", "--edition=2024", str(ROOT / "tests/fixtures/desktop_prepare_cargo.rs"),
                        "-o", str(cls.fixture)], cwd=ROOT, env=environment, check=True)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="desktop preparation 空 $-", dir=self.temporary.name)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / "fixture-bin"
        self.bin.mkdir()
        shutil.copy2(self.fixture, self.bin / ("cargo" + SUFFIX))
        self.environment = {k: v for k, v in os.environ.items() if not k.startswith((
            "BILIKARA_", "TAURI_ENV_", "GITHUB_", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET"))}
        # An optional locally installed BBDown must not change fixture coverage.
        remaining = [p for p in os.get_exec_path() if not (Path(p) / ("BBDown" + SUFFIX)).is_file()]
        self.environment.update(PATH=os.pathsep.join([str(self.bin), *remaining]),
                                BILIKARA_VERSION="v0.8.0-preview.3-contract")

    def prefix(self):
        prefix = self.root / "prepared prefix 音楽"
        (prefix / "bin").mkdir(parents=True, exist_ok=True)
        target = libav_bundle.native_target()
        companion = libav_bundle.COMPANIONS[build_bundle.platform.system()]
        dependency = ("avcodec-63.dll" if os.name == "nt" else
                      "libavcodec.63.dylib" if target.endswith("apple-darwin") else "libavcodec.so.63")
        manifest = dict(schema_version=1, kind="libav", version="9.0.1", target=target,
                        runtime_files=[companion, dependency], build_run="contract", build_attempt="1")
        for name in manifest["runtime_files"]:
            (prefix / "bin" / name).write_bytes(b"declared closure fixture, not executable acceptance")
        (prefix / "bin/ffmpeg-runtime.json").write_text(json.dumps(manifest), encoding="utf-8")
        for name in ("source/ffmpeg-9.0.1.tar.xz", "source/ffmpeg-9.0.1.tar.xz.asc", "licenses/COPYING.LGPLv2.1", "build-info.json"):
            path = prefix / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"provenance fixture")
        return prefix

    def run_path(self, name, environment=None, args=(), expected_error=None):
        base = self.root / name
        base.mkdir(exist_ok=True)
        log = base / "cargo.jsonl"
        log.unlink(missing_ok=True)
        env = dict(self.environment, XTASK_FIXTURE_OUTPUT=str(base / "outputs"), XTASK_FIXTURE_LOG=str(log))
        env.update(environment or {})
        if name.startswith("old"):
            with patch.dict(os.environ, env, clear=True), patch("sys.argv", ["build_bundle.py", "--dev", *args]), redirect_stdout(io.StringIO()):
                if expected_error:
                    with self.assertRaises(Exception) as failure:
                        build_bundle.main()
                    self.assertIn(expected_error, str(failure.exception))
                else:
                    build_bundle.main()
        else:
            result = subprocess.run([str(self.tool), "prepare-desktop", *args], cwd=ROOT, env=env,
                                    capture_output=True, encoding="utf-8", timeout=90)
            if expected_error:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected_error, result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        commands = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
        target = next((command[command.index("--target") + 1] for command in commands if "--target" in command), "")
        profile = "release" if env.get("TAURI_ENV_DEBUG") in {"false", "0"} else "debug"
        output = Path(env["CARGO_TARGET_DIR"]) if env.get("CARGO_TARGET_DIR") else base / "outputs/src-tauri"
        return output / target / profile, commands

    def inventory(self, root):
        result = {}
        for path in root.rglob("*"):
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                result[relative] = "directory"
                continue
            content = path.read_bytes()
            if path.name in {"native-desktop.json", "ffmpeg-runtime.json"}:
                content = json.loads(content)
            mode = stat.S_IMODE(path.stat().st_mode) if os.name != "nt" else None
            result[relative] = (content, mode, path.is_symlink())
        return result

    def pair(self, environment=None, args=(), expected_error=None):
        old, old_commands = self.run_path("old", environment, args, expected_error)
        new, new_commands = self.run_path("new", environment, args, expected_error)
        self.assertEqual(old_commands, new_commands)
        if not expected_error:
            self.assertEqual(self.inventory(old), self.inventory(new))
        return old, new, old_commands

    def test_normal_and_repeated_preparation_preserve_static_vendor_and_unrelated_data(self):
        old, new, commands = self.pair()
        self.assertIn("native-host", commands[0])
        self.assertEqual(commands[0].count("--bin"), 2)
        for directory in (old, new):
            (directory / "runtime/data").mkdir(parents=True)
            (directory / "runtime/data/sentinel").write_bytes(b"never remove")
            (directory / "_internal/static/stale-generated-file").write_bytes(b"remove")
            self.assertTrue((directory / ("_internal/bilikara-updater" + SUFFIX)).is_file())
            self.assertTrue((directory / "_internal/static/desktop-startup.html").is_file())
            self.assertFalse((directory / "_internal/static/vendor").exists())
        self.pair()
        for directory in (old, new):
            self.assertFalse((directory / "_internal/static/stale-generated-file").exists())
            self.assertEqual((directory / "runtime/data/sentinel").read_bytes(), b"never remove")

    def test_supplied_prefix_and_tool_with_debug_and_release_profiles(self):
        prefix = self.prefix()
        shutil.copy2(self.fixture, self.bin / ("BBDown" + SUFFIX))
        for debug in ("true", "false", "0"):
            with self.subTest(debug=debug):
                _, new, commands = self.pair(dict(BILIKARA_LIBAV_PREFIX=str(prefix), TAURI_ENV_DEBUG=debug, BILIKARA_BBDOWN_VERSION="1.6.3"))
                self.assertEqual("--release" in commands[0], debug != "true")
                self.assertEqual(json.loads((new / "_internal/native-desktop.json").read_text(encoding="utf-8"))["development"], debug == "true")
                self.assertTrue((new / "license/THIRD_PARTY_SOURCES/media-libav/build.py").is_file())
        self.pair(dict(BILIKARA_LIBAV_PREFIX=str(prefix), TAURI_ENV_DEBUG="false", BILIKARA_BBDOWN_VERSION="incorrect"), expected_error="does not match pinned")

    def test_target_precedence_and_mobile_noop_even_with_invalid_inputs(self):
        target = libav_bundle.native_target()
        self.pair(dict(TAURI_ENV_TARGET_TRIPLE=target))
        _, _, commands = self.pair(dict(CARGO_BUILD_TARGET=target, TAURI_ENV_TARGET_TRIPLE="foreign"))
        self.assertIn("--target", commands[0])
        self.pair(dict(CARGO_BUILD_TARGET="foreign"), args=("--target", target))
        self.pair(args=("--target=foreign", "--target=" + target))
        self.pair(dict(TAURI_ENV_TARGET_TRIPLE="foreign"), expected_error="matching target")
        self.pair(args=("--target", "foreign"), expected_error="matching target")
        for platform in ("android", "ios"):
            for name in ("old-mobile-" + platform, "new-mobile-" + platform):
                _, commands = self.run_path(name, dict(TAURI_ENV_PLATFORM=platform, BILIKARA_LIBAV_PREFIX="invalid", TAURI_ENV_DEBUG="false", CARGO_BUILD_TARGET="foreign"))
                self.assertEqual(commands, [])

    def test_cargo_metadata_output_overrides_and_shared_directory_repetition(self):
        outputs = []
        for name in ("old", "new"):
            environment = dict(CARGO_TARGET_DIR=str(self.root / (name + " shared Cargo 空 $()")), CARGO_BUILD_TARGET=libav_bundle.native_target())
            output, _ = self.run_path(name, environment)
            self.run_path(name, environment)
            outputs.append(output)
        self.assertEqual(self.inventory(outputs[0]), self.inventory(outputs[1]))

    def test_prefix_and_required_tools_fail_closed(self):
        self.pair(dict(BILIKARA_LIBAV_PREFIX="relative"), expected_error="absolute same-build prefix")
        self.pair(dict(TAURI_ENV_DEBUG="false"), expected_error="BILIKARA_LIBAV_PREFIX is required")
        prefix = self.prefix()
        env = dict(BILIKARA_LIBAV_PREFIX=str(prefix))
        self.pair(dict(env, TAURI_ENV_DEBUG="false"), expected_error="Prepare the pinned BBDown vendor")
        manifest_path = prefix / "bin/ffmpeg-runtime.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for changes, error in (({"version": "8.1.2"}, "Invalid packaged FFmpeg manifest"),
                               ({"runtime_files": [*manifest["runtime_files"], "../bad.dll"]}, "Invalid packaged runtime filename"),
                               ({"runtime_files": [*manifest["runtime_files"], manifest["runtime_files"][0]]}, "Incomplete packaged FFmpeg manifest"),
                               ({"target": manifest["target"].replace("x86_64", "aarch64") if manifest["target"].startswith("x86_64") else manifest["target"].replace("aarch64", "x86_64")}, "does not match the native package target")):
            with self.subTest(changes=changes):
                manifest_path.write_text(json.dumps({**manifest, **changes}), encoding="utf-8")
                self.pair(env, expected_error=error)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        for relative, error in (("bin/" + manifest["runtime_files"][1], "dependency is missing"), ("build-info.json", "provenance is incomplete")):
            path = prefix / relative
            content = path.read_bytes()
            path.unlink()
            self.pair(env, expected_error=error)
            path.write_bytes(content)
        manifest_path.write_text("{bad json", encoding="utf-8")
        self.run_path("old", env, expected_error="Expecting")
        self.run_path("new", env, expected_error="key must be a string")

    def test_version_override_git_ci_precedence_and_invalid_version(self):
        for env in (dict(BILIKARA_VERSION="  explicit+version  ", GITHUB_REF_TYPE="tag", GITHUB_REF_NAME="v9.9.9"),
                    dict(BILIKARA_VERSION="", GITHUB_REF_TYPE="branch", GITHUB_REF_NAME="fixture/分支", GITHUB_HEAD_REF="pull/request"),
                    dict(BILIKARA_VERSION="")):
            self.pair(env)
        self.pair(dict(BILIKARA_VERSION="invalid version"), expected_error="Invalid trusted build version")


if __name__ == "__main__":
    unittest.main()
