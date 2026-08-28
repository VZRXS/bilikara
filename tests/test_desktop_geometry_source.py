from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DesktopGeometrySourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tauri = ROOT / "src-tauri"
        cls.main = (cls.tauri / "src" / "main.rs").read_text(encoding="utf-8")
        cls.platform = (cls.tauri / "src" / "platform.rs").read_text(
            encoding="utf-8"
        )
        cls.backend = (cls.tauri / "src" / "backend_process.rs").read_text(
            encoding="utf-8"
        )
        cls.cargo = (cls.tauri / "Cargo.toml").read_text(encoding="utf-8")
        cls.lifecycle = (
            cls.tauri / "src" / "window_lifecycle.rs"
        ).read_text(encoding="utf-8")
        cls.configuration = json.loads(
            (cls.tauri / "tauri.conf.json").read_text(encoding="utf-8")
        )

    def test_geometry_is_applied_to_the_hidden_main_before_backend_launch(self):
        setup_start = self.main.index(".setup(move |app| {")
        setup_end = self.main.index(".on_window_event", setup_start)
        setup = self.main[setup_start:setup_end]

        self.assertIn(
            "window_lifecycle::initialize_main_window_geometry(app, &window)", setup
        )
        self.assertLess(
            setup.index("initialize_main_window_geometry"),
            setup.index("backend_process::launch"),
        )
        self.assertIn("create_macos_main_webview_window(app)?", setup)
        self.assertLess(
            setup.index("create_macos_main_webview_window(app)?"),
            setup.index("initialize_main_window_geometry"),
        )

        windows = self.configuration["app"]["windows"]
        self.assertEqual([window["label"] for window in windows], ["main"])
        self.assertFalse(windows[0]["visible"])
        self.assertNotIn(".show()", self.lifecycle)

    def test_geometry_persistence_is_rust_only_and_main_only(self):
        geometry = self.lifecycle[
            : self.lifecycle.index("async fn prepare_application_restart_on_main_thread")
        ]
        self.assertIn('const MAIN_WINDOW_LABEL: &str = "main";', self.lifecycle)
        self.assertIn("if window.label() != MAIN_WINDOW_LABEL", self.lifecycle)
        self.assertNotIn("tauri_plugin_window_state", self.lifecycle)
        self.assertNotIn("tauri-plugin-window-state", self.cargo)
        self.assertNotIn("controller", geometry)

    def test_backend_ready_marker_remains_the_only_initial_show_authority(self):
        reader = self.backend.index("let result = drain_backend_stdout(")
        ready_callback = self.backend.index("|ready| {", reader)
        output_callback = self.backend.index("|line| {", ready_callback)
        accepted_ready = self.backend[ready_callback:output_callback]

        self.assertEqual(self.backend.count("window_clone.show()"), 1)
        self.assertEqual(accepted_ready.count("window_clone.show()"), 1)
        self.assertLess(
            accepted_ready.index("ready_for_reader.store(true"),
            accepted_ready.index("window_clone.show()"),
        )
        self.assertLess(
            accepted_ready.index("window_clone.show()"),
            accepted_ready.index("window_clone.set_focus()"),
        )
        self.assertLess(
            accepted_ready.index("window_clone.set_focus()"),
            accepted_ready.index("window.location.replace"),
        )
        self.assertNotIn(".show()", self.lifecycle)


if __name__ == "__main__":
    unittest.main()
