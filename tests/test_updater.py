import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import bilikara.updater as updater
from bilikara.updater import AppUpdateManager, check_for_update, fetch_latest_release, is_auto_update_supported, is_newer_version, select_update_asset, version_tuple


class UpdateCheckTest(unittest.TestCase):
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
