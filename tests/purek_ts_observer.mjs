// Independent MPEG-TS/ADTS observer; no product muxer is imported.
import assert from 'node:assert/strict';
export function inspectTs(bytes,{videoFrames=24,channels,sampleRate}={}){
  assert.equal(bytes.length%188,0);const cc=new Map(),streams=new Map(),dts=new Map(),pts=new Map(),elementary=new Map();
  let pmtPid,pat=0,pmt=0;const pcr=[],patTimes=[],pmtTimes=[];
  const stamp=b=>((b[0]>>1)&7)*2**30+b[1]*2**22+(b[2]>>1)*2**15+b[3]*128+(b[4]>>1);
  for(let n=0;n<bytes.length;n+=188){
    const p=bytes.subarray(n,n+188);assert.equal(p[0],0x47);assert.equal(p[1]&0x80,0,'no TEI');
    const pid=((p[1]&31)<<8)|p[2],kind=(p[3]>>4)&3;assert.notEqual(kind,0);
    if((kind&1)&&pid!==8191){if(cc.has(pid))assert.equal(p[3]&15,(cc.get(pid)+1)&15,'continuity counter');cc.set(pid,p[3]&15);}
    let offset=4;
    if(kind&2){
      if(p[4]>=7&&(p[5]&16)){const a=p.subarray(6,12);pcr.push(a[0]*2**25+a[1]*2**17+a[2]*512+a[3]*2+(a[4]>>7));}
      offset+=1+p[4];
    }
    if(!(kind&1)||offset>=188)continue;
    const payload=p.subarray(offset),start=Boolean(p[1]&64);
    if(start&&(pid===0||pid===pmtPid)){
      const s=payload.subarray(1+payload[0]);
      if(pid===0){assert.equal(s[0],0);pmtPid=((s[10]&31)<<8)|s[11];pat++;if(pcr.length)patTimes.push(pcr.at(-1));}
      else{assert.equal(s[0],2);pmt++;if(pcr.length)pmtTimes.push(pcr.at(-1));const end=3+((s[1]&15)<<8)+s[2]-4;
        for(let i=12+((s[10]&15)<<8)+s[11];i<end;i+=5+((s[i+3]&15)<<8)+s[i+4])streams.set(((s[i+1]&31)<<8)|s[i+2],s[i]);}
    }
    if(start&&streams.has(pid)&&payload[0]===0&&payload[1]===0&&payload[2]===1){
      const mode=(payload[7]>>6)&3;assert.ok(mode===2||mode===3);
      const pt=stamp(payload.subarray(9,14)),dt=mode===3?stamp(payload.subarray(14,19)):pt;
      if(pcr.length)assert.ok(dt>=pcr.at(-1),'PES decode time must not precede PCR');
      const times=dts.get(pid)||[];if(times.length)assert.ok(dt>times.at(-1),'DTS advances per stream');times.push(dt);dts.set(pid,times);
      const presentation=pts.get(pid)||[];presentation.push(pt);pts.set(pid,presentation);
    }
    if(streams.has(pid)){const chunks=elementary.get(pid)||[];chunks.push(start?payload.subarray(9+payload[8]):payload);elementary.set(pid,chunks);}
  }
  assert.deepEqual([...streams.values()].sort((a,b)=>a-b),[15,27]);assert.ok(pat>=2&&pmt>=2);assert.ok(pcr.length>=24);
  const gap=values=>Math.max(...values.slice(1).map((v,i)=>(v-values[i]+2**33)%2**33/90));
  assert.ok(gap(pcr)<=40.1,`PCR interval ${gap(pcr)} ms`);
  assert.ok(gap(patTimes)<=100.1);assert.ok(gap(pmtTimes)<=100.1);
  const video=[...streams].find(([,type])=>type===27)[0],audio=[...streams].find(([,type])=>type===15)[0];
  assert.equal(dts.get(video).length,videoFrames);assert.ok(dts.get(audio).length>=2);
  const aac=Buffer.concat(elementary.get(audio));let frames=0,rate;
  for(let i=0;i<aac.length;){
    assert.equal(aac[i],255);assert.equal(aac[i+1]&0xf6,0xf0,'ADTS frame sync');assert.equal(aac[i+2]>>6,1,'AAC-LC');
    rate=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000][(aac[i+2]>>2)&15];assert.ok(rate);
    if(channels!==undefined)assert.equal(((aac[i+2]&1)<<2)|(aac[i+3]>>6),channels);
    if(sampleRate!==undefined)assert.equal(rate,sampleRate);
    const length=((aac[i+3]&3)<<11)|(aac[i+4]<<3)|(aac[i+5]>>5);assert.ok(length>=7&&i+length<=aac.length);i+=length;frames++;
  }
  assert.ok(frames>20,'actual AAC frames, independent of PES aggregation');
  const audioTail=pts.get(audio)[0]+(frames-1)*1024*90000/rate;
  assert.ok(Math.abs(Math.max(...pts.get(video))-audioTail)<9000,'A/V tails within 100ms');
  assert.ok(bytes.includes(Buffer.from([0,0,1,0x67])));assert.ok(bytes.includes(Buffer.from([0,0,1,0x68])));
  return {packets:bytes.length/188,pcr:pcr.length,maxPcrMs:gap(pcr)};
}
