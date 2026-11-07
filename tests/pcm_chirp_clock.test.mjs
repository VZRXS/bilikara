import assert from 'node:assert/strict';
import test from 'node:test';
import {installPCMChirpClock} from './browser/pcm_chirp_clock.mjs';
const read=installPCMChirpClock();
test('decoded chirp oracle resolves known timestamps and rejects a real 100ms error',()=>{
  for(const rate of [44100,48000,96000])for(const pitch of [0,2])for(const end of [.5,5,26.4]){
    const ratio=2**(pitch/12),pcm=new Float32Array(8192);
    for(let i=0;i<pcm.length;i++){
      const t=end-(pcm.length-1-i)/rate;
      pcm[i]=.2*Math.sin(2*Math.PI*ratio*(400*t+50*t*t));
    }
    const actual=read(pcm,rate,ratio);
    assert.ok(Math.abs(actual-end)<.002,JSON.stringify({rate,pitch,end,actual}));
    assert.ok(Math.abs((end-.06)-actual)<.08,'known 60ms stays within the unchanged 80ms gate');
    for(const wrong of [-.1,.1])assert.ok(Math.abs(end+wrong-actual)>.08,'real +/-100ms cannot pass');
  }
  for(const rate of [0,NaN,Infinity])assert.ok(Number.isNaN(read(new Float32Array(8192),rate)));
  assert.ok(Number.isNaN(read(new Float32Array(8192),44100)),'silence cannot become a valid timestamp');
});
