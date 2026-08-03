import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class HostMediaReleaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.release_source = source[
            source.index("function itemMediaRevision(") : source.index("function render()")
        ]

    def run_node(self, body: str) -> dict:
        script = f"""
const mediaReleaseAckMaxEntries = 128;
const mediaReleaseAckMaxAttempts = 5;
const timers = [];
const window = {{
  setTimeout(callback) {{ timers.push(callback); return timers.length; }},
  clearTimeout() {{}},
}};
function media(kind, revision = "rev-new") {{
  return {{
    kind,
    dataset: {{ playerItemId: "item-1", playerMountId: "7", mediaRevision: revision }},
    currentTime: 12.5,
    paused: false,
    pauseCalls: 0,
    loadCalls: 0,
    pause() {{ this.paused = true; this.pauseCalls += 1; }},
    load() {{ this.loadCalls += 1; }},
    removeAttribute(name) {{ if (name === "src") this.srcRemoved = true; }},
  }};
}}
const video = media("video");
const audio = media("audio");
const playerFrame = {{
  innerHTML: "mounted",
  querySelector(selector) {{
    if (selector.includes("video")) return video;
    if (selector.includes("audio")) return audio;
    return null;
  }},
}};
const elements = {{ playerFrame }};
const state = {{
  data: {{ current_item: {{ id: "item-1", media_revision: "rev-new" }}, media_release_request: null }},
  mediaReleaseAckEntries: new Map(),
  activeMediaReleaseRequest: null,
  pendingPlaybackRestore: null,
  localShouldBePlaying: true,
  playerSignature: "mounted",
  playerContext: {{ mounted: true }},
}};
let fetchCalls = 0;
const fetchResults = [];
function fetch() {{
  fetchCalls += 1;
  const next = fetchResults.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next || {{ ok: true, status: 200 }});
}}
function captureLocalPlayerPreferences() {{}}
function selectedAudioVariantForItem() {{ return {{ id: "default" }}; }}
function stopSplitPlayerSync() {{ state.syncStopped = true; }}

{self.release_source}

async function flushPromises() {{ await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }}
(async () => {{
  {body}
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_old_revision_request_acks_without_tearing_down_new_mount(self):
        result = self.run_node(
            """
const request = { request_id: "old-request", item_id: "item-1", media_revision: "rev-old" };
state.data.media_release_request = request;
handleMediaReleaseRequest(request);
await flushPromises();
console.log(JSON.stringify({
  fetchCalls,
  videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls,
  frame: playerFrame.innerHTML,
  teardown: state.activeMediaReleaseRequest.teardownPerformed,
}));
"""
        )
        self.assertEqual(result["fetchCalls"], 1)
        self.assertEqual(result["videoPauseCalls"], 0)
        self.assertEqual(result["audioPauseCalls"], 0)
        self.assertEqual(result["frame"], "mounted")
        self.assertFalse(result["teardown"])

    def test_matching_release_tears_down_once_and_retries_transient_ack(self):
        result = self.run_node(
            """
const request = { request_id: "current-request", item_id: "item-1", media_revision: "rev-new" };
state.data.media_release_request = request;
fetchResults.push({ ok: false, status: 503 }, { ok: true, status: 200 });
handleMediaReleaseRequest(request);
await flushPromises();
const retry = timers.shift();
retry();
await flushPromises();
handleMediaReleaseRequest(request);
await flushPromises();
console.log(JSON.stringify({
  fetchCalls,
  videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls,
  frame: playerFrame.innerHTML,
  ackStatus: state.mediaReleaseAckEntries.get("current-request").status,
  restorePlaying: state.pendingPlaybackRestore.wasPlaying,
}));
"""
        )
        self.assertEqual(result["fetchCalls"], 2)
        self.assertEqual(result["videoPauseCalls"], 1)
        self.assertEqual(result["audioPauseCalls"], 1)
        self.assertEqual(result["frame"], "")
        self.assertEqual(result["ackStatus"], "acknowledged")
        self.assertTrue(result["restorePlaying"])

    def test_release_timeout_clear_preserves_playback_restore_and_unlocks_renderer(self):
        result = self.run_node(
            """
const request = { request_id: "timeout-request", item_id: "item-1", media_revision: "rev-new" };
state.data.media_release_request = request;
handleMediaReleaseRequest(request);
await flushPromises();
state.data.media_release_request = null;
handleMediaReleaseRequest(null);
console.log(JSON.stringify({
  active: state.activeMediaReleaseRequest,
  restoreItem: state.pendingPlaybackRestore.itemId,
  restoreTime: state.pendingPlaybackRestore.currentTime,
  restorePlaying: state.pendingPlaybackRestore.wasPlaying,
  signature: state.playerSignature,
}));
"""
        )
        self.assertIsNone(result["active"])
        self.assertEqual(result["restoreItem"], "item-1")
        self.assertEqual(result["restoreTime"], 12.5)
        self.assertTrue(result["restorePlaying"])
        self.assertEqual(result["signature"], "")

    def test_ack_deduplication_is_bounded(self):
        result = self.run_node(
            """
for (let index = 0; index < 160; index += 1) {
  const request = { request_id: `request-${index}`, item_id: "other", media_revision: `rev-${index}` };
  state.data.media_release_request = request;
  handleMediaReleaseRequest(request);
  await flushPromises();
}
console.log(JSON.stringify({ size: state.mediaReleaseAckEntries.size, fetchCalls }));
"""
        )
        self.assertLessEqual(result["size"], 128)
        self.assertEqual(result["fetchCalls"], 160)


if __name__ == "__main__":
    unittest.main()
