from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PresentationRendererTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.module = ROOT / "static" / "presentation-renderer.js"
        cls.source = cls.module.read_text(encoding="utf-8")

    def run_renderer(self) -> dict:
        script = f"""
class ClassList {{
  constructor(node) {{ this.node = node; this.values = new Set(); }}
  add(...names) {{ names.forEach((name) => this.values.add(name)); this.sync(); }}
  remove(...names) {{ names.forEach((name) => this.values.delete(name)); this.sync(); }}
  toggle(name, force) {{
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    this.sync();
    return this.values.has(name);
  }}
  contains(name) {{ return this.values.has(name); }}
  sync() {{ this.node._className = [...this.values].join(" "); }}
}}
class Node {{
  constructor(tagName, text = "") {{
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {{}};
    this.dataset = {{}};
    this.textContent = text;
    this._className = "";
    this.classList = new ClassList(this);
    this.style = {{ values: {{}}, setProperty: (key, value) => {{ this.style.values[key] = value; }} }};
  }}
  set className(value) {{
    this._className = String(value);
    this.classList.values = new Set(this._className.split(/\\s+/).filter(Boolean));
  }}
  get className() {{ return this._className; }}
  setAttribute(name, value) {{
    this.attributes[name] = String(value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) {{
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }}
  }}
  append(...nodes) {{ nodes.forEach((node) => this.appendChild(node)); }}
  appendChild(node) {{ node.parentNode = this; this.children.push(node); return node; }}
  replaceChildren(...nodes) {{
    this.children.forEach((node) => {{ node.parentNode = null; }});
    this.children = [];
    this.append(...nodes);
  }}
  querySelector(selector) {{
    const match = (node) => {{
      if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
      const data = selector.match(/^\\[data-([^\\]]+)\\]$/);
      return data ? Object.hasOwn(node.attributes, `data-${{data[1]}}`) : false;
    }};
    const visit = (node) => {{
      for (const child of node.children) {{
        if (match(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }}
      return null;
    }};
    return visit(this);
  }}
}}
global.document = {{
  createElement: (tag) => new Node(tag),
  createElementNS: (_namespace, tag) => new Node(tag),
  createTextNode: (value) => new Node("#text", String(value)),
}};
const renderer = require({json.dumps(str(self.module))});
const root = new Node("div");
const video = new Node("video");
video.src = "media/video.mp4";
const audio = new Node("audio");
audio.src = "media/audio.m4a";
root.append(video, audio);
const scene = {{
  generation: 3,
  revision: 8,
  currentItemIdentity: "item-1",
  title: "<img src=x onerror=alert(1)>",
  overlay: {{
    visible: true,
    heading: "Next",
    deadline: 2000,
    durationMs: 2000,
    title: "<script>bad()</script>",
    requester: "Alice & Bob",
    duration: "3:00",
    queueHeading: "Queue",
    rows: [{{ title: "Song", requester: "Carol", duration: "2:00" }}],
    totalText: "2 songs",
  }},
}};
const first = renderer.renderScene(root, scene, {{ now: 1000 }});
const second = renderer.renderScene(root, {{ ...scene, revision: 9 }}, {{ now: 1500 }});
process.stdout.write(JSON.stringify({{
  videoPreserved: root.children[0] === video && video.src === "media/video.mp4",
  audioPreserved: root.children[1] === audio && audio.src === "media/audio.m4a",
  overlayReused: first === second,
  overlayCount: root.children.filter((node) => node.classList.contains("player-delay-overlay")).length,
  titleText: second.querySelector("[data-delay-next-title]").textContent,
  childTags: root.children.map((node) => node.tagName),
  generation: root.dataset.presentationGeneration,
  revision: root.dataset.presentationRevision,
}}));
"""
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

    def test_rendering_reuses_overlay_and_preserves_host_media_identity(self):
        result = self.run_renderer()
        self.assertTrue(result["videoPreserved"])
        self.assertTrue(result["audioPreserved"])
        self.assertTrue(result["overlayReused"])
        self.assertEqual(result["overlayCount"], 1)
        self.assertEqual(result["childTags"][:2], ["VIDEO", "AUDIO"])
        self.assertEqual(result["generation"], "3")
        self.assertEqual(result["revision"], "9")

    def test_user_content_is_assigned_as_text(self):
        result = self.run_renderer()
        self.assertEqual(result["titleText"], "<script>bad()</script>")
        self.assertNotIn("innerHTML", self.source)

    def test_renderer_never_constructs_or_synchronizes_media(self):
        for forbidden in (
            'createElement("video")',
            'createElement("audio")',
            "BroadcastChannel",
            "localStorage",
            "playbackRate",
            "drift",
            "currentTime",
            "mountMedia",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
