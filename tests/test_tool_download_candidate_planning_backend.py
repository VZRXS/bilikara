import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from bilikara import rust_backend


def request(asset=None, bases=None, tool="bbdown"):
    return {
        "schema_version": 1,
        "tool": tool,
        "asset": asset or {"mode": "supplied", "name": "tool", "primary_url": "primary"},
        "fallback_bases": bases or [],
    }


class ToolDownloadCandidatePlanningBackendTest(unittest.TestCase):
    def _mock_response(self, response_json):
        class Library:
            @staticmethod
            def rust_plan_tool_download_candidates(_payload):
                return object()

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(rust_backend, "_rust_lib", Library()))
        stack.enter_context(
            patch.dict(rust_backend._CAPABILITIES, {"plan_tool_download_candidates": True})
        )
        stack.enter_context(
            patch.object(rust_backend, "_read_rust_string", return_value=response_json)
        )

    def test_valid_empty_and_planned_results_are_accepted(self):
        empty_req = request(
            {"mode": "supplied", "name": "tool", "primary_url": ""}
        )
        empty = {
            "schema_version": 1,
            "status": "empty",
            "tool": "bbdown",
            "asset_name": "tool",
            "candidates": [],
        }
        self._mock_response(json.dumps(empty))
        self.assertEqual(rust_backend.try_plan_tool_download_candidates(empty_req), (True, empty))

        planned_req = request(bases=[{"original_index": 2, "base_url": "mirror"}])
        expected = {
            "schema_version": 1,
            "status": "planned",
            "tool": "bbdown",
            "asset_name": "tool",
            "candidates": [
                {"source": "supplied_primary", "fallback_index": None, "url": "primary"},
                {"source": "configured_fallback", "fallback_index": 2, "url": "mirror/tool"},
            ],
        }
        self._mock_response(json.dumps(expected))
        self.assertEqual(
            rust_backend.try_plan_tool_download_candidates(planned_req), (True, expected)
        )

    def test_request_validation_rejects_bad_tools_assets_targets_and_indices(self):
        base = request()
        invalid = [
            None,
            {**base, "schema_version": True},
            {**base, "tool": []},
            {**base, "tool": "unknown"},
            {**base, "asset": {"mode": "supplied", "name": "", "primary_url": ""}},
            {**base, "asset": {"mode": "unknown"}},
            {**base, "asset": {"mode": "default_for_target", "platform": 3, "arch": "x64"}},
            {**base, "fallback_bases": [{"original_index": True, "base_url": "x"}]},
            {**base, "fallback_bases": [
                {"original_index": 1, "base_url": "a"},
                {"original_index": 1, "base_url": "b"},
            ]},
            {**base, "extra": True},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(rust_backend._tool_download_plan_request(value))

    def test_untrusted_response_rejects_unknown_identity_order_duplicates_and_invention(self):
        req = request(bases=[{"original_index": 0, "base_url": "mirror"}])
        tool, asset, bases = rust_backend._tool_download_plan_request(req)
        asset_name, expected = rust_backend._expected_tool_download_plan(tool, asset, bases)
        base = {
            "schema_version": 1,
            "status": "planned",
            "tool": tool,
            "asset_name": asset_name,
            "candidates": expected,
        }
        invalid = [
            {**base, "status": "unknown"},
            {**base, "status": []},
            {**base, "tool": "ytdlp"},
            {**base, "asset_name": "invented"},
            {**base, "extra": True},
            {**base, "candidates": [{**expected[0], "source": "unknown"}, expected[1]]},
            {**base, "candidates": [{**expected[0], "source": []}, expected[1]]},
            {**base, "candidates": [{**expected[0], "fallback_index": 0}, expected[1]]},
            {**base, "candidates": [expected[0], expected[0]]},
            {**base, "candidates": list(reversed(expected))},
            {**base, "candidates": [{**expected[0], "url": "invented"}, expected[1]]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertFalse(
                    rust_backend._valid_tool_download_plan_response(
                        value, tool, asset_name, expected
                    )
                )

    def test_missing_symbol_incompatible_semantics_and_malformed_json_fall_back(self):
        with patch.object(rust_backend, "_rust_lib", None):
            self.assertEqual(rust_backend.try_plan_tool_download_candidates(request()), (False, None))
        with patch.object(rust_backend, "_rust_lib", object()), patch.dict(
            rust_backend._CAPABILITIES, {"plan_tool_download_candidates": False}
        ):
            self.assertEqual(rust_backend.try_plan_tool_download_candidates(request()), (False, None))
        unsupported = request(
            {"mode": "default_for_target", "platform": "linux", "arch": "x64"},
            tool="aria2c",
        )
        self.assertEqual(rust_backend.try_plan_tool_download_candidates(unsupported), (False, None))
        self._mock_response("not json")
        self.assertEqual(rust_backend.try_plan_tool_download_candidates(request()), (False, None))
        self.assertIn("plan_tool_download_candidates", rust_backend._SYMBOLS)
        self.assertNotEqual(
            rust_backend._SYMBOLS["plan_tool_download_candidates"],
            rust_backend._SYMBOLS["plan_update_download_candidates"],
        )
