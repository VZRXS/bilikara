import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, statSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, splitOnce, sourceIndex, lastSourceIndex, firstMatch, countValues, iterableValues, concatenate, markupSummary, countOccurrences, lockPackages, splitLimited, paired, subtract, readUniqueJson, words } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const TAURI = path.join(ROOT, "src-tauri");

import { cargoDependencies } from './cargo_manifest_support.mjs';

const AndroidAlphaBootstrapTest = {
async test_android_links_runtime_without_desktop_launcher() {
let capability, cargo, dependencies, entry, forbidden, source;
cargo = (await cargoDependencies(TAURI)).document;
dependencies = cargo["target"]["cfg(target_os = \"android\")"]["dependencies"];
assert.deepEqual(dependencies["bilikara_runtime"]["path"], "../rust-runtime");
assert.ok(contains("native-host", dependencies["bilikara_runtime"]["features"]));
assert.ok(!contains("tauri-plugin-dialog", cargo["dependencies"]));
assert.ok(!contains("tauri-plugin-clipboard-manager", cargo["dependencies"]));
assert.ok(contains("macos-private-api", cargo["dependencies"]["tauri"]["features"]));
entry = readFileSync(path.join(TAURI, "src/lib.rs"), "utf8");
assert.ok(contains("#[cfg_attr(mobile, tauri::mobile_entry_point)]", entry));
assert.ok(contains(`#[cfg(target_os = "android")]
mod android;`, entry));
source = readFileSync(path.join(TAURI, "src/android.rs"), "utf8");
assert.ok(contains("initialize_native_host(", source));
assert.match(source, new RegExp("app\\s*\\.path\\(\\)\\s*\\.app_data_dir\\(\\)",""));
assert.ok(contains("execute_app_state(AppStateRequest::Snapshot", source));
for (const forbidden of iterableValues(["Command::new", "backend_process::", "execute_app_state_json", "CString"])) {
assert.ok(!contains(forbidden, source));
}
for (const capability of iterableValues(["host_api_ready", "playback_ready"])) {
assert.ok(contains((String(capability) + ": true"), source));
}
assert.ok(contains("persistence_ready: true", source));
assert.ok(contains("stage: \"native-host-alpha\"", source));
assert.ok(contains("if let Some(error) = &bootstrap.error", source));
assert.ok(contains("app.asset_resolver()", source));
assert.ok(contains("NativeHost::start(", source));
assert.ok(contains("app.manage(AndroidBootstrap { host, error });", source));
assert.ok(!contains("std::fs::remove", source));
},
async test_bootstrap_ipc_is_local_read_only_and_mobile_scoped() {
let capability, config, desktop, name;
for (const name of iterableValues(["main", "controller"])) {
desktop = JSON.parse(readFileSync(path.join(TAURI, ("capabilities/" + String(name) + ".json")), "utf8"));
assert.deepEqual(new Set((Symbol.iterator in Object(desktop["platforms"]) ? desktop["platforms"] : Object.keys(desktop["platforms"]))), new Set(["windows", "linux", "macOS"]));
}
capability = JSON.parse(readFileSync(path.join(TAURI, "capabilities/android-alpha.json"), "utf8"));
assert.deepEqual(capability["platforms"], ["android"]);
assert.deepEqual(capability["windows"], ["main"]);
assert.deepEqual(capability["permissions"], ["allow-android-alpha-status"]);
assert.ok(hasContent(capability["local"]));
assert.ok(!contains("remote", capability));
config = JSON.parse(readFileSync(path.join(TAURI, "tauri.android.conf.json"), "utf8"));
assert.equal(config["build"]["devUrl"], null);
assert.deepEqual(config["app"]["security"]["capabilities"], ["android-alpha"]);
assert.ok(contains("default-src 'self'", config["app"]["security"]["csp"]));
assert.deepEqual(config["app"]["windows"][0]["url"], "android-alpha.html");
assert.ok(hasContent(config["app"]["windows"][0]["visible"]));
},
async test_android_scopes_cleartext_to_loopback_and_keeps_foreground_only() {
let activity, build, config, gradle, guard, manifest, security, updater;
config = JSON.parse(readFileSync(path.join(TAURI, "tauri.android.conf.json"), "utf8"));
assert.ok(!contains("version", config));
assert.deepEqual(config["bundle"]["android"]["debugApplicationIdSuffix"], ".alpha");
gradle = readFileSync(path.join(TAURI, "gen/android/app/build.gradle.kts"), "utf8");
assert.ok(contains("applicationIdSuffix = \".alpha\"", gradle));
build = readFileSync(path.join(TAURI, "build.rs"), "utf8");
assert.ok(contains("std::env::var(\"CARGO_CFG_TARGET_OS\").as_deref() == Ok(\"android\")", build));
assert.ok(contains("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384", build));
assert.ok(contains("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384", build));
manifest = readFileSync(path.join(TAURI, "gen/android/app/src/main/AndroidManifest.xml"), "utf8");
assert.ok(!contains("FOREGROUND_SERVICE", manifest));
assert.ok(contains("android.permission.REQUEST_INSTALL_PACKAGES", manifest));
updater = readFileSync(path.join(TAURI, "gen/android/app/src/main/java/com/bilikara/app/HostUpdate.kt"), "utf8");
for (const guard of iterableValues(["BuildConfig.DEBUG", "canRequestPackageInstalls()", "validatePackage(partial)", "candidate.packageName == activity.packageName", "signers(candidate) == expected", "nextCode > oldCode", "Intent.ACTION_VIEW", "digestHex(digest.digest()) == expectedHash"])) {
assert.ok(contains(guard, updater));
}
assert.ok(!contains("PackageInstaller.Session", updater));
assert.ok(!contains("android:usesCleartextTraffic=\"true\"", manifest));
assert.ok(contains("android:allowBackup=\"false\"", manifest));
assert.ok(contains("@xml/network_security_config", manifest));
security = readFileSync(path.join(TAURI, "gen/android/app/src/main/res/xml/network_security_config.xml"), "utf8");
assert.ok(contains("<base-config cleartextTrafficPermitted=\"false\"", security));
assert.ok(contains("includeSubdomains=\"false\">127.0.0.1</domain>", security));
activity = readFileSync(path.join(TAURI, "gen/android/app/src/main/java/com/bilikara/app/MainActivity.kt"), "utf8");
assert.ok(contains("FLAG_KEEP_SCREEN_ON", activity));
assert.ok(!contains("PARTIAL_WAKE_LOCK", activity));
},
async test_native_window_owns_insets_for_bootstrap_and_host() {
let activity, kind, manifest, source;
activity = readFileSync(path.join(TAURI, "gen/android/app/src/main/java/com/bilikara/app/MainActivity.kt"), "utf8");
assert.ok(contains("HostWindowInsets.install(findViewById(android.R.id.content))", activity));
manifest = readFileSync(path.join(TAURI, "gen/android/app/src/main/AndroidManifest.xml"), "utf8");
assert.ok(contains("android:windowSoftInputMode=\"adjustResize\"", manifest));
source = readFileSync(path.join(TAURI, "gen/android/app/src/main/java/com/bilikara/app/HostWindowInsets.kt"), "utf8");
for (const kind of iterableValues(["systemBars", "displayCutout", "ime"])) {
assert.ok(contains(("WindowInsetsCompat.Type." + String(kind) + "()"), source));
}
assert.ok(contains(".setInsets(handled, Insets.NONE)", source));
assert.ok(contains("ViewCompat.requestApplyInsets(content)", source));
},
async test_bootstrap_page_reports_native_success_failure_and_wrong_schema() {
let node, program, result;
node = process.execPath;
if ((!node)) {
assert.fail("Node.js is required to validate the Android bootstrap page");
}
program = `
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
`;
result = (await runNative(node, ["-e", program], process.env, 20 * 1000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
}
};
test("AndroidAlphaBootstrapTest.test_android_links_runtime_without_desktop_launcher", async () => { const instance = Object.create(AndroidAlphaBootstrapTest); await instance.test_android_links_runtime_without_desktop_launcher(); });
test("AndroidAlphaBootstrapTest.test_bootstrap_ipc_is_local_read_only_and_mobile_scoped", async () => { const instance = Object.create(AndroidAlphaBootstrapTest); await instance.test_bootstrap_ipc_is_local_read_only_and_mobile_scoped(); });
test("AndroidAlphaBootstrapTest.test_android_scopes_cleartext_to_loopback_and_keeps_foreground_only", async () => { const instance = Object.create(AndroidAlphaBootstrapTest); await instance.test_android_scopes_cleartext_to_loopback_and_keeps_foreground_only(); });
test("AndroidAlphaBootstrapTest.test_native_window_owns_insets_for_bootstrap_and_host", async () => { const instance = Object.create(AndroidAlphaBootstrapTest); await instance.test_native_window_owns_insets_for_bootstrap_and_host(); });
test("AndroidAlphaBootstrapTest.test_bootstrap_page_reports_native_success_failure_and_wrong_schema", async () => { const instance = Object.create(AndroidAlphaBootstrapTest); await instance.test_bootstrap_page_reports_native_success_failure_and_wrong_schema(); });
