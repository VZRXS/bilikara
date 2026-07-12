import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend, title_cleanup


class FakeFunction:
    def __init__(self, result=None):
        self.result = result

    def __call__(self, *args):
        return self.result


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

            with self._lookup_environment(root):
                self.assertEqual(rust_backend._get_rust_lib_path(), release)

    def test_get_rust_lib_path_finds_dev_debug(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            debug = root / "rust" / "target" / "debug" / "libbilikara_rust.so"
            debug.parent.mkdir(parents=True)
            debug.touch()

            with self._lookup_environment(root):
                self.assertEqual(rust_backend._get_rust_lib_path(), debug)

    def test_get_rust_lib_path_finds_pyinstaller_bundle(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            meipass = root / "extracted"
            bundled = meipass / "rust" / "libbilikara_rust.so"
            bundled.parent.mkdir(parents=True)
            bundled.touch()

            with self._lookup_environment(root), patch.object(
                rust_backend.sys, "_MEIPASS", str(meipass), create=True
            ):
                self.assertEqual(rust_backend._get_rust_lib_path(), bundled)

    def test_backend_status_structure(self):
        status = rust_backend.backend_status()
        self.assertIn("loaded", status)
        self.assertIn("error", status)
        self.assertIn("path", status)
        self.assertIsInstance(status["loaded"], bool)
        self.assertEqual(title_cleanup.rust_backend_status(), status)

    def test_load_library_rejects_missing_symbol(self):
        stale_library = SimpleNamespace(rust_clean_display_title=FakeFunction())
        with patch("bilikara.rust_backend.ctypes.CDLL", return_value=stale_library):
            library, error = rust_backend._load_library(Path("stale-library"))

        self.assertIsNone(library)
        self.assertIn("rust_safe_filename", error)

    def test_clean_display_title_python_fallback_without_library(self):
        with patch("bilikara.rust_backend._rust_lib", None):
            self.assertIsNone(rust_backend.clean_display_title("title", "", ""))
            result = title_cleanup.clean_display_title(
                title="【ニコカラ】七里香 [on vocal]",
                display_title="七里香",
                part_title="",
            )
        self.assertEqual(result, "七里香 [on vocal]")

    def test_clean_display_title_falls_back_on_null_result(self):
        null_library = SimpleNamespace(rust_clean_display_title=FakeFunction(None))
        with patch("bilikara.rust_backend._rust_lib", null_library):
            result = title_cleanup.clean_display_title(title="【ニコカラ】歌词")
        self.assertEqual(result, "歌词")

    def test_direct_rust_title_cleanup_matches_python(self):
        if not rust_backend.backend_status()["loaded"]:
            self.skipTest("Rust dynamic library is not available")

        cases = [
            ("【ニコカラ】歌词", "", ""),
            ("【纯k投屏】七里香 卡拉OK字幕 1080p", "", ""),
            ("[Aegisub] (KTV) 『字幕』 <60fps> 〈无损〉 《Hi-Res》", "", ""),
            ("【ニコカラ】丸の内サディスティック [on vocal]", "", ""),
            ("【卡拉OK】七里香", "", ""),
            ("", "My Display Title", ""),
            ("", "歌名 - P2", "P2"),
            ("🌟 Emojis 🌟 and Unicode characters 【自用】", "", ""),
            ("abc\x00def with interior null", "", ""),
        ]
        for title, display_title, part_title in cases:
            with self.subTest(title=title):
                rust_result = rust_backend.clean_display_title(title, display_title, part_title)
                self.assertIsNotNone(rust_result)
                self.assertEqual(
                    rust_result,
                    title_cleanup._py_clean_display_title(
                        title=title.replace("\x00", ""),
                        display_title=display_title.replace("\x00", ""),
                        part_title=part_title.replace("\x00", ""),
                    ),
                )

    @staticmethod
    @contextmanager
    def _lookup_environment(root: Path):
        with patch.object(
            rust_backend, "__file__", str(root / "bilikara" / "rust_backend.py")
        ), patch("bilikara.rust_backend.platform.system", return_value="Linux"), patch.object(
            rust_backend.sys, "executable", str(root / "python")
        ):
            yield
