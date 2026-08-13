from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ListFlipFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        start = cls.source.index("function parseCssTimeMs")
        end = cls.source.index("function activeScrollableList", start)
        cls.flip_source = cls.source[start:end]

    def run_node(self, body: str) -> dict:
        script = """
const state = {
  listView: "queue",
  listStageView: "",
  listFlipTimer: null,
  listFlipFrame: null,
  listFlipGeneration: 0,
  listFlipTransitionCleanup: null,
};
const listFlipFallbackPaddingMs = 80;

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

class FakeInner {
  constructor() {
    this.transform = "matrix(1, 0, 0, 1, 0, 0)";
    this.transitionProperty = "transform";
    this.transitionDuration = "420ms";
    this.transitionDelay = "0s";
    this.listeners = new Map();
  }
  addEventListener(eventName, listener) {
    const listeners = this.listeners.get(eventName) || [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }
  removeEventListener(eventName, listener) {
    const listeners = this.listeners.get(eventName) || [];
    this.listeners.set(eventName, listeners.filter((candidate) => candidate !== listener));
  }
  dispatchTransitionEnd(propertyName = "transform") {
    for (const listener of [...(this.listeners.get("transitionend") || [])]) {
      listener({ target: this, propertyName });
    }
  }
}

const inner = new FakeInner();
const stage = {
  classList: new FakeClassList(),
  querySelector(selector) { return selector === ".list-stage-inner" ? inner : null; },
};
const elements = { listStage: stage };

function setClassToggle(element, className, enabled) {
  element?.classList.toggle(className, Boolean(enabled));
}

let nextCallbackId = 1;
const animationFrames = new Map();
const timers = new Map();
global.window = global;
window.requestAnimationFrame = (callback) => {
  const id = nextCallbackId++;
  animationFrames.set(id, callback);
  return id;
};
window.cancelAnimationFrame = (id) => animationFrames.delete(id);
window.setTimeout = (callback, delay) => {
  const id = nextCallbackId++;
  timers.set(id, { callback, delay });
  return id;
};
window.clearTimeout = (id) => timers.delete(id);
window.getComputedStyle = (element) => ({
  transform: element.transform,
  transitionProperty: element.transitionProperty,
  transitionDuration: element.transitionDuration,
  transitionDelay: element.transitionDelay,
});

function runNextFrame() {
  const entry = animationFrames.entries().next().value;
  if (!entry) throw new Error("no animation frame is pending");
  const [id, callback] = entry;
  animationFrames.delete(id);
  callback();
  return id;
}

function ownership() {
  return {
    front: stage.classList.contains("flip-show-front"),
    back: stage.classList.contains("flip-show-back"),
    flipping: stage.classList.contains("is-flipping"),
    history: stage.classList.contains("is-history-view"),
  };
}
""" + self.flip_source + """
(async () => {
""" + body + """
})().catch((error) => { console.error(error); process.exit(1); });
"""
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_initial_queue_render_has_one_face_and_no_animation_artifacts(self):
        result = self.run_node(
            """
syncListStageView();
console.log(JSON.stringify({
  ownership: ownership(),
  frames: animationFrames.size,
  timers: timers.size,
  transitionListeners: (inner.listeners.get("transitionend") || []).length,
}));
"""
        )
        self.assertEqual(
            result,
            {
                "ownership": {
                    "front": True,
                    "back": False,
                    "flipping": False,
                    "history": False,
                },
                "frames": 0,
                "timers": 0,
                "transitionListeners": 0,
            },
        )

    def test_queue_to_history_hands_face_ownership_over_at_midpoint(self):
        result = self.run_node(
            """
syncListStageView();
state.listView = "history";
syncListStageView();
const beforeAnimation = ownership();

inner.transform = "matrix(0.707, 0, 0, 1, 0, 0)";
runNextFrame();
const beforeMidpoint = ownership();

inner.transform = "matrix(0, 0, 0, 1, 0, 0)";
runNextFrame();
const atMidpoint = ownership();

inner.transform = "matrix(-0.5, 0, 0, 1, 0, 0)";
runNextFrame();
const afterMidpoint = ownership();

inner.dispatchTransitionEnd();
const afterTransition = ownership();
console.log(JSON.stringify({
  beforeAnimation,
  beforeMidpoint,
  atMidpoint,
  afterMidpoint,
  afterTransition,
  frames: animationFrames.size,
  timers: timers.size,
}));
"""
        )
        self.assertEqual(
            result["beforeAnimation"],
            {"front": True, "back": False, "flipping": True, "history": False},
        )
        self.assertEqual(
            result["beforeMidpoint"],
            {"front": True, "back": False, "flipping": True, "history": True},
        )
        self.assertEqual(
            result["atMidpoint"],
            {"front": False, "back": True, "flipping": True, "history": True},
        )
        self.assertEqual(
            result["afterMidpoint"],
            {"front": False, "back": True, "flipping": True, "history": True},
        )
        self.assertEqual(
            result["afterTransition"],
            {"front": False, "back": True, "flipping": False, "history": True},
        )
        self.assertEqual(result["frames"], 0)
        self.assertEqual(result["timers"], 0)

    def test_history_to_queue_uses_inverse_face_ownership(self):
        result = self.run_node(
            """
state.listView = "history";
inner.transform = "matrix(-1, 0, 0, 1, 0, 0)";
syncListStageView();
state.listView = "queue";
syncListStageView();
const beforeAnimation = ownership();

inner.transform = "matrix(-0.707, 0, 0, 1, 0, 0)";
runNextFrame();
const beforeMidpoint = ownership();

inner.transform = "matrix(0, 0, 0, 1, 0, 0)";
runNextFrame();
const atMidpoint = ownership();

inner.transform = "matrix(0.5, 0, 0, 1, 0, 0)";
runNextFrame();
const afterMidpoint = ownership();
inner.dispatchTransitionEnd("-webkit-transform");
const afterTransition = ownership();
console.log(JSON.stringify({ beforeAnimation, beforeMidpoint, atMidpoint, afterMidpoint, afterTransition }));
"""
        )
        self.assertEqual(
            result["beforeAnimation"],
            {"front": False, "back": True, "flipping": True, "history": True},
        )
        self.assertEqual(
            result["beforeMidpoint"],
            {"front": False, "back": True, "flipping": True, "history": False},
        )
        self.assertEqual(
            result["atMidpoint"],
            {"front": True, "back": False, "flipping": True, "history": False},
        )
        self.assertEqual(
            result["afterMidpoint"],
            {"front": True, "back": False, "flipping": True, "history": False},
        )
        self.assertEqual(
            result["afterTransition"],
            {"front": True, "back": False, "flipping": False, "history": False},
        )

    def test_rapid_reverse_ignores_stale_midpoint_and_cleanup_callbacks(self):
        result = self.run_node(
            """
syncListStageView();
state.listView = "history";
syncListStageView();
const staleTimer = [...timers.values()][0].callback;
inner.transform = "matrix(0.5, 0, 0, 1, 0, 0)";
runNextFrame();
inner.transform = "matrix(-0.5, 0, 0, 1, 0, 0)";
runNextFrame();
const staleMidpoint = [...animationFrames.values()][0];
const historyAfterMidpoint = ownership();

state.listView = "queue";
syncListStageView();
const reverseGeneration = state.listFlipGeneration;
const reverseFrame = state.listFlipFrame;
const reverseStart = ownership();

staleMidpoint();
staleTimer();
const afterStaleCallbacks = {
  ownership: ownership(),
  generation: state.listFlipGeneration,
  framePreserved: state.listFlipFrame === reverseFrame,
};

inner.transform = "matrix(-0.5, 0, 0, 1, 0, 0)";
runNextFrame();
inner.transform = "matrix(0.5, 0, 0, 1, 0, 0)";
runNextFrame();
inner.dispatchTransitionEnd();
console.log(JSON.stringify({
  historyAfterMidpoint,
  reverseStart,
  reverseGeneration,
  afterStaleCallbacks,
  final: ownership(),
}));
"""
        )
        self.assertEqual(
            result["historyAfterMidpoint"],
            {"front": False, "back": True, "flipping": True, "history": True},
        )
        self.assertEqual(
            result["reverseStart"],
            {"front": False, "back": True, "flipping": True, "history": True},
        )
        self.assertEqual(result["afterStaleCallbacks"]["generation"], result["reverseGeneration"])
        self.assertTrue(result["afterStaleCallbacks"]["framePreserved"])
        self.assertEqual(result["afterStaleCallbacks"]["ownership"], result["reverseStart"])
        self.assertEqual(
            result["final"],
            {"front": True, "back": False, "flipping": False, "history": False},
        )

    def test_transition_duration_drives_bounded_cleanup_fallback(self):
        result = self.run_node(
            """
syncListStageView();
state.listView = "history";
syncListStageView();
const fallback = [...timers.values()][0];
inner.transform = "matrix(-1, 0, 0, 1, 0, 0)";
fallback.callback();
console.log(JSON.stringify({ delay: fallback.delay, final: ownership() }));
"""
        )
        self.assertEqual(result["delay"], 500)
        self.assertEqual(
            result["final"],
            {"front": False, "back": True, "flipping": False, "history": True},
        )

    def test_css_uses_explicit_visibility_and_scoped_compositing(self):
        list_face_start = self.styles.index(".list-face {")
        list_face_end = self.styles.index(".queue-card-head h2", list_face_start)
        list_face_css = self.styles[list_face_start:list_face_end]
        self.assertIn("-webkit-backface-visibility: hidden", list_face_css)
        self.assertIn("visibility: hidden", list_face_css)
        self.assertIn(".list-stage.flip-show-front .list-face-front", list_face_css)
        self.assertIn(".list-stage.flip-show-back .list-face-back", list_face_css)
        self.assertIn("content-visibility: hidden", list_face_css)

        queue_current_start = self.styles.index(".queue-current {")
        queue_current_end = self.styles.index(".queue-current.hidden", queue_current_start)
        queue_current_css = self.styles[queue_current_start:queue_current_end]
        self.assertNotIn("translateZ(0)", queue_current_css)
        self.assertNotIn("will-change: transform", queue_current_css)

    def test_non_webkit_uses_the_same_visible_face_phases(self):
        result = self.run_node(
            """
global.navigator = { userAgent: "Mozilla/5.0 Chrome/120 Safari/537.36" };
syncListStageView();
state.listView = "history";
syncListStageView();
inner.transform = "matrix(0.25, 0, 0, 1, 0, 0)";
runNextFrame();
const frontPhase = ownership();
inner.transform = "matrix(-0.25, 0, 0, 1, 0, 0)";
runNextFrame();
const backPhase = ownership();
console.log(JSON.stringify({ frontPhase, backPhase }));
"""
        )
        self.assertTrue(result["frontPhase"]["front"])
        self.assertFalse(result["frontPhase"]["back"])
        self.assertFalse(result["backPhase"]["front"])
        self.assertTrue(result["backPhase"]["back"])


if __name__ == "__main__":
    unittest.main()
