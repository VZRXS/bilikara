// Browser plugin is unavailable. Actual Rust Host + prepared L1 companion and
// decoded MPEG-TS/HLS; only the OS window relay is a fixture. No device gate.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before} from 'node:test';
import {createHash} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {RunningHost,isolatedEnvironment,waitFor,HttpClient} from './native_host_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
let alpha;
before(async()=>{if(process.platform==='linux')alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();},{timeout:300000});

test('local TS decoder stays pinned with its upstream license',()=>{
  const directory=path.join(root,'static/vendor/hls'),source=JSON.parse(readFileSync(path.join(directory,'sources.json'),'utf8'));
  assert.equal(source.repository,'https://github.com/video-dev/hls.js');assert.equal(source.version,'1.6.15');
  for(const [file,hash]of Object.entries(source.files))assert.equal(createHash('sha256').update(readFileSync(path.join(directory,file))).digest('hex'),hash);
  assert.match(readFileSync(path.join(directory,'LICENSE'),'utf8'),/Apache License/);
});
for(const engine of [chromium,webkit])test(`${engine.name()} real standalone L1 admission and supported single/dual decoder lifetime`,{skip:process.platform!=='linux',timeout:120000},async t=>{
 const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;assert.ok(companion&&existsSync(companion),'actual native L1 companion is required');
 const home=mkdtempSync(path.join(tmpdir(),'bilikara-native-output-'));let host,browser;
 t.after(async()=>{try{await browser?.close();}finally{try{await host?.close();}finally{rmSync(home,{recursive:true,force:true});}}});
 const files=[];
 for(const [fixture,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
  // A copied loop repeats AAC priming/edit boundaries on FFmpeg 8, leaving
  // real PCM timestamp holes. This positive fixture needs one continuous
  // sample clock; the real malformed-gap rejection has its own native test.
  const encoding=name==='audio.m4a'?['-af','asetpts=N/SR/TB','-c:a','aac']:['-c','copy'];
  const file=path.join(home,name),result=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',fixture),'-t','60',...encoding,'-movflags','+faststart',file],process.env,30000);
  assert.equal(result.status,0,result.stderr);files.push(file);
 }
 const env=isolatedEnvironment(home);env.BILIKARA_TEST_NATIVE_ALPHA_COMPANION=companion;
 host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),...files,'3'],env,true);
 browser=await engine.launch({headless:true,...(engine===chromium?{args:['--autoplay-policy=no-user-gesture-required']}:{})});
 const context=await browser.newContext({viewport:{width:393,height:852},hasTouch:true});
 await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
 await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
 await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
 const errors=[],requests=[],startup=[],page=await context.newPage();page.on('crash',()=>console.log('NATIVE_OUTPUT_PAGE_CRASH'));page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.includes('/api/player/'))requests.push(p);});
 page.on('response',async response=>{
   const request=response.request(),pathname=new URL(response.url()).pathname;
   if(!/^\/api\/player\/output(?:-preview)?$/.test(pathname)&&pathname!=='/api/state')return;
   const body=await response.json().catch(()=>({}));
   if(pathname==='/api/state'&&body.data?.media_output?.target!=='native')return;
   startup.push({path:pathname,method:request.method(),status:response.status(),error:body.error,generation:body.data?.generation,period:body.data?.period,output:body.data?.media_output});
 });
 await page.goto(host.base);assert.equal(await page.title(),'bilikara host');
 await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
 await page.evaluate(()=>{window.webPair={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};});
 const remote=new HttpClient(host.base);await remote.request('/remote');
 assert.equal((await remote.request('/api/player/output',{target:'native',experimental:true})).status,403);
 assert.equal((await host.request('/api/player/output',{target:'native'})).status,400);
 await page.locator('[data-android-page="my"]').click();
 const target=page.locator('[data-media-output="settings"] .media-output-targets');assert.equal(await target.locator('input').isEnabled(),true);
 const kind=await page.evaluate(()=>BilikaraNativeOutput.decoderKind());
 let decoderLoads=0;
 if(kind==='mse')await page.route('**/vendor/hls/hls.light.min.js',route=>++decoderLoads===1?route.abort():route.continue());
 await target.click();
 if(kind==='unavailable'){
   // Linux GTK WebKit lacks native HLS. It must reject this experimental
   // sink explicitly before stopping the working Web player. Apple hardware
   // native HLS is a separate device gate; no simulated decoder acceptance.
   assert.equal(engine.name(),'webkit');
   assert.equal(await page.evaluate(()=>document.createElement('video').canPlayType('application/vnd.apple.mpegurl')),'');
   await page.waitForFunction(()=>document.querySelector('[data-media-output="settings"] .media-output-status').textContent===t('mediaOutput.actionFailed'));
   assert.ok((await page.locator('#purek-info .media-output-error').textContent()).includes(await page.evaluate(()=>t('mediaOutput.decoderUnavailable'))));
   assert.equal((await host.api('/api/state')).media_output.target,'local');
   assert.deepEqual(await page.evaluate(()=>({same:webPair.video===state.hostPlaybackSession.video&&webPair.audio===state.hostPlaybackSession.audio,playing:!webPair.video.paused&&!webPair.audio.paused})),{same:true,playing:true});
   assert.deepEqual(requests.filter(path=>path==='/api/player/output'),[]);assert.deepEqual(errors,[]);return;
 }
 if(kind==='mse'){
   try {await page.waitForFunction(()=>state.data.media_output.last_error==='purek_output_preview_decode');}
   catch(error){
     const diagnostic={decoderLoads,requests,startup,errors,hostOutput:(await host.api('/api/state')).media_output,browser:await page.evaluate(()=>({output:state.data.media_output,decoder:state.nativeOutputPreview?.diagnostics(),hasPreview:Boolean(state.nativeOutputPreview),hasVideo:Boolean(state.nativeOutputPreview?.video()),pollInFlight:state.statePollInFlight,pollLease:state.statePollLease,pollAborted:state.statePollController?.signal.aborted,renderSignatureMatches:state.lastPollRenderSignature===renderSignatureForData(state.data)}))};
     console.log('NATIVE_OUTPUT_STARTUP_DIAGNOSTIC',JSON.stringify(diagnostic));
     const evidence=process.env.BILIKARA_IOS_PLAYBACK_EVIDENCE||(process.env.RUNNER_TEMP&&path.join(process.env.RUNNER_TEMP,'bilikara-shared-playback'));
     if(evidence){
       const directory=path.join(evidence,'native-output-'+engine.name());mkdirSync(directory,{recursive:true});
       writeFileSync(path.join(directory,'startup.json'),JSON.stringify(diagnostic,null,2)+'\n');
       // Only generated fixture inputs, never the Host home/cookies/checkpoint.
       for(const file of files)copyFileSync(file,path.join(directory,path.basename(file)));
       await page.screenshot({path:path.join(directory,'startup.png')});
     }
     throw error;
   }
   assert.equal(await page.locator('[data-media-output="settings"] .media-output-retry').isVisible(),true);
   await page.locator('[data-media-output="settings"] .media-output-retry').click();
 }
 const playing=()=>page.waitForFunction(()=>{const v=state.nativeOutputPreview?.video();return state.data?.media_output?.status==='streaming'&&v?.currentTime>.05&&!v.paused&&!v.ended&&v.videoWidth>0;});
 await playing();
 if(kind==='mse')assert.equal(decoderLoads,2,'an explicit retry reloads a failed decoder asset');
 console.log('DECODER_CAPABILITIES',await page.evaluate(()=>({decoder:state.nativeOutputPreview.video().currentSrc.startsWith('blob:')?'mse':'native-hls',combined:globalThis.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),video:globalThis.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E"'),audio:globalThis.MediaSource?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')})));
 await page.evaluate(()=>{window.nativeSource=state.nativeOutputPreview.video().currentSrc;});
 const first=await host.api('/api/state');assert.equal(first.media_output.target,'native');assert.equal(first.media_output.authorized,false);assert.equal(first.media_output.pipeline_level,'L1');assert.equal(first.media_output.qualified,false);
 assert.equal(await page.locator('#purek-modal').isVisible(),false);
 assert.deepEqual(await page.evaluate(()=>({same:webPair.video===state.hostPlaybackSession.video&&webPair.audio===state.hostPlaybackSession.audio,paused:webPair.video.paused&&webPair.audio.paused})),{same:true,paused:true});
 const preview=await host.api('/api/player/output-preview');
 assert.equal((await host.request('/api/player/output-preview',{generation:preview.generation,phase:'ended'})).status,409,'producer is not finished; premature decoder EOF cannot advance');
 assert.equal((await remote.request('/api/player/output-preview')).status,403);
 assert.equal((await remote.request(preview.url)).status,403);
 const publicState=await remote.api('/api/state');assert.ok(!JSON.stringify(publicState).includes(preview.url));
 const control=async(action,extra={})=>{const s=await host.api('/api/state');await host.api('/api/player/control',{action,item_id:s.current_item.id,playback_generation:s.playback_generation,...extra});};
 await control('pause');await page.waitForFunction(()=>state.data.media_output.status==='paused'&&state.nativeOutputPreview.video().paused);
 assert.equal((await host.api('/api/state')).media_output.last_error,null,'intentional pause is not a decoder failure');
 await control('play');await playing();
 const resumed=await host.api('/api/player/output-preview');assert.notEqual(resumed.generation,preview.generation);
 assert.equal(resumed.url,preview.url,'local mode keeps one private HLS session across run periods');
 assert.equal((await host.request(preview.url)).status,200);
 assert.equal((await host.request(preview.native_url)).status,410,'native system players cannot keep a retired run playlist');
 await control('seek-absolute',{target_seconds:8});await waitFor(async()=>{const s=await host.api('/api/state');return s.media_output.position>=8&&s.media_output.stream_generation>resumed.generation;},'authoritative seek consumption and new pipeline');await playing();
 assert.ok((await host.api('/api/state')).media_output.position>=8);
 // A separate actual audience decoder consumes the same pipeline. The relay
 // replaces only native window IPC, never Host commands or media responses.
 const audienceContext=await browser.newContext({viewport:{width:1280,height:720}});
 await audienceContext.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
 const session={generation:42,mode:'localDualScreen',phase:'active',controllerReady:true,playbackAuthority:'host',mediaRendererOwner:'host'};
 await audienceContext.addInitScript(session=>{
  const listeners=new Map();
  window.emit=(name,payload)=>{for(const fn of listeners.get(name)||[])fn({payload});};
  window.__TAURI__={
   core:{invoke:async name=>{if(name==='get_presentation_session')return session;if(name==='request_presentation_output_state')window.ready=true;}},
   event:{listen:async(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);return()=>{};}},
  };
 },session);
 const audience=await audienceContext.newPage();audience.on('pageerror',e=>errors.push(e.message));await audience.goto(host.base+'/controller.html?presentationGeneration=42');await audience.waitForFunction(()=>window.ready);
 await page.exposeBinding('relay',async(_source,command,args)=>{if(command==='publish_presentation_playback_state')return args.playbackState;assert.equal(command,'publish_presentation_output_state');await audience.evaluate(envelope=>emit('bilikara-presentation-output-state',envelope),args.envelope);});
 await page.evaluate(session=>{const original=tauriInvoke;tauriInvoke=capability=>capability==='presentation'?window.relay:original(capability);applyPresentationSession({...state.presentationSession,...session});applyPresentationCompositionDom(42,'stageOnly');renderPresentationHostSurface();publishPresentationOutputState(undefined,{force:true});},session);
 await audience.waitForFunction(()=>{const v=document.querySelector('video');return v?.currentTime>.1&&v.videoWidth>0&&!v.paused&&!v.muted;});
 assert.equal(await page.evaluate(()=>state.nativeOutputPreview.video().muted),true,'only the Audience sink emits sound');
 assert.equal(await page.evaluate(()=>{
   const original=relayPresentationOutputState;relayPresentationOutputState=()=>false;
   const before=localStorage.getItem(BilikaraPresentationSync.storageKey);
   publishPresentationOutputState(undefined,{force:true});relayPresentationOutputState=original;
   return localStorage.getItem(BilikaraPresentationSync.storageKey)===before;
 }),true,'a private pipeline URI never enters the storage fallback');
 await page.evaluate(()=>{applyPresentationSession({...state.presentationSession,mode:'singleScreen',phase:'inactive'});applyPresentationCompositionDom(42,'singleScreen');renderPresentationHostSurface();});
 assert.equal(await page.evaluate(()=>state.nativeOutputPreview.video().muted),false);
 await audienceContext.close();
 await host.api('/api/player/output',{target:'local'});
 await page.waitForFunction(()=>state.data.media_output.target==='local'&&state.hostPlaybackSession.phase==='playing'&&!state.hostPlaybackSession.audio.paused);
 assert.equal(await page.evaluate(()=>webPair.video===state.hostPlaybackSession.video&&webPair.audio===state.hostPlaybackSession.audio),true);
 assert.equal(await page.locator('.native-output-video').isVisible(),false);
 await page.evaluate(()=>{window.nativeSink=document.querySelector('.native-output-video');});
 assert.ok([404,410].includes((await host.request(preview.url)).status),'leaving the local pipeline retires its capability');
 await host.api('/api/player/output',{target:'native',experimental:true});await playing();
 assert.equal(await page.evaluate(()=>nativeSink===state.nativeOutputPreview.video()),true,'reuse the mounted decoder through mode changes');
 await control('next-track');await page.waitForFunction(id=>state.data.current_item?.id!==id&&state.data.media_output.target==='native',first.current_item.id);await playing();
 assert.equal(await page.evaluate(()=>state.nativeOutputPreview.video().currentSrc===nativeSource),true,'all native mode periods retain the same MediaSource');
 // Observe decoded audio from the actual muxed output, not only a moving clock.
 await page.evaluate(async()=>{const video=state.nativeOutputPreview.video(),context=new AudioContext();await context.resume();const source=context.createMediaElementSource(video),analyser=context.createAnalyser();source.connect(analyser);analyser.connect(context.destination);window.outputPcm={context,read:()=>{const x=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(x);return Math.sqrt(x.reduce((s,n)=>s+n*n,0)/x.length);}};});
 await page.waitForFunction(()=>outputPcm.read()>.001);
 const beforeTail=await host.api('/api/state');
 await control('seek-absolute',{target_seconds:58});
 try {await waitFor(async()=>{const s=await host.api('/api/state');return s.current_item.id!==beforeTail.current_item.id;},'decoder-consumed native tail advances exactly once',20000);}
 catch(error){console.log('NATIVE_OUTPUT_DIAGNOSTIC',await page.evaluate(()=>({output:state.data.media_output,decoder:state.nativeOutputPreview.diagnostics()})));throw error;}
 await playing();
 assert.equal((await host.api('/api/state')).current_item.id,beforeTail.playlist[0].id,'only the immediate next track is selected');
 assert.ok(!requests.includes('/api/purek/connect'));assert.deepEqual(errors,[]);
});
