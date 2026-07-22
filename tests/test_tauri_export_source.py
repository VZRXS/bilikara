import unittest
from pathlib import Path


class TauriExportSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = Path(__file__).resolve().parents[1]
        cls.main_source = (root / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8")
        cls.cargo_source = (root / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
        cls.capability_source = (root / "src-tauri" / "capabilities" / "main.json").read_text(
            encoding="utf-8"
        )

    def test_dialog_plugin_and_native_save_command_are_registered(self):
        self.assertIn('tauri-plugin-dialog = "2"', self.cargo_source)
        self.assertIn(".plugin(tauri_plugin_dialog::init())", self.main_source)
        self.assertIn("save_backend_download", self.main_source)

    def test_native_download_is_limited_to_export_endpoints(self):
        self.assertIn('request.path.starts_with("/api/playlist/export?")', self.main_source)
        self.assertIn('request.path == "/api/diagnostics/package"', self.main_source)
        self.assertIn('Err("不允许保存该后端端点"', self.main_source)

    def test_native_download_prompts_then_writes_selected_path(self):
        self.assertIn(".blocking_save_file()", self.main_source)
        self.assertIn("std::fs::write(&target_path, response.body)", self.main_source)

    def test_physical_adapter_page_can_use_tauri_ipc(self):
        self.assertIn('"http://*:*/*"', self.capability_source)
        self.assertIn("let window_url = window", self.main_source)
        self.assertIn('return Err("当前页面无权调用本机导出"', self.main_source)


if __name__ == "__main__":
    unittest.main()
