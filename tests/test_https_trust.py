from __future__ import annotations

import ssl
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from bilikara import https_trust


class HttpsTrustInitializationTest(unittest.TestCase):
    def setUp(self):
        self.original_injected = https_trust._SYSTEM_TRUST_INJECTED
        https_trust._SYSTEM_TRUST_INJECTED = False

    def tearDown(self):
        https_trust._SYSTEM_TRUST_INJECTED = self.original_injected

    def test_non_frozen_runtime_preserves_python_default_trust(self):
        fake_truststore = SimpleNamespace(inject_into_ssl=MagicMock())
        with patch.object(https_trust, "_is_frozen_macos", return_value=False), patch.dict(
            sys.modules, {"truststore": fake_truststore}
        ):
            status = https_trust.initialize_https_trust()

        fake_truststore.inject_into_ssl.assert_not_called()
        self.assertEqual(status.backend, "python-default")
        self.assertEqual(status.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(status.check_hostname)

    def test_frozen_macos_injects_native_trust_once(self):
        fake_truststore = SimpleNamespace(inject_into_ssl=MagicMock())
        with patch.object(https_trust, "_is_frozen_macos", return_value=True), patch.dict(
            sys.modules, {"truststore": fake_truststore}
        ):
            first = https_trust.initialize_https_trust()
            second = https_trust.initialize_https_trust()

        fake_truststore.inject_into_ssl.assert_called_once_with()
        self.assertEqual(first.backend, "macos-system")
        self.assertEqual(second.backend, "macos-system")
        self.assertEqual(first.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(first.check_hostname)

    def test_initialization_fails_closed_if_verification_is_disabled(self):
        insecure_context = SimpleNamespace(
            verify_mode=ssl.CERT_NONE,
            check_hostname=False,
        )
        with patch.object(https_trust.ssl, "create_default_context", return_value=insecure_context):
            with self.assertRaisesRegex(RuntimeError, "certificate and hostname verification"):
                https_trust.initialize_https_trust()

    def test_packaged_smoke_uses_strict_context(self):
        response = MagicMock()
        response.status = 204
        response.read.return_value = b""
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with patch.object(https_trust, "_is_frozen_macos", return_value=False), patch.object(
            https_trust.urllib.request, "urlopen", return_value=response
        ) as urlopen:
            result = https_trust.perform_packaged_https_smoke()

        context = urlopen.call_args.kwargs["context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertEqual(result["verifyMode"], "CERT_REQUIRED")
        self.assertTrue(result["checkHostname"])
        self.assertEqual(result["status"], 204)

    def test_packaged_smoke_rejects_non_https_endpoint(self):
        with patch.object(https_trust, "PACKAGED_HTTPS_SMOKE_URL", "http://example.com/"):
            with self.assertRaisesRegex(RuntimeError, "credential-free HTTPS URL"):
                https_trust.perform_packaged_https_smoke()


if __name__ == "__main__":
    unittest.main()
