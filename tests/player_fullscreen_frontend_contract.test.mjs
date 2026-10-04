import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, sourceIndex, lastSourceIndex, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const SOURCE = readFileSync(path.join(path.resolve(path.resolve(__file__), "..", ".."), "static/app.js"), "utf8");
const PlayerFullscreenFrontendTest = {
async test_native_and_browser_fullscreen_have_one_owner() {
let functions, result, script;
if ((!process.execPath)) {
(() => { throw new Error("node unavailable"); })();
}
function section(start, end) {
return SOURCE.slice(sourceIndex(SOURCE, start), sourceIndex(SOURCE, end, sourceIndex(SOURCE, start)));
}
functions = [section("function fullscreenElement()", "function isWebKitPlaybackRuntime()"), section("function isPlayerPanelFullscreen()", "function tauriInvoke("), section("async function setTauriWindowFullscreen", "function presentationSceneApi()"), section("function requestElementFullscreen", "function clearPlayerFrameClickTimer"), section("function handleFullscreenChange()", "document.addEventListener(\"fullscreenchange\"")].join(`
`);
script = concatenate(concatenate(`
const assert = require('node:assert/strict');
const classes = () => {
  const values = new Set();
  return {contains: k => values.has(k), add: k => values.add(k), remove: k => values.delete(k),
    toggle: (k, on) => on ? values.add(k) : values.delete(k)};
};
const document = {fullscreenElement: null, body: {classList: classes()}};
const panel = {classList: classes()};
const elements = {playerPanel: panel};
const state = {data: {current_item: {id: 'same-song'}}, presentationSession: {phase: 'inactive'},
  playerFullscreenTransitioning: false, playerFullscreenRevision: 0};
let native = true, nativeFailure = false, resolveNative, delayNative = false;
let calls = [], domCalls = [], messages = [], renders = 0;
let hoverResets = 0, controlsHides = 0;
const fullscreenControlHover = {reset() {hoverResets++;}};
function hideMountedPlayerControls() {controlsHides++;}
function tauriInvoke() {
  return native ? async (command, args) => {
    calls.push([command, args.fullscreen]);
    if (nativeFailure) throw Error('native failure');
    if (delayNative) await new Promise(resolve => {resolveNative = resolve;});
  } : null;
}
panel.requestFullscreen = async () => { domCalls.push('enter'); document.fullscreenElement = panel; };
document.exitFullscreen = async () => { domCalls.push('exit'); document.fullscreenElement = null; };
function presentationCompositionActive() {return state.presentationSession.phase !== 'inactive';}
function renderPlayerFullscreenButton() {renders++;}
function setPlayerFullscreenRemotePinned() {}
function hideFullscreenRequestToast() {}
function hasLocalAdvanceDelayOverlay() {return false;}
function updateLocalAdvanceDelayOverlay() {}
function hidePlayerDelayOverlay() {}
function t(key) {return key;}
function setAppMessage(text) {messages.push(text);}
`, functions), `
(async () => {
  // Native windows do not need or invoke DOM fullscreen on any desktop engine.
  delete panel.requestFullscreen;
  assert.equal(supportsPlayerFullscreen(), true);
  delayNative = true;
  const entering = togglePlayerFullscreen();
  assert.equal(document.body.classList.contains('is-tauri-fullscreen-active'), true,
    'hide windowed toolbar/rail before awaiting native monitor expansion');
  assert.equal(state.playerFullscreenTransitioning, true);
  assert.equal(hoverResets, 1);
  assert.equal(controlsHides, 1);
  assert.equal(isPlayerPanelFullscreen(), false);
  await togglePlayerFullscreen(); // duplicate activation is ignored
  assert.deepEqual(calls, [['set_window_fullscreen', true]]);
  resolveNative(); await entering; delayNative = false;
  assert.equal(isPlayerPanelFullscreen(), true);
  assert.equal(document.body.classList.contains('is-tauri-fullscreen-active'), true);
  assert.deepEqual(domCalls, []);
  handleFullscreenChange(); // stale WebView event cannot change native state
  assert.equal(calls.length, 1);

  nativeFailure = true;
  await togglePlayerFullscreen();
  assert.equal(isPlayerPanelFullscreen(), true); // failed exit preserves UI
  assert.equal(state.playerFullscreenTransitioning, false);
  nativeFailure = false;
  let prevented = false;
  handleNativePlayerFullscreenEscape({key:'Escape', preventDefault(){prevented=true;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(isPlayerPanelFullscreen(), false);
  nativeFailure = true;
  await togglePlayerFullscreen();
  assert.equal(isPlayerPanelFullscreen(), false); // never fake native success
  assert.equal(messages.length, 2);
  nativeFailure = false;

  await togglePlayerFullscreen();
  let resolveRead;
  const oldRead = syncNativePlayerFullscreen({isFullscreen: () => new Promise(resolve => {resolveRead=resolve;})});
  await togglePlayerFullscreen(); await togglePlayerFullscreen();
  resolveRead(false); await oldRead;
  assert.equal(isPlayerPanelFullscreen(), true); // old native reads are rejected
  await syncNativePlayerFullscreen({isFullscreen: async () => {throw Error('read unavailable');}});
  assert.equal(isPlayerPanelFullscreen(), true);
  await syncNativePlayerFullscreen({isFullscreen: async () => false});
  assert.equal(isPlayerPanelFullscreen(), false); // OS exit reconciles CSS
  state.presentationSession.phase = 'active';
  const before = calls.length;
  await togglePlayerFullscreen();
  assert.equal(calls.length, before); // dual-screen remains authoritative
  state.presentationSession.phase = 'inactive';

  native = false;
  panel.requestFullscreen = async () => {domCalls.push('enter'); document.fullscreenElement=panel;};
  await togglePlayerFullscreen();
  assert.equal(document.fullscreenElement, panel);
  await togglePlayerFullscreen();
  assert.equal(document.fullscreenElement, null);
  assert.deepEqual(domCalls, ['enter','exit']);
  assert.equal(calls.length, before);
  assert.equal(state.data.current_item.id, 'same-song');
  console.log(JSON.stringify({passed:true, nativeCalls:calls.length, domCalls, messages}));
})().catch(error => {console.error(error);process.exitCode=1;});
`);
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(result.status, 0, result.stderr);
assert.ok(hasContent(JSON.parse(result.stdout)["passed"]));
},
async test_native_exit_is_observed_and_escape_respects_existing_modals() {
let end, handler, start;
assert.ok(contains("void syncNativePlayerFullscreen(appWindow);", SOURCE));
end = sourceIndex(SOURCE, "function handleFullscreenChange");
start = lastSourceIndex(SOURCE, "document.addEventListener(\"keydown\", (event) => {", 0, end);
handler = SOURCE.slice(start, end);
assert.ok(sourceIndex(handler, "closeOrdinaryPopoverForEscape()") < sourceIndex(handler, "handleNativePlayerFullscreenEscape(event)"));
}
};
test("PlayerFullscreenFrontendTest.test_native_and_browser_fullscreen_have_one_owner", async () => { const instance = Object.create(PlayerFullscreenFrontendTest); await instance.test_native_and_browser_fullscreen_have_one_owner(); });
test("PlayerFullscreenFrontendTest.test_native_exit_is_observed_and_escape_respects_existing_modals", async () => { const instance = Object.create(PlayerFullscreenFrontendTest); await instance.test_native_exit_is_observed_and_escape_respects_existing_modals(); });
