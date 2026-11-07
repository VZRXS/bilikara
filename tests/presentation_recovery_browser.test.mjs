// Actual Rust Host, media fetch/decode and shared controls. Only the OS display
// bridge/watchdog is a fixture; Linux WebKit is not iOS/macOS device evidence.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before,after} from 'node:test';
import {webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
let alpha,media;
const unavailable=process.platform!=='linux'&&'Linux browser fixture; Apple hardware validation is separate';
before(async()=>{
  if(unavailable)return;
  alpha=await buildNativeAlpha();media=mkdtempSync(path.join(tmpdir(),'bilikara-recovery-media-'));
  for(const [name,args] of [['video.mp4',['-f','lavfi','-i','testsrc2=s=640x360:r=15:d=60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart']],['audio.m4a',['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=60','-c:a','aac']]]){
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,path.join(media,name)],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
},{timeout:300000});
after(()=>{if(media)rmSync(media,{recursive:true,force:true});});
async function open(t,platform,playable){
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-output-recovery-'));let browser,host;
  t.after(async()=>{try{await browser?.close();}finally{try{await host?.close();}finally{rmSync(home,{recursive:true,force:true});}}});
  host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),...(playable?[path.join(media,'video.mp4'),path.join(media,'audio.m4a'),'3']:[])],isolatedEnvironment(home),true);
  browser=await webkit.launch({headless:true});const context=await browser.newContext({viewport:platform==='ios'?{width:393,height:844}:{width:1000,height:800},hasTouch:platform==='ios'});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(platform=>{
    localStorage.setItem('bilikara.update.automatic','false');
    const listeners=new Map();
    const initial=generation=>({mode:'singleScreen',phase:'inactive',generation,controllerReady:false,hostReady:false,selectedOutputDisplayId:'',controllerDisplayId:'host',playbackAuthority:'host',mediaRendererOwner:'host'});
    let session=initial(0),lastMaster=0;
    window.outputProbe={messages:[],failures:[]};
    const emit=()=>{for(const callback of listeners.get('bilikara-presentation-state')||[])callback({payload:{session:{...session}}});};
    window.BilikaraNativePresentation={platform:platform==='ios'?'ios':'macos',
      invoke:async(command,args={})=>{
        if(command==='get_presentation_session')return {...session};
        if(command==='get_presentation_displays')return {monitorCount:2,controllerDisplayId:'host',recommendedDisplayId:'external',displays:[{id:'external',name:'External fixture',width:1920,height:1080,scaleFactor:1,selectable:true,identityStable:true}]};
        if(command==='activate_local_presentation'){session={...initial(session.generation+1),mode:'localDualScreen',phase:'activating',selectedOutputDisplayId:'external'};lastMaster=Date.now();return {...session};}
        if(command==='mark_presentation_host_ready'){session={...session,phase:'active',controllerReady:true,hostReady:true};return {...session};}
        if(command==='deactivate_local_presentation'){session=initial(session.generation);return {...session};}
        if(command==='publish_presentation_playback_state'||command==='dismiss_presentation_display_identifiers')return null;
        throw Error('Unexpected display command '+command);
      },
      listen:async(name,callback)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);return()=>listeners.get(name).delete(callback);},
      postMaster:envelope=>{if(envelope.payload.scene.generation!==session.generation)throw Error('stale generation');lastMaster=Date.now();outputProbe.messages.push({generation:session.generation,at:lastMaster,paused:envelope.payload.clock.paused});},
    };
    // Exercise the desktop WebKit branch as well as the iOS Host marker.
    if(platform==='desktop')window.__TAURI__={};
    setInterval(()=>{if(session.phase==='active'&&Date.now()-lastMaster>5000){outputProbe.failures.push('outputHeartbeatLost');session={...initial(session.generation),recoveryReason:'outputHeartbeatLost'};emit();}},50);
  },platform);
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();if(['/', '/index.html'].includes(url.pathname)){const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"',`data-host-platform="${platform}"`)});}return route.continue();});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(host.base);await page.waitForFunction(()=>state.hasValidStateResponse&&state.presentationListenersReady&&state.presentationDisplayInfo?.displays?.length);
  return {page,host};
}
for(const platform of ['desktop','ios']){
  test(`${platform} WebKit output heartbeat survives no media and repeated output switches`,{skip:unavailable,timeout:60000},async t=>{
    const {page}=await open(t,platform,false);
    for(let cycle=0;cycle<3;cycle++){
      await page.evaluate(()=>activateLocalPresentation());
      await page.waitForFunction(()=>state.presentationSession.phase==='active');
      await page.waitForTimeout(6200);
      assert.equal(await page.evaluate(()=>state.presentationSession.phase),'active');
      assert.deepEqual(await page.evaluate(()=>outputProbe.failures),[]);
      const messages=await page.evaluate(()=>outputProbe.messages.filter(m=>m.generation===state.presentationSession.generation));
      assert.ok(messages.length>=5,'a decoder-free Host still publishes a current scene and clock');
      assert.ok(messages.slice(1).every((m,i)=>m.at-messages[i].at<2000),'heartbeat retains the existing one-second cadence');
      await page.evaluate(()=>deactivateLocalPresentation());
      const stopped=await page.evaluate(()=>outputProbe.messages.length);await page.waitForTimeout(1100);
      assert.equal(await page.evaluate(()=>outputProbe.messages.length),stopped,'inactive output releases its timer');
    }
  });
  test(`${platform} WebKit delayed track metadata keeps output alive and a real gesture recovers the same pair`,{skip:unavailable,timeout:60000},async t=>{
    const {page,host}=await open(t,platform,true);
    await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
    await page.evaluate(()=>activateLocalPresentation());
    await page.evaluate(()=>{window.retiredPair={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};});
    let release,held;const gate=new Promise(r=>{release=r;}),requested=new Promise(r=>{held=r;});let block=true;
    await page.route('**/media/**/instrumental.m4a',async route=>{if(block){held();await gate;}return route.continue();});
    const item=(await host.api('/api/state')).current_item;
    await host.api('/api/player/audio-variant',{item_id:item.id,variant_id:'p2_instrumental',expected_item_incarnation_id:item.item_incarnation_id});
    await requested;await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='failed');
    const before=await page.evaluate(()=>{window.failedPair={session:state.hostPlaybackSession,video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};return {ready:state.hostPlaybackSession.readyCommitted,failure:state.hostPlaybackSession.failureStage};});
    assert.deepEqual(before,{ready:false,failure:'media-readiness'});
    await page.waitForTimeout(3200);assert.equal(await page.evaluate(()=>state.presentationSession.phase),'active');
    assert.deepEqual(await page.evaluate(()=>outputProbe.failures),[]);
    block=false;release();
    await page.waitForFunction(()=>state.hostPlaybackSession.audio.readyState>=1&&state.hostPlaybackSession.video.readyState>=1&&!state.hostPlaybackSession.audio.seeking&&!state.hostPlaybackSession.video.seeking);
    // Keep the failure visible until an actual user control requests recovery.
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.phase),'failed');
    assert.equal(await page.evaluate(()=>requestSplitPlaybackStartFromUserGesture(retiredPair.video,retiredPair.audio,'retired-gesture')),false);
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.phase),'failed','a retired control cannot admit the current program');
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.readyCommitCount),0);
    await page.locator('#presentation-host-play').click();
    await page.waitForFunction(()=>state.hostPlaybackSession.phase==='playing'&&state.hostPlaybackSession.audio.currentTime>.3);
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession===failedPair.session&&state.hostPlaybackSession.video===failedPair.video&&state.hostPlaybackSession.audio===failedPair.audio),true);
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.readyCommitCount),1);
    assert.equal(await page.evaluate(()=>state.hostPlaybackSession.syncTimer!==null),true);
    for(const variant of ['p1_original','p2_instrumental','p1_original']){
      const item=(await host.api('/api/state')).current_item;
      await host.api('/api/player/audio-variant',{item_id:item.id,variant_id:variant,expected_item_incarnation_id:item.item_incarnation_id});
      await page.waitForFunction(variant=>state.data.current_item.selected_audio_variant_id===variant&&state.hostPlaybackSession.phase==='playing',variant);
    }
    if(platform==='desktop'){
      // Desktop keeps native output at unity. The supported gain boost creates
      // its real Web Audio route; iOS already uses that route for volume.
      await page.evaluate(()=>setLocalPlayerVolume(1.2));
    }
    await page.evaluate(()=>{
      const gain=state.hostPlaybackSession.audio.bilikaraVolumeGain;
      if(!gain)throw Error('WebKit output must use the actual audio gain graph');
      const analyser=state.audioContext.createAnalyser();gain.connect(analyser);
      window.recoveryPcm={gain,analyser,read:()=>{const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((sum,n)=>sum+n*n,0)/data.length);}};
    });
    await page.waitForFunction(()=>recoveryPcm.read()>.005);
    await page.evaluate(()=>recoveryPcm.gain.disconnect(recoveryPcm.analyser));
    await page.evaluate(()=>deactivateLocalPresentation());
    assert.equal(await page.locator('#player-frame').evaluate(n=>n.inert),false);
    // The single-screen recovery overlay uses the same synchronous retry path.
    await page.evaluate(()=>{const s=state.hostPlaybackSession;setSplitPlaybackIntent(s.video,s.audio,false);s.readyCommitted=false;s.initialIntentApplied=false;s.phase='binding';failHostPlaybackCandidate(s,s.video,s.audio,'fixture-readiness-retry');});
    await page.locator('.split-playback-start-button').click();
    await page.waitForFunction(()=>state.hostPlaybackSession.phase==='playing');
    assert.deepEqual(await page.evaluate(()=>outputProbe.failures),[]);
  });
}
