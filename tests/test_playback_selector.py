import io
import json
import queue
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import bilikara.server as server_module
from bilikara import rust_backend
from bilikara.bilibili import (
    AudioBindingDecision,
    VideoPage,
    decide_audio_binding,
)
from bilikara.cache import CacheManager
from bilikara.models import PlaylistItem
from bilikara.playback_selector import (
    PLAYBACK_RUST_CAPABILITIES,
    PlaybackCapabilityError,
    PlaybackSelector,
)
from bilikara.server import AppContext, BilikaraHandler
from bilikara.store import PlaylistStore, _py_apply_av_delay_action


def rust_status(*, available: bool) -> dict[str, object]:
    from bilikara.playback_selector import PLAYBACK_RUST_CAPABILITIES

    return {
        "loaded": available,
        "error": "missing native library" if not available else None,
        "capabilities": {
            capability: available for capability in PLAYBACK_RUST_CAPABILITIES
        },
    }


class PlaybackSelectorStoreTest(unittest.TestCase):
    def make_store(self, root: Path, on_change=None) -> PlaylistStore:
        return PlaylistStore(
            root / "state.json",
            root / "backup.json",
            root / "played",
            on_change=on_change,
        )

    def test_rust_is_fresh_default_and_explicit_python_persists_round_trip(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=True),
            ):
                store = self.make_store(root)
                self.assertEqual(store.snapshot()["playback_selector"]["mode"], "rust")

                store.set_playback_selector_mode("python")
                restored = self.make_store(root)

            self.assertEqual(restored.playback_selector_mode, "python")
            payload = json.loads((root / "player_state.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["playback_selector_mode"], "python")

    def test_explicit_persisted_rust_when_available_retains_rust(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "player_state.json").write_text(
                json.dumps({"playback_selector_mode": "rust"}),
                encoding="utf-8",
            )
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=True),
            ):
                store = self.make_store(root)
                selector = store.snapshot()["playback_selector"]

            self.assertEqual(selector["mode"], "rust")
            self.assertEqual(selector["warning"], "")
            persisted = json.loads(
                (root / "player_state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["playback_selector_mode"], "rust")

    def test_invalid_persisted_value_uses_rust_default_when_available(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "player_state.json").write_text(
                json.dumps({"playback_selector_mode": "hybrid"}),
                encoding="utf-8",
            )
            stderr = io.StringIO()
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=True),
            ), patch("sys.stderr", stderr):
                store = self.make_store(root)

            selector = store.snapshot()["playback_selector"]
            self.assertEqual(selector["mode"], "rust")
            self.assertIn("invalid persisted", selector["warning"])
            self.assertIn("using rust", stderr.getvalue())
            self.assertNotIn("using python", selector["warning"])
            persisted = json.loads(
                (root / "player_state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["playback_selector_mode"], "rust")

    def test_invalid_persisted_value_uses_python_when_rust_unavailable(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "player_state.json").write_text(
                json.dumps({"playback_selector_mode": "unknown"}),
                encoding="utf-8",
            )
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=False),
            ):
                store = self.make_store(root)

            selector = store.snapshot()["playback_selector"]
            self.assertEqual(selector["mode"], "python")
            self.assertIn("invalid persisted", selector["warning"])
            self.assertIn("using python", selector["warning"])
            self.assertNotIn("using rust", selector["warning"])
            persisted = json.loads(
                (root / "player_state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["playback_selector_mode"], "python")

    def test_unavailable_persisted_rust_normalizes_to_python_with_warning(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            (root / "player_state.json").write_text(
                json.dumps({"playback_selector_mode": "rust"}),
                encoding="utf-8",
            )
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=False),
            ):
                store = self.make_store(root)
                selector = store.snapshot()["playback_selector"]

            self.assertEqual(selector["mode"], "python")
            self.assertIn("unavailable", selector["warning"])
            persisted = json.loads(
                (root / "player_state.json").read_text(encoding="utf-8")
            )
            self.assertEqual(persisted["playback_selector_mode"], "python")

    def test_selector_mutation_increments_revision_without_resetting_player_or_cache(self):
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            context = AppContext.__new__(AppContext)
            context._state_change_condition = threading.Condition()
            context._state_revision = 0
            store = self.make_store(root, on_change=context._notify_state_changed)
            context.store = store
            item = PlaylistItem(
                id="song",
                original_url="https://example.test/song",
                resolved_url="https://example.test/song",
                title="Song",
                display_title="Song",
                aid=1,
                bvid="BV1xx411c7mD",
                cid=2,
                page=1,
                part_title="P1",
                cover_url="",
                embed_url="",
                video_relative_path="song/video.mp4",
                video_media_url="/media/song/video.mp4",
                audio_variants=[{"id": "a", "audio_url": "/media/song/audio.m4a"}],
                cache_status="ready",
            )
            store.current_item = item
            cache_file = root / "cache" / "song" / "video.mp4"
            cache_file.parent.mkdir(parents=True)
            cache_file.write_bytes(b"cached")
            before = store.snapshot()["current_item"]

            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=True),
            ):
                context.set_playback_selector_mode("python")

            after = store.snapshot()["current_item"]
            self.assertEqual(after, before)
            self.assertEqual(cache_file.read_bytes(), b"cached")
            self.assertEqual(context._state_revision, 1)

    def test_read_only_snapshot_is_backend_free_and_exactly_equivalent(self):
        states = (
            (0, 0, False),
            (5000, 0, True),
            (-5000, 0, True),
            (125, -25, True),
            (0, 125, False),
            (0, -125, False),
            (4999, 1, True),
            (-4999, -1, True),
        )
        with TemporaryDirectory() as tmpdir:
            store = self.make_store(Path(tmpdir))
            store.playback_selector_mode = "rust"
            with patch(
                "bilikara.playback_selector.rust_backend.backend_status",
                return_value=rust_status(available=True),
            ), patch(
                "bilikara.store.rust_backend.try_apply_av_delay_action",
                side_effect=AssertionError(
                    "read-only snapshot must not invoke a playback backend"
                ),
            ):
                for global_delay, local_delay, locked in states:
                    with self.subTest(
                        global_delay=global_delay,
                        local_delay=local_delay,
                        locked=locked,
                    ):
                        store.av_global_delay_ms = global_delay
                        store.av_local_delay_ms = local_delay
                        store.av_delay_locked = locked
                        expected = _py_apply_av_delay_action(
                            {
                                "global_delay_ms": global_delay,
                                "local_delay_ms": local_delay,
                                "locked": locked,
                            },
                            {"type": "snapshot"},
                        )
                        actual = store.snapshot()["player_settings"]["av_delay"]
                        self.assertEqual(actual, expected)

    def test_av_delay_availability_check_runs_outside_store_lock(self):
        with TemporaryDirectory() as tmpdir:
            store = self.make_store(Path(tmpdir))
            store.playback_selector_mode = "rust"
            native_result = _py_apply_av_delay_action(
                {
                    "global_delay_ms": 0,
                    "local_delay_ms": 0,
                    "locked": False,
                },
                {"type": "adjust", "delta_ms": 125},
            )

            def assert_outside_store_lock():
                self.assertFalse(store.lock._is_owned())
                return True, ""

            with patch(
                "bilikara.playback_selector.rust_playback_availability",
                side_effect=assert_outside_store_lock,
            ), patch(
                "bilikara.store.rust_backend.try_apply_av_delay_action",
                return_value=(True, native_result),
            ):
                result = store.apply_av_delay_action(
                    {"type": "adjust", "delta_ms": 125}
                )

            self.assertEqual(result, native_result)


class PlaybackSelectorDispatchTest(unittest.TestCase):
    def test_dormant_media_page_selector_is_not_required_for_playback_mode(self):
        self.assertNotIn("select_media_pages", PLAYBACK_RUST_CAPABILITIES)

    def test_python_path_never_invokes_playback_rust(self):
        pages = [VideoPage(page=1, cid=2, duration=60, part="single")]
        with patch(
            "bilikara.bilibili.rust_backend.try_decide_audio_binding",
            side_effect=AssertionError("Rust playback must not be invoked"),
        ):
            result = decide_audio_binding(
                pages, playback_selector=PlaybackSelector("python")
            )
        self.assertEqual(result, AudioBindingDecision("single", (0,), None))

    def test_rust_path_never_invokes_python_playback_fallback(self):
        pages = [VideoPage(page=1, cid=2, duration=60, part="single")]
        native = {
            "schema_version": 1,
            "status": "decided",
            "mode": "single",
            "selected_indices": [0],
            "automatic_video_index": None,
        }
        with patch(
            "bilikara.bilibili._py_decide_audio_binding",
            side_effect=AssertionError("Python playback must not be invoked"),
        ), patch(
            "bilikara.bilibili.rust_backend.try_decide_audio_binding",
            return_value=(True, native),
        ) as native_call:
            result = decide_audio_binding(
                pages, playback_selector=PlaybackSelector("rust")
            )
        self.assertEqual(result, AudioBindingDecision("single", (0,), None))
        self.assertEqual(native_call.call_args.kwargs, {"allow_python_reference": False})

    def test_rust_failure_is_explicit(self):
        pages = [VideoPage(page=1, cid=2, duration=60, part="single")]
        with patch(
            "bilikara.bilibili.rust_backend.try_decide_audio_binding",
            return_value=(False, None),
        ), self.assertRaisesRegex(
            PlaybackCapabilityError, "decide_audio_binding"
        ):
            decide_audio_binding(
                pages, playback_selector=PlaybackSelector("rust")
            )

    def test_operation_keeps_captured_mode_and_next_operation_observes_switch(self):
        with TemporaryDirectory() as tmpdir, patch(
            "bilikara.playback_selector.rust_backend.backend_status",
            return_value=rust_status(available=True),
        ):
            root = Path(tmpdir)
            store = PlaylistStore(
                root / "state.json", root / "backup.json", root / "played"
            )
            entered = threading.Event()
            release = threading.Event()
            finished = threading.Event()
            observed = []

            def operation() -> None:
                selector = store.capture_playback_selector()
                observed.append(selector.mode)
                entered.set()
                self.assertTrue(release.wait(2))
                observed.append(selector.mode)
                finished.set()

            thread = threading.Thread(target=operation)
            thread.start()
            self.assertTrue(entered.wait(2))
            store.set_playback_selector_mode("python")
            next_selector = store.capture_playback_selector()
            release.set()
            self.assertTrue(finished.wait(2))
            thread.join()

            self.assertEqual(observed, ["rust", "rust"])
            self.assertEqual(next_selector.mode, "python")

    def test_non_playback_rust_dispatch_remains_unchanged(self):
        with TemporaryDirectory() as tmpdir:
            store = PlaylistStore(
                Path(tmpdir) / "state.json",
                Path(tmpdir) / "backup.json",
                Path(tmpdir) / "played",
            )
            response = {
                "schema_version": 1,
                "status": "planned",
                "ordered_ids": [],
            }
            with patch(
                "bilikara.store.rust_backend.try_plan_playlist_order",
                return_value=(True, response),
            ) as native_call:
                store._plan_playlist_order_unlocked("rebuild")
            native_call.assert_called_once()


class PlaybackSelectorAllCapabilityStrictRoutingTest(unittest.TestCase):
    @staticmethod
    def _apply_av_delay(selector: PlaybackSelector) -> dict[str, object]:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            store = PlaylistStore(
                root / "state.json", root / "backup.json", root / "played"
            )
            with patch.object(
                store, "capture_playback_selector", return_value=selector
            ):
                return store.apply_av_delay_action(
                    {"type": "adjust", "delta_ms": 125}
                )

    @classmethod
    def _capability_cases(cls):
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
        av_delay_response = _py_apply_av_delay_action(
            {"global_delay_ms": 0, "local_delay_ms": 0, "locked": False},
            {"type": "adjust", "delta_ms": 125},
        )
        return (
            {
                "capability": "decide_audio_binding",
                "native_patch": "bilikara.bilibili.rust_backend.try_decide_audio_binding",
                "native": rust_backend.try_decide_audio_binding,
                "python_patch": "bilikara.bilibili._py_decide_audio_binding",
                "invoke": lambda selector: decide_audio_binding(
                    pages, playback_selector=selector
                ),
                "native_response": {
                    "schema_version": 1,
                    "status": "decided",
                    "mode": "single",
                    "selected_indices": [0],
                    "automatic_video_index": None,
                },
                "expected": AudioBindingDecision("single", (0,), None),
            },
            {
                "capability": "decide_quality_policy",
                "native_patch": "bilikara.cache.rust_backend.try_decide_quality_policy",
                "native": rust_backend.try_decide_quality_policy,
                "python_patch": "bilikara.cache.CacheManager._py_optional_video_quality",
                "invoke": lambda selector: CacheManager._optional_video_quality(
                    "720P 高清", playback_selector=selector
                ),
                "native_response": quality_response,
                "expected": "720P 高清",
            },
            {
                "capability": "select_video_stream",
                "native_patch": "bilikara.cache.rust_backend.try_select_video_stream",
                "native": rust_backend.try_select_video_stream,
                "python_patch": "bilikara.cache.CacheManager._py_select_dash_video_stream",
                "invoke": lambda selector: CacheManager._select_dash_video_stream(
                    video_streams,
                    max_quality_id=80,
                    playback_selector=selector,
                ),
                "native_response": video_response,
                "expected": video_streams[0],
            },
            {
                "capability": "select_audio_stream",
                "native_patch": "bilikara.cache.rust_backend.try_select_audio_stream",
                "native": rust_backend.try_select_audio_stream,
                "python_patch": "bilikara.cache.CacheManager._py_select_dash_audio_stream",
                "invoke": lambda selector: CacheManager._select_dash_audio_stream(
                    audio_streams,
                    audio_hires=True,
                    playback_selector=selector,
                ),
                "native_response": audio_response,
                "expected": audio_streams[0],
            },
            {
                "capability": "select_preferred_audio_source",
                "native_patch": "bilikara.cache.rust_backend.try_select_preferred_audio_source",
                "native": rust_backend.try_select_preferred_audio_source,
                "python_patch": "bilikara.cache.CacheManager._py_select_preferred_dash_audio",
                "invoke": lambda selector: CacheManager._select_preferred_dash_audio(
                    regular_audio,
                    None,
                    None,
                    audio_hires=True,
                    playback_selector=selector,
                ),
                "native_response": preferred_response,
                "expected": regular_audio[0],
            },
            {
                "capability": "plan_media_download_candidates",
                "native_patch": "bilikara.cache.rust_backend.try_plan_media_download_candidates",
                "native": rust_backend.try_plan_media_download_candidates,
                "python_patch": "bilikara.cache.CacheManager._py_dash_stream_urls",
                "invoke": lambda selector: CacheManager._dash_stream_urls(
                    dash_streams, "video", playback_selector=selector
                ),
                "native_response": candidate_response,
                "expected": [
                    "https://media.test/video.m4s",
                    "https://media.test/video-backup.m4s",
                ],
            },
            {
                "capability": "apply_av_delay_action",
                "native_patch": "bilikara.store.rust_backend.try_apply_av_delay_action",
                "native": rust_backend.try_apply_av_delay_action,
                "python_patch": "bilikara.store._py_apply_av_delay_action",
                "invoke": cls._apply_av_delay,
                "native_response": av_delay_response,
                "expected": av_delay_response,
            },
        )

    def test_case_table_covers_every_reachable_playback_capability(self):
        tested = tuple(case["capability"] for case in self._capability_cases())
        self.assertEqual(tested, PLAYBACK_RUST_CAPABILITIES)
        self.assertNotIn("select_media_pages", tested)

    def test_python_selected_production_calls_never_invoke_rust(self):
        for case in self._capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["native_patch"],
                side_effect=AssertionError("Rust playback must not be invoked"),
            ) as native_call:
                result = case["invoke"](PlaybackSelector("python"))
                self.assertEqual(result, case["expected"])
                native_call.assert_not_called()

    def test_rust_selected_production_calls_are_strict_and_never_use_python(self):
        for case in self._capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("Python playback must not be invoked"),
            ), patch(
                case["native_patch"],
                return_value=(True, case["native_response"]),
            ) as native_call:
                result = case["invoke"](PlaybackSelector("rust"))
                self.assertEqual(result, case["expected"])
                native_call.assert_called_once()
                self.assertEqual(
                    native_call.call_args.kwargs,
                    {"allow_python_reference": False},
                )

    def test_rust_selected_unavailable_capabilities_raise_without_fallback(self):
        for case in self._capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("Python playback must not be invoked"),
            ), patch.dict(
                rust_backend._CAPABILITIES,
                {case["capability"]: False},
            ), patch(
                case["native_patch"], wraps=case["native"]
            ) as native_call, self.assertRaisesRegex(
                PlaybackCapabilityError, case["capability"]
            ):
                case["invoke"](PlaybackSelector("rust"))
            native_call.assert_called_once()
            self.assertEqual(
                native_call.call_args.kwargs,
                {"allow_python_reference": False},
            )

    def test_rust_selected_incomplete_results_raise_without_fallback(self):
        for case in self._capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("Python playback must not be invoked"),
            ), patch(
                case["native_patch"], return_value=(True, None)
            ) as native_call, self.assertRaisesRegex(
                PlaybackCapabilityError, case["capability"]
            ):
                case["invoke"](PlaybackSelector("rust"))
            native_call.assert_called_once()
            self.assertEqual(
                native_call.call_args.kwargs,
                {"allow_python_reference": False},
            )

    def test_rust_selected_malformed_native_responses_raise_without_fallback(self):
        malformed = {"schema_version": 1, "status": "malformed"}
        for case in self._capability_cases():
            with self.subTest(capability=case["capability"]), patch(
                case["python_patch"],
                side_effect=AssertionError("Python playback must not be invoked"),
            ), patch(
                "bilikara.rust_backend._call_json_capability",
                return_value=malformed,
            ), patch(
                case["native_patch"], wraps=case["native"]
            ) as native_call, self.assertRaisesRegex(
                PlaybackCapabilityError, case["capability"]
            ):
                case["invoke"](PlaybackSelector("rust"))
            native_call.assert_called_once()
            self.assertEqual(
                native_call.call_args.kwargs,
                {"allow_python_reference": False},
            )


class PlaybackSelectorInputValidationRoutingTest(unittest.TestCase):
    def test_rust_invalid_dash_kind_raises_without_python_or_rust_call(self):
        with patch(
            "bilikara.cache.rust_backend.python_fallback"
        ) as python_fallback, patch(
            "bilikara.cache.CacheManager._py_dash_stream_urls"
        ) as python_reference, patch(
            "bilikara.cache.rust_backend.try_plan_media_download_candidates"
        ) as rust_call, self.assertRaises(
            PlaybackCapabilityError
        ) as raised:
            CacheManager._dash_stream_urls(
                {},
                "invalid",
                playback_selector=PlaybackSelector("rust"),
            )

        self.assertEqual(
            raised.exception.capability,
            "plan_media_download_candidates",
        )
        self.assertIn("invalid stream_kind", str(raised.exception))
        python_fallback.assert_not_called()
        python_reference.assert_not_called()
        rust_call.assert_not_called()

    def test_rust_malformed_preferred_audio_raises_without_backend_call(self):
        cases = (
            {"url": 123, "backup_urls": ["backup"]},
            {"url": "primary", "backup_urls": [456]},
        )
        for preferred_audio in cases:
            with self.subTest(preferred_audio=preferred_audio), patch(
                "bilikara.cache.rust_backend.python_fallback"
            ) as python_fallback, patch(
                "bilikara.cache.CacheManager._py_preferred_audio_urls"
            ) as python_reference, patch(
                "bilikara.cache.rust_backend.try_plan_media_download_candidates"
            ) as rust_call, self.assertRaises(
                PlaybackCapabilityError
            ) as raised:
                CacheManager._preferred_audio_urls(
                    preferred_audio,
                    playback_selector=PlaybackSelector("rust"),
                )

            self.assertEqual(
                raised.exception.capability,
                "plan_media_download_candidates",
            )
            self.assertIn(
                "preferred audio URLs must be strings",
                str(raised.exception),
            )
            python_fallback.assert_not_called()
            python_reference.assert_not_called()
            rust_call.assert_not_called()

    def test_python_selector_retains_reference_precondition_behavior(self):
        preferred_audio = {"url": 123, "backup_urls": [456]}
        with patch(
            "bilikara.cache.rust_backend.try_plan_media_download_candidates",
            side_effect=AssertionError("Rust playback must not be invoked"),
        ) as rust_call:
            self.assertEqual(
                CacheManager._dash_stream_urls(
                    {},
                    "invalid",
                    playback_selector=PlaybackSelector("python"),
                ),
                [],
            )
            self.assertEqual(
                CacheManager._preferred_audio_urls(
                    preferred_audio,
                    playback_selector=PlaybackSelector("python"),
                ),
                [123, 456],
            )
        rust_call.assert_not_called()

    def test_no_selector_retains_legacy_fallback_behavior(self):
        preferred_audio = {"url": 123, "backup_urls": [456]}
        with patch(
            "bilikara.cache.rust_backend.python_fallback",
            wraps=rust_backend.python_fallback,
        ) as python_fallback, patch(
            "bilikara.cache.rust_backend.try_plan_media_download_candidates",
            side_effect=AssertionError("invalid input must not be sent to Rust"),
        ) as rust_call:
            self.assertEqual(CacheManager._dash_stream_urls({}, "invalid"), [])
            self.assertEqual(
                CacheManager._preferred_audio_urls(preferred_audio),
                [123, 456],
            )
        self.assertEqual(python_fallback.call_count, 2)
        rust_call.assert_not_called()


class PlaybackSelectorWorkerTest(unittest.TestCase):
    def test_cache_operation_captures_mode_once(self):
        with TemporaryDirectory() as tmpdir, patch(
            "bilikara.playback_selector.rust_backend.backend_status",
            return_value=rust_status(available=True),
        ):
            root = Path(tmpdir)
            store = PlaylistStore(
                root / "state.json", root / "backup.json", root / "played"
            )
            item = SimpleNamespace(id="song")
            manager = CacheManager.__new__(CacheManager)
            manager.store = store
            manager.stop_event = threading.Event()
            manager._should_cache = lambda item_id: True
            manager._take_retry_request = lambda item_id: False
            manager._remove_cache_dir = lambda item_id: None
            store.get_item = lambda item_id: item
            entered = threading.Event()
            release = threading.Event()
            observed = []

            def cache_multi(item_id, cached_item, **kwargs):
                observed.append(kwargs["playback_selector"].mode)
                if len(observed) == 1:
                    entered.set()
                    self.assertTrue(release.wait(2))
                    observed.append(kwargs["playback_selector"].mode)
                return False

            manager._cache_item_multi = cache_multi
            first = threading.Thread(target=lambda: manager._cache_item("song"))
            first.start()
            self.assertTrue(entered.wait(2))
            store.set_playback_selector_mode("python")
            release.set()
            first.join(2)
            self.assertFalse(first.is_alive())
            manager._cache_item("song")

            self.assertEqual(observed, ["rust", "rust", "python"])

    def test_worker_survives_playback_capability_failure(self):
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
        captured = []

        def capture_playback_selector():
            item_id = "bad" if not captured else "good"
            captured.append(item_id)
            if item_id == "bad":
                raise PlaybackCapabilityError("select_video_stream")
            return PlaybackSelector("python")

        manager.store = SimpleNamespace(
            capture_playback_selector=capture_playback_selector,
            get_item=lambda item_id: SimpleNamespace(id=item_id),
            update_item=lambda *args, **kwargs: None,
        )
        manager.sync_with_playlist = lambda: None
        manager._current_download_source = lambda: "bbdown"
        manager._item_log_path = lambda *args: Path("worker.log")
        manager._append_log_line = lambda *args: None
        manager._should_cache = lambda item_id: True
        manager._take_retry_request = lambda item_id: False
        manager._remove_cache_dir = lambda item_id: None
        processed = []
        good_processed = threading.Event()

        def cache_item_multi(item_id, item, **kwargs):
            processed.append(item_id)
            good_processed.set()
            manager.stop_event.set()
            return False

        manager._cache_item_multi = cache_item_multi
        manager.tasks.put("bad")
        manager.tasks.put("good")
        worker = threading.Thread(target=manager._worker_loop)
        worker.start()
        self.assertTrue(good_processed.wait(2))
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(captured, ["bad", "good"])
        self.assertEqual(processed, ["good"])

    def test_playback_selector_propagates_through_stream_download(self):
        for mode in ("python", "rust"):
            with self.subTest(mode=mode):
                selector = PlaybackSelector(mode)
                manager = CacheManager.__new__(CacheManager)
                manager.store = SimpleNamespace(capture_playback_selector=lambda: selector)
                manager._should_cache = lambda item_id: True
                manager.lock = threading.RLock()
                manager.video_quality = "1080P 高清"
                manager.hevc_supported = True
                manager.avc_quality_cap = ""
                manager.audio_hires = True
                manager.download_source = "bbdown"
                manager._item_log_path = lambda item_id, source: Path("/tmp/song.log")
                manager._ensure_downloader = lambda source: Path("/bin/bbdown")
                manager._ensure_ffmpeg = lambda force_refresh=False: Path("/bin/ffmpeg")

                item = SimpleNamespace(
                    id="song",
                    display_title="Song",
                    video_page=1,
                    selected_pages=[1],
                    resolved_url="https://example.test/video",
                )

                # Test 1: _cache_item_multi passes playback_selector to _download_selected_streams without TypeError
                download_streams_calls = []

                def fake_download_selected_streams(item_arg, bin_arg, ffmpeg_arg, dir_arg, log_arg, **kwargs):
                    download_streams_calls.append(kwargs.get("playback_selector"))
                    return {
                        "video_file": Path("video.mp4"),
                        "video_relative_path": "song/video.mp4",
                        "video_media_url": "/media/song/video.mp4",
                        "audio_variants": [{"id": "v1", "audio_url": "/media/song/audio.m4a"}],
                        "selected_audio_variant_id": "v1",
                    }

                manager._download_selected_streams = fake_download_selected_streams
                manager.store.update_item = lambda *args, **kwargs: None
                manager._record_item_activity = lambda *args, **kwargs: None
                manager._append_log_line = lambda *args, **kwargs: None
                manager._clear_item_download_progress = lambda *args, **kwargs: None
                manager._raise_if_retry_requested = lambda *args, **kwargs: None
                manager._raise_if_priority_shift = lambda *args, **kwargs: None
                manager._cache_start_message = lambda item_arg: ""
                manager._ready_message = lambda item_arg: ""

                res = manager._cache_item_multi("song", item, allow_refresh_retry=True, playback_selector=selector)
                self.assertTrue(res)
                self.assertEqual(len(download_streams_calls), 1)
                self.assertIs(download_streams_calls[0], selector)

                # Test 2: _download_selected_streams passes playback_selector to downstream helpers
                pref_args_calls = []
                format_selector_calls = []

                def fake_bbdown_args(stream_kind, **kwargs):
                    pref_args_calls.append(kwargs.get("playback_selector"))
                    return ["-q", "80"]

                def fake_ytdlp_selector(stream_kind, **kwargs):
                    format_selector_calls.append(kwargs.get("playback_selector"))
                    return "best"

                manager._bbdown_stream_preference_args = fake_bbdown_args
                manager._ytdlp_format_selector = fake_ytdlp_selector

                bbdown_cmd = manager._bbdown_download_command(
                    Path("/bin/bbdown"),
                    Path("/bin/ffmpeg"),
                    "https://example.test",
                    page=1,
                    stream_kind="video",
                    target_dir=Path("/tmp"),
                    playback_selector=selector,
                )
                self.assertEqual(len(pref_args_calls), 1)
                self.assertIs(pref_args_calls[0], selector)

                ytdlp_cmd = manager._ytdlp_download_command(
                    Path("/bin/ytdlp"),
                    Path("/bin/ffmpeg"),
                    "https://example.test",
                    page=1,
                    stream_kind="video",
                    target_dir=Path("/tmp"),
                    playback_selector=selector,
                )
                self.assertEqual(len(format_selector_calls), 1)
                self.assertIs(format_selector_calls[0], selector)


class PlaybackSelectorRouteTest(unittest.TestCase):
    @staticmethod
    def read_request(*, local=True):
        writes = []
        authoritative = {
            "playback_selector": {
                "mode": "python",
                "modes": ["python", "rust"],
                "rust_available": True,
                "warning": "",
            },
            "state_revision": 41,
        }
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            playback_selector_capability_snapshot=lambda: authoritative,
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/playback-selector"
        handler.headers = {}
        handler._is_local_client = lambda: local
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )
        with patch("bilikara.server.CONTEXT", context):
            handler.do_GET()
        return writes, authoritative

    @staticmethod
    def request(body, *, local=True):
        writes = []
        mutations = []
        authoritative = {
            "playback_selector": {"mode": body.get("mode")},
            "current_item": {"id": "song"},
            "state_revision": 41,
        }
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_playback_selector_mode=lambda mode: mutations.append(mode),
            snapshot=lambda: authoritative,
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/playback-selector"
        handler.headers = {}
        handler._read_json_body = lambda: body
        handler._is_local_client = lambda: local
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )
        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()
        return writes, mutations, authoritative

    def test_local_mutation_returns_full_authoritative_snapshot(self):
        writes, mutations, authoritative = self.request({"mode": "python"})
        self.assertEqual(mutations, ["python"])
        self.assertEqual(writes, [({"ok": True, "data": authoritative}, None)])

    def test_local_capability_read_returns_authoritative_selector(self):
        writes, authoritative = self.read_request()
        self.assertEqual(writes, [({"ok": True, "data": authoritative}, None)])

    def test_lan_capability_read_is_rejected(self):
        writes, _ = self.read_request(local=False)
        self.assertEqual(writes[0][0], {"ok": False, "error": "forbidden"})
        self.assertEqual(writes[0][1], server_module.HTTPStatus.FORBIDDEN)

    def test_lan_mutation_is_rejected(self):
        writes, mutations, _ = self.request({"mode": "python"}, local=False)
        self.assertEqual(mutations, [])
        self.assertEqual(writes[0][0], {"ok": False, "error": "forbidden"})
        self.assertEqual(writes[0][1], server_module.HTTPStatus.FORBIDDEN)

    def test_invalid_api_mode_is_rejected(self):
        writes = []
        context = SimpleNamespace(
            touch_client=lambda client_id, is_host=True: None,
            set_playback_selector_mode=lambda mode: (_ for _ in ()).throw(
                ValueError("playback selector mode must be python or rust")
            ),
        )
        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.path = "/api/player/playback-selector"
        handler.headers = {}
        handler._read_json_body = lambda: {"mode": "hybrid"}
        handler._is_local_client = lambda: True
        handler._write_json = lambda payload, status=None: writes.append(
            (payload, status)
        )
        with patch("bilikara.server.CONTEXT", context):
            handler.do_POST()
        self.assertEqual(writes[0][1], server_module.HTTPStatus.BAD_REQUEST)
        self.assertIn("python or rust", writes[0][0]["error"])


if __name__ == "__main__":
    unittest.main()
