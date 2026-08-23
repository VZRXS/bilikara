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
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
function setSplitPlaybackIntent(_video, _audio, playing, options) {{
  actions.push(["playback", playing, options.source]);
  return true;
}}
function isActiveSplitPlayer() {{ return true; }}
function beginSplitPlayerSeek(_video, _audio, options) {{
  actions.push(["seek", options.targetTime, options.diagnosticAction]);
  options.onSettled();
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
            "function presentationPlaybackStateModel",
            "function tauriEventListen",
        )
        script = f"""
const calls = [];
const video = {{ currentTime: 12.4, duration: 123.5, paused: false, volume: 1, muted: false }};
const audio = {{ volume: 0.42, muted: true }};
const state = {{
  data: {{ current_item: {{
    id: "song-1", display_title: "Song", video_url: "forbidden", audio_url: "forbidden",
  }} }},
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
