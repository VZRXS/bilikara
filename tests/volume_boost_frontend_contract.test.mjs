import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { sourceIndex, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const VolumeBoostFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.app = readFileSync(path.join(ROOT, "static/app.js"), "utf8");
},
async run_node(source) {
let result;
result = (await runNative(this.node, ["-e", source], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
return JSON.parse(result.stdout);
},
async source(start, end) {
let offset;
offset = sourceIndex(this.app, start);
return this.app.slice(offset, sourceIndex(this.app, end, offset));
},
async test_slider_keeps_full_normal_range_and_clamps_boost_at_end() {
let result;
result = (await this.run_node(`
require("./static/volume-control.js");
const { toPosition, toPercent } = globalThis.BilikaraVolumeControl;
console.log(JSON.stringify({
  positions: [0, 50, 100, 200, 500].map(toPosition),
  roundTrip: Array.from({length: 101}, (_, i) => toPercent(toPosition(i))),
}));
`));
assert.deepEqual(result["positions"], [0, 50, 100, 100, 100]);
assert.deepEqual(result["roundTrip"], Array.from(Array.from({length: 101}, (_, i) => i)));
},
async test_acknowledged_host_write_does_not_suppress_remote_mute() {
let result;
result = (await this.run_node(concatenate(concatenate(concatenate(`
const state = {localPlayerVolume: 1, localPlayerMuted: false, volumeSaveSeq: 0,
  playerSettingsEchoSuppressUntil: 0, data: {player_settings: {volume_percent: 100, is_muted: false}}};
const playerSettingsEchoSuppressMs = 1800;
function persistLocalVolumePreferences() {}
function activeLocalPlayerElements() { return {}; }
function applyStoredVolumeToMountedPlayer() {}
function renderVolumeControls() {}
function frontendPlaybackMode() { return "local"; }
function render() {}
function setAppMessage() {}
async function apiPost(url, settings) { return {player_settings: settings}; }
function acceptHostStateSnapshot(snapshot) { state.data = snapshot; return true; }
`, (await this.source("function syncLocalPlayerSettingsFromSnapshot", "function clientHeaders"))), (await this.source("async function setLocalPlayerVolumeAndMuted", "async function setLocalPlayerVolume(nextVolume"))), `
(async () => {
  await setLocalPlayerVolumeAndMuted(5, false);
  const suppression = state.playerSettingsEchoSuppressUntil;
  syncLocalPlayerSettingsFromSnapshot({volume_percent: 500, is_muted: true});
  console.log(JSON.stringify({suppression, volume: state.localPlayerVolume, muted: state.localPlayerMuted}));
})().catch(error => { console.error(error); process.exitCode = 1; });
`)));
assert.deepEqual(result, {["suppression"]: 0, ["volume"]: 5, ["muted"]: true});
},
async test_gain_survives_native_volume_echo_mute_pitch_and_media_replacement() {
let result;
result = (await this.run_node(concatenate(concatenate(concatenate(`
const assert = require("node:assert/strict");
let created = 0;
class Node {
  constructor(name) { this.name = name; this.connections = []; }
  connect(target) { this.connections.push(target); }
  disconnect() { this.connections = []; }
}
class Context {
  constructor() { this.destination = new Node("output"); this.state = "running"; this.currentTime = 0; }
  createMediaElementSource() { created++; return new Node("source"); }
  createGain() {
    const node = new Node("gain");
    node.gain = {value: 1, setTargetAtTime(value) { this.value = value; }};
    return node;
  }
}
class Pitch {
  constructor({source, destination}) { this.source = source; this.destination = destination; this.requested = 0; }
  setShift(value) { this.requested = value; this.source.disconnect(); this.source.connect(this.destination); }
  dispose() { this.source.disconnect(); }
}
globalThis.BilikaraPitch = {PlayerPitch: Pitch};
globalThis.isSecureContext = true;
globalThis.AudioWorkletNode = function() {};
function renderKeyShiftControls() {}
const window = {AudioContext: Context};
const state = {localPlayerVolume: .5, localPlayerMuted: false, data: {player_settings: {key_shift: 0}}};
const errors = [];
function setAppMessage(value) { errors.push(value); }
function t(key) { return key; }
function addMountedPlayerListener() {}
function persistLocalVolumePreferences() {}
function renderVolumeControls() {}
function frontendPlaybackMode() { return "local"; }
function media() {
  let volume = 1;
  return {paused: false, muted: false,
    get volume() { return volume; },
    set volume(value) { assert(value >= 0 && value <= 1); volume = value; }};
}
`, (await this.source("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences"))), (await this.source("function applyStoredVolumeToSplitPlayer", "function syncSplitSeekAudioTarget"))), `
const video = media(), audio = media();
applyStoredVolumeToSplitPlayer(video, audio);
assert.equal(created, 0, "ordinary volume keeps native playback lazy");
state.localPlayerVolume = 5;
applyStoredVolumeToSplitPlayer(video, audio);
assert.equal(audio.volume, 1);
assert.equal(audio.bilikaraVolumeGain.gain.value, 5);
syncSplitPlayerVolumeFromVideo(video, audio);
assert.equal(state.localPlayerVolume, 5, "programmatic native-volume echo must not reset gain");
video.muted = true;
syncSplitPlayerVolumeFromVideo(video, audio);
assert.equal(state.localPlayerVolume, 5);
assert.equal(audio.muted, true);
applyKeyShiftToAudio(audio, 3);
assert.equal(audio.bilikaraPitch.destination, audio.bilikaraVolumeGain);
assert.equal(audio.bilikaraPitch.requested, 3);
applyKeyShiftToAudio(audio, 0);
assert.deepEqual(audio.bilikaraPitchSource.connections, [audio.bilikaraVolumeGain]);
const gain = audio.bilikaraVolumeGain;
disposeAudioPitchShifter(audio);
assert.deepEqual(gain.connections, []);
const replacement = media();
applyStoredVolumeToSplitPlayer(video, replacement);
assert.equal(replacement.bilikaraVolumeGain.gain.value, 5);
state.localPlayerVolume = .4;
applyStoredVolumeToSplitPlayer(video, replacement);
assert.equal(replacement.volume, 1);
assert.equal(replacement.bilikaraVolumeGain.gain.value, .4);
video.volume = .25;
syncSplitPlayerVolumeFromVideo(video, replacement);
assert.equal(state.localPlayerVolume, .25, "real native-control changes still work");
assert.equal(replacement.volume, 1);
assert.equal(replacement.bilikaraVolumeGain.gain.value, .25);
assert.deepEqual(errors, []);
console.log(JSON.stringify({sources: created, volume: state.localPlayerVolume}));
`)));
assert.deepEqual(result, {["sources"]: 2, ["volume"]: 0.25});
},
async test_unavailable_audio_boost_reports_error_and_preserves_native_audio() {
let result;
result = (await this.run_node(concatenate(concatenate(`
const state = {localPlayerVolume: 5, localPlayerMuted: false};
const window = {};
const errors = [];
console.error = () => {};
function setAppMessage(value) { errors.push(value); }
function t(key) { return key; }
`, (await this.source("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences"))), `
const audio = {volume: .4, muted: true};
applyMediaVolume(audio);
applyMediaVolume(audio);
console.log(JSON.stringify({volume: audio.volume, muted: audio.muted, errors}));
`)));
assert.deepEqual(result, {["volume"]: 1, ["muted"]: false, ["errors"]: ["player.volumeUnavailable"]});
}
};
test("VolumeBoostFrontendTest.test_slider_keeps_full_normal_range_and_clamps_boost_at_end", async () => { const instance = Object.create(VolumeBoostFrontendTest); await instance.setUpClass(); await instance.test_slider_keeps_full_normal_range_and_clamps_boost_at_end(); });
test("VolumeBoostFrontendTest.test_acknowledged_host_write_does_not_suppress_remote_mute", async () => { const instance = Object.create(VolumeBoostFrontendTest); await instance.setUpClass(); await instance.test_acknowledged_host_write_does_not_suppress_remote_mute(); });
test("VolumeBoostFrontendTest.test_gain_survives_native_volume_echo_mute_pitch_and_media_replacement", async () => { const instance = Object.create(VolumeBoostFrontendTest); await instance.setUpClass(); await instance.test_gain_survives_native_volume_echo_mute_pitch_and_media_replacement(); });
test("VolumeBoostFrontendTest.test_unavailable_audio_boost_reports_error_and_preserves_native_audio", async () => { const instance = Object.create(VolumeBoostFrontendTest); await instance.setUpClass(); await instance.test_unavailable_audio_boost_reports_error_and_preserves_native_audio(); });
