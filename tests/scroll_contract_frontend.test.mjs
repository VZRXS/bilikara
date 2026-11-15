import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const load = file => readFileSync(new URL('../static/' + file, import.meta.url), 'utf8');

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
  const source = load('result-pagination.js');
  const frames = [], observers = [], observed = new Set(), classes = new Set();
  let overflowY = 'auto', visible = true;
  const viewport = {clientWidth: 365, clientHeight: 100, scrollHeight: 108,
    style: {}, classList: {toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }}};
  const pager = {getClientRects: () => visible ? [{}] : []}, container = {};
  const context = vm.createContext({viewport, pager, container, document: {},
    getComputedStyle: () => ({overflowY}),
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { observed.add(element); }
    }});
  const start = source.indexOf('    function scheduleLayout()');
  const end = source.indexOf('    function animate(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext('let layoutFrame = null, viewportWidth = 0, fit = null, rows = 0;\n'
    + source.slice(start, end), context);
  assert.equal(observers.length, 1, 'reuse the pager observer');
  for (const element of [viewport, container, pager]) assert.ok(observed.has(element));
  function measure() {
    observers[0].callback(); observers[0].callback();
    assert.equal(frames.length, 1, 'size/content changes share one animation frame');
    frames.shift()();
  }
  measure(); assert.ok(classes.has('has-scroll-inset'));
  viewport.scrollHeight = 101;
  measure(); assert.ok(!classes.has('has-scroll-inset'), 'rounding alone does not reserve space');
  viewport.scrollHeight = 100;
  measure(); assert.ok(!classes.has('has-scroll-inset'));
  viewport.scrollHeight = 108;
  for (overflowY of ['visible', 'hidden', 'clip']) {
    measure(); assert.ok(!classes.has('has-scroll-inset'), overflowY);
  }
  overflowY = 'scroll';
  measure(); assert.ok(classes.has('has-scroll-inset'));
  visible = false; viewport.clientHeight = 200;
  measure();
  visible = true;
  measure(); assert.ok(!classes.has('has-scroll-inset'), 'remeasure when the page becomes visible');
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
