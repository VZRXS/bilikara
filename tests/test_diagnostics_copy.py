from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


class DiagnosticsCopyBehaviorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.root = Path(__file__).resolve().parents[1]
        cls.helper = cls.root / "static" / "diagnostics-copy.js"
        cls.helper_source = cls.helper.read_text(encoding="utf-8")
        cls.app_source = (cls.root / "static" / "app.js").read_text(encoding="utf-8")

    def run_node(self, script: str) -> dict:
        process = subprocess.run(
            [self.node, "-e", script, str(self.helper)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return json.loads(process.stdout)

    def test_tauri_native_write_is_preferred_and_preserves_unicode(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            const markdown = "# 診断\n中文内容 🎤";
            const calls = { native: [], web: [] };
            helper.copyText(markdown, {
              tauri: { clipboardManager: { async writeText(value) { calls.native.push(value); } } },
              navigator: { clipboard: { async writeText(value) { calls.web.push(value); } } },
            }).then((value) => process.stdout.write(JSON.stringify({ value, calls })));
            """
        )
        self.assertEqual(result["value"], {"transport": "tauri"})
        self.assertEqual(result["calls"]["native"], ["# 診断\n中文内容 🎤"])
        self.assertEqual(result["calls"]["web"], [])

    def test_browser_uses_web_clipboard_and_native_failure_falls_back(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            const calls = [];
            async function run() {
              const browser = await helper.copyText("browser", {
                tauri: null,
                navigator: { clipboard: { async writeText(value) { calls.push(`web:${value}`); } } },
              });
              const fallback = await helper.copyText("fallback", {
                tauri: { clipboardManager: { async writeText() {
                  calls.push("native:failed");
                  throw new Error("native unavailable");
                } } },
                navigator: { clipboard: { async writeText(value) { calls.push(`web:${value}`); } } },
              });
              return { browser, fallback, calls };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            """
        )
        self.assertEqual(result["browser"], {"transport": "web"})
        self.assertEqual(result["fallback"], {"transport": "web"})
        self.assertEqual(
            result["calls"],
            ["web:browser", "native:failed", "web:fallback"],
        )

    def test_total_native_and_web_failure_reports_only_safe_message(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            const secretMarkdown = "# SESSDATA=must-not-appear";
            helper.copyText(secretMarkdown, {
              fallbackMessage: "translated clipboard failure",
              tauri: { clipboardManager: { async writeText(value) {
                throw new Error(`native rejected ${value}`);
              } } },
              navigator: { clipboard: { async writeText(value) {
                throw new Error(`web rejected ${value}`);
              } } },
              document: null,
            }).then(() => {
              process.stdout.write(JSON.stringify({ error: null }));
            }).catch((error) => {
              process.stdout.write(JSON.stringify({ error: error.message }));
            });
            """
        )
        self.assertEqual(result["error"], "translated clipboard failure")
        self.assertNotIn("SESSDATA", result["error"])

    def test_first_copy_failure_retains_markdown_and_second_click_does_not_regenerate(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            let requests = 0;
            let writes = 0;
            const copied = [];
            const controller = helper.createRetryController({
              async generate() { requests += 1; return "# 已生成的诊断"; },
              async copyText(value) {
                writes += 1;
                if (writes === 1) throw new Error("activation expired");
                copied.push(value);
                return { transport: "web" };
              },
            });
            async function run() {
              const first = await controller.copy();
              const pendingAfterFirst = controller.hasPendingMarkdown();
              const second = await controller.copy();
              return {
                first: { status: first.status, reused: first.reused },
                second: { status: second.status, reused: second.reused },
                pendingAfterFirst,
                pendingAfterSecond: controller.hasPendingMarkdown(),
                requests,
                writes,
                copied,
              };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            """
        )
        self.assertEqual(result["first"], {"status": "ready", "reused": False})
        self.assertTrue(result["pendingAfterFirst"])
        self.assertEqual(result["second"], {"status": "copied", "reused": True})
        self.assertFalse(result["pendingAfterSecond"])
        self.assertEqual(result["requests"], 1)
        self.assertEqual(result["writes"], 2)
        self.assertEqual(result["copied"], ["# 已生成的诊断"])

    def test_warm_success_clears_state_and_generation_failure_retries(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            async function run() {
              let warmRequests = 0;
              let warmWrites = 0;
              const warm = helper.createRetryController({
                async generate() { warmRequests += 1; return "# warm"; },
                async copyText() { warmWrites += 1; return { transport: "web" }; },
              });
              const warmResult = await warm.copy();

              let failureRequests = 0;
              const failure = helper.createRetryController({
                async generate() {
                  failureRequests += 1;
                  if (failureRequests === 1) throw new Error("generation failed");
                  return "# regenerated";
                },
                async copyText() { return { transport: "web" }; },
              });
              let firstError = "";
              try { await failure.copy(); } catch (error) { firstError = error.message; }
              const pendingAfterFailure = failure.hasPendingMarkdown();
              const retryResult = await failure.copy();
              return {
                warmResult,
                warmRequests,
                warmWrites,
                warmPending: warm.hasPendingMarkdown(),
                firstError,
                pendingAfterFailure,
                failureRequests,
                retryResult,
              };
            }
            run().then((value) => process.stdout.write(JSON.stringify(value)));
            """
        )
        self.assertEqual(result["warmResult"]["status"], "copied")
        self.assertEqual(result["warmRequests"], 1)
        self.assertEqual(result["warmWrites"], 1)
        self.assertFalse(result["warmPending"])
        self.assertEqual(result["firstError"], "generation failed")
        self.assertFalse(result["pendingAfterFailure"])
        self.assertEqual(result["failureRequests"], 2)
        self.assertEqual(result["retryResult"]["status"], "copied")

    def test_empty_and_malformed_generation_are_never_cached(self):
        result = self.run_node(
            r"""
            const helper = require(process.argv[1]);
            const values = ["", "   ", null, { markdown: "wrong shape" }];
            async function run() {
              const states = [];
              for (const value of values) {
                const controller = helper.createRetryController({
                  async generate() { return value; },
                  async copyText() { throw new Error("must not copy"); },
                });
                try { await controller.copy(); } catch (_) {}
                states.push(controller.hasPendingMarkdown());
              }
              return states;
            }
            run().then((states) => process.stdout.write(JSON.stringify({ states })));
            """
        )
        self.assertEqual(result["states"], [False, False, False, False])

    def test_retry_state_is_memory_only_and_app_uses_generic_abstraction(self):
        for storage_name in ("localStorage", "sessionStorage", "indexedDB"):
            self.assertNotIn(storage_name, self.helper_source)
        self.assertIn("helper.createRetryController", self.app_source)
        self.assertIn("helper.copyText(markdown", self.app_source)
        self.assertIn("controller.hasPendingMarkdown()", self.app_source)


class TauriClipboardCapabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.cargo = (cls.root / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
        cls.main = (cls.root / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8")
        cls.capability = json.loads(
            (cls.root / "src-tauri" / "capabilities" / "main.json").read_text(encoding="utf-8")
        )
        cls.helper = (cls.root / "static" / "diagnostics-copy.js").read_text(encoding="utf-8")

    def test_official_write_only_clipboard_plugin_is_registered(self):
        self.assertIn('tauri-plugin-clipboard-manager = "2"', self.cargo)
        self.assertIn("tauri_plugin_clipboard_manager::init()", self.main)
        self.assertIn("clipboard-manager:allow-write-text", self.capability["permissions"])

    def test_clipboard_read_is_not_exposed(self):
        permissions = "\n".join(self.capability["permissions"])
        self.assertNotIn("allow-read", permissions)
        self.assertNotIn("clipboard-manager:default", permissions)
        self.assertNotIn("readText", self.helper)


if __name__ == "__main__":
    unittest.main()
