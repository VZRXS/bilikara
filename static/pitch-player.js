/* Playback-only Signalsmith adapter. User settings remain owned by AppState. */
(() => {
  "use strict";
  const moduleUrl = new URL("vendor/signalsmith-stretch/SignalsmithStretch.js", document.currentScript.src).href;
  const contexts = new WeakMap();
  const timeoutMs = 10000;

  function capability(context) {
    if (!globalThis.isSecureContext) return "insecure-context";
    if (typeof WebAssembly !== "object") return "wasm-unavailable";
    if (typeof AudioWorkletNode !== "function" || !context?.audioWorklet) return "worklet-unavailable";
    if (context.state === "closed") return "context-closed";
    return "";
  }

  function load(context) {
    if (!contexts.has(context)) {
      // Cache rejection as well: a bad local asset/CSP must not cause a retry loop.
      contexts.set(context, new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("module-timeout")), timeoutMs);
        import(moduleUrl).then(async ({ default: factory }) => {
          factory.moduleUrl = moduleUrl; // local worklet, no Blob URL or CDN
          await context.audioWorklet.addModule(moduleUrl);
          return factory;
        }).then(resolve, reject).finally(() => clearTimeout(timer));
      }));
    }
    return contexts.get(context);
  }

  class PlayerPitch {
    constructor({ audio, context, source, destination, connectInput, current, changed, unavailable }) {
      Object.assign(this, { audio, context, source, destination, connectInput, current, changed, unavailable });
      this.gate = context.createGain();
      this.gate.gain.value = 0;
      this.gateConnected = false;
      this.requested = this.applied = this.latency = this.generation = 0;
      this.phase = "direct";
      this.failure = "";
      this.node = null;
      this.needsPrime = this.blocked = this.disposed = false;
      this.listeners = [];
      this.listen(audio, "pause", () => {
        if (audio.paused && !audio.ended && (this.phase === "active" || (this.phase === "priming" && this.inputStarted))) this.reset();
      });
      this.listen(audio, "seeking", () => {
        if (!this.ownSeek && ["active", "priming", "draining"].includes(this.phase)) this.reset();
      });
      this.listen(audio, "seeked", () => { this.ownSeek = false; });
      this.listen(audio, "emptied", () => this.reset());
      this.listen(context, "statechange", () => {
        if (context.state === "closed") this.fail("context-closed");
        else if (context.state !== "running" && this.phase === "active") this.reset();
      });
    }

    listen(target, name, callback) {
      target.addEventListener(name, callback);
      this.listeners.push(() => target.removeEventListener(name, callback));
    }

    valid(generation) {
      return !this.disposed && this.current() && this.generation === generation && this.context.state !== "closed";
    }

    notify() { if (!this.disposed && this.current()) this.changed?.(this.snapshot()); }

    snapshot() {
      return { processor: "signalsmith", state: this.phase, requested: this.requested,
        applied: this.applied, latency_seconds: this.latency, sample_rate: this.context.sampleRate,
        failure: this.failure };
    }

    stopNode() {
      this.gate.gain.value = 0;
      this.abort?.abort();
      this.abort = null;
      if (this.node) {
        try { this.source?.disconnect(this.node); } catch { /* Already disconnected. */ }
        this.node.removeEventListener("processorerror", this.onProcessorError);
        this.node.destroy();
        this.node = null;
      }
      this.applied = 0;
      this.cancelTail?.();
    }

    setShift(value) {
      const shift = Number.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0;
      if (shift === this.requested && (this.pending || this.node || this.failure || shift === 0)) return this.pending;
      this.requested = shift;
      if (!shift) {
        // Keep a working wet route until sync() repositions its input to audible time.
        this.needsPrime = Boolean(this.source) && this.phase !== "direct";
        if (!["active", "priming", "draining"].includes(this.phase)) {
          ++this.generation;
          this.stopNode();
          this.pending = null;
          this.phase = this.source ? "ready" : "direct";
        }
        this.notify();
        return;
      }
      if (this.failure) { this.notify(); return; }
      if (this.node && this.phase === "ready") { this.notify(); return; }
      if (this.node && ["active", "priming"].includes(this.phase)) {
        this.needsPrime = false;
        this.parameters();
      } else if (!this.pending) {
        this.prepare();
      }
      this.notify();
      return this.pending;
    }

    parameters() {
      const node = this.node, generation = this.generation, shift = this.requested;
      // Live input: never use input/rate to seek or resample the media element.
      node.schedule({ semitones: shift, formantCompensation: false }).then(() => {
        if (this.valid(generation) && this.node === node && this.requested === shift) {
          this.applied = shift;
          this.notify();
        }
      }).catch(() => { if (this.valid(generation) && this.node === node) this.fail("parameter"); });
    }

    prepare() {
      const generation = ++this.generation;
      this.phase = "loading";
      this.needsPrime = true;
      const abort = this.abort = new AbortController();
      this.pending = (async () => {
        let node;
        try {
          const unsupported = capability(this.context);
          if (unsupported) throw new Error(unsupported);
          const factory = await load(this.context);
          if (!this.valid(generation) || !this.requested) return;
          node = await factory(this.context, {
            numberOfInputs: 1, numberOfOutputs: 1,
            channelCount: 2, channelCountMode: "max", channelInterpretation: "speakers",
          }, abort.signal);
          if (!this.valid(generation)) { node.destroy(); return; }
          this.node = node;
          this.onProcessorError = () => { if (this.valid(generation)) this.fail("processorerror"); };
          node.addEventListener("processorerror", this.onProcessorError);
          await node.configure({ preset: "default" });
          const latency = await node.latency(); // upstream returns seconds, input + output latency
          if (!Number.isFinite(latency) || latency <= 0 || latency > 1) throw new Error("invalid-latency");
          if (!this.valid(generation)) {
            node.destroy();
            if (this.node === node) this.node = null;
            return;
          }
          this.latency = latency;
          this.phase = "ready";
          this.pending = null;
          this.notify();
        } catch (error) {
          node?.destroy();
          if (this.valid(generation)) this.fail(error.message === "insecure-context" ? error.message : "initialization");
        }
      })();
      return this.pending;
    }

    reset() {
      if (this.disposed || (!this.requested && this.phase === "direct")) return;
      ++this.generation;
      this.stopNode();
      this.pending = null;
      this.blocked = this.needsPrime = Boolean(this.source);
      this.phase = "ready";
      if (this.requested && !this.failure) this.prepare();
      this.notify();
    }

    fail(kind) {
      if (this.disposed) return;
      ++this.generation;
      this.stopNode();
      this.pending = null;
      this.failure = kind;
      this.blocked = this.needsPrime = Boolean(this.source);
      this.phase = "unavailable";
      if (this.source) this.audio.pause();
      // Restore a destination immediately; sync() then reconciles the audible clock.
      if (this.source) {
        this.source.disconnect();
        this.source.connect(this.destination);
      }
      this.audio.bilikaraPitchRoute = "direct";
      if (!this.reported) { this.reported = true; this.unavailable?.(kind); }
      this.notify();
    }

    delay(rate = this.audio.playbackRate || 1) {
      return ["active", "priming", "draining"].includes(this.phase) ? this.latency * rate : 0;
    }

    // Called by the existing Host sync loop, including its short frame-cadence hold.
    // A fresh processor consumes the selected opening while video is held. We
    // never advance media input by L to hide DSP latency, nor crossfade dry/wet.
    sync({ video, offset, rate, hold, play, beforePrime }) {
      if (this.disposed) return false;
      if (this.requested && this.phase === "loading") {
        if (!this.blocked) return false; // first load: ordinary playback remains usable
        hold();
        this.audio.pause();
        return true;
      }
      if (this.needsPrime) {
        const target = Math.max(0, Math.min(Number(this.audio.duration) || Infinity, video.currentTime - offset));
        if (video.currentTime - offset < 0 && this.requested && !this.failure) return false;
        beforePrime?.();
        hold();
        this.phase = "ready"; // queued pause events must not retire the new processor
        this.audio.pause();
        if (!this.source) {
          try {
            const input = this.connectInput();
            this.source = input.source;
            this.destination = input.destination;
          } catch { this.fail("media-source"); return false; }
        }
        if (!this.gateConnected) {
          this.gate.connect(this.destination);
          this.gateConnected = true;
        }
        if (Math.abs(this.audio.currentTime - target) > 0.001) {
          this.ownSeek = true;
          this.audio.currentTime = target;
        }
        this.source.disconnect();
        if (!this.requested || this.failure) {
          this.stopNode();
          this.source.connect(this.destination);
          this.audio.bilikaraPitchRoute = "direct";
          this.latency = 0;
          this.phase = this.failure ? "unavailable" : "direct";
        } else {
          this.source.connect(this.node);
          this.node.connect(this.gate);
          this.gate.gain.value = 1;
          this.audio.bilikaraPitchRoute = "processor";
          const generation = this.generation, node = this.node;
          // start() is required in live-input mode. Its acknowledgement gates input.
          this.started = false;
          node.start({ active: true, semitones: this.requested, formantCompensation: false }).then(() => {
            if (this.valid(generation) && this.node === node) { this.started = true; this.parameters(); }
          }).catch(() => { if (this.valid(generation)) this.fail("start"); });
          this.anchor = target;
          this.inputStarted = false;
          this.phase = "priming";
        }
        this.blocked = this.needsPrime = false;
        this.notify();
      }
      if (this.phase !== "priming") return false;
      hold();
      if (this.audio.seeking || this.audio.readyState < 2 || !this.started) return true;
      if (this.audio.paused) play();
      if (!this.audio.paused && !this.inputStarted) {
        this.inputStarted = true;
        this.inputStartContext = this.context.currentTime;
      }
      const advance = this.audio.currentTime - this.anchor;
      const elapsed = this.context.currentTime - this.inputStartContext;
      // Some WebKit/GStreamer MediaElement sources expose a decoder-buffer clock
      // that jumps ahead of the context. It cannot support this live time mapping.
      // Reject that capability instead of repeatedly seeking or reporting success.
      if (this.inputStarted && advance > (elapsed + 2 * this.latency) * rate) {
        this.fail("media-clock");
        return true;
      }
      if (advance < this.latency * rate) return true;
      this.phase = "active";
      this.notify();
      return false;
    }

    drain() {
      if (!this.node || !["active", "priming"].includes(this.phase)) return Promise.resolve(true);
      if (this.tail) return this.tail;
      this.phase = "draining";
      const generation = this.generation;
      // Two live latencies bound the STFT overlap tail, including edge smearing.
      const until = this.context.currentTime + 2 * this.latency;
      this.tail = new Promise(resolve => {
        const deadline = Date.now() + Math.ceil(2000 * this.latency) + 1000;
        const finish = result => { clearTimeout(timer); this.cancelTail = null; resolve(result); };
        let timer;
        this.cancelTail = () => finish(false);
        const poll = () => {
          if (!this.valid(generation)) return finish(false);
          if (this.context.currentTime >= until || Date.now() >= deadline) return finish(true);
          timer = setTimeout(poll, 10);
        };
        poll();
      }).finally(() => { this.tail = null; });
      return this.tail;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      ++this.generation;
      this.stopNode();
      this.source?.disconnect();
      this.gate.disconnect();
      this.listeners.splice(0).forEach(remove => remove());
      this.phase = "disposed";
    }
  }

  globalThis.BilikaraPitch = { PlayerPitch, capability };
})();
