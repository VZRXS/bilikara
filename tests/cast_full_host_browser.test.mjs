// P9: R1 T6 real-media scenarios use next media_output + ordered player_control_command ACKs.
// Whole production Host page: only HTTP responses are simulated. Media uses
// real decoding, Range requests, renderPlayer, Web Audio and split-player seek.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('production Host restores real media and gain across repeated cast sessions and a program change', { timeout: 90000 }, async t => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  if (process.env.BILIKARA_CAST_TEST_CPU_RATE) {
    const client=await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate',{rate:Number(process.env.BILIKARA_CAST_TEST_CPU_RATE)});
  }
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  async function wait(label, predicate, argument) {
    try { await page.waitForFunction(predicate, argument, {timeout:30000,polling:50}); }
    catch (error) {
      console.error('cast wait failed:', label, await page.evaluate(() => {
        const session=state.hostPlaybackSession;
        const media=node=>node && ({paused:node.paused,time:node.currentTime,seeking:node.seeking,ready:node.readyState,ended:node.ended});
        return {phase:session?.phase,ready:session?.readyCommitted,intent:session?.logicalPlayIntent,seekSettling:session?.seekSettling,
          video:media(session?.video),audio:media(session?.audio),gain:session?.audio?.bilikaraVolumeGain?.gain.value,
          context:state.audioContext?.state,contextTime:state.audioContext?.currentTime,bootstrap:state.hostPlaybackBootstrapRestartPending,
          events:window.castMediaEvents};
      }));
      throw new Error('cast wait failed: '+label,{cause:error});
    }
  }
  await page.addInitScript(() => {
    window.castMediaEvents=[];
    for(const type of ['play','playing','pause','seeking','seeked','ended','loadedmetadata','canplay']) document.addEventListener(type,event=>{
      if(!(event.target instanceof HTMLMediaElement))return;
      castMediaEvents.push({type,media:event.target.tagName,time:event.target.currentTime,at:performance.now()});
      if(castMediaEvents.length>100)castMediaEvents.shift();
    },true);
  });
  let snapshot = {
    state_revision:1, revision:1, playback_generation:1, playback_mode:'local',
    playback_program:null, current_item:null, playlist:[], history:[],
    player_settings:{volume_percent:60, muted:false, song_advance_delay_seconds:0, key_shift:0, av_offset_ms:0},
    media_output:{target:'local',requested_target:'local',status:'stopped',available:true,authorized:true,can_manage:true,busy:false},
    player_control_command:null,
    cast:{phase:'idle',operation_id:0,owns_playback:false,renderers:[],devices:{}},
  };
  let releaseCapabilities, capabilitiesRequested;
  const capabilitiesGate = new Promise(resolve => {releaseCapabilities=resolve;});
  const capabilitiesRequest = new Promise(resolve => {capabilitiesRequested=resolve;});
  t.after(() => releaseCapabilities());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname;
    if (url.origin !== 'http://localhost') return route.abort();
    if (name.startsWith('/api/')) {
      requests.push({name, body:route.request().postDataJSON()});
      if (name === '/api/client/media-capabilities') {
        capabilitiesRequested();
        await capabilitiesGate;
      }
      const data = name === '/api/player/claim-program' ? {claimed:true} : snapshot;
      return route.fulfill({json:{ok:true,data}});
    }
    if (name.startsWith('/media/fixture/')) {
      const video = name.endsWith('.mp4');
      const bytes = readFileSync(new URL(`../rust-runtime/src/native_host/cast_session/fixtures/${video ? 'keyframes-30s.mp4' : 'audio-30s.m4a'}`, import.meta.url));
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]),bytes.length-1) : bytes.length-1;
      return route.fulfill({status:range?206:200,body:bytes.subarray(start,end+1),headers:{
        'content-type':video?'video/mp4':'audio/mp4', 'accept-ranges':'bytes',
        ...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
    }
    const relative = name === '/' ? 'index.html' : name.replace(/^\/(?:static\/)?/, '');
    try {
      const file = new URL(`../static/${relative}`,import.meta.url);
      const root = new URL('../static/',import.meta.url);
      assert.ok(file.href.startsWith(root.href));
      const type = {js:'text/javascript',css:'text/css',json:'application/json',html:'text/html',svg:'image/svg+xml'}[relative.split('.').at(-1)] || 'application/octet-stream';
      return route.fulfill({body:readFileSync(file),contentType:type});
    } catch { return route.fulfill({status:404,body:''}); }
  });
  await page.goto('http://localhost/');
  await wait('initial state', () => state.hasValidStateResponse);
  await capabilitiesRequest;
  assert.equal(await page.evaluate(() => state.hostPlaybackBootstrapRestartPending),true);
  // An accepted initial snapshot precedes capability reporting and bootstrap
  // restart. Injecting a program during that gap retires it; this HTTP fixture
  // intentionally cannot implement the backend's restart/generation mutation.
  // Exercise the gap explicitly, then wait for the real bootstrap to finish.
  const bootstrapped = wait('bootstrap complete', () => state.hasValidStateResponse && !state.hostPlaybackBootstrapRestartPending);
  releaseCapabilities();
  await bootstrapped;
  async function update(patch) {
    snapshot = {...snapshot,...patch,state_revision:snapshot.state_revision+1,revision:snapshot.revision+1};
    await page.evaluate(value => { if (!acceptHostStateSnapshot(value)) throw new Error('snapshot rejected'); render(); }, snapshot);
  }
  let sequence=0;
  async function returnLocal(position,paused,cast) {
    const seek={seq:++sequence,action:'seek-absolute',item_id:snapshot.current_item.id,playback_generation:snapshot.playback_generation,target_seconds:position};
    await update({cast,media_output:{...snapshot.media_output,target:'local',requested_target:'local',status:'stopped'},player_control_command:seek});
    await wait('return seek acknowledged', seq=>state.lastAppliedPlayerControlSeq===seq&&!state.playerControlAckInFlight?.has(seq),seek.seq);
    assert.ok(requests.some(request=>request.name==='/api/player/control-ack'&&request.body.seq===seek.seq));
    const intent={seq:++sequence,action:paused?'pause':'play',item_id:snapshot.current_item.id,playback_generation:snapshot.playback_generation};
    await update({player_control_command:intent});
    await wait('return intent acknowledged',seq=>state.lastAppliedPlayerControlSeq===seq&&!state.playerControlAckInFlight?.has(seq),intent.seq);
    assert.ok(requests.some(request=>request.name==='/api/player/control-ack'&&request.body.seq===intent.seq));
  }
  async function takeNetwork(cast) {
    await update({cast,media_output:{...snapshot.media_output,target:'purek',requested_target:'purek',status:'streaming',desired_playing:true}});
  }
  function program(id) {
    const item = {id, item_incarnation_id:`${id}-incarnation`, selected_audio_variant_id:'original', artifact_set_id:`${id}-artifact`,
      title:id, display_title:id, page:1, cache_status:'ready', video_media_url:'/media/fixture/video.mp4',
      audio_variants:[{id:'original',page:1,label:'Original',audio_url:'/media/fixture/audio.m4a'}]};
    return {current_item:item,playback_program:{item_id:id,item_incarnation_id:item.item_incarnation_id,selected_audio_variant_id:'original',artifact_set_id:item.artifact_set_id}};
  }
  await update({...program('first'),playback_generation:2});
  try {
    await wait('ready', () => state.hostPlaybackSession?.readyCommitted);
    await page.evaluate(async () => {
      const {video,audio} = state.hostPlaybackSession;
      ensureAudioPitchSource(audio);
      applyStoredVolumeToMountedPlayer();
      window.original = {video,audio,session:state.hostPlaybackSession,parents:[video.parentNode,audio.parentNode],gain:audio.bilikaraVolumeGain};
      window.addedMediaListeners = 0;
      for(const media of [video,audio]) {
        const add = media.addEventListener.bind(media);
        media.addEventListener = (...args) => {addedMediaListeners++; return add(...args);};
      }
      await state.audioContext.resume();
      await video.play();
    });
    await wait('initial playing', () => !original.video.paused && !original.audio.paused);
    assert.deepEqual(await page.evaluate(() => [original.video.muted, original.audio.muted, original.gain.bilikaraTarget]), [false,false,0.6]);
    for (let cycle=0; cycle<3; cycle++) {
      const operation = cycle*2+1;
      await takeNetwork({...snapshot.cast,phase:'active',owns_playback:true,operation_id:operation,position:13+cycle*3,duration:30,is_paused:false});
      assert.deepEqual(await page.evaluate(() => [original.video.paused,original.audio.paused,original.video.muted,original.audio.muted,original.gain.bilikaraTarget]), [true,true,false,false,0.6]);
      // next suspends both real decoders and preserves the shared volume graph.
      await wait('retained gain', () => Math.abs(original.gain.gain.value-0.6)<0.001);
      await page.evaluate(() => { original.video.play().catch(()=>{}); });
      await wait('blocked play', () => original.video.paused);
      const paused = cycle === 1;
      await returnLocal(13+cycle*3,paused,{...snapshot.cast,phase:'idle',owns_playback:false,operation_id:operation+1});
      await wait('resume', ({paused,position}) => original.video.paused===paused && original.audio.paused===paused && !original.video.seeking && Math.abs(original.video.currentTime-position)<1, {paused,position:13+cycle*3});
      assert.deepEqual(await page.evaluate(() => [original.video.muted,original.audio.muted,original.gain.bilikaraTarget, state.localPlayerVolume]), [false,false,0.6,0.6]);
      assert.deepEqual(await page.evaluate(() => [state.hostPlaybackSession===original.session,state.hostPlaybackSession.video===original.video,state.hostPlaybackSession.audio===original.audio,original.video.parentNode===original.parents[0],original.audio.parentNode===original.parents[1],original.audio.bilikaraVolumeGain===original.gain,addedMediaListeners]), [true,true,true,true,true,true,0]);
    }
    // Suspending output keeps the receiver and cast operation ID; each return
    // still uses next's ordered seek + intent commands, with fresh sequence IDs.
    for (let cycle=0; cycle<2; cycle++) {
      await takeNetwork({...snapshot.cast,phase:'active',connected:true,output_enabled:true,owns_playback:true,operation_id:6});
      assert.equal(await page.evaluate(() => original.video.paused && original.audio.paused),true);
      const position=10+cycle*3;
      await returnLocal(position,false,{...snapshot.cast,output_enabled:false,owns_playback:false});
      await wait('same-session resume', position => !original.video.paused && !original.audio.paused && !original.video.seeking && Math.abs(original.video.currentTime-position)<1, position);
      assert.deepEqual(await page.evaluate(() => [original.video.muted,original.audio.muted,original.gain.bilikaraTarget,state.hostPlaybackSession.video===original.video,addedMediaListeners]),[false,false,0.6,true,0]);
    }
    await takeNetwork({...snapshot.cast,phase:'active',owns_playback:true,operation_id:7});
    await update({...program('second'),playback_generation:3});
    assert.equal(await page.evaluate(() => state.hostPlaybackSession.video===original.video && original.video.paused && original.audio.paused),true);
    await returnLocal(21,false,{...snapshot.cast,phase:'idle',owns_playback:false,operation_id:8});
    await wait('new program', () => {
      const session = state.hostPlaybackSession;
      return session?.playbackGeneration===3 && session.readyCommitted && !session.video.paused && !session.audio.paused && session.video.currentTime>=21 && session.video.currentTime<24;
    });
    assert.equal(await page.evaluate(() => state.hostPlaybackSession.video===original.video),false,'a new program mounts only after receiver releases playback');
    // A replayed command can retry its ACK but must not replay its seek. A
    // command from the previous program is also acknowledged without effects.
    await update({player_control_command:{...snapshot.player_control_command,action:'seek-absolute',target_seconds:0}});
    assert.ok(await page.evaluate(()=>state.hostPlaybackSession.video.currentTime>=21));
    await update({player_control_command:{seq:++sequence,action:'seek-absolute',item_id:'first',playback_generation:2,target_seconds:0}});
    assert.ok(await page.evaluate(()=>state.hostPlaybackSession.video.currentTime>=21));
    assert.deepEqual(await page.evaluate(() => {
      const invoke = tauriInvoke;
      tauriInvoke = () => async () => { throw Error('physical activation must stay blocked'); };
      state.presentationSession = {...state.presentationSession,mode:'networkRenderer',phase:'active'};
      state.presentationOutputRenderSignature = '';
      renderPresentationOutputControl();
      const result = {checked:elements.presentationOutputButton.getAttribute('aria-checked'),
        disabled:elements.presentationOutputButton.disabled,summary:elements.presentationOutputSummary.textContent,
        off:t('display.outputOff'),active:elements.presentationSettings.classList.contains('is-active')};
      tauriInvoke = invoke;
      return result;
    }), {checked:'false',disabled:true,summary:await page.evaluate(()=>t('display.outputOff')),off:await page.evaluate(()=>t('display.outputOff')),active:false}, 'a native network lease never masquerades as physical dual display, even during release');
    assert.deepEqual(errors,[]);
    assert.ok(requests.some(request => request.name==='/api/player/claim-program'));
    assert.equal(requests.some(request => request.name==='/api/player/restart-program'),false,'test programs must be injected after bootstrap');
  } catch (error) {
    console.error('production cast observation', await page.evaluate(() => ({session:Object.fromEntries(Object.entries(state.hostPlaybackSession||{}).filter(([,value]) => value===null || ['string','number','boolean'].includes(typeof value))),data:state.data,video:state.hostPlaybackSession?.video && {time:state.hostPlaybackSession.video.currentTime,paused:state.hostPlaybackSession.video.paused,error:state.hostPlaybackSession.video.error?.message}})), errors,requests);
    throw error;
  }
});
