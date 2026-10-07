"""Retained libav manifest and source-mode routing compatibility contracts."""
from __future__ import annotations

from contextlib import ExitStack
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.ffmpeg_vendor import MANIFEST, runtime_files

ROOT = Path(__file__).resolve().parents[1]


class LibavBundleTests(unittest.TestCase):
    def test_each_native_target_discovers_its_packaged_companion_without_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            vendor = Path(temporary)
            (vendor / MANIFEST).write_text('{}')
            for system, suffix in (("Windows", "pc-windows-msvc"), ("Darwin", "apple-darwin"), ("Linux", "unknown-linux-gnu")):
                for machine, arch in (("AMD64", "x86_64"), ("arm64", "aarch64")):
                    with self.subTest(system=system, machine=machine), \
                         patch("platform.system", return_value=system), patch("platform.machine", return_value=machine), \
                         patch("bilikara.config.VENDOR_DIR", vendor), \
                         patch("bilikara.config.INTERNAL_VENDOR_DIR", vendor / "absent"), \
                         patch.dict(os.environ, {"BILIKARA_MEDIA_BACKEND": "default"}), \
                         patch.object(rust_runtime, "_call_media_api", return_value={"configured": True}) as api:
                        self.assertEqual(rust_runtime._configure_media_routing(), (True, vendor.resolve(), ""))
                        api.assert_called_once_with("bilikara_runtime_media_startup", {
                            "mode": "default", "companion": str(vendor.resolve() / {"Windows": "bilikara_media_libav.dll", "Darwin": "libbilikara_media_libav.dylib", "Linux": "libbilikara_media_libav.so"}[system])})
                        # Absence of the library must reach Rust negotiation,
                        # rather than disguising a broken package as unprovisioned.
                        self.assertFalse((vendor / {"Windows": "bilikara_media_libav.dll", "Darwin": "libbilikara_media_libav.dylib", "Linux": "libbilikara_media_libav.so"}[system]).exists())

    def test_posix_manifest_validates_complete_flat_closure_and_rejects_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            vendor = Path(temporary)
            for target, library in (("x86_64-unknown-linux-gnu", "libavcodec.so.63"),
                                    ("aarch64-apple-darwin", "libavcodec.63.dylib")):
                names = ["ffmpeg", "ffprobe", library]
                for name in names:
                    (vendor / name).write_bytes(b"native")
                data = dict(schema_version=1, version="9.0.1", target=target, runtime_files=names)
                (vendor / MANIFEST).write_text(json.dumps(data))
                self.assertEqual([p.name for p in runtime_files(vendor)], names)
                for bad in ("../libescape.so", "libescape.so/child", "libescape.so:stream", "ffmpeg.exe"):
                    (vendor / MANIFEST).write_text(json.dumps({**data, "runtime_files": names + [bad]}))
                    with self.subTest(bad=bad), self.assertRaises(RuntimeError):
                        runtime_files(vendor)
                (vendor / MANIFEST).write_text(json.dumps(data))
                (vendor / library).unlink()
                with self.assertRaisesRegex(RuntimeError, "dependency is missing"):
                    runtime_files(vendor)

    def test_packaged_cli_uses_its_origin_without_developer_loader_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            vendor = Path(temporary)
            env = {"PATH": "/usr/bin"}
            with patch("platform.system", return_value="Linux"), patch.object(rust_runtime, "_media_tool_directory", vendor):
                self.assertEqual(rust_runtime.media_compatibility_env(env)["LD_LIBRARY_PATH"], str(vendor.parent / "lib"))
                (vendor / MANIFEST).write_text('{}')
                self.assertEqual(rust_runtime.media_compatibility_env(env), env)



class SourceLibavToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.vendor = self.root / "bin"
        self.vendor.mkdir()
        self.names = ["ffmpeg.exe", "ffprobe.exe", "avcodec-63.dll", "avformat-63.dll", "avutil-61.dll", "swresample-7.dll", "vcruntime140.dll"]
        for name in self.names + ["bilikara_media_libav.dll"]:
            (self.vendor / name).write_bytes(b"selected")
        self.manifest = {"schema_version": 1, "version": "9.0.1", "target": "x86_64-pc-windows-msvc",
                         "runtime_files": self.names}
        self.write_manifest()
        for name in ("source/ffmpeg-9.0.1.tar.xz", "licenses/COPYING.LGPLv2.1", "build-info.json"):
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_text("test fixture")

    def write_manifest(self):
        (self.vendor / MANIFEST).write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_manifest_rejects_escape_wrong_target_and_missing_dependencies(self):
        for change in ({"runtime_files": [*self.names, "../outside.dll"]}, {"target": "i686-pc-windows-msvc"}, {"version": "8.1.2"}, {"runtime_files": [*self.names, "missing.dll"]}):
            with self.subTest(change=change):
                old = self.manifest.copy()
                self.manifest.update(change)
                self.write_manifest()
                with self.assertRaises(RuntimeError):
                    runtime_files(self.vendor)
                self.manifest = old

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

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is required for installed MSVC license collection")
    def test_msvc_license_collection_selects_product_and_requires_records(self):
        script = (ROOT / "media-libav/prepare-windows.ps1").read_text(encoding="utf-8")
        start = script.index("$instances = @(")
        end = script.index("\n@(\n    'BILIKARA_FFMPEG_SOURCE_VERSION", start)
        collection = script[start:end]
        self.assertTrue(collection.strip())
        # PowerShell expands the Windows TEMP short name in $PSScriptRoot.
        installation = (self.root / "Visual Studio selected").resolve()
        redist = installation / "Licenses/1033/Redist.txt"
        redist.parent.mkdir(parents=True)
        redist.write_bytes(b"installed redistribution list")
        catalog_path = self.root / "Microsoft/VisualStudio/Packages/_Instances/selected/catalog.json"
        catalog_path.parent.mkdir(parents=True)
        product = "Microsoft.VisualStudio.Product.Enterprise"
        license_url = "https://go.microsoft.com/fwlink/?LinkId=2327713"
        selected = {"id": product, "localizedResources": [{"language": "en-us", "license": license_url}]}
        catalog = {"packages": [{"id": "unrelated", "localizedResources": []}, selected]}
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        instances = [
            {"installationPath": str(self.root / "other"), "instanceId": "other", "productId": "unrelated"},
            {"installationPath": str(installation), "instanceId": "selected", "productId": product,
             "installationVersion": "18.9.1"},
        ]
        (self.root / "instances.json").write_text(json.dumps(instances), encoding="utf-8")
        (self.root / "vswhere.ps1").write_text(
            "Get-Content (Join-Path $PSScriptRoot 'instances.json') -Raw\n$global:LASTEXITCODE = 0\n", encoding="utf-8")
        (self.root / "records").mkdir()
        check = self.root / "check.ps1"
        check.write_text("""$ErrorActionPreference = 'Stop'
$prefix = $PSScriptRoot
$env:ProgramData = $PSScriptRoot
$env:VSINSTALLDIR = (Join-Path $PSScriptRoot 'Visual Studio selected') + [IO.Path]::DirectorySeparatorChar
$vswhere = Join-Path $PSScriptRoot 'vswhere.ps1'
function Invoke-WebRequest($Uri, $OutFile) {
    if ($Uri -ne 'https://go.microsoft.com/fwlink/?LinkId=2327713') { throw 'Wrong product terms' }
    [IO.File]::WriteAllText($OutFile, 'selected product terms')
}
""" + collection, encoding="utf-8")
        def run():
            return subprocess.run([shutil.which("pwsh"), "-NoProfile", "-File", str(check)],
                                  capture_output=True, text=True, encoding="utf-8", timeout=30)
        result = run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "licenses/MSVC-Product-License.html").read_text(), "selected product terms")
        self.assertEqual((self.root / "licenses/MSVC-Redist.txt").read_bytes(), redist.read_bytes())
        record = json.loads((self.root / "records/msvc-license-source.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(record, {"product_id": product, "installation_version": "18.9.1", "license_url": license_url})
        selected["localizedResources"] = []
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        result = run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("product license URL unavailable", result.stderr)
        selected["localizedResources"] = [{"language": "en-us", "license": license_url}]
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        redist.unlink()
        result = run()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("redistribution list unavailable", result.stderr)


if __name__ == "__main__":
    unittest.main()
