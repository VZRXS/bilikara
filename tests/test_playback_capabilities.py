import queue
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.bilibili import AudioBindingDecision, VideoPage, decide_audio_binding
from bilikara.cache import CacheManager


PRODUCTION_CAPABILITIES = (
    "decide_audio_binding",
    "decide_quality_policy",
    "select_video_stream",
    "select_audio_stream",
    "select_preferred_audio_source",
    "plan_media_download_candidates",
)


class PlaybackCapabilityProductionTest(unittest.TestCase):
    @classmethod
    def capability_cases(cls):
        pages = [VideoPage(page=1, cid=2, duration=60, part="single")]
        video_streams = [
            {"quality_id": 80, "bandwidth": 1_000, "codec_name": "avc"}
        ]
        audio_streams = [{"quality_id": 30280, "bandwidth": 1_000}]
        regular_audio = [{"quality_id": 30280, "url": "regular"}]
        dash_streams = {
            "video": [
                {
                    "url": "https://media.test/video.m4s",
                    "backup_urls": ["https://media.test/video-backup.m4s"],
                }
            ]
        }
        quality_request = {
            "schema_version": 1,
            "raw_quality": "720P 高清",
            "raw_cap": "",
            "choice_index": None,
        }
        quality_response = rust_backend._expected_quality_policy(quality_request)
        video_response = rust_backend._expected_video_stream_selection(
            {
                "schema_version": 1,
                "max_quality_id": 80,
                "codec_filter": None,
                "max_avc_quality_id": None,
                "streams": [
                    {
                        "original_index": 0,
                        "quality_id": 80,
                        "bandwidth": 1_000,
                        "codec": "avc",
                    }
                ],
            }
        )
        audio_response = rust_backend._expected_audio_stream_selection(
            {
                "schema_version": 1,
                "audio_hires": True,
                "regular_streams": [
                    {
                        "original_index": 0,
                        "quality_id": 30280,
                        "bandwidth": 1_000,
                    }
                ],
            }
        )
        preferred_response = rust_backend._expected_preferred_audio_source_selection(
            {
                "schema_version": 1,
                "audio_hires": True,
                "regular_candidates": [{"original_index": 0}],
                "flac_available": False,
                "dolby_available": False,
            }
        )
        candidate_response = {
            "schema_version": 1,
            "status": "planned",
            "candidates": [
                {
                    "stream_index": 0,
                    "source": "primary",
                    "backup_index": None,
                    "url": "https://media.test/video.m4s",
                },
                {
                    "stream_index": 0,
                    "source": "backup",
                    "backup_index": 0,
                    "url": "https://media.test/video-backup.m4s",
                },
            ],
        }
        return (
            {
                "capability": "decide_audio_binding",
                "native_patch": "bilikara.bilibili.rust_backend.try_decide_audio_binding",
                "native_response": {
                    "schema_version": 1,
                    "status": "decided",
                    "mode": "single",
                    "selected_indices": [0],
                    "automatic_video_index": None,
                },
                "invalid_response": {
                    "schema_version": 1,
                    "status": "decided",
                    "mode": "single",
                    "selected_indices": [],
                    "automatic_video_index": None,
                },
                "python_patch": "bilikara.bilibili._py_decide_audio_binding",
                "invoke": lambda: decide_audio_binding(pages),
                "expected": AudioBindingDecision("single", (0,), None),
            },
            {
                "capability": "decide_quality_policy",
                "native_patch": "bilikara.cache.rust_backend.try_decide_quality_policy",
                "native_response": quality_response,
                "invalid_response": {
                    **quality_response,
                    "normalized_quality": "invented",
                },
                "python_patch": "bilikara.cache.CacheManager._py_optional_video_quality",
                "invoke": lambda: CacheManager._optional_video_quality("720P 高清"),
                "expected": "720P 高清",
            },
            {
                "capability": "select_video_stream",
                "native_patch": "bilikara.cache.rust_backend.try_select_video_stream",
                "native_response": video_response,
                "invalid_response": {**video_response, "selected_index": 99},
                "python_patch": "bilikara.cache.CacheManager._py_select_dash_video_stream",
                "invoke": lambda: CacheManager._select_dash_video_stream(
                    video_streams, max_quality_id=80
                ),
                "expected": video_streams[0],
            },
            {
                "capability": "select_audio_stream",
                "native_patch": "bilikara.cache.rust_backend.try_select_audio_stream",
                "native_response": audio_response,
                "invalid_response": {**audio_response, "selected_index": 99},
                "python_patch": "bilikara.cache.CacheManager._py_select_dash_audio_stream",
                "invoke": lambda: CacheManager._select_dash_audio_stream(
                    audio_streams, audio_hires=True
                ),
                "expected": audio_streams[0],
            },
            {
                "capability": "select_preferred_audio_source",
                "native_patch": (
                    "bilikara.cache.rust_backend.try_select_preferred_audio_source"
                ),
                "native_response": preferred_response,
                "invalid_response": {
                    **preferred_response,
                    "selected_regular_index": 99,
                },
                "python_patch": (
                    "bilikara.cache.CacheManager._py_select_preferred_dash_audio"
                ),
                "invoke": lambda: CacheManager._select_preferred_dash_audio(
                    regular_audio, None, None, audio_hires=True
                ),
                "expected": regular_audio[0],
            },
            {
                "capability": "plan_media_download_candidates",
                "native_patch": (
                    "bilikara.cache.rust_backend.try_plan_media_download_candidates"
                ),
                "native_response": candidate_response,
                "invalid_response": {
                    **candidate_response,
                    "candidates": [
                        {
                            **candidate_response["candidates"][0],
                            "url": "https://media.test/invented.m4s",
                        },
                        candidate_response["candidates"][1],
                    ],
                },
                "python_patch": "bilikara.cache.CacheManager._py_dash_stream_urls",
                "invoke": lambda: CacheManager._dash_stream_urls(
                    dash_streams, "video"
                ),
                "expected": [
                    "https://media.test/video.m4s",
                    "https://media.test/video-backup.m4s",
                ],
            },
        )

    def test_table_covers_exactly_the_six_production_capabilities(self):
        self.assertEqual(
            tuple(case["capability"] for case in self.capability_cases()),
            PRODUCTION_CAPABILITIES,
        )

    def test_every_production_call_is_strict_rust_and_never_uses_python(self):
        for case in self.capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("frozen Python reference was invoked"),
            ), patch(
                "bilikara.rust_backend.python_fallback",
                side_effect=AssertionError("Python fallback was invoked"),
            ), patch(
                case["native_patch"], return_value=(True, case["native_response"])
            ) as native_call:
                self.assertEqual(case["invoke"](), case["expected"])

            native_call.assert_called_once()
            self.assertEqual(
                native_call.call_args.kwargs,
                {"allow_python_reference": False},
            )

    def test_unavailable_capability_fails_explicitly_without_fallback(self):
        for case in self.capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("frozen Python reference was invoked"),
            ), patch(
                "bilikara.rust_backend.python_fallback",
                side_effect=AssertionError("Python fallback was invoked"),
            ), patch.dict(
                rust_backend._CAPABILITIES, {case["capability"]: False}
            ), self.assertRaises(rust_backend.PlaybackCapabilityError) as raised:
                case["invoke"]()

            self.assertEqual(raised.exception.capability, case["capability"])

    def test_malformed_native_json_fails_explicitly_without_fallback(self):
        for case in self.capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("frozen Python reference was invoked"),
            ), patch(
                "bilikara.rust_backend.python_fallback",
                side_effect=AssertionError("Python fallback was invoked"),
            ), patch(
                "bilikara.rust_backend._call_json_capability", return_value=None
            ), self.assertRaises(rust_backend.PlaybackCapabilityError) as raised:
                case["invoke"]()

            self.assertEqual(raised.exception.capability, case["capability"])

    def test_invalid_or_contradictory_native_result_fails_explicitly(self):
        for case in self.capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("frozen Python reference was invoked"),
            ), patch(
                "bilikara.rust_backend._call_json_capability",
                return_value=case["invalid_response"],
            ), self.assertRaises(rust_backend.PlaybackCapabilityError) as raised:
                case["invoke"]()

            self.assertEqual(raised.exception.capability, case["capability"])

    def test_strict_equivalence_mode_cannot_replace_production_output(self):
        for case in self.capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                "bilikara.rust_backend.strict_equivalence_enabled",
                return_value=True,
            ), patch(
                "bilikara.rust_backend._strict_equivalence_result",
                side_effect=AssertionError("reference substitution was attempted"),
            ) as equivalence, patch(
                "bilikara.rust_backend._call_json_capability",
                return_value=case["native_response"],
            ):
                self.assertEqual(case["invoke"](), case["expected"])

            equivalence.assert_not_called()

            with self.subTest(
                capability=case["capability"], result="invalid"
            ), patch(
                "bilikara.rust_backend.strict_equivalence_enabled",
                return_value=True,
            ), patch(
                "bilikara.rust_backend._strict_equivalence_result",
                side_effect=AssertionError("reference substitution was attempted"),
            ) as equivalence, patch(
                "bilikara.rust_backend._call_json_capability",
                return_value=case["invalid_response"],
            ), self.assertRaises(rust_backend.PlaybackCapabilityError):
                case["invoke"]()

            equivalence.assert_not_called()

    def test_invalid_candidate_inputs_fail_before_native_or_python_dispatch(self):
        invalid_cases = (
            lambda: CacheManager._dash_stream_urls({}, "invalid"),
            lambda: CacheManager._preferred_audio_urls(
                {"url": 123, "backup_urls": ["backup"]}
            ),
            lambda: CacheManager._preferred_audio_urls(
                {"url": "primary", "backup_urls": [456]}
            ),
        )
        for invoke in invalid_cases:
            with patch(
                "bilikara.cache.rust_backend.try_plan_media_download_candidates"
            ) as native_call, patch(
                "bilikara.cache.rust_backend.python_fallback"
            ) as python_fallback, self.assertRaises(
                rust_backend.PlaybackCapabilityError
            ) as raised:
                invoke()

            self.assertEqual(
                raised.exception.capability, "plan_media_download_candidates"
            )
            native_call.assert_not_called()
            python_fallback.assert_not_called()


class PlaybackCapabilityWorkerTest(unittest.TestCase):
    def test_cache_worker_survives_one_capability_failure(self):
        manager = CacheManager.__new__(CacheManager)
        manager.stop_event = threading.Event()
        manager.tasks = queue.Queue()
        manager.lock = threading.RLock()
        manager.active_item_id = None
        manager.active_processes = set()
        manager.active_process_item_ids = {}
        manager.active_process = None
        manager.requeued_active_ids = set()
        manager.pending_ids = {"bad", "good"}
        manager.python_worker_download_sources = {
            "bad": "bbdown",
            "good": "bbdown",
        }
        manager.python_cache_attempt_tokens = {"bad": 1, "good": 2}
        manager.store = SimpleNamespace()
        manager.sync_with_playlist = lambda: None
        manager._current_download_source = lambda: "bbdown"
        manager._item_log_path = lambda *args: Path("worker.log")
        manager._append_log_line = lambda *args: None
        manager._project_cache_event = lambda *args, **kwargs: None
        processed = []
        good_processed = threading.Event()

        def cache_item(item_id, cache_attempt_token):
            if item_id == "bad":
                self.assertEqual(cache_attempt_token, 1)
                raise rust_backend.PlaybackCapabilityError("select_video_stream")
            self.assertEqual(cache_attempt_token, 2)
            processed.append(item_id)
            good_processed.set()
            manager.stop_event.set()
            return False

        manager._cache_item = cache_item
        manager.tasks.put("bad")
        manager.tasks.put("good")
        worker = threading.Thread(target=manager._worker_loop)
        worker.start()
        self.assertTrue(good_processed.wait(2))
        worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertEqual(processed, ["good"])


if __name__ == "__main__":
    unittest.main()
