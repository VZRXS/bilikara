from __future__ import annotations

import json
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.cache import CacheManager, CachePlan, _py_plan_cache_window


class RustRuntimePolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        rust_backend.timing_diagnostics_snapshot(reset=True)

    @staticmethod
    def manager() -> CacheManager:
        manager = CacheManager.__new__(CacheManager)
        manager.lock = threading.RLock()
        manager.active_item_id = None
        manager.active_process_item_ids = {}
        manager.urgent_cache_ids = set()
        manager.max_cache_items = 2
        manager._item_cache_ready = lambda item: bool(item.ready)
        return manager

    @staticmethod
    def items():
        return [
            SimpleNamespace(id="a", ready=False),
            SimpleNamespace(id="b", ready=True),
            SimpleNamespace(id="c", ready=True),
        ]

    @staticmethod
    def response() -> dict[str, object]:
        return {
            "schema_version": 1,
            "desired_ids": ["a", "b"],
            "pending_order": ["a"],
            "retained_ids": ["a", "b", "c"],
            "preempt_ids": [],
        }

    def test_valid_rust_result_skips_python_fallback_and_reference_in_normal_mode(self):
        manager = self.manager()
        with patch.dict(
            os.environ,
            {"BILIKARA_RUST_STRICT_EQUIVALENCE": ""},
            clear=False,
        ), patch(
            "bilikara.cache.rust_backend.try_plan_cache_window",
            return_value=(True, self.response()),
        ), patch(
            "bilikara.cache._py_plan_cache_window",
            wraps=_py_plan_cache_window,
        ) as fallback:
            plan = manager._plan_cache_snapshot(self.items())

        self.assertEqual(
            plan,
            CachePlan(("a", "b"), ("a",), ("a", "b", "c"), ()),
        )
        fallback.assert_not_called()

    def test_rust_failure_invokes_python_fallback_exactly_once(self):
        manager = self.manager()
        with patch(
            "bilikara.cache.rust_backend.try_plan_cache_window",
            return_value=(False, None),
        ), patch(
            "bilikara.cache._py_plan_cache_window",
            wraps=_py_plan_cache_window,
        ) as fallback:
            plan = manager._plan_cache_snapshot(self.items())
        self.assertEqual(plan.desired_ids, ("a", "b"))
        fallback.assert_called_once()

    def test_valid_bridge_response_skips_reference_comparison_in_normal_mode(self):
        request = {
            "schema_version": 1,
            "items": [{"original_index": 0, "item_id": "a", "cache_ready": False}],
            "max_items": 1,
            "retention_limit": 3,
            "active_item_ids": [],
            "primary_active_item_id": None,
            "urgent_item_ids": [],
        }
        response = {
            "schema_version": 1,
            "desired_ids": ["a"],
            "pending_order": ["a"],
            "retained_ids": ["a"],
            "preempt_ids": [],
        }
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 1)
        with patch.dict(
            os.environ, {"BILIKARA_RUST_STRICT_EQUIVALENCE": ""}, clear=False
        ), patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ), patch.object(
            rust_backend, "_read_rust_string", return_value=json.dumps(response)
        ), patch.object(
            rust_backend,
            "_expected_cache_plan",
            side_effect=AssertionError("normal mode must not run the Python reference"),
        ) as reference:
            self.assertEqual(
                rust_backend.try_plan_cache_window(request), (True, response)
            )
        reference.assert_not_called()

    def test_malformed_native_response_reaches_caller_fallback_once(self):
        manager = self.manager()
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 1)
        with patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ), patch.object(
            rust_backend, "_read_rust_string", return_value=json.dumps({"bad": True})
        ), patch(
            "bilikara.cache._py_plan_cache_window",
            wraps=_py_plan_cache_window,
        ) as fallback:
            plan = manager._plan_cache_snapshot(self.items())
        self.assertEqual(plan.pending_order, ("a",))
        fallback.assert_called_once()

    def test_unavailable_native_library_keeps_complete_fallback_functional(self):
        manager = self.manager()
        with patch.object(rust_backend, "_rust_lib", None), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ), patch(
            "bilikara.cache._py_plan_cache_window",
            wraps=_py_plan_cache_window,
        ) as fallback:
            plan = manager._plan_cache_snapshot(self.items())
        self.assertEqual(
            plan,
            CachePlan(("a", "b"), ("a",), ("a", "b", "c"), ()),
        )
        fallback.assert_called_once()

    def test_strict_mode_runs_reference_detects_mismatch_and_returns_reference(self):
        request = {
            "schema_version": 1,
            "items": [
                {"original_index": 0, "item_id": "a", "cache_ready": False},
                {"original_index": 1, "item_id": "b", "cache_ready": True},
                {"original_index": 2, "item_id": "c", "cache_ready": True},
            ],
            "max_items": 2,
            "retention_limit": 3,
            "active_item_ids": [],
            "primary_active_item_id": None,
            "urgent_item_ids": [],
        }
        valid_but_mismatched = {
            **self.response(),
            "retained_ids": ["a", "b"],
        }
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 1)
        with patch.dict(
            os.environ,
            {
                "BILIKARA_RUST_STRICT_EQUIVALENCE": "1",
                "BILIKARA_RUST_TIMING_DIAGNOSTICS": "1",
            },
            clear=False,
        ), patch.object(rust_backend, "_rust_lib", library), patch.object(
            rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
        ), patch.object(
            rust_backend,
            "_read_rust_string",
            return_value=json.dumps(valid_but_mismatched),
        ), patch.object(
            rust_backend,
            "_valid_cache_plan_response",
            return_value=True,
        ), patch.object(
            rust_backend,
            "_expected_cache_plan",
            wraps=rust_backend._expected_cache_plan,
        ) as reference:
            completed, response = rust_backend.try_plan_cache_window(request)
            metrics = rust_backend.timing_diagnostics_snapshot()

        self.assertTrue(completed)
        self.assertEqual(response, self.response())
        reference.assert_called_once()
        self.assertEqual(
            metrics["plan_cache_window"]["strict_equivalence_comparison_count"], 1
        )
        self.assertEqual(
            metrics["plan_cache_window"]["strict_equivalence_mismatch_count"], 1
        )
        self.assertEqual(metrics["plan_cache_window"]["call_count"], 1)
        self.assertGreaterEqual(
            metrics["plan_cache_window"]["rust_ffi_elapsed_seconds"], 0
        )
        self.assertGreaterEqual(
            metrics["plan_cache_window"]["json_encode_elapsed_seconds"], 0
        )
        self.assertGreaterEqual(
            metrics["plan_cache_window"]["json_decode_elapsed_seconds"], 0
        )

    def test_normal_and_strict_modes_return_same_valid_canonical_result(self):
        request = {
            "schema_version": 1,
            "items": [{"original_index": 0, "item_id": "a", "cache_ready": False}],
            "max_items": 1,
            "retention_limit": 3,
            "active_item_ids": [],
            "primary_active_item_id": None,
            "urgent_item_ids": [],
        }
        response = {
            "schema_version": 1,
            "desired_ids": ["a"],
            "pending_order": ["a"],
            "retained_ids": ["a"],
            "preempt_ids": [],
        }
        library = SimpleNamespace(rust_plan_cache_window=lambda _payload: 1)

        def call(strict: str):
            with patch.dict(
                os.environ, {"BILIKARA_RUST_STRICT_EQUIVALENCE": strict}, clear=False
            ), patch.object(rust_backend, "_rust_lib", library), patch.object(
                rust_backend, "_CAPABILITIES", {"plan_cache_window": True}
            ), patch.object(
                rust_backend, "_read_rust_string", return_value=json.dumps(response)
            ):
                return rust_backend.try_plan_cache_window(request)

        self.assertEqual(call(""), call("1"))

    def test_optional_timing_counts_lazy_fallback(self):
        with patch.dict(
            os.environ, {"BILIKARA_RUST_TIMING_DIAGNOSTICS": "1"}, clear=False
        ):
            self.assertEqual(
                rust_backend.python_fallback("demo", lambda: "fallback"),
                "fallback",
            )
            metrics = rust_backend.timing_diagnostics_snapshot()
        self.assertEqual(metrics["demo"]["python_fallback_count"], 1)
        self.assertGreaterEqual(metrics["demo"]["python_fallback_elapsed_seconds"], 0)


if __name__ == "__main__":
    unittest.main()
