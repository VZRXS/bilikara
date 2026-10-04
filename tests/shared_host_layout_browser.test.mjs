import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { webkit } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { buildNativeAlpha } from './native_runtime_artifacts.mjs';
import { RunningHost, isolatedEnvironment } from './native_host_support.mjs';

test('actual shared Android layout releases desktop popup coordinates and keeps settings reachable', {
  skip: process.platform !== 'linux' && 'Linux WebKit browser layout; native Android/device evidence remains separate',
  timeout: 120000,
}, async t => {
  const directory = ownedDirectory('shared Android layout 中文 &');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const host = await RunningHost.start(await buildNativeAlpha(), directory,
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
  }
  assert.deepEqual(errors, []);
});
