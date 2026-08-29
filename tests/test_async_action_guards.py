import json
import shutil
import subprocess
import unittest
from pathlib import Path


class AsyncActionGuardsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.app_js = cls.repo_root / "static" / "app.js"
        cls.remote_js = cls.repo_root / "static" / "remote.js"
        cls.remote_css = cls.repo_root / "static" / "remote.css"
        cls.export_guard_js = cls.repo_root / "static" / "export-guard.js"
        cls.i18n_json = cls.repo_root / "static" / "i18n.json"

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
          const classes = new Set();
          return {
            tagName: tag ? tag.toUpperCase() : "DIV",
            className: "",
            listeners,
            dataset: {},
            classList: {
              add(...names) { names.forEach(name => classes.add(name)); },
              remove(...names) { names.forEach(name => classes.delete(name)); },
              toggle(name, force) {
                if (force === true) { classes.add(name); return true; }
                if (force === false) { classes.delete(name); return false; }
                if (classes.has(name)) { classes.delete(name); return false; }
                classes.add(name); return true;
              },
              contains(name) { return classes.has(name); },
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
        eval(appSource + "; global.state = state; global.elements = elements; global.t = t; global.closeOpenMenus = closeOpenMenus; global.renderBackupBanner = renderBackupBanner; global.dismissBackupBanner = dismissBackupBanner;");

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

    def test_application_restart_is_hidden_without_tauri_and_cancel_keeps_settings_open(self):
        res = self.run_node_app_test(
            """
            const row = global.elements.applicationRestartRow;
            const button = global.elements.applicationRestartButton;
            delete global.__TAURI__;
            button.click();
            const browser = {
              hidden: row.classList.contains("hidden"),
              ariaHidden: row.attributes["aria-hidden"],
              disabled: button.disabled,
              confirmIntent: global.state.confirmIntent,
            };

            global.__TAURI__ = { core: { invoke() { throw new Error("must not invoke before confirm"); } } };
            global.state.cacheSettingsOpen = true;
            global.state.cacheAdvancedOpen = true;
            button.click();
            const native = {
              hidden: row.classList.contains("hidden"),
              ariaHidden: row.attributes["aria-hidden"],
              disabled: button.disabled,
              confirmType: global.state.confirmIntent?.type,
              confirmMessage: global.state.confirmIntent?.message,
            };
            global.elements.confirmCancel.click();

            process.stdout.write(JSON.stringify({
              browser,
              native,
              afterCancel: {
                confirmIntent: global.state.confirmIntent,
                cacheSettingsOpen: global.state.cacheSettingsOpen,
                cacheAdvancedOpen: global.state.cacheAdvancedOpen,
              },
            }));
            """
        )
        self.assertTrue(res["browser"]["hidden"])
        self.assertEqual(res["browser"]["ariaHidden"], "true")
        self.assertTrue(res["browser"]["disabled"])
        self.assertIsNone(res["browser"]["confirmIntent"])
        self.assertFalse(res["native"]["hidden"])
        self.assertEqual(res["native"]["ariaHidden"], "false")
        self.assertFalse(res["native"]["disabled"])
        self.assertEqual(res["native"]["confirmType"], "restart-application")
        self.assertIn("restartApplicationConfirm", res["native"]["confirmMessage"])
        self.assertIsNone(res["afterCancel"]["confirmIntent"])
        self.assertTrue(res["afterCancel"]["cacheSettingsOpen"])
        self.assertTrue(res["afterCancel"]["cacheAdvancedOpen"])

    def test_application_restart_double_activation_invokes_once_and_stays_busy(self):
        res = self.run_node_app_test(
            """
            let invokeCalls = [];
            let resolveInvoke;
            const httpCalls = [];
            global.fetch = (...args) => {
              httpCalls.push(args);
              return new Promise(() => {});
            };
            global.__TAURI__ = { core: { invoke(command, payload) {
              invokeCalls.push({ command, payload: payload ?? null });
              return new Promise(resolve => { resolveInvoke = resolve; });
            } } };

            const sourceButton = global.elements.applicationRestartButton;
            const okButton = global.elements.confirmOk;
            sourceButton.click();
            okButton.click();
            const during = {
              sourceDisabled: sourceButton.disabled,
              sourceAriaBusy: sourceButton.attributes["aria-busy"],
              confirmDisabled: okButton.disabled,
              confirmAriaBusy: okButton.attributes["aria-busy"],
              invokeCount: invokeCalls.length,
            };
            okButton.click();
            sourceButton.click();
            const callsAfterRepeatedActivation = invokeCalls.length;
            resolveInvoke();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                during,
                callsAfterRepeatedActivation,
                invokeCalls,
                httpCalls: httpCalls.length,
                final: {
                  sourceDisabled: sourceButton.disabled,
                  sourceAriaBusy: sourceButton.attributes["aria-busy"],
                  confirmDisabled: okButton.disabled,
                  confirmAriaBusy: okButton.attributes["aria-busy"],
                  inFlight: global.state.applicationRestartInFlight,
                },
              }));
            }, 10);
            """
        )
        self.assertEqual(res["during"]["invokeCount"], 1)
        self.assertEqual(res["callsAfterRepeatedActivation"], 1)
        self.assertEqual(
            res["invokeCalls"],
            [{"command": "restart_application", "payload": None}],
        )
        self.assertEqual(res["httpCalls"], 0)
        for state in (res["during"], res["final"]):
            self.assertTrue(state["sourceDisabled"])
            self.assertEqual(state["sourceAriaBusy"], "true")
            self.assertTrue(state["confirmDisabled"])
            self.assertEqual(state["confirmAriaBusy"], "true")
        self.assertTrue(res["final"]["inFlight"])

    def test_application_restart_invoke_failure_restores_controls_with_bounded_error(self):
        res = self.run_node_app_test(
            """
            let invokeCalls = 0;
            global.__TAURI__ = { core: { invoke() {
              invokeCalls += 1;
              return Promise.reject(new Error("sensitive native failure details"));
            } } };
            global.state.translations = {
              zh: { "service.restartApplicationFailed": "无法重启桌面应用。" },
            };

            const sourceButton = global.elements.applicationRestartButton;
            const okButton = global.elements.confirmOk;
            sourceButton.click();
            okButton.click();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                invokeCalls,
                sourceDisabled: sourceButton.disabled,
                sourceAriaBusy: sourceButton.attributes["aria-busy"] || null,
                confirmDisabled: okButton.disabled,
                confirmAriaBusy: okButton.attributes["aria-busy"] || null,
                inFlight: global.state.applicationRestartInFlight,
                message: global.elements.appToast.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["invokeCalls"], 1)
        self.assertFalse(res["sourceDisabled"])
        self.assertIsNone(res["sourceAriaBusy"])
        self.assertFalse(res["confirmDisabled"])
        self.assertIsNone(res["confirmAriaBusy"])
        self.assertFalse(res["inFlight"])
        self.assertEqual(res["message"], "无法重启桌面应用。")
        self.assertNotIn("sensitive", res["message"])

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

            resolveSubmit(true);

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                stateDuringRun,
                callsAfterSecondClick,
                candidate: global.state.gatchaCandidate,
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
        self.assertIsNone(res["candidate"])
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])
        self.assertEqual(res["finalText"], "确定点歌")

    def test_gatcha_draw_is_single_flight_and_exposes_busy_state(self):
        res = self.run_node_app_test(
            """
            let fetchCalls = 0;
            let resolveFetch;
            global.fetch = function() {
              fetchCalls += 1;
              return new Promise(resolve => { resolveFetch = resolve; });
            };

            const drawButton = global.elements.gatchaButton;
            drawButton.textContent = "Draw";
            drawButton.click();
            const during = {
              fetchCalls,
              disabled: drawButton.disabled,
              ariaBusy: drawButton.attributes["aria-busy"] || null,
              text: drawButton.textContent,
            };
            drawButton.click();
            const callsAfterRepeat = fetchCalls;
            resolveFetch({
              ok: true,
              json() {
                return { ok: true, data: { url: "https://bilibili.com/video/BVdraw", title: "Drawn Song" } };
              },
            });

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                during,
                callsAfterRepeat,
                candidate: global.state.gatchaCandidate,
                drawBusy: global.state.gatchaDrawBusy,
                finalDisabled: drawButton.disabled,
                finalAriaBusy: drawButton.attributes["aria-busy"] || null,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["during"]["fetchCalls"], 1)
        self.assertEqual(res["callsAfterRepeat"], 1)
        self.assertTrue(res["during"]["disabled"])
        self.assertEqual(res["during"]["ariaBusy"], "true")
        self.assertEqual(res["during"]["text"], "gatcha.drawing")
        self.assertEqual(res["candidate"]["title"], "Drawn Song")
        self.assertFalse(res["drawBusy"])
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])

    def test_stale_gatcha_add_retains_candidate(self):
        res = self.run_node_app_test(
            """
            global.state.gatchaCandidate = {
              url: "https://bilibili.com/video/BVstale",
              title: "Retained Song",
            };
            global.validatedRequesterNameForAdd = function() { return "Exact User"; };
            global.submitAddRequest = function() { return Promise.resolve(false); };
            global.elements.gatchaConfirmButton.click();
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                candidate: global.state.gatchaCandidate,
                message: global.elements.gatchaMessage.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["candidate"]["title"], "Retained Song")
        self.assertEqual(res["message"], "error.requestFailed")

    def test_gatcha_duplicate_confirmation_keeps_exact_source_and_requester(self):
        res = self.run_node_app_test(
            """
            global.state.gatchaCandidate = {
              url: "https://bilibili.com/video/BVduplicate",
              title: "Duplicate Song",
            };
            global.validatedRequesterNameForAdd = function() { return "Exact User"; };
            global.submitAddRequest = function() {
              const error = new Error("duplicate");
              error.code = "duplicate_session_request";
              error.payload = {};
              return Promise.reject(error);
            };
            global.elements.gatchaConfirmButton.click();
            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                candidate: global.state.gatchaCandidate,
                intent: global.state.confirmIntent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["candidate"]["title"], "Duplicate Song")
        self.assertEqual(res["intent"]["type"], "duplicate-add")
        self.assertEqual(res["intent"]["source"], "gatcha")
        self.assertEqual(res["intent"]["requesterName"], "Exact User")

    def test_remote_gatcha_confirm_button_prevents_duplicate_and_restores(self):
        source = self.remote_js.read_text(encoding="utf-8")
        start = source.index("async function confirmGatchaCandidate")
        end = source.index("async function sendPlayerControl", start)
        function_source = source[start:end]
        script = f"""
const state = {{
  submitting: false,
  gatchaCandidate: {{ url: "https://bilibili.com/video/BV1xx" }},
}};
const button = {{
  disabled: false,
  textContent: "确定点歌",
  attributes: {{}},
  setAttribute(key, value) {{ this.attributes[key] = String(value); }},
  removeAttribute(key) {{ delete this.attributes[key]; }},
}};
const elements = {{ gatchaConfirmButton: button }};
function t() {{ return "添加中..."; }}
let addCalls = 0;
let resolveAdd;
function addByUrl() {{
  addCalls += 1;
  return new Promise((resolve) => {{ resolveAdd = resolve; }});
}}
{function_source}
const first = confirmGatchaCandidate();
const during = {{
  disabled: button.disabled,
  ariaBusy: button.attributes["aria-busy"],
  text: button.textContent,
}};
const second = confirmGatchaCandidate();
resolveAdd();
Promise.all([first, second]).then((results) => {{
  process.stdout.write(JSON.stringify({{
    addCalls,
    during,
    results,
    finalDisabled: button.disabled,
    finalAriaBusy: button.attributes["aria-busy"] || null,
    finalText: button.textContent,
  }}));
}});
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["addCalls"], 1)
        self.assertTrue(result["during"]["disabled"])
        self.assertEqual(result["during"]["ariaBusy"], "true")
        self.assertEqual(result["during"]["text"], "添加中...")
        self.assertEqual(result["results"], [True, False])
        self.assertFalse(result["finalDisabled"])
        self.assertIsNone(result["finalAriaBusy"])
        self.assertEqual(result["finalText"], "确定点歌")
        self.assertIn(".primary-button:disabled", self.remote_css.read_text(encoding="utf-8"))

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

    def test_previous_session_banner_uses_countdown_and_localized_continue_action(self):
        res = self.run_node_app_test(
            """
            global.state.translations = JSON.parse(fs.readFileSync("""
            + json.dumps(str(self.i18n_json))
            + """, "utf-8")).languages;
            global.state.language = "zh";
            global.renderBackupBanner(
              { available: false },
              { available: true, item_count: 2 },
              false,
              0,
              false,
            );
            const zh = {
              mode: global.state.backupBannerMode,
              title: global.elements.backupTitle.textContent,
              text: global.elements.backupText.textContent,
              action: global.elements.backupActionButton.textContent,
              countdown: global.elements.dismissBackupButton.textContent,
              visible: !global.elements.backupBanner.classList.contains("hidden"),
              timerActive: Boolean(global.state.backupBannerCountdownTimer),
            };

            global.state.language = "en";
            global.renderBackupBanner(
              { available: false },
              { available: true, item_count: 2 },
              false,
              0,
              false,
            );
            const enAction = global.elements.backupActionButton.textContent;

            global.state.language = "ja";
            global.renderBackupBanner(
              { available: false },
              { available: true, item_count: 2 },
              false,
              0,
              false,
            );
            const jaAction = global.elements.backupActionButton.textContent;
            global.dismissBackupBanner();

            global.state.previousSessionPromptChecked = false;
            global.state.previousSessionPromptEligible = false;
            global.state.backupBannerShown = false;
            global.state.backupBannerDismissed = false;
            global.state.language = "zh";
            global.renderBackupBanner(
              { available: true, playlist_count: 3 },
              { available: true, item_count: 2 },
              true,
              0,
              true,
            );
            const autoRestore = {
              mode: global.state.backupBannerMode,
              action: global.elements.backupActionButton.textContent,
              text: global.elements.backupText.textContent,
            };
            global.dismissBackupBanner();
            process.stdout.write(JSON.stringify({ zh, enAction, jaAction, autoRestore }));
            """
        )
        self.assertEqual(res["zh"]["mode"], "previous_session")
        self.assertEqual(res["zh"]["title"], "上一场")
        self.assertEqual(res["zh"]["text"], "检测到上一场记录，共 2 首。")
        self.assertEqual(res["zh"]["action"], "继续上一场")
        self.assertEqual(res["zh"]["countdown"], "5")
        self.assertTrue(res["zh"]["visible"])
        self.assertTrue(res["zh"]["timerActive"])
        self.assertEqual(res["enAction"], "Continue Previous Session")
        self.assertEqual(res["jaAction"], "前回のセッションを続ける")
        self.assertEqual(res["autoRestore"]["mode"], "auto_restored")
        self.assertEqual(res["autoRestore"]["action"], "清空备份")
        self.assertEqual(
            res["autoRestore"]["text"], "已自动恢复上次歌单，共 3 首。"
        )

    def test_previous_session_action_prevents_duplicate_click_and_restores_state(self):
        res = self.run_node_app_test(
            """
            let continueCalls = 0;
            let resolveContinue;
            global.state.backupBannerMode = "previous_session";
            global.state.translations = { zh: { "gatcha.adding": "处理中" } };
            global.continuePreviousSession = function() {
              continueCalls++;
              return new Promise(resolve => { resolveContinue = resolve; });
            };

            const button = global.elements.backupActionButton;
            button.textContent = "继续上一场";
            button.click();
            const during = {
              disabled: button.disabled,
              ariaBusy: button.attributes["aria-busy"],
              text: button.textContent,
              continueCalls,
            };
            button.click();
            const callsAfterSecondClick = continueCalls;
            resolveContinue();

            setTimeout(() => {
              process.stdout.write(JSON.stringify({
                during,
                callsAfterSecondClick,
                finalDisabled: button.disabled,
                finalAriaBusy: button.attributes["aria-busy"] || null,
                finalText: button.textContent,
              }));
            }, 10);
            """
        )
        self.assertEqual(res["during"]["continueCalls"], 1)
        self.assertEqual(res["callsAfterSecondClick"], 1)
        self.assertTrue(res["during"]["disabled"])
        self.assertEqual(res["during"]["ariaBusy"], "true")
        self.assertEqual(res["during"]["text"], "处理中")
        self.assertFalse(res["finalDisabled"])
        self.assertIsNone(res["finalAriaBusy"])
        self.assertEqual(res["finalText"], "继续上一场")


if __name__ == "__main__":
    unittest.main()
