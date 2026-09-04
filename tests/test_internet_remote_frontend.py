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
        cls.remote_css = (ROOT / "static" / "remote.css").read_text(
            encoding="utf-8"
        )
        cls.remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.asset_sync = (
            ROOT / "scripts" / "sync_internet_remote_assets.ps1"
        ).read_text(encoding="utf-8")

    def test_host_exposes_local_and_internet_modes_without_replacing_local_remote(self):
        self.assertIn('id="internet-remote-local-mode"', self.host_html)
        self.assertIn('id="internet-remote-internet-mode"', self.host_html)
        self.assertIn('href="/remote"', self.host_html)
        self.assertIn('state.mode = "local"', self.host_js)

    def test_host_uses_one_mobile_remote_entry_with_local_and_public_tabs(self):
        self.assertNotIn('class="status-chip internet-remote-status-chip"', self.host_html)
        popover = self.host_html.index('id="remote-mini-popover"')
        local_mode = self.host_html.index('id="internet-remote-local-mode"')
        internet_mode = self.host_html.index('id="internet-remote-internet-mode"')
        self.assertLess(popover, local_mode)
        self.assertLess(popover, internet_mode)
        self.assertIn('id="internet-remote-local-content"', self.host_html)
        self.assertIn('id="internet-remote-internet-content"', self.host_html)

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
            "internetRemote.localDescription",
            "internetRemote.modeLabel",
            "internetRemote.internet",
            "internetRemote.description",
            "internetRemote.password",
            "internetRemote.regenerate",
            "internetRemote.create",
            "internetRemote.capacityReached",
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
        self.assertIn('url.pathname === "/api/lark/search"', self.remote_transport)
        self.assertIn('url.pathname === "/api/gatcha/search"', self.remote_transport)
        self.assertIn("internet_remote_unavailable", self.remote_transport)
        self.assertIn("url.origin !== global.location.origin", self.remote_transport)
        self.assertNotIn('request("http.request"', self.remote_transport)
        self.assertNotIn("/api/internet-remote/dispatch", self.remote_transport)

    def test_internet_mode_keeps_shared_browse_and_gatcha_ui_visible(self):
        for selector in (
            ".gatcha-panel",
            '[data-target="follow"]',
            '[data-target="favlist"]',
            '[data-target="category"]',
            '[data-target="name"]',
            '[data-target="artist"]',
        ):
            with self.subTest(selector=selector):
                self.assertNotIn(
                    f'html[data-remote-transport="internet"] {selector}',
                    self.remote_css,
                )

    def test_internet_adapter_maps_shared_browse_and_gatcha_endpoints(self):
        expected_routes = {
            "/api/d1/browse",
            "/api/d1/category-browse",
            "/api/gatcha/browse",
            "/api/gatcha/favlist/browse",
            "/api/gatcha/pool-config",
            "/api/gatcha/candidate",
            "/api/gatcha/uids/preview",
            "/api/gatcha/uids/add",
            "/api/gatcha/refresh",
            "/api/gatcha/favlist/preview",
            "/api/gatcha/favlist",
        }
        for route in expected_routes:
            with self.subTest(route=route):
                self.assertIn(f'url.pathname === "{route}"', self.remote_transport)

        for request_kind in (
            "catalog.browse",
            "catalog.category_browse",
            "gatcha.browse",
            "gatcha.favlist_browse",
            "gatcha.pool_config_get",
            "gatcha.candidate",
            "gatcha.pool_config_set",
            "gatcha.uid_preview",
            "gatcha.uid_add",
            "gatcha.refresh",
            "gatcha.favlist_preview",
            "gatcha.favlist_refresh",
        ):
            with self.subTest(request_kind=request_kind):
                self.assertIn(f'"{request_kind}"', self.remote_transport)

    def test_follow_browse_uses_bounded_offset_pagination(self):
        self.assertIn('params.set("offset", String(offset))', self.remote_js)
        self.assertIn('params.set("limit", String(limit))', self.remote_js)
        self.assertIn('id="sources-follow-results"', self.remote_html)
        self.assertNotIn('id="follow-browse-more"', self.remote_html)
        self.assertNotIn('id="modal-follow-browse-more"', self.remote_html)
        self.assertIn("function maybeLoadMoreFollowBrowse", self.remote_js)
        self.assertIn(
            "maybeLoadMoreFollowBrowse(elements.sourcesFollowResults)",
            self.remote_js,
        )
        browse_route = self.remote_transport.index(
            'url.pathname === "/api/gatcha/browse"'
        )
        browse_source = self.remote_transport[browse_route:browse_route + 700]
        self.assertIn('offset:', browse_source)
        self.assertIn('limit:', browse_source)

    def test_favlist_browse_uses_bounded_offset_pagination(self):
        self.assertIn('id="favlist-song-results"', self.remote_html)
        self.assertNotIn('id="favlist-browse-more"', self.remote_html)
        self.assertIn("function maybeLoadMoreFavlistBrowse", self.remote_js)
        self.assertIn(
            "maybeLoadMoreFavlistBrowse(elements.favlistSongResults)", self.remote_js
        )
        fetch_start = self.remote_js.index("async function fetchGatchaFavlistBrowse")
        fetch_end = self.remote_js.index("async function fetchPoolConfig", fetch_start)
        fetch_source = self.remote_js[fetch_start:fetch_end]
        self.assertIn('params.set("offset", String(offset))', fetch_source)
        self.assertIn('params.set("limit", String(limit))', fetch_source)
        load_start = self.remote_js.index("async function loadFavlistBrowse")
        load_end = self.remote_js.index("function requestResultItemKey", load_start)
        load_source = self.remote_js[load_start:load_end]
        self.assertIn("append = false", load_source)
        self.assertIn("next_offset", load_source)

        browse_route = self.remote_transport.index(
            'url.pathname === "/api/gatcha/favlist/browse"'
        )
        browse_source = self.remote_transport[browse_route:browse_route + 700]
        self.assertIn('offset:', browse_source)
        self.assertIn('limit:', browse_source)

    def test_public_state_maps_history_and_host_transport_revision(self):
        self.assertIn("function localHistoryItem", self.remote_transport)
        self.assertIn(
            "history: (remoteState.history || []).map(localHistoryItem).filter(Boolean)",
            self.remote_transport,
        )
        self.assertIn(
            "remoteState.state_revision ?? remoteState.revision",
            self.remote_transport,
        )
        self.assertIn("nextRevision <= state.stateRevision", self.host_js)

    def test_public_items_preserve_authoritative_part_binding_metadata(self):
        start = self.remote_transport.index("function localItem")
        end = self.remote_transport.index("function localHistoryItem", start)
        source = self.remote_transport[start:end]
        for field in (
            "item.selected_pages",
            "item.selected_durations",
            "item.selected_parts",
            "item.available_pages",
            "item.available_durations",
            "item.available_parts",
        ):
            with self.subTest(field=field):
                self.assertIn(field, source)
        self.assertIn("variant.page", source)

    def test_public_state_never_rolls_back_to_an_older_transport_revision(self):
        self.assertIn("nextRevision < currentRevision", self.remote_transport)
        self.assertIn("nextRevision <= state.stateRevision", self.host_js)

    def test_revision_bound_remote_mutations_are_serialized_before_reading_revision(self):
        self.assertIn("revisionMutationTail: Promise.resolve()", self.remote_transport)
        self.assertIn("async function acquireRevisionMutationTurn", self.remote_transport)
        self.assertIn("isRevisionBoundMutation(method, url.pathname)", self.remote_transport)
        self.assertIn("releaseRevisionMutation?.()", self.remote_transport)

    def test_host_diagnostics_record_datachannel_request_outcomes(self):
        self.assertIn('recordDiagnostic("request.dispatch", "started"', self.host_js)
        self.assertIn('recordDiagnostic("request.dispatch", "completed"', self.host_js)
        self.assertIn("operation:", self.host_js)

    def test_host_releases_public_room_capacity_when_stopped(self):
        self.assertIn('method: "DELETE"', self.host_js)
        self.assertIn("Authorization: `Bearer ${hostToken}`", self.host_js)
        self.assertIn("keepalive: true", self.host_js)

    def test_search_covers_are_requested_without_a_referrer(self):
        start = self.remote_js.index("function createSearchResultCover")
        end = self.remote_js.index("function createSearchResultRow", start)
        source = self.remote_js[start:end]
        self.assertIn('image.referrerPolicy = "no-referrer"', source)
        self.assertLess(
            source.index('image.referrerPolicy = "no-referrer"'),
            source.index("image.src = coverUrl"),
        )

    def test_application_rejections_do_not_disconnect_the_peer(self):
        start = self.host_js.index("async function handlePeerMessage")
        end = self.host_js.index("async function publishState", start)
        source = self.host_js[start:end]
        self.assertIn('accepted: false', source)
        self.assertIn('isFatalProtocolError(error.code)', source)
        self.assertIn('code: String(error.code || "internet_remote_request_failed")', source)

    def test_manual_binding_error_payload_crosses_both_browser_adapters(self):
        local_post_start = self.host_js.index("async function localPost")
        local_post_end = self.host_js.index("function signalUrl", local_post_start)
        self.assertIn(
            "error.payload = payload",
            self.host_js[local_post_start:local_post_end],
        )

        host_dispatch_start = self.host_js.index("async function handlePeerMessage")
        host_dispatch_end = self.host_js.index("async function publishState", host_dispatch_start)
        self.assertIn(
            "binding: sanitizedManualBinding(error.payload?.binding)",
            self.host_js[host_dispatch_start:host_dispatch_end],
        )

        self.assertIn(
            "error.payload = { binding: message.binding }",
            self.remote_transport,
        )
        self.assertIn(
            "failure.binding = error.payload.binding",
            self.remote_transport,
        )

    def test_playlist_add_preserves_optional_manual_binding_selection(self):
        start = self.remote_transport.index(
            'if (method === "POST" && url.pathname === "/api/playlist/add")'
        )
        end = self.remote_transport.index(
            'else if (method === "POST" && url.pathname === "/api/playlist/reorder")',
            start,
        )
        source = self.remote_transport[start:end]
        self.assertIn("selected_video_page: body.selected_video_page", source)
        self.assertIn("selected_audio_pages: body.selected_audio_pages", source)

    def test_remote_identity_registration_is_idempotent_in_the_browser_adapter(self):
        start = self.remote_transport.index(
            'if (method === "POST" && ["/api/remote-identity/register"'
        )
        end = self.remote_transport.index(
            'if (method === "POST" && url.pathname === "/api/gatcha/pool-config")',
            start,
        )
        source = self.remote_transport[start:end]
        same_name = source.index("requestedName === state.identity")
        rust_request = source.index('request("session.set_identity"')
        self.assertLess(same_name, rust_request)

    def test_control_and_bulk_requests_have_independent_ordered_queues(self):
        self.assertIn('queues: { control: Promise.resolve(), bulk: Promise.resolve() }', self.host_js)
        self.assertIn('peer.queues[lane] = peer.queues[lane].then', self.host_js)
        self.assertIn('lane === "control" && message?.type === "ping"', self.host_js)

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
        self.assertIn('$ErrorActionPreference = "Stop"', self.asset_sync)
        self.assertIn("[System.IO.Path]::IsPathRooted($Destination)", self.asset_sync)


if __name__ == "__main__":
    unittest.main()
