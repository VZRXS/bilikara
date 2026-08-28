import unittest
from pathlib import Path


class TauriExportSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = Path(__file__).resolve().parents[1]
        cls.main_source = (root / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8")
        cls.backend_source = (
            root / "src-tauri" / "src" / "backend_process.rs"
        ).read_text(encoding="utf-8")
        cls.download_source = (
            root / "src-tauri" / "src" / "backend_download.rs"
        ).read_text(encoding="utf-8")
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
        self.assertIn('request_url.path() == "/api/playlist/export"', self.download_source)
        self.assertIn('request_url.path() == "/api/diagnostics/package"', self.download_source)
        self.assertIn('Err("不允许保存该后端端点"', self.download_source)

    def test_native_download_requests_backend_before_dialog_and_writes_off_thread(self):
        self.assertIn(".blocking_save_file()", self.download_source)
        self.assertIn("final_download_target_path(", self.download_source)
        self.assertIn(
            "write_backend_download(&final_target_path, &response.body, !extension_corrected)",
            self.download_source,
        )
        command_start = self.download_source.index("async fn save_backend_download")
        command_end = self.download_source.index("#[cfg(test)]", command_start)
        command = self.download_source[command_start:command_end]
        self.assertLess(command.index('"validate_request"'), command.index('"authorize_window"'))
        self.assertLess(command.index('"authorize_window"'), command.index('"request_backend"'))
        self.assertLess(command.index('"request_backend"'), command.index('"validate_response"'))
        self.assertLess(command.index('"validate_response"'), command.index('"choose_destination"'))
        self.assertLess(command.index('"choose_destination"'), command.index('"write_file"'))
        self.assertLess(command.index('"validate_response"'), command.index(".blocking_save_file()"))
        self.assertIn("export_dialog_spec", self.download_source)
        self.assertIn("tauri::async_runtime::spawn_blocking", command)

    def test_physical_adapter_page_can_use_tauri_ipc_with_runtime_origin_check(self):
        self.assertIn('"http://*:*/*"', self.capability_source)
        self.assertIn(
            "window_origin_authorized(window_url.as_str(), &base_url)",
            self.download_source,
        )
        self.assertIn(
            'staged_error("authorize_window", "当前页面无权调用本机导出")',
            self.download_source,
        )

    def test_native_result_is_typed_and_does_not_return_a_path(self):
        self.assertIn("struct SaveBackendDownloadResult", self.download_source)
        self.assertIn("SaveBackendDownloadStatus::Saved", self.download_source)
        self.assertIn("SaveBackendDownloadStatus::Cancelled", self.download_source)
        self.assertNotIn("Result<bool, String>", self.download_source)

    def test_stdout_reader_drains_after_first_ready_event(self):
        self.assertIn("fn drain_backend_stdout", self.backend_source)
        self.assertIn("let mut ready_handled = false", self.backend_source)
        self.assertIn("process_backend_stdout_line", self.backend_source)
        reader_start = self.backend_source.index("fn drain_backend_stdout")
        reader_end = self.backend_source.index("pub(crate) fn launch", reader_start)
        self.assertNotIn("break;", self.backend_source[reader_start:reader_end])


if __name__ == "__main__":
    unittest.main()
