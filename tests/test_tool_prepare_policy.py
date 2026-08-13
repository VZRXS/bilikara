import unittest
from unittest.mock import patch

from bilikara import rust_backend


class ToolPreparePolicyIntegrationTest(unittest.TestCase):
    def require_capability(self) -> None:
        status = rust_backend.backend_status()
        if status["capabilities"].get("decide_tool_prepare_policy") is not True:
            self.skipTest("Rust tool prepare policy is unavailable")

    def test_native_bbdown_prepare_routing_matrix(self):
        self.require_capability()
        cases = (
            (False, True, False, True, "use_installed", False),
            (False, True, False, False, "use_installed", True),
            (False, False, False, False, "fetch_install_update", False),
            (False, True, True, True, "fetch_install_update", False),
            (True, True, True, False, "use_override", False),
        )
        for (
            override_exists,
            installed_exists,
            force_refresh,
            version_metadata_present,
            action,
            probe_installed_version,
        ) in cases:
            with self.subTest(
                override_exists=override_exists,
                installed_exists=installed_exists,
                force_refresh=force_refresh,
                version_metadata_present=version_metadata_present,
            ):
                completed, response = rust_backend.try_decide_tool_prepare_policy(
                    {
                        "schema_version": 1,
                        "override_exists": override_exists,
                        "installed_exists": installed_exists,
                        "force_refresh": force_refresh,
                        "version_metadata_present": version_metadata_present,
                    }
                )
                self.assertTrue(completed)
                self.assertIsNotNone(response)
                self.assertEqual(response["action"], action)
                self.assertEqual(
                    response["probe_installed_version"],
                    probe_installed_version,
                )

    def test_wrapper_rejects_malformed_native_response(self):
        request = {
            "schema_version": 1,
            "override_exists": False,
            "installed_exists": True,
            "force_refresh": False,
            "version_metadata_present": True,
        }
        with patch.object(
            rust_backend,
            "_call_json_capability",
            return_value={"schema_version": 1},
        ):
            self.assertEqual(
                rust_backend.try_decide_tool_prepare_policy(request),
                (False, None),
            )

    def test_wrapper_fails_closed_when_capability_is_unavailable(self):
        request = {
            "schema_version": 1,
            "override_exists": False,
            "installed_exists": True,
            "force_refresh": False,
            "version_metadata_present": True,
        }
        with patch.object(rust_backend, "_rust_lib", None):
            self.assertEqual(
                rust_backend.try_decide_tool_prepare_policy(request),
                (False, None),
            )


if __name__ == "__main__":
    unittest.main()
