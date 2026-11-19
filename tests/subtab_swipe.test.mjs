import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const {flatten,neighbor,descendant,intent,completed}=createRequire(import.meta.url)('../static/subtab-swipe.js');

test('recursive sub-tab leaves stay in their own scope at arbitrary depth',()=>{
  const tree=[{id:'request',children:[{id:'quick'},{id:'search',children:[{id:'shared'},{id:'local'}]},
    {id:'deep',children:[{id:'nested',children:[{id:'leaf'}]},{id:'disabled',disabled:true}]},
    {id:'hidden',hidden:true,children:[{id:'leaf'}]},{id:'random'}]}];
  assert.deepEqual(flatten(tree).map(n=>n.key),['request.quick','request.search.shared','request.search.local','request.deep.nested.leaf','request.random']);
  assert.equal(neighbor(tree,'request.search.local',1).key,'request.deep.nested.leaf');
  assert.equal(neighbor(tree,'request.deep.nested.leaf',-1).key,'request.search.local');
  assert.equal(neighbor(tree,'request.random',1),null);
  assert.equal(neighbor(tree,'request.quick',-1),null);
  assert.equal(neighbor(tree,'queue.history',1),null);
  assert.equal(descendant(tree,'request.search','request.search.local').key,'request.search.local','Direct parent taps may remember a child');
  assert.equal(neighbor(tree,'request.quick',1).key,'request.search.shared','Swipes cannot skip to a remembered nonadjacent child');
  tree[0].children[1].children[0].disabled=true;
  assert.equal(neighbor(tree,'request.quick',1).key,'request.search.local');
  assert.equal(descendant(tree,'request.search','request.search.shared').key,'request.search.local');
  assert.deepEqual(flatten([{id:'empty',children:[]}]),[]);
  assert.equal(neighbor([{id:'only'}],'only',1),null);
});
test('axis ownership and calibrated distance/flick decisions reject vertical and undecided motion',()=>{
  assert.equal(intent(13,6),'x');assert.equal(intent(12,10),'');assert.equal(intent(8,12),'y');
  assert.equal(intent(80,20,'y'),'y');assert.equal(intent(3,30,'x'),'x');
  assert.equal(completed(70,300,500,'x'),true);assert.equal(completed(70,800,500,'x'),false);
  assert.equal(completed(96,800,500,'x'),true);assert.equal(completed(-40,800,60,'x'),true);
  assert.equal(completed(31,800,10,'x'),false);assert.equal(completed(120,800,50,'y'),false);
  assert.equal(completed(120,800,50,''),false);
});

// Exercise the shipped event binding without a browser. This small DOM fixture
// supplies ancestry and event delivery, not gesture policy or rendered geometry.
function gestureFixture(family) {
  class Surface {
    listeners = new Map();
    addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(fn => fn !== handler)); }
    emit(type, fields = {}) {
      const event = {defaultPrevented: false, ...fields,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; }};
      for (const handler of this.listeners.get(type) || []) { handler(event); if (event.stopped) break; }
      return event;
    }
  }
  class Element extends Surface {
    constructor(selectors = [], parentElement = null) {
      super(); Object.assign(this, {selectors, parentElement, style: {transform: ''}, clientWidth: 300, scrollWidth: 300});
    }
    closest(query) {
      for (let node = this; node; node = node.parentElement)
        if (query.split(',').some(selector => node.selectors.includes(selector.trim()))) return node;
      return null;
    }
    contains(target) { for (let node = target; node; node = node.parentElement) if (node === this) return true; return false; }
    matches(selector) { return this.selectors.includes(selector); }
    querySelector(selector) { return selector === ':scope > .has-result-pages' ? this.results ?? null : null; }
    getClientRects() { return [{}]; }
    // Points are at clientY 100; result grids extend below it unless a case
    // gives them an earlier bottom (a partly filled page).
    getBoundingClientRect() { return {width: 300, bottom: this.bottom ?? 1000}; }
    animate() { animations++; return {cancel() {}, finished: new Promise(() => {})}; }
  }
  const root = new Element(), panel = new Element([], root), fixed = new Element([], root);
  const nestedFixed = new Element([], panel), content = new Element([], panel);
  const window = new Surface(), document = new Surface();
  if (family === 'touch') window.ontouchstart = null;
  window.matchMedia = () => ({matches: false});
  Object.assign(document, {body: root, hidden: false, querySelector: () => null, querySelectorAll: () => []});
  let key = 'request.quick', motions = 0, releases = 0, animations = 0;
  vm.runInNewContext(readFileSync(new URL('../static/subtab-swipe.js', import.meta.url), 'utf8'), {
    window, document, Element, innerWidth: 800, performance: {now: () => 1000},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: node => ({overflowX: node.overflowX || 'visible'}),
  });
  const binding = window.BilikaraSubTabSwipe.bind(root, {
    scope: () => 'request', tree: () => [{id: 'request', children: [{id: 'quick'}, {id: 'search'}]}],
    current: () => key, commit: path => { key = path.join('.'); }, panel: () => panel,
    fixedZones: () => [fixed, nestedFixed], motion: () => { motions++; return () => { releases++; }; },
  });
  const point = (target, x) => ({identifier: 1, target, clientX: x, clientY: 100});
  const start = target => family === 'touch'
    ? root.emit('touchstart', {target, touches: [point(target, 200)]})
    : root.emit('pointerdown', {target, pointerId: 1, pointerType: 'pen', isPrimary: true, button: 0, ...point(target, 200)});
  const move = (target, x = 80) => family === 'touch'
    ? root.emit('touchmove', {target, touches: [point(target, x)]})
    : window.emit('pointermove', {target, pointerId: 1, ...point(target, x)});
  const finish = () => family === 'touch' ? root.emit('touchend') : window.emit('pointerup', {pointerId: 1});
  const cancel = () => family === 'touch' ? root.emit('touchcancel') : window.emit('pointercancel', {pointerId: 1});
  const snapshot = () => ({key, transform: panel.style.transform, motions, releases, animations});
  return {root, panel, fixed, nestedFixed, content, window, binding, start, move, finish, cancel, snapshot,
    child: (selectors, parent = panel) => new Element(selectors, parent)};
}

for (const family of ['touch', 'pointer']) {
  test(`${family}: fixed chrome, controls, pagers and outside-panel space never create a candidate or click guard`, () => {
    const origins = [
      ['fixed heading', f => f.fixed], ['fixed toolbar blank', f => f.nestedFixed],
      ['fixed text', f => f.child([], f.fixed)], ['fixed Back', f => f.child(['button'], f.fixed)],
      ['fixed tab', f => f.child(['[role="tab"]'], f.nestedFixed)],
      ...['button', 'input', 'textarea', 'select', 'a', 'summary', 'audio', 'video', '[role="button"]',
        '[role="tablist"]', '[role="slider"]', '[contenteditable="true"]', '[draggable="true"]',
        '.result-page-viewport', '.result-pager', '.source-editor-tools'].map(selector => [selector, f => f.child([], f.child([selector]))]),
      ['overflow strip', f => { const node = f.child([]); node.scrollWidth = 600; node.overflowX = 'auto'; return f.child([], node); }],
      ['outside active content', f => f.child([], f.root)],
    ];
    for (const [label, origin] of origins) {
      const f = gestureFixture(family), target = origin(f), before = f.snapshot();
      f.start(target);
      assert.equal(f.move(f.content).defaultPrevented, false, label + ': preserve the original owner across regions');
      assert.deepEqual(f.snapshot(), before, label + ': no preview, motion setup or animation during move');
      f.finish();
      assert.deepEqual(f.snapshot(), before, label + ': no route or residual motion after end');
      assert.equal(f.root.emit('click', {target, detail: 1}).defaultPrevented, false, label + ': clicks remain available');
      f.binding.destroy();
    }
  });
  test(`${family}: result cards keep pager ownership, the blank space below a partly filled page switches sub-tabs`, () => {
    const results = f => {
      const viewport = f.child(['.result-page-viewport']);
      viewport.results = f.child(['.has-result-pages'], viewport);
      viewport.results.childNodes = [{}];
      return viewport;
    };
    const over = gestureFixture(family), filled = results(over);
    filled.results.bottom = 300;
    over.start(filled);
    assert.equal(over.move(over.content).defaultPrevented, false, 'a start over the rendered cards stays with the pager');
    over.finish();
    assert.equal(over.snapshot().key, 'request.quick');
    over.binding.destroy();
    const below = gestureFixture(family), partial = results(below);
    partial.results.bottom = 60;
    below.start(partial);
    assert.equal(below.move(below.content).defaultPrevented, true, 'blank space below the cards is content space');
    below.finish();
    assert.equal(below.snapshot().key, 'request.search');
    below.binding.destroy();
  });
  test(`${family}: a content-origin drag keeps ownership when crossing fixed chrome and commits one adjacent leaf`, () => {
    const f = gestureFixture(family);
    f.start(f.content);
    assert.equal(f.move(f.fixed).defaultPrevented, true);
    assert.equal(f.snapshot().key, 'request.quick', 'preview does not commit');
    assert.ok(f.snapshot().transform, 'content still has its ordinary preview');
    assert.equal(f.snapshot().motions, 1);
    f.finish();
    assert.equal(f.snapshot().key, 'request.search');
    assert.equal(f.snapshot().transform, '');
    assert.equal(f.snapshot().animations, 1);
    f.binding.destroy();
    assert.equal(f.snapshot().releases, 2, 'preview and incoming motion both release');
  });
  test(`${family}: interrupted content gestures restore presentation without changing the route`, () => {
    const f = gestureFixture(family);
    f.start(f.content); f.move(f.content);
    f.window.emit('blur'); f.finish();
    assert.deepEqual(f.snapshot(), {key: 'request.quick', transform: '', motions: 1, releases: 1, animations: 0});
    f.binding.destroy();
  });
  test(`${family}: content drags suppress the following click after navigation, below navigation distance and at a leaf boundary`, () => {
    for (const [label, x, expected] of [
      ['completed navigation', 80, 'request.search'],
      ['below navigation distance', 182, 'request.quick'],
      ['first leaf boundary', 320, 'request.quick'],
    ]) {
      const f = gestureFixture(family);
      let clicks = 0;
      f.root.addEventListener('click', () => { clicks++; });
      f.start(f.content);
      assert.equal(f.move(f.content, x).defaultPrevented, true, label + ': horizontal drag is owned');
      f.finish();
      assert.equal(f.snapshot().key, expected, label + ': correct route');
      const click = f.root.emit('click', {target: f.content, detail: 1});
      assert.equal(click.defaultPrevented, true, label + ': prevent the post-drag click');
      assert.equal(click.stopped, true, label + ': stop activation handlers');
      assert.equal(clicks, 0, label + ': original content action must not run');
      f.binding.destroy();
    }
  });
  test(`${family}: short content taps retain activation, including a new tap during a previous drag guard`, () => {
    for (const x of [null, 194]) {
      const f = gestureFixture(family);
      let clicks = 0;
      f.root.addEventListener('click', () => { clicks++; });
      f.start(f.content);
      if (x !== null) assert.equal(f.move(f.content, x).defaultPrevented, false, 'small tap jitter stays unclaimed');
      f.finish();
      assert.equal(f.snapshot().key, 'request.quick');
      assert.equal(f.snapshot().transform, '');
      assert.equal(f.root.emit('click', {target: f.content, detail: 1}).defaultPrevented, false);
      assert.equal(clicks, 1, 'short tap reaches its ordinary activation handler');
      f.binding.destroy();
    }
    const f = gestureFixture(family);
    f.start(f.content); f.move(f.content); f.finish();
    f.start(f.content); f.finish();
    assert.equal(f.root.emit('click', {target: f.content, detail: 1}).defaultPrevented, false,
      'a new stationary tap clears the previous drag guard immediately');
    f.binding.destroy();
  });
  test(`${family}: cancelling a content drag clears presentation and leaves no stale click guard`, () => {
    const f = gestureFixture(family);
    let clicks = 0;
    f.root.addEventListener('click', () => { clicks++; });
    f.start(f.content); f.move(f.content); f.cancel(); f.finish();
    assert.deepEqual(f.snapshot(), {key: 'request.quick', transform: '', motions: 1, releases: 1, animations: 0});
    assert.equal(f.root.emit('click', {target: f.content, detail: 1}).defaultPrevented, false);
    assert.equal(clicks, 1, 'cancelled touch/pointer does not leave a stale activation guard');
    f.binding.destroy();
  });
}
