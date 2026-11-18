// Bounded offline observation of synthetic tones from an actual audio-server
// monitor. Zero crossings are a tone check, not a general pitch/drift analyzer.
export function pcmWindows(bytes,rate=48000,channels=2,seconds=.5) {
  const frames=Math.floor(rate*seconds),stride=4*channels,result=[];
  for(let start=0;start+frames*stride<=bytes.length;start+=frames*stride) {
    let sum=0,crossings=0,previous=bytes.readFloatLE(start);
    for(let offset=start;offset<start+frames*stride;offset+=stride) {
      const value=bytes.readFloatLE(offset);sum+=value*value;
      if(previous<=0&&value>0)crossings++;previous=value;
    }
    result.push({atSeconds:start/stride/rate,rms:Math.sqrt(sum/frames),toneHz:crossings/seconds});
  }
  return result;
}

// Correlated synthetic 60ms pulses. Sample identity is separate from delivery
// timestamps: Node receipt is a bounded software observation, not DAC time.
export function pcmPulseEvents(bytes,chunks,rate=48000,channels=2) {
  const stride=4*channels,window=Math.round(rate*.005),pulses=[];let active=null,index=0;
  const timestamp=frame=>{
    while(index<chunks.length-1&&chunks[index].endFrame<frame)index++;
    const chunk=chunks[index];return chunk?chunk.atMs-(chunk.endFrame-frame)/rate*1000:null;
  };
  function finish(end) {
    if(!active)return;
    const frames=end-active.frame;
    if(frames>=rate*.015) {
      const crossings=[];let last=bytes.readFloatLE(active.frame*stride);
      for(let n=active.frame;n<end;n++) {const value=bytes.readFloatLE(n*stride);if(last<=0&&value>0)crossings.push(n);last=value;}
      const periods=crossings.slice(1).map((n,i)=>n-crossings[i]).sort((a,b)=>a-b);
      const period=periods[Math.floor(periods.length/2)];
      pulses.push({frame:active.frame,endFrame:end,atMs:timestamp(active.frame),durationMs:frames/rate*1000,toneHz:period?rate/period:null});
    }
    active=null;
  }
  for(let frame=0;(frame+window)*stride<=bytes.length;frame+=window) {
    let power=0;for(let n=frame;n<frame+window;n++){const v=bytes.readFloatLE(n*stride);power+=v*v;}
    if(Math.sqrt(power/window)>.03){active??={frame};}else finish(frame);
  }
  finish(Math.floor(bytes.length/stride));
  const deliveryExcessMs=chunks.slice(1).map((c,i)=>c.atMs-chunks[i].atMs-(c.endFrame-chunks[i].endFrame)/rate*1000);
  return {pulses,deliveryExcessMs,rate,channels,basis:'sample index mapped through each actual pipe delivery chunk; unknown fixed server/pipe latency remains'};
}

export const CODED_TONE_HZ = Array.from({length:16}, (_, code) => 400 + code * 50);

export function codedPcmPulseEvents(bytes, chunks, {keyShift=0}={}) {
  const pcm = pcmPulseEvents(bytes, chunks);
  const pitchRatio = 2 ** (keyShift / 12);
  const coefficients = CODED_TONE_HZ.map(frequency => 2 * Math.cos(2 * Math.PI * frequency * pitchRatio / pcm.rate));
  const pulses = pcm.pulses.map(pulse => {
    const samples = new Float64Array(pulse.endFrame - pulse.frame);
    let energy = 0;
    for (let n = 0; n < samples.length; n++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (samples.length - 1));
      const value = bytes.readFloatLE((pulse.frame + n) * pcm.channels * 4) * weight;
      samples[n] = value;
      energy += value * value;
    }
    const bins = coefficients.map((coefficient, code) => {
      let prior = 0, previous = 0;
      for (const sample of samples) {
        const current = sample + coefficient * previous - prior;
        prior = previous;
        previous = current;
      }
      return {code, power: previous ** 2 + prior ** 2 - coefficient * previous * prior};
    }).sort((left, right) => right.power - left.power);
    // Accept a dominant single tone from the synthetic codebook. Retain the
    // raw crossing estimate so rejected or distorted pulses remain visible.
    const [strongest, next] = bins;
    const recognized = strongest.power > 0.15 * samples.length * energy && strongest.power > 2 * next.power;
    return {...pulse, zeroCrossingHz:pulse.toneHz, toneHz:recognized ? CODED_TONE_HZ[strongest.code] : null};
  });
  return {...pcm,pulses};
}
