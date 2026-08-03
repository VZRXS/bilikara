from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from bilikara.rust_backend import try_apply_av_delay_action
from bilikara.store import _py_apply_av_delay_action


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
        cls.audio_canplay_source = cls._slice(
            "function handleSplitAudioCanPlay", "function renderPlayer"
        )

    @classmethod
    def _slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_node(self, body: str, *sources: str) -> dict:
        script = f"""
const state = {{
  localPlayerRequestedRate: 1,
  localPlayerMountId: 1,
  localSplitSyncCorrectionToken: 0,
  localSplitSyncCorrectionState: "idle",
  localSplitSyncCorrectionContext: null,
  localSplitSyncDecisionReason: "",
  localSplitSyncSuppressionReason: "",
  localSplitSyncSeekThresholdUsed: 0,
  localSplitSyncCorrectionTarget: null,
  localSplitSyncAudioPausedForRecovery: false,
  localSplitSyncIntentWillBeRestored: false,
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
  localTerminalAudioError: null,
  localPlayerSyncTimer: null,
  localPlayerStartupTimer: null,
  localPlayerEventCleanups: [],
}};
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerSyncSeekCooldownMs = 750;
const localPlayerSyncDiagnosticThrottleMs = 1000;
let nowMs = 1000;
Date.now = () => nowMs;
const actions = [];
let heldItemId = "";
function syncSplitPlayerVolumeFromVideo() {{}}
function persistLocalVolumePreferences() {{}}
function renderVolumeControls() {{}}
function frontendPlaybackMode() {{ return "split"; }}
function isSplitPlayerSeekSettling() {{ return false; }}
function clearLocalPlayerSyncTimer() {{
  if (state.localPlayerSyncTimer) {{
    clearInterval(state.localPlayerSyncTimer);
    state.localPlayerSyncTimer = null;
  }}
}}
function clearLocalPlayerStartupTimer() {{
  if (state.localPlayerStartupTimer) {{
    clearTimeout(state.localPlayerStartupTimer);
    state.localPlayerStartupTimer = null;
  }}
}}
const elements = {{
  playerDelayOverlay: {{ hidden: true }},
  playerFrame: {{ querySelector() {{ return null; }}, querySelectorAll() {{ return []; }} }},
}};
globalThis.document = global.document = {{ querySelectorAll() {{ return []; }} }};
var document = globalThis.document;
function clearLocalPlayerSeekState() {{}}
function clearLocalPlayerControlsHideTimer() {{}}
function apiPost(path, body) {{
  if (body?.event) {{
    actions.push(body.event);
  }}
  return Promise.resolve({{}});
}}
function setAppMessage() {{}}
function t(key) {{ return key; }}
function clearLocalPlayerEventListeners() {{
  if (Array.isArray(state.localPlayerEventCleanups)) {{
    state.localPlayerEventCleanups.forEach((cleanup) => cleanup());
    state.localPlayerEventCleanups = [];
  }}
}}
function currentItemIdFromData() {{
  return state.data?.current_item?.id || "";
}}
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
function seekSlaveVideo(video, targetTime) {{ video.currentTime = targetTime; return true; }}
function playMediaBestEffort(media) {{ if (media) media.paused = false; return Promise.resolve(); }}
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
    this.dataset = {{
      playerItemId: "item",
      playerMountId: "1",
      mediaRevision: "rev-1",
      audioVariantId: "default",
    }};
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.seekWrites = 0;
    this.listeners = {{}};
  }}
  get currentTime() {{ return this._time; }}
  set currentTime(value) {{ this._time = Number(value); this.seekWrites += 1; }}
  play() {{ this.paused = false; this.playCalls += 1; return Promise.resolve(); }}
  pause() {{ this.paused = true; this.pauseCalls += 1; }}
  addEventListener(event, handler) {{
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }}
  removeEventListener(event, handler) {{
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(h => h !== handler);
  }}
  dispatchEvent(eventObj) {{
    const type = typeof eventObj === "string" ? eventObj : eventObj?.type;
    const handlers = (this.listeners[type] || []).slice();
    for (const h of handlers) {{
      h({{ target: this, type }});
    }}
  }}
}}
if (typeof cancelSplitPlayerSyncCorrection !== "function") {{
  function cancelSplitPlayerSyncCorrection(reason = "cancelled") {{
    state.localSplitSyncCorrectionState = "idle";
    state.localSplitSyncCorrectionContext = null;
    state.localSplitSyncCorrectionTarget = null;
    state.localSplitSyncSuppressionReason = reason;
  }}
}}
if (typeof getSplitPlayerContextIdentity !== "function") {{
  function getSplitPlayerContextIdentity(video, audio) {{
    return {{
      mountId: Number(video?.dataset?.playerMountId || audio?.dataset?.playerMountId || state.localPlayerMountId || 0),
      itemId: String(video?.dataset?.playerItemId || audio?.dataset?.playerItemId || ""),
      mediaRevision: String(video?.dataset?.mediaRevision || audio?.dataset?.mediaRevision || ""),
      audioVariantId: String(video?.dataset?.audioVariantId || audio?.dataset?.audioVariantId || ""),
    }};
  }}
}}
{''.join(sources)}
(async () => {{
{body}
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
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
delete video.dataset.bilikaraInternalSeek;
state.localSplitSyncCorrectionState = "completed";
state.localSplitSyncCorrectionContext = null;
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

    def test_exact_diagnostic_trace_replay(self):
        result = self.run_node(
            """
const video = new FakeMedia(79.652896); const audio = new FakeMedia(80.010667);
video.paused = false; audio.paused = false;
const actionA = syncSplitPlayer(video, audio, 0.0, false);
video.seeking = true; audio._time = 80.069333;
const actionC = syncSplitPlayer(video, audio, 0.0, false);
video.seeking = false; video._time = 80.069913; audio._time = 80.101333;
state.localSplitSyncCorrectionState = "stabilizing";
const actionD = syncSplitPlayer(video, audio, 0.0, false);
console.log(JSON.stringify({ actionA, actionC, actionD, seekWrites: video.seekWrites, correctionState: state.localSplitSyncCorrectionState }));
""",
            self.sync_source,
        )
        self.assertEqual(result["actionA"], "seek")
        self.assertEqual(result["actionC"], "defer-video-recovery")
        self.assertEqual(result["actionD"], "resume")
        self.assertEqual(result["seekWrites"], 1)

    def test_one_initial_hard_seek_followed_by_residual_drift(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
const firstAction = syncSplitPlayer(video, audio, 0, false);
video.seeking = false; video._time = 10.0; audio._time = 10.05;
state.localSplitSyncCorrectionState = "stabilizing";
const secondAction = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ firstAction, secondAction, seekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["firstAction"], "seek")
        self.assertEqual(result["secondAction"], "resume")
        self.assertEqual(result["seekWrites"], 1)

    def test_no_second_hard_seek_while_first_correction_active(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
const action1 = syncSplitPlayer(video, audio, 0, false);
const action2 = syncSplitPlayer(video, audio, 0, false);
const action3 = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action1, action2, action3, seekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action1"], "defer-video-recovery")
        self.assertEqual(result["action2"], "defer-video-recovery")
        self.assertEqual(result["action3"], "defer-video-recovery")
        self.assertEqual(result["seekWrites"], 1)

    def test_audio_advancing_during_video_seek(self):
        result = self.run_node(
            """
const video = new FakeMedia(5); const audio = new FakeMedia(5);
video.paused = false; audio.paused = false;
audio._time = 5.0;
syncSplitPlayer(video, audio, 0.5, false);
audio._time = 5.2;
console.log(JSON.stringify({ audioPaused: audio.paused, audioTime: audio.currentTime, audioPauseCalls: audio.pauseCalls }));
""",
            self.sync_source,
        )
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["audioTime"], 5.2)
        self.assertEqual(result["audioPauseCalls"], 0)

    def test_waiting_canplay_seeked_lifecycle_flow(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
const stateSeeking = state.localSplitSyncCorrectionState;
video.readyState = 1; state.localVideoPlaybackBlocked = true;
syncSplitPlayer(video, audio, 0, false);
const stateWaiting = state.localSplitSyncCorrectionState;
video.readyState = 4; state.localVideoPlaybackBlocked = false; video.seeking = false;
state.localSplitSyncCorrectionState = "stabilizing";
syncSplitPlayer(video, audio, 0, false);
const stateCompleted = state.localSplitSyncCorrectionState;
console.log(JSON.stringify({ stateSeeking, stateWaiting, stateCompleted }));
""",
            self.sync_source,
        )
        self.assertEqual(result["stateSeeking"], "seeking")
        self.assertEqual(result["stateWaiting"], "waiting")
        self.assertEqual(result["stateCompleted"], "idle")

    def test_stale_callback_after_media_revision_change(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.dataset = { playerItemId: "item", playerMountId: "1", mediaRevision: "rev-1", audioVariantId: "default" };
syncSplitPlayer(video, audio, 0, false);
video.dataset.mediaRevision = "rev-2";
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, suppressionReason: state.localSplitSyncSuppressionReason }));
""",
            self.sync_source,
        )
        self.assertEqual(result["suppressionReason"], "stale_context")

    def test_stale_callback_after_player_remount(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.dataset = { playerItemId: "item", playerMountId: "1", mediaRevision: "rev-1", audioVariantId: "default" };
syncSplitPlayer(video, audio, 0, false);
video.dataset.playerMountId = "2";
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, suppressionReason: state.localSplitSyncSuppressionReason }));
""",
            self.sync_source,
        )
        self.assertEqual(result["suppressionReason"], "stale_context")

    def test_user_originated_seek_cancels_in_flight_correction(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
cancelSplitPlayerSyncCorrection("user-seek");
console.log(JSON.stringify({ correctionState: state.localSplitSyncCorrectionState, suppressionReason: state.localSplitSyncSuppressionReason }));
""",
            self.sync_source,
        )
        self.assertEqual(result["correctionState"], "idle")
        self.assertEqual(result["suppressionReason"], "user-seek")

    def test_paused_player_preserves_paused_intent(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
state.localShouldBePlaying = false; video.paused = true; audio.paused = true;
const action = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action, shouldPlay: state.localShouldBePlaying }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "pause")
        self.assertFalse(result["shouldPlay"])

    def test_playing_player_restores_playing_intent(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
state.localShouldBePlaying = true; video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
video.seeking = false; video._time = 10;
state.localSplitSyncCorrectionState = "stabilizing";
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, shouldPlay: state.localShouldBePlaying }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "resume")
        self.assertTrue(result["shouldPlay"])

    def test_no_ended_or_next_song_event_during_recovery(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ advances }));
""",
            self.sync_source,
        )
        self.assertEqual(result["advances"], 0)

    def test_video_ready_state_1_buffering_does_not_pause_healthy_audio(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; video.readyState = 1;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, audioPaused: audio.paused, audioPauseCalls: audio.pauseCalls }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "defer-video-recovery")
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["audioPauseCalls"], 0)

    def test_positive_zero_and_negative_av_delay(self):
        result = self.run_node(
            """
const v1 = new FakeMedia(0); const a1 = new FakeMedia(10);
v1.dataset.playerMountId = "1"; a1.dataset.playerMountId = "1";
const act1 = syncSplitPlayer(v1, a1, 0.5, true);
cancelSplitPlayerSyncCorrection("reset");
nowMs += 1000;

const v2 = new FakeMedia(0); const a2 = new FakeMedia(10);
v2.dataset.playerMountId = "2"; a2.dataset.playerMountId = "2";
const act2 = syncSplitPlayer(v2, a2, 0.0, true);
cancelSplitPlayerSyncCorrection("reset");
nowMs += 1000;

const v3 = new FakeMedia(0); const a3 = new FakeMedia(10);
v3.dataset.playerMountId = "3"; a3.dataset.playerMountId = "3";
const act3 = syncSplitPlayer(v3, a3, -0.5, true);
console.log(JSON.stringify({ target1: v1.currentTime, target2: v2.currentTime, target3: v3.currentTime }));
""",
            self.sync_source,
        )
        self.assertEqual(result["target1"], 10.5)
        self.assertEqual(result["target2"], 10.0)
        self.assertEqual(result["target3"], 9.5)

    def test_python_rust_av_delay_decision_equivalence(self):
        actions = [
            {"type": "snapshot"},
            {"type": "adjust", "delta_ms": 100},
            {"type": "adjust", "delta_ms": -200},
            {"type": "set_effective", "effective_delay_ms": 300},
            {"type": "set_persistent", "effective_delay_ms": 400},
            {"type": "reset_local"},
            {"type": "toggle_lock"},
        ]
        initial_state = {
            "global_delay_ms": 100,
            "local_delay_ms": 50,
            "locked": False,
        }
        for act in actions:
            py_res = _py_apply_av_delay_action(initial_state, act)
            rust_res = try_apply_av_delay_action(
                {"schema_version": 1, "state": initial_state, "action": act}
            )[1]
            if rust_res is not None:
                self.assertEqual(py_res, rust_res)

    def test_threshold_boundaries(self):
        result = self.run_node(
            """
const v1 = new FakeMedia(10.01); const a1 = new FakeMedia(10.0);
v1.dataset.playerMountId = "1"; a1.dataset.playerMountId = "1";
const act1 = syncSplitPlayer(v1, a1, 0, false);
cancelSplitPlayerSyncCorrection("reset");
nowMs += 1000;

const v2 = new FakeMedia(10.15); const a2 = new FakeMedia(10.0);
v2.dataset.playerMountId = "2"; a2.dataset.playerMountId = "2";
const act2 = syncSplitPlayer(v2, a2, 0, false);
cancelSplitPlayerSyncCorrection("reset");
nowMs += 1000;

const v3 = new FakeMedia(10.6); const a3 = new FakeMedia(10.0);
v3.dataset.playerMountId = "3"; a3.dataset.playerMountId = "3";
const act3 = syncSplitPlayer(v3, a3, 0, false);
console.log(JSON.stringify({ act1, act2, act3 }));
""",
            self.sync_source,
        )
        self.assertEqual(result["act1"], "none")
        self.assertEqual(result["act2"], "seek")
        self.assertEqual(result["act3"], "seek")

    def test_stabilizing_completes_with_moderate_residual_drift(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
// Video seek lands, but audio advanced in the meantime, leaving 60ms drift
video.seeking = false; video._time = 10.0; audio._time = 10.06;
state.localSplitSyncCorrectionState = "stabilizing";
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, state: state.localSplitSyncCorrectionState }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "resume")
        self.assertEqual(result["state"], "idle")

    def test_correction_timeout_prevents_permanent_state(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);
nowMs += 3500;
audio._time += 10.0; // Make drift large again so it seeks
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, state: state.localSplitSyncCorrectionState }));
""",
            self.sync_source,
        )
        # Should be cancelled, which sets it to idle, then triggers a seek due to drift
        self.assertNotEqual(result["state"], "requested")
        self.assertEqual(result["state"], "seeking")
        self.assertEqual(result["action"], "seek")

    def test_stale_callback_does_not_cancel_newer_correction(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
syncSplitPlayer(video, audio, 0, false);

state.localPlayerMountId = 2;
cancelSplitPlayerSyncCorrection("item-change");
nowMs += 1000; // bypass cooldown
const video2 = new FakeMedia(2); const audio2 = new FakeMedia(10);
video2.dataset.playerMountId = "2"; audio2.dataset.playerMountId = "2";
video2.paused = false; audio2.paused = false;
syncSplitPlayer(video2, audio2, 0, false);
const secondToken = state.localSplitSyncCorrectionContext.token;

const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, finalToken: state.localSplitSyncCorrectionContext?.token }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "defer-video-recovery")
        self.assertEqual(result["finalToken"], 2)

    def test_audio_canplay_uses_normal_sync(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
handleSplitAudioCanPlay(video, audio);
console.log(JSON.stringify({ forceSeek: canplayForceSeek, blocked: state.localAudioPlaybackBlocked }));
""",
            """
let canplayForceSeek = null;
function settleSplitPlayerSeek() { return false; }
function syncSplitPlayer(_video, _audio, _offset, forceSeek) { canplayForceSeek = forceSeek; }
""",
            self.audio_canplay_source,
        )
        self.assertFalse(result["forceSeek"])
        self.assertFalse(result["blocked"])

    def test_only_one_player_renderer_and_one_sync_interval_remain(self):
        self.assertEqual(self.source.count("function renderPlayer(currentItem, playbackMode)"), 1)
        renderer = self._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl")
        self.assertEqual(renderer.count("state.localPlayerSyncTimer = window.setInterval"), 1)
        self.assertIn("clearLocalPlayerEventListeners()", self.source)

    def test_terminal_audio_error_stops_sync_and_prevents_video_seeks(self):
        result = self.run_node(
            """
const video = new FakeMedia(3.6);
const audio = new FakeMedia(3.217992);
audio.error = { code: 4, message: "PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE: FFmpegDemuxer: PTS is not defined" };
audio.readyState = 4;
video.readyState = 4;

addMountedPlayerListener(audio, "error", (event) => handleTerminalAudioError(video, audio, event));
audio.dispatchEvent("error");

const seekWritesBeforeSync = video.seekWrites;
const action1 = syncSplitPlayer(video, audio, 0.2, false);
const action2 = syncSplitPlayer(video, audio, 0.2, true);
const seekWritesAfterSync = video.seekWrites;

// Simulate event callbacks firing after terminal error
audio.dispatchEvent("canplay");
audio.dispatchEvent("playing");
audio.dispatchEvent("waiting");
audio.dispatchEvent("stalled");
video.dispatchEvent("seeked");
const seekWritesAfterEvents = video.seekWrites;

console.log(JSON.stringify({
  action1,
  action2,
  seekWritesBeforeSync,
  seekWritesAfterSync,
  seekWritesAfterEvents,
  audioPaused: audio.paused,
  videoPaused: video.paused,
  terminalActive: Boolean(state.localTerminalAudioError),
  actions,
}));
""",
            self._slice("function addMountedPlayerListener", "function syncMountedLocalPlayer"),
        )
        self.assertEqual(result["action1"], "audio-terminal-error")
        self.assertEqual(result["action2"], "audio-terminal-error")
        self.assertEqual(result["seekWritesBeforeSync"], 0)
        self.assertEqual(result["seekWritesAfterSync"], 0)
        self.assertEqual(result["seekWritesAfterEvents"], 0)
        self.assertTrue(result["audioPaused"])
        self.assertTrue(result["videoPaused"])
        self.assertTrue(result["terminalActive"])
        self.assertIn("sync-audio-terminal-error", result["actions"])

    def test_stale_player_callbacks_do_not_poison_newer_mount(self):
        result = self.run_node(
            """
const videoA = new FakeMedia(3.2);
const audioA = new FakeMedia(3.2);
videoA.dataset.playerMountId = "1";
audioA.dataset.playerMountId = "1";

const videoB = new FakeMedia(5.0);
const audioB = new FakeMedia(4.8);
videoB.dataset.playerMountId = "2";
audioB.dataset.playerMountId = "2";

// Mount player A and register listeners
state.localPlayerMountId = 1;
addMountedPlayerListener(audioA, "error", (event) => handleTerminalAudioError(videoA, audioA, event));
addMountedPlayerListener(videoA, "canplay", () => syncSplitPlayer(videoA, audioA, 0.2));

// Teardown mount A (clears listeners & state)
teardownMountedPlayer();

// Mount player B
state.localPlayerMountId = 2;
addMountedPlayerListener(audioB, "error", (event) => handleTerminalAudioError(videoB, audioB, event));
addMountedPlayerListener(videoB, "canplay", () => syncSplitPlayer(videoB, audioB, 0.2));

// Dispatch delayed events on unmounted player A
audioA.error = { code: 4, message: "PTS is not defined" };
audioA.dispatchEvent("error");
audioA.dispatchEvent("canplay");
audioA.dispatchEvent("playing");
audioA.dispatchEvent("waiting");
videoA.dispatchEvent("seeked");

const syncB = syncSplitPlayer(videoB, audioB, 0.2, false);

console.log(JSON.stringify({
  syncB,
  audioBPaused: audioB.paused,
  terminalError: state.localTerminalAudioError,
}));
""",
            self._slice("function addMountedPlayerListener", "function syncMountedLocalPlayer"),
        )
        self.assertNotEqual(result["syncB"], "audio-terminal-error")
        self.assertIsNone(result["terminalError"])

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
