from __future__ import annotations

from contextlib import ExitStack
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, call, patch
from types import SimpleNamespace

import build_bundle
from bilikara.ffmpeg_vendor import MANIFEST, runtime_files
from bilikara.windows_preview_smoke import ModuleSnapshotPending, backend, clean_environment, comparison_has_same_build, module_paths, remove_package_dependency, require_native_pe, run
from scripts import windows_libav_preview as preview
from scripts import libav_bundle

ROOT = Path(__file__).resolve().parents[1]


class WindowsPreviewTests(unittest.TestCase):
    def test_diagnostic_restores_error_mode_after_a_failure(self):
        kernel = SimpleNamespace(GetErrorMode=Mock(return_value=2), SetErrorMode=Mock(),
                                 GetDllDirectoryW=Mock(return_value=0))
        with ExitStack() as stack:
            stack.enter_context(patch("sys.platform", "win32"))
            stack.enter_context(patch("sys.frozen", True, create=True))
            stack.enter_context(patch("sys.executable", str(self.root / "bilikara.exe")))
            stack.enter_context(patch("ctypes.WinDLL", return_value=kernel, create=True))
            stack.enter_context(patch("bilikara.ffmpeg_vendor.runtime_files", return_value=[]))
            stack.enter_context(patch("bilikara.windows_preview_smoke.clean_environment", return_value={}))
            stack.enter_context(patch("bilikara.windows_preview_smoke.backend", side_effect=RuntimeError("synthetic failure")))
            with self.assertRaisesRegex(RuntimeError, "Windows package smoke failed"):
                run()
        self.assertEqual(kernel.SetErrorMode.call_args_list, [call(3), call(2)])
        result = json.loads((self.root / "libav-smoke-result.json").read_text())
        self.assertEqual(result["stage"], "default_backend")
        self.assertEqual(result["outcome"], "failed")

    def test_missing_dependency_fault_removes_all_packaged_copies_only(self):
        package = self.root / "package"
        locations = ("_internal/avutil-61.dll", "_internal/vendor/avutil-61.dll")
        for relative in locations:
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"dependency")
        neighbor = package / "_internal/avcodec-63.dll"
        neighbor.write_bytes(b"keep")
        outside = self.root / "avutil-61.dll"
        outside.write_bytes(b"outside")
        self.assertEqual(remove_package_dependency(package, "avutil-61.dll"), list(locations))
        self.assertFalse(any(package.rglob("avutil-61.dll")))
        self.assertEqual(neighbor.read_bytes(), b"keep")
        self.assertEqual(outside.read_bytes(), b"outside")
        with self.assertRaisesRegex(RuntimeError, "dependency is absent"):
            remove_package_dependency(package, "avutil-61.dll")

    def test_comparison_requires_every_same_build_fact_in_its_report_shape(self):
        self.assertTrue(comparison_has_same_build({"same_build": True}, packet_scan=False))
        self.assertTrue(comparison_has_same_build(
            {"same_build": {"inventory": True, "operational": True}}, packet_scan=True))
        for value in (None, False, 1, {}, {"inventory": True},
                      {"inventory": False, "operational": True},
                      {"inventory": True, "operational": False},
                      {"inventory": True, "operational": 1},
                      {"inventory": True, "operational": True, "extra": True}):
            with self.subTest(value=value):
                self.assertFalse(comparison_has_same_build({"same_build": value}, packet_scan=True))
                self.assertFalse(comparison_has_same_build({"same_build": value}, packet_scan=False))
        self.assertFalse(comparison_has_same_build({"same_build": True}, packet_scan=True))
        self.assertFalse(comparison_has_same_build(
            {"same_build": {"inventory": True, "operational": True}}, packet_scan=False))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.vendor = self.root / "bin"
        self.vendor.mkdir()
        self.names = ["ffmpeg.exe", "ffprobe.exe", "avcodec-63.dll", "avformat-63.dll", "avutil-61.dll", "swresample-7.dll", "vcruntime140.dll"]
        for name in self.names + [preview.COMPANION]:
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

    def test_unconfigured_tool_helper_preserves_developer_discovery(self):
        with patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": ""}), patch("build_bundle.shutil.which", return_value="/chosen/ffmpeg"), patch("build_bundle.platform.system", return_value="Linux"):
            self.assertIsNone(libav_bundle.package_prefix())
            self.assertEqual(build_bundle._resolve_bundle_binary_path("ffmpeg"), Path("/chosen/ffmpeg"))

    def test_prefix_is_explicit_fail_closed_and_never_uses_path(self):
        with patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": str(self.root)}), patch.object(preview.platform, "system", return_value="Windows"), patch.object(preview.platform, "machine", return_value="AMD64"), patch("build_bundle.shutil.which", side_effect=AssertionError("system fallback")):
            self.assertEqual(build_bundle._resolve_bundle_binary_path("ffmpeg"), self.vendor / "ffmpeg.exe")
            (self.vendor / "avutil-61.dll").unlink()
            with self.assertRaises(RuntimeError):
                build_bundle._resolve_bundle_binary_path("ffprobe")
            with patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": "relative-prefix"}):
                with self.assertRaises(RuntimeError):
                    libav_bundle.package_prefix()

    def test_manifest_rejects_escape_wrong_target_and_missing_dependencies(self):
        for change in ({"runtime_files": [*self.names, "../outside.dll"]}, {"target": "i686-pc-windows-msvc"}, {"version": "8.1.2"}, {"runtime_files": [*self.names, "missing.dll"]}):
            with self.subTest(change=change):
                old = self.manifest.copy()
                self.manifest.update(change)
                self.write_manifest()
                with self.assertRaises(RuntimeError):
                    runtime_files(self.vendor)
                self.manifest = old

    def test_shared_cli_stages_as_data_avoiding_pyinstaller_import_search(self):
        paths = {"ffmpeg": self.vendor / "ffmpeg.exe", "ffprobe": self.vendor / "ffprobe.exe", "BBDown": self.root / "BBDown.exe"}
        with patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": str(self.root)}), patch.object(build_bundle, "_resolved_bundle_binary_paths", return_value=(paths, [])):
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

    def test_extracted_machine_check_rejects_wrong_architecture_and_non_pe(self):
        path = self.root / "tool.exe"
        for host, expected in (("AMD64", 0x8664), ("arm64", 0xaa64)):
            for machine in (0x8664, 0xaa64, 0x14c):
                data = bytearray(128)
                data[:2] = b"MZ"
                struct.pack_into("<I", data, 60, 64)
                data[64:70] = b"PE\0\0" + struct.pack("<H", machine)
                path.write_bytes(data)
                with self.subTest(host=host, machine=machine), patch("platform.machine", return_value=host):
                    if machine == expected:
                        require_native_pe(path)
                    else:
                        with self.assertRaises(RuntimeError):
                            require_native_pe(path)
            path.write_bytes(b"not a PE executable")
            with patch("platform.machine", return_value=host), self.assertRaisesRegex(RuntimeError, "missing PE header"):
                require_native_pe(path)

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
        class WindowsEnvironment(dict):
            def __getitem__(self, key):
                return super().__getitem__(key.upper())
        environment = WindowsEnvironment(SYSTEMROOT=str(self.root), PATH="private-ffmpeg",
                                         BILIKARA_BILIBILI_COOKIE="private", FFMPEG_PATH="private")
        with patch("bilikara.windows_preview_smoke.os.environ", environment):
            env = clean_environment(self.root)
        self.assertEqual(env["SystemRoot"], str(self.root))
        self.assertNotIn("SYSTEMROOT", env)
        self.assertNotIn("BILIKARA_BILIBILI_COOKIE", env)
        self.assertNotIn("FFMPEG_PATH", env)
        self.assertEqual(env["PATH"].split(os.pathsep),
                         [str(self.root / part) for part in ("System32", "", "System32/Wbem")])

    def test_backend_smoke_requires_the_packaged_runtime_file_identity(self):
        package = self.root / "package"
        runtime = package / "_internal/rust/bilikara_runtime.dll"
        runtime.parent.mkdir(parents=True)
        runtime.write_bytes(b"runtime fixture")
        alias = package / "BILIKA~1.DLL"
        os.link(runtime, alias)
        foreign = self.root / "bilikara_runtime.dll"
        foreign.write_bytes(runtime.read_bytes())
        for loaded, valid in ((runtime, True), (alias, True), (foreign, False)):
            with self.subTest(loaded=loaded.name, valid=valid):
                child = SimpleNamespace(
                    pid=123, stdout=io.BytesIO(b'{"event":"bilikara.ready","port":12345}\n'),
                    poll=lambda: 0, wait=lambda timeout: 0,
                )
                health = io.BytesIO(b'{"ok":true,"status":"ready"}')
                shutdown = io.BytesIO()
                shutdown.status = 200
                diagnostics = {}
                with patch("bilikara.windows_preview_smoke.subprocess.Popen", return_value=child), patch(
                    "bilikara.windows_preview_smoke.module_paths", return_value=[self.root / "removed.dll", loaded]
                ), patch("bilikara.windows_preview_smoke.urllib.request.urlopen", side_effect=[health, shutdown]) as request:
                    if valid:
                        self.assertEqual(backend(package, self.root, {}, diagnostics)["outcome"], "success")
                        self.assertEqual(request.call_count, 2)
                    else:
                        with self.assertRaisesRegex(RuntimeError, "packaged mandatory Runtime missing"):
                            backend(package, self.root, {}, diagnostics)
                        self.assertEqual(request.call_count, 1)
                self.assertEqual(diagnostics["bilikara_modules"][0]["matches_runtime"], valid)
                self.assertEqual(diagnostics["module_path_errors"][0]["name"], "removed.dll")

    def test_module_snapshot_queries_the_wide_filename_and_closes_handles(self):
        expected = (self.root / "Bilikara preview \u7a7a" / "runtime.dll").resolve()
        expected.parent.mkdir()
        expected.write_bytes(b"module fixture")
        kernel = Mock()
        kernel.CreateToolhelp32Snapshot.return_value = 101
        kernel.OpenProcess.return_value = 202
        kernel.Module32NextW.return_value = False
        def first(snapshot, entry):
            entry._obj.hModule = 303
            entry._obj.szExePath = "C:\\lossy ?\\runtime.dll"
            return True
        def filename(process, module, buffer, capacity):
            self.assertEqual((process, module), (202, 303))
            self.assertGreater(capacity, len(str(expected)))
            buffer.value = str(expected)
            return len(buffer.value)
        kernel.Module32FirstW.side_effect = first
        kernel.K32GetModuleFileNameExW.side_effect = filename
        with patch("bilikara.windows_preview_smoke.ctypes.WinDLL", return_value=kernel, create=True):
            self.assertEqual(module_paths(404), [expected])
            kernel.OpenProcess.assert_called_once_with(0x0410, False, 404)
            self.assertEqual(kernel.CloseHandle.call_args_list, [call(202), call(101)])
            for count in (0, 32768):
                with self.subTest(filename_length=count):
                    kernel.CloseHandle.reset_mock()
                    kernel.K32GetModuleFileNameExW.side_effect = None
                    kernel.K32GetModuleFileNameExW.return_value = count
                    with self.assertRaisesRegex(RuntimeError, "module filename query failed or overflowed"):
                        module_paths(404)
                    self.assertEqual(kernel.CloseHandle.call_args_list, [call(202), call(101)])
            kernel.Module32FirstW.side_effect = None
            kernel.Module32FirstW.return_value = False
            for code, exception in ((18, ModuleSnapshotPending), (5, RuntimeError)):
                with self.subTest(winerror=code), patch(
                    "bilikara.windows_preview_smoke.ctypes.get_last_error", return_value=code, create=True
                ):
                    kernel.CloseHandle.reset_mock()
                    with self.assertRaises(exception) as failure:
                        module_paths(404)
                    self.assertIs(type(failure.exception), exception)
                    self.assertEqual(kernel.CloseHandle.call_args_list, [call(202), call(101)])

    @unittest.skipUnless(sys.platform == "win32", "Windows module enumeration requires Win32")
    def test_module_snapshot_identifies_the_loaded_windows_system_library(self):
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.assertTrue(kernel._handle)
        paths = module_paths(os.getpid())
        candidates = [p for p in paths if p.name.lower() == "kernel32.dll"]
        self.assertTrue(candidates, [p.name for p in paths])
        expected = Path(os.environ["SystemRoot"]) / "System32/kernel32.dll"
        self.assertTrue(any(p.samefile(expected) for p in candidates), candidates)

    @unittest.skipUnless(sys.platform == "win32", "Windows module enumeration requires Win32")
    def test_module_snapshot_preserves_unicode_loaded_library_path(self):
        directory = self.root / "Bilikara preview \u7a7a"
        directory.mkdir()
        library = directory / "unicode-version.dll"
        shutil.copy2(Path(os.environ["SystemRoot"]) / "System32/version.dll", library)
        # A child releases the loaded DLL before TemporaryDirectory cleanup.
        result = subprocess.run([sys.executable, "-c", """
import ctypes, os, sys
from pathlib import Path
from bilikara.windows_preview_smoke import module_paths
expected = Path(sys.argv[1]).resolve()
loaded = ctypes.WinDLL(str(expected))
assert loaded._handle
paths = module_paths(os.getpid())
candidates = [p for p in paths if p.name == expected.name]
assert candidates, [p.name for p in paths]
assert any(p.samefile(expected) for p in candidates), candidates
""", str(library)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_workflow_requires_all_native_targets_without_preview_input(self):
        text = (ROOT / ".github/workflows/ci-bundle.yml").read_text(encoding="utf-8")
        test_match = re.search(r"^        os: (.+)$", text, re.M)
        bundle_match = re.search(r"^        include: (.+)$", text, re.M)
        self.assertIsNotNone(test_match)
        self.assertIsNotNone(bundle_match)
        targets = ["windows-latest", "windows-11-arm", "macos-latest", "macos-15-intel", "ubuntu-latest", "ubuntu-24.04-arm"]
        self.assertEqual(json.loads(test_match[1]), targets)
        bundles = json.loads(bundle_match[1])
        self.assertEqual([entry["os"] for entry in bundles], targets)
        self.assertEqual({(e["slug"], e["arch"]) for e in bundles},
                         {(os, arch) for os in ("windows", "macos", "linux") for arch in ("x64", "arm64")})
        self.assertNotIn("windows_libav_preview", text)
        self.assertNotIn("BILIKARA_WINDOWS_LIBAV_PREVIEW", text)
        self.assertEqual(text.count("if: startsWith(github.ref, 'refs/tags/v')"), 2)
        for before, after in (("Setup native MSVC", "Build same-source Windows"),
                              ("Build same-source Windows", "Prepare native driver"),
                              ("Prepare native driver", "Build app bundle"),
                              ("Build same-source POSIX", "Build app bundle"),
                              ("Inject Tauri into Windows", "Archive Windows bundle"),
                              ("Archive Windows bundle", "Smoke extracted Windows"),
                              ("Smoke extracted Windows", "Upload native bundle"),
                              ("Smoke extracted macOS", "Upload native bundle"),
                              ("Archive and smoke extracted Linux", "Upload native bundle")):
            self.assertLess(text.index(before), text.index(after))
        self.assertIn("Expand-Archive -Path $env:BUNDLE_ARCHIVE", text)
        self.assertIn("--tool-smoke libav-package", text)

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

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is required for the preview smoke wrapper")
    def test_smoke_wrapper_bounds_wait_and_rejects_failed_results(self):
        wrapper = self.root / "libav-smoke.ps1"
        shutil.copy2(ROOT / "media-libav/windows-smoke.ps1", wrapper)
        (self.root / "bilikara.exe").write_bytes(b"mock executable")
        check = self.root / "check-smoke.ps1"
        check.write_text("""param($Mode)
$ErrorActionPreference = 'Stop'
$env:TEMP = $PSScriptRoot
$env:BILIKARA_HOME = 'previous home'
$global:SmokeMode = $Mode
function Start-Process($FilePath, $ArgumentList, [switch]$PassThru) {
    if ($ArgumentList -join ' ' -ne '--tool-smoke windows-libav-preview') { throw 'Wrong smoke command' }
    $process = [pscustomobject]@{ Handle = 1; ExitCode = 0 }
    $process | Add-Member ScriptMethod WaitForExit {
        param($milliseconds)
        if ($milliseconds -ne 900000) { throw 'Wrong timeout' }
        return $global:SmokeMode -ne 'timeout'
    }
    $process | Add-Member ScriptMethod Kill {
        param($tree)
        if (-not $tree) { throw 'Process tree was not terminated' }
        Set-Content (Join-Path $env:TEMP 'killed.txt') 'terminated'
    }
    return $process
}
try { & (Join-Path $PSScriptRoot 'libav-smoke.ps1') }
finally {
    if ($env:BILIKARA_HOME -ne 'previous home') { throw 'Home was not restored' }
}
""", encoding="utf-8")
        for mode in ("success", "timeout", "failed"):
            with self.subTest(mode=mode):
                (self.root / "libav-smoke-result.json").write_text(
                    json.dumps({"outcome": "failed" if mode == "failed" else "success"}), encoding="utf-8")
                result = subprocess.run([shutil.which("pwsh"), "-NoProfile", "-File", str(check), mode],
                                        capture_output=True, text=True, encoding="utf-8", timeout=30)
                if mode == "success":
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("timed out" if mode == "timeout" else "did not succeed", result.stderr)
                if mode == "timeout":
                    self.assertTrue((self.root / "killed.txt").is_file())


if __name__ == "__main__":
    unittest.main()
