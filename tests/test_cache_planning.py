from __future__ import annotations

import itertools
import json
import os
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.cache import (
    CachePlan,
    CachePlanItem,
    CachePlanRequest,
    _py_plan_cache_window,
)


def item(index: int, item_id: str, ready: bool = False) -> CachePlanItem:
    return CachePlanItem(index, item_id, ready)


def request(
    items: tuple[CachePlanItem, ...],
    max_items: int,
    retention_limit: int = 3,
    *,
    active: tuple[str, ...] = (),
    primary: str | None = None,
    urgent: tuple[str, ...] = (),
) -> CachePlanRequest:
    return CachePlanRequest(
        items=items,
        max_items=max_items,
        retention_limit=retention_limit,
        active_item_ids=active,
        primary_active_item_id=primary,
        urgent_item_ids=urgent,
    )


class PythonCachePlanningPolicyTest(unittest.TestCase):
    def test_empty_and_zero_limit(self):
        empty = CachePlan((), (), (), ())
        self.assertEqual(_py_plan_cache_window(request((), 3)), empty)
        self.assertEqual(
            _py_plan_cache_window(request((item(0, "a", True),), 0, 3)),
            empty,
        )

    def test_limits_below_equal_and_above_count(self):
        items = (item(0, "a"), item(1, "b"), item(2, "c"))
        self.assertEqual(_py_plan_cache_window(request(items, 2)).desired_ids, ("a", "b"))
        self.assertEqual(_py_plan_cache_window(request(items, 3)).desired_ids, ("a", "b", "c"))
        self.assertEqual(_py_plan_cache_window(request(items, 9)).desired_ids, ("a", "b", "c"))

    def test_all_none_and_mixed_ready_pending_order(self):
        all_ready = (item(0, "a", True), item(1, "b", True))
        none_ready = (item(0, "a"), item(1, "b"))
        mixed = (item(0, "a", True), item(1, "b"), item(2, "c", True), item(3, "d"))
        self.assertEqual(_py_plan_cache_window(request(all_ready, 2)).pending_order, ())
        self.assertEqual(_py_plan_cache_window(request(none_ready, 2)).pending_order, ("a", "b"))
        self.assertEqual(_py_plan_cache_window(request(mixed, 4)).pending_order, ("b", "d"))

    def test_retention_zero_below_and_above_available(self):
        items = (
            item(0, "inside-ready", True),
            item(1, "inside-pending"),
            item(2, "outside-pending"),
            item(3, "outside-ready-1", True),
            item(4, "outside-ready-2", True),
        )
        self.assertEqual(
            _py_plan_cache_window(request(items, 2, 0)).retained_ids,
            ("inside-ready", "inside-pending"),
        )
        self.assertEqual(
            _py_plan_cache_window(request(items, 2, 1)).retained_ids,
            ("inside-ready", "inside-pending", "outside-ready-1"),
        )
        self.assertEqual(
            _py_plan_cache_window(request(items, 2, 9)).retained_ids,
            ("inside-ready", "inside-pending", "outside-ready-1", "outside-ready-2"),
        )

    def test_reordered_input_uses_explicit_sequence(self):
        items = (item(8, "c"), item(3, "a"), item(5, "b"))
        plan = _py_plan_cache_window(request(items, 2))
        self.assertEqual(plan.desired_ids, ("c", "a"))
        self.assertEqual(plan.pending_order, ("c", "a"))

    def test_active_preemption_matrix(self):
        items = (item(0, "first"), item(1, "active"), item(2, "outside"))
        self.assertEqual(_py_plan_cache_window(request(items, 2)).preempt_ids, ())
        active_first = request(items, 2, active=("first",), primary="first")
        self.assertEqual(_py_plan_cache_window(active_first).preempt_ids, ())
        active_later = request(items, 2, active=("active",), primary="active")
        self.assertEqual(_py_plan_cache_window(active_later).preempt_ids, ("active",))
        outside = request(items, 2, active=("outside",), primary="outside")
        self.assertEqual(_py_plan_cache_window(outside).preempt_ids, ())
        ready_items = (item(0, "first"), item(1, "active", True))
        active_ready = request(ready_items, 2, active=("active",), primary="active")
        self.assertEqual(_py_plan_cache_window(active_ready).preempt_ids, ())
        urgent = replace(active_later, urgent_item_ids=("first",))
        self.assertEqual(_py_plan_cache_window(urgent).preempt_ids, ())

    def test_rejects_duplicate_ids_indices_and_invalid_references(self):
        invalid = (
            request((item(0, "a"), item(1, "a")), 2),
            request((item(0, "a"), item(0, "b")), 2),
            request((item(0, "a"),), 1, active=("missing",)),
            request((item(0, "a"),), 1, urgent=("missing",)),
            request((item(0, "a"),), 1, primary="a"),
        )
        for case in invalid:
            with self.subTest(case=case), self.assertRaises(ValueError):
                _py_plan_cache_window(case)

    def test_is_deterministic(self):
        case = request(
            (item(4, "b"), item(2, "a"), item(8, "c", True)),
            2,
            active=("a",),
            primary="a",
        )
        expected = _py_plan_cache_window(case)
        for _ in range(100):
            self.assertEqual(_py_plan_cache_window(case), expected)


def wire_request(case: CachePlanRequest) -> dict[str, object]:
    return {
        "schema_version": 1,
        "items": [
            {
                "original_index": value.original_index,
                "item_id": value.item_id,
                "cache_ready": value.cache_ready,
            }
            for value in case.items
        ],
        "max_items": case.max_items,
        "retention_limit": case.retention_limit,
        "active_item_ids": list(case.active_item_ids),
        "primary_active_item_id": case.primary_active_item_id,
        "urgent_item_ids": list(case.urgent_item_ids),
    }


def wire_response(plan: CachePlan) -> dict[str, object]:
    return {
        "schema_version": 1,
        "desired_ids": list(plan.desired_ids),
        "pending_order": list(plan.pending_order),
        "retained_ids": list(plan.retained_ids),
        "preempt_ids": list(plan.preempt_ids),
    }


class CachePlanningBackendTest(unittest.TestCase):
    def call_with_response(self, payload: object, response: object):
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 1)
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend,
            "_CAPABILITIES",
            {"plan_cache_window": True},
        ), patch.object(
            rust_backend,
            "_read_rust_string",
            return_value=response if isinstance(response, str) else json.dumps(response),
        ):
            return rust_backend.try_plan_cache_window(payload)

    def test_valid_response_is_accepted(self):
        case = request(
            (item(0, "first"), item(1, "active"), item(2, "ready", True)),
            2,
            1,
            active=("active",),
            primary="active",
        )
        expected = wire_response(_py_plan_cache_window(case))
        self.assertEqual(self.call_with_response(wire_request(case), expected), (True, expected))

    def test_missing_library_symbol_exception_null_and_malformed_json_fall_back(self):
        case = wire_request(request((item(0, "a"),), 1))
        with patch.object(rust_backend, "_rust_lib", None):
            self.assertEqual(rust_backend.try_plan_cache_window(case), (False, None))
        with patch.object(rust_backend, "_rust_lib", SimpleNamespace()), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": False}
        ):
            self.assertEqual(rust_backend.try_plan_cache_window(case), (False, None))
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: (_ for _ in ()).throw(RuntimeError()))
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ):
            self.assertEqual(rust_backend.try_plan_cache_window(case), (False, None))
        self.assertEqual(self.call_with_response(case, "not json"), (False, None))
        self.assertEqual(self.call_with_response(case, "null"), (False, None))
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 0)
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ), patch.object(rust_backend, "_read_rust_string", return_value=None):
            self.assertEqual(rust_backend.try_plan_cache_window(case), (False, None))

    def test_request_validation_rejects_schema_types_duplicates_and_references(self):
        base = wire_request(request((item(0, "a"),), 1))
        invalid_cases = []
        for key, value in (
            ("schema_version", 2),
            ("schema_version", True),
            ("max_items", True),
            ("max_items", -1),
            ("retention_limit", True),
        ):
            invalid_cases.append({**base, key: value})
        invalid_cases.extend(
            [
                {**base, "unknown": 1},
                {**base, "items": [{**base["items"][0], "unknown": 1}]},
                {**base, "items": [{**base["items"][0], "original_index": True}]},
                {**base, "items": [{**base["items"][0], "original_index": -1}]},
                {**base, "items": [base["items"][0], {**base["items"][0], "original_index": 1}]},
                {**base, "items": [base["items"][0], {**base["items"][0], "item_id": "b"}]},
                {**base, "active_item_ids": ["missing"]},
                {**base, "urgent_item_ids": ["missing"]},
                {**base, "primary_active_item_id": "a"},
            ]
        )
        for invalid in invalid_cases:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.call_with_response(invalid, {}), (False, None))

    def test_response_validation_rejects_every_mismatch_class(self):
        case = request((item(0, "a"), item(1, "b", True)), 2, 1)
        payload = wire_request(case)
        expected = wire_response(_py_plan_cache_window(case))
        mutations = [
            {**expected, "unknown": []},
            {**expected, "schema_version": 2},
            {**expected, "desired_ids": ["missing"]},
            {**expected, "desired_ids": ["a", "a"]},
            {**expected, "desired_ids": []},
            {**expected, "desired_ids": ["b", "a"]},
            {**expected, "pending_order": ["b"]},
            {**expected, "pending_order": []},
            {**expected, "retained_ids": ["a"]},
            {**expected, "retained_ids": ["a", "b", "b"]},
            {**expected, "preempt_ids": ["a"]},
        ]
        for response in mutations:
            with self.subTest(response=response):
                self.assertEqual(self.call_with_response(payload, response), (False, None))

    def test_real_native_generated_equivalence(self):
        status = rust_backend.backend_status()
        if not status["capabilities"].get("plan_cache_window"):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail("strict native mode requires plan_cache_window")
            self.skipTest("native cache planner is unavailable")

        ids = ("a", "b", "c")
        for permutation in itertools.permutations(ids):
            for ready_mask in range(1 << len(ids)):
                values = tuple(
                    item(index, item_id, bool(ready_mask & (1 << index)))
                    for index, item_id in enumerate(permutation)
                )
                for limit in range(0, 5):
                    for retention in (0, 1, 4):
                        for primary in (None, *permutation):
                            active = () if primary is None else (primary,)
                            urgent = () if primary == permutation[0] else (permutation[0],)
                            case = request(
                                values,
                                limit,
                                retention,
                                active=active,
                                primary=primary,
                                urgent=urgent,
                            )
                            completed, response = rust_backend.try_plan_cache_window(
                                wire_request(case)
                            )
                            self.assertTrue(completed)
                            self.assertEqual(response, wire_response(_py_plan_cache_window(case)))


if __name__ == "__main__":
    unittest.main()
