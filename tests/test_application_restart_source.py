from __future__ import annotations

import json
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ApplicationRestartSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.app_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.i18n = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )
        cls.main_rs = (ROOT / "src-tauri" / "src" / "main.rs").read_text(
            encoding="utf-8"
        )
        cls.lifecycle_rs = (
            ROOT / "src-tauri" / "src" / "window_lifecycle.rs"
        ).read_text(encoding="utf-8")
        cls.build_rs = (ROOT / "src-tauri" / "build.rs").read_text(encoding="utf-8")
        cls.cargo_toml = (ROOT / "src-tauri" / "Cargo.toml").read_text(
            encoding="utf-8"
        )
        cls.cargo_lock = tomllib.loads(
            (ROOT / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
        )
        cls.capability = json.loads(
            (ROOT / "src-tauri" / "capabilities" / "main.json").read_text(
                encoding="utf-8"
            )
        )

    def test_advanced_action_is_native_only_and_uses_existing_confirmation(self):
        self.assertIn('id="application-restart-row"', self.html)
        self.assertIn('id="application-restart-button"', self.html)
        self.assertIn('data-i18n="service.restartApplication"', self.html)
        self.assertRegex(
            self.html,
            r'class="cache-panel-row hidden" id="application-restart-row" aria-hidden="true"',
        )
        self.assertRegex(
            self.html,
            r'id="application-restart-button" disabled',
        )
        self.assertIn('type: "restart-application"', self.app_js)
        self.assertIn('invoke("restart_application")', self.app_js)
        self.assertIn("syncApplicationRestartAvailability", self.app_js)
        self.assertNotRegex(self.app_js, r"api(?:Post|Get)?\([^\n]*restart")
        for language in ("zh", "en", "ja"):
            translations = self.i18n["languages"][language]
            self.assertIn("service.restartApplication", translations)
            self.assertIn("service.restartApplicationConfirm", translations)
            self.assertIn("service.restartApplicationFailed", translations)
        self.assertEqual(
            self.i18n["languages"]["zh"]["service.restartApplication"],
            "重启应用",
        )

    def test_native_command_is_registered_and_main_only(self):
        self.assertIn("ApplicationLifecycleState::default()", self.main_rs)
        self.assertIn("window_lifecycle::restart_application", self.main_rs)
        self.assertIn('"restart_application"', self.build_rs)
        self.assertIn("allow-restart-application", self.capability["permissions"])
        self.assertIn("pub(crate) async fn restart_application", self.lifecycle_rs)
        command = self.lifecycle_rs[
            self.lifecycle_rs.index("pub(crate) async fn restart_application") :
            self.lifecycle_rs.index("pub(crate) fn handle_window_event")
        ]
        self.assertIn(
            'presentation::authorize_window(&window, &backend, &[MAIN_WINDOW_LABEL])',
            command,
        )
        self.assertIn("app.request_restart()", command)
        self.assertNotIn('"controller"', command)
        self.assertNotIn("std::process::Command", command)
        self.assertNotIn("current_exe", command)
        self.assertNotIn("update_installer", command)

    def test_locked_tauri_core_restart_contract_needs_no_process_plugin(self):
        tauri_packages = [
            package
            for package in self.cargo_lock["package"]
            if package["name"] == "tauri"
        ]
        self.assertEqual([package["version"] for package in tauri_packages], ["2.11.2"])
        self.assertNotIn("tauri-plugin-process", self.cargo_toml)
        self.assertNotIn(
            "tauri-plugin-process",
            [package["name"] for package in self.cargo_lock["package"]],
        )
        self.assertIn("sets restart_on_exit", self.lifecycle_rs)
        self.assertIn("App::run exit callbacks and Tauri cleanup", self.lifecycle_rs)

    def test_restart_sequence_preserves_existing_cleanup_order(self):
        preparation_start = self.lifecycle_rs.index(
            "async fn prepare_application_restart_on_main_thread"
        )
        command_start = self.lifecycle_rs.index(
            "pub(crate) async fn restart_application", preparation_start
        )
        preparation = self.lifecycle_rs[preparation_start:command_start]
        self.assertIn("run_on_main_thread", preparation)
        self.assertLess(
            preparation.index("save_main_window_geometry"),
            preparation.index("presentation::prepare_app_shutdown"),
        )
        self.assertIn("let result = save_main_window_geometry", preparation)
        self.assertNotIn("save_main_window_geometry(&window.as_ref().window())?", preparation)

        command_end = self.lifecycle_rs.index(
            "pub(crate) fn set_window_fullscreen", command_start
        )
        command = self.lifecycle_rs[command_start:command_end]
        preparation_call = command.index(
            "prepare_application_restart_on_main_thread(&app, &window).await"
        )
        backend = command.index("backend_process::shutdown(&backend)")
        restart = command.index("app.request_restart()")
        self.assertLess(preparation_call, backend)
        self.assertLess(backend, restart)
        self.assertIn("spawn_blocking", command)


if __name__ == "__main__":
    unittest.main()
