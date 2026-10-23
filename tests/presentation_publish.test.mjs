import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require=createRequire(import.meta.url),sync=require('../static/presentation-sync.js');
const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const publishCode=app.slice(app.indexOf('function publishPresentationOutputState('),app.indexOf('const presentationModes ='));

function publisher(native=true) {
  let now=1000;
  const nativeMessages=[],browserMessages=[],writes=[];
  const video={currentTime:0,paused:false,playbackRate:1,seeking:false};
  const scene={generation:7,revision:1,currentItemIdentity:'song',title:'Song',videoUrl:'/media/song.mp4',overlay:{visible:false}};
  const state={presentationSession:{generation:7,mode:'localDualScreen',phase:'active'},language:'zh',
    hostPlaybackSession:{video},presentationOutputSequence:0,presentationOutputSenderId:'host',
    internetRemoteDisplay:{active:true,password:'fixture',qr_image:'data:image/svg+xml;base64,PHN2Zy8+'}};
  const publish=vm.runInNewContext(publishCode+';publishPresentationOutputState;',{
    state,window:{},Date:{now:()=>now},presentationOutputClockIntervalMs:250,presentationOutputHeartbeatMs:1000,
    presentationSyncApi:()=>sync,currentPresentationScene:()=>scene,activePrimaryVideoElement:()=>video,
    remoteAccessForPresentation:()=>({preferred_url:'http://127.0.0.1:1234/remote',connected_count:1}),
    relayPresentationOutputState:envelope=>{if(native)nativeMessages.push(envelope);return native;},
    ensurePresentationOutputChannel:()=>({postMessage:envelope=>browserMessages.push(envelope)}),
    localStorage:{setItem:(...args)=>writes.push(args),removeItem:(...args)=>writes.push(args)},
  });
  return {state,video,scene,publish,nativeMessages,browserMessages,writes,setNow:value=>{now=value;}};
}

test('native audience clocks are bounded without duplicate browser storage writes',()=>{
  const f=publisher();
  for(let i=0;i<100;i++){f.setNow(1000+i*20);f.video.currentTime=i*.02;f.publish();}
  assert.ok(f.nativeMessages.length<=9,`native messages: ${f.nativeMessages.length}`);
  assert.equal(f.browserMessages.length,0);assert.equal(f.writes.length,0);
  assert.ok(f.nativeMessages.length>=7,'a playing clock must still reach the audience regularly');
});

test('pause seek scene and feedback changes publish immediately between clock samples',()=>{
  const f=publisher();f.publish();
  f.setNow(1020);f.video.paused=true;f.publish();assert.equal(f.nativeMessages.length,2);
  f.setNow(1040);f.video.currentTime=30;f.publish();assert.equal(f.nativeMessages.length,3);
  f.setNow(1060);f.scene.title='Updated';f.publish();assert.equal(f.nativeMessages.length,4);
  f.setNow(1080);f.state.presentationActionFeedback={generation:7,sequence:1,kind:'volume',value:'65%'};
  f.publish();assert.equal(f.nativeMessages.length,5);
  f.setNow(1100);f.publish();assert.equal(f.nativeMessages.length,5,'unchanged content waits for the heartbeat');
});

test('idle clocks retain a heartbeat and an audience replay can force unchanged content',()=>{
  const f=publisher();f.video.paused=true;f.publish();
  f.setNow(1500);f.publish();assert.equal(f.nativeMessages.length,1);
  f.setNow(2000);f.publish();assert.equal(f.nativeMessages.length,2);
  f.setNow(2010);f.publish(undefined,{force:true});assert.equal(f.nativeMessages.length,3);
});

test('browser-only output retains its same-origin fallbacks',()=>{
  const f=publisher(false);f.publish();
  assert.equal(f.nativeMessages.length,0);assert.equal(f.browserMessages.length,1);assert.equal(f.writes.length,2);
});

function playbackPublisher(invoke) {
  const session={video:{},audio:{},readyCommitted:true,playbackGeneration:1,playbackProgram:{item_id:'song'}};
  const state={hostPlaybackSession:session,presentationSession:{generation:7,phase:'active'},presentationPlaybackRevision:0};
  const playback={currentTimeSeconds:0,paused:false,volumePercent:100};
  const code=app.slice(app.indexOf('function publishPresentationPlaybackState('),app.indexOf('function tauriEventListen('));
  const publish=vm.runInNewContext(code+';publishPresentationPlaybackState;',{
    state,tauriInvoke:()=>invoke,isCurrentHostPlaybackSession:current=>current===state.hostPlaybackSession,
    presentationPlaybackStateModel:()=>({...playback}),
  });
  return {publish,playback,state};
}

test('native playback observations coalesce clock progress but retain immediate controls and subsecond seeks',async()=>{
  const calls=[],f=playbackPublisher(async(name,args)=>calls.push([name,args]));
  for(let i=0;i<100;i++){f.playback.currentTimeSeconds=i*.02;await f.publish();}
  assert.equal(calls.length,2);
  f.playback.paused=true;await f.publish();assert.equal(calls.length,3);
  f.playback.volumePercent=65;await f.publish();assert.equal(calls.length,4);
  f.playback.currentTimeSeconds=1.5;await f.publish(undefined,{force:true});assert.equal(calls.length,5);
  assert.equal(calls.at(-1)[1].playbackState.currentTimeSeconds,1.5,'publish the unrounded actual observation');
});

test('a busy native relay discards superseded queued playback observations',async()=>{
  const calls=[];
  let release;
  const f=playbackPublisher(async(name,args)=>{
    calls.push(args);
    if(calls.length===1)await new Promise(resolve=>{release=resolve;});
  });
  const first=f.publish();
  await new Promise(resolve=>setImmediate(resolve));
  const pending=[];
  for(let i=1;i<=30;i++){f.playback.currentTimeSeconds=i;pending.push(f.publish());}
  f.playback.paused=true;pending.push(f.publish());release();
  await Promise.all([first,...pending]);
  assert.equal(calls.length,2);assert.equal(calls[1].playbackState.currentTimeSeconds,30);
  assert.equal(calls[1].playbackState.paused,true);
});
