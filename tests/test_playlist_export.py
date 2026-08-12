import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image, ImageDraw, ImageFont

import bilikara.playlist_export as playlist_export
from bilikara.playlist_export import (
    _find_system_font,
    _bundled_source_han_sans_path,
    _font_supports_char,
    _hidden_process_kwargs,
    _load_font,
    _select_font_for_char,
    _measure_text_with_fallback,
    _draw_text_with_fallback,
    playlist_image_export,
    prewarm_playlist_export_fonts,
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

    def test_bundled_font_path_is_absolute_and_rooted_at_configured_static_dir(self):
        expected = (playlist_export.STATIC_DIR / "fonts" / "SourceHanSans-VF.ttf").resolve()
        self.assertEqual(_bundled_source_han_sans_path(), expected)
        self.assertTrue(_bundled_source_han_sans_path().is_absolute())

        frozen_static_dir = Path("/runtime/Contents/Resources/static")
        with patch.object(playlist_export, "STATIC_DIR", frozen_static_dir):
            self.assertEqual(
                _bundled_source_han_sans_path(),
                (frozen_static_dir / "fonts" / "SourceHanSans-VF.ttf").resolve(),
            )

    def test_load_font_uses_bundled_source_han_after_current_directory_changes(self):
        expected = _bundled_source_han_sans_path()
        original_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary_directory:
            try:
                os.chdir(temporary_directory)
                fonts = _load_font(ImageFont, 24)
            finally:
                os.chdir(original_cwd)

        self.assertGreater(len(fonts), 0)
        self.assertEqual(Path(fonts[0].path).resolve(), expected)

    def test_bundled_source_han_is_primary_for_ordinary_export_text_and_uses_fallback_for_emoji(self):
        fonts = _load_font(ImageFont, 24)
        primary = fonts[0]
        self.assertEqual(Path(primary.path).resolve(), _bundled_source_han_sans_path())

        for char in ("A", "7", "你", "日", "。", "!"):
            self.assertTrue(_font_supports_char(primary, char), char)
            self.assertIs(_select_font_for_char(fonts, char), primary)

        class EmojiFallback:
            @staticmethod
            def getindex(char):
                return 1 if char == "🌟" else 0

        self.assertFalse(_font_supports_char(primary, "🌟"))
        fallback = EmojiFallback()
        self.assertIs(_select_font_for_char([primary, fallback], "🌟"), fallback)

    def test_variable_font_weight_selection_uses_the_bundled_font_for_normal_and_bold(self):
        expected = _bundled_source_han_sans_path()

        class FakeVariableFont:
            def __init__(self, path):
                self.path = str(path)
                self.variation_axes = []

            @staticmethod
            def get_variation_axes():
                return [{"name": b"Weight"}]

            def set_variation_by_axes(self, axes):
                self.variation_axes.append(axes)

        class FakeFontModule:
            def __init__(self):
                self.successful_paths = []

            def truetype(self, path, _size, index=0):
                del index
                resolved_path = Path(path).resolve()
                if resolved_path != expected:
                    raise OSError("unavailable fallback font")
                self.successful_paths.append(resolved_path)
                return FakeVariableFont(resolved_path)

            @staticmethod
            def load_default():
                raise AssertionError("the bundled font should load")

        with patch("bilikara.playlist_export._find_system_font", return_value=None):
            normal_module = FakeFontModule()
            normal_fonts = _load_font(normal_module, 24)
            bold_module = FakeFontModule()
            bold_fonts = _load_font(bold_module, 24, bold=True)

        self.assertEqual(normal_module.successful_paths, [expected])
        self.assertEqual(bold_module.successful_paths, [expected])
        self.assertEqual(normal_fonts[0].variation_axes, [[450]])
        self.assertEqual(bold_fonts[0].variation_axes, [[800]])

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

    def test_prewarm_playlist_export_fonts_loads_exact_render_fonts_and_cmaps(self):
        fonts = [[object(), object()], [object()], [object()], [object()], [object()]]
        with patch(
            "bilikara.playlist_export._load_font", side_effect=fonts
        ) as load_font, patch(
            "bilikara.playlist_export._font_codepoints"
        ) as font_codepoints, patch(
            "bilikara.playlist_export.playlist_image_export",
            side_effect=AssertionError("prewarm must not render an image"),
        ):
            prewarm_playlist_export_fonts()

        self.assertEqual(
            [(call.args[1], call.kwargs["bold"]) for call in load_font.call_args_list],
            [(72, True), (27, False), (25, True), (24, False), (22, False)],
        )
        self.assertEqual(
            [call.args[0] for call in font_codepoints.call_args_list],
            [font for group in fonts for font in group],
        )

    def test_prewarm_uses_the_same_bundled_font_source_as_rendering(self):
        expected = _bundled_source_han_sans_path()
        successful_paths = []

        class FakeFont:
            def __init__(self, path):
                self.path = str(path)

            @staticmethod
            def get_variation_axes():
                return []

        def load_bundled_font(path, _size, index=0):
            del index
            resolved_path = Path(path).resolve()
            if resolved_path != expected:
                raise OSError("unavailable fallback font")
            successful_paths.append(resolved_path)
            return FakeFont(resolved_path)

        with patch("PIL.ImageFont.truetype", side_effect=load_bundled_font), patch(
            "bilikara.playlist_export._font_codepoints"
        ), patch("bilikara.playlist_export._find_system_font", return_value=None):
            prewarm_playlist_export_fonts()

        self.assertEqual(successful_paths, [expected] * 5)

    def test_prewarm_playlist_export_fonts_swallows_font_errors(self):
        with patch(
            "bilikara.playlist_export._load_font",
            side_effect=RuntimeError("font discovery failed"),
        ):
            prewarm_playlist_export_fonts()

    def test_playlist_image_export_renders(self):
        entries = [
            {
                "title": "bilikara 2026：你好、カラオケ! 🌟",
                "display_title": "bilikara 2026：你好、カラオケ! 🌟",
                "part_title": "",
                "original_url": "https://www.bilibili.com/video/BV1xx411c7xv",
                "requester_name": "点歌人 Alice 7 💖",
                "owner_name": "UP主 山田 🎶",
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
