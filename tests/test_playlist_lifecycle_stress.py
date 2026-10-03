from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict
from itertools import zip_longest
import json
from pathlib import Path
from random import Random
from tempfile import TemporaryDirectory
import threading
import unittest
import uuid

from bilikara import rust_runtime
from bilikara.store import PlaylistStore
from tests.test_app_state_store import item


class PlaylistLifecycleStressTest(unittest.TestCase):
    RANDOM_SEEDS = range(12)
    RANDOM_STEPS = 180
    CONCURRENT_SEED = 118_940

    @contextmanager
    def session(self, users):
        with TemporaryDirectory(prefix="playlist-lifecycle-") as directory:
            root = Path(directory)
            store = PlaylistStore(root / "state.json", root / "backup.json", root / "sessions")
            try:
                for user in users:
                    store.add_session_user(user)
                yield store
            finally:
                store.shutdown()

    def snapshot(self):
        return self.with_requester_ids(rust_runtime.app_state_request("snapshot"))["snapshot"]

    @staticmethod
    def with_requester_ids(response):
        # Ownership is a separate persisted identity; requester_name is the
        # immutable display label and cannot group songs after a rename.
        response["snapshot"]["requester_user_ids"] = response["persistence"]["requester_user_ids"]
        return response

    def command(self, command, **fields):
        return self.with_requester_ids(rust_runtime.app_state_request(command, now=1000.0, **fields))

    def add(self, item_id, user, *, position="tail", song=None, allow_repeat=False):
        return self.command("add_item", item=asdict(item(item_id, song=song)),
            requester_name=user, position=position, reset_av_delay=False, allow_repeat=allow_repeat)

    @staticmethod
    def active(snapshot):
        return snapshot["playlist"] + ([snapshot["current_item"]] if snapshot["current_item"] else [])

    def cycle_schedule(self, snapshot, candidate=None):
        seats = [user["id"] for user in snapshot["session_user_entries"]]
        owners = snapshot["requester_user_ids"]
        current_user = owners.get((snapshot["current_item"] or {}).get("id"))
        if current_user in seats:
            offset = seats.index(current_user) + 1
            seats = seats[offset:] + seats[:offset]
        buckets = [[entry["id"] for entry in snapshot["playlist"]
            if entry["queue_slot_type"] == "cycle" and owners.get(entry["id"]) == user] for user in seats]
        if candidate is not None:
            owner = next(user["id"] for user in snapshot["session_user_entries"] if user["name"] == candidate["requester_name"])
            buckets[seats.index(owner)].append(candidate["id"])
        return [item_id for round_ in zip_longest(*buckets) for item_id in round_ if item_id is not None]

    def assert_cycle_order(self, snapshot):
        actual = [entry["id"] for entry in snapshot["playlist"]
            if entry["queue_slot_type"] == "cycle" and snapshot["requester_user_ids"].get(entry["id"]) in {user["id"] for user in snapshot["session_user_entries"]}]
        self.assertEqual(actual, self.cycle_schedule(snapshot))

    def assert_conserved(self, snapshot, admitted):
        active = self.active(snapshot)
        ids = [entry["id"] for entry in active]
        ended = [entry["item_id"] for entry in snapshot["session_played"] if entry["ended_at"] is not None]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ended), len(set(ended)))
        self.assertFalse(set(ids) & set(ended))
        self.assertEqual(set(ids) | set(ended), set(admitted))
        self.assertEqual(len(snapshot["session_users"]), len(set(snapshot["session_users"])))
        self.assertLessEqual(len(snapshot["session_users"]), 32)
        for entry in active:
            # Even a rename must preserve all request-time content.
            expected = admitted[entry["id"]]
            self.assertEqual({key: value for key, value in entry.items() if key != "queue_slot_type"},
                {key: value for key, value in expected.items() if key != "queue_slot_type"})

    def test_random_user_lifecycle_and_ordering_state_machine(self):
        counts = Counter()
        initial_counts = []
        for seed in self.RANDOM_SEEDS:
            with self.subTest(seed=seed):
                rng = Random(914_000 + seed)
                initial_count = rng.randrange(1, 33)
                initial_counts.append(initial_count)
                with self.session([f"U{index}" for index in range(initial_count)]):
                    admitted = {}
                    serial = 0
                    for step in range(self.RANDOM_STEPS):
                        before = self.snapshot()
                        queue, users = before["playlist"], before["session_users"]
                        choice = rng.randrange(15)
                        fields = {}
                        expected_errors = set()
                        requested_id = None
                        if choice < 3 and len(queue) < 48:
                            requested_id = f"s{seed:03d}{serial:06d}"
                            serial += 1
                            command = "add_item"
                            fields = dict(item=asdict(item(requested_id)), requester_name=rng.choice(users) if users else "missing",
                                position="next" if choice == 2 else "tail", reset_av_delay=False, allow_repeat=False)
                            expected_errors = {"session_user_required"} if not users else set()
                        elif choice in {3, 4, 13, 14}:
                            command = {3: "move_to_next", 4: "move_item_to_index", 13: "move_to_front", 14: "move_item_to_index"}[choice]
                            fields["item_id"] = rng.choice(queue)["id"] if queue and choice != 14 else "missing"
                            if fields["item_id"] == "missing":
                                expected_errors = {"queue_item_missing"}
                            if command == "move_item_to_index":
                                fields["target_index"] = rng.randrange(-3, len(queue) + 4)
                        elif choice == 5:
                            command = "move_session_user_to_index"
                            fields = dict(name=rng.choice(users) if users else "missing", target_index=rng.randrange(-3, len(users) + 4))
                        elif choice == 6:
                            command = "add_session_user"
                            fields["name"] = f"U{rng.randrange(64)}"
                            if fields["name"] in users:
                                expected_errors = {"duplicate_session_user"}
                            elif len(users) == 32:
                                expected_errors = {"too_many_session_users"}
                        elif choice == 7:
                            command = "remove_session_user"
                            fields["name"] = rng.choice(users) if users else "missing"
                        elif choice == 10:
                            command = "rename_session_user"
                            fields = dict(current_name=rng.choice(users) if users else "missing", new_name=f"U{rng.randrange(64)}")
                            if not users:
                                expected_errors = {"session_user_not_found"}
                            elif fields["new_name"] != fields["current_name"] and fields["new_name"] in users:
                                expected_errors = {"duplicate_session_user"}
                        elif choice in {9, 11}:
                            command = "advance_to_next"
                            generation = before["playback_generation"]
                            stale = choice == 11 and generation > 1
                            fields["expected_playback_generation"] = generation - 1 if stale else generation
                            if stale:
                                expected_errors = {"playback_generation_mismatch"}
                        elif choice == 12 and self.active(before) and users:
                            command = "add_item"
                            payload = dict(rng.choice(self.active(before)))
                            payload["id"] = f"s{seed:03d}{serial:06d}"
                            serial += 1
                            fields = dict(item=payload, requester_name=rng.choice(users), position="tail", reset_av_delay=False, allow_repeat=False)
                            expected_errors = {"duplicate_session_request"}
                        else:
                            command = "resort_playlist_by_cycle"
                        counts[command] += 1
                        try:
                            result = self.command(command, **fields)
                        except rust_runtime.RustAppStateError as error:
                            self.assertIn(error.kind, expected_errors, (seed, step, command))
                            self.assertEqual(self.snapshot(), before)
                            counts[f"rejected:{error.kind}"] += 1
                            continue
                        self.assertFalse(expected_errors, (seed, step, command))
                        after = result["snapshot"]
                        # Account for transitions from the submitted action,
                        # independently of the returned session-play ledger.
                        expected_queue = {entry["id"] for entry in queue}
                        expected_ended = {entry["item_id"] for entry in before["session_played"]
                            if entry["ended_at"] is not None}
                        replaces_current = False
                        if requested_id is not None and before["current_item"]:
                            expected_queue.add(requested_id)
                        elif command == "advance_to_next":
                            if queue:
                                expected_queue.remove(queue[0]["id"])
                            replaces_current = True
                        elif command == "move_to_front" and fields["item_id"] in expected_queue:
                            expected_queue.remove(fields["item_id"])
                            replaces_current = True
                        if replaces_current and before["current_item"]:
                            expected_ended.add(before["current_item"]["id"])
                        self.assertEqual({entry["id"] for entry in after["playlist"]}, expected_queue,
                            (seed, step, command))
                        self.assertEqual({entry["item_id"] for entry in after["session_played"]
                            if entry["ended_at"] is not None}, expected_ended, (seed, step, command))
                        if requested_id is not None:
                            admitted[requested_id] = next(entry for entry in self.active(after) if entry["id"] == requested_id)
                            old_ids = [entry["id"] for entry in queue]
                            if before["current_item"]:
                                new_ids = [entry["id"] for entry in after["playlist"]]
                                if fields["position"] == "next":
                                    self.assertEqual(new_ids, [requested_id] + old_ids)
                                else:
                                    self.assertEqual([item_id for item_id in new_ids if item_id != requested_id], old_ids)
                                    scheduled = self.cycle_schedule(before, admitted[requested_id])
                                    predecessors = set(scheduled[:scheduled.index(requested_id)])
                                    predecessors.update(entry["id"] for entry in queue
                                        if entry["queue_slot_type"] != "cycle" or before["requester_user_ids"].get(entry["id"]) not in {user["id"] for user in before["session_user_entries"]})
                                    expected_index = max((index + 1 for index, item_id in enumerate(old_ids) if item_id in predecessors), default=0)
                                    self.assertEqual(new_ids.index(requested_id), expected_index, (seed, step))
                        self.assert_conserved(after, admitted)
                        if command not in {"advance_to_next", "move_to_front", "add_item"}:
                            self.assertEqual(after["current_item"], before["current_item"])
                            self.assertEqual(after["playback_generation"], before["playback_generation"])
                        if command == "resort_playlist_by_cycle":
                            self.assertTrue(all(entry["queue_slot_type"] == "cycle" for entry in after["playlist"]))
                            for user in before["session_user_entries"]:
                                self.assertEqual([entry["id"] for entry in after["playlist"] if after["requester_user_ids"].get(entry["id"]) == user["id"]],
                                    [entry["id"] for entry in queue if before["requester_user_ids"].get(entry["id"]) == user["id"]], (seed, step, user))
                        if command == "move_to_next" and fields["item_id"] in {entry["id"] for entry in queue}:
                            self.assertEqual(after["playlist"][0]["id"], fields["item_id"])
                            self.assertEqual(after["playlist"][0]["queue_slot_type"], "priority")
                        if command == "move_item_to_index" and fields["item_id"] in {entry["id"] for entry in queue}:
                            target = max(0, min(fields["target_index"], len(queue) - 1))
                            self.assertEqual(after["playlist"][target]["id"], fields["item_id"])
                        if command == "move_session_user_to_index" and users:
                            expected = list(users)
                            expected.remove(fields["name"])
                            expected.insert(max(0, min(fields["target_index"], len(users) - 1)), fields["name"])
                            self.assertEqual(after["session_users"], expected)
                        if command == "rename_session_user":
                            self.assertEqual(after["playlist"], before["playlist"])
                            self.assertEqual(after["requester_user_ids"], before["requester_user_ids"])
                        if result["committed"] and command not in {"add_item", "rename_session_user"}:
                            self.assert_cycle_order(after)
                        if command in {"add_session_user", "remove_session_user", "rename_session_user", "move_session_user_to_index", "resort_playlist_by_cycle"}:
                            for index, entry in enumerate(queue):
                                requester = before["requester_user_ids"].get(entry["id"])
                                fixed = (command != "resort_playlist_by_cycle" and entry["queue_slot_type"] != "cycle") or requester not in {user["id"] for user in after["session_user_entries"]}
                                if fixed:
                                    self.assertEqual(after["playlist"][index]["id"], entry["id"])
        for command in ["move_session_user_to_index", "move_to_next", "add_item", "move_item_to_index", "add_session_user", "remove_session_user", "resort_playlist_by_cycle", "rename_session_user", "advance_to_next", "move_to_front"]:
            self.assertGreater(counts[command], 0)
        self.metrics = {"seeds": len(initial_counts), "initial_user_counts": initial_counts, "operations": sum(counts[key] for key in counts if not key.startswith("rejected:")), "counts": dict(counts)}

    def test_returning_singer_after_three_empty_rounds_gets_the_next_cycle_turn(self):
        with self.session(["A", "B", "C"]):
            self.add("a0", "A")
            for round_ in range(3):
                self.add(f"b{round_}", "B")
                self.add(f"c{round_}", "C")
            for _ in range(6):
                self.command("advance_to_next", expected_playback_generation=self.snapshot()["playback_generation"])
            self.assertFalse(self.snapshot()["playlist"])
            self.add("b-return", "B")
            self.add("a-return", "A")
            self.assertEqual([entry["id"] for entry in self.snapshot()["playlist"]], ["a-return", "b-return"])

    def test_same_name_registration_preserves_but_does_not_adopt_old_waiting_songs(self):
        with self.session(["A", "B", "C"]):
            self.add("a0", "A")
            self.add("b1", "B")
            self.add("c1", "C")
            self.add("b2", "B")
            before = self.snapshot()
            self.command("remove_session_user", name="B")
            orphaned = self.snapshot()
            self.assertEqual(orphaned["playlist"], before["playlist"])
            self.assertEqual(orphaned["current_item"], before["current_item"])
            self.command("add_session_user", name="B")
            self.add("b3", "B")
            self.command("resort_playlist_by_cycle")
            after = self.snapshot()
            self.assertEqual([entry["id"] for entry in after["playlist"]], ["b1", "c1", "b2", "b3"])
            self.assertEqual(after["requester_user_ids"]["b1"], before["requester_user_ids"]["b1"])
            self.assertNotEqual(after["requester_user_ids"]["b1"], after["requester_user_ids"]["b3"])

    def test_zero_and_max_users_and_duplicate_names_reject_without_side_effects(self):
        with self.session([]):
            before = self.snapshot()
            with self.assertRaises(rust_runtime.RustAppStateError) as error:
                self.add("q0", "missing")
            self.assertEqual(error.exception.kind, "session_user_required")
            self.assertEqual(self.snapshot(), before)
            for index in range(32):
                self.command("add_session_user", name=f"U{index}")
            for name, kind in [("U32", "too_many_session_users"), (" U0 ", "duplicate_session_user"), (" \t ", "invalid_session_user")]:
                before = self.snapshot()
                with self.assertRaises(rust_runtime.RustAppStateError) as error:
                    self.command("add_session_user", name=name)
                self.assertEqual(error.exception.kind, kind)
                self.assertEqual(self.snapshot(), before)

    def test_duplicate_requests_across_singers_require_an_explicit_repeat(self):
        with self.session(["A", "B"]):
            self.add("a0", "A", song="same")
            before = self.snapshot()
            with self.assertRaises(rust_runtime.RustAppStateError) as error:
                self.add("b0", "B", song="same")
            self.assertEqual(error.exception.kind, "duplicate_session_request")
            self.assertEqual(self.snapshot(), before)
            self.add("b0", "B", song="same", allow_repeat=True)
            self.assertEqual(self.snapshot()["playlist"][0]["id"], "b0")
            self.assertNotEqual(self.snapshot()["playlist"][0]["item_incarnation_id"], self.snapshot()["current_item"]["item_incarnation_id"])

    def test_unstarted_skips_and_started_history_have_distinct_repeat_rules(self):
        for started in [False, True]:
            with self.subTest(started=started), self.session(["A", "B"]) as store:
                self.add("a0", "A", song="same")
                if started:
                    self.assertTrue(store.mark_item_playback_started("a0"))
                self.command("advance_to_next", expected_playback_generation=self.snapshot()["playback_generation"])
                after = self.snapshot()
                self.assertEqual(after["session_played"][0]["item_id"], "a0")
                self.assertIsNotNone(after["session_played"][0]["ended_at"])
                self.assertEqual(len(after["session_history"]), int(started))
                if started:
                    with self.assertRaises(rust_runtime.RustAppStateError) as error:
                        self.add("b0", "B", song="same")
                    self.assertEqual(error.exception.kind, "duplicate_session_request")
                    self.assertEqual(self.snapshot(), after)
                else:
                    self.add("b0", "B", song="same")
                    self.assertEqual(self.snapshot()["current_item"]["id"], "b0")

    def test_missing_targets_duplicate_ids_and_clamped_positions_preserve_other_songs(self):
        with self.session(["A", "B", "C"]):
            self.add("a0", "A")
            for item_id, user in [("a1", "A"), ("b1", "B"), ("c1", "C")]:
                self.add(item_id, user)
            before = self.snapshot()
            for command, fields in [
                ("move_to_next", {"item_id": "missing"}),
                ("move_item_to_index", {"item_id": "missing", "target_index": 1}),
                ("move_session_user_to_index", {"name": "missing", "target_index": 1}),
            ]:
                if command == "move_session_user_to_index":
                    self.assertFalse(self.command(command, **fields)["committed"])
                else:
                    with self.assertRaises(rust_runtime.RustAppStateError) as error:
                        self.command(command, **fields)
                    self.assertEqual(error.exception.kind, "queue_item_missing")
                self.assertEqual(self.snapshot(), before)
            with self.assertRaises(rust_runtime.RustAppStateError) as error:
                self.add("b1", "C", song="different", allow_repeat=True)
            self.assertEqual(error.exception.kind, "duplicate_item_id")
            self.assertEqual(self.snapshot(), before)
            self.command("move_item_to_index", item_id="a1", target_index=-999)
            self.assertEqual(self.snapshot()["playlist"][0]["id"], "a1")
            self.command("move_item_to_index", item_id="b1", target_index=999)
            self.assertEqual(self.snapshot()["playlist"][-1]["id"], "b1")
            self.command("move_to_next", item_id="b1")
            topped = self.snapshot()
            unchanged = self.command("move_item_to_index", item_id="b1", target_index=0)
            self.assertFalse(unchanged["committed"])
            self.assertEqual(unchanged["snapshot"], topped)
            self.assertEqual(topped["playlist"][0]["queue_slot_type"], "priority")
            self.assertEqual({entry["id"] for entry in topped["playlist"]}, {"a1", "b1", "c1"})
            self.assertEqual(topped["current_item"], before["current_item"])

    def test_drag_guard_ignores_metadata_but_rejects_queue_changes_and_readmissions(self):
        with self.session(["A", "B"]) as store:
            for name, singer in [("a0", "A"), ("a1", "A"), ("b1", "B")]:
                self.add(name, singer)
            original = self.snapshot()
            version = original["queue_version"]
            store.set_volume_percent(57)
            store.update_item("a1", title="Metadata changed")
            token = store.begin_cache_attempt("a1", store.get_item("a1").item_incarnation_id)
            store.apply_cache_event("a1", cache_attempt_token=token, event={"kind": "queued", "message": "Caching"})
            self.assertEqual(self.snapshot()["queue_version"], version)
            same_index = next(i for i, song in enumerate(original["playlist"]) if song["id"] == "a1")
            result = self.command("move_item_to_index", item_id="a1", target_index=same_index, expected_queue_version=version)
            self.assertFalse(result["committed"])
            self.command("move_to_next", item_id="a1")
            changed = self.snapshot()
            self.assertNotEqual(changed["queue_version"], version)
            with self.assertRaises(rust_runtime.RustAppStateError) as error:
                self.command("move_item_to_index", item_id="b1", target_index=0, expected_queue_version=version)
            self.assertEqual(error.exception.kind, "queue_changed")
            self.assertEqual(self.snapshot(), changed)
            for command in ["move_to_next", "move_item_to_index", "move_to_front"]:
                with self.assertRaises(rust_runtime.RustAppStateError) as error:
                    self.command(command, item_id="a0", **({"target_index": 0} if command == "move_item_to_index" else {}))
                self.assertEqual(error.exception.kind, "queue_item_missing")
            store.remove_item("a1")
            self.add("a1", "A")
            self.assertNotEqual(self.snapshot()["queue_version"], changed["queue_version"])

    def test_public_full_queue_and_guard_survive_progress_and_reject_stale_intents(self):
        with self.session(["A"]):
            seed = dict(session_users=["A"], session_started_at=1.0,
                session_played_file="public.json", updated_at=1.0,
                history=[dict(key=f"h{i}:p1", display_title=f"Song {i}", original_url="", resolved_url="", requested_at=1.0) for i in range(1001)],
                playlist=[asdict(item(f"p{index:09d}")) for index in range(10000)])
            rust_runtime.app_state_request("initialize", state=seed)
            public = rust_runtime.app_state_request("internet_remote_state")["result"]["remote_state"]
            self.assertEqual(len(public["playlist"]), 10000)
            self.assertEqual(len(public["history"]), 1001)
            self.assertEqual([song["id"] for song in public["playlist"]], [song["id"] for song in self.snapshot()["playlist"]])
            rust_runtime.app_state_request("open_internet_remote_peer", peer_id="guard-test", epoch="abcdefghijklmnopqrstuv", profile="controller")
            seq = 0
            def send(kind, **body):
                nonlocal seq
                seq += 1
                return self.command("dispatch_internet_remote_message", peer_id="guard-test", lane="control", message=json.dumps(dict(v=1,
                    lane="control", epoch="abcdefghijklmnopqrstuv", seq=seq, id=str(uuid.uuid4()), kind=kind, body=body)))["result"]
            send("session.set_identity", name="A")
            before = self.snapshot()
            self.command("set_muted", is_muted=True)
            # The revision is old solely because of a player setting; queue token is still valid.
            moved = send("playlist.move", item_id="p000000000", target_index=9999,
                expected_revision=before["revision"], expected_queue_version=before["queue_version"])
            self.assertTrue(moved["accepted"])
            self.assertEqual(moved["data"]["playlist"][-1]["id"], "p000000000")
            self.assertEqual(len(moved["data"]["playlist"]), 10000)
            stale = send("playlist.move", item_id="p000000001", target_index=9998,
                expected_revision=self.snapshot()["revision"], expected_queue_version=before["queue_version"])
            self.assertFalse(stale["accepted"])
            self.assertEqual(stale["code"], "queue_changed")
            after = self.snapshot()
            with self.assertRaises(rust_runtime.RustAppStateError) as error:
                send("playlist.move_next", item_id="missing", expected_revision=after["revision"])
            self.assertEqual(error.exception.kind, "queue_item_missing")
            self.assertEqual(self.snapshot(), after)

    def test_backup_restore_preserves_roster_order_item_ids_and_fixed_markers(self):
        with TemporaryDirectory(prefix="playlist-lifecycle-restart-") as directory:
            root = Path(directory)
            paths = (root / "state.json", root / "backup.json", root / "sessions")
            store = PlaylistStore(*paths)
            try:
                for user in ["A", "B", "C"]:
                    store.add_session_user(user)
                for item_id, user in [("a0", "A"), ("a1", "A"), ("b1", "B"), ("c1", "C")]:
                    store.add_item(item(item_id), requester_name=user)
                store.move_to_next("c1")
                store.move_item_to_index("a1", 1)
                store.move_session_user_to_index("C", 0)
                store.remove_session_user("B")
                expected = store.authoritative_snapshot()
            finally:
                store.shutdown()
            restarted = PlaylistStore(*paths)
            try:
                self.assertTrue(restarted.restore_backup())
                after = restarted.authoritative_snapshot()
                self.assertEqual(after["session_users"], expected["session_users"])
                self.assertEqual(after["current_item"]["id"], expected["current_item"]["id"])
                self.assertEqual([(entry["id"], entry["requester_name"], entry["queue_slot_type"]) for entry in after["playlist"]],
                    [(entry["id"], entry["requester_name"], entry["queue_slot_type"]) for entry in expected["playlist"]])
                self.assertNotEqual(after["current_item"]["item_incarnation_id"], expected["current_item"]["item_incarnation_id"])
            finally:
                restarted.shutdown()

    def test_capacity_includes_current_and_concurrent_callers_share_the_last_slot(self):
        with self.session(["A"]):
            seed = dict(session_users=["A"], session_started_at=1.0,
                session_played_file="capacity.json", updated_at=1.0,
                current_item=asdict(item("p000000000")),
                playlist=[asdict(item(f"p{index:09d}")) for index in range(1, 9999)])
            rust_runtime.app_state_request("initialize", state=seed)
            before = self.snapshot()
            barrier = threading.Barrier(8)

            def admit(worker):
                barrier.wait(timeout=10)
                try:
                    self.add(f"e{worker:09d}", "A", position="next" if worker % 2 else "tail")
                    return True
                except rust_runtime.RustAppStateError as error:
                    self.assertEqual(error.kind, "too_many_items")
                    return False

            with ThreadPoolExecutor(max_workers=8) as pool:
                self.assertEqual(sum(pool.map(admit, range(8))), 1)
            full = self.snapshot()
            self.assertEqual(len(self.active(full)), 10000)
            self.assertEqual(len({entry["id"] for entry in self.active(full)}), 10000)
            self.assertEqual(full["revision"], before["revision"] + 1)
            self.assertEqual(full["current_item"], before["current_item"])
            for position in ["tail", "next"]:
                with self.assertRaises(rust_runtime.RustAppStateError) as error:
                    self.add("overflow", "A", position=position, allow_repeat=True)
                self.assertEqual(error.exception.kind, "too_many_items")
                self.assertEqual(self.snapshot(), full)

    def test_concurrent_roster_requests_reorders_and_next_conserve_every_admission(self):
        rng = Random(self.CONCURRENT_SEED)
        initial_count = rng.randrange(1, 33)
        with self.session([f"U{index}" for index in range(initial_count)]):
            admitted = set()
            for index in range(17):
                item_id = f"p{index:09d}"
                self.add(item_id, f"U{index % initial_count}")
                admitted.add(item_id)
            barrier = threading.Barrier(8)
            counts = Counter()
            lock = threading.Lock()

            def worker(worker_id):
                random = Random(701_200 + worker_id)
                successes = set()
                events = Counter()
                barrier.wait(timeout=10)
                for step in range(96):
                    before = self.snapshot()
                    users, queue = before["session_users"], before["playlist"]
                    choice = random.randrange(8)
                    name = f"U{random.randrange(40)}"
                    command = ["add_session_user", "remove_session_user", "move_session_user_to_index", "move_to_next", "move_item_to_index", "resort_playlist_by_cycle", "add_item", "advance_to_next"][choice]
                    fields = {}
                    if choice < 3:
                        fields["name"] = name
                        if choice == 2:
                            fields["target_index"] = random.randrange(-2, 34)
                    elif choice in {3, 4}:
                        fields["item_id"] = random.choice(queue)["id"] if queue else "missing"
                        if choice == 4:
                            fields["target_index"] = random.randrange(-2, len(queue) + 3)
                    elif choice == 6:
                        item_id = f"c{worker_id:02d}{step:07d}"
                        fields = dict(item=asdict(item(item_id)), requester_name=random.choice(users) if users else name,
                            position=random.choice(["tail", "next"]), reset_av_delay=False, allow_repeat=False)
                    elif choice == 7:
                        fields["expected_playback_generation"] = before["playback_generation"]
                    events[command] += 1
                    try:
                        response = self.command(command, **fields)
                    except rust_runtime.RustAppStateError as error:
                        self.assertIn(error.kind, {"duplicate_session_user", "too_many_session_users", "session_user_required", "session_user_not_found", "playback_generation_mismatch", "queue_item_missing"})
                        events[f"rejected:{error.kind}"] += 1
                        continue
                    if choice == 6:
                        successes.add(item_id)
                    snapshot = response["snapshot"]
                    active = [entry["id"] for entry in self.active(snapshot)]
                    ended = [entry["item_id"] for entry in snapshot["session_played"] if entry["ended_at"] is not None]
                    self.assertEqual(len(active), len(set(active)))
                    self.assertEqual(len(ended), len(set(ended)))
                    self.assertFalse(set(active) & set(ended))
                    if response["committed"] and choice != 6:
                        self.assert_cycle_order(snapshot)
                with lock:
                    counts.update(events)
                return successes

            with ThreadPoolExecutor(max_workers=8) as pool:
                for successes in pool.map(worker, range(8)):
                    admitted.update(successes)
            final = self.snapshot()
            active = {entry["id"] for entry in self.active(final)}
            ended = {entry["item_id"] for entry in final["session_played"] if entry["ended_at"] is not None}
            self.assertEqual(active | ended, admitted)
            self.assertFalse(active & ended)
            self.concurrent_metrics = {"initial_users": initial_count, "callers": 8, "operations": 768, "admitted_items": len(admitted), "counts": dict(counts)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Replay native playlist lifecycle stress tests")
    parser.add_argument("--stress", action="store_true")
    parser.add_argument("--seeds", type=int, default=100)
    parser.add_argument("--steps", type=int, default=500)
    parser.add_argument("--concurrent-sessions", type=int, default=8)
    args, unittest_args = parser.parse_known_args()
    if not args.stress:
        unittest.main(argv=[__file__, *unittest_args])
    else:
        if not 1 <= args.seeds <= 1000 or args.steps < 1 or args.concurrent_sessions < 1:
            parser.error("seeds must be 1–1000; steps and concurrent-sessions must be positive")
        model = PlaylistLifecycleStressTest("test_random_user_lifecycle_and_ordering_state_machine")
        model.RANDOM_SEEDS = range(args.seeds)
        model.RANDOM_STEPS = args.steps
        concurrent = []
        for seed in range(args.concurrent_sessions):
            case = PlaylistLifecycleStressTest("test_concurrent_roster_requests_reorders_and_next_conserve_every_admission")
            case.CONCURRENT_SEED = 113 + seed * 7919
            concurrent.append(case)
        result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([model, *concurrent]))
        print(json.dumps({"passed": result.wasSuccessful(), "random": getattr(model, "metrics", None),
            "concurrent": [getattr(case, "concurrent_metrics", None) for case in concurrent]}, ensure_ascii=False))
        raise SystemExit(not result.wasSuccessful())
