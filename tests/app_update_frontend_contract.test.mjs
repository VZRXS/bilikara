import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const AppUpdateFrontendTest = {
async setUpClass() {
this.source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
this.i18n = readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8");
this.node = process.execPath;
},
async run_node(script) {
let completed;
if ((!this.node)) {
(() => { throw new Error("node is unavailable"); })();
}
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async source_slice(start, end) {
let start_index;
start_index = sourceIndex(this.source, start);
return this.source.slice(start_index, sourceIndex(this.source, end, start_index));
},
async test_shared_update_actions_keep_platform_installers_separate() {
let result;
assert.notEqual(this.node, null);
result = (await runNative(this.node, ["tests/host_updates.cjs"], process.env, 20 * 1000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
},
async test_update_preferences_and_marker_live_in_settings_workspace() {
let update_button_rule;
assert.ok(contains("updateAutomatic: \"bilikara.update.automatic\"", this.source));
assert.ok(contains("updateAutomaticEnabled: true", this.source));
assert.ok(contains("id=\"update-automatic-checkbox\"", this.html));
assert.ok(contains("id=\"settings-update-indicator\"", this.html));
assert.ok(!contains("id=\"service-update-indicator\"", this.html));
assert.ok(!contains("id=\"advanced-update-indicator\"", this.html));
assert.ok(contains("id=\"update-version-badge\"", this.html));
assert.ok(contains("id=\"app-update-status\"", this.html));
assert.ok(contains("class=\"service-status-wrap\"", this.html));
assert.ok(!contains("class=\"service-status-ring\"", this.html));
assert.ok(contains("class=\"cache-preview-field cache-update-upper-field\"", this.html));
assert.ok(sourceIndex(this.html, "for=\"update-preview-checkbox\"") < sourceIndex(this.html, "for=\"update-automatic-checkbox\""));
assert.ok(!contains(".service-status-ring.has-update", this.css));
assert.ok(contains(".work-rail-update-dot", this.css));
assert.ok(contains("--update-available-dot: var(--accent)", this.css));
update_button_rule = this.css.slice(sourceIndex(this.css, ".cache-update-button {"), sourceIndex(this.css, "}", sourceIndex(this.css, ".cache-update-button {")));
assert.ok(contains("width: max-content", update_button_rule));
assert.ok(contains("min-width: 0", update_button_rule));
assert.ok(contains("white-space: nowrap", update_button_rule));
assert.ok(!contains("min-width: 72px", update_button_rule));
assert.ok(contains(".bbdown-login-qr .bbdown-login-message", this.css));
assert.ok(contains("\"service.autoCheckUpdates\"", this.i18n));
assert.ok(contains("\"service.update\"", this.i18n));
},
async test_relaunch_failure_is_distinct_from_replacement_and_reported_once() {
let checkedFunction, key, language, r, result, translations;
checkedFunction = this.source.slice(sourceIndex(this.source, "function maybeReportLastInstall("), sourceIndex(this.source, "function renderUpdatePreviewControl("));
result = (await this.run_node((`
const state = {};
const messages = [];
const t = (key, args) => ({key, args});
const setAppMessage = (message, error = false) => messages.push({message, error});
` + String(checkedFunction) + `
for (const [operation, result, relaunch_failed] of [
  ["update-1", "installed", true], ["update-2", "installed", undefined],
  ["update-3", "failed", true], ["update-4", "failed", undefined],
  ["update-5", "owners_running", undefined]
]) {
  const update = {current_version:"v0.8.0-preview.4", last_install:{operation,result,relaunch_failed,log:"kept.log"}};
  maybeReportLastInstall(update);
  maybeReportLastInstall(update);
}
process.stdout.write(JSON.stringify(messages));
`)));
assert.deepEqual(result.length, 5);
assert.deepEqual(Array.from(Array.from(iterableValues(result))).map((r) => r["message"]["key"]), ["service.updateLastInstalledRestartFailed", "service.updateLastInstalled", "service.updateLastFailedRestartFailed", "service.updateLastFailed", "service.updateLastOwnersRunning"]);
assert.deepEqual(Array.from(Array.from(iterableValues(result))).map((r) => r["error"]), [true, false, true, true, true]);
assert.deepEqual(result[0]["message"]["args"], {["log"]: "kept.log", ["version"]: "v0.8.0-preview.4"});
translations = JSON.parse(this.i18n);
for (const language of iterableValues(["zh", "en", "ja"])) {
for (const key of iterableValues(["service.updateLastInstalledRestartFailed", "service.updateLastFailedRestartFailed"])) {
assert.ok(contains("{log}", translations["languages"][language][key]));
}
}
},
async test_startup_and_manual_paths_use_check_only_without_installing() {
let check_source;
assert.ok(contains("apiPost(\"/api/app/update/check\"", this.source));
assert.ok(contains("function scheduleStartupAppUpdateCheck", this.source));
assert.ok(contains("state.updateAutomaticAttemptedChannels", this.source));
assert.ok(contains("scheduleStartupAppUpdateCheck();", this.source));
assert.ok(contains("apiPost(\"/api/app/update/install\"", this.source));
check_source = this.source.slice(sourceIndex(this.source, "async function requestAppUpdateCheck"), sourceIndex(this.source, "async function installAppUpdate"));
assert.ok(!contains("/api/app/update/install", check_source));
assert.ok(!contains("setInterval", check_source));
},
async test_known_results_render_explicit_actions_and_current_channel_badges() {
assert.ok(contains("function isEligibleCurrentChannelUpdate", this.source));
assert.ok(contains("function shouldPresentCurrentChannelUpdate", this.source));
assert.ok(!contains("t(\"service.updateToVersion\"", this.source));
assert.ok(!contains("\"service.updateToVersion\"", this.i18n));
assert.ok(contains("t(\"service.update\")", this.source));
assert.ok(contains("t(\"service.viewVersion\"", this.source));
assert.ok(contains("t(\"service.newVersionBadge\"", this.source));
assert.ok(contains("update.include_preview === state.updatePreviewEnabled", this.source));
assert.ok(contains("openExternalUrl", this.source));
},
async test_preference_defaults_and_startup_check_are_executable_and_bounded() {
let hydrate_source, operation_source, result, script;
hydrate_source = (await this.source_slice("function hydrateLocalPreferences", "function renderHostWorkspaceSelection"));
operation_source = (await this.source_slice("async function requestAppUpdateCheck", "async function addSessionUser"));
script = (`
const stored = new Map();
const storageKeys = {
  playerVolume: "volume", playerMuted: "muted",
  updateAutomatic: "automatic", updatePreview: "preview", theme: "theme",
};
const state = {
  localPlayerVolume: 1, localPlayerMuted: false, theme: "light",
  updateAutomaticEnabled: true, updatePreviewEnabled: false,
  updateAutomaticAttemptedChannels: new Set(), startupUpdateCheckScheduled: false,
  updateCheckRequestInFlight: false, manualUpdateCheck: null,
  updateManualVisibleChannel: "",
  hasValidStateResponse: true, data: { app_update: { state: "idle", updated_at: 1, include_preview: false } },
};
const elements = { updateCheckButton: null, cacheSettings: null };
const posts = [];
const messages = [];
function readLocalNumber(key, fallback) { return stored.has(key) ? Number(stored.get(key)) : fallback; }
function readLocalBoolean(key, fallback) { return stored.has(key) ? stored.get(key) === "true" : fallback; }
function readLocalString(key, fallback) { return stored.has(key) ? stored.get(key) : fallback; }
function normalizeTheme(value) { return value === "dark" ? "dark" : "light"; }
function applyTheme(value) { state.theme = value; }
function appUpdateStatus() { return state.data.app_update; }
function isAppUpdateBusy(update = appUpdateStatus()) { return ["checking", "downloading", "installing", "restarting"].includes(update.state); }
function isEligibleCurrentChannelUpdate() { return false; }
function renderUpdatePreviewControl() {}
function closeConfirm() {}
function safeHttpUrl(value) { return value; }
function openExternalUrl() {}
function anchorPointForEvent() { return { x: 0, y: 0 }; }
function openConfirm() {}
function setAppMessage(message, isError = false) { messages.push({ message, isError }); }
function t(key) { return key; }
const appUpdateCheckTimeoutMs = 10000;
async function apiPost(path, payload) { posts.push({ path, payload }); return { state: "checking" }; }
` + String(hydrate_source) + `
` + String(operation_source) + `

(async () => {
  hydrateLocalPreferences();
  const defaults = { automatic: state.updateAutomaticEnabled, preview: state.updatePreviewEnabled };
  scheduleStartupAppUpdateCheck();
  await Promise.resolve();
  scheduleStartupAppUpdateCheck();
  await requestAppUpdateCheck({ automatic: true });
  const enabledPosts = posts.splice(0);

  state.updateAutomaticEnabled = true;
  state.updatePreviewEnabled = false;
  stored.set("automatic", "false");
  stored.set("preview", "true");
  hydrateLocalPreferences();
  const persisted = { automatic: state.updateAutomaticEnabled, preview: state.updatePreviewEnabled };
  state.startupUpdateCheckScheduled = false;
  scheduleStartupAppUpdateCheck();
  await Promise.resolve();

  process.stdout.write(JSON.stringify({ defaults, persisted, enabledPosts, disabledPostCount: posts.length, messages }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
result = (await this.run_node(script));
assert.deepEqual(result["defaults"], {["automatic"]: true, ["preview"]: false});
assert.deepEqual(result["persisted"], {["automatic"]: false, ["preview"]: true});
assert.deepEqual(result["enabledPosts"], [{["path"]: "/api/app/update/check", ["payload"]: {["include_preview"]: false}}]);
assert.deepEqual(result["disabledPostCount"], 0);
assert.deepEqual(result["messages"], []);
},
async test_host_basic_full_preference_is_retired_without_a_hidden_toggle() {
assert.ok(!contains("layoutMode: \"bilikara.layout.mode\"", this.source));
assert.ok(!contains("function normalizeLayoutMode", this.source));
assert.ok(!contains("function renderLayoutMode", this.source));
assert.ok(!contains("function setLayoutMode", this.source));
assert.ok(!contains("id=\"layout-mode-switch\"", this.html));
assert.ok(!contains("id=\"display-layout-summary\"", this.html));
assert.ok(!contains(".app-shell.layout-mode-basic", this.css));
assert.ok(!contains(".app-shell.layout-mode-full", this.css));
assert.deepEqual(countOccurrences(this.source, "removeItem(\"bilikara.layout.mode\")"), 1);
},
async test_indicator_rendering_and_manual_actions_are_executable() {
let name, operation_source, post, render_source, result, script;
render_source = (await this.source_slice("function appUpdateStatus", "function renderPlaybackRepairControls"));
operation_source = (await this.source_slice("async function requestAppUpdateCheck", "async function addSessionUser"));
script = (`
class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}
class FakeElement {
  constructor() { this.classList = new FakeClassList(); this.attributes = {}; this.textContent = ""; this.disabled = false; this.checked = false; this.id = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
}
function element(id = "") { const value = new FakeElement(); value.id = id; return value; }
const elements = {
  updateAutomaticCheckbox: element(), updatePreviewCheckbox: element(),
  updateCheckButton: element("update-check-button"), settingsUpdateIndicator: element(),
  appUpdateRow: element(), appUpdateStatus: element(),
  updateVersionBadge: element(), cacheSettings: element(),
};
const state = {
  data: { app_update: { state: "idle", include_preview: false, updated_at: 1 } },
  updateAutomaticEnabled: true, updatePreviewEnabled: false,
  updateCheckRequestInFlight: false, manualUpdateCheck: null,
  updateManualVisibleChannel: "",
  updateAutomaticAttemptedChannels: new Set(), startupUpdateCheckScheduled: true,
  hasValidStateResponse: true,
};
const posts = [];
const confirms = [];
const opened = [];
const messages = [];
function t(key, values = {}) { return \`\${key}:\${values.version || ""}\`; }
function setClassToggle(element, name, force) { element?.classList.toggle(name, force); }
function setTextContent(element, value) { if (element) element.textContent = String(value); }
function setElementTitle(element, value) { if (element) element.attributes.title = String(value); }
function setAppMessage(message, isError = false) { messages.push({ message, isError }); }
function anchorPointForEvent() { return { x: 1, y: 2 }; }
function openConfirm(value) { confirms.push(value); }
function closeConfirm() {}
function safeHttpUrl(value) { return String(value || ""); }
function openExternalUrl(value) { opened.push(value); }
const appUpdateCheckTimeoutMs = 10000;
async function apiPost(path, payload) { posts.push({ path, payload }); return { state: "checking" }; }
` + String(render_source) + `
` + String(operation_source) + `
function indicatorState() {
  return {
    settings: !elements.settingsUpdateIndicator.classList.contains("hidden"),
    row: elements.appUpdateRow.classList.contains("has-update"),
    badge: !elements.updateVersionBadge.classList.contains("hidden"),
    button: elements.updateCheckButton.textContent,
    status: elements.appUpdateStatus.textContent,
  };
}

(async () => {
  const states = {};
  for (const [name, update] of Object.entries({
    unknown: { state: "idle", include_preview: false, updated_at: 2 },
    checking: { state: "checking", include_preview: false, updated_at: 3 },
    current: { state: "idle", include_preview: false, updated_at: 4, update_action: "no_action", message: "current" },
    failed: { state: "failed", operation: "check", include_preview: false, updated_at: 5, error: "offline" },
    installable: { state: "available", include_preview: false, updated_at: 6, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.1", auto_update_supported: true, release_url: "https://example.test/v0.8.1" },
    viewOnly: { state: "available", include_preview: false, updated_at: 7, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.2", auto_update_supported: false, release_url: "https://example.test/v0.8.2" },
    stalePreview: { state: "available", include_preview: true, updated_at: 8, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.9.0-preview.1", auto_update_supported: true },
  })) {
    state.data.app_update = update;
    renderUpdatePreviewControl();
    states[name] = indicatorState();
  }
  state.updateAutomaticEnabled = false;
  state.updateManualVisibleChannel = "";
  state.data.app_update = { state: "available", include_preview: false, updated_at: 8.5, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.3", auto_update_supported: true };
  renderUpdatePreviewControl();
  states.automaticOff = indicatorState();
  state.updateManualVisibleChannel = "stable";
  renderUpdatePreviewControl();
  states.manualVisible = indicatorState();
  state.updateAutomaticEnabled = true;
  state.updateManualVisibleChannel = "";
  const messagesBeforeActions = messages.length;

  state.data.app_update = { state: "idle", include_preview: false, updated_at: 9 };
  await checkAppUpdate({});
  state.data.app_update = { state: "available", include_preview: false, updated_at: 10, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.1", auto_update_supported: true, release_url: "https://example.test/v0.8.1" };
  await checkAppUpdate({});
  await installAppUpdate(false);
  state.data.app_update = { state: "available", include_preview: false, updated_at: 11, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.2", auto_update_supported: false, release_url: "https://example.test/v0.8.2" };
  await checkAppUpdate({});
  state.updatePreviewEnabled = true;
  await checkAppUpdate({});

  process.stdout.write(JSON.stringify({ states, posts, confirms, opened, messages, messagesBeforeActions }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
result = (await this.run_node(script));
for (const name of iterableValues(["unknown", "checking", "current", "failed", "stalePreview"])) {
{
assert.ok(!hasContent(result["states"][name]["settings"]));
assert.ok(!hasContent(result["states"][name]["row"]));
assert.ok(!hasContent(result["states"][name]["badge"]));
}
}
for (const name of iterableValues(["installable", "viewOnly"])) {
{
assert.ok(hasContent(result["states"][name]["settings"]));
assert.ok(!hasContent(result["states"][name]["row"]));
assert.ok(hasContent(result["states"][name]["badge"]));
}
}
assert.deepEqual(result["states"]["installable"]["button"], "service.update:");
assert.deepEqual(result["states"]["installable"]["status"], "");
assert.deepEqual(result["states"]["viewOnly"]["button"], "service.viewVersion:v0.8.2");
assert.ok(!hasContent(result["states"]["automaticOff"]["settings"]));
assert.ok(!hasContent(result["states"]["automaticOff"]["badge"]));
assert.deepEqual(result["states"]["automaticOff"]["button"], "service.checkUpdate:");
assert.ok(hasContent(result["states"]["manualVisible"]["settings"]));
assert.ok(!hasContent(result["states"]["manualVisible"]["row"]));
assert.deepEqual(result["states"]["manualVisible"]["status"], "");
assert.deepEqual(result["messagesBeforeActions"], 0);
assert.deepEqual(Array.from(Array.from(iterableValues(result["posts"]))).map((post) => post["path"]), ["/api/app/update/check", "/api/app/update/install", "/api/app/update/check"]);
assert.deepEqual(result["confirms"].length, 1);
assert.deepEqual(result["confirms"][0]["type"], "install-app-update");
assert.deepEqual(result["opened"], ["https://example.test/v0.8.2"]);
}
};
test("AppUpdateFrontendTest.test_shared_update_actions_keep_platform_installers_separate", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_shared_update_actions_keep_platform_installers_separate(); });
test("AppUpdateFrontendTest.test_update_preferences_and_marker_live_in_settings_workspace", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_update_preferences_and_marker_live_in_settings_workspace(); });
test("AppUpdateFrontendTest.test_relaunch_failure_is_distinct_from_replacement_and_reported_once", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_relaunch_failure_is_distinct_from_replacement_and_reported_once(); });
test("AppUpdateFrontendTest.test_startup_and_manual_paths_use_check_only_without_installing", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_startup_and_manual_paths_use_check_only_without_installing(); });
test("AppUpdateFrontendTest.test_known_results_render_explicit_actions_and_current_channel_badges", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_known_results_render_explicit_actions_and_current_channel_badges(); });
test("AppUpdateFrontendTest.test_preference_defaults_and_startup_check_are_executable_and_bounded", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_preference_defaults_and_startup_check_are_executable_and_bounded(); });
test("AppUpdateFrontendTest.test_host_basic_full_preference_is_retired_without_a_hidden_toggle", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_host_basic_full_preference_is_retired_without_a_hidden_toggle(); });
test("AppUpdateFrontendTest.test_indicator_rendering_and_manual_actions_are_executable", async () => { const instance = Object.create(AppUpdateFrontendTest); await instance.setUpClass(); await instance.test_indicator_rendering_and_manual_actions_are_executable(); });
const NativeDesktopUpdateAdapterTest = {
async test_private_shell_operations_and_duplicate_activation() {
let node, result, script;
node = process.execPath;
if ((!node)) {
(() => { throw new Error("node is unavailable"); })();
}
script = `
const fs=require("node:fs"), vm=require("node:vm"), assert=require("node:assert/strict");
const calls=[];
const desktop={window:{__TAURI__:{core:{invoke:async(name,args)=>{calls.push([name,args]);return {state:"downloading"};}}}},document:{documentElement:{dataset:{hostPlatform:"desktop"}}}};
vm.runInNewContext(fs.readFileSync("static/desktop-platform.js","utf8"),desktop);
(async()=>{
 const adapter=desktop.window.BilikaraDesktopPlatform;
 await adapter.startUpdate(true);await adapter.cancelUpdate();
 await adapter.openExternal("https://github.com/VZRXS/bilikara/releases");
 await Promise.all([adapter.applyUpdate({state:"prepared",operation:7}),adapter.applyUpdate({state:"prepared",operation:7})]);
 await adapter.applyUpdate({state:"downloading",operation:8});
 assert.deepEqual(calls.map(v=>v[0]),["start_desktop_update","cancel_desktop_update","open_external_web_url","apply_desktop_update"]);
 assert.equal(calls[0][1].includePreview,true);assert.equal(calls[3][1].operation,7);
 assert.ok(!calls.some(v=>JSON.stringify(v).includes("command")));
 const android={window:{},document:{documentElement:{dataset:{hostPlatform:"android"}}}};
 vm.runInNewContext(fs.readFileSync("static/desktop-platform.js","utf8"),android);
 assert.equal(android.window.BilikaraDesktopPlatform,undefined);
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
result = (await runNative(node, ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
}
};
test("NativeDesktopUpdateAdapterTest.test_private_shell_operations_and_duplicate_activation", async () => { const instance = Object.create(NativeDesktopUpdateAdapterTest); await instance.test_private_shell_operations_and_duplicate_activation(); });
