"""Retained libav manifest and source-mode routing compatibility contracts."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.ffmpeg_vendor import MANIFEST, runtime_files


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



if __name__ == "__main__":
    unittest.main()
