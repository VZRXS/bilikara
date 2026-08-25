import hashlib
import io
import json
import os
import queue
import shutil
import ssl
import stat
import subprocess
import sys
import tarfile
import threading
import unittest
import urllib.error
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bilikara import rust_backend, rust_runtime
from bilikara.cache import (
    CachePlan,
    CacheManager,
    DOWNLOAD_SOURCE_BBDOWN,
    DOWNLOAD_SOURCE_DOWNKYI,
    DOWNLOAD_SOURCE_NATIVE,
    DOWNLOAD_SOURCE_YTDLP,
    DownloadCommandError,
    SOURCE_AUDIO_DURATION_TOLERANCE_SECONDS,
    VIDEO_QUALITY_CHOICES,
)
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


def begin_cache_attempt(store: PlaylistStore, item_id: str) -> int:
    observed = store.get_item(item_id)
    if observed is None:
        raise AssertionError(f"missing cache item fixture: {item_id}")
    return store.begin_cache_attempt(item_id, observed.item_incarnation_id)


class CacheManagerOutputTest(unittest.TestCase):
    def test_prewarm_prepares_legacy_tools_without_overriding_runtime_status(self):
        manager = CacheManager.__new__(CacheManager)
        manager.lock = threading.RLock()
        manager.binary_state = "failed"
        manager.binary_version = ""
        manager.binary_message = "stale BBDown failure"
        manager.ffmpeg_state = "failed"
        manager.ffmpeg_version = ""
        manager.ffmpeg_message = "stale FFmpeg failure"
        with patch.object(
            manager,
            "_ensure_bbdown",
            return_value=Path("BBDown"),
        ) as ensure_bbdown, patch.object(
            manager,
            "_ensure_ffmpeg",
            return_value=Path("ffmpeg"),
        ) as ensure_ffmpeg:
            manager._prewarm_binary_worker()

        ensure_bbdown.assert_called_once_with()
        ensure_ffmpeg.assert_called_once_with(force_refresh=True)
        self.assertEqual(manager.binary_state, "failed")
        self.assertEqual(manager.binary_message, "stale BBDown failure")
        self.assertEqual(manager.ffmpeg_state, "failed")
        self.assertEqual(manager.ffmpeg_message, "stale FFmpeg failure")

    def test_diagnostic_snapshot_preserves_frontend_service_failure_reason(self):
        manager = CacheManager.__new__(CacheManager)
        manager.lock = threading.RLock()
        manager.active_item_id = "item-1"
        manager.urgent_cache_ids = set()
        manager.pending_ids = {"item-1"}
        manager.ordered_desired_ids = ["item-1"]
        manager.tasks = queue.Queue()
        manager.binary_state = "failed"
        manager.binary_version = ""
        manager.binary_message = "legacy BBDown prewarm failed"
        manager.ffmpeg_state = "ready"
        manager.ffmpeg_version = "ffmpeg 7"
        manager.ffmpeg_message = "FFmpeg ready"
        manager.max_cache_items = 3
        manager.download_source = DOWNLOAD_SOURCE_NATIVE
        manager.media_capabilities = {}
        manager.client_media_capabilities = {}
        runtime = {
            "loaded": True,
            "path": "C:/bundle/rust/bilikara_runtime.dll",
            "error": "",
            "abi_version": 1,
            "capabilities": {"http_download": True, "media_backend": True},
            "load_diagnostics": {"stage": "ready"},
        }

        with patch("bilikara.cache.rust_runtime.runtime_status", return_value=runtime), patch.object(
            manager,
            "bbdown_login_status",
            return_value={"state": "idle", "logged_in": False},
        ):
            snapshot = manager.diagnostic_snapshot()

        native = snapshot["tools"]["Rust Native"]
        media = snapshot["tools"]["Rust MediaBackend"]
        bbdown = snapshot["tools"]["BBDown"]
        self.assertEqual(bbdown["state"], "failed")
        self.assertEqual(native["state"], "ready")
        self.assertEqual(native["message"], "Rust Native ready")
        self.assertEqual(native["runtime_state"], "ready")
        self.assertEqual(media["state"], "ready")
        self.assertEqual(media["message"], "Rust MediaBackend ready")

    def test_iter_output_messages_handles_carriage_return_updates(self):
        stream = io.StringIO("0%\r14.5%\r89.1%\n下载完成\n")
        self.assertEqual(
            list(CacheManager._iter_output_messages(stream)),
            ["0%", "14.5%", "89.1%", "下载完成"],
        )

    def test_iter_output_messages_handles_backspace_rewrites(self):
        stream = io.StringIO("0%\b\b15%\b\b\b30%\n完成\n")
        self.assertEqual(
            list(CacheManager._iter_output_messages(stream)),
            ["0%", "15%", "30%", "完成"],
        )

    def test_extract_progress_ignores_ansi_escape_sequences(self):
        line = "\x1b[32m52.6 %\x1b[0m 正在下载"
        normalized = CacheManager._normalize_output_line(line)
        self.assertEqual(normalized, "52.6 % 正在下载")
        self.assertEqual(CacheManager._extract_progress(normalized), 52.6)

    def test_display_message_compacts_progress_logs(self):
        self.assertEqual(CacheManager._display_message("[###] 42% / - 5 MB/s", 42.0), "缓存中 42%")

    def test_selected_stream_size_hint_reads_selected_video_size(self):
        line = "[视频] [1080P 高清] [1920x1080] [AVC] [30.002] [2410 kbps] [~71.78 MB]"
        self.assertEqual(
            CacheManager._selected_stream_size_hint_bytes(line, "video"),
            int(71.78 * 1024 * 1024),
        )
        self.assertEqual(CacheManager._selected_stream_size_hint_bytes(line, "audio"), 0)

        # Test aria2c progress log parsing
        aria_line = "[#23e8fe 96KiB/2.3MiB(3%) CN:1 DL:53KiB ETA:43s]"
        self.assertEqual(
            CacheManager._selected_stream_size_hint_bytes(aria_line, "video"),
            int(2.3 * 1024 * 1024),
        )

        self.assertEqual(
            CacheManager._selected_stream_size_hint_bytes("[#111111 0B/150MB(0%)", "video"),
            150 * 1024 * 1024,
        )

        self.assertEqual(
            CacheManager._selected_stream_size_hint_bytes("[#222222 10M/163.5M(6%)", "video"),
            int(163.5 * 1024 * 1024),
        )

    def test_aria2_progress_reads_exact_raw_byte_counts(self):
        self.assertEqual(
            CacheManager._aria2_progress_bytes(
                "[#23e8fe 1048576B/10485760B(10%) CN:8 DL:524288B]"
            ),
            (1048576, 10485760, 10.0),
        )

    def test_aria2_progress_does_not_use_sparse_file_logical_size(self):
        with TemporaryDirectory() as tmpdir, patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            root = Path(tmpdir)
            store = PlaylistStore(root / "state.json", root / "backup.json")
            manager = CacheManager(store, max_cache_items=1)
            try:
                attempt = root / ".attempt-test"
                attempt.mkdir()
                sparse = attempt / "video.mp4"
                with sparse.open("wb") as handle:
                    handle.seek(10 * 1024 * 1024 - 1)
                    handle.write(b"x")
                self.assertEqual(sparse.stat().st_size, 10 * 1024 * 1024)

                with patch.object(manager, "_project_cache_progress"):
                    manager._begin_download_progress(
                        "song",
                        [{
                            "key": "video-p1",
                            "label": "视频轨P1",
                            "order": 0,
                        }],
                        cache_attempt_token=1,
                    )
                    manager._update_download_track_progress(
                        "song",
                        cache_attempt_token=1,
                        track_key="video-p1",
                        target_dir=attempt,
                        current_bytes=1024 * 1024,
                        target_bytes=10 * 1024 * 1024,
                        progress_percent=10,
                        measure_path=False,
                    )
                progress = manager.item_download_progress["song"]["video-p1"]
                self.assertEqual(progress["current_bytes"], 1024 * 1024)
                self.assertEqual(progress["target_bytes"], 10 * 1024 * 1024)
                self.assertEqual(progress["progress_percent"], 10)
            finally:
                manager.shutdown()

    def test_structured_stage_message_prefers_tracked_bytes(self):
        self.assertEqual(
            CacheManager._structured_stage_message("下载视频轨 P1", 32 * 1024 * 1024, 64 * 1024 * 1024),
            "下载视频轨 P1 50% · 32.0 MB / 64.0 MB",
        )

    def test_track_percent_ratio_counts_done_and_pending_tracks(self):
        tracks = [
            {"progress_percent": 50.0, "done": False},
            {"done": True},
            {"done": False},
        ]
        self.assertAlmostEqual(CacheManager._download_progress_ratio_from_track_percents(tracks), 0.5)

    def test_track_percent_ratio_returns_none_without_progress_signal(self):
        self.assertIsNone(CacheManager._download_progress_ratio_from_track_percents([{"done": False}]))

    def test_structured_download_message_starts_with_total_progress(self):
        tracks = [
            {
                "label": "视频轨P1",
                "order": 0,
                "current_bytes": 32 * 1024 * 1024,
                "target_bytes": 64 * 1024 * 1024,
            },
            {
                "label": "音轨P1",
                "order": 1,
                "current_bytes": 8 * 1024 * 1024,
                "target_bytes": 16 * 1024 * 1024,
            },
        ]
        self.assertEqual(
            CacheManager._structured_download_message(tracks),
            "总计：40.0 MB / 80.0 MB\n视频轨P1：32.0 MB / 64.0 MB\n音轨P1：8.0 MB / 16.0 MB",
        )

    def test_download_track_label_reports_validation_and_retry_phase(self):
        base = {"label": "音轨P2", "attempt": 3, "max_attempts": 10}
        self.assertEqual(
            CacheManager._download_track_progress_label({**base, "phase": "validating"}),
            "音轨P2（校验中）",
        )
        self.assertEqual(
            CacheManager._download_track_progress_label({**base, "phase": "retrying"}),
            "音轨P2（第 3/10 次失败）",
        )
        self.assertEqual(
            CacheManager._download_track_progress_label({**base, "phase": "downloading"}),
            "音轨P2（重试 3/10）",
        )

    def test_force_refresh_hint_matches_upgrade_message(self):
        self.assertTrue(CacheManager._should_force_refresh_bbdown("请尝试升级到最新版本后重试!"))
        self.assertFalse(CacheManager._should_force_refresh_bbdown("缓存失败"))

    def test_find_stream_file_returns_none_when_directory_disappears_mid_scan(self):
        with patch.object(Path, "rglob", side_effect=FileNotFoundError("gone")):
            self.assertIsNone(CacheManager._find_stream_file(Path("C:/missing"), {".mp4"}))

class CacheManagerPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.cache_dir = temp_path / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_policy_file = temp_path / "cache_policy.json"
        self.cache_policy_patcher = patch("bilikara.cache.CACHE_POLICY_FILE", self.cache_policy_file)
        self.cache_policy_patcher.start()
        self.store = PlaylistStore(
            state_file=temp_path / "state.json",
            backup_file=temp_path / "playlist_backup.json",
        )
        self.store.add_session_user("cache-test-user")

    def tearDown(self) -> None:
        self.cache_policy_patcher.stop()
        self.temp_dir.cleanup()

    def make_item(self, item_id: str) -> PlaylistItem:
        return PlaylistItem(
            id=item_id,
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=456,
            page=1,
            title=f"title-{item_id}",
            part_title="P1",
            display_title=f"title-{item_id} - P1",
            cover_url="",
            embed_url="https://player.bilibili.com/player.html?aid=123",
        )

    def mark_item_ready_with_files(self, item_id: str) -> None:
        token = begin_cache_attempt(self.store, item_id)
        reservation = self.store.cache_attempt_reservation(token)
        relative_directory = reservation["artifact_relative_directory"]
        item_dir = self.cache_dir / relative_directory
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").write_bytes(b"video")
        (item_dir / "audio.m4a").write_bytes(b"audio")
        self.store.apply_cache_event(
            item_id,
            cache_attempt_token=token,
            event={
                "kind": "ready",
                "progress": 100.0,
                "message": "缓存已完成",
                "video_relative_path": f"{relative_directory}/video.mp4",
                "video_media_url": f"/media/{relative_directory}/video.mp4",
                "audio_variants": [
                    {
                        "id": "p1",
                        "label": "P1",
                        "page": 1,
                        "audio_url": f"/media/{relative_directory}/audio.m4a",
                    }
                ],
                "selected_audio_variant_id": "p1",
                "item_incarnation_id": reservation["item_incarnation_id"],
                "artifact_set_id": reservation["artifact_set_id"],
                "artifact_relative_directory": relative_directory,
            },
        )

    def ready_payload(
        self,
        item_id: str,
        cache_attempt_token: int,
        *,
        video_name: str = "video.mp4",
        audio_name: str = "audio.m4a",
        variant_id: str = "p1",
    ) -> dict[str, object]:
        reservation = self.store.cache_attempt_reservation(cache_attempt_token)
        relative_directory = reservation["artifact_relative_directory"]
        return {
            "video_relative_path": f"{relative_directory}/{video_name}",
            "video_media_url": f"/media/{relative_directory}/{video_name}",
            "audio_variants": [
                {
                    "id": variant_id,
                    "label": "P1",
                    "page": 1,
                    "audio_url": f"/media/{relative_directory}/{audio_name}",
                }
            ],
            "selected_audio_variant_id": variant_id,
            "item_incarnation_id": reservation["item_incarnation_id"],
            "artifact_set_id": reservation["artifact_set_id"],
            "artifact_relative_directory": relative_directory,
        }

    def project_cache_started(
        self, item_id: str, *, message: str, progress: float | None = None
    ) -> int:
        token = begin_cache_attempt(self.store, item_id)
        self.store.apply_cache_event(
            item_id,
            cache_attempt_token=token,
            event={"kind": "started", "message": message},
        )
        if progress is not None:
            self.store.apply_cache_event(
                item_id,
                cache_attempt_token=token,
                event={
                    "kind": "progress",
                    "progress": progress,
                    "message": message,
                },
            )
        return token

    def project_cache_failed(self, item_id: str, *, message: str) -> None:
        token = begin_cache_attempt(self.store, item_id)
        self.store.apply_cache_event(
            item_id,
            cache_attempt_token=token,
            event={"kind": "failed", "message": message},
        )

    def project_missing_ready(self, item_id: str) -> None:
        token = begin_cache_attempt(self.store, item_id)
        payload = self.ready_payload(item_id, token)
        self.store.apply_cache_event(
            item_id,
            cache_attempt_token=token,
            event={"kind": "ready", "progress": 100.0, "message": "缓存已完成", **payload},
        )

    def staged_cache_result(
        self,
        staging_dir: Path,
        *,
        native_tracks_prevalidated: bool = False,
    ) -> dict[str, object]:
        video = staging_dir / "video-source.mp4"
        audio = staging_dir / "audio-source.m4a"
        video.parent.mkdir(parents=True, exist_ok=True)
        video.write_bytes(b"video")
        audio.write_bytes(b"audio")
        return {
            "video_file": video,
            "video_relative_path": str(video.relative_to(self.cache_dir)),
            "video_media_url": f"/media/{video.relative_to(self.cache_dir).as_posix()}",
            "audio_variants": [
                {
                    "id": "p1",
                    "label": "P1",
                    "page": 1,
                    "audio_url": f"/media/{audio.relative_to(self.cache_dir).as_posix()}",
                }
            ],
            "selected_audio_variant_id": "p1",
            "validation_files": [
                {"path": video, "stream_kind": "video", "page": 1},
                {"path": audio, "stream_kind": "audio", "page": 1},
            ],
            "validation_metadata": [{"path": str(video)}, {"path": str(audio)}],
            "validation_failure_count": 0,
            "native_tracks_prevalidated": native_tracks_prevalidated,
        }

    def test_native_cache_job_contains_selected_pages_policy_and_existing_artifacts(self):
        item = self.make_item("song-native")
        item.selected_pages = [1, 2]
        item.selected_cids = [456, 789]
        item.selected_durations = [120, 180]
        item.selected_parts = ["Vocal", "Off Vocal"]
        item.video_page = 2
        self.store.add_item(item, requester_name="cache-test-user")
        self.mark_item_ready_with_files(item.id)
        item = self.store.get_item(item.id)

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ), patch(
            "bilikara.cache.effective_bilibili_cookie",
            return_value="SESSDATA=test-cookie",
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                manager.video_quality = "720P 高清"
                manager.audio_hires = False
                job = manager._native_cache_job(item)
            finally:
                manager.shutdown()

        self.assertEqual(job["video_page"], 2)
        self.assertEqual(job["item_incarnation_id"], item.item_incarnation_id)
        self.assertEqual([page["cid"] for page in job["pages"]], [456, 789])
        self.assertEqual([page["label"] for page in job["pages"]], ["Vocal", "Off Vocal"])
        self.assertEqual(job["video_quality"], "720P 高清")
        self.assertFalse(job["audio_hires"])
        self.assertEqual(job["cookie"], "SESSDATA=test-cookie")
        self.assertTrue(job["reported_ready"])
        self.assertEqual(
            job["existing_audio_variants"][0]["relative_path"],
            f"{item.artifact_relative_directory}/audio.m4a",
        )

    def test_native_cache_events_project_state_and_reject_stale_attempt_tokens(self):
        item = self.make_item("song-native-events")
        self.store.add_item(item, requester_name="cache-test-user")
        stale_token = begin_cache_attempt(self.store, item.id)
        cache_attempt_token = begin_cache_attempt(self.store, item.id)
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                manager._apply_native_cache_event(
                    {
                        "generation": 2,
                        "cache_attempt_token": cache_attempt_token,
                        "item_id": item.id,
                        "kind": "started",
                        "payload": {
                            "tracks": [
                                {
                                    "key": "video-p1",
                                    "label": "视频轨P1",
                                    "order": 0,
                                    "stream_kind": "video",
                                    "phase": "queued",
                                    "attempt": 0,
                                    "max_attempts": 10,
                                    "current_bytes": 0,
                                    "target_bytes": 0,
                                    "done": False,
                                }
                            ]
                        },
                    }
                )
                manager._apply_native_cache_event(
                    {
                        "generation": 2,
                        "cache_attempt_token": cache_attempt_token,
                        "item_id": item.id,
                        "kind": "ready",
                        "payload": self.ready_payload(
                            item.id,
                            cache_attempt_token,
                            video_name="video-p1.mp4",
                            audio_name="audio-p1.m4a",
                            variant_id="p1_track_1",
                        ),
                    }
                )
                with manager.lock:
                    manager.pending_ids.add(item.id)
                    manager.active_item_id = item.id
                manager._apply_native_cache_event(
                    {
                        "generation": 2,
                        "cache_attempt_token": stale_token,
                        "item_id": item.id,
                        "kind": "failed",
                        "payload": {"message": "stale failure"},
                    }
                )
                cached = self.store.get_item(item.id)
                cached_status = cached.cache_status
                selected_variant_id = cached.selected_audio_variant_id
                with manager.lock:
                    stale_terminal_kept_pending = item.id in manager.pending_ids
                    stale_terminal_kept_active = manager.active_item_id == item.id
                    accepted_identity = (
                        manager.native_cache_generations[item.id],
                        manager.native_cache_attempt_tokens[item.id],
                    )
            finally:
                manager.shutdown()

        self.assertEqual(cached_status, "ready")
        self.assertEqual(selected_variant_id, "p1_track_1")
        self.assertTrue(stale_terminal_kept_pending)
        self.assertTrue(stale_terminal_kept_active)
        self.assertEqual(accepted_identity, (2, cache_attempt_token))
        self.assertEqual(manager.native_cache_generations, {})

    def test_native_attempt_identity_pair_is_idempotent_and_rejects_conflicts(self):
        item_id = "song-native-identity-order"
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                self.assertTrue(
                    manager._accept_native_cache_attempt_identity(item_id, 2, 202)
                )
                self.assertFalse(
                    manager._accept_native_cache_attempt_identity(item_id, 1, 101)
                )
                self.assertEqual(
                    (
                        manager.native_cache_generations[item_id],
                        manager.native_cache_attempt_tokens[item_id],
                    ),
                    (2, 202),
                )
                self.assertTrue(
                    manager._accept_native_cache_attempt_identity(item_id, 2, 202)
                )
                self.assertFalse(
                    manager._accept_native_cache_attempt_identity(item_id, 2, 203)
                )
                self.assertEqual(
                    (
                        manager.native_cache_generations[item_id],
                        manager.native_cache_attempt_tokens[item_id],
                    ),
                    (2, 202),
                )
                manager.native_cache_attempt_tokens.pop(item_id)
                self.assertTrue(
                    manager._accept_native_cache_attempt_identity(item_id, 2, 202)
                )
                self.assertEqual(manager.native_cache_attempt_tokens[item_id], 202)
            finally:
                manager.shutdown()

    def test_inverse_native_submit_completion_keeps_newer_generation_token_pair(self):
        item = self.make_item("song-native-inverse-submit")
        item.selected_pages = [1]
        item.selected_cids = [456]
        item.selected_durations = [120]
        self.store.add_item(item, requester_name="cache-test-user")
        first_processing = threading.Event()
        newer_recorded = threading.Event()

        class DelayedResult(dict):
            def get(self, key, default=None):
                if key == "generation":
                    first_processing.set()
                    if not newer_recorded.wait(5.0):
                        raise AssertionError("newer Native result did not complete")
                return super().get(key, default)

        responses: queue.Queue[dict[str, object]] = queue.Queue()
        responses.put(DelayedResult(generation=1, cache_attempt_token=101))
        responses.put({"generation": 2, "cache_attempt_token": 202})

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            original_accept = manager._accept_native_cache_attempt_identity

            def accept_identity(item_id, generation, cache_attempt_token):
                accepted = original_accept(item_id, generation, cache_attempt_token)
                if generation == 2:
                    newer_recorded.set()
                return accepted

            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                with patch.object(
                    manager, "_ensure_native_cache_runtime"
                ), patch(
                    "bilikara.cache.rust_runtime.cache_runtime_request",
                    side_effect=lambda _command, **_fields: responses.get_nowait(),
                ), patch.object(
                    manager, "_drain_native_cache_events"
                ), patch.object(
                    manager,
                    "_accept_native_cache_attempt_identity",
                    side_effect=accept_identity,
                ):
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        first = executor.submit(manager.enqueue, item.id)
                        self.assertTrue(first_processing.wait(5.0))
                        second = executor.submit(manager.enqueue, item.id)
                        second.result(timeout=5.0)
                        first.result(timeout=5.0)

                self.assertEqual(
                    (
                        manager.native_cache_generations[item.id],
                        manager.native_cache_attempt_tokens[item.id],
                    ),
                    (2, 202),
                )
            finally:
                manager.shutdown()

    def test_native_sync_submits_rust_jobs_without_using_python_worker_queue(self):
        item = self.make_item("song-native-sync")
        item.selected_pages = [1]
        item.selected_cids = [456]
        item.selected_durations = [120]
        self.store.add_item(item, requester_name="cache-test-user")
        calls = []

        def runtime_request(command, **fields):
            calls.append((command, fields))
            if command == "sync":
                return {
                    "generations": {item.id: 7},
                    "cache_attempt_tokens": {item.id: 107},
                    "snapshot": {
                        "primary_active_item_id": None,
                        "active_item_ids": [],
                        "urgent_item_ids": [],
                        "pending_ids": [item.id],
                    },
                }
            return {"events": [], "snapshot": {}}

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                with patch.object(manager, "_ensure_native_cache_runtime"), patch.object(
                    manager, "_native_cache_request", side_effect=runtime_request
                ):
                    manager.sync_with_playlist()
                queued = manager.tasks.qsize()
                generation = manager.native_cache_generations[item.id]
                cache_attempt_token = manager.native_cache_attempt_tokens[item.id]
            finally:
                manager.shutdown()

        self.assertEqual(queued, 0)
        self.assertEqual(generation, 7)
        self.assertEqual(cache_attempt_token, 107)
        sync_request = next(fields for command, fields in calls if command == "sync")
        self.assertEqual(sync_request["jobs"][0]["item_id"], item.id)
        observed = self.store.get_item(item.id)
        self.assertEqual(
            sync_request["current_item_incarnations"],
            {item.id: observed.item_incarnation_id},
        )
        self.assertEqual(sync_request["ordered_ids"], [item.id])

    def test_native_sync_excludes_active_python_owner_and_includes_future_item(self):
        active = self.make_item("song-external-active")
        future = self.make_item("song-native-future")
        for item in (active, future):
            item.selected_pages = [1]
            item.selected_cids = [456]
            item.selected_durations = [120]
            self.store.add_item(item, requester_name="cache-test-user")
        self.project_cache_started(
            active.id,
            message="BBDown 下载中",
            progress=42.0,
        )
        plan = CachePlan(
            desired_ids=(active.id, future.id),
            pending_order=(active.id, future.id),
            retained_ids=(active.id, future.id),
            preempt_ids=(),
        )
        calls = []

        def runtime_request(command, **fields):
            calls.append((command, fields))
            if command == "sync":
                return {
                    "generations": {future.id: 1},
                    "cache_attempt_tokens": {future.id: 101},
                    "snapshot": {
                        "primary_active_item_id": None,
                        "active_item_ids": [],
                        "urgent_item_ids": [],
                        "pending_ids": [future.id],
                    },
                }
            return {"events": [], "snapshot": {}}

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value=""
        ), patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=2)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.active_item_id = active.id
                manager.pending_ids.add(active.id)
                manager.python_worker_download_sources[active.id] = DOWNLOAD_SOURCE_BBDOWN
                manager.set_cache_policy(download_source=DOWNLOAD_SOURCE_NATIVE)
                with patch.object(
                    manager,
                    "_stable_cache_plan_snapshot",
                    return_value=(plan, manager._cache_priority_state()),
                ), patch.object(manager, "_ensure_native_cache_runtime"), patch.object(
                    manager, "_native_cache_request", side_effect=runtime_request
                ):
                    manager.sync_with_playlist()
            finally:
                manager.native_cache_started = False
                manager.shutdown()

        sync_request = next(fields for command, fields in calls if command == "sync")
        self.assertEqual(
            [job["item_id"] for job in sync_request["jobs"]],
            [future.id],
        )
        self.assertEqual(
            sync_request["current_item_incarnations"],
            {
                item_id: self.store.get_item(item_id).item_incarnation_id
                for item_id in (active.id, future.id)
            },
        )

    def test_python_queue_captures_source_before_native_switch(self):
        worker_loop = CacheManager._worker_loop
        queued = self.make_item("song-python-queued")
        future = self.make_item("song-native-future")
        for item in (queued, future):
            item.selected_pages = [1]
            item.selected_cids = [456]
            item.selected_durations = [120]
            self.store.add_item(item, requester_name="cache-test-user")
        plan = CachePlan(
            desired_ids=(queued.id, future.id),
            pending_order=(queued.id, future.id),
            retained_ids=(queued.id, future.id),
            preempt_ids=(),
        )
        calls = []

        def runtime_request(command, **fields):
            calls.append((command, fields))
            if command == "sync":
                return {
                    "generations": {future.id: 1},
                    "cache_attempt_tokens": {future.id: 101},
                    "snapshot": {
                        "primary_active_item_id": None,
                        "active_item_ids": [],
                        "urgent_item_ids": [],
                        "pending_ids": [future.id],
                    },
                }
            if command == "submit":
                return {"generation": 2, "cache_attempt_token": 102}
            return {"events": [], "snapshot": {}}

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.enqueue(queued.id)
                queued_token = manager.python_cache_attempt_tokens[queued.id]
                self.assertEqual(
                    manager.python_worker_download_sources[queued.id],
                    DOWNLOAD_SOURCE_BBDOWN,
                )

                manager.set_cache_policy(download_source=DOWNLOAD_SOURCE_NATIVE)
                with patch.object(
                    manager,
                    "_stable_cache_plan_snapshot",
                    return_value=(plan, manager._cache_priority_state()),
                ), patch.object(manager, "_ensure_native_cache_runtime"), patch.object(
                    manager, "_native_cache_request", side_effect=runtime_request
                ):
                    manager.sync_with_playlist()

                    executed_attempts = []

                    def execute_python_item(item_id, cache_attempt_token):
                        executed_attempts.append(
                            (
                                manager.python_worker_download_sources[item_id],
                                cache_attempt_token,
                            )
                        )
                        manager.stop_event.set()
                        return False

                    with patch.object(
                        manager, "_cache_item", side_effect=execute_python_item
                    ):
                        worker_loop(manager)
                    manager.stop_event.clear()
                    manager.enqueue(future.id)

                sync_request = next(
                    fields for command, fields in calls if command == "sync"
                )
                self.assertEqual(
                    [job["item_id"] for job in sync_request["jobs"]],
                    [future.id],
                )
                self.assertEqual(
                    executed_attempts,
                    [(DOWNLOAD_SOURCE_BBDOWN, queued_token)],
                )
                submit_request = next(
                    fields for command, fields in calls if command == "submit"
                )
                self.assertEqual(submit_request["job"]["item_id"], future.id)
                self.assertNotIn(future.id, manager.python_worker_download_sources)
            finally:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.shutdown()

    def test_external_sources_reserve_before_worker_queueing(self):
        for index, download_source in enumerate(
            (DOWNLOAD_SOURCE_BBDOWN, DOWNLOAD_SOURCE_YTDLP),
            start=1,
        ):
            with self.subTest(download_source=download_source), patch.object(
                CacheManager, "_worker_loop", lambda self: None
            ):
                item = self.make_item(f"song-reserve-{index}")
                self.store.add_item(item, requester_name="cache-test-user")
                manager = CacheManager(self.store, max_cache_items=1)
                events: list[str] = []
                original_begin = manager._begin_cache_attempt

                def reserve(item_id: str, item_incarnation_id: str) -> int:
                    events.append("reserve")
                    return original_begin(item_id, item_incarnation_id)

                try:
                    manager.download_source = download_source
                    with patch.object(
                        manager,
                        "_begin_cache_attempt",
                        side_effect=reserve,
                    ), patch.object(
                        manager.tasks,
                        "put",
                        side_effect=lambda _item_id: events.append("queue"),
                    ):
                        manager.enqueue(item.id)

                    self.assertEqual(events, ["reserve", "queue"])
                    self.assertGreater(
                        manager.python_cache_attempt_tokens[item.id],
                        0,
                    )
                    self.assertEqual(
                        manager.python_worker_download_sources[item.id],
                        download_source,
                    )
                finally:
                    manager.shutdown()

    def test_downkyi_checks_cookie_then_reserves_without_starting_work(self):
        item = self.make_item("song-downkyi-reservation-order")
        self.store.add_item(item, requester_name="cache-test-user")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            events: list[str] = []
            original_begin = manager._begin_cache_attempt

            def check_cookie() -> str:
                events.append("cookie")
                return ""

            def reserve(item_id: str, item_incarnation_id: str) -> int:
                events.append("reserve")
                return original_begin(item_id, item_incarnation_id)

            try:
                manager.download_source = DOWNLOAD_SOURCE_DOWNKYI
                with patch(
                    "bilikara.cache.effective_bilibili_cookie",
                    side_effect=check_cookie,
                ), patch.object(
                    manager,
                    "_begin_cache_attempt",
                    side_effect=reserve,
                ), patch.object(
                    manager.tasks,
                    "put",
                ) as queue_work, patch.object(
                    manager,
                    "_ensure_downloader",
                ) as prepare_tool, patch(
                    "bilikara.cache.subprocess.Popen",
                ) as spawn_process:
                    manager.enqueue(item.id)

                self.assertEqual(events, ["cookie", "reserve"])
                queue_work.assert_not_called()
                prepare_tool.assert_not_called()
                spawn_process.assert_not_called()
                self.assertEqual(self.store.get_item(item.id).cache_status, "failed")
            finally:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.shutdown()

    def test_external_reservation_failure_starts_no_worker_or_process(self):
        item = self.make_item("song-reservation-failure")
        self.store.add_item(item, requester_name="cache-test-user")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                with patch.object(
                    manager,
                    "_begin_cache_attempt",
                    side_effect=RuntimeError("reservation failed"),
                ), patch.object(
                    manager.tasks,
                    "put",
                ) as queue_work, patch.object(
                    manager,
                    "_ensure_downloader",
                ) as prepare_tool, patch(
                    "bilikara.cache.subprocess.Popen",
                ) as spawn_process:
                    with self.assertRaisesRegex(RuntimeError, "reservation failed"):
                        manager.enqueue(item.id)

                queue_work.assert_not_called()
                prepare_tool.assert_not_called()
                spawn_process.assert_not_called()
                self.assertNotIn(item.id, manager.pending_ids)
                self.assertNotIn(item.id, manager.python_worker_download_sources)
                self.assertNotIn(item.id, manager.python_cache_attempt_tokens)
            finally:
                manager.shutdown()

    def test_stale_python_attempt_starts_no_tool_native_or_subprocess_work(self):
        old_item = self.make_item("song-reused-id")
        self.store.add_item(old_item, requester_name="cache-test-user")
        old_item = self.store.get_item(old_item.id)
        self.assertIsNotNone(old_item)
        stale_token = self.store.begin_cache_attempt(
            old_item.id,
            old_item.item_incarnation_id,
        )
        self.assertTrue(self.store.remove_item(old_item.id))
        replacement = self.make_item(old_item.id)
        replacement.bvid = "BV1yy411c7mE"
        self.store.add_item(replacement, requester_name="cache-test-user")

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                with manager.lock:
                    manager.desired_ids = {old_item.id}
                    manager.python_worker_download_sources[old_item.id] = (
                        DOWNLOAD_SOURCE_BBDOWN
                    )
                    manager.python_cache_attempt_tokens[old_item.id] = stale_token
                with patch.object(
                    manager,
                    "_ensure_downloader",
                ) as prepare_tool, patch.object(
                    manager,
                    "_ensure_ffmpeg",
                ) as prepare_ffmpeg, patch.object(
                    manager,
                    "_native_cache_request",
                ) as native_work, patch(
                    "bilikara.cache.subprocess.Popen",
                ) as spawn_process:
                    with self.assertRaisesRegex(
                        (RuntimeError, ValueError),
                        "unavailable|incarnation changed",
                    ):
                        manager._cache_item(old_item.id, stale_token)

                prepare_tool.assert_not_called()
                prepare_ffmpeg.assert_not_called()
                native_work.assert_not_called()
                spawn_process.assert_not_called()
                self.assertEqual(
                    manager.python_cache_attempt_tokens[old_item.id],
                    stale_token,
                )
            finally:
                manager.shutdown()

    def test_shutdown_skips_items_removed_before_attempt_reservation(self):
        item = self.make_item("song-removed-before-shutdown")
        self.store.add_item(item, requester_name="cache-test-user")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            replacement_store = PlaylistStore(
                state_file=Path(self.temp_dir.name) / "replacement-state.json",
                backup_file=Path(self.temp_dir.name) / "replacement-backup.json",
            )
            try:
                with patch.object(manager, "_clear_cache_root") as clear_cache:
                    manager.shutdown()

                clear_cache.assert_called_once_with()
                self.assertTrue(manager.stop_event.is_set())
            finally:
                replacement_store.shutdown()

    def test_requeued_python_item_retains_original_source_after_switch(self):
        worker_loop = CacheManager._worker_loop
        item = self.make_item("song-python-requeued")
        self.store.add_item(item, requester_name="cache-test-user")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.enqueue(item.id)
                with manager.lock:
                    manager.requeued_active_ids.add(item.id)
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                executed_sources = []

                def interrupt_and_requeue(item_id, _cache_attempt_token):
                    executed_sources.append(
                        manager.python_worker_download_sources[item_id]
                    )
                    manager.stop_event.set()
                    return False

                with patch.object(
                    manager, "_cache_item", side_effect=interrupt_and_requeue
                ):
                    worker_loop(manager)

                self.assertEqual(executed_sources, [DOWNLOAD_SOURCE_BBDOWN])
                self.assertEqual(
                    manager.python_worker_download_sources[item.id],
                    DOWNLOAD_SOURCE_BBDOWN,
                )
                self.assertIn(item.id, manager.pending_ids)
            finally:
                manager.stop_event.clear()
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                manager.shutdown()

    def test_native_terminal_events_release_bookkeeping_after_source_switch(self):
        terminal_payloads = {
            "ready": {
                "video_relative_path": "video.mp4",
                "video_media_url": "/media/video.mp4",
                "audio_variants": [
                    {
                        "id": "p1",
                        "label": "P1",
                        "page": 1,
                        "audio_url": "/media/audio.m4a",
                    }
                ],
                "selected_audio_variant_id": "p1",
            },
            "failed": {"message": "native failure"},
            "cancelled": {"reason": "cancelled"},
            "evicted": {"reason": "evicted"},
        }
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=4)
            try:
                for sequence, (kind, payload) in enumerate(
                    terminal_payloads.items(), start=1
                ):
                    with self.subTest(kind=kind):
                        item = self.make_item(f"song-native-{kind}")
                        self.store.add_item(item, requester_name="cache-test-user")
                        cache_attempt_token = begin_cache_attempt(self.store, item.id)
                        if kind == "ready":
                            payload = self.ready_payload(
                                item.id,
                                cache_attempt_token,
                            )
                        with manager.lock:
                            manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                            manager.native_cache_generations[item.id] = 7
                            manager.pending_ids.add(item.id)
                            manager.urgent_cache_ids.add(item.id)
                            manager.active_item_id = item.id

                        manager._apply_native_cache_event(
                            {
                                "generation": 7,
                                "cache_attempt_token": cache_attempt_token,
                                "sequence": sequence,
                                "item_id": item.id,
                                "kind": kind,
                                "payload": payload,
                            }
                        )

                        with manager.lock:
                            self.assertNotIn(item.id, manager.pending_ids)
                            self.assertNotIn(item.id, manager.urgent_cache_ids)
                            self.assertIsNone(manager.active_item_id)
                        manager.enqueue(item.id)
                        self.assertEqual(
                            manager.python_worker_download_sources[item.id],
                            DOWNLOAD_SOURCE_BBDOWN,
                        )
                        self.assertEqual(manager.tasks.get_nowait(), item.id)
                        manager.tasks.task_done()
                        with manager.lock:
                            manager.pending_ids.discard(item.id)
                            manager.python_worker_download_sources.pop(item.id)
                            manager.python_cache_attempt_tokens.pop(item.id)
            finally:
                manager.shutdown()

    def test_native_terminal_event_does_not_clear_active_python_bookkeeping(self):
        item = self.make_item("song-python-active-after-native")
        self.store.add_item(item, requester_name="cache-test-user")
        native_token = begin_cache_attempt(self.store, item.id)
        python_token = begin_cache_attempt(self.store, item.id)
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                with manager.lock:
                    manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                    manager.native_cache_generations[item.id] = 3
                    manager.python_worker_download_sources[item.id] = (
                        DOWNLOAD_SOURCE_BBDOWN
                    )
                    manager.python_cache_attempt_tokens[item.id] = python_token
                    manager.pending_ids.add(item.id)
                    manager.urgent_cache_ids.add(item.id)
                    manager.active_item_id = item.id

                with self.assertRaisesRegex(ValueError, "superseded"):
                    manager._apply_native_cache_event(
                        {
                            "generation": 3,
                            "cache_attempt_token": native_token,
                            "sequence": 1,
                            "item_id": item.id,
                            "kind": "cancelled",
                            "payload": {"reason": "old native job ended"},
                        }
                    )

                with manager.lock:
                    self.assertIn(item.id, manager.pending_ids)
                    self.assertIn(item.id, manager.urgent_cache_ids)
                    self.assertEqual(manager.active_item_id, item.id)
                    self.assertEqual(
                        manager.python_worker_download_sources[item.id],
                        DOWNLOAD_SOURCE_BBDOWN,
                    )
            finally:
                manager.shutdown()

    def test_native_sync_service_failure_does_not_fan_out_to_valid_jobs(self):
        ready = self.make_item("song-ready")
        pending = self.make_item("song-pending")
        malformed = self.make_item("song-malformed")
        for item in (ready, pending, malformed):
            item.selected_pages = [1]
            item.selected_cids = [456]
            item.selected_durations = [120]
            self.store.add_item(item, requester_name="cache-test-user")
        self.mark_item_ready_with_files(ready.id)
        plan = CachePlan(
            desired_ids=(ready.id, pending.id, malformed.id),
            pending_order=(pending.id, malformed.id),
            retained_ids=(ready.id, pending.id, malformed.id),
            preempt_ids=(),
        )

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value=""
        ), patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                original_job = manager._native_cache_job

                def build_job(item):
                    if item.id == malformed.id:
                        raise ValueError("malformed fixture")
                    return original_job(item)

                with patch.object(
                    manager,
                    "_stable_cache_plan_snapshot",
                    return_value=(plan, manager._cache_priority_state()),
                ), patch.object(
                    manager, "_native_cache_job", side_effect=build_job
                ), patch.object(manager, "_ensure_native_cache_runtime"), patch.object(
                    manager,
                    "_native_cache_request",
                    side_effect=RuntimeError("simulated service failure"),
                ):
                    manager.sync_with_playlist()

                ready_after = self.store.get_item(ready.id)
                pending_after = self.store.get_item(pending.id)
                malformed_after = self.store.get_item(malformed.id)
                self.assertEqual(ready_after.cache_status, "ready")
                self.assertEqual(
                    ready_after.video_relative_path,
                    f"{ready_after.artifact_relative_directory}/video.mp4",
                )
                self.assertEqual(len(ready_after.audio_variants), 1)
                self.assertEqual(pending_after.cache_status, "pending")
                self.assertEqual(malformed_after.cache_status, "failed")
                self.assertEqual(manager.native_cache_error, "simulated service failure")
            finally:
                manager.native_cache_started = False
                manager.shutdown()

    def test_stale_native_job_build_failure_does_not_mark_reused_item_id(self):
        old = self.make_item("song-native-stale-build")
        old.selected_pages = [1]
        old.selected_cids = [456]
        old.selected_durations = [120]
        self.store.add_item(old, requester_name="cache-test-user")
        observed = self.store.get_item(old.id)
        replacement = self.make_item(old.id)
        replacement.bvid = "BV1yy411c7mE"
        replacement.title = "replacement-build"
        plan = CachePlan(
            desired_ids=(old.id,),
            pending_order=(old.id,),
            retained_ids=(old.id,),
            preempt_ids=(),
        )

        def fail_after_replacement(_item):
            self.store.remove_item(old.id)
            self.store.add_item(replacement, requester_name="cache-test-user")
            raise ValueError("stale Native job fixture")

        def runtime_request(command, **_fields):
            if command == "sync":
                return {
                    "generations": {},
                    "cache_attempt_tokens": {},
                    "snapshot": {},
                }
            return {"events": [], "snapshot": {}}

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                with patch.object(
                    manager, "_native_cache_job", side_effect=fail_after_replacement
                ), patch.object(
                    manager, "_ensure_native_cache_runtime"
                ), patch.object(
                    manager, "_native_cache_request", side_effect=runtime_request
                ), patch.object(
                    manager, "_begin_cache_attempt_for_item"
                ) as reserve_attempt:
                    manager._sync_native_with_playlist([observed], plan)

                live = self.store.get_item(old.id)
                self.assertEqual(live.bvid, replacement.bvid)
                self.assertEqual(live.title, replacement.title)
                self.assertEqual(live.cache_status, "pending")
                reserve_attempt.assert_not_called()
                self.assertEqual(self.store._cache_attempt_reservations, {})
            finally:
                manager.shutdown()

    def test_stale_native_submit_and_retry_failures_do_not_mark_reused_item_id(self):
        for action in ("submit", "retry"):
            with self.subTest(action=action):
                old = self.make_item(f"song-native-stale-{action}")
                old.selected_pages = [1]
                old.selected_cids = [456]
                old.selected_durations = [120]
                self.store.add_item(old, requester_name="cache-test-user")
                replacement = self.make_item(old.id)
                replacement.bvid = "BV1yy411c7mE"
                replacement.title = f"replacement-{action}"

                def fail_after_replacement(command, **_fields):
                    self.assertEqual(command, action)
                    self.store.remove_item(old.id)
                    self.store.add_item(
                        replacement,
                        requester_name="cache-test-user",
                    )
                    raise RuntimeError(f"stale Native {action} fixture")

                with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
                    CacheManager, "_worker_loop", lambda self: None
                ):
                    manager = CacheManager(self.store, max_cache_items=1)
                    try:
                        manager.download_source = DOWNLOAD_SOURCE_NATIVE
                        manager.desired_ids = {old.id}
                        with patch.object(
                            manager, "_ensure_native_cache_runtime"
                        ), patch.object(
                            manager,
                            "_native_cache_request",
                            side_effect=fail_after_replacement,
                        ), patch.object(
                            manager, "_begin_cache_attempt_for_item"
                        ) as reserve_attempt, patch.object(
                            manager, "_append_log_line"
                        ):
                            if action == "submit":
                                manager.enqueue(old.id)
                            else:
                                manager.retry_item(old.id)

                        live = self.store.get_item(old.id)
                        self.assertEqual(live.bvid, replacement.bvid)
                        self.assertEqual(live.title, replacement.title)
                        self.assertEqual(live.cache_status, "pending")
                        reserve_attempt.assert_not_called()
                        self.assertEqual(self.store._cache_attempt_reservations, {})
                    finally:
                        manager.shutdown()

    def test_native_failure_for_current_incarnation_is_still_projected(self):
        item = self.make_item("song-native-current-failure")
        self.store.add_item(item, requester_name="cache-test-user")
        observed = self.store.get_item(item.id)
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                with patch.object(
                    manager,
                    "_begin_cache_attempt_for_item",
                    wraps=manager._begin_cache_attempt_for_item,
                ) as reserve_attempt:
                    manager._mark_native_cache_failed(
                        item.id,
                        "exact incarnation failure",
                        expected_item_incarnation_id=observed.item_incarnation_id,
                    )

                live = self.store.get_item(item.id)
                self.assertEqual(live.cache_status, "failed")
                self.assertIn("exact incarnation failure", live.cache_message)
                reserve_attempt.assert_called_once()
            finally:
                manager.shutdown()

    def test_native_snapshot_recovers_lost_terminal_event_once(self):
        item = self.make_item("song-terminal-recovery")
        self.store.add_item(item, requester_name="cache-test-user")
        cache_attempt_token = begin_cache_attempt(self.store, item.id)
        reservation = self.store.cache_attempt_reservation(cache_attempt_token)
        relative_directory = reservation["artifact_relative_directory"]
        terminal = {
            "sequence": 9,
            "generation": 3,
            "cache_attempt_token": cache_attempt_token,
            "item_id": item.id,
            "kind": "ready",
            "payload": {
                "video_relative_path": f"{relative_directory}/video-p1.mp4",
                "video_media_url": f"/media/{relative_directory}/video-p1.mp4",
                "audio_variants": [
                    {
                        "id": "p1-vocal",
                        "label": "Vocal",
                        "page": 1,
                        "audio_url": f"/media/{relative_directory}/audio-p1-vocal.m4a",
                    },
                    {
                        "id": "p1-off-vocal",
                        "label": "Off Vocal",
                        "page": 1,
                        "audio_url": f"/media/{relative_directory}/audio-p1-off-vocal.m4a",
                    },
                ],
                "selected_audio_variant_id": "p1-vocal",
                "item_incarnation_id": reservation["item_incarnation_id"],
                "artifact_set_id": reservation["artifact_set_id"],
                "artifact_relative_directory": relative_directory,
            },
        }
        snapshot = {
            "primary_active_item_id": None,
            "active_item_ids": [],
            "urgent_item_ids": [],
            "pending_ids": [],
            "terminal_events": [terminal],
        }

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                manager._apply_native_cache_snapshot(snapshot)
                self.assertTrue(
                    self.store.set_audio_variant(item.id, "p1-off-vocal")
                )
                manager._apply_native_cache_snapshot(snapshot)
                cached = self.store.get_item(item.id)
                self.assertEqual(cached.cache_status, "ready")
                self.assertEqual(cached.selected_audio_variant_id, "p1-off-vocal")
                self.assertEqual(manager.native_cache_terminal_sequences[item.id], 9)
            finally:
                manager.shutdown()

    def test_native_drain_applies_events_before_terminal_snapshot_recovery(self):
        item = self.make_item("song-terminal-order")
        self.store.add_item(item, requester_name="cache-test-user")
        cache_attempt_token = begin_cache_attempt(self.store, item.id)
        ready = {
            "sequence": 9,
            "generation": 3,
            "cache_attempt_token": cache_attempt_token,
            "item_id": item.id,
            "kind": "ready",
            "payload": self.ready_payload(
                item.id,
                cache_attempt_token,
                video_name="video-p1.mp4",
                audio_name="audio-p1.m4a",
            ),
        }
        result = {
            "events": [
                {
                    "sequence": 8,
                    "generation": 3,
                    "cache_attempt_token": cache_attempt_token,
                    "item_id": item.id,
                    "kind": "queued",
                    "payload": {"priority": "normal"},
                },
                ready,
            ],
            "snapshot": {
                "primary_active_item_id": None,
                "active_item_ids": [],
                "urgent_item_ids": [],
                "pending_ids": [],
                "terminal_events": [ready],
            },
        }

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                with patch.object(manager, "_native_cache_request", return_value=result):
                    manager._drain_native_cache_events()
                self.assertEqual(self.store.get_item(item.id).cache_status, "ready")
            finally:
                manager.shutdown()

    def test_cache_metrics_reports_usage_by_item(self):
        for item_id in ("song-a", "song-b"):
            self.store.add_item(
                self.make_item(item_id), requester_name="cache-test-user"
            )
            self.mark_item_ready_with_files(item_id)
        orphan = self.cache_dir / "artifacts" / "orphan"
        orphan.mkdir(parents=True)
        (orphan / "retained.bin").write_bytes(b"retained")
        staging = self.cache_dir / ".staging" / "attempt"
        staging.mkdir(parents=True)
        (staging / "partial.bin").write_bytes(b"partial")

        log_dir = Path(self.temp_dir.name) / "logs"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                metrics = manager.cache_metrics()
            finally:
                manager.shutdown()

        self.assertEqual(metrics["total_bytes"], 20)
        self.assertEqual(metrics["item_count"], 2)
        self.assertEqual(metrics["item_bytes"]["song-a"], 10)
        self.assertEqual(metrics["item_bytes"]["song-b"], 10)
        self.assertEqual(metrics["retained_bytes"], len(b"retained"))
        self.assertEqual(metrics["staging_bytes"], len(b"partial"))
        self.assertEqual(
            metrics["physical_total_bytes"],
            metrics["total_bytes"] + metrics["retained_bytes"] + metrics["staging_bytes"],
        )

    def test_set_max_cache_items_clamps_to_picker_range(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.assertEqual(manager.set_max_cache_items(9), 5)
                self.assertEqual(manager.max_cache_items, 5)
                self.assertEqual(manager.policy_snapshot()["choices"], [1, 2, 3, 4, 5])
            finally:
                manager.shutdown()

    def test_cache_policy_persists_quality_and_hires_preference(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                snapshot = manager.set_cache_policy(
                    video_quality="720P 高清",
                    audio_hires=False,
                )
                self.assertEqual(snapshot["video_quality"], "720P 高清")
                self.assertFalse(snapshot["audio_hires"])
            finally:
                manager.shutdown()

            restored = CacheManager(self.store, max_cache_items=3)
            try:
                snapshot = restored.policy_snapshot()
                self.assertEqual(snapshot["video_quality"], "720P 高清")
                self.assertFalse(snapshot["audio_hires"])
            finally:
                restored.shutdown()

    def test_native_media_preferences_only_apply_to_future_downloads(self):
        current = self.make_item("song-a")
        queued = self.make_item("song-b")
        future = self.make_item("song-c")
        self.store.add_item(current, requester_name="cache-test-user")
        self.store.add_item(queued, requester_name="cache-test-user")
        self.mark_item_ready_with_files(current.id)
        self.mark_item_ready_with_files(queued.id)

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                manager.video_quality = "1080P 高清"
                manager.audio_hires = False
                manager.native_cache_started = True
                with patch.object(manager, "_native_cache_request") as native_request, patch.object(
                    manager, "_drain_native_cache_events"
                ) as drain_events, patch.object(manager, "sync_with_playlist") as sync:
                    snapshot = manager.set_cache_policy(
                        video_quality="720P 高清",
                        audio_hires=True,
                    )

                self.assertEqual(snapshot["video_quality"], "720P 高清")
                self.assertTrue(snapshot["audio_hires"])
                self.assertNotIn(
                    "clear",
                    [args[0] for args, _kwargs in native_request.call_args_list],
                )
                drain_events.assert_not_called()
                sync.assert_not_called()
                self.assertEqual(self.store.get_item(current.id).cache_status, "ready")
                self.assertEqual(self.store.get_item(queued.id).cache_status, "ready")
                future_job = manager._native_cache_job(future)
                self.assertEqual(future_job["video_quality"], "720P 高清")
                self.assertTrue(future_job["audio_hires"])
            finally:
                manager.native_cache_started = False
                manager.shutdown()

    def test_download_source_change_only_applies_to_future_downloads(self):
        current = self.make_item("song-a")
        downloading = self.make_item("song-b")
        self.store.add_item(current, requester_name="cache-test-user")
        self.store.add_item(downloading, requester_name="cache-test-user")
        self.mark_item_ready_with_files(current.id)
        self.project_cache_started(
            downloading.id,
            message="BBDown 下载中",
            progress=42.0,
        )

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value=""
        ), patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                with patch.object(
                    manager, "_ensure_native_cache_runtime"
                ), patch.object(
                    manager,
                    "_native_cache_request",
                    side_effect=RuntimeError("native takeover conflict"),
                ) as native_request:
                    snapshot = manager.set_cache_policy(
                        download_source=DOWNLOAD_SOURCE_NATIVE
                    )

                self.assertEqual(snapshot["download_source"], DOWNLOAD_SOURCE_NATIVE)
                native_request.assert_not_called()
                self.assertEqual(self.store.get_item(current.id).cache_status, "ready")
                downloading_after = self.store.get_item(downloading.id)
                self.assertEqual(downloading_after.cache_status, "downloading")
                self.assertEqual(downloading_after.cache_progress, 42.0)
                self.assertEqual(downloading_after.cache_message, "BBDown 下载中")
            finally:
                manager.shutdown()

    def test_cache_policy_preserves_each_download_source(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.assertEqual(
                    [choice["value"] for choice in manager.policy_snapshot()["download_source_choices"]],
                    [DOWNLOAD_SOURCE_BBDOWN, DOWNLOAD_SOURCE_DOWNKYI, DOWNLOAD_SOURCE_NATIVE],
                )
                for source in (
                    DOWNLOAD_SOURCE_BBDOWN,
                    DOWNLOAD_SOURCE_YTDLP,
                    DOWNLOAD_SOURCE_DOWNKYI,
                    DOWNLOAD_SOURCE_NATIVE,
                ):
                    snapshot = manager.set_cache_policy(download_source=source)
                    self.assertEqual(snapshot["download_source"], source)
            finally:
                manager.shutdown()

            restored = CacheManager(self.store, max_cache_items=3)
            try:
                snapshot = restored.policy_snapshot()
                self.assertEqual(snapshot["download_source"], DOWNLOAD_SOURCE_NATIVE)
            finally:
                restored.shutdown()

    def test_downkyi_status_prompts_windows_prepare_when_aria2c_missing(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", return_value=None
        ), patch("bilikara.cache.os.name", "nt"), patch.object(
            CacheManager,
            "_current_platform_tokens",
            return_value=("windows", "x64"),
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                status = manager.downloader_status(DOWNLOAD_SOURCE_DOWNKYI)
            finally:
                manager.shutdown()

        self.assertFalse(status["ready"])
        self.assertTrue(status["requires_prepare"])
        self.assertTrue(status["auto_prepare_supported"])
        self.assertTrue(status["path"].endswith("aria2c.exe"))
        self.assertIn(str(aria2_dir), status["message"])

    def test_downkyi_status_uses_manual_prepare_on_linux_when_aria2c_missing(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", return_value=None
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL", "https://download.example/bilikara/tools"
        ), patch("bilikara.cache.os.name", "posix"), patch.object(
            CacheManager, "_system_aria2c_path", return_value=None
        ), patch.object(
            CacheManager,
            "_current_platform_tokens",
            return_value=("linux", "x64"),
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                status = manager.downloader_status(DOWNLOAD_SOURCE_DOWNKYI)
            finally:
                manager.shutdown()

        self.assertFalse(status["ready"])
        self.assertTrue(status["requires_prepare"])
        self.assertFalse(status["auto_prepare_supported"])
        self.assertTrue(status["path"].endswith("aria2c"))
        self.assertIn(str(aria2_dir), status["message"])

    def test_downkyi_status_uses_manual_prepare_when_fallback_asset_unavailable(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", return_value=None
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL", ""
        ), patch("bilikara.cache.os.name", "posix"), patch.object(
            CacheManager, "_system_aria2c_path", return_value=None
        ), patch.object(
            CacheManager,
            "_current_platform_tokens",
            return_value=("linux", "riscv64"),
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                status = manager.downloader_status(DOWNLOAD_SOURCE_DOWNKYI)
                with patch.object(manager, "_install_aria2c") as install:
                    with self.assertRaisesRegex(RuntimeError, "手动安装"):
                        manager.prepare_downloader(DOWNLOAD_SOURCE_DOWNKYI)
                    install.assert_not_called()
            finally:
                manager.shutdown()

        self.assertFalse(status["ready"])
        self.assertTrue(status["requires_prepare"])
        self.assertFalse(status["auto_prepare_supported"])
        self.assertTrue(status["path"].endswith("aria2c"))
        self.assertIn(str(aria2_dir), status["message"])


    def test_prepare_downkyi_reports_missing_auto_package_for_404_without_polluting_current_source(self):
        manager = CacheManager(self.store, max_cache_items=3)
        try:
            manager.binary_state = "ready"
            manager.binary_version = "1.6.3"
            manager.binary_message = "BBDown 1.6.3 已就绪"
            error = urllib.error.HTTPError(
                "https://download.example/bilikara/tools/aria2.tar.gz",
                404,
                "Not Found",
                {},
                None,
            )
            with patch.object(
                manager,
                "_aria2c_status",
                return_value={"ready": False, "auto_prepare_supported": True},
            ), patch.object(
                manager,
                "_local_aria2c_binary_path",
                return_value=Path("/tmp/tools/aria2c"),
            ), patch.object(manager, "_ensure_aria2c", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, "自动下载包"):
                    manager.prepare_downloader(DOWNLOAD_SOURCE_DOWNKYI)
            self.assertEqual(manager.binary_state, "ready")
            self.assertEqual(manager.binary_version, "1.6.3")
            self.assertEqual(manager.binary_message, "BBDown 1.6.3 已就绪")
        finally:
            manager.shutdown()

    def test_downkyi_status_accepts_local_aria2c_binary(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        target_path = aria2_dir / "aria2c"
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(b"aria2c-bin")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.os.name", "posix"
        ), patch.object(
            CacheManager,
            "_system_aria2c_path",
            return_value=None,
        ), patch.object(
            CacheManager,
            "_current_platform_tokens",
            return_value=("linux", "x64"),
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_read_aria2c_version", return_value="1.37.0"):
                    status = manager.downloader_status(DOWNLOAD_SOURCE_DOWNKYI)
            finally:
                manager.shutdown()

        self.assertTrue(status["ready"])
        self.assertFalse(status["requires_prepare"])
        self.assertEqual(status["path"], str(target_path))
        self.assertEqual(status["version"], "1.37.0")

    def test_macos_direct_metadata_enables_prepare_without_homebrew_or_path(self):
        root = Path(self.temp_dir.name) / "macos-direct-status"
        executable = root / "bilikara.app" / "Contents" / "MacOS" / "bilikara"
        metadata_path = (
            executable.parent.parent / "Resources" / "vendor" / "aria2-macos.json"
        )
        metadata_path.parent.mkdir(parents=True)
        revision = "a" * 40
        asset_name = f"aria2-1.37.0-macos-arm64-{revision}.tar.gz"
        metadata_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "tool": "aria2c",
                    "provider": "bilikara-r2",
                    "platform": "darwin",
                    "arch": "arm64",
                    "name": asset_name,
                    "url": f"https://download.example/bilikara/tools/aria2/1.37.0/{revision}/{asset_name}",
                    "sha256": "b" * 64,
                    "version": "1.37.0",
                    "source_url": (
                        "https://github.com/aria2/aria2/releases/download/"
                        "release-1.37.0/aria2-1.37.0.tar.xz"
                    ),
                    "source_sha256": (
                        "60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"
                    ),
                    "recipe_revision": revision,
                }
            ),
            encoding="utf-8",
        )
        aria2_dir = root / "tools" / "aria2c"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.ARIA2_MACOS_METADATA_PATH",
            root / "missing-vendor" / "aria2-macos.json",
        ), patch("bilikara.cache.INTERNAL_VENDOR_DIR", root / "missing-internal"), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL",
            "https://download.example/bilikara/tools",
        ), patch("bilikara.cache.PACKAGED_RUNTIME", True), patch(
            "bilikara.cache.sys.executable", str(executable)
        ), patch.object(CacheManager, "_system_aria2c_path", return_value=None), patch.object(
            CacheManager, "_brew_executable", return_value=None
        ), patch.object(
            CacheManager, "_current_platform_tokens", return_value=("darwin", "arm64")
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                status = manager.downloader_status(DOWNLOAD_SOURCE_DOWNKYI)
            finally:
                manager.shutdown()

        self.assertFalse(status["ready"])
        self.assertTrue(status["auto_prepare_supported"])
        self.assertTrue(status["requires_prepare"])

    def test_macos_direct_prepare_downloads_validates_and_publishes_atomically(self):
        root = Path(self.temp_dir.name) / "macos-direct-install"
        aria2_dir = root / "tools" / "aria2c"
        metadata_path = root / "vendor" / "aria2-macos.json"
        metadata_path.parent.mkdir(parents=True)
        source_archive = root / "source.tar.gz"
        binary_bytes = b"portable-aria2c"
        with tarfile.open(source_archive, "w:gz") as bundle:
            entry = tarfile.TarInfo("aria2c")
            entry.size = len(binary_bytes)
            bundle.addfile(entry, io.BytesIO(binary_bytes))
        archive_sha = hashlib.sha256(source_archive.read_bytes()).hexdigest()
        revision = "c" * 40
        asset_name = f"aria2-1.37.0-macos-arm64-{revision}.tar.gz"
        metadata_path.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "tool": "aria2c",
                    "provider": "bilikara-r2",
                    "platform": "darwin",
                    "arch": "arm64",
                    "name": asset_name,
                    "url": f"https://download.example/bilikara/tools/aria2/1.37.0/{revision}/{asset_name}",
                    "sha256": archive_sha,
                    "version": "1.37.0",
                    "source_url": (
                        "https://github.com/aria2/aria2/releases/download/"
                        "release-1.37.0/aria2-1.37.0.tar.xz"
                    ),
                    "source_sha256": (
                        "60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b"
                    ),
                    "recipe_revision": revision,
                }
            ),
            encoding="utf-8",
        )

        def fake_download(_asset: dict, target: Path, **_kwargs) -> None:
            shutil.copy2(source_archive, target)

        target = aria2_dir / "aria2c"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2_MACOS_METADATA_PATH", metadata_path), patch(
            "bilikara.cache.INTERNAL_VENDOR_DIR", root / "missing-internal"
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL",
            "https://download.example/bilikara/tools",
        ), patch.object(CacheManager, "_current_platform_tokens", return_value=("darwin", "arm64")):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_fetch_aria2_release") as fetch_release, patch.object(
                    manager, "_download_tool_asset", side_effect=fake_download
                ) as download, patch.object(
                    manager, "_read_aria2c_version", return_value="1.37.0"
                ), patch.object(CacheManager, "_brew_executable", return_value=None):
                    manager._install_aria2c(target, allow_brew_fallback=False)
            finally:
                manager.shutdown()

        self.assertEqual(target.read_bytes(), binary_bytes)
        if os.name != "nt":
            self.assertTrue(target.stat().st_mode & stat.S_IEXEC)
        fetch_release.assert_not_called()
        download.assert_called_once()
        self.assertEqual(list(aria2_dir.glob(".prepare-*")), [])

    def test_macos_failed_direct_prepare_preserves_existing_runtime_and_source(self):
        root = Path(self.temp_dir.name) / "macos-direct-failure"
        aria2_dir = root / "tools" / "aria2c"
        target = aria2_dir / "aria2c"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"existing-runtime")
        bad_archive = root / "bad.tar.gz"
        bad_archive.write_bytes(b"not-an-archive")
        mirror_asset = {
            "name": "aria2-1.37.0-macos-arm64-test.tar.gz",
            "browser_download_url": "https://download.example/aria2.tar.gz",
            "sha256": "d" * 64,
            "version": "1.37.0",
        }

        def fake_download(_asset: dict, destination: Path, **_kwargs) -> None:
            shutil.copy2(bad_archive, destination)

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch.object(CacheManager, "_current_platform_tokens", return_value=("darwin", "arm64")):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_fetch_aria2_release", return_value={"assets": []}), patch.object(
                    manager, "_macos_aria2_asset", return_value=mirror_asset
                ), patch.object(manager, "_download_tool_asset", side_effect=fake_download), patch.object(
                    manager, "_brew_executable", return_value=None
                ):
                    with self.assertRaisesRegex(RuntimeError, "automatic preparation failed"):
                        manager._install_aria2c(target, allow_brew_fallback=False)
            finally:
                manager.shutdown()

        self.assertEqual(target.read_bytes(), b"existing-runtime")
        self.assertEqual(manager.download_source, DOWNLOAD_SOURCE_BBDOWN)

    def test_existing_runtime_aria2c_skips_all_preparation_network(self):
        aria2_dir = Path(self.temp_dir.name) / "existing-aria2" / "tools" / "aria2c"
        target = aria2_dir / ("aria2c.exe" if os.name == "nt" else "aria2c")
        target.parent.mkdir(parents=True)
        target.write_bytes(b"existing-aria2")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch.object(
            CacheManager, "_system_aria2c_path", return_value=None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_aria2c_binary_path", return_value=target), patch.object(
                    manager, "_read_aria2c_version", return_value="1.37.0"
                ), patch.object(manager, "_install_aria2c") as install, patch.object(
                    manager, "_fetch_aria2_release"
                ) as fetch:
                    self.assertEqual(manager._ensure_aria2c(), target)
            finally:
                manager.shutdown()
        install.assert_not_called()
        fetch.assert_not_called()

    def test_bbdown_stream_preference_args_use_cache_policy(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.set_cache_policy(video_quality="720P 高清", audio_hires=False)
                self.assertEqual(
                    manager._bbdown_stream_preference_args("video"),
                    ["-q", "720P 高清,480P 清晰,360P 流畅"],
                )
                self.assertEqual(manager._bbdown_stream_preference_args("audio"), ["--audio-ascending"])
            finally:
                manager.shutdown()

    def test_ytdlp_download_command_uses_policy_and_login_cookie(self):
        target_dir = self.cache_dir / "song-a" / "video-p2"
        target_dir.mkdir(parents=True, exist_ok=True)
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.set_cache_policy(video_quality=VIDEO_QUALITY_CHOICES[2], audio_hires=False)
                with patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test-cookie"), patch.object(
                    CacheManager,
                    "_tool_arg_path",
                    side_effect=lambda path: str(path),
                ):
                    command = manager._ytdlp_download_command(
                        Path("/tools/ytdlp/yt-dlp.exe"),
                        Path("/tools/ffmpeg/ffmpeg.exe"),
                        "https://www.bilibili.com/video/BV1xx411c7mD?p=2",
                        page=2,
                        stream_kind="video",
                        target_dir=target_dir,
                    )
                    cookie_file = Path(command[command.index("--cookies") + 1])
                    self.assertTrue(cookie_file.exists(), f"cookie jar file not found: {cookie_file}")
                    cookie_content = cookie_file.read_text(encoding="utf-8")
                    self.assertIn("SESSDATA", cookie_content)
                    self.assertIn("test-cookie", cookie_content)
                    for line in cookie_content.splitlines():
                        if "SESSDATA" in line and not line.startswith("#"):
                            self.assertIn("\tTRUE\t/\tTRUE\t", line, "SESSDATA should have secure=TRUE")
                    self.assertNotIn("--add-header", command)
                    self.assertNotIn("--cookies-from-browser", command)
            finally:
                manager.shutdown()

        self.assertEqual(command[0], str(Path("/tools/ytdlp/yt-dlp.exe")))
        self.assertIn("--newline", command)
        self.assertIn("--no-playlist", command)
        self.assertIn("--retries", command)
        self.assertEqual(command[command.index("--retries") + 1], "10")
        self.assertIn("--fragment-retries", command)
        self.assertEqual(command[command.index("--fragment-retries") + 1], "10")
        self.assertIn("--file-access-retries", command)
        self.assertEqual(command[command.index("--file-access-retries") + 1], "10")
        self.assertIn("--retry-sleep", command)
        self.assertEqual(command[command.index("--retry-sleep") + 1], "3")
        self.assertIn("--throttled-rate", command)
        self.assertEqual(command[command.index("--throttled-rate") + 1], "100K")
        self.assertIn("--concurrent-fragments", command)
        self.assertEqual(command[command.index("--concurrent-fragments") + 1], "1")
        self.assertIn("height<=720", command[command.index("-f") + 1])
        self.assertIn("--cookies", command)

    def test_ytdlp_download_command_falls_back_to_browser_cookies(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch("bilikara.cache.effective_bilibili_cookie", return_value=""), patch.dict(
                    os.environ,
                    {"YTDLP_COOKIES_FROM_BROWSER": "firefox"},
                ), patch.object(
                    CacheManager,
                    "_tool_arg_path",
                    side_effect=lambda path: str(path),
                ):
                    command = manager._ytdlp_download_command(
                        Path("/tools/ytdlp/yt-dlp.exe"),
                        Path("/tools/ffmpeg/ffmpeg.exe"),
                        "https://www.bilibili.com/video/BV1xx411c7mD?p=1",
                        page=1,
                        stream_kind="audio",
                        target_dir=Path("/cache/song-a/audio-p1"),
                    )
            finally:
                manager.shutdown()

        self.assertEqual(command[command.index("-f") + 1], "ba/bestaudio")
        self.assertEqual(command[command.index("--cookies-from-browser") + 1], "firefox")
        self.assertNotIn("--add-header", command)

    def test_bbdown_stream_preference_args_force_avc_when_hevc_unsupported(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                snapshot = manager.set_client_media_capabilities(
                    {
                        "hevc_supported": False,
                        "avc_supported": True,
                        "max_avc_quality_index": 2,
                        "can_play_type": {'video/mp4; codecs="hvc1"': ""},
                        "user_agent": "Firefox on Windows 7",
                        "platform": "Win32",
                    }
                )
                self.assertTrue(snapshot["force_avc"])
                self.assertEqual(snapshot["max_avc_quality"], VIDEO_QUALITY_CHOICES[2])
                self.assertEqual(
                    manager._bbdown_stream_preference_args("video"),
                    ["-q", ",".join(VIDEO_QUALITY_CHOICES[2:]), "-e", "avc"],
                )
                self.assertEqual(manager._bbdown_stream_preference_args("audio"), [])
            finally:
                manager.shutdown()

    def test_avc_quality_cap_does_not_raise_lower_manual_quality(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                max_avc_quality_index = min(2, len(VIDEO_QUALITY_CHOICES) - 2)
                manual_quality_index = max_avc_quality_index + 1
                manager.set_cache_policy(video_quality=VIDEO_QUALITY_CHOICES[manual_quality_index])
                manager.set_client_media_capabilities(
                    {
                        "hevc_supported": False,
                        "avc_supported": True,
                        "max_avc_quality_index": max_avc_quality_index,
                    }
                )
                self.assertEqual(
                    manager._bbdown_stream_preference_args("video"),
                    ["-q", ",".join(VIDEO_QUALITY_CHOICES[manual_quality_index:]), "-e", "avc"],
                )
            finally:
                manager.shutdown()

    def test_hevc_unsupported_without_avc_level_falls_back_to_lowest_quality(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                snapshot = manager.set_client_media_capabilities({"hevc_supported": False})
                self.assertEqual(snapshot["max_avc_quality"], VIDEO_QUALITY_CHOICES[-1])
                self.assertEqual(
                    manager._bbdown_stream_preference_args("video"),
                    ["-q", VIDEO_QUALITY_CHOICES[-1], "-e", "avc"],
                )
            finally:
                manager.shutdown()

    def test_hevc_unsupported_requeues_desired_ready_items_for_avc(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                self.mark_item_ready_with_files("song-a")
                before = self.store.get_item("song-a")
                item_dir = self.cache_dir / before.artifact_relative_directory
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock:
                    manager.set_client_media_capabilities({"hevc_supported": False})

                refreshed = self.store.get_item("song-a")
                self.assertIsNotNone(refreshed)
                self.assertEqual(refreshed.cache_status, "ready")
                self.assertEqual(refreshed.video_media_url, before.video_media_url)
                self.assertEqual(refreshed.audio_variants, before.audio_variants)
                self.assertEqual(refreshed.selected_audio_variant_id, "p1")
                self.assertTrue(item_dir.exists())
                enqueue_mock.assert_called_once_with("song-a")
            finally:
                manager.shutdown()

    def test_hidden_process_kwargs_hides_windows_console(self):
        with patch("bilikara.cache.os.name", "nt"):
            kwargs = CacheManager._hidden_process_kwargs()
        self.assertEqual(kwargs["creationflags"], 0x08000000)

    def test_append_log_line_writes_bbdown_log_file(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = manager._item_log_path("song-a")
                manager._append_log_line(log_path, "缓存中")
                self.assertTrue(log_path.exists())
                self.assertIn("缓存中", log_path.read_text(encoding="utf-8"))
            finally:
                manager.shutdown()

    def test_clear_log_root_preserves_startup_diagnostics(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        log_dir.mkdir(parents=True)
        desktop_log = log_dir / "desktop-startup.log"
        login_log = log_dir / "bilibili-login.log"
        transient_log = log_dir / "transient.log"
        transient_dir = log_dir / "bbdown"
        desktop_log.write_text("desktop diagnostic\n", encoding="utf-8")
        login_log.write_text("login diagnostic\n", encoding="utf-8")
        transient_log.write_text("temporary\n", encoding="utf-8")
        transient_dir.mkdir()
        (transient_dir / "item.log").write_text("temporary\n", encoding="utf-8")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.LOG_DIR", log_dir
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager._clear_log_root()
            finally:
                manager.shutdown()

        self.assertTrue(desktop_log.is_file())
        self.assertTrue(login_log.is_file())
        self.assertFalse(transient_log.exists())
        self.assertFalse(transient_dir.exists())

    def test_drop_item_cache_removes_related_log_file(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        item_dir = self.cache_dir / "song-a"
        item_dir.mkdir(parents=True, exist_ok=True)
        (item_dir / "video.mp4").write_bytes(b"123")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                log_path = manager._item_log_path("song-a")
                manager._append_log_line(log_path, "缓存日志")
                manager._drop_item_cache("song-a", "释放缓存")
                self.assertTrue(item_dir.exists())
                self.assertFalse(log_path.exists())
            finally:
                manager.shutdown()

    def test_remove_cache_dir_ignores_windows_missing_path_race(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        missing_error = OSError(3, "系统找不到指定的路径。")
        missing_error.winerror = 3

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir), patch(
            "bilikara.cache.shutil.rmtree",
            side_effect=missing_error,
        ) as rmtree_mock:
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager._remove_cache_dir("song-a", cache_attempt_token=41)
            finally:
                manager.shutdown()

        rmtree_mock.assert_called_once_with(
            self.cache_dir / ".staging" / "attempt-41", ignore_errors=True
        )

    def test_path_size_ignores_directory_removed_during_scan(self):
        item_dir = self.cache_dir / "song-a"
        item_dir.mkdir(parents=True, exist_ok=True)

        with patch.object(Path, "rglob", side_effect=OSError(3, "missing path")):
            self.assertEqual(CacheManager._path_size(item_dir), 0)

    def test_enrich_snapshot_includes_cache_activity_timestamp(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.item_activity_at["song-a"] = 123.0
                payload = {
                    "current_item": {"id": "song-a"},
                    "playlist": [{"id": "song-a"}],
                }
                enriched = manager.enrich_snapshot(payload)
            finally:
                manager.shutdown()

        self.assertEqual(enriched["current_item"]["cache_activity_at"], 123.0)
        self.assertEqual(enriched["playlist"][0]["cache_activity_at"], 123.0)

    def test_item_cache_ready_requires_video_and_audio_files(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                item.cache_status = "ready"
                item.video_relative_path = "song-a/video.mp4"
                item.video_media_url = "/media/song-a/video.mp4"
                item.audio_variants = [
                    {"id": "p1", "label": "P1", "audio_url": "/media/song-a/audio.m4a"}
                ]
                item_dir = self.cache_dir / "song-a"
                item_dir.mkdir(parents=True, exist_ok=True)
                (item_dir / "video.mp4").write_bytes(b"video")

                self.assertFalse(manager._item_cache_ready(item))

                (item_dir / "audio.m4a").write_bytes(b"audio")
                self.assertTrue(manager._item_cache_ready(item))
            finally:
                manager.shutdown()

    def test_ensure_item_cached_preserves_selected_audio_variant_while_requeueing(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                item.page = 2
                item.video_page = 2
                item.selected_pages = [1, 2]
                item.selected_parts = ["main track", "off vocal"]
                item.selected_audio_variant_id = "p2_off_vocal"
                self.store.add_item(item, requester_name="cache-test-user")

                manager._ensure_item_cached(item)

                updated = self.store.get_item("song-a")
                self.assertIsNotNone(updated)
                self.assertEqual(updated.cache_status, "pending")
                self.assertEqual(updated.audio_variants, [])
                self.assertEqual(updated.selected_audio_variant_id, "")
            finally:
                manager.shutdown()

    def test_reconcile_cache_state_requeues_ready_item_when_files_are_missing(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-b"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-c"), requester_name="cache-test-user")
                self.project_missing_ready("song-a")
                with manager.lock:
                    manager.pending_ids = {"song-b", "song-c"}
                    for item_id in ["song-b", "song-c"]:
                        manager.tasks.put(item_id)

                manager.reconcile_cache_state()

                song_a = self.store.get_item("song-a")
                self.assertIsNotNone(song_a)
                self.assertEqual(song_a.cache_status, "pending")
                self.assertEqual(song_a.video_relative_path, "")
                self.assertEqual(song_a.video_media_url, "")
                self.assertEqual(song_a.audio_variants, [])

                queued_ids = []
                while True:
                    try:
                        queued_ids.append(manager.tasks.get_nowait())
                    except queue.Empty:
                        break
                self.assertEqual(queued_ids, ["song-a", "song-b", "song-c"])
            finally:
                manager.shutdown()

    def test_reconcile_invalidates_before_planning_and_refreshes_after_ensure(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                self.project_missing_ready("song-a")
                events = []
                planned_statuses = []
                original_planner = manager._plan_cache_snapshot

                def record_plan(items, **kwargs):
                    events.append("plan")
                    planned_statuses.append(self.store.get_item("song-a").cache_status)
                    return original_planner(items, **kwargs)

                with patch.object(
                    manager,
                    "_plan_cache_snapshot",
                    side_effect=record_plan,
                ) as planner_mock, patch.object(
                    manager,
                    "_ensure_item_cached",
                    side_effect=lambda item: events.append(f"ensure:{item.id}"),
                ), patch.object(
                    manager,
                    "_apply_cache_plan_priority",
                    side_effect=lambda items, plan: events.append("apply"),
                ):
                    manager.reconcile_cache_state()

                self.assertEqual(planner_mock.call_count, 1)
                self.assertEqual(planned_statuses, ["pending"])
                self.assertEqual(events, ["plan", "ensure:song-a", "apply"])
            finally:
                manager.shutdown()

    def test_sync_with_playlist_keeps_ready_current_and_targets_following_window_items(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                for item_id in ["song-a", "song-b", "song-c", "song-d"]:
                    self.store.add_item(self.make_item(item_id), requester_name="cache-test-user")
                self.mark_item_ready_with_files("song-a")

                with patch(
                    "bilikara.cache.rust_backend.try_plan_cache_window",
                    wraps=rust_backend.try_plan_cache_window,
                ) as planner_mock:
                    manager.sync_with_playlist()

                song_a = self.store.get_item("song-a")
                self.assertIsNotNone(song_a)
                self.assertEqual(song_a.cache_status, "ready")
                self.assertTrue(
                    (self.cache_dir / song_a.artifact_relative_directory).exists()
                )
                self.assertEqual(manager.desired_ids, {"song-a", "song-b", "song-c"})
                self.assertEqual(manager.ordered_desired_ids, ["song-b", "song-c"])
                self.assertEqual(planner_mock.call_count, 1)
            finally:
                manager.shutdown()

    def test_sync_after_removing_item_tolerates_parallel_active_processes(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            processes = [
                subprocess.Popen([sys.executable, "-c", "pass"]),  # noqa: S603
                subprocess.Popen([sys.executable, "-c", "pass"]),  # noqa: S603
            ]
            try:
                for process in processes:
                    process.wait(timeout=5)
                for item_id in ["song-a", "song-b"]:
                    self.store.add_item(self.make_item(item_id), requester_name="cache-test-user")
                with manager.lock:
                    manager.active_item_id = "song-a"
                    manager.active_processes = set(processes)
                    manager.active_process_item_ids = {
                        process: "song-a" for process in processes
                    }

                self.assertEqual(
                    manager._cache_priority_state(),
                    ("song-a", ("song-a",), ()),
                )
                self.assertTrue(self.store.remove_item("song-a"))

                manager.sync_with_playlist()

                self.assertIsNone(self.store.get_item("song-a"))
                self.assertEqual(manager.desired_ids, {"song-b"})
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)
                manager.shutdown()

    def test_sync_refreshes_priority_plan_after_ensure_starts_active_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            fake_process = SimpleNamespace(
                poll=lambda: None,
                terminate=lambda: None,
                wait=lambda timeout=None: None,
                kill=lambda: None,
            )
            try:
                for item_id in ["song-a", "song-b", "song-c"]:
                    self.store.add_item(self.make_item(item_id), requester_name="cache-test-user")
                with manager.lock:
                    manager.pending_ids = {"song-a", "song-b", "song-c"}
                    for item_id in ["song-c", "song-b", "song-a"]:
                        manager.tasks.put(item_id)

                plans = []
                original_planner = manager._plan_cache_snapshot

                def record_plan(items, **kwargs):
                    plan = original_planner(items, **kwargs)
                    plans.append(plan)
                    return plan

                def expose_later_active_item(item):
                    if item.id == "song-a":
                        with manager.lock:
                            manager.active_item_id = "song-b"
                            manager.active_process = fake_process

                with patch.object(
                    manager,
                    "_plan_cache_snapshot",
                    side_effect=record_plan,
                ), patch.object(
                    manager,
                    "_ensure_item_cached",
                    side_effect=expose_later_active_item,
                ), patch.object(
                    manager,
                    "_terminate_process",
                ) as terminate_mock:
                    manager.sync_with_playlist()

                self.assertEqual(len(plans), 2)
                self.assertEqual(plans[0].preempt_ids, ())
                self.assertEqual(plans[1].preempt_ids, ("song-b",))
                terminate_mock.assert_called_once_with(fake_process)
                self.assertEqual(
                    manager.cache_interrupted_messages["song-b"],
                    "等待优先缓存: title-song-a - P1",
                )
                self.assertIn("song-b", manager.requeued_active_ids)
                queued_ids = []
                while True:
                    try:
                        queued_ids.append(manager.tasks.get_nowait())
                    except queue.Empty:
                        break
                self.assertEqual(queued_ids, ["song-a", "song-b", "song-c"])
            finally:
                manager.shutdown()

    def test_sync_reuses_plan_when_ensure_keeps_priority_inputs_unchanged(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            try:
                for item_id in ["song-a", "song-b"]:
                    self.store.add_item(self.make_item(item_id), requester_name="cache-test-user")
                state_plan = CachePlan(
                    desired_ids=("song-a", "song-b"),
                    pending_order=("song-a", "song-b"),
                    retained_ids=("song-a", "song-b"),
                    preempt_ids=(),
                )
                events = []

                def plan_snapshot(items):
                    events.append("plan")
                    return state_plan

                with patch.object(
                    manager,
                    "_plan_cache_snapshot",
                    side_effect=plan_snapshot,
                ), patch.object(
                    manager,
                    "_ensure_item_cached",
                    side_effect=lambda item: events.append(f"ensure:{item.id}"),
                ), patch.object(
                    manager,
                    "_apply_cache_plan_priority",
                    side_effect=lambda items, plan: events.append(("apply", plan)),
                ) as apply_mock:
                    manager.sync_with_playlist()

                self.assertEqual(
                    events,
                    [
                        "plan",
                        "ensure:song-a",
                        "ensure:song-b",
                        ("apply", state_plan),
                    ],
                )
                apply_mock.assert_called_once()
            finally:
                manager.shutdown()

    def test_cache_ready_requests_worker_resync_after_success(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                item = self.store.get_item(item.id)
                self.assertIsNotNone(item)
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                    manager.ordered_desired_ids = ["song-a"]
                    manager.python_worker_download_sources["song-a"] = (
                        DOWNLOAD_SOURCE_NATIVE
                    )
                with patch("bilikara.cache.rust_runtime.http_download_available", return_value=True), patch(
                    "bilikara.cache.rust_runtime.media_backend_available", return_value=True
                ), patch.object(
                    manager,
                    "_download_selected_streams",
                    side_effect=lambda *_args, **_kwargs: self.staged_cache_result(
                        _args[3], native_tracks_prevalidated=True
                    ),
                ), patch.object(
                    manager,
                    "sync_with_playlist",
                ) as sync_mock:
                    should_resync = manager._cache_item_multi("song-a", item, allow_refresh_retry=True)

                cached = self.store.get_item("song-a")
                self.assertIsNotNone(cached)
                self.assertEqual(cached.cache_status, "ready")
                self.assertTrue(should_resync)
                sync_mock.assert_not_called()
            finally:
                manager.shutdown()

    def test_python_cache_lifecycle_uses_typed_appstate_events(self):
        item = self.make_item("song-python-events")
        self.store.add_item(item, requester_name="cache-test-user")
        item = self.store.get_item(item.id)
        self.assertIsNotNone(item)
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.download_source = DOWNLOAD_SOURCE_BBDOWN
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                    manager.python_worker_download_sources[item.id] = (
                        DOWNLOAD_SOURCE_BBDOWN
                    )

                projected_events: list[tuple[int, dict[str, object]]] = []
                operation_order: list[str] = []
                apply_cache_event = self.store.apply_cache_event
                begin_cache_attempt = manager._begin_cache_attempt

                def reserve_attempt(
                    item_id: str,
                    item_incarnation_id: str,
                ) -> int:
                    operation_order.append("reserve")
                    return begin_cache_attempt(item_id, item_incarnation_id)

                def record_event(
                    item_id: str,
                    *,
                    cache_attempt_token: int,
                    event: dict[str, object],
                ) -> bool:
                    projected_events.append((cache_attempt_token, dict(event)))
                    return apply_cache_event(
                        item_id,
                        cache_attempt_token=cache_attempt_token,
                        event=event,
                    )

                def download_with_progress(*_args, **_kwargs):
                    operation_order.append("download")
                    manager._project_cache_progress(
                        item.id,
                        cache_attempt_token=_kwargs["cache_attempt_token"],
                        progress=42.0,
                        message="BBDown 缓存中 42%",
                    )
                    return self.staged_cache_result(_args[3])

                with patch.object(
                    self.store,
                    "apply_cache_event",
                    side_effect=record_event,
                ), patch.object(
                    manager,
                    "_begin_cache_attempt",
                    side_effect=reserve_attempt,
                ), patch.object(
                    self.store,
                    "update_item",
                    side_effect=AssertionError("generic item patch used by cache worker"),
                ), patch.object(
                    manager,
                    "_ensure_downloader",
                    side_effect=lambda _source: (
                        operation_order.append("prepare-downloader")
                        or Path("BBDown")
                    ),
                ), patch.object(
                    manager,
                    "_ensure_ffmpeg",
                    side_effect=lambda **_kwargs: (
                        operation_order.append("prepare-ffmpeg")
                        or Path("ffmpeg")
                    ),
                ), patch.object(
                    manager,
                    "_download_selected_streams",
                    side_effect=download_with_progress,
                ), patch.object(manager, "_validate_cache_result"):
                    self.assertTrue(
                        manager._cache_item_multi(
                            item.id,
                            item,
                            allow_refresh_retry=False,
                        )
                    )

                self.assertEqual(
                    [event["kind"] for _, event in projected_events],
                    ["queued", "started", "progress", "ready"],
                )
                self.assertEqual(
                    [token for token, _ in projected_events],
                    [projected_events[0][0]] * 4,
                )
                self.assertGreater(projected_events[0][0], 0)
                self.assertEqual(
                    operation_order,
                    ["reserve", "prepare-downloader", "prepare-ffmpeg", "download"],
                )
                cached = self.store.get_item(item.id)
                self.assertEqual(cached.cache_status, "ready")
                self.assertEqual(
                    cached.video_relative_path,
                    f"{cached.artifact_relative_directory}/video-p1.mp4",
                )
                self.assertEqual(cached.selected_audio_variant_id, "p1")
            finally:
                manager.shutdown()

    def test_all_retained_sources_publish_only_rust_reserved_immutable_paths(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test"
        ), patch(
            "bilikara.cache.rust_runtime.http_download_available", return_value=True
        ), patch(
            "bilikara.cache.rust_runtime.media_backend_available", return_value=True
        ):
            manager = CacheManager(self.store, max_cache_items=5)
            try:
                for source in (
                    DOWNLOAD_SOURCE_BBDOWN,
                    DOWNLOAD_SOURCE_YTDLP,
                    DOWNLOAD_SOURCE_DOWNKYI,
                    DOWNLOAD_SOURCE_NATIVE,
                ):
                    with self.subTest(source=source):
                        item = self.make_item(f"song-{source}")
                        self.store.add_item(
                            item, requester_name="cache-test-user"
                        )
                        item = self.store.get_item(item.id)
                        self.assertIsNotNone(item)
                        with manager.lock:
                            manager.download_source = source
                            manager.desired_ids.add(item.id)
                            manager.python_worker_download_sources[item.id] = source

                        def fixture(*args, **_kwargs):
                            result = self.staged_cache_result(
                                args[3],
                                native_tracks_prevalidated=(
                                    source == DOWNLOAD_SOURCE_NATIVE
                                ),
                            )
                            if source == DOWNLOAD_SOURCE_DOWNKYI:
                                result["downkyi_tracks_prevalidated"] = True
                            return result

                        with patch.object(
                            manager, "_ensure_downloader", return_value=Path(source)
                        ), patch.object(
                            manager, "_ensure_ffmpeg", return_value=Path("ffmpeg")
                        ), patch.object(
                            manager,
                            "_download_selected_streams",
                            side_effect=fixture,
                        ), patch.object(manager, "_validate_cache_result"):
                            self.assertTrue(
                                manager._cache_item_multi(
                                    item.id,
                                    item,
                                    allow_refresh_retry=False,
                                )
                            )

                        committed = self.store.get_item(item.id)
                        self.assertEqual(committed.cache_status, "ready")
                        self.assertTrue(committed.item_incarnation_id.startswith("i-"))
                        self.assertTrue(committed.artifact_set_id.startswith("a-"))
                        self.assertTrue(
                            committed.video_relative_path.startswith(
                                f"{committed.artifact_relative_directory}/"
                            )
                        )
                        self.assertTrue(
                            (
                                self.cache_dir
                                / committed.artifact_relative_directory
                                / "video-p1.mp4"
                            ).is_file()
                        )
            finally:
                manager.shutdown()

    def test_native_prevalidated_tracks_skip_legacy_batch_validation(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-downkyi")
                item.selected_pages = [1]
                item.selected_cids = [item.cid]
                item.selected_durations = [120]
                item.video_page = 1
                self.store.add_item(item, requester_name="cache-test-user")
                item = self.store.get_item(item.id)
                self.assertIsNotNone(item)
                manager.download_source = DOWNLOAD_SOURCE_NATIVE
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                    manager.python_worker_download_sources[item.id] = (
                        DOWNLOAD_SOURCE_NATIVE
                    )

                def prevalidated_result(*_args, **_kwargs):
                    return self.staged_cache_result(
                        _args[3], native_tracks_prevalidated=True
                    )

                with patch("bilikara.cache.rust_runtime.http_download_available", return_value=True), patch(
                    "bilikara.cache.rust_runtime.media_backend_available", return_value=True
                ), patch.object(
                    manager, "_download_selected_streams", side_effect=prevalidated_result
                ), patch.object(
                    manager, "_validate_cache_result"
                ) as validate_mock:
                    self.assertTrue(
                        manager._cache_item_multi(item.id, item, allow_refresh_retry=False)
                    )

                validate_mock.assert_not_called()
                cached = self.store.get_item(item.id)
                self.assertIsNotNone(cached)
                self.assertEqual(cached.cache_status, "ready")
                self.assertNotIn(".attempt-", cached.video_media_url)
                self.assertNotIn(".attempt-", cached.audio_variants[0]["audio_url"])
            finally:
                manager.shutdown()

    def test_worker_resyncs_ready_cache_after_pending_bookkeeping(self):
        worker_loop = CacheManager._worker_loop
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.pending_ids = {"song-a"}
                manager.python_cache_attempt_tokens["song-a"] = 1
                manager.tasks.put("song-a")
                resync_states = []

                def sync_once() -> None:
                    resync_states.append((set(manager.pending_ids), manager.active_item_id))
                    manager.stop_event.set()

                with patch.object(manager, "_cache_item", return_value=True), patch.object(
                    manager,
                    "sync_with_playlist",
                    side_effect=sync_once,
                ) as sync_mock:
                    worker_loop(manager)

                sync_mock.assert_called_once_with()
                self.assertEqual(resync_states, [(set(), None)])
            finally:
                manager.shutdown()

    def test_worker_continues_after_typed_attempt_publication_rejection(self):
        worker_loop = CacheManager._worker_loop
        bad = self.make_item("song-stale-publication")
        good = self.make_item("song-after-stale-publication")
        for item in (bad, good):
            self.store.add_item(item, requester_name="cache-test-user")
        stale_token = begin_cache_attempt(self.store, bad.id)
        begin_cache_attempt(self.store, bad.id)
        good_token = begin_cache_attempt(self.store, good.id)

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            processed: list[str] = []
            try:
                with manager.lock:
                    manager.pending_ids = {bad.id, good.id}
                    manager.python_worker_download_sources = {
                        bad.id: DOWNLOAD_SOURCE_BBDOWN,
                        good.id: DOWNLOAD_SOURCE_BBDOWN,
                    }
                    manager.python_cache_attempt_tokens = {
                        bad.id: stale_token,
                        good.id: good_token,
                    }
                manager.tasks.put(bad.id)
                manager.tasks.put(good.id)

                def cache_item(item_id: str, cache_attempt_token: int) -> bool:
                    if item_id == bad.id:
                        manager._project_cache_event(
                            item_id,
                            "failed",
                            cache_attempt_token=cache_attempt_token,
                            message="stale terminal",
                        )
                    processed.append(item_id)
                    manager.stop_event.set()
                    return False

                with patch.object(manager, "_cache_item", side_effect=cache_item):
                    worker_loop(manager)

                self.assertEqual(processed, [good.id])
                self.assertEqual(self.store.get_item(bad.id).cache_status, "pending")
            finally:
                manager.stop_event.clear()
                manager.shutdown()

    def test_sync_with_playlist_keeps_three_ready_items_as_retention_buffer(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=1)
            try:
                for item_id in ["song-a", "song-b", "song-c", "song-d", "song-e"]:
                    self.store.add_item(self.make_item(item_id), requester_name="cache-test-user")
                for item_id in ["song-b", "song-c", "song-d", "song-e"]:
                    self.mark_item_ready_with_files(item_id)

                manager.sync_with_playlist()

                for item_id in ["song-b", "song-c", "song-d"]:
                    cached = self.store.get_item(item_id)
                    self.assertIsNotNone(cached)
                    self.assertEqual(cached.cache_status, "ready")
                    self.assertTrue(
                        (self.cache_dir / cached.artifact_relative_directory).exists()
                    )

                song_e = self.store.get_item("song-e")
                self.assertIsNotNone(song_e)
                self.assertEqual(song_e.cache_status, "pending")
                self.assertTrue(
                    any(
                        path.is_file()
                        for path in (self.cache_dir / "artifacts").rglob("*")
                    )
                )
            finally:
                manager.shutdown()

    def test_retry_item_requeues_failed_cache_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                self.project_cache_failed("song-a", message="缓存失败")
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock:
                    manager.retry_item("song-a")
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "queued")
                    self.assertEqual(retried.cache_message, "准备重新下载")
                    enqueue_mock.assert_called_once_with("song-a")
            finally:
                manager.shutdown()

    def test_aria2c_download_uses_backup_urls_as_mirror_uris(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                target_dir = self.cache_dir / "song-a" / "video-p1"
                log_path = Path(self.temp_dir.name) / "download.log"
                captured = {}

                def fake_run_item_command(_item_id, command, *_args, **_kwargs):
                    captured["command"] = list(command)
                    attempt_dir = Path(command[command.index("--dir") + 1])
                    out_name = command[command.index("--out") + 1]
                    attempt_dir.mkdir(parents=True, exist_ok=True)
                    (attempt_dir / out_name).write_bytes(b"video")

                with patch.object(manager, "_run_item_command", side_effect=fake_run_item_command):
                    path = manager._download_stream_with_aria2c(
                        "song-a",
                        Path("aria2c.exe"),
                        Path("ffmpeg.exe"),
                        target_dir,
                        log_path,
                        urls=["https://primary.example/video.m4s", "https://backup.example/video.m4s"],
                        out_name="video-p1.mp4",
                        cookie="",
                        stage_label="download video",
                        track_key="video-p1",
                        cache_attempt_token=1,
                        stream_kind="video",
                    )

                command = captured["command"]
                self.assertEqual(path.name, "video-p1.mp4")
                self.assertTrue(path.parent.name.startswith(".attempt-"))
                self.assertEqual(path.parent.parent, target_dir)
                self.assertFalse((target_dir / "video-p1.mp4").exists())
                self.assertIn("https://primary.example/video.m4s", command)
                self.assertIn("https://backup.example/video.m4s", command)
                self.assertLess(command.index("https://backup.example/video.m4s"), command.index("--dir"))
                self.assertNotIn("--referer", command)
                self.assertIn("--continue=false", command)
                self.assertIn("--max-tries=1", command)
                self.assertIn("--human-readable=false", command)
                self.assertIn("--split=16", command)
                self.assertIn("--max-connection-per-server=16", command)
                self.assertIn("--auto-file-renaming=false", command)
                self.assertIn("--allow-overwrite=false", command)
                self.assertNotIn("--continue=true", command)
            finally:
                manager.shutdown()

    def test_retry_item_can_force_requeue_ready_cache_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                self.mark_item_ready_with_files("song-a")
                before = self.store.get_item("song-a")
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock:
                    manager.retry_item("song-a", force=True)
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "ready")
                    self.assertEqual(retried.cache_message, "准备重新下载")
                    self.assertEqual(retried.video_media_url, before.video_media_url)
                    self.assertEqual(retried.artifact_set_id, before.artifact_set_id)
                    self.assertTrue(
                        (
                            self.cache_dir / before.artifact_relative_directory
                        ).is_dir()
                    )
                    enqueue_mock.assert_called_once_with("song-a")
            finally:
                manager.shutdown()

    def test_retry_item_keeps_cache_dir_while_item_is_in_flight(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                item_dir = self.cache_dir / "song-a" / "video-p1"
                item_dir.mkdir(parents=True, exist_ok=True)
                (item_dir / "video.mp4").write_bytes(b"media")
                self.project_cache_started("song-a", message="downloading")
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                    manager.pending_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock, patch.object(
                    manager, "_terminate_process"
                ) as terminate_mock:
                    manager.retry_item("song-a")
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "queued")
                    self.assertTrue((self.cache_dir / "song-a").exists())
                    self.assertIn("song-a", manager.retry_requested_ids)
                    enqueue_mock.assert_not_called()
                    terminate_mock.assert_not_called()
            finally:
                manager.shutdown()

    def test_force_retry_current_item_uses_urgent_lane_without_preempting_active_cache(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                target = self.make_item("song-a")
                active = self.make_item("song-b")
                self.store.add_item(target, requester_name="cache-test-user")
                self.store.add_item(active, requester_name="cache-test-user")
                self.project_cache_failed("song-a", message="缓存失败")
                fake_process = SimpleNamespace(poll=lambda: 0)
                with manager.lock:
                    manager.desired_ids = {"song-a", "song-b"}
                    manager.ordered_desired_ids = ["song-a", "song-b"]
                    manager.active_item_id = "song-b"
                    manager.active_process = fake_process
                with patch.object(manager, "_start_urgent_cache") as urgent_cache_mock, patch.object(
                    manager, "_terminate_process"
                ) as terminate_mock:
                    manager.retry_item("song-a", force=True)
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "queued")
                    self.assertEqual(retried.cache_message, "准备重新下载")
                    self.assertNotIn("song-b", manager.cache_interrupted_messages)
                    urgent_cache_mock.assert_called_once_with("song-a")
                    terminate_mock.assert_not_called()
                    self.assertEqual(manager.active_item_id, "song-b")
            finally:
                manager.shutdown()

    def test_urgent_current_retry_runs_concurrently_with_normal_cache_worker(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            target = self.make_item("song-a")
            active = self.make_item("song-b")
            self.store.add_item(target, requester_name="cache-test-user")
            self.store.add_item(active, requester_name="cache-test-user")
            self.project_cache_failed("song-a", message="缓存失败")
            urgent_started = threading.Event()
            release_urgent = threading.Event()

            def fake_cache_item(
                item_id, _cache_attempt_token, allow_refresh_retry=True
            ):
                self.assertEqual(item_id, "song-a")
                urgent_started.set()
                self.assertTrue(release_urgent.wait(2))
                return False

            fake_process = SimpleNamespace(
                poll=lambda: None,
                terminate=lambda: None,
                wait=lambda timeout=None: None,
                kill=lambda: None,
            )
            try:
                with manager.lock:
                    manager.desired_ids = {"song-a", "song-b"}
                    manager.ordered_desired_ids = ["song-a", "song-b"]
                    manager.pending_ids = {"song-b"}
                    manager.active_item_id = "song-b"
                    manager.active_process = fake_process
                with patch.object(manager, "_cache_item", side_effect=fake_cache_item), patch.object(
                    manager, "_terminate_process"
                ) as terminate_mock:
                    manager.retry_item("song-a", force=True)
                    self.assertTrue(urgent_started.wait(2))
                    with manager.lock:
                        self.assertEqual(manager.active_item_id, "song-b")
                        self.assertIn("song-a", manager.urgent_cache_ids)
                        self.assertIn("song-b", manager.pending_ids)
                    terminate_mock.assert_not_called()
                    release_urgent.set()
                    worker = manager.urgent_workers.get("song-a")
                    self.assertIsNotNone(worker)
                    worker.join(timeout=2)
                    self.assertFalse(worker.is_alive())
                    with manager.lock:
                        self.assertNotIn("song-a", manager.urgent_cache_ids)
                        self.assertEqual(manager.active_item_id, "song-b")
            finally:
                release_urgent.set()
                manager.shutdown()

    def test_normal_cache_priority_remains_single_lane(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-b"), requester_name="cache-test-user")
                fake_process = SimpleNamespace(
                    poll=lambda: None,
                    terminate=lambda: None,
                    wait=lambda timeout=None: None,
                    kill=lambda: None,
                )
                with manager.lock:
                    manager.desired_ids = {"song-a", "song-b"}
                    manager.pending_ids = {"song-a", "song-b"}
                    manager.active_item_id = "song-b"
                    manager.active_process = fake_process

                with patch.object(manager, "_start_urgent_cache") as urgent_cache_mock, patch.object(
                    manager, "_terminate_process"
                ) as terminate_mock:
                    manager._prioritize_cache_window(
                        self.store.list_items(),
                        {"song-a", "song-b"},
                    )

                urgent_cache_mock.assert_not_called()
                terminate_mock.assert_called_once_with(fake_process)
                self.assertNotIn("song-a", manager.urgent_cache_ids)
            finally:
                manager.shutdown()

    def test_active_process_registry_isolates_concurrent_items(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            process_a = Mock()
            process_b = Mock()
            try:
                manager._register_active_process("song-a", process_a)
                manager._register_active_process("song-b", process_b)
                with manager.lock:
                    self.assertEqual(manager._active_processes_locked("song-a"), [process_a])
                    self.assertEqual(manager._active_processes_locked("song-b"), [process_b])
                    self.assertCountEqual(
                        manager._active_processes_locked(),
                        [process_a, process_b],
                    )
                manager._unregister_active_process(process_a)
                manager._unregister_active_process(process_b)
            finally:
                manager.shutdown()

    def test_prioritize_cache_window_reorders_pending_queue_by_play_order(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-b"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-c"), requester_name="cache-test-user")
                with manager.lock:
                    manager.desired_ids = {"song-a", "song-b", "song-c"}
                    manager.pending_ids = {"song-a", "song-b", "song-c"}
                    for item_id in ["song-c", "song-b", "song-a"]:
                        manager.tasks.put(item_id)

                manager._prioritize_cache_window(
                    self.store.list_items(),
                    {"song-a", "song-b", "song-c"},
                )

                queued_ids = []
                while True:
                    try:
                        queued_ids.append(manager.tasks.get_nowait())
                    except queue.Empty:
                        break
                self.assertEqual(queued_ids, ["song-a", "song-b", "song-c"])
            finally:
                manager.shutdown()

    def test_prioritize_cache_window_preempts_lower_priority_active_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                self.store.add_item(self.make_item("song-a"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-b"), requester_name="cache-test-user")
                self.store.add_item(self.make_item("song-c"), requester_name="cache-test-user")
                fake_process = SimpleNamespace(
                    poll=lambda: None,
                    terminate=lambda: None,
                    wait=lambda timeout=None: None,
                    kill=lambda: None,
                )
                with manager.lock:
                    manager.desired_ids = {"song-a", "song-b", "song-c"}
                    manager.pending_ids = {"song-a", "song-b", "song-c"}
                    manager.active_item_id = "song-b"
                    manager.active_process = fake_process

                with patch.object(manager, "_terminate_process") as terminate_mock:
                    manager._prioritize_cache_window(
                        self.store.list_items(),
                        {"song-a", "song-b", "song-c"},
                    )

                self.assertEqual(
                    manager.cache_interrupted_messages["song-b"],
                    "等待优先缓存: title-song-a - P1",
                )
                terminate_mock.assert_called_once_with(fake_process)
                self.assertIn("song-b", manager.requeued_active_ids)
                queued_ids = []
                while True:
                    try:
                        queued_ids.append(manager.tasks.get_nowait())
                    except queue.Empty:
                        break
                self.assertEqual(queued_ids, ["song-a", "song-b", "song-c"])
            finally:
                manager.shutdown()

    def test_apply_priority_ignores_plan_when_active_item_changes(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            process_a = Mock()
            process_b = Mock()
            try:
                items = [self.make_item("song-first"), self.make_item("song-a")]
                plan = CachePlan(
                    desired_ids=("song-first", "song-a"),
                    pending_order=("song-first", "song-a"),
                    retained_ids=("song-first", "song-a"),
                    preempt_ids=("song-a",),
                )
                with manager.lock:
                    manager.desired_ids = {"song-first", "song-a"}
                    manager.pending_ids = {"song-first", "song-a"}
                    manager.active_item_id = "song-b"
                    manager.active_processes = {process_a, process_b}
                    manager.active_process_item_ids = {
                        process_a: "song-a",
                        process_b: "song-b",
                    }
                    manager.tasks.put("song-first")
                    manager.tasks.put("song-a")

                with patch.object(manager, "_terminate_processes") as terminate_mock:
                    manager._apply_cache_plan_priority(items, plan)

                terminate_mock.assert_not_called()
                self.assertNotIn("song-a", manager.cache_interrupted_messages)
                self.assertNotIn("song-a", manager.requeued_active_ids)
                self.assertEqual(manager.active_item_id, "song-b")
            finally:
                manager.shutdown()

    def test_apply_priority_ignores_plan_when_active_item_finishes(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            process_a = Mock()
            try:
                items = [self.make_item("song-first"), self.make_item("song-a")]
                plan = CachePlan(
                    desired_ids=("song-first", "song-a"),
                    pending_order=("song-first", "song-a"),
                    retained_ids=("song-first", "song-a"),
                    preempt_ids=("song-a",),
                )
                with manager.lock:
                    manager.desired_ids = {"song-first", "song-a"}
                    manager.pending_ids = {"song-first", "song-a"}
                    manager.active_item_id = None
                    manager.active_processes = {process_a}
                    manager.active_process_item_ids = {process_a: "song-a"}
                    manager.tasks.put("song-first")
                    manager.tasks.put("song-a")

                with patch.object(manager, "_terminate_processes") as terminate_mock:
                    manager._apply_cache_plan_priority(items, plan)

                terminate_mock.assert_not_called()
                self.assertNotIn("song-a", manager.cache_interrupted_messages)
                self.assertNotIn("song-a", manager.requeued_active_ids)
            finally:
                manager.shutdown()

    def test_apply_priority_ignores_plan_when_next_item_becomes_urgent(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager,
            "_worker_loop",
            lambda self: None,
        ):
            manager = CacheManager(self.store, max_cache_items=2)
            process_a = Mock()
            try:
                items = [self.make_item("song-first"), self.make_item("song-a")]
                plan = CachePlan(
                    desired_ids=("song-first", "song-a"),
                    pending_order=("song-first", "song-a"),
                    retained_ids=("song-first", "song-a"),
                    preempt_ids=("song-a",),
                )
                with manager.lock:
                    manager.desired_ids = {"song-first", "song-a"}
                    manager.pending_ids = {"song-first", "song-a"}
                    manager.active_item_id = "song-a"
                    manager.urgent_cache_ids.add("song-first")
                    manager.active_processes = {process_a}
                    manager.active_process_item_ids = {process_a: "song-a"}
                    manager.tasks.put("song-first")
                    manager.tasks.put("song-a")

                with patch.object(manager, "_terminate_processes") as terminate_mock:
                    manager._apply_cache_plan_priority(items, plan)

                terminate_mock.assert_not_called()
                self.assertNotIn("song-a", manager.cache_interrupted_messages)
                self.assertNotIn("song-a", manager.requeued_active_ids)
            finally:
                manager.shutdown()

    def test_cache_item_preserves_committed_dir_before_processing_pending_retry(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                item_dir = self.cache_dir / "song-a" / "video-p1"
                item_dir.mkdir(parents=True, exist_ok=True)
                (item_dir / "video.mp4").write_bytes(b"media")
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                    manager.retry_requested_ids.add("song-a")
                old_token = begin_cache_attempt(self.store, "song-a")
                manager.python_cache_attempt_tokens["song-a"] = old_token
                with patch.object(manager, "_cache_item_multi") as cache_item_multi_mock:
                    manager._cache_item(
                        "song-a",
                        old_token,
                    )
                    self.assertTrue((self.cache_dir / "song-a").exists())
                    cache_item_multi_mock.assert_called_once()
                    fresh_token = cache_item_multi_mock.call_args.kwargs[
                        "cache_attempt_token"
                    ]
                    self.assertGreater(fresh_token, old_token)
                    self.assertEqual(
                        manager.python_cache_attempt_tokens["song-a"],
                        fresh_token,
                    )
            finally:
                manager.shutdown()

    def test_validate_media_file_logs_ffprobe_success(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        media_file = self.cache_dir / "song-a" / "video.mp4"
        media_file.parent.mkdir(parents=True, exist_ok=True)
        media_file.write_bytes(b"media")
        probe_payload = {
            "streams": [{"codec_type": "video", "duration": "12.34"}],
            "format": {"duration": "12.34"},
        }

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = manager._item_log_path("song-a")
                with patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(probe_payload),
                        stderr="",
                    ),
                ) as run_mock:
                    manager._validate_media_file(
                        Path("/tools/ffprobe"),
                        Path("/tools/ffmpeg"),
                        media_file,
                        label="视频轨 P1",
                        required_streams={"video"},
                        log_path=log_path,
                    )
                log_text = log_path.read_text(encoding="utf-8")
            finally:
                manager.shutdown()

        self.assertTrue(run_mock.called)
        self.assertIn("ffprobe validate 视频轨 P1: ok", log_text)
        self.assertIn("duration=12.34s", log_text)

    def test_validate_media_file_rejects_missing_required_stream(self):
        media_file = self.cache_dir / "song-a" / "audio.m4a"
        media_file.parent.mkdir(parents=True, exist_ok=True)
        media_file.write_bytes(b"media")
        probe_payload = {
            "streams": [{"codec_type": "video", "duration": "12.34"}],
            "format": {"duration": "12.34"},
        }

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = manager._item_log_path("song-a")
                with patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(probe_payload),
                        stderr="",
                    ),
                ):
                    with self.assertRaisesRegex(DownloadCommandError, "缺少 audio 流"):
                        manager._validate_media_file(
                            Path("/tools/ffprobe"),
                            Path("/tools/ffmpeg"),
                            media_file,
                            label="音轨 P1",
                            required_streams={"audio"},
                            log_path=log_path,
                        )
            finally:
                manager.shutdown()

    def test_validate_cache_result_rejects_probe_failure(self):
        log_dir = Path(self.temp_dir.name) / "logs"
        media_file = self.cache_dir / "song-a" / "audio.m4a"
        media_file.parent.mkdir(parents=True, exist_ok=True)
        media_file.write_bytes(b"media")
        probe_payload = {
            "streams": [{"codec_type": "video", "duration": "12.34"}],
            "format": {"duration": "12.34"},
        }

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = manager._item_log_path("song-a")
                with patch.object(manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")), patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(probe_payload),
                        stderr="",
                    ),
                ):
                    with self.assertRaisesRegex(DownloadCommandError, "音轨 P1"):
                        manager._validate_cache_result(
                            "song-a",
                            {
                                "validation_files": [
                                    {
                                        "path": media_file,
                                        "label": "音轨 P1",
                                        "required_streams": {"audio"},
                                    }
                                ]
                            },
                            Path("/tools/ffmpeg"),
                            log_path,
                            cache_attempt_token=1,
                        )
                log_text = log_path.read_text(encoding="utf-8")
            finally:
                manager.shutdown()

        self.assertIn("ffprobe validate 音轨 P1: failed", log_text)
        self.assertIn("cache validation error", log_text)
        self.assertFalse(media_file.exists())

    def test_ffprobe_path_for_ffmpeg_skips_broken_runtime_probe(self):
        suffix = ".exe" if os.name == "nt" else ""
        tools_dir = Path(self.temp_dir.name) / "runtime" / "tools" / "bbdown"
        ffmpeg_path = tools_dir / f"ffmpeg{suffix}"
        ffprobe_path = tools_dir / f"ffprobe{suffix}"
        tools_dir.mkdir(parents=True, exist_ok=True)
        ffmpeg_path.write_bytes(b"ffmpeg-bin")
        ffprobe_path.write_bytes(b"broken-shim")

        with patch("bilikara.cache.FFPROBE_RUNTIME_PATH", ffprobe_path), patch(
            "bilikara.cache.shutil.which",
            return_value=None,
        ), patch(
            "bilikara.cache.subprocess.run",
            return_value=SimpleNamespace(
                returncode=1,
                stdout="",
                stderr="Cannot find file at '..\\lib\\ffmpeg\\tools\\ffmpeg\\bin\\ffprobe.exe'",
            ),
        ) as run_mock:
            resolved = CacheManager._ffprobe_path_for_ffmpeg(ffmpeg_path)

        self.assertIsNone(resolved)
        run_mock.assert_called_once()

    def test_ffprobe_path_for_ffmpeg_falls_back_to_sibling_probe(self):
        suffix = ".exe" if os.name == "nt" else ""
        runtime_dir = Path(self.temp_dir.name) / "runtime" / "tools" / "bbdown"
        sibling_dir = Path(self.temp_dir.name) / "external" / "ffmpeg"
        runtime_probe = runtime_dir / f"ffprobe{suffix}"
        ffmpeg_path = sibling_dir / f"ffmpeg{suffix}"
        sibling_probe = sibling_dir / f"ffprobe{suffix}"
        runtime_dir.mkdir(parents=True, exist_ok=True)
        sibling_dir.mkdir(parents=True, exist_ok=True)
        runtime_probe.write_bytes(b"broken-shim")
        ffmpeg_path.write_bytes(b"ffmpeg-bin")
        sibling_probe.write_bytes(b"ffprobe-bin")

        with patch("bilikara.cache.FFPROBE_RUNTIME_PATH", runtime_probe), patch(
            "bilikara.cache.shutil.which",
            return_value=None,
        ), patch(
            "bilikara.cache.subprocess.run",
            side_effect=[
                SimpleNamespace(returncode=1, stdout="", stderr="Cannot find file"),
                SimpleNamespace(returncode=0, stdout="ffprobe version 7.1", stderr=""),
            ],
        ) as run_mock:
            resolved = CacheManager._ffprobe_path_for_ffmpeg(ffmpeg_path)

        self.assertEqual(resolved, sibling_probe)
        self.assertEqual(run_mock.call_count, 2)

    def test_ensure_bbdown_existing_binary_skips_release_request(self):
        suffix = ".exe" if os.name == "nt" else ""
        local_binary = Path(self.temp_dir.name) / "tools" / "bbdown" / f"BBDown{suffix}"
        local_binary.parent.mkdir(parents=True, exist_ok=True)
        local_binary.write_bytes(b"bbdown-bin")
        version_file = Path(self.temp_dir.name) / "tools" / "bbdown" / "VERSION"
        version_file.write_text("1.6.3", encoding="utf-8")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch("bilikara.cache.TOOL_ASSET_BASE_URL", ""):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager, "_fetch_latest_release"
                ) as fetch_release, patch.object(
                    manager, "_download_tool_asset"
                ) as download_asset:
                    path = manager._ensure_bbdown()
            finally:
                manager.shutdown()

        self.assertEqual(path, local_binary)
        fetch_release.assert_not_called()
        download_asset.assert_not_called()
        self.assertTrue(local_binary.stat().st_mode & stat.S_IEXEC)
        self.assertEqual(manager.binary_state, "ready")
        self.assertEqual(manager.binary_version, "1.6.3")
        self.assertIn("未检查更新", manager.binary_message)

    def test_ensure_bbdown_existing_binary_reads_binary_version_without_metadata(self):
        suffix = ".exe" if os.name == "nt" else ""
        local_binary = Path(self.temp_dir.name) / "tools" / "bbdown" / f"BBDown{suffix}"
        local_binary.parent.mkdir(parents=True, exist_ok=True)
        local_binary.write_bytes(b"bbdown-bin")
        version_file = Path(self.temp_dir.name) / "tools" / "bbdown" / "VERSION"

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager, "_read_bbdown_version", return_value="1.6.3"
                ) as read_version, patch.object(
                    manager, "_fetch_latest_release"
                ) as fetch_release:
                    path = manager._ensure_bbdown()
            finally:
                manager.shutdown()

        self.assertEqual(path, local_binary)
        read_version.assert_called_once_with(local_binary)
        fetch_release.assert_not_called()
        self.assertEqual(manager.binary_state, "ready")
        self.assertEqual(manager.binary_version, "1.6.3")

    def test_bbdown_version_probe_uses_supported_help_command_and_requires_success(self):
        suffix = ".exe" if os.name == "nt" else ""
        binary = Path(self.temp_dir.name) / f"BBDown{suffix}"
        binary.write_bytes(b"bbdown-bin")
        with patch(
            "bilikara.cache.subprocess.run",
            return_value=SimpleNamespace(
                returncode=0,
                stdout="BBDown version 1.6.3, Bilibili Downloader.\n",
                stderr="",
            ),
        ) as run_mock:
            self.assertEqual(CacheManager._read_bbdown_version(binary), "1.6.3")
        self.assertEqual(run_mock.call_args.args[0], [str(binary), "--help"])

        with patch(
            "bilikara.cache.subprocess.run",
            return_value=SimpleNamespace(
                returncode=1,
                stdout="BBDown version 1.6.3, Bilibili Downloader.\n",
                stderr="probe failed",
            ),
        ):
            self.assertEqual(CacheManager._read_bbdown_version(binary), "")

    def test_ensure_bbdown_existing_override_keeps_override_precedence(self):
        suffix = ".exe" if os.name == "nt" else ""
        override = Path(self.temp_dir.name) / "external" / f"BBDown{suffix}"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_bytes(b"external-bbdown")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(override)
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(
                    manager,
                    "_fetch_latest_release",
                ) as fetch_release, patch.object(
                    manager,
                    "_download_tool_asset",
                ) as download_asset:
                    path = manager._ensure_bbdown(force_refresh=True)
            finally:
                manager.shutdown()

        self.assertEqual(path, override)
        fetch_release.assert_not_called()
        download_asset.assert_not_called()
        self.assertEqual(manager.binary_state, "ready")
        self.assertIn("外部 BBDown", manager.binary_message)

    def test_packaged_bbdown_valid_runtime_never_uses_network(self):
        bbdown_dir = Path(self.temp_dir.name) / "packaged" / "tools" / "bbdown"
        runtime = bbdown_dir / ("BBDown.exe" if os.name == "nt" else "BBDown")
        runtime.parent.mkdir(parents=True)
        runtime.write_bytes(b"valid-runtime")
        version_file = bbdown_dir / "VERSION"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.PACKAGED_RUNTIME", True
        ), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", ""):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=runtime), patch.object(
                    manager, "_read_bbdown_version", return_value="1.6.3"
                ), patch.object(manager, "_fetch_latest_release") as fetch_release, patch.object(
                    manager, "_download_tool_asset"
                ) as download_asset:
                    resolved = manager._ensure_bbdown()
            finally:
                manager.shutdown()

        self.assertEqual(resolved, runtime)
        self.assertEqual(runtime.read_bytes(), b"valid-runtime")
        self.assertEqual(version_file.read_text(encoding="utf-8"), "1.6.3")
        fetch_release.assert_not_called()
        download_asset.assert_not_called()

    def test_packaged_bbdown_missing_or_corrupt_runtime_restores_vendor_atomically(self):
        for initial_runtime in (None, b"corrupt-runtime"):
            with self.subTest(initial_runtime=initial_runtime):
                root = Path(self.temp_dir.name) / f"restore-{initial_runtime is not None}"
                bbdown_dir = root / "tools" / "bbdown"
                runtime = bbdown_dir / ("BBDown.exe" if os.name == "nt" else "BBDown")
                vendor = root / "vendor" / runtime.name
                vendor.parent.mkdir(parents=True)
                vendor.write_bytes(b"pinned-vendor")
                if initial_runtime is not None:
                    runtime.parent.mkdir(parents=True)
                    runtime.write_bytes(initial_runtime)
                version_file = bbdown_dir / "VERSION"

                def fake_version(path: Path) -> str:
                    return "1.6.3" if path.read_bytes() == b"pinned-vendor" else ""

                with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
                    "bilikara.cache.PACKAGED_RUNTIME", True
                ), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir), patch(
                    "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
                ), patch("bilikara.cache.BB_DOWN_BUNDLED_PATH", vendor), patch(
                    "bilikara.cache.BB_DOWN_PATH_OVERRIDE", ""
                ):
                    manager = CacheManager(self.store, max_cache_items=3)
                    try:
                        with patch.object(manager, "_local_binary_path", return_value=runtime), patch.object(
                            manager, "_read_bbdown_version", side_effect=fake_version
                        ), patch.object(manager, "_fetch_latest_release") as fetch_release, patch.object(
                            manager, "_download_tool_asset"
                        ) as download_asset:
                            resolved = manager._ensure_bbdown()
                    finally:
                        manager.shutdown()

                self.assertEqual(resolved, runtime)
                self.assertEqual(runtime.read_bytes(), b"pinned-vendor")
                self.assertEqual(version_file.read_text(encoding="utf-8"), "1.6.3")
                self.assertEqual(list(bbdown_dir.glob(".BBDown.install-*")), [])
                fetch_release.assert_not_called()
                download_asset.assert_not_called()

    def test_packaged_bbdown_force_refresh_restores_vendor_and_override_still_wins(self):
        root = Path(self.temp_dir.name) / "force-restore"
        bbdown_dir = root / "tools" / "bbdown"
        runtime = bbdown_dir / ("BBDown.exe" if os.name == "nt" else "BBDown")
        vendor = root / "vendor" / runtime.name
        override = root / "override" / runtime.name
        runtime.parent.mkdir(parents=True)
        vendor.parent.mkdir(parents=True)
        override.parent.mkdir(parents=True)
        runtime.write_bytes(b"old-valid-runtime")
        vendor.write_bytes(b"pinned-vendor")
        override.write_bytes(b"override")
        version_file = bbdown_dir / "VERSION"

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.PACKAGED_RUNTIME", True
        ), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch("bilikara.cache.BB_DOWN_BUNDLED_PATH", vendor), patch(
            "bilikara.cache.BB_DOWN_PATH_OVERRIDE", ""
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=runtime), patch.object(
                    manager, "_read_bbdown_version", return_value="1.6.3"
                ):
                    self.assertEqual(manager._ensure_bbdown(force_refresh=True), runtime)
            finally:
                manager.shutdown()
        self.assertEqual(runtime.read_bytes(), b"pinned-vendor")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.PACKAGED_RUNTIME", True
        ), patch("bilikara.cache.BB_DOWN_PATH_OVERRIDE", str(override)):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_bundled_bbdown_path") as bundled, patch.object(
                    manager, "_fetch_latest_release"
                ) as fetch_release:
                    self.assertEqual(manager._ensure_bbdown(force_refresh=True), override)
            finally:
                manager.shutdown()
        bundled.assert_not_called()
        fetch_release.assert_not_called()

    def test_ensure_bbdown_raises_when_release_check_fails_and_no_local_binary(self):
        suffix = ".exe" if os.name == "nt" else ""
        local_binary = Path(self.temp_dir.name) / "tools" / "bbdown" / f"BBDown{suffix}"
        version_file = Path(self.temp_dir.name) / "tools" / "bbdown" / "VERSION"

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch("bilikara.cache.TOOL_ASSET_BASE_URL", ""):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager, "_fetch_latest_release", side_effect=RuntimeError("offline")
                ):
                    with self.assertRaisesRegex(RuntimeError, "无法检查 BBDown 最新版本"):
                        manager._ensure_bbdown()
            finally:
                manager.shutdown()

    def test_tool_asset_download_retries_bucket_fallback(self):
        target_path = Path(self.temp_dir.name) / "yt-dlp.exe"
        calls: list[str] = []

        def fake_download(url: str, path: Path) -> None:
            calls.append(url)
            if len(calls) == 1:
                raise RuntimeError("github offline")
            path.write_bytes(b"tool-bin")

        manager = CacheManager(self.store, max_cache_items=3)
        try:
            with patch("bilikara.cache.TOOL_ASSET_BASE_URL", "https://download.example/bilikara/tools"), patch.object(
                manager,
                "_download_url",
                side_effect=fake_download,
            ):
                manager._download_tool_asset(
                    {
                        "name": "yt-dlp.exe",
                        "browser_download_url": "https://github.example/yt-dlp.exe",
                    },
                    target_path,
                    tool="ytdlp",
                )
        finally:
            manager.shutdown()

        self.assertEqual(
            calls,
            [
                "https://github.example/yt-dlp.exe",
                "https://download.example/bilikara/tools/yt-dlp.exe",
            ],
        )
        self.assertEqual(target_path.read_bytes(), b"tool-bin")

    def test_bbdown_uses_bucket_fallback_when_release_check_fails(self):
        suffix = ".exe" if os.name == "nt" else ""
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        local_binary = bbdown_dir / f"BBDown{suffix}"
        version_file = bbdown_dir / "VERSION"
        calls: list[str] = []

        def fake_download(url: str, path: Path) -> None:
            calls.append(url)
            path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(path, "w") as zf:
                zf.writestr(f"BBDown{suffix}", b"bbdown-bin")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_DIR",
            bbdown_dir,
        ), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE",
            version_file,
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL",
            "https://download.example/bilikara/tools",
        ), patch(
            "bilikara.cache.platform.system",
            return_value="Windows",
        ), patch(
            "bilikara.cache.platform.machine",
            return_value="AMD64",
        ), patch.object(CacheManager, "_system_aria2c_path", return_value=None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager,
                    "_fetch_latest_release",
                    side_effect=RuntimeError("offline"),
                ) as fetch_release, patch.object(manager, "_download_url", side_effect=fake_download):
                    path = manager._ensure_bbdown()
            finally:
                manager.shutdown()

        self.assertEqual(path, local_binary)
        fetch_release.assert_called_once_with()
        self.assertEqual(calls, ["https://download.example/bilikara/tools/BBDown_1.6.3_20240814_win-x64.zip"])
        self.assertEqual(local_binary.read_bytes(), b"bbdown-bin")
        self.assertEqual(version_file.read_text(encoding="utf-8"), "r2-fallback")

    def test_select_asset_uses_windows_arm64_package(self):
        release = {
            "assets": [
                {
                    "name": "BBDown_1.6.3_20240814_win-x64.zip",
                    "browser_download_url": "https://example.test/win-x64.zip",
                },
                {
                    "name": "BBDown_1.6.3_20240814_win-arm64.zip",
                    "browser_download_url": "https://example.test/win-arm64.zip",
                },
            ],
        }

        with patch("bilikara.cache.platform.system", return_value="Windows"), patch(
            "bilikara.cache.platform.machine",
            return_value="ARM64",
        ):
            selected = CacheManager._select_asset(object(), release)

        self.assertEqual(selected["name"], "BBDown_1.6.3_20240814_win-arm64.zip")

    def test_select_asset_uses_macos_arm64_package(self):
        release = {
            "assets": [
                {
                    "name": "BBDown_1.6.3_20240814_osx-x64.zip",
                    "browser_download_url": "https://example.test/osx-x64.zip",
                },
                {
                    "name": "BBDown_1.6.3_20240814_osx-arm64.zip",
                    "browser_download_url": "https://example.test/osx-arm64.zip",
                },
            ],
        }

        with patch("bilikara.cache.platform.system", return_value="Darwin"), patch(
            "bilikara.cache.platform.machine",
            return_value="arm64",
        ):
            selected = CacheManager._select_asset(object(), release)

        self.assertEqual(selected["name"], "BBDown_1.6.3_20240814_osx-arm64.zip")

    def test_select_ytdlp_asset_prefers_windows_arm64_binary(self):
        release = {
            "assets": [
                {
                    "name": "yt-dlp.exe",
                    "browser_download_url": "https://example.test/yt-dlp.exe",
                },
                {
                    "name": "yt-dlp_arm64.exe",
                    "browser_download_url": "https://example.test/yt-dlp_arm64.exe",
                },
            ],
        }

        with patch("bilikara.cache.platform.system", return_value="Windows"), patch(
            "bilikara.cache.platform.machine",
            return_value="ARM64",
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                selected = manager._select_ytdlp_asset(release)
            finally:
                manager.shutdown()

        self.assertEqual(selected["name"], "yt-dlp_arm64.exe")

    def test_ensure_ytdlp_downloads_release_asset_when_missing(self):
        ytdlp_dir = Path(self.temp_dir.name) / "tools" / "ytdlp"
        target_path = ytdlp_dir / ("yt-dlp.exe" if os.name == "nt" else "yt-dlp")
        release = {
            "assets": [
                {
                    "name": "yt-dlp.exe",
                    "browser_download_url": "https://example.test/yt-dlp",
                },
                {
                    "name": "yt-dlp_macos",
                    "browser_download_url": "https://example.test/yt-dlp",
                },
                {
                    "name": "yt-dlp_linux",
                    "browser_download_url": "https://example.test/yt-dlp",
                },
                {
                    "name": "yt-dlp",
                    "browser_download_url": "https://example.test/yt-dlp",
                }
            ],
        }

        def fake_download(url: str, path: Path) -> None:
            self.assertEqual(url, "https://example.test/yt-dlp")
            path.write_bytes(b"yt-dlp-bin")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.YTDLP_DIR", ytdlp_dir
        ), patch("bilikara.cache.YTDLP_PATH_OVERRIDE", ""):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_ytdlp_binary_path", return_value=target_path), patch.object(
                    manager, "_fetch_ytdlp_release", return_value=release
                ), patch.object(manager, "_download_url", side_effect=fake_download), patch.object(
                    manager,
                    "_read_ytdlp_version",
                    return_value="2026.06.15",
                ):
                    path = manager._ensure_ytdlp()
            finally:
                manager.shutdown()

        self.assertEqual(path, target_path)
        self.assertEqual(target_path.read_bytes(), b"yt-dlp-bin")
        self.assertEqual(manager.binary_version, "2026.06.15")

    def test_ensure_aria2c_downloads_and_extracts_zip_when_missing(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        target_path = aria2_dir / "aria2c.exe"
        release = {
            "assets": [
                {
                    "name": "aria2-1.37.0-win-64bit-build1.zip",
                    "browser_download_url": "https://example.test/aria2.zip",
                }
            ],
        }

        def fake_download(url: str, path: Path) -> None:
            self.assertEqual(url, "https://example.test/aria2.zip")
            path.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(path, "w") as zf:
                zf.writestr("aria2-1.37.0-win-64bit-build1/aria2c.exe", b"aria2c-bin")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch.object(
            CacheManager, "_system_aria2c_path", return_value=None
        ), patch(
            "bilikara.cache.platform.system",
            return_value="Windows",
        ), patch(
            "bilikara.cache.platform.machine",
            return_value="AMD64",
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_aria2c_binary_path", return_value=target_path), patch.object(
                    manager, "_fetch_aria2_release", return_value=release
                ), patch.object(manager, "_download_url", side_effect=fake_download), patch.object(
                    manager,
                    "_read_aria2c_version",
                    return_value="1.37.0",
                ):
                    path = manager._ensure_aria2c()
            finally:
                manager.shutdown()

        self.assertEqual(path, target_path)
        self.assertEqual(target_path.read_bytes(), b"aria2c-bin")
        self.assertEqual(manager.binary_version, "1.37.0")
        self.assertFalse((aria2_dir / "aria2-1.37.0-win-64bit-build1.zip").exists())


    def test_ensure_aria2c_resolves_system_path_when_available(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_PATH_OVERRIDE", ""
        ), patch(
            "bilikara.cache.shutil.which", return_value="/usr/bin/aria2c"
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(
                    manager,
                    "_read_aria2c_version",
                    return_value="1.37.0",
                ) as mock_read_version:
                    path = manager._ensure_aria2c()
                    mock_read_version.assert_called_once_with(Path("/usr/bin/aria2c"))
            finally:
                manager.shutdown()

        self.assertEqual(path, Path("/usr/bin/aria2c"))
        self.assertEqual(manager.binary_version, "1.37.0")
        self.assertIn("使用系统 aria2c", manager.binary_message)

    def test_ensure_aria2c_downloads_via_apt_on_linux(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        target_path = aria2_dir / "aria2c"

        def fake_which(cmd):
            if cmd in ("apt-get", "dpkg-deb"):
                return f"/usr/bin/{cmd}"
            return None

        import subprocess
        def fake_run(args, **kwargs):
            if args[0] == "apt-get" and args[1] == "download":
                cwd = kwargs.get("cwd")
                if cwd:
                    Path(cwd).mkdir(parents=True, exist_ok=True)
                    (Path(cwd) / "aria2_1.36.0-1_amd64.deb").write_bytes(b"fake-deb")
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            if args[0] == "dpkg-deb" and args[1] == "-x":
                extract_dir = Path(args[3])
                binary_dir = extract_dir / "usr" / "bin"
                binary_dir.mkdir(parents=True, exist_ok=True)
                (binary_dir / "aria2c").write_bytes(b"fake-aria2c-bin")
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", side_effect=fake_which
        ), patch(
            "bilikara.cache.platform.system",
            return_value="Linux",
        ), patch(
            "bilikara.cache.platform.machine",
            return_value="x86_64",
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch("subprocess.run", side_effect=fake_run), patch.object(
                    manager, "_system_aria2c_path", return_value=None
                ), patch.object(
                    manager, "_local_aria2c_binary_path", return_value=target_path
                ), patch.object(
                    manager, "_read_aria2c_version", return_value="1.37.0"
                ):
                    path = manager._ensure_aria2c()
            finally:
                manager.shutdown()

        self.assertEqual(path, target_path)
        self.assertEqual(target_path.read_bytes(), b"fake-aria2c-bin")

    def test_ensure_aria2c_downloads_via_brew_on_macos(self):
        aria2_dir = Path(self.temp_dir.name) / "tools" / "aria2c"
        target_path = aria2_dir / "aria2c"

        def fake_which(cmd):
            if cmd == "brew":
                return "/usr/local/bin/brew"
            return None

        import subprocess
        fake_cache_dir = Path(self.temp_dir.name) / "brew_cache"
        fake_cache_dir.mkdir(parents=True, exist_ok=True)
        fake_bottle_file = fake_cache_dir / "aria2-1.37.0.bottle.tar.gz"

        def fake_run(args, **kwargs):
            if "fetch" in args:
                fake_bottle_file.write_bytes(b"fake-bottle-tar-gz")
                return subprocess.CompletedProcess(args, 0, stdout="Fetched", stderr="")
            if "--cache" in args:
                return subprocess.CompletedProcess(args, 0, stdout=str(fake_bottle_file), stderr="")
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.ARIA2C_DIR", aria2_dir
        ), patch("bilikara.cache.ARIA2C_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", side_effect=fake_which
        ), patch(
            "bilikara.cache.platform.system",
            return_value="Darwin",
        ), patch(
            "bilikara.cache.platform.machine",
            return_value="arm64",
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch("subprocess.run", side_effect=fake_run), patch.object(
                    manager, "_system_aria2c_path", return_value=None
                ), patch.object(
                    manager, "_local_aria2c_binary_path", return_value=target_path
                ), patch.object(
                    manager, "_fetch_aria2_release", return_value={"assets": []}
                ), patch.object(
                    manager, "_macos_aria2_asset", return_value=None
                ), patch.object(
                    manager, "_extract_tool_binary_from_archive",
                    side_effect=lambda archive, out_dir, bin_name: target_path.write_bytes(b"fake-brew-aria2c-bin")
                ), patch.object(
                    manager, "_read_aria2c_version", return_value="1.37.0"
                ):
                    path = manager._ensure_aria2c()
            finally:
                manager.shutdown()

        self.assertEqual(path, target_path)
        self.assertEqual(target_path.read_bytes(), b"fake-brew-aria2c-bin")
    def test_urlopen_retries_ssl_certificate_failure_with_certifi(self):
        certificate_error = urllib.error.URLError(
            ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED")
        )
        fallback_response = object()
        fake_certifi = SimpleNamespace(where=lambda: "certifi.pem")

        with patch.dict(sys.modules, {"certifi": fake_certifi}), patch(
            "bilikara.cache.ssl.create_default_context",
            return_value="ssl-context",
        ) as context_mock, patch(
            "bilikara.cache.urllib.request.urlopen",
            side_effect=[certificate_error, fallback_response],
        ) as urlopen_mock:
            response = CacheManager._urlopen("https://example.test", timeout=20)

        self.assertIs(response, fallback_response)
        context_mock.assert_called_once_with(cafile="certifi.pem")
        self.assertEqual(urlopen_mock.call_count, 2)
        self.assertEqual(urlopen_mock.call_args.kwargs["context"], "ssl-context")

    def test_ensure_ffmpeg_syncs_bundled_binary_into_runtime_tools(self):
        vendor_dir = Path(self.temp_dir.name) / "vendor"
        tools_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        suffix = ".exe" if os.name == "nt" else ""
        bundled_ffmpeg = vendor_dir / f"ffmpeg{suffix}"
        bundled_ffprobe = vendor_dir / f"ffprobe{suffix}"
        runtime_ffmpeg = tools_dir / f"ffmpeg{suffix}"
        runtime_ffprobe = tools_dir / f"ffprobe{suffix}"
        vendor_dir.mkdir(parents=True, exist_ok=True)
        bundled_ffmpeg.write_bytes(b"ffmpeg-bin")
        bundled_ffprobe.write_bytes(b"ffprobe-bin")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.VENDOR_DIR", vendor_dir
        ), patch("bilikara.cache.INTERNAL_VENDOR_DIR", Path(self.temp_dir.name) / "_internal" / "vendor"), patch(
            "bilikara.cache.FFMPEG_TOOLS_DIR", tools_dir
        ), patch("bilikara.cache.FFMPEG_RUNTIME_PATH", runtime_ffmpeg), patch(
            "bilikara.cache.FFPROBE_RUNTIME_PATH", runtime_ffprobe
        ), patch("bilikara.cache.FFMPEG_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", return_value=None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_read_ffmpeg_version", return_value="7.1"):
                    path = manager._ensure_ffmpeg(force_refresh=True)
            finally:
                manager.shutdown()

        self.assertEqual(path, runtime_ffmpeg)
        self.assertEqual(runtime_ffmpeg.read_bytes(), b"ffmpeg-bin")
        self.assertEqual(runtime_ffprobe.read_bytes(), b"ffprobe-bin")

    def test_bbdown_ffmpeg_arg_uses_binary_directory(self):
        suffix = ".exe" if os.name == "nt" else ""
        binary_path = Path(self.temp_dir.name) / "runtime" / "tools" / "ffmpeg" / f"ffmpeg{suffix}"
        binary_path.parent.mkdir(parents=True, exist_ok=True)
        binary_path.write_bytes(b"ffmpeg-bin")

        with patch.object(CacheManager, "_tool_arg_path", return_value="C:\\SHORT\\FFMPEG"):
            self.assertEqual(CacheManager._bbdown_ffmpeg_path_arg(binary_path), "C:\\SHORT\\FFMPEG")

    def test_tool_arg_path_prefers_windows_short_path(self):
        path = Path("C:/Users/Test User/AppData/Local/bilikara/runtime/tools/bbdown")

        with patch("bilikara.cache.os.name", "nt"), patch.object(
            CacheManager,
            "_windows_short_path",
            return_value="C:\\Users\\TESTUS~1\\AppData\\Local\\BILIKA~1\\runtime\\tools\\bbdown",
        ):
            self.assertEqual(
                CacheManager._tool_arg_path(path),
                "C:\\Users\\TESTUS~1\\AppData\\Local\\BILIKA~1\\runtime\\tools\\bbdown",
            )

    def test_tool_arg_path_falls_back_when_short_path_unavailable(self):
        path = Path("C:/Users/Test User/AppData/Local/bilikara/runtime/tools/bbdown")

        with patch("bilikara.cache.os.name", "nt"), patch.object(CacheManager, "_windows_short_path", return_value=""):
            self.assertEqual(CacheManager._tool_arg_path(path), str(path))

    def test_tool_process_env_prepends_ffmpeg_and_bbdown_dirs(self):
        suffix = ".exe" if os.name == "nt" else ""
        ffmpeg_path = Path(self.temp_dir.name) / "runtime" / "tools" / "bbdown" / f"ffmpeg{suffix}"
        ffmpeg_path.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg_path.write_bytes(b"ffmpeg-bin")

        with patch("bilikara.cache.BB_DOWN_DIR", ffmpeg_path.parent), patch.object(
            CacheManager,
            "_tool_arg_path",
            side_effect=lambda path: f"short-{Path(path).name}",
        ):
            env = CacheManager._tool_process_env(ffmpeg_path)

        first_path = env["PATH"].split(os.pathsep)[0]
        self.assertEqual(first_path, "short-bbdown")

    def test_download_selected_streams_skips_legacy_muxed_variant_outputs(self):
        item_dir = self.cache_dir / "song-a"
        item_dir.mkdir(parents=True, exist_ok=True)
        video_file = item_dir / "video-p1" / "video.mp4"
        audio_file = item_dir / "audio-p1" / "audio.m4a"
        log_path = Path(self.temp_dir.name) / "logs" / "song-a.log"
        video_file.parent.mkdir(parents=True, exist_ok=True)
        audio_file.parent.mkdir(parents=True, exist_ok=True)
        video_file.write_bytes(b"video")
        audio_file.write_bytes(b"audio")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                item.selected_pages = [1]
                item.video_page = 1
                self.store.add_item(item, requester_name="cache-test-user")
                cache_attempt_token = begin_cache_attempt(self.store, item.id)
                manager.desired_ids.add(item.id)
                with patch.object(manager, "_download_page_stream", side_effect=[video_file, audio_file]):
                    result = manager._download_selected_streams(
                        item,
                        Path("/tools/BBDown"),
                        Path("/tools/ffmpeg"),
                        item_dir,
                        log_path,
                        cache_attempt_token=cache_attempt_token,
                        download_source="bbdown",
                    )
            finally:
                manager.shutdown()

        self.assertEqual(result["audio_variants"][0]["audio_url"], "/media/song-a/audio-p1/audio.m4a")
        self.assertEqual(result["audio_variants"][0]["page"], 1)
        self.assertNotIn("media_url", result["audio_variants"][0])
        validation_labels = [entry["label"] for entry in result["validation_files"]]
        self.assertEqual(validation_labels, ["视频轨 P1", "音轨 P1"])
        video_validation, audio_validation = result["validation_files"]
        self.assertIn("expected_duration", video_validation)
        self.assertNotIn("expected_duration", audio_validation)

    def test_download_selected_streams_records_page_for_single_p2_audio_binding(self):
        item_dir = self.cache_dir / "song-a"
        item_dir.mkdir(parents=True, exist_ok=True)
        video_file = item_dir / "video-p2" / "video.mp4"
        audio_file = item_dir / "audio-p2" / "audio.m4a"
        log_path = Path(self.temp_dir.name) / "logs" / "song-a.log"
        video_file.parent.mkdir(parents=True, exist_ok=True)
        audio_file.parent.mkdir(parents=True, exist_ok=True)
        video_file.write_bytes(b"video")
        audio_file.write_bytes(b"audio")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                item.selected_pages = [2]
                item.selected_parts = ["伴奏"]
                item.available_pages = [1, 2]
                item.available_parts = ["原曲", "伴奏"]
                item.video_page = 2
                self.store.add_item(item, requester_name="cache-test-user")
                cache_attempt_token = begin_cache_attempt(self.store, item.id)
                manager.desired_ids.add(item.id)
                with patch.object(manager, "_download_page_stream", side_effect=[video_file, audio_file]):
                    result = manager._download_selected_streams(
                        item,
                        Path("/tools/BBDown"),
                        Path("/tools/ffmpeg"),
                        item_dir,
                        log_path,
                        cache_attempt_token=cache_attempt_token,
                        download_source="bbdown",
                    )
            finally:
                manager.shutdown()

        self.assertEqual(Path(result["video_relative_path"]).as_posix(), "song-a/video-p2/video.mp4")
        self.assertEqual(result["audio_variants"][0]["id"], "p2_track_1")
        self.assertEqual(result["audio_variants"][0]["page"], 2)
        self.assertEqual(result["selected_audio_variant_id"], "p2_track_1")

    def test_download_selected_streams_preserves_p2_default_when_p1_audio_is_also_bound(self):
        item_dir = self.cache_dir / "song-a"
        item_dir.mkdir(parents=True, exist_ok=True)
        video_file = item_dir / "video-p2" / "video.mp4"
        audio_p1_file = item_dir / "audio-p1" / "audio.m4a"
        audio_p2_file = item_dir / "audio-p2" / "audio.m4a"
        log_path = Path(self.temp_dir.name) / "logs" / "song-a.log"
        for file_path in (video_file, audio_p1_file, audio_p2_file):
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(b"track")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                item.page = 2
                item.cid = 789
                item.part_title = "off vocal"
                item.display_title = "title-song-a - off vocal"
                item.selected_pages = [1, 2]
                item.selected_parts = ["main track", "off vocal"]
                item.available_pages = [1, 2]
                item.available_parts = ["main track", "off vocal"]
                item.selected_audio_variant_id = "p2_off_vocal"
                item.video_page = 2
                self.store.add_item(item, requester_name="cache-test-user")
                cache_attempt_token = begin_cache_attempt(self.store, item.id)
                manager.desired_ids.add(item.id)
                with patch.object(manager, "_download_page_stream", side_effect=[video_file, audio_p1_file, audio_p2_file]):
                    result = manager._download_selected_streams(
                        item,
                        Path("/tools/BBDown"),
                        Path("/tools/ffmpeg"),
                        item_dir,
                        log_path,
                        cache_attempt_token=cache_attempt_token,
                        download_source="bbdown",
                    )
            finally:
                manager.shutdown()

        self.assertEqual(Path(result["video_relative_path"]).as_posix(), "song-a/video-p2/video.mp4")
        self.assertEqual([variant["id"] for variant in result["audio_variants"]], ["p1_main_track", "p2_off_vocal"])
        self.assertEqual([variant["page"] for variant in result["audio_variants"]], [1, 2])
        self.assertEqual(result["selected_audio_variant_id"], "p2_off_vocal")

    def test_start_bbdown_login_removes_stale_qr_image(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        qr_path = bbdown_dir / "qrcode.png"
        qr_path.write_bytes(b"old-qr")
        (bbdown_dir / "BBDown.data").write_text(
            "ticket=synthetic-ticket; gourl=synthetic-path",
            encoding="utf-8",
        )

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch("bilikara.cache.threading.Thread") as thread_mock:
                    manager.start_bbdown_login(force_refresh_qr=True)
                    self.assertFalse(qr_path.exists())
                    thread_mock.assert_called_once()
            finally:
                manager.shutdown()

    def test_bbdown_logout_removes_data_file(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        data_path = bbdown_dir / "BBDown.data"
        data_path.write_text("{}", encoding="utf-8")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                status = manager.logout_bbdown()
            finally:
                manager.shutdown()

        self.assertFalse(data_path.exists())
        self.assertFalse(status["logged_in"])

    def test_bbdown_login_success_triggers_callback(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        callback_calls: list[str] = []
        cancel_event = Mock()
        cancel_event.wait.return_value = False
        cancel_event.is_set.return_value = False

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(
                self.store,
                max_cache_items=3,
                on_bbdown_login_success=lambda: callback_calls.append("refresh"),
            )
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=[
                        {"data": {"url": "synthetic-qr-url", "qrcode_key": "synthetic-qr-key"}},
                        {"data": {"code": 0}},
                    ],
                ), patch.object(
                    manager,
                    "_write_bbdown_login_qr",
                    return_value="data:image/png;base64,synthetic",
                ), patch.object(
                    manager,
                    "_cookie_text_from_login_jar",
                    return_value="SESSDATA=synthetic-session; bili_jct=synthetic-csrf",
                ):
                    manager._bbdown_login_worker(cancel_event)

                self.assertEqual(callback_calls, ["refresh"])
                self.assertEqual(manager.bbdown_login_status()["state"], "logged_in")
            finally:
                manager.shutdown()

    def test_bbdown_login_generate_failure_logs_sanitized_exception(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        log_dir = Path(self.temp_dir.name) / "logs"
        cancel_event = Mock()
        cancel_event.is_set.return_value = False
        secret_values = (
            "synthetic-qr-secret",
            "synthetic-session-secret",
            "synthetic-access-secret",
        )
        request_error = urllib.error.URLError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] self-signed certificate in certificate chain "
            "at https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
            f"?qrcode_key={secret_values[0]} Cookie: SESSDATA={secret_values[1]} "
            f"access_token={secret_values[2]}"
        )

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_DIR", bbdown_dir
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            manager.log_dir = log_dir
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=request_error,
                ):
                    manager._bbdown_login_worker(cancel_event)
                status = manager.bbdown_login_status()
            finally:
                manager.shutdown()

        log_text = (log_dir / "bilibili-login.log").read_text(encoding="utf-8")
        self.assertIn("stage=generate", log_text)
        self.assertIn("type=URLError", log_text)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", log_text)
        for secret_value in secret_values:
            self.assertNotIn(secret_value, log_text)
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["message"], "Bilibili 登录请求失败，请重试")

    def test_bbdown_login_poll_failure_logs_poll_stage_without_qr_secret(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        log_dir = Path(self.temp_dir.name) / "logs"
        cancel_event = Mock()
        cancel_event.wait.return_value = False
        cancel_event.is_set.return_value = False
        qr_secret = "synthetic-poll-qr-secret"
        poll_error = urllib.error.URLError(
            "timed out requesting "
            f"https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={qr_secret}"
        )

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_DIR", bbdown_dir
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            manager.log_dir = log_dir
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=[
                        {"data": {"url": "synthetic-qr-url", "qrcode_key": qr_secret}},
                        poll_error,
                    ],
                ), patch.object(
                    manager,
                    "_write_bbdown_login_qr",
                    return_value="data:image/png;base64,synthetic",
                ):
                    manager._bbdown_login_worker(cancel_event)
            finally:
                manager.shutdown()

        log_text = (log_dir / "bilibili-login.log").read_text(encoding="utf-8")
        self.assertIn("stage=poll", log_text)
        self.assertIn("type=URLError", log_text)
        self.assertNotIn(qr_secret, log_text)

    def test_bbdown_login_rejects_ticket_only_data_after_zero_exit(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        (bbdown_dir / "BBDown.data").write_text(
            "ticket=synthetic-ticket; gourl=synthetic-path; first_domain=synthetic-domain",
            encoding="utf-8",
        )
        callback_calls: list[str] = []
        cancel_event = Mock()
        cancel_event.wait.return_value = False
        cancel_event.is_set.return_value = False

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(
                self.store,
                max_cache_items=3,
                on_bbdown_login_success=lambda: callback_calls.append("refresh"),
            )
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=[
                        {"data": {"url": "synthetic-qr-url", "qrcode_key": "synthetic-qr-key"}},
                        {"data": {"code": 0}},
                    ],
                ), patch.object(
                    manager,
                    "_write_bbdown_login_qr",
                    return_value="data:image/png;base64,synthetic",
                ), patch.object(
                    manager,
                    "_cookie_text_from_login_jar",
                    return_value="",
                ):
                    manager._bbdown_login_worker(cancel_event)

                status = manager.bbdown_login_status()
                self.assertEqual(callback_calls, [])
                self.assertFalse(status["logged_in"])
                self.assertEqual(status["state"], "failed")
                self.assertIn("SESSDATA 和 bili_jct", status["message"])
            finally:
                manager.shutdown()

    def test_bbdown_login_rejects_valid_cookie_when_poll_fails(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        (bbdown_dir / "BBDown.data").write_text(
            "SESSDATA=synthetic-session; bili_jct=synthetic-csrf",
            encoding="utf-8",
        )

        cancel_event = Mock()
        cancel_event.wait.return_value = False
        cancel_event.is_set.return_value = False

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=[
                        {"data": {"url": "synthetic-qr-url", "qrcode_key": "synthetic-qr-key"}},
                        {"data": {"code": 1}},
                    ],
                ), patch.object(
                    manager,
                    "_write_bbdown_login_qr",
                    return_value="data:image/png;base64,synthetic",
                ):
                    manager._bbdown_login_worker(cancel_event)

                status = manager.bbdown_login_status()
                self.assertFalse(status["logged_in"])
                self.assertEqual(status["state"], "failed")
                self.assertEqual(status["message"], "Bilibili 登录失败，请重试")
            finally:
                manager.shutdown()

    def test_cookie_text_from_login_jar_requires_web_cookie_pair(self):
        complete = [
            SimpleNamespace(name="bili_jct", value="synthetic-csrf"),
            SimpleNamespace(name="SESSDATA", value="synthetic-session"),
            SimpleNamespace(name="DedeUserID", value="100"),
        ]
        token_only = [SimpleNamespace(name="access_token", value="synthetic-token")]

        self.assertEqual(
            CacheManager._cookie_text_from_login_jar(complete),
            "SESSDATA=synthetic-session; bili_jct=synthetic-csrf; DedeUserID=100",
        )
        self.assertEqual(CacheManager._cookie_text_from_login_jar(token_only), "")

    def test_cancelled_login_does_not_save_returned_cookie_material(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        cancel_event = Mock()
        cancel_event.wait.return_value = False
        cancel_event.is_set.return_value = True

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.bbdown_login_cancel_event = cancel_event
                with patch.object(
                    manager,
                    "_bilibili_login_request_json",
                    side_effect=[
                        {"data": {"url": "synthetic-qr-url", "qrcode_key": "synthetic-qr-key"}},
                        {"data": {"code": 0}},
                    ],
                ), patch.object(
                    manager,
                    "_write_bbdown_login_qr",
                    return_value="data:image/png;base64,synthetic",
                ), patch.object(manager, "_save_bbdown_login_cookie") as save_cookie:
                    manager._bbdown_login_worker(cancel_event)

                save_cookie.assert_not_called()
                self.assertFalse((bbdown_dir / "BBDown.data").exists())
            finally:
                manager.shutdown()

    def test_save_bbdown_login_cookie_is_atomic_and_private(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                saved = manager._save_bbdown_login_cookie(
                    "SESSDATA=synthetic-session; bili_jct=synthetic-csrf"
                )
            finally:
                manager.shutdown()

        data_path = bbdown_dir / "BBDown.data"
        self.assertTrue(saved)
        self.assertTrue(data_path.exists())
        self.assertFalse((bbdown_dir / ".BBDown.data.login.tmp").exists())
        if os.name != "nt":
            self.assertEqual(data_path.stat().st_mode & 0o777, 0o600)

    def test_ensure_ffmpeg_rejects_non_executable_binary(self):
        vendor_dir = Path(self.temp_dir.name) / "vendor"
        tools_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        suffix = ".exe" if os.name == "nt" else ""
        bundled_ffmpeg = vendor_dir / f"ffmpeg{suffix}"
        runtime_ffmpeg = tools_dir / f"ffmpeg{suffix}"
        vendor_dir.mkdir(parents=True, exist_ok=True)
        bundled_ffmpeg.write_bytes(b"bad-ffmpeg")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.VENDOR_DIR", vendor_dir
        ), patch("bilikara.cache.INTERNAL_VENDOR_DIR", Path(self.temp_dir.name) / "_internal" / "vendor"), patch(
            "bilikara.cache.FFMPEG_TOOLS_DIR", tools_dir
        ), patch("bilikara.cache.FFMPEG_RUNTIME_PATH", runtime_ffmpeg), patch(
            "bilikara.cache.FFPROBE_RUNTIME_PATH", tools_dir / f"ffprobe{suffix}"
        ), patch("bilikara.cache.FFMPEG_PATH_OVERRIDE", ""), patch(
            "bilikara.cache.shutil.which", return_value=None
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_read_ffmpeg_version", return_value=""):
                    with self.assertRaisesRegex(RuntimeError, "FFmpeg 不可执行"):
                        manager._ensure_ffmpeg(force_refresh=True)
            finally:
                manager.shutdown()


class CacheManagerMediaIntegrityEvidenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.cache_dir = root / "cache"
        self.cache_dir.mkdir()
        self.log_path = root / "downkyi.log"
        self.store = PlaylistStore(root / "state.json", root / "backup.json")
        self.store.add_session_user("diagnostic-user")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _manager(self):
        return CacheManager(self.store, max_cache_items=3)

    def _add_item(self, item_id: str) -> PlaylistItem:
        item = PlaylistItem(
            id=item_id,
            original_url=f"https://example.test/{item_id}",
            resolved_url=f"https://example.test/{item_id}?p=1",
            bvid="BV1xx411c7mD",
            aid=1,
            cid=2,
            page=1,
            title=item_id,
            part_title="P1",
            display_title=f"{item_id} - P1",
            cover_url="",
            embed_url="",
        )
        self.store.add_item(item, requester_name="diagnostic-user")
        return item

    def _publication_fixture(
        self,
        manager: CacheManager,
        item_id: str,
        token: int,
        marker: bytes,
    ) -> tuple[dict[str, object], dict[str, object], Path, Path]:
        reservation, staging, committed = manager._cache_attempt_paths(token)
        staging.mkdir(parents=True)
        video = staging / "downloaded-video.mp4"
        audio = staging / "downloaded-audio.m4a"
        video.write_bytes(b"video-" + marker)
        audio.write_bytes(b"audio-" + marker)
        result: dict[str, object] = {
            "video_file": video,
            "video_relative_path": str(video.relative_to(self.cache_dir)),
            "video_media_url": f"/media/{video.relative_to(self.cache_dir)}",
            "audio_variants": [
                {
                    "id": "p1",
                    "label": "P1",
                    "page": 1,
                    "audio_url": f"/media/{audio.relative_to(self.cache_dir)}",
                }
            ],
            "selected_audio_variant_id": "p1",
            "validation_files": [
                {"path": video, "stream_kind": "video", "page": 1},
                {"path": audio, "stream_kind": "audio", "page": 1},
            ],
            "validation_metadata": [{"path": str(video)}, {"path": str(audio)}],
        }
        return reservation, result, staging, committed

    def _apply_ready_result(
        self,
        item_id: str,
        token: int,
        result: dict[str, object],
    ) -> bool:
        return self.store.apply_cache_event(
            item_id,
            cache_attempt_token=token,
            event={
                "kind": "ready",
                "progress": 100.0,
                "message": "ready",
                "video_relative_path": result["video_relative_path"],
                "video_media_url": result["video_media_url"],
                "audio_variants": result["audio_variants"],
                "selected_audio_variant_id": result["selected_audio_variant_id"],
                "item_incarnation_id": result["item_incarnation_id"],
                "artifact_set_id": result["artifact_set_id"],
                "artifact_relative_directory": result[
                    "artifact_relative_directory"
                ],
            },
        )

    @staticmethod
    def _probe_payload(kind: str, duration: str | None) -> dict:
        stream = {
            "codec_type": kind,
            "codec_name": "h264" if kind == "video" else "aac",
            "codec_tag_string": "avc1" if kind == "video" else "mp4a",
            "start_time": "0.000000",
            "time_base": "1/1000",
        }
        file_format = {"format_name": "mov,mp4,m4a", "start_time": "0.000000"}
        if duration is not None:
            stream["duration"] = duration
            stream["duration_ts"] = str(round(float(duration) * 1000))
            file_format["duration"] = duration
        return {"streams": [stream], "format": file_format}

    def test_downkyi_diagnostics_redact_signed_urls_and_cookie(self):
        safe = CacheManager._safe_url_summary(
            "https://upos.example.com/path/video.m4s?deadline=123&token=secret"
        )
        command = CacheManager._redacted_command_for_log([
            "aria2c",
            "https://upos.example.com/path/video.m4s?token=secret",
            "--header",
            "Cookie: SESSDATA=secret",
        ])
        self.assertEqual(safe, "https://upos.example.com/video.m4s")
        self.assertEqual(command[1], "https://upos.example.com/video.m4s")
        self.assertEqual(command[3], "Cookie: <redacted>")
        self.assertNotIn("secret", json.dumps(command))

    def test_aria2_output_diagnostics_lists_control_and_numbered_files(self):
        target = self.cache_dir / "song" / "video-p1"
        target.mkdir(parents=True)
        expected = target / "video-p1.mp4"
        expected.write_bytes(b"old")
        (target / "video-p1.mp4.aria2").write_bytes(b"control")
        (target / "video-p1.1.mp4").write_bytes(b"new")

        result = CacheManager._aria2_output_diagnostics(target, expected)

        self.assertTrue(result["expected_exists"])
        self.assertEqual(result["aria2_files"], ["video-p1.mp4.aria2"])
        self.assertEqual(result["numbered_alternatives"], ["video-p1.1.mp4"])
        self.assertEqual(
            [entry["name"] for entry in result["files"]],
            ["video-p1.1.mp4", "video-p1.mp4", "video-p1.mp4.aria2"],
        )

    def test_validate_media_file_returns_structured_probe_metadata(self):
        media = self.cache_dir / "song" / "video.mp4"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"media")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", return_value=SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps(self._probe_payload("video", "120.5")),
                    stderr="",
                )):
                    result = manager._validate_media_file(
                        Path("/tools/ffprobe"),
                        Path("/tools/ffmpeg"),
                        media,
                        label="视频轨 P1",
                        required_streams={"video"},
                        log_path=self.log_path,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(result["path"], str(media))
        self.assertEqual(result["size"], 5)
        self.assertEqual(result["format_name"], "mov,mp4,m4a")
        self.assertEqual(result["duration"], 120.5)
        self.assertEqual(result["start_time"], 0.0)
        self.assertEqual(result["streams"][0]["codec_name"], "h264")
        self.assertEqual(result["streams"][0]["codec_tag_string"], "avc1")
        self.assertEqual(result["streams"][0]["duration_ts"], "120500")
        self.assertEqual(result["streams"][0]["time_base"], "1/1000")

    def test_audio_stream_duration_does_not_use_video_or_container_duration(self):
        payload = {
            "streams": [
                {"codec_type": "video", "duration": "243.0"},
                {"codec_type": "audio", "duration": "87.0"},
            ],
            "format": {"duration": "243.0"},
        }

        self.assertEqual(CacheManager._probe_stream_duration(payload, "audio"), 87.0)
        self.assertEqual(CacheManager._probe_stream_duration(payload, "video"), 243.0)

    def test_original_audio_probe_uses_audio_stream_not_container_duration(self):
        media = self.cache_dir / "song" / "raw-audio.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"raw")
        payload = {
            "streams": [
                {"codec_type": "video", "duration": "243.0"},
                {"codec_type": "audio", "duration": "87.0"},
            ],
            "format": {"duration": "243.0"},
        }
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(payload),
                        stderr="",
                    ),
                ):
                    duration = manager._probe_original_audio_duration(
                        Path("/tools/ffprobe"),
                        Path("/tools/ffmpeg"),
                        media,
                        label="音轨 P1",
                        log_path=self.log_path,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(duration, 87.0)

    def test_stream_duration_reconstructs_from_duration_ts_and_time_base(self):
        payload = {
            "streams": [{
                "codec_type": "audio",
                "duration_ts": "459020",
                "time_base": "1/44100",
            }],
            "format": {"duration": "99.0"},
        }

        self.assertAlmostEqual(
            CacheManager._probe_stream_duration(payload, "audio"),
            459020 / 44100,
            places=9,
        )

    def test_stream_duration_rejects_invalid_or_non_finite_values(self):
        invalid_payloads = [
            {"streams": [{"codec_type": "audio", "duration": "nan"}]},
            {"streams": [{"codec_type": "audio", "duration": "inf"}]},
            {
                "streams": [{
                    "codec_type": "audio",
                    "duration_ts": "100",
                    "time_base": "1/0",
                }]
            },
            {
                "streams": [{
                    "codec_type": "audio",
                    "duration_ts": True,
                    "time_base": "1/1000",
                }]
            },
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                self.assertIsNone(CacheManager._probe_stream_duration(payload, "audio"))

    def test_validation_error_prevents_cache_result_acceptance(self):
        media = self.cache_dir / "song" / "audio.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"media")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                with patch.object(manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")), patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(self._probe_payload("video", "120")),
                        stderr="",
                    ),
                ):
                    with self.assertRaisesRegex(DownloadCommandError, "音轨 P1"):
                        manager._validate_cache_result(
                            "song",
                            {"validation_files": [{
                                "path": media,
                                "label": "音轨 P1",
                                "required_streams": {"audio"},
                            }]},
                            Path("/tools/ffmpeg"),
                            self.log_path,
                            cache_attempt_token=1,
                        )
            finally:
                manager.shutdown()

    def test_source_audio_missing_stream_duration_is_rejected(self):
        with self.assertRaisesRegex(DownloadCommandError, "未报告音频流时长"):
            self._validate_source_audio_duration(None, source_duration=120.0)

    def test_source_audio_duration_accepts_observed_remux_delta(self):
        result = self._validate_source_audio_duration("118.0", source_duration=120.0)
        self.assertEqual(result["duration"], 118.0)

    def test_source_audio_duration_rejects_shorter_output_beyond_tolerance(self):
        with self.assertRaisesRegex(DownloadCommandError, "与原始音轨时长不一致"):
            self._validate_source_audio_duration("117.999", source_duration=120.0)

    def test_source_audio_duration_rejects_longer_output_beyond_tolerance(self):
        with self.assertRaisesRegex(DownloadCommandError, "与原始音轨时长不一致"):
            self._validate_source_audio_duration("122.001", source_duration=120.0)

    def test_video_significantly_shorter_than_expected_is_rejected(self):
        self._assert_duration_rejected("video", "87", expected=243)

    def test_downkyi_validation_requires_ffprobe(self):
        media = self.cache_dir / "song" / "audio.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"media")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch.object(manager, "_ffprobe_path_for_ffmpeg", return_value=None):
                    with self.assertRaisesRegex(DownloadCommandError, "需要可用的 ffprobe"):
                        manager._validate_cache_result(
                            "song",
                            {"validation_files": [{
                                "path": media,
                                "label": "音轨 P1",
                                "required_streams": {"audio"},
                                "download_source": DOWNLOAD_SOURCE_DOWNKYI,
                            }]},
                            Path("/tools/ffmpeg"),
                            self.log_path,
                            cache_attempt_token=1,
                        )
            finally:
                manager.shutdown()

    def test_downkyi_full_demux_failure_is_rejected(self):
        media = self.cache_dir / "song" / "audio.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"partial")
        probe = SimpleNamespace(
            returncode=0,
            stdout=json.dumps(self._probe_payload("audio", "120")),
            stderr="",
        )
        demux = SimpleNamespace(returncode=1, stdout="", stderr="partial file: unexpected EOF")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", side_effect=[probe, demux]):
                    with self.assertRaisesRegex(DownloadCommandError, "完整包扫描失败"):
                        manager._validate_media_file(
                            Path("/tools/ffprobe"),
                            Path("/tools/ffmpeg"),
                            media,
                            label="音轨 P1",
                            required_streams={"audio"},
                            log_path=self.log_path,
                            diagnostic_context={
                                "source_audio_duration": 120,
                                "download_source": DOWNLOAD_SOURCE_DOWNKYI,
                                "stream_kind": "audio",
                            },
                        )
            finally:
                manager.shutdown()

    def test_bbdown_full_demux_failure_is_rejected(self):
        media = self.cache_dir / "song" / "video.mp4"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"partial")
        probe = SimpleNamespace(
            returncode=0,
            stdout=json.dumps(self._probe_payload("video", "120")),
            stderr="",
        )
        demux = SimpleNamespace(returncode=1, stdout="", stderr="partial file: unexpected EOF")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", side_effect=[probe, demux]):
                    with self.assertRaisesRegex(DownloadCommandError, "完整包扫描失败"):
                        manager._validate_media_file(
                            Path("/tools/ffprobe"),
                            Path("/tools/ffmpeg"),
                            media,
                            label="视频 P2",
                            required_streams={"video"},
                            log_path=self.log_path,
                            diagnostic_context={
                                "download_source": DOWNLOAD_SOURCE_BBDOWN,
                                "stream_kind": "video",
                            },
                        )
            finally:
                manager.shutdown()

    def test_bbdown_cache_result_requires_ffprobe_for_strict_validation(self):
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch.object(manager, "_ffprobe_path_for_ffmpeg", return_value=None):
                    with self.assertRaisesRegex(DownloadCommandError, "BBDown/DownKyi"):
                        manager._validate_cache_result(
                            "test-id",
                            {
                                "validation_files": [
                                    {
                                        "download_source": DOWNLOAD_SOURCE_BBDOWN,
                                        "path": Path("/fake/video.mp4"),
                                        "required_streams": {"video"},
                                        "label": "视频",
                                    }
                                ]
                            },
                            Path("/tools/ffmpeg"),
                            self.log_path,
                            cache_attempt_token=1,
                        )
            finally:
                manager.shutdown()

    def test_downkyi_video_is_copy_remuxed_with_faststart(self):
        media = self.cache_dir / "song" / ".attempt-test" / "video-p1.mp4"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"raw-video")
        captured = {}

        def fake_run(command, **_kwargs):
            captured["command"] = command
            Path(command[-1]).write_bytes(b"normalized-video")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", side_effect=fake_run):
                    manager._normalize_downkyi_media_file(
                        Path("/tools/ffmpeg"), media, label="视频轨 P1",
                        stream_kind="video", log_path=self.log_path,
                    )
                self.assertEqual(media.read_bytes(), b"normalized-video")
            finally:
                manager.shutdown()
        command = captured["command"]
        self.assertEqual(command[command.index("-map") + 1], "0:v:0")
        self.assertIn("+faststart", command)
        self.assertIn("copy", command)

    def test_downkyi_flac_remux_preserves_flac_container(self):
        media = self.cache_dir / "song" / ".attempt-test" / "audio-p1.flac"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"raw-flac")
        captured = {}

        def fake_run(command, **_kwargs):
            captured["command"] = command
            Path(command[-1]).write_bytes(b"normalized-flac")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", side_effect=fake_run):
                    manager._normalize_downkyi_media_file(
                        Path("/tools/ffmpeg"), media, label="音轨 P1",
                        stream_kind="audio", log_path=self.log_path,
                    )
            finally:
                manager.shutdown()
        command = captured["command"]
        self.assertTrue(command[-1].endswith(".flac"))
        self.assertEqual(command[command.index("-map") + 1], "0:a:0")
        self.assertNotIn("-movflags", command)

    def test_real_aac_remux_preserves_original_audio_duration_when_available(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            self.skipTest("ffmpeg/ffprobe unavailable")
        media = self.cache_dir / "song" / ".attempt-test" / "audio-p1.m4a"
        media.parent.mkdir(parents=True)
        generated = subprocess.run([
            ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=44100:duration=1.2",
            "-vn", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov",
            str(media),
        ], capture_output=True, text=True, check=False)
        if generated.returncode != 0:
            self.skipTest(f"AAC fixture generation unavailable: {generated.stderr[:120]}")

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                source_duration = manager._probe_original_audio_duration(
                    Path(ffprobe),
                    Path(ffmpeg),
                    media,
                    label="音轨 P1",
                    log_path=self.log_path,
                )
                manager._normalize_downkyi_media_file(
                    Path(ffmpeg),
                    media,
                    label="音轨 P1",
                    stream_kind="audio",
                    log_path=self.log_path,
                )
                metadata = manager._validate_media_file(
                    Path(ffprobe),
                    Path(ffmpeg),
                    media,
                    label="音轨 P1",
                    required_streams={"audio"},
                    log_path=self.log_path,
                    diagnostic_context={"source_audio_duration": source_duration},
                )
            finally:
                manager.shutdown()

        self.assertLessEqual(
            abs(float(metadata["duration"]) - source_duration),
            SOURCE_AUDIO_DURATION_TOLERANCE_SECONDS,
        )

    def test_downkyi_remux_failure_keeps_raw_file_and_rejects_cache(self):
        media = self.cache_dir / "song" / ".attempt-test" / "audio-p1.m4a"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"truncated-raw")
        failed = SimpleNamespace(returncode=1, stdout="", stderr="partial file: unexpected EOF")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", return_value=failed):
                    with self.assertRaisesRegex(DownloadCommandError, "unexpected EOF"):
                        manager._normalize_downkyi_media_file(
                            Path("/tools/ffmpeg"), media, label="音轨 P1",
                            stream_kind="audio", log_path=self.log_path,
                        )
                self.assertEqual(media.read_bytes(), b"truncated-raw")
                self.assertEqual(list(media.parent.glob("*.normalized-*")), [])
            finally:
                manager.shutdown()

    def test_real_ffmpeg_remuxes_fragmented_mp4_when_available(self):
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if not ffmpeg or not ffprobe:
            self.skipTest("ffmpeg/ffprobe unavailable")
        media = self.cache_dir / "song" / ".attempt-test" / "video-p1.mp4"
        media.parent.mkdir(parents=True)
        generated = subprocess.run([
            ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
            "color=c=black:s=64x64:r=10:d=1", "-an", "-c:v", "mpeg4",
            "-movflags", "frag_keyframe+empty_moov", str(media),
        ], capture_output=True, text=True, check=False)
        if generated.returncode != 0:
            self.skipTest(f"fixture generation unavailable: {generated.stderr[:120]}")
        before = media.stat().st_size
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                manager._normalize_downkyi_media_file(
                    Path(ffmpeg), media, label="视频轨 P1",
                    stream_kind="video", log_path=self.log_path,
                )
                probe = subprocess.run([
                    ffprobe, "-v", "error", "-show_entries", "format=duration",
                    "-of", "default=nw=1:nk=1", str(media),
                ], capture_output=True, text=True, check=False)
                self.assertEqual(probe.returncode, 0, probe.stderr)
                self.assertGreater(float(probe.stdout.strip()), 0.8)
                self.assertGreater(media.stat().st_size, 0)
                self.assertGreater(before, 0)
            finally:
                manager.shutdown()

    def test_audio_duration_is_not_compared_with_video_duration(self):
        video = self.cache_dir / "song" / "video.mp4"
        audio = self.cache_dir / "song" / "audio.m4a"
        video.parent.mkdir(parents=True)
        video.write_bytes(b"video")
        audio.write_bytes(b"audio")
        cache_result = {
            "validation_files": [
                {
                    "path": video,
                    "label": "视频轨 P1",
                    "required_streams": {"video"},
                    "stream_kind": "video",
                    "page": 1,
                    "expected_duration": 243,
                },
                {
                    "path": audio,
                    "label": "音轨 P1",
                    "required_streams": {"audio"},
                    "stream_kind": "audio",
                    "page": 1,
                },
            ]
        }
        probes = [
            SimpleNamespace(
                returncode=0,
                stdout=json.dumps(self._probe_payload("video", "243")),
                stderr="",
            ),
            SimpleNamespace(
                returncode=0,
                stdout=json.dumps(self._probe_payload("audio", "87")),
                stderr="",
            ),
        ]

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch.object(
                    manager,
                    "_ffprobe_path_for_ffmpeg",
                    return_value=Path("/tools/ffprobe"),
                ), patch("bilikara.cache.subprocess.run", side_effect=probes):
                    manager._validate_cache_result(
                        "song",
                        cache_result,
                        Path("/tools/ffmpeg"),
                        self.log_path,
                        cache_attempt_token=1,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(cache_result["validation_failure_count"], 0)
        self.assertEqual(
            [entry["duration"] for entry in cache_result["validation_metadata"]],
            [243.0, 87.0],
        )

    def _validate_source_audio_duration(
        self,
        actual: str | None,
        *,
        source_duration: float,
    ) -> dict[str, object]:
        media = self.cache_dir / "song" / "source-audio.m4a"
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(b"media")
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = self._manager()
            try:
                with patch(
                    "bilikara.cache.subprocess.run",
                    return_value=SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(self._probe_payload("audio", actual)),
                        stderr="",
                    ),
                ):
                    return manager._validate_media_file(
                        Path("/tools/ffprobe"),
                        Path("/tools/ffmpeg"),
                        media,
                        label="音轨 P1",
                        required_streams={"audio"},
                        log_path=self.log_path,
                        diagnostic_context={"source_audio_duration": source_duration},
                    )
            finally:
                manager.shutdown()

    def _assert_duration_rejected(self, kind: str, actual: str | None, *, expected: float) -> None:
        extension = ".mp4" if kind == "video" else ".m4a"
        media = self.cache_dir / "song" / f"track{extension}"
        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(b"media")
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                with patch("bilikara.cache.subprocess.run", return_value=SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps(self._probe_payload(kind, actual)),
                    stderr="",
                )):
                    with self.assertRaisesRegex(DownloadCommandError, "时长"):
                        manager._validate_media_file(
                            Path("/tools/ffprobe"),
                            Path("/tools/ffmpeg"),
                            media,
                            label=("视频轨" if kind == "video" else "音轨") + " P1",
                            required_streams={kind},
                            log_path=self.log_path,
                            diagnostic_context={"expected_duration": expected},
                        )
            finally:
                manager.shutdown()

    def test_aria2_control_file_after_success_is_rejected(self):
        self._assert_aria2_output_rejected(["video-p1.mp4", "video-p1.mp4.aria2"])

    def test_stale_expected_output_plus_new_numbered_output_is_rejected(self):
        self._assert_aria2_output_rejected(["video-p1.mp4", "video-p1.1.mp4"])

    def test_multiple_matching_media_outputs_are_rejected(self):
        self._assert_aria2_output_rejected(["video-p1.mp4", "other.mp4"])

    def _assert_aria2_output_rejected(self, names: list[str]) -> None:
        target = self.cache_dir / "song" / "video-p1"
        target.mkdir(parents=True)
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                def fake_run(_item_id, command, *_args, **_kwargs):
                    attempt_dir = Path(command[command.index("--dir") + 1])
                    attempt_dir.mkdir(parents=True, exist_ok=True)
                    for index, name in enumerate(names, start=1):
                        (attempt_dir / name).write_bytes(b"x" * index)

                with patch.object(manager, "_run_item_command", side_effect=fake_run):
                    with self.assertRaises(DownloadCommandError):
                        manager._download_stream_with_aria2c(
                            "song",
                            Path("/tools/aria2c"),
                            Path("/tools/ffmpeg"),
                            target,
                            self.log_path,
                            urls=["https://upos.example/video.m4s?token=secret"],
                            out_name="video-p1.mp4",
                            cookie="SESSDATA=secret",
                            stage_label="下载视频轨 P1",
                            track_key="video-p1",
                            cache_attempt_token=1,
                            stream_kind="video",
                            page=1,
                            cid=123,
                        )
            finally:
                manager.shutdown()

    def test_validated_attempt_is_atomically_published_and_urls_rewritten(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                item = PlaylistItem(
                    id="song",
                    original_url="https://example.test/song",
                    resolved_url="https://example.test/song?p=1",
                    bvid="BV1xx411c7mD",
                    aid=1,
                    cid=2,
                    page=1,
                    title="song",
                    part_title="P1",
                    display_title="song - P1",
                    cover_url="",
                    embed_url="",
                )
                self.store.add_item(item, requester_name="diagnostic-user")
                token = begin_cache_attempt(self.store, item.id)
                reservation, attempt, committed = manager._cache_attempt_paths(token)
                attempt.mkdir(parents=True)
                video = attempt / "downloaded-video.mp4"
                audio = attempt / "downloaded-audio.m4a"
                video.write_bytes(b"validated-video")
                audio.write_bytes(b"validated-audio")
                result = {
                    "video_file": video,
                    "video_relative_path": str(video.relative_to(self.cache_dir)),
                    "video_media_url": f"/media/{video.relative_to(self.cache_dir)}",
                    "audio_variants": [
                        {
                            "id": "p1",
                            "label": "P1",
                            "page": 1,
                            "audio_url": f"/media/{audio.relative_to(self.cache_dir)}",
                        }
                    ],
                    "selected_audio_variant_id": "p1",
                    "validation_files": [
                        {"path": video, "stream_kind": "video", "page": 1},
                        {"path": audio, "stream_kind": "audio", "page": 1},
                    ],
                    "validation_metadata": [
                        {"path": str(video)},
                        {"path": str(audio)},
                    ],
                }

                manager._publish_validated_cache_result(
                    item.id,
                    token,
                    reservation,
                    attempt,
                    result,
                    self.log_path,
                )
                final_path = committed / "video-p1.mp4"
                self.assertTrue(final_path.exists())
                self.assertTrue((committed / "audio-p1.m4a").exists())
                self.assertFalse(attempt.exists())
                self.assertEqual(result["video_file"], final_path)
                self.assertEqual(result["validation_files"][0]["path"], final_path)
                self.assertEqual(result["validation_metadata"][0]["path"], str(final_path))
                self.assertNotIn(".staging", result["video_media_url"])
                self.assertEqual(self.store.get_item(item.id).cache_status, "pending")
            finally:
                manager.shutdown()

    def test_superseded_ready_leaves_only_an_orphan_and_preserves_old_commit(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                item = self._add_item("song-orphan")
                first_token = begin_cache_attempt(self.store, item.id)
                first_reservation, first_result, first_staging, first_committed = (
                    self._publication_fixture(
                        manager, item.id, first_token, b"first"
                    )
                )
                manager._publish_validated_cache_result(
                    item.id,
                    first_token,
                    first_reservation,
                    first_staging,
                    first_result,
                    self.log_path,
                )
                self.assertTrue(
                    self._apply_ready_result(item.id, first_token, first_result)
                )
                committed_before = self.store.get_item(item.id)

                stale_token = begin_cache_attempt(self.store, item.id)
                stale_reservation, stale_result, stale_staging, stale_committed = (
                    self._publication_fixture(
                        manager, item.id, stale_token, b"stale"
                    )
                )
                manager._publish_validated_cache_result(
                    item.id,
                    stale_token,
                    stale_reservation,
                    stale_staging,
                    stale_result,
                    self.log_path,
                )
                newest_token = begin_cache_attempt(self.store, item.id)
                with self.assertRaisesRegex(ValueError, "superseded"):
                    self._apply_ready_result(item.id, stale_token, stale_result)

                current = self.store.get_item(item.id)
                self.assertEqual(
                    current.artifact_set_id, committed_before.artifact_set_id
                )
                self.assertEqual(current.video_media_url, committed_before.video_media_url)
                self.assertEqual(
                    (first_committed / "video-p1.mp4").read_bytes(),
                    b"video-first",
                )
                self.assertEqual(
                    (stale_committed / "video-p1.mp4").read_bytes(),
                    b"video-stale",
                )
                self.assertNotEqual(
                    first_reservation["artifact_set_id"],
                    stale_reservation["artifact_set_id"],
                )
                self.assertGreater(newest_token, stale_token)
            finally:
                manager.shutdown()

    def test_generic_update_cannot_change_committed_media_descriptor_or_bytes(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                item = self._add_item("song-metadata-boundary")
                token = begin_cache_attempt(self.store, item.id)
                reservation, result, staging, committed = self._publication_fixture(
                    manager, item.id, token, b"committed"
                )
                manager._publish_validated_cache_result(
                    item.id,
                    token,
                    reservation,
                    staging,
                    result,
                    self.log_path,
                )
                self.assertTrue(self._apply_ready_result(item.id, token, result))
                before = self.store.get_item(item.id)
                self.assertIsNotNone(before)
                before_payload = before.serialize()
                before_bytes = {
                    path.name: path.read_bytes()
                    for path in committed.iterdir()
                    if path.is_file()
                }

                protected_changes = {
                    "original_url": "https://example.test/replacement",
                    "resolved_url": "https://example.test/replacement?p=2",
                    "bvid": "BV1replacement",
                    "aid": 99,
                    "cid": 100,
                    "page": 2,
                    "selected_pages": [2],
                    "selected_cids": [100],
                    "selected_durations": [999],
                    "selected_parts": ["replacement"],
                    "available_pages": [2],
                    "available_cids": [100],
                    "available_durations": [999],
                    "available_parts": ["replacement"],
                    "video_page": 2,
                    "manual_selection": True,
                    "audio_variants": [],
                    "selected_audio_variant_id": "replacement",
                    "cache_status": "pending",
                    "cache_progress": 0.0,
                    "cache_message": "replacement",
                    "video_relative_path": "replacement/video.mp4",
                    "video_media_url": "/media/replacement/video.mp4",
                    "item_incarnation_id": "i-replacement",
                    "artifact_set_id": "a-replacement",
                    "artifact_relative_directory": "artifacts/replacement",
                }
                with self.assertRaisesRegex(ValueError, "metadata fields"):
                    self.store.update_item(item.id, **protected_changes)

                after = self.store.get_item(item.id)
                self.assertIsNotNone(after)
                for field in protected_changes:
                    self.assertEqual(
                        after.serialize()[field],
                        before_payload[field],
                        field,
                    )
                self.assertEqual(
                    {
                        path.name: path.read_bytes()
                        for path in committed.iterdir()
                        if path.is_file()
                    },
                    before_bytes,
                )
            finally:
                manager.shutdown()

    def test_partial_or_colliding_refresh_never_modifies_old_committed_bytes(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch.object(
            CacheManager, "_worker_loop", lambda self: None
        ):
            manager = self._manager()
            try:
                item = self._add_item("song-failure")
                first_token = begin_cache_attempt(self.store, item.id)
                first_reservation, first_result, first_staging, first_committed = (
                    self._publication_fixture(manager, item.id, first_token, b"old")
                )
                manager._publish_validated_cache_result(
                    item.id,
                    first_token,
                    first_reservation,
                    first_staging,
                    first_result,
                    self.log_path,
                )
                self._apply_ready_result(item.id, first_token, first_result)
                old_identity = self.store.get_item(item.id).artifact_set_id

                partial_token = begin_cache_attempt(self.store, item.id)
                partial_reservation, partial_result, partial_staging, partial_committed = (
                    self._publication_fixture(
                        manager, item.id, partial_token, b"partial"
                    )
                )
                Path(
                    partial_result["validation_files"][1]["path"]
                ).unlink()
                with self.assertRaisesRegex(DownloadCommandError, "临时文件不可用"):
                    manager._publish_validated_cache_result(
                        item.id,
                        partial_token,
                        partial_reservation,
                        partial_staging,
                        partial_result,
                        self.log_path,
                    )
                self.assertFalse(partial_committed.exists())
                self.store.apply_cache_event(
                    item.id,
                    cache_attempt_token=partial_token,
                    event={"kind": "failed", "message": "partial failed"},
                )
                self.assertEqual(self.store.get_item(item.id).artifact_set_id, old_identity)

                collision_token = begin_cache_attempt(self.store, item.id)
                collision_reservation, collision_result, collision_staging, collision_committed = (
                    self._publication_fixture(
                        manager, item.id, collision_token, b"collision"
                    )
                )
                collision_committed.mkdir(parents=True)
                (collision_committed / "marker").write_bytes(b"existing")
                with self.assertRaisesRegex(DownloadCommandError, "目标已存在"):
                    manager._publish_validated_cache_result(
                        item.id,
                        collision_token,
                        collision_reservation,
                        collision_staging,
                        collision_result,
                        self.log_path,
                    )
                self.assertEqual(
                    (collision_committed / "marker").read_bytes(), b"existing"
                )
                self.assertFalse((collision_committed / "video-p1.mp4").exists())
                self.assertEqual(
                    (first_committed / "video-p1.mp4").read_bytes(), b"video-old"
                )
                self.assertEqual(self.store.get_item(item.id).artifact_set_id, old_identity)
            finally:
                manager.shutdown()

class CacheManagerBBDownRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.cache_dir = temp_path / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.store = PlaylistStore(
            state_file=temp_path / "state.json",
            backup_file=temp_path / "playlist_backup.json",
        )
        self.store.add_session_user("cache-test-user")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_debug_print_no_early_return_and_handles_unicode(self):
        from bilikara.cache import _debug_print
        fake_stdout = io.StringIO()
        with patch("sys.stdout", fake_stdout):
            _debug_print("Hello 世界")
            self.assertIn("Hello 世界", fake_stdout.getvalue())

        fake_buffer = io.BytesIO()
        class UnicodeErrorStdout:
            def __init__(self):
                self.encoding = "ascii"
                self.buffer = fake_buffer
            def write(self, s):
                raise UnicodeEncodeError("ascii", s, 0, 1, "ordinal not in range")
            def flush(self):
                pass

        with patch("sys.stdout", UnicodeErrorStdout()):
            _debug_print("Hello 世界")
            self.assertIn(b"Hello ??", fake_buffer.getvalue())

    def test_download_tool_asset_attempts_both_urls_and_formats_errors(self):
        manager = CacheManager(self.store, max_cache_items=3)
        try:
            download_calls = []
            def fake_download_url(url, target_path):
                download_calls.append(url)
                raise ConnectionError(f"failed to connect to {url}")

            target_file = Path(self.temp_dir.name) / "test_tool"

            with patch("bilikara.cache.TOOL_ASSET_BASE_URL", "https://mirror.example.com"), patch.object(
                manager, "_download_url", side_effect=fake_download_url
            ):
                asset = {
                    "name": "test_tool_asset",
                    "browser_download_url": "https://github.example.com/test_tool_asset"
                }
                with self.assertRaisesRegex(RuntimeError, "tool asset test_tool_asset download failed") as ctx:
                    manager._download_tool_asset(asset, target_file, tool="bbdown")

                err_msg = str(ctx.exception)
                self.assertIn("test_tool_asset", err_msg)
                self.assertIn("https://github.example.com/test_tool_asset", err_msg)
                self.assertIn("https://mirror.example.com/test_tool_asset", err_msg)
                self.assertIn("ConnectionError: failed to connect to https://github.example.com/test_tool_asset", err_msg)
                self.assertIn("ConnectionError: failed to connect to https://mirror.example.com/test_tool_asset", err_msg)
                self.assertEqual(download_calls, [
                    "https://github.example.com/test_tool_asset",
                    "https://mirror.example.com/test_tool_asset"
                ])
                self.assertFalse(target_file.exists())
        finally:
            manager.shutdown()

    def test_invalid_bbdown_archive_raises_clear_error(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        version_file = bbdown_dir / "VERSION"

        invalid_zip_content = b"<html><body>Proxy Error</body></html>"

        def fake_download_url(url, path):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(invalid_zip_content)

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_DIR", bbdown_dir
        ), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch(
            "bilikara.cache.platform.system", return_value="Windows"
        ), patch(
            "bilikara.cache.platform.machine", return_value="AMD64"
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL", "https://mirror.example.com"
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                release_data = {
                    "tag_name": "v1.6.3",
                    "assets": [{"name": "BBDown_1.6.3_win-x64.zip", "browser_download_url": "https://github.com/win-x64.zip"}]
                }
                with patch.object(manager, "_fetch_latest_release", return_value=release_data), patch.object(
                    manager, "_download_url", side_effect=fake_download_url
                ):
                    with self.assertRaisesRegex(RuntimeError, "BBDown 下载内容不是有效压缩包: BBDown_1.6.3_win-x64.zip \\(size=37 bytes\\)"):
                        manager._ensure_bbdown()
            finally:
                manager.shutdown()

    def test_failed_bbdown_update_preserves_existing_binary_and_bbdown_data(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        version_file = bbdown_dir / "VERSION"
        version_file.write_text("v1.6.2", encoding="utf-8")

        suffix = ".exe" if os.name == "nt" else ""
        existing_binary = bbdown_dir / f"BBDown{suffix}"
        existing_binary.write_bytes(b"existing-binary-content")

        data_file = bbdown_dir / "BBDown.data"
        data_file.write_text("user-data", encoding="utf-8")

        def fake_download_url(url, path):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"invalid-archive")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_DIR", bbdown_dir
        ), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ), patch(
            "bilikara.cache.platform.system", return_value="Windows"
        ), patch(
            "bilikara.cache.platform.machine", return_value="AMD64"
        ), patch(
            "bilikara.cache.TOOL_ASSET_BASE_URL", "https://mirror.example.com"
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                release_data = {
                    "tag_name": "v1.6.3",
                    "assets": [{"name": "BBDown_1.6.3_win-x64.zip", "browser_download_url": "https://github.com/win-x64.zip"}]
                }
                with patch.object(manager, "_fetch_latest_release", return_value=release_data) as fetch_release, patch.object(
                    manager, "_download_url", side_effect=fake_download_url
                ):
                    with self.assertRaises(Exception):
                        manager._ensure_bbdown(force_refresh=True)

                fetch_release.assert_called_once_with()

                self.assertTrue(existing_binary.exists())
                self.assertEqual(existing_binary.read_bytes(), b"existing-binary-content")

                self.assertTrue(data_file.exists())
                self.assertEqual(data_file.read_text(encoding="utf-8"), "user-data")

                self.assertEqual(version_file.read_text(encoding="utf-8").strip(), "v1.6.2")
            finally:
                manager.shutdown()

    def test_worker_loop_handles_unexpected_exception(self):
        log_dir = Path(self.temp_dir.name) / "logs"

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = PlaylistItem(
                    id="song-err",
                    original_url="https://www.bilibili.com/video/BV1xx411c7mD",
                    resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
                    bvid="BV1xx411c7mD",
                    aid=123,
                    cid=456,
                    page=1,
                    title="song-err",
                    part_title="P1",
                    display_title="song-err - P1",
                    cover_url="",
                    embed_url="https://player.bilibili.com/player.html?aid=123",
                )
                self.store.add_item(item, requester_name="cache-test-user")
                cache_attempt_token = begin_cache_attempt(self.store, item.id)

                with patch.object(manager, "_cache_item", side_effect=RuntimeError("unexpected crash")):
                    with manager.lock:
                        manager.pending_ids.add(item.id)
                        manager.python_worker_download_sources[item.id] = (
                            DOWNLOAD_SOURCE_BBDOWN
                        )
                        manager.python_cache_attempt_tokens[item.id] = (
                            cache_attempt_token
                        )
                    manager.tasks.put("song-err")
                    manager.tasks.join()

                import time
                time.sleep(0.1)

                refreshed = self.store.get_item("song-err")
                self.assertEqual(refreshed.cache_status, "failed")
                self.assertIn("缓存发生意外错误: unexpected crash", refreshed.cache_message)

                manager.sync_with_playlist()
                self.assertEqual(manager.tasks.qsize(), 0)
                refreshed = self.store.get_item("song-err")
                self.assertEqual(refreshed.cache_status, "failed")

                log_path = manager._item_log_path("song-err")
                self.assertTrue(log_path.exists())
                log_content = log_path.read_text(encoding="utf-8")
                self.assertIn("Unexpected error caching item: unexpected crash", log_content)
            finally:
                manager.shutdown()


class CacheManagerDownkyiRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.cache_dir = temp_path / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.store = PlaylistStore(
            state_file=temp_path / "state.json",
            backup_file=temp_path / "playlist_backup.json",
        )
        self.store.add_session_user("cache-test-user")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _single_downkyi_item(item_id: str = "single-p-item") -> PlaylistItem:
        return PlaylistItem(
            id=item_id,
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=111,
            page=1,
            title="Single P Video",
            part_title="P1",
            display_title="Single P Video",
            cover_url="",
            embed_url="",
            selected_pages=[1],
            selected_cids=[111],
            selected_durations=[120],
            selected_parts=["P1"],
            video_page=1,
        )

    def test_rust_native_guest_resolves_dash_and_downgrades_quality_without_python_fallback(self):
        item = self._single_downkyi_item("native-guest")
        guest_dash = {
            "video": [
                {
                    "url": "https://media.example/480.m4s",
                    "backup_urls": [],
                    "codec_name": "avc",
                    "quality_id": 32,
                    "bandwidth": 500_000,
                },
                {
                    "url": "https://media.example/720.m4s",
                    "backup_urls": [],
                    "codec_name": "avc",
                    "quality_id": 64,
                    "bandwidth": 1_000_000,
                },
            ],
            "audio": [
                {
                    "url": "https://media.example/audio.m4s",
                    "backup_urls": [],
                    "quality_id": 30280,
                    "bandwidth": 192_000,
                }
            ],
            "flac": None,
            "dolby": None,
        }
        with patch.object(CacheManager, "_worker_loop", lambda self: None), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value=""
        ), patch(
            "bilikara.cache.rust_runtime.fetch_bilibili_dash_playurl",
            return_value=guest_dash,
        ) as native_dash, patch(
            "bilikara.cache.fetch_dash_playurl"
        ) as python_dash:
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager.video_quality = "1080P 高清"
                manager.audio_hires = False
                selected = manager._resolve_dash_streams(item, native_media=True)
            finally:
                manager.shutdown()

        self.assertEqual(native_dash.call_args.kwargs["cookie"], "")
        self.assertEqual(selected["video"][0]["quality_id"], 64)
        self.assertEqual(selected["audio"][0]["quality_id"], 30280)
        python_dash.assert_not_called()

    def test_rust_native_guest_media_download_omits_cookie_header(self):
        item = self._single_downkyi_item("native-guest-media")
        captured = {}

        def fake_download(*, destination, headers, **_kwargs):
            captured["headers"] = list(headers)
            destination.write_bytes(b"guest-media")
            return {"bytes_written": len(b"guest-media"), "candidate_index": 0}

        with patch.object(CacheManager, "_worker_loop", lambda self: None), patch(
            "bilikara.cache.rust_runtime.download_to_path", side_effect=fake_download
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                manager._begin_download_progress(
                    item.id,
                    [{"key": "video-p1", "label": "视频轨P1", "order": 0}],
                    cache_attempt_token=1,
                )
                result = manager._download_stream_with_rust(
                    item.id,
                    self.cache_dir / item.id / "video-p1",
                    Path(self.temp_dir.name) / "native-guest.log",
                    urls=["https://media.example/video.m4s"],
                    out_name="video-p1.mp4",
                    cookie="",
                    stage_label="下载视频轨 P1",
                    track_key="video-p1",
                    cache_attempt_token=1,
                    stream_kind="video",
                )
            finally:
                manager.shutdown()

        self.assertTrue(result.is_file())
        self.assertFalse(any(name.lower() == "cookie" for name, _value in captured["headers"]))

    def test_rust_native_http_status_wrappers_distinguish_access_failures(self):
        expected = {
            401: ("authentication", "login/Cookie is invalid or expired"),
            402: ("unavailable", "unavailable or requires payment"),
            403: ("forbidden", "media access was forbidden"),
        }
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                for status, (kind, message) in expected.items():
                    with self.subTest(status=status), patch(
                        "bilikara.cache.rust_runtime.download_to_path",
                        side_effect=rust_runtime.RustDownloadError(
                            "http_status",
                            f"HTTP {status}",
                            response={
                                "error": {
                                    "kind": "http_status",
                                    "http_status": status,
                                }
                            },
                        ),
                    ):
                        with self.assertRaises(DownloadCommandError) as raised:
                            manager._download_stream_with_rust(
                                f"native-http-{status}",
                                self.cache_dir / f"native-http-{status}",
                                Path(self.temp_dir.name) / f"native-http-{status}.log",
                                urls=["https://media.example/video.m4s"],
                                out_name="video-p1.mp4",
                                cookie="",
                                stage_label="下载视频轨 P1",
                                track_key="video-p1",
                                cache_attempt_token=1,
                                stream_kind="video",
                            )
                        self.assertEqual(raised.exception.kind, kind)
                        self.assertIn(message, str(raised.exception))
                        self.assertEqual(raised.exception.http_status, status)
            finally:
                manager.shutdown()

    def test_unknown_api_error_is_not_automatically_terminal(self):
        unknown = DownloadCommandError("unclassified API failure")
        unknown.kind = "api"
        unknown.api_code = -999
        authentication = DownloadCommandError("not logged in")
        authentication.kind = "api"
        authentication.api_code = -101

        self.assertFalse(CacheManager._is_terminal_track_failure(unknown))
        self.assertTrue(CacheManager._is_terminal_track_failure(authentication))

    def test_downkyi_without_cookie_fails_before_tool_preparation_or_track_work(self):
        item = self._single_downkyi_item("downkyi-no-cookie")
        self.store.add_item(item, requester_name="cache-test-user")
        item = self.store.get_item(item.id)
        self.assertIsNotNone(item)
        with patch.object(CacheManager, "_worker_loop", lambda self: None), patch(
            "bilikara.cache.effective_bilibili_cookie", return_value=""
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.python_worker_download_sources[item.id] = DOWNLOAD_SOURCE_DOWNKYI
                with patch.object(manager, "_ensure_downloader") as prepare_aria2c, patch.object(
                    manager, "_ensure_ffmpeg"
                ) as prepare_ffmpeg, patch.object(
                    manager, "_begin_download_progress"
                ) as begin_tracks, patch.object(
                    manager, "_resolve_dash_streams"
                ) as resolve_dash, patch.object(
                    manager, "_download_dash_streams_with_aria2c"
                ) as aria2_download, patch.object(
                    manager.stop_event, "wait", wraps=manager.stop_event.wait
                ) as retry_wait, patch.object(
                    manager, "_project_cache_event", wraps=manager._project_cache_event
                ) as project_event:
                    result = manager._cache_item_multi(
                        item.id,
                        item,
                        allow_refresh_retry=True,
                    )
                self.assertFalse(result)
                prepare_aria2c.assert_not_called()
                prepare_ffmpeg.assert_not_called()
                begin_tracks.assert_not_called()
                resolve_dash.assert_not_called()
                aria2_download.assert_not_called()
                retry_wait.assert_not_called()
                self.assertFalse(
                    any(call.args[1] == "started" for call in project_event.call_args_list)
                )
                refreshed = self.store.get_item(item.id)
                self.assertEqual(refreshed.cache_status, "failed")
                self.assertEqual(
                    refreshed.cache_message,
                    "缓存失败: DownKyi/aria2c requires a valid Bilibili login/Cookie",
                )
            finally:
                manager.shutdown()

    def test_downkyi_explicit_forbidden_failure_stops_after_one_track_attempt(self):
        item = self._single_downkyi_item("downkyi-expired-cookie")
        forbidden_error = DownloadCommandError(
            "DownKyi/aria2c Bilibili media access was forbidden (HTTP 403)"
        )
        forbidden_error.kind = "forbidden"
        forbidden_error.http_status = 403
        download_calls = []

        def fail_download(*args, **kwargs):
            download_calls.append((args, kwargs))
            raise forbidden_error

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                with patch.object(
                    manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")
                ), patch.object(
                    manager, "_download_stream_with_aria2c", side_effect=fail_download
                ), patch.object(
                    manager.stop_event, "wait", wraps=manager.stop_event.wait
                ) as retry_wait:
                    with self.assertRaisesRegex(
                        DownloadCommandError, r"access was forbidden \(HTTP 403\)"
                    ) as raised:
                        manager._download_dash_streams_with_aria2c(
                            item=item,
                            binary_path=Path("/tools/aria2c"),
                            ffmpeg_path=Path("/tools/ffmpeg"),
                            item_dir=self.cache_dir / item.id,
                            log_path=Path(self.temp_dir.name) / "expired-cookie.log",
                            dash_streams={
                                "video": [
                                    {
                                        "url": "https://media.example/video.m4s",
                                        "backup_urls": [],
                                        "quality_id": 64,
                                    }
                                ]
                            },
                            video_track={
                                "key": "video-p1",
                                "page": 1,
                                "stream_kind": "video",
                                "label": "V1",
                                "order": 0,
                            },
                            audio_tracks=[],
                            cache_attempt_token=1,
                            validate_tracks=True,
                        )
                retry_wait.assert_not_called()
            finally:
                manager.shutdown()

        self.assertEqual(len(download_calls), 1)
        self.assertNotIn("10", str(raised.exception))

    def test_aria2_http_statuses_are_classified_and_redacted(self):
        item = self._single_downkyi_item("downkyi-aria-http")
        expected = {
            401: ("authentication", "login/Cookie is invalid or expired"),
            402: ("unavailable", "unavailable or requires payment"),
            403: ("forbidden", "media access was forbidden"),
        }
        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                    manager.active_item_id = item.id
                for status, (kind, message) in expected.items():
                    with self.subTest(status=status):
                        log_path = Path(self.temp_dir.name) / f"aria-http-{status}.log"
                        target_dir = self.cache_dir / item.id / f"video-p{status}"
                        target_dir.mkdir(parents=True)
                        track_key = f"video-p{status}"
                        manager._begin_download_progress(
                            item.id,
                            [{"key": track_key, "label": "视频轨", "order": 0}],
                            cache_attempt_token=1,
                        )
                        command = [
                            sys.executable,
                            "-c",
                            (
                                "print('errorCode=22 The response status is not successful. "
                                f"status={status} URI=https://media.example/video.m4s?' + "
                                "'token' + '=' + 'secret'); raise SystemExit(1)"
                            ),
                        ]
                        with self.assertRaises(DownloadCommandError) as raised:
                            manager._run_item_command(
                                item.id,
                                command,
                                Path(sys.executable),
                                log_path,
                                stage_label="下载视频轨 P1",
                                stream_kind="video",
                                target_dir=target_dir,
                                track_key=track_key,
                                cache_attempt_token=1,
                                tool_dir=Path(self.temp_dir.name),
                                progress_from_output=True,
                            )
                        self.assertEqual(raised.exception.kind, kind)
                        self.assertEqual(raised.exception.http_status, status)
                        self.assertIn(message, str(raised.exception))
                        log_text = log_path.read_text(encoding="utf-8")
                        self.assertNotIn("token=secret", log_text)
                        self.assertNotIn(
                            "https://media.example/video.m4s?token=secret", log_text
                        )
            finally:
                manager.shutdown()

    def test_downkyi_multi_page_audio_resolves_correct_cids_and_urls(self):
        item = PlaylistItem(
            id="multi-p-item",
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=111,
            page=1,
            title="Multi P Video",
            part_title="P1",
            display_title="Multi P Video",
            cover_url="",
            embed_url="",
            selected_pages=[1, 2, 3],
            selected_cids=[111, 222, 333],
            selected_parts=["P1", "P2", "P3"],
            video_page=1,
        )

        resolved_cids = []

        def mock_fetch_dash(bvid, cid, avid):
            resolved_cids.append(cid)
            return {
                "video": [{"id": 80, "url": f"video-cid-{cid}.m4s", "backup_urls": []}],
                "audio": [{"id": 30216, "url": f"audio-cid-{cid}.m4s", "backup_urls": []}],
            }

        downloaded_tracks = []

        def mock_download_aria2c(item_id, binary_path, ffmpeg_path, target_dir, log_path, urls, out_name, cookie, stage_label, track_key, stream_kind, **_kwargs):
            downloaded_tracks.append({
                "urls": urls,
                "out_name": out_name,
                "stage_label": stage_label,
            })
            return Path(target_dir) / out_name

        with patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test"), patch(
            "bilikara.cache.fetch_dash_playurl", side_effect=mock_fetch_dash
        ), patch.object(
            CacheManager, "_download_stream_with_aria2c", side_effect=mock_download_aria2c
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = Path(self.temp_dir.name) / "test.log"
                dash_streams = manager._resolve_dash_streams(item)
                result = manager._download_dash_streams_with_aria2c(
                    item=item,
                    binary_path=Path("/tools/aria2c"),
                    ffmpeg_path=Path("/tools/ffmpeg"),
                    item_dir=self.cache_dir / "multi-p-item",
                    log_path=log_path,
                    dash_streams=dash_streams,
                    video_track={
                        "key": "video_1",
                        "page": 1,
                        "stream_kind": "video",
                        "label": "视频轨 P1",
                        "order": 0,
                    },
                    audio_tracks=[
                        {
                            "key": "audio_1",
                            "page": 1,
                            "stream_kind": "audio",
                            "label": "音轨 P1",
                            "order": 1,
                        },
                        {
                            "key": "audio_2",
                            "page": 2,
                            "stream_kind": "audio",
                            "label": "音轨 P2",
                            "order": 2,
                        },
                        {
                            "key": "audio_3",
                            "page": 3,
                            "stream_kind": "audio",
                            "label": "音轨 P3",
                            "order": 3,
                        },
                    ],
                    cache_attempt_token=1,
                )
            finally:
                manager.shutdown()

        self.assertEqual(resolved_cids, [111, 111, 222, 333])
        self.assertEqual(len(downloaded_tracks), 4)
        downloads_by_name = {entry["out_name"]: entry for entry in downloaded_tracks}
        self.assertEqual(downloads_by_name["video-p1.mp4"]["urls"][0], "video-cid-111.m4s")
        self.assertEqual(downloads_by_name["audio-p1.m4a"]["urls"][0], "audio-cid-111.m4s")
        self.assertEqual(downloads_by_name["audio-p2.m4a"]["urls"][0], "audio-cid-222.m4s")
        self.assertEqual(downloads_by_name["audio-p3.m4a"]["urls"][0], "audio-cid-333.m4s")

        self.assertTrue(log_path.exists())
        log_content = log_path.read_text(encoding="utf-8")
        self.assertIn("resolve audio DASH: page=1, cid=111", log_content)
        self.assertIn("resolve audio DASH: page=2, cid=222", log_content)
        self.assertIn("resolve audio DASH: page=3, cid=333", log_content)
        self.assertIn("download audio track: page=1, label=音轨 P1", log_content)
        self.assertIn("download audio track: page=2, label=音轨 P2", log_content)
        self.assertIn("download audio track: page=3, label=音轨 P3", log_content)

    def test_downkyi_single_page_regression(self):
        item = PlaylistItem(
            id="single-p-item",
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=111,
            page=1,
            title="Single P Video",
            part_title="P1",
            display_title="Single P Video",
            cover_url="",
            embed_url="",
            selected_pages=[1],
            selected_cids=[111],
            selected_parts=["P1"],
            video_page=1,
        )

        resolved_cids = []

        def mock_fetch_dash(bvid, cid, avid):
            resolved_cids.append(cid)
            return {
                "video": [{"id": 80, "url": "video.m4s", "backup_urls": []}],
                "audio": [{"id": 30216, "url": "audio.m4s", "backup_urls": []}],
            }

        with patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test"), patch(
            "bilikara.cache.fetch_dash_playurl", side_effect=mock_fetch_dash
        ), patch.object(
            CacheManager, "_download_stream_with_aria2c", return_value=Path("/tmp/ok")
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = Path(self.temp_dir.name) / "test.log"
                dash_streams = manager._resolve_dash_streams(item)
                result = manager._download_dash_streams_with_aria2c(
                    item=item,
                    binary_path=Path("/tools/aria2c"),
                    ffmpeg_path=Path("/tools/ffmpeg"),
                    item_dir=self.cache_dir / "single-p-item",
                    log_path=log_path,
                    dash_streams=dash_streams,
                    video_track={"key": "v1", "page": 1, "stream_kind": "video", "label": "V1", "order": 0},
                    audio_tracks=[{"key": "a1", "page": 1, "stream_kind": "audio", "label": "A1", "order": 1}],
                    cache_attempt_token=1,
                )
            finally:
                manager.shutdown()

        self.assertEqual(resolved_cids, [111, 111])

    def test_downkyi_validates_finished_track_without_waiting_for_other_downloads(self):
        item = self._single_downkyi_item("async-validation")
        video_validated = threading.Event()
        download_counts = {"video": 0, "audio": 0}
        audio_steps = []

        def fake_download(_item_id, _binary, _ffmpeg, target_dir, _log, **kwargs):
            kind = kwargs["stream_kind"]
            download_counts[kind] += 1
            if kind == "audio":
                self.assertTrue(video_validated.wait(2), "audio waited for video validation")
            attempt = Path(target_dir) / f".attempt-{kind}-{download_counts[kind]}"
            attempt.mkdir(parents=True)
            path = attempt / kwargs["out_name"]
            path.write_bytes(kind.encode("ascii"))
            return path

        def fake_probe_source(_ffprobe, _ffmpeg, media_path, **_kwargs):
            self.assertEqual(media_path.read_bytes(), b"audio")
            audio_steps.append("source-probe")
            return 120.125

        def fake_normalize(_ffmpeg, _media_path, **kwargs):
            if kwargs["stream_kind"] == "audio":
                audio_steps.append("normalize")

        def fake_validate(_ffprobe, _ffmpeg, media_path, **kwargs):
            context = kwargs["diagnostic_context"]
            if context["stream_kind"] == "video":
                video_validated.set()
                self.assertNotIn("source_audio_duration", context)
            else:
                audio_steps.append("validate")
                self.assertEqual(context["source_audio_duration"], 120.125)
                self.assertNotIn("expected_duration", context)
            return {
                "path": str(media_path),
                "size": media_path.stat().st_size,
                "format_name": "mov,mp4,m4a",
                "duration": 120.0,
                "start_time": 0.0,
                "streams": [],
            }

        with patch.object(CacheManager, "_worker_loop", lambda self: None):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                with patch.object(manager, "_resolve_dash_streams", return_value={
                    "audio": [{"url": "audio.m4s", "backup_urls": [], "quality_id": 30280}],
                }), patch.object(
                    manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")
                ), patch.object(
                    manager, "_download_stream_with_aria2c", side_effect=fake_download
                ), patch.object(
                    manager, "_probe_original_audio_duration", side_effect=fake_probe_source
                ), patch.object(
                    manager, "_normalize_downkyi_media_file", side_effect=fake_normalize
                ), patch.object(
                    manager, "_validate_media_file", side_effect=fake_validate
                ):
                    result = manager._download_dash_streams_with_aria2c(
                        item=item,
                        binary_path=Path("/tools/aria2c"),
                        ffmpeg_path=Path("/tools/ffmpeg"),
                        item_dir=self.cache_dir / item.id,
                        log_path=Path(self.temp_dir.name) / "async.log",
                        dash_streams={
                            "video": [{"url": "video.m4s", "backup_urls": [], "quality_id": 32}],
                        },
                        video_track={"key": "video-p1", "page": 1, "stream_kind": "video", "label": "V1", "order": 0},
                        audio_tracks=[{"key": "audio-p1", "page": 1, "stream_kind": "audio", "label": "A1", "order": 1}],
                        cache_attempt_token=1,
                        validate_tracks=True,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(set(result), {"video-p1", "audio-p1"})
        self.assertEqual(download_counts, {"video": 1, "audio": 1})
        self.assertTrue(video_validated.is_set())
        self.assertEqual(audio_steps, ["source-probe", "normalize", "validate"])

    def test_downkyi_retries_only_failed_track_and_caps_total_attempts_at_ten(self):
        item = self._single_downkyi_item("track-retry")
        download_counts = {"video": 0, "audio": 0}
        validation_counts = {"video": 0, "audio": 0}

        def fake_download(_item_id, _binary, _ffmpeg, target_dir, _log, **kwargs):
            kind = kwargs["stream_kind"]
            download_counts[kind] += 1
            attempt = Path(target_dir) / f".attempt-{kind}-{download_counts[kind]}"
            attempt.mkdir(parents=True)
            path = attempt / kwargs["out_name"]
            path.write_bytes(kind.encode("ascii"))
            return path

        def fake_validate(_ffprobe, _ffmpeg, media_path, **kwargs):
            kind = kwargs["diagnostic_context"]["stream_kind"]
            validation_counts[kind] += 1
            if kind == "audio" and validation_counts[kind] == 1:
                raise DownloadCommandError("audio packet truncated")
            return {
                "path": str(media_path),
                "size": media_path.stat().st_size,
                "format_name": "mov,mp4,m4a",
                "duration": 120.0,
                "start_time": 0.0,
                "streams": [],
            }

        with patch.object(CacheManager, "_worker_loop", lambda self: None), patch(
            "bilikara.cache.DOWNKYI_TRACK_RETRY_WAIT_SECONDS", 0
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                with patch.object(manager, "_resolve_dash_streams", return_value={
                    "audio": [{"url": "audio.m4s", "backup_urls": [], "quality_id": 30280}],
                }), patch.object(
                    manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")
                ), patch.object(
                    manager, "_download_stream_with_aria2c", side_effect=fake_download
                ), patch.object(
                    manager, "_probe_original_audio_duration", return_value=120.0
                ), patch.object(
                    manager, "_normalize_downkyi_media_file"
                ), patch.object(
                    manager, "_validate_media_file", side_effect=fake_validate
                ):
                    manager._download_dash_streams_with_aria2c(
                        item=item,
                        binary_path=Path("/tools/aria2c"),
                        ffmpeg_path=Path("/tools/ffmpeg"),
                        item_dir=self.cache_dir / item.id,
                        log_path=Path(self.temp_dir.name) / "retry.log",
                        dash_streams={
                            "video": [{"url": "video.m4s", "backup_urls": [], "quality_id": 32}],
                        },
                        video_track={"key": "video-p1", "page": 1, "stream_kind": "video", "label": "V1", "order": 0},
                        audio_tracks=[{"key": "audio-p1", "page": 1, "stream_kind": "audio", "label": "A1", "order": 1}],
                        cache_attempt_token=1,
                        validate_tracks=True,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(download_counts, {"video": 1, "audio": 2})
        self.assertEqual(validation_counts, {"video": 1, "audio": 2})

    def test_downkyi_track_failure_stops_after_ten_total_attempts(self):
        item = self._single_downkyi_item("track-retry-limit")
        download_counts = {"video": 0, "audio": 0}

        def fake_download(_item_id, _binary, _ffmpeg, target_dir, _log, **kwargs):
            kind = kwargs["stream_kind"]
            download_counts[kind] += 1
            if kind == "audio":
                raise DownloadCommandError("CDN connection reset")
            attempt = Path(target_dir) / ".attempt-video"
            attempt.mkdir(parents=True, exist_ok=True)
            path = attempt / kwargs["out_name"]
            path.write_bytes(b"video")
            return path

        with patch.object(CacheManager, "_worker_loop", lambda self: None), patch(
            "bilikara.cache.DOWNKYI_TRACK_RETRY_WAIT_SECONDS", 0
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with manager.lock:
                    manager.desired_ids = {item.id}
                    manager.ordered_desired_ids = [item.id]
                with patch.object(manager, "_resolve_dash_streams", return_value={
                    "audio": [{"url": "audio.m4s", "backup_urls": [], "quality_id": 30280}],
                }), patch.object(
                    manager, "_ffprobe_path_for_ffmpeg", return_value=Path("/tools/ffprobe")
                ), patch.object(
                    manager, "_download_stream_with_aria2c", side_effect=fake_download
                ), patch.object(
                    manager, "_normalize_downkyi_media_file"
                ), patch.object(
                    manager, "_validate_media_file", return_value={
                        "path": "video", "size": 5, "format_name": "mp4", "duration": 120.0,
                        "start_time": 0.0, "streams": [],
                    }
                ):
                    with self.assertRaisesRegex(DownloadCommandError, "已尝试 10 次仍失败"):
                        manager._download_dash_streams_with_aria2c(
                            item=item,
                            binary_path=Path("/tools/aria2c"),
                            ffmpeg_path=Path("/tools/ffmpeg"),
                            item_dir=self.cache_dir / item.id,
                            log_path=Path(self.temp_dir.name) / "retry-limit.log",
                            dash_streams={
                                "video": [{"url": "video.m4s", "backup_urls": [], "quality_id": 32}],
                            },
                            video_track={"key": "video-p1", "page": 1, "stream_kind": "video", "label": "V1", "order": 0},
                            audio_tracks=[{"key": "audio-p1", "page": 1, "stream_kind": "audio", "label": "A1", "order": 1}],
                            cache_attempt_token=1,
                            validate_tracks=True,
                        )
            finally:
                manager.shutdown()

        self.assertEqual(download_counts["audio"], 10)
        self.assertEqual(download_counts["video"], 1)

    def test_downkyi_missing_cid_mapping_fails_clear(self):
        item = PlaylistItem(
            id="bad-item",
            original_url="https://www.bilibili.com/video/BV1xx411c7mD",
            resolved_url="https://www.bilibili.com/video/BV1xx411c7mD?p=1",
            bvid="BV1xx411c7mD",
            aid=123,
            cid=111,
            page=1,
            title="Bad Video",
            part_title="P1",
            display_title="Bad Video",
            cover_url="",
            embed_url="",
            selected_pages=[1, 2],
            selected_cids=[111],
            selected_parts=["P1", "P2"],
            video_page=1,
        )

        with patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=test"), patch(
            "bilikara.cache.fetch_dash_playurl", return_value={
                "video": [{"url": "video.m4s", "backup_urls": []}],
                "audio": [{"id": 30216, "url": "audio.m4s", "backup_urls": []}],
            }
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                log_path = Path(self.temp_dir.name) / "test.log"
                with self.assertRaisesRegex(RuntimeError, "无法解析 P2 的 cid，不能下载对应音频"):
                    manager._download_dash_streams_with_aria2c(
                        item=item,
                        binary_path=Path("/tools/aria2c"),
                        ffmpeg_path=Path("/tools/ffmpeg"),
                        item_dir=self.cache_dir / "bad-item",
                        log_path=log_path,
                        dash_streams={"video": [{"url": "video.m4s", "backup_urls": []}], "audio": []},
                        video_track={"key": "v1", "page": 1, "stream_kind": "video", "label": "V1", "order": 0},
                        audio_tracks=[
                            {"key": "a1", "page": 1, "stream_kind": "audio", "label": "A1", "order": 1},
                            {"key": "a2", "page": 2, "stream_kind": "audio", "label": "A2", "order": 2},
                        ],
                        cache_attempt_token=1,
                    )
            finally:
                manager.shutdown()


if __name__ == "__main__":
    unittest.main()
