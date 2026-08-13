import unittest
from unittest.mock import patch

from bilikara import rust_backend
from bilikara.playback_selector import normalize_persisted_playback_selector_mode


class RustAuthoritativePolicyIntegrationTest(unittest.TestCase):
    def require_capability(self, capability: str) -> None:
        status = rust_backend.backend_status()
        if status["capabilities"].get(capability) is not True:
            self.skipTest(f"Rust capability is unavailable: {capability}")

    def test_native_playback_selector_persisted_mode_matrix(self):
        self.require_capability("decide_playback_selector_policy")
        cases = (
            (False, None, True, "rust", "default"),
            (True, "rust", True, "rust", "explicit_rust"),
            (True, "python", True, "python", "explicit_python"),
            (True, "python", False, "python", "explicit_python"),
            (True, "hybrid", True, "rust", "invalid_persisted"),
            (True, "hybrid", False, "python", "invalid_persisted"),
            (True, "rust", False, "python", "rust_unavailable"),
        )
        for is_set, mode, rust_available, effective_mode, reason in cases:
            with self.subTest(
                is_set=is_set,
                mode=mode,
                rust_available=rust_available,
            ):
                completed, response = (
                    rust_backend.try_decide_playback_selector_policy(
                        {
                            "schema_version": 1,
                            "operation": "resolve_persisted",
                            "rust_available": rust_available,
                            "is_set": is_set,
                            "mode": mode,
                        }
                    )
                )
                self.assertTrue(completed)
                self.assertIsNotNone(response)
                self.assertEqual(response["effective_mode"], effective_mode)
                self.assertEqual(response["reason"], reason)

    def test_python_persisted_mode_adapter_uses_native_reason(self):
        self.require_capability("decide_playback_selector_policy")
        unavailable_status = {
            "loaded": True,
            "error": None,
            "capabilities": {
                capability: False
                for capability in (
                    "decide_audio_binding",
                    "decide_quality_policy",
                    "select_video_stream",
                    "select_audio_stream",
                    "select_preferred_audio_source",
                    "plan_media_download_candidates",
                    "apply_av_delay_action",
                )
            },
        }
        with patch(
            "bilikara.playback_selector.rust_backend.backend_status",
            return_value=unavailable_status,
        ), patch.object(
            rust_backend,
            "try_decide_playback_selector_policy",
            wraps=rust_backend.try_decide_playback_selector_policy,
        ) as decide_policy:
            mode, warning = normalize_persisted_playback_selector_mode("rust")

        self.assertEqual(mode, "python")
        self.assertIn("unavailable", warning)
        decide_policy.assert_called_once()

    def test_policy_wrapper_rejects_malformed_native_response(self):
        selector_request = {
            "schema_version": 1,
            "operation": "resolve_persisted",
            "rust_available": True,
            "is_set": False,
            "mode": None,
        }
        with patch.object(
            rust_backend,
            "_call_json_capability",
            return_value={"schema_version": 1},
        ):
            self.assertEqual(
                rust_backend.try_decide_playback_selector_policy(selector_request),
                (False, None),
            )


if __name__ == "__main__":
    unittest.main()
