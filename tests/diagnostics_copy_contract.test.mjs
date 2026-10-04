import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const DiagnosticsCopyBehaviorTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.root = path.resolve(path.resolve(__file__), "..", "..");
this.helper = path.join(path.join(this.root, "static"), "diagnostics-copy.js");
this.helper_source = readFileSync(this.helper, "utf8");
this.app_source = readFileSync(path.join(path.join(this.root, "static"), "app.js"), "utf8");
},
async run_node(script) {
let childResult;
childResult = (await checked(this.node, ["-e", script, String(this.helper)], root));
return JSON.parse(childResult.stdout);
},
async test_tauri_native_write_is_preferred_and_preserves_unicode() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const markdown = "# 診断\\n中文内容 🎤";
            const calls = { native: [], web: [] };
            helper.copyText(markdown, {
              tauri: { clipboardManager: { async writeText(value) { calls.native.push(value); } } },
              navigator: { clipboard: { async writeText(value) { calls.web.push(value); } } },
            }).then((value) => process.stdout.write(JSON.stringify({ value, calls })));
            `));
assert.deepEqual(result["value"], {["transport"]: "tauri"});
assert.deepEqual(result["calls"]["native"], [`# 診断
中文内容 🎤`]);
assert.deepEqual(result["calls"]["web"], []);
},
async test_browser_uses_web_clipboard_and_native_failure_falls_back() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const calls = [];
            async function run() {
              const browser = await helper.copyText("browser", {
                tauri: null,
                navigator: { clipboard: { async writeText(value) { calls.push(\`web:\${value}\`); } } },
              });
              const fallback = await helper.copyText("fallback", {
                tauri: { clipboardManager: { async writeText() {
                  calls.push("native:failed");
                  throw new Error("native unavailable");
                } } },
                navigator: { clipboard: { async writeText(value) { calls.push(\`web:\${value}\`); } } },
              });
              return { browser, fallback, calls };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            `));
assert.deepEqual(result["browser"], {["transport"]: "web"});
assert.deepEqual(result["fallback"], {["transport"]: "web"});
assert.deepEqual(result["calls"], ["web:browser", "native:failed", "web:fallback"]);
},
async test_total_native_and_web_failure_reports_only_safe_message() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const secretMarkdown = "# SESSDATA=must-not-appear";
            helper.copyText(secretMarkdown, {
              fallbackMessage: "translated clipboard failure",
              tauri: { clipboardManager: { async writeText(value) {
                throw new Error(\`native rejected \${value}\`);
              } } },
              navigator: { clipboard: { async writeText(value) {
                throw new Error(\`web rejected \${value}\`);
              } } },
              document: null,
            }).then(() => {
              process.stdout.write(JSON.stringify({ error: null }));
            }).catch((error) => {
              process.stdout.write(JSON.stringify({ error: error.message }));
            });
            `));
assert.deepEqual(result["error"], "translated clipboard failure");
assert.ok(!contains("SESSDATA", result["error"]));
},
async test_first_copy_failure_retains_markdown_and_second_click_does_not_regenerate() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            let requests = 0;
            let writes = 0;
            const copied = [];
            const controller = helper.createRetryController({
              async generate() { requests += 1; return "# 已生成的诊断"; },
              async copyText(value) {
                writes += 1;
                if (writes === 1) throw new Error("activation expired");
                copied.push(value);
                return { transport: "web" };
              },
            });
            async function run() {
              const first = await controller.copy();
              const pendingAfterFirst = controller.hasPendingMarkdown();
              const second = await controller.copy();
              return {
                first: { status: first.status, reused: first.reused },
                second: { status: second.status, reused: second.reused },
                pendingAfterFirst,
                pendingAfterSecond: controller.hasPendingMarkdown(),
                requests,
                writes,
                copied,
              };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            `));
assert.deepEqual(result["first"], {["status"]: "ready", ["reused"]: false});
assert.ok(hasContent(result["pendingAfterFirst"]));
assert.deepEqual(result["second"], {["status"]: "copied", ["reused"]: true});
assert.ok(!hasContent(result["pendingAfterSecond"]));
assert.deepEqual(result["requests"], 1);
assert.deepEqual(result["writes"], 2);
assert.deepEqual(result["copied"], ["# 已生成的诊断"]);
},
async test_warm_success_clears_state_and_generation_failure_retries() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            async function run() {
              let warmRequests = 0;
              let warmWrites = 0;
              const warm = helper.createRetryController({
                async generate() { warmRequests += 1; return "# warm"; },
                async copyText() { warmWrites += 1; return { transport: "web" }; },
              });
              const warmResult = await warm.copy();

              let failureRequests = 0;
              const failure = helper.createRetryController({
                async generate() {
                  failureRequests += 1;
                  if (failureRequests === 1) throw new Error("generation failed");
                  return "# regenerated";
                },
                async copyText() { return { transport: "web" }; },
              });
              let firstError = "";
              try { await failure.copy(); } catch (error) { firstError = error.message; }
              const pendingAfterFailure = failure.hasPendingMarkdown();
              const retryResult = await failure.copy();
              return {
                warmResult,
                warmRequests,
                warmWrites,
                warmPending: warm.hasPendingMarkdown(),
                firstError,
                pendingAfterFailure,
                failureRequests,
                retryResult,
              };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            `));
assert.deepEqual(result["warmResult"]["status"], "copied");
assert.deepEqual(result["warmRequests"], 1);
assert.deepEqual(result["warmWrites"], 1);
assert.ok(!hasContent(result["warmPending"]));
assert.deepEqual(result["firstError"], "generation failed");
assert.ok(!hasContent(result["pendingAfterFailure"]));
assert.deepEqual(result["failureRequests"], 2);
assert.deepEqual(result["retryResult"]["status"], "copied");
},
async test_empty_and_malformed_generation_are_never_cached() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const values = ["", "   ", null, { markdown: "wrong shape" }];
            async function run() {
              const states = [];
              for (const value of values) {
                const controller = helper.createRetryController({
                  async generate() { return value; },
                  async copyText() { throw new Error("must not copy"); },
                });
                try { await controller.copy(); } catch (_) {}
                states.push(controller.hasPendingMarkdown());
              }
              return states;
            }
            run().then((states) => process.stdout.write(JSON.stringify({ states })));
            `));
assert.deepEqual(result["states"], [false, false, false, false]);
},
async test_retry_state_is_memory_only_and_app_uses_generic_abstraction() {
let storage_name;
for (const storage_name of iterableValues(["localStorage", "sessionStorage", "indexedDB"])) {
assert.ok(!contains(storage_name, this.helper_source));
}
assert.ok(contains("helper.createRetryController", this.app_source));
assert.ok(contains("helper.copyText(markdown", this.app_source));
assert.ok(contains("controller.hasPendingMarkdown()", this.app_source));
}
};
test("DiagnosticsCopyBehaviorTest.test_tauri_native_write_is_preferred_and_preserves_unicode", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_tauri_native_write_is_preferred_and_preserves_unicode(); });
test("DiagnosticsCopyBehaviorTest.test_browser_uses_web_clipboard_and_native_failure_falls_back", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_browser_uses_web_clipboard_and_native_failure_falls_back(); });
test("DiagnosticsCopyBehaviorTest.test_total_native_and_web_failure_reports_only_safe_message", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_total_native_and_web_failure_reports_only_safe_message(); });
test("DiagnosticsCopyBehaviorTest.test_first_copy_failure_retains_markdown_and_second_click_does_not_regenerate", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_first_copy_failure_retains_markdown_and_second_click_does_not_regenerate(); });
test("DiagnosticsCopyBehaviorTest.test_warm_success_clears_state_and_generation_failure_retries", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_warm_success_clears_state_and_generation_failure_retries(); });
test("DiagnosticsCopyBehaviorTest.test_empty_and_malformed_generation_are_never_cached", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_empty_and_malformed_generation_are_never_cached(); });
test("DiagnosticsCopyBehaviorTest.test_retry_state_is_memory_only_and_app_uses_generic_abstraction", async () => { const instance = Object.create(DiagnosticsCopyBehaviorTest); await instance.setUpClass(); await instance.test_retry_state_is_memory_only_and_app_uses_generic_abstraction(); });
const TauriClipboardCapabilityTest = {
async setUpClass() {
this.root = path.resolve(path.resolve(__file__), "..", "..");
this.cargo = readFileSync(path.join(path.join(this.root, "src-tauri"), "Cargo.toml"), "utf8");
this.main = readFileSync(path.join(path.join(path.join(this.root, "src-tauri"), "src"), "desktop.rs"), "utf8");
this.capability = JSON.parse(readFileSync(path.join(path.join(path.join(this.root, "src-tauri"), "capabilities"), "main.json"), "utf8"));
this.helper = readFileSync(path.join(path.join(this.root, "static"), "diagnostics-copy.js"), "utf8");
},
async test_official_write_only_clipboard_plugin_is_registered() {
assert.ok(contains("tauri-plugin-clipboard-manager = \"2\"", this.cargo));
assert.ok(contains("tauri_plugin_clipboard_manager::init()", this.main));
assert.ok(contains("clipboard-manager:allow-write-text", this.capability["permissions"]));
},
async test_clipboard_read_is_not_exposed() {
let permissions;
permissions = this.capability["permissions"].join(`
`);
assert.ok(!contains("allow-read", permissions));
assert.ok(!contains("clipboard-manager:default", permissions));
assert.ok(!contains("readText", this.helper));
}
};
test("TauriClipboardCapabilityTest.test_official_write_only_clipboard_plugin_is_registered", async () => { const instance = Object.create(TauriClipboardCapabilityTest); await instance.setUpClass(); await instance.test_official_write_only_clipboard_plugin_is_registered(); });
test("TauriClipboardCapabilityTest.test_clipboard_read_is_not_exposed", async () => { const instance = Object.create(TauriClipboardCapabilityTest); await instance.setUpClass(); await instance.test_clipboard_read_is_not_exposed(); });
