import copy
import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.models import PlaylistItem
from bilikara.store import (
    PlaylistStore,
    PlaylistStoreCommandError,
    _py_apply_av_delay_action,
)


def item(item_id: str, *, song: str | None = None) -> PlaylistItem:
    identity = song or item_id
    return PlaylistItem(
        id=item_id,
        original_url=f"https://example.test/{identity}",
        resolved_url=f"https://example.test/{identity}?p=1",
        bvid=f"BV{identity:0<10}"[:12],
        aid=1,
        cid=2,
        page=1,
        title=f"title-{item_id}",
        part_title="P1",
        display_title=f"title-{item_id} - P1",
        cover_url="",
        embed_url="",
    )


def begin_cache_attempt(store: PlaylistStore, item_id: str) -> int:
    observed = store.get_item(item_id)
    if observed is None:
        raise AssertionError(f"missing cache item fixture: {item_id}")
    return store.begin_cache_attempt(item_id, observed.item_incarnation_id)


def advance_to_next(store: PlaylistStore, *, reset_av_delay: bool = False) -> bool:
    return store.advance_to_next(
        expected_playback_generation=store.playback_generation,
        reset_av_delay=reset_av_delay,
    )


class RustAppStateStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def store(self, *, on_change=None) -> PlaylistStore:
        return PlaylistStore(
            self.root / "state.json",
            self.root / "playlist_backup.json",
            self.root / "played_sessions",
            on_change=on_change,
        )

    def test_existing_files_round_trip_through_one_rust_initialization(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_session_user("Bob")
        store.set_volume_percent(37)
        store.set_muted(True)
        store.set_key_shift(3)
        store.add_item(item("a"), requester_name="Alice")
        store.add_item(item("b"), requester_name="Bob")
        store.add_item(item("c"), requester_name="Alice")
        self.assertTrue(store.mark_item_playback_started("a"))
        self.assertTrue(advance_to_next(store))

        restarted = self.store()
        before_restore = restarted.snapshot()
        self.assertEqual(before_restore["session_users"], ["Alice", "Bob"])
        self.assertEqual(before_restore["player_settings"]["volume_percent"], 37)
        self.assertTrue(before_restore["player_settings"]["is_muted"])
        self.assertEqual(before_restore["player_settings"]["key_shift"], 0)
        self.assertEqual(len(before_restore["history"]), 1)
        self.assertEqual(before_restore["history"][0]["display_title"], "title-a")
        self.assertTrue(restarted.restore_backup())

        restored = restarted.snapshot()
        self.assertEqual(restored["current_item"]["id"], "b")
        self.assertEqual([entry["id"] for entry in restored["playlist"]], ["c"])
        self.assertEqual(
            [entry.item_id for entry in restarted.session_played], ["a", "b"]
        )
        self.assertGreaterEqual(restored["revision"], 2)

    def test_revision_rejection_and_snapshot_contract(self):
        store = self.store()
        initial = store.revision
        store.add_session_user("Alice")
        self.assertEqual(store.revision, initial + 1)

        before_rejection = store.revision
        with self.assertRaises(ValueError):
            store.add_session_user("Alice")
        self.assertEqual(store.revision, before_rejection)

        snapshot = store.authoritative_snapshot()
        self.assertEqual(snapshot["revision"], before_rejection)
        self.assertEqual(store.revision, before_rejection)

    def test_player_status_observation_adapter_preserves_exact_generation_rejection(self):
        changes: list[str] = []
        store = self.store(on_change=lambda: changes.append("changed"))
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        generation = store.playback_generation
        changes.clear()

        result = store.apply_player_status_observation(
            expected_playback_generation=generation,
            item_id="a",
            is_paused=True,
            current_time=50.0,
            duration=100.0,
        )
        self.assertEqual(
            result,
            {
                "changed": True,
                "started_changed": True,
                "threshold_changed": True,
            },
        )
        self.assertTrue(store.current_item_started)
        self.assertTrue(store.session_played[0].threshold_reached)
        self.assertEqual(store.playback_generation, generation)
        self.assertEqual(changes, ["changed"])

        store.reset_player_state()
        reset_generation = store.playback_generation
        self.assertGreater(reset_generation, generation)
        changes.clear()
        before = store.authoritative_snapshot()
        with self.assertRaises(PlaylistStoreCommandError) as rejected:
            store.apply_player_status_observation(
                expected_playback_generation=generation,
                item_id="a",
                is_paused=False,
                current_time=75.0,
                duration=100.0,
            )
        self.assertEqual(rejected.exception.kind, "playback_generation_mismatch")
        self.assertEqual(store.authoritative_snapshot(), before)
        self.assertEqual(changes, [])

    def test_cache_attempt_reservation_is_opaque_and_operational_only(self):
        changes: list[str] = []
        store = self.store(on_change=lambda: changes.append("changed"))
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        changes.clear()
        before = store.authoritative_snapshot()
        persisted_before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        first = begin_cache_attempt(store, "a")
        second = begin_cache_attempt(store, "a")

        self.assertGreater(first, 0)
        self.assertGreater(second, first)
        self.assertEqual(store.authoritative_snapshot(), before)
        self.assertEqual(changes, [])
        self.assertEqual(
            {
                path.relative_to(self.root): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file()
            },
            persisted_before,
        )
        self.assertNotIn(
            "cache_attempt",
            json.dumps(store.authoritative_snapshot(), sort_keys=True),
        )
        self.assertNotIn(
            "cache_attempt",
            b"\n".join(persisted_before.values()).decode("utf-8"),
        )

        with self.assertRaises(PlaylistStoreCommandError) as rejected:
            store.apply_cache_event(
                "a",
                cache_attempt_token=first,
                event={"kind": "queued", "message": "old"},
            )
        self.assertEqual(rejected.exception.kind, "cache_attempt_superseded")
        self.assertEqual(store.authoritative_snapshot(), before)
        self.assertEqual(changes, [])

        self.assertTrue(
            store.apply_cache_event(
                "a",
                cache_attempt_token=second,
                event={"kind": "queued", "message": "current"},
            )
        )
        self.assertEqual(store.get_item("a").cache_message, "current")
        self.assertEqual(changes, ["changed"])

    def test_cache_attempt_reservations_stay_bounded_to_live_python_attempts(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        store.add_item(item("b"), requester_name="Alice")

        superseded = []
        for _ in range(200):
            superseded.append(begin_cache_attempt(store, "a"))
        current_a = superseded[-1]
        self.assertEqual(len(store._cache_attempt_reservations), 1)
        for token in superseded[:-1]:
            with self.assertRaisesRegex(ValueError, "unavailable"):
                store.cache_attempt_reservation(token)
        self.assertEqual(
            store.cache_attempt_reservation(current_a)["cache_attempt_token"],
            current_a,
        )

        failed_b = begin_cache_attempt(store, "b")
        self.assertEqual(len(store._cache_attempt_reservations), 2)
        self.assertTrue(
            store.apply_cache_event(
                "b",
                cache_attempt_token=failed_b,
                event={"kind": "failed", "message": "expected failure"},
            )
        )
        self.assertEqual(len(store._cache_attempt_reservations), 1)

        rejected_b = begin_cache_attempt(store, "b")
        with self.assertRaises(PlaylistStoreCommandError) as rejected:
            store.apply_cache_event(
                "a",
                cache_attempt_token=rejected_b,
                event={"kind": "cancelled", "message": "wrong worker owner"},
            )
        self.assertEqual(rejected.exception.kind, "cache_attempt_wrong_item")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            store.cache_attempt_reservation(rejected_b)
        self.assertEqual(len(store._cache_attempt_reservations), 1)

        self.assertTrue(store.remove_item("a"))
        with self.assertRaisesRegex(ValueError, "unavailable"):
            store.cache_attempt_reservation(current_a)
        self.assertEqual(store._cache_attempt_reservations, {})

    def test_stale_expected_incarnation_is_forwarded_and_rejected_without_side_effects(self):
        changes: list[str] = []
        store = self.store(on_change=lambda: changes.append("changed"))
        store.add_session_user("Alice")
        store.add_item(item("a", song="old"), requester_name="Alice")
        stale = store.get_item("a")
        self.assertIsNotNone(stale)
        self.assertTrue(store.remove_item("a"))
        store.add_item(item("a", song="new"), requester_name="Alice")
        live = store.get_item("a")
        self.assertIsNotNone(live)
        self.assertNotEqual(stale.item_incarnation_id, live.item_incarnation_id)
        changes.clear()
        snapshot_before = store.authoritative_snapshot()
        reservations_before = dict(store._cache_attempt_reservations)
        persisted_before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        with self.assertRaises(PlaylistStoreCommandError) as rejected:
            store.begin_cache_attempt("a", stale.item_incarnation_id)

        self.assertEqual(rejected.exception.kind, "item_incarnation_mismatch")
        self.assertEqual(store.authoritative_snapshot(), snapshot_before)
        self.assertEqual(store._cache_attempt_reservations, reservations_before)
        self.assertEqual(changes, [])
        self.assertEqual(
            {
                path.relative_to(self.root): path.read_bytes()
                for path in self.root.rglob("*")
                if path.is_file()
            },
            persisted_before,
        )

    def test_concurrent_cache_attempts_retain_only_the_newest_rust_reservation(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        original_request = store._request
        first_returned = threading.Event()
        release_first = threading.Event()
        second_returned = threading.Event()
        request_index = 0
        request_index_lock = threading.Lock()

        def delayed_request(command: str, **fields):
            nonlocal request_index
            result = original_request(command, **fields)
            if command != "begin_cache_attempt":
                return result
            with request_index_lock:
                request_index += 1
                index = request_index
            if index == 1:
                first_returned.set()
                self.assertTrue(release_first.wait(2))
            elif index == 2:
                second_returned.set()
            return result

        tokens: list[int] = []
        with patch.object(store, "_request", side_effect=delayed_request):
            first = threading.Thread(
                target=lambda: tokens.append(begin_cache_attempt(store, "a"))
            )
            second = threading.Thread(
                target=lambda: tokens.append(begin_cache_attempt(store, "a"))
            )
            first.start()
            self.assertTrue(first_returned.wait(2))
            second.start()
            if second_returned.wait(0.2):
                second.join(timeout=2)
            release_first.set()
            first.join(timeout=2)
            second.join(timeout=2)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(len(tokens), 2)
        newest = max(tokens)
        self.assertEqual(len(store._cache_attempt_reservations), 1)
        self.assertEqual(
            store.cache_attempt_reservation(newest)["cache_attempt_token"], newest
        )

    def test_persistence_adapter_does_not_rewrite_rust_artifact_identities(self):
        persisted = item("a").serialize()
        persisted.update(
            {
                "item_incarnation_id": (
                    "i-0123456789abcdef0123456789abcdef-0000000000000001"
                ),
                "artifact_set_id": (
                    "a-0123456789abcdef0123456789abcdef-0000000000000002"
                ),
                "artifact_relative_directory": (
                    "artifacts/"
                    "i-0123456789abcdef0123456789abcdef-0000000000000001/"
                    "a-0123456789abcdef0123456789abcdef-0000000000000002"
                ),
            }
        )

        normalized = PlaylistStore._normalized_item_payload(persisted)

        self.assertIsNotNone(normalized)
        self.assertEqual(
            normalized["item_incarnation_id"], persisted["item_incarnation_id"]
        )
        self.assertEqual(normalized["artifact_set_id"], persisted["artifact_set_id"])
        self.assertEqual(
            normalized["artifact_relative_directory"],
            persisted["artifact_relative_directory"],
        )

    def test_begin_cache_attempt_returns_the_opaque_rust_token(self):
        store = self.store()
        with patch.object(
            store,
            "_request",
            return_value={
                "cache_attempt_token": 9_007_199_254_740_991,
                "item_id": "opaque-item",
                "item_incarnation_id": "i-0123456789abcdef0123456789abcdef-0000000000000001",
                "artifact_set_id": "a-0123456789abcdef0123456789abcdef-0000000000000001",
                "artifact_relative_directory": (
                    "artifacts/i-0123456789abcdef0123456789abcdef-0000000000000001/"
                    "a-0123456789abcdef0123456789abcdef-0000000000000001"
                ),
                "refresh": False,
            },
        ) as request:
            token = store.begin_cache_attempt(
                "opaque-item",
                "i-0123456789abcdef0123456789abcdef-0000000000000001",
            )

        self.assertEqual(token, 9_007_199_254_740_991)
        request.assert_called_once_with(
            "begin_cache_attempt",
            include_now=False,
            item_id="opaque-item",
            expected_item_incarnation_id=(
                "i-0123456789abcdef0123456789abcdef-0000000000000001"
            ),
        )
        with self.assertRaises(TypeError):
            store.apply_cache_event(
                "opaque-item",
                generation=0,
                event={"kind": "queued", "message": "legacy"},
            )

    def test_session_and_playback_generations_change_only_at_identity_boundaries(self):
        store = self.store()
        initial_session = store.session_generation
        initial_playback = store.playback_generation
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        after_first = store.playback_generation
        self.assertEqual(after_first, initial_playback + 1)

        store.set_volume_percent(44)
        self.assertEqual(store.playback_generation, after_first)
        store.add_item(item("b"), requester_name="Alice")
        self.assertEqual(store.playback_generation, after_first)
        advance_to_next(store)
        self.assertEqual(store.playback_generation, after_first + 1)

        self.assertTrue(store.discard_backup())
        self.assertEqual(store.session_generation, initial_session + 1)
        self.assertEqual(store.playback_generation, after_first + 2)

    def test_stale_next_generation_is_forwarded_and_rejected_without_side_effects(self):
        changes: list[str] = []
        store = self.store(on_change=lambda: changes.append("changed"))
        store.add_session_user("Alice")
        for item_id in ("a", "b", "c"):
            store.add_item(item(item_id), requester_name="Alice")
        generation_a = store.playback_generation
        self.assertTrue(store.move_to_front("b"))
        generation_b = store.playback_generation
        before_stale = store.authoritative_snapshot()
        changes.clear()

        with self.assertRaises(PlaylistStoreCommandError) as raised:
            store.advance_to_next(expected_playback_generation=generation_a)

        self.assertEqual(raised.exception.kind, "playback_generation_mismatch")
        self.assertEqual(store.authoritative_snapshot(), before_stale)
        self.assertEqual(changes, [])
        self.assertTrue(
            store.advance_to_next(expected_playback_generation=generation_b)
        )
        self.assertEqual(store.snapshot()["current_item"]["id"], "c")

    def test_playback_program_projection_is_preserved_validated_and_not_persisted(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")

        snapshot = store.snapshot()
        current = snapshot["current_item"]
        expected_program = {
            "item_id": "a",
            "item_incarnation_id": current["item_incarnation_id"],
            "selected_audio_variant_id": "",
            "artifact_set_id": None,
        }
        self.assertEqual(snapshot["playback_program"], expected_program)

        before = store.authoritative_snapshot()
        with self.assertRaisesRegex(ValueError, "playback_program"):
            store.update_item("a", playback_program={"item_id": "forged"})
        self.assertEqual(store.authoritative_snapshot(), before)

        response = rust_runtime.app_state_request("snapshot")
        self.assertEqual(response["snapshot"]["playback_program"], expected_program)
        self.assertNotIn("playback_program", response["persistence"])
        self.assertNotIn("playback_generation", response["persistence"])
        for persisted_file in self.root.rglob("*.json"):
            persisted_text = persisted_file.read_text(encoding="utf-8")
            self.assertNotIn('"playback_program"', persisted_text)
            self.assertNotIn('"playback_generation"', persisted_text)

        malformed_responses = []
        malformed_artifact = copy.deepcopy(response)
        malformed_artifact["snapshot"]["playback_program"]["artifact_set_id"] = 7
        malformed_responses.append(malformed_artifact)
        missing_program_field = copy.deepcopy(response)
        del missing_program_field["snapshot"]["playback_program"]
        malformed_responses.append(missing_program_field)
        unsafe_generation = copy.deepcopy(response)
        unsafe_generation["snapshot"]["playback_generation"] = 9_007_199_254_740_992
        malformed_responses.append(unsafe_generation)

        for malformed in malformed_responses:
            with self.subTest(snapshot=malformed["snapshot"]):
                with self.assertRaisesRegex(
                    rust_runtime.RustAppStateError,
                    "invalid authoritative projection",
                ):
                    with store.lock:
                        store._accept_response_unlocked(malformed)
                self.assertEqual(store.authoritative_snapshot(), before)

    def test_reset_player_accepts_rust_generation_without_runtime_only_persistence(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        before = store.authoritative_snapshot()
        persisted_before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*.json")
        }
        rust_responses = []
        app_state_request = rust_runtime.app_state_request

        def capture_request(command, **fields):
            response = app_state_request(command, **fields)
            if command == "reset_player":
                rust_responses.append(copy.deepcopy(response))
            return response

        with patch(
            "bilikara.rust_runtime.app_state_request",
            side_effect=capture_request,
        ):
            store.reset_player_state()

        after = store.authoritative_snapshot()
        self.assertEqual(after["playback_program"], before["playback_program"])
        self.assertEqual(
            after["playback_generation"], before["playback_generation"] + 1
        )
        self.assertEqual(after, rust_responses[0]["snapshot"])
        self.assertTrue(rust_responses[0]["committed"])
        self.assertFalse(any(rust_responses[0]["effects"].values()))
        persisted_after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*.json")
        }
        self.assertEqual(persisted_after, persisted_before)

    def test_restart_playback_program_preserves_settings_without_persistence(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        store.set_mode("online")
        store.set_volume_percent(37)
        store.set_muted(True)
        before = store.authoritative_snapshot()
        persisted_before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*.json")
        }

        changed = store.restart_playback_program()

        after = store.authoritative_snapshot()
        self.assertTrue(changed)
        self.assertEqual(after["playback_program"], before["playback_program"])
        self.assertEqual(after["player_settings"], before["player_settings"])
        self.assertEqual(after["playback_mode"], before["playback_mode"])
        self.assertEqual(after["revision"], before["revision"] + 1)
        self.assertEqual(
            after["playback_generation"], before["playback_generation"] + 1
        )
        persisted_after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*.json")
        }
        self.assertEqual(persisted_after, persisted_before)

    def test_concurrent_ffi_callers_are_serialized_by_rust_revision(self):
        store = self.store()
        initial_revision = store.revision
        barrier = threading.Barrier(8)
        failures: list[BaseException] = []

        def mutate(value: int) -> None:
            try:
                barrier.wait()
                rust_runtime.app_state_request(
                    "set_volume",
                    volume_percent=value,
                    now=100.0 + value,
                )
            except BaseException as exc:
                failures.append(exc)

        workers = [
            threading.Thread(target=mutate, args=(value,))
            for value in range(10, 18)
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()

        self.assertEqual(failures, [])
        snapshot = store.authoritative_snapshot()
        self.assertEqual(snapshot["revision"], initial_revision + len(workers))

    def test_projection_cannot_be_mutated_during_serialization(self):
        store = self.store()
        store.add_session_user("Alice")
        store.add_item(item("a"), requester_name="Alice")
        projected = store.current_item
        self.assertIsNotNone(projected)
        projected.display_title = "outside mutation"

        restarted = self.store()
        self.assertTrue(restarted.restore_backup())
        self.assertEqual(restarted.current_item.display_title, "title-a - P1")

    def test_runtime_or_initialization_failure_never_creates_python_core(self):
        with patch("bilikara.store.rust_runtime.app_state_available", return_value=False), patch(
            "bilikara.store.rust_runtime.runtime_status",
            return_value={"error": "missing AppState capability"},
        ), patch(
            "bilikara.rust_backend.python_fallback",
            side_effect=AssertionError("Python Core fallback must not run"),
        ):
            with self.assertRaises(rust_runtime.RustRuntimeUnavailableError):
                self.store()

        failure = rust_runtime.RustAppStateError(
            "internal_error",
            "initialization_failed",
            "initialization failed",
            response={},
        )
        with patch("bilikara.store.rust_runtime.app_state_available", return_value=True), patch(
            "bilikara.store.rust_runtime.app_state_request", side_effect=failure
        ), patch(
            "bilikara.rust_backend.python_fallback",
            side_effect=AssertionError("Python Core fallback must not run"),
        ):
            with self.assertRaises(rust_runtime.RustAppStateError):
                self.store()

    def test_legacy_processing_backend_key_is_dropped_from_state_and_persistence(self):
        legacy_key = "playback_" + "selector" + "_mode"
        (self.root / "player_state.json").write_text(
            json.dumps(
                {
                    legacy_key: "python",
                    "player_settings": {"volume_percent": 41},
                }
            ),
            encoding="utf-8",
        )

        store = self.store()
        snapshot = store.authoritative_snapshot()
        persisted = json.loads(
            (self.root / "player_state.json").read_text(encoding="utf-8")
        )

        self.assertNotIn("playback_" + "selector", snapshot)
        self.assertNotIn(legacy_key, persisted)
        self.assertEqual(snapshot["player_settings"]["volume_percent"], 41)

    def test_av_delay_read_only_snapshots_are_backend_free_and_exact(self):
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
        store = self.store()
        with patch(
            "bilikara.rust_backend.try_apply_av_delay_action",
            side_effect=AssertionError(
                "read-only snapshot must not invoke the legacy adapter"
            ),
        ):
            for global_delay, local_delay, locked in states:
                with self.subTest(
                    global_delay=global_delay,
                    local_delay=local_delay,
                    locked=locked,
                ):
                    store.set_av_offset_ms(global_delay if locked else 0)
                    if local_delay:
                        store.apply_av_delay_action(
                            {"type": "adjust", "delta_ms": local_delay}
                        )
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

    def test_av_delay_snapshot_and_mutation_are_owned_by_app_state(self):
        store = self.store()
        expected = _py_apply_av_delay_action(
            {
                "global_delay_ms": 0,
                "local_delay_ms": 0,
                "locked": False,
            },
            {"type": "adjust", "delta_ms": 125},
        )
        before_revision = store.revision

        with patch(
            "bilikara.rust_backend.try_apply_av_delay_action",
            side_effect=AssertionError("AppState must not call the legacy adapter"),
        ):
            result = store.apply_av_delay_action(
                {"type": "adjust", "delta_ms": 125}
            )
            snapshot = store.snapshot()["player_settings"]["av_delay"]

        self.assertEqual(result, expected)
        self.assertEqual(snapshot, expected)
        self.assertEqual(store.revision, before_revision + 1)

    def test_playlist_ordering_remains_internal_to_app_state(self):
        store = self.store()
        with patch(
            "bilikara.rust_backend.try_plan_playlist_order",
            side_effect=AssertionError("legacy planner adapter must not run"),
        ) as planner:
            store.add_session_user("A")
            store.add_session_user("B")
            store.add_item(item("a"), requester_name="A")

        planner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
