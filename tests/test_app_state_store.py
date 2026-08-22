import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara import rust_runtime
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


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
        self.assertTrue(store.advance_to_next())

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
        store.advance_to_next()
        self.assertEqual(store.playback_generation, after_first + 1)

        self.assertTrue(store.discard_backup())
        self.assertEqual(store.session_generation, initial_session + 1)
        self.assertEqual(store.playback_generation, after_first + 2)

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


if __name__ == "__main__":
    unittest.main()
