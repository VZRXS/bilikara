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
            check=True,
        )
        return json.loads(process.stdout)

    def test_loopback_hostname_rules_include_mapped_loopback_only(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const values = [
              "localhost", "LOCALHOST.", "127.0.0.1", "127.99.4.3",
              "::1", "[::1]", "::ffff:127.0.0.1", "[::ffff:7f00:1]",
              "192.168.1.8", "10.0.0.4", "172.16.0.9", "128.0.0.1",
              "::ffff:192.168.1.8", "example.com",
            ];
            process.stdout.write(JSON.stringify(
              Object.fromEntries(values.map((value) => [value, helper.isLoopbackHostname(value)]))
            ));
            """,
            str(self.helper),
        )
        for hostname in (
            "localhost",
            "LOCALHOST.",
            "127.0.0.1",
            "127.99.4.3",
            "::1",
            "[::1]",
            "::ffff:127.0.0.1",
            "[::ffff:7f00:1]",
        ):
            self.assertTrue(result[hostname], hostname)
        for hostname in (
            "192.168.1.8",
            "10.0.0.4",
            "172.16.0.9",
            "128.0.0.1",
            "::ffff:192.168.1.8",
            "example.com",
        ):
            self.assertFalse(result[hostname], hostname)

    def test_direct_attachment_uses_hidden_removable_iframe(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            let scheduled = null;
            const frame = {
              hidden: false,
              attributes: {},
              removed: false,
              setAttribute(name, value) { this.attributes[name] = value; },
              remove() { this.removed = true; },
            };
            const document = {
              createdTag: "",
              appended: null,
              createElement(tag) { this.createdTag = tag; return frame; },
              body: { appendChild(node) { document.appended = node; } },
            };
            const triggered = helper.triggerAttachmentDownload(
              "/api/playlist/export?format=csv&source=played&page_size=200",
              {
                document,
                setTimeout(callback, delay) { scheduled = { callback, delay }; },
              },
            );
            const beforeCleanup = frame.removed;
            scheduled.callback();
            process.stdout.write(JSON.stringify({
              triggered,
              tag: document.createdTag,
              appended: document.appended === frame,
              hidden: frame.hidden,
              ariaHidden: frame.attributes["aria-hidden"],
              src: frame.src,
              cleanupDelay: scheduled.delay,
              beforeCleanup,
              removed: frame.removed,
              hasDownloadAttribute: Object.prototype.hasOwnProperty.call(frame, "download"),
            }));
            """,
            str(self.helper),
        )
        self.assertTrue(result["triggered"])
        self.assertEqual(result["tag"], "iframe")
        self.assertTrue(result["appended"])
        self.assertTrue(result["hidden"])
        self.assertEqual(result["ariaHidden"], "true")
        self.assertEqual(result["cleanupDelay"], 60_000)
        self.assertFalse(result["beforeCleanup"])
        self.assertTrue(result["removed"])
        self.assertFalse(result["hasDownloadAttribute"])
        self.assertIn("format=csv", result["src"])
        self.assertIn("source=played", result["src"])
        self.assertIn("page_size=200", result["src"])

    def run_frontend_download(
        self,
        frontend: str,
        *,
        hostname: str,
        tauri_result: bool | None,
        export_format: str,
        source: str,
        page_size: int,
        response_ok: bool = True,
    ) -> dict:
        function_source = self.function_source(
            self.sources[frontend],
            "async function downloadHistoryExport",
            "async function exportHistory",
        )
        script = """
        const NativeURLSearchParams = global.URLSearchParams;
        const events = {
          saveCalls: 0,
          fetchCalls: 0,
          blobCalls: 0,
          objectUrlCalls: 0,
          navigationCalls: 0,
          created: [],
          appended: [],
          timers: [],
        };
        global.document = {
          createElement(tag) {
            const node = {
              tagName: String(tag).toLowerCase(),
              hidden: false,
              attributes: {},
              removed: false,
              clicked: false,
              setAttribute(name, value) { this.attributes[name] = String(value); },
              remove() { this.removed = true; },
              click() { this.clicked = true; },
            };
            events.created.push(node);
            return node;
          },
          body: {
            appendChild(node) { events.appended.push(node); },
          },
        };
        global.setTimeout = function(callback, delay) {
          events.timers.push({ callback, delay });
          return events.timers.length;
        };
        global.window = global;
        window.location = {
          hostname: process.argv[2],
          replace() { events.navigationCalls += 1; },
        };
        window.BilikaraExportDownload = require(process.argv[1]);
        global.URLSearchParams = NativeURLSearchParams;
        global.URL = {
          createObjectURL() { events.objectUrlCalls += 1; return "blob:test"; },
          revokeObjectURL() {},
        };
        async function saveTauriBackendDownload(url) {
          events.saveCalls += 1;
          events.saveUrl = url;
          return JSON.parse(process.argv[3]);
        }
        async function fetch(url) {
          events.fetchCalls += 1;
          events.fetchUrl = url;
          return {
            ok: JSON.parse(process.argv[7]),
            headers: { get() { return 'attachment; filename="server-name.csv"'; } },
            async json() { return { error: "server export failed" }; },
            async blob() { events.blobCalls += 1; return { size: 3 }; },
          };
        }
        function normalizedHistoryExportSource(value) {
          return value === "history" ? "history" : "played";
        }
        function normalizedHistoryExportPageSize(value) {
          const parsed = Number.parseInt(String(value), 10);
          return [200, 150, 100, 80, 60, 50].includes(parsed) ? parsed : 200;
        }
        function filenameFromContentDisposition(value, fallback) {
          const match = String(value || "").match(/filename="([^"]+)"/i);
          return match ? match[1] : fallback;
        }
        function t(key) { return key; }
        const elements = {};
        const state = {};
        function openRatingPrompt() {}
        """ + function_source + """
        function report(result, error) {
            events.timers.filter((timer) => timer.delay === 60000)
              .forEach((timer) => timer.callback());
            process.stdout.write(JSON.stringify({
              result,
              error: error ? error.message : null,
              saveCalls: events.saveCalls,
              fetchCalls: events.fetchCalls,
              blobCalls: events.blobCalls,
              objectUrlCalls: events.objectUrlCalls,
              navigationCalls: events.navigationCalls,
              saveUrl: events.saveUrl || null,
              fetchUrl: events.fetchUrl || null,
              created: events.created.map((node) => ({
                tagName: node.tagName,
                hidden: node.hidden,
                ariaHidden: node.attributes["aria-hidden"] || null,
                src: node.src || null,
                download: node.download || null,
                removed: node.removed,
                clicked: node.clicked,
              })),
              timerDelays: events.timers.map((timer) => timer.delay),
            }));
        }
        downloadHistoryExport(process.argv[4], process.argv[5], Number(process.argv[6]))
          .then((result) => report(result, null))
          .catch((error) => report(null, error));
        """
        return self.run_node(
            script,
            str(self.helper),
            hostname,
            json.dumps(tauri_result),
            export_format,
            source,
            str(page_size),
            json.dumps(response_ok),
        )

    def test_frontends_choose_tauri_loopback_and_physical_ip_paths(self):
        for frontend in self.sources:
            with self.subTest(frontend=frontend, path="tauri-success"):
                result = self.run_frontend_download(
                    frontend,
                    hostname="192.168.1.25",
                    tauri_result=True,
                    export_format="csv",
                    source="played",
                    page_size=200,
                )
                self.assertTrue(result["result"])
                self.assertEqual(result["saveCalls"], 1)
                self.assertEqual(result["fetchCalls"], 0)
                self.assertEqual(result["created"], [])

            with self.subTest(frontend=frontend, path="tauri-cancel"):
                result = self.run_frontend_download(
                    frontend,
                    hostname="192.168.1.25",
                    tauri_result=False,
                    export_format="csv",
                    source="played",
                    page_size=200,
                )
                self.assertFalse(result["result"])
                self.assertEqual(result["fetchCalls"], 0)
                self.assertEqual(result["created"], [])

            with self.subTest(frontend=frontend, path="loopback"):
                result = self.run_frontend_download(
                    frontend,
                    hostname="localhost",
                    tauri_result=None,
                    export_format="csv",
                    source="played",
                    page_size=200,
                )
                self.assertTrue(result["result"])
                self.assertEqual(result["fetchCalls"], 1)
                self.assertEqual(result["blobCalls"], 1)
                self.assertEqual(result["objectUrlCalls"], 1)
                self.assertEqual(result["created"][0]["tagName"], "a")
                self.assertEqual(result["created"][0]["download"], "server-name.csv")
                self.assertIn("format=csv", result["fetchUrl"])
                self.assertIn("source=played", result["fetchUrl"])

            with self.subTest(frontend=frontend, path="loopback-error"):
                result = self.run_frontend_download(
                    frontend,
                    hostname="127.0.0.1",
                    tauri_result=None,
                    export_format="csv",
                    source="played",
                    page_size=200,
                    response_ok=False,
                )
                self.assertEqual(result["error"], "server export failed")
                self.assertEqual(result["fetchCalls"], 1)
                self.assertEqual(result["blobCalls"], 0)
                self.assertEqual(result["objectUrlCalls"], 0)

            for export_format, source, page_size in (
                ("csv", "played", 200),
                ("image", "history", 80),
            ):
                with self.subTest(frontend=frontend, path="physical", format=export_format):
                    result = self.run_frontend_download(
                        frontend,
                        hostname="192.168.1.25",
                        tauri_result=None,
                        export_format=export_format,
                        source=source,
                        page_size=page_size,
                    )
                    self.assertTrue(result["result"])
                    self.assertEqual(result["fetchCalls"], 0)
                    self.assertEqual(result["blobCalls"], 0)
                    self.assertEqual(result["objectUrlCalls"], 0)
                    self.assertEqual(result["navigationCalls"], 0)
                    self.assertEqual(len(result["created"]), 1)
                    frame = result["created"][0]
                    self.assertEqual(frame["tagName"], "iframe")
                    self.assertTrue(frame["hidden"])
                    self.assertEqual(frame["ariaHidden"], "true")
                    self.assertIsNone(frame["download"])
                    self.assertTrue(frame["removed"])
                    self.assertIn(f"format={export_format}", frame["src"])
                    self.assertIn(f"source={source}", frame["src"])
                    self.assertIn(f"page_size={page_size}", frame["src"])
                    self.assertIn(60_000, result["timerDelays"])

    def run_export_guard_behavior(self, frontend: str, saved: bool) -> dict:
        next_marker = "function diagnosticBrowserInfo" if frontend == "host" else "async function submitAddRequest"
        function_source = self.function_source(
            self.sources[frontend],
            "async function exportHistory",
            next_marker,
        )
        invocation = 'exportHistory("csv", "played", 200)' if frontend == "host" else 'exportHistory("csv")'
        script = """
        const { createExportGuard } = require(process.argv[1]);
        const button = {
          disabled: false,
          attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          removeAttribute(name) { delete this.attributes[name]; },
        };
        const historyExportGuard = createExportGuard([button]);
        const messages = [];
        let downloadCalls = 0;
        async function downloadHistoryExport() {
          downloadCalls += 1;
          return JSON.parse(process.argv[2]);
        }
        function normalizedHistoryExportSource(value) { return value; }
        function normalizedHistoryExportPageSize(value) { return value; }
        function historyExportSourceLabel(value) { return value; }
        function selectedHistoryExportSource() { return "played"; }
        function selectedHistoryExportPageSize() { return 200; }
        function closeConfirm() {}
        function setAppMessage(message) { messages.push(message); }
        function t(key) { return key; }
        """ + function_source + """
        """ + invocation + """.then(() => {
          process.stdout.write(JSON.stringify({
            downloadCalls,
            messages,
            busy: historyExportGuard.isBusy(),
            disabled: button.disabled,
            ariaBusy: button.attributes["aria-busy"] || null,
          }));
        });
        """
        return self.run_node(script, str(self.guard), json.dumps(saved))

    def test_cancellation_has_no_false_success_and_guard_is_released(self):
        for frontend in self.sources:
            with self.subTest(frontend=frontend, saved=False):
                result = self.run_export_guard_behavior(frontend, False)
                self.assertEqual(result["downloadCalls"], 1)
                self.assertNotIn("history.csvDownloadStarted", result["messages"])
                self.assertFalse(result["busy"])
                self.assertFalse(result["disabled"])
                self.assertIsNone(result["ariaBusy"])
            with self.subTest(frontend=frontend, saved=True):
                result = self.run_export_guard_behavior(frontend, True)
                self.assertEqual(result["downloadCalls"], 1)
                self.assertIn("history.csvDownloadStarted", result["messages"])
                self.assertFalse(result["busy"])
                self.assertFalse(result["disabled"])
                self.assertIsNone(result["ariaBusy"])


if __name__ == "__main__":
    unittest.main()
