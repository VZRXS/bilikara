from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch

import build_bundle
from bilikara.ffmpeg_vendor import MANIFEST, runtime_files
from bilikara.windows_preview_smoke import clean_environment, require_x64
from scripts import windows_libav_preview as preview

ROOT = Path(__file__).resolve().parents[1]


class WindowsPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.vendor = self.root / "bin"
        self.vendor.mkdir()
        self.names = ["ffmpeg.exe", "ffprobe.exe", "avcodec-63.dll", "avformat-63.dll", "avutil-61.dll", "swresample-7.dll", "vcruntime140.dll"]
        for name in self.names + [preview.COMPANION]:
            (self.vendor / name).write_bytes(b"selected")
        self.manifest = {"schema_version": 1, "version": "9.0.1", "target": preview.TARGET,
                         "runtime_files": self.names}
        self.write_manifest()
        for name in ("source/ffmpeg-9.0.1.tar.xz", "licenses/COPYING.LGPLv2.1", "build-info.json"):
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("test fixture")

    def write_manifest(self):
        (self.vendor / MANIFEST).write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_opt_in_off_preserves_discovery(self):
        with patch.dict(os.environ, {"BILIKARA_WINDOWS_LIBAV_PREVIEW": "0"}), patch("build_bundle.shutil.which", return_value="/chosen/ffmpeg"), patch("build_bundle.platform.system", return_value="Linux"):
            self.assertIsNone(preview.preview_prefix())
            self.assertEqual(build_bundle._resolve_bundle_binary_path("ffmpeg"), Path("/chosen/ffmpeg"))

    def test_prefix_is_explicit_fail_closed_and_never_uses_path(self):
        with patch.dict(os.environ, {"BILIKARA_WINDOWS_LIBAV_PREVIEW": "1", "BILIKARA_WINDOWS_LIBAV_PREVIEW_PREFIX": str(self.root)}), patch.object(preview.platform, "system", return_value="Windows"), patch.object(preview.platform, "machine", return_value="AMD64"), patch("build_bundle.shutil.which", side_effect=AssertionError("system fallback")):
            self.assertEqual(build_bundle._resolve_bundle_binary_path("ffmpeg"), self.vendor / "ffmpeg.exe")
            (self.vendor / "avutil-61.dll").unlink()
            with self.assertRaises(RuntimeError):
                build_bundle._resolve_bundle_binary_path("ffprobe")
            with patch.dict(os.environ, {"BILIKARA_WINDOWS_LIBAV_PREVIEW_PREFIX": ""}):
                with self.assertRaises(RuntimeError):
                    preview.preview_prefix()

    def test_manifest_rejects_escape_wrong_target_and_missing_dependencies(self):
        for change in ({"runtime_files": [*self.names, "../outside.dll"]}, {"target": "aarch64-pc-windows-msvc"}, {"version": "8.1.2"}, {"runtime_files": [*self.names, "missing.dll"]}):
            with self.subTest(change=change):
                old = self.manifest.copy()
                self.manifest.update(change)
                self.write_manifest()
                with self.assertRaises(RuntimeError):
                    runtime_files(self.vendor)
                self.manifest = old

    def test_preview_stages_cli_as_data_avoiding_pyinstaller_import_search(self):
        paths = {"ffmpeg": self.vendor / "ffmpeg.exe", "ffprobe": self.vendor / "ffprobe.exe", "BBDown": self.root / "BBDown.exe"}
        with patch.dict(os.environ, {"BILIKARA_WINDOWS_LIBAV_PREVIEW": "1"}), patch.object(build_bundle, "_resolved_bundle_binary_paths", return_value=(paths, [])):
            args = build_bundle._bundled_binary_args(";")
        self.assertEqual(args[0], "--add-data")
        self.assertEqual(args[2], "--add-data")
        self.assertEqual(args[4], "--add-binary")

    def test_restore_copies_shared_closure_and_rejects_system_probe(self):
        from bilikara.cache import CacheManager
        manager = object.__new__(CacheManager)
        manager.ffmpeg_prepare_lock = threading.Lock()
        manager.lock = threading.Lock()
        destination = self.root / "tools/bbdown"
        with ExitStack() as stack:
            # Replace the cache module's os binding, not global os.name/Path.
            from types import SimpleNamespace
            stack.enter_context(patch("bilikara.cache.os", SimpleNamespace(name="nt")))
            for key, value in {"VENDOR_DIR": self.vendor, "INTERNAL_VENDOR_DIR": self.root / "absent",
                               "FFMPEG_TOOLS_DIR": destination, "FFMPEG_RUNTIME_PATH": destination / "ffmpeg.exe",
                               "FFPROBE_RUNTIME_PATH": destination / "ffprobe.exe", "FFMPEG_PATH_OVERRIDE": "/unrelated/ffmpeg"}.items():
                stack.enter_context(patch("bilikara.cache." + key, value))
            stack.enter_context(patch.object(manager, "_read_ffmpeg_version", return_value="9.0.1"))
            stack.enter_context(patch("bilikara.cache.shutil.which", side_effect=AssertionError("system fallback")))
            self.assertEqual(manager._ensure_ffmpeg(), destination / "ffmpeg.exe")
            for name in self.names:
                self.assertEqual((destination / name).read_bytes(), b"selected")
            with patch("bilikara.cache.shutil.copy2", side_effect=AssertionError("rewriting an in-use group")):
                manager._ensure_ffmpeg()
            (destination / "avutil-61.dll").write_bytes(b"oldbuild")
            self.manifest["build_run"] = "next-package-build"
            self.write_manifest()
            manager._ensure_ffmpeg()
            self.assertEqual((destination / "avutil-61.dll").read_bytes(), b"selected")
            with patch.object(CacheManager, "_is_usable_ffprobe", return_value=False):
                self.assertIsNone(manager._ffprobe_path_for_ffmpeg(destination / "ffmpeg.exe"))
            (self.vendor / "avcodec-63.dll").unlink()
            with self.assertRaises(RuntimeError):
                manager._ensure_ffmpeg()

    def test_dependency_collection_uses_import_closure_and_rejects_foreign(self):
        redist, system = self.root / "redist", self.root / "system"
        redist.mkdir()
        system.mkdir()
        (redist / "vcruntime140.dll").write_bytes(b"vc-redist")
        (self.vendor / "vcruntime140.dll").unlink()
        imports = {
            "ffmpeg.exe": ["avformat-63.dll"], "ffprobe.exe": ["avformat-63.dll"],
            preview.COMPANION: ["avformat-63.dll"], "bilikara_media_libav_test.dll": ["avformat-63.dll"],
            "avformat-63.dll": ["avcodec-63.dll", "avutil-61.dll"],
            "avcodec-63.dll": ["swresample-7.dll", "avutil-61.dll"],
            "avutil-61.dll": ["vcruntime140.dll"], "swresample-7.dll": [], "vcruntime140.dll": [],
        }
        def info(p):
            return {"machine": "x64", "imports": imports[p.name] + ["api-ms-win-crt-runtime-l1-1-0.dll"]}
        with patch.object(preview, "pe_info", side_effect=info):
            data = preview.collect(self.root, redist, system)
            self.assertIn("swresample-7.dll", data["runtime_files"])
            self.assertNotIn(preview.COMPANION, data["runtime_files"])
            self.assertEqual((self.vendor / "vcruntime140.dll").read_bytes(), b"vc-redist")
            imports["avcodec-63.dll"].append("avcodec-OLD.dll")
            (system / "avcodec-OLD.dll").write_bytes(b"foreign")
            with self.assertRaises(RuntimeError):
                preview.collect(self.root, redist, system)

    def test_extracted_machine_check_rejects_arm64_and_non_pe(self):
        path = self.root / "tool.exe"
        for machine, good in ((0x8664, True), (0xaa64, False), (0x14c, False)):
            data = bytearray(128)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 60, 64)
            data[64:70] = b"PE\0\0" + struct.pack("<H", machine)
            path.write_bytes(data)
            if good:
                require_x64(path)
            else:
                with self.assertRaises(RuntimeError):
                    require_x64(path)

    def test_stage_preserves_vendor_closure_driver_and_provenance_layout(self):
        self.manifest.update(pe={n: {} for n in [*self.names, preview.COMPANION]}, vc_redist_files=["vcruntime140.dll"])
        self.write_manifest()
        (self.root / "driver").mkdir()
        for name in ("libav_metadata.exe", "libav-runtime-tests.exe"):
            (self.root / "driver" / name).write_bytes(b"developer-exe")
        (self.root / "records").mkdir()
        (self.root / "records/config.log").write_text("same build")
        (self.root / "source/source.asc").write_text("source signature fixture")
        bundle = self.root / "package"
        (bundle / "THIRD_PARTY_SOURCES").mkdir(parents=True)
        with patch.object(preview, "pe_info", return_value={"machine": "x64", "imports": []}):
            preview.stage(self.root, bundle)
        for name in self.names:
            self.assertEqual((bundle / "_internal/vendor" / name).read_bytes(), b"selected")
        self.assertTrue((bundle / "preview/libav_metadata.exe").is_file())
        self.assertTrue((bundle / "preview/vcruntime140.dll").is_file())
        self.assertTrue((bundle / "THIRD_PARTY_SOURCES/source.asc").is_file())
        self.assertTrue((bundle / "THIRD_PARTY_SOURCES/media-libav/fixtures/synthetic.h264").is_file())
        self.assertTrue((bundle / "libav-smoke.ps1").is_file())
        self.assertEqual((bundle / "preview/build/config.log").read_text(), "same build")

    def test_smoke_environment_excludes_tool_and_credential_overrides(self):
        with patch.dict(os.environ, {"SystemRoot": str(self.root), "PATH": "private-ffmpeg", "BILIKARA_BILIBILI_COOKIE": "private", "FFMPEG_PATH": "private"}):
            env = clean_environment(self.root)
        self.assertNotIn("BILIKARA_BILIBILI_COOKIE", env)
        self.assertNotIn("FFMPEG_PATH", env)
        self.assertNotIn("private", env["PATH"])
        self.assertIn("System32", env["PATH"])

    def test_workflow_opt_in_and_default_matrices_and_order(self):
        text = (ROOT / ".github/workflows/ci-bundle.yml").read_text()
        match = re.search(r"include: \$\{\{ fromJSON\(inputs.windows_libav_preview && '([^']+)' \|\| '([^']+)'\)", text)
        self.assertIsNotNone(match)
        selected, default = map(json.loads, match.groups())
        self.assertEqual([e["os"] for e in selected], ["windows-latest"])
        self.assertEqual([e["os"] for e in default], ["windows-latest", "windows-11-arm", "macos-latest", "macos-15-intel"])
        self.assertIn("type: boolean\n        default: false", text)
        self.assertIn("if: runner.os == 'Windows' && !inputs.windows_libav_preview", text)
        self.assertEqual(text.count("if: startsWith(github.ref, 'refs/tags/v') && !inputs.windows_libav_preview"), 2)
        for before, after in (("Setup x64 MSVC preview", "Build same-source Windows"), ("Build same-source Windows", "Prepare preview driver"),
                              ("Prepare preview driver", "Build app bundle"), ("Inject Tauri into Windows", "Archive Windows bundle"),
                              ("Archive Windows bundle", "Smoke extracted Windows"), ("Smoke extracted Windows", "Upload Windows preview")):
            self.assertLess(text.index(before), text.index(after))
        self.assertIn("if: always() && inputs.windows_libav_preview", text)
        self.assertIn("Expand-Archive -Path $env:BUNDLE_ARCHIVE", text)


if __name__ == "__main__":
    unittest.main()
