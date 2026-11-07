// Real shared Host UI/HTTP in Linux WebKit/Chromium. The WK->UIKit operation
// is a transport fixture; this cannot qualify iPhone Safari/Universal Links.
import assert from 'node:assert/strict';
import {test, before} from 'node:test';
import {readFileSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha;
before(async () => {if (process.platform === 'linux') alpha = await buildNativeAlpha();}, {timeout: 300000});
for (const engine of [chromium, webkit]) test(`${engine.name()} iOS login uses bounded native bridge and retains Host/QR/media nodes`,
  {skip: process.platform !== 'linux', timeout: 90000}, async t => {
    const directory = ownedDirectory('ios login bridge'); t.after(() => rmSync(directory, {recursive: true, force: true}));
    const host = await RunningHost.start(alpha, directory, [directory, path.join(root, 'static')], isolatedEnvironment(directory), true);
    t.after(() => host.close());
    const browser = await engine.launch(); t.after(() => browser.close());
    const context = await browser.newContext({viewport: {width: 393, height: 844}, hasTouch: true});
    await context.addCookies([...host.cookies].map(([name, value]) => ({name, value, url: host.base})));
    await context.addInitScript(() => {
      localStorage.setItem('bilikara.update.automatic', 'false');
      window.iosNativeRequests = [];
      window.webkit = {messageHandlers: {bilikaraPlatform: {postMessage(value) {const request = JSON.parse(value);
        if (request.action === 'sync-dock') {
          queueMicrotask(() => BilikaraIosPlatform._receive({...request,ok:false}));
        } else if (request.id > 0) iosNativeRequests.push(request);}}}};
    });
    const source = readFileSync(new URL('../static/ios-platform.js', import.meta.url), 'utf8');
    await context.addInitScript(source.replace('"__BILIKARA_IOS_ORIGIN__"', JSON.stringify(host.base)));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); if (url.origin !== host.base) return route.abort();
      if (['/', '/index.html'].includes(url.pathname)) {
        const response = await route.fetch();
        return route.fulfill({response, body: (await response.text()).replace('data-host-platform="android"', 'data-host-platform="ios"')});
      }
      return route.continue();
    });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.base); await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
    assert.equal(await page.title(), 'bilikara host');
    assert.equal(new URL(page.url()).origin, host.base);
    assert.equal(await page.locator('.app-shell').isVisible(), true);
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(), 0);
    await page.evaluate(() => {
      state.eventSource?.close(); window.loginRefreshes = 0; fetchState = async () => {loginRefreshes++;};
      window.loginMediaNodes = [...document.querySelectorAll('video,audio')];
      state.data.bbdown.login = {state: 'waiting', logged_in: false, message: 'fixture',
        login_url: 'https://account.bilibili.com/login?fixture=1',
        qr_image: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="white"/></svg>')};
      renderBBDownLogin(state.data.bbdown.login, {startIfNeeded: false});
    });
    await page.locator('[data-android-page="my"]').click();
    const link = page.locator('#bbdown-login-link'); await link.waitFor({state: 'visible'});
    await link.click();
    assert.equal(await link.getAttribute('aria-busy'), 'true');
    await page.evaluate(() => document.getElementById('bbdown-login-link').click());
    assert.equal(await page.evaluate(() => iosNativeRequests.length), 1);
    const sent = await page.evaluate(() => iosNativeRequests[0]);
    assert.equal(sent.action, 'open-bilibili-login');
    assert.equal(sent.url, 'https://account.bilibili.com/login?fixture=1');
    await page.evaluate(() => BilikaraIosPlatform._receive({...iosNativeRequests[0], ok: true, data: {opened: true}}));
    await page.waitForFunction(() => !document.getElementById('bbdown-login-link').hasAttribute('aria-busy'));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.evaluate(() => loginRefreshes), 1);
    assert.equal(await page.evaluate(() => loginMediaNodes.every((node, i) => node === document.querySelectorAll('video,audio')[i])), true);
    assert.equal(await page.locator('#bbdown-login-qr-image').isVisible(), true);
    assert.equal(new URL(page.url()).origin, host.base);
    if (process.env.BILIKARA_IOS_UI_EVIDENCE) {
      mkdirSync(process.env.BILIKARA_IOS_UI_EVIDENCE, {recursive: true});
      await page.screenshot({path: path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, `ios-login-${engine.name()}.png`)});
    }
    assert.deepEqual(errors, []);
  });

for (const engine of [chromium, webkit]) test(`${engine.name()} iOS export dialog keeps guards until Files confirms saved or cancelled`,
  {skip:process.platform!=='linux',timeout:90000},async t=>{
    const directory=ownedDirectory('ios export bridge');t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const host=await RunningHost.start(alpha,directory,[directory,path.join(root,'static')],isolatedEnvironment(directory),true);t.after(()=>host.close());
    const browser=await engine.launch();t.after(()=>browser.close());
    const context=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(()=>{
      localStorage.setItem('bilikara.update.automatic','false');window.iosExports=[];
      window.webkit={messageHandlers:{bilikaraPlatform:{postMessage(raw){const r=JSON.parse(raw);
        if(r.action==='sync-dock')queueMicrotask(()=>BilikaraIosPlatform._receive({...r,ok:false}));
        if(r.action==='save-history')iosExports.push(r);
      }}}};
    });
    const script=readFileSync(new URL('../static/ios-platform.js',import.meta.url),'utf8');
    await context.addInitScript(script.replace('"__BILIKARA_IOS_ORIGIN__"',JSON.stringify(host.base)));
    await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==host.base)return route.abort();
      if(['/', '/index.html'].includes(u.pathname)){const r=await route.fetch();return route.fulfill({response:r,body:(await r.text()).replace('data-host-platform="android"','data-host-platform="ios"')});}return route.continue();});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(host.base);await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse);
    await page.evaluate(()=>setLanguage('zh'));
    await page.locator('[data-android-page="queue"]').click();await page.locator('[data-android-workspace="history"]').click();
    await page.locator('#history-export-button').click();await page.locator('#confirm-source').selectOption('history');await page.locator('#confirm-page-size').selectOption('50');
    await page.locator('#confirm-ok').click();await page.waitForFunction(()=>iosExports.length===1);
    assert.deepEqual(await page.evaluate(()=>iosExports[0].export),{format:'image',source:'history',pageSize:50});
    await page.evaluate(()=>{elements.confirmOk.click();elements.confirmSecondary.click();BilikaraIosPlatform._receive({...iosExports[0],ok:true,data:{status:'choosing'}});});
    assert.equal(await page.evaluate(()=>iosExports.length),1);assert.equal(await page.locator('#confirm-ok').isDisabled(),true);
    assert.equal(await page.locator('#confirm-secondary').isDisabled(),true);
    await page.evaluate(()=>BilikaraIosPlatform._receive({...iosExports[0],ok:true,data:{status:'cancelled'}}));
    await page.waitForFunction(()=>!elements.confirmOk.disabled&&!elements.confirmSecondary.disabled);
    assert.equal(await page.locator('#confirm-popover').isVisible(),true);
    await page.locator('#confirm-secondary').click();await page.waitForFunction(()=>iosExports.length===2);
    assert.equal(await page.evaluate(()=>iosExports[1].export.format),'csv');
    await page.evaluate(()=>BilikaraIosPlatform._receive({...iosExports[1],ok:true,data:{status:'saved'}}));
    await page.locator('#confirm-popover').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>BilikaraExportDownload.getExportDiagnosticsSnapshot().at(-1).status),'saved');
    assert.deepEqual(errors,[]);
  });
