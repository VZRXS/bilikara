import os
import json
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
             patch("bilikara.cache.effective_bilibili_cookie", return_value="SESSDATA=synthetic; bili_jct=csrf"):
            command = manager._bbdown_download_command(Path("BBDown"), Path("ffmpeg"),
                "https://example.invalid/video", page=1, stream_kind="video", target_dir=Path("cache"))
        self.assertIn("--skip-mux", command)
        self.assertIn("--video-only", command)
        self.assertNotIn("--ffmpeg-path", command)
        self.assertNotIn("ffmpeg", command)

    def test_normal_source_mode_remains_available_for_baseline_tests(self):
        with patch.object(media_cli, "DISABLED", False):
            media_cli.require_media_cli()

    def test_ytdlp_no_cli_ignores_user_config_and_disables_fixups(self):
        manager = CacheManager.__new__(CacheManager)
        with patch.object(media_cli, "DISABLED", True), \
             patch.object(manager, "_ytdlp_format_selector", return_value="ba/bestaudio"), \
             patch.object(manager, "_ytdlp_browser_cookie_source", return_value="chrome"), \
             patch("bilikara.cache.effective_bilibili_cookie", return_value=""):
            command = manager._ytdlp_download_command(Path("yt-dlp"), Path("ffmpeg"),
                "https://example.invalid/video", page=1, stream_kind="audio", target_dir=Path("cache"))
        self.assertIn("--ignore-config", command)
        self.assertEqual(command[command.index("--fixup") + 1], "never")
        self.assertEqual(command[command.index("--downloader") + 1], "native")
        self.assertNotIn("--ffmpeg-location", command)


@unittest.skipUnless(os.environ.get("BILIKARA_NO_CLI_FIXTURES"), "requires accepted libav and synthetic media fixtures")
class LiveNoMediaCliTest(unittest.TestCase):
    def child(self, code, *, legacy=False, missing=False):
        with tempfile.TemporaryDirectory(prefix="no-cli-adapter-") as directory:
            env = dict(os.environ, PATH="", BILIKARA_HOME=directory,
                       BILIKARA_BILIBILI_COOKIE="", BILIKARA_DISABLE_MEDIA_CLI="1",
                       BILIKARA_MEDIA_BACKEND="legacy" if legacy else "default")
            if missing:
                env["BILIKARA_LIBAV_COMPANION"] = str(Path(directory) / "absent.so")
            result = subprocess.run([sys.executable, "-c", """
import json, os, shutil
from pathlib import Path
from bilikara import media_cli, rust_runtime as runtime
from bilikara.cache import CacheManager, DownloadCommandError
assert media_cli.DISABLED and shutil.which('ffmpeg') is None and shutil.which('ffprobe') is None
manager = CacheManager.__new__(CacheManager)
fixtures = Path(os.environ['BILIKARA_NO_CLI_FIXTURES'])
home = Path(os.environ['BILIKARA_HOME'])
log = home / 'media.log'
""" + code], env=env, capture_output=True, text=True, encoding="utf-8", timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_real_downkyi_normalization_and_downloader_validation(self):
        result = self.child("""
rows = []
for name, kind in [('video.mp4', 'video'), ('aac.m4a', 'audio')]:
    source = home / name
    shutil.copyfile(fixtures / name, source)
    manager._normalize_downkyi_media_file(Path('/absent/ffmpeg'), source,
        label='fixture', stream_kind=kind, log_path=log)
    metadata = manager._probe_media_metadata(None, Path('/absent/ffmpeg'), source,
        label='fixture', log_path=log, expected_kind=kind)
    manager._validate_demux_file(Path('/absent/ffmpeg'), source,
        label='fixture', stream_kind=kind, log_path=log)
    assert metadata['backend'] == 'libav'
    assert not list(home.glob('.*normalized*'))
    rows.append(name)
output = home / 'extracted.flac'
result = runtime.normalize_media(source=fixtures / 'flac.mp4', destination=output, expected_kind='audio')
assert result['diagnostic']['backend'] == 'libav' and output.read_bytes().startswith(b'fLaC')
rows.append('flac.mp4')
print(json.dumps(rows))
""")
        self.assertEqual(result, ["video.mp4", "aac.m4a", "flac.mp4"])

    def test_real_unsupported_legacy_and_missing_companion_are_terminal(self):
        for legacy, missing, name in [(False, False, "outside.wav"), (True, False, "aac.m4a"), (False, True, "aac.m4a")]:
            with self.subTest(legacy=legacy, missing=missing):
                result = self.child(f"""
try:
    manager._validate_demux_file(Path('/absent/ffmpeg'), fixtures / {name!r},
        label='fixture', log_path=log, stream_kind='audio')
except media_cli.MediaCliDisabledError as exc:
    assert manager._is_terminal_track_failure(exc)
    print(json.dumps({{'terminal': True}}))
else:
    raise AssertionError('unsupported CLI compatibility fabricated success')
""", legacy=legacy, missing=missing)
                self.assertEqual(result, {"terminal": True})

    def test_corrupt_downkyi_source_is_not_replaced_or_reclassified(self):
        result = self.child("""
source = home / 'corrupt.m4a'
shutil.copyfile(fixtures / 'missing-mdat.m4a', source)
original = source.read_bytes()
try:
    manager._normalize_downkyi_media_file(Path('/absent/ffmpeg'), source,
        label='fixture', stream_kind='audio', log_path=log)
except runtime.RustMediaError as exc:
    assert exc.kind in {'invalid_media', 'media_contract_violation'}, exc.kind
    assert source.read_bytes() == original and not list(home.glob('.*normalized*'))
    print(json.dumps({'kind': exc.kind}))
else:
    raise AssertionError('corrupt media was published')
""")
        self.assertIn(result["kind"], {"invalid_media", "media_contract_violation"})
