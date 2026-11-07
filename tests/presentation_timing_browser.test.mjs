import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root, runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';
import {avDelayOutputMatrix} from './browser/av_delay_output_matrix.mjs';

// Required shared regression: +/-100ms must be distinguished by decoded PCM
// in CI as well as an explicitly selected local run.
const delayMatrix=true;
const delayPlatform=process.env.BILIKARA_AV_DELAY_PLATFORM||'ios';
assert.ok(['ios','desktop'].includes(delayPlatform));
const profile=process.env.BILIKARA_PRESENTATION_PROFILE||'640x360:30';
assert.ok(['640x360:30','1280x720:30','1920x1080:30','1920x1080:60'].includes(profile));
const [dimensions,frameRate]=profile.split(':');

// Compile current native fixtures before measuring browser behavior. Cold Cargo
// preparation has its own bound and must not consume the playback deadline.
let alpha;
before(async () => {
  if (process.platform === 'linux') alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
}, {timeout: 300000});

// Real native HTTP/SSE, split media and separate Host/audience browser contexts.
// Only the OS window relay is a fixture. Linux WebKit and Chromium do not
// qualify macOS WKWebView, Windows WebView2 or physical multiple monitors.
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name} dual-screen clocks preserve media pace without metadata layout work`, {
    skip: process.platform !== 'linux' && 'Linux browser fixture; native desktop acceptance is separate', timeout: 180000,
  }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'bilikara-presentation-timing-'));
    const evidence = process.env.BILIKARA_PRESENTATION_TIMING_EVIDENCE || home;
    mkdirSync(evidence, {recursive: true});
    const errors = [], samples = [], counts = {output: 0, playback: 0};
    let host, browser, main, output;
    try {
      const video = path.join(home, 'video.mp4'), audio = path.join(home, 'audio.m4a');
      for (const [file, args] of [
        [video, ['-f','lavfi','-i',`testsrc2=s=${dimensions}:r=${frameRate}:d=90`,'-c:v','libx264','-preset','ultrafast','-g','120','-pix_fmt','yuv420p','-movflags','+faststart']],
        [audio, ['-f','lavfi','-i',delayMatrix?'aevalsrc=0.2*sin(2*PI*440*t)|0.2*sin(2*PI*(400*t+50*t*t)):s=48000:d=90':'sine=frequency=440:sample_rate=48000:duration=90','-c:a','aac']],
      ]) {
        const result = await runNative('ffmpeg', ['-hide_banner','-loglevel','error','-y',...args,'-threads','4',file], process.env, 30000);
        assert.equal(result.status, 0, result.stderr);
      }
      host = await RunningHost.start(alpha, home,
        [home, process.env.BILIKARA_TEST_STATIC_DIR || path.join(root, 'static'), video, audio, '3'], isolatedEnvironment(home), true);
      browser = await engine.launch({headless: true, ...(name === 'chromium' ? {args: ['--autoplay-policy=no-user-gesture-required']} : {})});
      const mainContext = await browser.newContext({viewport: {width: 1280, height: 800}});
      const audienceContext = await browser.newContext({viewport: {width: 1920, height: 1080}});
      for (const context of [mainContext, audienceContext]) {
        await context.addCookies([...host.cookies].map(([name,value]) => ({name,value,url:host.base})));
        await context.route('**/*', async route => {
          const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
          if(delayMatrix&&context===mainContext&&url.pathname==='/'){
            const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"',`data-host-platform="${delayPlatform}"`)});
          }
          return route.continue();
        });
      }
      const session = {generation:42,mode:'localDualScreen',phase:'active',controllerReady:true,
        playbackAuthority:'host',mediaRendererOwner:'host'};
      await audienceContext.addInitScript(session => {
        const listeners = new Map();
        window.__timingEmit = (name, payload) => { for (const callback of listeners.get(name) || []) callback({payload}); };
        window.__TAURI__ = {
          core:{invoke:async name => {
            if (name === 'get_presentation_session') return session;
            if (name === 'request_presentation_output_state') window.timingReady = true;
          }},
          event:{listen:async (name, callback) => {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
            return () => {};
          }},
        };
      }, session);
      output = await audienceContext.newPage(); main = await mainContext.newPage();
      for (const page of [main, output]) page.on('pageerror', error => errors.push(error.message));
      await output.goto(`${host.base}/controller.html?presentationGeneration=42`);
      await output.waitForFunction(() => window.timingReady);
      await main.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
      await main.goto(host.base);
      await main.waitForFunction(() => state.hostPlaybackSession?.phase === 'playing');
      await main.evaluate(()=>{
        window.timingHostPresentedFrames=0;
        const video=state.hostPlaybackSession.video;
        const presented=()=>{timingHostPresentedFrames++;video.requestVideoFrameCallback(presented);};
        video.requestVideoFrameCallback(presented);
      });
      const readMain = () => main.evaluate(() => {
        const {video,audio} = state.hostPlaybackSession;
        return {wall:Date.now(),video:video.currentTime,audio:audio.currentTime,
          rates:[video.playbackRate,audio.playbackRate],paused:[video.paused,audio.paused],
          frames:window.timingHostPresentedFrames,dropped:video.getVideoPlaybackQuality?.().droppedVideoFrames??null,
          samePair:!window.timingPair || (video===window.timingPair.video && audio===window.timingPair.audio)};
      });
      async function measure(label) {
        const first = await readMain();
        await main.waitForTimeout(5000);
        const last = await readMain(), seconds = (last.wall-first.wall)/1000;
        for (const kind of ['video','audio']) {
          const pace = (last[kind]-first[kind])/seconds;
          assert.ok(pace > .85 && pace < 1.15, `${name} ${label} ${kind} pace ${pace}`);
        }
        assert.deepEqual(last.rates,[1,1]); assert.deepEqual(last.paused,[false,false]); assert.equal(last.samePair,true);
        samples.push({label,first,last});
      }
      await measure('ordinary Host');
      if (name === 'chromium') {
        const cdp = await mainContext.newCDPSession(main);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
      }
      await main.exposeBinding('__timingRelay', async (_, command, args) => {
        if (command === 'publish_presentation_playback_state') { counts.playback++; return args.playbackState; }
        assert.equal(command,'publish_presentation_output_state'); counts.output++;
        await output.evaluate(envelope => window.__timingEmit('bilikara-presentation-output-state',envelope), args.envelope);
      });
      await main.evaluate(session => {
        window.timingPair = {video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};
        const originalInvoke = tauriInvoke;
        tauriInvoke = capability => capability === 'presentation' ? window.__timingRelay : originalInvoke(capability);
        applyPresentationSession({...state.presentationSession,...session});
        applyPresentationCompositionDom(42,'stageOnly');
        window.timingStorageWrites=0; window.timingBrowserMessages=0;
        const setItem=Storage.prototype.setItem, removeItem=Storage.prototype.removeItem;
        Storage.prototype.setItem=function(key,...args){if(key===BilikaraPresentationSync.storageKey)window.timingStorageWrites++;return setItem.call(this,key,...args);};
        Storage.prototype.removeItem=function(key){if(key===BilikaraPresentationSync.storageKey)window.timingStorageWrites++;return removeItem.call(this,key);};
        const post=BroadcastChannel.prototype.postMessage;
        BroadcastChannel.prototype.postMessage=function(...args){if(this.name===BilikaraPresentationSync.channelName)window.timingBrowserMessages++;return post.apply(this,args);};
        publishPresentationOutputState(undefined,{force:true});
      },session);
      await output.waitForFunction(expectedWidth => {
        // WebKit may remain at HAVE_CURRENT_DATA while decoding this complete
        // local MP4. Require real decoded geometry and clock advance instead
        // of assuming its canplay readiness state matches Chromium's.
        const video=document.querySelector('video');return video?.readyState>=2&&video.videoWidth===expectedWidth
          &&!video.paused&&!video.seeking&&video.currentTime>.1;
      },Number(dimensions.split("x")[0]));
      await output.waitForTimeout(1500);
      await output.evaluate(() => {
        window.timingVideo=document.querySelector('video'); window.timingSeekCount=0;
        // GStreamer's sink statistics reset on flush/seek; WebKit exposes that
        // segment counter as totalVideoFrames. Count actual presented frames
        // throughout this measurement instead of sampling the last segment.
        window.timingPresentedFrames=0;
        window.timingFrameSamples=[];
        const presented=(_,frame)=>{
          window.timingPresentedFrames++;
          window.timingFrameSamples.push({time:frame.mediaTime,
            reportedFrames:window.timingVideo.getVideoPlaybackQuality?.().totalVideoFrames});
          window.timingVideo.requestVideoFrameCallback(presented);
        };
        window.timingVideo.requestVideoFrameCallback(presented);
        window.timingEvents=[];
        for(const type of ['seeking','seeked','playing','pause','waiting','stalled','ratechange'])window.timingVideo.addEventListener(type,()=>{
          const v=window.timingVideo;window.timingEvents.push({type,wall:Date.now(),time:v.currentTime,ready:v.readyState,hidden:document.hidden,rate:v.playbackRate});
          if(window.timingEvents.length>100)window.timingEvents.shift();
        });
        window.timingVideo.addEventListener('seeking',()=>window.timingSeekCount++);
        window.timingLayoutReads=0; window.timingMutations=0;
        const bounds=Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect=function(...args){window.timingLayoutReads++;return bounds.apply(this,args);};
        new MutationObserver(records=>{window.timingMutations+=records.length;}).observe(document.getElementById('controller-shell'),
          {childList:true,attributes:true,characterData:true,subtree:true});
      });
      const before={...counts};
      await measure('dual-screen Host');
      const steady = await output.evaluate(() => ({time:window.timingVideo.currentTime,
        seeks:window.timingSeekCount,layoutReads:window.timingLayoutReads,mutations:window.timingMutations,
        rate:window.timingVideo.playbackRate,paused:window.timingVideo.paused,
        frames:window.timingPresentedFrames,
        reportedFrames:window.timingVideo.getVideoPlaybackQuality?.().totalVideoFrames,
        frameSamples:window.timingFrameSamples}));
      const messages={output:counts.output-before.output,playback:counts.playback-before.playback};
      samples.push({label:'steady transport',messages,steady});
      assert.ok(messages.output>=10&&messages.output<=22,JSON.stringify(messages));
      assert.ok(messages.playback>=4&&messages.playback<=7,JSON.stringify(messages));
      assert.equal(steady.layoutReads,0); assert.equal(steady.mutations,0);
      assert.ok(steady.seeks<=2,JSON.stringify(steady)); assert.ok(steady.rate>=.96&&steady.rate<=1.04);assert.equal(steady.paused,false);
      assert.ok(steady.frames>30,'the audience must present actual frames throughout the sample');
      assert.ok(steady.frameSamples.at(-1).time-steady.frameSamples[0].time>3,
        'presented frame timestamps must advance throughout steady playback');
      assert.deepEqual(await main.evaluate(()=>[window.timingStorageWrites,window.timingBrowserMessages]),[0,0]);
      const master = await readMain();assert.ok(Math.abs(steady.time-master.video)<.4,JSON.stringify({steady,master}));
      // Metadata revisions update the UI without rebuilding a playing decoder.
      // Isolate a Host-only decoder hold while the real audio keeps running.
      // The audience must not inherit that internal pause or corrective seek.
      const holdStart=await output.evaluate(()=>({time:timingVideo.currentTime,pauses:timingEvents.filter(e=>e.type==='pause').length}));
      await main.evaluate(()=>{
        const s=state.hostPlaybackSession;clearLocalPlayerSyncTimer(s);
        holdVideoForAudio(s.video);
        publishPresentationOutputState(undefined,{force:true});
      });
      await output.waitForTimeout(1200);
      const held=await output.evaluate(()=>({time:timingVideo.currentTime,paused:timingVideo.paused,pauses:timingEvents.filter(e=>e.type==='pause').length}));
      samples.push({label:'Host-only video hold',before:holdStart,after:held});
      assert.equal(held.paused,false);assert.equal(held.pauses,holdStart.pauses);
      assert.ok(held.time-holdStart.time>.7,'actual audience frames continue while Host video waits');
      await main.evaluate(()=>state.hostPlaybackSession.startSyncTimer());
      await main.waitForFunction(()=>!state.hostPlaybackSession.video.paused);
      await main.evaluate(() => {applyTheme('dark');setLanguage('ja');publishPresentationOutputState(undefined,{force:true});});
      await output.waitForFunction(() => document.documentElement.lang==='ja'&&document.documentElement.dataset.theme==='dark');
      assert.equal(await output.evaluate(()=>document.querySelector('video')===window.timingVideo),true);
      // The transport must retain immediate pause/seek/resume behavior.
      await main.locator('#presentation-host-play').click();
      await output.waitForFunction(()=>window.timingVideo.paused);
      await main.evaluate(()=>{
        elements.presentationHostProgress.value='40';
        elements.presentationHostProgress.dispatchEvent(new Event('input',{bubbles:true}));
        elements.presentationHostProgress.dispatchEvent(new Event('change',{bubbles:true}));
      });
      await output.waitForFunction(()=>!window.timingVideo.seeking&&Math.abs(window.timingVideo.currentTime-40)<.15);
      await main.waitForFunction(()=>!state.hostPlaybackSession.seekSettling);
      await main.locator('#presentation-host-play').click();
      await output.waitForFunction(()=>!window.timingVideo.paused&&window.timingVideo.currentTime>40.3);
      // Keep the original steady-stream pause-count measurement isolated from
      // the deliberate seek/pause transitions in this additional matrix.
      if(delayMatrix)await avDelayOutputMatrix({main,output,host,samples});
      // A quiet/stalled relay cannot make the output extrapolate indefinitely.
      await main.evaluate(()=>{window.__timingRelay=async()=>null;});
      await output.waitForFunction(()=>window.timingVideo.paused,null,{timeout:5000});
      await output.waitForTimeout(150);
      assert.equal(await output.locator('#controller-error').textContent(),'','normal pause or stale-clock cancellation is not an autoplay failure');
      await output.screenshot({path:path.join(evidence,`${name}-audience.png`)});
      await main.screenshot({path:path.join(evidence,`${name}-host.png`)});
      assert.deepEqual(errors,[]);
      writeFileSync(path.join(evidence,`${name}.json`),JSON.stringify({engine:name,version:browser.version(),profile,delayMatrix,fixture:'Linux decoders; native relay fixture, no AirPlay',samples,messages,steady,errors},null,2),'utf8');
    } catch(error) {
      const media=page=>page?.evaluate(()=>[...document.querySelectorAll('video,audio')].map(v=>({kind:v.tagName,time:v.currentTime,
        ready:v.readyState,paused:v.paused,seeking:v.seeking,rate:v.playbackRate,error:v.error?.message}))).catch(()=>null);
      const events=await output?.evaluate(()=>window.timingEvents||[]).catch(()=>[]);
      const hostState=await main?.evaluate(()=>{
        const s=state.hostPlaybackSession;
        return {phase:s?.phase,intent:s?.logicalPlayIntent,shouldPlay:state.localShouldBePlaying,
          delaySignal:typeof readDelaySignal==='function'?readDelaySignal():null,
          pcm:window.delayLastPCM?{...delayLastPCM,values:Array.from(delayLastPCM.values)}:null,
          offsetAlignment:s?.avOffsetAlignment,requestedRate:state.localPlayerRequestedRate,
          pitch:s?.audio?.bilikaraPitch?.snapshot(),trace:state.playbackTrace,
          seekSettling:s?.seekSettling,start:state.localPlaybackStartState,syncTimer:Boolean(s?.syncTimer),
          blocked:[state.localVideoPlaybackBlocked,state.localAudioPlaybackBlocked],
          held:state.localVideoHeldForAudio,deferred:state.localVideoDeferredRecovery,audioRecovering:s?.audioClockRecovering};
      }).catch(()=>null);
      const details={error:String(error),errors,counts,samples,events,hostState,host:await media(main),audience:await media(output)};
      writeFileSync(path.join(evidence,`${name}-failure.json`),JSON.stringify(details,null,2));
      console.error(JSON.stringify(details));
      throw error;
    } finally {
      await browser?.close();
      if (host) {host.kill();await host.finished;}
    }
  });
}
