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
        cls.video_recovery_event_source = cls._slice(
            '  addMountedPlayerListener(video, "canplay",',
            '  addMountedPlayerListener(video, "timeupdate",',
        )
        cls.video_play_event_source = cls._slice(
            '  addMountedPlayerListener(video, "play",',
            '  addMountedPlayerListener(video, "pause",',
        )
        cls.video_play_pause_event_source = cls._slice(
            '  addMountedPlayerListener(video, "play",',
            '  addMountedPlayerListener(video, "seeking",',
        )
        cls.player_frame_click_listener_source = cls._slice(
            'elements.playerFrame?.addEventListener("click",',
            'elements.playerFrame?.addEventListener("dblclick",',
        )
        cls.session_foundation_source = cls._slice(
            "function hostPlaybackMountData",
            "function renderPlayer",
        )
        cls.renderer_source = cls._slice(
            "function renderPlayer(currentItem, playbackMode)",
            "function applyRemotePlayerControl",
        )
        cls.program_equality_source = cls._slice(
            "function playbackProgramDescriptorsEqual",
            "function isValidHostMediaLocator",
        )
        cls.webkit_helpers_source = cls._slice(
            "function isWebKitPlaybackRuntime",
            "function canTogglePlayerFullscreen",
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
  localPlaybackStartState: "established",
  localPlaybackStartGeneration: 0,
  localPlaybackStartPromisesSettled: false,
  localWebKitStartRetryDone: false,
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
  localPlayerControlsHideTimer: null,
  localPlayerControlsHideGeneration: 0,
  localPlaybackStartupWatchdogTimer: null,
  localPlayerEventCleanups: [],
  hostPlaybackSession: {{ eventCleanups: [] }},
  tauriMediaSessionOwner: null,
  lastTauriMediaSessionPositionAt: 0,
}};
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerSyncSeekCooldownMs = 750;
const localPlayerSeekSettlePollMs = 50;
const localPlayerSeekSettleMaxMs = 1400;
const splitPlaybackStartupWatchdogMs = 3000;
const tauriMediaSessionPositionUpdateMs = 1000;
const mediaPlayPromisesInFlight = new WeakSet();
let nowMs = 1000;
Date.now = () => nowMs;
const actions = [];
const playRejections = [];
const startupDiagnostics = [];
let heldItemId = "";
let mountedVideo = null;
let mountedAudio = null;
let mountedOverlay = null;
global.window = global;
const elements = {{
  playerFrame: {{
    querySelector(selector) {{
      return selector === ".split-playback-start-overlay" ? mountedOverlay : null;
    }},
    appendChild() {{}},
  }},
}};
function t(key) {{ return key; }}
function activeLocalPlayerElements() {{ return {{ video: mountedVideo, audio: mountedAudio }}; }}
function clearSplitPlaybackStartupWatchdog() {{
  if (!state.localPlaybackStartupWatchdogTimer) return;
  window.clearTimeout(state.localPlaybackStartupWatchdogTimer);
  state.localPlaybackStartupWatchdogTimer = null;
}}
function syncSplitPlayerVolumeFromVideo() {{}}
function isSplitPlayerSeekSettling(video, audio) {{
  return state.localSeekSettling && isActiveSplitPlayer(video, audio);
}}
function shouldHoldCurrentItemForTransition(item) {{
  const itemId = String(item?.id || item || "");
  return Boolean(itemId && itemId === heldItemId);
}}
function reportSplitSyncDiagnostic(itemId, video, audio, action) {{ actions.push(action); }}
function reportSplitStartupDiagnostic(itemId, video, audio, eventName) {{
  startupDiagnostics.push({{
    eventName,
    playbackStartState: state.localPlaybackStartState,
    localShouldBePlaying: state.localShouldBePlaying,
  }});
}}
function reportMediaDiagnostic(itemId, mediaKind, media, eventName, video, audio, action, error) {{
  playRejections.push({{
    mediaKind,
    eventName,
    errorName: String(error?.name || ""),
    errorMessage: String(error?.message || ""),
  }});
}}
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
function revealMountedPlayerControlsForUserInteraction() {{}}
function resumeAudioContextBestEffort() {{}}
function reportPlayerStatus() {{}}
let advances = 0;
async function handleLocalPlaybackEnded() {{ advances += 1; }}
let nextTrackRequests = 0;
async function requestNextTrack() {{ nextTrackRequests += 1; }}
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
function addMountedPlayerListener(media, eventName, listener) {{
  media.addEventListener(eventName, listener);
}}
{self.webkit_helpers_source}
{''.join(sources)}
(async () => {{
{body}
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        return self.run_node_script(script)

    def run_node_script(self, script: str) -> dict:
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
state.localPlaybackStartupWatchdogTimer = 3;
state.hostPlaybackSession.eventCleanups.push(() => { listenerCleanups += 1; });
clearLocalPlayerSyncTimer(); clearLocalPlayerEventListeners();
console.log(JSON.stringify({ intervalClears, timeoutClears, listenerCleanups,
  syncTimer: state.localPlayerSyncTimer, startupTimer: state.localPlayerStartupTimer,
  watchdogTimer: state.localPlaybackStartupWatchdogTimer,
  cleanupCount: state.hostPlaybackSession.eventCleanups.length }));
""",
            self.lifecycle_source,
        )
        self.assertEqual(result["intervalClears"], 1)
        self.assertEqual(result["timeoutClears"], 2)
        self.assertEqual(result["listenerCleanups"], 1)
        self.assertIsNone(result["syncTimer"])
        self.assertIsNone(result["startupTimer"])
        self.assertIsNone(result["watchdogTimer"])
        self.assertEqual(result["cleanupCount"], 0)

    def test_ordinary_render_does_not_synchronize_or_seek_mounted_player(self):
        result = self.run_node_script(
            f"""
let syncCalls = 0;
let videoSeekWrites = 0;
let audioSeekWrites = 0;
const video = {{ currentTime: 23.5 }};
const audio = {{ currentTime: 23.5 }};
const program = {{
  item_id: "item",
  item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental",
  artifact_set_id: "artifact",
}};
const state = {{
  data: {{ playback_generation: 2, playback_program: program }},
  hostPlaybackSession: {{
    playbackGeneration: 2, playbackProgram: program, cleanupState: "active",
    video, audio, eventCleanups: [],
  }},
}};
function handleRatingCurrentItemChange() {{}}
function syncMountedLocalPlayer() {{
  syncCalls += 1;
  videoSeekWrites += 1;
  audioSeekWrites += 1;
}}
{self.program_equality_source}
{self.session_foundation_source}
{self.renderer_source}
const item = {{ id: "item", item_incarnation_id: "incarnation" }};
renderPlayer(item, "local");
console.log(JSON.stringify({{
  syncCalls, videoSeekWrites, audioSeekWrites,
  sameVideo: state.hostPlaybackSession.video === video,
  sameAudio: state.hostPlaybackSession.audio === audio,
  currentTime: video.currentTime,
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "syncCalls": 0,
                "videoSeekWrites": 0,
                "audioSeekWrites": 0,
                "sameVideo": True,
                "sameAudio": True,
                "currentTime": 23.5,
            },
        )

    def test_refresh_progress_preserves_mounted_pair_and_new_artifact_changes_identity_once(self):
        result = self.run_node_script(
            f"""
{self.program_equality_source}
const initial = {{
  item_id: "song-a", item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental", artifact_set_id: "set-a1",
}};
const progressRefresh = {{ ...initial }};
const languageRefresh = {{ ...initial }};
const replacement = {{ ...initial, artifact_set_id: "set-a2" }};
console.log(JSON.stringify({{
  sameDuringRefresh: playbackProgramDescriptorsEqual(initial, progressRefresh),
  sameAfterLanguageChange: playbackProgramDescriptorsEqual(progressRefresh, languageRefresh),
  replacementChanged: !playbackProgramDescriptorsEqual(replacement, progressRefresh),
  replacementStable: playbackProgramDescriptorsEqual(replacement, {{ ...replacement }}),
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "sameDuringRefresh": True,
                "sameAfterLanguageChange": True,
                "replacementChanged": True,
                "replacementStable": True,
            },
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
const video = {{ currentTime: 30 }};
const audio = {{ currentTime: 30 }};
const program = {{
  item_id: "item", item_incarnation_id: "incarnation",
  selected_audio_variant_id: "instrumental", artifact_set_id: "artifact",
}};
const state = {{
  data: {{ playback_generation: 4, playback_program: program, player_settings: {{ key_shift: 0 }} }},
  hostPlaybackSession: {{
    playbackGeneration: 4, playbackProgram: program, cleanupState: "active",
    video, audio, eventCleanups: [],
  }},
}};
function handleRatingCurrentItemChange() {{}}
function syncMountedLocalPlayer() {{ syncCalls += 1; videoSeekWrites += 1; }}
{self.program_equality_source}
{self.session_foundation_source}
{self.renderer_source}
const item = {{ id: "item", item_incarnation_id: "incarnation" }};
state.data.player_settings.key_shift = 2;
renderPlayer(item, "local");
renderPlayer(item, "local");
console.log(JSON.stringify({{
  syncCalls, videoSeekWrites,
  sameVideo: state.hostPlaybackSession.video === video,
  sameAudio: state.hostPlaybackSession.audio === audio,
  currentTime: video.currentTime,
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "syncCalls": 0,
                "videoSeekWrites": 0,
                "sameVideo": True,
                "sameAudio": True,
                "currentTime": 30,
            },
        )

    def test_startup_readiness_events_coalesce_without_timeline_write_storm(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
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
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
console.log(JSON.stringify({
  forceCalls,
  actions,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
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
        self.assertEqual(result["forceCalls"].count(True), 1)
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertEqual(result["startState"], "established")
        self.assertIn("autoplay-success", result["actions"])
        self.assertEqual(result["videoTime"], 0)
        self.assertEqual(result["audioTime"], 0)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)
        self.assertEqual(result["restoreChecks"], 3)

    def test_packaged_tauri_webkit_fresh_start_resolves_without_user_gesture(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: {
    toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); },
  },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  isTauriWebKit: isTauriWebKitRuntime(),
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupDiagnostics,
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(
            result,
            {
                "isTauriWebKit": True,
                "startState": "established",
                "shouldPlay": True,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
                "overlayHidden": True,
                "startupDiagnostics": [
                    {
                        "eventName": "autoplay-attempt",
                        "playbackStartState": "starting",
                        "localShouldBePlaying": True,
                    },
                    {
                        "eventName": "autoplay-video-play-resolved",
                        "playbackStartState": "starting",
                        "localShouldBePlaying": True,
                    },
                    {
                        "eventName": "autoplay-audio-play-resolved",
                        "playbackStartState": "starting",
                        "localShouldBePlaying": True,
                    },
                    {
                        "eventName": "autoplay-success",
                        "playbackStartState": "established",
                        "localShouldBePlaying": True,
                    },
                ],
            },
        )

    def test_webkit_metadata_only_pair_attempts_autoplay_before_canplay(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
const handled = synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  handled,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["handled"])
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertIn("autoplay-attempt", result["startupEvents"])
        self.assertIn("autoplay-success", result["startupEvents"])

    def test_chromium_initial_start_keeps_existing_canplay_gate(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  video,
  audio,
  () => false,
);
synchronizeStartupPlayer();
const atMetadata = {
  startState: state.localPlaybackStartState,
  playCalls: [video.playCalls, audio.playCalls],
};
video.readyState = 2; audio.readyState = 2;
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  atMetadata,
  finalState: state.localPlaybackStartState,
  finalPlayCalls: [video.playCalls, audio.playCalls],
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(
            result["atMetadata"],
            {"startState": "pending", "playCalls": [0, 0]},
        )
        self.assertEqual(result["finalState"], "established")
        self.assertEqual(result["finalPlayCalls"], [1, 1])

    def test_packaged_tauri_metadata_start_ignores_internal_native_play_echo(self):
        result = self.run_node(
            """
synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(video, audio, () => false);
synchronizeStartupPlayer();

// WebKit/Now Playing echoes the application-owned video play event.
video.paused = false;
video.dispatchMediaEvent("play");
const afterEarlyPlay = {
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  videoPauseCalls: video.pauseCalls,
};

await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterEarlyPlay,
  finalState: state.localPlaybackStartState,
  finalShouldPlay: state.localShouldBePlaying,
  finalOverlayHidden: mountedOverlay.hidden,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupDiagnostics,
}));
""",
            self.sync_source,
            self.startup_source,
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 4;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: {
    toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); },
  },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
const currentItem = { id: "item" };
let synchronizeStartupPlayer = null;
function addMountedPlayerListener(media, eventName, listener) { media.addEventListener(eventName, listener); }
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
""",
            self.video_play_event_source,
        )
        self.assertEqual(
            result["afterEarlyPlay"],
            {
                "startState": "starting",
                "shouldPlay": True,
                "overlayHidden": True,
                "videoPauseCalls": 0,
            },
        )
        self.assertEqual(result["finalState"], "established")
        self.assertTrue(result["finalShouldPlay"])
        self.assertTrue(result["finalOverlayHidden"])
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertEqual(
            [event["eventName"] for event in result["startupDiagnostics"]],
            [
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-audio-play-resolved",
                "autoplay-success",
            ],
        )

    def test_host_pending_first_video_click_is_immediate_start_not_toggle(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17 Safari/605.1.15",
}, configurable: true, writable: true });
delete window.__TAURI__;
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
let insideClickHandler = false;
const activationObservations = [];
video.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["video", insideClickHandler]);
  return Promise.resolve();
};
audio.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["audio", insideClickHandler]);
  return Promise.resolve();
};
insideClickHandler = true;
frameClickHandler({
  target: { closest(selector) { return selector === "video" ? video : null; } },
});
insideClickHandler = false;
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  activationObservations,
  queuedToggleCalls,
  playCalls: [video.playCalls, audio.playCalls],
}));
""",
            self.sync_source,
            """
let frameClickHandler = null;
let queuedToggleCalls = 0;
function clearPlayerFrameClickTimer() {}
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
""",
            self.player_frame_click_listener_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertEqual(result["activationObservations"], [["video", True], ["audio", True]])
        self.assertEqual(result["queuedToggleCalls"], 0)
        self.assertEqual(result["playCalls"], [1, 1])

    def test_packaged_tauri_pending_video_click_is_one_explicit_start(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
frameClickHandler({
  target: { closest(selector) { return selector === "video" ? video : null; } },
});
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  queuedToggleCalls,
  playCalls: [video.playCalls, audio.playCalls],
}));
""",
            self.sync_source,
            """
let frameClickHandler = null;
let queuedToggleCalls = 0;
function clearPlayerFrameClickTimer() {}
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
""",
            self.player_frame_click_listener_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertEqual(result["queuedToggleCalls"], 0)
        self.assertEqual(result["playCalls"], [1, 1])

    def test_packaged_tauri_native_pause_and_play_ignore_outer_video_click(self):
        result = self.run_node(
            """
function mountPair(playing) {
  video = new FakeMedia(20); audio = new FakeMedia(19.8);
  video.paused = !playing; audio.paused = !playing;
  mountedVideo = video; mountedAudio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = playing;
  return { video, audio };
}

const playingPair = mountPair(true);
playingPair.video.paused = true;
videoPauseListener();
frameClickHandler(nativeVideoClick);
await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: playingPair.video.paused,
  audioPaused: playingPair.audio.paused,
  queuedToggleCalls,
};

const pausedPair = mountPair(false);
pausedPair.video.paused = false;
videoPlayListener();
frameClickHandler(nativeVideoClick);
await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
const afterPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: pausedPair.video.paused,
  audioPaused: pausedPair.audio.paused,
  queuedToggleCalls,
};
console.log(JSON.stringify({ afterPause, afterPlay }));
""",
            self.sync_source,
            self.startup_source,
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
global.document = { hidden: false };
const currentItem = { id: "item" };
let synchronizeStartupPlayer = () => false;
let video = new FakeMedia(20); let audio = new FakeMedia(19.8);
let videoPlayListener = null;
let videoPauseListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (eventName === "play") videoPlayListener = listener;
  if (eventName === "pause") videoPauseListener = listener;
}
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
let frameClickHandler = null;
let queuedToggleCalls = 0;
const playerClickDelayMs = 10;
function clearPlayerFrameClickTimer() {
  if (state.playerFrameClickTimer) clearTimeout(state.playerFrameClickTimer);
  state.playerFrameClickTimer = null;
}
function queuePlayerFrameSingleClick() {
  clearPlayerFrameClickTimer();
  state.playerFrameClickTimer = setTimeout(() => {
    state.playerFrameClickTimer = null;
    queuedToggleCalls += 1;
    setSplitPlaybackIntent(mountedVideo, mountedAudio, !state.localShouldBePlaying, {
      source: "player-toggle-intent",
      userGesture: true,
    });
  }, playerClickDelayMs);
}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
const nativeVideoClick = {
  target: {
    closest(selector) { return selector === "video" ? mountedVideo : null; },
  },
};
""",
            self.video_play_pause_event_source,
            self.player_frame_click_listener_source,
        )
        self.assertEqual(
            result["afterPause"],
            {
                "shouldPlay": False,
                "videoPaused": True,
                "audioPaused": True,
                "queuedToggleCalls": 0,
            },
        )
        self.assertEqual(
            result["afterPlay"],
            {
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "queuedToggleCalls": 0,
            },
        )

    def test_packaged_tauri_native_seek_ignores_outer_video_click_and_preserves_intent(self):
        result = self.run_node(
            """
async function exercise(playing) {
  clearPlayerFrameClickTimer();
  const beforeQueued = queuedToggleCalls;
  video = new FakeMedia(20); audio = new FakeMedia(19.8);
  video.paused = !playing; audio.paused = !playing;
  mountedVideo = video; mountedAudio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = playing;

  video.currentTime = 35;
  video.seeking = true;
  videoSeekingListener();
  frameClickHandler(nativeVideoClick);
  video.seeking = false;
  audio.seeking = false;
  videoSeekedListener();
  await new Promise((resolve) => setTimeout(resolve, playerClickDelayMs + 15));
  return {
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoWrites: video.seekWrites,
    audioWrites: audio.seekWrites,
    queuedToggleCalls: queuedToggleCalls - beforeQueued,
  };
}

const playing = await exercise(true);
const paused = await exercise(false);
console.log(JSON.stringify({ playing, paused }));
""",
            self.sync_source,
            self.startup_source,
            self.seek_lifecycle_source,
            self.clear_seek_source,
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
let video = new FakeMedia(20); let audio = new FakeMedia(19.8);
let videoSeekingListener = null;
let videoSeekedListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (eventName === "seeking") videoSeekingListener = listener;
  if (eventName === "seeked") videoSeekedListener = listener;
}
function reportCurrentVideoStatus() {}
function maybeShowRatingPromptForProgress() {}
const currentItem = { id: "item" };
let frameClickHandler = null;
let queuedToggleCalls = 0;
const playerClickDelayMs = 10;
function clearPlayerFrameClickTimer() {
  if (state.playerFrameClickTimer) clearTimeout(state.playerFrameClickTimer);
  state.playerFrameClickTimer = null;
}
function queuePlayerFrameSingleClick() {
  clearPlayerFrameClickTimer();
  state.playerFrameClickTimer = setTimeout(() => {
    state.playerFrameClickTimer = null;
    queuedToggleCalls += 1;
    setSplitPlaybackIntent(mountedVideo, mountedAudio, !state.localShouldBePlaying, {
      source: "player-toggle-intent",
      userGesture: true,
    });
  }, playerClickDelayMs);
}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
const nativeVideoClick = {
  target: {
    closest(selector) { return selector === "video" ? mountedVideo : null; },
  },
};
""",
            self.video_seek_event_source,
            self.player_frame_click_listener_source,
        )
        self.assertEqual(
            result["playing"],
            {
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoWrites": 1,
                "audioWrites": 1,
                "queuedToggleCalls": 0,
            },
        )
        self.assertEqual(
            result["paused"],
            {
                "shouldPlay": False,
                "videoPaused": True,
                "audioPaused": True,
                "videoWrites": 1,
                "audioWrites": 1,
                "queuedToggleCalls": 0,
            },
        )

    def test_player_frame_click_toggle_is_bypassed_only_for_tauri_webkit(self):
        result = self.run_node(
            """
function exercise(userAgent, tauriPresent) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent }, configurable: true, writable: true,
  });
  if (tauriPresent) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
  const before = queuedToggleCalls;
  frameClickHandler({ target: { closest(selector) { return selector === "video" ? {} : null; } } });
  return queuedToggleCalls - before;
}
console.log(JSON.stringify({
  safari: exercise(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    false,
  ),
  chrome: exercise("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", false),
  webview2: exercise(
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120",
    true,
  ),
  tauriWebKit: exercise(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    true,
  ),
}));
""",
            """
let frameClickHandler = null;
let queuedToggleCalls = 0;
function queuePlayerFrameSingleClick() { queuedToggleCalls += 1; }
function clearPlayerFrameClickTimer() {}
elements.playerFrame.addEventListener = (eventName, listener) => {
  if (eventName === "click") frameClickHandler = listener;
};
""",
            self.player_frame_click_listener_source,
        )
        self.assertEqual(
            result,
            {"safari": 1, "chrome": 1, "webview2": 1, "tauriWebKit": 0},
        )

    def test_remote_toggle_during_pending_start_is_deterministic_play(self):
        remote_control_source = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localShouldBePlaying = true;
state.localPlaybackStartState = "pending";
applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  playCalls: [video.playCalls, audio.playCalls],
  appliedSeq: state.lastAppliedPlayerControlSeq,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            """
function ackRemotePlayerControl() {}
""",
            remote_control_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertEqual(result["playCalls"], [1, 1])
        self.assertEqual(result["appliedSeq"], 1)
        self.assertIn("remote-play-intent", result["startupEvents"])

    def test_tauri_webkit_host_manual_play_then_remote_toggle_uses_session_intent(self):
        remote_control_source = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
const productionRequestStart = requestSplitPlaybackStart;
let startupRequestCalls = 0;
requestSplitPlaybackStart = (...args) => {
  startupRequestCalls += 1;
  return productionRequestStart(...args);
};

setSplitPlaybackIntent(video, audio, true, {
  source: "host-manual-play",
  userGesture: true,
});
await Promise.resolve(); await Promise.resolve();
const afterHostManualPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
};

applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
applyRemotePlayerControl(
  { seq: 2, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterHostManualPlay,
  afterPause,
  afterPlay: {
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
  },
  startupRequestCalls,
  appliedSeq: state.lastAppliedPlayerControlSeq,
}));
""",
            self.sync_source,
            """
function ackRemotePlayerControl() {}
""",
            remote_control_source,
        )
        self.assertEqual(
            result["afterHostManualPlay"],
            {
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
            },
        )
        self.assertEqual(
            result["afterPause"],
            {"shouldPlay": False, "videoPaused": True, "audioPaused": True},
        )
        self.assertEqual(
            result["afterPlay"],
            {
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 2,
                "audioPlayCalls": 2,
            },
        )
        self.assertEqual(result["startupRequestCalls"], 0)
        self.assertEqual(result["appliedSeq"], 2)

    def test_tauri_webkit_remote_toggle_recovers_an_active_auto_started_pair(self):
        remote_control_source = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "starting";
state.localShouldBePlaying = true;

applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
const afterPause = {
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};
applyRemotePlayerControl(
  { seq: 2, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  afterPause,
  afterPlay: {
    startState: state.localPlaybackStartState,
    shouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoPlayCalls: video.playCalls,
    audioPlayCalls: audio.playCalls,
  },
}));
""",
            self.sync_source,
            """
function ackRemotePlayerControl() {}
""",
            remote_control_source,
        )
        self.assertEqual(
            result["afterPause"],
            {
                "startState": "established",
                "shouldPlay": False,
                "videoPaused": True,
                "audioPaused": True,
            },
        )
        self.assertEqual(
            result["afterPlay"],
            {
                "startState": "established",
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
            },
        )

    def test_tauri_webkit_remote_seek_uses_authoritative_playback_intent(self):
        remote_control_source = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        result = self.run_node(
            """
function setRuntime(userAgent, tauri) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent }, configurable: true, writable: true,
  });
  if (tauri) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
}
function mountPair({ intent, videoPaused, audioPaused, startState }) {
  const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
  video.paused = videoPaused; audio.paused = audioPaused;
  mountedVideo = video; mountedAudio = audio;
  elements.playerFrame.querySelector = (selector) => {
    if (selector === "video") return video;
    if (selector === 'audio[data-player-role="audio"]') return audio;
    if (selector === ".split-playback-start-overlay") return mountedOverlay;
    return null;
  };
  state.localPlaybackStartState = startState;
  state.localShouldBePlaying = intent;
  return { video, audio };
}
async function seek(pair, seq) {
  applyRemotePlayerControl(
    { seq, action: "seek-relative", item_id: "item", delta_seconds: 15 },
    { id: "item" },
    "local",
  );
  settleSplitPlayerSeek(pair.video, pair.audio, true);
  await Promise.resolve(); await Promise.resolve();
  return {
    startState: state.localPlaybackStartState,
    shouldPlay: state.localShouldBePlaying,
    videoPaused: pair.video.paused,
    audioPaused: pair.audio.paused,
    videoPlayCalls: pair.video.playCalls,
    audioPlayCalls: pair.audio.playCalls,
  };
}
state.lastAppliedPlayerControlSeq = 0;
setRuntime(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  true,
);
const playing = await seek(mountPair({
  intent: true, videoPaused: false, audioPaused: false, startState: "established",
}), 1);
const pausedWithNativeVideoEcho = await seek(mountPair({
  intent: false, videoPaused: false, audioPaused: true, startState: "established",
}), 2);
const autoStarted = await seek(mountPair({
  intent: true, videoPaused: false, audioPaused: false, startState: "starting",
}), 3);
const manuallyStartedPair = mountPair({
  intent: false, videoPaused: true, audioPaused: true, startState: "established",
});
setSplitPlaybackIntent(manuallyStartedPair.video, manuallyStartedPair.audio, true, {
  source: "host-manual-play",
  userGesture: true,
});
await Promise.resolve(); await Promise.resolve();
const manuallyStarted = await seek(manuallyStartedPair, 4);
setRuntime(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  false,
);
const chromiumNativeVideoEcho = await seek(mountPair({
  intent: false, videoPaused: false, audioPaused: true, startState: "established",
}), 5);
console.log(JSON.stringify({
  playing,
  pausedWithNativeVideoEcho,
  autoStarted,
  manuallyStarted,
  chromiumNativeVideoEcho,
}));
""",
            self.clear_seek_source,
            self.seek_lifecycle_source,
            self.sync_source,
            """
function ackRemotePlayerControl() {}
""",
            remote_control_source,
        )
        self.assertEqual(
            result["playing"],
            {
                "startState": "established",
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
            },
        )
        self.assertEqual(
            result["pausedWithNativeVideoEcho"],
            {
                "startState": "established",
                "shouldPlay": False,
                "videoPaused": True,
                "audioPaused": True,
                "videoPlayCalls": 0,
                "audioPlayCalls": 0,
            },
        )
        self.assertEqual(
            result["autoStarted"],
            {
                "startState": "established",
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
            },
        )
        self.assertEqual(
            result["manuallyStarted"],
            {
                "startState": "established",
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 2,
                "audioPlayCalls": 2,
            },
        )
        self.assertEqual(
            result["chromiumNativeVideoEcho"],
            {
                "startState": "established",
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
            },
        )

    def test_tauri_webkit_internal_pause_events_preserve_play_intent(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
global.document = { hidden: false };
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;

holdVideoForAudio(video);
videoPauseListener();
const afterSyncPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
};

video.paused = false; audio.paused = false;
state.localShouldBePlaying = true;
beginSplitPlayerSeek(video, audio, { resumeAfterSeek: true, targetTime: 45 });
videoPauseListener();
console.log(JSON.stringify({
  afterSyncPause,
  afterSeekPause: {
    shouldPlay: state.localShouldBePlaying,
    seekResumePending: state.localSeekResumePending,
    videoPaused: video.paused,
    audioPaused: audio.paused,
  },
}));
""",
            self.clear_seek_source,
            self.seek_lifecycle_source,
            self.sync_source,
            """
const currentItem = { id: "item" };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
let videoPauseListener = null;
function addMountedPlayerListener(media, eventName, listener) {
  media.addEventListener(eventName, listener);
  if (media === video && eventName === "pause") videoPauseListener = listener;
}
function isLocalAdvanceHoldingItem() { return false; }
function stopMountedPlayerForAdvanceDelay() {}
function reportCurrentVideoStatus() {}
function synchronizeStartupPlayer() { return false; }
""",
            self.video_play_pause_event_source,
        )
        self.assertEqual(
            result["afterSyncPause"],
            {"shouldPlay": True, "videoPaused": True, "audioPaused": False},
        )
        self.assertEqual(
            result["afterSeekPause"],
            {
                "shouldPlay": True,
                "seekResumePending": True,
                "videoPaused": True,
                "audioPaused": True,
            },
        )

    def test_tauri_webkit_remote_policy_rejection_still_requires_host_gesture(self):
        remote_control_source = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(30); const audio = new FakeMedia(29.8);
video.play = function() {
  this.playCalls += 1;
  const error = new Error("Host WebView user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("Host WebView user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
mountedVideo = video; mountedAudio = audio;
elements.playerFrame.querySelector = (selector) => {
  if (selector === "video") return video;
  if (selector === 'audio[data-player-role="audio"]') return audio;
  if (selector === ".split-playback-start-overlay") return mountedOverlay;
  return null;
};
state.lastAppliedPlayerControlSeq = 0;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
applyRemotePlayerControl(
  { seq: 1, action: "toggle-play", item_id: "item" },
  { id: "item" },
  "local",
);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            """
function ackRemotePlayerControl() {}
""",
            remote_control_source,
        )
        self.assertEqual(result["startState"], "needs-user-gesture")
        self.assertFalse(result["shouldPlay"])
        self.assertTrue(result["videoPaused"])
        self.assertTrue(result["audioPaused"])
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertIn("video-playback-blocked", result["startupEvents"])

    def test_packaged_tauri_media_session_pause_and_play_follow_logical_intent(self):
        result = self.run_node(
            """
const handlers = {};
const positionStates = [];
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { handlers[action] = handler; },
  setPositionState(value) { positionStates.push(value); },
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(20); const audio = new FakeMedia(19.8);
video.paused = false; audio.paused = false;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;
ensureTauriMediaSessionHandlers();

handlers.pause({});
const afterPause = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPauseCalls: video.pauseCalls,
  audioPauseCalls: audio.pauseCalls,
  playbackState: mediaSession.playbackState,
};
const pausedTicks = [];
for (let index = 0; index < 5; index += 1) {
  pausedTicks.push(syncSplitPlayer(video, audio, 0.2, false));
}

handlers.play({});
await Promise.resolve(); await Promise.resolve();
const afterPlay = {
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  playbackState: mediaSession.playbackState,
};
const playingTicks = [];
for (let index = 0; index < 5; index += 1) {
  playingTicks.push(syncSplitPlayer(video, audio, 0.2, false));
}
console.log(JSON.stringify({
  registeredActions: Object.keys(handlers).sort(),
  afterPause,
  pausedTicks,
  afterPlay,
  playingTicks,
  finalVideoPlayCalls: video.playCalls,
  finalAudioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  positionStates,
}));
""",
            self.sync_source,
        )
        self.assertEqual(
            result["registeredActions"],
            ["nexttrack", "pause", "play", "seekbackward", "seekforward", "seekto"],
        )
        self.assertEqual(
            result["afterPause"],
            {
                "shouldPlay": False,
                "videoPaused": True,
                "audioPaused": True,
                "videoPauseCalls": 1,
                "audioPauseCalls": 1,
                "playbackState": "paused",
            },
        )
        self.assertEqual(set(result["pausedTicks"]), {"pause"})
        self.assertEqual(
            result["afterPlay"],
            {
                "shouldPlay": True,
                "videoPaused": False,
                "audioPaused": False,
                "videoPlayCalls": 1,
                "audioPlayCalls": 1,
                "playbackState": "playing",
            },
        )
        self.assertEqual(result["finalVideoPlayCalls"], 1)
        self.assertEqual(result["finalAudioPlayCalls"], 1)
        self.assertEqual(set(result["playingTicks"]), {"none"})
        self.assertEqual(
            result["startupEvents"],
            ["media-session-pause", "media-session-play"],
        )

    def test_packaged_tauri_media_session_seeks_are_bounded_and_preserve_intent(self):
        result = self.run_node(
            """
const handlers = {};
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { handlers[action] = handler; },
  setPositionState() {},
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
ensureTauriMediaSessionHandlers();

function exercise(action, details, shouldPlay) {
  const video = new FakeMedia(50); const audio = new FakeMedia(49.8);
  mountedVideo = video; mountedAudio = audio;
  state.localPlaybackStartState = "established";
  state.localShouldBePlaying = shouldPlay;
  video.paused = !shouldPlay;
  audio.paused = !shouldPlay;
  handlers[action](details);
  const initial = {
    videoWrites: video.seekWrites,
    audioWrites: audio.seekWrites,
    shouldPlay: state.localShouldBePlaying,
  };
  settleSplitPlayerSeek(video, audio, true);
  return {
    initial,
    finalVideoWrites: video.seekWrites,
    finalAudioWrites: audio.seekWrites,
    finalShouldPlay: state.localShouldBePlaying,
    videoPaused: video.paused,
    audioPaused: audio.paused,
    videoTime: video.currentTime,
    audioTime: audio.currentTime,
  };
}

const backward = exercise("seekbackward", { seekOffset: 10 }, true);
const forward = exercise("seekforward", { seekOffset: 10 }, false);
const absolute = exercise("seekto", { seekTime: 75 }, true);
console.log(JSON.stringify({ backward, forward, absolute,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName) }));
""",
            self.seek_lifecycle_source,
            self.sync_source,
            self.clear_seek_source,
        )
        for action in ("backward", "forward", "absolute"):
            with self.subTest(action=action):
                self.assertEqual(result[action]["initial"]["videoWrites"], 1)
                self.assertEqual(result[action]["initial"]["audioWrites"], 1)
                self.assertEqual(result[action]["finalVideoWrites"], 1)
                self.assertEqual(result[action]["finalAudioWrites"], 1)
        self.assertTrue(result["backward"]["finalShouldPlay"])
        self.assertFalse(result["backward"]["videoPaused"])
        self.assertFalse(result["backward"]["audioPaused"])
        self.assertFalse(result["forward"]["finalShouldPlay"])
        self.assertTrue(result["forward"]["videoPaused"])
        self.assertTrue(result["forward"]["audioPaused"])
        self.assertTrue(result["absolute"]["finalShouldPlay"])
        self.assertAlmostEqual(result["backward"]["videoTime"], 40)
        self.assertAlmostEqual(result["forward"]["videoTime"], 60)
        self.assertAlmostEqual(result["absolute"]["videoTime"], 75)
        self.assertEqual(
            result["startupEvents"],
            [
                "media-session-seek-backward",
                "media-session-seek-forward",
                "media-session-seek-to",
            ],
        )

    def test_packaged_tauri_media_session_resolves_new_song_and_next_track_dynamically(self):
        result = self.run_node(
            """
const handlers = {};
let registrationCalls = 0;
const mediaSession = {
  playbackState: "none",
  setActionHandler(action, handler) { registrationCalls += 1; handlers[action] = handler; },
  setPositionState() {},
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const oldVideo = new FakeMedia(30); const oldAudio = new FakeMedia(29.8);
oldVideo.paused = false; oldAudio.paused = false;
mountedVideo = oldVideo; mountedAudio = oldAudio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = true;
ensureTauriMediaSessionHandlers();
ensureTauriMediaSessionHandlers();

const newVideo = new FakeMedia(0); const newAudio = new FakeMedia(0);
mountedVideo = newVideo; mountedAudio = newAudio;
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
  newVideo,
  newAudio,
  () => false,
);
synchronizeStartupPlayer();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
handlers.pause({});
handlers.nexttrack({});
await Promise.resolve();
console.log(JSON.stringify({
  registrationCalls,
  newStartState: state.localPlaybackStartState,
  newVideoPlayCalls: newVideo.playCalls,
  newAudioPlayCalls: newAudio.playCalls,
  oldVideoPauseCalls: oldVideo.pauseCalls,
  oldAudioPauseCalls: oldAudio.pauseCalls,
  newVideoPauseCalls: newVideo.pauseCalls,
  newAudioPauseCalls: newAudio.pauseCalls,
  nextTrackRequests,
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(
            result,
            {
                "registrationCalls": 6,
                "newStartState": "established",
                "newVideoPlayCalls": 1,
                "newAudioPlayCalls": 1,
                "oldVideoPauseCalls": 0,
                "oldAudioPauseCalls": 0,
                "newVideoPauseCalls": 1,
                "newAudioPauseCalls": 1,
                "nextTrackRequests": 1,
            },
        )

    def test_media_session_ownership_is_packaged_tauri_webkit_only(self):
        result = self.run_node(
            """
function registrationCount(userAgent, tauriPresent) {
  let calls = 0;
  const mediaSession = {
    setActionHandler() { calls += 1; },
    setPositionState() {},
  };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent, mediaSession }, configurable: true, writable: true });
  if (tauriPresent) {
    window.__TAURI__ = { core: {}, webviewWindow: {} };
  } else {
    delete window.__TAURI__;
  }
  state.tauriMediaSessionOwner = null;
  ensureTauriMediaSessionHandlers();
  ensureTauriMediaSessionHandlers();
  return calls;
}
const safari = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  false,
);
const chrome = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  true,
);
const webview2 = registrationCount(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  true,
);
const tauriWebKit = registrationCount(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  true,
);
console.log(JSON.stringify({ safari, chrome, webview2, tauriWebKit }));
""",
            self.sync_source,
        )
        self.assertEqual(
            result,
            {"safari": 0, "chrome": 0, "webview2": 0, "tauriWebKit": 6},
        )

    def test_packaged_tauri_media_session_position_uses_video_master_and_clears(self):
        result = self.run_node(
            """
const positionStates = [];
const mediaSession = {
  playbackState: "none",
  setActionHandler() {},
  setPositionState(value) { positionStates.push(value); },
};
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  mediaSession,
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(33); const audio = new FakeMedia(12);
video.duration = 120; audio.duration = 118;
video.playbackRate = 1.25;
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
syncTauriMediaSessionState(video, { forcePosition: true });
const playingState = mediaSession.playbackState;
state.localShouldBePlaying = false;
syncTauriMediaSessionState(video, { forcePosition: true });
const pausedState = mediaSession.playbackState;
mountedVideo = null; mountedAudio = null;
clearTauriMediaSessionState();
console.log(JSON.stringify({ playingState, pausedState,
  clearedState: mediaSession.playbackState, positionStates }));
""",
            self.sync_source,
        )
        self.assertEqual(result["playingState"], "playing")
        self.assertEqual(result["pausedState"], "paused")
        self.assertEqual(result["clearedState"], "none")
        self.assertEqual(
            result["positionStates"],
            [
                {"duration": 120, "position": 33, "playbackRate": 1.25},
                {"duration": 120, "position": 33, "playbackRate": 1.25},
                {},
            ],
        )

    def test_user_gesture_state_is_only_requested_from_policy_rejections(self):
        video_listener = self.video_play_event_source
        toggle_source = self._slice(
            "function toggleMountedLocalPlayback",
            "function queuePlayerFrameSingleClick",
        )
        remote_control = self._slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        self.assertNotIn("requireSplitPlaybackUserGesture", video_listener)
        self.assertNotIn("requireSplitPlaybackUserGesture", toggle_source)
        self.assertNotIn("requireSplitPlaybackUserGesture", remote_control)
        self.assertEqual(self.source.count("requireSplitPlaybackUserGesture("), 4)
        startup_attempt = self._slice(
            "function startSplitPlaybackPair",
            "function playMediaBestEffort",
        )
        best_effort = self._slice(
            "function playMediaBestEffort",
            "function seekVideoForNavigation",
        )
        self.assertEqual(startup_attempt.count("requireSplitPlaybackUserGesture("), 2)
        self.assertGreaterEqual(startup_attempt.count("isPlaybackPolicyRejection"), 3)
        self.assertEqual(best_effort.count("requireSplitPlaybackUserGesture("), 1)
        self.assertIn("isPlaybackPolicyRejection(error)", best_effort)

    def test_startup_misalignment_is_one_audio_write_and_zero_video_writes(self):
        result = self.run_node(
            """
const video = new FakeMedia(2); const audio = new FakeMedia(10);
video.readyState = 1; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
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
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
console.log(JSON.stringify({ forceCalls, actions,
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls, audioPlayCalls: audio.playCalls,
  videoTime: video.currentTime, audioTime: audio.currentTime,
  videoSeekWrites: video.seekWrites, audioSeekWrites: audio.seekWrites }));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["forceCalls"].count(True), 1)
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertEqual(result["startState"], "established")
        self.assertIn("autoplay-success", result["actions"])
        self.assertEqual(result["videoTime"], 2)
        self.assertAlmostEqual(result["audioTime"], 1.8)
        self.assertEqual(result["videoSeekWrites"], 0)
        self.assertEqual(result["audioSeekWrites"], 1)

    def test_video_autoplay_policy_rejection_requires_one_user_gesture(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localPlaybackStartState = "pending";
video.play = function() {
  this.playCalls += 1;
  const error = new Error("user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  overlayHidden: mountedOverlay.hidden,
  actions,
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["startState"], "needs-user-gesture")
        self.assertFalse(result["shouldPlay"])
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertTrue(result["videoPaused"])
        self.assertTrue(result["audioPaused"])
        self.assertFalse(result["overlayHidden"])
        self.assertIn("autoplay-video-blocked", result["actions"])
        self.assertIn("user-start-required", result["actions"])

    def test_audio_autoplay_policy_rejection_requires_one_user_gesture(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("user activation required");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  actions,
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["startState"], "needs-user-gesture")
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["audioPlayCalls"], 1)
        self.assertIn("autoplay-audio-blocked", result["actions"])

    def test_webkit_startup_records_video_and_audio_play_rejections_separately(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
video.play = function() {
  this.playCalls += 1;
  const error = new Error("video policy rejection");
  error.name = "NotAllowedError";
  return Promise.reject(error);
};
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("audio pipeline aborted");
  error.name = "AbortError";
  return Promise.reject(error);
};
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, playRejections }));
""",
            self.sync_source,
        )
        self.assertEqual(result["startState"], "needs-user-gesture")
        self.assertEqual(
            result["playRejections"],
            [
                {
                    "mediaKind": "video",
                    "eventName": "autoplay-video-play-rejected",
                    "errorName": "NotAllowedError",
                    "errorMessage": "video policy rejection",
                },
                {
                    "mediaKind": "audio",
                    "eventName": "autoplay-audio-play-rejected",
                    "errorName": "AbortError",
                    "errorMessage": "audio pipeline aborted",
                },
            ],
        )

    def test_application_start_invokes_both_media_plays_in_same_click_stack(self):
        result = self.run_node(
            """
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
let insideClickHandler = false;
const activationObservations = [];
video.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["video", insideClickHandler]);
  return Promise.resolve();
};
audio.play = function() {
  this.playCalls += 1; this.paused = false;
  activationObservations.push(["audio", insideClickHandler]);
  return Promise.resolve();
};
insideClickHandler = true;
startSplitPlaybackPair(video, audio, { userGesture: true });
insideClickHandler = false;
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  activationObservations,
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  actions,
}));
""",
            self.sync_source,
        )
        self.assertEqual(
            result["activationObservations"],
            [["video", True], ["audio", True]],
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertIn("user-start-success", result["actions"])
        overlay_source = self._slice(
            "function createSplitPlaybackStartOverlay",
            "function playMediaBestEffort",
        )
        self.assertIn('button.addEventListener("click"', overlay_source)
        self.assertIn(
            "requestSplitPlaybackStartFromUserGesture(video, audio, \"overlay-start-intent\")",
            overlay_source,
        )

    def test_user_start_issues_both_play_calls_even_when_ready_state_below_2(self):
        for video_ready, audio_ready in ((1, 4), (4, 1), (1, 1)):
            with self.subTest(video_ready=video_ready, audio_ready=audio_ready):
                result = self.run_node(
                    f"""
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = {video_ready}; audio.readyState = {audio_ready};
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
const started = startSplitPlaybackPair(video, audio, {{userGesture: true}});
const playCalls = [video.playCalls, audio.playCalls];
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({{
  started,
  playCalls,
  startState: state.localPlaybackStartState,
}}));
""",
                    self.sync_source,
                )
                self.assertTrue(result["started"])
                self.assertEqual(result["playCalls"], [1, 1])
                self.assertEqual(result["startState"], "established")

    def test_pending_without_play_attempt_times_out_to_manual_recovery(self):
        result = self.run_node(
            """
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 0; audio.readyState = 0;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localShouldBePlaying = true;
setSplitPlaybackStartState("pending", video, audio);
const scheduledWatchdogs = watchdogCallbacks.size;
const callback = [...watchdogCallbacks.values()][0];
watchdogCallbacks.clear();
callback();
console.log(JSON.stringify({
  scheduledWatchdogs,
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  playCalls: [video.playCalls, audio.playCalls],
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["scheduledWatchdogs"], 1)
        self.assertEqual(result["startState"], "startup-failed")
        self.assertFalse(result["shouldPlay"])
        self.assertFalse(result["overlayHidden"])
        self.assertEqual(result["playCalls"], [0, 0])
        self.assertIn("startup-timeout-before-play-attempt", result["startupEvents"])

    def test_unsettled_play_promises_time_out_without_retry_storm(self):
        result = self.run_node(
            """
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 1; audio.readyState = 1;
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") mountedOverlay.hidden = Boolean(force); } },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
state.localPlaybackStartState = "needs-user-gesture";
video.play = function() {
  this.playCalls += 1;
  return new Promise(() => {}); // never resolves
};
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {}); // never resolves
};
startSplitPlaybackPair(video, audio, { userGesture: true });
const startStateAfterClick = state.localPlaybackStartState;
const callsAfterClick = [video.playCalls, audio.playCalls];
const tickActions = [];
for (let index = 0; index < 5; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
const callback = [...watchdogCallbacks.values()][0];
watchdogCallbacks.clear();
callback();
console.log(JSON.stringify({
  startStateAfterClick,
  finalState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  overlayHidden: mountedOverlay.hidden,
  callsAfterClick,
  tickActions,
  finalCalls: [video.playCalls, audio.playCalls],
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["startStateAfterClick"], "starting")
        self.assertEqual(result["finalState"], "startup-failed")
        self.assertFalse(result["shouldPlay"])
        self.assertFalse(result["overlayHidden"])
        self.assertEqual(result["callsAfterClick"], [1, 1])
        self.assertEqual(set(result["tickActions"]), {"startup-pending"})
        self.assertEqual(result["finalCalls"], [1, 1])
        self.assertIn("startup-play-promise-timeout", result["startupEvents"])

    def test_resolved_playing_pair_establishes_and_cancels_watchdog(self):
        result = self.run_node(
            """
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
let watchdogClearCalls = 0;
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (watchdogCallbacks.delete(token)) {
    watchdogClearCalls += 1;
  } else {
    nativeClearTimeout(token);
  }
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "pending";
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  activeWatchdogs: watchdogCallbacks.size,
  watchdogClearCalls,
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertFalse(result["videoPaused"])
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["activeWatchdogs"], 0)
        self.assertEqual(result["watchdogClearCalls"], 1)

    def test_stale_pending_watchdog_cannot_fail_newer_start_generation(self):
        result = self.run_node(
            """
const nativeSetTimeout = window.setTimeout;
const nativeClearTimeout = window.clearTimeout;
const watchdogCallbacks = new Map();
window.setTimeout = (callback, delay) => {
  if (delay === splitPlaybackStartupWatchdogMs) {
    const token = {};
    watchdogCallbacks.set(token, callback);
    return token;
  }
  return nativeSetTimeout(callback, delay);
};
window.clearTimeout = (token) => {
  if (!watchdogCallbacks.delete(token)) nativeClearTimeout(token);
};
const video = new FakeMedia(0); const audio = new FakeMedia(0);
video.readyState = 2; audio.readyState = 2;
video.play = function() { this.playCalls += 1; return new Promise(() => {}); };
audio.play = function() { this.playCalls += 1; return new Promise(() => {}); };
mountedVideo = video; mountedAudio = audio;
state.localShouldBePlaying = true;
setSplitPlaybackStartState("pending", video, audio);
const staleWatchdog = [...watchdogCallbacks.values()][0];
startSplitPlaybackPair(video, audio);
const activeWatchdogsBeforeStaleCallback = watchdogCallbacks.size;
staleWatchdog();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  generation: state.localPlaybackStartGeneration,
  activeWatchdogsBeforeStaleCallback,
  activeWatchdogsAfterStaleCallback: watchdogCallbacks.size,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["startState"], "starting")
        self.assertEqual(result["generation"], 1)
        self.assertEqual(result["activeWatchdogsBeforeStaleCallback"], 1)
        self.assertEqual(result["activeWatchdogsAfterStaleCallback"], 1)
        self.assertNotIn("startup-failed", result["startupEvents"])

    def test_superseded_startup_promises_cannot_establish_newer_attempt(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
const videoResolvers = [];
const audioResolvers = [];
video.play = function() {
  this.playCalls += 1;
  return new Promise((resolve) => {
    videoResolvers.push(() => { this.paused = false; resolve(); });
  });
};
audio.play = function() {
  this.playCalls += 1;
  return new Promise((resolve) => {
    audioResolvers.push(() => { this.paused = false; resolve(); });
  });
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
const firstGeneration = state.localPlaybackStartGeneration;

state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
const secondGeneration = state.localPlaybackStartGeneration;

videoResolvers[0](); audioResolvers[0]();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const afterStaleResolution = state.localPlaybackStartState;

videoResolvers[1](); audioResolvers[1]();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  firstGeneration,
  secondGeneration,
  afterStaleResolution,
  finalState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["firstGeneration"], 1)
        self.assertEqual(result["secondGeneration"], 2)
        self.assertEqual(result["afterStaleResolution"], "starting")
        self.assertEqual(result["finalState"], "established")
        self.assertEqual(result["videoPlayCalls"], 2)
        self.assertEqual(result["audioPlayCalls"], 2)

    def test_native_controls_are_unavailable_until_split_start_is_established(self):
        controls_source = self._slice(
            "function clearLocalPlayerControlsHideTimer",
            "function toggleMountedLocalPlayback",
        )
        result = self.run_node(
            """
const video = new FakeMedia(0);
const attributes = new Set();
video.controls = false;
video.setAttribute = (name) => attributes.add(name);
video.removeAttribute = (name) => attributes.delete(name);
const audio = {};
mountedVideo = video;
mountedAudio = audio;
state.localPlaybackStartState = "pending";
revealMountedPlayerControlsForUserInteraction();
const pending = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "starting";
revealMountedPlayerControlsForUserInteraction();
const starting = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "established";
revealMountedPlayerControlsForUserInteraction();
const established = { controls: video.controls, hasAttribute: attributes.has("controls") };
console.log(JSON.stringify({ pending, starting, established }));
""",
            controls_source,
            """
function mountedLocalVideoElement() { return mountedVideo; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
window.setTimeout = () => ({ timer: "controls" });
window.clearTimeout = () => {};
""",
        )
        self.assertEqual(
            result,
            {
                "pending": {"controls": False, "hasAttribute": False},
                "starting": {"controls": False, "hasAttribute": False},
                "established": {"controls": True, "hasAttribute": True},
            },
        )

    def test_player_surface_interactions_reveal_controls_only_after_startup_and_hide_on_leave(self):
        controls_source = self._slice(
            "function clearLocalPlayerControlsHideTimer",
            "function toggleMountedLocalPlayback",
        )
        interaction_source = self._slice(
            '  ["pointerenter", "pointermove", "pointerdown", "touchstart", "focus"].forEach',
            '  addMountedPlayerListener(video, "ended",',
        )
        result = self.run_node(
            """
const attributes = new Set();
const video = new FakeMedia(0);
video.controls = false;
video.setAttribute = (name) => attributes.add(name);
video.removeAttribute = (name) => attributes.delete(name);
mountedVideo = video;
mountedAudio = {};
registerPlayerSurfaceInteractions(video);

state.localPlaybackStartState = "established";
video.dispatchMediaEvent("pointerenter");
const entered = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
const left = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointermove");
const moved = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
video.dispatchMediaEvent("touchstart");
const touched = { controls: video.controls, hasAttribute: attributes.has("controls") };
video.dispatchMediaEvent("pointerleave");
video.dispatchMediaEvent("focus");
const focused = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "pending";
video.dispatchMediaEvent("pointermove");
const pending = { controls: video.controls, hasAttribute: attributes.has("controls") };
state.localPlaybackStartState = "starting";
video.dispatchMediaEvent("touchstart");
const starting = { controls: video.controls, hasAttribute: attributes.has("controls") };
console.log(JSON.stringify({ entered, left, moved, touched, focused, pending, starting }));
""",
            controls_source,
            """
function mountedLocalVideoElement() { return mountedVideo; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
window.setTimeout = () => ({ timer: "controls" });
window.clearTimeout = () => {};
function registerPlayerSurfaceInteractions(video) {
"""
            + interaction_source
            + """
}
""",
        )
        self.assertEqual(
            result,
            {
                "entered": {"controls": True, "hasAttribute": True},
                "left": {"controls": False, "hasAttribute": False},
                "moved": {"controls": True, "hasAttribute": True},
                "touched": {"controls": True, "hasAttribute": True},
                "focused": {"controls": True, "hasAttribute": True},
                "pending": {"controls": False, "hasAttribute": False},
                "starting": {"controls": False, "hasAttribute": False},
            },
        )

    def test_stale_controls_hide_callback_cannot_mutate_a_replacement_video(self):
        controls_source = self._slice(
            "function clearLocalPlayerControlsHideTimer",
            "function toggleMountedLocalPlayback",
        )
        result = self.run_node(
            """
const scheduled = [];
window.setTimeout = (callback) => {
  const timer = { id: scheduled.length + 1 };
  scheduled.push({ timer, callback });
  return timer;
};
window.clearTimeout = () => {};
function makeVideo() {
  const video = new FakeMedia(0);
  const attributes = new Set();
  video.controls = false;
  video.setAttribute = (name) => attributes.add(name);
  video.removeAttribute = (name) => attributes.delete(name);
  video.hasControlsAttribute = () => attributes.has("controls");
  return video;
}
const oldVideo = makeVideo();
mountedVideo = oldVideo;
mountedAudio = {};
state.localPlaybackStartState = "established";
revealMountedPlayerControlsForUserInteraction();

const replacement = makeVideo();
mountedVideo = replacement;
revealMountedPlayerControlsForUserInteraction();
scheduled[0].callback();
const afterStale = {
  controls: replacement.controls,
  hasAttribute: replacement.hasControlsAttribute(),
  activeTimer: scheduled.indexOf(scheduled.find((entry) => entry.timer === state.localPlayerControlsHideTimer)),
};
scheduled[1].callback();
const afterCurrent = {
  controls: replacement.controls,
  hasAttribute: replacement.hasControlsAttribute(),
};
console.log(JSON.stringify({ afterStale, afterCurrent }));
""",
            controls_source,
            """
function mountedLocalVideoElement() { return mountedVideo; }
function presentationCompositionActive() { return false; }
const playerControlsAutoHideMs = 5000;
""",
        )
        self.assertEqual(
            result,
            {
                "afterStale": {"controls": True, "hasAttribute": True, "activeTimer": 1},
                "afterCurrent": {"controls": False, "hasAttribute": False},
            },
        )

    def test_automatic_player_lifecycle_never_requests_native_control_visibility(self):
        renderer = self._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl")
        automatic_renderer = renderer[: renderer.index('  ["pointerenter", "pointermove", "pointerdown", "touchstart", "focus"].forEach')]
        automatic_sources = (
            automatic_renderer,
            self._slice("function mountHostPlaybackSessionElements", "function reconcileHostPlaybackSession"),
            self._slice("function startLocalAdvanceDelay", "function clearLocalAdvanceDelay"),
            self._slice("async function handleSplitVideoEnded", "function holdVideoForAudio"),
            self._slice("function requireSplitPlaybackUserGesture", "function setSplitPlaybackIntent"),
            self._slice("function failSplitPlaybackStartup", "function scheduleWebKitSplitPlaybackRetry"),
            self._slice("function startSplitPlaybackPair", "function playMediaBestEffort"),
            self._slice('document.addEventListener("visibilitychange",', "function handleFullscreenChange"),
            self._slice('window.addEventListener("pageshow",', "startPolling();"),
        )

        mount = automatic_sources[1]
        self.assertIn("video.controls = false", mount)
        self.assertIn('video.removeAttribute("controls")', mount)
        self.assertIn("video.tabIndex = 0", mount)
        self.assertNotIn("showMountedPlayerControls", self.source)
        self.assertEqual(self.source.count("revealMountedPlayerControlsForUserInteraction"), 4)
        for source in automatic_sources:
            self.assertNotIn("revealMountedPlayerControlsForUserInteraction", source)

        teardown = self._slice("function retireHostPlaybackSession", "function replaceHostPlayerView")
        self.assertIn("clearLocalPlayerControlsHideTimer()", teardown)

    def test_policy_rejection_stops_periodic_play_retry_storm(self):
        result = self.run_node(
            """
const video = new FakeMedia(5); const audio = new FakeMedia(5);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "needs-user-gesture";
state.localShouldBePlaying = false;
const tickActions = [];
for (let index = 0; index < 12; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  tickActions,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
""",
            self.sync_source,
        )
        self.assertEqual(set(result["tickActions"]), {"user-start-required"})
        self.assertEqual(result["videoPlayCalls"], 0)
        self.assertEqual(result["audioPlayCalls"], 0)

    def test_established_starvation_hold_and_recovery_still_work(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
mountedVideo = video; mountedAudio = audio;
video.paused = false; audio.paused = false;
state.localPlaybackStartState = "established";
state.localAudioPlaybackBlocked = true;
const held = syncSplitPlayer(video, audio, 0, false);
state.localAudioPlaybackBlocked = false;
nowMs += 1000;
const recovered = syncSplitPlayer(video, audio, 0, true);
await Promise.resolve();
console.log(JSON.stringify({
  held, recovered,
  videoPauseCalls: video.pauseCalls,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  videoSeekWrites: video.seekWrites,
}));
""",
            self.sync_source,
        )
        self.assertEqual(result["held"], "wait-for-audio")
        self.assertEqual(result["recovered"], "resume")
        self.assertEqual(result["videoPauseCalls"], 1)
        self.assertEqual(result["videoPlayCalls"], 1)
        self.assertEqual(result["videoSeekWrites"], 0)

    def test_manual_pause_remains_authoritative_after_pair_is_established(self):
        result = self.run_node(
            """
const video = new FakeMedia(10); const audio = new FakeMedia(10);
mountedVideo = video; mountedAudio = audio;
state.localPlaybackStartState = "established";
state.localShouldBePlaying = false;
const actionsAfterPause = [];
for (let index = 0; index < 5; index += 1) {
  actionsAfterPause.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  actionsAfterPause,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
}));
""",
            self.sync_source,
        )
        self.assertEqual(set(result["actionsAfterPause"]), {"pause"})
        self.assertEqual(result["videoPlayCalls"], 0)
        self.assertEqual(result["audioPlayCalls"], 0)

    def test_song_switch_resets_policy_state_and_attempts_new_pair_once(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15",
}, configurable: true, writable: true });
const oldVideo = new FakeMedia(0); const oldAudio = new FakeMedia(0);
mountedVideo = oldVideo; mountedAudio = oldAudio;
state.localPlaybackStartState = "pending";
oldAudio.play = function() {
  this.playCalls += 1;
  const error = new Error("blocked"); error.name = "NotAllowedError";
  return Promise.reject(error);
};
startSplitPlaybackPair(oldVideo, oldAudio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const oldState = state.localPlaybackStartState;

state.localPlaybackStartState = "idle";
state.localPlaybackStartGeneration = 0;
state.localPlaybackStartPromisesSettled = false;
state.localWebKitStartRetryDone = false;
const newVideo = new FakeMedia(0); const newAudio = new FakeMedia(0);
newVideo.readyState = 1; newAudio.readyState = 1;
mountedVideo = newVideo; mountedAudio = newAudio;
// A new song defaults to play even though the replaced song ended blocked/paused.
state.localShouldBePlaying = true;
setSplitPlaybackStartState("pending", newVideo, newAudio);
const synchronizeNewSong = createSplitPlayerStartupSynchronizer(
  newVideo,
  newAudio,
  () => false,
);
synchronizeNewSong();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  oldState,
  oldCalls: [oldVideo.playCalls, oldAudio.playCalls],
  newState: state.localPlaybackStartState,
  newIntent: state.localShouldBePlaying,
  newCalls: [newVideo.playCalls, newAudio.playCalls],
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["oldState"], "needs-user-gesture")
        self.assertEqual(result["oldCalls"], [1, 1])
        self.assertEqual(result["newState"], "established")
        self.assertTrue(result["newIntent"])
        self.assertEqual(result["newCalls"], [1, 1])
        teardown = self._slice("function retireHostPlaybackSession", "function replaceHostPlayerView")
        renderer = self._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl")
        self.assertIn('state.localPlaybackStartState = "idle"', teardown)
        self.assertIn('setSplitPlaybackStartState("pending", video, audio)', renderer)

    def test_only_one_player_renderer_and_one_sync_interval_remain(self):
        self.assertEqual(self.source.count("function renderPlayer(currentItem, playbackMode)"), 1)
        renderer = self._slice("function renderPlayer(currentItem, playbackMode)", "function applyRemotePlayerControl")
        self.assertEqual(renderer.count("state.localPlayerSyncTimer = window.setInterval"), 1)
        self.assertIn("clearLocalPlayerEventListeners(session)", self.source)

    def test_frontend_has_no_duplicate_active_function_declarations(self):
        pattern = re.compile(r"^(?:async )?function ([A-Za-z0-9_]+)", re.MULTILINE)
        for name, source in (("host", self.source), ("remote", self.remote_source)):
            declarations = pattern.findall(source)
            duplicates = sorted(
                declaration for declaration in set(declarations) if declarations.count(declaration) > 1
            )
            self.assertEqual(duplicates, [], name)

    def test_webkit_detection(self):
        result = self.run_node(
            """
const safariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const wkWebviewUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const macChromeUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const winEdgeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

Object.defineProperty(globalThis, "navigator", { value: { userAgent: safariUA }, configurable: true, writable: true });
const safariResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: wkWebviewUA }, configurable: true, writable: true });
const wkResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: macChromeUA }, configurable: true, writable: true });
const macChromeResult = isWebKitPlaybackRuntime();

Object.defineProperty(globalThis, "navigator", { value: { userAgent: winEdgeUA }, configurable: true, writable: true });
const winEdgeResult = isWebKitPlaybackRuntime();

console.log(JSON.stringify({ safariResult, wkResult, macChromeResult, winEdgeResult }));
""",
        )
        self.assertEqual(result, {"safariResult": True, "wkResult": True, "macChromeResult": False, "winEdgeResult": False})

    def test_webkit_sync_thresholds(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(29.80);
video.paused = false; audio.paused = false;
const smallDriftAction = syncSplitPlayer(video, audio, 0.0, false);
const smallAudioWrites = audio.seekWrites;

audio._time = 29.30;
const largeDriftAction = syncSplitPlayer(video, audio, 0.0, false);
const largeAudioWrites = audio.seekWrites;

console.log(JSON.stringify({ smallDriftAction, smallAudioWrites, largeDriftAction, largeAudioWrites, videoWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result, {
            "smallDriftAction": "none",
            "smallAudioWrites": 0,
            "largeDriftAction": "audio-drift-correction",
            "largeAudioWrites": 1,
            "videoWrites": 0,
        })

    def test_webkit_short_video_waiting_recovers_without_pausing_or_seeking_audio(self):
        event_source = f"""
function addMountedPlayerListener(media, eventName, listener) {{ media.addEventListener(eventName, listener); }}
function registerVideoRecoveryListeners(video, audio, synchronizeStartupPlayer) {{
{self.video_recovery_event_source}
}}
"""
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(15); const audio = new FakeMedia(14.98);
video.paused = false; audio.paused = false;
let syncCalls = 0; const forceCalls = [];
const productionSync = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  syncCalls += 1; forceCalls.push(Boolean(args[3])); return productionSync(...args);
};
function updateSplitPlaybackStartOverlay() {}
function settleSplitPlayerSeek() { return false; }
registerVideoRecoveryListeners(video, audio, () => false);
video.readyState = 1;
video.dispatchMediaEvent("waiting");
const pausedDuringWait = audio.paused;
const waitingAction = syncSplitPlayer(video, audio, 0, false);
video.readyState = 4;
video.dispatchMediaEvent("canplay");
await Promise.resolve();
console.log(JSON.stringify({ pausedDuringWait, waitingAction, syncCalls, forceCalls,
  audioPaused: audio.paused, audioPauseCalls: audio.pauseCalls,
  audioPlayCalls: audio.playCalls, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
            event_source,
        )
        self.assertFalse(result["pausedDuringWait"])
        self.assertEqual(result["waitingAction"], "wait-for-video")
        self.assertEqual(result["syncCalls"], 2)
        self.assertEqual(result["forceCalls"], [False, False])
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["audioPauseCalls"], 0)
        self.assertEqual(result["audioPlayCalls"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)
        self.assertEqual(result["videoSeekWrites"], 0)

    def test_webkit_video_waiting_bursts_do_not_create_command_storm(self):
        event_source = f"""
function addMountedPlayerListener(media, eventName, listener) {{ media.addEventListener(eventName, listener); }}
function registerVideoRecoveryListeners(video, audio, synchronizeStartupPlayer) {{
{self.video_recovery_event_source}
}}
"""
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(15); const audio = new FakeMedia(14.98);
video.paused = false; audio.paused = false;
let syncCalls = 0; const forceCalls = [];
const productionSync = syncSplitPlayer;
syncSplitPlayer = (...args) => {
  syncCalls += 1; forceCalls.push(Boolean(args[3])); return productionSync(...args);
};
function updateSplitPlaybackStartOverlay() {}
function settleSplitPlayerSeek() { return false; }
registerVideoRecoveryListeners(video, audio, () => false);
for (let index = 0; index < 5; index += 1) {
  video.readyState = 1;
  video.dispatchMediaEvent("waiting");
  syncSplitPlayer(video, audio, 0, false);
  video.readyState = 4;
  video.dispatchMediaEvent("canplay");
}
await Promise.resolve();
console.log(JSON.stringify({ syncCalls, forceCalls, audioPauseCalls: audio.pauseCalls,
  audioPlayCalls: audio.playCalls, audioSeekWrites: audio.seekWrites,
  videoPauseCalls: video.pauseCalls, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
            event_source,
        )
        self.assertEqual(result["syncCalls"], 10)
        self.assertNotIn(True, result["forceCalls"])
        self.assertEqual(result["audioPauseCalls"], 0)
        self.assertEqual(result["audioPlayCalls"], 0)
        self.assertEqual(result["audioSeekWrites"], 0)
        self.assertEqual(result["videoPauseCalls"], 0)
        self.assertEqual(result["videoPlayCalls"], 0)
        self.assertEqual(result["videoSeekWrites"], 0)

    def test_webkit_starvation_recovery_defers_large_correction_to_later_tick(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(27);
video.paused = false; audio.paused = false;
state.localVideoDeferredRecovery = true;
const recoveryAction = syncSplitPlayer(video, audio, 0, true);
const recoveryWrites = audio.seekWrites;
nowMs += 120;
const laterAction = syncSplitPlayer(video, audio, 0, false);
nowMs += 120;
const cooldownAction = syncSplitPlayer(video, audio, 0, false);
console.log(JSON.stringify({ recoveryAction, recoveryWrites, laterAction, cooldownAction,
  audioTime: audio.currentTime, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result["recoveryAction"], "resume")
        self.assertEqual(result["recoveryWrites"], 0)
        self.assertEqual(result["laterAction"], "audio-drift-correction")
        self.assertEqual(result["cooldownAction"], "none")
        self.assertEqual(result["audioSeekWrites"], 1)
        self.assertEqual(result["videoSeekWrites"], 0)

    def test_webkit_force_correction_does_not_bypass_hard_threshold(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(30); const audio = new FakeMedia(29.98);
video.paused = false; audio.paused = false;
const action = syncSplitPlayer(video, audio, 0, true);
console.log(JSON.stringify({ action, audioSeekWrites: audio.seekWrites,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result, {
            "action": "none",
            "audioSeekWrites": 0,
            "videoSeekWrites": 0,
        })

    def test_pending_best_effort_play_is_bounded_per_media_element(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(20); const audio = new FakeMedia(20);
video.paused = false; audio.paused = true;
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {});
};
for (let index = 0; index < 12; index += 1) {
  syncSplitPlayer(video, audio, 0, false);
}
console.log(JSON.stringify({ audioPlayCalls: audio.playCalls,
  audioSeekWrites: audio.seekWrites, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result, {
            "audioPlayCalls": 1,
            "audioSeekWrites": 0,
            "videoPlayCalls": 0,
            "videoSeekWrites": 0,
        })

    def test_chromium_pending_best_effort_play_behavior_is_unchanged(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0" }, configurable: true, writable: true });
const video = new FakeMedia(20); const audio = new FakeMedia(20);
video.paused = false; audio.paused = true;
audio.play = function() {
  this.playCalls += 1;
  return new Promise(() => {});
};
for (let index = 0; index < 3; index += 1) {
  syncSplitPlayer(video, audio, 0, false);
}
console.log(JSON.stringify({ audioPlayCalls: audio.playCalls,
  audioSeekWrites: audio.seekWrites, videoPlayCalls: video.playCalls,
  videoSeekWrites: video.seekWrites }));
""",
            self.sync_source,
        )
        self.assertEqual(result, {
            "audioPlayCalls": 3,
            "audioSeekWrites": 0,
            "videoPlayCalls": 0,
            "videoSeekWrites": 0,
        })

    def test_webkit_seek_single_transaction(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(10); const audio = new FakeMedia(10);
video.paused = false; audio.paused = false;
beginSplitPlayerSeek(video, audio, { targetTime: 20, resumeAfterSeek: true });
const initialVideoWrites = video.seekWrites;
const initialAudioWrites = audio.seekWrites;

// Settle polling
settleSplitPlayerSeek(video, audio);
const pollAudioWrites = audio.seekWrites;

// Complete seek
video.seeking = false; audio.seeking = false; video.readyState = 4; audio.readyState = 4;
settleSplitPlayerSeek(video, audio, true);
const finalAudioWrites = audio.seekWrites;

console.log(JSON.stringify({ initialVideoWrites, initialAudioWrites, pollAudioWrites, finalAudioWrites }));
""",
            self.sync_source,
            self.seek_lifecycle_source,
            self.clear_seek_source,
            self._slice("function targetAudioTimeFromVideo", "function mediaUrlBasename"),
        )
        self.assertEqual(result, {
            "initialVideoWrites": 1,
            "initialAudioWrites": 1,
            "pollAudioWrites": 1,
            "finalAudioWrites": 1,
        })

    def test_webkit_startup_abort_error_does_not_trigger_user_gesture(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
audio.play = function() {
  const err = new Error("aborted"); err.name = "AbortError";
  return Promise.reject(err);
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, shouldBePlaying: state.localShouldBePlaying }));
""",
            self.sync_source,
            self._slice("function startSplitPlaybackPair", "function playMediaBestEffort"),
        )
        self.assertNotEqual(result["startState"], "needs-user-gesture")
        self.assertTrue(result["shouldBePlaying"])

    def test_webkit_startup_abort_error_retries_once_then_establishes(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
let audioAttempts = 0;
audio.play = function() {
  this.playCalls += 1;
  audioAttempts += 1;
  if (audioAttempts === 1) {
    const error = new Error("initial audio load interrupted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  this.paused = false;
  return Promise.resolve();
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  rejectionNames: playRejections.map((entry) => entry.errorName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["startState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertFalse(result["videoPaused"])
        self.assertFalse(result["audioPaused"])
        self.assertEqual(result["videoPlayCalls"], 2)
        self.assertEqual(result["audioPlayCalls"], 2)
        self.assertTrue(result["overlayHidden"])
        self.assertEqual(result["rejectionNames"], ["AbortError"])
        self.assertEqual(
            result["startupEvents"],
            [
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-retry-scheduled",
                "autoplay-retry-attempt",
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-audio-play-resolved",
                "autoplay-retry-success",
                "autoplay-success",
            ],
        )

    def test_webkit_startup_retry_waits_for_stable_readiness(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
let audioAttempts = 0;
audio.play = function() {
  this.playCalls += 1;
  audioAttempts += 1;
  if (audioAttempts === 1) {
    this.readyState = 1;
    const error = new Error("audio load replaced");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  this.paused = false;
  return Promise.resolve();
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 70));
const beforeReady = {
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
};
audio.readyState = 4;
audio.dispatchMediaEvent("canplay");
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  beforeReady,
  finalState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(
            result["beforeReady"],
            {"startState": "pending", "videoPlayCalls": 1, "audioPlayCalls": 1},
        )
        self.assertEqual(result["finalState"], "established")
        self.assertEqual(result["videoPlayCalls"], 2)
        self.assertEqual(result["audioPlayCalls"], 2)
        self.assertIn("autoplay-retry-attempt", result["startupEvents"])
        self.assertIn("autoplay-retry-success", result["startupEvents"])

    def test_webkit_startup_non_policy_retry_exhaustion_is_recoverable_failure(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
audio.play = function() {
  this.playCalls += 1;
  const error = new Error(`audio pipeline interrupted ${this.playCalls}`);
  error.name = "AbortError";
  return Promise.reject(error);
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
const tickActions = [];
for (let index = 0; index < 5; index += 1) {
  tickActions.push(syncSplitPlayer(video, audio, 0, false));
}
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  tickActions,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
  rejectionNames: playRejections.map((entry) => entry.errorName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["startState"], "startup-failed")
        self.assertFalse(result["shouldPlay"])
        self.assertTrue(result["videoPaused"])
        self.assertTrue(result["audioPaused"])
        self.assertEqual(result["videoPlayCalls"], 2)
        self.assertEqual(result["audioPlayCalls"], 2)
        self.assertFalse(result["overlayHidden"])
        self.assertEqual(set(result["tickActions"]), {"startup-failed"})
        self.assertEqual(result["rejectionNames"], ["AbortError", "AbortError"])
        self.assertEqual(
            result["startupEvents"],
            [
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-retry-scheduled",
                "autoplay-retry-attempt",
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-retry-exhausted",
                "startup-failed",
            ],
        )

    def test_webkit_startup_failed_overlay_allows_manual_recovery(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
audio.play = function() {
  this.playCalls += 1;
  const error = new Error("temporary audio failure");
  error.name = "AbortError";
  return Promise.reject(error);
};
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
effectiveOffsetSeconds = 0;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
const failed = {
  startState: state.localPlaybackStartState,
  overlayHidden: mountedOverlay.hidden,
};

audio.play = function() {
  this.playCalls += 1;
  this.paused = false;
  return Promise.resolve();
};
startSplitPlaybackPair(video, audio, { userGesture: true });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  failed,
  finalState: state.localPlaybackStartState,
  shouldPlay: state.localShouldBePlaying,
  videoPaused: video.paused,
  audioPaused: audio.paused,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(
            result["failed"],
            {"startState": "startup-failed", "overlayHidden": False},
        )
        self.assertEqual(result["finalState"], "established")
        self.assertTrue(result["shouldPlay"])
        self.assertFalse(result["videoPaused"])
        self.assertFalse(result["audioPaused"])
        self.assertTrue(result["overlayHidden"])
        self.assertIn("user-start-success", result["startupEvents"])

    def test_webkit_resolved_but_paused_pair_is_not_established(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
}, configurable: true, writable: true });
window.__TAURI__ = { core: {}, webviewWindow: {} };
const video = new FakeMedia(0); const audio = new FakeMedia(0);
mountedVideo = video; mountedAudio = audio;
mountedOverlay = {
  hidden: true,
  classList: { toggle(name, force) { if (name === "hidden") this.owner.hidden = Boolean(force); }, owner: null },
  setAttribute() {},
  querySelector() { return { disabled: false, textContent: "", removeAttribute() {} }; },
};
mountedOverlay.classList.owner = mountedOverlay;
video.play = function() { this.playCalls += 1; return Promise.resolve(); };
audio.play = function() { this.playCalls += 1; return Promise.resolve(); };
state.localPlaybackStartState = "pending";
state.localShouldBePlaying = true;
startSplitPlaybackPair(video, audio);
await new Promise((resolve) => setTimeout(resolve, 90));
await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({
  startState: state.localPlaybackStartState,
  videoPlayCalls: video.playCalls,
  audioPlayCalls: audio.playCalls,
  overlayHidden: mountedOverlay.hidden,
  startupEvents: startupDiagnostics.map((entry) => entry.eventName),
}));
""",
            self.sync_source,
            self.startup_source,
        )
        self.assertEqual(result["startState"], "startup-failed")
        self.assertEqual(result["videoPlayCalls"], 2)
        self.assertEqual(result["audioPlayCalls"], 2)
        self.assertFalse(result["overlayHidden"])
        self.assertEqual(
            result["startupEvents"],
            [
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-audio-play-resolved",
                "autoplay-resolved-but-still-paused",
                "autoplay-retry-scheduled",
                "autoplay-retry-attempt",
                "autoplay-attempt",
                "autoplay-video-play-resolved",
                "autoplay-audio-play-resolved",
                "autoplay-resolved-but-still-paused",
                "resolved-but-still-paused",
                "startup-failed",
            ],
        )

    def test_webkit_startup_not_allowed_error_triggers_user_gesture(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" }, configurable: true, writable: true });
const video = new FakeMedia(0); const audio = new FakeMedia(0);
audio.play = function() {
  const err = new Error("NotAllowedError"); err.name = "NotAllowedError";
  return Promise.reject(err);
};
state.localPlaybackStartState = "pending";
startSplitPlaybackPair(video, audio);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
console.log(JSON.stringify({ startState: state.localPlaybackStartState, shouldBePlaying: state.localShouldBePlaying }));
""",
            self.sync_source,
            self._slice("function startSplitPlaybackPair", "function playMediaBestEffort"),
        )
        self.assertEqual(result["startState"], "needs-user-gesture")
        self.assertFalse(result["shouldBePlaying"])

    def test_tauri_webkit_fullscreen_fallback(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)" }, configurable: true, writable: true });
global.window.__TAURI__ = { window: {}, core: {} };
let classAdded = false;
let bodyClassAdded = false;
elements.playerPanel = {
  classList: {
    contains(c) { return c === "is-tauri-fullscreen" ? classAdded : false; },
    add(c) { if (c === "is-tauri-fullscreen") classAdded = true; },
    remove(c) { if (c === "is-tauri-fullscreen") classAdded = false; },
  }
};
global.document = {
  body: {
    classList: {
      add(c) { if (c === "is-tauri-fullscreen-active") bodyClassAdded = true; },
      remove(c) { if (c === "is-tauri-fullscreen-active") bodyClassAdded = false; },
    }
  }
};

const isTauriWK = isTauriWebKitRuntime();
const supportsFS = supportsPlayerFullscreen();

console.log(JSON.stringify({ isTauriWK, supportsFS }));
""",
            self._slice("function isWebKitPlaybackRuntime()", "function tauriInvoke()"),
        )
        self.assertTrue(result["isTauriWK"])
        self.assertTrue(result["supportsFS"])

    def test_chromium_freeze_unchanged(self):
        result = self.run_node(
            """
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0" }, configurable: true, writable: true });
global.window.__TAURI__ = { window: {}, core: {} };

const isWebKit = isWebKitPlaybackRuntime();
const isTauriWK = isTauriWebKitRuntime();

console.log(JSON.stringify({ isWebKit, isTauriWK }));
""",
            self._slice("function isWebKitPlaybackRuntime()", "function tauriInvoke()"),
        )
        self.assertFalse(result["isWebKit"])
        self.assertFalse(result["isTauriWK"])


if __name__ == "__main__":
    unittest.main()
