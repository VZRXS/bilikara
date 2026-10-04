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
const ROOT_DIR = root;
import { cargoDependencies } from './cargo_manifest_support.mjs';
const MacOSTauriAutoplayConfigurationTest = {
async test_macos_defers_exactly_one_configured_main_window() {
let base_config, base_windows, capability, key, macos_config, macos_window, macos_windows, value, window;
base_config = JSON.parse(readFileSync(path.join(path.join(ROOT_DIR, "src-tauri"), "tauri.conf.json"), "utf8"));
macos_config = JSON.parse(readFileSync(path.join(path.join(ROOT_DIR, "src-tauri"), "tauri.macos.conf.json"), "utf8"));
capability = JSON.parse(readFileSync(path.join(path.join(path.join(ROOT_DIR, "src-tauri"), "capabilities"), "main.json"), "utf8"));
base_windows = Array.from(Array.from(iterableValues(base_config["app"]["windows"])) .filter((window) => ((window["label"] === "main")))).map((window) => window);
macos_windows = Array.from(Array.from(iterableValues(macos_config["app"]["windows"])) .filter((window) => ((window["label"] === "main")))).map((window) => window);
assert.deepEqual(base_windows.length, 1);
assert.deepEqual(macos_windows.length, 1);
assert.ok(!contains("create", base_windows[0]));
assert.ok(!hasContent(macos_windows[0]["create"]));
macos_window = macos_windows[0];
for (const [key, value] of iterableValues(Object.entries(base_windows[0]))) {
assert.deepEqual(macos_window[key], value, key);
}
assert.ok(hasContent(macos_window["decorations"]));
assert.ok(hasContent(macos_window["hiddenTitle"]));
assert.deepEqual(macos_window["titleBarStyle"], "Overlay");
assert.deepEqual(capability["windows"], ["main"]);
},
async test_macos_main_webview_uses_creation_time_autoplay_policy() {
let backend_start, configuration, configuration_start, creation, creation_start, main_source, platform_source, setup, setup_start;
main_source = readFileSync(path.join(path.join(path.join(ROOT_DIR, "src-tauri"), "src"), "desktop.rs"), "utf8");
platform_source = readFileSync(path.join(path.join(path.join(ROOT_DIR, "src-tauri"), "src"), "platform.rs"), "utf8");
configuration_start = sourceIndex(platform_source, "fn macos_autoplay_webview_configuration");
creation_start = sourceIndex(platform_source, "fn create_macos_main_webview_window");
configuration = platform_source.slice(configuration_start, creation_start);
creation = platform_source.slice(creation_start, undefined);
setup_start = sourceIndex(main_source, ".setup(move |app| {");
backend_start = sourceIndex(main_source, "backend_process::launch", setup_start);
setup = main_source.slice(setup_start, backend_start);
assert.ok(contains("#[cfg(target_os = \"macos\")]", platform_source.slice(0, configuration_start).slice((-80), undefined)));
assert.ok(contains("WKWebViewConfiguration::new(main_thread)", configuration));
assert.ok(contains(".setMediaTypesRequiringUserActionForPlayback(", configuration));
assert.ok(contains("WKAudiovisualMediaTypes::None", configuration));
assert.ok(contains("#[cfg(target_os = \"macos\")]", platform_source.slice(0, creation_start).slice((-80), undefined)));
assert.ok(contains("app.get_webview_window(\"main\").is_some()", creation));
assert.ok(contains(".find(|config| config.label == \"main\")", creation));
assert.ok(contains("WebviewWindowBuilder::from_config", creation));
assert.ok(contains(".with_webview_configuration(", creation));
assert.deepEqual(countOccurrences(creation, ".build()?;"), 1);
assert.ok(contains("#[cfg(target_os = \"macos\")]", setup));
assert.ok(sourceIndex(setup, "create_macos_main_webview_window(app)?;") < sourceIndex(setup, "app.get_webview_window(\"main\")"));
},
async test_native_dependencies_remain_pinned_to_the_locked_graph() {
let cargo_lock, cargo_toml, lockedPackage, locked_versions, macos_dependencies;
cargo_toml = (await cargoDependencies(path.join(ROOT_DIR, "src-tauri"))).document;
cargo_lock = lockPackages(readFileSync(path.join(path.join(ROOT_DIR, "src-tauri"), "Cargo.lock"), "utf8"));
macos_dependencies = cargo_toml["target"]["cfg(target_os = \"macos\")"]["dependencies"];
assert.deepEqual(macos_dependencies["objc2"].version, "=0.6.4");
assert.deepEqual(macos_dependencies["objc2-web-kit"]["version"], "=0.3.2");
assert.ok(!hasContent(macos_dependencies["objc2-web-kit"]["default-features"]));
assert.deepEqual(macos_dependencies["objc2-web-kit"]["features"], ["std", "WKWebViewConfiguration"]);
locked_versions = Object.fromEntries(Array.from(Array.from(iterableValues(cargo_lock["package"]))).map((lockedPackage) => [lockedPackage["name"], lockedPackage["version"]]));
assert.deepEqual(locked_versions["tauri"], "2.11.2");
assert.deepEqual(locked_versions["tauri-runtime-wry"], "2.11.2");
assert.deepEqual(locked_versions["wry"], "0.55.1");
assert.deepEqual(locked_versions["objc2"], "0.6.4");
assert.deepEqual(locked_versions["objc2-web-kit"], "0.3.2");
}
};
test("MacOSTauriAutoplayConfigurationTest.test_macos_defers_exactly_one_configured_main_window", async () => { const instance = Object.create(MacOSTauriAutoplayConfigurationTest); await instance.test_macos_defers_exactly_one_configured_main_window(); });
test("MacOSTauriAutoplayConfigurationTest.test_macos_main_webview_uses_creation_time_autoplay_policy", async () => { const instance = Object.create(MacOSTauriAutoplayConfigurationTest); await instance.test_macos_main_webview_uses_creation_time_autoplay_policy(); });
test("MacOSTauriAutoplayConfigurationTest.test_native_dependencies_remain_pinned_to_the_locked_graph", async () => { const instance = Object.create(MacOSTauriAutoplayConfigurationTest); await instance.test_native_dependencies_remain_pinned_to_the_locked_graph(); });
