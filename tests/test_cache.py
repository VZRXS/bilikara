import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from bilikara.cache import CacheManager, DownloadCommandError
from bilikara.models import PlaylistItem
from bilikara.store import PlaylistStore


class CacheManagerOutputTest(unittest.TestCase):
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

    def test_cache_metrics_reports_usage_by_item(self):
        first = self.cache_dir / "song-a"
        second = self.cache_dir / "song-b"
        first.mkdir()
        second.mkdir()
        (first / "video.mp4").write_bytes(b"1234")
        (second / "video.mp4").write_bytes(b"123456")

        log_dir = Path(self.temp_dir.name) / "logs"
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.LOG_DIR", log_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                metrics = manager.cache_metrics()
            finally:
                manager.shutdown()

        self.assertEqual(metrics["total_bytes"], 10)
        self.assertEqual(metrics["item_count"], 2)
        self.assertEqual(metrics["item_bytes"]["song-a"], 4)
        self.assertEqual(metrics["item_bytes"]["song-b"], 6)

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
            finally:
                manager.shutdown()

        self.assertFalse(item_dir.exists())
        self.assertFalse(log_path.exists())

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

    def test_retry_item_requeues_failed_cache_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                self.store.update_item(
                    "song-a",
                    cache_status="failed",
                    cache_message="缓存失败",
                    persist_backup=False,
                )
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock:
                    manager.retry_item("song-a")
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "pending")
                    self.assertEqual(retried.cache_message, "准备重新下载")
                    enqueue_mock.assert_called_once_with("song-a")
            finally:
                manager.shutdown()

    def test_retry_item_can_force_requeue_ready_cache_item(self):
        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                item = self.make_item("song-a")
                self.store.add_item(item, requester_name="cache-test-user")
                self.store.update_item(
                    "song-a",
                    cache_status="ready",
                    cache_message="缓存完成",
                    video_media_url="/media/song-a/video.mp4",
                    persist_backup=False,
                )
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock:
                    manager.retry_item("song-a", force=True)
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "pending")
                    self.assertEqual(retried.cache_message, "准备重新下载")
                    self.assertEqual(retried.video_media_url, "")
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
                self.store.update_item(
                    "song-a",
                    cache_status="downloading",
                    cache_message="downloading",
                    persist_backup=False,
                )
                with manager.lock:
                    manager.desired_ids = {"song-a"}
                    manager.pending_ids = {"song-a"}
                with patch.object(manager, "enqueue") as enqueue_mock, patch.object(
                    manager, "_terminate_process"
                ) as terminate_mock:
                    manager.retry_item("song-a")
                    retried = self.store.get_item("song-a")
                    self.assertIsNotNone(retried)
                    self.assertEqual(retried.cache_status, "pending")
                    self.assertTrue((self.cache_dir / "song-a").exists())
                    self.assertIn("song-a", manager.retry_requested_ids)
                    enqueue_mock.assert_not_called()
                    terminate_mock.assert_not_called()
            finally:
                manager.shutdown()

    def test_cache_item_clears_old_cache_dir_before_processing_pending_retry(self):
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
                with patch.object(manager, "_cache_item_multi") as cache_item_multi_mock:
                    manager._cache_item("song-a")
                    self.assertFalse((self.cache_dir / "song-a").exists())
                    cache_item_multi_mock.assert_called_once()
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

    def test_ensure_bbdown_uses_local_binary_when_release_check_fails(self):
        suffix = ".exe" if os.name == "nt" else ""
        local_binary = Path(self.temp_dir.name) / "tools" / "bbdown" / f"BBDown{suffix}"
        local_binary.parent.mkdir(parents=True, exist_ok=True)
        local_binary.write_bytes(b"bbdown-bin")
        version_file = Path(self.temp_dir.name) / "tools" / "bbdown" / "VERSION"
        version_file.write_text("1.6.3", encoding="utf-8")

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager, "_fetch_latest_release", side_effect=RuntimeError("offline")
                ):
                    path = manager._ensure_bbdown()
            finally:
                manager.shutdown()

        self.assertEqual(path, local_binary)
        self.assertEqual(manager.binary_version, "1.6.3")
        self.assertIn("未检查更新", manager.binary_message)

    def test_ensure_bbdown_raises_when_release_check_fails_and_no_local_binary(self):
        suffix = ".exe" if os.name == "nt" else ""
        local_binary = Path(self.temp_dir.name) / "tools" / "bbdown" / f"BBDown{suffix}"
        version_file = Path(self.temp_dir.name) / "tools" / "bbdown" / "VERSION"

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch(
            "bilikara.cache.BB_DOWN_VERSION_FILE", version_file
        ):
            manager = CacheManager(self.store, max_cache_items=3)
            try:
                with patch.object(manager, "_local_binary_path", return_value=local_binary), patch.object(
                    manager, "_fetch_latest_release", side_effect=RuntimeError("offline")
                ):
                    with self.assertRaisesRegex(RuntimeError, "无法检查 BBDown 最新版本"):
                        manager._ensure_bbdown()
            finally:
                manager.shutdown()

    def test_ensure_ffmpeg_syncs_bundled_binary_into_runtime_tools(self):
        vendor_dir = Path(self.temp_dir.name) / "vendor"
        tools_dir = Path(self.temp_dir.name) / "tools" / "ffmpeg"
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

        self.assertEqual(
            CacheManager._bbdown_ffmpeg_path_arg(binary_path),
            str(binary_path.parent),
        )

    def test_tool_process_env_prepends_ffmpeg_and_bbdown_dirs(self):
        suffix = ".exe" if os.name == "nt" else ""
        ffmpeg_path = Path(self.temp_dir.name) / "runtime" / "tools" / "bbdown" / f"ffmpeg{suffix}"
        ffmpeg_path.parent.mkdir(parents=True, exist_ok=True)
        ffmpeg_path.write_bytes(b"ffmpeg-bin")

        with patch("bilikara.cache.BB_DOWN_DIR", ffmpeg_path.parent):
            env = CacheManager._tool_process_env(ffmpeg_path)

        first_path = env["PATH"].split(os.pathsep)[0]
        self.assertEqual(first_path, str(ffmpeg_path.parent))

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
                with patch.object(manager, "_download_page_stream", side_effect=[video_file, audio_file]):
                    result = manager._download_selected_streams(
                        item,
                        Path("/tools/BBDown"),
                        Path("/tools/ffmpeg"),
                        item_dir,
                        log_path,
                    )
            finally:
                manager.shutdown()

        self.assertEqual(result["audio_variants"][0]["audio_url"], "/media/song-a/audio-p1/audio.m4a")
        self.assertNotIn("media_url", result["audio_variants"][0])
        validation_labels = [entry["label"] for entry in result["validation_files"]]
        self.assertEqual(validation_labels, ["视频轨 P1", "音轨 P1"])

    def test_start_bbdown_login_removes_stale_qr_image(self):
        bbdown_dir = Path(self.temp_dir.name) / "tools" / "bbdown"
        bbdown_dir.mkdir(parents=True, exist_ok=True)
        qr_path = bbdown_dir / "qrcode.png"
        qr_path.write_bytes(b"old-qr")

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
        (bbdown_dir / "BBDown.data").write_text("{}", encoding="utf-8")
        callback_calls: list[str] = []

        class FakeLoginProcess:
            def __init__(self) -> None:
                self.stdout = io.StringIO("login qr ready\n")
                self.returncode: int | None = None

            def poll(self) -> int | None:
                return self.returncode

            def terminate(self) -> None:
                self.returncode = 0

            def wait(self, timeout: float | None = None) -> int:
                self.returncode = 0
                return 0

            def kill(self) -> None:
                self.returncode = -9

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir), patch("bilikara.cache.BB_DOWN_DIR", bbdown_dir):
            manager = CacheManager(
                self.store,
                max_cache_items=3,
                on_bbdown_login_success=lambda: callback_calls.append("refresh"),
            )
            try:
                with patch.object(manager, "_ensure_bbdown", return_value=bbdown_dir / "BBDown"), patch(
                    "bilikara.cache.subprocess.Popen",
                    return_value=FakeLoginProcess(),
                ):
                    manager._bbdown_login_worker()

                self.assertEqual(callback_calls, ["refresh"])
                self.assertEqual(manager.bbdown_login_status()["state"], "logged_in")
            finally:
                manager.shutdown()

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


if __name__ == "__main__":
    unittest.main()
