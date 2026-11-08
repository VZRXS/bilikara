import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]) {
  test(`${name} LegacyPlaybackAdapter delegates to the same production pair and Rust program`,{timeout:180000},async()=>{
    const home=mkdtempSync(path.join(tmpdir(),'legacy-media-backend-')),video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
    for(const [file,source,codec]of [[video,'testsrc2=s=640x360:r=30:d=40','libx264'],[audio,'sine=frequency=440:sample_rate=48000:duration=40','aac']]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',source,'-c:'+ (file===video?'v':'a'),codec,...(file===video?['-preset','ultrafast','-pix_fmt','yuv420p']:[]),'-threads','4',file],process.env,30000);assert.equal(result.status,0,result.stderr);
    }
    const host=await RunningHost.start(await buildNativeAlpha(),home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
    let browser;
    try {
      browser=await engine.launch({headless:true,...(name==='chromium'?{args:['--autoplay-policy=no-user-gesture-required']}: {})});
      const context=await browser.newContext({viewport:{width:1280,height:800}});
      await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
      await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(host.base);await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
      const initial=await page.evaluate(()=>{
        const session=state.hostPlaybackSession,adapter=session.mediaBackend;
        window.roundALegacy={session,adapter,video:session.video,audio:session.audio,program:adapter.program,events:[]};
        adapter.subscribe(event=>roundALegacy.events.push(event.type));
        return adapter.snapshot(adapter.program);
      });
      assert.equal(initial.ready,true);assert.equal(initial.playing,true);
      await page.evaluate(()=>roundALegacy.adapter.pause(roundALegacy.program));
      await page.waitForFunction(()=>state.hostPlaybackSession.audio.paused&&state.hostPlaybackSession.video.paused);
      await page.evaluate(()=>roundALegacy.adapter.play(roundALegacy.program,{userGesture:true}));
      await page.waitForFunction(()=>state.hostPlaybackSession.phase==='playing');
      await page.evaluate(()=>roundALegacy.adapter.seek(roundALegacy.program,5));
      await page.evaluate(()=>roundALegacy.adapter.setVolume(roundALegacy.program,.5,false));
      await page.evaluate(()=>roundALegacy.adapter.setKeyShift(roundALegacy.program,1));
      await page.evaluate(()=>roundALegacy.adapter.setAvDelay(roundALegacy.program,100));
      const timing=await page.evaluate(()=>({snapshot:roundALegacy.adapter.snapshot(roundALegacy.program),
        navigationTime:roundALegacy.video.currentTime,audioTime:roundALegacy.audio.bilikaraAudioClock?.outputTime()??roundALegacy.audio.currentTime}));
      assert.ok(Math.abs(timing.snapshot.timeSeconds-timing.navigationTime)<.01);
      assert.ok(Math.abs(timing.snapshot.audioTimeSeconds-timing.audioTime)<.01);
      assert.ok(['output-segment','reported-media'].includes(timing.snapshot.audioTimeBasis));
      const samePair=await page.evaluate(()=>state.hostPlaybackSession===roundALegacy.session&&state.hostPlaybackSession.video===roundALegacy.video&&state.hostPlaybackSession.audio===roundALegacy.audio);
      assert.equal(samePair,true);
      const variant=await page.evaluate(()=>state.data.current_item.audio_variants.find(v=>v.id!==roundALegacy.program.selected_audio_variant_id).id);
      await page.evaluate(variant=>roundALegacy.adapter.selectAudioVariant(roundALegacy.program,variant),variant);
      await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing'&&state.hostPlaybackSession.playbackGeneration>roundALegacy.program.playback_generation);
      const after=await page.evaluate(()=>{
        const current=state.hostPlaybackSession.mediaBackend;
        let staleCode;try{roundALegacy.adapter.pause(roundALegacy.program);}catch(error){staleCode=error.code;}
        return {staleCode,snapshot:current.snapshot(current.program),events:roundALegacy.events};
      });
      assert.equal(after.staleCode,'disposed');assert.equal(after.snapshot.program.selected_audio_variant_id,variant);
      assert.equal(after.snapshot.program.item_incarnation_id,initial.program.item_incarnation_id);
      assert.ok(after.events.includes('playing'));
      const beforeStop=await host.api('/api/state');
      const stopped=await page.evaluate(()=>{
        const session=state.hostPlaybackSession,backend=session.mediaBackend;
        const result=backend.stop(backend.program);backend.dispose();
        return {result,phase:session.phase,pairGone:!session.video&&!session.audio};
      });
      assert.deepEqual(stopped,{result:true,phase:'retired',pairGone:true});
      const afterStop=await host.api('/api/state');assert.equal(afterStop.playback_generation,beforeStop.playback_generation);
      assert.deepEqual(afterStop.playlist.map(i=>i.id),beforeStop.playlist.map(i=>i.id));assert.deepEqual(afterStop.history,beforeStop.history);
      assert.deepEqual(errors,[]);
    }finally{await browser?.close();await host.close();}
  });
}
