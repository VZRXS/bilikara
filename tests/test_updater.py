import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import bilikara.updater as updater
from bilikara import rust_backend
from bilikara.updater import AppUpdateManager, check_for_update, fetch_latest_release, is_auto_update_supported, is_newer_version, select_update_asset, version_tuple


class FakeHTTPResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return self._payload


class UpdateCheckTest(unittest.TestCase):
    def test_safe_filename_python_cases(self):
        long_name = f"{'a' * 300}.zip"
        cases = [
            ("bilikara-v0.7.0.zip", "fallback.zip", "bilikara-v0.7.0.zip"),
            ("歌ってみた.zip", "fallback.zip", "zip"),
            ("卡拉OK更新包.zip", "fallback.zip", "OK-.zip"),
            ("karaoke🎤mix.zip", "fallback.zip", "karaoke-mix.zip"),
            ('bad<>:"/\\|?*name.zip', "fallback.zip", "bad-name.zip"),
            ("  update.zip  ", "fallback.zip", "update.zip"),
            ("part///name.zip", "fallback.zip", "part-name.zip"),
            ("CON", "fallback.zip", "CON"),
            ("...", "fallback.zip", "fallback.zip"),
            ("", "fallback.zip", "fallback.zip"),
            ("abc\x00def.zip", "fallback.zip", "abc-def.zip"),
            ("unchanged_name-1.2.zip", "fallback.zip", "unchanged_name-1.2.zip"),
            (long_name, "fallback.zip", long_name),
        ]

        for name, fallback, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(updater._py_safe_filename(name, fallback), expected)

    def test_safe_filename_uses_python_fallback_without_rust(self):
        with patch("bilikara.updater.rust_backend.safe_filename", return_value=None):
            self.assertEqual(updater._safe_filename("歌名 / demo.zip"), "demo.zip")

    def test_safe_filename_falls_back_on_null_result(self):
        null_library = type("NullLibrary", (), {"rust_safe_filename": lambda self, *args: None})()
        with patch("bilikara.rust_backend._rust_lib", null_library):
            self.assertEqual(updater._safe_filename("歌名 / demo.zip"), "demo.zip")

    def test_safe_filename_preserves_non_string_fallback_behavior(self):
        fallback = object()
        self.assertIs(updater._safe_filename("...", fallback), fallback)

    def test_safe_filename_rust_matches_python(self):
        if not rust_backend.backend_status()["loaded"]:
            self.skipTest("Rust dynamic library is not available")

        long_name = f"{'a' * 300}.zip"
        cases = [
            ("bilikara-v0.7.0.zip", "fallback.zip"),
            ("歌ってみた.zip", "fallback.zip"),
            ("卡拉OK更新包.zip", "fallback.zip"),
            ("karaoke🎤mix.zip", "fallback.zip"),
            ('bad<>:"/\\|?*name.zip', "fallback.zip"),
            ("  update.zip  ", "fallback.zip"),
            ("part///name.zip", "fallback.zip"),
            ("CON", "fallback.zip"),
            ("...", "fallback.zip"),
            ("", "fallback.zip"),
            ("abc\x00def.zip", "fallback.zip"),
            ("unchanged_name-1.2.zip", "fallback.zip"),
            (long_name, "fallback.zip"),
        ]

        for name, fallback in cases:
            with self.subTest(name=name):
                rust_result = rust_backend.safe_filename(name, fallback)
                self.assertIsNotNone(rust_result)
                self.assertEqual(rust_result, updater._py_safe_filename(name, fallback))

    def test_version_tuple_accepts_release_tags(self):
        self.assertEqual(version_tuple("v0.4.1"), (0, 4, 1))
        self.assertEqual(version_tuple("0.4.1"), (0, 4, 1))
        self.assertEqual(version_tuple("v0.5.0-preview.1"), (0, 5, 0))
        self.assertIsNone(version_tuple("v0.4.1-2-gabc123"))

    def test_is_newer_version_compares_semver_tags(self):
        self.assertTrue(is_newer_version("v0.4.1", "v0.4.0"))
        self.assertTrue(is_newer_version("v0.5.0-preview.2", "v0.5.0-preview.1"))
        self.assertTrue(is_newer_version("v0.5.0", "v0.5.0-preview.2"))
        self.assertTrue(is_newer_version("v0.5.1", "v0.5.0-preview.2"))
        self.assertFalse(is_newer_version("v0.4.0", "v0.4.0"))
        self.assertFalse(is_newer_version("v0.5.0-preview.2", "v0.5.0"))
        self.assertFalse(is_newer_version("v0.4.0", "dev"))

    def test_check_for_update_reports_release_link(self):
        result = check_for_update(
            current_version="v0.4.0",
            release_fetcher=lambda: {
                "tag_name": "v0.4.1",
                "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.1",
                "name": "v0.4.1",
                "published_at": "2026-04-29T00:00:00Z",
            },
        )

        self.assertTrue(result["update_available"])
        self.assertEqual(result["current_version"], "v0.4.0")
        self.assertEqual(result["latest_version"], "v0.4.1")
        self.assertEqual(result["release_url"], "https://github.com/VZRXS/bilikara/releases/tag/v0.4.1")

    def test_fetch_latest_release_reports_timeout_error(self):
        with patch("bilikara.updater.urllib.request.urlopen", side_effect=TimeoutError):
            with self.assertRaisesRegex(RuntimeError, "连接 GitHub Releases 超时"):
                fetch_latest_release()

    def test_fetch_latest_release_reports_network_error(self):
        with patch("bilikara.updater.urllib.request.urlopen", side_effect=urllib.error.URLError("offline")):
            with self.assertRaisesRegex(RuntimeError, "无法连接 GitHub Releases"):
                fetch_latest_release()

    def test_fetch_release_json_tries_fallback_urls(self):
        calls: list[str] = []

        def fake_urlopen(request, timeout):
            calls.append(request.full_url)
            if len(calls) == 1:
                raise urllib.error.URLError("offline")
            return FakeHTTPResponse(b'{"tag_name":"v1.2.3"}')

        with patch("bilikara.updater.urllib.request.urlopen", side_effect=fake_urlopen):
            payload = updater._fetch_release_json([
                "https://api.github.com/repos/VZRXS/bilikara/releases/latest",
                "https://mirror.example/releases/latest",
            ])

        self.assertEqual(payload["tag_name"], "v1.2.3")
        self.assertEqual(calls, [
            "https://api.github.com/repos/VZRXS/bilikara/releases/latest",
            "https://mirror.example/releases/latest",
        ])

    def test_download_url_candidates_supports_proxy_template(self):
        with patch("bilikara.updater.APP_UPDATE_DOWNLOAD_PROXY", "https://mirror.example/{url_encoded}"), patch(
            "bilikara.updater.APP_UPDATE_DOWNLOAD_PROXY_FIRST",
            True,
        ):
            candidates = updater._download_url_candidates("https://github.com/VZRXS/bilikara/releases/download/v1/app.zip")

        self.assertEqual(candidates[0], "https://mirror.example/https%3A%2F%2Fgithub.com%2FVZRXS%2Fbilikara%2Freleases%2Fdownload%2Fv1%2Fapp.zip")
        self.assertEqual(candidates[1], "https://github.com/VZRXS/bilikara/releases/download/v1/app.zip")

    def test_app_update_manager_retries_download_with_proxy_candidate(self):
        calls: list[str] = []

        def downloader(url, destination, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                raise RuntimeError("offline")
            destination.write_bytes(b"update")
            return 6, 6

        with tempfile.TemporaryDirectory() as tmpdir, patch(
            "bilikara.updater.APP_UPDATE_DOWNLOAD_PROXY",
            "https://mirror.example/{url}",
        ):
            manager = AppUpdateManager(
                app_home=Path(tmpdir),
                current_version="v0.1.0",
                downloader=downloader,
                target={"platform": "windows", "arch": "x64"},
                frozen=True,
            )
            archive_path = Path(tmpdir) / "update.zip"
            downloaded, total = manager._download_update_archive(
                "https://github.com/VZRXS/bilikara/releases/download/v1/app.zip",
                archive_path,
            )

        self.assertEqual((downloaded, total), (6, 6))
        self.assertEqual(calls, [
            "https://github.com/VZRXS/bilikara/releases/download/v1/app.zip",
            "https://mirror.example/https://github.com/VZRXS/bilikara/releases/download/v1/app.zip",
        ])

    def test_check_for_update_offers_switch_for_non_release_build(self):
        result = check_for_update(
            current_version="v0.4.0-8-gabcdef-dirty",
            release_fetcher=lambda: {
                "tag_name": "v0.4.0",
                "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.0",
            },
        )

        self.assertFalse(result["current_is_release"])
        self.assertFalse(result["update_available"])
        self.assertTrue(result["switch_to_release_available"])
        self.assertIn("非正式版", result["message"])

    def test_stable_current_ignores_newer_preview_release(self):
        result = check_for_update(
            current_version="v0.4.0",
            release_fetcher=lambda: [
                {
                    "tag_name": "v0.5.0-preview.1",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.1",
                    "prerelease": True,
                },
                {
                    "tag_name": "v0.4.0",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.0",
                },
            ],
        )

        self.assertEqual(result["latest_version"], "v0.4.0")
        self.assertFalse(result["update_available"])

    def test_stable_current_can_opt_into_preview_release_check(self):
        result = check_for_update(
            current_version="v0.4.0",
            include_preview=True,
            release_fetcher=lambda: [
                {
                    "tag_name": "v0.5.0-preview.1",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.1",
                    "prerelease": True,
                },
                {
                    "tag_name": "v0.4.0",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.0",
                },
            ],
        )

        self.assertEqual(result["latest_version"], "v0.5.0-preview.1")
        self.assertTrue(result["update_available"])
        self.assertTrue(result["include_preview"])

    def test_preview_current_updates_to_newer_preview(self):
        result = check_for_update(
            current_version="v0.5.0-preview.1",
            include_preview=True,
            release_fetcher=lambda: [
                {
                    "tag_name": "v0.5.0-preview.2",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.2",
                    "prerelease": True,
                },
                {
                    "tag_name": "v0.4.0",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.0",
                },
            ],
        )

        self.assertEqual(result["latest_version"], "v0.5.0-preview.2")
        self.assertTrue(result["update_available"])
        self.assertIn("预览版", result["message"])

    def test_preview_current_updates_to_stable_release(self):
        result = check_for_update(
            current_version="v0.5.0-preview.2",
            include_preview=True,
            release_fetcher=lambda: [
                {
                    "tag_name": "v0.5.0",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0",
                },
                {
                    "tag_name": "v0.5.0-preview.2",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.2",
                    "prerelease": True,
                },
            ],
        )

        self.assertEqual(result["latest_version"], "v0.5.0")
        self.assertTrue(result["update_available"])
        self.assertIn("正式版", result["message"])

    def test_preview_current_updates_to_newer_stable_minor(self):
        result = check_for_update(
            current_version="v0.5.0-preview.2",
            include_preview=True,
            release_fetcher=lambda: [
                {
                    "tag_name": "v0.5.1",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.1",
                },
                {
                    "tag_name": "v0.5.0-preview.2",
                    "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.5.0-preview.2",
                    "prerelease": True,
                },
            ],
        )

        self.assertEqual(result["latest_version"], "v0.5.1")
        self.assertTrue(result["update_available"])

    def test_select_update_asset_prefers_windows_x64(self):
        release = {
            "assets": [
                {"name": "bilikara-v1.0.0-windows-arm64.zip", "browser_download_url": "https://example.test/win-arm64.zip"},
                {"name": "bilikara-v1.0.0-windows-x64.zip", "browser_download_url": "https://example.test/win-x64.zip"},
                {"name": "bilikara-v1.0.0-macos-arm64.zip", "browser_download_url": "https://example.test/macos.zip"},
            ]
        }

        asset = select_update_asset(release, target={"platform": "windows", "arch": "x64"})

        self.assertIsNotNone(asset)
        self.assertEqual(asset["name"], "bilikara-v1.0.0-windows-x64.zip")

    def test_select_update_asset_prefers_windows_arm64(self):
        release = {
            "assets": [
                {"name": "bilikara-v1.0.0-windows-x64.zip", "browser_download_url": "https://example.test/win-x64.zip"},
                {"name": "bilikara-v1.0.0-windows-arm64.zip", "browser_download_url": "https://example.test/win-arm64.zip"},
            ]
        }

        asset = select_update_asset(release, target={"platform": "windows", "arch": "arm64"})

        self.assertIsNotNone(asset)
        self.assertEqual(asset["name"], "bilikara-v1.0.0-windows-arm64.zip")

    def test_select_update_asset_accepts_macos_universal(self):
        release = {
            "assets": [
                {"name": "bilikara-v1.0.0-windows-x64.zip", "browser_download_url": "https://example.test/win.zip"},
                {"name": "bilikara-v1.0.0-macos-universal.zip", "browser_download_url": "https://example.test/mac.zip"},
            ]
        }

        asset = select_update_asset(release, target={"platform": "macos", "arch": "arm64"})

        self.assertIsNotNone(asset)
        self.assertEqual(asset["name"], "bilikara-v1.0.0-macos-universal.zip")

    def test_select_update_asset_requires_windows_arm64_asset_for_windows_arm64(self):
        release = {
            "assets": [
                {"name": "bilikara-v1.0.0-windows.zip", "browser_download_url": "https://example.test/win.zip"},
            ]
        }

        self.assertIsNone(select_update_asset(release, target={"platform": "windows", "arch": "arm64"}))

    def test_select_update_asset_returns_none_for_linux(self):
        release = {
            "assets": [
                {"name": "bilikara-v1.0.0-linux-x64.zip", "browser_download_url": "https://example.test/linux.zip"},
            ]
        }

        self.assertIsNone(select_update_asset(release, target={"platform": "linux", "arch": "x64"}))

    def test_auto_update_support_requires_packaged_windows_or_macos(self):
        self.assertTrue(is_auto_update_supported(target={"platform": "windows", "arch": "x64"}, frozen=True))
        self.assertTrue(is_auto_update_supported(target={"platform": "macos", "arch": "arm64"}, frozen=True))
        self.assertFalse(is_auto_update_supported(target={"platform": "windows", "arch": "x64"}, frozen=False))
        self.assertFalse(is_auto_update_supported(target={"platform": "linux", "arch": "x64"}, frozen=True))


    def test_restart_launch_executable_uses_tauri_entry(self):
        with patch.dict(
            os.environ,
            {
                "BILIKARA_LAUNCH_MODE": "tauri",
                "BILIKARA_DESKTOP_EXECUTABLE": r"C:\bilikara\bilikara-desktop.exe",
                "BILIKARA_DESKTOP_PID": "1234",
            },
        ):
            self.assertEqual(
                updater._restart_launch_executable_name(Path(r"C:\bilikara\bilikara.exe")),
                "bilikara-desktop.exe",
            )
            self.assertEqual(updater._restart_wait_pids(42), [42, 1234])

    def test_windows_restart_script_waits_for_shell_and_launches_selected_entry(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "apply.cmd"
            updater._write_windows_restart_script(
                script_path,
                source_root=Path(r"C:\update\bilikara"),
                destination_root=Path(r"C:\bilikara"),
                executable_name="bilikara.exe",
                launch_executable_name="bilikara-desktop.exe",
                wait_pids=[111, 222],
            )

            script = script_path.read_text(encoding="utf-8")

        self.assertIn('set "PIDS=111 222"', script)
        self.assertIn('set "EXE=bilikara-desktop.exe"', script)
        self.assertIn('for %%I in (%PIDS%) do call :waitpid %%I', script)
        self.assertIn('/XD runtime data updates __pycache__', script)
        self.assertIn(r'start "" "%DST%\%EXE%"', script)

    def test_app_update_manager_reports_unsupported_platform_without_downloading(self):
        calls: list[str] = []

        def release_checker(**kwargs):
            calls.append("check")
            return {
                "current_version": "v0.1.0",
                "latest_version": "v0.2.0",
                "release_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.2.0",
                "update_available": True,
                "update_asset": {
                    "name": "bilikara-v0.2.0-linux-x64.zip",
                    "browser_download_url": "https://example.test/linux.zip",
                },
            }

        def downloader(*args, **kwargs):
            raise AssertionError("unsupported platforms should not download")

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = AppUpdateManager(
                app_home=Path(tmpdir),
                current_version="v0.1.0",
                release_checker=release_checker,
                downloader=downloader,
                target={"platform": "linux", "arch": "x64"},
                frozen=True,
            )
            manager.start()
            manager._thread.join(timeout=1.0)

        snapshot = manager.snapshot()
        self.assertEqual(calls, ["check"])
        self.assertEqual(snapshot["state"], "unsupported")
        self.assertIn("暂不支持", snapshot["message"])


if __name__ == "__main__":
    unittest.main()
