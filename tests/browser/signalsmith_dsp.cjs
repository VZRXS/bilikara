"use strict";
// Real live-input WASM in a browser OfflineAudioContext; no decoder/network media.
// NODE_PATH=/path/to/existing/playwright/node_modules node tests/browser/signalsmith_dsp.cjs OUTPUT_DIR [webkit|chromium]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const playwright = require("playwright");
const root = path.resolve(__dirname, "../..");
const directory = path.resolve(process.argv[2]);
const engine = process.argv[3] || "webkit";
fs.mkdirSync(directory, {recursive: true});
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.setHeader("Content-Type", "text/html"); return res.end("<!doctype html><title>Local Signalsmith DSP</title><button>Start</button>"); }
  if (req.url === "/lifetime-probe.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(`
      const counts = {created: 0, destroyed: 0};
      const register = registerProcessor;
      globalThis.registerProcessor = (name, Processor) => register(name, name !== 'signalsmith-stretch' ? Processor : class extends Processor {
        constructor(options) {
          super(options); counts.created++;
          let destroyed = false;
          Object.defineProperty(this, 'destroyed', {get: () => destroyed, set: value => {
            if (value && !destroyed) counts.destroyed++;
            destroyed = value;
          }});
        }
      });
      register('lifetime-probe', class extends AudioWorkletProcessor {
        constructor() { super(); this.port.onmessage = () => this.port.postMessage(counts); }
        process() { return true; }
      });
    `);
  }
  const file = path.join(root, "static", new URL(req.url, "http://localhost").pathname);
  if (!file.startsWith(path.join(root, "static/")) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader("Content-Type", "text/javascript"); res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await playwright[engine].launch({headless: true});
  const errors = [];
  let timeout;
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const results = await Promise.race([page.evaluate(async () => {
      const {default: factory} = await import("/vendor/signalsmith-stretch/SignalsmithStretch.js");
      factory.moduleUrl = location.origin + "/vendor/signalsmith-stretch/SignalsmithStretch.js";
      const results = [];
      for (const sampleRate of [48000, 44100]) {
        for (const shift of [-6, -3, 3, 6]) {
          const context = new OfflineAudioContext(2, sampleRate * 3, sampleRate);
          const node = await factory(context);
          await node.configure({preset: "default"});
          const latency = await node.latency();
          await node.start({active: true, semitones: shift, formantCompensation: false});
          const source = context.createBufferSource();
          const input = source.buffer = context.createBuffer(2, sampleRate * 2.4, sampleRate);
          const starts = [0, .6, 1.2, 1.8], width = .35;
          for (let c = 0; c < 2; c++) {
            const data = input.getChannelData(c), frequency = c ? 660 : 440;
            for (let i = 0; i < data.length; i++) {
              const time = i / sampleRate;
              if (starts.some(start => time >= start && time < start + width)) data[i] = .99 * Math.sin(2 * Math.PI * frequency * time);
            }
          }
          source.connect(node); node.connect(context.destination); source.start(0);
          const rendered = await context.startRendering();
          node.destroy(); node.destroy();
          const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
          const rms = (data, start, end) => {
            let energy = 0; const a = Math.floor(start * sampleRate), b = Math.floor(end * sampleRate);
            for (let i = a; i < b; i++) energy += data[i] ** 2;
            return Math.sqrt(energy / (b - a));
          };
          const frequency = (data, expected) => {
            // Frequency estimate from positive crossings inside a steady burst.
            const crossings = [], a = Math.floor((.6 + latency + .08) * sampleRate), b = Math.floor((.6 + latency + .28) * sampleRate);
            for (let i = a + 1; i < b; i++) if (data[i - 1] <= 0 && data[i] > 0) crossings.push(i - data[i] / (data[i] - data[i - 1]));
            const measured = (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]);
            return {measured, expected, cents: 1200 * Math.log2(measured / expected)};
          };
          const centers = starts.map(start => {
            let weight = 0, weightedTime = 0;
            for (let i = Math.floor(start * sampleRate); i < Math.floor((start + .58) * sampleRate); i++) {
              const e = channels[0][i] ** 2; weight += e; weightedTime += e * i / sampleRate;
            }
            return weightedTime / weight;
          });
          const peaks = channels.map(data => {
            let peak = 0, nonfinite = 0, clipped = 0;
            for (const sample of data) { if (!Number.isFinite(sample)) nonfinite++; peak = Math.max(peak, Math.abs(sample)); if (Math.abs(sample) > 1) clipped++; }
            return {peak, nonfinite, overUnity: clipped};
          });
          const result = {sampleRate, shift, latency,
            frequencies: channels.map((data, c) => frequency(data, (c ? 660 : 440) * 2 ** (shift / 12))),
            measuredDelay: centers[1] - (.6 + width / 2),
            pulseIntervals: centers.slice(1).map((v, i) => v - centers[i]),
            introEnergy: rms(channels[0], 0, .55), silenceRms: rms(channels[0], 2.4 + latency, 3), peaks};
          if (sampleRate === 48000 && shift === 3) {
            result.pcm = channels.map(data => Array.from(data));
            result.reference = [Array.from(input.getChannelData(0)), Array.from(input.getChannelData(1))];
          }
          results.push(result);
        }
      }
      // Silence, mono and stereo phase integrity use actual processor output.
      for (const kind of ["silence", "mono", "opposite"]) {
        const context = new OfflineAudioContext(2, 48000, 48000), node = await factory(context, {numberOfInputs: 1, numberOfOutputs: 1});
        await node.start({active: true, semitones: 6});
        const source = context.createBufferSource(); source.buffer = context.createBuffer(kind === "mono" ? 1 : 2, 48000, 48000);
        if (kind !== "silence") for (let c = 0; c < source.buffer.numberOfChannels; c++) {
          const data = source.buffer.getChannelData(c);
          for (let i = 0; i < data.length; i++) data[i] = (c ? -.5 : .5) * Math.sin(2 * Math.PI * 440 * i / 48000);
        }
        source.connect(node); node.connect(context.destination); source.start();
        const output = await context.startRendering(); node.destroy();
        let residual = 0, peak = 0;
        const a = output.getChannelData(0), b = output.getChannelData(1);
        for (let i = 0; i < a.length; i++) {
          residual = Math.max(residual, Math.abs(a[i] + (kind === "opposite" ? b[i] : -b[i])));
          peak = Math.max(peak, Math.abs(a[i]));
        }
        results.push({kind, residual, peak});
      }
      // Independent fresh memory must not emit the old tone after a route cut.
      // Also test an input ending with sound, without a zero-padded media buffer.
      {
        const sr = 48000, context = new OfflineAudioContext(2, sr * 2.5, sr);
        const nodes = [];
        for (let i = 0; i < 2; i++) {
          const node = await factory(context), source = context.createBufferSource(), gate = context.createGain();
          await node.start({active: true, semitones: 3});
          source.buffer = context.createBuffer(2, sr, sr);
          for (let c = 0; c < 2; c++) for (let n = 0; n < sr; n++) source.buffer.getChannelData(c)[n] = .5 * Math.sin(2 * Math.PI * (i ? 880 : 330) * n / sr);
          source.connect(node); node.connect(gate); gate.connect(context.destination);
          if (i === 0) gate.gain.setValueAtTime(0, 1); // explicit retirement gates immediately
          source.start(i); nodes.push(node);
        }
        const output = (await context.startRendering()).getChannelData(0);
        nodes.forEach(node => node.destroy());
        const magnitude = (frequency, start, end) => {
          let re = 0, im = 0;
          for (let n = Math.floor(start * sr); n < end * sr; n++) { re += output[n] * Math.cos(2 * Math.PI * frequency * n / sr); im += output[n] * Math.sin(2 * Math.PI * frequency * n / sr); }
          return Math.hypot(re, im) / ((end - start) * sr);
        };
        const rms = (a, b) => Math.sqrt(output.subarray(a * sr, b * sr).reduce((sum, v) => sum + v*v, 0) / ((b-a)*sr));
        const oldTone = magnitude(330 * 2**(.25), 1.35, 1.85), newTone = magnitude(880 * 2**(.25), 1.35, 1.85);
        results.push({kind: "discontinuity-tail", oldTone, newTone, tailRms: rms(2, 2.1), drainedRms: rms(2.24, 2.5)});
      }
      {
        const context = new OfflineAudioContext(2, 48000, 48000);
        await context.audioWorklet.addModule("/lifetime-probe.js");
        for (let i = 0; i < 16; i++) {
          const node = await factory(context);
          await node.configure({preset: "default"}); await node.start({active: true, semitones: i % 2 ? 3 : -3});
          node.destroy(); node.destroy();
        }
        const probe = new AudioWorkletNode(context, "lifetime-probe");
        const counts = await new Promise(resolve => { probe.port.onmessage = event => resolve(event.data); probe.port.postMessage("counts"); });
        probe.port.close(); probe.disconnect();
        results.push({kind: "lifetime", ...counts});
      }
      return results;
    }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("real AudioWorklet test timed out")), 60000); })]);
    for (const result of results) {
      if (result.frequencies) {
        assert(result.frequencies.every(value => Math.abs(value.cents) < 15), JSON.stringify(result.frequencies));
        assert(Math.abs(result.measuredDelay - result.latency) < .025, JSON.stringify({...result, pcm: undefined, reference: undefined}));
        assert(result.pulseIntervals.every(interval => Math.abs(interval - .6) < .025));
        assert(result.peaks.every(value => value.nonfinite === 0 && value.peak < 2));
        assert(result.introEnergy > .1 && result.silenceRms < 1e-5);
      } else if (result.kind === "discontinuity-tail") {
        assert(result.oldTone / result.newTone < .005 && result.newTone > .1, JSON.stringify(result));
        assert(result.tailRms > .1 && result.drainedRms < 1e-5, JSON.stringify(result));
      } else if (result.kind === "lifetime") {
        assert.equal(result.created, 16); assert.equal(result.destroyed, 16);
      } else {
        // Spectral floating-point phase reconstruction need not be sample-identical.
        // Require >60 dB anti-phase rejection and identical mono duplication.
        assert(result.residual < (result.kind === "opposite" ? result.peak * .001 : 1e-5), JSON.stringify(result));
        assert(result.kind === "silence" ? result.peak === 0 : result.peak > .1);
      }
      if (result.pcm) {
        // Float WAV preserves overshoots for inspection, without a limiter/normalizer.
        writeWav(path.join(directory, "signalsmith-plus3-float.wav"), result.pcm, result.sampleRate);
        writeWav(path.join(directory, "reference-float.wav"), result.reference, result.sampleRate);
        delete result.pcm; delete result.reference;
      }
    }
    assert.deepEqual(errors, []);
    const report = {engine, version: browser.version(), results, errors};
    fs.writeFileSync(path.join(directory, "dsp.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { clearTimeout(timeout); await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

function writeWav(file, channels, sampleRate) {
  const size = channels[0].length * channels.length * 4, buffer = Buffer.alloc(44 + size);
  buffer.write("RIFF"); buffer.writeUInt32LE(36 + size, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels.length, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * channels.length * 4, 28);
  buffer.writeUInt16LE(channels.length * 4, 32); buffer.writeUInt16LE(32, 34); buffer.write("data", 36); buffer.writeUInt32LE(size, 40);
  for (let i = 0; i < channels[0].length; i++) for (let c = 0; c < channels.length; c++) buffer.writeFloatLE(channels[c][i], 44 + (i * channels.length + c) * 4);
  fs.writeFileSync(file, buffer);
}
