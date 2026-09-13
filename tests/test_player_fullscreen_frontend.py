import json
import shutil
import subprocess
import unittest
from pathlib import Path


SOURCE = (Path(__file__).resolve().parents[1] / "static/app.js").read_text(encoding="utf-8")


class PlayerFullscreenFrontendTest(unittest.TestCase):
    def test_native_and_browser_fullscreen_have_one_owner(self):
        if not shutil.which("node"):
            self.skipTest("node unavailable")

        def section(start, end):
            return SOURCE[SOURCE.index(start):SOURCE.index(end, SOURCE.index(start))]

        functions = "\n".join([
            section("function fullscreenElement()", "function isWebKitPlaybackRuntime()"),
            section("function isPlayerPanelFullscreen()", "function tauriInvoke()"),
            section("async function setTauriWindowFullscreen", "function presentationSceneApi()"),
            section("function requestElementFullscreen", "function clearPlayerFrameClickTimer"),
            section("function handleFullscreenChange()", 'document.addEventListener("fullscreenchange"'),
        ])
        script = r'''
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
'''+functions+r'''
(async () => {
  // Native windows do not need or invoke DOM fullscreen on any desktop engine.
  delete panel.requestFullscreen;
  assert.equal(supportsPlayerFullscreen(), true);
  delayNative = true;
  const entering = togglePlayerFullscreen();
  assert.equal(state.playerFullscreenTransitioning, true);
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
'''
        result = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])

    def test_native_exit_is_observed_and_escape_respects_existing_modals(self):
        self.assertIn("void syncNativePlayerFullscreen(appWindow);", SOURCE)
        end = SOURCE.index("function handleFullscreenChange")
        start = SOURCE.rindex('document.addEventListener("keydown", (event) => {', 0, end)
        handler = SOURCE[start:end]
        self.assertLess(handler.index("closeOrdinaryPopoverForEscape()"),
                        handler.index("handleNativePlayerFullscreenEscape(event)"))
