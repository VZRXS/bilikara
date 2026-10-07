import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, sourceIndex, iterableValues, lockPackages } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const ApplicationRestartSourceTest = {
async setUpClass() {
this.html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.app_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.i18n = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"));
this.main_rs = readFileSync(path.join(path.join(path.join(ROOT, "src-tauri"), "src"), "desktop.rs"), "utf8");
this.lifecycle_rs = readFileSync(path.join(path.join(path.join(ROOT, "src-tauri"), "src"), "window_lifecycle.rs"), "utf8");
this.build_rs = readFileSync(path.join(path.join(ROOT, "src-tauri"), "build.rs"), "utf8");
this.cargo_toml = readFileSync(path.join(path.join(ROOT, "src-tauri"), "Cargo.toml"), "utf8");
this.cargo_lock = lockPackages(readFileSync(path.join(path.join(ROOT, "src-tauri"), "Cargo.lock"), "utf8"));
this.capability = JSON.parse(readFileSync(path.join(path.join(path.join(ROOT, "src-tauri"), "capabilities"), "main.json"), "utf8"));
},
async test_advanced_action_is_native_only_and_uses_existing_confirmation() {
let language, translations;
assert.ok(contains("id=\"application-restart-row\"", this.html));
assert.ok(contains("id=\"application-restart-button\"", this.html));
assert.ok(contains("data-i18n=\"service.restartApplication\"", this.html));
assert.match(this.html, new RegExp("class=\"cache-panel-row hidden\" id=\"application-restart-row\" aria-hidden=\"true\"",""));
assert.match(this.html, new RegExp("id=\"application-restart-button\" disabled",""));
assert.ok(contains("type: \"restart-application\"", this.app_js));
assert.ok(contains("invoke(\"restart_application\")", this.app_js));
assert.ok(contains("syncApplicationRestartAvailability", this.app_js));
assert.doesNotMatch(this.app_js, new RegExp("api(?:Post|Get)?\\([^\\n]*restart",""));
for (const language of iterableValues(["zh", "en", "ja"])) {
translations = this.i18n["languages"][language];
assert.ok(contains("service.restartApplication", translations));
assert.ok(contains("service.restartApplicationConfirm", translations));
assert.ok(contains("service.restartApplicationFailed", translations));
}
assert.deepEqual(this.i18n["languages"]["zh"]["service.restartApplication"], "重启应用");
},
async test_native_command_is_registered_and_main_only() {
let command;
assert.ok(contains("ApplicationLifecycleState::default()", this.main_rs));
assert.ok(contains("window_lifecycle::restart_application", this.main_rs));
assert.ok(contains("\"restart_application\"", this.build_rs));
assert.ok(contains("allow-restart-application", this.capability["permissions"]));
assert.ok(contains("pub(crate) async fn restart_application", this.lifecycle_rs));
command = this.lifecycle_rs.slice(sourceIndex(this.lifecycle_rs, "pub(crate) async fn restart_application"), sourceIndex(this.lifecycle_rs, "pub(crate) fn handle_window_event"));
assert.ok(contains("presentation::authorize_window(&window, &backend, &[MAIN_WINDOW_LABEL])", command));
assert.ok(contains("app.request_restart()", command));
assert.ok(!contains("\"controller\"", command));
assert.ok(!contains("std::process::Command", command));
assert.ok(!contains("current_exe", command));
assert.ok(!contains("update_installer", command));
},
async test_locked_tauri_core_restart_contract_needs_no_process_plugin() {
let lockedPackage, tauri_packages;
tauri_packages = Array.from(Array.from(iterableValues(this.cargo_lock["package"])) .filter((lockedPackage) => ((lockedPackage["name"] === "tauri")))).map((lockedPackage) => lockedPackage);
assert.deepEqual(Array.from(Array.from(iterableValues(tauri_packages))).map((lockedPackage) => lockedPackage["version"]), ["2.11.2"]);
assert.ok(!contains("tauri-plugin-process", this.cargo_toml));
assert.ok(!contains("tauri-plugin-process", Array.from(Array.from(iterableValues(this.cargo_lock["package"]))).map((lockedPackage) => lockedPackage["name"])));
assert.ok(contains("sets restart_on_exit", this.lifecycle_rs));
assert.ok(contains("App::run exit callbacks and Tauri cleanup", this.lifecycle_rs));
},
async test_restart_sequence_preserves_existing_cleanup_order() {
let backend, command, command_end, command_start, preparation, preparation_call, preparation_start, restart;
preparation_start = sourceIndex(this.lifecycle_rs, "async fn prepare_application_restart_on_main_thread");
command_start = sourceIndex(this.lifecycle_rs, "pub(crate) async fn restart_application", preparation_start);
preparation = this.lifecycle_rs.slice(preparation_start, command_start);
assert.ok(contains("run_on_main_thread", preparation));
assert.ok(sourceIndex(preparation, "save_main_window_geometry") < sourceIndex(preparation, "presentation::prepare_app_shutdown"));
assert.ok(contains("let result = save_main_window_geometry", preparation));
assert.ok(!contains("save_main_window_geometry(&window.as_ref().window())?", preparation));
command_end = sourceIndex(this.lifecycle_rs, "pub(crate) async fn set_window_fullscreen", command_start);
command = this.lifecycle_rs.slice(command_start, command_end);
preparation_call = sourceIndex(command, "prepare_application_restart_on_main_thread(&app, &window).await");
backend = sourceIndex(command, "backend_process::shutdown(&backend)");
restart = sourceIndex(command, "app.request_restart()");
assert.ok(preparation_call < backend);
assert.ok(backend < restart);
assert.ok(contains("spawn_blocking", command));
}
};
test("ApplicationRestartSourceTest.test_advanced_action_is_native_only_and_uses_existing_confirmation", async () => { const instance = Object.create(ApplicationRestartSourceTest); await instance.setUpClass(); await instance.test_advanced_action_is_native_only_and_uses_existing_confirmation(); });
test("ApplicationRestartSourceTest.test_native_command_is_registered_and_main_only", async () => { const instance = Object.create(ApplicationRestartSourceTest); await instance.setUpClass(); await instance.test_native_command_is_registered_and_main_only(); });
test("ApplicationRestartSourceTest.test_locked_tauri_core_restart_contract_needs_no_process_plugin", async () => { const instance = Object.create(ApplicationRestartSourceTest); await instance.setUpClass(); await instance.test_locked_tauri_core_restart_contract_needs_no_process_plugin(); });
test("ApplicationRestartSourceTest.test_restart_sequence_preserves_existing_cleanup_order", async () => { const instance = Object.create(ApplicationRestartSourceTest); await instance.setUpClass(); await instance.test_restart_sequence_preserves_existing_cleanup_order(); });
