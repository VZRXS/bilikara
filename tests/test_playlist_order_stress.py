from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from random import Random
from tempfile import TemporaryDirectory
import threading
import unittest

from bilikara import rust_runtime
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


class PlaylistOrderStressTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = TemporaryDirectory(prefix="playlist-order-stress-")
        root = Path(self.directory.name)
        self.store = PlaylistStore(root / "state.json", root / "backup.json", root / "sessions")
        self.users = ["A", "B", "C", "D"]
        for user in self.users:
            self.store.add_session_user(user)

    def tearDown(self) -> None:
        self.store.shutdown()
        self.directory.cleanup()

    def add(self, item_id: str, requester: str, *, position: str = "tail") -> None:
        self.store.add_item(PlaylistItem(
            id=item_id, original_url=f"https://example.test/{item_id}",
            resolved_url=f"https://example.test/{item_id}", bvid=f"BV-{item_id}",
            aid=1, cid=2, page=1, title=item_id, part_title="P1",
            display_title=item_id, cover_url="", embed_url="",
        ), requester_name=requester, position=position)

    def ids(self) -> list[str]:
        return [item.id for item in self.store.playlist]

    def test_resort_clears_a_single_priority_before_future_requests(self) -> None:
        self.add("playing", "A")
        self.add("a1", "A", position="next")
        self.assertTrue(self.store.resort_playlist_by_cycle())
        self.assertEqual(self.store.playlist[0].queue_slot_type, "cycle")
        self.add("b1", "B")
        self.assertEqual(self.ids(), ["b1", "a1"])

    def test_resort_clears_a_single_manual_before_future_requests(self) -> None:
        self.add("playing", "A")
        self.add("b1", "B")
        self.add("a1", "A")
        self.store.move_item_to_index("a1", 0)
        self.store.remove_item("b1")
        self.assertEqual(self.store.playlist[0].queue_slot_type, "manual")
        self.assertTrue(self.store.resort_playlist_by_cycle())
        self.assertEqual(self.store.playlist[0].queue_slot_type, "cycle")
        self.add("b2", "B")
        self.assertEqual(self.ids(), ["b2", "a1"])

    def test_latest_top_wins_without_interrupting_or_removing_any_song(self) -> None:
        self.add("playing", "A")
        for item_id, requester in [("b1", "B"), ("c1", "C"), ("a1", "A"), ("b2", "B")]:
            self.add(item_id, requester)
        before = self.store.authoritative_snapshot()
        self.store.move_to_next("b2")
        self.store.move_to_next("c1")
        self.store.move_to_next("c1")
        after = self.store.authoritative_snapshot()
        self.assertEqual(self.ids(), ["c1", "b2", "b1", "a1"])
        self.assertEqual(after["current_item"], before["current_item"])
        self.assertEqual(after["playback_generation"], before["playback_generation"])
        self.assertEqual(after["session_played"], before["session_played"])

    def test_cycle_resort_keeps_each_singers_present_relative_song_order(self) -> None:
        self.add("playing", "A")
        for item_id, requester in [("a1", "A"), ("a2", "A"), ("b1", "B"), ("b2", "B")]:
            self.add(item_id, requester)
        self.store.move_to_next("a2")
        self.store.resort_playlist_by_cycle()
        self.assertEqual(self.ids(), ["b1", "a2", "b2", "a1"])
        self.assertTrue(all(item.queue_slot_type == "cycle" for item in self.store.playlist))

    def test_concurrent_native_callers_conserve_queue_payloads_and_current_program(self) -> None:
        self.add("playing", "A")
        for index in range(32):
            self.add(f"q{index}", self.users[index % len(self.users)])
        before = self.store.authoritative_snapshot()
        baseline = {item["id"]: {**item, "queue_slot_type": "cycle"} for item in before["playlist"]}
        barrier = threading.Barrier(8)

        def worker(worker_id: int) -> None:
            rng = Random(11400 + worker_id)
            barrier.wait(timeout=10)
            for step in range(80):
                item_id = f"q{rng.randrange(32)}"
                command = rng.choice(["move_to_next", "move_item_to_index", "move_item", "resort_playlist_by_cycle"])
                fields: dict[str, object] = {"now": float(1000 + step)}
                if command != "resort_playlist_by_cycle":
                    fields["item_id"] = item_id
                if command == "move_item_to_index":
                    fields["target_index"] = rng.randrange(-2, 34)
                elif command == "move_item":
                    fields["direction"] = rng.choice(["up", "down"])
                snapshot = rust_runtime.app_state_request(command, **fields)["snapshot"]
                actual = {item["id"]: {**item, "queue_slot_type": "cycle"} for item in snapshot["playlist"]}
                self.assertEqual(len(snapshot["playlist"]), len(baseline))
                self.assertEqual(actual, baseline)
                self.assertEqual(snapshot["current_item"], before["current_item"])
                self.assertEqual(snapshot["playback_generation"], before["playback_generation"])
                self.assertEqual(snapshot["session_played"], before["session_played"])

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(worker, range(8)))

    def test_mixed_requests_moves_and_stale_next_conserve_every_admitted_item(self) -> None:
        admitted: set[str] = set()
        retired: set[str] = set()
        rng = Random(1142026)
        stale_rejections = 0
        for step in range(500):
            before = self.store.authoritative_snapshot()
            queue = before["playlist"]
            action = rng.randrange(7)
            if (action < 2 and len(queue) < 32) or not admitted:
                item_id = f"mixed-{len(admitted)}"
                self.add(item_id, rng.choice(self.users), position="next" if action == 0 else "tail")
                admitted.add(item_id)
            elif action in {2, 3} and queue:
                item_id = rng.choice(queue)["id"]
                if action == 2:
                    self.store.move_to_next(item_id)
                else:
                    self.store.move_item_to_index(item_id, rng.randrange(-1, len(queue) + 2))
            elif action == 4:
                self.store.resort_playlist_by_cycle()
            else:
                generation = before["playback_generation"]
                stale = action == 6 and generation > 1
                if stale:
                    with self.assertRaises(rust_runtime.RustAppStateError) as rejected:
                        rust_runtime.app_state_request("advance_to_next",
                            expected_playback_generation=generation - 1, reset_av_delay=False,
                            now=float(1000 + step))
                    self.assertEqual(rejected.exception.kind, "playback_generation_mismatch")
                    self.assertEqual(self.store.authoritative_snapshot(), before)
                    stale_rejections += 1
                else:
                    self.store.advance_to_next(expected_playback_generation=generation)
                    if before["current_item"]:
                        retired.add(before["current_item"]["id"])
            after = self.store.authoritative_snapshot()
            active = [item["id"] for item in after["playlist"]]
            if after["current_item"]:
                active.append(after["current_item"]["id"])
            self.assertEqual(len(active), len(set(active)))
            self.assertFalse(set(active) & retired)
            self.assertEqual(set(active) | retired, admitted)
            self.assertEqual({item["item_id"] for item in after["session_played"]
                if item["ended_at"] is not None}, retired)
        self.assertGreater(stale_rejections, 0)
