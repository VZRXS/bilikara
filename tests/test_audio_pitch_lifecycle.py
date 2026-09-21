from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AudioPitchLifecycleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.app_source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.pitch_source = cls._slice(
            "function disposeAudioPitchProcessor", "function persistLocalVolumePreferences"
        )
        cls.snapshot_source = cls._slice(
            "function syncLocalPlayerSettingsFromSnapshot", "function markLocalVolumeWrite"
        )
        cls.teardown_source = (
            cls._slice(
                "function setHostPlaybackSessionPhase", "Object.defineProperty"
            )
            + cls._slice("function retireHostPlaybackSession", "function replaceHostPlayerView")
            + cls._slice("function teardownMountedPlayer", "function activeLocalPlayerElements")
        )
        cls.reset_source = cls._slice(
            "async function resetPlayerState", "async function installAppUpdate"
        )

    @classmethod
    def _slice(cls, start: str, end: str) -> str:
        start_index = cls.app_source.index(start)
        return cls.app_source[start_index : cls.app_source.index(end, start_index)]

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            [
                self.node,
                "-e",
                f"(async () => {{\n{script}\n}})().catch((error) => {{ console.error(error); process.exit(1); }});",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    def test_adapter_and_host_pitch_lifecycle(self):
        completed = subprocess.run(
            [self.node, str(ROOT / "tests" / "audio_pitch_lifecycle.cjs")],
            capture_output=True, text=True, timeout=20, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(result["live"], 0)
        self.assertEqual(result["cases"], 12)

    def test_retired_element_graph_cleanup_preserves_current_graph_and_shared_context(self):
        result = self.run_node(
            f"""
const disconnected = [];
const disposed = [];
function graphAudio(name) {{
  return {{
    name,
    paused: false,
    bilikaraPitch: {{ dispose() {{ disposed.push(name); }} }},
    bilikaraPitchSource: {{ disconnect() {{ disconnected.push(name); }} }},
    bilikaraPitchRoute: "processor",
    pause() {{ this.paused = true; }},
    removeAttribute() {{}},
    load() {{}},
  }};
}}
function media(name) {{
  return {{
    name,
    paused: false,
    pause() {{ this.paused = true; }},
    removeAttribute() {{}},
    load() {{}},
  }};
}}
const audioA = graphAudio("A");
const audioB = graphAudio("B");
const sessionA = {{ phase: "playing", video: media("video-A"), audio: audioA, eventCleanups: [] }};
const sessionB = {{ phase: "playing", video: media("video-B"), audio: audioB, eventCleanups: [] }};
const sharedContext = {{ state: "running" }};
const state = {{
  hostPlaybackSession: sessionB,
  audioContext: sharedContext,
  localWebKitStartRetryDone: false,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localPlaybackStartState: "established",
  localPlaybackStartGeneration: 1,
  localPlaybackStartPromisesSettled: true,
  localPlaybackEndHandled: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
}};
function clearLocalPlayerEventListeners() {{}}
function clearWebKitAudioStarvationTimer() {{}}
function clearLocalPlayerSyncTimer() {{}}
function clearPlayerFrameClickTimer() {{}}
function clearLocalPlayerSeekState() {{}}
function clearLocalPlayerControlsHideTimer() {{}}
function clearTauriMediaSessionState() {{}}
function clearLocalAdvanceDelay() {{}}
{self.pitch_source}
{self.teardown_source}
const retiredOld = retireHostPlaybackSession(sessionA);
const afterOld = {{
  retiredOld,
  currentPreserved: state.hostPlaybackSession === sessionB,
  currentSourcePreserved: Boolean(audioB.bilikaraPitchSource),
  currentProcessorPreserved: Boolean(audioB.bilikaraPitch),
  contextPreserved: state.audioContext === sharedContext,
  disposed: [...disposed],
  disconnected: [...disconnected],
}};
const retiredCurrent = retireHostPlaybackSession(sessionB);
console.log(JSON.stringify({{
  afterOld,
  retiredCurrent,
  pointerCleared: state.hostPlaybackSession === null,
  contextPreserved: state.audioContext === sharedContext,
  disposed,
  disconnected,
}}));
"""
        )
        self.assertEqual(
            result["afterOld"],
            {
                "retiredOld": True,
                "currentPreserved": True,
                "currentSourcePreserved": True,
                "currentProcessorPreserved": True,
                "contextPreserved": True,
                "disposed": ["A"],
                "disconnected": ["A"],
            },
        )
        self.assertTrue(result["retiredCurrent"])
        self.assertTrue(result["pointerCleared"])
        self.assertTrue(result["contextPreserved"])
        self.assertEqual(result["disposed"], ["A", "B"])
        self.assertEqual(result["disconnected"], ["A", "B"])
