from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from bilikara import updater


def release(
    tag_name: str, draft: bool = False, prerelease: bool = False
) -> dict[str, object]:
    return {
        "tag_name": tag_name,
        "draft": draft,
        "prerelease": prerelease,
        "html_url": f"https://example.test/releases/{tag_name}",
        "name": f"Release {tag_name}",
        "published_at": "2026-08-03T00:00:00Z",
        "assets": [
            {
                "name": f"bilikara-{tag_name}-windows-x64.zip",
                "browser_download_url": f"https://example.test/{tag_name}.zip",
                "size": 1024,
            }
        ],
    }


DECISION_CASES = (
    {
        "name": "stable normal upgrade",
        "current": "v0.6.3",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "stable already current",
        "current": "v0.6.4",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "no_action",
        "reason": "already_current",
    },
    {
        "name": "preview normal upgrade",
        "current": "v0.7.0-preview.1",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.2")],
        "latest": "v0.7.0-preview.2",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "preview upgrades to final stable",
        "current": "v0.7.0-preview.3",
        "include_preview": False,
        "releases": [release("v0.7.0")],
        "latest": "v0.7.0",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "preview channel disabled switches to lower stable",
        "current": "v0.7.0-preview.3",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "preview_to_stable",
        "reason": "preview_channel_disabled",
    },
    {
        "name": "dev to stable default",
        "current": "rebuild/preview3-playback",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "development_to_stable",
        "reason": "development_build",
    },
    {
        "name": "dev to preview with preview enabled",
        "current": "v0.7.0-preview.3-12-gabcdef",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.3")],
        "latest": "v0.7.0-preview.3",
        "action": "development_to_preview",
        "reason": "development_build",
    },
    {
        "name": "dev to preview dirty tag",
        "current": "v0.7.0-preview.3-dirty",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.4")],
        "latest": "v0.7.0-preview.4",
        "action": "development_to_preview",
        "reason": "development_build",
    },
    {
        "name": "dev to preview raw sha tag",
        "current": "abcdef123",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.3")],
        "latest": "v0.7.0-preview.3",
        "action": "development_to_preview",
        "reason": "development_build",
    },
    {
        "name": "dev to stable when latest is stable and preview enabled",
        "current": "v0.7.0-preview.3-12-gabcdef",
        "include_preview": True,
        "releases": [release("v0.7.0")],
        "latest": "v0.7.0",
        "action": "development_to_stable",
        "reason": "development_build",
    },
    {
        "name": "dev preview off preview only releases",
        "current": "v0.7.0-preview.3-12-gabcdef",
        "include_preview": False,
        "releases": [release("v0.7.0-preview.3")],
        "latest": "",
        "action": "no_action",
        "reason": "no_stable_release",
    },
    {
        "name": "stable must not downgrade",
        "current": "v0.7.0",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "no_action",
        "reason": "stable_not_newer",
    },
)


class UpdateChannelDecisionTest(unittest.TestCase):
    def test_decision_matrix_matches_python_and_rust_backend(self):
        for case in DECISION_CASES:
            with self.subTest(case=case["name"]):
                py_decision = updater._py_release_decision_for_current(
                    case["current"],
                    case["releases"],
                    include_preview=case["include_preview"],
                )
                self.assertEqual(py_decision["action"], case["action"])
                self.assertEqual(py_decision["reason"], case["reason"])
                self.assertEqual(
                    py_decision["release"].get("tag_name", ""),
                    case["latest"],
                )

                rust_decision = updater._release_decision_for_current(
                    case["current"],
                    case["releases"],
                    include_preview=case["include_preview"],
                )
                self.assertEqual(rust_decision["action"], case["action"])
                self.assertEqual(rust_decision["reason"], case["reason"])
                self.assertEqual(
                    rust_decision["release"].get("tag_name", ""),
                    case["latest"],
                )

                with patch.object(
                    updater, "detect_update_target", return_value={"platform": "windows", "arch": "x64"}
                ), patch.object(
                    updater, "is_auto_update_supported", return_value=True
                ):
                    result = updater.check_for_update(
                        current_version=case["current"],
                        include_preview=case["include_preview"],
                        release_fetcher=lambda case=case: case["releases"],
                    )
                self.assertEqual(result["update_action"], case["action"])
                self.assertEqual(result["update_reason"], case["reason"])
                self.assertEqual(result["latest_version"], case["latest"])
                self.assertEqual(result["current_version"], case["current"])

                installable = case["action"] in {
                    "normal_upgrade",
                    "preview_to_stable",
                    "development_to_stable",
                    "development_to_preview",
                }
                self.assertEqual(result["update_installable"], installable)
                self.assertEqual(
                    result["update_available"], case["action"] == "normal_upgrade"
                )
                self.assertEqual(
                    result["switch_to_release_available"],
                    case["action"] in {"preview_to_stable", "development_to_stable", "development_to_preview"},
                )
                expected_auto = case.get("auto_update_supported", installable)
                self.assertEqual(result["auto_update_supported"], expected_auto)

    def test_preview_to_lower_stable_has_intentional_user_message(self):
        with patch.object(
            updater,
            "is_newer_version",
            side_effect=AssertionError("channel switches must not use is_newer_version"),
        ):
            result = updater.check_for_update(
                current_version="v0.7.0-preview.3",
                include_preview=False,
                release_fetcher=lambda: [release("v0.6.4")],
            )

        self.assertEqual(
            result["message"],
            "当前使用预览版 v0.7.0-preview.3，已关闭预览版更新；可切换到最新正式版 v0.6.4。",
        )

    def test_update_manager_proceeds_for_preview_to_stable_switch(self):
        downloads = []

        def checker(**kwargs):
            return {
                "current_version": "v0.7.0-preview.3",
                "latest_version": "v0.6.4",
                "release_url": "https://example.test/releases/v0.6.4",
                "update_action": "preview_to_stable",
                "update_reason": "preview_channel_disabled",
                "update_installable": True,
                "update_available": False,
                "switch_to_release_available": True,
                "update_asset": {
                    "name": "bilikara-v0.6.4-windows-x64.zip",
                    "browser_download_url": "https://example.test/v0.6.4.zip",
                },
            }

        def downloader(url, destination, **kwargs):
            downloads.append(url)
            with zipfile.ZipFile(destination, "w") as archive:
                archive.writestr("bilikara.exe", b"test executable")
            return destination.stat().st_size, destination.stat().st_size

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = updater.AppUpdateManager(
                app_home=Path(tmpdir),
                current_version="v0.7.0-preview.3",
                release_checker=checker,
                downloader=downloader,
                target={"platform": "windows", "arch": "x64"},
                executable_path=Path(tmpdir) / "current" / "bilikara.exe",
                frozen=True,
            )
            with patch.object(
                manager,
                "_prepare_restart_helper",
                return_value=["cmd", "/c", "apply.cmd"],
            ) as prepare:
                manager.start(restart=False)
                assert manager._thread is not None
                manager._thread.join(timeout=2.0)
                self.assertFalse(manager._thread.is_alive())

            snapshot = manager.snapshot()

        self.assertEqual(downloads, ["https://example.test/v0.6.4.zip"])
        prepare.assert_called_once()
        self.assertEqual(snapshot["state"], "idle")
        self.assertEqual(snapshot["update_action"], "preview_to_stable")
        self.assertEqual(snapshot["update_reason"], "preview_channel_disabled")
        self.assertEqual(snapshot["progress"], 1.0)

    def test_update_manager_rejects_inconsistent_explicit_downgrade(self):
        downloads = []

        def checker(**kwargs):
            return {
                "current_version": "v0.7.0",
                "latest_version": "v0.6.4",
                "release_url": "https://example.test/releases/v0.6.4",
                "update_action": "normal_upgrade",
                "update_reason": "newer_version",
                "update_installable": True,
                "update_available": True,
                "update_asset": {
                    "name": "bilikara-v0.6.4-windows-x64.zip",
                    "browser_download_url": "https://example.test/v0.6.4.zip",
                },
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            manager = updater.AppUpdateManager(
                app_home=Path(tmpdir),
                current_version="v0.7.0",
                release_checker=checker,
                downloader=lambda *args, **kwargs: downloads.append(args[0]),
                target={"platform": "windows", "arch": "x64"},
                frozen=True,
            )
            manager.start(restart=False)
            assert manager._thread is not None
            manager._thread.join(timeout=2.0)
            self.assertFalse(manager._thread.is_alive())

        self.assertEqual(downloads, [])
        self.assertEqual(manager.snapshot()["state"], "idle")

    def test_legacy_switch_allows_preview_to_stable_but_not_stable_downgrade(self):
        legacy_response = {
            "latest_version": "v0.6.4",
            "switch_to_release_available": True,
        }

        self.assertTrue(
            updater._is_update_decision_installable(
                legacy_response,
                current_version="v0.7.0-preview.3",
                include_preview=False,
            )
        )
        self.assertFalse(
            updater._is_update_decision_installable(
                legacy_response,
                current_version="v0.7.0",
                include_preview=False,
            )
        )

    def test_frontend_reaches_install_for_channel_switch_and_fails_closed(self):
        source = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text(
            encoding="utf-8"
        )
        start = source.index("async function checkAppUpdate")
        end = source.index("async function addSessionUser", start)
        function_source = source[start:end]
        helper_start = source.index("function appUpdateStatus")
        helper_end = source.index("function appUpdateProgressPercent", helper_start)
        helper_source = source[helper_start:helper_end]
        script = f"""
(async () => {{
  const state = {{
    updateCheckRequestInFlight: false,
    updatePreviewEnabled: false,
    data: {{ app_update: {{ state: "idle", include_preview: false }} }},
  }};
  const elements = {{ updateCheckButton: {{ id: "update-check-button" }}, cacheSettings: {{}} }};
  const confirms = [];
  let checks = 0;
  function anchorPointForEvent() {{ return {{ x: 1, y: 2 }}; }}
  async function requestAppUpdateCheck() {{ checks += 1; }}
  function openConfirm(value) {{ confirms.push(value); }}
  function safeHttpUrl(value) {{ return value; }}
  function openExternalUrl() {{ throw new Error("unexpected view action"); }}
  function setAppMessage() {{}}
  function t(key) {{ return key; }}
  {helper_source}
  {function_source}

  state.data.app_update = {{
    state: "available",
    include_preview: false,
    update_action: "preview_to_stable",
    update_installable: true,
    switch_to_release_available: true,
    eligible_update: true,
    auto_update_supported: true,
    release_url: "https://example.test/v0.6.4",
    latest_version: "v0.6.4",
    message: "switch",
  }};
  await checkAppUpdate({{}});

  state.data.app_update = {{
    state: "available",
    include_preview: false,
    update_action: "no_action",
    update_installable: true,
    update_available: true,
    switch_to_release_available: true,
    eligible_update: true,
    auto_update_supported: true,
  }};
  await checkAppUpdate({{}});

  console.log(JSON.stringify({{ confirms, checks }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(len(result["confirms"]), 1)
        self.assertEqual(result["confirms"][0]["type"], "install-app-update")
        self.assertFalse(result["confirms"][0]["includePreview"])
        self.assertEqual(result["checks"], 1)


if __name__ == "__main__":
    unittest.main()
