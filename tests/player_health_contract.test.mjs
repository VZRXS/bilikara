import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, sourceIndex, iterableValues, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const PlayerDiagnosticsOnlyTest = {
async setUpClass() {
this.repo_root = path.resolve(path.resolve(__file__), "..", "..");
this.app_source = readFileSync(path.join(path.join(this.repo_root, "static"), "app.js"), "utf8");
this.index_source = readFileSync(path.join(path.join(this.repo_root, "static"), "index.html"), "utf8");
},
async function_source(start_marker, end_marker) {
let end, start;
start = sourceIndex(this.app_source, start_marker);
end = sourceIndex(this.app_source, end_marker, start);
return this.app_source.slice(start, end);
},
async test_player_health_control_module_is_removed() {
let obsolete_name;
assert.ok(!hasContent(existsSync(path.join(path.join(this.repo_root, "static"), "player-health.js"))));
assert.ok(!contains("/player-health.js", this.index_source));
for (const obsolete_name of iterableValues(["splitPlaybackMetrics", "pauseSplitPlaybackForFault", "handleSplitPlaybackFault", "recordSplitMediaIssue", "attachSplitPlaybackFaultHandlers", "playbackFaultItemId", "playbackFaultRetryByItem", "mediaIssueEventsByKey", "BilikaraPlayerHealth"])) {
assert.ok(!contains(obsolete_name, this.app_source));
}
},
async test_all_media_health_events_are_attached_to_diagnostics() {
let diagnostics;
diagnostics = (await this.function_source("function attachSplitPlayerDiagnostics", "async function handleSplitVideoEnded"));
assert.ok(contains("[\"loadedmetadata\", \"canplay\", \"waiting\", \"stalled\", \"suspend\", \"error\", \"ended\"]", diagnostics));
assert.ok(contains("reportMediaDiagnostic(itemId, \"video\"", diagnostics));
assert.ok(contains("reportMediaDiagnostic(itemId, \"audio\"", diagnostics));
},
async test_media_diagnostics_are_best_effort_and_report_useful_fields() {
let diagnostics, field;
diagnostics = (await this.function_source("function splitVideoFrameStats", "function attachSplitPlayerDiagnostics"));
for (const field of iterableValues(["item_id", "media_kind", "event", "current_time", "duration", "ready_state", "network_state", "paused", "ended", "seeking", "playback_rate", "buffered_end", "audio_current_time", "video_current_time", "target_video_time", "drift_seconds", "effective_av_delay_seconds", "synchronization_action", "dropped_video_frames", "total_video_frames", "error_code", "error_message", "play_rejection_name", "url_basename", "playback_start_state", "local_should_be_playing", "local_audio_playback_blocked", "local_video_playback_blocked", "is_webkit_runtime", "is_tauri_runtime", "is_tauri_webkit_runtime"])) {
assert.ok(contains(field, diagnostics));
}
assert.ok(contains("apiPost(\"/api/player/diagnostic\", payload).catch(() => {})", diagnostics));
},
async test_startup_decision_diagnostics_bypass_sync_throttle() {
let direct_reporter, event_name, initial_intent, startup, synchronizer;
direct_reporter = (await this.function_source("function reportSplitStartupDiagnostic", "function reportSplitSyncDiagnostic"));
startup = (await this.function_source("function requireSplitPlaybackUserGesture", "function createSplitPlaybackStartOverlay"));
synchronizer = (await this.function_source("function createSplitPlayerStartupSynchronizer", "function renderPlayer"));
initial_intent = (await this.function_source("function applyInitialHostPlaybackIntent", "function commitHostPlaybackSessionReadyPaused"));
assert.ok(contains("reportMediaDiagnostic(itemId, \"split\"", direct_reporter));
for (const event_name of iterableValues(["autoplay-attempt", "user-start-attempt", "autoplay-success", "user-start-success"])) {
assert.ok(contains(event_name, startup));
}
assert.ok(contains("startup-ready-no-play-intent", initial_intent));
assert.ok(!contains("localPlayerSyncDiagnosticThrottleMs", direct_reporter));
},
async test_health_events_have_no_control_side_effects() {
let diagnostics, event_name, forbidden;
diagnostics = (await this.function_source("function reportMediaDiagnostic", "async function handleSplitVideoEnded"));
for (const forbidden of iterableValues(["/api/cache/retry", "playerSignature", "render()", ".pause()", "setAppMessage("])) {
assert.ok(!contains(forbidden, diagnostics));
}
for (const event_name of iterableValues(["waiting", "stalled", "suspend", "error"])) {
assert.ok(!contains(("addEventListener(\"" + String(event_name) + "\""), this.app_source));
}
},
async test_audio_ended_is_the_authoritative_completion_event() {
let ended_guard, sync_source;
sync_source = (await this.function_source("function syncSplitPlayer", "function syncMountedLocalPlayer"));
assert.ok(contains("if (audio.ended) {", sync_source));
ended_guard = sync_source.slice(sourceIndex(sync_source, "if (audio.ended)"), undefined);
ended_guard = ended_guard.slice(0, sourceIndex(ended_guard, "}"));
assert.ok(!contains("audio.play(", ended_guard));
assert.ok(!contains("audio.pause(", ended_guard));
assert.ok(contains("addMountedPlayerListener(audio, \"ended\"", this.app_source));
},
async test_video_ended_defers_to_audio_and_audio_completion_advances_once() {
let handler;
handler = (await this.function_source("async function handleSplitVideoEnded", "function holdVideoForAudio"));
assert.ok(contains("if (!audio.ended)", handler));
assert.ok(contains("\"defer-video-recovery\"", handler));
assert.ok(contains("state.localPlaybackEndHandled", handler));
assert.deepEqual(countOccurrences(handler, "handleLocalPlaybackEnded(\"media-ended\", endingSession)"), 1);
assert.ok(contains("const endingSession = state.hostPlaybackSession;", handler));
assert.ok(sourceIndex(handler, "const endingSession = state.hostPlaybackSession;") < sourceIndex(handler, "await audio.bilikaraPitch.drain()"));
assert.ok(!contains("audio.pause()", handler));
assert.ok(!contains("cache/retry", handler));
assert.ok(!contains("render()", handler));
},
async test_media_events_cannot_retry_cache() {
let diagnostic_start, player_end, player_source, player_start;
diagnostic_start = sourceIndex(this.app_source, "function reportMediaDiagnostic");
player_start = sourceIndex(this.app_source, "function renderPlayer", diagnostic_start);
player_end = sourceIndex(this.app_source, "function applyRemotePlayerControl", player_start);
player_source = this.app_source.slice(diagnostic_start, player_end);
assert.ok(!contains("/api/cache/retry", player_source));
},
async test_manual_current_cache_retry_remains_forced() {
assert.ok(contains(`"retry-cache": [
      "/api/cache/retry",`, this.app_source));
assert.ok(contains("expected_item_incarnation_id: button.dataset.itemIncarnationId", this.app_source));
assert.ok(contains(`expected_item_incarnation_id: currentItem.item_incarnation_id,
      force: true,`, this.app_source));
assert.ok(contains("button.dataset.itemIncarnationId = item.item_incarnation_id", this.app_source));
},
async test_offset_changes_resync_audio_only_when_effective_value_changes() {
let offset_handler, resync_handler, snapshot_handler;
offset_handler = (await this.function_source("async function setAvOffset", "function updateCacheSliderFill"));
snapshot_handler = (await this.function_source("async function fetchState", "function renderSignatureForData"));
assert.ok(contains("resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs)", offset_handler));
assert.ok(contains("resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs)", snapshot_handler));
resync_handler = (await this.function_source("function resyncMountedLocalPlayerForOffsetChange", "function applyStoredVolumeToSinglePlayer"));
assert.ok(contains("Number(video.currentTime || 0) - currentAvOffsetSeconds()", resync_handler));
assert.ok(contains("setMediaCurrentTime(audio, targetAudioTime)", resync_handler));
assert.ok(contains("\"av-delay-audio-resync\"", resync_handler));
assert.ok(contains("if (Number(previousOffsetMs) === currentAvOffsetMs())", resync_handler));
assert.deepEqual(countOccurrences(resync_handler, "resyncMountedLocalPlayerForOffsetChange();"), 1);
assert.ok(!contains("beginSplitPlayerSeek", resync_handler));
assert.ok(!contains("seekVideoForNavigation", resync_handler));
assert.ok(!contains("setMediaCurrentTime(video", resync_handler));
}
};
test("PlayerDiagnosticsOnlyTest.test_player_health_control_module_is_removed", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_player_health_control_module_is_removed(); });
test("PlayerDiagnosticsOnlyTest.test_all_media_health_events_are_attached_to_diagnostics", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_all_media_health_events_are_attached_to_diagnostics(); });
test("PlayerDiagnosticsOnlyTest.test_media_diagnostics_are_best_effort_and_report_useful_fields", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_media_diagnostics_are_best_effort_and_report_useful_fields(); });
test("PlayerDiagnosticsOnlyTest.test_startup_decision_diagnostics_bypass_sync_throttle", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_startup_decision_diagnostics_bypass_sync_throttle(); });
test("PlayerDiagnosticsOnlyTest.test_health_events_have_no_control_side_effects", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_health_events_have_no_control_side_effects(); });
test("PlayerDiagnosticsOnlyTest.test_audio_ended_is_the_authoritative_completion_event", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_audio_ended_is_the_authoritative_completion_event(); });
test("PlayerDiagnosticsOnlyTest.test_video_ended_defers_to_audio_and_audio_completion_advances_once", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_video_ended_defers_to_audio_and_audio_completion_advances_once(); });
test("PlayerDiagnosticsOnlyTest.test_media_events_cannot_retry_cache", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_media_events_cannot_retry_cache(); });
test("PlayerDiagnosticsOnlyTest.test_manual_current_cache_retry_remains_forced", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_manual_current_cache_retry_remains_forced(); });
test("PlayerDiagnosticsOnlyTest.test_offset_changes_resync_audio_only_when_effective_value_changes", async () => { const instance = Object.create(PlayerDiagnosticsOnlyTest); await instance.setUpClass(); await instance.test_offset_changes_resync_audio_only_when_effective_value_changes(); });
