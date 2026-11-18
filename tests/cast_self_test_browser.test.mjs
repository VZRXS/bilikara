// P9: R1 T8 checks mapped to a Manage device-row opener; production row integration is in cast_browser.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';

const read = name => readFileSync(new URL(`../static/${name}`, import.meta.url), 'utf8');
const dictionary = JSON.parse(read('i18n.json')).languages;
test('cast and compatibility translations retain Unicode and intentional question marks', () => {
  for (const language of ['zh', 'en', 'ja']) for (const [key, value] of Object.entries(dictionary[language])) {
    if (key.startsWith('cast.') || ['purek.manualAddress','purek.addressConfirmed','purek.manualAddressHint','mediaOutput.dspUnavailable'].includes(key)) {
      assert.doesNotMatch(value, /\?\?|\uFFFD|\?(?!$)/, key);
      if (language !== 'en') assert.match(value, /[\u3040-\u9fff]/, key);
      if (key.startsWith('cast.test.cell.')) assert.match(value, /×/, key);
      if (key === 'cast.test.busy') assert.match(value, /…$/, key);
    }
  }
});
async function open(t, width = 700, language = 'zh', hasTouch = true) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  const trigger = '<button type="button" class="toolbar-button purek-action" data-cast-compatibility-test></button>';
  await page.setContent(`<style>${read('accent-palette.css')}\n${read('styles.css')}\n${read('ui-surfaces.css')}\n${read('purek-room.css')}</style><div class="purek-device">${trigger}<button id="purek-close">Close</button></div><button id="purek-open">Manage</button><video id="retained-video"></video>`);
  await page.addScriptTag({ content: read('cast-self-test.js') });
  await page.evaluate(({ dictionary, language }) => {
    const state = { cast: { phase: 'idle', renderers: [{ device_key: 'one', label: 'Living room' }], self_test: {} } };
    const calls = [], pending = new Map(), errors = [], rejections = new Map(), translations = [];
    let copied = '', saved = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: text => { copied = text; return new Promise(resolve => pending.set('copy', resolve)); } } });
    const report = { diagnostics: { cast_self_test: { schema_version: 1, conclusion: { decision_row: 2 }, cells: [] } }, text: 'Safe diagnostic summary' };
    const controller = BilikaraCastSelfTest.create({
      snapshot: () => state, translate: key => { translations.push(key); return dictionary[language][key] || key; },
      physicalBusy: () => false, castBusy: () => false, closePhysical: async () => {}, disconnect: async () => {},
      refresh: async () => controller.render(), error: message => errors.push(message),
      post: async (path, payload) => { calls.push({ path, payload }); return new Promise(resolve => pending.set(path.split('/').at(-1), resolve)); },
      getReport: async () => report,
      saveReport: () => new Promise((resolve, reject) => { rejections.set('save', reject); pending.set('save', result => { saved = result !== 'cancelled'; resolve(result || 'saved'); }); }),
    });
    document.querySelector('[data-cast-compatibility-test]').addEventListener('click', event => controller.open(event.currentTarget, 'one'));
    window.fixture = { state, calls, errors, report, translations, video: document.querySelector('video'),
      update(test) { Object.assign(state.cast.self_test, test); controller.render(); },
      resolve(action, result) { const resolve = pending.get(action); if (!resolve) throw new Error(`Not pending: ${action}`); pending.delete(action); resolve(result); },
      reject(action) { rejections.get(action)(new Error('private native detail')); },
      copied: () => copied, saved: () => saved,
      timeout() { setTimeout(() => { this.update({ cell: 'file_b', question: true }); }, 60000); },
    };
  }, { dictionary, language });
  await page.locator('[data-cast-compatibility-test]').click();
  return page;
}

for (const language of ['zh', 'en', 'ja']) test(`self-test reuses shared close and busy labels ${language}`, async t => {
  const page = await open(t, 700, language);
  assert.equal(await page.locator('[data-test-close]').getAttribute('aria-label'), dictionary[language]['common.close']);
  await page.locator('[data-test-start]').click();
  assert.equal(await page.locator('[data-test-start]').innerText(), dictionary[language]['purek.working']);
  const translated = await page.evaluate(() => fixture.translations);
  assert.equal(translated.includes('cast.test.close') || translated.includes('cast.test.busy'), false);
  assert.ok(translated.includes('common.close') && translated.includes('purek.working'));
  await page.evaluate(() => fixture.resolve('start'));
  await page.waitForFunction(() => !document.querySelector('[data-test-start]').hasAttribute('aria-busy'));
});

test('closing compatibility dialog restores Manage focus when its receiver row disappears', async t => {
  const page = await open(t);
  for (const method of ['button', 'escape']) {
    await page.locator('.purek-device').evaluate(node => { fixture.detachedRow = node; node.remove(); });
    if (method === 'button') await page.locator('[data-test-close]').click();
    else await page.keyboard.press('Escape');
    assert.equal(await page.locator('#cast-self-test').evaluate(node => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement === document.getElementById('purek-open')), true, method);
    if (method === 'button') {
      await page.evaluate(() => document.body.prepend(fixture.detachedRow));
      await page.locator('[data-cast-compatibility-test]').click();
    }
  }
});

test('compatibility dialog guards async actions, preserves drafts, copies and saves', async t => {
  const page = await open(t);
  await page.clock.install();
  await page.locator('[data-test-device]').selectOption('one');
  await page.locator('[data-test-start]').click();
  await page.waitForFunction(() => fixture.calls.length === 1);
  assert.equal(await page.locator('[data-test-start]').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('[data-test-start]').isDisabled(), true);
  await page.clock.fastForward(500);
  assert.equal(await page.locator('[data-test-start]').getAttribute('aria-busy'), 'true');
  await page.locator('[data-test-start]').dispatchEvent('click');
  assert.equal(await page.evaluate(() => fixture.calls.length), 1);
  await page.evaluate(() => { fixture.update({ generation: 1, running: true, stage: 's6', cell: 'file_a', question_id: 4, question: true, ask_sync: true }); fixture.resolve('start'); });
  await page.locator('input[name="cast-test-video"][value="normal"]').check();
  await page.locator('input[name="cast-test-audio"][value="yes"]').check();
  await page.locator('input[name="cast-test-synchronized"][value="yes"]').check();
  await page.evaluate(() => fixture.update({ stage: 's6' }));
  assert.equal(await page.locator('input[name="cast-test-video"][value="normal"]').isChecked(), true);
  await page.locator('[data-test-submit]').click();
  await page.waitForFunction(() => fixture.calls.length === 2);
  assert.equal(await page.locator('[data-test-submit]').getAttribute('aria-busy'), 'true');
  const answer = await page.evaluate(() => fixture.calls.at(-1).payload);
  assert.deepEqual(answer, { generation: 1, cell: 'file_a', question_id: 4, answers: { video: 'normal', audio: 'yes', synchronized: 'yes' } });
  await page.evaluate(() => { fixture.update({ question: false }); fixture.resolve('answer'); });
  await page.evaluate(() => fixture.update({ running: false, report_available: true, stage: 's7' }));
  await page.waitForFunction(() => document.querySelector('[data-test-summary]').textContent.includes('Safe diagnostic'));
  await page.locator('[data-test-copy]').click();
  await page.waitForFunction(() => fixture.copied().length > 0);
  assert.equal(await page.locator('[data-test-copy]').getAttribute('aria-busy'), 'true');
  assert.equal(await page.evaluate(() => fixture.copied()), 'Safe diagnostic summary\n\n' + JSON.stringify({ diagnostics: { cast_self_test: { schema_version: 1, conclusion: { decision_row: 2 }, cells: [] } } }, null, 2));
  await page.evaluate(() => fixture.resolve('copy'));
  await page.locator('[data-test-save]').click();
  assert.equal(await page.locator('[data-test-save]').getAttribute('aria-busy'), 'true');
  await page.evaluate(() => fixture.resolve('save'));
  await page.waitForFunction(() => fixture.saved());
  assert.equal(await page.evaluate(() => fixture.video === document.querySelector('video')), true);
  assert.deepEqual(await page.evaluate(() => fixture.errors), []);
});

test('server question timeout advances without a fabricated answer and cancel stays guarded', async t => {
  const page = await open(t);
  await page.clock.install();
  await page.evaluate(() => { fixture.update({ generation: 1, running: true, stage: 's6', cell: 'file_a', question: true }); fixture.timeout(); });
  await page.clock.fastForward(60000);
  assert.equal(await page.evaluate(() => fixture.state.cast.self_test.cell), 'file_b');
  assert.deepEqual(await page.evaluate(() => fixture.calls), []);
  await page.locator('[data-test-cancel]').click();
  assert.equal(await page.locator('[data-test-cancel]').getAttribute('aria-busy'), 'true');
  await page.evaluate(() => { fixture.update({ running: false, question: false }); fixture.resolve('cancel'); });
  await page.waitForFunction(() => !document.querySelector('[data-test-cancel]').hasAttribute('aria-busy'));
  assert.equal(await page.locator('[data-test-questions]').isVisible(), false);
});

test('save cancellation and failure restore controls without leaking native details', async t => {
  const page = await open(t);
  await page.evaluate(() => fixture.update({ generation: 1, report_available: true }));
  await page.waitForFunction(() => !document.querySelector('[data-test-save]').disabled);
  await page.locator('[data-test-save]').click();
  await page.evaluate(() => fixture.resolve('save', 'cancelled'));
  await page.waitForFunction(() => !document.querySelector('[data-test-save]').hasAttribute('aria-busy'));
  assert.equal(await page.evaluate(() => fixture.saved()), false);
  assert.deepEqual(await page.evaluate(() => fixture.errors), []);
  await page.locator('[data-test-save]').click();
  await page.evaluate(() => fixture.reject('save'));
  await page.waitForFunction(() => fixture.errors.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.errors), [dictionary.zh['cast.error.unknown']]);
  assert.equal(await page.locator('[data-test-save]').isDisabled(), false);
});

test('device-row self-test reuses its prepared renderer without a second QR authorization input', async t => {
  const page = await open(t);
  assert.equal(await page.locator('[data-test-device]').inputValue(), 'one');
  assert.equal(await page.locator('input[type=url]').count(), 0);
  assert.deepEqual(await page.locator('[data-test-device] option').evaluateAll(options => options.map(option => option.value)), ['', 'one']);
  await page.locator('[data-test-start]').click();
  await page.waitForFunction(() => fixture.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.calls), [{path:'/api/cast/self-test/start', payload:{generation:undefined,device_key:'one'}}]);
  assert.deepEqual(await page.evaluate(() => fixture.errors), []);
  await page.evaluate(() => fixture.resolve('start'));
  await page.waitForFunction(() => !document.querySelector('[data-test-start]').hasAttribute('aria-busy'));
  assert.equal(await page.locator('[data-test-start]').isDisabled(), false);
});

for (const language of ['zh', 'en', 'ja']) test(`short question deadline and handoff choice ${language}`, async t => {
  const page = await open(t, 700, language);
  await page.clock.install();
  await page.evaluate(() => fixture.update({ generation: 2, running: true, stage: 's6', cell: 'file_b', question_id: 9, question: true, question_deadline_ms: Date.now() + 3000 }));
  assert.equal(await page.locator('[data-test-countdown-text]').textContent(), dictionary[language]['cast.test.remaining'].replace('{seconds}', '3'));
  const announcement = await page.locator('[data-test-countdown-live]').textContent();
  await page.clock.fastForward(1000);
  assert.equal(await page.locator('[data-test-countdown-text]').textContent(), dictionary[language]['cast.test.remaining'].replace('{seconds}', '2'));
  assert.equal(await page.locator('[data-test-countdown-live]').textContent(), announcement, 'polite announcement does not update every second');
  await page.clock.fastForward(2000);
  assert.equal(await page.locator('[data-test-countdown-text]').textContent(), dictionary[language]['cast.test.remaining'].replace('{seconds}', '0'));
  assert.deepEqual(await page.evaluate(() => fixture.calls), []);
  await page.evaluate(() => fixture.update({ question: false, stage: 's7', handoff_available: true }));
  assert.equal(await page.locator('[data-test-countdown]').isVisible(), false);
  await page.locator('[data-test-continue]').click();
  await page.locator('[data-test-continue]').dispatchEvent('click');
  assert.deepEqual(await page.evaluate(() => fixture.calls), [{ path: '/api/cast/self-test/handoff', payload: { generation: 2, start_casting: true } }]);
  assert.equal(await page.locator('[data-test-finish]').isDisabled(), true);
  await page.evaluate(() => { fixture.update({ running: false, handoff_available: false }); fixture.resolve('handoff'); });
  await page.evaluate(() => { fixture.report.diagnostics.cast_self_test.cells = [{ cell: 'file_b', skip_reason: 'platform_unavailable' }, { cell: 'live_b', skip_reason: 'platform_unavailable' }]; fixture.update({ report_available: true }); });
  await page.waitForFunction(() => !document.querySelector('[data-test-platform]').hidden);
  assert.ok((await page.locator('[data-test-platform]').textContent()).includes(dictionary[language]['cast.test.platformUnavailable']));
  await page.locator('[data-test-close]').click();
  assert.equal(await page.locator('[data-cast-compatibility-test]').evaluate(node => node === document.activeElement), true);
});

test('self-test reuses shared controls in all themes and interaction states', { timeout: 90000 }, async t => {
  const page = await open(t, 1100, 'en', false);
  await page.evaluate(() => {
    const dialog = document.querySelector('#cast-self-test'); dialog.close(); dialog.show();
    fixture.update({ generation: 1, report_available: true });
    const reference = document.createElement('div');
    reference.className = 'source-action-row';
    reference.style.cssText = 'position:fixed;left:800px;top:20px;display:grid;width:250px;gap:12px';
    reference.innerHTML = '<button class="toolbar-button" id="reference-secondary">Secondary</button><button class="next-button" id="reference-primary">Primary</button><select class="confirm-source" id="reference-select"><option>Target</option></select>';
    document.body.append(reference);
  });
  await page.waitForFunction(() => !document.querySelector('[data-test-copy]').disabled);
  const metrics = node => {
    const css = getComputedStyle(node);
    return Object.fromEntries(['backgroundColor', 'backgroundImage', 'color', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'height', 'fontSize', 'fontWeight', 'borderRadius', 'outlineColor', 'outlineWidth', 'boxShadow', 'opacity'].map(key => [key, css[key]]));
  };
  async function observe(selector, interaction) {
    const control = page.locator(selector);
    await page.mouse.move(1090, 790);
    await page.evaluate(() => document.activeElement?.blur());
    await control.evaluate((node, disabled) => { node.disabled = disabled; }, interaction === 'disabled');
    if (interaction === 'hover') await control.hover();
    if (interaction === 'focus') await control.focus();
    if (interaction === 'pressed') { await control.hover(); await page.mouse.down(); }
    await control.evaluate(async node => {
      getComputedStyle(node).backgroundColor;
      await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const result = await control.evaluate(metrics);
    if (interaction === 'pressed') { await page.mouse.move(1090, 790); await page.mouse.up(); }
    await control.evaluate(node => { node.disabled = false; });
    return result;
  }
  const backgrounds = [];
  for (const theme of ['light', 'dark', 'blue']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const [target, reference] of [['[data-cast-compatibility-test]', '#reference-secondary'], ['[data-test-copy]', '#reference-secondary'], ['[data-test-start]', '#reference-secondary'], ['[data-test-save]', '#reference-primary'], ['[data-test-device]', '#reference-select']]) {
      for (const interaction of ['normal', 'hover', 'focus', 'pressed', 'disabled']) {
        assert.deepEqual(await observe(target, interaction), await observe(reference, interaction), `${theme}: ${target} ${interaction}`);
      }
    }
    backgrounds.push((await observe('[data-test-copy]', 'normal')).backgroundColor);
    const primary = await observe('[data-test-save]', 'normal');
    assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(primary.backgroundColor), `${theme}: primary fill must be visible`);
    const close = await page.locator('[data-test-close]').evaluate(node => {
      const rect = node.getBoundingClientRect(), icon = node.querySelector('svg').getBoundingClientRect();
      return { width: rect.width, height: rect.height, contained: icon.left >= rect.left && icon.right <= rect.right && icon.top >= rect.top && icon.bottom <= rect.bottom };
    });
    assert.deepEqual(close, { width: 32, height: 32, contained: true });
  }
  assert.equal(new Set(backgrounds).size, 3, 'secondary surfaces follow the selected theme');
});

for (const width of [700, 360, 320]) for (const language of ['zh', 'en', 'ja']) {
  test(`compatibility questions fit ${width}px ${language}`, async t => {
    const page = await open(t, width, language);
    await page.evaluate(() => fixture.update({ generation: 1, running: true, stage: 's6', cell: 'live_b', question: true, ask_sync: true }));
    await page.locator('input[name="cast-test-video"][value="normal"]').check();
    const bounds = await page.locator('#cast-self-test').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, overflow: dialog.scrollWidth - dialog.clientWidth,
        buttons: [...dialog.querySelectorAll('footer button, [data-test-submit]')].filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect().height),
        backdrop: getComputedStyle(dialog, '::backdrop').backgroundColor,
        blocks: [...dialog.children].filter(e => e.getClientRects().length).map(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })),
      };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, JSON.stringify(bounds));
    assert.ok(bounds.overflow <= 1, JSON.stringify(bounds));
    assert.ok(bounds.buttons.every(h => h >= 44), JSON.stringify(bounds));
    assert.equal(bounds.backdrop, 'rgba(0, 0, 0, 0)');
    for (let i=1;i<bounds.blocks.length;i++) assert.ok(bounds.blocks[i].top >= bounds.blocks[i-1].bottom, JSON.stringify(bounds.blocks));
    if (width === 320 && language === 'ja') { mkdirSync(new URL('../.tmp/self-test-browser/', import.meta.url), { recursive: true }); await page.screenshot({ path: new URL('../.tmp/self-test-browser/320-ja.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true }); }
  });
}

// P10 review N1: a prepared Pure K room that is not the selected device is
// stated explicitly instead of silently testing ordinary DLNA.
for (const language of ['zh', 'en', 'ja']) test(`unmatched prepared room is reported ${language}`, async t => {
  const page = await open(t, 360, language);
  const note = page.locator('[data-test-room]');
  assert.equal(await note.isVisible(), false);
  await page.evaluate(() => fixture.update({ generation: 1, running: true, stage: 's1', purek_room_unmatched: true }));
  assert.equal(await note.isVisible(), true);
  assert.equal(await note.textContent(), dictionary[language]['cast.test.roomUnmatched']);
  // It stays with the finished report and clears on a matched run.
  await page.evaluate(() => fixture.update({ running: false, report_available: true }));
  assert.equal(await note.isVisible(), true);
  await page.evaluate(() => fixture.update({ generation: 2, running: true, purek_room_unmatched: false }));
  assert.equal(await note.isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
