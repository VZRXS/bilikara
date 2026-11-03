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
  if (process.platform === 'linux') alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
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
    for (const name of ['playback', 'queue', 'request', 'users', 'my']) {
      await page.locator(`[data-android-page="${name}"]`).click();
      const selected = await page.evaluate(() => {
        const current = document.querySelectorAll('#android-host-dock [aria-current="page"]');
        const button = current[0], bounds = button.getBoundingClientRect();
        return { count: current.length, name: button.dataset.androidPage,
          filled: getComputedStyle(button.querySelector('.work-rail-icon-fill')).display !== 'none',
          visible: bounds.height >= 44 && bounds.x >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1 };
      });
      assert.deepEqual(selected, { count: 1, name, filled: true, visible: true });
      if (name === 'queue') assert.equal(await page.locator('#android-queue-tabs').evaluate(n => n.getBoundingClientRect().height), 48);
    }
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

test('Android headings precede tabs and tools keep their compact roles across page and layout switches', {
  skip: process.platform !== 'linux' && 'Browser layout fixture; actual Android evidence is recorded separately',
  timeout: 90000,
}, async t => {
  const directory = ownedDirectory('Android hierarchy and tool roles');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = await RunningHost.start(alpha, directory,
    [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
  t.after(() => host.close());
  const browser = await chromium.launch({ headless: true });
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
  await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base);
  await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse && window.BilikaraHostLayout);
  await page.evaluate(() => {
    setLanguage('zh');
    window.originalHeadings = ['queue', 'history', 'request'].map(name => {
      const title = document.getElementById('workspace-' + name + '-heading');
      return { title, heading: title.parentElement, parent: title.parentElement.parentElement };
    });
    window.originalMedia = [...document.querySelectorAll('video, audio')];
    window.originalAccount = ['host-account-settings', 'bbdown-status-row', 'bbdown-login-panel'].map(id => {
      const node = document.getElementById(id);
      return { node, parent: node.parentElement };
    });
  });
  for (const width of [320, 412]) {
    await page.setViewportSize({ width, height: 850 });
    for (const [route, tab] of [['queue', 'android-queue-tabs'], ['request', 'android-request-tabs']]) {
      await page.locator('[data-android-page="' + route + '"]').click();
      assert.equal(await page.locator('#android-page-heading h2').isVisible(), true);
      const heading = await page.locator('#android-page-heading').boundingBox();
      const tabs = await page.locator('#' + tab).boundingBox();
      assert.ok(heading.y + heading.height <= tabs.y + 1, 'Shared title must precede segmented navigation');
      if (route === 'request') {
        assert.equal(await page.locator('.request-workspace-head').isVisible(), false,
          'Moving the heading and tabs must not leave an empty title row or separator');
        const footer = await page.locator('.native-alpha-notice').boundingBox();
        const panel = await page.locator('#request-quick-panel').boundingBox();
        const form = await page.locator('#add-form').boundingBox();
        assert.ok(Math.abs(panel.x + panel.width - footer.x - footer.width - 14) < 1 &&
          Math.abs(panel.y + panel.height - footer.y - footer.height - 14) < 1 &&
          footer.y >= form.y + form.height, 'Preview badge stays at the bottom right, clear of the form');
        assert.deepEqual(await page.evaluate(() => {
          const label = document.querySelector('.native-alpha-notice > [data-i18n]');
          const form = document.getElementById('add-form'), before = form.getBoundingClientRect();
          const text = label.textContent; label.textContent = text.repeat(20);
          const after = form.getBoundingClientRect(); label.textContent = text;
          return [after.x - before.x, after.y - before.y, after.width - before.width, after.height - before.height];
        }), [0, 0, 0, 0], 'Changing preview copy must not move the request form');
        assert.equal(await page.locator('#android-preview-help').count(), 0);
        assert.equal(await page.locator('.native-alpha-notice > span').last().textContent(),
          await page.evaluate(() => t('mobile.betaNotice')), 'Short preview guidance stays expanded');
      }
    }
    await page.locator('[data-android-page="queue"]').click();
    await page.locator('[data-android-workspace="history"]').click();
    assert.equal(await page.locator('#android-page-heading #workspace-history-heading').isVisible(), true);
    assert.equal(await page.locator('#android-page-heading #history-export-button').isVisible(), true);
    const headerAlignment = await page.evaluate(() => {
      const head = document.getElementById('android-page-heading');
      const actions = head.querySelector('.queue-toolbar').getBoundingClientRect(), row = head.getBoundingClientRect();
      return {right: row.right - actions.right, top: Math.abs(row.y - actions.y)};
    });
    assert.ok(headerAlignment.right < 1 && headerAlignment.top < 1, 'History actions align with the whole bilingual heading at its top-right edge');
    await page.locator('[data-android-page="users"]').click();
    assert.equal(await page.locator('.session-user-prerequisite').textContent(), await page.evaluate(() => t('session.empty')));
    assert.equal(await page.locator('.session-user-guidance').textContent(), await page.evaluate(() => t('session.help')));
    assert.equal(await page.locator('[aria-describedby="session-users-help"]').count(), 0);
    await page.locator('[data-android-page="my"]').click();
    assert.equal(await page.locator('#android-page-heading .section-tag').textContent(), 'My Page');
    const login = await page.locator('#bbdown-login-button').boundingBox();
    assert.equal(login.height, 30, 'Login status retains compact tool geometry');
    const account = await page.evaluate(() => {
      const heading = document.getElementById('android-account-title').getBoundingClientRect();
      const row = document.getElementById('android-account-heading').getBoundingClientRect();
      const badge = document.getElementById('bbdown-login-button').getBoundingClientRect();
      return { centerDelta: Math.abs(heading.y + heading.height / 2 - badge.y - badge.height / 2),
        rightInset: row.right - badge.right,
        separate: document.getElementById('android-account-slot').closest('.android-my-card') !==
          document.getElementById('android-settings-slot').closest('.android-my-card') };
    });
    assert.ok(account.centerDelta < 1 && account.rightInset < 1 && account.separate,
      'Login aligns with its heading in a separate account card');
    assert.deepEqual(await page.locator('#android-open-settings').evaluate(button => {
      const style = getComputedStyle(button);
      return [style.fontSize, style.fontWeight, button.getBoundingClientRect().height >= 44];
    }), ['16px', '700', true], 'Settings entry uses subheading type with a full touch target');
    for (const id of ['cache-limit-slider', 'advance-delay-slider']) {
      const slider = await page.locator('#' + id).evaluate(input => {
        const bounds = input.getBoundingClientRect();
        const header = input.closest('.cache-double-col').querySelector('.cache-double-header').getBoundingClientRect();
        return { gap: bounds.top - header.bottom, height: bounds.height };
      });
      assert.ok(slider.gap >= 0 && slider.gap <= 4 && slider.height >= 32,
        id + ' removes stacked spacing while retaining range touch height');
    }
    for (const theme of ['light', 'dark', 'blue']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await page.locator('#android-host-dock').evaluate(async node => {
        getComputedStyle(node.querySelector('[aria-current]')).backgroundColor;
        await new Promise(requestAnimationFrame);
        await Promise.allSettled(node.getAnimations({ subtree: true }).map(animation => animation.finished));
      });
      const colors = await page.evaluate(() => {
        const current = getComputedStyle(document.querySelector('#android-host-dock [aria-current]'), '::before');
        const sample = document.createElement('span'); sample.style.backgroundColor = 'var(--accent)'; document.body.append(sample);
        const accent = getComputedStyle(sample).backgroundColor; sample.remove();
        return { background: current.backgroundColor, accent };
      });
      assert.equal(colors.background, colors.accent, theme + ' selected navigation uses theme accent');
    }
    await page.locator('#android-open-settings').click();
    for (const id of ['diagnostic-copy-button']) {
      assert.equal((await page.locator('#' + id).boundingBox()).height, 30, id + ' is a compact settings tool');
    }
    await page.locator('[data-android-page="playback"]').click();
    assert.equal(await page.locator('#presentation-settings').evaluate(n => Boolean(n.closest('.topbar'))), true);
    assert.equal((await page.locator('#presentation-settings-toggle').boundingBox()).height, 44);
    assert.equal((await page.locator('#presentation-settings-toggle').boundingBox()).width, 60);
    assert.equal((await page.locator('#remote-mini-trigger').boundingBox()).width, 44);
    await page.locator('#presentation-settings-toggle').click();
    assert.equal(await page.locator('#presentation-settings-toggle').getAttribute('aria-expanded'), 'true');
    const displayMenu = await page.locator('#presentation-settings-panel').boundingBox();
    assert.ok(displayMenu.x >= 0 && displayMenu.x + displayMenu.width <= width + 1);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForFunction(() => !BilikaraHostLayout.isPortrait());
    assert.equal(await page.locator('#history-export-button').evaluate(n => Boolean(n.closest('.queue-card-head'))), true, 'Return the same actions to the desktop header');
    assert.equal(await page.evaluate(() => originalHeadings.every(({ title, heading, parent }) =>
      title.parentElement === heading && heading.parentElement === parent)), true, 'Restore the exact desktop heading nodes');
    assert.equal(await page.evaluate(() => originalAccount.every(({ node, parent }) =>
      node === document.getElementById(node.id) && node.parentElement === parent)), true,
      'Restore the exact desktop account, status and QR panel nodes');
  }
  assert.equal(await page.evaluate(() => originalMedia.every(node => node.isConnected && [...document.querySelectorAll('video, audio')].includes(node))), true);
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
