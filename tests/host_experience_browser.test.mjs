import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { before } from 'node:test';
import { chromium, webkit } from 'playwright';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeAlpha, buildNativeHost } from './native_runtime_artifacts.mjs';
import { RunningHost, isolatedEnvironment } from './native_host_support.mjs';

const require = createRequire(import.meta.url);
const ratingDialog = require('./browser/remote_rating_dialog.cjs');
let alpha, desktop;
before(async () => {
  if (process.platform !== 'linux') return;
  alpha = await buildNativeAlpha();
  desktop = await buildNativeHost();
}, { timeout: 300000 });

async function open(t, engine, role = 'host') {
  const home = mkdtempSync(path.join(root, '.tmp/Host experience 中文 & '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const host = await RunningHost.start(alpha, home, [home, path.join(root, 'static')], isolatedEnvironment(home), true);
  t.after(() => host.close());
  await host.api('/api/session-users/add', { name: 'Alice' });
  const browser = await engine.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: role === 'host'
    ? { width: 1920, height: 1080 } : { width: 440, height: 956 } });
  if (role === 'host') await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
  await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
  await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base + (role === 'remote' ? '/remote' : ''));
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data?.session_user_entries?.length === 1);
  if (role === 'remote') {
    await page.waitForFunction(() => !state.remoteIdentityChecking);
    await page.evaluate(async () => applyRemoteIdentity(await apiPost('/api/remote-identity/register', { name: 'Alice', claim: true })));
    await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
  } else await page.evaluate(() => { document.documentElement.dataset.hostPlatform = 'desktop'; });
  t.after(() => assert.deepEqual(errors, []));
  return { page, home, host };
}

const nativeLimit = process.platform !== 'linux'
  && 'Linux Chromium/WebKit interaction fixtures; Windows/macOS native WebViews remain separate';
for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  for (const role of ['host', 'remote']) test(`${name} ${role} ratings save editable waiting values and lock only actual submission`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page, home } = await open(t, engine, role);
    await ratingDialog(page, { bvid: 'BV1xx411c7mD', title: 'Rating fixture', owner_mid: 42 }, home, { role });
  });

  test(`${name} desktop rail hover matches selection and random covers ignore title/artwork size`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    const rail = page.locator('#work-rail-random');
    for (const theme of ['light', 'dark', 'blue']) {
      await page.evaluate(theme => { applyTheme(theme); activateHostWorkspace('queue', { inputOrigin: 'programmatic' }); }, theme);
      await rail.hover();
      await rail.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      const hover = await rail.evaluate(node => getComputedStyle(node).color);
      await rail.click();
      await rail.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      assert.equal(await rail.evaluate(node => getComputedStyle(node).color), hover, theme);
    }
    await page.route('**/fixture-cover', route => route.fulfill({ contentType: 'image/svg+xml', body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="500"><rect width="90" height="500" fill="orange"/></svg>' }));
    for (const width of [700, 1280, 1920]) {
      await page.setViewportSize({ width, height: 1080 });
      const covers = [];
      for (const [title, artwork] of [['短标题', false], ['Long title 中文'.repeat(25), true]]) {
        await page.evaluate(({ title, artwork }) => {
          state.gatchaCandidate = { bvid: 'BV1xx411c7mD', title, owner_name: 'Artist', cover_url: artwork ? location.origin + '/fixture-cover' : '' };
          state.gatchaView = 'candidate'; renderGatchaWorkspace();
        }, { title, artwork });
        if (artwork) await page.locator('#gatcha-candidate-card img').evaluate(image => image.decode());
        await page.evaluate(() => Promise.allSettled(document.getAnimations()
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
        covers.push(await page.locator('#gatcha-candidate-card .search-result-cover').evaluate(node => {
          const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
        }));
      }
      assert.deepEqual(covers[0], covers[1], 'Image dimensions and title must not resize the cover');
      assert.ok(Math.abs(covers[0].width / covers[0].height - 16 / 9) < 0.01);
      const size = await page.locator('#gatcha-candidate-card').evaluate(node => {
        const parent = node.parentElement, style = getComputedStyle(parent);
        return { actual: node.getBoundingClientRect().width,
          available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      assert.ok(Math.abs(size.actual - Math.min(360, size.available)) < 1, JSON.stringify(size));
    }
  });

  test(`${name} Remote progress remains keyboard/touch usable and cancels interrupted scrubbing`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine, 'remote');
    await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      state.ratingOptOut = true;
      const current = { id: 'seek-fixture', bvid: 'BV1xx411c7mD', title: 'Seek fixture', cache_status: 'ready', selected_pages: [1], selected_durations: [120],
        video_media_url: location.origin + '/fixture.mp4', audio_variants: [{ audio_url: location.origin + '/fixture.m4a' }] };
      state.data.current_item = current;
      state.data.playback_generation = 1;
      state.data.player_status = { item_id: current.id, playback_generation: 1, current_time: 20, duration: 120, is_paused: true };
      renderCurrentItem(current); openPlaybackSheet();
      renderCurrentPlaybackState(current);
      renderPlayerControls(current, 'local');
      paintPlaybackClockSurfaces();
    });
    const requests = [];
    await page.route('**/api/player/control', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, data: {} } });
    });
    const range = page.locator('#playback-sheet-seek');
    await range.waitFor({ state: 'visible' });
    await range.evaluate(node => node.blur());
    assert.equal(await range.evaluate(node => node.matches(':focus')), false);
    const rect = await range.boundingBox();
    assert.equal(rect.height, 44);
    let response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await range.click({ position: { x: rect.width / 2, y: rect.height / 2 } });
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(await range.evaluate(node => node.matches(':focus')), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'seek-absolute');
    const before = Number(await range.inputValue());
    response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await page.keyboard.press('ArrowRight');
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].target_seconds > before);
    const dragBounds = await range.boundingBox();
    const start = Number(await range.inputValue()) / Number(await range.getAttribute('max'));
    await page.mouse.move(dragBounds.x + 5 + start * (dragBounds.width - 10), dragBounds.y + dragBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBounds.x + 5 + 0.75 * (dragBounds.width - 10), dragBounds.y + dragBounds.height / 2, { steps: 5 });
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), true);
    assert.equal(requests.length, 2, 'Dragging previews locally until release');
    const dragged = Number(await range.inputValue());
    await page.evaluate(() => paintPlaybackClockSurfaces());
    assert.equal(Number(await range.inputValue()), dragged, 'Clock updates must preserve the drag');
    response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await page.mouse.up();
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(requests.length, 3);
    assert.ok(Math.abs(requests[2].target_seconds - 90) <= 1);
    await range.evaluate(node => { node.value = '90'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), true);
    await range.dispatchEvent('pointercancel');
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), false);
    assert.equal(requests.length, 3, 'Cancellation must not seek');
    await page.evaluate(() => closePlaybackSheet());
    assert.equal(await range.evaluate(node => node.classList.contains('is-engaged')), false);
  });

  test(`${name} isolated audience receives download progress without recreating media or changing authority`, {
    skip: nativeLimit, timeout: 120000,
  }, async t => {
    const directory = mkdtempSync(path.join(root, '.tmp/audience progress 中文 & '));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = await runNative(process.execPath,
      ['tests/browser/native_presentation_output_relay.cjs', desktop, directory, name.toLowerCase()],
      process.env, 100000);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /audience download progress: PASS/);
  });

  test(`${name} Host titles reserve glyph paint room in single-line, two-line and scrolling layouts`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine);
    for (const width of [1920, 700]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const family of ['', 'Arial, sans-serif']) {
        const paint = await page.evaluate(family => {
          elements.currentTitle.style.fontFamily = family;
          elements.currentTitleText.textContent = 'gypqj'; measurePersistentStage();
          const range = document.createRange(); range.selectNodeContents(elements.currentTitleText);
          const glyph = range.getBoundingClientRect(), text = elements.currentTitleText.getBoundingClientRect();
          return { top: glyph.top - text.top, bottom: text.bottom - glyph.bottom };
        }, family);
        assert.ok(paint.top >= 2 && paint.bottom >= 2, `Glyph bounds need paint room: ${JSON.stringify(paint)}`);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      elements.currentTitle.style.fontFamily = '';
      elements.currentTitle.style.maxWidth = '300px';
      elements.currentTitleText.textContent = 'gypqj 演唱版本 gypqj ending'; measurePersistentStage();
    });
    await page.waitForFunction(() => elements.currentTitle.dataset.visibleLines === '2');
    assert.equal(await page.locator('#current-title').evaluate(node => node.classList.contains('is-scrolling')), false);
    await page.evaluate(() => {
      elements.currentTitleText.textContent = 'gypqj 很长的歌曲标题 '.repeat(30); measurePersistentStage();
    });
    await page.waitForFunction(() => elements.currentTitle.classList.contains('is-scrolling'));
    assert.equal(await page.locator('#current-title-text').evaluate(node => getComputedStyle(node).animationName), 'host-current-title-marquee');
  });

  test(`${name} ordinary user guidance stays neutral and drag deletion retains a stable target through snapshots`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page, host } = await open(t, engine);
    await page.locator('#work-rail-users').click();
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); });
    for (const theme of ['light', 'dark', 'blue']) {
      const colors = await page.evaluate(theme => {
        applyTheme(theme); state.sessionUserEditor.render({ ...state.data, session_user_entries: [] });
        const guidance = getComputedStyle(document.querySelector('.session-user-empty'));
        const queue = getComputedStyle(document.querySelector('.queue-empty'));
        return { guidance: guidance.color, queue: queue.color, weight: guidance.fontWeight };
      }, theme);
      assert.equal(colors.guidance, colors.queue, theme);
      assert.equal(colors.weight, '400');
    }
    await page.evaluate(() => state.sessionUserEditor.render(state.data));
    const drag = await page.evaluate(() => {
      const editor = state.sessionUserEditor;
      editor.beginDrag(editor.list.querySelector('.session-user-badge'));
      editor.render(state.data);
      const enabled = !editor.trash.disabled;
      const slot = editor.trash.closest('.session-user-trash-slot'), box = slot.getBoundingClientRect();
      const event = type => new DragEvent(type, { bubbles: true, dataTransfer: new DataTransfer(),
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
      editor.trash.dispatchEvent(event('dragover'));
      const highlighted = editor.trash.classList.contains('drag-over');
      editor.trash.dispatchEvent(new DragEvent('dragleave', { bubbles: true,
        relatedTarget: editor.trash.querySelector('path'), clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
      const staysHighlighted = editor.trash.classList.contains('drag-over');
      slot.dispatchEvent(new DragEvent('dragleave', { bubbles: true, clientX: box.right + 20, clientY: box.bottom + 20 }));
      const clearsOutside = !editor.trash.classList.contains('drag-over');
      editor.finishDrag();
      return { enabled, highlighted, staysHighlighted, clearsOutside, released: editor.trash.disabled };
    });
    assert.deepEqual(drag, { enabled: true, highlighted: true, staysHighlighted: true, clearsOutside: true, released: true });
    await page.locator('.session-user-badge').dragTo(page.locator('.session-user-trash-slot'));
    await page.waitForFunction(() => !state.sessionUserEditor.busy);
    assert.deepEqual((await host.api('/api/state')).session_users, [], 'Actual native drag/drop deletes only on drop');
    assert.equal(await page.evaluate(() => Boolean(state.sessionUserEditor.drag)), false);
  });
}

test('actual local-library HTTP search counts and renders unique videos across overlapping sources', {
  skip: nativeLimit, timeout: 60000,
}, async t => {
  const { page, home, host } = await open(t, chromium);
  const files = {
    'gatcha_uids.json': { schema_version: 2, uids: ['42'], profiles: {} },
    'gatcha_cache.json': { schema_version: 3, uids: { '42': [
      { bvid: 'BV1xx411c7mD', title: 'Song original' },
      { bvid: 'BV1z84y1p7oS', title: 'Song second' },
    ] }, profiles: {} },
    'gatcha_favlist.json': { schema_version: 2, items: [
      { bvid: 'BV1xx411c7mD', title: 'Song original', fav_uid: '42', fav_folder_id: '10' },
      { bvid: 'BV1xx411c7mD', title: 'Song original', fav_uid: '42', fav_folder_id: '20' },
      { bvid: 'BV0000000001', title: 'Song favorite' },
    ], folders: [] },
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(home, name), JSON.stringify(value), 'utf8');
  const first = await host.api('/api/gatcha/search?q=Song&limit=2'), second = await host.api('/api/gatcha/search?q=Song&limit=2&offset=2');
  assert.equal(first.matched_count, 3);
  assert.deepEqual(first.items.map(item => item.bvid), ['BV1xx411c7mD', 'BV1z84y1p7oS']);
  assert.deepEqual(second.items.map(item => item.bvid), ['BV0000000001']);
  assert.equal(second.has_more, false);
  await page.locator('#work-rail-request').click();
  await page.locator('[data-request-view="search"]').click();
  await page.locator('[data-search-mode="local"]').click();
  await page.locator('#search-query').fill('Song');
  await page.locator('#search-button').click();
  await page.waitForFunction(() => state.searchModeState.local.items.length === 3 && !state.searchModeState.local.loading);
  assert.deepEqual(await page.evaluate(() => state.searchModeState.local.items.map(item => item.bvid)), ['BV1xx411c7mD', 'BV1z84y1p7oS', 'BV0000000001']);
  assert.equal(await page.locator('#search-results .search-result-item').count(), 3);
});
