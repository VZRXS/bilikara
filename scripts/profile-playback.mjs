// Reproducible software-only Linux profile of the actual Rust Host and shared
// shipped UI. Does not qualify WebView2, Android hardware, UIKit or AirPlay.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,readdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {tmpdir,cpus,hostname,networkInterfaces,getPriority,release} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {distribution,installProfileObserver,instrumentController} from './profile-observer.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,webkit} from 'playwright';
import {root,runNative} from '../tests/desktop_construction_support.mjs';
import {buildNativeAlpha} from '../tests/native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment,waitFor} from '../tests/native_host_support.mjs';

assert.equal(process.platform,'linux','This process sampler uses Linux /proc; native platform profiles are separate');
const args=process.argv.slice(2),value=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
const engineName=value('--engine','chromium'),engine={chromium,webkit}[engineName];assert.ok(engine);
const profile=value('--profile','1280x720:30');assert.ok(['1280x720:30','1920x1080:30','1920x1080:60'].includes(profile));
const seconds=Number(value('--seconds','20'));assert.ok(Number.isInteger(seconds)&&seconds>=10&&seconds<=1800);
const output=path.resolve(value('--output',''));assert.ok(args.includes('--output'),'Choose an explicit evidence directory outside the checkout');
assert.ok(!output.startsWith(root+path.sep)&&output!==root);
const staticDirectory=realpathSync(value('--static-dir',path.join(root,'static')));
const frontendRoot=path.dirname(staticDirectory);
assert.equal(path.basename(staticDirectory),'static','Use an actual checkout static directory');
const fixtureCache=args.includes('--fixture-cache')?path.resolve(value('--fixture-cache','')):null;
if(fixtureCache){assert.ok(fixtureCache!==root&&!fixtureCache.startsWith(root+path.sep));assert.ok(fixtureCache!==output&&!fixtureCache.startsWith(output+path.sep)&&!output.startsWith(fixtureCache+path.sep));}
const modes=value('--modes','idle,single,dual,dlna-l0,dlna-l1,native-single,native-dual').split(',');
assert.ok(modes.length&&modes.every(m=>['idle','single','dual','dlna-l0','dlna-l1','native-single','native-dual'].includes(m)));
const repeats=Number(value('--repeats','1'));assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=10);
const experiment=value('--dual-experiment','baseline');assert.ok(['baseline','pause','retire','static'].includes(experiment));
const overlay=value('--overlay','off');assert.ok(['on','off'].includes(overlay));
const qrBytes=Number(value('--qr-bytes','0'));assert.ok(Number.isInteger(qrBytes)&&qrBytes>=0&&qrBytes<=524288);
const worker=value('--hls-worker','off');assert.ok(['on','off'].includes(worker));
const actions=args.includes('--actions');
const audible=args.includes('--audible');
const cpuProfile=args.includes('--cpu-profile');assert.ok(!cpuProfile||engineName==='chromium','CDP CPU profiles require Chromium');
const frameObserver=value('--frame-observer','on');assert.ok(['on','counters'].includes(frameObserver));
const workerPolicy=value('--worker-policy','production');assert.ok(['production','allow-blob'].includes(workerPolicy));
const effects=value('--effects','baseline');assert.ok(['baseline','flat'].includes(effects));
assert.ok(experiment==='baseline'||modes.every(mode=>mode==='dual'),'decode diagnostics apply only to ordinary dual mode');
const viewport=key=>{const parts=value(key,key==='--host-viewport'?'1280x800':'1920x1080').split('x').map(Number);assert.ok(parts.length===2&&parts.every(n=>Number.isInteger(n)&&n>=320&&n<=4096));return{width:parts[0],height:parts[1]};};
const hostViewport=viewport('--host-viewport'),audienceViewport=viewport('--audience-viewport');
assert.equal(value('--build-mode','dev'),'dev','The current companion admission is a debug harness; do not mislabel it release');
const durationSeconds=Math.max(90,seconds+30);
mkdirSync(output,{recursive:true});
assert.ok(!existsSync(path.join(output,'profile.json')),'Preserve an existing profile; choose a new evidence directory');
const alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
const hzResult=await runNative('getconf',['CLK_TCK'],process.env,10000);assert.equal(hzResult.status,0,hzResult.stderr);
const hz=Number(hzResult.stdout.trim());assert.ok(hz>0);
const home=mkdtempSync(path.join(tmpdir(),'bilikara-profile-'));
const mediaDirectory=fixtureCache?path.join(fixtureCache,profile.replace(':','-')+'-d'+durationSeconds):home;
mkdirSync(mediaDirectory,{recursive:true});
const fixtureManifest=path.join(mediaDirectory,'fixture.json');
const targetKbps=profile==='1280x720:30'?2000:profile==='1920x1080:30'?5000:8000;
const metadata={evidenceClass:'SOFTWARE-PROFILE',machine:hostname(),platform:process.platform,architecture:process.arch,
  audibleOutputRequested:audible,
  osRelease:release(),buildMode:'dev',cpu:cpus()[0].model,logicalCpus:cpus().length,engine:engineName,engineVersion:null,profile,seconds,
  cpuAffinity:readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],nice:getPriority(),
  softwareDecoding:true,hardwareDecode:'disabled; not device evidence',hostViewport,audienceViewport,repeats,experiment,overlay,qrBytes,worker,workerPolicy,actions,effects,frameObserver,cpuProfile,
  fixture:{durationSeconds,video:'H.264',videoTargetKbps:targetKbps,audio:'AAC',audioKbps:192},
  sourceCommit:(await runNative('git',['rev-parse','HEAD'],process.env,10000,root)).stdout.trim(),
  sourceDirty:Boolean((await runNative('git',['status','--porcelain'],process.env,10000,root)).stdout.trim()),
  backend:'Rust NativeHost isolated fixture harness',nativeDesktopShell:false,
  note:'Software decoding, no physical displays/receiver. Dual-screen OS IPC and DLNA receiver are independent local fixtures. CPU=100% per logical core. PSS avoids double-counting shared pages. Warm steady windows exclude builds, generation, startup and shutdown. No URLs, cookies or bootstrap credentials recorded.',modes:[]};
metadata.trackedDiffSha256=createHash('sha256').update((await runNative('git',['diff','HEAD','--binary'],process.env,10000,root)).stdout).digest('hex');
metadata.loadAverageStart=readFileSync('/proc/loadavg','utf8').split(' ').slice(0,3).map(Number);
metadata.limits={audioUnderruns:'unavailable; media waiting/stalled are not PCM proof',physicalOutput:'not measured',nativeCpuFlamegraph:'not captured',receiverCpu:'synthetic consumer excluded'};
metadata.limits.frameCounters='decoded is the legacy field name for browser totalVideoFrames, not a decoder-thread count; seek/source counter resets can invalidate endpoint deltas';
const [size,fps]=profile.split(':');
const video=path.join(mediaDirectory,'video.mp4'),audio=path.join(mediaDirectory,'audio.m4a');
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
let reusedFixture=false;
if(fixtureCache&&existsSync(fixtureManifest)){
  const saved=JSON.parse(readFileSync(fixtureManifest,'utf8'));assert.equal(saved.profile,profile);assert.equal(saved.durationSeconds,durationSeconds);
  for(const [kind,file]of [['video',video],['audio',audio]]){assert.ok(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink());assert.equal(digest(file),saved.sha256[kind],'preserve the exact benchmark bitstream');}
  reusedFixture=true;
}else if(fixtureCache){assert.ok(!existsSync(video)&&!existsSync(audio),'keep an interrupted fixture for diagnosis; choose a new cache');}

if(!reusedFixture)for(const [file,input,codec]of [[video,`testsrc2=s=${size}:r=${fps}:d=${durationSeconds}`,['-c:v','libx264','-preset','veryfast','-b:v',`${targetKbps}k`,'-maxrate',`${targetKbps}k`,'-bufsize',`${targetKbps*2}k`,'-g',fps,'-pix_fmt','yuv420p']],
  [audio,`sine=frequency=440:sample_rate=48000:duration=${durationSeconds}`,['-c:a','aac','-b:a','192k']]]){
  const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',input,...codec,'-threads','4','-movflags','+faststart',file],process.env,60000);
  assert.equal(result.status,0,result.stderr);
}
metadata.fixture.sha256={video:digest(video),audio:digest(audio)};
metadata.fixture.reused=reusedFixture;metadata.fixture.retained=Boolean(fixtureCache);
if(fixtureCache&&!reusedFixture)writeFileSync(fixtureManifest,JSON.stringify({profile,durationSeconds,sha256:metadata.fixture.sha256},null,2),{encoding:'utf8',flag:'wx'});
metadata.frontend={sourceCommit:(await runNative('git',['rev-parse','HEAD'],process.env,10000,frontendRoot)).stdout.trim(),
  dirty:Boolean((await runNative('git',['status','--porcelain','--','static'],process.env,10000,frontendRoot)).stdout.trim()),
  staticTree:(await runNative('git',['rev-parse','HEAD:static'],process.env,10000,frontendRoot)).stdout.trim()};
metadata.runtimeTree=(await runNative('git',['rev-parse','HEAD:rust-runtime'],process.env,10000,root)).stdout.trim();
function processes(pid,result=[],seen=new Set()){
  if(seen.has(pid))return result;seen.add(pid);
  try{
    const raw=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
    const memory=readFileSync(`/proc/${pid}/smaps_rollup`,'utf8');
    result.push({pid,start:fields[19],ticks:Number(fields[11])+Number(fields[12]),
      pss:Number(memory.match(/^Pss:\s+(\d+)/m)?.[1]||0)*1024,rss:Number(memory.match(/^Rss:\s+(\d+)/m)?.[1]||0)*1024});
    for(const thread of readdirSync(`/proc/${pid}/task`)) {
      let children;
      try{children=readFileSync(`/proc/${pid}/task/${thread}/children`,'utf8').trim().split(/\s+/).filter(Boolean);}
      catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
      for(const child of children)processes(Number(child),result,seen);
    }
  }catch(error){if(!['ESRCH','ENOENT'].includes(error.code))throw error;}
  return result;
}
function sampler(roots){
  const previous=new Map();
  return ()=>Object.fromEntries(Object.entries(roots).map(([role,pid])=>{
    const rows=processes(pid);let ticks=0;
    for(const row of rows){const key=`${role}:${row.pid}:${row.start}`,old=previous.get(key);if(old!==undefined)ticks+=Math.max(0,row.ticks-old);previous.set(key,row.ticks);}
    return[role,{cpuSeconds:ticks/hz,pssBytes:rows.reduce((n,row)=>n+row.pss,0),rssBytes:rows.reduce((n,row)=>n+row.rss,0),processes:rows.length,rows:rows.map(row=>({...row,cpuSeconds:previous.has(`last:${role}:${row.pid}:${row.start}`)?Math.max(0,row.ticks-previous.get(`last:${role}:${row.pid}:${row.start}`))/hz:null})).map(row=>{previous.set(`last:${role}:${row.pid}:${row.start}`,row.ticks);return row;})}];
  }));
}
const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
const xml=s=>s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"');
async function renderer(){
  const ip=Object.values(networkInterfaces()).flat().find(n=>n?.family==='IPv4'&&!n.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))?.address;assert.ok(ip);
  let uri='',pull=null,transport='STOPPED',bytes=0,requests=0,pullTask=null,streamError=null;
  const server=http.createServer(async(req,res)=>{
    try{
      const body=[];for await(const part of req)body.push(part);const text=Buffer.concat(body).toString('utf8');res.setHeader('Content-Type','text/xml');
      if(req.method==='GET')return res.end('<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:software-profile-receiver</UDN><friendlyName>Software profile receiver</friendlyName><serviceList>'+['ConnectionManager','AVTransport'].map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
      const action=String(req.headers.soapaction||'').match(/#([^"\s]+)/)?.[1];
      if(action==='GetProtocolInfo')return res.end(soap(action,'<Source/><Sink>http-get:*:video/MP2T:*</Sink>','ConnectionManager'));
      if(action==='SetAVTransportURI'){uri=xml(text.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)?.[1]||'');return res.end(soap(action));}
      if(action==='Stop'){transport='STOPPED';pull?.abort();return res.end(soap(action));}
      if(action==='GetTransportInfo')return res.end(soap(action,`<CurrentTransportState>${transport}</CurrentTransportState>`));
      if(action==='Play'){
        transport='PLAYING';requests++;pull=new AbortController();
        pullTask=(async()=>{const response=await fetch(uri,{signal:pull.signal});assert.equal(response.status,200);for await(const part of response.body)bytes+=part.length;})().catch(error=>{if(error.name!=='AbortError')streamError=error.message;});
        return res.end(soap(action));
      }
      res.statusCode=500;res.end('Unsupported fixture action');
    }catch{res.statusCode=500;res.end('Fixture receiver error');}
  });
  await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  return {description:`http://${ip}:${server.address().port}/description.xml`,ip,sample:()=>({bytes,requests,streamError}),
    async close(){pull?.abort();await pullTask;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function connectAudience(browser,host,main){
  const context=await browser.newContext({viewport:audienceViewport});
  await observeContext(context);
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.fallback():r.abort());
  const session={generation:42,mode:'localDualScreen',phase:'active',controllerReady:true,playbackAuthority:'host',mediaRendererOwner:'host'};
  await context.addInitScript(session=>{
    const listeners=new Map();window.profileEmit=(name,payload)=>{for(const callback of listeners.get(name)||[])callback({payload});};
    window.__TAURI__={core:{invoke:async name=>{if(name==='get_presentation_session')return session;if(name==='request_presentation_output_state')window.profileReady=true;}},
      event:{listen:async(name,callback)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);return()=>{};}}};
  },session);
  const page=await context.newPage();await page.goto(host.base+'/controller.html?presentationGeneration=42');await page.waitForFunction(()=>window.profileReady);if(effects==='flat')await flattenEffects(page);
  await main.exposeBinding('profileRelay',async(_,command,args)=>{
    if(command==='publish_presentation_playback_state')return args.playbackState;
    assert.equal(command,'publish_presentation_output_state');
    const envelope=structuredClone(args.envelope);
    if(experiment==='static')envelope.payload.scene.videoUrl='';
    const start=performance.now(),chars=JSON.stringify(envelope).length;
    await page.evaluate(envelope=>{__bilikaraProfile.push('relayAgeMs',Math.max(0,Date.now()-envelope.sentAt));profileEmit('bilikara-presentation-output-state',envelope);},envelope);
    await main.evaluate(({elapsed,chars})=>{__bilikaraProfile.push('relayRoundTripMs',elapsed);__bilikaraProfile.push('relayChars',chars);},{elapsed:performance.now()-start,chars});
  });
  await main.evaluate(session=>{const original=tauriInvoke;tauriInvoke=capability=>capability==='presentation'?window.profileRelay:original(capability);
    applyPresentationSession({...state.presentationSession,...session});applyPresentationCompositionDom(42,'stageOnly');publishPresentationOutputState(undefined,{force:true});},session);
  if(experiment!=='static')await page.waitForFunction(()=>{const video=document.querySelector('video');return video&&!video.paused&&video.currentTime>.1;});return page;
}
async function flattenEffects(page){
  await page.addStyleTag({content:'*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;animation:none!important;transition:none!important}'});
}
async function observeContext(context){
  if(workerPolicy==='allow-blob')await context.route('**/*',async route=>{
    if(route.request().resourceType()!=='document')return route.fallback();
    const response=await route.fetch(),headers=response.headers();
    assert.ok(headers['content-security-policy']&&!headers['content-security-policy'].includes('worker-src'),'review a changed production CSP before the diagnostic');
    await route.fulfill({response,headers:{...headers,'content-security-policy':headers['content-security-policy']+"; worker-src 'self' blob:"}});
  });
  context.on('page',page=>page.on('worker',()=>page.evaluate(()=>__bilikaraProfile.inc('workersCreated')).catch(()=>{})));
  await context.addInitScript(installProfileObserver,{frameCallbacks:frameObserver==='on'});
  await context.route('**/controller.js',async route=>{
    const source=readFileSync(path.join(staticDirectory,'controller.js'),'utf8');
    await route.fulfill({contentType:'text/javascript',body:instrumentController(source)});
  });
  if(worker==='on')await context.route('**/native-output.js',async route=>{
    const source=readFileSync(path.join(staticDirectory,'native-output.js'),'utf8');
    assert.ok(source.includes('enableWorker:false'),'worker diagnostic anchor changed');
    await route.fulfill({contentType:'text/javascript',body:source.replace('enableWorker:false','enableWorker:true')});
  });
}
async function instrumentHost(page){
  await page.evaluate(({overlay,qrBytes,seconds})=>{
    __bilikaraProfile.activeVideo=()=>state.data?.media_output?.target==='native'?state.nativeOutputPreview?.video():state.hostPlaybackSession?.video;
    for(const name of ['currentPresentationScene','publishPresentationOutputState','remoteAccessForPresentation'])
      window[name]=__bilikaraProfile.wrap(name,window[name]);
    const stringify=JSON.stringify;
    JSON.stringify=function(...args){const start=performance.now(),result=stringify.apply(this,args);__bilikaraProfile.push('stringifyMs',performance.now()-start);__bilikaraProfile.push('stringifyChars',result?.length||0);return result;};
    if(overlay==='on'){
      const model={visible:true,deadline:Date.now()+(seconds+90)*1000,durationMs:(seconds+90)*1000,
        heading:'Profile countdown',title:'Synthetic song',requester:'Fixture',duration:'1:30',cacheStatus:'ready',
        queueHeading:'Queue',countdownLabel:'Countdown',rows:Array.from({length:5},(_,i)=>({title:'Song '+i,requester:'Fixture',duration:'1:30',cacheStatus:'ready'}))};
      presentationOverlayModel=()=>model;
    }
    if(qrBytes){
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="white"/><!--'+ 'x'.repeat(Math.max(0,Math.floor(qrBytes*.75)-170))+'--></svg>';
      state.internetRemoteDisplay={...state.internetRemoteDisplay,active:true,hint:'Synthetic profile',password:'fixture',qr_image:'data:image/svg+xml;base64,'+btoa(svg)};
    }
  },{overlay,qrBytes,seconds});
}
async function suspendHostVideo(page,kind){
  return page.evaluate(kind=>{
    const s=state.hostPlaybackSession,v=s.video,a=s.audio;
    const saved={video:v,source:v.getAttribute('src'),play:v.play,pause:v.pause};
    // Measurement-only isolation: suppress paired pause handlers, never add
    // this to the shipping player. Other readiness/EOS dependencies remain and
    // are deliberately exercised by --actions rather than assumed safe.
    const mute=e=>e.stopImmediatePropagation();v.addEventListener('pause',mute,true);
    saved.pause.call(v);v.play=()=>Promise.resolve();
    if(kind==='retire'){v.removeAttribute('src');v.load();}
    saved.mute=mute;window.__profileRetired=saved;
    return {kind,audioPaused:a.paused,hostVideoPaused:v.paused,hostVideoReady:v.readyState};
  },kind);
}
async function recoveryActions(main,audience,host,diagnostic){
  const results=[];
  const record=async(name,fn)=>{const start=performance.now();try{await fn();results.push({name,status:'PASS',latencyMs:performance.now()-start});}catch(e){results.push({name,status:'FAIL',category:e.name,latencyMs:performance.now()-start});}};
  const control=async(action,extra={})=>{const s=await host.api('/api/state');return host.api('/api/player/control',{action,item_id:s.current_item.id,playback_generation:s.playback_generation,expected_queue_version:s.queue_version,...extra});};
  const playing=async(checkAudience=true)=>{
    await main.waitForFunction(diagnostic=>{
      if(diagnostic){const s=state.hostPlaybackSession,a=s?.audio,c=a?.bilikaraAudioClock;
        return s?.logicalPlayIntent&&state.localShouldBePlaying&&!s.seekSettling&&a&&(c?c.isOutputRunning():!a.paused&&a.readyState>=2);}
      const v=activePrimaryVideoElement();return v&&!v.paused&&v.readyState>=2;
    },Boolean(diagnostic),{timeout:10000});
    if(checkAudience&&audience&&experiment!=='static')await audience.waitForFunction(()=>{const v=document.querySelector('video');return v&&!v.paused&&v.readyState>=2;},null,{timeout:10000});
  };
  await record('pause',async()=>{
    await control('pause');
    await main.waitForFunction(()=>{
      if(state.data.media_output.target==='native')return activePrimaryVideoElement()?.paused;
      const s=state.hostPlaybackSession,a=s?.audio,c=a?.bilikaraAudioClock;
      return !s?.logicalPlayIntent&&a&&(c?!c.isOutputRunning():a.paused);
    },null,{timeout:10000});
    if(audience&&experiment!=='static')await audience.waitForFunction(()=>document.querySelector('video')?.paused,null,{timeout:10000});
  });
  await record('resume',async()=>{await control('play');await playing();});
  await record('seek',async()=>{
    const previous=await host.api('/api/state');await control('seek-absolute',{target_seconds:20});
    await main.waitForFunction(({native,generation,diagnostic})=>{
      const v=activePrimaryVideoElement();
      if(diagnostic){const s=state.hostPlaybackSession,a=s?.audio,c=a?.bilikaraAudioClock;
        const time=c?(c.outputTime?.()??c.time()):a?.currentTime;
        return !s?.seekSettling&&Math.abs(time+currentAvOffsetSeconds()-20)<1;}
      return native?state.data.media_output.stream_generation>generation&&state.data.media_output.position>=20&&v&&!v.paused&&v.readyState>=2
        :v&&!v.seeking&&Math.abs(v.currentTime-20)<1;
    },{native:previous.media_output.target==='native',generation:previous.media_output.stream_generation,diagnostic:Boolean(diagnostic)},{timeout:15000});
    await playing();
  });
  if(diagnostic)await record('same-item-resource-restore',async()=>{
    const before=await host.api('/api/state');
    await main.evaluate(()=>{
      const saved=window.__profileRetired,s=state.hostPlaybackSession;
      if(!saved||saved.video!==s?.video)throw new Error('diagnostic_program_retired');
      const v=saved.video,a=s.audio,c=a?.bilikaraAudioClock;
      const time=Math.max(0,(c?(c.outputTime?.()??c.time()):a.currentTime)+currentAvOffsetSeconds());
      v.play=saved.play;v.removeEventListener('pause',saved.mute,true);
      const resume=()=>{setMediaCurrentTime(v,time);v.play().catch(()=>{});};
      if(!v.getAttribute('src')&&saved.source){v.addEventListener('loadedmetadata',resume,{once:true});v.src=saved.source;v.load();}
      else resume();
      saved.restored=true;
    });
    await main.waitForFunction(()=>{const v=state.hostPlaybackSession.video;return !v.paused&&v.readyState>=2&&!v.seeking;},null,{timeout:15000});
    await playing();assert.equal((await host.api('/api/state')).current_item.id,before.current_item.id);
  });
  await record('next',async()=>{const previous=await host.api('/api/state');await control('next-track');await waitFor(async()=>(await host.api('/api/state')).current_item?.id!==previous.current_item.id,'Next selects new item',10000);await main.waitForFunction(id=>state.data.current_item?.id!==id,previous.current_item.id,{timeout:10000});await playing();});
  await record('EOS',async()=>{const previous=await host.api('/api/state');await control('seek-absolute',{target_seconds:durationSeconds-2});await waitFor(async()=>(await host.api('/api/state')).current_item?.id!==previous.current_item.id,'actual decoder EOF advances',20000);});
  if(audience)await record('dual-to-single',async()=>{
    const start=performance.now();
    await main.evaluate(()=>{
      const saved=window.__profileRetired;if(saved){saved.video.play=saved.play;saved.video.removeEventListener('pause',saved.mute,true);if(!saved.restored&&saved.video===state.hostPlaybackSession?.video&&saved.source)saved.video.src=saved.source;}
      applyPresentationSession({...state.presentationSession,mode:'singleScreen',phase:'inactive'});
      applyPresentationCompositionDom(42,'singleScreen');renderPresentationHostSurface();
    });
    await playing(false);results.push({name:'restoreCost',status:'OBSERVED',latencyMs:performance.now()-start,diagnostic:Boolean(diagnostic)});
    await audience.close();
  });
  return results;
}

async function launch(){return engine.launchServer({headless:true,...(audible?{ignoreDefaultArgs:['--mute-audio']}:{}),...(engineName==='chromium'?{args:['--disable-gpu','--disable-accelerated-video-decode','--autoplay-policy=no-user-gesture-required']}
        :{env:{...process.env,GST_PLUGIN_FEATURE_RANK:'vah264dec:0,vah264lpdec:0,vaapih264dec:0,nvh264dec:0,nvh264sldec:0,qsvh264dec:0,v4l2slh264dec:0,avdec_h264:256'}})});}
async function mediaSample(page){
  return page.evaluate(()=>[...document.querySelectorAll('video,audio')].filter(n=>n.currentSrc).map(n=>({kind:n.tagName.toLowerCase(),time:n.currentTime,paused:n.paused,
    muted:n.muted,volume:n.volume,width:n.videoWidth??null,height:n.videoHeight??null,seeking:n.seeking,ended:n.ended,presented:n.bilikaraProfileFrames??null,dropped:n.getVideoPlaybackQuality?.().droppedVideoFrames??null,
    decoded:n.getVideoPlaybackQuality?.().totalVideoFrames??null,ready:n.readyState})));
}
try{
  for(let repetition=1;repetition<=repeats;repetition++)for(const mode of modes){
    const directory=path.join(home,`${mode}-${repetition}`),data=path.join(directory,'data');mkdirSync(directory);let host,browser,server,receiver,audienceServer,audienceBrowser;
    const errors=[];let startupMs=null,hlsStartupMs=null;
    try{
      if(mode.startsWith('dlna'))receiver=await renderer();
      const environment=isolatedEnvironment(directory);
      if(process.env.BILIKARA_TEST_LIBAV_COMPANION)environment.BILIKARA_TEST_NATIVE_ALPHA_COMPANION=process.env.BILIKARA_TEST_LIBAV_COMPANION;
      if(receiver)environment.NO_PROXY=environment.no_proxy=`127.0.0.1,localhost,${receiver.ip}`;
      mkdirSync(data);
      host=await RunningHost.start(alpha,directory,[data,staticDirectory,...(mode==='idle'?[]:[video,audio,'3'])],environment,true);
      server=await launch();
      browser=await engine.connect(server.wsEndpoint());metadata.engineVersion=browser.version();
      const context=await browser.newContext({viewport:hostViewport});
      await observeContext(context);
      await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
      await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
      await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.fallback():r.abort());
      const main=await context.newPage();const startupAt=performance.now();main.on('pageerror',e=>errors.push(e.name));await main.goto(host.base);
      if(effects==='flat')await flattenEffects(main);
      await main.waitForFunction(()=>state.hasValidStateResponse);
      if(mode!=='idle') {
        try{await main.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');}
        catch(error){
          const diagnostic=await main.evaluate(()=>({phase:state.hostPlaybackSession?.phase,
            cache:state.data?.current_item?.cache_status,current:Boolean(state.data?.current_item),
            choice:state.data?.session_flags?.startup_choice_pending,status:state.data?.player_status,
            ready:[state.hostPlaybackSession?.video?.readyState,state.hostPlaybackSession?.audio?.readyState],
            mediaErrors:[state.hostPlaybackSession?.video?.error?.code,state.hostPlaybackSession?.audio?.error?.code]}));
          throw new Error('Profile fixture did not start: '+JSON.stringify(diagnostic),{cause:error});
        }
      }
      startupMs=performance.now()-startupAt;
      await instrumentHost(main);
      if(mode.startsWith('native')){
        const kind=await main.evaluate(()=>BilikaraNativeOutput.decoderKind());
        if(kind==='unavailable'){
          metadata.modes.push({mode,repetition,status:'UNSUPPORTED',reason:'engine native HLS/MSE decoder unavailable; local output retained'});
          writeFileSync(path.join(output,'profile.json'),JSON.stringify(metadata,null,2),'utf8');continue;
        }
        const hlsStarted=performance.now();
        await host.api('/api/player/output',{target:'native',experimental:true});
        await main.waitForFunction(()=>{const v=state.nativeOutputPreview?.video();return state.data?.media_output?.pipeline_level==='L1'&&v?.currentTime>.1&&!v.paused&&v.videoWidth>0;});
        await main.evaluate(()=>new Promise(resolve=>{const v=state.nativeOutputPreview.video();if(v.requestVideoFrameCallback){const timer=setTimeout(()=>resolve(),5000);v.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve();});}else resolve();}));
        hlsStartupMs=performance.now()-hlsStarted;
      }
      const dual=['dual','native-dual'].includes(mode);
      let audience=null;
      if(dual){audienceServer=await launch();audienceBrowser=await engine.connect(audienceServer.wsEndpoint());audience=await connectAudience(audienceBrowser,host,main);}
      const diagnostic=dual&&['pause','retire'].includes(experiment)?await suspendHostVideo(main,experiment):null;
      if(audience){audience.on('pageerror',e=>errors.push(e.name));await audience.waitForFunction(()=>__bilikaraProfile.snapshot().functions.applyClock?.count>0);}
      if(receiver){
        await host.api('/api/purek/prepare',{url:receiver.description});await host.api('/api/purek/connect',{});
        // Registration returns before the bounded capability probe completes.
        // Wait for its actual committed readiness, never retry a failed start.
        await waitFor(async()=>{const s=await host.api('/api/purek/state');return s.connected&&!s.busy;},'receiver registration and capability probe',15000);
        assert.equal((await host.api('/api/state')).media_output.available,true,'An actual full companion is required');
        await waitFor(async()=>!(await host.api('/api/state')).media_output.busy,'automatic receiver admission settled',15000);
        if(mode==='dlna-l0'){
          // A confirmed receiver defaults to managed L1. The diagnostic L0
          // endpoint cannot take its ownership: explicitly return to local first.
          await host.api('/api/player/output',{target:'local'});
          await waitFor(async()=>{const s=await host.api('/api/state');return s.media_output.target==='local'&&!s.media_output.busy;},'managed output released before diagnostic L0',15000);
          await host.api('/api/purek/output/start',{experimental:true,pipeline:'L0'});
        }else{
          // The automatic default preserves the observed paused state. This
          // explicit benchmark start must request playback, even if selected.
          await host.api('/api/player/output',{target:'purek',experimental:true});
        }
        await waitFor(async()=>(await host.api('/api/purek/state')).output.status==='streaming','Actual TS delivery',15000);
      }
      if(frameObserver==='on')for(const page of [main,audience].filter(Boolean))await page.evaluate(()=>{
        for(const video of document.querySelectorAll('video'))if(video.requestVideoFrameCallback){
          let frames=0;const frame=()=>{video.bilikaraProfileFrames=++frames;video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
        }
      });
      await delay(3000);
      for(const page of [main,audience].filter(Boolean))await page.evaluate(()=>__bilikaraProfile.start());
      const cdp=engineName==='chromium'?await context.newCDPSession(main):null;
      await cdp?.send('Performance.enable');const beforePerformance=await cdp?.send('Performance.getMetrics');
      const profilers=cpuProfile?[['host',cdp],...(audience?[['audience',await audience.context().newCDPSession(audience)]]:[])]:[];
      for(const [,session]of profilers){await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:1000});await session.send('Profiler.start');}
      const sample=sampler({host:host.process.pid,hostBrowser:server.process().pid,...(audienceServer?{audienceBrowser:audienceServer.process().pid}:{})});sample();
      const initial={host:await mediaSample(main),audience:audience?await mediaSample(audience):[],receiver:receiver?.sample()};
      const samples=[],started=performance.now();let last=started;
      while(performance.now()-started<seconds*1000){
        await delay(1000);const now=performance.now();const hostClock=await main.evaluate(()=>{const c=state.presentationOutputLastPublication?.clock;return {wall:Date.now(),clock:c?{mediaTime:c.mediaTime,sampledAt:c.sampledAt,paused:c.paused,rate:c.playbackRate}:null,audioTime:state.hostPlaybackSession?.audio?.currentTime??null,audioContext:state.audioContext?.state??null};});
        const audienceClock=audience?await audience.evaluate(()=>{const v=document.querySelector('video');return{wall:Date.now(),time:v?.currentTime??null,paused:v?.paused??null};}):null;
        samples.push({seconds:(now-started)/1000,intervalSeconds:(now-last)/1000,roles:sample(),hostClock,audienceClock});last=now;
      }
      const elapsed=(performance.now()-started)/1000;
      for(const [role,session]of profilers){
        const {profile:trace}=await session.send('Profiler.stop');
        const scripts=new Set(readdirSync(staticDirectory).filter(name=>name.endsWith('.js')));
        for(const node of trace.nodes){
          const frame=node.callFrame;
          const base=String(frame.url||'').split('/').at(-1)?.split('?')[0];
          frame.url=scripts.has(base)?base:'<redacted>';
          if(!/^[a-zA-Z0-9_.$ ()<>\[\]-]{0,120}$/.test(frame.functionName))frame.functionName='<redacted>';
        }
        writeFileSync(path.join(output,`cpu-${mode}-${repetition}-${role}.json`),JSON.stringify(trace),'utf8');
      }
      const final={host:await mediaSample(main),audience:audience?await mediaSample(audience):[],receiver:receiver?.sample()};
      const roles=Object.keys(samples[0].roles);
      const summary=Object.fromEntries(roles.map(role=>[role,{
        cpuPercentOneCore:100*samples.reduce((sum,s)=>sum+s.roles[role].cpuSeconds,0)/elapsed,
        peakPssMiB:Math.max(...samples.map(s=>s.roles[role].pssBytes))/2**20,
        peakRssMiB:Math.max(...samples.map(s=>s.roles[role].rssBytes))/2**20,
        cpuSamples:distribution(samples.map(s=>100*s.roles[role].cpuSeconds/s.intervalSeconds)),
      }]));
      const synchronization=distribution(samples.filter(s=>s.hostClock.clock&&!s.hostClock.clock.paused&&s.audienceClock&&s.audienceClock.time!==null).map(s=>s.audienceClock.time-s.hostClock.clock.mediaTime-(s.audienceClock.wall-s.hostClock.clock.sampledAt)/1000*s.hostClock.clock.rate));
      const observations={host:await main.evaluate(()=>__bilikaraProfile.snapshot()),audience:audience?await audience.evaluate(()=>__bilikaraProfile.snapshot()):null};
      const performanceAfter=await cdp?.send('Performance.getMetrics');
      const browserPerformance=performanceAfter?Object.fromEntries(performanceAfter.metrics.filter(m=>['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration'].includes(m.name)).map(m=>[m.name,m.value-(beforePerformance.metrics.find(b=>b.name===m.name)?.value||0)])):null;
      const recovery=actions&&mode!=='idle'&&!receiver?await recoveryActions(main,audience,host,diagnostic):[];
      const audioStart=initial.host.find(m=>m.kind==='audio'),audioEnd=final.host.find(m=>m.kind==='audio');
      const diagnosticValidity=diagnostic?{audioProgressSeconds:audioEnd&&audioStart?audioEnd.time-audioStart.time:null,audioPaused:audioEnd?.paused??null,hostDecoderPaused:final.host.find(m=>m.kind==='video')?.paused??null}:null;
      const actionFailures=recovery.filter(r=>r.status==='FAIL').length;
      const o=(await host.api('/api/state')).media_output;
      const decoder=await main.evaluate(()=>state.nativeOutputPreview?.diagnostics()?.decoder??null);
      const actualOutput={decoder,target:o.target,status:o.status,pipelineLevel:o.pipeline_level,generation:o.stream_generation};
      const result={actualOutput,mode,repetition,status:'MEASURED',startupMs,hlsStartupMs,elapsed,summary,initial,final,samples,observations,synchronization,browserPerformance,recovery,actionFailures,diagnosticValidity,errors,output:receiver?(await host.api('/api/purek/state')).output:undefined};
      // Output snapshots include lease/transport URLs; retain ONLY fixed metrics.
      if(result.output){const o=result.output;result.output={status:o.status,pipelineLevel:o.pipeline_level,bytesSent:o.bytes_sent,lastError:o.last_error};}
      if(errors.length||final.receiver?.streamError)result.status='ERROR';
      if(diagnosticValidity&&(diagnosticValidity.audioPaused||diagnosticValidity.audioProgressSeconds<elapsed*.8))result.status='DIAGNOSTIC_INVALID';
      metadata.modes.push(result);writeFileSync(path.join(output,'profile.json'),JSON.stringify(metadata,null,2),'utf8');
      console.log(JSON.stringify({mode,status:result.status,elapsed,summary,actionFailures,evidenceClass:metadata.evidenceClass}));
      assert.deepEqual(errors,[]);if(receiver)assert.equal(final.receiver.streamError,null);
    }finally{
      if(host&&receiver)await host.api('/api/purek/output/stop',{}).catch(()=>{});
      if(audienceBrowser)await audienceBrowser.close();if(audienceServer)await audienceServer.close();
      if(browser)await browser.close();if(server)await server.close();if(receiver)await receiver.close();if(host)await host.close();
    }
  }
}finally{rmSync(home,{recursive:true,force:true});}
