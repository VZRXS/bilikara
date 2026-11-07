// Actual decoders/Signalsmith/PCM and the shipped Host with a separately
// rendered Audience. OS output routing is a bridge fixture, never AirPlay proof.
import assert from 'node:assert/strict';
import {installPCMChirpClock} from './pcm_chirp_clock.mjs';

export async function avDelayOutputMatrix({main,output,host,samples,engine}) {
  const control=async(action,target)=>{
    const identity=await main.evaluate(()=>({item_id:state.data.current_item.id,playback_generation:state.data.playback_generation}));
    await host.api('/api/player/control',{action,...identity,...(target===undefined?{}:{target_seconds:target})});
  };
  await control('seek-absolute',20);
  await main.waitForFunction(()=>!state.hostPlaybackSession.seekSettling&&state.hostPlaybackSession.video.currentTime>20);
  if(await main.evaluate(()=>document.documentElement.dataset.hostPlatform==='desktop')){
    // Begin on native unity volume. WebKit's first AV edit prepares its
    // captured-output workaround. Chromium retains its native unity route
    // until DSP is requested; require that route rather than a WebKit workaround.
    // Both engines still run the complete captured PCM matrix below.
    assert.ok(['chromium','webkit'].includes(engine));
    assert.equal(await main.evaluate(()=>Boolean(state.hostPlaybackSession.audio.bilikaraPitchSource)),false);
    for(const offset of [100,0,-100,0,400,-400,0]){
      await main.evaluate(value=>dispatchAvDelayAction({type:'set_effective',effective_delay_ms:value}),offset);
      await main.waitForFunction(()=>!state.hostPlaybackSession.avOffsetAlignment
        &&!state.hostPlaybackSession.video.paused&&!state.hostPlaybackSession.audio.paused,null,{timeout:5000});
      const clocks=await main.evaluate(()=>{
        const {video,audio}=state.hostPlaybackSession;return{video:video.currentTime,audio:(audio.bilikaraAudioClock?.time()??audio.currentTime)-(audio.bilikaraOutputDelay?.seconds()||0),
          offset:currentAvOffsetSeconds(),captured:Boolean(audio.bilikaraPitchSource),rates:[video.playbackRate,audio.playbackRate]};
      });
      assert.ok(Math.abs(clocks.video-clocks.audio-clocks.offset)<.05,JSON.stringify(clocks));
      assert.equal(clocks.captured,engine==='webkit');assert.deepEqual(clocks.rates,[1,1]);
      samples.push({label:'native-unity AV alignment; physical sound unverified',engine,...clocks});
    }
  }
  await main.evaluate(installPCMChirpClock);
  await main.evaluate(async()=>{
    const {audio,video}=state.hostPlaybackSession;ensureAudioPitchSource(audio);await state.audioContext.resume();
    window.delayOriginal={audio,video,gain:audio.bilikaraVolumeGain,context:state.audioContext};
    const splitter=state.audioContext.createChannelSplitter(2);audio.bilikaraVolumeGain.connect(splitter);
    window.delayAnalysers=[0,1].map(channel=>{const a=state.audioContext.createAnalyser();a.fftSize=8192;a.smoothingTimeConstant=0;splitter.connect(a,channel);return a;});
    window.readDelaySignal=()=>{
      const {audio,video}=state.hostPlaybackSession;
      const channels=delayAnalysers.map(a=>{const pcm=new Float32Array(a.fftSize);a.getFloatTimeDomainData(pcm);return Math.sqrt(pcm.reduce((s,v)=>s+v*v,0)/pcm.length);});
      const a=delayAnalysers[1],bins=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(bins);
      let peak=1;for(let i=2;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
      const shift=audio.bilikaraPitch?.snapshot().applied||0,ratio=2**(shift/12);
      const fftTime=(peak*state.audioContext.sampleRate/a.fftSize/ratio-400)/100+a.fftSize/state.audioContext.sampleRate/2;
      const pcm=new Float32Array(a.fftSize);a.getFloatTimeDomainData(pcm);
      const pcmTime=readPCMChirpTime(pcm,state.audioContext.sampleRate,ratio);
      window.delayLastPCM={values:pcm,sampleRate:state.audioContext.sampleRate,ratio,
        contextTime:state.audioContext.currentTime,videoTime:video.currentTime};
      return {channels,pcmTime,fftTime,pcmDb:bins[peak],video:video.currentTime,audio:audio.currentTime,
        output:audio.bilikaraAudioClock?.time()??audio.currentTime,offset:currentAvOffsetSeconds(),
        context:state.audioContext.state,intent:state.hostPlaybackSession.logicalPlayIntent,
        paused:[video.paused,audio.paused],pending:Boolean(audio.bilikaraAudioClock?.pending),holding:Boolean(audio.bilikaraAudioClock?.holding),
        pitch:shift,gain:audio.bilikaraVolumeGain.gain.value,
        rates:[video.playbackRate,audio.playbackRate],requestedRate:state.localPlayerRequestedRate,
        same:audio===delayOriginal.audio&&video===delayOriginal.video&&audio.bilikaraVolumeGain===delayOriginal.gain&&state.audioContext===delayOriginal.context};
    };
  });
  const delay=async value=>main.evaluate(value=>dispatchAvDelayAction({type:'set_effective',effective_delay_ms:value}),value);
  for(const pitch of [0,2]){
    await main.evaluate(value=>setLocalPlayerKeyShift(value),pitch);
    if(pitch)await main.waitForFunction(()=>state.hostPlaybackSession.audio.bilikaraPitch?.snapshot().state==='active');
    for(const offset of [100,0,-100,0,400,-400,0]){
      const start=Date.now();await delay(offset);
      await main.waitForFunction(()=>{
        const s=readDelaySignal();
        return s.intent&&s.context==='running'&&s.paused.every(p=>!p)&&!s.pending&&!s.holding
          &&!state.hostPlaybackSession.avOffsetAlignment&&s.channels.every(r=>r>.005);
      },null,{timeout:5000});
      // Require stable decoded output for a complete FFT window. A WebKit
      // decoder may stall just after its first aligned/readiness callback.
      await main.evaluate(()=>{window.delayStableSince=null;});
      await main.waitForFunction(()=>{
        const s=readDelaySignal(),now=state.audioContext.currentTime;
        const stable=!state.hostPlaybackSession.avOffsetAlignment&&!s.pending&&!s.holding
          &&s.paused.every(v=>!v)&&s.rates.every(v=>v===1)&&s.channels.every(v=>v>.005)
          &&s.pcmDb>-80&&Math.abs(s.video-s.pcmTime-s.offset)<.08;
        if(!stable){delayStableSince=null;return false;}
        if(delayStableSince===null)delayStableSince=now;
        return now-delayStableSince>.35;
      },null,{timeout:5000});
      const frames=await output.evaluate(()=>timingPresentedFrames);
      await output.waitForFunction(frames=>!timingVideo.paused&&!timingVideo.seeking&&timingVideo.readyState>=2
        &&timingPresentedFrames>frames,frames,{timeout:5000});
      const signal=await main.evaluate(()=>readDelaySignal());
      const audience=await output.evaluate(()=>({time:timingVideo.currentTime,paused:timingVideo.paused,seeks:timingSeekCount,
        frames:timingPresentedFrames,dropped:timingVideo.getVideoPlaybackQuality?.().droppedVideoFrames??null}));
      assert.ok(signal.same&&signal.intent,JSON.stringify(signal));
      assert.deepEqual(signal.rates,[1,1]);assert.equal(signal.requestedRate,1);
      assert.ok(signal.channels.every(r=>r>.005)&&signal.pcmDb>-80,JSON.stringify(signal));
      // 350ms can accept both +100ms and -100ms as the same output. Require
      // independent decoded PCM to distinguish those requested adjustments.
      const precision=[];
      for(let i=0;i<5;i++){
        const s=await main.evaluate(()=>readDelaySignal());
        assert.ok(s.pcmDb>-80&&s.channels.every(r=>r>.005),JSON.stringify(s));
        precision.push(s.video-s.pcmTime-s.offset);
        await main.waitForTimeout(60);
      }
      const error=precision.reduce((sum,v)=>sum+v,0)/precision.length;
      assert.ok(Math.abs(error)<.08,JSON.stringify({pitch,offset,error,precision,signal}));
      assert.equal(audience.paused,false);
      samples.push({label:'dual-screen AV Delay decoded output',pitch,offset,recovery_ms:Date.now()-start,signal,audience,precision,error,drift_seconds:audience.time-signal.video});
    }
    // Repeated real commands share one queue; none may inherit a previous seek's pause.
    await main.evaluate(()=>Promise.all([100,-100,100,0].map(effective_delay_ms=>dispatchAvDelayAction({type:'set_effective',effective_delay_ms}))));
    await main.waitForFunction(()=>readDelaySignal().channels.every(r=>r>.005)&&!readDelaySignal().pending);
    await control('pause');await main.waitForFunction(()=>state.hostPlaybackSession.audio.paused&&state.hostPlaybackSession.video.paused);
    for(const offset of [100,-100,0]){
      await delay(offset);assert.deepEqual(await main.evaluate(()=>readDelaySignal().paused),[true,true]);
      assert.equal(await main.evaluate(()=>state.hostPlaybackSession.logicalPlayIntent),false);
    }
    await control('seek-absolute',25);
    await main.waitForFunction(()=>!state.hostPlaybackSession.seekSettling);
    await control('play');await main.waitForFunction(()=>readDelaySignal().channels.every(r=>r>.005)&&readDelaySignal().intent);
  }
  await main.evaluate(()=>setLocalPlayerKeyShift(0));
  const trace=await main.evaluate(()=>diagnosticPlayerInfo().trace);
  assert.ok(trace.length>0&&trace.length<=256);
  assert.ok(trace.some(s=>s.event==='av-delay-change'&&s.previous_offset_ms!==null));
  assert.ok(!JSON.stringify(trace).includes('/media/'));
  samples.push({label:'bounded AV-delay recovery trace',trace});
}
