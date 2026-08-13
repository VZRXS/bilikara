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
        cls.export_permission_source = (
            root / "src-tauri" / "permissions" / "export.toml"
        ).read_text(encoding="utf-8")

    def test_dialog_plugin_and_native_save_command_are_registered(self):
        self.assertIn('tauri-plugin-dialog = "2"', self.cargo_source)
        self.assertIn(".plugin(tauri_plugin_dialog::init())", self.main_source)
        self.assertIn("save_backend_download", self.main_source)
        self.assertIn('"allow-save-backend-download"', self.capability_source)
        self.assertIn('identifier = "allow-save-backend-download"', self.export_permission_source)
        self.assertIn('commands.allow = ["save_backend_download"]', self.export_permission_source)

    def test_native_download_is_limited_to_export_endpoints(self):
        self.assertIn('request_url.path() == "/api/playlist/export"', self.main_source)
        self.assertIn('request_url.path() == "/api/diagnostics/package"', self.main_source)
        self.assertIn('Err("不允许保存该后端端点"', self.main_source)

    def test_native_download_requests_backend_before_dialog_and_writes_off_thread(self):
        self.assertIn(".blocking_save_file()", self.main_source)
        self.assertIn("final_download_target_path(", self.main_source)
        self.assertIn(
            "write_backend_download(&final_target_path, &response.body, !extension_corrected)",
            self.main_source,
        )
        command_start = self.main_source.index("async fn save_backend_download")
        command_end = self.main_source.index("fn set_window_fullscreen", command_start)
        command = self.main_source[command_start:command_end]
        self.assertLess(command.index('"validate_request"'), command.index('"authorize_window"'))
        self.assertLess(command.index('"authorize_window"'), command.index('"request_backend"'))
        self.assertLess(command.index('"request_backend"'), command.index('"validate_response"'))
        self.assertLess(command.index('"validate_response"'), command.index('"choose_destination"'))
        self.assertLess(command.index('"choose_destination"'), command.index('"write_file"'))
        self.assertLess(command.index('"validate_response"'), command.index(".blocking_save_file()"))
        self.assertIn("export_dialog_spec", self.main_source)
        self.assertIn("tauri::async_runtime::spawn_blocking", command)

    def test_physical_adapter_page_can_use_tauri_ipc_with_runtime_origin_check(self):
        self.assertIn('"http://*:*/*"', self.capability_source)
        self.assertIn("window_origin_authorized(window_url.as_str(), &base_url)", self.main_source)
        self.assertIn('staged_error("authorize_window", "当前页面无权调用本机导出")', self.main_source)

    def test_native_result_is_typed_and_does_not_return_a_path(self):
        self.assertIn("struct SaveBackendDownloadResult", self.main_source)
        self.assertIn("SaveBackendDownloadStatus::Saved", self.main_source)
        self.assertIn("SaveBackendDownloadStatus::Cancelled", self.main_source)
        self.assertNotIn("Result<bool, String>", self.main_source)

    def test_stdout_reader_drains_after_first_ready_event(self):
        self.assertIn("fn drain_backend_stdout", self.main_source)
        self.assertIn("let mut ready_handled = false", self.main_source)
        self.assertIn("process_backend_stdout_line", self.main_source)
        reader_start = self.main_source.index("fn drain_backend_stdout")
        reader_end = self.main_source.index("fn main()", reader_start)
        self.assertNotIn("break;", self.main_source[reader_start:reader_end])


if __name__ == "__main__":
    unittest.main()
