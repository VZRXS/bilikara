import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, iterableValues, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const PresentationTauriSourceTest = {
async setUpClass() {
this.tauri = path.join(ROOT, "src-tauri");
this.main = readFileSync(path.join(path.join(this.tauri, "src"), "desktop.rs"), "utf8");
this.backend = readFileSync(path.join(path.join(this.tauri, "src"), "backend_process.rs"), "utf8");
this.diagnostics = readFileSync(path.join(path.join(this.tauri, "src"), "desktop_diagnostics.rs"), "utf8");
this.presentation = readFileSync(path.join(path.join(this.tauri, "src"), "presentation.rs"), "utf8");
this.window_lifecycle = readFileSync(path.join(path.join(this.tauri, "src"), "window_lifecycle.rs"), "utf8");
this.build = readFileSync(path.join(this.tauri, "build.rs"), "utf8");
this.configuration = JSON.parse(readFileSync(path.join(this.tauri, "tauri.conf.json"), "utf8"));
this.main_capability = JSON.parse(readFileSync(path.join(path.join(this.tauri, "capabilities"), "main.json"), "utf8"));
this.controller_capability = JSON.parse(readFileSync(path.join(path.join(this.tauri, "capabilities"), "controller.json"), "utf8"));
},
async test_session_names_one_host_authority_and_renderer() {
assert.ok(contains("playback_authority: PlaybackAuthorityIdentity::Host", this.presentation));
assert.ok(contains("media_renderer_owner: MediaRendererOwner::Host", this.presentation));
assert.ok(!contains("StageSession", this.presentation));
assert.ok(!contains("WebviewWindowBuilder::new(app, \"stage\"", this.presentation));
assert.ok(contains("WebviewWindowBuilder::new(app, \"controller\"", this.presentation));
},
async test_typed_event_and_command_contract_is_closed() {
let event, variant;
for (const event of iterableValues(["bilikara-presentation-state", "bilikara-presentation-host-composition", "bilikara-presentation-host-command", "bilikara-presentation-playback-state", "bilikara-presentation-output-state", "bilikara-presentation-output-request"])) {
assert.ok(contains(event, this.presentation));
}
assert.ok(contains("tag = \"type\"", this.presentation));
assert.ok(contains("rename_all = \"camelCase\"", this.presentation));
assert.ok(contains("rename_all_fields = \"camelCase\"", this.presentation));
assert.ok(contains("deny_unknown_fields", this.presentation));
for (const variant of iterableValues(["Play", "Pause", "SeekRelative", "SeekAbsolute", "NextTrack", "SetVolume"])) {
assert.match(this.presentation, new RegExp(("\\b" + String(variant) + "\\b"),""));
}
assert.ok(contains("MAX_PENDING_COMMANDS", this.presentation));
assert.ok(contains("MAX_SAFE_JS_INTEGER", this.presentation));
assert.ok(contains("request.sequence != expected_sequence", this.presentation));
},
async test_capabilities_keep_controller_narrow_and_remove_direct_fullscreen() {
let controller_permissions, main_permissions;
main_permissions = new Set((Symbol.iterator in Object(this.main_capability["permissions"]) ? this.main_capability["permissions"] : Object.keys(this.main_capability["permissions"])));
controller_permissions = new Set((Symbol.iterator in Object(this.controller_capability["permissions"]) ? this.controller_capability["permissions"] : Object.keys(this.controller_capability["permissions"])));
assert.ok(!contains("core:window:allow-set-fullscreen", main_permissions));
assert.ok(contains("allow-set-window-fullscreen", main_permissions));
assert.deepEqual(controller_permissions, new Set(["core:event:allow-listen", "core:event:allow-unlisten", "allow-get-presentation-session", "allow-mark-presentation-controller-ready", "allow-request-presentation-output-state", "allow-record-presentation-video-geometry", "allow-deactivate-local-presentation"]));
assert.ok(contains("allow-publish-presentation-output-state", main_permissions));
assert.ok(!contains("allow-request-presentation-output-state", main_permissions));
assert.ok(!contains("allow-record-presentation-video-geometry", main_permissions));
assert.ok(!contains("allow-publish-presentation-output-state", controller_permissions));
assert.ok(!contains("core:default", controller_permissions));
assert.ok(!contains("core:event:allow-emit", controller_permissions));
assert.ok(!contains("core:event:allow-emit-to", controller_permissions));
assert.ok(contains("http://*:*/*", this.main_capability["remote"]["urls"]));
assert.ok(contains("http://*:*/*", this.controller_capability["remote"]["urls"]));
assert.ok(contains("window_origin_authorized(window_url.as_str(), &backend_url)", this.presentation));
assert.ok(contains(".on_navigation(move |candidate|", this.presentation));
assert.match(this.presentation, new RegExp("window_origin_authorized\\(\\s*candidate\\.as_str\\(\\),\\s*allowed_origin\\.as_str\\(\\),?\\s*\\)",""));
},
async test_command_manifest_handler_and_generated_permissions_are_synchronized() {
let command, commands, handler, handler_match, permission, text;
commands = ["set_window_fullscreen", "get_presentation_displays", "get_presentation_session", "show_presentation_display_identifiers", "dismiss_presentation_display_identifiers", "activate_local_presentation", "mark_presentation_host_ready", "mark_presentation_controller_ready", "send_presentation_command", "acknowledge_presentation_command", "publish_presentation_playback_state", "publish_presentation_output_state", "request_presentation_output_state", "record_presentation_video_geometry", "deactivate_local_presentation"];
handler_match = this.main.match(new RegExp("tauri::generate_handler!\\[(.*?)\\]\\)","s"));
assert.notEqual(handler_match, null);
handler = handler_match[1];
for (const command of iterableValues(commands)) {
assert.ok(contains(("\"" + String(command) + "\""), this.build));
assert.ok(contains(command, handler));
permission = path.join(path.join(path.join(this.tauri, "permissions"), "autogenerated"), (String(command) + ".toml"));
assert.ok(hasContent((existsSync(permission) && statSync(permission).isFile())), command);
text = readFileSync(permission, "utf8");
assert.ok(contains(("commands.allow = [\"" + String(command) + "\"]"), text));
}
},
async test_output_state_relay_is_bounded_generation_checked_and_role_scoped() {
let publish, request, validation;
publish = this.presentation.slice(sourceIndex(this.presentation, "pub(crate) fn publish_presentation_output_state"), sourceIndex(this.presentation, "pub(crate) fn request_presentation_output_state"));
assert.ok(contains("authorize_window(&window, &backend, &[\"main\"])?", publish));
assert.ok(contains("validate_output_state(&envelope, generation)?", publish));
assert.ok(contains("state.ensure_output_generation(generation)?", publish));
assert.ok(contains("app.emit_to(\"controller\", OUTPUT_STATE_EVENT, &envelope)", publish));
request = this.presentation.slice(sourceIndex(this.presentation, "pub(crate) fn request_presentation_output_state"), sourceIndex(this.presentation, "pub(crate) fn deactivate_local_presentation"));
assert.ok(contains("authorize_window(&window, &backend, &[\"controller\"])?", request));
assert.ok(contains("state.ensure_output_generation(generation)?", request));
assert.ok(contains("\"main\"", request));
assert.ok(contains("OUTPUT_REQUEST_EVENT", request));
validation = this.presentation.slice(sourceIndex(this.presentation, "fn validate_output_state"), sourceIndex(this.presentation, "fn close_controller("));
assert.ok(contains("Some(\"master-state\")", validation));
assert.ok(contains("envelope[\"payload\"][\"scene\"][\"generation\"].as_u64() != Some(generation)", validation));
assert.ok(contains("size > MAX_OUTPUT_STATE_BYTES", validation));
assert.ok(contains("const MAX_OUTPUT_STATE_BYTES: usize = 2 * 1024 * 1024;", this.presentation));
},
async test_video_geometry_log_is_audience_scoped_and_generation_checked() {
let command, compact, field;
command = splitOnce(splitOnce(this.presentation, "pub(crate) async fn record_presentation_video_geometry")[1], "pub(crate) fn deactivate_local_presentation")[0];
assert.ok(contains("authorize_window(&window, &backend, &[\"controller\"])?", command));
assert.ok(contains("state.ensure_output_generation(generation)?", command));
assert.ok(contains("geometry.validate()?", command));
compact = command.replaceAll(new RegExp("\\s+","g"), "");
assert.ok(sourceIndex(compact, "geometry.validate()?") < sourceIndex(compact, "window.inner_size()"));
for (const field of iterableValues(["window.inner_size()", "window.outer_size()", "window.scale_factor()"])) {
assert.ok(contains(field, compact));
}
assert.ok(contains("append_desktop_diagnostic", command));
assert.ok(contains("\"presentation_video_geometry\"", command));
assert.ok(!contains("std::fs", command));
},
async test_windows_main_and_audience_windows_share_one_webview_store() {
let argument, builder, checkedArguments, setup, storage, window, windows, windows_config;
windows = JSON.parse(readFileSync(path.join(this.tauri, "tauri.windows.conf.json"), "utf8"))["app"]["windows"];
assert.deepEqual(Array.from(Array.from(iterableValues(windows))).map((window) => window["label"]), ["main"]);
assert.ok(!hasContent(windows[0]["create"]));
storage = readFileSync(path.join(path.join(this.tauri, "src"), "desktop_storage.rs"), "utf8");
builder = storage.slice(sourceIndex(storage, "pub(crate) fn create_windows_main_webview_window"), undefined);
assert.ok(contains("webview_directory(app.config())", builder));
assert.ok(contains(".data_directory(directory)", builder));
setup = this.main.slice(sourceIndex(this.main, ".setup(move |app|"), undefined);
assert.ok(sourceIndex(setup, "crate::desktop_storage::create_windows_main_webview_window(app)?") < sourceIndex(setup, "app.get_webview_window(\"main\")"));
assert.deepEqual(countOccurrences(this.presentation, "builder.data_directory(crate::desktop_storage::webview_directory(app.config())?)"), 2);
assert.ok(contains(".additional_browser_args(WINDOWS_WEBVIEW_BROWSER_ARGS)", builder));
assert.deepEqual(countOccurrences(this.presentation, "builder.additional_browser_args(crate::desktop_storage::WINDOWS_WEBVIEW_BROWSER_ARGS)"), 2);
checkedArguments = splitOnce(storage.slice(sourceIndex(storage, "WINDOWS_WEBVIEW_BROWSER_ARGS: &str = "), undefined), `
`)[0];
for (const argument of iterableValues(["--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection", "--autoplay-policy=no-user-gesture-required", "--disable-direct-composition-video-overlays"])) {
assert.ok(contains(argument, checkedArguments));
}
windows_config = readFileSync(path.join(this.tauri, "tauri.windows.conf.json"), "utf8");
assert.ok(!contains("additionalBrowserArgs", windows_config));
},
async test_display_identifiers_are_ordered_native_overlays_with_bounded_lifetime() {
let identifiers, main_permissions;
identifiers = this.presentation.slice(sourceIndex(this.presentation, "fn validate_display_identifier_order"), sourceIndex(this.presentation, "fn capture_host_placement"));
assert.ok(contains("requested_ids.len() != available_ids.len()", identifiers));
assert.ok(contains("seen.insert(requested_id.as_str())", identifiers));
assert.ok(contains("order_index + 1", identifiers));
assert.ok(contains("record.display.controller", identifiers));
assert.ok(contains("record.display.selectable", identifiers));
assert.ok(contains(".always_on_top(true)", identifiers));
assert.ok(contains(".focusable(false)", identifiers));
assert.ok(contains(".skip_taskbar(true)", identifiers));
assert.ok(contains("const DISPLAY_IDENTIFIER_WIDTH: f64 = 128.0", this.presentation));
assert.ok(contains("const DISPLAY_IDENTIFIER_HEIGHT: f64 = 128.0", this.presentation));
assert.ok(contains(".transparent(true)", identifiers));
assert.ok(contains(".shadow(false)", identifiers));
assert.ok(contains("tauri::window::Color(0, 0, 0, 0)", identifiers));
assert.ok(contains("window.set_ignore_cursor_events(true)", identifiers));
assert.ok(contains("display_identifier_margin_offset", identifiers));
assert.ok(!contains("saturating_sub(width) / 2", identifiers));
assert.ok(contains("DISPLAY_IDENTIFIER_LIFETIME", identifiers));
assert.ok(contains("close_display_identifier_labels(&expiry_app", identifiers));
main_permissions = new Set((Symbol.iterator in Object(this.main_capability["permissions"]) ? this.main_capability["permissions"] : Object.keys(this.main_capability["permissions"])));
assert.ok(contains("allow-show-presentation-display-identifiers", main_permissions));
assert.ok(contains("allow-dismiss-presentation-display-identifiers", main_permissions));
assert.ok(!contains("allow-show-presentation-display-identifiers", this.controller_capability["permissions"]));
assert.ok(hasContent(this.configuration["app"]["macOSPrivateApi"]));
},
async test_only_main_is_static_and_audience_output_is_dynamic() {
let finalization, fullscreen, placement, show, window;
assert.deepEqual(Array.from(Array.from(iterableValues(this.configuration["app"]["windows"]))).map((window) => window["label"]), ["main"]);
assert.deepEqual(new Set((Symbol.iterator in Object(this.configuration["app"]["security"]["capabilities"]) ? this.configuration["app"]["security"]["capabilities"] : Object.keys(this.configuration["app"]["security"]["capabilities"]))), new Set(["main", "controller"]));
assert.ok(contains("visible(false)", this.presentation));
placement = sourceIndex(this.presentation, "controller.set_position(position)");
fullscreen = sourceIndex(this.presentation, "controller.set_fullscreen(true)");
show = sourceIndex(this.presentation, "controller.show()");
assert.ok(placement < show);
assert.ok(fullscreen < show);
finalization = this.presentation.slice(sourceIndex(this.presentation, "fn complete_activation_if_ready"), sourceIndex(this.presentation, "fn run_activation_readiness_step"));
assert.ok(!contains("host.set_fullscreen(true)", finalization));
},
async test_audience_output_is_frameless_and_fills_the_selected_monitor() {
let placement;
assert.ok(contains(".title(\"Bilikara Stage\")", this.presentation));
assert.ok(contains(".decorations(false)", this.presentation));
assert.ok(contains(".resizable(false)", this.presentation));
placement = this.presentation.slice(sourceIndex(this.presentation, "fn place_controller_for_activation"), sourceIndex(this.presentation, "pub(crate) fn authorize_window"));
assert.ok(contains("controller.set_size(size)", placement));
assert.ok(contains("controller.set_position(position)", placement));
assert.ok(contains("controller.set_fullscreen(true)", placement));
},
async test_activation_uses_tauri_async_executor_before_controller_construction() {
let activation, end, start;
start = sourceIndex(this.presentation, `#[tauri::command(async)]
pub(crate) fn activate_local_presentation`);
end = sourceIndex(this.presentation, "fn complete_activation_if_ready");
activation = this.presentation.slice(start, end);
assert.ok(contains("ActivationAttemptGuard::new", activation));
assert.ok(contains("run_on_main_thread_with_result", activation));
assert.ok(sourceIndex(activation, "create_controller_window(") < sourceIndex(activation, "run_on_main_thread_with_result("));
assert.ok(sourceIndex(activation, "place_controller_for_activation(") < sourceIndex(activation, "mark_activation_published("));
assert.ok(sourceIndex(activation, "place_host_for_activation(") < sourceIndex(activation, "mark_activation_published("));
assert.ok(contains("if let Some(host_monitor) = host_target_monitor.as_ref()", activation));
assert.ok(sourceIndex(activation, "|| controller.show()") < sourceIndex(activation, "mark_activation_published("));
assert.ok(sourceIndex(activation, "emit_composition(") < sourceIndex(activation, "mark_activation_published("));
assert.ok(sourceIndex(activation, "mark_activation_published(") < sourceIndex(activation, "start_generation_watchers("));
assert.ok(contains("complete_activation_if_ready", activation));
},
async test_presentation_native_lifecycle_is_recorded_in_diagnostic_logs() {
let lifecycle_result, stage;
assert.ok(contains("join(\"runtime\")", this.diagnostics));
assert.ok(contains("join(\"logs\")", this.diagnostics));
assert.ok(contains("install_runtime_desktop_diagnostics", this.main));
assert.ok(contains("sender.try_send(record)", this.diagnostics));
assert.ok(!contains("try_state::<DesktopStartupLog>", this.main));
assert.ok(contains("\"presentation_window_destroyed\"", this.window_lifecycle));
for (const stage of iterableValues(["activation_command_begin", "controller_build_begin", "controller_build_end", "main_thread_result_wait_begin", "main_thread_operation_begin", "window_mutation_begin", "window_mutation_end", "recovery_claimed", "recovery_restore_end", "app_shutdown_controller_close_end"])) {
assert.ok(contains(("\"" + String(stage) + "\""), this.presentation));
}
lifecycle_result = this.presentation.slice(sourceIndex(this.presentation, "fn deliver_main_thread_operation_result"), sourceIndex(this.presentation, "fn run_on_main_thread_with_result"));
assert.ok(sourceIndex(lifecycle_result, "sender.send(result)") < sourceIndex(lifecycle_result, "completion_diagnostic(succeeded)"));
},
async test_stale_activation_cannot_mutate_after_recovery_claim() {
let finalization, mutation, settlement;
mutation = this.presentation.slice(sourceIndex(this.presentation, "fn run_activation_window_mutation"), sourceIndex(this.presentation, "fn place_host_for_activation"));
assert.ok(sourceIndex(mutation, "ensure_activation_native_owner") < sourceIndex(mutation, "operation()"));
finalization = this.presentation.slice(sourceIndex(this.presentation, "fn complete_activation_if_ready"), sourceIndex(this.presentation, "fn run_activation_readiness_step"));
assert.ok(sourceIndex(finalization, "ensure_activation_native_owner") < sourceIndex(finalization, "complete_activation(generation)"));
assert.ok(!contains("host.set_fullscreen(true)", finalization));
settlement = this.presentation.slice(sourceIndex(this.presentation, "fn settle_activation_attempt"), sourceIndex(this.presentation, "fn complete_activation_if_ready"));
assert.ok(sourceIndex(settlement, "activation_attempt.finish()") < sourceIndex(settlement, "force_finalize_recovery"));
},
async test_display_identity_is_native_and_unsupported_platforms_fail_closed() {
let windows_metadata;
assert.ok(contains("DISPLAYCONFIG_TARGET_DEVICE_NAME", this.presentation));
assert.ok(contains("target.monitorDevicePath", this.presentation));
assert.ok(contains("macos-uuid:", this.presentation));
assert.ok(contains("localizedName", this.presentation));
assert.ok(contains("is_in_mirror_set", this.presentation));
assert.ok(contains("source_path_counts", this.presentation));
assert.ok(contains("DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL", this.presentation));
assert.ok(contains("display.is_builtin()", this.presentation));
windows_metadata = this.presentation.slice(sourceIndex(this.presentation, "fn windows_display_metadata"), sourceIndex(this.presentation, "fn macos_display_uuid"));
assert.ok(contains("raw_source_path_counts", windows_metadata));
assert.ok(sourceIndex(windows_metadata, "raw_source_path_counts.entry(source_key)") < sourceIndex(windows_metadata, "DisplayConfigGetDeviceInfo(&mut source.header)"));
assert.ok(contains("display_source_is_mirrored(", windows_metadata));
assert.ok(contains("entry.identity_stable = !mirrored", this.presentation));
assert.ok(contains("let main_display_id = CGDisplay::main().id", this.presentation));
assert.ok(contains("display_id == main_display_id", this.presentation));
assert.ok(contains("Presentation display discovery failed; recovering the current generation", this.presentation));
assert.ok(contains(`platform_name,
            false,`, this.presentation));
assert.ok(contains("let current_monitor = main_window", this.presentation));
assert.ok(contains(".current_monitor()", this.presentation));
assert.ok(contains("(!controller || controller_has_alternative)", this.presentation));
},
async test_host_moves_only_when_output_uses_its_current_display() {
let activation, recovery;
activation = this.presentation.slice(sourceIndex(this.presentation, "pub(crate) fn activate_local_presentation"), sourceIndex(this.presentation, "fn settle_activation_attempt"));
assert.ok(contains("if target.display.id == current_host.display.id", activation));
assert.ok(contains(".find(|record| record.display.built_in)", activation));
assert.ok(contains("host_display_id: Option<String>", activation));
assert.ok(contains("if let Some(host_monitor) = host_target_monitor.as_ref()", activation));
assert.ok(contains("host_target.is_some()", activation));
assert.ok(sourceIndex(activation, "close_display_identifier_windows(&app)") < sourceIndex(activation, "state.begin_activation("));
recovery = this.presentation.slice(sourceIndex(this.presentation, "fn restore_recovery_window"), sourceIndex(this.presentation, "fn finalize_recovery"));
assert.ok(contains("recovery_host_was_relocated", recovery));
assert.ok(contains("mark_host_window_restored", recovery));
},
async test_recovery_and_playback_publication_have_bounded_failure_transactions() {
assert.ok(contains("RECOVERY_FINALIZATION_TIMEOUT", this.presentation));
assert.ok(contains("start_recovery_finalization_deadline", this.presentation));
assert.ok(contains("force_finalize_recovery", this.presentation));
assert.ok(contains("force_complete_recovery", this.presentation));
assert.ok(contains("rollback_playback_state", this.presentation));
assert.ok(contains("previous_sequence", this.presentation));
assert.ok(contains("window.inner_size()", this.presentation));
assert.ok(!contains("size: window.outer_size()", this.presentation));
},
async test_claimed_readiness_publication_failures_enter_activation_recovery() {
let controller, host, source;
host = this.presentation.slice(sourceIndex(this.presentation, "pub(crate) fn mark_presentation_host_ready"), sourceIndex(this.presentation, "pub(crate) fn mark_presentation_controller_ready"));
controller = this.presentation.slice(sourceIndex(this.presentation, "pub(crate) fn mark_presentation_controller_ready"), sourceIndex(this.presentation, "pub(crate) fn send_presentation_command"));
for (const source of iterableValues([host, controller])) {
assert.ok(contains("run_activation_readiness_step(", source));
assert.ok(contains("should_finalize", source));
assert.ok(contains("recover_after_activation_failure", source));
}
},
async test_controller_loss_recovers_only_presentation_and_main_keeps_pr95_shutdown() {
let controller_block, event, graceful, shutdown, shutdown_start;
assert.ok(contains(".on_window_event(window_lifecycle::handle_window_event)", this.main));
event = this.window_lifecycle;
assert.ok(contains("window.label() == \"controller\"", event));
assert.ok(contains("presentation::handle_controller_destroyed", event));
assert.ok(contains("window.label() == \"main\"", event));
assert.ok(contains("presentation::prepare_app_shutdown", event));
assert.ok(contains("backend_process::shutdown", event));
assert.ok(sourceIndex(event, "presentation::prepare_app_shutdown") < sourceIndex(event, "backend_process::shutdown"));
shutdown_start = sourceIndex(this.backend, "pub(crate) fn shutdown");
shutdown = this.backend.slice(shutdown_start, undefined);
assert.ok(contains("wait_for_active_backend_downloads", shutdown));
assert.ok(contains("request_backend_shutdown", shutdown));
assert.ok(contains("wait_for_child_exit", shutdown));
graceful = sourceIndex(shutdown, "wait_for_child_exit");
assert.ok(contains("return;", shutdown.slice(graceful, undefined)));
assert.ok(sourceIndex(shutdown, "wait_for_active_backend_downloads") < sourceIndex(shutdown, "request_backend_shutdown"));
assert.ok(sourceIndex(shutdown, "request_backend_shutdown") < sourceIndex(shutdown, "child.kill()"));
controller_block = event.slice(sourceIndex(event, "window.label() == \"controller\""), sourceIndex(event, "window.label() == \"main\""));
assert.ok(!contains("backend_process::shutdown", controller_block));
}
};
test("PresentationTauriSourceTest.test_session_names_one_host_authority_and_renderer", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_session_names_one_host_authority_and_renderer(); });
test("PresentationTauriSourceTest.test_typed_event_and_command_contract_is_closed", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_typed_event_and_command_contract_is_closed(); });
test("PresentationTauriSourceTest.test_capabilities_keep_controller_narrow_and_remove_direct_fullscreen", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_capabilities_keep_controller_narrow_and_remove_direct_fullscreen(); });
test("PresentationTauriSourceTest.test_command_manifest_handler_and_generated_permissions_are_synchronized", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_command_manifest_handler_and_generated_permissions_are_synchronized(); });
test("PresentationTauriSourceTest.test_output_state_relay_is_bounded_generation_checked_and_role_scoped", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_output_state_relay_is_bounded_generation_checked_and_role_scoped(); });
test("PresentationTauriSourceTest.test_video_geometry_log_is_audience_scoped_and_generation_checked", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_video_geometry_log_is_audience_scoped_and_generation_checked(); });
test("PresentationTauriSourceTest.test_windows_main_and_audience_windows_share_one_webview_store", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_windows_main_and_audience_windows_share_one_webview_store(); });
test("PresentationTauriSourceTest.test_display_identifiers_are_ordered_native_overlays_with_bounded_lifetime", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_display_identifiers_are_ordered_native_overlays_with_bounded_lifetime(); });
test("PresentationTauriSourceTest.test_only_main_is_static_and_audience_output_is_dynamic", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_only_main_is_static_and_audience_output_is_dynamic(); });
test("PresentationTauriSourceTest.test_audience_output_is_frameless_and_fills_the_selected_monitor", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_audience_output_is_frameless_and_fills_the_selected_monitor(); });
test("PresentationTauriSourceTest.test_activation_uses_tauri_async_executor_before_controller_construction", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_activation_uses_tauri_async_executor_before_controller_construction(); });
test("PresentationTauriSourceTest.test_presentation_native_lifecycle_is_recorded_in_diagnostic_logs", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_presentation_native_lifecycle_is_recorded_in_diagnostic_logs(); });
test("PresentationTauriSourceTest.test_stale_activation_cannot_mutate_after_recovery_claim", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_stale_activation_cannot_mutate_after_recovery_claim(); });
test("PresentationTauriSourceTest.test_display_identity_is_native_and_unsupported_platforms_fail_closed", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_display_identity_is_native_and_unsupported_platforms_fail_closed(); });
test("PresentationTauriSourceTest.test_host_moves_only_when_output_uses_its_current_display", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_host_moves_only_when_output_uses_its_current_display(); });
test("PresentationTauriSourceTest.test_recovery_and_playback_publication_have_bounded_failure_transactions", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_recovery_and_playback_publication_have_bounded_failure_transactions(); });
test("PresentationTauriSourceTest.test_claimed_readiness_publication_failures_enter_activation_recovery", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_claimed_readiness_publication_failures_enter_activation_recovery(); });
test("PresentationTauriSourceTest.test_controller_loss_recovers_only_presentation_and_main_keeps_pr95_shutdown", async () => { const instance = Object.create(PresentationTauriSourceTest); await instance.setUpClass(); await instance.test_controller_loss_recovers_only_presentation_and_main_keeps_pr95_shutdown(); });
