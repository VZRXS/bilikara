import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scope={queueMicrotask,setTimeout,clearTimeout,Date};
vm.runInNewContext(readFileSync(new URL('../static/audio-clock.js',import.meta.url),'utf8'),scope);
const {CapturedClock}=scope.BilikaraAudioClock;
const {AlignmentDelay}=scope.BilikaraAudioClock;

test('measured output alignment is bounded, resettable and drains on the actual context clock',async()=>{
  let alive=true,disconnected=0;
  const destination={},context={currentTime:4,state:'running',createDelay(max){
    assert.equal(max,1);return{delayTime:{value:0},connect(node){assert.equal(node,destination);},disconnect(){disconnected++;}};
  }};
  const delay=new AlignmentDelay({context,destination,current:()=>alive});
  assert.equal(delay.seconds(),0);
  assert.equal(delay.add(.125),true);assert.equal(delay.seconds(),.125);
  for(const value of [-.01,Infinity,NaN,1])assert.equal(delay.add(value),false);
  assert.equal(delay.seconds(),.125,'a rejected correction cannot silently clamp the clock');
  let finished=false;const tail=delay.drain().then(value=>{finished=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(finished,false);
  context.currentTime=4.125;assert.equal(await tail,true);
  const cancelled=delay.drain();delay.reset();assert.equal(await cancelled,false);assert.equal(delay.seconds(),0);
  delay.add(.2);const retired=delay.drain();alive=false;assert.equal(await retired,false);
  delay.dispose();assert.equal(disconnected,1);
});

test('captured pause/resume retains audible position and delayed EOF does not truncate its tail',()=>{
  const f=fixture();let delay=0;
  f.audio.bilikaraOutputDelay={seconds:()=>delay,reset:()=>{delay=0;}};
  f.clock.seek(10,true);f.finish();delay=.125;f.context.currentTime=.5;
  assert.equal(f.clock.time(),10.5);assert.equal(f.clock.outputTime(),10.375);
  f.setIntent(false);f.clock.stop();assert.equal(delay,0);assert.equal(f.clock.time(),10.375);
  f.setIntent(true);f.clock.seek(29,true);f.finish();delay=.125;f.audio.ended=true;f.audio.dispatchEvent(new Event('ended'));
  f.context.currentTime=1.6;
  assert.equal(f.clock.time(),30);assert.equal(f.clock.outputTime(),29.975);
  assert.equal(f.clock.isOutputRunning(),true);assert.equal(f.clock.isOutputComplete(),false);
  f.context.currentTime=1.625;assert.equal(f.clock.outputTime(),30);assert.equal(f.clock.isOutputComplete(),true);
  f.clock.dispose();
});
function fixture({stickyEnded=false}={}){
  const context=Object.assign(new EventTarget(),{currentTime:0,state:'running'});
  let assigned=10;
  const audio=Object.assign(new EventTarget(),{paused:false,seeking:false,ended:false,duration:30,playbackRate:1,readyState:4,
    pause(){this.paused=true;this.dispatchEvent(new Event('pause'));},
    play(){this.paused=false;this.dispatchEvent(new Event('play'));},
  });
  Object.defineProperty(audio,'currentTime',{configurable:true,get:()=>assigned,set:value=>{assigned=value;audio.seeking=true;if(!stickyEnded)audio.ended=false;}});
  let alive=true,intent=true,plays=0,changes=0;
  const errors=[];
  const clock=new CapturedClock({audio,context,current:()=>alive,shouldPlay:()=>intent,
    play(){plays++;audio.play();},changed(){changes++;},unavailable:code=>errors.push(code)});
  const finish=()=>{assigned+=1;audio.ended=false;audio.seeking=false;audio.dispatchEvent(new Event('seeked'));};
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

test('context resume recovers a startup segment without another media readiness event',()=>{
  const f=fixture();
  f.clock.seek(10,true);f.finish();
  f.context.currentTime=.5;
  f.context.state='interrupted';f.context.dispatchEvent(new Event('statechange'));
  const plays=f.plays();
  f.clock.sync();f.clock.sync();
  assert.equal(f.plays(),plays,'suspended output must not spin decoder starts');
  assert.equal(f.clock.time(),10.5);
  f.context.state='running';f.context.dispatchEvent(new Event('statechange'));
  assert.equal(f.audio.seeking,true,'resume flushes the stale captured segment');
  assert.equal(f.audio.currentTime,10.5);
  f.finish();f.context.currentTime=1;
  assert.equal(f.clock.isOutputRunning(),true);
  assert.equal(f.clock.time(),11);
  f.clock.dispose();
});

test('a delayed ordinary seeking event cannot adopt decoder read-ahead as output time',()=>{
  for(const playing of [true,false]){
    const f=fixture();f.clock.seek(10,playing);f.setIntent(playing);f.finish();
    f.context.currentTime=.125;
    const output=f.clock.time();
    // Native readiness can settle before its queued seeking notification.
    // The decoder cursor already contains queued input ahead of the output.
    const decoder=f.audio.currentTime;
    assert.equal(f.audio.seeking,false);
    f.audio.dispatchEvent(new Event('seeking'));
    assert.equal(f.clock.time(),output);
    assert.equal(f.audio.currentTime,decoder,'a stale notification must not flush valid queued audio');
    assert.equal(f.clock.isOutputRunning(),playing);f.clock.dispose();
  }
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

test('implicit repeated AV-delay seeks retain committed intent through internal native pauses [AIRPLAY-AV-DELAY]',()=>{
  const f=fixture();f.clock.seek(10,true);f.finish();
  f.clock.seek(12);
  assert.equal(f.audio.paused,true,'the first seek owns an internal decoder pause');
  f.clock.seek(13);f.finish();
  assert.equal(f.audio.paused,false,'a second offset must resume despite the transient paused input');
  assert.equal(f.clock.holding,false);assert.equal(f.clock.time(),13);
  f.setIntent(false);f.audio.paused=false;
  f.clock.seek(14);f.finish();
  assert.equal(f.audio.paused,true,'stale native playing state cannot override a committed user pause');
  f.clock.dispose();
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

test('decoder EOS before the resumed play event still starts the captured output tail',async()=>{
  const f=fixture();
  f.audio.play=function(){
    // WebKit can decode this entire short segment before dispatching play.
    this.paused=true;this.ended=true;
    this.dispatchEvent(new Event('play'));this.dispatchEvent(new Event('ended'));
  };
  f.clock.seek(29,true);f.finish();
  assert.equal(f.clock.hasPlayingTail(),true);
  assert.equal(f.clock.isOutputRunning(),true);
  assert.equal(f.clock.holding,false);
  const completed=f.clock.drain();f.context.currentTime=.5;
  assert.equal(f.clock.time(),29.5);
  f.context.currentTime=1;assert.equal(await completed,true);
  assert.equal(f.clock.hasPlayingTail(),false,'Only unplayed output is a playing tail');
  f.setIntent(false);f.clock.stop();f.audio.dispatchEvent(new Event('ended'));
  assert.equal(f.clock.running,false,'Late EOS cannot undo an explicit pause');
  assert.equal(f.clock.isOutputRunning(),false);
  f.clock.dispose();
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
  const pending=invoke(f.audio);
  assert.equal(rewinds,0,'Reposition must precede the native play invocation');
  assert.equal(f.audio.currentTime,29);
  f.finish();await pending;f.context.currentTime=.5;assert.equal(f.clock.time(),29.5);f.clock.dispose();
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

test('an EOS flag retained through an asynchronous seek cannot queue an implicit rewind',async()=>{
  const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
  const start=app.indexOf('function invokeMediaPlay('),end=app.indexOf('function pauseSplitPlaybackForStartupRecovery(',start);
  const invoke=vm.runInNewContext(app.slice(start,end)+';invokeMediaPlay;',{networkOutputOwnsPlayback:()=>false});
  const f=fixture({stickyEnded:true});f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.pause();f.setIntent(false);f.clock.stop();f.setIntent(true);
  f.audio.bilikaraAudioClock=f.clock;let plays=0,rewinds=0;
  f.audio.play=function(){plays++;if(this.ended)rewinds++;this.paused=false;this.dispatchEvent(new Event('play'));};
  const pending=invoke(f.audio);
  assert.equal(f.audio.ended,true,'Real decoders may retain EOS until seek completion');
  assert.equal(plays,0,'Do not play while the ended seek is pending');
  f.finish();await pending;
  assert.equal(plays,1);assert.equal(rewinds,0);assert.equal(f.clock.time(),29);
  f.context.currentTime=.5;assert.equal(f.clock.time(),29.5);f.clock.dispose();
});

test('pause, replacement seek and disposal cancel a deferred EOS play without reviving stale media',async()=>{
  for(const cancel of [f=>{f.setIntent(false);f.clock.stop();},f=>f.clock.seek(20,false),f=>f.clock.dispose()]){
    const f=fixture({stickyEnded:true});f.audio.ended=true;f.audio.pause();f.clock.seek(29,true);
    let plays=0;const pending=f.clock.playPrepared(()=>{plays++;f.audio.play();});
    cancel(f);await assert.rejects(pending,{name:'AbortError'});
    f.finish();assert.equal(plays,0);f.clock.dispose();
  }
});

test('a missing ended-seek completion rejects within its owned deadline and releases the queued callback',async()=>{
  const saved={setTimeout:scope.setTimeout,clearTimeout:scope.clearTimeout};
  let expire,cleared=0;
  scope.setTimeout=(callback,delay)=>{assert.equal(delay,3000);expire=callback;return 1;};
  scope.clearTimeout=()=>{cleared++;};
  const f=fixture({stickyEnded:true});
  try{
    f.audio.ended=true;f.audio.pause();f.clock.seek(29,true);
    let plays=0;const pending=f.clock.playPrepared(()=>{plays++;});
    expire();await assert.rejects(pending,/Captured audio seek timed out/);
    assert.equal(f.clock.queuedPlay,null);assert.equal(cleared,1);
    f.finish();assert.equal(plays,0);assert.equal(f.plays(),0);
    assert.equal(f.clock.holding,true);assert.equal(f.clock.failure,'seek-timeout');
  }finally{f.clock.dispose();Object.assign(scope,saved);}
});

test('a delayed native rewind after an ended-segment play preserves its explicit output position',async()=>{
  const f=fixture({stickyEnded:true});f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.pause();f.setIntent(false);f.clock.stop();f.setIntent(true);
  f.clock.seek(29,true);
  const pending=f.clock.playPrepared(()=>f.audio.play());
  f.finish();await pending;f.context.currentTime=.05;
  // Some WebKit decoders enqueue EOS's rewind behind seeked and play. All
  // application seeks use clock.seek(). The decoder can already be 150ms
  // past zero when its unsolicited rewind event reaches this listener.
  f.audio.currentTime=.149;f.audio.dispatchEvent(new Event('seeking'));
  assert.equal(f.audio.currentTime,29.05);
  assert.equal(f.clock.time(),29.05);
  f.finish();f.context.currentTime=.1;assert.equal(f.clock.time(),29.1);
  f.clock.seek(0,true);f.finish();
  assert.equal(f.clock.time(),0,'An explicit application seek to zero remains valid');
  f.clock.dispose();
});

test('a resumed captured tail completes from known source EOS even if native ended clears permanently',async()=>{
  const f=fixture();f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.dispatchEvent(new Event('ended'));
  f.setIntent(false);f.clock.stop();assert.equal(f.clock.isOutputComplete(),false);
  f.setIntent(true);f.clock.preparePlay();f.finish();
  assert.equal(f.audio.ended,false,'the resumed decoder flag need not return');
  f.context.currentTime=.5;assert.equal(f.clock.hasPlayingTail(),true);assert.equal(f.clock.isOutputComplete(),false);
  f.context.currentTime=1;assert.equal(f.clock.isOutputComplete(),true);
  f.clock.seek(0,true);f.finish();assert.equal(f.clock.isOutputComplete(),false,'a new seek cannot reuse the old output position');
  f.audio.dispatchEvent(new Event('emptied'));assert.equal(f.clock.inputEnded,false,'a new source cannot inherit EOS');
  f.context.currentTime=31;assert.equal(f.clock.isOutputComplete(),false,'elapsed context time without source EOS is insufficient');
  f.retire();assert.equal(f.clock.isOutputComplete(),false);f.clock.dispose();
});

test('a startup retry after native EOS clears cannot admit a delayed decoder rewind',async()=>{
  const f=fixture({stickyEnded:true});f.clock.seek(29,true);f.finish();
  f.audio.ended=true;f.audio.dispatchEvent(new Event('ended'));
  f.setIntent(false);f.clock.stop();f.setIntent(true);
  f.clock.preparePlay();f.finish();f.context.currentTime=.04;
  assert.equal(f.audio.ended,false);
  // A video play AbortError retries the pair and explicitly seeks the audio
  // again. Native ended is already false while its old rewind is still queued.
  f.clock.stop();f.clock.seek(29.04,true);f.finish();
  f.audio.currentTime=1.024;f.audio.dispatchEvent(new Event('seeking'));
  assert.equal(f.audio.currentTime,29.04,'The retry must retain the explicit output segment');
  assert.equal(f.clock.time(),29.04);
  f.finish();f.context.currentTime=1;
  assert.equal(f.clock.isOutputComplete(),true);
  f.clock.seek(0,true);f.finish();assert.equal(f.clock.time(),0,'Deliberate application rewind remains valid');
  f.audio.dispatchEvent(new Event('emptied'));assert.equal(f.clock.resumingEndedInput,false);
  f.clock.dispose();
});

test('a delayed decoder seek to old EOS cannot consume the resumed output segment [P1-MEDIA-1 P1-MEDIA-2]',()=>{
  const f=fixture({stickyEnded:true});f.clock.seek(28,true);f.finish();
  f.audio.ended=true;f.audio.dispatchEvent(new Event('ended'));
  f.setIntent(false);f.clock.stop();f.setIntent(true);f.clock.preparePlay();f.finish();
  f.context.currentTime=.125;
  // WebKit can expose the previous decoder's end cursor in an unsolicited
  // seeking event after the explicit resume seek has already completed.
  f.audio.currentTime=f.audio.duration;f.audio.dispatchEvent(new Event('seeking'));
  assert.equal(f.audio.currentTime,28.125,'The captured output position owns this native event');
  assert.equal(f.clock.time(),28.125);assert.equal(f.clock.isOutputComplete(),false);
  f.finish();f.context.currentTime=.25;assert.equal(f.clock.time(),28.25);
  f.clock.seek(30,true);f.finish();assert.equal(f.clock.time(),30,'An explicit application seek to the end remains valid');
  f.clock.dispose();
});

test('real captured completion still uses shared intent, current-program and single-advance guards',async()=>{
  const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
  const begin=app.indexOf('async function handleSplitVideoEnded('),end=app.indexOf('function holdVideoForAudio(',begin);
  const f=fixture();f.clock.seek(29,true);f.finish();f.audio.ended=true;f.audio.dispatchEvent(new Event('ended'));
  f.setIntent(false);f.clock.stop();f.setIntent(true);f.clock.preparePlay();f.finish();f.context.currentTime=1;
  const video={paused:false,dataset:{},pause(){this.paused=true;}};
  const session={video,audio:f.audio,readyCommitted:true,logicalPlayIntent:true};f.audio.bilikaraAudioClock=f.clock;
  const state={hostPlaybackSession:session,localShouldBePlaying:false,localPlaybackEndHandled:false};let advances=0;
  const handle=vm.runInNewContext(app.slice(begin,end)+';handleSplitAudioEnded;',{
    state,isActiveSplitPlayer:(v,a)=>v===session.video&&a===session.audio,
    shouldHoldCurrentItemForTransition:()=>false,reportSplitSyncDiagnostic(){},
    async handleLocalPlaybackEnded(){advances++;},
  });
  const item={id:'current'},report=()=>{};
  await handle(item,video,f.audio,report);assert.equal(advances,0,'paused intent cannot advance');
  state.localShouldBePlaying=true;await Promise.all([handle(item,video,f.audio,report),handle(item,video,f.audio,report)]);
  assert.equal(advances,1);assert.equal(state.localPlaybackEndHandled,true);assert.equal(f.audio.ended,false);
  f.clock.dispose();
});


test('V7 a ready seek without a second media event releases pending output on reconciliation', async () => {
  const f = fixture();
  f.clock.seek(10, true);
  await Promise.resolve(); // the initial microtask still sees seeking
  assert.equal(f.clock.pending, true);
  f.audio.seeking = false; // readiness changed without seeked/canplay
  f.clock.sync();
  assert.equal(f.clock.pending, false);
  assert.equal(f.clock.holding, false);
  assert.equal(f.clock.isOutputRunning(), true);
  assert.equal(f.plays(), 1);
  f.clock.dispose();
});
