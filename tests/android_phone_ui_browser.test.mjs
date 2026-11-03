import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {mkdirSync, rmSync} from 'node:fs';
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
  const scrolled=await page.locator('#stage-control-tray').evaluate(n=>{n.scrollTop=n.scrollHeight;return {top:n.scrollTop,overflow:n.scrollHeight-n.clientHeight};});
  assert.ok(scrolled.top>0&&scrolled.overflow>0,'Only the controls region scrolls on a short phone');
  assert.deepEqual(await page.locator('#player-frame').boundingBox(),frame,'Scrolling controls must not move playback');
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
    const titles=[];
    for(const name of ['queue','history','users','my','request']){
      if(name==='history')await page.locator('[data-android-workspace="history"]').click();
      else await go(page,name);
      titles.push(await page.locator('#android-page-heading').evaluate(n=>{
        const tag=n.querySelector('.section-tag'),title=n.querySelector('h2');
        const typography=node=>{const s=getComputedStyle(node);return [s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing,s.fontFamily];};
        return [tag.getBoundingClientRect().x,title.getBoundingClientRect().x,typography(tag),typography(title)];
      }));
      if(name==='queue'||name==='history'){
        const inset=await page.locator(`#host-workspace-${name}`).evaluate(n=>{const c=n.getBoundingClientRect(),r=n.querySelector('.list-stage').getBoundingClientRect();return [r.top-c.top,r.left-c.left,c.right-r.right];});
        assert.ok(Math.max(...inset)-Math.min(...inset)<1,'List starts with equal top/side card insets: '+JSON.stringify(inset));
        const aligned=await page.locator('#android-page-heading').evaluate(n=>{
          const r=n.getBoundingClientRect(),a=n.querySelector('.queue-toolbar').getBoundingClientRect();return Math.abs(r.top-a.top)<1&&Math.abs(r.right-a.right)<1;
        });assert.equal(aligned,true);
      }
      if(name==='users'){
        assert.equal(await page.locator('[aria-describedby="session-users-help"]').count(),0);
        assert.equal(await page.locator('.session-user-guidance').isVisible(),true);
        const emphasis=await page.locator('.session-user-prerequisite').evaluate(n=>[getComputedStyle(n).color,getComputedStyle(n).fontWeight]);
        assert.deepEqual(emphasis,await page.locator('#gatcha-session-user-notice').evaluate(n=>[getComputedStyle(n).color,getComputedStyle(n).fontWeight]));
      }
    }
    titles.forEach(title=>assert.deepEqual(title,titles[0],'All external heading pairs share the same axis and type scale'));
    for(const view of ['search','discover','sources']){
      await page.locator(`[data-request-view="${view}"]`).click();
      const frame=await page.locator(`.request-${view}-view > .request-mode-panel:not([hidden])`).first().evaluate(n=>{
        const s=getComputedStyle(n);return [s.paddingTop,s.paddingLeft,s.paddingRight];
      });assert.deepEqual(frame,['14px','14px','14px']);
      const segment=await page.locator('#android-request-tabs > .request-mode-head').evaluate(head=>{
        const selected=head.querySelector('[aria-selected="true"]'),r=head.getBoundingClientRect(),b=selected.getBoundingClientRect(),s=getComputedStyle(selected);
        return {clipped:getComputedStyle(head).overflow,top:b.top+parseFloat(s.borderTopWidth)-r.top,bottom:r.bottom-b.bottom+parseFloat(s.borderBottomWidth)};
      });assert.equal(segment.clipped,'hidden');assert.ok(segment.top>=3.9&&segment.bottom>=3.9,'The painted fill stays inside the segmented track');
      await page.locator('#android-request-tabs [data-request-back]').click();
    }
    const quick=await page.locator('#request-quick-panel').evaluate(n=>{
      const p=n.closest('#host-workspace-request').getBoundingClientRect(),tag=n.querySelector('.section-tag').getBoundingClientRect(),title=n.querySelector('h3').getBoundingClientRect();const typography=node=>{const s=getComputedStyle(node);return [s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing,s.fontFamily];};return {position:[tag.x-p.x,tag.y-p.y,title.x-p.x,title.y-p.y],type:[typography(n.querySelector('.section-tag')),typography(n.querySelector('h3,h2'))]};
    });
    await page.locator('#android-request-random').click();
    const random=await page.locator('#gatcha-panel').evaluate(n=>{
      const p=n.getBoundingClientRect(),tag=n.querySelector('.section-tag').getBoundingClientRect(),title=n.querySelector('h2').getBoundingClientRect();const typography=node=>{const s=getComputedStyle(node);return [s.fontSize,s.fontWeight,s.lineHeight,s.letterSpacing,s.fontFamily];};return {position:[tag.x-p.x,tag.y-p.y,title.x-p.x,title.y-p.y],type:[typography(n.querySelector('.section-tag')),typography(n.querySelector('h3,h2'))]};
    });quick.position.forEach((value,i)=>assert.ok(Math.abs(value-random.position[i])<1,JSON.stringify({quick,random})));
    assert.deepEqual(quick.type,random.type,'Quick Request and Gatcha share heading typography');
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

test('Android My keeps its scroll frame, cache lines, login link and settings animation geometry', {timeout:90000,skip:process.platform!=='linux'}, async t=>{
  const {page,host}=await open(t,chromium);await go(page,'my');
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
      await Promise.allSettled(incoming.getAnimations().map(a=>a.finished));return {previous:previous.top,final:incoming.getBoundingClientRect().top,tops,scrolls};
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

test('Android user tools stay at the card bottom and the dock highlight leaves its full touch slot intact',{timeout:60000,skip:process.platform!=='linux'},async t=>{
  const {page}=await open(t,chromium);await go(page,'users');
  const placement=await page.locator('#session-users-panel').evaluate(n=>{const r=n.getBoundingClientRect(),f=n.querySelector('.session-user-tools').getBoundingClientRect();return {bottom:r.bottom-f.bottom,right:r.right-f.right};});
  assert.ok(placement.bottom>=14&&placement.bottom<=16,JSON.stringify(placement));assert.ok(Math.abs(placement.bottom-placement.right)<1);
  for(const width of [320,393,650])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:736});await page.evaluate(language=>setLanguage(language),language);
    const geometry=await page.locator('#android-host-dock [aria-current]').evaluate(n=>{const p=getComputedStyle(n,'::before'),r=n.getBoundingClientRect();return {target:r.width,visible:parseFloat(p.width),height:r.height,fits:[...n.querySelectorAll('span')].filter(s=>getComputedStyle(s).display!=='none').every(s=>s.getBoundingClientRect().width<=parseFloat(p.width))};});
    assert.ok(geometry.target>=44&&geometry.height>=44);assert.ok(geometry.visible<=68&&geometry.visible<geometry.target);assert.equal(geometry.fits,true,JSON.stringify({width,language,geometry}));
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
  await page.locator('#lark-search-form input').fill('Fixture');await page.locator('#lark-search-form button[type="submit"]').click();
  const frame=page.locator('#request-search-shared .android-result-frame'),pager=frame.locator('.result-pager'),results=page.locator('#lark-search-results');
  await page.waitForFunction(()=>!document.getElementById('lark-search-button').disabled);
  assert.equal(await results.locator('.search-result-item').count(),6);assert.equal(await pager.locator('[data-page-input]').inputValue(),'1');
  assert.equal(await results.locator('.search-result-title').first().textContent(),'Fixture song 1');
  const cdp=await page.context().newCDPSession(page);t.after(()=>cdp.detach().catch(()=>{}));
  const swipe=async locator=>{const r=await locator.boundingBox(),y=r.y+Math.min(40,r.height/2),x=r.x+r.width*.8;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(const fraction of [.15,.35,.6])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-r.width*fraction,y:y+2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  await swipe(frame.locator('.result-page-viewport'));await page.waitForFunction(()=>document.querySelector('#request-search-shared [data-page-input]').value==='2');
  assert.equal(await results.locator('.search-result-title').first().textContent(),'Fixture song 7');
  await pager.locator('[data-page-action="last"]').click();await page.waitForFunction(()=>document.querySelector('#request-search-shared [data-page-input]').value==='20');
  assert.equal(await results.locator('.search-result-title').first().textContent(),'Fixture song 115');assert.ok(requests.some(r=>r.offset===114));
  const viewport=await frame.locator('.result-page-viewport').boundingBox(),footer=await pager.boundingBox();assert.ok(footer.y>=viewport.y+viewport.height-1);assert.ok(footer.y+footer.height<668,'Page controls stay above phone navigation');
  await page.locator('#lark-search-form input').fill('Recovery');await page.locator('#lark-search-form button[type="submit"]').click();
  await page.waitForFunction(()=>!document.getElementById('lark-search-button').disabled);assert.equal(await pager.locator('[data-page-input]').inputValue(),'1');
  await page.locator('#android-request-tabs [data-request-back]').click();await page.locator('[data-request-view="discover"]').click();
  const tags=Array.from({length:25},(_,i)=>({tag:`Artist ${i+1}`,count:120}));
  await page.route('**/api/d1/browse?**',route=>{
    const q=new URL(route.request().url()),tag=q.searchParams.get('tag'),offset=Number(q.searchParams.get('offset')||0),limit=Number(q.searchParams.get('limit')||100);
    return route.fulfill({json:{ok:true,data:{tags:tag?[]:tags,items:tag?items.slice(offset,offset+limit):[],matched_count:tag?120:25,has_more:tag&&offset+limit<120,next_offset:Math.min(120,offset+limit)}}});
  });
  await page.locator('[data-discover-mode="artist"]').click();await page.locator('#request-discover-artist [data-letter="A"]').click();
  const tagGrid=page.locator('#request-discover-artist [data-d1-browse-tags]');await tagGrid.locator('button').first().waitFor();assert.equal(await tagGrid.locator('button').count(),12);
  const tagsFrame=tagGrid.locator('..').locator('..');await tagsFrame.locator('[data-page-action="next"]').click();assert.equal(await tagGrid.locator('button').first().getAttribute('data-tag'),'Artist 13');
  await tagGrid.locator('button').first().click();const songs=page.locator('#request-discover-artist [data-d1-browse-results]');await songs.locator('.search-result-item').first().waitFor();assert.equal(await songs.locator('.search-result-item').count(),6);
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
