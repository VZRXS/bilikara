import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const PresentationHostFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.path = path.join(path.join(ROOT, "static"), "app.js");
this.source = readFileSync(this.path, "utf8");
this.index = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
},
async source_slice(start, end) {
let start_index;
start_index = sourceIndex(this.source, start);
return this.source.slice(start_index, sourceIndex(this.source, end, start_index));
},
async run_node(script) {
let completed;
completed = (await runNative(this.node, ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_dual_screen_host_transport_matches_remote_control_order() {
let controls, handler, identifier, ordered_ids, positions;
controls = this.index.slice(sourceIndex(this.index, "id=\"presentation-host-controls\""), sourceIndex(this.index, "id=\"stage-controls-toggle\""));
ordered_ids = ["id=\"presentation-host-back\"", "id=\"presentation-host-play\"", "id=\"presentation-host-forward\"", "id=\"presentation-host-progress\"", "id=\"presentation-host-next\""];
positions = Array.from(Array.from(iterableValues(ordered_ids))).map((identifier) => sourceIndex(controls, identifier));
assert.deepEqual(positions, Array.from(positions).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0));
assert.ok(contains("data-presentation-host-action=\"seek-relative\" data-delta=\"-15\"", controls));
assert.ok(contains("data-presentation-host-action=\"seek-relative\" data-delta=\"15\"", controls));
assert.ok(contains("type=\"range\" id=\"presentation-host-progress\"", controls));
handler = (await this.source_slice("async function handlePresentationHostControl", "function queuePlayerFrameSingleClick"));
assert.ok(contains("action === \"seek\" || action === \"seek-relative\"", handler));
assert.ok(contains("Number(button.dataset.delta || 0)", handler));
assert.ok(contains("beginSplitPlayerSeek(video, audio", handler));
assert.ok(contains("setMediaCurrentTime(video, targetTime)", handler));
assert.ok(contains(".presentation-host-primary-controls", this.styles));
assert.ok(contains("grid-template-columns: 44px 48px 44px", this.styles));
},
async test_composition_preserves_media_and_turns_host_player_into_control_surface() {
let entry, exit_state, functions, result, script;
functions = (await this.source_slice("function presentationCompositionActive", "function applyPresentationSession"));
script = (`
class ClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  toggle(name, force) {
    if (force) this.values.add(name); else this.values.delete(name);
    return this.values.has(name);
  }
  contains(name) { return this.values.has(name); }
}
const trace = [];
const video = { tagName: "VIDEO", currentTime: 42 };
const audio = { tagName: "AUDIO", currentTime: 42 };
const frame = { children: [video, audio], inert: false };
const elements = { playerFrame: frame };
const state = {
  presentationSession: {
    mode: "localDualScreen", phase: "activating", generation: 4,
    hostReady: false, controllerReady: true,
  },
  presentationAppliedComposition: "combined",
  presentationCompositionGeneration: 0,
  presentationHostReadyKey: "",
  presentationCursorHideTimer: null,
};
global.window = global;
window.setTimeout = () => 10;
window.clearTimeout = () => {};
window.requestAnimationFrame = (callback) => { trace.push("frame"); callback(); };
global.document = { body: { classList: new ClassList() } };
function hideMountedPlayerControls() { trace.push("hide-controls"); }
function renderCurrentPresentationScene() { trace.push("render-scene"); }
function renderPlayerFullscreenButton() { trace.push("render-fullscreen"); }
function setAppMessage(message) { trace.push(\`error:\${message}\`); }
function t(key) { return key; }
function tauriInvoke() {
  return async (name, payload) => {
    trace.push(\`invoke:\${name}:\${payload.composition}\`);
    return { ...state.presentationSession, hostReady: true };
  };
}
async function handlePresentationSession(session) {
  trace.push("handle-session");
  state.presentationSession = session;
}
` + String(functions) + `
(async () => {
  const before = [frame.children[0], frame.children[1]];
  const entered = await applyPresentationComposition({ generation: 4, composition: "stageOnly" });
  const entry = {
    entered,
    activeClass: document.body.classList.contains("is-presentation-control-host"),
    inert: frame.inert,
    sameVideo: frame.children[0] === before[0],
    sameAudio: frame.children[1] === before[1],
    currentTime: frame.children[0].currentTime,
    trace: [...trace],
  };
  state.presentationSession = {
    mode: "localDualScreen", phase: "recovering", generation: 5,
    hostReady: false, controllerReady: false,
  };
  state.presentationHostReadyKey = "";
  trace.length = 0;
  const exited = await applyPresentationComposition({ generation: 5, composition: "combined" });
  const stale = await applyPresentationComposition({ generation: 4, composition: "stageOnly" });
  process.stdout.write(JSON.stringify({
    entry,
    exit: {
      exited,
      stale,
      activeClass: document.body.classList.contains("is-presentation-control-host"),
      inert: frame.inert,
      sameVideo: frame.children[0] === before[0],
      sameAudio: frame.children[1] === before[1],
      trace,
    },
  }));
})();
`);
result = (await this.run_node(script));
entry = result["entry"];
assert.ok(hasContent(entry["entered"]));
assert.ok(hasContent(entry["activeClass"]));
assert.ok(hasContent(entry["inert"]));
assert.ok(hasContent(entry["sameVideo"]));
assert.ok(hasContent(entry["sameAudio"]));
assert.deepEqual(entry["currentTime"], 42);
assert.ok(sourceIndex(entry["trace"], "render-scene") < sourceIndex(entry["trace"], "frame"));
assert.ok(sourceIndex(entry["trace"], "frame") < sourceIndex(entry["trace"], "invoke:mark_presentation_host_ready:stageOnly"));
exit_state = result["exit"];
assert.ok(hasContent(exit_state["exited"]));
assert.ok(!hasContent(exit_state["stale"]));
assert.ok(!hasContent(exit_state["activeClass"]));
assert.ok(!hasContent(exit_state["inert"]));
assert.ok(hasContent(exit_state["sameVideo"]));
assert.ok(hasContent(exit_state["sameAudio"]));
assert.ok(contains("invoke:mark_presentation_host_ready:combined", exit_state["trace"]));
},
async test_typed_commands_map_to_existing_host_authority_in_fifo_order() {
let functions, result, script;
functions = (await this.source_slice("function normalizeControllerCommandEnvelope", "function presentationPlaybackStateModel"));
script = (`
const actions = [];
const acknowledgements = [];
const messages = [];
let publishShouldFail = false;
const state = {
  data: { playback_generation: 41 },
  presentationSession: {
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 6,
  },
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
};
const video = { currentTime: 20, duration: 200, dataset: { playerItemId: "song" } };
const audio = { currentTime: 20, duration: 200 };
state.hostPlaybackSession = { readyCommitted: true, playbackGeneration: 41 };
function isCurrentHostPlaybackSession(session) {
  return session === state.hostPlaybackSession
    && session.playbackGeneration === state.data.playback_generation;
}
function activeLocalPlayerElements() { return { video, audio }; }
function setSplitPlaybackIntent(_video, _audio, playing, options) {
  actions.push(["playback", playing, options.source]);
  return true;
}
function isActiveSplitPlayer() { return true; }
function beginSplitPlayerSeek(_video, _audio, options) {
  actions.push(["seek", options.targetTime, options.diagnosticAction]);
  options.onSettled(true);
  return true;
}
function reportPlayerStatus() { actions.push(["status"]); }
async function requestNextTrack(expectedPlaybackGeneration) {
  actions.push(["next", expectedPlaybackGeneration]);
  return true;
}
async function setLocalPlayerVolumeAndMuted(volume, muted, options) {
  actions.push(["volume", volume, muted, options.reportError]);
}
function setMediaCurrentTime(media, value) { media.currentTime = value; }
function clampMediaTime(_media, value) { return value; }
function tauriInvoke() {
  return async (name, payload) => {
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    acknowledgements.push(payload.sequence);
    return {
      ...state.presentationSession,
      hostReady: true, controllerReady: true,
      lastAppliedCommandSequence: payload.sequence,
      mediaRendererOwner: "host",
    };
  };
}
async function handlePresentationSession() {}
function setAppMessage(message) { messages.push(String(message)); }
async function publishPresentationPlaybackState() {
  actions.push(["publish"]);
  if (publishShouldFail) throw new Error("snapshot failed");
}
` + String(functions) + `
const envelope = (sequence, command) => ({
  generation: 7, sequence, target: "host", command,
});
(async () => {
  const results = [];
  results.push(await applyControllerCommand(envelope(1, { type: "play" })));
  results.push(await applyControllerCommand(envelope(2, { type: "pause" })));
  results.push(await applyControllerCommand(envelope(3, {
    type: "seekRelative", deltaSeconds: -10, expectedPlaybackGeneration: 41,
  })));
  results.push(await applyControllerCommand(envelope(4, {
    type: "seekAbsolute", targetSeconds: 75, expectedPlaybackGeneration: 41,
  })));
  results.push(await applyControllerCommand(envelope(5, {
    type: "nextTrack", expectedPlaybackGeneration: 41,
  })));
  publishShouldFail = true;
  results.push(await applyControllerCommand(envelope(6, {
    type: "setVolume", volumePercent: 35, muted: true,
  })));
  const stale = await applyControllerCommand(envelope(6, { type: "pause" }));
  const wrongGeneration = await applyControllerCommand({
    generation: 8, sequence: 7, target: "host", command: { type: "pause" },
  });
  await Promise.resolve();
  process.stdout.write(JSON.stringify({
    results, stale, wrongGeneration, actions, acknowledgements, messages,
    applied: state.presentationLastAppliedCommandSequence,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["results"], Array.from({length: 6}, () => [true]).flat());
assert.ok(!hasContent(result["stale"]));
assert.ok(!hasContent(result["wrongGeneration"]));
assert.deepEqual(result["acknowledgements"], [1, 2, 3, 4, 5, 6]);
assert.deepEqual(result["applied"], 6);
assert.ok(contains(["playback", true, "presentation-controller-play"], result["actions"]));
assert.ok(contains(["playback", false, "presentation-controller-pause"], result["actions"]));
assert.ok(contains(["seek", 10, "presentation-controller-seek"], result["actions"]));
assert.ok(contains(["seek", 75, "presentation-controller-seek"], result["actions"]));
assert.ok(contains(["next", 41], result["actions"]));
assert.ok(contains(["volume", 0.35, true, false], result["actions"]));
assert.deepEqual(result["messages"], ["snapshot failed"]);
},
async test_program_relative_controller_commands_consume_stale_targets_and_release_fifo() {
let functions, result, script;
functions = (await this.source_slice("function normalizeControllerCommandEnvelope", "function presentationPlaybackStateModel"));
script = (`
const acknowledgements = [];
const effects = [];
let supersedeNext = false;
const state = {
  data: { playback_generation: 22 },
  presentationSession: {
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 9,
  },
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
  hostPlaybackSession: { readyCommitted: true, playbackGeneration: 22 },
};
const video = { currentTime: 20, duration: 200, dataset: { playerItemId: "same-song" } };
const audio = { currentTime: 20, duration: 200 };
function activeLocalPlayerElements() { return { video, audio }; }
function isCurrentHostPlaybackSession(session) {
  return session === state.hostPlaybackSession
    && session.playbackGeneration === state.data.playback_generation;
}
function isActiveSplitPlayer() { return true; }
function setSplitPlaybackIntent(_video, _audio, playing, options) {
  effects.push(["intent", playing, options.source]);
  return true;
}
function beginSplitPlayerSeek(_video, _audio, options) {
  effects.push(["seek", options.targetTime]);
  options.onSettled(true);
  return true;
}
function reportPlayerStatus() { effects.push(["status"]); }
async function requestNextTrack(expectedPlaybackGeneration) {
  effects.push(["next", expectedPlaybackGeneration]);
  if (supersedeNext) {
    supersedeNext = false;
    state.data = { playback_generation: expectedPlaybackGeneration + 1 };
    state.hostPlaybackSession.playbackGeneration = expectedPlaybackGeneration + 1;
    return false;
  }
  return true;
}
async function setLocalPlayerVolumeAndMuted(volume, muted) {
  effects.push(["volume", volume, muted]);
}
function tauriInvoke() {
  return async (name, payload) => {
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    acknowledgements.push(payload.sequence);
    return {
      ...state.presentationSession,
      lastAppliedCommandSequence: payload.sequence,
    };
  };
}
async function handlePresentationSession() {}
async function publishPresentationPlaybackState() { effects.push(["publish"]); }
function setAppMessage() {}
` + String(functions) + `
const envelope = (sequence, command) => ({
  generation: 7, sequence, target: "host", command,
});
(async () => {
  const results = [];
  results.push(await applyControllerCommand(envelope(1, {
    type: "seekRelative", deltaSeconds: 15, expectedPlaybackGeneration: 21,
  })));
  results.push(await applyControllerCommand(envelope(2, {
    type: "nextTrack", expectedPlaybackGeneration: 21,
  })));
  results.push(await applyControllerCommand(envelope(3, { type: "play" })));
  results.push(await applyControllerCommand(envelope(4, { type: "pause" })));
  results.push(await applyControllerCommand(envelope(5, {
    type: "setVolume", volumePercent: 35, muted: true,
  })));
  results.push(await applyControllerCommand(envelope(6, {
    type: "seekAbsolute", targetSeconds: 75, expectedPlaybackGeneration: 22,
  })));
  results.push(await applyControllerCommand(envelope(7, {
    type: "nextTrack", expectedPlaybackGeneration: 22,
  })));
  state.data = { playback_generation: 23 };
  state.hostPlaybackSession.playbackGeneration = 23;
  supersedeNext = true;
  results.push(await applyControllerCommand(envelope(8, {
    type: "nextTrack", expectedPlaybackGeneration: 23,
  })));
  results.push(await applyControllerCommand(envelope(9, { type: "pause" })));
  await Promise.resolve();
  process.stdout.write(JSON.stringify({
    results,
    acknowledgements,
    effects,
    applied: state.presentationLastAppliedCommandSequence,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["results"], [false, false, true, true, true, true, true, false, true]);
assert.deepEqual(result["acknowledgements"], Array.from(Array.from({length: 10 - 1}, (_, i) => i + 1)));
assert.deepEqual(result["applied"], 9);
assert.ok(!contains(["seek", 35], result["effects"]));
assert.ok(!contains(["next", 21], result["effects"]));
assert.ok(contains(["intent", true, "presentation-controller-play"], result["effects"]));
assert.ok(contains(["intent", false, "presentation-controller-pause"], result["effects"]));
assert.ok(contains(["volume", 0.35, true], result["effects"]));
assert.ok(contains(["seek", 75], result["effects"]));
assert.ok(contains(["next", 22], result["effects"]));
assert.deepEqual(countOccurrences(result["effects"], ["next", 23]), 1);
},
async test_uncommitted_seek_is_cancelled_promptly_and_releases_controller_fifo() {
let functions, result, script;
functions = (await this.source_slice("function normalizeControllerCommandEnvelope", "function presentationPlaybackStateModel"));
script = (`
const acknowledgements = [];
const effects = [];
let seekBegins = 0;
let playbackPublishes = 0;
const state = {
  data: { playback_generation: 41 },
  presentationSession: {
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 2,
  },
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
  hostPlaybackSession: {
    phase: "binding", readyCommitted: false, logicalPlayIntent: true,
    playbackGeneration: 41,
  },
};
const video = { currentTime: 20, duration: 200, dataset: { playerItemId: "song" } };
const audio = { currentTime: 20, duration: 200 };
function activeLocalPlayerElements() { return { video, audio }; }
function isCurrentHostPlaybackSession(session) {
  return session === state.hostPlaybackSession
    && session.playbackGeneration === state.data.playback_generation;
}
function isActiveSplitPlayer() { return true; }
function beginSplitPlayerSeek() { seekBegins += 1; return true; }
function setSplitPlaybackIntent(_video, _audio, playing, options) {
  effects.push(["intent", playing, options.source]);
  state.hostPlaybackSession.logicalPlayIntent = playing;
  return true;
}
function reportPlayerStatus() { effects.push(["status"]); }
async function requestNextTrack() { throw new Error("not used"); }
async function setLocalPlayerVolumeAndMuted() { throw new Error("not used"); }
function tauriInvoke() {
  return async (name, payload) => {
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    acknowledgements.push(payload.sequence);
    return {
      ...state.presentationSession,
      lastAppliedCommandSequence: payload.sequence,
    };
  };
}
async function handlePresentationSession(session) { state.presentationSession = session; }
async function publishPresentationPlaybackState() { playbackPublishes += 1; }
function setAppMessage() {}
` + String(functions) + `
const envelope = (sequence, command) => ({
  generation: 7, sequence, target: "host", command,
});
(async () => {
  const seek = await applyControllerCommand(envelope(1, {
    type: "seekAbsolute", targetSeconds: 75, expectedPlaybackGeneration: 41,
  }));
  const pause = await applyControllerCommand(envelope(2, { type: "pause" }));
  await Promise.resolve();
  process.stdout.write(JSON.stringify({
    seek,
    pause,
    acknowledgements,
    applied: state.presentationLastAppliedCommandSequence,
    seekBegins,
    effects,
    logicalPlayIntent: state.hostPlaybackSession.logicalPlayIntent,
    playbackPublishes,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result, {["seek"]: false, ["pause"]: true, ["acknowledgements"]: [1, 2], ["applied"]: 2, ["seekBegins"]: 0, ["effects"]: [["intent", false, "presentation-controller-pause"]], ["logicalPlayIntent"]: false, ["playbackPublishes"]: 1});
},
async test_retired_seek_is_consumed_once_and_releases_native_like_fifo() {
let functions, result, script;
functions = (await this.source_slice("function normalizeControllerCommandEnvelope", "function presentationPlaybackStateModel"));
script = (`
const acknowledgements = [];
const emitted = [1];
const results = [];
const errors = [];
let pendingSeek = null;
let statusReports = 0;
let playbackPublishes = 0;
let deactivations = 0;
let pauseEffects = 0;
const programA = { item_id: "song-a" };
const programB = { item_id: "song-b" };
const state = {
  presentationSession: {
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 2,
  },
  presentationLastAppliedCommandSequence: 0,
  presentationCommandApplyPromise: Promise.resolve(),
  localShouldBePlaying: true,
  data: { playback_generation: 10, playback_program: programA },
};
const videoA = { currentTime: 20, duration: 200, dataset: { playerItemId: "song-a" } };
const audioA = { currentTime: 20, duration: 200 };
const videoB = { currentTime: 0, duration: 200, dataset: { playerItemId: "song-b" } };
const audioB = { currentTime: 0, duration: 200 };
const sessionA = {
  phase: "playing", playbackGeneration: 10, playbackProgram: programA,
  readyCommitted: true, video: videoA, audio: audioA,
};
const sessionB = {
  phase: "playing", playbackGeneration: 11, playbackProgram: programB,
  readyCommitted: true, video: videoB, audio: audioB,
};
state.hostPlaybackSession = sessionA;
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && (video === undefined || session.video === video)
    && (audio === undefined || session.audio === audio);
}
function activeLocalPlayerElements() {
  return {
    video: state.hostPlaybackSession?.video || null,
    audio: state.hostPlaybackSession?.audio || null,
  };
}
function isActiveSplitPlayer(video, audio) {
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}
function beginSplitPlayerSeek(_video, _audio, options) {
  pendingSeek = options.onSettled;
  return true;
}
function reportPlayerStatus() { statusReports += 1; }
function setSplitPlaybackIntent(video, audio, playing) {
  if (video === videoB && audio === audioB && !playing) pauseEffects += 1;
  return true;
}
const nativeQueue = [
  { generation: 7, sequence: 1, target: "host", command: {
    type: "seekAbsolute", targetSeconds: 75, expectedPlaybackGeneration: 10,
  } },
  { generation: 7, sequence: 2, target: "host", command: { type: "pause" } },
];
let nativeInFlight = 1;
function dispatchHostCommand(command) {
  const commandGeneration = command.generation;
  const pending = state.presentationCommandApplyPromise
    .catch(() => {})
    .then(() => applyControllerCommand(command));
  state.presentationCommandApplyPromise = pending;
  pending.then(
    (applied) => results.push([command.sequence, applied]),
    async (error) => {
      errors.push([command.sequence, error.name, error.message]);
      if (
        Number.isSafeInteger(commandGeneration)
        && state.presentationSession.phase === "active"
        && state.presentationSession.generation === commandGeneration
      ) {
        await tauriInvoke()("deactivate_local_presentation", { generation: commandGeneration });
      }
    },
  );
  return pending;
}
function tauriInvoke() {
  return async (name, payload) => {
    if (name === "deactivate_local_presentation") {
      deactivations += 1;
      nativeQueue.length = 0;
      nativeInFlight = null;
      state.presentationSession.phase = "inactive";
      return state.presentationSession;
    }
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    if (nativeQueue[0]?.sequence !== payload.sequence || nativeInFlight !== payload.sequence) {
      throw new Error("native acknowledgement is out of order");
    }
    acknowledgements.push([name, payload.sequence]);
    nativeQueue.shift();
    nativeInFlight = nativeQueue[0]?.sequence || null;
    const session = { ...state.presentationSession, lastAppliedCommandSequence: payload.sequence };
    if (nativeQueue[0]) {
      const next = nativeQueue[0];
      Promise.resolve().then(() => {
        emitted.push(next.sequence);
        dispatchHostCommand(next);
      });
    }
    return session;
  };
}
async function handlePresentationSession(session) { state.presentationSession = session; }
async function publishPresentationPlaybackState() { playbackPublishes += 1; }
function setAppMessage() {}
` + String(functions) + `
(async () => {
  const first = dispatchHostCommand(nativeQueue[0]);
  await Promise.resolve();
  await Promise.resolve();
  sessionA.phase = "retired";
  state.data = { playback_generation: 11, playback_program: programB };
  state.hostPlaybackSession = sessionB;
  pendingSeek(false);
  pendingSeek(false);
  await first.catch(() => {});
  await Promise.resolve();
  await state.presentationCommandApplyPromise.catch(() => {});
  await Promise.resolve();
  process.stdout.write(JSON.stringify({
    results,
    errors,
    emitted,
    acknowledgements,
    statusReports,
    playbackPublishes,
    deactivations,
    pauseEffects,
    nativeQueue: nativeQueue.map((command) => command.sequence),
    nativeInFlight,
    applied: state.presentationLastAppliedCommandSequence,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result, {["results"]: [[1, false], [2, true]], ["errors"]: [], ["emitted"]: [1, 2], ["acknowledgements"]: [["acknowledge_presentation_command", 1], ["acknowledge_presentation_command", 2]], ["statusReports"]: 0, ["playbackPublishes"]: 1, ["deactivations"]: 0, ["pauseEffects"]: 1, ["nativeQueue"]: [], ["nativeInFlight"]: null, ["applied"]: 2});
},
async test_failed_next_track_is_not_acknowledged() {
let functions, result, script;
functions = (await this.source_slice("function normalizeControllerCommandEnvelope", "function presentationPlaybackStateModel"));
script = (`
const acknowledgements = [];
const state = {
  data: { playback_generation: 41 },
  presentationSession: {
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 1,
  },
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
  hostPlaybackSession: { playbackGeneration: 41 },
};
const video = { currentTime: 20, duration: 200, dataset: { playerItemId: "song" } };
const audio = { currentTime: 20, duration: 200 };
function activeLocalPlayerElements() { return { video, audio }; }
function isCurrentHostPlaybackSession(session) {
  return session === state.hostPlaybackSession
    && session.playbackGeneration === state.data.playback_generation;
}
async function requestNextTrack() { return false; }
function tauriInvoke() {
  return async (name, payload) => { acknowledgements.push([name, payload]); };
}
async function handlePresentationSession() {}
async function publishPresentationPlaybackState() {}
function setAppMessage() {}
` + String(functions) + `
(async () => {
  let error = "";
  try {
    await applyControllerCommand({
      generation: 7, sequence: 1, target: "host", command: {
        type: "nextTrack", expectedPlaybackGeneration: 41,
      },
    });
  } catch (caught) {
    error = caught.message;
  }
  process.stdout.write(JSON.stringify({ error, acknowledgements }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["error"], "The Host could not advance to the next track");
assert.deepEqual(result["acknowledgements"], []);
},
async test_output_state_relays_through_shell_with_one_request_in_flight() {
let functions, listeners, publish, result, script;
functions = (await this.source_slice("function relayPresentationOutputState", "function publishPresentationOutputState"));
script = (`
const calls = [];
const settle = [];
const state = {
  presentationSession: { generation: 4 },
  presentationOutputRelayPending: null,
  presentationOutputRelayInFlight: false,
};
function tauriInvoke(capability) {
  if (capability !== "presentation") throw new Error(capability);
  return (name, payload) => {
    calls.push([name, payload.generation, payload.envelope.sequence]);
    return new Promise((resolve, reject) => settle.push({ resolve, reject }));
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
` + String(functions) + `
(async () => {
  relayPresentationOutputState({ sequence: 1 });
  relayPresentationOutputState({ sequence: 2 });
  relayPresentationOutputState({ sequence: 3 });
  const inFlight = calls.length;
  // A rejected relay still releases the next, newest envelope.
  settle.shift().reject(new Error("stale"));
  await tick();
  const afterFirst = calls.slice();
  relayPresentationOutputState({ sequence: 4 });
  state.presentationSession.generation = 5;
  settle.shift().resolve();
  await tick();
  process.stdout.write(JSON.stringify({
    inFlight, afterFirst, calls,
    pending: state.presentationOutputRelayPending,
    busy: state.presentationOutputRelayInFlight,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["inFlight"], 1);
assert.deepEqual(result["afterFirst"], [["publish_presentation_output_state", 4, 1], ["publish_presentation_output_state", 4, 3]]);
assert.deepEqual(result["calls"], result["afterFirst"]);
assert.equal(result["pending"], null);
assert.ok(!hasContent(result["busy"]));
publish = (await this.source_slice("function publishPresentationOutputState", "const presentationModes"));
assert.ok(sourceIndex(publish, "window.BilikaraAndroidPresentation.postMaster(envelope)") < sourceIndex(publish, "relayPresentationOutputState(envelope)"));
listeners = (await this.source_slice("async function initializeLocalPresentation", "function syncPlayerFullscreenExpandedWidth"));
assert.ok(contains("listen(\"bilikara-presentation-output-request\"", listeners));
assert.ok(contains("state.presentationSession.generation", listeners));
assert.ok(contains("unlistenOutputRequest", listeners));
},
async test_playback_snapshot_is_bounded_deduplicated_and_contains_no_media_transport() {
let first, functions, result, script, snapshot;
functions = (await this.source_slice("function hostPlaybackSessionObservedPlaying", "function tauriEventListen"));
script = (`
const calls = [];
const program = { item_id: "song-1" };
const video = { currentTime: 12.4, duration: 123.5, paused: false, volume: 1, muted: false };
const audio = { paused: false, volume: 0.42, muted: true };
const session = {
  playbackGeneration: 3, playbackProgram: program, phase: "playing",
  readyCommitted: true, video, audio,
};
const state = {
  data: {
    playback_generation: 3,
    playback_program: program,
    current_item: {
      id: "song-1", display_title: "Song", video_url: "forbidden", audio_url: "forbidden",
    },
  },
  hostPlaybackSession: session,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  presentationSession: { phase: "active", generation: 9 },
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: null,
};
function activeLocalPlayerElements() { return { video, audio }; }
function activePrimaryVideoElement() { return video; }
function isActiveSplitPlayer(candidateVideo, candidateAudio) {
  return candidateVideo === video && candidateAudio === audio;
}
function isCurrentHostPlaybackSession(candidate, candidateVideo, candidateAudio) {
  return candidate === session
    && candidateVideo === video
    && candidateAudio === audio;
}
function t(key) { return key; }
function tauriInvoke() {
  return async (name, payload) => { calls.push([name, payload]); return payload; };
}
` + String(functions) + `
(async () => {
  await Promise.all([publishPresentationPlaybackState(), publishPresentationPlaybackState()]);
  video.currentTime = 13.6;
  await publishPresentationPlaybackState();
  audio.volume = 1;
  audio.bilikaraVolume = 5;
  await publishPresentationPlaybackState();
  process.stdout.write(JSON.stringify({ calls }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["calls"].length, 3);
first = result["calls"][0];
assert.deepEqual(first[0], "publish_presentation_playback_state");
assert.deepEqual(first[1]["generation"], 9);
snapshot = first[1]["playbackState"];
assert.deepEqual(new Set((Symbol.iterator in Object(snapshot) ? snapshot : Object.keys(snapshot))), new Set(["revision", "playbackGeneration", "itemIdentity", "title", "paused", "currentTimeSeconds", "durationSeconds", "volumePercent", "muted", "canSkip"]));
assert.deepEqual(snapshot["revision"], 1);
assert.deepEqual(snapshot["playbackGeneration"], 3);
assert.ok(!hasContent(snapshot["paused"]));
assert.deepEqual(snapshot["volumePercent"], 42);
assert.ok(hasContent(snapshot["muted"]));
assert.deepEqual(result["calls"][1][1]["playbackState"]["revision"], 2);
assert.deepEqual(result["calls"][2][1]["playbackState"]["revision"], 3);
assert.deepEqual(result["calls"][2][1]["playbackState"]["volumePercent"], 500);
},
async test_committed_pair_observation_drives_external_playback_state() {
let legacy_view, media_session, publication, result, script;
legacy_view = (await this.source_slice("function legacyPlaybackStartStateForSession", "const elements ="));
publication = (await this.source_slice("function hostPlaybackSessionObservedPlaying", "function tauriEventListen"));
media_session = (await this.source_slice("function tauriWebKitMediaSession", "function tauriMediaSessionActionEvent"));
script = (`
const presentationCalls = [];
const mediaStates = [];
let videoPlayCalls = 0;
let audioPlayCalls = 0;
let mediaPlaybackState = "none";
const mediaSession = {
  get playbackState() { return mediaPlaybackState; },
  set playbackState(value) {
    mediaPlaybackState = value;
    mediaStates.push(value);
  },
  setActionHandler() {},
  setPositionState() {},
};
const program = { item_id: "song-1", artifact_set_id: "artifact-1" };
const video = {
  currentTime: 12, duration: 120, paused: true, playbackRate: 1,
  volume: 1, muted: false,
  play() { videoPlayCalls += 1; },
};
const audio = {
  paused: true, volume: 0.5, muted: false,
  play() { audioPlayCalls += 1; },
};
const session = {
  playbackGeneration: 4,
  playbackProgram: program,
  phase: "binding",
  readyCommitted: false,
  video,
  audio,
};
const state = {
  data: {
    playback_generation: 4,
    playback_program: program,
    current_item: { id: "song-1", display_title: "Song" },
  },
  hostPlaybackSession: session,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  localAdvanceInFlight: false,
  presentationSession: { phase: "active", generation: 8 },
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: null,
  lastTauriMediaSessionPositionAt: 0,
};
global.window = global;
window.__TAURI__ = { core: {} };
Object.defineProperty(globalThis, "navigator", {
  value: { mediaSession }, configurable: true, writable: true,
});
const tauriMediaSessionPositionUpdateMs = 1000;
function activeLocalPlayerElements() {
  return { video: session.video, audio: session.audio };
}
function activePrimaryVideoElement() { return session.video; }
function isCurrentHostPlaybackSession(candidate, candidateVideo, candidateAudio) {
  return candidate === state.hostPlaybackSession
    && candidate.playbackGeneration === state.data.playback_generation
    && candidate.playbackProgram === state.data.playback_program
    && candidate.video === candidateVideo
    && candidate.audio === candidateAudio
    && candidate.phase !== "retiring"
    && candidate.phase !== "retired";
}
function isActiveSplitPlayer(candidateVideo, candidateAudio) {
  return isCurrentHostPlaybackSession(
    state.hostPlaybackSession,
    candidateVideo,
    candidateAudio,
  );
}
function isTauriWebKitRuntime() { return true; }
function t(key) { return key; }
function tauriInvoke() {
  return async (name, payload) => {
    presentationCalls.push([name, payload]);
    return payload;
  };
}
` + String(legacy_view) + `
` + String(publication) + `
` + String(media_session) + `

const descriptor = Object.getOwnPropertyDescriptor(state, "localPlaybackStartState");
state.localPlaybackStartState = "starting";
const legacy = {
  hasSetter: typeof descriptor.set === "function",
  phaseAfterWrite: session.phase,
  derivedState: state.localPlaybackStartState,
};

async function observe(label, phase, readyCommitted, videoPaused, audioPaused) {
  session.phase = phase;
  session.readyCommitted = readyCommitted;
  video.paused = videoPaused;
  audio.paused = audioPaused;
  state.localShouldBePlaying = true;
  const paused = presentationPlaybackStateModel(session).paused;
  syncTauriMediaSessionState(video, { forcePosition: true });
  await publishPresentationPlaybackState(session);
  return {
    label,
    paused,
    mediaState: mediaSession.playbackState,
    presentationCallCount: presentationCalls.length,
  };
}

(async () => {
  const observations = [];
  observations.push(await observe("ready-paused", "ready-paused", true, true, true));
  await publishPresentationPlaybackState(session);
  const duplicateReadyCallCount = presentationCalls.length;
  observations.push(await observe("starting", "starting", true, false, false));
  observations.push(await observe(
    "needs-user-gesture",
    "needs-user-gesture",
    true,
    true,
    true,
  ));
  observations.push(await observe("playing", "playing", true, false, false));
  observations.push(await observe("paused", "paused", true, true, true));
  video.currentTime = 99;
  observations.push(await observe("uncommitted", "binding", false, true, true));
  process.stdout.write(JSON.stringify({
    legacy,
    observations,
    duplicateReadyCallCount,
    publishedPaused: presentationCalls.map((call) => call[1].playbackState.paused),
    playCalls: [videoPlayCalls, audioPlayCalls],
    mediaStates,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["legacy"], {["hasSetter"]: false, ["phaseAfterWrite"]: "binding", ["derivedState"]: "pending"});
assert.deepEqual(result["observations"], [{["label"]: "ready-paused", ["paused"]: true, ["mediaState"]: "paused", ["presentationCallCount"]: 1}, {["label"]: "starting", ["paused"]: true, ["mediaState"]: "paused", ["presentationCallCount"]: 1}, {["label"]: "needs-user-gesture", ["paused"]: true, ["mediaState"]: "paused", ["presentationCallCount"]: 1}, {["label"]: "playing", ["paused"]: false, ["mediaState"]: "playing", ["presentationCallCount"]: 2}, {["label"]: "paused", ["paused"]: true, ["mediaState"]: "paused", ["presentationCallCount"]: 3}, {["label"]: "uncommitted", ["paused"]: true, ["mediaState"]: "none", ["presentationCallCount"]: 3}]);
assert.deepEqual(result["duplicateReadyCallCount"], 1);
assert.deepEqual(result["publishedPaused"], [true, false, true]);
assert.deepEqual(result["playCalls"], [0, 0]);
},
async test_retired_presentation_publication_is_suppressed_before_send() {
let functions, result, script;
functions = (await this.source_slice("function hostPlaybackSessionObservedPlaying", "function tauriEventListen"));
script = (`
const calls = [];
let releasePrevious;
const previous = new Promise((resolve) => { releasePrevious = resolve; });
const programA = { item_id: "A" };
const programB = { item_id: "B" };
const videoA = { currentTime: 12, duration: 100, paused: false, volume: 1, muted: false };
const audioA = { volume: 0.5, muted: false };
const videoB = { currentTime: 30, duration: 200, paused: false, volume: 1, muted: false };
const audioB = { volume: 0.7, muted: true };
const sessionA = {
  playbackGeneration: 10, playbackProgram: programA, phase: "playing",
  readyCommitted: true, video: videoA, audio: audioA,
};
const sessionB = {
  playbackGeneration: 11, playbackProgram: programB, phase: "playing",
  readyCommitted: false, video: videoB, audio: audioB,
};
const state = {
  data: {
    playback_generation: 10,
    playback_program: programA,
    current_item: { id: "A", title: "A" },
  },
  hostPlaybackSession: sessionA,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  localAdvanceInFlight: false,
  presentationSession: { phase: "active", generation: 9 },
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: previous,
};
function isCurrentHostPlaybackSession(session, video, audio) {
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && session.video === video
    && session.audio === audio;
}
function isActiveSplitPlayer(video, audio) {
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}
function activeLocalPlayerElements() {
  return {
    video: state.hostPlaybackSession?.video || null,
    audio: state.hostPlaybackSession?.audio || null,
  };
}
function activePrimaryVideoElement() { return state.hostPlaybackSession?.video || null; }
function t(key) { return key; }
function tauriInvoke() {
  return async (name, payload) => { calls.push([name, payload]); return payload; };
}
` + String(functions) + `
(async () => {
  const stale = publishPresentationPlaybackState(sessionA);
  sessionA.phase = "retired";
  state.data = {
    playback_generation: 11,
    playback_program: programB,
    current_item: { id: "B", title: "B" },
  };
  state.hostPlaybackSession = sessionB;
  const uncommitted = publishPresentationPlaybackState(sessionB);
  sessionB.readyCommitted = true;
  const current = publishPresentationPlaybackState(sessionB);
  releasePrevious();
  const uncommittedResult = await uncommitted;
  await Promise.all([stale, current]);
  process.stdout.write(JSON.stringify({
    callCount: calls.length,
    item: calls[0]?.[1]?.playbackState?.itemIdentity || "",
    signature: state.presentationPlaybackPublishSignature,
    uncommittedSuppressed: uncommittedResult === null,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["callCount"], 1);
assert.deepEqual(result["item"], "B");
assert.ok(hasContent(result["signature"]));
assert.ok(hasContent(result["uncommittedSuppressed"]));
},
async test_host_listener_serializes_commands_and_presentation_toggle_has_busy_finally() {
let listener, toggle;
listener = (await this.source_slice("async function initializeLocalPresentation", "function renderPlayerFullscreenButton"));
toggle = (await this.source_slice("async function toggleLocalPresentation", "function selectPresentationDisplay"));
assert.ok(contains("state.presentationCommandApplyPromise", listener));
assert.ok(contains(".then(() => applyControllerCommand(event?.payload))", listener));
assert.ok(contains("invoke(\"deactivate_local_presentation\"", listener));
assert.ok(contains("const commandGeneration = Number(event?.payload?.generation)", listener));
assert.ok(contains("state.presentationSession.generation !== commandGeneration", listener));
assert.ok(contains("generation: commandGeneration", listener));
assert.ok(contains("state.presentationControlBusy = true", toggle));
assert.ok(contains("finally", toggle));
assert.ok(contains("state.presentationControlBusy = false", toggle));
assert.ok(!contains("setTimeout", toggle));
},
async test_presentation_toggle_busy_state_tracks_invoke_settlement() {
let call, functions, result, script;
functions = (await this.source_slice("async function activateLocalPresentation", "function selectPresentationDisplay"));
script = (`
const calls = [];
const renders = [];
const messages = [];
const busyAtInvoke = [];
let settle = null;
let nextInvoke = (name, payload) => {
  busyAtInvoke.push(state.presentationControlBusy);
  calls.push([name, payload]);
  return new Promise((resolve, reject) => { settle = { resolve, reject }; });
};
const state = {
  presentationSelectedDisplayId: "display:audience",
  presentationControlBusy: false,
  presentationDisplayBusy: false,
  presentationSession: { phase: "inactive", generation: 0 },
};
function tauriInvoke() { return (name, payload) => nextInvoke(name, payload); }
function presentationDisplayById(displayId) {
  return displayId === "display:audience" ? { selectable: true } : null;
}
function renderPresentationOutputControl() { renders.push(state.presentationControlBusy); }
function setAppMessage(message, isError) { messages.push([message, isError]); }
function t(key, values = {}) { return values.message ? \`\${key}:\${values.message}\` : key; }
async function handlePresentationSession(session) {
  state.presentationSession = session;
  return session;
}
` + String(functions) + `
(async () => {
  const activation = toggleLocalPresentation();
  const busyDuringActivation = state.presentationControlBusy;
  settle.resolve({ phase: "activating", generation: 7 });
  await activation;
  const busyAfterActivation = state.presentationControlBusy;

  nextInvoke = async (name, payload) => {
    busyAtInvoke.push(state.presentationControlBusy);
    calls.push([name, payload]);
    return { phase: "inactive", generation: 8 };
  };
  await toggleLocalPresentation();
  const busyAfterCancellation = state.presentationControlBusy;

  state.presentationSession = { phase: "inactive", generation: 8 };
  nextInvoke = (name, payload) => {
    busyAtInvoke.push(state.presentationControlBusy);
    calls.push([name, payload]);
    return Promise.reject(new Error("activation rejected"));
  };
  await toggleLocalPresentation();
  process.stdout.write(JSON.stringify({
    calls,
    renders,
    messages,
    busyAtInvoke,
    busyDuringActivation,
    busyAfterActivation,
    busyAfterCancellation,
    busyAfterRejection: state.presentationControlBusy,
  }));
})();
`);
result = (await this.run_node(script));
assert.deepEqual(result["busyAtInvoke"], [true, true, true]);
assert.ok(hasContent(result["busyDuringActivation"]));
assert.ok(!hasContent(result["busyAfterActivation"]));
assert.ok(!hasContent(result["busyAfterCancellation"]));
assert.ok(!hasContent(result["busyAfterRejection"]));
assert.deepEqual(Array.from(Array.from(iterableValues(result["calls"]))).map((call) => call[0]), ["activate_local_presentation", "deactivate_local_presentation", "activate_local_presentation"]);
assert.deepEqual(result["calls"][1][1]["generation"], 7);
assert.deepEqual(result["messages"], [["display.presentationTransitionFailed:activation rejected", true]]);
assert.ok(!contains("setTimeout", functions));
},
async test_display_discovery_and_transition_controls_fail_closed_while_busy() {
let index, presentation;
presentation = (await this.source_slice("async function refreshPresentationDisplays", "function normalizeControllerCommandEnvelope"));
index = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
assert.ok(contains("state.presentationDisplayBusy", presentation));
assert.ok(contains("list.setAttribute(\"aria-busy\", \"true\")", presentation));
assert.ok(contains("state.presentationControlBusy || state.presentationDisplayBusy", presentation));
assert.ok(contains("replacement?.focus()", presentation));
assert.ok(contains("aria-controls=\"presentation-settings-panel\"", index));
assert.ok(contains("id=\"presentation-output-status\" role=\"status\"", index));
assert.ok(contains("id=\"presentation-display-list\" aria-live=\"polite\"", index));
assert.ok(contains("id=\"presentation-identify-button\"", index));
assert.ok(contains("invoke(\"show_presentation_display_identifiers\"", presentation));
assert.ok(contains("invoke(\"dismiss_presentation_display_identifiers\")", presentation));
},
async test_identification_is_explicit_and_busy_until_windows_finish() {
let identifiers, result, toggle;
identifiers = (await this.source_slice("async function showPresentationDisplayIdentifiers", "function dismissPresentationDisplayIdentifiers"));
toggle = (await this.source_slice("elements.presentationSettingsToggle?.addEventListener(\"click\", async () => {", "elements.presentationDisplayList?.addEventListener(\"click\","));
result = (await this.run_node((`
const assert = require("node:assert/strict");
const state = {
  presentationSettingsOpen: false, cacheSettingsOpen: true,
  presentationIdentifiersBusy: false, presentationDisplayBusy: false,
  presentationControlBusy: false, presentationSession: {phase: "inactive"},
  presentationDisplayInfo: {displays: [{id: "one"}, {id: "two"}]},
  theme: "light", language: "zh",
};
let handler, invokeCount = 0, refreshCount = 0, settle;
let invokeResult = new Promise(resolve => { settle = resolve; });
const elements = {presentationSettingsToggle: {addEventListener: (_, next) => {handler = next;}}};
const busyStates = [], messages = [];
function tauriInvoke() {return () => {invokeCount++; return invokeResult;};}
function renderPresentationOutputControl() {busyStates.push(state.presentationIdentifiersBusy);}
function normalizeTheme(value) {return value;}
function normalizeLanguage(value) {return value;}
function setAppMessage(message) {messages.push(message);}
function t(key) {return key;}
function setRemoteQrPinned() {}
function syncCachePanelVisibility() {}
function syncPresentationPanelVisibility() {}
async function refreshPresentationDisplays() {refreshCount++; return state.presentationDisplayInfo;}
` + String(identifiers) + `
` + String(toggle) + `
(async () => {
  await handler();
  assert.equal(state.presentationSettingsOpen, true);
  assert.equal(refreshCount, 1);
  assert.equal(invokeCount, 0, "menu opening must not show identifier windows");
  const pending = showPresentationDisplayIdentifiers();
  assert.equal(state.presentationIdentifiersBusy, true);
  assert.equal(await showPresentationDisplayIdentifiers(), false);
  assert.equal(invokeCount, 1, "pending identification blocks duplicate activation");
  await Promise.resolve();
  assert.equal(state.presentationIdentifiersBusy, true);
  settle();
  assert.equal(await pending, true);
  assert.equal(state.presentationIdentifiersBusy, false);
  invokeResult = Promise.reject(new Error("identifier failure"));
  assert.equal(await showPresentationDisplayIdentifiers({announceError: true}), false);
  assert.equal(state.presentationIdentifiersBusy, false);
  assert.equal(messages.length, 1);
  console.log(JSON.stringify({invokeCount, refreshCount, busyStates, messages}));
})().catch(error => {console.error(error); process.exitCode = 1;});
`)));
assert.deepEqual(result["invokeCount"], 2);
assert.deepEqual(result["refreshCount"], 1);
assert.deepEqual(result["busyStates"], [true, false, true, false]);
assert.deepEqual(result["messages"], ["display.identificationFailed"]);
},
async test_display_numbers_keep_menu_order_when_host_moves() {
let functions, result, script;
functions = (await this.source_slice("function normalizePresentationDisplayInfo", "async function refreshPresentationDisplays"));
script = (`
const renders = [];
const state = {
  presentationDisplayInfo: null,
  presentationDisplayError: "",
  presentationSession: { phase: "inactive" },
  presentationSelectionInitialized: false,
  presentationSelectedDisplayId: "",
  presentationSelectedHostDisplayId: "",
};
function renderPresentationOutputControl() {
  renders.push(state.presentationDisplayInfo?.displays?.map((display) => display.id) || []);
}
` + String(functions) + `
const display = (id, controller, builtIn = false) => ({
  id,
  name: id,
  positionX: 0,
  positionY: 0,
  width: 1920,
  height: 1080,
  scaleFactor: 1,
  builtIn,
  controller,
  primary: builtIn,
  selectable: true,
  mirrored: false,
  identityStable: true,
  identityQuality: "stable",
});
applyPresentationDisplayInfo({
  monitorCount: 3,
  displays: [display("builtin", true, true), display("desk", false), display("projector", false)],
  controllerDisplayId: "builtin",
  recommendedDisplayId: "desk",
});
applyPresentationDisplayInfo({
  monitorCount: 3,
  displays: [display("projector", false), display("desk", true), display("builtin", false, true)],
  controllerDisplayId: "desk",
  recommendedDisplayId: "projector",
});
process.stdout.write(JSON.stringify({
  ids: state.presentationDisplayInfo.displays.map((entry) => entry.id),
  controllers: state.presentationDisplayInfo.displays.map((entry) => entry.controller),
  selected: state.presentationSelectedDisplayId,
}));
`);
result = (await this.run_node(script));
assert.deepEqual(result["ids"], ["builtin", "desk", "projector"]);
assert.deepEqual(result["controllers"], [false, true, false]);
assert.deepEqual(result["selected"], "desk");
},
async test_display_discovery_refreshes_once_after_window_geometry_settles() {
let chrome, result, scheduler, script;
scheduler = (await this.source_slice("const presentationDisplayRefreshDebounceMs", "function presentationDisplayById"));
chrome = (await this.source_slice("function initializeWindowChrome", "function initializeHostShell"));
assert.ok(contains("appWindow.onMoved", chrome));
assert.ok(contains("appWindow.onScaleChanged", chrome));
assert.ok(contains("appWindow.onResized", chrome));
assert.ok(contains("window.addEventListener(\"focus\", schedulePresentationDisplayRefreshFromWindowEvent)", chrome));
assert.ok(!contains("setInterval", scheduler));
script = (`
let nextTimer = 0;
let activeTimer = null;
let cleared = 0;
let refreshes = 0;
const state = {
  presentationSettingsOpen: true,
  presentationSession: { phase: "inactive" },
  presentationDisplayRefreshTimer: null,
  presentationDisplayRefreshPending: false,
  presentationDisplayBusy: false,
};
global.window = {
  setTimeout(callback, delay) {
    activeTimer = { id: ++nextTimer, callback, delay };
    return activeTimer.id;
  },
  clearTimeout(id) {
    if (activeTimer?.id === id) activeTimer = null;
    cleared += 1;
  },
};
function refreshPresentationDisplays() {
  refreshes += 1;
  return Promise.resolve();
}
` + String(scheduler) + `
schedulePresentationDisplayRefreshFromWindowEvent();
schedulePresentationDisplayRefreshFromWindowEvent();
const scheduled = { count: nextTimer, cleared, delay: activeTimer?.delay };
activeTimer.callback();
state.presentationSettingsOpen = false;
schedulePresentationDisplayRefreshFromWindowEvent();
state.presentationSettingsOpen = true;
state.presentationSession.phase = "active";
schedulePresentationDisplayRefreshFromWindowEvent();
Promise.resolve().then(() => process.stdout.write(JSON.stringify({
  scheduled,
  refreshes,
  finalTimerCount: nextTimer,
})));
`);
result = (await this.run_node(script));
assert.deepEqual(result, {["scheduled"]: {["count"]: 2, ["cleared"]: 1, ["delay"]: 280}, ["refreshes"]: 1, ["finalTimerCount"]: 2});
},
async test_dual_display_roles_have_explanations_and_role_specific_icons() {
let icon_shapes, icons, index;
index = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
icon_shapes = (await this.source_slice("const presentationDeviceIconShapes", "function createPresentationDeviceIcon"));
icons = (await this.source_slice("function createPresentationDeviceIcon", "function renderPresentationDisplayList"));
assert.ok(contains("id=\"presentation-output-description\" role=\"tooltip\"", index));
assert.ok(contains("id=\"presentation-host-target-description\" role=\"tooltip\"", index));
assert.ok(!contains("id=\"presentation-host-target-hint\"", index));
assert.ok(contains("data-i18n=\"display.outputPanelTitle\">观众屏", index));
assert.ok(contains("data-i18n=\"display.hostTargetTitle\">Host 目标位置", index));
assert.ok(contains("id=\"presentation-host-target-summary\"", index));
assert.ok(!contains("<rect x=\"14.5\" y=\"8\" width=\"7\" height=\"9\"", index));
assert.ok(contains("host:", icon_shapes));
assert.ok(contains("output:", icon_shapes));
assert.ok(contains("presentationDisplayNumber(display.id)", icons));
assert.ok(contains("number.className = \"presentation-display-index\"", icons));
assert.ok(contains("fill: \"currentColor\"", icon_shapes));
assert.ok(!contains("controller:", icon_shapes));
},
async test_unavailable_output_is_not_presented_as_busy() {
let render, result, script, styles;
render = (await this.source_slice("function renderPresentationOutputControl", "async function handlePresentationSession"));
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
script = (`
const state = {
  presentationSession: {
    phase: "inactive",
    selectedOutputDisplayId: "",
  },
  presentationSelectedDisplayId: "",
  presentationDisplayInfo: {
    monitorCount: 1,
    displays: [{
      id: "primary",
      name: "Primary",
      controller: true,
      primary: true,
      selectable: false,
    }],
  },
  presentationDisplayError: "",
  presentationDisplayBusy: false,
  presentationControlBusy: false,
  presentationOutputRenderSignature: "",
  language: "en",
};
function classList() { return { toggle() {} }; }
function buttonLike() {
  return {
    classList: classList(),
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}
const button = {
  disabled: false,
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, String(value)); },
  removeAttribute(name) { this.attributes.delete(name); },
};
const elements = {
  presentationSettings: { classList: classList() },
  presentationOutputButton: button,
  presentationOutputStatus: { textContent: "" },
  presentationOutputSummary: { textContent: "" },
  presentationOutputMeta: { textContent: "" },
  presentationStateDot: { classList: classList() },
  presentationRefreshButton: buttonLike(),
  presentationDisplayList: {},
};
function tauriInvoke() { return () => {}; }
function presentationDisplayById(displayId) {
  return state.presentationDisplayInfo.displays.find((display) => display.id === displayId) || null;
}
function setTextContent(element, value) { element.textContent = value; }
function setElementAttribute(element, name, value) { element.setAttribute(name, value); }
function setClassToggle(element, name, enabled) { element.classList.toggle(name, enabled); }
function renderPresentationDisplayList() {}
function t(key) { return key; }
` + String(render) + `
renderPresentationOutputControl();
const unavailable = {
  disabled: button.disabled,
  ariaChecked: button.attributes.get("aria-checked") || null,
  ariaBusy: button.attributes.get("aria-busy") || null,
  status: elements.presentationOutputStatus.textContent,
};
state.presentationControlBusy = true;
renderPresentationOutputControl();
const busy = {
  disabled: button.disabled,
  ariaBusy: button.attributes.get("aria-busy") || null,
};
process.stdout.write(JSON.stringify({ unavailable, busy }));
`);
result = (await this.run_node(script));
assert.deepEqual(result["unavailable"], {["disabled"]: true, ["ariaChecked"]: "false", ["ariaBusy"]: null, ["status"]: "display.presentationNoExternalDisplay"});
assert.deepEqual(result["busy"]["disabled"], true);
assert.deepEqual(result["busy"]["ariaBusy"], "true");
assert.ok(contains(`.presentation-output-switch:disabled {
  opacity: 0.52;
  cursor: not-allowed;`, styles));
assert.ok(contains(`.presentation-output-switch:disabled[aria-busy="true"] {
  cursor: wait;
}`, styles));
}
};
test("PresentationHostFrontendTest.test_dual_screen_host_transport_matches_remote_control_order", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_dual_screen_host_transport_matches_remote_control_order(); });
test("PresentationHostFrontendTest.test_composition_preserves_media_and_turns_host_player_into_control_surface", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_composition_preserves_media_and_turns_host_player_into_control_surface(); });
test("PresentationHostFrontendTest.test_typed_commands_map_to_existing_host_authority_in_fifo_order", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_typed_commands_map_to_existing_host_authority_in_fifo_order(); });
test("PresentationHostFrontendTest.test_program_relative_controller_commands_consume_stale_targets_and_release_fifo", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_program_relative_controller_commands_consume_stale_targets_and_release_fifo(); });
test("PresentationHostFrontendTest.test_uncommitted_seek_is_cancelled_promptly_and_releases_controller_fifo", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_uncommitted_seek_is_cancelled_promptly_and_releases_controller_fifo(); });
test("PresentationHostFrontendTest.test_retired_seek_is_consumed_once_and_releases_native_like_fifo", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_retired_seek_is_consumed_once_and_releases_native_like_fifo(); });
test("PresentationHostFrontendTest.test_failed_next_track_is_not_acknowledged", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_failed_next_track_is_not_acknowledged(); });
test("PresentationHostFrontendTest.test_output_state_relays_through_shell_with_one_request_in_flight", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_output_state_relays_through_shell_with_one_request_in_flight(); });
test("PresentationHostFrontendTest.test_playback_snapshot_is_bounded_deduplicated_and_contains_no_media_transport", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_playback_snapshot_is_bounded_deduplicated_and_contains_no_media_transport(); });
test("PresentationHostFrontendTest.test_committed_pair_observation_drives_external_playback_state", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_committed_pair_observation_drives_external_playback_state(); });
test("PresentationHostFrontendTest.test_retired_presentation_publication_is_suppressed_before_send", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_retired_presentation_publication_is_suppressed_before_send(); });
test("PresentationHostFrontendTest.test_host_listener_serializes_commands_and_presentation_toggle_has_busy_finally", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_host_listener_serializes_commands_and_presentation_toggle_has_busy_finally(); });
test("PresentationHostFrontendTest.test_presentation_toggle_busy_state_tracks_invoke_settlement", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_presentation_toggle_busy_state_tracks_invoke_settlement(); });
test("PresentationHostFrontendTest.test_display_discovery_and_transition_controls_fail_closed_while_busy", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_display_discovery_and_transition_controls_fail_closed_while_busy(); });
test("PresentationHostFrontendTest.test_identification_is_explicit_and_busy_until_windows_finish", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_identification_is_explicit_and_busy_until_windows_finish(); });
test("PresentationHostFrontendTest.test_display_numbers_keep_menu_order_when_host_moves", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_display_numbers_keep_menu_order_when_host_moves(); });
test("PresentationHostFrontendTest.test_display_discovery_refreshes_once_after_window_geometry_settles", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_display_discovery_refreshes_once_after_window_geometry_settles(); });
test("PresentationHostFrontendTest.test_dual_display_roles_have_explanations_and_role_specific_icons", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_dual_display_roles_have_explanations_and_role_specific_icons(); });
test("PresentationHostFrontendTest.test_unavailable_output_is_not_presented_as_busy", async () => { const instance = Object.create(PresentationHostFrontendTest); await instance.setUpClass(); await instance.test_unavailable_output_is_not_presented_as_busy(); });
