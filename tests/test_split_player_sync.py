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
        cls.sync_source = cls._slice("function holdVideoForAudio", "function syncMountedLocalPlayer")
        cls.seek_source = cls._slice(
            "function syncSplitSeekAudioTarget", "function scheduleSplitPlayerSeekSettle"
        )
        cls.seek_lifecycle_source = cls._slice(
            "function syncSplitSeekAudioTarget", "function mediaUrlBasename"
        )
        cls.clear_seek_source = cls._slice(
            "function clearLocalPlayerSeekState", "function playerDelayOverlay"
        )
        cls.offset_resync_source = cls._slice(
            "function syncMountedLocalPlayer", "function applyStoredVolumeToSinglePlayer"
        )
        cls.ended_source = cls._slice(
            "async function handleSplitVideoEnded", "function holdVideoForAudio"
        )
        cls.lifecycle_source = cls._slice(
            "function clearLocalPlayerSyncTimer", "function clearLocalPlayerSeekState"
        )
        cls.startup_source = cls._slice(
            "function createSplitPlayerStartupSynchronizer",
            "function renderPlayer",
        )
        cls.key_shift_action_source = cls._slice(
            "async function setLocalPlayerKeyShift",
            "function disposeAudioPitchProcessor",
        )
        cls.pitch_apply_source = cls._slice(
            "function applyKeyShiftToAudio",
            "function persistLocalVolumePreferences",
        )
        cls.video_seek_event_source = cls._slice(
            '  addMountedPlayerListener(video, "seeking",',
            '  addMountedPlayerListener(video, "canplay",',
        )
        cls.renderer_fast_path_source = (
            cls._slice(
                "function renderPlayer(currentItem, playbackMode)",
                "  const previousPlayerContext",
            )
            + "}\n"
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
  localSeekSettling: false,
  localSeekResumeAfterSettle: false,
  localSeekSettleStartedAt: 0,
  localSeekSettleTimer: null,
  localSeekSettleCallback: null,
  localPlayerSyncTimer: null,
  localPlayerStartupTimer: null,
  localPlayerEventCleanups: [],
}};
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerSyncSeekCooldownMs = 750;
const localPlayerSeekSettlePollMs = 50;
const localPlayerSeekSettleMaxMs = 1400;
let nowMs = 1000;
Date.now = () => nowMs;
const actions = [];
let heldItemId = "";
let mountedVideo = null;
let mountedAudio = null;
function activeLocalPlayerElements() {{ return {{ video: mountedVideo, audio: mountedAudio }}; }}
function syncSplitPlayerVolumeFromVideo() {{}}
function isSplitPlayerSeekSettling(video, audio) {{
  return state.localSeekSettling && isActiveSplitPlayer(video, audio);
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
let effectiveOffsetSeconds = 0.2;
function currentAvOffsetSeconds() {{ return effectiveOffsetSeconds; }}
function currentAvOffsetMs() {{ return effectiveOffsetSeconds * 1000; }}
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
    this.listeners = new Map();
  }}
  get currentTime() {{ return this._time; }}
  set currentTime(value) {{ this._time = Number(value); this.seekWrites += 1; }}
  addEventListener(eventName, listener) {{
    const listeners = this.listeners.get(eventName) || [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }}
  dispatchMediaEvent(eventName) {{
    for (const listener of this.listeners.get(eventName) || []) listener();
  }}
  play() {{ this.paused = false; this.playCalls += 1; return Promise.resolve(); }}
  pause() {{ this.paused = true; this.pauseCalls += 1; }}
}}
{''.join(sources)}
(async () => {{
{body}
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        return self.run_node_script(script)

    def run_node_script(self, script: str) -> dict:
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

    def test_video_starvation_pauses_audio_without_seeking_video(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; video.readyState = 1;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, audioPauseCalls: audio.pauseCalls, audioPaused: audio.paused,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "wait-for-video")
        self.assertEqual(result["audioPauseCalls"], 1)
        self.assertTrue(result["audioPaused"])
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)

    def test_video_recovery_realigns_audio_to_video_clock(self):
        result = self.run_node(
            """
const video = new FakeMedia(7); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
state.localVideoPlaybackBlocked = true;
const waitingAction = syncSplitPlayer(video, audio, 0.25, false);
state.localVideoPlaybackBlocked = false; nowMs += 1000;
const recoveryAction = syncSplitPlayer(video, audio, 0.25, true);
console.log(JSON.stringify({ waitingAction, recoveryAction, audioTime: audio.currentTime,
  videoTime: video.currentTime, audioPauseCalls: audio.pauseCalls,
  audioSeekWrites: audio.seekWrites, videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["waitingAction"], "wait-for-video")
        self.assertEqual(result["recoveryAction"], "audio-drift-correction")
        self.assertAlmostEqual(result["audioTime"], 6.75)
        self.assertEqual(result["videoTime"], 7)
        self.assertEqual(result["audioPauseCalls"], 1)
        self.assertEqual(result["audioSeekWrites"], 1)
        self.assertEqual(result["videoSeekWrites"], 0)

    def test_normal_sync_source_cannot_seek_video(self):
        sync_function = self._slice(
            "function syncSplitPlayer(video, audio, offsetSeconds",
            "function syncMountedLocalPlayer",
        )
        self.assertIn("setMediaCurrentTime(audio, targetAudioTime)", sync_function)
        self.assertNotIn("seekVideoForNavigation", sync_function)
        self.assertNotIn("setMediaCurrentTime(video", sync_function)

    def test_all_programmatic_video_writes_are_navigation_or_restore_paths(self):
        self.assertEqual(self.source.count("seekVideoForNavigation(video,"), 2)
        self.assertEqual(self.source.count("setMediaCurrentTime(video,"), 2)
        restore_call = self._slice("const maybeRestorePlayback = () =>", "const synchronizeStartupPlayer")
        remote_controls = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        self.assertIn('diagnosticAction: "restore-video-seek"', restore_call)
        self.assertIn('action === "seek-relative" || action === "seek-absolute"', remote_controls)
        self.assertIn('diagnosticAction: "manual-video-seek"', remote_controls)
        self.assertIn("setMediaCurrentTime(video, clampedNextTime)", remote_controls)

    def test_normal_drift_correction_seeks_audio_only(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(20);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0.2, false);
console.log(JSON.stringify({ action, videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "audio-drift-correction")
        self.assertEqual(result["videoTime"], 30)
        self.assertAlmostEqual(result["audioTime"], 29.8)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 1)

    def test_small_acceptable_drift_writes_neither_timeline(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(29.85);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0.2, false);
console.log(JSON.stringify({ action, videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "none")
        self.assertEqual(result["videoTime"], 30)
        self.assertEqual(result["audioTime"], 29.85)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)

    def test_effective_offset_echo_performs_exactly_one_audio_resync(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0.2;
const changed = resyncMountedLocalPlayerIfOffsetChanged(0);
const echoed = resyncMountedLocalPlayerIfOffsetChanged(200);
console.log(JSON.stringify({ changed, echoed, videoTime: video.currentTime,
  audioTime: audio.currentTime, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
            self.offset_resync_source,
        )
        self.assertEqual(
            result,
            {
                "changed": True,
                "echoed": False,
                "videoTime": 30,
                "audioTime": 29.8,
                "videoSeekWrites": 0,
                "audioSeekWrites": 1,
            },
        )

    def test_av_delay_change_while_playing_repositions_only_audio(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0.2;
const changed = resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ changed, settling: state.localSeekSettling,
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
            self.offset_resync_source,
        )
        self.assertEqual(
            result,
            {
                "changed": True,
                "settling": False,
                "videoTime": 30,
                "audioTime": 29.8,
                "videoPaused": False,
                "audioPaused": False,
                "videoSeekWrites": 0,
                "audioSeekWrites": 1,
            },
        )

    def test_av_delay_resync_does_not_enter_coordinated_video_seek(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(30);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
let coordinatedSeekBegins = 0;
function beginSplitPlayerSeek() { coordinatedSeekBegins += 1; }
effectiveOffsetSeconds = 0.2;
resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ coordinatedSeekBegins, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites, audioTime: audio.currentTime }));
""",
            self.sync_source,
            self.offset_resync_source,
        )
        self.assertEqual(
            result,
            {
                "coordinatedSeekBegins": 0,
                "videoSeekWrites": 0,
                "audioSeekWrites": 1,
                "audioTime": 29.8,
            },
        )

    def test_av_delay_change_while_paused_realigns_audio_and_stays_paused(self):
        result = self.run_node(
            """
mountedVideo = new FakeMedia(30);
mountedAudio = new FakeMedia(30);
state.localShouldBePlaying = false;
effectiveOffsetSeconds = 0.4;
const changed = resyncMountedLocalPlayerForOffsetChange();
console.log(JSON.stringify({ changed, videoTime: mountedVideo.currentTime,
  audioTime: mountedAudio.currentTime, videoPaused: mountedVideo.paused,
  audioPaused: mountedAudio.paused, videoPlayCalls: mountedVideo.playCalls,
  audioPlayCalls: mountedAudio.playCalls, videoSeekWrites: mountedVideo.seekWrites,
  audioSeekWrites: mountedAudio.seekWrites }));
""",
            self.sync_source,
            self.offset_resync_source,
        )
        self.assertEqual(
            result,
            {
                "changed": True,
                "videoTime": 30,
                "audioTime": 29.6,
                "videoPaused": True,
                "audioPaused": True,
                "videoPlayCalls": 0,
                "audioPlayCalls": 0,
                "videoSeekWrites": 0,
                "audioSeekWrites": 1,
            },
        )

    def test_audio_waiting_holds_video_without_seeking_it(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false; state.localAudioPlaybackBlocked = true;
const action = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ action, videoPaused: video.paused, videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls, videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["action"], "wait-for-audio")
        self.assertTrue(result["videoPaused"])
        self.assertEqual(result["videoPauseCalls"], 1)
        self.assertEqual(result["audioPauseCalls"], 0)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)

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
  negativeAudioTime: negativeAudio.currentTime, negativeAudioPlaying: !negativeAudio.paused,
  positiveVideoSeekWrites: positiveVideo.seekWrites,
  negativeVideoSeekWrites: negativeVideo.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["positiveAction"], "start")
        self.assertEqual(result["positiveVideoTime"], 0)
        self.assertTrue(result["positiveAudioPaused"])
        self.assertTrue(result["positiveVideoPlaying"])
        self.assertEqual(result["negativeAction"], "audio-drift-correction")
        self.assertEqual(result["negativeVideoTime"], 0)
        self.assertAlmostEqual(result["negativeAudioTime"], 0.4)
        self.assertTrue(result["negativeAudioPlaying"])
        self.assertEqual(result["positiveVideoSeekWrites"], 0)
        self.assertEqual(result["negativeVideoSeekWrites"], 0)

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

    def test_manual_video_seek_freezes_pair_maps_audio_and_resumes(self):
        result = self.run_node(
            """
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function maybeShowRatingPromptForProgress() {}
function reportCurrentVideoStatus() {}
const currentItem = { id: "item" };
const video = new FakeMedia(60); const audio = new FakeMedia(3);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
let coordinatedSeekBegins = 0;
const originalBeginSplitPlayerSeek = beginSplitPlayerSeek;
beginSplitPlayerSeek = (...args) => {
  coordinatedSeekBegins += 1;
  return originalBeginSplitPlayerSeek(...args);
};
"""
            + self.video_seek_event_source
            + """
video.seeking = true;
video.dispatchMediaEvent("seeking");
const frozen = {
  coordinatedSeekBegins,
  internalSeek: video.dataset.bilikaraInternalSeek || null,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  audioTime: audio.currentTime,
  pendingTimers: pendingTimers.size,
};
video.seeking = false;
video.dispatchMediaEvent("seeked");
console.log(JSON.stringify({
  frozen,
  final: {
    coordinatedSeekBegins,
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
    pendingTimers: pendingTimers.size,
  },
}));
""",
            self.clear_seek_source,
            self.sync_source,
            self.seek_lifecycle_source,
        )
        self.assertEqual(
            result["frozen"],
            {
                "coordinatedSeekBegins": 1,
                "internalSeek": None,
                "videoPaused": True,
                "audioPaused": True,
                "audioTime": 59.8,
                "pendingTimers": 1,
            },
        )
        self.assertEqual(
            result["final"],
            {
                "coordinatedSeekBegins": 1,
                "videoTime": 60,
                "audioTime": 59.8,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
                "pendingTimers": 0,
            },
        )

    def test_playback_restore_intentionally_seeks_video_then_aligns_audio(self):
        result = self.run_node(
            """
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
const video = new FakeMedia(10); const audio = new FakeMedia(9.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
beginSplitPlayerSeek(video, audio, {
  resumeAfterSeek: true,
  targetTime: 45,
  diagnosticAction: "restore-video-seek",
});
const positioned = {
  videoTime: video.currentTime,
  audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
delete video.dataset.bilikaraInternalSeek;
const settled = settleSplitPlayerSeek(video, audio);
console.log(JSON.stringify({ positioned, settled, actions,
  finalVideoTime: video.currentTime, finalAudioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites,
  pairPlaying: !video.paused && !audio.paused }));
""",
            self.clear_seek_source,
            self.sync_source,
            self.seek_lifecycle_source,
        )
        self.assertEqual(
            result["positioned"],
            {
                "videoTime": 45,
                "audioTime": 44.8,
                "videoSeekWrites": 1,
                "audioSeekWrites": 1,
                "videoPaused": True,
                "audioPaused": True,
            },
        )
        self.assertTrue(result["settled"])
        self.assertIn("restore-video-seek", result["actions"])
        self.assertEqual(result["finalVideoTime"], 45)
        self.assertAlmostEqual(result["finalAudioTime"], 44.8)
        self.assertEqual(result["videoSeekWrites"], 1)
        self.assertEqual(result["audioSeekWrites"], 1)
        self.assertTrue(result["pairPlaying"])

    def test_manual_video_seek_while_paused_keeps_pair_paused(self):
        result = self.run_node(
            """
let nextTimerId = 1;
const pendingTimers = new Map();
global.window = {
  setTimeout(callback) { const id = nextTimerId++; pendingTimers.set(id, callback); return id; },
  clearTimeout(id) { pendingTimers.delete(id); },
};
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function maybeShowRatingPromptForProgress() {}
function reportCurrentVideoStatus() {}
const currentItem = { id: "item" };
const video = new FakeMedia(60); const audio = new FakeMedia(3);
state.localShouldBePlaying = false;
mountedVideo = video; mountedAudio = audio;
"""
            + self.video_seek_event_source
            + """
video.seeking = true;
video.dispatchMediaEvent("seeking");
video.seeking = false;
video.dispatchMediaEvent("seeked");
console.log(JSON.stringify({ videoTime: video.currentTime, audioTime: audio.currentTime,
  videoPaused: video.paused, audioPaused: audio.paused,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.clear_seek_source,
            self.sync_source,
            self.seek_lifecycle_source,
        )
        self.assertEqual(
            result,
            {
                "videoTime": 60,
                "audioTime": 59.8,
                "videoPaused": True,
                "audioPaused": True,
                "videoPlayCalls": 0,
                "audioPlayCalls": 0,
                "videoSeekWrites": 0,
                "audioSeekWrites": 1,
            },
        )

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

    def test_long_term_periodic_correction_never_writes_video_timeline(self):
        result = self.run_node(
            """
const video = new FakeMedia(30); const audio = new FakeMedia(29.6);
video.paused = false; audio.paused = false;
const tickActions = [];
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.12; audio._time = 29.91; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.24; audio._time = 29.95; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 30.36; audio._time = 29.96; nowMs += 120;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
video._time = 31; audio._time = 30.4; nowMs += 1000;
tickActions.push(syncSplitPlayer(video, audio, 0.2, false));
console.log(JSON.stringify({ tickActions, videoTime: video.currentTime,
  videoSeekWrites: video.seekWrites, audioTime: audio.currentTime, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(
            result["tickActions"],
            ["audio-drift-correction", "none", "none", "none", "audio-drift-correction"],
        )
        self.assertEqual(result["videoTime"], 31)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 2)
        self.assertAlmostEqual(result["audioTime"], 30.8)

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

    def test_ordinary_render_does_not_synchronize_or_seek_mounted_player(self):
        result = self.run_node_script(
            f"""
let syncCalls = 0;
let videoSeekWrites = 0;
let audioSeekWrites = 0;
const state = {{
  data: {{ revision: 2, player_settings: {{ key_shift: 0 }} }},
  language: "en",
  playerSignature: "item|local|video.mp4|audio.m4a|ready|cached|en",
}};
function handleRatingCurrentItemChange() {{}}
function selectedVideoUrlForItem() {{ return "video.mp4"; }}
function selectedAudioUrlForItem() {{ return "audio.m4a"; }}
function hostCacheDetailTextForItem() {{ return "cached"; }}
function syncMountedLocalPlayer() {{
  syncCalls += 1;
  videoSeekWrites += 1;
  audioSeekWrites += 1;
}}
function syncPlayerFrameCacheHint() {{}}
{self.renderer_fast_path_source}
const item = {{ id: "item", cache_status: "ready" }};
renderPlayer(item, "local");
console.log(JSON.stringify({{ syncCalls, videoSeekWrites, audioSeekWrites }}));
"""
        )
        self.assertEqual(
            result,
            {"syncCalls": 0, "videoSeekWrites": 0, "audioSeekWrites": 0},
        )

    def test_key_shift_action_writes_neither_media_timeline(self):
        result = self.run_node_script(
            f"""
(async () => {{
  class TimelineMedia {{
    constructor() {{ this._time = 30; this.seekWrites = 0; this.paused = false; }}
    get currentTime() {{ return this._time; }}
    set currentTime(value) {{ this._time = Number(value); this.seekWrites += 1; }}
  }}
  const video = new TimelineMedia();
  const audio = new TimelineMedia();
  const state = {{
    data: {{ player_settings: {{ key_shift: 0 }} }},
    volumeSaveSeq: 0,
    audioContext: null,
  }};
  const window = {{ AudioContext: null, webkitAudioContext: null }};
  function markLocalVolumeWrite() {{ state.volumeSaveSeq += 1; return state.volumeSaveSeq; }}
  function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
  function renderKeyShiftControls() {{}}
  function frontendPlaybackMode() {{ return "local"; }}
  function ensureAudioPitchSource() {{ return null; }}
  function disposeAudioPitchProcessor() {{}}
  function disconnectAudioPitchSource() {{}}
  function resumeAudioContextBestEffort() {{}}
  function syncLocalPlayerSettingsFromSnapshot(settings) {{
    applyKeyShiftToAudio(audio, settings?.key_shift);
  }}
  async function apiPost() {{ return {{ player_settings: {{ key_shift: 3 }} }}; }}
  {self.pitch_apply_source}
  {self.key_shift_action_source}
  await setLocalPlayerKeyShift(3);
  console.log(JSON.stringify({{
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
    videoSeekWrites: video.seekWrites,
    audioSeekWrites: audio.seekWrites,
  }}));
}})().catch((error) => {{ globalThis.console.error(error); process.exit(1); }});
"""
        )
        self.assertEqual(
            result,
            {
                "videoTime": 30,
                "audioTime": 30,
                "videoSeekWrites": 0,
                "audioSeekWrites": 0,
            },
        )
        self.assertNotIn("currentTime", self.pitch_apply_source)
        self.assertNotIn("syncMountedLocalPlayer", self.key_shift_action_source)

    def test_key_shift_render_echo_does_not_synchronize_or_seek_video(self):
        result = self.run_node_script(
            f"""
let syncCalls = 0;
let videoSeekWrites = 0;
const state = {{
  data: {{ player_settings: {{ key_shift: 0 }} }},
  language: "en",
  playerSignature: "item|local|video.mp4|audio.m4a|ready|cached|en",
}};
function handleRatingCurrentItemChange() {{}}
function selectedVideoUrlForItem() {{ return "video.mp4"; }}
function selectedAudioUrlForItem() {{ return "audio.m4a"; }}
function hostCacheDetailTextForItem() {{ return "cached"; }}
function syncMountedLocalPlayer() {{ syncCalls += 1; videoSeekWrites += 1; }}
function syncPlayerFrameCacheHint() {{}}
{self.renderer_fast_path_source}
const item = {{ id: "item", cache_status: "ready" }};
state.data.player_settings.key_shift = 2;
renderPlayer(item, "local");
renderPlayer(item, "local");
console.log(JSON.stringify({{ syncCalls, videoSeekWrites }}));
"""
        )
        self.assertEqual(result, {"syncCalls": 0, "videoSeekWrites": 0})

    def test_startup_readiness_events_coalesce_without_timeline_write_storm(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0;
let restoreChecks = 0;
const originalSyncSplitPlayer = syncSplitPlayer;
const forceCalls = [];
syncSplitPlayer = (...args) => {
  forceCalls.push(Boolean(args[3]));
  return originalSyncSplitPlayer(...args);
};
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => { restoreChecks += 1; return false; },
);
const handleReadiness = () => {
  if (!synchronizeStartupPlayer()) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), state.localVideoDeferredRecovery);
  }
};
synchronizeStartupPlayer();
video.readyState = 4;
handleReadiness();
audio.readyState = 4;
handleReadiness();
handleReadiness();
handleReadiness();
console.log(JSON.stringify({
  forceCalls,
  actions,
  videoTime: video.currentTime,
  audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites,
  audioSeekWrites: audio.seekWrites,
  restoreChecks,
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["forceCalls"], [True, False, False])
        self.assertEqual(result["actions"], ["none", "none", "none"])
        self.assertEqual(result["videoTime"], 0)
        self.assertEqual(result["audioTime"], 0)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)
        self.assertEqual(result["restoreChecks"], 3)

    def test_startup_misalignment_is_one_audio_write_and_zero_video_writes(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
effectiveOffsetSeconds = 0.2;
const forceCalls = [];
const originalSyncSplitPlayer = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  forceCalls.push(Boolean(args[3]));
  return originalSyncSplitPlayer(...args);
};
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
const handleReadiness = () => {
  if (!synchronizeStartupPlayer()) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), state.localVideoDeferredRecovery);
  }
};
synchronizeStartupPlayer();
video.readyState = 4;
handleReadiness();
audio.readyState = 4;
handleReadiness();
handleReadiness();
handleReadiness();
console.log(JSON.stringify({ forceCalls, actions,
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["forceCalls"], [True, False, False])
        self.assertEqual(
            result["actions"],
            ["audio-drift-correction", "none", "none"],
        )
        self.assertEqual(result["videoTime"], 2)
        self.assertAlmostEqual(result["audioTime"], 1.8)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 1)

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
