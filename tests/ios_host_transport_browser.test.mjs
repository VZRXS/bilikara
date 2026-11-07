// The WK message boundary and visibility are fixtures. Commands execute through
// the production native JSON client and actual Rust HTTP/AppState, not a mock.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import test,{before} from 'node:test';
import {chromium,webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
let alpha;
before(async()=>{if(process.platform==='linux')alpha=process.env.BILIKARA_TEST_NATIVE_JSON_BINARY||await buildNativeAlpha();},{timeout:300000});

for(const [name,engine]of Object.entries({chromium,webkit}))test(`${name}: iOS native commands survive unavailable WebKit fetch after foreground`,{
  skip:process.platform!=='linux',timeout:120000,
},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-ios-http-')),ui=process.env.BILIKARA_FEEDBACK_REFERENCE_ROOT||root;
  let host,browser;const pending=new Map();
  t.after(async()=>{try{await browser?.close();}finally{try{await host?.close();}finally{rmSync(home,{recursive:true,force:true});}}});
  const files=[];
  for(const [fixture,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
    const file=path.join(home,name),built=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',fixture),'-t','90','-c','copy','-movflags','+faststart',file],process.env,30000);
    assert.equal(built.status,0,built.stderr);files.push(file);
  }
  host=await RunningHost.start(alpha,home,[home,path.join(ui,'static'),...files,'3'],isolatedEnvironment(home),true);
  let sequence=0;
  const lines=createInterface({input:host.process.stdout});
  lines.on('line',line=>{
    if(!line.startsWith('NATIVE_JSON '))return;
    const response=JSON.parse(line.slice('NATIVE_JSON '.length)),waiter=pending.get(response.id);
    if(waiter){pending.delete(response.id);clearTimeout(waiter.timer);waiter.resolve(response.reply);}
  });
  t.after(()=>{lines.close();for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('fixture retired'));}});
  browser=await engine.launch({headless:true});
  const context=await browser.newContext({viewport:{width:393,height:852},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  const calls=[];
  await context.exposeBinding('nativeHostJson',(_source,request)=>new Promise((resolve,reject)=>{
    const id=++sequence;calls.push({method:request.method,path:request.path.split('?')[0]});
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('native fixture deadline'));},15000);
    pending.set(id,{resolve,reject,timer});host.process.stdin.write(JSON.stringify({operation:'native-json',id,request})+'\n');
  }));
  await context.addInitScript(()=>{
    localStorage.setItem('bilikara.update.automatic','false');
    window.webkit={messageHandlers:{bilikaraPlatform:{postMessage(raw){
      const message=JSON.parse(raw);
      if(message.action==='request-json'){
        nativeHostJson(message.json_request).then(reply=>BilikaraIosPlatform._receive({...message,ok:true,data:reply}));
      }else if(message.action==='sync-dock')queueMicrotask(()=>BilikaraIosPlatform._receive({...message,ok:false}));
    }}}};
  });
  await context.addInitScript(readFileSync(path.join(ui,'static/ios-platform.js'),'utf8')
    .replace('"__BILIKARA_IOS_ORIGIN__"',JSON.stringify(host.base)).replace('"__BILIKARA_IOS_HTTP__"','"enabled"'));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
    if(url.pathname==='/'){
      const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});
    }
    return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(host.base);await page.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
  const first=await page.evaluate(()=>{
    window.transportOriginal={video:state.hostPlaybackSession.video,audio:state.hostPlaybackSession.audio};
    window.actualFetch=fetch.bind(window);window.fetch=(url,options)=>{
      if(new URL(typeof url==='string'?url:url.url,location.href).pathname.startsWith('/api/'))return Promise.reject(new TypeError('Load failed'));
      return actualFetch(url,options);
    };
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));
    return state.data.current_item.id;
  });
  // Same application command path as the software controller; Rust enqueues
  // and the live Host consumes/ACKs it through the new transport.
  await page.evaluate(async()=>{await apiPostStateSnapshot('/api/player/control',{
    action:'pause',item_id:state.data.current_item.id,playback_generation:state.data.playback_generation});render();});
  await page.waitForFunction(()=>!state.localShouldBePlaying&&state.hostPlaybackSession.audio.paused);
  await page.evaluate(async()=>{await apiPostStateSnapshot('/api/player/control',{
    action:'play',item_id:state.data.current_item.id,playback_generation:state.data.playback_generation});render();});
  await page.waitForFunction(()=>state.localShouldBePlaying&&!state.hostPlaybackSession.audio.paused);
  assert.equal(await page.evaluate(()=>transportOriginal.video===state.hostPlaybackSession.video&&transportOriginal.audio===state.hostPlaybackSession.audio),true);
  await page.locator('[data-android-page="queue"]').click();await page.locator('#next-button').click();
  await page.waitForFunction(first=>state.data.current_item?.id!==first,first);
  assert.notEqual((await host.api('/api/state')).current_item.id,first,'the authoritative Rust item advanced');
  assert.ok(calls.some(call=>call.path==='/api/state'));
  assert.ok(calls.some(call=>call.path==='/api/player/control'));
  assert.equal(await page.evaluate(()=>state.hostHttpTransport.failed),0);
  assert.deepEqual(errors,[]);
});
