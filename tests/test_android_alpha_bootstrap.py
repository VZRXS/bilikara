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
        self.assertIn("native-host", dependencies["bilikara_runtime"]["features"])
        self.assertNotIn("tauri-plugin-dialog", cargo["dependencies"])
        self.assertNotIn("tauri-plugin-clipboard-manager", cargo["dependencies"])
        # Retain the existing desktop feature. It is inert on non-macOS targets,
        # and keeping it aligned with the shared config avoids CLI manifest churn.
        self.assertIn("macos-private-api", cargo["dependencies"]["tauri"]["features"])
        entry = (TAURI / "src/lib.rs").read_text(encoding="utf-8")
        self.assertIn("#[cfg_attr(mobile, tauri::mobile_entry_point)]", entry)
        self.assertIn('#[cfg(target_os = "android")]\nmod android;', entry)
        source = (TAURI / "src/android.rs").read_text(encoding="utf-8")
        self.assertIn("initialize_native_host(", source)
        self.assertRegex(source, r"app\s*\.path\(\)\s*\.app_data_dir\(\)")
        self.assertIn("execute_app_state(AppStateRequest::Snapshot", source)
        for forbidden in ("Command::new", "backend_process::", "execute_app_state_json", "CString"):
            self.assertNotIn(forbidden, source)
        for capability in ("host_api_ready", "playback_ready"):
            self.assertIn(f"{capability}: true", source)
        self.assertIn("persistence_ready: true", source)
        self.assertIn('stage: "native-host-alpha"', source)
        self.assertIn("if let Some(error) = &bootstrap.error", source)
        self.assertIn("app.asset_resolver()", source)
        self.assertIn("NativeHost::start(", source)
        self.assertIn("app.manage(AndroidBootstrap { host, error });", source)
        self.assertNotIn("std::fs::remove", source)

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

    def test_android_scopes_cleartext_to_loopback_and_keeps_foreground_only(self):
        config = json.loads((TAURI / "tauri.android.conf.json").read_text(encoding="utf-8"))
        self.assertNotIn("version", config)
        self.assertEqual(config["bundle"]["android"]["debugApplicationIdSuffix"], ".alpha")
        gradle = (TAURI / "gen/android/app/build.gradle.kts").read_text(encoding="utf-8")
        self.assertIn('applicationIdSuffix = ".alpha"', gradle)
        build = (TAURI / "build.rs").read_text(encoding="utf-8")
        self.assertIn('std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")', build)
        self.assertIn("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384", build)
        self.assertIn("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384", build)
        manifest = (TAURI / "gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertNotIn("FOREGROUND_SERVICE", manifest)
        self.assertNotIn("REQUEST_INSTALL_PACKAGES", manifest)
        self.assertNotIn('android:usesCleartextTraffic="true"', manifest)
        self.assertIn('android:allowBackup="false"', manifest)
        self.assertIn('@xml/network_security_config', manifest)
        security = (TAURI / "gen/android/app/src/main/res/xml/network_security_config.xml").read_text(encoding="utf-8")
        self.assertIn('<base-config cleartextTrafficPermitted="false"', security)
        self.assertIn('includeSubdomains="false">127.0.0.1</domain>', security)
        activity = (TAURI / "gen/android/app/src/main/java/com/bilikara/app/MainActivity.kt").read_text(encoding="utf-8")
        self.assertIn("FLAG_KEEP_SCREEN_ON", activity)
        self.assertNotIn("PARTIAL_WAKE_LOCK", activity)

    def test_native_window_owns_insets_for_bootstrap_and_host(self):
        activity = (TAURI / "gen/android/app/src/main/java/com/bilikara/app/MainActivity.kt").read_text(encoding="utf-8")
        self.assertIn("HostWindowInsets.install(findViewById(android.R.id.content))", activity)
        manifest = (TAURI / "gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertIn('android:windowSoftInputMode="adjustResize"', manifest)
        source = (TAURI / "gen/android/app/src/main/java/com/bilikara/app/HostWindowInsets.kt").read_text(encoding="utf-8")
        for kind in ("systemBars", "displayCutout", "ime"):
            self.assertIn(f"WindowInsetsCompat.Type.{kind}()", source)
        self.assertIn(".setInsets(handled, Insets.NONE)", source)
        self.assertIn("ViewCompat.requestApplyInsets(content)", source)

    def test_bootstrap_page_reports_native_success_failure_and_wrong_schema(self):
        node = shutil.which("node")
        if not node:
            self.fail("Node.js is required to validate the Android bootstrap page")
        program = r'''
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/android-alpha.js", "utf8");
const valid = {schema_version: 3, stage: "native-host-alpha", backend: "rust", revision: 0,
  host_api_ready: true, persistence_ready: true, playback_ready: true,
  bootstrap_url: "http://127.0.0.1:12345/bootstrap/" + "a".repeat(43)};
async function render(invoke) {
  const nodes = {"bootstrap-status": {textContent: ""}, "bootstrap-details": {hidden: true}};
  let destination = null;
  const context = {URL, window: {location: {replace: url => {destination = url;}},
    ...(invoke ? {__TAURI__: {core: {invoke}}} : {})},
    document: {getElementById: id => nodes[id]}};
  await vm.runInNewContext(source, context);
  return {...nodes, destination};
}
(async () => {
  let calls = 0;
  const success = await render(async name => { calls++; assert.equal(name, "android_alpha_status"); return valid; });
  assert.equal(calls, 1);
  assert.equal(success.destination, valid.bootstrap_url);
  assert.match(success["bootstrap-status"].textContent, /Rust Host 已就绪/);
  assert.ok(!success["bootstrap-status"].textContent.includes("a".repeat(43)));
  for (const invoke of [null, async () => {throw new Error("native failure");},
    async () => ({...valid, backend: "python"}), async () => ({...valid, revision: NaN}),
    async () => ({...valid, schema_version: 1}), async () => ({...valid, persistence_ready: false}),
    async () => ({...valid, stage: "native-bootstrap"}), async () => ({...valid, host_api_ready: false}),
    ...["https://evil.test/bootstrap/", "http://localhost:12345/bootstrap/", "http://127.0.0.1/bootstrap/",
      "http://token@127.0.0.1:12345/bootstrap/", "javascript:"].map(prefix => async () => ({...valid, bootstrap_url: prefix + "a".repeat(43)})),
    async () => ({...valid, bootstrap_url: valid.bootstrap_url + "?leak=1"}),
    async () => ({...valid, bootstrap_url: valid.bootstrap_url + "#leak"})]) {
    const failed = await render(invoke);
    assert.match(failed["bootstrap-status"].textContent, /启动检查失败/);
    assert.equal(failed["bootstrap-details"].hidden, true);
    assert.equal(failed.destination, null);
  }
  const badStorage = await render(async () => {throw "native_storage_invalid: original preserved";});
  assert.match(badStorage["bootstrap-status"].textContent, /native_storage_invalid: original preserved/);
  assert.equal(badStorage["bootstrap-details"].hidden, true);
})().catch(error => {console.error(error); process.exitCode = 1;});
'''
        result = subprocess.run([node, "-e", program], cwd=ROOT, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
