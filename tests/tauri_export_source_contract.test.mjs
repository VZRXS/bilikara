import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, sourceIndex } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const TauriExportSourceTest = {
async setUpClass() {
let root;
root = path.resolve(path.resolve(__file__), "..", "..");
this.main_source = readFileSync(path.join(path.join(path.join(root, "src-tauri"), "src"), "desktop.rs"), "utf8");
this.backend_source = readFileSync(path.join(path.join(path.join(root, "src-tauri"), "src"), "backend_process.rs"), "utf8");
this.download_source = readFileSync(path.join(path.join(path.join(root, "src-tauri"), "src"), "backend_download.rs"), "utf8");
this.cargo_source = readFileSync(path.join(path.join(root, "src-tauri"), "Cargo.toml"), "utf8");
this.capability_source = readFileSync(path.join(path.join(path.join(root, "src-tauri"), "capabilities"), "main.json"), "utf8");
this.export_permission_source = readFileSync(path.join(path.join(path.join(root, "src-tauri"), "permissions"), "export.toml"), "utf8");
},
async test_dialog_plugin_and_native_save_command_are_registered() {
assert.ok(contains("tauri-plugin-dialog = \"2\"", this.cargo_source));
assert.ok(contains(".plugin(tauri_plugin_dialog::init())", this.main_source));
assert.ok(contains("save_backend_download", this.main_source));
assert.ok(contains("\"allow-save-backend-download\"", this.capability_source));
assert.ok(contains("identifier = \"allow-save-backend-download\"", this.export_permission_source));
assert.ok(contains("commands.allow = [\"save_backend_download\"]", this.export_permission_source));
},
async test_native_download_is_limited_to_export_endpoints() {
assert.ok(contains("request_url.path() == \"/api/playlist/export\"", this.download_source));
assert.ok(contains("request_url.path() == \"/api/diagnostics/package\"", this.download_source));
assert.ok(contains("Err(\"不允许保存该后端端点\"", this.download_source));
},
async test_native_download_requests_backend_before_dialog_and_writes_off_thread() {
let command, command_end, command_start;
assert.ok(contains(".blocking_save_file()", this.download_source));
assert.ok(contains("final_download_target_path(", this.download_source));
assert.ok(contains("write_backend_download(&final_target_path, &response.body, !extension_corrected)", this.download_source));
command_start = sourceIndex(this.download_source, "async fn save_backend_download");
command_end = sourceIndex(this.download_source, "#[cfg(test)]", command_start);
command = this.download_source.slice(command_start, command_end);
assert.ok(sourceIndex(command, "\"validate_request\"") < sourceIndex(command, "\"authorize_window\""));
assert.ok(sourceIndex(command, "\"authorize_window\"") < sourceIndex(command, "\"request_backend\""));
assert.ok(sourceIndex(command, "\"request_backend\"") < sourceIndex(command, "\"validate_response\""));
assert.ok(sourceIndex(command, "\"validate_response\"") < sourceIndex(command, "\"choose_destination\""));
assert.ok(sourceIndex(command, "\"choose_destination\"") < sourceIndex(command, "\"write_file\""));
assert.ok(sourceIndex(command, "\"validate_response\"") < sourceIndex(command, ".blocking_save_file()"));
assert.ok(contains("export_dialog_spec", this.download_source));
assert.ok(contains("tauri::async_runtime::spawn_blocking", command));
},
async test_physical_adapter_page_can_use_tauri_ipc_with_runtime_origin_check() {
assert.ok(contains("\"http://*:*/*\"", this.capability_source));
assert.ok(contains("window_origin_authorized(window_url.as_str(), &base_url)", this.download_source));
assert.ok(contains("staged_error(\"authorize_window\", \"当前页面无权调用本机导出\")", this.download_source));
},
async test_native_result_is_typed_and_does_not_return_a_path() {
assert.ok(contains("struct SaveBackendDownloadResult", this.download_source));
assert.ok(contains("SaveBackendDownloadStatus::Saved", this.download_source));
assert.ok(contains("SaveBackendDownloadStatus::Cancelled", this.download_source));
assert.ok(!contains("Result<bool, String>", this.download_source));
},
async test_stdout_reader_drains_after_first_ready_event() {
let reader_end, reader_start;
assert.ok(contains("fn drain_backend_stdout", this.backend_source));
assert.ok(contains("let mut ready_handled = false", this.backend_source));
assert.ok(contains("process_backend_stdout_line", this.backend_source));
reader_start = sourceIndex(this.backend_source, "fn drain_backend_stdout");
reader_end = sourceIndex(this.backend_source, "pub(crate) fn launch", reader_start);
assert.ok(!contains("break;", this.backend_source.slice(reader_start, reader_end)));
}
};
test("TauriExportSourceTest.test_dialog_plugin_and_native_save_command_are_registered", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_dialog_plugin_and_native_save_command_are_registered(); });
test("TauriExportSourceTest.test_native_download_is_limited_to_export_endpoints", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_native_download_is_limited_to_export_endpoints(); });
test("TauriExportSourceTest.test_native_download_requests_backend_before_dialog_and_writes_off_thread", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_native_download_requests_backend_before_dialog_and_writes_off_thread(); });
test("TauriExportSourceTest.test_physical_adapter_page_can_use_tauri_ipc_with_runtime_origin_check", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_physical_adapter_page_can_use_tauri_ipc_with_runtime_origin_check(); });
test("TauriExportSourceTest.test_native_result_is_typed_and_does_not_return_a_path", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_native_result_is_typed_and_does_not_return_a_path(); });
test("TauriExportSourceTest.test_stdout_reader_drains_after_first_ready_event", async () => { const instance = Object.create(TauriExportSourceTest); await instance.setUpClass(); await instance.test_stdout_reader_drains_after_first_ready_event(); });
