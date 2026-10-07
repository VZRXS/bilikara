import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, iterableValues, markupSummary, splitLimited, subtract } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const ControllerFrontendTest = {
async setUpClass() {
let staticRoot;
staticRoot = path.join(ROOT, "static");
this.html = readFileSync(path.join(staticRoot, "controller.html"), "utf8");
this.css = readFileSync(path.join(staticRoot, "controller.css"), "utf8");
this.shared_css = readFileSync(path.join(staticRoot, "remote-access.css"), "utf8");
this.source = readFileSync(path.join(staticRoot, "controller.js"), "utf8");
},
async test_output_window_is_a_stage_not_a_second_control_console() {
let parser, rejected_id;
parser = markupSummary();
Object.assign(parser, markupSummary(this.html));
assert.ok(!hasContent(new Set(Array.from(new Set(["video", "audio", "iframe", "canvas"])).filter(value => contains(value, new Set((Symbol.iterator in Object(parser.tags) ? parser.tags : Object.keys(parser.tags))))))));
assert.deepEqual(parser.scripts, ["/presentation-scene.js", "/presentation-renderer.js", "/presentation-sync.js", "/android-presentation.js", "/incoming-request.js", "/presentation-feedback.js", "/fullscreen-controls.js", "/controller.js"]);
assert.ok(hasContent(Array.from(new Set(["controller-shell", "controller-stage-frame", "controller-empty", "controller-status", "controller-output-control", "controller-exit", "controller-remote-popover", "controller-remote-qr-image", "controller-remote-url-link", "controller-internet-remote-meta", "controller-internet-remote-connection-count", "controller-internet-remote-room", "controller-internet-remote-qr-image", "controller-internet-remote-qr-placeholder", "controller-internet-remote-password", "controller-error", "controller-unavailable"])).every(value => contains(value, parser.ids))));
assert.ok(contains("candidate?.qr_image", this.source));
assert.ok(contains("candidate?.password", this.source));
assert.ok(contains("__bilikaraQrImage", this.source));
for (const rejected_id of iterableValues(["controller-play-toggle", "controller-back-15", "controller-forward-15", "controller-next", "controller-volume"])) {
assert.ok(!contains(rejected_id, parser.ids));
}
},
async test_output_video_is_muted_clock_follower_and_never_host_authority() {
assert.ok(contains("candidate?.type !== \"master-state\"", this.source));
assert.ok(contains("document.createElement(\"video\")", this.source));
assert.ok(contains("video.muted = true", this.source));
assert.ok(contains("video.defaultMuted = true", this.source));
assert.ok(contains("sync.planClockCorrection", this.source));
assert.ok(contains("BroadcastChannel(sync.channelName)", this.source));
assert.ok(contains("localStorage.setItem(sync.storageKey", this.source));
assert.ok(!contains("document.createElement(\"audio\")", this.source));
assert.ok(!contains("document.createElement(\"iframe\")", this.source));
assert.ok(!contains("EventSource", this.source));
assert.ok(!contains("/api/player/", this.source));
assert.ok(!contains("invoke(\"send_presentation_command\"", this.source));
},
async test_output_grid_and_video_can_shrink_below_intrinsic_dimensions() {
let frame, video;
frame = splitOnce(splitLimited(this.css, ".presentation-output-frame {", 2).at((-1)), "}")[0];
video = splitOnce(splitOnce(this.css, "video[data-presentation-output-video] {")[1], "}")[0];
assert.ok(contains("grid-template-columns: minmax(0, 1fr)", frame));
assert.ok(contains("grid-template-rows: minmax(0, 1fr)", frame));
assert.ok(contains("min-width: 0", video));
assert.ok(contains("min-height: 0", video));
assert.ok(contains("object-fit: contain", video));
},
async test_output_geometry_is_desktop_only_event_driven_and_released() {
let body, value;
body = splitOnce(splitOnce(this.source, "function observeVideoGeometry(video)")[1], "function mountScene")[0];
assert.ok(contains("if (androidDisplay || typeof invoke !== \"function\") return", body));
for (const value of iterableValues(["video.videoWidth", "video.videoHeight", "getBoundingClientRect()", "window.innerWidth", "window.outerHeight", "window.devicePixelRatio"])) {
assert.ok(contains(value, body));
}
assert.ok(contains("if (key === state.geometryKey) return", body));
assert.ok(contains("invoke(\"record_presentation_video_geometry\", { generation, geometry }).catch", body));
assert.ok(!contains("video.src", body));
assert.ok(!contains("setInterval", body));
assert.ok(contains("observer?.disconnect()", body));
assert.ok(contains("state.stopGeometryObservation?.()", this.source));
},
async test_output_state_arrives_through_the_shell_after_ready() {
let body, request, start;
start = sourceIndex(this.source, "async function start()");
body = this.source.slice(start, sourceIndex(this.source, "elements.exit.addEventListener(\"pointerdown\"", start));
assert.ok(contains("listen(\"bilikara-presentation-output-state\"", body));
assert.ok(contains("handleMasterMessage(event?.payload)", body));
assert.ok(sourceIndex(body, "listen(\"bilikara-presentation-output-state\"") < sourceIndex(body, "invoke(\"get_presentation_session\")"));
assert.ok(sourceIndex(body, "postEnvelope(\"output-ready\"") < sourceIndex(body, "requestOutputStateUntilReceived();"));
request = this.source.slice(sourceIndex(this.source, "function requestOutputState()"), sourceIndex(this.source, "function postEnvelope("));
assert.ok(contains("invoke(\"request_presentation_output_state\", { generation })", request));
assert.ok(contains("[\"activating\", \"active\"].includes(state.session?.phase)", request));
assert.ok(contains("state.lastMasterEnvelope || state.failedClosed || attempts > 10", request));
assert.ok(contains("window.clearInterval(state.outputRequestTimer)", this.source));
},
async test_output_only_marks_ready_and_can_exit_fullscreen_mode() {
assert.ok(contains("invoke(\"get_presentation_session\")", this.source));
assert.ok(contains("invoke(\"mark_presentation_controller_ready\"", this.source));
assert.ok(contains("invoke(\"deactivate_local_presentation\", { generation })", this.source));
assert.ok(contains("data-i18n-aria-label=\"player.fullscreenRemoteExit\"", this.html));
assert.ok(contains("presentation-output-phone-icon", this.html));
assert.ok(contains("presentation-output-exit-icon", this.html));
assert.ok(contains("M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5", this.html));
assert.ok(contains("activationUsesTouch(event)", this.source));
assert.ok(contains("setRemoteQrPinned(true)", this.source));
assert.ok(contains("candidate.payload?.remoteAccess", this.source));
assert.ok(contains("candidate.payload?.internetRemote", this.source));
assert.ok(contains("function renderInternetRemote", this.source));
assert.ok(contains("applyLanguage(candidate.payload?.language)", this.source));
assert.ok(contains("fetch(\"/api/app/open-url\"", this.source));
assert.ok(contains("position: fixed", this.css));
assert.ok(contains("top: 16px", this.css));
assert.ok(contains("right: 16px", this.css));
assert.ok(!contains("presentation-controller-controls", this.css));
},
async test_output_remote_control_uses_theme_tokens_and_hover_exit_label() {
let local_details;
assert.ok(contains("data-i18n=\"player.fullscreenExit\"", this.html));
assert.ok(contains("color: var(--ink)", this.css));
assert.ok(contains("background: var(--settings-panel-bg)", this.css));
assert.ok(contains("background: color-mix(in srgb, var(--settings-panel-bg)", this.css));
assert.ok(contains(".presentation-output-exit-label", this.css));
assert.ok(contains("cubic-bezier(0.16, 1, 0.3, 1)", this.css));
assert.ok(contains("href=\"/remote-access.css\"", this.html));
assert.ok(contains("width: min(390px, calc(100vw - 32px))", this.shared_css));
assert.ok(contains(".remote-access-card", this.shared_css));
assert.ok(contains("grid-template-columns: repeat(2, minmax(0, 1fr))", this.shared_css));
assert.ok(contains("font-size: 12px", this.shared_css));
assert.ok(!contains("remote-access-public-state-icon", this.html));
assert.ok(contains("class=\"remote-access-public-connection-indicator\"", this.html));
assert.ok(contains("candidate?.connected_count", this.source));
local_details = this.html.slice(subtract(sourceIndex(this.html, "id=\"controller-remote-url-link\""), 200), sourceIndex(this.html, "id=\"controller-internet-remote-meta\""));
assert.ok(sourceIndex(local_details, "id=\"controller-remote-url-link\"") < sourceIndex(local_details, "id=\"controller-remote-url-hint\""));
assert.ok(!contains("presentation-remote-meta-font-size", this.css));
},
async test_output_remote_copy_uses_the_shared_local_and_public_wording() {
assert.ok(contains("class=\"remote-access-copy-title\" data-i18n=\"internetRemote.localScanTitle\"", this.html));
assert.ok(contains("id=\"controller-remote-url-hint\" data-i18n=\"internetRemote.localSameNetwork\"", this.html));
assert.ok(contains("data-i18n=\"internetRemote.publicScanTitle\"", this.html));
assert.ok(contains("elements.remoteUrlHint.textContent = t(\"internetRemote.localSameNetwork\")", this.source));
},
async test_output_fails_closed_without_tauri_or_sync_contract() {
assert.ok(contains("typeof invoke !== \"function\"", this.source));
assert.ok(contains("typeof listen !== \"function\"", this.source));
assert.ok(contains("!sceneApi", this.source));
assert.ok(contains("!renderer", this.source));
assert.ok(contains("!sync", this.source));
assert.ok(contains("failClosed(t(\"controller.tauriRequired\"), \"controller.tauriRequired\")", this.source));
assert.ok(contains("elements.exit.disabled = true", this.source));
assert.ok(contains("elements.unavailable.classList.remove(\"hidden\")", this.source));
}
};
test("ControllerFrontendTest.test_output_window_is_a_stage_not_a_second_control_console", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_window_is_a_stage_not_a_second_control_console(); });
test("ControllerFrontendTest.test_output_video_is_muted_clock_follower_and_never_host_authority", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_video_is_muted_clock_follower_and_never_host_authority(); });
test("ControllerFrontendTest.test_output_grid_and_video_can_shrink_below_intrinsic_dimensions", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_grid_and_video_can_shrink_below_intrinsic_dimensions(); });
test("ControllerFrontendTest.test_output_geometry_is_desktop_only_event_driven_and_released", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_geometry_is_desktop_only_event_driven_and_released(); });
test("ControllerFrontendTest.test_output_state_arrives_through_the_shell_after_ready", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_state_arrives_through_the_shell_after_ready(); });
test("ControllerFrontendTest.test_output_only_marks_ready_and_can_exit_fullscreen_mode", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_only_marks_ready_and_can_exit_fullscreen_mode(); });
test("ControllerFrontendTest.test_output_remote_control_uses_theme_tokens_and_hover_exit_label", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_remote_control_uses_theme_tokens_and_hover_exit_label(); });
test("ControllerFrontendTest.test_output_remote_copy_uses_the_shared_local_and_public_wording", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_remote_copy_uses_the_shared_local_and_public_wording(); });
test("ControllerFrontendTest.test_output_fails_closed_without_tauri_or_sync_contract", async () => { const instance = Object.create(ControllerFrontendTest); await instance.setUpClass(); await instance.test_output_fails_closed_without_tauri_or_sync_contract(); });
