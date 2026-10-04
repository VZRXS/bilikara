import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteSseFrontendTest = {
async setUpClass() {
let end, epoch_end, epoch_start, source, start;
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
source = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.source = source;
this.queue_source = readFileSync(path.join(path.join(ROOT, "static"), "remote-queue.js"), "utf8");
start = sourceIndex(source, "function clearEventStreamReconnectTimer");
end = sourceIndex(source, "function connectStateStream", start);
this.reconnect_source = source.slice(start, end);
start = sourceIndex(source, "function currentPlaybackClockSeconds");
end = sourceIndex(source, "function flushPendingAutoRating", start);
this.clock_value_source = source.slice(start, end);
start = sourceIndex(source, "function currentPlayerStatus");
end = sourceIndex(source, "function durationSecondsForItem", start);
this.current_status_source = source.slice(start, end);
start = sourceIndex(source, "function formatPlaybackClockSeconds");
end = sourceIndex(source, "function formatBytes", start);
this.clock_render_source = source.slice(start, end);
start = sourceIndex(source, "function applyStateSnapshot");
end = sourceIndex(source, "function clearEventStreamReconnectTimer", start);
epoch_start = sourceIndex(source, "function stateEpochTransition");
epoch_end = sourceIndex(source, "const CACHE_VOLATILE_ITEM_KEYS", epoch_start);
this.apply_snapshot_source = concatenate(source.slice(epoch_start, epoch_end), source.slice(start, end));
start = sourceIndex(source, "async function fetchState");
end = sourceIndex(source, "async function searchGatchaCache", start);
this.state_transport_source = source.slice(start, end);
start = sourceIndex(source, "function renderCurrentItem");
end = sourceIndex(source, "function renderCurrentRatingButton", start);
this.current_item_render_source = source.slice(start, end);
start = sourceIndex(source, "function currentPlayerStatus");
end = sourceIndex(source, "function renderPlayerControls", start);
this.player_status_sync_source = source.slice(start, end);
start = sourceIndex(source, "function remoteIssueSignatureSet");
end = sourceIndex(source, "function noteRemoteFallbackSuccess", start);
this.issue_source = source.slice(start, end);
start = sourceIndex(source, "function remotePlayerIssueSignature");
end = sourceIndex(source, "function disconnectClient", start);
this.player_control_source = source.slice(start, end);
},
async run_node(body) {
let completed, script;
script = (`
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
` + String(this.reconnect_source) + `
` + String(body) + `
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_host_restart_accepts_new_epoch_and_rejects_retired_responses() {
let end, output, start;
start = sourceIndex(this.source, "function currentStateRevision");
end = sourceIndex(this.source, "const CACHE_VOLATILE_ITEM_KEYS", start);
output = (await this.run_node(concatenate(concatenate(this.source.slice(start, end), this.apply_snapshot_source), `
const state = {data:null, remoteVolumeSaveSeq:0};
const elements = {};
const renderSignatureForSnapshot = JSON.stringify;
function clearRemoteVolumeCommitTimer() {}
function currentPlayerStatus() { return null; }
function clearCurrentPlaybackClock() {}
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function scheduleRender() {}
function renderCacheStatusOnly() {}
const snapshot = (epoch, revision, volume) => ({state_epoch:epoch, state_revision:revision, playlist:[], player_settings:{volume_percent:volume}});
const old = snapshot('old-host', 35, 60);
applyStateSnapshot(old);
const fresh = snapshot('new-host', 4, 80);
const currentAfterRestart = eventStreamStateIsCurrent(fresh);
const acceptedRestart = applyStateSnapshot(fresh);
const acceptedLateOld = applyStateSnapshot({...old,state_revision:99}, {forceRender:true});
const lateOldCurrent = eventStreamStateIsCurrent(old);
const acceptedDuplicate = applyStateSnapshot(fresh);
const acceptedOutOfOrder = applyStateSnapshot(snapshot('new-host',3,70));
const acceptedNewer = applyStateSnapshot(snapshot('new-host',5,85));
const acceptedOlderProtocol = applyStateSnapshot({state_revision:100,player_settings:{volume_percent:10}}, {forceRender:true});
console.log(JSON.stringify({currentAfterRestart,acceptedRestart,acceptedLateOld,lateOldCurrent,acceptedDuplicate,acceptedOutOfOrder,acceptedNewer,acceptedOlderProtocol,epoch:state.data.state_epoch,volume:state.data.player_settings.volume_percent}));
`)));
assert.deepEqual(output, {["currentAfterRestart"]: true, ["acceptedRestart"]: true, ["acceptedLateOld"]: false, ["lateOldCurrent"]: false, ["acceptedDuplicate"]: false, ["acceptedOutOfOrder"]: false, ["acceptedNewer"]: true, ["acceptedOlderProtocol"]: false, ["epoch"]: "new-host", ["volume"]: 85});
},
async test_audio_variant_request_uses_only_the_observed_item_incarnation() {
let end, listener, start;
start = sourceIndex(this.source, "elements.audioVariantBar.addEventListener(\"click\"");
end = sourceIndex(this.source, "elements.playerControlPanel.addEventListener(\"click\"", start);
listener = this.source.slice(start, end);
assert.ok(contains("expected_item_incarnation_id: currentItem.item_incarnation_id", listener));
assert.ok(!contains("playback_generation", listener));
},
async test_expired_native_lan_session_reenters_once_without_redirecting_public_remote() {
let end, output, start;
start = sourceIndex(this.source, "function reenterExpiredLocalRemote");
end = sourceIndex(this.source, "function clearRemoteConnectionOfflineTimer", start);
output = (await this.run_node(concatenate(this.source.slice(start, end), `
const state = {remoteSessionReentering:false};
const visits = [];
const window = {location:{replace:url=>visits.push(url)},BilikaraRemoteTransport:{mode:'internet'}};
const error = {code:'forbidden'};
const publicResult = reenterExpiredLocalRemote({status:403},error);
window.BilikaraRemoteTransport.mode = 'local';
const otherResults = [reenterExpiredLocalRemote({status:500},error),reenterExpiredLocalRemote({status:403},{code:'origin'})];
const first = reenterExpiredLocalRemote({status:403},error);
const concurrent = reenterExpiredLocalRemote({status:403},error);
console.log(JSON.stringify({publicResult,otherResults,first,concurrent,visits}));
`)));
assert.deepEqual(output, {["publicResult"]: false, ["otherResults"]: [false, false], ["first"]: true, ["concurrent"]: true, ["visits"]: ["/remote"]});
},
async test_current_cache_retry_forwards_the_observed_item_incarnation() {
let end, retry_flow, start;
start = sourceIndex(this.source, "function syncCurrentCacheState");
end = sourceIndex(this.source, "elements.historyExportImageButton?.addEventListener(\"click\"", start);
retry_flow = this.source.slice(start, end);
assert.ok(contains("retryBtn.dataset.itemIncarnationId = current.item_incarnation_id", retry_flow));
assert.ok(contains("expected_item_incarnation_id: itemIncarnationId", retry_flow));
assert.ok(contains("button.dataset.itemIncarnationId = item.item_incarnation_id", this.queue_source));
assert.ok(contains("expected_item_incarnation_id: itemIncarnationId", this.queue_source));
},
async test_reconnect_jitter_is_bounded_and_never_subsecond() {
let result;
result = (await this.run_node(`
console.log(JSON.stringify({
  initial: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(1000, value)),
  middle: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(4000, value)),
  capped: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(15000, value)),
}));
`));
assert.deepEqual(result["initial"], [1000, 1125, 1250]);
assert.deepEqual(result["middle"], [4000, 4400, 4800]);
assert.deepEqual(result["capped"], [12000, 13500, 15000]);
assert.ok(Math.min(...concatenate(concatenate(result["initial"], result["middle"]), result["capped"])) >= 1000);
assert.ok(Math.max(...concatenate(concatenate(result["initial"], result["middle"]), result["capped"])) <= 15000);
},
async test_scheduler_jitters_each_attempt_but_doubles_only_base_delay() {
let result;
result = (await this.run_node(`
const delays = [];
const callbacks = new Map();
const cleared = [];
let nextTimerId = 1;
let connectCalls = 0;
const randomValues = [0.4, 0.75];
Math.random = () => randomValues.shift();
const state = { eventStreamRetryMs: 1000, eventStreamReconnectTimer: null };
const window = {
  setTimeout(callback, delayMs) {
    const timerId = nextTimerId++;
    callbacks.set(timerId, callback);
    delays.push(delayMs);
    return timerId;
  },
  clearTimeout(timerId) {
    callbacks.delete(timerId);
    cleared.push(timerId);
  },
};
function connectStateStream() { connectCalls += 1; }
scheduleEventStreamReconnect();
const firstNextBase = state.eventStreamRetryMs;
scheduleEventStreamReconnect();
const secondTimerId = state.eventStreamReconnectTimer;
const secondNextBase = state.eventStreamRetryMs;
callbacks.get(secondTimerId)();
console.log(JSON.stringify({
  delays,
  cleared,
  firstNextBase,
  secondNextBase,
  connectCalls,
  activeTimer: state.eventStreamReconnectTimer,
}));
`));
assert.deepEqual(result, {["delays"]: [1100, 2300], ["cleared"]: [1], ["firstNextBase"]: 2000, ["secondNextBase"]: 4000, ["connectCalls"]: 1, ["activeTimer"]: null});
},
async test_cache_polling_uses_the_revision_guard() {
let end, polling_source, start;
start = sourceIndex(this.source, "async function refreshCacheStatusOnly");
end = sourceIndex(this.source, "function currentStateRevision", start);
polling_source = this.source.slice(start, end);
assert.ok(contains("await fetchState({ force: false });", polling_source));
assert.ok(!contains("state.data = payload.data", polling_source));
},
async run_state_transport_node(body, {event_source_supported = true} = {}) {
let completed, event_source_value, script;
event_source_value = (event_source_supported ? "FakeEventSource" : "undefined");
script = (`
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
const stateFallbackRefreshMs = 1000;
const nativeEventStreamDeadlineMs = 12000;
const document = {visibilityState: "visible"};
let nowMs = 0;
Date.now = () => nowMs;
Math.random = () => 0;
let nextTimerId = 1;
const timers = new Map();
const requests = [];
const stateGetSnapshots = [];
const connectionDiagnostics = [];
const stateGetFailures = [];
const connectionPhases = [];
const appMessages = [];
const renderedCacheStatuses = [];
const renderedCacheProgress = [];
const renderedQueueLengths = [];

async function advanceTime(deltaMs) {
  const target = nowMs + deltaMs;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, task]) => task.due <= target)
      .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
    if (!due) break;
    const [timerId, task] = due;
    timers.delete(timerId);
    nowMs = task.due;
    await task.callback();
    await Promise.resolve();
  }
  nowMs = target;
  await Promise.resolve();
}

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
}
class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closeCalls = 0;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, listener) {
    (this.listeners[name] ||= []).push(listener);
  }
  async emit(name, data = "") {
    const event = { data: typeof data === "string" ? data : JSON.stringify(data) };
    await Promise.all((this.listeners[name] || []).map((listener) => listener(event)));
  }
  close() { this.closeCalls += 1; }
}

const window = {
  EventSource: ` + String(event_source_value) + `,
  setTimeout(callback, delayMs) {
    const timerId = nextTimerId++;
    timers.set(timerId, { callback, due: nowMs + Number(delayMs || 0) });
    return timerId;
  },
  clearTimeout(timerId) { timers.delete(timerId); },
};
globalThis.setTimeout = window.setTimeout;
globalThis.clearTimeout = window.clearTimeout;

const state = {
  clientId: "remote-test",
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  autoRefreshTimer: null,
  stateFallbackFetchInFlight: false,
  eventSource: null,
  eventStreamHealthy: false,
  eventStreamReconnectTimer: null,
  eventStreamRetryMs: eventStreamInitialRetryMs,
  remoteConnectionPhase: "connecting",
  remoteConnectionOfflineTimer: null,
  remoteConnectionFailureStartedAt: null,
  remoteIssueSignatures: new Set(),
  currentNowPlayingSignature: "",
  playerControlStatusSync: null,
};
const elements = {
  currentTitle: { textContent: "" },
  currentRequester: { textContent: "", classList: new FakeClassList() },
  currentOwner: { textContent: "", classList: new FakeClassList() },
  openRatingButton: { classList: new FakeClassList() },
  currentMeta: { textContent: "" },
  playbackDock: {
    classList: new FakeClassList(),
    setAttribute() {},
    removeAttribute() {},
  },
  playbackDockTitle: { textContent: "" },
  playbackDockRequester: { textContent: "", classList: new FakeClassList() },
  playbackDockCoverImage: {},
  playbackSheetCoverImage: {},
  remoteShell: { classList: new FakeClassList() },
};
function clientHeaders() { return {}; }
function localizedApiMessage(value) { return String(value || ""); }
function t(key) { return key; }
function setRemoteConnectionPhase(phase) {
  if (state.remoteConnectionPhase !== phase) {
    state.remoteConnectionPhase = phase;
    connectionPhases.push(phase);
  }
}
function setAppMessage(message, isError) {
  appMessages.push({ message: String(message), isError: Boolean(isError) });
}
function requesterBadgeText() { return ""; }
function ownerLineText() { return ""; }
function normalizedPlaybackCoverUrl() { return ""; }
function syncPlaybackCoverImage() {}
function setPlaybackDockMarqueeText(container, _textNode, value) { container.textContent = value; }
function schedulePlaybackDockMarquee() {}
function resetPlaybackDockMarquees() {}
function closePlaybackSheet() {}
function closePlaybackMetadataPopover() {}
function syncPlaybackMetadataFieldVisibility() {}
function renderOwnerBadgeLabel() {}
function maybeUpdateRemoteRatingPrompt() {}
function syncCurrentCacheState(current) {
  renderedCacheStatuses.push(current?.cache_status || "empty");
  renderedCacheProgress.push(Number(current?.cache_progress || 0));
}
function renderCurrentPlaybackState(current) { syncCurrentCacheState(current); }
function renderPlayerControls() {}
function renderQueueCacheStatus() {}
function frontendPlaybackMode() { return "local"; }
function currentPlayerStatus() { return null; }
function clearCurrentPlaybackClock() {}
function clearRemoteVolumeCommitTimer() { state.remoteVolumeCommitTimer = null; }
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function render() {
  renderedQueueLengths.push(Array.isArray(state.data?.playlist) ? state.data.playlist.length : 0);
  renderCurrentItem(state.data?.current_item, "local");
}
async function fetch(url, options = {}) {
  if (url === "/api/remote/connection-diagnostic") {
    connectionDiagnostics.push(JSON.parse(options.body));
    return {ok:true};
  }
  requests.push({ url, at: nowMs });
  if (stateGetFailures.length) {
    stateGetFailures.shift();
    return {
      ok: false,
      async json() { return { ok: false, error: "fallback failed" }; },
    };
  }
  const snapshot = stateGetSnapshots.length
    ? stateGetSnapshots.shift()
    : state.data;
  return {
    ok: true,
    async json() { return { ok: true, data: snapshot }; },
  };
}
` + String(this.state_transport_source) + `
` + String(this.current_item_render_source) + `
function snapshot(revision, cacheStatus, progress = 0, queueSize = 0) {
  return {
    state_revision: revision,
    playback_generation: 1,
    playback_mode: "local",
    current_item: {
      id: "song-a",
      display_title: "Song A",
      cache_status: cacheStatus,
      cache_progress: progress,
    },
    playlist: Array.from({ length: queueSize }, (_, index) => ({ id: \`queued-\${index}\` })),
  };
}
` + String(body) + `
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_healthy_sse_is_the_only_continuous_cache_state_feed() {
let result;
result = (await this.run_state_transport_node(`
(async () => {
  stateGetSnapshots.push(snapshot(1, "downloading", 0));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;

  connectStateStream();
  const source = FakeEventSource.instances[0];
  await source.emit("open");
  const healthyAfterOpenOnly = state.eventStreamHealthy;
  await source.emit("state", snapshot(1, "downloading", 0));
  for (let second = 1; second <= 10; second += 1) {
    await source.emit("state", snapshot(second + 1, "downloading", second * 9));
    await advanceTime(1000);
  }
  const cacheGetsAfterBootstrap = requests.length - bootstrapGets;
  await source.emit("state", snapshot(12, "ready", 100, 1));
  await advanceTime(50);
  await source.emit("state", snapshot(13, "failed", 100));
  await advanceTime(50);
  process.stdout.write(JSON.stringify({
    bootstrapGets,
    cacheGetsAfterBootstrap,
    healthyAfterOpenOnly,
    healthy: state.eventStreamHealthy,
    autoRefreshTimer: state.autoRefreshTimer,
    renderedCacheStatuses,
    renderedCacheProgress,
    renderedQueueLengths,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["bootstrapGets"], 1);
assert.deepEqual(result["cacheGetsAfterBootstrap"], 0);
assert.ok(!hasContent(result["healthyAfterOpenOnly"]));
assert.ok(hasContent(result["healthy"]));
assert.equal(result["autoRefreshTimer"], null);
assert.ok(contains("downloading", result["renderedCacheStatuses"]));
assert.ok(contains("ready", result["renderedCacheStatuses"]));
assert.ok(contains("failed", result["renderedCacheStatuses"]));
assert.ok(contains(90, result["renderedCacheProgress"]));
assert.ok(contains(1, result["renderedQueueLengths"]));
},
async test_native_heartbeat_detects_silent_loss_without_polling_healthy_stream() {
let result;
result = (await this.run_state_transport_node(`
(async () => {
  const firstState={...snapshot(1,"ready",100),capabilities:{event_heartbeat:true}};
  stateGetSnapshots.push(firstState);
  await fetchState();
  connectStateStream();
  const source=FakeEventSource.instances[0];
  await source.emit("state",firstState);
  await advanceTime(10000);
  await source.emit("heartbeat",{state_revision:1});
  await advanceTime(10000);
  const healthyGets=requests.length;
  // The next state was lost; a newer heartbeat must NOT conceal that loss.
  await source.emit("heartbeat",{state_revision:2});
  await source.emit("state","invalid JSON");
  const second={...firstState,state_revision:2,playback_generation:2,
    current_item:{...firstState.current_item,id:"song-b",display_title:"Song B"}};
  stateGetSnapshots.push(second);
  window.EventSource=class extends FakeEventSource {
    constructor(url) { super(url); queueMicrotask(()=>this.emit("state",second)); }
  };
  await advanceTime(2100);
  await advanceTime(1000);
  const recovered=FakeEventSource.instances.at(-1);
  await recovered.emit("state",second);
  await source.emit("state",{...firstState,state_revision:100});
  await advanceTime(50);
  process.stdout.write(JSON.stringify({healthyGets,gets:requests.length,
    item:state.data.current_item.id,title:elements.currentTitle.textContent,
    healthy:state.eventStreamHealthy,closed:source.closeCalls,
    diagnostics:connectionDiagnostics.map(entry=>entry.event)}));
})().catch(error=>{process.stderr.write(String(error));process.exit(1);});
`));
assert.deepEqual(result["healthyGets"], 1);
assert.deepEqual(result["gets"], 2);
assert.deepEqual(result["item"], "song-b");
assert.deepEqual(result["title"], "Song B");
assert.ok(hasContent(result["healthy"]));
assert.deepEqual(result["closed"], 1);
assert.ok(contains("invalid_state", result["diagnostics"]));
assert.ok(contains("stale", result["diagnostics"]));
},
async test_event_source_unsupported_uses_one_bounded_fallback_timer() {
let result;
result = (await this.run_state_transport_node(`
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  stateGetSnapshots.push(
    snapshot(2, "downloading", 20),
    snapshot(1, "queued", 0),
    snapshot(3, "ready", 100),
  );
  connectStateStream();
  await advanceTime(3000);
  process.stdout.write(JSON.stringify({
    fallbackGets: requests.length - bootstrapGets,
    activeFallbackTimers: state.autoRefreshTimer === null ? 0 : 1,
    fallbackFetchInFlight: state.stateFallbackFetchInFlight,
    finalRevision: state.data?.state_revision,
    finalStatus: state.data?.current_item?.cache_status,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`, {event_source_supported: false}));
assert.deepEqual(result["fallbackGets"], 3);
assert.deepEqual(result["activeFallbackTimers"], 1);
assert.ok(!hasContent(result["fallbackFetchInFlight"]));
assert.deepEqual(result["finalRevision"], 3);
assert.deepEqual(result["finalStatus"], "ready");
},
async test_event_source_without_valid_state_uses_then_cancels_fallback() {
let result;
result = (await this.run_state_transport_node(`
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  stateGetSnapshots.push(snapshot(2, "downloading", 40));
  connectStateStream();
  const source = FakeEventSource.instances[0];
  await source.emit("open");
  await advanceTime(1000);
  const getsWithoutValidState = requests.length - bootstrapGets;
  await source.emit("state", snapshot(3, "ready", 100));
  await advanceTime(5000);
  process.stdout.write(JSON.stringify({
    getsWithoutValidState,
    getsAfterRecovery: requests.length - bootstrapGets,
    healthy: state.eventStreamHealthy,
    fallbackTimer: state.autoRefreshTimer,
    finalRevision: state.data?.state_revision,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["getsWithoutValidState"], 1);
assert.deepEqual(result["getsAfterRecovery"], 1);
assert.ok(hasContent(result["healthy"]));
assert.equal(result["fallbackTimer"], null);
assert.deepEqual(result["finalRevision"], 3);
},
async test_remote_connection_phase_tracks_sse_and_bounded_fallback_recovery() {
let result, url;
result = (await this.run_state_transport_node(`
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  const initialPhase = state.remoteConnectionPhase;

  connectStateStream();
  const first = FakeEventSource.instances[0];
  await first.emit("open");
  const phaseAfterOpen = state.remoteConnectionPhase;
  await first.emit("state", "not-json");
  const readyAfterMalformed = state.eventStreamHealthy;
  await first.emit("state", snapshot(0, "stale", 0));
  const readyAfterStale = state.eventStreamHealthy;
  await first.emit("state", snapshot(1, "ready", 100));
  const phaseAfterValidState = state.remoteConnectionPhase;

  await first.emit("error");
  const phaseAfterError = state.remoteConnectionPhase;
  const messagesAfterError = appMessages.length;
  stateGetSnapshots.push(snapshot(2, "downloading", 40));
  await advanceTime(2000);
  const phaseAfterFallbackSuccess = state.remoteConnectionPhase;
  const healthyAfterFallbackSuccess = state.eventStreamHealthy;

  stateGetFailures.push(true, true, true, true, true);
  await advanceTime(4000);
  const phaseAfterOfflineGrace = state.remoteConnectionPhase;
  const messagesAfterOffline = appMessages.length;
  await advanceTime(1000);
  const phaseAfterRepeatedFailure = state.remoteConnectionPhase;
  const messagesAfterRepeatedFailure = appMessages.length;

  const recoverySource = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  await recoverySource.emit("state", snapshot(3, "ready", 100));
  const phaseAfterRecovery = state.remoteConnectionPhase;
  process.stdout.write(JSON.stringify({
    initialPhase,
    phaseAfterOpen,
    readyAfterMalformed,
    readyAfterStale,
    phaseAfterValidState,
    phaseAfterError,
    messagesAfterError,
    phaseAfterFallbackSuccess,
    healthyAfterFallbackSuccess,
    phaseAfterOfflineGrace,
    messagesAfterOffline,
    phaseAfterRepeatedFailure,
    messagesAfterRepeatedFailure,
    phaseAfterRecovery,
    offlineIssuePresent: state.remoteIssueSignatures.has("remote-connection-offline"),
    eventSourceCount: FakeEventSource.instances.length,
    stateRequestUrls: requests.map((request) => request.url),
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["initialPhase"], "connecting");
assert.deepEqual(result["phaseAfterOpen"], "connecting");
assert.ok(!hasContent(result["readyAfterMalformed"]));
assert.ok(!hasContent(result["readyAfterStale"]));
assert.deepEqual(result["phaseAfterValidState"], "connected");
assert.deepEqual(result["phaseAfterError"], "reconnecting");
assert.deepEqual(result["messagesAfterError"], 0);
assert.deepEqual(result["phaseAfterFallbackSuccess"], "reconnecting");
assert.ok(!hasContent(result["healthyAfterFallbackSuccess"]));
assert.deepEqual(result["phaseAfterOfflineGrace"], "offline");
assert.deepEqual(result["messagesAfterOffline"], 1);
assert.deepEqual(result["phaseAfterRepeatedFailure"], "offline");
assert.deepEqual(result["messagesAfterRepeatedFailure"], 1);
assert.deepEqual(result["phaseAfterRecovery"], "connected");
assert.ok(!hasContent(result["offlineIssuePresent"]));
assert.deepEqual(result["eventSourceCount"], 2);
assert.ok(hasContent(Array.from(Array.from(iterableValues(result["stateRequestUrls"]))).map((url) => ((url === "/api/state"))).every(Boolean)));
},
async test_transient_sse_reconnect_has_no_parallel_full_state_get() {
let result;
result = (await this.run_state_transport_node(`
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  connectStateStream();
  const first = FakeEventSource.instances[0];
  await first.emit("state", snapshot(1, "ready", 100));
  await first.emit("error");
  const getsImmediatelyAfterError = requests.length - bootstrapGets;
  const timersAfterFirstError = timers.size;
  await first.emit("error");
  const timersAfterRepeatedError = timers.size;

  await advanceTime(1000);
  const second = FakeEventSource.instances[1];
  await first.emit("error");
  const newerSourceCloseCallsAfterOldError = second.closeCalls;
  await second.emit("state", snapshot(2, "downloading", 50));
  await advanceTime(5000);
  process.stdout.write(JSON.stringify({
    getsImmediatelyAfterError,
    getsAfterRecovery: requests.length - bootstrapGets,
    timersAfterFirstError,
    timersAfterRepeatedError,
    sourceCount: FakeEventSource.instances.length,
    firstCloseCalls: first.closeCalls,
    newerSourceCloseCallsAfterOldError,
    healthy: state.eventStreamHealthy,
    fallbackTimer: state.autoRefreshTimer,
    reconnectTimer: state.eventStreamReconnectTimer,
    finalRevision: state.data?.state_revision,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["getsImmediatelyAfterError"], 0);
assert.deepEqual(result["getsAfterRecovery"], 0);
assert.ok(result["timersAfterFirstError"] <= 2);
assert.deepEqual(result["timersAfterRepeatedError"], result["timersAfterFirstError"]);
assert.deepEqual(result["sourceCount"], 2);
assert.deepEqual(result["firstCloseCalls"], 1);
assert.deepEqual(result["newerSourceCloseCallsAfterOldError"], 0);
assert.ok(hasContent(result["healthy"]));
assert.equal(result["fallbackTimer"], null);
assert.equal(result["reconnectTimer"], null);
assert.deepEqual(result["finalRevision"], 2);
},
async test_startup_retains_initial_get_before_connecting_sse() {
let end, start, startup_source;
start = sourceIndex(this.source, "async function startRemoteSession");
end = sourceIndex(this.source, "startRemoteSession();", start);
startup_source = this.source.slice(start, end);
assert.ok(sourceIndex(startup_source, "await fetchState();") < sourceIndex(startup_source, "connectStateStream();"));
},
async test_player_status_and_clock_fail_closed_by_playback_generation() {
let completed, result, script;
script = (`
let nowMs = 1000;
Date.now = () => nowMs;
let nextTimerId = 1;
const activeIntervals = new Set();
const window = {
  setInterval(_callback, _delayMs) {
    const timerId = nextTimerId++;
    activeIntervals.add(timerId);
    return timerId;
  },
  clearInterval(timerId) { activeIntervals.delete(timerId); },
};
const state = {
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlStatusSync: null,
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
  remoteIssueSignatures: new Set(),
};
const clockText = { textContent: "" };
const elements = {
  currentCacheState: {
    textContent: "",
    querySelector() { return clockText; },
  },
};
function currentStateRevision(snapshot) { return Number(snapshot?.state_revision || 0); }
function renderSignatureForSnapshot(snapshot) {
  return JSON.stringify({
    playback_generation: snapshot?.playback_generation,
    current_item: snapshot?.current_item,
  });
}
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function scheduleRender() {}
function renderCacheStatusOnly() {}
function durationSecondsForItem(item) { return Number(item?.duration || 0); }
function playerControlStatusSyncPending() { return false; }
function clearPlayerControlStatusSync() {}
function syncCurrentCacheState() {}
function maybeUpdateRemoteRatingPrompt() {}
console.warn = () => {};
` + String(this.clock_value_source) + `
` + String(this.current_status_source) + `
` + String(this.clock_render_source) + `
` + String(this.apply_snapshot_source) + `
function snapshot(revision, generation, status, extra = {}) {
  return {
    state_revision: revision,
    playback_generation: generation,
    playback_program: {
      item_id: "song-a",
      item_incarnation_id: \`i-\${generation}\`,
      selected_audio_variant_id: "instrumental",
      artifact_set_id: \`a-\${generation}\`,
    },
    current_item: { id: "song-a", cache_status: "ready", duration: 100 },
    player_status: status,
    ...extra,
  };
}
function status(generation, currentTime) {
  return {
    playback_generation: generation,
    item_id: "song-a",
    observed_phase: "playing",
    is_paused: false,
    current_time: currentTime,
    duration: 100,
    updated_at: generation * 100,
  };
}

const first = snapshot(1, 1, status(1, 10));
const acceptedFirst = applyStateSnapshot(first);
renderCurrentPlaybackState(state.data.current_item);
const firstTimer = state.currentPlaybackClockTimer;
const matchingFirst = currentPlayerStatus(state.data.current_item);

const sameProgram = snapshot(2, 1, status(1, 10), { python_only: "changed" });
const acceptedSame = applyStateSnapshot(sameProgram);
const retainedTimer = state.currentPlaybackClockTimer;
const sameProgramRetained = firstTimer === retainedTimer && activeIntervals.has(firstTimer);

const mismatched = snapshot(3, 2, status(1, 80));
const acceptedMismatch = applyStateSnapshot(mismatched);
const mismatchResult = {
  currentStatus: currentPlayerStatus(state.data.current_item),
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
};

const replacement = snapshot(4, 2, status(2, 3));
const acceptedReplacement = applyStateSnapshot(replacement);
renderCurrentPlaybackState(state.data.current_item);
const replacementResult = {
  generation: currentPlayerStatus(state.data.current_item)?.playback_generation,
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
};

const duplicateAccepted = applyStateSnapshot(snapshot(4, 2, status(2, 90)));
const inverseAccepted = applyStateSnapshot(snapshot(3, 1, status(1, 90)));
console.log(JSON.stringify({
  acceptedFirst,
  matchingFirstGeneration: matchingFirst?.playback_generation,
  acceptedSame,
  sameProgramRetained,
  acceptedMismatch,
  mismatchResult,
  acceptedReplacement,
  replacementResult,
  duplicateAccepted,
  inverseAccepted,
  finalCurrentTime: state.data.player_status.current_time,
  finalGeneration: state.data.playback_generation,
}));
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.ok(hasContent(result["acceptedFirst"]));
assert.deepEqual(result["matchingFirstGeneration"], 1);
assert.ok(hasContent(result["acceptedSame"]));
assert.ok(hasContent(result["sameProgramRetained"]), result);
assert.ok(hasContent(result["acceptedMismatch"]));
assert.deepEqual(result["mismatchResult"], {["currentStatus"]: null, ["timer"]: null, ["paused"]: true, ["base"]: 0});
assert.ok(hasContent(result["acceptedReplacement"]));
assert.deepEqual(result["replacementResult"]["generation"], 2);
assert.notEqual(result["replacementResult"]["timer"], null);
assert.ok(!hasContent(result["replacementResult"]["paused"]));
assert.deepEqual(result["replacementResult"]["base"], 3);
assert.ok(!hasContent(result["duplicateAccepted"]));
assert.ok(!hasContent(result["inverseAccepted"]));
assert.deepEqual(result["finalCurrentTime"], 3);
assert.deepEqual(result["finalGeneration"], 2);
},
async run_player_control_sync_node(body) {
let completed, script;
script = (`
const playerControlStatusRefreshDelaysMs = [180, 520, 1100, 1800];
const playerControlStatusSyncTimeoutMs = 3200;
let nowMs = 1000;
Date.now = () => nowMs;
let nextTimerId = 1;
const timers = new Map();
const intervals = new Map();
const commandRequests = [];
const messages = [];
const fallbackSnapshots = [];
let fetchStateCalls = 0;
let commandApplied = true;

async function advanceTime(deltaMs) {
  const target = nowMs + deltaMs;
  while (true) {
    const due = [...timers.entries()]
      .filter(([, task]) => task.due <= target)
      .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
    if (!due) break;
    const [timerId, task] = due;
    timers.delete(timerId);
    nowMs = task.due;
    await task.callback();
    await Promise.resolve();
  }
  nowMs = target;
  await Promise.resolve();
}

const window = {
  setTimeout(callback, delayMs) {
    const timerId = nextTimerId++;
    timers.set(timerId, { callback, due: nowMs + Number(delayMs || 0) });
    return timerId;
  },
  clearTimeout(timerId) { timers.delete(timerId); },
  setInterval(callback, delayMs) {
    const timerId = nextTimerId++;
    intervals.set(timerId, { callback, delayMs });
    return timerId;
  },
  clearInterval(timerId) { intervals.delete(timerId); },
};

const state = {
  data: null,
  eventStreamHealthy: true,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  playerControlStatusRefreshTimers: [],
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
};
const clockText = { textContent: "" };
const elements = {
  currentCacheState: {
    textContent: "",
    querySelector() { return clockText; },
  },
};
function frontendPlaybackMode() { return "local"; }
function canRemoteControlPlayer() { return true; }
function renderPlayerControls() {}
function syncCurrentCacheState() {}
function maybeUpdateRemoteRatingPrompt() {}
function setFormMessage(message, isError = false) { messages.push({ message, isError }); }
function t(key) { return key; }
console.warn = () => {};
function applyStateSnapshot(snapshot) {
  if (
    state.data
    && Number(snapshot?.state_revision || 0) <= Number(state.data?.state_revision || 0)
  ) return false;
  const previousGeneration = state.data?.playback_generation;
  state.data = snapshot;
  if (
    previousGeneration !== undefined
    && previousGeneration !== snapshot.playback_generation
  ) clearCurrentPlaybackClock();
  renderCurrentPlaybackState(snapshot.current_item);
  renderPlayerControls(snapshot.current_item, "local");
  return true;
}
async function fetchState() {
  fetchStateCalls += 1;
  if (fallbackSnapshots.length) applyStateSnapshot(fallbackSnapshots.shift());
}
async function apiPost(path, payload) {
  commandRequests.push({ path, payload: { ...payload } });
  return {
    ...state.data,
    state_revision: Number(state.data?.state_revision || 0) + 1,
  };
}
async function apiPostExactStateCommand(path, payload) {
  const snapshot = await apiPost(path, payload);
  return {
    snapshotAccepted: applyStateSnapshot(snapshot),
    commandApplied,
  };
}
function playerSnapshot(revision, generation, itemId, updatedAt, currentTime, isPaused = false) {
  return {
    state_revision: revision,
    playback_generation: generation,
    playback_mode: "local",
    current_item: {
      id: itemId,
      cache_status: "ready",
      duration: 120,
      video_url: "/media/video.mp4",
      audio_url: "/media/audio.m4a",
    },
    player_status: updatedAt === null ? null : {
      playback_generation: generation,
      item_id: itemId,
      observed_phase: isPaused ? "paused" : "playing",
      is_paused: isPaused,
      current_time: currentTime,
      duration: 120,
      updated_at: updatedAt,
    },
  };
}
` + String(this.clock_value_source) + `
` + String(this.player_status_sync_source) + `
` + String(this.clock_render_source) + `
` + String(this.issue_source) + `
` + String(this.player_control_source) + `
` + String(body) + `
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_healthy_sse_settles_player_control_without_refresh_burst() {
let result;
result = (await this.run_player_control_sync_node(`
(async () => {
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  await sendPlayerControl("seek-relative", 15);
  const timersAfterCommand = state.playerControlStatusRefreshTimers.length;
  await advanceTime(2000);
  const getsBeforeMatchingStatus = fetchStateCalls;

  applyStateSnapshot(playerSnapshot(3, 7, "song-a", 200, 30));
  const matchingStatus = {
    pending: state.playerControlStatusSync,
    clockBase: state.currentPlaybackClockBaseSeconds,
    clockPaused: state.currentPlaybackClockPaused,
    clockTimerActive: state.currentPlaybackClockTimer !== null,
  };
  await advanceTime(2000);

  commandApplied = false;
  await sendPlayerControl("toggle-play", 0);
  const staleOutcome = {
    pending: state.playerControlStatusSync,
    messageCount: messages.length,
    pendingAction: state.playerControlPendingAction,
  };

  commandApplied = true;
  beginPlayerControlStatusSync(state.data.current_item);
  applyStateSnapshot(playerSnapshot(5, 8, "song-b", null, 0, true));
  process.stdout.write(JSON.stringify({
    commandRequests,
    timersAfterCommand,
    getsBeforeMatchingStatus,
    finalFetchStateCalls: fetchStateCalls,
    matchingStatus,
    staleOutcome,
    messages,
    pendingAfterProgramChange: state.playerControlStatusSync,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["commandRequests"].length, 2);
assert.deepEqual(result["timersAfterCommand"], 1);
assert.deepEqual(result["getsBeforeMatchingStatus"], 0);
assert.deepEqual(result["finalFetchStateCalls"], 0);
assert.deepEqual(result["matchingStatus"], {["pending"]: null, ["clockBase"]: 30, ["clockPaused"]: false, ["clockTimerActive"]: true});
assert.deepEqual(result["staleOutcome"], {["pending"]: null, ["messageCount"]: 1, ["pendingAction"]: ""});
assert.deepEqual(result["messages"], [{["message"]: "remote.controlSentForward", ["isError"]: false}]);
assert.equal(result["pendingAfterProgramChange"], null);
},
async test_player_control_without_usable_sse_has_no_refresh_burst_or_retry() {
let result;
result = (await this.run_player_control_sync_node(`
(async () => {
  state.eventStreamHealthy = false;
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  await sendPlayerControl("toggle-play", 0);
  await advanceTime(3300);
  process.stdout.write(JSON.stringify({
    commandRequestCount: commandRequests.length,
    fetchStateCalls,
    pending: state.playerControlStatusSync,
    pendingAction: state.playerControlPendingAction,
    activeStatusTimers: state.playerControlStatusRefreshTimers.length,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["commandRequestCount"], 1);
assert.ok(result["fetchStateCalls"] <= 1);
assert.equal(result["pending"], null);
assert.deepEqual(result["pendingAction"], "");
assert.deepEqual(result["activeStatusTimers"], 0);
},
async test_failed_player_commands_use_incarnation_scoped_deduplicated_toasts() {
let result;
result = (await this.run_player_control_sync_node(`
(async () => {
  globalThis.setAppMessage = (message, isError) => messages.push({ message: String(message), isError: Boolean(isError) });
  commandApplied = false;
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  state.data.current_item.item_incarnation_id = "incarnation-a";
  await sendPlayerControl("seek-relative", 15);
  await sendPlayerControl("seek-relative", 15);
  state.data = {
    ...state.data,
    playback_generation: 8,
    current_item: {
      ...state.data.current_item,
      item_incarnation_id: "incarnation-b",
    },
  };
  await sendPlayerControl("seek-relative", 15);
  process.stdout.write(JSON.stringify({
    messages,
    issueSignatures: [...state.remoteIssueSignatures],
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.deepEqual(result["messages"], [{["message"]: "remote.controlRejected", ["isError"]: true}, {["message"]: "remote.controlRejected", ["isError"]: true}]);
assert.deepEqual(result["issueSignatures"], ["player-command:seek-relative:song-a:incarnation-a:7", "player-command:seek-relative:song-a:incarnation-b:8"]);
},
async test_remote_program_relative_controls_capture_the_observed_rust_generation() {
let completed, requests, script;
script = (`
const requests = [];
const state = {
  data: {
    state_revision: 10,
    playback_generation: 41,
    current_item: { id: "song-a" },
  },
  playerControlPendingAction: "",
};
function frontendPlaybackMode() { return "local"; }
function canRemoteControlPlayer() { return true; }
function beginPlayerControlStatusSync() {}
function clearPlayerControlStatusSync() {}
function renderCurrentPlaybackState() {}
function renderPlayerControls() {}
function setFormMessage() {}
function t(key) { return key; }
function applyStateSnapshot(snapshot) { state.data = snapshot; return true; }
async function fetchState() {}
async function apiPost(path, payload) {
  requests.push({ path, payload: { ...payload } });
  return { ...state.data, state_revision: state.data.state_revision + 1 };
}
async function apiPostExactStateCommand(path, payload) {
  const snapshot = await apiPost(path, payload);
  return {
    snapshotAccepted: applyStateSnapshot(snapshot),
    commandApplied: true,
  };
}
` + String(this.player_control_source) + `
(async () => {
  await sendPlayerControl("seek-relative", 15);
  await sendPlayerControl("seek-absolute", 42);
  state.data = { ...state.data, state_revision: 99 };
  await sendPlayerNext();
  await sendPlayerControl("next-track");
  process.stdout.write(JSON.stringify(requests));
})();
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
requests = JSON.parse(completed.stdout);
assert.deepEqual(requests, [{["path"]: "/api/player/control", ["payload"]: {["action"]: "seek-relative", ["item_id"]: "song-a", ["delta_seconds"]: 15, ["playback_generation"]: 41}}, {["path"]: "/api/player/control", ["payload"]: {["action"]: "seek-absolute", ["item_id"]: "song-a", ["delta_seconds"]: 0, ["playback_generation"]: 41, ["target_seconds"]: 42}}, {["path"]: "/api/player/next", ["payload"]: {["playback_generation"]: 41}}, {["path"]: "/api/player/control", ["payload"]: {["action"]: "next-track", ["item_id"]: "song-a", ["delta_seconds"]: 0, ["playback_generation"]: 41}}]);
},
async test_stale_exact_commands_update_state_without_success_ui_or_refetch() {
let completed, result, script;
script = (`
const state = {
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
};
const messages = [];
const requests = [];
let fetchStateCalls = 0;
let controlRenders = 0;
function currentStateRevision(snapshot) { return Number(snapshot?.state_revision || 0); }
function renderSignatureForSnapshot(snapshot) {
  return JSON.stringify({
    revision: snapshot?.state_revision || 0,
    generation: snapshot?.playback_generation || 0,
    incarnation: snapshot?.current_item?.item_incarnation_id || "",
  });
}
function currentPlayerStatus() { return null; }
function clearCurrentPlaybackClock() {}
function clearRemoteVolumeCommitTimer() { state.remoteVolumeCommitTimer = null; }
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function scheduleRender() {}
function renderCacheStatusOnly() {}
function frontendPlaybackMode() { return "local"; }
function canRemoteControlPlayer() { return true; }
function beginPlayerControlStatusSync() {}
function clearPlayerControlStatusSync() {}
function renderCurrentPlaybackState() {}
function renderPlayerControls() { controlRenders += 1; }
function setFormMessage(message, isError = false) { messages.push({ message, isError }); }
function t(key) { return key; }
async function fetchState() { fetchStateCalls += 1; }
` + String(this.apply_snapshot_source) + `

const initial = {
  state_revision: 10,
  playback_generation: 41,
  playback_mode: "local",
  current_item: { id: "song-a", item_incarnation_id: "i-a" },
};
const replacement = {
  state_revision: 11,
  playback_generation: 42,
  playback_mode: "local",
  current_item: { id: "song-a", item_incarnation_id: "i-b" },
};
applyStateSnapshot(initial);
async function apiPostExactStateCommand(path, payload) {
  requests.push({ path, payload });
  return {
    snapshotAccepted: applyStateSnapshot(replacement),
    commandApplied: false,
  };
}
` + String(this.player_control_source) + `
(async () => {
  await sendPlayerNext();
  process.stdout.write(JSON.stringify({
    requests,
    messages,
    fetchStateCalls,
    controlRenders,
    pendingAction: state.playerControlPendingAction,
    acceptedRevision: state.data.state_revision,
    acceptedGeneration: state.data.playback_generation,
    acceptedIncarnation: state.data.current_item.item_incarnation_id,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result, {["requests"]: [{["path"]: "/api/player/next", ["payload"]: {["playback_generation"]: 41}}], ["messages"]: [], ["fetchStateCalls"]: 0, ["controlRenders"]: 2, ["pendingAction"]: "", ["acceptedRevision"]: 11, ["acceptedGeneration"]: 42, ["acceptedIncarnation"]: "i-b"});
},
async test_remote_variant_and_retry_stale_ui_settles_once() {
let audio_listener, completed, result, retry_listener, script;
audio_listener = this.source.slice(sourceIndex(this.source, "elements.audioVariantBar.addEventListener(\"click\""), sourceIndex(this.source, "elements.playerControlPanel.addEventListener(\"click\"", sourceIndex(this.source, "elements.audioVariantBar.addEventListener(\"click\"")));
retry_listener = this.source.slice(sourceIndex(this.source, "elements.currentCacheState?.addEventListener(\"click\""), sourceIndex(this.source, "elements.historyExportImageButton?.addEventListener(\"click\"", sourceIndex(this.source, "elements.currentCacheState?.addEventListener(\"click\"")));
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
const audioVariantPopover = new FakeElement();
const currentCacheState = new FakeElement();
const elements = { audioVariantBar, audioVariantPopover, currentCacheState };
const window = { confirm: () => true };
const audioVariantSwitchDebounceMs = 350;
const state = {
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlStatusSync: null,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantBarExpanded: false,
};
const messages = [];
const requests = [];
const responses = [];
let renders = 0;
let unlockSchedules = 0;
let busyObservations = 0;
function currentStateRevision(snapshot) { return Number(snapshot?.state_revision || 0); }
function renderSignatureForSnapshot(snapshot) { return JSON.stringify(snapshot); }
function currentPlayerStatus() { return null; }
function clearCurrentPlaybackClock() {}
function clearRemoteVolumeCommitTimer() { state.remoteVolumeCommitTimer = null; }
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function scheduleRender() {}
function renderCacheStatusOnly() {}
function frontendPlaybackMode() { return "local"; }
function renderAudioVariantBar() {}
function setAudioVariantPopoverOpen() {}
function audioVariantSwitchLocked() {
  return state.audioVariantSwitchInFlight || Date.now() < state.audioVariantSwitchUnlockAt;
}
function scheduleAudioVariantSwitchUnlock() { unlockSchedules += 1; }
function selectedAudioVariantForItem(item) {
  return item?.audio_variants?.find((variant) => variant.id === item.selected_audio_variant_id) || null;
}
function setFormMessage(message, isError = false) { messages.push({ message, isError }); }
function t(key) { return key; }
function render() { renders += 1; }
` + String(this.apply_snapshot_source) + `
function item(incarnation, selectedVariant = "instrumental", cacheStatus = "failed") {
  return {
    id: "song-a",
    item_incarnation_id: incarnation,
    selected_audio_variant_id: selectedVariant,
    cache_status: cacheStatus,
    audio_variants: [
      { id: "instrumental", label: "Instrumental", audio_url: "/media/i.m4a" },
      { id: "vocal", label: "Vocal", audio_url: "/media/v.m4a" },
    ],
  };
}
function snapshot(revision, currentItem) {
  return {
    state_revision: revision,
    playback_generation: revision,
    playback_mode: "local",
    current_item: currentItem,
    playlist: [],
  };
}
async function apiPostExactStateCommand(path, payload) {
  requests.push({ path, payload });
  if (path === "/api/cache/retry") {
    const button = activeRetryButton;
    if (button?.disabled && button?.getAttribute("aria-busy") === "true") {
      busyObservations += 1;
    }
  }
  const response = responses.shift();
  return {
    snapshotAccepted: applyStateSnapshot(response.snapshot),
    commandApplied: response.applied,
  };
}
` + String(audio_listener) + `
` + String(retry_listener) + `
let activeRetryButton = null;
function audioEventButton(currentItem) {
  const button = new FakeElement({
    itemId: currentItem.id,
    bound: "true",
    variantId: "vocal",
  });
  return { closest: (selector) => selector === "button[data-variant-id]" ? button : null };
}
function retryEventButton(currentItem) {
  const button = new FakeElement({
    id: currentItem.id,
    itemIncarnationId: currentItem.item_incarnation_id,
  });
  activeRetryButton = button;
  return { button, event: { target: { closest: () => button }, stopPropagation() {} } };
}

(async () => {
  applyStateSnapshot(snapshot(1, item("i-1")));
  responses.push({ snapshot: snapshot(2, item("i-2")), applied: false });
  await audioVariantPopover.listeners.click({ target: audioEventButton(state.data.current_item) });
  const staleAudio = {
    messages: messages.splice(0),
    inFlight: state.audioVariantSwitchInFlight,
    unlockAt: state.audioVariantSwitchUnlockAt,
    incarnation: state.data.current_item.item_incarnation_id,
  };

  responses.push({ snapshot: snapshot(3, item("i-3")), applied: false });
  const staleRetryTarget = retryEventButton(state.data.current_item);
  await currentCacheState.listeners.click(staleRetryTarget.event);
  const staleRetry = {
    messages: messages.splice(0),
    disabled: staleRetryTarget.button.disabled,
    busy: staleRetryTarget.button.getAttribute("aria-busy"),
    incarnation: state.data.current_item.item_incarnation_id,
  };

  responses.push({ snapshot: snapshot(4, item("i-3", "vocal")), applied: true });
  await audioVariantPopover.listeners.click({ target: audioEventButton(state.data.current_item) });
  const validAudio = { messages: messages.splice(0) };

  responses.push({ snapshot: snapshot(5, item("i-3", "vocal", "downloading")), applied: true });
  const validRetryTarget = retryEventButton(state.data.current_item);
  await currentCacheState.listeners.click(validRetryTarget.event);
  const validRetry = {
    messages: messages.splice(0),
    disabled: validRetryTarget.button.disabled,
    busy: validRetryTarget.button.getAttribute("aria-busy"),
  };

  process.stdout.write(JSON.stringify({
    staleAudio,
    staleRetry,
    validAudio,
    validRetry,
    requests,
    renders,
    unlockSchedules,
    busyObservations,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result["staleAudio"], {["messages"]: [], ["inFlight"]: false, ["unlockAt"]: 0, ["incarnation"]: "i-2"});
assert.deepEqual(result["staleRetry"], {["messages"]: [], ["disabled"]: false, ["busy"]: null, ["incarnation"]: "i-3"});
assert.deepEqual(result["validAudio"], {["messages"]: [{["message"]: "player.switchedPart", ["isError"]: false}]});
assert.deepEqual(result["validRetry"], {["messages"]: [{["message"]: "cache.retryStarted", ["isError"]: false}], ["disabled"]: false, ["busy"]: null});
assert.deepEqual(result["requests"].length, 4);
assert.deepEqual(result["renders"], 2);
assert.deepEqual(result["unlockSchedules"], 2);
assert.deepEqual(result["busyObservations"], 2);
},
async test_enhanced_queue_preserves_nodes_on_unrelated_updates() {
let end, enhanced, helper, script, start;
helper = this.source.slice(sourceIndex(this.source, "function queueRenderSignatureForItem"), sourceIndex(this.source, "function createQueueEmptyNode"));
start = sourceIndex(this.queue_source, "const pendingQueueActions");
end = sourceIndex(this.queue_source, "function clearDropIndicators", start);
enhanced = this.queue_source.slice(start, end);
script = concatenate(concatenate(concatenate(`
const assert = require('node:assert/strict');
const state = {data:{state_epoch:'one',current_item:{id:'now'}},language:'zh',queueRenderSignature:''};
let renderQueue, replacements=0, cacheUpdates=0;
class Node {
  constructor(){this.dataset={};this.disabled=false;this.attributes={};this.children=new Map();this.classList={add(){},remove(){},toggle(){}};}
  setAttribute(k,v){this.attributes[k]=v;}
  querySelector(k){if(!this.children.has(k))this.children.set(k,new Node());return this.children.get(k);}
  querySelectorAll(){const button=this.querySelector('action');button.dataset.action='retry-cache';return [button];}
}
const list = {nodes:[],replaceChildren(){replacements++;this.nodes=[];},appendChild(n){this.nodes.push(n);},
 querySelectorAll(selector){return selector==='[data-drag-handle]'?[]:this.nodes.flatMap(n=>n.querySelectorAll());}};
const elements={queueList:list,queueItemTemplate:{content:{firstElementChild:{cloneNode:()=>new Node()}}}};
function applyStaticI18n(){} function t(k){return k;}
function requesterBadgeText(name){return name;} function queueNoteText(item){return item.cache_message||'';}
function queueStateLabel(item){return item.cache_status;} function syncQueueItemRetryButton(){}
function renderQueueCacheStatus(){cacheUpdates++;} function createQueueEmptyNode(){return new Node();}
function syncDropIndicators(){}
`, helper), enhanced), `
const items=[{id:'a',item_incarnation_id:'i-a',display_title:'A',requester_name:'Alice',cache_status:'downloading'}];
renderQueue(items);const node=list.nodes[0];
for(let i=0;i<5;i++){
 state.data.state_revision=i;renderQueue([{...items[0],cache_progress:i,cache_message:'progress '+i}]);
 assert.equal(list.nodes[0],node);
}
assert.equal(replacements,1);assert.equal(cacheUpdates,5);
const button=node.querySelectorAll()[0];
pendingQueueActions.set(queueActionKey('retry-cache','a'),new Map());
renderQueue(items);assert.equal(button.disabled,true);assert.equal(button.attributes['aria-busy'],'true');
state.dragItemId='a';renderQueue([]);assert.equal(list.nodes[0],node);state.dragItemId='';
renderQueue([{...items[0],display_title:'Renamed'}]);assert.notEqual(list.nodes[0],node);
const renamed=list.nodes[0];renderQueue([{...items[0],display_title:'Renamed',item_incarnation_id:'i-new'}]);
assert.notEqual(list.nodes[0],renamed);
const previous=list.nodes[0];state.language='en';renderQueue(items);assert.notEqual(list.nodes[0],previous);
renderQueue([]);const empty=list.nodes[0];renderQueue([]);assert.equal(list.nodes[0],empty);
console.log(JSON.stringify({ok:true}));
`);
assert.deepEqual((await this.run_node(script)), {["ok"]: true});
},
async test_queue_drag_feedback_has_one_handle_and_pauses_expiry_during_drag() {
let end, helpers, script, start;
start = sourceIndex(this.queue_source, "const dragHandleRestoreDelayMs");
end = sourceIndex(this.queue_source, "renderQueue =", start);
helpers = this.queue_source.slice(start, end);
start = sourceIndex(this.queue_source, "function beginDrag");
end = sourceIndex(this.queue_source, "async function finishDrag", start);
script = concatenate(concatenate(concatenate(`
const assert = require('node:assert/strict');
const state = {listView:'queue',dragItemId:''};
let nextTimer=0, dragStartX=0, dragStartY=0, suppressDragClick=false;
const timers=new Map(), closed=[];
const window={setTimeout(callback,delay){assert.equal(delay,5000);timers.set(++nextTimer,callback);return nextTimer;},clearTimeout(id){timers.delete(id);}};
function handle(id){
  const classes=new Set(), wrap={id};
  return {id,expanded:'false',classes,
    classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},
    closest(selector){return selector==='.queue-item'?{dataset:{id}}:wrap;},
    getAttribute(){return this.expanded;},setPointerCapture(){}};
}
let handles=[handle('a'),handle('b')];
const elements={queueList:{querySelectorAll(){return handles;},querySelector(){return handles.find(button=>button.classes.has('is-drag-ready'));}}};
function hideRemoteContextualInfo(wrap){closed.push(wrap.id);}
function active(){return handles.filter(button=>button.classes.has('is-drag-ready')).map(button=>button.id);}
function expire(){assert.equal(timers.size,1);[...timers.values()][0]();assert.equal(timers.size,0);}
`, helpers), this.queue_source.slice(start, end)), `
activateQueueDragHandle('a');assert.deepEqual(active(),['a']);assert.equal(timers.size,1);
activateQueueDragHandle('b');assert.deepEqual(active(),['b']);assert.equal(timers.size,1);
handles[1].expanded='true';expire();assert.deepEqual(active(),[]);assert.deepEqual(closed,['b']);
activateQueueDragHandle('a');
handles=[handle('a'),handle('b')];syncQueueDragHandles();
assert.deepEqual(active(),['a'],'a rerender preserves the chosen handle');
beginDrag(handles[0],{pointerType:'touch',button:0,pointerId:7,clientX:20,clientY:30,preventDefault(){}});
assert.equal(state.dragItemId,'a');assert.equal(timers.size,0);
scheduleDragHandleRestore();assert.equal(timers.size,0,'holding a drag must not start the expiry timer');
state.dragItemId='';scheduleDragHandleRestore();expire();
assert.deepEqual(active(),[]);assert.deepEqual(closed,['b'],'an expired handle must not close unrelated help');
console.log(JSON.stringify({ok:true}));
`);
assert.deepEqual((await this.run_node(script)), {["ok"]: true});
},
async test_remote_queue_retry_stale_releases_only_its_button() {
let completed, end, helpers_end, helpers_start, queue_action, result, script, start;
start = sourceIndex(this.queue_source, "async function handleQueueAction");
end = sourceIndex(this.queue_source, "function beginDrag", start);
helpers_start = sourceIndex(this.queue_source, "const pendingQueueActions");
helpers_end = sourceIndex(this.queue_source, "const dragScrollThresholdPx", helpers_start);
queue_action = concatenate(this.queue_source.slice(helpers_start, helpers_end), this.queue_source.slice(start, end));
script = (`
class FakeButton {
  constructor() { this.disabled = false; this.attributes = {}; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
}
const state = { data: { state_revision: 1 } };
const window = { confirm: () => true };
const messages = [];
let commandApplied = false;
let requests = 0;
let busyObservations = 0;
let renders = 0;
function t(key) { return key; }
function setFormMessage(message, isError = false) { messages.push({ message, isError }); }
function render() { renders += 1; }
async function apiPost() { throw new Error("generic post must not handle exact retry"); }
async function apiPostExactStateCommand(path, payload) {
  requests += 1;
  if (
    path !== "/api/cache/retry"
    || payload.item_id !== "song-a"
    || payload.expected_item_incarnation_id !== "i-a"
  ) throw new Error("wrong exact retry payload");
  if (activeButton.disabled && activeButton.getAttribute("aria-busy") === "true") {
    busyObservations += 1;
  }
  return { snapshotAccepted: true, commandApplied };
}
` + String(queue_action) + `
let activeButton = new FakeButton();
(async () => {
  await handleQueueAction("retry-cache", "song-a", "i-a", activeButton);
  const stale = {
    messages: messages.splice(0),
    disabled: activeButton.disabled,
    busy: activeButton.getAttribute("aria-busy"),
  };
  commandApplied = true;
  activeButton = new FakeButton();
  await handleQueueAction("retry-cache", "song-a", "i-a", activeButton);
  const valid = {
    messages: messages.splice(0),
    disabled: activeButton.disabled,
    busy: activeButton.getAttribute("aria-busy"),
  };
  process.stdout.write(JSON.stringify({
    stale, valid, requests, busyObservations, renders,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result, {["stale"]: {["messages"]: [], ["disabled"]: false, ["busy"]: null}, ["valid"]: {["messages"]: [{["message"]: "cache.retryStarted", ["isError"]: false}], ["disabled"]: false, ["busy"]: null}, ["requests"]: 2, ["busyObservations"]: 2, ["renders"]: 2});
}
};
test("RemoteSseFrontendTest.test_host_restart_accepts_new_epoch_and_rejects_retired_responses", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_host_restart_accepts_new_epoch_and_rejects_retired_responses(); });
test("RemoteSseFrontendTest.test_audio_variant_request_uses_only_the_observed_item_incarnation", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_audio_variant_request_uses_only_the_observed_item_incarnation(); });
test("RemoteSseFrontendTest.test_expired_native_lan_session_reenters_once_without_redirecting_public_remote", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_expired_native_lan_session_reenters_once_without_redirecting_public_remote(); });
test("RemoteSseFrontendTest.test_current_cache_retry_forwards_the_observed_item_incarnation", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_current_cache_retry_forwards_the_observed_item_incarnation(); });
test("RemoteSseFrontendTest.test_reconnect_jitter_is_bounded_and_never_subsecond", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_reconnect_jitter_is_bounded_and_never_subsecond(); });
test("RemoteSseFrontendTest.test_scheduler_jitters_each_attempt_but_doubles_only_base_delay", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_scheduler_jitters_each_attempt_but_doubles_only_base_delay(); });
test("RemoteSseFrontendTest.test_cache_polling_uses_the_revision_guard", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_cache_polling_uses_the_revision_guard(); });
test("RemoteSseFrontendTest.test_healthy_sse_is_the_only_continuous_cache_state_feed", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_healthy_sse_is_the_only_continuous_cache_state_feed(); });
test("RemoteSseFrontendTest.test_native_heartbeat_detects_silent_loss_without_polling_healthy_stream", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_native_heartbeat_detects_silent_loss_without_polling_healthy_stream(); });
test("RemoteSseFrontendTest.test_event_source_unsupported_uses_one_bounded_fallback_timer", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_event_source_unsupported_uses_one_bounded_fallback_timer(); });
test("RemoteSseFrontendTest.test_event_source_without_valid_state_uses_then_cancels_fallback", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_event_source_without_valid_state_uses_then_cancels_fallback(); });
test("RemoteSseFrontendTest.test_remote_connection_phase_tracks_sse_and_bounded_fallback_recovery", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_remote_connection_phase_tracks_sse_and_bounded_fallback_recovery(); });
test("RemoteSseFrontendTest.test_transient_sse_reconnect_has_no_parallel_full_state_get", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_transient_sse_reconnect_has_no_parallel_full_state_get(); });
test("RemoteSseFrontendTest.test_startup_retains_initial_get_before_connecting_sse", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_startup_retains_initial_get_before_connecting_sse(); });
test("RemoteSseFrontendTest.test_player_status_and_clock_fail_closed_by_playback_generation", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_player_status_and_clock_fail_closed_by_playback_generation(); });
test("RemoteSseFrontendTest.test_healthy_sse_settles_player_control_without_refresh_burst", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_healthy_sse_settles_player_control_without_refresh_burst(); });
test("RemoteSseFrontendTest.test_player_control_without_usable_sse_has_no_refresh_burst_or_retry", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_player_control_without_usable_sse_has_no_refresh_burst_or_retry(); });
test("RemoteSseFrontendTest.test_failed_player_commands_use_incarnation_scoped_deduplicated_toasts", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_failed_player_commands_use_incarnation_scoped_deduplicated_toasts(); });
test("RemoteSseFrontendTest.test_remote_program_relative_controls_capture_the_observed_rust_generation", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_remote_program_relative_controls_capture_the_observed_rust_generation(); });
test("RemoteSseFrontendTest.test_stale_exact_commands_update_state_without_success_ui_or_refetch", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_stale_exact_commands_update_state_without_success_ui_or_refetch(); });
test("RemoteSseFrontendTest.test_remote_variant_and_retry_stale_ui_settles_once", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_remote_variant_and_retry_stale_ui_settles_once(); });
test("RemoteSseFrontendTest.test_enhanced_queue_preserves_nodes_on_unrelated_updates", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_enhanced_queue_preserves_nodes_on_unrelated_updates(); });
test("RemoteSseFrontendTest.test_queue_drag_feedback_has_one_handle_and_pauses_expiry_during_drag", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_queue_drag_feedback_has_one_handle_and_pauses_expiry_during_drag(); });
test("RemoteSseFrontendTest.test_remote_queue_retry_stale_releases_only_its_button", async () => { const instance = Object.create(RemoteSseFrontendTest); await instance.setUpClass(); await instance.test_remote_queue_retry_stale_releases_only_its_button(); });
