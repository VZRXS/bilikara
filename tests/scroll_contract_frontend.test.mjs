import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const load = file => readFileSync(new URL('../static/' + file, import.meta.url), 'utf8');

function pagerLayoutHarness() {
  const frames = [], observers = [], observed = new Set(), classes = new Set(), properties = new Map();
  let classChanges = 0;
  const state = {overflowY: 'auto', visible: true, contentHeight: 108, insetHeightReduction: 0};
  const viewport = {clientWidth: 365, clientHeight: 100, scrollTop: 0,
    get scrollHeight() {
      const padding = properties.has('padding-right') ? parseFloat(properties.get('padding-right').value)
        : classes.has('has-scroll-inset') ? 4 : 0;
      const height = Math.max(this.clientHeight, state.contentHeight - (padding ? state.insetHeightReduction : 0));
      this.scrollTop = Math.min(this.scrollTop, height - this.clientHeight);
      return height;
    },
    style: {
      getPropertyValue: name => properties.get(name)?.value || '',
      getPropertyPriority: name => properties.get(name)?.priority || '',
      setProperty(name, value, priority = '') { properties.set(name, {value, priority}); },
      removeProperty(name) { properties.delete(name); },
    },
    classList: {
      contains: name => classes.has(name),
      toggle(name, enabled) {
        if (classes.has(name) !== enabled) classChanges++;
        enabled ? classes.add(name) : classes.delete(name);
      },
    }};
  const pager = {getClientRects: () => state.visible ? [{}] : []}, container = {};
  const context = vm.createContext({viewport, pager, container, document: {},
    getComputedStyle: () => ({overflowY: state.overflowY}),
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { observed.add(element); }
    }});
  const source = load('result-pagination.js');
  const start = source.indexOf('    function scheduleLayout()');
  const end = source.indexOf('    function animate(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext('let layoutFrame = null, viewportWidth = 0, fit = null, rows = 0;\n'
    + source.slice(start, end), context);
  function measure() {
    observers[0].callback(); observers[0].callback();
    assert.equal(frames.length, 1, 'size/content changes share one animation frame');
    frames.shift()();
  }
  return {state, viewport, classes, observers, observed, pager, container, frames, measure,
    get classChanges() { return classChanges; }};
}

test('portrait My/Settings own full-width scrolling and internal content gutters [B3-G2]', () => {
  const css = load('host-layout.css');
  assert.match(css, /html\[data-host-layout="portrait"\]\[data-host-page="my"\] \.shell-body\s*\{\s*padding-inline: 0;\s*\}/);
  for (const owner of ['android-my-scroll', 'settings-workspace-body']) {
    assert.match(css, new RegExp('html\\[data-host-layout="portrait"\\] \\.' + owner
      + '\\s*\\{\\s*padding: 0 14px calc\\(var\\(--mobile-content-trailing-inset\\) \\+ 14px\\);\\s*\\}'));
  }
  // G2 moves only the side gutters; the existing dock/trailing relationship
  // remains part of the contract until D1 is decided.
  assert.match(css, /:is\(\.android-my-scroll, \.settings-workspace-body\)\s*\{\s*scroll-padding-bottom: calc\(var\(--mobile-content-trailing-inset\) \+ 14px\);/);
});

test('result viewport inset follows actual bounded overflow through the existing observer [B3-G3]', () => {
  const {state, viewport, classes, observers, observed, pager, container, measure} = pagerLayoutHarness();
  assert.equal(observers.length, 1, 'reuse the pager observer');
  for (const element of [viewport, container, pager]) assert.ok(observed.has(element));
  measure(); assert.ok(classes.has('has-scroll-inset'));
  state.contentHeight = 101;
  measure(); assert.ok(!classes.has('has-scroll-inset'), 'rounding alone does not reserve space');
  state.contentHeight = 100;
  measure(); assert.ok(!classes.has('has-scroll-inset'));
  state.contentHeight = 108;
  for (state.overflowY of ['visible', 'hidden', 'clip']) {
    measure(); assert.ok(!classes.has('has-scroll-inset'), state.overflowY);
  }
  state.overflowY = 'scroll';
  measure(); assert.ok(classes.has('has-scroll-inset'));
  state.visible = false; viewport.clientHeight = 200;
  measure();
  state.visible = true;
  measure(); assert.ok(!classes.has('has-scroll-inset'), 'remeasure when the page becomes visible');
});

test('aspect-ratio card reflow cannot feed back into the inset overflow decision [B3-G3]', () => {
  const harness = pagerLayoutHarness();
  const {state, viewport, classes, measure} = harness;
  // WSL 393x847 capture: removing 4px of grid width shortens three rows
  // of 16:9 song covers, reducing overflow from 5px to 1px.
  state.contentHeight = 105; state.insetHeightReduction = 4;
  measure(); assert.ok(classes.has('has-scroll-inset'));
  assert.equal(viewport.scrollHeight - viewport.clientHeight, 1);
  measure(); assert.ok(classes.has('has-scroll-inset'), 'the observer must use the uninset 5px overflow');
  assert.equal(harness.classChanges, 1, 'no intermediate class removal during measurement');
  assert.equal(viewport.style.getPropertyValue('padding-right'), '', 'restore stylesheet ownership');
  assert.equal(harness.frames.length, 0, 'measurement schedules no polling');

  // Both resize directions and new content use the same uninset baseline.
  for (const heights of [[95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107],
    [107, 106, 105, 104, 103, 102, 101, 100, 99, 98, 97, 96, 95]]) {
    for (viewport.clientHeight of heights) {
      measure();
      assert.equal(classes.has('has-scroll-inset'), state.contentHeight > viewport.clientHeight + 1);
      const changes = harness.classChanges;
      measure();
      assert.equal(harness.classChanges, changes, 'a resulting resize cannot change the decision');
    }
  }
  state.contentHeight = 50;
  measure(); assert.ok(!classes.has('has-scroll-inset'), 'a shorter page releases the inset');
});

test('uninset measurement restores inline padding priority and scroll position [B3-G3]', () => {
  const {state, viewport, measure} = pagerLayoutHarness();
  state.contentHeight = 105;
  measure();
  // Text wrapping may make the inset page taller instead of shorter. A
  // temporary wider layout can clamp scrollTop before padding is restored.
  state.insetHeightReduction = -20;
  viewport.style.setProperty('padding-right', '4px', 'important');
  viewport.scrollTop = 20;
  measure();
  assert.equal(viewport.style.getPropertyValue('padding-right'), '4px');
  assert.equal(viewport.style.getPropertyPriority('padding-right'), 'important');
  assert.equal(viewport.scrollTop, 20);
});

test('result viewport CSS reserves a right gap only with the overflow class [B3-G3]', () => {
  const css = load('styles.css');
  assert.match(css, /:root :is\([^{}]*\.result-page-viewport\)\s*\{ padding-right: 0; \}/);
  assert.match(css, /:root :is\([^{}]*\.result-page-viewport\)\.has-scroll-inset\s*\{ padding-right: 4px; \}/);
});

test('announcement content leaves scrollbar reservation to actual native overflow [B3-G6]', () => {
  for (const file of ['announcements.css', 'compat83/announcements.css']) {
    const css = load(file);
    const content = css.match(/#announcements-content\s*\{([^}]+)\}/)?.[1];
    assert.ok(content, file);
    assert.match(content, /overflow-y:\s*auto/);
    assert.match(content, /scrollbar-gutter:\s*auto/);
    assert.doesNotMatch(css, /scrollbar-gutter:\s*stable/);
  }
});
