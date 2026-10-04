import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, sourceIndex, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const FrontendExportBehaviorTest = {
async setUpClass() {
let root;
root = path.resolve(path.resolve(__file__), "..", "..");
this.sources = {["host"]: readFileSync(path.join(path.join(root, "static"), "app.js"), "utf8"), ["remote"]: readFileSync(path.join(path.join(root, "static"), "remote.js"), "utf8")};
},
async function_source(source, marker, next_marker) {
let end, start;
start = sourceIndex(source, marker);
end = sourceIndex(source, next_marker, start);
return source.slice(start, end);
},
async test_playlist_export_routing_is_explicit_by_surface() {
let export_source, host_export, remote_export;
host_export = (await this.function_source(this.sources["host"], "async function downloadHistoryExport", "async function exportHistory"));
remote_export = (await this.function_source(this.sources["remote"], "async function downloadHistoryExport", "elements.openRatingButton"));
for (const export_source of iterableValues([host_export, remote_export])) {
assert.ok(contains("new URLSearchParams", export_source));
assert.ok(contains("format: normalizedFormat", export_source));
assert.ok(contains("source: normalizedSource", export_source));
assert.ok(contains("page_size: String(normalizedPageSize)", export_source));
assert.ok(contains("/api/playlist/export?", export_source));
assert.ok(contains("exportDownload.downloadBrowserFile(exportUrl", export_source));
assert.ok(contains("headers: clientHeaders()", export_source));
assert.ok(!contains("triggerAttachmentDownload", export_source));
assert.ok(!contains("window.location.hostname", export_source));
}
assert.ok(contains("await saveTauriBackendDownload(exportUrl)", host_export));
assert.ok(contains("tauriStatus === \"saved\"", host_export));
assert.ok(!contains("saveTauriBackendDownload", remote_export));
assert.ok(!contains("__TAURI__", remote_export));
},
async test_only_host_native_helper_invokes_typed_save_command() {
let helper;
helper = (await this.function_source(this.sources["host"], "async function saveTauriBackendDownload", "async function setTauriWindowFullscreen"));
assert.ok(contains("invoke(\"save_backend_download\"", helper));
assert.ok(contains("path,", helper));
assert.ok(contains("body,", helper));
assert.ok(contains("clientId: state.clientId", helper));
assert.ok(contains("nativeDownloadStatus(result, fallback)", helper));
assert.ok(contains("normalizedErrorMessage(error, fallback)", helper));
assert.ok(!contains("saveTauriBackendDownload", this.sources["remote"]));
},
async test_diagnostics_package_uses_tauri_save_dialog_before_browser_blob() {
let download_source, response_source, source;
source = this.sources["host"];
response_source = (await this.function_source(source, "async function diagnosticResponse", "async function generateDiagnosticsMarkdown"));
download_source = (await this.function_source(source, "async function downloadDiagnosticsPackage", "async function resetRuntimeData"));
assert.ok(contains("\"/api/diagnostics/package\"", download_source));
assert.ok(contains("await saveTauriBackendDownload(", download_source));
assert.ok(contains("browser: diagnosticBrowserInfo()", download_source));
assert.ok(contains("export_diagnostics: exportDiagnostics", download_source));
assert.ok(contains("internet_remote_diagnostics: internetRemoteDiagnosticsSnapshot()", download_source));
assert.ok(contains("if (tauriStatus !== null)", download_source));
assert.ok(contains("tauriStatus === \"saved\"", download_source));
assert.ok(contains("await diagnosticResponse(\"/api/diagnostics/package\")", download_source));
assert.ok(contains("method: \"POST\"", response_source));
assert.ok(contains("await response.blob()", download_source));
assert.ok(!contains("triggerAttachmentDownload", download_source));
assert.ok(sourceIndex(download_source, "await saveTauriBackendDownload(") < sourceIndex(download_source, "await diagnosticResponse(\"/api/diagnostics/package\")"));
},
async test_export_guard_waits_for_download_response() {
let download_source, export_source, name, source;
for (const [name, source] of iterableValues(Object.entries(this.sources))) {
{
export_source = (await this.function_source(source, "async function exportHistory", (((name === "host")) ? "function diagnosticBrowserInfo" : "async function submitAddRequest")));
assert.ok(contains("historyExportGuard.run", export_source));
assert.ok(contains("await downloadHistoryExport", export_source));
assert.ok(contains("normalizedErrorMessage", export_source));
assert.ok(sourceIndex(export_source, "if (!saved)") < sourceIndex(export_source, "t(\"history.csvDownloadStarted\""));
download_source = (await this.function_source(source, "async function downloadHistoryExport", "async function exportHistory"));
assert.ok(contains("async function downloadHistoryExport", download_source));
assert.ok(contains("downloadBrowserFile", download_source));
}
}
},
async test_diagnostics_copy_uses_shared_clipboard_and_retry_abstraction() {
let copy_source, source;
source = this.sources["host"];
copy_source = (await this.function_source(source, "function diagnosticsCopyController", "async function copyDiagnosticsMarkdown"));
assert.ok(contains("window.BilikaraDiagnosticsCopy", copy_source));
assert.ok(contains("helper.createRetryController", copy_source));
assert.ok(contains("helper.copyText(markdown", copy_source));
assert.ok(!contains("navigator.clipboard", copy_source));
}
};
test("FrontendExportBehaviorTest.test_playlist_export_routing_is_explicit_by_surface", async () => { const instance = Object.create(FrontendExportBehaviorTest); await instance.setUpClass(); await instance.test_playlist_export_routing_is_explicit_by_surface(); });
test("FrontendExportBehaviorTest.test_only_host_native_helper_invokes_typed_save_command", async () => { const instance = Object.create(FrontendExportBehaviorTest); await instance.setUpClass(); await instance.test_only_host_native_helper_invokes_typed_save_command(); });
test("FrontendExportBehaviorTest.test_diagnostics_package_uses_tauri_save_dialog_before_browser_blob", async () => { const instance = Object.create(FrontendExportBehaviorTest); await instance.setUpClass(); await instance.test_diagnostics_package_uses_tauri_save_dialog_before_browser_blob(); });
test("FrontendExportBehaviorTest.test_export_guard_waits_for_download_response", async () => { const instance = Object.create(FrontendExportBehaviorTest); await instance.setUpClass(); await instance.test_export_guard_waits_for_download_response(); });
test("FrontendExportBehaviorTest.test_diagnostics_copy_uses_shared_clipboard_and_retry_abstraction", async () => { const instance = Object.create(FrontendExportBehaviorTest); await instance.setUpClass(); await instance.test_diagnostics_copy_uses_shared_clipboard_and_retry_abstraction(); });
