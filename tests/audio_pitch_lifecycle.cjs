"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const slice = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
let sources = 0, creates = 0, live = 0, moduleLoads = 0, resumes = 0;
let configureWait = null, loadWait = null;
class Node extends EventTarget {
  constructor(name) { super(); this.name = name; this.connections = new Set(); this.gain = {value: 1, setTargetAtTime: v => { this.gain.value = v; }}; }
  connect(node) { this.connections.add(node); return node; }
  disconnect(node) { if (node) this.connections.delete(node); else this.connections.clear(); }
}
class Context extends EventTarget {
  constructor() { super(); this.state = "running"; this.sampleRate = 48000; this.currentTime = 0; this.destination = new Node("destination");
    this.audioWorklet = {addModule: async () => { moduleLoads++; if (loadWait) await loadWait.promise; }}; }
  createGain() { return new Node("gain"); }
  createMediaElementSource(audio) { assert(!audio.wrapped); audio.wrapped = true; sources++; return new Node("source"); }
  resume() { resumes++; return Promise.reject(new Error("policy")); }
  close() { this.state = "closed"; this.dispatchEvent(new Event("statechange")); return Promise.resolve(); }
}
class DSP extends Node {
  constructor() { super("processor"); creates++; live++; this.dead = false; this.shifts = []; }
  async configure() { if (configureWait) await configureWait.promise; }
  async latency() { return .12; }
  async start(options) { this.started = true; this.shifts.push(options.semitones); }
  async schedule(options) { this.shifts.push(options.semitones); }
  destroy() { if (!this.dead) { this.dead = true; live--; this.disconnect(); } }
}
globalThis.window = globalThis;
globalThis.document = {currentScript: {src: "http://localhost/pitch-player.js"}};
globalThis.AudioContext = Context;
globalThis.AudioWorkletNode = DSP;
globalThis.isSecureContext = true;
globalThis.loadPitchModule = async () => ({default: async (_ctx, _options, signal) => {
  const node = new DSP(); signal.addEventListener("abort", () => node.destroy(), {once: true}); return node;
}});
// Only dependency loading is mocked; exercise the shipping adapter and Host seams.
eval(fs.readFileSync(path.join(root, "static/pitch-player.js"), "utf8").replace("import(moduleUrl)", "loadPitchModule()"));
const state = {localPlayerVolume: 1, localPlayerMuted: false, audioContext: null, data: {player_settings: {key_shift: 0}}};
const messages = [];
function setAppMessage(message) { messages.push(message); }
function t(key) { return key; }
function renderKeyShiftControls() {}
function frontendPlaybackMode() { return "local"; }
function addMountedPlayerListener(media, name, fn) { media.addEventListener(name, fn); }
function isCurrentHostPlaybackSession(session, _video, audio) { return session === state.hostPlaybackSession && session.audio === audio; }
function persistLocalVolumePreferences() {}
function closeConfirm() {}
function render() {}
async function apiPostStateSnapshot(_url, _data, options) { options.onAccepted(); }
function activeLocalPlayerElements() { return state.hostPlaybackSession; }
function media() {
  const value = new EventTarget();
  Object.assign(value, {paused: true, ended: false, seeking: false, currentTime: 0, duration: 100, readyState: 4, playbackRate: 1,
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event("pause")); } },
    play() { this.paused = false; return Promise.resolve(); }});
  return value;
}
function pair() {
  const audio = media(), video = media();
  state.hostPlaybackSession = {audio, video};
  return {audio, video};
}
function sync(audio, video, offset = 0, rate = 1) {
  return audio.bilikaraPitch.sync({video, offset, rate, hold: () => video.pause(), play: () => audio.play(), align: t => {video.currentTime = t;}});
}
async function prime(audio, video, offset = 0, rate = 1) {
  await tick(); sync(audio, video, offset, rate); audio.dispatchEvent(new Event("seeked")); await tick(); sync(audio, video, offset, rate);
  audio.currentTime += .12 * rate + 1 / 48000;
  sync(audio, video, offset, rate);
  assert.equal(audio.bilikaraPitch.phase, "active");
}

eval(slice("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences") + "\n" +
  slice("function syncLocalPlayerSettingsFromSnapshot", "function markLocalVolumeWrite") + `
${slice("async function resetPlayerState", "async function requestAppUpdateCheck")}
function teardownMountedPlayer() {
  const audio = state.hostPlaybackSession?.audio;
  disposeAudioPitchShifter(audio);
  audio?.pause();
  state.hostPlaybackSession = null;
}
(async () => {
  let {audio, video} = pair();
  applyKeyShiftToAudio(audio, 0);
  assert.equal(state.audioContext, null); assert.equal(sources, 0); assert.equal(creates, 0);
  audio.paused = false;
  applyKeyShiftToAudio(audio, 3);
  await prime(audio, video);
  const first = audio.bilikaraPitch.node;
  assert.equal(audio.bilikaraPitch.applied, 3);
  for (const shift of [-6, 2, -3, 6]) applyKeyShiftToAudio(audio, shift);
  await tick();
  assert.equal(audio.bilikaraPitch.node, first); assert.equal(audio.bilikaraPitch.applied, 6);
  assert.equal(sources, 1); assert.equal(moduleLoads, 1);
  applyKeyShiftToAudio(audio, 0); sync(audio, video);
  assert.equal(live, 0); assert.deepEqual([...audio.bilikaraPitchSource.connections], [audio.bilikaraVolumeGain]);
  assert.equal(audio.bilikaraPitch.delay(), 0);
  for (let i = 0; i < 16; i++) {
    applyKeyShiftToAudio(audio, i % 2 ? 3 : -3); await prime(audio, video);
    assert.equal(live, 1); applyKeyShiftToAudio(audio, 0); sync(audio, video); assert.equal(live, 0);
  }
  assert.equal(sources, 1); assert.equal(moduleLoads, 1);
  disposeAudioPitchShifter(audio); disposeAudioPitchShifter(audio);
  assert.equal(ensureAudioPitchSource(audio), null, "retired element must never get a second source");
  assert.equal(live, 0);

  // Latest intent during asynchronous configuration, then seek/reset and replacement.
  ({audio, video} = pair()); configureWait = deferred();
  applyKeyShiftToAudio(audio, 3); await tick();
  applyKeyShiftToAudio(audio, -6); applyKeyShiftToAudio(audio, 6);
  const pending = audio.bilikaraPitch.node;
  assert.equal(audio.bilikaraPitch.applied, 0);
  audio.bilikaraPitch.reset(); await tick();
  assert(pending.dead);
  const retired = audio; disposeAudioPitchShifter(audio); ({audio, video} = pair());
  configureWait.resolve(); configureWait = null; await tick();
  assert.equal(live, 0); assert.equal(retired.bilikaraPitch, null);

  // Signed user AV delay is unchanged; input starts at the selected content,
  // with latency multiplied by media rate only in the running time mapping.
  for (const offset of [-.35, 0, .4]) {
    video.currentTime = 30; audio.currentTime = 10; audio.playbackRate = 1.25;
    applyKeyShiftToAudio(audio, 3); await tick(); sync(audio, video, offset, 1.25);
    assert.equal(audio.currentTime, 30 - offset);
    assert.equal(video.currentTime, 30);
    await prime(audio, video, offset, 1.25);
    assert.equal(audio.bilikaraPitch.delay(), .15);
    assert(Math.abs(video.currentTime - (audio.currentTime - .15 + offset)) < 2 / 48000);
    audio.pause(); assert.notEqual(audio.bilikaraPitch.phase, "active");
    assert.equal(audio.bilikaraPitch.gate.gain.value, 0);
    video.currentTime = 40; audio.bilikaraPitch.reset(); await tick();
    assert.equal(audio.paused, true, "paused seek must not restart audio");
    await prime(audio, video, offset, 1.25);
    const old = audio.bilikaraPitch.node;
    audio.dispatchEvent(new Event("seeking")); await tick(); assert(old.dead);
    applyKeyShiftToAudio(audio, 0); sync(audio, video);
  }
  applyKeyShiftToAudio(audio, 3); await prime(audio, video);
  const draining = audio.bilikaraPitch.drain();
  assert.equal(audio.bilikaraPitch.phase, "draining");
  disposeAudioPitchShifter(audio); assert.equal(await draining, false, "explicit next cancels tail");
  assert.equal(live, 0);

  // Runtime failure restores one direct destination, reports once and never retries.
  ({audio, video} = pair()); applyKeyShiftToAudio(audio, 3); await prime(audio, video);
  audio.bilikaraPitch.node.dispatchEvent(new Event("processorerror"));
  const failureCreates = creates;
  await tick(); sync(audio, video);
  assert.equal(audio.bilikaraPitch.applied, 0);
  assert.deepEqual([...audio.bilikaraPitchSource.connections], [audio.bilikaraVolumeGain]);
  for (let i = 0; i < 5; i++) applyKeyShiftToAudio(audio, 6);
  assert.equal(creates, failureCreates); assert.equal(messages.length, 1);
  disposeAudioPitchShifter(audio);

  ({audio, video} = pair()); globalThis.isSecureContext = false;
  const sourceCount = sources; applyKeyShiftToAudio(audio, 3);
  assert.equal(sources, sourceCount); assert.equal(audio.bilikaraPitchFailure, "unsupported-context");
  globalThis.isSecureContext = true;

  // A module error must not capture a still-native media element at all.
  state.audioContext = null; ({audio, video} = pair()); loadWait = deferred();
  applyKeyShiftToAudio(audio, 3); await tick(); loadWait.reject(new Error("CSP")); await tick(); loadWait = null;
  assert.equal(audio.bilikaraPitch.failure, "initialization"); sync(audio, video);
  assert.equal(audio.bilikaraPitchSource, undefined);
  disposeAudioPitchShifter(audio); disposeSharedAudioContext();
  assert.equal(state.audioContext, null); assert.equal(live, 0);

  // Existing snapshot activation and rejected autoplay resume remain bounded.
  ({audio, video} = pair()); state.audioContext = new Context(); state.audioContext.state = "suspended";
  audio.paused = false; state.data.player_settings.key_shift = 3;
  syncLocalPlayerSettingsFromSnapshot(state.data.player_settings); await tick();
  const beforeResumes = resumes;
  syncLocalPlayerSettingsFromSnapshot(state.data.player_settings); await tick();
  assert.equal(resumes, beforeResumes);
  disposeAudioPitchShifter(audio); disposeSharedAudioContext(); assert.equal(live, 0);

  ({audio, video} = pair()); state.audioContext = null;
  applyKeyShiftToAudio(audio, 3); await prime(audio, video);
  const endingPitch = audio.bilikaraPitch;
  audio.ended = true; audio.pause();
  assert.equal(endingPitch.phase, "active", "native ended pause must preserve the output tail");
  const tail = endingPitch.drain(); state.audioContext.currentTime += .25;
  assert.equal(await tail, true);
  const resetContext = state.audioContext;
  state.volumeSaveSeq = 0; state.localPlayerMuted = true; state.localPlayerVolume = 4;
  await resetPlayerState();
  assert.equal(state.audioContext, null); assert.equal(resetContext.state, "closed");
  assert.equal(audio.bilikaraPitch, null); assert.equal(audio.bilikaraPitchRetired, true);
  assert.equal(state.localPlayerVolume, 1); assert.equal(state.localPlayerMuted, false);
  assert.equal(state.volumeSaveSeq, 1); assert.equal(live, 0);

  // Reject clocks which jump ahead of actual context time, without claiming pitch.
  const clockAudio = media(), clockContext = new Context(), clockSource = new Node("source"), clockDestination = new Node("destination");
  let clockFailure = "";
  const clockPitch = new BilikaraPitch.PlayerPitch({audio: clockAudio, context: clockContext, source: clockSource, destination: clockDestination, current: () => true, unavailable: kind => {clockFailure = kind;}});
  clockAudio.bilikaraPitch = clockPitch; video = media();
  clockPitch.setShift(3); await tick(); sync(clockAudio, video); await tick(); sync(clockAudio, video);
  clockAudio.currentTime = 1.1; clockContext.currentTime = .02; sync(clockAudio, video);
  assert.equal(clockFailure, "media-clock"); assert.equal(clockPitch.applied, 0);
  assert.deepEqual([...clockSource.connections], [clockDestination]);
  clockPitch.dispose(); assert.equal(live, 0);
  console.log(JSON.stringify({sources, creates, live, moduleLoads, cases: 12}));
})().catch(error => {console.error(error); process.exitCode = 1;});
`);
