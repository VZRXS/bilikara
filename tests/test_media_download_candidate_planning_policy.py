import itertools
import os
import unittest
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.cache import CacheManager


class MediaDownloadCandidatePlanningPolicyTest(unittest.TestCase):
    def test_python_dash_reference_trims_drops_empty_and_preserves_duplicates(self):
        streams = {
            "video": [
                {
                    "url": " primary ",
                    "backup_urls": [" backup ", "primary", "", "backup"],
                },
                {"url": " ", "backup_urls": ["歌曲", "%E6%AD%8C"]},
            ]
        }
        self.assertEqual(
            CacheManager._py_dash_stream_urls(streams, "video"),
            ["primary", "backup", "primary", "backup", "歌曲", "%E6%AD%8C"],
        )
        self.assertEqual(CacheManager._py_dash_stream_urls({}, "unknown"), [])

    def test_python_preferred_audio_reference_preserves_raw_string_identity(self):
        preferred = {"url": " primary ", "backup_urls": ["", " primary ", "歌曲"]}
        self.assertEqual(
            CacheManager._py_preferred_audio_urls(preferred),
            [" primary ", "", " primary ", "歌曲"],
        )

    def test_public_wrappers_fall_back_completely(self):
        dash = {"audio": [{"url": " a ", "backup_urls": ["", "a"]}]}
        preferred = {"url": " a ", "backup_urls": ["", "a"]}
        with patch.object(
            rust_backend,
            "try_plan_media_download_candidates",
            return_value=(False, None),
        ), patch.object(
            CacheManager,
            "_py_dash_stream_urls",
            wraps=CacheManager._py_dash_stream_urls,
        ) as dash_fallback, patch.object(
            CacheManager,
            "_py_preferred_audio_urls",
            wraps=CacheManager._py_preferred_audio_urls,
        ) as preferred_fallback:
            self.assertEqual(CacheManager._dash_stream_urls(dash, "audio"), ["a", "a"])
            self.assertEqual(
                CacheManager._preferred_audio_urls(preferred), [" a ", "", "a"]
            )
            dash_fallback.assert_called_once()
            preferred_fallback.assert_called_once()

    def test_real_native_equivalence_across_generated_fixtures(self):
        available = rust_backend.backend_status()["capabilities"].get(
            "plan_media_download_candidates", False
        )
        if not available:
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail("strict native suite requires media candidate planning")
            self.skipTest("media candidate planning capability unavailable")

        values = ["", " ", "https://a", " https://a ", "歌曲", "%E6%AD%8C"]
        for primary, backup in itertools.product(values, repeat=2):
            dash = {"video": [{"url": primary, "backup_urls": [backup, primary]}]}
            self.assertEqual(
                CacheManager._dash_stream_urls(dash, "video"),
                CacheManager._py_dash_stream_urls(dash, "video"),
            )
        preferred = {"url": " raw ", "backup_urls": ["", " raw ", "歌曲"]}
        self.assertEqual(
            CacheManager._preferred_audio_urls(preferred),
            CacheManager._py_preferred_audio_urls(preferred),
        )
