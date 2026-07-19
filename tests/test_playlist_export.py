import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image, ImageDraw, ImageFont

import bilikara.playlist_export as playlist_export
from bilikara.playlist_export import (
    _find_system_font,
    _hidden_process_kwargs,
    _load_font,
    _select_font_for_char,
    _measure_text_with_fallback,
    _draw_text_with_fallback,
    playlist_image_export,
)

class PlaylistExportTest(unittest.TestCase):
    def tearDown(self):
        _find_system_font.cache_clear()

    def test_find_system_font_is_cached_by_weight(self):
        completed = SimpleNamespace(
            returncode=0,
            stdout="/fonts/example.ttf: Example\n",
        )
        _find_system_font.cache_clear()
        with patch("bilikara.playlist_export.shutil.which", return_value="fc-list"), patch(
            "bilikara.playlist_export.subprocess.run",
            return_value=completed,
        ) as run:
            self.assertEqual(_find_system_font(bold=False), "/fonts/example.ttf")
            self.assertEqual(_find_system_font(bold=False), "/fonts/example.ttf")
            self.assertEqual(_find_system_font(bold=True), "/fonts/example.ttf")
            self.assertEqual(_find_system_font(bold=True), "/fonts/example.ttf")

        self.assertEqual(run.call_count, 2)

    def test_hidden_process_kwargs_prevent_windows_console(self):
        startupinfo = SimpleNamespace(dwFlags=0, wShowWindow=None)
        startupinfo_cls = Mock(return_value=startupinfo)
        with patch("bilikara.playlist_export.os.name", "nt"), patch.object(
            playlist_export.subprocess,
            "STARTUPINFO",
            startupinfo_cls,
            create=True,
        ):
            kwargs = _hidden_process_kwargs()

        self.assertEqual(kwargs["creationflags"], 0x08000000)
        self.assertEqual(startupinfo.dwFlags & 0x00000001, 0x00000001)
        self.assertEqual(startupinfo.wShowWindow, 0)
        self.assertIs(kwargs["startupinfo"], startupinfo)

    def test_load_font_returns_list_of_fonts(self):
        fonts = _load_font(ImageFont, 24)
        self.assertIsInstance(fonts, list)
        self.assertTrue(len(fonts) > 0)
        # Check that they are either FreeTypeFont or standard ImageFont
        for font in fonts:
            self.assertTrue(
                isinstance(font, (ImageFont.FreeTypeFont, ImageFont.ImageFont))
            )

    def test_measure_text_with_fallback(self):
        fonts = _load_font(ImageFont, 24)
        img = Image.new("RGB", (100, 100))
        draw = ImageDraw.Draw(img)
        
        # Test normal ascii
        len_ascii = _measure_text_with_fallback(draw, "Hello", fonts)
        self.assertGreater(len_ascii, 0)
        
        # Test CJK + Emoji/Special characters
        len_cjk = _measure_text_with_fallback(draw, "你好 🌟", fonts)
        self.assertGreater(len_cjk, 0)

    def test_draw_text_with_fallback(self):
        fonts = _load_font(ImageFont, 24)
        img = Image.new("RGB", (100, 100))
        draw = ImageDraw.Draw(img)
        
        # Draw without raising exceptions
        _draw_text_with_fallback(draw, (0, 0), "Hello 你好 🌟", "#000000", fonts)

    def test_select_font_for_char_uses_support_probe_without_getindex(self):
        primary_font = object()
        symbol_font = object()

        def fake_supports(font, char):
            if char == "A":
                return font is primary_font
            if char == "★":
                return font is symbol_font
            return False

        with patch("bilikara.playlist_export._font_supports_char", side_effect=fake_supports):
            self.assertIs(_select_font_for_char([primary_font, symbol_font], "A"), primary_font)
            self.assertIs(_select_font_for_char([primary_font, symbol_font], "★"), symbol_font)

    def test_playlist_image_export_renders(self):
        entries = [
            {
                "title": "测试歌曲 你好 🌟",
                "display_title": "测试歌曲 你好 🌟",
                "part_title": "",
                "original_url": "https://www.bilibili.com/video/BV1xx411c7xv",
                "requester_name": "点歌人 💖",
                "owner_name": "UP主 🎶",
                "requested_at": 1718000000.0,
            }
        ]
        
        # Render a simple playlist image
        logo_path = Path("static/logo.png") # fake or none, playlist_image_export handles missing logo gracefully
        image_bytes, content_type, filename = playlist_image_export(
            entries,
            logo_path=logo_path,
            title="测试歌单",
            page_size=50,
        )
        
        self.assertGreater(len(image_bytes), 0)
        self.assertEqual(content_type, "image/png")
        self.assertTrue(filename.endswith(".png"))

if __name__ == "__main__":
    unittest.main()
