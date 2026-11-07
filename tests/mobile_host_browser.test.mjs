// Browser presentation evidence over an actual isolated Rust Host. The iOS
// HTML marker is a transport fixture; this does not run UIKit or WKWebView.
// Flow: shared Host -> mobile pages/settings/search -> bounded controls with
// live media, drafts and pending-operation guards preserved.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

const unavailable = process.platform !== 'linux' && 'Linux browser presentation; iOS device/Simulator evidence is separate';
let alpha, desktop;
before(async () => {
  if (unavailable) return;
  alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
  desktop = process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
}, {timeout:300000});

async function open(t, platform, {keyboard = false, media = false, expectedHttpErrors = [], channel = '', nativeDock = false} = {}) {
  const home = mkdtempSync(path.join(tmpdir(),'bilikara-mobile-ui-'));
  let host, browser;
  t.after(async()=>{
    // Keep the Host and its data alive until all browser polling has stopped.
    try { if (browser) await browser.close(); }
    finally { try { if (host) await host.close(); } finally { rmSync(home,{recursive:true,force:true}); } }
  });
  const mediaFiles=[];
  if(media)for(const [source,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
    // The tiny cache-validation fixtures are one frame / one second. Their
    // natural EOS can legitimately replace the player during navigation.
    // Keep real media alive for this UI contract, matching Native Alpha's 90s.
    const target=path.join(home,name);
    const built=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',source),'-t','90','-c','copy','-movflags','+faststart',target],process.env,30000);
    assert.equal(built.status,0,built.stderr);mediaFiles.push(target);
  }
  host = await RunningHost.start(platform === 'desktop' ? desktop : alpha,home,platform === 'desktop'
    ? ['--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')]
    : [home,path.join(root,'static'),...mediaFiles],isolatedEnvironment(home),platform !== 'desktop');
  if (!media) await host.api('/api/session-users/add',{name:'Mobile singer'});
  const requestedEngine = process.env.BILIKARA_MOBILE_UI_ENGINE;
  assert.ok(!requestedEngine || ['chromium','webkit'].includes(requestedEngine), 'explicit supported Linux browser');
  browser = await (requestedEngine ? {chromium,webkit}[requestedEngine] : platform === 'ios' ? webkit : chromium).launch({headless:true});
  const context = await browser.newContext({viewport:platform === 'desktop' ? {width:700,height:600} : {width:393,height:844},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(({keyboard,nativeDock})=>{
    if (nativeDock) {
      window.nativeDockRequests = [];
      window.BilikaraIosPlatform = {syncDock: async data => {window.nativeDockRequests.push(data);if(nativeDock === "unavailable") throw new Error("ios_platform_failed");return {height:83};}};
    }
    localStorage.setItem('bilikara.update.automatic','false');
    if (keyboard) {
      const viewport = Object.assign(new EventTarget(),{height:innerHeight,offsetTop:0,scale:1});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
    }
  },{keyboard,nativeDock});
  await context.route('**/*',async route=>{
    const url = new URL(route.request().url());
    if (url.origin !== host.base) return route.abort();
    if ((platform === 'ios' || channel) && ['/', '/index.html'].includes(url.pathname)) {
      const response = await route.fetch();
      let body = await response.text();
      if (platform === 'ios') body = body.replace('data-host-platform="android"','data-host-platform="ios"');
      if (channel) body = body.replace('<html ', `<html data-host-channel="${channel}" `);
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
  await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region,.mobile-navigation-header')]
    .flatMap(node=>node.getAnimations().map(animation=>animation.finished))));
};

for (const platform of ['android','ios']) test(`${platform} phone pages use viewport motion and continuous dock underlap`,
  {skip:unavailable,timeout:90000}, async t=>{
    const {page}=await open(t,platform,{media:true});
    await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
    const brand=await page.evaluate(()=>{
      const a=document.querySelector('.host-brand h1').getBoundingClientRect(),b=document.querySelector('.top-controls').getBoundingClientRect();
      return Math.abs((a.top+a.bottom-b.top-b.bottom)/2);
    });
    assert.ok(brand<1,'the single-line brand centers with its action row');
    await page.setViewportSize({width:393,height:600});
    const frame=await page.locator('#player-frame').boundingBox();
    const controls=await page.locator('#stage-control-tray').evaluate(n=>{
      n.scrollTop=n.scrollHeight;const r=n.getBoundingClientRect();return{bottom:r.bottom,scroll:n.scrollTop,padding:parseFloat(getComputedStyle(n).paddingBottom)};
    });
    const dock=await page.locator('#android-host-dock').boundingBox();
    assert.ok(controls.bottom>dock.y&&controls.bottom<=600);
    assert.ok(controls.padding>=dock.height+14&&controls.scroll>0);
    assert.ok(Math.abs((await page.locator('#player-frame').boundingBox()).y-frame.y)<1,'only the controls scroll');
    await go(page,'queue');
    assert.ok(await page.locator('#host-workspace-region').evaluate(n=>n.getBoundingClientRect().bottom>=innerHeight-1),
      'Queue continues beneath the floating dock');
    await go(page,'my');
    assert.ok(await page.locator('#android-my-scroll').evaluate(n=>n.getBoundingClientRect().bottom>=innerHeight-1));
    const fields=await page.locator('#cache-quality-select,#cache-download-source-select').evaluateAll(nodes=>nodes.map(n=>{
      const s=getComputedStyle(n);return ['appearance','backgroundColor','backdropFilter','webkitBackdropFilter','borderRadius','fontSize','fontWeight','height','boxShadow'].map(k=>s[k]);
    }));
    assert.deepEqual(fields[0],fields[1],'both runtime selects share the same CSS skin; native OS popovers require device inspection');
    await page.locator('#android-open-settings').click();
    await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));
    if(platform==='ios'){
      const progress=async(phase,value)=>page.evaluate(({phase,value})=>{
        document.documentElement.dataset.iosNativeBack='true';dispatchEvent(new CustomEvent('bilikara:ios-back',{detail:{phase,progress:value,velocity:0}}));
      },{phase,value});
      await progress('began',0);await progress('changed',.5);
      const motion=await page.evaluate(()=>{
        const node=document.getElementById('host-workspace-region'),r=node.getBoundingClientRect();
        const group=document.querySelector('#host-workspace-settings .settings-section-card').getBoundingClientRect();
        return{width:r.width,left:r.left,viewport:innerWidth,gutter:group.left-r.left,
          header:document.querySelector('.mobile-navigation-header[data-page="settings"]').getBoundingClientRect().width,
          overflow:getComputedStyle(node.parentElement).overflow};
      });
      assert.ok(Math.abs(motion.width-motion.viewport)<1&&Math.abs(motion.left-motion.viewport*.5)<1,JSON.stringify(motion));
      assert.ok(Math.abs(motion.header-motion.viewport)<1,JSON.stringify(motion));
      assert.ok(Math.abs(motion.gutter-14)<1,JSON.stringify(motion));
      assert.equal(motion.overflow,'visible');
      if(process.env.BILIKARA_MOBILE_UI_EVIDENCE){mkdirSync(process.env.BILIKARA_MOBILE_UI_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.BILIKARA_MOBILE_UI_EVIDENCE,`viewport-back-${process.env.BILIKARA_MOBILE_UI_ENGINE||platform}.png`)});}
      await progress('cancelled',.5);
    }
  });

for (const platform of ['android','ios']) test(`${platform} primary navigation stays tap-only through touch cancellation and empty-space swipes [P0-UI-3]`,
  {skip:unavailable,timeout:60000},async t=>{
    const {page}=await open(t,platform,{media:true});
    await page.evaluate(()=>{window.primaryMedia=[...document.querySelectorAll('video,audio')];});
    for(const name of ['playback','queue','request','users','my']){
      await go(page,name);
      for(const cancel of [true,false])await page.evaluate(cancel=>{
        const target=document.querySelector('.shell-body');
        for(const [type,x,y] of [['pointerdown',180,350],['pointermove',40,352],[cancel?'pointercancel':'pointerup',40,352]]){
          target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:17,pointerType:'touch',isPrimary:true,clientX:x,clientY:y}));
        }
        const touch=(x,y)=>({identifier:18,clientX:x,clientY:y});
        for(const [type,point] of [['touchstart',touch(180,350)],['touchmove',touch(40,352)],[cancel?'touchcancel':'touchend',touch(40,352)]]){
          const event=new Event(type,{bubbles:true,cancelable:true});
          Object.defineProperties(event,{touches:{value:['touchend','touchcancel'].includes(type)?[]:[point]},changedTouches:{value:[point]}});
          target.dispatchEvent(event);
        }
      },cancel);
      assert.equal(await page.locator('#android-host-dock [aria-current="page"]').getAttribute('data-android-page'),name);
      assert.equal(await page.evaluate(()=>primaryMedia.every(node=>node.isConnected&&[...document.querySelectorAll('video,audio')].includes(node))),true);
    }
  });

for (const platform of ['desktop','android','ios']) test(`${platform} export dialog centers in usable bounds across languages and short windows`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform,{nativeDock:platform==='ios'});
    if(platform==='desktop')await page.locator('#work-rail-history').click();
    else {
      if(platform==='ios')await page.evaluate(()=>window.dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:1}})));
      else await go(page,'queue');
      await page.locator('[data-android-workspace="history"]').click();
    }
    await page.locator('#history-export-button').click();
    for(const [width,height] of platform==='desktop'?[[700,600],[1280,800]]:[[320,568],[393,844],[844,393]]){
      await page.setViewportSize({width,height});
      for(const language of ['zh','en','ja']){
        await page.evaluate(({language,platform})=>{setLanguage(language);if(platform==='ios'){
          document.documentElement.style.setProperty('--ios-safe-top','44px');document.documentElement.style.setProperty('--ios-safe-bottom','34px');
        }scheduleConfirmPopoverPositionSync();},{language,platform});
        await page.evaluate(()=>Promise.allSettled(document.getElementById('confirm-popover').getAnimations().map(a=>a.finished)));
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        const actual=await page.evaluate(()=>{
          const panel=document.getElementById('confirm-popover'),r=panel.getBoundingClientRect(),root=document.documentElement;
          const style=getComputedStyle(root),safe=side=>parseFloat(style.getPropertyValue('--ios-safe-'+side))||0;
          const dock=document.getElementById('android-host-dock');
          const ceiling=Math.max(0,safe('top'))+12;
          const floor=Math.min(innerHeight-safe('bottom'),root.dataset.hostLayout==='portrait'&&dock.getClientRects().length?dock.getBoundingClientRect().top:innerHeight)-12;
          return {leftGap:r.left-(safe('left')+12),rightGap:innerWidth-safe('right')-12-r.right,topGap:r.top-ceiling,bottomGap:floor-r.bottom,width:r.width,
            buttons:[...panel.querySelectorAll('.confirm-actions button:not(.hidden)')].map(b=>{const x=b.getBoundingClientRect();return {x:x.x,right:x.right,y:x.y};}),left:r.left,right:r.right};
        });
        assert.ok(Math.abs(actual.leftGap-actual.rightGap)<2,JSON.stringify(actual));
        assert.ok(Math.abs(actual.topGap-actual.bottomGap)<2,JSON.stringify(actual));
        assert.ok(actual.topGap>=-1&&actual.leftGap>=-1&&actual.width<=420.5,JSON.stringify(actual));
        assert.ok(actual.buttons.every(b=>b.x>=actual.left&&b.right<=actual.right+1));
        assert.ok(Math.abs(actual.buttons[0].y-actual.buttons[1].y)<1,'both export actions stay on one row');
      }
    }
  });

for (const platform of ['desktop','android','ios']) test(`${platform} export backdrop preserves theme, focus, background input and rapid reopening`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform);
    if(platform==='desktop')await page.locator('#work-rail-history').click();
    else {await go(page,'queue');await page.locator('[data-android-workspace="history"]').click();}
    const original=await page.evaluate(()=>({inert:document.querySelector('.app-shell').inert,overflow:document.body.style.overflow}));
    const openDialog=async()=>{await page.locator('#history-export-button').click();await page.locator('#confirm-popover').evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));};
    await openDialog();
    for(const theme of ['light','dark','blue']){
      await page.evaluate(theme=>applyTheme(theme),theme);
      const actual=await page.evaluate(()=>{
        const p=document.getElementById('confirm-popover'),b=document.getElementById('confirm-export-backdrop'),s=getComputedStyle(b);
        return {modal:p.getAttribute('aria-modal'),visible:b.getClientRects().length>0,color:s.backgroundColor,blur:s.backdropFilter||s.webkitBackdropFilter,
          shellInert:document.querySelector('.app-shell').inert,pageBlur:getComputedStyle(document.querySelector('.app-shell')).filter,hit:document.elementFromPoint(5,100)?.id};
      });
      if(platform==='desktop'){assert.equal(actual.visible,false);assert.equal(actual.modal,'false');assert.equal(actual.shellInert,original.inert);}
      else {assert.equal(actual.visible,true);assert.equal(actual.modal,'true');assert.equal(actual.shellInert,true);assert.equal(actual.blur,'none');assert.equal(actual.pageBlur,'none');assert.match(actual.color,/rgba\(.+, 0\.[1-9]/);assert.equal(actual.hit,'confirm-export-backdrop');}
    }
    if(platform!=='desktop'){
      await page.locator('#confirm-ok').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#confirm-close').evaluate(n=>n===document.activeElement),true);
      await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('#confirm-ok').evaluate(n=>n===document.activeElement),true);
      const target=await page.locator('[data-android-page="my"]').boundingBox();await page.mouse.click(target.x+target.width/2,target.y+target.height/2);
      await page.locator('#confirm-popover').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.documentElement.dataset.hostPage),'queue','backdrop consumes the tap instead of navigating');
      assert.equal(await page.locator('#history-export-button').evaluate(n=>n===document.activeElement),true);
      await openDialog();
      await page.evaluate(()=>{const intent={...state.confirmIntent};closeConfirm();openConfirm(intent);});
      await page.locator('#confirm-popover').evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
      assert.equal(await page.evaluate(()=>document.querySelector('.app-shell').inert),true);
    }
    await page.locator('#confirm-close').click();await page.locator('#confirm-popover').waitFor({state:'hidden'});
    assert.equal(await page.locator('#confirm-export-backdrop').isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>({inert:document.querySelector('.app-shell').inert,overflow:document.body.style.overflow})),original);
  });

for (const platform of ['android','ios']) test(`${platform} logout confirmation resets on outside interaction, route changes and app departure`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform);
    await go(page,'my');
    // The Host is deliberately unlogged; keep background refreshes from
    // replacing this synthetic logged-in UI fixture. Explicit logout below
    // still uses the actual Host request and returned state.
    await page.evaluate(()=>{setLanguage('zh');fetchState=async()=>{};state.eventSource?.close();state.data.bbdown={...state.data.bbdown,logged_in:true,login:{logged_in:true}};renderBBDownLogin(state.data.bbdown.login);});
    const button=page.locator('#bbdown-login-button'), label=button.locator('.bbdown-login-label');
    const arm=async()=>{await button.click();assert.equal(await label.textContent(),'退出');};
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.locator('#android-my-page h3').first().click();
    assert.equal(await label.textContent(),'已登录');
    await arm();await go(page,'queue');await go(page,'my');
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.locator('#android-open-settings').click();await page.locator('#android-settings-back').click();
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}})));
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.keyboard.press('Escape');
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    assert.equal(await label.textContent(),'已登录');
    await arm();await page.evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;
    });
    assert.equal(await label.textContent(),'已登录');
    let requests=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/bbdown/logout')requests++;});
    await arm();await button.click();await page.waitForFunction(()=>!elements.bbdownLoginButton.disabled);
    assert.equal(requests,1);assert.equal(await label.textContent(),'未登录');
  });

for (const platform of ['android','ios']) test(`${platform} phone subtitles, titles and unframed content share Playback geometry`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform);
    for (const width of [320,393,430]) {
      await page.setViewportSize({width,height:844});
      for (const language of ['zh','en','ja']) {
        await page.evaluate(language=>setLanguage(language),language);
        await go(page,'playback');
        const card=await page.locator('.player-panel').boundingBox();
        const title=await page.locator('.host-brand h1').boundingBox();
        // The topbar's mode-control owns its visible outline/background.
        const homeButton=await page.locator('#remote-mini-control').boundingBox();
        let sectionTitleCenter=null;
        for (const name of ['queue','request','users','my']) {
          await go(page,name);
          const heading=page.locator('#android-page-heading h2');
          const bounds=await heading.boundingBox();
          assert.ok(Math.abs(bounds.x-title.x)<1,`${platform}/${width}/${language}/${name} title axis`);
          const center=bounds.y+bounds.height/2;
          if(sectionTitleCenter===null)sectionTitleCenter=center;
          assert.ok(Math.abs(center-sectionTitleCenter)<2,`${name} title center`);
          assert.ok(Math.abs(title.y+title.height/2-homeButton.y-homeButton.height/2)<1,'Playback brand centers with its actions');
          const outer=await page.locator(name==='my'?'#android-my-page':'#host-workspace-region').boundingBox();
          assert.ok(Math.abs(outer.y-card.y)<1,`${name} card top: ${outer.y} vs ${card.y}`);
          assert.equal(await page.locator('#android-page-heading .section-tag').isVisible(),true);
          const surface=await page.locator(name==='my'?'#android-my-page':'#host-workspace-region').evaluate(n=>{const s=getComputedStyle(n);return {border:s.borderTopWidth,background:s.backgroundColor,radius:s.borderRadius};});
          assert.deepEqual([surface.border,surface.radius],['0px','0px'],'no enclosing page card');
          assert.equal(surface.background,'rgba(0, 0, 0, 0)','page frames reveal the continuous viewport backdrop without a rectangular base');
          if(name==='queue') {
            const action=await page.locator('#clear-playlist-button').boundingBox();
            assert.equal(action.height,homeButton.height);
            const text=await page.locator('#clear-playlist-button').evaluate(button=>{
              const range=document.createRange();range.selectNodeContents(button);const r=range.getBoundingClientRect(),b=button.getBoundingClientRect();
              return {width:r.width,height:r.height,inside:r.left>=b.left&&r.right<=b.right,font:parseFloat(getComputedStyle(button).fontSize),pseudo:getComputedStyle(button,'::before').content};
            });
            assert.ok(text.width>0&&text.height>0&&text.font>=14&&text.inside,JSON.stringify(text));
            assert.ok(['none','normal'].includes(text.pseudo),'text action must not be replaced by a pseudo-icon');
            const sort=await page.locator('#resort-playlist-button').boundingBox();
            assert.ok(sort.width>action.width,'translated labels retain their content widths');
            assert.ok(Math.abs(action.y-homeButton.y)<1,`${name} toolbar ${JSON.stringify({action,homeButton})}`);
          }
        }
      }
    }
    await screenshot(page,`phone-toolbar-${platform}`);
  });

for(const [platform,channel] of [['android',''],['ios',''],['ios','stable']])test(`${platform} ${channel||'default'} build label and mobile selects retain platform, theme and focus semantics`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform,{channel});
    await go(page,'request');
    const expected=platform==='android'?['Android','Android','Android']
      :channel==='stable'?['iOS','iOS','iOS']:['iOS 测试版','iOS beta','iOS テスト版'];
    for(const [index,language]of ['zh','en','ja'].entries()){
      await page.evaluate(language=>setLanguage(language),language);
      assert.equal(await page.locator('[data-mobile-build-label]').textContent(),expected[index]);
    }
    for(const name of ['request','queue','users','my']){
      await go(page,name);
      const heading=page.locator('#android-page-heading > .host-peer-heading');
      assert.equal(await heading.count(),1);
      const bounds=await heading.boundingBox();assert.ok(bounds.width > 100);assert.ok(bounds.height >= 24);
      assert.ok(await heading.locator('h2').textContent(),'semantic heading is retained');
    }
    await go(page,'my');
    for(const theme of ['light','dark','blue']){
      await page.evaluate(theme=>applyTheme(theme),theme);
      for(const id of ['cache-quality-select','cache-download-source-select']){
        const field=page.locator('#'+id+(platform==='ios'?'-trigger':''));
        assert.equal(await field.isVisible(),true);
        const style=await field.evaluate(node=>{const s=getComputedStyle(node);return{height:node.getBoundingClientRect().height,border:s.borderTopWidth,color:s.borderTopColor,background:s.backgroundColor,radius:parseFloat(s.borderRadius)};});
        assert.equal(style.height,34);assert.equal(style.border,'1px');assert.ok(style.radius>=17);
        assert.notEqual(style.color,style.background);
      }
    }
    await screenshot(page,`selects-${platform}-${channel||'default'}`);
  });

test('iOS Settings edge-back uses the existing route, preserves drafts and ignores other gesture owners',
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,'ios');
    await go(page,'request');await page.locator('#url-input').fill('unsubmitted request');
    await go(page,'my');
    await page.evaluate(()=>{window.myReturnControls=[...document.querySelectorAll('#cache-panel input,#cache-panel select')];window.myReturnValues=myReturnControls.map(n=>[n.value,n.checked,n.disabled,n.getAttribute('aria-busy')]);});
    await page.locator('#android-open-settings').click();
    await page.locator('#host-workspace-settings').waitFor({state:'visible'});
    const length=await page.evaluate(()=>history.length);
    const swipe=async({x=12,y=200,dx=220,dy=2,target='body',cancel=false}={})=>page.evaluate(({x,y,dx,dy,target,cancel})=>{
      const element=document.querySelector(target),touch=(clientX,clientY)=>({identifier:41,clientX,clientY});
      const send=(type,point)=>{const e=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperties(e,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[point]},changedTouches:{value:[point]}});element.dispatchEvent(e);};
      send('touchstart',touch(x,y));send('touchmove',touch(x+dx,y+dy));
      if(cancel)send('touchcancel',touch(x+dx,y+dy));send('touchend',touch(x+dx,y+dy));
    },{x,y,dx,dy,target,cancel});
    for(const gesture of [{x:80},{dx:40},{dx:10,dy:100},{target:'#cache-limit-slider'},{cancel:true}]){
      await swipe(gesture);assert.equal(await page.locator('#host-workspace-settings').isVisible(),true);
    }
    await page.evaluate(()=>{const d=document.createElement('dialog');d.id='edge-modal-fixture';d.textContent='modal';document.body.append(d);d.showModal();});
    await swipe();assert.equal(await page.locator('#host-workspace-settings').isVisible(),true);
    await page.evaluate(()=>document.querySelector('#edge-modal-fixture').remove());
    const interactive = await page.evaluate(() => {
      const send = (type, x) => {const event = new Event(type, {bubbles:true,cancelable:true});
        const point = {identifier:99,clientX:x,clientY:200};
        Object.defineProperties(event, {touches:{value:type==='touchend'?[]:[point]},changedTouches:{value:[point]}});
        document.body.dispatchEvent(event);
      };
      const card = document.getElementById('host-workspace-region');
      const before = card.getBoundingClientRect().left;
      send('touchstart', 12); send('touchmove', 112);
      const panel=document.getElementById('cache-panel');
      const middle = {cacheVisible:panel.getBoundingClientRect().height>0&&!panel.classList.contains('hidden'),
        controlsRetained:myReturnControls.every(n=>panel.contains(n)),
        valuesRetained:JSON.stringify(myReturnValues)===JSON.stringify(myReturnControls.map(n=>[n.value,n.checked,n.disabled,n.getAttribute('aria-busy')])),
        canvas:getComputedStyle(card).backgroundColor,
        clip:getComputedStyle(document.getElementById('android-my-page')).clipPath,
        fillsPage:document.getElementById('host-workspace-settings').getBoundingClientRect().height>=card.getBoundingClientRect().height-1,
        distance:card.getBoundingClientRect().left-before,
        parentVisible:!document.getElementById('android-my-page').hidden,
        route:history.state.hostLayout.settings};
      send('touchmove', 24); send('touchend', 24);
      return middle;
    });
    assert.ok(interactive.distance > 80 && interactive.distance < 120, JSON.stringify(interactive));
    assert.equal(interactive.parentVisible, true); assert.equal(interactive.route, true);
    assert.equal(interactive.cacheVisible,true,'My playback/download controls remain rendered under the back gesture');
    assert.equal(interactive.controlsRetained,true,'return uses the original controls');
    assert.equal(interactive.valuesRetained,true,'return preserves values, disabled state and pending guards');
    assert.equal(interactive.canvas,'rgba(0, 0, 0, 0)','moving pages have no rectangular background');
    assert.match(interactive.clip,/^inset\(/,'covered My content is clipped rather than showing through Settings');
    assert.equal(interactive.fillsPage,true);
    await page.evaluate(() => Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region,.mobile-navigation-header')]
      .flatMap(node => node.getAnimations().map(animation => animation.finished))));
    assert.equal(await page.evaluate(() => history.state.hostLayout.settings), true, 'cancel preserves the child route');
    await swipe();await page.locator('#host-workspace-settings').waitFor({state:'hidden'});
    assert.equal(await page.locator('#android-my-page').isVisible(),true);
    assert.equal(await page.evaluate(()=>history.length),length,'edge-back must replace rather than push a new route');
    assert.equal(await page.evaluate(()=>history.state.hostLayout.settings),false);
    await go(page,'request');assert.equal(await page.locator('#url-input').inputValue(),'unsubmitted request');
    // Native protocol fixture exercises shared presentation, not UIKit input.
    await go(page,'my');await page.locator('#android-open-settings').click();
    await page.locator('#host-workspace-settings').waitFor({state:'visible'});
    const nativeLength=await page.evaluate(()=>history.length);
    const nativeProgress = async (phase, progress) => page.evaluate(({phase,progress}) => {
      document.documentElement.dataset.iosNativeBack='true';
      window.dispatchEvent(new CustomEvent('bilikara:ios-back',{detail:{phase,progress,velocity:0}}));
    },{phase,progress});
    await nativeProgress('began',0);await nativeProgress('changed',.25);
    assert.equal(await page.evaluate(()=>history.state.hostLayout.settings),true);
    assert.equal(await page.locator('#android-my-page').isVisible(),true);
    const takeover=await page.evaluate(()=>{
      // UIKit's recognizer cancels the WebView touch stream on takeover.
      document.body.dispatchEvent(new Event('touchcancel',{bubbles:true}));
      window.dispatchEvent(new CustomEvent('bilikara:ios-back',{detail:{phase:'changed',progress:.3,velocity:0}}));
      // Ordinary SSE/volume paints continue during an interactive gesture.
      // They must not hide the incoming card or reset its transform.
      syncCachePanelVisibility();BilikaraHostLayout.syncVisibility();
      const node=document.getElementById('host-workspace-region');
      return {cacheVisible:document.getElementById('cache-panel').getBoundingClientRect().height>0,width:node.getBoundingClientRect().width,translation:new DOMMatrixReadOnly(getComputedStyle(node).transform).m41};
    });
    assert.ok(Math.abs(takeover.translation-takeover.width*.3)<1,JSON.stringify(takeover));
    assert.equal(takeover.cacheVisible,true,'an ordinary state paint must not hide resident My controls');
    // Use the same opaque sentinel/layer in both captures. Adding/removing a
    // layer can change fractional-position text rasterization in Chromium even
    // when no underlay pixel is visible. Only its color changes between frames.
    await page.locator('#android-my-page').evaluate(n=>{
      const probe=document.createElement('div');probe.id='underlay-clip-probe';probe.setAttribute('aria-hidden','true');
      probe.style.cssText='position:absolute;inset:0;background:#ff00ff;z-index:2147483647;pointer-events:none;transition:none;animation:none;will-change:transform';n.append(probe);
    });
    let before,coveredUnderlay;
    try{
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
      const overlap=await page.evaluate(()=>{
        const my=document.getElementById('android-my-page').getBoundingClientRect(),settings=document.getElementById('host-workspace-region').getBoundingClientRect();
        const x=Math.ceil(settings.left)+1,y=Math.ceil(settings.top)+1;
        return {x,y,width:Math.floor(Math.min(my.right,settings.right,innerWidth)-x)-1,height:Math.floor(Math.min(settings.bottom,innerHeight)-y)-1};
      });
      assert.ok(overlap.width>40&&overlap.height>100);
      before=await page.screenshot({clip:overlap});
      await page.locator('#underlay-clip-probe').evaluate(n=>{n.style.backgroundColor='#00ff00';});
      coveredUnderlay=await page.screenshot({clip:overlap});
    }
    finally{await page.locator('#underlay-clip-probe').evaluate(n=>n.remove());}
    if(process.env.BILIKARA_MOBILE_UI_EVIDENCE){
      const directory=process.env.BILIKARA_MOBILE_UI_EVIDENCE;mkdirSync(directory,{recursive:true});
      writeFileSync(path.join(directory,'settings-overlap.png'),before);
      writeFileSync(path.join(directory,'settings-overlap-sentinel.png'),coveredUnderlay);
    }
    assert.equal(Buffer.compare(before,coveredUnderlay),0,'My must not paint anywhere covered by the transparent Settings page, including its lower blank space');
    assert.equal(await page.locator('#android-my-page').isVisible(),true);
    await nativeProgress('cancelled',.25);
    await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region,.mobile-navigation-header')]
      .flatMap(node=>node.getAnimations().map(animation=>animation.finished))));
    assert.equal(await page.evaluate(()=>history.state.hostLayout.settings),true);
    await nativeProgress('began',0);await nativeProgress('changed',.6);await nativeProgress('ended',.6);
    await page.locator('#host-workspace-settings').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>history.length),nativeLength);
    assert.deepEqual(await page.locator('#android-my-page,#host-workspace-region').evaluateAll(nodes=>nodes.map(n=>n.style.clipPath)),['',''],'finished navigation removes its temporary clipping');
  });

for (const platform of ['desktop', 'android', 'ios']) test(`${platform} display discovery distinguishes unsupported, empty, busy, failed and mirroring states`,
  {skip:unavailable,timeout:90000}, async t => {
    const {page} = await open(t, platform);
    const list = page.locator('#presentation-display-list');
    assert.equal(await list.getAttribute('data-discovery-status'), 'unsupported');
    assert.ok((await list.textContent()).trim().length > 10, 'unsupported UI must not be blank');
    assert.equal(await page.locator('#presentation-refresh-button').isDisabled(), true);
    await page.evaluate(() => {
      // Controlled discovery responses verify shared UI classification, not
      // physical AirPlay, Android display enumeration or UIKit Scene support.
      window.BilikaraAndroidPresentation = {invoke: async () => ({displays: []})};
    });
    for (const [expected, info, busy, error] of [
      ['discovering', null, true, ''], ['no_targets', {displays: []}, false, ''],
      ['failed', {displays: []}, false, 'enumeration failed'],
      ['mirroring_only', {displays: [], discoveryStatus: 'mirroring_only'}, false, ''],
      ['mirroring_only', {displays: [{id:'mirror',name:'Mirror',selectable:false,mirrored:true,controller:false}]}, false, ''],
      ['failed', {displays: null}, false, ''],
      ['failed', {displays: {}}, false, ''], ['failed', {displays: [null]}, false, ''],
    ]) {
      await page.evaluate(({info, busy, error}) => {
        state.presentationDisplayInfo = info; state.presentationDisplayBusy = busy;
        state.presentationDisplayError = error; state.presentationOutputRenderSignature = '';
        renderPresentationOutputControl();
      }, {info, busy, error});
      assert.equal(await list.getAttribute('data-discovery-status'), expected);
      assert.ok((await list.textContent()).trim().length > 0);
      assert.equal(await page.locator('#presentation-output-button').isDisabled(), true);
    }
    await page.evaluate(() => {
      state.presentationDisplayInfo = {displays: [{id: 'external', name: 'Fixture display', selectable: true,
        controller: false, primary: false, builtIn: false, mirrored: false, width: 1920, height: 1080}], monitorCount: 1};
      state.presentationOutputRenderSignature = '';
      renderPresentationOutputControl();
    });
    assert.equal(await list.getAttribute('data-discovery-status'), 'available');
    assert.equal(await list.locator('[data-presentation-display-id="external"]').count(), 1);
  });
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
  await page.waitForFunction(()=>window.BilikaraHostLayout && window.BilikaraIOSHost && state.hostPlaybackSession?.readyCommitted
    && document.querySelectorAll('#player-frame video, #player-frame audio').length === 2
    && [...document.querySelectorAll('#player-frame video, #player-frame audio')].every(node=>node.duration>=89.9));
  await page.evaluate(()=>{
    window.mobileMedia=[...document.querySelectorAll('#player-frame video, #player-frame audio')].map(node=>({node,parent:node.parentElement}));
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

test('iOS compact dock reserves the safe area once and grows for larger navigation text', {skip:unavailable,timeout:120000}, async t=>{
  const {page}=await open(t,'ios');
  await go(page,'my');
  await page.evaluate(()=>document.documentElement.style.setProperty('--ios-safe-top','47px'));
  for (const width of [320,393,430]) for (const font of [16,24]) for (const bottom of [0,34]) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(({font,bottom})=>{
      document.documentElement.style.fontSize=`${font}px`;
      document.documentElement.style.setProperty('--ios-safe-bottom',`${bottom}px`);
      setLanguage('zh');
    },{font,bottom});
    await page.waitForFunction(({font,bottom})=>{
      const dock=document.getElementById('android-host-dock');
      const buttonHeight=parseFloat(document.documentElement.style.getPropertyValue('--ios-dock-button-height'));
      const height=dock.getBoundingClientRect().height;
      return (font===16 ? height===56+bottom : height>=63+bottom)
        && Number.isFinite(buttonHeight)&&Math.abs(height-buttonHeight-11-bottom)<1
        && [...dock.querySelectorAll('button > span')].filter(n=>n.getClientRects().length)
          .every(n=>n.scrollWidth<=n.clientWidth+1&&n.scrollHeight<=n.clientHeight+1);
    },{font,bottom});
    const measured=await page.locator('#android-host-dock').evaluate((dock,bottom)=>{
      const box=dock.getBoundingClientRect(),style=getComputedStyle(dock);
      const buttons=[...dock.querySelectorAll('button')].map(node=>{
        const b=node.getBoundingClientRect();
        return {width:b.width,height:b.height,bottom:b.bottom,left:b.left,right:b.right,
          labels:[...node.querySelectorAll('span')].filter(n=>n.getClientRects().length).map(n=>({width:n.clientWidth,scroll:n.scrollWidth,height:n.clientHeight,scrollHeight:n.scrollHeight})),
          icon:[node.querySelector('svg').getBoundingClientRect().width,node.querySelector('svg').getBoundingClientRect().height]};
      });
      return {height:box.height,bottom:box.bottom,main:box.height-bottom,padding:parseFloat(style.paddingBottom),buttons};
    },bottom);
    assert.equal(measured.bottom,844);
    assert.equal(measured.padding,6+bottom);
    if(font===16) assert.equal(measured.main,56,JSON.stringify({width,font,bottom,measured}));
    else assert.ok(measured.main>=56);
    assert.equal(measured.buttons.length,5);
    for(const target of measured.buttons){
      assert.ok(target.width>=44&&target.height>=44&&target.left>=0&&target.right<=width&&target.bottom<=844-bottom);
      assert.deepEqual(target.icon,[24,24]);
      for(const label of target.labels){assert.ok(label.scroll<=label.width+1);assert.ok(label.scrollHeight<=label.height+1);}
    }
    if(width===393&&font===16&&bottom===34) await screenshot(page,'ios-compact-dock-safe-area');
    if(width===320&&font===24&&bottom===34) await screenshot(page,'ios-compact-dock-large-text');
  }
});


test('iOS native dock mirrors shared routes, reserves height once and keeps modal geometry and hides for fullscreen', {skip:unavailable,timeout:120000}, async t => {
  const {page} = await open(t,'ios',{nativeDock:true});
  await page.waitForFunction(()=>document.documentElement.dataset.iosNativeDock==='true');
  const labels = await page.locator('#android-host-dock button').evaluateAll(buttons => buttons.map(button =>
    [...button.querySelectorAll(':scope > span')].find(label => getComputedStyle(label).display !== 'none')?.textContent.trim().replace(/\s+/g,' ')));
  assert.deepEqual(await page.evaluate(()=>nativeDockRequests.at(-1).labels), labels, 'native labels exclude hidden short/full duplicates');
  assert.equal(await page.locator('#android-host-dock').isVisible(),false);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-height').trim()),'83px');
  await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}})));
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.selected===4);
  assert.equal(await page.locator('#android-my-page').isVisible(),true);
  await page.evaluate(() => {
    applyTheme('blue');
    for (const index of [0,2,3,4]) dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index}}));
  });
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.selected===4 && nativeDockRequests.at(-1)?.accent[1]===210);
  assert.deepEqual(await page.evaluate(()=>nativeDockRequests.at(-1).accent), [0,210,255]);
  assert.ok(await page.evaluate(()=>nativeDockRequests.every((v,i,list)=>!i || v.sequence>list[i-1].sequence)));
  await page.evaluate(()=>document.getElementById('purek-modal').classList.remove('hidden'));
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.modal_covered===true && nativeDockRequests.at(-1)?.interactive===false);
  assert.equal(await page.evaluate(()=>nativeDockRequests.at(-1).visible),true);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-height').trim()),'83px');
  await page.evaluate(()=>document.getElementById('purek-modal').classList.add('hidden'));
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.visible===true && nativeDockRequests.at(-1)?.interactive===true);
  await page.evaluate(()=>document.body.classList.add('is-tauri-fullscreen-active'));
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.visible===false);
  await page.evaluate(()=>document.body.classList.remove('is-tauri-fullscreen-active'));
  await page.waitForFunction(()=>nativeDockRequests.at(-1)?.visible===true);
});


test('iOS native dock failure retains the accessible Web navigation fallback', {skip:unavailable,timeout:120000}, async t => {
  const {page} = await open(t,'ios',{nativeDock:'unavailable'});
  await page.waitForFunction(()=>nativeDockRequests.length>0);
  assert.equal(await page.locator('#android-host-dock').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.iosNativeDock),undefined);
  await go(page,'my');
  assert.equal(await page.locator('#android-my-page').isVisible(),true);
});

for (const platform of ['desktop','android','ios']) test(`${platform} part selection opens above details and cancel preserves its request context`,
  {skip:unavailable,timeout:60000},async t=>{
    const {page}=await open(t,platform,{expectedHttpErrors:['/api/playlist/add']});
    if(platform==='desktop')await page.locator('#work-rail-request').click();else await go(page,'request');
    let requests=0;
    await page.route('**/api/playlist/add',async route=>{
      requests++;
      return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,error:'Select parts',code:'manual_binding_required',binding:{preferred_page:1,pages:[{page:1,part:'Video'},{page:2,part:'Instrumental'}]}})});
    });
    await page.evaluate(()=>{
      document.getElementById('search-query').value='preserved search draft';
      searchDetailController.open({url:'https://www.bilibili.com/video/BV17x411w7KC',bvid:'BV17x411w7KC',title:'Part selection regression'});
    });
    const detail=page.locator('.song-detail-view:not(.hidden)'),button=detail.locator('[data-song-detail-request]');
    for(let attempt=0;attempt<2;attempt++){
      await button.click();await page.locator('#binding-modal').waitFor({state:'visible'});
      await page.locator('#binding-modal .selection-modal-card').evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
      const hit=await page.locator('#binding-modal-cancel').evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
      assert.equal(hit,true,'part dialog must receive input above its still-open detail dialog');
      await page.locator('#binding-audio-options input[value="2"]').check();
      await page.locator('#binding-modal-cancel').click();
      assert.equal(await detail.isVisible(),true);
      assert.equal(await detail.locator('[data-song-detail-title]').textContent(),'Part selection regression');
      assert.equal(await page.locator('#search-query').inputValue(),'preserved search draft');
      assert.equal(await button.isEnabled(),true);
    }
    assert.equal(requests,2,'cancel does not submit a request or duplicate handlers');
  });

for(const platform of ['android','ios'])test(`${platform} unframed phone pages keep dock overlays, dividers and reachable final controls`,{skip:unavailable,timeout:60000},async t=>{
  const {page}=await open(t,platform,{media:true,nativeDock:platform==='ios'});
  const visit=async name=>{
    if(platform==='ios')await page.evaluate(index=>window.dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index}})),['playback','queue','request','users','my'].indexOf(name));
    else await go(page,name);
    await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region')].flatMap(n=>n.getAnimations().map(a=>a.finished))));
  };
  await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
  await page.evaluate(()=>{const s=state.hostPlaybackSession;setSplitPlaybackIntent(s.video,s.audio,false);window.pageScrollPair={session:s,video:s.video,audio:s.audio};});
  await page.setViewportSize({width:393,height:520});
  for(const name of ['playback','my']){
    await visit(name);
    const selector=name==='playback'?'#stage-control-tray':'.android-my-scroll';
    const frameBefore=await page.locator('#player-frame').boundingBox();
    const result=await page.locator(selector).evaluate((n,name)=>{
      n.scrollTop=n.scrollHeight;
      const r=n.getBoundingClientRect(),dock=document.getElementById('android-host-dock').getBoundingClientRect();
      const last=n.lastElementChild;
      const end=last.getBoundingClientRect();
      return {bottom:r.bottom,dockTop:dock.top,dockBottom:dock.bottom,scroll:n.scrollTop,lastBottom:end.bottom,overflow:n.scrollHeight-n.clientHeight};
    },name);
    if(name==='my')assert.ok(result.bottom>=result.dockBottom-1,'My scroller continues behind the floating dock: '+JSON.stringify(result));
    else {
      assert.ok(result.bottom>=result.dockBottom-1,'Playback scroll content extends behind the dock: '+JSON.stringify(result));
      const frameAfter=await page.locator('#player-frame').boundingBox();
      assert.deepEqual(frameAfter,frameBefore,'control scrolling keeps the stage fixed');
      assert.equal(await page.locator('.left-column').evaluate(n=>n.scrollTop),0);
    }
    assert.ok(result.overflow>0&&result.scroll>0,'short pages expand instead of clipping their last groups');
    assert.ok(result.lastBottom<=result.dockTop-12,'last group can be reached above the dock: '+JSON.stringify(result));
    if(name==='my'){
      for(const theme of ['light','dark','blue']){
        await page.evaluate(theme=>applyTheme(theme),theme);
        const groups=await page.locator('.android-my-scroll > .android-my-card').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>{const s=getComputedStyle(n);return {border:s.borderTopWidth,bg:s.backgroundColor,radius:s.borderRadius,padding:s.padding,margin:s.marginBottom};}));
        assert.ok(groups.length>=3);
        assert.ok(groups.every(g=>g.border==='1px'&&g.bg!=='rgba(0, 0, 0, 0)'&&g.radius==='14px'&&g.padding==='14px'&&g.margin==='0px'),JSON.stringify(groups));
        const rows=await page.locator('#cache-panel > .cache-panel-row').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>{const s=getComputedStyle(n);return {border:s.borderTopWidth,top:s.paddingTop,bottom:s.paddingBottom};}));
        assert.ok(rows.length>=4);assert.equal(rows[0].border,'0px');assert.equal(rows[0].top,'0px');assert.equal(rows.at(-1).bottom,'0px');
        assert.ok(rows.slice(1).every(r=>r.border==='1px'),'only internal functional rows have dividers');
      }
      await page.evaluate(()=>applyTheme('light'));
    }
  }
  await visit('queue');
  const gap=await page.evaluate(()=>document.getElementById('queue-current').getBoundingClientRect().top-document.getElementById('android-queue-tabs').getBoundingClientRect().bottom);
  assert.ok(gap>=12&&gap<=20,'tabs retain a readable gap above the first song: '+gap);
  const padding=await page.locator('#queue-current').evaluate(n=>[getComputedStyle(n).paddingTop,getComputedStyle(n).paddingBottom]);assert.deepEqual(padding,['8px','8px']);
  assert.equal(await page.evaluate(()=>pageScrollPair.session===state.hostPlaybackSession&&pageScrollPair.video===state.hostPlaybackSession.video&&pageScrollPair.audio===state.hostPlaybackSession.audio),true,'layout and scrolling retain the same media pair');
});

for(const [platform,nativeDock] of [['android',false],['ios',false],['ios',true]])test(
  `${platform} ${nativeDock?'native':'web'} dock keeps the playback scrollbar outside the controls [IOS-09-02]`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform,{media:true,keyboard:true,nativeDock});
    await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await page.evaluate(()=>{
      const session=state.hostPlaybackSession;setSplitPlaybackIntent(session.video,session.audio,false);
      window.playbackScrollNodes={session,video:session.video,audio:session.audio};
    });
    const samples=[];
    for(const [width,height] of [[320,568],[375,667],[393,852],[430,932],[393,520]]){
      await page.setViewportSize({width,height});
      for(const theme of ['light','dark','blue']){
        await page.evaluate(theme=>applyTheme(theme),theme);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const stageBefore=await page.locator('#player-frame').boundingBox();
        await page.locator('#stage-control-tray').evaluate(n=>{n.scrollTop=n.scrollHeight;});
        const sample=await page.evaluate(()=>{
          const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
          const tray=document.getElementById('stage-control-tray'),last=document.getElementById('key-shift-panel');
          const glow=getComputedStyle(document.querySelector('.player-panel'),'::before');
          return {viewport:innerWidth,scroller:rect('#stage-control-tray'),controls:rect('#stage-extended-controls'),last:rect('#key-shift-panel'),dock:rect('#android-host-dock'),
            buttons:[...last.querySelectorAll('button,input')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}),
            overflow:tray.scrollHeight-tray.clientHeight,scrollTop:tray.scrollTop,glowVisible:glow.display!=='none'&&glow.content!=='none',
            outerScroll:[document.scrollingElement.scrollTop,document.querySelector('.left-column').scrollTop]};
        });
        samples.push({width,height,theme,...sample});
        if(process.env.BILIKARA_MOBILE_UI_EVIDENCE){
          const out=process.env.BILIKARA_MOBILE_UI_EVIDENCE;mkdirSync(out,{recursive:true});
          writeFileSync(path.join(out,`playback-scroll-${platform}-${nativeDock?'native':'web'}.json`),JSON.stringify(samples,null,2));
          if(samples.length===1||(width===393&&height===520&&theme==='light'))await page.screenshot({path:path.join(out,`playback-scroll-${platform}-${nativeDock?'native':'web'}.png`)});
        }
        assert.equal(sample.glowVisible,false,'mobile inline playback has no residual glow');
        assert.ok(Math.abs(sample.scroller.right-width)<=1&&Math.abs(sample.scroller.left)<=1,'the scrollbar viewport reaches the outer page edge: '+JSON.stringify(sample));
        assert.ok(Math.abs(sample.controls.left-14)<=1&&Math.abs(width-sample.controls.right-14)<=1,'the white controls keep equal 14px outer gutters: '+JSON.stringify(sample));
        assert.ok(Math.abs(sample.scroller.bottom-sample.dock.bottom)<1,'the scrolling page extends to the viewport bottom: '+JSON.stringify(sample));
        assert.ok(sample.last.top>=sample.scroller.top-1&&sample.last.bottom<=Math.min(sample.scroller.bottom,sample.dock.top-12)+1&&sample.buttons.every(r=>r.top>=sample.scroller.top-1&&r.bottom<=sample.scroller.bottom+1),'the complete final group, labels and controls remain reachable: '+JSON.stringify(sample));
        assert.deepEqual(sample.outerScroll,[0,0]);
        assert.deepEqual(await page.locator('#player-frame').boundingBox(),stageBefore,'only the lower control region scrolls');
      }
    }
    await page.setViewportSize({width:393,height:667});
    await page.locator('#stage-extended-controls .section-tag,#stage-extended-controls input').evaluateAll(nodes=>nodes.forEach(n=>{n.style.fontSize='20px';}));
    for(const language of ['zh','en','ja']){
      await page.evaluate(language=>setLanguage(language),language);
      if(platform==='ios'){
        assert.equal(await page.locator('#key-shift-input').isEnabled(),true);
        await page.locator('#key-shift-input').focus();
        await page.evaluate(()=>{visualViewport.height=410;visualViewport.dispatchEvent(new Event('resize'));});
        await page.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-ime-height'))>200);
      }
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.locator('#stage-control-tray').evaluate(n=>{n.scrollTop=n.scrollHeight;});
      const final=await page.evaluate(()=>{
        const tray=document.getElementById('stage-control-tray').getBoundingClientRect(),last=document.getElementById('key-shift-panel').getBoundingClientRect();
        return {top:tray.top,bottom:tray.bottom,lastTop:last.top,lastBottom:last.bottom,keyboardTop:visualViewport.height,
          field:document.getElementById('key-shift-input').getBoundingClientRect().bottom};
      });
      assert.ok(final.lastTop>=final.top-1&&final.lastBottom<=final.bottom+1,JSON.stringify({language,...final}));
      if(platform==='ios')assert.ok(final.bottom<=final.keyboardTop&&final.field<=final.keyboardTop,JSON.stringify(final));
    }
    if(platform==='ios'){
      await page.locator('#key-shift-input').blur();
      await page.evaluate(()=>{visualViewport.height=innerHeight;visualViewport.dispatchEvent(new Event('resize'));});
      await page.waitForFunction(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-ime-height'))===0);
    }
    assert.equal(await page.evaluate(()=>playbackScrollNodes.session===state.hostPlaybackSession&&playbackScrollNodes.video===state.hostPlaybackSession.video&&playbackScrollNodes.audio===state.hostPlaybackSession.audio),true,'geometry changes never replace media');
  });

for(const [platform,nativeDock] of [['android',false],['ios',false],['ios',true]])test(
  `${platform} ${nativeDock?'native':'web'} queue uses the available height and outer scrollbar [IOS-09-08]`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform,{media:true,nativeDock});
    await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await page.evaluate(()=>{
      fetchState=async()=>{};state.eventSource?.close();
      const session=state.hostPlaybackSession;setSplitPlaybackIntent(session.video,session.audio,false);
      window.queueCapacityMedia={session,video:session.video,audio:session.audio};
      state.data.playlist=Array.from({length:12},(_,i)=>({id:`capacity-${i}`,display_title:`歌曲 ${i+1}：保持自然高度的两行标题与点歌信息`,requester_name:'Fixture singer',cache_status:'pending'}));
      render();
    });
    if(nativeDock)await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:1}})));
    else await go(page,'queue');
    const evidence=process.env.BILIKARA_CAPACITY_EVIDENCE,samples=[];
    let previousCount=0;
    for(const [width,height] of [[320,568],[375,667],[393,852],[430,932],[430,1024]]){
      await page.setViewportSize({width,height});
      if(platform==='ios')await page.evaluate(()=>{
        document.documentElement.style.setProperty('--ios-safe-top','59px');
        document.documentElement.style.setProperty('--ios-safe-bottom','34px');
      });
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.locator('#playlist').evaluate(n=>{n.scrollTop=0;});
      const sample=await page.evaluate(()=>{
        const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width};};
        const q=s=>rect(document.querySelector(s)),list=document.getElementById('playlist'),port=rect(list);
        const cards=[...list.querySelectorAll('.song-item')].map(rect),style=getComputedStyle(list),dock=q('#android-host-dock');
        return {width:innerWidth,height:innerHeight,heading:q('.topbar'),tabs:q('.android-page-tools'),stage:q('#host-workspace-queue .list-stage'),current:q('#queue-current'),port,
          firstTwo:cards.slice(0,2),complete:1+cards.filter(r=>r.top>=port.top-.5&&r.bottom<=Math.min(port.bottom,dock.top)+.5).length,
          currentToPending:cards[0].top-document.getElementById('queue-current').getBoundingClientRect().bottom,
          gap:parseFloat(style.rowGap),scrollRange:list.scrollHeight-list.clientHeight,scrollable:list.classList.contains('is-scrollable'),dock:q('#android-host-dock')};
      });
      samples.push(sample);
      if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`queue-capacity-${platform}-${nativeDock?'native':'web'}.json`),JSON.stringify(samples,null,2));}
      assert.ok(sample.current.top>=sample.tabs.bottom-.5,'the first song clears the tabs');
      assert.ok(sample.complete>=previousCount,'more available height cannot reduce complete row capacity');previousCount=sample.complete;
      const required=sample.current.height+sample.currentToPending+sample.firstTwo[0].height+sample.gap+sample.firstTwo[1].height;
      if(sample.dock.top-sample.stage.top>=required)assert.ok(sample.complete>=3,JSON.stringify(sample));
      else assert.ok(height<=667,'only physically constrained phones may require scrolling for the third row');
      assert.ok(Math.abs(sample.port.bottom-sample.dock.bottom)<1,JSON.stringify(sample));
      assert.ok(Math.abs(sample.port.left)<1&&Math.abs(sample.port.right-width)<1,'queue scrollbar belongs at the page edge: '+JSON.stringify(sample));
      assert.equal(sample.scrollable,true,'overflow must become scrollable after resize');
      await page.locator('#playlist').evaluate(n=>{n.scrollTop=n.scrollHeight;});
      const last=await page.locator('#playlist .song-item').last().boundingBox();
      assert.ok(last.y>=sample.port.top-.5&&last.y+last.height<=sample.dock.top-12+.5,'the final complete card stays above the dock');
      if(evidence&&width===393)await page.screenshot({path:path.join(evidence,`queue-bottom-${platform}-${nativeDock?'native':'web'}.png`)});
      await page.locator('#playlist').evaluate(n=>{n.scrollTop=30;});
      const scroll=await page.locator('#playlist').evaluate(n=>n.scrollTop);
      if(nativeDock)await page.evaluate(()=>{dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}}));dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:1}}));});
      else {await go(page,'my');await go(page,'queue');}
      assert.ok(Math.abs(await page.locator('#playlist').evaluate(n=>n.scrollTop)-scroll)<1,'navigation preserves the queue scroll position');
    }
    await page.setViewportSize({width:844,height:393});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.setViewportSize({width:393,height:520});
    await page.evaluate(()=>{document.documentElement.style.fontSize='20px';setLanguage('ja');});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.locator('#playlist .song-item').last().evaluate(n=>n.scrollIntoView({block:'end'}));
    const short=await page.locator('#playlist .song-item').last().evaluate(n=>{let owner=n.parentElement;while(owner&&getComputedStyle(owner).overflowY!=='auto')owner=owner.parentElement;const r=n.getBoundingClientRect(),p=owner.getBoundingClientRect(),stage=n.closest('.list-stage').getBoundingClientRect(),dock=document.getElementById('android-host-dock').getBoundingClientRect();return {row:r.toJSON(),port:p.toJSON(),stage:stage.toJSON(),dock:dock.toJSON(),scrollTop:owner.scrollTop,range:owner.scrollHeight-owner.clientHeight,outerScroll:document.scrollingElement.scrollTop,
      listHeight:n.parentElement.getBoundingClientRect().height,listPadding:getComputedStyle(n.parentElement).paddingBottom,stageClass:n.closest('.list-stage').className,rowShrink:getComputedStyle(n).flexShrink,listRows:[...n.parentElement.children].slice(-2).map(n=>n.getBoundingClientRect().height),
      stageGrid:getComputedStyle(n.closest('.list-stage')).gridTemplateRows,listMax:getComputedStyle(n.parentElement).maxHeight,listOverflow:[getComputedStyle(n.parentElement).overflowX,getComputedStyle(n.parentElement).overflowY],listStyle:n.parentElement.getAttribute('style')};});
    if(evidence){writeFileSync(path.join(evidence,`queue-short-${platform}-${nativeDock?'native':'web'}.json`),JSON.stringify(short,null,2));await page.screenshot({path:path.join(evidence,`queue-short-${platform}-${nativeDock?'native':'web'}.png`)});}
    assert.ok(short.row.top>=short.port.top-.5&&short.row.bottom<=Math.min(short.port.bottom,short.dock.top)+.5,'short and enlarged text still reaches the complete final song: '+JSON.stringify(short));
    assert.equal(short.outerScroll,0,'short-screen scrolling stays inside the queue');
    if(nativeDock)await page.evaluate(()=>{dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}}));dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:1}}));});
    else {await go(page,'my');await go(page,'queue');}
    assert.equal(await page.locator('#playlist .song-item').last().evaluate(n=>{const r=n.getBoundingClientRect(),stage=n.closest('.list-stage').getBoundingClientRect();return r.top>=stage.top-.5&&r.bottom<=stage.bottom+.5;}),true,'the short-screen queue restores its scroll position after navigation');
    await page.evaluate(()=>{document.documentElement.style.fontSize='16px';setLanguage('zh');});
    await page.setViewportSize({width:393,height:852});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
    assert.equal(await page.locator('#queue-current').evaluate(n=>{const r=n.getBoundingClientRect(),stage=n.closest('.list-stage').getBoundingClientRect();return r.top>=stage.top-.5&&r.bottom<=stage.bottom+.5;}),true,'a taller screen restores the stationary natural-height current card');
    await page.evaluate(()=>{state.data.history=Array.from({length:12},(_,i)=>({display_title:`历史歌曲 ${i}`,requested_at:1700000000+i,request_count:1,requester_name:'Fixture singer',original_url:`https://www.bilibili.com/video/BV17x411w7KC?p=${i+1}`}));renderHistory(state.data.history);});
    await page.locator('[data-android-workspace="history"]').click();
    await page.locator('#history-list').evaluate(n=>{n.scrollTop=n.scrollHeight;});
    assert.equal(await page.locator('#history-list').evaluate(n=>{const r=n.getBoundingClientRect(),last=n.lastElementChild.getBoundingClientRect(),dock=document.getElementById('android-host-dock').getBoundingClientRect();return Math.abs(r.left)<1&&Math.abs(r.right-innerWidth)<1&&last.top>=r.top-.5&&last.bottom<=Math.min(r.bottom,dock.top)+.5;}),true,'History shares the outer scrollbar and fully reachable last row');
    assert.equal(await page.evaluate(()=>queueCapacityMedia.session===state.hostPlaybackSession&&queueCapacityMedia.video===state.hostPlaybackSession.video&&queueCapacityMedia.audio===state.hostPlaybackSession.audio),true,'capacity changes retain live media ownership');
  });

for(const [platform,nativeDock] of [['android',false],['ios',false],['ios',true]])test(
  `${platform} ${nativeDock?'native':'web'} Settings moves its header with the page and cancels cleanly [IOS-09-03]`,
  {skip:unavailable,timeout:90000},async t=>{
    const {page}=await open(t,platform,{media:true,nativeDock});
    const moving='#android-my-page,#host-workspace-region,.mobile-navigation-header';
    const settle=()=>page.evaluate(selector=>Promise.allSettled([...document.querySelectorAll(selector)].flatMap(n=>n.getAnimations().map(a=>a.finished))),moving);
    const finish=()=>page.evaluate(async()=>{const motion=window.headerMotion||[];motion.forEach(a=>a.finish());await Promise.allSettled(motion.map(a=>a.finished));await new Promise(requestAnimationFrame);});
    const clickAndPause=selector=>page.evaluate(({selector,moving})=>{
      document.querySelector(selector).click();
      window.headerMotion=[...document.querySelectorAll(moving)].flatMap(n=>n.getAnimations());
      headerMotion.forEach(a=>{a.pause();a.currentTime=100;});
    },{selector,moving});
    const sample=()=>page.evaluate(()=>{
      const rect=id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return {x:r.x,contentX:r.x+parseFloat(getComputedStyle(n).paddingLeft),y:r.y,width:r.width,height:r.height,visible:r.height>0&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('[hidden]')};};
      return {my:rect('android-my-page'),settings:rect('host-workspace-region'),title:rect('android-my-title'),back:rect('android-settings-back'),dock:rect('android-host-dock')};
    });
    await page.setViewportSize({width:393,height:736});
    await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await page.evaluate(async()=>{
      fetchState=async()=>{};state.eventSource?.close();await document.fonts.ready;
      const session=state.hostPlaybackSession;setSplitPlaybackIntent(session.video,session.audio,true);
      window.headerMedia={session,nodes:[session.video,session.audio],parents:[session.video.parentElement,session.audio.parentElement],time:session.video.currentTime};
    });
    await page.waitForFunction(()=>headerMedia.nodes.every(n=>!n.paused));
    if(nativeDock)await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}})));
    else await go(page,'my');
    await page.locator('#android-my-scroll').evaluate(n=>{n.scrollTop=120;});
    const scroll=await page.locator('#android-my-scroll').evaluate(n=>n.scrollTop);
    assert.ok(scroll>0,'the scroll restoration case must start at a nonzero offset');
    const my=await sample();
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#android-open-settings').click();
    const settings=await sample();
    await page.locator('#android-settings-back').click();await page.emulateMedia({reducedMotion:'no-preference'});
    const check=(value)=>{
      assert.equal(value.title.visible,true,'the original My title remains visible during the transition');
      assert.equal(value.back.visible,true,'the original Back control remains visible during the transition');
      assert.ok(Math.abs((value.title.x-my.title.x)-(value.my.contentX-my.my.contentX))<1,'My title and content have the same translation inside the viewport frame: '+JSON.stringify(value));
      assert.ok(Math.abs((value.back.x-settings.back.x)-(value.settings.contentX-settings.settings.contentX))<1,'Settings Back and content have the same translation inside the viewport frame: '+JSON.stringify(value));
      assert.ok(Math.abs(value.title.y-my.title.y)<1&&Math.abs(value.back.y-settings.back.y)<1,'navigation retains the header vertical axes');
      assert.deepEqual(value.dock,my.dock,'the global dock never moves');
    };
    const evidence=process.env.BILIKARA_NAVIGATION_EVIDENCE,samples=[];
    await page.locator('#android-open-settings').focus();
    await clickAndPause('#android-open-settings');const forward=await sample();samples.push({phase:'forward',...forward});
    if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`header-${platform}-${nativeDock?'native':'web'}.json`),JSON.stringify({scroll,my,settings,samples},null,2));await page.screenshot({path:path.join(evidence,`forward-${platform}-${nativeDock?'native':'web'}.png`)});}
    check(forward);await finish();
    assert.equal(await page.locator('#android-settings-back').evaluate(n=>n===document.activeElement),true,'opening Settings transfers focus to Back');
    await clickAndPause('#android-settings-back');const backward=await sample();samples.push({phase:'backward',...backward});check(backward);await finish();
    assert.equal(await page.locator('#android-open-settings').evaluate(n=>n===document.activeElement),true,'Back returns focus to the Settings entry');
    assert.equal(await page.locator('#android-my-scroll').evaluate(n=>n.scrollTop),scroll);
    if(platform==='ios'){
      await page.locator('#android-open-settings').click();await settle();
      await page.locator('#android-settings-back').focus();
      const native=(phase,progress)=>page.evaluate(({phase,progress})=>{document.documentElement.dataset.iosNativeBack='true';dispatchEvent(new CustomEvent('bilikara:ios-back',{detail:{phase,progress,velocity:0}}));},{phase,progress});
      const length=await page.evaluate(()=>history.length);
      await native('began',0);await native('changed',.4);
      const edge=await sample();samples.push({phase:'interactive',...edge});check(edge);
      if(evidence)await page.screenshot({path:path.join(evidence,`interactive-${platform}-${nativeDock?'native':'web'}.png`)});
      // Only the color changes between captures, keeping fractional-position
      // text rasterization stable while proving the covered header is clipped.
      await page.locator('.mobile-navigation-header[data-page="my"]').evaluate(n=>{
        const probe=document.createElement('div');probe.id='header-clip-probe';probe.setAttribute('aria-hidden','true');
        probe.style.cssText='position:absolute;inset:0;background:#ff00ff;z-index:2147483647;pointer-events:none;will-change:transform';n.append(probe);
      });
      try{
        const clip=await page.evaluate(()=>{
          const my=document.querySelector('.mobile-navigation-header[data-page="my"]').getBoundingClientRect();
          const settings=document.getElementById('host-workspace-region').getBoundingClientRect(),bar=document.querySelector('.topbar').getBoundingClientRect();
          const x=Math.ceil(settings.left)+1,y=Math.ceil(bar.top)+1;
          return {x,y,width:Math.floor(Math.min(my.right,innerWidth)-x)-1,height:Math.floor(bar.height)-2};
        });
        assert.ok(clip.width>40&&clip.height>40);
        const before=await page.screenshot({clip});
        await page.locator('#header-clip-probe').evaluate(n=>{n.style.backgroundColor='#00ff00';});
        const after=await page.screenshot({clip});
        assert.equal(Buffer.compare(before,after),0,'the transparent Settings header must not show its covered My header');
        if(evidence){writeFileSync(path.join(evidence,`header-overlap-${nativeDock?'native':'web'}.png`),before);writeFileSync(path.join(evidence,`header-overlap-sentinel-${nativeDock?'native':'web'}.png`),after);}
      }finally{await page.locator('#header-clip-probe').evaluate(n=>n.remove());}
      await native('cancelled',.4);await settle();
      assert.equal(await page.locator('#android-settings-back').evaluate(n=>n===document.activeElement),true,'cancelled edge Back restores focus');
      assert.equal(await page.evaluate(()=>history.state.hostLayout.settings),true);
      await native('began',0);await native('changed',.6);await native('ended',.6);await settle();
      assert.equal(await page.evaluate(()=>history.state.hostLayout.settings),false);assert.equal(await page.evaluate(()=>history.length),length);
    }
    await page.evaluate(()=>{
      for(let i=0;i<3;i++){document.getElementById('android-open-settings').click();document.getElementById('android-settings-back').click();}
    });await settle();
    assert.equal(await page.locator('.mobile-navigation-header').count(),0,'rapid reversals retire all temporary header nodes');
    assert.equal(await page.locator('#android-page-heading').evaluate(n=>n.contains(document.getElementById('android-my-title'))),true);
    await page.locator('#android-open-settings').click();await settle();await page.evaluate(()=>history.back());
    await page.waitForFunction(()=>history.state.hostLayout.settings===false);await settle();
    assert.equal(await page.locator('#android-my-page').isVisible(),true);
    assert.equal(await page.locator('#android-my-scroll').evaluate(n=>n.scrollTop),scroll);
    await page.locator('#android-open-settings').focus();
    await clickAndPause('#android-open-settings');
    await page.evaluate(()=>{window.headerResizeObserved=false;addEventListener('resize',()=>{window.headerResizeObserved=true;},{once:true});});
    await page.setViewportSize({width:390,height:800});await page.waitForFunction(()=>window.headerResizeObserved);
    assert.equal(await page.locator('.mobile-navigation-header').count(),0,'resize retires interrupted header layers');
    assert.equal(await page.locator('#android-settings-back').isVisible(),true);
    assert.equal(await page.locator('#android-settings-back').evaluate(n=>n===document.activeElement),true,'resize finishing Settings entry preserves destination focus');
    await page.locator('#android-settings-back').click();await settle();
    await clickAndPause('#android-open-settings');
    if(nativeDock)await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:1}})));
    else await go(page,'queue');
    assert.equal(await page.locator('.mobile-navigation-header').count(),0,'primary navigation retires interrupted header layers');
    assert.equal(await page.locator('#android-page-heading #workspace-queue-heading').isVisible(),true);
    if(nativeDock)await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:4}})));
    else await go(page,'my');
    for(const [width,height,language] of [[320,568,'en'],[430,932,'ja']]){
      await page.setViewportSize({width,height});await page.evaluate(language=>setLanguage(language),language);
      await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#android-open-settings').click();
      assert.equal(await page.locator('.mobile-navigation-header').count(),0,'reduced-motion routes commit without temporary layers');
      await page.locator('#android-settings-back').click();
    }
    assert.equal(await page.evaluate(()=>headerMedia.session===state.hostPlaybackSession&&headerMedia.nodes.every((n,i)=>n.isConnected&&n.parentElement===headerMedia.parents[i])),true,'navigation never reparents or recreates media');
    assert.equal(await page.evaluate(()=>headerMedia.nodes.every(n=>!n.paused)&&headerMedia.session.video.currentTime>headerMedia.time),true,'media continues playing throughout navigation');
    assert.equal(await page.locator('#host-workspace-region,#android-my-page').evaluateAll(nodes=>nodes.every(n=>!n.style.transform&&!n.style.clipPath&&!n.style.position)),true,'finished navigation releases temporary body styles');
    if(evidence)writeFileSync(path.join(evidence,`header-${platform}-${nativeDock?'native':'web'}.json`),JSON.stringify({scroll,my,settings,samples},null,2));
  });

for(const client of ['android','ios','remote'])test(`${client} Quick Request retains inset focus and viewport geometry in the real Host [IOS-09-09]`,
  {skip:unavailable,timeout:90000},async t=>{
    let {page,host}=await open(t,client==='remote'?'android':client,{keyboard:client==='ios'});
    const errors=[],advisories=[],samples=[];
    if(client==='remote'){
      const context=await page.context().browser().newContext({viewport:{width:393,height:852},hasTouch:true});
      await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());
      await context.addInitScript(()=>{
        window.focusConnectionAttempts=[];
        const original=window.fetch;
        window.fetch=function(resource,options){
          if(resource==='/api/remote/connection-diagnostic'){
            const record={event:JSON.parse(options.body).event,registered:state.remoteIdentity?.registered===true};
            window.focusConnectionAttempts.push(record);
            return original.apply(this,arguments).then(response=>{record.status=response.status;return response;});
          }
          return original.apply(this,arguments);
        };
      });
      const previous=page;page=await context.newPage();await previous.close();
      page.on('pageerror',error=>errors.push(error.message));
      page.on('response',response=>{const url=new URL(response.url());if(url.origin===host.base&&response.status()>=400)errors.push(`${url.pathname}: ${response.status()}`);});
      page.on('console',message=>{
        // WebKit ignores this existing Chromium viewport hint. Keep the exact
        // advisory in evidence; other console errors/warnings still fail.
        if(page.context().browser().browserType().name()==='webkit'&&['error','warning'].includes(message.type())&&message.text()==='Viewport argument key "interactive-widget" not recognized and ignored.')advisories.push({level:message.type(),message:message.text()});
        else if(['error','warning'].includes(message.type())&&!/^Failed to load resource:/.test(message.text()))errors.push(message.text());
      });
      await page.goto(host.base+'/remote');await page.locator('#remote-identity-input').fill('Focus tester');
      await page.locator('#remote-identity-submit').click();await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
      assert.equal(await page.title(),'bilikara remote');
    }else await go(page,'request');
    const expectedPath=client==='remote'?'/remote':'/';assert.equal(new URL(page.url()).pathname,expectedPath);
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(),0);
    const field=page.locator('#url-input'),heading=page.locator(client==='remote'?'.remote-header':'.topbar');
    await field.fill('Unsubmitted focus draft');await field.evaluate(n=>{window.originalFocusField=n;});
    const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await Promise.allSettled(document.getElementById('url-input').getAnimations().map(a=>a.finished));await new Promise(requestAnimationFrame);});
    const geometry=()=>page.evaluate(()=>{
      const rect=n=>n?.getBoundingClientRect().toJSON(),root=document.documentElement,style=getComputedStyle(root),vv=visualViewport;
      return {field:rect(document.getElementById('url-input')),header:rect(document.querySelector('.topbar,.remote-header')),rootScroll:[scrollX,scrollY],layout:[innerWidth,innerHeight,root.clientHeight],visual:vv?{top:vv.offsetTop,height:vv.height,scale:vv.scale}:null,ime:style.getPropertyValue('--mobile-ime-height'),safeTop:style.getPropertyValue('--ios-safe-top'),safeBottom:style.getPropertyValue('--ios-safe-bottom'),dock:rect(document.getElementById('android-host-dock'))};
    });
    for(const [width,height,language] of [[320,568,'zh'],[375,667,'en'],[393,852,'ja'],[430,932,'zh']]){
      await page.setViewportSize({width,height});
      for(const theme of ['light','dark','blue']){
        await page.evaluate(({language,theme})=>{setLanguage(language);applyTheme(theme);},{language,theme});await settle();
        // Scrolling the Remote document into view is an explicit test setup;
        // focus itself must preserve that viewport and the live input node.
        await field.scrollIntoViewIfNeeded();await field.evaluate(n=>n.blur());await settle();
        const before=await geometry(),header=await heading.boundingBox();
        await field.evaluate(n=>n.focus({preventScroll:true}));await settle();
        const focused=await field.evaluate(n=>{const s=getComputedStyle(n);return{width:parseFloat(s.outlineWidth),style:s.outlineStyle,offset:parseFloat(s.outlineOffset),value:n.value};});
        assert.ok(focused.style!=='none'&&focused.width>=2&&focused.offset+focused.width<=0,JSON.stringify({client,width,theme,focused}));
        assert.deepEqual(await heading.boundingBox(),header,'focusing a visible field does not move the header');
        assert.deepEqual((await geometry()).field,before.field,'focus does not change field dimensions or position');
        assert.equal(focused.value,'Unsubmitted focus draft');
        if(client==='ios'){
          await page.evaluate(()=>{visualViewport.offsetTop=0;visualViewport.height=innerHeight-220;visualViewport.dispatchEvent(new Event('resize'));});
          await page.waitForFunction(()=>BilikaraIOSHost.diagnostics().keyboard_inset===220);await settle();
          const keyboard=await geometry();
          assert.ok(keyboard.field.bottom+4<=keyboard.visual.height,'this case starts with a genuinely visible top field');
          assert.deepEqual(keyboard.field,before.field,'the visible top field is not scrolled for IME padding');
          assert.deepEqual(keyboard.header,before.header);assert.deepEqual(keyboard.rootScroll,before.rootScroll);
          await page.evaluate(()=>{visualViewport.offsetTop=24;visualViewport.height=innerHeight-244;visualViewport.dispatchEvent(new Event('scroll'));});await settle();
          const panned=await geometry();assert.deepEqual(panned.field,before.field,'native visual-viewport pan is not applied twice');
          samples.push({width,height,language,theme,before,keyboard,panned});
          await go(page,'queue');await page.waitForFunction(()=>BilikaraIOSHost.diagnostics().keyboard_inset===0);
          await page.evaluate(()=>{visualViewport.offsetTop=0;visualViewport.height=innerHeight;visualViewport.dispatchEvent(new Event('resize'));});await go(page,'request');
        }else samples.push({width,height,language,theme,before,after:await geometry()});
        assert.equal(await field.evaluate(n=>n===window.originalFocusField),true,'theme, language and navigation retain the mounted field');
      }
    }
    await host.api('/api/session-users/add',{name:'Focus refresh'});await page.evaluate(()=>fetchState());
    assert.equal(await field.evaluate(n=>n===window.originalFocusField&&n.value==='Unsubmitted focus draft'),true,'real state refresh preserves input identity and draft');
    const connectionAttempts=client==='remote'?await page.evaluate(()=>window.focusConnectionAttempts):[];
    const evidence=process.env.BILIKARA_FOCUS_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});await field.evaluate(n=>n.focus({preventScroll:true}));await settle();await page.screenshot({path:path.join(evidence,`app-${client}.png`)});writeFileSync(path.join(evidence,`app-${client}.json`),JSON.stringify({client,samples,errors,advisories,connectionAttempts,fixture:'Real isolated Rust Host; iOS VisualViewport is synthetic, not device IME evidence'},null,2));}
    assert.deepEqual(errors,[],JSON.stringify(connectionAttempts));
    if(client==='remote'){
      assert.ok(connectionAttempts.some(attempt=>attempt.event==='connected'&&attempt.status===200),'registered Remote still publishes connection diagnostics');
      assert.ok(connectionAttempts.every(attempt=>attempt.registered&&attempt.status===200),'only registered requests reach the authenticated diagnostic endpoint');
    }
  });
