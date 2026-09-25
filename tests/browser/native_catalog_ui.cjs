'use strict';
const assert = require('node:assert/strict');
const {firefox,chromium,webkit} = require('playwright');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createInterface} = require('node:readline');
const {createServer} = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
// Offline UI regression against the release backend, including installed assets.
// NODE_PATH=<Playwright modules> node tests/browser/native_catalog_ui.cjs EXE OUTPUT [STATIC]
// BILIKARA_TEST_LIBAV_COMPANION is needed only for a build-tree EXE.
// BILIKARA_TEST_UI_BROWSER=chromium also exercises composited backdrop blur;
// some headless Firefox environments expose the CSS without painting the blur.
// BILIKARA_TEST_UI_CHECKS=name,name optionally narrows a local diagnostic run.
// Desktop WebKit does not emulate iOS Safari's system toolbar or safe areas.
const [executable, output, staticDirectory] = process.argv.slice(2);
const browserName=process.env.BILIKARA_TEST_UI_BROWSER || 'firefox';
assert.ok(['firefox','chromium','webkit'].includes(browserName), 'Use firefox, chromium or webkit for the offline UI checks');
assert.ok(executable && output, 'Provide the native EXE and a task-owned output directory');
const notes=path.resolve(output);
(async()=>{
 await fs.mkdir(notes,{recursive:true,mode:0o700});
 const directory=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'bilikara-ui-offline-'));
 const items=Array.from({length:221},(_,n)=>({bvid:`BV${String(n).padStart(10,'0')}`,title:`Offline song ${n}`,mid:'123',owner_name:'Fixture',duration:123,cover_url:`https://i0.hdslb.com/bfs/archive/ui-fixture-${n%4}.jpg`,url:`https://www.bilibili.com/video/BV${String(n).padStart(10,'0')}`}));
 const covers=await Promise.all([1,7,9,15].map(n=>fs.readFile(path.resolve(staticDirectory || path.join(path.dirname(executable),'static'),'pic',`cat_${n}.jpg`))));
 const calls=[];
 const fixture=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||80);
  const format=url.searchParams.get('format');
  calls.push({path:url.pathname,offset,limit,format,method:req.method});
  let data;
  if(url.pathname==='/browse' && !url.searchParams.get('tag')) {
   const query=url.searchParams.get('q')||'';
   data={items:[],tags:Array.from({length:40},(_,n)=>({tag:`Artist ${n}`,letter:'A',count:221})).filter(t=>t.tag.includes(query))};
  } else if(url.searchParams.get('keyword')==='missing') data={items:[],tags:[],offset:0,matched_count:0,has_more:false,next_offset:0};
  // Worker keeps legacy arrays/ignored offsets until the Rust client opts in.
  // "legacy" also exercises an old deployment that ignores the new parameter.
  else if(format!=='paged' || url.searchParams.get('keyword')==='legacy') data=items.slice(0,limit);
  else data={items:items.slice(offset,offset+limit),tags:[],offset,limit,matched_count:221,has_more:offset+limit<221,next_offset:Math.max(offset,Math.min(offset+limit,221)),result_kind:'songs'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
 });
 fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
 for(const [name,data] of Object.entries({
  'gatcha_uids.json':{schema_version:2,uids:['123'],profiles:{}},
  'native-library-defaults.json':{schema_version:1},
  'gatcha_cache.json':{schema_version:3,uids:{123:items},profiles:{}},
  'gatcha_favlist.json':{schema_version:2,uids:['123'],folders:[{uid:'123',media_id:'456',title:'Fixture favorites',media_count:6}],
   items:items.slice(0,6).map((item,n)=>({...item,bvid:`BV8${String(n).padStart(9,'0')}`,title:`Favorite fixture ${n}`,fav_uid:'123',fav_folder_id:'456'}))},
 }))await fs.writeFile(path.join(directory,name),JSON.stringify(data));
 await fs.writeFile(path.join(directory,'.bilikara-desktop-rust-preview'),'desktop-rust-preview-v1\n');
 const applicationEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(BILIKARA_|PYTHON|CARGO_|RUST|NODE_|LD_LIBRARY_PATH|DYLD_)/.test(key)));
 const emptyPath=path.join(directory,'empty-path');await fs.mkdir(emptyPath);
 Object.assign(applicationEnv,{PATH:emptyPath,HOME:directory,USERPROFILE:directory,
  BILIKARA_CF_API_URL:`http://127.0.0.1:${fixture.address().port}`,BILIKARA_CATALOG_SHEETS_URL:''});
 if(process.env.BILIKARA_TEST_LIBAV_COMPANION)applicationEnv.BILIKARA_LIBAV_COMPANION=process.env.BILIKARA_TEST_LIBAV_COMPANION;
 const args=['--data-dir',directory,'--headless'];
 if(staticDirectory)args.push('--static-dir',path.resolve(staticDirectory));
 const server=spawn(path.resolve(executable),args,{cwd:directory,env:applicationEnv,stdio:['pipe','pipe','pipe']});
 let err='';server.stderr.on('data',x=>err+=x);
 const lines=createInterface({input:server.stdout});let browser;
 const errors=[],measurements={},failures=[];
 try {
  const ready=JSON.parse(await Promise.race([once(lines,'line').then(x=>x[0]),once(server,'exit').then(()=>{throw Error(err)})]));
  const base=new URL(ready.bootstrapUrl).origin;
  browser=await ({firefox,chromium,webkit}[browserName]).launch({headless:true,
   ...(browserName==='firefox'?{firefoxUserPrefs:{'browser.chrome.site_icons':false,'browser.chrome.favicons':false}}:{})});
  measurements.browser=browserName;
  async function context(viewport,options={}) {
   const c=await browser.newContext({viewport,locale:'zh-CN',...options});
   await c.route('**/*',r=>{
    const url=new URL(r.request().url());
    const image=/^\/bfs\/archive\/ui-fixture-([0-3])\.jpg$/.exec(url.pathname);
    if(url.hostname==='i0.hdslb.com' && image)return r.fulfill({contentType:'image/jpeg',body:covers[Number(image[1])]});
    return url.hostname==='127.0.0.1'?r.continue():r.abort();
   });
   c.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
   return c;
  }
  const hostContext=await context({width:1280,height:900});
  await hostContext.addInitScript(()=>{
   if(window===window.top && location.hostname==='127.0.0.1')sessionStorage.setItem('bilikara.host.requestView','search');
  });
  const host=await hostContext.newPage();await host.goto(ready.bootstrapUrl);await host.waitForFunction(()=>typeof state!=='undefined'&&state.data?.remote_access);
  assert.equal(await host.evaluate(()=>state.activeHostWorkspace),'request');
  assert.equal(await host.evaluate(()=>state.requestSubview),'quick');
  await host.screenshot({path:path.join(notes,'host-startup-quick.png')});
  assert.match(await host.title(),/bilikara/i);assert.ok(await host.locator('.player-panel').count());
  const invitation=await host.evaluate(()=>state.data.remote_access.local_url);
  const remoteContext=await context({width:392,height:817});
  const remote=await remoteContext.newPage();await remote.goto(invitation);await remote.waitForFunction(()=>typeof state!=='undefined'&&state.data?.capabilities);
  assert.equal(await remote.locator('label[for="remote-identity-input"]:visible').count(),0);
  assert.equal(await remote.locator('#remote-identity-input').getAttribute('aria-label'),'用户名');
  assert.equal(await remote.locator('#remote-identity-input').getAttribute('placeholder'),'输入用户名');
  await assertBackdropPolicy(remote);
  await remote.locator('.remote-identity-card').screenshot({path:path.join(notes,'identity-local.png')});
  await remote.screenshot({path:path.join(notes,'identity-local-page.png')});
  await remote.locator('#remote-identity-input').fill('UI fixture');await remote.locator('#remote-identity-submit').click();await remote.waitForFunction(()=>state.remoteIdentity?.registered);
  assert.match(await remote.title(),/bilikara/i);
  remote.setDefaultTimeout(7000);host.setDefaultTimeout(7000);
  const selectedChecks=new Set((process.env.BILIKARA_TEST_UI_CHECKS||'').split(',').filter(Boolean));
  const check=async(name,fn)=>{if(selectedChecks.size&&!selectedChecks.has(name))return;try{await fn();measurements[name]={...measurements[name],passed:true};}catch(e){failures.push(`${name}: ${e.stack}`);}};
  async function assertBackdropPolicy(page) {
   await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
   const layers=await page.evaluate(()=>{
    const remote=document.documentElement.dataset.uiClient==='remote';

    const read=(e,pseudo)=>{const s=getComputedStyle(e,pseudo);
     const dimmed=remote && (e.matches('.remote-identity-backdrop,.song-detail-backdrop,.rating-modal-backdrop,.binding-sheet-backdrop,.playback-sheet-backdrop') || (pseudo && e.matches('.history-export-dialog')));
     return {name:e.className+(pseudo||''),background:s.backgroundColor,blur:s.backdropFilter,expected:dimmed?(document.documentElement.dataset.theme==='blue'?'rgba(2, 6, 23, 0.38)':'rgba(29, 26, 24, 0.24)'):'rgba(0, 0, 0, 0)',expectedBlur:'none'};
    };
    const overlays=[...document.querySelectorAll('.selection-modal-backdrop,.rating-modal-backdrop,.binding-sheet-backdrop,.remote-identity-backdrop,.song-detail-backdrop,.playback-sheet-backdrop,.stage-control-backdrop,.audio-variant-backdrop,.song-detail-view')].filter(e=>e.getClientRects().length).map(e=>read(e));
    return overlays.concat([...document.querySelectorAll('.history-export-dialog[open],.volume-adjust-popover[open]')].map(e=>read(e,'::backdrop')));
   });
   for(const layer of layers){assert.equal(layer.background,layer.expected,`${layer.name}: client-specific backdrop`);assert.equal(layer.blur,layer.expectedBlur);}
  }
  async function closeControl(page, card, button, remoteControl=false) {
   await page.mouse.move(0,0);
   await settled(page);
   await assertBackdropPolicy(page);
   const read=()=>button.evaluate(e=>{
    const s=getComputedStyle(e),b=e.getBoundingClientRect();
    return {background:s.backgroundColor,color:s.color,transform:s.transform,opacity:s.opacity,
     left:b.left,top:b.top,right:b.right,bottom:b.bottom};
   });
   const surface=await card.evaluate(e=>{const s=getComputedStyle(e);return {bg:s.backgroundColor,radius:s.borderRadius,blur:s.backdropFilter,shadow:s.boxShadow};});
   assert.match(surface.bg,/, 0\.9\)$/,'Every dialog uses the same 90% surface');
   assert.equal(surface.radius,'18px');assert.equal(surface.blur,'blur(12px)');assert.notEqual(surface.shadow,'none');
   const rest=await read(), bounds=await card.boundingBox();
   assert.match(rest.background,/^rgb\(/,'Close background must be opaque');
   assert.equal(rest.opacity,'1');assert.equal(rest.transform,'none');
   const luminance=color=>{
    const rgb=color.match(/[\d.]+/g).slice(0,3).map(v=>{v=Number(v)/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;});
    return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
   };
   const bg=luminance(rest.background),fg=luminance(rest.color);
   assert.ok((Math.max(bg,fg)+0.05)/(Math.min(bg,fg)+0.05)>=4.5,'The X is legible without hovering');
   assert.ok(rest.left>=bounds.x && rest.top>=bounds.y && rest.right<=bounds.x+bounds.width && rest.bottom<=bounds.y+bounds.height,'Close button stays inside its card');
   assert.ok(rest.top-bounds.y<=32 && bounds.x+bounds.width-rest.right<=32,`Close button is in the top right corner: ${JSON.stringify({rest,bounds})}`);
   await button.hover();await settled(page);
   const hover=await read();assert.equal(hover.transform,'none');
   if(remoteControl)assert.deepEqual(hover,rest,'Remote has no close hover effect');
   await page.mouse.down();
   try {await settled(page);assert.equal((await read()).transform,'none','Pressing does not shrink the close button');}
   finally {
    // Observe :active without dismissing/submitting the synthetic dialog.
    await button.evaluate(e=>e.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();},{capture:true,once:true}));
    await page.mouse.up();await page.mouse.move(0,0);
   }
   // Exercise genuine keyboard modality, including Remote's focus policy.
   await page.keyboard.press('Tab');await button.focus();
   assert.equal(await button.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
   await button.blur();await settled(page);
  }
  await check('publicIdentityCopy',async()=>{
   const publicContext=await context({width:392,height:817});
   const publicRemote=await publicContext.newPage();
   // Obtain a local read role first; the LAN invitation redirect deliberately
   // cleans its URL. Then render the public entry with dummy room credentials.
   await publicRemote.goto(invitation);
   const joinPreview=new URL(base+'/remote.html');
   joinPreview.hash=new URLSearchParams({room:'A'.repeat(27),join:'B'.repeat(43)}).toString();
   await publicRemote.goto(joinPreview.href);
   await publicRemote.locator('#internet-join-identity').waitFor();
   assert.equal(await publicRemote.locator('label[for="internet-join-identity"]:visible').count(),0);
   assert.equal(await publicRemote.locator('#internet-join-identity').getAttribute('aria-label'),'用户名');
   assert.equal(await publicRemote.locator('#internet-join-identity').getAttribute('placeholder'),'输入用户名');
   assert.equal(await publicRemote.locator('label[for="internet-join-password"]:visible').count(),0);
   assert.equal(await publicRemote.locator('#internet-join-password').getAttribute('aria-label'),'房间密码');
   assert.equal(await publicRemote.locator('#internet-join-password').getAttribute('placeholder'),'输入房间密码');
   await assertBackdropPolicy(publicRemote);
   await publicRemote.locator('.internet-remote-join-card').screenshot({path:path.join(notes,'identity-internet-local-preview.png')});
   await publicContext.close();
  });
  await check('privateLanSharing',async()=>{
   assert.equal((await fetch(base+'/api/remote-access')).status,403);
   const response=await remote.request.get(base+'/api/remote-access');assert.equal(response.status(),200);
   const data=(await response.json()).data;assert.equal(new URL(data.local_url).search,'');assert.equal(new URL(data.local_url).pathname,'/remote');
   const publicUrl='https://rtc.kevinx96.icu/remote.html#room=QUIET-ZONE-FIXTURE&join='+'A'.repeat(43);
   const publicQrResponse=await host.request.post(base+'/api/internet-remote/qr',{data:{url:publicUrl}});
   assert.equal(publicQrResponse.status(),200);
   const publicQr=(await publicQrResponse.json()).data.image;
   for(const image of [data.qr_image,publicQr]) {
    const svg=Buffer.from(image.split(',')[1],'base64').toString();
    const size=Number(/viewBox="0 0 (\d+) /.exec(svg)[1]);
    const rects=[...svg.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)H/g)].map(m=>m.slice(1).map(Number));
    assert.ok(rects.length>0);
    const border=[Math.min(...rects.map(r=>r[0])),Math.min(...rects.map(r=>r[1])),
     size-Math.max(...rects.map(r=>r[0]+r[2])),size-Math.max(...rects.map(r=>r[1]+r[3]))];
    assert.deepEqual(border,[0,0,0,0],'Host access QR images use only the outer CSS frame, matching the shipped Python desktop');
   }

   assert.equal((await remote.request.get(base+'/api/remote-access',{headers:{Origin:'https://foreign.invalid'}})).status(),403);
   assert.equal(await remote.evaluate(()=>state.data.remote_access),undefined);
   await remote.locator('#remote-menu-toggle').click();await remote.locator('#remote-qr-toggle').click();
   await remote.waitForFunction(()=>document.querySelector('#remote-popover-qr-placeholder svg'));
   const menuSurface=await remote.locator('#remote-menu-panel').evaluate(e=>{
    const s=getComputedStyle(e), content=getComputedStyle(e.querySelector('.remote-share-card'));
    return {background:s.backgroundColor,radius:s.borderRadius,blur:s.backdropFilter,contentBackground:content.backgroundColor,contentShadow:content.boxShadow};
   });
   assert.match(menuSurface.background,/, 0\.9\)$/);assert.equal(menuSurface.radius,'18px');assert.equal(menuSurface.blur,'blur(12px)');
   assert.equal(menuSurface.contentBackground,'rgba(0, 0, 0, 0)');assert.equal(menuSurface.contentShadow,'none','An inline QR section must not add a second floating surface');
   const link=remote.locator('#remote-popover-url-link');assert.equal(await link.textContent(),new URL(await link.getAttribute('href')).origin+'/remote');
   await remote.locator('#remote-menu-panel').screenshot({path:path.join(notes,'remote-access-link.png')});
   await remote.locator('#remote-menu-toggle').click();
   assert.equal(await host.locator('#remote-popover-url-link').textContent(),new URL(await host.locator('#remote-popover-url-link').getAttribute('href')).origin+'/remote');
   assert.equal(await host.locator('#internet-remote-local-address-detail').count(),0);
   await host.waitForFunction(()=>['remote-popover-qr-image','player-fullscreen-remote-qr-image'].every(id=>document.getElementById(id)?.naturalWidth>0));
   assert.equal(new URL(await host.locator('#remote-popover-url-link').getAttribute('href')).search,'');
   await host.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedInvitation=text;}}}));
   await host.locator('#remote-mini-trigger').click();
   await host.locator('#remote-popover-copy-link').click();
   await host.waitForFunction(()=>Boolean(window.copiedInvitation));
   const copied=await host.evaluate(()=>window.copiedInvitation);
   assert.equal(new URL(copied).pathname,'/remote');assert.equal(new URL(copied).search,'');
   const freshContext=await context({width:392,height:817});
   await freshContext.route(new URL(copied).origin+'/**',route=>route.continue());
   const fresh=await freshContext.newPage();
   assert.equal((await fresh.request.get(new URL('/remote',copied).href)).status(),200,'A fresh device can open /remote directly');
   await fresh.goto(copied);await fresh.waitForURL(new URL('/remote',copied).href);
   assert.ok((await freshContext.cookies()).some(cookie=>cookie.httpOnly));
   assert.equal((await fresh.request.get(new URL('/remote',copied).href)).status(),200,'The device can reuse /remote without another entry document');
   await fresh.locator('#remote-identity-input').fill('Direct LAN entry');
   await fresh.locator('#remote-identity-submit').click();
   await fresh.waitForFunction(()=>state.remoteIdentity?.registered);
   const beforeCookie=(await freshContext.cookies()).find(cookie=>cookie.name==='bilikara_native').value;
   await fresh.reload();await fresh.waitForFunction(()=>state.remoteIdentity?.registered);
   assert.equal((await freshContext.cookies()).find(cookie=>cookie.name==='bilikara_native').value,beforeCookie);
   assert.equal((await fresh.request.post(new URL('/api/session-users/add',copied).href,{data:{name:'Forbidden'}})).status(),403);
   await freshContext.close();
   await host.locator('#remote-mini-popover').screenshot({path:path.join(notes,'host-access-link.png')});
   await host.locator('#remote-mini-popover-close').click();

  });
  await check('localEntryFailureStates',async()=>{
   let mode='ok';
   const pattern='**/api/state';
   const handler=async route=>{
    if(mode==='ok')return route.continue();
    if(mode==='network')return route.abort('connectionrefused');
    if(mode==='http')return route.fulfill({status:503,contentType:'text/html',body:'Unavailable fixture'});
    if(mode==='invalid')return route.fulfill({contentType:'application/json',body:'{"ok":true,"data":null}'});
    const response=await route.fetch();const body=await response.json();
    body.data.remote_access={local_url:base+'/remote',preferred_url:base+'/remote',lan_urls:[]};
    if(mode==='switched') {
     const url=`http://192.168.50.8:${new URL(base).port}/remote`;
     body.data.remote_access={...body.data.remote_access,preferred_url:url,lan_urls:[url],
      qr_image:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><text y="20">Changed network fixture</text></svg>').toString('base64')};
    }
    return route.fulfill({response,json:body});
   };
   await hostContext.route(pattern,handler);
   const unavailable=async()=>{
    for(const id of ['remote-url-link','remote-popover-url-link']) {
     assert.equal(await host.locator('#'+id).getAttribute('href'),null);
     assert.equal(await host.locator('#'+id).getAttribute('aria-disabled'),'true');
    }
    for(const id of ['copy-remote-url-button','remote-popover-copy-link'])assert.equal(await host.locator('#'+id).isDisabled(),true);
    for(const id of ['remote-qr-image','remote-popover-qr-image','remote-mini-qr-image','player-fullscreen-remote-qr-image']) {
     assert.equal(await host.locator('#'+id).getAttribute('src'),null);
     assert.equal(await host.locator('#'+id).evaluate(e=>e.classList.contains('hidden')),true);
    }
   };
   try {
    await host.locator('#remote-mini-trigger').click();
    await host.evaluate(()=>{
     window.previousQrLoad=document.querySelector('#remote-popover-qr-image').onload;
     Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>{window.finishCopy=resolve;})}});
    });
    await host.locator('#remote-popover-copy-link').click();
    await host.waitForFunction(()=>Boolean(window.finishCopy));
    mode='http';await host.evaluate(()=>fetchState().catch(()=>{}));
    await host.evaluate(()=>{window.previousQrLoad?.();window.finishCopy();});
    await host.waitForFunction(()=>!document.querySelector('#remote-popover-copy-link').hasAttribute('aria-busy'));
    await unavailable();
    mode='ok';await host.evaluate(()=>fetchState());
    for(const failure of ['http','network','invalid','no-lan']) {
     mode=failure;await host.evaluate(()=>fetchState().catch(()=>{}));
     await unavailable();
     const text=await host.locator('#remote-popover-url-hint').textContent();
     assert.match(text,({http:/HTTP 503/,network:/无法连接/,invalid:/无效/, 'no-lan':/局域网/})[failure]);
     if(failure==='http')await host.locator('#remote-mini-popover').screenshot({path:path.join(notes,'local-entry-http-error.png')});
     mode='ok'; // Recovery must come from the real timer, without a click/fetch call.
     await host.waitForFunction(()=>document.querySelector('#remote-popover-qr-image').naturalWidth>0&&!document.querySelector('#remote-popover-qr-image').classList.contains('hidden'));
     assert.equal(await host.locator('#remote-popover-copy-link').isEnabled(),true);
    }
    await host.evaluate(()=>{
     const request=++state.remoteAccessRequestSequence;
     updateRemoteAccessFailure({kind:'timeout'},request);
     updateRemoteAccessFailure({kind:'http',status:403},request-1);
    });
    await unavailable();assert.match(await host.locator('#remote-popover-url-hint').textContent(),/超时/);
    await host.evaluate(()=>fetchState());
    mode='switched';
    await host.waitForFunction(()=>document.querySelector('#remote-popover-url-link').href.includes('192.168.50.8'));
    assert.match(await host.locator('#remote-popover-qr-image').getAttribute('src'),/^data:image\/svg\+xml;base64,/);
    assert.equal(await host.locator('#remote-popover-copy-link').isEnabled(),true);
    mode='no-lan';
    await host.waitForFunction(()=>!document.querySelector('#remote-popover-url-link').hasAttribute('href'));
    await unavailable();
    mode='ok';
    await host.waitForFunction(()=>document.querySelector('#remote-popover-copy-link').disabled===false);
   } finally {await hostContext.unroute(pattern,handler);await host.locator('#remote-mini-popover-close').click();}
  });
  await check('publicRoomFailureDetails',async()=>{
   const pattern='https://rtc.kevinx96.icu/v1/rooms';let requests=0;
   const handler=route=>{requests++;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"offline_fixture"}'});};
   await hostContext.route(pattern,handler);
   try {
    await host.locator('#remote-mini-trigger').click();
    if(!await host.locator('#internet-remote-restart').isVisible())await host.locator('#internet-remote-disclosure').click();
    await host.locator('#internet-remote-restart').click();
    await host.waitForFunction(()=>document.querySelector('#internet-remote-status').textContent.includes('HTTP 503'));
    assert.equal(requests,1);
    assert.equal(await host.locator('#internet-remote-copy-link').isDisabled(),true);
    assert.equal(await host.locator('#internet-remote-url').getAttribute('href'),null);
    assert.equal(await host.locator('#internet-remote-qr').getAttribute('src'),null);
    const status=await host.locator('#internet-remote-status').evaluate(e=>({height:e.getBoundingClientRect().height,clip:getComputedStyle(e).clip}));
    assert.ok(status.height>10);assert.equal(status.clip,'auto');
    await host.locator('#remote-mini-popover').screenshot({path:path.join(notes,'public-room-http-error.png')});
   } finally {await hostContext.unroute(pattern,handler);await host.locator('#remote-mini-popover-close').click();}
  });
  const settled=async page=>page.evaluate(async()=>{
   // Sheet openers schedule their entry classes on the next animation frame.
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
   // WebKit may resolve finished before applying the final layout frame.
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  await check('windowsCaptionGeometry',async()=>{
   const c=await context({width:1280,height:900},{hasTouch:true,deviceScaleFactor:2,storageState:await hostContext.storageState()});
   try {
    const page=await c.newPage();await page.goto(base);await page.waitForFunction(()=>typeof state!=='undefined'&&state.data?.capabilities);
    await page.evaluate(()=>{
     document.body.dataset.tauriPlatform='windows';
     document.querySelector('#window-controls').hidden=false;
    });
    await page.locator('#window-close').hover();await settled(page);
    assert.equal(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches),true);
    const geometry=await page.locator('#window-controls').evaluate(e=>({row:e.getBoundingClientRect().toJSON(),buttons:[...e.querySelectorAll('button')].map(b=>b.getBoundingClientRect().toJSON())}));
    assert.equal(geometry.row.height,32);
    for(const button of geometry.buttons){assert.equal(button.width,46);assert.equal(button.height,32);assert.equal(button.bottom,geometry.row.bottom);}
    measurements.windowsCaptionGeometry=geometry;
    await page.screenshot({path:path.join(notes,'windows-caption-fixed.png'),clip:{x:830,y:0,width:450,height:100}});
    // Reproduce the inherited touch minimum for a visual comparison only.
    const old=await page.addStyleTag({content:'body[data-tauri-platform="windows"] .window-control-button { min-height:44px;max-height:none; }'});
    await page.screenshot({path:path.join(notes,'windows-caption-before.png'),clip:{x:830,y:0,width:450,height:100}});
    await old.evaluate(e=>e.remove());
    // Return to mouse metrics; button geometry must not depend on touch support.
    await page.locator('#cache-settings-toggle').click();await settled(page);
    assert.equal(await page.locator('#cache-settings-toggle').getAttribute('aria-expanded'),'true');
   } finally {await c.close();}
  });
  await check('nativePreferencesAndEntryPoints',async()=>{
   const policy=await host.evaluate(()=>state.data.cache_policy);
   assert.equal(policy.video_quality,'1080P 高帧率');assert.equal(policy.audio_hires,true);assert.equal(policy.reset_offset_on_next,true);
   await host.locator('#work-rail-settings').click();
   assert.equal(await host.locator('[data-android-layout-mode]').count(),0);
   assert.equal(await host.locator('#diagnostic-package-button').isVisible(),true);
   assert.equal(await host.locator('#android-orientation-settings').isVisible(),false);
  });
  await check('volumeOutwardGesture',async()=>{
   if(await host.locator('#stage-controls-toggle').isVisible()&&await host.locator('#stage-controls-toggle').getAttribute('aria-expanded')!=='true')await host.locator('#stage-controls-toggle').click();
   const slider=host.locator('#volume-slider');
   const editor=host.locator('.volume-adjust-popover');
   for(const dual of [false,true]) {
    // Only the OS display composition is a fixture. DOM controls and volume
    // writes still use this page's real handlers and authenticated native Host.
    await host.evaluate(dual=>{
     state.presentationSession={...state.presentationSession,generation:1,mode:'localDualScreen',phase:'active',playbackAuthority:'host',mediaRendererOwner:'host'};
     applyPresentationCompositionDom(1,dual?'stageOnly':'combined');
    },dual);
    await settled(host);
    await slider.hover();
    await slider.press('Home');await host.waitForFunction(()=>state.data.player_settings.volume_percent===0);
    await slider.press('ArrowRight');
    await host.waitForFunction(()=>state.data.player_settings.volume_percent===1);
    let start=await slider.boundingBox();
    await host.mouse.move(start.x+8,start.y+start.height/2);await host.mouse.down();
    await host.mouse.move(start.x+start.width+30,start.y+start.height/2,{steps:8});await host.mouse.up();
    await host.waitForFunction(()=>state.data.player_settings.volume_percent===100);
    assert.equal(await editor.evaluate(e=>e.open),false,'The first drag reaching 100% does not arm boost');
    await settled(host);await slider.hover();
    const box=await slider.boundingBox(),x=box.x+box.width-8,y=box.y+box.height/2;
    await host.mouse.move(x,y);await host.mouse.down();await host.mouse.move(x+35,y,{steps:8});
    // No release in the control window is needed to enter boost editing.
    try {assert.equal(await editor.evaluate(e=>e.open),true,`Outward drag opens before release (dual=${dual})`);} finally {await host.mouse.up();}
    await editor.locator('input').fill('250');await editor.locator('input').press('Enter');
    await host.waitForFunction(()=>state.data.player_settings.volume_percent===250);
    assert.equal(await host.locator('#volume-value').textContent(),'250%');
    await editor.locator('[data-volume-reset]').click();await host.waitForFunction(()=>state.data.player_settings.volume_percent===100);
    await editor.locator('[data-volume-close]').click();await host.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
    await host.locator('#volume-value').click();assert.equal(await editor.evaluate(e=>e.open),true);
    const backdrop=await editor.evaluate(e=>getComputedStyle(e,'::backdrop').backgroundColor);
    assert.equal(backdrop,'rgba(0, 0, 0, 0)','Element editor does not dim the page');
    assert.equal(await host.locator('#stage-control-backdrop').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)','Underlying element-owned controls do not dim the page either');
    if(!dual){await settled(host);await host.screenshot({path:path.join(notes,'host-volume-element-scope.png')});}

    await editor.locator('[data-volume-close]').click();await host.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
   }
   if(await host.locator('#stage-controls-toggle').getAttribute('aria-expanded')==='true')await host.keyboard.press('Escape');
   await host.evaluate(()=>{state.presentationSession.phase='inactive';applyPresentationCompositionDom(1,'combined');});
   await settled(host);
  });
  await check('hostDialogMotion',async()=>{
   await host.locator('#work-rail-history').click();
   // The export entry is present even when the isolated history is empty.
   await host.locator('#history-export-button').click();
   const confirm=host.locator('#confirm-popover');await confirm.waitFor({state:'visible'});
   assert.equal(await confirm.evaluate(e=>getComputedStyle(e).animationName),'scale-from-center-card');
   await settled(host);
   await host.screenshot({path:path.join(notes,'host-export-dialog.png')});
   const info=host.locator('#confirm-source-field .cache-advanced-info');
   const tip=host.locator('#confirm-source-info');
   const opened=await info.evaluate(e=>{e.querySelector('button').click();const t=e.querySelector('[role=tooltip]');return {open:t.matches(':popover-open'),animations:t.getAnimations().length};});
   assert.equal(opened.open,true);assert.ok(opened.animations>0);
   await settled(host);
   const closed=await info.evaluate(e=>{e.querySelector('button').click();const t=e.querySelector('[role=tooltip]');return {open:t.matches(':popover-open'),animations:t.getAnimations().length};});
   assert.equal(closed.open,true,'Bubble remains painted during its exit');assert.ok(closed.animations>0);
   await host.waitForFunction(()=>!document.querySelector('#confirm-source-info').matches(':popover-open'));
   await info.evaluate(e=>{e.querySelector('button').click();e.querySelector('button').click();e.querySelector('button').click();});
   await settled(host);assert.equal(await tip.evaluate(e=>e.matches(':popover-open')),true,'A stale close cannot hide a reopened bubble');
   const close=await host.locator('#confirm-cancel').evaluate(e=>{e.click();const p=document.querySelector('#confirm-popover');return {closing:p.classList.contains('closing'),hidden:p.classList.contains('hidden'),animation:getComputedStyle(p).animationName};});
   assert.deepEqual(close,{closing:true,hidden:false,animation:'scale-to-center-card'});
   await confirm.waitFor({state:'hidden'});
   await host.locator('#work-rail-settings').click();
   await host.locator('#data-reset-button').click();await confirm.waitFor({state:'visible'});
   assert.equal(await confirm.evaluate(e=>getComputedStyle(e).animationName),'scale-from-center-card');
   await settled(host);
   const bounds=await confirm.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=1280,'Animated confirmation stays inside the window');
   await host.screenshot({path:path.join(notes,'host-cleanup-dialog.png')});
   await host.locator('#confirm-cancel').click();await confirm.waitFor({state:'hidden'});
   await host.emulateMedia({reducedMotion:'reduce'});
   await host.locator('#data-reset-button').click();
   assert.equal(await confirm.evaluate(e=>getComputedStyle(e).animationDuration),'0.001s');
   await host.locator('#confirm-cancel').click();await confirm.waitFor({state:'hidden'});
   await host.emulateMedia({reducedMotion:'no-preference'});
  });
  const primary=async()=>{const back=remote.locator('#remote-request-secondary-back:not(.hidden)');if(await back.isVisible())await back.click();};
  const assertPadding=async()=>{
   const p=await remote.locator('.request-panel').evaluate(e=>{
    const style=getComputedStyle(e);
    const pager=Array.from(e.querySelectorAll('.result-pager')).find(n=>n.getClientRects().length);
    return {bottom:style.paddingBottom,left:style.paddingLeft,right:style.paddingRight,
     footer:!!pager,above:pager?pager.getBoundingClientRect().top-pager.previousElementSibling.getBoundingClientRect().bottom:null,
     below:pager?e.getBoundingClientRect().bottom-parseFloat(style.borderBottomWidth)-pager.getBoundingClientRect().bottom:null};
   });
   assert.equal(p.left,p.right);
   if(p.footer) {
    assert.ok(Math.abs(p.above-p.below)<=1,JSON.stringify(p));
    measurements.footerSpacing={above:p.above,below:p.below};
   } else assert.equal(p.bottom,p.left);
  };
  const noMessages=async()=>{assert.equal(await remote.locator('.request-panel .message:visible').count(),0);};
  async function jump(selector,page) {
   const pager=remote.locator(selector).locator('..').locator('+ .result-pager');
   await pager.locator('input').fill(String(page));await pager.locator('input').press('Enter');
   await remote.waitForFunction(({selector,page})=>document.querySelector(selector).parentElement.nextElementSibling.dataset.page===String(page),{selector,page},{timeout:5000});
   // A page-number change can precede its entry animation. Finish that motion
   // before a subsequent drag checks finger tracking, especially under CI load.
   await remote.locator(selector).evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished.catch(()=>{}))));
  }
  await check('sharedAndLocalSearch',async()=>{
   await remote.locator('#remote-request-search-tab').click();
   await remote.locator('#lark-search-query').fill('Offline');await remote.locator('#lark-search-button').click();
   await remote.waitForFunction(()=>canonicalBilikaraSearch.items.length===80 && !canonicalBilikaraSearch.loading);
   assert.match(await remote.locator('#lark-search-results').locator('..').locator('+ .result-pager').textContent(),/221/);
   const backwardBatch=remote.waitForResponse(r=>r.url().includes('/api/catalog/search?') && new URL(r.url()).searchParams.get('offset')==='156');
   await jump('#lark-search-results',37);
   await (await backwardBatch).finished();await settled(remote);
   assert.equal(await remote.locator('#lark-search-results .search-result-item').count(),5);
   assert.match(await remote.locator('#lark-search-results').textContent(),/Offline song 216/);
   const reverseReads=calls.length;
   for(const page of [36,35,34,33]) {
    await jump('#lark-search-results',page);
    assert.match(await remote.locator('#lark-search-results').textContent(),new RegExp(`Offline song ${(page-1)*6}`));
   }
   assert.equal(calls.length,reverseReads,'Reverse navigation consumes prefetched pages without additional provider reads');
   await jump('#lark-search-results',37);
   const readCount=calls.length;await jump('#lark-search-results',1);await jump('#lark-search-results',37);assert.equal(calls.length,readCount);
   await remote.locator('[data-remote-search-mode="local"]').click();await assertPadding();
   await remote.locator('#search-query').fill('Offline');await remote.locator('#search-button').click();
   await remote.waitForFunction(()=>localLibrarySearch.data?.matched_count===221);
   await jump('#search-results',37);assert.equal(await remote.locator('#search-results .search-result-item').count(),5);
   await noMessages();await assertPadding();
   await remote.locator('[data-remote-search-mode="shared"]').click();await assertPadding();
   assert.equal(await remote.locator('#lark-search-query').inputValue(),'Offline');
   measurements.sharedAndLocalSearch={total:221,lastPage:37,localItems:5,repeatPageReads:0};
   await settled(remote);await remote.screenshot({path:path.join(notes,'search-mobile.png'),fullPage:true});
  });
  await check('fingerTracking',async()=>{
   await primary();await remote.locator('#remote-request-search-tab').click();await jump('#lark-search-results',1);
   const grid=remote.locator('#lark-search-results');await grid.scrollIntoViewIfNeeded();const box=await grid.boundingBox();
   const x=box.x+box.width*.75,y=Math.max(60,box.y+40);await remote.mouse.move(x,y);await remote.mouse.down();await remote.mouse.move(x-90,y+2,{steps:5});
   const transform=await grid.evaluate(e=>getComputedStyle(e).transform);assert.notEqual(transform,'none');assert.ok(Number(transform.split(',')[4])<-60,transform);
   const viewport=grid.locator('..');
   assert.equal(await viewport.evaluate(e=>getComputedStyle(e).overflowX),'hidden');
   const preview=viewport.locator('.result-page-preview');
   assert.match(await preview.textContent(),/Offline song 6/);
   const currentBox=await grid.boundingBox(),previewBox=await preview.boundingBox();
   const pageGap=previewBox.x-currentBox.x-currentBox.width;
   assert.ok(pageGap>=31 && pageGap<=33,`Page gap ${pageGap}`);
   measurements.fingerTracking={pageGap};
   assert.ok(previewBox.x < (await viewport.boundingBox()).x + (await viewport.boundingBox()).width);
   const pager=viewport.locator('+ .result-pager');
   await remote.waitForFunction(()=>getComputedStyle(document.querySelector('#lark-search-results').parentElement.nextElementSibling.querySelector('.result-pager-dots')).opacity==='1');
   assert.equal(await pager.locator('.result-pager-editor').evaluate(e=>getComputedStyle(e).opacity),'0');
   assert.equal(await viewport.evaluate(e=>{
    const box=e.getBoundingClientRect();
    return document.elementFromPoint(Math.max(0,box.left-3),Math.max(1,box.top+30))?.closest('.search-result-item') == null;
   }),true,'Outgoing cards are clipped at the result viewport');
   await remote.screenshot({path:path.join(notes,'swipe-adjacent-page.png'),fullPage:true});
   const beforeTurnY=await remote.evaluate(()=>scrollY);
   await remote.mouse.up();await remote.waitForFunction(()=>document.querySelector('#lark-search-results').parentElement.nextElementSibling.dataset.page==='2');
   assert.ok(Math.abs(await remote.evaluate(()=>scrollY)-beforeTurnY)<2,'Swipe preserves document scroll position');
   assert.equal(await remote.locator('.song-detail-view:not(.hidden)').count(),0);
   await remote.waitForFunction(()=>getComputedStyle(document.querySelector('#lark-search-results').parentElement.nextElementSibling.querySelector('.result-pager-dots')).opacity==='0');
   assert.equal(await pager.locator('.result-pager-editor').evaluate(e=>getComputedStyle(e).opacity),'1');
   await remote.screenshot({path:path.join(notes,'pager-at-rest.png'),fullPage:true});
   // A source change during the remaining swipe animation must cancel its
   // navigation, rather than paging the next search when that animation ends.
   await grid.scrollIntoViewIfNeeded();const nextBox=await grid.boundingBox();
   const nextX=nextBox.x+nextBox.width*.75,nextY=Math.max(60,nextBox.y+40);
   await remote.mouse.move(nextX,nextY);await remote.mouse.down();await remote.mouse.move(nextX-90,nextY,{steps:4});
   await remote.mouse.up();
   await remote.locator('[data-remote-search-mode="local"]').evaluate(e=>e.click());
   await settled(remote);
   assert.equal(await viewport.locator('.result-page-preview').count(),0);
   assert.equal(await grid.evaluate(e=>e.style.transform),'');
   await remote.locator('[data-remote-search-mode="shared"]').click();
   assert.equal(await grid.locator('..').locator('+ .result-pager').getAttribute('data-page'),'2');
  });
  await check('nameArtistPaginationAndSpacing',async()=>{
   for(const kind of ['name','artist']) {
    await primary();await remote.locator('#remote-request-discover-tab').click();await remote.locator(`[data-remote-discover-mode="${kind}"]`).click();
    const panel=remote.locator(`#remote-discover-${kind}-panel`);
    await assertPadding();await noMessages();assert.equal(await panel.locator('.browse-search-form:visible').count(),0);
    assert.match(await panel.textContent(),/请选择.+首字母/);
    assert.ok(await panel.locator('.browse-search-bar').evaluate(e=>e.getBoundingClientRect().height<32));
    await remote.locator('.request-panel').screenshot({path:path.join(notes,kind+'-letters.png')});
    await panel.locator('[data-letter="A"]').click();await panel.locator('[data-tag="Artist 0"]').waitFor();
    assert.equal(await panel.locator('[data-tag]').count(),12);
    await remote.locator('.request-panel').screenshot({path:path.join(notes,kind+'-six-rows.png')});
    await remote.setViewportSize({width:1024,height:900});
    await remote.waitForFunction(kind=>document.querySelectorAll(`#remote-discover-${kind}-panel [data-tag]`).length===24,kind);
    await remote.locator('.request-panel').screenshot({path:path.join(notes,kind+'-six-rows-wide.png')});
    await remote.setViewportSize({width:392,height:817});
    await remote.waitForFunction(kind=>document.querySelectorAll(`#remote-discover-${kind}-panel [data-tag]`).length===12,kind);
    const tagsSelector=`#remote-discover-${kind}-panel [data-d1-browse-tags]`;
    await jump(tagsSelector,4);assert.equal(await panel.locator('[data-tag]').count(),4);
    await jump(tagsSelector,1);await panel.locator('.browse-search-form button[type=submit]').click();
    await panel.locator('.browse-search-form input').fill('Artist 39');await panel.locator('.browse-search-form').evaluate(e=>e.requestSubmit());
    await panel.locator('[data-tag="Artist 39"]').waitFor();assert.equal(await panel.locator('[data-tag]').count(),1);
    await panel.locator('.browse-search-cancel').click();
    await remote.waitForFunction(kind=>document.querySelector(`#remote-discover-${kind}-panel .browse-search-form`).getAttribute('aria-busy')==='false',kind);
    await settled(remote);
    assert.ok(!(await panel.locator('.browse-search-form').evaluate(e=>getComputedStyle(e).boxShadow)).includes('inset'));
    await assertPadding();await noMessages();
   }
   await settled(remote);await remote.screenshot({path:path.join(notes,'name-mobile.png')});
  });
  await check('selectedGroupSongWindows',async()=>{
   for(const kind of ['name','artist']) {
    await primary();await remote.locator('#remote-request-discover-tab').click();
    await remote.locator(`[data-remote-discover-mode="${kind}"]`).click();
    const panel=remote.locator(`#remote-discover-${kind}-panel`);
    const back=panel.locator('[data-d1-browse-back]');
    if(await back.isVisible())await back.click();
    await panel.locator('[data-letter="A"]').click();
    await panel.locator('[data-tag="Artist 0"]').click();
    const selector=`#remote-discover-${kind}-panel [data-d1-browse-results]`;
    const results=remote.locator(selector),pager=results.locator('..').locator('+ .result-pager');
    await results.locator('.search-result-item').first().waitFor();
    assert.match(await pager.locator('.result-pager-items-total').textContent(),/221/);
    await jump(selector,37);
    assert.equal(await results.locator('.search-result-item').count(),5);
    assert.match(await results.textContent(),/Offline song 216/);
    await panel.locator('[data-d1-browse-back]').click();
   }
  });
  await check('rootAndEmptyViews',async()=>{
   await primary();await remote.locator('#remote-request-discover-tab').click();
   await remote.locator('[data-remote-discover-mode="categories"]').click();
   assert.ok(await remote.locator('[data-category-browser-grid] [data-category-id]:visible').count());
   await assertPadding();await noMessages();
   assert.equal(await remote.locator('#remote-discover-categories-panel .browse-search-form:visible').count(),0);
   await remote.locator('[data-category-browser-grid] [data-category-id]').first().click();
   await remote.waitForFunction(()=>state.categoryBrowseMatchedCount===221 && !state.categoryBrowseLoading);
   assert.match(await remote.locator('#remote-discover-categories-panel .result-pager-items-total').textContent(),/221/);
   const categoryResults='#remote-discover-categories-panel [data-category-browse-results]';
   const preloaded=remote.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/d1/category-browse' && url.searchParams.get('offset')==='18';
   });
   await jump(categoryResults,2);
   await preloaded;
   await settled(remote);
   assert.equal(await remote.locator(categoryResults).locator('..').locator('+ .result-pager').getAttribute('data-page'),'2');
   const prefetchReads=calls.filter(call=>call.path==='/browse-category' && call.offset===18).length;
   assert.equal(prefetchReads,1,'The next window is fetched before the initial batch is exhausted');
   await jump(categoryResults,4);
   assert.match(await remote.locator(categoryResults+' .search-result-title').first().textContent(),/Offline song 18/);
   assert.equal(calls.filter(call=>call.path==='/browse-category' && call.offset===18).length,prefetchReads);

   await primary();await remote.locator('#remote-request-search-tab').click();
   await remote.locator('[data-remote-search-mode="shared"]').click();
   await remote.locator('#lark-search-query').fill('missing');await remote.locator('#lark-search-button').click();
   await remote.waitForFunction(()=>!canonicalBilikaraSearch.loading && canonicalBilikaraSearch.data?.matched_count===0);
   assert.equal(await remote.locator('#lark-search-results .search-empty:visible').count(),1);
   assert.equal(await remote.locator('#lark-search-results').locator('..').locator('+ .result-pager:visible').count(),0);
   await assertPadding();await noMessages();
   await remote.setViewportSize({width:1024,height:900});
   await primary();await remote.locator('#remote-request-discover-tab').click();
   await remote.locator('[data-remote-discover-mode="name"]').click();
   const back=remote.locator('#remote-discover-name-panel [data-d1-browse-back]');
   if(await back.isVisible())await back.click();
   await settled(remote);await assertPadding();await noMessages();
   await remote.screenshot({path:path.join(notes,'name-root-wide.png')});
   await remote.setViewportSize({width:392,height:817});
  });
  await check('pagerButtonsAndPosition',async()=>{
   await primary();await remote.locator('#remote-request-search-tab').click();
   await remote.locator('[data-remote-search-mode="shared"]').click();
   await remote.locator('#lark-search-query').fill('Offline');await remote.locator('#lark-search-button').click();
   await remote.waitForFunction(()=>!canonicalBilikaraSearch.loading);
   const pager=remote.locator('#lark-search-results').locator('..').locator('+ .result-pager');
   assert.equal(await pager.locator('[data-page-action="first"]').isDisabled(),true);
   for(const [action,page] of [['next',2],['last',37],['previous',36],['first',1]]) {
    const button=pager.locator(`[data-page-action="${action}"]`);
    await button.scrollIntoViewIfNeeded();await settled(remote);
    const y=await remote.evaluate(()=>scrollY);
    await button.click();
    await remote.waitForFunction(page=>document.querySelector('#lark-search-results').parentElement.nextElementSibling.dataset.page===String(page),page);
    await settled(remote);
    assert.ok(Math.abs(await remote.evaluate(()=>scrollY)-y)<2,`${action} keeps scroll position`);
   }
   assert.equal(await pager.locator('.result-pager-items-total > [aria-hidden]').innerText(),'221 条');
   await jump('#lark-search-results',37);
   assert.equal(await pager.locator('.result-pager-count').innerText(),'217–221');
   for(const width of [360,392,768]) {
    await remote.setViewportSize({width,height:817});await settled(remote);
    await pager.evaluate(e=>e.scrollIntoView({block:'center'}));
    await remote.waitForFunction(()=>getComputedStyle(document.querySelector('#lark-search-results').parentElement.nextElementSibling.querySelector('.result-pager-editor')).opacity==='1');
    const geometry=await pager.evaluate(e=>{
     const r=e.getBoundingClientRect(),c=e.querySelector('.result-pager-controls').getBoundingClientRect();
     const t=e.querySelector('.result-pager-items-total').getBoundingClientRect();
     const range=e.querySelector('.result-pager-count').getBoundingClientRect();
     const arrows=[...e.querySelectorAll('[data-page-action] svg')].map(svg=>svg.getBoundingClientRect());
     return {center:Math.abs((c.left+c.right-r.left-r.right)/2),gap:t.left-c.right,
      inside:t.right<=r.right+1,rangeGap:c.left-range.right,rangeInside:range.left>=r.left-1,
      arrowsCentered:arrows.length===4 && arrows.every(a=>Math.abs((a.top+a.bottom-c.top-c.bottom)/2)<1)};
    });
    assert.ok(geometry.center<1,`${width}: page controls centered`);
    assert.ok(geometry.gap>=3 && geometry.inside,`${width}: total fits without overlap`);
    assert.ok(geometry.rangeGap>=3 && geometry.rangeInside,`${width}: current range fits`);
    assert.ok(geometry.arrowsCentered,`${width}: arrow icons vertically centered`);
    await pager.screenshot({path:path.join(notes,`pager-${width}.png`)});
   }
   await jump('#lark-search-results',1);
   await remote.setViewportSize({width:392,height:817});await settled(remote);
   await pager.screenshot({path:path.join(notes,'pager-buttons.png')});
  });
  await check('searchClearGeometryAndDock',async()=>{
   for(const [name,page] of [['host',host],['remote',remote]]) {
    if(name==='host') {
     await host.locator('[data-host-workspace="request"]').click();await host.locator('[data-request-view="search"]').click();
     await host.locator('[data-search-mode="shared"]').click();
    }
    const input=page.locator('#lark-search-query'),clear=page.locator('#lark-search-form .search-clear-button');
    await input.fill('Offline');
    for(const busy of [false,true]) {
     await clear.evaluate((e,busy)=>e.disabled=busy,busy);
     await clear.hover({force:true});
     const a=await input.boundingBox(),b=await clear.boundingBox();
     assert.ok(Math.abs(a.y+a.height/2-b.y-b.height/2)<1,`${name} clear remains centered (busy=${busy})`);
    }
    await clear.evaluate(e=>e.disabled=false);
    await page.locator('#lark-search-form').screenshot({path:path.join(notes,`${name}-search-clear.png`)});
   }
   const bottom=await remote.locator('#playback-dock').evaluate(e=>getComputedStyle(e).bottom);
   assert.equal(bottom,'12px'); // no safe-area in desktop Chromium emulation
  });
  await check('fullscreenTopAlignment',async()=>{
   const actions=host.locator('.player-panel > .panel-head .stage-actions');
   await host.evaluate(()=>{document.querySelector('.player-panel h2').textContent='Long fixture title '.repeat(20);});
   const parent=await actions.locator('..').boundingBox(),box=await actions.boundingBox();
   assert.ok(Math.abs(box.y-parent.y)<1,'Actions stay at the top of a multiline heading');
   await host.locator('.player-panel > .panel-head').screenshot({path:path.join(notes,'host-fullscreen-heading.png')});
  });
  await check('hostSearchScroll',async()=>{
   await host.locator('[data-host-workspace="request"]').click();
   await host.locator('[data-request-view="search"]').click();
   for(const [mode,selector,input,button] of [
    ['shared','#lark-search-results','#lark-search-query','#lark-search-button'],
    ['local','#search-results','#search-query','#search-button']]) {
    await host.locator(`[data-search-mode="${mode}"]`).click();
    await host.locator(input).fill('Offline');await host.locator(button).click();
    await host.waitForFunction(mode=>state.searchModeState[mode].items.length===80,mode);
    assert.equal(await host.locator(`[data-search-summary="${mode}"]`).innerText(),'共 221 条');
    for(const length of [160,221]) {
     await host.locator(selector).focus();
     // Exercise the scroller itself; native End shortcuts differ in WebKit.
     await host.locator(selector).evaluate(e=>e.scrollTo({top:e.scrollHeight,behavior:'instant'}));
     try {await host.waitForFunction(({mode,length})=>state.searchModeState[mode].items.length===length,{mode,length},{timeout:5000});}
     catch(error) {
      measurements.hostSearchScroll=await host.evaluate(({mode,selector})=>{
       const e=document.querySelector(selector),r=e.getBoundingClientRect(),last=e.lastElementChild.getBoundingClientRect();
       const m=state.searchModeState[mode];
       return {mode,clientHeight:e.clientHeight,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,rect:{top:r.top,bottom:r.bottom},last:{top:last.top,bottom:last.bottom},hidden:!!e.closest('[hidden],.hidden'),loading:m.loading,pageLoading:m.pageLoading,pageData:m.pageData?{...m.pageData,items:m.pageData.items.length}:null};
      },{mode,selector});
      throw error;
     }
    }
   }
   await host.locator('#search-results').evaluate(e=>e.scrollTo({top:e.scrollHeight,behavior:'instant'}));
   await host.waitForFunction(()=>{
    const container=document.querySelector('#search-results');
    return container.lastElementChild.getBoundingClientRect().bottom<=container.getBoundingClientRect().bottom+2;
   });
   await settled(host);await host.screenshot({path:path.join(notes,'search-desktop.png')});
   await host.locator('#search-results .search-result-item').first().click();
   const detail=host.locator('.song-detail-card:visible');await detail.waitFor({state:'visible'});
   for(const theme of ['light','dark','blue']) {
    await host.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const surfaces=await host.evaluate(()=>{
     const read=e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,border:s.border,radius:s.borderRadius,shadow:s.boxShadow};};
     return {detail:read(document.querySelector('.song-detail-card')),confirm:read(document.querySelector('#confirm-popover')),volume:read(document.querySelector('.volume-adjust-popover')),selection:read(document.querySelector('.selection-modal-card')),sharing:read(document.querySelector('.remote-access-card')),audio:read(document.querySelector('.audio-variant-popover')),
      blur:[...document.querySelectorAll('.song-detail-view,.selection-modal-backdrop,.rating-modal-backdrop')].map(e=>getComputedStyle(e).backdropFilter),volumeBlur:getComputedStyle(document.querySelector('.volume-adjust-popover'),'::backdrop').backdropFilter};
    });
    await closeControl(host,detail,host.locator('.song-detail-close:visible'));
    for(const kind of ['detail','confirm','selection','sharing','audio'])assert.deepEqual(surfaces[kind],surfaces.volume,`${theme}: ${kind}`);
    assert.ok(surfaces.blur.every(v=>v==='none'));assert.equal(surfaces.volumeBlur,'none');
   }
   await host.evaluate(()=>document.documentElement.dataset.theme='light');await settled(host);
   await host.screenshot({path:path.join(notes,'host-detail-dialog.png')});
   await host.locator('.song-detail-close:visible').click();await detail.waitFor({state:'hidden'});
  });
  await check('presentationQrUnderNativeCsp',async()=>{
   const controller=await hostContext.newPage();
   await controller.addInitScript(()=>{
    window.__TAURI__={core:{invoke:async()=>({mode:'localDualScreen',phase:'active',generation:1,
      playbackAuthority:'host',mediaRendererOwner:'host',controllerReady:true})},event:{listen:async()=>()=>{}}};
   });
   const response=await controller.goto(base+'/controller.html?presentationGeneration=1');
   assert.ok(response.headers()['content-security-policy']);
   await controller.waitForFunction(()=>document.querySelector('#controller-exit').disabled===false);
   await host.evaluate(()=>{
    const channel=new BroadcastChannel(BilikaraPresentationSync.channelName);
    channel.postMessage(BilikaraPresentationSync.makeEnvelope('master-state',{
     language:'zh',scene:{generation:1},remoteAccess:state.data.remote_access,
     internetRemote:{active:true,connected_count:0,password:'000000',qr_image:state.data.remote_access.qr_image}
    },{senderId:'offline-qr-fixture',sequence:1}));channel.close();
   });
   await controller.waitForFunction(()=>['controller-remote-qr-image','controller-internet-remote-qr-image'].every(id=>{
    const image=document.getElementById(id);return image.naturalWidth>0&&!image.classList.contains('hidden');
   }));
   assert.equal(await controller.locator('#controller-remote-url-link').textContent(),new URL(await controller.locator('#controller-remote-url-link').getAttribute('href')).origin+'/remote');
   assert.match(await controller.locator('.presentation-output-remote-popover').evaluate(e=>getComputedStyle(e).transitionDuration),/^0\.2s/);
   await host.evaluate(()=>{
    const channel=new BroadcastChannel(BilikaraPresentationSync.channelName);
    channel.postMessage(BilikaraPresentationSync.makeEnvelope('master-state',{
     language:'zh',scene:{generation:1},remoteAccess:{preferred_url:'',local_url:'',qr_image:'',unavailable_message:'HTTP 503 fixture'},internetRemote:{active:false}
    },{senderId:'offline-qr-fixture',sequence:2}));channel.close();
   });
   await controller.waitForFunction(()=>document.querySelector('#controller-remote-url-hint').textContent.includes('503'));
   assert.equal(await controller.locator('#controller-remote-url-link').getAttribute('href'),null);
   assert.equal(await controller.locator('#controller-remote-qr-image').getAttribute('src'),null);
   measurements.presentationQrUnderNativeCsp={transport:'fixture shell IPC and real native HTTP/CSP',publicRoomCreated:false};
   await controller.close();
  });
  await check('searchClearAndBusyOwnership',async()=>{
   await host.locator('#work-rail-request').click();await host.locator('[data-request-view="search"]').click();
   await primary();await remote.locator('#remote-request-search-tab').click();
   for(const [name,page] of [['host',host],['remote',remote]]) {
    for(const mode of ['shared','local']) {
     const tab=page.locator(`[data-${name==='host'?'search':'remote-search'}-mode="${mode}"]`);
     await tab.click();
     const form=page.locator(mode==='shared'?'#lark-search-form':'#search-form');
     const input=form.locator('input'),clear=form.locator('.search-clear-button'),submit=form.locator('button[type="submit"]');
     assert.equal(await clear.count(),1);
     assert.equal(await submit.innerText(),'');assert.equal(await submit.getAttribute('aria-label'),'搜索');
     const box=await submit.boundingBox();assert.ok(Math.abs(box.width-box.height)<=1,`${name}: magnifier should remain circular`);
     const reads=[];const observe=r=>{if(/\/api\/.*search/.test(new URL(r.url()).pathname))reads.push(r.url());};page.on('request',observe);
     try {
      await input.fill('Unsubmitted draft');await clear.waitFor({state:'visible'});
      await clear.focus();await clear.press('Enter');
      assert.equal(await input.inputValue(),'');assert.equal(await input.evaluate(e=>e===document.activeElement),true);
      assert.equal(await clear.isVisible(),false);
      await input.fill('Offline');await tab.click();
      assert.equal(await input.inputValue(),'Offline');assert.equal(await clear.count(),1);
      await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
      assert.equal(reads.length,0,'Editing and clearing drafts never reads the Catalog or library');
     } finally {page.off('request',observe);}
    }
    await page.locator(`[data-${name==='host'?'search':'remote-search'}-mode="shared"]`).click();
    const form=page.locator('#lark-search-form');
    for(const language of ['en','ja','zh']) {
     await page.evaluate(language=>setLanguage(language),language);
     const labels=await page.evaluate(()=>({clear:t('search.clearInput'),submit:t('search.submit')}));
     assert.equal(await form.locator('.search-clear-button').getAttribute('aria-label'),labels.clear);
     assert.equal(await form.locator('button[type="submit"]').getAttribute('aria-label'),labels.submit);
     assert.equal(await form.locator('input').inputValue(),'Offline');
    }
    let release;const gate=new Promise(r=>release=r);let reads=0;
    const hold=async route=>{reads++;const response=await route.fetch();await gate;await route.fulfill({response});};
    await page.route('**/api/catalog/search*',hold);
    try {
     await form.locator('input').fill('New fixture search');await form.locator('button[type="submit"]').click();
     await page.waitForFunction(()=>document.querySelector('#lark-search-button').getAttribute('aria-busy')==='true');
     assert.equal(await form.locator('.search-clear-button').isDisabled(),true);
     assert.equal(await form.locator('.browse-search-spinner').isVisible(),true);
     assert.equal(await form.locator('button[type="submit"]').evaluate(e=>getComputedStyle(e,'::before').content),'none','Only one loading indicator is painted');
     await form.evaluate(e=>e.requestSubmit());
     await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));
     assert.ok(reads<=1,'Repeated submit cannot duplicate the active read');
    } finally {release();}
    await page.waitForFunction(()=>!document.querySelector('#lark-search-button').disabled);
    assert.equal(reads,1);await page.unroute('**/api/catalog/search*',hold);
    assert.equal(await form.locator('.search-clear-button').isDisabled(),false);
    assert.equal(await form.locator('.browse-search-spinner').isVisible(),false);
    await settled(page);
    await page.locator(name==='host'?'#host-workspace-request':'.request-panel').screenshot({path:path.join(notes,name+'-search-clear.png')});
   }
  });
  await check('warningThemeColors',async()=>{
   const colors={};
   for(const theme of ['light','dark','blue']) {
    for(const page of [host,remote])await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    colors[theme]={};
    for(const [name,page] of [['host',host],['remote',remote]])colors[theme][name]=await page.evaluate(()=>{
     const style=getComputedStyle(document.documentElement),notice=document.querySelector('#gatcha-login-notice');
     const variables=Object.fromEntries(['ink','muted','accent','accent-deep','red','green','status-ready-rgb','status-warning-rgb','status-wait-rgb','status-error-rgb'].map(key=>[key,style.getPropertyValue('--'+key).trim()]));
     return {...variables,notice:getComputedStyle(notice).color,danger:style.getPropertyValue('--danger-btn-color').trim(),dangerBackground:style.getPropertyValue('--danger-btn-bg').trim(),dangerHover:style.getPropertyValue('--danger-btn-hover-bg').trim(),toastBorder:style.getPropertyValue('--toast-error-border').trim()};
    });
    assert.deepEqual(colors[theme].host,colors[theme].remote);
   }
   measurements.warningThemeColors=colors;
  });
  await check('sourceRefreshPresentationAndReload',async()=>{
   const disabledStyles={};
   await host.locator('#work-rail-request').click();await host.locator('[data-request-view="sources"]').click();
   await host.locator('[data-sources-mode="uids"]').click();
   await primary();await remote.locator('#remote-request-sources-tab').click();await remote.locator('[data-remote-sources-mode="uids"]').click();
   for(const page of [host,remote])await page.waitForFunction(()=>state.followBrowseData?.owners?.length && !state.followBrowseLoading);
   const cache=JSON.parse(await fs.readFile(path.join(directory,'gatcha_cache.json'),'utf8'));
   cache.uids['123'].push({...items[0],bvid:'BV9999999999',url:'https://www.bilibili.com/video/BV9999999999',title:'New fixture entry'});
   await fs.writeFile(path.join(directory,'gatcha_cache.json'),JSON.stringify(cache));
   for(const [name,page] of [['host',host],['remote',remote]]) {
    let task={busy:true,background_busy:true,last_status:'running',last_message:'本地曲库更新中',last_result:{rebuild:{phase:'uid',current_uid:'123',sources:{generation:1,uids:0,favorites:0}}}};
    const stateHandler=async route=>{
     const response=await route.fetch();const body=await response.json();body.data.gatcha=task;
     return route.fulfill({response,json:body});
    };
    await page.route('**/api/state',stateHandler);
    try {
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    const panel=page.locator(name==='host'?'#request-sources-uids':'#remote-sources-uids-panel');
    await page.evaluate(name=>{
     state.data.gatcha={busy:true,background_busy:true,last_status:'running',last_message:'本地曲库更新中',last_result:{rebuild:{phase:'uid',current_uid:'123',sources:{generation:1,uids:0,favorites:0}}}};
     if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();
    },name);
    assert.equal(await panel.locator('.source-task-status').count(),0);
    assert.equal(await panel.locator('[data-uid="123"] .source-card-spinner').isVisible(),true);
    assert.equal(await panel.locator('#refresh-gatcha-cache-button').getAttribute('aria-busy'),'true');
    disabledStyles[name]={};
    for(const theme of ['light','dark','blue']) {
     await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
     await settled(page);
     disabledStyles[name][theme]=await panel.locator('#refresh-gatcha-cache-button').evaluate(button=>{
      const s=getComputedStyle(button);return {background:s.backgroundColor,color:s.color,opacity:s.opacity};
     });
    }
    await page.evaluate(()=>document.documentElement.dataset.theme='light');
    await settled(page);
    await panel.screenshot({path:path.join(notes,name+'-source-fetching.png')});
    let reads=0;const observe=r=>{if(new URL(r.url()).pathname==='/api/gatcha/browse')reads++;};page.on('request',observe);
    task={busy:true,last_status:'running',last_updated_at:1,last_result:{rebuild:{phase:'uid',sources:{generation:1,uids:1,favorites:0}}}};
    await page.evaluate(({name,task})=>{
     state.data.gatcha=task;
     if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();
    },{name,task});
    await page.waitForFunction(()=>!state.followBrowseLoading && state.followBrowseData?.owners?.[0]?.count===222);
    assert.equal(reads,1,'The first source is visible before the batch finishes');
    assert.equal(await page.evaluate(()=>state.data.gatcha.busy),true);
    assert.equal(await panel.locator('.source-card-spinner').count(),0,'Completed source stops spinning');
    reads=0;
    task={busy:false,background_busy:false,last_status:'success',last_message:'更新完成',last_updated_at:1};
    await page.evaluate(({name,task})=>{
     state.data.gatcha=task;
     if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();
    },{name,task});
    await page.waitForFunction(()=>!state.followBrowseLoading && state.followBrowseData?.owners?.[0]?.count===222);
    await page.evaluate(name=>{for(let n=0;n<3;n++){if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();}},name);
    assert.equal(reads,1,'One completed task reloads the open source browser once');
    page.off('request',observe);
    assert.equal(await panel.locator('.source-task-status').isVisible(),false);
    } finally {
     // This scenario owns the page routes. Drain any polled state fetch before
     // restoring the context's network guard or moving to the next scenario.
     await page.unrouteAll({behavior:'wait'});
    }
   }
   measurements.sourceRefreshPresentationAndReload={taskState:'local UI fixture',browse:'real native HTTP and modified task-owned records',autoRefreshReadsPerClient:1};
   for(const [name,page] of [['host',host],['remote',remote]]) {
    let release,intercepted;
    const gate=new Promise(resolve=>{release=resolve;});
    const waiting=new Promise(resolve=>{intercepted=resolve;});
    let requests=0;
    const holdFirst=async route=>{
     requests++;
     if(requests===1) {const response=await route.fetch();intercepted();await gate;await route.fulfill({response});}
     else await route.continue();
    };
    await page.route('**/api/gatcha/browse*',holdFirst);
    try {
     await page.evaluate(name=>{
      state.data.gatcha={busy:true,last_status:'running'};
      if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();
      void loadFollowBrowse({uid:'',query:'',keepQuery:true});
     },name);
     await Promise.race([waiting,new Promise((_,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Source browse did not reach its local fixture')),5000);
      waiting.then(()=>clearTimeout(timeout));
     })]);
     const count=cache.uids['123'].length;
     cache.uids['123'].push({...items[0],bvid:`BV${String(count).padStart(10,'0')}`,title:`New fixture entry ${count}`});
     await fs.writeFile(path.join(directory,'gatcha_cache.json'),JSON.stringify(cache));
     await page.evaluate(name=>{
      state.data.gatcha={busy:false,last_status:'success',last_updated_at:2};
      if(name==='host')renderGatchaUidFace();else renderSourceManagementControls();
     },name);
     assert.equal(requests,1,'Completion waits for the existing browse read');
     release();
     await page.waitForFunction(count=>!state.followBrowseLoading && state.followBrowseData?.owners?.[0]?.count===count,count+1);
     assert.equal(requests,2,'Exactly one follow-up read replaces the stale in-flight result');
    } finally {release();await page.unroute('**/api/gatcha/browse*',holdFirst);}
   }
   assert.deepEqual(disabledStyles.host,disabledStyles.remote,'Source buttons share disabled colors and opacity in every theme');
   measurements.sourceRefreshPresentationAndReload.disabledStyles=disabledStyles;
   measurements.sourceRefreshPresentationAndReload.completionDuringBrowse='one deferred refresh per client';
   await host.locator('#follow-up-grid [data-uid="123"]').click();
   await host.locator('#follow-search-form.browse-search-form').waitFor();
   assert.equal(await host.locator('#follow-search-form button[type="submit"]').getAttribute('aria-expanded'),'false');
   await host.locator('#request-sources-uids').screenshot({path:path.join(notes,'host-uploader-search.png')});
  });
  await check('sourceManualRefreshCompletion',async()=>{
   await host.locator('#work-rail-request').click();await host.locator('[data-request-view="sources"]').click();
   await host.locator('[data-sources-mode="uids"]').click();
   await primary();await remote.locator('#remote-request-sources-tab').click();await remote.locator('[data-remote-sources-mode="uids"]').click();
   for(const [name,page] of [['host',host],['remote',remote]]) {
    if(name==='remote' && await page.locator('#sources-follow-back').isVisible())await page.locator('#sources-follow-back').click();
    await page.waitForFunction(()=>state.followBrowseData?.owners?.length && !state.followBrowseLoading);
    let task={busy:false,background_busy:false,last_status:'idle'};
    const revision=await page.evaluate(()=>state.data.state_revision+100);
    const stateHandler=async route=>{
     const response=await route.fetch();const body=await response.json();
     body.data.gatcha=task;body.data.state_revision=revision;
     return route.fulfill({response,json:body});
    };
    let release,reached;const gate=new Promise(resolve=>release=resolve),posted=new Promise(resolve=>reached=resolve);
    const refreshHandler=async route=>{reached();await gate;await route.fulfill({json:{ok:true,data:{started:true}}});};
    await page.route('**/api/state',stateHandler);await page.route('**/api/gatcha/refresh',refreshHandler);
    try {
     await page.evaluate(()=>fetchState());
     await page.waitForFunction(()=>!document.querySelector('#refresh-gatcha-cache-button').disabled);
     await page.locator('#refresh-gatcha-cache-button').click();await posted;
     assert.equal(await page.locator('#refresh-gatcha-cache-button').isDisabled(),true);
     assert.equal(await page.locator('#refresh-gatcha-cache-button').getAttribute('aria-busy'),'true');
     const cache=JSON.parse(await fs.readFile(path.join(directory,'gatcha_cache.json'),'utf8'));
     const count=cache.uids['123'].length+1;
     cache.uids['123'].push({...items[0],bvid:`BV${String(count).padStart(10,'0')}`,title:'Fast completed refresh'});
     await fs.writeFile(path.join(directory,'gatcha_cache.json'),JSON.stringify(cache));
     task={busy:false,background_busy:false,last_status:'success',last_message:'更新完成',last_updated_at:1};
     // A completion arrives through polling/SSE before the POST response.
     await page.evaluate(({name,task,revision})=>{
      const next={...state.data,state_revision:revision+1,gatcha:task};
      if(name==='host'){acceptHostStateSnapshot(next);render();}else applyStateSnapshot(next);
     },{name,task,revision});
     release();
     await page.waitForFunction(count=>!state.gatchaRefreshSaving && !state.followBrowseLoading && state.followBrowseData?.owners?.[0]?.count===count,count);
     assert.equal(await page.locator('#refresh-gatcha-cache-button').isEnabled(),true);
     assert.equal(await page.evaluate(()=>state.data.gatcha.last_status),'success');
    } finally {
     release();await page.unrouteAll({behavior:'wait'});
     await page.reload();await page.waitForFunction(()=>state.data?.capabilities);
    }
   }
  });
  await check('hostInlineSearchContexts',async()=>{
   async function draft(form,render) {
    await form.waitFor();const submit=form.locator('button[type="submit"]');
    await host.waitForFunction(e=>!e.disabled,await submit.elementHandle());
    assert.equal(await submit.getAttribute('aria-expanded'),'false');await submit.click();
    const input=form.locator('input');await input.fill('Draft to clear');
    await host.evaluate(render);
    assert.equal(await input.inputValue(),'Draft to clear','Repeated state rendering retains the draft');
    assert.equal(await form.locator('.search-clear-button').count(),1);
    const count=calls.length;await form.locator('.search-clear-button').click();
    assert.equal(await input.inputValue(),'');assert.equal(await input.evaluate(e=>e===document.activeElement),true);
    assert.equal(await submit.getAttribute('aria-expanded'),'true');
    await form.locator('..').locator('.browse-search-cancel').click();await settled(host);
    assert.equal(calls.length,count,'Clearing/collapsing an unsubmitted draft makes no Catalog request');
   }
   await draft(host.locator('#follow-search-form'),()=>{renderFollowBrowse();renderFollowBrowse();});
   await host.locator('[data-sources-mode="favorites"]').click();
   await host.locator('#favlist-grid [data-folder-id="123:456"]').click();
   await draft(host.locator('#favlist-search-form'),()=>{renderFavlistBrowse();renderFavlistBrowse();});
   await host.locator('#host-workspace-request').screenshot({path:path.join(notes,'host-favorites-inline-search.png')});
   await host.locator('[data-request-view="discover"]').click();
   for(const kind of ['name','artist']) {
    await host.locator(`[data-discover-mode="${kind}"]`).click();
    const panel=host.locator(`#request-discover-${kind}`);
    assert.equal(await panel.locator('.browse-search-form:visible').count(),0,'Letter root has no nonfunctional search button');
    await panel.locator('[data-letter="A"]').click();await panel.locator('[data-tag="Artist 0"]').waitFor();
    const form=panel.locator('.browse-search-form');
    await draft(form,()=>renderD1BrowseView());
    await form.locator('button[type="submit"]').click();await form.locator('input').fill('Artist 39');
    await form.locator('button[type="submit"]').click();await panel.locator('[data-tag="Artist 39"]').waitFor();
    assert.equal(await panel.locator('[data-tag]').count(),1);
    const gap=await panel.evaluate(e=>e.querySelector('[data-tag]').getBoundingClientRect().top-e.querySelector('.browse-search-bar').getBoundingClientRect().bottom);
    assert.ok(gap>=0 && gap<=16,'Filtered cards follow the navigation row without an empty grid track');
    await settled(host);await host.locator('#host-workspace-request').screenshot({path:path.join(notes,`host-${kind}-inline-search.png`)});
    await panel.locator('.browse-search-cancel').click();await panel.locator('[data-tag="Artist 0"]').waitFor();
   }
   await host.locator('[data-discover-mode="categories"]').click();
   const panel=host.locator('#request-discover-categories');
   await panel.locator('.category-browser-card').first().click();
   await draft(panel.locator('.browse-search-form'),()=>renderCategoryBrowseView());
   await panel.locator('[data-category-browse-back]').click();
  });
  await check('hostSelectionAndRatingSurfaces',async()=>{
   // Use existing presentation functions with synthetic display data only;
   // never confirm a binding or submit a song rating.
   for(const theme of ['light','dark','blue']) {
    await host.evaluate(theme=>{
     document.documentElement.dataset.theme=theme;
     openBindingModal({}, {pages:[{page:1,part:'Original track',duration:123},{page:2,part:'Instrumental',duration:123}],preferred_page:1});
    },theme);
    const card=host.locator('#binding-modal .selection-modal-card');await card.waitFor();await settled(host);
    const styles=await card.evaluate(e=>{
     const s=getComputedStyle(e),v=getComputedStyle(document.querySelector('.volume-adjust-popover'));
     return {surface:[s.backgroundColor,s.border,s.borderRadius,s.boxShadow],volume:[v.backgroundColor,v.border,v.borderRadius,v.boxShadow],footer:getComputedStyle(e.querySelector('.selection-modal-actions')).backgroundColor,
      title:getComputedStyle(e.querySelector('h2')).fontSize};
    });
    assert.deepEqual(styles.surface,styles.volume);assert.equal(styles.footer,'rgba(0, 0, 0, 0)');assert.equal(styles.title,'18px');
    await closeControl(host,card,host.locator('#binding-modal-close'));
    await card.screenshot({path:path.join(notes,`host-binding-${theme}.png`)});
    await host.locator('#binding-modal-close').click();await card.waitFor({state:'hidden'});
    await host.locator('#work-rail-queue').click();
    await host.evaluate(item=>openRatingPrompt({...item,id:'ui-rating-fixture'},{manual:true}),items[0]);
    const rating=host.locator('.rating-card');await rating.waitFor();await settled(host);
    const style=await rating.evaluate(e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.border,s.borderRadius,s.boxShadow];});
    try {assert.deepEqual(style,styles.volume);await closeControl(host,rating,rating.locator('.rating-close'));await rating.screenshot({path:path.join(notes,`host-rating-${theme}.png`)});await host.screenshot({path:path.join(notes,`host-rating-${theme}-scope.png`)});}
    finally {await host.evaluate(()=>closeRatingPrompt({submit:false}));await rating.waitFor({state:'hidden'});}
   }
   await host.evaluate(()=>document.documentElement.dataset.theme='light');
  });
  await check('remoteModalBackdrop',async()=>{
   await remote.evaluate(()=>document.documentElement.dataset.theme='light');
   await remote.setViewportSize({width:412,height:850});
   await primary();await remote.locator('#remote-request-search-tab').click();
   await remote.locator('[data-remote-search-mode="shared"]').click();
   await remote.locator('#lark-search-query').fill('Offline');await remote.locator('#lark-search-button').click();
   await remote.locator('#lark-search-results .search-result-item').first().click();
   const detail=remote.locator('.song-detail-card:visible');await detail.waitFor();await settled(remote);
   const verify=async()=>{
    await remote.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    await assertBackdropPolicy(remote);
    const bounds=await remote.locator('.song-detail-backdrop').evaluate(e=>{const b=e.getBoundingClientRect();return [b.left,b.top,b.right-innerWidth,b.bottom-innerHeight];});
    assert.ok(bounds.every(v=>Math.abs(v)<1),'Remote detail dims the whole viewport');
   };
   await remote.evaluate(()=>window.scrollTo(0,0));
   await verify();await remote.screenshot({path:path.join(notes,'remote-detail-card-scope.png')});
   await remote.evaluate(()=>window.scrollBy(0,90));await verify();
   await remote.setViewportSize({width:428,height:850});await verify();
   await detail.locator('.song-detail-close').click();await detail.waitFor({state:'hidden'});
   assert.equal(await remote.evaluate(()=>document.querySelector('.search-result-item.is-selected')===document.activeElement),true,'Closing returns focus to the selected source');
   await remote.locator('#lark-search-results .search-result-item').first().click();await detail.waitFor();await settled(remote);
   await remote.evaluate(()=>window.scrollTo(0,0));
   await remote.mouse.click(380,25);await detail.waitFor({state:'hidden'});
   assert.equal(await remote.locator('#remote-menu-panel').isVisible(),false,'The modal click-away layer must not activate the menu beneath it');
   assert.equal(await remote.evaluate(()=>document.querySelector('.search-result-item.is-selected')===document.activeElement),true);
   await remote.setViewportSize({width:392,height:817});await remote.evaluate(()=>window.scrollTo(0,0));
  });
  await check('remoteCloseControls',async()=>{
   for(const theme of ['light','dark','blue']) {
    await remote.evaluate(({theme,item})=>{
     document.documentElement.dataset.theme=theme;
     initSearchDetailController();searchDetailController.open(item);
    },{theme,item:items[0]});
    const detail=remote.locator('.song-detail-card:visible');await detail.waitFor();
    await closeControl(remote,detail,detail.locator('.song-detail-close'),true);
    await detail.screenshot({path:path.join(notes,`remote-detail-${theme}.png`)});
    await detail.locator('.song-detail-close').click();await detail.waitFor({state:'hidden'});
    await remote.evaluate(item=>openRatingPrompt({...item,id:'ui-rating-fixture'},{manual:true}),items[0]);
    const rating=remote.locator('.rating-card');await rating.waitFor();
    try {
     await closeControl(remote,rating,rating.locator('.rating-close'),true);
     await rating.screenshot({path:path.join(notes,`remote-rating-${theme}.png`)});
     await remote.screenshot({path:path.join(notes,`remote-rating-${theme}-page.png`)});
    } finally {await remote.evaluate(()=>closeRatingPrompt({submit:false}));await rating.waitFor({state:'hidden'});}
   }
   await remote.evaluate(()=>document.documentElement.dataset.theme='light');
   await remote.evaluate(()=>openBindingSheet({}, {pages:[{page:1,part:'Original track',duration:123},{page:2,part:'Instrumental',duration:123}],preferred_page:1}));
   const binding=remote.locator('#binding-sheet .binding-sheet-panel');await binding.waitFor();
   await closeControl(remote,binding,binding.locator('.binding-sheet-close'),true);
   await binding.screenshot({path:path.join(notes,'remote-binding-light.png')});
   await binding.locator('.binding-sheet-close').click();await binding.waitFor({state:'hidden'});
   await remote.evaluate(()=>openPoolConfigSheet());
   const pool=remote.locator('#gatcha-pool-config-sheet .binding-sheet-panel');await pool.waitFor();
   await closeControl(remote,pool,pool.locator('.binding-sheet-close'),true);
   await pool.locator('.binding-sheet-close').click();await pool.waitFor({state:'hidden'});
  });
  await check('hostCategoryColumns',async()=>{
   await host.evaluate(()=>document.documentElement.dataset.theme='light');
   await host.locator('#work-rail-request').click();
   await host.locator('[data-request-view="discover"]').click();
   await host.locator('[data-discover-mode="categories"]').click();
   const sizes=[];
   for(const width of [1280,1536,1707,1920,412]) {
    await host.setViewportSize({width,height:width===412?817:960});
    if(width===412)await host.locator('[data-android-page="request"]').click();
    const grid=host.locator('#request-discover-categories .category-browser-grid');
    await grid.waitFor({state:'visible'});await settled(host);
    sizes.push(await grid.evaluate((e,width)=>({viewport:width,width:e.getBoundingClientRect().width,
     columns:getComputedStyle(e).gridTemplateColumns.split(' ').length,noOverflow:e.scrollWidth<=e.clientWidth+1}),width));
    if(width===1707||width===412)await host.screenshot({path:path.join(notes,'category-'+width+'.png')});
   }
   measurements.hostCategoryColumns={sizes};
   assert.equal(sizes.find(s=>s.viewport===1707).columns,2,'2K / 150% Host should show two category columns');
   assert.equal(sizes.find(s=>s.viewport===1280).columns,1,'Narrow desktop stays readable');
   assert.equal(sizes.find(s=>s.viewport===412).columns,2,'Phone keeps its compact two columns');
   assert.ok(sizes.every(s=>s.noOverflow));
  });
  await check('portraitContextualTabs',async()=>{
   await host.setViewportSize({width:412,height:850});
   await host.locator('[data-android-page="request"]').click();
   await host.locator('[data-request-back]:visible').click();
   const input=host.locator('#url-input');await input.fill('Preserved quick request');
   await host.evaluate(()=>window.contextualTabIdentity={input:document.querySelector('#url-input'),
    tabs:document.querySelector('#request-discover-panel .request-mode-tabs'),media:[...document.querySelectorAll('video,audio')]});
   for(const view of ['search','discover','sources']) {
    await host.locator(`[data-request-view="${view}"]`).click();
    assert.equal(await host.locator('#android-page-tools').isVisible(),false,'No empty primary toolbar remains');
    const panel=host.locator(`#request-${view}-panel`),head=panel.locator('.request-mode-head');
    assert.equal(await panel.locator('[data-request-back]').isVisible(),true);
    assert.equal(await panel.locator('.request-mode-tabs').isVisible(),true);
    assert.ok((await head.boundingBox()).height<=68,'One compact navigation row');
    if(view==='search')await host.locator('#lark-search-query').fill('Preserved catalog draft');
    await settled(host);await host.screenshot({path:path.join(notes,`host-phone-${view}.png`)});
    await panel.locator('[data-request-back]').click();
    assert.equal(await input.inputValue(),'Preserved quick request');
    assert.equal(await host.locator(`[data-request-view="${view}"]`).evaluate(e=>e===document.activeElement),true);
   }
   await host.locator('[data-request-view="quick"]').focus();await host.keyboard.press('ArrowRight');
   assert.equal(await host.locator('#request-search-panel [aria-selected="true"]').evaluate(e=>e===document.activeElement),true,'Keyboard focus follows the newly visible secondary tabs');
   assert.equal(await host.locator('#lark-search-query').inputValue(),'Preserved catalog draft');
   await host.setViewportSize({width:412,height:340});
   assert.equal(await host.locator('html').getAttribute('data-host-layout'),'portrait','Keyboard-sized height changes keep compact navigation');
   await host.setViewportSize({width:1440,height:900});await settled(host);
   assert.equal(await host.locator('.request-workspace-head .request-subview-tabs').isVisible(),true);
   assert.equal(await host.locator('#request-search-panel .request-mode-tabs').isVisible(),true);
   assert.equal(await host.locator('[data-request-back]:visible').count(),0,'Desktop retains its full navigation');
   assert.equal(await host.evaluate(()=>contextualTabIdentity.input===document.querySelector('#url-input') && contextualTabIdentity.tabs===document.querySelector('#request-discover-panel .request-mode-tabs') && contextualTabIdentity.media.every((node,i)=>node===document.querySelectorAll('video,audio')[i])),true);
   await host.screenshot({path:path.join(notes,'host-desktop-tabs.png')});
  });
  await check('sharedRequestTabAppearance',async()=>{
   const read=async locator=>locator.evaluate(e=>{
    const s=getComputedStyle(e);return Object.fromEntries(['fontSize','fontWeight','lineHeight','height','minHeight','borderRadius','padding','borderTopWidth','backgroundColor','color','boxShadow'].map(k=>[k,s[k]]));
   });
   await primary();await remote.locator('#remote-request-search-tab').click();
   for(const width of [412,1440]) {
    await host.setViewportSize({width,height:850});await remote.setViewportSize({width:412,height:850});
    if(width===412)await host.locator('[data-android-page="request"]').click();
    for(const theme of ['light','dark','blue']) {
     for(const page of [host,remote])await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
     await settled(host);await settled(remote);
     assert.deepEqual(await read(host.locator('[data-search-mode="shared"]')),await read(remote.locator('[data-remote-search-mode="shared"]')),`${theme} ${width} secondary tab`);
     assert.deepEqual(await read(host.locator('[data-search-mode="local"]')),await read(remote.locator('[data-remote-search-mode="local"]')),`${theme} ${width} inactive tab`);
     if(width===1440) {
      await primary();await remote.locator('#remote-request-quick-tab').click();
      await host.locator('[data-request-view="quick"]').click();await settled(host);await settled(remote);
      assert.deepEqual(await read(host.locator('[data-request-view="quick"]')),await read(remote.locator('#remote-request-quick-tab')),`${theme} primary tab`);
      await host.locator('[data-request-view="search"]').click();await remote.locator('#remote-request-search-tab').click();
     }
     if(theme==='light') {
      await host.screenshot({path:path.join(notes,`host-shared-tabs-${width}.png`)});
      await remote.screenshot({path:path.join(notes,'remote-shared-tabs.png')});
     }
    }
   }
  });
  await check('partialPageBlankSwipe',async()=>{
   await remote.setViewportSize({width:392,height:817});
   await remote.evaluate(()=>{
    const grid=document.createElement('div');grid.id='blank-swipe-fixture';
    grid.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:10px';
    document.querySelector('.remote-shell').prepend(grid);
    window.blankPager=BilikaraResultPager.create(grid,{translate:t,reportError:message=>{throw Error(message)},renderItems:(entries,_empty,target=grid)=>{
     target.replaceChildren(...entries.map(n=>{const card=document.createElement('div');card.textContent=`Fixture ${n}`;card.style.height='100px';return card}));
    }});
    blankPager.update({key:'blank',items:Array.from({length:7},(_,n)=>n),pageSize:6,total:7});
   });
   const viewport=remote.locator('#blank-swipe-fixture').locator('..');
   const pager=viewport.locator('xpath=following-sibling::nav[1]');
   await pager.locator('[data-page-action="last"]').click();await settled(remote);
   await viewport.scrollIntoViewIfNeeded();
   const box=await viewport.boundingBox();
   assert.ok(box.height>=320);
   await remote.mouse.move(box.x+30,box.y+box.height-30);await remote.mouse.down();
   await remote.mouse.move(box.x+180,box.y+box.height-30,{steps:8});await remote.mouse.up();
   await remote.waitForFunction(()=>document.querySelector('#blank-swipe-fixture').children.length===6);
   if(browserName==='chromium') {
    await pager.locator('[data-page-action="last"]').click();await settled(remote);
    await viewport.scrollIntoViewIfNeeded();const bounds=await viewport.boundingBox();
    const session=await remoteContext.newCDPSession(remote);
    const y=bounds.y+bounds.height-30,x=bounds.x+30;
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let step=1;step<=8;step++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+step*20,y}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await remote.waitForFunction(()=>document.querySelector('#blank-swipe-fixture').children.length===6);
    await settled(remote);
    const start=await viewport.boundingBox(),sx=start.x+start.width-35,sy=start.y+240;
    const scrollBefore=await remote.evaluate(()=>scrollY);
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:sx,y:sy}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:sx-12,y:sy-8}]});
    for(let step=1;step<=8;step++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:sx-12-step*15,y:sy-8-step*18}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await remote.waitForFunction(()=>document.querySelector('#blank-swipe-fixture').children.length===1);
    assert.equal(await remote.evaluate(()=>scrollY),scrollBefore,'A horizontal start stays locked through later vertical drift');
    await settled(remote);
    const vertical=await viewport.boundingBox(),vx=vertical.x+vertical.width/2,vy=vertical.y+250;
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:vx,y:vy}]});
    for(let step=1;step<=8;step++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:vx+step,y:vy-step*16}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await settled(remote);
    assert.ok(await remote.evaluate(()=>scrollY)>scrollBefore,'An intentional vertical gesture retains native page scrolling');
    assert.equal(await pager.getAttribute('data-page'),'2','Vertical scrolling cannot turn a page');
    // Let that deliberate native fling finish before removing its content or
    // starting an unrelated modal's scroll-position assertion.
    await remote.evaluate(()=>new Promise(resolve=>{
     let previous=scrollY,stable=0;
     const frame=()=>{stable=scrollY===previous?stable+1:0;previous=scrollY;if(stable>=12)resolve();else requestAnimationFrame(frame)};
     requestAnimationFrame(frame);
    }));
    await session.detach();
   }
   await remote.evaluate(()=>{const grid=document.querySelector('#blank-swipe-fixture');grid.parentElement.nextElementSibling.remove();grid.parentElement.remove()});
  });
  await check('playbackSheetStableScrollAndVolumeAnchor',async()=>{
   await remote.evaluate(item=>{
    disconnectClient();document.documentElement.dataset.theme='light';
    state.data.current_item={...item,id:'cache-ui',item_incarnation_id:'i-fixture',display_title:'多音轨缓存展示',requester_name:'UI fixture',cache_status:'downloading',cache_progress:58.8,cache_message:'总计：120 B / 200 B\n视频P1：80 B / 100 B\n音轨P2：40 B / 100 B',cache_activity_at:100,cache_download_current_bytes:125829120,cache_download_total_bytes:209715200,cache_download_tracks:[{key:'video-p1',label:'视频P1',current_bytes:83886080,target_bytes:104857600,done:false,phase:'downloading',attempt:1,max_attempts:10},{key:'audio-p2',label:'音轨P2',current_bytes:41943040,target_bytes:104857600,done:false,phase:'downloading',attempt:1,max_attempts:10}]};
    state.data.player_settings.volume_percent=100;render();
    window.scrollTo(0,150);
   },items[0]);
   const before=await remote.evaluate(()=>scrollY);
   await remote.locator('#playback-dock').click();await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before,'Opening keeps the actual document scroll position');
   assert.equal(await remote.evaluate(()=>document.activeElement.id==='playback-sheet-collapse'),false,'Pointer opening does not move keyboard focus');
   assert.notEqual(await remote.locator('body').evaluate(e=>getComputedStyle(e).position),'fixed');
   assert.equal(await remote.locator('html').evaluate(e=>e.classList.contains('remote-modal-scroll-locked')),true);
   const sheet=await remote.locator('#playback-sheet-panel').evaluate(e=>({bottom:e.getBoundingClientRect().bottom,viewport:innerHeight,radius:getComputedStyle(e).borderBottomLeftRadius}));
   assert.equal(sheet.radius,'0px');assert.ok(Math.abs(sheet.bottom-sheet.viewport)<1,'Sheet meets viewport bottom');
   await assertBackdropPolicy(remote);
   await remote.mouse.move(12,150);await remote.mouse.wheel(0,200);await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before,'Backdrop cannot change the actual document scroll position');
   await remote.keyboard.press('PageDown');await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before,'Keyboard cannot scroll the background');
   await remote.setViewportSize({width:392,height:560});await settled(remote);
   const body=remote.locator('#playback-sheet-body');
   await body.evaluate(e=>e.scrollTop=0);
   const bodyBox=await body.boundingBox();
   await remote.mouse.move(bodyBox.x+bodyBox.width/2,bodyBox.y+100);await remote.mouse.wheel(0,150);await settled(remote);
   await remote.waitForFunction(()=>document.querySelector('#playback-sheet-body').scrollTop>0);
   assert.ok(await body.evaluate(e=>e.scrollTop)>0,'The sheet remains scrollable');
   assert.equal(await remote.evaluate(()=>scrollY),before,'Internal scrolling cannot chain to the page');
   await body.evaluate(e=>e.scrollTop=0);
   await remote.setViewportSize({width:392,height:817});await settled(remote);
   const cache=remote.locator('#current-cache-state');
   assert.match(await cache.innerText(),/120(?:\.0)? MB \/ 200(?:\.0)? MB/,'Remote displays aggregate downloaded and total sizes');
   const normal=await cache.boundingBox();
   await remote.evaluate(()=>{state.retryActivityById['cache-ui'].observedAt=Date.now()/1000-10;syncCurrentCacheState(state.data.current_item)});
   assert.equal(await remote.locator('#current-cache-retry').isVisible(),true);
   assert.ok(normal.height<=30,'The ordinary progress text has no artificial 44px row');
   assert.ok((await cache.boundingBox()).height<=44,'Retry retains one compact touch-target row');
   await remote.evaluate(()=>{state.data.current_item.cache_activity_at=101;syncCurrentCacheState(state.data.current_item)});
   assert.equal(await remote.locator('#current-cache-retry').isVisible(),false,'Activity without a rounded percent change hides retry');
   const value=remote.locator('#remote-volume-value');await value.click();await settled(remote);
   const panel=remote.locator('.volume-adjust-popover[open]');
   const slider=await remote.locator('#remote-volume-slider').boundingBox(),popup=await panel.boundingBox();
   assert.ok(popup.y+popup.height<=slider.y+1 && slider.y-popup.y-popup.height<14,'Volume panel is directly above the slider');
   assert.ok(Math.abs(popup.x+popup.width-slider.x-slider.width)<35,'Volume panel aligns with the right thumb');
   const sheetScroll=await remote.locator('#playback-sheet-body').evaluate(e=>e.scrollTop);
   await remote.route('**/api/player/volume',async route=>{
    const percent=route.request().postDataJSON().volume_percent;
    const data=await remote.evaluate(percent=>({...state.data,player_settings:{...state.data.player_settings,volume_percent:percent},state_revision:(state.data.state_revision||0)+100}),percent);
    await route.fulfill({json:{ok:true,data}});
   });
   for(const [selector,expected] of [['[data-volume-step="10"]','110'],['[data-volume-reset]','100']]) {
    await panel.locator(selector).click();await remote.waitForFunction(()=>!document.querySelector('.volume-adjust-popover [aria-busy]'));
    assert.equal(await panel.locator('input').inputValue(),expected,'Volume action committed');
    assert.equal(await remote.locator('#playback-sheet-body').evaluate(e=>e.scrollTop),sheetScroll,'Volume writes keep the sheet position');
    assert.equal(await remote.evaluate(()=>scrollY),before);
   }
   await remote.unrouteAll({behavior:'wait'});
   await remote.mouse.move(8,140);await remote.mouse.wheel(0,200);await settled(remote);
   assert.equal(await remote.locator('#playback-sheet-body').evaluate(e=>e.scrollTop),sheetScroll,'Nested volume editor locks the sheet beneath it');
   assert.equal(await remote.evaluate(()=>scrollY),before,'Nested volume editor locks the page');
   await remote.screenshot({path:path.join(notes,'remote-volume-anchored.png')});
   await panel.locator('[data-volume-close]').click();await remote.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
   await assertBackdropPolicy(remote);
   await remote.screenshot({path:path.join(notes,'remote-cache-sheet.png')});
   await remote.locator('#playback-sheet-collapse').click();await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before,'Closing keeps root scroll position');
   await remote.setViewportSize({width:844,height:390});await settled(remote);
   const landscapeBefore=await remote.evaluate(()=>scrollY);
   await remote.locator('#playback-dock').click();await settled(remote);
   const landscape=await remote.locator('#playback-sheet-panel').evaluate(e=>({bottom:e.getBoundingClientRect().bottom,viewport:innerHeight,style:getComputedStyle(e).borderBottomLeftRadius,blur:getComputedStyle(e).backdropFilter}));
   assert.equal(landscape.style,'18px');assert.equal(landscape.blur,'blur(12px)');
   assert.ok(landscape.viewport-landscape.bottom>=8,'Landscape card stays inside its bottom margin');
   assert.equal(await remote.evaluate(()=>scrollY),landscapeBefore,'Landscape opening keeps scroll position');
   await remote.screenshot({path:path.join(notes,'remote-sheet-landscape.png')});
   await remote.locator('#playback-sheet-collapse').click();await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),landscapeBefore,'Landscape closing keeps scroll position');
   await remote.setViewportSize({width:392,height:817});await settled(remote);
  });
  await check('playbackSafeAreaAndCacheStability',async()=>{
   await remote.setViewportSize({width:390,height:844});
   await remote.evaluate(item=>{
    disconnectClient();const root=document.documentElement;
    root.style.setProperty('--remote-safe-area-top','47px');root.style.setProperty('--remote-safe-area-bottom','34px');
    state.data.current_item={...item,id:'safe-cache',display_title:'稳定标题',requester_name:'UI fixture',cache_status:'downloading',cache_progress:50,cache_activity_at:100};render();
   },items[0]);
   try {
    await remote.locator('#playback-dock').click();await settled(remote);
    const geometry=()=>remote.evaluate(()=>{
     const panel=document.querySelector('#playback-sheet-panel'),body=document.querySelector('#playback-sheet-body');
     const rect=panel.getBoundingClientRect(),style=getComputedStyle(panel);
     return {top:rect.top,left:rect.left,right:rect.right,bottom:rect.bottom,radius:style.borderBottomLeftRadius,
      bodyBottom:body.getBoundingClientRect().bottom,width:innerWidth,height:innerHeight};
    });
    let bounds=await geometry();assert.equal(bounds.radius,'18px');
    assert.ok(bounds.top>=47 && Math.abs(bounds.bottom-bounds.height)<1);
    assert.ok(bounds.bodyBottom<=bounds.height-34,'Controls stop above the empty bottom safe area');
    const measure=()=>remote.evaluate(()=>Object.fromEntries(['current-title','current-owner','current-cache-state','player-control-panel'].map(id=>{
     const rect=document.getElementById(id).getBoundingClientRect();return [id,{top:rect.top,height:rect.height}];
    })));
    const downloading=await measure();
    assert.ok(Math.abs(downloading['current-cache-state'].height-downloading['current-owner'].height)<1,'Cache and UP use the same one-line height');
    await remote.screenshot({path:path.join(notes,'remote-safe-portrait-downloading.png')});
    await remote.evaluate(()=>{state.data.current_item.cache_status='ready';render();schedulePlaybackSheetAdaptiveLayout({force:true})});await settled(remote);
    const ready=await measure();
    for(const id of Object.keys(downloading)) {
     assert.ok(Math.abs(downloading[id].top-ready[id].top)<1,`${id}: completion keeps position`);
     assert.ok(Math.abs(downloading[id].height-ready[id].height)<1,`${id}: completion keeps height`);
    }
    assert.equal(await remote.locator('#current-cache-state').getAttribute('aria-hidden'),'true');
    await remote.screenshot({path:path.join(notes,'remote-safe-portrait-ready.png')});
    await remote.setViewportSize({width:844,height:390});
    await remote.evaluate(()=>{
     for(const [side,value] of Object.entries({top:0,right:47,bottom:21,left:47}))document.documentElement.style.setProperty(`--remote-safe-area-${side}`,`${value}px`);
     schedulePlaybackSheetAdaptiveLayout({force:true});
    });await settled(remote);
    bounds=await geometry();assert.equal(bounds.radius,'18px');
    assert.ok(bounds.left>=47 && bounds.right<=bounds.width-47 && bounds.top>=8 && bounds.bottom<=bounds.height-21,'Landscape card respects all four safe edges');
    await remote.screenshot({path:path.join(notes,'remote-safe-landscape.png')});
   } finally {
    await remote.evaluate(()=>{closePlaybackSheet({immediate:true,restoreFocus:false});for(const side of ['top','right','bottom','left'])document.documentElement.style.removeProperty(`--remote-safe-area-${side}`)});
    await remote.setViewportSize({width:392,height:817});await settled(remote);
   }
  });
  await check('desktopCompactLoginBaseline',async()=>{
   const original=host.viewportSize();let starts=0;
   const handler=async route=>{
    starts++;
    const data=await host.evaluate(()=>({...state.data,bbdown:{...state.data.bbdown,login:{state:'waiting',logged_in:false,message:'Offline QR fixture',qr_image:''}}}));
    await route.fulfill({json:{ok:true,data}});
   };
   await host.route('**/api/bbdown/login/start',handler);
   try {
    await host.setViewportSize({width:640,height:850});await settled(host);
    await host.evaluate(()=>{state.data.bbdown={...state.data.bbdown,login:{state:'idle',logged_in:false}};});
    await host.locator('[data-android-page="my"]').click();
    await host.waitForFunction(()=>!state.bbdownLoginRequesting && state.data.bbdown.login.state==='waiting');
    assert.equal(starts,1,'Opening desktop account controls prepares QR even at compact width');
    assert.equal(await host.locator('#bbdown-login-panel').isVisible(),true);
    await host.screenshot({path:path.join(notes,'desktop-compact-account.png')});
   } finally {await host.unroute('**/api/bbdown/login/start',handler);await host.setViewportSize(original);}
  });
  await check('hostPreviewParity',async()=>{
   await host.setViewportSize({width:1000,height:1100});
   await host.locator('#work-rail-request').click();
   await host.locator('[data-request-view="quick"]').click();
   await settled(host);
   const requestGap=await host.locator('.request-workspace-head').evaluate(e=>e.querySelector('h2').getBoundingClientRect().top-e.querySelector('.section-tag').getBoundingClientRect().bottom);
   await host.locator('#work-rail-users').click();await settled(host);
   const project=host.locator('#developer-mode-trigger');
   assert.equal(await project.isVisible(),true,'Desktop retains the project/admin entry');
   await host.evaluate(()=>{
    state.data.session_users=['Alice','Bob'];state.sessionUsersRenderSignature='';
    renderSessionUsers(state.data.session_users);
   });
   const badge=host.locator('.session-user-badge').first();
   assert.equal(await badge.getAttribute('draggable'),'true','Portrait desktop still supports mouse dragging');
   const metrics=await badge.evaluate(e=>{
    const n=e.querySelector('.session-user-name');return {height:e.offsetHeight,nameHeight:n.offsetHeight,bg:getComputedStyle(n).backgroundColor};
   });
   assert.equal(metrics.height,36);assert.equal(metrics.bg,'rgba(0, 0, 0, 0)');
   const userGap=await host.locator('#session-users-panel').evaluate(e=>e.querySelector('h2').getBoundingClientRect().top-e.querySelector('.section-tag').getBoundingClientRect().bottom);
   assert.ok(Math.abs(requestGap-userGap)<1,`Request ${requestGap}, users ${userGap}`);
   const box=await badge.boundingBox();await host.mouse.move(box.x+box.width/2,box.y+box.height/2);await host.mouse.down();
   await host.mouse.move(box.x+box.width/2+50,box.y+box.height/2+12,{steps:8});
   assert.equal(await badge.evaluate(e=>e.classList.contains('dragging')),true,'Dragging from the name starts the existing reorder flow');
   await host.keyboard.press('Escape');await host.mouse.up();
   await host.screenshot({path:path.join(notes,'host-preview-parity.png')});
  });
  await check('remoteTouchBackgroundLock',async()=>{
   if(browserName!=='chromium')return;
   await remote.route('**/api/player/volume',async route=>{
    const percent=route.request().postDataJSON().volume_percent;
    const data=await remote.evaluate(percent=>({...state.data,player_settings:{...state.data.player_settings,volume_percent:percent},state_revision:(state.data.state_revision||0)+100}),percent);
    await route.fulfill({json:{ok:true,data}});
   });
   await remote.locator('#playback-dock').click();await settled(remote);
   const before=await remote.evaluate(()=>scrollY);
   const session=await remoteContext.newCDPSession(remote);
   const swipe=async(x,y,dy)=>{
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=8;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+dy*i/8}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   };
   try {
    await swipe(8,120,-80);await settled(remote);
    assert.equal(await remote.evaluate(()=>scrollY),before,'Touching the backdrop cannot scroll the page');
    await remote.setViewportSize({width:392,height:560});await settled(remote);
    const body=remote.locator('#playback-sheet-body');await body.evaluate(e=>e.scrollTop=0);
    const box=await body.boundingBox();await swipe(box.x+8,box.y+220,-120);
    await remote.waitForFunction(()=>document.querySelector('#playback-sheet-body').scrollTop>0);
    assert.equal(await remote.evaluate(()=>scrollY),before,'Touch scrolling stays inside the sheet');
    await remote.setViewportSize({width:392,height:817});await settled(remote);
    const slider=remote.locator('#remote-volume-slider');const range=await slider.boundingBox();
    const x=range.x+range.width-10,y=range.y+range.height/2;
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=8;i++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-i*10,y}]});
    assert.ok(Number(await slider.inputValue())<90,'The scroll lock preserves native touch range dragging');
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await remote.evaluate(()=>scrollY),before,'Adjusting the slider cannot move the background');
   } finally {
    await session.detach();await remote.unrouteAll({behavior:'wait'});
    await remote.setViewportSize({width:392,height:817});
    await remote.locator('#playback-sheet-collapse').click();await settled(remote);
   }
  });
  await check('remoteBackdropMotion',async()=>{
   const sample=async closing=>remote.evaluate(async({item,closing})=>{
    if(closing)document.querySelector('.song-detail-close').click();
    else searchDetailController.open(item);
    const backdrop=document.querySelector('.song-detail-backdrop');
    getComputedStyle(backdrop).backdropFilter;
    const animation=backdrop.getAnimations().find(a=>a.animationName===`remote-backdrop-${closing?'out':'in'}`);
    if(!animation)return null;
    animation.pause();animation.currentTime=100;
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const style=getComputedStyle(backdrop);
    const result={blur:style.backdropFilter,opacity:Number(style.opacity)};
    animation.finish();animation.cancel();return result;
   },{item:items[0],closing});
   for(const closing of [false,true]) {
    const frame=await sample(closing);
    assert.ok(frame && frame.blur==='none' && frame.opacity>0 && frame.opacity<1,`Dimming ${closing?'exit':'entry'} has an intermediate frame: ${JSON.stringify(frame)}`);
    await settled(remote);
   }
   await remote.emulateMedia({reducedMotion:'reduce'});
   await remote.evaluate(item=>searchDetailController.open(item),items[0]);await settled(remote);
   assert.equal(await remote.locator('.song-detail-backdrop').evaluate(e=>getComputedStyle(e).animationDuration),'0.001s');
   await remote.locator('.song-detail-close').click();await settled(remote);
   await remote.emulateMedia({reducedMotion:'no-preference'});
  });
  await check('remoteModalBackgroundLock',async()=>{
   await remote.evaluate(()=>window.scrollTo(0,130));const before=await remote.evaluate(()=>scrollY);
   await remote.evaluate(item=>searchDetailController.open(item),items[0]);await settled(remote);
   assert.notEqual(await remote.locator('body').evaluate(e=>getComputedStyle(e).position),'fixed');
   assert.equal(await remote.locator('html').evaluate(e=>e.classList.contains('remote-modal-scroll-locked')),true);
   await assertBackdropPolicy(remote);
   await remote.mouse.move(8,140);await remote.mouse.wheel(0,300);await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before);
   await remote.evaluate(()=>{
    const update=document.createElement('div');update.id='modal-background-update';update.style.height='80px';
    document.querySelector('.remote-shell').prepend(update);
   });await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before,'Background content updates cannot scroll-anchor the page behind a modal');
   await remote.evaluate(()=>document.getElementById('modal-background-update').remove());await settled(remote);
   await remote.screenshot({path:path.join(notes,'remote-detail-dim.png')});
   await remote.locator('.song-detail-close').click();await settled(remote);
   assert.equal(await remote.evaluate(()=>scrollY),before);
   assert.notEqual(await remote.locator('body').evaluate(e=>getComputedStyle(e).position),'fixed');
  });
  await check('remoteOtherModalScrollLocks',async()=>{
   const flows=[
    ['rename',()=>openRemoteIdentityRename(),'.remote-identity-card',()=>closeRemoteIdentityRename()],
    ['export',()=>openHistoryExportDialog(),'.history-export-dialog',()=>closeHistoryExportDialog({restoreFocus:false})],
    ['rating',item=>{state.data.session_played.push({...item,item_id:'ui-scroll-rating',threshold_reached:true});openRatingPrompt({...item,id:'ui-scroll-rating'},{manual:true});},'.rating-card',()=>closeRatingPrompt({submit:false,restoreFocus:false})],
    ['pool',()=>openPoolConfigSheet(),'#gatcha-pool-config-sheet .binding-sheet-panel',()=>closePoolConfigSheet()],
   ];
   for(const [name,open,selector,close] of flows) {
    await remote.evaluate(()=>window.scrollTo(0,130));const before=await remote.evaluate(()=>scrollY);
    await remote.evaluate(open,items[0]);await settled(remote);
    try {
     const panel=remote.locator(selector);await panel.waitFor();
     assert.equal(await remote.evaluate(()=>scrollY),before,`${name}: opening preserves page position`);
     assert.equal(await panel.evaluate(e=>getComputedStyle(e).backdropFilter),'blur(12px)');
     await assertBackdropPolicy(remote);
     await remote.mouse.move(8,140);await remote.mouse.wheel(0,300);await settled(remote);
     assert.equal(await remote.evaluate(()=>scrollY),before,`${name}: background wheel is locked`);
     await remote.keyboard.press('PageDown');await settled(remote);
     assert.equal(await remote.evaluate(()=>scrollY),before,`${name}: background keyboard scrolling is locked`);
    } finally {await remote.evaluate(close);await settled(remote);}
    assert.equal(await remote.evaluate(()=>scrollY),before,`${name}: closing preserves page position`);
   }
  });
  await check('hostRatingPills',async()=>{
   await host.setViewportSize({width:1440,height:900});
   await host.evaluate(()=>document.documentElement.dataset.theme='light');
   await host.locator('#requester-select').selectOption({label:'UI fixture'});
   await host.locator('#work-rail-queue').click();
   await host.evaluate(item=>{
    const current={...item,id:'rating-ui',display_title:'当前歌曲 · 评分与切歌',requester_name:'UI fixture',cache_status:'pending'};
    renderQueueCurrent(current);renderCurrentRatingButton(current);
   },items[0]);
   const rating=host.locator('#open-rating-button'),next=host.locator('#next-button');
   const a=await rating.boundingBox(),b=await next.boundingBox();
   assert.ok(Math.abs(a.y-b.y)<1 && Math.abs(a.height-b.height)<1);
   assert.ok(b.x-a.x-a.width<=9);
   assert.equal(await rating.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
   await host.screenshot({path:path.join(notes,'host-rating-pills.png')});
   await host.evaluate(()=>renderPreparingHostPlaybackState({cache_status:'downloading',cache_message:'总计：120 B / 200 B\n视频P1：80 B / 100 B\n音轨P2：40 B / 100 B'}));
   assert.equal(await host.locator('.empty-hint').innerText(),'总计：120 B / 200 B\n视频P1：80 B / 100 B\n音轨P2：40 B / 100 B');
   assert.equal(await host.locator('.empty-hint').evaluate(e=>getComputedStyle(e).whiteSpace),'pre-line');
   await host.locator('.player-panel').screenshot({path:path.join(notes,'host-all-cache-tracks.png')});
  });
  await check('remoteReconnectsAfterDataReset',async()=>{
   assert.equal(await remote.evaluate(()=>state.remoteIdentity.registered),true);
   const reentered=remote.waitForEvent('framenavigated',{predicate:frame=>frame===remote.mainFrame(),timeout:7000});
   const reset=await host.evaluate(async()=>{
    const response=await fetch('/api/data/reset',{method:'POST',headers:clientHeaders({'Content-Type':'application/json'}),body:'{}'});
    return {status:response.status,payload:await response.json()};
   });
   assert.equal(reset.status,200);assert.equal(reset.payload.ok,true);
   await reentered;
   await remote.locator('#remote-identity-input').waitFor({state:'visible'});
   await remote.waitForFunction(()=>!state.remoteIdentityChecking);
   assert.equal(await remote.evaluate(()=>state.remoteIdentity.registered),false);
   await remote.locator('#remote-identity-input').fill('New session user');
   await remote.locator('#remote-identity-submit').click();
   await remote.waitForFunction(()=>state.remoteIdentity.registered && state.remoteIdentity.name==='New session user');
   measurements.remoteReconnectsAfterDataReset={reentered:true,reregistered:true};
  });
  await fs.writeFile(path.join(notes,'ui-results.json'),JSON.stringify({directory,measurements,failures,errors,calls,productionRequests:0},null,2));
  console.log(JSON.stringify({directory,measurements,failures,errors,calls,productionRequests:0},null,2));
  assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);assert.ok(calls.every(c=>c.method==='GET'));
 }finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await once(server,'exit');await new Promise(r=>fixture.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
