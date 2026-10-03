"""Real selected libraries; Python drives only the independent reference/tests.

CI's lightweight Linux prerequisite supplies BILIKARA_TEST_LIBAV_COMPANION.
No handwritten prefix is treated as native C/ABI qualification.
"""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from scripts import libav_bundle, libav_cache

ROOT = Path(__file__).resolve().parents[1]


class LibavPrerequisiteContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        companion = os.environ.get("BILIKARA_TEST_LIBAV_COMPANION", "")
        if not companion:
            raise unittest.SkipTest("Requires real prepared libav libraries from the native prerequisite")
        cls.prefix = Path(companion).resolve(strict=True).parent.parent
        environment = dict(os.environ)
        environment.pop("CARGO_BUILD_TARGET", None)
        output = subprocess.check_output([
            "cargo", "build", "--manifest-path", str(ROOT / "xtask/Cargo.toml"),
            "--locked", "--target", "host-tuple", "--message-format=json"],
            cwd=ROOT, env=environment, encoding="utf-8")
        artifacts = [record["executable"] for line in output.splitlines()
                     if (record := json.loads(line)).get("reason") == "compiler-artifact"
                     and record["target"]["name"] == "bilikara-xtask" and record.get("executable")]
        if len(artifacts) != 1:
            raise AssertionError("Expected one current host-native xtask compiler artifact")
        cls.tool = Path(artifacts[0])
        cls.environment = {key: value for key, value in os.environ.items()
                           if not key.startswith(("BILIKARA_", "TAURI_ENV_", "GITHUB_", "CARGO_BUILD_TARGET"))}

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="libav prerequisites 中文 $() ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def invoke(self, *args, success=True, overrides=None):
        result = subprocess.run([str(self.tool), *map(str, args)], cwd=ROOT,
                                env=dict(self.environment, **(overrides or {})),
                                capture_output=True, encoding="utf-8", timeout=180)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_real_companion_matches_frozen_reference_and_preserves_repeated_outputs(self):
        old, new = self.root / "reference", self.root / "Rust 产物"
        subprocess.run([sys.executable, str(ROOT / "media-libav/build.py"), "--prefix", str(self.prefix),
                        "--out", str(old), "--test"], cwd=ROOT, env=self.environment,
                       check=True, capture_output=True, encoding="utf-8", timeout=180)
        for _ in range(2):
            self.invoke("libav-companion", "--prefix", self.prefix, "--out", new, "--test")
            self.assertEqual(sorted(path.name for path in old.iterdir()), sorted(path.name for path in new.iterdir()))
            self.assertEqual(json.loads((old / "build-info.json").read_bytes()),
                             json.loads((new / "build-info.json").read_bytes()))
            self.assertEqual((old / "build_config.h").read_bytes(), (new / "build_config.h").read_bytes())
            for path in old.iterdir():
                self.assertEqual(path.stat().st_mode, (new / path.name).stat().st_mode, path.name)
                if path.name not in {"build-info.json", "build_config.h"} and os.name != "nt":
                    self.assertEqual(libav_bundle.binary_info(path), libav_bundle.binary_info(new / path.name))
        # The C shim assertions are executed by both producers; debug paths and
        # signatures may change binary bytes, but ABI/config/imports may not.

    def test_compiler_failure_invalidates_completion_and_target_mismatch_fails(self):
        out = self.root / "failed compiler"
        out.mkdir()
        (out / "build-info.json").write_text('{"old":true}', encoding="utf-8")
        self.invoke("libav-companion", "--prefix", self.prefix, "--out", out,
                    success=False, overrides=({"PATH": str(self.root / "absent tools")} if os.name == "nt"
                                              else {"CC": str(self.root / "absent compiler")}))
        self.assertFalse((out / "build-info.json").exists())
        self.invoke("libav-companion", "--prefix", self.prefix, "--out", out,
                    success=False, overrides={"BILIKARA_LIBAV_TARGET": "foreign-target"})

    @unittest.skipIf(os.name == "nt", "POSIX sanitizer mode; Windows rejection is covered by xtask tests")
    def test_real_sanitized_shim_executes(self):
        self.invoke("libav-companion", "--prefix", self.prefix, "--out", self.root / "sanitized",
                    "--test", "--sanitize")

    @unittest.skipUnless(sys.platform.startswith("linux"), "Independent POSIX collector reference on native Linux")
    def test_real_collection_matches_reference_paths_metadata_permissions_and_bytes(self):
        old, new = self.root / "old prefix", self.root / "new prefix"
        for prefix in (old, new):
            # Same verified upstream inputs and already freshly compiled shim;
            # no C dependency from a previous collection is reused.
            shutil.copytree(self.prefix / "lib", prefix / "lib", symlinks=True)
            (prefix / "bin").mkdir()
            (prefix / "driver").mkdir()
            for name in ("libbilikara_media_libav.so", "libbilikara_media_libav_test.so"):
                shutil.copy2(self.prefix / "bin" / name, prefix / "bin" / name)
        libav_bundle.collect_posix(old)  # Independent reference, outside migrated descendants.
        self.invoke("libav-collect", "--prefix", new)
        self.assertEqual(json.loads((old / "bin/ffmpeg-runtime.json").read_bytes()),
                         json.loads((new / "bin/ffmpeg-runtime.json").read_bytes()))
        self.assertEqual(sorted(p.name for p in (old / "bin").iterdir()), sorted(p.name for p in (new / "bin").iterdir()))
        for path in (old / "bin").iterdir():
            actual = new / "bin" / path.name
            self.assertEqual(path.stat().st_mode, actual.stat().st_mode)
            if path.name != "ffmpeg-runtime.json":
                self.assertEqual(path.read_bytes(), actual.read_bytes(), path.name)
        self.invoke("libav-collect", "--prefix", new)
        self.assertEqual(json.loads((old / "bin/ffmpeg-runtime.json").read_bytes()),
                         json.loads((new / "bin/ffmpeg-runtime.json").read_bytes()))

    @unittest.skipUnless(sys.platform.startswith("linux"), "Actual native Linux upstream-cache comparison")
    def test_real_upstream_cache_matches_reference_and_rejects_invalid_hits_before_mutation(self):
        upstream, old, new = [self.root / name for name in ("upstream C only", "old cache", "Rust cache")]
        for directory in ("lib", "include", "share", "source", "licenses"):
            shutil.copytree(self.prefix / directory, upstream / directory, symlinks=True)
        (upstream / "records").mkdir()
        for name in ("signature.log", "configure.log", "build.log", "install.log", "config.log", "config.h",
                     "config_components.h", "config.mak", "libav-linker-flags.rsp"):
            source = self.prefix / "records" / name
            if source.is_file():
                shutil.copy2(source, upstream / "records" / name)
        libav_cache.snapshot(upstream, old)
        environment = {"BILIKARA_LIBAV_PREFIX": str(self.prefix)}
        self.invoke("libav-cache", "snapshot", upstream, new, overrides=environment)

        def inventory(root):
            entries = {}
            for path in root.rglob("*"):
                if path.name == "cache-manifest.json":
                    continue  # Intentional one-time cache schema/key rotation.
                entries[path.relative_to(root).as_posix()] = (
                    path.lstat().st_mode,
                    os.readlink(path) if path.is_symlink() else None if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest())
            return entries

        self.assertEqual(inventory(old), inventory(new))
        restored = self.root / "restored C 产物"
        reference_restored = self.root / "reference restored C"
        libav_cache.restore(old, reference_restored)
        self.invoke("libav-cache", "restore", new, restored, overrides=environment)
        self.assertEqual(inventory(reference_restored), inventory(restored))
        self.assertFalse((restored / "driver").exists())
        self.assertFalse((restored / "bin/build-info.json").exists())

        destination = self.root / "existing output"
        (destination / "bin").mkdir(parents=True)
        (destination / "build-info.json").write_bytes(b"previous completion")
        (destination / "bin/ffmpeg-runtime.json").write_bytes(b"previous manifest")
        before = inventory(destination)
        for case in ("content", "target", "toolchain", "malformed", "source", "license", "private", "unsafe path", "unsafe link", "interrupted"):
            with self.subTest(case=case):
                bad = self.root / ("invalid cache " + case)
                shutil.copytree(new, bad, symlinks=True)
                manifest = bad / "cache-manifest.json"
                data = json.loads(manifest.read_bytes())
                if case == "content":
                    (bad / "include/libavutil/avutil.h").write_bytes(b"corruption")
                elif case == "target":
                    data["target"] = "foreign-target"
                elif case == "toolchain":
                    data["key"] = "wrong compiler/key"
                elif case == "source":
                    (bad / "source/ffmpeg-9.0.1.tar.xz").unlink()
                    del data["entries"]["source/ffmpeg-9.0.1.tar.xz"]
                elif case == "license":
                    (bad / "licenses/COPYING.LGPLv2.1").unlink()
                    del data["entries"]["licenses/COPYING.LGPLv2.1"]
                elif case == "private":
                    for library in (bad / "lib").glob("libswresample.so*"):
                        del data["entries"][library.relative_to(bad).as_posix()]
                        library.unlink()
                elif case == "unsafe path":
                    data["entries"]["../user-data"] = {"kind": "file"}
                elif case == "unsafe link":
                    (bad / "lib/libavcodec.so").unlink()
                    (bad / "lib/libavcodec.so").symlink_to(self.prefix / "lib/libavcodec.so")
                elif case == "interrupted":
                    manifest.unlink()
                if case != "interrupted":
                    manifest.write_text("{broken" if case == "malformed" else json.dumps(data), encoding="utf-8")
                self.invoke("libav-cache", "restore", bad, destination, success=False, overrides=environment)
                self.assertEqual(before, inventory(destination), "Invalid declared cache must not contaminate the working prefix")


if __name__ == "__main__":
    unittest.main()
