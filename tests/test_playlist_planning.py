from __future__ import annotations

import ctypes
import itertools
import json
import os
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.store import (
    DuplicateActiveItem,
    DuplicateHistoryEntry,
    MAX_PLAYLIST_HISTORY_KEY_BYTES,
    PlaylistDuplicateDecision,
    PlaylistDuplicateRequest,
    PlaylistIdentity,
    PlaylistOrderItem,
    PlaylistOrderPlan,
    PlaylistOrderRequest,
    _py_decide_playlist_duplicate,
    _py_plan_playlist_order,
    _py_playlist_identity_key,
)


def order_item(
    index: int,
    item_id: str,
    requester: str = "",
    slot: str = "cycle",
) -> PlaylistOrderItem:
    return PlaylistOrderItem(index, item_id, requester, slot)


def order_request(
    items: tuple[PlaylistOrderItem, ...] = (),
    *,
    operation: str = "rebuild",
    users: tuple[str, ...] = ("A", "B", "C"),
    current: str | None = None,
    candidate: PlaylistOrderItem | None = None,
) -> PlaylistOrderRequest:
    return PlaylistOrderRequest(operation, users, current, items, candidate)


def identity(
    bvid: str = "BV1",
    aid: int = 1,
    page: int = 1,
    audio: tuple[int, ...] = (),
) -> PlaylistIdentity:
    return PlaylistIdentity(bvid, aid, page, audio)


def active(index: int, item_id: str, value: PlaylistIdentity) -> DuplicateActiveItem:
    return DuplicateActiveItem(index, item_id, value)


class PythonPlaylistOrderingPolicyTest(unittest.TestCase):
    def test_empty_users_and_items(self):
        self.assertEqual(
            _py_plan_playlist_order(order_request(users=())),
            PlaylistOrderPlan(()),
        )
        items = (order_item(0, "a", "A"), order_item(1, "fixed", "", "manual"))
        self.assertEqual(
            _py_plan_playlist_order(order_request(items, users=())).ordered_ids,
            ("a", "fixed"),
        )

    def test_current_rotation_and_unregistered_current(self):
        items = (
            order_item(0, "a", "A"),
            order_item(1, "b", "B"),
            order_item(2, "c", "C"),
            order_item(3, "d", "D"),
        )
        users = ("A", "B", "C", "D")
        self.assertEqual(
            _py_plan_playlist_order(order_request(items, users=users, current="B")).ordered_ids,
            ("c", "d", "a", "b"),
        )
        for current in (None, "", "X"):
            with self.subTest(current=current):
                self.assertEqual(
                    _py_plan_playlist_order(
                        order_request(items, users=users, current=current)
                    ).ordered_ids,
                    ("a", "b", "c", "d"),
                )

    def test_multiple_rounds_uneven_counts_and_reordered_users(self):
        items = (
            order_item(0, "a2", "A"),
            order_item(1, "b2", "B"),
            order_item(2, "a1", "A"),
            order_item(3, "c1", "C"),
            order_item(4, "b1", "B"),
            order_item(5, "a3", "A"),
        )
        plan = _py_plan_playlist_order(
            order_request(items, users=("A", "C", "B"), current="A")
        )
        self.assertEqual(plan.ordered_ids, ("c1", "b2", "a2", "b1", "a1", "a3"))

    def test_fixed_priority_manual_and_unregistered_cycle_positions(self):
        items = (
            order_item(0, "a2", "A"),
            order_item(1, "priority", "B", "priority"),
            order_item(2, "unknown", "X"),
            order_item(3, "c1", "C"),
            order_item(4, "b1", "B"),
            order_item(5, "manual", "A", "manual"),
            order_item(6, "a1", "A"),
        )
        plan = _py_plan_playlist_order(order_request(items, current="A"))
        self.assertEqual(
            plan.ordered_ids,
            ("b1", "priority", "unknown", "c1", "a2", "manual", "a1"),
        )

    def test_stable_original_index_tie_and_determinism(self):
        items = (
            order_item(8, "b", "B"),
            order_item(3, "a", "A"),
            order_item(5, "c", "C"),
        )
        case = order_request(items)
        expected = _py_plan_playlist_order(case)
        self.assertEqual(expected.ordered_ids, ("a", "b", "c"))
        for _ in range(100):
            self.assertEqual(_py_plan_playlist_order(case), expected)

    def test_insert_empty_known_next_round_and_unknown(self):
        empty = order_request(
            operation="insert_cycle",
            candidate=order_item(0, "a", "A"),
        )
        self.assertEqual(_py_plan_playlist_order(empty).ordered_ids, ("a",))

        items = (
            order_item(0, "priority", "A", "priority"),
            order_item(1, "b1", "B"),
            order_item(2, "c1", "C"),
            order_item(3, "a1", "A"),
        )
        known = order_request(
            items,
            operation="insert_cycle",
            current="A",
            candidate=order_item(4, "b2", "B"),
        )
        self.assertEqual(
            _py_plan_playlist_order(known).ordered_ids,
            ("priority", "b1", "c1", "a1", "b2"),
        )
        unknown = replace(known, candidate=order_item(4, "x", "X"))
        self.assertEqual(_py_plan_playlist_order(unknown).ordered_ids[-1], "x")

    def test_rejects_duplicate_users_ids_indices_slots_and_relationships(self):
        invalid = (
            order_request(users=("A", "A")),
            order_request(users=tuple(f"user-{index}" for index in range(33))),
            order_request((order_item(0, "x" * 513),)),
            order_request((order_item(0, "a"), order_item(1, "a"))),
            order_request((order_item(0, "a"), order_item(0, "b"))),
            order_request((order_item(0, "a", slot="bad"),)),
            order_request(candidate=order_item(0, "a")),
            order_request(operation="insert_cycle"),
            order_request(
                (order_item(0, "a"),),
                operation="insert_cycle",
                candidate=order_item(1, "a"),
            ),
            order_request(
                operation="insert_cycle",
                candidate=order_item(0, "a", slot="manual"),
            ),
        )
        for case in invalid:
            with self.subTest(case=case), self.assertRaises(ValueError):
                _py_plan_playlist_order(case)

    def test_generated_permutations_conserve_ids_and_fixed_positions(self):
        base = (
            order_item(0, "a", "A"),
            order_item(1, "b", "B"),
            order_item(2, "c", "C"),
            order_item(3, "fixed", "A", "manual"),
        )
        for permutation in itertools.permutations(base):
            normalized = tuple(replace(item, original_index=index) for index, item in enumerate(permutation))
            plan = _py_plan_playlist_order(order_request(normalized, current="B"))
            self.assertCountEqual(plan.ordered_ids, [item.item_id for item in normalized])
            fixed_index = next(index for index, item in enumerate(normalized) if item.item_id == "fixed")
            self.assertEqual(plan.ordered_ids[fixed_index], "fixed")


class PythonPlaylistDuplicatePolicyTest(unittest.TestCase):
    def test_identity_bvid_aid_video_and_audio_boundaries(self):
        self.assertEqual(_py_playlist_identity_key(identity("BVCase", 9, 2)), "BVCase:p2")
        self.assertEqual(_py_playlist_identity_key(identity("", 9, 2)), "aid:9:p2")
        self.assertNotEqual(
            _py_playlist_identity_key(identity("BV", 1, 1)),
            _py_playlist_identity_key(identity("BV", 1, 2)),
        )
        self.assertEqual(
            _py_playlist_identity_key(identity("BV", audio=(2, 0, -1, 1, 2))),
            "BV:p1:a2-1-2",
        )
        for invalid in (
            identity("BV", aid=-1),
            identity("BV", page=0),
            identity("x" * 513),
            identity("BV", audio=tuple([1] * 257)),
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                _py_playlist_identity_key(invalid)

    def test_active_precedence_and_no_match(self):
        candidate = identity("BV", audio=(1, 2))
        request = PlaylistDuplicateRequest(
            candidate,
            current_item=active(0, "current", candidate),
            queued_items=(active(1, "first", candidate), active(2, "second", candidate)),
        )
        self.assertEqual(
            _py_decide_playlist_duplicate(request).active_duplicate_id,
            "current",
        )
        queued_only = replace(request, current_item=None)
        self.assertEqual(
            _py_decide_playlist_duplicate(queued_only).active_duplicate_id,
            "first",
        )
        different = replace(
            queued_only,
            queued_items=(active(1, "different", identity("BV", audio=(2, 1))),),
        )
        self.assertIsNone(_py_decide_playlist_duplicate(different).active_duplicate_id)

    def test_history_first_match_and_determinism(self):
        candidate = identity("BV", audio=(1, 1))
        key = _py_playlist_identity_key(candidate)
        request = PlaylistDuplicateRequest(
            candidate,
            history_entries=(
                DuplicateHistoryEntry(7, key),
                DuplicateHistoryEntry(3, key),
            ),
        )
        expected = PlaylistDuplicateDecision(key, None, 7)
        for _ in range(100):
            self.assertEqual(_py_decide_playlist_duplicate(request), expected)
        no_match = replace(
            request,
            history_entries=(
                DuplicateHistoryEntry(0, ""),
                DuplicateHistoryEntry(1, "other"),
            ),
        )
        self.assertIsNone(_py_decide_playlist_duplicate(no_match).history_duplicate_index)

    def test_maximum_legal_identity_key_is_accepted_as_history(self):
        size_t_max = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
        maximum = identity(
            "B" * 512,
            2**64 - 1,
            size_t_max,
            (2**63 - 1,) * 256,
        )
        key = _py_playlist_identity_key(maximum)
        self.assertLessEqual(len(key.encode("utf-8")), MAX_PLAYLIST_HISTORY_KEY_BYTES)
        decision = _py_decide_playlist_duplicate(
            PlaylistDuplicateRequest(
                maximum,
                history_entries=(DuplicateHistoryEntry(7, key),),
            )
        )
        self.assertEqual(decision.identity_key, key)
        self.assertEqual(decision.history_duplicate_index, 7)

        for invalid_key in ("x" * 8193, "valid\x00invalid", 123):
            with self.subTest(invalid_key=repr(invalid_key)), self.assertRaises(ValueError):
                _py_decide_playlist_duplicate(
                    PlaylistDuplicateRequest(
                        maximum,
                        history_entries=(DuplicateHistoryEntry(0, invalid_key),),
                    )
                )


def order_wire(case: PlaylistOrderRequest) -> dict[str, object]:
    def item(value: PlaylistOrderItem) -> dict[str, object]:
        return {
            "original_index": value.original_index,
            "item_id": value.item_id,
            "requester_name": value.requester_name,
            "slot_type": value.slot_type,
        }

    return {
        "schema_version": 1,
        "operation": case.operation,
        "session_users": list(case.session_users),
        "current_requester": case.current_requester,
        "items": [item(value) for value in case.items],
        "candidate": item(case.candidate) if case.candidate else None,
    }


def duplicate_wire(case: PlaylistDuplicateRequest) -> dict[str, object]:
    def identity_payload(value: PlaylistIdentity) -> dict[str, object]:
        return {
            "bvid": value.bvid,
            "aid": value.aid,
            "video_page": value.video_page,
            "selected_audio_pages": list(value.selected_audio_pages),
        }

    def active_payload(value: DuplicateActiveItem) -> dict[str, object]:
        return {
            "original_index": value.original_index,
            "item_id": value.item_id,
            "identity": identity_payload(value.identity),
        }

    return {
        "schema_version": 1,
        "candidate": identity_payload(case.candidate),
        "current_item": active_payload(case.current_item) if case.current_item else None,
        "queued_items": [active_payload(value) for value in case.queued_items],
        "history_entries": [
            {"original_index": value.original_index, "key": value.key}
            for value in case.history_entries
        ],
    }


class PlaylistPlanningBackendTest(unittest.TestCase):
    def call_order(self, payload: object, response: object):
        library = SimpleNamespace(rust_plan_playlist_order=lambda _payload: 1)
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_playlist_order": True}
        ), patch.object(
            rust_backend,
            "_read_rust_string",
            return_value=response if isinstance(response, str) else json.dumps(response),
        ):
            return rust_backend.try_plan_playlist_order(payload)

    def call_duplicate(self, payload: object, response: object):
        library = SimpleNamespace(rust_decide_playlist_duplicate=lambda _payload: 1)
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"decide_playlist_duplicate": True}
        ), patch.object(
            rust_backend,
            "_read_rust_string",
            return_value=response if isinstance(response, str) else json.dumps(response),
        ):
            return rust_backend.try_decide_playlist_duplicate(payload)

    def test_successful_exact_native_results(self):
        order_case = order_request(
            (order_item(0, "b", "B"), order_item(1, "a", "A"))
        )
        order_response = {
            "schema_version": 1,
            "ordered_ids": list(_py_plan_playlist_order(order_case).ordered_ids),
        }
        self.assertEqual(
            self.call_order(order_wire(order_case), order_response),
            (True, order_response),
        )
        duplicate_case = PlaylistDuplicateRequest(
            identity("BV"),
            queued_items=(active(0, "queued", identity("BV")),),
        )
        decision = _py_decide_playlist_duplicate(duplicate_case)
        duplicate_response = {
            "schema_version": 1,
            "identity_key": decision.identity_key,
            "active_duplicate_id": decision.active_duplicate_id,
            "history_duplicate_index": decision.history_duplicate_index,
        }
        self.assertEqual(
            self.call_duplicate(duplicate_wire(duplicate_case), duplicate_response),
            (True, duplicate_response),
        )

    def test_missing_library_symbol_exception_null_and_malformed_fall_back(self):
        order_case = order_wire(order_request())
        duplicate_case = duplicate_wire(PlaylistDuplicateRequest(identity()))
        with patch.object(rust_backend, "_rust_lib", None):
            self.assertEqual(rust_backend.try_plan_playlist_order(order_case), (False, None))
            self.assertEqual(
                rust_backend.try_decide_playlist_duplicate(duplicate_case),
                (False, None),
            )
        with patch.object(rust_backend, "_rust_lib", SimpleNamespace()), patch.object(
            rust_backend, "_CAPABILITIES", {}
        ):
            self.assertEqual(rust_backend.try_plan_playlist_order(order_case), (False, None))
            self.assertEqual(
                rust_backend.try_decide_playlist_duplicate(duplicate_case),
                (False, None),
            )
        order_library = SimpleNamespace(
            rust_plan_playlist_order=lambda _payload: (_ for _ in ()).throw(RuntimeError())
        )
        with patch.object(rust_backend, "_rust_lib", order_library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_playlist_order": True}
        ):
            self.assertEqual(rust_backend.try_plan_playlist_order(order_case), (False, None))
        self.assertEqual(self.call_order(order_case, "not json"), (False, None))
        self.assertEqual(self.call_duplicate(duplicate_case, "null"), (False, None))
        order_library = SimpleNamespace(rust_plan_playlist_order=lambda _payload: 0)
        with patch.object(rust_backend, "_rust_lib", order_library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_playlist_order": True}
        ), patch.object(rust_backend, "_read_rust_string", return_value=None):
            self.assertEqual(rust_backend.try_plan_playlist_order(order_case), (False, None))
        duplicate_library = SimpleNamespace(rust_decide_playlist_duplicate=lambda _payload: 0)
        with patch.object(rust_backend, "_rust_lib", duplicate_library), patch.object(
            rust_backend, "_CAPABILITIES", {"decide_playlist_duplicate": True}
        ), patch.object(rust_backend, "_read_rust_string", return_value=None):
            self.assertEqual(
                rust_backend.try_decide_playlist_duplicate(duplicate_case),
                (False, None),
            )

    def test_order_request_and_response_validation(self):
        case = order_request(
            (order_item(0, "b", "B"), order_item(1, "a", "A"))
        )
        payload = order_wire(case)
        expected = {"schema_version": 1, "ordered_ids": ["a", "b"]}
        invalid_requests = [
            {**payload, "unknown": 1},
            {**payload, "schema_version": True},
            {**payload, "operation": "bad"},
            {**payload, "session_users": ["A", "A"]},
            {**payload, "session_users": [f"user-{index}" for index in range(33)]},
            {**payload, "items": [{**payload["items"][0], "original_index": True}]},
            {**payload, "items": [{**payload["items"][0], "item_id": "x" * 513}]},
            {**payload, "items": [payload["items"][0], {**payload["items"][0], "original_index": 2}]},
            {**payload, "candidate": order_wire(order_request())["candidate"] or {"bad": 1}},
        ]
        for invalid in invalid_requests:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.call_order(invalid, expected), (False, None))
        invalid_responses = [
            {**expected, "unknown": 1},
            {**expected, "schema_version": 2},
            {**expected, "ordered_ids": ["a"]},
            {**expected, "ordered_ids": ["a", "a"]},
            {**expected, "ordered_ids": ["a", "invented"]},
            {**expected, "ordered_ids": ["b", "a"]},
        ]
        for response in invalid_responses:
            with self.subTest(response=response):
                self.assertEqual(self.call_order(payload, response), (False, None))

    def test_duplicate_request_and_response_validation(self):
        candidate = identity("BV", audio=(1, 2))
        case = PlaylistDuplicateRequest(
            candidate,
            current_item=active(0, "current", candidate),
            history_entries=(DuplicateHistoryEntry(4, _py_playlist_identity_key(candidate)),),
        )
        payload = duplicate_wire(case)
        expected = {
            "schema_version": 1,
            "identity_key": "BV:p1:a1-2",
            "active_duplicate_id": "current",
            "history_duplicate_index": 4,
        }
        invalid_requests = [
            {**payload, "unknown": 1},
            {**payload, "schema_version": True},
            {**payload, "candidate": {**payload["candidate"], "aid": True}},
            {**payload, "candidate": {**payload["candidate"], "video_page": -1}},
            {
                **payload,
                "candidate": {
                    **payload["candidate"],
                    "selected_audio_pages": [1] * 257,
                },
            },
            {**payload, "queued_items": [payload["current_item"]]},
            {**payload, "history_entries": [payload["history_entries"][0]] * 2},
        ]
        for invalid in invalid_requests:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.call_duplicate(invalid, expected), (False, None))
        invalid_responses = [
            {**expected, "unknown": 1},
            {**expected, "schema_version": 2},
            {**expected, "identity_key": "wrong"},
            {**expected, "active_duplicate_id": "invented"},
            {**expected, "active_duplicate_id": None},
            {**expected, "history_duplicate_index": 99},
            {**expected, "history_duplicate_index": None},
        ]
        for response in invalid_responses:
            with self.subTest(response=response):
                self.assertEqual(self.call_duplicate(payload, response), (False, None))

    def test_real_native_generated_equivalence(self):
        status = rust_backend.backend_status()
        required = ("plan_playlist_order", "decide_playlist_duplicate")
        if not all(status["capabilities"].get(name) for name in required):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail("strict native mode requires both playlist planning capabilities")
            self.skipTest("native playlist planners are unavailable")

        base = (
            order_item(0, "a", "A"),
            order_item(1, "b", "B"),
            order_item(2, "c", "C"),
        )
        for permutation in itertools.permutations(base):
            items = tuple(replace(value, original_index=index) for index, value in enumerate(permutation))
            for current in (None, "A", "B", "X"):
                case = order_request(items, current=current)
                completed, response = rust_backend.try_plan_playlist_order(order_wire(case))
                self.assertTrue(completed)
                self.assertEqual(response["ordered_ids"], list(_py_plan_playlist_order(case).ordered_ids))

        for bvid in ("", "BVCase"):
            for page in (1, 2):
                for audio_pages in ((), (1,), (2, 1), (1, 1), (0, -1, 2)):
                    candidate = identity(bvid, 42, page, audio_pages)
                    key = _py_playlist_identity_key(candidate)
                    case = PlaylistDuplicateRequest(
                        candidate,
                        queued_items=(active(0, "queued", candidate),),
                        history_entries=(DuplicateHistoryEntry(3, key),),
                    )
                    completed, response = rust_backend.try_decide_playlist_duplicate(
                        duplicate_wire(case)
                    )
                    self.assertTrue(completed)
                    expected = _py_decide_playlist_duplicate(case)
                    self.assertEqual(
                        response,
                        {
                            "schema_version": 1,
                            "identity_key": expected.identity_key,
                            "active_duplicate_id": expected.active_duplicate_id,
                            "history_duplicate_index": expected.history_duplicate_index,
                        },
                    )

        size_t_max = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
        maximum = identity(
            "B" * 512,
            2**64 - 1,
            size_t_max,
            (2**63 - 1,) * 256,
        )
        maximum_key = _py_playlist_identity_key(maximum)
        maximum_case = PlaylistDuplicateRequest(
            maximum,
            history_entries=(DuplicateHistoryEntry(9, maximum_key),),
        )
        completed, response = rust_backend.try_decide_playlist_duplicate(
            duplicate_wire(maximum_case)
        )
        self.assertTrue(completed)
        self.assertEqual(response["identity_key"], maximum_key)
        self.assertEqual(response["history_duplicate_index"], 9)

        oversized = duplicate_wire(maximum_case)
        oversized["history_entries"] = [{"original_index": 0, "key": "x" * 8193}]
        self.assertEqual(
            rust_backend.try_decide_playlist_duplicate(oversized),
            (False, None),
        )


if __name__ == "__main__":
    unittest.main()
