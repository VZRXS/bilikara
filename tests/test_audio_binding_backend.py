import json
import os
import unittest
from unittest.mock import patch

from bilikara import bilibili, rust_backend
from bilikara.bilibili import AudioBindingDecision, VideoPage, decide_audio_binding


def page(number: int, part: str, duration: int = 300, cid: int | None = None) -> VideoPage:
    return VideoPage(
        page=number,
        cid=cid if cid is not None else 100 + number,
        duration=duration,
        part=part,
    )


def request_for(pages: list[VideoPage], tolerance_seconds: int = 3) -> dict[str, object]:
    return {
        "schema_version": 1,
        "tolerance_seconds": tolerance_seconds,
        "pages": [
            {
                "original_index": index,
                "page": item.page,
                "duration": item.duration,
                "part": item.part,
            }
            for index, item in enumerate(pages)
        ],
    }


def decision_from_response(response: dict[str, object] | None) -> AudioBindingDecision | None:
    assert response is not None
    if response["status"] == "no_match":
        return None
    return AudioBindingDecision(
        mode=response["mode"],
        selected_indices=tuple(response["selected_indices"]),
        automatic_video_index=response["automatic_video_index"],
    )


class AudioBindingBackendTest(unittest.TestCase):
    def setUp(self):
        strict_patcher = patch.dict(
            os.environ, {"BILIKARA_RUST_STRICT_EQUIVALENCE": ""}, clear=False
        )
        strict_patcher.start()
        self.addCleanup(strict_patcher.stop)
        self.original_py_decide = bilibili._py_decide_audio_binding

    def _mock_rust_response(self, response_json: str, capabilities=None):
        if capabilities is None:
            capabilities = {"decide_audio_binding": True}
        capability_patcher = patch.dict(rust_backend._CAPABILITIES, capabilities)
        capability_patcher.start()
        self.addCleanup(capability_patcher.stop)

        class DummyLibrary:
            pass

        if rust_backend._rust_lib is None:
            library_patcher = patch.object(
                rust_backend, "_rust_lib", new=DummyLibrary()
            )
            library_patcher.start()
            self.addCleanup(library_patcher.stop)

        class MockPointer:
            pass

        symbol_patcher = patch.object(
            rust_backend._rust_lib,
            "rust_decide_audio_binding",
            new=lambda _request_json: MockPointer(),
            create=True,
        )
        symbol_patcher.start()
        self.addCleanup(symbol_patcher.stop)

        read_patcher = patch.object(
            rust_backend,
            "_read_rust_string",
            new=lambda pointer: response_json if isinstance(pointer, MockPointer) else None,
        )
        read_patcher.start()
        self.addCleanup(read_patcher.stop)

    def assert_native_decision(
        self,
        pages: list[VideoPage],
        response: dict[str, object],
        expected: AudioBindingDecision | None,
    ) -> None:
        self._mock_rust_response(json.dumps(response, ensure_ascii=False))
        with patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback:
            self.assertEqual(decide_audio_binding(pages), expected)
            fallback.assert_not_called()

    def test_native_single(self):
        self.assert_native_decision(
            [page(7, "plain")],
            {
                "schema_version": 1,
                "status": "decided",
                "mode": "single",
                "selected_indices": [0],
                "automatic_video_index": None,
            },
            AudioBindingDecision("single", (0,), None),
        )

    def test_native_automatic(self):
        self.assert_native_decision(
            [page(1, "plain"), page(2, "off", 301)],
            {
                "schema_version": 1,
                "status": "decided",
                "mode": "automatic",
                "selected_indices": [0, 1],
                "automatic_video_index": 1,
            },
            AudioBindingDecision("automatic", (0, 1), 1),
        )

    def test_native_manual_required(self):
        self.assert_native_decision(
            [page(1, "plain"), page(2, "music", 301)],
            {
                "schema_version": 1,
                "status": "decided",
                "mode": "manual_required",
                "selected_indices": [],
                "automatic_video_index": None,
            },
            AudioBindingDecision("manual_required", (), None),
        )

    def test_valid_native_no_match(self):
        self.assert_native_decision(
            [],
            {
                "schema_version": 1,
                "status": "no_match",
                "mode": None,
                "selected_indices": [],
                "automatic_video_index": None,
            },
            None,
        )

    def test_missing_symbol_fails_audio_binding_without_affecting_other_capabilities(self):
        pages = [page(1, "plain")]
        with patch.dict(
            rust_backend._CAPABILITIES,
            {"decide_audio_binding": False, "select_media_pages": True},
        ), patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            decide_audio_binding(pages)
        fallback.assert_not_called()
        self.assertTrue(rust_backend._CAPABILITIES["select_media_pages"])

    def test_another_capability_remains_enabled_after_native_audio_decision(self):
        self._mock_rust_response(
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "decided",
                    "mode": "single",
                    "selected_indices": [0],
                    "automatic_video_index": None,
                }
            ),
            capabilities={"decide_audio_binding": True, "select_media_pages": True},
        )
        self.assertEqual(
            decide_audio_binding([page(1, "plain")]),
            AudioBindingDecision("single", (0,), None),
        )
        self.assertTrue(rust_backend._CAPABILITIES["select_media_pages"])

    def test_request_validation_is_strict(self):
        valid = request_for([page(1, "plain")])
        invalid_requests = [
            None,
            [],
            {**valid, "schema_version": True},
            {**valid, "schema_version": 2},
            {**valid, "tolerance_seconds": True},
            {**valid, "tolerance_seconds": -1},
            {**valid, "extra": True},
            {**valid, "pages": "invalid"},
            {**valid, "pages": [{**valid["pages"][0], "original_index": True}]},
            {**valid, "pages": [{**valid["pages"][0], "original_index": -1}]},
            {
                **valid,
                "pages": [
                    {
                        **valid["pages"][0],
                        "original_index": 2
                        ** (rust_backend.ctypes.sizeof(rust_backend.ctypes.c_size_t) * 8),
                    }
                ],
            },
            {
                **valid,
                "pages": [
                    valid["pages"][0],
                    {**valid["pages"][0], "page": 2},
                ],
            },
            {**valid, "pages": [{**valid["pages"][0], "page": True}]},
            {**valid, "pages": [{**valid["pages"][0], "duration": True}]},
            {**valid, "pages": [{**valid["pages"][0], "part": None}]},
            {**valid, "pages": [{**valid["pages"][0], "cid": 123}]},
        ]
        for invalid in invalid_requests:
            with self.subTest(request=invalid):
                self.assertIsNone(rust_backend._audio_binding_request_indices(invalid))

    def test_response_validation_rejects_malformed_and_contradictory_shapes(self):
        base = {
            "schema_version": 1,
            "status": "decided",
            "mode": "automatic",
            "selected_indices": [0, 1],
            "automatic_video_index": None,
        }
        invalid_cases = [
            (None, [0, 1]),
            ([], [0, 1]),
            ({**base, "schema_version": True}, [0, 1]),
            ({**base, "schema_version": 2}, [0, 1]),
            ({**base, "status": "unknown"}, [0, 1]),
            ({**base, "mode": "unknown"}, [0, 1]),
            ({**base, "selected_indices": "invalid"}, [0, 1]),
            ({**base, "selected_indices": [True, 1]}, [0, 1]),
            ({**base, "selected_indices": [-1, 1]}, [0, 1]),
            ({**base, "selected_indices": [0, 0]}, [0, 1]),
            ({**base, "selected_indices": [0, 9]}, [0, 1]),
            ({**base, "extra": True}, [0, 1]),
            (
                {
                    **base,
                    "status": "no_match",
                    "mode": None,
                    "selected_indices": [],
                },
                [0, 1],
            ),
            (
                {
                    **base,
                    "status": "no_match",
                    "mode": "single",
                    "selected_indices": [],
                },
                [],
            ),
            (
                {
                    **base,
                    "status": "no_match",
                    "mode": None,
                    "selected_indices": [0],
                },
                [0],
            ),
            (
                {**base, "status": "no_match", "mode": None, "automatic_video_index": 0},
                [],
            ),
            ({**base, "mode": "single", "selected_indices": [0]}, []),
            ({**base, "mode": "single", "selected_indices": [0]}, [0, 1]),
            ({**base, "mode": "single", "selected_indices": [1]}, [0]),
            ({**base, "mode": "single", "selected_indices": [0], "automatic_video_index": 0}, [0]),
            ({**base, "mode": "automatic"}, [0]),
            ({**base, "mode": "automatic"}, [0, 1, 2]),
            ({**base, "mode": "automatic", "selected_indices": [1, 0]}, [0, 1]),
            ({**base, "mode": "automatic", "automatic_video_index": True}, [0, 1]),
            ({**base, "mode": "automatic", "automatic_video_index": 9}, [0, 1]),
            ({**base, "mode": "manual_required", "selected_indices": []}, []),
            ({**base, "mode": "manual_required", "selected_indices": []}, [0]),
            ({**base, "mode": "manual_required"}, [0, 1]),
            ({**base, "mode": "manual_required", "selected_indices": [], "automatic_video_index": 0}, [0, 1]),
        ]
        for response, indices in invalid_cases:
            with self.subTest(response=response, indices=indices):
                self.assertFalse(
                    rust_backend._valid_audio_binding_response(response, indices)
                )

    def test_malformed_json_response_fails_closed(self):
        self._mock_rust_response("not json")
        pages = [page(1, "plain")]
        with patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            decide_audio_binding(pages)
        fallback.assert_not_called()

    def test_non_object_native_response_fails_closed(self):
        self._mock_rust_response("[]")
        pages = [page(1, "plain")]
        with patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            decide_audio_binding(pages)
        fallback.assert_not_called()

    def test_impossible_native_cardinality_fails_closed(self):
        self._mock_rust_response(
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "decided",
                    "mode": "single",
                    "selected_indices": [],
                    "automatic_video_index": None,
                }
            )
        )
        pages = [page(1, "plain")]
        with patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            decide_audio_binding(pages)
        fallback.assert_not_called()

    def test_native_exception_fails_closed(self):
        class DummyLibrary:
            pass

        library = rust_backend._rust_lib or DummyLibrary()
        with patch.object(rust_backend, "_rust_lib", library), patch.dict(
            rust_backend._CAPABILITIES, {"decide_audio_binding": True}
        ), patch.object(
            library,
            "rust_decide_audio_binding",
            side_effect=RuntimeError("native failure"),
            create=True,
        ), patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            pages = [page(1, "plain")]
            decide_audio_binding(pages)
        fallback.assert_not_called()

    def test_incompatible_abi_fails_closed(self):
        pages = [page(1, "plain")]
        with patch.object(rust_backend, "_rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES",
            rust_backend._empty_capabilities(),
        ), patch.object(
            bilibili,
            "_py_decide_audio_binding",
            wraps=self.original_py_decide,
        ) as fallback, self.assertRaises(rust_backend.PlaybackCapabilityError):
            decide_audio_binding(pages)
        fallback.assert_not_called()

    def test_input_order_and_original_page_identity_are_preserved(self):
        p2 = page(2, "off", 301)
        p1 = page(1, "plain", 300)
        pages = [p2, p1]
        identities = tuple(id(item) for item in pages)
        self.assert_native_decision(
            pages,
            {
                "schema_version": 1,
                "status": "decided",
                "mode": "automatic",
                "selected_indices": [0, 1],
                "automatic_video_index": 0,
            },
            AudioBindingDecision("automatic", (0, 1), 0),
        )
        self.assertEqual(tuple(id(item) for item in pages), identities)

    def test_real_rust_python_and_public_equivalence_without_fallback(self):
        if rust_backend._rust_lib is None or not rust_backend._CAPABILITIES.get(
            "decide_audio_binding"
        ):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but native decide_audio_binding is unavailable"
                )
            self.skipTest("Rust audio-binding capability is unavailable")

        cases = [
            [],
            [page(7, "plain")],
            [page(1, "main track"), page(2, "music track", 301)],
            [page(1, "plain"), page(2, "ON", 301)],
            [page(1, "plain"), page(2, "Off", 301)],
            [page(1, "plain"), page(2, "人声", 301)],
            [page(1, "plain"), page(2, "原唱", 301)],
            [page(1, "plain"), page(2, "伴奏", 301)],
            [page(1, "plain"), page(2, " office ", 301)],
            [page(1, "on_vocal"), page(2, "off-vocal", 301)],
            [page(1, "off vocal", 300, 101), page(1, "on vocal", 301, 102)],
            [page(1, "plain", 300), page(2, "off", 302)],
            [page(1, "plain", 300), page(2, "off", 303)],
            [page(1, "plain", 300), page(2, "off", 304)],
            [page(2, "off", 301), page(1, "plain", 300)],
            [page(1, "on", 300), page(2, "plain", 301)],
            [page(1, "on", 300), page(2, "off", 301)],
            [page(3, "plain", 300), page(4, "off", 301)],
            [page(1, "plain", 300, 101), page(1, "off", 301, 102)],
            [page(1, "on"), page(2, "off", 301), page(3, "伴奏", 302)],
        ]
        for pages in cases:
            with self.subTest(pages=pages):
                python_result = self.original_py_decide(pages, 3)
                completed, native_response = rust_backend.try_decide_audio_binding(
                    request_for(pages)
                )
                self.assertTrue(completed)
                self.assertEqual(
                    decision_from_response(native_response), python_result
                )
                with patch.object(
                    bilibili,
                    "_py_decide_audio_binding",
                    side_effect=AssertionError("Python fallback was called"),
                ):
                    public_result = decide_audio_binding(pages)
                self.assertEqual(public_result, python_result)


if __name__ == "__main__":
    unittest.main()
