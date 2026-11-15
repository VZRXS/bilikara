// Shipped UI over an actual isolated Rust Host, with synthetic TouchEvents.
// This exercises ownership/routing; it is not native gesture/device acceptance.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before} from 'node:test';
import {chromium,webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {HttpClient,RunningHost,isolatedEnvironment} from './native_host_support.mjs';
let alpha;
before(async()=>{if(process.platform==='linux')alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();},{timeout:300000});

async function swipe(page,{direction=1,target='',dx,dy=2,cancel=false,multi=false,edge=false,preview=false,remote=false}={}) {
  return page.evaluate(({direction,target,dx,dy,cancel,multi,edge,preview,remote})=>{
    const current=()=>remote?`request.${state.remoteRequestView}${({search:state.remoteSearchMode,discover:state.remoteDiscoverMode,sources:state.remoteSourcesMode}[state.remoteRequestView])?'.'+({search:state.remoteSearchMode,discover:state.remoteDiscoverMode,sources:state.remoteSourcesMode}[state.remoteRequestView]):''}`:BilikaraHostSubTabs.current();
    const key=current(),[scope,view,child]=key.split('.');
    const content=remote?[...elements.remoteRequestViewPanels].find(node=>!node.hidden):scope==='queue'?document.querySelector(`[data-host-workspace-panel="${view}"]`)
      :view==='random'?document.getElementById('gatcha-panel'):document.querySelector(child?`[data-${view}-panel="${child}"]`:`[data-request-panel="${view}"]`);
    const element=target?document.querySelector(target):content;
    if(!element)throw Error('No gesture target for '+key);
    const frame=!remote&&BilikaraHostLayout.isPortrait()?elements.hostWorkspaceRegion:content;
    const sample=()=>{
      const rect=node=>{const b=node.getBoundingClientRect();return [b.x,b.y,b.width,b.height];};
      return {transform:getComputedStyle(frame).transform,inline:frame.style.transform,rect:rect(frame),originRect:rect(element),
        scroll:[document.scrollingElement.scrollTop,frame.scrollTop,element.scrollTop],
        motion:document.documentElement.dataset.hostSubtabMotion||'',focus:document.activeElement?.id,
        animations:[...new Set([frame,element])].reduce((n,node)=>n+node.getAnimations().length,0),
        selected:[...document.querySelectorAll('[role="tab"]')].map(node=>node.getAttribute('aria-selected'))};
    };
    const bounds=element.getBoundingClientRect(),x=edge?8:Math.min(innerWidth-32,bounds.right-32),y=Math.max(0,bounds.y+Math.min(140,bounds.height/2));
    const emit=(type,x,y,count=1)=>{
      const touches=Array.from({length:count},(_,identifier)=>({identifier,target:element,clientX:x+identifier*10,clientY:y}));
      const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:touches},changedTouches:{value:touches}});element.dispatchEvent(event);return event.defaultPrevented;
    };
    const initial=sample();
    emit('touchstart',x,y);const prevented=[emit('touchmove',x-direction*16,y+dy/4),
      emit('touchmove',x+(dx??-direction*120),y+dy,multi?2:1)];
    const during=sample();
    if(!preview)emit(cancel?'touchcancel':'touchend',x+(dx??-direction*120),y+dy);
    return {before:key,after:current(),transform:frame.style.transform,initial,during,finished:sample(),prevented};
  },{direction,target,dx,dy,cancel,multi,edge,preview,remote});
}

async function fixedSwipe(page,options) {
  // Let any previous *content* transition finish before comparing the fixed
  // origin, including Queue/History panels and their outgoing transitions.
  // Wait for settlement/cleanup and a layout frame, not a sampled playState.
  await page.evaluate(async selector=>{
    const origin=document.querySelector(selector);
    const panels='.host-workspace-region,[data-host-workspace-panel],[data-request-panel],[data-search-panel],[data-discover-panel],[data-sources-panel],.remote-request-view';
    // Only rendered panel/origin-ancestor targets can move the fixed origin.
    // WebKit can retain unresolved transitions on hidden nodes, so a document-
    // wide wait could never settle.
    const pending=()=>document.getAnimations().filter(animation=>{
      const node=animation.effect?.target;
      return animation.effect?.getTiming().iterations!==Infinity
        && (animation.pending||animation.playState==='running')
        && (node?.matches?.(panels)||(origin&&node?.contains?.(origin)))
        && node.checkVisibility?.({contentVisibilityAuto:true})!==false;
    });
    do {
      await Promise.allSettled(pending().map(animation=>animation.finished));
      await new Promise(resolve=>requestAnimationFrame(resolve));
    } while(pending().length);
  },options.target);
  await page.waitForFunction(()=>!document.documentElement.dataset.hostSubtabMotion);
  // Inspect the move itself, not just the restored end state.
  const result=await swipe(page,options);
  assert.ok(result.initial.originRect[2]>0&&result.initial.originRect[3]>0,options.target+': exercise a rendered fixed origin');
  assert.equal(result.initial.motion,'',options.target+': no prior content motion remains');
  assert.equal(result.after,result.before,options.target+': fixed origin cannot navigate');
  assert.deepEqual(result.during,result.initial,options.target+': zero transform, animations, geometry, selection, focus or scroll changes during move');
  assert.deepEqual(result.finished,result.initial,options.target+': fixed origin leaves no motion or state changes');
  assert.deepEqual(result.prevented,[false,false],options.target+': fixed origin does not capture native gestures');
  return result;
}

for(const [name,engine]of Object.entries({chromium,webkit}))test(`${name}: intra-section leaf traversal never selects a primary tab or rebuilds playing media`,{
  skip:process.platform!=='linux'&&'Linux browser gesture evidence; physical mobile gates remain separate',timeout:120000,
},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-subtab-'));
  let host,browser;
  t.after(async()=>{try{if(browser)await browser.close();}finally{try{if(host)await host.close();}finally{rmSync(home,{recursive:true,force:true});}}});
  const files=[];
  for(const [fixture,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
    const file=path.join(home,name),built=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',fixture),'-t','90','-c','copy','-movflags','+faststart',file],process.env,30000);
    assert.equal(built.status,0,built.stderr);files.push(file);
  }
  host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),...files],isolatedEnvironment(home),true);
  browser=await engine.launch({headless:true});
  const context=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
  await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.base);await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
  await page.evaluate(()=>{window.pair={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};window.dockSelections=0;window.addEventListener('bilikara:ios-dock-select',()=>dockSelections++);});
  await page.locator('[data-android-page="request"]').click();
  await page.evaluate(()=>activateRequestSubview('quick'));
  await fixedSwipe(page,{target:'#android-page-heading'});
  await page.evaluate(()=>activateRequestSubview('search'));
  await fixedSwipe(page,{target:'[data-search-mode="local"]'});
  await page.locator('[data-search-mode="local"]').dispatchEvent('click',{detail:1});
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.local',
    'a fixed-origin drag does not install click suppression');
  await page.locator('[data-search-mode="shared"]').click();
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.shared','a subsequent direct tap still works');
  await fixedSwipe(page,{target:'[data-search-mode="local"]',direction:-1});
  await page.evaluate(()=>activateRequestSubview('search'));
  await fixedSwipe(page,{target:'[data-search-mode="local"]',dx:-18});
  await page.locator('[data-search-mode="local"]').dispatchEvent('click',{detail:1});
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.local',
    'a short fixed-origin drag leaves ordinary tab activation available');
  await page.locator('[data-search-mode="shared"]').dispatchEvent('click',{detail:0});
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.shared','keyboard activation is never swallowed');
  await page.evaluate(()=>activateRequestSubview('quick'));
  const length=await page.evaluate(()=>history.length);
  const sequence=['request.quick','request.search.shared','request.search.local','request.discover.categories','request.discover.name','request.discover.artist','request.sources.uids','request.sources.favorites','request.random'];
  assert.deepEqual(await page.evaluate(()=>BilikaraSubTabSwipe.flatten(BilikaraHostSubTabs.tree()).map(n=>n.key)),sequence);
  for(const expected of sequence.slice(1)) {
    const moved=await swipe(page);assert.equal(moved.after,expected,JSON.stringify(moved));
    assert.equal(await page.locator('#android-host-dock [aria-current="page"]').getAttribute('data-android-page'),'request');
  }
  assert.equal((await swipe(page)).after,'request.random');
  for(const expected of sequence.slice(0,-1).reverse())assert.equal((await swipe(page,{direction:-1})).after,expected);
  assert.equal((await swipe(page,{direction:-1})).after,'request.quick');
  assert.equal(await page.evaluate(()=>history.length),length,'Flicks replace only the current within-section route');
  assert.equal(await page.evaluate(()=>dockSelections),0);
  // A direct parent tap restores its remembered child; a neighboring swipe
  // still chooses shared rather than skipping to that remembered local child.
  await page.evaluate(()=>{activateRequestSubview('search');activateSearchMode('local');activateRequestSubview('quick');activateRequestSubview('search');});
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.local');
  await page.evaluate(()=>activateRequestSubview('quick'));
  assert.equal((await swipe(page)).after,'request.search.shared');
  for(const options of [{cancel:true},{multi:true},{edge:true},{dy:150,dx:30}]){
    const unchanged=await swipe(page,options);assert.equal(unchanged.after,unchanged.before);
    assert.equal(unchanged.transform,'');
  }
  const held=await swipe(page,{preview:true});assert.equal(held.before,held.after);assert.ok(held.transform);
  const motion=await page.evaluate(()=>{
    const n=elements.hostWorkspaceRegion, b=n.getBoundingClientRect(),frame=document.querySelector('.shell-body').getBoundingClientRect();
    return {width:b.width,expected:frame.width,overflow:getComputedStyle(n.parentElement).overflowX,padding:getComputedStyle(n).paddingLeft};
  });
  assert.equal(motion.width,motion.expected,'the complete page frame moves, including both content gutters');
  assert.equal(motion.overflow,'visible');assert.equal(motion.padding,'14px');
  await page.evaluate(()=>dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('.host-workspace-region').evaluate(n=>n.style.transform),'');
  // Pager ownership is captured even at its last page. Never hand the gesture
  // to the outer leaf resolver or use an input/slider as the scope owner.
  await page.evaluate(()=>{
    const area=document.querySelector('[data-search-panel="shared"]');
    const pager=document.createElement('div');pager.className='result-page-viewport';pager.id='last-page-owner';pager.style.height='60px';area.append(pager);
  });
  assert.equal((await swipe(page,{target:'#last-page-owner'})).after,'request.search.shared');
  await fixedSwipe(page,{target:'#shared-search-query'});
  await page.locator('#shared-search-query').tap();
  assert.equal(await page.locator('#shared-search-query').evaluate(node=>node===document.activeElement),true,
    'a fixed field still accepts focus for editing');
  await page.evaluate(()=>activateSearchMode('shared'));
  // Exercise the shipped pager, not just its ownership class. Card swipes
  // page results; a fixed heading never becomes a route gesture zone.
  await page.evaluate(()=>{
    const area=document.querySelector('[data-search-panel="shared"]'),cards=document.createElement('div');
    cards.id='gesture-result-cards';cards.style.height='70px';area.prepend(cards);
    window.gesturePager=BilikaraResultPager.create(cards,{translate:t,rows:0,
      renderItems:(items,_message,target=cards)=>{target.textContent=items.join(' ');},reportError:error=>{throw error;}});
    gesturePager.update({key:'gesture-ownership',items:['first card','second card'],total:2,pageSize:1,hasMore:false});
  });
  assert.equal((await swipe(page,{target:'#gesture-result-cards'})).after,'request.search.shared');
  await page.waitForFunction(()=>document.getElementById('gesture-result-cards').textContent==='second card');
  assert.equal((await swipe(page,{target:'#gesture-result-cards'})).after,'request.search.shared',
    'the final result page does not hand the same drag to a tab');
  await fixedSwipe(page,{target:'#android-page-heading'});
  await page.evaluate(()=>{gesturePager.hide();activateSearchMode('shared');});
  // Actual overflow retains its own gesture in a fixed bar as well.
  await page.evaluate(()=>{
    const bar=document.querySelector('[data-search-mode="shared"]').parentElement;
    window.gestureBar=bar;window.gestureBarStyle=bar.getAttribute('style');
    bar.style.cssText+=';width:100px;min-width:0;max-width:100px;overflow-x:auto;display:flex;';
    for(const child of bar.children){child.dataset.oldStyle=child.getAttribute('style')||'';child.style.cssText+=';flex:0 0 160px;';}
  });
  assert.equal(await page.evaluate(()=>gestureBar.scrollWidth>gestureBar.clientWidth+1),true);
  await fixedSwipe(page,{target:'[data-search-mode="shared"]'});
  await page.evaluate(()=>{
    for(const child of gestureBar.children){child.setAttribute('style',child.dataset.oldStyle);delete child.dataset.oldStyle;}
    if(gestureBarStyle===null)gestureBar.removeAttribute('style');else gestureBar.setAttribute('style',gestureBarStyle);
  });
  await fixedSwipe(page,{target:'#shared-search-button'});
  // The screenshot's Sources/Favorites fixed layer includes both blank space
  // and nested navigation/query controls. None may even preview a new leaf.
  await page.evaluate(()=>{activateRequestSubview('sources');activateSourcesMode('favorites');});
  for(const target of ['#android-page-heading','#android-page-tools','#android-request-tabs > .request-mode-head',
    '#android-request-tabs [data-request-back]','[data-sources-mode="uids"]','[data-sources-mode="favorites"]',
    '[data-sources-panel="favorites"] .source-action-row','#modal-favlist-uid-input']) await fixedSwipe(page,{target});
  await page.locator('[data-sources-mode="uids"]').tap();
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.sources.uids');
  await page.evaluate(()=>activateRequestSubview('search'));
  await page.evaluate(()=>activateSearchMode('shared'));
  await page.locator('[data-android-page="users"]').click();
  await page.goBack();
  assert.equal(await page.locator('#android-host-dock [aria-current="page"]').getAttribute('data-android-page'),'request');
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.shared','Back restores the complete ancestor/child route');
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await swipe(page,{preview:true});assert.equal(reduced.transform,'');
  await page.evaluate(()=>dispatchEvent(new Event('orientationchange')));
  assert.equal(await page.evaluate(()=>BilikaraHostSubTabs.current()),'request.search.shared');
  assert.equal((await swipe(page)).after,'request.search.local');
  assert.equal(await page.locator('[data-search-panel="local"]').evaluate(n=>n.getAnimations().length),0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('[data-android-page="queue"]').click();
  await fixedSwipe(page,{target:'#android-page-heading'});
  assert.equal((await swipe(page)).after,'queue.history');
  assert.equal((await swipe(page,{direction:-1})).after,'queue.queue');
  for(const primary of ['playback','users','my']) {
    await page.locator(`[data-android-page="${primary}"]`).click();
    await page.evaluate(()=>{
      const element=document.querySelector('.app-shell');
      for(const [type,x]of [['touchstart',280],['touchmove',120],['touchend',120]]){
        const touch=({identifier:0,target:element,clientX:x,clientY:350});
        const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[touch]},changedTouches:{value:[touch]}});element.dispatchEvent(event);
      }
    });
    assert.equal(await page.locator('#android-host-dock [aria-current="page"]').getAttribute('data-android-page'),primary);
  }
  assert.deepEqual(await page.evaluate(()=>({same:state.hostPlaybackSession.video===pair.video&&state.hostPlaybackSession.audio===pair.audio,
    playing:!pair.video.paused&&!pair.audio.paused,errors:dockSelections})),{same:true,playing:true,errors:0});
  // Remote uses the same resolver with its own eight-leaf scope and fixed
  // exclusions. It cannot invoke Host primary navigation.
  await host.api('/api/session-users/add',{name:'Swipe visitor'});
  const remoteContext=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
  const client=new HttpClient(host.base);await client.request('/remote');
  await remoteContext.addCookies([...client.cookies].map(([name,value])=>({name,value,url:host.base})));
  await remoteContext.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
  const remote=await remoteContext.newPage();remote.on('pageerror',e=>errors.push(e.message));
  await remote.goto(host.base+'/remote');
  await remote.waitForFunction(()=>typeof state!=='undefined'&&state.data&&!state.remoteIdentityChecking);
  await remote.evaluate(async()=>{
    applyRemoteIdentity(await apiPost('/api/remote-identity/register',{name:'Swipe visitor',claim:true}));
    state.eventSource?.close();fetchState=async()=>{};
  });
  await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});
  await fixedSwipe(remote,{remote:true,target:'#remote-request-search-tab',direction:-1});
  await remote.locator('#remote-request-search-tab').dispatchEvent('click',{detail:1});
  assert.equal(await remote.evaluate(()=>state.remoteRequestView),'search',
    'a fixed-origin boundary drag does not suppress subsequent tab activation');
  await fixedSwipe(remote,{remote:true,target:'.remote-request-head'});
  await fixedSwipe(remote,{remote:true,target:'#remote-search-local-tab'});
  await remote.locator('#remote-search-local-tab').dispatchEvent('click',{detail:1});
  assert.equal(await remote.evaluate(()=>state.remoteSearchMode),'local');
  await remote.locator('#remote-search-shared-tab').click();
  assert.equal(await remote.evaluate(()=>state.remoteSearchMode),'shared');
  await fixedSwipe(remote,{remote:true,target:'#remote-request-secondary-back'});
  await remote.locator('#remote-request-secondary-back').tap();
  assert.equal(await remote.evaluate(()=>state.remoteRequestView),'quick','a stationary Back tap retains its action');
  await remote.evaluate(()=>{activateRemoteRequestView('sources');activateRemoteSourcesMode('favorites');});
  for(const target of ['.remote-request-head','.remote-request-tabs-viewport','#remote-request-secondary-back',
    '#remote-sources-uids-tab','#sources-favlist-pull-form','#sources-favlist-uid-input']) await fixedSwipe(remote,{remote:true,target});
  await remote.evaluate(()=>activateRemoteRequestView('quick'));
  const remoteSequence=sequence.slice(0,-1);
  for(const expected of remoteSequence.slice(1)) assert.equal((await swipe(remote,{remote:true})).after,expected);
  assert.equal((await swipe(remote,{remote:true})).after,'request.sources.favorites');
  for(const expected of remoteSequence.slice(0,-1).reverse()) assert.equal((await swipe(remote,{remote:true,direction:-1})).after,expected);
  assert.equal((await swipe(remote,{remote:true,direction:-1})).after,'request.quick');
  await remoteContext.close();
  assert.deepEqual(errors,[]);
});

for (const [name, engine] of Object.entries({chromium, webkit})) test(`${name}: landscape tablet touch routes and desktop pointer ownership [P3]`, {
  skip: process.platform !== 'linux', timeout: 120000,
}, async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-tablet-subtab-'));
  let host, browser;
  t.after(async () => {
    try { await browser?.close(); } finally {
      try { await host?.close(); } finally { rmSync(home, {recursive: true, force: true}); }
    }
  });
  host = await RunningHost.start(alpha, home, [home, path.join(root, 'static')], isolatedEnvironment(home), true);
  browser = await engine.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1024, height: 768}, hasTouch: true});
  await context.addCookies([...host.cookies].map(([name, value]) => ({name, value, url: host.base})));
  await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== host.base) return route.abort();
    if (url.pathname === '/') {
      const response = await route.fetch();
      return route.fulfill({response, body: (await response.text()).replace('data-host-platform="android"', 'data-host-platform="ios"')});
    }
    return route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base);
  await page.waitForFunction(() => state.hasValidStateResponse);
  assert.equal(await page.evaluate(() => BilikaraHostLayout.isPortrait()), false);
  await page.locator('[data-host-workspace="request"]').click();
  await page.evaluate(() => activateRequestSubview('quick'));
  await fixedSwipe(page, {target: '#workspace-request-heading'});
  assert.equal((await swipe(page)).after, 'request.search.shared');
  await fixedSwipe(page, {target: '#shared-search-query'});
  assert.equal((await swipe(page)).after, 'request.search.local');
  await page.evaluate(() => {
    const cards = document.createElement('div');
    cards.id = 'tablet-page-owner'; cards.style.height = '64px';
    document.querySelector('[data-search-panel="local"]').append(cards);
    window.tabletPager = BilikaraResultPager.create(cards, {translate: t, rows: 0,
      renderItems: (items, _message, target = cards) => { target.textContent = items.join(' '); }});
    tabletPager.update({key: 'tablet-owner', items: ['first', 'second'], total: 2, pageSize: 1, hasMore: false});
  });
  assert.equal((await swipe(page, {target: '#tablet-page-owner'})).after, 'request.search.local');
  await page.waitForFunction(() => document.getElementById('tablet-page-owner').textContent === 'second');
  assert.equal((await swipe(page, {target: '#tablet-page-owner'})).after, 'request.search.local');
  await page.locator('[data-host-workspace="random"]').click();
  assert.equal(await page.locator('#gatcha-pool-config-toggle').isEnabled(), true);
  await fixedSwipe(page, {target: '#gatcha-pool-config-toggle', direction: -1});
  assert.equal(await page.locator('#gatcha-pool-config-modal').isVisible(), false);
  assert.equal((await swipe(page, {direction: -1})).after, 'request.sources.favorites',
    'landscape content space retains adjacent navigation when fixed tools are excluded');
  await page.locator('[data-host-workspace="random"]').click();
  await page.locator('#gatcha-pool-config-toggle').tap();
  await page.locator('#gatcha-pool-config-modal').waitFor({state: 'visible'});
  assert.equal((await swipe(page, {target: '#gatcha-pool-config-toggle', direction: -1})).after, 'request.random');
  await page.locator('#gatcha-pool-config-modal-close').click();
  await page.locator('#gatcha-pool-config-modal').waitFor({state: 'hidden'});
  await page.locator('[data-host-workspace="queue"]').click();
  await fixedSwipe(page, {target: '#workspace-queue-heading'});
  assert.equal((await swipe(page)).after, 'queue.history');
  await fixedSwipe(page, {target: '#workspace-history-heading', direction: -1});
  assert.equal((await swipe(page, {direction: -1})).after, 'queue.queue');
  assert.deepEqual(errors, []);

  // Touch-capable layouts do not turn mouse text selection into navigation.
  const mouseContext = await browser.newContext({viewport: {width: 1024, height: 768}, hasTouch: false});
  await mouseContext.addCookies([...host.cookies].map(([name, value]) => ({name, value, url: host.base})));
  await mouseContext.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
  await mouseContext.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const desktop = await mouseContext.newPage();
  await desktop.goto(host.base); await desktop.waitForFunction(() => state.hasValidStateResponse);
  await desktop.evaluate(() => { activateHostWorkspace('request'); activateRequestSubview('quick'); });
  const heading = await desktop.locator('#workspace-request-heading').boundingBox();
  const x = Math.min(980, heading.x + heading.width - 24), y = heading.y + heading.height / 2;
  await desktop.mouse.move(x, y); await desktop.mouse.down();
  await desktop.mouse.move(x - 140, y + 2, {steps: 5}); await desktop.mouse.up();
  assert.equal(await desktop.evaluate(() => BilikaraHostSubTabs.current()), 'request.quick');
  const pointerSwipe = targetSelector => desktop.evaluate(targetSelector => {
    const target = document.querySelector(targetSelector), box = target.getBoundingClientRect();
    const panel = document.querySelector('[data-request-panel="quick"]');
    const sample = () => {
      const bounds = panel.getBoundingClientRect();
      return {route: BilikaraHostSubTabs.current(), transform: getComputedStyle(panel).transform,
        animations: panel.getAnimations().length, motion: document.documentElement.dataset.hostSubtabMotion || '',
        rect: [bounds.x, bounds.y, bounds.width, bounds.height], scroll: panel.scrollTop};
    };
    const initial = sample();
    const x = box.right - 24, y = box.y + box.height / 2;
    for (const [type, dx] of [['pointerdown', 0], ['pointermove', -140]])
      target.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 62,
        pointerType: 'touch', isPrimary: true, button: 0, clientX: x + dx, clientY: y}));
    const during = sample();
    target.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, pointerId: 62, pointerType: 'touch', isPrimary: true}));
    return {initial, during, route: BilikaraHostSubTabs.current()};
  }, targetSelector);
  const fixedPointer = await pointerSwipe('#workspace-request-heading');
  assert.deepEqual(fixedPointer.during, fixedPointer.initial, 'fixed pointer origin never previews or moves the content');
  assert.equal(fixedPointer.route, 'request.quick');
  await pointerSwipe('#request-quick-panel');
  assert.equal(await desktop.evaluate(() => BilikaraHostSubTabs.current()), 'request.search.shared');
});
