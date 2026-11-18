// Independent source-content timing check after real native Seek/track/delay.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startPcmMonitor,correlatePulses} from '../research/av-timing.mjs';
import {codedPcmPulseEvents,pcmPulseEvents} from '../research/pcm-observer.mjs';
import {runNative} from './desktop_construction_support.mjs';

export async function validateNativeTail(binary, sdk, environment, directory, clock) {
  mkdirSync(directory, {recursive: true});
  const video = path.join(directory, 'video.mp4'), audio = path.join(directory, 'tail.m4a');
  // All source tone lies inside the final 60 ms, shorter than DSP latency.
  // Passing requires output samples from the drain, even if EOS was posted.
  for (const args of [
    ['-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', video],
    ['-i', 'aevalsrc=if(gte(t\\,3.94)\\,0.25*sin(2*PI*440*t)\\,0):s=48000:d=4', '-c:a', 'aac', '-b:a', '192k', audio],
  ]) {
    const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', ...args], process.env, 30000);
    assert.equal(result.status, 0, result.stderr);
  }
  const program = {playback_generation: 1, item_id: 'coded-tail', item_incarnation_id: 'coded-tail-i1',
    artifact_set_id: 'coded-tail-a1', selected_audio_variant_id: 'aac'};
  const manifest = path.join(directory, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({program, video, audio: [audio], pulse_server: environment.PULSE_SERVER,
    pulse_device: 'rounda', diagnostic_clock: clock, initial_key_shift: 2}));
  const pcmFile = path.join(directory, 'sink.f32le'), monitor = startPcmMonitor(sdk, environment, pcmFile);
  const events = [];
  let child, finished;
  try {
    await monitor.ready;
    child = spawn(binary, [manifest], {env: environment, stdio: ['pipe', 'pipe', 'inherit']});
    let spawnError;
    child.once('error', error => { spawnError = error; });
    finished = new Promise(resolve => child.once('close', resolve));
    createInterface({input: child.stdout}).on('line', line => events.push(JSON.parse(line)));
    const deadline = performance.now() + 10000;
    while (!events.some(e => e.type === 'eos') && performance.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'tail renderer exited before draining');
      await delay(20);
    }
    assert.equal(events.filter(e => e.type === 'eos').length, 1, 'coded tail drains once');
    // The server's monitor delivery can lag its sink. Keep the renderer alive
    // until the captured sample itself is observable.
    await delay(250);
    const delivery = await monitor.stop();
    const {pulses} = pcmPulseEvents(readFileSync(pcmFile), delivery.chunks);
    writeFileSync(path.join(directory, 'pulses.json'), JSON.stringify({clock, pulses}, null, 2));
    assert.ok(pulses.some(p => p.durationMs >= 20 && Math.abs(p.toneHz - 440 * 2 ** (2 / 12)) < 30),
      'the shifted final source pulse reaches the actual PulseAudio monitor');
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM');
    await finished;
    await monitor.stop();
    writeFileSync(path.join(directory, 'events.json'), JSON.stringify(events, null, 2));
  }
}

export async function validateNativeTimeline(binary,sdk,environment,video,aac,flac,directory,clock) {
 mkdirSync(directory,{recursive:true});
 let program={playback_generation:1,item_id:'coded',item_incarnation_id:'coded-i1',artifact_set_id:'coded-a1',selected_audio_variant_id:'aac'};
 const manifest=path.join(directory,'manifest.json');writeFileSync(manifest,JSON.stringify({program,video,audio:[aac,flac],pulse_server:environment.PULSE_SERVER,pulse_device:'rounda',diagnostic_clock:clock}));
 const pcmFile=path.join(directory,'sink.f32le'),monitor=startPcmMonitor(sdk,environment,pcmFile);
 await monitor.ready;
 const child=spawn(binary,[manifest],{env:environment}),events=[],frames=[],sent=new Map(),stages=[];let text='',stderr='',seq=0;
 child.stdout.on('data',buffer=>{text+=buffer;while(text.includes('\n')){const end=text.indexOf('\n'),e=JSON.parse(text.slice(0,end));text=text.slice(end+1);e.receivedMs=performance.now();events.push(e);if(e.type==='surface-observation'&&sent.has(e.seq))frames.push({frame:e.timecode_frame,atMs:(sent.get(e.seq)+e.receivedMs)/2,uncertaintyMs:(e.receivedMs-sent.get(e.seq))/2});}});
 child.stderr.on('data',buffer=>stderr=(stderr+buffer).slice(-65536));
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 const wait=async predicate=>{const until=performance.now()+10000;while(performance.now()<until){assert.equal(child.exitCode,null,stderr);const value=predicate();if(value)return value;await delay(10);}throw Error('native timeline condition timeout');};
 async function command(action,parameters={}){const id=++seq;sent.set(id,performance.now());child.stdin.write(JSON.stringify({action,seq:id,expected_program:program,...parameters})+'\n');const result=await wait(()=>events.find(e=>e.type==='command'&&e.seq===id));assert.equal(result.accepted,true,action);return result;}
 const timer=setInterval(()=>{const id=++seq;sent.set(id,performance.now());child.stdin.write(JSON.stringify({action:'surfaceProbe',timecodeOnly:true,seq:id,expected_program:program})+'\n');},100);
 async function observe(label,offsetMs){const startMs=performance.now();await delay(6000);stages.push({label,offsetMs,startMs,endMs:performance.now()});}
 try {
  await wait(()=>frames.some(f=>f.frame>=30));
  await command('seek',{seconds:8});await wait(()=>frames.some(f=>f.frame>=240&&f.frame<270));await observe('seek-eight-seconds',0);
  const next={...program,playback_generation:2,selected_audio_variant_id:'flac'};await command('track',{index:1,program:next});program=next;await observe('selected-independent-flac',0);
  await command('delay',{milliseconds:100});await observe('positive-delay',100);
  await command('delay',{milliseconds:-100});await observe('negative-delay',-100);
  await command('stop');const exit=await exited;assert.equal(exit.code,0,stderr);
  const delivery=await monitor.stop(),pcm=codedPcmPulseEvents(readFileSync(pcmFile),delivery.chunks),results=stages.map(s=>({...s,recovery:correlatePulses(pcm.pulses,frames,{startMs:s.startMs,endMs:s.startMs+2000,offsetMs:s.offsetMs}),steady:correlatePulses(pcm.pulses,frames,{startMs:s.startMs+2000,endMs:s.endMs,offsetMs:s.offsetMs})}));
  const failures=[];for(const s of results){if(s.steady.pairs<2)failures.push(s.label+': missing source-content-correlated PCM');if(s.steady.p95AbsoluteErrorMs===null||s.steady.p95AbsoluteErrorMs>80)failures.push(s.label+': correlated virtual offset exceeds 80ms');}
  const selectedClock=events.find(e=>e.type==='clock')?.name??null;
  if(clock==='system'&&selectedClock!=='GstSystemClock')failures.push('system clock was requested but not selected');
  const result={status:failures.length?'FAIL':'PASS',diagnosticClock:clock,selectedClock,failures,stages:results,physical:'DEVICE-UNVERIFIED'};
  writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));writeFileSync(path.join(directory,'observations.json'),JSON.stringify({events,frames,pcm,stderr},null,2));return result;
 }catch(error){writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error),events,frames,stderr},null,2));throw error;}
 finally{clearInterval(timer);if(child.exitCode===null)child.kill('SIGTERM');await monitor.stop();}
}
