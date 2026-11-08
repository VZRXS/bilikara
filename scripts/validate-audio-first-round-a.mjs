// Experimental qualification, with explicit failed gates rather than a device claim.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,webkit} from 'playwright';
import {virtualOutputs} from '../research/media-gstreamer/environment.mjs';
import {pcmWindows} from '../research/pcm-observer.mjs';
import {startAudioFirst} from '../tests/media_round_a_support.mjs';
import {root} from '../tests/desktop_construction_support.mjs';
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
for(const key of ['--sdk','--video','--audio','--output'])assert.ok(args.includes(key),key);
const directory=path.resolve(value('--output'));assert.ok(!directory.startsWith(root+path.sep));mkdirSync(directory,{recursive:true});
const lab=await virtualOutputs(value('--sdk'),path.join(directory,'outputs'));
const old={...process.env};Object.assign(process.env,lab.environment);
let qualificationFailed=false;
try {
  for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]) {
    const f=await startAudioFirst(engine,path.resolve(value('--video')),path.resolve(value('--audio')));
    let recording;
    try {
      await f.main.waitForFunction(()=>roundA.player.snapshot().playing);
      const pcmFile=path.join(directory,name+'.f32le');
      recording=spawn(path.join(path.resolve(value('--sdk')),'usr/bin/parec'),['--device=rounda.monitor','--raw','--format=float32le','--rate=48000','--channels=2'],{env:lab.environment,stdio:['ignore',openSync(pcmFile,'wx'),openSync(path.join(directory,name+'-parec.stderr'),'wx')]});
      await delay(2000);await f.main.evaluate(()=>roundA.player.setKeyShift(2));await delay(2500);
      await f.main.evaluate(()=>roundA.player.setVolume(1,true));await delay(1800);
      await f.main.evaluate(()=>roundA.player.setVolume(1,false));await delay(1800);
      await f.main.evaluate(()=>roundA.player.seek(15));await delay(800);
      const recovery=await f.main.evaluate(()=>roundA.player.snapshot());assert.equal(recovery.playing,true);
      recording.kill('SIGTERM');await new Promise(resolve=>recording.once('exit',resolve));recording=null;
      const windows=pcmWindows(readFileSync(pcmFile));
      writeFileSync(path.join(directory,name+'-pcm.json'),JSON.stringify(windows,null,2));
      for(const frequency of [440,440*2**(2/12)])assert.ok(windows.some(w=>w.rms>.02&&Math.abs(w.toneHz-frequency)<8),name+' actual sink tone '+frequency);
      assert.ok(windows.some(w=>w.rms<1e-6),name+' actual sink mute');
      const boundary=await f.main.evaluate(async()=>{
        const player=roundA.player;player.pause();await player.setAvDelay(100);
        await player.load(roundA.program,player.media,0);
        return {positiveOpening:player.snapshot(),contextSampleRate:player.context.sampleRate,
          baseLatency:player.context.baseLatency??null,outputLatency:player.context.outputLatency??null};
      });
      const result={engine:name,version:f.main.context().browser().version(),functional:'PASS',realVirtualSinkPcm:'PASS',recovery,boundary,
        positiveOpeningGate:boundary.positiveOpening.mediaTime===0&&boundary.positiveOpening.audioSeconds===0&&boundary.positiveOpening.openingSilenceSeconds===.1?'PASS':'FAIL',
        expected:'Video opening must start at zero with positive delay; audio must wait for preroll',
        preciseAvDelay:'NOT QUALIFIED physically; run validate-media-timing.mjs for correlated virtual PCM/barcode evidence',physicalDevice:'DEVICE-UNVERIFIED'};
      writeFileSync(path.join(directory,name+'-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({engine:name,functional:result.functional,positiveOpeningGate:result.positiveOpeningGate}));
      if(result.positiveOpeningGate!=='PASS')qualificationFailed=true;
      assert.deepEqual(f.errors,[]);
    }finally{recording?.kill('SIGTERM');await f.close();}
  }
}finally{Object.assign(process.env,old);await lab.close();}
if(qualificationFailed)process.exitCode=2;
