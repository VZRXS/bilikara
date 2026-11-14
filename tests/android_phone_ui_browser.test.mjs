import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha;
before(async () => { if (process.platform !== 'linux') return; alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha(); }, {timeout:300000});
async function open(t, engine, {sessionUser = true} = {}) {
  const home = ownedDirectory('Android phone UI');
  t.after(() => rmSync(home, {recursive:true,force:true}));
  const host = await RunningHost.start(alpha, home, [home,path.join(root,'static')], isolatedEnvironment(home), true);
  t.after(() => host.close());
  if (sessionUser) await host.api('/api/session-users/add', {name:'Fixture singer'});
  const browser = await engine.launch({headless:true}); t.after(() => browser.close());
  const context = await browser.newContext({viewport:{width:393,height:736},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(() => {
    localStorage.setItem('bilikara.update.automatic','false');
    window.BilikaraHostWindow = {postMessage(raw) {
      if (['enter','exit'].includes(raw)) return;
      const {id}=JSON.parse(raw);
      queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));
    }};
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== host.base) return route.abort();
    // Catalog interaction is local: never forward a browse to the deployed service.
    if (/^\/api\/(d1\/|catalog\/)/.test(url.pathname)) return route.fulfill({json:{ok:true,data:{
      kind:url.searchParams.get('kind'),letter:url.searchParams.get('letter'),tags:[],items:[],categories:[],total:0,
    }}});
    return route.continue();
  });
  const page = await context.newPage(), errors=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base);
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse&&window.BilikaraHostLayout);
  await page.evaluate(()=>{setLanguage('zh');window.phoneMedia=[...document.querySelectorAll('video,audio')];});
  t.after(()=>assert.deepEqual(errors,[]));
  return {page,host};
}
const settle = page => page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region')]
  .flatMap(n=>n.getAnimations().map(a=>a.finished))));
const go = async (page,name) => {await page.locator(`[data-android-page="${name}"]`).click();await settle(page);};

for(const engine of [chromium,webkit])test(`${engine.name()} touch Host gates hover and keeps the QR action accessible`, {timeout:90000,skip:process.platform!=='linux'}, async t=>{
  const {page}=await open(t,engine);await go(page,'my');
  await page.evaluate(()=>{
    fetchState=async()=>{};state.eventSource?.close();
    state.data.bbdown.login={state:'waiting',logged_in:false,message:'请扫码登录'};renderBBDownLogin(state.data.bbdown.login);
  });
  const audit=await page.evaluate(()=>{
    const missing=[];let count=0;
    function visit(rules,gated=false){for(const rule of rules){
      const guard=gated||(rule.conditionText?.includes('(hover: hover)')&&rule.conditionText.includes('(pointer: fine)'));
      if(rule.selectorText?.includes(':hover')){count++;if(!guard)missing.push(rule.selectorText);}
      if(rule.cssRules)visit(rule.cssRules,guard);
    }}
    for(const sheet of document.styleSheets)visit(sheet.cssRules);
    return {missing,count,hover:matchMedia('(hover: hover) and (pointer: fine)').matches};
  });
  assert.equal(audit.hover,false);assert.ok(audit.count>40);assert.deepEqual(audit.missing,[],'all loaded Host hover rules require an actual hover-capable fine pointer');
  const button=page.locator('#bbdown-login-refresh');
  for(const theme of ['light','dark','blue']){
    await page.evaluate(theme=>applyTheme(theme),theme);await page.mouse.move(0,0);
    await button.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
    const normal=await button.evaluate(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return {height:r.height,font:s.fontSize,weight:s.fontWeight,line:s.lineHeight,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],radius:s.borderRadius,background:s.backgroundColor,border:s.border,transform:s.transform}});
    assert.ok(normal.height>=44);assert.equal(normal.transform,'none');
    assert.equal(await button.getAttribute('aria-label'),await page.evaluate(()=>t('service.regenerateQr')));
    assert.equal((await button.innerText()).trim(),'');
    await button.hover();
    assert.deepEqual(await button.evaluate(n=>{const s=getComputedStyle(n);return {background:s.backgroundColor,border:s.border,transform:s.transform}}),{background:normal.background,border:normal.border,transform:normal.transform},'sticky :hover on touch must not recolor or lift the action');
  }
  await page.keyboard.press('Tab');await button.focus();
  assert.equal(await button.evaluate(n=>n.matches(':focus-visible')),true);assert.notEqual(await button.evaluate(n=>getComputedStyle(n).outlineStyle),'none','keyboard focus stays visible');
  const touch=await page.evaluate(()=>{
    window.touchHoverPauses=0;pauseBackupBannerTimer=()=>touchHoverPauses++;
    state.backupDismissHover=false;
    elements.backupBanner.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'touch'}));
    elements.dismissBackupButton.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'touch'}));
    elements.backupBanner.dispatchEvent(new MouseEvent('mouseenter'));
    elements.dismissBackupButton.dispatchEvent(new MouseEvent('mouseenter'));
    return {pauses:touchHoverPauses,dismissHover:state.backupDismissHover};
  });assert.deepEqual(touch,{pauses:0,dismissHover:false});
  await page.setViewportSize({width:700,height:800});
  await page.locator('#remote-mini-trigger').focus();
  assert.equal(await page.locator('#remote-mini-popover').evaluate(n=>getComputedStyle(n).visibility),'hidden','touch focus cannot open the desktop QR hover annotation');
});

for (const engine of [chromium,webkit]) test(`${engine.name()} Android phone keeps chrome, contextual tabs, stage and translations bounded`, {timeout:120000,skip:process.platform!=='linux'}, async t=>{
  const {page}=await open(t,engine);
  // This layout case injects synthetic update states below. Live authoritative
  // snapshots must not overwrite them between the render and DOM assertion.
  await page.evaluate(()=>{state.eventSource?.close();fetchState=async()=>{};});
  for(const width of [320,393]) for(const language of ['zh','en','ja']) {
    await page.setViewportSize({width,height:736});await page.evaluate(language=>setLanguage(language),language);
    const dock=await page.locator('[data-android-page="users"]').evaluate(n=>{
      const icon=n.querySelector('svg').getBoundingClientRect(),r=n.getBoundingClientRect();
      const text=[...n.querySelectorAll(':scope > span')].filter(s=>getComputedStyle(s).display!=='none');
      return {icon:[icon.width,icon.height],fits:text.every(s=>s.scrollWidth<=s.clientWidth+1),height:r.height};
    });
    assert.deepEqual(dock.icon,[24,24]);assert.ok(dock.fits&&dock.height>=44);
    await go(page,'request');
    for(const view of ['search','discover','sources']) {
      await page.locator(`#android-request-tabs [data-request-view="${view}"]`).click();
      const tabs=page.locator('#android-request-tabs > .request-mode-head');
      assert.equal(await tabs.count(),1);assert.equal(await tabs.isVisible(),true);
      assert.equal(await page.locator('.request-subview-tabs').isVisible(),false);
      assert.equal(await page.locator('.request-subview:not([hidden])').evaluate(n=>getComputedStyle(n).gridTemplateRows.split(' ').length),1,'Moving the header releases its grid track instead of shrinking content after resize');
      await tabs.locator('[data-request-back]').click();
      assert.equal(await page.locator('.request-subview-tabs').isVisible(),true);
    }
    await go(page,'my');
    assert.equal(await page.locator('#cache-usage-row .cache-panel-label').isVisible(),false);
    assert.equal(await page.locator('#android-open-settings').evaluate(n=>getComputedStyle(n).borderRadius),'14px');
    await page.locator('#android-open-settings').click();await settle(page);
    assert.equal(await page.locator('#android-settings-back').isVisible(),true);
    assert.equal(await page.locator('#android-settings-back [data-i18n]').textContent(),await page.evaluate(()=>t('common.back')));
    await page.evaluate(()=>{
      state.updateAutomaticEnabled=true;state.updateCheckRequestInFlight=false;
      state.data.app_update={state:'up_to_date',supported:true,include_preview:state.updatePreviewEnabled,message:'旧中文消息'};
      renderUpdatePreviewControl();
    });
    assert.equal(await page.locator('#app-update-status').textContent(),await page.evaluate(()=>t('service.noUpdateAvailable')));
    await page.locator('#android-settings-back').click();await settle(page);
  }
  await go(page,'request');await page.locator('[data-request-view="discover"]').click();
  for(const mode of ['name','artist']) {
    await page.locator(`[data-discover-mode="${mode}"]`).click();
    const view=page.locator(`#request-discover-${mode}`);
    await view.locator('[data-letter="A"]').click();
    assert.equal(await view.locator('[data-d1-browse-alphabet]').isVisible(),false);
    await view.locator('[data-d1-browse-back]').click();
    assert.equal(await view.locator('[data-d1-browse-alphabet]').isVisible(),true);
  }
  await go(page,'playback');await page.setViewportSize({width:393,height:520});
  const frame=await page.locator('#player-frame').boundingBox();
  const scrolled=await page.locator('#stage-control-tray').evaluate(n=>{n.scrollTop=n.scrollHeight;return {top:n.scrollTop,overflow:n.scrollHeight-n.clientHeight,bottom:n.getBoundingClientRect().bottom};});
  assert.ok(scrolled.top>0&&scrolled.overflow>0,'Only the inline playback controls scroll');
  const afterScroll=await page.locator('#player-frame').boundingBox();
  assert.ok(Math.abs(afterScroll.y-frame.y)<1,'Video stays fixed while the controls scroll');
  assert.equal(await page.locator('.left-column').evaluate(n=>n.scrollTop),0);
  const dockTop=await page.locator('#android-host-dock').evaluate(n=>n.getBoundingClientRect().top);
  assert.ok(scrolled.bottom>dockTop&&scrolled.bottom<=520,'The scrolling page extends behind the floating dock');
  assert.ok(await page.locator('#stage-control-tray').evaluate(n=>parseFloat(getComputedStyle(n).paddingBottom)>=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-height'))+14),
    'Trailing scroll space keeps the final controls reachable above the dock');
  await page.evaluate(()=>{
    const button=document.getElementById('player-fullscreen-button');
    getComputedStyle(button).backgroundColor;
    document.querySelector('.player-panel').classList.add('is-tauri-fullscreen');button.disabled=false;
    getComputedStyle(button).backgroundColor;
    // Exercise a transition that outlives the former 180ms sampling delay,
    // as can happen while the CI WebKit renderer waits for its next frame.
    for(const animation of button.getAnimations())animation.playbackRate=.25;
  });
  await page.mouse.move(0,500);
  await page.evaluate(()=>Promise.all(
    ['player-fullscreen-button','android-fullscreen-remote-button'].flatMap(id=>
      document.getElementById(id).getAnimations().map(animation=>animation.finished)),
  ));
  const fullscreen=await page.evaluate(()=>['player-fullscreen-button','android-fullscreen-remote-button'].map(id=>{
    const n=document.getElementById(id),s=getComputedStyle(n),r=n.getBoundingClientRect();
    return [s.opacity,s.backgroundColor,s.color,s.borderRadius,s.border,s.boxShadow,r.width,r.height];
  }));
  assert.deepEqual(fullscreen[0],fullscreen[1],'Android fullscreen QR/exit actions retain the desktop surface and geometry');
  await page.evaluate(()=>document.querySelector('.player-panel').classList.remove('is-tauri-fullscreen'));
  await go(page,'my');await page.locator('#android-open-settings').click();
  await page.locator('#android-settings-back').click();await settle(page);
  assert.equal(await page.locator('#android-my-page').isVisible(),true);
  assert.equal(await page.locator('#android-my-page').evaluate(n=>n.style.position),'');
  await page.setViewportSize({width:393,height:736});await go(page,'request');
  const dock=await page.locator('#android-host-dock').boundingBox();
  await page.locator('#url-input').focus();
  await page.evaluate(()=>{dispatchEvent(new CustomEvent('bilikara:ime',{detail:{bottom:300*devicePixelRatio}}));setAppMessage('Fixture toast');});
  assert.deepEqual(await page.locator('#android-host-dock').boundingBox(),dock,'Native IME event does not relocate the dock');
  assert.ok((await page.locator('.app-toast').boundingBox()).y+ (await page.locator('.app-toast').boundingBox()).height<=436,
    'Toast clears the keyboard and bottom navigation');
  await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ime',{detail:{bottom:0}})));
  assert.equal(await page.evaluate(()=>phoneMedia.every(n=>n.isConnected&&[...document.querySelectorAll('video,audio')].includes(n))),true);
  if(process.env.BILIKARA_TEST_SCREENSHOT_DIR){mkdirSync(process.env.BILIKARA_TEST_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR,engine.name()+'-phone.png')});}
});

test('Android account logout requires two deliberate taps and holds its guard until the real local request finishes',{timeout:60000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,chromium);await go(page,'my');
  let count=0,release;const pending=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  await page.route('**/api/bbdown/logout',async route=>{count++;await pending;await route.continue();});
  await page.evaluate(()=>{state.data.bbdown={...state.data.bbdown,login:{state:'logged_in',logged_in:true}};renderBBDownLogin(state.data.bbdown.login);});
  const button=page.locator('#bbdown-login-button');
  assert.equal(await button.locator('.bbdown-login-label').textContent(),await page.evaluate(()=>t('service.loggedIn')));
  await button.click();assert.equal(count,0);
  assert.equal(await button.locator('.bbdown-login-label').textContent(),await page.evaluate(()=>t('service.logout')));
  await button.click();await page.waitForFunction(()=>document.getElementById('bbdown-login-button').getAttribute('aria-busy')==='true');
  assert.equal(count,1);await button.evaluate(n=>n.click());assert.equal(count,1);
  release();await page.waitForFunction(()=>!document.getElementById('bbdown-login-button').disabled);
  assert.equal(await button.locator('.bbdown-login-label').textContent(),await page.evaluate(()=>t('service.notLoggedIn')));
});

test('Android headings, insets, empty guidance and segmented fills share one phone frame', {timeout:120000,skip:process.platform!=='linux'}, async t=>{
  const {page,host}=await open(t,chromium,{sessionUser:false});
  for(const width of [320,360,393])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:844});await page.evaluate(language=>setLanguage(language),language);
    for(const name of ['queue','history','users','my','request']){
      if(name==='history')await page.locator('[data-android-workspace="history"]').click();
      else await go(page,name);
      const title=await page.locator('#android-page-heading > .host-peer-heading').evaluate(n=>({
        width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,
        text:n.querySelector('h2').textContent,clip:getComputedStyle(n).clip,
      }));
      assert.ok(title.width>=32,JSON.stringify({width,language,name,...title}));assert.ok(title.height>=24);assert.ok(title.text);assert.equal(title.clip,'auto');
      if(name==='queue'||name==='history'){
        const inset=await page.locator(`#host-workspace-${name}`).evaluate(n=>{const c=n.getBoundingClientRect(),r=n.querySelector('.list-stage').getBoundingClientRect();return [r.top-c.top,r.left-c.left,c.right-r.right];});
        assert.ok(Math.max(...inset)-Math.min(...inset)<1,'List starts with equal top/side card insets: '+JSON.stringify(inset));
        const aligned=await page.locator('#android-page-heading').evaluate(n=>{
          const r=n.getBoundingClientRect(),a=n.querySelector('.queue-toolbar').getBoundingClientRect();return Math.abs(r.top+r.height/2-a.top-a.height/2)<1&&Math.abs(r.right-a.right)<1;
        });assert.equal(aligned,true);
      }
      if(name==='users'){
        assert.equal(await page.locator('[aria-describedby="session-users-help"]').count(),0);
        assert.equal(await page.locator('.session-user-guidance').isVisible(),true);
        const emphasis=await page.locator('.session-user-prerequisite').evaluate(n=>[getComputedStyle(n).color,getComputedStyle(n).fontWeight]);
        assert.deepEqual(emphasis,await page.locator('#gatcha-session-user-notice').evaluate(n=>[getComputedStyle(n).color,getComputedStyle(n).fontWeight]));
      }
    }
    for(const view of ['search','discover','sources']){
      await page.locator(`[data-request-view="${view}"]`).click();
      const frame=await page.locator(`.request-${view}-view > .request-mode-panel:not([hidden])`).first().evaluate(n=>{
        const s=getComputedStyle(n);return [s.paddingTop,s.paddingLeft,s.paddingRight];
      });assert.deepEqual(frame,['0px','0px','0px']);
      const segment=await page.locator('#android-request-tabs > .request-mode-head').evaluate(head=>{
        const selected=head.querySelector('[aria-selected="true"]'),r=head.getBoundingClientRect(),b=selected.getBoundingClientRect(),s=getComputedStyle(selected);
        return {clipped:getComputedStyle(head).overflow,top:b.top+parseFloat(s.borderTopWidth)-r.top,bottom:r.bottom-b.bottom+parseFloat(s.borderBottomWidth)};
      });assert.equal(segment.clipped,'hidden');assert.ok(segment.top>=3.9&&segment.bottom>=3.9,'The painted fill stays inside the segmented track');
      await page.locator('#android-request-tabs [data-request-back]').click();
    }
    const quick=await page.locator('#request-quick-panel').evaluate(n=>{
      const p=n.closest('#host-workspace-request').getBoundingClientRect(),title=n.querySelector('h3').getBoundingClientRect();const s=getComputedStyle(n.querySelector('h3'));return {position:[title.x-p.x,title.y-p.y],type:[s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing,s.fontFamily],subtitle:getComputedStyle(n.querySelector('.section-tag')).display};
    });
    await page.locator('#android-request-random').click();
    const random=await page.locator('#gatcha-panel').evaluate(n=>{
      const p=n.getBoundingClientRect(),title=n.querySelector('h2').getBoundingClientRect();const s=getComputedStyle(n.querySelector('h2'));return {position:[title.x-p.x,title.y-p.y],type:[s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing,s.fontFamily],subtitle:getComputedStyle(n.querySelector('.section-tag')).display};
    });quick.position.forEach((value,i)=>assert.ok(Math.abs(value-random.position[i])<1,JSON.stringify({quick,random})));
    assert.deepEqual(quick.type,random.type,'Quick Request and Gatcha share heading typography');
    assert.equal(quick.subtitle,'block');assert.equal(random.subtitle,'block');
    await go(page,'my');await page.locator('#android-open-settings').click();await settle(page);
    assert.equal(await page.locator('.settings-workspace-head').isVisible(),false);
    assert.equal(await page.locator('#android-page-heading #android-settings-back svg').isVisible(),true);
    await page.locator('#android-settings-back').click();await settle(page);
  }
  await host.api('/api/session-users/add',{name:'Visible singer'});await go(page,'users');
  await page.locator('.session-user-badge').waitFor();assert.equal(await page.locator('.session-user-empty').count(),0);
  assert.equal(await page.evaluate(()=>phoneMedia.every(n=>n.isConnected)),true);
});

test('Android audience QR follows Host open/close over ordered envelopes without output buttons', {timeout:60000,skip:process.platform!=='linux'}, async t=>{
  const {page,host}=await open(t,chromium);const context=page.context();
  await context.addInitScript(()=>{
    const session={mode:'localDualScreen',phase:'active',generation:7,hostReady:true,controllerReady:true,playbackAuthority:'host',mediaRendererOwner:'host'};
    window.BilikaraAndroidPresentation={invoke:async()=>session,listen:async(name,handler)=>{if(name==='master-state')window.receiveMaster=handler;return()=>{};},isForeground:()=>true,reportOutput(){}};
  });
  const output=await context.newPage(),errors=[];output.on('pageerror',e=>errors.push(e.message));
  await output.goto(host.base+'/controller.html?presentationGeneration=7');await output.waitForFunction(()=>typeof receiveMaster==='function');
  let latest;await page.exposeFunction('relayToOutput',async envelope=>{latest=envelope;await output.evaluate(envelope=>receiveMaster({payload:envelope}),envelope);});
  await page.evaluate(()=>{
    window.BilikaraAndroidPresentation={invoke:async()=>({}),postMaster:envelope=>window.relayToOutput(envelope)};
    state.presentationSession={...state.presentationSession,mode:'localDualScreen',phase:'active',generation:7,hostReady:true,controllerReady:true};
    publishPresentationOutputState();
  });
  assert.equal(await output.locator('#controller-exit').isVisible(),false);
  assert.equal(await output.locator('#controller-remote-popover').isVisible(),false);
  await page.locator('#remote-mini-trigger').tap();
  await output.waitForFunction(()=>document.getElementById('controller-output-control').classList.contains('is-qr-pinned'));
  assert.equal(latest.payload.remoteMenuVisible,true);await output.locator('#controller-remote-popover').waitFor({state:'visible'});
  const stale={...latest,sequence:latest.sequence-1,payload:{...latest.payload,remoteMenuVisible:false}};
  await output.evaluate(envelope=>receiveMaster({payload:envelope}),stale);
  assert.equal(await output.locator('#controller-remote-popover').isVisible(),true,'Stale envelopes do not override the current QR state');
  await page.keyboard.press('Escape');await output.waitForFunction(()=>!document.getElementById('controller-output-control').classList.contains('is-qr-pinned'));
  await output.locator('#controller-remote-popover').waitFor({state:'hidden'});
  assert.equal(latest.payload.remoteMenuVisible,false);assert.deepEqual(errors,[]);
});

for(const engine of [chromium,webkit])test(`${engine.name()} Android My keeps its scroll frame, cache lines, login link and settings animation geometry`, {timeout:90000,skip:process.platform!=='linux'}, async t=>{
  const {page,host}=await open(t,engine);await go(page,'my');
  await page.evaluate(()=>{
    fetchState=async()=>{};state.eventSource?.close();
    state.data.bbdown.login={state:'waiting',logged_in:false,message:'请使用哔哩哔哩 App 扫码登录',login_url:'https://account.bilibili.com/fixture-login?key=synthetic',qr_image:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjgiIGhlaWdodD0iMTY4Ij48cmVjdCB3aWR0aD0iMTY4IiBoZWlnaHQ9IjE2OCIgZmlsbD0id2hpdGUiLz48L3N2Zz4='};
    renderBBDownLogin(state.data.bbdown.login);
  });
  const login=await page.locator('#bbdown-login-panel').evaluate(n=>{
    const image=n.querySelector('img').getBoundingClientRect(),link=n.querySelector('a').getBoundingClientRect(),s=getComputedStyle(n);
    const message=n.querySelector('.bbdown-login-message').getBoundingClientRect();
    return {border:parseFloat(s.borderTopWidth),bg:s.backgroundColor,right:link.left>=image.right,
      aligned:Math.abs(message.left-link.left)<1,below:link.top>=message.bottom};
  });assert.deepEqual(login,{border:0,bg:'rgba(0, 0, 0, 0)',right:true,aligned:true,below:true});
  for(const width of [320,393])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:736});await page.evaluate(language=>setLanguage(language),language);
    const bounds=await page.locator('.bbdown-login-qr').evaluate(n=>{
      const qr=n.querySelector('.bbdown-login-qr-code').getBoundingClientRect(),details=n.querySelector('.bbdown-login-qr-details').getBoundingClientRect();
      return {inside:details.top>=qr.top-1&&details.bottom<=qr.bottom+1,right:details.left>=qr.right,alternative:!n.querySelector('.bbdown-login-alternative').hidden};
    });assert.ok(bounds.inside&&bounds.right,JSON.stringify({width,language,bounds}));assert.equal(bounds.alternative,true);
    await page.evaluate(()=>renderCacheUsageDetail(t('service.cacheUsageDetail',{usage:'12.5 GB',count:9999})));
    const usage=await page.locator('#cache-usage-row').evaluate(row=>{
      const detail=row.querySelector('#cache-usage-detail'),side=row.querySelector('.cache-panel-side');
      const singleLines=[...detail.children].every(n=>{const range=document.createRange();range.selectNodeContents(n);return range.getClientRects().length===1;});
      const a=detail.getBoundingClientRect(),b=side.getBoundingClientRect(),r=row.getBoundingClientRect();
      return {singleLines,separate:a.right<=b.left,inside:a.left>=r.left&&b.right<=r.right+1,overflow:row.scrollWidth>row.clientWidth+1};
    });assert.deepEqual(usage,{singleLines:true,separate:true,inside:true,overflow:false},JSON.stringify({width,language,usage}));
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.ok(['stacked','inline'].includes(await page.locator('#cache-source-row').getAttribute('data-layout')));
    const source=await page.locator('#cache-source-row').evaluate(row=>{
      const [download,reset]=row.children,[a,b]=[download,reset].map(n=>n.getBoundingClientRect());
      const labels=[download,reset].map(n=>n.firstElementChild.getBoundingClientRect());
      const controls=[download.querySelector('.runtime-settings-select-shell'),reset.querySelector('.cache-hires-switch')].map(n=>n.getBoundingClientRect());
      const stacked=row.dataset.layout==='stacked';
      return {aligned:stacked?a.bottom<=b.top&&Math.abs(labels[0].left-labels[1].left)<1&&Math.abs(controls[0].right-controls[1].right)<1:
        Math.abs(labels[0].top-labels[1].top)<1&&Math.abs((controls[0].top+controls[0].bottom-controls[1].top-controls[1].bottom)/2)<1,
        separate:labels.every((r,i)=>stacked?r.right<=controls[i].left:r.bottom<=controls[i].top),targets:[a,b].every(r=>r.height>=44),overflow:row.scrollWidth>row.clientWidth+1};
    });assert.deepEqual(source,{aligned:true,separate:true,targets:true,overflow:false},JSON.stringify({width,language,source}));
  }
  await page.setViewportSize({width:393,height:736});await page.evaluate(()=>setLanguage('zh'));
  const lines=await page.locator('#cache-usage-detail').evaluate(n=>{const [size,count]=n.children;return {size:size.getBoundingClientRect().toJSON(),count:count.getBoundingClientRect().toJSON()};});
  assert.ok(lines.count.top>=lines.size.bottom,'Cached song count stays below bytes');
  let calls=0,release;const pending=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  await page.exposeFunction('fixtureLoginOpen',()=>{calls++;return pending;});
  await page.evaluate(()=>{window.BilikaraAndroidPlatform={openLoginLink:url=>fixtureLoginOpen(url)}});
  await page.locator('#bbdown-login-link').click();await page.waitForFunction(()=>document.getElementById('bbdown-login-link').getAttribute('aria-busy')==='true');
  await page.locator('#bbdown-login-link').evaluate(n=>n.click());assert.equal(calls,1);release();
  await page.waitForFunction(()=>!document.getElementById('bbdown-login-link').hasAttribute('aria-busy'));
  assert.equal(new URL(page.url()).origin,host.base,'Opening login never navigates the Host WebView');
  const frame=await page.locator('#android-my-page').evaluate(n=>{
    const scroll=n.querySelector('.android-my-scroll');scroll.scrollTop=scroll.scrollHeight;
    const a=n.getBoundingClientRect(),b=scroll.getBoundingClientRect();return {top:b.top-a.top,left:b.left-a.left,right:a.right-b.right,bottom:a.bottom-b.bottom,scroll:scroll.scrollTop};
  });assert.ok(frame.scroll>0);assert.ok(Math.max(frame.top,frame.left,frame.right,frame.bottom)-Math.min(frame.top,frame.left,frame.right,frame.bottom)<1);
  for(const forward of [true,false]){
    const result=await page.evaluate(async forward=>{
      const outgoing=forward?document.getElementById('android-my-page'):document.getElementById('host-workspace-region');
      const previous=outgoing.getBoundingClientRect();document.getElementById(forward?'android-open-settings':'android-settings-back').click();
      const incoming=forward?document.getElementById('host-workspace-region'):document.getElementById('android-my-page');
      const animation=incoming.getAnimations()[0],tops=[],scrolls=[];
      while(animation&&animation.playState!=='finished'&&animation.playState!=='idle'){
        tops.push([outgoing.getBoundingClientRect().top,incoming.getBoundingClientRect().top]);scrolls.push(document.querySelector('.android-my-scroll').scrollTop);await new Promise(requestAnimationFrame);
      }
      await Promise.allSettled([...document.querySelectorAll('#android-my-page,#host-workspace-region,.mobile-navigation-header')]
        .flatMap(n=>n.getAnimations().map(a=>a.finished)));return {previous:previous.top,final:incoming.getBoundingClientRect().top,tops,scrolls};
    },forward);
    if(!forward)assert.ok(result.scrolls.every(value=>Math.abs(value-frame.scroll)<1),JSON.stringify(result.scrolls));
    assert.ok(result.tops.length>1);for(const [oldTop,newTop]of result.tops){assert.ok(Math.abs(oldTop-result.previous)<1,JSON.stringify(result));assert.ok(Math.abs(newTop-result.final)<1,JSON.stringify(result));}
  }
  assert.equal(await page.locator('.android-my-scroll').evaluate(n=>n.scrollTop),frame.scroll,'Settings return preserves My scroll position');
  for(const login of [{state:'failed',login_url:'https://account.bilibili.com/fixture'}, {state:'waiting',login_url:'https://account.bilibili.com.evil.test/'},{state:'logged_in',logged_in:true,login_url:'https://account.bilibili.com/fixture'}]){
    await page.evaluate(login=>renderBBDownLogin(login),login);assert.equal(await page.locator('#bbdown-login-link').isVisible(),false);
    assert.equal(await page.locator('#bbdown-login-link').getAttribute('href'),null);
  }
});

test('Android user tools fill the unframed page bottom and the dock highlight leaves its full touch slot intact',{timeout:60000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,chromium);await go(page,'users');
  const placement=await page.locator('#session-users-panel').evaluate(n=>{const r=n.getBoundingClientRect(),f=n.querySelector('.session-user-tools').getBoundingClientRect();return {bottom:r.bottom-f.bottom,right:r.right-f.right,dockGap:document.getElementById('android-host-dock').getBoundingClientRect().top-f.bottom};});
  assert.ok(placement.bottom>=0&&placement.bottom<=1,JSON.stringify(placement));assert.ok(Math.abs(placement.bottom-placement.right)<1);assert.ok(placement.dockGap>=12&&placement.dockGap<=16,'resident tools reclaim the former card padding without covering the dock: '+JSON.stringify(placement));
  for(const width of [320,393,650])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:736});await page.evaluate(language=>setLanguage(language),language);
    const geometry=await page.locator('#android-host-dock [aria-current]').evaluate(n=>{const p=getComputedStyle(n,'::before'),r=n.getBoundingClientRect();return {target:r.width,visible:parseFloat(p.width),height:r.height,fits:[...n.querySelectorAll('span')].filter(s=>getComputedStyle(s).display!=='none').every(s=>s.getBoundingClientRect().width<=parseFloat(p.width))};});
    assert.ok(geometry.target>=44&&geometry.height>=44);assert.ok(geometry.visible<=68&&geometry.visible<geometry.target);assert.equal(geometry.fits,true,JSON.stringify({width,language,geometry}));
  }
});

async function assertFittedBrowsePage(grid, viewport, selector, minimumRows=1) {
  await grid.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cards = await grid.locator(selector).evaluateAll(nodes => nodes.map(n => {const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};}));
  const bounds=await viewport.boundingBox(),gap=await grid.evaluate(n=>parseFloat(getComputedStyle(n).rowGap)||0);
  const metrics=await viewport.evaluate(n=>({height:n.clientHeight,scrollHeight:n.scrollHeight,overflow:getComputedStyle(n).overflowY}));
  assert.ok(cards.length>0);
  const rows=new Set(cards.map(card=>Math.round(card.top))).size;
  assert.ok(rows>=minimumRows,'the phone song page retains at least three rows');
  const scrolls=metrics.scrollHeight>metrics.height+1;
  for(const card of cards) {
    assert.ok(card.top>=bounds.y-1&&card.bottom<=bounds.y+(scrolls?metrics.scrollHeight:bounds.height)+1,'every card fits its viewport or scrollable content');
    assert.ok(card.left>=bounds.x-1&&card.right<=bounds.x+bounds.width+1,'every card fits horizontally');
  }
  if(scrolls) {
    assert.equal(minimumRows,3,'only the approved minimum song rows use a short-screen scrollport');
    assert.equal(rows,3,'short screens scroll the minimum three rows, without fetching an unbounded list');
    assert.match(metrics.overflow,/auto|scroll/);
    await viewport.evaluate(n=>{n.scrollTop=n.scrollHeight;});
    const last=await grid.locator(selector).last().boundingBox();
    assert.ok(last.y>=bounds.y-1&&last.y+last.height<=bounds.y+bounds.height+1,'the last song row is fully reachable above the pager');
    await viewport.evaluate(n=>{n.scrollTop=0;});
  }
  assert.ok(Math.max(...cards.map(c=>c.bottom))+cards[0].height+gap>bounds.y+bounds.height-1,'another complete row must not fit below the page');
  return cards.length;
}

async function installTopSlotFixtures(page) {
  const items=Array.from({length:60},(_,i)=>({bvid:`BV${String(i+1).padStart(10,'0')}`,title:`Fixture song ${i+1}`,owner_name:'Fixture UP'}));
  const tags=Array.from({length:30},(_,i)=>({tag:`Artist ${i+1}`,count:60}));
  await page.route(/\/api\/(?:catalog\/search|gatcha\/search|d1\/(?:browse|category-browse)|gatcha\/(?:favlist\/)?browse)(?:\?|$)/,route=>{
    const url=new URL(route.request().url()),offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100);
    const uid=url.searchParams.get('uid')||'',folder=url.searchParams.get('folder_id')||'';
    return route.fulfill({json:{ok:true,data:{items:items.slice(offset,offset+limit),tags,
      owners:[{uid:'42',name:'Fixture UP',count:60}],folders:[{id:'42:7',folder_id:'7',title:'Fixture favorites',count:60}],
      selected_uid:uid,selected_folder_id:folder,query:url.searchParams.get('q')||'',matched_count:60,
      has_more:offset+limit<60,next_offset:Math.min(60,offset+limit)}}});
  });
}

for(const engine of [chromium,webkit]) for(const [client,width,height] of [
  ['desktop',1440,900],['desktop',700,800],['android',393,844],['android',844,393],
  ['android',1024,768],['android',1180,820],['remote',393,844],['remote',360,740],
]) test(`${engine.name()} ${client} ${width}x${height} Request TopSlots share bounds and first-card spacing`,{timeout:120000,skip:process.platform!=='linux'},async t=>{
  const {page,host}=await open(t,engine);
  await installTopSlotFixtures(page);
  const remote=client==='remote';
  if(remote){
    await page.goto(host.base+'/remote');
    await page.waitForFunction(()=>typeof state!=='undefined'&&state.data?.session_user_entries?.length);
    await page.locator('#remote-identity-input').fill('TopSlot tester');
    await page.locator('#remote-identity-submit').click();
    await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  }else{
    await page.evaluate(client=>{document.documentElement.dataset.hostPlatform=client;activateHostWorkspace('request');},client);
  }
  await page.setViewportSize({width,height});
  await page.evaluate(()=>setLanguage('zh'));
  const activate=async(view,mode)=>page.evaluate(({remote,view,mode})=>{
    if(remote){
      activateRemoteRequestView(view);
      ({search:activateRemoteSearchMode,discover:activateRemoteDiscoverMode,sources:activateRemoteSourcesMode})[view](mode);
    }else{
      activateRequestSubview(view);
      ({search:activateSearchMode,discover:activateDiscoverMode,sources:activateSourcesMode})[view](mode);
    }
  },{remote,view,mode});
  const measurements=[];
  const sample=async(name,topSelector,cardSelector,{separateAlphabet=false}={})=>{
    await page.locator(cardSelector).first().waitFor({state:'visible'});
    await page.evaluate(async()=>{
      await document.fonts.ready;
      await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));
      window.scrollTo(0,0);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    const value=await page.evaluate(({topSelector,cardSelector})=>{
      const topNode=document.querySelector(topSelector),top=topNode.getBoundingClientRect(),card=document.querySelector(cardSelector).getBoundingClientRect();
      const alphabet=topNode.closest('.tag-browser')?.querySelector('.tag-browser-alphabet');
      const alphabetRect=alphabet?.getBoundingClientRect();
      return {x:top.x,y:top.y,width:top.width,height:top.height,gap:card.y-top.bottom,
        alphabet:alphabetRect?{height:alphabetRect.height,bottom:alphabetRect.bottom}:null,
        expectedGap:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--request-top-content-gap'))};
    },{topSelector,cardSelector});
    if(separateAlphabet){
      assert.ok(value.alphabet?.height>0,'desktop alphabet navigation remains visible');
      assert.ok(value.alphabet.bottom<=value.y+1,'desktop alphabet remains above the contextual TopSlot in normal flow');
    }
    assert.ok(Math.abs(value.gap-value.expectedGap)<=1,JSON.stringify({name,...value}));
    for(const key of ['x','y','width','height'])if(measurements.length&&!(key==='y'&&separateAlphabet))assert.ok(Math.abs(value[key]-measurements[0][key])<=1,JSON.stringify({name,key,value,reference:measurements[0]}));
    measurements.push({name,...value});
  };
  for(const mode of ['shared','local']){
    await activate('search',mode);
    const form=mode==='shared'?'#shared-search-form':'#search-form',grid=mode==='shared'?'#shared-search-results':'#search-results';
    await page.locator(form+' input').fill('Fixture');
    await page.locator(form+' button[type="submit"]').click();
    await sample(`search-${mode}`,form,grid+' .search-result-item');
  }
  await activate('discover','categories');
  const category=remote?'#remote-discover-categories-panel':'#request-discover-categories';
  await page.locator(category+' [data-category-browser-home] [data-category-id]').first().click();
  await sample('category-results',category+' .browse-search-bar',category+' .search-result-item');
  // Approved desktop exception: the persistent alphabet is separate navigation,
  // excluded from TopSlot height and cross-page y comparisons. Its following
  // TopSlot still participates in the same lower-edge-to-first-card gap check.
  // Native/Remote contextual levels compare all four TopSlot bounds normally.
  for(const kind of ['name','artist']){
    await activate('discover',kind);
    const view=remote?`#remote-discover-${kind}-panel`:`#request-discover-${kind}`;
    await page.locator(view+' [data-letter="A"]').click();
    await sample(`${kind}-tags`,view+' .browse-search-bar',view+' .tag-browser-tag',{separateAlphabet:client==='desktop'});
    await page.locator(view+' .tag-browser-tag').first().click();
    await sample(`${kind}-results`,view+' .browse-search-bar',view+' .search-result-item',{separateAlphabet:client==='desktop'});
  }
  for(const mode of ['uids','favorites']){
    const favorite=mode==='favorites';
    await activate('sources',mode);
    const panel=remote?`#remote-sources-${mode}-panel`:`#request-sources-${mode}`;
    const grid=favorite?'#favlist-grid':remote?'#sources-follow-grid':'#follow-up-grid';
    const results=favorite?'#favlist-song-results':remote?'#sources-follow-results':'#follow-song-results';
    await sample(`${mode}-list`,panel+' .source-uid-form',grid+' .follow-up-button');
    await page.locator(grid+' .follow-up-button').first().click();
    await sample(`${mode}-detail`,panel+' .browse-search-bar',results+' .search-result-item');
  }
});

for (const engine of [chromium, webkit]) test(`${engine.name()} Request search fills the frame and landscape tag navigation stays above content`, {timeout:120000,skip:process.platform!=='linux'}, async t=>{
  const {page}=await open(t,engine);
  const items=Array.from({length:60},(_,i)=>({bvid:`BV${String(i+1).padStart(10,'0')}`,title:`Song ${i+1}`,owner_name:'Fixture'}));
  await page.route('**/api/catalog/search?**',route=>route.fulfill({json:{ok:true,data:{items,matched_count:60,has_more:false}}}));
  await page.route('**/api/d1/browse?**',route=>route.fulfill({json:{ok:true,data:{tags:Array.from({length:30},(_,i)=>({tag:`Artist ${i+1}`,count:60})),items,matched_count:60,has_more:false}}}));
  await go(page,'request');
  await page.locator('[data-request-view="search"]').click();
  await page.locator('#shared-search-form input').fill('Fixture');
  await page.locator('#shared-search-form button[type="submit"]').click();
  await page.locator('#shared-search-results .search-result-item').first().waitFor();
  for (const [width,height] of [[393,844],[844,393],[1024,768],[1180,820]]) {
    await page.setViewportSize({width,height});
    for (const status of ['', 'Visible status']) for (const notice of [false,true]) {
      await page.locator('#request-search-shared').evaluate((panel,{status,notice})=>{
        panel.querySelector('.search-message').textContent=status;
        panel.querySelector('.request-session-user-notice')?.remove();
        panel.classList.toggle('has-request-session-user-notice',notice);
        if(notice){const n=document.createElement('p');n.className='request-session-user-notice';n.textContent='Visible singer notice';panel.querySelector('form').after(n);}
      },{status,notice});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const bounds=await page.locator('#request-search-shared').evaluate(panel=>{
        const s=getComputedStyle(panel),r=panel.getBoundingClientRect(),frame=panel.querySelector('.android-result-frame').getBoundingClientRect();
        const status=panel.querySelector('.search-message').getBoundingClientRect();
        return {contentBottom:r.bottom-parseFloat(s.paddingBottom)-parseFloat(s.borderBottomWidth),frameBottom:frame.bottom,statusHeight:status.height};
      });
      assert.ok(Math.abs(bounds.frameBottom-bounds.contentBottom)<=1,JSON.stringify({width,height,status,notice,bounds}));
      if(!status)assert.equal(bounds.statusHeight,0,'empty status contributes neither a track nor a gap');
    }
  }
  await page.setViewportSize({width:393,height:844});
  await page.locator('#android-request-tabs [data-request-back]').click();
  await page.locator('[data-request-view="discover"]').click();
  for(const kind of ['name','artist']) {
    await page.locator(`[data-discover-mode="${kind}"]`).click();
    await page.locator(`#request-discover-${kind} [data-letter="A"]`).click();
    for(const [width,height] of [[393,844],[844,393],[1024,768],[1180,820]]) {
      await page.setViewportSize({width,height});
      const view=page.locator(`#request-discover-${kind}`);
      await view.locator('[data-d1-browse-tags] button').first().waitFor();
      const top=await view.locator('.browse-search-bar').boundingBox(),grid=await view.locator('[data-d1-browse-tags]').boundingBox();
      assert.ok(top.y+top.height<=grid.y,JSON.stringify({kind,width,height,top,grid}));
    }
    await page.setViewportSize({width:393,height:844});
  }
});

test('Android search and discovery use Remote result pages, swipe, exact jumps and query recovery',{timeout:90000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,chromium),requests=[];
  const items=Array.from({length:120},(_,i)=>({bvid:'BV'+String(i+1).padStart(10,'0'),title:`Fixture song ${i+1}`,owner_name:'Fixture',source_url:'https://www.bilibili.com/video/BV'+String(i+1).padStart(10,'0')}));
  await page.route('**/api/catalog/search?**',route=>{
    const q=new URL(route.request().url()),offset=Number(q.searchParams.get('offset')),limit=Number(q.searchParams.get('limit'));requests.push({offset,limit,q:q.searchParams.get('q')});
    return route.fulfill({json:{ok:true,data:{items:items.slice(offset,offset+limit),matched_count:items.length,has_more:offset+limit<items.length,next_offset:Math.min(items.length,offset+limit)}}});
  });
  await go(page,'request');await page.locator('[data-request-view="search"]').click();
  await page.locator('#shared-search-form input').fill('Fixture');await page.locator('#shared-search-form button[type="submit"]').click();
  const frame=page.locator('#request-search-shared .android-result-frame'),pager=frame.locator('.result-pager'),results=page.locator('#shared-search-results');
  await page.waitForFunction(()=>!document.getElementById('shared-search-button').disabled);
  const pageSize=await assertFittedBrowsePage(results,frame.locator('.result-page-viewport'),'.search-result-item',3);assert.equal(await pager.locator('[data-page-input]').inputValue(),'1');
  assert.equal(await results.locator('.search-result-title').first().textContent(),'Fixture song 1');
  const cdp=await page.context().newCDPSession(page);t.after(()=>cdp.detach().catch(()=>{}));
  const swipe=async locator=>{const r=await locator.boundingBox(),y=r.y+Math.min(40,r.height/2),x=r.x+r.width*.8;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(const fraction of [.15,.35,.6])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-r.width*fraction,y:y+2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  await swipe(frame.locator('.result-page-viewport'));await page.waitForFunction(()=>document.querySelector('#request-search-shared [data-page-input]').value==='2');
  assert.equal(await results.locator('.search-result-title').first().textContent(),`Fixture song ${pageSize+1}`);
  const lastPage=Math.ceil(items.length/pageSize),lastOffset=(lastPage-1)*pageSize;
  await pager.locator('[data-page-action="last"]').click();await page.waitForFunction(last=>document.querySelector('#request-search-shared [data-page-input]').value===String(last),lastPage);
  assert.equal(await results.locator('.search-result-title').first().textContent(),`Fixture song ${lastOffset+1}`);assert.ok(requests.some(r=>r.offset<=lastOffset&&r.offset+r.limit>lastOffset),'the exact last page is covered by an actual direct or prefetched read');
  const viewport=await frame.locator('.result-page-viewport').boundingBox(),footer=await pager.boundingBox();assert.ok(footer.y>=viewport.y+viewport.height-1);assert.ok(footer.y+footer.height<=(await page.locator('#android-host-dock').boundingBox()).y,'Page controls stay above phone navigation');
  await page.locator('#shared-search-form input').fill('Recovery');await page.locator('#shared-search-form button[type="submit"]').click();
  await page.waitForFunction(()=>!document.getElementById('shared-search-button').disabled);assert.equal(await pager.locator('[data-page-input]').inputValue(),'1');
  await page.locator('#android-request-tabs [data-request-back]').click();await page.locator('[data-request-view="discover"]').click();
  const tags=Array.from({length:25},(_,i)=>({tag:`Artist ${i+1}`,count:120}));
  await page.route('**/api/d1/browse?**',route=>{
    const q=new URL(route.request().url()),tag=q.searchParams.get('tag'),offset=Number(q.searchParams.get('offset')||0),limit=Number(q.searchParams.get('limit')||100);
    return route.fulfill({json:{ok:true,data:{tags:tag?[]:tags,items:tag?items.slice(offset,offset+limit):[],matched_count:tag?120:25,has_more:tag&&offset+limit<120,next_offset:Math.min(120,offset+limit)}}});
  });
  await page.locator('[data-discover-mode="artist"]').click();await page.locator('#request-discover-artist [data-letter="A"]').click();
  const tagGrid=page.locator('#request-discover-artist [data-d1-browse-tags]');await tagGrid.locator('button').first().waitFor();
  const tagsFrame=tagGrid.locator('..').locator('..'),tagPageSize=await assertFittedBrowsePage(tagGrid,tagsFrame.locator('.result-page-viewport'),'button');
  await tagsFrame.locator('[data-page-action="next"]').click();assert.equal(await tagGrid.locator('button').first().getAttribute('data-tag'),`Artist ${tagPageSize+1}`);
  await tagGrid.locator('button').first().click();const songs=page.locator('#request-discover-artist [data-d1-browse-results]');await songs.locator('.search-result-item').first().waitFor();await assertFittedBrowsePage(songs,songs.locator('..'),'.search-result-item',3);
  await page.locator('#request-discover-artist [data-d1-browse-back]').click();assert.equal(await songs.locator('..').locator('..').isVisible(),false,'Returning to tags hides the old result footer too');
});


for(const engine of [chromium,webkit])test(`${engine.name()} Android stage uses shared complete-title wrapping and marquee modes`,{timeout:90000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,engine);await go(page,'playback');
  await page.evaluate(()=>{state.eventSource?.close();fetchState=async()=>{};});
  const title=page.locator('#current-title');
  const inspect=n=>{const text=n.querySelector('#current-title-text'),s=getComputedStyle(text),r=n.getBoundingClientRect();return {
    two:n.classList.contains('is-two-line'),scrolling:n.classList.contains('is-scrolling'),loop:n.classList.contains('is-text-marquee-loop'),
    animation:s.animationName,width:n.clientWidth,natural:text.scrollWidth,height:r.height,line:parseFloat(s.lineHeight),
    copies:n.querySelectorAll('.text-marquee-copy').length,text:text.textContent,
  };};
  for(const width of [320,393]){
    await page.setViewportSize({width,height:850});
    const samples=await page.evaluate(()=>{
      BilikaraTextMarquee.reset(elements.currentTitle,elements.currentTitleText);
      elements.currentTitleText.textContent='短标题';measurePersistentStage();
      const s=getComputedStyle(elements.currentTitleText),c=document.createElement('canvas').getContext('2d');
      c.font=`${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const w=elements.currentTitle.clientWidth;
      return {two:'春'.repeat(Math.floor(w*1.35/c.measureText('春').width)),
        small:Array(3).fill('W'.repeat(Math.max(1,Math.floor(w*.58/c.measureText('W').width)))).join(' '),
        long:'很长的歌曲标题 gypqj '.repeat(40)};
    });
    for(const [mode,text] of Object.entries(samples)){
      await page.evaluate(text=>{elements.currentTitleText.textContent=text;measurePersistentStage();},text);
      const result=await title.evaluate(inspect);assert.equal(result.text,text);
      if(mode==='two'){
        assert.equal(result.two,true,JSON.stringify(result));assert.equal(result.scrolling,false);assert.equal(result.copies,0);
        assert.ok(result.height>=result.line*2-1&&result.height<=result.line*2+8,JSON.stringify(result));
      }else{
        assert.equal(result.two,false,JSON.stringify(result));assert.equal(result.scrolling,true);
        assert.equal(result.loop,mode==='long');assert.equal(result.copies,mode==='long'?1:0);
        assert.equal(result.animation,mode==='long'?'text-marquee-loop':'host-current-title-marquee');
        assert.ok(result.height<result.line*2,JSON.stringify(result));
        if(mode==='small')assert.ok(result.natural>result.width&&result.natural<result.width*2,JSON.stringify(result));
      }
      if(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS&&engine===chromium){
        const out=path.resolve(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS);mkdirSync(out,{recursive:true});
        await page.screenshot({animations:'disabled',path:path.join(out,`android-${width}-${mode}.png`)});
      }
    }
    const full=page.locator('#player-fullscreen-button');
    assert.deepEqual(await full.evaluate(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return {width:r.width,height:r.height,radius:s.borderRadius};}),{width:44,height:44,radius:'14px'});
    assert.equal(await page.locator('#player-fullscreen-label').isVisible(),false);
    assert.equal(await full.locator('.fullscreen-enter-icon').isVisible(),true);
    assert.ok(await full.getAttribute('aria-label'));
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await title.evaluate(n=>getComputedStyle(n.firstElementChild).animationName),'none');
    await page.evaluate(()=>{elements.currentTitleText.textContent='短标题';measurePersistentStage();});
    assert.equal(await title.locator('.text-marquee-copy').count(),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
  }
  assert.equal(await page.evaluate(()=>phoneMedia.every(n=>n.isConnected)),true);
});


for(const engine of [chromium,webkit])test(`${engine.name()} Android fullscreen icon shares held hints without activating on release`,{timeout:60000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,engine);await go(page,'playback');
  await page.evaluate(()=>{
    state.eventSource?.close();fetchState=async()=>{};
    state.data.current_item={id:'hint-fixture',display_title:'全屏按钮说明',cache_status:'pending'};
    window.phoneFullscreenTaps=0;togglePlayerFullscreen=async()=>{phoneFullscreenTaps++;};
    renderPlayerFullscreenButton();
  });
  const full=page.locator('#player-fullscreen-button');assert.equal(await full.isEnabled(),true);
  const box=await full.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  const bubble=page.locator('.playback-control-hint.is-visible');await bubble.waitFor();
  assert.equal(await bubble.textContent(),await full.getAttribute('aria-label'));
  assert.deepEqual(await bubble.evaluate(n=>{const s=getComputedStyle(n);return [s.fontSize,s.fontWeight,s.borderRadius];}),['13px','400','12px']);
  assert.ok((await full.getAttribute('aria-describedby')).includes(await bubble.getAttribute('id')));
  assert.equal(await bubble.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true);
  if(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS&&engine===chromium){
    const out=path.resolve(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS);mkdirSync(out,{recursive:true});
    await page.screenshot({animations:'disabled',path:path.join(out,'android-fullscreen-held-hint.png')});
  }
  await page.mouse.up();await page.locator('.playback-control-hint.is-visible').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>phoneFullscreenTaps),0,'Releasing a held hint must not toggle fullscreen');
  await full.click();assert.equal(await page.evaluate(()=>phoneFullscreenTaps),1,'A fresh deliberate tap still works');
  await full.focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>phoneFullscreenTaps),2,'Keyboard activation stays available');
});

for(const engine of [chromium,webkit])for(const platform of ['android','ios'])test(`${engine.name()} ${platform} compact queue menu and page-wide request detail backdrop`,{timeout:90000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,engine);
  await page.evaluate(platform=>{fetchState=async()=>{};state.eventSource?.close();document.documentElement.dataset.hostPlatform=platform;state.data.playlist=[{id:'surface-song',display_title:'浮层测试歌曲',requester_name:'Fixture singer',cache_status:'pending'}];state.listView='queue';render();},platform);
  await go(page,'queue');
  await page.locator('.song-actions-wrap .menu-toggle').first().click();
  const menu=page.locator('.song-actions.menu-content:visible').first();
  await menu.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
  for(const width of [320,393])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:736});await page.evaluate(language=>setLanguage(language),language);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const geometry=await menu.evaluate(n=>{
      const r=n.getBoundingClientRect(),buttons=[...n.querySelectorAll('button')].map(b=>b.getBoundingClientRect());
      return {rect:r.toJSON(),height:r.height,inside:r.left>=0&&r.right<=innerWidth,heights:buttons.map(b=>b.height),touches:[...n.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b,'::before');return r.width-parseFloat(s.left)-parseFloat(s.right)>=44&&r.height-parseFloat(s.top)-parseFloat(s.bottom)>=44;}),gaps:buttons.slice(1).filter((b,i)=>Math.abs(b.top-buttons[i].top)<1).map(b=>b.left-buttons[buttons.indexOf(b)-1].right),fits:[...n.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(b);return [...range.getClientRects()].every(text=>text.top>=r.top-1&&text.bottom<=r.bottom+1&&text.left>=r.left-1&&text.right<=r.right+1);})};
    });
    assert.ok(geometry.height<=94&&geometry.inside&&geometry.fits&&geometry.touches,JSON.stringify(geometry));
    assert.ok(geometry.heights.every(h=>h===36)&&geometry.gaps.every(g=>Math.abs(g-8)<1),JSON.stringify(geometry));
  }
  await page.evaluate(()=>setLanguage('zh'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const rowMenuGeometry=n=>{
    const r=n.getBoundingClientRect(),trigger=n.closest('.song-item,.history-item').querySelector('.menu-toggle').getBoundingClientRect(),s=getComputedStyle(n);
    const containingBlocks=[];
    for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(s.transform!=='none'||s.filter!=='none'||(s.backdropFilter&&s.backdropFilter!=='none')||/layout|paint|strict|content/.test(s.contain)||/transform|filter|contain/.test(s.willChange))containingBlocks.push({id:p.id,classes:p.className,transform:s.transform,filter:s.filter,backdrop:s.backdropFilter,contain:s.contain,willChange:s.willChange});}
    return {centerDelta:(r.top+r.bottom-trigger.top-trigger.bottom)/2,radius:s.borderRadius,padding:s.padding,gap:s.gap,shadow:s.boxShadow,
      containingBlocks,actions:[...n.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(),s=getComputedStyle(b);return {height:r.height,font:s.fontSize,radius:s.borderRadius};})};
  };
  const queueGeometry=await menu.evaluate(rowMenuGeometry);
  const menuEvidence=process.env.BILIKARA_MOBILE_SURFACES_EVIDENCE;
  if(menuEvidence){mkdirSync(menuEvidence,{recursive:true});writeFileSync(path.join(menuEvidence,`menu-anchor-${platform}-${engine.name()}.json`),JSON.stringify({queue:queueGeometry},null,2));}
  assert.ok(Math.abs(queueGeometry.centerDelta)<1,'queue menu uses the ellipsis center axis: '+JSON.stringify(queueGeometry));
  for(const theme of ['dark','blue','light']){
    await page.evaluate(theme=>applyTheme(theme),theme);
    assert.equal(await menu.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=12&&r.right<=innerWidth-12&&r.top>=12&&r.bottom<=document.getElementById('android-host-dock').getBoundingClientRect().top-12;}),true,'all themes keep the menu inside the screen and above the dock');
  }
  assert.equal(await menu.evaluate(n=>getComputedStyle(n).boxShadow),await menu.evaluate(n=>{const probe=document.createElement('div');probe.style.boxShadow='var(--anchored-menu-shadow)';n.append(probe);const value=getComputedStyle(probe).boxShadow;probe.remove();return value;}));
  const evidence=process.env.BILIKARA_MOBILE_SURFACES_EVIDENCE;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));await page.screenshot({path:path.join(evidence,`queue-${platform}-${engine.name()}.png`)});}
  const closing=await page.evaluate(()=>{
    const menu=document.querySelector('.song-actions.menu-content'),toggle=document.querySelector('.song-actions-wrap .menu-toggle');
    window.originalRowMenu=menu;toggle.click();
    return {hidden:menu.classList.contains('hidden'),inert:menu.inert,animation:menu.getAnimations().length,expanded:toggle.getAttribute('aria-expanded')};
  });
  assert.deepEqual(closing,{hidden:false,inert:true,animation:1,expanded:'false'},'closing retains its node and geometry while blocking actions');
  await page.evaluate(()=>document.querySelector('.song-actions-wrap .menu-toggle').click());
  await menu.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
  assert.equal(await menu.evaluate(n=>n===originalRowMenu&&!n.inert&&!n.classList.contains('hidden')),true,'rapid reopening retires the closing callback');
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  await page.evaluate(()=>{
    const item={id:'axis-current',display_title:'歌曲标题',requester_name:'Fixture singer',cache_status:'ready'};
    renderQueueCurrent(item);
  });
  const axis=await page.evaluate(()=>{
    const r=s=>document.querySelector(s).getBoundingClientRect();
    return {badges:[r('.queue-current-progress-badge').width,r('.song-progress-badge').width],titles:[r('.queue-current-title').left,r('.song-title').left],requesters:[r('.queue-current-requester').left,r('.song-requester').left],pill:r('.song-requester').height,more:r('.song-actions-wrap .menu-toggle').height};
  });
  assert.deepEqual(axis.badges,[48,48]);assert.ok(Math.abs(axis.titles[0]-axis.titles[1])<1&&Math.abs(axis.requesters[0]-axis.requesters[1])<1,JSON.stringify(axis));
  assert.equal(axis.pill,28);assert.equal(axis.more,28,'circle radius matches the requester pill radius');
  const rowInsets=await page.evaluate(()=>[...document.querySelectorAll('.queue-current,.song-item')].filter(n=>n.getClientRects().length).map(n=>{
    const card=n.getBoundingClientRect(),title=n.querySelector('.queue-current-title,.song-title').getBoundingClientRect();
    const last=[...n.querySelectorAll('.queue-current-requester,.queue-current-actions,.song-meta-row')].filter(x=>x.getClientRects().length).map(x=>x.getBoundingClientRect().bottom);
    return {top:title.top-card.top,bottom:card.bottom-Math.max(...last)};
  }));
  assert.ok(rowInsets.length>=2&&rowInsets.every(r=>Math.abs(r.top-r.bottom)<1),JSON.stringify(rowInsets));
  if(evidence)await page.screenshot({path:path.join(evidence,`queue-cards-${platform}-${engine.name()}.png`)});
  await page.evaluate(()=>{state.data.history=[{display_title:'历史歌曲',requester_name:'Fixture singer',requested_at:1700000000,request_count:1,original_url:'https://www.bilibili.com/video/BV17x411w7KC'}];render();});
  await page.locator('[data-android-workspace="history"]').click();await settle(page);
  const insets=await page.locator('.history-item').first().evaluate(n=>{
    const card=n.getBoundingClientRect(),title=n.querySelector('.history-title').getBoundingClientRect(),meta=n.querySelector('.history-meta-row').getBoundingClientRect();
    return {top:title.top-card.top,bottom:card.bottom-meta.bottom,trigger:n.querySelector('.menu-toggle').getBoundingClientRect().height};
  });
  assert.ok(Math.abs(insets.top-insets.bottom)<1,JSON.stringify(insets));assert.equal(insets.trigger,28);
  const historyToggle=page.locator('.history-actions-wrap .menu-toggle').first();await historyToggle.click();
  const historyMenu=page.locator('.history-actions.menu-content').first();
  await historyMenu.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
  const historyGeometry=await historyMenu.evaluate(rowMenuGeometry);
  if(menuEvidence)writeFileSync(path.join(menuEvidence,`menu-anchor-${platform}-${engine.name()}.json`),JSON.stringify({queue:queueGeometry,history:historyGeometry},null,2));
  assert.ok(Math.abs(historyGeometry.centerDelta)<1,'history menu uses the same center axis');
  for(const key of ['radius','padding','gap','shadow'])assert.equal(historyGeometry[key],queueGeometry[key],'queue/history share their '+key);
  assert.ok([...queueGeometry.actions,...historyGeometry.actions].every(a=>a.height===36&&a.font==='13px'),'both menus share their action surface and typography');
  assert.equal(await historyMenu.evaluate(n=>getComputedStyle(n).gap),'8px');
  assert.equal(await historyMenu.evaluate(n=>[...n.querySelectorAll('button')].every(b=>{const s=getComputedStyle(b,'::before');return b.offsetWidth-parseFloat(s.left)-parseFloat(s.right)>=44&&b.offsetHeight-parseFloat(s.top)-parseFloat(s.bottom)>=44;})),true,'history actions keep the same full hit targets');
  if(evidence)await page.screenshot({path:path.join(evidence,`history-open-${platform}-${engine.name()}.png`)});
  const historyClosing=await page.evaluate(()=>{const n=document.querySelector('.history-actions.menu-content');document.querySelector('.history-actions-wrap .menu-toggle').click();return !n.classList.contains('hidden')&&n.inert&&n.getAnimations().length===1;});assert.equal(historyClosing,true);
  await historyMenu.waitFor({state:'hidden'});
  if(evidence)await page.screenshot({path:path.join(evidence,`history-${platform}-${engine.name()}.png`)});
  await page.emulateMedia({reducedMotion:'reduce'});await historyToggle.click();
  assert.equal(await historyMenu.evaluate(n=>n.getAnimations().length),0);
  await historyToggle.click();assert.equal(await historyMenu.evaluate(n=>n.classList.contains('hidden')),true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Real overflowing lists exercise fixed menus escaping their clipping ancestor,
  // following scroll, and clamping above the dock on a short phone viewport.
  await page.setViewportSize({width:320,height:568});
  await page.evaluate(()=>{
    state.data.playlist=Array.from({length:12},(_,i)=>({id:`menu-scroll-${i}`,display_title:`排队歌曲 ${i}`,requester_name:'Fixture singer',cache_status:'pending'}));
    state.data.history=Array.from({length:24},(_,i)=>({display_title:`历史歌曲 ${i}`,requester_name:'Fixture singer',requested_at:1700000000+i,request_count:1,original_url:`https://www.bilibili.com/video/BV17x411w7KC?p=${i+1}`}));
    render();
  });
  for(const kind of ['queue','history']){
    await go(page,'queue');
    await page.locator(`[data-android-workspace="${kind}"]`).click();await settle(page);
    const list=page.locator(kind==='queue'?'#playlist':'#history-list');
    const toggle=list.locator('.menu-toggle').nth(5);
    await toggle.evaluate(n=>{
      const list=n.closest('.playlist,.history-list'),r=n.getBoundingClientRect(),p=list.getBoundingClientRect(),dock=document.getElementById('android-host-dock').getBoundingClientRect();
      list.scrollTop+=(r.top+r.bottom)/2-(p.top+Math.min(p.bottom,dock.top))/2;
    });await toggle.focus();await page.keyboard.press('Enter');
    const popup=list.locator('.menu-content:not(.hidden)').first();
    await popup.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
    const before=await popup.boundingBox();
    const triggerBefore=await toggle.boundingBox();
    const scrollBefore=await list.evaluate(n=>({top:n.scrollTop,range:n.scrollHeight-n.clientHeight,count:n.children.length}));
    assert.ok(scrollBefore.range>48,'the fixture must overflow the expanded viewport before testing scroll-follow');
    await list.evaluate(n=>{n.scrollTop+=24;});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const after=await popup.boundingBox();
    assert.ok(Math.abs(before.y-after.y-24)<1,'the open menu follows its row when the list scrolls: '+JSON.stringify({kind,before,after,triggerBefore,triggerAfter:await toggle.boundingBox(),port:await list.boundingBox(),scrollBefore,scrollAfter:await list.evaluate(n=>n.scrollTop)}));
    assert.ok(Math.abs((await popup.evaluate(rowMenuGeometry)).centerDelta)<1,'the scrolled menu retains the shared center axis');
    assert.equal(await popup.evaluate(n=>[...n.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})),true,'list overflow does not clip menu action hit targets');
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
    assert.equal(await toggle.evaluate(n=>n===document.activeElement),true,'Escape restores focus to the trigger');
    await list.evaluate(n=>{n.scrollTop=n.scrollHeight;});
    const lastTarget=await list.locator('.menu-toggle').last().evaluate(n=>{
      const r=n.getBoundingClientRect(),list=n.closest('.playlist,.history-list'),s=getComputedStyle(list),dock=document.getElementById('android-host-dock').getBoundingClientRect();
      return {hit:n.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)),top:r.top,bottom:r.bottom,dock:dock.top,
        padding:s.paddingBottom,scroll:list.scrollTop,range:list.scrollHeight-list.clientHeight};
    });
    assert.equal(lastTarget.hit,true,kind+' final trigger stays above the dock: '+JSON.stringify(lastTarget));
    await list.locator('.menu-toggle').last().click();
    const lastMenu=list.locator('.menu-content:not(.hidden)').last();
    await lastMenu.evaluate(n=>Promise.allSettled(n.getAnimations().map(a=>a.finished)));
    assert.equal(await lastMenu.evaluate(n=>{const r=n.getBoundingClientRect(),dock=document.getElementById('android-host-dock').getBoundingClientRect();return r.left>=12&&r.right<=innerWidth-12&&r.top>=12&&r.bottom<=dock.top-12+.5&&[...n.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});}),true,'all commands on the final row remain visible and actionable above the dock');
    if(evidence)await page.screenshot({path:path.join(evidence,`${kind}-short-bottom-${platform}-${engine.name()}.png`)});
    await page.keyboard.press('Escape');await lastMenu.waitFor({state:'hidden'});
  }
  await page.keyboard.press('Escape');await go(page,'request');
  await page.evaluate(()=>{initSearchDetailController();searchDetailController.open({title:'整页遮罩测试',url:'https://www.bilibili.com/video/BV1xx411c7mD',bvid:'BV1xx411c7mD',owner_name:'示例作者'});});
  const detail=page.locator('.song-detail-view:not(.hidden)');
  assert.deepEqual(await detail.evaluate(n=>{const r=n.getBoundingClientRect(),b=n.querySelector('.song-detail-backdrop').getBoundingClientRect();return [n.parentElement===document.body,r.x,r.y,r.width===innerWidth,r.height===innerHeight,b.width===innerWidth,b.height===innerHeight];}),[true,0,0,true,true,true,true]);
  assert.equal(await detail.getAttribute('role'),'dialog');assert.equal(await detail.getAttribute('aria-modal'),'true');
  assert.equal(await detail.getAttribute('aria-labelledby'),await detail.locator('.song-detail-title').getAttribute('id'));
  await detail.locator('[data-song-detail-close]').focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await detail.locator('[data-song-detail-next]').evaluate(n=>n===document.activeElement),true);
  await page.keyboard.press('Tab');assert.equal(await detail.locator('[data-song-detail-close]').evaluate(n=>n===document.activeElement),true);
  if(evidence){await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished)));await page.screenshot({path:path.join(evidence,`detail-${platform}-${engine.name()}.png`)});}
  await page.locator('[data-song-detail-close]').click();await detail.waitFor({state:'hidden'});
  await page.evaluate(()=>{document.documentElement.dataset.hostPlatform='desktop';searchDetailController.open({title:'Desktop contextual detail',url:'https://www.bilibili.com/video/BV1xx411c7mD'});});
  assert.equal(await detail.evaluate(n=>n.parentElement===elements.requestWorkspace),true,'desktop retains its contextual detail parent');
  assert.equal(await detail.getAttribute('aria-modal'),'false');
});
