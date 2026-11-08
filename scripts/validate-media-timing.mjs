// Round A virtual-output qualification. No product playback path imports this.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,webkit} from 'playwright';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {virtualOutputs} from '../research/media-gstreamer/environment.mjs';
import {timingFixture,startPcmMonitor,installFrameTimecodeObserver,correlatePulses,quantile} from '../research/av-timing.mjs';
import {pcmPulseEvents} from '../research/pcm-observer.mjs';
import {startAudioFirst} from '../tests/media_round_a_support.mjs';
import {startProductionPlayback} from '../tests/media_round_a_production_support.mjs';
import {calibrateMonotonic} from '../tests/monotonic_clock_support.mjs';
import {root} from '../tests/desktop_construction_support.mjs';
const args=process.argv.slice(2),value=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
for(const k of ['--sdk','--output'])assert.ok(args.includes(k),k);
const directory=path.resolve(value('--output'));assert.ok(!directory.startsWith(root+path.sep));mkdirSync(directory,{recursive:true});
const seconds=Number(value('--seconds','18')),repeats=Number(value('--repeats','1'));assert.ok(seconds>=10&&seconds<=7200&&repeats>=1&&repeats<=3);
const initialDelayMs=Number(value('--delay-ms','200'));assert.ok(Number.isInteger(initialDelayMs)&&Math.abs(initialDelayMs)<=1000);
const keyShift=Number(value('--key-shift','0'));assert.ok(Number.isInteger(keyShift)&&Math.abs(keyShift)<=6);
const sourcePulses=pcm=>pcm.pulses.map(p=>({...p,outputToneHz:p.toneHz,toneHz:p.toneHz/2**(keyShift/12)}));
const fixture=await timingFixture(path.join(directory,'fixture'),Math.ceil(seconds+45));
const lab=await virtualOutputs(value('--sdk'),path.join(directory,'outputs'));
const old={...process.env};Object.assign(process.env,lab.environment);
const status=[],source=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),dirty=!!spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout.trim();
const sourceFiles=['scripts/validate-media-timing.mjs','research/av-timing.mjs','research/pcm-observer.mjs','research/webview-audio-first/audio-first.js','tests/media_round_a_support.mjs','tests/media_round_a_production_support.mjs','tests/monotonic_clock_support.mjs','research/decoder-observer.mjs','static/audio-clock.js','static/presentation-sync.js','research/media-gstreamer/src/main.rs','research/media-gstreamer/src/playbin_probe.rs','research/media-gstreamer/src/surface.rs','media-libav/stretch.cpp'];
const hashes={};
for(const file of sourceFiles){const bytes=readFileSync(path.join(root,file));hashes[file]=createHash('sha256').update(bytes).digest('hex');const copy=path.join(directory,'source-snapshot',file);mkdirSync(path.dirname(copy),{recursive:true});writeFileSync(copy,bytes);}
writeFileSync(path.join(directory,'metadata.json'),JSON.stringify({source,dirty,hashes,binarySha256:args.includes('--binary')?createHash('sha256').update(readFileSync(value('--binary'))).digest('hex'):null,command:process.argv.slice(1),fixture,seconds,repeats,keyShift,scope:'Linux virtual-output software timing; NOT physical lip-sync'},null,2));
try {
 for(let repetition=1;repetition<=repeats;repetition++)for(const [name,engine]of [['chromium',chromium],['webkit',webkit],['a0-chromium',chromium],['a0-webkit',webkit]]) {
  if(!value('--engines','chromium,webkit').split(',').includes(name))continue;
  const production=name.startsWith('a0-');
  const f=await (production?startProductionPlayback:startAudioFirst)(engine,fixture.video,fixture.audio,{autoplay:false,initialDelayMs,initialKey:keyShift});
  const file=path.join(directory,`${name}-${repetition}.f32le`),recording=startPcmMonitor(path.resolve(value('--sdk')),lab.environment,file),stages=[];
  try {
   await recording.ready;await f.output.evaluate(installFrameTimecodeObserver);await delay(200);
   const opening=await f.main.evaluate(()=>roundA.player.snapshot());
   if(!production){assert.equal(opening.mediaTime,0);assert.equal(opening.audioSeconds,0);assert.equal(opening.openingSilenceSeconds,Math.max(0,initialDelayMs/1000));}
   async function observe(label,offsetMs,duration){
    const started=performance.now();await delay(duration*1000);const finished=performance.now();
    stages.push({label,offsetMs,started,finished,steadyStart:started+2000});
    console.log(JSON.stringify({engine:name,repetition,stage:label,seconds:duration}));
   }
   await f.main.evaluate(()=>roundA.player.play());await observe('configured-opening',initialDelayMs,seconds);
   await f.main.evaluate(()=>roundA.player.pause());const frozen=await f.main.evaluate(()=>roundA.player.snapshot().mediaTime);
   await delay(350);await f.main.evaluate(()=>roundA.player.setAvDelay(-100));
   assert.ok(Math.abs(await f.main.evaluate(()=>roundA.player.snapshot().mediaTime)-frozen)<.001,'paused delay preserves video position');
   await f.main.evaluate(()=>roundA.player.seek(0));await f.main.evaluate(()=>roundA.player.play());await observe('negative-opening',-100,6);
   await f.main.evaluate(()=>roundA.player.setAvDelay(100));await observe('running-positive-change',100,6);
   await f.main.evaluate(()=>roundA.player.seek(.02));await observe('seek-near-opening',100,6);
   const calibration=await calibrateMonotonic(f.output),frames=await f.output.evaluate(()=>roundATimecodedFrames);
   const mapped=frames.map(frame=>({...frame,atMs:frame.atMs+calibration.offsetMs}));
   const uniqueTimestamps=frames.filter(f=>f.mediaTime>=0).map(f=>Math.abs(f.frame/30-f.mediaTime)*1000);
   assert.ok(quantile(uniqueTimestamps)<34,'decoded barcode and media timestamp differ by more than one frame');
   const calibrationAfter=await calibrateMonotonic(f.output);
   const delivery=await recording.stop(),pcm=pcmPulseEvents(readFileSync(file),delivery.chunks);
   const results=stages.map(stage=>({...stage,recovery:correlatePulses(sourcePulses(pcm),mapped,{startMs:stage.started,endMs:stage.steadyStart,offsetMs:stage.offsetMs}),timing:correlatePulses(sourcePulses(pcm),mapped,{startMs:stage.steadyStart,endMs:stage.finished,offsetMs:stage.offsetMs})}));
   const failures=[];
   for(const r of results) {
    if(r.timing.pairs<Math.floor((r.finished-r.steadyStart)/1000)-1)failures.push(r.label+': insufficient matching PCM pulses');
    if(r.timing.p95AbsoluteErrorMs===null||r.timing.p95AbsoluteErrorMs>80)failures.push(r.label+': software correlated offset exceeds 80ms');
   }
   // Opening pulse must survive; source time zero is 400Hz and frame zero.
   const first=stages[0],onset=correlatePulses(sourcePulses(pcm).filter(p=>Math.abs(p.toneHz-400)<20&&p.atMs>=first.started&&p.atMs<first.started+1500),mapped,{startMs:first.started,endMs:first.started+1500,offsetMs:initialDelayMs});
   if(!onset.pairs)failures.push('opening audio pulse missing');
   else if(onset.p95AbsoluteErrorMs>80)failures.push('opening recovery: correlated virtual offset exceeds 80ms');
   const result={engine:name,repetition,version:f.main.context().browser().version(),status:failures.length?'FAIL':'PASS',failures,keyShift,opening,openingPcm:onset,calibration,calibrationAfter,
    executionTrace:await f.main.evaluate(()=>roundA.player.executionTrace),barcodeTimestampP95Ms:quantile(uniqueTimestamps),callbackVsExpectedDisplayP95Ms:quantile(frames.map(f=>Math.abs(f.callbackAtMs-f.expectedDisplayTime))),pcmDeliveryExcessP95Ms:quantile(pcm.deliveryExcessMs.map(Math.abs)),stages:results,physical:'DEVICE-UNVERIFIED',longDuration:seconds>=3600?'SOFTWARE-ONLY':'NOT RUN: 60–120 minute drift'};
   writeFileSync(file+'.json',JSON.stringify({result,frames:mapped,pcm},null,2));status.push(result);
   assert.deepEqual(f.errors,[]);
  }catch(error){
   const diagnostic=await f.main.evaluate(()=>({snapshot:roundA.player.snapshot(),trace:roundA.player.executionTrace})).catch(()=>({unavailable:true}));
   const delivery=await recording.stop(),frames=await f.output.evaluate(()=>roundATimecodedFrames).catch(()=>[]);
   const result={engine:name,repetition,status:'FAIL',error:String(error),diagnostic,stages,physical:'DEVICE-UNVERIFIED'};
   writeFileSync(file+'.failure.json',JSON.stringify({result,frames,delivery},null,2));status.push(result);console.log(JSON.stringify({engine:name,status:'FAIL',error:String(error)}));
  }finally{await recording.stop();await f.close();}
 }
 if(value('--engines','chromium,webkit').split(',').includes('native')) for(let repetition=1;repetition<=repeats;repetition++) {
  assert.ok(args.includes('--binary'),'native timing needs --binary');
  const file=path.join(directory,`native-${repetition}.f32le`),recording=startPcmMonitor(path.resolve(value('--sdk')),lab.environment,file);
  await recording.ready;
  const program={playback_generation:1,item_id:'timecode',item_incarnation_id:'timecode-i1',artifact_set_id:'timecode-a1',selected_audio_variant_id:'aac'};
  const manifest=path.join(directory,'native-manifest.json');
  writeFileSync(manifest,JSON.stringify({program,video:fixture.video,audio:[fixture.audio],initial_delay_ms:initialDelayMs,initial_key_shift:keyShift,diagnostic_max_seconds:Math.ceil(seconds+40),pulse_server:lab.environment.PULSE_SERVER,pulse_device:'rounda'}));
  const child=spawn(path.resolve(value('--binary')),[manifest],{env:lab.environment});
  const events=[],frames=[],requests=new Map();let text='',stderr='',seq=0;
  child.stdout.on('data',buffer=>{text+=buffer;while(text.includes('\n')){const end=text.indexOf('\n'),event=JSON.parse(text.slice(0,end));text=text.slice(end+1);event.receivedMs=performance.now();events.push(event);if(event.type==='surface-observation'&&requests.has(event.seq)){const before=requests.get(event.seq);frames.push({frame:event.timecode_frame,atMs:(before+event.receivedMs)/2,uncertaintyMs:(event.receivedMs-before)/2});requests.delete(event.seq);}}});
  child.stderr.on('data',buffer=>stderr+=buffer);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const started=performance.now();let heartbeat=started;
  const poll=setInterval(()=>{
    const id=++seq;requests.set(id,performance.now());child.stdin.write(JSON.stringify({action:'surfaceProbe',timecodeOnly:true,seq:id,expected_program:program})+'\n');
    if(performance.now()-heartbeat>=60000){heartbeat=performance.now();console.log(JSON.stringify({engine:'native',elapsedSeconds:(heartbeat-started)/1000,lastObservedFrame:frames.at(-1)?.frame,pcmBytes:recording.chunks.at(-1)?.endFrame*8}));}
  },100);
  try {
   await Promise.race([delay(seconds*1000),exited.then(exit=>{throw Error('renderer exited before timing window: '+JSON.stringify(exit));})]);const finished=performance.now();clearInterval(poll);
   child.stdin.write(JSON.stringify({action:'stop',seq:++seq,expected_program:program})+'\n');
   const exit=await exited;assert.equal(exit.code,0,stderr);
   const delivery=await recording.stop(),pcm=pcmPulseEvents(readFileSync(file),delivery.chunks);
   // Warm steady state starts after actual sink PCM, not process launch or
   // read-ahead appsink progress. Preserve startup observations separately.
   const firstAudioMs=pcm.pulses[0]?.atMs??finished,steadyStart=Math.max(started+2000,firstAudioMs+2000);
   const timing=correlatePulses(sourcePulses(pcm),frames,{startMs:steadyStart,endMs:finished,offsetMs:initialDelayMs});
   const startupTiming=correlatePulses(sourcePulses(pcm),frames,{startMs:started,endMs:steadyStart,offsetMs:initialDelayMs});
   const failures=[];if(timing.pairs<Math.floor((finished-steadyStart)/1000)-1)failures.push('insufficient correlated PCM pulses');
   if(timing.p95AbsoluteErrorMs===null||timing.p95AbsoluteErrorMs>80)failures.push('software correlated offset exceeds 80ms');
   const driftOverRunMs=timing.driftSlopeMsPerSecond*((finished-steadyStart)/1000);
   if(seconds>=180&&Math.abs(driftOverRunMs)>1000/30)failures.push('fitted drift exceeds one frame over run');
   if(events.some(e=>e.type==='error'))failures.push('renderer error');
   const result={engine:'native',repetition,status:failures.length?'FAIL':'PASS',seconds,failures,timing,startupTiming,startupFirstPcmMs:firstAudioMs-started,steadyStartMs:steadyStart,driftOverRunMs,probeRttUncertaintyP95Ms:quantile(frames.map(f=>f.uncertaintyMs)),pcmDeliveryExcessP95Ms:quantile(pcm.deliveryExcessMs.map(Math.abs)),physical:'DEVICE-UNVERIFIED',longDuration:seconds>=3600?'SOFTWARE-ONLY':'NOT RUN: 60–120 minute drift'};
   writeFileSync(file+'.json',JSON.stringify({result,frames,pcm,events,stderr},null,2));status.push(result);console.log(JSON.stringify({engine:'native',status:result.status,pairs:timing.pairs}));
  }finally{clearInterval(poll);if(child.exitCode===null)child.kill('SIGTERM');await recording.stop();}
 }

}finally{Object.assign(process.env,old);await lab.close();writeFileSync(path.join(directory,'results.json'),JSON.stringify(status,null,2));}
if(status.some(s=>s.status!=='PASS'))process.exitCode=2;
