from __future__ import annotations

import json
import re
import shutil
import subprocess
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
        cls.host_app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.remote_access_css = (ROOT / "static" / "remote-access.css").read_text(
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
        cls.server_source = (ROOT / "bilikara" / "server.py").read_text(
            encoding="utf-8"
        )

    def test_host_exposes_local_and_internet_modes_without_replacing_local_remote(self):
        self.assertIn('id="internet-remote-local-content"', self.host_html)
        self.assertIn('id="internet-remote-disclosure"', self.host_html)
        self.assertRegex(self.host_html, r'id="remote-popover-url-link"[^>]+aria-disabled="true"')
        self.assertIn('state.mode = "local"', self.host_js)

    def test_host_uses_one_mobile_remote_entry_with_a_collapsed_public_menu(self):
        self.assertNotIn('class="status-chip internet-remote-status-chip"', self.host_html)
        popover = self.host_html.index('id="remote-mini-popover"')
        local_content = self.host_html.index('id="internet-remote-local-content"')
        disclosure = self.host_html.index('id="internet-remote-disclosure"')
        internet_content = self.host_html.index('id="internet-remote-internet-content"')
        self.assertLess(popover, local_content)
        self.assertLess(local_content, disclosure)
        self.assertLess(disclosure, internet_content)
        self.assertIn('id="internet-remote-internet-content"', self.host_html)
        disclosure_handler = self.host_js[
            self.host_js.index('elements.disclosureRow.addEventListener("click"') :
            self.host_js.index('elements.restart.addEventListener("click"')
        ]
        self.assertNotIn("startRoom", disclosure_handler)
        self.assertIn('event.target.closest(".cache-advanced-info")', disclosure_handler)

    def test_fullscreen_remote_card_uses_the_same_compact_public_summary(self):
        self.assertIn('id="player-fullscreen-local-entry"', self.host_html)
        self.assertIn('id="player-fullscreen-public-meta"', self.host_html)
        self.assertIn('id="player-fullscreen-public-qr-image"', self.host_html)
        self.assertIn('id="player-fullscreen-public-room"', self.host_html)
        self.assertIn('id="player-fullscreen-public-password"', self.host_html)
        self.assertNotIn('id="player-fullscreen-internet-password"', self.host_html)
        self.assertIn(
            'new CustomEvent("bilikara:internet-remote-display"', self.host_js
        )
        self.assertIn("internetRemoteDisplay: null", self.host_app_js)
        self.assertIn(
            'document.addEventListener("bilikara:internet-remote-display"',
            self.host_app_js,
        )
        render_start = self.host_app_js.index("function renderPlayerFullscreenRemoteAccess")
        render_end = self.host_app_js.index(
            "async function copyRemoteUrl", render_start
        )
        render_source = self.host_app_js[render_start:render_end]
        self.assertIn("renderPlayerFullscreenRemoteAccess", render_source)
        self.assertIn("renderProvidedRemoteQr", render_source)
        self.assertIn("playerFullscreenPublicMeta", render_source)
        self.assertIn("playerFullscreenPublicRoom", render_source)
        self.assertIn("internetActive", render_source)
        self.assertIn("internetPassword", render_source)

    def test_compact_hover_keeps_active_public_qr_without_room_controls(self):
        self.assertIn('classList.toggle("has-active-internet-room", roomResultAvailable)', self.host_js)
        self.assertIn("const compactRoomPreviewVisible = !fullMenuOpen && roomResultAvailable", self.host_js)
        self.assertIn("const currentPasswordVisible = roomResultAvailable;", self.host_js)
        self.assertIn("? state.password", self.host_js)
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        compact_rule = styles[
            styles.index('.remote-mini-control:not(.is-qr-pinned) :is(') :
            styles.index('.status-chip {', styles.index('.remote-mini-control:not(.is-qr-pinned) :is('))
        ]
        self.assertIn(".internet-remote-config-row", compact_rule)
        self.assertIn(".internet-remote-actions", compact_rule)
        self.assertIn(".has-active-internet-room", compact_rule)
        self.assertNotIn(".internet-remote-internet-content\n)", compact_rule)
        self.assertIn('href="/remote-access.css"', self.host_html)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", self.remote_access_css)
        self.assertIn(".is-local-only-preview", self.remote_access_css)
        self.assertIn(".is-management-layout", self.remote_access_css)
        self.assertIn(".remote-access-expand-hint", self.remote_access_css)
        self.assertIn(
            ".remote-access-card.is-local-only-preview .remote-access-copy-title",
            self.remote_access_css,
        )
        self.assertNotIn(":lang(zh)", self.remote_access_css)

    def test_access_popovers_share_opaque_dark_surfaces_and_translation_keys(self):
        self.assertIn(
            ':root:is([data-theme="dark"], [data-theme="blue"]) .remote-access-card',
            self.remote_access_css,
        )
        self.assertIn("background: var(--modal-card-bg);", self.remote_access_css)
        self.assertIn("border: var(--modal-card-border);", self.remote_access_css)
        self.assertIn("box-shadow: var(--rating-card-shadow);", self.remote_access_css)
        self.assertEqual(
            self.host_html.count('data-i18n="internetRemote.localScanTitle"'),
            2,
        )
        self.assertEqual(
            self.host_html.count('data-i18n="internetRemote.publicScanTitle"'),
            2,
        )
        languages = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        self.assertEqual(languages["zh"]["internetRemote.publicScanTitle"], "扫码后输入房间密码")
        self.assertEqual(languages["en"]["internetRemote.publicScanTitle"], "Scan, then enter password")
        self.assertEqual(languages["ja"]["internetRemote.publicScanTitle"], "QRを読み取り、パスワードを入力")

    def test_public_and_local_qr_use_complete_images_with_one_shared_quiet_zone(self):
        self.assertIn("rust_runtime.generate_qr_image(remote_url, border=0)", self.server_source)
        self.assertNotIn("import qrcode", self.server_source)
        qr_rule = next(
            rule
            for rule in self.remote_access_css.split(".remote-access-qr {")[1:]
            if "width: 160px" in rule.split("}", 1)[0]
        ).split("}", 1)[0]
        self.assertIn("width: 160px", qr_rule)
        self.assertIn("height: 160px", qr_rule)
        self.assertIn("padding: 3px", qr_rule)
        self.assertNotIn(
            ".remote-access-entry--public .remote-access-qr img",
            self.remote_access_css,
        )
        local_qr_rule = re.search(
            r"\.remote-access-entry--local \.remote-access-qr\s*\{([^}]*)\}",
            self.remote_access_css,
        ).group(1)
        self.assertIn("justify-self: start", local_qr_rule)

    def test_hover_preview_and_pinned_menu_have_explicit_shared_ownership(self):
        self.assertIn('new CustomEvent("bilikara:remote-access-menu"', self.host_app_js)
        self.assertIn(
            'document.addEventListener("bilikara:remote-access-menu"',
            self.host_js,
        )
        self.assertIn('elements.disclosure.tabIndex = fullMenuOpen ? 0 : -1', self.host_js)
        self.assertIn('const fullInternetContentVisible = fullMenuOpen && state.internetExpanded', self.host_js)
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('.remote-mini-control:not(.is-qr-pinned)', styles)
        self.assertIn('.internet-remote-internet-content', styles)
        self.assertIn('!fullMenuOpen && !roomResultAvailable', self.host_js)
        self.assertIn('classList.toggle("is-management-layout"', self.host_app_js)

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

    def test_current_access_entry_labels_exist_in_every_language(self):
        languages = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        required = {
            "remote.openInBrowser",
            "internetRemote.localEntry",
            "internetRemote.localHint",
            "internetRemote.localScanTitle",
            "internetRemote.localSameNetwork",
            "internetRemote.localNoLanAddress",
            "internetRemote.openOnThisDevice",
            "internetRemote.localEntryDescription",
            "internetRemote.internetEntry",
            "internetRemote.description",
            "internetRemote.password",
            "internetRemote.duration",
            "internetRemote.durationUnit",
            "internetRemote.durationHint",
            "internetRemote.durationInvalid",
            "internetRemote.regenerate",
            "internetRemote.create",
            "internetRemote.stop",
            "internetRemote.createdStatus",
            "internetRemote.publicScanTitle",
            "internetRemote.expiryCompact",
            "internetRemote.currentPassword",
            "internetRemote.openFullMenu",
            "internetRemote.rebuildApply",
            "internetRemote.capacityReached",
        }
        for language, messages in languages.items():
            with self.subTest(language=language):
                self.assertTrue(required.issubset(messages))

    def test_host_remote_explanations_use_contextual_info_bubbles(self):
        self.assertIn('id="internet-remote-mode-description" role="tooltip"', self.host_html)
        self.assertIn('id="internet-remote-public-description" role="tooltip"', self.host_html)
        self.assertIn('id="internet-remote-duration-hint" class="cache-advanced-tooltip"', self.host_html)
        self.assertNotIn("internet-remote-mode-copy", self.host_html)
        self.assertNotIn('id="internet-remote-meta"', self.host_html)
        self.assertIn('data-i18n="internetRemote.localEntryDescription"', self.host_html)
        self.assertNotIn('id="internet-remote-local-address-detail"', self.host_html)
        self.assertIn('id="remote-popover-url-link"', self.host_html)
        self.assertIn('id="remote-popover-copy-link"', self.host_html)
        self.assertIn("本地 Remote 仍可同时使用", self.host_html)
        self.assertIn('setStatus(state.available\n      ? ""', self.host_js)
        self.assertNotIn(
            't("internetRemote.localAddressDetail", { url: shareableUrl })',
            self.host_app_js,
        )
        self.assertIn("function resetContextualTooltipPosition", self.host_app_js)
        self.assertIn("resetContextualTooltipPosition(info);", self.host_app_js)

    def test_local_entry_copy_names_devices_and_host_without_platform_assumptions(self):
        languages = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        for language, messages in languages.items():
            with self.subTest(language=language):
                same_network = messages["internetRemote.localSameNetwork"]
                default_hint = messages["remote.defaultHint"]
                self.assertIn("Host", same_network)
                self.assertIn("Host", default_hint)
        self.assertEqual(
            languages["en"]["internetRemote.localSameNetwork"],
            "Same network as Host",
        )
        self.assertEqual(
            languages["ja"]["internetRemote.localSameNetwork"],
            "Host と同じネットワーク",
        )
        self.assertEqual(languages["en"]["remote.openInBrowser"], "Open Remote")
        self.assertEqual(
            languages["en"]["internetRemote.localScanTitle"],
            "Scan to connect",
        )
        self.assertEqual(
            languages["en"]["internetRemote.publicScanTitle"],
            "Scan, then enter password",
        )
        self.assertEqual(languages["ja"]["remote.openInBrowser"], "Remote を開く")
        self.assertEqual(
            languages["ja"]["internetRemote.localScanTitle"],
            "QRを読み取って接続",
        )
        self.assertEqual(
            languages["ja"]["internetRemote.publicScanTitle"],
            "QRを読み取り、パスワードを入力",
        )
        render_start = self.host_app_js.index("function renderRemoteAccess")
        render_end = self.host_app_js.index("function renderRemoteQr", render_start)
        render = self.host_app_js[render_start:render_end]
        self.assertIn("setTextContent(elements.remotePopoverUrlHint, displayHint)", render)
        self.assertIn("localHint: displayHint", render)
        self.assertIn('hint: t("internetRemote.localSameNetwork")', self.host_app_js)

    def test_host_remote_entry_controls_use_shared_control_geometry(self):
        self.assertIn('class="internet-remote-config-row"', self.host_html)
        self.assertIn('class="internet-remote-duration-unit"', self.host_html)
        self.assertIn('id="internet-remote-stop"', self.host_html)
        self.assertNotIn('class="internet-remote-mode-row"', self.host_html)
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("min-height: var(--host-control-height, 44px)", styles)
        self.assertIn("border-radius: var(--host-control-radius, 14px)", styles)
        self.assertIn("font-size: 12px", self.remote_access_css)
        self.assertIn(".internet-remote-disclosure-meta.is-active { color: var(--green)", styles)
        self.assertIn("padding-right: 40px; text-align: right", styles)

    def test_remote_room_and_display_refresh_controls_share_the_host_svg(self):
        canonical_path = "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
        room_start = self.host_html.index('id="internet-remote-regenerate"')
        room_end = self.host_html.index("</button>", room_start)
        display_start = self.host_html.index('id="presentation-refresh-button"')
        display_end = self.host_html.index("</button>", display_start)
        self.assertIn(canonical_path, self.host_html[room_start:room_end])
        self.assertIn(canonical_path, self.host_html[display_start:display_end])

    def test_host_remote_entry_statuses_do_not_use_indicator_dots(self):
        popover_start = self.host_html.index('id="remote-mini-popover"')
        popover_end = self.host_html.index('id="presentation-settings"', popover_start)
        popover = self.host_html[popover_start:popover_end]
        self.assertNotIn("presentation-state-dot", popover)
        self.assertIn("internet-remote-entry-title remote-access-title", popover)
        self.assertNotIn("remote-access-public-state-icon", popover)
        self.assertIn("remote-access-public-connection-indicator", popover)
        self.assertIn("internet-remote-public-connection-count", popover)
        self.assertIn("remote-access-public-status", popover)
        self.assertIn("connected_count: active ? connectedCount : 0", self.host_js)
        self.assertIn('elements.publicMeta.classList.toggle("is-active", roomActive && !state.busy)', self.host_js)

    def test_shared_two_column_preview_uses_one_local_detail_order(self):
        main_start = self.host_html.index('id="internet-remote-local-content"')
        main_end = self.host_html.index("</section>", main_start)
        main_local = self.host_html[main_start:main_end]
        fullscreen_start = self.host_html.index('id="player-fullscreen-local-entry"')
        fullscreen_end = self.host_html.index("</section>", fullscreen_start)
        fullscreen_local = self.host_html[fullscreen_start:fullscreen_end]
        self.assertLess(
            main_local.index('id="remote-popover-url-link"'),
            main_local.index('id="remote-popover-url-hint"'),
        )
        self.assertLess(
            fullscreen_local.index('id="player-fullscreen-remote-url"'),
            fullscreen_local.index('id="player-fullscreen-remote-url-hint"'),
        )
        self.assertIn(".remote-access-public-status", self.remote_access_css)
        self.assertNotIn(".remote-access-public-state-icon", self.remote_access_css)
        self.assertIn(".remote-access-public-connection-indicator", self.remote_access_css)

    def test_host_requests_a_bounded_configurable_room_lifetime(self):
        self.assertIn('id="internet-remote-duration"', self.host_html)
        self.assertIn('min="1" max="24" step="1" value="12"', self.host_html)
        self.assertIn("DEFAULT_ROOM_LIFETIME_HOURS = 12", self.host_js)
        self.assertIn("MIN_ROOM_LIFETIME_HOURS = 1", self.host_js)
        self.assertIn("MAX_ROOM_LIFETIME_HOURS = 24", self.host_js)
        self.assertIn("lifetime_hours: lifetimeHours", self.host_js)
        self.assertIn('!/^\\d+$/u.test(durationValue)', self.host_js)
        self.assertIn('tr("internetRemote.durationInvalid"', self.host_js)
        self.assertNotIn("workerLifetime > (8 * 60 * 60 * 1000)", self.host_js)

    def test_playback_status_changes_reach_internet_peers_without_a_new_revision(self):
        # Play/pause and seek observations leave the core state revision unchanged.
        start = self.host_js.index("  function playbackStatusBaseline(status)")
        functions = self.host_js[start : self.host_js.index("  async function publishState(", start)]
        script = f"""
const assert = require('node:assert/strict');
let now = 0;
const performance = {{ now: () => now }};
const state = {{ playbackStatus: null }};
{functions}
const push = status => {{
  const changed = playbackStatusChanged(status);
  if (changed) state.playbackStatus = playbackStatusBaseline(status);
  return changed;
}};
const status = (playing, position) => ({{ playing, position_seconds: position, duration_seconds: 240 }});
assert.equal(push(status(true, 10)), true, 'first observation');
now = 3000;
assert.equal(push(status(true, 13)), false, 'steady playback follows the prediction');
assert.equal(push(status(false, 13)), true, 'pause');
now = 9000;
assert.equal(push(status(false, 13)), false, 'paused position stays put');
assert.equal(push(status(false, 60)), true, 'seek while paused');
assert.equal(push(status(true, 60)), true, 'resume');
assert.equal(push(null), true, 'program ended');
assert.equal(push(null), false);
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8",
            capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        publish = self.host_js[self.host_js.index("  async function publishState(") :]
        self.assertIn("nextRevision <= state.stateRevision && !playbackChanged", publish)
        self.assertIn("state.playbackStatus = playbackStatusBaseline(remoteState.player_status)", publish)

    def test_remote_public_card_shows_only_the_room_password(self):
        remote = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        card = remote[remote.index('id="remote-share-public"') : remote.index("</section>", remote.index('id="remote-share-public"'))]
        self.assertNotIn("internetRemote.publicScanTitle", card)
        self.assertIn('data-i18n="internetRemote.currentPassword"', card)
        self.assertIn('<strong id="remote-share-password">', card)

    def test_room_creation_failure_remains_visible_after_cleanup(self):
        start = self.host_js.index("async function startRoom")
        end = self.host_js.index("function expireRoom", start)
        source = self.host_js[start:end]
        catch = source.index("} catch (error) {")
        cleanup = source.index("stopRoom(false);", catch)
        failure_status = source.index('setStatus(message, "bad")', catch)
        self.assertLess(cleanup, failure_status)
        self.assertIn("state.roomFailure = true", source[catch:])

    def test_host_remote_results_show_only_the_local_url_and_share_one_layout(self):
        self.assertIn('id="internet-remote-room"', self.host_html)
        self.assertIn("remote-access-entry-content", self.host_html)
        self.assertIn('id="remote-popover-copy-link"', self.host_html)
        self.assertIn('id="internet-remote-copy-link"', self.host_html)
        self.assertNotIn('id="remote-popover-open-link"', self.host_html)
        self.assertNotIn('id="internet-remote-open-link"', self.host_html)
        self.assertIn("internet-remote-local-link remote-access-link", self.host_html)
        self.assertIn('class="internet-remote-link-target"', self.host_html)
        self.assertIn('class="internet-remote-live-region"', self.host_html)
        self.assertNotIn('class="remote-url-link" href="#"', self.host_html)
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn(".internet-remote-local-link { display: block;", styles)
        self.assertIn(".internet-remote-link-target { display: none; }", styles)
        self.assertIn("background: var(--settings-panel-bg);", styles)
        self.assertIn("grid-template-columns: 160px minmax(0, 1fr)", styles)
        self.assertIn(".internet-remote-divider", styles)

    def test_host_remote_lifecycle_uses_accepted_room_state(self):
        render_start = self.host_js.index("function render()")
        render_end = self.host_js.index("async function localPost", render_start)
        render = self.host_js[render_start:render_end]
        self.assertIn("const roomResultAvailable = Boolean(roomActive && state.remoteUrl)", render)
        self.assertIn('elements.room.classList.toggle("hidden", !roomResultAvailable)', render)
        self.assertIn('elements.stop.classList.toggle("hidden", !roomActive)', render)
        self.assertIn("passwordDraftChanged", render)
        self.assertIn("lifetimeDraftChanged", render)
        self.assertIn('tr("internetRemote.rebuildApply"', render)
        self.assertIn("state.password", render)
        self.assertNotIn("state.expiresAt", render)
        self.assertIn("state.expiresAt", self.host_js)
        self.assertNotIn('id="internet-remote-expiry"', self.host_html)
        self.assertEqual(self.host_js.count('localPost("/api/internet-remote/qr"'), 1)
        self.assertNotIn("setInterval(", self.host_js)

    def test_loopback_local_entry_is_not_presented_as_phone_shareable(self):
        self.assertIn("function remoteUrlUsesLoopback", self.host_app_js)
        self.assertIn('hostname.startsWith("127.")', self.host_app_js)
        self.assertIn('hostname === "::1"', self.host_app_js)
        self.assertIn("!remoteUrlUsesLoopback(value)", self.host_app_js)
        self.assertIn("renderRemoteQr(shareableUrl", self.host_app_js)
        self.assertIn('button.disabled = !shareableUrl', self.host_app_js)

    def test_missing_remote_address_never_becomes_host_homepage(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required")
        program = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('static/app.js','utf8');
const helpers=source.slice(source.indexOf('function normalizedRemoteHttpUrl('),source.indexOf('function renderRemoteAccess('));
const context={URL,window:{location:{href:'http://10.45.66.136:8080/'}}};
vm.createContext(context);vm.runInContext(helpers,context);
for(const value of [undefined,null,'','   ']) assert.equal(context.normalizedRemoteHttpUrl(value),'');
context.candidates=['',undefined,'http://10.45.66.136:8080/remote'];
assert.equal(vm.runInContext('candidates.map(normalizedRemoteHttpUrl).find(url=>url&&!remoteUrlUsesLoopback(url))',context),'http://10.45.66.136:8080/remote');
context.candidates=['',undefined,'http://127.0.0.1:8080/remote'];
assert.equal(vm.runInContext('candidates.map(normalizedRemoteHttpUrl).find(url=>url&&!remoteUrlUsesLoopback(url))',context),undefined);
'''
        result = subprocess.run([node, "-e", program], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_public_qr_failure_keeps_the_valid_room_result(self):
        start = self.host_js.index("async function startRoom")
        end = self.host_js.index("function expireRoom", start)
        source = self.host_js[start:end]
        qr_try = source.index('localPost("/api/internet-remote/qr"')
        qr_catch = source.index("} catch (error) {", qr_try)
        outer_catch = source.index("} catch (error) {", qr_catch + 1)
        self.assertIn("state.qrError = true", source[qr_catch:outer_catch])
        self.assertNotIn("stopRoom", source[qr_catch:outer_catch])

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
        self.assertIn('url.pathname === "/api/catalog/search"', self.remote_transport)
        self.assertIn('url.pathname === "/api/gatcha/search"', self.remote_transport)
        self.assertIn("internet_remote_unavailable", self.remote_transport)
        self.assertIn("url.origin !== global.location.origin", self.remote_transport)
        self.assertNotIn('request("http.request"', self.remote_transport)
        self.assertNotIn("/api/internet-remote/dispatch", self.remote_transport)

    def test_internet_adapter_preserves_click_time_command_identity(self):
        self.assertIn(
            'item_incarnation_id: String(item.item_incarnation_id || "")',
            self.remote_transport,
        )
        control_start = self.remote_transport.index(
            'url.pathname === "/api/player/control"'
        )
        control_end = self.remote_transport.index(
            'url.pathname === "/api/player/key-shift"', control_start
        )
        control = self.remote_transport[control_start:control_end]
        self.assertIn('item_id: String(body.item_id || "")', control)
        self.assertIn(
            "playback_generation: Number(body.playback_generation)", control
        )
        self.assertIn('"seek-absolute": "playback.seek_absolute"', control)
        self.assertIn(
            'if (action === "seek-absolute") payload.target_seconds =', control
        )
        self.assertIn("Math.round(Number(body.target_seconds || 0))", control)
        player_control_end = self.remote_transport.index(
            'url.pathname === "/api/player/next"', control_start
        )
        player_control_route = self.remote_transport[
            control_start:player_control_end
        ]
        self.assertEqual(player_control_route.count("response = await request("), 1)
        self.assertNotIn("nativeFetch(", player_control_route)

        cache_start = self.remote_transport.index(
            'url.pathname === "/api/cache/retry"'
        )
        cache_end = self.remote_transport.index(
            'url.pathname === "/api/player/control"', cache_start
        )
        cache = self.remote_transport[cache_start:cache_end]
        self.assertIn(
            'expected_item_incarnation_id: String(body.expected_item_incarnation_id || "")',
            cache,
        )

        self.assertIn("force: Boolean(body.force)", cache)

        variant_start = self.remote_transport.index(
            'url.pathname === "/api/player/audio-variant"'
        )
        variant_end = self.remote_transport.index(
            'url.pathname === "/api/rating/submit"', variant_start
        )
        variant = self.remote_transport[variant_start:variant_end]
        self.assertIn(
            'expected_item_incarnation_id: String(body.expected_item_incarnation_id || "")',
            variant,
        )

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

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_volume_transport_preserves_song_guard_and_stops_after_rejection(self):
        start = self.remote_transport.index('url.pathname === "/api/player/volume"')
        start = self.remote_transport.index("if (body.volume_percent", start)
        end = self.remote_transport.index('\n      } else if', start)
        body = self.remote_transport[start:end]
        script = '''
const assert = require("node:assert/strict");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const send = new AsyncFunction("body", "request", "let response;\\n" + BODY + "\\nreturn response;");
(async () => {
  const calls = [];
  const id = "i-0123456789abcdef0123456789abcdef-0000000000000001";
  await send({volume_percent:500, expected_item_incarnation_id:id, is_muted:false}, async (kind, payload) => {
    calls.push({kind, payload}); return {};
  });
  assert.deepEqual(calls[0], {kind:"player.set_volume", payload:{volume_percent:500, expected_item_incarnation_id:id}});
  calls.length = 0;
  await assert.rejects(send({volume_percent:500, expected_item_incarnation_id:id, is_muted:false}, async (kind) => {
    calls.push(kind); throw new Error("item_incarnation_mismatch");
  }), /item_incarnation_mismatch/);
  assert.deepEqual(calls, ["player.set_volume"]);
})().catch(error => { console.error(error); process.exitCode = 1; });
'''.replace("BODY", json.dumps(body))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_multiline_request_paste_preserves_url_boundaries_and_selection(self):
        for page in [self.host_html, self.remote_html]:
            self.assertIn('src="/request-input.js"', page)
        self.assertIn('"request-input.js"', self.asset_sync)
        script = r'''const assert = require("node:assert/strict");
let paste, inputs=0;
const input={value:"prefix OLD suffix",selectionStart:7,selectionEnd:10,
  addEventListener:(type,fn)=>{assert.equal(type,"paste");paste=fn;},
  dispatchEvent:event=>{assert.equal(event.type,"input");inputs++;},
  setRangeText(text,start,end,mode){assert.equal(mode,"end");this.value=this.value.slice(0,start)+text+this.value.slice(end);}};
globalThis.document={getElementById:id=>{assert.equal(id,"url-input");return input;}};
require("./static/request-input.js");
let prevented=0;
const event=text=>({clipboardData:{getData:()=>text},preventDefault:()=>{prevented++;}});
paste(event("Song title\nhttps://youtu.be/YE7VzlLtp-4\r\n#karaoke"));
assert.equal(input.value,"prefix Song title https://youtu.be/YE7VzlLtp-4 #karaoke suffix");
assert.equal(prevented,1);assert.equal(inputs,1);
paste(event("https://youtu.be/YE7VzlLtp-4"));assert.equal(prevented,1);
input.disabled=true;paste(event("title\nhttps://youtu.be/YE7VzlLtp-4"));assert.equal(prevented,1);
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_youtube_urls_and_share_text_match_rust_input_fixtures(self):
        start = self.remote_transport.index('  function youtubeVideoId(')
        end = self.remote_transport.index('\n  async function ', start)
        script = r'''const assert = require("node:assert/strict");
const fs = require("node:fs");
SOURCE
const cases = JSON.parse(fs.readFileSync("tests/fixtures/youtube_inputs.json", "utf8"));
for (const row of cases) {
  if (row.error) assert.throws(()=>youtubeVideoId(row.input), /YouTube/, row.input);
  else assert.equal(youtubeVideoId(row.input), row.video_id, row.input);
  if (row.video_id) {
    assert.equal(catalogId(row.input), `youtube:${row.video_id}`, row.input);
    assert.throws(()=>catalogId(row.input, 2), /YouTube/);
  }
}
assert.equal(catalogId("BV1xx411c7mD"), "BV1xx411c7mD");
assert.equal(catalogId("https://www.bilibili.com/video/BV1xx411c7mD?p=2"), "BV1xx411c7mD_p2");
'''.replace("SOURCE", self.remote_transport[start:end])
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_public_drag_keeps_the_captured_queue_version_when_sending_later(self):
        start = self.remote_transport.index('response = await request("playlist.move",')
        end = self.remote_transport.index('\n      } else if', start)
        script = r'''const assert = require("node:assert/strict");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const send = new AsyncFunction("body", "request", "expectedRevision", "let response;\n" + BODY);
(async()=>{
  let observed;
  await send({item_id:"old-target",index:1200,expected_queue_version:"a".repeat(64)},async(kind,body)=>{observed={kind,body};},()=>999);
  assert.deepEqual(observed,{kind:"playlist.move",body:{item_id:"old-target",target_index:1200,expected_queue_version:"a".repeat(64),expected_revision:999}});
})().catch(error=>{console.error(error);process.exitCode=1;});'''.replace("BODY", json.dumps(self.remote_transport[start:end]))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_full_public_queue_roundtrips_chunking_and_limits_malicious_buffers(self):
        script = r'''const assert = require("node:assert/strict");
require("./static/internet-remote-transport.js");
const api = globalThis.BilikaraInternetTransport;
const playlist = Array.from({length:10000}, (_, i) => ({id:`song-${i}`, title:"中文歌曲/日本語の曲".repeat(8)}));
const payload = {type:"state", data:{playlist}};
const frames = [];
api.send({readyState:"open",send:frame=>frames.push(frame)}, payload);
assert.ok(frames.length > 128);
const decoder = new api.Decoder();
const decoded = frames.flatMap(frame=>decoder.consume(frame));
assert.deepEqual(decoded, [payload]);
const bad = new api.Decoder();
assert.throws(()=>bad.consume(JSON.stringify({type:"__chunk",transfer_id:"bad",index:0,total:2,total_bytes:1,data:"too big"})), /Corrupt/);
assert.equal(bad.pending.size, 0);
(async () => {
  const channel = new EventTarget();
  channel.readyState = "open"; channel.bufferedAmount = 0;
  let sent = 0, maximum = 0;
  channel.send = frame => {
    sent++; channel.bufferedAmount += new TextEncoder().encode(frame).length;
    maximum = Math.max(maximum, channel.bufferedAmount);
    setTimeout(() => { channel.bufferedAmount = 0; channel.dispatchEvent(new Event("bufferedamountlow")); }, 0);
  };
  await api.send(channel, payload, {buffered:true});
  assert.equal(sent, frames.length);
  assert.ok(maximum <= 140 * 1024, maximum);
})().catch(error=>{console.error(error); process.exitCode=1;});
for (let i=0;i<2;i++) bad.consume(JSON.stringify({type:"__chunk",transfer_id:`big-${i}`,index:0,total:2,total_bytes:32*1024*1024,data:"x"}));
assert.throws(()=>bad.consume(JSON.stringify({type:"__chunk",transfer_id:"overflow",index:0,total:2,total_bytes:1,data:"x"})), /Too many/);
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_retry_transport_preserves_force_true_false_and_legacy_absence(self):
        start = self.remote_transport.index('response = await request("cache.retry", {')
        end = self.remote_transport.index('\n      } else if', start)
        script = r'''const assert = require("node:assert/strict");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const send = new AsyncFunction("body", "request", "expectedRevision", "let response;\n" + BODY + "\nreturn response;");
(async()=>{
  for(const force of [undefined,false,true]){
    let observed;
    await send({item_id:"song",expected_item_incarnation_id:"incarnation",force},async(kind,body)=>{observed={kind,body};},()=>12);
    assert.deepEqual(observed,{kind:"cache.retry",body:{item_id:"song",expected_item_incarnation_id:"incarnation",force:force===true,expected_revision:12}});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});'''.replace("BODY", json.dumps(self.remote_transport[start:end]))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

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
        self.assertIn("function remoteResultPaginationOptions", self.remote_js)
        self.assertIn(
            "fetchGatchaBrowse(selected, query, page)",
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
        self.assertIn("function remoteResultPaginationOptions", self.remote_js)
        self.assertIn(
            "fetchGatchaFavlistBrowse(selected, query, page)", self.remote_js
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
        self.assertIn("async function stopInternetRoom", self.host_js)
        self.assertIn('elements.stop.addEventListener("click"', self.host_js)

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

    def test_playlist_add_waits_for_host_metadata_resolution(self):
        self.assertIn(
            "const playlistAddRequestTimeoutMs = 60_000;", self.remote_transport
        )
        start = self.remote_transport.index(
            'if (method === "POST" && url.pathname === "/api/playlist/add")'
        )
        end = self.remote_transport.index(
            'else if (method === "POST" && url.pathname === "/api/playlist/reorder")',
            start,
        )
        source = self.remote_transport[start:end]
        self.assertIn('}, "control", playlistAddRequestTimeoutMs)', source)

    def test_foreground_resume_probes_live_channel_before_reconnecting(self):
        self.assertIn("function probeHeartbeat", self.remote_transport)
        self.assertIn("function refreshHeartbeatAfterForeground", self.remote_transport)
        self.assertIn(
            'global.addEventListener("pageshow", refreshHeartbeatAfterForeground)',
            self.remote_transport,
        )
        self.assertIn(
            'document.addEventListener("visibilitychange"', self.remote_transport
        )
        refresh_start = self.remote_transport.index(
            "function refreshHeartbeatAfterForeground"
        )
        refresh_end = self.remote_transport.index("function request", refresh_start)
        refresh_source = self.remote_transport[refresh_start:refresh_end]
        self.assertIn("probeHeartbeat({ freshGrace: true })", refresh_source)

    def test_heartbeat_grants_a_fresh_probe_after_timer_suspension(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is unavailable")
        start = self.remote_transport.index("function probeHeartbeat")
        end = self.remote_transport.index("function startHeartbeat", start)
        probe_source = self.remote_transport[start:end]
        script = f"""
const heartbeatTimeoutMs = 8000;
let now = 1000;
Date.now = () => now;
let reconnects = 0;
const sent = [];
const state = {{
  authorized: true,
  control: {{ readyState: "open" }},
  lastPongAt: 0,
  heartbeatProbeAt: 0,
  heartbeatLastTickAt: 0,
}};
const lowLevel = {{ send: (_channel, message) => sent.push(message.at) }};
function scheduleReconnect() {{ reconnects += 1; }}
{probe_source}
probeHeartbeat();
now = 3000;
probeHeartbeat();
now = 12001;
probeHeartbeat();
state.lastPongAt = state.heartbeatProbeAt;
now = 14001;
probeHeartbeat();
for (now of [16001, 18001, 20001, 22001, 24001]) probeHeartbeat();
console.log(JSON.stringify({{ sent, reconnects }}));
"""
        completed = subprocess.run(
            [node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(completed.stdout.strip()),
            {"sent": [1000, 12001, 14001], "reconnects": 1},
        )

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_public_rename_revalidates_identity_and_preserves_newer_broadcasts(self):
        script = r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('static/remote-transport-client.js', 'utf8').replace(
  '})(globalThis);',
  'globalThis.adapter={state,fetchInternet,publishState,stub:fn=>{request=fn;}}; })(globalThis);'
);
const storage=new Map();
const sandbox={fetch:async()=>{throw new Error('Unexpected network request');},
 location:{hash:'#room=fixture',origin:'https://example.test',href:'https://example.test/#room=fixture'},
 localStorage:{getItem:key=>storage.get(key)||'',setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
 URLSearchParams,URL,Response,Headers,queueMicrotask,setTimeout:()=>1,clearTimeout:()=>{},clearInterval:()=>{},
 navigator:{onLine:true},addEventListener:()=>{},dispatchEvent:()=>{},Event:class{},
 BilikaraInternetTransport:{randomBase64Url:()=> 'fixture',Decoder:class{}},
 document:{addEventListener:()=>{},documentElement:{dataset:{}}}};
vm.runInNewContext(source,sandbox);
const {state,fetchInternet,publishState,stub}=sandbox.adapter;
const id='a'.repeat(64);
const roster=(revision,name)=>({state_epoch:'epoch',revision,session_generation:1,session_user_edit_version:1,
 session_users:[name],session_user_entries:[{id,name}],player_settings:{}});
(async()=>{
 state.authorized=true;state.identity='Alice';state.identityUserId=id;
 publishState(roster(1,'Alice'));
 const calls=[];
 stub(async(kind,body)=>{calls.push({kind,body});return {data:{name:'Alice',state:roster(1,'Alice')}};});
 const post=(route,body)=>fetchInternet(route,{method:'POST',body:JSON.stringify(body)});
 await post('/api/remote-identity/register',{name:'Alice'});
 assert.equal(calls[0].kind,'session.set_identity'); // Same-name requests still reach Rust.
 stub(async(kind,body)=>{calls.push({kind,body});publishState(roster(3,'Latest'));return {data:{name:'Aimer',state:roster(2,'Aimer')}};});
 let response=await (await post('/api/remote-identity/rename',{name:'Aimer',user_id:id,expected_name:'Alice'})).json();
 assert.equal(calls[1].kind,'session.rename');assert.equal(calls[1].body.user_id,id);
 assert.equal(response.data.name,'Latest');assert.equal(response.data.user_id,id);
 assert.equal(storage.get('bilikara.internetRemote.identity.v1.fixture.userId'),id);
 publishState({...roster(4,''),session_users:[],session_user_entries:[]});
 assert.equal(state.identity,'');assert.equal(state.identityUserId,'');
 assert.equal(storage.has('bilikara.internetRemote.identity.v1.fixture.userId'),false);
 // Older Hosts must never receive the old rename-as-registration request.
 state.remoteState.session_user_edit_version=0;
 response=await post('/api/remote-identity/rename',{name:'Old host'});
 assert.equal(response.status,409);assert.equal(calls.length,2);
 console.log('ok');
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
        completed = subprocess.run([shutil.which("node"), "-e", script], capture_output=True,
                                   text=True, encoding="utf-8", timeout=10, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "ok")

    def test_control_and_bulk_requests_have_independent_ordered_queues(self):
        self.assertIn('queues: { control: Promise.resolve(), bulk: Promise.resolve() }', self.host_js)
        self.assertIn('peer.queues[lane] = peer.queues[lane].then', self.host_js)
        self.assertIn('lane === "control" && message?.type === "ping"', self.host_js)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required")
    def test_public_projection_and_disconnect_never_replay_cached_state_as_live(self):
        script = r'''
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync("static/remote-transport-client.js", "utf8").replace(
  "})(globalThis);",
  "globalThis.testAdapter = {state, localState, createStateSource, scheduleReconnect, disconnect, handleDataMessage}; })(globalThis);",
);
const sandbox = {
  fetch: () => {}, location: {hash: "#room=fixture", origin: "https://example.test"},
  localStorage: {getItem: () => "", setItem: () => {}}, URLSearchParams,
  navigator: {onLine: true}, queueMicrotask, clearTimeout: () => {}, clearInterval: () => {},
  setTimeout: () => 1, addEventListener: () => {}, dispatchEvent: () => {},
  Event: class {}, BilikaraInternetTransport: {randomBase64Url: () => "fixture", Decoder: class {}},
  document: {addEventListener: () => {}, documentElement: {dataset: {}}},
};
vm.runInNewContext(source, sandbox);
const {state, localState, createStateSource, scheduleReconnect, disconnect, handleDataMessage} = sandbox.testAdapter;
(async () => {
  const data = {revision: 1, player_settings: {effective_av_delay_ms: 50,
    av_delay_locked: false, av_delay_lock_button_enabled: false, av_delay_has_local_adjustment: false},
    current_item: {id: "fixture", display_title: "Song", cache_status: "downloading"}, bilibili_logged_in: false};
  let local = localState(data);
  assert.equal(local.player_settings.av_delay.has_local_adjustment, false);
  assert.equal(local.player_settings.av_delay.lock_button_enabled, false);
  assert.equal(local.bbdown.logged_in, false);
  assert.equal(local.capabilities.source_queue, false);
  assert.equal(local.capabilities.source_queue_titles, false);
  data.capabilities = {source_queue: true, source_queue_titles: true, event_heartbeat: true};
  data.gatcha = {background_busy: true, source_queue: {pending: [{uid: "123"}]}};
  local = localState(data);
  assert.equal(local.capabilities.source_queue, true);
  assert.equal(local.capabilities.source_queue_titles, true);
  assert.equal(local.capabilities.event_heartbeat, undefined);
  assert.equal(local.gatcha.source_queue.pending[0].uid, "123");
  data.capabilities.source_queue = false;
  assert.equal(localState(data).capabilities.source_queue, false);

  assert.equal(local.current_item.video_media_url, "");
  data.player_settings.av_delay_has_local_adjustment = true;
  data.player_settings.av_delay_lock_button_enabled = true;
  data.bilibili_logged_in = true;
  data.current_item.cache_status = "ready";
  data.session_played = [{item_id: "previous", bvid: "BV1z84y1p7oS", threshold_reached: true}];
  data.song_ratings = [{session_user_name: "Alice", play_id: "fixture", status: "waiting"}];
  local = localState(data);
  assert.equal(local.session_played[0].item_id, "previous");
  assert.equal(local.session_played[0].threshold_reached, true);
  assert.equal(local.song_ratings[0].status, "waiting");
  assert.equal(local.player_settings.av_delay.has_local_adjustment, true);
  assert.equal(local.player_settings.av_delay.lock_button_enabled, true);
  assert.equal(local.bbdown.logged_in, true);
  assert.equal(local.current_item.video_media_url, "internet-remote://video");
  for (const online of [true, false]) {
    sandbox.navigator.onLine = online;
    state.authorized = true; state.password = "fixture"; state.reconnectTimer = null;
    state.remoteState = data;
    const events = []; const stream = createStateSource();
    stream.addEventListener("state", e => events.push(e.type));
    stream.addEventListener("error", e => events.push(e.type));
    await Promise.resolve(); assert.deepEqual(events, ["state"]);
    scheduleReconnect(); assert.deepEqual(events, ["state", "error"]);
    handleDataMessage({type: "state", data: {...data, revision: 2}});
    assert.deepEqual(events, ["state", "error"]);
    stream.close();
    const reconnectEvents = []; const replacement = createStateSource();
    replacement.addEventListener("state", e => reconnectEvents.push(e.type));
    replacement.addEventListener("error", e => reconnectEvents.push(e.type));
    await Promise.resolve(); assert.deepEqual(reconnectEvents, ["error"]);
    replacement.close();
  }
  state.authorized = true; state.remoteState = {...data,state_epoch:"old-host",state_revision:35};
  const restarting = createStateSource(); const revisions = [];
  restarting.addEventListener("state", e => revisions.push(JSON.parse(e.data)));
  await Promise.resolve();
  handleDataMessage({type:"state",data:{...data,state_epoch:"new-host",state_revision:4}});
  handleDataMessage({type:"state",data:{...data,state_epoch:"old-host",state_revision:99}});
  handleDataMessage({type:"state",data:{...data,state_epoch:"new-host",state_revision:3}});
  assert.equal(revisions.length,2);
  assert.equal(revisions[1].state_revision,4);
  assert.equal(revisions[1].state_epoch,"new-host");
  assert.equal(state.remoteState.state_epoch,"new-host");
  restarting.close();
  state.authorized = true; state.remoteState = data;
  const events = []; const stream = createStateSource();
  stream.addEventListener("state", e => events.push(e.type));
  stream.addEventListener("error", e => events.push(e.type));
  await Promise.resolve(); disconnect();
  assert.deepEqual(events, ["state", "error"]);
  assert.equal(state.authorized, false);
})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, encoding="utf-8", capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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
            "accent-palette.css",
            "export-download.js",
            "export-guard.js",
            "remote.html",
            "remote.css",
            "remote.js",
            "result-pagination.css",
            "result-pagination.js",
            "browse-search.js",
            "search-result-media.css",
            "search-result-media.js",
            "remote-queue.css",
            "remote-queue.js",
            "song-detail.css",
            "song-detail.js",
            "i18n.json",
            "internet-remote-transport.js",
            "remote-transport-client.js",
            "qrcode-generator.js",
            "qrcode-generator.LICENSE",
            "remote-access.css",
        ):
            with self.subTest(asset=asset):
                self.assertIn(f'"{asset}"', self.asset_sync)
        self.assertIn('Join-Path $staticRoot "pic"', self.asset_sync)
        self.assertIn('$ErrorActionPreference = "Stop"', self.asset_sync)
        self.assertIn("[System.IO.Path]::IsPathRooted($Destination)", self.asset_sync)

    def test_remote_invitation_is_authorized_unexpired_and_preserves_fragment(self):
        start = self.remote_transport.index("  function invitation()")
        end = self.remote_transport.index("  const invitationRemainingMs", start)
        source = self.remote_transport[start:end]
        script = """
const assert = require("node:assert/strict");
const global = { location: { origin: "https://example.invalid" } };
const roomId = "A".repeat(27), joinToken = "B".repeat(43);
const state = { authorized: false, password: "synthetic-password" };
const fragment = new URLSearchParams({ expires: String(Date.now() + 60000) });
""" + source + """
assert.equal(invitation(), null);
state.authorized = true;
const shared = invitation();
const url = new URL(shared.url);
assert.equal(url.pathname, "/remote.html");
const params = new URLSearchParams(url.hash.slice(1));
assert.equal(params.get("room"), roomId);
assert.equal(params.get("join"), joinToken);
assert.equal(params.get("expires"), fragment.get("expires"));
assert.equal(params.has("password"), false);
assert.equal(shared.password, state.password);
fragment.set("expires", String(Date.now() - 1));
assert.equal(invitation(), null);
fragment.set("expires", "invalid");
assert.equal(invitation(), null);
fragment.set("expires", String(Date.now() + 60000));
state.password = "";
assert.equal(invitation(), null);
"""
        node = shutil.which("node")
        if not node:
            self.skipTest("node is unavailable")
        result = subprocess.run([node, "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        qr_start = self.remote_js.index("function renderRemoteQr(")
        qr_end = self.remote_js.index("function setFormMessage", qr_start)
        qr_source = self.remote_js[qr_start:qr_end]
        self.assertNotIn("qrserver.com", qr_source)
        self.assertIn("window.qrcode(0", qr_source)
        self.assertIn("placeholder.replaceChildren(qr)", qr_source)
        self.assertNotIn("data:image", qr_source)


if __name__ == "__main__":
    unittest.main()
