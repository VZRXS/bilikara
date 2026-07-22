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

    def test_playlist_export_uses_tauri_save_dialog_and_browser_blob_download(self):
        for name, source in self.sources.items():
            with self.subTest(frontend=name):
                export_source = self.function_source(
                    source,
                    "async function downloadHistoryExport",
                    "async function exportHistory",
                )
                self.assertIn("new URLSearchParams", export_source)
                self.assertIn("format: normalizedFormat", export_source)
                self.assertIn("source: normalizedSource", export_source)
                self.assertIn("page_size: String(normalizedPageSize)", export_source)
                self.assertIn("/api/playlist/export?", export_source)
                self.assertIn("await saveTauriBackendDownload(exportUrl)", export_source)
                self.assertIn("if (tauriSaved !== null)", export_source)
                self.assertIn("await fetch(", export_source)
                self.assertIn("await response.blob()", export_source)
                self.assertIn("filenameFromContentDisposition(", export_source)
                self.assertIn("URL.createObjectURL(blob)", export_source)
                self.assertIn("link.download = filename", export_source)
                self.assertIn("URL.revokeObjectURL(downloadUrl)", export_source)
                self.assertLess(
                    export_source.index("await saveTauriBackendDownload(exportUrl)"),
                    export_source.index("await fetch(exportUrl"),
                )

    def test_tauri_download_helper_invokes_native_save_command(self):
        for name, source in self.sources.items():
            with self.subTest(frontend=name):
                helper = self.function_source(
                    source,
                    "async function saveTauriBackendDownload",
                    "async function setTauriWindowFullscreen" if name == "host" else "function localizedBBDownLoginMessage",
                )
                self.assertIn('invoke("save_backend_download"', helper)
                self.assertIn("path,", helper)
                self.assertIn("body,", helper)
                self.assertIn("clientId: state.clientId", helper)

    def test_diagnostics_package_uses_tauri_save_dialog_before_browser_blob(self):
        source = self.sources["host"]
        download_source = self.function_source(
            source,
            "async function downloadDiagnosticsPackage",
            "async function resetRuntimeData",
        )
        self.assertIn('"/api/diagnostics/package"', download_source)
        self.assertIn("await saveTauriBackendDownload(", download_source)
        self.assertIn("JSON.stringify({ browser: diagnosticBrowserInfo() })", download_source)
        self.assertIn("if (tauriSaved !== null)", download_source)
        self.assertIn('await diagnosticResponse("/api/diagnostics/package")', download_source)
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
                download_source = self.function_source(
                    source,
                    "async function downloadHistoryExport",
                    "async function exportHistory",
                )
                self.assertIn("async function downloadHistoryExport", download_source)
                self.assertIn("await fetch(", download_source)

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
