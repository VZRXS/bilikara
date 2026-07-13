import unittest
import ctypes
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


def fake_library(**symbols):
    symbols.setdefault("rust_free_string", FakeFunction())
    return SimpleNamespace(**symbols)


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

    def test_get_rust_lib_path_finds_executable_adjacent_library(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            bundled = root / "app" / "rust" / "libbilikara_rust.so"
            bundled.parent.mkdir(parents=True)
            bundled.touch()

            with self._lookup_environment(root, executable=root / "app" / "bilikara"):
                self.assertEqual(rust_backend._get_rust_lib_path(), bundled)

    def test_backend_status_structure(self):
        status = rust_backend.backend_status()
        self.assertIn("loaded", status)
        self.assertIn("error", status)
        self.assertIn("path", status)
        self.assertIn("capabilities", status)
        self.assertIn("fully_compatible", status)
        self.assertIn("missing_capabilities", status)
        self.assertIn("abi_version", status)
        self.assertIn("expected_abi_version", status)
        self.assertIn("abi_compatible", status)
        self.assertIsInstance(status["loaded"], bool)
        self.assertIsInstance(status["capabilities"], dict)
        self.assertEqual(status["fully_compatible"], not status["missing_capabilities"])
        self.assertEqual(title_cleanup.rust_backend_status(), status)

    def test_load_library_keeps_available_capability_when_symbol_is_missing(self):
        stale_library = fake_library(rust_clean_display_title=FakeFunction())
        with patch("bilikara.rust_backend.ctypes.CDLL", return_value=stale_library):
            library, capabilities, error = rust_backend._load_library(Path("stale-library"))

        self.assertIs(library, stale_library)
        self.assertIsNone(error)
        self.assertTrue(capabilities["title_cleanup"])
        self.assertFalse(capabilities["safe_filename"])

    def test_missing_symbol_disables_only_its_wrapper(self):
        stale_library = fake_library(rust_clean_display_title=FakeFunction())
        capabilities = rust_backend._configure_library(stale_library)
        with patch("bilikara.rust_backend._rust_lib", stale_library), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ):
            self.assertIsNone(rust_backend.safe_filename("demo.zip", "fallback.zip"))
            self.assertTrue(capabilities["title_cleanup"])

    def test_only_title_symbol_keeps_title_usable(self):
        result_buffer = ctypes.create_string_buffer("歌词".encode("utf-8"))
        library = fake_library(
            rust_clean_display_title=FakeFunction(ctypes.addressof(result_buffer))
        )
        capabilities = rust_backend._configure_library(library)
        with patch("bilikara.rust_backend._rust_lib", library), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ), patch("bilikara.rust_backend._RUST_LOAD_ERROR", None):
            status = rust_backend.backend_status()
            self.assertTrue(status["loaded"])
            self.assertFalse(status["fully_compatible"])
            self.assertTrue(status["capabilities"]["title_cleanup"])
            self.assertEqual(
                status["missing_capabilities"],
                sorted(set(rust_backend._SYMBOLS) - {"title_cleanup"}),
            )
            self.assertEqual(rust_backend.clean_display_title("title", "", ""), "歌词")
            self.assertIsNone(rust_backend.safe_filename("demo.zip", "fallback.zip"))
            self.assertEqual(rust_backend.try_version_tuple("v1.2.3"), (False, None))
            self.assertIsNone(rust_backend.normalize_machine_arch("AMD64"))

    def test_missing_free_string_disables_all_capabilities(self):
        library = SimpleNamespace(rust_clean_display_title=FakeFunction())
        with patch("bilikara.rust_backend.ctypes.CDLL", return_value=library):
            loaded, capabilities, error = rust_backend._load_library(Path("unsafe-library"))
        self.assertIsNone(loaded)
        self.assertFalse(any(capabilities.values()))
        self.assertEqual(error, "Rust library has no usable symbols")

        with patch("bilikara.rust_backend._rust_lib", loaded), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ), patch("bilikara.rust_backend._RUST_LOAD_ERROR", error):
            status = rust_backend.backend_status()
            self.assertFalse(status["loaded"])
            self.assertFalse(status["fully_compatible"])
            self.assertEqual(status["missing_capabilities"], sorted(rust_backend._SYMBOLS))

    def test_matching_abi_version(self):
        library = fake_library(rust_backend_abi_version=FakeFunction(1))
        version, compatible = rust_backend._detect_abi_version(library)
        self.assertEqual(version, 1)
        self.assertTrue(compatible)

    def test_missing_abi_symbol_is_legacy_compatible(self):
        version, compatible = rust_backend._detect_abi_version(fake_library())
        self.assertIsNone(version)
        self.assertIsNone(compatible)

    def test_incompatible_abi_disables_features_and_falls_back(self):
        library = fake_library(
            rust_backend_abi_version=FakeFunction(2),
            rust_clean_display_title=FakeFunction(),
        )
        version, compatible = rust_backend._detect_abi_version(library)
        self.assertEqual(version, 2)
        self.assertFalse(compatible)
        capabilities = rust_backend._empty_capabilities()
        with patch("bilikara.rust_backend._rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ), patch("bilikara.rust_backend._ABI_VERSION", version), patch(
            "bilikara.rust_backend._ABI_COMPATIBLE", compatible
        ), patch(
            "bilikara.rust_backend._RUST_LOAD_ERROR",
            "Rust backend ABI mismatch: expected 1, got 2",
        ):
            status = rust_backend.backend_status()
            self.assertFalse(status["loaded"])
            self.assertFalse(status["abi_compatible"])
            self.assertEqual(
                status["error"],
                "Rust backend ABI mismatch: expected 1, got 2",
            )
            self.assertEqual(
                title_cleanup.clean_display_title(title="【ニコカラ】歌词"), "歌词"
            )

    def test_clean_display_title_python_fallback_without_library(self):
        with patch("bilikara.rust_backend._rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES", rust_backend._empty_capabilities()
        ):
            self.assertIsNone(rust_backend.clean_display_title("title", "", ""))
            result = title_cleanup.clean_display_title(
                title="【ニコカラ】七里香 [on vocal]",
                display_title="七里香",
                part_title="",
            )
        self.assertEqual(result, "七里香 [on vocal]")

    def test_clean_display_title_falls_back_on_null_result(self):
        null_library = fake_library(rust_clean_display_title=FakeFunction(None))
        capabilities = rust_backend._configure_library(null_library)
        with patch("bilikara.rust_backend._rust_lib", null_library), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ):
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
    def _lookup_environment(root: Path, *, executable: Path | None = None):
        with patch.object(
            rust_backend, "__file__", str(root / "bilikara" / "rust_backend.py")
        ), patch("bilikara.rust_backend.platform.system", return_value="Linux"), patch.object(
            rust_backend.sys, "executable", str(executable or root / "python")
        ):
            yield
