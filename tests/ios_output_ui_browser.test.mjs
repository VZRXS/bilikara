// Actual isolated Rust Host + Linux browser. Native iOS markers/IPC replies
// are fixtures, never physical AirPlay/Scene/receiver acceptance.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before,after} from 'node:test';
import {chromium,webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
import {receiver} from './ktv_assistance_support.mjs';
let alpha,mediaHome,files;
before(async()=>{
  if(process.platform!=='linux')return;
  alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
  mediaHome=mkdtempSync(path.join(tmpdir(),'bilikara-ios-output-media-'));files=[];
  for(const [fixture,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
    const file=path.join(mediaHome,name),result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',fixture),'-t','90','-c','copy','-movflags','+faststart',file],process.env,30000);
    assert.equal(result.status,0,result.stderr);files.push(file);
  }
},{timeout:300000});
after(()=>{if(mediaHome)rmSync(mediaHome,{recursive:true,force:true});});
async function open(t,engine,platform){
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-output-entry-'));let host,browser;
  t.after(async()=>{try{if(browser)await browser.close();}finally{try{if(host)await host.close();}finally{rmSync(home,{recursive:true,force:true});}}});
  host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),...files],isolatedEnvironment(home),true);
  browser=await engine.launch({headless:true});
  const context=await browser.newContext({viewport:platform==='desktop'?{width:1024,height:768}:{width:393,height:852},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(()=>{
    localStorage.setItem('bilikara.update.automatic','false');
    if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Fixture permission denial','NotAllowedError'));
  });
  await context.route('**/*',async r=>{
    const url=new URL(r.request().url());if(url.origin!==host.base)return r.abort();
    if(url.pathname==='/'&&platform!=='android'){
      const response=await r.fetch();return r.fulfill({response,body:(await response.text()).replace('data-host-platform="android"',`data-host-platform="${platform}"`)});
    }return r.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.base);await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing'&&window.BilikaraPureK);
  await page.evaluate(()=>{window.pair={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};});
  t.after(()=>assert.deepEqual(errors,[]));return{page,host};
}
const settle=page=>page.evaluate(async()=>{
  await document.fonts.ready;await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));
  await new Promise(resolve=>requestAnimationFrame(resolve));
});

for(const [engineName,engine]of Object.entries({chromium,webkit})) {
  for(const platform of ['desktop','android','ios'])test(`${engineName} ${platform}: DLNA management stays accessible and plain description URLs use real Rust admission`,{
    skip:process.platform!=='linux',timeout:90000,
  },async t=>{
    const {page,host}=await open(t,engine,platform),tv=await receiver(t),outputPosts=[];
    page.on('request',r=>{if(new URL(r.url()).pathname==='/api/player/output')outputPosts.push(r.postDataJSON());});
    await page.locator(platform==='desktop'?'#work-rail-settings':'[data-android-page="my"]').click();
    await page.locator('#purek-settings').scrollIntoViewIfNeeded();
    const toggle=page.locator('[data-media-output="settings"] .media-output-toggle');
    assert.equal(await toggle.isEnabled(),true);assert.equal(await toggle.isChecked(),false);
    // Tap the label itself: Playwright otherwise waits for its intentionally
    // disabled associated input to become enabled before sending any input.
    await page.locator('[data-media-output="settings"] .media-output-targets').click({force:true});
    assert.equal(await page.locator('#purek-modal').isVisible(),false,'DLNA only changes output; it never opens acquisition');
    await page.waitForFunction(()=>document.querySelector('[data-media-output="settings"] .media-output-status').textContent===t('mediaOutput.actionFailed'));
    assert.deepEqual(outputPosts,[{target:'native',experimental:true}]);
    await page.locator('#purek-open').click();
    await page.locator('#purek-modal').waitFor({state:'visible'});
    assert.equal(await toggle.isChecked(),false);assert.deepEqual(outputPosts,[{target:"native",experimental:true}]);
    await page.locator('#purek-dlna-entry summary').click();
    await page.locator('#purek-dlna-url').fill(tv.description);
    await page.locator('#purek-dlna-connect').click();
    await page.waitForFunction(()=>state.data?.purek?.connected===true);
    assert.equal((await host.api('/api/purek/state')).connection_type,'dlna');
    assert.ok(tv.state.actions.includes('GetProtocolInfo'));
    assert.equal(tv.state.actions.includes('SetDeviceAuthorization'),false,'Plain DLNA classification comes from Rust, never a fabricated Pure K authorization');
    assert.deepEqual(outputPosts,[{target:'native',experimental:true}],'connection does not issue a browser-side duplicate output command');
    assert.equal((await host.api('/api/state')).media_output.target,'local');
    await page.locator('#purek-close').click();
    await page.locator('#purek-modal').waitFor({state:'hidden'});
    // Native Alpha has no packaged live-TS companion. This is actual missing
    // capability, distinct from an iOS marker pretending to disable Linux.
    assert.equal((await host.api('/api/state')).media_output.available,false);
    // Connection admission is published before the Rust operation guard is
    // released. Keep the switch disabled during that real pending operation;
    // assert availability only after its terminal snapshot, not an SSE race.
    await page.waitForFunction(()=>state.data?.media_output?.authorized===true&&!state.data.media_output.available
      && !state.data.media_output.busy && !BilikaraMediaOutput.busy());
    assert.equal(await toggle.isEnabled(),true);
    await page.locator('[data-media-output="settings"] .media-output-targets').click({force:true});
    assert.equal(await page.locator('#purek-modal').isVisible(),false,'a missing backend cannot turn the mode switch into a scanner launcher');
    await page.waitForFunction(()=>!BilikaraMediaOutput.busy());
    if(platform==='desktop')await page.evaluate(()=>document.getElementById('purek-output-manage').click());
    else await page.locator('#purek-open').click();
    await page.locator('#purek-modal').waitFor({state:'visible'});
    assert.equal(await toggle.isChecked(),false);
    await page.locator('[aria-describedby="purek-dialog-info"]').click();
    assert.ok((await page.locator('#purek-dialog-info').innerText()).includes(await page.evaluate(()=>t('mediaOutput.backendUnavailable'))));
    assert.deepEqual(outputPosts,[{target:"native",experimental:true},{target:"purek",experimental:true}]);
    await page.keyboard.press('Escape');await page.locator('#purek-close').click();
    assert.deepEqual(await page.evaluate(()=>({same:state.hostPlaybackSession.video===pair.video&&state.hostPlaybackSession.audio===pair.audio,
      playing:!pair.video.paused&&!pair.audio.paused})),{same:true,playing:true});
  });

  test(`${engineName} iOS: quality and downloader keep native selects, pill geometry and original value/change ownership`,{skip:process.platform!=='linux',timeout:90000},async t=>{
    const {page,host}=await open(t,engine,'ios');
    await page.locator('[data-android-page="my"]').click();
    const ids=['cache-quality-select','cache-download-source-select'];
    await page.evaluate(ids=>{
      window.nativeRuntimeSelects=ids.map(id=>document.getElementById(id));
      window.runtimeSelectEvents={};
      for(const select of nativeRuntimeSelects) {
        runtimeSelectEvents[select.id]={input:0,change:0};
        for(const type of ['input','change']) select.addEventListener(type,()=>runtimeSelectEvents[select.id][type]++);
      }
    },ids);
    const saved=await page.evaluate(()=>nativeRuntimeSelects.map(select=>select.value));
    for(const [width,height,theme,language] of [[393,852,'light','zh'],[320,568,'dark','en'],[430,932,'blue','ja']]) {
      await page.setViewportSize({width,height});
      await page.evaluate(({theme,language})=>{applyTheme(theme);setLanguage(language);},{theme,language});
      await settle(page);
      const paint=[];
      for(const id of ids) {
        const select=page.locator('#'+id);await select.waitFor({state:'visible'});await select.scrollIntoViewIfNeeded();
        assert.equal(await select.count(),1,'one original native input per setting');
        const hit=await select.evaluate(n=>{
          const r=n.getBoundingClientRect(),shell=n.parentElement,s=getComputedStyle(shell),b=shell.getBoundingClientRect();
          return {tag:n.tagName,hidden:n.hidden,role:n.getAttribute('role'),label:n.labels?.[0]?.htmlFor,
            height:r.height,shellHeight:b.height,centerDelta:Math.abs((r.top+r.bottom-b.top-b.bottom)/2),
            edgeHits:[b.top-4,b.bottom+4].map(y=>document.elementFromPoint(r.x+r.width/2,y)===n),
            bounds:[r.left,r.right,innerWidth],overflow:s.overflow,radius:s.borderRadius,
            font:[getComputedStyle(n).fontSize,getComputedStyle(n).fontWeight],
            paint:[s.backgroundColor,s.boxShadow,s.borderRadius]};
        });
        assert.equal(hit.tag,'SELECT');assert.equal(hit.hidden,false);assert.equal(hit.role,null);assert.equal(hit.label,id);
        assert.equal(hit.shellHeight,34);assert.equal(hit.height,44);assert.ok(hit.centerDelta<1);
        assert.deepEqual(hit.edgeHits,[true,true],'the original native select owns both extended hit edges: '+JSON.stringify(hit));
        assert.equal(hit.overflow,'visible');assert.equal(hit.radius,'999px');assert.deepEqual(hit.font,['13px','700']);
        assert.ok(hit.bounds[0]>=14&&hit.bounds[1]<=width-14+1,'native target stays inside the page gutters');
        paint.push(hit.paint);
        await select.focus();
        assert.equal(await select.evaluate(n=>document.activeElement===n),true,'keyboard focus reaches the native control');
        assert.equal(await select.evaluate(n=>getComputedStyle(n.parentElement).outlineWidth),'2px','the shell keeps a visible focus ring');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.runtime-select-trigger,.runtime-select-menu,.runtime-select-option').count(),0,
          'keyboard/cancellation never constructs a CSS Picker');
      }
      assert.deepEqual(paint[0],paint[1],'the two closed pills still share their painted surface');
      assert.deepEqual(await page.evaluate(()=>nativeRuntimeSelects.map(select=>select.value)),saved,'theme/language/size never reset a selection');
      assert.equal(await page.evaluate(()=>nativeRuntimeSelects.every(select=>document.getElementById(select.id)===select)),true);
    }
    const geometry=await page.evaluate(()=>nativeRuntimeSelects.map(select=>{
      const r=select.getBoundingClientRect(),label=select.closest('label'),peer=label.nextElementSibling.getBoundingClientRect();
      return {overlap:Math.min(r.right,peer.right)>Math.max(r.left,peer.left)&&Math.min(r.bottom,peer.bottom)>Math.max(r.top,peer.top)};
    }));
    assert.ok(geometry.every(sample=>!sample.overlap),'44px native targets do not overlap their neighboring switches');
    const quality=page.locator('#cache-quality-select');
    const value=await page.locator('#cache-quality-select').evaluate(n=>n.options[n.options.length-1].value);
    await quality.selectOption(value);
    await page.waitForFunction(value=>document.querySelector('#cache-quality-select').value===value&&state.data.cache_policy.video_quality===value&&!state.cachePolicySaving,value);
    assert.equal((await host.api('/api/state')).cache_policy.video_quality,value);
    assert.deepEqual(await page.evaluate(()=>runtimeSelectEvents['cache-quality-select']),{input:1,change:1},'one native selection delivers one change');
    // Re-selecting the current downloader preserves its backend preference,
    // without preparing/installing an unrelated downloader in this UI fixture.
    await page.locator('#cache-download-source-select').selectOption(saved[1]);
    assert.deepEqual(await page.evaluate(()=>runtimeSelectEvents['cache-download-source-select']),{input:1,change:1});
    assert.equal((await host.api('/api/state')).cache_policy.download_source,saved[1]);
    await page.evaluate(()=>{state.cachePolicySaving=true;renderCachePolicyControls(state.data.cache_policy);});
    for(const id of ids) assert.equal(await page.locator('#'+id).isDisabled(),true,'pending writes disable the actual input');
    await page.evaluate(()=>{state.cachePolicySaving=false;renderCachePolicyControls(state.data.cache_policy);});
    await page.locator('[data-android-page="playback"]').click();await page.locator('[data-android-page="my"]').click();
    assert.equal(await page.evaluate(()=>nativeRuntimeSelects.every(select=>document.getElementById(select.id)===select&&!select.hidden&&!select.disabled)),true);
    assert.equal(await quality.inputValue(),value);
    await page.locator('#android-my-title').click();
    assert.equal(await page.locator('.runtime-select-trigger,.runtime-select-menu').count(),0,'outside activation leaves native ownership intact');
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.video===pair.video&&state.hostPlaybackSession.audio===pair.audio),true);
    // Physical WKWebView Picker opening/selection/cancellation and VoiceOver
    // remain device gates; Linux browser CSS/DOM evidence does not qualify them.
  });

  test(`${engineName} iOS: local video policy, theme identifiers, scanner corners and fullscreen QR fit logical viewports`,{
    skip:process.platform!=='linux',timeout:120000,
  },async t=>{
    const {page}=await open(t,engine,'ios');
    assert.deepEqual(await page.evaluate(()=>({disabled:pair.video.disableRemotePlayback,attribute:pair.video.hasAttribute('disableRemotePlayback'),webkit:pair.video.getAttribute('x-webkit-airplay'),audio:pair.audio.hasAttribute('disableRemotePlayback')})),
      {disabled:true,attribute:true,webkit:'deny',audio:false});
    await page.evaluate(()=>{
      window.identifierCalls=[];window.BilikaraNativePresentation={platform:'ios',invoke:async(command,args)=>{identifierCalls.push({command,args});return{};}};
      applyPresentationDisplayInfo({controllerDisplayId:'ios-host',displays:[{id:'ios-host',builtIn:true,controller:true,identityStable:true},
        {id:'pending',width:0,height:0,selectable:true,identityQuality:'pending',identifiable:false,identificationRequiresConnection:true}]});
    });
    const colors=[];
    for(const [theme,language]of [['light','zh'],['dark','en'],['blue','ja']]){
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.evaluate(async({theme,language})=>{applyTheme(theme);setLanguage(language);await showPresentationDisplayIdentifiers();},{theme,language});
      const wash=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--mobile-viewport-wash').trim());
      if(theme==='light') {
        const alpha=[...wash.matchAll(/rgba\(255,\s*255,\s*255,\s*([.\d]+)\)/g)].map(match=>Number(match[1]));
        assert.deepEqual(alpha,[0,.6],'the approved white wash strengthens from top to bottom behind content');
      } else assert.equal(wash,'','dark/blue surfaces keep their existing background');
      const call=await page.evaluate(()=>identifierCalls.filter(r=>r.command==='show_presentation_display_identifiers').at(-1));
      assert.deepEqual(call.args.displayIds,['ios-host','pending']);assert.deepEqual(call.args.displayNumbers,{'ios-host':1,pending:2});
      assert.equal(call.args.theme,theme);assert.equal(call.args.language,language);assert.equal(call.args.reduceMotion,true);
      for(const rgba of Object.values(call.args.colors))assert.ok(rgba.length===4&&rgba.every(n=>Number.isInteger(n)&&n>=0&&n<=255));
      assert.ok(call.args.colors.fill[3]>0);colors.push(call.args.colors.fill);
    }
    assert.equal(new Set(colors.map(c=>c.join(','))).size,3,'Native card receives shared theme tokens');
    await page.evaluate(()=>{applyTheme('light');setLanguage('zh');});
    await page.locator('[data-android-page="my"]').click();
    const background=await page.evaluate(()=>({canvas:getComputedStyle(document.body).backgroundImage,underlay:getComputedStyle(elements.hostWorkspaceRegion).backgroundImage}));
    assert.ok(background.underlay.includes('radial-gradient'));
    await page.locator('#purek-open').click();await page.locator('#purek-error:not([hidden])').waitFor();
    for(const [width,height]of [[393,852],[320,568],[844,393],[1024,768]]){
      await page.setViewportSize({width,height});await settle(page);
      if(width>=700)assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--mobile-viewport-wash').trim()),'',
        'landscape Host/tablet layouts retain their existing backdrop');
      const geometry=await page.evaluate(()=>{
        const outer=document.querySelector('.purek-card'),inner=document.getElementById('ktv-host-scan-view'),o=outer.getBoundingClientRect(),i=inner.getBoundingClientRect();
        return {insets:[i.left-o.left,o.right-i.right],radii:[parseFloat(getComputedStyle(outer).borderRadius),parseFloat(getComputedStyle(inner).borderRadius)],
          bounds:[o.left,o.right,innerWidth],scroll:document.querySelector('.purek-body').scrollHeight,
          controls:[...inner.querySelectorAll('button')].map(n=>n.getBoundingClientRect().height)};
      });
      assert.ok(geometry.insets.every(n=>Math.abs(n-21)<1),JSON.stringify(geometry));
      assert.deepEqual(geometry.radii,[18,14]);assert.ok(geometry.controls.every(n=>n>=44));
      assert.ok(geometry.bounds[0]>=0&&geometry.bounds[1]<=geometry.bounds[2]+1);
      await page.locator('#ktv-host-import').scrollIntoViewIfNeeded();assert.equal(await page.locator('#ktv-host-import').isEnabled(),true);
    }
    await page.locator('#purek-close').click();
    for(const [width,height]of [[844,390],[393,852]]){
      await page.setViewportSize({width,height});
      await page.evaluate(()=>{elements.playerPanel.classList.add('is-tauri-fullscreen');setPlayerFullscreenRemotePinned(true);});
      await settle(page);
      const bounds=await page.locator('#player-fullscreen-remote-popover').boundingBox();
      assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=height+1,JSON.stringify(bounds));
      assert.ok(bounds.width<=340);
      await page.evaluate(()=>{setPlayerFullscreenRemotePinned(false);elements.playerPanel.classList.remove('is-tauri-fullscreen');});
    }
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.video===pair.video&&state.hostPlaybackSession.audio===pair.audio),true);
  });
}
