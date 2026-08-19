from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PresentationSceneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.module = ROOT / "static" / "presentation-scene.js"
        cls.source = cls.module.read_text(encoding="utf-8")

    def call(self, expression: str) -> object:
        script = f"""
const scene = require({json.dumps(str(self.module))});
const result = {expression};
process.stdout.write(JSON.stringify(result));
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

    def test_scene_normalizes_only_audience_visual_state(self):
        result = self.call(
            """
scene.normalizePresentationScene({
  generation: 7.8,
  revision: -4,
  currentItemIdentity: 123,
  title: "<b>Audience title</b>",
  displayMetadata: { requester: "Alice", duration: 90, detail: "UP" },
  theme: "unknown",
  videoUrl: "https://forbidden.invalid/video.mp4",
  currentTime: 21,
  playbackRate: 1.2,
  drift: 500,
  transport: "broadcast",
  overlay: { visible: true, rows: [] },
})
"""
        )
        self.assertEqual(
            set(result),
            {
                "generation",
                "revision",
                "currentItemIdentity",
                "title",
                "displayMetadata",
                "theme",
                "overlay",
            },
        )
        self.assertEqual(result["generation"], 7)
        self.assertEqual(result["revision"], 0)
        self.assertEqual(result["currentItemIdentity"], "123")
        self.assertEqual(result["title"], "<b>Audience title</b>")
        self.assertEqual(result["theme"], "light")
        for forbidden in (
            "videoUrl",
            "audioUrl",
            "currentTime",
            "predictedTime",
            "playbackRate",
            "drift",
            "seek",
            "transport",
        ):
            self.assertNotIn(forbidden, result)

    def test_overlay_is_bounded_to_five_safe_rows(self):
        result = self.call(
            """
scene.normalizeOverlay({
  visible: 1,
  heading: 55,
  deadline: -10,
  durationMs: "2500",
  rows: Array.from({ length: 8 }, (_, index) => ({
    title: `Song ${index}`,
    requester: index,
    duration: null,
    mediaUrl: "forbidden",
  })),
})
"""
        )
        self.assertTrue(result["visible"])
        self.assertEqual(result["heading"], "55")
        self.assertEqual(result["deadline"], 0)
        self.assertEqual(result["durationMs"], 2500)
        self.assertEqual(len(result["rows"]), 5)
        self.assertEqual(result["rows"][4]["title"], "Song 4")
        self.assertEqual(set(result["rows"][0]), {"title", "requester", "duration"})

    def test_module_contains_no_playback_transport_or_follower_clock(self):
        for forbidden in (
            "BroadcastChannel",
            "localStorage",
            "playbackRate",
            "predictedTime",
            "driftMs",
            "videoUrl",
            "audioUrl",
        ):
            self.assertNotIn(forbidden, self.source)


if __name__ == "__main__":
    unittest.main()
