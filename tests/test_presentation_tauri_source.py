from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PresentationTauriSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tauri = ROOT / "src-tauri"
        cls.main = (cls.tauri / "src" / "desktop.rs").read_text(encoding="utf-8")
        cls.backend = (cls.tauri / "src" / "backend_process.rs").read_text(
            encoding="utf-8"
        )
        cls.diagnostics = (
            cls.tauri / "src" / "desktop_diagnostics.rs"
        ).read_text(encoding="utf-8")
        cls.presentation = (cls.tauri / "src" / "presentation.rs").read_text(encoding="utf-8")
        cls.window_lifecycle = (
            cls.tauri / "src" / "window_lifecycle.rs"
        ).read_text(encoding="utf-8")
        cls.build = (cls.tauri / "build.rs").read_text(encoding="utf-8")
        cls.configuration = json.loads(
            (cls.tauri / "tauri.conf.json").read_text(encoding="utf-8")
        )
        cls.main_capability = json.loads(
            (cls.tauri / "capabilities" / "main.json").read_text(encoding="utf-8")
        )
        cls.controller_capability = json.loads(
            (cls.tauri / "capabilities" / "controller.json").read_text(encoding="utf-8")
        )

    def test_session_names_one_host_authority_and_renderer(self):
        self.assertIn("playback_authority: PlaybackAuthorityIdentity::Host", self.presentation)
        self.assertIn("media_renderer_owner: MediaRendererOwner::Host", self.presentation)
        self.assertNotIn("StageSession", self.presentation)
        self.assertNotIn('WebviewWindowBuilder::new(app, "stage"', self.presentation)
        self.assertIn('WebviewWindowBuilder::new(app, "controller"', self.presentation)

    def test_typed_event_and_command_contract_is_closed(self):
        for event in (
            "bilikara-presentation-state",
            "bilikara-presentation-host-composition",
            "bilikara-presentation-host-command",
            "bilikara-presentation-playback-state",
            "bilikara-presentation-output-state",
            "bilikara-presentation-output-request",
        ):
            self.assertIn(event, self.presentation)
        self.assertIn('tag = "type"', self.presentation)
        self.assertIn('rename_all = "camelCase"', self.presentation)
        self.assertIn('rename_all_fields = "camelCase"', self.presentation)
        self.assertIn("deny_unknown_fields", self.presentation)
        for variant in ("Play", "Pause", "SeekRelative", "SeekAbsolute", "NextTrack", "SetVolume"):
            self.assertRegex(self.presentation, rf"\b{variant}\b")
        self.assertIn("MAX_PENDING_COMMANDS", self.presentation)
        self.assertIn("MAX_SAFE_JS_INTEGER", self.presentation)
        self.assertIn("request.sequence != expected_sequence", self.presentation)

    def test_capabilities_keep_controller_narrow_and_remove_direct_fullscreen(self):
        main_permissions = set(self.main_capability["permissions"])
        controller_permissions = set(self.controller_capability["permissions"])
        self.assertNotIn("core:window:allow-set-fullscreen", main_permissions)
        self.assertIn("allow-set-window-fullscreen", main_permissions)
        self.assertEqual(
            controller_permissions,
            {
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "allow-get-presentation-session",
                "allow-mark-presentation-controller-ready",
                "allow-request-presentation-output-state",
                "allow-deactivate-local-presentation",
            },
        )
        # Only the Host publishes output; the audience may only ask for a replay.
        self.assertIn("allow-publish-presentation-output-state", main_permissions)
        self.assertNotIn("allow-request-presentation-output-state", main_permissions)
        self.assertNotIn("allow-publish-presentation-output-state", controller_permissions)
        self.assertNotIn("core:default", controller_permissions)
        self.assertNotIn("core:event:allow-emit", controller_permissions)
        self.assertNotIn("core:event:allow-emit-to", controller_permissions)
        # The main wildcard preserves packaged-Windows physical-adapter loading from PR95.
        # Presentation commands still require exact runtime origin, and Controller navigation
        # is pinned to the exact origin chosen at construction.
        self.assertIn("http://*:*/*", self.main_capability["remote"]["urls"])
        self.assertIn("http://*:*/*", self.controller_capability["remote"]["urls"])
        self.assertIn("window_origin_authorized(window_url.as_str(), &backend_url)", self.presentation)
        self.assertIn(".on_navigation(move |candidate|", self.presentation)
        self.assertRegex(
            self.presentation,
            r"window_origin_authorized\(\s*candidate\.as_str\(\),\s*allowed_origin\.as_str\(\),?\s*\)",
        )

    def test_command_manifest_handler_and_generated_permissions_are_synchronized(self):
        commands = (
            "set_window_fullscreen",
            "get_presentation_displays",
            "get_presentation_session",
            "show_presentation_display_identifiers",
            "dismiss_presentation_display_identifiers",
            "activate_local_presentation",
            "mark_presentation_host_ready",
            "mark_presentation_controller_ready",
            "send_presentation_command",
            "acknowledge_presentation_command",
            "publish_presentation_playback_state",
            "publish_presentation_output_state",
            "request_presentation_output_state",
            "deactivate_local_presentation",
        )
        handler_match = re.search(r"tauri::generate_handler!\[(.*?)\]\)", self.main, re.DOTALL)
        self.assertIsNotNone(handler_match)
        handler = handler_match.group(1)
        for command in commands:
            self.assertIn(f'"{command}"', self.build)
            self.assertIn(command, handler)
            permission = self.tauri / "permissions" / "autogenerated" / f"{command}.toml"
            self.assertTrue(permission.is_file(), command)
            text = permission.read_text(encoding="utf-8")
            self.assertIn(f'commands.allow = ["{command}"]', text)

    def test_output_state_relay_is_bounded_generation_checked_and_role_scoped(self):
        publish = self.presentation[
            self.presentation.index("pub(crate) fn publish_presentation_output_state") :
            self.presentation.index("pub(crate) fn request_presentation_output_state")
        ]
        self.assertIn('authorize_window(&window, &backend, &["main"])?', publish)
        self.assertIn("validate_output_state(&envelope, generation)?", publish)
        self.assertIn("state.ensure_output_generation(generation)?", publish)
        self.assertIn('app.emit_to("controller", OUTPUT_STATE_EVENT, &envelope)', publish)
        request = self.presentation[
            self.presentation.index("pub(crate) fn request_presentation_output_state") :
            self.presentation.index("pub(crate) fn deactivate_local_presentation")
        ]
        self.assertIn('authorize_window(&window, &backend, &["controller"])?', request)
        self.assertIn("state.ensure_output_generation(generation)?", request)
        self.assertIn('"main"', request)
        self.assertIn("OUTPUT_REQUEST_EVENT", request)
        validation = self.presentation[
            self.presentation.index("fn validate_output_state") :
            self.presentation.index("fn close_controller(")
        ]
        self.assertIn('Some("master-state")', validation)
        self.assertIn('envelope["payload"]["scene"]["generation"].as_u64() != Some(generation)', validation)
        self.assertIn("size > MAX_OUTPUT_STATE_BYTES", validation)
        self.assertIn("const MAX_OUTPUT_STATE_BYTES: usize = 2 * 1024 * 1024;", self.presentation)

    def test_windows_main_and_audience_windows_share_one_webview_store(self):
        # Tauri ignores a configured window's dataDirectory; separate stores share
        # no cookies, localStorage or BroadcastChannel with the audience window.
        windows = json.loads(
            (self.tauri / "tauri.windows.conf.json").read_text(encoding="utf-8")
        )["app"]["windows"]
        self.assertEqual([window["label"] for window in windows], ["main"])
        self.assertFalse(windows[0]["create"])
        storage = (self.tauri / "src" / "desktop_storage.rs").read_text(encoding="utf-8")
        builder = storage[storage.index("pub(crate) fn create_windows_main_webview_window") :]
        self.assertIn("webview_directory(app.config())", builder)
        self.assertIn(".data_directory(directory)", builder)
        setup = self.main[self.main.index(".setup(move |app|") :]
        self.assertLess(
            setup.index("crate::desktop_storage::create_windows_main_webview_window(app)?"),
            setup.index('app.get_webview_window("main")'),
        )
        self.assertEqual(
            self.presentation.count(
                "builder.data_directory(crate::desktop_storage::webview_directory(app.config())?)"
            ),
            2,
        )
        # One WebView2 environment per data directory requires identical arguments.
        self.assertIn(".additional_browser_args(WINDOWS_WEBVIEW_BROWSER_ARGS)", builder)
        self.assertEqual(
            self.presentation.count(
                "builder.additional_browser_args(crate::desktop_storage::WINDOWS_WEBVIEW_BROWSER_ARGS)"
            ),
            2,
        )
        arguments = storage[storage.index("WINDOWS_WEBVIEW_BROWSER_ARGS: &str = ") :].split("\n", 1)[0]
        for argument in (
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-direct-composition-video-overlays",
        ):
            self.assertIn(argument, arguments)
        windows_config = (self.tauri / "tauri.windows.conf.json").read_text(encoding="utf-8")
        self.assertNotIn("additionalBrowserArgs", windows_config)

    def test_display_identifiers_are_ordered_native_overlays_with_bounded_lifetime(self):
        identifiers = self.presentation[
            self.presentation.index("fn validate_display_identifier_order") :
            self.presentation.index("fn capture_host_placement")
        ]
        self.assertIn("requested_ids.len() != available_ids.len()", identifiers)
        self.assertIn("seen.insert(requested_id.as_str())", identifiers)
        self.assertIn("order_index + 1", identifiers)
        self.assertIn("record.display.controller", identifiers)
        self.assertIn("record.display.selectable", identifiers)
        self.assertIn(".always_on_top(true)", identifiers)
        self.assertIn(".focusable(false)", identifiers)
        self.assertIn(".skip_taskbar(true)", identifiers)
        self.assertIn("const DISPLAY_IDENTIFIER_WIDTH: f64 = 128.0", self.presentation)
        self.assertIn("const DISPLAY_IDENTIFIER_HEIGHT: f64 = 128.0", self.presentation)
        self.assertIn(".transparent(true)", identifiers)
        self.assertIn(".shadow(false)", identifiers)
        self.assertIn("tauri::window::Color(0, 0, 0, 0)", identifiers)
        self.assertIn("window.set_ignore_cursor_events(true)", identifiers)
        self.assertIn("display_identifier_margin_offset", identifiers)
        self.assertNotIn("saturating_sub(width) / 2", identifiers)
        self.assertIn("DISPLAY_IDENTIFIER_LIFETIME", identifiers)
        self.assertIn("close_display_identifier_labels(&expiry_app", identifiers)
        main_permissions = set(self.main_capability["permissions"])
        self.assertIn("allow-show-presentation-display-identifiers", main_permissions)
        self.assertIn("allow-dismiss-presentation-display-identifiers", main_permissions)
        self.assertNotIn("allow-show-presentation-display-identifiers", self.controller_capability["permissions"])
        self.assertTrue(self.configuration["app"]["macOSPrivateApi"])

    def test_only_main_is_static_and_audience_output_is_dynamic(self):
        self.assertEqual([window["label"] for window in self.configuration["app"]["windows"]], ["main"])
        self.assertEqual(set(self.configuration["app"]["security"]["capabilities"]), {"main", "controller"})
        self.assertIn("visible(false)", self.presentation)
        placement = self.presentation.index("controller.set_position(position)")
        fullscreen = self.presentation.index("controller.set_fullscreen(true)")
        show = self.presentation.index("controller.show()")
        self.assertLess(placement, show)
        self.assertLess(fullscreen, show)
        finalization = self.presentation[
            self.presentation.index("fn complete_activation_if_ready") :
            self.presentation.index("fn run_activation_readiness_step")
        ]
        self.assertNotIn("host.set_fullscreen(true)", finalization)

    def test_audience_output_is_frameless_and_fills_the_selected_monitor(self):
        self.assertIn('.title("Bilikara Stage")', self.presentation)
        self.assertIn(".decorations(false)", self.presentation)
        self.assertIn(".resizable(false)", self.presentation)
        placement = self.presentation[
            self.presentation.index("fn place_controller_for_activation") :
            self.presentation.index("pub(crate) fn authorize_window")
        ]
        self.assertIn("controller.set_size(size)", placement)
        self.assertIn("controller.set_position(position)", placement)
        self.assertIn("controller.set_fullscreen(true)", placement)

    def test_activation_uses_tauri_async_executor_before_controller_construction(self):
        start = self.presentation.index(
            "#[tauri::command(async)]\npub(crate) fn activate_local_presentation"
        )
        end = self.presentation.index("fn complete_activation_if_ready")
        activation = self.presentation[start:end]
        self.assertIn("ActivationAttemptGuard::new", activation)
        self.assertIn("run_on_main_thread_with_result", activation)
        self.assertLess(
            activation.index("create_controller_window("),
            activation.index("run_on_main_thread_with_result("),
        )
        self.assertLess(
            activation.index("place_controller_for_activation("),
            activation.index("mark_activation_published("),
        )
        self.assertLess(
            activation.index("place_host_for_activation("),
            activation.index("mark_activation_published("),
        )
        self.assertIn("if let Some(host_monitor) = host_target_monitor.as_ref()", activation)
        self.assertLess(
            activation.index("|| controller.show()"),
            activation.index("mark_activation_published("),
        )
        self.assertLess(
            activation.index("emit_composition("),
            activation.index("mark_activation_published("),
        )
        self.assertLess(
            activation.index("mark_activation_published("),
            activation.index("start_generation_watchers("),
        )
        self.assertIn("complete_activation_if_ready", activation)

    def test_presentation_native_lifecycle_is_recorded_in_diagnostic_logs(self):
        self.assertIn('join("runtime")', self.diagnostics)
        self.assertIn('join("logs")', self.diagnostics)
        self.assertIn("install_runtime_desktop_diagnostics", self.main)
        self.assertIn("sender.try_send(record)", self.diagnostics)
        self.assertNotIn("try_state::<DesktopStartupLog>", self.main)
        self.assertIn('"presentation_window_destroyed"', self.window_lifecycle)
        for stage in (
            "activation_command_begin",
            "controller_build_begin",
            "controller_build_end",
            "main_thread_result_wait_begin",
            "main_thread_operation_begin",
            "window_mutation_begin",
            "window_mutation_end",
            "recovery_claimed",
            "recovery_restore_end",
            "app_shutdown_controller_close_end",
        ):
            self.assertIn(f'"{stage}"', self.presentation)

        lifecycle_result = self.presentation[
            self.presentation.index("fn deliver_main_thread_operation_result") :
            self.presentation.index("fn run_on_main_thread_with_result")
        ]
        self.assertLess(
            lifecycle_result.index("sender.send(result)"),
            lifecycle_result.index("completion_diagnostic(succeeded)"),
        )

    def test_stale_activation_cannot_mutate_after_recovery_claim(self):
        mutation = self.presentation[
            self.presentation.index("fn run_activation_window_mutation") :
            self.presentation.index("fn place_host_for_activation")
        ]
        self.assertLess(
            mutation.index("ensure_activation_native_owner"),
            mutation.index("operation()"),
        )
        finalization = self.presentation[
            self.presentation.index("fn complete_activation_if_ready") :
            self.presentation.index("fn run_activation_readiness_step")
        ]
        self.assertLess(
            finalization.index("ensure_activation_native_owner"),
            finalization.index("complete_activation(generation)"),
        )
        self.assertNotIn("host.set_fullscreen(true)", finalization)
        settlement = self.presentation[
            self.presentation.index("fn settle_activation_attempt") :
            self.presentation.index("fn complete_activation_if_ready")
        ]
        self.assertLess(
            settlement.index("activation_attempt.finish()"),
            settlement.index("force_finalize_recovery"),
        )

    def test_display_identity_is_native_and_unsupported_platforms_fail_closed(self):
        self.assertIn("DISPLAYCONFIG_TARGET_DEVICE_NAME", self.presentation)
        self.assertIn("target.monitorDevicePath", self.presentation)
        self.assertIn("macos-uuid:", self.presentation)
        self.assertIn("localizedName", self.presentation)
        self.assertIn("is_in_mirror_set", self.presentation)
        self.assertIn("source_path_counts", self.presentation)
        self.assertIn("DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL", self.presentation)
        self.assertIn("display.is_builtin()", self.presentation)
        windows_metadata = self.presentation[
            self.presentation.index("fn windows_display_metadata") :
            self.presentation.index("fn macos_display_uuid")
        ]
        self.assertIn("raw_source_path_counts", windows_metadata)
        self.assertLess(
            windows_metadata.index("raw_source_path_counts.entry(source_key)"),
            windows_metadata.index("DisplayConfigGetDeviceInfo(&mut source.header)"),
        )
        self.assertIn("display_source_is_mirrored(", windows_metadata)
        self.assertIn("entry.identity_stable = !mirrored", self.presentation)
        self.assertIn("let main_display_id = CGDisplay::main().id", self.presentation)
        self.assertIn("display_id == main_display_id", self.presentation)
        self.assertIn(
            "Presentation display discovery failed; recovering the current generation",
            self.presentation,
        )
        self.assertIn("platform_name,\n            false,", self.presentation)
        self.assertIn("let current_monitor = main_window", self.presentation)
        self.assertIn(".current_monitor()", self.presentation)
        self.assertIn("(!controller || controller_has_alternative)", self.presentation)

    def test_host_moves_only_when_output_uses_its_current_display(self):
        activation = self.presentation[
            self.presentation.index("pub(crate) fn activate_local_presentation") :
            self.presentation.index("fn settle_activation_attempt")
        ]
        self.assertIn("if target.display.id == current_host.display.id", activation)
        self.assertIn(".find(|record| record.display.built_in)", activation)
        self.assertIn("host_display_id: Option<String>", activation)
        self.assertIn("if let Some(host_monitor) = host_target_monitor.as_ref()", activation)
        self.assertIn("host_target.is_some()", activation)
        self.assertLess(
            activation.index("close_display_identifier_windows(&app)"),
            activation.index("state.begin_activation("),
        )
        recovery = self.presentation[
            self.presentation.index("fn restore_recovery_window") :
            self.presentation.index("fn finalize_recovery")
        ]
        self.assertIn("recovery_host_was_relocated", recovery)
        self.assertIn("mark_host_window_restored", recovery)

    def test_recovery_and_playback_publication_have_bounded_failure_transactions(self):
        self.assertIn("RECOVERY_FINALIZATION_TIMEOUT", self.presentation)
        self.assertIn("start_recovery_finalization_deadline", self.presentation)
        self.assertIn("force_finalize_recovery", self.presentation)
        self.assertIn("force_complete_recovery", self.presentation)
        self.assertIn("rollback_playback_state", self.presentation)
        self.assertIn("previous_sequence", self.presentation)
        self.assertIn("window.inner_size()", self.presentation)
        self.assertNotIn("size: window.outer_size()", self.presentation)

    def test_claimed_readiness_publication_failures_enter_activation_recovery(self):
        host = self.presentation[
            self.presentation.index("pub(crate) fn mark_presentation_host_ready") :
            self.presentation.index("pub(crate) fn mark_presentation_controller_ready")
        ]
        controller = self.presentation[
            self.presentation.index("pub(crate) fn mark_presentation_controller_ready") :
            self.presentation.index("pub(crate) fn send_presentation_command")
        ]
        for source in (host, controller):
            self.assertIn("run_activation_readiness_step(", source)
            self.assertIn("should_finalize", source)
            self.assertIn("recover_after_activation_failure", source)

    def test_controller_loss_recovers_only_presentation_and_main_keeps_pr95_shutdown(self):
        self.assertIn(
            ".on_window_event(window_lifecycle::handle_window_event)", self.main
        )
        event = self.window_lifecycle
        self.assertIn('window.label() == "controller"', event)
        self.assertIn("presentation::handle_controller_destroyed", event)
        self.assertIn('window.label() == "main"', event)
        self.assertIn("presentation::prepare_app_shutdown", event)
        self.assertIn("backend_process::shutdown", event)
        self.assertLess(
            event.index("presentation::prepare_app_shutdown"),
            event.index("backend_process::shutdown"),
        )
        shutdown_start = self.backend.index("pub(crate) fn shutdown")
        shutdown = self.backend[shutdown_start:]
        self.assertIn("wait_for_active_backend_downloads", shutdown)
        self.assertIn("request_backend_shutdown", shutdown)
        self.assertIn("wait_for_child_exit", shutdown)
        graceful = shutdown.index("wait_for_child_exit")
        self.assertIn("return;", shutdown[graceful:])
        self.assertLess(
            shutdown.index("wait_for_active_backend_downloads"),
            shutdown.index("request_backend_shutdown"),
        )
        self.assertLess(
            shutdown.index("request_backend_shutdown"), shutdown.index("child.kill()")
        )
        controller_block = event[event.index('window.label() == "controller"') : event.index('window.label() == "main"')]
        self.assertNotIn("backend_process::shutdown", controller_block)


if __name__ == "__main__":
    unittest.main()
