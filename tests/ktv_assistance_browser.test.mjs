// Real Rust Host, real browser DOM/QR reader, and authenticated real WebRTC.
// SDP routing and receiver XML are independent local fixtures, not TV/WeChat
// qualification. Browser-only iOS markers never qualify UIKit or physical Safari.
import assert from 'node:assert/strict';
import {test,before} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha,buildNativeHost} from './native_runtime_artifacts.mjs';
import {startHost,HttpClient,waitFor,roomQr,receiver,stream} from './ktv_assistance_support.mjs';
const qrcode=createRequire(import.meta.url)('../static/qrcode-generator.js');
const read=name=>readFileSync(path.join(root,'static',name),'utf8');
let desktop,alpha;before(async()=>{if(process.platform!=='linux')return;desktop=process.env.BILIKARA_TEST_NATIVE_HOST_BINARY||await buildNativeHost();alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();},{timeout:300000});
const evidence=process.env.BILIKARA_KTV_EVIDENCE;
async function settleLayout(page,scope='#purek-modal'){
  await page.evaluate(async scope=>{
    await document.fonts.ready;
    const root=document.querySelector(scope);
    // WebKit can retain unresolved transitions inside collapsed details. Only
    // rendered targets in the surface under measurement can affect its bounds.
    const relevant=document.getAnimations().filter(a=>{
      const target=a.effect?.target;
      return a.effect?.getTiming().iterations!==Infinity&&target&&root?.contains(target)
        &&target.checkVisibility?.({contentVisibilityAuto:true})!==false;
    });
    await Promise.allSettled(relevant.map(a=>a.finished));
    await new Promise(resolve=>requestAnimationFrame(resolve));
  },scope);
}
async function shot(page,name,scope='#purek-modal'){if(evidence){
  await settleLayout(page,scope);
  mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,name+'.png')});
}}
async function checkScannerGeometry(page) {
  await settleLayout(page);
  const g=await page.locator('#purek-modal').evaluate(modal=>{
    const card=modal.querySelector('.purek-card'),body=card.querySelector('.purek-body'),view=card.querySelector('.ktv-scan-view');
    const c=card.getBoundingClientRect(),b=body.getBoundingClientRect(),v=view.getBoundingClientRect(),h=card.querySelector('.selection-modal-head').getBoundingClientRect();
    const cs=getComputedStyle(card),ms=getComputedStyle(modal),vs=getComputedStyle(view),bs=getComputedStyle(body);
    const number=(style,key)=>parseFloat(style[key])||0;
    return {padding:['paddingTop','paddingRight','paddingBottom','paddingLeft'].map(k=>number(cs,k)),
      inner:number(vs,'borderTopLeftRadius'),
      axes:[b.left-c.left-number(cs,'borderLeftWidth'),c.right-b.right-number(cs,'borderRightWidth')],
      scanWidth:v.width,bodyWidth:body.clientWidth,headerGap:b.top-h.bottom,minHeight:number(vs,'minHeight'),height:v.height,
      overflow:bs.overflowY,top:c.top-number(ms,'paddingTop'),bottom:innerHeight-number(ms,'paddingBottom')-c.bottom,
      viewport:c.left>=0&&c.right<=innerWidth+1&&c.top>=0&&c.bottom<=innerHeight+1,
      targets:[...view.querySelectorAll('button')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return [r.width,r.height];})};
  });
  assert.deepEqual(g.padding,[20,20,20,20],'IOS-09-04 shared content axis');
  assert.ok(g.axes.every(n=>Math.abs(n-20)<1),JSON.stringify(g));
  assert.equal(g.inner,14,'IOS-09-04 scanner retains its approved role radius independently of the dialog corners');
  assert.ok(Math.abs(g.scanWidth-g.bodyWidth)<1&&g.headerGap>=11&&g.height>=g.minHeight-1,JSON.stringify(g));
  assert.equal(g.overflow,'auto');assert.equal(g.viewport,true);
  assert.ok(g.top>=-1&&g.bottom>=-1&&Math.abs(g.top-g.bottom)<2,'IOS-09-04 centers in the usable viewport after dock/safe-area/IME insets: '+JSON.stringify(g));
  assert.ok(g.targets.length&&g.targets.every(([w,h])=>w>=44&&h>=44),'scanner touch targets stay full size');
}
async function browserContext(t,engine,server,{host=false,ios=false,phone=false}={}){
  const browser=await engine.launch();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:host&&!phone?700:393,height:host&&!phone?700:844},hasTouch:true});
  if(host)await context.addCookies([...server.cookies].map(([name,value])=>({name,value,url:server.base})));
  await context.addInitScript(()=>{localStorage.setItem('bilikara.update.automatic','false');window.__ktvCameraCalls=0;if(navigator.mediaDevices?.getUserMedia){const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(...args)=>{__ktvCameraCalls++;return get(...args);};}});
  if(host&&phone&&!ios)await context.addInitScript(()=>{
    window.__unsafeDetectorCalls=0;
    window.BarcodeDetector=class{constructor(){window.__unsafeDetectorCalls++;throw Error('Unsafe embedded native QR provider');}};
  });
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==server.base)return route.abort();
    if(ios&&u.pathname==='/'){const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});}
    return route.continue();
  });return context;
}
for(const engine of [chromium,webkit])for(const platform of ['desktop','android','ios'])test(`${engine.name()} ${platform} Host shows supported scan routes and admits approved LAN invitations`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await startHost(t,platform==='desktop'?desktop:alpha,platform!=='desktop');
  const context=await browserContext(t,engine,server,{host:true,ios:platform==='ios',phone:platform!=='desktop'}),host=await context.newPage(),errors=[];
  const assistanceReads=[];host.on('request',r=>{if(new URL(r.url()).pathname==='/api/ktv/host')assistanceReads.push(r.method());});
  host.on('pageerror',e=>errors.push(e.message));await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
  await host.locator(platform==='desktop'?'#work-rail-settings':'[data-android-page="my"]').click();
  if(platform!=='desktop')await host.setViewportSize({width:320,height:844});
  const toolStyle=node=>{const s=getComputedStyle(node);return [s.height,s.minHeight,s.fontSize,s.fontWeight,s.borderRadius,s.paddingLeft,s.paddingRight,s.backgroundColor,s.color];};
  for(const [language,theme] of [['zh','light'],['en','dark'],['ja','blue']]){
    await host.evaluate(({language,theme})=>{setLanguage(language);applyTheme(theme);},{language,theme});
    await settleLayout(host,'#purek-settings');
    const scan=await host.locator('#purek-open').evaluate(toolStyle);
    // Compare rendered controls. WebKit can retain an old computed palette
    // for a reference inside a display:none mobile Settings page.
    if(platform!=='desktop'){
      await host.locator('#android-open-settings').click();
      await host.locator('#host-workspace-settings').waitFor({state:'visible'});
      await settleLayout(host,'#host-workspace-settings');
    }
    const reference=await host.locator('#diagnostic-copy-button').evaluate(toolStyle);
    if(platform!=='desktop'){
      await host.locator('#android-settings-back').click();
      await host.locator('#android-my-page').waitFor({state:'visible'});
      await settleLayout(host,'#android-my-page');
    }
    const styles={scan,reference};
    assert.deepEqual(styles.scan,styles.reference,'Scan entry reuses the full settings-tool style');
    assert.deepEqual(styles.scan.slice(0,7),['30px','30px','12px','700','999px','12px','12px']);
    const size=await host.locator('.purek-scan-tool').boundingBox();assert.ok(size.height>=44);
    assert.equal(await host.locator('#purek-open').evaluate(n=>getComputedStyle(n,'::before').height),'44px','theme borders must not shrink the hit region');
    {
      const geometry=await host.locator('.purek-settings-controls').evaluate(row=>{
        const a=row.querySelector('.purek-scan-tool').getBoundingClientRect(),b=row.querySelector('.media-output-targets').getBoundingClientRect(),r=row.getBoundingClientRect();
        return {centers:Math.abs(a.top+a.height/2-b.top-b.height/2),left:a.left-r.left,right:r.right-b.right,separate:a.right<=b.left,widths:[a.width,b.width,r.width]};
      });
      assert.ok(geometry.centers<1&&Math.abs(geometry.left)<1&&Math.abs(geometry.right)<1&&geometry.separate,JSON.stringify(geometry));
      const insets=await host.locator('#purek-settings').evaluate(card=>{const r=card.getBoundingClientRect(),h=card.querySelector('.purek-heading').getBoundingClientRect(),a=card.querySelector('.purek-settings-controls').getBoundingClientRect();return [h.top-r.top,r.bottom-a.bottom];});
      assert.ok(insets.every(value=>value>=14),JSON.stringify(insets));
    }
  }
  await host.evaluate(()=>{setLanguage('zh');applyTheme('light');});
  await host.locator('#purek-settings').scrollIntoViewIfNeeded();
  await shot(host,`settings-pill-${platform}-${engine.name()}`,'#purek-settings');
  const pill=await host.locator('#purek-open').boundingBox();
  await host.touchscreen.tap(pill.x+pill.width/2,pill.y-4);
  await host.locator(platform==='desktop'?'#ktv-host-empty':'#ktv-host-local-scan').waitFor({state:'visible'});
  assert.equal(await host.title(),'bilikara host');assert.equal(new URL(host.url()).origin,server.base);assert.equal(await host.locator('.app-shell').isVisible(),true);
  assert.equal(await host.locator('#ktv-host-local-scan').isVisible(),platform!=='desktop');
  assert.equal(await host.locator('#purek-url,#purek-camera,#purek-import,#purek-authorize').count(),0,'retired legacy acquisition is not reintroduced');
  assert.equal(await host.locator('.purek-remote-guide').count(),0);assert.equal(await host.locator('.purek-scan-tool').evaluate(n=>n.getBoundingClientRect().height>=44),true);
  assert.equal(await host.locator('#purek-dialog-title').textContent(),await host.evaluate(mobile=>t(mobile?'ktv.scan':'ktv.selectDevice'),platform!=='desktop'));
  assert.deepEqual(assistanceReads,platform==='desktop'?['GET']:[]);
  await host.locator('#purek-dialog-help').click();await host.locator('#purek-dialog-info').waitFor({state:'visible'});
  if(platform!=='desktop')assert.doesNotMatch(await host.locator('#purek-dialog-acquisition-help').innerText(),/Remote|招待|邀请/);
  await host.keyboard.press('Escape');assert.equal(await host.locator('#purek-modal').isVisible(),true);
  const client=new HttpClient(server.base);await client.request('/remote');await client.api('/api/remote-identity/register',{name:'Phone'});
  const rc=await browserContext(t,engine,server);await rc.addCookies([...client.cookies].map(([name,value])=>({name,value,url:server.base})));
  const remote=await rc.newPage();remote.on('pageerror',e=>errors.push(e.message));await remote.goto(server.base+'/remote');await remote.waitForFunction(()=>state.data&&state.eventSource&&window.BilikaraKtvRemote);
  if(platform==='desktop'){
    await host.locator('#ktv-host-devices button').waitFor();assert.match(await host.locator('#ktv-host-devices button').innerText(),/^Phone · (?:Local connection|本地连接|ローカル接続)$/);
    assert.equal(await host.locator('#ktv-host-devices button').isDisabled(),false);assert.equal(await host.locator('#ktv-host-empty').isVisible(),false);
  }else{
    assert.equal(await host.locator('#ktv-host-devices').isVisible(),false);
    assert.equal(await host.locator('#ktv-host-devices button').count(),0);
    assert.equal(await host.locator('#ktv-host-empty').isVisible(),false);
    assert.equal(await host.locator('#ktv-host-pair').isVisible(),false);
  }
  await shot(host,`chooser-lan-${platform}-${engine.name()}`);
  if(platform==='android')assert.equal(await host.evaluate(()=>__unsafeDetectorCalls),0,'Android startup never enters an optional JNI barcode provider');
  const oldConnection=(await server.api('/api/ktv/host')).devices[0].connection_id;
  if(platform==='desktop')await host.locator('#ktv-host-devices button').click();
  else await server.api('/api/ktv/host',{operation:'invite',connection_id:oldConnection});
  await remote.locator('#ktv-invitation').waitFor({state:'visible'});
  assert.equal(await remote.evaluate(()=>__ktvCameraCalls),0);
  await remote.locator('#ktv-accept').click();await remote.locator('#ktv-scanner').waitFor({state:'visible'});
  if(platform!=='desktop'){
    const radius=n=>getComputedStyle(n).borderTopLeftRadius;
    assert.deepEqual(await Promise.all([host.locator('#ktv-host-scan-view').evaluate(radius),remote.locator('#ktv-scan-view').evaluate(radius)]),['14px','14px'],'IOS-09-04 Host and Remote share the approved scanner radius');
  }
  assert.equal(await remote.evaluate(()=>__ktvCameraCalls),0,'an invitation/acceptance never starts the camera');
  assert.equal(await remote.locator('#ktv-session-status').isVisible(),false,'Host invitations need no redundant approval status');
  await remote.locator('#ktv-cancel-session').click();await remote.locator('#ktv-remote-modal').waitFor({state:'hidden'});
  await remote.evaluate(()=>{window.__returnNode=document.querySelector('#remote-menu-toggle');});
  await remote.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await remote.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await waitFor(async()=>(await server.api('/api/ktv/host')).devices.some(d=>d.connection_id===oldConnection),'valid LAN SSE survives a cached page return');
  assert.equal(await remote.evaluate(()=>window.__returnNode===document.querySelector('#remote-menu-toggle')),true);
  for(const language of['zh','en','ja']){
    await remote.evaluate(l=>setLanguage(l),language);await remote.setViewportSize({width:320,height:740});
    await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();
    assert.deepEqual(await remote.locator('#remote-menu-panel .remote-menu-section-toggle').evaluateAll(nodes=>nodes.map(n=>n.id)),['remote-qr-toggle','remote-settings-toggle','ktv-menu-toggle']);
    assert.equal(await remote.locator('#ktv-menu-scan').isDisabled(),false);assert.doesNotMatch(await remote.locator('#ktv-menu-guidance').innerText(),/HTTPS/);
    assert.equal(await remote.locator('#remote-menu-panel').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    await remote.keyboard.press('Escape');assert.equal(await remote.locator('#remote-menu-toggle').evaluate(n=>n===document.activeElement),true);
  }
  for(const size of[{width:393,height:844},{width:844,height:393}]){
    await remote.setViewportSize(size);await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();
    assert.equal(await remote.locator('#remote-menu-panel').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&n.scrollWidth<=n.clientWidth+1;}),true);
    await shot(remote,`menu-${size.width}-${platform}-${engine.name()}`,'#remote-menu-panel');await remote.keyboard.press('Escape');
  }
  await host.locator('#purek-close').click();assert.equal(await host.locator('#purek-open').evaluate(n=>n===document.activeElement),true);
  if(platform==='desktop'){
    await rc.close();
    await waitFor(async()=>(await server.api('/api/ktv/host')).devices.length===0,'the last Remote left');
    await host.locator('#purek-open').click();await host.locator('#ktv-host-pair').click();await host.locator('#purek-modal').waitFor({state:'hidden'});assert.equal(await host.locator('#purek-modal').isVisible(),false);
    assert.equal(await host.locator('#remote-mini-control').evaluate(n=>n?.classList.contains('is-qr-pinned')),true,'pairing uses the existing Host phone access menu');
  }
  assert.deepEqual(errors,[]);
});

for(const engine of [chromium,webkit])for(const platform of ['android','ios'])test(`${engine.name()} ${platform} Host scans local QR images without a Remote and retains official authorization checks`,
  {skip:process.platform!=='linux',timeout:90000},async t=>{
    const {server}=await startHost(t,alpha,true),tv=await receiver(t);
    const context=await browserContext(t,engine,server,{host:true,ios:platform==='ios',phone:true});
    const host=await context.newPage(),errors=[];host.on('pageerror',e=>errors.push(e.message));
    let pickerCalls=0;host.on('filechooser',async chooser=>{pickerCalls++;await chooser.setFiles([]);});
    await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
    await host.evaluate(()=>setLanguage('zh'));
    const live=await host.evaluate(track=>{
      if(!isSecureContext||typeof navigator.mediaDevices?.getUserMedia!=='function')return false;
      if(track)navigator.mediaDevices.getUserMedia=async()=>{__ktvCameraCalls++;throw new DOMException('denied','NotAllowedError');};
      return true;
    },engine===chromium);
    await host.locator('[data-android-page="my"]').click();await host.locator('#purek-open').click();
    await host.waitForFunction(()=>!document.querySelector('#purek-close').disabled);
    assert.equal(await host.locator('#ktv-host-local-scan').isVisible(),true);
    assert.equal(await host.locator('#ktv-host-photo,#ktv-host-photo-input').count(),0);
    assert.equal(await host.locator('#ktv-host-local-scan > .purek-assistance-actions').count(),0);
    assert.equal(await host.locator('#ktv-host-scan-view #ktv-host-import').getAttribute('aria-label'),'导入图片');
    assert.equal(await host.locator('#purek-cancel').isVisible(),false,'no orphan Cancel footer');
    assert.equal(await host.locator('#purek-settings [aria-describedby="purek-info"]').count(),1);
    assert.equal(await host.locator('[data-media-output="settings"] .media-output-help').count(),0);
    for(const size of [{width:393,height:844},{width:393,height:520},{width:844,height:393},{width:1024,height:768}]){
      await host.setViewportSize(size);await checkScannerGeometry(host);
    }
    await host.setViewportSize({width:393,height:844});
    if(live){
      // Observe WebKit's actual native denial, without relying on a replaced
      // WebIDL method surviving between browser tasks. Chromium also counts calls.
      await host.locator('#purek-error:not([hidden])').waitFor();
      assert.equal(await host.locator('#purek-error').innerText(),await host.evaluate(()=>t('ktv.error.camera_permission')));
      await checkScannerGeometry(host);
      assert.equal(pickerCalls,0);
      if(engine===chromium)assert.equal(await host.evaluate(()=>__ktvCameraCalls),1,'the outer Scan button opens the camera directly');
    }else assert.equal(pickerCalls,1,'the outer Scan button opens the system picker without live camera');
    await host.mouse.click(2,2);await host.locator('#purek-modal').waitFor({state:'hidden'});
    await host.locator('#purek-open').click();await host.waitForFunction(()=>!document.querySelector('#purek-close').disabled);
    await host.locator('#ktv-host-capture').click();if(live)await host.locator('#purek-error:not([hidden])').waitFor();else assert.ok(pickerCalls>=2);
    assert.equal(await host.locator('#ktv-host-import').isEnabled(),true,'permission denial retains image fallback');
    const image=raw=>{const code=qrcode(0,'M');code.addData(raw);code.make();return{name:'device.svg',mimeType:'image/svg+xml',buffer:Buffer.from(code.createSvgTag({cellSize:4,margin:24,scalable:false}))};};
    let release,entered;
    const held=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const hold=async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});};
    await host.route('**/api/purek/prepare',hold);
    await host.locator('#ktv-host-image-input').setInputFiles(image(roomQr(tv.base)));await held;
    await host.mouse.click(2,2);
    assert.equal(await host.locator('#purek-modal').isVisible(),true,'outside click cannot discard an in-flight prepare');
    assert.equal(await host.locator('#purek-close').isDisabled(),true);
    release();await host.locator('#ktv-host-authorization:not([hidden])').waitFor();await host.unroute('**/api/purek/prepare',hold);
    assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),roomQr(tv.base));
    assert.equal((await server.api('/api/purek/state')).connected,false,'decoding is not authorization');
    tv.state.deny=true;await host.locator('#purek-submit').click();await host.locator('#purek-error:not([hidden])').waitFor();
    assert.equal((await server.api('/api/purek/state')).connected,false,'official authorization denial cannot be bypassed');
    tv.state.deny=false;await host.locator('#purek-submit').click();await waitFor(async()=>(await server.api('/api/purek/state')).connected,'authorized fixture connected');
    await host.waitForFunction(()=>document.querySelector('#ktv-host-authorization-url').value==='');
    assert.equal(await host.locator('#purek-open').textContent(),await host.evaluate(()=>t('purek.manage')));
    assert.equal(await host.locator('#ktv-host-local-scan').isVisible(),false,'connected device management has no idle scanner');
    await host.locator('#purek-close').click();
    await host.locator('#purek-open').click();
    assert.equal(await host.locator('#purek-modal').isVisible(),true,'mobile management stays separate from the output switch');
    await host.locator('#purek-submit').click();await waitFor(async()=>!(await server.api('/api/purek/state')).connected,'Host management disconnect');
    await host.locator('#purek-close').click();
    await host.locator('#purek-open').click();await host.waitForFunction(()=>!document.querySelector('#purek-close').disabled);
    await host.waitForFunction(()=>document.querySelector('#purek-open').textContent===t('ktv.scan'));
    const authorizations=tv.state.actions.filter(a=>a==='SetDeviceAuthorization').length;
    await host.locator('#ktv-host-image-input').setInputFiles(image(tv.description));
    await host.waitForFunction(()=>state.data.purek.connection_type==='dlna'&&!document.querySelector('#purek-submit').disabled);
    assert.equal(await host.locator('#ktv-host-authorization').isVisible(),false);
    await host.locator('#purek-submit').click();await waitFor(async()=>(await server.api('/api/purek/state')).connected,'DLNA fixture connected');
    assert.equal(tv.state.actions.filter(a=>a==='SetDeviceAuthorization').length,authorizations,'DLNA does not perform Pure K registration');
    const lan=new HttpClient(server.base);await lan.request('/remote');
    assert.equal((await lan.request('/api/purek/prepare',{url:roomQr(tv.base)})).status,403);
    await shot(host,`local-host-scan-${platform}-${engine.name()}`);
    if(platform==='android')assert.equal(await host.evaluate(()=>__unsafeDetectorCalls),0,'Real image acquisition uses the bundled decoder without entering native JNI');
    assert.deepEqual(errors,[]);
  });

test('actual authenticated encrypted DataChannels carry local QR results, never photos or signaling credentials', {skip:process.platform!=='linux',timeout:180000},async t=>{
  const {server}=await startHost(t,desktop),tv=await receiver(t);
  let releaseHostRead;
  const browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});t.after(async()=>{releaseHostRead?.();for(const context of browser.contexts())for(const page of context.pages())await page.unrouteAll({behavior:'ignoreErrors'});await browser.close();});
  const hc=await browser.newContext({viewport:{width:700,height:700}}),rc=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
  await hc.addCookies([...server.cookies].map(([name,value])=>({name,value,url:server.base})));
  const errors=[],wire=[],httpBodies=[];
  for(const [context,host]of[[hc,true],[rc,false]]){
    await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
    await context.route('**/*',async route=>{
      const u=new URL(route.request().url());if(u.origin!==server.base){if(route.request().method()==='DELETE')return route.fulfill({status:204});return route.abort();}
      if(host&&u.pathname==='/internet-remote-host.js')return route.fulfill({contentType:'text/javascript',body:read('internet-remote-host.js').replace(/\}\)\(\);\s*$/,'window.__ktvHost={state,peers,createPeer,publishState};})();')});
      if(!host&&u.pathname==='/remote-transport-client.js')return route.fulfill({contentType:'text/javascript',body:read('remote-transport-client.js').replace(/\}\)\(globalThis\);\s*$/,'global.__ktvPeer={state,peerId,acceptOffer,request,resetPeer};})(globalThis);')});
      if(!host&&route.request().postData())httpBodies.push(route.request().postData());
      return route.continue();
    });
  }
  const host=await hc.newPage(),remote=await rc.newPage();for(const page of[host,remote])page.on('pageerror',e=>errors.push(e.message));
  await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.__ktvHost);
  await host.evaluate(()=>{window.__ktvOriginalMedia=[...document.querySelectorAll('audio,video')];});
  await rc.request.get(server.base+'/remote');
  await rc.addInitScript(()=>{Object.defineProperty(window,'BarcodeDetector',{configurable:true,value:undefined});});
  await remote.goto(server.base+'/remote#room='+'R'.repeat(27)+'&join='+'J'.repeat(43));await remote.waitForFunction(()=>window.__ktvPeer&&window.BilikaraKtvRemote);
  const pagesByPeer=new Map(),peerByPage=new Map(),signalBound=new Set();
  await host.exposeFunction('ktvSignal',async m=>{wire.push(m);const page=pagesByPeer.get(m.to);assert.ok(page,'exact SDP target');if(m.type==='offer')await page.evaluate(sdp=>__ktvPeer.acceptOffer(sdp),m.payload);if(m.type==='candidate')await page.evaluate(ice=>__ktvPeer.state.ice.addCandidate(ice),m.payload);});
  await host.evaluate(()=>{BilikaraInternetTransport.iceConfiguration={iceServers:[]};Object.assign(__ktvHost.state,{mode:'internet',stopped:false,roomId:'R'.repeat(27),hostToken:'H'.repeat(43),password:'fixture-password',socket:{readyState:1,close(){},send:wire=>void ktvSignal(JSON.parse(wire))}});});
  async function connect(page){
    const id=await page.evaluate(()=>__ktvPeer.peerId);pagesByPeer.set(id,page);peerByPage.set(page,id);
    if(!signalBound.has(page)){await page.exposeFunction('ktvSignal',async m=>{wire.push(m);const id=peerByPage.get(page);if(m.type==='answer')await host.evaluate(({id,payload})=>__ktvHost.peers.get(id).ice.setRemoteDescription(payload),{id,payload:m.payload});if(m.type==='candidate')await host.evaluate(({id,payload})=>__ktvHost.peers.get(id).ice.addCandidate(payload),{id,payload:m.payload});});signalBound.add(page);}
    await page.evaluate(()=>{BilikaraInternetTransport.iceConfiguration={iceServers:[]};Object.assign(__ktvPeer.state,{identity:'RTC phone',password:'fixture-password',socket:{readyState:1,close(){},send:wire=>void ktvSignal(JSON.parse(wire))}});});
    await host.evaluate(id=>__ktvHost.createPeer(id),id);
    try{await page.waitForFunction(()=>__ktvPeer.state.sessionReady&&state.data);}
    catch(error){
      // CI transport failures need stage/enum evidence, never SDP, ICE
      // addresses, room credentials or the authorization URL.
      const remoteStatus=await page.evaluate(()=>({ready:__ktvPeer.state.sessionReady,
        diagnostic:__ktvPeer.state.diagnostic?.snapshot(),last:__ktvPeer.state.lastDiagnostic}));
      const hostStatus=await host.evaluate(id=>{const peer=__ktvHost.peers.get(id);return{exists:!!peer,
        authorized:peer?.authorized,diagnostic:peer?.diagnostic.snapshot()};},id);
      throw new Error('Encrypted DataChannel handshake failed: '+JSON.stringify({remoteStatus,hostStatus,signals:wire.slice(-12).map(m=>m.type)}),{cause:error});
    }
    assert.equal(await page.evaluate(()=>__ktvPeer.state.peer.connectionState),'connected');return id;
  }
  const firstId=await connect(remote),other=await rc.newPage();other.on('pageerror',e=>errors.push(e.message));
  await other.goto(remote.url());await other.waitForFunction(()=>window.__ktvPeer&&window.BilikaraKtvRemote);const otherId=await connect(other);
  assert.notEqual(firstId,otherId,'two same-origin tabs must not share the old localStorage endpoint');
  await remote.evaluate(()=>{
    window.__ktvRealFetch=window.fetch;let release;const gate=new Promise(resolve=>{release=resolve;});window.__releaseKtvReply=release;
    window.fetch=async(...args)=>{const response=await __ktvRealFetch(...args);let operation;try{operation=JSON.parse(args[1]?.body||'{}').request?.operation;}catch{}
      if(operation==='ktv.scan.request'){window.__ktvReplyHeld=true;await gate;}return response;};
  });
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();
  await remote.waitForFunction(()=>window.__ktvReplyHeld);assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>n.open),false);
  await remote.evaluate(()=>{
    // Authentication and the KTV identity/capability projection are separate
    // messages. Delay only actual capable frames to verify both phases.
    const ktv=BilikaraKtvRemote,held=[];window.__heldKtvPresence=held;
    window.BilikaraKtvRemote={...ktv,presence(next){if(next.capabilities?.scan===true)held.push(next);else ktv.presence(next);}};
    window.__releaseKtvPresence=()=>{window.BilikaraKtvRemote=ktv;for(const next of held.splice(0))ktv.presence(next);};
    __ktvPeer.resetPeer();
  });
  assert.equal(await remote.locator('#ktv-menu-scan').getAttribute('aria-busy'),null,'disconnect clears the pending action before reconnecting');
  await connect(remote);
  await remote.waitForFunction(()=>__heldKtvPresence.length>0);
  assert.equal(await remote.locator('#ktv-menu-scan').isEnabled(),false,'a live connection must not bypass pending identity capabilities');
  assert.equal(await remote.locator('#ktv-menu-scan').getAttribute('aria-busy'),null);
  await remote.evaluate(()=>__releaseKtvPresence());
  await remote.waitForFunction(()=>document.querySelector('#ktv-room-status').textContent.includes(t('ktv.internet'))&&!document.querySelector('#ktv-menu-scan').disabled);
  assert.equal(await remote.locator('#ktv-menu-scan').isEnabled(),true,'disconnect before the dialog opens must release its busy guard');
  assert.equal(await remote.locator('#ktv-menu-scan').getAttribute('aria-busy'),null);
  await remote.evaluate(async()=>{__releaseKtvReply();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);window.fetch=__ktvRealFetch;});
  assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>n.open),false,'a retired request reply cannot reopen the replacement connection dialog');
  if(await remote.locator('#remote-menu-panel').isVisible())await remote.keyboard.press('Escape');
  if(await host.locator('#purek-modal').isVisible()){await host.locator('#purek-close').click();await host.locator('#purek-modal').waitFor({state:'hidden'});}
  const privateEvents=await server.api('/api/ktv/internet-events'),target=privateEvents.find(e=>e.peer_id===otherId).data;
  assert.equal((await server.api('/api/ktv/host')).devices.filter(d=>d.transport==='internet'&&d.name==='RTC phone').length,2);
  await other.evaluate(()=>openRemoteIdentityRename());await other.locator('#remote-identity-input').focus();
  await server.api('/api/ktv/host',{operation:'invite',connection_id:target.connection_id});await other.locator('#ktv-invitation:not([hidden])').waitFor();
  assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>n.open),false,'another same-name Internet tab receives no invitation');
  await other.locator('#ktv-remote-close').focus();await other.keyboard.press('Shift+Tab');
  assert.equal(await other.locator('#ktv-remote-modal .remote-info-button').evaluate(n=>n===document.activeElement),true);
  await other.keyboard.press('Shift+Tab');assert.equal(await other.locator('#ktv-accept').evaluate(n=>n===document.activeElement),true,'the older identity modal cannot steal the top dialog focus trap');
  await other.locator('#ktv-decline').click();await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='declined','targeted Internet decline');
  assert.equal(await other.locator('#remote-identity-input').evaluate(n=>n===document.activeElement),true);await other.locator('#remote-identity-cancel').click();
  await server.api('/api/ktv/host',{operation:'invite',connection_id:target.connection_id});await other.locator('#ktv-invitation:not([hidden])').waitFor();
  await other.locator('#ktv-remote-close').click();await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='declined','closing an invitation explicitly declines it');
  await server.api('/api/ktv/host',{operation:'invite',connection_id:target.connection_id});await other.locator('#ktv-invitation:not([hidden])').waitFor();
  await other.locator('#ktv-accept').click();await other.locator('#ktv-scanner:not([hidden])').waitFor();assert.equal(await other.locator('#ktv-camera-preview').evaluate(n=>n.srcObject),null,'accept opens the shared scanner without automatically activating the camera');
  const acceptedInvite=await server.api('/api/ktv/host');await server.api('/api/ktv/host',{operation:'cancel',request_id:acceptedInvite.session.request_id,host_epoch:acceptedInvite.host_epoch});
  await other.waitForFunction(()=>document.querySelector('#ktv-scanner').hidden);await other.locator('#ktv-remote-close').click();
  assert.equal(await remote.title(),'bilikara remote');
  // A GET captured before the Remote request must not overwrite its newer SSE.
  const hostReadGate=new Promise(resolve=>{releaseHostRead=resolve;});let hostReadHeld=false,hostReadDelivered=false;
  await host.route('**/api/ktv/host',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();hostReadHeld=true;await hostReadGate;await route.fulfill({response});hostReadDelivered=true;});
  await host.locator('#work-rail-settings').click();await host.locator('#purek-open').click();await waitFor(()=>hostReadHeld,'old Host read captured');
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();
  await host.locator('#ktv-host-approve:not([hidden])').waitFor();releaseHostRead();await waitFor(()=>hostReadDelivered,'old Host read delivered');await host.unroute('**/api/ktv/host');assert.equal(await host.locator('#ktv-host-approve').isVisible(),true);await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-scanner:not([hidden])').waitFor();
  for(const language of['zh','en','ja']){
    await remote.evaluate(l=>setLanguage(l),language);await remote.setViewportSize({width:320,height:740});
    assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&n.scrollWidth<=n.clientWidth+1;}),true,`${language} scanner fits a 320px viewport`);
  }
  await remote.evaluate(()=>setLanguage('zh'));await remote.setViewportSize({width:393,height:844});
  await remote.evaluate(()=>{window.__originalGum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Denied by test','NotAllowedError'));});
  await remote.locator('#ktv-camera').click();await remote.locator('#ktv-remote-error:not([hidden])').waitFor();assert.equal(await remote.locator('#ktv-import').isEnabled(),true);assert.equal(await remote.locator('#ktv-photo').count(),0);
  await remote.evaluate(()=>{navigator.mediaDevices.getUserMedia=__originalGum;});
  await remote.locator('#ktv-camera').click();await remote.waitForFunction(()=>document.querySelector('#ktv-camera-preview').srcObject?.getVideoTracks().length===1);
  await remote.waitForFunction(()=>!document.querySelector('#ktv-camera').hasAttribute('aria-busy')&&!document.querySelector('#ktv-import').disabled);
  await shot(remote,'scanner-live-camera','#ktv-remote-modal');
  await remote.evaluate(()=>{window.__cameraTrack=document.querySelector('#ktv-camera-preview').srcObject.getVideoTracks()[0];});
  const acceptedBeforeBackground=(await server.api('/api/ktv/host')).session.request_id;
  await remote.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await remote.evaluate(()=>__cameraTrack.readyState),'ended');
  await remote.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
  assert.equal(await remote.locator('#ktv-camera-preview').evaluate(n=>n.srcObject),null,'foreground restoration never reopens the camera');
  assert.equal((await server.api('/api/ktv/host')).session.request_id,acceptedBeforeBackground);assert.equal((await server.api('/api/ktv/host')).session.status,'accepted');
  await remote.locator('#ktv-camera').click();await remote.waitForFunction(()=>document.querySelector('#ktv-camera-preview').srcObject?.getVideoTracks().length===1);
  await remote.waitForFunction(()=>!document.querySelector('#ktv-camera').hasAttribute('aria-busy')&&!document.querySelector('#ktv-import').disabled);
  await remote.evaluate(()=>{window.__cameraTrack=document.querySelector('#ktv-camera-preview').srcObject.getVideoTracks()[0];});
  const code=qrcode(0,'M');code.addData(roomQr(tv.base));code.make();const svg=Buffer.from(code.createSvgTag({cellSize:4,margin:24,scalable:false}));
  // No BarcodeDetector: the actual pinned fallback must decode these pixels.
  await remote.evaluate(()=>{window.__qrReads=0;const decode=window.jsQR;window.jsQR=(...args)=>{__qrReads++;return decode(...args);};});
  await remote.locator('#ktv-image-input').setInputFiles({name:'room.svg',mimeType:'image/svg+xml',buffer:svg});
  await remote.waitForFunction(()=>!document.querySelector('#ktv-authorization').hidden||!document.querySelector('#ktv-remote-error').hidden);
  assert.equal(await remote.locator('#ktv-remote-error').isVisible(),false,await remote.locator('#ktv-remote-error').textContent());
  await remote.locator('#ktv-authorization:not([hidden])').waitFor();assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),roomQr(tv.base));
  assert.ok(await remote.evaluate(()=>__qrReads)>=1);
  assert.equal(await remote.evaluate(()=>__cameraTrack.readyState),'ended','image import stops the actual synthetic camera track');
  assert.equal(await remote.locator('#ktv-open-wechat').isVisible(),false);assert.match(await remote.locator('#ktv-wechat-help').innerText(),/微信|WeChat/);
  await shot(remote,'official-authorization-instructions','#ktv-remote-modal');
  const staged=(await server.api('/api/ktv/host')).session,stagedConnection=staged.connection_id,actionsBeforeReturn=[...tv.state.actions];
  await remote.evaluate(()=>{window.__returnNode=document.querySelector('#remote-menu-toggle');window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));});
  assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>n.open),false);assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),'');
  assert.equal((await server.api('/api/ktv/host')).session.status,'authorization_pending','cached navigation does not cancel a live authenticated grant');
  await remote.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await remote.waitForFunction(()=>__ktvPeer.state.sessionReady);assert.equal(await remote.evaluate(()=>__returnNode===document.querySelector('#remote-menu-toggle')),true);
  assert.equal(await remote.locator('#ktv-remote-modal').evaluate(n=>n.open),false,'restoration never reopens the scanner or authorization modal');
  assert.deepEqual(tv.state.actions,actionsBeforeReturn,'restoration does not automatically verify authorization');
  assert.equal((await server.api('/api/ktv/host')).session.connection_id,stagedConnection);
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();await remote.locator('#ktv-check:not([hidden])').waitFor();
  assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),'');await remote.locator('#ktv-load-authorization').click();await remote.waitForFunction(()=>document.querySelector('#ktv-authorization-url').value.length>0);
  assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),roomQr(tv.base));assert.deepEqual(tv.state.actions,actionsBeforeReturn);
  // A new authenticated connection has no inherited authority, even in the same
  // tab and under the same registered username. Rebinding needs a distinct grant.
  await remote.evaluate(()=>__ktvPeer.resetPeer());await waitFor(async()=>(await server.api('/api/ktv/host')).recovery.available,'lost connection parks a bounded candidate');
  await connect(remote);await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-resume:not([hidden])').waitFor();
  assert.equal(await remote.locator('#ktv-check').isVisible(),false);assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),'');assert.deepEqual(tv.state.actions,actionsBeforeReturn);
  await remote.locator('#ktv-menu-resume').click();await host.locator('#ktv-host-approve:not([hidden])').waitFor();
  assert.equal((await server.api('/api/ktv/host')).session.kind,'resume');assert.equal(await host.locator('#ktv-host-approve').innerText(),await host.evaluate(()=>t('ktv.approveResume')));
  assert.equal(await remote.locator('#ktv-check').isVisible(),false);await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-check:not([hidden])').waitFor();
  assert.notEqual((await server.api('/api/ktv/host')).session.connection_id,stagedConnection);assert.deepEqual(tv.state.actions,actionsBeforeReturn,'Host resume approval does not register the receiver');
  await remote.locator('#ktv-load-authorization').click();await remote.waitForFunction(()=>document.querySelector('#ktv-authorization-url').value.length>0);
  // UA fixture checks the conditional official-link boundary, not WeChat launch.
  await remote.evaluate(()=>{const original=navigator.userAgent;Object.defineProperty(navigator,'userAgent',{configurable:true,value:original+' MicroMessenger'});document.dispatchEvent(new Event('bilikara:i18n'));});
  assert.equal(await remote.locator('#ktv-open-wechat').isVisible(),true);assert.equal(await remote.locator('#ktv-open-wechat').getAttribute('href'),roomQr(tv.base));
  tv.state.deny=true;await remote.locator('#ktv-check').click();await remote.locator('#ktv-remote-error:not([hidden])').waitFor();assert.equal((await server.api('/api/purek/state')).connected,false);
  tv.state.deny=false;await remote.locator('#ktv-check').click();await waitFor(async()=>(await server.api('/api/purek/state')).connected,'real Host registration verified');
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='completed','Host completes authorization and its capability probe');
  const verifiedRoom=(await server.api('/api/internet-remote/state')).ktv_room.status;
  await remote.waitForFunction(status=>document.querySelector('#ktv-session-status').textContent===t(`ktv.room.${status}`),verifiedRoom);
  await remote.waitForFunction(()=>document.querySelector('#ktv-check').hidden);assert.equal(await remote.locator('#ktv-remote-error').isVisible(),false,'successful authoritative retry clears the previous authorization failure');
  assert.ok(tv.state.actions.includes('GetProtocolInfo'));assert.ok(tv.state.descriptions>=3);
  // An actual probe response is held after real receiver I/O. Busy state must
  // survive SSE/localization; older snapshots must not restore that busy state.
  let releaseProbe;const heldProbe=new Promise(resolve=>{releaseProbe=resolve;});t.after(()=>releaseProbe());
  const beforeProbe=await server.api('/api/purek/state');
  await host.route('**/api/purek/output/probe',async route=>{const response=await route.fetch();await heldProbe;await route.fulfill({response});});
  await host.locator('#purek-probe').click();await host.waitForFunction(()=>document.querySelector('#purek-probe').getAttribute('aria-busy')==='true');
  await host.evaluate(()=>setLanguage('ja'));assert.equal(await host.locator('#purek-probe').isDisabled(),true);
  assert.match(await host.locator('#purek-probe').innerText(),/処理中/);releaseProbe();
  await host.waitForFunction(()=>!document.querySelector('#purek-probe').hasAttribute('aria-busy'));
  await host.evaluate(old=>BilikaraPureK.sync(old),{...beforeProbe,busy:true});assert.equal(await host.locator('#purek-probe').isDisabled(),false);
  assert.equal(await host.evaluate(()=>__ktvOriginalMedia.every((node,i)=>node===document.querySelectorAll('audio,video')[i])),true);
  assert.ok(!JSON.stringify(wire).includes('projection_url'));assert.ok(!JSON.stringify(wire).includes('synthetic-ktv-private'));
  assert.ok(!httpBodies.some(body=>body.includes('projection_url')||body.includes('synthetic-ktv-private')||body.includes('pixels')));
  assert.equal(await remote.evaluate(()=>[...Array(localStorage.length)].map((_,i)=>localStorage.getItem(localStorage.key(i))).some(v=>v?.includes('projection_url'))),false);
  await remote.locator('#ktv-remote-close').click();await server.api('/api/purek/disconnect',{});tv.state.actions=[];
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();
  await host.locator('#ktv-host-approve:not([hidden])').waitFor();await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-scanner:not([hidden])').waitFor();
  await remote.locator('#ktv-advanced summary').click();await remote.locator('#ktv-room-url').fill('http://8.8.8.8/description.xml');await remote.locator('#ktv-submit-url').click();await remote.locator('#ktv-remote-error:not([hidden])').waitFor();
  assert.equal((await server.api('/api/purek/state')).room_name,null);
  await remote.locator('#ktv-room-url').fill(tv.description);await remote.locator('#ktv-submit-url').click();await remote.locator('#ktv-check:not([hidden])').waitFor();
  assert.equal(await remote.locator('#ktv-authorization').isVisible(),false,'ordinary DLNA has no WeChat step');await remote.locator('#ktv-check').click();
  await waitFor(async()=>(await server.api('/api/purek/state')).connected,'ordinary DLNA through the relocated input');
  assert.ok(tv.state.actions.includes('GetProtocolInfo'));assert.ok(!tv.state.actions.includes('SetDeviceAuthorization'));
  await remote.locator('#ktv-remote-close').click();await server.api('/api/purek/disconnect',{});tv.state.actions=[];
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();
  await host.locator('#ktv-host-approve:not([hidden])').waitFor();await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-scanner:not([hidden])').waitFor();
  await remote.locator('#ktv-room-url').fill(roomQr(tv.base));await remote.locator('#ktv-submit-url').click();await remote.locator('#ktv-authorization:not([hidden])').waitFor();
  let finishRegistration;tv.state.hold=new Promise(resolve=>{finishRegistration=resolve;});t.after(()=>finishRegistration());
  await remote.locator('#ktv-check').click();await waitFor(()=>tv.state.actions.includes('SetDeviceAuthorization'),'actual DataChannel check reaches gated SOAP');
  await remote.locator('#ktv-cancel-session').click();
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='canceled','Remote cancellation must reach Rust before the blocked SOAP check completes',4000);
  assert.equal((await server.api('/api/purek/state')).busy,true,'cancel retains the actual pending I/O lease');
  tv.state.hold=null;finishRegistration();await waitFor(async()=>!(await server.api('/api/purek/state')).busy,'canceled DataChannel verification rolls back');
  assert.equal(tv.state.authorized,false);assert.equal((await server.api('/api/purek/state')).connected,false);
  const canceledActions=[...tv.state.actions];
  await other.locator('#remote-menu-toggle').click();await other.locator('#ktv-menu-toggle').click();await other.locator('#ktv-menu-scan').click();
  await host.locator('#ktv-host-approve:not([hidden])').waitFor();await host.locator('#ktv-host-approve').click();await other.locator('#ktv-scanner:not([hidden])').waitFor();
  assert.equal(await other.locator('#ktv-check').isVisible(),false,'fresh same-user approval must scan rather than reuse the canceled candidate');
  const rejected=await other.evaluate(async()=>{
    const {data:current}=await __ktvPeer.request('ktv.status.get',{});
    try{await __ktvPeer.request('ktv.authorization.check',{request_id:current.session.request_id,host_epoch:current.host_epoch});return null;}
    catch(error){return error.code;}
  });assert.equal(rejected,'ktv_scan_required');
  assert.deepEqual(tv.state.actions,canceledActions,'rejected fresh-tab check cannot register the old room');await other.locator('#ktv-cancel-session').click();
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='canceled','fresh scan canceled');
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-scan').click();
  await host.locator('#ktv-host-approve:not([hidden])').waitFor();await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-scanner:not([hidden])').waitFor();
  await remote.locator('#ktv-room-url').fill(roomQr(tv.base));await remote.locator('#ktv-submit-url').click();await remote.locator('#ktv-authorization:not([hidden])').waitFor();
  const actionsBeforeNavigation=[...tv.state.actions];
  // A real document replacement runs non-persisted pagehide, retires the old
  // connection and erases all document-held private data. Identity is not consent.
  await remote.reload({waitUntil:'domcontentloaded'});await remote.waitForFunction(()=>window.__ktvPeer&&window.BilikaraKtvRemote);
  await waitFor(async()=>(await server.api('/api/ktv/host')).recovery.available,'actual navigation retires the original grant');
  assert.notEqual(await connect(remote),firstId,'a restored username cannot reuse the old document endpoint');
  await remote.locator('#remote-menu-toggle').click();await remote.locator('#ktv-menu-toggle').click();await remote.locator('#ktv-menu-resume:not([hidden])').waitFor();
  assert.equal(await remote.locator('#ktv-camera-preview').evaluate(n=>n.srcObject),null);assert.equal(await remote.locator('#ktv-check').isVisible(),false);
  assert.equal(await remote.locator('#ktv-authorization-url').inputValue(),'');assert.deepEqual(tv.state.actions,actionsBeforeNavigation);
  await remote.locator('#ktv-menu-resume').click();await host.locator('#ktv-host-approve:not([hidden])').waitFor();await host.locator('#ktv-host-approve').click();await remote.locator('#ktv-check:not([hidden])').waitFor();
  assert.deepEqual(tv.state.actions,actionsBeforeNavigation,'navigation and explicit resume never replay a receiver check');await remote.locator('#ktv-cancel-session').click();
  assert.ok(!JSON.stringify(wire).includes('projection_url'));assert.ok(!JSON.stringify(wire).includes('synthetic-ktv-private'));
  assert.ok(!httpBodies.some(body=>body.includes('projection_url')||body.includes('synthetic-ktv-private')||body.includes('pixels')));
  assert.equal(await remote.evaluate(()=>[localStorage,sessionStorage].some(storage=>[...Array(storage.length)].some((_,i)=>/projection_url|synthetic-ktv-private/.test(storage.getItem(storage.key(i))||'')))),false);
  assert.deepEqual(errors,[]);await shot(remote,'internet-qr-authorized','#ktv-remote-modal');
});

// Android's runtime permission Activity briefly hides the WebView while getUserMedia is pending
// (android-camera-repro.md). Real Host DOM, real MediaStream tracks; only the permission result
// and the visibility transition are scripted, since desktop engines show no permission Activity.
async function cameraHarness(context){
  await context.addInitScript(()=>{
    window.__gum={calls:0,pending:[],streams:[]};
    if(!navigator.mediaDevices)Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{}});
    navigator.mediaDevices.getUserMedia=()=>{__gum.calls++;return new Promise((resolve,reject)=>__gum.pending.push({resolve,reject}));};
    window.__liveStream=()=>{const c=document.createElement('canvas');c.width=64;c.height=48;c.getContext('2d').fillRect(0,0,64,48);const s=c.captureStream(5);__gum.streams.push(s);return s;};
    window.__setHidden=hidden=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    };
    window.__trackStates=()=>__gum.streams.map(s=>s.getTracks().map(track=>track.readyState).join());
  });
}
const preview=page=>page.evaluate(()=>{const v=document.querySelector('#ktv-host-camera-preview');return{hidden:v.hidden,attached:v.srcObject?__gum.streams.indexOf(v.srcObject):-1};});
const settled=page=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));

for(const engine of[chromium,webkit])test(`${engine.name()} Android Host keeps a camera permission request across the permission Activity and never holds a background camera`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await startHost(t,alpha,true);
  const context=await browserContext(t,engine,server,{host:true,phone:true});await cameraHarness(context);
  const host=await context.newPage(),errors=[];host.on('pageerror',e=>errors.push(e.message));
  await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
  await host.evaluate(()=>setLanguage('en'));
  assert.equal(await host.evaluate(()=>document.documentElement.dataset.hostPlatform),'android');
  // First permission grant: the dialog's transient hidden must not void the pending request.
  await host.locator('[data-android-page="my"]').click();await host.locator('#purek-open').click();
  await host.waitForFunction(()=>__gum.pending.length===1);
  await host.evaluate(()=>__setHidden(true));await settled(host);
  await host.evaluate(()=>__setHidden(false));await settled(host);
  assert.equal(await host.locator('#purek-error').isVisible(),false);
  await host.evaluate(()=>__gum.pending[0].resolve(__liveStream()));
  await host.waitForFunction(()=>!document.querySelector('#ktv-host-camera-preview').hidden);
  assert.deepEqual(await preview(host),{hidden:false,attached:0},'the first grant shows the preview without a second tap');
  assert.equal(await host.evaluate(()=>__gum.calls),1);
  assert.deepEqual(await host.evaluate(()=>__trackStates()),['live']);
  // A running camera is released as soon as the Host really goes to the background.
  await host.evaluate(()=>__setHidden(true));await settled(host);
  assert.deepEqual(await host.evaluate(()=>__trackStates()),['ended'],'background releases the running camera');
  assert.deepEqual(await preview(host),{hidden:true,attached:-1});
  await host.evaluate(()=>__setHidden(false));await settled(host);
  assert.equal(await host.evaluate(()=>__gum.calls),1,'returning to the foreground does not reopen the camera');
  // Denial after the permission Activity closes still reaches the original permission hint.
  await host.locator('#ktv-host-capture').click();await host.waitForFunction(()=>__gum.pending.length===2);
  await host.evaluate(()=>__setHidden(true));await settled(host);
  await host.evaluate(()=>__setHidden(false));
  await host.evaluate(()=>__gum.pending[1].reject(new DOMException('Permission denied','NotAllowedError')));
  await host.locator('#purek-error:not([hidden])').waitFor();
  assert.equal(await host.locator('#purek-error').innerText(),await host.evaluate(()=>t('ktv.error.camera_permission')));
  assert.equal(await host.locator('#ktv-host-import').isEnabled(),true,'denial keeps the image fallback');
  // A result that arrives while the Host is still in the background stops its tracks and is never mounted.
  await host.locator('#ktv-host-capture').click();await host.waitForFunction(()=>__gum.pending.length===3);
  await host.evaluate(()=>__setHidden(true));await settled(host);
  await host.evaluate(()=>__gum.pending[2].resolve(__liveStream()));await settled(host);
  assert.deepEqual(await host.evaluate(()=>__trackStates()),['ended','ended'],'a late background grant never holds the camera');
  assert.deepEqual(await preview(host),{hidden:true,attached:-1});
  await host.evaluate(()=>__setHidden(false));await settled(host);
  assert.deepEqual(await preview(host),{hidden:true,attached:-1},'no automatic reopen after returning');
  assert.equal(await host.evaluate(()=>__gum.calls),3);
  // Page retirement still cancels a pending request; its later stream is stopped.
  await host.locator('#ktv-host-capture').click();await host.waitForFunction(()=>__gum.pending.length===4);
  await host.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await host.evaluate(()=>__gum.pending[3].resolve(__liveStream()));await settled(host);
  assert.deepEqual(await host.evaluate(()=>__trackStates()),['ended','ended','ended'],'pagehide cancels the pending request');
  assert.deepEqual(errors,[]);
});

for(const engine of[chromium,webkit])test(`${engine.name()} iOS Host still stops a pending camera request when hidden`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await startHost(t,alpha,true);
  const context=await browserContext(t,engine,server,{host:true,phone:true,ios:true});await cameraHarness(context);
  const host=await context.newPage(),errors=[];host.on('pageerror',e=>errors.push(e.message));
  await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
  assert.equal(await host.evaluate(()=>document.documentElement.dataset.hostPlatform),'ios');
  await host.locator('[data-android-page="my"]').click();await host.locator('#purek-open').click();
  await host.waitForFunction(()=>__gum.pending.length===1);
  await host.evaluate(()=>__setHidden(true));await settled(host);
  await host.evaluate(()=>__setHidden(false));
  await host.evaluate(()=>__gum.pending[0].resolve(__liveStream()));await settled(host);
  assert.deepEqual(await host.evaluate(()=>__trackStates()),['ended'],'iOS keeps its hide-to-stop policy');
  assert.deepEqual(await preview(host),{hidden:true,attached:-1});
  assert.equal(await host.locator('#purek-error').isVisible(),false,'a canceled request is not reported as a denial');
  assert.deepEqual(errors,[]);
});

for(const engine of[chromium,webkit])test(`${engine.name()} Desktop explicitly retrieves Remote official links and rejects late or retired handoffs`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await startHost(t,desktop),tv=await receiver(t),client=new HttpClient(server.base);
  await client.request('/remote');await client.api('/api/remote-identity/register',{name:'授权手机'});
  const events=stream(client);t.after(()=>events.close());const presence=await events.ready();
  const send=(operation,fields={})=>client.api('/api/ktv/remote',{connection_id:presence.connection_id,request:{operation,...fields}});
  const context=await browserContext(t,engine,server,{host:true}),host=await context.newPage(),errors=[],reads=[];
  await context.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedOfficial=text;}}}));
  host.on('pageerror',error=>errors.push(error.message));
  host.on('request',r=>{if(new URL(r.url()).pathname==='/api/ktv/host'&&r.postDataJSON()?.operation==='authorization_link')reads.push(r.postDataJSON());});
  await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
  await host.locator('#work-rail-settings').click();
  const stage=async()=>{
    const requested=await send('ktv.scan.request'),binding={request_id:requested.session.request_id,host_epoch:requested.host_epoch};
    await host.locator('#ktv-host-approve:not([hidden])').click();
    await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='accepted','Host approval has committed before Remote submission');
    await send('ktv.scan.submit',{...binding,url:roomQr(tv.base)});
    await host.locator('#ktv-host-load-authorization:not([hidden])').waitFor();return binding;
  };
  const binding=await stage();
  assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),'');assert.equal(reads.length,0,'opening or receiving SSE never fetches the official link');
  assert.equal(await host.locator('#ktv-host-local-scan').isVisible(),false,'Desktop authorization is independent of the mobile scanner');
  await host.locator('#ktv-host-load-authorization').click();
  await host.locator('#ktv-host-copy-authorization:not([hidden])').waitFor();
  assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),roomQr(tv.base));assert.equal(reads.length,1);
  await host.locator('#ktv-host-copy-authorization').click();assert.equal(await host.evaluate(()=>__copiedOfficial),roomQr(tv.base),'clipboard API fixture receives the exact current link');
  assert.deepEqual(tv.state.actions,[],'copying does not authorize the independent receiver');
  await host.locator('#purek-close').click();assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),'');
  await host.locator('#purek-open').click();await host.locator('#ktv-host-load-authorization:not([hidden])').waitFor();assert.equal(reads.length,1,'reopening does not auto-read');
  await host.locator('#ktv-host-load-authorization').click();await host.locator('#ktv-host-copy-authorization:not([hidden])').waitFor();
  await send('ktv.scan.cancel',binding);await host.waitForFunction(()=>document.querySelector('#ktv-host-authorization-url').value==='');
  assert.equal(await host.locator('#ktv-host-authorization').isVisible(),false);
  const next=await stage();let release,entered;const gate=new Promise(r=>{release=r;}),held=new Promise(r=>{entered=r;});
  t.after(()=>release());
  await host.route('**/api/ktv/host',async route=>{
    if(route.request().method()!=='POST'||route.request().postDataJSON()?.operation!=='authorization_link')return route.continue();
    const response=await route.fetch();entered();await gate;await route.fulfill({response});
  });
  await host.locator('#ktv-host-load-authorization').click();await held;
  assert.equal(await host.locator('#ktv-host-load-authorization').getAttribute('aria-busy'),'true');
  await host.locator('#ktv-host-load-authorization').evaluate(n=>n.click());assert.equal(reads.length,3,'the pending read rejects duplicate activation');
  await send('ktv.scan.cancel',next);await host.waitForFunction(()=>state.data.ktv_assistance?.session?.status==='canceled');
  release();await host.waitForFunction(()=>!document.querySelector('#ktv-host-load-authorization').hasAttribute('aria-busy'));
  assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),'','late read cannot repopulate a canceled candidate');
  await host.unroute('**/api/ktv/host');await stage();tv.state.deny=true;
  let releaseCheck;tv.state.hold=new Promise(r=>{releaseCheck=r;});t.after(()=>releaseCheck());
  await host.locator('#purek-submit').click();
  await host.waitForFunction(()=>document.querySelector('#ktv-host-session').textContent===t('ktv.session.connecting')&&!document.querySelector('#purek-submit').hasAttribute('aria-busy'));
  assert.equal(await host.locator('#purek-submit').isDisabled(),true,'an acknowledged background check stays disabled until its terminal state');
  await host.locator('#purek-submit').evaluate(n=>n.click());
  await waitFor(()=>tv.state.actions.includes('SetDeviceAuthorization'),'the admitted worker reaches the independent receiver');
  assert.equal(tv.state.actions.filter(a=>a==='SetDeviceAuthorization').length,1,'a second activation cannot fall through to unbound room connection');
  tv.state.hold=null;releaseCheck();await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='error','actual Host-bound denial');
  await host.waitForFunction(()=>document.querySelector('#ktv-host-session').textContent===t('ktv.session.error')&&!document.querySelector('#purek-submit').disabled);tv.state.deny=false;
  await host.locator('#purek-submit').click();await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='completed','Host completes the same bound request');
  await host.waitForFunction(()=>state.data.purek.connected);
  assert.equal(await host.locator('#ktv-host-authorization-url').inputValue(),'');assert.equal(await host.locator('#ktv-host-authorization').isVisible(),false);
  assert.deepEqual(errors,[]);
});

for(const engine of[chromium,webkit])test(`${engine.name()} non-loopback HTTP LAN imports QR and pastes DLNA without live camera or Internet Remote`,{skip:process.platform!=='linux',timeout:120000},async t=>{
  const {server}=await startHost(t,desktop),tv=await receiver(t),ip=new URL(tv.base).hostname,lanBase=server.base.replace('127.0.0.1',ip);
  const client=new HttpClient(lanBase);await client.request('/remote');await client.api('/api/remote-identity/register',{name:'示例手机'});
  const browser=await engine.launch();t.after(()=>browser.close());const context=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
  await context.addCookies([...client.cookies].map(([name,value])=>({name,value,url:lanBase})));
  const bodies=[],errors=[];await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
  await context.route('**/*',route=>new URL(route.request().url()).origin===lanBase?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.postData())bodies.push(r.postData());});
  const hc=await browserContext(t,engine,server,{host:true}),host=await hc.newPage();host.on('pageerror',e=>errors.push(e.message));
  await host.goto(server.base);await host.waitForFunction(()=>state.hasValidStateResponse&&window.BilikaraPureK);
  await host.evaluate(()=>setLanguage('zh'));
  assert.equal(await host.locator('#purek-modal').isVisible(),false);
  await page.goto(lanBase+'/remote');await page.waitForFunction(()=>state.data&&state.eventSource&&window.BilikaraKtvRemote);assert.equal(await page.evaluate(()=>isSecureContext),false);
  await page.evaluate(()=>setLanguage('zh'));
  await page.locator('#remote-menu-toggle').click();await page.locator('#ktv-menu-toggle').click();
  await page.locator('#ktv-menu-scan').waitFor({state:'visible'});assert.equal(await page.locator('#ktv-menu-scan').isEnabled(),true);
  assert.doesNotMatch(await page.locator('#ktv-menu-guidance').innerText(),/HTTPS/);
  const approve=async()=>{
    const pending=await waitFor(async()=>{const x=await server.api('/api/ktv/host');return x.session?.status==='approval_pending'&&x;},'LAN request awaits explicit Host approval');
    assert.ok(pending.session.request_id);
    assert.equal(await page.locator('#ktv-scanner').isVisible(),false);
    await host.locator('#purek-modal').waitFor({state:'visible'});
    assert.equal(await host.locator("#ktv-host-reject").isVisible(),true);
    assert.equal(await host.locator("#ktv-host-cancel").isVisible(),false);
    await shot(host,`host-scan-approval-${engine.name()}`);
    await host.locator('#ktv-host-approve').click();
    await page.locator('#ktv-scanner').waitFor({state:'visible'});
    assert.equal(await page.locator('#ktv-camera').isEnabled(),true,'the unified action uses the system picker on HTTP');
    assert.equal(await page.locator('#ktv-photo,#ktv-camera-guidance').count(),0);
    assert.equal(await page.locator('#ktv-session-status').isVisible(),false,'Host approval is not repeated after acceptance');
    assert.deepEqual(await page.locator('#ktv-remote-modal > .ktv-actions > button:visible').allTextContents(),['取消本次协助','扫描二维码']);
    assert.equal(await page.locator('#ktv-import').isEnabled(),true);
    assert.equal(await page.locator('#ktv-menu-resume').isVisible(),false);
    await host.locator('#purek-close').click();
  };
  await page.locator('#ktv-menu-scan').click();await approve();
  assert.equal(await page.locator('#ktv-capture-input').getAttribute('capture'),'environment');
  await page.locator('#ktv-remote-modal .remote-info-button').click();
  await page.locator('#ktv-transport-info').waitFor({state:'visible'});
  assert.match(await page.locator('#ktv-secure-fallback').innerText(),/HTTP.*未加密/);
  await shot(page,`http-lan-help-${engine.name()}`,'#ktv-remote-modal');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#ktv-remote-modal').isVisible(),true);
  const code=qrcode(0,'M');code.addData(roomQr(tv.base));code.make();
  await shot(page,`scanner-http-lan-${engine.name()}`,'#ktv-remote-modal');
  assert.equal(await page.locator('#ktv-remote-title').innerText(),'投屏设备');
  assert.equal(await page.locator('#ktv-scan-view #ktv-import').getAttribute('aria-label'),'导入图片');
  assert.equal(await page.locator('#ktv-import').innerText(),'');
  assert.equal(await page.locator('.ktv-scan-reticle').count(),0);
  const gallery=await page.locator('#ktv-import').evaluate(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return [r.width,r.height,s.borderRadius];});
  assert.deepEqual(gallery,[44,44,'14px']);
  const choosing=page.waitForEvent('filechooser');
  await page.locator(engine===chromium?'#ktv-camera':'#ktv-import').click();
  await (await choosing).setFiles({name:'private-image.svg',mimeType:'image/svg+xml',buffer:Buffer.from(code.createSvgTag({cellSize:4,margin:24,scalable:false}))});
  await page.locator('#ktv-authorization').waitFor({state:'visible'});
  assert.equal(await page.locator('#ktv-authorization-url').inputValue(),roomQr(tv.base));
  assert.equal((await server.api('/api/purek/state')).connected,false);
  assert.equal((await client.request('/api/purek/prepare',{url:roomQr(tv.base)})).status,403);
  const projection=JSON.stringify(await client.api('/api/state'));
  assert.ok(!projection.includes('projection_url')&&!projection.includes('synthetic-ktv-private'));
  await page.locator('#ktv-check').click();await waitFor(async()=>(await server.api('/api/purek/state')).connected,'LAN authorized receiver check');
  await page.waitForFunction(()=>document.querySelector('#ktv-authorization-url').value==='');
  await shot(page,`http-lan-authorized-${engine.name()}`,'#ktv-remote-modal');
  await page.locator('#ktv-remote-close').click();
  await page.locator('#remote-menu-toggle').click();await page.locator('#ktv-menu-toggle').click();
  await page.locator('#ktv-menu-scan').waitFor({state:'hidden'});
  await host.locator('#work-rail-settings').click();await host.locator('#purek-open').scrollIntoViewIfNeeded();
  await host.waitForFunction(()=>document.querySelector('#purek-open').textContent===t('purek.disconnect'));
  await shot(host,`host-device-disconnect-${engine.name()}`);
  await host.locator('#purek-open').click();
  await page.locator('#ktv-menu-scan').waitFor({state:'visible'});
  assert.equal(await page.locator('#ktv-menu-scan').isEnabled(),true,'Host disconnect reopens the Remote entry through SSE');
  await page.locator('#ktv-menu-scan').click();await approve();
  await page.locator('#ktv-advanced').evaluate(n=>{n.open=true;});
  await page.locator('#ktv-room-url').fill(tv.description);
  const before=tv.state.actions.filter(x=>x==='SetDeviceAuthorization').length;
  await page.locator('#ktv-submit-url').click();await page.locator('#ktv-check').waitFor({state:'visible'});
  await page.locator('#ktv-check').click();await waitFor(async()=>(await server.api('/api/purek/state')).connected,'LAN pasted DLNA connects');
  assert.equal(tv.state.actions.filter(x=>x==='SetDeviceAuthorization').length,before);
  assert.ok(bodies.some(body=>body.includes('ktv.scan.submit')));
  assert.ok(bodies.every(body=>!body.includes('private-image.svg')&&!body.includes('pixels')&&!body.includes('image/svg')&&!body.includes('data:image')));
  assert.equal(await page.evaluate(()=>[localStorage,sessionStorage].some(storage=>Object.keys(storage).some(key=>/synthetic-ktv-private|projection_url/.test(storage.getItem(key)||'')))),false);
  assert.equal(await page.locator('#ktv-camera-preview').evaluate(n=>n.srcObject),null);assert.deepEqual(errors,[]);
});
