import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from bilikara import playback_selector, rust_backend, updater


def release(tag: str, *, draft: bool = False, with_asset: bool = True) -> dict:
    payload = {
        "tag_name": tag,
        "draft": draft,
        "prerelease": "preview" in tag.lower(),
        "html_url": f"https://example.test/releases/{tag}",
    }
    if with_asset:
        payload["assets"] = [
            {
                "name": f"bilikara-{tag}-windows-x64.zip",
                "browser_download_url": f"https://example.test/{tag}.zip",
                "size": 128,
                "content_type": "application/zip",
            }
        ]
    return payload


DECISION_CASES = (
    {
        "name": "stable normal update",
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
        "name": "stable to preview with preview enabled",
        "current": "v0.6.4",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.1")],
        "latest": "v0.7.0-preview.1",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "preview to newer preview",
        "current": "v0.7.0-preview.1",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.2")],
        "latest": "v0.7.0-preview.2",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "current preview with no newer preview",
        "current": "v0.7.0-preview.3",
        "include_preview": True,
        "releases": [release("v0.7.0-preview.3"), release("v0.6.4")],
        "latest": "v0.7.0-preview.3",
        "action": "no_action",
        "reason": "already_current",
    },
    {
        "name": "preview to numerically lower stable when preview disabled",
        "current": "v0.7.0-preview.3",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "preview_to_stable",
        "reason": "preview_channel_disabled",
    },
    {
        "name": "preview to final stable",
        "current": "v0.7.0-preview.3",
        "include_preview": False,
        "releases": [release("v0.7.0")],
        "latest": "v0.7.0",
        "action": "normal_upgrade",
        "reason": "newer_version",
    },
    {
        "name": "dev to stable",
        "current": "v0.7.0-12-gabcdef",
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
    {
        "name": "draft ignored",
        "current": "v0.7.0",
        "include_preview": False,
        "releases": [release("v0.8.0", draft=True), release("v0.7.0")],
        "latest": "v0.7.0",
        "action": "no_action",
        "reason": "already_current",
    },
    {
        "name": "malformed version ignored",
        "current": "v0.7.0",
        "include_preview": False,
        "releases": [release("not-a-version"), release("v0.7.0")],
        "latest": "v0.7.0",
        "action": "no_action",
        "reason": "already_current",
    },
    {
        "name": "no stable available",
        "current": "v0.7.0-preview.3",
        "include_preview": False,
        "releases": [release("v0.8.0-preview.1")],
        "latest": "",
        "action": "no_action",
        "reason": "no_stable_release",
    },
    {
        "name": "missing asset",
        "current": "v0.6.3",
        "include_preview": False,
        "releases": [release("v0.6.4", with_asset=False)],
        "latest": "v0.6.4",
        "action": "normal_upgrade",
        "reason": "newer_version",
        "auto_update_supported": False,
    },
    {
        "name": "unsupported platform",
        "current": "v0.6.3",
        "include_preview": False,
        "releases": [release("v0.6.4")],
        "latest": "v0.6.4",
        "action": "normal_upgrade",
        "reason": "newer_version",
        "unsupported_platform": True,
        "auto_update_supported": False,
    },
)


class UpdateChannelDecisionTest(unittest.TestCase):
    def test_python_reference_decision_matrix(self):
        for case in DECISION_CASES:
            with self.subTest(case=case["name"]):
                decision = updater._py_release_decision_for_current(
                    case["current"],
                    case["releases"],
                    include_preview=case["include_preview"],
                )
                self.assertEqual(decision["action"], case["action"])
                self.assertEqual(decision["reason"], case["reason"])
                self.assertEqual(
                    updater.normalize_version_tag(decision["release"].get("tag_name")),
                    case["latest"],
                )

    def test_native_rust_decision_matrix(self):
        status = rust_backend.backend_status()
        if not status["capabilities"].get("select_release"):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail("native Rust release selection is required but unavailable")
            self.skipTest("native Rust release selection is unavailable")

        for case in DECISION_CASES:
            with self.subTest(case=case["name"]):
                request = {
                    "schema_version": 1,
                    "current_version": case["current"],
                    "include_preview": case["include_preview"],
                    "releases": [
                        {
                            "tag_name": str(item.get("tag_name") or ""),
                            "draft": bool(item.get("draft")),
                            "prerelease": bool(item.get("prerelease")),
                        }
                        for item in case["releases"]
                    ],
                }
                completed, decision = rust_backend.try_select_release(request)
                self.assertTrue(completed)
                self.assertIsNotNone(decision)
                assert decision is not None
                self.assertEqual(decision["action"], case["action"])
                self.assertEqual(decision["reason"], case["reason"])

    def test_native_response_cannot_authorize_a_stable_downgrade(self):
        request = {
            "schema_version": 1,
            "current_version": "v0.7.0",
            "include_preview": False,
            "releases": [
                {"tag_name": "v0.6.4", "draft": False, "prerelease": False}
            ],
        }
        forged_response = {
            "schema_version": 1,
            "status": "selected",
            "selected_index": 0,
            "action": "normal_upgrade",
            "reason": "newer_version",
        }
        with patch.object(
            rust_backend,
            "_call_json_capability",
            return_value=forged_response,
        ):
            completed, decision = rust_backend.try_select_release(request)

        self.assertFalse(completed)
        self.assertIsNone(decision)

    def test_update_check_response_matrix(self):
        for case in DECISION_CASES:
            with self.subTest(case=case["name"]), patch.object(
                rust_backend, "try_select_release", return_value=(False, None)
            ):
                target = (
                    {"platform": "linux", "arch": "x64"}
                    if case.get("unsupported_platform")
                    else {"platform": "windows", "arch": "x64"}
                )
                with patch.object(updater, "detect_update_target", return_value=target), patch.object(
                    updater,
                    "is_auto_update_supported",
                    return_value=not case.get("unsupported_platform", False),
                ):
                    result = updater.check_for_update(
                        current_version=case["current"],
                        include_preview=case["include_preview"],
                        release_fetcher=lambda case=case: case["releases"],
                    )

                self.assertEqual(result["latest_version"], case["latest"])
                self.assertEqual(result["update_action"], case["action"])
                self.assertEqual(result["update_reason"], case["reason"])
                installable = case["action"] != "no_action"
                self.assertEqual(result["update_installable"], installable)
                self.assertEqual(
                    result["update_available"],
                    case["action"] == "normal_upgrade",
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
        ), patch.object(
            playback_selector.PlaybackSelector,
            "dispatch",
            side_effect=AssertionError("updater must not consult playback routing"),
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
        script = f"""
(async () => {{
  const state = {{
    updateChecking: false,
    updatePreviewEnabled: false,
    data: {{ app_update: {{ state: "idle" }} }},
  }};
  const elements = {{ updateCheckButton: {{ id: "update-check-button" }}, cacheSettings: {{}} }};
  const window = {{ setTimeout, clearTimeout }};
  const appUpdateCheckTimeoutMs = 1000;
  const confirms = [];
  const messages = [];
  let result = null;
  function isAppUpdateBusy() {{ return false; }}
  function renderUpdatePreviewControl() {{}}
  function anchorPointForEvent() {{ return {{ x: 1, y: 2 }}; }}
  async function apiGet() {{ return result; }}
  function openConfirm(value) {{ confirms.push(value); }}
  function setAppMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
  function t(key) {{ return key; }}
  {function_source}

  result = {{
    update_action: "preview_to_stable",
    update_installable: true,
    switch_to_release_available: true,
    auto_update_supported: true,
    release_url: "https://example.test/v0.6.4",
    message: "switch",
  }};
  await checkAppUpdate({{}});

  result = {{
    update_action: "no_action",
    update_installable: true,
    update_available: true,
    switch_to_release_available: true,
    auto_update_supported: true,
  }};
  await checkAppUpdate({{}});

  console.log(JSON.stringify({{ confirms, messages }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(len(result["confirms"]), 1)
        self.assertEqual(result["confirms"][0]["type"], "install-app-update")
        self.assertFalse(result["confirms"][0]["includePreview"])
        self.assertEqual(result["messages"][-1]["message"], "service.upToDate")


if __name__ == "__main__":
    unittest.main()
