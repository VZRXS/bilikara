import json
import shutil
import subprocess
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"


class AndroidAlphaBootstrapTest(unittest.TestCase):
    def test_android_links_runtime_without_desktop_launcher(self):
        cargo = tomllib.loads((TAURI / "Cargo.toml").read_text(encoding="utf-8"))
        dependencies = cargo["target"]['cfg(target_os = "android")']["dependencies"]
        self.assertEqual(dependencies["bilikara_runtime"]["path"], "../rust-runtime")
        self.assertNotIn("tauri-plugin-dialog", cargo["dependencies"])
        self.assertNotIn("tauri-plugin-clipboard-manager", cargo["dependencies"])
        # Retain the existing desktop feature. It is inert on non-macOS targets,
        # and keeping it aligned with the shared config avoids CLI manifest churn.
        self.assertIn("macos-private-api", cargo["dependencies"]["tauri"]["features"])
        entry = (TAURI / "src/lib.rs").read_text(encoding="utf-8")
        self.assertIn("#[cfg_attr(mobile, tauri::mobile_entry_point)]", entry)
        self.assertIn('#[cfg(target_os = "android")]\nmod android;', entry)
        source = (TAURI / "src/android.rs").read_text(encoding="utf-8")
        self.assertIn("initialize_app_state_once(AppStateSeed", source)
        self.assertIn("app.path().app_data_dir()", source)
        self.assertIn("execute_app_state(AppStateRequest::Snapshot", source)
        for forbidden in ("Command::new", "backend_process::", "execute_app_state_json", "CString"):
            self.assertNotIn(forbidden, source)
        for capability in ("host_api_ready", "persistence_ready", "playback_ready"):
            self.assertIn(f"{capability}: false", source)

    def test_bootstrap_ipc_is_local_read_only_and_mobile_scoped(self):
        for name in ("main", "controller"):
            desktop = json.loads((TAURI / f"capabilities/{name}.json").read_text(encoding="utf-8"))
            self.assertEqual(set(desktop["platforms"]), {"windows", "linux", "macOS"})
        capability = json.loads((TAURI / "capabilities/android-alpha.json").read_text(encoding="utf-8"))
        self.assertEqual(capability["platforms"], ["android"])
        self.assertEqual(capability["windows"], ["main"])
        self.assertEqual(capability["permissions"], ["allow-android-alpha-status"])
        self.assertTrue(capability["local"])
        self.assertNotIn("remote", capability)
        config = json.loads((TAURI / "tauri.android.conf.json").read_text(encoding="utf-8"))
        self.assertIsNone(config["build"]["devUrl"])
        self.assertEqual(config["app"]["security"]["capabilities"], ["android-alpha"])
        self.assertIn("default-src 'self'", config["app"]["security"]["csp"])
        self.assertEqual(config["app"]["windows"][0]["url"], "android-alpha.html")
        self.assertTrue(config["app"]["windows"][0]["visible"])

    def test_android_uses_same_version_and_does_not_expose_a_host_service_yet(self):
        config = json.loads((TAURI / "tauri.android.conf.json").read_text(encoding="utf-8"))
        self.assertNotIn("version", config)
        self.assertEqual(config["bundle"]["android"]["debugApplicationIdSuffix"], ".alpha")
        gradle = (TAURI / "gen/android/app/build.gradle.kts").read_text(encoding="utf-8")
        self.assertIn('applicationIdSuffix = ".alpha"', gradle)
        manifest = (TAURI / "gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertNotIn("FOREGROUND_SERVICE", manifest)
        self.assertNotIn("REQUEST_INSTALL_PACKAGES", manifest)
        self.assertNotIn('android:usesCleartextTraffic="true"', manifest)
        activity = (TAURI / "gen/android/app/src/main/java/com/bilikara/app/MainActivity.kt").read_text(encoding="utf-8")
        self.assertIn("FLAG_KEEP_SCREEN_ON", activity)
        self.assertNotIn("PARTIAL_WAKE_LOCK", activity)

    def test_bootstrap_page_reports_native_success_failure_and_wrong_schema(self):
        node = shutil.which("node")
        if not node:
            self.fail("Node.js is required to validate the Android bootstrap page")
        program = r'''
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/android-alpha.js", "utf8");
const valid = {schema_version: 1, stage: "native-bootstrap", backend: "rust", revision: 0,
  host_api_ready: false, persistence_ready: false, playback_ready: false};
async function render(invoke) {
  const nodes = {"bootstrap-status": {textContent: ""}, "bootstrap-details": {hidden: true}};
  const context = {window: invoke ? {__TAURI__: {core: {invoke}}} : {},
    document: {getElementById: id => nodes[id]}};
  await vm.runInNewContext(source, context);
  return nodes;
}
(async () => {
  let calls = 0;
  const success = await render(async name => { calls++; assert.equal(name, "android_alpha_status"); return valid; });
  assert.equal(calls, 1);
  assert.equal(success["bootstrap-details"].hidden, false);
  assert.match(success["bootstrap-status"].textContent, /完整 Host 功能尚未接入/);
  for (const invoke of [null, async () => {throw new Error("native failure");},
    async () => ({...valid, backend: "python"}), async () => ({...valid, revision: NaN}),
    async () => ({...valid, schema_version: 2}), async () => ({...valid, host_api_ready: true})]) {
    const failed = await render(invoke);
    assert.match(failed["bootstrap-status"].textContent, /启动检查失败/);
    assert.equal(failed["bootstrap-details"].hidden, true);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
'''
        result = subprocess.run([node, "-e", program], cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
