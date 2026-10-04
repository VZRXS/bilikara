import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, splitOnce, sourceIndex, iterableValues, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const AvDelayFrontendTest = {
async setUpClass() {
this.host_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.host_html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.remote_html = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.host_css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
this.remote_css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
},
async test_existing_panels_are_the_only_lock_entry_points() {
assert.deepEqual(countOccurrences(this.host_html, "data-av-delay-lock"), 1);
assert.deepEqual(countOccurrences(this.remote_html, "data-av-delay-lock"), 1);
assert.ok(contains("id=\"av-delay-lock-button\"", this.host_html));
assert.ok(contains("id=\"remote-av-delay-lock-button\"", this.remote_html));
},
async test_host_lock_button_is_immediately_right_of_reset_button() {
let lock_position, positive_step_position, reset_position;
positive_step_position = sourceIndex(this.host_html, "data-step=\"200\"");
reset_position = sourceIndex(this.host_html, "id=\"av-offset-reset-button\"");
lock_position = sourceIndex(this.host_html, "data-av-delay-lock");
assert.ok(positive_step_position < reset_position);
assert.ok(reset_position < lock_position);
},
async test_remote_av_delay_spinner_sits_next_to_unit() {
let declarations, input_rules, input_selector, rule, rules, selector;
selector = "#remote-av-sync-panel .remote-input-wrap {";
rules = this.remote_css.split(selector);
assert.ok(rules.length >= 3);
for (const rule of iterableValues(rules.slice(1, undefined))) {
declarations = splitOnce(rule, "}")[0];
assert.ok(contains("justify-content: flex-end;", declarations));
assert.ok(contains("gap: 4px;", declarations));
}
input_selector = "#remote-av-sync-panel .remote-input-wrap input[type=\"number\"] {";
input_rules = this.remote_css.split(input_selector);
assert.ok(input_rules.length >= 3);
for (const rule of iterableValues(input_rules.slice(1, undefined))) {
declarations = splitOnce(rule, "}")[0];
assert.ok(contains("padding: 0;", declarations));
assert.ok(contains("margin: 0;", declarations));
}
assert.ok(contains("#remote-av-sync-panel .remote-input-wrap input[type=\"number\"]::-webkit-inner-spin-button", this.remote_css));
},
async test_host_and_remote_contextual_info_markup_is_accessible_and_audited() {
let advanced, metadata_popover, playback_controls, playback_sheet, volume_panel;
advanced = this.host_html.slice(sourceIndex(this.host_html, "id=\"cache-advanced-inline-view\""), sourceIndex(this.host_html, "class=\"cache-panel-footer\""));
assert.deepEqual(countOccurrences(advanced, "class=\"cache-advanced-info-button\""), 4);
assert.deepEqual(countOccurrences(advanced, "class=\"contextual-info-glyph\" aria-hidden=\"true\">i</span>"), 4);
assert.deepEqual(countOccurrences(advanced, "data-i18n-aria-label=\"common.moreInfo\""), 4);
assert.deepEqual(countOccurrences(advanced, "aria-describedby=\"cache-advanced-"), 4);
assert.deepEqual(countOccurrences(advanced, "role=\"tooltip\""), 4);
assert.ok(!contains("aria-hidden=\"true\">?</span>", advanced));
assert.ok(!contains("service.releaseOnlyHint", advanced));
assert.ok(!contains("service.dataCleanupHint", advanced));
assert.ok(contains("data-i18n=\"service.restartApplicationHint\"", advanced));
assert.ok(contains("data-i18n=\"service.playbackRepairHint\"", advanced));
assert.ok(contains("data-i18n=\"service.dataCleanupScope\"", advanced));
assert.ok(contains("data-i18n=\"service.diagnosticsHint\"", advanced));
assert.ok(!contains("class=\"cache-panel-hint cache-data-cleanup-scope\"", advanced));
playback_sheet = this.remote_html.slice(sourceIndex(this.remote_html, "id=\"playback-sheet\""), sourceIndex(this.remote_html, "id=\"remote-identity-modal\""));
assert.deepEqual(countOccurrences(playback_sheet, "class=\"remote-info-button\""), 3);
assert.deepEqual(countOccurrences(playback_sheet, "class=\"contextual-info-glyph\" aria-hidden=\"true\">i</span>"), 3);
assert.deepEqual(countOccurrences(playback_sheet, "data-i18n-aria-label=\"common.moreInfo\""), 3);
assert.deepEqual(countOccurrences(playback_sheet, "aria-describedby=\"remote-"), 3);
assert.deepEqual(countOccurrences(playback_sheet, "role=\"tooltip\""), 4);
assert.deepEqual(countOccurrences(playback_sheet, "id=\"playback-metadata-popover\""), 1);
metadata_popover = playback_sheet.slice(sourceIndex(playback_sheet, "id=\"playback-metadata-popover\""), undefined);
assert.ok(!contains("aria-modal=\"true\"", metadata_popover));
volume_panel = playback_sheet.slice(sourceIndex(playback_sheet, "id=\"remote-volume-panel\""), sourceIndex(playback_sheet, "id=\"remote-key-shift-panel\""));
assert.ok(contains("remote-info-button", volume_panel));
assert.ok(contains("aria-describedby=\"remote-volume-info\"", volume_panel));
assert.ok(contains("data-i18n=\"player.volumeBoostHelp\"", volume_panel));
playback_controls = this.host_html.slice(sourceIndex(this.host_html, "id=\"av-sync-panel\""), sourceIndex(this.host_html, "id=\"host-workspace-settings\""));
assert.deepEqual(countOccurrences(playback_controls, "class=\"playback-contextual-info-button"), 3);
assert.deepEqual(countOccurrences(playback_controls, "class=\"contextual-info-glyph\" aria-hidden=\"true\">i</span>"), 3);
assert.ok(!contains("aria-hidden=\"true\">?</span>", playback_controls));
assert.ok(!contains("class=\"av-sync-hint\"", playback_controls));
assert.ok(!contains("class=\"volume-hint\"", playback_controls));
assert.ok(!contains("id=\"volume-panel\" class=\"volume-panel cache-contextual-info-region\"", playback_controls));
assert.ok(contains("aria-describedby=\"host-av-sync-info\"", playback_controls));
assert.ok(contains("aria-describedby=\"host-key-shift-info\"", playback_controls));
assert.ok(contains("aria-describedby=\"host-volume-info\"", playback_controls));
assert.deepEqual(countOccurrences(playback_controls, "role=\"tooltip\""), 3);
},
async test_contextual_info_styles_cover_fine_and_coarse_pointers() {
assert.ok(contains("@media (hover: hover) and (pointer: fine)", this.host_css));
assert.ok(contains("@media (hover: none), (pointer: coarse)", this.host_css));
assert.ok(contains(".cache-advanced-info:hover .cache-advanced-info-button", this.host_css));
assert.ok(!contains(".cache-contextual-info-region:hover .cache-advanced-info-button", this.host_css));
assert.ok(contains(".cache-advanced-info.is-visible .cache-advanced-tooltip", this.host_css));
assert.ok(!contains(":hover", this.remote_css));
assert.ok(contains("@media (hover: none), (pointer: coarse)", this.remote_css));
assert.ok(contains(".remote-info-button:focus-visible", this.remote_css));
assert.ok(contains(".info-trigger-wrap.is-visible .remote-tooltip-bubble", this.remote_css));
assert.ok(!contains(".info-trigger-wrap.show-tooltip", this.remote_css));
},
async test_contextual_info_scripts_separate_transient_and_pinned_state() {
assert.ok(contains("const cacheAdvancedInfoHoverDelayMs = 160;", this.host_js));
assert.ok(contains("function showCacheAdvancedInfoTransient", this.host_js));
assert.ok(contains("classList.contains(\"is-pinned\")", this.host_js));
assert.ok(!contains("remoteContextualInfoHoverDelayMs", this.remote_js));
assert.ok(contains("region.addEventListener(\"focusin\"", this.remote_js));
assert.ok(contains("function showRemoteContextualInfoTransient", this.remote_js));
assert.ok(!contains("classList.contains(\"show-tooltip\")", this.remote_js));
},
async test_frontends_dispatch_actions_and_render_rust_snapshot_fields() {
let source;
for (const source of iterableValues([this.host_js, this.remote_js])) {
assert.ok(contains("/api/player/av-delay-action", source));
assert.ok(contains("has_local_adjustment", source));
assert.ok(contains("lock_button_enabled", source));
assert.ok(contains("effective_delay_ms", source));
assert.ok(contains("{ type: \"adjust\", delta_ms:", source));
assert.ok(contains("{ type: \"reset_local\" }", source));
assert.ok(contains("{ type: \"toggle_lock\" }", source));
assert.ok(!contains("bilikara.player.av_offset_ms", source));
assert.ok(!contains("global_delay_ms + local_delay_ms", source));
assert.ok(!contains("local_delay_ms + global_delay_ms", source));
}
},
async test_host_and_remote_render_backend_button_decisions() {
let busy_key, call, cases, completed, enabled, end_marker, fixture, fixtures, function_source, has_local, input_key, lock_key, locked, offset_helper, panel_key, reset_key, result, script, source, start_marker;
fixtures = [[this.host_js, "function renderAvSyncControls", "function renderPlayer", "avDelayLockButton", "avOffsetResetButton", "avOffsetInput", "avSyncPanel", "avOffsetSaving", "function currentAvOffsetMs() { return currentSettings.av_delay.effective_delay_ms; }", "renderAvSyncControls('local', currentSettings);"], [this.remote_js, "function setRemoteIconVisibility", "function renderRemoteVolumeControls", "remoteAvDelayLockButton", "remoteAvOffsetResetButton", "remoteAvOffsetInput", "remoteAvSyncPanel", "remoteAvDelaySaving", "function currentRemoteAvOffsetMs(settings) { return settings.av_delay.effective_delay_ms; }", "renderRemoteAvSyncControls('local', currentSettings);"]];
cases = [[false, false, false], [false, true, true], [true, false, true], [true, true, true]];
for (const fixture of iterableValues(fixtures)) {
[source, start_marker, end_marker, lock_key, reset_key, input_key, panel_key, busy_key, offset_helper, call] = fixture;
function_source = source.slice(sourceIndex(source, start_marker), sourceIndex(source, end_marker, sourceIndex(source, start_marker)));
for (const [locked, has_local, enabled] of iterableValues(cases)) {
script = (`
const currentSettings = { av_delay: { effective_delay_ms: 0, locked: ` + String(String(locked).toLowerCase()) + `,
  has_local_adjustment: ` + String(String(has_local).toLowerCase()) + ", lock_button_enabled: " + String(String(enabled).toLowerCase()) + ` } };
const icons = ['locked', 'unlocked'].map(value => ({
  dataset: { avLockIcon: value }, hidden: false, getAttribute() { return value; },
  classList: { toggle(_name, hidden) { icons.find(icon => icon.dataset.avLockIcon === value).hidden = hidden; } }
}));
function element() { return { disabled: false, value: '', textContent: '', title: '', dataset: {},
  attributes: {}, setAttribute(k, v) { this.attributes[k] = String(v); },
  classList: { toggle() {} }, querySelectorAll(selector) { return selector === "[data-av-lock-icon]" ? icons : []; } }; }
const elements = { ` + String(lock_key) + ": element(), " + String(reset_key) + ": element(), " + String(input_key) + ": element(), " + String(panel_key) + `: element() };
const state = { ` + String(busy_key) + `: false };
const document = { activeElement: null };
function t(key) { return key; }
` + String(offset_helper) + `
` + String(function_source) + `
` + String(call) + `
console.log(JSON.stringify({ disabled: elements.` + String(lock_key) + `.disabled,
  visibleIcons: icons.filter(icon => !icon.hidden).map(icon => icon.dataset.avLockIcon),
  pressed: elements.` + String(lock_key) + `.attributes['aria-pressed'],
  hasLocal: elements.` + String(lock_key) + `.dataset.hasLocal }));
`);
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result["disabled"], (!enabled));
assert.deepEqual(result["visibleIcons"], [(locked ? "locked" : "unlocked")]);
assert.deepEqual(result["pressed"], String(locked).toLowerCase());
assert.deepEqual(result["hasLocal"], String(has_local).toLowerCase());
}
}
},
async test_av_delay_actions_use_lightweight_decisions_and_a_timeout() {
let source;
for (const source of iterableValues([this.host_js, this.remote_js])) {
assert.ok(contains("const avDelayRequestTimeoutMs = 8000;", source));
assert.ok(contains("new AbortController()", source));
assert.ok(contains("{ timeoutMs: avDelayRequestTimeoutMs }", source));
assert.ok(contains("av_delay: decision", source));
assert.ok(contains("av_offset_ms: Number(decision?.effective_delay_ms || 0)", source));
}
},
async test_api_post_aborts_a_stalled_av_delay_request() {
let api_post_source, childResult, end, end_marker, fixtures, script, source, start;
fixtures = [[this.host_js, "function submitSongRating"], [this.remote_js, "function normalizedRemoteIdentity"]];
for (const [source, end_marker] of iterableValues(fixtures)) {
start = sourceIndex(source, "async function apiPost");
end = sourceIndex(source, end_marker, start);
api_post_source = source.slice(start, end);
script = (`
const window = globalThis;
function clientHeaders(headers) { return headers; }
function localizedApiMessage(value) { return value; }
function t(key) { return key; }
function fetch(url, options) {
  return new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}
` + String(api_post_source) + `
apiPost("/api/player/av-delay-action", {}, { timeoutMs: 10 })
  .then(() => process.exit(2))
  .catch((error) => {
    if (error.message !== "error.requestTimeout") process.exit(3);
    process.exit(0);
  });
`);
childResult = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(childResult.status, 0, (childResult.stderr || childResult.stdout));
}
},
async test_all_four_visual_combinations_and_disabled_state_are_styled() {
let local_rule, locked_local_rule, locked_rule, selector, source, state_rule, token;
for (const [source, selector] of iterableValues([[this.host_css, ".av-sync-lock-button"], [this.remote_css, ".remote-lock-button"]])) {
assert.ok(contains((String(selector) + "[data-has-local=\"true\"]"), source));
assert.ok(contains((String(selector) + "[data-locked=\"true\"]"), source));
assert.ok(contains((String(selector) + "[data-locked=\"true\"][data-has-local=\"true\"]"), source));
assert.ok(contains((String(selector) + ":disabled"), source));
assert.ok(contains("background: var(--av-lock-unlocked-bg);", source));
assert.ok(contains("background: var(--av-lock-disabled-bg);", source));
for (const token of iterableValues(["--av-lock-hover-filter", "--av-lock-focus-outline", "--av-lock-focus-shadow", "--av-lock-active-transform"])) {
assert.ok(contains(token, source));
}
assert.ok(contains((String(selector) + "[data-has-local=\"true\"]::after"), source));
assert.ok(contains("content: \"\";", source));
assert.ok(contains("position: absolute;", source));
assert.ok(contains("inset-block-start: 6px;", source));
assert.ok(contains("inset-inline-end: 6px;", source));
assert.ok(contains((String(selector) + ":focus-visible"), source));
assert.ok(contains((String(selector) + ":not(:disabled):active"), source));
local_rule = splitOnce(splitOnce(source, (String(selector) + "[data-has-local=\"true\"] {"))[1], "}")[0];
locked_rule = splitOnce(splitOnce(source, (String(selector) + "[data-locked=\"true\"] {"))[1], "}")[0];
locked_local_rule = splitOnce(splitOnce(source, (String(selector) + "[data-locked=\"true\"][data-has-local=\"true\"] {"))[1], "}")[0];
for (const state_rule of iterableValues([local_rule, locked_rule, locked_local_rule])) {
assert.ok(!contains("background:", state_rule));
}
}
},
async test_remote_lock_and_reset_share_the_idle_button_surface() {
let peer_rule, root_vars;
root_vars = this.remote_css.slice(0, sourceIndex(this.remote_css, "body {"));
assert.ok(contains("--av-lock-unlocked-border: 1px solid rgba(67, 53, 41, 0.08);", root_vars));
assert.ok(contains("--av-lock-disabled-bg: var(--remote-secondary-button-disabled-bg);", root_vars));
peer_rule = this.remote_css.slice(sourceIndex(this.remote_css, ".remote-step-button,"), sourceIndex(this.remote_css, ".remote-step-button {"));
assert.ok(contains(".remote-reset-button", peer_rule));
assert.ok(contains(".remote-lock-button", peer_rule));
assert.ok(contains("border-radius: 14px", peer_rule));
}
};
test("AvDelayFrontendTest.test_existing_panels_are_the_only_lock_entry_points", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_existing_panels_are_the_only_lock_entry_points(); });
test("AvDelayFrontendTest.test_host_lock_button_is_immediately_right_of_reset_button", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_host_lock_button_is_immediately_right_of_reset_button(); });
test("AvDelayFrontendTest.test_remote_av_delay_spinner_sits_next_to_unit", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_remote_av_delay_spinner_sits_next_to_unit(); });
test("AvDelayFrontendTest.test_host_and_remote_contextual_info_markup_is_accessible_and_audited", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_host_and_remote_contextual_info_markup_is_accessible_and_audited(); });
test("AvDelayFrontendTest.test_contextual_info_styles_cover_fine_and_coarse_pointers", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_contextual_info_styles_cover_fine_and_coarse_pointers(); });
test("AvDelayFrontendTest.test_contextual_info_scripts_separate_transient_and_pinned_state", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_contextual_info_scripts_separate_transient_and_pinned_state(); });
test("AvDelayFrontendTest.test_frontends_dispatch_actions_and_render_rust_snapshot_fields", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_frontends_dispatch_actions_and_render_rust_snapshot_fields(); });
test("AvDelayFrontendTest.test_host_and_remote_render_backend_button_decisions", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_host_and_remote_render_backend_button_decisions(); });
test("AvDelayFrontendTest.test_av_delay_actions_use_lightweight_decisions_and_a_timeout", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_av_delay_actions_use_lightweight_decisions_and_a_timeout(); });
test("AvDelayFrontendTest.test_api_post_aborts_a_stalled_av_delay_request", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_api_post_aborts_a_stalled_av_delay_request(); });
test("AvDelayFrontendTest.test_all_four_visual_combinations_and_disabled_state_are_styled", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_all_four_visual_combinations_and_disabled_state_are_styled(); });
test("AvDelayFrontendTest.test_remote_lock_and_reset_share_the_idle_button_surface", async () => { const instance = Object.create(AvDelayFrontendTest); await instance.setUpClass(); await instance.test_remote_lock_and_reset_share_the_idle_button_surface(); });
