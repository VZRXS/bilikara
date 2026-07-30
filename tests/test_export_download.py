import json
import shutil
import subprocess
import unittest
from pathlib import Path


class ExportDownloadBehaviorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.helper = cls.repo_root / "static" / "export-download.js"
        cls.guard = cls.repo_root / "static" / "export-guard.js"
        cls.sources = {
            "host": (cls.repo_root / "static" / "app.js").read_text(encoding="utf-8"),
            "remote": (cls.repo_root / "static" / "remote.js").read_text(encoding="utf-8"),
        }

    @staticmethod
    def function_source(source: str, marker: str, next_marker: str) -> str:
        start = source.index(marker)
        end = source.index(next_marker, start)
        return source[start:end]

    def run_node(self, script: str, *args: str) -> dict:
        process = subprocess.run(
            [self.node, "-e", script, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return json.loads(process.stdout)

    def test_error_normalization_covers_error_string_and_fallback_inputs(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const fallback = "translated fallback";
            process.stdout.write(JSON.stringify({
              error: helper.normalizedErrorMessage(new Error("error instance"), fallback),
              string: helper.normalizedErrorMessage("  string rejection  ", fallback),
              empty: helper.normalizedErrorMessage("   ", fallback),
              nullValue: helper.normalizedErrorMessage(null, fallback),
              object: helper.normalizedErrorMessage({ code: 500 }, fallback),
              translated: helper.normalizedErrorMessage(undefined, "翻译后的失败消息"),
            }));
            """,
            str(self.helper),
        )
        self.assertEqual(result["error"], "error instance")
        self.assertEqual(result["string"], "string rejection")
        self.assertEqual(result["empty"], "translated fallback")
        self.assertEqual(result["nullValue"], "translated fallback")
        self.assertEqual(result["object"], "translated fallback")
        self.assertEqual(result["translated"], "翻译后的失败消息")

    def test_native_result_accepts_only_saved_and_cancelled(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const values = {};
            for (const [name, value] of Object.entries({
              saved: { status: "saved" },
              cancelled: { status: "cancelled" },
              boolean: true,
              unknown: { status: "complete" },
              nullValue: null,
            })) {
              try {
                values[name] = { status: helper.nativeDownloadStatus(value, "native fallback") };
              } catch (error) {
                values[name] = { error: error.message };
              }
            }
            process.stdout.write(JSON.stringify(values));
            """,
            str(self.helper),
        )
        self.assertEqual(result["saved"], {"status": "saved"})
        self.assertEqual(result["cancelled"], {"status": "cancelled"})
        for name in ("boolean", "unknown", "nullValue"):
            self.assertEqual(result[name], {"error": "native fallback"})

    def run_browser_download(self, *, response_mode: str, filename: str = "server-name.csv") -> dict:
        return self.run_node(
            """
            const helper = require(process.argv[1]);
            const mode = process.argv[2];
            const filename = process.argv[3];
            const events = { appended: [], revoked: [], timers: [], fetchOptions: null };
            const link = {
              removed: false,
              clicked: false,
              remove() { this.removed = true; },
              click() { this.clicked = true; },
            };
            const environment = {
              async fetch(url, options) {
                events.fetchUrl = url;
                events.fetchOptions = options;
                return {
                  ok: mode === "success",
                  headers: { get(name) {
                    return name === "Content-Disposition"
                      ? `attachment; filename="${filename}"`
                      : null;
                  } },
                  async blob() { events.blobCalled = true; return { size: 12 }; },
                  async json() {
                    if (mode === "json-error") return { error: "server rejected export" };
                    if (mode === "empty-json-error") return { error: "" };
                    throw new Error("not JSON");
                  },
                };
              },
              document: {
                createElement(tag) { events.createdTag = tag; return link; },
                body: { appendChild(node) { events.appended.push(node); } },
              },
              URL: {
                createObjectURL(blob) { events.createdBlob = blob; return "blob:download"; },
                revokeObjectURL(url) { events.revoked.push(url); },
              },
              setTimeout(callback, delay) { events.timers.push({ callback, delay }); },
            };
            helper.downloadBrowserFile(
              "/api/playlist/export?format=csv",
              {
                fallbackFilename: "fallback.csv",
                fallbackMessage: "translated export failure",
                headers: { "X-Bilikara-Client": "remote-client" },
              },
              environment,
            ).then((value) => {
              for (const timer of events.timers) timer.callback();
              process.stdout.write(JSON.stringify({
                value,
                error: null,
                fetchUrl: events.fetchUrl,
                fetchOptions: events.fetchOptions,
                blobCalled: Boolean(events.blobCalled),
                createdTag: events.createdTag || null,
                clicked: link.clicked,
                removed: link.removed,
                href: link.href || null,
                download: link.download || null,
                rel: link.rel || null,
                timerDelays: events.timers.map((timer) => timer.delay),
                revoked: events.revoked,
              }));
            }).catch((error) => {
              process.stdout.write(JSON.stringify({
                value: null,
                error: error.message,
                fetchOptions: events.fetchOptions,
                blobCalled: Boolean(events.blobCalled),
                createdTag: events.createdTag || null,
                revoked: events.revoked,
              }));
            });
            """,
            str(self.helper),
            response_mode,
            filename,
        )

    def test_browser_blob_download_uses_content_disposition_and_cleans_up(self):
        for filename in ("playlist.csv", "playlist.png"):
            with self.subTest(filename=filename):
                result = self.run_browser_download(response_mode="success", filename=filename)
                self.assertTrue(result["value"])
                self.assertIsNone(result["error"])
                self.assertEqual(result["fetchOptions"]["credentials"], "same-origin")
                self.assertEqual(result["fetchOptions"]["cache"], "no-store")
                self.assertEqual(
                    result["fetchOptions"]["headers"]["X-Bilikara-Client"],
                    "remote-client",
                )
                self.assertTrue(result["blobCalled"])
                self.assertEqual(result["createdTag"], "a")
                self.assertTrue(result["clicked"])
                self.assertTrue(result["removed"])
                self.assertEqual(result["href"], "blob:download")
                self.assertEqual(result["download"], filename)
                self.assertEqual(result["rel"], "noopener")
                self.assertEqual(result["timerDelays"], [1000])
                self.assertEqual(result["revoked"], ["blob:download"])

    def test_browser_blob_download_surfaces_json_and_non_json_errors(self):
        expected = {
            "json-error": "server rejected export",
            "non-json-error": "translated export failure",
            "empty-json-error": "translated export failure",
        }
        for mode, message in expected.items():
            with self.subTest(mode=mode):
                result = self.run_browser_download(response_mode=mode)
                self.assertEqual(result["error"], message)
                self.assertFalse(result["blobCalled"])
                self.assertIsNone(result["createdTag"])
                self.assertEqual(result["revoked"], [])

    def run_adapter(self, frontend: str, *, tauri: bool, native_mode: str = "saved") -> dict:
        download_source = self.function_source(
            self.sources[frontend],
            "async function downloadHistoryExport",
            "async function exportHistory" if frontend == "host" else "elements.openRatingButton",
        )
        save_source = ""
        if frontend == "host":
            save_source = self.function_source(
                self.sources[frontend],
                "async function saveTauriBackendDownload",
                "async function setTauriWindowFullscreen",
            )
        script = """
        const helper = require(process.argv[1]);
        const NativeURLSearchParams = global.URLSearchParams;
        const events = { invokeCalls: 0, fetchCalls: 0, links: [], revoked: [] };
        global.window = global;
        window.BilikaraExportDownload = helper;
        global.URLSearchParams = NativeURLSearchParams;
        const state = { clientId: "client-1" };
        const elements = {};
        function t(key) { return key; }
        function clientHeaders() { return { "X-Bilikara-Client": state.clientId }; }
        function normalizedHistoryExportSource(value) { return value === "history" ? "history" : "played"; }
        function normalizedHistoryExportPageSize(value) { return Number(value) || 200; }
        async function invoke() {
          events.invokeCalls += 1;
          const mode = process.argv[3];
          if (mode === "string-error") throw "[request_backend] backend unavailable";
          if (mode === "error-object") throw new Error("[write_file] permission denied");
          if (mode === "malformed") return true;
          return { status: mode };
        }
        function tauriInvoke() { return window.__TAURI__?.core?.invoke || null; }
        if (JSON.parse(process.argv[2])) {
          window.__TAURI__ = { core: { invoke } };
        }
        global.fetch = async function(url, options) {
          events.fetchCalls += 1;
          events.fetchUrl = url;
          events.fetchOptions = options;
          return {
            ok: true,
            headers: { get() { return 'attachment; filename="browser-file.csv"'; } },
            async blob() { return { size: 3 }; },
          };
        };
        global.document = {
          createElement() {
            const link = {
              clicked: false,
              removed: false,
              click() { this.clicked = true; },
              remove() { this.removed = true; },
            };
            events.links.push(link);
            return link;
          },
          body: { appendChild() {} },
        };
        global.URL = {
          createObjectURL() { return "blob:test"; },
          revokeObjectURL(url) { events.revoked.push(url); },
        };
        global.setTimeout = (callback) => { callback(); };
        """ + save_source + download_source + """
        downloadHistoryExport("csv", "played", 200).then((result) => {
          process.stdout.write(JSON.stringify({
            result,
            error: null,
            invokeCalls: events.invokeCalls,
            fetchCalls: events.fetchCalls,
            fetchOptions: events.fetchOptions || null,
            links: events.links.map((link) => ({
              download: link.download,
              clicked: link.clicked,
              removed: link.removed,
            })),
            revoked: events.revoked,
          }));
        }).catch((error) => {
          process.stdout.write(JSON.stringify({
            result: null,
            error: error.message,
            invokeCalls: events.invokeCalls,
            fetchCalls: events.fetchCalls,
          }));
        });
        """
        return self.run_node(
            script,
            str(self.helper),
            json.dumps(tauri),
            native_mode,
        )

    def test_adapter_routing_is_explicit_for_tauri_host_web_host_and_remote(self):
        tauri_host = self.run_adapter("host", tauri=True, native_mode="saved")
        self.assertTrue(tauri_host["result"])
        self.assertEqual(tauri_host["invokeCalls"], 1)
        self.assertEqual(tauri_host["fetchCalls"], 0)

        web_host = self.run_adapter("host", tauri=False)
        self.assertTrue(web_host["result"])
        self.assertEqual(web_host["invokeCalls"], 0)
        self.assertEqual(web_host["fetchCalls"], 1)
        self.assertEqual(web_host["links"][0]["download"], "browser-file.csv")

        remote_with_tauri_fixture = self.run_adapter("remote", tauri=True)
        self.assertTrue(remote_with_tauri_fixture["result"])
        self.assertEqual(remote_with_tauri_fixture["invokeCalls"], 0)
        self.assertEqual(remote_with_tauri_fixture["fetchCalls"], 1)
        self.assertEqual(
            remote_with_tauri_fixture["fetchOptions"]["headers"]["X-Bilikara-Client"],
            "client-1",
        )

    def test_native_saved_cancelled_and_failure_results_are_observable(self):
        saved = self.run_adapter("host", tauri=True, native_mode="saved")
        self.assertTrue(saved["result"])

        cancelled = self.run_adapter("host", tauri=True, native_mode="cancelled")
        self.assertFalse(cancelled["result"])
        self.assertIsNone(cancelled["error"])

        string_error = self.run_adapter("host", tauri=True, native_mode="string-error")
        self.assertEqual(string_error["error"], "[request_backend] backend unavailable")

        error_object = self.run_adapter("host", tauri=True, native_mode="error-object")
        self.assertEqual(error_object["error"], "[write_file] permission denied")

        malformed = self.run_adapter("host", tauri=True, native_mode="malformed")
        self.assertEqual(malformed["error"], "history.exportFailed")

    def run_export_guard_error(self, frontend: str, rejection_kind: str) -> dict:
        next_marker = "function diagnosticBrowserInfo" if frontend == "host" else "async function submitAddRequest"
        function_source = self.function_source(
            self.sources[frontend],
            "async function exportHistory",
            next_marker,
        )
        invocation = 'exportHistory("csv", "played", 200)' if frontend == "host" else 'exportHistory("csv")'
        return self.run_node(
            """
            const helper = require(process.argv[2]);
            const { createExportGuard } = require(process.argv[1]);
            global.window = global;
            window.BilikaraExportDownload = helper;
            const button = {
              disabled: false,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            };
            const historyExportGuard = createExportGuard([button]);
            const messages = [];
            async function downloadHistoryExport() {
              if (process.argv[3] === "string") throw "native string failure";
              throw { code: "plain object" };
            }
            function normalizedHistoryExportSource(value) { return value; }
            function normalizedHistoryExportPageSize(value) { return value; }
            function historyExportSourceLabel(value) { return value; }
            function selectedHistoryExportSource() { return "played"; }
            function selectedHistoryExportPageSize() { return 200; }
            function closeConfirm() {}
            function setAppMessage(message, isError) { messages.push({ message, isError: Boolean(isError) }); }
            function t(key) { return key; }
            """ + function_source + """
            """ + invocation + """.then(() => {
              process.stdout.write(JSON.stringify({
                messages,
                busy: historyExportGuard.isBusy(),
                disabled: button.disabled,
                ariaBusy: button.attributes["aria-busy"] || null,
              }));
            });
            """,
            str(self.guard),
            str(self.helper),
            rejection_kind,
        )

    def test_export_guards_restore_buttons_and_show_normalized_errors(self):
        for frontend in self.sources:
            with self.subTest(frontend=frontend, rejection="string"):
                result = self.run_export_guard_error(frontend, "string")
                self.assertEqual(result["messages"][-1], {"message": "native string failure", "isError": True})
                self.assertFalse(result["busy"])
                self.assertFalse(result["disabled"])
                self.assertIsNone(result["ariaBusy"])
            with self.subTest(frontend=frontend, rejection="object"):
                result = self.run_export_guard_error(frontend, "object")
                self.assertEqual(result["messages"][-1], {"message": "history.exportFailed", "isError": True})
                self.assertFalse(result["busy"])


if __name__ == "__main__":
    unittest.main()
