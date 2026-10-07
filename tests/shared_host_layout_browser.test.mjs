import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { chromium, webkit } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { buildNativeAlpha } from './native_runtime_artifacts.mjs';
import { RunningHost, isolatedEnvironment } from './native_host_support.mjs';

let alpha;
before(async () => {
  if (process.platform === 'linux') alpha = await buildNativeAlpha();
}, { timeout: 300000 });

test('actual shared Android layout releases desktop popup coordinates and keeps settings reachable', {
  skip: process.platform !== 'linux' && 'Linux WebKit browser layout; native Android/device evidence remains separate',
  timeout: 120000,
}, async t => {
  const directory = ownedDirectory('shared Android layout 中文 &');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = await RunningHost.start(alpha, directory,
    [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
  t.after(() => host.close());
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 900 }, hasTouch: true });
  await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
  await context.addInitScript(() => {
    localStorage.setItem('bilikara.update.automatic', 'false');
    window.BilikaraHostWindow = { postMessage(raw) {
      if (['enter', 'exit'].includes(raw)) return;
      const { id } = JSON.parse(raw);
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, ok: true, data: { layout: 'auto', orientation: 'system' } }) }));
    } };
  });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base);
  await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse && window.BilikaraHostLayout);
  await page.evaluate(() => { window.layoutNodes = ['cache-panel', 'cache-settings', 'cache-download-source-select'].map(id => document.getElementById(id)); });
  for (const width of [412, 390, 412]) {
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForFunction(() => !BilikaraHostLayout.isPortrait());
    await page.locator('#cache-settings-toggle').click();
    await page.waitForFunction(() => document.getElementById('cache-panel').style.position === 'fixed');
    await page.setViewportSize({ width, height: 850 });
    await page.waitForFunction(() => BilikaraHostLayout.isPortrait());
    await page.locator('[data-android-page="my"]').click();
    await page.locator('#android-open-settings').scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('cache-panel'), slot = document.getElementById('android-settings-slot');
      const button = document.getElementById('android-open-settings'), bounds = button.getBoundingClientRect();
      return { position: getComputedStyle(panel).position,
        contained: panel.getBoundingClientRect().bottom <= slot.getBoundingClientRect().bottom,
        reachable: button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
        same: layoutNodes.every(node => node === document.getElementById(node.id)),
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.deepEqual(geometry, { position: 'static', contained: true, reachable: true, same: true, overflow: false });
    await page.locator('#android-open-settings').click();
    await page.locator('#host-workspace-settings').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-android-orientation-mode]').count(), 0,
      'Phone settings follow system rotation instead of exposing a direction override');
  }
  assert.deepEqual(errors, []);
});

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`actual ${name} Remote identity gate and rename preserve keyboard ownership and pending work`, {
    skip: process.platform !== 'linux' && 'Linux browser interactions; native mobile devices remain separate',
    timeout: 60000,
  }, async t => {
    const directory = ownedDirectory('Remote identity keyboard 中文 &');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = await RunningHost.start(alpha, directory,
      [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
    t.after(() => host.close());
    await host.api('/api/session-users/add', { name: 'VZRXS' });
    const browser = await engine.launch({ headless: true });
    let page, release;
    t.after(async () => {
      release?.();
      if (page && !page.isClosed()) await page.unrouteAll({ behavior: 'wait' });
      await browser.close();
    });
    const context = await browser.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.base + '/remote');
    await page.waitForFunction(() => typeof state !== 'undefined' && state.data?.session_user_entries?.length === 1 && !state.remoteIdentityChecking);
    await page.locator('#remote-identity-input').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#remote-identity-modal').isVisible(), true, 'Registration is a non-dismissible entry gate');
    assert.equal(await page.evaluate(() => state.remoteIdentity.registered), false);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remote-identity-submit');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remote-identity-input');
    await page.evaluate(async () => applyRemoteIdentity(await apiPost('/api/remote-identity/register', { name: 'VZRXS', claim: true })));
    await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
    const userId = await page.evaluate(() => state.remoteIdentity.userId);
    await page.evaluate(() => openRemoteIdentityRename());
    await page.locator('#remote-identity-input').fill('Unsent draft');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remote-identity-submit');
    await page.keyboard.press('Escape');
    await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remote-identity-rename');
    assert.deepEqual((await host.api('/api/state')).session_users, ['VZRXS']);
    await page.evaluate(() => { openRemoteIdentityRename(); closeRemoteIdentityRename(); openRemoteIdentityRename(); });
    await page.locator('.remote-identity-card').evaluate(panel =>
      Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
    assert.equal(await page.locator('#remote-identity-modal').isVisible(), true, 'A closing callback must not hide a reopened form');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'remote-identity-input');
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/remote-identity/rename', async route => { await pending; await route.continue(); });
    await page.locator('#remote-identity-input').fill('Chorus');
    await page.locator('#remote-identity-submit').click();
    await page.waitForFunction(() => state.remoteIdentitySaving);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#remote-identity-modal').isVisible(), true, 'Escape must not abandon a pending rename');
    assert.equal(await page.locator('#remote-identity-submit').getAttribute('aria-busy'), 'true');
    release();
    await page.waitForFunction(() => state.remoteIdentity.name === 'Chorus');
    await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.remoteIdentity.userId), userId);
    assert.deepEqual((await host.api('/api/state')).session_users, ['Chorus']);
    assert.deepEqual(errors, []);
  });

  test(`actual ${name} Host popovers preserve compact bounds and ordinary field geometry`, {
    skip: process.platform !== 'linux' && 'Linux browser geometry; native platform windows remain separate',
    timeout: 60000,
  }, async t => {
    const directory = ownedDirectory('shared Host popovers 中文 &');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = await RunningHost.start(alpha, directory,
      [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
    t.after(() => host.close());
    await host.api('/api/session-users/add', { name: 'VZRXS' });
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addCookies([...host.cookies].map(([cookie, value]) => ({ name: cookie, value, url: host.base })));
    await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(host.base);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
    await page.locator('#work-rail-users').click();
    await page.locator('[data-mode="rename"]').click();
    await page.locator('.session-user-name').first().click();
    await page.locator('.session-user-rename-panel').evaluate(panel =>
      Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
    const rename = await page.locator('.session-user-rename-panel').evaluate(panel => {
      const rect = panel.getBoundingClientRect(), input = panel.querySelector('input');
      return { width: rect.width, height: rect.height, inputHeight: input.getBoundingClientRect().height,
        blur: getComputedStyle(panel).backdropFilter, font: getComputedStyle(input).fontSize };
    });
    assert.deepEqual({ width: rename.width, height: rename.height, inputHeight: rename.inputHeight, font: rename.font },
      { width: 320, height: 186, inputHeight: 44, font: '16px' });
    assert.match(rename.blur, /blur\(/);
    await page.keyboard.press('Escape');
    await page.locator('#cache-settings-toggle').click();
    for (const selector of ['#cache-quality-select', '#cache-download-source-select']) {
      assert.deepEqual(await page.locator(selector).evaluate(select => {
        const style = getComputedStyle(select);
        return { height: select.getBoundingClientRect().height, font: style.fontSize,
          weight: style.fontWeight, radius: style.borderRadius, appearance: style.appearance };
      }), { height: 34, font: '13px', weight: '700', radius: '999px', appearance: 'auto' });
    }
  });

  test(`actual ${name} user editor preserves motion, focus and layers through rapid reopening and navigation`, {
    skip: process.platform !== 'linux' && 'Linux browser interactions; native platform windows remain separate',
    timeout: 60000,
  }, async t => {
    const directory = ownedDirectory('user editor motion 中文 &');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = await RunningHost.start(alpha, directory,
      [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
    t.after(() => host.close());
    for (const name of ['VZRXS', 'kevin', '凛夜']) await host.api('/api/session-users/add', { name });
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addCookies([...host.cookies].map(([cookie, value]) => ({ name: cookie, value, url: host.base })));
    await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.base);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
    await page.locator('#work-rail-users').click();
    await page.locator('[data-mode="rename"]').click();
    await page.locator('.session-user-name').first().click();
    const opened = await page.locator('.session-user-rename-panel').evaluate(panel => ({
      animation: getComputedStyle(panel).animationName,
      duration: getComputedStyle(panel).animationDuration,
      popover: panel.matches(':popover-open'),
    }));
    assert.deepEqual(opened, { animation: 'scale-from-center-card', duration: '0.2s', popover: true });
    await page.locator('.session-user-rename-panel').evaluate(panel =>
      Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'session-user-rename-input');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('banner-close')), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.type), 'submit');
    const closing = await page.evaluate(() => {
      window.closingUserEditor = state.sessionUserEditor.editor.node;
      const before = { left: closingUserEditor.style.left, top: closingUserEditor.style.top };
      state.sessionUserEditor.closeEditor();
      return { connected: closingUserEditor.isConnected, inert: closingUserEditor.inert,
        animation: getComputedStyle(closingUserEditor).animationName,
        stationary: before.left === closingUserEditor.style.left && before.top === closingUserEditor.style.top };
    });
    assert.deepEqual(closing, { connected: true, inert: true, animation: 'scale-to-center-card', stationary: true });
    await page.locator('.session-user-name').nth(1).click();
    assert.equal(await page.locator('#session-user-rename-input').count(), 1);
    assert.equal(await page.locator('#session-user-rename-input').inputValue(), 'kevin');
    await page.waitForFunction(() => !closingUserEditor.isConnected);
    assert.equal(await page.evaluate(() => state.sessionUserEditor.editor.node.isConnected), true);
    await page.setViewportSize({ width: 700, height: 480 });
    await page.waitForFunction(() => document.querySelector('.app-shell').dataset.narrowToolLayout === 'overlay');
    assert.equal(await page.evaluate(() => state.sessionUserEditor.editor?.input.value), 'kevin');
    assert.equal(await page.locator('#session-user-rename-input').isVisible(), true);
    await page.locator('#work-rail-queue').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !state.sessionUserEditor.editor);
    await page.locator('.session-user-rename-panel').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 700, height: 480 });
    await page.locator('#work-rail-users').click();
    if (await page.locator('[data-mode="rename"]').getAttribute('aria-pressed') !== 'true') {
      await page.locator('[data-mode="rename"]').click();
    }
    await page.locator('.session-user-name').last().click();
    await page.locator('.session-user-rename-panel').evaluate(panel =>
      Promise.allSettled(panel.getAnimations().map(animation => animation.finished)));
    const layer = await page.locator('.session-user-rename-panel').evaluate(panel => {
      const r = panel.getBoundingClientRect();
      return { inside: r.left >= 12 && r.top >= 12 && r.right <= innerWidth - 12 && r.bottom <= innerHeight - 12,
        hit: panel.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    assert.deepEqual(layer, { inside: true, hit: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.session-user-rename-panel').evaluate(panel => getComputedStyle(panel).animationDuration), '0.001s');
    await page.keyboard.press('Escape');
    await page.locator('.session-user-rename-panel').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.session-user-name').first().click();
    await page.locator('#cache-settings-toggle').click();
    await page.locator('#cache-panel').waitFor({ state: 'visible' });
    // Menu anchoring is coalesced in a render frame. Measure after that owner
    // has positioned the surface, rather than its transient hidden geometry.
    await page.waitForFunction(() => state.topControlPopoverPositionFrame === null);
    assert.equal(await page.evaluate(() => state.sessionUserEditor.editor), null);
    const menuLayer = await page.locator('#cache-panel').evaluate(panel => {
      const r = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { reachable: panel.contains(hit), bounds: r.toJSON(), hit: hit?.id || hit?.className,
        position: panel.style.position, left: panel.style.left, top: panel.style.top };
    });
    assert.equal(menuLayer.reachable, true,
      `The retiring top-layer editor must not cover the newly opened runtime menu: ${JSON.stringify(menuLayer)}`);
    await page.locator('.session-user-rename-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  });
}
