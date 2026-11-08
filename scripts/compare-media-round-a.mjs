// A0 product UI; A1 stripped experiment UI; A2 renderer process only. These
// scopes are explicit: CPU differences cannot all be attributed to one decoder.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import path from 'node:path';
import {cpus,hostname,release} from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,webkit} from 'playwright';
import {virtualOutputs} from '../research/media-gstreamer/environment.mjs';
import {sampler,summarize} from '../research/linux-sampler.mjs';
import {startAudioFirst} from '../tests/media_round_a_support.mjs';
import {root} from '../tests/desktop_construction_support.mjs';
import {startPcmMonitor} from '../research/av-timing.mjs';
import {pcmWindows} from '../research/pcm-observer.mjs';
const args=process.argv.slice(2),value=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
for(const key of ['--output','--sdk','--binary','--fixture-cache','--baseline','--baseline-static'])assert.ok(args.includes(key),key);
const directory=path.resolve(value('--output'));assert.ok(!directory.startsWith(root+path.sep));mkdirSync(directory,{recursive:true});
const seconds=Number(value('--seconds','60')),repeats=Number(value('--repeats','3'));assert.ok(seconds>=10&&seconds<=1800&&repeats>=1&&repeats<=5);
const approaches=value('--approaches','a0,a1,a2').split(',');assert.ok(approaches.length&&approaches.every(a=>['a0','a1','a1-shadow','a2'].includes(a)));
const keyShift=Number(value('--key-shift','0'));assert.ok(Number.isInteger(keyShift)&&Math.abs(keyShift)<=6);
const git=(...arguments_)=>{const r=spawnSync('git',arguments_,{encoding:'utf8'});assert.equal(r.status,0);return r.stdout.trim();};
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const fixture=path.resolve(value('--fixture-cache'),'1280x720-30-d90'),video=path.join(fixture,'video.mp4'),audio=path.join(fixture,'audio.m4a');
const sourceFiles=['static/media-backend.js','research/webview-audio-first/audio-first.js','tests/media_round_a_support.mjs','tests/monotonic_clock_support.mjs','research/decoder-observer.mjs','research/av-timing.mjs','research/pcm-observer.mjs','research/media-gstreamer/src/main.rs','research/media-gstreamer/src/playbin_probe.rs','research/media-gstreamer/src/surface.rs','research/media-gstreamer/environment.mjs','research/media-gstreamer/build.rs','research/media-gstreamer/Cargo.lock','scripts/profile-playback.mjs','scripts/compare-media-round-a.mjs'];
const metadata={sourceSha:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain'),baseline:git('rev-parse',value('--baseline')+'^{commit}'),
  hashes:Object.fromEntries(sourceFiles.map(file=>[file,hash(file)])),binarySha256:hash(value('--binary')),mediaSha256:{video:hash(video),audio:hash(audio)},
  cpu:cpus()[0].model,logicalCpus:cpus().length,machine:hostname(),os:release(),buildMode:'dev',
  hardwareDecode:'software-only; inspect actual decoder facts',resolution:'1280x720',fps:30,hostViewport:'1280x800',audienceViewport:'1920x1080',seconds,repeats,approaches,keyShift,warmupSeconds:3,
  limitations:['A1 uses a stripped isolated UI and an explicit 250ms fixture relay','A2 excludes Host/Audience UI, Native Host and IPC integration; its totals include virtual output servers','A1-SHADOW adds exactly one experimental hidden video with no authority; confirm frame activity before attributing its cost','PulseAudio null sink and Xvfb are virtual outputs, not physical devices','CPU 100% = one logical core; shared-machine workload can vary','Browser media counters are not hardware-decoder instrumentation','Native always runs pinned Signalsmith; at unity A0/A1 bypass it. Equal nonzero keyShift exercises all three DSPs','Browser AudioContext rate can differ from native 48k; no product-wide percentage follows from totals']};
writeFileSync(path.join(directory,'metadata.json'),JSON.stringify(metadata,null,2));
const hz=Number(spawnSync('getconf',['CLK_TCK'],{encoding:'utf8'}).stdout);assert.ok(hz>0);
const lab=await virtualOutputs(value('--sdk'),path.join(directory,'virtual-outputs'));
const oldEnvironment={...process.env};Object.assign(process.env,lab.environment);
const results=[];
async function withPcm(label,run) {
  const file=path.join(directory,label+'.f32le');
  const monitor=startPcmMonitor(path.resolve(value('--sdk')),lab.environment,file);
  try {
    await monitor.ready;const result=await run();await monitor.stop();
    const windows=pcmWindows(readFileSync(file)),chunks=monitor.chunks;
    for(const window of windows){const frame=window.atSeconds*48000,chunk=chunks.find(c=>c.endFrame>=frame);window.monotonicMs=chunk?Number(chunk.monotonicNs)/1e6-(chunk.endFrame-frame)/48000*1000:null;}
    const start=Number(result.steadyWindowNs.start)/1e6,end=Number(result.steadyWindowNs.end)/1e6;
    const steady=windows.filter(w=>w.monotonicMs>=start&&w.monotonicMs+500<=end),expectedHz=440*2**(keyShift/12);
    const active=steady.filter(w=>w.rms>.01),matching=active.filter(w=>Math.abs(w.toneHz-expectedHz)<10);
    result.pcm={expectedHz,steadyWindows:steady.length,activeWindows:active.length,matchingToneWindows:matching.length,silenceWindows:steady.length-active.length,
      status:steady.length&&matching.length/steady.length>.98?'PASS':'FAIL',steadyWindowNs:result.steadyWindowNs,clockBasis:'common single-host Linux Node hrtime; whole 500ms PCM windows inside actual measured interval',underruns:'NOT OBSERVABLE: silence is a symptom, not an audio-server underrun counter',scope:'actual virtual sink monitor; observer process excluded from product roles'};
    writeFileSync(file+'.json',JSON.stringify({pcm:result.pcm,windows},null,2));return result;
  }finally{await monitor.stop();}
}
async function collect(read,roots) {
  const sample=sampler(roots,hz);sample();const initial=await read(),samples=[],started=performance.now(),steadyStartNs=process.hrtime.bigint().toString();let last=started;
  while(performance.now()-started<seconds*1000){await delay(1000);const now=performance.now();samples.push({seconds:(now-started)/1000,intervalSeconds:(now-last)/1000,roles:sample(),observation:await read()});last=now;}
  const elapsed=(performance.now()-started)/1000;return {elapsed,steadyWindowNs:{start:steadyStartNs,end:process.hrtime.bigint().toString()},summary:summarize(samples,elapsed),initial,final:await read(),samples};
}
try {
  for(let repetition=1;repetition<=repeats;repetition++) {
    for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]) {
      if(approaches.includes('a0')) {
      const a0dir=path.join(directory,`a0-${name}-${repetition}`);
      const command=['scripts/profile-playback.mjs','--engine',name,'--seconds',String(seconds),'--modes','dual','--repeats','1','--audible','--key-shift',String(keyShift),'--overlay','off','--qr-bytes','0','--profile','1280x720:30','--fixture-cache',value('--fixture-cache'),'--static-dir',value('--baseline-static'),'--output',a0dir];
      const pcm=await withPcm(`a0-${name}-${repetition}`,async()=>{
      const c=spawn(process.execPath,command,{env:process.env,stdio:['ignore',openSync(a0dir+'.log','wx'),openSync(a0dir+'.stderr','wx')]});
      const code=await new Promise(resolve=>c.on('exit',resolve));assert.equal(code,0,'A0 profiler failed');
      const raw=JSON.parse(readFileSync(path.join(a0dir,'profile.json'),'utf8'));
      return raw.modes[0];});
      const raw=JSON.parse(readFileSync(path.join(a0dir,'profile.json'),'utf8'));raw.modes[0].pcm=pcm.pcm;writeFileSync(path.join(a0dir,'profile.json'),JSON.stringify(raw,null,2));
      results.push({approach:'A0',engine:name,repetition,raw:a0dir,results:raw.modes});
      console.log(JSON.stringify({completed:'A0',engine:name,repetition}));
      }
      for(const approach of ['a1','a1-shadow'].filter(a=>approaches.includes(a))) {
      const shadowVideo=approach==='a1-shadow';
      const a1=await startAudioFirst(engine,video,audio,{initialKey:keyShift,shadowVideo});
      try {
        await a1.main.waitForFunction(()=>roundA.player.snapshot().playing);await a1.output.waitForFunction(()=>document.querySelector('video').currentTime>1);
        await delay(3000);
        for(const page of [a1.main,a1.output])await page.evaluate(()=>__bilikaraProfile.start());
        const observation=async()=>({host:await a1.main.evaluate(()=>({clock:roundA.player.snapshot(),profile:__bilikaraProfile.snapshot(),errors:roundA.errors})),
          audience:await a1.output.evaluate(()=>({wall:Date.now(),monotonicAt:performance.now(),time:document.querySelector('video').currentTime,profile:__bilikaraProfile.snapshot(),corrections:roundACorrections.slice(-10)}))});
        const metrics=await withPcm(`${approach}-${name}-${repetition}`,()=>collect(observation,{rustHost:a1.host.process.pid,hostBrowser:a1.hostBrowser.process().pid,audienceBrowser:a1.audienceBrowser.process().pid}));
        const result={approach:shadowVideo?'A1-SHADOW':'A1',engine:name,repetition,shadowVideo,keyShift,clockCalibration:a1.clockCalibration,decoderFacts:a1.decoderFacts,engineVersion:a1.main.context().browser().version(),...metrics};
        writeFileSync(path.join(directory,`${approach}-${name}-${repetition}.json`),JSON.stringify(result,null,2));results.push(result);
        writeFileSync(path.join(directory,'results.json'),JSON.stringify(results,null,2));
        assert.deepEqual(a1.errors,[]);assert.deepEqual(metrics.final.host.errors,[]);assert.equal(metrics.final.host.clock.hostVideoDecoders,0);
        assert.equal(await a1.main.locator('video').count(),shadowVideo?1:0);
        console.log(JSON.stringify({completed:result.approach,engine:name,repetition,summary:metrics.summary}));
      }finally{await a1.close();}
      }
    }
    if(!approaches.includes('a2'))continue;
    const program={playback_generation:1,item_id:'fixture',item_incarnation_id:'fixture-i1',artifact_set_id:'fixture-a1',selected_audio_variant_id:'aac'};
    const manifest=path.join(directory,`a2-manifest-${repetition}.json`);writeFileSync(manifest,JSON.stringify({program,video,audio:[audio],initial_key_shift:keyShift,pulse_server:process.env.PULSE_SERVER,pulse_device:'rounda'}));
    const child=spawn(path.resolve(value('--binary')),[manifest],{env:process.env,stdio:['pipe','pipe',openSync(path.join(directory,`a2-${repetition}.stderr`),'wx')]});
    let pending='',latest=null;const events=[];child.stdout.on('data',b=>{pending+=b;while(pending.includes('\n')){const end=pending.indexOf('\n'),event=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);events.push(event);if(event.type==='sample')latest=event;}});
    try {
      for(let i=0;i<200&&!(latest?.pcm_frames>=96000);i++){assert.equal(child.exitCode,null);await delay(50);}assert.ok(latest?.pcm_frames>=96000,'Gst steady PCM progression');
      await delay(3000);
      const metrics=await withPcm(`a2-${repetition}`,()=>collect(async()=>latest,{gstreamer:child.pid,audioServer:lab.pulse.pid,displayServer:lab.xvfb.pid}));
      assert.deepEqual(events.filter(e=>e.type==='error'),[]);
      assert.ok(events.some(e=>e.type==='decoders'&&e.video_caps?.includes('width=(int)1920')&&e.video_caps.includes('height=(int)1080')),'actual Audience-sized decoded output');
      const result={approach:'A2',engine:'GStreamer',repetition,...metrics,events};writeFileSync(path.join(directory,`a2-${repetition}.json`),JSON.stringify(result,null,2));results.push(result);
      child.stdin.write(JSON.stringify({action:'stop',expected_program:program,seq:1})+'\n');await new Promise(resolve=>child.on('exit',resolve));
      console.log(JSON.stringify({completed:'A2',repetition,summary:metrics.summary}));
    }finally{if(child.exitCode===null)child.kill('SIGTERM');}
    writeFileSync(path.join(directory,'results.json'),JSON.stringify(results,null,2));
  }
}finally {
  Object.assign(process.env,oldEnvironment);await lab.close();
}
