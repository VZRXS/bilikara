from __future__ import annotations

from html.parser import HTMLParser
import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class _ControllerMarkupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.ids: set[str] = set()
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        values = dict(attrs)
        if values.get("id"):
            self.ids.add(str(values["id"]))
        if tag == "script" and values.get("src"):
            self.scripts.append(str(values["src"]))


class ControllerFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.html_path = ROOT / "static" / "controller.html"
        cls.js_path = ROOT / "static" / "controller.js"
        cls.html = cls.html_path.read_text(encoding="utf-8")
        cls.source = cls.js_path.read_text(encoding="utf-8")

    def run_node(
        self, body: str, *, with_tauri: bool = True, before_eval: str = ""
    ) -> dict:
        tauri_setup = """
window.__TAURI__ = {
  core: { invoke },
  event: { listen },
};
""" if with_tauri else "window.__TAURI__ = undefined;"
        script = f"""
const fs = require("fs");

class ClassList {{
  constructor(initial = []) {{ this.values = new Set(initial); }}
  add(...names) {{ names.forEach((name) => this.values.add(name)); }}
  remove(...names) {{ names.forEach((name) => this.values.delete(name)); }}
  toggle(name, force) {{
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    return this.values.has(name);
  }}
  contains(name) {{ return this.values.has(name); }}
}}

function element(id, hidden = false) {{
  const listeners = {{}};
  const label = {{ textContent: "" }};
  return {{
    id,
    dataset: {{}},
    disabled: false,
    value: "0",
    max: "0",
    textContent: "",
    attributes: {{}},
    classList: new ClassList(hidden ? ["hidden"] : []),
    addEventListener(type, callback) {{ listeners[type] = callback; }},
    setAttribute(name, value) {{ this.attributes[name] = String(value); }},
    removeAttribute(name) {{ delete this.attributes[name]; }},
    querySelector(selector) {{ return selector === "span" ? label : null; }},
    dispatch(type) {{ return listeners[type]?.({{ target: this }}); }},
    label,
  }};
}}

const ids = [
  "controller-shell", "controller-status", "controller-title", "controller-time",
  "controller-seek", "controller-play-toggle", "controller-back-15",
  "controller-forward-15", "controller-next", "controller-volume",
  "controller-volume-value", "controller-mute", "controller-exit",
  "controller-error", "controller-unavailable",
];
const elements = Object.fromEntries(ids.map((id) => [
  id,
  element(id, id === "controller-error" || id === "controller-unavailable"),
]));
const commandIds = [
  "controller-seek", "controller-play-toggle", "controller-back-15",
  "controller-forward-15", "controller-next", "controller-volume", "controller-mute",
];
const windowListeners = {{}};
global.window = global;
window.location = {{ search: "?presentationGeneration=7" }};
window.addEventListener = (type, callback) => {{ windowListeners[type] = callback; }};
global.navigator = {{ languages: ["en-US"], language: "en-US" }};
global.document = {{
  title: "",
  activeElement: null,
  documentElement: {{ lang: "" }},
  getElementById: (id) => elements[id],
  querySelectorAll(selector) {{
    if (selector === "[data-command-control]") return commandIds.map((id) => elements[id]);
    return [];
  }},
}};
global.fetch = async () => ({{
  ok: true,
  json: async () => ({{ defaultLanguage: "en", languages: {{ en: {{}} }} }}),
}});

const trace = [];
const nativeListeners = {{}};
let unlistenCount = 0;
let session = {{
  mode: "localDualScreen",
  phase: "activating",
  generation: 7,
  hostReady: false,
  controllerReady: false,
  lastAcceptedCommandSequence: 0,
  lastAppliedCommandSequence: 0,
  playbackAuthority: "host",
  mediaRendererOwner: "host",
}};
let deferredSend = null;
let deferNextSend = true;
let emitStateDuringRegistration = false;
let deferPlaybackListener = false;
let resolvePlaybackListener = null;
let rejectControllerReady = false;
const sent = [];

async function listen(name, callback) {{
  trace.push(`listen:${{name}}`);
  nativeListeners[name] = callback;
  if (name === "bilikara-presentation-state" && emitStateDuringRegistration) {{
    callback({{ payload: {{ session: {{ ...session }} }} }});
  }}
  if (name === "bilikara-presentation-playback-state" && deferPlaybackListener) {{
    return new Promise((resolve) => {{
      resolvePlaybackListener = () => resolve(() => {{ unlistenCount += 1; }});
    }});
  }}
  return () => {{ unlistenCount += 1; }};
}}
async function invoke(name, payload = {{}}) {{
  trace.push(`invoke:${{name}}`);
  if (name === "get_presentation_session") return {{ ...session }};
  if (name === "mark_presentation_controller_ready") {{
    if (rejectControllerReady) throw new Error("controller readiness rejected");
    session = {{ ...session, controllerReady: true }};
    return {{ ...session }};
  }}
  if (name === "send_presentation_command") {{
    sent.push(payload.request);
    if (deferNextSend) {{
      deferNextSend = false;
      return new Promise((resolve) => {{ deferredSend = resolve; }});
    }}
    session = {{ ...session, lastAcceptedCommandSequence: payload.request.sequence }};
    return {{ generation: payload.request.generation, sequence: payload.request.sequence }};
  }}
  if (name === "deactivate_local_presentation") {{
    session = {{
      ...session,
      mode: "localDualScreen",
      phase: "recovering",
      generation: session.generation + 1,
      hostReady: false,
      controllerReady: false,
      lastAcceptedCommandSequence: 0,
      lastAppliedCommandSequence: 0,
    }};
    return {{ ...session }};
  }}
  throw new Error(`unexpected invoke ${{name}}`);
}}
{tauri_setup}
{before_eval}

eval(fs.readFileSync({json.dumps(str(self.js_path))}, "utf8"));

async function flush() {{
  await new Promise((resolve) => setTimeout(resolve, 10));
}}

(async () => {{
  await flush();
  {body}
}})().catch((error) => {{
  console.error(error);
  process.exitCode = 1;
}});
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_controller_has_no_media_or_remote_surface(self):
        parser = _ControllerMarkupParser()
        parser.feed(self.html)
        self.assertFalse({"video", "audio", "iframe", "canvas", "img"} & set(parser.tags))
        self.assertEqual(parser.scripts, ["/controller.js"])
        self.assertEqual(
            {
                "controller-shell",
                "controller-status",
                "controller-title",
                "controller-time",
                "controller-seek",
                "controller-play-toggle",
                "controller-back-15",
                "controller-forward-15",
                "controller-next",
                "controller-volume",
                "controller-mute",
                "controller-exit",
                "controller-error",
                "controller-unavailable",
            } - parser.ids,
            set(),
        )
        for forbidden in (
            "EventSource",
            "BroadcastChannel",
            "localStorage",
            "/api/",
            "remote.js",
            "createElement(\"video\")",
            "createElement(\"audio\")",
        ):
            self.assertNotIn(forbidden, self.source)

    def test_listeners_readiness_ordering_typed_sequence_and_busy_restoration(self):
        result = self.run_node(
            """
  const stateEvent = nativeListeners["bilikara-presentation-state"];
  const playbackEvent = nativeListeners["bilikara-presentation-playback-state"];
  const initialTrace = [...trace];
  session = { ...session, phase: "active", hostReady: true, controllerReady: true };
  stateEvent({ payload: { session: { ...session } } });
  playbackEvent({ payload: {
    generation: 7, sequence: 1,
    state: {
      revision: 1, playbackGeneration: 41, itemIdentity: "song-1", title: "First",
      paused: true, currentTimeSeconds: 12, durationSeconds: 120,
      volumePercent: 75, muted: false, canSkip: true,
    },
  }});

  elements["controller-back-15"].dispatch("click");
  await Promise.resolve();
  const busyDuringSend = {
    disabled: elements["controller-back-15"].disabled,
    ariaBusy: elements["controller-back-15"].attributes["aria-busy"],
    sentCount: sent.length,
  };
  elements["controller-forward-15"].dispatch("click");
  await Promise.resolve();
  const sentAfterDuplicate = sent.length;
  session = { ...session, lastAcceptedCommandSequence: 1 };
  deferredSend({ generation: 7, sequence: 1 });
  await flush();

  const sentBeforeSeekInput = sent.length;
  elements["controller-seek"].value = "55";
  elements["controller-seek"].dispatch("input");
  await Promise.resolve();
  const sentAfterSeekInput = sent.length;
  elements["controller-seek"].dispatch("change");
  await flush();

  elements["controller-play-toggle"].dispatch("click");
  await flush();
  elements["controller-next"].dispatch("click");
  await flush();
  elements["controller-volume"].value = "35";
  elements["controller-volume"].dispatch("change");
  await flush();

  playbackEvent({ payload: {
    generation: 7, sequence: 1,
    state: {
      revision: 2, playbackGeneration: 41, itemIdentity: "song-1", title: "Stale",
      paused: false, currentTimeSeconds: 20, durationSeconds: 120,
      volumePercent: 75, muted: false, canSkip: true,
    },
  }});
  const titleAfterStale = elements["controller-title"].textContent;
  playbackEvent({ payload: {
    generation: 7, sequence: 2,
    state: {
      revision: 3, playbackGeneration: 41, itemIdentity: "song-1", title: "Fresh",
      paused: false, currentTimeSeconds: 21, durationSeconds: 120,
      volumePercent: 75, muted: false, canSkip: true,
    },
  }});
  playbackEvent({ payload: {
    generation: 99, sequence: 99,
    state: {
      revision: 99, playbackGeneration: 99, itemIdentity: "bad", title: "Wrong generation",
      paused: false, currentTimeSeconds: 0, durationSeconds: 1,
      volumePercent: 10, muted: false, canSkip: true,
    },
  }});
  const titleAfterFresh = elements["controller-title"].textContent;

  elements["controller-exit"].dispatch("click");
  await flush();
  windowListeners.pagehide();
  process.stdout.write(JSON.stringify({
    initialTrace,
    busyDuringSend,
    sentAfterDuplicate,
    sentBeforeSeekInput,
    sentAfterSeekInput,
    sent,
    busyRestored: !elements["controller-back-15"].attributes["aria-busy"],
    titleAfterStale,
    titleAfterFresh,
    exitCalled: trace.includes("invoke:deactivate_local_presentation"),
    unlistenCount,
  }));
"""
        )
        self.assertLess(
            result["initialTrace"].index("listen:bilikara-presentation-state"),
            result["initialTrace"].index("invoke:get_presentation_session"),
        )
        self.assertLess(
            result["initialTrace"].index("listen:bilikara-presentation-playback-state"),
            result["initialTrace"].index("invoke:mark_presentation_controller_ready"),
        )
        self.assertEqual(
            result["busyDuringSend"],
            {"disabled": True, "ariaBusy": "true", "sentCount": 1},
        )
        self.assertEqual(result["sentAfterDuplicate"], 1)
        self.assertTrue(result["busyRestored"])
        self.assertEqual(result["sentBeforeSeekInput"], result["sentAfterSeekInput"])
        self.assertEqual(result["sent"][0], {
            "generation": 7,
            "sequence": 1,
            "command": {
                "type": "seekRelative",
                "deltaSeconds": -15,
                "expectedPlaybackGeneration": 41,
            },
        })
        self.assertEqual(result["sent"][1], {
            "generation": 7,
            "sequence": 2,
            "command": {
                "type": "seekAbsolute",
                "targetSeconds": 55,
                "expectedPlaybackGeneration": 41,
            },
        })
        self.assertEqual(result["sent"][2], {
            "generation": 7,
            "sequence": 3,
            "command": {"type": "play"},
        })
        self.assertEqual(result["sent"][3], {
            "generation": 7,
            "sequence": 4,
            "command": {
                "type": "nextTrack",
                "expectedPlaybackGeneration": 41,
            },
        })
        self.assertEqual(result["sent"][4], {
            "generation": 7,
            "sequence": 5,
            "command": {
                "type": "setVolume",
                "volumePercent": 35,
                "muted": False,
            },
        })
        self.assertEqual(result["titleAfterStale"], "First")
        self.assertEqual(result["titleAfterFresh"], "Fresh")
        self.assertTrue(result["exitCalled"])
        self.assertEqual(result["unlistenCount"], 2)

    def test_empty_snapshot_disables_playback_controls_but_keeps_volume_available(self):
        result = self.run_node(
            """
  const stateEvent = nativeListeners["bilikara-presentation-state"];
  const playbackEvent = nativeListeners["bilikara-presentation-playback-state"];
  session = { ...session, phase: "active", hostReady: true, controllerReady: true };
  stateEvent({ payload: { session: { ...session } } });
  playbackEvent({ payload: {
    generation: 7, sequence: 1,
    state: {
      revision: 1, itemIdentity: null, title: "", paused: true,
      currentTimeSeconds: 0, durationSeconds: null,
      volumePercent: 75, muted: false, canSkip: false,
    },
  }});
  const empty = {
    play: elements["controller-play-toggle"].disabled,
    back: elements["controller-back-15"].disabled,
    forward: elements["controller-forward-15"].disabled,
    seek: elements["controller-seek"].disabled,
    next: elements["controller-next"].disabled,
    volume: elements["controller-volume"].disabled,
    mute: elements["controller-mute"].disabled,
    playLabel: elements["controller-play-toggle"].label.textContent,
  };
  playbackEvent({ payload: {
    generation: 7, sequence: 2,
    state: {
      revision: 2, playbackGeneration: 41, itemIdentity: "song-1", title: "Song", paused: false,
      currentTimeSeconds: 5, durationSeconds: 120,
      volumePercent: 75, muted: false, canSkip: true,
    },
  }});
  const playable = {
    play: elements["controller-play-toggle"].disabled,
    back: elements["controller-back-15"].disabled,
    forward: elements["controller-forward-15"].disabled,
    seek: elements["controller-seek"].disabled,
    next: elements["controller-next"].disabled,
    playLabel: elements["controller-play-toggle"].label.textContent,
  };
  process.stdout.write(JSON.stringify({ empty, playable }));
"""
        )
        self.assertEqual(
            result["empty"],
            {
                "play": True,
                "back": True,
                "forward": True,
                "seek": True,
                "next": True,
                "volume": False,
                "mute": False,
                "playLabel": "controller.play",
            },
        )
        self.assertEqual(
            result["playable"],
            {
                "play": False,
                "back": False,
                "forward": False,
                "seek": False,
                "next": False,
                "playLabel": "controller.pause",
            },
        )

    def test_readiness_waits_until_both_native_listeners_are_installed(self):
        result = self.run_node(
            """
  const beforePlaybackListener = trace.filter(
    (entry) => entry === "invoke:mark_presentation_controller_ready",
  ).length;
  resolvePlaybackListener();
  await flush();
  const afterPlaybackListener = trace.filter(
    (entry) => entry === "invoke:mark_presentation_controller_ready",
  ).length;
  process.stdout.write(JSON.stringify({ beforePlaybackListener, afterPlaybackListener }));
""",
            before_eval="""
emitStateDuringRegistration = true;
deferPlaybackListener = true;
""",
        )
        self.assertEqual(result["beforePlaybackListener"], 0)
        self.assertEqual(result["afterPlaybackListener"], 1)

    def test_non_tauri_controller_fails_closed(self):
        result = self.run_node(
            """
  process.stdout.write(JSON.stringify({
    unavailableVisible: !elements["controller-unavailable"].classList.contains("hidden"),
    controlsDisabled: commandIds.every((id) => elements[id].disabled),
    exitDisabled: elements["controller-exit"].disabled,
  }));
""",
            with_tauri=False,
        )
        self.assertEqual(
            result,
            {"unavailableVisible": True, "controlsDisabled": True, "exitDisabled": True},
        )

    def test_controller_readiness_failure_is_visible_and_fails_closed(self):
        result = self.run_node(
            """
  process.stdout.write(JSON.stringify({
    error: elements["controller-error"].textContent,
    unavailableVisible: !elements["controller-unavailable"].classList.contains("hidden"),
    controlsDisabled: commandIds.every((id) => elements[id].disabled),
    readyAttempts: trace.filter(
      (entry) => entry === "invoke:mark_presentation_controller_ready",
    ).length,
  }));
""",
            before_eval="rejectControllerReady = true;",
        )
        self.assertEqual(result["error"], "controller readiness rejected")
        self.assertTrue(result["unavailableVisible"])
        self.assertTrue(result["controlsDisabled"])
        self.assertEqual(result["readyAttempts"], 1)


if __name__ == "__main__":
    unittest.main()
