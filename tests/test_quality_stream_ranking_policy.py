import itertools
import os
import unittest
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.cache import CacheManager, VIDEO_QUALITY_CHOICES


class QualityPolicyReferenceTest(unittest.TestCase):
    def test_python_quality_reference_covers_labels_indices_caps_and_boundaries(self):
        for index, quality in enumerate(VIDEO_QUALITY_CHOICES):
            with self.subTest(index=index, quality=quality):
                self.assertEqual(CacheManager._py_quality_from_choice_index(index), quality)
                self.assertEqual(CacheManager._py_quality_from_choice_index(str(index)), quality)
                self.assertEqual(CacheManager._py_optional_video_quality(f" {quality} "), quality)
                self.assertEqual(CacheManager._py_normalize_video_quality(f" {quality} "), quality)

        self.assertEqual(CacheManager._py_quality_from_choice_index(True), VIDEO_QUALITY_CHOICES[1])
        self.assertEqual(CacheManager._py_quality_from_choice_index(2.9), VIDEO_QUALITY_CHOICES[2])
        self.assertIsNone(CacheManager._py_quality_from_choice_index("invalid"))
        self.assertIsNone(CacheManager._py_optional_video_quality("4K 超清"))
        self.assertEqual(CacheManager._py_normalize_video_quality("invalid"), VIDEO_QUALITY_CHOICES[0])

        dash_ids = {
            "360P 流畅": 16,
            "480P 清晰": 32,
            "720P 高清": 64,
            "720P 60帧": 74,
            "1080P 高清": 80,
            "1080P 高码率": 112,
            "1080P 高帧率": 116,
            "4K 超清": 120,
            "HDR 真彩": 125,
            "杜比视界": 126,
            "8K 超高清": 127,
        }
        for label, quality_id in dash_ids.items():
            self.assertEqual(CacheManager._py_dash_max_quality_id(label), quality_id)
        self.assertEqual(CacheManager._py_dash_max_quality_id(" 4K 超清 "), 80)

        heights = [1080, 1080, 720, 480, 360]
        for quality, height in zip(VIDEO_QUALITY_CHOICES, heights):
            self.assertEqual(CacheManager._py_ytdlp_max_height(quality), height)
        self.assertEqual(
            CacheManager._py_ytdlp_max_height("1080P 高帧率", "720P 高清"),
            720,
        )
        self.assertEqual(
            CacheManager._py_video_quality_priority("480P 清晰", "720P 高清"),
            "480P 清晰,360P 流畅",
        )

    def test_public_quality_wrappers_fall_back_to_independent_python(self):
        with patch.object(
            rust_backend, "try_decide_quality_policy", return_value=(False, None)
        ), patch.object(
            CacheManager,
            "_py_normalize_video_quality",
            wraps=CacheManager._py_normalize_video_quality,
        ) as fallback:
            self.assertEqual(CacheManager._normalize_video_quality(" 720P 高清 "), "720P 高清")
            fallback.assert_called_once()


class StreamRankingReferenceTest(unittest.TestCase):
    def test_python_video_reference_preserves_three_stage_ranking(self):
        streams = [
            {"quality_id": 80, "bandwidth": 100, "codec_name": "hevc"},
            {"quality_id": 64, "bandwidth": 200, "codec_name": "avc"},
            {"quality_id": 64, "bandwidth": 200, "codec_name": "avc"},
        ]
        self.assertIs(
            CacheManager._py_select_dash_video_stream(
                streams,
                max_quality_id=80,
                codec_filter="avc",
                avc_quality_cap="720P 高清",
            ),
            streams[1],
        )
        self.assertIs(
            CacheManager._py_select_dash_video_stream(
                streams, max_quality_id=80, codec_filter="av1"
            ),
            streams[0],
        )
        self.assertEqual(
            CacheManager._py_select_dash_video_stream(
                [{"quality_id": 116, "bandwidth": 1, "codec_name": "avc"}],
                max_quality_id=64,
            )["codec_name"],
            "avc",
        )
        self.assertIsNone(
            CacheManager._py_select_dash_video_stream([], max_quality_id=80)
        )

    def test_python_audio_reference_preserves_quality_and_ignores_bandwidth(self):
        streams = [
            {"quality_id": 30280, "bandwidth": 0},
            {"quality_id": 30280, "bandwidth": 999999},
            {"quality_id": 30232, "bandwidth": 999999},
        ]
        self.assertIs(
            CacheManager._py_select_dash_audio_stream(streams, audio_hires=True),
            streams[0],
        )
        high_only = [
            {"quality_id": 30251, "bandwidth": 2},
            {"quality_id": 30250, "bandwidth": 1},
        ]
        self.assertIs(
            CacheManager._py_select_dash_audio_stream(high_only, audio_hires=False),
            high_only[1],
        )

    def test_python_preferred_audio_reference_is_dolby_flac_regular(self):
        regular = {"quality_id": 30280}
        flac = {"quality_id": 30251}
        dolby = {"quality_id": 30250}
        self.assertIs(
            CacheManager._py_select_preferred_dash_audio(
                [regular], flac, dolby, audio_hires=True
            ),
            dolby,
        )
        self.assertIs(
            CacheManager._py_select_preferred_dash_audio(
                [regular], flac, None, audio_hires=True
            ),
            flac,
        )
        self.assertIs(
            CacheManager._py_select_preferred_dash_audio(
                [regular], flac, dolby, audio_hires=False
            ),
            regular,
        )

    def test_public_stream_wrappers_fall_back_completely(self):
        video = [{"quality_id": 80, "bandwidth": 1, "codec_name": "avc"}]
        audio = [{"quality_id": 30280, "bandwidth": 1}]
        with patch.object(
            rust_backend, "try_select_video_stream", return_value=(False, None)
        ), patch.object(
            rust_backend, "try_select_audio_stream", return_value=(False, None)
        ), patch.object(
            CacheManager,
            "_py_select_dash_video_stream",
            wraps=CacheManager._py_select_dash_video_stream,
        ) as video_fallback, patch.object(
            CacheManager,
            "_py_select_dash_audio_stream",
            wraps=CacheManager._py_select_dash_audio_stream,
        ) as audio_fallback:
            self.assertIs(
                CacheManager._select_dash_video_stream(video, max_quality_id=80),
                video[0],
            )
            self.assertIs(
                CacheManager._select_dash_audio_stream(audio, audio_hires=True),
                audio[0],
            )
            video_fallback.assert_called_once()
            audio_fallback.assert_called_once()


class NativeQualityStreamEquivalenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        status = rust_backend.backend_status()
        capabilities = status["capabilities"]
        required = {
            "decide_quality_policy",
            "select_video_stream",
            "select_audio_stream",
        }
        if not status["loaded"] or not all(capabilities.get(name) for name in required):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                raise AssertionError("strict-native quality/stream capabilities are unavailable")
            raise unittest.SkipTest("quality/stream native capabilities are unavailable")

    def test_quality_native_matches_reference_generated_inputs(self):
        values = ["", "invalid", " 720P 高清 ", "4K 超清", "歌曲"]
        caps = ["", "720P 高清", " 480P 清晰 ", "invalid"]
        for value, cap in itertools.product(values, caps):
            self.assertEqual(
                CacheManager._normalize_video_quality(value),
                CacheManager._py_normalize_video_quality(value),
            )
            self.assertEqual(
                CacheManager._optional_video_quality(value),
                CacheManager._py_optional_video_quality(value),
            )
            self.assertEqual(
                CacheManager._dash_max_quality_id(value),
                CacheManager._py_dash_max_quality_id(value),
            )
            self.assertEqual(
                CacheManager._ytdlp_max_height(value, cap),
                CacheManager._py_ytdlp_max_height(value, cap),
            )
            self.assertEqual(
                CacheManager._video_quality_priority(value, cap),
                CacheManager._py_video_quality_priority(value, cap),
            )

    def test_video_native_matches_reference_across_permutations(self):
        base = [
            {"quality_id": 116, "bandwidth": 0, "codec_name": "hevc"},
            {"quality_id": 80, "bandwidth": 100, "codec_name": "avc"},
            {"quality_id": 64, "bandwidth": 100, "codec_name": "av1"},
        ]
        for streams in itertools.permutations(base):
            streams = list(streams)
            for max_id, codec, cap in itertools.product(
                (64, 80, 116), (None, "", "avc", "hevc", "unknown"), ("", "720P 高清")
            ):
                native = CacheManager._select_dash_video_stream(
                    streams,
                    max_quality_id=max_id,
                    codec_filter=codec,
                    avc_quality_cap=cap,
                )
                reference = CacheManager._py_select_dash_video_stream(
                    streams,
                    max_quality_id=max_id,
                    codec_filter=codec,
                    avc_quality_cap=cap,
                )
                self.assertIs(native, reference)

    def test_audio_native_matches_reference_for_hires_and_ties(self):
        base = [
            {"quality_id": 30250, "bandwidth": 1},
            {"quality_id": 30251, "bandwidth": 999},
            {"quality_id": 30280, "bandwidth": 0},
            {"quality_id": 30280, "bandwidth": 999999},
            {"quality_id": 0, "bandwidth": 1},
        ]
        for streams in ([], base, list(reversed(base)), base[2:]):
            for hires in (False, True):
                self.assertIs(
                    CacheManager._select_dash_audio_stream(streams, audio_hires=hires),
                    CacheManager._py_select_dash_audio_stream(streams, audio_hires=hires),
                )

        regular = {"quality_id": 30280, "bandwidth": 0}
        flac = {"quality_id": 30251, "bandwidth": 1}
        dolby = {"quality_id": 30250, "bandwidth": 1}
        for hires, flac_value, dolby_value in itertools.product(
            (False, True), (None, flac), (None, dolby)
        ):
            self.assertIs(
                CacheManager._select_preferred_dash_audio(
                    [regular], flac_value, dolby_value, audio_hires=hires
                ),
                CacheManager._py_select_preferred_dash_audio(
                    [regular], flac_value, dolby_value, audio_hires=hires
                ),
            )


if __name__ == "__main__":
    unittest.main()
