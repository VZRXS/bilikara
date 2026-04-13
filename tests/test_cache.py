import io
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara.cache import CacheManager
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

class CacheManagerPolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        temp_path = Path(self.temp_dir.name)
        self.cache_dir = temp_path / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.store = PlaylistStore(
            state_file=temp_path / "state.json",
            backup_file=temp_path / "playlist_backup.json",
        )

    def tearDown(self) -> None:
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

        with patch("bilikara.cache.CACHE_DIR", self.cache_dir):
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
                self.store.add_item(self.make_item("song-a"))
                log_path = manager._item_log_path("song-a")
                manager._append_log_line(log_path, "缓存日志")
                manager._drop_item_cache("song-a", "释放缓存")
            finally:
                manager.shutdown()

        self.assertFalse(item_dir.exists())
        self.assertFalse(log_path.exists())

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
