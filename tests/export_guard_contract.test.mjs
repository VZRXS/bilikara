import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { hasContent, sourceIndex, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const ExportGuardTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.repo_root = path.resolve(path.resolve(__file__), "..", "..");
this.helper = path.join(path.join(this.repo_root, "static"), "export-guard.js");
},
async run_node(script) {
let childResult;
childResult = (await checked(this.node, ["-e", script, String(this.helper)], root));
return JSON.parse(childResult.stdout);
},
async test_disables_both_buttons_and_suppresses_concurrent_export() {
let result;
result = (await this.run_node(`
            const {createExportGuard} = require(process.argv[1]);
            const button = () => ({
              disabled: false,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            });
            const buttons = [button(), button()];
            const guard = createExportGuard(buttons);
            let finish;
            let calls = 0;
            const first = guard.run(() => {
              calls += 1;
              return new Promise((resolve) => { finish = resolve; });
            });
            const busySnapshot = buttons.map((item) => ({
              disabled: item.disabled,
              ariaBusy: item.attributes["aria-busy"],
            }));
            const second = guard.run(() => { calls += 1; });
            Promise.resolve(second).then((secondResult) => {
              finish();
              return first.then((firstResult) => {
                process.stdout.write(JSON.stringify({
                  calls,
                  firstResult,
                  secondResult,
                  busySnapshot,
                  finalBusy: guard.isBusy(),
                  finalButtons: buttons.map((item) => ({
                    disabled: item.disabled,
                    ariaBusy: item.attributes["aria-busy"] || null,
                  })),
                }));
              });
            });
            `));
assert.deepEqual(result["calls"], 1);
assert.ok(hasContent(result["firstResult"]));
assert.ok(!hasContent(result["secondResult"]));
assert.deepEqual(result["busySnapshot"], [{["disabled"]: true, ["ariaBusy"]: "true"}, {["disabled"]: true, ["ariaBusy"]: "true"}]);
assert.ok(!hasContent(result["finalBusy"]));
assert.deepEqual(result["finalButtons"], [{["disabled"]: false, ["ariaBusy"]: null}, {["disabled"]: false, ["ariaBusy"]: null}]);
},
async test_restores_buttons_after_failure() {
let result;
result = (await this.run_node(`
            const {createExportGuard} = require(process.argv[1]);
            const button = {
              disabled: false,
              setAttribute() {},
              removeAttribute() {},
            };
            const guard = createExportGuard([button]);
            guard.run(async () => { throw new Error("failed"); })
              .catch((error) => process.stdout.write(JSON.stringify({
                message: error.message,
                busy: guard.isBusy(),
                disabled: button.disabled,
              })));
            `));
assert.deepEqual(result, {["message"]: "failed", ["busy"]: false, ["disabled"]: false});
},
async test_preserves_preexisting_disabled_state() {
let result;
result = (await this.run_node(`
            const {createExportGuard} = require(process.argv[1]);
            const button = {
              disabled: true,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            };
            const guard = createExportGuard([button]);
            guard.run(async () => {}).then(() => process.stdout.write(JSON.stringify({
              busy: guard.isBusy(),
              disabled: button.disabled,
              ariaBusy: button.attributes["aria-busy"] || null,
            })));
            `));
assert.deepEqual(result, {["busy"]: false, ["disabled"]: true, ["ariaBusy"]: null});
},
async test_pages_load_guard_before_export_consumers() {
let consumer_name, page_name, source;
for (const [page_name, consumer_name] of iterableValues([["index.html", "app.js"], ["remote.html", "remote.js"]])) {
source = readFileSync(path.join(path.join(this.repo_root, "static"), page_name), "utf8");
assert.ok(sourceIndex(source, "/export-guard.js") < sourceIndex(source, ("/" + String(consumer_name))));
assert.ok(sourceIndex(source, "/export-download.js") < sourceIndex(source, ("/" + String(consumer_name))));
}
}
};
test("ExportGuardTest.test_disables_both_buttons_and_suppresses_concurrent_export", async () => { const instance = Object.create(ExportGuardTest); await instance.setUpClass(); await instance.test_disables_both_buttons_and_suppresses_concurrent_export(); });
test("ExportGuardTest.test_restores_buttons_after_failure", async () => { const instance = Object.create(ExportGuardTest); await instance.setUpClass(); await instance.test_restores_buttons_after_failure(); });
test("ExportGuardTest.test_preserves_preexisting_disabled_state", async () => { const instance = Object.create(ExportGuardTest); await instance.setUpClass(); await instance.test_preserves_preexisting_disabled_state(); });
test("ExportGuardTest.test_pages_load_guard_before_export_consumers", async () => { const instance = Object.create(ExportGuardTest); await instance.setUpClass(); await instance.test_pages_load_guard_before_export_consumers(); });
