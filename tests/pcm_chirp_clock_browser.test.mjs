import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium,webkit} from 'playwright';
import {installPCMChirpClock} from './browser/pcm_chirp_clock.mjs';

for(const [name,engine] of Object.entries({chromium,webkit}))test(`${name}: PCM oracle calibrates against an independent scheduled source`,{
  skip:process.platform!=='linux',timeout:30000,
},async()=>{
  const browser=await engine.launch({headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<button>Start calibration</button>');
    await page.evaluate(installPCMChirpClock);
    await page.evaluate(()=>{document.querySelector('button').onclick=async()=>{
      window.calibrationContext=new AudioContext();const ctx=calibrationContext;
      const source=ctx.createBufferSource(),buffer=ctx.createBuffer(1,ctx.sampleRate*4,ctx.sampleRate);
      const pcm=buffer.getChannelData(0);for(let i=0;i<pcm.length;i++){
        const t=10+i/ctx.sampleRate;pcm[i]=.2*Math.sin(2*Math.PI*(400*t+50*t*t));
      }
      window.calibrationAnalyser=ctx.createAnalyser();calibrationAnalyser.fftSize=8192;
      source.buffer=buffer;source.connect(calibrationAnalyser);calibrationAnalyser.connect(ctx.destination);
      await ctx.resume();window.calibrationStart=ctx.currentTime+.1;source.start(calibrationStart);
    };});
    await page.click('button');await page.waitForFunction(()=>Number.isFinite(window.calibrationStart)
      && window.calibrationContext?.currentTime>window.calibrationStart+.3);
    for(let i=0;i<8;i++){
      const s=await page.evaluate(()=>{
        const ctx=calibrationContext,pcm=new Float32Array(calibrationAnalyser.fftSize),before=ctx.currentTime;
        calibrationAnalyser.getFloatTimeDomainData(pcm);
        return{time:readPCMChirpTime(pcm,ctx.sampleRate),before:10+before-calibrationStart,
          after:10+ctx.currentTime-calibrationStart,quantum:128/ctx.sampleRate};
      });
      assert.ok(s.time>=s.before-2*s.quantum-.001&&s.time<=s.after+.001,JSON.stringify(s));
      assert.ok(Math.abs(s.before-.06-s.time)<.08,'known 60ms remains within the original 80ms gate');
      for(const wrong of [-.1,.1])assert.ok(Math.abs(s.before+wrong-s.time)>.08,'true +/-100ms is rejected');
      await page.waitForTimeout(60);
    }
    await page.evaluate(()=>calibrationContext.close());
  }finally{await browser.close();}
});
