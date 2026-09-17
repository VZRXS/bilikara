"""Behavior tests for P03's real Rust renderer/Runtime/FFI and HTTP consumers.
Pillow and ZXing are independent test decoders, never production renderers.
"""
import base64
import csv
from datetime import datetime
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
import zxingcpp

from bilikara import playlist_export as export, rust_runtime, server

SYNTHETIC = [
    {"title": "【ニコカラ】你好、日本語 Latin Café ★ 😀", "display_title": 'CSV, "quotes"\nsecond line',
     "requester_name": ' Alice, "B"\nC ', "owner_name": "山田 🎶", "owner_mid": 123,
     "request_count": 3, "requested_at": 1718000000, "played_at": 1718000200,
     "resolved_url": "https://www.bilibili.com/video/BV1xx411c7xv", "original_url": "av123", "part_title": "原曲"},
    {"title": "long 中文日本語 " * 30, "requester_name": "点歌人" * 20,
     "owner_name": "UP主" * 20, "played_at": 1718000100},
]


class PlaylistExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not rust_runtime.app_state_available():
            raise RuntimeError("P03 export tests require the real Rust Runtime library")

    def decode_png(self, payload, rows):
        image = Image.open(io.BytesIO(payload))
        image.load()
        self.assertEqual(image.format, "PNG")
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.size, (1600, max(760, 634 + rows * 104)))
        qr = zxingcpp.read_barcode(image.crop((80, 430 + rows * 104, 260, 610 + rows * 104)))
        self.assertIsNotNone(qr)
        self.assertTrue(qr.valid)
        self.assertEqual(qr.bytes, export.PROJECT_URL.encode())
        self.assertEqual(qr.ec_level, "M")
        return image

    def test_empty_single_and_boundary_multi_page_real_ffi(self):
        for count in [0, 2, 80, 81]:
            with self.subTest(count=count):
                items = [{"title": f"合成歌单 Synthetic {i}", "requested_at": 1718000000 + i} for i in range(count)]
                payload, mime, filename = export.playlist_image_export(items)
                if count <= 80:
                    self.assertEqual((mime, filename), ("image/png", "bilikara-playlist.png"))
                    self.decode_png(payload, count)
                else:
                    self.assertEqual((mime, filename), ("application/zip", "bilikara-playlist-images.zip"))
                    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                        self.assertIsNone(archive.testzip())
                        self.assertEqual(archive.namelist(), ["bilikara-playlist-page-01.png", "bilikara-playlist-page-02.png"])
                        first = self.decode_png(archive.read(archive.namelist()[0]), 80)
                        last = self.decode_png(archive.read(archive.namelist()[1]), 1)
                        self.assertNotEqual(first.crop((94, 371, 145, 407)).tobytes(), last.crop((94, 371, 145, 407)).tobytes())

    def test_long_fields_multilingual_symbols_emoji_and_alternate_rows(self):
        payload, _, _ = export.playlist_image_export(SYNTHETIC)
        image = self.decode_png(payload, 2)
        self.assertEqual(image.getpixel((100, 365)), (255, 255, 255))
        self.assertEqual(image.getpixel((100, 469)), (251, 246, 239))
        # Time content is inside the card, and all body glyphs remain above footer.
        self.assertGreater(len(set(image.crop((1280, 371, 1505, 413)).getdata())), 10)
        self.assertGreater(len(set(image.crop((158, 371, 650, 450)).getdata())), 10)

    def test_csv_exact_bom_quoting_newlines_columns_custom_label_and_order(self):
        values = [SYNTHETIC[1], {"title": "Undated", "requested_at": 0}, SYNTHETIC[0],
                  {"title": "Tie", "requested_at": 1718000000, "request_count": "bad"}]
        payload = export.playlist_csv_bytes(values, time_header="自定义时间")
        self.assertTrue(payload.startswith(b"\xef\xbb\xbf"))
        rows = list(csv.reader(io.StringIO(payload.decode("utf-8-sig"), newline="")))
        self.assertEqual(rows[0], ["序号", "标题", "BV 号", "点歌人", "UP 主", "UP 主 UID", "点歌次数", "自定义时间", "视频链接", "原始链接", "分P/版本"])
        self.assertEqual([r[0] for r in rows[1:]], ["1", "2", "3", "4"])
        self.assertEqual([r[1] for r in rows[1:]], [SYNTHETIC[0]["display_title"], "Tie", SYNTHETIC[1]["title"].strip(), "Undated"])
        self.assertEqual(rows[1][2:7], ["BV1xx411c7xv", 'Alice, "B"\nC', "山田 🎶", "123", "3"])
        self.assertEqual(rows[-1][7], "")
        # Independent stdlib writer reconstructs every byte including CRLF and quoting.
        expected = io.StringIO(newline="")
        csv.writer(expected).writerows(rows)
        self.assertEqual(payload, ("\ufeff" + expected.getvalue()).encode())
        self.assertEqual(len(list(csv.reader(io.StringIO(export.playlist_csv_bytes([]).decode("utf-8-sig"))))), 1)

    def test_local_time_including_dst_is_not_utc(self):
        # Windows uses the OS timezone; TZ overrides are a POSIX test facility.
        cases = [(os.environ.get("TZ", ""), datetime.fromtimestamp(1718000000).strftime("%Y-%m-%d %H:%M:%S"))] if os.name == "nt" else [
            ("Asia/Tokyo", "2024-06-10 15:13:20"),
            ("America/New_York", "2024-06-10 02:13:20"),
        ]
        for zone, expected in cases:
            code = "import sys; from bilikara.playlist_export import playlist_csv_bytes; sys.stdout.buffer.write(playlist_csv_bytes([{'requested_at':1718000000}]))"
            result = subprocess.run([sys.executable, "-c", code], env={**os.environ, "TZ": zone, "PYTHONIOENCODING": "cp1252"}, capture_output=True, check=True)
            self.assertTrue(result.stdout.startswith(b"\xef\xbb\xbf"))
            self.assertIn(expected, result.stdout.decode("utf-8-sig"))

    def test_configured_bundle_root_and_cwd_independence(self):
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Contents" / "Resources" / "static"
            (root / "fonts").mkdir(parents=True)
            shutil.copyfile(export.STATIC_DIR / "fonts" / "SourceHanSans-VF.ttf", root / "fonts" / "SourceHanSans-VF.ttf")
            try:
                os.chdir(temporary)
                with patch.object(export, "STATIC_DIR", root):
                    export.prewarm_playlist_export_fonts()
                    self.decode_png(export.playlist_image_export([SYNTHETIC[0]])[0], 1)
            finally:
                os.chdir(original_cwd)

    def test_prewarm_best_effort_and_actual_export_errors_propagate(self):
        with patch.object(export, "prewarm_playlist_fonts", side_effect=RuntimeError("font failure")):
            export.prewarm_playlist_export_fonts()
        with patch.object(export, "STATIC_DIR", Path("/nonexistent-synthetic-export-root")):
            export.prewarm_playlist_export_fonts()
            with self.assertRaises(rust_runtime.RustRuntimeServiceError) as error:
                export.playlist_image_export([])
            self.assertEqual(error.exception.kind, "font_unavailable")
        with patch.object(rust_runtime, "_runtime_lib", None):
            for call in [lambda: export.playlist_csv_bytes([]), lambda: export.playlist_image_export([])]:
                with self.assertRaises(rust_runtime.RustRuntimeUnavailableError): call()

    def test_invalid_ffi_request_and_artifact_fail_explicitly(self):
        for request in [{"operation": "bogus"}, {"operation": "csv", "items": [None], "time_header": "time"}]:
            with self.assertRaises(rust_runtime.RustRuntimeServiceError) as error:
                rust_runtime._call_runtime_service("playlist_export", request)
            self.assertEqual(error.exception.kind, "invalid_request")
        for artifact in [{}, {"data_base64": "@@", "mime_type": "image/png", "filename": "bad.png", "missing_glyphs": []},
                         {"data_base64": base64.b64encode(b"\x89PNG\r\n\x1a\n").decode(), "mime_type": "image/png", "filename": "bilikara-playlist.png", "missing_glyphs": []}]:
            with patch.object(rust_runtime, "_call_runtime_service", return_value=artifact):
                with self.assertRaises(rust_runtime.RustRuntimeServiceError): export.playlist_image_export([])

    def test_production_export_does_not_import_pillow(self):
        code = '''
import builtins, sys
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == "PIL" or name.startswith("PIL."):
        raise AssertionError("Production export attempted to import Pillow")
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from bilikara.playlist_export import playlist_image_export, playlist_csv_bytes, prewarm_playlist_export_fonts
prewarm_playlist_export_fonts()
assert playlist_image_export([])[1] == "image/png"
assert playlist_image_export([{"title":"A"},{"title":"B"}], page_size=1)[1] == "application/zip"
assert playlist_csv_bytes([]).startswith(b"\\xef\\xbb\\xbf")
assert not any(m == "PIL" or m.startswith("PIL.") for m in sys.modules)
'''
        subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True)

    def test_real_http_consumer_for_history_played_alias_and_zip(self):
        for route, source, count in [("playlist", "history", 1), ("history", "played", 81)]:
            handler = server.BilikaraHandler.__new__(server.BilikaraHandler)
            handler.path = f"/api/{route}/export?format=image&source={source}&page_size=80"
            handler.headers = {}
            items = [{"title": f"合成 HTTP {i}"} for i in range(count)]
            context = SimpleNamespace(touch_client=lambda *a, **k: None, history_snapshot=lambda: items, session_played_snapshot=lambda: items)
            writes = []
            handler._write_download = lambda payload, content_type, filename: writes.append((payload, content_type, filename))
            handler._write_json = lambda *a, **k: self.fail(f"HTTP export failed: {a}")
            with patch.object(server, "CONTEXT", context), patch.object(server.time, "strftime", return_value="20240101-123456"):
                handler.do_GET()
            self.assertEqual(len(writes), 1)
            payload, mime, filename = writes[0]
            self.assertEqual(filename, f"bilikara-{source}-20240101-123456." + ("png" if count == 1 else "zip"))
            self.assertEqual(mime, "image/png" if count == 1 else "application/zip")
            if count == 1: self.decode_png(payload, 1)
            else:
                with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                    self.assertEqual(len(archive.namelist()), 2)
                    self.decode_png(archive.read(archive.namelist()[1]), 1)


if __name__ == "__main__":
    unittest.main()
