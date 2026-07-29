import os
import unittest
from unittest.mock import patch
import json

from bilikara import updater, rust_backend

class TestReleaseSelectionBackend(unittest.TestCase):
    def setUp(self):
        strict_patcher = patch.dict(
            os.environ, {"BILIKARA_RUST_STRICT_EQUIVALENCE": ""}, clear=False
        )
        strict_patcher.start()
        self.addCleanup(strict_patcher.stop)
        self.releases = [
            {"tag_name": "v0.8.0", "draft": False, "prerelease": False},
        ]
        self.request = {
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": False,
            "releases": self.releases,
        }
        # Save original _py_latest_release_for_current to spy on it
        self.original_py_latest = updater._py_latest_release_for_current

    def _mock_rust_response(self, response_json, capabilities=None):
        if capabilities is None:
            capabilities = {"select_release": True}

        patcher_cap = patch.dict(rust_backend._CAPABILITIES, capabilities)
        patcher_cap.start()
        self.addCleanup(patcher_cap.stop)

        # Ensure _rust_lib is not None first
        class DummyLib:
            pass
        if rust_backend._rust_lib is None:
            patcher_lib = patch.object(rust_backend, '_rust_lib', new=DummyLib())
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

        patcher_sel = patch.object(rust_backend._rust_lib, 'rust_select_release', new=mock_select, create=True)
        patcher_sel.start()
        self.addCleanup(patcher_sel.stop)

        patcher_read = patch.object(rust_backend, '_read_rust_string', new=mock_read)
        patcher_read.start()
        self.addCleanup(patcher_read.stop)

    def test_native_selected(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "selected", "selected_index": 0}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            result = updater._latest_release_for_current("v0.7.0", self.releases)
            self.assertEqual(result, self.releases[0])
            spy.assert_not_called()

    def test_native_no_match(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "no_match", "selected_index": None}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            result = updater._latest_release_for_current("v0.7.0", self.releases)
            self.assertEqual(result, {})
            spy.assert_not_called()

    def test_missing_release_symbol(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "selected", "selected_index": 0}), capabilities={"select_release": False, "select_update_asset": True})
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            result = updater._latest_release_for_current("v0.7.0", self.releases)
            self.assertEqual(result, self.releases[0])
            spy.assert_called_once()
            self.assertTrue(rust_backend._CAPABILITIES["select_update_asset"])

    def test_malformed_native_json(self):
        self._mock_rust_response("{invalid")
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            result = updater._latest_release_for_current("v0.7.0", self.releases)
            self.assertEqual(result, self.releases[0])
            spy.assert_called_once()

    def test_non_object_response(self):
        self._mock_rust_response("[]")
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_missing_schema_version(self):
        self._mock_rust_response(json.dumps({"status": "selected", "selected_index": 0}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_unsupported_schema_version(self):
        self._mock_rust_response(json.dumps({"schema_version": 2, "status": "selected", "selected_index": 0}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_unknown_status(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "maybe", "selected_index": 0}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_boolean_selected_index(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "selected", "selected_index": True}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_negative_selected_index(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "selected", "selected_index": -1}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_out_of_range_selected_index(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "selected", "selected_index": 99}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_contradictory_no_match_response(self):
        self._mock_rust_response(json.dumps({"schema_version": 1, "status": "no_match", "selected_index": 0}))
        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_native_exception(self):
        patcher_cap = patch.dict(rust_backend._CAPABILITIES, {"select_release": True})
        patcher_cap.start()
        self.addCleanup(patcher_cap.stop)

        if rust_backend._rust_lib is None:
            class DummyLib:
                pass
            patcher_lib = patch.object(rust_backend, '_rust_lib', new=DummyLib())
            patcher_lib.start()
            self.addCleanup(patcher_lib.stop)

        def mock_select(req_json):
            raise RuntimeError("Crashed")

        patcher_sel = patch.object(rust_backend._rust_lib, 'rust_select_release', new=mock_select, create=True)
        patcher_sel.start()
        self.addCleanup(patcher_sel.stop)

        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            updater._latest_release_for_current("v0.7.0", self.releases)
            spy.assert_called_once()

    def test_rust_python_equivalence(self):
        # Without mocks, we use the real rust backend
        if rust_backend._rust_lib is None or not rust_backend._CAPABILITIES.get("select_release"):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but native select_release is unavailable"
                )
            self.skipTest("Rust backend not available")

        releases = [
            {"tag_name": "v0.8.0", "draft": False, "id": 1},
            {"tag_name": "v0.9.0-preview.1", "draft": False, "id": 2},
            {"tag_name": "v0.7.0", "draft": False, "id": 3},
        ]

        with patch.object(updater, '_py_latest_release_for_current', wraps=self.original_py_latest) as spy:
            result = updater._latest_release_for_current("v0.7.0", releases, include_preview=False)
            self.assertEqual(result["id"], 1)
            spy.assert_not_called()

            result_preview = updater._latest_release_for_current("v0.7.0", releases, include_preview=True)
            self.assertEqual(result_preview["id"], 2)
            spy.assert_not_called()

            large_versions = [
                {"tag_name": "v18446744073709551616.0.0", "draft": False, "id": "large"},
                {"tag_name": "v1.0.0", "draft": False, "id": "small"},
            ]
            result_large = updater._latest_release_for_current(
                "v0.7.0", large_versions, include_preview=False
            )
            self.assertEqual(result_large["id"], "large")
            spy.assert_not_called()

if __name__ == '__main__':
    unittest.main()
