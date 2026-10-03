"""Frozen Python producer vs migrated Rust release entries on native fixtures.

The fixture supplies compiled Cargo/Tauri outputs, never a Python executable in
the migrated process tree. Real native product/GUI acceptance remains separate.
Only JSON/plist formatting and macOS signature bytes are normalized.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

import build_bundle
from scripts import libav_bundle, windows_libav_preview
from tests.test_desktop_prepare_contract import DesktopConstructionFixtures, ROOT, SUFFIX


class DesktopReleaseContractTests(DesktopConstructionFixtures):
    def setUp(self):
        super().setUp()
        shutil.copy2(self.fixture, self.bin / ("BBDown" + SUFFIX))
        if os.name == "nt":
            shutil.copy2(self.fixture, self.bin / "npm-fixture.exe")
            (self.bin / "npm.cmd").write_text('@echo off\n"%~dp0npm-fixture.exe" %*\n', encoding="utf-8")
        else:
            shutil.copy2(self.fixture, self.bin / "npm")
        self.prepared = self.prefix()
        archive = self.prepared / "source/ffmpeg-9.0.1.tar.xz"
        self.environment.update(BILIKARA_LIBAV_PREFIX=str(self.prepared), BILIKARA_BBDOWN_VERSION="1.6.3",
                                BILIKARA_FFMPEG_SOURCE_VERSION="9.0.1", BILIKARA_FFMPEG_SOURCE_ARCHIVE=str(archive),
                                BILIKARA_FFMPEG_SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz",
                                BILIKARA_FFMPEG_SOURCE_SHA256=hashlib.sha256(archive.read_bytes()).hexdigest())
        # Isolated reference checkout: the frozen producer has no output option.
        # Supply exactly the repository resources reached by this release slice.
        self.reference = self.root / "reference checkout 空 $()"
        self.reference.mkdir()
        shutil.copytree(ROOT / "static", self.reference / "static")
        for name in ("LICENSE", "LEGAL.md", "THIRD_PARTY_NOTICES.md", "package.json", "third_party/BBDown-LICENSE.txt"):
            destination = self.reference / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, destination)
        for name in ("probe.h", "probe.c", "remux.c", "test_shim.c", "windows_io.h", "build.py", "build-posix.sh",
                     "build-posix-libraries.sh", "build-windows.sh", "build-windows-libraries.sh", "prepare-windows.ps1", "fixtures/synthetic.h264"):
            destination = self.reference / "media-libav" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "media-libav" / name, destination)
        self.new_dist = self.root / "new dist 音楽 $()"
        self.product = "bilikara.app" if build_bundle.platform.system() == "Darwin" else "bilikara"

    def release_path(self, old, overrides=None, args=(), error=None, full=True):
        base = self.root / ("old-release" if old else "new-release")
        base.mkdir(exist_ok=True)
        log = base / "commands.jsonl"
        log.unlink(missing_ok=True)
        env = dict(self.environment, XTASK_FIXTURE_OUTPUT=str(base / "cargo outputs 空"), XTASK_FIXTURE_LOG=str(log))
        env.update(overrides or {})
        if old:
            with patch.dict(os.environ, env, clear=True), patch.object(build_bundle, "ROOT_DIR", self.reference), \
                 patch.object(libav_bundle, "ROOT", self.reference), patch.object(windows_libav_preview, "ROOT", self.reference), \
                 patch("sys.argv", ["build_bundle.py", *(["--desktop"] if full else []), *args]), redirect_stdout(io.StringIO()):
                if error:
                    with self.assertRaises(Exception) as failure:
                        build_bundle.main()
                    self.assertIn(error, str(failure.exception))
                else:
                    build_bundle.main()
        else:
            self.invoke("build-desktop" if full else "build-backend", env, args, error)
        commands = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
        if old:
            commands = [[arg.replace(str(self.reference), str(ROOT)) for arg in command] for command in commands]
        return commands, env

    def invoke(self, action, env, args=(), error=None):
        result = subprocess.run([str(self.tool), action, "--dist-dir", str(self.new_dist), *args], cwd=ROOT, env=env,
                                capture_output=True, encoding="utf-8", timeout=120)
        if error:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(error, result.stderr)
        else:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def inventory(self, root):
        result = super().inventory(root)
        if build_bundle.platform.system() == "Darwin":
            for relative, item in result.items():
                path = root / relative
                if path.is_symlink() or not path.is_file():
                    continue
                if "_CodeSignature" in path.parts:
                    # Retain every relative entry/mode; only signature content
                    # can differ because JSON formatting affects sealed hashes.
                    result[relative] = ("signature bytes", item[1], item[2])
                elif path.read_bytes()[:4] in build_bundle.MACHO_MAGICS:
                    copy = self.root / "signature-normalization-copy"
                    shutil.copy2(path, copy)
                    subprocess.run(["/usr/bin/codesign", "--remove-signature", str(copy)], check=True,
                                   capture_output=True, encoding="utf-8")
                    result[relative] = (copy.read_bytes(), item[1], item[2])
                    copy.unlink()
        return result

    def pair_release(self, overrides=None, args=(), error=None, full=True):
        old_commands, _ = self.release_path(True, overrides, args, error, full)
        new_commands, env = self.release_path(False, overrides, args, error, full)
        if not error:
            self.assertEqual(old_commands, new_commands)
            self.assert_same_inventory(self.inventory(self.reference / "dist" / self.product), self.inventory(self.new_dist / self.product))
            if full and self.product.endswith(".app"):
                self.assert_same_inventory(self.inventory(self.reference / "dist/bilikara-desktop.app"), self.inventory(self.new_dist / "bilikara-desktop.app"))
        return new_commands, env

    def test_full_release_compiles_both_backend_binaries_shell_and_complete_compliance(self):
        commands, _ = self.pair_release(dict(TAURI_ENV_DEBUG="true", TAURI_ENV_PLATFORM="android"))
        self.assertIn("--release", commands[0])
        self.assertIn("native-host", commands[0])
        self.assertEqual(commands[0].count("--bin"), 2)
        self.assertEqual(sum(command[0] == "exec" for command in commands), 1)
        backend = self.new_dist / self.product
        resources = backend / ("Contents/Resources" if self.product.endswith(".app") else "_internal")
        self.assertIs(json.loads((resources / "native-desktop.json").read_text(encoding="utf-8"))["development"], False)
        docs = resources / "license" if self.product.endswith(".app") else backend / "license"
        self.assertTrue((docs / "THIRD_PARTY_SOURCES/ffmpeg-9.0.1.tar.xz").is_file())
        self.assertTrue((docs / "THIRD_PARTY_SOURCES/media-libav/build.py").is_file())
        self.assertFalse((resources / "static/vendor").exists())

    def test_split_ci_assembly_reuses_compiled_shell_without_cargo_build_or_npm(self):
        _, env = self.pair_release(full=False)
        old_commands, _ = self.release_path(True, full=True)
        # Fixture supplies the exact compiled Tauri output from the reference
        # build, just as CI supplies a shell already checked before assembly.
        output = self.root / "old-release/cargo outputs 空/src-tauri/release"
        shell = output / ("bundle/macos/bilikara.app" if self.product.endswith(".app") else "bilikara" + SUFFIX)
        log = Path(env["XTASK_FIXTURE_LOG"])
        log.write_text("", encoding="utf-8")
        self.invoke("assemble-desktop", env, ("--shell", str(shell)))
        self.assertEqual(log.read_text(encoding="utf-8"), "")
        self.assertEqual(sum(command[0] == "exec" for command in old_commands), 1)
        final = "bilikara-desktop.app" if self.product.endswith(".app") else self.product
        self.assert_same_inventory(self.inventory(self.reference / "dist" / final), self.inventory(self.new_dist / final))

    def test_full_migrated_entry_runs_with_no_python_on_isolated_path(self):
        isolated = self.root / "only native fixture and inspection tools"
        shutil.copytree(self.bin, isolated)
        for name in ("readelf", "lipo", "otool", "plutil", "codesign", "ditto"):
            path = shutil.which(name)
            if path:
                shutil.copy2(path, isolated / Path(path).name)
        self.assertIsNone(shutil.which("python", path=str(isolated)))
        self.assertIsNone(shutil.which("python3", path=str(isolated)))
        commands, _ = self.release_path(False, dict(PATH=str(isolated)))
        self.assertEqual(sum(command[0] == "build" for command in commands), 1)
        self.assertEqual(sum(command[0] == "exec" for command in commands), 1)
        self.assertTrue((self.new_dist / self.product).is_dir())

    def test_target_precedence_and_shared_cargo_outputs_with_special_paths(self):
        native = libav_bundle.native_target()
        self.pair_release(dict(CARGO_BUILD_TARGET="foreign", TAURI_ENV_TARGET_TRIPLE="foreign"), ("--target", native))
        commands, _ = self.pair_release(dict(CARGO_BUILD_TARGET=native))
        self.assertIn("--target", commands[0])
        shared = self.root / "shared Cargo target 空 $()"
        self.pair_release(dict(CARGO_TARGET_DIR=str(shared)))
        self.pair_release(dict(CARGO_TARGET_DIR=str(shared)))
        self.pair_release(dict(CARGO_BUILD_TARGET="foreign"), error="matching target")

    def test_tool_notice_preserves_reference_universal_newline_conversion(self):
        self.pair_release(dict(XTASK_FIXTURE_TOOL_VERSION="BBDown 1.6.3\r\nbanner\rline"))

    def test_release_inputs_fail_without_development_or_system_fallback(self):
        self.pair_release(dict(BILIKARA_LIBAV_PREFIX="", TAURI_ENV_DEBUG="true"), error="BILIKARA_LIBAV_PREFIX is required")
        self.pair_release(dict(BILIKARA_LIBAV_PREFIX="relative"), error="absolute same-build prefix")
        self.pair_release(dict(BILIKARA_LIBAV_PREFIX=str(self.root / "absent prefix")), error="incomplete; no system fallback")
        self.pair_release(dict(BILIKARA_BBDOWN_VERSION="incorrect"), error="does not match pinned")
        (self.bin / ("BBDown" + SUFFIX)).unlink()
        self.pair_release(error="Prepare the pinned BBDown vendor")

    def test_invalid_prefix_dependency_provenance_and_source_digest_rejections(self):
        manifest_file = self.prepared / "bin/ffmpeg-runtime.json"
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        other_target = manifest["target"].replace("x86_64", "aarch64") if manifest["target"].startswith("x86_64") else manifest["target"].replace("aarch64", "x86_64")
        for changes, error in ((dict(kind="ffmpeg"), "Invalid packaged FFmpeg manifest"),
                               (dict(version="8.1.2"), "Invalid packaged FFmpeg manifest"),
                               (dict(target=other_target), "does not match the native package target")):
            with self.subTest(changes=changes):
                manifest_file.write_text(json.dumps({**manifest, **changes}), encoding="utf-8")
                self.pair_release(error=error)
        manifest_file.write_text(json.dumps(manifest), encoding="utf-8")
        for name, error in (("bin/" + manifest["runtime_files"][1], "dependency is missing"),
                            ("source/ffmpeg-9.0.1.tar.xz", "provenance is incomplete"), ("build-info.json", "provenance is incomplete")):
            path = self.prepared / name
            hidden = path.with_suffix(path.suffix + ".hidden")
            path.rename(hidden)
            self.pair_release(error=error)
            hidden.rename(path)
        self.pair_release(dict(BILIKARA_FFMPEG_SOURCE_SHA256="0" * 64), error="SHA-256 mismatch")
        self.pair_release(dict(BILIKARA_FFMPEG_SOURCE_ARCHIVE=str(self.root / "missing.tar.xz")), error="source archive not found")
        self.pair_release(dict(BILIKARA_BBDOWN_LICENSE_FILE=str(self.root / "missing-license.txt")), error="BBDown license file not found")
        manifest_file.write_text("{invalid", encoding="utf-8")
        self.release_path(True, error="Expecting")
        self.release_path(False, error="key must be a string")

    def test_repeated_release_preserves_unrelated_artifacts_and_refuses_user_data(self):
        _, env = self.pair_release()
        for dist in (self.reference / "dist", self.new_dist):
            (dist / "unrelated-artifact").write_bytes(b"preserve")
        self.pair_release()
        self.assertEqual((self.new_dist / "unrelated-artifact").read_bytes(), b"preserve")
        data = self.new_dist / self.product / "runtime/data"
        data.mkdir(parents=True)
        (data / "sentinel").write_bytes(b"user data is not generated output")
        self.invoke("build-backend", env, error="containing user data")
        self.assertEqual((data / "sentinel").read_bytes(), b"user data is not generated output")

    def test_assembly_rejects_missing_updater_debug_layout_and_wrong_version(self):
        _, env = self.pair_release(full=False)
        backend = self.new_dist / self.product
        resources = backend / ("Contents/Resources" if self.product.endswith(".app") else "_internal")
        manifest_file = resources / "native-desktop.json"
        original = manifest_file.read_bytes()
        for changes, error in ((dict(development=True), "matching release backend"),
                               (dict(arch="foreign"), "matching release backend"),
                               (dict(version="wrong"), "version/manifest mismatch")):
            manifest_file.write_text(json.dumps({**json.loads(original), **changes}), encoding="utf-8")
            self.invoke("assemble-desktop", env, ("--shell", str(self.fixture)), error=error)
        manifest_file.write_bytes(original)
        updater = backend / ("Contents/MacOS/bilikara-updater" if self.product.endswith(".app") else "_internal/bilikara-updater" + SUFFIX)
        updater.unlink()
        result = self.invoke("assemble-desktop", env, ("--shell", str(self.fixture)), error="os error 2")
        self.assertNotEqual(result.returncode, 0)

    def test_cleanup_preserves_supplied_tool_archive_and_license_inside_product(self):
        _, env = self.pair_release(full=False)
        product = self.new_dist / self.product
        for kind in ("tool", "archive", "license"):
            with self.subTest(kind=kind):
                supplied = product / "prepared input"
                shutil.copy2(self.bin / ("BBDown" + SUFFIX), supplied)
                guarded_env = dict(env)
                if kind == "tool":
                    supplied.rename(product / ("BBDown" + SUFFIX))
                    supplied = product / ("BBDown" + SUFFIX)
                    guarded_env["PATH"] = str(product) + os.pathsep + env["PATH"]
                elif kind == "archive":
                    guarded_env["BILIKARA_FFMPEG_SOURCE_ARCHIVE"] = str(supplied)
                    guarded_env["BILIKARA_FFMPEG_SOURCE_SHA256"] = hashlib.sha256(supplied.read_bytes()).hexdigest()
                else:
                    guarded_env["BILIKARA_BBDOWN_LICENSE_FILE"] = str(supplied)
                before = self.inventory(product)
                self.invoke("build-backend", guarded_env, error="overlaps a prepared input")
                self.assert_same_inventory(before, self.inventory(product))
                supplied.unlink()


if __name__ == "__main__":
    unittest.main()
