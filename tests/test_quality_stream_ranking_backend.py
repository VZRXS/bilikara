import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from bilikara import rust_backend


def quality_request(**changes):
    request = {
        "schema_version": 1,
        "raw_quality": "720P 高清",
        "raw_cap": "",
        "choice_index": 2,
    }
    request.update(changes)
    return request


def video_request(streams=None, **changes):
    request = {
        "schema_version": 1,
        "max_quality_id": 80,
        "codec_filter": "avc",
        "max_avc_quality_id": 64,
        "streams": streams or [],
    }
    request.update(changes)
    return request


def audio_request(streams=None, **changes):
    request = {
        "schema_version": 1,
        "audio_hires": True,
        "regular_streams": streams or [],
        "flac_available": False,
        "dolby_available": False,
    }
    request.update(changes)
    return request


class QualityStreamBackendValidationTest(unittest.TestCase):
    def _mock_response(self, capability, symbol, response):
        class Library:
            pass

        setattr(Library, symbol, staticmethod(lambda _payload: object()))
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(rust_backend, "_rust_lib", Library()))
        stack.enter_context(patch.dict(rust_backend._CAPABILITIES, {capability: True}))
        stack.enter_context(
            patch.object(
                rust_backend,
                "_read_rust_string",
                return_value=response if isinstance(response, str) else json.dumps(response),
            )
        )

    def test_quality_valid_response_and_strict_reconstruction(self):
        request = quality_request()
        validated = rust_backend._quality_policy_request(request)
        expected = rust_backend._expected_quality_policy(validated)
        self._mock_response(
            "decide_quality_policy", "rust_decide_quality_policy", expected
        )
        self.assertEqual(rust_backend.try_decide_quality_policy(request), (True, expected))

        for invalid in (
            {**expected, "status": "unknown"},
            {**expected, "normalized_quality": "invented"},
            {**expected, "effective_max_height": 2160},
            {**expected, "bbdown_quality_order": list(reversed(expected["bbdown_quality_order"]))},
            {**expected, "extra": True},
        ):
            self.assertFalse(rust_backend._valid_quality_policy_response(invalid, validated))

    def test_quality_request_limits_types_and_boolean_indices(self):
        invalid = [
            quality_request(schema_version=2),
            quality_request(choice_index=True),
            quality_request(raw_quality=[]),
            quality_request(raw_cap="x" * (rust_backend.MAX_QUALITY_LABEL_BYTES + 1)),
            {**quality_request(), "extra": True},
        ]
        for request in invalid:
            self.assertIsNone(rust_backend._quality_policy_request(request))

    def test_video_valid_no_match_and_selected_responses(self):
        empty = video_request()
        expected_empty = rust_backend._expected_video_stream_selection(
            rust_backend._video_stream_request(empty)
        )
        self._mock_response("select_video_stream", "rust_select_video_stream", expected_empty)
        self.assertEqual(rust_backend.try_select_video_stream(empty), (True, expected_empty))

        selected = video_request(
            [
                {"original_index": 0, "quality_id": 80, "bandwidth": 10, "codec": "hevc"},
                {"original_index": 1, "quality_id": 64, "bandwidth": 20, "codec": "avc"},
            ]
        )
        validated = rust_backend._video_stream_request(selected)
        expected = rust_backend._expected_video_stream_selection(validated)
        self._mock_response("select_video_stream", "rust_select_video_stream", expected)
        self.assertEqual(rust_backend.try_select_video_stream(selected), (True, expected))

    def test_video_rejects_bad_requests_and_untrusted_rankings(self):
        stream = {"original_index": 0, "quality_id": 80, "bandwidth": 1, "codec": "avc"}
        invalid_requests = [
            video_request([stream], max_quality_id=True),
            video_request([{**stream, "quality_id": True}]),
            video_request([{**stream, "bandwidth": float("inf")}]),
            video_request([{**stream, "codec": "x" * (rust_backend.MAX_CODEC_STRING_BYTES + 1)}]),
            video_request([stream, stream]),
            video_request([stream] * (rust_backend.MAX_STREAM_RANKING_INPUTS + 1)),
        ]
        for request in invalid_requests:
            self.assertIsNone(rust_backend._video_stream_request(request))

        request = rust_backend._video_stream_request(video_request([stream]))
        expected = rust_backend._expected_video_stream_selection(request)
        invalid_responses = [
            {**expected, "status": "unknown"},
            {**expected, "selected_index": 99},
            {**expected, "ranked_indices": [0, 0]},
            {**expected, "ranked_indices": []},
            {**expected, "reason": "unknown"},
            {**expected, "extra": True},
        ]
        for response in invalid_responses:
            self.assertFalse(rust_backend._valid_video_stream_response(response, request))

    def test_audio_valid_dolby_result_and_strict_ordering(self):
        request = audio_request(
            [
                {"original_index": 0, "quality_id": 30232, "bandwidth": 999},
                {"original_index": 1, "quality_id": 30280, "bandwidth": 0},
            ],
            flac_available=True,
            dolby_available=True,
        )
        validated = rust_backend._audio_stream_request(request)
        expected = rust_backend._expected_audio_stream_selection(validated)
        self.assertEqual(expected["preferred_source"], "dolby")
        self.assertEqual(expected["ranked_regular_indices"], [1, 0])
        self._mock_response("select_audio_stream", "rust_select_audio_stream", expected)
        self.assertEqual(rust_backend.try_select_audio_stream(request), (True, expected))

        for invalid in (
            {**expected, "preferred_source": "unknown"},
            {**expected, "selected_regular_index": 99},
            {**expected, "ranked_regular_indices": [0, 1]},
            {**expected, "ranked_regular_indices": [1, 1]},
            {**expected, "regular_reason": "unknown"},
            {**expected, "extra": True},
        ):
            self.assertFalse(rust_backend._valid_audio_stream_response(invalid, validated))

    def test_audio_rejects_invalid_types_indices_and_excessive_requests(self):
        stream = {"original_index": 0, "quality_id": 30280, "bandwidth": 0}
        invalid = [
            audio_request([stream], audio_hires=1),
            audio_request([{**stream, "quality_id": True}]),
            audio_request([{**stream, "original_index": True}]),
            audio_request([stream, stream]),
            audio_request([stream] * (rust_backend.MAX_STREAM_RANKING_INPUTS + 1)),
            {**audio_request([stream]), "extra": True},
        ]
        for request in invalid:
            self.assertIsNone(rust_backend._audio_stream_request(request))

    def test_missing_library_symbol_malformed_json_null_and_capability_isolation(self):
        calls = (
            (rust_backend.try_decide_quality_policy, quality_request()),
            (rust_backend.try_select_video_stream, video_request()),
            (rust_backend.try_select_audio_stream, audio_request()),
        )
        with patch.object(rust_backend, "_rust_lib", None):
            for function, request in calls:
                self.assertEqual(function(request), (False, None))

        for capability, function, request in (
            ("decide_quality_policy", rust_backend.try_decide_quality_policy, quality_request()),
            ("select_video_stream", rust_backend.try_select_video_stream, video_request()),
            ("select_audio_stream", rust_backend.try_select_audio_stream, audio_request()),
        ):
            with patch.object(rust_backend, "_rust_lib", object()), patch.dict(
                rust_backend._CAPABILITIES, {capability: False}
            ):
                self.assertEqual(function(request), (False, None))

        self._mock_response(
            "select_video_stream", "rust_select_video_stream", "not json"
        )
        self.assertEqual(rust_backend.try_select_video_stream(video_request()), (False, None))
        with patch.object(rust_backend, "_rust_lib", object()), patch.dict(
            rust_backend._CAPABILITIES, {"select_audio_stream": True}
        ), patch.object(rust_backend, "_read_rust_string", return_value=None):
            self.assertEqual(
                rust_backend.try_select_audio_stream(audio_request()), (False, None)
            )
        self.assertEqual(
            len(
                {
                    rust_backend._SYMBOLS["decide_quality_policy"][0],
                    rust_backend._SYMBOLS["select_video_stream"][0],
                    rust_backend._SYMBOLS["select_audio_stream"][0],
                }
            ),
            3,
        )


if __name__ == "__main__":
    unittest.main()
