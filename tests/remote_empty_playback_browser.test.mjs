// Real native Host and Remote transport; Linux engines do not qualify iOS.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

// Compile current native fixtures before measuring browser behavior. Cold Cargo
// preparation has its own bound and must not consume the playback deadline.
let alpha;
before(async () => {
  if (process.platform === 'linux') alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
}, {timeout: 300000});

for (const engine of [chromium, webkit]) test(`${engine.name()} empty Remote dock opens without issuing playback commands`, {
  skip:process.platform !== 'linux', timeout:150000,
}, async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-empty-dock-'));
  let host, browser;
  t.after(async () => { await browser?.close(); await host?.close(); rmSync(home, {recursive:true, force:true}); });
  host = await RunningHost.start(alpha, home,
    [home, path.join(root, 'static')], isolatedEnvironment(home), true);
  await host.api('/api/session-users/add', {name:'Empty fixture'});
  browser = await engine.launch();
  const context = await browser.newContext({viewport:{width:393, height:844}, hasTouch:true});
  await context.addInitScript(() => {
    localStorage.setItem('bilikara.update.automatic','false');
    localStorage.setItem('bilikara.ui.playback-restart-seen.remote.v1','true');
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const page = await context.newPage(), commands = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^\/api\/(?:player\/(?:control|next)|cache\/retry|audio-variant)/.test(new URL(request.url()).pathname)) commands.push(request.url());
  });
  await page.goto(host.base + '/remote');
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data && !state.remoteIdentityChecking);
  await page.evaluate(async () => applyRemoteIdentity(await apiPost('/api/remote-identity/register', {name:'Empty fixture', claim:true})));
  await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  const dock = page.locator('#playback-dock'), sheet = page.locator('#playback-sheet');
  const verify = async () => {
    assert.equal(await dock.isVisible(), true);
    assert.equal(await dock.getAttribute('aria-hidden'), 'false');
    await dock.click(); await sheet.waitFor({state:'visible'});
    await page.waitForFunction(() => !playbackSheetGesture?.active);
    assert.equal(await page.locator('#current-title').textContent(), await page.evaluate(() => t('remote.noCurrentSong')));
    assert.equal(await page.locator('#player-control-panel').isVisible(), true);
    const controls = page.locator('#player-control-panel button[data-control-action],#playback-sheet-seek');
    assert.ok(await controls.count() >= 4);
    assert.equal(await controls.evaluateAll(nodes => nodes.every(node => node.disabled)), true);
    assert.equal(await page.locator('#audio-variant-bar').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Even a direct stale UI invocation must not submit a command for no song.
    await page.evaluate(async () => { await sendPlayerControl('toggle-play'); await sendPlayerNext(); });
    assert.deepEqual(commands, []);
  };
  await verify();
  const evidence = process.env.BILIKARA_EMPTY_REMOTE_EVIDENCE;
  if (evidence) { mkdirSync(evidence, {recursive:true}); await page.screenshot({path:path.join(evidence,`${engine.name()}-empty-remote.png`)}); }
  // A fresh HTTP/SSE connection restores the same empty presentation.
  await page.reload();
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data && !state.remoteIdentityChecking);
  await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  await verify();
  await page.keyboard.press('Escape'); await sheet.waitFor({state:'hidden'});
  await dock.focus(); await page.keyboard.press('Enter'); await sheet.waitFor({state:'visible'});
  assert.deepEqual(errors, []); assert.deepEqual(commands, []);
});
