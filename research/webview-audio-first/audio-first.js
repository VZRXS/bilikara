/* Isolated MEDIA-ARCH-02/03 experiment. Never imported by product entry points.
 * This owns one renderer, not a playlist, AppState or an automatic-Next policy.
 * Host has audio + DSP only. A detachable surface follows the output clock.
 */
(() => {
  "use strict";
  const wait = (predicate, timeout = 5000) => new Promise((resolve, reject) => {
    const until = performance.now() + timeout;
    const tick = () => {
      if (predicate()) return resolve();
      if (performance.now() > until) return reject(new Error("prototype-readiness-timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
  class AudioFirst {
    constructor({ current, changed, ended }) {
      Object.assign(this, { current, changed, ended });
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.offset = this.shift = this.latency = this.epoch = 0;
      this.playEpoch = this.dspEpoch = this.cancelledPlays = 0;
      this.volume = 1;
      this.intent = this.muted = this.disposed = false;
      this.stoppedAt = 0;
      this.executionTrace=[];
      this.timer = setInterval(() => this.tick(), 100);
    }
    valid(program = this.program) {
      return !this.disposed && BilikaraMediaBackend.same(program, this.program)
        && BilikaraMediaBackend.same(program, this.current());
    }
    async load(program, media, restore = 0) {
      this.trace('bind-start');
      this.retire();
      this.program = BilikaraMediaBackend.identity(program);
      this.failure = "";
      const epoch = this.epoch;
      this.media = media;
      const audio = this.audio = document.createElement("audio");
      audio.hidden = true;
      document.body.append(audio);
      audio.preload = "auto";
      audio.src = media.audio;
      this.source = this.context.createMediaElementSource(audio);
      this.source.connect(this.gain);
      this.clock = audio.bilikaraAudioClock = new BilikaraAudioClock.CapturedClock({
        audio, context: this.context, current: () => this.valid(program) && epoch === this.epoch,
        shouldPlay: () => this.intent, play: () => this.playInput(),
        changed: () => this.changed?.(this.snapshot()),
        unavailable: code => { this.failure = code; },
      });
      audio.addEventListener('playing',()=>{
        if(!this.valid(program)||epoch!==this.epoch||audio.paused||audio.seeking||this.clock.pending||!this.awaitingInput)return;
        // `play` is intent; `playing` is the element's ready output transition.
        // Rebase once per flushed input segment, never from WebKit read-ahead.
        this.clock.anchor=this.context.currentTime;
        this.awaitingInput=false;
      });
      for(const type of ['play','playing','pause','seeking','seeked','waiting','canplay','ended'])audio.addEventListener(type,()=>queueMicrotask(()=>{
        if(this.valid(program)&&epoch===this.epoch)this.trace(type);
      }));
      audio.load();
      await wait(() => !this.valid(program) || audio.readyState >= 2 || audio.error);
      if (!this.valid(program) || epoch !== this.epoch) return false;
      if (audio.error) throw new Error("prototype-audio-decode");
      await this.position(restore);
      if (!this.valid(program) || epoch !== this.epoch) return false;
      await wait(()=>!this.valid(program)||epoch!==this.epoch||!audio.seeking&&!this.clock.pending);
      if (!this.valid(program) || epoch !== this.epoch) return false;
      this.ready = true;
      this.trace('bind-ready');
      this.changed?.(this.snapshot());
      return true;
    }
    playInput() {
      if (!this.valid()) return Promise.reject(new Error("stale-program"));
      if (!this.clock.preparePlay()) return Promise.reject(new Error("prototype-clock-unavailable"));
      const program=this.program, epoch=this.epoch, operation=this.playEpoch;
      const request=this.clock.playPrepared(() => this.audio.play());
      this.trace('play-request');
      request.then(()=>this.valid(program)&&epoch===this.epoch&&this.trace('play-promise-resolved'),()=>{});
      // Clock readiness callbacks intentionally don't await play(). Observe its
      // rejection too, retaining the original Promise for explicit callers.
      request.catch(error=>{
        if(!this.valid(program)||epoch!==this.epoch||operation!==this.playEpoch) {
          if(error.name==='AbortError')this.cancelledPlays++;
          return;
        }
        this.failure='prototype-play-'+error.name;this.intent=false;
        this.changed?.(this.snapshot());
      });
      return request;
    }
    trace(type) {
      this.executionTrace.push({type,at:performance.now(),context:this.context.currentTime,input:this.audio?.currentTime,
        inputStart:this.segmentInput,position:this.clock?.position,anchor:this.clock?.anchor,pending:this.clock?.pending,
        running:this.clock?.running,awaitingInput:this.awaitingInput,intent:this.intent,epoch:this.epoch});
      if(this.executionTrace.length>128)this.executionTrace.shift();
    }
    async play() {
      if (!this.valid()) throw new Error("stale-program");
      const program = this.program, epoch = this.epoch;
      await this.context.resume();
      if (!this.valid(program) || epoch !== this.epoch) return false;
      if (this.reprime) {
        // A native media seek does not promise to flush captured Web Audio
        // input queues. Revoke the old input owner before binding a fresh one;
        // keep the AudioContext/gain and the authoritative program/lease.
        const surface=this.surface;
        await this.load(program,this.media,this.stoppedAt);
        if(surface&&this.valid(program))this.attachSurface(surface);
      }
      if (!this.valid(program)) return false;
      const activeEpoch=this.epoch;
      this.intent = true;
      this.playInput();
      // WebKit can keep a play Promise pending while real output advances.
      // The request's rejection remains observed above. Do not wait until EOS
      // for its resolution or call play again: confirm the ready output leg.
      await wait(()=>!this.valid(program)||activeEpoch!==this.epoch||this.failure
        || !this.awaitingInput&&this.clock.isOutputRunning());
      if(this.failure)throw new Error(this.failure);
      this.trace('play-confirmed');
      return this.valid(program) && activeEpoch === this.epoch;
    }
    pause() {
      this.trace('pause-intent');
      this.stoppedAt = this.snapshot().mediaTime;
      ++this.playEpoch; this.intent = false; this.clock?.stop();
      // Disconnect buffered DSP/delay output immediately. Rebuild it on resume
      // at the frozen navigation position; stale PCM must not leak after pause.
      this.source?.disconnect(); this.pitch?.disconnect(); this.openingDelay?.disconnect();
      this.reprime = true;
    }
    async position(seconds) {
      const program=this.program,epoch=this.epoch;
      const request=this.positionEpoch=(this.positionEpoch||0)+1;
      this.stoppedAt=seconds;
      this.awaitingInput=true;
      // Production sign: audible = video - offset. At zero, retain the entire
      // audio input. Positive delay emits real silence; negative delay holds
      // frame zero while the leading audio plays. No opening samples are skipped.
      this.openingSeconds=Math.max(0,this.offset-seconds);
      this.segmentInput=seconds===0?0:Math.max(0,seconds-this.offset);
      this.openingDelay?.disconnect();
      this.openingDelay=this.context.createDelay(1);
      this.openingDelay.delayTime.value=this.openingSeconds;
      this.openingDelay.connect(this.gain);
      await this.configurePitch();
      if(!this.valid(program)||epoch!==this.epoch||request!==this.positionEpoch)return false;
      this.clock.seek(this.segmentInput,false);
      this.reprime=false;
      return true;
    }
    async seek(seconds) {
      if (!this.valid() || !Number.isFinite(seconds) || seconds < 0) throw new Error("invalid-seek");
      const program=this.program,media=this.media,resume=this.intent,surface=this.surface;
      this.trace('seek-start');
      if(!await this.load(program,media,Math.min(seconds,this.audio.duration)))return false;
      if(surface&&this.valid(program))this.attachSurface(surface);
      const result=resume?await this.play():true;
      this.trace('seek-confirmed');return result;
    }
    async configurePitch() {
      const epoch = this.epoch, program = this.program;
      const request=++this.dspEpoch;
      this.pitch?.destroy(); this.pitch = null; this.latency = 0;
      this.source.disconnect(); this.source.connect(this.openingDelay || this.gain);
      if (!this.shift) return;
      const url = new URL('/vendor/signalsmith-stretch/SignalsmithStretch.js', location.href).href;
      const { default: factory } = await import(url);
      factory.moduleUrl = url;
      await this.context.audioWorklet.addModule(url);
      const node = await factory(this.context, { numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: 2, channelCountMode: "max", channelInterpretation: "speakers" });
      await node.configure({ preset: "default" });
      const latency = await node.latency();
      if (!this.valid(program) || epoch !== this.epoch || request!==this.dspEpoch) { node.destroy(); return; }
      if (!Number.isFinite(latency) || latency <= 0 || latency > 1) { node.destroy(); throw new Error("DSP-latency"); }
      await node.start({ active: true, semitones: this.shift, formantCompensation: false });
      if (!this.valid(program) || epoch !== this.epoch || request!==this.dspEpoch) { node.destroy(); return; }
      this.pitch = node; this.latency = latency;
      node.addEventListener('processorerror',()=>{
        if(!this.valid(program)||epoch!==this.epoch||request!==this.dspEpoch)return;
        this.failure='prototype-DSP-processor';this.pause();this.changed?.(this.snapshot());
      });
      this.source.disconnect(); this.source.connect(node); node.connect(this.openingDelay || this.gain);
    }
    async setKeyShift(value) {
      if (!Number.isFinite(value) || value < -6 || value > 6) throw new Error("invalid-pitch");
      const restore=this.snapshot().mediaTime;
      this.shift = value;
      if(!this.audio)return;
      if (this.pitch && value) return this.pitch.schedule({ semitones: value, formantCompensation: false });
      if(this.ready)return this.seek(restore);
      return this.configurePitch();
    }
    setVolume(value, muted = this.muted) {
      if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error("invalid-volume");
      this.volume = value; this.muted = muted;
      this.gain.gain.value = muted ? 0 : value;
    }
    async setAvDelay(milliseconds) {
      if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 1000) throw new Error("invalid-delay");
      const restore=this.snapshot().mediaTime;
      this.offset = milliseconds / 1000;
      if(this.ready)await this.seek(restore);
    }
    // A video surface can be attached on return to single-screen. No audio/DSP
    // owner is moved; dual-screen never creates a Host video element.
    attachSurface(video) {
      this.detachSurface();
      this.surface = video;
      video.muted = true; video.playsInline = true; video.src = this.media.video;
      video.load();
    }
    detachSurface() {
      if (!this.surface) return;
      this.surface.pause(); this.surface.removeAttribute('src'); this.surface.load(); this.surface = null;
    }
    snapshot() {
      // CapturedClock's public time clamps at source EOS. Its output segment
      // anchor continues through DSP/delay and the lagging video's final tail.
      // This implementation-specific access stays inside the experimental owner.
      const raw=this.clock ? this.clock.position+(this.clock.running?Math.max(0,this.context.currentTime-this.clock.anchor)*this.clock.rate:0):0;
      const audible=raw-this.latency-(this.openingSeconds||0);
      const audioSeconds = Math.max(0, Math.min(this.audio?.duration||Infinity,audible));
      const outputMediaTime=audible+this.offset;
      const mediaTime=this.reprime?this.stoppedAt:Math.min(this.media?.duration||this.audio?.duration||Infinity,Math.max(this.stoppedAt||0,outputMediaTime));
      const running=Boolean(this.intent&&!this.awaitingInput&&this.clock?.running&&!this.clock.pending&&!this.clock.holding&&this.context.state==='running');
      return { program: this.program, rendererEpoch:this.epoch, ready: Boolean(this.ready), playing: running,
        audioSeconds, mediaTime,outputMediaTime,
        monotonicAt:performance.now(), contextTime:this.context.currentTime,
        openingSilenceSeconds:this.openingSeconds||0,
        sampledAt: Date.now(), paused: !running || outputMediaTime<(this.stoppedAt||0),
        playbackRate: 1, seeking: Boolean(this.clock?.pending), duration: this.audio?.duration || 0,
        avDelayMs: this.offset * 1000, pitch: this.shift, dspLatency: this.latency,
        contextState: this.context.state, contextSampleRate:this.context.sampleRate,
        reportedBaseLatency:this.context.baseLatency??null,reportedOutputLatency:this.context.outputLatency??null,
        failure: this.failure || null, cancelledPlays:this.cancelledPlays,
        hostVideoDecoders: this.surface ? 1 : 0 };
    }
    async tick() {
      if (!this.valid() || !this.ready) return;
      this.clock.sync();
      const snapshot = this.snapshot();
      if (this.surface) BilikaraAudioFirst.follow(this.surface, snapshot);
      const outputEnd=Math.max(this.audio.duration+this.offset,this.media.duration||this.audio.duration);
      if (!this.eosPending && this.intent && this.clock.isOutputComplete()
          && snapshot.outputMediaTime>=outputEnd && snapshot.audioSeconds>=this.audio.duration) {
        this.eosPending = true;
        const program = this.program, epoch = this.epoch;
        // Include the real DSP tail before asking the external authoritative
        // Host to ACK/advance; never choose the next item in this renderer.
        // The output-segment timeline above already includes actual DSP/delay
        // drain; an extra wall-clock sleep would double-count DSP latency.
        if (this.valid(program) && epoch === this.epoch) {
          this.pause(); this.ended?.(program);
        }
      }
    }
    retire() {
      ++this.epoch; this.intent = this.ready = this.eosPending = false;
      ++this.playEpoch; ++this.dspEpoch;
      this.detachSurface(); this.clock?.dispose(); this.pitch?.destroy(); this.pitch = null;
      this.source?.disconnect(); this.openingDelay?.disconnect();this.openingDelay=null;this.audio?.pause();
      this.audio?.removeAttribute('src'); this.audio?.load();
      this.audio?.remove();
      this.clock = this.audio = null;
    }
    async dispose() { if (this.disposed) return; this.retire(); this.disposed = true; clearInterval(this.timer); await this.context.close(); }
  }
  function follow(video, clock) {
    const generation=clock.program?.playback_generation||0;
    if(generation<(video.roundAProgramGeneration||0)
      ||generation===(video.roundAProgramGeneration||0)&&clock.rendererEpoch<(video.roundASegment||0))return {action:'stale-segment',shouldPlay:false};
    video.roundAProgramGeneration=generation;
    if(clock.ready===false){video.roundAWantsPlay=false;video.pause();return {action:'hold-loading',shouldPlay:false};}
    const now=clock.clockBasis==='local-performance'?performance.now():Date.now();
    if(video.roundASegment!==clock.rendererEpoch) {
      if(video.readyState<1)return {action:'wait-metadata',shouldPlay:false};
      // A renderer segment is NOT an AppState generation. Explicit seeks and
      // fresh input binds must reach the follower even within the ordinary
      // drift deadband, including recovery from an already-ended element.
      video.currentTime=Math.min(video.duration||Infinity,BilikaraPresentationSync.predictedMediaTime(clock,now));
      video.roundASegment=clock.rendererEpoch;video.roundALastSeek=now;
    }
    if(video.ended && Number.isFinite(video.duration) && clock.mediaTime>=video.duration-.03) {
      video.roundAWantsPlay=false;video.pause();return {action:'hold-ended',playbackRate:1,shouldPlay:false};
    }
    const decision = BilikaraPresentationSync.planClockCorrection(clock, {
      currentTime: video.currentTime, paused: video.paused, seeking: video.seeking, lastSeekAt: video.roundALastSeek,
    },now);
    if (decision.action === 'seek') { video.currentTime = decision.targetTime; video.roundALastSeek = now; }
    if (decision.action === 'pause') video.pause();
    video.playbackRate = decision.playbackRate;
    video.roundAWantsPlay=decision.shouldPlay;
    if (decision.shouldPlay && video.paused) {
      const epoch=video.roundASegment;
      video.play().then(()=>{if(epoch===video.roundASegment)video.roundAPlaybackError=null;},error=>{
        if(error.name==='AbortError'&&(!video.roundAWantsPlay||epoch!==video.roundASegment))video.roundAExpectedPlayCancellations=(video.roundAExpectedPlayCancellations||0)+1;
        else video.roundAPlaybackError=error.name;
      });
    }
    return decision;
  }
  globalThis.BilikaraAudioFirst = { AudioFirst, follow };
})();
