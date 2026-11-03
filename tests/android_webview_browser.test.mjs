import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { chromium } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { buildNativeAlpha } from './native_runtime_artifacts.mjs';
import { RunningHost, isolatedEnvironment } from './native_host_support.mjs';

// Linux browser + actual isolated shared Rust Host; never Android device acceptance.
// Optional historic executable is explicit, never downloaded by the test.
const executablePath = process.env.BILIKARA_TEST_WEBVIEW_CHROMIUM;
const legacyMode = process.env.BILIKARA_TEST_WEBVIEW_MODE === "legacy";
const evidence = process.env.BILIKARA_TEST_SCREENSHOT_DIR;
let binary;
before(async () => { binary = await buildNativeAlpha(); }, { timeout: 300000 });

for (const missingTimeout of [true, false]) test(`Host startup, LAN QR, fixture public room and recovery in ${legacyMode ? "legacy" : "latest"} (timeout API ${missingTimeout ? 'absent' : 'unchanged'})`, {
  timeout: 90000,
}, async t => {
  const home = mkdtempSync(path.join(root, '.tmp/webview-compat-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const host = await RunningHost.start(binary, home, [home, path.join(root, 'static')], isolatedEnvironment(home), true);
  t.after(() => host.close());
  await host.api('/api/session-users/add', { name: 'Fixture singer' });
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-background-networking'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 700, height: 800 } });
  await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
  await context.addInitScript(({ missingTimeout, legacyMode }) => {
    if (legacyMode) {
      Object.defineProperty(Object, "hasOwn", {configurable: true, value: undefined});
      Object.defineProperty(Array.prototype, "at", {configurable: true, value: undefined});
      Object.defineProperty(crypto, "randomUUID", {configurable: true, value: undefined});
      delete HTMLElement.prototype.inert;
    }
    if (missingTimeout) Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
    localStorage.setItem('bilikara.update.automatic', 'false');
    // Socket lifecycle fixture: no production WebSocket, ICE or TURN traffic.
    window.WebSocket = class extends EventTarget {
      constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() { this.readyState = 3; }
      send() {}
    };
    const active = new Set(), originalSet = window.setTimeout, originalClear = window.clearTimeout;
    window.setTimeout = function (fn, ms, ...args) {
      let id; id = originalSet(() => { active.delete(id); fn(...args); }, ms);
      if ([10000, 15000].includes(ms)) active.add(id);
      return id;
    };
    window.clearTimeout = function (id) { active.delete(id); return originalClear(id); };
    window.issue117Deadlines = active;
  }, { missingTimeout, legacyMode });
  let stateFailure = false, roomFailure = false, creates = 0, qrRequests = 0;
  const errors = [], external = [], consoleMessages = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://rtc.kevinx96.icu' && url.pathname.startsWith('/v1/rooms')) {
      if (route.request().method() === 'POST') {
        creates++;
        const input = route.request().postDataJSON();
        assert.equal(input.lifetime_hours, 12);
        assert.match(input.host_token_hash, /^[A-Za-z0-9_-]{43}$/);
        assert.match(input.join_token_hash, /^[A-Za-z0-9_-]{43}$/);
        const now = Date.now();
        return route.fulfill({ status: roomFailure ? 503 : 200, json: roomFailure ? { error: 'isolated signaling fixture unavailable' }
          : { room_id: 'r'.repeat(27), created_at: now, expires_at: now + 12 * 3600000 } });
      }
      return route.fulfill({ status: 200, json: { ok: true } });
    }
    if (url.origin !== host.base) { external.push(url.origin); return route.abort(); }
    if (url.pathname === '/api/state' && stateFailure) return route.abort();
    if (url.pathname === '/api/internet-remote/qr') qrRequests++;
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (['error', 'warning'].includes(message.type()) && consoleMessages.length < 30)
      consoleMessages.push(message.text().replace(/https?:\/\/\S+/gu, '[fixture URL]').slice(0, 250));
  });
  await page.goto(legacyMode ? host.bootstrapUrl + "?webviewMode=legacy" : host.base);
  await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
  assert.equal(await page.title(), 'bilikara host');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.webviewMode), legacyMode ? 'legacy' : 'latest');
  assert.match(await page.locator('body').innerText(), /bilikara/);
  const facts = await page.evaluate(() => ({ ua: navigator.userAgent, timeout: typeof AbortSignal.timeout,
    hasOwn: typeof Object.hasOwn, at: typeof Array.prototype.at, platform: document.documentElement.dataset.hostPlatform }));
  if (missingTimeout) assert.equal(facts.timeout, 'undefined');
  await page.waitForFunction(() => document.querySelector('#remote-mini-qr-image').naturalWidth > 0);
  await page.locator('#remote-mini-trigger').click();
  await page.waitForFunction(() => document.querySelector('#remote-popover-qr-image').naturalWidth > 0);
  assert.match(await page.locator('#remote-popover-url-link').getAttribute('href'), /^http:\/\//);
  async function shot(label) {
    if (!evidence) return;
    mkdirSync(evidence, { recursive: true });
    // Only this disposable fixture's password/QR is displayed; no user records.
    await page.screenshot({ path: path.join(evidence, `${missingTimeout ? 'missing' : 'normal'}-${label}.png`) });
  }
  await shot('lan-qr');
  if (!await page.locator('#internet-remote-password').isVisible()) await page.locator('#internet-remote-disclosure').click();
  await page.locator('#internet-remote-password').fill('117fixture');
  await page.locator('#internet-remote-restart').click();
  await page.waitForFunction(() => document.querySelector('#internet-remote-qr').naturalWidth > 0);
  assert.equal(creates, 1); assert.equal(qrRequests, 1);
  assert.equal(await page.locator('#internet-remote-restart').getAttribute('aria-busy'), null);
  await page.waitForFunction(() => issue117Deadlines.size === 0);
  await shot('public-qr');
  await page.locator('#internet-remote-stop').click();
  await page.waitForFunction(() => document.querySelector('#internet-remote-stop').classList.contains('hidden'));
  roomFailure = true;
  await page.locator('#internet-remote-restart').click();
  await page.waitForFunction(() => document.querySelector('#internet-remote-status').textContent.includes('503'));
  assert.equal(await page.locator('#internet-remote-restart').isEnabled(), true);
  roomFailure = false;
  await page.locator('#internet-remote-restart').click();
  await page.waitForFunction(() => document.querySelector('#internet-remote-qr').naturalWidth > 0);
  assert.equal(creates, 3); assert.equal(qrRequests, 2);
  await page.locator('#internet-remote-stop').click();
  // Exercise the same state-failure/recovery path used by polling, without
  // changing production intervals or replacing the state authority.
  stateFailure = true;
  const failure = await page.evaluate(async () => { try { await fetchState(); return ''; } catch (e) { return e.name; } });
  assert.equal(failure, 'TypeError');
  assert.equal(await page.evaluate(() => state.remoteAccessFailure.kind), 'network');
  stateFailure = false;
  await page.evaluate(() => fetchState());
  await page.waitForFunction(() => state.remoteAccessFailure === null && issue117Deadlines.size === 0);
  await page.keyboard.press('Escape');
  await page.locator('#work-rail-request').click();
  await page.waitForFunction(() => state.activeHostWorkspace === 'request');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-android-page="queue"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.hostPage === 'queue');
  await page.locator('[data-android-page="request"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.hostPage === 'request');
  await shot('phone-navigation');
  // Normal local Remote uses the same real Host and no Host authentication cookie.
  const remote = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await remote.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const remotePage = await remote.newPage(); remotePage.on('pageerror', error => errors.push(error.message));
  await remotePage.goto(host.base + '/remote');
  await remotePage.waitForFunction(() => typeof state !== 'undefined' && !!state.data);
  assert.equal(await remotePage.title(), 'bilikara remote');
  assert.deepEqual(errors, []);
  assert.ok(consoleMessages.every(message => /^Failed to load resource: (?:the server responded with a status of 503|net::ERR_FAILED)/u.test(message)),
    JSON.stringify(consoleMessages)); // Only the two intentional failure fixtures.
  assert.deepEqual(external, [], 'no external asset/service request should escape the fixture');
  if (evidence) writeFileSync(path.join(evidence, `${missingTimeout ? 'missing' : 'normal'}-facts.json`), JSON.stringify({ browser: browser.version(), facts, creates, qrRequests, errors, external, consoleMessages }, null, 2));
});
