from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AppUpdateFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.i18n = (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        cls.node = shutil.which("node")

    def run_node(self, script: str) -> dict:
        if not self.node:
            self.skipTest("node is unavailable")
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def source_slice(self, start: str, end: str) -> str:
        start_index = self.source.index(start)
        return self.source[start_index : self.source.index(end, start_index)]

    def test_update_preferences_and_service_health_ring_markup(self):
        self.assertIn('updateAutomatic: "bilikara.update.automatic"', self.source)
        self.assertIn("updateAutomaticEnabled: true", self.source)
        self.assertIn('id="update-automatic-checkbox"', self.html)
        self.assertIn('id="service-update-indicator"', self.html)
        self.assertIn('id="advanced-update-indicator"', self.html)
        self.assertIn('id="update-version-badge"', self.html)
        self.assertIn('id="app-update-status"', self.html)
        self.assertIn('class="service-status-ring"', self.html)
        self.assertIn('class="cache-preview-field cache-update-upper-field"', self.html)
        self.assertLess(
            self.html.index('for="update-preview-checkbox"'),
            self.html.index('for="update-automatic-checkbox"'),
        )
        self.assertIn(".service-status-ring.has-update", self.css)
        self.assertIn(".app-update-indicator", self.css)
        self.assertIn(".bbdown-login-qr .bbdown-login-message", self.css)
        self.assertIn('"service.autoCheckUpdates"', self.i18n)
        self.assertIn('"service.update"', self.i18n)

    def test_startup_and_manual_paths_use_check_only_without_installing(self):
        self.assertIn('apiPost("/api/app/update/check"', self.source)
        self.assertIn("function scheduleStartupAppUpdateCheck", self.source)
        self.assertIn("state.updateAutomaticAttemptedChannels", self.source)
        self.assertIn("scheduleStartupAppUpdateCheck();", self.source)
        self.assertIn('apiPost("/api/app/update/install"', self.source)
        check_source = self.source[
            self.source.index("async function requestAppUpdateCheck") :
            self.source.index("async function installAppUpdate")
        ]
        self.assertNotIn("/api/app/update/install", check_source)
        self.assertNotIn("setInterval", check_source)

    def test_known_results_render_explicit_actions_and_current_channel_badges(self):
        self.assertIn("function isEligibleCurrentChannelUpdate", self.source)
        self.assertIn("function shouldPresentCurrentChannelUpdate", self.source)
        self.assertNotIn('t("service.updateToVersion"', self.source)
        self.assertNotIn('"service.updateToVersion"', self.i18n)
        self.assertIn('t("service.update")', self.source)
        self.assertIn('t("service.viewVersion"', self.source)
        self.assertIn('t("service.newVersionBadge"', self.source)
        self.assertIn("update.include_preview === state.updatePreviewEnabled", self.source)
        self.assertIn("openExternalUrl", self.source)

    def test_preference_defaults_and_startup_check_are_executable_and_bounded(self):
        hydrate_source = self.source_slice(
            "function hydrateLocalPreferences", "function renderHostWorkspaceSelection"
        )
        operation_source = self.source_slice(
            "async function requestAppUpdateCheck", "async function addSessionUser"
        )
        script = f"""
const stored = new Map();
const storageKeys = {{
  playerVolume: "volume", playerMuted: "muted",
  updateAutomatic: "automatic", updatePreview: "preview", theme: "theme",
}};
const state = {{
  localPlayerVolume: 1, localPlayerMuted: false, theme: "light",
  updateAutomaticEnabled: true, updatePreviewEnabled: false,
  updateAutomaticAttemptedChannels: new Set(), startupUpdateCheckScheduled: false,
  updateCheckRequestInFlight: false, manualUpdateCheck: null,
  updateManualVisibleChannel: "",
  hasValidStateResponse: true, data: {{ app_update: {{ state: "idle", updated_at: 1, include_preview: false }} }},
}};
const elements = {{ updateCheckButton: null, cacheSettings: null }};
const posts = [];
const messages = [];
function readLocalNumber(key, fallback) {{ return stored.has(key) ? Number(stored.get(key)) : fallback; }}
function readLocalBoolean(key, fallback) {{ return stored.has(key) ? stored.get(key) === "true" : fallback; }}
function readLocalString(key, fallback) {{ return stored.has(key) ? stored.get(key) : fallback; }}
function normalizeTheme(value) {{ return value === "dark" ? "dark" : "light"; }}
function applyTheme(value) {{ state.theme = value; }}
function appUpdateStatus() {{ return state.data.app_update; }}
function isAppUpdateBusy(update = appUpdateStatus()) {{ return ["checking", "downloading", "installing", "restarting"].includes(update.state); }}
function isEligibleCurrentChannelUpdate() {{ return false; }}
function renderUpdatePreviewControl() {{}}
function closeConfirm() {{}}
function safeHttpUrl(value) {{ return value; }}
function openExternalUrl() {{}}
function anchorPointForEvent() {{ return {{ x: 0, y: 0 }}; }}
function openConfirm() {{}}
function setAppMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function t(key) {{ return key; }}
const appUpdateCheckTimeoutMs = 10000;
async function apiPost(path, payload) {{ posts.push({{ path, payload }}); return {{ state: "checking" }}; }}
{hydrate_source}
{operation_source}

(async () => {{
  hydrateLocalPreferences();
  const defaults = {{ automatic: state.updateAutomaticEnabled, preview: state.updatePreviewEnabled }};
  scheduleStartupAppUpdateCheck();
  await Promise.resolve();
  scheduleStartupAppUpdateCheck();
  await requestAppUpdateCheck({{ automatic: true }});
  const enabledPosts = posts.splice(0);

  state.updateAutomaticEnabled = true;
  state.updatePreviewEnabled = false;
  stored.set("automatic", "false");
  stored.set("preview", "true");
  hydrateLocalPreferences();
  const persisted = {{ automatic: state.updateAutomaticEnabled, preview: state.updatePreviewEnabled }};
  state.startupUpdateCheckScheduled = false;
  scheduleStartupAppUpdateCheck();
  await Promise.resolve();

  process.stdout.write(JSON.stringify({{ defaults, persisted, enabledPosts, disabledPostCount: posts.length, messages }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
"""
        result = self.run_node(script)
        self.assertEqual(result["defaults"], {"automatic": True, "preview": False})
        self.assertEqual(result["persisted"], {"automatic": False, "preview": True})
        self.assertEqual(
            result["enabledPosts"],
            [{"path": "/api/app/update/check", "payload": {"include_preview": False}}],
        )
        self.assertEqual(result["disabledPostCount"], 0)
        self.assertEqual(result["messages"], [])

    def test_host_basic_full_preference_is_retired_without_a_hidden_toggle(self):
        self.assertNotIn('layoutMode: "bilikara.layout.mode"', self.source)
        self.assertNotIn("function normalizeLayoutMode", self.source)
        self.assertNotIn("function renderLayoutMode", self.source)
        self.assertNotIn("function setLayoutMode", self.source)
        self.assertNotIn('id="layout-mode-switch"', self.html)
        self.assertNotIn('id="display-layout-summary"', self.html)
        self.assertNotIn(".app-shell.layout-mode-basic", self.css)
        self.assertNotIn(".app-shell.layout-mode-full", self.css)
        self.assertEqual(self.source.count('removeItem("bilikara.layout.mode")'), 1)

    def test_indicator_rendering_and_manual_actions_are_executable(self):
        render_source = self.source_slice(
            "function appUpdateStatus", "function renderPlaybackRepairControls"
        )
        operation_source = self.source_slice(
            "async function requestAppUpdateCheck", "async function addSessionUser"
        )
        script = f"""
class FakeClassList {{
  constructor() {{ this.values = new Set(); }}
  toggle(name, force) {{ if (force) this.values.add(name); else this.values.delete(name); }}
  contains(name) {{ return this.values.has(name); }}
}}
class FakeElement {{
  constructor() {{ this.classList = new FakeClassList(); this.attributes = {{}}; this.textContent = ""; this.disabled = false; this.checked = false; this.id = ""; }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  removeAttribute(name) {{ delete this.attributes[name]; }}
}}
function element(id = "") {{ const value = new FakeElement(); value.id = id; return value; }}
const elements = {{
  updateAutomaticCheckbox: element(), updatePreviewCheckbox: element(),
  updateCheckButton: element("update-check-button"), serviceUpdateIndicator: element(),
  advancedUpdateIndicator: element(), appUpdateRow: element(), appUpdateStatus: element(),
  updateVersionBadge: element(), cacheSettings: element(),
}};
const state = {{
  data: {{ app_update: {{ state: "idle", include_preview: false, updated_at: 1 }} }},
  updateAutomaticEnabled: true, updatePreviewEnabled: false,
  updateCheckRequestInFlight: false, manualUpdateCheck: null,
  updateManualVisibleChannel: "",
  updateAutomaticAttemptedChannels: new Set(), startupUpdateCheckScheduled: true,
  hasValidStateResponse: true,
}};
const posts = [];
const confirms = [];
const opened = [];
const messages = [];
function t(key, values = {{}}) {{ return `${{key}}:${{values.version || ""}}`; }}
function setClassToggle(element, name, force) {{ element?.classList.toggle(name, force); }}
function setTextContent(element, value) {{ if (element) element.textContent = String(value); }}
function setElementTitle(element, value) {{ if (element) element.attributes.title = String(value); }}
function setAppMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function anchorPointForEvent() {{ return {{ x: 1, y: 2 }}; }}
function openConfirm(value) {{ confirms.push(value); }}
function closeConfirm() {{}}
function safeHttpUrl(value) {{ return String(value || ""); }}
function openExternalUrl(value) {{ opened.push(value); }}
const appUpdateCheckTimeoutMs = 10000;
async function apiPost(path, payload) {{ posts.push({{ path, payload }}); return {{ state: "checking" }}; }}
{render_source}
{operation_source}
function indicatorState() {{
  return {{
    service: elements.serviceUpdateIndicator.classList.contains("has-update"),
    advanced: !elements.advancedUpdateIndicator.classList.contains("hidden"),
    row: elements.appUpdateRow.classList.contains("has-update"),
    badge: !elements.updateVersionBadge.classList.contains("hidden"),
    button: elements.updateCheckButton.textContent,
    status: elements.appUpdateStatus.textContent,
  }};
}}

(async () => {{
  const states = {{}};
  for (const [name, update] of Object.entries({{
    unknown: {{ state: "idle", include_preview: false, updated_at: 2 }},
    checking: {{ state: "checking", include_preview: false, updated_at: 3 }},
    current: {{ state: "idle", include_preview: false, updated_at: 4, update_action: "no_action", message: "current" }},
    failed: {{ state: "failed", operation: "check", include_preview: false, updated_at: 5, error: "offline" }},
    installable: {{ state: "available", include_preview: false, updated_at: 6, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.1", auto_update_supported: true, release_url: "https://example.test/v0.8.1" }},
    viewOnly: {{ state: "available", include_preview: false, updated_at: 7, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.2", auto_update_supported: false, release_url: "https://example.test/v0.8.2" }},
    stalePreview: {{ state: "available", include_preview: true, updated_at: 8, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.9.0-preview.1", auto_update_supported: true }},
  }})) {{
    state.data.app_update = update;
    renderUpdatePreviewControl();
    states[name] = indicatorState();
  }}
  state.updateAutomaticEnabled = false;
  state.updateManualVisibleChannel = "";
  state.data.app_update = {{ state: "available", include_preview: false, updated_at: 8.5, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.3", auto_update_supported: true }};
  renderUpdatePreviewControl();
  states.automaticOff = indicatorState();
  state.updateManualVisibleChannel = "stable";
  renderUpdatePreviewControl();
  states.manualVisible = indicatorState();
  state.updateAutomaticEnabled = true;
  state.updateManualVisibleChannel = "";
  const messagesBeforeActions = messages.length;

  state.data.app_update = {{ state: "idle", include_preview: false, updated_at: 9 }};
  await checkAppUpdate({{}});
  state.data.app_update = {{ state: "available", include_preview: false, updated_at: 10, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.1", auto_update_supported: true, release_url: "https://example.test/v0.8.1" }};
  await checkAppUpdate({{}});
  await installAppUpdate(false);
  state.data.app_update = {{ state: "available", include_preview: false, updated_at: 11, update_action: "normal_upgrade", eligible_update: true, latest_version: "v0.8.2", auto_update_supported: false, release_url: "https://example.test/v0.8.2" }};
  await checkAppUpdate({{}});
  state.updatePreviewEnabled = true;
  await checkAppUpdate({{}});

  process.stdout.write(JSON.stringify({{ states, posts, confirms, opened, messages, messagesBeforeActions }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
"""
        result = self.run_node(script)
        for name in ("unknown", "checking", "current", "failed", "stalePreview"):
            with self.subTest(name=name):
                self.assertFalse(result["states"][name]["service"])
                self.assertFalse(result["states"][name]["advanced"])
                self.assertFalse(result["states"][name]["row"])
                self.assertFalse(result["states"][name]["badge"])
        for name in ("installable", "viewOnly"):
            with self.subTest(name=name):
                self.assertTrue(result["states"][name]["service"])
                self.assertTrue(result["states"][name]["advanced"])
                self.assertTrue(result["states"][name]["row"])
                self.assertTrue(result["states"][name]["badge"])
        self.assertEqual(result["states"]["installable"]["button"], "service.update:")
        self.assertEqual(result["states"]["installable"]["status"], "")
        self.assertEqual(result["states"]["viewOnly"]["button"], "service.viewVersion:v0.8.2")
        self.assertFalse(result["states"]["automaticOff"]["service"])
        self.assertFalse(result["states"]["automaticOff"]["badge"])
        self.assertEqual(result["states"]["automaticOff"]["button"], "service.checkUpdate:")
        self.assertTrue(result["states"]["manualVisible"]["service"])
        self.assertEqual(result["states"]["manualVisible"]["status"], "")
        self.assertEqual(result["messagesBeforeActions"], 0)
        self.assertEqual([post["path"] for post in result["posts"]], [
            "/api/app/update/check",
            "/api/app/update/install",
            "/api/app/update/check",
        ])
        self.assertEqual(len(result["confirms"]), 1)
        self.assertEqual(result["confirms"][0]["type"], "install-app-update")
        self.assertEqual(result["opened"], ["https://example.test/v0.8.2"])


if __name__ == "__main__":
    unittest.main()
