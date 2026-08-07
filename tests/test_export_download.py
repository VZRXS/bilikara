import io
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

    def test_native_result_supports_saved_cancelled_and_failed(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const values = {};
            for (const [name, value] of Object.entries({
              saved: { status: "saved" },
              cancelled: { status: "cancelled" },
              failed: { status: "failed", errorMessage: "custom native failure" },
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
        self.assertEqual(result["failed"], {"error": "custom native failure"})
        for name in ("boolean", "unknown", "nullValue"):
            self.assertEqual(result[name], {"error": "native fallback"})

    def test_export_diagnostic_ring_caps_at_64_entries_and_whitelists_fields(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const ring = helper.createExportDiagnosticRing(64);
            for (let i = 0; i < 70; i++) {
              ring.push({
                timestamp: "2026-08-05T00:00:00Z",
                surface: "host",
                runtime: "tauri",
                format: "csv",
                source: "played",
                pageSize: 200,
                stage: "complete",
                status: "saved",
                httpStatus: 200,
                contentType: "text/csv",
                bytes: 100,
                filenameExtension: "csv",
                elapsedMs: 50,
                songTitle: "unauthorized_title_secret",
                requester: "unauthorized_user_secret",
                extraField: "should_be_stripped",
                index: i,
              });
            }
            const snapshot = ring.snapshot();
            process.stdout.write(JSON.stringify({
              length: snapshot.length,
              firstIndex: snapshot[0].index,
              hasSongTitle: "songTitle" in snapshot[0],
              hasRequester: "requester" in snapshot[0],
              hasExtraField: "extraField" in snapshot[0],
            }));
            """,
            str(self.helper),
        )
        self.assertEqual(result["length"], 64)
        self.assertFalse(result["hasSongTitle"])
        self.assertFalse(result["hasRequester"])
        self.assertFalse(result["hasExtraField"])

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
          if (mode === "command-not-found") throw "command save_backend_download not found";
          if (mode === "command-quote-not-found") throw "command 'save_backend_download' not found";
          if (mode === "unknown-command") throw "unknown command save_backend_download";
          if (mode === "unknown-command-quote") throw "unknown command 'save_backend_download'";
          if (mode === "backend-resource-not-found") throw "backend resource not found";
          if (mode === "window-not-found") throw "window not found";
          if (mode === "export-file-not-found") throw "export file not found";
          if (mode === "string-error") throw "[request_backend] backend unavailable";
          if (mode === "error-object") throw new Error("[write_file] permission denied");

          if (mode === "saved") {
            return {
              status: "saved",
              stage: "complete",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: 200,
              contentType: "text/csv",
              bytes: 150,
              filenameExtension: "csv",
              elapsedMs: 50,
              stageTimings: [{ stage: "complete", elapsedMs: 10 }],
              errorCode: null,
              errorMessage: null,
            };
          }
          if (mode === "cancelled") {
            return {
              status: "cancelled",
              stage: "choose_destination",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: null,
              contentType: null,
              bytes: null,
              filenameExtension: null,
              elapsedMs: 30,
              stageTimings: [{ stage: "choose_destination", elapsedMs: 10 }],
              errorCode: null,
              errorMessage: null,
            };
          }
          if (mode === "failed") {
            return {
              status: "failed",
              stage: "request_backend",
              format: "csv",
              source: "played",
              pageSize: 200,
              httpStatus: null,
              contentType: null,
              bytes: null,
              filenameExtension: null,
              elapsedMs: 40,
              stageTimings: [{ stage: "request_backend", elapsedMs: 10 }],
              errorCode: "REQUEST_BACKEND_FAILED",
              errorMessage: "[request_backend] backend failed",
            };
          }

          if (mode === "malformed-true") return true;
          if (mode === "malformed-null") return null;
          if (mode === "malformed-string") return "unexpected string";
          if (mode === "malformed-partial-saved") return { status: "saved" };
          if (mode === "malformed-partial-cancelled") return { status: "cancelled" };
          if (mode === "malformed-partial-failed") return { status: "failed" };
          if (mode === "malformed-object") return { foo: "bar", status: "invalid_status", extra: "secret" };
          if (mode === "malformed-saved-wrong-stage") {
            return {
              status: "saved", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-saved-no-http-status") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-cancelled-with-backend-response") {
            return {
              status: "cancelled", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-failed-no-error-code") {
            return {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: "error msg",
            };
          }
          if (mode === "malformed-failed-no-error-message") {
            return {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 10, stageTimings: [], errorCode: "ERR", errorMessage: null,
            };
          }
          if (mode === "malformed-invalid-elapsed-ms") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: -5, stageTimings: [], errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-invalid-stage-timings") {
            return {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: "invalid", errorCode: null, errorMessage: null,
            };
          }
          if (mode === "malformed-inherited-properties") {
            const proto = {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
            };
            return Object.create(proto);
          }

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
            diagnostics: window.BilikaraExportDownload ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot() : [],
          }));
        }).catch((error) => {
          process.stdout.write(JSON.stringify({
            result: null,
            error: error.message,
            invokeCalls: events.invokeCalls,
            fetchCalls: events.fetchCalls,
            diagnostics: window.BilikaraExportDownload ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot() : [],
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

        failed = self.run_adapter("host", tauri=True, native_mode="failed")
        self.assertEqual(failed["error"], "[request_backend] backend failed")
        self.assertEqual(failed["fetchCalls"], 0)

        string_error = self.run_adapter("host", tauri=True, native_mode="string-error")
        self.assertEqual(string_error["error"], "[request_backend] backend unavailable")
        self.assertEqual(string_error["fetchCalls"], 0)

        error_object = self.run_adapter("host", tauri=True, native_mode="error-object")
        self.assertEqual(error_object["error"], "[write_file] permission denied")
        self.assertEqual(error_object["fetchCalls"], 0)

    def test_tauri_command_unavailable_matching_is_narrow(self):
        for mode in ("command-not-found", "command-quote-not-found", "unknown-command", "unknown-command-quote"):
            res = self.run_adapter("host", tauri=True, native_mode=mode)
            self.assertTrue(res["result"], f"Mode {mode} should fall back to browser and succeed")
            self.assertEqual(res["fetchCalls"], 1, f"Mode {mode} should issue fetch")

        for mode in ("backend-resource-not-found", "window-not-found", "export-file-not-found"):
            res = self.run_adapter("host", tauri=True, native_mode=mode)
            self.assertFalse(res["result"], f"Mode {mode} must fail closed")
            self.assertIsNotNone(res["error"])
            self.assertEqual(res["fetchCalls"], 0, f"Mode {mode} must NOT fall back to browser")

    def test_malformed_native_results_fail_closed_and_record_diagnostics(self):
        malformed_modes = (
            "malformed-true",
            "malformed-null",
            "malformed-string",
            "malformed-partial-saved",
            "malformed-partial-cancelled",
            "malformed-partial-failed",
            "malformed-object",
            "malformed-saved-wrong-stage",
            "malformed-saved-no-http-status",
            "malformed-cancelled-with-backend-response",
            "malformed-failed-no-error-code",
            "malformed-failed-no-error-message",
            "malformed-invalid-elapsed-ms",
            "malformed-invalid-stage-timings",
            "malformed-inherited-properties",
        )
        for mode in malformed_modes:
            res = self.run_adapter("host", tauri=True, native_mode=mode)
            self.assertFalse(res["result"], f"Malformed mode {mode} must fail closed")
            self.assertEqual(res["error"], "history.exportFailed", f"Mode {mode} error mismatch")
            self.assertEqual(res["fetchCalls"], 0, f"Malformed mode {mode} must NOT fall back to browser")
            diags = res.get("diagnostics") or []
            self.assertEqual(len(diags), 1, f"Mode {mode} should yield exactly 1 diagnostic record")
            entry = diags[0]
            self.assertEqual(entry["runtime"], "tauri")
            self.assertEqual(entry["status"], "failed")
            self.assertEqual(entry["stage"], "validate_native_result")
            self.assertEqual(entry["errorCode"], "MALFORMED_NATIVE_RESULT")
            self.assertEqual(entry["errorMessage"], "history.exportFailed")
            self.assertNotIn("foo", entry)
            self.assertNotIn("extra", entry)

    def test_is_valid_native_download_result_unit_contract(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const validSaved = {
              status: "saved", stage: "complete", format: "csv", source: "played",
              pageSize: 200, httpStatus: 200, contentType: "text/csv", bytes: 100,
              filenameExtension: "csv", elapsedMs: 50, stageTimings: [{ stage: "complete", elapsedMs: 10 }],
              errorCode: null, errorMessage: null,
            };
            const validCancelled = {
              status: "cancelled", stage: "choose_destination", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 30, stageTimings: [], errorCode: null, errorMessage: null,
            };
            const validFailed = {
              status: "failed", stage: "request_backend", format: "csv", source: "played",
              pageSize: 200, httpStatus: null, contentType: null, bytes: null,
              filenameExtension: null, elapsedMs: 40, stageTimings: [],
              errorCode: "ERR_BACKEND", errorMessage: "Backend failed",
            };

            const checks = {
              validSaved: helper.isValidNativeDownloadResult(validSaved),
              validCancelled: helper.isValidNativeDownloadResult(validCancelled),
              validFailed: helper.isValidNativeDownloadResult(validFailed),
              primitiveNull: helper.isValidNativeDownloadResult(null),
              primitiveNumber: helper.isValidNativeDownloadResult(123),
              primitiveArray: helper.isValidNativeDownloadResult([]),
              missingKey: helper.isValidNativeDownloadResult({ status: "saved" }),
              inheritedKey: helper.isValidNativeDownloadResult(Object.create(validSaved)),
              invalidStatus: helper.isValidNativeDownloadResult({ ...validSaved, status: "unknown" }),
              savedWrongStage: helper.isValidNativeDownloadResult({ ...validSaved, stage: "choose_destination" }),
              savedNoHttpStatus: helper.isValidNativeDownloadResult({ ...validSaved, httpStatus: null }),
              cancelledWithBackend: helper.isValidNativeDownloadResult({ ...validCancelled, httpStatus: 200 }),
              failedNoErrorCode: helper.isValidNativeDownloadResult({ ...validFailed, errorCode: null }),
              failedNoErrorMessage: helper.isValidNativeDownloadResult({ ...validFailed, errorMessage: null }),
              invalidElapsedMs: helper.isValidNativeDownloadResult({ ...validSaved, elapsedMs: -1 }),
              invalidStageTimings: helper.isValidNativeDownloadResult({ ...validSaved, stageTimings: "invalid" }),
            };
            process.stdout.write(JSON.stringify(checks));
            """,
            str(self.helper),
        )
        self.assertTrue(result["validSaved"])
        self.assertTrue(result["validCancelled"])
        self.assertTrue(result["validFailed"])
        self.assertFalse(result["primitiveNull"])
        self.assertFalse(result["primitiveNumber"])
        self.assertFalse(result["primitiveArray"])
        self.assertFalse(result["missingKey"])
        self.assertFalse(result["inheritedKey"])
        self.assertFalse(result["invalidStatus"])
        self.assertFalse(result["savedWrongStage"])
        self.assertFalse(result["savedNoHttpStatus"])
        self.assertFalse(result["cancelledWithBackend"])
        self.assertFalse(result["failedNoErrorCode"])
        self.assertFalse(result["failedNoErrorMessage"])
        self.assertFalse(result["invalidElapsedMs"])
        self.assertFalse(result["invalidStageTimings"])

    def test_stage_timings_capped_at_16_on_frontend(self):
        result = self.run_node(
            """
            const helper = require(process.argv[1]);
            const ring = helper.createExportDiagnosticRing(64);
            const manyTimings = Array.from({ length: 25 }, (_, i) => ({
              stage: `stage_${i}`,
              elapsedMs: i * 10,
            }));
            ring.push({
              timestamp: "2026-08-05T00:00:00Z",
              surface: "host",
              runtime: "tauri",
              format: "csv",
              source: "played",
              pageSize: 200,
              stage: "complete",
              status: "saved",
              elapsedMs: 250,
              stageTimings: manyTimings,
            });
            const snapshot = ring.snapshot();
            process.stdout.write(JSON.stringify({
              timingsCount: snapshot[0].stageTimings.length,
              firstStage: snapshot[0].stageTimings[0].stage,
              lastStage: snapshot[0].stageTimings[snapshot[0].stageTimings.length - 1].stage,
            }));
            """,
            str(self.helper),
        )
        self.assertEqual(result["timingsCount"], 16)
        self.assertEqual(result["firstStage"], "stage_0")
        self.assertEqual(result["lastStage"], "stage_15")

    def test_save_tauri_backend_download_path_isolation(self):
        save_source = self.function_source(
            self.sources["host"],
            "async function saveTauriBackendDownload",
            "async function setTauriWindowFullscreen",
        )
        calls = self.run_node(
            """
            const helper = require(process.argv[1]);
            const NativeURLSearchParams = global.URLSearchParams;
            global.window = global;
            window.BilikaraExportDownload = helper;
            global.URLSearchParams = NativeURLSearchParams;
            const state = { clientId: "client-1" };
            function t(key) { return key; }
            function clientHeaders() { return { "X-Bilikara-Client": state.clientId }; }
            function tauriInvoke() { return window.__TAURI__?.core?.invoke || null; }
            function isTauriCommandNotFoundError() { return false; }
            const invokedArgs = [];
            window.__TAURI__ = {
              core: {
                invoke(cmd, args) {
                  invokedArgs.push({ cmd, args });
                  return Promise.resolve({
                    status: "saved", stage: "complete", format: "zip", source: "diagnostics",
                    pageSize: 10, httpStatus: 200, contentType: "application/zip", bytes: 100,
                    filenameExtension: "zip", elapsedMs: 10, stageTimings: [], errorCode: null, errorMessage: null,
                  });
                }
              }
            };
            """ + save_source + """
            (async () => {
              await saveTauriBackendDownload("/api/diagnostics/package", JSON.stringify({ browser: {} }));
              await saveTauriBackendDownload("/api/playlist/export?format=csv", null);
              process.stdout.write(JSON.stringify(invokedArgs));
            })().catch((err) => { console.error(err); process.exit(1); });
            """,
            str(self.helper),
        )
        self.assertEqual(len(calls), 2)

        diag_path = calls[0]["args"]["request"]["path"]
        self.assertEqual(diag_path, "/api/diagnostics/package")
        self.assertNotIn("?", diag_path)
        self.assertNotIn("request_id", diag_path)
        self.assertNotIn("requestId", diag_path)

        playlist_path = calls[1]["args"]["request"]["path"]
        self.assertTrue(playlist_path.startswith("/api/playlist/export"))
        self.assertIn("request_id=", playlist_path)

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


class ImageExportDiagnosticsTest(unittest.TestCase):

    def test_playlist_image_export_populates_structured_timing_keys(self):
        from bilikara.playlist_export import playlist_image_export
        items = [
            {
                "id": "song-1",
                "title": "Test Song 1",
                "display_title": "Test Song 1",
                "bvid": "BV1234567890",
                "requester_name": "Alice",
            }
        ]
        timings: dict[str, Any] = {}
        payload, content_type, filename = playlist_image_export(items, timings=timings)
        self.assertTrue(len(payload) > 0)
        self.assertEqual(content_type, "image/png")
        self.assertEqual(filename, "bilikara-playlist.png")
        expected_keys = {
            "pillow_import",
            "prepare_items_and_pages",
            "font_discovery",
            "font_load",
            "font_cmap_cold_parse_ms",
            "font_cmap_cold_miss_count",
            "font_cmap_cold_bytes_read",
            "page_count",
            "page_render_total_ms",
            "page_render_max_ms",
            "png_encode_total_ms",
            "zip_write_finalize_ms",
            "total_image_export",
        }
        self.assertEqual(set(timings.keys()), expected_keys)
        self.assertEqual(timings["page_count"], 1)
        self.assertEqual(timings["zip_write_finalize_ms"], 0.0)
        for key, val in timings.items():
            if isinstance(val, float):
                self.assertGreaterEqual(val, 0.0)

    def test_cold_vs_warm_font_cmap_cache(self):
        from bilikara.playlist_export import _font_codepoints_for_path, playlist_image_export
        items = [
            {
                "id": "song-1",
                "title": "Cold Font Test",
                "display_title": "Cold Font Test",
                "bvid": "BV1234567890",
            }
        ]
        _font_codepoints_for_path.cache_clear()
        timings_cold: dict[str, Any] = {}
        playlist_image_export(items, timings=timings_cold)

        timings_warm: dict[str, Any] = {}
        playlist_image_export(items, timings=timings_warm)

        self.assertGreater(timings_cold["font_cmap_cold_miss_count"], 0)
        self.assertGreater(timings_cold["font_cmap_cold_bytes_read"], 0)
        self.assertEqual(timings_warm["font_cmap_cold_miss_count"], 0)
        self.assertEqual(timings_warm["font_cmap_cold_bytes_read"], 0)
        self.assertEqual(timings_warm["font_cmap_cold_parse_ms"], 0.0)

    def test_single_page_png_export(self):
        from bilikara.playlist_export import playlist_image_export
        items = [{"id": "s1", "title": "Single Item", "display_title": "Single Item"}]
        timings: dict[str, Any] = {}
        payload, content_type, filename = playlist_image_export(items, page_size=80, timings=timings)
        self.assertTrue(payload.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(content_type, "image/png")
        self.assertEqual(filename, "bilikara-playlist.png")
        self.assertEqual(timings["page_count"], 1)
        self.assertEqual(timings["zip_write_finalize_ms"], 0.0)

    def test_multipage_zip_export(self):
        import zipfile
        from bilikara.playlist_export import playlist_image_export
        items = [
            {"id": f"s-{i}", "title": f"Song {i}", "display_title": f"Song {i}"}
            for i in range(100)
        ]
        timings: dict[str, Any] = {}
        payload, content_type, filename = playlist_image_export(items, page_size=80, timings=timings)
        self.assertTrue(payload.startswith(b"PK\x03\x04"))
        self.assertEqual(content_type, "application/zip")
        self.assertEqual(filename, "bilikara-playlist-images.zip")
        self.assertEqual(timings["page_count"], 2)
        self.assertGreaterEqual(timings["png_encode_total_ms"], 0.0)
        self.assertGreaterEqual(timings["zip_write_finalize_ms"], 0.0)
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            self.assertEqual(len(zf.namelist()), 2)
            self.assertIn("bilikara-playlist-page-01.png", zf.namelist())
            self.assertIn("bilikara-playlist-page-02.png", zf.namelist())

    def test_image_export_diagnostics_propagation_to_artifact(self):
        from contextlib import redirect_stdout
        from unittest.mock import MagicMock
        from bilikara.server import CONTEXT, BilikaraHandler

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.connection = MagicMock()
        handler.connection.getsockname.return_value = ("127.0.0.1", 8080)
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/playlist/export?format=image"
        handler.context = CONTEXT

        context = {
            "format": "image",
            "source": "history",
            "page_size": 80,
            "request_id": "req-diag-123",
            "item_count": 1,
            "payload_size": 2048,
            "started_at": 1000.0,
            "image_export_timings": {
                "pillow_import": 1.2,
                "prepare_items_and_pages": 0.5,
                "font_discovery": 12.3,
                "font_load": 45.6,
                "font_cmap_cold_parse_ms": 8.9,
                "font_cmap_cold_miss_count": 1,
                "font_cmap_cold_bytes_read": 10240,
                "page_count": 1,
                "page_render_total_ms": 30.1,
                "page_render_max_ms": 30.1,
                "png_encode_total_ms": 15.4,
                "zip_write_finalize_ms": 0.0,
                "total_image_export": 114.0,
            },
        }

        buf = io.StringIO()
        with redirect_stdout(buf):
            handler._log_export_stage("export_payload_ready", context)

        artifact = CONTEXT.build_diagnostics()
        self.assertIn("export-diagnostics.json", artifact.files)
        sanitized_export = json.loads(artifact.files["export-diagnostics.json"].decode("utf-8"))
        matched_entry = next((e for e in sanitized_export if e.get("requestId") == "req-diag-123"), None)
        self.assertIsNotNone(matched_entry)
        self.assertEqual(matched_entry["surface"], "server")
        self.assertEqual(matched_entry["format"], "image")
        self.assertIn("imageExportTimings", matched_entry)
        self.assertEqual(matched_entry["imageExportTimings"]["font_discovery"], 12.3)
        self.assertEqual(matched_entry["imageExportTimings"]["font_cmap_cold_miss_count"], 1)

    def test_privacy_and_csv_export_isolation(self):
        from bilikara.playlist_export import playlist_csv_bytes
        from bilikara.server import CONTEXT

        csv_bytes = playlist_csv_bytes([{"id": "c1", "title": "CSV Title", "display_title": "CSV Title"}])
        self.assertTrue(len(csv_bytes) > 0)
        self.assertTrue(csv_bytes.startswith(b"\xef\xbb\xbf"))

    def test_backend_export_preserves_supplied_request_id(self):
        from contextlib import redirect_stdout
        from unittest.mock import MagicMock
        from bilikara.server import CONTEXT, BilikaraHandler

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.connection = MagicMock()
        handler.connection.getsockname.return_value = ("127.0.0.1", 8080)
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/playlist/export?format=image&request_id=req-correlation-123"
        handler.context = CONTEXT

        context = {
            "format": "image",
            "source": "history",
            "page_size": 80,
            "request_id": "req-correlation-123",
            "item_count": 1,
            "payload_size": 1024,
            "started_at": 1000.0,
            "image_export_timings": {"total_image_export": 50.0},
        }
        buf = io.StringIO()
        with redirect_stdout(buf):
            handler._log_export_stage("export_payload_ready", context)

        snapshot = CONTEXT.export_diagnostics_snapshot()
        matched = next((e for e in snapshot if e.get("requestId") == "req-correlation-123"), None)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["surface"], "server")
        self.assertEqual(matched["requestId"], "req-correlation-123")

    def test_diagnostics_artifact_correlates_native_and_server_records(self):
        from bilikara.server import CONTEXT

        native_record = {
            "timestamp": "2026-08-07T12:00:00Z",
            "surface": "host",
            "runtime": "tauri",
            "format": "image",
            "source": "history",
            "pageSize": 80,
            "stage": "complete",
            "status": "saved",
            "httpStatus": 200,
            "contentType": "image/png",
            "bytes": 2048,
            "filenameExtension": "png",
            "elapsedMs": 120,
            "requestId": "req-corr-456",
        }
        server_record = {
            "timestamp": "2026-08-07T12:00:00Z",
            "surface": "server",
            "runtime": "python",
            "format": "image",
            "source": "history",
            "pageSize": 80,
            "stage": "export_payload_ready",
            "status": "completed",
            "httpStatus": 200,
            "bytes": 2048,
            "elapsedMs": 95.0,
            "requestId": "req-corr-456",
            "imageExportTimings": {
                "pillow_import": 1.0,
                "total_image_export": 95.0,
            },
        }

        CONTEXT.record_export_diagnostic(native_record)
        CONTEXT.record_export_diagnostic(server_record)

        artifact = CONTEXT.build_diagnostics()
        self.assertIn("export-diagnostics.json", artifact.files)
        data = json.loads(artifact.files["export-diagnostics.json"].decode("utf-8"))
        correlated = [e for e in data if e.get("requestId") == "req-corr-456"]
        self.assertEqual(len(correlated), 2)
        surfaces = {e["surface"] for e in correlated}
        self.assertEqual(surfaces, {"host", "server"})
        server_item = next(e for e in correlated if e["surface"] == "server")
        self.assertIn("imageExportTimings", server_item)
        self.assertEqual(server_item["imageExportTimings"]["total_image_export"], 95.0)

    def test_backend_export_generates_fallback_request_id_when_omitted(self):
        from contextlib import redirect_stdout
        from unittest.mock import MagicMock
        from bilikara.server import CONTEXT, BilikaraHandler

        handler = BilikaraHandler.__new__(BilikaraHandler)
        handler.connection = MagicMock()
        handler.connection.getsockname.return_value = ("127.0.0.1", 8080)
        handler.client_address = ("127.0.0.1", 12345)
        handler.path = "/api/playlist/export?format=image"
        handler.context = CONTEXT

        context = {
            "format": "image",
            "source": "history",
            "page_size": 80,
            "request_id": "fallback-generated-id-789",
            "item_count": 1,
            "payload_size": 1024,
            "started_at": 1000.0,
        }
        buf = io.StringIO()
        with redirect_stdout(buf):
            handler._log_export_stage("export_payload_ready", context)

        snapshot = CONTEXT.export_diagnostics_snapshot()
        matched = next((e for e in snapshot if e.get("requestId") == "fallback-generated-id-789"), None)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["surface"], "server")
        self.assertTrue(len(matched["requestId"]) > 0)


if __name__ == "__main__":
    unittest.main()

