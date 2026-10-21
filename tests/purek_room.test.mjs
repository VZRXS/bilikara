import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {createRequire} from 'node:module';
import {historicChromium} from './historic_chromium_support.mjs';
const qrcode=createRequire(import.meta.url)('../static/qrcode-generator.js');
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {HttpClient, RunningHost, isolatedEnvironment} from './native_host_support.mjs';
let desktop, alpha;
before(async()=>{
  if(process.platform!=='linux')return;
  desktop=process.env.BILIKARA_TEST_NATIVE_HOST_BINARY||await buildNativeHost();
  alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
},{timeout:300000});
function qr(base='http://192.168.123.231',token='synthetic-only-secret'){
  const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',base);inner.searchParams.set('token',token);inner.searchParams.set('name','Fixture room');
  const outer=new URL('https://wx.chunk.cn/projection/login');outer.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));outer.searchParams.set('place_code','fixture');return outer.href;
}
async function host(t, android=false){
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const env=isolatedEnvironment(home);env.BILIKARA_CF_API_URL='';env.BILIKARA_CATALOG_SHEETS_URL='';
  const server=await RunningHost.start(android?alpha:desktop,home,android?[home,path.join(root,'static')]:['--headless','--port','0','--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],env,android);
  t.after(()=>server.close());return {server,home};
}
test('Pure K API is Host-only, validates offline, and never persists the room token',{skip:process.platform!=='linux',timeout:60000},async t=>{
  const {server,home}=await host(t);
  const anonymous=new HttpClient(server.base);assert.equal((await anonymous.request('/api/purek/state')).status,403);
  const remote=new HttpClient(server.base);await remote.request('/remote');
  assert.equal((await remote.request('/api/purek/state')).status,403);
  assert.equal((await remote.request('/api/purek/prepare',{qr_url:qr()})).status,403);
  assert.equal((await remote.request('/api/purek/output/probe',{})).status,403);
  assert.equal((await server.request('/api/purek/output/probe',{})).status,409);
  assert.equal((await server.request('/api/purek/output/probe',{control_url:'http://example.invalid'})).status,400);
  assert.equal((await server.api('/api/purek/state')).connected,false);
  const ordered=await server.api('/api/purek/state');
  assert.ok(Number.isSafeInteger(ordered.revision));assert.equal(typeof ordered.state_epoch,'string');
  const output=(await server.api('/api/purek/state')).output;
  assert.equal(output.schema_version,1);assert.equal(output.status,'stopped');
  assert.equal(output.target_room_id,null);assert.equal(output.pipeline_level,null);
  assert.equal(output.capabilities.supports_live_stream,false);
  for(const bad of [qr('http://127.0.0.1'),qr('http://8.8.8.8'),qr('http://169.254.169.254'),qr('http://public.example'),qr().replace('wx.chunk.cn','evil.example')]){
    const response=await server.request('/api/purek/prepare',{qr_url:bad});assert.equal(response.status,400);assert.ok(!response.body.includes(Buffer.from('synthetic-only-secret')));
  }
  const prepared=await server.api('/api/purek/prepare',{qr_url:qr()});assert.equal(prepared.room_name,'Fixture room');assert.equal(prepared.authorization_url,qr());
  const snapshot=await server.api('/api/state');assert.equal(snapshot.purek.room_name,'Fixture room');assert.equal(snapshot.purek.connected,false);
  assert.equal(snapshot.purek.auto_discovery,false);assert.ok(!JSON.stringify(snapshot.purek).includes('secret'));assert.ok(!JSON.stringify(snapshot.purek).includes('projection_url'));
  const invalid=await server.request('/api/purek/preferences',{auto_discovery:'true'});assert.equal(invalid.status,400);
  await server.api('/api/purek/preferences',{auto_discovery:false});
  const files=readdirSync(path.join(home,'data'));assert.ok(files.includes('native-preferences.json'));
  assert.ok(!readFileSync(path.join(home,'data','native-preferences.json'),'utf8').includes('secret'));
  const disconnected=await server.api('/api/purek/disconnect',{});assert.equal(disconnected.room_name,null);
  assert.equal(disconnected.output.status,'stopped');assert.ok(disconnected.output.generation>output.generation);
  assert.equal((await server.request('/api/purek/connect',{})).status,409);
});
for(const engine of [chromium,webkit])for(const android of [false,true])test(`${engine.name()} ${android?'Android My':'desktop settings'} room controls and authorization recovery`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await host(t,android);
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:android?{width:393,height:900}:{width:1440,height:980},hasTouch:android});
  await context.addCookies([...server.cookies].map(([name,value])=>({name,value,url:server.base})));
  const errors=[],external=[],bridge=[],preferences=[];let connectedFixture=false,releaseAuthorization;
  let probeCount=0,releaseProbe;
  const probeGate=new Promise(resolve=>{releaseProbe=resolve;});t.after(()=>releaseProbe());
  let decodeCount=0,holdDecode=false,releaseDecode;
  const decodeGate=new Promise(resolve=>{releaseDecode=resolve;});t.after(()=>releaseDecode());
  await context.exposeFunction('roomBridgeCall',call=>{bridge.push(call);return new Promise(resolve=>{releaseAuthorization=resolve;});});
  await context.addInitScript(android=>{
    localStorage.setItem('bilikara.update.automatic','false');
    if(android)window.BilikaraHostWindow={postMessage(raw){
      if(['enter','exit','purek-open','purek-close'].includes(raw))return;
      const{id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));
    }};
  },android);
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==server.base){external.push(u.origin);return route.abort();}
    if(/^\/api\/(bbdown\/login|catalog\/|d1\/|app\/update)/.test(u.pathname))return route.fulfill({status:503,json:{ok:false,error:'local fixture offline'}});
    if(u.pathname==='/api/purek/preferences'){
      const body=route.request().postDataJSON();preferences.push(body);
      if(connectedFixture)return route.fulfill({json:{ok:true,data:{auto_discovery:false,connected:true,busy:true,
        state_epoch:'fixture-room-epoch',revision:11,room_name:'Fixture room',output:{status:'probing'}}}});
      // Frontend-only preference fixture: never enable real LAN discovery.
      return route.fulfill({json:{ok:true,data:{auto_discovery:body.auto_discovery,connected:false,busy:false}}});
    }
    if(u.pathname==='/api/purek/connect')return route.fulfill(connectedFixture?{json:{ok:true,data:{connected:true,busy:false,room_name:'Fixture room',auto_discovery:false,state_epoch:'fixture-room-epoch',revision:10}}}:{status:502,json:{ok:false,code:'purek_authorization',error:'synthetic authorization missing'}});
    if(u.pathname==='/api/purek/output/probe'){
      probeCount++;
      if(probeCount>1)return route.fulfill({json:{ok:true,data:{auto_discovery:false,connected:true,busy:true,
        state_epoch:'fixture-room-epoch',revision:11,room_name:'Fixture room',output:{status:'probing'}}}});
      await probeGate;
      return route.fulfill({json:{ok:true,data:{connected:true,busy:false,room_name:'Fixture room',auto_discovery:false,state_epoch:'fixture-room-epoch',revision:12,
        output:{schema_version:1,status:'unsupported',last_error:'purek_output_no_av_transport',capabilities:{supports_live_stream:false}}}}});
    }
    if(u.pathname==='/api/purek/decode'){decodeCount++;if(holdDecode)await decodeGate;}
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const consoleIssues=[];page.on('console',message=>{
    if(['warning','error'].includes(message.type()))consoleIssues.push(message.text());
  });
  await page.goto(server.base);assert.match(await page.title(),/^bilikara(?: host)?$/);assert.equal(new URL(page.url()).origin,server.base);
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse&&window.BilikaraPureK);
  await page.evaluate(android=>{
    state.eventSource?.close();fetchState=async()=>{};setLanguage('zh');applyTheme('light');
    const opener=url=>window.roomBridgeCall({action:'authorize',url});
    if(android)window.BilikaraAndroidPlatform={openRoomAuthorization:opener};
    else window.BilikaraDesktopPlatform={...window.BilikaraDesktopPlatform,openExternal:opener};
  },android);
  await page.locator(android?'[data-android-page="my"]':'#work-rail-settings').click();
  await page.waitForFunction(android=>android ? document.documentElement.dataset.hostPage==='my' : state.activeHostWorkspace==='settings',android);
  await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished)));
  await page.locator('#purek-settings').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#purek-settings').isVisible(),true);
  assert.equal(await page.locator('#purek-settings').evaluate(n=>!n.nextElementSibling || n.nextElementSibling.classList.contains('cache-panel-footer')),true,'last section in Settings / My');
  const originalMedia=await page.locator('video,audio').count();
  const compactGeometry=n=>{const s=getComputedStyle(n);return {
    height:s.height,minHeight:s.minHeight,radius:s.borderRadius,font:s.fontSize,
    weight:s.fontWeight,paddingLeft:s.paddingLeft,paddingRight:s.paddingRight,lineHeight:s.lineHeight,
  };};
  const reference=await page.locator('#update-check-button').evaluate(compactGeometry);
  assert.deepEqual(reference,{height:'30px',minHeight:'30px',radius:'999px',font:'12px',weight:'700',paddingLeft:'12px',paddingRight:'12px',lineHeight:'12px'});
  assert.deepEqual(await page.locator('#purek-open').evaluate(compactGeometry),reference,'Connect room reuses the complete compact settings tool definition');
  assert.equal(await page.locator('#purek-open').evaluate(n=>n.getBoundingClientRect().height),30);
  assert.equal(await page.locator('#purek-automatic').count(),0,'settings offer manual room connection without automatic discovery');
  assert.equal(await page.locator('#purek-settings .settings-section-card').count(),0,'one settings surface owns the room section');
  assert.equal(await page.locator('[data-media-output="settings"]').evaluate(n=>{const s=getComputedStyle(n);return s.borderTopWidth==='0px'&&s.backgroundColor==='rgba(0, 0, 0, 0)';}),true,'output controls do not add a nested frame');
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium){const out=path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS);mkdirSync(out,{recursive:true});await page.screenshot({animations:"disabled",path:path.join(out,`${android?'android':'desktop'}-settings.png`)});await page.evaluate(()=>applyTheme("dark"));await page.screenshot({animations:"disabled",path:path.join(out,`${android?'android':'desktop'}-dark.png`)});await page.evaluate(()=>applyTheme("light"));}
  assert.deepEqual(preferences,[]);
  await page.locator('#purek-open').click();assert.equal(await page.locator('#purek-modal').isVisible(),true);
  const ordinaryGeometry=n=>{const s=getComputedStyle(n);return {height:s.height,radius:s.borderRadius,font:s.fontSize,weight:s.fontWeight};};
  for(const id of ['purek-import','purek-cancel','purek-submit'])assert.deepEqual(await page.locator('#'+id).evaluate(ordinaryGeometry),{height:'44px',radius:'14px',font:'16px',weight:'400'});
  const headingStyle=await page.locator('#purek-dialog-title').evaluate(n=>{const s=getComputedStyle(n);return {font:s.fontSize,line:s.lineHeight};});
  assert.deepEqual(headingStyle,{font:'18px',line:'24px'});
  assert.equal(await page.locator('#purek-close').evaluate(n=>{const r=n.getBoundingClientRect(),p=n.closest('.purek-card').getBoundingClientRect();return Math.abs(r.top-p.top-16)<1&&Math.abs(p.right-r.right-16)<1;}),true,'dialog close retains the shared 16px edge inset');
  // URL fields must share the ordinary Host input surface, including focus.
  const inputStyle=n=>{const s=getComputedStyle(n);return Object.fromEntries(
    ['height','minHeight','borderRadius','borderTopWidth','borderTopStyle','borderTopColor',
     'backgroundColor','color','fontFamily','fontSize','fontWeight','paddingLeft','paddingRight',
     'lineHeight','boxShadow'].map(key=>[key,s[key]]));};
  const urlInput=page.locator('#purek-url');
  for(const theme of ['light','dark','blue']){
    await page.evaluate(theme=>applyTheme(theme),theme);
    // Make the existing source input visible in this dialog. Some engines retain
    // stale inherited colors inside a hidden page until it participates in layout.
    await page.evaluate(()=>{
      const row=document.createElement('div');row.className='source-action-row';row.id='input-style-reference';
      row.append(document.querySelector('.source-action-row input').cloneNode());
      document.querySelector('.purek-body').append(row);
    });
    const focusReference=page.locator('#input-style-reference input');
    const surface=await page.locator('.purek-card').evaluate(n=>{
      const s=getComputedStyle(n), probe=document.createElement('span');
      probe.style.boxShadow='var(--rating-card-shadow)';n.append(probe);
      const expectedShadow=getComputedStyle(probe).boxShadow;probe.remove();
      return {background:s.backgroundColor,opacity:s.opacity,radius:s.borderRadius,
        blur:s.backdropFilter||s.webkitBackdropFilter,shadow:s.boxShadow,
        expectedShadow,
        nestedBlur:[...n.children].map(c=>{const x=getComputedStyle(c);return x.backdropFilter||x.webkitBackdropFilter||'none';})};
    });
    assert.equal(surface.opacity,'1');assert.equal(surface.radius,'18px');
    assert.match(surface.background,/, 0\.9\)$/,'Shared surface uses 90% fill opacity');
    assert.equal(surface.blur,'blur(12px)','Blur is confined to the shared outer panel');
    assert.notEqual(surface.shadow,'none');assert.equal(surface.shadow,surface.expectedShadow,'Shared theme shadow');
    assert.ok(surface.nestedBlur.every(x=>x==='none'),'No nested backdrop blur');
    const normal=await focusReference.evaluate(inputStyle);
    assert.equal(normal.borderTopWidth,'1px');
    assert.deepEqual(await urlInput.evaluate(inputStyle),normal,`${theme}: QR URL shares the ordinary Host input definition`);
    await focusReference.focus();
    const focused=await focusReference.evaluate(inputStyle);
    await urlInput.focus();assert.deepEqual(await urlInput.evaluate(inputStyle),focused,`${theme}: shared focus outline and ring`);
    assert.notEqual(focused.boxShadow,'none');
    await page.evaluate(()=>{document.getElementById('input-style-reference').remove();document.activeElement.blur();});
    assert.deepEqual(await urlInput.evaluate(inputStyle),normal,'Blur restores the ordinary input surface');
    if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)
      await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-input-${theme}.png`)});
  }
  await page.evaluate(()=>applyTheme('light'));
  assert.equal(await page.locator('#purek-camera').isVisible(),android);
  const dialogHelp=page.locator('#purek-dialog-help'),dialogInfo=page.locator('#purek-dialog-info');
  assert.equal(await dialogInfo.isVisible(),false,'room instructions do not occupy a body row');
  await dialogHelp.click();await dialogInfo.waitFor({state:'visible'});
  assert.equal(await page.locator('#purek-drop-hint').isVisible(),!android);
  assert.equal(await page.locator('#purek-input-hint #purek-drop-hint').count(),1);
  assert.equal(await dialogInfo.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true);
  await page.keyboard.press('Escape');await dialogInfo.waitFor({state:'hidden'});
  assert.equal(await page.locator('#purek-modal').isVisible(),true,'Escape dismisses help before the room dialog');
  assert.equal(await page.locator('label[for="purek-url"]').count(),0);
  assert.equal(await urlInput.getAttribute('aria-label'),'二维码链接或 DLNA 描述地址');

  assert.equal(await page.locator('#purek-camera-image').getAttribute('capture'),'environment');
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-input.png`)});
  await page.locator('#purek-url').fill(qr());await page.locator('#purek-submit').click();
  await page.waitForFunction(()=>document.getElementById('purek-submit').textContent==='检查连接');
  assert.equal(await page.locator('#purek-room-name').innerText(),'Fixture room');
  assert.equal(await page.locator('#purek-media-controls').isVisible(),false,'output controls wait for room authorization');
  for(const id of ['purek-authorize','purek-reidentify'])assert.deepEqual(await page.locator('#'+id).evaluate(ordinaryGeometry),{height:'44px',radius:'14px',font:'16px',weight:'400'});
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium){
    await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished)));
    await page.screenshot({animations:"disabled",path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-authorization.png`)});
  }
  await page.locator('#purek-authorize').evaluate(n=>{n.click();n.click();});
  await page.waitForFunction(()=>document.getElementById('purek-authorize').getAttribute('aria-busy')==='true');
  assert.equal(bridge.length,1);assert.equal(bridge[0].url,qr());releaseAuthorization();
  await page.waitForFunction(()=>!document.getElementById('purek-authorize').disabled);
  await page.locator('#purek-submit').click();await page.locator('#purek-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#purek-submit').isEnabled(),true);
  assert.equal(await page.locator('#purek-submit').getAttribute('aria-busy'),null);
  connectedFixture=true;await page.locator('#purek-submit').click();await page.locator('#purek-submit').filter({hasText:'断开连接'}).waitFor();
  assert.equal(await page.locator('#purek-open').innerText(),'已连接');assert.equal(await page.locator('#purek-output').getAttribute('hidden'),null);
  assert.deepEqual(await page.locator('#purek-open').evaluate(compactGeometry),reference,'Connected state retains the same compact geometry');
  assert.equal(await page.locator('#purek-output-status').innerText(),'房台已授权');
  assert.equal(await page.locator('#purek-output-details').textContent(),'设备已连接，尚未确认可投屏。');
  assert.equal(await page.locator('#purek-submit').evaluate(n=>n.classList.contains('purek-primary')),false,'disconnect uses the neutral domain-action palette');
  const probe=page.locator('#purek-probe');
  assert.deepEqual(await probe.evaluate(ordinaryGeometry),{height:'44px',radius:'14px',font:'16px',weight:'400'});
  await probe.evaluate(n=>{n.click();n.click();});
  await page.waitForFunction(()=>document.getElementById('purek-probe').getAttribute('aria-busy')==='true');
  assert.equal(probeCount,1);assert.equal(await probe.isEnabled(),false);
  assert.equal(await probe.innerText(),'处理中…');
  await page.evaluate(()=>setLanguage('en'));
  assert.equal(await probe.getAttribute('aria-busy'),'true');assert.equal(await probe.isEnabled(),false);
  assert.equal(await probe.innerText(),'Working…');
  releaseProbe();
  await page.waitForFunction(()=>document.getElementById('purek-probe').getAttribute('aria-busy')===null);
  assert.equal(await probe.isEnabled(),true);
  assert.match(await page.locator('#purek-output-status').innerText(),/AVTransport/);
  assert.equal(await page.locator('#purek-error').getAttribute('hidden'),'');
  await page.evaluate(()=>setLanguage('zh'));
  assert.equal(await page.locator('#purek-output-status').innerText(),'缺少 AVTransport');
  await dialogHelp.click();await dialogInfo.waitFor({state:'visible'});
  assert.equal(await page.locator('#purek-output-details').innerText(),'设备已连接，但未提供 AVTransport，无法通过 DLNA 播放。');
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-room-help.png`)});
  await page.keyboard.press('Escape');await dialogInfo.waitFor({state:'hidden'});
  await page.evaluate(()=>{
    const older={...state.data.purek,revision:11,busy:true,output:{status:'probing'}};
    state.data.purek=older;BilikaraPureK.sync(older);
  });
  assert.equal(await probe.isEnabled(),true);
  assert.equal(await page.evaluate(()=>state.data.purek.revision),12,'Older SSE/paint cannot restore a completed busy operation');
  await probe.click();
  await page.waitForFunction(()=>!document.getElementById('purek-probe').hasAttribute('aria-busy'));
  assert.equal(await probe.isEnabled(),true);
  assert.equal(await page.evaluate(()=>state.data.purek.revision),12,'Older API result cannot replace the accepted Rust projection');
  assert.deepEqual(preferences,[],'manual room UI never sends discovery preferences');
  for(const language of ['zh','en','ja']){
    await page.setViewportSize({width:android?320:700,height:600});
    await page.evaluate(language=>setLanguage(language),language);
    assert.match(await page.locator('#purek-output-status').innerText(),/AVTransport/);
    assert.equal(await page.locator('.purek-card').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&n.scrollWidth<=n.clientWidth+1;}),true);
    assert.equal(await page.locator('[data-media-output="room"]').evaluate(n=>{const r=n.querySelector('.media-output-targets').getBoundingClientRect(),box=n.getBoundingClientRect(),s=getComputedStyle(n);return Math.abs(r.right-box.right+parseFloat(s.paddingRight)+parseFloat(s.borderRightWidth))<1;}),true,'room switch aligns with its card content edge');
    assert.equal(await probe.isEnabled(),true);
  }
  await page.setViewportSize(android?{width:393,height:900}:{width:1440,height:980});
  await page.evaluate(()=>setLanguage('zh'));
  for(const [status,label] of [['unverified','待验证'],['starting','启动'],['streaming','发送'],['paused','暂停'],['stopped','停止']]){
    await page.evaluate(status=>{
      const value={...state.data.purek,revision:state.data.purek.revision+1,output:{status,pipeline_level:['starting','streaming'].includes(status)?'L0':null}};
      state.data.purek=value;BilikaraPureK.sync(value);
    },status);
    assert.match(await page.locator('#purek-output-status').innerText(),new RegExp(label));
    assert.equal(await probe.isEnabled(),!['starting','streaming'].includes(status));
    if(status==='unverified'){
      assert.equal(await page.locator('#purek-output-status').innerText(),'媒体能力待验证');
      assert.match(await page.locator('#purek-output-details').innerText(),/开启 DLNA/);
      if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)
        await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-unverified.png`)});
    }
    if(status==='streaming'&&process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)
      await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-streaming.png`)});
  }
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)
    await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-capabilities.png`)});
  await page.keyboard.press('Escape');
  if(await page.locator('#purek-modal').isVisible()) {
    assert.equal(await page.locator('#purek-modal .cache-advanced-info.is-visible').count(),0,'Escape first closes the current annotation');
    await page.keyboard.press('Escape');
  }
  await page.locator('#purek-modal').waitFor({state:'hidden'});
  // The connected state above is an explicit UI fixture; real loopback SOAP
  // success, timeout and rollback are exercised independently in Rust tests.
  await page.evaluate(()=>{
    state.data.purek={connected:false,busy:false,auto_discovery:false,state_epoch:'fixture-restarted-epoch',revision:0};
    BilikaraPureK.sync(state.data.purek);
  });
  assert.equal(await page.locator('#purek-open').innerText(),'连接','A replacement Host epoch accepts its reset revision');
  assert.equal(await page.locator('#purek-open').getAttribute('aria-label'),'连接设备','short visual label keeps its full accessible action name');
  for(const language of ['zh','en','ja'])for(const width of android?[320,393]:[700,1440]){
    await page.setViewportSize({width,height:900});await page.evaluate(l=>setLanguage(l),language);
    await page.locator('#purek-settings').scrollIntoViewIfNeeded();await page.locator('#purek-open').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.equal(await page.locator('.purek-card').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&n.scrollWidth<=n.clientWidth+1;}),true);
    assert.equal(await page.locator('.purek-image-actions').evaluate(n=>Array.from(n.children).filter(b=>!b.hidden).every(b=>b.scrollWidth<=b.clientWidth+1)),true,'Translated image actions keep their text inside the touch targets');
    await page.keyboard.press('Escape');await page.locator('#purek-modal').waitFor({state:'hidden'});
  }
  await page.evaluate(()=>setLanguage('zh'));await page.locator('#purek-open').click();
  const code=qrcode(0,'M');code.addData(qr());code.make();
  await page.locator('#purek-image').setInputFiles({name:'synthetic-room.svg',mimeType:'image/svg+xml',buffer:Buffer.from(code.createSvgTag({cellSize:4,margin:16,scalable:false}))});
  await page.waitForFunction(()=>!document.getElementById('purek-authorization-step').hidden||!document.getElementById('purek-error').hidden);
  assert.equal(await page.locator('#purek-error').getAttribute('hidden'),'');
  assert.equal(await page.locator('#purek-room-name').innerText(),'Fixture room');
  await page.keyboard.press('Escape');await page.locator('#purek-modal').waitFor({state:'hidden'});
  await page.locator('#purek-open').click();
  const svg=code.createSvgTag({cellSize:4,margin:16,scalable:false});
  if(android){
    // Browser fixture verifies the capture input and returned-image decode.
    // Launching a real system camera still requires Android device acceptance.
    const picker=page.waitForEvent('filechooser');await page.locator('#purek-camera').click();
    const chooser=await picker;assert.equal(await chooser.element().getAttribute('id'),'purek-camera-image');
    await chooser.setFiles({name:'camera-room.svg',mimeType:'image/svg+xml',buffer:Buffer.from(svg)});
    await page.waitForFunction(()=>!document.getElementById('purek-authorization-step').hidden);
    assert.equal(await page.locator('#purek-camera-image').inputValue(),'');
  }else{
    const drop=async files=>page.evaluate(files=>{
      const data=new DataTransfer();for(const file of files)data.items.add(new File([file.text],file.name,{type:file.type}));
      const modal=document.getElementById('purek-modal');
      const accepted=!modal.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));
      const highlighted=document.getElementById('purek-image-source').classList.contains('is-drag-over');
      modal.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
      return {accepted,highlighted};
    },files);
    await drop([{name:'wrong.txt',type:'text/plain',text:'not an image'}]);
    await page.locator('#purek-error:not([hidden])').waitFor();
    assert.equal(await page.locator('#purek-import').isEnabled(),true);
    const before=decodeCount;holdDecode=true;
    const request=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/purek/decode');
    const roomFile={name:'dropped-room.svg',type:'image/svg+xml',text:svg};
    assert.deepEqual(await drop([roomFile]),{accepted:true,highlighted:true});
    await request;
    assert.equal(await page.locator('#purek-import').getAttribute('aria-busy'),'true');
    await drop([roomFile]);assert.equal(decodeCount,before+1,'Pending drops cannot start another decode');
    releaseDecode();
    await page.waitForFunction(()=>!document.getElementById('purek-authorization-step').hidden);
    assert.equal(await page.locator('#purek-image-source').evaluate(n=>n.classList.contains('is-drag-over')),false);
    assert.equal(await page.locator('#purek-import').getAttribute('aria-busy'),null);
  }
  assert.equal(await page.locator('#purek-room-name').innerText(),'Fixture room');
  await page.locator('#purek-close').click();await page.locator('#purek-modal').waitFor({state:'hidden'});
  assert.equal(await page.locator('video,audio').count(),originalMedia);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  assert.deepEqual(consoleIssues.filter(message=>!/^Failed to load resource:.*(?:400|409|502|503)/.test(message)),[],
    'Only the deliberately rejected authorization/offline HTTP fixtures may log resource errors');
});

test('actual Chromium 83 can prepare a room using the shared compatibility UI',{
  skip:!process.env.BILIKARA_TEST_CHROMIUM83&&'Historic Chromium 83 executable required; a modern browser is not old-WebView proof',timeout:90000,
},async t=>{
  const {server}=await host(t,true);
  const {send,evaluate,wait,exceptions}=await historicChromium(t,process.env.BILIKARA_TEST_CHROMIUM83);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'try{localStorage.setItem("bilikara.update.automatic","false")}catch(e){}'});
  await send('Emulation.setDeviceMetricsOverride',{width:393,height:900,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:server.bootstrapUrl+'?webviewMode=legacy'});
  await wait('typeof state!=="undefined"&&state.hasValidStateResponse&&window.BilikaraPureK');
  assert.match(await evaluate('navigator.userAgent'),/Chrome\/83\./);
  await evaluate(`setLanguage("zh");document.querySelector('[data-android-page="my"]').click()`);
  await wait('!document.getElementById("purek-settings").hidden');
  await evaluate('document.getElementById("purek-open").click()');
  assert.deepEqual(await evaluate('(function(){var s=getComputedStyle(document.getElementById("purek-url"));return {height:s.height,radius:s.borderRadius,font:s.fontSize,border:s.borderTopWidth,style:s.borderTopStyle}})()'),
    {height:'44px',radius:'14px',font:'16px',border:'1px',style:'solid'});
  await evaluate('var roomInput=document.getElementById("purek-url");roomInput.value='+JSON.stringify(qr())+';roomInput.dispatchEvent(new Event("input"));document.getElementById("purek-submit").click()');
  await wait('document.getElementById("purek-submit").textContent==="检查连接"');
  assert.equal(await evaluate('document.getElementById("purek-room-name").textContent'),'Fixture room');
  assert.equal(await evaluate('document.getElementById("purek-error").hidden'),true);
  assert.equal(await evaluate('(function(){var r=document.querySelector(".purek-card").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()'),true);
  if(process.env.BILIKARA_PUREK_SCREENSHOTS){const {data}=await send('Page.captureScreenshot',{format:'png'});const {writeFileSync}=await import('node:fs');writeFileSync(path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),'chromium83-authorization.png'),Buffer.from(data,'base64'));}
  await evaluate('document.getElementById("purek-cancel").click()');
  await wait('document.getElementById("purek-modal").classList.contains("hidden")');
  await evaluate('document.getElementById("purek-open").click()');
  assert.equal(await evaluate('getComputedStyle(document.getElementById("purek-submit")).borderRadius'),'14px');
  assert.equal(await evaluate('document.getElementById("purek-camera").hidden'),false);
  const directory=mkdtempSync(path.join(tmpdir(),'bilikara-room-photo83-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const code=qrcode(0,'M');code.addData(qr());code.make();
  const photo=path.join(directory,'photo.svg');writeFileSync(photo,code.createSvgTag({cellSize:4,margin:16,scalable:false}),'utf8');
  const document=await send('DOM.getDocument');
  const input=await send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#purek-camera-image'});
  await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[photo]});
  await wait('!document.getElementById("purek-authorization-step").hidden');
  assert.equal(await evaluate('document.getElementById("purek-room-name").textContent'),'Fixture room');
  assert.equal(await evaluate('document.getElementById("purek-camera-image").value'),'');
  assert.deepEqual(exceptions,[]);
});

for(const engine of [chromium,webkit])for(const android of [false,true])test(`${engine.name()} ${android?'Android':'desktop'} ordinary DLNA connects without vendor authorization`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {server}=await host(t,android);
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:android?{width:393,height:900}:{width:700,height:700},hasTouch:android});
  await context.addCookies([...server.cookies].map(([name,value])=>({name,value,url:server.base})));
  await context.addInitScript(android=>{
    localStorage.setItem('bilikara.update.automatic','false');
    if(android)window.BilikaraHostWindow={postMessage(raw){
      if(['enter','exit','purek-open','purek-close'].includes(raw))return;
      const{id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));
    }};
  },android);
  let connects=0,release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==server.base)return route.abort();
    if(/^\/api\/(bbdown\/login|catalog\/|d1\/|app\/update)/.test(u.pathname))return route.fulfill({status:503,json:{ok:false,error:'local fixture offline'}});
    if(u.pathname==='/api/purek/connect'){
      connects++;await gate;
      return route.fulfill({json:{ok:true,data:{connected:true,busy:false,connection_type:'dlna',room_name:'Ordinary receiver',state_epoch:'dlna-ui-fixture',revision:1,output:{status:'authorized'}}}});
    }
    return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.base);await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse&&window.BilikaraPureK);
  await page.evaluate(()=>{state.eventSource?.close();fetchState=async()=>{};setLanguage('zh');window.__dlnaVideo=document.querySelector('video');});
  await page.locator(android?'[data-android-page="my"]':'#work-rail-settings').click();
  await page.locator('#purek-open').click();
  await page.locator('#purek-url').fill('https://example.com/description.xml');await page.locator('#purek-submit').click();
  await page.locator('#purek-error:not([hidden])').waitFor();
  assert.match(await page.locator('#purek-error').innerText(),/内网 IPv4/);
  await page.locator('#purek-url').fill('http://192.168.123.231:8200/renderer/device.xml');await page.locator('#purek-submit').click();
  await page.waitForFunction(()=>document.getElementById('purek-submit').textContent==='连接设备');
  assert.equal((await server.api('/api/purek/state')).connection_type,'dlna','prepare uses the actual Rust URL parser');
  assert.equal(await page.locator('#purek-authorize').isVisible(),false);
  assert.equal(await page.locator('#purek-dialog-info').isVisible(),false,'long guidance stays inside i');
  for(const language of ['zh','en','ja']){
    await page.evaluate(l=>setLanguage(l),language);
    await page.locator('#purek-dialog-help').click();await page.locator('#purek-dialog-info').waitFor({state:'visible'});
    assert.match(await page.locator('#purek-auth-hint').innerText(),/DLNA/);
    assert.equal(await page.locator('#purek-authorize').isVisible(),false);
    assert.equal(await page.locator('.purek-card').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    assert.equal(await page.locator('#purek-dialog-info').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),true);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(()=>setLanguage('zh'));
  await page.locator('#purek-submit').evaluate(n=>{n.click();n.click();});
  await page.waitForFunction(()=>document.getElementById('purek-submit').getAttribute('aria-busy')==='true');
  await page.waitForFunction(()=>document.getElementById('purek-submit').disabled);assert.equal(connects,1);
  await page.evaluate(()=>setLanguage('en'));assert.equal(await page.locator('#purek-submit').getAttribute('aria-busy'),'true');
  release();await page.locator('#purek-submit').filter({hasText:'Disconnect'}).waitFor();
  assert.equal(await page.locator('#purek-submit').getAttribute('aria-busy'),null);
  assert.equal(await page.locator('#purek-output-status').innerText(),'Connected');
  assert.equal(await page.locator('#purek-authorize').isVisible(),false);
  for(const language of ['zh','en','ja']){
    await page.setViewportSize({width:android?320:700,height:900});await page.evaluate(l=>setLanguage(l),language);
    assert.equal(await page.locator('.purek-room-title').evaluate(n=>n.getBoundingClientRect().width>=140),true,'device name retains readable space');
    assert.equal(await page.locator('#purek-probe').evaluate(n=>{const r=n.getBoundingClientRect(),b=n.closest('.purek-body').getBoundingClientRect();return r.left>=b.left&&r.right<=b.right+1&&n.scrollWidth<=n.clientWidth+1;}),true,'probe action stays inside its row');
    assert.equal(await page.locator('.purek-dialog-heading h2').evaluate(n=>{const r=n.getBoundingClientRect(),i=n.nextElementSibling.getBoundingClientRect();return r.right<=i.left&&n.scrollWidth<=n.clientWidth+1;}),true,'translated heading does not overlap i');
  }
  await page.setViewportSize({width:android?393:700,height:900});await page.evaluate(()=>setLanguage('en'));
  assert.equal(await page.evaluate(()=>document.querySelector('video')===window.__dlnaVideo),true,'connection preserves the media node');
  assert.deepEqual(errors,[]);
  if(process.env.BILIKARA_PUREK_SCREENSHOTS&&engine===chromium)
    await page.screenshot({animations:'disabled',path:path.join(path.resolve(process.env.BILIKARA_PUREK_SCREENSHOTS),`${android?'android':'desktop'}-ordinary-dlna.png`)});
});
