import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, sourceIndex, iterableValues, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const AsyncActionGuardsTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.repo_root = path.resolve(path.resolve(__file__), "..", "..");
this.app_js = path.join(path.join(this.repo_root, "static"), "app.js");
this.remote_js = path.join(path.join(this.repo_root, "static"), "remote.js");
this.remote_css = path.join(path.join(this.repo_root, "static"), "remote.css");
this.export_guard_js = path.join(path.join(this.repo_root, "static"), "export-guard.js");
this.fullscreen_controls_js = path.join(path.join(this.repo_root, "static"), "fullscreen-controls.js");
this.i18n_json = path.join(path.join(this.repo_root, "static"), "i18n.json");
},
async run_node_app_test(test_script) {
let childResult, harness;
harness = concatenate(concatenate(concatenate(concatenate(concatenate(concatenate(concatenate(`
        const fs = require('fs');

        global.window = global;
        window.addEventListener = function() {};
        window.removeEventListener = function() {};
        window.requestAnimationFrame = function(cb) { return setTimeout(cb, 0); };
        window.cancelAnimationFrame = function(id) { clearTimeout(id); };

        function createMockElement(tag) {
          const listeners = {};
          const classes = new Set();
          const element = {
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
            style: {
              setProperty(name, value) { this[name] = String(value); },
              removeProperty(name) { delete this[name]; },
            },
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
          Object.defineProperty(element, "ownerDocument", { get() { return global.document; } });
          return element;
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
        global.BilikaraExportGuard = require(`, JSON.stringify(String(this.export_guard_js))), `);
        require(`), JSON.stringify(String(this.fullscreen_controls_js))), `);

        // Load app.js and bind top-level declarations to global object
        const appSource = fs.readFileSync(`), JSON.stringify(String(this.app_js))), `, 'utf-8');
        eval(appSource + "; global.state = state; global.elements = elements; global.t = t; global.closeOpenMenus = closeOpenMenus; global.renderBackupBanner = renderBackupBanner; global.dismissBackupBanner = dismissBackupBanner;");

        `), test_script);
childResult = (await checked(this.node, ["-e", harness], root));
return JSON.parse(childResult.stdout);
},
async test_confirm_ok_prevents_duplicate_click_and_restores_state() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["stateDuringRun"]["actionCalls"], 1);
assert.deepEqual(res["callsAfterSecondClick"], 1);
assert.ok(hasContent(res["stateDuringRun"]["okDisabled"]));
assert.deepEqual(res["stateDuringRun"]["okAriaBusy"], "true");
assert.ok(hasContent(res["stateDuringRun"]["secDisabled"]));
assert.ok(!hasContent(res["finalOkDisabled"]));
assert.equal(res["finalOkAriaBusy"], null);
assert.deepEqual(res["finalOkText"], "Confirm Clear");
},
async test_confirm_ok_restores_state_after_failure() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["actionCalls"], 1);
assert.ok(!hasContent(res["finalOkDisabled"]));
assert.equal(res["finalOkAriaBusy"], null);
assert.deepEqual(res["finalOkText"], "Clear");
},
async test_application_restart_is_hidden_without_tauri_and_cancel_keeps_settings_open() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.ok(hasContent(res["browser"]["hidden"]));
assert.deepEqual(res["browser"]["ariaHidden"], "true");
assert.ok(hasContent(res["browser"]["disabled"]));
assert.equal(res["browser"]["confirmIntent"], null);
assert.ok(!hasContent(res["native"]["hidden"]));
assert.deepEqual(res["native"]["ariaHidden"], "false");
assert.ok(!hasContent(res["native"]["disabled"]));
assert.deepEqual(res["native"]["confirmType"], "restart-application");
assert.ok(contains("restartApplicationConfirm", res["native"]["confirmMessage"]));
assert.equal(res["afterCancel"]["confirmIntent"], null);
assert.ok(hasContent(res["afterCancel"]["cacheSettingsOpen"]));
assert.ok(hasContent(res["afterCancel"]["cacheAdvancedOpen"]));
},
async test_application_restart_double_activation_invokes_once_and_stays_busy() {
let res, state;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["during"]["invokeCount"], 1);
assert.deepEqual(res["callsAfterRepeatedActivation"], 1);
assert.deepEqual(res["invokeCalls"], [{["command"]: "restart_application", ["payload"]: null}]);
assert.deepEqual(res["httpCalls"], 0);
for (const state of iterableValues([res["during"], res["final"]])) {
assert.ok(hasContent(state["sourceDisabled"]));
assert.deepEqual(state["sourceAriaBusy"], "true");
assert.ok(hasContent(state["confirmDisabled"]));
assert.deepEqual(state["confirmAriaBusy"], "true");
}
assert.ok(hasContent(res["final"]["inFlight"]));
},
async test_application_restart_invoke_failure_restores_controls_with_bounded_error() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["invokeCalls"], 1);
assert.ok(!hasContent(res["sourceDisabled"]));
assert.equal(res["sourceAriaBusy"], null);
assert.ok(!hasContent(res["confirmDisabled"]));
assert.equal(res["confirmAriaBusy"], null);
assert.ok(!hasContent(res["inFlight"]));
assert.deepEqual(res["message"], "无法重启桌面应用。");
assert.ok(!contains("sensitive", res["message"]));
},
async test_gatcha_confirm_button_prevents_duplicate_and_restores() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["stateDuringRun"]["submitCalls"], 1);
assert.deepEqual(res["callsAfterSecondClick"], 1);
assert.ok(hasContent(res["stateDuringRun"]["disabled"]));
assert.deepEqual(res["stateDuringRun"]["ariaBusy"], "true");
assert.equal(res["candidate"], null);
assert.ok(!hasContent(res["finalDisabled"]));
assert.equal(res["finalAriaBusy"], null);
assert.deepEqual(res["finalText"], "确定点歌");
},
async test_gatcha_draw_is_single_flight_and_exposes_busy_state() {
let res;
res = (await this.run_node_app_test(`
            let fetchCalls = 0;
            let resolveFetch;
            global.fetch = function() {
              fetchCalls += 1;
              return new Promise(resolve => { resolveFetch = resolve; });
            };
            global.state.data = { bbdown: { login: { logged_in: true } } };

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
            `));
assert.deepEqual(res["during"]["fetchCalls"], 1);
assert.deepEqual(res["callsAfterRepeat"], 1);
assert.ok(hasContent(res["during"]["disabled"]));
assert.deepEqual(res["during"]["ariaBusy"], "true");
assert.deepEqual(res["during"]["text"], "gatcha.drawing");
assert.deepEqual(res["candidate"]["title"], "Drawn Song");
assert.ok(!hasContent(res["drawBusy"]));
assert.ok(!hasContent(res["finalDisabled"]));
assert.equal(res["finalAriaBusy"], null);
},
async test_stale_gatcha_add_retains_candidate() {
let res;
res = (await this.run_node_app_test(`
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
                toast: global.elements.appToast.textContent,
              }));
            }, 10);
            `));
assert.deepEqual(res["candidate"]["title"], "Retained Song");
assert.deepEqual(res["message"], "");
assert.deepEqual(res["toast"], "error.requestFailed");
},
async test_gatcha_duplicate_confirmation_keeps_exact_source_and_requester() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["candidate"]["title"], "Duplicate Song");
assert.deepEqual(res["intent"]["type"], "duplicate-add");
assert.deepEqual(res["intent"]["source"], "gatcha");
assert.deepEqual(res["intent"]["requesterName"], "Exact User");
},
async test_remote_gatcha_confirm_button_prevents_duplicate_and_restores() {
let completed, end, function_source, result, script, source, start;
source = readFileSync(this.remote_js, "utf8");
start = sourceIndex(source, "async function confirmGatchaCandidate");
end = sourceIndex(source, "async function sendPlayerControl", start);
function_source = source.slice(start, end);
script = (`
const state = {
  submitting: false,
  gatchaCandidate: { url: "https://bilibili.com/video/BV1xx" },
};
const button = {
  disabled: false,
  textContent: "确定点歌",
  attributes: {},
  setAttribute(key, value) { this.attributes[key] = String(value); },
  removeAttribute(key) { delete this.attributes[key]; },
};
const elements = { gatchaConfirmButton: button };
function t() { return "添加中..."; }
let addCalls = 0;
let resolveAdd;
function addByUrl() {
  addCalls += 1;
  return new Promise((resolve) => { resolveAdd = resolve; });
}
` + String(function_source) + `
const first = confirmGatchaCandidate();
const during = {
  disabled: button.disabled,
  ariaBusy: button.attributes["aria-busy"],
  text: button.textContent,
};
const second = confirmGatchaCandidate();
resolveAdd();
Promise.all([first, second]).then((results) => {
  process.stdout.write(JSON.stringify({
    addCalls,
    during,
    results,
    finalDisabled: button.disabled,
    finalAriaBusy: button.attributes["aria-busy"] || null,
    finalText: button.textContent,
  }));
});
`);
completed = (await checked(this.node, ["-e", script], root));
result = JSON.parse(completed.stdout);
assert.deepEqual(result["addCalls"], 1);
assert.ok(hasContent(result["during"]["disabled"]));
assert.deepEqual(result["during"]["ariaBusy"], "true");
assert.deepEqual(result["during"]["text"], "添加中...");
assert.deepEqual(result["results"], [true, false]);
assert.ok(!hasContent(result["finalDisabled"]));
assert.equal(result["finalAriaBusy"], null);
assert.deepEqual(result["finalText"], "确定点歌");
assert.ok(contains(".primary-button:disabled", readFileSync(this.remote_css, "utf8")));
},
async test_history_readd_button_prevents_duplicate_and_restores() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["stateDuringRun"]["handleAddCalls"], 1);
assert.deepEqual(res["callsAfterSecondClick"], 1);
assert.ok(hasContent(res["stateDuringRun"]["disabled"]));
assert.deepEqual(res["stateDuringRun"]["ariaBusy"], "true");
assert.ok(!hasContent(res["finalDisabled"]));
assert.equal(res["finalAriaBusy"], null);
assert.deepEqual(res["finalText"], "加到末尾");
},
async test_resort_playlist_button_prevents_duplicate_and_restores() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["stateDuringRun"]["resortCalls"], 1);
assert.deepEqual(res["callsAfterSecondClick"], 1);
assert.ok(hasContent(res["stateDuringRun"]["disabled"]));
assert.deepEqual(res["stateDuringRun"]["ariaBusy"], "true");
assert.ok(!hasContent(res["finalDisabled"]));
assert.equal(res["finalAriaBusy"], null);
assert.deepEqual(res["finalText"], "重新排序");
},
async test_previous_session_banner_uses_countdown_and_localized_continue_action() {
let res;
res = (await this.run_node_app_test(concatenate(concatenate(`
            global.state.translations = JSON.parse(fs.readFileSync(`, JSON.stringify(String(this.i18n_json))), `, "utf-8")).languages;
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
            `)));
assert.deepEqual(res["zh"]["mode"], "previous_session");
assert.deepEqual(res["zh"]["title"], "上一场");
assert.deepEqual(res["zh"]["text"], "检测到上一场记录，共 2 首。");
assert.deepEqual(res["zh"]["action"], "继续上一场");
assert.deepEqual(res["zh"]["countdown"], "5");
assert.ok(hasContent(res["zh"]["visible"]));
assert.ok(hasContent(res["zh"]["timerActive"]));
assert.deepEqual(res["enAction"], "Continue Previous Session");
assert.deepEqual(res["jaAction"], "前回のセッションを続ける");
assert.deepEqual(res["autoRestore"]["mode"], "auto_restored");
assert.deepEqual(res["autoRestore"]["action"], "清空备份");
assert.deepEqual(res["autoRestore"]["text"], "已自动恢复上次歌单，共 3 首。");
},
async test_previous_session_action_prevents_duplicate_click_and_restores_state() {
let res;
res = (await this.run_node_app_test(`
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
            `));
assert.deepEqual(res["during"]["continueCalls"], 1);
assert.deepEqual(res["callsAfterSecondClick"], 1);
assert.ok(hasContent(res["during"]["disabled"]));
assert.deepEqual(res["during"]["ariaBusy"], "true");
assert.deepEqual(res["during"]["text"], "处理中");
assert.ok(!hasContent(res["finalDisabled"]));
assert.equal(res["finalAriaBusy"], null);
assert.deepEqual(res["finalText"], "继续上一场");
}
};
test("AsyncActionGuardsTest.test_confirm_ok_prevents_duplicate_click_and_restores_state", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_confirm_ok_prevents_duplicate_click_and_restores_state(); });
test("AsyncActionGuardsTest.test_confirm_ok_restores_state_after_failure", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_confirm_ok_restores_state_after_failure(); });
test("AsyncActionGuardsTest.test_application_restart_is_hidden_without_tauri_and_cancel_keeps_settings_open", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_application_restart_is_hidden_without_tauri_and_cancel_keeps_settings_open(); });
test("AsyncActionGuardsTest.test_application_restart_double_activation_invokes_once_and_stays_busy", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_application_restart_double_activation_invokes_once_and_stays_busy(); });
test("AsyncActionGuardsTest.test_application_restart_invoke_failure_restores_controls_with_bounded_error", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_application_restart_invoke_failure_restores_controls_with_bounded_error(); });
test("AsyncActionGuardsTest.test_gatcha_confirm_button_prevents_duplicate_and_restores", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_gatcha_confirm_button_prevents_duplicate_and_restores(); });
test("AsyncActionGuardsTest.test_gatcha_draw_is_single_flight_and_exposes_busy_state", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_gatcha_draw_is_single_flight_and_exposes_busy_state(); });
test("AsyncActionGuardsTest.test_stale_gatcha_add_retains_candidate", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_stale_gatcha_add_retains_candidate(); });
test("AsyncActionGuardsTest.test_gatcha_duplicate_confirmation_keeps_exact_source_and_requester", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_gatcha_duplicate_confirmation_keeps_exact_source_and_requester(); });
test("AsyncActionGuardsTest.test_remote_gatcha_confirm_button_prevents_duplicate_and_restores", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_remote_gatcha_confirm_button_prevents_duplicate_and_restores(); });
test("AsyncActionGuardsTest.test_history_readd_button_prevents_duplicate_and_restores", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_history_readd_button_prevents_duplicate_and_restores(); });
test("AsyncActionGuardsTest.test_resort_playlist_button_prevents_duplicate_and_restores", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_resort_playlist_button_prevents_duplicate_and_restores(); });
test("AsyncActionGuardsTest.test_previous_session_banner_uses_countdown_and_localized_continue_action", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_previous_session_banner_uses_countdown_and_localized_continue_action(); });
test("AsyncActionGuardsTest.test_previous_session_action_prevents_duplicate_click_and_restores_state", async () => { const instance = Object.create(AsyncActionGuardsTest); await instance.setUpClass(); await instance.test_previous_session_action_prevents_duplicate_click_and_restores_state(); });
