import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, splitOnce, sourceIndex, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const SongTransitionFrontendTest = {
async setUpClass() {
this.source = readFileSync(path.join(path.join(path.resolve(path.resolve(__file__), "..", ".."), "static"), "app.js"), "utf8");
},
async source_slice(start, end) {
let end_index, start_index;
start_index = sourceIndex(this.source, start);
end_index = sourceIndex(this.source, end, start_index);
if (((end_index <= start_index))) {
throw new Error(("Empty source slice: " + JSON.stringify(start) + " to " + JSON.stringify(end)));
}
return this.source.slice(start_index, end_index);
},
async run_node(script) {
let completed;
completed = (await runNative("node", ["-e", (`(async () => {
function applyFreshStateSnapshot(snapshot) { state.data = snapshot; return true; }
async function apiPostStateSnapshot(url, payload) { return applyFreshStateSnapshot(await apiPost(url, payload)); }
async function apiPostExactStateCommand(url, payload) { const snapshot = await apiPost(url, payload); return { snapshotAccepted: applyFreshStateSnapshot(snapshot), commandApplied: true }; }
` + String(script) + `
})().catch((error) => { console.error(error); process.exit(1); });`)], process.env, 120000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout.trim().trimEnd().split(/\r?\n/).at((-1)));
},
async test_configured_zero_delay_is_not_replaced_with_default() {
let functions, result;
functions = (await this.source_slice("function currentSongAdvanceDelaySeconds", "function clampMediaTime"));
result = (await this.run_node((`
const state = { data: { player_settings: { song_advance_delay_seconds: 0 } } };
const defaultSongAdvanceDelaySeconds = 3;
const maxSongAdvanceDelaySeconds = 30;
` + String(functions) + `
console.log(JSON.stringify({
  current: currentSongAdvanceDelaySeconds(),
  manual: manualTransitionOverlaySeconds(),
}));
`)));
assert.deepEqual(result, {["current"]: 0, ["manual"]: 0});
},
async test_manual_next_registers_hold_before_backend_and_deduplicates_races() {
let advance_functions, hold_functions, result;
hold_functions = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
advance_functions = (await this.source_slice("async function advanceLocalPlayerNow", "async function reorderPlaylist"));
result = (await this.run_node((`
const oldItem = { id: "old" }; const nextItem = { id: "next" };
const state = {
  data: {
    playback_generation: 9,
    current_item: oldItem,
    playlist: [nextItem],
    player_settings: { song_advance_delay_seconds: 3 },
  },
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function queuedNextItem() { return state.data.playlist[0] || null; }
function manualTransitionOverlaySeconds() { return 3; }
function currentSongAdvanceDelaySeconds() { return 3; }
function clearLocalAdvanceDelay() {
  state.manualTransitionHoldItemId = ""; state.manualTransitionHoldGeneration = 0;
}
let apiCalls = 0; let heldBeforeResponse = false; let renders = 0; let nextPayload = null;
async function apiPost(_url, payload) {
  apiCalls += 1;
  nextPayload = payload;
  heldBeforeResponse = shouldHoldCurrentItemForTransition(nextItem)
    && state.localShouldBePlaying === false;
  await Promise.resolve();
  return { current_item: nextItem, playlist: [], player_settings: { song_advance_delay_seconds: 3 } };
}
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() {}
function syncLocalPlayerSettingsFromSnapshot(settings) { state.syncedPlayerSettings = settings; }
function render() { renders += 1; }
function syncMountedLocalPlayer() {}
function setAppMessage() {}
function isCurrentHostPlaybackSession() { return false; }
function isSafeHostSnapshotInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
` + String(hold_functions) + `
` + String(advance_functions) + `
await Promise.all([
  handleLocalPlaybackEnded("media-ended"),
  handleLocalPlaybackEnded("manual-next"),
]);
await requestNextTrack();
console.log(JSON.stringify({
  apiCalls, heldBeforeResponse, renders,
  inFlight: state.localAdvanceInFlight,
  holdItem: state.manualTransitionHoldItemId,
  shouldPlay: state.localShouldBePlaying, nextPayload,
}));
`)));
assert.deepEqual(result["apiCalls"], 1);
assert.ok(hasContent(result["heldBeforeResponse"]));
assert.deepEqual(result["renders"], 1);
assert.ok(hasContent(result["inFlight"]));
assert.deepEqual(result["holdItem"], "next");
assert.ok(!hasContent(result["shouldPlay"]));
assert.deepEqual(result["nextPayload"], {["playback_generation"]: 9});
},
async test_manual_next_zero_delay_mutates_once_without_hold() {
let advance_functions, hold_functions, result;
hold_functions = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
advance_functions = (await this.source_slice("async function advanceLocalPlayerNow", "async function reorderPlaylist"));
result = (await this.run_node((`
const nextItem = { id: "next" };
const state = {
  data: { playback_generation: 12, current_item: { id: "old" }, playlist: [nextItem] },
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function queuedNextItem() { return state.data.playlist[0] || null; }
function manualTransitionOverlaySeconds() { return 0; }
function currentSongAdvanceDelaySeconds() { return 0; }
function clearLocalAdvanceDelay() {}
let apiCalls = 0; let nextPayload = null;
async function apiPost(_url, payload) {
  apiCalls += 1;
  nextPayload = payload;
  return { playback_generation: 13, current_item: nextItem, playlist: [] };
}
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() { throw new Error("zero delay must not register overlay"); }
function render() {}
function syncMountedLocalPlayer() {}
function setAppMessage() {}
function isCurrentHostPlaybackSession() { return false; }
function isSafeHostSnapshotInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
` + String(hold_functions) + `
` + String(advance_functions) + `
await requestNextTrack();
console.log(JSON.stringify({
  apiCalls, inFlight: state.localAdvanceInFlight,
  generation: state.manualTransitionHoldGeneration,
  shouldPlay: state.localShouldBePlaying, nextPayload,
}));
`)));
assert.deepEqual(result, {["apiCalls"]: 1, ["inFlight"]: false, ["generation"]: 0, ["shouldPlay"]: true, ["nextPayload"]: {["playback_generation"]: 12}});
},
async test_stale_next_releases_only_its_transition_after_program_replacement() {
let advance_functions, clear_delay, expected, hold_functions, maybe_transition, result;
hold_functions = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
maybe_transition = (await this.source_slice("function maybeShowSongTransitionOverlay", "function hasPendingSongTransitionOverlayForItem"));
clear_delay = (await this.source_slice("function clearLocalAdvanceDelay", "function teardownMountedPlayer"));
advance_functions = (await this.source_slice("async function advanceLocalPlayerNow", "async function reorderPlaylist"));
result = (await this.run_node((`
const window = {
  clearTimeout() {}, clearInterval() {},
};
const oldItem = { id: "A" };
const nextItem = { id: "B" };
const programA = { item_id: "A", selected_audio_variant_id: "instrumental", artifact_set_id: "set-a1" };
const state = {
  data: {
    playback_generation: 9, playback_program: programA,
    current_item: oldItem, playlist: [nextItem],
    player_settings: { song_advance_delay_seconds: 3 },
  },
  hostPlaybackSession: null,
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
  localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
  localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function queuedNextItem() { return state.data.playlist[0] || null; }
function manualTransitionOverlaySeconds() { return 3; }
function currentSongAdvanceDelaySeconds() { return 3; }
function hidePlayerDelayOverlay() {}
function hasLocalAdvanceDelayOverlay() { return false; }
function isSafeHostSnapshotInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
function sameProgram(left, right) {
  return left?.item_id === right?.item_id
    && left?.selected_audio_variant_id === right?.selected_audio_variant_id
    && left?.artifact_set_id === right?.artifact_set_id;
}
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && sameProgram(session.playbackProgram, state.data.playback_program)
    && session.video === video && session.audio === audio;
}
let rejectNext = null;
let resolveNext = null;
let apiCalls = 0;
let syncCalls = 0;
let replacementPairEffects = 0;
async function apiPost() {
  apiCalls += 1;
  return new Promise((resolve, reject) => {
    resolveNext = resolve;
    rejectNext = reject;
  });
}
function render() {}
function setAppMessage() {}
function syncMountedLocalPlayer() {
  syncCalls += 1;
  const session = state.hostPlaybackSession;
  if (session?.playbackGeneration === state.data.playback_generation) {
    replacementPairEffects += 1;
  }
}
` + String(hold_functions) + `
` + String(maybe_transition) + `
` + String(clear_delay) + `
` + String(advance_functions) + `

async function runReplacement(selectedVariant, artifactSetId) {
  Object.assign(state, {
    data: {
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem],
      player_settings: { song_advance_delay_seconds: 3 },
    },
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  });
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  const oldSession = {
    phase: "playing", playbackGeneration: 9, playbackProgram: programA,
    video: {}, audio: {},
  };
  state.hostPlaybackSession = oldSession;
  const pending = requestNextTrack();
  const heldBeforeReplacement = state.manualTransitionHoldItemId === "B"
    && state.manualTransitionHoldGeneration === 1
    && state.localAdvanceInFlight;

  const replacementProgram = {
    item_id: "A", selected_audio_variant_id: selectedVariant,
    artifact_set_id: artifactSetId,
  };
  state.data = {
    playback_generation: 10, playback_program: replacementProgram,
    current_item: oldItem, playlist: [nextItem],
    player_settings: { song_advance_delay_seconds: 3 },
  };
  oldSession.phase = "retired";
  state.hostPlaybackSession = {
    phase: "playing", playbackGeneration: 10,
    playbackProgram: replacementProgram, video: {}, audio: {},
  };
  rejectNext(new Error("playback_generation_mismatch"));
  await pending;
  return {
    heldBeforeReplacement, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingOverlay: state.pendingSongTransitionOverlayData,
    delayTimer: state.localAdvanceDelayTimer,
    countdownTimer: state.localAdvanceCountdownTimer,
    deadline: state.localAdvanceDelayDeadline,
    inFlight: state.localAdvanceInFlight,
    replacementPairEffects, syncCalls, apiCalls,
  };
}

async function runNetworkFailure() {
  Object.assign(state, {
    data: {
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem],
      player_settings: { song_advance_delay_seconds: 3 },
    },
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  });
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  state.hostPlaybackSession = {
    phase: "playing", playbackGeneration: 9, playbackProgram: programA,
    video: {}, audio: {},
  };
  const pending = requestNextTrack();
  rejectNext(new Error("network failure"));
  await pending;
  return {
    holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  };
}

async function runNewerTransition() {
  Object.assign(state, {
    data: {
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem], state_revision: 1,
      player_settings: { song_advance_delay_seconds: 3 },
    },
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  });
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  const oldSession = {
    phase: "playing", playbackGeneration: 9, playbackProgram: programA,
    video: {}, audio: {},
  };
  state.hostPlaybackSession = oldSession;
  const pending = requestNextTrack();
  const oldGeneration = state.manualTransitionHoldGeneration;
  const previousData = state.data;
  const newerItem = { id: "C" };
  const newerProgram = {
    item_id: "C", selected_audio_variant_id: "instrumental",
    artifact_set_id: "set-c1",
  };
  state.data = {
    playback_generation: 10, playback_program: newerProgram,
    current_item: newerItem, playlist: [], state_revision: 2,
    player_settings: { song_advance_delay_seconds: 3 },
  };
  maybeShowSongTransitionOverlay(previousData, state.data);
  oldSession.phase = "retired";
  state.hostPlaybackSession = {
    phase: "playing", playbackGeneration: 10,
    playbackProgram: newerProgram, video: {}, audio: {},
  };
  rejectNext(new Error("playback_generation_mismatch"));
  await pending;
  return {
    oldGeneration, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    pendingGeneration: state.pendingSongTransitionGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  };
}

async function runAcceptedInverseResponse() {
  Object.assign(state, {
    data: {
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem], state_revision: 1,
      player_settings: { song_advance_delay_seconds: 3 },
    },
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  });
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  state.hostPlaybackSession = {
    phase: "playing", playbackGeneration: 9, playbackProgram: programA,
    video: {}, audio: {},
  };
  const originalApply = applyFreshStateSnapshot;
  applyFreshStateSnapshot = (snapshot) => snapshot?.inverse
    ? false
    : originalApply(snapshot);
  const pending = requestNextTrack();
  const acceptedItem = { id: "B" };
  const acceptedProgram = {
    item_id: "B", selected_audio_variant_id: "instrumental",
    artifact_set_id: "set-b1",
  };
  state.data = {
    playback_generation: 10, playback_program: acceptedProgram,
    current_item: acceptedItem, playlist: [], state_revision: 3,
    player_settings: { song_advance_delay_seconds: 3 },
  };
  resolveNext({ inverse: true });
  const accepted = await pending;
  applyFreshStateSnapshot = originalApply;
  return {
    accepted, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    pendingGeneration: state.pendingSongTransitionGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  };
}
console.log(JSON.stringify({
  variant: await runReplacement("vocal", "set-a1"),
  artifact: await runReplacement("instrumental", "set-a2"),
  network: await runNetworkFailure(),
  newerTransition: await runNewerTransition(),
  acceptedInverse: await runAcceptedInverseResponse(),
}));
`)));
expected = {["heldBeforeReplacement"]: true, ["holdItem"]: "", ["holdGeneration"]: 0, ["pendingOverlay"]: null, ["delayTimer"]: null, ["countdownTimer"]: null, ["deadline"]: 0, ["inFlight"]: false, ["replacementPairEffects"]: 0, ["syncCalls"]: 0, ["apiCalls"]: 1};
assert.deepEqual(result["variant"], expected);
assert.deepEqual(result["artifact"], expected);
assert.deepEqual(result["network"], {["holdItem"]: "", ["holdGeneration"]: 0, ["inFlight"]: false, ["shouldPlay"]: true, ["replacementPairEffects"]: 1, ["syncCalls"]: 1, ["apiCalls"]: 1});
assert.deepEqual(result["newerTransition"], {["oldGeneration"]: 1, ["holdItem"]: "C", ["holdGeneration"]: 2, ["pendingItem"]: "C", ["pendingGeneration"]: 2, ["inFlight"]: true, ["shouldPlay"]: false, ["replacementPairEffects"]: 0, ["syncCalls"]: 0, ["apiCalls"]: 1});
assert.deepEqual(result["acceptedInverse"], {["accepted"]: true, ["holdItem"]: "B", ["holdGeneration"]: 1, ["pendingItem"]: "B", ["pendingGeneration"]: 1, ["inFlight"]: true, ["shouldPlay"]: false, ["replacementPairEffects"]: 0, ["syncCalls"]: 0, ["apiCalls"]: 1});
},
async test_stale_next_first_carrier_accepts_new_program_but_reports_no_effect() {
let advance_functions, api_functions, clear_delay, completed, hold_functions, maybe_transition, result, script, snapshot_functions;
api_functions = (await this.source_slice("async function parseApiResponse", "function submitSongRating"));
snapshot_functions = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
hold_functions = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
maybe_transition = (await this.source_slice("function maybeShowSongTransitionOverlay", "function hasPendingSongTransitionOverlayForItem"));
clear_delay = (await this.source_slice("function clearLocalAdvanceDelay", "function teardownMountedPlayer"));
advance_functions = (await this.source_slice("async function advanceLocalPlayerNow", "async function reorderPlaylist"));
script = (`
const window = {
  location: { href: "http://127.0.0.1:8080/" },
  setTimeout,
  clearTimeout,
  clearInterval,
};
const oldItem = item("A", "i-a", "a-1");
const nextItem = item("B", "i-b", "b-1");
const replacementItem = item("A", "i-a", "a-2");
const initial = snapshot(9, 9, 9, oldItem, [nextItem]);
const replacement = snapshot(10, 10, 10, replacementItem, [nextItem]);
const state = {
  data: null,
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
  localShouldBePlaying: true,
  localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localAdvanceDelayTimer: null,
  localAdvanceCountdownTimer: null,
  localAdvanceDelayStartAt: 0,
  localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0,
  localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null,
  localAdvanceOverlayTotalCount: null,
  localAdvanceDelayItemId: "",
  localAdvanceDelayToken: 0,
  songTransitionGeneration: 0,
  manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
  lastSongTransitionOverlayKey: "",
};
function syncLocalPlayerSettingsFromSnapshot(settings) { state.syncedPlayerSettings = settings; }
let responseSnapshotAccepted = false;
let reconciliationCount = 0;
let nextRequests = 0;
let heldBeforeResponse = false;
let renderCount = 0;
let syncCalls = 0;

function item(id, incarnation, artifact) {
  return {
    id,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: "instrumental",
    artifact_set_id: artifact,
    video_media_url: \`/media/\${artifact}/video.mp4\`,
    audio_variants: [{
      id: "instrumental",
      audio_url: \`/media/\${artifact}/instrumental.m4a\`,
    }],
  };
}
function snapshot(stateRevision, revision, generation, currentItem, playlist) {
  return {
    state_revision: stateRevision,
    revision,
    playback_generation: generation,
    playback_program: {
      item_id: currentItem.id,
      item_incarnation_id: currentItem.item_incarnation_id,
      selected_audio_variant_id: currentItem.selected_audio_variant_id,
      artifact_set_id: currentItem.artifact_set_id,
    },
    current_item: currentItem,
    playlist,
    playback_mode: "local",
    player_settings: { song_advance_delay_seconds: 3 },
  };
}
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function queuedNextItem() { return state.data?.playlist?.[0] || null; }
function manualTransitionOverlaySeconds() { return 3; }
function currentSongAdvanceDelaySeconds() { return 3; }
function hasLocalAdvanceDelayOverlay() {
  return Boolean(
    state.localAdvanceDelayDeadline
    || state.localAdvanceDelayStartAt
    || state.localAdvanceDelayTimer
    || state.localAdvanceCountdownTimer
  );
}
function hidePlayerDelayOverlay() {}
function clientHeaders(headers) { return headers; }
function localizedApiMessage(message) { return String(message || ""); }
function t(key) { return key; }
function frontendPlaybackMode(mode) { return mode || "local"; }
function setAppMessage() {}
function render() { renderCount += 1; }
function syncMountedLocalPlayer() { syncCalls += 1; }
function isCurrentHostPlaybackSession(session) {
  return Boolean(
    session
    && state.hostPlaybackSession === session
    && session.playbackGeneration === state.data?.playback_generation
    && playbackProgramDescriptorsEqual(session.playbackProgram, state.data?.playback_program)
  );
}
function renderPlayer(currentItem) {
  reconciliationCount += 1;
  state.hostPlaybackSession = {
    phase: "playing",
    playbackGeneration: state.data.playback_generation,
    playbackProgram: state.data.playback_program,
    video: { paused: false },
    audio: { paused: false },
    readyCommitted: true,
  };
  state.localShouldBePlaying = !shouldHoldCurrentItemForTransition(currentItem);
}
async function fetch(url, options) {
  nextRequests += 1;
  heldBeforeResponse = Boolean(
    url === "/api/player/next"
    && JSON.parse(options.body).playback_generation === 9
    && state.localAdvanceInFlight
    && state.manualTransitionHoldItemId === "B"
  );
  return {
    status: 200,
    ok: true,
    url: \`http://127.0.0.1:8080\${url}\`,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true, stale: true, data: replacement }),
  };
}
` + String(api_functions) + `
function maybeShowIncomingRequestToast() {}
` + String(snapshot_functions) + `
` + String(hold_functions) + `
` + String(maybe_transition) + `
` + String(clear_delay) + `
` + String(advance_functions) + `

(async () => {
  if (!acceptHostStateSnapshot(initial)) throw new Error("initial snapshot rejected");
  await Promise.resolve();
  reconciliationCount = 0;
  responseSnapshotAccepted = state.data === initial;
  const applied = await requestNextTrack();
  await Promise.resolve();
  responseSnapshotAccepted = responseSnapshotAccepted && state.data === replacement;
  process.stdout.write(JSON.stringify({
    applied,
    responseSnapshotAccepted,
    reconciledGeneration: state.hostPlaybackSession?.playbackGeneration || 0,
    reconciledItem: state.hostPlaybackSession?.playbackProgram?.item_id || "",
    playable: Boolean(
      state.hostPlaybackSession?.readyCommitted
      && state.hostPlaybackSession?.video?.paused === false
      && state.hostPlaybackSession?.audio?.paused === false
    ),
    heldBeforeResponse,
    holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    pendingGeneration: state.pendingSongTransitionGeneration,
    delayItem: state.localAdvanceDelayItemId,
    deadline: state.localAdvanceDelayDeadline,
    delayTimer: state.localAdvanceDelayTimer,
    countdownTimer: state.localAdvanceCountdownTimer,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    reconciliationCount,
    nextRequests,
    renderCount,
    syncCalls,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNative("node", ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result, {["applied"]: false, ["responseSnapshotAccepted"]: true, ["reconciledGeneration"]: 10, ["reconciledItem"]: "A", ["playable"]: true, ["heldBeforeResponse"]: true, ["holdItem"]: "", ["holdGeneration"]: 0, ["pendingItem"]: "", ["pendingGeneration"]: 0, ["delayItem"]: "", ["deadline"]: 0, ["delayTimer"]: null, ["countdownTimer"]: null, ["inFlight"]: false, ["shouldPlay"]: true, ["reconciliationCount"]: 1, ["nextRequests"]: 1, ["renderCount"]: 0, ["syncCalls"]: 0});
},
async test_inverse_play_now_responses_cannot_restore_an_older_current_item() {
let freshness, playlist_action, result;
freshness = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
playlist_action = (await this.source_slice("async function handlePlaylistAction", "elements.addForm.addEventListener"));
result = (await this.run_node((`
const state = {
  data: snapshot(1, 1, 1, "song-a", "i-a", "a-a"),
  localShouldBePlaying: true,
  localAdvanceInFlight: false,
};
const window = { location: { href: "http://127.0.0.1:8080/" } };
function snapshot(stateRevision, revision, generation, itemId, incarnation, artifact) {
  const variantId = "instrumental";
  const currentItem = {
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: variantId,
    artifact_set_id: artifact,
    video_media_url: \`/media/\${artifact}/video.mp4\`,
    audio_variants: [{ id: variantId, audio_url: \`/media/\${artifact}/audio.m4a\` }],
  };
  return {
    state_revision: stateRevision,
    revision,
    playback_generation: generation,
    playback_program: {
      item_id: itemId,
      item_incarnation_id: incarnation,
      selected_audio_variant_id: variantId,
      artifact_set_id: artifact,
    },
    current_item: currentItem,
  };
}
class Button {
  constructor(id) {
    this.dataset = { id, action: "play-now" };
    this.disabled = false;
    this.attributes = new Map();
  }
  getAttribute(name) { return this.attributes.get(name) || null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}
const pending = new Map();
function apiPost(_url, payload) {
  return new Promise((resolve) => pending.set(payload.item_id, resolve));
}
function manualTransitionOverlaySeconds() { return 0; }
function shouldHoldCurrentItemForTransition() { return false; }
function closeOpenMenus() {}
function setAppMessage(message) { throw new Error(message); }
const rendered = [];
const playerReconciled = [];
function render() { rendered.push(state.data.current_item.id); }
function renderPlayer() { playerReconciled.push(state.data.current_item.id); }
function frontendPlaybackMode(mode) { return mode || "local"; }
function clearLocalAdvanceDelay() {}
function registerManualTransitionHold() { return 0; }
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() {}
function syncLocalPlayerSettingsFromSnapshot(settings) { state.syncedPlayerSettings = settings; }
function syncMountedLocalPlayer() {}
` + String(freshness) + `
` + String(playlist_action) + `
const playB = handlePlaylistAction(new Button("song-b"));
const playC = handlePlaylistAction(new Button("song-c"));
pending.get("song-c")(snapshot(3, 3, 3, "song-c", "i-c", "a-c"));
await Promise.resolve();
pending.get("song-b")(snapshot(2, 2, 2, "song-b", "i-b", "a-b"));
await Promise.all([playB, playC]);
console.log(JSON.stringify({
  current: state.data.current_item.id,
  revision: state.data.state_revision,
  rendered,
  playerReconciled,
}));
`)));
assert.deepEqual(result, {["current"]: "song-c", ["revision"]: 3, ["rendered"]: ["song-c"], ["playerReconciled"]: ["song-c"]});
},
async test_polling_same_transition_does_not_register_again() {
let hold_functions, maybe_function, result;
hold_functions = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
maybe_function = (await this.source_slice("function maybeShowSongTransitionOverlay", "function hasPendingSongTransitionOverlayForItem"));
result = (await this.run_node((`
const previous = { current_item: { id: "old" }, state_revision: 1 };
const next = { current_item: { id: "next", title: "Next" }, state_revision: 2 };
const state = {
  data: next, localShouldBePlaying: true,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  lastSongTransitionOverlayKey: "", songTransitionGeneration: 0,
  manualTransitionHoldItemId: "", manualTransitionHoldGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function manualTransitionOverlaySeconds() { return 3; }
function hasLocalAdvanceDelayOverlay() { return false; }
function clearLocalAdvanceDelay() {}
` + String(hold_functions) + `
` + String(maybe_function) + `
maybeShowSongTransitionOverlay(previous, next);
const firstGeneration = state.manualTransitionHoldGeneration;
maybeShowSongTransitionOverlay(previous, next);
console.log(JSON.stringify({
  firstGeneration,
  finalGeneration: state.manualTransitionHoldGeneration,
  pendingItem: state.pendingSongTransitionOverlayData.current_item.id,
}));
`)));
assert.deepEqual(result, {["firstGeneration"]: 1, ["finalGeneration"]: 1, ["pendingItem"]: "next"});
},
async test_delayed_responses_do_not_restart_a_completed_transition() {
let advance, carrier, clear_delay, holds, playlist_action, polling, remote_access_failure, result, snapshots, transitions;
snapshots = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
polling = (await this.source_slice("async function fetchState", "function renderSignatureForData"));
remote_access_failure = (await this.source_slice("function updateRemoteAccessFailure", "function localRemoteAccessView"));
holds = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
transitions = (await this.source_slice("function maybeShowSongTransitionOverlay", "function hasPendingSongTransitionOverlayForItem"));
clear_delay = (await this.source_slice("function clearLocalAdvanceDelay", "function teardownMountedPlayer"));
advance = (await this.source_slice("async function advanceLocalPlayerNow", "async function requestNextTrack"));
playlist_action = (await this.source_slice("async function handlePlaylistAction", "elements.addForm.addEventListener(\"submit\""));
for (const carrier of iterableValues(["poll", "next", "next-newer-snapshot", "play-now"])) {
{
result = (await this.run_node((`
const window = { location: { href: "http://127.0.0.1/" }, clearTimeout, clearInterval };
function item(id) {
  return {
    id, item_incarnation_id: \`i-\${id}\`, artifact_set_id: \`a-\${id}\`,
    selected_audio_variant_id: "vocal", video_media_url: \`/media/\${id}/video.mp4\`,
    audio_variants: [{ id: "vocal", audio_url: \`/media/\${id}/audio.m4a\` }],
  };
}
const oldItem = item("old");
const nextItem = item("next");
function snapshot(revision, current, generation) {
  return {
    state_revision: revision, revision, playback_generation: generation,
    current_item: current, playlist: current === oldItem ? [nextItem] : [],
    playback_program: {
      item_id: current.id, item_incarnation_id: current.item_incarnation_id,
      artifact_set_id: current.artifact_set_id, selected_audio_variant_id: "vocal",
    },
    player_settings: { song_advance_delay_seconds: 3 },
  };
}
const state = {
  data: snapshot(1, oldItem, 1), localPreferencesHydrated: true,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localShouldBePlaying: true, localAdvanceInFlight: false, localAdvanceDelayToken: 0,
  manualTransitionHoldItemId: "", manualTransitionHoldGeneration: 0,
  songTransitionGeneration: 0, lastSongTransitionOverlayKey: "",
  remoteAccessFailure: null, remoteAccessRequestSequence: 0, remoteAccessOutcomeSequence: 0,
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function queuedNextItem() { return state.data.playlist[0]; }
function manualTransitionOverlaySeconds() { return 3; }
function hasLocalAdvanceDelayOverlay() { return false; }
function hidePlayerDelayOverlay() {}
function closeOpenMenus() {}
function renderPlayer() {}
function renderRemoteAccess() {}
function publishPresentationOutputState() {}
function frontendPlaybackMode() { return "local"; }
function isCurrentHostPlaybackSession() { return false; }
function render() {}
function setAppMessage(message) { throw new Error(message); }
function syncMountedLocalPlayer() {}
function currentAvOffsetMs() { return 0; }
function clientHeaders() { return {}; }
function parseApiResponse(response) { return response.json(); }
function scheduleStartupAppUpdateCheck() {}
function maybeShowIncomingRequestToast() {}
function syncLocalPlayerSettingsFromSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function renderSignatureForData(data) { return String(data.state_revision); }
function resyncMountedLocalPlayerIfOffsetChanged() {}
function hasDownloadingItems() { return false; }
let respond;
function fetch() { return new Promise(resolve => { respond = resolve; }); }
function apiPost() { return new Promise(resolve => { respond = resolve; }); }
` + String(snapshots) + `
` + String(remote_access_failure) + `
` + String(polling) + `
` + String(holds) + `
` + String(transitions) + `
` + String(clear_delay) + `
` + String(advance) + `
` + String(playlist_action) + `
const carrier = ` + String(JSON.stringify(carrier)) + `;
const button = {
  dataset: { id: "next", action: "play-now" }, disabled: false,
  getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
};
const pending = carrier === "poll" ? fetchState()
  : carrier === "play-now" ? handlePlaylistAction(button) : advanceLocalPlayerNow();
// Another response delivers the switch while the original request is pending.
acceptHostStateSnapshot(snapshot(2, nextItem, 2));
await Promise.resolve();
const firstTransition = state.pendingSongTransitionGeneration;
// Its countdown finishes and the exact mounted pair is now playing.
state.pendingSongTransitionOverlayData = null;
state.pendingSongTransitionGeneration = 0;
clearLocalAdvanceDelay({ resetInFlight: true });
state.localShouldBePlaying = true;
const payload = carrier === "next" ? snapshot(2, nextItem, 2) : snapshot(3, nextItem, 2);
respond(carrier === "poll"
  ? { ok: true, json: async () => ({ ok: true, data: payload }) }
  : carrier === "play-now" ? payload : { data: payload, stale: false });
const applied = await pending;
console.log(JSON.stringify({
  applied: applied ?? null, firstTransition, shouldPlay: state.localShouldBePlaying,
  pending: Boolean(state.pendingSongTransitionOverlayData),
  holdGeneration: state.manualTransitionHoldGeneration,
  inFlight: state.localAdvanceInFlight, itemId: state.data.current_item.id,
  revision: state.data.state_revision,
}));
`)));
assert.deepEqual(result, {["applied"]: (((carrier === "play-now")) ? null : true), ["firstTransition"]: 1, ["shouldPlay"]: true, ["pending"]: false, ["holdGeneration"]: 0, ["inFlight"]: false, ["itemId"]: "next", ["revision"]: (((carrier === "next")) ? 2 : 3)});
}
}
},
async test_stale_completion_cannot_resume_newer_item_and_valid_completion_runs_once() {
let result, resume_function;
resume_function = (await this.source_slice("function resumeMountedPlayerAfterOverlay", "function shouldHoldCurrentItemForTransition"));
result = (await this.run_node((`
const video = { dataset: { playerItemId: "new" } }; const audio = {};
const oldVideo = { dataset: { playerItemId: "new" } }; const oldAudio = {};
const program = {
  item_id: "new", item_incarnation_id: "i-new",
  selected_audio_variant_id: "v", artifact_set_id: "a",
};
const oldSession = {
  playbackGeneration: 1, playbackProgram: program, phase: "retired",
  video: oldVideo, audio: oldAudio,
};
const currentSession = {
  playbackGeneration: 2, playbackProgram: program, phase: "paused",
  readyCommitted: true, initialIntentApplied: true, video, audio,
};
const state = {
  data: {
    current_item: { id: "new" },
    playback_generation: 2,
    playback_program: program,
  },
  hostPlaybackSession: currentSession,
  manualTransitionHoldItemId: "new", manualTransitionHoldGeneration: 2,
  localShouldBePlaying: false, localPlaybackStartState: "established",
};
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function activeLocalPlayerElements() { return { video, audio }; }
function isCurrentHostPlaybackSession(session, exactVideo, exactAudio) {
  return session === state.hostPlaybackSession
    && session?.phase !== "retiring"
    && session?.phase !== "retired"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && (exactVideo === undefined || session.video === exactVideo)
    && (exactAudio === undefined || session.audio === exactAudio);
}
let stale = 0; let syncs = 0; let clears = 0;
function reportSplitSyncDiagnostic() { stale += 1; }
function clearLocalAdvanceDelay() {
  clears += 1; state.manualTransitionHoldItemId = "";
  state.manualTransitionHoldGeneration = 0;
}
function setSplitPlaybackIntent() { syncs += 1; return true; }
function startSplitPlaybackPair() { syncs += 1; return true; }
function applyInitialHostPlaybackIntent() { syncs += 1; return true; }
function updateSplitPlaybackStartOverlay() {}
function currentAvOffsetSeconds() { return 0; }
` + String(resume_function) + `
resumeMountedPlayerAfterOverlay("new", 2, oldSession);
resumeMountedPlayerAfterOverlay("new", 2, currentSession);
resumeMountedPlayerAfterOverlay("new", 2, currentSession);
console.log(JSON.stringify({ stale, syncs, clears, shouldPlay: state.localShouldBePlaying }));
`)));
assert.deepEqual(result, {["stale"]: 1, ["syncs"]: 1, ["clears"]: 1, ["shouldPlay"]: true});
},
async test_same_item_replacement_rebinds_active_countdown_to_the_new_session() {
let clear_delay, equality, has_overlay, hold, phase_helper, replacement, result, resume, sessions, show;
equality = (await this.source_slice("function playbackProgramDescriptorsEqual", "function isValidHostMediaLocator"));
resume = (await this.source_slice("function resumeMountedPlayerAfterOverlay", "function shouldHoldCurrentItemForTransition"));
show = (await this.source_slice("function showSongTransitionOverlayForData", "function maybeShowSongTransitionOverlay"));
has_overlay = (await this.source_slice("function hasLocalAdvanceDelayOverlay", "function clearLocalAdvanceDelay"));
hold = (await this.source_slice("function shouldHoldCurrentItemForTransition", "function stopMountedPlayerForAdvanceDelay"));
clear_delay = (await this.source_slice("function clearLocalAdvanceDelay", "function teardownMountedPlayer"));
sessions = (await this.source_slice("function hostPlaybackMountData", "function renderPlayer"));
phase_helper = (await this.source_slice("function setHostPlaybackSessionPhase", "Object.defineProperty"));
result = (await this.run_node((`
const localAdvanceOverlayFadeMs = 500;
let now = 1000;
const timers = [];
const intervals = [];
const window = {
  setTimeout(callback, delay) {
    const timer = { callback, delay, active: true };
    timers.push(timer);
    return timer;
  },
  clearTimeout(timer) { if (timer) timer.active = false; },
  setInterval(callback, delay) {
    const timer = { callback, delay, active: true };
    intervals.push(timer);
    return timer;
  },
  clearInterval(timer) { if (timer) timer.active = false; },
};
Date.now = () => now;

class FakeMedia {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.currentTime = 12;
    this.paused = true;
    this.attributes = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
  pause() { this.paused = true; }
  load() {}
}
class FakeFrame {
  constructor() { this.children = []; }
  querySelector() { return null; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  appendChild(node) { this.children.push(node); return node; }
}
const document = { createElement: (tagName) => new FakeMedia(tagName) };
const elements = { playerFrame: new FakeFrame() };
const state = {
  data: null,
  hostPlaybackSession: null,
  hostPlaybackBootstrapRestartPending: false,
  pageHidePlaybackRestartRequired: false,
  pendingPlaybackRestore: null,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localAdvanceDelayTimer: null,
  localAdvanceCountdownTimer: null,
  localAdvanceDelayStartAt: 0,
  localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0,
  localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null,
  localAdvanceOverlayTotalCount: null,
  localAdvanceDelayItemId: "",
  localAdvanceDelayToken: 0,
  localAdvanceInFlight: false,
  manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
  localShouldBePlaying: true,
  localPlaybackStartState: "established",
};
let updates = 0;
let resumes = 0;
let syncs = 0;
function currentItemIdFromData(data) { return String(data?.current_item?.id || ""); }
function manualTransitionOverlaySeconds() { return 3; }
function updateLocalAdvanceDelayOverlay() { updates += 1; return true; }
function hidePlayerDelayOverlay({ onHidden = null } = {}) { onHidden?.(); }
function activeLocalPlayerElements() {
  const session = state.hostPlaybackSession;
  return { video: session?.video || null, audio: session?.audio || null };
}
function syncSplitPlayer() { syncs += 1; }
function startSplitPlaybackPair() { syncs += 1; }
function currentAvOffsetSeconds() { return 0; }
function selectedVideoUrlForItem(item) { return item.video_media_url; }
function selectedAudioUrlForItem(item) {
  return item.audio_variants.find((variant) => variant.id === item.selected_audio_variant_id)?.audio_url || "";
}
function playerDelayOverlay() { return null; }
function hasPendingSongTransitionOverlayForItem() { return false; }
function captureLocalPlayerPreferences() {}
function renderEmptyHostPlaybackState() { elements.playerFrame.replaceChildren(); }
function renderPreparingHostPlaybackState() { elements.playerFrame.replaceChildren(); }
function clearLocalPlayerEventListeners() {}
function clearWebKitAudioStarvationTimer() {}
function clearLocalPlayerSyncTimer() {}
function clearPlayerFrameClickTimer() {}
function clearLocalPlayerSeekState() {}
function clearLocalPlayerControlsHideTimer() {}
function clearTauriMediaSessionState() {}
function disposeAudioPitchShifter() {}
function t(key) { return key; }
function apiPost() { return Promise.resolve({ ok: true }); }
` + String(equality) + `
` + String(resume) + `
` + String(hold) + `
` + String(show) + `
` + String(has_overlay) + `
` + String(clear_delay) + `
` + String(phase_helper) + `
` + String(sessions) + `

function item(artifact, variant) {
  return {
    id: "song-b",
    item_incarnation_id: "inc-b",
    selected_audio_variant_id: variant,
    artifact_set_id: artifact,
    video_media_url: \`/media/\${artifact}/video.mp4\`,
    audio_variants: [
      { id: "instrumental", audio_url: \`/media/\${artifact}/instrumental.m4a\` },
      { id: "vocal", audio_url: \`/media/\${artifact}/vocal.m4a\` },
    ],
  };
}
function program(artifact, variant) {
  return {
    item_id: "song-b",
    item_incarnation_id: "inc-b",
    selected_audio_variant_id: variant,
    artifact_set_id: artifact,
  };
}
function runReplacement(nextArtifact, nextVariant) {
  now = 1000;
  timers.length = 0;
  intervals.length = 0;
  resumes = 0;
  syncs = 0;
  Object.assign(state, {
    pendingPlaybackRestore: null,
    localAdvanceDelayTimer: null,
    localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0,
    localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0,
    localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null,
    localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "",
    localAdvanceDelayToken: 0,
    localAdvanceInFlight: false,
    manualTransitionHoldItemId: "song-b",
    manualTransitionHoldGeneration: 7,
    localShouldBePlaying: false,
    localPlaybackStartState: "established",
  });
  const firstItem = item("artifact-1", "instrumental");
  const firstProgram = program("artifact-1", "instrumental");
  state.data = {
    playback_generation: 10,
    playback_program: firstProgram,
    current_item: firstItem,
    playlist: [],
  };
  const firstSession = createHostPlaybackSession(10, firstProgram);
  state.hostPlaybackSession = firstSession;
  mountHostPlaybackSessionElements(firstSession, firstItem, hostPlaybackMountData(firstItem, firstProgram));
  showSongTransitionOverlayForData(state.data, 7);
  const originalDeadline = state.localAdvanceDelayDeadline;
  const oldTimer = state.localAdvanceDelayTimer;

  now = 2000;
  const replacementItem = item(nextArtifact, nextVariant);
  const replacementProgram = program(nextArtifact, nextVariant);
  state.data = {
    playback_generation: 11,
    playback_program: replacementProgram,
    current_item: replacementItem,
    playlist: [],
  };
  const reconciliation = reconcileHostPlaybackSession(replacementItem);
  const replacementSession = state.hostPlaybackSession;
  const reboundTimer = state.localAdvanceDelayTimer;

  now = originalDeadline;
  oldTimer.callback();
  const afterOld = {
    session: state.hostPlaybackSession === replacementSession,
    inFlight: state.localAdvanceInFlight,
    resumes,
  };
  reboundTimer.callback();
  reboundTimer.callback();
  return {
    kind: reconciliation.kind,
    oldRetired: firstSession.phase,
    rebound: reboundTimer !== oldTimer,
    remainingDelay: reboundTimer.delay,
    deadlinePreserved: originalDeadline === 4500,
    afterOld,
    final: {
      inFlight: state.localAdvanceInFlight,
      holdItem: state.manualTransitionHoldItemId,
      deadline: state.localAdvanceDelayDeadline,
      shouldPlay: state.localShouldBePlaying,
      resumes,
      syncs,
      media: elements.playerFrame.children.map((node) => node.tagName),
    },
  };
}

const originalResume = resumeMountedPlayerAfterOverlay;
resumeMountedPlayerAfterOverlay = (...args) => {
  const resumed = originalResume(...args);
  if (resumed) resumes += 1;
  return resumed;
};
console.log(JSON.stringify({
  artifact: runReplacement("artifact-2", "instrumental"),
  variant: runReplacement("artifact-1", "vocal"),
}));
`)));
for (const replacement of iterableValues([result["artifact"], result["variant"]])) {
assert.deepEqual(replacement["kind"], "mounted");
assert.deepEqual(replacement["oldRetired"], "retired");
assert.ok(hasContent(replacement["rebound"]));
assert.deepEqual(replacement["remainingDelay"], 2500);
assert.ok(hasContent(replacement["deadlinePreserved"]));
assert.deepEqual(replacement["afterOld"], {["session"]: true, ["inFlight"]: true, ["resumes"]: 0});
assert.deepEqual(replacement["final"], {["inFlight"]: false, ["holdItem"]: "", ["deadline"]: 0, ["shouldPlay"]: true, ["resumes"]: 1, ["syncs"]: 0, ["media"]: ["VIDEO", "AUDIO"]});
}
},
async test_configured_countdown_holds_correct_item_and_resumes_once() {
let result, show_function;
show_function = (await this.source_slice("function showSongTransitionOverlayForData", "function maybeShowSongTransitionOverlay"));
result = (await this.run_node((`
const item = { id: "next", title: "Next song" };
const video = { dataset: { playerItemId: "next" } };
const audio = {};
const session = { phase: "playing", video, audio };
const state = {
  data: { current_item: item }, hostPlaybackSession: session,
  localAdvanceDelayToken: 4, localAdvanceInFlight: false,
  localAdvanceCountdownTimer: null, localAdvanceDelayTimer: null,
  manualTransitionHoldItemId: "next", manualTransitionHoldGeneration: 7,
  localShouldBePlaying: true,
};
const localAdvanceOverlayFadeMs = 200;
const timers = []; const intervals = []; let updates = 0; let resumes = 0;
const window = {
  setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
  clearInterval() {},
};
Date.now = () => 1000;
function manualTransitionOverlaySeconds() { return 3; }
function isCurrentHostPlaybackSession(candidate, exactVideo, exactAudio) {
  return candidate === state.hostPlaybackSession
    && candidate?.phase === "playing"
    && (exactVideo === undefined || candidate.video === exactVideo)
    && (exactAudio === undefined || candidate.audio === exactAudio);
}
function clearLocalAdvanceDelay({ resetInFlight = false } = {}) {
  state.localAdvanceDelayToken += 1;
  if (resetInFlight) state.localAdvanceInFlight = false;
}
function updateLocalAdvanceDelayOverlay() { updates += 1; }
function registerManualTransitionHold() { return 7; }
function hidePlayerDelayOverlay({ onHidden }) { onHidden(); }
function resumeMountedPlayerAfterOverlay(itemId, generation) {
  if (itemId === "next" && generation === 7) {
    resumes += 1;
    state.manualTransitionHoldItemId = "";
    state.manualTransitionHoldGeneration = 0;
    state.localAdvanceInFlight = false;
  }
}
` + String(show_function) + `
showSongTransitionOverlayForData({
  current_item: item,
  playlist: [{ id: "later" }],
  player_settings: { song_advance_delay_seconds: 3 },
}, 7);
const held = state.localShouldBePlaying === false;
const delay = timers[0].delay;
timers[0].callback();
timers[0].callback();
console.log(JSON.stringify({
  held, delay, resumes, updates,
  itemId: state.localAdvanceDelayItemId,
  inFlight: state.localAdvanceInFlight,
}));
`)));
assert.deepEqual(result["delay"], 3200);
assert.ok(hasContent(result["held"]));
assert.deepEqual(result["resumes"], 1);
assert.deepEqual(result["itemId"], "next");
assert.ok(!hasContent(result["inFlight"]));
assert.ok(result["updates"] >= 2);
},
async test_all_mount_and_recovery_paths_use_authoritative_hold() {
let initial_intent, renderer, sync;
renderer = (await this.source_slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl"));
initial_intent = (await this.source_slice("function applyInitialHostPlaybackIntent", "function commitHostPlaybackSessionReadyPaused"));
sync = (await this.source_slice("function syncSplitPlayer", "function syncMountedLocalPlayer"));
assert.ok(contains("session.logicalPlayIntent", initial_intent));
assert.ok(contains("session.initialIntentApplied", initial_intent));
assert.ok(contains("shouldHoldCurrentItemForTransition(video.dataset.playerItemId)", initial_intent));
assert.ok(contains("shouldHoldCurrentItemForTransition(currentItem)", renderer));
assert.ok(contains("shouldHoldCurrentItemForTransition(video.dataset.playerItemId)", sync));
assert.ok(contains("return reportAction(\"transition-hold\")", sync));
assert.ok(contains("pendingSongTransitionGeneration", this.source));
assert.ok(contains("registerManualTransitionHold(nextItemId)", this.source));
assert.ok(contains("generation: transitionGeneration", this.source));
assert.ok(contains("requestNextTrack().catch(() => {})", this.source));
assert.ok(contains("action === \"play-now\"", this.source));
assert.ok(contains("state.pendingSongTransitionOverlayData = null", (await this.source_slice("function retireHostPlaybackSession", "function replaceHostPlayerView"))));
},
async test_all_next_surfaces_share_the_exact_rust_generation_transport() {
let advance, controller, ended, media_session, playback_ended, remote_control, remote_next, remote_next_end, remote_next_start, remote_source;
advance = (await this.source_slice("async function advanceLocalPlayerNow", "async function reorderPlaylist"));
media_session = (await this.source_slice("function handleTauriMediaSessionAction", "function ensureTauriMediaSessionHandlers"));
controller = (await this.source_slice("async function applyControllerCommand", "function presentationPlaybackStateModel"));
remote_control = (await this.source_slice("function applyRemotePlayerControl", "async function ackRemotePlayerControl"));
ended = (await this.source_slice("async function handleSplitAudioEnded", "function holdVideoForAudio"));
playback_ended = (await this.source_slice("async function handleLocalPlaybackEnded", "async function reorderPlaylist"));
remote_source = readFileSync(path.join(path.join(path.resolve(path.resolve(__file__), "..", ".."), "static"), "remote.js"), "utf8");
remote_next_start = sourceIndex(remote_source, "async function sendPlayerNext");
remote_next_end = sourceIndex(remote_source, "function disconnectClient", remote_next_start);
remote_next = remote_source.slice(remote_next_start, remote_next_end);
assert.ok(contains("session?.playbackGeneration", advance));
assert.ok(contains("playback_generation: expectedPlaybackGeneration", advance));
assert.ok(contains("apiPostExactStateCommand(\"/api/player/next\", {", advance));
assert.ok(contains("handleLocalPlaybackEnded(\"media-ended\", endingSession)", ended));
assert.ok(contains("const endingSession = state.hostPlaybackSession", ended));
assert.ok(contains("isActiveSplitPlayer(video, audio)", splitOnce(ended, "await audio.bilikaraPitch.drain()")[1]));
assert.ok(contains("return advanceLocalPlayerNow({", playback_ended));
assert.ok(contains("isCurrentHostPlaybackSession(session, session.video, session.audio)", playback_ended));
assert.ok(contains("expectedPlaybackGeneration,", playback_ended));
assert.ok(contains("requestNextTrack().catch(() => {})", media_session));
assert.ok(contains("case \"nextTrack\"", controller));
assert.ok(contains("await requestNextTrack(expectedPlaybackGeneration)", controller));
assert.ok(contains("action === \"next-track\"", remote_control));
assert.ok(contains("requestNextTrack(expectedPlaybackGeneration).catch(() => {})", remote_control));
assert.ok(contains("state.data.playback_generation", remote_next));
assert.ok(contains("playback_generation: expectedPlaybackGeneration", remote_next));
}
};
test("SongTransitionFrontendTest.test_configured_zero_delay_is_not_replaced_with_default", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_configured_zero_delay_is_not_replaced_with_default(); });
test("SongTransitionFrontendTest.test_manual_next_registers_hold_before_backend_and_deduplicates_races", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_manual_next_registers_hold_before_backend_and_deduplicates_races(); });
test("SongTransitionFrontendTest.test_manual_next_zero_delay_mutates_once_without_hold", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_manual_next_zero_delay_mutates_once_without_hold(); });
test("SongTransitionFrontendTest.test_stale_next_releases_only_its_transition_after_program_replacement", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_stale_next_releases_only_its_transition_after_program_replacement(); });
test("SongTransitionFrontendTest.test_stale_next_first_carrier_accepts_new_program_but_reports_no_effect", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_stale_next_first_carrier_accepts_new_program_but_reports_no_effect(); });
test("SongTransitionFrontendTest.test_inverse_play_now_responses_cannot_restore_an_older_current_item", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_inverse_play_now_responses_cannot_restore_an_older_current_item(); });
test("SongTransitionFrontendTest.test_polling_same_transition_does_not_register_again", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_polling_same_transition_does_not_register_again(); });
test("SongTransitionFrontendTest.test_delayed_responses_do_not_restart_a_completed_transition", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_delayed_responses_do_not_restart_a_completed_transition(); });
test("SongTransitionFrontendTest.test_stale_completion_cannot_resume_newer_item_and_valid_completion_runs_once", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_stale_completion_cannot_resume_newer_item_and_valid_completion_runs_once(); });
test("SongTransitionFrontendTest.test_same_item_replacement_rebinds_active_countdown_to_the_new_session", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_same_item_replacement_rebinds_active_countdown_to_the_new_session(); });
test("SongTransitionFrontendTest.test_configured_countdown_holds_correct_item_and_resumes_once", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_configured_countdown_holds_correct_item_and_resumes_once(); });
test("SongTransitionFrontendTest.test_all_mount_and_recovery_paths_use_authoritative_hold", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_all_mount_and_recovery_paths_use_authoritative_hold(); });
test("SongTransitionFrontendTest.test_all_next_surfaces_share_the_exact_rust_generation_transport", async () => { const instance = Object.create(SongTransitionFrontendTest); await instance.setUpClass(); await instance.test_all_next_surfaces_share_the_exact_rust_generation_transport(); });
