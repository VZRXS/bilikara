import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const QueueHistoryFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
this.markup = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.i18n = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
},
async run_node(body) {
let completed, end, script, start, workspace_source;
start = sourceIndex(this.source, "function renderHostWorkspaceSelection");
end = sourceIndex(this.source, "function closeHostWorkspaceOverlay", start);
workspace_source = this.source.slice(start, end);
script = concatenate(concatenate(concatenate(`
class FakeClassList {
  constructor() { this.values = new Set(); }
  contains(name) { return this.values.has(name); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, enabled) {
    if (enabled) this.values.add(name); else this.values.delete(name);
  }
}
class FakeElement {
  constructor(workspace = "", panel = false) {
    this.dataset = workspace
      ? (panel ? { hostWorkspacePanel: workspace } : { hostWorkspace: workspace })
      : {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = { values: new Map(), setProperty(name, value) { this.values.set(name, String(value)); },
      removeProperty(name) { this.values.delete(name); }, getPropertyValue(name) { return this.values.get(name) || ""; } };
    this.clientLeft = this.clientTop = 0;
    this.hidden = false;
    this.inert = false;
    this.tabIndex = -1;
    this.scrollTop = 0;
    this.focused = false;
    this.heading = { focused: false, focus() { this.focused = true; } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  querySelector() { return this.heading; }
  getBoundingClientRect() { return { left: 640, top: 100, width: 360, height: 600 }; }
}
function getComputedStyle(node) { return { opacity: "1", display: node.hidden ? "none" : "grid" }; }
const workspaces = ["queue", "history", "request", "random", "users", "settings"];
const buttons = workspaces.map((workspace) => new FakeElement(workspace));
const panels = workspaces.map((workspace) => new FakeElement(workspace, true));
const queueButton = buttons[0];
const historyButton = buttons[1];
const elements = {
  appShell: new FakeElement(),
  hostWorkspaceRegion: new FakeElement(),
  hostWorkspaceButtons: buttons,
  hostWorkspacePanels: panels,
  hostWorkspaceBackdrop: new FakeElement(),
  playlist: new FakeElement(),
  historyList: new FakeElement(),
};
const state = {
  activeHostWorkspace: "queue",
  focusedHostWorkspace: "queue",
  hostWorkspaceOverlayOpen: false,
  hostWorkspaceScrollPositions: {},
};
let closeCalls = 0;
let loadCalls = 0;
function closeOpenMenus() { closeCalls += 1; }
function loadPlayedSessions() { loadCalls += 1; return Promise.resolve(true); }
function closeRequestDetailForNavigation() {}
function rememberRequestScrollPosition() {}
function syncRequestSubviewSelection() {}
function restoreRequestScrollPosition() {}
`, workspace_source), `
`), body);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_direct_workspaces_are_stable_accessible_and_preserve_scroll() {
let result;
result = (await this.run_node(`
elements.playlist.scrollTop = 91;
elements.historyList.scrollTop = 173;
const queueNode = panels[0];
const historyNode = panels[1];
renderHostWorkspaceSelection();
const initial = {
  queueSelected: queueButton.getAttribute("aria-selected"),
  historySelected: historyButton.getAttribute("aria-selected"),
  queueHidden: panels[0].hidden,
  historyHidden: panels[1].hidden,
  historyInert: panels[1].inert,
};
activateHostWorkspace("history", { inputOrigin: "pointer" });
const history = {
  queueSelected: queueButton.getAttribute("aria-selected"),
  historySelected: historyButton.getAttribute("aria-selected"),
  queueHidden: panels[0].hidden,
  queueInert: panels[0].inert,
  historyHidden: panels[1].hidden,
  focused: historyButton.focused,
};
activateHostWorkspace("queue", { inputOrigin: "pointer" });
console.log(JSON.stringify({
  initial,
  history,
  stableNodes: queueNode === panels[0] && historyNode === panels[1],
  scroll: [elements.playlist.scrollTop, elements.historyList.scrollTop],
  closeCalls,
  loadCalls,
}));
`));
assert.deepEqual(result["initial"], {["queueSelected"]: "true", ["historySelected"]: "false", ["queueHidden"]: false, ["historyHidden"]: true, ["historyInert"]: true});
assert.deepEqual(result["history"], {["queueSelected"]: "false", ["historySelected"]: "true", ["queueHidden"]: true, ["queueInert"]: true, ["historyHidden"]: false, ["focused"]: true});
assert.ok(hasContent(result["stableNodes"]));
assert.deepEqual(result["scroll"], [91, 173]);
assert.deepEqual(result["closeCalls"], 2);
assert.deepEqual(result["loadCalls"], 1);
},
async test_rail_keyboard_wraps_and_supports_home_end() {
let result;
result = (await this.run_node(`
function key(target, value) {
  handleHostWorkspaceRailKeydown({
    currentTarget: target,
    key: value,
    preventDefault() {},
  });
  return state.focusedHostWorkspace;
}
const sequence = [
  key(queueButton, "ArrowUp"),
  key(buttons[5], "ArrowDown"),
  key(queueButton, "End"),
  key(buttons[5], "Home"),
];
console.log(JSON.stringify({ sequence }));
`));
assert.deepEqual(result["sequence"], ["settings", "queue", "settings", "queue"]);
},
async test_markup_places_actions_on_their_final_owners() {
let player_panel, queue_workspace, request_workspace;
player_panel = this.markup.slice(sourceIndex(this.markup, "<section class=\"player-panel\">"), sourceIndex(this.markup, "<div class=\"player-frame\" id=\"player-frame\">"));
request_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"host-workspace-request\""), sourceIndex(this.markup, "id=\"session-users-panel\""));
queue_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"host-workspace-queue\""), sourceIndex(this.markup, "</aside>", sourceIndex(this.markup, "id=\"host-workspace-queue\"")));
assert.deepEqual(countOccurrences(this.markup, "id=\"next-button\""), 1);
assert.ok(!contains("id=\"next-button\"", player_panel));
assert.ok(contains("id=\"next-button\"", queue_workspace));
assert.ok(contains("class=\"next-button settings-tool-button queue-current-next\"", queue_workspace));
assert.deepEqual(countOccurrences(this.markup, "id=\"resort-playlist-button\""), 1);
assert.ok(contains("id=\"resort-playlist-button\"", queue_workspace));
assert.ok(!contains("id=\"resort-playlist-button\"", request_workspace));
assert.ok(!contains("id=\"queue-view-tabs\"", queue_workspace));
assert.ok(!contains("data-list-view=", this.markup));
assert.deepEqual(countOccurrences(this.markup, "data-host-workspace=\"history\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-host-workspace-panel=\"history\""), 1);
assert.ok(!contains("id=\"history-toggle-button\"", this.markup));
},
async test_old_flip_and_manual_wheel_seam_are_removed() {
let list_css, list_scroll_css;
assert.ok(!contains("listFlip", this.source));
assert.ok(!contains("syncListStageView", this.source));
assert.ok(!contains("elements.listStage.addEventListener(\"wheel\"", this.source));
assert.ok(!contains("list-stage-inner", this.markup));
assert.ok(!contains("list-face", this.markup));
list_css = this.styles.slice(sourceIndex(this.styles, ".list-stage {"), sourceIndex(this.styles, ".queue-card-head h2", sourceIndex(this.styles, ".list-stage {")));
assert.ok(!contains("perspective", list_css));
assert.ok(!contains("rotateY", list_css));
assert.ok(!contains("backface-visibility", list_css));
assert.ok(contains("overflow: hidden", list_css));
assert.ok(contains("grid-template-rows: auto minmax(0, 1fr)", list_css));
list_scroll_css = this.styles.slice(sourceIndex(this.styles, ".playlist,"), sourceIndex(this.styles, ".queue-empty", sourceIndex(this.styles, ".playlist,")));
assert.ok(contains("overflow: auto", list_scroll_css));
assert.ok(contains("overscroll-behavior: contain", list_scroll_css));
assert.ok(contains("function syncQueueScrollOwnership()", this.source));
assert.ok(contains("playlist.classList.toggle(\"is-scrollable\", scrollable)", this.source));
assert.ok(contains("playlist.classList.toggle(\"is-content-fit\", !scrollable)", this.source));
assert.match(this.styles, new RegExp("\\.host-workspace-region \\.playlist\\s*\\{[^}]*overflow-y: hidden;[^}]*scrollbar-gutter: auto;","s"));
assert.match(this.styles, new RegExp("\\.host-workspace-region \\.playlist\\.is-scrollable\\s*\\{[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;","s"));
},
async test_request_discover_uses_one_direct_accessible_workspace() {
let expected, expected_labels, key, labels, language, mode, owner_panel, panel, panel_markup, quick_tab, request_workspace, source_uid_tab;
assert.deepEqual(countOccurrences(this.markup, "id=\"host-workspace-request\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-request-view=\"quick\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-request-view=\"search\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-request-view=\"discover\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-request-view=\"sources\""), 1);
request_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"host-workspace-request\""), sourceIndex(this.markup, "id=\"session-users-panel\""));
assert.ok(contains("role=\"tablist\"", request_workspace));
quick_tab = request_workspace.slice(sourceIndex(request_workspace, "data-request-view=\"quick\""), sourceIndex(request_workspace, "</button>", sourceIndex(request_workspace, "data-request-view=\"quick\"")));
assert.ok(contains("aria-selected=\"true\"", quick_tab));
assert.ok(contains("tabindex=\"0\"", quick_tab));
assert.ok(contains("data-request-panel=\"quick\"", request_workspace));
assert.ok(!contains("data-request-panel=\"quick\" hidden", request_workspace));
for (const panel of iterableValues(["search", "discover", "sources"])) {
panel_markup = request_workspace.slice(sourceIndex(request_workspace, ("data-request-panel=\"" + String(panel) + "\"")), sourceIndex(request_workspace, ">", sourceIndex(request_workspace, ("data-request-panel=\"" + String(panel) + "\""))));
assert.ok(contains("hidden", panel_markup));
assert.ok(contains("inert", panel_markup));
}
for (const mode of iterableValues(["shared", "local"])) {
assert.deepEqual(countOccurrences(request_workspace, ("data-search-mode=\"" + String(mode) + "\"")), 1);
}
for (const mode of iterableValues(["categories", "name", "artist"])) {
assert.deepEqual(countOccurrences(request_workspace, ("data-discover-mode=\"" + String(mode) + "\"")), 1);
}
for (const mode of iterableValues(["uids", "favorites"])) {
assert.deepEqual(countOccurrences(request_workspace, ("data-sources-mode=\"" + String(mode) + "\"")), 1);
}
assert.ok(!contains("data-sources-mode=\"followed\"", request_workspace));
source_uid_tab = request_workspace.slice(sourceIndex(request_workspace, "data-sources-mode=\"uids\""), sourceIndex(request_workspace, "</button>", sourceIndex(request_workspace, "data-sources-mode=\"uids\"")));
assert.ok(contains("data-i18n=\"sources.ownerList\">UP 主列表", source_uid_tab));
assert.ok(!contains("data-i18n=\"sources.addedUids\"", source_uid_tab));
owner_panel = request_workspace.slice(sourceIndex(request_workspace, "id=\"request-sources-uids\""), sourceIndex(request_workspace, "id=\"request-sources-favorites\""));
assert.ok(contains("id=\"modal-follow-uid-form\"", owner_panel));
assert.ok(contains("id=\"request-sources-followed-scroll\"", owner_panel));
assert.ok(contains("id=\"follow-up-grid\"", owner_panel));
assert.ok(!contains("id=\"request-sources-followed\"", request_workspace));
assert.ok(!contains("id=\"open-added-uids-button\"", request_workspace));
assert.ok(!contains("id=\"open-favorites-button\"", request_workspace));
expected_labels = {["request.quickTab"]: {["zh"]: "快速点歌", ["en"]: "Quick", ["ja"]: "クイック"}, ["request.searchTab"]: {["zh"]: "搜索", ["en"]: "Search", ["ja"]: "検索"}, ["request.discoverTab"]: {["zh"]: "发现", ["en"]: "Discover", ["ja"]: "見つける"}, ["request.sourcesTab"]: {["zh"]: "来源", ["en"]: "Sources", ["ja"]: "ソース"}, ["search.sharedCatalog"]: {["zh"]: "共享曲库", ["en"]: "Shared", ["ja"]: "共有ライブラリ"}, ["search.localLibrary"]: {["zh"]: "本地曲库", ["en"]: "Local", ["ja"]: "ローカルライブラリ"}, ["sources.addUid"]: {["zh"]: "添加 UID", ["en"]: "Add UID", ["ja"]: "UID を追加"}, ["sources.ownerList"]: {["zh"]: "UP 主列表", ["en"]: "Uploader List", ["ja"]: "UP 主一覧"}, ["sources.favorites"]: {["zh"]: "收藏夹", ["en"]: "Favorites", ["ja"]: "お気に入り"}};
for (const [key, labels] of iterableValues(Object.entries(expected_labels))) {
for (const [language, expected] of iterableValues(Object.entries(labels))) {
{
assert.deepEqual(this.i18n[language][key], expected);
}
}
}
},
async test_all_tools_and_request_subviews_share_one_width_per_shell_state() {
assert.ok(!contains("--host-workspace-width", this.styles));
assert.ok(!contains("data-request-subview", this.styles));
assert.ok(contains("--host-tool-card-width: minmax(380px, 1fr)", this.styles));
assert.ok(!contains("--host-tool-card-width: 500px", this.styles));
assert.ok(contains("--host-rail-width", this.styles));
},
async test_request_removes_host_search_flip_modal_and_source_duplicates() {
let random_workspace, retired_css, retired_markup, retired_source;
for (const retired_markup of iterableValues(["id=\"search-stage\"", "id=\"search-stage-inner\"", "id=\"search-expand-button\"", "id=\"search-modal\"", "id=\"lark-search-hitbox-form\""])) {
assert.ok(!contains(retired_markup, this.markup));
}
for (const retired_source of iterableValues(["searchStageView", "searchStageAngle", "searchFlipTimer", "searchFlipFrame", "syncSearchStageView", "openExpandedSearchModal", "closeExpandedSearchModal", "searchModalPlaceholder.appendChild"])) {
assert.ok(!contains(retired_source, this.source));
}
for (const retired_css of iterableValues([".search-stage", ".search-face-front", ".search-modal-card"])) {
assert.ok(!contains(retired_css, this.styles));
}
assert.deepEqual(countOccurrences(this.markup, "id=\"modal-follow-uid-form\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"refresh-gatcha-cache-button\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"modal-favlist-pull-form\""), 1);
random_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"gatcha-panel\""), sourceIndex(this.markup, "id=\"host-workspace-queue\""));
assert.ok(!contains("id=\"gatcha-uid-form\"", random_workspace));
assert.ok(!contains("id=\"refresh-gatcha-cache-button\"", random_workspace));
assert.ok(!contains("id=\"pull-gatcha-favlist-button\"", random_workspace));
assert.ok(!contains("id=\"manage-sources-button\"", random_workspace));
},
async test_gatcha_is_one_direct_state_workspace_with_local_scroll() {
let gatcha_body_rule, random_owner_rule, random_workspace, view;
assert.deepEqual(countOccurrences(this.markup, "id=\"gatcha-panel\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"gatcha-pool-config-modal\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"manage-sources-button\""), 0);
assert.deepEqual(countOccurrences(this.markup, "id=\"gatcha-button\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"gatcha-retry-button\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"gatcha-confirm-button\""), 1);
for (const view of iterableValues(["idle", "drawing", "candidate", "error"])) {
{
assert.deepEqual(countOccurrences(this.markup, ("data-gatcha-view=\"" + String(view) + "\"")), 1);
}
}
random_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"gatcha-panel\""), sourceIndex(this.markup, "id=\"host-workspace-queue\""));
assert.ok(contains("id=\"gatcha-stage\"", random_workspace));
assert.ok(contains("data-i18n-aria-label=\"gatcha.scrollLabel\"", random_workspace));
assert.ok(!contains("gatcha-face", random_workspace));
assert.ok(!contains("perspective", this.styles.slice(sourceIndex(this.styles, ".gatcha-panel {"), undefined)));
assert.ok(!contains("rotateY", this.styles.slice(sourceIndex(this.styles, ".gatcha-panel {"), undefined)));
random_owner_rule = this.styles.match(new RegExp("\\.host-workspace-region\\[data-active-workspace=\"random\"\\]\\s*\\{([^}]*)\\}",""));
assert.notEqual(random_owner_rule, null);
assert.ok(contains("overflow: hidden", random_owner_rule[1]));
gatcha_body_rule = this.styles.match(new RegExp("\\.gatcha-stage\\s*\\{([^}]*)\\}",""));
assert.notEqual(gatcha_body_rule, null);
assert.ok(contains("overflow-y: auto", gatcha_body_rule[1]));
assert.ok(contains("overscroll-behavior: contain", gatcha_body_rule[1]));
},
async test_gatcha_state_and_pool_ownership_are_narrow_and_stale_safe() {
let field, forbidden, pool_sheet, random_workspace;
for (const field of iterableValues(["gatchaView", "gatchaDrawBusy", "gatchaDrawSequence", "gatchaDrawError", "gatchaScrollTop", "poolConfigAccepted", "poolConfigDraft", "poolConfigLoading", "poolConfigLoadSequence", "poolConfigSaveSequence"])) {
{
assert.ok(contains(field, this.source));
}
}
assert.ok(contains("renderGatchaWorkspace();", this.source));
assert.ok(contains("state.gatchaDrawSequence !== drawSequence", this.source));
assert.ok(contains("state.poolConfigLoadSequence !== loadSequence", this.source));
assert.ok(contains("state.poolConfigSaveSequence !== saveSequence", this.source));
random_workspace = this.markup.slice(sourceIndex(this.markup, "id=\"gatcha-panel\""), sourceIndex(this.markup, "id=\"host-workspace-queue\""));
pool_sheet = this.markup.slice(sourceIndex(this.markup, "id=\"gatcha-pool-config-modal\""), sourceIndex(this.markup, "id=\"bilikara-secret-modal\""));
for (const forbidden of iterableValues(["id=\"modal-follow-uid-form\"", "id=\"refresh-gatcha-cache-button\"", "id=\"modal-favlist-pull-form\"", "/api/gatcha/uids/add", "/api/gatcha/refresh", "/api/gatcha/favlist"])) {
{
assert.ok(!contains(forbidden, random_workspace));
assert.ok(!contains(forbidden, pool_sheet));
}
}
},
async test_sources_and_rating_reuse_the_add_uid_command() {
let rating_handler_end, rating_handler_start, rating_open_end, rating_open_start, rating_render_start, rating_source, source_owner;
assert.deepEqual(countOccurrences(this.markup, "id=\"modal-follow-uid-form\""), 1);
assert.deepEqual(Array.from(this.source.matchAll(new RegExp("(?<!function )\\baddGatchaUid\\(","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).length, 2);
assert.ok(contains("data-rating-add-up", this.source));
rating_render_start = sourceIndex(this.source, "function renderRatingPromptContent()");
rating_open_start = sourceIndex(this.source, "function openRatingPrompt(", rating_render_start);
rating_open_end = sourceIndex(this.source, "function maybeShowRatingPromptForProgress", rating_open_start);
rating_handler_start = sourceIndex(this.source, `document.addEventListener("click", async (event) => {
  const root = state.ratingPromptElement;`);
rating_handler_end = sourceIndex(this.source, "function handleRatingFullscreenChange()", rating_handler_start);
rating_source = concatenate(concatenate(this.source.slice(rating_render_start, rating_open_start), this.source.slice(rating_open_start, rating_open_end)), this.source.slice(rating_handler_start, rating_handler_end));
assert.ok(contains("await addGatchaUid(uid)", rating_source));
assert.ok(contains("addUpButton.setAttribute(\"aria-busy\", \"true\")", rating_source));
for (const source_owner of iterableValues(["previewGatchaUid(", "refreshGatchaCache(", "previewGatchaFavlist(", "fetchGatchaBrowse(", "fetchGatchaFavlistBrowse("])) {
{
assert.ok(!contains(source_owner, rating_source));
}
}
},
async test_reorder_actions_use_one_confirmed_exact_index_command() {
let move_action_end, move_action_start;
assert.deepEqual(countOccurrences(this.markup, "data-action=\"move-up\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-action=\"move-down\""), 1);
assert.ok(contains("data-i18n-aria-label=\"common.moveUp\"", this.markup));
assert.ok(contains("data-i18n-aria-label=\"common.moveDown\"", this.markup));
assert.deepEqual(countOccurrences(this.source, "apiPostStateSnapshot(\"/api/playlist/reorder\""), 1);
assert.ok(contains("moveUpButton.disabled = index === 0", this.source));
assert.ok(contains("moveDownButton.disabled = index === playlist.length - 1", this.source));
move_action_start = sourceIndex(this.source, "if (button.dataset.action === \"move-up\"");
move_action_end = sourceIndex(this.source, "if (button.dataset.action === \"remove\")", move_action_start);
assert.ok(contains("targetIndex,", this.source.slice(move_action_start, move_action_end)));
assert.ok(contains("if (accepted) {", this.source));
assert.ok(contains("focusPlaylistItemMenuTrigger(intent.focusItemId)", this.source));
assert.ok(contains("elements.confirmCancel.focus({ preventScroll: true })", this.source));
},
async test_escape_uses_one_authoritative_layer_before_row_menus() {
let escape_end, escape_source, escape_start, layer, ordered_layers, positions;
assert.deepEqual(countOccurrences(this.markup, "aria-haspopup=\"menu\" aria-expanded=\"false\""), 2);
assert.deepEqual(countOccurrences(this.markup, "class=\"song-actions menu-content hidden\" role=\"menu\""), 1);
assert.deepEqual(countOccurrences(this.markup, "class=\"history-actions menu-content hidden\" role=\"menu\""), 1);
escape_start = sourceIndex(this.source, "document.addEventListener(\"keydown\", (event) => {");
escape_end = sourceIndex(this.source, "document.addEventListener(\"visibilitychange\"", escape_start);
escape_source = this.source.slice(escape_start, escape_end);
ordered_layers = ["if (state.confirmIntent)", "closeHighestRequestTaskLayerForEscape()", "searchDetailController?.isOpen?.()", "closeOrdinaryPopoverForEscape()", "if (state.stageControlTrayOpen && !stageControlsAreInline())", "closeHostWorkspaceOverlay()", "closeOpenMenus({ restoreFocus: true })"];
positions = Array.from(Array.from(iterableValues(ordered_layers))).map((layer) => sourceIndex(escape_source, layer));
assert.deepEqual(positions, Array.from(positions).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0));
assert.ok(contains("state.openRowMenuTrigger = toggle", this.source));
assert.ok(contains("trigger.focus({ preventScroll: true })", this.source));
},
async test_clear_confirm_warns_that_the_playing_song_survives_in_every_language() {
let expected_clear_phrases, language, translations;
expected_clear_phrases = {["zh"]: "当前正在播放的歌曲不会受影响", ["en"]: "currently playing song will not be affected", ["ja"]: "現在再生中の曲には影響しません"};
for (const [language, translations] of iterableValues(Object.entries(this.i18n))) {
{
assert.ok(contains(expected_clear_phrases[language], translations["list.clearConfirm"]));
}
}
}
};
test("QueueHistoryFrontendTest.test_direct_workspaces_are_stable_accessible_and_preserve_scroll", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_direct_workspaces_are_stable_accessible_and_preserve_scroll(); });
test("QueueHistoryFrontendTest.test_rail_keyboard_wraps_and_supports_home_end", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_rail_keyboard_wraps_and_supports_home_end(); });
test("QueueHistoryFrontendTest.test_markup_places_actions_on_their_final_owners", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_markup_places_actions_on_their_final_owners(); });
test("QueueHistoryFrontendTest.test_old_flip_and_manual_wheel_seam_are_removed", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_old_flip_and_manual_wheel_seam_are_removed(); });
test("QueueHistoryFrontendTest.test_request_discover_uses_one_direct_accessible_workspace", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_request_discover_uses_one_direct_accessible_workspace(); });
test("QueueHistoryFrontendTest.test_all_tools_and_request_subviews_share_one_width_per_shell_state", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_all_tools_and_request_subviews_share_one_width_per_shell_state(); });
test("QueueHistoryFrontendTest.test_request_removes_host_search_flip_modal_and_source_duplicates", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_request_removes_host_search_flip_modal_and_source_duplicates(); });
test("QueueHistoryFrontendTest.test_gatcha_is_one_direct_state_workspace_with_local_scroll", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_gatcha_is_one_direct_state_workspace_with_local_scroll(); });
test("QueueHistoryFrontendTest.test_gatcha_state_and_pool_ownership_are_narrow_and_stale_safe", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_gatcha_state_and_pool_ownership_are_narrow_and_stale_safe(); });
test("QueueHistoryFrontendTest.test_sources_and_rating_reuse_the_add_uid_command", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_sources_and_rating_reuse_the_add_uid_command(); });
test("QueueHistoryFrontendTest.test_reorder_actions_use_one_confirmed_exact_index_command", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_reorder_actions_use_one_confirmed_exact_index_command(); });
test("QueueHistoryFrontendTest.test_escape_uses_one_authoritative_layer_before_row_menus", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_escape_uses_one_authoritative_layer_before_row_menus(); });
test("QueueHistoryFrontendTest.test_clear_confirm_warns_that_the_playing_song_survives_in_every_language", async () => { const instance = Object.create(QueueHistoryFrontendTest); await instance.setUpClass(); await instance.test_clear_confirm_warns_that_the_playing_song_survives_in_every_language(); });
