// Actual shipping Host/Controller pages with the existing isolated Native Host.
// Only the native-window transport is a fixture; no media/sync policy is patched.
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

export async function startProductionPlayback(engine,video,audio,{initialDelayMs=0,initialKey=0}={}) {
 const home=mkdtempSync(path.join(tmpdir(),'round-a-production-')),alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
 const host=await RunningHost.start(alpha,home,[home,path.join(root,'static'),video,audio,'3'],isolatedEnvironment(home),true);
 let hostBrowser,audienceBrowser;
 try {
  const options={headless:true,ignoreDefaultArgs:['--mute-audio'],...(engine.name()==='chromium'?{args:['--disable-gpu','--disable-accelerated-video-decode','--autoplay-policy=no-user-gesture-required']}:{env:{...process.env,GST_PLUGIN_FEATURE_RANK:'vah264dec:0,vah264lpdec:0,vaapih264dec:0,nvh264dec:0,nvh264sldec:0,qsvh264dec:0,v4l2slh264dec:0,avdec_h264:256'}})};
  hostBrowser=await engine.launchServer(options);audienceBrowser=await engine.launchServer(options);
  const browsers=await Promise.all([engine.connect(hostBrowser.wsEndpoint()),engine.connect(audienceBrowser.wsEndpoint())]);
  const contexts=await Promise.all(browsers.map((browser,i)=>browser.newContext({viewport:i?{width:1920,height:1080}:{width:1280,height:800}})));
  for(const context of contexts){await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());}
  await contexts[0].addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
  const main=await contexts[0].newPage(),output=await contexts[1].newPage(),errors=[];
  for(const page of [main,output])page.on('pageerror',error=>errors.push(error.message));
  await main.goto(host.base);await main.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
  const session={generation:42,mode:'localDualScreen',phase:'active',controllerReady:true,playbackAuthority:'host',mediaRendererOwner:'host'};
  await contexts[1].addInitScript(session=>{
   const listeners=new Map();window.roundAEmit=(name,payload)=>{for(const cb of listeners.get(name)||[])cb({payload});};
   window.__TAURI__={core:{invoke:async name=>{if(name==='get_presentation_session')return session;if(name==='request_presentation_output_state')window.roundAReady=true;}},
    event:{listen:async(name,callback)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(callback);return()=>{};}}};
  },session);
  await output.goto(host.base+'/controller.html?presentationGeneration=42');await output.waitForFunction(()=>roundAReady);
  await main.exposeBinding('roundAProductionRelay',async(_,command,args)=>{
   if(command==='publish_presentation_playback_state')return args.playbackState;
   if(command!=='publish_presentation_output_state')throw Error('unexpected native presentation command');
   await output.evaluate(envelope=>roundAEmit('bilikara-presentation-output-state',envelope),args.envelope);
  });
  await main.evaluate(session=>{
   const original=tauriInvoke;tauriInvoke=capability=>capability==='presentation'?window.roundAProductionRelay:original(capability);
   applyPresentationSession({...state.presentationSession,...session});applyPresentationCompositionDom(42,'stageOnly');publishPresentationOutputState(undefined,{force:true});
   const call=(name,...args)=>{const adapter=state.hostPlaybackSession.mediaBackend;return adapter[name](adapter.program,...args);};
   window.roundA={player:{play:()=>call('play'),pause:()=>call('pause'),seek:s=>call('seek',s),setAvDelay:ms=>call('setAvDelay',ms),setKeyShift:key=>call('setKeyShift',key),snapshot:()=>{
    const adapter=state.hostPlaybackSession.mediaBackend,s=adapter.snapshot(adapter.program);
    return {...s,mediaTime:s.timeSeconds,audioSeconds:s.audioTimeSeconds};
   }}};
  },session);
  await main.evaluate(async({delay,key})=>{if(key)await roundA.player.setKeyShift(key);roundA.player.pause();await roundA.player.setAvDelay(delay);await roundA.player.seek(0);},{delay:initialDelayMs,key:initialKey});
  return {host,main,output,errors,hostBrowser,audienceBrowser,async close(){await Promise.all([hostBrowser.close(),audienceBrowser.close()]);await host.close();}};
 }catch(error){await hostBrowser?.close();await audienceBrowser?.close();await host.close();throw error;}
}
