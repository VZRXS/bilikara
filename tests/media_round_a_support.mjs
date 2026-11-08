// Explicit test-only routes: no shipped Host route or feature flag enables A1.
import {readFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
import {installProfileObserver} from '../scripts/profile-observer.mjs';
import {calibrateMonotonic} from './monotonic_clock_support.mjs';
import {observeDecoders} from '../research/decoder-observer.mjs';

export async function startAudioFirst(engine,video,audio,{hostViewport={width:1280,height:800},audienceViewport={width:1920,height:1080},initialDelayMs=0,initialKey=0,autoplay=true,shadowVideo=false}={}) {
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-round-a-'));
  const alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
  const host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
  let hostBrowser,audienceBrowser;
  try {
    const options={headless:true,ignoreDefaultArgs:['--mute-audio'],...(engine.name()==='chromium'?{args:['--disable-gpu','--disable-accelerated-video-decode','--autoplay-policy=no-user-gesture-required']}:{env:{...process.env,GST_PLUGIN_FEATURE_RANK:'vah264dec:0,vah264lpdec:0,vaapih264dec:0,nvh264dec:0,nvh264sldec:0,qsvh264dec:0,v4l2slh264dec:0,avdec_h264:256'}})};
    // Independent browser process groups, as in the production profiler.
    hostBrowser=await engine.launchServer(options);audienceBrowser=await engine.launchServer(options);
    const mainBrowser=await engine.connect(hostBrowser.wsEndpoint()),outputBrowser=await engine.connect(audienceBrowser.wsEndpoint());
    const contexts=await Promise.all([mainBrowser.newContext({viewport:hostViewport}),outputBrowser.newContext({viewport:audienceViewport})]);
    for(const context of contexts) {
      await context.addInitScript(installProfileObserver,{frameCallbacks:true});
      await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin!==host.base)return route.abort();
        if(url.pathname==='/__round_a__/audio-first.js')return route.fulfill({contentType:'application/javascript',body:readFileSync(path.join(root,'research/webview-audio-first/audio-first.js'),'utf8')});
        if(url.pathname==='/__round_a__/host')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated Audio-First experiment</title><script src="/media-backend.js"></script><script src="/audio-clock.js"></script><script src="/presentation-sync.js"></script><script src="/__round_a__/audio-first.js"></script><main>Audio-First: Host owns audio only</main>'});
        if(url.pathname==='/__round_a__/audience')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated Audience</title><style>body{margin:0;background:black}video{width:100vw;height:100vh;object-fit:contain}</style><script src="/presentation-sync.js"></script><script src="/__round_a__/audio-first.js"></script><video muted playsinline></video>'});
        return route.continue();
      });
    }
    const main=await contexts[0].newPage(),output=await contexts[1].newPage(),errors=[];
    const decoderFacts={host:await observeDecoders(main),audience:await observeDecoders(output)};
    for(const page of [main,output])page.on('pageerror',error=>errors.push(error.message));
    await main.goto(host.base+'/__round_a__/host');await output.goto(host.base+'/__round_a__/audience');
    await main.exposeBinding('roundAPrepareAudience',async(_,program,src)=>{
      const identity=JSON.stringify(program);
      await output.evaluate(({identity,src})=>{
        const video=document.querySelector('video');video.pause();video.preload='auto';video.dataset.program=identity;video.src=src;video.load();
      },{identity,src});
      await output.waitForFunction(identity=>{
        const video=document.querySelector('video');return video.dataset.program===identity&&video.readyState>=2&&!video.seeking;
      },identity);
    });
    await main.evaluate(async({initialDelayMs,initialKey,autoplay,shadowVideo})=>{
      window.roundAPost=async(url,body)=>{
        const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Bilikara-Client':'round-a-audio-first'},body:JSON.stringify(body)});
        const result=await response.json();if(!response.ok)throw new Error(result.code||'Host error');return result.data;
      };
      window.roundA={events:[],errors:[],statusSequence:0,nextCount:0};
      roundA.player=new BilikaraAudioFirst.AudioFirst({current:()=>roundA.program,
        changed:()=>{},ended:async program=>{
          try {
            if(!BilikaraMediaBackend.same(program,roundA.program))return;
            await roundA.transition(async()=>{
              await roundA.report('ended');
              await roundAPost('/api/player/next',{playback_generation:program.playback_generation,expected_queue_version:null});
              await roundA.load();await roundA.player.play();roundA.nextCount++;
            });
          }catch(error){roundA.errors.push(error.message);}
        }});
      roundA.report=phase=>{
        const program=roundA.program,previous=roundA.statusRequest||Promise.resolve();
        roundA.statusPending=true;
        const request=previous.then(()=>{
          if(!BilikaraMediaBackend.same(program,roundA.program))throw new Error('stale-program');
          const state=roundA.player.snapshot();
          return roundAPost('/api/player/status',{playback_generation:program.playback_generation,
            item_id:program.item_id,status_sequence:++roundA.statusSequence,observed_phase:phase,
            is_paused:phase!=='playing',current_time:state.mediaTime,duration:state.duration});
        }).finally(()=>{if(roundA.statusRequest===request)roundA.statusPending=false;});
        return roundA.statusRequest=request;
      };
      roundA.transition=async action=>{
        roundA.binding=true;
        try {await roundA.statusRequest;return await action();}finally{roundA.binding=false;}
      };
      roundA.load=async(restore=0)=>{
        const snapshot=(await (await fetch('/api/state')).json()).data;
        roundA.snapshot=snapshot;const program=roundA.program={...snapshot.playback_program,playback_generation:snapshot.playback_generation};
        roundA.statusSequence=0;
        const {playback_generation,item_incarnation_id,artifact_set_id}=program;
        const claim=await roundAPost('/api/player/claim-program',{playback_generation,item_incarnation_id,artifact_set_id});
        if(!claim.claimed)throw new Error('claim-rejected');
        const item=snapshot.current_item;
        const variant=item.audio_variants.find(value=>value.id===roundA.program.selected_audio_variant_id);
        if(!BilikaraMediaBackend.same(program,roundA.program))throw new Error('stale-program');
        await roundA.player.load(program,{video:item.video_media_url,audio:variant.audio_url},restore);
        if(!BilikaraMediaBackend.same(program,roundA.program))throw new Error('stale-program');
        await roundA.report('ready-paused');
        await roundAPrepareAudience(BilikaraMediaBackend.identity(program),item.video_media_url);
      };
      await roundA.player.setAvDelay(initialDelayMs);
      await roundA.player.setKeyShift(initialKey);
      await roundA.load();
      if(shadowVideo){
        // Controlled decoder-cost experiment. This extra element has no clock,
        // readiness, DSP, EOS or queue authority. Never created by the product.
        const shadow=roundA.shadow=document.createElement('video');
        shadow.muted=true;shadow.style.cssText='position:fixed;width:1280px;height:720px;opacity:0;pointer-events:none';
        document.body.append(shadow);shadow.src=roundA.player.media.video;shadow.load();
      }
      roundA.statusTimer=setInterval(()=>{
        if(!roundA.binding&&!roundA.statusPending)roundA.report(roundA.player.snapshot().playing?'playing':'paused').catch(error=>roundA.errors.push(error.message));
      },1000);
    },{initialDelayMs,initialKey,autoplay,shadowVideo});
    await output.evaluate(()=>{
      window.roundAClock=null;window.roundACorrections=[];
      setInterval(()=>{
        if(!roundAClock)return;
        const video=document.querySelector('video');
        const result=BilikaraAudioFirst.follow(video,roundAClock);
        roundACorrections.push({at:Date.now(),action:result.action,drift:result.driftSeconds});
        if(roundACorrections.length>20000)roundACorrections.shift();
      },100);
    });
    const hostCalibration=await calibrateMonotonic(main),audienceCalibration=await calibrateMonotonic(output);
    let relaying=false;
    const relay=async()=>{
      if(relaying)return;relaying=true;
      try {
        const data=await main.evaluate(()=>({clock:roundA.player.snapshot(),video:roundA.player.media.video}));
        data.clock.sampledAt=data.clock.monotonicAt+hostCalibration.offsetMs-audienceCalibration.offsetMs;
        data.clock.clockBasis='local-performance';
        await output.evaluate(({clock,video:src})=>{
          const video=document.querySelector('video');
          const identity=JSON.stringify(clock.program);
          if(video.dataset.program!==identity){video.dataset.program=identity;video.src=src;video.load();}
          window.roundAClock=clock;
        },data);
      }catch(error){errors.push(error.message);}finally{relaying=false;}
    };
    await relay();const timer=setInterval(relay,250);
    if(autoplay)await main.evaluate(async()=>{await roundA.player.play();await roundA.report('playing');if(roundA.shadow)await roundA.shadow.play();});
    return {host,main,output,hostBrowser,audienceBrowser,errors,relay,decoderFacts,clockCalibration:{host:hostCalibration,audience:audienceCalibration},
      async close(){clearInterval(timer);await main.evaluate(async()=>{clearInterval(roundA.statusTimer);await roundA.player.dispose();}).catch(()=>{});await Promise.all([hostBrowser.close(),audienceBrowser.close()]);await host.close();}};
  }catch(error){await hostBrowser?.close();await audienceBrowser?.close();await host.close();throw error;}
}
