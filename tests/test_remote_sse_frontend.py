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
        start = source.index("function clearEventStreamReconnectTimer")
        end = source.index("function connectStateStream", start)
        cls.reconnect_source = source[start:end]

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


if __name__ == "__main__":
    unittest.main()
