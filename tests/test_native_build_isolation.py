"""Retained legacy manifest adapter; construction isolation now runs in Node."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest


class NativeBuildIsolationTests(unittest.TestCase):
    def test_legacy_import_preserves_optional_manifest_and_missing_dependency_errors(self):
        from bilikara import ffmpeg_vendor

        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory)
            self.assertIsNone(ffmpeg_vendor.runtime_files(vendor))
            names = ["libbilikara_media_libav.so", "libavcodec.so.63"]
            (vendor / "ffmpeg-runtime.json").write_text(json.dumps(dict(
                schema_version=1, kind="libav", version="9.0.1",
                target="x86_64-unknown-linux-gnu", runtime_files=names,
            )), encoding="utf-8")
            for name in names:
                (vendor / name).write_bytes(b"native fixture")
            self.assertEqual(ffmpeg_vendor.runtime_files(vendor), [vendor / n for n in names])
            (vendor / names[1]).unlink()
            with self.assertRaisesRegex(RuntimeError, "dependency is missing"):
                ffmpeg_vendor.runtime_files(vendor)


if __name__ == "__main__":
    unittest.main()
