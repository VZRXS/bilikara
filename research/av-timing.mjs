// Synthetic timecode/PCM observations. These are virtual-output measurements,
// never microphone/photodiode or physical lip-sync qualification.
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,createWriteStream} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runNative} from '../tests/desktop_construction_support.mjs';

export async function timingFixture(directory,seconds=90) {
  mkdirSync(directory,{recursive:true});
  const video=path.join(directory,'timecode.mp4'),audio=path.join(directory,'pulses.m4a');
  // Twenty 32px binary cells encode the ACTUAL decoded frame, independently of
  // HTML currentTime/rVFC's mediaTime. Below them, two white frames per second
  // correlate with a 60ms tone pulse whose frequency identifies second mod 16.
  const picture="color=black:s=640x360:r=30:d="+seconds+",drawbox=x=0:y=32:w=iw:h=ih-32:color=white:t=fill:enable='lt(mod(n,30),2)'"
    +Array.from({length:20},(_,bit)=>`,drawbox=x=${bit*32}:y=0:w=32:h=32:color=white:t=fill:enable='mod(floor(n/${2**bit}),2)'`).join('');
  const sound="aevalsrc=if(lt(mod(t\\,1)\\,0.06)\\,0.5*sin(2*PI*(400+50*mod(floor(t)\\,16))*t)\\,0):s=48000:d="+seconds;
  for(const [file,args]of [[video,['-f','lavfi','-i',picture,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']],
    [audio,['-f','lavfi','-i',sound,'-c:a','aac','-b:a','192k']]]) {
    const r=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,'-threads','4',file],process.env,Math.min(300000,Math.max(60000,seconds*100)));assert.equal(r.status,0,r.stderr);
  }
  const result={video,audio,seconds,fps:30,resolution:'640x360',rate:48000,channels:1,
    hashes:Object.fromEntries([video,audio].map(f=>[path.basename(f),createHash('sha256').update(readFileSync(f)).digest('hex')]))};
  writeFileSync(path.join(directory,'fixture.json'),JSON.stringify(result,null,2));return result;
}

export function startPcmMonitor(sdk,env,file) {
  const chunks=[],stream=createWriteStream(file,{flags:'wx'});let bytes=0,stderr='',readyAt=null,resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  // Callers may retain older observation-only usage; awaited readiness still
  // rejects, while an unconsumed diagnostic Promise is never unhandled.
  ready.catch(()=>{});
  const timer=setTimeout(()=>{rejectReady(Error('PCM capture produced no data within 5s'));child.kill('SIGTERM');},5000);
  const child=spawn(path.join(sdk,'usr/bin/parec'),['--device=rounda.monitor','--raw','--format=float32le','--rate=48000','--channels=2','--latency-msec=10','--process-time-msec=10','--verbose'],{env});
  child.stdout.on('data',buffer=>{
    bytes+=buffer.length;const chunk={endFrame:bytes/8,atMs:performance.now(),monotonicNs:process.hrtime.bigint().toString()};chunks.push(chunk);stream.write(buffer);
    if(!readyAt){readyAt=chunk;clearTimeout(timer);resolveReady(chunk);}
  });
  child.on('error',error=>{clearTimeout(timer);rejectReady(error);});
  child.stderr.on('data',buffer=>stderr+=buffer);
  const exited=new Promise(resolve=>{child.once('exit',(code,signal)=>{clearTimeout(timer);if(!readyAt)rejectReady(Error('PCM capture exited before readiness'));resolve({code,signal});});child.once('error',error=>resolve({code:null,error:error.message}));});let stopping;
  return {chunks,child,ready,stop(){return stopping??=(async()=>{clearTimeout(timer);if(!readyAt)rejectReady(Error('PCM capture stopped before readiness'));child.kill('SIGTERM');const exit=await exited;await new Promise(resolve=>stream.end(resolve));writeFileSync(file+'.delivery.json',JSON.stringify({chunks,readyAt,requestedLatencyMs:10,stderr,exit},null,2));return {chunks,readyAt,stderr,exit};})();}};
}

export function installFrameTimecodeObserver() {
  const video=document.querySelector('video'),canvas=document.createElement('canvas');canvas.width=640;canvas.height=32;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),frames=[];let previous=-1;
  globalThis.roundATimecodedFrames=frames;
  const observe=(at,metadata)=>{
    ctx.drawImage(video,0,0,video.videoWidth,video.videoHeight*32/360,0,0,640,32);const row=ctx.getImageData(0,16,640,1).data;
    let frame=0;for(let bit=0;bit<20;bit++)if(row[(bit*32+16)*4]>128)frame+=2**bit;
    if(frame!==previous){frames.push({frame,atMs:performance.now(),callbackAtMs:at,expectedDisplayTime:metadata.expectedDisplayTime,presentationTime:metadata.presentationTime,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames});previous=frame;}
    if(frames.length<250000)video.requestVideoFrameCallback(observe);
  };
  video.requestVideoFrameCallback(observe);
}

export function quantile(values,fraction=.95) {
  const s=[...values].sort((a,b)=>a-b);return s.length?s[Math.ceil(s.length*fraction)-1]:null;
}

export function correlatePulses(pulses,frames,{startMs=-Infinity,endMs=Infinity,offsetMs=0}={}) {
  const selected=pulses.filter(p=>p.atMs>=startMs&&p.atMs<endMs),pairs=[];
  const groups=new Map();
  // Never mix frames from an adjacent control/offset phase into a steady
  // estimate. Use early observations of each coded second; an already-held
  // preroll image is recovery evidence, not a steady pulse presentation.
  for(const frame of frames.filter(f=>f.atMs>=startMs&&f.atMs<endMs&&f.frame%30<=5)) {
    const second=Math.floor(frame.frame/30);
    if(!groups.has(second))groups.set(second,[]);
    groups.get(second).push(frame.atMs-(frame.frame%30)*1000/30);
  }
  const presentations=[...groups].map(([second,times])=>({second,atMs:quantile(times,.5)}));
  for(const pulse of selected) {
    // Estimate the presentation of the integer-second frame using its barcode,
    // not a metadata clock. Native X11 polls may first see frame second*30+1.
    const ordinal=((Math.round((pulse.toneHz-400)/50)%16)+16)%16;
    const candidates=presentations.filter(f=>f.second%16===ordinal);
    if(!candidates.length)continue;
    const closest=candidates.reduce((a,b)=>Math.abs(pulse.atMs-a.atMs-offsetMs)<Math.abs(pulse.atMs-b.atMs-offsetMs)?a:b);
    const visibleAtMs=closest.atMs;
    pairs.push({audioAtMs:pulse.atMs,videoAtMs:visibleAtMs,frame:closest.second*30,toneHz:pulse.toneHz,offsetMs:pulse.atMs-visibleAtMs,errorMs:pulse.atMs-visibleAtMs-offsetMs});
  }
  const errors=pairs.map(p=>p.errorMs),mean=errors.length?errors.reduce((a,b)=>a+b,0)/errors.length:null;
  const x=pairs.map(p=>(p.audioAtMs-(pairs[0]?.audioAtMs||0))/1000),xm=x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
  const denominator=x.reduce((a,v)=>a+(v-xm)**2,0);
  const slope=denominator?pairs.reduce((a,p,i)=>a+(x[i]-xm)*(p.errorMs-mean),0)/denominator:null;
  return {pairs: pairs.length,meanErrorMs:mean,p95AbsoluteErrorMs:quantile(errors.map(Math.abs)),driftSlopeMsPerSecond:slope,observations:pairs,
    measurement:'PulseAudio monitor sample stream versus decoded barcode/compositor callback or composited X11 pixels; delivery/calibration uncertainty applies',physical:'DEVICE-UNVERIFIED'};
}
