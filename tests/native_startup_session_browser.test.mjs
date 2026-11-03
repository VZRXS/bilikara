import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { buildNativeAlpha, buildNativeHost } from './native_runtime_artifacts.mjs';
import { HttpClient, RunningHost, isolatedEnvironment } from './native_host_support.mjs';

const evidence = process.env.BILIKARA_TEST_SCREENSHOT_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

async function appearance(button) {
  return button.evaluate(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, font: style.fontSize,
      weight: style.fontWeight, radius: style.borderRadius, transform: style.transform,
      background: style.backgroundColor, color: style.color, border: style.borderColor,
      transition: style.transitionDuration, outline: style.outlineWidth };
  });
}

async function settleFeedback(button) {
  await button.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
}

for (const android of [false, true]) test(`pending native session keeps settings and LAN access responsive (${android ? 'Android layout' : 'desktop'})`, {
  skip: process.platform !== 'linux' && 'Linux Chromium/native Host fixture; native WebView qualification remains separate',
  timeout: 120000,
}, async () => {
  const name = android ? 'android' : 'desktop';
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-session-startup-'));
  const data = path.join(home, 'data');
  mkdirSync(data);
  // Empty native library defaults prevent first-run catalog/provider bootstrap.
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  writeFileSync(path.join(data, 'native-library-defaults.json'), '{"schema_version":1}');
  writeFileSync(path.join(data, 'gatcha_uids.json'), '{"schema_version":2,"uids":[],"profiles":{}}');
  const executable = android
    ? process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha()
    : process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
  const args = android ? [data, path.join(root, 'static')]
    : ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')];
  let host, browser, context, page, passed = false, holdChoice, releaseChoice;
  const report = { name, backend: [], externalBlocked: [], pageErrors: [], console: [],
    choices: [], logins: [], geometry: [], screenshots: [] };
  const start = () => RunningHost.start(executable, home, args, isolatedEnvironment(home), android);
  async function shot(label) {
    if (!evidence) return;
    const file = path.join(evidence, `session-${name}-${label}.png`);
    await page.screenshot({ path: file, mask: [page.locator('#internet-remote-password')] });
    report.screenshots.push(path.basename(file));
  }
  try {
    host = await start();
    assert.equal((await host.api('/api/state')).session_flags.startup_choice_pending, false);
    await host.api('/api/session-users/add', { name: 'Saved singer' });
    await host.close(); host = await start();
    const snapshot = await host.api('/api/state');
    assert.equal(snapshot.session_flags.startup_choice_pending, true);
    assert.deepEqual(snapshot.session_users, ['Saved singer']);
    // These are real concurrent HTTP requests while the authoritative choice is pending.
    await Promise.all(['/api/state', '/api/remote-access', '/api/played-sessions', '/api/diagnostics/native'].map(async route => {
      const started = performance.now(), response = await host.request(route);
      report.backend.push({ route, status: response.status, ms: Math.round(performance.now() - started) });
      assert.equal(response.status, 200, `${route} remains available before the session choice`);
    }));
    const denied = await host.request('/api/session-users/add', { name: 'Must stay blocked' });
    assert.equal(denied.status, 409); assert.equal(JSON.parse(denied.body).code, 'session_choice_pending');
    const remote = new HttpClient(host.base); await remote.request('/remote');
    assert.equal((await remote.request('/api/session/startup-choice', { choice: 'new' })).status, 403);

    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
    context = await browser.newContext({ viewport: android ? { width: 360, height: 800 } : { width: 1280, height: 800 },
      hasTouch: android, locale: 'zh-CN' });
    await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
    await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
    if (android) await context.addInitScript(() => {
      // Native Android window messaging contract only; all HTTP/state remains Rust.
      window.BilikaraHostWindow = { postMessage(raw) {
        if (['enter', 'exit'].includes(raw)) return;
        const { id } = JSON.parse(raw);
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, ok: true, data: { layout: 'auto', orientation: 'system' } }) }));
      } };
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== host.base) { report.externalBlocked.push(url.origin); return route.abort(); }
      if (url.pathname === '/api/bbdown/login/start') {
        report.logins.push({ pending: (await host.api('/api/state')).session_flags.startup_choice_pending });
        // Provider errors are a local contract fixture, never a real login/provider call.
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Local login fixture unavailable' }) });
      }
      if (url.pathname === '/api/session/startup-choice') {
        report.choices.push(route.request().postDataJSON());
        if (holdChoice) await holdChoice;
      }
      return route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type()) && report.console.length < 30)
        report.console.push({ type: message.type(), text: message.text().slice(0, 250) });
    });
    await page.goto(host.base);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
    assert.equal(await page.title(), 'bilikara host');
    assert.equal(new URL(page.url()).origin, host.base);
    assert.match(await page.locator('body').innerText(), /bilikara/);
    const banner = page.locator('#native-session-choice'); await banner.waitFor({ state: 'visible' });
    // A real keyboard focus pauses the existing countdown without changing its state.
    const accept = page.locator('[data-session-choice="continue"]'), dismiss = page.locator('#native-session-dismiss');
    if (android) {
      await page.evaluate(() => document.activeElement?.blur());
      await banner.hover();
      await page.evaluate(() => window.BilikaraNativeSession.syncSessionChoice());
      assert.equal(await dismiss.evaluate(node => node.classList.contains('is-close-glyph')), false,
        'a touch browser sticky hover must not pause the startup countdown');
      await accept.focus();
      assert.equal(await dismiss.evaluate(node => node.classList.contains('is-close-glyph')), true,
        'explicit focus still pauses the startup countdown');
    }
    async function pauseChoice() { await accept.focus(); await banner.hover(); }
    await accept.focus();
    if (android) await page.locator('[data-android-page="my"]').click();
    else await page.locator('#cache-settings-toggle').click();
    // Keep focus inside the banner while inspecting the independently open settings.
    await pauseChoice();
    report.controls = await page.evaluate(() => ({
      quality: Array.from(document.querySelector('#cache-quality-select').options, option => option.value),
      sources: Array.from(document.querySelector('#cache-download-source-select').options, option => option.value),
      qr: document.querySelector('#remote-mini-qr-image').naturalWidth,
      pending: state.data.session_flags.startup_choice_pending,
    }));
    await shot('settings-pending');
    assert.deepEqual(report.controls.quality, snapshot.cache_policy.video_quality_choices.map(choice => typeof choice === 'string' ? choice : choice.value));
    assert.deepEqual(report.controls.sources, snapshot.cache_policy.download_source_choices.map(choice => typeof choice === 'string' ? choice : choice.value));
    assert.ok(await page.locator('#cache-quality-select').isVisible(), 'Runtime settings are actually visible');
    assert.ok(await page.locator('#cache-download-source-select').isVisible());
    assert.deepEqual(report.logins, [], 'Pending choice must not start automatic Bilibili login');

    const access = await host.api('/api/remote-access');
    // A shareable LAN interface is required to exercise the native QR path.
    assert.ok(access.lan_urls.length, 'LAN QR fixture requires a non-loopback interface in the owned test network');
    assert.match(access.qr_image, /^data:image\/svg\+xml;base64,/);
    await page.waitForFunction(() => document.querySelector('#remote-mini-qr-image').naturalWidth > 0);
    if (android) await page.locator('[data-android-page="playback"]').click();
    else await page.locator('#cache-settings-toggle').click();
    const qrTrigger = page.locator('#remote-mini-trigger');
    // The centered startup banner can overlap the left edge of the desktop
    // phone trigger. Use its exposed right edge, without force-clicking through it.
    const triggerBounds = await qrTrigger.boundingBox();
    await qrTrigger.click({ position: { x: triggerBounds.width - 8, y: triggerBounds.height / 2 } });
    // On phones the open QR card covers the banner's center. Keyboard focus
    // still pauses the countdown; do not force a pointer through the card.
    await accept.focus();
    await page.waitForFunction(() => document.querySelector('#remote-popover-qr-image').naturalWidth > 0);
    await shot('qr-pending');
    if (android) await page.locator('[data-android-page="my"]').click();
    else await page.keyboard.press('Escape');
    await pauseChoice();

    const before = await appearance(accept), close = await appearance(dismiss);
    report.geometry.push({ before, close });
    assert.equal(before.height, 44); assert.equal(before.font, '16px');
    assert.equal(before.radius, '14px'); assert.equal(before.weight, '400');
    assert.equal(close.width, 32); assert.equal(close.height, 32);
    for (const size of android ? [{ width: 320, height: 640 }, { width: 360, height: 1000 }]
      : [{ width: 700, height: 600 }]) {
      await page.setViewportSize(size); await pauseChoice();
      assert.equal((await appearance(dismiss)).width, 32);
      assert.equal((await appearance(accept)).height, 44);
      assert.ok(await banner.isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
      await shot(`${size.width}x${size.height}`);
    }
    if (!android) {
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const theme of ['light', 'dark', 'blue']) {
        await page.locator('#work-rail-settings').click();
        await page.locator(`button[data-theme="${theme}"]`).click();
        await accept.focus(); await page.mouse.move(10, 10); await settleFeedback(accept);
        const normal = await appearance(accept);
        await accept.hover(); await settleFeedback(accept); const hover = await appearance(accept);
        assert.equal(hover.transform, 'matrix(1, 0, 0, 1, 0, -1)');
        assert.notEqual(hover.background, normal.background); assert.notEqual(hover.border, normal.border);
        await page.mouse.down(); await settleFeedback(accept);
        assert.equal((await appearance(accept)).transform, 'none');
        // Release outside the button: test pressed feedback without accepting the choice.
        await page.mouse.move(10, 10); await page.mouse.up();
        await settleFeedback(dismiss); const closeNormal = await appearance(dismiss);
        await dismiss.hover(); await settleFeedback(dismiss); const closeHover = await appearance(dismiss);
        assert.equal(closeHover.transform, 'none'); assert.equal(closeHover.width, closeNormal.width);
        assert.notEqual(closeHover.background, closeNormal.background); assert.notEqual(closeHover.color, closeNormal.color);
        report.geometry.push({ theme, normal, hover, closeNormal, closeHover });
        await shot(`${theme}-controls`);
      }
      await page.keyboard.press('Tab'); await accept.focus();
      assert.equal((await appearance(accept)).outline, '2px');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal((await appearance(accept)).transition, '0s');
    assert.equal((await appearance(dismiss)).transition, '0s');
    const countdown = await dismiss.locator('[data-session-countdown]').textContent();
    await accept.focus();
    for (let i = 0; i < 3; i++) await page.evaluate(() => fetchState());
    assert.equal(await dismiss.locator('[data-session-countdown]').textContent(), countdown, 'State updates do not reset the paused timer');

    holdChoice = new Promise(resolve => { releaseChoice = resolve; });
    await accept.click();
    await page.waitForFunction(() => document.querySelector('[data-session-choice="continue"]').getAttribute('aria-busy') === 'true');
    assert.ok(await accept.isDisabled()); assert.ok(await dismiss.isDisabled());
    await page.evaluate(() => document.querySelector('[data-session-choice="continue"]').click());
    assert.equal(report.choices.length, 1, 'Pending action rejects duplicate activation');
    releaseChoice(); holdChoice = null;
    await page.waitForFunction(() => !state.data.session_flags.startup_choice_pending);
    await banner.waitFor({ state: 'hidden' });
    assert.deepEqual((await host.api('/api/state')).session_users, ['Saved singer']);
    assert.equal(await accept.getAttribute('aria-busy'), null);
    assert.equal(report.choices.length, 1);
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bbdown/login/start');
    if (android) await page.locator('#bbdown-login-button').click();
    else await page.locator('#cache-settings-toggle').click();
    assert.equal((await loginResponse).status(), 503, 'Only the deliberately local provider-error fixture is used');
    await page.waitForFunction(() => !state.bbdownLoginRequesting);
    assert.ok(report.logins.length > 0, 'The regular login workflow resumes after the choice');
    assert.ok(report.logins.every(call => !call.pending));
    await host.api('/api/session-users/add', { name: 'New singer' });
    await host.api('/api/session/startup-choice', { choice: 'new' });
    assert.deepEqual((await host.api('/api/state')).session_users, ['Saved singer', 'New singer'],
      'Resolved startup commands cannot overwrite a now usable session');
    assert.deepEqual(report.externalBlocked, []); assert.deepEqual(report.pageErrors, []);
    // Only the deliberately failed local login response may produce an HTTP console error.
    assert.ok(report.console.every(entry => entry.text.includes('503') || entry.text.includes('Local login fixture unavailable')),
      JSON.stringify(report.console));
    passed = true;
  } finally {
    releaseChoice?.();
    if (page && !page.isClosed() && !passed) await shot('failure').catch(() => {});
    if (browser) await browser.close();
    if (host) await host.close();
    if (evidence) writeFileSync(path.join(evidence, `session-${name}-report.json`), JSON.stringify({ passed, ...report,
      coverage: 'Actual Rust Host, persisted session, Chromium and native SVG QR. Android OS messaging contract fixture; no physical native WebView.' }, null, 2));
    if (passed) rmSync(home, { recursive: true, force: true });
  }
});
