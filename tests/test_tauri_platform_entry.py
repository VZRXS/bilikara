import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"


class TauriPlatformEntryTest(unittest.TestCase):
    def test_binary_delegates_to_shared_library(self):
        cargo = tomllib.loads((TAURI / "Cargo.toml").read_text(encoding="utf-8"))
        self.assertEqual(cargo["lib"]["name"], "bilikara_app")
        self.assertEqual(set(cargo["lib"]["crate-type"]), {"staticlib", "cdylib", "rlib"})
        main = (TAURI / "src/main.rs").read_text(encoding="utf-8")
        self.assertIn("bilikara_app::run();", main)
        self.assertIn('windows_subsystem = "windows"', main)
        self.assertNotIn("backend_process::launch", main)

    def test_desktop_adapters_are_excluded_from_mobile_library(self):
        source = (TAURI / "src/lib.rs").read_text(encoding="utf-8")
        for module in (
            "backend_download", "backend_process", "desktop", "desktop_diagnostics",
            "platform", "presentation", "window_lifecycle",
        ):
            self.assertIn(f"#[cfg(desktop)]\nmod {module};", source)
        self.assertIn("desktop::run();", source)
        desktop = (TAURI / "src/desktop.rs").read_text(encoding="utf-8")
        self.assertIn("pub(crate) fn run()", desktop)
        self.assertIn("backend_process::launch(app, window, startup_log)", desktop)
        self.assertIn(".on_window_event(window_lifecycle::handle_window_event)", desktop)


if __name__ == "__main__":
    unittest.main()
