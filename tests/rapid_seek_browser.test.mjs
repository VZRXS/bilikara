import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {root, runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

test('rapid native timeline and Host transport seeks retain audible split playback', {
  skip: process.platform !== 'linux' && 'Linux browser fixture; Windows WebView2 acceptance is separate', timeout: 180000,
}, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-rapid-seek-'));
  const evidence = process.env.BILIKARA_SEEK_EVIDENCE;
  if (evidence) mkdirSync(evidence, {recursive: true});
  let browser, host;
  const errors = [], samples = [], httpErrors = [];
  try {
    const video = path.join(home, 'video.mp4'), audio = path.join(home, 'audio.m4a');
    for (const [file, args] of [[video, ['-f','lavfi','-i','testsrc2=s=320x180:r=15:d=90','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-movflags','+faststart']],
      [audio, ['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=90','-c:a','aac']]]) {
      const result = await runNative('ffmpeg', ['-hide_banner','-loglevel','error','-y',...args,file], process.env, 30000);
      assert.equal(result.status, 0, result.stderr);
    }
    host = await RunningHost.start(await buildNativeAlpha(), home,
      [home, process.env.BILIKARA_TEST_STATIC_DIR || path.join(root, 'static'), video, audio, '3'], isolatedEnvironment(home), true);
    browser = await chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const context = await browser.newContext({viewport: {width: 1280, height: 800}});
    await context.addCookies([...host.cookies].map(([name,value]) => ({name,value,url:host.base})));
    await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === host.base) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    async function nativeTimeline() {
      await page.locator('#player-frame video').hover();
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {nodeId:root.nodeId,selector:'#player-frame video'});
      const {node} = await cdp.send('DOM.describeNode', {nodeId,depth:-1,pierce:true});
      const pending = [node];
      while (pending.length) {
        const node = pending.pop();
        if (node.attributes?.includes('-webkit-media-controls-timeline')) {
          const {model} = await cdp.send('DOM.getBoxModel', {backendNodeId:node.backendNodeId});
          return {x:model.content[0],y:(model.content[1]+model.content[5])/2,width:model.content[2]-model.content[0]};
        }
        pending.push(...(node.children || []),...(node.shadowRoots || []));
      }
      throw Error('Actual UA timeline missing');
    }
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type()==='error') errors.push(message.text()); });
    page.on('response', async response => {
      if(response.status()<400)return;
      const url=new URL(response.url());if(url.origin!==host.base)return;
      const body=await response.json().catch(()=>({}));
      httpErrors.push({path:url.pathname,status:response.status(),code:body.code});
    });
    page.on('requestfailed', request => {
      // Native scrubbing legitimately cancels superseded media range fetches.
      if (request.resourceType()==='media' && request.failure()?.errorText==='net::ERR_ABORTED') return;
      errors.push({path:new URL(request.url()).pathname,failure:request.failure()});
    });
    await page.goto(host.base);
    assert.equal(await page.title(), 'bilikara host');
    await page.waitForFunction(() => state.hostPlaybackSession?.phase === 'playing');
    // Hold one actual status request while media events publish newer samples.
    // Only the latest queued observation may follow it; all requests still run
    // through the real Rust sequence/claim checks, without synthetic responses.
    await page.evaluate(()=>state.hostPlaybackSession.playerStatusRequest);
    let releaseStatus,statusSeen;
    const statusGate=new Promise(resolve=>releaseStatus=resolve),firstStatus=new Promise(resolve=>statusSeen=resolve);
    const sequences=[];
    const holdStatus=async route=>{
      sequences.push(route.request().postDataJSON().status_sequence);
      if(sequences.length===1){statusSeen();await statusGate;}
      return route.continue();
    };
    await context.route('**/api/player/status',holdStatus);
    const observe=()=>page.evaluate(()=>{
      const s=state.hostPlaybackSession;s.lastReportedStatusSignature='';
      reportPlayerStatus(state.data.current_item.id,s.video,s);
    });
    try{
      await observe();await firstStatus;await observe();await observe();
      assert.equal(sequences.length,1,'HTTP observations cannot overtake the held sample');
    }finally{releaseStatus();}
    await page.evaluate(()=>state.hostPlaybackSession.playerStatusRequest);
    await context.unroute('**/api/player/status',holdStatus);
    assert.ok(sequences.length>=2);assert.ok(sequences.every((seq,i)=>i===0||seq>sequences[i-1]));
    await page.evaluate(() => {
      const {video, audio} = state.hostPlaybackSession;
      window.seekOriginalPair = {video, audio};
      ensureAudioPitchSource(audio);
      window.seekAnalyser = state.audioContext.createAnalyser();
      audio.bilikaraVolumeGain.connect(window.seekAnalyser);
      window.seekEvents = [];
      for (const media of [video,audio]) for (const type of ['play','playing','pause','seeking','seeked','waiting','stalled','canplay']) {
        media.addEventListener(type, event => {
          const session = state.hostPlaybackSession;
          window.seekEvents.push({kind:media.tagName,type,trusted:event.isTrusted,ready:media.readyState,time:media.currentTime,paused:media.paused,
            phase:session.phase,intent:session.logicalPlayIntent,settling:session.seekSettling,
            internalPause:video.dataset.bilikaraInternalPause,internalSeek:video.dataset.bilikaraInternalSeek});
          if (window.seekEvents.length > 500) window.seekEvents.shift();
        });
      }
    });
    for (const shift of [0,2]) {
      await page.evaluate(shift => setLocalPlayerKeyShift(shift), shift);
      for (const entry of ['native-scrub','native-timeline','host-range','host-relative']) {
        await page.evaluate(entry => {
          if (entry.startsWith('native-')) { applyPresentationCompositionDom(state.presentationSession.generation,'combined');return; }
          // Only the OS composition bridge is a fixture; playback, media,
          // controller actions and native HTTP all remain the real product.
          state.presentationSession = {...state.presentationSession, mode:'localDualScreen',phase:'active',generation:42};
          applyPresentationCompositionDom(42,'stageOnly');
          renderPresentationHostSurface();
        }, entry);
        const timeline = entry === 'native-scrub' ? await nativeTimeline() : null;
        for (let i = 0; i < 8; i++) {
          if (timeline) {
            await page.mouse.move(timeline.x+timeline.width*.3,timeline.y);
            await page.mouse.down();
            await page.mouse.move(timeline.x+timeline.width*(.15+(i%4)*.16),timeline.y,{steps:4});
            await page.mouse.up();
          } else {
            const applied = await page.evaluate(({entry, i}) => {
              const video = state.hostPlaybackSession.video;
              const target = 12 + ((i * 17) % 50);
              const previous = video.currentTime;
              if (entry === 'native-timeline') video.currentTime = target;
              else if (entry === 'host-range') {
                elements.presentationHostProgress.value = String(target);
                elements.presentationHostProgress.dispatchEvent(new Event('input', {bubbles:true}));
                elements.presentationHostProgress.dispatchEvent(new Event('change', {bubbles:true}));
              } else {
                document.querySelector(`[data-presentation-host-action="seek-relative"][data-delta="${i % 2 ? -15 : 15}"]`).click();
              }
              return entry === 'host-relative' ? Math.abs(video.currentTime-previous)>14
                : Math.abs(video.currentTime-target)<.1;
            }, {entry,i});
            assert.equal(applied,true,`${entry} ${i} must apply its real seek action`);
          }
          await page.waitForTimeout(i % 2 ? 15 : 40);
        }
        if (entry === 'native-scrub') {
          await page.waitForFunction(() => {
            const {video,audio}=state.hostPlaybackSession;
            return !video.seeking && !audio.seeking && video.readyState>=3 && audio.readyState>=3 && !state.hostPlaybackSession.seekSettling;
          });
          // Explicit event-order fixture, not a claim of a natural network
          // stall: dispatch after the real decoder is already ready. No media
          // state/clock/play implementation is stubbed, nor is canplay replayed.
          await page.evaluate(() => state.hostPlaybackSession.video.dispatchEvent(new Event('stalled')));
        }
        try {
          const start = await page.evaluate(() => ({video:state.hostPlaybackSession.video.currentTime,audio:state.hostPlaybackSession.audio.currentTime}));
          start.shift=shift;
          await page.waitForFunction(start => {
            const {video,audio} = state.hostPlaybackSession;
            const pcm = new Float32Array(window.seekAnalyser.fftSize);
            window.seekAnalyser.getFloatTimeDomainData(pcm);
            return !video.paused && !audio.paused && !video.seeking && !audio.seeking
              && !state.hostPlaybackSession.seekSettling && state.localShouldBePlaying
              && video.currentTime > start.video+.2 && audio.currentTime > start.audio+.2
              && (!start.shift || (audio.bilikaraPitch?.phase==='active' && audio.bilikaraPitch.applied===start.shift))
              && pcm.some(value => Math.abs(value) > .005);
          }, start, {timeout: 10000});
        } finally {
          samples.push(await page.evaluate(({entry,shift}) => {
            const {video,audio} = state.hostPlaybackSession;
            const pcm = new Float32Array(window.seekAnalyser.fftSize);
            window.seekAnalyser.getFloatTimeDomainData(pcm);
            return {entry,shift,videoTime:video.currentTime,audioTime:audio.currentTime,
              videoPaused:video.paused,audioPaused:audio.paused,seeking:[video.seeking,audio.seeking],
              phase:state.hostPlaybackSession.phase,intent:state.hostPlaybackSession.logicalPlayIntent,
              settling:state.hostPlaybackSession.seekSettling,start:state.localPlaybackStartState,
              blocked:[state.localVideoPlaybackBlocked,state.localAudioPlaybackBlocked],
              pitch:audio.bilikaraPitch?.snapshot(),rms:Math.sqrt(pcm.reduce((sum,v)=>sum+v*v,0)/pcm.length),
              samePair:video===window.seekOriginalPair.video&&audio===window.seekOriginalPair.audio};
          }, {entry,shift}));
          assert.equal(samples.at(-1).samePair,true);
        }
      }
    }
    // A genuinely paused song stays paused through native seeking; an
    // explicit app resume still restores audible output afterwards.
    await page.evaluate(() => {
      const {video,audio}=state.hostPlaybackSession;
      setSplitPlaybackIntent(video,audio,false,{source:'host-pause-intent'});
    });
    await page.waitForFunction(()=>state.hostPlaybackSession.video.paused&&state.hostPlaybackSession.audio.paused);
    for (const target of [10,25,45]) {
      await page.evaluate(target=>{state.hostPlaybackSession.video.currentTime=target;},target);
      await page.waitForTimeout(20);
    }
    await page.waitForFunction(()=>!state.hostPlaybackSession.seekSettling&&!state.hostPlaybackSession.video.seeking&&!state.hostPlaybackSession.audio.seeking);
    assert.deepEqual(await page.evaluate(()=>({intent:state.hostPlaybackSession.logicalPlayIntent,
      paused:[state.hostPlaybackSession.video.paused,state.hostPlaybackSession.audio.paused]})),{intent:false,paused:[true,true]});
    await page.evaluate(()=>{
      const {video,audio}=state.hostPlaybackSession;
      setSplitPlaybackIntent(video,audio,true,{source:'host-resume-intent',userGesture:true});
    });
    await page.waitForFunction(()=>{
      const pcm=new Float32Array(window.seekAnalyser.fftSize);window.seekAnalyser.getFloatTimeDomainData(pcm);
      return !state.hostPlaybackSession.video.paused&&!state.hostPlaybackSession.audio.paused&&pcm.some(value=>Math.abs(value)>.005);
    });
    assert.deepEqual(errors, [],JSON.stringify(httpErrors));
    if (evidence) await page.screenshot({path:path.join(evidence,'rapid-seek-after.png')});
  } finally {
    if (evidence) {
      const events = await browser?.contexts()[0]?.pages()[0]?.evaluate(() => window.seekEvents).catch(() => []);
      const final = await browser?.contexts()[0]?.pages()[0]?.evaluate(() => {
        const s=state.hostPlaybackSession;
        return {phase:s?.phase,video:s?.video&&{ready:s.video.readyState,error:s.video.error?.message},audio:s?.audio&&{ready:s.audio.readyState,error:s.audio.error?.message}};
      }).catch(()=>null);
      writeFileSync(path.join(evidence,'rapid-seek.json'),JSON.stringify({errors,httpErrors,samples,events,final},null,2)+'\n');
    }
    await browser?.close();
    if (host) await host.close();
    rmSync(home,{recursive:true,force:true});
  }
});
