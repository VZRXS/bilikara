import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara import title_cleanup


class RustMigrationTest(unittest.TestCase):
    def test_get_rust_lib_path_finds_dev_release_before_debug(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            release = root / "rust" / "target" / "release" / "libbilikara_rust.so"
            debug = root / "rust" / "target" / "debug" / "libbilikara_rust.so"
            release.parent.mkdir(parents=True)
            debug.parent.mkdir(parents=True)
            release.touch()
            debug.touch()

            with patch.object(title_cleanup, "__file__", str(root / "bilikara" / "title_cleanup.py")), patch(
                "bilikara.title_cleanup.platform.system", return_value="Linux"
            ), patch.object(title_cleanup.sys, "executable", str(root / "python")):
                self.assertEqual(title_cleanup._get_rust_lib_path(), release)

    def test_get_rust_lib_path_finds_dev_debug(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            debug = root / "rust" / "target" / "debug" / "libbilikara_rust.so"
            debug.parent.mkdir(parents=True)
            debug.touch()

            with patch.object(title_cleanup, "__file__", str(root / "bilikara" / "title_cleanup.py")), patch(
                "bilikara.title_cleanup.platform.system", return_value="Linux"
            ), patch.object(title_cleanup.sys, "executable", str(root / "python")):
                self.assertEqual(title_cleanup._get_rust_lib_path(), debug)

    def test_get_rust_lib_path_finds_pyinstaller_bundle(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            meipass = root / "extracted"
            bundled = meipass / "rust" / "libbilikara_rust.so"
            bundled.parent.mkdir(parents=True)
            bundled.touch()

            with patch.object(title_cleanup, "__file__", str(root / "source" / "bilikara" / "title_cleanup.py")), patch(
                "bilikara.title_cleanup.platform.system", return_value="Linux"
            ), patch.object(title_cleanup.sys, "_MEIPASS", str(meipass), create=True), patch.object(
                title_cleanup.sys, "executable", str(root / "app" / "bilikara")
            ):
                self.assertEqual(title_cleanup._get_rust_lib_path(), bundled)

    def test_rust_backend_status_structure(self):
        status = title_cleanup.rust_backend_status()
        self.assertIn("loaded", status)
        self.assertIn("error", status)
        self.assertIn("path", status)
        self.assertIsInstance(status["loaded"], bool)

    def test_clean_display_title_python_fallback(self):
        # Force Rust lib to None and verify it still outputs correct cleaned title
        with patch("bilikara.title_cleanup._rust_lib", None):
            status = title_cleanup.rust_backend_status()
            self.assertFalse(status["loaded"])
            res = title_cleanup.clean_display_title(
                title="【ニコカラ】七里香 [on vocal]",
                display_title="七里香",
                part_title=""
            )
            self.assertEqual(res, "七里香 [on vocal]")

    def test_equivalence_cases_fallback_and_rust(self):
        # Define representative test cases
        # Each case is a tuple of (title, display_title, part_title)
        cleanup_cases = [
            # fullwidth bracket tags
            ("【ニコカラ】歌词", "", ""),
            ("【纯k投屏】七里香 卡拉OK字幕 1080p", "", ""),
            
            # normal bracket tags & karaoke keywords
            ("[Aegisub] (KTV) 『字幕』 <60fps> 〈无损〉 《Hi-Res》", "", ""),
            ("ニコカラ Aegisub びり因为 on/off vocal 无损 1080p mv", "", ""),
            
            # Japanese titles
            ("【ニコカラ】丸の内サディスティック [on vocal]", "", ""),
            
            # Chinese titles
            ("【卡拉OK】七里香", "", ""),
            
            # empty title with display_title fallback
            ("", "My Display Title", ""),
            
            # display_title with part_title suffix
            ("", "歌名 - P2", "P2"),
            
            # mixed separators
            ("歌名 - / \\ 、 ， , - 纯k", "", ""),
            
            # Unicode edge cases
            ("🌟 Emojis 🌟 and Unicode characters 【自用】", "", ""),
            
            # string containing an interior NUL character
            ("abc\x00def with interior null", "", ""),
            ("【ニコカラ\x00】歌词", "", ""),
        ]

        # First, run python-only fallback tests to ensure it runs without error
        with patch("bilikara.title_cleanup._rust_lib", None):
            for title, disp, part in cleanup_cases:
                py_res = title_cleanup.clean_display_title(
                    title=title, display_title=disp, part_title=part
                )
                self.assertIsNotNone(py_res)

        # Secondly, if Rust is loaded, verify output matches Python output exactly
        status = title_cleanup.rust_backend_status()
        if status["loaded"]:
            for title, disp, part in cleanup_cases:
                with patch("bilikara.title_cleanup._rust_lib", None):
                    py_res = title_cleanup.clean_display_title(
                        title=title, display_title=disp, part_title=part
                    )
                rust_res = title_cleanup.clean_display_title(
                    title=title, display_title=disp, part_title=part
                )
                self.assertEqual(
                    py_res, rust_res,
                    f"Equivalence failed for clean_display_title on input: title={repr(title)}, disp={repr(disp)}, part={repr(part)}"
                )
