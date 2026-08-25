from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AudioPitchLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.app_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.jungle_source = (ROOT / "static" / "jungle.js").read_text(encoding="utf-8")
        cls.pitch_source = cls._slice(
            "function disposeAudioPitchProcessor", "function persistLocalVolumePreferences"
        )
        cls.snapshot_source = cls._slice(
            "function syncLocalPlayerSettingsFromSnapshot", "function markLocalVolumeWrite"
        )
        cls.teardown_source = (
            cls._slice("function retireHostPlaybackSession", "function replaceHostPlayerView")
            + cls._slice("function teardownMountedPlayer", "function activeLocalPlayerElements")
        )
        cls.reset_source = cls._slice(
            "async function resetPlayerState", "async function installAppUpdate"
        )

    @classmethod
    def _slice(cls, start: str, end: str) -> str:
        start_index = cls.app_source.index(start)
        return cls.app_source[start_index : cls.app_source.index(end, start_index)]

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            [
                self.node,
                "-e",
                f"(async () => {{\n{script}\n}})().catch((error) => {{ console.error(error); process.exit(1); }});",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    def test_pitch_graph_is_lazy_reusable_and_fully_disposed(self):
        result = self.run_node(
            f"""
let contextCreates = 0;
let sourceCreates = 0;
let processorCreates = 0;
let processorDisposals = 0;
let activeProcessors = 0;
let contextCloses = 0;
let mountedMedia = [];

class MockNode {{
  constructor(name) {{
    this.name = name;
    this.connections = [];
    this.disconnectCalls = 0;
  }}
  connect(target) {{ this.connections.push(target); return target; }}
  disconnect() {{ this.connections = []; this.disconnectCalls += 1; }}
}}

class MockAudioContext {{
  constructor() {{
    contextCreates += 1;
    this.state = "running";
    this.destination = new MockNode("destination");
  }}
  createMediaElementSource() {{
    sourceCreates += 1;
    return new MockNode(`media-source-${{sourceCreates}}`);
  }}
  resume() {{ return Promise.resolve(); }}
  close() {{ this.state = "closed"; contextCloses += 1; return Promise.resolve(); }}
}}

class Jungle {{
  constructor() {{
    processorCreates += 1;
    activeProcessors += 1;
    this.input = new MockNode(`jungle-input-${{processorCreates}}`);
    this.output = new MockNode(`jungle-output-${{processorCreates}}`);
    this.disposed = false;
    this.pitchOffsets = [];
  }}
  setPitchOffset(value) {{ this.pitchOffsets.push(value); }}
  dispose() {{
    if (this.disposed) return;
    this.disposed = true;
    processorDisposals += 1;
    activeProcessors -= 1;
    this.input.disconnect();
    this.output.disconnect();
  }}
}}

class MockAudio {{
  constructor() {{ this.dataset = {{ playerRole: "audio" }}; this.paused = false; }}
  pause() {{ this.paused = true; }}
  removeAttribute() {{}}
  load() {{}}
}}

const window = {{ AudioContext: MockAudioContext, webkitAudioContext: null }};
const state = {{
  data: {{ player_settings: {{ key_shift: 0 }} }},
  audioContext: null,
  hostPlaybackSession: null,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localPlaybackEndHandled: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localPlayerVolume: 0.5,
  localPlayerMuted: true,
  playerSettingsEchoSuppressUntil: 1,
  volumeSaveSeq: 0,
  avOffsetSaving: true,
}};
const elements = {{
  playerFrame: {{ querySelectorAll() {{ return mountedMedia; }} }},
}};
function addMountedPlayerListener(_media, _name, _callback) {{}}
function clearWebKitAudioStarvationTimer() {{}}
function clearLocalPlayerSyncTimer() {{}}
function clearLocalPlayerControlsHideTimer() {{}}
function clearLocalPlayerSeekState() {{}}
function clearLocalPlayerEventListeners() {{ state.localPlayerEventCleanups = []; }}
function clearLocalAdvanceDelay() {{}}
function clearTauriMediaSessionState() {{}}
function persistLocalVolumePreferences() {{}}
async function apiPostStateSnapshot(_url, _payload, options) {{
  if (typeof options?.onAccepted === "function") {{
    options.onAccepted();
  }}
  return true;
}}
function closeConfirm() {{}}
function render() {{}}
function setAppMessage() {{}}
function t(key) {{ return key; }}

{self.pitch_source}
{self.teardown_source}
{self.reset_source}

const audio = new MockAudio();
setupAudioPitchShifter(audio);
const zeroMount = {{ contextCreates, sourceCreates, processorCreates, activeProcessors }};

applyKeyShiftToAudio(audio, 3);
const firstSource = audio.bilikaraPitchSource;
const firstProcessor = audio.jungle;
const firstNonZero = {{
  sourceCreates,
  processorCreates,
  activeProcessors,
  route: audio.bilikaraPitchRoute,
  sourceConnections: firstSource.connections.map((node) => node.name),
}};
applyKeyShiftToAudio(audio, 5);
const sameProcessor = audio.jungle === firstProcessor;

applyKeyShiftToAudio(audio, 0);
const returnedToZero = {{
  processorDisposals,
  activeProcessors,
  route: audio.bilikaraPitchRoute,
  sourceConnections: firstSource.connections.map((node) => node.name),
}};

applyKeyShiftToAudio(audio, -6);
const nonZeroAgain = {{
  sameSource: audio.bilikaraPitchSource === firstSource,
  sourceCreates,
  processorCreates,
  activeProcessors,
  route: audio.bilikaraPitchRoute,
  sourceConnections: firstSource.connections.map((node) => node.name),
}};

mountedMedia = [audio];
state.hostPlaybackSession = {{ cleanupState: "active", video: null, audio, eventCleanups: [] }};
teardownMountedPlayer();
const afterTeardown = {{
  activeProcessors,
  processorDisposals,
  sourceCleared: audio.bilikaraPitchSource === null,
  processorCleared: audio.jungle === null,
  contextStillOpen: state.audioContext?.state === "running",
}};

state.data.player_settings.key_shift = 2;
for (let index = 0; index < 5; index += 1) {{
  const transitionAudio = new MockAudio();
  mountedMedia = [transitionAudio];
  state.hostPlaybackSession = {{ cleanupState: "active", video: null, audio: transitionAudio, eventCleanups: [] }};
  setupAudioPitchShifter(transitionAudio);
  teardownMountedPlayer();
}}
const afterTransitions = {{ activeProcessors, processorCreates, processorDisposals }};

const resetAudio = new MockAudio();
mountedMedia = [resetAudio];
state.hostPlaybackSession = {{ cleanupState: "active", video: null, audio: resetAudio, eventCleanups: [] }};
setupAudioPitchShifter(resetAudio);
await resetPlayerState();
const afterReset = {{
  activeProcessors,
  contextCloses,
  contextCleared: state.audioContext === null,
  sourceCleared: resetAudio.bilikaraPitchSource === null,
  processorCleared: resetAudio.jungle === null,
}};

console.log(JSON.stringify({{
  zeroMount,
  firstNonZero,
  sameProcessor,
  returnedToZero,
  nonZeroAgain,
  afterTeardown,
  afterTransitions,
  afterReset,
}}));
"""
        )

        self.assertEqual(
            result["zeroMount"],
            {"contextCreates": 0, "sourceCreates": 0, "processorCreates": 0, "activeProcessors": 0},
        )
        self.assertEqual(
            result["firstNonZero"],
            {
                "sourceCreates": 1,
                "processorCreates": 1,
                "activeProcessors": 1,
                "route": "processor",
                "sourceConnections": ["jungle-input-1"],
            },
        )
        self.assertTrue(result["sameProcessor"])
        self.assertEqual(
            result["returnedToZero"],
            {
                "processorDisposals": 1,
                "activeProcessors": 0,
                "route": "direct",
                "sourceConnections": ["destination"],
            },
        )
        self.assertEqual(
            result["nonZeroAgain"],
            {
                "sameSource": True,
                "sourceCreates": 1,
                "processorCreates": 2,
                "activeProcessors": 1,
                "route": "processor",
                "sourceConnections": ["jungle-input-2"],
            },
        )
        self.assertEqual(
            result["afterTeardown"],
            {
                "activeProcessors": 0,
                "processorDisposals": 2,
                "sourceCleared": True,
                "processorCleared": True,
                "contextStillOpen": True,
            },
        )
        self.assertEqual(result["afterTransitions"]["activeProcessors"], 0)
        self.assertEqual(
            result["afterTransitions"]["processorCreates"],
            result["afterTransitions"]["processorDisposals"],
        )
        self.assertEqual(
            result["afterReset"],
            {
                "activeProcessors": 0,
                "contextCloses": 1,
                "contextCleared": True,
                "sourceCleared": True,
                "processorCleared": True,
            },
        )

    def test_already_playing_snapshot_activation_resumes_suspended_context_once(self):
        result = self.run_node(
            f"""
let sourceCreates = 0;
let processorCreates = 0;
let processorDisposals = 0;
let resumeCalls = 0;
let playListenerCount = 0;

class MockNode {{
  constructor(name) {{ this.name = name; this.connections = []; }}
  connect(target) {{ this.connections.push(target); return target; }}
  disconnect() {{ this.connections = []; }}
}}

class MockAudioContext {{
  constructor() {{
    this.state = "suspended";
    this.destination = new MockNode("destination");
  }}
  createMediaElementSource() {{
    sourceCreates += 1;
    return new MockNode("media-source-" + sourceCreates);
  }}
  resume() {{
    resumeCalls += 1;
    return Promise.reject(new Error("autoplay blocked"));
  }}
}}

class Jungle {{
  constructor() {{
    processorCreates += 1;
    this.input = new MockNode("jungle-input-" + processorCreates);
    this.output = new MockNode("jungle-output-" + processorCreates);
    this.disposed = false;
  }}
  setPitchOffset() {{}}
  dispose() {{
    if (this.disposed) return;
    this.disposed = true;
    processorDisposals += 1;
    this.input.disconnect();
    this.output.disconnect();
  }}
}}

const audio = {{ paused: false }};
const window = {{ AudioContext: MockAudioContext, webkitAudioContext: null }};
const state = {{
  data: {{ player_settings: {{ key_shift: 0 }} }},
  audioContext: null,
  playerSettingsEchoSuppressUntil: 0,
  localPlayerVolume: 1,
  localPlayerMuted: false,
}};
function addMountedPlayerListener(_media, name) {{
  if (name === "play") playListenerCount += 1;
}}
function activeLocalPlayerElements() {{ return {{ audio }}; }}
function persistLocalVolumePreferences() {{}}

{self.pitch_source}
{self.snapshot_source}

setupAudioPitchShifter(audio);
const zeroShift = {{
  contextCreated: state.audioContext !== null,
  sourceCreates,
  processorCreates,
  resumeCalls,
}};

const nonZeroSnapshot = {{ volume_percent: 100, is_muted: false, key_shift: 3 }};
state.data.player_settings = nonZeroSnapshot;
syncLocalPlayerSettingsFromSnapshot(nonZeroSnapshot);
await Promise.resolve();
const firstActivation = {{
  sourceCreates,
  processorCreates,
  resumeCalls,
  playListenerCount,
  route: audio.bilikaraPitchRoute,
}};

syncLocalPlayerSettingsFromSnapshot(nonZeroSnapshot);
await Promise.resolve();
const repeatedSnapshot = {{ sourceCreates, processorCreates, resumeCalls, playListenerCount }};

const zeroSnapshot = {{ volume_percent: 100, is_muted: false, key_shift: 0 }};
state.data.player_settings = zeroSnapshot;
syncLocalPlayerSettingsFromSnapshot(zeroSnapshot);
console.log(JSON.stringify({{
  zeroShift,
  firstActivation,
  repeatedSnapshot,
  returnedToZero: {{
    processorDisposals,
    processorCleared: audio.jungle === null,
    sourceCreates,
    route: audio.bilikaraPitchRoute,
    sourceConnections: audio.bilikaraPitchSource.connections.map((node) => node.name),
  }},
}}));
"""
        )

        self.assertEqual(
            result["zeroShift"],
            {"contextCreated": False, "sourceCreates": 0, "processorCreates": 0, "resumeCalls": 0},
        )
        self.assertEqual(
            result["firstActivation"],
            {
                "sourceCreates": 1,
                "processorCreates": 1,
                "resumeCalls": 1,
                "playListenerCount": 1,
                "route": "processor",
            },
        )
        self.assertEqual(
            result["repeatedSnapshot"],
            {"sourceCreates": 1, "processorCreates": 1, "resumeCalls": 1, "playListenerCount": 1},
        )
        self.assertEqual(
            result["returnedToZero"],
            {
                "processorDisposals": 1,
                "processorCleared": True,
                "sourceCreates": 1,
                "route": "direct",
                "sourceConnections": ["destination"],
            },
        )


    def test_jungle_dispose_stops_all_looping_sources_once(self):
        result = self.run_node(
            f"""
class MockNode {{
  constructor(kind) {{
    this.kind = kind;
    this.connections = [];
    this.disconnectCalls = 0;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.gain = {{ value: 1, setTargetAtTime: () => {{}} }};
    this.delayTime = {{}};
    this.buffer = null;
    this.loop = false;
  }}
  connect(target) {{ this.connections.push(target); return target; }}
  disconnect() {{ this.connections = []; this.disconnectCalls += 1; }}
  start() {{ this.startCalls += 1; }}
  stop() {{
    this.stopCalls += 1;
    if (this.stopCalls > 1) throw new Error("already stopped");
  }}
}}

const bufferSources = [];
const graphNodes = [];
const context = {{
  sampleRate: 100,
  currentTime: 1,
  createBuffer(_channels, length) {{
    return {{ getChannelData() {{ return new Float32Array(length); }} }};
  }},
  createBufferSource() {{
    const node = new MockNode("buffer-source");
    bufferSources.push(node);
    return node;
  }},
  createGain() {{
    const node = new MockNode("gain");
    graphNodes.push(node);
    return node;
  }},
  createDelay() {{
    const node = new MockNode("delay");
    graphNodes.push(node);
    return node;
  }},
}};

{self.jungle_source}

const jungle = new Jungle(context);
const started = bufferSources.reduce((total, node) => total + node.startCalls, 0);
jungle.dispose();
jungle.dispose();
jungle.setPitchOffset(0.25);
console.log(JSON.stringify({{
  sourceCount: bufferSources.length,
  started,
  stopped: bufferSources.reduce((total, node) => total + node.stopCalls, 0),
  sourceDisconnects: bufferSources.reduce((total, node) => total + node.disconnectCalls, 0),
  graphNodesDisconnected: graphNodes.every((node) => node.disconnectCalls === 1),
  disposed: jungle.disposed,
  contextCleared: jungle.context === null,
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "sourceCount": 6,
                "started": 6,
                "stopped": 6,
                "sourceDisconnects": 6,
                "graphNodesDisconnected": True,
                "disposed": True,
                "contextCleared": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
