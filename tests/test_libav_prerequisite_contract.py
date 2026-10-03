"""Real selected libraries; Python drives independent verification only.

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

import platform
import re

ROOT = Path(__file__).resolve().parents[1]
COMPANIONS = {"Windows": "bilikara_media_libav.dll", "Darwin": "libbilikara_media_libav.dylib",
              "Linux": "libbilikara_media_libav.so"}


def native_target():
    """Independent native test facts; no construction expectation dependency."""
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}[platform.machine().lower()]
    suffix = {"Windows": "pc-windows-msvc", "Darwin": "apple-darwin", "Linux": "unknown-linux-gnu"}[platform.system()]
    return f"{arch}-{suffix}"


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

    def test_real_companion_has_pinned_facts_and_preserves_repeated_outputs(self):
        new = self.root / "Rust 产物"
        expected_names = {COMPANIONS[platform.system()], "build-info.json", "build_config.h"}
        if os.name != "nt":
            expected_names |= {COMPANIONS[platform.system()].replace("libav.", "libav_test."), "test_shim"}
        previous = None
        for _ in range(2):
            self.invoke("libav-companion", "--prefix", self.prefix, "--out", new, "--test")
            if os.name != "nt":
                self.assertEqual({path.name for path in new.iterdir()}, expected_names)
            else:
                self.assertTrue(expected_names.issubset({path.name for path in new.iterdir()}))
                self.assertTrue((new / "bilikara_media_libav_test.dll").is_file())
                self.assertTrue((new / "test_shim.exe").is_file())
            facts = json.loads((new / "build-info.json").read_bytes())
            self.assertEqual(facts["library_versions"], [dict(name="libavutil", version=3998053),
                             dict(name="libavcodec", version=4129125), dict(name="libavformat", version=4129125)])
            self.assertEqual(facts["program_version"]["version"], "9.0.1")
            configuration = facts["program_version"]["configuration"]
            for flag in ("--disable-network", "--enable-shared", "--disable-programs", "--disable-autodetect"):
                self.assertIn(flag, configuration.split())
            self.assertEqual((new / "build_config.h").read_text(),
                             "#define BM_BUILD_CONFIG " + json.dumps(configuration, ensure_ascii=True) + "\n")
            if previous:
                self.assertEqual(facts, previous)
            previous = facts
        # --test executes the actual C shim, not an inferred filename/ABI fixture.

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

    @unittest.skipUnless(sys.platform.startswith("linux"), "Native ELF collection evidence")
    def test_real_collection_has_complete_relocatable_closure_and_fresh_metadata(self):
        new = self.root / "new prefix"
        shutil.copytree(self.prefix / "lib", new / "lib", symlinks=True)
        (new / "bin").mkdir()
        (new / "driver").mkdir()
        for name in ("libbilikara_media_libav.so", "libbilikara_media_libav_test.so"):
            shutil.copy2(self.prefix / "bin" / name, new / "bin" / name)
        expected_runtime = sorted(["libbilikara_media_libav.so", "libavcodec.so.63", "libavformat.so.63",
                                   "libavutil.so.61", "libswresample.so.7"])
        expected_code = sorted([*expected_runtime, "libbilikara_media_libav_test.so"])
        system = {"libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1", "libresolv.so.2",
                  "libgcc_s.so.1", "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1"}
        previous = None
        for _ in range(2):
            self.invoke("libav-collect", "--prefix", new)
            data = json.loads((new / "bin/ffmpeg-runtime.json").read_bytes())
            self.assertEqual({key: data[key] for key in ("schema_version", "kind", "version", "target",
                             "runtime_files", "build_run", "build_attempt", "drivers")},
                             dict(schema_version=1, kind="libav", version="9.0.1", target=native_target(),
                                  runtime_files=expected_runtime, build_run="local", build_attempt="1", drivers={}))
            self.assertEqual(sorted(data["binaries"]), expected_code)
            self.assertEqual(sorted(p.name for p in (new / "bin").iterdir()),
                             sorted([*expected_code, "ffmpeg-runtime.json"]))
            for name, facts in data["binaries"].items():
                path = new / "bin" / name
                self.assertFalse(path.is_symlink())
                self.assertEqual(path.stat().st_mode & 0o777, (self.prefix / "bin" / name).stat().st_mode & 0o777)
                dynamic = subprocess.check_output(["readelf", "-d", str(path)], encoding="utf-8")
                self.assertIn("Library runpath: [$ORIGIN]", dynamic)
                imports = re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic)
                self.assertEqual(facts, dict(machine="arm64" if native_target().startswith("aarch64") else "x64", imports=imports))
                self.assertTrue(all(dep in system or dep in expected_code for dep in imports))
            if previous:
                self.assertEqual(data, previous)
            previous = data

    @unittest.skipUnless(sys.platform.startswith("linux"), "Actual native Linux upstream-cache round trip")
    def test_real_upstream_cache_preserves_c_only_inputs_and_rejects_invalid_hits_before_mutation(self):
        upstream, new = [self.root / name for name in ("upstream C only", "Rust cache")]
        for directory in ("lib", "include", "share", "source", "licenses"):
            # The accepted cache excludes program-named directories too,
            # including share/ffmpeg examples. The exact source archive remains.
            shutil.copytree(self.prefix / directory, upstream / directory, symlinks=True,
                            ignore=shutil.ignore_patterns("ffmpeg", "ffprobe"))
        (upstream / "records").mkdir()
        for name in ("signature.log", "configure.log", "build.log", "install.log", "config.log", "config.h",
                     "config_components.h", "config.mak", "libav-linker-flags.rsp"):
            source = self.prefix / "records" / name
            if source.is_file():
                shutil.copy2(source, upstream / "records" / name)
        (upstream / "bin").mkdir()
        environment = {"BILIKARA_LIBAV_PREFIX": str(self.prefix)}
        self.invoke("libav-cache", "snapshot", upstream, new, overrides=environment)

        def inventory(root):
            entries = {}
            for path in root.rglob("*"):
                if path.name == "cache-manifest.json":
                    continue  # The cache manifest is validated independently below.
                entries[path.relative_to(root).as_posix()] = (
                    path.lstat().st_mode,
                    os.readlink(path) if path.is_symlink() else None if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest())
            return entries

        self.assertEqual(inventory(upstream), inventory(new))
        cache_manifest = json.loads((new / "cache-manifest.json").read_bytes())
        self.assertEqual(cache_manifest["schema_version"], 3)
        self.assertEqual(cache_manifest["target"], native_target())
        restored = self.root / "restored C 产物"
        self.invoke("libav-cache", "restore", new, restored, overrides=environment)
        self.assertEqual(inventory(upstream), inventory(restored))
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
