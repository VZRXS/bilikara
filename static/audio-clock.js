// Timing for a captured media element. Rust/Host intent remains authoritative;
// this object owns only the current renderer's seek/output segment.
(() => {
  "use strict";
  class CapturedClock {
    constructor({ audio, context, current, shouldPlay, play, changed, unavailable }) {
      Object.assign(this, { audio, context, current, shouldPlay, play, changed, unavailable });
      this.position = Number(audio.currentTime || 0);
      this.anchor = context.currentTime;
      this.rate = Number(audio.playbackRate || 1);
      this.running = this.pending = this.resumeWanted = this.needsReposition = this.disposed = false;
      this.holding = true;
      this.listeners = [];
      this.listen(audio, "play", () => {
        if (audio.paused || !this.valid()) return;
        if (this.needsReposition) this.seek(this.time(), true);
        else this.start();
      });
      this.listen(audio, "pause", () => {
        if (!audio.paused || audio.ended || this.pending || !this.valid()) return;
        this.freeze();
        this.needsReposition = true;
      });
      this.listen(audio, "seeking", () => {
        if (this.pending || !this.valid()) return;
        this.seek(Number(audio.currentTime || 0), !audio.paused);
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
    freeze() {
      this.position = this.time();
      this.anchor = this.context.currentTime;
      this.running = false;
      this.holding = true;
      if (this.valid()) this.changed();
    }
    stop() {
      if (!this.valid()) return;
      this.cancelDrain?.(false);
      this.freeze();
      this.resumeWanted = false;
      this.needsReposition = true;
      if (!this.audio.paused) this.audio.pause();
    }
    seek(target, resume = !this.audio.paused) {
      if (!this.valid() || !Number.isFinite(target)) return false;
      this.cancelDrain?.(false);
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
      if (this.resumeWanted && this.shouldPlay()) {
        if (this.audio.paused) this.play();
        else this.start();
      } else if (!this.audio.paused) this.start();
    }
    start() {
      if (!this.valid() || this.failure || this.pending || this.audio.seeking || this.audio.readyState < 2
        || this.audio.paused || this.context.state !== "running" || !this.shouldPlay()) return;
      if (!this.running) this.anchor = this.context.currentTime;
      this.running = true;
      this.holding = false;
      this.resumeWanted = false;
      this.changed();
    }
    sync() {
      if (!this.valid() || this.failure || !this.shouldPlay()) return;
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
      this.cancelDrain?.(false);
      for (const remove of this.listeners) remove();
      this.listeners.length = 0;
    }
  }
  globalThis.BilikaraAudioClock = { CapturedClock };
})();
