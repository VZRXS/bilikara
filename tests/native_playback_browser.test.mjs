// Host-page integration of the native GStreamer session against the real Rust
// Host (AppState, claims, queue, history) with a deterministic engine bridge.
// The real engine/pipeline is covered by media-engine live tests and the
// Linux desktop acceptance; this file proves the page never owns Next.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

// Deterministic in-page engine following the bridge protocol of
// static/native-playback.js and src-tauri/src/native_media.rs.
function installFakeEngine() {
  const fields=['playback_generation','item_id','item_incarnation_id','selected_audio_variant_id','artifact_set_id'];
  const same=(a,b)=>Boolean(a&&b&&fields.every(k=>a[k]===b[k]));
  const listeners=new Set(),log=[];let seq=0,seekId=0,current=null,preference='gstreamer',failLoad=false;
  const status=()=>({platform:'linux',preference,default_engine:'gstreamer',configured:preference,
    gstreamer:{available:true,qualification:'browser-test',reason:null,version:'test',missing:[]}});
  const emit=(program,type,extra={})=>{
    const observation={seq:++seq,program,type,position:current?.position??0,duration:current?.duration??null,
      intent_playing:Boolean(current?.intent),at_ms:Date.now(),...extra};
    log.push({observation:{type,generation:program.playback_generation,seq:observation.seq,position:observation.position}});
    for(const handler of [...listeners])handler({payload:observation});
    return observation;
  };
  setInterval(()=>{
    if(!current?.playing)return;
    current.position=Math.min(current.duration,current.position+.1);
    if(current.position>=current.duration){current.playing=false;current.intent=false;emit(current.program,'eos',{drained:true,watchdog:false});}
    else emit(current.program,'position');
  },100);
  function command(c){
    log.push({command:c.op,generation:c.program?.playback_generation??null,seconds:c.seconds??c.start_seconds??null,play:c.play??null});
    if(c.op==='settings')return{accepted:true,seek_id:null};
    if(c.op==='load'){
      if(failLoad)return{accepted:false,code:'test-load-failure'};
      if(current&&current.program.playback_generation>c.program.playback_generation)return{accepted:false,code:'stale-program'};
      current={program:c.program,position:c.start_seconds||0,duration:Number(window.__fakeEngineDuration||60),intent:Boolean(c.play),playing:false};
      const loaded=current;
      setTimeout(()=>{if(current!==loaded)return;emit(loaded.program,'loading');emit(loaded.program,'ready');
        if(loaded.intent){loaded.playing=true;emit(loaded.program,'playing');}else emit(loaded.program,'paused');},40);
      return{accepted:true,seek_id:null};
    }
    if(!current||!same(c.program,current.program))return{accepted:false,code:'stale-program'};
    const active=current;
    switch(c.op){
      case'play':if(active.position>=active.duration)return{accepted:false,code:'program-ended'};
        active.intent=true;active.playing=true;setTimeout(()=>emit(active.program,'playing'),10);return{accepted:true,seek_id:null};
      case'pause':active.intent=false;active.playing=false;setTimeout(()=>emit(active.program,'paused'),10);return{accepted:true,seek_id:null};
      case'seek':{const id=++seekId;if(typeof c.play==='boolean')active.intent=c.play;active.playing=false;
        active.position=Math.min(active.duration,c.seconds);
        setTimeout(()=>{if(current!==active)return;emit(active.program,'seek-settled',{seek_id:id});
          if(active.intent){active.playing=true;emit(active.program,'playing');}else emit(active.program,'paused');},30);
        return{accepted:true,seek_id:id};}
      case'stop':current=null;setTimeout(()=>emit(active.program,'stopped'),5);return{accepted:true,seek_id:null};
      default:return{accepted:false,code:'unsupported'};
    }
  }
  window.__BILIKARA_MEDIA_ENGINE_TEST_BRIDGE__={
    async invoke(name,args){
      if(name==='get_media_engine_status')return status();
      if(name==='set_media_engine_preference'){preference=args.engine;return status();}
      if(name==='media_engine_command')return command(args.command);
      if(name==='set_media_engine_surface'){log.push({surface:args.surface.visible});return null;}
      if(name==='get_media_engine_snapshot')return{engine:current&&{program:current.program}};
      throw new Error('unsupported test command '+name);
    },
    async listen(event,handler){
      if(event!=='media-engine://observation')throw new Error('unexpected event '+event);
      listeners.add(handler);return()=>listeners.delete(handler);
    },
  };
  window.__fakeEngine={log,emit,current:()=>current,setFailLoad:v=>{failLoad=v;},same};
}

async function media(home) {
  const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
  for(const [file,source,codec]of [[video,'testsrc2=s=320x180:r=30:d=6','libx264'],[audio,'sine=frequency=440:sample_rate=48000:duration=6','aac']]) {
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',source,'-c:'+(file===video?'v':'a'),codec,
      ...(file===video?['-preset','ultrafast','-pix_fmt','yuv420p']:[]),'-threads','2',file],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
  return {video,audio};
}

test('native session executes claimed programs while Rust AppState owns every transition',{timeout:240000},async()=>{
  const home=mkdtempSync(path.join(tmpdir(),'native-playback-')),{video,audio}=await media(home);
  const host=await RunningHost.start(await buildNativeAlpha(),home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
  let browser;
  try {
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());
    await context.addInitScript(installFakeEngine);
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.base);
    await page.waitForFunction(()=>state.hostPlaybackSession?.engine==='gstreamer'&&state.hostPlaybackSession.phase==='playing',null,{timeout:30000});
    await page.evaluate(()=>{window.__firstProgram=state.hostPlaybackSession.mediaBackend.program;});
    const first=await page.evaluate(()=>({
      generation:state.hostPlaybackSession.playbackGeneration,item:state.data.current_item.id,
      noMediaElements:!document.querySelector('#player-frame video,#player-frame audio'),
      stage:Boolean(document.querySelector('#player-frame .native-video-stage')),
      nativeVideo:document.documentElement.dataset.nativeVideo,
      engineStatus:document.getElementById('playback-engine-status').textContent,
      load:__fakeEngine.log.find(e=>e.command==='load'),
    }));
    assert.equal(first.noMediaElements,true,'no WebView media pair is created for a native session');
    assert.equal(first.stage,true);assert.equal(first.nativeVideo,'active');
    // The shell composites frames beneath pixels the page leaves transparent:
    // the stage must be a real hole through every page layer (including the
    // root's own gradient), while the surrounding page stays opaque.
    const {pngRgba}=await import('../scripts/png-rgba.mjs');
    await page.waitForTimeout(300);
    const frameBox=await page.locator('#player-frame').boundingBox();
    const alpha=async(x,y)=>pngRgba(await page.screenshot({omitBackground:true,clip:{x,y,width:1,height:1}})).pixels[3];
    assert.equal(await alpha(frameBox.x+frameBox.width/2,frameBox.y+frameBox.height/2),0,'native stage is transparent');
    assert.equal(await alpha(10,10),255,'page outside the stage stays opaque');
    // The Linux shell's own app-shell colour must not cover the stage either.
    const platform=await page.evaluate(()=>{const old=document.body.dataset.tauriPlatform;document.body.dataset.tauriPlatform='linux';return old;});
    await page.waitForTimeout(100);
    assert.equal(await alpha(frameBox.x+frameBox.width/2,frameBox.y+frameBox.height/2),0,'Linux shell stage is transparent');
    assert.equal(await alpha(10,10),255,'Linux shell page stays opaque');
    await page.evaluate(old=>{if(old===undefined)delete document.body.dataset.tauriPlatform;else document.body.dataset.tauriPlatform=old;},platform);
    // A layout change without a window resize moves the stage: the holes follow
    // the surface tracker, so the old hole region is opaque again.
    await page.evaluate(()=>{document.querySelector('#player-frame').style.marginTop='60px';});
    await page.waitForTimeout(800);
    const moved=await page.locator('#player-frame').boundingBox();
    assert.ok(moved.y>=frameBox.y+50,'stage moved by layout');
    assert.equal(await alpha(moved.x+moved.width/2,moved.y+moved.height/2),0,'moved stage is transparent');
    assert.equal(await alpha(moved.x+moved.width/2,moved.y-20),255,'stale hole region is opaque again');
    await page.evaluate(()=>{document.querySelector('#player-frame').style.marginTop='';});
    assert.equal(first.load.generation,first.generation);
    // The program was claimed before execution: Rust accepts its status.
    const claimed=await host.api('/api/state');
    assert.equal(claimed.current_item.id,first.item);

    // Remote/Host transport commands reach the engine through the Host queue.
    await host.api('/api/player/control',{action:'pause',item_id:first.item,playback_generation:first.generation});
    await page.waitForFunction(()=>__fakeEngine.log.some(e=>e.command==='pause')&&state.hostPlaybackSession.logicalPlayIntent===false);
    await host.api('/api/player/control',{action:'seek-absolute',item_id:first.item,playback_generation:first.generation,target_seconds:1.2});
    await page.waitForFunction(()=>__fakeEngine.log.some(e=>e.command==='seek'&&Math.abs(e.seconds-1.2)<.01&&e.play===false));
    await host.api('/api/player/control',{action:'play',item_id:first.item,playback_generation:first.generation});
    await page.waitForFunction(()=>state.hostPlaybackSession.phase==='playing');

    // Natural end: one drained EOS advances exactly once through AppState. The
    // first program is long enough for the checks above on a loaded machine;
    // a seek near its end ends it. Later programs run long enough for the
    // switching checks below.
    await page.evaluate(()=>{window.__fakeEngineDuration=5;});
    await host.api('/api/player/control',{action:'seek-absolute',item_id:first.item,playback_generation:first.generation,target_seconds:59.5});
    await page.waitForFunction(g=>state.data.playback_generation>g&&state.hostPlaybackSession?.engine==='gstreamer'
      &&state.hostPlaybackSession.playbackGeneration===state.data.playback_generation,first.generation,{timeout:30000});
    const advanced=await host.api('/api/state');
    assert.equal(advanced.history.length,1,'one history entry for one completion');
    assert.notEqual(advanced.current_item.id,first.item);
    // Replayed and stale observations of the retired program are ignored.
    const before=advanced.playback_generation;
    await page.evaluate(()=>{const stale=window.__firstProgram;
      __fakeEngine.emit(stale,'eos',{drained:true,watchdog:false});__fakeEngine.emit(stale,'eos',{drained:true,watchdog:false});
      __fakeEngine.emit(stale,'error',{code:'stale',fatal:true});});
    await page.waitForTimeout(800);
    const afterStale=await host.api('/api/state');
    assert.equal(afterStale.playback_generation,before,'stale EOS cannot select Next');
    assert.equal(afterStale.history.length,1);
    assert.equal(await page.evaluate(()=>state.mediaEngineFallback),null,'stale fatal error cannot trigger fallback');

    // Deliberate switch to Legacy reloads the same claimed program at its
    // logical position; no Next, no history, no queue change.
    // Wait until the configured inter-song transition released the new song.
    await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing'
      &&!shouldHoldCurrentItemForTransition(state.data.current_item),null,{timeout:30000});
    const second=await host.api('/api/state');
    await host.api('/api/player/control',{action:'pause',item_id:second.current_item.id,playback_generation:second.playback_generation});
    await host.api('/api/player/control',{action:'seek-absolute',item_id:second.current_item.id,playback_generation:second.playback_generation,target_seconds:1.5});
    await page.waitForFunction(()=>Math.abs(state.hostPlaybackSession.video.currentTime-1.5)<.3&&state.hostPlaybackSession.logicalPlayIntent===false
      &&!state.hostPlaybackSession.seekSettling&&!state.data.player_control_command);
    const queueBefore=(await host.api('/api/state')).playlist.map(i=>i.id);
    // Exercise the real settings listener (the popover need not be open).
    await page.evaluate(()=>{const select=document.getElementById('playback-engine-select');
      select.value='legacy';select.dispatchEvent(new Event('change'));});
    await page.waitForFunction(g=>state.hostPlaybackSession?.engine!=='gstreamer'&&state.hostPlaybackSession?.playbackGeneration===g
      &&state.hostPlaybackSession.readyCommitted,before,{timeout:30000});
    const legacy=await page.evaluate(()=>({paused:state.hostPlaybackSession.video.paused,time:state.hostPlaybackSession.video.currentTime,
      intent:state.hostPlaybackSession.logicalPlayIntent,phase:state.hostPlaybackSession.phase,should:state.localShouldBePlaying,
      restore:state.pendingPlaybackRestore,
      nativeVideo:document.documentElement.dataset.nativeVideo||null,element:state.hostPlaybackSession.video instanceof HTMLVideoElement,
      stopped:__fakeEngine.log.filter(e=>e.command==='stop').length}));
    assert.equal(legacy.element,true);assert.equal(legacy.nativeVideo,null);assert.equal(legacy.paused,true,'pause intent preserved '+JSON.stringify(legacy));
    assert.ok(Math.abs(legacy.time-1.5)<.6,`position preserved: ${legacy.time}`);assert.ok(legacy.stopped>=1,'native engine retired');
    const afterSwitch=await host.api('/api/state');
    assert.equal(afterSwitch.playback_generation,before);assert.equal(afterSwitch.history.length,1);
    assert.deepEqual(afterSwitch.playlist.map(i=>i.id),queueBefore);

    // Switch back, then an unrecoverable native failure falls back once.
    await page.evaluate(()=>changeMediaEnginePreference('gstreamer'));
    await page.waitForFunction(g=>state.hostPlaybackSession?.engine==='gstreamer'&&state.hostPlaybackSession.playbackGeneration===g&&state.hostPlaybackSession.readyCommitted,before,{timeout:30000});
    await page.evaluate(()=>__fakeEngine.setFailLoad(true));
    await page.evaluate(()=>{const s=state.hostPlaybackSession;__fakeEngine.emit(s.mediaBackend.program,'error',{code:'pipeline-error',fatal:true,detail:'test'});});
    await page.waitForFunction(g=>state.mediaEngineFallback&&state.hostPlaybackSession?.engine!=='gstreamer'&&state.hostPlaybackSession?.playbackGeneration===g,before,{timeout:30000});
    const fallback=await page.evaluate(()=>({reason:state.mediaEngineFallback.reason,row:document.getElementById('playback-engine-row').dataset.fallback,
      text:document.getElementById('playback-engine-status').textContent,loads:__fakeEngine.log.filter(e=>e.command==='load').length}));
    assert.equal(fallback.reason,'pipeline-error');assert.equal(fallback.row,'true');assert.match(fallback.text,/pipeline-error/);
    await page.waitForTimeout(1500);
    const loadsLater=await page.evaluate(()=>__fakeEngine.log.filter(e=>e.command==='load').length);
    assert.equal(loadsLater,fallback.loads,'fallback never retries the native engine by itself');
    const afterFallback=await host.api('/api/state');
    assert.equal(afterFallback.playback_generation,before);assert.equal(afterFallback.history.length,1);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await host.close();}
});
