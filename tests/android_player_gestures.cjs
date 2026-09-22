"use strict";
// Exercise the actual shared Host frame listeners, including the delayed toggle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
function section(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, start);
  const limit = source.indexOf(end, offset);
  assert.ok(limit > offset, end);
  return source.slice(offset, limit);
}

function fixture({android = true, webkit = false, pending = false} = {}) {
  const listeners = {}, timers = new Map();
  const calls = {toggle: 0, start: 0, reveal: 0, fullscreen: 0};
  const video = {tagName: "VIDEO"}, audio = {};
  const session = {video, audio, frameClickTimer: null};
  let timerId = 0;
  const context = {
    isAndroidNativePlaybackRuntime: () => android,
    state: {hostPlaybackSession: session, data: {current_item: {id: "song"}}},
    playerClickDelayMs: 220,
    elements: {playerFrame: {addEventListener: (name, handler) => { listeners[name] = handler; }}},
    setTimeout: callback => {timers.set(++timerId, callback); return timerId;},
    clearTimeout: id => timers.delete(id),
    clearPlayerFrameClickTimer() {timers.delete(session.frameClickTimer); session.frameClickTimer = null;},
    activeLocalPlayerElements: () => ({video, audio}),
    isCurrentHostPlaybackSession: candidate => candidate === session,
    isTauriWebKitRuntime: () => webkit,
    requestSplitPlaybackStartFromUserGesture() {if (pending) calls.start++; return pending;},
    toggleMountedLocalPlayback() {calls.toggle++;},
    revealMountedPlayerControlsForUserInteraction() {calls.reveal++;},
    canTogglePlayerFullscreen: () => true,
    isPlayerPanelFullscreen: () => false,
    async togglePlayerFullscreen() {calls.fullscreen++;},
    renderPlayerFullscreenButton() {},
  };
  context.window = context;
  vm.runInNewContext(
    section("function queuePlayerFrameSingleClick()", "function readLocalNumber")
      + section('elements.playerFrame?.addEventListener("click",', 'elements.nextButton.addEventListener('),
    context,
  );
  return {calls, timers, session, video,
    dispatch(type, target = "video") {
      const event = {defaultPrevented: false,
        preventDefault() {this.defaultPrevented = true;},
        target: {closest: selector => target === "control"
          ? selector === "video" ? video : {} : target === "video" && selector === "video" ? video : null},
      };
      listeners[type](event);
      return event;
    },
    flush() {const queued = [...timers.values()]; timers.clear(); queued.forEach(callback => callback());},
  };
}

function nativePause({android, seeking, playing}) {
  let handler;
  const video = {dataset: {}, paused: true, ended: false, seeking};
  const context = {
    isAndroidNativePlaybackRuntime: () => android,
    video, audio: {ended: false}, session: {seekResumePending: false},
    state: {localShouldBePlaying: playing}, document: {hidden: false},
    addMountedPlayerListener(target, name, callback) {handler = callback;},
    setSplitPlaybackIntent(video, audio, intent) {context.state.localShouldBePlaying = intent;},
    reportCurrentVideoStatus() {},
  };
  context.window = context;
  vm.runInNewContext(section('  addMountedPlayerListener(video, "pause",', '  addMountedPlayerListener(video, "seeking",'), context);
  handler();
  return context.state.localShouldBePlaying;
}

(async () => {
  for (const pending of [false, true]) {
    const f = fixture({pending});
    const tap = f.dispatch("click");
    f.flush();
    assert.equal(f.calls.toggle, 0, "Android single tap must not schedule a playback toggle while revealing/seeking");
    assert.equal(f.calls.start, 0, "Android single tap must not bypass the double-tap policy during startup");
    assert.equal(tap.defaultPrevented, false, "Native seekbar and play button keep their default actions");
    assert.equal(f.calls.reveal, 1, "Single tap still reveals native controls");
  }

  const android = fixture();
  android.dispatch("click"); android.dispatch("click");
  const double = android.dispatch("dblclick");
  android.flush();
  await Promise.resolve();
  assert.equal(android.calls.toggle, 1, "A double tap toggles exactly once, in the user gesture");
  assert.equal(android.calls.fullscreen, 0, "Android fullscreen remains on the explicit button");
  assert.equal(double.defaultPrevented, true, "Suppress the competing default double-click action");
  for (const target of ["control", "frame"]) {
    android.dispatch("click", target); android.dispatch("dblclick", target);
  }
  android.flush();
  assert.equal(android.calls.toggle, 1, "Controls and surrounding panel are not video-surface gestures");

  const desktop = fixture({android: false});
  desktop.dispatch("click"); desktop.flush();
  assert.equal(desktop.calls.toggle, 1, "Desktop single click remains unchanged");
  desktop.dispatch("click"); desktop.dispatch("click"); desktop.dispatch("dblclick");
  desktop.flush(); await Promise.resolve();
  assert.equal(desktop.calls.toggle, 1, "Desktop double click cancels the pending single click");
  assert.equal(desktop.calls.fullscreen, 1, "Desktop double click still opens fullscreen");

  const webkit = fixture({android: false, webkit: true, pending: true});
  webkit.dispatch("click"); webkit.flush();
  assert.equal(webkit.calls.start, 1, "Packaged desktop WebKit retains synchronous startup activation");
  assert.equal(webkit.calls.toggle, 0, "Packaged WebKit still defers native pause/play to its controls");
  assert.equal(nativePause({android: true, seeking: true, playing: true}), true,
    "Native Android scrub pause must preserve the play intent used by the following seeking event");
  assert.equal(nativePause({android: true, seeking: true, playing: false}), false,
    "Seeking a paused song must not resume it");
  assert.equal(nativePause({android: true, seeking: false, playing: true}), false,
    "Native play/pause button still records an explicit pause");
  assert.equal(nativePause({android: false, seeking: true, playing: true}), false,
    "Desktop native pause behavior is unchanged");
  console.log("PASS shared Host: Android double-tap playback; single tap/controls and desktop unchanged");
})().catch(error => {console.error(error); process.exitCode = 1;});
