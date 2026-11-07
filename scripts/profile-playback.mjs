// Reproducible software-only Linux profile of the actual Rust Host and shared
// shipped UI. Does not qualify WebView2, Android hardware, UIKit or AirPlay.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir,cpus,hostname,networkInterfaces,getPriority} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,webkit} from 'playwright';
import {root,runNative} from '../tests/desktop_construction_support.mjs';
import {buildNativeAlpha} from '../tests/native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment,waitFor} from '../tests/native_host_support.mjs';

assert.equal(process.platform,'linux','This process sampler uses Linux /proc; native platform profiles are separate');
const args=process.argv.slice(2),value=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
const engineName=value('--engine','chromium'),engine={chromium,webkit}[engineName];assert.ok(engine);
const profile=value('--profile','1280x720:30');assert.ok(['1280x720:30','1920x1080:30','1920x1080:60'].includes(profile));
const seconds=Number(value('--seconds','20'));assert.ok(Number.isInteger(seconds)&&seconds>=10&&seconds<=60);
const output=path.resolve(value('--output',''));assert.ok(args.includes('--output'),'Choose an explicit evidence directory outside the checkout');
assert.ok(!output.startsWith(root+path.sep)&&output!==root);
const modes=value('--modes','idle,single,dual,dlna-l0,dlna-l1').split(',');
assert.ok(modes.length&&modes.every(m=>['idle','single','dual','dlna-l0','dlna-l1'].includes(m)));
mkdirSync(output,{recursive:true});
assert.ok(!existsSync(path.join(output,'profile.json')),'Preserve an existing profile; choose a new evidence directory');
const alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
const hzResult=await runNative('getconf',['CLK_TCK'],process.env,10000);assert.equal(hzResult.status,0,hzResult.stderr);
const hz=Number(hzResult.stdout.trim());assert.ok(hz>0);
const home=mkdtempSync(path.join(tmpdir(),'bilikara-profile-'));
const targetKbps=profile==='1280x720:30'?2000:profile==='1920x1080:30'?5000:8000;
const metadata={evidenceClass:'SOFTWARE-PROFILE',machine:hostname(),platform:process.platform,architecture:process.arch,
  cpu:cpus()[0].model,logicalCpus:cpus().length,engine:engineName,engineVersion:null,profile,seconds,
  cpuAffinity:readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],nice:getPriority(),
  fixture:{durationSeconds:90,video:'H.264',videoTargetKbps:targetKbps,audio:'AAC',audioKbps:192},
  sourceCommit:(await runNative('git',['rev-parse','HEAD'],process.env,10000,root)).stdout.trim(),
  sourceDirty:Boolean((await runNative('git',['status','--porcelain'],process.env,10000,root)).stdout.trim()),
  backend:'Rust NativeHost isolated fixture harness',nativeDesktopShell:false,
  note:'Software decoding, no physical displays/receiver. Dual-screen OS IPC and DLNA receiver are independent local fixtures. CPU=100% per logical core. PSS avoids double-counting shared pages. Warm steady windows exclude builds, generation, startup and shutdown. No URLs, cookies or bootstrap credentials recorded.',modes:[]};
const [size,fps]=profile.split(':');
const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
for(const [file,input,codec]of [[video,`testsrc2=s=${size}:r=${fps}:d=90`,['-c:v','libx264','-preset','veryfast','-b:v',`${targetKbps}k`,'-maxrate',`${targetKbps}k`,'-bufsize',`${targetKbps*2}k`,'-g',fps,'-pix_fmt','yuv420p']],
  [audio,'sine=frequency=440:sample_rate=48000:duration=90',['-c:a','aac','-b:a','192k']]]){
  const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',input,...codec,'-threads','4','-movflags','+faststart',file],process.env,60000);
  assert.equal(result.status,0,result.stderr);
}
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
    return[role,{cpuSeconds:ticks/hz,pssBytes:rows.reduce((n,row)=>n+row.pss,0),rssBytes:rows.reduce((n,row)=>n+row.rss,0),processes:rows.length}];
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
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
  const session={generation:42,mode:'localDualScreen',phase:'active',controllerReady:true,playbackAuthority:'host',mediaRendererOwner:'host'};
  await context.addInitScript(session=>{
    const listeners=new Map();window.profileEmit=(name,payload)=>{for(const callback of listeners.get(name)||[])callback({payload});};
    window.__TAURI__={core:{invoke:async name=>{if(name==='get_presentation_session')return session;if(name==='request_presentation_output_state')window.profileReady=true;}},
      event:{listen:async(name,callback)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);return()=>{};}}};
  },session);
  const page=await context.newPage();await page.goto(host.base+'/controller.html?presentationGeneration=42');await page.waitForFunction(()=>window.profileReady);
  await main.exposeBinding('profileRelay',async(_,command,args)=>{
    if(command==='publish_presentation_playback_state')return args.playbackState;
    assert.equal(command,'publish_presentation_output_state');await page.evaluate(envelope=>profileEmit('bilikara-presentation-output-state',envelope),args.envelope);
  });
  await main.evaluate(session=>{const original=tauriInvoke;tauriInvoke=capability=>capability==='presentation'?window.profileRelay:original(capability);
    applyPresentationSession({...state.presentationSession,...session});applyPresentationCompositionDom(42,'stageOnly');publishPresentationOutputState(undefined,{force:true});},session);
  await page.waitForFunction(()=>{const video=document.querySelector('video');return video&&!video.paused&&video.currentTime>.1;});return page;
}
async function mediaSample(page){
  return page.evaluate(()=>[...document.querySelectorAll('video,audio')].filter(n=>n.currentSrc).map(n=>({kind:n.tagName.toLowerCase(),time:n.currentTime,paused:n.paused,
    presented:n.bilikaraProfileFrames??null,dropped:n.getVideoPlaybackQuality?.().droppedVideoFrames??null,
    decoded:n.getVideoPlaybackQuality?.().totalVideoFrames??null,ready:n.readyState})));
}
try{
  for(const mode of modes){
    const directory=path.join(home,mode),data=path.join(directory,'data');mkdirSync(directory);let host,browser,server,receiver;
    const errors=[];
    try{
      if(mode.startsWith('dlna'))receiver=await renderer();
      const environment=isolatedEnvironment(directory);
      if(process.env.BILIKARA_TEST_LIBAV_COMPANION)environment.BILIKARA_TEST_NATIVE_ALPHA_COMPANION=process.env.BILIKARA_TEST_LIBAV_COMPANION;
      if(receiver)environment.NO_PROXY=environment.no_proxy=`127.0.0.1,localhost,${receiver.ip}`;
      mkdirSync(data);
      host=await RunningHost.start(alpha,directory,[data,path.join(root,'static'),...(mode==='idle'?[]:[video,audio,'2'])],environment,true);
      server=await engine.launchServer({headless:true,...(engineName==='chromium'?{args:['--disable-gpu','--disable-accelerated-video-decode','--autoplay-policy=no-user-gesture-required']}
        :{env:{...process.env,GST_PLUGIN_FEATURE_RANK:'vah264dec:0,vah264lpdec:0,vaapih264dec:0,nvh264dec:0,nvh264sldec:0,qsvh264dec:0,v4l2slh264dec:0,avdec_h264:256'}})});
      browser=await engine.connect(server.wsEndpoint());metadata.engineVersion=browser.version();
      const context=await browser.newContext({viewport:{width:1280,height:800}});
      await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
      await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
      await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
      const main=await context.newPage();main.on('pageerror',e=>errors.push(e.message));await main.goto(host.base);
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
      const audience=mode==='dual'?await connectAudience(browser,host,main):null;
      if(receiver){
        await host.api('/api/purek/prepare',{url:receiver.description});await host.api('/api/purek/connect',{});
        assert.equal((await host.api('/api/state')).media_output.available,true,'An actual full companion is required');
        if(mode==='dlna-l0')await host.api('/api/purek/output/start',{experimental:true,pipeline:'L0'});
        else await host.api('/api/player/output',{target:'purek',experimental:true});
        await waitFor(async()=>(await host.api('/api/purek/state')).output.status==='streaming','Actual TS delivery',15000);
      }
      for(const page of [main,audience].filter(Boolean))await page.evaluate(()=>{
        for(const video of document.querySelectorAll('video'))if(video.requestVideoFrameCallback){
          let frames=0;const frame=()=>{video.bilikaraProfileFrames=++frames;video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);
        }
      });
      await delay(3000);
      const sample=sampler({host:host.process.pid,browser:server.process().pid});sample();
      const initial={host:await mediaSample(main),audience:audience?await mediaSample(audience):[],receiver:receiver?.sample()};
      const samples=[],started=performance.now();let last=started;
      while(performance.now()-started<seconds*1000){
        await delay(1000);const now=performance.now();samples.push({seconds:(now-started)/1000,intervalSeconds:(now-last)/1000,roles:sample()});last=now;
      }
      const elapsed=(performance.now()-started)/1000;
      const final={host:await mediaSample(main),audience:audience?await mediaSample(audience):[],receiver:receiver?.sample()};
      const summary=Object.fromEntries(['host','browser'].map(role=>[role,{
        cpuPercentOneCore:100*samples.reduce((sum,s)=>sum+s.roles[role].cpuSeconds,0)/elapsed,
        peakPssMiB:Math.max(...samples.map(s=>s.roles[role].pssBytes))/2**20,
        peakRssMiB:Math.max(...samples.map(s=>s.roles[role].rssBytes))/2**20,
      }]));
      const result={mode,elapsed,summary,initial,final,samples,errors,output:receiver?(await host.api('/api/purek/state')).output:undefined};
      // Output snapshots include lease/transport URLs; retain ONLY fixed metrics.
      if(result.output){const o=result.output;result.output={status:o.status,pipelineLevel:o.pipeline_level,bytesSent:o.bytes_sent,lastError:o.last_error};}
      assert.deepEqual(errors,[]);if(receiver)assert.equal(final.receiver.streamError,null);
      metadata.modes.push(result);writeFileSync(path.join(output,'profile.json'),JSON.stringify(metadata,null,2),'utf8');
      console.log(JSON.stringify({mode,elapsed,summary,evidenceClass:metadata.evidenceClass}));
    }finally{
      if(host&&receiver)await host.api('/api/purek/output/stop',{}).catch(()=>{});
      if(browser)await browser.close();if(server)await server.close();if(receiver)await receiver.close();if(host)await host.close();
    }
  }
}finally{rmSync(home,{recursive:true,force:true});}
