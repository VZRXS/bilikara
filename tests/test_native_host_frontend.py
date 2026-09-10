"""Regression contracts for the shared UI served by the native Host."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NativeHostFrontendTest(unittest.TestCase):
    def test_transition_waits_for_its_matching_media_mount(self):
        program = r'''
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync("static/app.js", "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const tail = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(start >= 0 && tail >= 0);
  return source.slice(start, start + 1 + tail);
}
const item = {id: "song"};
const data = {current_item: item};
const state = {data, pendingSongTransitionOverlayData: data, pendingSongTransitionGeneration: 7};
const calls = [];
const context = {state, currentItemIdFromData: d => d?.current_item?.id || "",
  selectedVideoUrlForItem: () => "video", selectedAudioUrlForItem: () => "audio",
  isCurrentHostPlaybackSession: s => Boolean(s?.video && s?.audio),
  showSongTransitionOverlayForData: (d, g) => calls.push(g)};
vm.createContext(context);
vm.runInContext(extract("flushPendingSongTransitionOverlay"), context);
context.flushPendingSongTransitionOverlay();
assert.equal(state.pendingSongTransitionOverlayData, data);
state.hostPlaybackSession = {video: {dataset: {playerItemId: "old"}}, audio: {}};
context.flushPendingSongTransitionOverlay();
assert.equal(state.pendingSongTransitionOverlayData, data);
state.hostPlaybackSession.video.dataset.playerItemId = "song";
context.flushPendingSongTransitionOverlay();
context.flushPendingSongTransitionOverlay();
assert.deepEqual(calls, [7]);
assert.equal(state.pendingSongTransitionOverlayData, null);
assert.equal(state.pendingSongTransitionGeneration, 0);
assert.match(extract("scheduleAcceptedHostPlaybackProgramReconciliation"),
  /renderPlayer\([\s\S]+flushPendingSongTransitionOverlay\(\)/);
'''
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required")
        result = subprocess.run([node, "-e", program], cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
