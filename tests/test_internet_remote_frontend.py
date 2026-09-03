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
        cls.remote_html = (ROOT / "static" / "remote.html").read_text(
            encoding="utf-8"
        )
        cls.remote_transport = (
            ROOT / "static" / "remote-transport-client.js"
        ).read_text(encoding="utf-8")
        cls.remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.asset_sync = (
            ROOT / "scripts" / "sync_internet_remote_assets.ps1"
        ).read_text(encoding="utf-8")

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

    def test_local_and_internet_remote_share_the_product_remote_page(self):
        low_level = self.remote_html.index('src="/internet-remote-transport.js"')
        adapter = self.remote_html.index('src="/remote-transport-client.js"')
        application = self.remote_html.index('src="/remote.js"')
        queue = self.remote_html.index('src="/remote-queue.js"')
        self.assertLess(low_level, adapter)
        self.assertLess(adapter, application)
        self.assertLess(application, queue)
        self.assertIn('id="remote-request-search-panel"', self.remote_html)
        self.assertIn('id="queue-item-template"', self.remote_html)

    def test_internet_adapter_is_an_explicit_api_allowlist(self):
        self.assertIn('url.pathname === "/api/playlist/reorder"', self.remote_transport)
        self.assertIn('url.pathname === "/api/player/control"', self.remote_transport)
        self.assertIn('["/api/lark/search", "/api/gatcha/search"]', self.remote_transport)
        self.assertIn("internet_remote_unavailable", self.remote_transport)
        self.assertIn("url.origin !== global.location.origin", self.remote_transport)
        self.assertNotIn('request("http.request"', self.remote_transport)
        self.assertNotIn("/api/internet-remote/dispatch", self.remote_transport)

    def test_local_transport_remains_native_fetch_and_event_source(self):
        self.assertIn('mode: "local"', self.remote_transport)
        self.assertIn("fetch: nativeFetch", self.remote_transport)
        self.assertIn("new global.EventSource(url)", self.remote_transport)

    def test_reconnect_replaces_the_resolved_readiness_gate(self):
        reconnect = self.remote_transport.index("function scheduleReconnect()")
        disconnect = self.remote_transport.index("function disconnect()", reconnect)
        source = self.remote_transport[reconnect:disconnect]
        self.assertIn("state.authorized = false", source)
        self.assertIn("state.readyPromise = null", source)
        self.assertIn("ensureReadyPromise()", source)

    def test_internet_disconnect_does_not_send_a_local_api_beacon(self):
        start = self.remote_js.index("function disconnectClient()")
        end = self.remote_js.index("elements.requestForm", start)
        source = self.remote_js[start:end]
        transport_disconnect = source.index('mode === "internet"')
        beacon = source.index("navigator.sendBeacon")
        self.assertLess(transport_disconnect, beacon)
        self.assertIn("window.BilikaraRemoteTransport.disconnect()", source)

    def test_worker_asset_sync_uses_the_product_remote_dependencies(self):
        for asset in (
            "remote.html",
            "remote.css",
            "remote.js",
            "remote-queue.css",
            "remote-queue.js",
            "song-detail.css",
            "song-detail.js",
            "i18n.json",
            "internet-remote-transport.js",
            "remote-transport-client.js",
        ):
            with self.subTest(asset=asset):
                self.assertIn(f'"{asset}"', self.asset_sync)
        self.assertIn('Join-Path $staticRoot "pic"', self.asset_sync)


if __name__ == "__main__":
    unittest.main()
