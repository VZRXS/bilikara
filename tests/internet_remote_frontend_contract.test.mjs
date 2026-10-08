import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, firstMatch, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const InternetRemoteFrontendTest = {
async setUpClass() {
this.host_html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.host_js = readFileSync(path.join(path.join(ROOT, "static"), "internet-remote-host.js"), "utf8");
this.host_app_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.remote_access_css = readFileSync(path.join(path.join(ROOT, "static"), "remote-access.css"), "utf8");
this.remote_html = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.remote_transport = readFileSync(path.join(path.join(ROOT, "static"), "remote-transport-client.js"), "utf8");
this.remote_css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.asset_sync = readFileSync(path.join(path.join(ROOT, "scripts"), "sync_internet_remote_assets.ps1"), "utf8");
this.server_source = readFileSync(path.join(path.join(ROOT, "bilikara"), "server.py"), "utf8");
},
async test_host_exposes_local_and_internet_modes_without_replacing_local_remote() {
assert.ok(contains("id=\"internet-remote-local-content\"", this.host_html));
assert.ok(contains("id=\"internet-remote-disclosure\"", this.host_html));
assert.match(this.host_html, new RegExp("id=\"remote-popover-url-link\"[^>]+aria-disabled=\"true\"",""));
assert.ok(contains("state.mode = \"local\"", this.host_js));
},
async test_host_uses_one_mobile_remote_entry_with_a_collapsed_public_menu() {
let disclosure, disclosure_handler, internet_content, local_content, popover;
assert.ok(!contains("class=\"status-chip internet-remote-status-chip\"", this.host_html));
popover = sourceIndex(this.host_html, "id=\"remote-mini-popover\"");
local_content = sourceIndex(this.host_html, "id=\"internet-remote-local-content\"");
disclosure = sourceIndex(this.host_html, "id=\"internet-remote-disclosure\"");
internet_content = sourceIndex(this.host_html, "id=\"internet-remote-internet-content\"");
assert.ok(popover < local_content);
assert.ok(local_content < disclosure);
assert.ok(disclosure < internet_content);
assert.ok(contains("id=\"internet-remote-internet-content\"", this.host_html));
disclosure_handler = this.host_js.slice(sourceIndex(this.host_js, "elements.disclosureRow.addEventListener(\"click\""), sourceIndex(this.host_js, "elements.restart.addEventListener(\"click\""));
assert.ok(!contains("startRoom", disclosure_handler));
assert.ok(contains("event.target.closest(\".cache-advanced-info\")", disclosure_handler));
},
async test_fullscreen_remote_card_uses_the_same_compact_public_summary() {
let render_end, render_source, render_start;
assert.ok(contains("id=\"player-fullscreen-local-entry\"", this.host_html));
assert.ok(contains("id=\"player-fullscreen-public-meta\"", this.host_html));
assert.ok(contains("id=\"player-fullscreen-public-qr-image\"", this.host_html));
assert.ok(contains("id=\"player-fullscreen-public-room\"", this.host_html));
assert.ok(contains("id=\"player-fullscreen-public-password\"", this.host_html));
assert.ok(!contains("id=\"player-fullscreen-internet-password\"", this.host_html));
assert.ok(contains("new CustomEvent(\"bilikara:internet-remote-display\"", this.host_js));
assert.ok(contains("internetRemoteDisplay: null", this.host_app_js));
assert.ok(contains("document.addEventListener(\"bilikara:internet-remote-display\"", this.host_app_js));
render_start = sourceIndex(this.host_app_js, "function renderPlayerFullscreenRemoteAccess");
render_end = sourceIndex(this.host_app_js, "async function copyRemoteUrl", render_start);
render_source = this.host_app_js.slice(render_start, render_end);
assert.ok(contains("renderPlayerFullscreenRemoteAccess", render_source));
assert.ok(contains("renderProvidedRemoteQr", render_source));
assert.ok(contains("playerFullscreenPublicMeta", render_source));
assert.ok(contains("playerFullscreenPublicRoom", render_source));
assert.ok(contains("internetActive", render_source));
assert.ok(contains("internetPassword", render_source));
},
async test_compact_hover_keeps_active_public_qr_without_room_controls() {
let compact_rule, styles;
assert.ok(contains("classList.toggle(\"has-active-internet-room\", roomResultAvailable)", this.host_js));
assert.ok(contains("const compactRoomPreviewVisible = !fullMenuOpen && roomResultAvailable", this.host_js));
assert.ok(contains("const currentPasswordVisible = roomResultAvailable;", this.host_js));
assert.ok(contains("? state.password", this.host_js));
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
compact_rule = styles.slice(sourceIndex(styles, ".remote-mini-control:not(.is-qr-pinned) :is("), sourceIndex(styles, ".status-chip {", sourceIndex(styles, ".remote-mini-control:not(.is-qr-pinned) :is(")));
assert.ok(contains(".internet-remote-config-row", compact_rule));
assert.ok(contains(".internet-remote-actions", compact_rule));
assert.ok(contains(".has-active-internet-room", compact_rule));
assert.ok(!contains(`.internet-remote-internet-content
)`, compact_rule));
assert.ok(contains("href=\"/remote-access.css\"", this.host_html));
assert.ok(contains("grid-template-columns: repeat(2, minmax(0, 1fr))", this.remote_access_css));
assert.ok(contains(".is-local-only-preview", this.remote_access_css));
assert.ok(contains(".is-management-layout", this.remote_access_css));
assert.ok(contains(".remote-access-expand-hint", this.remote_access_css));
assert.ok(contains(".remote-access-card.is-local-only-preview .remote-access-copy-title", this.remote_access_css));
assert.ok(!contains(":lang(zh)", this.remote_access_css));
},
async test_access_popovers_share_opaque_dark_surfaces_and_translation_keys() {
let languages;
assert.ok(contains(":root:is([data-theme=\"dark\"], [data-theme=\"blue\"]) .remote-access-card", this.remote_access_css));
assert.ok(contains("background: var(--modal-card-bg);", this.remote_access_css));
assert.ok(contains("border: var(--modal-card-border);", this.remote_access_css));
assert.ok(contains("box-shadow: var(--rating-card-shadow);", this.remote_access_css));
assert.deepEqual(countOccurrences(this.host_html, "data-i18n=\"internetRemote.localScanTitle\""), 2);
assert.deepEqual(countOccurrences(this.host_html, "data-i18n=\"internetRemote.publicScanTitle\""), 2);
languages = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
assert.deepEqual(languages["zh"]["internetRemote.publicScanTitle"], "扫码后输入房间密码");
assert.deepEqual(languages["en"]["internetRemote.publicScanTitle"], "Scan, then enter password");
assert.deepEqual(languages["ja"]["internetRemote.publicScanTitle"], "QRを読み取り、パスワードを入力");
},
async test_public_and_local_qr_use_complete_images_with_one_shared_quiet_zone() {
let local_qr_rule, qr_rule, rule;
assert.ok(contains("rust_runtime.generate_qr_image(remote_url, border=0)", this.server_source));
assert.ok(!contains("import qrcode", this.server_source));
qr_rule = splitOnce(firstMatch(Array.from(Array.from(iterableValues(this.remote_access_css.split(".remote-access-qr {").slice(1, undefined))) .filter((rule) => (contains("width: 160px", splitOnce(rule, "}")[0])))).map((rule) => rule)), "}")[0];
assert.ok(contains("width: 160px", qr_rule));
assert.ok(contains("height: 160px", qr_rule));
assert.ok(contains("padding: 3px", qr_rule));
assert.ok(!contains(".remote-access-entry--public .remote-access-qr img", this.remote_access_css));
local_qr_rule = this.remote_access_css.match(new RegExp("\\.remote-access-entry--local \\.remote-access-qr\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("justify-self: start", local_qr_rule));
},
async test_hover_preview_and_pinned_menu_have_explicit_shared_ownership() {
let styles;
assert.ok(contains("new CustomEvent(\"bilikara:remote-access-menu\"", this.host_app_js));
assert.ok(contains("document.addEventListener(\"bilikara:remote-access-menu\"", this.host_js));
assert.ok(contains("elements.disclosure.tabIndex = fullMenuOpen ? 0 : -1", this.host_js));
assert.ok(contains("const fullInternetContentVisible = fullMenuOpen && state.internetExpanded", this.host_js));
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
assert.ok(contains(".remote-mini-control:not(.is-qr-pinned)", styles));
assert.ok(contains(".internet-remote-internet-content", styles));
assert.ok(contains("!fullMenuOpen && !roomResultAvailable", this.host_js));
assert.ok(contains("classList.toggle(\"is-management-layout\"", this.host_app_js));
},
async test_internet_remote_scripts_load_before_the_host_application() {
let adapter, application, transport;
transport = sourceIndex(this.host_html, "src=\"/internet-remote-transport.js\"");
adapter = sourceIndex(this.host_html, "src=\"/internet-remote-host.js\"");
application = sourceIndex(this.host_html, "src=\"/app.js\"");
assert.ok(transport < adapter);
assert.ok(adapter < application);
},
async test_host_room_secrets_stay_in_fragment_and_websocket_subprotocol() {
assert.ok(contains("/remote.html#room=", this.host_js));
assert.ok(contains("`host.${state.hostToken}.${state.hostPeerId}`", this.host_js));
assert.ok(!contains("?host=", this.host_js));
assert.ok(!contains("?join=", this.host_js));
},
async test_current_access_entry_labels_exist_in_every_language() {
let language, languages, messages, required;
languages = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
required = new Set(["remote.openInBrowser", "internetRemote.localEntry", "internetRemote.localHint", "internetRemote.localScanTitle", "internetRemote.localSameNetwork", "internetRemote.localNoLanAddress", "internetRemote.openOnThisDevice", "internetRemote.localEntryDescription", "internetRemote.internetEntry", "internetRemote.description", "internetRemote.password", "internetRemote.duration", "internetRemote.durationUnit", "internetRemote.durationHint", "internetRemote.durationInvalid", "internetRemote.regenerate", "internetRemote.create", "internetRemote.stop", "internetRemote.createdStatus", "internetRemote.publicScanTitle", "internetRemote.expiryCompact", "internetRemote.currentPassword", "internetRemote.openFullMenu", "internetRemote.rebuildApply", "internetRemote.capacityReached"]);
for (const [language, messages] of iterableValues(Object.entries(languages))) {
{
assert.ok(hasContent(Array.from(required).every(value => contains(value, messages))));
}
}
},
async test_host_remote_explanations_use_contextual_info_bubbles() {
assert.ok(contains("id=\"internet-remote-mode-description\" role=\"tooltip\"", this.host_html));
assert.ok(contains("id=\"internet-remote-public-description\" role=\"tooltip\"", this.host_html));
assert.ok(contains("id=\"internet-remote-duration-hint\" class=\"cache-advanced-tooltip\"", this.host_html));
assert.ok(!contains("internet-remote-mode-copy", this.host_html));
assert.ok(!contains("id=\"internet-remote-meta\"", this.host_html));
assert.ok(contains("data-i18n=\"internetRemote.localEntryDescription\"", this.host_html));
assert.ok(!contains("id=\"internet-remote-local-address-detail\"", this.host_html));
assert.ok(contains("id=\"remote-popover-url-link\"", this.host_html));
assert.ok(contains("id=\"remote-popover-copy-link\"", this.host_html));
assert.ok(contains("本地 Remote 仍可同时使用", this.host_html));
assert.ok(contains(`setStatus(state.available
      ? ""`, this.host_js));
assert.ok(!contains("t(\"internetRemote.localAddressDetail\", { url: shareableUrl })", this.host_app_js));
assert.ok(contains("function resetContextualTooltipPosition", this.host_app_js));
assert.ok(contains("resetContextualTooltipPosition(info);", this.host_app_js));
},
async test_local_entry_copy_names_devices_and_host_without_platform_assumptions() {
let default_hint, language, languages, messages, render, render_end, render_start, same_network;
languages = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
for (const [language, messages] of iterableValues(Object.entries(languages))) {
{
same_network = messages["internetRemote.localSameNetwork"];
default_hint = messages["remote.defaultHint"];
assert.ok(contains("Host", same_network));
assert.ok(contains("Host", default_hint));
}
}
assert.deepEqual(languages["en"]["internetRemote.localSameNetwork"], "Same network as Host");
assert.deepEqual(languages["ja"]["internetRemote.localSameNetwork"], "Host と同じネットワーク");
assert.deepEqual(languages["en"]["remote.openInBrowser"], "Open Remote");
assert.deepEqual(languages["en"]["internetRemote.localScanTitle"], "Scan to connect");
assert.deepEqual(languages["en"]["internetRemote.publicScanTitle"], "Scan, then enter password");
assert.deepEqual(languages["ja"]["remote.openInBrowser"], "Remote を開く");
assert.deepEqual(languages["ja"]["internetRemote.localScanTitle"], "QRを読み取って接続");
assert.deepEqual(languages["ja"]["internetRemote.publicScanTitle"], "QRを読み取り、パスワードを入力");
render_start = sourceIndex(this.host_app_js, "function renderRemoteAccess");
render_end = sourceIndex(this.host_app_js, "function renderRemoteQr", render_start);
render = this.host_app_js.slice(render_start, render_end);
assert.ok(contains("setTextContent(elements.remotePopoverUrlHint, displayHint)", render));
assert.ok(contains("localHint: displayHint", render));
assert.ok(contains("hint: t(\"internetRemote.localSameNetwork\")", this.host_app_js));
},
async test_host_remote_entry_controls_use_shared_control_geometry() {
let styles;
assert.ok(contains("class=\"internet-remote-config-row\"", this.host_html));
assert.ok(contains("class=\"internet-remote-duration-unit\"", this.host_html));
assert.ok(contains("id=\"internet-remote-stop\"", this.host_html));
assert.ok(!contains("class=\"internet-remote-mode-row\"", this.host_html));
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
assert.ok(contains("min-height: var(--host-control-height, 44px)", styles));
assert.ok(contains("border-radius: var(--host-control-radius, 14px)", styles));
assert.ok(contains("font-size: 12px", this.remote_access_css));
assert.ok(contains(".internet-remote-disclosure-meta.is-active { color: var(--green)", styles));
assert.ok(contains("padding-right: 40px; text-align: right", styles));
},
async test_remote_room_and_display_refresh_controls_share_the_host_svg() {
let canonical_path, display_end, display_start, room_end, room_start;
canonical_path = "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5";
room_start = sourceIndex(this.host_html, "id=\"internet-remote-regenerate\"");
room_end = sourceIndex(this.host_html, "</button>", room_start);
display_start = sourceIndex(this.host_html, "id=\"presentation-refresh-button\"");
display_end = sourceIndex(this.host_html, "</button>", display_start);
assert.ok(contains(canonical_path, this.host_html.slice(room_start, room_end)));
assert.ok(contains(canonical_path, this.host_html.slice(display_start, display_end)));
},
async test_host_remote_entry_statuses_do_not_use_indicator_dots() {
let popover, popover_end, popover_start;
popover_start = sourceIndex(this.host_html, "id=\"remote-mini-popover\"");
popover_end = sourceIndex(this.host_html, "id=\"presentation-settings\"", popover_start);
popover = this.host_html.slice(popover_start, popover_end);
assert.ok(!contains("presentation-state-dot", popover));
assert.ok(contains("internet-remote-entry-title remote-access-title", popover));
assert.ok(!contains("remote-access-public-state-icon", popover));
assert.ok(contains("remote-access-public-connection-indicator", popover));
assert.ok(contains("internet-remote-public-connection-count", popover));
assert.ok(contains("remote-access-public-status", popover));
assert.ok(contains("connected_count: active ? connectedCount : 0", this.host_js));
assert.ok(contains("elements.publicMeta.classList.toggle(\"is-active\", roomActive && !state.busy)", this.host_js));
},
async test_shared_two_column_preview_uses_one_local_detail_order() {
let fullscreen_end, fullscreen_local, fullscreen_start, main_end, main_local, main_start;
main_start = sourceIndex(this.host_html, "id=\"internet-remote-local-content\"");
main_end = sourceIndex(this.host_html, "</section>", main_start);
main_local = this.host_html.slice(main_start, main_end);
fullscreen_start = sourceIndex(this.host_html, "id=\"player-fullscreen-local-entry\"");
fullscreen_end = sourceIndex(this.host_html, "</section>", fullscreen_start);
fullscreen_local = this.host_html.slice(fullscreen_start, fullscreen_end);
assert.ok(sourceIndex(main_local, "id=\"remote-popover-url-link\"") < sourceIndex(main_local, "id=\"remote-popover-url-hint\""));
assert.ok(sourceIndex(fullscreen_local, "id=\"player-fullscreen-remote-url\"") < sourceIndex(fullscreen_local, "id=\"player-fullscreen-remote-url-hint\""));
assert.ok(contains(".remote-access-public-status", this.remote_access_css));
assert.ok(!contains(".remote-access-public-state-icon", this.remote_access_css));
assert.ok(contains(".remote-access-public-connection-indicator", this.remote_access_css));
},
async test_host_requests_a_bounded_configurable_room_lifetime() {
assert.ok(contains("id=\"internet-remote-duration\"", this.host_html));
assert.ok(contains("min=\"1\" max=\"24\" step=\"1\" value=\"12\"", this.host_html));
assert.ok(contains("DEFAULT_ROOM_LIFETIME_HOURS = 12", this.host_js));
assert.ok(contains("MIN_ROOM_LIFETIME_HOURS = 1", this.host_js));
assert.ok(contains("MAX_ROOM_LIFETIME_HOURS = 24", this.host_js));
assert.ok(contains("lifetime_hours: lifetimeHours", this.host_js));
assert.ok(contains("!/^\\d+$/u.test(durationValue)", this.host_js));
assert.ok(contains("tr(\"internetRemote.durationInvalid\"", this.host_js));
assert.ok(!contains("workerLifetime > (8 * 60 * 60 * 1000)", this.host_js));
},
async test_playback_status_changes_reach_internet_peers_without_a_new_revision() {
let functions, publish, result, script, start;
start = sourceIndex(this.host_js, "  function playbackStatusBaseline(status)");
functions = this.host_js.slice(start, sourceIndex(this.host_js, "  async function publishState(", start));
script = (`
const assert = require('node:assert/strict');
let now = 0;
const performance = { now: () => now };
const state = { playbackStatus: null };
` + String(functions) + `
const push = status => {
  const changed = playbackStatusChanged(status);
  if (changed) state.playbackStatus = playbackStatusBaseline(status);
  return changed;
};
const status = (playing, position) => ({ playing, position_seconds: position, duration_seconds: 240 });
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
`);
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
publish = this.host_js.slice(sourceIndex(this.host_js, "  async function publishState("), undefined);
assert.ok(contains("nextRevision <= state.stateRevision && !playbackChanged", publish));
assert.ok(contains("state.playbackStatus = playbackStatusBaseline(remoteState.player_status)", publish));
},
async test_remote_public_card_shows_only_the_room_password() {
let card, remote;
remote = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
card = remote.slice(sourceIndex(remote, "id=\"remote-share-public\""), sourceIndex(remote, "</section>", sourceIndex(remote, "id=\"remote-share-public\"")));
assert.ok(!contains("internetRemote.publicScanTitle", card));
assert.ok(contains("data-i18n=\"internetRemote.currentPassword\"", card));
assert.ok(contains("<strong id=\"remote-share-password\">", card));
},
async test_room_creation_failure_remains_visible_after_cleanup() {
let catchClause, cleanup, end, failure_status, source, start;
start = sourceIndex(this.host_js, "async function startRoom");
end = sourceIndex(this.host_js, "function expireRoom", start);
source = this.host_js.slice(start, end);
catchClause = sourceIndex(source, "} catch (error) {");
cleanup = sourceIndex(source, "stopRoom(false);", catchClause);
failure_status = sourceIndex(source, "setStatus(message, \"bad\")", catchClause);
assert.ok(cleanup < failure_status);
assert.ok(contains("state.roomFailure = true", source.slice(catchClause, undefined)));
},
async test_host_remote_results_show_only_the_local_url_and_share_one_layout() {
let styles;
assert.ok(contains("id=\"internet-remote-room\"", this.host_html));
assert.ok(contains("remote-access-entry-content", this.host_html));
assert.ok(contains("id=\"remote-popover-copy-link\"", this.host_html));
assert.ok(contains("id=\"internet-remote-copy-link\"", this.host_html));
assert.ok(!contains("id=\"remote-popover-open-link\"", this.host_html));
assert.ok(!contains("id=\"internet-remote-open-link\"", this.host_html));
assert.ok(contains("internet-remote-local-link remote-access-link", this.host_html));
assert.ok(contains("class=\"internet-remote-link-target\"", this.host_html));
assert.ok(contains("class=\"internet-remote-live-region\"", this.host_html));
assert.ok(!contains("class=\"remote-url-link\" href=\"#\"", this.host_html));
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
assert.ok(contains(".internet-remote-local-link { display: block;", styles));
assert.ok(contains(".internet-remote-link-target { display: none; }", styles));
assert.ok(contains("background: var(--settings-panel-bg);", styles));
assert.ok(contains("grid-template-columns: 160px minmax(0, 1fr)", styles));
assert.ok(contains(".internet-remote-divider", styles));
},
async test_host_remote_lifecycle_uses_accepted_room_state() {
let render, render_end, render_start;
render_start = sourceIndex(this.host_js, "function render()");
render_end = sourceIndex(this.host_js, "async function localPost", render_start);
render = this.host_js.slice(render_start, render_end);
assert.ok(contains("const roomResultAvailable = Boolean(roomActive && state.remoteUrl)", render));
assert.ok(contains("elements.room.classList.toggle(\"hidden\", !roomResultAvailable)", render));
assert.ok(contains("elements.stop.classList.toggle(\"hidden\", !roomActive)", render));
assert.ok(contains("passwordDraftChanged", render));
assert.ok(contains("lifetimeDraftChanged", render));
assert.ok(contains("tr(\"internetRemote.rebuildApply\"", render));
assert.ok(contains("state.password", render));
assert.ok(!contains("state.expiresAt", render));
assert.ok(contains("state.expiresAt", this.host_js));
assert.ok(!contains("id=\"internet-remote-expiry\"", this.host_html));
assert.deepEqual(countOccurrences(this.host_js, "localPost(\"/api/internet-remote/qr\""), 1);
assert.ok(!contains("setInterval(", this.host_js));
},
async test_loopback_local_entry_is_not_presented_as_phone_shareable() {
assert.ok(contains("function remoteUrlUsesLoopback", this.host_app_js));
assert.ok(contains("hostname.startsWith(\"127.\")", this.host_app_js));
assert.ok(contains("hostname === \"::1\"", this.host_app_js));
assert.ok(contains("!remoteUrlUsesLoopback(value)", this.host_app_js));
assert.ok(contains("renderRemoteQr(shareableUrl", this.host_app_js));
assert.ok(contains("button.disabled = !shareableUrl", this.host_app_js));
},
async test_missing_remote_address_never_becomes_host_homepage() {
let node, program, result;
node = process.execPath;
assert.notEqual(node, null);
program = `
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
`;
result = (await runNative(node, ["-e", program], process.env, 20 * 1000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
},
async test_public_qr_failure_keeps_the_valid_room_result() {
let end, outer_catch, qr_catch, qr_try, source, start;
start = sourceIndex(this.host_js, "async function startRoom");
end = sourceIndex(this.host_js, "function expireRoom", start);
source = this.host_js.slice(start, end);
qr_try = sourceIndex(source, "localPost(\"/api/internet-remote/qr\"");
qr_catch = sourceIndex(source, "} catch (error) {", qr_try);
outer_catch = sourceIndex(source, "} catch (error) {", concatenate(qr_catch, 1));
assert.ok(contains("state.qrError = true", source.slice(qr_catch, outer_catch)));
assert.ok(!contains("stopRoom", source.slice(qr_catch, outer_catch)));
},
async test_internet_remote_exposes_only_sanitized_bounded_diagnostics() {
let record_end, record_source, record_start;
assert.ok(contains("window.BilikaraInternetRemoteDiagnostics", this.host_js));
assert.ok(contains("getSnapshot()", this.host_js));
assert.ok(contains("DIAGNOSTIC_EVENT_LIMIT = 64", this.host_js));
record_start = sourceIndex(this.host_js, "function recordDiagnostic");
record_end = sourceIndex(this.host_js, "window.BilikaraInternetRemoteDiagnostics", record_start);
record_source = this.host_js.slice(record_start, record_end);
assert.ok(!contains("roomId", record_source));
assert.ok(!contains("hostToken", record_source));
assert.ok(!contains("joinToken", record_source));
assert.ok(!contains("password", record_source));
},
async test_local_and_internet_remote_share_the_product_remote_page() {
let adapter, application, low_level, queue;
low_level = sourceIndex(this.remote_html, "src=\"/internet-remote-transport.js\"");
adapter = sourceIndex(this.remote_html, "src=\"/remote-transport-client.js\"");
application = sourceIndex(this.remote_html, "src=\"/remote.js\"");
queue = sourceIndex(this.remote_html, "src=\"/remote-queue.js\"");
assert.ok(low_level < adapter);
assert.ok(adapter < application);
assert.ok(application < queue);
assert.ok(contains("id=\"remote-request-search-panel\"", this.remote_html));
assert.ok(contains("id=\"queue-item-template\"", this.remote_html));
},
async test_internet_adapter_is_an_explicit_api_allowlist() {
assert.ok(contains("url.pathname === \"/api/playlist/reorder\"", this.remote_transport));
assert.ok(contains("url.pathname === \"/api/player/control\"", this.remote_transport));
assert.ok(contains("url.pathname === \"/api/catalog/search\"", this.remote_transport));
assert.ok(contains("url.pathname === \"/api/gatcha/search\"", this.remote_transport));
assert.ok(contains("internet_remote_unavailable", this.remote_transport));
assert.ok(contains("url.origin !== global.location.origin", this.remote_transport));
assert.ok(!contains("request(\"http.request\"", this.remote_transport));
assert.ok(!contains("/api/internet-remote/dispatch", this.remote_transport));
},
async test_internet_adapter_preserves_click_time_command_identity() {
let cache, cache_end, cache_start, control, control_end, control_start, player_control_end, player_control_route, variant, variant_end, variant_start;
assert.ok(contains("item_incarnation_id: String(item.item_incarnation_id || \"\")", this.remote_transport));
control_start = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/control\"");
control_end = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/key-shift\"", control_start);
control = this.remote_transport.slice(control_start, control_end);
assert.ok(contains("item_id: String(body.item_id || \"\")", control));
assert.ok(contains("playback_generation: Number(body.playback_generation)", control));
assert.ok(contains("\"seek-absolute\": \"playback.seek_absolute\"", control));
assert.ok(contains("if (action === \"seek-absolute\") payload.target_seconds =", control));
assert.ok(contains("Math.round(Number(body.target_seconds || 0))", control));
player_control_end = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/next\"", control_start);
player_control_route = this.remote_transport.slice(control_start, player_control_end);
assert.deepEqual(countOccurrences(player_control_route, "response = await request("), 1);
assert.ok(!contains("nativeFetch(", player_control_route));
cache_start = sourceIndex(this.remote_transport, "url.pathname === \"/api/cache/retry\"");
cache_end = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/control\"", cache_start);
cache = this.remote_transport.slice(cache_start, cache_end);
assert.ok(contains("expected_item_incarnation_id: String(body.expected_item_incarnation_id || \"\")", cache));
assert.ok(contains("force: Boolean(body.force)", cache));
variant_start = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/audio-variant\"");
variant_end = sourceIndex(this.remote_transport, "url.pathname === \"/api/rating/submit\"", variant_start);
variant = this.remote_transport.slice(variant_start, variant_end);
assert.ok(contains("expected_item_incarnation_id: String(body.expected_item_incarnation_id || \"\")", variant));
},
async test_internet_mode_keeps_shared_browse_and_gatcha_ui_visible() {
let selector;
for (const selector of iterableValues([".gatcha-panel", "[data-target=\"follow\"]", "[data-target=\"favlist\"]", "[data-target=\"category\"]", "[data-target=\"name\"]", "[data-target=\"artist\"]"])) {
{
assert.ok(!contains(("html[data-remote-transport=\"internet\"] " + String(selector)), this.remote_css));
}
}
},
async test_volume_transport_preserves_song_guard_and_stops_after_rejection() {
let body, end, result, script, start;
start = sourceIndex(this.remote_transport, "url.pathname === \"/api/player/volume\"");
start = sourceIndex(this.remote_transport, "if (body.volume_percent", start);
end = sourceIndex(this.remote_transport, `
      } else if`, start);
body = this.remote_transport.slice(start, end);
script = `
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
`.replaceAll("BODY", JSON.stringify(body));
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_multiline_request_paste_preserves_url_boundaries_and_selection() {
let page, result, script;
for (const page of iterableValues([this.host_html, this.remote_html])) {
assert.ok(contains("src=\"/request-input.js\"", page));
}
assert.ok(contains("\"request-input.js\"", this.asset_sync));
script = `const assert = require("node:assert/strict");
let paste, inputs=0;
const input={value:"prefix OLD suffix",selectionStart:7,selectionEnd:10,
  addEventListener:(type,fn)=>{assert.equal(type,"paste");paste=fn;},
  dispatchEvent:event=>{assert.equal(event.type,"input");inputs++;},
  setRangeText(text,start,end,mode){assert.equal(mode,"end");this.value=this.value.slice(0,start)+text+this.value.slice(end);}};
globalThis.document={getElementById:id=>{assert.equal(id,"url-input");return input;}};
require("./static/request-input.js");
let prevented=0;
const event=text=>({clipboardData:{getData:()=>text},preventDefault:()=>{prevented++;}});
paste(event("Song title\\nhttps://youtu.be/YE7VzlLtp-4\\r\\n#karaoke"));
assert.equal(input.value,"prefix Song title https://youtu.be/YE7VzlLtp-4 #karaoke suffix");
assert.equal(prevented,1);assert.equal(inputs,1);
paste(event("https://youtu.be/YE7VzlLtp-4"));assert.equal(prevented,1);
input.disabled=true;paste(event("title\\nhttps://youtu.be/YE7VzlLtp-4"));assert.equal(prevented,1);
`;
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_youtube_urls_and_share_text_match_rust_input_fixtures() {
let end, result, script, start;
start = sourceIndex(this.remote_transport, "  function youtubeVideoId(");
end = sourceIndex(this.remote_transport, `
  async function `, start);
script = `const assert = require("node:assert/strict");
const fs = require("node:fs");
SOURCE
const cases = JSON.parse(fs.readFileSync("tests/fixtures/youtube_inputs.json", "utf8"));
for (const row of cases) {
  if (row.error) assert.throws(()=>youtubeVideoId(row.input), /YouTube/, row.input);
  else assert.equal(youtubeVideoId(row.input), row.video_id, row.input);
  if (row.video_id) {
    assert.equal(catalogId(row.input), \`youtube:\${row.video_id}\`, row.input);
    assert.throws(()=>catalogId(row.input, 2), /YouTube/);
  }
}
assert.equal(catalogId("BV1xx411c7mD"), "BV1xx411c7mD");
assert.equal(catalogId("https://www.bilibili.com/video/BV1xx411c7mD?p=2"), "BV1xx411c7mD_p2");
`.replaceAll("SOURCE", this.remote_transport.slice(start, end));
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_public_drag_keeps_the_captured_queue_version_when_sending_later() {
let end, result, script, start;
start = sourceIndex(this.remote_transport, "response = await request(\"playlist.move\",");
end = sourceIndex(this.remote_transport, `
      } else if`, start);
script = `const assert = require("node:assert/strict");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const send = new AsyncFunction("body", "request", "expectedRevision", "let response;\\n" + BODY);
(async()=>{
  let observed;
  await send({item_id:"old-target",index:1200,expected_queue_version:"a".repeat(64)},async(kind,body)=>{observed={kind,body};},()=>999);
  assert.deepEqual(observed,{kind:"playlist.move",body:{item_id:"old-target",target_index:1200,expected_queue_version:"a".repeat(64),expected_revision:999}});
})().catch(error=>{console.error(error);process.exitCode=1;});`.replaceAll("BODY", JSON.stringify(this.remote_transport.slice(start, end)));
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_full_public_queue_roundtrips_chunking_and_limits_malicious_buffers() {
let result, script;
script = `const assert = require("node:assert/strict");
require("./static/internet-remote-transport.js");
const api = globalThis.BilikaraInternetTransport;
const playlist = Array.from({length:1000}, (_, i) => ({id:\`song-\${i}\`, title:"中文歌曲/日本語の曲".repeat(8)}));
const payload = {type:"state", data:{playlist}};
const frames = [];
api.send({readyState:"open",send:frame=>frames.push(frame)}, payload);
assert.ok(frames.length > 12);
const decoder = new api.Decoder();
const decoded = frames.flatMap(frame=>decoder.consume(frame));
assert.deepEqual(decoded, [payload]);
const oversized = {type:"state",data:{playlist:Array.from({length:10000}, (_, i) => ({id:\`song-\${i}\`, title:"中文歌曲/日本語の曲".repeat(8)}))}};
const rejected = [];
assert.throws(()=>api.send({readyState:"open",send:frame=>rejected.push(frame)},oversized), /too large/);
assert.deepEqual(rejected, [], "No tail truncation or partial upload of an oversized full queue");
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
for (let i=0;i<8;i++) bad.consume(JSON.stringify({type:"__chunk",transfer_id:\`big-\${i}\`,index:0,total:2,total_bytes:512*1024,data:"x"}));
assert.throws(()=>bad.consume(JSON.stringify({type:"__chunk",transfer_id:"overflow",index:0,total:2,total_bytes:1,data:"x"})), /Too many/);
`;
result = (await runNative("node", ["-e", script], process.env, 20 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_retry_transport_preserves_force_true_false_and_legacy_absence() {
let end, result, script, start;
start = sourceIndex(this.remote_transport, "response = await request(\"cache.retry\", {");
end = sourceIndex(this.remote_transport, `
      } else if`, start);
script = `const assert = require("node:assert/strict");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const send = new AsyncFunction("body", "request", "expectedRevision", "let response;\\n" + BODY + "\\nreturn response;");
(async()=>{
  for(const force of [undefined,false,true]){
    let observed;
    await send({item_id:"song",expected_item_incarnation_id:"incarnation",force},async(kind,body)=>{observed={kind,body};},()=>12);
    assert.deepEqual(observed,{kind:"cache.retry",body:{item_id:"song",expected_item_incarnation_id:"incarnation",force:force===true,expected_revision:12}});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});`.replaceAll("BODY", JSON.stringify(this.remote_transport.slice(start, end)));
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
},
async test_internet_adapter_maps_shared_browse_and_gatcha_endpoints() {
let expected_routes, request_kind, route;
expected_routes = new Set(["/api/d1/browse", "/api/d1/category-browse", "/api/gatcha/browse", "/api/gatcha/favlist/browse", "/api/gatcha/pool-config", "/api/gatcha/candidate", "/api/gatcha/uids/preview", "/api/gatcha/uids/add", "/api/gatcha/refresh", "/api/gatcha/favlist/preview", "/api/gatcha/favlist"]);
for (const route of iterableValues(expected_routes)) {
{
assert.ok(contains(("url.pathname === \"" + String(route) + "\""), this.remote_transport));
}
}
for (const request_kind of iterableValues(["catalog.browse", "catalog.category_browse", "gatcha.browse", "gatcha.favlist_browse", "gatcha.pool_config_get", "gatcha.candidate", "gatcha.pool_config_set", "gatcha.uid_preview", "gatcha.uid_add", "gatcha.refresh", "gatcha.favlist_preview", "gatcha.favlist_refresh"])) {
{
assert.ok(contains(("\"" + String(request_kind) + "\""), this.remote_transport));
}
}
},
async test_follow_browse_uses_bounded_offset_pagination() {
let browse_route, browse_source;
assert.ok(contains("params.set(\"offset\", String(offset))", this.remote_js));
assert.ok(contains("params.set(\"limit\", String(limit))", this.remote_js));
assert.ok(contains("id=\"sources-follow-results\"", this.remote_html));
assert.ok(!contains("id=\"follow-browse-more\"", this.remote_html));
assert.ok(!contains("id=\"modal-follow-browse-more\"", this.remote_html));
assert.ok(contains("function remoteResultPaginationOptions", this.remote_js));
assert.ok(contains("fetchGatchaBrowse(selected, query, page)", this.remote_js));
browse_route = sourceIndex(this.remote_transport, "url.pathname === \"/api/gatcha/browse\"");
browse_source = this.remote_transport.slice(browse_route, concatenate(browse_route, 700));
assert.ok(contains("offset:", browse_source));
assert.ok(contains("limit:", browse_source));
},
async test_favlist_browse_uses_bounded_offset_pagination() {
let browse_route, browse_source, fetch_end, fetch_source, fetch_start, load_end, load_source, load_start;
assert.ok(contains("id=\"favlist-song-results\"", this.remote_html));
assert.ok(!contains("id=\"favlist-browse-more\"", this.remote_html));
assert.ok(contains("function remoteResultPaginationOptions", this.remote_js));
assert.ok(contains("fetchGatchaFavlistBrowse(selected, query, page)", this.remote_js));
fetch_start = sourceIndex(this.remote_js, "async function fetchGatchaFavlistBrowse");
fetch_end = sourceIndex(this.remote_js, "async function fetchPoolConfig", fetch_start);
fetch_source = this.remote_js.slice(fetch_start, fetch_end);
assert.ok(contains("params.set(\"offset\", String(offset))", fetch_source));
assert.ok(contains("params.set(\"limit\", String(limit))", fetch_source));
load_start = sourceIndex(this.remote_js, "async function loadFavlistBrowse");
load_end = sourceIndex(this.remote_js, "function requestResultItemKey", load_start);
load_source = this.remote_js.slice(load_start, load_end);
assert.ok(contains("append = false", load_source));
assert.ok(contains("next_offset", load_source));
browse_route = sourceIndex(this.remote_transport, "url.pathname === \"/api/gatcha/favlist/browse\"");
browse_source = this.remote_transport.slice(browse_route, concatenate(browse_route, 700));
assert.ok(contains("offset:", browse_source));
assert.ok(contains("limit:", browse_source));
},
async test_public_state_maps_history_and_host_transport_revision() {
assert.ok(contains("function localHistoryItem", this.remote_transport));
assert.ok(contains("history: (remoteState.history || []).map(localHistoryItem).filter(Boolean)", this.remote_transport));
assert.ok(contains("remoteState.state_revision ?? remoteState.revision", this.remote_transport));
assert.ok(contains("nextRevision <= state.stateRevision", this.host_js));
},
async test_public_items_preserve_authoritative_part_binding_metadata() {
let end, field, source, start;
start = sourceIndex(this.remote_transport, "function localItem");
end = sourceIndex(this.remote_transport, "function localHistoryItem", start);
source = this.remote_transport.slice(start, end);
for (const field of iterableValues(["item.selected_pages", "item.selected_durations", "item.selected_parts", "item.available_pages", "item.available_durations", "item.available_parts"])) {
{
assert.ok(contains(field, source));
}
}
assert.ok(contains("variant.page", source));
},
async test_public_state_never_rolls_back_to_an_older_transport_revision() {
assert.ok(contains("nextRevision < currentRevision", this.remote_transport));
assert.ok(contains("nextRevision <= state.stateRevision", this.host_js));
},
async test_revision_bound_remote_mutations_are_serialized_before_reading_revision() {
assert.ok(contains("revisionMutationTail: Promise.resolve()", this.remote_transport));
assert.ok(contains("async function acquireRevisionMutationTurn", this.remote_transport));
assert.ok(contains("isRevisionBoundMutation(method, url.pathname)", this.remote_transport));
assert.ok(contains("releaseRevisionMutation?.()", this.remote_transport));
},
async test_host_diagnostics_record_datachannel_request_outcomes() {
assert.ok(contains("recordDiagnostic(\"request.dispatch\", \"started\"", this.host_js));
assert.ok(contains("recordDiagnostic(\"request.dispatch\", \"completed\"", this.host_js));
assert.ok(contains("operation:", this.host_js));
},
async test_host_releases_public_room_capacity_when_stopped() {
assert.ok(contains("method: \"DELETE\"", this.host_js));
assert.ok(contains("Authorization: `Bearer ${hostToken}`", this.host_js));
assert.ok(contains("keepalive: true", this.host_js));
assert.ok(contains("async function stopInternetRoom", this.host_js));
assert.ok(contains("elements.stop.addEventListener(\"click\"", this.host_js));
},
async test_search_covers_are_requested_without_a_referrer() {
let end, source, start;
start = sourceIndex(this.remote_js, "function createSearchResultCover");
end = sourceIndex(this.remote_js, "function createSearchResultRow", start);
source = this.remote_js.slice(start, end);
assert.ok(contains("image.referrerPolicy = \"no-referrer\"", source));
assert.ok(sourceIndex(source, "image.referrerPolicy = \"no-referrer\"") < sourceIndex(source, "image.src = coverUrl"));
},
async test_application_rejections_do_not_disconnect_the_peer() {
let end, source, start;
start = sourceIndex(this.host_js, "async function handlePeerMessage");
end = sourceIndex(this.host_js, "async function publishState", start);
source = this.host_js.slice(start, end);
assert.ok(contains("accepted: false", source));
assert.ok(contains("isFatalProtocolError(error.code)", source));
assert.ok(contains("code: String(error.code || \"internet_remote_request_failed\")", source));
},
async test_manual_binding_error_payload_crosses_both_browser_adapters() {
let host_dispatch_end, host_dispatch_start, local_post_end, local_post_start;
local_post_start = sourceIndex(this.host_js, "async function localPost");
local_post_end = sourceIndex(this.host_js, "function signalUrl", local_post_start);
assert.ok(contains("error.payload = payload", this.host_js.slice(local_post_start, local_post_end)));
host_dispatch_start = sourceIndex(this.host_js, "async function handlePeerMessage");
host_dispatch_end = sourceIndex(this.host_js, "async function publishState", host_dispatch_start);
assert.ok(contains("binding: sanitizedManualBinding(error.payload?.binding)", this.host_js.slice(host_dispatch_start, host_dispatch_end)));
assert.ok(contains("error.payload = { binding: message.binding }", this.remote_transport));
assert.ok(contains("failure.binding = error.payload.binding", this.remote_transport));
},
async test_playlist_add_preserves_optional_manual_binding_selection() {
let end, source, start;
start = sourceIndex(this.remote_transport, "if (method === \"POST\" && url.pathname === \"/api/playlist/add\")");
end = sourceIndex(this.remote_transport, "else if (method === \"POST\" && url.pathname === \"/api/playlist/reorder\")", start);
source = this.remote_transport.slice(start, end);
assert.ok(contains("selected_video_page: body.selected_video_page", source));
assert.ok(contains("selected_audio_pages: body.selected_audio_pages", source));
},
async test_playlist_add_waits_for_host_metadata_resolution() {
let end, source, start;
assert.ok(contains("const playlistAddRequestTimeoutMs = 60_000;", this.remote_transport));
start = sourceIndex(this.remote_transport, "if (method === \"POST\" && url.pathname === \"/api/playlist/add\")");
end = sourceIndex(this.remote_transport, "else if (method === \"POST\" && url.pathname === \"/api/playlist/reorder\")", start);
source = this.remote_transport.slice(start, end);
assert.ok(contains("}, \"control\", playlistAddRequestTimeoutMs)", source));
},
async test_foreground_resume_probes_live_channel_before_reconnecting() {
let refresh_end, refresh_source, refresh_start;
assert.ok(contains("function probeHeartbeat", this.remote_transport));
assert.ok(contains("function refreshHeartbeatAfterForeground", this.remote_transport));
assert.ok(contains("global.addEventListener(\"pageshow\", refreshHeartbeatAfterForeground)", this.remote_transport));
assert.ok(contains("document.addEventListener(\"visibilitychange\"", this.remote_transport));
refresh_start = sourceIndex(this.remote_transport, "function refreshHeartbeatAfterForeground");
refresh_end = sourceIndex(this.remote_transport, "function request", refresh_start);
refresh_source = this.remote_transport.slice(refresh_start, refresh_end);
assert.ok(contains("probeHeartbeat({ freshGrace: true })", refresh_source));
},
async test_heartbeat_grants_a_fresh_probe_after_timer_suspension() {
let completed, end, node, probe_source, script, start;
node = process.execPath;
if ((!node)) {
(() => { throw new Error("node is unavailable"); })();
}
start = sourceIndex(this.remote_transport, "function probeHeartbeat");
end = sourceIndex(this.remote_transport, "function startHeartbeat", start);
probe_source = this.remote_transport.slice(start, end);
script = (`
const heartbeatTimeoutMs = 8000;
let now = 1000;
Date.now = () => now;
let reconnects = 0;
const sent = [];
const state = {
  authorized: true,
  control: { readyState: "open" },
  lastPongAt: 0,
  heartbeatProbeAt: 0,
  heartbeatLastTickAt: 0,
};
const lowLevel = { send: (_channel, message) => sent.push(message.at) };
function scheduleReconnect() { reconnects += 1; }
` + String(probe_source) + `
probeHeartbeat();
now = 3000;
probeHeartbeat();
now = 12001;
probeHeartbeat();
state.lastPongAt = state.heartbeatProbeAt;
now = 14001;
probeHeartbeat();
for (now of [16001, 18001, 20001, 22001, 24001]) probeHeartbeat();
console.log(JSON.stringify({ sent, reconnects }));
`);
completed = (await runNative(node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
assert.deepEqual(JSON.parse(completed.stdout.trim()), {["sent"]: [1000, 12001, 14001], ["reconnects"]: 1});
},
async test_public_rename_revalidates_identity_and_preserves_newer_broadcasts() {
const result = await runNative('node', ['-e', "\nconst assert = require('node:assert/strict');\nconst vm = require('node:vm');\nconst fs = require('node:fs');\nconst source = fs.readFileSync('static/remote-transport-client.js', 'utf8').replace(\n  '})(globalThis);',\n  'globalThis.adapter={state,fetchInternet,publishState,stub:fn=>{request=fn;}}; })(globalThis);'\n);\nconst storage=new Map();\nconst sandbox={fetch:async()=>{throw new Error('Unexpected network request');},\n location:{hash:'#room=fixture',origin:'https://example.test',href:'https://example.test/#room=fixture'},\n localStorage:{getItem:key=>storage.get(key)||'',setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},\n URLSearchParams,URL,Response,Headers,queueMicrotask,setTimeout:()=>1,clearTimeout:()=>{},clearInterval:()=>{},\n navigator:{onLine:true},addEventListener:()=>{},dispatchEvent:()=>{},Event:class{},\n BilikaraInternetTransport:{randomBase64Url:()=> 'fixture',Decoder:class{}},\n document:{addEventListener:()=>{},documentElement:{dataset:{}}}};\nsandbox.crypto=require('node:crypto').webcrypto;sandbox.TextEncoder=TextEncoder;sandbox.btoa=btoa;\nvm.runInNewContext(fs.readFileSync('static/internet-remote-transport.js','utf8'),sandbox);\nsandbox.BilikaraInternetTransport.randomBase64Url=()=> 'fixture';\nvm.runInNewContext(source,sandbox);\nconst {state,fetchInternet,publishState,stub}=sandbox.adapter;\nconst id='a'.repeat(64);\nconst roster=(revision,name)=>({state_epoch:'epoch',revision,session_generation:1,session_user_edit_version:1,\n session_users:[name],session_user_entries:[{id,name}],player_settings:{}});\n(async()=>{\n state.authorized=true;state.identity='Alice';state.identityUserId=id;\n publishState(roster(1,'Alice'));\n const calls=[];\n stub(async(kind,body)=>{calls.push({kind,body});return {data:{name:'Alice',state:roster(1,'Alice')}};});\n const post=(route,body)=>fetchInternet(route,{method:'POST',body:JSON.stringify(body)});\n await post('/api/remote-identity/register',{name:'Alice'});\n assert.equal(calls[0].kind,'session.set_identity'); // Same-name requests still reach Rust.\n stub(async(kind,body)=>{calls.push({kind,body});publishState(roster(3,'Latest'));return {data:{name:'Aimer',state:roster(2,'Aimer')}};});\n let response=await (await post('/api/remote-identity/rename',{name:'Aimer',user_id:id,expected_name:'Alice'})).json();\n assert.equal(calls[1].kind,'session.rename');assert.equal(calls[1].body.user_id,id);\n assert.equal(response.data.name,'Latest');assert.equal(response.data.user_id,id);\n assert.equal(storage.get('bilikara.internetRemote.identity.v1.fixture.userId'),id);\n publishState({...roster(4,''),session_users:[],session_user_entries:[]});\n assert.equal(state.identity,'');assert.equal(state.identityUserId,'');\n assert.equal(storage.has('bilikara.internetRemote.identity.v1.fixture.userId'),false);\n // Older Hosts must never receive the old rename-as-registration request.\n state.remoteState.session_user_edit_version=0;\n response=await post('/api/remote-identity/rename',{name:'Old host'});\n assert.equal(response.status,409);assert.equal(calls.length,2);\n console.log('ok');\n})().catch(error=>{console.error(error);process.exitCode=1;});\n"], process.env, 10000, ROOT);
assert.equal(result.status, 0, result.stderr);
},
async test_control_and_bulk_requests_have_independent_ordered_queues() {
assert.ok(contains("queues: { control: Promise.resolve(), bulk: Promise.resolve() }", this.host_js));
assert.ok(contains("peer.queues[lane] = peer.queues[lane].then", this.host_js));
assert.ok(contains("lane === \"control\" && message?.type === \"ping\"", this.host_js));
},
async test_public_projection_and_disconnect_never_replay_cached_state_as_live() {
let result, script;
script = `
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
sandbox.crypto=require("node:crypto").webcrypto;sandbox.TextEncoder=TextEncoder;sandbox.btoa=btoa;
vm.runInNewContext(fs.readFileSync("static/internet-remote-transport.js","utf8"),sandbox);
sandbox.BilikaraInternetTransport.randomBase64Url=()=> "fixture";
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
`;
result = (await runNative("node", ["-e", script], process.env, 120000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
},
async test_local_transport_remains_native_fetch_and_event_source() {
assert.ok(contains("mode: \"local\"", this.remote_transport));
assert.ok(contains("fetch: nativeFetch", this.remote_transport));
assert.ok(contains("new global.EventSource(url)", this.remote_transport));
},
async test_reconnect_replaces_the_resolved_readiness_gate() {
let disconnect, reconnect, source;
reconnect = sourceIndex(this.remote_transport, "function scheduleReconnect()");
disconnect = sourceIndex(this.remote_transport, "function disconnect()", reconnect);
source = this.remote_transport.slice(reconnect, disconnect);
assert.ok(contains("state.authorized = false", source));
assert.ok(contains("state.readyPromise = null", source));
assert.ok(contains("ensureReadyPromise()", source));
},
async test_internet_disconnect_does_not_send_a_local_api_beacon() {
let beacon, end, source, start, transport_disconnect;
start = sourceIndex(this.remote_js, "function disconnectClient()");
end = sourceIndex(this.remote_js, "elements.requestForm", start);
source = this.remote_js.slice(start, end);
transport_disconnect = sourceIndex(source, "mode === \"internet\"");
beacon = sourceIndex(source, "navigator.sendBeacon");
assert.ok(transport_disconnect < beacon);
assert.ok(contains("window.BilikaraRemoteTransport.disconnect()", source));
},
async test_worker_asset_sync_uses_the_product_remote_dependencies() {
let asset;
for (const asset of iterableValues(["accent-palette.css", "export-download.js", "export-guard.js", "remote.html", "remote.css", "remote.js", "result-pagination.css", "result-pagination.js", "browse-search.js", "search-result-media.css", "search-result-media.js", "remote-queue.css", "remote-queue.js", "song-detail.css", "song-detail.js", "i18n.json", "internet-remote-transport.js", "remote-transport-client.js", "qrcode-generator.js", "qrcode-generator.LICENSE", "remote-access.css"])) {
{
assert.ok(contains(("\"" + String(asset) + "\""), this.asset_sync));
}
}
assert.ok(contains("Join-Path $staticRoot \"pic\"", this.asset_sync));
assert.ok(contains("$ErrorActionPreference = \"Stop\"", this.asset_sync));
assert.ok(contains("[System.IO.Path]::IsPathRooted($Destination)", this.asset_sync));
},
async test_remote_invitation_is_authorized_unexpired_and_preserves_fragment() {
let end, node, qr_end, qr_source, qr_start, result, script, source, start;
start = sourceIndex(this.remote_transport, "  function invitation()");
end = sourceIndex(this.remote_transport, "  function armInvitationExpiry", start);
source = this.remote_transport.slice(start, end);
script = concatenate(concatenate(`
const assert = require("node:assert/strict");
const global = { location: { origin: "https://example.invalid" } };
const roomId = "A".repeat(27), joinToken = "B".repeat(43);
const state = { authorized: false, password: "synthetic-password" };
const fragment = new URLSearchParams({ expires: String(Date.now() + 60000) });
`, source), `
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
`);
node = process.execPath;
if ((!node)) {
(() => { throw new Error("node is unavailable"); })();
}
result = (await runNative(node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(result.status, 0, result.stderr);
qr_start = sourceIndex(this.remote_js, "function renderRemoteQr(");
qr_end = sourceIndex(this.remote_js, "function setFormMessage", qr_start);
qr_source = this.remote_js.slice(qr_start, qr_end);
assert.ok(!contains("qrserver.com", qr_source));
assert.ok(contains("window.qrcode(0", qr_source));
assert.ok(contains("placeholder.replaceChildren(qr)", qr_source));
assert.ok(!contains("data:image", qr_source));
}
};
test("InternetRemoteFrontendTest.test_host_exposes_local_and_internet_modes_without_replacing_local_remote", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_exposes_local_and_internet_modes_without_replacing_local_remote(); });
test("InternetRemoteFrontendTest.test_host_uses_one_mobile_remote_entry_with_a_collapsed_public_menu", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_uses_one_mobile_remote_entry_with_a_collapsed_public_menu(); });
test("InternetRemoteFrontendTest.test_fullscreen_remote_card_uses_the_same_compact_public_summary", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_fullscreen_remote_card_uses_the_same_compact_public_summary(); });
test("InternetRemoteFrontendTest.test_compact_hover_keeps_active_public_qr_without_room_controls", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_compact_hover_keeps_active_public_qr_without_room_controls(); });
test("InternetRemoteFrontendTest.test_access_popovers_share_opaque_dark_surfaces_and_translation_keys", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_access_popovers_share_opaque_dark_surfaces_and_translation_keys(); });
test("InternetRemoteFrontendTest.test_public_and_local_qr_use_complete_images_with_one_shared_quiet_zone", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_and_local_qr_use_complete_images_with_one_shared_quiet_zone(); });
test("InternetRemoteFrontendTest.test_hover_preview_and_pinned_menu_have_explicit_shared_ownership", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_hover_preview_and_pinned_menu_have_explicit_shared_ownership(); });
test("InternetRemoteFrontendTest.test_internet_remote_scripts_load_before_the_host_application", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_remote_scripts_load_before_the_host_application(); });
test("InternetRemoteFrontendTest.test_host_room_secrets_stay_in_fragment_and_websocket_subprotocol", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_room_secrets_stay_in_fragment_and_websocket_subprotocol(); });
test("InternetRemoteFrontendTest.test_current_access_entry_labels_exist_in_every_language", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_current_access_entry_labels_exist_in_every_language(); });
test("InternetRemoteFrontendTest.test_host_remote_explanations_use_contextual_info_bubbles", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_remote_explanations_use_contextual_info_bubbles(); });
test("InternetRemoteFrontendTest.test_local_entry_copy_names_devices_and_host_without_platform_assumptions", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_local_entry_copy_names_devices_and_host_without_platform_assumptions(); });
test("InternetRemoteFrontendTest.test_host_remote_entry_controls_use_shared_control_geometry", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_remote_entry_controls_use_shared_control_geometry(); });
test("InternetRemoteFrontendTest.test_remote_room_and_display_refresh_controls_share_the_host_svg", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_remote_room_and_display_refresh_controls_share_the_host_svg(); });
test("InternetRemoteFrontendTest.test_host_remote_entry_statuses_do_not_use_indicator_dots", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_remote_entry_statuses_do_not_use_indicator_dots(); });
test("InternetRemoteFrontendTest.test_shared_two_column_preview_uses_one_local_detail_order", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_shared_two_column_preview_uses_one_local_detail_order(); });
test("InternetRemoteFrontendTest.test_host_requests_a_bounded_configurable_room_lifetime", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_requests_a_bounded_configurable_room_lifetime(); });
test("InternetRemoteFrontendTest.test_playback_status_changes_reach_internet_peers_without_a_new_revision", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_playback_status_changes_reach_internet_peers_without_a_new_revision(); });
test("InternetRemoteFrontendTest.test_remote_public_card_shows_only_the_room_password", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_remote_public_card_shows_only_the_room_password(); });
test("InternetRemoteFrontendTest.test_room_creation_failure_remains_visible_after_cleanup", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_room_creation_failure_remains_visible_after_cleanup(); });
test("InternetRemoteFrontendTest.test_host_remote_results_show_only_the_local_url_and_share_one_layout", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_remote_results_show_only_the_local_url_and_share_one_layout(); });
test("InternetRemoteFrontendTest.test_host_remote_lifecycle_uses_accepted_room_state", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_remote_lifecycle_uses_accepted_room_state(); });
test("InternetRemoteFrontendTest.test_loopback_local_entry_is_not_presented_as_phone_shareable", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_loopback_local_entry_is_not_presented_as_phone_shareable(); });
test("InternetRemoteFrontendTest.test_missing_remote_address_never_becomes_host_homepage", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_missing_remote_address_never_becomes_host_homepage(); });
test("InternetRemoteFrontendTest.test_public_qr_failure_keeps_the_valid_room_result", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_qr_failure_keeps_the_valid_room_result(); });
test("InternetRemoteFrontendTest.test_internet_remote_exposes_only_sanitized_bounded_diagnostics", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_remote_exposes_only_sanitized_bounded_diagnostics(); });
test("InternetRemoteFrontendTest.test_local_and_internet_remote_share_the_product_remote_page", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_local_and_internet_remote_share_the_product_remote_page(); });
test("InternetRemoteFrontendTest.test_internet_adapter_is_an_explicit_api_allowlist", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_adapter_is_an_explicit_api_allowlist(); });
test("InternetRemoteFrontendTest.test_internet_adapter_preserves_click_time_command_identity", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_adapter_preserves_click_time_command_identity(); });
test("InternetRemoteFrontendTest.test_internet_mode_keeps_shared_browse_and_gatcha_ui_visible", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_mode_keeps_shared_browse_and_gatcha_ui_visible(); });
test("InternetRemoteFrontendTest.test_volume_transport_preserves_song_guard_and_stops_after_rejection", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_volume_transport_preserves_song_guard_and_stops_after_rejection(); });
test("InternetRemoteFrontendTest.test_multiline_request_paste_preserves_url_boundaries_and_selection", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_multiline_request_paste_preserves_url_boundaries_and_selection(); });
test("InternetRemoteFrontendTest.test_youtube_urls_and_share_text_match_rust_input_fixtures", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_youtube_urls_and_share_text_match_rust_input_fixtures(); });
test("InternetRemoteFrontendTest.test_public_drag_keeps_the_captured_queue_version_when_sending_later", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_drag_keeps_the_captured_queue_version_when_sending_later(); });
test("InternetRemoteFrontendTest.test_full_public_queue_roundtrips_chunking_and_limits_malicious_buffers", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_full_public_queue_roundtrips_chunking_and_limits_malicious_buffers(); });
test("InternetRemoteFrontendTest.test_retry_transport_preserves_force_true_false_and_legacy_absence", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_retry_transport_preserves_force_true_false_and_legacy_absence(); });
test("InternetRemoteFrontendTest.test_internet_adapter_maps_shared_browse_and_gatcha_endpoints", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_adapter_maps_shared_browse_and_gatcha_endpoints(); });
test("InternetRemoteFrontendTest.test_follow_browse_uses_bounded_offset_pagination", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_follow_browse_uses_bounded_offset_pagination(); });
test("InternetRemoteFrontendTest.test_favlist_browse_uses_bounded_offset_pagination", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_favlist_browse_uses_bounded_offset_pagination(); });
test("InternetRemoteFrontendTest.test_public_state_maps_history_and_host_transport_revision", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_state_maps_history_and_host_transport_revision(); });
test("InternetRemoteFrontendTest.test_public_items_preserve_authoritative_part_binding_metadata", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_items_preserve_authoritative_part_binding_metadata(); });
test("InternetRemoteFrontendTest.test_public_state_never_rolls_back_to_an_older_transport_revision", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_state_never_rolls_back_to_an_older_transport_revision(); });
test("InternetRemoteFrontendTest.test_revision_bound_remote_mutations_are_serialized_before_reading_revision", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_revision_bound_remote_mutations_are_serialized_before_reading_revision(); });
test("InternetRemoteFrontendTest.test_host_diagnostics_record_datachannel_request_outcomes", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_diagnostics_record_datachannel_request_outcomes(); });
test("InternetRemoteFrontendTest.test_host_releases_public_room_capacity_when_stopped", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_host_releases_public_room_capacity_when_stopped(); });
test("InternetRemoteFrontendTest.test_search_covers_are_requested_without_a_referrer", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_search_covers_are_requested_without_a_referrer(); });
test("InternetRemoteFrontendTest.test_application_rejections_do_not_disconnect_the_peer", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_application_rejections_do_not_disconnect_the_peer(); });
test("InternetRemoteFrontendTest.test_manual_binding_error_payload_crosses_both_browser_adapters", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_manual_binding_error_payload_crosses_both_browser_adapters(); });
test("InternetRemoteFrontendTest.test_playlist_add_preserves_optional_manual_binding_selection", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_playlist_add_preserves_optional_manual_binding_selection(); });
test("InternetRemoteFrontendTest.test_playlist_add_waits_for_host_metadata_resolution", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_playlist_add_waits_for_host_metadata_resolution(); });
test("InternetRemoteFrontendTest.test_foreground_resume_probes_live_channel_before_reconnecting", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_foreground_resume_probes_live_channel_before_reconnecting(); });
test("InternetRemoteFrontendTest.test_heartbeat_grants_a_fresh_probe_after_timer_suspension", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_heartbeat_grants_a_fresh_probe_after_timer_suspension(); });
test("InternetRemoteFrontendTest.test_public_rename_revalidates_identity_and_preserves_newer_broadcasts", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_rename_revalidates_identity_and_preserves_newer_broadcasts(); });
test("InternetRemoteFrontendTest.test_control_and_bulk_requests_have_independent_ordered_queues", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_control_and_bulk_requests_have_independent_ordered_queues(); });
test("InternetRemoteFrontendTest.test_public_projection_and_disconnect_never_replay_cached_state_as_live", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_public_projection_and_disconnect_never_replay_cached_state_as_live(); });
test("InternetRemoteFrontendTest.test_local_transport_remains_native_fetch_and_event_source", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_local_transport_remains_native_fetch_and_event_source(); });
test("InternetRemoteFrontendTest.test_reconnect_replaces_the_resolved_readiness_gate", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_reconnect_replaces_the_resolved_readiness_gate(); });
test("InternetRemoteFrontendTest.test_internet_disconnect_does_not_send_a_local_api_beacon", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_internet_disconnect_does_not_send_a_local_api_beacon(); });
test("InternetRemoteFrontendTest.test_worker_asset_sync_uses_the_product_remote_dependencies", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_worker_asset_sync_uses_the_product_remote_dependencies(); });
test("InternetRemoteFrontendTest.test_remote_invitation_is_authorized_unexpired_and_preserves_fragment", async () => { const instance = Object.create(InternetRemoteFrontendTest); await instance.setUpClass(); await instance.test_remote_invitation_is_authorized_unexpired_and_preserves_fragment(); });
