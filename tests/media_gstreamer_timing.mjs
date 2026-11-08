// Independent source-content timing check after real native Seek/track/delay.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startPcmMonitor,correlatePulses} from '../research/av-timing.mjs';
import {pcmPulseEvents} from '../research/pcm-observer.mjs';

export async function validateNativeTimeline(binary,sdk,environment,video,aac,flac,directory) {
 mkdirSync(directory,{recursive:true});
 let program={playback_generation:1,item_id:'coded',item_incarnation_id:'coded-i1',artifact_set_id:'coded-a1',selected_audio_variant_id:'aac'};
 const manifest=path.join(directory,'manifest.json');writeFileSync(manifest,JSON.stringify({program,video,audio:[aac,flac],pulse_server:environment.PULSE_SERVER,pulse_device:'rounda'}));
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
  const delivery=await monitor.stop(),pcm=pcmPulseEvents(readFileSync(pcmFile),delivery.chunks),results=stages.map(s=>({...s,recovery:correlatePulses(pcm.pulses,frames,{startMs:s.startMs,endMs:s.startMs+2000,offsetMs:s.offsetMs}),steady:correlatePulses(pcm.pulses,frames,{startMs:s.startMs+2000,endMs:s.endMs,offsetMs:s.offsetMs})}));
  const failures=[];for(const s of results){if(s.steady.pairs<2)failures.push(s.label+': missing source-content-correlated PCM');if(s.steady.p95AbsoluteErrorMs===null||s.steady.p95AbsoluteErrorMs>80)failures.push(s.label+': correlated virtual offset exceeds 80ms');}
  const result={status:failures.length?'FAIL':'PASS',failures,stages:results,physical:'DEVICE-UNVERIFIED'};
  writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));writeFileSync(path.join(directory,'observations.json'),JSON.stringify({events,frames,pcm,stderr},null,2));return result;
 }catch(error){writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:String(error),events,frames,stderr},null,2));throw error;}
 finally{clearInterval(timer);if(child.exitCode===null)child.kill('SIGTERM');await monitor.stop();}
}
