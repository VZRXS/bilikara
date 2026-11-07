// Independent fixture oracle: phase crossings of the decoded linear chirp,
// with no dependency on the player's model clock or requested AV delay.
export function installPCMChirpClock() {
  function read(pcm, sampleRate, ratio = 1) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(ratio) || ratio <= 0) return NaN;
    let first, last, count = 0;
    for (let i = 1; i < pcm.length; i++) {
      if (!Number.isFinite(pcm[i-1]) || !Number.isFinite(pcm[i])) return NaN;
      if (pcm[i-1] <= 0 && pcm[i] > 0) {
        const crossing = i-1-pcm[i-1]/(pcm[i]-pcm[i-1]);
        if (!count) first = crossing;
        last = crossing; count++;
      }
    }
    if (count < 8 || last <= first) return NaN;
    // Integral of a linear frequency ramp equals its midpoint frequency.
    // Interpolated crossings avoid FFT-bin quantization (~54ms at 44.1kHz).
    const frequency = (count-1)*sampleRate/(last-first);
    return (frequency/ratio-400)/100+(pcm.length-1-(first+last)/2)/sampleRate;
  }
  if (typeof window !== 'undefined') window.readPCMChirpTime = read;
  return read;
}
