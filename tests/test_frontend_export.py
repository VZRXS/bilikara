import unittest
from pathlib import Path


class FrontendExportBehaviorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        root = Path(__file__).resolve().parents[1]
        cls.sources = {
            "host": (root / "static" / "app.js").read_text(encoding="utf-8"),
            "remote": (root / "static" / "remote.js").read_text(encoding="utf-8"),
        }

    @staticmethod
    def function_source(source: str, marker: str, next_marker: str) -> str:
        start = source.index(marker)
        end = source.index(next_marker, start)
        return source[start:end]

    def test_playlist_export_routing_is_explicit_by_surface(self):
        host_export = self.function_source(
            self.sources["host"],
            "async function downloadHistoryExport",
            "async function exportHistory",
        )
        remote_export = self.function_source(
            self.sources["remote"],
            "async function downloadHistoryExport",
            "elements.openRatingButton",
        )
        for export_source in (host_export, remote_export):
            self.assertIn("new URLSearchParams", export_source)
            self.assertIn("format: normalizedFormat", export_source)
            self.assertIn("source: normalizedSource", export_source)
            self.assertIn("page_size: String(normalizedPageSize)", export_source)
            self.assertIn("/api/playlist/export?", export_source)
            self.assertIn("exportDownload.downloadBrowserFile(exportUrl", export_source)
            self.assertIn("headers: clientHeaders()", export_source)
            self.assertNotIn("triggerAttachmentDownload", export_source)
            self.assertNotIn("window.location.hostname", export_source)

        self.assertIn("await saveTauriBackendDownload(exportUrl)", host_export)
        self.assertIn('tauriStatus === "saved"', host_export)
        self.assertNotIn("saveTauriBackendDownload", remote_export)
        self.assertNotIn("__TAURI__", remote_export)

    def test_only_host_native_helper_invokes_typed_save_command(self):
        helper = self.function_source(
            self.sources["host"],
            "async function saveTauriBackendDownload",
            "async function setTauriWindowFullscreen",
        )
        self.assertIn('invoke("save_backend_download"', helper)
        self.assertIn("path,", helper)
        self.assertIn("body,", helper)
        self.assertIn("clientId: state.clientId", helper)
        self.assertIn("nativeDownloadStatus(result, fallback)", helper)
        self.assertIn("normalizedErrorMessage(error, fallback)", helper)
        self.assertNotIn("saveTauriBackendDownload", self.sources["remote"])

    def test_diagnostics_package_uses_tauri_save_dialog_before_browser_blob(self):
        source = self.sources["host"]
        response_source = self.function_source(
            source,
            "async function diagnosticResponse",
            "async function copyTextWithFallback",
        )
        download_source = self.function_source(
            source,
            "async function downloadDiagnosticsPackage",
            "async function resetRuntimeData",
        )
        self.assertIn('"/api/diagnostics/package"', download_source)
        self.assertIn("await saveTauriBackendDownload(", download_source)
        self.assertIn("JSON.stringify({ browser: diagnosticBrowserInfo() })", download_source)
        self.assertIn("if (tauriStatus !== null)", download_source)
        self.assertIn('tauriStatus === "saved"', download_source)
        self.assertIn('await diagnosticResponse("/api/diagnostics/package")', download_source)
        self.assertIn('method: "POST"', response_source)
        self.assertIn("await response.blob()", download_source)
        self.assertNotIn("triggerAttachmentDownload", download_source)
        self.assertLess(
            download_source.index("await saveTauriBackendDownload("),
            download_source.index('await diagnosticResponse("/api/diagnostics/package")'),
        )

    def test_export_guard_waits_for_download_response(self):
        for name, source in self.sources.items():
            with self.subTest(frontend=name):
                export_source = self.function_source(
                    source,
                    "async function exportHistory",
                    "function diagnosticBrowserInfo" if name == "host" else "async function submitAddRequest",
                )
                self.assertIn("historyExportGuard.run", export_source)
                self.assertIn("await downloadHistoryExport", export_source)
                self.assertIn("normalizedErrorMessage", export_source)
                self.assertLess(
                    export_source.index("if (!saved)"),
                    export_source.index('t("history.csvDownloadStarted"'),
                )
                download_source = self.function_source(
                    source,
                    "async function downloadHistoryExport",
                    "async function exportHistory",
                )
                self.assertIn("async function downloadHistoryExport", download_source)
                self.assertIn("downloadBrowserFile", download_source)

    def test_clipboard_rejection_falls_back_to_exec_command(self):
        source = self.sources["host"]
        fallback = self.function_source(
            source,
            "async function copyTextWithFallback",
            "async function copyDiagnosticsMarkdown",
        )
        self.assertIn("await navigator.clipboard.writeText(text)", fallback)
        self.assertIn("catch {", fallback)
        self.assertIn('document.execCommand("copy")', fallback)
        self.assertIn("if (!copied)", fallback)


if __name__ == "__main__":
    unittest.main()
