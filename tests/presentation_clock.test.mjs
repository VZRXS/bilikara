import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const sync=require('../static/presentation-sync.js');
const source=readFileSync(new URL('../static/controller.js',import.meta.url),'utf8');
const clockCode=source.slice(source.indexOf('  function safeSeek('),source.indexOf('  function reportOutputDiagnostics('));

function follower() {
  let now=1000,time=0;
  const seeks=[],rates=[],errors=[];
  const video={readyState:4,paused:false,seeking:false,ended:false,duration:300,
    get currentTime(){return time;},set currentTime(value){time=value;this.seeking=true;seeks.push(value);},
    _rate:1,get playbackRate(){return this._rate;},set playbackRate(value){this._rate=value;rates.push(value);},
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},
  };
  const state={video,failedClosed:false,lastMasterAt:now,session:{phase:'active'},
    scene:{currentItemIdentity:'song'},clock:{itemIdentity:'song',mediaTime:10,sampledAt:now,paused:false,playbackRate:1}};
  const clock=vm.runInNewContext(clockCode+';({apply:applyClock,seeked:finishClockSeek});',{
    state,sync,androidDisplay:null,Date:{now:()=>now},reportOutputDiagnostics(){},setError:message=>errors.push(message),t:key=>key,
  });
  return {state,video,seeks,rates,errors,apply:clock.apply,seeked:()=>clock.seeked(video),setNow(value){now=value;},settle(value){time=value;video.seeking=false;}};
}

test('a paused or retired audience play request cannot report an autoplay failure',async()=>{
  for(const reason of ['paused','retired','aborted']){
    const f=follower();f.state.clock.mediaTime=0;f.video.paused=true;
    let reject;
    f.video.play=()=>new Promise((_,fail)=>{reject=fail;});f.apply();
    if(reason==='paused'){f.state.clock.paused=true;f.apply();}
    if(reason==='retired')f.state.video=null;
    reject(Object.assign(new Error(reason),{name:reason==='aborted'?'AbortError':'NotAllowedError'}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.errors,[],reason);
  }
  const f=follower();f.state.clock.mediaTime=0;f.video.paused=true;
  f.video.play=()=>Promise.reject(Object.assign(new Error('policy'),{name:'NotAllowedError'}));
  f.apply();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.errors,['controller.autoplayBlocked'],'an actual policy rejection still requests a user gesture');
});

test('audience waits for an outstanding decoder seek instead of replacing it every clock tick',()=>{
  const f=follower();f.apply();
  for(let ms=1100;ms<=1900;ms+=100){f.setNow(ms);f.apply();}
  assert.equal(f.seeks.length,1,'one pending seek must be allowed to finish');
  f.settle(10.9);f.apply();assert.equal(f.seeks.length,1);
});

test('audience preserves the decoder rate through a seek instead of restarting its pipeline twice',()=>{
  const f=follower();f.settle(9.9);f.apply();
  assert.equal(f.video.playbackRate,1.04);
  f.settle(9);f.apply();
  assert.equal(f.seeks.length,1);
  assert.deepEqual(f.rates,[1.04],'starting a position correction must not also change the decoder rate');
  f.setNow(1100);f.apply();
  assert.deepEqual(f.rates,[1.04],'an outstanding seek retains its current rate');
  f.settle(10.1);f.seeked();
  assert.equal(f.video.playbackRate,1,'alignment still restores the Host rate after the seek');
});

test('audience lets a slow decoder play between drift corrections',()=>{
  const f=follower();f.apply();f.setNow(1300);f.settle(9.5);f.seeked();
  assert.equal(f.seeks.length,1,'normal drift must not immediately start a second seek');
  f.setNow(1800);f.apply();assert.equal(f.seeks.length,1,'cooldown starts at decoder completion');
  f.setNow(2100);f.apply();assert.equal(f.seeks.length,2,'persistent drift remains correctable');
});

test('a seek longer than the correction interval still releases the decoder before another correction',()=>{
  const f=follower();f.apply();f.setNow(1900);f.settle(10);f.seeked();
  assert.equal(f.seeks.length,1);assert.equal(f.video.seeking,false);
  assert.equal(f.video.paused,false);
  f.setNow(2000);f.apply();assert.equal(f.seeks.length,1);
  f.setNow(2700);f.apply();assert.equal(f.seeks.length,2);
});

test('a retired decoder seek completion cannot change the current audience clock',()=>{
  const f=follower();f.apply();const before=f.state.lastClockSeekAt;
  f.state.video={};f.setNow(1900);f.seeked();
  assert.equal(f.state.lastClockSeekAt,before);assert.equal(f.seeks.length,1);
});

test('pause stays immediate during a seek and the latest explicit position bypasses cooldown after it settles',()=>{
  const f=follower();f.apply();
  f.state.clock={...f.state.clock,paused:true,mediaTime:25};f.state.forceClockSeek=true;
  f.setNow(1200);f.apply();assert.equal(f.video.paused,true);assert.equal(f.seeks.length,1);
  f.settle(10);f.apply();assert.equal(f.seeks.at(-1),25);
  assert.equal(f.video.paused,true);
});

test('a fresh envelope cannot revive an expired clock sample, and small correction returns to the Host rate',()=>{
  const f=follower();f.settle(9.9);f.apply();assert.equal(f.video.playbackRate,1.04);
  f.settle(10);f.apply();assert.equal(f.video.playbackRate,1);
  f.setNow(21000);f.state.lastMasterAt=21000;f.apply();assert.equal(f.video.paused,true);
});

test('audience stops following an expired Host clock rather than fast forwarding indefinitely',()=>{
  const f=follower();f.apply();f.settle(10);f.setNow(21000);f.apply();
  assert.equal(f.video.paused,true);assert.equal(f.seeks.length,1);
  f.state.lastMasterAt=21000;f.state.clock={...f.state.clock,mediaTime:30,sampledAt:21000};
  f.apply();assert.equal(f.video.paused,false);assert.equal(f.seeks.at(-1),30);
});

test('clock prediction is bounded and rate correction never accumulates onto the follower rate',()=>{
  const clock={itemIdentity:'song',mediaTime:10,sampledAt:1000,paused:false,playbackRate:1};
  assert.ok(sync.predictedMediaTime(clock,61000)<=12,'old samples cannot predict a minute of independent playback');
  let rate=1;
  for(let i=0;i<18000;i++){
    const current=10+i/10;
    const decision=sync.planClockCorrection({...clock,mediaTime:current,sampledAt:1000+i*100},
      {currentTime:current-.1,paused:false,playbackRate:rate},1000+i*100);
    rate=decision.playbackRate;assert.ok(rate>=.96&&rate<=1.04);
  }
});
