import { readSourceText as readFileSync, runNodeScript } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const HostPlaybackSessionFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
},
async source_slice(start, end) {
let start_index;
start_index = sourceIndex(this.source, start);
return this.source.slice(start_index, sourceIndex(this.source, end, start_index));
},
async test_audio_variant_request_uses_only_the_observed_item_incarnation() {
let listener;
listener = (await this.source_slice("async function handleAudioVariantSelection(event)", "elements.playlist.addEventListener(\"click\""));
assert.ok(contains("expected_item_incarnation_id: currentItem.item_incarnation_id", listener));
assert.ok(!contains("playback_generation", listener));
},
async test_stale_variant_and_retry_accept_authority_without_success_ownership() {
let audio_listener, completed, result, retry_listener, script, snapshot_functions;
snapshot_functions = (await this.source_slice("function isSafeHostSnapshotInteger", "async function apiPostStateSnapshot"));
audio_listener = (await this.source_slice("async function handleAudioVariantSelection(event)", "elements.playlist.addEventListener(\"click\""));
retry_listener = (await this.source_slice("elements.queueCurrentRetry.addEventListener(\"click\"", "// LEGACY: the online embed mode endpoint"));
script = (`
class FakeElement {
  constructor(dataset = {}) {
    this.dataset = { ...dataset };
    this.listeners = {};
    this.attributes = {};
    this.disabled = false;
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
}
const audioVariantBar = new FakeElement();
const queueCurrentRetry = new FakeElement();
const elements = { audioVariantBar, audioVariantPopover: new FakeElement(), queueCurrentRetry };
const window = {
  location: { href: "http://127.0.0.1:8080/" },
  setTimeout,
  clearTimeout,
};
const audioVariantSwitchDebounceMs = 350;
const state = {
  data: null,
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
  pendingPlaybackRestore: null,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantBarExpanded: false,
};
const messages = [];
const requests = [];
const responses = [];
let reconciliations = 0;
let renders = 0;
let retryBusyObservations = 0;
function item(incarnation, artifact, selectedVariant = "instrumental", cacheStatus = "failed") {
  return {
    id: "song-a",
    item_incarnation_id: incarnation,
    selected_audio_variant_id: selectedVariant,
    artifact_set_id: artifact,
    video_media_url: \`/media/\${artifact}/video.mp4\`,
    cache_status: cacheStatus,
    audio_variants: [
      { id: "instrumental", label: "Instrumental", audio_url: \`/media/\${artifact}/i.m4a\` },
      { id: "vocal", label: "Vocal", audio_url: \`/media/\${artifact}/v.m4a\` },
    ],
  };
}
function snapshot(revision, currentItem) {
  return {
    state_revision: revision,
    revision,
    playback_generation: revision,
    playback_mode: "local",
    playback_program: {
      item_id: currentItem.id,
      item_incarnation_id: currentItem.item_incarnation_id,
      selected_audio_variant_id: currentItem.selected_audio_variant_id,
      artifact_set_id: currentItem.artifact_set_id,
    },
    current_item: currentItem,
    playlist: [],
  };
}
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() {}
function syncLocalPlayerSettingsFromSnapshot(settings) { state.syncedPlayerSettings = settings; }
function frontendPlaybackMode() { return "local"; }
function renderPlayer() {
  reconciliations += 1;
  state.hostPlaybackSession = {
    playbackGeneration: state.data.playback_generation,
    playbackProgram: state.data.playback_program,
    video: { currentTime: 12, paused: false },
    audio: { paused: false },
    readyCommitted: true,
  };
}
function isCurrentHostPlaybackSession(session) {
  return Boolean(
    session
    && session === state.hostPlaybackSession
    && session.playbackGeneration === state.data?.playback_generation
    && playbackProgramDescriptorsEqual(session.playbackProgram, state.data?.playback_program)
  );
}
function audioVariantSwitchLocked() {
  return state.audioVariantSwitchInFlight || Date.now() < state.audioVariantSwitchUnlockAt;
}
function renderAudioVariantBar() {}
function selectedAudioVariantForItem(currentItem) {
  return currentItem.audio_variants.find(
    (variant) => variant.id === currentItem.selected_audio_variant_id
  );
}
function scheduleAudioVariantSwitchUnlock() {}
function render() { renders += 1; }
function setAppMessage(message, isError = false) { messages.push({ message, isError }); }
function t(key) { return key; }
async function apiPostExactStateCommand(path, payload) {
  requests.push({ path, payload });
  if (
    path === "/api/cache/retry"
    && queueCurrentRetry.disabled
    && queueCurrentRetry.getAttribute("aria-busy") === "true"
  ) {
    retryBusyObservations += 1;
  }
  const response = responses.shift();
  return {
    snapshotAccepted: acceptHostStateSnapshot(response.snapshot),
    commandApplied: response.applied,
  };
}
` + String(snapshot_functions) + `
` + String(audio_listener) + `
` + String(retry_listener) + `
function audioEventButton(currentItem) {
  const button = new FakeElement({
    itemId: currentItem.id,
    bound: "true",
    variantId: "vocal",
  });
  return { closest: (selector) => selector === "button[data-variant-id]" ? button : null };
}

(async () => {
  if (!acceptHostStateSnapshot(snapshot(1, item("i-1", "a-1")))) {
    throw new Error("initial rejected");
  }
  await Promise.resolve();
  reconciliations = 0;
  responses.push({ snapshot: snapshot(2, item("i-2", "a-2")), applied: false });
  await audioVariantBar.listeners.click({ target: audioEventButton(state.data.current_item) });
  await Promise.resolve();
  const staleAudio = {
    messages: messages.splice(0),
    pendingRestore: state.pendingPlaybackRestore,
    inFlight: state.audioVariantSwitchInFlight,
    unlockAt: state.audioVariantSwitchUnlockAt,
    incarnation: state.data.current_item.item_incarnation_id,
    sessionGeneration: state.hostPlaybackSession.playbackGeneration,
    playable: state.hostPlaybackSession.video.paused === false
      && state.hostPlaybackSession.audio.paused === false,
  };

  queueCurrentRetry.dataset = { id: "song-a", itemIncarnationId: "i-2" };
  responses.push({ snapshot: snapshot(3, item("i-3", "a-3")), applied: false });
  await queueCurrentRetry.listeners.click();
  await Promise.resolve();
  const staleRetry = {
    messages: messages.splice(0),
    disabled: queueCurrentRetry.disabled,
    busy: queueCurrentRetry.getAttribute("aria-busy"),
    incarnation: state.data.current_item.item_incarnation_id,
  };

  queueCurrentRetry.dataset = { id: "song-a", itemIncarnationId: "i-3" };
  responses.push({
    snapshot: snapshot(4, item("i-3", "a-3", "instrumental", "downloading")),
    applied: true,
  });
  await queueCurrentRetry.listeners.click();
  const validRetry = {
    messages: messages.splice(0),
    disabled: queueCurrentRetry.disabled,
    busy: queueCurrentRetry.getAttribute("aria-busy"),
  };
  process.stdout.write(JSON.stringify({
    staleAudio,
    staleRetry,
    validRetry,
    requests,
    reconciliations,
    renders,
    retryBusyObservations,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNodeScript(script, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result["staleAudio"], {["messages"]: [], ["pendingRestore"]: null, ["inFlight"]: false, ["unlockAt"]: 0, ["incarnation"]: "i-2", ["sessionGeneration"]: 2, ["playable"]: true});
assert.deepEqual(result["staleRetry"], {["messages"]: [], ["disabled"]: false, ["busy"]: null, ["incarnation"]: "i-3"});
assert.deepEqual(result["validRetry"], {["messages"]: [{["message"]: "cache.retryStarted", ["isError"]: false}], ["disabled"]: false, ["busy"]: null});
assert.deepEqual(result["requests"].length, 3);
assert.deepEqual(result["reconciliations"], 3);
assert.deepEqual(result["renders"], 3);
assert.deepEqual(result["retryBusyObservations"], 2);
},
async run_foundation(body) {
let clock_recovery_cleanup, completed, equality, foundation, listener_lifecycle, recovery, resets, script, seek_cleanup;
clock_recovery_cleanup = (await this.source_slice("function clearAndroidAudioClockRecovery", "function clearWebKitAudioStarvationTimer"));
equality = (await this.source_slice("function playbackProgramDescriptorsEqual", "function isValidHostMediaLocator"));
listener_lifecycle = (await this.source_slice("function clearLocalPlayerEventListeners", "function clearLocalPlayerSeekState"));
seek_cleanup = (await this.source_slice("function takeLocalPlayerSeekCompletion", "function playerDelayOverlay"));
foundation = (await this.source_slice("function hostPlaybackMountData", "function renderPlayer"));
recovery = (await this.source_slice("async function restartHostPlaybackAfterBootstrap", "startPolling();"));
resets = (await this.source_slice("async function resetRuntimeData", "async function installAppUpdate"));
script = (`
const windowListeners = {};
const sourceAssignments = [];
class FakeNode {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.attributes = {};
    this.currentTime = 0;
    this.paused = true;
    this._src = "";
    this.controls = false;
    this.listeners = new Map();
  }
  get src() { return this._src; }
  set src(value) {
    this._src = String(value || "");
    if (this._src && ["VIDEO", "AUDIO"].includes(this.tagName)) {
      sourceAssignments.push({
        tagName: this.tagName,
        listenerNames: [...this.listeners.keys()].sort(),
      });
    }
  }
  append(...nodes) { nodes.forEach((node) => { node.parentElement = this; this.children.push(node); }); }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) { nodes.reverse().forEach((node) => { node.parentElement = this; this.children.unshift(node); }); }
  replaceChildren(...nodes) {
    this.children.forEach((node) => { node.parentElement = null; });
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
  pause() { this.paused = true; }
  load() {}
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(
      name,
      (this.listeners.get(name) || []).filter((entry) => entry !== listener),
    );
  }
  queuedListeners(name) { return [...(this.listeners.get(name) || [])]; }
  dispatchEventName(name) {
    this.queuedListeners(name).forEach((listener) => listener({ type: name, target: this }));
  }
  querySelector(selector) {
    if (selector === ".empty-state .empty-hint") {
      return this.children.flatMap((node) => node.children || []).find((node) => node.className === "empty-hint") || null;
    }
    return this.children.find((node) => {
      if (selector.startsWith("video")) return node.tagName === "VIDEO";
      if (selector.startsWith("audio")) return node.tagName === "AUDIO";
      return false;
    }) || null;
  }
  querySelectorAll(selector) {
    if (selector === "video, audio") return this.children.filter((node) => ["VIDEO", "AUDIO"].includes(node.tagName));
    return [];
  }
}
const document = { createElement: (tagName) => new FakeNode(tagName) };
const window = {
  clearTimeout() {},
  clearInterval() {},
  addEventListener(name, listener) { windowListeners[name] = listener; },
};
const elements = { playerFrame: new FakeNode("div") };
const state = {
  data: null,
  language: "en",
  hostPlaybackSession: null,
  hostPlaybackBootstrapRestartPending: false,
  hasValidStateResponse: true,
  pendingPlaybackRestore: null,
  localShouldBePlaying: true,
  localPlayerEventCleanups: [],
  localPlaybackStartState: "idle",
  localPlaybackStartGeneration: 0,
  localPlaybackStartPromisesSettled: false,
  localPlaybackEndHandled: false,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localWebKitStartRetryDone: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localPlayerVolume: 0.42,
  localPlayerMuted: true,
  playerSettingsEchoSuppressUntil: 1,
  volumeSaveSeq: 0,
  avOffsetSaving: true,
};
function selectedVideoUrlForItem(item) { return String(item?.video_media_url || ""); }
function selectedAudioUrlForItem(item) {
  return String(item?.audio_variants?.find((variant) => variant.id === item.selected_audio_variant_id)?.audio_url || "");
}
function hostCacheDetailTextForItem(item) { return String(item?.cache_message || ""); }
function t(key) { return key; }
function setTextContent(element, value) { element.textContent = String(value); }
function playerDelayOverlay() { return null; }
function clearWebKitAudioStarvationTimer() {}
function clearLocalPlayerSyncTimer() {}
function clearLocalPlayerControlsHideTimer() {}
function clearPlayerFrameClickTimer() {}
function clearTauriMediaSessionState() {}
function clearLocalAdvanceDelay() {}
function disposeAudioPitchShifter() {}
function captureLocalPlayerPreferences() {}
function setHostPlaybackSessionPhase(session, phase) {
  if (!session) return false;
  session.phase = phase;
  return true;
}
const preferenceWrites = [];
function persistLocalVolumePreferences() {
  preferenceWrites.push([state.localPlayerVolume, state.localPlayerMuted]);
}
function shouldHoldCurrentItemForTransition() { return false; }
function hasPendingSongTransitionOverlayForItem() { return false; }
function hasLocalAdvanceDelayOverlay() { return false; }
function teardownMountedPlayer() {
  return retireHostPlaybackSession(state.hostPlaybackSession);
}
function scheduleConfirmPopoverPositionSync() {}
function initializeLocalPresentation() { return Promise.resolve(); }
function renderVolumeControls() {}
function frontendPlaybackMode() { return "local"; }
let sharedAudioContextDisposals = 0;
function disposeSharedAudioContext() { sharedAudioContextDisposals += 1; }
function teardownLocalPresentationListeners() {}
function disconnectClient() {}
function setAppMessage() {}
function closeConfirm() {}
function dismissBackupBanner() {}
let apiPostStateSnapshotImpl = async () => false;
async function apiPostStateSnapshot(...args) {
  const accepted = await apiPostStateSnapshotImpl(...args);
  if (accepted && typeof args[2]?.onAccepted === "function") {
    args[2].onAccepted();
  }
  return accepted;
}
const retirementRequests = [];
const ownershipClaimRequests = [];
const startupWatchdogRequests = [];
let ownershipClaimRequestImpl = async () => ({ claimed: true });
let retirementRequestImpl = async () => ({ ok: true });
function scheduleSplitPlaybackStartupWatchdog(video, audio) {
  startupWatchdogRequests.push({ video, audio });
  return true;
}
function apiPost(path, payload) {
  if (path === "/api/player/claim-program") {
    ownershipClaimRequests.push({ path, payload });
    return ownershipClaimRequestImpl(path, payload);
  }
  if (path === "/api/player/retire-program") {
    retirementRequests.push({ path, payload });
    return retirementRequestImpl(path, payload);
  }
  throw new Error(\`unexpected API path: \${path}\`);
}
let renderImpl = () => {};
function render() { renderImpl(); }
` + String(listener_lifecycle) + `
` + String(clock_recovery_cleanup) + `
` + String(seek_cleanup) + `
` + String(equality) + `
` + String(foundation) + `
` + String(recovery) + `
` + String(resets) + `

function item({
  itemId = "song-a",
  incarnation = "i-a",
  variantId = "instrumental",
  artifactId = "a-1",
  mountable = true,
  cacheMessage = "ready",
} = {}) {
  return {
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: mountable ? variantId : "",
    artifact_set_id: mountable ? artifactId : "",
    video_media_url: mountable ? \`/media/\${artifactId}/video.mp4\` : "",
    audio_variants: mountable ? [{ id: variantId, audio_url: \`/media/\${artifactId}/\${variantId}.m4a\` }] : [],
    cache_message: cacheMessage,
  };
}
function installSnapshot(generation, current, extras = {}) {
  state.data = {
    playback_generation: generation,
    playback_program: current ? {
      item_id: current.id,
      item_incarnation_id: current.item_incarnation_id,
      selected_audio_variant_id: current.selected_audio_variant_id,
      artifact_set_id: current.artifact_set_id || null,
    } : null,
    current_item: current,
    ...extras,
  };
}
function counts() {
  return {
    video: elements.playerFrame.children.filter((node) => node.tagName === "VIDEO").length,
    audio: elements.playerFrame.children.filter((node) => node.tagName === "AUDIO").length,
  };
}
` + String(body) + `
`);
completed = (await runNodeScript(script, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_deferred_item_returns_with_fresh_zero_time_media_not_its_old_playhead() {
const result = await this.run_foundation(`
const a = item();
const b = item({ itemId: 'song-b', incarnation: 'i-b', artifactId: 'a-b' });
installSnapshot(7, a);
const first = reconcileHostPlaybackSession(a);
first.session.readyCommitted = true;
first.session.logicalPlayIntent = true;
first.video.currentTime = 70;
first.audio.currentTime = 70;
installSnapshot(8, b);
const second = reconcileHostPlaybackSession(b);
installSnapshot(9, a);
const replay = reconcileHostPlaybackSession(a);
process.stdout.write(JSON.stringify({
  retired: first.session.phase,
  newVideo: replay.video !== first.video,
  newAudio: replay.audio !== first.audio,
  videoTime: Number(replay.video.currentTime || 0),
  audioTime: Number(replay.audio.currentTime || 0),
  restore: replay.session.playbackRestore,
  playing: replay.session.logicalPlayIntent,
  counts: counts(),
}));
`);
assert.deepEqual(result, {
  retired: "retired", newVideo: true, newAudio: true,
  videoTime: 0, audioTime: 0, restore: null,
  playing: true, counts: {video: 1, audio: 1},
});
},
async test_defer_gesture_skips_only_its_own_countdown_including_sse_first() {
const overlay = await this.source_slice("function maybeShowSongTransitionOverlay", "function hasPendingSongTransitionOverlayForItem");
const submit = await this.source_slice("async function deferCurrentSong", "currentQueueDefer = window.BilikaraQueueDefer");
const script = `
const assert = require('node:assert/strict');
const state = {};
let clears = 0, holds = 0;
function clearLocalAdvanceDelay() { clears++; }
function currentItemIdFromData(data) { return data?.current_item?.id || ''; }
function hasLocalAdvanceDelayOverlay() { return false; }
function manualTransitionOverlaySeconds() { return 3; }
function registerManualTransitionHold() { return ++holds; }
const payload = {item_id:'a',expected_item_incarnation_id:'i-a',playback_generation:7,expected_playlist_item_ids:['b','c']};
const before = {playback_generation:7,current_item:{id:'a'}};
const after = {playback_generation:8,current_item:{id:'b'},playlist:[{id:'a',item_incarnation_id:'i-a'},{id:'c'}]};
async function apiPostStateSnapshot(url, body) {
  assert.equal(url, '/api/playlist/defer-current');
  assert.equal(body, payload);
  assert.equal(state.immediateDeferTransition, payload);
  // SSE commits before the HTTP acknowledgement returns.
  maybeShowSongTransitionOverlay(before, after);
  return true;
}
` + overlay + submit + `
(async () => {
  await deferCurrentSong(payload);
  assert.equal(clears, 1); assert.equal(holds, 0);
  assert.equal(state.immediateDeferTransition, null);
  // Coalesced SSE can already contain B's ready-artifact generation.
  state.immediateDeferTransition = payload;
  maybeShowSongTransitionOverlay(before, {...after, playback_generation:9});
  assert.equal(clears, 2); assert.equal(holds, 0);
  // Normal Next still observes the configured countdown, even with a pending
  // defer request, because A was NOT retained by that transition.
  state.immediateDeferTransition = payload;
  maybeShowSongTransitionOverlay(before, {...after, playlist:[{id:'c'}]});
  assert.equal(clears, 2); assert.equal(holds, 1);
  apiPostStateSnapshot = async () => { throw Error('fixture failure'); };
  await assert.rejects(deferCurrentSong(payload));
  assert.equal(state.immediateDeferTransition, null);
})().catch(error => {console.error(error); process.exitCode = 1;});
`;
const completed = await runNodeScript(script, 10 * 1000, root);
assert.equal(completed.status, 0, completed.stderr);
},
async test_session_state_machine_owns_one_exact_pair() {
let boundary, rerender, result;
result = (await this.run_foundation(`
const observations = {};
installSnapshot(1, null);
observations.empty = { kind: reconcileHostPlaybackSession(null).kind, counts: counts() };

const pending = item({ mountable: false, cacheMessage: "queued" });
installSnapshot(2, pending);
const pendingResult = reconcileHostPlaybackSession(pending);
observations.pending = {
  kind: pendingResult.kind,
  state: state.hostPlaybackSession.phase,
  counts: counts(),
};

const firstItem = item();
installSnapshot(3, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
const firstVideo = first.video;
const firstAudio = first.audio;
firstVideo.currentTime = 23.5;
firstVideo.paused = false;
observations.first = { kind: first.kind, counts: counts() };

const rerenderChanges = [
  { language: "ja" }, { theme: "dark" }, { cache_progress: 42 },
  { player_settings: { volume_percent: 55 } }, { playlist: [{ id: "queued" }] },
  { presentation: { composition: "stageOnly" } },
];
observations.rerenders = rerenderChanges.map((change) => {
  installSnapshot(3, { ...firstItem, cache_message: change.cache_progress ? "refreshing" : "ready" }, change);
  const rendered = reconcileHostPlaybackSession(state.data.current_item);
  return {
    kind: rendered.kind,
    sameVideo: rendered.video === firstVideo,
    sameAudio: rendered.audio === firstAudio,
    time: rendered.video.currentTime,
    counts: counts(),
  };
});

const stale = item({ itemId: "song-stale", incarnation: "i-stale", artifactId: "a-stale" });
installSnapshot(2, stale);
const staleResult = reconcileHostPlaybackSession(stale);
observations.stale = {
  kind: staleResult.kind,
  sameVideo: state.hostPlaybackSession.video === firstVideo,
  sameAudio: state.hostPlaybackSession.audio === firstAudio,
  time: firstVideo.currentTime,
  counts: counts(),
};

installSnapshot(4, firstItem);
const reset = reconcileHostPlaybackSession(firstItem);
const resetVideo = reset.video;
const resetAudio = reset.audio;
observations.reset = {
  kind: reset.kind,
  freshVideo: resetVideo !== firstVideo,
  freshAudio: resetAudio !== firstAudio,
  counts: counts(),
};
observations.resetDuplicate = {
  kind: reconcileHostPlaybackSession(firstItem).kind,
  sameVideo: state.hostPlaybackSession.video === resetVideo,
  sameAudio: state.hostPlaybackSession.audio === resetAudio,
  counts: counts(),
};

const variant = item({ variantId: "original" });
installSnapshot(5, variant);
const variantResult = reconcileHostPlaybackSession(variant);
const variantVideo = variantResult.video;
observations.variant = {
  kind: variantResult.kind,
  freshVideo: variantVideo !== resetVideo,
  freshAudio: variantResult.audio !== resetAudio,
  counts: counts(),
};

const recached = item({ variantId: "original", artifactId: "a-2" });
installSnapshot(6, recached);
const artifactResult = reconcileHostPlaybackSession(recached);
const currentSession = state.hostPlaybackSession;
observations.artifact = {
  kind: artifactResult.kind,
  freshVideo: artifactResult.video !== variantVideo,
  counts: counts(),
};
observations.oldRetirement = {
  retiredAgain: retireHostPlaybackSession(first.session),
  pointerPreserved: state.hostPlaybackSession === currentSession,
  pairPreserved: state.hostPlaybackSession.video === artifactResult.video,
  counts: counts(),
};
observations.retirement = {
  first: retireHostPlaybackSession(currentSession),
  second: retireHostPlaybackSession(currentSession),
  state: currentSession.phase,
};
process.stdout.write(JSON.stringify(observations));
`));
assert.deepEqual(result["empty"], {["kind"]: "empty", ["counts"]: {["video"]: 0, ["audio"]: 0}});
assert.deepEqual(result["pending"]["kind"], "pending");
assert.deepEqual(result["pending"]["state"], "requested");
assert.deepEqual(result["pending"]["counts"], {["video"]: 0, ["audio"]: 0});
assert.deepEqual(result["first"], {["kind"]: "mounted", ["counts"]: {["video"]: 1, ["audio"]: 1}});
for (const rerender of iterableValues(result["rerenders"])) {
assert.deepEqual(rerender["kind"], "reused");
assert.ok(hasContent(rerender["sameVideo"]));
assert.ok(hasContent(rerender["sameAudio"]));
assert.deepEqual(rerender["time"], 23.5);
assert.deepEqual(rerender["counts"], {["video"]: 1, ["audio"]: 1});
}
assert.deepEqual(result["stale"]["kind"], "stale");
assert.ok(hasContent(result["stale"]["sameVideo"]));
assert.ok(hasContent(result["stale"]["sameAudio"]));
assert.deepEqual(result["stale"]["time"], 23.5);
assert.deepEqual(result["stale"]["counts"], {["video"]: 1, ["audio"]: 1});
for (const boundary of iterableValues(["reset", "variant", "artifact"])) {
assert.deepEqual(result[boundary]["kind"], "mounted");
assert.ok(hasContent(result[boundary]["freshVideo"]));
assert.deepEqual(result[boundary]["counts"], {["video"]: 1, ["audio"]: 1});
}
assert.ok(hasContent(result["reset"]["freshAudio"]));
assert.ok(hasContent(result["variant"]["freshAudio"]));
assert.deepEqual(result["resetDuplicate"], {["kind"]: "reused", ["sameVideo"]: true, ["sameAudio"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["oldRetirement"], {["retiredAgain"]: false, ["pointerPreserved"]: true, ["pairPreserved"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["retirement"], {["first"]: true, ["second"]: false, ["state"]: "retired"});
},
async test_exact_retirement_acknowledges_once_after_media_detachment() {
let expected_identity, result;
result = (await this.run_foundation(`
(async () => {
  const incarnationA = "i-0123456789abcdef0123456789abcdef-0000000000000001";
  const artifactA = "a-0123456789abcdef0123456789abcdef-0000000000000001";
  const incarnationB = "i-0123456789abcdef0123456789abcdef-0000000000000002";
  const artifactB = "a-0123456789abcdef0123456789abcdef-0000000000000002";
  const firstItem = item({ incarnation: incarnationA, artifactId: artifactA });
  installSnapshot(7, firstItem);
  const first = reconcileHostPlaybackSession(firstItem);
  first.session.ownershipClaimStarted = true;
  const oldVideo = first.video;
  const oldAudio = first.audio;
  let detachedAtAcknowledgement = null;
  retirementRequestImpl = async (path, payload) => {
    detachedAtAcknowledgement = {
      path,
      payload,
      phase: first.session.phase,
      sessionVideoCleared: first.session.video === null,
      sessionAudioCleared: first.session.audio === null,
      videoSource: oldVideo.src,
      audioSource: oldAudio.src,
    };
    throw new Error("acknowledgement lost");
  };

  const secondItem = item({
    itemId: "song-b",
    incarnation: incarnationB,
    artifactId: artifactB,
  });
  installSnapshot(8, secondItem);
  const second = reconcileHostPlaybackSession(secondItem);
  await Promise.resolve();
  await Promise.resolve();
  const duplicateRetirement = retireHostPlaybackSession(first.session);
  const afterFailedAcknowledgement = {
    requests: retirementRequests.length,
    duplicateRetirement,
    currentIsSecond: state.hostPlaybackSession === second.session,
    secondPhase: second.session.phase,
    counts: counts(),
  };

  const pending = item({
    itemId: "song-pending",
    incarnation: "i-pending",
    artifactId: "",
    mountable: false,
  });
  retirementRequestImpl = async () => ({ ok: true });
  installSnapshot(9, pending);
  reconcileHostPlaybackSession(pending);
  const requestsAfterSecondRetirement = retirementRequests.length;
  const third = item({
    itemId: "song-c",
    incarnation: "i-c",
    artifactId: "a-c",
  });
  installSnapshot(10, third);
  reconcileHostPlaybackSession(third);
  const pendingSentInvalidAcknowledgement = (
    retirementRequests.length !== requestsAfterSecondRetirement
  );

  process.stdout.write(JSON.stringify({
    detachedAtAcknowledgement,
    firstRequest: retirementRequests[0],
    afterFailedAcknowledgement,
    pendingSentInvalidAcknowledgement,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
expected_identity = {["playback_generation"]: 7, ["item_incarnation_id"]: "i-0123456789abcdef0123456789abcdef-0000000000000001", ["artifact_set_id"]: "a-0123456789abcdef0123456789abcdef-0000000000000001"};
assert.deepEqual(result["detachedAtAcknowledgement"], {["path"]: "/api/player/retire-program", ["payload"]: expected_identity, ["phase"]: "retired", ["sessionVideoCleared"]: true, ["sessionAudioCleared"]: true, ["videoSource"]: "", ["audioSource"]: ""});
assert.deepEqual(result["firstRequest"], {["path"]: "/api/player/retire-program", ["payload"]: expected_identity});
assert.deepEqual(result["afterFailedAcknowledgement"], {["requests"]: 1, ["duplicateRetirement"]: false, ["currentIsSecond"]: true, ["secondPhase"]: "binding", ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.ok(!hasContent(result["pendingSentInvalidAcknowledgement"]));
},
async test_pagehide_uses_the_same_exact_idempotent_retirement_boundary() {
let result;
result = (await this.run_foundation(`
const current = item({
  incarnation: "i-0123456789abcdef0123456789abcdef-0000000000000001",
  artifactId: "a-0123456789abcdef0123456789abcdef-0000000000000001",
});
installSnapshot(11, current);
const mounted = reconcileHostPlaybackSession(current);
mounted.session.ownershipClaimStarted = true;
windowListeners.pagehide();
windowListeners.pagehide();
process.stdout.write(JSON.stringify({
  requests: retirementRequests,
  phase: mounted.session.phase,
  videoCleared: mounted.session.video === null,
  audioCleared: mounted.session.audio === null,
  counts: counts(),
}));
`));
assert.deepEqual(result, {["requests"]: [{["path"]: "/api/player/retire-program", ["payload"]: {["playback_generation"]: 11, ["item_incarnation_id"]: "i-0123456789abcdef0123456789abcdef-0000000000000001", ["artifact_set_id"]: "a-0123456789abcdef0123456789abcdef-0000000000000001"}}], ["phase"]: "retired", ["videoCleared"]: true, ["audioCleared"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
},
async test_candidate_creation_prepares_one_pair_without_starting_media_load() {
let result;
result = (await this.run_foundation(`
const current = item();
installSnapshot(7, current);
const candidate = reconcileHostPlaybackSession(current);
process.stdout.write(JSON.stringify({
  kind: candidate.kind,
  counts: counts(),
  videoSrc: candidate.video?.src || "",
  audioSrc: candidate.audio?.src || "",
  sourceAssignments,
}));
`));
assert.deepEqual(result, {["kind"]: "mounted", ["counts"]: {["video"]: 1, ["audio"]: 1}, ["videoSrc"]: "", ["audioSrc"]: "", ["sourceAssignments"]: []});
},
async test_exact_claim_precedes_loading_and_failure_or_supersession_never_retries() {
let render_player, result;
render_player = (await this.source_slice("function renderPlayer", "function applyRemotePlayerControl"));
assert.ok(contains("beginHostPlaybackSessionOwnershipClaim(session);", render_player));
result = (await this.run_foundation(`
(async () => {
  const firstItem = item();
  installSnapshot(7, firstItem);
  const first = reconcileHostPlaybackSession(firstItem);
  let resolveFirstClaim;
  ownershipClaimRequestImpl = () => new Promise((resolve) => {
    resolveFirstClaim = resolve;
  });
  const firstStarted = beginHostPlaybackSessionOwnershipClaim(first.session);
  const duplicateStart = beginHostPlaybackSessionOwnershipClaim(first.session);
  await Promise.resolve();
  const beforeFirstClaim = {
    videoSrc: first.video.src,
    audioSrc: first.audio.src,
    loadingStarted: first.session.loadingStarted,
    claimRequests: ownershipClaimRequests.length,
  };
  resolveFirstClaim({ claimed: true });
  await first.session.ownershipClaimRequest;
  const afterFirstClaim = {
    videoSrc: first.video.src,
    audioSrc: first.audio.src,
    loadingStarted: first.session.loadingStarted,
    ownershipClaimed: first.session.ownershipClaimed,
    sourceAssignments: sourceAssignments.length,
  };

  let resolveDelayedClaim;
  const secondItem = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
  installSnapshot(8, secondItem);
  const second = reconcileHostPlaybackSession(secondItem);
  ownershipClaimRequestImpl = () => new Promise((resolve) => {
    resolveDelayedClaim = resolve;
  });
  beginHostPlaybackSessionOwnershipClaim(second.session);
  await Promise.resolve();
  const thirdItem = item({ itemId: "song-c", incarnation: "i-c", artifactId: "a-c" });
  installSnapshot(9, thirdItem);
  const third = reconcileHostPlaybackSession(thirdItem);
  resolveDelayedClaim({ claimed: true });
  await second.session.ownershipClaimRequest;
  const superseded = {
    phase: second.session.phase,
    videoSrc: second.video?.src || "",
    audioSrc: second.audio?.src || "",
    currentIsThird: state.hostPlaybackSession === third.session,
    claimRequests: ownershipClaimRequests.length,
  };

  ownershipClaimRequestImpl = async () => { throw new Error("claim failed"); };
  beginHostPlaybackSessionOwnershipClaim(third.session);
  await third.session.ownershipClaimRequest;
  const failed = {
    phase: third.session.phase,
    currentSessionRetained: state.hostPlaybackSession === third.session,
    videoSrc: third.video?.src || "",
    audioSrc: third.audio?.src || "",
    ownershipClaimFailed: third.session.ownershipClaimFailed,
    claimRequests: ownershipClaimRequests.length,
    retirementRequests: retirementRequests.length,
    counts: counts(),
  };

  process.stdout.write(JSON.stringify({
    firstStarted,
    duplicateStart,
    beforeFirstClaim,
    afterFirstClaim,
    superseded,
    failed,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.ok(hasContent(result["firstStarted"]));
assert.ok(!hasContent(result["duplicateStart"]));
assert.deepEqual(result["beforeFirstClaim"], {["videoSrc"]: "", ["audioSrc"]: "", ["loadingStarted"]: false, ["claimRequests"]: 1});
assert.deepEqual(result["afterFirstClaim"], {["videoSrc"]: "/media/a-1/video.mp4", ["audioSrc"]: "/media/a-1/instrumental.m4a", ["loadingStarted"]: true, ["ownershipClaimed"]: true, ["sourceAssignments"]: 2});
assert.deepEqual(result["superseded"], {["phase"]: "retired", ["videoSrc"]: "", ["audioSrc"]: "", ["currentIsThird"]: true, ["claimRequests"]: 2});
assert.deepEqual(result["failed"], {["phase"]: "retired", ["currentSessionRetained"]: true, ["videoSrc"]: "", ["audioSrc"]: "", ["ownershipClaimFailed"]: true, ["claimRequests"]: 3, ["retirementRequests"]: 3, ["counts"]: {["video"]: 0, ["audio"]: 0}});
},
async test_claim_failure_is_terminal_for_the_same_accepted_program() {
let result;
result = (await this.run_foundation(`
(async () => {
  const failedItem = item();
  installSnapshot(7, failedItem, { state_revision: 40, cache_progress: 10 });
  const first = reconcileHostPlaybackSession(failedItem);
  ownershipClaimRequestImpl = async () => { throw new Error("claim failed"); };
  beginHostPlaybackSessionOwnershipClaim(first.session);
  await first.session.ownershipClaimRequest;
  const afterFailure = {
    phase: first.session.phase,
    retained: state.hostPlaybackSession === first.session,
    ownershipClaimFailed: first.session.ownershipClaimFailed,
    claimRequests: ownershipClaimRequests.length,
    retirementRequests: retirementRequests.length,
    counts: counts(),
  };

  installSnapshot(7, failedItem, { state_revision: 41, cache_progress: 75 });
  const sameProgram = reconcileHostPlaybackSession(failedItem);
  if (sameProgram.kind === "mounted") {
    beginHostPlaybackSessionOwnershipClaim(sameProgram.session);
    await sameProgram.session.ownershipClaimRequest;
  }
  const afterPythonOnlyRevision = {
    kind: sameProgram.kind,
    sameSentinel: state.hostPlaybackSession === first.session,
    claimRequests: ownershipClaimRequests.length,
    retirementRequests: retirementRequests.length,
    counts: counts(),
  };

  const recoveredItem = item({
    itemId: "song-b",
    incarnation: "i-b",
    artifactId: "a-b",
  });
  installSnapshot(8, recoveredItem, { state_revision: 42 });
  const recovered = reconcileHostPlaybackSession(recoveredItem);
  ownershipClaimRequestImpl = async () => ({ claimed: true });
  beginHostPlaybackSessionOwnershipClaim(recovered.session);
  await recovered.session.ownershipClaimRequest;
  const afterHigherGeneration = {
    kind: recovered.kind,
    generation: recovered.session.playbackGeneration,
    current: state.hostPlaybackSession === recovered.session,
    loadingStarted: recovered.session.loadingStarted,
    ownershipClaimed: recovered.session.ownershipClaimed,
    videoSrc: recovered.video.src,
    audioSrc: recovered.audio.src,
    claimRequests: ownershipClaimRequests.length,
    retirementRequests: retirementRequests.length,
    watchdogRequests: startupWatchdogRequests.length,
    counts: counts(),
  };

  process.stdout.write(JSON.stringify({
    afterFailure,
    afterPythonOnlyRevision,
    afterHigherGeneration,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["afterFailure"], {["phase"]: "retired", ["retained"]: true, ["ownershipClaimFailed"]: true, ["claimRequests"]: 1, ["retirementRequests"]: 1, ["counts"]: {["video"]: 0, ["audio"]: 0}});
assert.deepEqual(result["afterPythonOnlyRevision"], {["kind"]: "retired", ["sameSentinel"]: true, ["claimRequests"]: 1, ["retirementRequests"]: 1, ["counts"]: {["video"]: 0, ["audio"]: 0}});
assert.deepEqual(result["afterHigherGeneration"], {["kind"]: "mounted", ["generation"]: 8, ["current"]: true, ["loadingStarted"]: true, ["ownershipClaimed"]: true, ["videoSrc"]: "/media/a-b/video.mp4", ["audioSrc"]: "/media/a-b/instrumental.m4a", ["claimRequests"]: 2, ["retirementRequests"]: 1, ["watchdogRequests"]: 1, ["counts"]: {["video"]: 1, ["audio"]: 1}});
},
async test_recache_and_variant_replacements_capture_only_exact_ready_session_restore() {
let result;
result = (await this.run_foundation(`
function exercise(firstItem, replacementItem, logicalPlayIntent, currentTime) {
  retireHostPlaybackSession(state.hostPlaybackSession);
  state.hostPlaybackSession = null;
  state.pendingPlaybackRestore = null;
  installSnapshot(20, firstItem);
  const first = reconcileHostPlaybackSession(firstItem);
  first.session.readyCommitted = true;
  first.session.initialIntentApplied = true;
  first.session.logicalPlayIntent = logicalPlayIntent;
  first.session.phase = logicalPlayIntent ? "playing" : "paused";
  first.video.currentTime = currentTime;
  first.video.paused = !logicalPlayIntent;
  first.audio.paused = !logicalPlayIntent;

  installSnapshot(21, replacementItem);
  const replacement = reconcileHostPlaybackSession(replacementItem);
  return {
    oldPhase: first.session.phase,
    replacementPhase: replacement.session.phase,
    restore: replacement.session.playbackRestore,
    logicalPlayIntent: replacement.session.logicalPlayIntent,
    counts: counts(),
  };
}

const recache = exercise(
  item({ artifactId: "artifact-1" }),
  item({ artifactId: "artifact-2" }),
  true,
  41.25,
);
const variant = exercise(
  item({ artifactId: "artifact-2", variantId: "instrumental" }),
  item({ artifactId: "artifact-2", variantId: "vocal" }),
  false,
  27.5,
);
const differentIncarnation = exercise(
  item({ incarnation: "i-a", artifactId: "artifact-3" }),
  item({ incarnation: "i-b", artifactId: "artifact-4" }),
  true,
  63,
);
retireHostPlaybackSession(state.hostPlaybackSession);
state.hostPlaybackSession = null;
state.pendingPlaybackRestore = {
  itemId: "song-a",
  itemIncarnationId: "i-old",
  variantId: "instrumental",
  currentTime: 88,
  wasPlaying: false,
};
const replacement = item({
  incarnation: "i-new", variantId: "instrumental", artifactId: "artifact-5",
});
installSnapshot(30, replacement);
const staleRestoreReplacement = reconcileHostPlaybackSession(replacement);
const staleVariantRestore = {
  restore: staleRestoreReplacement.session.playbackRestore,
  pendingRestore: state.pendingPlaybackRestore,
  logicalPlayIntent: staleRestoreReplacement.session.logicalPlayIntent,
};
process.stdout.write(JSON.stringify({
  recache, variant, differentIncarnation, staleVariantRestore,
}));
`));
assert.deepEqual(result["recache"], {["oldPhase"]: "retired", ["replacementPhase"]: "binding", ["restore"]: {["itemId"]: "song-a", ["itemIncarnationId"]: "i-a", ["variantId"]: "instrumental", ["currentTime"]: 41.25, ["wasPlaying"]: true}, ["logicalPlayIntent"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["variant"], {["oldPhase"]: "retired", ["replacementPhase"]: "binding", ["restore"]: {["itemId"]: "song-a", ["itemIncarnationId"]: "i-a", ["variantId"]: "vocal", ["currentTime"]: 27.5, ["wasPlaying"]: false}, ["logicalPlayIntent"]: false, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["differentIncarnation"], {["oldPhase"]: "retired", ["replacementPhase"]: "binding", ["restore"]: null, ["logicalPlayIntent"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["staleVariantRestore"], {["restore"]: null, ["pendingRestore"]: null, ["logicalPlayIntent"]: true});
},
async test_same_item_program_reconciliation_preserves_an_exact_inflight_next_hold() {
let result;
result = (await this.run_foundation(`
const current = item({ artifactId: "artifact-1" });
installSnapshot(30, current);
const first = reconcileHostPlaybackSession(current);
first.session.readyCommitted = true;
first.session.phase = "playing";
first.session.logicalPlayIntent = true;
state.localAdvanceInFlight = true;
state.localAdvanceDelayToken = 9;
state.manualTransitionHoldItemId = "song-b";
state.manualTransitionHoldGeneration = 4;
let clearCalls = 0;
clearLocalAdvanceDelay = () => {
  clearCalls += 1;
  state.localAdvanceInFlight = false;
  state.manualTransitionHoldItemId = "";
  state.manualTransitionHoldGeneration = 0;
};

const recached = item({ artifactId: "artifact-2" });
installSnapshot(31, recached);
const replacement = reconcileHostPlaybackSession(recached);
process.stdout.write(JSON.stringify({
  kind: replacement.kind,
  oldPhase: first.session.phase,
  clearCalls,
  inFlight: state.localAdvanceInFlight,
  holdItem: state.manualTransitionHoldItemId,
  holdGeneration: state.manualTransitionHoldGeneration,
  delayToken: state.localAdvanceDelayToken,
  counts: counts(),
}));
`));
assert.deepEqual(result, {["kind"]: "mounted", ["oldPhase"]: "retired", ["clearCalls"]: 0, ["inFlight"]: true, ["holdItem"]: "song-b", ["holdGeneration"]: 4, ["delayToken"]: 9, ["counts"]: {["video"]: 1, ["audio"]: 1}});
},
async test_current_session_predicate_requires_authority_and_exact_elements() {
let result;
result = (await this.run_foundation(`
const current = item();
installSnapshot(7, current);
const mounted = reconcileHostPlaybackSession(current);
const session = mounted.session;
const impostor = { ...session };
const otherVideo = new FakeNode("video");
const checks = {
  current: isCurrentHostPlaybackSession(session),
  exactPair: isCurrentHostPlaybackSession(session, mounted.video, mounted.audio),
  wrongObject: isCurrentHostPlaybackSession(impostor),
  wrongVideo: isCurrentHostPlaybackSession(session, otherVideo, mounted.audio),
};
session.phase = "retiring";
checks.retiring = isCurrentHostPlaybackSession(session, mounted.video, mounted.audio);
session.phase = "binding";
state.data.playback_generation = 8;
checks.wrongGeneration = isCurrentHostPlaybackSession(session, mounted.video, mounted.audio);
process.stdout.write(JSON.stringify(checks));
`));
assert.deepEqual(result, {["current"]: true, ["exactPair"]: true, ["wrongObject"]: false, ["wrongVideo"]: false, ["retiring"]: false, ["wrongGeneration"]: false});
},
async test_queued_media_listener_rechecks_exact_session_before_effects() {
let result;
result = (await this.run_foundation(`
const firstItem = item();
installSnapshot(7, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
let oldEndedEffects = 0;
addMountedPlayerListener(first.video, "ended", () => {
  oldEndedEffects += 1;
  state.hostPlaybackSession.video.pause();
});
const queuedOldEnded = first.video.queuedListeners("ended");

const secondItem = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
installSnapshot(8, secondItem);
const second = reconcileHostPlaybackSession(secondItem);
second.video.paused = false;
queuedOldEnded.forEach((listener) => listener({ type: "ended", target: first.video }));
const afterRetiredEvent = {
  oldEndedEffects,
  secondPaused: second.video.paused,
  currentSession: state.hostPlaybackSession === second.session,
};

let currentEndedEffects = 0;
addMountedPlayerListener(second.video, "ended", () => {
  currentEndedEffects += 1;
  second.video.pause();
});
second.video.dispatchEventName("ended");
process.stdout.write(JSON.stringify({
  afterRetiredEvent,
  current: { currentEndedEffects, secondPaused: second.video.paused },
}));
`));
assert.deepEqual(result, {["afterRetiredEvent"]: {["oldEndedEffects"]: 0, ["secondPaused"]: false, ["currentSession"]: true}, ["current"]: {["currentEndedEffects"]: 1, ["secondPaused"]: true}});
},
async test_retirement_settles_owned_seek_once_without_clearing_new_session() {
let result;
result = (await this.run_foundation(`
const firstItem = item();
installSnapshot(7, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
const firstSettlements = [];
first.session.seekSettling = true;
first.session.seekSettleTimer = 41;
first.session.seekSettleCallback = (applied) => firstSettlements.push(applied);
const firstRetire = retireHostPlaybackSession(first.session);
const duplicateRetire = retireHostPlaybackSession(first.session);

const secondItem = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
installSnapshot(8, secondItem);
const second = reconcileHostPlaybackSession(secondItem);
const secondSettlements = [];
second.session.seekSettling = true;
second.session.seekSettleTimer = 42;
second.session.seekSettleCallback = (applied) => secondSettlements.push(applied);
const staleCleanup = retireHostPlaybackSession(first.session);
const beforeSecondRetire = {
  currentPreserved: state.hostPlaybackSession === second.session,
  secondSettlements: [...secondSettlements],
  secondSeekTimer: second.session.seekSettleTimer,
};
const secondRetire = retireHostPlaybackSession(second.session);
process.stdout.write(JSON.stringify({
  firstRetire,
  duplicateRetire,
  staleCleanup,
  firstSettlements,
  beforeSecondRetire,
  secondRetire,
  secondSettlements,
}));
`));
assert.deepEqual(result, {["firstRetire"]: true, ["duplicateRetire"]: false, ["staleCleanup"]: false, ["firstSettlements"]: [false], ["beforeSecondRetire"]: {["currentPreserved"]: true, ["secondSettlements"]: [], ["secondSeekTimer"]: 42}, ["secondRetire"]: true, ["secondSettlements"]: [false]});
},
async test_player_signature_and_context_are_not_lifetime_authority() {
assert.ok(!contains("playerSignature", this.source));
assert.ok(!contains("playerContext", this.source));
},
async test_bootstrap_restarts_before_mounting_one_current_program_pair() {
let result;
result = (await this.run_foundation(`
(async () => {
  const current = item();
  installSnapshot(7, current);
  state.hostPlaybackBootstrapRestartPending = true;
  const beforeRestart = reconcileHostPlaybackSession(current);
  const retiredGeneration = state.hostPlaybackSession.playbackGeneration;
  let restartCalls = 0;
  let renderCalls = 0;
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    installSnapshot(8, current);
    return true;
  };
  renderImpl = () => {
    renderCalls += 1;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  const restarted = await restartHostPlaybackAfterBootstrap();
  const mounted = state.hostPlaybackSession;
  const mountedObservation = {
    generation: mounted.playbackGeneration,
    phase: mounted.phase,
    freshPair: Boolean(mounted.video && mounted.audio),
    counts: counts(),
  };
  const duplicate = await restartHostPlaybackAfterBootstrap();

  retireHostPlaybackSession(mounted);
  state.hostPlaybackSession = null;
  installSnapshot(9, null);
  state.hostPlaybackBootstrapRestartPending = true;
  reconcileHostPlaybackSession(null);
  const noCurrent = await restartHostPlaybackAfterBootstrap();
  process.stdout.write(JSON.stringify({
    beforeRestart: beforeRestart.kind,
    retiredGeneration,
    restarted,
    duplicate,
    noCurrent,
    restartCalls,
    renderCalls,
    mounted: mountedObservation,
    finalCounts: counts(),
    pending: state.hostPlaybackBootstrapRestartPending,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result, {["beforeRestart"]: "retired", ["retiredGeneration"]: 7, ["restarted"]: true, ["duplicate"]: false, ["noCurrent"]: false, ["restartCalls"]: 1, ["renderCalls"]: 1, ["mounted"]: {["generation"]: 8, ["phase"]: "binding", ["freshPair"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}}, ["finalCounts"]: {["video"]: 0, ["audio"]: 0}, ["pending"]: false});
},
async test_page_restore_restarts_rust_program_before_one_fresh_mount() {
let result;
result = (await this.run_foundation(`
(async () => {
  const current = item();
  installSnapshot(7, current);
  const mounted = reconcileHostPlaybackSession(current);
  const oldSession = mounted.session;
  let restartCalls = 0;
  let renderCalls = 0;
  let retiredBeforeRestart = false;
  let preRestartRenderSuppressed = false;
  let generationSeenByRender = 0;
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    retiredBeforeRestart = oldSession.phase === "retired";
    installSnapshot(8, current);
    render();
    preRestartRenderSuppressed = state.hostPlaybackSession.phase === "retired"
      && state.hostPlaybackSession.playbackGeneration === 8
      && state.hostPlaybackSession.video === null
      && state.hostPlaybackSession.audio === null
      && elements.playerFrame.querySelector("video") === mounted.video
      && elements.playerFrame.querySelector("audio") === mounted.audio;
    return true;
  };
  renderImpl = () => {
    renderCalls += 1;
    generationSeenByRender = state.data.playback_generation;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  windowListeners.pagehide();
  const afterHide = {
    phase: oldSession.phase,
    restartRequired: state.pageHidePlaybackRestartRequired,
    counts: counts(),
  };
  windowListeners.pageshow();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const newSession = state.hostPlaybackSession;
  const afterShow = {
    restartCalls,
    renderCalls,
    retiredBeforeRestart,
    preRestartRenderSuppressed,
    generationSeenByRender,
    generation: newSession.playbackGeneration,
    phase: newSession.phase,
    mounted: Boolean(newSession.video && newSession.audio),
    freshVideo: newSession.video !== mounted.video,
    freshAudio: newSession.audio !== mounted.audio,
    counts: counts(),
  };
  windowListeners.pageshow();
  await Promise.resolve();
  const afterDuplicateShow = { restartCalls, renderCalls };

  installSnapshot(9, null);
  state.pageHidePlaybackRestartRequired = true;
  const noCurrent = await restartHostPlaybackAfterPageRestore();
  process.stdout.write(JSON.stringify({ afterHide, afterShow, afterDuplicateShow, noCurrent }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["afterHide"], {["phase"]: "retired", ["restartRequired"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["afterShow"], {["restartCalls"]: 1, ["renderCalls"]: 2, ["retiredBeforeRestart"]: true, ["preRestartRenderSuppressed"]: true, ["generationSeenByRender"]: 8, ["generation"]: 8, ["phase"]: "binding", ["mounted"]: true, ["freshVideo"]: true, ["freshAudio"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["afterDuplicateShow"], {["restartCalls"]: 1, ["renderCalls"]: 2});
assert.ok(!hasContent(result["noCurrent"]));
},
async test_page_restore_reconciles_a_newer_accepted_program_after_a_stale_response() {
let result;
result = (await this.run_foundation(`
(async () => {
  const current = item();
  installSnapshot(7, current);
  const mounted = reconcileHostPlaybackSession(current);
  const oldVideo = mounted.video;
  const oldAudio = mounted.audio;
  let restartCalls = 0;
  let renderCalls = 0;
  let releaseRestart;
  const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    installSnapshot(9, current, { state_revision: 9 });
    render();
    await restartGate;
    return false;
  };
  renderImpl = () => {
    renderCalls += 1;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  windowListeners.pagehide();
  const firstRestore = restartHostPlaybackAfterPageRestore();
  const duplicateRestore = await restartHostPlaybackAfterPageRestore();
  releaseRestart();
  const accepted = await firstRestore;
  const newerSession = state.hostPlaybackSession;
  const newer = {
    accepted,
    duplicateRestore,
    restartCalls,
    renderCalls,
    generation: newerSession.playbackGeneration,
    active: newerSession.phase === "binding",
    freshVideo: newerSession.video !== oldVideo,
    freshAudio: newerSession.audio !== oldAudio,
    counts: counts(),
  };

  state.pageHidePlaybackRestartRequired = false;
  retireHostPlaybackSession(newerSession);
  state.hostPlaybackSession = null;
  installSnapshot(20, current, { state_revision: 20 });
  reconcileHostPlaybackSession(current);
  let failedCalls = 0;
  apiPostStateSnapshotImpl = async () => {
    failedCalls += 1;
    installSnapshot(20, current, { state_revision: 21, cache_progress: 50 });
    render();
    throw new Error("network failed");
  };
  windowListeners.pagehide();
  const failed = await restartHostPlaybackAfterPageRestore();
  const sameGeneration = {
    failed,
    failedCalls,
    renderCalls,
    generation: state.hostPlaybackSession.playbackGeneration,
    phase: state.hostPlaybackSession.phase,
    videoSrc: state.hostPlaybackSession.video?.src || "",
    audioSrc: state.hostPlaybackSession.audio?.src || "",
    counts: counts(),
  };
  process.stdout.write(JSON.stringify({ newer, sameGeneration }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["newer"], {["accepted"]: false, ["duplicateRestore"]: false, ["restartCalls"]: 1, ["renderCalls"]: 2, ["generation"]: 9, ["active"]: true, ["freshVideo"]: true, ["freshAudio"]: true, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["sameGeneration"], {["failed"]: false, ["failedCalls"]: 1, ["renderCalls"]: 3, ["generation"]: 20, ["phase"]: "retired", ["videoSrc"]: "", ["audioSrc"]: "", ["counts"]: {["video"]: 1, ["audio"]: 1}});
},
async test_resets_retire_only_after_an_authoritative_snapshot_is_accepted() {
let result;
result = (await this.run_foundation(`
(async () => {
  const current = item();
  installSnapshot(7, current, { player_settings: { volume_percent: 42, is_muted: true } });
  const mounted = reconcileHostPlaybackSession(current);
  const oldVideo = mounted.video;
  const oldAudio = mounted.audio;
  oldVideo.currentTime = 18.25;
  oldVideo.paused = false;
  oldAudio.paused = false;
  renderImpl = () => reconcileHostPlaybackSession(state.data.current_item);

  apiPostStateSnapshotImpl = async () => { throw new Error("network failed"); };
  await resetPlayerState();
  const failedPlayerReset = {
    sameSession: state.hostPlaybackSession === mounted.session,
    sameVideo: state.hostPlaybackSession.video === oldVideo,
    sameAudio: state.hostPlaybackSession.audio === oldAudio,
    phase: mounted.session.phase,
    videoPaused: oldVideo.paused,
    audioPaused: oldAudio.paused,
    currentTime: oldVideo.currentTime,
    volume: state.localPlayerVolume,
    muted: state.localPlayerMuted,
    serverVolume: state.data.player_settings.volume_percent,
    serverMuted: state.data.player_settings.is_muted,
    preferenceWrites: preferenceWrites.length,
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => false;
  await resetRuntimeData();
  const failedDataReset = {
    sameSession: state.hostPlaybackSession === mounted.session,
    phase: mounted.session.phase,
    videoPaused: oldVideo.paused,
    audioPaused: oldAudio.paused,
    generation: state.data.playback_generation,
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => {
    installSnapshot(8, current, { player_settings: { volume_percent: 100, is_muted: false } });
    return true;
  };
  await resetPlayerState();
  const resetSession = state.hostPlaybackSession;
  const acceptedPlayerReset = {
    generation: resetSession.playbackGeneration,
    freshVideo: resetSession.video !== oldVideo,
    freshAudio: resetSession.audio !== oldAudio,
    oldRetired: mounted.session.phase,
    volume: state.localPlayerVolume,
    muted: state.localPlayerMuted,
    preferenceWrites: preferenceWrites.length,
    disposals: sharedAudioContextDisposals,
    counts: counts(),
  };

  const newer = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
  apiPostStateSnapshotImpl = async () => {
    installSnapshot(9, newer);
    render();
    return false;
  };
  await resetPlayerState();
  const newerSession = state.hostPlaybackSession;
  const stalePlayerReset = {
    generation: newerSession.playbackGeneration,
    itemId: newerSession.playbackProgram.item_id,
    phase: newerSession.phase,
    counts: counts(),
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => {
    installSnapshot(10, null);
    return true;
  };
  await resetRuntimeData();
  const acceptedDataReset = {
    generation: state.data.playback_generation,
    currentItem: state.data.current_item,
    phase: newerSession.phase,
    disposals: sharedAudioContextDisposals,
    counts: counts(),
  };
  process.stdout.write(JSON.stringify({
    failedPlayerReset,
    failedDataReset,
    acceptedPlayerReset,
    stalePlayerReset,
    acceptedDataReset,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["failedPlayerReset"], {["sameSession"]: true, ["sameVideo"]: true, ["sameAudio"]: true, ["phase"]: "binding", ["videoPaused"]: false, ["audioPaused"]: false, ["currentTime"]: 18.25, ["volume"]: 0.42, ["muted"]: true, ["serverVolume"]: 42, ["serverMuted"]: true, ["preferenceWrites"]: 0, ["disposals"]: 0});
assert.deepEqual(result["failedDataReset"], {["sameSession"]: true, ["phase"]: "binding", ["videoPaused"]: false, ["audioPaused"]: false, ["generation"]: 7, ["disposals"]: 0});
assert.deepEqual(result["acceptedPlayerReset"], {["generation"]: 8, ["freshVideo"]: true, ["freshAudio"]: true, ["oldRetired"]: "retired", ["volume"]: 1, ["muted"]: false, ["preferenceWrites"]: 1, ["disposals"]: 1, ["counts"]: {["video"]: 1, ["audio"]: 1}});
assert.deepEqual(result["stalePlayerReset"], {["generation"]: 9, ["itemId"]: "song-b", ["phase"]: "binding", ["counts"]: {["video"]: 1, ["audio"]: 1}, ["disposals"]: 1});
assert.deepEqual(result["acceptedDataReset"], {["generation"]: 10, ["currentItem"]: null, ["phase"]: "retired", ["disposals"]: 2, ["counts"]: {["video"]: 0, ["audio"]: 0}});
},
async test_workspace_switching_preserves_exact_session_program_and_media_pair() {
let completed, result, scenario, script, shell_functions;
shell_functions = (await this.source_slice("function renderHostWorkspaceSelection", "function rememberedVolumePercent"));
script = (`
function fakeClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name); else values.delete(name);
      return enabled;
    },
    contains(name) { return values.has(name); },
  };
}
function fakeElement(dataset = {}) {
  return {
    dataset: { ...dataset },
    attributes: {},
    classList: fakeClassList(),
    hidden: false,
    inert: false,
    scrollTop: 0,
    tabIndex: -1,
    focusCount: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focusCount += 1; document.activeElement = this; },
    querySelector(selector) {
      return selector === "[data-host-workspace-heading]" ? this.heading : null;
    },
  };
}
const workspaceNames = ["queue", "request", "random", "users"];
const buttons = workspaceNames.map((name) => fakeElement({ hostWorkspace: name }));
const panels = workspaceNames.map((name) => {
  const panel = fakeElement({ hostWorkspacePanel: name });
  panel.heading = fakeElement();
  return panel;
});
const workspaceBackdrop = fakeElement();
const appShell = fakeElement();
const hostWorkspaceRegion = fakeElement();
const document = { activeElement: null };
const window = {
  matchMedia(query) {
    return { matches: query.includes("1040px") ? false : true };
  },
  localStorage: { removeItem() {} },
};
const elements = {
  appShell,
  hostWorkspaceRegion,
  hostWorkspaceButtons: buttons,
  hostWorkspacePanels: panels,
  hostWorkspaceBackdrop: workspaceBackdrop,
};
let forbidden = {
  mount: 0, replace: 0, claim: 0, retire: 0, load: 0,
  play: 0, pause: 0, seek: 0, playerRequests: 0,
};
function mountHostPlaybackSessionElements() { forbidden.mount += 1; }
function replaceHostPlayerView() { forbidden.replace += 1; }
function apiPostStateSnapshot(path) {
  if (String(path).startsWith("/api/player/")) forbidden.playerRequests += 1;
}
function acceptedScenario(phase, presentationActive = false) {
  const playing = phase === "playing";
  const video = {
    src: "/media/program-a/video.mp4",
    currentSrc: "/media/program-a/video.mp4",
    currentTime: 18.5,
    paused: !playing,
    load() { forbidden.load += 1; },
    play() { forbidden.play += 1; return Promise.resolve(); },
    pause() { forbidden.pause += 1; },
  };
  let audioTime = 18.5;
  const audio = {
    src: "/media/program-a/audio.m4a",
    currentSrc: "/media/program-a/audio.m4a",
    paused: !playing,
    load() { forbidden.load += 1; },
    play() { forbidden.play += 1; return Promise.resolve(); },
    pause() { forbidden.pause += 1; },
    get currentTime() { return audioTime; },
    set currentTime(value) { forbidden.seek += 1; audioTime = value; },
  };
  const frame = fakeElement();
  frame.children = [video, audio];
  frame.querySelectorAll = (selector) => selector === "video" ? [video]
    : selector === "audio" ? [audio] : [];
  const program = Object.freeze({
    item_id: "song-a",
    item_incarnation_id: "incarnation-a",
    selected_audio_variant_id: "instrumental",
    artifact_set_id: "artifact-a",
  });
  const session = {
    phase,
    playbackGeneration: 41,
    playbackProgram: program,
    video,
    audio,
    readyCommitted: phase !== "binding",
  };
  state.activeHostWorkspace = "queue";
  state.focusedHostWorkspace = "queue";
  state.hostWorkspaceOverlayOpen = false;
  state.hostPlaybackSession = session;
  state.data = { playback_generation: 41, playback_program: program };
  state.presentationSession = { phase: presentationActive ? "active" : "inactive" };
  renderHostWorkspaceSelection();
  const original = {
    session,
    frame,
    video,
    audio,
    videoSrc: video.src,
    audioSrc: audio.src,
    program,
    generation: session.playbackGeneration,
    currentTime: video.currentTime,
  };
  let snapshotRenders = 0;
  for (let cycle = 0; cycle < 20; cycle += 1) {
    for (const workspace of ["request", "random", "users", "queue"]) {
      activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
    }
    if (cycle === 9) {
      snapshotRenders += 1;
      renderHostWorkspaceSelection();
    }
    if (playing) video.currentTime += 0.25;
  }
  return {
    phase,
    presentationActive,
    snapshotRenders,
    sessionStable: state.hostPlaybackSession === original.session,
    programStable: state.hostPlaybackSession.playbackProgram === original.program,
    frameStable: frame === original.frame,
    videoStable: state.hostPlaybackSession.video === original.video,
    audioStable: state.hostPlaybackSession.audio === original.audio,
    videoCount: frame.querySelectorAll("video").length,
    audioCount: frame.querySelectorAll("audio").length,
    srcStable: video.src === original.videoSrc && audio.src === original.audioSrc,
    generationStable: session.playbackGeneration === original.generation,
    timeHealthy: playing ? video.currentTime > original.currentTime : video.currentTime === original.currentTime,
    finalWorkspace: state.activeHostWorkspace,
  };
}
const state = {
  activeHostWorkspace: "queue",
  focusedHostWorkspace: "queue",
  hostWorkspaceOverlayOpen: false,
  hostPlaybackSession: null,
  data: null,
  presentationSession: { phase: "inactive" },
};
` + String(shell_functions) + `
const scenarios = [
  acceptedScenario("playing"),
  acceptedScenario("paused"),
  acceptedScenario("binding"),
  acceptedScenario("playing", true),
];
process.stdout.write(JSON.stringify({ scenarios, forbidden }));
`);
completed = (await runNodeScript(script, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
for (const scenario of iterableValues(result["scenarios"])) {
assert.deepEqual(scenario["snapshotRenders"], 1);
assert.ok(hasContent(scenario["sessionStable"]));
assert.ok(hasContent(scenario["programStable"]));
assert.ok(hasContent(scenario["frameStable"]));
assert.ok(hasContent(scenario["videoStable"]));
assert.ok(hasContent(scenario["audioStable"]));
assert.deepEqual(scenario["videoCount"], 1);
assert.deepEqual(scenario["audioCount"], 1);
assert.ok(hasContent(scenario["srcStable"]));
assert.ok(hasContent(scenario["generationStable"]));
assert.ok(hasContent(scenario["timeHealthy"]));
assert.deepEqual(scenario["finalWorkspace"], "queue");
}
assert.deepEqual(result["forbidden"], {["mount"]: 0, ["replace"]: 0, ["claim"]: 0, ["retire"]: 0, ["load"]: 0, ["play"]: 0, ["pause"]: 0, ["seek"]: 0, ["playerRequests"]: 0});
}
};
test("HostPlaybackSessionFrontendTest.test_audio_variant_request_uses_only_the_observed_item_incarnation", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_audio_variant_request_uses_only_the_observed_item_incarnation(); });
test("HostPlaybackSessionFrontendTest.test_deferred_item_returns_with_fresh_zero_time_media_not_its_old_playhead", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_deferred_item_returns_with_fresh_zero_time_media_not_its_old_playhead(); });
test("HostPlaybackSessionFrontendTest.test_defer_gesture_skips_only_its_own_countdown_including_sse_first", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_defer_gesture_skips_only_its_own_countdown_including_sse_first(); });
test("HostPlaybackSessionFrontendTest.test_stale_variant_and_retry_accept_authority_without_success_ownership", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_stale_variant_and_retry_accept_authority_without_success_ownership(); });
test("HostPlaybackSessionFrontendTest.test_session_state_machine_owns_one_exact_pair", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_session_state_machine_owns_one_exact_pair(); });
test("HostPlaybackSessionFrontendTest.test_exact_retirement_acknowledges_once_after_media_detachment", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_exact_retirement_acknowledges_once_after_media_detachment(); });
test("HostPlaybackSessionFrontendTest.test_pagehide_uses_the_same_exact_idempotent_retirement_boundary", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_pagehide_uses_the_same_exact_idempotent_retirement_boundary(); });
test("HostPlaybackSessionFrontendTest.test_candidate_creation_prepares_one_pair_without_starting_media_load", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_candidate_creation_prepares_one_pair_without_starting_media_load(); });
test("HostPlaybackSessionFrontendTest.test_exact_claim_precedes_loading_and_failure_or_supersession_never_retries", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_exact_claim_precedes_loading_and_failure_or_supersession_never_retries(); });
test("HostPlaybackSessionFrontendTest.test_claim_failure_is_terminal_for_the_same_accepted_program", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_claim_failure_is_terminal_for_the_same_accepted_program(); });
test("HostPlaybackSessionFrontendTest.test_recache_and_variant_replacements_capture_only_exact_ready_session_restore", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_recache_and_variant_replacements_capture_only_exact_ready_session_restore(); });
test("HostPlaybackSessionFrontendTest.test_same_item_program_reconciliation_preserves_an_exact_inflight_next_hold", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_same_item_program_reconciliation_preserves_an_exact_inflight_next_hold(); });
test("HostPlaybackSessionFrontendTest.test_current_session_predicate_requires_authority_and_exact_elements", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_current_session_predicate_requires_authority_and_exact_elements(); });
test("HostPlaybackSessionFrontendTest.test_queued_media_listener_rechecks_exact_session_before_effects", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_queued_media_listener_rechecks_exact_session_before_effects(); });
test("HostPlaybackSessionFrontendTest.test_retirement_settles_owned_seek_once_without_clearing_new_session", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_retirement_settles_owned_seek_once_without_clearing_new_session(); });
test("HostPlaybackSessionFrontendTest.test_player_signature_and_context_are_not_lifetime_authority", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_player_signature_and_context_are_not_lifetime_authority(); });
test("HostPlaybackSessionFrontendTest.test_bootstrap_restarts_before_mounting_one_current_program_pair", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_bootstrap_restarts_before_mounting_one_current_program_pair(); });
test("HostPlaybackSessionFrontendTest.test_page_restore_restarts_rust_program_before_one_fresh_mount", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_page_restore_restarts_rust_program_before_one_fresh_mount(); });
test("HostPlaybackSessionFrontendTest.test_page_restore_reconciles_a_newer_accepted_program_after_a_stale_response", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_page_restore_reconciles_a_newer_accepted_program_after_a_stale_response(); });
test("HostPlaybackSessionFrontendTest.test_resets_retire_only_after_an_authoritative_snapshot_is_accepted", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_resets_retire_only_after_an_authoritative_snapshot_is_accepted(); });
test("HostPlaybackSessionFrontendTest.test_workspace_switching_preserves_exact_session_program_and_media_pair", async () => { const instance = Object.create(HostPlaybackSessionFrontendTest); await instance.setUpClass(); await instance.test_workspace_switching_preserves_exact_session_program_and_media_pair(); });
