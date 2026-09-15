import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bilikara import media_cli, rust_runtime
from bilikara.cache import CacheManager


class MediaCliDisabledTest(unittest.TestCase):
    def test_source_opt_in_blocks_actual_spawn_before_path_lookup(self):
        script = """
import os, subprocess
from bilikara import media_cli
assert media_cli.DISABLED
os.environ['BILIKARA_DISABLE_MEDIA_CLI'] = '0'
for name in ['ffmpeg', 'FFPROBE.EXE', 'C:\\\\absent\\\\ffmpeg.exe']:
    try:
        subprocess.run([name, '-version'], check=True, timeout=2)
    except media_cli.MediaCliDisabledError:
        pass
    else:
        raise AssertionError(name)
"""
        env = {**os.environ, "BILIKARA_DISABLE_MEDIA_CLI": "1"}
        result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_windows_audit_event_without_explicit_executable(self):
        for command in ('ffmpeg -version', '"C:\\Program Files\\ffprobe.exe" -version'):
            with self.assertRaises(media_cli.MediaCliDisabledError):
                media_cli._audit("subprocess.Popen", (None, command, None, None))
        media_cli._audit("subprocess.Popen", (None, '"C:\\Program Files\\browser.exe" https://example.invalid', None, None))

    def test_frozen_policy_cannot_be_disabled_by_environment(self):
        script = "import sys; sys.frozen=True; from bilikara import media_cli; assert media_cli.DISABLED"
        result = subprocess.run([sys.executable, "-c", script], env={**os.environ, "BILIKARA_DISABLE_MEDIA_CLI": "0"}, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prepare_and_override_compatibility_fail_before_io(self):
        manager = CacheManager.__new__(CacheManager)
        with patch.object(media_cli, "DISABLED", True), patch("subprocess.run") as run, patch("subprocess.Popen") as popen:
            for prepare in (manager._ensure_ffmpeg,):
                with self.assertRaises(media_cli.MediaCliDisabledError):
                    prepare()
            for name in ("ffmpeg", "ffprobe"):
                with self.assertRaises(media_cli.MediaCliDisabledError):
                    rust_runtime.media_compatibility_tool(name, Path("renamed-override"))
            self.assertEqual(manager.ffmpeg_status()["state"], "disabled")
            self.assertTrue(manager._is_terminal_track_failure(media_cli.MediaCliDisabledError()))
            run.assert_not_called()
            popen.assert_not_called()

    def test_ffmpeg_command_is_blocked_before_logging_or_spawn(self):
        manager = CacheManager.__new__(CacheManager)
        with patch.object(media_cli, "DISABLED", True):
            with self.assertRaises(media_cli.MediaCliDisabledError):
                manager._run_item_command("id", ["ffmpeg"], Path("ffmpeg"), Path("log"),
                    stage_label="test", stream_kind="audio", target_dir=Path("cache"), track_key="audio",
                    cache_attempt_token=1)

    def test_version_checks_do_not_run_any_external_media_tool(self):
        manager = CacheManager.__new__(CacheManager)
        with tempfile.TemporaryDirectory() as directory, patch.object(media_cli, "DISABLED", True), patch("subprocess.run") as run:
            path = Path(directory) / "renamed-tool"
            path.write_bytes(b"sentinel")
            for read in (manager._read_ffmpeg_version,):
                self.assertEqual(read(path), "")
            run.assert_not_called()

    def test_download_tools_remain_allowed(self):
        with patch.object(media_cli, "DISABLED", True):
            for tool in ("BBDown", "aria2c", "yt-dlp"):
                media_cli.require_media_cli(tool)
                media_cli._audit("subprocess.Popen", (None, tool + " --version", None, None))

    def test_bbdown_command_keeps_download_only_mode_without_ffmpeg_dependency(self):
        manager = CacheManager.__new__(CacheManager)
        with patch.object(media_cli, "DISABLED", True), \
             patch.object(manager, "_bbdown_stream_preference_args", return_value=[]), \
             patch("bilikara.cache.effective_bilibili_cookie", return_value=""):
            command = manager._bbdown_download_command(Path("BBDown"), Path("ffmpeg"),
                "https://example.invalid/video", page=1, stream_kind="video", target_dir=Path("cache"))
        self.assertIn("--skip-mux", command)
        self.assertIn("--video-only", command)
        self.assertNotIn("--ffmpeg-path", command)
        self.assertNotIn("ffmpeg", command)

    def test_normal_source_mode_remains_available_for_baseline_tests(self):
        with patch.object(media_cli, "DISABLED", False):
            media_cli.require_media_cli()
