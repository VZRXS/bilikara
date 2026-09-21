import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class VolumeBoostFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.app = (ROOT / "static/app.js").read_text(encoding="utf-8")

    def run_node(self, source):
        result = subprocess.run([self.node, "-e", source], cwd=ROOT, capture_output=True,
                                text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def source(self, start, end):
        offset = self.app.index(start)
        return self.app[offset:self.app.index(end, offset)]

    def test_slider_keeps_full_normal_range_and_clamps_boost_at_end(self):
        result = self.run_node('''
require("./static/volume-control.js");
const { toPosition, toPercent } = globalThis.BilikaraVolumeControl;
console.log(JSON.stringify({
  positions: [0, 50, 100, 200, 500].map(toPosition),
  roundTrip: Array.from({length: 101}, (_, i) => toPercent(toPosition(i))),
}));
''')
        self.assertEqual(result["positions"], [0, 50, 100, 100, 100])
        self.assertEqual(result["roundTrip"], list(range(101)))

    def test_acknowledged_host_write_does_not_suppress_remote_mute(self):
        result = self.run_node('''
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
''' + self.source("function syncLocalPlayerSettingsFromSnapshot", "function clientHeaders")
        + self.source("async function setLocalPlayerVolumeAndMuted", "async function setLocalPlayerVolume(nextVolume") + '''
(async () => {
  await setLocalPlayerVolumeAndMuted(5, false);
  const suppression = state.playerSettingsEchoSuppressUntil;
  syncLocalPlayerSettingsFromSnapshot({volume_percent: 500, is_muted: true});
  console.log(JSON.stringify({suppression, volume: state.localPlayerVolume, muted: state.localPlayerMuted}));
})().catch(error => { console.error(error); process.exitCode = 1; });
''')
        self.assertEqual(result, {"suppression": 0, "volume": 5, "muted": True})

    def test_gain_survives_native_volume_echo_mute_pitch_and_media_replacement(self):
        result = self.run_node('''
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
class Jungle {
  constructor() { this.input = new Node("pitch-in"); this.output = new Node("pitch-out"); }
  setPitchOffset() {}
  dispose() { this.input.disconnect(); this.output.disconnect(); }
}
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
''' + self.source("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences")
        + self.source("function applyStoredVolumeToSplitPlayer", "function syncSplitSeekAudioTarget") + '''
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
assert.equal(audio.jungle.output.connections[0], audio.bilikaraVolumeGain);
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
''')
        self.assertEqual(result, {"sources": 2, "volume": .25})

    def test_unavailable_audio_boost_reports_error_and_preserves_native_audio(self):
        result = self.run_node('''
const state = {localPlayerVolume: 5, localPlayerMuted: false};
const window = {};
const errors = [];
console.error = () => {};
function setAppMessage(value) { errors.push(value); }
function t(key) { return key; }
''' + self.source("function disposeAudioPitchProcessor", "function persistLocalVolumePreferences") + '''
const audio = {volume: .4, muted: true};
applyMediaVolume(audio);
applyMediaVolume(audio);
console.log(JSON.stringify({volume: audio.volume, muted: audio.muted, errors}));
''')
        self.assertEqual(result, {"volume": 1, "muted": False, "errors": ["player.volumeUnavailable"]})


if __name__ == "__main__":
    unittest.main()
