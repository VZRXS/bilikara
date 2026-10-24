// Browser presentation evidence over an actual isolated Rust Host. The iOS
// HTML marker is a transport fixture; this does not run UIKit or WKWebView.
// Flow: shared Host -> mobile pages/settings/search -> bounded controls with
// live media, drafts and pending-operation guards preserved.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

const unavailable = process.platform !== 'linux' && 'Linux browser presentation; iOS device/Simulator evidence is separate';
let alpha, desktop;
before(async () => {
  if (unavailable) return;
  alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
  desktop = process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
}, {timeout:300000});

async function open(t, platform, {keyboard = false, media = false, expectedHttpErrors = []} = {}) {
  const home = mkdtempSync(path.join(tmpdir(),'bilikara-mobile-ui-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const host = await RunningHost.start(platform === 'desktop' ? desktop : alpha,home,platform === 'desktop'
    ? ['--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')]
    : [home,path.join(root,'static'),...(media ? [path.join(root,'tests/fixtures/bbdown/video.mp4'),path.join(root,'tests/fixtures/bbdown/audio.m4a')] : [])],isolatedEnvironment(home),platform !== 'desktop');
  t.after(()=>host.close());
  if (!media) await host.api('/api/session-users/add',{name:'Mobile singer'});
  const browser = await (platform === 'ios' ? webkit : chromium).launch({headless:true});
  t.after(()=>browser.close());
  const context = await browser.newContext({viewport:platform === 'desktop' ? {width:700,height:600} : {width:393,height:844},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(({keyboard})=>{
    localStorage.setItem('bilikara.update.automatic','false');
    if (keyboard) {
      const viewport = Object.assign(new EventTarget(),{height:innerHeight,offsetTop:0,scale:1});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
    }
  },{keyboard});
  await context.route('**/*',async route=>{
    const url = new URL(route.request().url());
    if (url.origin !== host.base) return route.abort();
    if (platform === 'ios' && ['/', '/index.html'].includes(url.pathname)) {
      const response = await route.fetch();
      const body = (await response.text()).replace('data-host-platform="android"','data-host-platform="ios"');
      assert.ok(body.includes('data-host-platform="ios"'));
      return route.fulfill({response,body});
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [], consoleErrors = [], localHttpErrors = [];
  page.on('response',response=>{
    const url=new URL(response.url());
    if (url.origin===host.base && response.status()>=400 && !expectedHttpErrors.includes(url.pathname)) {
      localHttpErrors.push(`${url.pathname}: ${response.status()}`);
    }
  });
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if (['error','warning'].includes(message.type())) consoleErrors.push(message.text());});
  await page.goto(host.base);
  await page.waitForFunction(()=>typeof state !== 'undefined' && state.hasValidStateResponse);
  assert.equal(await page.title(),'bilikara host');
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal(await page.locator('.app-shell').isVisible(),true);
  assert.equal(await page.locator('vite-error-overlay, nextjs-portal, webpack-dev-server-client-overlay').count(),0);
  t.after(()=>{
    assert.deepEqual(errors,[]);
    assert.deepEqual(localHttpErrors,[]);
    // Outbound requests are intentionally blocked. Engine network diagnostics
    // for those requests are not JavaScript/application exceptions.
    assert.deepEqual(consoleErrors.filter(message=>!/^Failed to load resource:/.test(message)),[]);
  });
  return {page,host};
}
const go = async (page,name)=>{
  await page.locator(`[data-android-page="${name}"]`).click();
  await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region')]
    .flatMap(node=>node.getAnimations().map(animation=>animation.finished))));
};
async function screenshot(page,name) {
  if (!process.env.BILIKARA_MOBILE_UI_EVIDENCE) return;
  mkdirSync(process.env.BILIKARA_MOBILE_UI_EVIDENCE,{recursive:true});
  await page.screenshot({path:path.join(process.env.BILIKARA_MOBILE_UI_EVIDENCE,name+'.png')});
}

test('desktop at the native minimum with mixed touch input keeps its rail and workspace', {skip:unavailable,timeout:90000},async t=>{
  const {page}=await open(t,'desktop');
  await page.locator('#work-rail-request').click();
  await page.locator('#url-input').waitFor({state:'visible'});
  for (const width of [700,900,700]) {
    await page.setViewportSize({width,height:600});
    assert.equal(await page.locator('#android-host-dock').isVisible(),false);
    assert.equal(await page.locator('#work-rail-request').isVisible(),true);
    assert.equal(await page.evaluate(()=>window.BilikaraIOSHost || window.BilikaraAndroidPlayback || null),null);
    assert.equal(await page.locator('#url-input').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.hostLayout),'landscape');
  }
  await screenshot(page,'desktop-700-touch');
});

test('iOS shares mobile navigation across languages/rotation and retains live nodes, drafts and keyboard geometry', {skip:unavailable,timeout:150000},async t=>{
  const {page}=await open(t,'ios',{keyboard:true,media:true});
  await page.waitForFunction(()=>window.BilikaraHostLayout && window.BilikaraIOSHost && document.querySelectorAll('video, audio').length === 2);
  await page.evaluate(()=>{
    window.mobileMedia=[...document.querySelectorAll('video, audio')].map(node=>({node,parent:node.parentElement}));
    window.mobileSession=state.hostPlaybackSession;
    if (!window.mobileSession) throw Error('A live shared playback session is required');
    document.documentElement.style.setProperty('--ios-safe-top','47px');
    document.documentElement.style.setProperty('--ios-safe-bottom','34px');
  });
  for (const [language,theme] of [['zh','light'],['en','dark'],['ja','blue']]) {
    await page.evaluate(({language,theme})=>{setLanguage(language);applyTheme(theme);},{language,theme});
    for (const name of ['playback','queue','request','users','my']) {
      await go(page,name);
      assert.equal(await page.locator('#android-host-dock [aria-current="page"]').getAttribute('data-android-page'),name);
      const targets=await page.locator('#android-host-dock button').evaluateAll(nodes=>nodes.map(node=>{
        const box=node.getBoundingClientRect();return box.width>=44 && box.height>=44 && box.left>=0 && box.right<=innerWidth && box.bottom<=innerHeight-34;
      }));
      assert.deepEqual(targets,[true,true,true,true,true]);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    }
  }
  await go(page,'request');
  await page.locator('#url-input').fill('unsent mobile draft');
  await page.locator('#url-input').evaluate(input=>input.setSelectionRange(7,13));
  const dock=await page.locator('#android-host-dock').boundingBox();
  await page.evaluate(()=>{visualViewport.height=520;visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForFunction(()=>BilikaraIOSHost.diagnostics().keyboard_inset===324);
  assert.deepEqual(await page.locator('#android-host-dock').boundingBox(),dock,'Keyboard must not move the dock');
  assert.ok((await page.locator('.shell-body').evaluate(node=>parseFloat(getComputedStyle(node).paddingBottom)))>=234);
  await page.evaluate(()=>{visualViewport.scale=2;visualViewport.dispatchEvent(new Event('resize'));});
  await page.waitForFunction(()=>BilikaraIOSHost.diagnostics().keyboard_inset===0);
  await page.locator('#url-input').blur();
  await page.evaluate(()=>{visualViewport.height=innerHeight;visualViewport.scale=1;});
  for (const viewport of [{width:844,height:390},{width:320,height:736},{width:393,height:844}]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(()=>BilikaraHostLayout.isPortrait()===(innerWidth<700));
    assert.equal(await page.locator('#url-input').inputValue(),'unsent mobile draft');
    assert.deepEqual(await page.locator('#url-input').evaluate(input=>[input.selectionStart,input.selectionEnd]),[7,13]);
    assert.equal(await page.evaluate(()=>mobileMedia.every(({node,parent})=>node.isConnected && node.parentElement===parent && [...document.querySelectorAll('video,audio')].includes(node))),true);
    assert.equal(await page.evaluate(()=>mobileSession===state.hostPlaybackSession),true);
  }
  await go(page,'my');
  await page.locator('#android-open-settings').scrollIntoViewIfNeeded();
  const scroll=await page.locator('#android-my-scroll').evaluate(node=>{node.scrollTop=80;return node.scrollTop;});
  await page.locator('#android-open-settings').click();
  await page.locator('#host-workspace-settings').waitFor({state:'visible'});
  await page.locator('#android-settings-back').click();
  await page.locator('#android-my-page').waitFor({state:'visible'});
  await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region')]
    .flatMap(node=>node.getAnimations().map(animation=>animation.finished))));
  assert.equal(await page.locator('#android-my-scroll').evaluate(node=>node.scrollTop),scroll);
  assert.deepEqual(await page.evaluate(()=>[document.documentElement.dataset.hostPlatform,
    Boolean(window.BilikaraAndroidPlatform),Boolean(window.BilikaraAndroidExport),Boolean(window.BilikaraAndroidPlayback),isAndroidNativePlaybackRuntime()]),['ios',false,false,false,false]);
  await screenshot(page,'ios-my-blue-safe-areas');
  await page.evaluate(()=>applyTheme('light'));
  await screenshot(page,'ios-my-safe-areas');
  await go(page,'request');
  await go(page,'users');
  await page.goBack();
  await page.waitForFunction(()=>document.documentElement.dataset.hostPage==='request');
  assert.equal(await page.locator('#url-input').inputValue(),'unsent mobile draft');
  await screenshot(page,'ios-request-draft');
});

test('iOS uses shared result pagination and keeps an asynchronous action busy through navigation', {skip:unavailable,timeout:90000},async t=>{
  const {page}=await open(t,'ios',{expectedHttpErrors:['/api/playlist/add']});
  const items=Array.from({length:30},(_,i)=>({bvid:'BV'+String(i+1).padStart(10,'0'),title:'Mobile song '+(i+1),owner_name:'Fixture'}));
  await page.route('**/api/catalog/search?**',route=>{
    const query=new URL(route.request().url()),offset=Number(query.searchParams.get('offset')),limit=Number(query.searchParams.get('limit'));
    return route.fulfill({json:{ok:true,data:{items:items.slice(offset,offset+limit),matched_count:30,has_more:offset+limit<30,next_offset:Math.min(30,offset+limit)}}});
  });
  await go(page,'request');
  await page.locator('[data-request-view="search"]').click();
  await page.locator('#lark-search-form input').fill('Mobile');
  await page.locator('#lark-search-button').click();
  const pager=page.locator('#request-search-shared .result-pager');
  await pager.locator('[data-page-input]').waitFor();
  await pager.locator('[data-page-action="next"]').click();
  await page.waitForFunction(()=>document.querySelector('#request-search-shared [data-page-input]').value==='2');
  assert.notEqual(await page.locator('#lark-search-results .search-result-title').first().textContent(),'Mobile song 1');
  const bounds=await pager.boundingBox(),dock=await page.locator('#android-host-dock').boundingBox();
  assert.ok(bounds.y+bounds.height<=dock.y,'Pager stays in its bounded page above navigation');
  await page.locator('#android-request-tabs [data-request-back]').click();
  await page.locator('#url-input').fill('BV1z84y1p7oS');
  let release, requests=0;
  const barrier=new Promise(resolve=>release=resolve);
  await page.route('**/api/playlist/add',async route=>{requests++;await barrier;await route.continue();});
  t.after(()=>release());
  const button=page.locator('#add-form button[type=submit]');
  await button.click();
  await page.waitForFunction(()=>document.querySelector('#add-form button[type=submit]').getAttribute('aria-busy')==='true');
  await go(page,'queue');await go(page,'request');
  await page.evaluate(()=>setLanguage('en'));
  assert.equal(await button.isDisabled(),true);
  await button.dispatchEvent('click');
  assert.equal(requests,1,'Repeated activation must not start another request');
  release();
  await page.waitForFunction(()=>!document.querySelector('#add-form button[type=submit]').disabled);
  assert.equal(await button.getAttribute('aria-busy'),null);
  await screenshot(page,'ios-pending-action-restored');
});
