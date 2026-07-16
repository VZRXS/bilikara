import json
import shutil
import subprocess
import unittest
from pathlib import Path


class AsyncActionGuardsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        v20_node = Path("/tmp/node-v20.18.0-linux-x64/bin/node")
        if v20_node.is_file():
            cls.node = str(v20_node)
        else:
            cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.app_js = cls.repo_root / "static" / "app.js"
        cls.export_guard_js = cls.repo_root / "static" / "export-guard.js"

    def run_node_app_test(self, test_script: str) -> dict:
        harness = """
        const fs = require('fs');

        global.window = global;
        window.addEventListener = function() {};
        window.removeEventListener = function() {};
        window.requestAnimationFrame = function(cb) { return setTimeout(cb, 0); };
        window.cancelAnimationFrame = function(id) { clearTimeout(id); };

        function createMockElement(tag) {
          const listeners = {};
          return {
            tagName: tag ? tag.toUpperCase() : "DIV",
            className: "",
            listeners,
            dataset: {},
            classList: {
              add() {},
              remove() {},
              toggle() {},
            },
            style: {},
            attributes: {},
            setAttribute(k, v) { this.attributes[k] = String(v); },
            removeAttribute(k) { delete this.attributes[k]; },
            addEventListener(evt, fn) { listeners[evt] = fn; },
            getBoundingClientRect() { return { right: 100, bottom: 100, left: 10, top: 10 }; },
            click() {
              if (listeners["click"]) {
                return listeners["click"]({ target: this, preventDefault() {}, stopPropagation() {} });
              }
            },
            appendChild() {},
            append() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            content: { firstElementChild: { cloneNode() { return createMockElement("div"); } } },
          };
        }

        const docElements = {};
        global.document = {
          listeners: {},
          elements: docElements,
          documentElement: createMockElement("html"),
          head: createMockElement("head"),
          body: createMockElement("body"),
          cookie: "",
          createElement(tag) {
            return createMockElement(tag);
          },
          getElementById(id) {
            if (!docElements[id]) {
              docElements[id] = createMockElement("button");
              docElements[id].id = id;
              docElements[id].disabled = false;
              docElements[id].textContent = "Original Text";
            }
            return docElements[id];
          },
          querySelector() { return createMockElement("div"); },
          querySelectorAll() { return []; },
          addEventListener(evt, fn) {
            this.listeners[evt] = fn;
          }
        };
        global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
        global.navigator = { userAgent: "node" };
        global.URLSearchParams = class { has() { return false; } };
        global.location = { search: "", href: "" };
        global.fetch = function() { return new Promise(() => {}); };
        global.BilikaraExportGuard = require(""" + json.dumps(str(self.export_guard_js)) + """);

        // Load app.js and bind top-level declarations to global object
        const appSource = fs.readFileSync(""" + json.dumps(str(self.app_js)) + """, 'utf-8');
        eval(appSource + "; global.state = state; global.elements = elements; global.t = t; global.closeOpenMenus = closeOpenMenus;");

        """ + test_script
        process = subprocess.run(
            [self.node, "-e", harness],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return json.loads(process.stdout)

    def test_confirm_ok_prevents_duplicate_click_and_restores_state(self):
        res = self.run_node_app_test(
            """
            let actionCalls = 0;
            let resolveAction;
            global.state.confirmIntent = { type: "clear-playlist" };

            global.clearPlaylist = function() {
              actionCalls++;
              return new Promise(res => { resolveAction = res; });
            };

            const okBtn = global.elements.confirmOk;
            const secBtn = global.elements.confirmSecondary;
            okBtn.textContent = "Confirm Clear";
            secBtn.textContent = "Cancel";

            okBtn.click();

            const stateDuringRun = {
              okDisabled: okBtn.disabled,
              okAriaBusy: okBtn.attributes["aria-busy"],
              okText: okBtn.textContent,
              secDisabled: secBtn.disabled,
              secAriaBusy: secBtn.attributes["aria-busy"],
              actionCalls: actionCalls,
            };

            okBtn.click();
            const callsAfterSecondClick = actionCalls;

            resolveAction();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                stateDuringRun,
                callsAfterSecondClick,
                finalOkDisabled: okBtn.disabled,
                finalOkAriaBusy: okBtn.attributes["aria-busy"] || null,
                finalOkText: okBtn.textContent,
                finalSecDisabled: secBtn.disabled,
                finalSecAriaBusy: secBtn.attributes["aria-busy"] || null,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["stateDuringRun"]["actionCalls"], 1)
        self.assertEqual(res["callsAfterSecondClick"], 1)
        self.assertTrue(res["stateDuringRun"]["okDisabled"])
        self.assertEqual(res["stateDuringRun"]["okAriaBusy"], "true")
        self.assertTrue(res["stateDuringRun"]["secDisabled"])
        self.assertFalse(res["finalOkDisabled"])
        self.assertIsNone(res["finalOkAriaBusy"])
        self.assertEqual(res["finalOkText"], "Confirm Clear")

    def test_confirm_ok_restores_state_after_failure(self):
        res = self.run_node_app_test(
            """
            let actionCalls = 0;
            global.state.confirmIntent = { type: "clear-playlist" };

            global.clearPlaylist = function() {
              actionCalls++;
              return Promise.reject(new Error("network error"));
            };

            const okBtn = global.elements.confirmOk;
            okBtn.textContent = "Clear";

            okBtn.click();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                actionCalls,
                finalOkDisabled: okBtn.disabled,
                finalOkAriaBusy: okBtn.attributes["aria-busy"] || null,
                finalOkText: okBtn.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["actionCalls"], 1)
        self.assertFalse(res["finalOkDisabled"])
        self.assertIsNone(res["finalOkAriaBusy"])
        self.assertEqual(res["finalOkText"], "Clear")

    def test_gatcha_confirm_button_prevents_duplicate_and_restores(self):
        res = self.run_node_app_test(
            """
            let submitCalls = 0;
            let resolveSubmit;
            global.state.gatchaCandidate = { url: "https://bilibili.com/video/BV1xx", title: "Test Song" };
            global.validatedRequesterNameForAdd = function() { return "TestUser"; };

            global.submitAddRequest = function() {
              submitCalls++;
              return new Promise(res => { resolveSubmit = res; });
            };

            const gatchaBtn = global.elements.gatchaConfirmButton;
            gatchaBtn.textContent = "确定点歌";

            gatchaBtn.click();

            const stateDuringRun = {
              disabled: gatchaBtn.disabled,
              ariaBusy: gatchaBtn.attributes["aria-busy"],
              text: gatchaBtn.textContent,
              submitCalls: submitCalls,
            };

            gatchaBtn.click();
            const callsAfterSecondClick = submitCalls;

            resolveSubmit({ playlist: [] });

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                stateDuringRun,
                callsAfterSecondClick,
                finalDisabled: gatchaBtn.disabled,
                finalAriaBusy: gatchaBtn.attributes["aria-busy"] || null,
                finalText: gatchaBtn.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["stateDuringRun"]["submitCalls"], 1)
        self.assertEqual(res["callsAfterSecondClick"], 1)
        self.assertTrue(res["stateDuringRun"]["disabled"])
        self.assertEqual(res["stateDuringRun"]["ariaBusy"], "true")
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])
        self.assertEqual(res["finalText"], "确定点歌")

    def test_history_readd_button_prevents_duplicate_and_restores(self):
        res = self.run_node_app_test(
            """
            let handleAddCalls = 0;
            let resolveAdd;

            global.handleAddByUrl = function() {
              handleAddCalls++;
              return new Promise(res => { resolveAdd = res; });
            };

            const btn = createMockElement("button");
            btn.dataset = { action: "history-tail", url: "https://bilibili.com/video/BV2xx" };
            btn.textContent = "加到末尾";
            btn.disabled = false;

            const event = {
              target: {
                closest(selector) {
                  return selector === "button[data-action]" ? btn : null;
                }
              }
            };
            const historyListener = global.elements.historyList.listeners["click"];

            historyListener(event);

            const stateDuringRun = {
              disabled: btn.disabled,
              ariaBusy: btn.attributes["aria-busy"],
              text: btn.textContent,
              handleAddCalls: handleAddCalls,
            };

            historyListener(event);
            const callsAfterSecondClick = handleAddCalls;

            resolveAdd();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                stateDuringRun,
                callsAfterSecondClick,
                finalDisabled: btn.disabled,
                finalAriaBusy: btn.attributes["aria-busy"] || null,
                finalText: btn.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["stateDuringRun"]["handleAddCalls"], 1)
        self.assertEqual(res["callsAfterSecondClick"], 1)
        self.assertTrue(res["stateDuringRun"]["disabled"])
        self.assertEqual(res["stateDuringRun"]["ariaBusy"], "true")
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])
        self.assertEqual(res["finalText"], "加到末尾")

    def test_resort_playlist_button_prevents_duplicate_and_restores(self):
        res = self.run_node_app_test(
            """
            let resortCalls = 0;
            let resolveResort;

            global.resortPlaylistByCycle = function() {
              resortCalls++;
              return new Promise(res => { resolveResort = res; });
            };

            const resortBtn = global.elements.resortPlaylistButton;
            resortBtn.textContent = "重新排序";

            resortBtn.click();

            const stateDuringRun = {
              disabled: resortBtn.disabled,
              ariaBusy: resortBtn.attributes["aria-busy"],
              text: resortBtn.textContent,
              resortCalls: resortCalls,
            };

            resortBtn.click();
            const callsAfterSecondClick = resortCalls;

            resolveResort();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                stateDuringRun,
                callsAfterSecondClick,
                finalDisabled: resortBtn.disabled,
                finalAriaBusy: resortBtn.attributes["aria-busy"] || null,
                finalText: resortBtn.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["stateDuringRun"]["resortCalls"], 1)
        self.assertEqual(res["callsAfterSecondClick"], 1)
        self.assertTrue(res["stateDuringRun"]["disabled"])
        self.assertEqual(res["stateDuringRun"]["ariaBusy"], "true")
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])
        self.assertEqual(res["finalText"], "重新排序")


if __name__ == "__main__":
    unittest.main()
