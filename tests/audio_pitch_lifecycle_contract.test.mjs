import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { hasContent, sourceIndex, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const AudioPitchLifecycleTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.app_source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.pitch_source = (await this._slice("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences"));
this.snapshot_source = (await this._slice("function syncLocalPlayerSettingsFromSnapshot", "function markLocalVolumeWrite"));
this.teardown_source = concatenate(concatenate((await this._slice("function setHostPlaybackSessionPhase", "Object.defineProperty")), (await this._slice("function retireHostPlaybackSession", "function replaceHostPlayerView"))), (await this._slice("function teardownMountedPlayer", "function activeLocalPlayerElements")));
this.reset_source = (await this._slice("async function resetPlayerState", "async function installAppUpdate"));
},
async _slice(start, end) {
let start_index;
start_index = sourceIndex(this.app_source, start);
return this.app_source.slice(start_index, sourceIndex(this.app_source, end, start_index));
},
async run_node(script) {
let completed;
completed = (await runNative(this.node, ["-e", (`(async () => {
` + String(script) + `
})().catch((error) => { console.error(error); process.exit(1); });`)], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout.trim().trimEnd().split(/\r?\n/).at((-1)));
},
async test_adapter_and_host_pitch_lifecycle() {
let completed, result;
completed = (await runNative(this.node, [String(path.join(path.join(ROOT, "tests"), "audio_pitch_lifecycle.cjs"))], process.env, 20 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout.trim().trimEnd().split(/\r?\n/).at((-1)));
assert.deepEqual(result["live"], 0);
assert.deepEqual(result["cases"], 12);
},
async test_retired_element_graph_cleanup_preserves_current_graph_and_shared_context() {
let result;
result = (await this.run_node((`
const disconnected = [];
const disposed = [];
function graphAudio(name) {
  return {
    name,
    paused: false,
    bilikaraPitch: { dispose() { disposed.push(name); } },
    bilikaraPitchSource: { disconnect() { disconnected.push(name); } },
    bilikaraPitchRoute: "processor",
    pause() { this.paused = true; },
    removeAttribute() {},
    load() {},
  };
}
function media(name) {
  return {
    name,
    paused: false,
    pause() { this.paused = true; },
    removeAttribute() {},
    load() {},
  };
}
const audioA = graphAudio("A");
const audioB = graphAudio("B");
const sessionA = { phase: "playing", video: media("video-A"), audio: audioA, eventCleanups: [] };
const sessionB = { phase: "playing", video: media("video-B"), audio: audioB, eventCleanups: [] };
const sharedContext = { state: "running" };
const state = {
  hostPlaybackSession: sessionB,
  audioContext: sharedContext,
  localWebKitStartRetryDone: false,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localPlaybackStartState: "established",
  localPlaybackStartGeneration: 1,
  localPlaybackStartPromisesSettled: true,
  localPlaybackEndHandled: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
};
function clearLocalPlayerEventListeners() {}
function clearWebKitAudioStarvationTimer() {}
function clearLocalPlayerSyncTimer() {}
function clearPlayerFrameClickTimer() {}
function clearLocalPlayerSeekState() {}
function clearLocalPlayerControlsHideTimer() {}
function clearTauriMediaSessionState() {}
function clearLocalAdvanceDelay() {}
` + String(this.pitch_source) + `
` + String(this.teardown_source) + `
const retiredOld = retireHostPlaybackSession(sessionA);
const afterOld = {
  retiredOld,
  currentPreserved: state.hostPlaybackSession === sessionB,
  currentSourcePreserved: Boolean(audioB.bilikaraPitchSource),
  currentProcessorPreserved: Boolean(audioB.bilikaraPitch),
  contextPreserved: state.audioContext === sharedContext,
  disposed: [...disposed],
  disconnected: [...disconnected],
};
const retiredCurrent = retireHostPlaybackSession(sessionB);
console.log(JSON.stringify({
  afterOld,
  retiredCurrent,
  pointerCleared: state.hostPlaybackSession === null,
  contextPreserved: state.audioContext === sharedContext,
  disposed,
  disconnected,
}));
`)));
assert.deepEqual(result["afterOld"], {["retiredOld"]: true, ["currentPreserved"]: true, ["currentSourcePreserved"]: true, ["currentProcessorPreserved"]: true, ["contextPreserved"]: true, ["disposed"]: ["A"], ["disconnected"]: ["A"]});
assert.ok(hasContent(result["retiredCurrent"]));
assert.ok(hasContent(result["pointerCleared"]));
assert.ok(hasContent(result["contextPreserved"]));
assert.deepEqual(result["disposed"], ["A", "B"]);
assert.deepEqual(result["disconnected"], ["A", "B"]);
}
};
test("AudioPitchLifecycleTest.test_adapter_and_host_pitch_lifecycle", async () => { const instance = Object.create(AudioPitchLifecycleTest); await instance.setUpClass(); await instance.test_adapter_and_host_pitch_lifecycle(); });
test("AudioPitchLifecycleTest.test_retired_element_graph_cleanup_preserves_current_graph_and_shared_context", async () => { const instance = Object.create(AudioPitchLifecycleTest); await instance.setUpClass(); await instance.test_retired_element_graph_cleanup_preserves_current_graph_and_shared_context(); });
