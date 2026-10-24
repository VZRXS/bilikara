import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope={queueMicrotask,setTimeout,clearTimeout,Date};
vm.runInNewContext(readFileSync(new URL('../static/audio-clock.js',import.meta.url),'utf8'),scope);
const {CapturedClock}=scope.BilikaraAudioClock;
function fixture(){
  const context=Object.assign(new EventTarget(),{currentTime:0,state:'running'});
  let assigned=10;
  const audio=Object.assign(new EventTarget(),{paused:false,seeking:false,ended:false,duration:30,playbackRate:1,readyState:4,
    pause(){this.paused=true;this.dispatchEvent(new Event('pause'));},
    play(){this.paused=false;this.dispatchEvent(new Event('play'));},
  });
  Object.defineProperty(audio,'currentTime',{configurable:true,get:()=>assigned,set:value=>{assigned=value;audio.seeking=true;audio.ended=false;}});
  let alive=true,intent=true,plays=0,changes=0;
  const errors=[];
  const clock=new CapturedClock({audio,context,current:()=>alive,shouldPlay:()=>intent,
    play(){plays++;audio.play();},changed(){changes++;},unavailable:code=>errors.push(code)});
  const finish=()=>{assigned+=1;audio.seeking=false;audio.dispatchEvent(new Event('seeked'));};
  return {audio,context,clock,finish,errors,setIntent:value=>intent=value,retire:()=>alive=false,
    plays:()=>plays,changes:()=>changes};
}

test('captured output follows the explicitly sought segment instead of the decoder read-ahead position',async()=>{
  const f=fixture();f.clock.seek(10,true);
  assert.equal(f.clock.holding,true);
  f.context.currentTime=2;
  assert.equal(f.clock.time(),10,'No elapsed media time before the seek is ready');
  f.finish();
  assert.equal(f.audio.currentTime,11,'Raw browser clock stays unchanged and observable');
  assert.equal(f.clock.time(),10);
  assert.equal(f.plays(),1);
  f.context.currentTime=2.5;
  assert.equal(f.clock.time(),10.5);
  assert.equal(f.clock.holding,false);
  f.audio.playbackRate=.5;f.audio.dispatchEvent(new Event('ratechange'));
  f.context.currentTime=3.5;
  assert.equal(f.clock.time(),11,'Rate changes retain the current position');
  f.clock.dispose();
});

test('pause, suspended context and starvation hold output and flush the old segment before resuming',async()=>{
  const f=fixture();f.clock.seek(10,true);f.finish();f.context.currentTime=.5;
  f.setIntent(false);f.audio.pause();
  assert.equal(f.clock.time(),10.5);assert.equal(f.clock.holding,true);
  f.context.currentTime=2;
  assert.equal(f.clock.time(),10.5);
  f.setIntent(true);f.audio.play();
  assert.equal(f.audio.seeking,true);
  assert.equal(f.audio.currentTime,10.5,'Resume discards queued old PCM');
  f.finish();f.context.currentTime=2.5;
  assert.equal(f.clock.time(),11);
  f.context.state='suspended';f.context.dispatchEvent(new Event('statechange'));
  assert.equal(f.clock.holding,true);
  f.context.state='running';f.context.dispatchEvent(new Event('statechange'));f.clock.sync();
  assert.equal(f.audio.currentTime,11);f.finish();
  f.context.currentTime=3;f.audio.readyState=1;f.audio.dispatchEvent(new Event('waiting'));
  assert.equal(f.clock.time(),11.5);assert.equal(f.clock.holding,true);
  f.context.currentTime=4;f.audio.readyState=2;f.clock.sync();
  assert.equal(f.audio.currentTime,11.5);f.finish();
  assert.equal(f.clock.holding,false);f.clock.dispose();
});

test('rapid seeks, a later user pause and retired callbacks cannot resume the wrong playback',async()=>{
  const f=fixture();f.clock.seek(5,true);f.clock.seek(20,true);
  f.setIntent(false);f.finish();
  assert.equal(f.clock.time(),20);assert.equal(f.plays(),0);
  f.setIntent(true);f.clock.sync();
  assert.equal(f.plays(),1);
  f.clock.seek(25,true);f.retire();
  const before=f.changes();f.finish();await Promise.resolve();
  assert.equal(f.changes(),before);assert.equal(f.plays(),1);
  f.clock.dispose();
  f.audio.play();f.context.dispatchEvent(new Event('statechange'));
  assert.equal(f.changes(),before,'Disposal removes owned listeners');
});

test('input EOS drains the remaining output, while explicit pause/seek/dispose cancels its pending completion',async()=>{
  const f=fixture();f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.pause();
  assert.equal(f.clock.running,true,'Native pause at input EOS must not cut the queued output');
  let finished=false;
  const tail=f.clock.drain().then(value=>{finished=value;return value;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(finished,false);
  f.context.currentTime=1;
  assert.equal(await tail,true);
  f.audio.ended=false;f.clock.seek(29,true);f.finish();
  const cancelled=f.clock.drain();f.clock.stop();
  assert.equal(await cancelled,false);assert.equal(f.clock.holding,true);
  assert.equal(f.clock.needsReposition,true);
  f.clock.dispose();assert.equal(await f.clock.drain(),false);
});

test('closed contexts and rejected seeks remain explicit failures',()=>{
  const f=fixture();f.clock.seek(10,true);f.finish();
  f.context.state='closed';f.context.dispatchEvent(new Event('statechange'));
  assert.deepEqual(f.errors,['context-closed']);assert.equal(f.clock.holding,true);
  f.clock.dispose();
  const g=fixture();Object.defineProperty(g.audio,'currentTime',{set(){throw Error('seek rejected');},configurable:true});
  assert.equal(g.clock.seek(12,true),false);
  g.audio.play();g.audio.dispatchEvent(new Event('seeked'));
  assert.equal(g.clock.holding,true,'Late readiness cannot hide a failed seek');
  assert.equal(g.clock.running,false);
  assert.deepEqual(g.errors,['seek-failed']);g.clock.dispose();
});

test('resuming an ended native element cannot replace the paused output tail with its implicit rewind',()=>{
  const f=fixture();f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.pause();f.setIntent(false);f.clock.stop();
  assert.equal(f.clock.time(),29);
  f.setIntent(true);
  // HTMLMediaElement.play() may rewind an ended input and dispatch seeking
  // before play. That input event must retain the explicit output segment.
  f.audio.currentTime=0;f.audio.paused=false;f.audio.dispatchEvent(new Event('seeking'));
  f.audio.dispatchEvent(new Event('play'));
  assert.equal(f.audio.currentTime,29);
  assert.equal(f.clock.time(),29);
  f.finish();f.context.currentTime=.5;
  assert.equal(f.clock.time(),29.5);f.clock.dispose();
});

test('the shared native play entry restores a captured tail before the decoder can queue an implicit rewind',async()=>{
  const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
  const start=app.indexOf('function invokeMediaPlay('),end=app.indexOf('function pauseSplitPlaybackForStartupRecovery(',start);
  const invoke=vm.runInNewContext(app.slice(start,end)+';invokeMediaPlay;',{networkOutputOwnsPlayback:()=>false});
  const f=fixture();f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.pause();f.setIntent(false);f.clock.stop();f.setIntent(true);
  f.audio.bilikaraAudioClock=f.clock;
  let rewinds=0;
  f.audio.play=function(){
    const endedAtInvocation=this.ended;this.paused=false;this.dispatchEvent(new Event('play'));
    if(endedAtInvocation){
      // An already queued decoder reset can arrive after the play callback's
      // own seek. Restoring from that callback is too late to prevent it.
      rewinds++;this.currentTime=0;this.dispatchEvent(new Event('seeking'));
    }
  };
  await invoke(f.audio);
  assert.equal(rewinds,0,'Reposition must precede the native play invocation');
  assert.equal(f.audio.currentTime,29);
  f.finish();f.context.currentTime=.5;assert.equal(f.clock.time(),29.5);f.clock.dispose();
});

test('a suspended tail deadline reports failure instead of inventing output completion',async()=>{
  const f=fixture();const saved=scope.Date;
  let now=0;scope.Date={now:()=>now};
  try{
    f.clock.seek(29,true);f.finish();f.audio.ended=true;f.audio.pause();
    const tail=f.clock.drain();now=4000;
    assert.equal(await tail,false);
    assert.deepEqual(f.errors,['tail-timeout']);
    assert.equal(f.clock.holding,true);
  }finally{scope.Date=saved;f.clock.dispose();}
});
