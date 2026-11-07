// Real HTTP/SSE, decoders and Web Audio over the shared Rust Host. The iOS
// platform marker is a fixture: Linux WebKit is not iPhone/WKWebView evidence.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root, runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha;
before(async()=>{
  if (process.platform==='linux') alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
},{timeout:300000});

const cases=[['desktop',false],['android',false],['ios',process.env.BILIKARA_IOS_PLAYBACK_ENGINE==='webkit']];
if (!process.env.BILIKARA_IOS_PLAYBACK_ENGINE) cases.push(['ios',true]);
for (const [platform,useWebKit] of cases) {
  const engineName=useWebKit?'WebKit':'Chromium';
  const evidenceName=`${platform}-${engineName.toLowerCase()}`;
  test(`${platform} ${engineName} fixture: shared split playback preserves clocks and media through volume, offset and track controls`, {
    skip: process.platform !== 'linux' && 'Linux browser fixture; native Apple acceptance is separate', timeout: 180000,
  }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'bilikara-ios-playback-'));
    const evidence = process.env.BILIKARA_IOS_PLAYBACK_EVIDENCE || home;
    mkdirSync(evidence, {recursive: true});
    const errors = [], consoleErrors = [], httpErrors = [], errorResponses=[], samples = [], nextRequests=[], diagnostics=[];
    let replacedTrack=null;
    let browser, host, page;
    try {
      const video = path.join(home, 'video.mp4'), audio = path.join(home, 'audio.m4a');
      for (const [file, args] of [
        [video, ['-f','lavfi','-i','testsrc2=s=640x360:r=30:d=90','-c:v','libx264','-preset','ultrafast','-g','120','-pix_fmt','yuv420p','-movflags','+faststart']],
        // Left channel is the independent pitch reference; right is a linear
        // frequency clock (400+100*t Hz), so actual PCM reveals media position.
        [audio, ['-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*(400*t+50*t*t)):s=48000:d=90','-c:a','aac','-b:a','192k']],
      ]) {
        const result = await runNative('ffmpeg', ['-hide_banner','-loglevel','error','-y',...args,file], process.env, 30000);
        assert.equal(result.status, 0, result.stderr);
      }
      host = await RunningHost.start(alpha, home,
        [home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
      browser = await (useWebKit ? webkit : chromium).launch({headless:true,
        ...(useWebKit ? {} : {args:['--autoplay-policy=no-user-gesture-required']})});
      const context = await browser.newContext({viewport:platform === 'desktop' ? {width:700,height:700} : {width:393,height:844},hasTouch:true});
      await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
      await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
      await context.route('**/*',async route=>{
        const url = new URL(route.request().url());
        if (url.origin !== host.base) return route.abort();
        if (['/', '/index.html'].includes(url.pathname)) {
          const response = await route.fetch();
          const body = (await response.text()).replace('data-host-platform="android"',`data-host-platform="${platform}"`);
          assert.ok(body.includes(`data-host-platform="${platform}"`));
          return route.fulfill({response,body});
        }
        return route.continue();
      });
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{
        if (['error','warning'].includes(message.type())) consoleErrors.push(message.text());
        if (message.type()==='info' && message.text().startsWith('[player-media]')) {
          const payload=message.args()[1];
          if (payload) diagnostics.push(payload.jsonValue().catch(()=>null));
        }
      });
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/player/next')nextRequests.push(request.postDataJSON());});
      page.on('response',response=>{
        if (new URL(response.url()).origin!==host.base || response.status()<400) return;
        const pathname=new URL(response.url()).pathname;
        const body=pathname==='/api/player/status'?response.request().postDataJSON():null;
        const error={path:pathname,status:response.status(),item:body?.item_id,generation:body?.playback_generation,afterNext:nextRequests.length>0,afterTrackChange:replacedTrack!==null};
        httpErrors.push(error);
        errorResponses.push(response.json().then(reply=>{error.code=reply.code;}).catch(()=>{}));
      });
      await page.goto(host.base);
      await page.waitForFunction(()=>state.hostPlaybackSession?.phase === 'playing' && state.hostPlaybackSession.audio.currentTime > .3);
      assert.equal(await page.title(),'bilikara host');
      assert.equal(await page.locator('.app-shell').isVisible(),true);
      assert.equal(await page.locator('vite-error-overlay, nextjs-portal, webpack-dev-server-client-overlay').count(),0);
      assert.equal(await page.locator('#android-host-dock').isVisible(),platform !== 'desktop');
      await page.evaluate(()=>{window.playbackPair={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};});
      const sample = async label=>{
        const value = await page.evaluate(()=>{
          const {video,audio}=state.hostPlaybackSession;
          return {wall:Date.now(),video:video.currentTime,audio:audio.currentTime,paused:[video.paused,audio.paused],
            rate:[video.playbackRate,audio.playbackRate],offset:currentAvOffsetSeconds(),renderAudio:audio.bilikaraAudioClock?.time() ?? audio.currentTime,
            samePair:video===window.playbackPair.video && audio===window.playbackPair.audio,
            volume:state.localPlayerVolume,gain:audio.bilikaraVolumeGain?.gain.value ?? null,
            source:Boolean(audio.bilikaraPitchSource),context:state.audioContext?.state ?? null};
        });
        samples.push({label,...value});return value;
      };
      const start = await sample('initial');
      if(useWebKit){
        await page.evaluate(()=>{
          const {audio}=state.hostPlaybackSession;
          if(!audio.bilikaraVolumeGain)throw Error('iOS WebKit must capture before first playback');
          const analyser=state.audioContext.createAnalyser();
          audio.bilikaraVolumeGain.connect(analyser);
          window.startupAudioProbe={analyser,gain:audio.bilikaraVolumeGain,read:()=>{
            const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
            return Math.sqrt(values.reduce((total,value)=>total+value*value,0)/values.length);
          }};
        });
        await page.waitForFunction(()=>window.startupAudioProbe.read()>.02);
        const startup=[];
        for(let index=0;index<20;index++){
          const value=await page.evaluate(()=>({rms:window.startupAudioProbe.read(),time:state.audioContext.currentTime}));
          startup.push(value);
          assert.ok(value.rms>.02,`Captured audio must remain present during startup: ${JSON.stringify(startup)}`);
          await page.waitForTimeout(100);
        }
        samples.push({label:'decoded startup',values:startup});
        // Control only resume ordering, retaining the real AudioContext,
        // compressed decoder, output gain and PCM observer. A cache wait can
        // leave the shared context suspended when the next start is admitted.
        await page.evaluate(async()=>{
          const session=state.hostPlaybackSession, context=state.audioContext;
          setSplitPlaybackIntent(session.video,session.audio,false,{source:'test-pause-before-context-gap'});
          await context.suspend();
          const resume=context.resume.bind(context);
          let release;
          const gate=new Promise(resolve=>{release=resolve;});
          context.resume=()=>gate;
          window.releaseContextGap=async()=>{context.resume=resume;await resume();release();};
          setSplitPlaybackIntent(session.video,session.audio,true,{source:'test-context-gap-start',userGesture:true});
        });
        assert.equal(await page.evaluate(()=>state.audioContext.state),'suspended');
        await page.evaluate(()=>window.releaseContextGap());
        await page.waitForFunction(()=>state.hostPlaybackSession.phase==='playing'
          && state.hostPlaybackSession.audio.bilikaraAudioClock.isOutputRunning() && startupAudioProbe.read()>.02);
        const recovered=await sample('context-gap recovered');
        await page.waitForFunction(time=>state.hostPlaybackSession.video.currentTime>time+.3,recovered.video);
        assert.equal(recovered.samePair,true);
        await page.evaluate(()=>window.startupAudioProbe.gain.disconnect(window.startupAudioProbe.analyser));
      }
      await page.waitForFunction(time=>state.hostPlaybackSession.video.currentTime > time+1,start.video);
      const running = await sample('advance');
      assert.ok(running.video-start.video > .9);
      assert.ok(running.audio-start.audio > .8);
      assert.deepEqual(running.paused,[false,false]);
      assert.equal(running.samePair,true);
      const showControls = async selector => {
        // The bounded desktop stage may switch from inline controls to its
        // popup as translated setting values change. Use the real opener for
        // each action rather than assuming an earlier layout remains open.
        if (!await page.locator(selector).isVisible()) {
          await page.locator('#stage-controls-toggle').click();
          await page.locator(selector).waitFor({state:'visible'});
        }
      };
      await showControls('#volume-slider');
      // Dispatch the real shared slider's input/change events; no audio or
      // native-volume implementation is replaced by a browser mock.
      const volume = async percent=>{
        await page.locator('#volume-slider').evaluate((node,value)=>{
          node.value=String(value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));
        },percent);
        await page.waitForFunction(value=>state.localPlayerVolume===value
          && state.data.player_settings.volume_percent===Math.round(value*100)
          && state.playerSettingsEchoSuppressUntil===0,percent/100);
      };
      await volume(25);
      // Reproduce an immutable iOS video-volume property without replacing the
      // actual audio decoder, Web Audio gain or authoritative HTTP/SSE Host.
      if (platform === 'ios') {
        await page.evaluate(() => {
          const video = state.hostPlaybackSession.video;
          Object.defineProperty(video, 'volume', {configurable: true, get: () => 1, set() {}});
          applyStoredVolumeToMountedPlayer();
          for (let i = 0; i < 5; i++) video.dispatchEvent(new Event('volumechange'));
        });
        assert.equal(await page.evaluate(() => state.localPlayerVolume), .25);
        assert.equal((await host.api('/api/state')).player_settings.volume_percent, 25);
        await page.evaluate(() => {delete state.hostPlaybackSession.video.volume; applyStoredVolumeToMountedPlayer();});
      }
      let releaseVolume, volumeReached;
      const volumeHeld = new Promise(resolve => {volumeReached = resolve;});
      const volumeRelease = new Promise(resolve => {releaseVolume = resolve;});
      let volumeRequests = 0;
      const holdVolume = async route => {
        volumeRequests++;
        const response = await route.fetch();
        if (volumeRequests === 1) {volumeReached(); await volumeRelease;}
        await route.fulfill({response});
      };
      await context.route('**/api/player/volume', holdVolume);
      await page.evaluate(() => {window.volumeWrites = [setLocalPlayerVolume(.3)];});
      await volumeHeld;
      await page.evaluate(() => {
        window.volumeWrites.push(setLocalPlayerVolume(.5), setLocalPlayerVolume(.8));
        state.playerSettingsEchoSuppressUntil = 0;
        syncLocalPlayerSettingsFromSnapshot({volume_percent: 30, is_muted: false});
      });
      assert.equal(await page.evaluate(() => state.localPlayerVolume), .8);
      releaseVolume();
      await page.evaluate(() => Promise.all(window.volumeWrites));
      assert.equal(volumeRequests, 2, 'send one in-flight request and the coalesced tail');
      assert.equal((await host.api('/api/state')).player_settings.volume_percent, 80);
      await context.unroute('**/api/player/volume', holdVolume);
      await volume(25);
      if (platform === 'ios') {
        await page.waitForFunction(()=>state.audioContext?.state === 'running' && state.hostPlaybackSession.audio.bilikaraVolumeGain?.gain.value < .26);
        await page.evaluate(()=>{
          const gain=state.hostPlaybackSession.audio.bilikaraVolumeGain;
          window.playbackGain=gain;
          window.playbackSplitter=state.audioContext.createChannelSplitter(2);
          gain.connect(window.playbackSplitter);
          window.playbackAnalyser=state.audioContext.createAnalyser();
          window.playbackSplitter.connect(window.playbackAnalyser,0);
          window.playbackTimeAnalyser=state.audioContext.createAnalyser();
          window.playbackTimeAnalyser.fftSize=8192;window.playbackTimeAnalyser.smoothingTimeConstant=0;
          window.playbackSplitter.connect(window.playbackTimeAnalyser,1);
          window.readPlaybackTime=()=>{
            const bins=new Float32Array(window.playbackTimeAnalyser.frequencyBinCount);
            window.playbackTimeAnalyser.getFloatFrequencyData(bins);
            let peak=1;for(let i=2;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
            const hz=peak*state.audioContext.sampleRate/window.playbackTimeAnalyser.fftSize;
            return {time:(hz-400)/100+window.playbackTimeAnalyser.fftSize/state.audioContext.sampleRate/2,db:bins[peak]};
          };
          window.playbackRms=()=>{
            const bytes=new Float32Array(window.playbackAnalyser.fftSize);
            window.playbackAnalyser.getFloatTimeDomainData(bytes);
            return Math.sqrt(bytes.reduce((total,value)=>total+value*value,0)/bytes.length);
          };
        });
        // Read a rendered analyser window after the gain ramp, using the audio
        // clock. Wall-clock timers alone do not prove rendering has advanced
        // on a busy runner. Keep the decoded-gain ratio assertion unchanged.
        const rms=async()=>{
          const start=await page.evaluate(()=>state.audioContext.currentTime);
          await page.waitForFunction(start=>{
            const {audio}=state.hostPlaybackSession, clock=audio.bilikaraAudioClock;
            const rendered=.015*8+window.playbackAnalyser.fftSize/state.audioContext.sampleRate;
            return (!clock || clock.running&&!clock.holding)
              && state.audioContext.currentTime-start>=rendered;
          },start);
          return page.evaluate(async()=>{
          const values=[];
          for(let index=0;index<12;index++){
            await new Promise(resolve=>setTimeout(resolve,50));
            values.push({rms:window.playbackRms(),time:state.audioContext.currentTime,
              gain:state.hostPlaybackSession.audio.bilikaraVolumeGain.gain.value});
          }
          return {median:values.map(v=>v.rms).sort((a,b)=>a-b)[6],values};
          });
        };
        await page.waitForFunction(()=>window.playbackRms()>.005);
        const quietWindow=await rms(), quiet=quietWindow.median;
        await volume(100);
        await page.waitForFunction(()=>state.hostPlaybackSession.audio.bilikaraVolumeGain.gain.value>.99);
        const fullWindow=await rms(), full=fullWindow.median;
        samples.push({label:'decoded PCM',quiet,full,quietWindow,fullWindow});
        assert.ok(full/quiet>3 && full/quiet<5,`Actual decoded gain ratio ${full/quiet}: ${JSON.stringify({quietWindow,fullWindow})}`);
        await volume(0);
        await page.waitForFunction(()=>window.playbackRms()<.0001);
        await volume(25);
        await page.waitForFunction(()=>window.playbackRms()>.005);
        assert.equal(await page.evaluate(()=>state.hostPlaybackSession.audio.bilikaraVolumeGain===window.playbackGain),true);
        // Real context suspension + synthetic visibility are software lifecycle
        // inputs, not an assertion about iOS background scheduling or routes.
        await page.evaluate(async()=>{
          Object.defineProperty(document, 'visibilityState', {configurable:true, value:'hidden'});
          document.dispatchEvent(new Event('visibilitychange'));
          await state.audioContext.suspend();
          Object.defineProperty(document, 'visibilityState', {configurable:true, value:'visible'});
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForFunction(()=>state.audioContext.state==='running' && playbackRms()>.005
          && state.hostPlaybackSession.logicalPlayIntent
          && !state.hostPlaybackSession.video.paused && !state.hostPlaybackSession.audio.paused
          && !state.hostPlaybackSession.video.seeking && !state.hostPlaybackSession.audio.seeking
          && !state.hostPlaybackSession.seekSettling
          && (!state.hostPlaybackSession.audio.bilikaraAudioClock
            || (state.hostPlaybackSession.audio.bilikaraAudioClock.isOutputRunning()
              && !state.hostPlaybackSession.audio.bilikaraAudioClock.pending)), null, {timeout:5000});
        const foreground=await sample('foreground decoded audio recovered');
        await page.waitForFunction(time=>state.hostPlaybackSession.video.currentTime>time+.3, foreground.video);
        assert.equal(foreground.samePair,true);
        assert.ok(Math.abs(foreground.video-foreground.renderAudio-foreground.offset)<.3);
        await page.evaluate(async()=>{
          const context=state.audioContext;
          await context.suspend();
          const resume=context.resume.bind(context);
          window.restoreForegroundResume=()=>{context.resume=resume;};
          context.resume=()=>Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.locator('.split-playback-start-button').waitFor({state:'visible'});
        assert.equal(await page.evaluate(()=>state.hostPlaybackSession.logicalPlayIntent),true);
        await page.evaluate(()=>restoreForegroundResume());
        await page.locator('.split-playback-start-button').click();
        await page.waitForFunction(()=>state.audioContext.state==='running' && playbackRms()>.005
          && !state.hostPlaybackSession.audio.paused && !state.hostPlaybackSession.video.paused).catch(async error=>{
            throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(()=>({phase:state.hostPlaybackSession.phase,start:state.localPlaybackStartState,intent:state.hostPlaybackSession.logicalPlayIntent,context:state.audioContext.state,rms:playbackRms(),audio:{paused:state.hostPlaybackSession.audio.paused,time:state.hostPlaybackSession.audio.currentTime,clock:state.hostPlaybackSession.audio.bilikaraAudioClock?.snapshot?.()},video:{paused:state.hostPlaybackSession.video.paused,time:state.hostPlaybackSession.video.currentTime},trace:diagnosticPlayerInfo().trace})))}`);
          });
        assert.equal((await sample('foreground gesture decoded audio recovered')).samePair,true);
        await page.evaluate(async()=>{
          const context=state.audioContext;
          await context.suspend();
          const resume=context.resume.bind(context);
          window.restorePendingForegroundResume=()=>{context.resume=resume;};
          context.resume=()=>new Promise(()=>{});
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.locator('.split-playback-start-button').waitFor({state:'visible',timeout:3000});
        await page.evaluate(()=>restorePendingForegroundResume());
        await page.locator('.split-playback-start-button').click();
        await page.waitForFunction(()=>state.audioContext.state==='running' && playbackRms()>.005
          && !state.hostPlaybackSession.audio.paused && !state.hostPlaybackSession.video.paused);
        assert.equal((await sample('pending foreground promise released by user gesture')).samePair,true);
        await page.evaluate(()=>delete document.visibilityState);

      } else {
        assert.equal((await sample('native attenuation')).source,false);
        assert.equal(await page.evaluate(()=>state.hostPlaybackSession.audio.volume),.25);
      }
      await page.locator('#volume-mute-button').click();
      await page.waitForFunction(()=>state.hostPlaybackSession.audio.muted
        && state.data.player_settings.is_muted && state.playerSettingsEchoSuppressUntil===0);
      if (platform === 'ios') await page.waitForFunction(()=>window.playbackRms()<.0001);
      await page.locator('#volume-mute-button').click();
      await page.waitForFunction(()=>!state.hostPlaybackSession.audio.muted
        && !state.data.player_settings.is_muted && state.playerSettingsEchoSuppressUntil===0);
      if (platform === 'ios') await page.waitForFunction(()=>window.playbackRms()>.005);
      for (const offset of [400,-400,0]) {
        await showControls('#av-offset-input');
        await page.locator('#av-offset-input').fill(String(offset));
        await page.locator('#av-offset-input').press('Enter');
        await page.waitForFunction(value=>!state.avOffsetSaving && currentAvOffsetMs()===value,offset);
        await page.waitForFunction(()=>{
          const {video,audio}=state.hostPlaybackSession;
          const time=audio.bilikaraAudioClock?.time() ?? audio.currentTime;
          return !video.seeking && !audio.seeking && Math.abs(video.currentTime-time-currentAvOffsetSeconds())<.25;
        });
        if (platform==='ios') {
          // Require actual decoded content to agree continuously. A mapped
          // clock alone must never make a silent/out-of-sync stream pass.
          await page.waitForTimeout(200);
          for(let index=0;index<5;index++){
            const pcm=await page.evaluate(()=>({pcm:window.readPlaybackTime(),video:state.hostPlaybackSession.video.currentTime,offset:currentAvOffsetSeconds()}));
            assert.ok(pcm.pcm.db>-80,'Time-coded PCM must actually be present');
            assert.ok(Math.abs(pcm.video-pcm.pcm.time-pcm.offset)<.25,JSON.stringify(pcm));
            samples.push({label:`decoded offset ${offset}`,...pcm});
            await page.waitForTimeout(100);
          }
        }
        assert.equal((await sample(`offset ${offset}`)).samePair,true);
      }
      if (await page.locator('#stage-controls-close').isVisible()) {
        await page.locator('#stage-controls-close').click();
        await page.locator('#stage-control-tray').waitFor({state:'hidden'});
      }
      // Exercise the actual shared playback action: the presentation transport
      // is intentionally hidden in ordinary single-screen Host mode.
      await page.evaluate(()=>toggleMountedLocalPlayback());
      await page.waitForFunction(()=>state.hostPlaybackSession.video.paused && state.hostPlaybackSession.audio.paused);
      if (platform==='ios') {
        await page.waitForFunction(()=>window.playbackRms()<.0001);
        const before=await sample('paused');await page.waitForTimeout(250);
        const after=await sample('still paused');
        assert.ok(Math.abs(after.renderAudio-before.renderAudio)<.03);
      }
      const control=async(action,target)=>{
        const identity=await page.evaluate(()=>({item_id:state.data.current_item.id,playback_generation:state.data.playback_generation}));
        await host.api('/api/player/control',{action,...identity,...(target===undefined?{}:{target_seconds:target})});
      };
      await control('seek-absolute',15);
      await page.waitForFunction(()=>!state.hostPlaybackSession.seekSettling && !state.hostPlaybackSession.video.seeking
        && Math.abs(state.hostPlaybackSession.video.currentTime-15)<.15);
      assert.equal(await page.evaluate(()=>state.hostPlaybackSession.video.paused),true);
      if (platform==='ios') await page.waitForFunction(()=>window.playbackRms()<.0001);
      await page.evaluate(()=>toggleMountedLocalPlayback());
      await page.waitForFunction(()=>!state.hostPlaybackSession.video.paused && !state.hostPlaybackSession.audio.paused);
      await control('seek-absolute',18);await control('seek-absolute',22);
      await page.waitForFunction(()=>!state.hostPlaybackSession.seekSettling && state.hostPlaybackSession.video.currentTime>22.1);
      if (platform==='ios') {
        await page.waitForTimeout(250);
        const pcm=await page.evaluate(()=>({pcm:window.readPlaybackTime(),video:state.hostPlaybackSession.video.currentTime}));
        assert.ok(pcm.pcm.db>-80 && Math.abs(pcm.video-pcm.pcm.time)<.25,JSON.stringify(pcm));
        samples.push({label:'decoded rapid seek',...pcm});
      }
      assert.equal((await sample('seek retained pair')).samePair,true);
      // Track selection commits through the same NativeHost API. Both fixture
      // variants contain the same signal; this checks selection/ownership and
      // decoded resumption, not the correctness of a provider's accompaniment.
      replacedTrack=await page.evaluate(()=>({item:state.data.current_item.id,generation:state.data.playback_generation}));
      await page.locator('#audio-variant-bar [data-variant-id="p2_instrumental"]').click();
      await page.waitForFunction(()=>state.data.current_item.selected_audio_variant_id==='p2_instrumental'
        && state.hostPlaybackSession?.phase==='playing' && state.hostPlaybackSession.audio.currentSrc.endsWith('/instrumental.m4a')
        && !state.hostPlaybackSession.video.paused && !state.hostPlaybackSession.audio.paused);
      const track=await sample('track changed');assert.deepEqual(track.paused,[false,false]);
      await showControls('#key-shift-input');
      await page.locator('#key-shift-input').fill('2');
      await page.locator('#key-shift-input').press('Enter');
      await page.waitForFunction(()=>state.data.player_settings.key_shift===2
        && state.hostPlaybackSession.audio.bilikaraPitch?.snapshot().state==='active'
        && state.hostPlaybackSession.audio.bilikaraPitch?.snapshot().applied===2);
      // Read the real Signalsmith output, not only its requested parameter.
      await page.evaluate(()=>{
        const {audio,video}=state.hostPlaybackSession;
        const analyser=state.audioContext.createAnalyser();analyser.fftSize=16384;
        const splitter=state.audioContext.createChannelSplitter(2);audio.bilikaraVolumeGain.connect(splitter);splitter.connect(analyser,0);
        window.playbackTimeAnalyser=state.audioContext.createAnalyser();
        window.playbackTimeAnalyser.fftSize=8192;window.playbackTimeAnalyser.smoothingTimeConstant=0;
        splitter.connect(window.playbackTimeAnalyser,1);
        window.pitchTimeSplitter=splitter;
        window.readPitchTime=()=>{
          const bins=new Float32Array(window.playbackTimeAnalyser.frequencyBinCount);window.playbackTimeAnalyser.getFloatFrequencyData(bins);
          let peak=1;for(let i=2;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
          const ratio=2**((audio.bilikaraPitch?.snapshot().applied || 0)/12);
          const hz=peak*state.audioContext.sampleRate/window.playbackTimeAnalyser.fftSize/ratio;
          return {time:(hz-400)/100+window.playbackTimeAnalyser.fftSize/state.audioContext.sampleRate/2,db:bins[peak]};
        };
        window.readPitchReference=()=>{
          const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);
          let peak=1;for(let index=2;index<bins.length;index++)if(bins[index]>bins[peak])peak=index;
          return peak*state.audioContext.sampleRate/analyser.fftSize;
        };
        window.pitchReferenceAnalyser=analyser;
        window.pitchPair={video,audio};window.pitchGraph=audio.bilikaraVolumeGain;
      });
      // Routing can prime again while its asynchronous start is acknowledged.
      // Collect a full rendered FFT window after active output, rather than
      // assuming that 600ms on the wall clock means the graph was active.
      await page.waitForFunction(()=>{
        const audio=state.hostPlaybackSession.audio;
        if(audio.bilikaraPitch?.snapshot().state!=='active'||audio.paused||audio.seeking){window.pitchRenderStart=null;return false;}
        window.pitchRenderStart ??= state.audioContext.currentTime;
        return state.audioContext.currentTime-window.pitchRenderStart >= window.pitchReferenceAnalyser.fftSize/state.audioContext.sampleRate;
      });
      const pitch=await page.evaluate(()=>{
        const frequency=window.readPitchReference();
        window.pitchTimeSplitter.disconnect(window.pitchReferenceAnalyser);
        return {frequency,snapshot:state.hostPlaybackSession.audio.bilikaraPitch.snapshot()};
      });
      const expected=440*2**(2/12);
      assert.ok(Math.abs(pitch.frequency-expected)<10,`Actual pitch ${pitch.frequency}Hz, expected ${expected}Hz`);
      samples.push({label:'decoded pitch',...pitch});
      for(let index=0;index<5;index++){
        const pcm=await page.evaluate(()=>({pcm:window.readPitchTime(),video:state.hostPlaybackSession.video.currentTime,offset:currentAvOffsetSeconds()}));
        assert.ok(pcm.pcm.db>-80 && Math.abs(pcm.video-pcm.pcm.time-pcm.offset)<.25,JSON.stringify(pcm));
        samples.push({label:'decoded pitch sync',...pcm});await page.waitForTimeout(100);
      }
      await page.locator('#key-shift-reset-button').click();
      await page.waitForFunction(()=>state.data.player_settings.key_shift===0 && state.hostPlaybackSession.audio.bilikaraPitch?.snapshot().applied===0);
      assert.equal(await page.evaluate(()=>state.hostPlaybackSession.audio===window.pitchPair.audio
        && state.hostPlaybackSession.video===window.pitchPair.video && state.hostPlaybackSession.audio.bilikaraVolumeGain===window.pitchGraph),true);
      if (await page.locator('#stage-controls-close').isVisible()) await page.locator('#stage-controls-close').click();
      if(useWebKit){
        const next=nextRequests;
        await page.evaluate(()=>{
          window.endingPair={...window.pitchPair,clock:state.hostPlaybackSession.audio.bilikaraAudioClock};
          window.tailSamples=[];
          const sampleTail=()=>{
            const pair=window.endingPair;
            window.tailSamples.push({clock:pair.clock.time(),duration:pair.audio.duration,inputEnded:pair.audio.ended,sourceEnded:pair.clock.inputEnded,
              pcm:window.readPitchTime(),item:state.data.current_item.id,phase:state.hostPlaybackSession.phase,intent:state.hostPlaybackSession.logicalPlayIntent,
              videoPaused:pair.video.paused,observed:observedHostPlayerStatus(state.data.current_item.id,state.hostPlaybackSession,state.hostPlaybackSession.video)});
          };
          window.tailTimer=setInterval(sampleTail,50);
          // Decoder read-ahead varies: an EOS/output gap can be shorter than
          // Playwright's poll interval. Pause at the real input event instead
          // of assuming a fixed 200ms queue. Keep the actual PCM assertions.
          window.tailPaused=false;
          window.endingPair.audio.addEventListener('ended',()=>{
            sampleTail();toggleMountedLocalPlayback();window.tailPaused=true;
          },{once:true,capture:true});
        });
        await control('seek-absolute',88);
        await page.waitForFunction(()=>window.tailPaused);
        assert.equal(next.length,0,'Input EOS cannot advance before the queued output is played');
        const paused=await page.evaluate(()=>window.endingPair.clock.time());
        await page.waitForTimeout(250);
        assert.equal(next.length,0,'Pausing the tail cancels automatic completion');
        assert.ok(Math.abs(await page.evaluate(()=>window.endingPair.clock.time())-paused)<.03);
        await page.evaluate(()=>toggleMountedLocalPlayback());
        await page.waitForFunction(()=>state.data.current_item.id==='fixture-second');
        assert.equal(next.length,1,'Output completion advances exactly once');
        const tail=await page.evaluate(()=>{clearInterval(window.tailTimer);return window.tailSamples;});
        const audibleTail=tail.filter(s=>s.item==='fixture-first' && s.pcm.db!==null && s.pcm.db>-80 && (s.inputEnded || s.sourceEnded));
        assert.ok(audibleTail.some(s=>s.pcm.time>s.duration-.25),'The final time-coded PCM must actually reach the output');
        samples.push({label:'input/output EOS',tail});
        assert.ok(audibleTail.some(s=>s.observed?.observed_phase==='playing'),'Remote status remains playing while queued output is audible');
        await page.evaluate(()=>{window.endingPair.audio.dispatchEvent(new Event('seeked'));window.endingPair.audio.dispatchEvent(new Event('ended'));});
        await page.waitForTimeout(150);assert.equal(next.length,1,'Retired media callbacks cannot advance the new song');
      }
      await page.screenshot({path:path.join(evidence,`${evidenceName}-playback.png`)});
      const finalSnapshot=await host.api('/api/state');
      await Promise.all(errorResponses);
      const staleStatus=error=>error.path==='/api/player/status' && error.status===409 && error.code==='stale_player'
        && error.item==='fixture-first' && Number.isSafeInteger(error.generation) && error.generation<finalSnapshot.playback_generation
        && ((error.afterTrackChange && error.item===replacedTrack?.item && error.generation===replacedTrack.generation)
          || (useWebKit && error.afterNext));
      // Replacing the selected track also retires a program. Only an exact
      // stale_player rejection from a retired program is an expected negative;
      // same-generation/order failures and all other HTTP errors still fail.
      const retiredStatus=httpErrors.filter(staleStatus);
      assert.deepEqual(errors,[]);assert.deepEqual(httpErrors.filter(error=>!staleStatus(error)),[]);
      assert.deepEqual(consoleErrors.filter(message=>!/^Failed to load resource:/.test(message)),[]);
      writeFileSync(path.join(evidence,`${evidenceName}.json`),JSON.stringify({platform,engine:engineName,evidence:'Linux browser fixture',samples,errors,httpErrors,retiredStatus,consoleErrors},null,2),'utf8');
    } catch (error) {
      const player=await page?.evaluate(()=>{
        const s=state.hostPlaybackSession;
        const clock=s?.audio.bilikaraAudioClock;
        return {phase:s?.phase,item:state.data?.current_item?.id,tailSamples:window.tailSamples,settings:state.data?.player_settings,clock:clock?{time:clock.time(),running:clock.running,pending:clock.pending,holding:clock.holding,resumeWanted:clock.resumeWanted,needsReposition:clock.needsReposition}:null,media:[...document.querySelectorAll('audio,video')].map(node=>({kind:node.tagName,time:node.currentTime,paused:node.paused,ready:node.readyState,seeking:node.seeking,error:node.error?.code})),pitch: s?.audio.bilikaraPitch?.snapshot?.()};
      }).catch(()=>null);
      writeFileSync(path.join(evidence,`${evidenceName}-failure.json`),JSON.stringify({error:String(error),player,samples,diagnostics:await Promise.all(diagnostics),errors,httpErrors,consoleErrors},null,2),'utf8');
      throw error;
    } finally {
      await browser?.close();
      if (host) await host.close();
    }
  });
}

test('WebKit resumed EOS rejects the old native end cursor and renders the remaining PCM [P1-MEDIA-1 P1-MEDIA-2]', {
  skip: process.platform !== 'linux', timeout: 90000,
}, async () => {
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-eos-cursor-'));
  const evidence=process.env.BILIKARA_IOS_PLAYBACK_EVIDENCE||home;
  mkdirSync(evidence,{recursive:true});
  let host,browser,page;const errors=[],consoleErrors=[],next=[];
  try {
    const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
    for(const [file,args]of [
      [video,['-f','lavfi','-i','testsrc2=s=320x180:r=24:d=8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart']],
      [audio,['-f','lavfi','-i','aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*(400*t+50*t*t)):s=48000:d=8','-c:a','aac','-b:a','192k']],
    ]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,file],process.env,30000);
      assert.equal(result.status,0,result.stderr);
    }
    host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),video,audio,'2'],isolatedEnvironment(home),true);
    browser=await webkit.launch();const context=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
      if(url.pathname==='/'){
        const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});
      }
      return route.continue();
    });
    page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(['error','warning'].includes(message.type())&&consoleErrors.length<64)consoleErrors.push(message.text().replace(/https?:\/\/[^\s)]+/g,'[url]').slice(0,500));});
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/player/next')next.push(request.postDataJSON());});
    await page.goto(host.base);await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
    await page.evaluate(()=>{
      const {audio,video}=state.hostPlaybackSession,clock=audio.bilikaraAudioClock,gain=audio.bilikaraVolumeGain;
      const splitter=state.audioContext.createChannelSplitter(2),analyser=state.audioContext.createAnalyser();
      analyser.fftSize=8192;analyser.smoothingTimeConstant=0;gain.connect(splitter);splitter.connect(analyser,1);
      window.eosProbe={audio,video,clock,gain,samples:[],paused:false};
      const sample=()=>{
        const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);
        let peak=1;for(let index=2;index<bins.length;index++)if(bins[index]>bins[peak])peak=index;
        eosProbe.samples.push({at:performance.now(),clock:clock.time(),duration:audio.duration,
          pcm:(peak*state.audioContext.sampleRate/analyser.fftSize-400)/100+analyser.fftSize/state.audioContext.sampleRate/2,
          db:bins[peak],inputEnded:clock.inputEnded,item:state.data.current_item.id,
          sameGraph:state.hostPlaybackSession.audio===audio&&audio.bilikaraAudioClock===clock&&audio.bilikaraVolumeGain===gain});
      };
      eosProbe.timer=setInterval(sample,20);
      audio.addEventListener('ended',()=>{sample();toggleMountedLocalPlayback();eosProbe.paused=true;},{once:true,capture:true});
    });
    const identity=await page.evaluate(()=>({item_id:state.data.current_item.id,playback_generation:state.data.playback_generation}));
    await host.api('/api/player/control',{action:'seek-absolute',target_seconds:6,...identity});
    await page.waitForFunction(()=>eosProbe.paused);assert.equal(next.length,0);
    const paused=await page.evaluate(()=>eosProbe.clock.time());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(()=>eosProbe.clock.time()),paused);assert.equal(next.length,0);
    await page.evaluate(()=>toggleMountedLocalPlayback());
    await page.waitForFunction(()=>eosProbe.clock.running&&!eosProbe.clock.pending&&!eosProbe.audio.seeking);
    await page.evaluate(()=>{
      // Controlled native-event delivery. The compressed decoder and output
      // signal stay real; an old EOS cursor must not own the resumed segment.
      eosProbe.audio.currentTime=eosProbe.audio.duration;
      eosProbe.audio.dispatchEvent(new Event('seeking'));
    });
    await page.waitForFunction(()=>state.data.current_item.id==='fixture-second');
    const observed=await page.evaluate(()=>{clearInterval(eosProbe.timer);return {samples:eosProbe.samples};});
    assert.equal(next.length,1);
    assert.ok(observed.samples.filter(s=>s.item==='fixture-first').every(s=>s.sameGraph),'The active source, gain and clock stay mounted');
    assert.ok(observed.samples.some(s=>s.item==='fixture-first'&&s.inputEnded&&s.db!==null&&s.db>-80&&s.pcm>s.duration-.25),'Actual remaining time-coded PCM must precede next');
    assert.deepEqual(errors,[]);
    writeFileSync(path.join(evidence,'eos-native-cursor.json'),JSON.stringify({evidenceClass:'BROWSER-TESTED',
      fixture:'Linux WebKit with controlled native cursor event; DEVICE-UNVERIFIED',engine:'webkit',engineVersion:browser.version(),
      os:process.platform,architecture:process.arch,commit:process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      workingTreeModified:Boolean(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()),
      clockSourceSha256:createHash('sha256').update(readFileSync(path.join(root,'static/audio-clock.js'))).digest('hex'),
      ...observed,errors,consoleErrors},null,2)+'\n');
  } catch(error) {
    const samples=await page?.evaluate(()=>eosProbe?.samples).catch(()=>null);
    writeFileSync(path.join(evidence,'eos-native-cursor-failure.json'),JSON.stringify({error:String(error),samples,errors,consoleErrors},null,2)+'\n');
    throw error;
  } finally {
    await browser?.close();if(host)await host.close();rmSync(home,{recursive:true,force:true});
  }
});
