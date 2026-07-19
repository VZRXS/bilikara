import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from bilikara import rust_backend


def request(mode="dash_streams", kind="video", streams=None):
    return {
        "schema_version": 1,
        "mode": mode,
        "stream_kind": kind,
        "streams": streams or [],
    }


class MediaDownloadCandidatePlanningBackendTest(unittest.TestCase):
    def _mock_response(self, response_json):
        class Library:
            @staticmethod
            def rust_plan_media_download_candidates(_payload):
                return object()

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(rust_backend, "_rust_lib", Library()))
        stack.enter_context(
            patch.dict(rust_backend._CAPABILITIES, {"plan_media_download_candidates": True})
        )
        stack.enter_context(
            patch.object(rust_backend, "_read_rust_string", return_value=response_json)
        )

    def test_valid_empty_and_duplicate_preserving_plans_are_accepted(self):
        self._mock_response(json.dumps({"schema_version": 1, "status": "empty", "candidates": []}))
        self.assertTrue(rust_backend.try_plan_media_download_candidates(request())[0])

        req = request(
            streams=[{"original_index": 0, "primary_url": "a", "backup_urls": ["a"]}]
        )
        response = {
            "schema_version": 1,
            "status": "planned",
            "candidates": [
                {"stream_index": 0, "source": "primary", "backup_index": None, "url": "a"},
                {"stream_index": 0, "source": "backup", "backup_index": 0, "url": "a"},
            ],
        }
        self._mock_response(json.dumps(response))
        self.assertEqual(rust_backend.try_plan_media_download_candidates(req), (True, response))

    def test_request_validation_rejects_malformed_modes_types_and_indices(self):
        base = request(streams=[{"original_index": 0, "primary_url": "a", "backup_urls": []}])
        invalid = [
            None,
            {**base, "schema_version": 2},
            {**base, "mode": []},
            {**base, "mode": "unknown"},
            {**base, "mode": "preferred_audio", "stream_kind": "video"},
            {**base, "extra": True},
            {**base, "streams": [{**base["streams"][0], "original_index": True}]},
            {**base, "streams": [base["streams"][0], base["streams"][0]]},
            {**base, "streams": [{**base["streams"][0], "backup_urls": [None]}]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(rust_backend._media_download_plan_request(value))

    def test_untrusted_response_rejects_unknown_source_bad_index_order_and_invention(self):
        req = request(streams=[{"original_index": 3, "primary_url": " a ", "backup_urls": ["b"]}])
        mode, _kind, streams = rust_backend._media_download_plan_request(req)
        expected = rust_backend._expected_media_download_candidates(mode, streams)
        base = {"schema_version": 1, "status": "planned", "candidates": expected}
        invalid = [
            {**base, "status": "unknown"},
            {**base, "status": []},
            {**base, "extra": True},
            {**base, "candidates": [{**expected[0], "source": "unknown"}, expected[1]]},
            {**base, "candidates": [{**expected[0], "source": []}, expected[1]]},
            {**base, "candidates": [{**expected[0], "stream_index": True}, expected[1]]},
            {**base, "candidates": [{**expected[0], "stream_index": 99}, expected[1]]},
            {**base, "candidates": [{**expected[0], "backup_index": 0}, expected[1]]},
            {**base, "candidates": [{**expected[0], "url": "invented"}, expected[1]]},
            {**base, "candidates": list(reversed(expected))},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertFalse(
                    rust_backend._valid_media_download_plan_response(value, mode, streams)
                )

    def test_missing_capability_malformed_json_and_capability_isolation_fail_closed(self):
        with patch.object(rust_backend, "_rust_lib", None):
            self.assertEqual(
                rust_backend.try_plan_media_download_candidates(request()), (False, None)
            )
        with patch.object(rust_backend, "_rust_lib", object()), patch.dict(
            rust_backend._CAPABILITIES, {"plan_media_download_candidates": False}
        ):
            self.assertEqual(
                rust_backend.try_plan_media_download_candidates(request()), (False, None)
            )
        self._mock_response("not json")
        self.assertEqual(
            rust_backend.try_plan_media_download_candidates(request()), (False, None)
        )
        self.assertIn("plan_media_download_candidates", rust_backend._SYMBOLS)
        self.assertNotEqual(
            rust_backend._SYMBOLS["plan_media_download_candidates"],
            rust_backend._SYMBOLS["plan_update_download_candidates"],
        )
