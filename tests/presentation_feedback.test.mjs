import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { root } from './desktop_construction_support.mjs';
const source = readFileSync(path.join(root, 'static/presentation-feedback.js'), 'utf8');
const baseline = () => ({ session_generation: 1, current_item: { id: 'song', item_incarnation_id: 'incarnation' },
  player_settings: { volume_percent: 100, is_muted: false, av_offset_ms: 0, key_shift: 0, av_delay: { effective_delay_ms: 0, locked: false } },
  session_user_entries: [{ id: 'alice', name: 'Alice' }] });
function fixture() {
  let now = 1000, sequence = 0;
  const timers = new Map(), frames = new Map();
  const makeNode = tag => {
    const classes = new Set();
    return { tag, children: [], dataset: {}, textContent: '', attributes: {}, style: { setProperty(key, value) { this[key] = value; } },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, yes) { if (yes) classes.add(name); else classes.delete(name); } },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
      appendChild(node) { this.append(node); }, replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); } };
  };
  const element = makeNode('div'); element.classList.add('hidden');
  const context = { Date: { now: () => now }, document: { createElement: makeNode, createElementNS: (_, tag) => makeNode(tag) },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, deadline: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id) };
  vm.runInNewContext(source, context);
  return { api: context.BilikaraPresentationFeedback, element, timers,
    paint() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.deadline <= now) { timers.delete(id); timer.fn(); } },
    card(category) { return element.children.find(node => node.dataset.feedbackCategory === category); } };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('settings feedback excludes initial/progress/user/reorder/song defaults and preserves simultaneous acknowledged changes', () => {
  const { api } = fixture(), data = baseline(), first = api.snapshot(data);
  assert.deepEqual(plain(api.changes(null, first)), []);
  for (const extra of [{ state_revision: 20 }, { session_user_entries: [] }, { session_generation: 2 },
    { current_item: { id: 'song', item_incarnation_id: 'new' }, player_settings: { volume_percent: 80 } }])
    assert.deepEqual(plain(api.changes(first, api.snapshot({ ...data, ...extra }))), []);
  assert.deepEqual(plain(api.changes(first, api.snapshot({ ...data, player_settings: { ...data.player_settings,
    volume_percent: 80, key_shift: 2, av_delay: { effective_delay_ms: 150, locked: true } } }))), [
    { kind: 'delay', value: '+150ms' }, { kind: 'delay-lock', value: 'locked' }, { kind: 'pitch', value: '+2' }, { kind: 'volume', value: '80%' }]);
  assert.equal(api.change(first, api.snapshot({ ...data, player_settings: { volume_percent: NaN, av_offset_ms: NaN } })), null);
});
test('recent relay retains two distinct categories, merges repeated adjustments and expires without a waiting backlog', () => {
  const { api } = fixture(), notice = (key, kind) => ({ key, kind, value: key, expiresAt: 3000 });
  const initial = api.recent(null, [notice('1', 'volume'), notice('2', 'delay')], 1000);
  const muted = api.recent(initial, [notice('3', 'muted')], 1000);
  assert.deepEqual(plain(muted.entries.map(n => n.key)), ['2', '3']);
  const next = api.recent(muted, [notice('4', 'pause')], 1000);
  assert.deepEqual(plain(next.entries.map(n => n.key)), ['3', '4']);
  assert.equal(api.recent(next, [], 3000), null);
});
test('two cards coalesce in place, retain exiting nodes and rapid reopening cancels owned exit timers', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  const notice = (key, kind, value = key, expiresAt = 3000) => ({ key, kind, value, expiresAt });
  view.show(notice('1', 'volume', '80%')); f.paint();
  const card = f.card('volume');
  view.show(notice('2', 'volume', '85%')); f.paint(); assert.equal(f.card('volume'), card);
  assert.equal(card.children[2].textContent, '85%');
  view.show(notice('3', 'delay', '+150ms')); f.paint();
  view.show(notice('4', 'pitch', '+2')); f.paint();
  assert.equal(f.element.children.filter(n => n.classList.contains('is-visible')).length, 1,
    'The replacement enters only after the evicted card finishes its exit');
  assert.equal(f.element.children.includes(card), true, 'Keep the oldest card through exit motion');
  view.show(notice('5', 'volume', '90%')); f.paint(); f.advance(120); f.paint();
  assert.equal(f.card('volume'), card, 'A reopened category retains its node');
  assert.equal(f.element.children.filter(n => n.classList.contains('is-visible')).length, 2,
    'Reopening an exiting category also evicts the oldest visible card');
  assert.equal(card.children[2].textContent, '90%');
  f.advance(1880); assert.equal(f.element.classList.contains('is-visible'), false);
  f.advance(120); assert.equal(f.element.classList.contains('hidden'), true); assert.equal(f.timers.size, 0);
});
test('same-category updates retain their slot while eviction still keeps the two most recently updated categories', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  const notice = (key, kind) => ({ key, kind, value: key, expiresAt: 3000 });
  view.show(notice('1', 'volume')); f.paint();
  const volume = f.card('volume');
  assert.equal(volume.style['--feedback-offset'], 'calc(-100% - 4px)');
  view.show(notice('2', 'delay')); f.paint();
  assert.equal(f.card('delay').style['--feedback-offset'], '4px');
  assert.equal(volume.style['--feedback-offset'], 'calc(-100% - 4px)');
  view.show(notice('3', 'volume')); f.paint();
  assert.equal(f.card('volume'), volume);
  assert.equal(volume.style['--feedback-offset'], 'calc(-100% - 4px)');
  assert.equal(f.card('delay').style['--feedback-offset'], '4px');
  view.show(notice('4', 'pitch')); f.paint();
  assert.equal(f.card('delay').classList.contains('is-visible'), false);
  assert.equal(f.card('pitch').classList.contains('is-visible'), false);
  f.advance(120); f.paint();
  assert.equal(f.card('pitch').style['--feedback-offset'], '4px');
  assert.equal(volume.style['--feedback-offset'], 'calc(-100% - 4px)');
});
test('each card expires independently and the lower card moves up only after the upper exit finishes', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  view.show({ key: '1', kind: 'volume', value: '80%', expiresAt: 2000 }); f.paint();
  view.show({ key: '2', kind: 'delay', value: '+150ms', expiresAt: 3000 }); f.paint();
  const volume = f.card('volume'), delay = f.card('delay');
  f.advance(1000);
  assert.equal(volume.classList.contains('is-visible'), false);
  assert.equal(f.card('volume'), volume, 'Keep the upper node through its exit');
  assert.equal(delay.style['--feedback-offset'], '4px', 'Do not move into the fading card');
  view.show({ key: '3', kind: 'delay', value: '+200ms', expiresAt: 3000 }); f.paint();
  assert.equal(delay.style['--feedback-offset'], '4px', 'Refreshing the lower card cannot bypass the upper exit');
  f.advance(119); assert.equal(delay.style['--feedback-offset'], '4px');
  f.advance(1);
  assert.equal(f.card('volume'), undefined);
  assert.equal(f.card('delay'), delay);
  assert.equal(delay.style['--feedback-offset'], 'calc(-100% - 4px)');
  f.advance(880); f.advance(120);
  assert.equal(f.element.classList.contains('hidden'), true);
  assert.equal(f.timers.size, 0);
});
test('rapid category replacement retains only the latest two without an invisible waiting backlog', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  for (const [key, kind] of [['1', 'volume'], ['2', 'delay'], ['3', 'pitch'], ['4', 'pause'], ['5', 'next']]) {
    view.show({ key, kind, value: key, expiresAt: 3000 }); f.paint();
  }
  f.advance(120); f.paint();
  assert.deepEqual(f.element.children.map(node => node.dataset.feedbackCategory), ['playback', 'next']);
  assert.equal(f.element.children.filter(node => node.classList.contains('is-visible')).length, 2);
  f.advance(1880); f.advance(120); f.paint();
  assert.equal(f.element.children.length, 0);
  assert.equal(f.timers.size, 0);
});
test('the newer lower card may expire first without moving or extending the upper card', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  view.show({ key: '1', kind: 'volume', value: '80%', expiresAt: 3000 }); f.paint();
  view.show({ key: '2', kind: 'delay', value: '+150ms', expiresAt: 2000 }); f.paint();
  const volume = f.card('volume');
  f.advance(1000); f.advance(120);
  assert.equal(f.card('delay'), undefined);
  assert.equal(f.card('volume'), volume);
  assert.equal(volume.style['--feedback-offset'], 'calc(-100% - 4px)');
  assert.equal(volume.classList.contains('is-visible'), true);
  f.advance(880); assert.equal(volume.classList.contains('is-visible'), false);
});
test('invalid/stale notices, markup, output bounds and replay cannot create controls or extend expiry', () => {
  const f = fixture(), view = f.api.create(f.element, key => key);
  const first = { key: '1', kind: 'volume', value: '<img onerror=bad()>', expiresAt: 3000 };
  assert.equal(view.show(first), true); f.paint();
  const card = f.card('volume'); assert.equal(card.children[2].textContent, first.value);
  const timers = [...f.timers.keys()]; assert.equal(view.show(first), false); assert.deepEqual([...f.timers.keys()], timers);
  for (const extra of [{ key: 'old', expiresAt: 999 }, { key: 'bad', kind: 'user-add' }, { key: 'empty', value: null },
    { key: 'prototype', kind: '__proto__' }, { key: 'bad-lock', kind: 'delay-lock', value: 'arbitrary' }])
    assert.equal(view.show({ ...first, ...extra }), false);
  view.show({ ...first, key: 'long', value: 'a'.repeat(1000), expiresAt: 999999 }); f.paint();
  assert.equal(card.children[2].textContent.length, 512);
  f.advance(2000); f.advance(120); assert.equal(f.element.classList.contains('hidden'), true);
  assert.equal(view.show(first), false, 'Expired replay stays expired');
  view.show({ key: 'fresh', kind: 'pause', value: '', expiresAt: 9000 }); view.hide(); f.paint(); f.advance(120);
  assert.equal(f.element.children.length, 0); assert.equal(f.timers.size, 0);
});
test('localization updates visible full labels and values without extending their deadline', () => {
  const f = fixture(); let language = 'en';
  const view = f.api.create(f.element, () => language === 'en' ? 'Audio/video delay' : '音画延迟');
  const first = { key: 'delay', kind: 'delay', value: '+150ms', expiresAt: 3000 };
  view.show(first); f.paint(); const card = f.card('delay'), value = card.children[2], timers = [...f.timers.keys()];
  f.advance(1500); language = 'zh'; assert.equal(view.show(first), false);
  assert.equal(card.children[1].textContent, '音画延迟'); assert.equal(card.children[2], value);
  assert.deepEqual([...f.timers.keys()], timers);
  f.advance(500); assert.equal(card.classList.contains('is-visible'), false);
});
test('all native main-window configurations declare the same 700 × 600 logical minimum', () => {
  for (const name of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.macos.conf.json']) {
    const main = JSON.parse(readFileSync(path.join(root, 'src-tauri', name), 'utf8')).app.windows.find(w => w.label === 'main');
    assert.equal(main.minWidth, 700); assert.equal(main.minHeight, 600); assert.equal(main.height, 700);
  }
});
