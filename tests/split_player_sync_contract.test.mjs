import { readSourceText as readFileSync, runNodeScript } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const SplitPlayerSyncTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.remote_source = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.sync_source = (await this._slice("function holdVideoForAudio", "function syncMountedLocalPlayer"));
this.observed_playback_source = (await this._slice("function hostPlaybackSessionObservedPlaying", "function presentationPlaybackStateModel"));
this.seek_source = (await this._slice("function syncSplitSeekAudioTarget", "function scheduleSplitPlayerSeekSettle"));
this.seek_lifecycle_source = (await this._slice("function syncSplitSeekAudioTarget", "function mediaUrlBasename"));
this.clear_seek_source = (await this._slice("function takeLocalPlayerSeekCompletion", "function playerDelayOverlay"));
this.offset_resync_source = (await this._slice("function syncMountedLocalPlayer", "function applyStoredVolumeToSinglePlayer"));
this.ended_source = (await this._slice("async function handleSplitVideoEnded", "function holdVideoForAudio"));
this.lifecycle_source = (await this._slice("function clearLocalPlayerSyncTimer", "function clearLocalPlayerSeekState"));
this.startup_source = (await this._slice("function createSplitPlayerStartupSynchronizer", "function renderPlayer"));
this.key_shift_action_source = (await this._slice("async function setLocalPlayerKeyShift", "function disposeAudioPitchProcessor"));
this.pitch_apply_source = (await this._slice("function applyKeyShiftToAudio", "function persistLocalVolumePreferences"));
this.video_seek_event_source = (await this._slice("  addMountedPlayerListener(video, \"seeking\",", "  addMountedPlayerListener(video, \"canplay\","));
this.video_recovery_event_source = (await this._slice("  addMountedPlayerListener(video, \"canplay\",", "  addMountedPlayerListener(video, \"timeupdate\","));
this.video_play_event_source = (await this._slice("  addMountedPlayerListener(video, \"play\",", "  addMountedPlayerListener(video, \"pause\","));
this.video_play_pause_event_source = (await this._slice("  addMountedPlayerListener(video, \"play\",", "  addMountedPlayerListener(video, \"seeking\","));
this.player_frame_click_listener_source = (await this._slice("elements.playerFrame?.addEventListener(\"click\",", "elements.playerFrame?.addEventListener(\"dblclick\","));
this.session_foundation_source = (await this._slice("function hostPlaybackMountData", "function renderPlayer"));
this.renderer_source = (await this._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl"));
this.renderer_tail_source = (await this._slice("  addMountedPlayerListener(audio, \"waiting\",", "function applyRemotePlayerControl"));
this.watchdog_schedule_source = (await this._slice("function scheduleSplitPlaybackStartupWatchdog", "function setSplitPlaybackStartState"));
this.pause_event_source = (await this._slice("  addMountedPlayerListener(video, \"pause\",", "  addMountedPlayerListener(video, \"seeking\","));
this.frame_click_source = (await this._slice("function clearPlayerFrameClickTimer", "function readLocalNumber"));
this.diagnostic_source = (await this._slice("function mediaUrlBasename", "async function handleSplitVideoEnded"));
this.program_equality_source = (await this._slice("function playbackProgramDescriptorsEqual", "function isValidHostMediaLocator"));
this.webkit_helpers_source = (await this._slice("function isWebKitPlaybackRuntime", "function canTogglePlayerFullscreen"));
this.webkit_timer_source = (await this._slice("function clearWebKitAudioStarvationTimer", "function isPlayerPanelFullscreen"));
this.feedback_source = (await this._slice("function showPresentationOperationFeedback", "function requesterBadgeText"));
this.feedback_time_source = (await this._slice("function formatDurationSeconds", "function escapeRegExpText"));
},
async _slice(start, end) {
let end_index, start_index;
start_index = sourceIndex(this.source, start);
end_index = sourceIndex(this.source, end, start_index);
if (((end_index <= start_index))) {
throw new Error(("Empty source slice: " + JSON.stringify(start) + " to " + JSON.stringify(end)));
}
return this.source.slice(start_index, end_index);
},
async run_node(body, ...sources) {
let script;
script = (`
const state = {
  data: { playback_generation: 1 },
  localPlayerRequestedRate: 1,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localPlaybackStartGeneration: 0,
  localPlaybackStartPromisesSettled: false,
  localWebKitStartRetryDone: false,
  localShouldBePlaying: true,
  localPlaybackEndHandled: false,
  localPlayerControlsHideTimer: null,
  localPlayerControlsHideGeneration: 0,
  localPlayerEventCleanups: [],
  hostPlaybackSession: {
    playbackGeneration: 1,
    phase: "playing",
    readyCommitted: true,
    readyCommitCount: 1,
    loadingStarted: true,
    ownershipClaimed: true,
    logicalPlayIntent: true,
    initialIntentApplied: true,
    eventCleanups: [],
    syncTimer: null,
    startupTimer: null,
    startupWatchdogTimer: null,
    webkitRetryTimer: null,
    seekSettling: false,
    seekResumeAfterSettle: false,
    seekSettleStartedAt: 0,
    seekSettleTimer: null,
    seekSettleCallback: null,
    seekResumePending: false,
  },
  tauriMediaSessionOwner: null,
  lastTauriMediaSessionPositionAt: 0,
};
function legacyStartState() {
  const phase = state.hostPlaybackSession?.phase;
  if (phase === "starting") return "starting";
  if (phase === "playing" || phase === "paused") return "established";
  if (phase === "needs-user-gesture") return "needs-user-gesture";
  if (phase === "failed") return "startup-failed";
  if (["requested", "binding", "ready-paused", "start-retry-wait"].includes(phase)) return "pending";
  return "idle";
}
function setHostPlaybackSessionPhase(session, phase) {
  if (!session) return false;
  session.phase = phase;
  return true;
}
Object.defineProperty(state, "localPlaybackStartState", {
  get() { return legacyStartState(); },
  set(nextState) {
    const normalized = String(nextState || "");
    const phase = {
      pending: state.hostPlaybackSession?.readyCommitted ? "ready-paused" : "binding",
      starting: "starting",
      established: "playing",
      "needs-user-gesture": "needs-user-gesture",
      "startup-failed": "failed",
    }[normalized];
    if (phase) setHostPlaybackSessionPhase(state.hostPlaybackSession, phase);
  },
});
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerSyncSeekCooldownMs = 750;
const localPlayerSyncDiagnosticThrottleMs = 2000;
const localPlayerSeekSettlePollMs = 50;
const localPlayerSeekSettleMaxMs = 1400;
const splitPlaybackStartupWatchdogMs = 3000;
const tauriMediaSessionPositionUpdateMs = 1000;
const playerStatusMaxSeconds = 7 * 24 * 60 * 60;
const mediaPlayPromisesInFlight = new WeakSet();
let nowMs = 1000;
Date.now = () => nowMs;
const actions = [];
const playRejections = [];
const startupDiagnostics = [];
const diagnosticPosts = [];
console.info = () => {};
let heldItemId = "";
let mountedVideo = null;
let mountedAudio = null;
let mountedOverlay = null;
global.window = global;
const elements = {
  playerFrame: {
    querySelector(selector) {
      return selector === ".split-playback-start-overlay" ? mountedOverlay : null;
    },
    appendChild() {},
  },
};
function t(key) { return key; }
function activeLocalPlayerElements() { return { video: mountedVideo, audio: mountedAudio }; }
function isCurrentHostPlaybackSession(session, video, audio) {
  return Boolean(
    session
    && session === state.hostPlaybackSession
    && session.playbackGeneration === state.data?.playback_generation
    && (video === undefined || video === mountedVideo)
    && (audio === undefined || audio === mountedAudio)
  );
}
function clearSplitPlaybackStartupWatchdog() {
  const session = state.hostPlaybackSession;
  if (!session?.startupWatchdogTimer) return;
  window.clearTimeout(session.startupWatchdogTimer);
  session.startupWatchdogTimer = null;
}
function clearLocalPlayerSeekState() {}
function clearLocalPlayerSyncTimer(session = state.hostPlaybackSession) {
  clearSplitPlaybackStartupWatchdog(session);
}
function syncSplitPlayerVolumeFromVideo() {}
function isSplitPlayerSeekSettling(video, audio) {
  return state.hostPlaybackSession?.seekSettling && isActiveSplitPlayer(video, audio);
}
function shouldHoldCurrentItemForTransition(item) {
  const itemId = String(item?.id || item || "");
  return Boolean(itemId && itemId === heldItemId);
}
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function reportSplitSyncDiagnostic(itemId, video, audio, action) { actions.push(action); }
function reportSplitStartupDiagnostic(itemId, video, audio, eventName) {
  startupDiagnostics.push({
    eventName,
    playbackStartState: state.localPlaybackStartState,
    localShouldBePlaying: state.localShouldBePlaying,
  });
}
function reportMediaDiagnostic(itemId, mediaKind, media, eventName, video, audio, action, error) {
  playRejections.push({
    mediaKind,
    eventName,
    errorName: String(error?.name || ""),
    errorMessage: String(error?.message || ""),
  });
}
function apiPost(url, payload) { diagnosticPosts.push({ url, payload }); return Promise.resolve(); }
function clampMediaTime(media, value) {
  const lower = Math.max(0, Number(value || 0));
  return Number.isFinite(media.duration) ? Math.min(lower, media.duration) : lower;
}
function setMediaCurrentTime(media, value, tolerance = localPlayerForceSyncEpsilonSeconds) {
  const target = clampMediaTime(media, value);
  if (Math.abs(media.currentTime - target) <= tolerance) return false;
  media.currentTime = target;
  return true;
}
let effectiveOffsetSeconds = 0.2;
function currentAvOffsetSeconds() { return effectiveOffsetSeconds; }
function currentAvOffsetMs() { return effectiveOffsetSeconds * 1000; }
function isActiveSplitPlayer() { return true; }
function revealMountedPlayerControlsForUserInteraction() {}
function resumeAudioContextBestEffort() {}
function reportPlayerStatus() {}
function publishPresentationPlaybackState() { return Promise.resolve(null); }
let advances = 0;
async function handleLocalPlaybackEnded() { advances += 1; }
let nextTrackRequests = 0;
async function requestNextTrack() { nextTrackRequests += 1; }
class FakeMedia {
  constructor(time = 0) {
    this._time = time;
    this.duration = 100;
    this.readyState = 4;
    this.networkState = 1;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.playbackRate = 1;
    this.volume = 1;
    this.muted = false;
    this.dataset = { playerItemId: "item" };
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.seekWrites = 0;
    this.listeners = new Map();
  }
  get currentTime() { return this._time; }
  set currentTime(value) { this._time = Number(value); this.seekWrites += 1; }
  addEventListener(eventName, listener) {
    const listeners = this.listeners.get(eventName) || [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }
  dispatchMediaEvent(eventName, properties = {}) {
    const event = { type: eventName, target: this, pointerType: "mouse", ...properties };
    for (const listener of this.listeners.get(eventName) || []) listener(event);
  }
  play() { this.paused = false; this.playCalls += 1; return Promise.resolve(); }
  pause() { this.paused = true; this.pauseCalls += 1; }
}
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
}
` + String(this.webkit_helpers_source) + `
` + String(this.observed_playback_source) + `
` + this.feedback_source + this.feedback_time_source + String(sources.join("")) + `
(async () => {
` + String(body) + `
})().catch((error) => { console.error(error); process.exit(1); });
`);
return (await this.run_node_script(script));
},
async run_node_script(script) {
let completed;
completed = (await runNodeScript(script, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_video_starvation_pauses_audio_without_seeking_video() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; video.readyState = 1;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, audioPauseCalls: audio.pauseCalls, audioPaused: audio.paused,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["action"], "wait-for-video");
assert.deepEqual(result["audioPauseCalls"], 1);
assert.ok(hasContent(result["audioPaused"]));
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
},
async test_video_recovery_realigns_audio_to_video_clock() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(7); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
state.localVideoPlaybackBlocked = true;
const waitingAction = syncSplitPlayer(video, audio, 0.25, false);
state.localVideoPlaybackBlocked = false; nowMs += 1000;
const recoveryAction = syncSplitPlayer(video, audio, 0.25, true);
console.log(JSON.stringify({ waitingAction, recoveryAction, audioTime: audio.currentTime,
  videoTime: video.currentTime, audioPauseCalls: audio.pauseCalls,
  audioSeekWrites: audio.seekWrites, videoSeekWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["waitingAction"], "wait-for-video");
assert.deepEqual(result["recoveryAction"], "audio-drift-correction");
assert.ok(Number(Math.abs(result["audioTime"] - 6.75).toFixed(7)) === 0);
assert.deepEqual(result["videoTime"], 7);
assert.deepEqual(result["audioPauseCalls"], 1);
assert.deepEqual(result["audioSeekWrites"], 1);
assert.deepEqual(result["videoSeekWrites"], 0);
},
async test_normal_sync_source_cannot_seek_video() {
let sync_function;
sync_function = (await this._slice("function syncSplitPlayer(video, audio, offsetSeconds", "function syncMountedLocalPlayer"));
assert.ok(contains("setMediaCurrentTime(audio, targetAudioTime)", sync_function));
assert.ok(!contains("seekVideoForNavigation", sync_function));
assert.ok(!contains("setMediaCurrentTime(video", sync_function));
},
async test_all_programmatic_video_writes_are_navigation_or_restore_paths() {
let presentation_controls, remote_controls, restore_call;
assert.deepEqual(countOccurrences(this.source, "seekVideoForNavigation(video,"), 2);
assert.deepEqual(countOccurrences(this.source, "setMediaCurrentTime(video,"), 3);
restore_call = (await this._slice("const maybeRestorePlayback = () =>", "const synchronizeStartupPlayer"));
remote_controls = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
assert.ok(contains("diagnosticAction: \"restore-video-seek\"", restore_call));
assert.ok(contains("action === \"seek-relative\" || action === \"seek-absolute\"", remote_controls));
assert.ok(contains("diagnosticAction: \"manual-video-seek\"", remote_controls));
assert.ok(contains("setMediaCurrentTime(video, clampedNextTime)", remote_controls));
presentation_controls = (await this._slice("async function handlePresentationHostControl", "function queuePlayerFrameSingleClick"));
assert.ok(contains("action === \"seek\"", presentation_controls));
assert.ok(contains("diagnosticAction: \"presentation-host-seek\"", presentation_controls));
assert.ok(contains("setMediaCurrentTime(video, targetTime)", presentation_controls));
},
async test_normal_drift_correction_seeks_audio_only() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(20);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0.2, false);
console.log(JSON.stringify({ action, videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["action"], "audio-drift-correction");
assert.deepEqual(result["videoTime"], 30);
assert.ok(Number(Math.abs(result["audioTime"] - 29.8).toFixed(7)) === 0);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 1);
},
async test_android_recovery_events_do_not_seek_one_audio_packet_ahead() {
let events, result;
events = concatenate(concatenate(`
function registerRecovery(video, audio) {
  const session = state.hostPlaybackSession;
  const synchronizeStartupPlayer = () => false;
`, this.video_recovery_event_source), `
}`);
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Linux; Android 16; wv) Chrome/133" }, configurable: true,
});
global.document = { documentElement: { dataset: { nativeHost: "true" } } };
const video = new FakeMedia(8.661754), audio = new FakeMedia(8.683087);
mountedVideo = video; mountedAudio = audio; effectiveOffsetSeconds = 0;
video.paused = false; audio.paused = false;
registerRecovery(video, audio);
// Replay repeated starvation/recovery events, not just a single sync call.
// Each recovery sees audio one 48-kHz AAC packet ahead (21.333 ms).
for (let i = 0; i < 32; i++) {
  nowMs += 70;
  video.readyState = 1; video.dispatchMediaEvent("waiting");
  video._time += 0.07; audio._time = video._time + 0.021333;
  video.readyState = 4; video.dispatchMediaEvent("canplay");
  audio.dispatchMediaEvent("canplay");
  await Promise.resolve();
}
console.log(JSON.stringify({ seeks: audio.seekWrites, audioPaused: audio.paused,
  videoPaused: video.paused, videoTime: video.currentTime, actions }));
`, this.sync_source, events));
assert.deepEqual(result["seeks"], 0, result);
assert.ok(!hasContent(result["audioPaused"]));
assert.ok(!hasContent(result["videoPaused"]));
assert.ok(result["videoTime"] > 10);
},
async test_android_forced_audio_ahead_correction_respects_cooldown() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Linux; Android 16; wv) Chrome/133" }, configurable: true,
});
global.document = { documentElement: { dataset: { nativeHost: "true" } } };
const video = new FakeMedia(10), audio = new FakeMedia(10.6);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
const first = syncSplitPlayer(video, audio, 0, true);
audio._time = 10.6; nowMs += 50;
const second = syncSplitPlayer(video, audio, 0, true);
const seeksDuringCooldown = audio.seekWrites;
nowMs += 750;
const third = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ first, second, third, seeksDuringCooldown, seeks: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["first"], "audio-drift-correction");
assert.deepEqual(result["second"], "none");
assert.deepEqual(result["seeksDuringCooldown"], 1);
assert.deepEqual(result["third"], "audio-drift-correction");
assert.deepEqual(result["seeks"], 2);
},
async test_audio_correction_diagnostic_preserves_pre_seek_drift() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10), audio = new FakeMedia(10.6);
mountedVideo = video; mountedAudio = audio; effectiveOffsetSeconds = 0;
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, true);
const payload = diagnosticPosts.at(-1).payload;
console.log(JSON.stringify(payload));
`, this.sync_source, this.diagnostic_source));
assert.deepEqual(result["event"], "sync-audio-drift-correction");
assert.ok(Number(Math.abs(result["drift_before_correction_seconds"] - (-0.6)).toFixed(7)) === 0);
assert.deepEqual(result["correction_target_audio_time"], 10);
assert.ok(hasContent(result["sync_force_correction"]));
assert.deepEqual(result["drift_seconds"], 0);
},
async test_android_seek_output_clock_recovers_without_reseeking_audio() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/133.0.0.0" },
  configurable: true,
});
global.document = { documentElement: { dataset: { nativeHost: "true" } } };
const frames = new Map(); let nextFrame = 0;
window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
window.cancelAnimationFrame = id => frames.delete(id);
const video = new FakeMedia(10);
class OutputClockAudio extends FakeMedia {
  get currentTime() { return this._time; }
  set currentTime(value) {
    super.currentTime = value;
    this.seeking = true; this.readyState = 1;
    this.seekCompletesAt = nowMs + 10;
    this.clockResumesAt = nowMs + 310;
  }
}
const audio = new OutputClockAudio(9.8);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
// Exercise the real seek entry, settle and periodic controller together.
// seeked/canplay become true 300 ms BEFORE the audio output clock resumes.
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 30 });
const samples = [];
for (let tick = 1; tick <= 600; tick++) {
  nowMs += 10;
  if (audio.seeking && nowMs >= audio.seekCompletesAt) {
    audio.seeking = false; audio.readyState = 4;
  }
  if (!video.paused) video._time += 0.01;
  if (!audio.paused && !audio.seeking && nowMs >= audio.clockResumesAt) audio._time += 0.01;
  if (state.hostPlaybackSession.seekSettling) settleSplitPlayerSeek(video, audio);
  if (tick % 12 === 0) syncSplitPlayer(video, audio, 0.2, false);
  const pending = [...frames.values()]; frames.clear();
  for (const callback of pending) callback();
  await Promise.resolve(); await Promise.resolve();
  if (tick >= 200) samples.push(video.currentTime - audio.currentTime - 0.2);
}
console.log(JSON.stringify({
  audioSeekWrites: audio.seekWrites, videoSeekWrites: video.seekWrites,
  maxSettledDrift: Math.max(...samples.map(Math.abs)),
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  audioPauseCalls: audio.pauseCalls, pendingFrames: frames.size,
}));
`, this.clear_seek_source, this.seek_lifecycle_source, this.sync_source));
assert.deepEqual(result["audioSeekWrites"], 1, result);
assert.deepEqual(result["videoSeekWrites"], 1, result);
assert.ok(result["maxSettledDrift"] <= 0.045, result);
assert.ok(result["audioTime"] > 34);
assert.ok(!hasContent(result["videoPaused"]));
assert.ok(!hasContent(result["audioPaused"]));
assert.deepEqual(result["audioPauseCalls"], 1);
assert.deepEqual(result["pendingFrames"], 0);
},
async test_small_acceptable_drift_writes_neither_timeline() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(29.85);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0.2, false);
console.log(JSON.stringify({ action, videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["action"], "none");
assert.deepEqual(result["videoTime"], 30);
assert.deepEqual(result["audioTime"], 29.85);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
},
async run_android_clock_node(body, ...sources) {
return (await this.run_node(concatenate(`
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Chrome/133.0.0.0" },
  configurable: true,
});
global.document = { documentElement: { dataset: { nativeHost: "true" } } };
const frames = new Map(); let nextFrame = 0;
window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
window.cancelAnimationFrame = id => frames.delete(id);
const video = new FakeMedia(30), audio = new FakeMedia(29.5);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
`, body), this.sync_source, ...sources));
},
async test_android_clock_catchup_preserves_offset_and_requested_rate() {
let result, row;
result = (await this.run_android_clock_node(`
const results = [];
for (const offset of [-0.4, 0, 0.4]) {
  for (const rate of [0.75, 1, 1.5]) {
    effectiveOffsetSeconds = offset;
    state.localPlayerRequestedRate = rate;
    video._time = 30; audio._time = 30 - offset - 0.35;
    video.paused = false; audio.paused = false;
    syncSplitPlayer(video, audio, offset, false);
    const held = video.paused;
    for (let i = 0; i < 200; i++) {
      nowMs += 10;
      if (!video.paused) video._time += 0.01 * video.playbackRate;
      if (!audio.paused) audio._time += 0.01 * audio.playbackRate;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
      if (i % 12 === 0) syncSplitPlayer(video, audio, offset, false);
      await Promise.resolve();
    }
    results.push({ held, drift: video.currentTime - audio.currentTime - offset,
      videoRate: video.playbackRate, audioRate: audio.playbackRate,
      playing: !video.paused && !audio.paused, frames: frames.size });
  }
}
console.log(JSON.stringify({ results, videoSeeks: video.seekWrites, audioSeeks: audio.seekWrites }));
`));
assert.deepEqual(result["videoSeeks"], 0);
assert.deepEqual(result["audioSeeks"], 0);
for (const row of iterableValues(result["results"])) {
assert.ok(hasContent(row["held"]), row);
assert.ok(hasContent(row["playing"]), row);
assert.ok(Math.abs(row["drift"]) <= 0.045, row);
assert.deepEqual(row["videoRate"], row["audioRate"], row);
assert.deepEqual(row["frames"], 0, row);
}
},
async test_android_clock_recovery_cannot_undo_pause_or_new_seek() {
let result;
result = (await this.run_android_clock_node(`
syncSplitPlayer(video, audio, 0.2, false);
const oldPauseFrame = [...frames.values()][0];
setSplitPlaybackIntent(video, audio, false);
oldPauseFrame();
const paused = { video: video.paused, audio: audio.paused, frames: frames.size };
state.localShouldBePlaying = true; video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0.2, false);
const oldSeekFrame = [...frames.values()][0];
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: false, targetTime: 50 });
oldSeekFrame();
settleSplitPlayerSeek(video, audio, true);
console.log(JSON.stringify({ paused, videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  recovering: state.hostPlaybackSession.audioClockRecovering, frames: frames.size }));
`, this.clear_seek_source, this.seek_lifecycle_source));
assert.deepEqual(result["paused"], {["video"]: true, ["audio"]: true, ["frames"]: 0});
assert.deepEqual(result["videoTime"], 50);
assert.deepEqual(result["audioTime"], 49.8);
assert.ok(hasContent(result["videoPaused"]));
assert.ok(hasContent(result["audioPaused"]));
assert.ok(!hasContent(result["recovering"]));
assert.deepEqual(result["frames"], 0);
},
async test_android_clock_recovery_retires_with_session_and_ignores_old_frame() {
let result;
result = (await this.run_android_clock_node(`
syncSplitPlayer(video, audio, 0.2, false);
const oldSession = state.hostPlaybackSession;
const oldFrame = [...frames.values()][0];
clearLocalPlayerSyncTimer(oldSession);
state.hostPlaybackSession = { ...oldSession, audioClockRecoveryFrame: 999, audioClockRecovering: true };
oldFrame();
console.log(JSON.stringify({ oldFrame: oldSession.audioClockRecoveryFrame,
  oldRecovering: oldSession.audioClockRecovering,
  newFrame: state.hostPlaybackSession.audioClockRecoveryFrame,
  newRecovering: state.hostPlaybackSession.audioClockRecovering,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls }));
`, this.lifecycle_source));
assert.deepEqual(result, {["oldFrame"]: null, ["oldRecovering"]: false, ["newFrame"]: 999, ["newRecovering"]: true, ["videoPlayCalls"]: 0, ["audioPlayCalls"]: 0});
},
async test_android_audio_seek_holds_video_until_audio_recovers() {
let result;
result = (await this.run_android_clock_node(`
audio.seeking = true; audio.readyState = 1;
const waiting = syncSplitPlayer(video, audio, 0.2, false);
const held = video.paused;
audio.seeking = false; audio.readyState = 4;
const recovery = syncSplitPlayer(video, audio, 0.2, true);
console.log(JSON.stringify({ waiting, held, recovery, audioSeeks: audio.seekWrites,
  videoSeeks: video.seekWrites, audioPaused: audio.paused, frames: frames.size }));
`));
assert.deepEqual(result, {["waiting"]: "wait-for-audio", ["held"]: true, ["recovery"]: "wait-for-audio-clock", ["audioSeeks"]: 0, ["videoSeeks"]: 0, ["audioPaused"]: false, ["frames"]: 1});
},
async test_seek_supersedes_inflight_play_attempt_without_startup_failure() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10), audio = new FakeMedia(9.8);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
let rejectFirstPlay;
video.play = function () {
  this.paused = false; this.playCalls += 1;
  if (this.playCalls === 1) return new Promise((resolve, reject) => { rejectFirstPlay = reject; });
  return Promise.resolve();
};
startSplitPlaybackPair(video, audio, { userGesture: true });
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 45 });
// Chromium rejects the old pending play when the seek transaction pauses it.
rejectFirstPlay(Object.assign(new Error('interrupted by pause'), { name: 'AbortError' }));
for (let i = 0; i < 8; i++) await Promise.resolve();
const settled = settleSplitPlayerSeek(video, audio, true);
for (let i = 0; i < 8; i++) await Promise.resolve();
console.log(JSON.stringify({ settled, phase: state.hostPlaybackSession.phase,
  shouldPlay: state.localShouldBePlaying, videoPaused: video.paused, audioPaused: audio.paused,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls,
  videoTime: video.currentTime, audioTime: audio.currentTime }));
`, this.clear_seek_source, this.seek_lifecycle_source, this.sync_source));
assert.deepEqual(result, {["settled"]: true, ["phase"]: "playing", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 2, ["audioPlayCalls"]: 2, ["videoTime"]: 45, ["audioTime"]: 44.8});
},
async test_audio_variant_click_preserves_intent_during_internal_video_hold() {
let listener, result;
listener = (await this._slice("async function handleAudioVariantSelection(event)", "elements.audioVariantToggle?.addEventListener"));
result = (await this.run_node(`
const captures = [];
for (const intent of [true, false]) {
  const video = new FakeMedia(30), audio = new FakeMedia(29.5);
  mountedVideo = video; mountedAudio = audio;
  state.hostPlaybackSession.video = video;
  state.hostPlaybackSession.audio = audio;
  state.hostPlaybackSession.logicalPlayIntent = intent;
  state.localShouldBePlaying = intent;
  state.data.current_item = { id: 'item', item_incarnation_id: 'incarnation', selected_audio_variant_id: 'vocal' };
  const button = { dataset: { itemId: 'item', bound: 'true', variantId: 'instrumental' } };
  await variantClick({ target: { closest: () => button } });
  captures.push(state.pendingPlaybackRestore.wasPlaying);
}
console.log(JSON.stringify({ captures }));
`, concatenate(`
let variantClick;
elements.audioVariantPopover = { addEventListener() {} };
elements.audioVariantBar = { addEventListener(name, fn) { variantClick = fn; } };
const audioVariantSwitchDebounceMs = 350;
function audioVariantSwitchLocked() { return false; }
function selectedAudioVariantForItem() { return { id: 'vocal' }; }
function renderAudioVariantBar() {}
function frontendPlaybackMode() { return 'local'; }
function render() {}
function scheduleAudioVariantSwitchUnlock() {}
async function apiPostExactStateCommand() { return { commandApplied: true }; }
`, listener)));
assert.deepEqual(result["captures"], [true, false]);
},
async test_effective_offset_echo_performs_exactly_one_audio_resync() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0.2;
const changed = resyncMountedLocalPlayerIfOffsetChanged(0);
const echoed = resyncMountedLocalPlayerIfOffsetChanged(200);
console.log(JSON.stringify({ changed, echoed, videoTime: video.currentTime,
  audioTime: audio.currentTime, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites }));
`, this.sync_source, this.offset_resync_source));
assert.deepEqual(result, {["changed"]: true, ["echoed"]: false, ["videoTime"]: 30, ["audioTime"]: 29.8, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 1});
},
async test_av_delay_change_while_playing_repositions_only_audio() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0.2;
const changed = resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ changed, settling: state.hostPlaybackSession.seekSettling,
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`, this.sync_source, this.offset_resync_source));
assert.deepEqual(result, {["changed"]: true, ["settling"]: false, ["videoTime"]: 30, ["audioTime"]: 29.8, ["videoPaused"]: false, ["audioPaused"]: false, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 1});
},
async test_av_delay_resync_does_not_enter_coordinated_video_seek() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
let coordinatedSeekBegins = 0;
function beginSplitPlayerSeek() { coordinatedSeekBegins += 1; }
effectiveOffsetSeconds = 0.2;
resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ coordinatedSeekBegins, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites, audioTime: audio.currentTime }));
`, this.sync_source, this.offset_resync_source));
assert.deepEqual(result, {["coordinatedSeekBegins"]: 0, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 1, ["audioTime"]: 29.8});
},
async test_av_delay_change_while_paused_realigns_audio_and_stays_paused() {
let result;
result = (await this.run_node(`
mountedVideo = new FakeMedia(30);
mountedAudio = new FakeMedia(30);
state.localShouldBePlaying = false;
effectiveOffsetSeconds = 0.4;
const changed = resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ changed, videoTime: mountedVideo.currentTime,
  audioTime: mountedAudio.currentTime, videoPaused: mountedVideo.paused,
  audioPaused: mountedAudio.paused, videoPlayCalls: mountedVideo.playCalls,
  audioPlayCalls: mountedAudio.playCalls, videoSeekWrites: mountedVideo.seekWrites,
  audioSeekWrites: mountedAudio.seekWrites }));
`, this.sync_source, this.offset_resync_source));
assert.deepEqual(result, {["changed"]: true, ["videoTime"]: 30, ["audioTime"]: 29.6, ["videoPaused"]: true, ["audioPaused"]: true, ["videoPlayCalls"]: 0, ["audioPlayCalls"]: 0, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 1});
},
async test_audio_waiting_holds_video_without_seeking_it() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; audio.readyState = 2;
state.localAudioPlaybackBlocked = true;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, videoPaused: video.paused, videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["action"], "wait-for-audio");
assert.ok(hasContent(result["videoPaused"]));
assert.deepEqual(result["videoPauseCalls"], 1);
assert.deepEqual(result["audioPauseCalls"], 0);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
},
async test_rapid_host_seek_recovers_audio_when_readiness_event_is_lost() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;

beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 40 });
// A waiting/stalled event from the first seek can arrive without a matching
// canplay event when another host seek supersedes it.
state.localAudioPlaybackBlocked = true;
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 45 });
video.seeking = false; audio.seeking = false;
video.readyState = 4; audio.readyState = 4;
const settled = settleSplitPlayerSeek(video, audio, true);
await Promise.resolve(); await Promise.resolve();

console.log(JSON.stringify({
  settled,
  audioBlocked: state.localAudioPlaybackBlocked,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
`, this.clear_seek_source, this.seek_lifecycle_source, this.sync_source));
assert.deepEqual(result, {["settled"]: true, ["audioBlocked"]: false, ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
},
async test_transition_hold_prevents_any_audio_or_video_start() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.paused = false; audio.paused = false; heldItemId = "item";
const action = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action, shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls }));
`, this.sync_source));
assert.deepEqual(result["action"], "transition-hold");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(hasContent(result["videoPaused"]));
assert.ok(hasContent(result["audioPaused"]));
assert.deepEqual(result["videoPlayCalls"], 0);
assert.deepEqual(result["audioPlayCalls"], 0);
},
async test_positive_and_negative_delay_preserve_startup_boundaries() {
let result;
result = (await this.run_node(`
const positiveVideo = new FakeMedia(0); const positiveAudio = new FakeMedia(0);
const positiveAction = syncSplitPlayer(positiveVideo, positiveAudio, 0.4, true);
const negativeVideo = new FakeMedia(0); const negativeAudio = new FakeMedia(0);
const negativeAction = syncSplitPlayer(negativeVideo, negativeAudio, -0.4, true);
console.log(JSON.stringify({ positiveAction, positiveVideoTime: positiveVideo.currentTime,
  positiveAudioPaused: positiveAudio.paused, positiveVideoPlaying: !positiveVideo.paused,
  negativeAction, negativeVideoTime: negativeVideo.currentTime,
  negativeAudioTime: negativeAudio.currentTime, negativeAudioPlaying: !negativeAudio.paused,
  positiveVideoSeekWrites: positiveVideo.seekWrites,
  negativeVideoSeekWrites: negativeVideo.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["positiveAction"], "start");
assert.deepEqual(result["positiveVideoTime"], 0);
assert.ok(hasContent(result["positiveAudioPaused"]));
assert.ok(hasContent(result["positiveVideoPlaying"]));
assert.deepEqual(result["negativeAction"], "audio-drift-correction");
assert.deepEqual(result["negativeVideoTime"], 0);
assert.ok(Number(Math.abs(result["negativeAudioTime"] - 0.4).toFixed(7)) === 0);
assert.ok(hasContent(result["negativeAudioPlaying"]));
assert.deepEqual(result["positiveVideoSeekWrites"], 0);
assert.deepEqual(result["negativeVideoSeekWrites"], 0);
},
async test_video_timeline_seek_maps_to_audio_with_delay() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(12); const audio = new FakeMedia(3);
const target = syncSplitSeekAudioTarget(video, audio);
console.log(JSON.stringify({ target, audioTime: audio.currentTime }));
`, this.seek_source));
assert.ok(Number(Math.abs(result["target"] - 11.8).toFixed(7)) === 0);
assert.ok(Number(Math.abs(result["audioTime"] - 11.8).toFixed(7)) === 0);
},
async test_manual_video_seek_freezes_pair_maps_audio_and_resumes() {
let result;
result = (await this.run_node(concatenate(concatenate(`
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function maybeShowRatingPromptForProgress() {}
function reportCurrentVideoStatus() {}
const currentItem = { id: "item" };
const video = new FakeMedia(60); const audio = new FakeMedia(3);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
let coordinatedSeekBegins = 0;
const originalBeginSplitPlayerSeek = beginSplitPlayerSeek;
beginSplitPlayerSeek = (...args) => {
  coordinatedSeekBegins += 1;
  return originalBeginSplitPlayerSeek(...args);
};
`, this.video_seek_event_source), `
video.seeking = true;
video.dispatchMediaEvent("seeking");
const frozen = {
  coordinatedSeekBegins,
  internalSeek: video.dataset.bilikaraInternalSeek || null,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  audioTime: audio.currentTime,
  pendingTimers: pendingTimers.size,
};
video.seeking = false;
video.dispatchMediaEvent("seeked");
console.log(JSON.stringify({
  frozen,
  final: {
    coordinatedSeekBegins,
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
    pendingTimers: pendingTimers.size,
  },
}));
`), this.clear_seek_source, this.sync_source, this.seek_lifecycle_source));
assert.deepEqual(result["frozen"], {["coordinatedSeekBegins"]: 1, ["internalSeek"]: null, ["videoPaused"]: true, ["audioPaused"]: true, ["audioTime"]: 59.8, ["pendingTimers"]: 1});
assert.deepEqual(result["final"], {["coordinatedSeekBegins"]: 1, ["videoTime"]: 60, ["audioTime"]: 59.8, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1, ["pendingTimers"]: 0});
},
async test_playback_restore_intentionally_seeks_video_then_aligns_audio() {
let result;
result = (await this.run_node(`
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
const video = new FakeMedia(10); const audio = new FakeMedia(9.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
beginSplitPlayerSeek(video, audio, {
  resumeAfterSeek: true,
  targetTime: 45,
  diagnosticAction: "restore-video-seek",
});
const positioned = {
  videoTime: video.currentTime,
  audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
delete video.dataset.bilikaraInternalSeek;
const settled = settleSplitPlayerSeek(video, audio);
console.log(JSON.stringify({ positioned, settled, actions,
  finalVideoTime: video.currentTime, finalAudioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites,
  pairPlaying: !video.paused && !audio.paused }));
`, this.clear_seek_source, this.sync_source, this.seek_lifecycle_source));
assert.deepEqual(result["positioned"], {["videoTime"]: 45, ["audioTime"]: 44.8, ["videoSeekWrites"]: 1, ["audioSeekWrites"]: 1, ["videoPaused"]: true, ["audioPaused"]: true});
assert.ok(hasContent(result["settled"]));
assert.ok(contains("restore-video-seek", result["actions"]));
assert.deepEqual(result["finalVideoTime"], 45);
assert.ok(Number(Math.abs(result["finalAudioTime"] - 44.8).toFixed(7)) === 0);
assert.deepEqual(result["videoSeekWrites"], 1);
assert.deepEqual(result["audioSeekWrites"], 1);
assert.ok(hasContent(result["pairPlaying"]));
},
async test_manual_video_seek_while_paused_keeps_pair_paused() {
let result;
result = (await this.run_node(concatenate(concatenate(`
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function maybeShowRatingPromptForProgress() {}
function reportCurrentVideoStatus() {}
const currentItem = { id: "item" };
const video = new FakeMedia(60); const audio = new FakeMedia(3);
state.localShouldBePlaying = false;
mountedVideo = video; mountedAudio = audio;
`, this.video_seek_event_source), `
video.seeking = true;
video.dispatchMediaEvent("seeking");
video.seeking = false;
video.dispatchMediaEvent("seeked");
console.log(JSON.stringify({ videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`), this.clear_seek_source, this.sync_source, this.seek_lifecycle_source));
assert.deepEqual(result, {["videoTime"]: 60, ["audioTime"]: 59.8, ["videoPaused"]: true, ["audioPaused"]: true, ["videoPlayCalls"]: 0, ["audioPlayCalls"]: 0, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 1});
},
async test_requested_rate_is_preserved_without_internal_audio_nudging() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(5); const audio = new FakeMedia(5);
video.paused = false; audio.paused = false; state.localPlayerRequestedRate = 1.25;
syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ videoRate: video.playbackRate, audioRate: audio.playbackRate }));
`, this.sync_source));
assert.deepEqual(result, {["videoRate"]: 1.25, ["audioRate"]: 1.25});
},
async test_long_term_periodic_correction_never_writes_video_timeline() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(30); const audio = new FakeMedia(29.6);
video.paused = false; audio.paused = false;
const tickActions = [];
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.12; audio._time = 29.91; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.24; audio._time = 29.95; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.36; audio._time = 29.96; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 31; audio._time = 30.4; nowMs += 1000;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
console.log(JSON.stringify({ tickActions, videoTime: video.currentTime,
  videoSeekWrites: video.seekWrites, audioTime: audio.currentTime, audioSeekWrites: audio.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["tickActions"], ["audio-drift-correction", "none", "none", "none", "audio-drift-correction"]);
assert.deepEqual(result["videoTime"], 31);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 2);
assert.ok(Number(Math.abs(result["audioTime"] - 30.8).toFixed(7)) === 0);
},
async test_video_end_does_not_truncate_audio_and_completion_advances_once() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(100); const audio = new FakeMedia(95);
video.ended = true; video.paused = true; audio.paused = false;
const item = { id: "item" }; const report = () => {};
await handleSplitVideoEnded(item, video, audio, report);
const afterVideo = { advances, audioPaused: audio.paused };
audio.ended = true; audio.paused = true;
await handleSplitAudioEnded(item, video, audio, report);
await handleSplitAudioEnded(item, video, audio, report);
console.log(JSON.stringify({ afterVideo, advances }));
`, this.ended_source));
assert.deepEqual(result["afterVideo"], {["advances"]: 0, ["audioPaused"]: false});
assert.deepEqual(result["advances"], 1);
},
async test_teardown_helpers_clear_timers_and_registered_listeners() {
let result;
result = (await this.run_node(`
let intervalClears = 0; let timeoutClears = 0; let listenerCleanups = 0;
global.window = { clearInterval() { intervalClears += 1; }, clearTimeout() { timeoutClears += 1; } };
state.hostPlaybackSession.syncTimer = 1;
state.hostPlaybackSession.startupTimer = 2;
state.hostPlaybackSession.startupWatchdogTimer = 3;
state.hostPlaybackSession.eventCleanups.push(() => { listenerCleanups += 1; });
clearLocalPlayerSyncTimer(); clearLocalPlayerEventListeners();
console.log(JSON.stringify({ intervalClears, timeoutClears, listenerCleanups,
  syncTimer: state.hostPlaybackSession.syncTimer,
  startupTimer: state.hostPlaybackSession.startupTimer,
  watchdogTimer: state.hostPlaybackSession.startupWatchdogTimer,
  cleanupCount: state.hostPlaybackSession.eventCleanups.length }));
`, this.lifecycle_source));
assert.deepEqual(result["intervalClears"], 1);
assert.deepEqual(result["timeoutClears"], 2);
assert.deepEqual(result["listenerCleanups"], 1);
assert.equal(result["syncTimer"], null);
assert.equal(result["startupTimer"], null);
assert.equal(result["watchdogTimer"], null);
assert.deepEqual(result["cleanupCount"], 0);
},
async test_ordinary_render_does_not_synchronize_or_seek_mounted_player() {
let result;
result = (await this.run_node_script((`
let syncCalls = 0;
let videoSeekWrites = 0;
let audioSeekWrites = 0;
const video = { currentTime: 23.5 };
const audio = { currentTime: 23.5 };
const program = {
  item_id: "item",
  item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental",
  artifact_set_id: "artifact",
};
const state = {
  data: { playback_generation: 2, playback_program: program },
  hostPlaybackSession: {
    playbackGeneration: 2, playbackProgram: program, phase: "playing",
    video, audio, eventCleanups: [],
  },
};
function handleRatingCurrentItemChange() {}
function syncMountedLocalPlayer() {
  syncCalls += 1;
  videoSeekWrites += 1;
  audioSeekWrites += 1;
}
` + String(this.program_equality_source) + `
` + String(this.session_foundation_source) + `
` + String(this.renderer_source) + `
const item = { id: "item", item_incarnation_id: "incarnation" };
renderPlayer(item, "local");
console.log(JSON.stringify({
  syncCalls, videoSeekWrites, audioSeekWrites,
  sameVideo: state.hostPlaybackSession.video === video,
  sameAudio: state.hostPlaybackSession.audio === audio,
  currentTime: video.currentTime,
}));
`)));
assert.deepEqual(result, {["syncCalls"]: 0, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 0, ["sameVideo"]: true, ["sameAudio"]: true, ["currentTime"]: 23.5});
},
async test_ownership_claim_latency_does_not_consume_media_readiness_watchdog() {
let renderer, request_start, result, start_state;
renderer = this.renderer_source;
request_start = (await this._slice("function requestSplitPlaybackStart(", "function requestSplitPlaybackStartFromUserGesture"));
start_state = (await this._slice("function setSplitPlaybackStartState", "function isPlaybackPolicyRejection"));
assert.ok(sourceIndex(renderer, "addMountedPlayerListener(video, \"loadedmetadata\"") < sourceIndex(renderer, "beginHostPlaybackSessionOwnershipClaim(session)"));
assert.ok(contains("setSplitPlaybackStartState(\"pending\", video, audio)", request_start));
assert.ok(contains("scheduleSplitPlaybackStartupWatchdog(video, audio)", start_state));
result = (await this.run_node_script((`
(async () => {
  const splitPlaybackStartupWatchdogMs = 3000;
  const localPlayerSyncIntervalMs = 120;
  const timers = [];
  const intervals = [];
  const window = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setInterval(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { if (timer) timer.cancelled = true; },
  };
  class Media {
    constructor(role) {
      this.role = role;
      this.dataset = { playerItemId: "song-a" };
      this.listeners = new Map();
      this.paused = true;
      this.currentTime = 0;
      this.readyState = 0;
      this._src = "";
      this.loadCalls = 0;
      this.listenerCountAtSourceAssignment = 0;
    }
    get src() { return this._src; }
    set src(value) {
      this._src = String(value || "");
      if (this._src) this.listenerCountAtSourceAssignment = this.listeners.size;
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    load() { this.loadCalls += 1; }
  }
  const video = new Media("video");
  const audio = new Media("audio");
  const program = {
    item_id: "song-a",
    item_incarnation_id: "i-a",
    selected_audio_variant_id: "instrumental",
    artifact_set_id: "a-1",
  };
  const session = {
    playbackGeneration: 7,
    playbackProgram: program,
    phase: "binding",
    video,
    audio,
    mountData: {
      videoUrl: "/media/a-1/video.mp4",
      audioUrl: "/media/a-1/instrumental.m4a",
    },
    loadingStarted: false,
    readyCommitted: false,
    ownershipClaimStarted: false,
    ownershipClaimed: false,
    ownershipClaimFailed: false,
    ownershipClaimRequest: null,
    retirementReleaseSent: false,
    startupWatchdogTimer: null,
    startupTimer: null,
    syncTimer: null,
    eventCleanups: [],
  };
  const state = {
    data: { playback_generation: 7, playback_program: program },
    hostPlaybackSession: session,
    localPlaybackStartGeneration: 0,
    localPlaybackStartPromisesSettled: false,
    localAudioPlaybackBlocked: false,
    localVideoDeferredRecovery: false,
  };
  const elements = { playerFrame: { querySelector() { return null; } } };
  let resolveClaim;
  let claimRequests = 0;
  let readinessFailures = 0;
  function apiPost(path) {
    if (path !== "/api/player/claim-program") throw new Error(\`unexpected \${path}\`);
    claimRequests += 1;
    return new Promise((resolve) => { resolveClaim = resolve; });
  }
  function addMountedPlayerListener(media, name, listener) {
    media.addEventListener(name, listener);
    session.eventCleanups.push(() => {});
    return true;
  }
  function isActiveSplitPlayer(candidateVideo, candidateAudio) {
    return candidateVideo === video
      && candidateAudio === audio
      && state.hostPlaybackSession === session
      && session.phase !== "retired";
  }
  function clearSplitPlaybackStartupWatchdog(candidate = state.hostPlaybackSession) {
    if (!candidate?.startupWatchdogTimer) return;
    window.clearTimeout(candidate.startupWatchdogTimer);
    candidate.startupWatchdogTimer = null;
  }
  function failHostPlaybackCandidate(candidate, candidateVideo, candidateAudio) {
    if (
      candidate !== state.hostPlaybackSession
      || candidateVideo !== video
      || candidateAudio !== audio
      || candidate.phase !== "binding"
    ) return false;
    readinessFailures += 1;
    candidate.phase = "failed";
    return true;
  }
  function playbackProgramDescriptorsEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  function clearWebKitAudioStarvationTimer() {}
  function isWebKitPlaybackRuntime() { return false; }
  function syncSplitPlayer() {}
  function currentAvOffsetSeconds() { return 0; }
  function maybeShowRatingPromptForProgress() {}
  async function handleSplitAudioEnded() {}
  function reportCurrentVideoStatus() {}
  function synchronizeStartupPlayer() { return false; }
  ` + String(this.watchdog_schedule_source) + `
  ` + String(this.session_foundation_source) + `
  function registerRendererTail() {
  ` + String(this.renderer_tail_source) + `

  registerRendererTail();
  await Promise.resolve();
  await Promise.resolve();
  const preclaimScheduleAccepted = scheduleSplitPlaybackStartupWatchdog(video, audio);
  const pendingWatchdogs = timers.filter(
    (timer) => timer.delay === splitPlaybackStartupWatchdogMs && !timer.cancelled
  );
  pendingWatchdogs.forEach((timer) => timer.callback());
  const whileClaimPending = {
    pairCount: Number(Boolean(video)) + Number(Boolean(audio)),
    videoSrc: video.src,
    audioSrc: audio.src,
    loadingStarted: session.loadingStarted,
    readinessFailures,
    claimRequests,
    preclaimScheduleAccepted,
    activeWatchdogs: session.startupWatchdogTimer ? 1 : 0,
  };

  resolveClaim({ claimed: true });
  await session.ownershipClaimRequest;
  const afterClaim = {
    ownershipClaimed: session.ownershipClaimed,
    videoSrc: video.src,
    audioSrc: audio.src,
    videoLoadCalls: video.loadCalls,
    audioLoadCalls: audio.loadCalls,
    listenersBeforeVideoSource: video.listenerCountAtSourceAssignment,
    listenersBeforeAudioSource: audio.listenerCountAtSourceAssignment,
    loadingStarted: session.loadingStarted,
    readinessFailures,
    claimRequests,
    activeWatchdogs: session.startupWatchdogTimer ? 1 : 0,
  };

  timers
    .filter((timer) => timer.delay === splitPlaybackStartupWatchdogMs && !timer.cancelled)
    .forEach((timer) => timer.callback());
  const afterUnreadyTimeout = {
    phase: session.phase,
    readinessFailures,
    activeWatchdogs: session.startupWatchdogTimer ? 1 : 0,
  };
  console.log(JSON.stringify({ whileClaimPending, afterClaim, afterUnreadyTimeout }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
assert.deepEqual(result["whileClaimPending"], {["pairCount"]: 2, ["videoSrc"]: "", ["audioSrc"]: "", ["loadingStarted"]: false, ["readinessFailures"]: 0, ["claimRequests"]: 1, ["preclaimScheduleAccepted"]: false, ["activeWatchdogs"]: 0});
assert.deepEqual(result["afterClaim"], {["ownershipClaimed"]: true, ["videoSrc"]: "/media/a-1/video.mp4", ["audioSrc"]: "/media/a-1/instrumental.m4a", ["videoLoadCalls"]: 1, ["audioLoadCalls"]: 1, ["listenersBeforeVideoSource"]: 0, ["listenersBeforeAudioSource"]: 5, ["loadingStarted"]: true, ["readinessFailures"]: 0, ["claimRequests"]: 1, ["activeWatchdogs"]: 1});
assert.deepEqual(result["afterUnreadyTimeout"], {["phase"]: "failed", ["readinessFailures"]: 1, ["activeWatchdogs"]: 0});
},
async test_refresh_progress_preserves_mounted_pair_and_new_artifact_changes_identity_once() {
let result;
result = (await this.run_node_script((`
` + String(this.program_equality_source) + `
const initial = {
  item_id: "song-a", item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental", artifact_set_id: "set-a1",
};
const progressRefresh = { ...initial };
const languageRefresh = { ...initial };
const replacement = { ...initial, artifact_set_id: "set-a2" };
console.log(JSON.stringify({
  sameDuringRefresh: playbackProgramDescriptorsEqual(initial, progressRefresh),
  sameAfterLanguageChange: playbackProgramDescriptorsEqual(progressRefresh, languageRefresh),
  replacementChanged: !playbackProgramDescriptorsEqual(replacement, progressRefresh),
  replacementStable: playbackProgramDescriptorsEqual(replacement, { ...replacement }),
}));
`)));
assert.deepEqual(result, {["sameDuringRefresh"]: true, ["sameAfterLanguageChange"]: true, ["replacementChanged"]: true, ["replacementStable"]: true});
},
async test_key_shift_action_writes_neither_media_timeline() {
let result;
result = (await this.run_node_script((`
(async () => {
  class TimelineMedia {
    constructor() { this._time = 30; this.seekWrites = 0; this.paused = false; }
    get currentTime() { return this._time; }
    set currentTime(value) { this._time = Number(value); this.seekWrites += 1; }
  }
  const video = new TimelineMedia();
  const audio = new TimelineMedia();
  const state = {
    data: { player_settings: { key_shift: 0 } },
    volumeSaveSeq: 0,
    audioContext: null,
  };
  const window = { AudioContext: null, webkitAudioContext: null };
  function markLocalVolumeWrite() { state.volumeSaveSeq += 1; return state.volumeSaveSeq; }
  function activeLocalPlayerElements() { return { video, audio }; }
  function renderKeyShiftControls() {}
  function frontendPlaybackMode() { return "local"; }
  function setAppMessage() {}
  function t(key) { return key; }
  function ensureAudioPitchSource() { return null; }
  function disposeAudioPitchProcessor() {}
  function disconnectAudioPitchSource() {}
  function resumeAudioContextBestEffort() {}
  function syncLocalPlayerSettingsFromSnapshot(settings) {
    applyKeyShiftToAudio(audio, settings?.key_shift);
  }
  async function apiPost() { return { player_settings: { key_shift: 3 } }; }
  ` + String(this.pitch_apply_source) + `
  ` + String(this.key_shift_action_source) + `
  await setLocalPlayerKeyShift(3);
  console.log(JSON.stringify({
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
    videoSeekWrites: video.seekWrites,
    audioSeekWrites: audio.seekWrites,
  }));
})().catch((error) => { globalThis.console.error(error); process.exit(1); });
`)));
assert.deepEqual(result, {["videoTime"]: 30, ["audioTime"]: 30, ["videoSeekWrites"]: 0, ["audioSeekWrites"]: 0});
assert.ok(!contains("currentTime", this.pitch_apply_source));
assert.ok(!contains("syncMountedLocalPlayer", this.key_shift_action_source));
},
async test_key_shift_render_echo_does_not_synchronize_or_seek_video() {
let result;
result = (await this.run_node_script((`
let syncCalls = 0;
let videoSeekWrites = 0;
const video = { currentTime: 30 };
const audio = { currentTime: 30 };
const program = {
  item_id: "item", item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental", artifact_set_id: "artifact",
};
const state = {
  data: { playback_generation: 4, playback_program: program, player_settings: { key_shift: 0 } },
  hostPlaybackSession: {
    playbackGeneration: 4, playbackProgram: program, phase: "playing",
    video, audio, eventCleanups: [],
  },
};
function handleRatingCurrentItemChange() {}
function syncMountedLocalPlayer() { syncCalls += 1; videoSeekWrites += 1; }
` + String(this.program_equality_source) + `
` + String(this.session_foundation_source) + `
` + String(this.renderer_source) + `
const item = { id: "item", item_incarnation_id: "incarnation" };
state.data.player_settings.key_shift = 2;
renderPlayer(item, "local");
renderPlayer(item, "local");
console.log(JSON.stringify({
  syncCalls, videoSeekWrites,
  sameVideo: state.hostPlaybackSession.video === video,
  sameAudio: state.hostPlaybackSession.audio === audio,
  currentTime: video.currentTime,
}));
`)));
assert.deepEqual(result, {["syncCalls"]: 0, ["videoSeekWrites"]: 0, ["sameVideo"]: true, ["sameAudio"]: true, ["currentTime"]: 30});
},
async test_startup_readiness_events_coalesce_without_timeline_write_storm() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
effectiveOffsetSeconds = 0;
let restoreChecks = 0;
const originalSyncSplitPlayer = syncSplitPlayer;
const forceCalls = [];
syncSplitPlayer = (...args) => {
  forceCalls.push(Boolean(args[3]));
  return originalSyncSplitPlayer(...args);
};
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => { restoreChecks += 1; return false; },
);
const handleReadiness = () => {
  if (!synchronizeStartupPlayer()) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), state.localVideoDeferredRecovery);
  }
};
synchronizeStartupPlayer();
video.readyState = 4;
handleReadiness();
audio.readyState = 4;
handleReadiness();
handleReadiness();
handleReadiness();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
console.log(JSON.stringify({
  forceCalls,
  actions,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  videoTime: video.currentTime,
  audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites,
  restoreChecks,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(countOccurrences(result["forceCalls"], true), 1);
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.deepEqual(result["startState"], "established");
assert.ok(contains("autoplay-success", result["actions"]));
assert.deepEqual(result["videoTime"], 0);
assert.deepEqual(result["audioTime"], 0);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
assert.deepEqual(result["restoreChecks"], 1);
},
async test_staggered_readiness_commits_ready_paused_before_one_play_attempt() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 0; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.phase = "binding";
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.readyCommitCount = 0;
state.hostPlaybackSession.logicalPlayIntent = true;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
const playObservations = [];
for (const [kind, media] of [["video", video], ["audio", audio]]) {
  media.play = function play() {
    playObservations.push({
      kind,
      readyCommitted: state.hostPlaybackSession.readyCommitted,
      phase: state.hostPlaybackSession.phase,
    });
    this.paused = false;
    this.playCalls += 1;
    return Promise.resolve();
  };
}
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
video.readyState = 2;
synchronizeStartupPlayer();
const videoOnly = {
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  playCalls: [video.playCalls, audio.playCalls],
};
audio.readyState = 2;
synchronizeStartupPlayer();
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  videoOnly,
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  readyCommitCount: state.hostPlaybackSession.readyCommitCount,
  phase: state.hostPlaybackSession.phase,
  playCalls: [video.playCalls, audio.playCalls],
  playObservations,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["videoOnly"], {["readyCommitted"]: false, ["playCalls"]: [0, 0]});
assert.ok(hasContent(result["readyCommitted"]));
assert.deepEqual(result["readyCommitCount"], 1);
assert.deepEqual(result["phase"], "playing");
assert.deepEqual(result["playCalls"], [1, 1]);
assert.deepEqual(result["playObservations"], [{["kind"]: "video", ["readyCommitted"]: true, ["phase"]: "starting"}, {["kind"]: "audio", ["readyCommitted"]: true, ["phase"]: "starting"}]);
},
async test_audio_readiness_before_video_does_not_commit_or_start_early() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 0; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.phase = "binding";
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.readyCommitCount = 0;
state.hostPlaybackSession.logicalPlayIntent = true;
state.hostPlaybackSession.initialIntentApplied = false;
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
const audioOnlyHandled = synchronizeStartupPlayer();
const audioOnly = {
  handled: audioOnlyHandled,
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  playCalls: [video.playCalls, audio.playCalls],
};
video.readyState = 2;
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  audioOnly,
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  readyCommitCount: state.hostPlaybackSession.readyCommitCount,
  playCalls: [video.playCalls, audio.playCalls],
  phase: state.hostPlaybackSession.phase,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["audioOnly"], {["handled"]: true, ["readyCommitted"]: false, ["playCalls"]: [0, 0]});
assert.ok(hasContent(result["readyCommitted"]));
assert.deepEqual(result["readyCommitCount"], 1);
assert.deepEqual(result["playCalls"], [1, 1]);
assert.deepEqual(result["phase"], "playing");
},
async test_ready_commit_applies_paused_intent_without_playing() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(33); const audio = new FakeMedia(32.8);
video.readyState = 2; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.phase = "binding";
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.readyCommitCount = 0;
state.hostPlaybackSession.logicalPlayIntent = false;
state.hostPlaybackSession.initialIntentApplied = false;
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
synchronizeStartupPlayer();
console.log(JSON.stringify({
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  readyCommitCount: state.hostPlaybackSession.readyCommitCount,
  initialIntentApplied: state.hostPlaybackSession.initialIntentApplied,
  phase: state.hostPlaybackSession.phase,
  shouldPlay: state.localShouldBePlaying,
  playCalls: [video.playCalls, audio.playCalls],
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result, {["readyCommitted"]: true, ["readyCommitCount"]: 1, ["initialIntentApplied"]: true, ["phase"]: "paused", ["shouldPlay"]: false, ["playCalls"]: [0, 0]});
},
async test_policy_rejection_after_ready_commit_keeps_the_committed_pair() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
audio.play = function play() {
  this.playCalls += 1;
  const error = new Error("activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
mountedVideo = video; mountedAudio = audio;
Object.assign(state.hostPlaybackSession, {
  phase: "binding",
  readyCommitted: false,
  readyCommitCount: 0,
  logicalPlayIntent: true,
  initialIntentApplied: false,
});
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  readyCommitted: state.hostPlaybackSession.readyCommitted,
  readyCommitCount: state.hostPlaybackSession.readyCommitCount,
  phase: state.hostPlaybackSession.phase,
  shouldPlay: state.localShouldBePlaying,
  logicalPlayIntent: state.hostPlaybackSession.logicalPlayIntent,
  playCalls: [video.playCalls, audio.playCalls],
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, this.startup_source));
assert.ok(hasContent(result["readyCommitted"]));
assert.deepEqual(result["readyCommitCount"], 1);
assert.deepEqual(result["phase"], "needs-user-gesture");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(hasContent(result["logicalPlayIntent"]));
assert.deepEqual(result["playCalls"], [1, 1]);
assert.ok(contains("autoplay-audio-blocked", result["startupEvents"]));
},
async test_restore_settles_before_commit_and_applies_each_exact_intent_once() {
let entry, intent, observation, result;
result = (await this.run_node(`
async function exercise(logicalPlayIntent) {
  const video = new FakeMedia(0); const audio = new FakeMedia(0);
  video.readyState = 4; audio.readyState = 4;
  mountedVideo = video; mountedAudio = audio;
  Object.assign(state.hostPlaybackSession, {
    phase: "binding",
    video,
    audio,
    readyCommitted: false,
    readyCommitCount: 0,
    logicalPlayIntent,
    initialIntentApplied: false,
    restoreStarted: false,
    seekSettling: false,
    seekResumeAfterSettle: false,
    seekSettleStartedAt: 0,
    seekSettleTimer: null,
    seekSettleCallback: null,
    seekResumePending: false,
    seekUpdatesLogicalIntent: true,
  });
  const observations = [];
  for (const media of [video, audio]) {
    media.play = function play() {
      observations.push({
        event: "play",
        time: video.currentTime,
        readyCommitted: state.hostPlaybackSession.readyCommitted,
        phase: state.hostPlaybackSession.phase,
      });
      this.paused = false;
      this.playCalls += 1;
      return Promise.resolve();
    };
  }
  let restoreAttempts = 0;
  let restoreSettlements = 0;
  const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
    video,
    audio,
    () => {
      restoreAttempts += 1;
      return beginSplitPlayerSeek(video, audio, {
        resumeAfterSeek: false,
        allowUncommitted: true,
        updateIntent: false,
        targetTime: 48,
        diagnosticAction: "restore-video-seek",
        onSettled: (applied) => {
          restoreSettlements += 1;
          observations.push({
            event: "restore-settled",
            applied,
            time: video.currentTime,
            readyCommitted: state.hostPlaybackSession.readyCommitted,
            phase: state.hostPlaybackSession.phase,
          });
          if (applied) {
            commitHostPlaybackSessionReadyPaused(
              state.hostPlaybackSession,
              video,
              audio,
            );
          }
        },
      });
    },
  );
  synchronizeStartupPlayer();
  const beforeSettle = {
    time: video.currentTime,
    readyCommitted: state.hostPlaybackSession.readyCommitted,
    playCalls: [video.playCalls, audio.playCalls],
  };
  settleSplitPlayerSeek(video, audio, true);
  synchronizeStartupPlayer();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return {
    beforeSettle,
    observations,
    restoreAttempts,
    restoreSettlements,
    readyCommitCount: state.hostPlaybackSession.readyCommitCount,
    initialIntentApplied: state.hostPlaybackSession.initialIntentApplied,
    logicalPlayIntent: state.hostPlaybackSession.logicalPlayIntent,
    phase: state.hostPlaybackSession.phase,
    playCalls: [video.playCalls, audio.playCalls],
  };
}
const playing = await exercise(true);
const paused = await exercise(false);
console.log(JSON.stringify({ playing, paused }));
`, this.clear_seek_source, this.sync_source, this.seek_lifecycle_source, this.startup_source));
for (const intent of iterableValues(["playing", "paused"])) {
{
observation = result[intent];
assert.deepEqual(observation["restoreAttempts"], 1);
assert.deepEqual(observation["restoreSettlements"], 1);
assert.deepEqual(observation["readyCommitCount"], 1);
assert.ok(hasContent(observation["initialIntentApplied"]));
assert.deepEqual(observation["beforeSettle"]["time"], 48);
assert.ok(!hasContent(observation["beforeSettle"]["readyCommitted"]));
assert.deepEqual(observation["beforeSettle"]["playCalls"], [0, 0]);
assert.deepEqual(observation["observations"][0], {["event"]: "restore-settled", ["applied"]: true, ["time"]: 48, ["readyCommitted"]: false, ["phase"]: "binding"});
}
}
assert.ok(hasContent(result["playing"]["logicalPlayIntent"]));
assert.deepEqual(result["playing"]["phase"], "playing");
assert.deepEqual(result["playing"]["playCalls"], [1, 1]);
assert.ok(hasContent(Array.from(Array.from(iterableValues(result["playing"]["observations"].slice(1, undefined)))).map((entry) => entry["readyCommitted"]).every(Boolean)));
assert.ok(!hasContent(result["paused"]["logicalPlayIntent"]));
assert.deepEqual(result["paused"]["phase"], "paused");
assert.deepEqual(result["paused"]["playCalls"], [0, 0]);
},
async test_superseded_unready_candidate_and_media_error_settle_stale_safe_once() {
let result;
result = (await this.run_node(`
const exactIsActive = (video, audio) => Boolean(
  state.hostPlaybackSession
  && state.hostPlaybackSession.video === video
  && state.hostPlaybackSession.audio === audio
  && state.hostPlaybackSession.phase !== "retiring"
  && state.hostPlaybackSession.phase !== "retired"
);
isActiveSplitPlayer = exactIsActive;

function candidate(video, audio) {
  return {
    phase: "binding",
    video,
    audio,
    readyCommitted: false,
    readyCommitCount: 0,
    logicalPlayIntent: true,
    initialIntentApplied: false,
    restoreStarted: false,
    startupWatchdogTimer: null,
    seekSettling: false,
    seekResumeAfterSettle: false,
    seekSettleStartedAt: 0,
    seekSettleTimer: null,
    seekSettleCallback: null,
    seekResumePending: false,
    seekUpdatesLogicalIntent: true,
  };
}

const videoB = new FakeMedia(0); const audioB = new FakeMedia(0);
videoB.readyState = 0; audioB.readyState = 0;
const sessionB = candidate(videoB, audioB);
state.hostPlaybackSession = sessionB;
mountedVideo = videoB; mountedAudio = audioB;
const synchronizeB = createSplitPlayerStartupSynchronizer(videoB, audioB, () => false);

const videoC = new FakeMedia(0); const audioC = new FakeMedia(0);
videoC.readyState = 0; audioC.readyState = 0;
const sessionC = candidate(videoC, audioC);
sessionB.phase = "retired";
state.hostPlaybackSession = sessionC;
mountedVideo = videoC; mountedAudio = audioC;
const synchronizeC = createSplitPlayerStartupSynchronizer(videoC, audioC, () => false);

videoB.readyState = 4; audioB.readyState = 4;
const staleReadiness = synchronizeB();
const staleError = failHostPlaybackCandidate(
  sessionB,
  videoB,
  audioB,
  "stale-video-error",
);
const beforeC = {
  phase: sessionC.phase,
  readyCommitted: sessionC.readyCommitted,
  playCalls: [videoC.playCalls, audioC.playCalls],
};

videoC.readyState = 4; audioC.readyState = 4;
synchronizeC();
synchronizeC();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const committedC = {
  phase: sessionC.phase,
  readyCommitted: sessionC.readyCommitted,
  readyCommitCount: sessionC.readyCommitCount,
  playCalls: [videoC.playCalls, audioC.playCalls],
};

const sessionDVideo = new FakeMedia(0); const sessionDAudio = new FakeMedia(0);
const sessionD = candidate(sessionDVideo, sessionDAudio);
state.hostPlaybackSession = sessionD;
mountedVideo = sessionDVideo; mountedAudio = sessionDAudio;
const firstError = failHostPlaybackCandidate(
  sessionD,
  sessionDVideo,
  sessionDAudio,
  "video-error-before-readiness",
);
const duplicateError = failHostPlaybackCandidate(
  sessionD,
  sessionDVideo,
  sessionDAudio,
  "audio-error-before-readiness",
);
console.log(JSON.stringify({
  staleReadiness,
  staleError,
  beforeC,
  committedC,
  failure: {
    firstError,
    duplicateError,
    phase: sessionD.phase,
    readyCommitted: sessionD.readyCommitted,
    failureStage: sessionD.failureStage,
    playCalls: [sessionDVideo.playCalls, sessionDAudio.playCalls],
    startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  },
}));
`, this.sync_source, this.startup_source));
assert.ok(!hasContent(result["staleReadiness"]));
assert.ok(!hasContent(result["staleError"]));
assert.deepEqual(result["beforeC"], {["phase"]: "binding", ["readyCommitted"]: false, ["playCalls"]: [0, 0]});
assert.deepEqual(result["committedC"], {["phase"]: "playing", ["readyCommitted"]: true, ["readyCommitCount"]: 1, ["playCalls"]: [1, 1]});
assert.ok(hasContent(result["failure"]["firstError"]));
assert.ok(!hasContent(result["failure"]["duplicateError"]));
assert.deepEqual(result["failure"]["phase"], "failed");
assert.ok(!hasContent(result["failure"]["readyCommitted"]));
assert.deepEqual(result["failure"]["failureStage"], "media-readiness");
assert.deepEqual(result["failure"]["playCalls"], [0, 0]);
assert.deepEqual(result["failure"]["startupEvents"].slice((-2), undefined), ["video-error-before-readiness", "startup-failed"]);
},
async test_uncommitted_candidate_cannot_authoritatively_end() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(100); const audio = new FakeMedia(100);
video.ended = true; audio.ended = true;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.readyCommitted = false;
state.localPlaybackEndHandled = false;
await handleSplitVideoEnded({ id: "item" }, video, audio, () => {});
const beforeCommit = { advances, handled: state.localPlaybackEndHandled };
state.hostPlaybackSession.readyCommitted = true;
await handleSplitVideoEnded({ id: "item" }, video, audio, () => {});
console.log(JSON.stringify({ beforeCommit, advances, handled: state.localPlaybackEndHandled }));
`, this.ended_source));
assert.deepEqual(result["beforeCommit"], {["advances"]: 0, ["handled"]: false});
assert.deepEqual(result["advances"], 1);
assert.ok(hasContent(result["handled"]));
},
async test_program_scoped_player_status_is_observed_ordered_and_session_owned() {
let generation_eight, generation_seven, normalized_phases, phase, post, posts, result, status_source;
status_source = (await this._slice("function observedHostPlayerStatus", "function renderPlaylist"));
result = (await this.run_node(`
const video = new FakeMedia(18); const audio = new FakeMedia(17.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
const programA = {
  item_id: "item",
  item_incarnation_id: "i-a",
  selected_audio_variant_id: "instrumental",
  artifact_set_id: "a-a",
};
Object.assign(state.hostPlaybackSession, {
  phase: "binding",
  video,
  audio,
  readyCommitted: false,
  playbackGeneration: 7,
  playbackProgram: programA,
  statusSequence: 0,
  lastReportedStatusSignature: "",
  lastStatusHeartbeatAt: 0,
});
state.data = {
  playback_generation: 7,
  playback_program: programA,
  current_item: { id: "item" },
};
let mediaSessionPublishes = 0;
let presentationPublishes = 0;
syncTauriMediaSessionState = () => { mediaSessionPublishes += 1; return true; };
publishPresentationPlaybackState = () => { presentationPublishes += 1; return Promise.resolve(); };
const beforeCommit = reportPlayerStatus("item", video, state.hostPlaybackSession);
reportPlayerStatusHeartbeat("item", video, state.hostPlaybackSession);
const beforeCounts = {
  diagnosticPosts: diagnosticPosts.length,
  mediaSessionPublishes,
  presentationPublishes,
};
state.hostPlaybackSession.readyCommitted = true;
state.hostPlaybackSession.phase = "playing";
const afterCommit = reportPlayerStatus("item", video, state.hostPlaybackSession);
const duplicate = reportPlayerStatus("item", video, state.hostPlaybackSession);
reportPlayerStatusHeartbeat("item", video, state.hostPlaybackSession);
nowMs = 6001;
video.currentTime = 24;
reportPlayerStatusHeartbeat("item", video, state.hostPlaybackSession);

for (const phase of ["ready-paused", "starting", "needs-user-gesture", "failed"]) {
  state.hostPlaybackSession.phase = phase;
  video.currentTime += 1;
  reportPlayerStatus("item", video, state.hostPlaybackSession);
}
state.hostPlaybackSession.phase = "playing";
video.currentTime += 1;
reportPlayerStatus("item", video, state.hostPlaybackSession);

const retiredSession = state.hostPlaybackSession;
const videoB = new FakeMedia(3); const audioB = new FakeMedia(2.8);
videoB.paused = false; audioB.paused = false;
mountedVideo = videoB; mountedAudio = audioB;
const programB = { ...programA, artifact_set_id: "a-b" };
state.hostPlaybackSession = {
  ...retiredSession,
  phase: "playing",
  video: videoB,
  audio: audioB,
  playbackGeneration: 8,
  playbackProgram: programB,
  statusSequence: 0,
  lastReportedStatusSignature: "",
  lastStatusHeartbeatAt: 0,
};
state.data = {
  playback_generation: 8,
  playback_program: programB,
  current_item: { id: "item" },
};
const lateOldSession = reportPlayerStatus("item", video, retiredSession);
const newSessionFirst = reportPlayerStatus("item", videoB, state.hostPlaybackSession);
state.hostPlaybackSession.statusSequence = Number.MAX_SAFE_INTEGER;
videoB.currentTime += 1;
const exhausted = reportPlayerStatus("item", videoB, state.hostPlaybackSession);
await Promise.resolve();
console.log(JSON.stringify({
  beforeCommit,
  beforeCounts,
  afterCommit,
  duplicate,
  lateOldSession,
  newSessionFirst,
  exhausted,
  statusPosts: diagnosticPosts
    .filter((entry) => entry.url === "/api/player/status")
    .map((entry) => entry.payload),
  afterCounts: {
    diagnosticPosts: diagnosticPosts.length,
    mediaSessionPublishes,
    presentationPublishes,
  },
}));
`, `
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session.phase !== "retiring"
    && session.phase !== "retired"
    && session.video === video
    && session.audio === audio;
}
function syncTauriMediaSessionState() { return true; }
function publishPresentationPlaybackState() { return Promise.resolve(); }
function maybeShowRatingPromptForProgress() {}
`, status_source));
assert.ok(!hasContent(result["beforeCommit"]));
assert.deepEqual(result["beforeCounts"], {["diagnosticPosts"]: 0, ["mediaSessionPublishes"]: 0, ["presentationPublishes"]: 0});
assert.ok(hasContent(result["afterCommit"]));
assert.ok(!hasContent(result["duplicate"]));
assert.ok(!hasContent(result["lateOldSession"]));
assert.ok(hasContent(result["newSessionFirst"]));
assert.ok(!hasContent(result["exhausted"]));
posts = result["statusPosts"];
generation_seven = Array.from(Array.from(iterableValues(posts)) .filter((post) => ((post["playback_generation"] === 7)))).map((post) => post);
generation_eight = Array.from(Array.from(iterableValues(posts)) .filter((post) => ((post["playback_generation"] === 8)))).map((post) => post);
assert.deepEqual(Array.from(Array.from(iterableValues(generation_seven))).map((post) => post["status_sequence"]), Array.from(Array.from({length: concatenate(generation_seven.length, 1) - 1}, (_, i) => i + 1)));
assert.deepEqual(Array.from(Array.from(iterableValues(generation_eight))).map((post) => post["status_sequence"]), [1]);
assert.deepEqual(generation_seven[0]["observed_phase"], "playing");
assert.ok(!hasContent(generation_seven[0]["is_paused"]));
normalized_phases = Object.fromEntries(Array.from(Array.from(iterableValues(generation_seven))).map((post) => [post["observed_phase"], post["is_paused"]]));
for (const phase of iterableValues(["ready-paused", "starting", "needs-user-gesture", "failed"])) {
assert.ok(hasContent(normalized_phases[phase]));
}
assert.ok(!hasContent(normalized_phases["playing"]));
assert.ok(result["afterCounts"]["mediaSessionPublishes"] >= posts.length);
assert.ok(result["afterCounts"]["presentationPublishes"] >= posts.length);
},
async test_packaged_tauri_webkit_fresh_start_resolves_without_user_gesture() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: {
    toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); },
  },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  isTauriWebKit: isTauriWebKitRuntime(),
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupDiagnostics,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result, {["isTauriWebKit"]: true, ["startState"]: "established", ["shouldPlay"]: true, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1, ["overlayHidden"]: true, ["startupDiagnostics"]: [{["eventName"]: "autoplay-attempt", ["playbackStartState"]: "starting", ["localShouldBePlaying"]: true}, {["eventName"]: "autoplay-video-play-resolved", ["playbackStartState"]: "starting", ["localShouldBePlaying"]: true}, {["eventName"]: "autoplay-audio-play-resolved", ["playbackStartState"]: "starting", ["localShouldBePlaying"]: true}, {["eventName"]: "autoplay-success", ["playbackStartState"]: "established", ["localShouldBePlaying"]: true}]});
},
async test_webkit_metadata_only_pair_attempts_autoplay_before_canplay() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
const handled = synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  handled,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["handled"]));
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.ok(contains("autoplay-attempt", result["startupEvents"]));
assert.ok(contains("autoplay-success", result["startupEvents"]));
},
async test_chromium_initial_start_keeps_existing_canplay_gate() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
const atMetadata = {
  startState: state.localPlaybackStartState,
  playCalls: [video.playCalls, audio.playCalls],
};
video.readyState = 2; audio.readyState = 2;
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  atMetadata,
  finalState: state.localPlaybackStartState,
  finalPlayCalls: [video.playCalls, audio.playCalls],
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["atMetadata"], {["startState"]: "pending", ["playCalls"]: [0, 0]});
assert.deepEqual(result["finalState"], "established");
assert.deepEqual(result["finalPlayCalls"], [1, 1]);
},
async test_packaged_tauri_metadata_start_ignores_internal_native_play_echo() {
let event, result;
result = (await this.run_node(`
synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(video, audio, () => false);
synchronizeStartupPlayer();

// WebKit/Now Playing echoes the application-owned video play event.
video.paused = false;
video.dispatchMediaEvent("play");
const afterEarlyPlay = {
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  videoPauseCalls: video.pauseCalls,
};

await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterEarlyPlay,
  finalState: state.localPlaybackStartState,
  finalShouldPlay: state.localShouldBePlaying,
  finalOverlayHidden: mountedOverlay.hidden,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupDiagnostics,
}));
`, this.sync_source, this.startup_source, `
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 4;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: {
    toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); },
  },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
const currentItem = { id: "item" };
let synchronizeStartupPlayer = null;
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
`, this.video_play_event_source));
assert.deepEqual(result["afterEarlyPlay"], {["startState"]: "starting", ["shouldPlay"]: true, ["overlayHidden"]: true, ["videoPauseCalls"]: 0});
assert.deepEqual(result["finalState"], "established");
assert.ok(hasContent(result["finalShouldPlay"]));
assert.ok(hasContent(result["finalOverlayHidden"]));
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.deepEqual(Array.from(Array.from(iterableValues(result["startupDiagnostics"]))).map((event) => event["eventName"]), ["autoplay-attempt", "autoplay-video-play-resolved", "autoplay-audio-play-resolved", "autoplay-success"]);
},
async test_host_pending_first_video_click_is_immediate_start_not_toggle() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17 Safari/605.1.15",
}, configurable: true, writable: true });
delete window.__TAURI__;
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
let insideClickHandler = false;
const activationObservations = [];
video.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["video", insideClickHandler]);
  return Promise.resolve();
};
audio.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["audio", insideClickHandler]);
  return Promise.resolve();
};
insideClickHandler = true;
frameClickHandler({
  target: { closest(selector) { return selector === "video" ? video : null; } },
});
insideClickHandler = false;
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  activationObservations,
  queuedToggleCalls,
  playCalls: [video.playCalls, audio.playCalls],
}));
`, this.sync_source, `
let frameClickHandler = null;
let queuedToggleCalls = 0;
function clearPlayerFrameClickTimer() {}
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
`, this.player_frame_click_listener_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.deepEqual(result["activationObservations"], [["video", true], ["audio", true]]);
assert.deepEqual(result["queuedToggleCalls"], 0);
assert.deepEqual(result["playCalls"], [1, 1]);
},
async test_packaged_tauri_pending_video_click_is_one_explicit_start() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
frameClickHandler({
  target: { closest(selector) { return selector === "video" ? video : null; } },
});
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  queuedToggleCalls,
  playCalls: [video.playCalls, audio.playCalls],
}));
`, this.sync_source, `
let frameClickHandler = null;
let queuedToggleCalls = 0;
function clearPlayerFrameClickTimer() {}
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
`, this.player_frame_click_listener_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.deepEqual(result["queuedToggleCalls"], 0);
assert.deepEqual(result["playCalls"], [1, 1]);
},
async test_packaged_tauri_native_pause_and_play_ignore_outer_video_click() {
let result;
result = (await this.run_node(`
function mountPair(playing) {
  video = new FakeMedia(20); audio = new FakeMedia(19.8);
  video.paused = !playing; audio.paused = !playing;
  mountedVideo = video; mountedAudio = audio;
  session.video = video; session.audio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = playing;
  return { video, audio };
}

const playingPair = mountPair(true);
playingPair.video.paused = true;
videoPauseListener();
frameClickHandler(nativeVideoClick);
await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: playingPair.video.paused,
  audioPaused: playingPair.audio.paused,
  queuedToggleCalls,
};

const pausedPair = mountPair(false);
pausedPair.video.paused = false;
videoPlayListener();
frameClickHandler(nativeVideoClick);
await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
const afterPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: pausedPair.video.paused,
  audioPaused: pausedPair.audio.paused,
  queuedToggleCalls,
};
console.log(JSON.stringify({ afterPause, afterPlay }));
`, this.sync_source, this.startup_source, `
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
global.document = { hidden: false };
const currentItem = { id: "item" };
let synchronizeStartupPlayer = () => false;
let video = new FakeMedia(20); let audio = new FakeMedia(19.8);
const session = state.hostPlaybackSession;
let videoPlayListener = null;
let videoPauseListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (eventName === "play") videoPlayListener = listener;
  if (eventName === "pause") videoPauseListener = listener;
}
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
let frameClickHandler = null;
let queuedToggleCalls = 0;
const playerClickDelayMs = 10;
function clearPlayerFrameClickTimer() {
  if (state.playerFrameClickTimer) clearTimeout(state.playerFrameClickTimer);
  state.playerFrameClickTimer = null;
}
function queuePlayerFrameSingleClick() {
  clearPlayerFrameClickTimer();
  state.playerFrameClickTimer = setTimeout(() => {
    state.playerFrameClickTimer = null;
    queuedToggleCalls += 1;
    setSplitPlaybackIntent(mountedVideo, mountedAudio, !state.localShouldBePlaying, {
      source: "player-toggle-intent",
      userGesture: true,
    });
  }, playerClickDelayMs);
}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
const nativeVideoClick = {
  target: {
    closest(selector) { return selector === "video" ? mountedVideo : null; },
  },
};
`, this.video_play_pause_event_source, this.player_frame_click_listener_source));
assert.deepEqual(result["afterPause"], {["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true, ["queuedToggleCalls"]: 0});
assert.deepEqual(result["afterPlay"], {["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["queuedToggleCalls"]: 0});
},
async test_packaged_tauri_native_seek_ignores_outer_video_click_and_preserves_intent() {
let result;
result = (await this.run_node(`
async function exercise(playing) {
  clearPlayerFrameClickTimer();
  const beforeQueued = queuedToggleCalls;
  video = new FakeMedia(20); audio = new FakeMedia(19.8);
  video.paused = !playing; audio.paused = !playing;
  mountedVideo = video; mountedAudio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = playing;

  video.currentTime = 35;
  video.seeking = true;
  videoSeekingListener();
  frameClickHandler(nativeVideoClick);
  video.seeking = false;
  audio.seeking = false;
  videoSeekedListener();
  await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
  return {
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoWrites: video.seekWrites,
    audioWrites: audio.seekWrites,
    queuedToggleCalls: queuedToggleCalls - beforeQueued,
  };
}

const playing = await exercise(true);
const paused = await exercise(false);
console.log(JSON.stringify({ playing, paused }));
`, this.sync_source, this.startup_source, this.seek_lifecycle_source, this.clear_seek_source, `
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
let video = new FakeMedia(20); let audio = new FakeMedia(19.8);
let videoSeekingListener = null;
let videoSeekedListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (eventName === "seeking") videoSeekingListener = listener;
  if (eventName === "seeked") videoSeekedListener = listener;
}
function reportCurrentVideoStatus() {}
function maybeShowRatingPromptForProgress() {}
const currentItem = { id: "item" };
let frameClickHandler = null;
let queuedToggleCalls = 0;
const playerClickDelayMs = 10;
function clearPlayerFrameClickTimer() {
  if (state.playerFrameClickTimer) clearTimeout(state.playerFrameClickTimer);
  state.playerFrameClickTimer = null;
}
function queuePlayerFrameSingleClick() {
  clearPlayerFrameClickTimer();
  state.playerFrameClickTimer = setTimeout(() => {
    state.playerFrameClickTimer = null;
    queuedToggleCalls += 1;
    setSplitPlaybackIntent(mountedVideo, mountedAudio, !state.localShouldBePlaying, {
      source: "player-toggle-intent",
      userGesture: true,
    });
  }, playerClickDelayMs);
}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
const nativeVideoClick = {
  target: {
    closest(selector) { return selector === "video" ? mountedVideo : null; },
  },
};
`, this.video_seek_event_source, this.player_frame_click_listener_source));
assert.deepEqual(result["playing"], {["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoWrites"]: 1, ["audioWrites"]: 1, ["queuedToggleCalls"]: 0});
assert.deepEqual(result["paused"], {["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true, ["videoWrites"]: 1, ["audioWrites"]: 1, ["queuedToggleCalls"]: 0});
},
async test_player_frame_click_toggle_is_bypassed_only_for_tauri_webkit() {
let result;
result = (await this.run_node(`
function exercise(userAgent, tauriPresent) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent }, configurable: true, writable: true,
  });
  if (tauriPresent) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
  const before = queuedToggleCalls;
  frameClickHandler({ target: { closest(selector) { return selector === "video" ? {} : null; } } });
  return queuedToggleCalls - before;
}
console.log(JSON.stringify({
  safari: exercise(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    false,
  ),
  chrome: exercise("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", false),
  webview2: exercise(
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120",
    true,
  ),
  tauriWebKit: exercise(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    true,
  ),
}));
`, `
let frameClickHandler = null;
let queuedToggleCalls = 0;
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
function clearPlayerFrameClickTimer() {}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
`, this.player_frame_click_listener_source));
assert.deepEqual(result, {["safari"]: 1, ["chrome"]: 1, ["webview2"]: 1, ["tauriWebKit"]: 0});
},
async test_remote_toggle_during_pending_start_is_deterministic_play() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  playCalls: [video.playCalls, audio.playCalls],
  appliedSeq: state.lastAppliedPlayerControlSeq,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, `
function ackRemotePlayerControl() {}
`, remote_control_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.deepEqual(result["playCalls"], [1, 1]);
assert.deepEqual(result["appliedSeq"], 1);
assert.ok(contains("remote-play-intent", result["startupEvents"]));
},
async test_unknown_duration_keeps_absolute_seek_target_until_metadata_arrives() {
let result, source;
source = (await this._slice("function clampMediaTime", "function setMediaCurrentTime"));
result = (await this.run_node("console.log(JSON.stringify([0, NaN, 120].map(duration => clampMediaTime({duration}, 150))));", "", source));
assert.deepEqual(result, [150, 150, 120]);
},
async test_remote_program_relative_commands_reject_stale_same_id_programs_once() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
const video = new FakeMedia(20); const audio = new FakeMedia(20);
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.data = { playback_generation: 12, state_revision: 1 };
state.hostPlaybackSession.playbackGeneration = 12;
const currentItem = { id: "same-song" };

applyRemotePlayerControl(
  { seq: 1, action: "seek-relative", item_id: "same-song", delta_seconds: 15,
    playback_generation: 11 },
  currentItem,
  "local",
);
video.duration = 0;
applyRemotePlayerControl(
  { seq: 2, action: "seek-relative", item_id: "same-song", delta_seconds: 15,
    playback_generation: 12 },
  currentItem,
  "local",
);
state.data.state_revision = 99;
applyRemotePlayerControl(
  { seq: 3, action: "seek-absolute", item_id: "same-song", target_seconds: 80,
    playback_generation: 12 },
  currentItem,
  "local",
);
state.data = { playback_generation: 13, state_revision: 100 };
state.hostPlaybackSession.playbackGeneration = 13;
applyRemotePlayerControl(
  { seq: 4, action: "toggle-play", item_id: "same-song", playback_generation: 12 },
  currentItem,
  "local",
);
applyRemotePlayerControl(
  { seq: 5, action: "next-track", item_id: "same-song", playback_generation: 12 },
  currentItem,
  "local",
);
applyRemotePlayerControl(
  { seq: 6, action: "next-track", item_id: "same-song", playback_generation: 13 },
  currentItem,
  "local",
);
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  acknowledgements,
  seekTargets,
  nextGenerations,
  intentCalls,
  appliedSeq: state.lastAppliedPlayerControlSeq,
}));
`, `
const acknowledgements = [];
const seekTargets = [];
const nextGenerations = [];
let intentCalls = 0;
function ackRemotePlayerControl(seq) { acknowledgements.push(seq); }
function isTauriWebKitRuntime() { return false; }
function requestSplitPlaybackStart() { return false; }
function setSplitPlaybackIntent() { intentCalls += 1; return true; }
function beginSplitPlayerSeek(_video, _audio, options) {
  seekTargets.push(options.targetTime);
  options.onSettled(true);
  return true;
}
async function requestNextTrack(expectedPlaybackGeneration) {
  nextGenerations.push(expectedPlaybackGeneration);
  return true;
}
`, remote_control_source));
assert.deepEqual(result["acknowledgements"], [1, 2, 3, 4, 5, 6]);
assert.deepEqual(result["seekTargets"], [35, 80]);
assert.deepEqual(result["nextGenerations"], [13]);
assert.deepEqual(result["intentCalls"], 0);
assert.deepEqual(result["appliedSeq"], 6);
},
async test_tauri_webkit_host_manual_play_then_remote_toggle_uses_session_intent() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
const productionRequestStart = requestSplitPlaybackStart;
let startupRequestCalls = 0;
requestSplitPlaybackStart = (...args) => {
  startupRequestCalls += 1;
  return productionRequestStart(...args);
};

setSplitPlaybackIntent(video, audio, true, {
  source: "host-manual-play",
  userGesture: true,
});
await Promise.resolve(); await Promise.resolve();
const afterHostManualPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
};

applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
applyRemotePlayerControl(
  { seq: 2, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterHostManualPlay,
  afterPause,
  afterPlay: {
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
  },
  startupRequestCalls,
  appliedSeq: state.lastAppliedPlayerControlSeq,
}));
`, this.sync_source, `
function ackRemotePlayerControl() {}
`, remote_control_source));
assert.deepEqual(result["afterHostManualPlay"], {["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
assert.deepEqual(result["afterPause"], {["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true});
assert.deepEqual(result["afterPlay"], {["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 2, ["audioPlayCalls"]: 2});
assert.deepEqual(result["startupRequestCalls"], 0);
assert.deepEqual(result["appliedSeq"], 2);
},
async test_tauri_webkit_remote_toggle_recovers_an_active_auto_started_pair() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "starting";
state.localShouldBePlaying = true;

applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
const afterPause = {
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
applyRemotePlayerControl(
  { seq: 2, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterPause,
  afterPlay: {
    startState: state.localPlaybackStartState,
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
  },
}));
`, this.sync_source, `
function ackRemotePlayerControl() {}
`, remote_control_source));
assert.deepEqual(result["afterPause"], {["startState"]: "established", ["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true});
assert.deepEqual(result["afterPlay"], {["startState"]: "established", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
},
async test_tauri_webkit_remote_seek_uses_authoritative_playback_intent() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
function setRuntime(userAgent, tauri) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent }, configurable: true, writable: true,
  });
  if (tauri) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
}
function mountPair({ intent, videoPaused, audioPaused, startState }) {
  const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
  video.paused = videoPaused; audio.paused = audioPaused;
  mountedVideo = video; mountedAudio = audio;
  elements.playerFrame.querySelector = (selector) => {
    if (selector === "video") return video;
    if (selector === 'audio[data-player-role="audio"]') return audio;
    if (selector === ".split-playback-start-overlay") return mountedOverlay;
    return null;
  };
  state.localPlaybackStartState = startState;
  state.localShouldBePlaying = intent;
  return { video, audio };
}
async function seek(pair, seq) {
  applyRemotePlayerControl(
    { seq, action: "seek-relative", item_id: "item", delta_seconds: 15,
      playback_generation: 1 },
    { id: "item" },
    "local",
  );
  settleSplitPlayerSeek(pair.video, pair.audio, true);
  await Promise.resolve(); await Promise.resolve();
  return {
    startState: state.localPlaybackStartState,
    shouldPlay: state.localShouldBePlaying,
    videoPaused: pair.video.paused,
    audioPaused: pair.audio.paused,
    videoPlayCalls: pair.video.playCalls,
    audioPlayCalls: pair.audio.playCalls,
  };
}
state.lastAppliedPlayerControlSeq = 0;
setRuntime(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  true,
);
const playing = await seek(mountPair({
  intent: true, videoPaused: false, audioPaused: false, startState: "established",
}), 1);
const pausedWithNativeVideoEcho = await seek(mountPair({
  intent: false, videoPaused: false, audioPaused: true, startState: "established",
}), 2);
const autoStarted = await seek(mountPair({
  intent: true, videoPaused: false, audioPaused: false, startState: "starting",
}), 3);
const manuallyStartedPair = mountPair({
  intent: false, videoPaused: true, audioPaused: true, startState: "established",
});
setSplitPlaybackIntent(manuallyStartedPair.video, manuallyStartedPair.audio, true, {
  source: "host-manual-play",
  userGesture: true,
});
await Promise.resolve(); await Promise.resolve();
const manuallyStarted = await seek(manuallyStartedPair, 4);
setRuntime(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  false,
);
const chromiumNativeVideoEcho = await seek(mountPair({
  intent: false, videoPaused: false, audioPaused: true, startState: "established",
}), 5);
console.log(JSON.stringify({
  playing,
  pausedWithNativeVideoEcho,
  autoStarted,
  manuallyStarted,
  chromiumNativeVideoEcho,
}));
`, this.clear_seek_source, this.seek_lifecycle_source, this.sync_source, `
function ackRemotePlayerControl() {}
`, remote_control_source));
assert.deepEqual(result["playing"], {["startState"]: "established", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
assert.deepEqual(result["pausedWithNativeVideoEcho"], {["startState"]: "established", ["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true, ["videoPlayCalls"]: 0, ["audioPlayCalls"]: 0});
assert.deepEqual(result["autoStarted"], {["startState"]: "established", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
assert.deepEqual(result["manuallyStarted"], {["startState"]: "established", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 2, ["audioPlayCalls"]: 2});
assert.deepEqual(result["chromiumNativeVideoEcho"], {["startState"]: "established", ["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
},
async test_tauri_webkit_internal_pause_events_preserve_play_intent() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
global.document = { hidden: false };
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;

holdVideoForAudio(video);
videoPauseListener();
const afterSyncPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};

video.paused = false; audio.paused = false;
state.localShouldBePlaying = true;
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 45 });
videoPauseListener();
console.log(JSON.stringify({
  afterSyncPause,
  afterSeekPause: {
    shouldPlay: state.localShouldBePlaying,
    seekResumePending: state.hostPlaybackSession.seekResumePending,
    videoPaused: video.paused,
    audioPaused: audio.paused,
  },
}));
`, this.clear_seek_source, this.seek_lifecycle_source, this.sync_source, `
const currentItem = { id: "item" };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
let videoPauseListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (media === video && eventName === "pause") videoPauseListener = listener;
}
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
function synchronizeStartupPlayer() { return false; }
`, this.video_play_pause_event_source));
assert.deepEqual(result["afterSyncPause"], {["shouldPlay"]: true, ["videoPaused"]: true, ["audioPaused"]: false});
assert.deepEqual(result["afterSeekPause"], {["shouldPlay"]: true, ["seekResumePending"]: true, ["videoPaused"]: true, ["audioPaused"]: true});
},
async test_tauri_webkit_remote_policy_rejection_still_requires_host_gesture() {
let remote_control_source, result;
remote_control_source = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
video.play = function() {
  this.playCalls += 1;
  const error = new Error("Host WebView user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("Host WebView user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item", playback_generation: 1 },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, `
function ackRemotePlayerControl() {}
`, remote_control_source));
assert.deepEqual(result["startState"], "needs-user-gesture");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(hasContent(result["videoPaused"]));
assert.ok(hasContent(result["audioPaused"]));
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.ok(contains("video-playback-blocked", result["startupEvents"]));
},
async test_packaged_tauri_media_session_pause_and_play_follow_logical_intent() {
let result;
result = (await this.run_node(`
const handlers = {};
const positionStates = [];
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { handlers[action] = handler; },
  setPositionState(value) { positionStates.push(value); },
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(20); const audio = new FakeMedia(19.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.video = video;
state.hostPlaybackSession.audio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;
ensureTauriMediaSessionHandlers();

handlers.pause({});
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls,
  playbackState: mediaSession.playbackState,
};
const pausedTicks = [];
for (let index = 0; index < 5; index += 1) {
  pausedTicks.push(syncSplitPlayer(video, audio, 0.2, false));
}

handlers.play({});
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const afterPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  playbackState: mediaSession.playbackState,
};
const playingTicks = [];
for (let index = 0; index < 5; index += 1) {
  playingTicks.push(syncSplitPlayer(video, audio, 0.2, false));
}
console.log(JSON.stringify({
  registeredActions: Object.keys(handlers).sort(),
  afterPause,
  pausedTicks,
  afterPlay,
  playingTicks,
  finalVideoPlayCalls: video.playCalls,
  finalAudioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  positionStates,
}));
`, this.sync_source));
assert.deepEqual(result["registeredActions"], ["nexttrack", "pause", "play", "seekbackward", "seekforward", "seekto"]);
assert.deepEqual(result["afterPause"], {["shouldPlay"]: false, ["videoPaused"]: true, ["audioPaused"]: true, ["videoPauseCalls"]: 1, ["audioPauseCalls"]: 1, ["playbackState"]: "paused"});
assert.deepEqual(new Set((Symbol.iterator in Object(result["pausedTicks"]) ? result["pausedTicks"] : Object.keys(result["pausedTicks"]))), new Set(["pause"]));
assert.deepEqual(result["afterPlay"], {["shouldPlay"]: true, ["videoPaused"]: false, ["audioPaused"]: false, ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1, ["playbackState"]: "playing"});
assert.deepEqual(result["finalVideoPlayCalls"], 1);
assert.deepEqual(result["finalAudioPlayCalls"], 1);
assert.deepEqual(new Set((Symbol.iterator in Object(result["playingTicks"]) ? result["playingTicks"] : Object.keys(result["playingTicks"]))), new Set(["none"]));
assert.deepEqual(result["startupEvents"], ["media-session-pause", "media-session-play", "user-start-attempt", "user-start-video-play-resolved", "user-start-audio-play-resolved", "user-start-success"]);
},
async test_packaged_tauri_media_session_seeks_are_bounded_and_preserve_intent() {
let action, result;
result = (await this.run_node(`
const handlers = {};
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { handlers[action] = handler; },
  setPositionState() {},
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
ensureTauriMediaSessionHandlers();

function exercise(action, details, shouldPlay) {
  const video = new FakeMedia(50); const audio = new FakeMedia(49.8);
  mountedVideo = video; mountedAudio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = shouldPlay;
  video.paused = !shouldPlay;
  audio.paused = !shouldPlay;
  handlers[action](details);
  const initial = {
    videoWrites: video.seekWrites,
    audioWrites: audio.seekWrites,
    shouldPlay: state.localShouldBePlaying,
  };
  settleSplitPlayerSeek(video, audio, true);
  return {
    initial,
    finalVideoWrites: video.seekWrites,
    finalAudioWrites: audio.seekWrites,
    finalShouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
  };
}

const backward = exercise("seekbackward", { seekOffset: 10 }, true);
const forward = exercise("seekforward", { seekOffset: 10 }, false);
const absolute = exercise("seekto", { seekTime: 75 }, true);
console.log(JSON.stringify({ backward, forward, absolute,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName) }));
`, this.seek_lifecycle_source, this.sync_source, this.clear_seek_source));
for (const action of iterableValues(["backward", "forward", "absolute"])) {
{
assert.deepEqual(result[action]["initial"]["videoWrites"], 1);
assert.deepEqual(result[action]["initial"]["audioWrites"], 1);
assert.deepEqual(result[action]["finalVideoWrites"], 1);
assert.deepEqual(result[action]["finalAudioWrites"], 1);
}
}
assert.ok(hasContent(result["backward"]["finalShouldPlay"]));
assert.ok(!hasContent(result["backward"]["videoPaused"]));
assert.ok(!hasContent(result["backward"]["audioPaused"]));
assert.ok(!hasContent(result["forward"]["finalShouldPlay"]));
assert.ok(hasContent(result["forward"]["videoPaused"]));
assert.ok(hasContent(result["forward"]["audioPaused"]));
assert.ok(hasContent(result["absolute"]["finalShouldPlay"]));
assert.ok(Number(Math.abs(result["backward"]["videoTime"] - 40).toFixed(7)) === 0);
assert.ok(Number(Math.abs(result["forward"]["videoTime"] - 60).toFixed(7)) === 0);
assert.ok(Number(Math.abs(result["absolute"]["videoTime"] - 75).toFixed(7)) === 0);
assert.deepEqual(result["startupEvents"], ["media-session-seek-backward", "media-session-seek-forward", "media-session-seek-to"]);
},
async test_packaged_tauri_media_session_resolves_new_song_and_next_track_dynamically() {
let result;
result = (await this.run_node(`
const handlers = {};
let registrationCalls = 0;
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { registrationCalls += 1; handlers[action] = handler; },
  setPositionState() {},
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const oldVideo = new FakeMedia(30); const oldAudio = new FakeMedia(29.8);
oldVideo.paused = false; oldAudio.paused = false;
mountedVideo = oldVideo; mountedAudio = oldAudio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;
ensureTauriMediaSessionHandlers();
ensureTauriMediaSessionHandlers();

const newVideo = new FakeMedia(0); const newAudio = new FakeMedia(0);
mountedVideo = newVideo; mountedAudio = newAudio;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  newVideo,
  newAudio,
  () => false,
);
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
handlers.pause({});
handlers.nexttrack({});
await Promise.resolve();
console.log(JSON.stringify({
  registrationCalls,
  newStartState: state.localPlaybackStartState,
  newVideoPlayCalls: newVideo.playCalls,
  newAudioPlayCalls: newAudio.playCalls,
  oldVideoPauseCalls: oldVideo.pauseCalls,
  oldAudioPauseCalls: oldAudio.pauseCalls,
  newVideoPauseCalls: newVideo.pauseCalls,
  newAudioPauseCalls: newAudio.pauseCalls,
  nextTrackRequests,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result, {["registrationCalls"]: 6, ["newStartState"]: "established", ["newVideoPlayCalls"]: 1, ["newAudioPlayCalls"]: 1, ["oldVideoPauseCalls"]: 0, ["oldAudioPauseCalls"]: 0, ["newVideoPauseCalls"]: 1, ["newAudioPauseCalls"]: 1, ["nextTrackRequests"]: 1});
},
async test_media_session_ownership_is_packaged_tauri_webkit_only() {
let result;
result = (await this.run_node(`
function registrationCount(userAgent, tauriPresent) {
  let calls = 0;
  const mediaSession = {
    setActionHandler() { calls += 1; },
    setPositionState() {},
  };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent, mediaSession }, configurable: true, writable: true });
  if (tauriPresent) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
  state.tauriMediaSessionOwner = null;
  ensureTauriMediaSessionHandlers();
  ensureTauriMediaSessionHandlers();
  return calls;
}
const safari = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  false,
);
const chrome = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  true,
);
const webview2 = registrationCount(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  true,
);
const tauriWebKit = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  true,
);
console.log(JSON.stringify({ safari, chrome, webview2, tauriWebKit }));
`, this.sync_source));
assert.deepEqual(result, {["safari"]: 0, ["chrome"]: 0, ["webview2"]: 0, ["tauriWebKit"]: 6});
},
async test_packaged_tauri_media_session_position_uses_video_master_and_clears() {
let result;
result = (await this.run_node(`
const positionStates = [];
const mediaSession = {
  playbackState: "none",
  setActionHandler() {},
  setPositionState(value) { positionStates.push(value); },
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(33); const audio = new FakeMedia(12);
video.duration = 120; audio.duration = 118;
video.playbackRate = 1.25;
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.video = video;
state.hostPlaybackSession.audio = audio;
state.hostPlaybackSession.phase = "playing";
state.localShouldBePlaying = true;
syncTauriMediaSessionState(video, { forcePosition: true });
const playingState = mediaSession.playbackState;
video.paused = true; audio.paused = true;
state.hostPlaybackSession.phase = "paused";
state.localShouldBePlaying = false;
syncTauriMediaSessionState(video, { forcePosition: true });
const pausedState = mediaSession.playbackState;
mountedVideo = null; mountedAudio = null;
clearTauriMediaSessionState();
console.log(JSON.stringify({ playingState, pausedState,
  clearedState: mediaSession.playbackState, positionStates }));
`, this.sync_source));
assert.deepEqual(result["playingState"], "playing");
assert.deepEqual(result["pausedState"], "paused");
assert.deepEqual(result["clearedState"], "none");
assert.deepEqual(result["positionStates"], [{["duration"]: 120, ["position"]: 33, ["playbackRate"]: 1.25}, {["duration"]: 120, ["position"]: 33, ["playbackRate"]: 1.25}, {}]);
},
async test_user_gesture_state_is_only_requested_from_policy_rejections() {
let best_effort, remote_control, startup_attempt, toggle_source, video_listener;
video_listener = this.video_play_event_source;
toggle_source = (await this._slice("function toggleMountedLocalPlayback", "function queuePlayerFrameSingleClick"));
remote_control = (await this._slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
assert.ok(!contains("requireSplitPlaybackUserGesture", video_listener));
assert.ok(!contains("requireSplitPlaybackUserGesture", toggle_source));
assert.ok(!contains("requireSplitPlaybackUserGesture", remote_control));
assert.deepEqual(countOccurrences(this.source, "requireSplitPlaybackUserGesture("), 4);
startup_attempt = (await this._slice("function startSplitPlaybackPair", "function playMediaBestEffort"));
best_effort = (await this._slice("function playMediaBestEffort", "function seekVideoForNavigation"));
assert.deepEqual(countOccurrences(startup_attempt, "requireSplitPlaybackUserGesture("), 2);
assert.ok(countOccurrences(startup_attempt, "isPlaybackPolicyRejection") >= 3);
assert.deepEqual(countOccurrences(best_effort, "requireSplitPlaybackUserGesture("), 1);
assert.ok(contains("isPlaybackPolicyRejection(error)", best_effort));
},
async test_startup_misalignment_is_one_audio_write_and_zero_video_writes() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
state.localPlaybackStartState = "pending";
effectiveOffsetSeconds = 0.2;
const forceCalls = [];
const originalSyncSplitPlayer = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  forceCalls.push(Boolean(args[3]));
  return originalSyncSplitPlayer(...args);
};
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
const handleReadiness = () => {
  if (!synchronizeStartupPlayer()) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), state.localVideoDeferredRecovery);
  }
};
synchronizeStartupPlayer();
video.readyState = 4;
handleReadiness();
audio.readyState = 4;
handleReadiness();
handleReadiness();
handleReadiness();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
console.log(JSON.stringify({ forceCalls, actions,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls,
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
`, this.sync_source, this.startup_source));
assert.deepEqual(countOccurrences(result["forceCalls"], true), 1);
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.deepEqual(result["startState"], "established");
assert.ok(contains("autoplay-success", result["actions"]));
assert.deepEqual(result["videoTime"], 2);
assert.ok(Number(Math.abs(result["audioTime"] - 1.8).toFixed(7)) === 0);
assert.deepEqual(result["videoSeekWrites"], 0);
assert.deepEqual(result["audioSeekWrites"], 1);
},
async test_video_autoplay_policy_rejection_requires_one_user_gesture() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localPlaybackStartState = "pending";
video.play = function() {
  this.playCalls += 1;
  const error = new Error("user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  overlayHidden: mountedOverlay.hidden,
  actions,
}));
`, this.sync_source));
assert.deepEqual(result["startState"], "needs-user-gesture");
assert.ok(!hasContent(result["shouldPlay"]));
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.ok(hasContent(result["videoPaused"]));
assert.ok(hasContent(result["audioPaused"]));
assert.ok(!hasContent(result["overlayHidden"]));
assert.ok(contains("autoplay-video-blocked", result["actions"]));
assert.ok(contains("user-start-required", result["actions"]));
},
async test_audio_autoplay_policy_rejection_requires_one_user_gesture() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  actions,
}));
`, this.sync_source));
assert.deepEqual(result["startState"], "needs-user-gesture");
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["audioPlayCalls"], 1);
assert.ok(contains("autoplay-audio-blocked", result["actions"]));
},
async test_webkit_startup_records_video_and_audio_play_rejections_separately() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
video.play = function() {
  this.playCalls += 1;
  const error = new Error("video policy rejection");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("audio pipeline aborted");
  error.name = "AbortError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, playRejections }));
`, this.sync_source));
assert.deepEqual(result["startState"], "needs-user-gesture");
assert.deepEqual(result["playRejections"], [{["mediaKind"]: "video", ["eventName"]: "autoplay-video-play-rejected", ["errorName"]: "NotAllowedError", ["errorMessage"]: "video policy rejection"}, {["mediaKind"]: "audio", ["eventName"]: "autoplay-audio-play-rejected", ["errorName"]: "AbortError", ["errorMessage"]: "audio pipeline aborted"}]);
},
async test_application_start_invokes_both_media_plays_in_same_click_stack() {
let overlay_source, result;
result = (await this.run_node(`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
let insideClickHandler = false;
const activationObservations = [];
video.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["video", insideClickHandler]);
  return Promise.resolve();
};
audio.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["audio", insideClickHandler]);
  return Promise.resolve();
};
insideClickHandler = true;
startSplitPlaybackPair(video, audio, { userGesture: true });
insideClickHandler = false;
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  activationObservations,
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  actions,
}));
`, this.sync_source));
assert.deepEqual(result["activationObservations"], [["video", true], ["audio", true]]);
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.ok(contains("user-start-success", result["actions"]));
overlay_source = (await this._slice("function createSplitPlaybackStartOverlay", "function playMediaBestEffort"));
assert.ok(contains("button.addEventListener(\"click\"", overlay_source));
assert.ok(contains("requestSplitPlaybackStartFromUserGesture(video, audio, \"overlay-start-intent\")", overlay_source));
},
async test_user_start_issues_both_play_calls_even_when_ready_state_below_2() {
let audio_ready, result, video_ready;
for (const [video_ready, audio_ready] of iterableValues([[1, 4], [4, 1], [1, 1]])) {
{
result = (await this.run_node((`
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = ` + String(video_ready) + "; audio.readyState = " + String(audio_ready) + `;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
const started = startSplitPlaybackPair(video, audio, {userGesture: true});
const playCalls = [video.playCalls, audio.playCalls];
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  started,
  playCalls,
  startState: state.localPlaybackStartState,
}));
`), this.sync_source));
assert.ok(hasContent(result["started"]));
assert.deepEqual(result["playCalls"], [1, 1]);
assert.deepEqual(result["startState"], "established");
}
}
},
async test_pending_without_play_attempt_times_out_to_manual_recovery() {
let result;
result = (await this.run_node(`
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 0; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
setSplitPlaybackStartState("pending", video, audio);
const scheduledWatchdogs = watchdogCallbacks.size;
const callback = [...watchdogCallbacks.values()][0];
watchdogCallbacks.clear();
callback();
console.log(JSON.stringify({
  scheduledWatchdogs,
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  playCalls: [video.playCalls, audio.playCalls],
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source));
assert.deepEqual(result["scheduledWatchdogs"], 1);
assert.deepEqual(result["startState"], "startup-failed");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(!hasContent(result["overlayHidden"]));
assert.deepEqual(result["playCalls"], [0, 0]);
assert.ok(contains("startup-timeout-before-play-attempt", result["startupEvents"]));
},
async test_unsettled_play_promises_time_out_without_retry_storm() {
let result;
result = (await this.run_node(`
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localPlaybackStartState = "needs-user-gesture";
video.play = function() {
  this.playCalls += 1;
  return new Promise(() => {}); // never resolves
};
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {}); // never resolves
};
startSplitPlaybackPair(video, audio, { userGesture: true });
const startStateAfterClick = state.localPlaybackStartState;
const callsAfterClick = [video.playCalls, audio.playCalls];
const tickActions = [];
for (let index = 0; index < 5; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
const callback = [...watchdogCallbacks.values()][0];
watchdogCallbacks.clear();
callback();
console.log(JSON.stringify({
  startStateAfterClick,
  finalState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  callsAfterClick,
  tickActions,
  finalCalls: [video.playCalls, audio.playCalls],
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source));
assert.deepEqual(result["startStateAfterClick"], "starting");
assert.deepEqual(result["finalState"], "startup-failed");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(!hasContent(result["overlayHidden"]));
assert.deepEqual(result["callsAfterClick"], [1, 1]);
assert.deepEqual(new Set((Symbol.iterator in Object(result["tickActions"]) ? result["tickActions"] : Object.keys(result["tickActions"]))), new Set(["startup-pending"]));
assert.deepEqual(result["finalCalls"], [1, 1]);
assert.ok(contains("startup-play-promise-timeout", result["startupEvents"]));
},
async test_resolved_playing_pair_establishes_and_cancels_watchdog() {
let result;
result = (await this.run_node(`
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
let watchdogClearCalls = 0;
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (watchdogCallbacks.delete(token)) {
    watchdogClearCalls += 1;
  } else {
    nativeClearTimeout(token);
  }
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  activeWatchdogs: watchdogCallbacks.size,
  watchdogClearCalls,
}));
`, this.sync_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.ok(!hasContent(result["videoPaused"]));
assert.ok(!hasContent(result["audioPaused"]));
assert.deepEqual(result["activeWatchdogs"], 0);
assert.deepEqual(result["watchdogClearCalls"], 1);
},
async test_stale_pending_watchdog_cannot_fail_newer_start_generation() {
let result;
result = (await this.run_node(`
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
video.play = function() { this.playCalls += 1; return new Promise(() => {}); };
audio.play = function() { this.playCalls += 1; return new Promise(() => {}); };
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
setSplitPlaybackStartState("pending", video, audio);
const staleWatchdog = [...watchdogCallbacks.values()][0];
state.hostPlaybackSession.readyCommitted = true;
state.hostPlaybackSession.phase = "ready-paused";
startSplitPlaybackPair(video, audio);
const activeWatchdogsBeforeStaleCallback = watchdogCallbacks.size;
staleWatchdog();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  generation: state.localPlaybackStartGeneration,
  activeWatchdogsBeforeStaleCallback,
  activeWatchdogsAfterStaleCallback: watchdogCallbacks.size,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source));
assert.deepEqual(result["startState"], "starting");
assert.deepEqual(result["generation"], 1);
assert.deepEqual(result["activeWatchdogsBeforeStaleCallback"], 1);
assert.deepEqual(result["activeWatchdogsAfterStaleCallback"], 1);
assert.ok(!contains("startup-failed", result["startupEvents"]));
},
async test_retired_webkit_retry_and_watchdog_cannot_start_or_fail_current_pair() {
let result;
result = (await this.run_node(`
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const scheduled = [];
window.setTimeout = (callback, delay) => {
  const timer = { callback, delay, id: scheduled.length + 1 };
  scheduled.push(timer);
  return timer;
};
window.clearTimeout = () => {};
let currentVideo = null;
let currentAudio = null;
isActiveSplitPlayer = (video, audio) => video === currentVideo && audio === currentAudio;
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });

const oldVideo = new FakeMedia(0); const oldAudio = new FakeMedia(0);
oldVideo.readyState = 2; oldAudio.readyState = 2;
currentVideo = oldVideo; currentAudio = oldAudio;
mountedVideo = oldVideo; mountedAudio = oldAudio;
const oldSession = {
  eventCleanups: [], phase: "binding", readyCommitted: true,
  loadingStarted: true, ownershipClaimed: true,
  logicalPlayIntent: true, initialIntentApplied: true,
};
state.hostPlaybackSession = oldSession;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
oldSession.phase = "binding";
scheduleSplitPlaybackStartupWatchdog(oldVideo, oldAudio);
scheduleWebKitSplitPlaybackRetry(oldVideo, oldAudio, { userGesture: false, prefix: "old" });
const oldWatchdog = oldSession.startupWatchdogTimer;
const oldRetry = oldSession.webkitRetryTimer;

const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
currentVideo = video; currentAudio = audio;
mountedVideo = video; mountedAudio = audio;
const currentSession = {
  eventCleanups: [], phase: "binding", readyCommitted: true,
  loadingStarted: true, ownershipClaimed: true,
  logicalPlayIntent: true, initialIntentApplied: true,
};
state.hostPlaybackSession = currentSession;
oldSession.startupWatchdogTimer = null;
oldSession.webkitRetryTimer = null;
state.localPlaybackStartState = "pending";
currentSession.phase = "binding";
state.localShouldBePlaying = true;
scheduleSplitPlaybackStartupWatchdog(video, audio);
scheduleWebKitSplitPlaybackRetry(video, audio, { userGesture: false, prefix: "current" });
const currentWatchdog = currentSession.startupWatchdogTimer;
const currentRetry = currentSession.webkitRetryTimer;

oldWatchdog.callback();
oldRetry.callback();
const afterRetired = {
  state: state.localPlaybackStartState,
  playCalls: [video.playCalls, audio.playCalls],
  watchdogPreserved: currentSession.startupWatchdogTimer === currentWatchdog,
  retryPreserved: currentSession.webkitRetryTimer === currentRetry,
};
currentRetry.callback();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
window.setTimeout = nativeSetTimeout;
window.clearTimeout = nativeClearTimeout;
console.log(JSON.stringify({
  afterRetired,
  current: {
    state: state.localPlaybackStartState,
    playCalls: [video.playCalls, audio.playCalls],
  },
}));
`, this.sync_source));
assert.deepEqual(result["afterRetired"], {["state"]: "pending", ["playCalls"]: [0, 0], ["watchdogPreserved"]: true, ["retryPreserved"]: true});
assert.deepEqual(result["current"], {["state"]: "established", ["playCalls"]: [1, 1]});
},
async test_superseded_startup_promises_cannot_establish_newer_attempt() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
const videoResolvers = [];
const audioResolvers = [];
video.play = function() {
  this.playCalls += 1;
  return new Promise((resolve) => {
    videoResolvers.push(() => { this.paused = false; resolve(); });
  });
};
audio.play = function() {
  this.playCalls += 1;
  return new Promise((resolve) => {
    audioResolvers.push(() => { this.paused = false; resolve(); });
  });
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
const firstGeneration = state.localPlaybackStartGeneration;

state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
const secondGeneration = state.localPlaybackStartGeneration;

videoResolvers[0](); audioResolvers[0]();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const afterStaleResolution = state.localPlaybackStartState;

videoResolvers[1](); audioResolvers[1]();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  firstGeneration,
  secondGeneration,
  afterStaleResolution,
  finalState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["firstGeneration"], 1);
assert.deepEqual(result["secondGeneration"], 2);
assert.deepEqual(result["afterStaleResolution"], "starting");
assert.deepEqual(result["finalState"], "established");
assert.deepEqual(result["videoPlayCalls"], 2);
assert.deepEqual(result["audioPlayCalls"], 2);
},
async test_retired_play_promise_completion_is_silent_and_current_attempt_still_settles() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
let currentVideo = null;
let currentAudio = null;
isActiveSplitPlayer = (video, audio) => video === currentVideo && audio === currentAudio;

const oldVideo = new FakeMedia(0); const oldAudio = new FakeMedia(0);
const oldSettlers = [];
oldVideo.play = function() {
  this.playCalls += 1;
  return new Promise((resolve) => oldSettlers.push(() => resolve()));
};
oldAudio.play = function() {
  this.playCalls += 1;
  return new Promise((_resolve, reject) => oldSettlers.push(() => {
    const error = new Error("old policy rejection");
    error.name = "NotAllowedError";
    reject(error);
  }));
};
currentVideo = oldVideo; currentAudio = oldAudio;
mountedVideo = oldVideo; mountedAudio = oldAudio;
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(oldVideo, oldAudio);

const newVideo = new FakeMedia(0); const newAudio = new FakeMedia(0);
currentVideo = newVideo; currentAudio = newAudio;
mountedVideo = newVideo; mountedAudio = newAudio;
effectiveOffsetSeconds = 0;
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
startSplitPlaybackPair(newVideo, newAudio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const currentStateBeforeOld = state.localPlaybackStartState;
const postsBeforeOld = diagnosticPosts.length;

oldSettlers.forEach((settle) => settle());
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const stalePosts = diagnosticPosts.slice(postsBeforeOld).filter(
  (entry) => entry.payload?.item_id === "item",
).length;
console.log(JSON.stringify({
  currentStateBeforeOld,
  currentStateAfterOld: state.localPlaybackStartState,
  currentVideoPaused: newVideo.paused,
  currentAudioPaused: newAudio.paused,
  stalePosts,
}));
`, this.diagnostic_source, this.sync_source));
assert.deepEqual(result, {["currentStateBeforeOld"]: "established", ["currentStateAfterOld"]: "established", ["currentVideoPaused"]: false, ["currentAudioPaused"]: false, ["stalePosts"]: 0});
},
async test_native_controls_are_unavailable_until_split_start_is_established() {
let controls_source, result;
controls_source = (await this._slice("function clearLocalPlayerControlsHideTimer", "function toggleMountedLocalPlayback"));
result = (await this.run_node(`
const video = new FakeMedia(0);
const attributes = new Set();
video.controls = false;
video.setAttribute = (name) => attributes.add(name);
video.removeAttribute = (name) => attributes.delete(name);
const audio = {};
mountedVideo = video;
mountedAudio = audio;
state.localPlaybackStartState = "pending";
revealMountedPlayerControlsForUserInteraction();
const pending = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "starting";
revealMountedPlayerControlsForUserInteraction();
const starting = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "established";
revealMountedPlayerControlsForUserInteraction();
const established = { controls: video.controls, hasAttribute: attributes.has("controls") };
console.log(JSON.stringify({ pending, starting, established }));
`, controls_source, `
function mountedLocalVideoElement() { return mountedVideo; }
function fullscreenElement() { return null; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
window.setTimeout = () => ({ timer: "controls" });
window.clearTimeout = () => {};
`));
assert.deepEqual(result, {["pending"]: {["controls"]: false, ["hasAttribute"]: false}, ["starting"]: {["controls"]: false, ["hasAttribute"]: false}, ["established"]: {["controls"]: true, ["hasAttribute"]: true}});
},
async test_player_surface_interactions_reveal_controls_only_after_startup_and_hide_on_leave() {
let controls_source, interaction_source, result;
controls_source = (await this._slice("function clearLocalPlayerControlsHideTimer", "function toggleMountedLocalPlayback"));
interaction_source = (await this._slice("  [\"pointerenter\", \"pointermove\", \"pointerdown\", \"touchstart\", \"focus\"].forEach", "  addMountedPlayerListener(video, \"ended\","));
result = (await this.run_node(`
const attributes = new Set();
const video = new FakeMedia(0);
video.controls = false;
video.setAttribute = (name) => attributes.add(name);
video.removeAttribute = (name) => attributes.delete(name);
mountedVideo = video;
mountedAudio = {};
registerPlayerSurfaceInteractions(video);

state.localPlaybackStartState = "established";
video.dispatchMediaEvent("pointerenter");
const entered = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
const left = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointermove");
const moved = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
video.dispatchMediaEvent("touchstart");
const touched = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
video.dispatchMediaEvent("focus");
const focused = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "pending";
video.dispatchMediaEvent("pointermove");
const pending = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "starting";
video.dispatchMediaEvent("touchstart");
const starting = { controls: video.controls, hasAttribute: attributes.has("controls") };
console.log(JSON.stringify({ entered, left, moved, touched, focused, pending, starting }));
`, controls_source, concatenate(concatenate(`
function mountedLocalVideoElement() { return mountedVideo; }
function fullscreenElement() { return null; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
window.setTimeout = () => ({ timer: "controls" });
window.clearTimeout = () => {};
function registerPlayerSurfaceInteractions(video) {
`, interaction_source), `
}
`)));
assert.deepEqual(result, {["entered"]: {["controls"]: true, ["hasAttribute"]: true}, ["left"]: {["controls"]: false, ["hasAttribute"]: false}, ["moved"]: {["controls"]: true, ["hasAttribute"]: true}, ["touched"]: {["controls"]: true, ["hasAttribute"]: true}, ["focused"]: {["controls"]: true, ["hasAttribute"]: true}, ["pending"]: {["controls"]: false, ["hasAttribute"]: false}, ["starting"]: {["controls"]: false, ["hasAttribute"]: false}});
},
async test_stale_controls_hide_callback_cannot_mutate_a_replacement_video() {
let controls_source, result;
controls_source = (await this._slice("function clearLocalPlayerControlsHideTimer", "function toggleMountedLocalPlayback"));
result = (await this.run_node(`
const scheduled = [];
window.setTimeout = (callback) => {
  const timer = { id: scheduled.length + 1 };
  scheduled.push({ timer, callback });
  return timer;
};
window.clearTimeout = () => {};
function makeVideo() {
  const video = new FakeMedia(0);
  const attributes = new Set();
  video.controls = false;
  video.setAttribute = (name) => attributes.add(name);
  video.removeAttribute = (name) => attributes.delete(name);
  video.hasControlsAttribute = () => attributes.has("controls");
  return video;
}
const oldVideo = makeVideo();
mountedVideo = oldVideo;
mountedAudio = {};
state.localPlaybackStartState = "established";
revealMountedPlayerControlsForUserInteraction();

const replacement = makeVideo();
mountedVideo = replacement;
revealMountedPlayerControlsForUserInteraction();
scheduled[0].callback();
const afterStale = {
  controls: replacement.controls,
  hasAttribute: replacement.hasControlsAttribute(),
  activeTimer: scheduled.indexOf(scheduled.find((entry) => entry.timer === state.localPlayerControlsHideTimer)),
};
scheduled[1].callback();
const afterCurrent = {
  controls: replacement.controls,
  hasAttribute: replacement.hasControlsAttribute(),
};
console.log(JSON.stringify({ afterStale, afterCurrent }));
`, controls_source, `
function mountedLocalVideoElement() { return mountedVideo; }
function fullscreenElement() { return null; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
`));
assert.deepEqual(result, {["afterStale"]: {["controls"]: true, ["hasAttribute"]: true, ["activeTimer"]: 1}, ["afterCurrent"]: {["controls"]: false, ["hasAttribute"]: false}});
},
async test_retired_sync_start_and_starvation_callbacks_preserve_current_timers() {
let result;
result = (await this.run_node_script((`
const effects = [];
const timeouts = [];
const intervals = [];
const window = {
  setTimeout(callback, delay) {
    const timer = { type: "timeout", id: timeouts.length + 1, callback, delay };
    timeouts.push(timer);
    return timer;
  },
  clearTimeout() {},
  setInterval(callback, delay) {
    const timer = { type: "interval", id: intervals.length + 1, callback, delay };
    intervals.push(timer);
    return timer;
  },
  clearInterval() {},
};
const programA = { item_id: "A" };
const programB = { item_id: "B" };
const state = {
  data: { playback_generation: 1, playback_program: programA },
  hostPlaybackSession: null,
  localAudioPlaybackBlocked: false,
  localVideoDeferredRecovery: false,
  localPlayerSyncTimer: null,
  localPlayerStartupTimer: null,
  webKitAudioStarvationTimer: null,
};
function makeSession(generation, program, video, audio) {
  return {
    playbackGeneration: generation,
    playbackProgram: program,
    phase: "playing",
    video,
    audio,
    syncTimer: null,
    startupTimer: null,
    audioStarvationTimer: null,
  };
}
class Media {
  constructor(itemId) {
    this.dataset = { playerItemId: itemId };
    this.listeners = new Map();
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { this.listeners.get(name)?.(); }
}
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session?.phase !== "retiring"
    && session?.phase !== "retired"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && session.video === video
    && session.audio === audio;
}
function isActiveSplitPlayer(video, audio) {
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}
function addMountedPlayerListener(media, name, listener) { media.addEventListener(name, listener); }
function isWebKitPlaybackRuntime() { return true; }
function isSplitPlayerSeekSettling() { return false; }
function settleSplitPlayerSeek() { effects.push("settle"); }
function syncSplitPlayer(video) { effects.push(\`sync:\${video.dataset.playerItemId}\`); }
function maybeShowRatingPromptForProgress(item) { effects.push(\`rating:\${item.id}\`); }
async function handleSplitAudioEnded() { effects.push("ended"); }
function currentAvOffsetSeconds() { return 0; }
function scheduleSplitPlaybackStartupWatchdog() {}
function beginHostPlaybackSessionElementLoading() { return true; }
function beginHostPlaybackSessionOwnershipClaim() {
  return beginHostPlaybackSessionElementLoading();
}
function failHostPlaybackCandidate() { return false; }
const localPlayerSyncIntervalMs = 120;
` + String(this.webkit_timer_source) + `
function registerRendererTail(session, currentItem, video, audio) {
  const reportCurrentVideoStatus = () => effects.push(\`status:\${currentItem.id}\`);
  const synchronizeStartupPlayer = () => { effects.push(\`start:\${currentItem.id}\`); return true; };
` + String(this.renderer_tail_source) + `

const videoA = new Media("A"); const audioA = new Media("A");
const sessionA = makeSession(1, programA, videoA, audioA);
state.hostPlaybackSession = sessionA;
registerRendererTail(sessionA, { id: "A" }, videoA, audioA);
const aStartup = timeouts.find((timer) => timer.delay === 0);
const aSync = intervals[0];
audioA.dispatch("waiting");
const aStarvation = timeouts.find((timer) => timer.delay === 200);

const videoB = new Media("B"); const audioB = new Media("B");
const sessionB = makeSession(2, programB, videoB, audioB);
sessionA.phase = "retired";
sessionA.startupTimer = null;
sessionA.syncTimer = null;
sessionA.audioStarvationTimer = null;
state.data = { playback_generation: 2, playback_program: programB };
state.hostPlaybackSession = sessionB;
registerRendererTail(sessionB, { id: "B" }, videoB, audioB);
const bStartup = [...timeouts].reverse().find((timer) => timer.delay === 0);
const bSync = intervals[1];
audioB.dispatch("waiting");
const bStarvation = [...timeouts].reverse().find((timer) => timer.delay === 200);
const activeStartup = () => sessionB.startupTimer;
const activeStarvation = () => sessionB.audioStarvationTimer;

aStartup.callback();
aSync.callback();
aStarvation.callback();
const afterRetired = {
  effects: [...effects],
  startupPreserved: activeStartup() === bStartup,
  starvationPreserved: activeStarvation() === bStarvation,
};

bStartup.callback();
bSync.callback();
bStarvation.callback();
console.log(JSON.stringify({
  afterRetired,
  currentEffects: effects,
  currentStartupCleared: !activeStartup(),
  currentStarvationCleared: !activeStarvation(),
}));
`)));
assert.deepEqual(result["afterRetired"], {["effects"]: [], ["startupPreserved"]: true, ["starvationPreserved"]: true});
assert.ok(!contains("start:A", result["currentEffects"]));
assert.ok(!contains("sync:A", result["currentEffects"]));
assert.ok(contains("start:B", result["currentEffects"]));
assert.ok(countOccurrences(result["currentEffects"], "sync:B") >= 2);
assert.ok(hasContent(result["currentStartupCleared"]));
assert.ok(hasContent(result["currentStarvationCleared"]));
},
async test_retired_hidden_pause_and_delayed_click_callbacks_do_not_touch_current_pair() {
let result;
result = (await this.run_node_script((`
const effects = [];
const timers = [];
const window = {
  setTimeout(callback, delay) {
    const timer = { id: timers.length + 1, callback, delay };
    timers.push(timer);
    return timer;
  },
  clearTimeout() {},
};
const document = { hidden: true };
const programA = { item_id: "A" };
const programB = { item_id: "B" };
const state = {
  data: { playback_generation: 1, playback_program: programA, current_item: { id: "A" } },
  hostPlaybackSession: null,
  localShouldBePlaying: true,
  localSeekResumePending: false,
  playerFrameClickTimer: null,
};
function media(itemId) {
  return {
    dataset: { playerItemId: itemId },
    ended: false,
    paused: true,
    listeners: new Map(),
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    dispatch(name) { this.listeners.get(name)?.(); },
  };
}
function makeSession(generation, program, video, audio) {
  return {
    playbackGeneration: generation,
    playbackProgram: program,
    phase: "playing",
    video,
    audio,
    hiddenPauseTimer: null,
    frameClickTimer: null,
  };
}
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && session.video === video
    && session.audio === audio;
}
function addMountedPlayerListener(target, name, listener) { target.addEventListener(name, listener); }
function shouldHoldCurrentItemForTransition() { return false; }
function syncSplitPlayer(video) { effects.push(\`hidden-sync:\${video.dataset.playerItemId}\`); }
function isAndroidNativePlaybackRuntime() { return false; }
function currentAvOffsetSeconds() { return 0; }
function setSplitPlaybackIntent() { effects.push("intent"); }
function registerPause(session, currentItem, video, audio) {
  const reportCurrentVideoStatus = () => effects.push(\`status:\${currentItem.id}\`);
` + String(this.pause_event_source) + `
}
function presentationCompositionActive() { return false; }
function frontendPlaybackMode() { return "local"; }
function isLocalAdvanceHoldingItem() { return false; }
function activePrimaryVideoElement() { return state.hostPlaybackSession?.video || null; }
function activeLocalPlayerElements() {
  const current = state.hostPlaybackSession;
  return { video: current?.video || null, audio: current?.audio || null };
}
function requestSplitPlaybackStartFromUserGesture() { return false; }
function setSplitPlaybackIntent() { return true; }
function currentAvOffsetSeconds() { return 0; }
function canTogglePlayerFullscreen() { return false; }
function togglePlayerFullscreen() { return Promise.resolve(); }
function renderPlayerFullscreenButton() {}
const playerClickDelayMs = 220;
` + String(this.frame_click_source) + `
toggleMountedLocalPlayback = () => {
  effects.push(\`click:\${state.hostPlaybackSession?.video?.dataset?.playerItemId || ""}\`);
  return true;
};

const videoA = media("A"); const audioA = media("A");
const sessionA = makeSession(1, programA, videoA, audioA);
state.hostPlaybackSession = sessionA;
registerPause(sessionA, { id: "A" }, videoA, audioA);
videoA.dispatch("pause");
const aPauseTimer = timers[timers.length - 1];
queuePlayerFrameSingleClick();
const aClickTimer = timers[timers.length - 1];

const videoB = media("B"); const audioB = media("B");
const sessionB = makeSession(2, programB, videoB, audioB);
sessionA.phase = "retired";
sessionA.hiddenPauseTimer = null;
sessionA.frameClickTimer = null;
state.data = { playback_generation: 2, playback_program: programB, current_item: { id: "B" } };
state.hostPlaybackSession = sessionB;
registerPause(sessionB, { id: "B" }, videoB, audioB);
videoB.dispatch("pause");
const bPauseTimer = timers[timers.length - 1];
queuePlayerFrameSingleClick();
const bClickTimer = timers[timers.length - 1];
const activePause = () => sessionB.hiddenPauseTimer;
const activeClick = () => sessionB.frameClickTimer;

aPauseTimer.callback();
aClickTimer.callback();
const afterRetired = {
  effects: [...effects],
  pausePreserved: activePause() === bPauseTimer,
  clickPreserved: activeClick() === bClickTimer,
};
bPauseTimer.callback();
bClickTimer.callback();
console.log(JSON.stringify({ afterRetired, effects }));
`)));
assert.deepEqual(result["afterRetired"], {["effects"]: [], ["pausePreserved"]: true, ["clickPreserved"]: true});
assert.deepEqual(result["effects"], ["hidden-sync:B", "click:B"]);
},
async test_automatic_player_lifecycle_never_requests_native_control_visibility() {
let automatic_renderer, automatic_sources, mount, renderer, source, teardown;
renderer = (await this._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl"));
automatic_renderer = renderer.slice(0, sourceIndex(renderer, "  [\"pointerenter\", \"pointermove\", \"pointerdown\", \"touchstart\", \"focus\"].forEach"));
automatic_sources = [automatic_renderer, (await this._slice("function mountHostPlaybackSessionElements", "function reconcileHostPlaybackSession")), (await this._slice("function showSongTransitionOverlayForData", "function maybeShowSongTransitionOverlay")), (await this._slice("async function handleSplitVideoEnded", "function holdVideoForAudio")), (await this._slice("function requireSplitPlaybackUserGesture", "function setSplitPlaybackIntent")), (await this._slice("function failSplitPlaybackStartup", "function scheduleWebKitSplitPlaybackRetry")), (await this._slice("function startSplitPlaybackPair", "function playMediaBestEffort")), (await this._slice("document.addEventListener(\"visibilitychange\",", "function handleFullscreenChange")), (await this._slice("window.addEventListener(\"pageshow\",", "startPolling();"))];
mount = automatic_sources[1];
assert.ok(contains("video.controls = false", mount));
assert.ok(contains("video.removeAttribute(\"controls\")", mount));
assert.ok(contains("video.tabIndex = 0", mount));
assert.ok(!contains("showMountedPlayerControls", this.source));
assert.deepEqual(countOccurrences(this.source, "revealMountedPlayerControlsForUserInteraction"), 7);
for (const source of iterableValues(automatic_sources)) {
assert.ok(!contains("revealMountedPlayerControlsForUserInteraction", source));
}
teardown = (await this._slice("function retireHostPlaybackSession", "function replaceHostPlayerView"));
assert.ok(contains("clearLocalPlayerControlsHideTimer()", teardown));
},
async test_policy_rejection_stops_periodic_play_retry_storm() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(5); const audio = new FakeMedia(5);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
state.localShouldBePlaying = false;
const tickActions = [];
for (let index = 0; index < 12; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  tickActions,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
`, this.sync_source));
assert.deepEqual(new Set((Symbol.iterator in Object(result["tickActions"]) ? result["tickActions"] : Object.keys(result["tickActions"]))), new Set(["user-start-required"]));
assert.deepEqual(result["videoPlayCalls"], 0);
assert.deepEqual(result["audioPlayCalls"], 0);
},
async test_established_starvation_hold_and_recovery_still_work() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10); const audio = new FakeMedia(10);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
audio.readyState = 2;
state.localPlaybackStartState = "established";
state.localAudioPlaybackBlocked = true;
const held = syncSplitPlayer(video, audio, 0, false);
audio.readyState = 4;
state.localAudioPlaybackBlocked = false;
nowMs += 1000;
const recovered = syncSplitPlayer(video, audio, 0, true);
await Promise.resolve();
console.log(JSON.stringify({
  held, recovered,
  videoPauseCalls: video.pauseCalls,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  videoSeekWrites: video.seekWrites,
}));
`, this.sync_source));
assert.deepEqual(result["held"], "wait-for-audio");
assert.deepEqual(result["recovered"], "resume");
assert.deepEqual(result["videoPauseCalls"], 1);
assert.deepEqual(result["videoPlayCalls"], 1);
assert.deepEqual(result["videoSeekWrites"], 0);
},
async test_manual_pause_remains_authoritative_after_pair_is_established() {
let result;
result = (await this.run_node(`
const video = new FakeMedia(10); const audio = new FakeMedia(10);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
const actionsAfterPause = [];
for (let index = 0; index < 5; index += 1) {
  actionsAfterPause.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  actionsAfterPause,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
`, this.sync_source));
assert.deepEqual(new Set((Symbol.iterator in Object(result["actionsAfterPause"]) ? result["actionsAfterPause"] : Object.keys(result["actionsAfterPause"]))), new Set(["pause"]));
assert.deepEqual(result["videoPlayCalls"], 0);
assert.deepEqual(result["audioPlayCalls"], 0);
},
async test_song_switch_resets_policy_state_and_attempts_new_pair_once() {
let ownership_claim, renderer, result, teardown;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const oldVideo = new FakeMedia(0); const oldAudio = new FakeMedia(0);
mountedVideo = oldVideo; mountedAudio = oldAudio;
state.localPlaybackStartState = "pending";
oldAudio.play = function() {
  this.playCalls += 1;
  const error = new Error("blocked"); error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(oldVideo, oldAudio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const oldState = state.localPlaybackStartState;

state.localPlaybackStartState = "idle";
state.localPlaybackStartGeneration = 0;
state.localPlaybackStartPromisesSettled = false;
state.localWebKitStartRetryDone = false;
const newVideo = new FakeMedia(0); const newAudio = new FakeMedia(0);
newVideo.readyState = 1; newAudio.readyState = 1;
mountedVideo = newVideo; mountedAudio = newAudio;
// A new song defaults to play even though the replaced song ended blocked/paused.
state.localShouldBePlaying = true;
state.hostPlaybackSession.readyCommitted = false;
state.hostPlaybackSession.initialIntentApplied = false;
setSplitPlaybackStartState("pending", newVideo, newAudio);
const synchronizeNewSong = createSplitPlayerStartupSynchronizer(
  newVideo,
  newAudio,
  () => false,
);
synchronizeNewSong();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  oldState,
  oldCalls: [oldVideo.playCalls, oldAudio.playCalls],
  newState: state.localPlaybackStartState,
  newIntent: state.localShouldBePlaying,
  newCalls: [newVideo.playCalls, newAudio.playCalls],
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["oldState"], "needs-user-gesture");
assert.deepEqual(result["oldCalls"], [1, 1]);
assert.deepEqual(result["newState"], "established");
assert.ok(hasContent(result["newIntent"]));
assert.deepEqual(result["newCalls"], [1, 1]);
teardown = (await this._slice("function retireHostPlaybackSession", "function replaceHostPlayerView"));
renderer = (await this._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl"));
assert.ok(contains("setHostPlaybackSessionPhase(session, \"retired\")", teardown));
assert.ok(!contains("state.localPlaybackStartState = \"idle\"", teardown));
assert.ok(contains("setHostPlaybackSessionPhase(session, \"binding\")", this.source));
assert.ok(contains("commitHostPlaybackSessionReadyPaused", renderer));
assert.ok(contains("beginHostPlaybackSessionOwnershipClaim(session)", renderer));
ownership_claim = (await this._slice("function beginHostPlaybackSessionOwnershipClaim", "function replaceHostPlayerView"));
assert.ok(contains("beginHostPlaybackSessionElementLoading(session)", ownership_claim));
},
async test_only_one_player_renderer_and_one_sync_interval_remain() {
let renderer;
assert.deepEqual(countOccurrences(this.source, "function renderPlayer(currentItem, playbackMode)"), 1);
renderer = (await this._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl"));
assert.deepEqual(countOccurrences(renderer, "session.syncTimer = syncTimer"), 1);
assert.ok(contains("clearLocalPlayerEventListeners(session)", this.source));
},
async test_frontend_has_no_duplicate_active_function_declarations() {
let declaration, declarations, duplicates, name, pattern, source;
pattern = new RegExp("^(?:async )?function ([A-Za-z0-9_]+)","gm");
for (const [name, source] of iterableValues([["host", this.source], ["remote", this.remote_source]])) {
declarations = Array.from(source.matchAll(pattern), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
duplicates = Array.from(Array.from(Array.from(iterableValues(new Set((Symbol.iterator in Object(declarations) ? declarations : Object.keys(declarations))))) .filter((declaration) => ((countOccurrences(declarations, declaration) > 1)))).map((declaration) => declaration)).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0);
assert.deepEqual(duplicates, [], name);
}
},
async test_webkit_detection() {
let result;
result = (await this.run_node(`
const safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const wkWebviewUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const macChromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const winEdgeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

Object.defineProperty(globalThis, "navigator", { value: { userAgent: safariUA }, configurable: true, writable: true });
const safariResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: wkWebviewUA }, configurable: true, writable: true });
const wkResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: macChromeUA }, configurable: true, writable: true });
const macChromeResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: winEdgeUA }, configurable: true, writable: true });
const winEdgeResult = isWebKitPlaybackRuntime();

console.log(JSON.stringify({ safariResult, wkResult, macChromeResult, winEdgeResult }));
`));
assert.deepEqual(result, {["safariResult"]: true, ["wkResult"]: true, ["macChromeResult"]: false, ["winEdgeResult"]: false});
},
async test_webkit_sync_thresholds() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(29.80);
video.paused = false; audio.paused = false;
const smallDriftAction = syncSplitPlayer(video, audio, 0.0, false);
const smallAudioWrites = audio.seekWrites;

audio._time = 29.30;
const largeDriftAction = syncSplitPlayer(video, audio, 0.0, false);
const largeAudioWrites = audio.seekWrites;

console.log(JSON.stringify({ smallDriftAction, smallAudioWrites, largeDriftAction, largeAudioWrites, videoWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result, {["smallDriftAction"]: "none", ["smallAudioWrites"]: 0, ["largeDriftAction"]: "audio-drift-correction", ["largeAudioWrites"]: 1, ["videoWrites"]: 0});
},
async test_webkit_short_video_waiting_recovers_without_pausing_or_seeking_audio() {
let event_source, result;
event_source = (`
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function registerVideoRecoveryListeners(video, audio, synchronizeStartupPlayer) {
` + String(this.video_recovery_event_source) + `
}
`);
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(15); const audio = new FakeMedia(14.98);
video.paused = false; audio.paused = false;
let syncCalls = 0; const forceCalls = [];
const productionSync = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  syncCalls += 1; forceCalls.push(Boolean(args[3])); return productionSync(...args);
};
function updateSplitPlaybackStartOverlay() {}
function settleSplitPlayerSeek() { return false; }
registerVideoRecoveryListeners(video, audio, () => false);
video.readyState = 1;
video.dispatchMediaEvent("waiting");
const pausedDuringWait = audio.paused;
const waitingAction = syncSplitPlayer(video, audio, 0, false);
video.readyState = 4;
video.dispatchMediaEvent("canplay");
await Promise.resolve();
console.log(JSON.stringify({ pausedDuringWait, waitingAction, syncCalls, forceCalls,
  audioPaused: audio.paused, audioPauseCalls: audio.pauseCalls,
  audioPlayCalls: audio.playCalls, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source, event_source));
assert.ok(!hasContent(result["pausedDuringWait"]));
assert.deepEqual(result["waitingAction"], "wait-for-video");
assert.deepEqual(result["syncCalls"], 2);
assert.deepEqual(result["forceCalls"], [false, false]);
assert.ok(!hasContent(result["audioPaused"]));
assert.deepEqual(result["audioPauseCalls"], 0);
assert.deepEqual(result["audioPlayCalls"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
assert.deepEqual(result["videoSeekWrites"], 0);
},
async test_webkit_video_waiting_bursts_do_not_create_command_storm() {
let event_source, result;
event_source = (`
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function registerVideoRecoveryListeners(video, audio, synchronizeStartupPlayer) {
` + String(this.video_recovery_event_source) + `
}
`);
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(15); const audio = new FakeMedia(14.98);
video.paused = false; audio.paused = false;
let syncCalls = 0; const forceCalls = [];
const productionSync = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  syncCalls += 1; forceCalls.push(Boolean(args[3])); return productionSync(...args);
};
function updateSplitPlaybackStartOverlay() {}
function settleSplitPlayerSeek() { return false; }
registerVideoRecoveryListeners(video, audio, () => false);
for (let index = 0; index < 5; index += 1) {
  video.readyState = 1;
  video.dispatchMediaEvent("waiting");
  syncSplitPlayer(video, audio, 0, false);
  video.readyState = 4;
  video.dispatchMediaEvent("canplay");
}
await Promise.resolve();
console.log(JSON.stringify({ syncCalls, forceCalls, audioPauseCalls: audio.pauseCalls,
  audioPlayCalls: audio.playCalls, audioSeekWrites: audio.seekWrites,
  videoPauseCalls: video.pauseCalls, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source, event_source));
assert.deepEqual(result["syncCalls"], 10);
assert.ok(!contains(true, result["forceCalls"]));
assert.deepEqual(result["audioPauseCalls"], 0);
assert.deepEqual(result["audioPlayCalls"], 0);
assert.deepEqual(result["audioSeekWrites"], 0);
assert.deepEqual(result["videoPauseCalls"], 0);
assert.deepEqual(result["videoPlayCalls"], 0);
assert.deepEqual(result["videoSeekWrites"], 0);
},
async test_webkit_starvation_recovery_defers_large_correction_to_later_tick() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(27);
video.paused = false; audio.paused = false;
state.localVideoDeferredRecovery = true;
const recoveryAction = syncSplitPlayer(video, audio, 0, true);
const recoveryWrites = audio.seekWrites;
nowMs += 120;
const laterAction = syncSplitPlayer(video, audio, 0, false);
nowMs += 120;
const cooldownAction = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ recoveryAction, recoveryWrites, laterAction, cooldownAction,
  audioTime: audio.currentTime, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result["recoveryAction"], "resume");
assert.deepEqual(result["recoveryWrites"], 0);
assert.deepEqual(result["laterAction"], "audio-drift-correction");
assert.deepEqual(result["cooldownAction"], "none");
assert.deepEqual(result["audioSeekWrites"], 1);
assert.deepEqual(result["videoSeekWrites"], 0);
},
async test_webkit_force_correction_does_not_bypass_hard_threshold() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(29.98);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result, {["action"]: "none", ["audioSeekWrites"]: 0, ["videoSeekWrites"]: 0});
},
async test_pending_best_effort_play_is_bounded_per_media_element() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(20); const audio = new FakeMedia(20);
video.paused = false; audio.paused = true;
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {});
};
for (let index = 0; index < 12; index += 1) {
  syncSplitPlayer(video, audio, 0, false);
}
console.log(JSON.stringify({ audioPlayCalls: audio.playCalls,
  audioSeekWrites: audio.seekWrites, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result, {["audioPlayCalls"]: 1, ["audioSeekWrites"]: 0, ["videoPlayCalls"]: 0, ["videoSeekWrites"]: 0});
},
async test_chromium_pending_best_effort_play_behavior_is_unchanged() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0" }, configurable: true, writable: true });
const video = new FakeMedia(20); const audio = new FakeMedia(20);
video.paused = false; audio.paused = true;
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {});
};
for (let index = 0; index < 3; index += 1) {
  syncSplitPlayer(video, audio, 0, false);
}
console.log(JSON.stringify({ audioPlayCalls: audio.playCalls,
  audioSeekWrites: audio.seekWrites, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
`, this.sync_source));
assert.deepEqual(result, {["audioPlayCalls"]: 3, ["audioSeekWrites"]: 0, ["videoPlayCalls"]: 0, ["videoSeekWrites"]: 0});
},
async test_webkit_seek_single_transaction() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
beginSplitPlayerSeek(video, audio, { targetTime: 20, resumeAfterSeek: true });
const initialVideoWrites = video.seekWrites;
const initialAudioWrites = audio.seekWrites;

// Settle polling
settleSplitPlayerSeek(video, audio);
const pollAudioWrites = audio.seekWrites;

// Complete seek
video.seeking = false; audio.seeking = false; video.readyState = 4; audio.readyState = 4;
settleSplitPlayerSeek(video, audio, true);
const finalAudioWrites = audio.seekWrites;

console.log(JSON.stringify({ initialVideoWrites, initialAudioWrites, pollAudioWrites, finalAudioWrites }));
`, this.sync_source, this.seek_lifecycle_source, this.clear_seek_source, (await this._slice("function targetAudioTimeFromVideo", "function mediaUrlBasename"))));
assert.deepEqual(result, {["initialVideoWrites"]: 1, ["initialAudioWrites"]: 1, ["pollAudioWrites"]: 1, ["finalAudioWrites"]: 1});
},
async test_webkit_startup_abort_error_does_not_trigger_user_gesture() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
audio.play = function() {
  const err = new Error("aborted"); err.name = "AbortError";
  return Promise.reject(err);
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, shouldBePlaying: state.localShouldBePlaying }));
`, this.sync_source, (await this._slice("function startSplitPlaybackPair", "function playMediaBestEffort"))));
assert.notDeepEqual(result["startState"], "needs-user-gesture");
assert.ok(hasContent(result["shouldBePlaying"]));
},
async test_webkit_startup_abort_error_retries_once_then_establishes() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
let audioAttempts = 0;
audio.play = function() {
  this.playCalls += 1;
  audioAttempts += 1;
  if (audioAttempts === 1) {
    const error = new Error("initial audio load interrupted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  this.paused = false;
  return Promise.resolve();
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  rejectionNames: playRejections.map((entry) => entry.errorName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["startState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.ok(!hasContent(result["videoPaused"]));
assert.ok(!hasContent(result["audioPaused"]));
assert.deepEqual(result["videoPlayCalls"], 2);
assert.deepEqual(result["audioPlayCalls"], 2);
assert.ok(hasContent(result["overlayHidden"]));
assert.deepEqual(result["rejectionNames"], ["AbortError"]);
assert.deepEqual(result["startupEvents"], ["autoplay-attempt", "autoplay-video-play-resolved", "autoplay-retry-scheduled", "autoplay-retry-attempt", "autoplay-attempt", "autoplay-video-play-resolved", "autoplay-audio-play-resolved", "autoplay-retry-success", "autoplay-success"]);
},
async test_webkit_startup_retry_waits_for_stable_readiness() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
let audioAttempts = 0;
audio.play = function() {
  this.playCalls += 1;
  audioAttempts += 1;
  if (audioAttempts === 1) {
    this.readyState = 1;
    const error = new Error("audio load replaced");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  this.paused = false;
  return Promise.resolve();
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 70));
const beforeReady = {
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
};
audio.readyState = 4;
audio.dispatchMediaEvent("canplay");
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  beforeReady,
  finalState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["beforeReady"], {["startState"]: "pending", ["videoPlayCalls"]: 1, ["audioPlayCalls"]: 1});
assert.deepEqual(result["finalState"], "established");
assert.deepEqual(result["videoPlayCalls"], 2);
assert.deepEqual(result["audioPlayCalls"], 2);
assert.ok(contains("autoplay-retry-attempt", result["startupEvents"]));
assert.ok(contains("autoplay-retry-success", result["startupEvents"]));
},
async test_webkit_startup_non_policy_retry_exhaustion_is_recoverable_failure() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
audio.play = function() {
  this.playCalls += 1;
  const error = new Error(\`audio pipeline interrupted \${this.playCalls}\`);
  error.name = "AbortError";
  return Promise.reject(error);
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
const tickActions = [];
for (let index = 0; index < 5; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  tickActions,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  rejectionNames: playRejections.map((entry) => entry.errorName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["startState"], "startup-failed");
assert.ok(!hasContent(result["shouldPlay"]));
assert.ok(hasContent(result["videoPaused"]));
assert.ok(hasContent(result["audioPaused"]));
assert.deepEqual(result["videoPlayCalls"], 2);
assert.deepEqual(result["audioPlayCalls"], 2);
assert.ok(!hasContent(result["overlayHidden"]));
assert.deepEqual(new Set((Symbol.iterator in Object(result["tickActions"]) ? result["tickActions"] : Object.keys(result["tickActions"]))), new Set(["startup-failed"]));
assert.deepEqual(result["rejectionNames"], ["AbortError", "AbortError"]);
assert.deepEqual(result["startupEvents"], ["autoplay-attempt", "autoplay-video-play-resolved", "autoplay-retry-scheduled", "autoplay-retry-attempt", "autoplay-attempt", "autoplay-video-play-resolved", "autoplay-retry-exhausted", "startup-failed"]);
},
async test_webkit_startup_failed_overlay_allows_manual_recovery() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("temporary audio failure");
  error.name = "AbortError";
  return Promise.reject(error);
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
const failed = {
  startState: state.localPlaybackStartState,
  overlayHidden: mountedOverlay.hidden,
};

audio.play = function() {
  this.playCalls += 1;
  this.paused = false;
  return Promise.resolve();
};
startSplitPlaybackPair(video, audio, { userGesture: true });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  failed,
  finalState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["failed"], {["startState"]: "startup-failed", ["overlayHidden"]: false});
assert.deepEqual(result["finalState"], "established");
assert.ok(hasContent(result["shouldPlay"]));
assert.ok(!hasContent(result["videoPaused"]));
assert.ok(!hasContent(result["audioPaused"]));
assert.ok(hasContent(result["overlayHidden"]));
assert.ok(contains("user-start-success", result["startupEvents"]));
},
async test_webkit_resolved_but_paused_pair_is_not_established() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
video.play = function() { this.playCalls += 1; return Promise.resolve(); };
audio.play = function() { this.playCalls += 1; return Promise.resolve(); };
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
`, this.sync_source, this.startup_source));
assert.deepEqual(result["startState"], "startup-failed");
assert.deepEqual(result["videoPlayCalls"], 2);
assert.deepEqual(result["audioPlayCalls"], 2);
assert.ok(!hasContent(result["overlayHidden"]));
assert.deepEqual(result["startupEvents"], ["autoplay-attempt", "autoplay-video-play-resolved", "autoplay-audio-play-resolved", "autoplay-resolved-but-still-paused", "autoplay-retry-scheduled", "autoplay-retry-attempt", "autoplay-attempt", "autoplay-video-play-resolved", "autoplay-audio-play-resolved", "autoplay-resolved-but-still-paused", "resolved-but-still-paused", "startup-failed"]);
},
async test_webkit_startup_not_allowed_error_triggers_user_gesture() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
audio.play = function() {
  const err = new Error("NotAllowedError"); err.name = "NotAllowedError";
  return Promise.reject(err);
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, shouldBePlaying: state.localShouldBePlaying }));
`, this.sync_source, (await this._slice("function startSplitPlaybackPair", "function playMediaBestEffort"))));
assert.deepEqual(result["startState"], "needs-user-gesture");
assert.ok(!hasContent(result["shouldBePlaying"]));
},
async test_tauri_webkit_fullscreen_uses_native_capability() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
global.window.__TAURI__ = { window: {}, core: { invoke: async () => {} } };
let classAdded = false;
let bodyClassAdded = false;
elements.playerPanel = {
  classList: {
    contains(c) { return c === "is-tauri-fullscreen" ? classAdded : false; },
    add(c) { if (c === "is-tauri-fullscreen") classAdded = true; },
    remove(c) { if (c === "is-tauri-fullscreen") classAdded = false; },
  }
};
global.document = {
  body: {
    classList: {
      add(c) { if (c === "is-tauri-fullscreen-active") bodyClassAdded = true; },
      remove(c) { if (c === "is-tauri-fullscreen-active") bodyClassAdded = false; },
    }
  }
};

const isTauriWK = isTauriWebKitRuntime();
const supportsFS = supportsPlayerFullscreen();

console.log(JSON.stringify({ isTauriWK, supportsFS }));
`, (await this._slice("function isWebKitPlaybackRuntime()", "function tauriInvoke(")), (await this._slice("function tauriInvoke(", "function syncApplicationRestartAvailability()"))));
assert.ok(hasContent(result["isTauriWK"]));
assert.ok(hasContent(result["supportsFS"]));
},
async test_chromium_freeze_unchanged() {
let result;
result = (await this.run_node(`
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0" }, configurable: true, writable: true });
global.window.__TAURI__ = { window: {}, core: {} };

const isWebKit = isWebKitPlaybackRuntime();
const isTauriWK = isTauriWebKitRuntime();

console.log(JSON.stringify({ isWebKit, isTauriWK }));
`, (await this._slice("function isWebKitPlaybackRuntime()", "function tauriInvoke("))));
assert.ok(!hasContent(result["isWebKit"]));
assert.ok(!hasContent(result["isTauriWK"]));
}
};
test('playback feedback waits for the current observed pair, ignores retries/stale sessions and clears cancelled intent', async () => {
  const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass();
  const result = await instance.run_node(`
const notices = [];
elements.presentationFeedback = {};
window.BilikaraPresentationFeedback = {
  durationMs: 2000, recent(_previous, next) { return next.at(-1); },
  create() { return { show(notice) { notices.push(notice.kind); } }; },
};
isAudiencePlayerSurface = () => true;
global.publishPresentationOutputState = () => {};
const video = new FakeMedia(10), audio = new FakeMedia(9.8);
mountedVideo = video; mountedAudio = audio;
const session = state.hostPlaybackSession;
Object.assign(session, { video, audio, playbackProgram: null, phase: 'needs-user-gesture', logicalPlayIntent: true });
requestSplitPlaybackStartFromUserGesture(video, audio);
const beforeObserved = [...notices];
video.paused = true; audio.paused = false; session.phase = 'playing';
confirmPresentationPlaybackFeedback(session);
const incomplete = [...notices];
video.paused = false;
confirmPresentationPlaybackFeedback({ ...session });
const stale = [...notices];
confirmPresentationPlaybackFeedback(session); confirmPresentationPlaybackFeedback(session);
const played = [...notices];
setSplitPlaybackIntent(video, audio, false);
const paused = [...notices];
session.presentationFeedbackPlayPending = true; session.readyCommitted = false;
setSplitPlaybackIntent(video, audio, false);
const cancelledPending = session.presentationFeedbackPlayPending;
console.log(JSON.stringify({ beforeObserved, incomplete, stale, played, paused, cancelledPending }));
`, instance.program_equality_source, instance.sync_source, instance.startup_source);
  assert.deepEqual(result, { beforeObserved: [], incomplete: [], stale: [], played: ['play'], paused: ['play', 'pause'], cancelledPending: false });
});
test("SplitPlayerSyncTest.test_video_starvation_pauses_audio_without_seeking_video", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_video_starvation_pauses_audio_without_seeking_video(); });
test("SplitPlayerSyncTest.test_video_recovery_realigns_audio_to_video_clock", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_video_recovery_realigns_audio_to_video_clock(); });
test("SplitPlayerSyncTest.test_normal_sync_source_cannot_seek_video", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_normal_sync_source_cannot_seek_video(); });
test("SplitPlayerSyncTest.test_all_programmatic_video_writes_are_navigation_or_restore_paths", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_all_programmatic_video_writes_are_navigation_or_restore_paths(); });
test("SplitPlayerSyncTest.test_normal_drift_correction_seeks_audio_only", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_normal_drift_correction_seeks_audio_only(); });
test("SplitPlayerSyncTest.test_android_recovery_events_do_not_seek_one_audio_packet_ahead", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_recovery_events_do_not_seek_one_audio_packet_ahead(); });
test("SplitPlayerSyncTest.test_android_forced_audio_ahead_correction_respects_cooldown", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_forced_audio_ahead_correction_respects_cooldown(); });
test("SplitPlayerSyncTest.test_audio_correction_diagnostic_preserves_pre_seek_drift", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_audio_correction_diagnostic_preserves_pre_seek_drift(); });
test("SplitPlayerSyncTest.test_android_seek_output_clock_recovers_without_reseeking_audio", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_seek_output_clock_recovers_without_reseeking_audio(); });
test("SplitPlayerSyncTest.test_small_acceptable_drift_writes_neither_timeline", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_small_acceptable_drift_writes_neither_timeline(); });
test("SplitPlayerSyncTest.test_android_clock_catchup_preserves_offset_and_requested_rate", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_clock_catchup_preserves_offset_and_requested_rate(); });
test("SplitPlayerSyncTest.test_android_clock_recovery_cannot_undo_pause_or_new_seek", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_clock_recovery_cannot_undo_pause_or_new_seek(); });
test("SplitPlayerSyncTest.test_android_clock_recovery_retires_with_session_and_ignores_old_frame", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_clock_recovery_retires_with_session_and_ignores_old_frame(); });
test("SplitPlayerSyncTest.test_android_audio_seek_holds_video_until_audio_recovers", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_android_audio_seek_holds_video_until_audio_recovers(); });
test("SplitPlayerSyncTest.test_seek_supersedes_inflight_play_attempt_without_startup_failure", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_seek_supersedes_inflight_play_attempt_without_startup_failure(); });
test("SplitPlayerSyncTest.test_audio_variant_click_preserves_intent_during_internal_video_hold", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_audio_variant_click_preserves_intent_during_internal_video_hold(); });
test("SplitPlayerSyncTest.test_effective_offset_echo_performs_exactly_one_audio_resync", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_effective_offset_echo_performs_exactly_one_audio_resync(); });
test("SplitPlayerSyncTest.test_av_delay_change_while_playing_repositions_only_audio", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_av_delay_change_while_playing_repositions_only_audio(); });
test("SplitPlayerSyncTest.test_av_delay_resync_does_not_enter_coordinated_video_seek", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_av_delay_resync_does_not_enter_coordinated_video_seek(); });
test("SplitPlayerSyncTest.test_av_delay_change_while_paused_realigns_audio_and_stays_paused", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_av_delay_change_while_paused_realigns_audio_and_stays_paused(); });
test("SplitPlayerSyncTest.test_audio_waiting_holds_video_without_seeking_it", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_audio_waiting_holds_video_without_seeking_it(); });
test("SplitPlayerSyncTest.test_rapid_host_seek_recovers_audio_when_readiness_event_is_lost", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_rapid_host_seek_recovers_audio_when_readiness_event_is_lost(); });
test("SplitPlayerSyncTest.test_transition_hold_prevents_any_audio_or_video_start", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_transition_hold_prevents_any_audio_or_video_start(); });
test("SplitPlayerSyncTest.test_positive_and_negative_delay_preserve_startup_boundaries", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_positive_and_negative_delay_preserve_startup_boundaries(); });
test("SplitPlayerSyncTest.test_video_timeline_seek_maps_to_audio_with_delay", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_video_timeline_seek_maps_to_audio_with_delay(); });
test("SplitPlayerSyncTest.test_manual_video_seek_freezes_pair_maps_audio_and_resumes", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_manual_video_seek_freezes_pair_maps_audio_and_resumes(); });
test("SplitPlayerSyncTest.test_playback_restore_intentionally_seeks_video_then_aligns_audio", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_playback_restore_intentionally_seeks_video_then_aligns_audio(); });
test("SplitPlayerSyncTest.test_manual_video_seek_while_paused_keeps_pair_paused", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_manual_video_seek_while_paused_keeps_pair_paused(); });
test("SplitPlayerSyncTest.test_requested_rate_is_preserved_without_internal_audio_nudging", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_requested_rate_is_preserved_without_internal_audio_nudging(); });
test("SplitPlayerSyncTest.test_long_term_periodic_correction_never_writes_video_timeline", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_long_term_periodic_correction_never_writes_video_timeline(); });
test("SplitPlayerSyncTest.test_video_end_does_not_truncate_audio_and_completion_advances_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_video_end_does_not_truncate_audio_and_completion_advances_once(); });
test("SplitPlayerSyncTest.test_teardown_helpers_clear_timers_and_registered_listeners", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_teardown_helpers_clear_timers_and_registered_listeners(); });
test("SplitPlayerSyncTest.test_ordinary_render_does_not_synchronize_or_seek_mounted_player", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_ordinary_render_does_not_synchronize_or_seek_mounted_player(); });
test("SplitPlayerSyncTest.test_ownership_claim_latency_does_not_consume_media_readiness_watchdog", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_ownership_claim_latency_does_not_consume_media_readiness_watchdog(); });
test("SplitPlayerSyncTest.test_refresh_progress_preserves_mounted_pair_and_new_artifact_changes_identity_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_refresh_progress_preserves_mounted_pair_and_new_artifact_changes_identity_once(); });
test("SplitPlayerSyncTest.test_key_shift_action_writes_neither_media_timeline", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_key_shift_action_writes_neither_media_timeline(); });
test("SplitPlayerSyncTest.test_key_shift_render_echo_does_not_synchronize_or_seek_video", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_key_shift_render_echo_does_not_synchronize_or_seek_video(); });
test("SplitPlayerSyncTest.test_startup_readiness_events_coalesce_without_timeline_write_storm", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_startup_readiness_events_coalesce_without_timeline_write_storm(); });
test("SplitPlayerSyncTest.test_staggered_readiness_commits_ready_paused_before_one_play_attempt", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_staggered_readiness_commits_ready_paused_before_one_play_attempt(); });
test("SplitPlayerSyncTest.test_audio_readiness_before_video_does_not_commit_or_start_early", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_audio_readiness_before_video_does_not_commit_or_start_early(); });
test("SplitPlayerSyncTest.test_ready_commit_applies_paused_intent_without_playing", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_ready_commit_applies_paused_intent_without_playing(); });
test("SplitPlayerSyncTest.test_policy_rejection_after_ready_commit_keeps_the_committed_pair", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_policy_rejection_after_ready_commit_keeps_the_committed_pair(); });
test("SplitPlayerSyncTest.test_restore_settles_before_commit_and_applies_each_exact_intent_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_restore_settles_before_commit_and_applies_each_exact_intent_once(); });
test("SplitPlayerSyncTest.test_superseded_unready_candidate_and_media_error_settle_stale_safe_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_superseded_unready_candidate_and_media_error_settle_stale_safe_once(); });
test("SplitPlayerSyncTest.test_uncommitted_candidate_cannot_authoritatively_end", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_uncommitted_candidate_cannot_authoritatively_end(); });
test("SplitPlayerSyncTest.test_program_scoped_player_status_is_observed_ordered_and_session_owned", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_program_scoped_player_status_is_observed_ordered_and_session_owned(); });
test("SplitPlayerSyncTest.test_packaged_tauri_webkit_fresh_start_resolves_without_user_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_webkit_fresh_start_resolves_without_user_gesture(); });
test("SplitPlayerSyncTest.test_webkit_metadata_only_pair_attempts_autoplay_before_canplay", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_metadata_only_pair_attempts_autoplay_before_canplay(); });
test("SplitPlayerSyncTest.test_chromium_initial_start_keeps_existing_canplay_gate", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_chromium_initial_start_keeps_existing_canplay_gate(); });
test("SplitPlayerSyncTest.test_packaged_tauri_metadata_start_ignores_internal_native_play_echo", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_metadata_start_ignores_internal_native_play_echo(); });
test("SplitPlayerSyncTest.test_host_pending_first_video_click_is_immediate_start_not_toggle", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_host_pending_first_video_click_is_immediate_start_not_toggle(); });
test("SplitPlayerSyncTest.test_packaged_tauri_pending_video_click_is_one_explicit_start", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_pending_video_click_is_one_explicit_start(); });
test("SplitPlayerSyncTest.test_packaged_tauri_native_pause_and_play_ignore_outer_video_click", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_native_pause_and_play_ignore_outer_video_click(); });
test("SplitPlayerSyncTest.test_packaged_tauri_native_seek_ignores_outer_video_click_and_preserves_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_native_seek_ignores_outer_video_click_and_preserves_intent(); });
test("SplitPlayerSyncTest.test_player_frame_click_toggle_is_bypassed_only_for_tauri_webkit", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_player_frame_click_toggle_is_bypassed_only_for_tauri_webkit(); });
test("SplitPlayerSyncTest.test_remote_toggle_during_pending_start_is_deterministic_play", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_remote_toggle_during_pending_start_is_deterministic_play(); });
test("SplitPlayerSyncTest.test_unknown_duration_keeps_absolute_seek_target_until_metadata_arrives", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_unknown_duration_keeps_absolute_seek_target_until_metadata_arrives(); });
test("SplitPlayerSyncTest.test_remote_program_relative_commands_reject_stale_same_id_programs_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_remote_program_relative_commands_reject_stale_same_id_programs_once(); });
test("SplitPlayerSyncTest.test_tauri_webkit_host_manual_play_then_remote_toggle_uses_session_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_host_manual_play_then_remote_toggle_uses_session_intent(); });
test("SplitPlayerSyncTest.test_tauri_webkit_remote_toggle_recovers_an_active_auto_started_pair", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_remote_toggle_recovers_an_active_auto_started_pair(); });
test("SplitPlayerSyncTest.test_tauri_webkit_remote_seek_uses_authoritative_playback_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_remote_seek_uses_authoritative_playback_intent(); });
test("SplitPlayerSyncTest.test_tauri_webkit_internal_pause_events_preserve_play_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_internal_pause_events_preserve_play_intent(); });
test("SplitPlayerSyncTest.test_tauri_webkit_remote_policy_rejection_still_requires_host_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_remote_policy_rejection_still_requires_host_gesture(); });
test("SplitPlayerSyncTest.test_packaged_tauri_media_session_pause_and_play_follow_logical_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_media_session_pause_and_play_follow_logical_intent(); });
test("SplitPlayerSyncTest.test_packaged_tauri_media_session_seeks_are_bounded_and_preserve_intent", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_media_session_seeks_are_bounded_and_preserve_intent(); });
test("SplitPlayerSyncTest.test_packaged_tauri_media_session_resolves_new_song_and_next_track_dynamically", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_media_session_resolves_new_song_and_next_track_dynamically(); });
test("SplitPlayerSyncTest.test_media_session_ownership_is_packaged_tauri_webkit_only", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_media_session_ownership_is_packaged_tauri_webkit_only(); });
test("SplitPlayerSyncTest.test_packaged_tauri_media_session_position_uses_video_master_and_clears", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_packaged_tauri_media_session_position_uses_video_master_and_clears(); });
test("SplitPlayerSyncTest.test_user_gesture_state_is_only_requested_from_policy_rejections", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_user_gesture_state_is_only_requested_from_policy_rejections(); });
test("SplitPlayerSyncTest.test_startup_misalignment_is_one_audio_write_and_zero_video_writes", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_startup_misalignment_is_one_audio_write_and_zero_video_writes(); });
test("SplitPlayerSyncTest.test_video_autoplay_policy_rejection_requires_one_user_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_video_autoplay_policy_rejection_requires_one_user_gesture(); });
test("SplitPlayerSyncTest.test_audio_autoplay_policy_rejection_requires_one_user_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_audio_autoplay_policy_rejection_requires_one_user_gesture(); });
test("SplitPlayerSyncTest.test_webkit_startup_records_video_and_audio_play_rejections_separately", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_records_video_and_audio_play_rejections_separately(); });
test("SplitPlayerSyncTest.test_application_start_invokes_both_media_plays_in_same_click_stack", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_application_start_invokes_both_media_plays_in_same_click_stack(); });
test("SplitPlayerSyncTest.test_user_start_issues_both_play_calls_even_when_ready_state_below_2", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_user_start_issues_both_play_calls_even_when_ready_state_below_2(); });
test("SplitPlayerSyncTest.test_pending_without_play_attempt_times_out_to_manual_recovery", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_pending_without_play_attempt_times_out_to_manual_recovery(); });
test("SplitPlayerSyncTest.test_unsettled_play_promises_time_out_without_retry_storm", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_unsettled_play_promises_time_out_without_retry_storm(); });
test("SplitPlayerSyncTest.test_resolved_playing_pair_establishes_and_cancels_watchdog", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_resolved_playing_pair_establishes_and_cancels_watchdog(); });
test("SplitPlayerSyncTest.test_stale_pending_watchdog_cannot_fail_newer_start_generation", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_stale_pending_watchdog_cannot_fail_newer_start_generation(); });
test("SplitPlayerSyncTest.test_retired_webkit_retry_and_watchdog_cannot_start_or_fail_current_pair", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_retired_webkit_retry_and_watchdog_cannot_start_or_fail_current_pair(); });
test("SplitPlayerSyncTest.test_superseded_startup_promises_cannot_establish_newer_attempt", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_superseded_startup_promises_cannot_establish_newer_attempt(); });
test("SplitPlayerSyncTest.test_retired_play_promise_completion_is_silent_and_current_attempt_still_settles", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_retired_play_promise_completion_is_silent_and_current_attempt_still_settles(); });
test("SplitPlayerSyncTest.test_native_controls_are_unavailable_until_split_start_is_established", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_native_controls_are_unavailable_until_split_start_is_established(); });
test("SplitPlayerSyncTest.test_player_surface_interactions_reveal_controls_only_after_startup_and_hide_on_leave", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_player_surface_interactions_reveal_controls_only_after_startup_and_hide_on_leave(); });
test("SplitPlayerSyncTest.test_stale_controls_hide_callback_cannot_mutate_a_replacement_video", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_stale_controls_hide_callback_cannot_mutate_a_replacement_video(); });
test("SplitPlayerSyncTest.test_retired_sync_start_and_starvation_callbacks_preserve_current_timers", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_retired_sync_start_and_starvation_callbacks_preserve_current_timers(); });
test("SplitPlayerSyncTest.test_retired_hidden_pause_and_delayed_click_callbacks_do_not_touch_current_pair", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_retired_hidden_pause_and_delayed_click_callbacks_do_not_touch_current_pair(); });
test("SplitPlayerSyncTest.test_automatic_player_lifecycle_never_requests_native_control_visibility", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_automatic_player_lifecycle_never_requests_native_control_visibility(); });
test("SplitPlayerSyncTest.test_policy_rejection_stops_periodic_play_retry_storm", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_policy_rejection_stops_periodic_play_retry_storm(); });
test("SplitPlayerSyncTest.test_established_starvation_hold_and_recovery_still_work", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_established_starvation_hold_and_recovery_still_work(); });
test("SplitPlayerSyncTest.test_manual_pause_remains_authoritative_after_pair_is_established", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_manual_pause_remains_authoritative_after_pair_is_established(); });
test("SplitPlayerSyncTest.test_song_switch_resets_policy_state_and_attempts_new_pair_once", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_song_switch_resets_policy_state_and_attempts_new_pair_once(); });
test("SplitPlayerSyncTest.test_only_one_player_renderer_and_one_sync_interval_remain", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_only_one_player_renderer_and_one_sync_interval_remain(); });
test("SplitPlayerSyncTest.test_frontend_has_no_duplicate_active_function_declarations", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_frontend_has_no_duplicate_active_function_declarations(); });
test("SplitPlayerSyncTest.test_webkit_detection", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_detection(); });
test("SplitPlayerSyncTest.test_webkit_sync_thresholds", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_sync_thresholds(); });
test("SplitPlayerSyncTest.test_webkit_short_video_waiting_recovers_without_pausing_or_seeking_audio", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_short_video_waiting_recovers_without_pausing_or_seeking_audio(); });
test("SplitPlayerSyncTest.test_webkit_video_waiting_bursts_do_not_create_command_storm", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_video_waiting_bursts_do_not_create_command_storm(); });
test("SplitPlayerSyncTest.test_webkit_starvation_recovery_defers_large_correction_to_later_tick", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_starvation_recovery_defers_large_correction_to_later_tick(); });
test("SplitPlayerSyncTest.test_webkit_force_correction_does_not_bypass_hard_threshold", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_force_correction_does_not_bypass_hard_threshold(); });
test("SplitPlayerSyncTest.test_pending_best_effort_play_is_bounded_per_media_element", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_pending_best_effort_play_is_bounded_per_media_element(); });
test("SplitPlayerSyncTest.test_chromium_pending_best_effort_play_behavior_is_unchanged", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_chromium_pending_best_effort_play_behavior_is_unchanged(); });
test("SplitPlayerSyncTest.test_webkit_seek_single_transaction", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_seek_single_transaction(); });
test("SplitPlayerSyncTest.test_webkit_startup_abort_error_does_not_trigger_user_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_abort_error_does_not_trigger_user_gesture(); });
test("SplitPlayerSyncTest.test_webkit_startup_abort_error_retries_once_then_establishes", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_abort_error_retries_once_then_establishes(); });
test("SplitPlayerSyncTest.test_webkit_startup_retry_waits_for_stable_readiness", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_retry_waits_for_stable_readiness(); });
test("SplitPlayerSyncTest.test_webkit_startup_non_policy_retry_exhaustion_is_recoverable_failure", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_non_policy_retry_exhaustion_is_recoverable_failure(); });
test("SplitPlayerSyncTest.test_webkit_startup_failed_overlay_allows_manual_recovery", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_failed_overlay_allows_manual_recovery(); });
test("SplitPlayerSyncTest.test_webkit_resolved_but_paused_pair_is_not_established", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_resolved_but_paused_pair_is_not_established(); });
test("SplitPlayerSyncTest.test_webkit_startup_not_allowed_error_triggers_user_gesture", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_webkit_startup_not_allowed_error_triggers_user_gesture(); });
test("SplitPlayerSyncTest.test_tauri_webkit_fullscreen_uses_native_capability", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_tauri_webkit_fullscreen_uses_native_capability(); });
test("SplitPlayerSyncTest.test_chromium_freeze_unchanged", async () => { const instance = Object.create(SplitPlayerSyncTest); await instance.setUpClass(); await instance.test_chromium_freeze_unchanged(); });
