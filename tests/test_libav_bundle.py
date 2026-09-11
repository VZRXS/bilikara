"""Native package provisioning, relocation and architecture contracts."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_bundle
from bilikara import rust_runtime
from bilikara.ffmpeg_vendor import MANIFEST, runtime_files
from scripts import libav_bundle


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
                        self.assertEqual(libav_bundle.native_target(), f"{arch}-{suffix}")
                        self.assertEqual(rust_runtime._configure_media_routing(), (True, vendor.resolve(), ""))
                        api.assert_called_once_with("bilikara_runtime_media_startup", {
                            "mode": "default", "companion": str(vendor.resolve() / libav_bundle.COMPANIONS[system])})
                        # Absence of the library must reach Rust negotiation,
                        # rather than disguising a broken package as unprovisioned.
                        self.assertFalse((vendor / libav_bundle.COMPANIONS[system]).exists())

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

    def test_prefix_rejects_cross_architecture_even_when_all_files_exist(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary)
            bindir = prefix / "bin"
            bindir.mkdir()
            for name in ("ffmpeg", "ffprobe", "libavcodec.so.63", "libbilikara_media_libav.so"):
                (bindir / name).write_bytes(b"native")
            (bindir / MANIFEST).write_text(json.dumps(dict(schema_version=1, version="9.0.1",
                target="aarch64-unknown-linux-gnu", runtime_files=["ffmpeg", "ffprobe", "libavcodec.so.63"])))
            with patch.dict(os.environ, {"BILIKARA_LIBAV_PREFIX": str(prefix)}), \
                 patch("platform.system", return_value="Linux"), patch("platform.machine", return_value="x86_64"), \
                 self.assertRaisesRegex(RuntimeError, "does not match"):
                libav_bundle.package_prefix()

    def test_packaged_cli_uses_its_origin_without_developer_loader_override(self):
        with tempfile.TemporaryDirectory() as temporary:
            vendor = Path(temporary)
            env = {"PATH": "/usr/bin"}
            with patch("platform.system", return_value="Linux"), patch.object(rust_runtime, "_media_tool_directory", vendor):
                self.assertEqual(rust_runtime.media_compatibility_env(env)["LD_LIBRARY_PATH"], str(vendor.parent / "lib"))
                (vendor / MANIFEST).write_text('{}')
                self.assertEqual(rust_runtime.media_compatibility_env(env), env)

    def test_macos_stage_keeps_manifest_in_resources_with_a_relative_vendor_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prefix, app = root / "prefix", root / "bilikara.app"
            for name in ("bin", "driver", "records", "licenses", "source"):
                (prefix / name).mkdir(parents=True)
            names = ["ffmpeg", "ffprobe", "libavcodec.63.dylib"]
            companion = "libbilikara_media_libav.dylib"
            test_companion = "libbilikara_media_libav_test.dylib"
            for name in [*names, companion, test_companion]:
                (prefix / "bin" / name).write_bytes(b"native")
            data = dict(schema_version=1, version="9.0.1", target="x86_64-apple-darwin",
                        runtime_files=names,
                        binaries={name: {} for name in [*names, companion, test_companion]})
            (prefix / "bin" / MANIFEST).write_text(json.dumps(data))
            (prefix / "build-info.json").write_text('{}')
            (app / "Contents/Frameworks/rust").mkdir(parents=True)
            vendor = app / "Contents/Frameworks/vendor"
            resources = app / "Contents/Resources/vendor"
            vendor.mkdir()
            resources.mkdir(parents=True)
            (resources / "aria2-macos.json").write_text('{}')
            (resources / "ffmpeg").write_bytes(b"old data copy")
            (vendor / "ffmpeg").symlink_to("../../Resources/vendor/ffmpeg")
            with patch("platform.system", return_value="Darwin"):
                libav_bundle.stage(prefix, app)
                # A second staging pass must preserve the resource and link.
                libav_bundle.stage(prefix, app)
            self.assertFalse((vendor / "ffmpeg").is_symlink())
            self.assertEqual((vendor / "ffmpeg").read_bytes(), b"native")
            self.assertTrue((vendor / MANIFEST).is_symlink())
            self.assertFalse(Path(os.readlink(vendor / MANIFEST)).is_absolute())
            self.assertEqual((vendor / MANIFEST).resolve(), (resources / MANIFEST).resolve())
            self.assertEqual([p.name for p in runtime_files(vendor)], names)
            self.assertNotIn("binaries", json.loads((resources / MANIFEST).read_text()))
            self.assertNotIn("drivers", json.loads((resources / MANIFEST).read_text()))
            self.assertTrue((vendor / companion).is_file())
            self.assertFalse((vendor / test_companion).exists())
            self.assertFalse((app / "Contents/Resources/libav-diagnostics").exists())
            self.assertEqual((resources / "aria2-macos.json").read_text(), '{}')

    def test_nested_signing_defers_outer_executable_until_bundle_seal(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "bilikara.app"
            main = app / "Contents/MacOS/bilikara"
            helper = app / "Contents/Resources/helper/native-helper"
            library = app / "Contents/Frameworks/vendor/libavcodec.63.dylib"
            for path in (main, helper, library):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(bytes.fromhex("cffaedfe") + b"synthetic Mach-O")
            with patch.object(build_bundle, "_sign_path") as sign:
                build_bundle._sign_nested_macho_objects(app)
            self.assertCountEqual([call.args[0] for call in sign.call_args_list], [helper, library])

    def test_macho_system_boundary_rejects_external_ffmpeg(self):
        with patch("platform.system", return_value="Darwin"):
            for path in ("/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"):
                self.assertTrue(libav_bundle.system_import(path))
            for path in ("/opt/homebrew/lib/libavformat.dylib", "@rpath/libavcodec.63.dylib", "@loader_path/libavutil.61.dylib"):
                self.assertFalse(libav_bundle.system_import(path))


if __name__ == "__main__":
    unittest.main()
