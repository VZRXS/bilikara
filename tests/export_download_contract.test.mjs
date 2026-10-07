import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, sourceIndex, iterableValues, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const ExportDownloadBehaviorTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.repo_root = path.resolve(path.resolve(__file__), "..", "..");
this.helper = path.join(path.join(this.repo_root, "static"), "export-download.js");
this.guard = path.join(path.join(this.repo_root, "static"), "export-guard.js");
this.sources = {["host"]: readFileSync(path.join(path.join(this.repo_root, "static"), "app.js"), "utf8"), ["remote"]: readFileSync(path.join(path.join(this.repo_root, "static"), "remote.js"), "utf8")};
},
async function_source(source, marker, next_marker) {
let end, start;
start = sourceIndex(source, marker);
end = sourceIndex(source, next_marker, start);
return source.slice(start, end);
},
async run_node(script, ...args) {
let childResult;
childResult = (await checked(this.node, ["-e", script, ...args], root));
return JSON.parse(childResult.stdout);
},
async test_error_normalization_covers_error_string_and_fallback_inputs() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const fallback = "translated fallback";
            process.stdout.write(JSON.stringify({
              error: helper.normalizedErrorMessage(new Error("error instance"), fallback),
              string: helper.normalizedErrorMessage("  string rejection  ", fallback),
              empty: helper.normalizedErrorMessage("   ", fallback),
              nullValue: helper.normalizedErrorMessage(null, fallback),
              object: helper.normalizedErrorMessage({ code: 500 }, fallback),
              translated: helper.normalizedErrorMessage(undefined, "翻译后的失败消息"),
            }));
            `, String(this.helper)));
assert.deepEqual(result["error"], "error instance");
assert.deepEqual(result["string"], "string rejection");
assert.deepEqual(result["empty"], "translated fallback");
assert.deepEqual(result["nullValue"], "translated fallback");
assert.deepEqual(result["object"], "translated fallback");
assert.deepEqual(result["translated"], "翻译后的失败消息");
},
async test_native_result_supports_saved_cancelled_and_failed() {
let name, result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const values = {};
            for (const [name, value] of Object.entries({
              saved: { status: "saved" },
              cancelled: { status: "cancelled" },
              failed: { status: "failed", errorMessage: "custom native failure" },
              boolean: true,
              unknown: { status: "complete" },
              nullValue: null,
            })) {
              try {
                values[name] = { status: helper.nativeDownloadStatus(value, "native fallback") };
              } catch (error) {
                values[name] = { error: error.message };
              }
            }
            process.stdout.write(JSON.stringify(values));
            `, String(this.helper)));
assert.deepEqual(result["saved"], {["status"]: "saved"});
assert.deepEqual(result["cancelled"], {["status"]: "cancelled"});
assert.deepEqual(result["failed"], {["error"]: "custom native failure"});
for (const name of iterableValues(["boolean", "unknown", "nullValue"])) {
assert.deepEqual(result[name], {["error"]: "native fallback"});
}
},
async test_export_diagnostic_ring_caps_at_64_entries_and_whitelists_fields() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const ring = helper.createExportDiagnosticRing(64);
            for (let i = 0; i < 70; i++) {
              ring.push({
                timestamp: "2026-08-05T00:00:00Z",
                surface: "host",
                runtime: "tauri",
                format: "csv",
                source: "played",
                pageSize: 200,
                stage: "complete",
                status: "saved",
                httpStatus: 200,
                contentType: "text/csv",
                bytes: 100,
                filenameExtension: "csv",
                elapsedMs: 50,
                songTitle: "unauthorized_title_secret",
                requester: "unauthorized_user_secret",
                extraField: "should_be_stripped",
                index: i,
              });
            }
            const snapshot = ring.snapshot();
            process.stdout.write(JSON.stringify({
              length: snapshot.length,
              firstIndex: snapshot[0].index,
              hasSongTitle: "songTitle" in snapshot[0],
              hasRequester: "requester" in snapshot[0],
              hasExtraField: "extraField" in snapshot[0],
            }));
            `, String(this.helper)));
assert.deepEqual(result["length"], 64);
assert.ok(!hasContent(result["hasSongTitle"]));
assert.ok(!hasContent(result["hasRequester"]));
assert.ok(!hasContent(result["hasExtraField"]));
},
async run_browser_download({response_mode, filename = "server-name.csv"} = {}) {
return (await this.run_node(`
            const helper = require(process.argv[1]);
            const mode = process.argv[2];
            const filename = process.argv[3];
            const events = { appended: [], revoked: [], timers: [], fetchOptions: null };
            const link = {
              removed: false,
              clicked: false,
              remove() { this.removed = true; },
              click() { this.clicked = true; },
            };
            const environment = {
              async fetch(url, options) {
                events.fetchUrl = url;
                events.fetchOptions = options;
                return {
                  ok: mode === "success",
                  headers: { get(name) {
                    return name === "Content-Disposition"
                      ? \`attachment; filename="\${filename}"\`
                      : null;
                  } },
                  async blob() { events.blobCalled = true; return { size: 12 }; },
                  async json() {
                    if (mode === "json-error") return { error: "server rejected export" };
                    if (mode === "empty-json-error") return { error: "" };
                    throw new Error("not JSON");
                  },
                };
              },
              document: {
                createElement(tag) { events.createdTag = tag; return link; },
                body: { appendChild(node) { events.appended.push(node); } },
              },
              URL: {
                createObjectURL(blob) { events.createdBlob = blob; return "blob:download"; },
                revokeObjectURL(url) { events.revoked.push(url); },
              },
              setTimeout(callback, delay) { events.timers.push({ callback, delay }); },
            };
            helper.downloadBrowserFile(
              "/api/playlist/export?format=csv",
              {
                fallbackFilename: "fallback.csv",
                fallbackMessage: "translated export failure",
                headers: { "X-Bilikara-Client": "remote-client" },
              },
              environment,
            ).then((value) => {
              for (const timer of events.timers) timer.callback();
              process.stdout.write(JSON.stringify({
                value,
                error: null,
                fetchUrl: events.fetchUrl,
                fetchOptions: events.fetchOptions,
                blobCalled: Boolean(events.blobCalled),
                createdTag: events.createdTag || null,
                clicked: link.clicked,
                removed: link.removed,
                href: link.href || null,
                download: link.download || null,
                rel: link.rel || null,
                timerDelays: events.timers.map((timer) => timer.delay),
                revoked: events.revoked,
              }));
            }).catch((error) => {
              process.stdout.write(JSON.stringify({
                value: null,
                error: error.message,
                fetchOptions: events.fetchOptions,
                blobCalled: Boolean(events.blobCalled),
                createdTag: events.createdTag || null,
                revoked: events.revoked,
              }));
            });
            `, String(this.helper), response_mode, filename));
},
async test_browser_blob_download_uses_content_disposition_and_cleans_up() {
let filename, result;
for (const filename of iterableValues(["playlist.csv", "playlist.png"])) {
{
result = (await this.run_browser_download({response_mode: "success", filename: filename}));
assert.ok(hasContent(result["value"]));
assert.equal(result["error"], null);
assert.deepEqual(result["fetchOptions"]["credentials"], "same-origin");
assert.deepEqual(result["fetchOptions"]["cache"], "no-store");
assert.deepEqual(result["fetchOptions"]["headers"]["X-Bilikara-Client"], "remote-client");
assert.ok(hasContent(result["blobCalled"]));
assert.deepEqual(result["createdTag"], "a");
assert.ok(hasContent(result["clicked"]));
assert.ok(hasContent(result["removed"]));
assert.deepEqual(result["href"], "blob:download");
assert.deepEqual(result["download"], filename);
assert.deepEqual(result["rel"], "noopener");
assert.deepEqual(result["timerDelays"], [1000]);
assert.deepEqual(result["revoked"], ["blob:download"]);
}
}
},
async test_browser_blob_download_surfaces_json_and_non_json_errors() {
let expected, message, mode, result;
expected = {["json-error"]: "server rejected export", ["non-json-error"]: "translated export failure", ["empty-json-error"]: "translated export failure"};
for (const [mode, message] of iterableValues(Object.entries(expected))) {
{
result = (await this.run_browser_download({response_mode: mode}));
assert.deepEqual(result["error"], message);
assert.ok(!hasContent(result["blobCalled"]));
assert.equal(result["createdTag"], null);
assert.deepEqual(result["revoked"], []);
}
}
},
async run_adapter(frontend, {tauri, native_mode = "saved"} = {}) {
let download_source, save_source, script;
download_source = (await this.function_source(this.sources[frontend], "async function downloadHistoryExport", (((frontend === "host")) ? "async function exportHistory" : "elements.openRatingButton")));
save_source = "";
if (((frontend === "host"))) {
save_source = (await this.function_source(this.sources[frontend], "async function saveTauriBackendDownload", "async function setTauriWindowFullscreen"));
}
script = concatenate(concatenate(concatenate(`
        const helper = require(process.argv[1]);
        const NativeURLSearchParams = global.URLSearchParams;
        const events = { invokeCalls: 0, fetchCalls: 0, links: [], revoked: [] };
        global.window = global;
        window.BilikaraExportDownload = helper;
        global.URLSearchParams = NativeURLSearchParams;
        const state = { clientId: "client-1" };
        const elements = {};
        function t(key) { return key; }
        function clientHeaders() { return { "X-Bilikara-Client": state.clientId }; }
        function normalizedHistoryExportSource(value) { return value === "history" ? "history" : "played"; }
        function normalizedHistoryExportPageSize(value) { return Number(value) || 200; }
        async function invoke() {
          events.invokeCalls += 1;
          const mode = process.argv[3];
          if (mode === "command-not-found") throw "command save_backend_download not found";
          if (mode === "command-quote-not-found") throw "command 'save_backend_download' not found";
          if (mode === "unknown-command") throw "unknown command save_backend_download";
          if (mode === "unknown-command-quote") throw "unknown command 'save_backend_download'";
          if (mode === "backend-resource-not-found") throw "backend resource not found";
          if (mode === "window-not-found") throw "window not found";
          if (mode === "export-file-not-found") throw "export file not found";
          if (mode === "string-error") throw "[request_backend] backend unavailable";
          if (mode === "error-object") throw new Error("[write_file] permission denied");

          if (mode === "saved") {
            return {
              status: "saved",
              stage: "complete",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: 200,
              contentType: "text/csv",
              bytes: 150,
              filenameExtension: "csv",
              elapsedMs: 50,
              stageTimings: [{ stage: "complete", elapsedMs: 10 }],
              errorCode: null,
              errorMessage: null,
            };
          }
          if (mode === "cancelled") {
            return {
              status: "cancelled",
              stage: "choose_destination",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: null,
              contentType: null,
              bytes: null,
              filenameExtension: null,
              elapsedMs: 30,
              stageTimings: [{ stage: "choose_destination", elapsedMs: 10 }],
              errorCode: null,
              errorMessage: null,
            };
          }
          if (mode === "failed") {
            return {
              status: "failed",
              stage: "request_backend",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: null,
              contentType: null,
              bytes: null,
              filenameExtension: null,
              elapsedMs: 40,
              stageTimings: [{ stage: "request_backend", elapsedMs: 10 }],
              errorCode: "REQUEST_BACKEND_FAILED",
              errorMessage: "[request_backend] backend failed",
            };
          }

          if (mode === "malformed-true") return true;
          if (mode === "malformed-null") return null;
          if (mode === "malformed-string") return "unexpected string";
          if (mode === "malformed-partial-saved") return { status: "saved" };
          if (mode === "malformed-partial-cancelled") return { status: "cancelled" };
          if (mode === "malformed-partial-failed") return { status: "failed" };
          if (mode === "malformed-object") return { foo: "bar", status: "invalid_status", extra: "secret" };
          if (mode === "malformed-saved-wrong-stage") {
            return {
              status: "saved", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-saved-no-http-status") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-cancelled-with-backend-response") {
            return {
              status: "cancelled", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-failed-no-error-code") {
            return {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: "error msg",
            };
          }
          if (mode === "malformed-failed-no-error-message") {
            return {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 10, stageTimings: [], errorCode: "ERR", errorMessage: null,
            };
          }
          if (mode === "malformed-invalid-elapsed-ms") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: -5, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-invalid-stage-timings") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: "invalid", errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-inherited-properties") {
            const proto = {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
            return Object.create(proto);
          }

          if (mode === "malformed") return true;
          return { status: mode };
        }
        function tauriInvoke() { return window.__TAURI__?.core?.invoke || null; }
        if (JSON.parse(process.argv[2])) {
          window.__TAURI__ = { core: { invoke } };
        }
        global.fetch = async function(url, options) {
          events.fetchCalls += 1;
          events.fetchUrl = url;
          events.fetchOptions = options;
          return {
            ok: true,
            headers: { get() { return 'attachment; filename="browser-file.csv"'; } },
            async blob() { return { size: 3 }; },
          };
        };
        global.document = {
          createElement() {
            const link = {
              clicked: false,
              removed: false,
              click() { this.clicked = true; },
              remove() { this.removed = true; },
            };
            events.links.push(link);
            return link;
          },
          body: { appendChild() {} },
        };
        global.URL = {
          createObjectURL() { return "blob:test"; },
          revokeObjectURL(url) { events.revoked.push(url); },
        };
        global.setTimeout = (callback) => { callback(); };
        `, save_source), download_source), `
        downloadHistoryExport("csv", "played", 200).then((result) => {
          process.stdout.write(JSON.stringify({
            result,
            error: null,
            invokeCalls: events.invokeCalls,
            fetchCalls: events.fetchCalls,
            fetchOptions: events.fetchOptions || null,
            links: events.links.map((link) => ({
              download: link.download,
              clicked: link.clicked,
              removed: link.removed,
            })),
            revoked: events.revoked,
            diagnostics: window.BilikaraExportDownload ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot() : [],
          }));
        }).catch((error) => {
          process.stdout.write(JSON.stringify({
            result: null,
            error: error.message,
            invokeCalls: events.invokeCalls,
            fetchCalls: events.fetchCalls,
            diagnostics: window.BilikaraExportDownload ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot() : [],
          }));
        });
        `);
return (await this.run_node(script, String(this.helper), JSON.stringify(tauri), native_mode));
},
async test_adapter_routing_is_explicit_for_tauri_host_web_host_and_remote() {
let remote_with_tauri_fixture, tauri_host, web_host;
tauri_host = (await this.run_adapter("host", {tauri: true, native_mode: "saved"}));
assert.ok(hasContent(tauri_host["result"]));
assert.deepEqual(tauri_host["invokeCalls"], 1);
assert.deepEqual(tauri_host["fetchCalls"], 0);
web_host = (await this.run_adapter("host", {tauri: false}));
assert.ok(hasContent(web_host["result"]));
assert.deepEqual(web_host["invokeCalls"], 0);
assert.deepEqual(web_host["fetchCalls"], 1);
assert.deepEqual(web_host["links"][0]["download"], "browser-file.csv");
remote_with_tauri_fixture = (await this.run_adapter("remote", {tauri: true}));
assert.ok(hasContent(remote_with_tauri_fixture["result"]));
assert.deepEqual(remote_with_tauri_fixture["invokeCalls"], 0);
assert.deepEqual(remote_with_tauri_fixture["fetchCalls"], 1);
assert.deepEqual(remote_with_tauri_fixture["fetchOptions"]["headers"]["X-Bilikara-Client"], "client-1");
},
async test_native_saved_cancelled_and_failure_results_are_observable() {
let cancelled, error_object, failed, saved, string_error;
saved = (await this.run_adapter("host", {tauri: true, native_mode: "saved"}));
assert.ok(hasContent(saved["result"]));
cancelled = (await this.run_adapter("host", {tauri: true, native_mode: "cancelled"}));
assert.ok(!hasContent(cancelled["result"]));
assert.equal(cancelled["error"], null);
failed = (await this.run_adapter("host", {tauri: true, native_mode: "failed"}));
assert.deepEqual(failed["error"], "[request_backend] backend failed");
assert.deepEqual(failed["fetchCalls"], 0);
string_error = (await this.run_adapter("host", {tauri: true, native_mode: "string-error"}));
assert.deepEqual(string_error["error"], "[request_backend] backend unavailable");
assert.deepEqual(string_error["fetchCalls"], 0);
error_object = (await this.run_adapter("host", {tauri: true, native_mode: "error-object"}));
assert.deepEqual(error_object["error"], "[write_file] permission denied");
assert.deepEqual(error_object["fetchCalls"], 0);
},
async test_tauri_command_unavailable_matching_is_narrow() {
let mode, res;
for (const mode of iterableValues(["command-not-found", "command-quote-not-found", "unknown-command", "unknown-command-quote"])) {
res = (await this.run_adapter("host", {tauri: true, native_mode: mode}));
assert.ok(hasContent(res["result"]), ("Mode " + String(mode) + " should fall back to browser and succeed"));
assert.deepEqual(res["fetchCalls"], 1, ("Mode " + String(mode) + " should issue fetch"));
}
for (const mode of iterableValues(["backend-resource-not-found", "window-not-found", "export-file-not-found"])) {
res = (await this.run_adapter("host", {tauri: true, native_mode: mode}));
assert.ok(!hasContent(res["result"]), ("Mode " + String(mode) + " must fail closed"));
assert.notEqual(res["error"], null);
assert.deepEqual(res["fetchCalls"], 0, ("Mode " + String(mode) + " must NOT fall back to browser"));
}
},
async test_malformed_native_results_fail_closed_and_record_diagnostics() {
let diags, entry, malformed_modes, mode, res;
malformed_modes = ["malformed-true", "malformed-null", "malformed-string", "malformed-partial-saved", "malformed-partial-cancelled", "malformed-partial-failed", "malformed-object", "malformed-saved-wrong-stage", "malformed-saved-no-http-status", "malformed-cancelled-with-backend-response", "malformed-failed-no-error-code", "malformed-failed-no-error-message", "malformed-invalid-elapsed-ms", "malformed-invalid-stage-timings", "malformed-inherited-properties"];
for (const mode of iterableValues(malformed_modes)) {
res = (await this.run_adapter("host", {tauri: true, native_mode: mode}));
assert.ok(!hasContent(res["result"]), ("Malformed mode " + String(mode) + " must fail closed"));
assert.deepEqual(res["error"], "history.exportFailed", ("Mode " + String(mode) + " error mismatch"));
assert.deepEqual(res["fetchCalls"], 0, ("Malformed mode " + String(mode) + " must NOT fall back to browser"));
diags = ((Object.hasOwn(res, "diagnostics") ? res["diagnostics"] : null) || []);
assert.deepEqual(diags.length, 1, ("Mode " + String(mode) + " should yield exactly 1 diagnostic record"));
entry = diags[0];
assert.deepEqual(entry["runtime"], "tauri");
assert.deepEqual(entry["status"], "failed");
assert.deepEqual(entry["stage"], "validate_native_result");
assert.deepEqual(entry["errorCode"], "MALFORMED_NATIVE_RESULT");
assert.deepEqual(entry["errorMessage"], "history.exportFailed");
assert.ok(!contains("foo", entry));
assert.ok(!contains("extra", entry));
}
},
async test_is_valid_native_download_result_unit_contract() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const validSaved = {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 50, stageTimings: [{ stage: "complete", elapsedMs: 10 }],
              errorCode: null, errorMessage: null,
            };
            const validCancelled = {
              status: "cancelled", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 30, stageTimings: [], errorCode: null, errorMessage: null,
            };
            const validFailed = {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 40, stageTimings: [],
              errorCode: "ERR_BACKEND", errorMessage: "Backend failed",
            };

            const checks = {
              validSaved: helper.isValidNativeDownloadResult(validSaved),
              validCancelled: helper.isValidNativeDownloadResult(validCancelled),
              validFailed: helper.isValidNativeDownloadResult(validFailed),
              primitiveNull: helper.isValidNativeDownloadResult(null),
              primitiveNumber: helper.isValidNativeDownloadResult(123),
              primitiveArray: helper.isValidNativeDownloadResult([]),
              missingKey: helper.isValidNativeDownloadResult({ status: "saved" }),
              inheritedKey: helper.isValidNativeDownloadResult(Object.create(validSaved)),
              invalidStatus: helper.isValidNativeDownloadResult({ ...validSaved, status: "unknown" }),
              savedWrongStage: helper.isValidNativeDownloadResult({ ...validSaved, stage: "choose_destination" }),
              savedNoHttpStatus: helper.isValidNativeDownloadResult({ ...validSaved, httpStatus: null }),
              cancelledWithBackend: helper.isValidNativeDownloadResult({ ...validCancelled, httpStatus: 200 }),
              failedNoErrorCode: helper.isValidNativeDownloadResult({ ...validFailed, errorCode: null }),
              failedNoErrorMessage: helper.isValidNativeDownloadResult({ ...validFailed, errorMessage: null }),
              invalidElapsedMs: helper.isValidNativeDownloadResult({ ...validSaved, elapsedMs: -1 }),
              invalidStageTimings: helper.isValidNativeDownloadResult({ ...validSaved, stageTimings: "invalid" }),
            };
            process.stdout.write(JSON.stringify(checks));
            `, String(this.helper)));
assert.ok(hasContent(result["validSaved"]));
assert.ok(hasContent(result["validCancelled"]));
assert.ok(hasContent(result["validFailed"]));
assert.ok(!hasContent(result["primitiveNull"]));
assert.ok(!hasContent(result["primitiveNumber"]));
assert.ok(!hasContent(result["primitiveArray"]));
assert.ok(!hasContent(result["missingKey"]));
assert.ok(!hasContent(result["inheritedKey"]));
assert.ok(!hasContent(result["invalidStatus"]));
assert.ok(!hasContent(result["savedWrongStage"]));
assert.ok(!hasContent(result["savedNoHttpStatus"]));
assert.ok(!hasContent(result["cancelledWithBackend"]));
assert.ok(!hasContent(result["failedNoErrorCode"]));
assert.ok(!hasContent(result["failedNoErrorMessage"]));
assert.ok(!hasContent(result["invalidElapsedMs"]));
assert.ok(!hasContent(result["invalidStageTimings"]));
},
async test_stage_timings_capped_at_16_on_frontend() {
let result;
result = (await this.run_node(`
            const helper = require(process.argv[1]);
            const ring = helper.createExportDiagnosticRing(64);
            const manyTimings = Array.from({ length: 25 }, (_, i) => ({
              stage: \`stage_\${i}\`,
              elapsedMs: i * 10,
            }));
            ring.push({
              timestamp: "2026-08-05T00:00:00Z",
              surface: "host",
              runtime: "tauri",
              format: "csv",
              source: "played",
              pageSize: 200,
              stage: "complete",
              status: "saved",
              elapsedMs: 250,
              stageTimings: manyTimings,
            });
            const snapshot = ring.snapshot();
            process.stdout.write(JSON.stringify({
              timingsCount: snapshot[0].stageTimings.length,
              firstStage: snapshot[0].stageTimings[0].stage,
              lastStage: snapshot[0].stageTimings[snapshot[0].stageTimings.length - 1].stage,
            }));
            `, String(this.helper)));
assert.deepEqual(result["timingsCount"], 16);
assert.deepEqual(result["firstStage"], "stage_0");
assert.deepEqual(result["lastStage"], "stage_15");
},
async run_export_guard_error(frontend, rejection_kind) {
let function_source, invocation, message_adapter, next_marker;
next_marker = (((frontend === "host")) ? "function diagnosticBrowserInfo" : "async function submitAddRequest");
function_source = (await this.function_source(this.sources[frontend], "async function exportHistory", next_marker));
invocation = (((frontend === "host")) ? "exportHistory(\"csv\", \"played\", 200)" : "exportHistory(\"csv\")");
message_adapter = (((frontend === "host")) ? "" : (await this.function_source(this.sources[frontend], "function setHistoryExportMessage", "function openHistoryExportDialog")));
return (await this.run_node(concatenate(concatenate(concatenate(concatenate(concatenate(`
            const helper = require(process.argv[2]);
            const { createExportGuard } = require(process.argv[1]);
            global.window = global;
            window.BilikaraExportDownload = helper;
            const button = {
              disabled: false,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            };
            const historyExportGuard = createExportGuard([button]);
            const messages = [];
            const elements = { historyExportStatus: { textContent: "" } };
            async function downloadHistoryExport() {
              if (process.argv[3] === "string") throw "native string failure";
              throw { code: "plain object" };
            }
            function normalizedHistoryExportSource(value) { return value; }
            function normalizedHistoryExportPageSize(value) { return value; }
            function historyExportSourceLabel(value) { return value; }
            function selectedHistoryExportSource() { return "played"; }
            function selectedHistoryExportPageSize() { return 200; }
            function closeConfirm() {}
            function setAppMessage(message, isError) { messages.push({ message, isError: Boolean(isError) }); }
            function t(key) { return key; }
            `, message_adapter), function_source), `
            `), invocation), `.then(() => {
              process.stdout.write(JSON.stringify({
                messages,
                busy: historyExportGuard.isBusy(),
                disabled: button.disabled,
                ariaBusy: button.attributes["aria-busy"] || null,
              }));
            });
            `), String(this.guard), String(this.helper), rejection_kind));
},
async test_export_guards_restore_buttons_and_show_normalized_errors() {
let frontend, result;
for (const frontend of iterableValues(this.sources)) {
{
result = (await this.run_export_guard_error(frontend, "string"));
assert.deepEqual(result["messages"].at((-1)), {["message"]: "native string failure", ["isError"]: true});
assert.ok(!hasContent(result["busy"]));
assert.ok(!hasContent(result["disabled"]));
assert.equal(result["ariaBusy"], null);
}
{
result = (await this.run_export_guard_error(frontend, "object"));
assert.deepEqual(result["messages"].at((-1)), {["message"]: "history.exportFailed", ["isError"]: true});
assert.ok(!hasContent(result["busy"]));
}
}
}
};
test("ExportDownloadBehaviorTest.test_error_normalization_covers_error_string_and_fallback_inputs", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_error_normalization_covers_error_string_and_fallback_inputs(); });
test("ExportDownloadBehaviorTest.test_native_result_supports_saved_cancelled_and_failed", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_native_result_supports_saved_cancelled_and_failed(); });
test("ExportDownloadBehaviorTest.test_export_diagnostic_ring_caps_at_64_entries_and_whitelists_fields", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_export_diagnostic_ring_caps_at_64_entries_and_whitelists_fields(); });
test("ExportDownloadBehaviorTest.test_browser_blob_download_uses_content_disposition_and_cleans_up", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_browser_blob_download_uses_content_disposition_and_cleans_up(); });
test("ExportDownloadBehaviorTest.test_browser_blob_download_surfaces_json_and_non_json_errors", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_browser_blob_download_surfaces_json_and_non_json_errors(); });
test("ExportDownloadBehaviorTest.test_adapter_routing_is_explicit_for_tauri_host_web_host_and_remote", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_adapter_routing_is_explicit_for_tauri_host_web_host_and_remote(); });
test("ExportDownloadBehaviorTest.test_native_saved_cancelled_and_failure_results_are_observable", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_native_saved_cancelled_and_failure_results_are_observable(); });
test("ExportDownloadBehaviorTest.test_tauri_command_unavailable_matching_is_narrow", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_tauri_command_unavailable_matching_is_narrow(); });
test("ExportDownloadBehaviorTest.test_malformed_native_results_fail_closed_and_record_diagnostics", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_malformed_native_results_fail_closed_and_record_diagnostics(); });
test("ExportDownloadBehaviorTest.test_is_valid_native_download_result_unit_contract", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_is_valid_native_download_result_unit_contract(); });
test("ExportDownloadBehaviorTest.test_stage_timings_capped_at_16_on_frontend", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_stage_timings_capped_at_16_on_frontend(); });
test("ExportDownloadBehaviorTest.test_export_guards_restore_buttons_and_show_normalized_errors", async () => { const instance = Object.create(ExportDownloadBehaviorTest); await instance.setUpClass(); await instance.test_export_guards_restore_buttons_and_show_normalized_errors(); });
