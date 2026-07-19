import itertools
import os
import unittest
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.cache import CacheManager


class ToolDownloadCandidatePlanningPolicyTest(unittest.TestCase):
    def test_python_reference_is_primary_first_exact_and_stably_deduplicated(self):
        asset = {"name": "tool name/歌曲", "browser_download_url": " primary "}
        self.assertEqual(
            CacheManager._py_tool_download_candidates(
                asset, "unused", ["", "https://one", "https://one"]
            ),
            [" primary ", "https://one/tool%20name/%E6%AD%8C%E6%9B%B2"],
        )
        self.assertEqual(
            CacheManager._py_fallback_tool_asset("tool name", "https://one"),
            {
                "name": "tool name",
                "browser_download_url": "https://one/tool%20name",
            },
        )

    def test_python_default_assets_cover_all_existing_target_rules(self):
        fixtures = [
            ("bbdown", "windows", "x86", "BBDown_1.6.3_20240814_win-x64.zip"),
            ("bbdown", "darwin", "arm64", "BBDown_1.6.3_20240814_osx-arm64.zip"),
            ("ytdlp", "windows", "arm64", "yt-dlp_arm64.exe"),
            ("ytdlp", "other", "mips", "yt-dlp"),
            ("aria2c", "windows", "x86", "aria2-1.37.0-win-32bit-build1.zip"),
        ]
        for tool, platform_name, arch, expected_name in fixtures:
            with self.subTest(tool=tool, platform=platform_name, arch=arch):
                asset = CacheManager._py_default_tool_fallback_asset(
                    tool, platform_name, arch, "https://mirror"
                )
                self.assertEqual(asset["name"], expected_name)
        with self.assertRaisesRegex(RuntimeError, "no BBDown"):
            CacheManager._py_default_tool_fallback_asset(
                "bbdown", "freebsd", "x64", "https://mirror"
            )
        with self.assertRaisesRegex(RuntimeError, "no aria2c"):
            CacheManager._py_default_tool_fallback_asset(
                "aria2c", "linux", "x64", "https://mirror"
            )

    def test_public_wrapper_falls_back_completely(self):
        asset = {"name": "tool", "browser_download_url": "primary"}
        with patch.object(
            rust_backend, "try_plan_tool_download_candidates", return_value=(False, None)
        ), patch.object(
            CacheManager,
            "_py_tool_download_candidates",
            wraps=CacheManager._py_tool_download_candidates,
        ) as fallback:
            self.assertEqual(
                CacheManager._plan_tool_download_candidates(
                    "bbdown", asset, "unused", ["mirror"]
                ),
                ["primary", "mirror/tool"],
            )
            fallback.assert_called_once()

    def test_real_native_equivalence_for_generated_candidates_and_targets(self):
        available = rust_backend.backend_status()["capabilities"].get(
            "plan_tool_download_candidates", False
        )
        if not available:
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail("strict native suite requires tool candidate planning")
            self.skipTest("tool candidate planning capability unavailable")
        for primary, name, bases in itertools.product(
            ["", "primary", " primary "],
            ["tool", "歌曲", "already%20encoded"],
            [[], [""], ["mirror"], ["mirror", "mirror"]],
        ):
            asset = {"name": name, "browser_download_url": primary}
            self.assertEqual(
                CacheManager._plan_tool_download_candidates(
                    "ytdlp", asset, "unused", bases
                ),
                CacheManager._py_tool_download_candidates(asset, "unused", bases),
            )
        with patch("bilikara.cache.TOOL_ASSET_BASE_URL", "https://mirror"):
            self.assertEqual(
                CacheManager._fallback_tool_asset("tool name"),
                CacheManager._py_fallback_tool_asset(
                    "tool name", "https://mirror"
                ),
            )
            for tool, platform_name, arch in [
                ("bbdown", "linux", "x64"),
                ("ytdlp", "windows", "arm64"),
                ("aria2c", "windows", "x86"),
            ]:
                self.assertEqual(
                    CacheManager._default_tool_fallback_asset(tool, platform_name, arch),
                    CacheManager._py_default_tool_fallback_asset(
                        tool, platform_name, arch, "https://mirror"
                    ),
                )
