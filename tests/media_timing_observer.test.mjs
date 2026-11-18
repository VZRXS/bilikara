import assert from 'node:assert/strict';
import test from 'node:test';
import {correlatePulses} from '../research/av-timing.mjs';
import {codedPcmPulseEvents} from '../research/pcm-observer.mjs';

test('coded PCM identifies the dominant tone and rejects an out-of-band pulse', () => {
  const rate = 48000;
  const pulseFrames = rate * 0.06;
  const gapFrames = rate * 0.05;
  const frameCount = 2 * (pulseFrames + gapFrames);
  const bytes = Buffer.alloc(frameCount * 8);
  for (let frame = 0; frame < pulseFrames; frame++) {
    const time = frame / rate;
    const primary = 0.4 * Math.sin(2 * Math.PI * 400 * time);
    const ringing = 0.03 * Math.sin(2 * Math.PI * 3600 * time);
    bytes.writeFloatLE(primary + ringing, frame * 8);
    bytes.writeFloatLE(0.4 * Math.sin(2 * Math.PI * 1263 * time), (frame + pulseFrames + gapFrames) * 8);
  }
  const {pulses} = codedPcmPulseEvents(bytes, [{endFrame:frameCount,atMs:220}]);
  assert.deepEqual(pulses.map(pulse => pulse.toneHz), [400, null]);
  assert.ok(pulses[1].zeroCrossingHz > 1200);
});

test('an unknown frequency or missing frame cannot masquerade as a coded second', () => {
  const frames = [{frame:480,atMs:1000}, {frame:510,atMs:2000}];
  const pulses = [{toneHz:1263,atMs:1040}, {toneHz:null,atMs:1040}, {toneHz:400,atMs:1040}, {toneHz:450,atMs:2040}];
  const measured = correlatePulses(pulses, frames, {offsetMs:40});
  assert.equal(measured.unrecognizedTones, 2);
  assert.deepEqual(measured.observations.map(pulse => pulse.frame), [480, 510]);
  assert.equal(measured.p95AbsoluteErrorMs, 0);
  assert.equal(correlatePulses([{toneHz:400,atMs:50}], [{frame:null,atMs:10}]).pairs, 0);
});

test('pitch-shifted coded PCM resolves to its original source tone', () => {
  const rate = 48000, frames = rate * 0.06;
  for (const keyShift of [-3, 2]) {
    const frequency = 1000 * 2 ** (keyShift / 12);
    const bytes = Buffer.alloc(frames * 8);
    for (let frame = 0; frame < frames; frame++) {
      bytes.writeFloatLE(0.4 * Math.sin(2 * Math.PI * frequency * frame / rate), frame * 8);
    }
    const {pulses} = codedPcmPulseEvents(bytes, [{endFrame:frames,atMs:60}], {keyShift});
    assert.deepEqual(pulses.map(pulse => pulse.toneHz), [1000]);
    assert.ok(Math.abs(pulses[0].zeroCrossingHz-frequency)<25);
  }
});
