import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {startAudioFirst} from './media_round_a_support.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runNative} from './desktop_construction_support.mjs';

for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
  test(`${name} Audio-First has no Host video and preserves seek/resume, DSP, track, output and Rust Next`,{timeout:240000},async()=>{
    const home=mkdtempSync(path.join(tmpdir(),'round-a-media-'));
    const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
    // Long enough for all controls under the shared-machine load; EOS is
    // triggered explicitly by seeking to the tail, never by wall-clock luck.
    for(const [file,args] of [[video,['-f','lavfi','-i','testsrc2=s=640x360:r=30:d=90','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']],
      [audio,['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=90','-c:a','aac']]]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,'-threads','4',file],process.env,30000);
      assert.equal(result.status,0,result.stderr);
    }
    const f=await startAudioFirst(engine,video,audio);
    try {
      const {main,output}=f;
      await main.waitForFunction(()=>roundA.player.snapshot().playing);
      await output.waitForFunction(()=>document.querySelector('video').currentTime>.3);
      assert.equal(await main.locator('video').count(),0);
      const original=await main.evaluate(()=>roundA.program);
      const maximumStatusRequests=await main.evaluate(async()=>{
        await roundA.statusRequest;
        const original=roundAPost;let active=0,maximum=0,calls=0;
        window.roundAPost=async(url,body)=>{
          if(url!=='/api/player/status')return original(url,body);
          active++;maximum=Math.max(maximum,active);const call=++calls;
          try {if(call===1)await new Promise(resolve=>setTimeout(resolve,80));return await original(url,body);}
          finally{active--;}
        };
        try {await Promise.all([roundA.report('playing'),roundA.report('playing')]);return maximum;}
        finally{window.roundAPost=original;}
      });
      assert.equal(maximumStatusRequests,1,'fixture status observations cannot overtake one another; Rust stale-status checks stay authoritative');

      const segmentContract=await main.evaluate(()=>{
        let time=90,ended=true,seeking=false,plays=0,pauses=0;
        const video={readyState:2,duration:90,paused:true,get currentTime(){return time;},set currentTime(value){time=value;ended=false;seeking=true;},get ended(){return ended;},get seeking(){return seeking;},pause(){pauses++;},play(){plays++;return Promise.resolve();}};
        const clock={program:roundA.program,rendererEpoch:50,ready:true,mediaTime:89.9,sampledAt:Date.now(),paused:true,playbackRate:1};
        BilikaraAudioFirst.follow(video,clock);
        const stale=BilikaraAudioFirst.follow(video,{...clock,rendererEpoch:49,ready:false});
        return {time,plays,pauses,epoch:video.roundASegment,stale:stale.action};
      });
      assert.equal(segmentContract.time,89.9,'explicit tail seek bypasses steady drift deadband');
      assert.equal(segmentContract.plays,0);assert.equal(segmentContract.epoch,50);assert.equal(segmentContract.stale,'stale-segment');
      for(const milliseconds of [200,-200]) {
        const opening=await main.evaluate(async milliseconds=>{
          const p=roundA.player;p.pause();await p.setAvDelay(milliseconds);await p.seek(0);
          return {snapshot:p.snapshot(),input:p.audio.currentTime};
        },milliseconds);
        assert.equal(opening.snapshot.mediaTime,0,'configured delay must retain video frame zero');
        assert.equal(opening.snapshot.audioSeconds,0,'configured delay must retain audio sample zero');
        assert.equal(opening.input,0,'opening must not seek over the initial audio');
        assert.equal(opening.snapshot.openingSilenceSeconds,Math.max(0,milliseconds/1000));
        await main.evaluate(()=>roundA.player.play());await delay(600);
        assert.ok(await main.evaluate(()=>roundA.player.snapshot().mediaTime)>0);
      }
      await main.evaluate(()=>roundA.player.setAvDelay(0));
      const before=await main.evaluate(()=>roundA.player.snapshot().mediaTime);
      await main.evaluate(()=>roundA.player.pause());await delay(400);
      const paused=await main.evaluate(()=>roundA.player.snapshot().mediaTime);
      await delay(400);assert.ok(Math.abs(await main.evaluate(()=>roundA.player.snapshot().mediaTime)-paused)<.05);
      assert.ok(paused>=before-.1);
      await main.evaluate(()=>roundA.player.play());
      await main.evaluate(()=>roundA.player.seek(6));
      await main.waitForFunction(()=>roundA.player.snapshot().mediaTime>6.2);
      for(const milliseconds of [100,-100,0]) {
        await main.evaluate(value=>roundA.player.setAvDelay(value),milliseconds);
        await f.relay();await delay(650);
        const clocks=await Promise.all([main.evaluate(()=>roundA.player.snapshot()),output.evaluate(()=>({time:document.querySelector('video').currentTime}))]);
        // Coarse transport/recovery check ONLY. This is not A/V qualification;
        // validate-media-timing observes calibrated PCM and decoded barcodes.
        assert.ok(Math.abs(clocks[0].mediaTime-clocks[1].time)<.45,JSON.stringify(clocks));
        assert.ok(Math.abs(clocks[0].mediaTime-clocks[0].audioSeconds-milliseconds/1000)<.001);
      }
      await main.evaluate(()=>roundA.player.setKeyShift(2));
      assert.ok(await main.evaluate(()=>roundA.player.snapshot().dspLatency)>0);
      await main.evaluate(()=>roundA.player.setVolume(.5,true));
      assert.equal(await main.evaluate(()=>roundA.player.gain.gain.value),0);
      await main.evaluate(()=>roundA.player.setVolume(.5,false));
      assert.equal(await main.locator('audio').count(),1,'one active audio input after flush/recovery');
      const unchanged=await f.host.api('/api/state');
      assert.equal(unchanged.playback_generation,original.playback_generation,'renderer seeks do not mint business generations');
      assert.equal(unchanged.history.length,0,'renderer recovery cannot acknowledge EOS');
      // Surface change keeps the actual audio element and AudioContext alive.
      const continuity=await main.evaluate(async()=>{
        const player=roundA.player,context=player.context,audio=player.audio;
        const video=document.createElement('video');document.body.append(video);player.attachSurface(video);
        await new Promise(resolve=>setTimeout(resolve,600));player.detachSurface();video.remove();
        return context===player.context&&audio===player.audio&&player.snapshot().playing;
      });assert.equal(continuity,true);
      // Real Rust selection creates the next generation; renderer binds it.
      await main.evaluate(()=>roundA.transition(async()=>{
        const old=roundA.program,item=roundA.snapshot.current_item;
        await roundAPost('/api/player/audio-variant',{item_id:old.item_id,variant_id:item.audio_variants[1].id,expected_item_incarnation_id:old.item_incarnation_id});
        const restore=roundA.player.snapshot().mediaTime;
        await roundA.load(restore);await roundA.player.play();
      }));
      assert.ok((await main.evaluate(()=>roundA.program.playback_generation))>original.playback_generation);
      const stale=await main.evaluate(old=>roundA.player.valid(old),original);assert.equal(stale,false);
      await main.evaluate(()=>roundA.player.setKeyShift(2));
      await main.evaluate(()=>roundA.player.seek(89));
      await main.waitForFunction(()=>roundA.nextCount===1,null,{timeout:12000});
      assert.notEqual((await main.evaluate(()=>roundA.program.item_id)),original.item_id);
      assert.equal((await f.host.api('/api/state')).history.length,1);
      assert.deepEqual(await main.evaluate(()=>roundA.errors),[]);
      assert.deepEqual(f.errors,[]);
      if(process.env.BILIKARA_ROUND_A_EVIDENCE)await output.screenshot({path:path.join(process.env.BILIKARA_ROUND_A_EVIDENCE,`audio-first-${name}.png`)});
    }catch(error){
      const diagnostic=await f.main.evaluate(()=>({snapshot:roundA.player.snapshot(),trace:roundA.player.executionTrace})).catch(()=>({unavailable:true}));
      console.error(JSON.stringify({engine:name,diagnostic}));throw error;
    }finally{await f.close();}
  });
}
