from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SplitPlayerSyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.remote_source = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.sync_source = cls._slice("function pauseSlaveVideo", "function syncMountedLocalPlayer")
        cls.seek_source = cls._slice(
            "function syncSplitSeekAudioTarget", "function scheduleSplitPlayerSeekSettle"
        )
        cls.ended_source = cls._slice(
            "async function handleSplitVideoEnded", "function pauseSlaveVideo"
        )
        cls.lifecycle_source = cls._slice(
            "function clearLocalPlayerSyncTimer", "function clearLocalPlayerSeekState"
        )

    @classmethod
    def _slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_node(self, body: str, *sources: str) -> dict:
        script = f"""
const state = {{
  localPlayerRequestedRate: 1,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localShouldBePlaying: true,
  localPlaybackEndHandled: false,
  localSeekResumePending: false,
  localPlayerSyncTimer: null,
  localPlayerStartupTimer: null,
  localPlayerEventCleanups: [],
}};
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerSyncSeekCooldownMs = 750;
let nowMs = 1000;
Date.now = () => nowMs;
const actions = [];
let heldItemId = "";
function syncSplitPlayerVolumeFromVideo() {{}}
function isSplitPlayerSeekSettling() {{ return false; }}
function shouldHoldCurrentItemForTransition(item) {{
  const itemId = String(item?.id || item || "");
  return Boolean(itemId && itemId === heldItemId);
}}
function reportSplitSyncDiagnostic(itemId, video, audio, action) {{ actions.push(action); }}
function clampMediaTime(media, value) {{
  const lower = Math.max(0, Number(value || 0));
  return Number.isFinite(media.duration) ? Math.min(lower, media.duration) : lower;
}}
function setMediaCurrentTime(media, value, tolerance = localPlayerForceSyncEpsilonSeconds) {{
  const target = clampMediaTime(media, value);
  if (Math.abs(media.currentTime - target) <= tolerance) return false;
  media.currentTime = target;
  return true;
}}
function currentAvOffsetSeconds() {{ return 0.2; }}
function isActiveSplitPlayer() {{ return true; }}
function showMountedPlayerControls() {{}}
let advances = 0;
async function handleLocalPlaybackEnded() {{ advances += 1; }}
class FakeMedia {{
  constructor(time = 0) {{
    this._time = time;
    this.duration = 100;
    this.readyState = 4;
    this.networkState = 1;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.playbackRate = 1;
    this.volume = 1;
    this.muted = false;
    this.dataset = {{ playerItemId: "item" }};
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.seekWrites = 0;
  }}
  get currentTime() {{ return this._time; }}
  set currentTime(value) {{ this._time = Number(value); this.seekWrites += 1; }}
  play() {{ this.paused = false; this.playCalls += 1; return Promise.resolve(); }}
  pause() {{ this.paused = true; this.pauseCalls += 1; }}
}}
{''.join(sources)}
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

    def test_video_starvation_does_not_pause_healthy_audio(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; video.readyState = 1;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, audioPauseCalls: audio.pauseCalls, audioPaused: audio.paused }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "defer-video-recovery")
        self.assertEqual(result["audioPauseCalls"], 0)
        self.assertFalse(result["audioPaused"])

    def test_video_waiting_does_not_stop_audio_and_recovery_uses_audio_clock(self):
        result = self.run_node(
            """
const video = new FakeMedia(7); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
state.localVideoPlaybackBlocked = true;
const waitingAction = syncSplitPlayer(video, audio, 0.25, false);
state.localVideoPlaybackBlocked = false; nowMs += 1000;
const recoveryAction = syncSplitPlayer(video, audio, 0.25, true);
console.log(JSON.stringify({ waitingAction, recoveryAction, audioTime: audio.currentTime,
  videoTime: video.currentTime, audioPauseCalls: audio.pauseCalls }));
""",
            self.sync_source,
        )
        self.assertEqual(result["waitingAction"], "defer-video-recovery")
        self.assertEqual(result["recoveryAction"], "seek")
        self.assertEqual(result["audioTime"], 10)
        self.assertAlmostEqual(result["videoTime"], 10.25)
        self.assertEqual(result["audioPauseCalls"], 0)

    def test_internal_video_recovery_seek_does_not_pause_audio(self):
        result = self.run_node(
            """
const video = new FakeMedia(8); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; video.seeking = true;
video.dataset.bilikaraInternalSeek = "true";
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, audioPaused: audio.paused, audioPauseCalls: audio.pauseCalls }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "defer-video-recovery")
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["audioPauseCalls"], 0)

    def test_audio_waiting_holds_slave_video(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; state.localAudioPlaybackBlocked = true;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, videoPaused: video.paused, videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "wait-for-audio")
        self.assertTrue(result["videoPaused"])
        self.assertEqual(result["videoPauseCalls"], 1)
        self.assertEqual(result["audioPauseCalls"], 0)

    def test_transition_hold_prevents_any_audio_or_video_start(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.paused = false; audio.paused = false; heldItemId = "item";
const action = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action, shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "transition-hold")
        self.assertFalse(result["shouldPlay"])
        self.assertTrue(result["videoPaused"])
        self.assertTrue(result["audioPaused"])
        self.assertEqual(result["videoPlayCalls"], 0)
        self.assertEqual(result["audioPlayCalls"], 0)

    def test_positive_and_negative_delay_preserve_startup_boundaries(self):
        result = self.run_node(
            """
const positiveVideo = new FakeMedia(0); const positiveAudio = new FakeMedia(0);
const positiveAction = syncSplitPlayer(positiveVideo, positiveAudio, 0.4, true);
const negativeVideo = new FakeMedia(0); const negativeAudio = new FakeMedia(0);
const negativeAction = syncSplitPlayer(negativeVideo, negativeAudio, -0.4, true);
console.log(JSON.stringify({ positiveAction, positiveVideoTime: positiveVideo.currentTime,
  positiveAudioPaused: positiveAudio.paused, positiveVideoPlaying: !positiveVideo.paused,
  negativeAction, negativeVideoTime: negativeVideo.currentTime,
  negativeAudioPlaying: !negativeAudio.paused }));
""",
            self.sync_source,
        )
        self.assertEqual(result["positiveAction"], "start")
        self.assertEqual(result["positiveVideoTime"], 0)
        self.assertTrue(result["positiveAudioPaused"])
        self.assertTrue(result["positiveVideoPlaying"])
        self.assertEqual(result["negativeAction"], "start")
        self.assertEqual(result["negativeVideoTime"], 0)
        self.assertTrue(result["negativeAudioPlaying"])

    def test_video_timeline_seek_maps_to_audio_with_delay(self):
        result = self.run_node(
            """
const video = new FakeMedia(12); const audio = new FakeMedia(3);
const target = syncSplitSeekAudioTarget(video, audio);
console.log(JSON.stringify({ target, audioTime: audio.currentTime }));
""",
            self.seek_source,
        )
        self.assertAlmostEqual(result["target"], 11.8)
        self.assertAlmostEqual(result["audioTime"], 11.8)

    def test_requested_rate_is_preserved_without_internal_audio_nudging(self):
        result = self.run_node(
            """
const video = new FakeMedia(5); const audio = new FakeMedia(5);
video.paused = false; audio.paused = false; state.localPlayerRequestedRate = 1.25;
syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ videoRate: video.playbackRate, audioRate: audio.playbackRate }));
""",
            self.sync_source,
        )
        self.assertEqual(result, {"videoRate": 1.25, "audioRate": 1.25})

    def test_large_drift_seeks_only_video_and_cooldown_prevents_thrashing(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
const first = syncSplitPlayer(video, audio, 0.2, false);
video._time = 8; nowMs += 100;
const second = syncSplitPlayer(video, audio, 0.2, false);
console.log(JSON.stringify({ first, second, videoTime: video.currentTime,
  videoSeekWrites: video.seekWrites, audioTime: audio.currentTime, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["first"], "seek")
        self.assertEqual(result["second"], "none")
        self.assertEqual(result["videoSeekWrites"], 1)
        self.assertEqual(result["audioSeekWrites"], 0)
        self.assertEqual(result["audioTime"], 10)

    def test_video_end_does_not_truncate_audio_and_completion_advances_once(self):
        result = self.run_node(
            """
const video = new FakeMedia(100); const audio = new FakeMedia(95);
video.ended = true; video.paused = true; audio.paused = false;
const item = { id: "item" }; const report = () => {};
await handleSplitVideoEnded(item, video, audio, report);
const afterVideo = { advances, audioPaused: audio.paused };
audio.ended = true; audio.paused = true;
await handleSplitAudioEnded(item, video, audio, report);
await handleSplitAudioEnded(item, video, audio, report);
console.log(JSON.stringify({ afterVideo, advances }));
""",
            self.ended_source,
        )
        self.assertEqual(result["afterVideo"], {"advances": 0, "audioPaused": False})
        self.assertEqual(result["advances"], 1)

    def test_teardown_helpers_clear_timers_and_registered_listeners(self):
        result = self.run_node(
            """
let intervalClears = 0; let timeoutClears = 0; let listenerCleanups = 0;
global.window = { clearInterval() { intervalClears += 1; }, clearTimeout() { timeoutClears += 1; } };
state.localPlayerSyncTimer = 1; state.localPlayerStartupTimer = 2;
state.localPlayerEventCleanups.push(() => { listenerCleanups += 1; });
clearLocalPlayerSyncTimer(); clearLocalPlayerEventListeners();
console.log(JSON.stringify({ intervalClears, timeoutClears, listenerCleanups,
  syncTimer: state.localPlayerSyncTimer, startupTimer: state.localPlayerStartupTimer,
  cleanupCount: state.localPlayerEventCleanups.length }));
""",
            self.lifecycle_source,
        )
        self.assertEqual(result["intervalClears"], 1)
        self.assertEqual(result["timeoutClears"], 1)
        self.assertEqual(result["listenerCleanups"], 1)
        self.assertIsNone(result["syncTimer"])
        self.assertIsNone(result["startupTimer"])
        self.assertEqual(result["cleanupCount"], 0)

    def test_only_one_player_renderer_and_one_sync_interval_remain(self):
        self.assertEqual(self.source.count("function renderPlayer(currentItem, playbackMode)"), 1)
        renderer = self._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl")
        self.assertEqual(renderer.count("state.localPlayerSyncTimer = window.setInterval"), 1)
        self.assertIn("clearLocalPlayerEventListeners()", self.source)

    def test_frontend_has_no_duplicate_active_function_declarations(self):
        pattern = re.compile(r"^(?:async )?function ([A-Za-z0-9_]+)", re.MULTILINE)
        for name, source in (("host", self.source), ("remote", self.remote_source)):
            declarations = pattern.findall(source)
            duplicates = sorted(
                declaration for declaration in set(declarations) if declarations.count(declaration) > 1
            )
            self.assertEqual(duplicates, [], name)


if __name__ == "__main__":
    unittest.main()
