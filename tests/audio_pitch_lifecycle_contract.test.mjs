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

test("pitch output recovery keeps the exact program claim until ordinary retirement", async () => {
  const instance = Object.create(AudioPitchLifecycleTest);
  await instance.setUpClass();
  const lifecycle = await instance._slice("function createHostPlaybackSession", "function replaceHostPlayerView");
  const recovery = await instance._slice("function recoverAudioPitchOutput", "function applyKeyShiftToAudio");
  const result = await instance.run_node(`
const state = {};
const releases = [], claims = [], disposed = [], renders = [];
const retiredPrograms = new Set();
function playbackProgramDescriptorsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function setHostPlaybackSessionPhase(session, phase) { session.phase = phase; }
function clearLocalPlayerEventListeners() {}
function clearWebKitAudioStarvationTimer() {}
function clearLocalPlayerSyncTimer() {}
function clearPlayerFrameClickTimer() {}
function clearLocalPlayerSeekState() {}
function clearLocalPlayerControlsHideTimer() {}
function clearTauriMediaSessionState() {}
function clearLocalAdvanceDelay() {}
function disposeAudioPitchShifter(media) { disposed.push(media.name); }
function renderPreparingHostPlaybackState() {}
function frontendPlaybackMode(mode) { return mode; }
function beginHostPlaybackSessionElementLoading(session) { session.loadingStarted = true; return true; }
function apiPost(path, identity) {
  if (path === '/api/player/retire-program') {
    releases.push(identity); retiredPrograms.add(identity.playback_generation);
    return Promise.resolve({ released: true });
  }
  if (path === '/api/player/claim-program') {
    claims.push(identity);
    return Promise.resolve({ claimed: !retiredPrograms.has(identity.playback_generation) });
  }
  throw Error(path);
}
function media(name) {
  return { name, currentTime: 13.75, paused: false, pause() { this.paused = true; },
    removeAttribute() {}, load() {} };
}
${lifecycle}
${recovery}
function install(generation, contextState, logicalPlayIntent) {
  const item = { id: 'song', item_incarnation_id: 'incarnation' };
  const program = { item_id: 'song', item_incarnation_id: 'incarnation',
    artifact_set_id: 'artifact', selected_audio_variant_id: 'off-vocal' };
  state.data = { current_item: item, playback_generation: generation,
    playback_program: program, playback_mode: 'local' };
  const session = createHostPlaybackSession(generation, program);
  Object.assign(session, { phase: 'playing', video: media('video-' + generation),
    audio: media('audio-' + generation), ownershipClaimStarted: true,
    ownershipClaimed: true, logicalPlayIntent });
  state.hostPlaybackSession = session;
  state.audioContext = { state: contextState };
  return session;
}
function renderPlayer(item, mode) {
  renders.push({ item: item.id, mode });
  const session = createHostPlaybackSession(state.data.playback_generation, state.data.playback_program);
  Object.assign(session, { phase: 'binding', video: media('replacement-video'), audio: media('replacement-audio') });
  state.hostPlaybackSession = session;
  beginHostPlaybackSessionOwnershipClaim(session);
}
const observations = [];
for (const [generation, kind, contextState, intent] of [[7, 'media-clock', 'running', true], [8, 'context-closed', 'closed', false]]) {
  const old = install(generation, contextState, intent), context = state.audioContext;
  recoverAudioPitchOutput(old.audio, kind);
  await new Promise(resolve => setImmediate(resolve));
  const replacement = state.hostPlaybackSession;
  observations.push({ kind, oldPhase: old.phase, oldMediaGone: old.video === null && old.audio === null,
    loading: replacement.loadingStarted, claimed: replacement.ownershipClaimed,
    claim: claims.at(-1), releasesBeforeRetirement: releases.length,
    restore: state.pendingPlaybackRestore, contextPreserved: state.audioContext === context,
    failure: state.pitchContextFailure });
  retireHostPlaybackSession(replacement);
}
const stale = install(9, 'running', true);
recoverAudioPitchOutput(stale.audio, 'media-clock');
state.data.playback_generation = 10;
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ observations, releases, disposed, renders,
  stale: { phase: stale.phase, current: state.hostPlaybackSession === stale } }));
`);
  const identity = generation => ({ playback_generation: generation, item_incarnation_id: 'incarnation', artifact_set_id: 'artifact' });
  assert.deepEqual(result.observations, [
    { kind: 'media-clock', oldPhase: 'retired', oldMediaGone: true, loading: true, claimed: true,
      claim: identity(7), releasesBeforeRetirement: 0, contextPreserved: true, failure: 'media-clock',
      restore: { itemId: 'song', itemIncarnationId: 'incarnation', variantId: 'off-vocal', currentTime: 13.75, wasPlaying: true } },
    { kind: 'context-closed', oldPhase: 'retired', oldMediaGone: true, loading: true, claimed: true,
      claim: identity(8), releasesBeforeRetirement: 1, contextPreserved: false, failure: 'context-closed',
      restore: { itemId: 'song', itemIncarnationId: 'incarnation', variantId: 'off-vocal', currentTime: 13.75, wasPlaying: false } },
  ]);
  assert.deepEqual(result.releases, [identity(7), identity(8)]);
  assert.deepEqual(result.disposed, ['video-7', 'audio-7', 'replacement-video', 'replacement-audio',
    'video-8', 'audio-8', 'replacement-video', 'replacement-audio']);
  assert.deepEqual(result.renders, [{ item: 'song', mode: 'local' }, { item: 'song', mode: 'local' }]);
  assert.deepEqual(result.stale, { phase: 'playing', current: true });
});
