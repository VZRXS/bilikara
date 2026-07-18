import ctypes
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend, title_cleanup, updater


EXPECTED_PHASE1_CAPABILITIES = {
    "title_cleanup",
    "safe_filename",
    "normalize_version_tag",
    "version_tuple",
    "version_sort_key",
    "normalize_machine_arch",
    "asset_tokens",
    "asset_has_windows",
    "asset_has_macos",
    "asset_has_linux",
    "asset_has_x64",
    "asset_has_arm64",
    "asset_has_universal",
    "release_list_api_from_latest",
    "format_download_proxy_url",
    "is_downloadable_archive",
}

EXPECTED_PHASE2_CAPABILITIES = {
    "select_update_asset",
    "select_release",
    "select_media_pages",
    "decide_audio_binding",
    "plan_update_download_candidates",
    "plan_media_download_candidates",
    "plan_tool_download_candidates",
}


class FakeFunction:
    def __init__(self, result=None):
        self.result = result

    def __call__(self, *args):
        return self.result


class NativeUtilityReleaseGateTest(unittest.TestCase):
    def test_compiled_backend_is_fully_compatible_and_executes_every_domain(self):
        status = rust_backend.backend_status()
        library_path = Path(str(status["path"]))
        if not library_path.is_file():
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but the Rust dynamic library is not compiled"
                )
            self.skipTest("Rust dynamic library is not compiled")

        self.assertTrue(status["loaded"])
        self.assertEqual(status["abi_version"], 1)
        self.assertTrue(status["abi_compatible"])
        self.assertTrue(status["fully_compatible"])
        self.assertTrue(
            EXPECTED_PHASE1_CAPABILITIES.issubset(status["capabilities"])
        )
        self.assertTrue(
            all(
                status["capabilities"][capability]
                for capability in EXPECTED_PHASE1_CAPABILITIES
            )
        )
        self.assertTrue(all(status["capabilities"].values()))
        self.assertEqual(set(rust_backend.PHASE2_CAPABILITIES), EXPECTED_PHASE2_CAPABILITIES)

        # These are Rust-only backend calls. None/False completion sentinels
        # fail the gate instead of silently reaching the public Python fallback.
        self.assertEqual(
            rust_backend.clean_display_title("【ニコカラ】歌曲", "", ""),
            "歌曲",
        )
        self.assertEqual(
            rust_backend.safe_filename("歌名 / demo.zip", "fallback.zip"),
            updater._py_safe_filename("歌名 / demo.zip", "fallback.zip"),
        )
        self.assertEqual(rust_backend.try_version_tuple("v1.2.3"), (True, (1, 2, 3)))
        self.assertEqual(rust_backend.normalize_machine_arch("AMD64"), "x64")
        tokens = rust_backend.asset_tokens("bilikara-windows-x64.zip")
        self.assertEqual(tokens, {"bilikara", "windows", "x64", "zip"})
        assert tokens is not None
        self.assertTrue(rust_backend.asset_has_windows(tokens))
        self.assertEqual(
            rust_backend.release_list_api_from_latest(
                "https://api.example/releases/latest"
            ),
            "https://api.example/releases",
        )
        self.assertTrue(
            rust_backend.is_downloadable_archive(
                "bilikara.zip",
                "https://example/bilikara.zip",
            )
        )
        completed, plan = rust_backend.try_plan_update_download_candidates(
            {
                "schema_version": 1,
                "candidates": [
                    {
                        "original_index": 0,
                        "url": "https://example/app.zip",
                        "source": "primary",
                    }
                ],
                "proxy": {
                    "template": "https://proxy/{url}",
                    "proxy_first": True,
                },
            }
        )
        self.assertTrue(completed)
        self.assertEqual(
            [candidate["route"] for candidate in plan["candidates"]],
            ["proxy", "direct"],
        )
        completed, media_plan = rust_backend.try_plan_media_download_candidates(
            {
                "schema_version": 1,
                "mode": "dash_streams",
                "stream_kind": "video",
                "streams": [
                    {
                        "original_index": 0,
                        "primary_url": " primary ",
                        "backup_urls": ["backup", "primary"],
                    }
                ],
            }
        )
        self.assertTrue(completed)
        self.assertEqual(
            [candidate["url"] for candidate in media_plan["candidates"]],
            ["primary", "backup", "primary"],
        )
        completed, tool_plan = rust_backend.try_plan_tool_download_candidates(
            {
                "schema_version": 1,
                "tool": "ytdlp",
                "asset": {
                    "mode": "supplied",
                    "name": "yt-dlp",
                    "primary_url": "https://primary/yt-dlp",
                },
                "fallback_bases": [
                    {"original_index": 0, "base_url": "https://mirror"}
                ],
            }
        )
        self.assertTrue(completed)
        self.assertEqual(
            [candidate["url"] for candidate in tool_plan["candidates"]],
            ["https://primary/yt-dlp", "https://mirror/yt-dlp"],
        )

    def test_phase1_capability_documentation_matches_backend_symbols(self):
        self.assertEqual(set(rust_backend.PHASE1_CAPABILITIES), EXPECTED_PHASE1_CAPABILITIES)
        self.assertTrue(EXPECTED_PHASE1_CAPABILITIES.issubset(rust_backend._SYMBOLS))

        inventory_path = (
            Path(__file__).resolve().parent.parent
            / "docs"
            / "rust-native-utility-inventory.md"
        )
        inventory = inventory_path.read_text(encoding="utf-8")
        capability_section = inventory.split(
            "### Python capabilities and fallback conventions", 1
        )[1]
        documented_block = capability_section.split("```text", 1)[1].split("```", 1)[0]
        documented = {
            line.strip() for line in documented_block.splitlines() if line.strip()
        }
        self.assertEqual(documented, EXPECTED_PHASE1_CAPABILITIES)

    def test_public_wrappers_fall_back_without_library(self):
        with patch("bilikara.rust_backend._rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES",
            rust_backend._empty_capabilities(),
        ):
            self._assert_public_python_behavior()

    def test_public_wrappers_fall_back_for_incompatible_abi(self):
        self.assertEqual(
            rust_backend._abi_compatibility_error(2, False),
            "Rust backend ABI mismatch: expected 1, got 2",
        )
        capabilities = rust_backend._empty_capabilities()
        with patch("bilikara.rust_backend._rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ), patch("bilikara.rust_backend._ABI_VERSION", 2), patch(
            "bilikara.rust_backend._ABI_COMPATIBLE", False
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
            self.assertFalse(any(status["capabilities"].values()))
            self._assert_public_python_behavior()

    def test_partial_legacy_library_keeps_supported_feature_and_fallbacks(self):
        title_buffer = ctypes.create_string_buffer("歌曲".encode("utf-8"))
        library = SimpleNamespace(
            rust_free_string=FakeFunction(),
            rust_clean_display_title=FakeFunction(ctypes.addressof(title_buffer)),
        )
        capabilities = rust_backend._configure_library(library)
        abi_version, abi_compatible = rust_backend._detect_abi_version(library)
        self.assertIsNone(abi_version)
        self.assertIsNone(abi_compatible)

        with patch("bilikara.rust_backend._rust_lib", library), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ), patch("bilikara.rust_backend._ABI_VERSION", abi_version), patch(
            "bilikara.rust_backend._ABI_COMPATIBLE", abi_compatible
        ), patch("bilikara.rust_backend._RUST_LOAD_ERROR", None):
            status = rust_backend.backend_status()
            self.assertTrue(status["loaded"])
            self.assertIsNone(status["abi_version"])
            self.assertIsNone(status["abi_compatible"])
            self.assertTrue(status["capabilities"]["title_cleanup"])
            self.assertFalse(status["capabilities"]["safe_filename"])
            self.assertEqual(title_cleanup.clean_display_title(title="title"), "歌曲")
            self.assertEqual(
                updater._safe_filename("歌名 / demo.zip", "fallback.zip"),
                updater._py_safe_filename("歌名 / demo.zip", "fallback.zip"),
            )
            self.assertEqual(updater.version_tuple("v1.2.3"), (1, 2, 3))
            self.assertEqual(updater.normalize_machine_arch("AMD64"), "x64")
            self.assertTrue(
                updater._is_downloadable_archive(
                    {
                        "name": "bilikara.zip",
                        "browser_download_url": "https://example/bilikara.zip",
                    }
                )
            )

    def _assert_public_python_behavior(self):
        self.assertEqual(title_cleanup.clean_display_title(title="【ニコカラ】歌曲"), "歌曲")
        self.assertEqual(
            updater._safe_filename("歌名 / demo.zip", "fallback.zip"),
            updater._py_safe_filename("歌名 / demo.zip", "fallback.zip"),
        )
        self.assertEqual(updater.normalize_version_tag(" v1.2.3 "), "v1.2.3")
        self.assertEqual(updater.version_tuple("v1.2.3"), (1, 2, 3))
        self.assertEqual(updater.version_sort_key("v1.2.3"), (1, 2, 3, 1, 0))
        self.assertEqual(updater.normalize_machine_arch(" AMD64 "), "x64")
        tokens = updater._asset_tokens("bilikara-windows-x64.zip")
        self.assertEqual(tokens, {"bilikara", "windows", "x64", "zip"})
        self.assertTrue(updater._asset_has_windows(tokens))
        self.assertFalse(updater._asset_has_macos(tokens))
        self.assertFalse(updater._asset_has_linux(tokens))
        self.assertTrue(updater._asset_has_x64("bilikara-windows-x64.zip", tokens))
        self.assertFalse(updater._asset_has_arm64("bilikara-windows-x64.zip", tokens))
        self.assertFalse(updater._asset_has_universal(tokens))
        self.assertEqual(
            updater._release_list_api_from_latest(
                "https://api.example/releases/latest"
            ),
            "https://api.example/releases",
        )
        self.assertEqual(
            updater._format_download_proxy_url(
                "https://proxy",
                "https://example/bilikara.zip",
            ),
            "https://proxy/https://example/bilikara.zip",
        )
        self.assertTrue(
            updater._is_downloadable_archive(
                {
                    "name": "bilikara.zip",
                    "browser_download_url": "https://example/bilikara.zip",
                }
            )
        )
