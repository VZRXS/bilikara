// Browser plugin is unavailable. Use the repository's pinned Playwright engines.
// Native controller/renderer integration is separately required by test:purek-controller.
import assert from 'node:assert/strict';
import test,{before} from 'node:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {HttpClient,RunningHost,isolatedEnvironment} from './native_host_support.mjs';
import {outputTransportFixture} from './media_output_transport_support.mjs';
import {root,runNative} from './desktop_construction_support.mjs';

let alpha;
before(async()=>{alpha=await buildNativeAlpha();},{timeout:300000});
async function checkOutputHelp(page,card) {
  const button=card.locator('.media-output-help');
  const bubble=page.locator('#'+await button.getAttribute('aria-describedby'));
  assert.equal(await bubble.isVisible(),false,'long output guidance is collapsed');
  await button.click();await bubble.waitFor({state:'visible'});
  assert.ok((await bubble.textContent()).length>40);
  assert.equal(await bubble.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),true,'shared help stays inside viewport');
  await page.keyboard.press('Escape');await bubble.waitFor({state:'hidden'});
  await button.evaluate(n=>n.blur());
  await button.focus();await bubble.waitFor({state:'visible'});
  await page.keyboard.press('Escape');await bubble.waitFor({state:'hidden'});
  await button.evaluate(n=>n.blur());
}
for(const [engine,android] of [[chromium,false],[webkit,false],[chromium,true],[webkit,true]]) {
  test(`${engine.name()} ${android?'Android phone':'desktop 700px'} shared output and media identity`,{timeout:120000},async t=>{
    const home=mkdtempSync(path.join(tmpdir(),'bilikara-output-ui-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
    const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
    for(const [file,args] of [[video,['-f','lavfi','-i','color=c=blue:s=320x180:r=15:d=120','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p']],
      [audio,['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=120','-c:a','aac']]]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,file],process.env,30000);assert.equal(result.status,0,result.stderr);
    }
    const host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);t.after(()=>host.close());
    const browser=await engine.launch({headless:true,args:engine===chromium?['--autoplay-policy=no-user-gesture-required']:[]});t.after(()=>browser.close());
    const context=await browser.newContext({viewport:android?{width:393,height:852}:{width:1280,height:800},hasTouch:android});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(android=>{
      localStorage.setItem('bilikara.update.automatic','false');
      if(android)window.BilikaraHostWindow={postMessage(raw){if(['enter','exit'].includes(raw))return;const{id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));}};
    },android);
    const errors=[],commands=[];let release,gate=null;
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
      if(/^\/api\/(catalog\/|d1\/)/.test(url.pathname))return route.fulfill({json:{ok:true,data:{items:[],categories:[],total:0}}});
      if(['/api/player/output','/api/player/control'].includes(url.pathname)) {
        const body=route.request().postDataJSON();commands.push({path:url.pathname,body});if(gate)await gate;
        const data=await page.evaluate(({body,path})=>{
          const data=structuredClone(state.data);data.state_revision++;
          if(body.target)Object.assign(data.media_output,{target:body.target,requested_target:body.target,status:body.target==='purek'?'streaming':'stopped',desired_playing:true,busy:false});
          if(body.offset_mode)data.media_output.offset_mode=body.offset_mode;
          if(path==='/api/player/control'){
            if(body.action==='toggle-play')data.media_output.desired_playing=!data.media_output.desired_playing;
            if(body.action==='play')data.media_output.desired_playing=true;
            if(body.action==='seek-absolute')data.media_output.position=body.target_seconds;
            if(body.action==='seek-relative')data.media_output.position=Math.max(0,Math.min(120,data.media_output.position+body.delta_seconds));
            data.media_output.status=data.media_output.desired_playing?'streaming':'paused';
          }
          return data;
        },{body,path:url.pathname});
        return route.fulfill({json:{ok:true,data}});
      }
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const consoleIssues=[];page.on('console',message=>{if(['warning','error'].includes(message.type()))consoleIssues.push({type:message.type(),text:message.text()});});
    await page.goto(host.base);assert.match(await page.title(),/^bilikara(?: host)?$/);assert.equal(new URL(page.url()).origin,host.base);
    await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await page.evaluate(android=>{
      state.eventSource?.close();fetchState=async()=>{};if(!android)document.documentElement.dataset.hostPlatform='desktop';
      const session=state.hostPlaybackSession;ensureAudioPitchSource(session.audio);
      window.outputIdentity={video:session.video,audio:session.audio,pitch:session.audio.bilikaraPitch,gain:session.audio.bilikaraVolumeGain,source:session.audio.bilikaraPitchSource,controls:elements.presentationHostControls,announcement:elements.presentationHostAnnouncement,progress:elements.presentationHostProgress};
      state.data.media_output={schema_version:1,target:'local',requested_target:'local',status:'authorized',authorized:true,available:true,can_manage:true,qualified:false,offset_mode:'splice',position:3,duration:120,busy:false,desired_playing:true,measured_adjust_latency_ms:null};
      render();
    },android);
    const goSettings=async()=>{await page.locator(android?'[data-android-page="my"]':'#work-rail-settings').click();await page.locator('#purek-settings').scrollIntoViewIfNeeded();};
    await goSettings();const settings=page.locator('[data-media-output="settings"]');
    assert.equal(await settings.locator('.media-output-status').isVisible(),false,'ordinary local/authorized state does not add a redundant caption row');
    await page.evaluate(()=>{state.data.media_output.status='unverified';state.data.media_output.last_error='purek_protocol_info';render();});
    for(const [language,label] of [['zh','媒体能力待验证'],['en','Media support unverified'],['ja','メディア対応は未検証']]){
      await page.evaluate(language=>setLanguage(language),language);
      assert.equal(await settings.locator('.media-output-status').innerText(),label);
      assert.equal(await settings.locator('.media-output-toggle').isEnabled(),true,'unknown capability permits an explicit trial');
      assert.equal(await settings.locator('.media-output-error').isVisible(),false,'a query failure is not a playback interruption');
    }
    await page.evaluate(()=>{setLanguage('zh');state.data.media_output.status='authorized';state.data.media_output.last_error=null;render();});
    const switchAtRight=n=>{const target=n.querySelector('.media-output-targets').getBoundingClientRect(),box=n.getBoundingClientRect(),s=getComputedStyle(n);return Math.abs(target.right-(box.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight)))<1;};
    assert.equal(await settings.evaluate(switchAtRight),true,'settings switch aligns with the right content edge');
    if(process.env.BILIKARA_OUTPUT_EVIDENCE){mkdirSync(process.env.BILIKARA_OUTPUT_EVIDENCE,{recursive:true});await page.screenshot({path:path.join(process.env.BILIKARA_OUTPUT_EVIDENCE,`${engine.name()}-${android?'android':'desktop'}-output-settings.png`),animations:'disabled'});}
    assert.equal(await settings.locator('.experimental-label').isVisible(),false,'settings reuse the room marker without repetition');
    const markerStyle=n=>{const s=getComputedStyle(n);return [s.fontSize,s.fontWeight,s.color];};
    assert.deepEqual(await page.locator('#purek-settings .purek-heading .experimental-label').evaluate(markerStyle),await settings.locator('.media-output-heading').evaluate(markerStyle),'room experimental marker uses the quiet label treatment');
    await checkOutputHelp(page,settings);
    await page.evaluate(()=>{state.presentationSession.phase='active';});
    await settings.locator('.media-output-targets').click();
    await page.waitForFunction(()=>document.getElementById('app-toast').textContent===t('mediaOutput.closeDisplay'));
    assert.equal(commands.length,0,'blocked target changes stay local and show their actionable toast');
    assert.equal(await settings.locator('.media-output-toggle').isChecked(),false);
    await page.evaluate(()=>{state.presentationSession.phase='inactive';setAppMessage('');});
    gate=new Promise(resolve=>release=resolve);
    const toggle=settings.locator('.media-output-toggle');
    assert.equal(await toggle.getAttribute('role'),'switch');assert.equal(await toggle.isChecked(),false);
    await settings.locator('.media-output-targets').click();
    assert.equal(await toggle.isDisabled(),true);assert.equal(await toggle.getAttribute('aria-busy'),'true');
    await toggle.dispatchEvent('change');assert.equal(commands.length,1);
    release();gate=null;
    await page.waitForFunction(()=>state.data.media_output.target==='purek');
    assert.equal(commands[0].body.experimental,true);
    assert.equal(await toggle.isChecked(),true);
    const switchGeometry=n=>{const s=getComputedStyle(n);return Object.fromEntries(['width','height','borderRadius'].map(k=>[k,s[k]]));};
    assert.deepEqual(await settings.locator('.cache-preview-switch').evaluate(switchGeometry),await page.locator('label[for="update-automatic-checkbox"] .cache-preview-switch').evaluate(switchGeometry),'DLNA uses the existing settings switch geometry');
    assert.ok(await settings.locator('.media-output-targets').evaluate(n=>n.getBoundingClientRect().height>=44));
    const runtimeSelectStyle=n=>{const s=getComputedStyle(n);return [s.height,s.minHeight,s.borderRadius,s.fontSize,s.fontWeight,s.appearance];};
    assert.deepEqual(await settings.locator('select').evaluate(runtimeSelectStyle),await page.locator('#cache-quality-select').evaluate(runtimeSelectStyle),'inline output choice shares the runtime select definition');
    assert.deepEqual(await settings.locator('select').evaluate(runtimeSelectStyle),['34px','34px','999px','13px','700','auto']);
    assert.equal(await settings.locator('.runtime-settings-select-shell').evaluate(n=>{const s=getComputedStyle(n),a=n.getBoundingClientRect(),b=n.firstElementChild.getBoundingClientRect();return s.overflow==='hidden'&&s.borderRadius==='999px'&&Math.abs(a.width-b.width)<1;}),true,'native select paint is clipped to the visible pill without clipping its text');
    assert.equal(await settings.locator('.media-output-mode').evaluate(n=>{const a=n.firstElementChild.getBoundingClientRect(),b=n.lastElementChild.getBoundingClientRect();return Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<1;}),true,'delay mode label and select share one row');
    await page.locator(android?'[data-android-page="playback"]':'#work-rail-playback').count().then(async count=>{if(count)await page.locator(android?'[data-android-page="playback"]':'#work-rail-playback').click();});
    await page.locator('[data-media-output="console"]').waitFor({state:'visible'});
    await page.locator('#presentation-host-announcement').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.outputIdentity.controls===elements.presentationHostControls&&window.outputIdentity.announcement===elements.presentationHostAnnouncement&&window.outputIdentity.progress===elements.presentationHostProgress),true,'DLNA reuses the original dual-screen console nodes');
    assert.equal(await page.evaluate(()=>{const{video,audio,pitch,gain}=window.outputIdentity;return video===state.hostPlaybackSession.video&&audio===state.hostPlaybackSession.audio&&audio.bilikaraPitch===pitch&&audio.bilikaraVolumeGain===gain&&gain&&audio.bilikaraPitchSource===window.outputIdentity.source&&video.paused&&audio.paused;}),true);
    const stage=page.locator('#presentation-host-controls');
    const consoleCard=page.locator('[data-media-output="console"]');
    await checkOutputHelp(page,consoleCard);
    assert.equal(await consoleCard.evaluate(n=>Math.abs(n.getBoundingClientRect().right-n.closest('.panel-head').getBoundingClientRect().right)<1),true,'DLNA console spans both Host heading columns');
    const pause=stage.locator('#presentation-host-play'),beforePause=commands.length;
    gate=new Promise(resolve=>release=resolve);
    await pause.click();assert.equal(await pause.isDisabled(),true);assert.equal(await pause.getAttribute('aria-busy'),'true');
    await pause.dispatchEvent('click');assert.equal(commands.length,beforePause+1);
    release();gate=null;
    await page.waitForFunction(()=>!state.data.media_output.desired_playing);
    assert.equal(commands.at(-1).body.action,'toggle-play');
    await stage.locator('#presentation-host-forward').click();await page.waitForFunction(()=>state.data.media_output.position===18);
    assert.equal(commands.at(-1).body.action,'seek-relative');
    await stage.locator('#presentation-host-progress').fill('45');await stage.locator('#presentation-host-progress').dispatchEvent('change');
    await page.waitForFunction(()=>state.data.media_output.position===45);
    assert.equal(commands.at(-1).body.action,'seek-absolute');
    await stage.locator('.playback-restart-action:visible').click();
    await page.waitForFunction(()=>state.data.media_output.position===0&&state.data.media_output.desired_playing&&!state.presentationHostControlBusy);
    assert.deepEqual(commands.slice(-2).map(c=>c.body.action),['seek-absolute','play']);
    // In-flight old media events cannot resume the retained local pair.
    await page.evaluate(()=>{state.hostPlaybackSession.video.dispatchEvent(new Event('playing'));state.hostPlaybackSession.audio.dispatchEvent(new Event('playing'));});
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.video.paused&&state.hostPlaybackSession.audio.paused),true);
    for(const language of ['zh','en','ja']) {
      await page.evaluate(language=>setLanguage(language),language);
      assert.match(await stage.locator('#presentation-host-progress').getAttribute('aria-label'),/估计|estimate|推定/);
      for(const theme of ['light','dark','blue']) {
        await page.evaluate(theme=>applyTheme(theme),theme);
        if(!android)await page.setViewportSize({width:700,height:700});
        assert.equal(await stage.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
        assert.equal(await consoleCard.evaluate(switchAtRight),true,'DLNA switch stays on the right edge across languages, themes and viewport sizes');
        for(const button of await stage.locator('button:visible').all())assert.ok(await button.evaluate(n=>n.getBoundingClientRect().height>=44));
      }
    }
    assert.equal(await stage.evaluate(n=>{
      n.scrollTop=0;const box=n.getBoundingClientRect();
      return [...n.querySelectorAll('button:not([role=menuitem]),input[type="range"]')].filter(c=>c.getClientRects().length).every(c=>{const r=c.getBoundingClientRect();return r.top>=box.top&&r.bottom<=box.bottom+1&&r.left>=box.left&&r.right<=box.right+1;});
    }),true,'shared dual-screen transport targets fit the console');
    const evidence=process.env.BILIKARA_OUTPUT_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${engine.name()}-${android?'android':'desktop'}-network.png`),animations:'disabled'});}
    await consoleCard.locator('.media-output-toggle').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>state.data.media_output.target==='local');
    assert.equal(await stage.isVisible(),false);assert.equal(await consoleCard.isVisible(),false);
    assert.equal(await page.locator('#presentation-host-announcement').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.outputIdentity.video===state.hostPlaybackSession.video&&window.outputIdentity.audio===state.hostPlaybackSession.audio&&window.outputIdentity.gain===state.hostPlaybackSession.audio.bilikaraVolumeGain),true,'return to local preserves media and DSP graph');
    if(!android) {
      await host.api('/api/session-users/add',{name:'Output visitor'});
      const remoteContext=await browser.newContext({viewport:{width:320,height:780},hasTouch:true});
      const remoteClient=new HttpClient(host.base);await remoteClient.request('/remote');
      await remoteContext.addCookies([...remoteClient.cookies].map(([name,value])=>({name,value,url:host.base})));
      const remoteCalls=[];
      await remoteContext.route('**/*',async route=>{
        const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
        if(url.pathname==='/api/player/output') {
          const body=route.request().postDataJSON();remoteCalls.push(body);
          const data=await remote.evaluate(mode=>{const data=structuredClone(state.data);data.state_revision++;data.media_output.offset_mode=mode;return data;},body.offset_mode);
          return route.fulfill({json:{ok:true,data}});
        }
        return route.continue();
      });
      const remote=await remoteContext.newPage();remote.on('pageerror',e=>errors.push(e.message));
      await remote.goto(host.base+'/remote');await remote.waitForFunction(()=>document.title.includes('bilikara'));assert.match(await remote.title(),/bilikara/);
      await remote.waitForFunction(()=>typeof state!=='undefined'&&state.data&&!state.remoteIdentityChecking);
      await remote.evaluate(async()=>{applyRemoteIdentity(await apiPost('/api/remote-identity/register',{name:'Output visitor',claim:true}));state.eventSource?.close();fetchState=async()=>{};});
      await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});
      const projected=JSON.parse(JSON.stringify(outputTransportFixture().localState(await host.api('/api/internet-remote/state'))));
      for(const source of ['local','public']) {
        await remote.evaluate(({source,projected})=>{
          if(source==='public')state.data=structuredClone(projected);
          state.data.media_output={...state.data.media_output,schema_version:1,target:'purek',status:'streaming',can_manage:false,authorized:true,qualified:false,offset_mode:'splice',desired_playing:true,position:4,duration:120,busy:false,measured_adjust_latency_ms:450};
          state.data.player_status={item_id:state.data.current_item.id,playback_generation:state.data.playback_generation,is_paused:false,current_time:4,duration:120};
          render();
        },{source,projected});
        await remote.evaluate(()=>{if(!openPlaybackSheet())throw Error('Playback sheet unavailable: '+JSON.stringify({modal:anotherRemoteModalIsOpen(),item:!!state.data.current_item}));});
        await remote.locator('.playback-sheet-body:not([inert])').waitFor({state:'visible'});
        const card=remote.locator('[data-media-output="remote"]');await card.scrollIntoViewIfNeeded();
        assert.equal(await card.evaluate(n=>n.parentElement.classList.contains('playback-sheet-settings-card')),true,'output is one section of the existing settings panel');
        assert.equal(await card.evaluate(n=>{const s=getComputedStyle(n);return s.borderRadius==='0px'&&s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.borderTopWidth==='0px';}),true,'output has no separate card surface');
        assert.equal(await remote.locator('#remote-av-sync-panel').evaluate(n=>getComputedStyle(n).borderTopWidth),'1px','visible output shares the ordinary section divider');
        assert.equal(await card.locator('.media-output-targets').isVisible(),false,'Remote never offers room target management');
        assert.equal(await card.locator('.experimental-label').isVisible(),true);
        await checkOutputHelp(remote,card);
        await card.locator('select').selectOption('gradual');await remote.waitForFunction(()=>state.data.media_output.offset_mode==='gradual');
        assert.deepEqual(remoteCalls.at(-1),{offset_mode:'gradual'});
        for(const language of ['zh','en','ja']) {
          await remote.evaluate(language=>setLanguage(language),language);
          assert.equal(await card.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
          assert.equal(await remote.locator('[data-media-output-latency]').evaluate(n=>n.closest('.remote-setting-header')!=null),true,'measured latency stays beside the delay heading');
          for(const theme of ['light','dark','blue']) {
            await remote.evaluate(theme=>applyTheme(theme),theme);
            const settingStyle=n=>{const s=getComputedStyle(n);return Object.fromEntries(['paddingTop','paddingRight','paddingBottom','paddingLeft','backgroundColor','borderRadius','gap'].map(k=>[k,s[k]]));};
            assert.deepEqual(await card.evaluate(settingStyle),await remote.locator('#remote-av-sync-panel').evaluate(settingStyle),'output shares the surrounding settings section geometry and surface');
            const headingStyle=n=>{const s=getComputedStyle(n);return Object.fromEntries(['fontSize','fontWeight','lineHeight','letterSpacing','color','textTransform'].map(k=>[k,s[k]]));};
            assert.deepEqual(await card.locator('.media-output-heading').evaluate(headingStyle),await remote.locator('#remote-av-sync-panel .panel-tag').evaluate(headingStyle),'output heading reuses the existing settings label');
            assert.deepEqual(await card.locator('.experimental-label').evaluate(headingStyle),await card.locator('.media-output-heading').evaluate(headingStyle),'experimental marker uses the same quiet label across languages and themes');
            assert.equal(await card.locator('.experimental-label').textContent(),await remote.evaluate(()=>t('purek.experimental')));
            assert.equal(await card.locator('.media-output-status').textContent(),await remote.evaluate(()=>t('mediaOutput.status.streaming')));
            assert.doesNotMatch(await card.locator('.media-output-status').textContent(),/[()（）]/);
            assert.deepEqual(await card.locator('select').evaluate(n=>{const s=getComputedStyle(n);return [s.height,s.borderRadius,s.fontSize,s.fontWeight,s.appearance];}),['34px','999px','13px','700','auto']);
            assert.equal(await card.locator('.runtime-settings-select-shell').evaluate(n=>{const s=getComputedStyle(n),a=n.getBoundingClientRect(),b=n.firstElementChild.getBoundingClientRect();return s.overflow==='hidden'&&s.borderRadius==='999px'&&Math.abs(a.width-b.width)<1;}),true,'Remote clips the native paint to the same pill');
            assert.equal(await card.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
          }
        }
        if(evidence)await remote.screenshot({path:path.join(evidence,`${engine.name()}-remote-${source}.png`),animations:'disabled'});
        await remote.setViewportSize({width:812,height:375});
        await remote.waitForFunction(()=>!state.playbackMetadataLayoutFrame&&getComputedStyle(document.querySelector('.playback-sheet-body')).gridTemplateColumns.split(' ').length===2);
        await card.scrollIntoViewIfNeeded();
        assert.equal(await remote.locator('.playback-sheet-secondary').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true,'merged network settings fit the independent landscape scroll owner');
        await checkOutputHelp(remote,card);
        if(evidence)await remote.screenshot({path:path.join(evidence,`${engine.name()}-remote-${source}-landscape.png`),animations:'disabled'});
        await remote.setViewportSize({width:320,height:780});
        await remote.evaluate(()=>{state.data.media_output.target='local';render();});
        assert.equal(await card.isVisible(),false);
        assert.equal(await remote.locator('#remote-av-sync-panel').evaluate(n=>getComputedStyle(n).borderTopWidth),'0px','hidden output leaves no divider before the first visible section');
        await remote.waitForFunction(()=>!state.playbackMetadataLayoutFrame&&!playbackSheetGesture?.active&&JSON.parse(state.playbackMetadataLayoutSignature||'{}').viewportHeight===780);
        await remote.locator('#playback-sheet-collapse').click();
        await remote.locator('#playback-sheet').waitFor({state:"hidden"});
      }
      await remoteContext.close();
    }
    if(evidence)writeFileSync(path.join(evidence,`${engine.name()}-${android?'android':'desktop'}-console.json`),JSON.stringify({errors,consoleIssues},null,2));
    assert.deepEqual(errors,[]);
    assert.deepEqual(consoleIssues,[]);
  });
}
