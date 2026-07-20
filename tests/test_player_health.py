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
            "handleSplitAudioEnded",
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
            "function reportMediaDiagnostic",
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

    def test_audio_ended_only_stops_future_audio_sync(self):
        sync_source = self.function_source(
            "function syncSplitPlayer",
            "function syncMountedLocalPlayer",
        )
        self.assertIn("if (audio.ended) {", sync_source)
        ended_guard = sync_source[sync_source.index("if (audio.ended)"):]
        ended_guard = ended_guard[:ended_guard.index("}")]
        self.assertNotIn("audio.play(", ended_guard)
        self.assertNotIn("audio.pause(", ended_guard)
        self.assertNotIn('audio.addEventListener("ended"', self.app_source)

    def test_video_ended_uses_normal_path_exactly_once(self):
        handler = self.function_source(
            "async function handleSplitVideoEnded",
            "function syncSplitPlayer",
        )
        self.assertIn('video.dataset.bilikaraEndedHandled === "true"', handler)
        self.assertEqual(handler.count('handleLocalPlaybackEnded("media-ended")'), 1)
        self.assertEqual(handler.count("audio.pause()"), 1)
        self.assertEqual(handler.count("reportStatus()"), 1)
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

    def test_offset_changes_and_remote_snapshots_keep_seek_settling(self):
        offset_handler = self.function_source(
            "async function setAvOffset",
            "function updateCacheSliderFill",
        )
        snapshot_handler = self.function_source(
            "async function fetchState",
            "function renderSignatureForData",
        )
        self.assertIn("resyncMountedLocalPlayerForOffsetChange()", offset_handler)
        self.assertIn("resyncMountedLocalPlayerForOffsetChange()", snapshot_handler)


if __name__ == "__main__":
    unittest.main()
