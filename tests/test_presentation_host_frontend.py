from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PresentationHostFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.path = ROOT / "static" / "app.js"
        cls.source = cls.path.read_text(encoding="utf-8")

    @classmethod
    def source_slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_composition_preserves_media_and_acknowledges_after_render_frame(self):
        functions = self.source_slice(
            "function presentationCompositionActive",
            "function applyPresentationSession",
        )
        script = f"""
class ClassList {{
  constructor() {{ this.values = new Set(); }}
  add(name) {{ this.values.add(name); }}
  remove(name) {{ this.values.delete(name); }}
  toggle(name, force) {{
    if (force) this.values.add(name); else this.values.delete(name);
    return this.values.has(name);
  }}
  contains(name) {{ return this.values.has(name); }}
}}
const trace = [];
const video = {{ tagName: "VIDEO", currentTime: 42 }};
const audio = {{ tagName: "AUDIO", currentTime: 42 }};
const frame = {{ children: [video, audio], inert: false }};
const elements = {{ playerFrame: frame }};
const state = {{
  presentationSession: {{
    mode: "localDualScreen", phase: "activating", generation: 4,
    hostReady: false, controllerReady: true,
  }},
  presentationAppliedComposition: "combined",
  presentationCompositionGeneration: 0,
  presentationHostReadyKey: "",
  presentationCursorHideTimer: null,
}};
global.window = global;
window.setTimeout = () => 10;
window.clearTimeout = () => {{}};
window.requestAnimationFrame = (callback) => {{ trace.push("frame"); callback(); }};
global.document = {{ body: {{ classList: new ClassList() }} }};
function hideMountedPlayerControls() {{ trace.push("hide-controls"); }}
function renderCurrentPresentationScene() {{ trace.push("render-scene"); }}
function renderPlayerFullscreenButton() {{ trace.push("render-fullscreen"); }}
function setAppMessage(message) {{ trace.push(`error:${{message}}`); }}
function t(key) {{ return key; }}
function tauriInvoke() {{
  return async (name, payload) => {{
    trace.push(`invoke:${{name}}:${{payload.composition}}`);
    return {{ ...state.presentationSession, hostReady: true }};
  }};
}}
async function handlePresentationSession(session) {{
  trace.push("handle-session");
  state.presentationSession = session;
}}
{functions}
(async () => {{
  const before = [frame.children[0], frame.children[1]];
  const entered = await applyPresentationComposition({{ generation: 4, composition: "stageOnly" }});
  const entry = {{
    entered,
    activeClass: document.body.classList.contains("is-presentation-stage-only"),
    inert: frame.inert,
    sameVideo: frame.children[0] === before[0],
    sameAudio: frame.children[1] === before[1],
    currentTime: frame.children[0].currentTime,
    trace: [...trace],
  }};
  state.presentationSession = {{
    mode: "localDualScreen", phase: "recovering", generation: 5,
    hostReady: false, controllerReady: false,
  }};
  state.presentationHostReadyKey = "";
  trace.length = 0;
  const exited = await applyPresentationComposition({{ generation: 5, composition: "combined" }});
  const stale = await applyPresentationComposition({{ generation: 4, composition: "stageOnly" }});
  process.stdout.write(JSON.stringify({{
    entry,
    exit: {{
      exited,
      stale,
      activeClass: document.body.classList.contains("is-presentation-stage-only"),
      inert: frame.inert,
      sameVideo: frame.children[0] === before[0],
      sameAudio: frame.children[1] === before[1],
      trace,
    }},
  }}));
}})();
"""
        result = self.run_node(script)
        entry = result["entry"]
        self.assertTrue(entry["entered"])
        self.assertTrue(entry["activeClass"])
        self.assertTrue(entry["inert"])
        self.assertTrue(entry["sameVideo"])
        self.assertTrue(entry["sameAudio"])
        self.assertEqual(entry["currentTime"], 42)
        self.assertLess(entry["trace"].index("render-scene"), entry["trace"].index("frame"))
        self.assertLess(
            entry["trace"].index("frame"),
            entry["trace"].index("invoke:mark_presentation_host_ready:stageOnly"),
        )
        exit_state = result["exit"]
        self.assertTrue(exit_state["exited"])
        self.assertFalse(exit_state["stale"])
        self.assertFalse(exit_state["activeClass"])
        self.assertFalse(exit_state["inert"])
        self.assertTrue(exit_state["sameVideo"])
        self.assertTrue(exit_state["sameAudio"])
        self.assertIn("invoke:mark_presentation_host_ready:combined", exit_state["trace"])

    def test_typed_commands_map_to_existing_host_authority_in_fifo_order(self):
        functions = self.source_slice(
            "function normalizeControllerCommandEnvelope",
            "function presentationPlaybackStateModel",
        )
        script = f"""
const actions = [];
const acknowledgements = [];
const messages = [];
let publishShouldFail = false;
const state = {{
  presentationSession: {{
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 6,
  }},
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
}};
const video = {{ currentTime: 20, duration: 200, dataset: {{ playerItemId: "song" }} }};
const audio = {{ currentTime: 20, duration: 200 }};
state.hostPlaybackSession = {{ readyCommitted: true }};
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
function setSplitPlaybackIntent(_video, _audio, playing, options) {{
  actions.push(["playback", playing, options.source]);
  return true;
}}
function isActiveSplitPlayer() {{ return true; }}
function beginSplitPlayerSeek(_video, _audio, options) {{
  actions.push(["seek", options.targetTime, options.diagnosticAction]);
  options.onSettled(true);
  return true;
}}
function reportPlayerStatus() {{ actions.push(["status"]); }}
async function requestNextTrack() {{ actions.push(["next"]); return true; }}
async function setLocalPlayerVolumeAndMuted(volume, muted, options) {{
  actions.push(["volume", volume, muted, options.reportError]);
}}
function setMediaCurrentTime(media, value) {{ media.currentTime = value; }}
function clampMediaTime(_media, value) {{ return value; }}
function tauriInvoke() {{
  return async (name, payload) => {{
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    acknowledgements.push(payload.sequence);
    return {{
      ...state.presentationSession,
      hostReady: true, controllerReady: true,
      lastAppliedCommandSequence: payload.sequence,
      mediaRendererOwner: "host",
    }};
  }};
}}
async function handlePresentationSession() {{}}
function setAppMessage(message) {{ messages.push(String(message)); }}
async function publishPresentationPlaybackState() {{
  actions.push(["publish"]);
  if (publishShouldFail) throw new Error("snapshot failed");
}}
{functions}
const envelope = (sequence, command) => ({{
  generation: 7, sequence, target: "host", command,
}});
(async () => {{
  const results = [];
  results.push(await applyControllerCommand(envelope(1, {{ type: "play" }})));
  results.push(await applyControllerCommand(envelope(2, {{ type: "pause" }})));
  results.push(await applyControllerCommand(envelope(3, {{ type: "seekRelative", deltaSeconds: -10 }})));
  results.push(await applyControllerCommand(envelope(4, {{ type: "seekAbsolute", targetSeconds: 75 }})));
  results.push(await applyControllerCommand(envelope(5, {{ type: "nextTrack" }})));
  publishShouldFail = true;
  results.push(await applyControllerCommand(envelope(6, {{
    type: "setVolume", volumePercent: 35, muted: true,
  }})));
  const stale = await applyControllerCommand(envelope(6, {{ type: "pause" }}));
  const wrongGeneration = await applyControllerCommand({{
    generation: 8, sequence: 7, target: "host", command: {{ type: "pause" }},
  }});
  await Promise.resolve();
  process.stdout.write(JSON.stringify({{
    results, stale, wrongGeneration, actions, acknowledgements, messages,
    applied: state.presentationLastAppliedCommandSequence,
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(result["results"], [True] * 6)
        self.assertFalse(result["stale"])
        self.assertFalse(result["wrongGeneration"])
        self.assertEqual(result["acknowledgements"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(result["applied"], 6)
        self.assertIn(["playback", True, "presentation-controller-play"], result["actions"])
        self.assertIn(["playback", False, "presentation-controller-pause"], result["actions"])
        self.assertIn(["seek", 10, "presentation-controller-seek"], result["actions"])
        self.assertIn(["seek", 75, "presentation-controller-seek"], result["actions"])
        self.assertIn(["next"], result["actions"])
        self.assertIn(["volume", 0.35, True, False], result["actions"])
        self.assertEqual(result["messages"], ["snapshot failed"])

    def test_uncommitted_seek_is_cancelled_promptly_and_releases_controller_fifo(self):
        functions = self.source_slice(
            "function normalizeControllerCommandEnvelope",
            "function presentationPlaybackStateModel",
        )
        script = f"""
const acknowledgements = [];
const effects = [];
let seekBegins = 0;
let playbackPublishes = 0;
const state = {{
  presentationSession: {{
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 2,
  }},
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
  hostPlaybackSession: {{
    phase: "binding", readyCommitted: false, logicalPlayIntent: true,
  }},
}};
const video = {{ currentTime: 20, duration: 200, dataset: {{ playerItemId: "song" }} }};
const audio = {{ currentTime: 20, duration: 200 }};
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
function isActiveSplitPlayer() {{ return true; }}
function beginSplitPlayerSeek() {{ seekBegins += 1; return true; }}
function setSplitPlaybackIntent(_video, _audio, playing, options) {{
  effects.push(["intent", playing, options.source]);
  state.hostPlaybackSession.logicalPlayIntent = playing;
  return true;
}}
function reportPlayerStatus() {{ effects.push(["status"]); }}
async function requestNextTrack() {{ throw new Error("not used"); }}
async function setLocalPlayerVolumeAndMuted() {{ throw new Error("not used"); }}
function tauriInvoke() {{
  return async (name, payload) => {{
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    acknowledgements.push(payload.sequence);
    return {{
      ...state.presentationSession,
      lastAppliedCommandSequence: payload.sequence,
    }};
  }};
}}
async function handlePresentationSession(session) {{ state.presentationSession = session; }}
async function publishPresentationPlaybackState() {{ playbackPublishes += 1; }}
function setAppMessage() {{}}
{functions}
const envelope = (sequence, command) => ({{
  generation: 7, sequence, target: "host", command,
}});
(async () => {{
  const seek = await applyControllerCommand(envelope(1, {{
    type: "seekAbsolute", targetSeconds: 75,
  }}));
  const pause = await applyControllerCommand(envelope(2, {{ type: "pause" }}));
  await Promise.resolve();
  process.stdout.write(JSON.stringify({{
    seek,
    pause,
    acknowledgements,
    applied: state.presentationLastAppliedCommandSequence,
    seekBegins,
    effects,
    logicalPlayIntent: state.hostPlaybackSession.logicalPlayIntent,
    playbackPublishes,
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(
            result,
            {
                "seek": False,
                "pause": True,
                "acknowledgements": [1, 2],
                "applied": 2,
                "seekBegins": 0,
                "effects": [["intent", False, "presentation-controller-pause"]],
                "logicalPlayIntent": False,
                "playbackPublishes": 1,
            },
        )

    def test_retired_seek_is_consumed_once_and_releases_native_like_fifo(self):
        functions = self.source_slice(
            "function normalizeControllerCommandEnvelope",
            "function presentationPlaybackStateModel",
        )
        script = f"""
const acknowledgements = [];
const emitted = [1];
const results = [];
const errors = [];
let pendingSeek = null;
let statusReports = 0;
let playbackPublishes = 0;
let deactivations = 0;
let pauseEffects = 0;
const programA = {{ item_id: "song-a" }};
const programB = {{ item_id: "song-b" }};
const state = {{
  presentationSession: {{
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 2,
  }},
  presentationLastAppliedCommandSequence: 0,
  presentationCommandApplyPromise: Promise.resolve(),
  localShouldBePlaying: true,
  data: {{ playback_generation: 10, playback_program: programA }},
}};
const videoA = {{ currentTime: 20, duration: 200, dataset: {{ playerItemId: "song-a" }} }};
const audioA = {{ currentTime: 20, duration: 200 }};
const videoB = {{ currentTime: 0, duration: 200, dataset: {{ playerItemId: "song-b" }} }};
const audioB = {{ currentTime: 0, duration: 200 }};
const sessionA = {{
  phase: "playing", playbackGeneration: 10, playbackProgram: programA,
  readyCommitted: true, video: videoA, audio: audioA,
}};
const sessionB = {{
  phase: "playing", playbackGeneration: 11, playbackProgram: programB,
  readyCommitted: true, video: videoB, audio: audioB,
}};
state.hostPlaybackSession = sessionA;
function isCurrentHostPlaybackSession(session, video, audio) {{
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && session.video === video
    && session.audio === audio;
}}
function activeLocalPlayerElements() {{
  return {{
    video: state.hostPlaybackSession?.video || null,
    audio: state.hostPlaybackSession?.audio || null,
  }};
}}
function isActiveSplitPlayer(video, audio) {{
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}}
function beginSplitPlayerSeek(_video, _audio, options) {{
  pendingSeek = options.onSettled;
  return true;
}}
function reportPlayerStatus() {{ statusReports += 1; }}
function setSplitPlaybackIntent(video, audio, playing) {{
  if (video === videoB && audio === audioB && !playing) pauseEffects += 1;
  return true;
}}
const nativeQueue = [
  {{ generation: 7, sequence: 1, target: "host", command: {{ type: "seekAbsolute", targetSeconds: 75 }} }},
  {{ generation: 7, sequence: 2, target: "host", command: {{ type: "pause" }} }},
];
let nativeInFlight = 1;
function dispatchHostCommand(command) {{
  const commandGeneration = command.generation;
  const pending = state.presentationCommandApplyPromise
    .catch(() => {{}})
    .then(() => applyControllerCommand(command));
  state.presentationCommandApplyPromise = pending;
  pending.then(
    (applied) => results.push([command.sequence, applied]),
    async (error) => {{
      errors.push([command.sequence, error.name, error.message]);
      if (
        Number.isSafeInteger(commandGeneration)
        && state.presentationSession.phase === "active"
        && state.presentationSession.generation === commandGeneration
      ) {{
        await tauriInvoke()("deactivate_local_presentation", {{ generation: commandGeneration }});
      }}
    }},
  );
  return pending;
}}
function tauriInvoke() {{
  return async (name, payload) => {{
    if (name === "deactivate_local_presentation") {{
      deactivations += 1;
      nativeQueue.length = 0;
      nativeInFlight = null;
      state.presentationSession.phase = "inactive";
      return state.presentationSession;
    }}
    if (name !== "acknowledge_presentation_command") throw new Error(name);
    if (nativeQueue[0]?.sequence !== payload.sequence || nativeInFlight !== payload.sequence) {{
      throw new Error("native acknowledgement is out of order");
    }}
    acknowledgements.push([name, payload.sequence]);
    nativeQueue.shift();
    nativeInFlight = nativeQueue[0]?.sequence || null;
    const session = {{ ...state.presentationSession, lastAppliedCommandSequence: payload.sequence }};
    if (nativeQueue[0]) {{
      const next = nativeQueue[0];
      Promise.resolve().then(() => {{
        emitted.push(next.sequence);
        dispatchHostCommand(next);
      }});
    }}
    return session;
  }};
}}
async function handlePresentationSession(session) {{ state.presentationSession = session; }}
async function publishPresentationPlaybackState() {{ playbackPublishes += 1; }}
function setAppMessage() {{}}
{functions}
(async () => {{
  const first = dispatchHostCommand(nativeQueue[0]);
  await Promise.resolve();
  await Promise.resolve();
  sessionA.phase = "retired";
  state.data = {{ playback_generation: 11, playback_program: programB }};
  state.hostPlaybackSession = sessionB;
  pendingSeek(false);
  pendingSeek(false);
  await first.catch(() => {{}});
  await Promise.resolve();
  await state.presentationCommandApplyPromise.catch(() => {{}});
  await Promise.resolve();
  process.stdout.write(JSON.stringify({{
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
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(
            result,
            {
                "results": [[1, False], [2, True]],
                "errors": [],
                "emitted": [1, 2],
                "acknowledgements": [
                    ["acknowledge_presentation_command", 1],
                    ["acknowledge_presentation_command", 2],
                ],
                "statusReports": 0,
                "playbackPublishes": 1,
                "deactivations": 0,
                "pauseEffects": 1,
                "nativeQueue": [],
                "nativeInFlight": None,
                "applied": 2,
            },
        )

    def test_failed_next_track_is_not_acknowledged(self):
        functions = self.source_slice(
            "function normalizeControllerCommandEnvelope",
            "function presentationPlaybackStateModel",
        )
        script = f"""
const acknowledgements = [];
const state = {{
  presentationSession: {{
    mode: "localDualScreen", phase: "active", generation: 7,
    playbackAuthority: "host", lastAcceptedCommandSequence: 1,
  }},
  presentationLastAppliedCommandSequence: 0,
  localShouldBePlaying: true,
}};
const video = {{ currentTime: 20, duration: 200, dataset: {{ playerItemId: "song" }} }};
const audio = {{ currentTime: 20, duration: 200 }};
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
async function requestNextTrack() {{ return false; }}
function tauriInvoke() {{
  return async (name, payload) => {{ acknowledgements.push([name, payload]); }};
}}
async function handlePresentationSession() {{}}
async function publishPresentationPlaybackState() {{}}
function setAppMessage() {{}}
{functions}
(async () => {{
  let error = "";
  try {{
    await applyControllerCommand({{
      generation: 7, sequence: 1, target: "host", command: {{ type: "nextTrack" }},
    }});
  }} catch (caught) {{
    error = caught.message;
  }}
  process.stdout.write(JSON.stringify({{ error, acknowledgements }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(result["error"], "The Host could not advance to the next track")
        self.assertEqual(result["acknowledgements"], [])

    def test_playback_snapshot_is_bounded_deduplicated_and_contains_no_media_transport(self):
        functions = self.source_slice(
            "function hostPlaybackSessionObservedPlaying",
            "function tauriEventListen",
        )
        script = f"""
const calls = [];
const program = {{ item_id: "song-1" }};
const video = {{ currentTime: 12.4, duration: 123.5, paused: false, volume: 1, muted: false }};
const audio = {{ paused: false, volume: 0.42, muted: true }};
const session = {{
  playbackGeneration: 3, playbackProgram: program, phase: "playing",
  readyCommitted: true, video, audio,
}};
const state = {{
  data: {{
    playback_generation: 3,
    playback_program: program,
    current_item: {{
      id: "song-1", display_title: "Song", video_url: "forbidden", audio_url: "forbidden",
    }},
  }},
  hostPlaybackSession: session,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  presentationSession: {{ phase: "active", generation: 9 }},
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: null,
}};
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
function activePrimaryVideoElement() {{ return video; }}
function isActiveSplitPlayer(candidateVideo, candidateAudio) {{
  return candidateVideo === video && candidateAudio === audio;
}}
function isCurrentHostPlaybackSession(candidate, candidateVideo, candidateAudio) {{
  return candidate === session
    && candidateVideo === video
    && candidateAudio === audio;
}}
function t(key) {{ return key; }}
function tauriInvoke() {{
  return async (name, payload) => {{ calls.push([name, payload]); return payload; }};
}}
{functions}
(async () => {{
  await Promise.all([publishPresentationPlaybackState(), publishPresentationPlaybackState()]);
  video.currentTime = 13.6;
  await publishPresentationPlaybackState();
  process.stdout.write(JSON.stringify({{ calls }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(len(result["calls"]), 2)
        first = result["calls"][0]
        self.assertEqual(first[0], "publish_presentation_playback_state")
        self.assertEqual(first[1]["generation"], 9)
        snapshot = first[1]["playbackState"]
        self.assertEqual(
            set(snapshot),
            {
                "revision",
                "itemIdentity",
                "title",
                "paused",
                "currentTimeSeconds",
                "durationSeconds",
                "volumePercent",
                "muted",
                "canSkip",
            },
        )
        self.assertEqual(snapshot["revision"], 1)
        self.assertFalse(snapshot["paused"])
        self.assertEqual(snapshot["volumePercent"], 42)
        self.assertTrue(snapshot["muted"])
        self.assertEqual(result["calls"][1][1]["playbackState"]["revision"], 2)

    def test_committed_pair_observation_drives_external_playback_state(self):
        legacy_view = self.source_slice(
            "function legacyPlaybackStartStateForSession",
            "const elements =",
        )
        publication = self.source_slice(
            "function hostPlaybackSessionObservedPlaying",
            "function tauriEventListen",
        )
        media_session = self.source_slice(
            "function tauriWebKitMediaSession",
            "function tauriMediaSessionActionEvent",
        )
        script = f"""
const presentationCalls = [];
const mediaStates = [];
let videoPlayCalls = 0;
let audioPlayCalls = 0;
let mediaPlaybackState = "none";
const mediaSession = {{
  get playbackState() {{ return mediaPlaybackState; }},
  set playbackState(value) {{
    mediaPlaybackState = value;
    mediaStates.push(value);
  }},
  setActionHandler() {{}},
  setPositionState() {{}},
}};
const program = {{ item_id: "song-1", artifact_set_id: "artifact-1" }};
const video = {{
  currentTime: 12, duration: 120, paused: true, playbackRate: 1,
  volume: 1, muted: false,
  play() {{ videoPlayCalls += 1; }},
}};
const audio = {{
  paused: true, volume: 0.5, muted: false,
  play() {{ audioPlayCalls += 1; }},
}};
const session = {{
  playbackGeneration: 4,
  playbackProgram: program,
  phase: "binding",
  readyCommitted: false,
  video,
  audio,
}};
const state = {{
  data: {{
    playback_generation: 4,
    playback_program: program,
    current_item: {{ id: "song-1", display_title: "Song" }},
  }},
  hostPlaybackSession: session,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  localAdvanceInFlight: false,
  presentationSession: {{ phase: "active", generation: 8 }},
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: null,
  lastTauriMediaSessionPositionAt: 0,
}};
global.window = global;
window.__TAURI__ = {{ core: {{}} }};
Object.defineProperty(globalThis, "navigator", {{
  value: {{ mediaSession }}, configurable: true, writable: true,
}});
const tauriMediaSessionPositionUpdateMs = 1000;
function activeLocalPlayerElements() {{
  return {{ video: session.video, audio: session.audio }};
}}
function activePrimaryVideoElement() {{ return session.video; }}
function isCurrentHostPlaybackSession(candidate, candidateVideo, candidateAudio) {{
  return candidate === state.hostPlaybackSession
    && candidate.playbackGeneration === state.data.playback_generation
    && candidate.playbackProgram === state.data.playback_program
    && candidate.video === candidateVideo
    && candidate.audio === candidateAudio
    && candidate.phase !== "retiring"
    && candidate.phase !== "retired";
}}
function isActiveSplitPlayer(candidateVideo, candidateAudio) {{
  return isCurrentHostPlaybackSession(
    state.hostPlaybackSession,
    candidateVideo,
    candidateAudio,
  );
}}
function isTauriWebKitRuntime() {{ return true; }}
function t(key) {{ return key; }}
function tauriInvoke() {{
  return async (name, payload) => {{
    presentationCalls.push([name, payload]);
    return payload;
  }};
}}
{legacy_view}
{publication}
{media_session}

const descriptor = Object.getOwnPropertyDescriptor(state, "localPlaybackStartState");
state.localPlaybackStartState = "starting";
const legacy = {{
  hasSetter: typeof descriptor.set === "function",
  phaseAfterWrite: session.phase,
  derivedState: state.localPlaybackStartState,
}};

async function observe(label, phase, readyCommitted, videoPaused, audioPaused) {{
  session.phase = phase;
  session.readyCommitted = readyCommitted;
  video.paused = videoPaused;
  audio.paused = audioPaused;
  state.localShouldBePlaying = true;
  const paused = presentationPlaybackStateModel(session).paused;
  syncTauriMediaSessionState(video, {{ forcePosition: true }});
  await publishPresentationPlaybackState(session);
  return {{
    label,
    paused,
    mediaState: mediaSession.playbackState,
    presentationCallCount: presentationCalls.length,
  }};
}}

(async () => {{
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
  process.stdout.write(JSON.stringify({{
    legacy,
    observations,
    duplicateReadyCallCount,
    publishedPaused: presentationCalls.map((call) => call[1].playbackState.paused),
    playCalls: [videoPlayCalls, audioPlayCalls],
    mediaStates,
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(
            result["legacy"],
            {
                "hasSetter": False,
                "phaseAfterWrite": "binding",
                "derivedState": "pending",
            },
        )
        self.assertEqual(
            result["observations"],
            [
                {
                    "label": "ready-paused",
                    "paused": True,
                    "mediaState": "paused",
                    "presentationCallCount": 1,
                },
                {
                    "label": "starting",
                    "paused": True,
                    "mediaState": "paused",
                    "presentationCallCount": 1,
                },
                {
                    "label": "needs-user-gesture",
                    "paused": True,
                    "mediaState": "paused",
                    "presentationCallCount": 1,
                },
                {
                    "label": "playing",
                    "paused": False,
                    "mediaState": "playing",
                    "presentationCallCount": 2,
                },
                {
                    "label": "paused",
                    "paused": True,
                    "mediaState": "paused",
                    "presentationCallCount": 3,
                },
                {
                    "label": "uncommitted",
                    "paused": True,
                    "mediaState": "none",
                    "presentationCallCount": 3,
                },
            ],
        )
        self.assertEqual(result["duplicateReadyCallCount"], 1)
        self.assertEqual(result["publishedPaused"], [True, False, True])
        self.assertEqual(result["playCalls"], [0, 0])

    def test_retired_presentation_publication_is_suppressed_before_send(self):
        functions = self.source_slice(
            "function hostPlaybackSessionObservedPlaying",
            "function tauriEventListen",
        )
        script = f"""
const calls = [];
let releasePrevious;
const previous = new Promise((resolve) => {{ releasePrevious = resolve; }});
const programA = {{ item_id: "A" }};
const programB = {{ item_id: "B" }};
const videoA = {{ currentTime: 12, duration: 100, paused: false, volume: 1, muted: false }};
const audioA = {{ volume: 0.5, muted: false }};
const videoB = {{ currentTime: 30, duration: 200, paused: false, volume: 1, muted: false }};
const audioB = {{ volume: 0.7, muted: true }};
const sessionA = {{
  playbackGeneration: 10, playbackProgram: programA, phase: "playing",
  readyCommitted: true, video: videoA, audio: audioA,
}};
const sessionB = {{
  playbackGeneration: 11, playbackProgram: programB, phase: "playing",
  readyCommitted: false, video: videoB, audio: audioB,
}};
const state = {{
  data: {{
    playback_generation: 10,
    playback_program: programA,
    current_item: {{ id: "A", title: "A" }},
  }},
  hostPlaybackSession: sessionA,
  localShouldBePlaying: true,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  localAdvanceInFlight: false,
  presentationSession: {{ phase: "active", generation: 9 }},
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: previous,
}};
function isCurrentHostPlaybackSession(session, video, audio) {{
  return session === state.hostPlaybackSession
    && session?.phase === "playing"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && session.video === video
    && session.audio === audio;
}}
function isActiveSplitPlayer(video, audio) {{
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}}
function activeLocalPlayerElements() {{
  return {{
    video: state.hostPlaybackSession?.video || null,
    audio: state.hostPlaybackSession?.audio || null,
  }};
}}
function activePrimaryVideoElement() {{ return state.hostPlaybackSession?.video || null; }}
function t(key) {{ return key; }}
function tauriInvoke() {{
  return async (name, payload) => {{ calls.push([name, payload]); return payload; }};
}}
{functions}
(async () => {{
  const stale = publishPresentationPlaybackState(sessionA);
  sessionA.phase = "retired";
  state.data = {{
    playback_generation: 11,
    playback_program: programB,
    current_item: {{ id: "B", title: "B" }},
  }};
  state.hostPlaybackSession = sessionB;
  const uncommitted = publishPresentationPlaybackState(sessionB);
  sessionB.readyCommitted = true;
  const current = publishPresentationPlaybackState(sessionB);
  releasePrevious();
  const uncommittedResult = await uncommitted;
  await Promise.all([stale, current]);
  process.stdout.write(JSON.stringify({{
    callCount: calls.length,
    item: calls[0]?.[1]?.playbackState?.itemIdentity || "",
    signature: state.presentationPlaybackPublishSignature,
    uncommittedSuppressed: uncommittedResult === null,
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(result["callCount"], 1)
        self.assertEqual(result["item"], "B")
        self.assertTrue(result["signature"])
        self.assertTrue(result["uncommittedSuppressed"])

    def test_host_listener_serializes_commands_and_presentation_toggle_has_busy_finally(self):
        listener = self.source_slice(
            "async function initializeLocalPresentation",
            "function renderPlayerFullscreenButton",
        )
        toggle = self.source_slice(
            "async function toggleLocalPresentation",
            "function selectPresentationDisplay",
        )
        self.assertIn("state.presentationCommandApplyPromise", listener)
        self.assertIn(".then(() => applyControllerCommand(event?.payload))", listener)
        self.assertIn('invoke("deactivate_local_presentation"', listener)
        self.assertIn(
            "const commandGeneration = Number(event?.payload?.generation)", listener
        )
        self.assertIn(
            "state.presentationSession.generation !== commandGeneration", listener
        )
        self.assertIn("generation: commandGeneration", listener)
        self.assertIn("state.presentationControlBusy = true", toggle)
        self.assertIn("finally", toggle)
        self.assertIn("state.presentationControlBusy = false", toggle)
        self.assertNotIn("setTimeout", toggle)

    def test_presentation_toggle_busy_state_tracks_invoke_settlement(self):
        functions = self.source_slice(
            "async function activateLocalPresentation",
            "function selectPresentationDisplay",
        )
        script = f"""
const calls = [];
const renders = [];
const messages = [];
const busyAtInvoke = [];
let settle = null;
let nextInvoke = (name, payload) => {{
  busyAtInvoke.push(state.presentationControlBusy);
  calls.push([name, payload]);
  return new Promise((resolve, reject) => {{ settle = {{ resolve, reject }}; }});
}};
const state = {{
  presentationSelectedDisplayId: "display:audience",
  presentationControlBusy: false,
  presentationDisplayBusy: false,
  presentationSession: {{ phase: "inactive", generation: 0 }},
}};
function tauriInvoke() {{ return (name, payload) => nextInvoke(name, payload); }}
function presentationDisplayById(displayId) {{
  return displayId === "display:audience" ? {{ selectable: true }} : null;
}}
function renderPresentationOutputControl() {{ renders.push(state.presentationControlBusy); }}
function setAppMessage(message, isError) {{ messages.push([message, isError]); }}
function t(key, values = {{}}) {{ return values.message ? `${{key}}:${{values.message}}` : key; }}
async function handlePresentationSession(session) {{
  state.presentationSession = session;
  return session;
}}
{functions}
(async () => {{
  const activation = toggleLocalPresentation();
  const busyDuringActivation = state.presentationControlBusy;
  settle.resolve({{ phase: "activating", generation: 7 }});
  await activation;
  const busyAfterActivation = state.presentationControlBusy;

  nextInvoke = async (name, payload) => {{
    busyAtInvoke.push(state.presentationControlBusy);
    calls.push([name, payload]);
    return {{ phase: "inactive", generation: 8 }};
  }};
  await toggleLocalPresentation();
  const busyAfterCancellation = state.presentationControlBusy;

  state.presentationSession = {{ phase: "inactive", generation: 8 }};
  nextInvoke = (name, payload) => {{
    busyAtInvoke.push(state.presentationControlBusy);
    calls.push([name, payload]);
    return Promise.reject(new Error("activation rejected"));
  }};
  await toggleLocalPresentation();
  process.stdout.write(JSON.stringify({{
    calls,
    renders,
    messages,
    busyAtInvoke,
    busyDuringActivation,
    busyAfterActivation,
    busyAfterCancellation,
    busyAfterRejection: state.presentationControlBusy,
  }}));
}})();
"""
        result = self.run_node(script)
        self.assertEqual(result["busyAtInvoke"], [True, True, True])
        self.assertTrue(result["busyDuringActivation"])
        self.assertFalse(result["busyAfterActivation"])
        self.assertFalse(result["busyAfterCancellation"])
        self.assertFalse(result["busyAfterRejection"])
        self.assertEqual(
            [call[0] for call in result["calls"]],
            [
                "activate_local_presentation",
                "deactivate_local_presentation",
                "activate_local_presentation",
            ],
        )
        self.assertEqual(result["calls"][1][1]["generation"], 7)
        self.assertEqual(
            result["messages"],
            [["display.presentationTransitionFailed:activation rejected", True]],
        )
        self.assertNotIn("setTimeout", functions)

    def test_display_discovery_and_transition_controls_fail_closed_while_busy(self):
        presentation = self.source_slice(
            "async function refreshPresentationDisplays",
            "function normalizeControllerCommandEnvelope",
        )
        index = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn("state.presentationDisplayBusy", presentation)
        self.assertIn('list.setAttribute("aria-busy", "true")', presentation)
        self.assertIn(
            "state.presentationControlBusy || state.presentationDisplayBusy", presentation
        )
        self.assertIn("replacement?.focus()", presentation)
        self.assertIn('aria-controls="presentation-settings-panel"', index)
        self.assertIn('id="presentation-output-status" role="status"', index)
        self.assertIn('id="presentation-display-list" aria-live="polite"', index)

    def test_unavailable_output_is_not_presented_as_busy(self):
        render = self.source_slice(
            "function renderPresentationOutputControl",
            "async function handlePresentationSession",
        )
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        script = f"""
const state = {{
  presentationSession: {{
    phase: "inactive",
    selectedOutputDisplayId: "",
  }},
  presentationSelectedDisplayId: "",
  presentationDisplayInfo: {{
    monitorCount: 1,
    displays: [{{
      id: "primary",
      name: "Primary",
      controller: true,
      primary: true,
      selectable: false,
    }}],
  }},
  presentationDisplayError: "",
  presentationDisplayBusy: false,
  presentationControlBusy: false,
  presentationOutputRenderSignature: "",
  language: "en",
}};
function classList() {{ return {{ toggle() {{}} }}; }}
function buttonLike() {{
  return {{
    classList: classList(),
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) {{ this.attributes.set(name, String(value)); }},
    removeAttribute(name) {{ this.attributes.delete(name); }},
  }};
}}
const button = {{
  disabled: false,
  attributes: new Map(),
  setAttribute(name, value) {{ this.attributes.set(name, String(value)); }},
  removeAttribute(name) {{ this.attributes.delete(name); }},
}};
const elements = {{
  presentationSettings: {{ classList: classList() }},
  presentationOutputButton: button,
  presentationOutputStatus: {{ textContent: "" }},
  presentationOutputSummary: {{ textContent: "" }},
  presentationOutputMeta: {{ textContent: "" }},
  presentationStateDot: {{ classList: classList() }},
  presentationRefreshButton: buttonLike(),
  presentationDisplayList: {{}},
}};
function tauriInvoke() {{ return () => {{}}; }}
function presentationDisplayById(displayId) {{
  return state.presentationDisplayInfo.displays.find((display) => display.id === displayId) || null;
}}
function setTextContent(element, value) {{ element.textContent = value; }}
function setElementAttribute(element, name, value) {{ element.setAttribute(name, value); }}
function setClassToggle(element, name, enabled) {{ element.classList.toggle(name, enabled); }}
function renderPresentationDisplayList() {{}}
function t(key) {{ return key; }}
{render}
renderPresentationOutputControl();
const unavailable = {{
  disabled: button.disabled,
  ariaChecked: button.attributes.get("aria-checked") || null,
  ariaBusy: button.attributes.get("aria-busy") || null,
  status: elements.presentationOutputStatus.textContent,
}};
state.presentationControlBusy = true;
renderPresentationOutputControl();
const busy = {{
  disabled: button.disabled,
  ariaBusy: button.attributes.get("aria-busy") || null,
}};
process.stdout.write(JSON.stringify({{ unavailable, busy }}));
"""
        result = self.run_node(script)
        self.assertEqual(
            result["unavailable"],
            {
                "disabled": True,
                "ariaChecked": "false",
                "ariaBusy": None,
                "status": "display.presentationNoExternalDisplay",
            },
        )
        self.assertEqual(result["busy"]["disabled"], True)
        self.assertEqual(result["busy"]["ariaBusy"], "true")
        self.assertIn(
            ".presentation-output-switch:disabled {\n"
            "  opacity: 0.52;\n"
            "  cursor: not-allowed;",
            styles,
        )
        self.assertIn(
            '.presentation-output-switch:disabled[aria-busy="true"] {\n'
            "  cursor: wait;\n"
            "}",
            styles,
        )


if __name__ == "__main__":
    unittest.main()
