import os
import unittest
from unittest.mock import patch
import json

from bilikara import bilibili, rust_backend
from bilikara.bilibili import VideoPage, select_matching_pages


class TestMediaPageSelectionBackend(unittest.TestCase):
    def setUp(self):
        self.pages = [
            VideoPage(page=1, cid=101, duration=300, part="P1"),
            VideoPage(page=2, cid=102, duration=301, part="P2"),
        ]
        self.original_py_select = bilibili._py_select_matching_pages

    def _mock_rust_response(self, response_json, capabilities=None):
        if capabilities is None:
            capabilities = {"select_media_pages": True}

        patcher_cap = patch.dict(rust_backend._CAPABILITIES, capabilities)
        patcher_cap.start()
        self.addCleanup(patcher_cap.stop)

        class DummyLib:
            pass

        if rust_backend._rust_lib is None:
            patcher_lib = patch.object(rust_backend, "_rust_lib", new=DummyLib())
            patcher_lib.start()
            self.addCleanup(patcher_lib.stop)

        class MockPointer:
            pass

        def mock_select(req_json):
            return MockPointer()

        def mock_read(ptr):
            if isinstance(ptr, MockPointer):
                return response_json
            return None

        patcher_sel = patch.object(
            rust_backend._rust_lib,
            "rust_select_media_pages",
            new=mock_select,
            create=True,
        )
        patcher_sel.start()
        self.addCleanup(patcher_sel.stop)

        patcher_read = patch.object(rust_backend, "_read_rust_string", new=mock_read)
        patcher_read.start()
        self.addCleanup(patcher_read.stop)

    def test_native_selected(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [0, 1]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages(self.pages, preferred_page=1)
            self.assertEqual(len(result), 2)
            self.assertIs(result[0], self.pages[0])
            self.assertIs(result[1], self.pages[1])
            spy.assert_not_called()

    def test_valid_native_no_match(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "no_match", "selected_indices": []})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages([], preferred_page=1)
            self.assertEqual(result, [])
            spy.assert_not_called()

    def test_invalid_native_no_match_non_empty(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "no_match", "selected_indices": []})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages(self.pages, preferred_page=1)
            self.assertEqual(result, self.pages)
            spy.assert_called_once()

    def test_selected_empty_indices(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": []})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages(self.pages, preferred_page=1)
            self.assertEqual(result, self.pages)
            spy.assert_called_once()

    def test_missing_symbol(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [0, 1]}),
            capabilities={"select_media_pages": False, "select_release": True},
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages(self.pages, preferred_page=1)
            self.assertEqual(result, self.pages)
            spy.assert_called_once()
            self.assertTrue(rust_backend._CAPABILITIES["select_release"])

    def test_another_capability_remains_enabled(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [0, 1]}),
            capabilities={"select_media_pages": True, "select_release": True},
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_not_called()
            self.assertTrue(rust_backend._CAPABILITIES["select_release"])

    def test_malformed_json(self):
        self._mock_rust_response("invalid json")
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_non_object_response(self):
        self._mock_rust_response("[]")
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_missing_schema_version(self):
        self._mock_rust_response(
            json.dumps({"status": "selected", "selected_indices": [0, 1]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_unsupported_schema_version(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 2, "status": "selected", "selected_indices": [0, 1]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_unknown_status(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "maybe", "selected_indices": [0, 1]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_non_list_selected_indices(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": "not list"})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_boolean_index(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [True]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_negative_index(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [-1]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_unknown_index(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [99]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_duplicate_index(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [0, 0]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_contradictory_response(self):
        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "no_match", "selected_indices": [0]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_native_exception(self):
        patcher_cap = patch.dict(rust_backend._CAPABILITIES, {"select_media_pages": True})
        patcher_cap.start()
        self.addCleanup(patcher_cap.stop)

        class DummyLib:
            pass

        if rust_backend._rust_lib is None:
            patcher_lib = patch.object(rust_backend, "_rust_lib", new=DummyLib())
            patcher_lib.start()
            self.addCleanup(patcher_lib.stop)

        def mock_select(req_json):
            raise RuntimeError("Native panic")

        patcher_sel = patch.object(
            rust_backend._rust_lib,
            "rust_select_media_pages",
            new=mock_select,
            create=True,
        )
        patcher_sel.start()
        self.addCleanup(patcher_sel.stop)

        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            select_matching_pages(self.pages, preferred_page=1)
            spy.assert_called_once()

    def test_incompatible_abi(self):
        with patch.dict(rust_backend._CAPABILITIES, {"select_media_pages": False}):
            with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
                select_matching_pages(self.pages, preferred_page=1)
                spy.assert_called_once()

    def test_exact_order_mapping_and_object_identity(self):
        p0 = VideoPage(page=3, cid=103, duration=302, part="P3")
        p1 = VideoPage(page=1, cid=101, duration=300, part="P1")
        p2 = VideoPage(page=2, cid=102, duration=301, part="P2")
        input_pages = [p0, p1, p2]

        self._mock_rust_response(
            json.dumps({"schema_version": 1, "status": "selected", "selected_indices": [1, 2, 0]})
        )
        with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
            result = select_matching_pages(input_pages, preferred_page=1)
            self.assertEqual(len(result), 3)
            self.assertIs(result[0], p1)
            self.assertIs(result[1], p2)
            self.assertIs(result[2], p0)
            spy.assert_not_called()

    def test_rust_python_equivalence(self):
        if rust_backend._rust_lib is None or not rust_backend._CAPABILITIES.get("select_media_pages"):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but native select_media_pages is unavailable"
                )
            self.skipTest("Rust backend library not available")

        cases = [
            (
                [
                    VideoPage(page=1, cid=101, duration=25, part="preview"),
                    VideoPage(page=2, cid=102, duration=301, part="on vocal"),
                    VideoPage(page=3, cid=103, duration=303, part="off vocal"),
                    VideoPage(page=4, cid=104, duration=302, part="duet"),
                ],
                1,
                3,
            ),
            (
                [
                    VideoPage(page=1, cid=101, duration=120, part="P1"),
                    VideoPage(page=2, cid=102, duration=220, part="P2"),
                    VideoPage(page=3, cid=103, duration=330, part="P3"),
                ],
                2,
                3,
            ),
            (
                [
                    VideoPage(page=1, cid=101, duration=301, part="P1_longer"),
                    VideoPage(page=1, cid=102, duration=300, part="P1_shorter"),
                ],
                1,
                3,
            ),
        ]

        for pages, pref, tol in cases:
            with patch.object(bilibili, "_py_select_matching_pages", wraps=self.original_py_select) as spy:
                res = select_matching_pages(pages, preferred_page=pref, tolerance_seconds=tol)
                py_res = self.original_py_select(pages, preferred_page=pref, tolerance_seconds=tol)
                self.assertEqual(res, py_res)
                for r_item, py_item in zip(res, py_res):
                    self.assertIs(r_item, py_item)
                spy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
