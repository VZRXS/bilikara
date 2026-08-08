import unittest
from pathlib import Path


class PlayerDiagnosticsOnlyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.app_source = (cls.repo_root / "static" / "app.js").read_text(encoding="utf-8")
        cls.index_source = (cls.repo_root / "static" / "index.html").read_text(encoding="utf-8")

    def function_source(self, start_marker: str, end_marker: str) -> str:
        start = self.app_source.index(start_marker)
        end = self.app_source.index(end_marker, start)
        return self.app_source[start:end]

    def test_player_health_control_module_is_removed(self):
        self.assertFalse((self.repo_root / "static" / "player-health.js").exists())
        self.assertNotIn("/player-health.js", self.index_source)
        for obsolete_name in (
            "splitPlaybackMetrics",
            "pauseSplitPlaybackForFault",
            "handleSplitPlaybackFault",
            "recordSplitMediaIssue",
            "attachSplitPlaybackFaultHandlers",
            "playbackFaultItemId",
            "playbackFaultRetryByItem",
            "mediaIssueEventsByKey",
            "BilikaraPlayerHealth",
        ):
            self.assertNotIn(obsolete_name, self.app_source)

    def test_all_media_health_events_are_attached_to_diagnostics(self):
        diagnostics = self.function_source(
            "function attachSplitPlayerDiagnostics",
            "async function handleSplitVideoEnded",
        )
        self.assertIn(
            '["loadedmetadata", "canplay", "waiting", "stalled", "suspend", "error", "ended"]',
            diagnostics,
        )
        self.assertIn('reportMediaDiagnostic(itemId, "video"', diagnostics)
        self.assertIn('reportMediaDiagnostic(itemId, "audio"', diagnostics)

    def test_media_diagnostics_are_best_effort_and_report_useful_fields(self):
        diagnostics = self.function_source(
            "function splitVideoFrameStats",
            "function attachSplitPlayerDiagnostics",
        )
        for field in (
            "item_id",
            "media_kind",
            "event",
            "current_time",
            "duration",
            "ready_state",
            "network_state",
            "paused",
            "ended",
            "seeking",
            "playback_rate",
            "buffered_end",
            "audio_current_time",
            "video_current_time",
            "target_video_time",
            "drift_seconds",
            "effective_av_delay_seconds",
            "synchronization_action",
            "dropped_video_frames",
            "total_video_frames",
            "error_code",
            "error_message",
            "url_basename",
        ):
            self.assertIn(field, diagnostics)
        self.assertIn('apiPost("/api/player/diagnostic", payload).catch(() => {})', diagnostics)

    def test_health_events_have_no_control_side_effects(self):
        diagnostics = self.function_source(
            "function reportMediaDiagnostic",
            "async function handleSplitVideoEnded",
        )
        for forbidden in (
            "/api/cache/retry",
            "playerSignature",
            "render()",
            ".pause()",
            "setAppMessage(",
        ):
            self.assertNotIn(forbidden, diagnostics)
        for event_name in ("waiting", "stalled", "suspend", "error"):
            self.assertNotIn(f'addEventListener("{event_name}"', self.app_source)

    def test_audio_ended_is_the_authoritative_completion_event(self):
        sync_source = self.function_source(
            "function syncSplitPlayer",
            "function syncMountedLocalPlayer",
        )
        self.assertIn("if (audio.ended) {", sync_source)
        ended_guard = sync_source[sync_source.index("if (audio.ended)"):]
        ended_guard = ended_guard[:ended_guard.index("}")]
        self.assertNotIn("audio.play(", ended_guard)
        self.assertNotIn("audio.pause(", ended_guard)
        self.assertIn('addMountedPlayerListener(audio, "ended"', self.app_source)

    def test_video_ended_defers_to_audio_and_audio_completion_advances_once(self):
        handler = self.function_source(
            "async function handleSplitVideoEnded",
            "function syncSplitPlayer",
        )
        self.assertIn("if (!audio.ended)", handler)
        self.assertIn('"defer-video-recovery"', handler)
        self.assertIn("state.localPlaybackEndHandled", handler)
        self.assertEqual(handler.count('handleLocalPlaybackEnded("media-ended")'), 1)
        self.assertNotIn("audio.pause()", handler)
        self.assertNotIn("cache/retry", handler)
        self.assertNotIn("render()", handler)

    def test_media_events_cannot_retry_cache(self):
        diagnostic_start = self.app_source.index("function reportMediaDiagnostic")
        player_start = self.app_source.index("function renderPlayer", diagnostic_start)
        player_end = self.app_source.index("function applyRemotePlayerControl", player_start)
        player_source = self.app_source[diagnostic_start:player_end]
        self.assertNotIn("/api/cache/retry", player_source)

    def test_manual_current_cache_retry_remains_forced(self):
        self.assertIn(
            'apiPost("/api/cache/retry", { item_id: itemId, force: true })',
            self.app_source,
        )
        self.assertIn(
            'item_id: currentItem.id,\n      force: true,',
            self.app_source,
        )

    def test_offset_changes_resync_audio_only_when_effective_value_changes(self):
        offset_handler = self.function_source(
            "async function setAvOffset",
            "function updateCacheSliderFill",
        )
        snapshot_handler = self.function_source(
            "async function fetchState",
            "function renderSignatureForData",
        )
        self.assertIn("resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs)", offset_handler)
        self.assertIn("resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs)", snapshot_handler)
        resync_handler = self.function_source(
            "function resyncMountedLocalPlayerForOffsetChange",
            "function applyStoredVolumeToSinglePlayer",
        )
        self.assertIn(
            "Number(video.currentTime || 0) - currentAvOffsetSeconds()",
            resync_handler,
        )
        self.assertIn("setMediaCurrentTime(audio, targetAudioTime)", resync_handler)
        self.assertIn('"av-delay-audio-resync"', resync_handler)
        self.assertIn("if (Number(previousOffsetMs) === currentAvOffsetMs())", resync_handler)
        self.assertEqual(resync_handler.count("resyncMountedLocalPlayerForOffsetChange();"), 1)
        self.assertNotIn("beginSplitPlayerSeek", resync_handler)
        self.assertNotIn("seekVideoForNavigation", resync_handler)
        self.assertNotIn("setMediaCurrentTime(video", resync_handler)


if __name__ == "__main__":
    unittest.main()
