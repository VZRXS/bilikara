import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
}
