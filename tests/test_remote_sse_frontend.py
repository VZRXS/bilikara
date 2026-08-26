from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemoteSseFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        source = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.source = source
        start = source.index("function clearEventStreamReconnectTimer")
        end = source.index("function connectStateStream", start)
        cls.reconnect_source = source[start:end]
        start = source.index("function currentPlaybackClockSeconds")
        end = source.index("function flushPendingAutoRating", start)
        cls.clock_value_source = source[start:end]
        start = source.index("function currentPlayerStatus")
        end = source.index("function durationSecondsForItem", start)
        cls.current_status_source = source[start:end]
        start = source.index("function formatPlaybackClockSeconds")
        end = source.index("function formatBytes", start)
        cls.clock_render_source = source[start:end]
        start = source.index("function applyStateSnapshot")
        end = source.index("function clearEventStreamReconnectTimer", start)
        cls.apply_snapshot_source = source[start:end]

    def run_node(self, body: str) -> dict:
        script = f"""
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
{self.reconnect_source}
{body}
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

    def test_reconnect_jitter_is_bounded_and_never_subsecond(self):
        result = self.run_node(
            """
console.log(JSON.stringify({
  initial: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(1000, value)),
  middle: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(4000, value)),
  capped: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(15000, value)),
}));
"""
        )
        self.assertEqual(result["initial"], [1000, 1125, 1250])
        self.assertEqual(result["middle"], [4000, 4400, 4800])
        self.assertEqual(result["capped"], [12000, 13500, 15000])
        self.assertGreaterEqual(min(result["initial"] + result["middle"] + result["capped"]), 1000)
        self.assertLessEqual(max(result["initial"] + result["middle"] + result["capped"]), 15000)

    def test_scheduler_jitters_each_attempt_but_doubles_only_base_delay(self):
        result = self.run_node(
            """
const delays = [];
const callbacks = new Map();
const cleared = [];
let nextTimerId = 1;
let connectCalls = 0;
const randomValues = [0.4, 0.75];
Math.random = () => randomValues.shift();
const state = { eventStreamRetryMs: 1000, eventStreamReconnectTimer: null };
const window = {
  setTimeout(callback, delayMs) {
    const timerId = nextTimerId++;
    callbacks.set(timerId, callback);
    delays.push(delayMs);
    return timerId;
  },
  clearTimeout(timerId) {
    callbacks.delete(timerId);
    cleared.push(timerId);
  },
};
function connectStateStream() { connectCalls += 1; }
scheduleEventStreamReconnect();
const firstNextBase = state.eventStreamRetryMs;
scheduleEventStreamReconnect();
const secondTimerId = state.eventStreamReconnectTimer;
const secondNextBase = state.eventStreamRetryMs;
callbacks.get(secondTimerId)();
console.log(JSON.stringify({
  delays,
  cleared,
  firstNextBase,
  secondNextBase,
  connectCalls,
  activeTimer: state.eventStreamReconnectTimer,
}));
"""
        )
        self.assertEqual(
            result,
            {
                "delays": [1100, 2300],
                "cleared": [1],
                "firstNextBase": 2000,
                "secondNextBase": 4000,
                "connectCalls": 1,
                "activeTimer": None,
            },
        )

    def test_cache_polling_uses_the_revision_guard(self):
        start = self.source.index("async function refreshCacheStatusOnly")
        end = self.source.index("function currentStateRevision", start)
        polling_source = self.source[start:end]

        self.assertIn("applyStateSnapshot(payload.data);", polling_source)
        self.assertNotIn("state.data = payload.data", polling_source)

    def test_player_status_and_clock_fail_closed_by_playback_generation(self):
        script = f"""
let nowMs = 1000;
Date.now = () => nowMs;
let nextTimerId = 1;
const activeIntervals = new Set();
const window = {{
  setInterval(_callback, _delayMs) {{
    const timerId = nextTimerId++;
    activeIntervals.add(timerId);
    return timerId;
  }},
  clearInterval(timerId) {{ activeIntervals.delete(timerId); }},
}};
const state = {{
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlStatusSync: null,
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
}};
const clockText = {{ textContent: "" }};
const elements = {{
  currentCacheState: {{
    textContent: "",
    querySelector() {{ return clockText; }},
  }},
}};
function currentStateRevision(snapshot) {{ return Number(snapshot?.state_revision || 0); }}
function renderSignatureForSnapshot(snapshot) {{
  return JSON.stringify({{
    playback_generation: snapshot?.playback_generation,
    current_item: snapshot?.current_item,
  }});
}}
function syncRemoteIdentityWithSnapshot() {{}}
function scheduleFavlistBrowseReloadFromState() {{}}
function scheduleRender() {{}}
function renderCacheStatusOnly() {{}}
function durationSecondsForItem(item) {{ return Number(item?.duration || 0); }}
function playerControlStatusSyncPending() {{ return false; }}
function clearPlayerControlStatusSync() {{}}
function syncCurrentCacheState() {{}}
function maybeUpdateRemoteRatingPrompt() {{}}
console.warn = () => {{}};
{self.clock_value_source}
{self.current_status_source}
{self.clock_render_source}
{self.apply_snapshot_source}
function snapshot(revision, generation, status, extra = {{}}) {{
  return {{
    state_revision: revision,
    playback_generation: generation,
    playback_program: {{
      item_id: "song-a",
      item_incarnation_id: `i-${{generation}}`,
      selected_audio_variant_id: "instrumental",
      artifact_set_id: `a-${{generation}}`,
    }},
    current_item: {{ id: "song-a", cache_status: "ready", duration: 100 }},
    player_status: status,
    ...extra,
  }};
}}
function status(generation, currentTime) {{
  return {{
    playback_generation: generation,
    item_id: "song-a",
    observed_phase: "playing",
    is_paused: false,
    current_time: currentTime,
    duration: 100,
    updated_at: generation * 100,
  }};
}}

const first = snapshot(1, 1, status(1, 10));
const acceptedFirst = applyStateSnapshot(first);
renderCurrentPlaybackState(state.data.current_item);
const firstTimer = state.currentPlaybackClockTimer;
const matchingFirst = currentPlayerStatus(state.data.current_item);

const sameProgram = snapshot(2, 1, status(1, 10), {{ python_only: "changed" }});
const acceptedSame = applyStateSnapshot(sameProgram);
const retainedTimer = state.currentPlaybackClockTimer;
const sameProgramRetained = firstTimer === retainedTimer && activeIntervals.has(firstTimer);

const mismatched = snapshot(3, 2, status(1, 80));
const acceptedMismatch = applyStateSnapshot(mismatched);
const mismatchResult = {{
  currentStatus: currentPlayerStatus(state.data.current_item),
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
}};

const replacement = snapshot(4, 2, status(2, 3));
const acceptedReplacement = applyStateSnapshot(replacement);
renderCurrentPlaybackState(state.data.current_item);
const replacementResult = {{
  generation: currentPlayerStatus(state.data.current_item)?.playback_generation,
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
}};

const inverseAccepted = applyStateSnapshot(snapshot(3, 1, status(1, 90)));
console.log(JSON.stringify({{
  acceptedFirst,
  matchingFirstGeneration: matchingFirst?.playback_generation,
  acceptedSame,
  sameProgramRetained,
  acceptedMismatch,
  mismatchResult,
  acceptedReplacement,
  replacementResult,
  inverseAccepted,
  finalGeneration: state.data.playback_generation,
}}));
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
        result = json.loads(completed.stdout)
        self.assertTrue(result["acceptedFirst"])
        self.assertEqual(result["matchingFirstGeneration"], 1)
        self.assertTrue(result["acceptedSame"])
        self.assertTrue(result["sameProgramRetained"], result)
        self.assertTrue(result["acceptedMismatch"])
        self.assertEqual(
            result["mismatchResult"],
            {"currentStatus": None, "timer": None, "paused": True, "base": 0},
        )
        self.assertTrue(result["acceptedReplacement"])
        self.assertEqual(result["replacementResult"]["generation"], 2)
        self.assertIsNotNone(result["replacementResult"]["timer"])
        self.assertFalse(result["replacementResult"]["paused"])
        self.assertEqual(result["replacementResult"]["base"], 3)
        self.assertFalse(result["inverseAccepted"])
        self.assertEqual(result["finalGeneration"], 2)


if __name__ == "__main__":
    unittest.main()
