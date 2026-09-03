from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class InternetRemoteFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.host_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.host_js = (ROOT / "static" / "internet-remote-host.js").read_text(
            encoding="utf-8"
        )

    def test_host_exposes_local_and_internet_modes_without_replacing_local_remote(self):
        self.assertIn('id="internet-remote-local-mode"', self.host_html)
        self.assertIn('id="internet-remote-internet-mode"', self.host_html)
        self.assertIn('href="/remote"', self.host_html)
        self.assertIn('state.mode = "local"', self.host_js)

    def test_internet_remote_scripts_load_before_the_host_application(self):
        transport = self.host_html.index('src="/internet-remote-transport.js"')
        adapter = self.host_html.index('src="/internet-remote-host.js"')
        application = self.host_html.index('src="/app.js"')
        self.assertLess(transport, adapter)
        self.assertLess(adapter, application)

    def test_host_room_secrets_stay_in_fragment_and_websocket_subprotocol(self):
        self.assertIn("/remote.html#room=", self.host_js)
        self.assertIn("`host.${state.hostToken}.${state.hostPeerId}`", self.host_js)
        self.assertNotIn("?host=", self.host_js)
        self.assertNotIn("?join=", self.host_js)

    def test_mode_labels_exist_in_every_language(self):
        languages = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        required = {
            "internetRemote.title",
            "internetRemote.local",
            "internetRemote.localHint",
            "internetRemote.modeLabel",
            "internetRemote.internet",
            "internetRemote.description",
            "internetRemote.password",
            "internetRemote.regenerate",
            "internetRemote.create",
        }
        for language, messages in languages.items():
            with self.subTest(language=language):
                self.assertTrue(required.issubset(messages))

    def test_room_creation_failure_remains_visible_after_cleanup(self):
        start = self.host_js.index("async function startRoom")
        end = self.host_js.index("function expireRoom", start)
        source = self.host_js[start:end]
        catch = source.index("} catch (error) {")
        cleanup = source.index("stopRoom(false);", catch)
        failure_status = source.index('setStatus(tr("internetRemote.createFailed"', catch)
        self.assertLess(cleanup, failure_status)

    def test_internet_remote_exposes_only_sanitized_bounded_diagnostics(self):
        self.assertIn("window.BilikaraInternetRemoteDiagnostics", self.host_js)
        self.assertIn("getSnapshot()", self.host_js)
        self.assertIn("DIAGNOSTIC_EVENT_LIMIT = 64", self.host_js)
        record_start = self.host_js.index("function recordDiagnostic")
        record_end = self.host_js.index("window.BilikaraInternetRemoteDiagnostics", record_start)
        record_source = self.host_js[record_start:record_end]
        self.assertNotIn("roomId", record_source)
        self.assertNotIn("hostToken", record_source)
        self.assertNotIn("joinToken", record_source)
        self.assertNotIn("password", record_source)


if __name__ == "__main__":
    unittest.main()
