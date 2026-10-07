import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import { chromium } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { buildNativeHost, buildNativeAlpha } from './native_runtime_artifacts.mjs';
import { RunningHost, HttpClient, isolatedEnvironment, waitFor } from './native_host_support.mjs';

let executable, androidHost;
before(async () => { executable = await buildNativeHost(); androidHost = await buildNativeAlpha(); }, { timeout: 300000 });
async function fixture(t, android = false) {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-source-removal-'));
  const data = path.join(home, 'data'); mkdirSync(data);
  let host;
  t.after(async () => {
    try { if (host) await host.close(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  const save = (file, value) => writeFileSync(path.join(data, file), JSON.stringify(value));
  save('native-library-defaults.json', { schema_version: 1 });
  save('gatcha_uids.json', { schema_version: 2, uids: ['42', '43'], profiles: { '42': { name: '本地 UP One' }, '43': { name: 'Keep Two' } } });
  save('gatcha_cache.json', { schema_version: 3, uids: { '42': [{ bvid: 'BV1z84y1p7oS', title: 'Shared song' }], '43': [{ bvid: 'BV1z84y1p7oS', title: 'Shared song' }] } });
  save('gatcha_favlist.json', { schema_version: 2, uids: ['42'], folders: [{ uid: '42', id: '10', title: 'My collection' }, { uid: '42', id: '11', title: 'Keep collection' }], items: [{ bvid: 'BV1z84y1p7oS', fav_uid: '42', fav_folder_id: '10' }, { bvid: 'BV1z84y1p7oS', fav_uid: '42', fav_folder_id: '11' }] });
  host = await RunningHost.start(android ? androidHost : executable, home,
    android ? [data, path.join(root, 'static')] : ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')],
    isolatedEnvironment(home), android);
  return { host, data };
}

test('native local removal requires identity, never calls providers, and preserves sibling sources', { timeout: 60000 }, async t => {
  const { host, data } = await fixture(t);
  const guest = new HttpClient(host.base);
  await guest.request('/remote');
  assert.ok((await guest.request('/api/gatcha/source/remove', { source: 'uid', id: '42' })).status >= 400);
  const files = ['gatcha_uids.json', 'gatcha_cache.json', 'gatcha_favlist.json'];
  const before = files.map(file => readFileSync(path.join(data, file), 'utf8'));
  assert.equal((await host.request('/api/gatcha/source/remove', { source: 'd1', id: '42' })).status, 400);
  assert.deepEqual(files.map(file => readFileSync(path.join(data, file), 'utf8')), before);
  // No cookie, no provider, all external traffic is blocked in isolatedEnvironment.
  const result = await host.api('/api/gatcha/source/remove', { source: 'uid', id: '42' });
  assert.equal(result.removed, true);
  assert.deepEqual((await host.api('/api/gatcha/browse')).owners.map(v => v.uid), ['43']);
  assert.equal(readFileSync(path.join(data, 'gatcha_favlist.json'), 'utf8'), before[2]);
  await host.api('/api/session-users/add', { name: 'Remote user' });
  await guest.api('/api/remote-identity/register', { name: 'Remote user', claim: true });
  await guest.api('/api/gatcha/source/remove', { source: 'favlist', id: '42:10' });
  const saved = JSON.parse(readFileSync(path.join(data, 'gatcha_favlist.json'), 'utf8'));
  assert.deepEqual(saved.items.map(v => v.fav_folder_id), ['11']);
  assert.deepEqual((await host.api('/api/gatcha/favlist/browse')).folders.map(v => v.id), ['42:11']);
  const state = await host.api('/api/state');
  assert.equal(state.gatcha.last_result.operation, 'remove_source');
  assert.equal(state.gatcha.busy, false);
});

for (const mode of ['desktop', 'android', 'remote']) {
  test(`${mode} local source editing preserves navigation, gestures and pending guards`, { timeout: 90000 }, async t => {
    const { host, data } = await fixture(t, mode === 'android');
    await host.api('/api/session-users/add', { name: 'Alice' });
    const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: mode === 'desktop' ? { width: 700, height: 650 } : { width: 390, height: 844 }, hasTouch: mode !== 'desktop', reducedMotion: 'reduce' });
    if (mode !== 'remote') await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
    await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
    if (mode === 'android') await context.addInitScript(() => {
      window.BilikaraHostWindow = { postMessage(raw) {
        if (['enter', 'exit'].includes(raw)) return;
        const { id } = JSON.parse(raw);
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, ok: true, data: { layout: 'auto', orientation: 'system' } }) }));
      } };
    });
    await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.base + (mode === 'remote' ? '/remote' : '/'));
    await page.waitForFunction(() => typeof state !== 'undefined' && state.data?.session_user_entries?.length === 1);
    if (mode === 'remote') {
      await page.waitForFunction(() => !state.remoteIdentityChecking);
      await page.evaluate(async () => applyRemoteIdentity(await apiPost('/api/remote-identity/register', { name: 'Alice', claim: true })));
      await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
      await page.evaluate(() => activateRemoteRequestView('sources'));
    } else {
      if (mode === 'android') {
        await page.waitForFunction(() => window.BilikaraHostLayout?.isPortrait());
        await page.locator('[data-android-page="request"]').click();
      } else await page.locator('[data-host-workspace="request"]').click();
      await page.evaluate(() => activateRequestSubview('sources'));
    }
    await page.evaluate(() => { window.removalMediaNodes = [...document.querySelectorAll('video, audio')]; });
    await page.evaluate(() => loadFollowBrowse({ uid: '', query: '' }));
    const grid = page.locator(mode === 'remote' ? '#sources-follow-grid' : '#follow-up-grid');
    const card = grid.locator('.source-removal-card[data-source-id="42"]');
    await card.waitFor({ state: 'visible' });
    const toggle = page.locator(`.source-removal-toggle[aria-controls="${mode === 'remote' ? 'sources-follow-grid' : 'follow-up-grid'}"]`);
    assert.equal(await card.locator('.source-removal-delete').isVisible(), false);
    // A regular click still opens the source, including a mixed-input desktop.
    await card.locator('.follow-up-button').click();
    await page.waitForFunction(() => state.followBrowseSelectedUid === '42' && !state.followBrowseLoading);
    await page.evaluate(() => loadFollowBrowse({ uid: '', query: '' }));
    if (mode === 'desktop') await toggle.click();
    else {
      const target = card.locator('.follow-up-button');
      // Scrolling/movement and interrupted touches must not enter delete mode.
      await target.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 30, clientY: 30 });
      await target.dispatchEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 30, clientY: 60 });
      await page.waitForTimeout(600);
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      await target.dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 7 });
      await target.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: 30, clientY: 30 });
      await waitFor(async () => await toggle.getAttribute('aria-pressed') === 'true', 'long-press enters editing');
      await target.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 8 });
      await target.dispatchEvent('click');
      assert.equal(await page.evaluate(() => state.followBrowseSelectedUid), '');
    }
    const action = card.locator('.source-removal-delete');
    assert.equal(await action.isVisible(), true);
    const bounds = await card.boundingBox(), actionBounds = await action.boundingBox();
    assert.ok(actionBounds.x >= bounds.x && actionBounds.x + actionBounds.width <= bounds.x + bounds.width + 1);
    assert.equal(actionBounds.width, 44);
    if (process.env.BILIKARA_TEST_SCREENSHOT_DIR) {
      await page.screenshot({ path: path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR, `source-removal-${mode}.png`) });
    }
    let release, started = false, calls = 0;
    await page.route('**/api/gatcha/source/remove', async route => {
      calls++; started = true;
      await new Promise(resolve => { release = resolve; });
      await route.continue();
    });
    await action.click();
    await waitFor(() => started, 'delete request started');
    assert.equal(await action.isDisabled(), true);
    assert.equal(await action.getAttribute('aria-busy'), 'true');
    await action.dispatchEvent('click');
    assert.equal(calls, 1);
    release();
    await card.waitFor({ state: 'detached' });
    await page.unroute('**/api/gatcha/source/remove');
    await waitFor(() => JSON.parse(readFileSync(path.join(data, 'gatcha_uids.json'), 'utf8')).uids.length === 1, 'local file saved');
    assert.equal(await grid.locator('[data-source-id="43"]').count(), 1);
    // A failed write must restore the same controls and allow an explicit retry.
    await page.route('**/api/gatcha/source/remove', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Fixture refresh busy' }) }));
    const remaining = grid.locator('[data-source-id="43"] .source-removal-delete');
    await remaining.click();
    await waitFor(async () => !(await remaining.isDisabled()), 'failed removal restores controls');
    assert.equal(await remaining.getAttribute('aria-busy'), null);
    assert.deepEqual(JSON.parse(readFileSync(path.join(data, 'gatcha_uids.json'), 'utf8')).uids, ['43']);
    await page.unroute('**/api/gatcha/source/remove');
    // Exit is explicit and keyboard accessible.
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => {
      if (typeof activateRemoteSourcesMode === 'function') activateRemoteSourcesMode('favorites');
      else activateSourcesMode('favorites');
    });
    await page.evaluate(() => loadFavlistBrowse({ folderId: '', query: '' }));
    await page.locator('#favlist-grid .source-removal-card').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#favlist-grid .source-removal-card').count(), 2);
    await page.locator('.source-removal-toggle[aria-controls="favlist-grid"]').click();
    await page.locator('#favlist-grid [data-source-id="42:10"] .source-removal-delete').click();
    await page.locator('#favlist-grid [data-source-id="42:10"]').waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(readFileSync(path.join(data, 'gatcha_favlist.json'), 'utf8')).items.map(v => v.fav_folder_id), ['11']);
    await page.locator('.source-removal-toggle[aria-controls="favlist-grid"]').click();
    await page.locator('#favlist-grid [data-source-id="42:11"] .follow-up-button').click();
    await page.waitForFunction(() => state.favlistBrowseSelectedFolderId === '42:11' && !state.favlistBrowseLoading);
    // Another authenticated client removes the open folder. SSE must return
    // this client to the source list without a manual reload or a stale ID.
    await host.api('/api/gatcha/source/remove', { source: 'favlist', id: '42:11' });
    await page.waitForFunction(() => state.favlistBrowseSelectedFolderId === '' && state.favlistBrowseData.folders.length === 0);
    assert.equal(await page.evaluate(() => {
      const current = [...document.querySelectorAll('video, audio')];
      return current.length === window.removalMediaNodes.length && current.every((node, i) => node === window.removalMediaNodes[i]);
    }), true, 'source editing must retain all player media nodes');
    assert.deepEqual(errors, []);
  });
}
