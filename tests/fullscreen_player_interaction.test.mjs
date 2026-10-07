import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../static/fullscreen-controls.js', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
function fixture(mode = 'native') {
  const classes = () => {
    const set = new Set();
    return { add: key => set.add(key), remove: key => set.delete(key), contains: key => set.has(key) };
  };
  class Target {
    constructor() { this.listeners = new Map(); this.classList = classes(); }
    addEventListener(type, fn) { const listeners = this.listeners.get(type) || []; listeners.push(fn); this.listeners.set(type, listeners); }
    dispatch(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
  }
  const document = new Target(), window = new Target(), panel = new Target(), video = new Target();
  document.body = new Target(); document.hidden = false;
  panel.ownerDocument = document; panel.contains = target => target === video || target === panel;
  video.setAttribute = key => { if (key === 'controls') video.controls = true; };
  video.removeAttribute = key => { if (key === 'controls') video.controls = false; };
  video.matches = selector => selector === 'video'; video.controls = false;
  let now = 0, next = 0; const timers = new Map();
  window.setTimeout = (callback, ms) => { const id = ++next; timers.set(id, { callback, time: now + ms }); return id; };
  window.clearTimeout = id => timers.delete(id);
  const state = { localPlaybackStartState: 'established', localPlayerControlsHideTimer: null, playerFullscreenTransitioning: false };
  let dual = false;
  const sandbox = vm.createContext({ document, window, state, elements: { playerPanel: panel }, playerControlsAutoHideMs: 5000,
    fullscreenElement: () => document.fullscreenElement,
    presentationCompositionActive: () => dual, isAndroidNativePlaybackRuntime: () => false,
    mountedLocalVideoElement: () => video, activeLocalPlayerElements: () => ({ video, audio: {} }),
    isCurrentHostPlaybackSession: () => true, addMountedPlayerListener: (target, type, callback) => target.addEventListener(type, callback),
    fullscreenControlHover: { reset() {} }, setPlayerFullscreenRemotePinned() {}, hideFullscreenRequestToast() {},
    hasLocalAdvanceDelayOverlay: () => false, hidePlayerDelayOverlay() {}, renderPlayerFullscreenButton() {},
  });
  vm.runInContext(helper, sandbox);
  vm.runInContext(section('function isPlayerPanelFullscreen()', 'function isAudiencePlayerSurface()'), sandbox);
  // Keep the real controls policy and the actual mounted-media event handlers.
  vm.runInContext(section('function hidePlayerControls(', 'function toggleMountedLocalPlayback()'), sandbox);
  vm.runInContext(section('function clearLocalPlayerControlsHideTimer()', 'function mountedLocalVideoElement()'), sandbox);
  vm.runInContext(section('function handleFullscreenChange()', 'document.addEventListener("fullscreenchange",'), sandbox);
  sandbox.video = video;
  vm.runInContext(section('  ["pointerenter", "pointermove", "pointerdown", "touchstart", "focus"].forEach', '  addMountedPlayerListener(video, "ended",'), sandbox);
  state.playerFullscreenInteraction = window.BilikaraFullscreenControls.bindPlayer?.(panel, {
    active: () => sandbox.isPlayerPanelFullscreen() && !dual,
    transitioning: () => state.playerFullscreenTransitioning,
    revealControls: sandbox.revealMountedPlayerControlsForUserInteraction,
  });
  function fire(type, extra = {}) {
    const event = { type, target: video, pointerType: 'mouse', pointerId: 1, screenX: 50, screenY: 50, movementX: 0, movementY: 0, ...extra };
    document.dispatch(event); video.dispatch(event); return event;
  }
  function enter() {
    if (mode === 'native') panel.classList.add('is-tauri-fullscreen');
    else document.fullscreenElement = panel;
    sandbox.handleFullscreenChange();
  }
  function exit() {
    panel.classList.remove('is-tauri-fullscreen'); document.fullscreenElement = null;
    sandbox.handleFullscreenChange();
  }
  function tick(ms) {
    const until = now + ms;
    while (true) {
      const nextTimer = [...timers.entries()].filter(([, timer]) => timer.time <= until).sort((a, b) => a[1].time - b[1].time)[0];
      if (!nextTimer) break;
      const [id, timer] = nextTimer; timers.delete(id); now = timer.time; timer.callback();
    }
    now = until;
  }
  return { document, window, panel, video, state, sandbox, timers, fire, enter, exit, tick, dual: value => { dual = value; } };
}

for (const mode of ['native', 'browser']) test(`${mode} fullscreen starts quiet but real input restores controls`, () => {
  const f = fixture(mode);
  f.fire('pointermove'); assert.equal(f.video.controls, true, 'ordinary window remains interactive');
  f.enter(); assert.equal(f.video.controls, false, 'entry never shows controls');
  f.fire('pointerenter'); f.fire('focus'); f.fire('pointermove');
  assert.equal(f.video.controls, false, 'entry focus/retargeted stationary movement must stay quiet');
  f.fire('pointermove', { screenX: 70, movementX: 20 });
  assert.equal(f.video.controls, true, 'a real move must reveal the fullscreen seekbar');
  f.tick(5001); assert.equal(f.video.controls, false, 'ordinary auto-hide remains');
  f.fire('pointerdown', { screenX: 70 }); assert.equal(f.video.controls, true);
  f.fire('focus'); f.fire('pointerenter'); f.fire('pointerleave');
  assert.equal(f.video.controls, true, 'focus and UA-control retargeting must not undo the pointerdown');
  f.tick(6000); assert.equal(f.video.controls, true, 'do not remove native controls while scrubbing');
  f.fire('pointerup', { screenX: 70 }); f.tick(5001); assert.equal(f.video.controls, false);
  f.exit(); f.fire('pointerenter'); assert.equal(f.video.controls, true);
});

test('single-screen cursor idles, wakes, and cannot leak into an exited or replaced fullscreen', () => {
  const f = fixture(); f.fire('pointermove'); f.enter();
  f.tick(1801); assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), true);
  f.fire('pointermove', { screenX: 80, movementX: 30 });
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
  f.fire('pointerdown', { screenX: 80 }); f.tick(6000);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false, 'held pointers stay visible');
  f.fire('pointerup', { screenX: 80 }); f.tick(1801);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), true);
  f.exit(); assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
  f.tick(10000); assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
  f.enter(); f.window.dispatch({ type: 'blur' }); f.tick(2000);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
  f.window.dispatch({ type: 'focus' }); f.tick(1801);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), true);
});

test('touch/keyboard intent works while automatic focus, transitions and dual screen stay protected', () => {
  const f = fixture(); f.enter();
  f.fire('focus'); assert.equal(f.video.controls, false);
  f.fire('keydown', { key: 'Tab' }); f.fire('focus'); assert.equal(f.video.controls, true);
  f.sandbox.hideMountedPlayerControls(); f.fire('touchstart', { pointerType: 'touch' });
  f.fire('pointerup', { pointerType: 'touch' }); f.fire('pointerleave', { pointerType: 'touch' });
  assert.equal(f.video.controls, true);
  f.state.playerFullscreenTransitioning = true;
  f.fire('pointerdown'); assert.equal(f.video.controls, false);
  f.state.playerFullscreenTransitioning = false; f.dual(true);
  f.fire('pointerdown'); assert.equal(f.video.controls, false, 'audience/control-host composition remains untouched');
  f.state.playerFullscreenInteraction?.sync(); f.tick(2000);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
});

test('native seekbar movement protects scrubbing even when the UA consumes pointerdown', () => {
  const f = fixture(); f.fire('pointermove'); f.enter();
  f.fire('pointermove', { screenX: 80, movementX: 30, buttons: 1 });
  f.tick(6000);
  assert.equal(f.video.controls, true);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), false);
  f.fire('lostpointercapture', { buttons: 0 });
  f.tick(1801);
  assert.equal(f.panel.classList.contains('is-player-cursor-hidden'), true);
  f.tick(4000); assert.equal(f.video.controls, false);
});
