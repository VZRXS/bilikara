// Timing for a captured media element. Rust/Host intent remains authoritative;
// this object owns only the current renderer's seek/output segment.
(() => {
  "use strict";
  // A short measured renderer correction, never the user's AV-delay setting.
  // It sits before volume gain so mute/volume still take effect immediately.
  class AlignmentDelay {
    constructor({context, destination, current}) {
      Object.assign(this, {context, current});
      this.node = context.createDelay(1);
      this.node.connect(destination);
    }
    seconds() { return this.node.delayTime.value; }
    add(seconds) {
      const next = this.seconds() + seconds;
      if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(next) || next > 1) return false;
      this.node.delayTime.value = next;
      return true;
    }
    reset() { this.cancelDrain?.(false); this.node.delayTime.value = 0; }
    drain() {
      if (this.tail) return this.tail;
      const until = this.context.currentTime + this.seconds();
      if (until <= this.context.currentTime) return Promise.resolve(true);
      const deadline = Date.now() + this.seconds()*1000 + 2000;
      this.tail = new Promise(resolve => {
        let timer;
        const finish = result => {clearTimeout(timer);this.cancelDrain=null;resolve(result);};
        this.cancelDrain = finish;
        const poll = () => {
          if (!this.current() || this.context.state === 'closed') return finish(false);
          if (this.context.currentTime >= until) return finish(true);
          if (Date.now() >= deadline) return finish(false);
          timer = setTimeout(poll, 10);
        };
        poll();
      }).finally(() => {this.tail=null;});
      return this.tail;
    }
    dispose() {this.reset();this.node.disconnect();}
  }
  class CapturedClock {
    constructor({ audio, context, current, shouldPlay, play, changed, unavailable }) {
      Object.assign(this, { audio, context, current, shouldPlay, play, changed, unavailable });
      this.position = Number(audio.currentTime || 0);
      this.anchor = context.currentTime;
      this.rate = Number(audio.playbackRate || 1);
      this.running = this.pending = this.resumeWanted = this.needsReposition = this.disposed = false;
      this.holding = true;
      this.inputEnded = false;
      this.listeners = [];
      this.listen(audio, "play", () => {
        if ((audio.paused && !audio.ended) || !this.valid()) return;
        if (this.needsReposition) this.seek(this.time(), true);
        else this.start();
      });
      this.listen(audio, "ended", () => {
        if (!this.valid()) return;
        this.inputEnded = true;
        // A short resumed segment can reach decoder EOS before play resolves.
        // Its captured PCM still needs the explicit output segment's clock.
        if (!this.needsReposition) this.start();
      });
      this.listen(audio, "emptied", () => {
        this.inputEnded = this.resumingEndedInput = false;
      });
      this.listen(audio, "pause", () => {
        if (!audio.paused || audio.ended || this.pending || !this.valid()) return;
        this.freeze();
        this.needsReposition = true;
      });
      this.listen(audio, "seeking", () => {
        if (this.pending || !this.valid()) return;
        // play() implicitly rewinds an ended decoder before its play event.
        // A paused captured tail still owns its explicit output position.
        const nativeTime = Number(audio.currentTime), duration = Number(audio.duration);
        // A delayed event can expose the previous EOS cursor as well as its
        // implicit rewind. Neither cursor owns a resumed captured segment.
        // Explicit application seeks use seek() and retain their full range.
        const lateEndedCursor = this.resumingEndedInput && this.shouldPlay()
          && (nativeTime + .25 < this.position
            || (Number.isFinite(duration) && nativeTime >= duration && this.time() < duration));
        // Readiness can settle before its queued seeking event is delivered.
        // Once the actual seek has ended, decoder read-ahead is not a new
        // output target. Preserve the separate implicit-EOS rewind recovery.
        if (!audio.seeking && !lateEndedCursor) return;
        this.seek(this.needsReposition || lateEndedCursor ? this.time() : Number(audio.currentTime || 0),
          this.shouldPlay());
      });
      this.listen(audio, "seeked", () => this.ready());
      this.listen(audio, "canplay", () => this.ready());
      this.listen(audio, "waiting", () => {
        if (!this.valid() || audio.readyState >= 2 || this.pending) return;
        this.freeze();
        this.needsReposition = true;
      });
      this.listen(audio, "ratechange", () => {
        this.position = this.time();
        this.anchor = context.currentTime;
        this.rate = Number(audio.playbackRate || 1);
      });
      this.listen(context, "statechange", () => {
        if (!this.valid()) return;
        if (context.state !== "running") {
          this.freeze();
          this.needsReposition = true;
        }
        // A context can suspend between songs while the next item caches.
        // Resuming it need not produce another media readiness event. Rebase
        // the captured segment now, including while startup is still pending.
        if (context.state === "running") this.sync();
        if (context.state === "closed") this.unavailable?.("context-closed");
      });
    }
    valid() { return !this.disposed && this.current(); }
    listen(target, type, callback) {
      target.addEventListener(type, callback);
      this.listeners.push(() => target.removeEventListener(type, callback));
    }
    time() {
      const elapsed = this.running ? Math.max(0, this.context.currentTime - this.anchor) * this.rate : 0;
      const duration = Number(this.audio.duration);
      return Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : Infinity, this.position + elapsed));
    }
    outputTime() {
      const elapsed = this.running ? Math.max(0, this.context.currentTime-this.anchor)*this.rate : 0;
      const duration = Number(this.audio.duration);
      return Math.max(0, Math.min(Number.isFinite(duration)&&duration>0?duration:Infinity,
        this.position+elapsed-(this.audio.bilikaraOutputDelay?.seconds()||0)*this.rate));
    }
    freeze() {
      const outputDelay = this.audio.bilikaraOutputDelay;
      this.position = this.outputTime();
      outputDelay?.reset();
      this.anchor = this.context.currentTime;
      this.running = false;
      this.holding = true;
      if (this.valid()) this.changed();
    }
    stop() {
      if (!this.valid()) return;
      this.inputEnded = this.inputEnded || Boolean(this.audio.ended);
      this.cancelPreparedPlay();
      this.cancelDrain?.(false);
      this.freeze();
      this.audio.bilikaraOutputDelay?.reset();
      this.resumeWanted = false;
      this.needsReposition = true;
      if (!this.audio.paused) this.audio.pause();
    }
    preparePlay() {
      if (!this.valid() || this.failure) return false;
      // Do this before HTMLMediaElement.play(): an ended decoder may already
      // have queued its implicit rewind by the time it dispatches play/seeking.
      return !this.needsReposition || this.seek(this.time(), true);
    }
    playPrepared(play) {
      if (!this.pending || !this.seekFromEnd) return play();
      if (this.queuedPlay) return this.queuedPlay.promise;
      // An ended decoder can keep its EOS flag until seeked. Playing during
      // that seek can queue a later rewind, even after currentTime was set.
      const queued = {};
      let done = false, timer;
      queued.promise = new Promise((resolve, reject) => {
        queued.finish = error => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (this.queuedPlay === queued) this.queuedPlay = null;
          if (!error && (!this.valid() || !this.shouldPlay())) error = this.playCancelled();
          if (error) reject(error);
          else { try { resolve(play()); } catch (failure) { reject(failure); } }
        };
        timer = setTimeout(() => {
          this.failure = "seek-timeout";
          this.resumeWanted = false;
          this.needsReposition = true;
          queued.finish(new Error("Captured audio seek timed out"));
        }, 3000);
      });
      this.queuedPlay = queued;
      return queued.promise;
    }
    playCancelled() { return Object.assign(new Error("Captured audio play cancelled"), {name: "AbortError"}); }
    cancelPreparedPlay() { this.queuedPlay?.finish(this.playCancelled()); }
    seek(target, resume = this.shouldPlay()) {
      if (!this.valid() || !Number.isFinite(target)) return false;
      this.cancelPreparedPlay();
      this.seekFromEnd = Boolean(this.seekFromEnd || this.audio.ended);
      // A startup retry can seek again after WebKit clears native ended but
      // before its queued EOS rewind arrives. Keep protection for this source;
      // explicit application seeks still replace position, including zero.
      this.resumingEndedInput = this.inputEnded || Boolean(this.audio.ended);
      this.cancelDrain?.(false);
      this.audio.bilikaraOutputDelay?.reset();
      this.freeze();
      this.position = Math.max(0, target);
      this.failure = "";
      this.pending = true;
      this.needsReposition = false;
      this.resumeWanted = resume;
      this.audio.pause();
      // Flush the decoder/source queue even if its reported currentTime happens
      // to match. It may describe queued input, not the Web Audio output segment.
      try { this.audio.currentTime = this.position; }
      catch {
        this.pending = this.resumeWanted = false;
        this.failure = "seek-failed";
        this.unavailable?.(this.failure);
        return false;
      }
      queueMicrotask(() => this.ready());
      return true;
    }
    ready() {
      if (!this.valid() || this.failure || this.audio.seeking || this.audio.readyState < 2) return;
      if (this.pending) this.pending = false;
      this.seekFromEnd = false;
      if (this.queuedPlay) { this.queuedPlay.finish(); return; }
      if (this.resumeWanted && this.shouldPlay()) {
        if (this.audio.ended) this.start();
        else if (this.audio.paused) this.play();
        else this.start();
      } else if (!this.audio.paused) this.start();
    }
    start() {
      if (!this.valid() || this.failure || this.pending || this.needsReposition || this.audio.error
        || this.audio.seeking || this.audio.readyState < 2
        || (this.audio.paused && !this.audio.ended) || this.context.state !== "running" || !this.shouldPlay()
        || (this.audio.ended && this.time() >= this.audio.duration)) return;
      if (!this.running) this.anchor = this.context.currentTime;
      this.running = true;
      this.holding = false;
      this.resumeWanted = false;
      this.changed();
    }
    isOutputRunning() {
      return this.valid() && !this.failure && !this.audio.error && this.running && !this.holding
        && this.context.state === "running" && this.shouldPlay() && this.outputTime() < this.audio.duration;
    }
    hasPlayingTail() { return (this.inputEnded || this.audio.ended) && this.isOutputRunning(); }
    isOutputComplete() {
      // WebKit may clear ended on a resumed captured tail without delivering a
      // second EOS, even while its final PCM reaches the output. Keep the known
      // source EOS for this media node; seeks still rebase the output clock.
      const duration = Number(this.audio.duration);
      return this.valid() && this.inputEnded && !this.failure && !this.audio.error
        && this.running && !this.holding && !this.pending && !this.needsReposition
        && this.context.state === "running" && Number.isFinite(duration) && duration > 0
        && this.outputTime() >= duration;
    }
    sync() {
      if (!this.valid() || this.failure || !this.shouldPlay() || this.context.state !== "running") return;
      // Reconcile ready state before waiting for events: a context resume or
      // same-position seek need not dispatch another canplay/seeked callback.
      if (this.pending) this.ready();
      if (this.needsReposition && !this.pending && !this.audio.seeking && this.audio.readyState >= 2) {
        this.seek(this.time(), true);
      } else if (!this.pending && this.holding) {
        if (this.audio.paused) this.play();
        else this.start();
      }
    }
    drain() {
      if (!this.valid()) return Promise.resolve(false);
      if (this.tail) return this.tail;
      const duration = Number(this.audio.duration);
      if (!Number.isFinite(duration) || this.time() >= duration) return Promise.resolve(true);
      const remaining = Math.max(0, duration - this.time()) / this.rate;
      const deadline = Date.now() + Math.min(10000, remaining * 1000 + 2000);
      this.tail = new Promise(resolve => {
        let timer;
        const finish = result => { clearTimeout(timer); this.cancelDrain = null; resolve(result); };
        this.cancelDrain = finish;
        const tick = () => {
          if (!this.valid() || this.context.state === "closed") return finish(false);
          if (this.time() >= duration) return finish(true);
          if (Date.now() >= deadline) {
            this.failure = "tail-timeout";
            this.stop();
            this.unavailable?.(this.failure);
            return;
          }
          timer = setTimeout(tick, 10);
        };
        tick();
      }).finally(() => { this.tail = null; });
      return this.tail;
    }
    dispose() {
      this.disposed = true;
      this.cancelPreparedPlay();
      this.cancelDrain?.(false);
      for (const remove of this.listeners) remove();
      this.listeners.length = 0;
    }
  }
  globalThis.BilikaraAudioClock = { CapturedClock, AlignmentDelay };
})();
