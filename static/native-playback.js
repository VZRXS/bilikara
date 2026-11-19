/* Native GStreamer playback engine bridge for the desktop Host.
 *
 * Rust AppState remains the business authority. The Host page binds one
 * already-claimed program to the native engine through this module; the
 * engine executes it and reports identity-bound observations. Completion is an
 * observation only: the existing generation-checked Host transition requests
 * Next. Video frames are composited by the shell beneath the transparent
 * stage and never cross JavaScript IPC.
 */
(() => {
  "use strict";
  const OBSERVATION_EVENT = "media-engine://observation";
  const fields = ["playback_generation", "item_id", "item_incarnation_id",
    "selected_audio_variant_id", "artifact_set_id"];

  function same(left, right) {
    return Boolean(left && right && fields.every(key => left[key] === right[key]));
  }

  function failure(code) {
    return Object.assign(new Error(code), { name: "NativePlaybackError", code });
  }

  // Browser tests may install a deterministic engine bridge before the page
  // loads; production pages only ever use the Tauri shell bridge.
  function testBridge() {
    const bridge = globalThis.__BILIKARA_MEDIA_ENGINE_TEST_BRIDGE__;
    return bridge && typeof bridge.invoke === "function" && typeof bridge.listen === "function"
      ? bridge : null;
  }

  function tauriInvoke() {
    const bridge = testBridge();
    if (bridge) return bridge.invoke;
    const invoke = globalThis.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke : null;
  }

  function tauriListen() {
    const bridge = testBridge();
    if (bridge) return bridge.listen;
    const listen = globalThis.__TAURI__?.event?.listen;
    return typeof listen === "function" ? listen : null;
  }

  async function status() {
    const invoke = tauriInvoke();
    if (!invoke) return null;
    try {
      return await invoke("get_media_engine_status");
    } catch {
      return null;
    }
  }

  async function setPreference(engine) {
    const invoke = tauriInvoke();
    if (!invoke) throw failure("unavailable");
    return invoke("set_media_engine_preference", { engine });
  }

  async function command(payload) {
    const invoke = tauriInvoke();
    if (!invoke) return { accepted: false, code: "unavailable" };
    try {
      const result = await invoke("media_engine_command", { command: payload });
      return result && typeof result === "object" ? result : { accepted: false, code: "invalid-response" };
    } catch (error) {
      return { accepted: false, code: String(error?.message || error || "invoke-failed") };
    }
  }

  async function snapshot() {
    const invoke = tauriInvoke();
    if (!invoke) return null;
    try {
      return await invoke("get_media_engine_snapshot");
    } catch {
      return null;
    }
  }

  let listenerPromise = null;
  const observers = new Set();
  function ensureListener() {
    if (listenerPromise) return listenerPromise;
    const listen = tauriListen();
    if (!listen) return Promise.resolve(false);
    listenerPromise = Promise.resolve(listen(OBSERVATION_EVENT, (event) => {
      const observation = event?.payload;
      if (!observation || typeof observation !== "object") return;
      for (const observer of [...observers]) {
        try { observer(observation); } catch { /* Observer owns its failure. */ }
      }
    })).then(() => true, () => { listenerPromise = null; return false; });
    return listenerPromise;
  }

  function subscribe(observer) {
    observers.add(observer);
    void ensureListener();
    return () => observers.delete(observer);
  }

  /* Stage geometry for the shell compositor. Rectangles are CSS pixels of the
   * WebView; the shell applies the page zoom. Updates are coalesced per frame
   * and sent only when the visible rectangle changes. */
  function createSurfaceTracker(element, { label = "stage", onMeasure = null } = {}) {
    const invoke = tauriInvoke();
    let frame = null, lastKey = "", disposed = false, observer = null;
    const send = (surface) => {
      if (!invoke) return;
      const key = JSON.stringify(surface);
      if (key === lastKey) return;
      lastKey = key;
      invoke("set_media_engine_surface", { surface }).catch(() => { lastKey = ""; });
    };
    const measure = () => {
      frame = null;
      if (disposed) return;
      if (!element?.isConnected) {
        send({ visible: false, x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      const rect = element.getBoundingClientRect();
      const visible = rect.width >= 2 && rect.height >= 2 && document.visibilityState !== "hidden";
      // Layout can move the stage without a window resize (window manager,
      // fonts, workspace changes); page-side holes follow every measurement.
      try { onMeasure?.(rect); } catch { /* the owner handles its own failure */ }
      send({ visible, x: Math.round(rect.x * 100) / 100, y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 });
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(schedule);
      observer.observe(element);
      observer.observe(document.documentElement);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    // Transitions and fullscreen changes can move the stage without resizing it.
    const settle = window.setInterval(schedule, 500);
    schedule();
    return Object.freeze({
      element,
      label,
      refresh: schedule,
      dispose() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        window.removeEventListener("resize", schedule);
        document.removeEventListener("scroll", schedule, true);
        document.removeEventListener("visibilitychange", schedule);
        window.clearInterval(settle);
        if (frame !== null) window.cancelAnimationFrame(frame);
        lastKey = "";
        send({ visible: false, x: 0, y: 0, width: 0, height: 0 });
      },
    });
  }

  /* Media-element shaped read model over one native program. Existing Host
   * bookkeeping (status reports, presentation publication, Remote progress)
   * reads currentTime/duration/paused exactly as from the Legacy pair; every
   * write is routed to the engine for this exact program. */
  function createFacade(controller, role) {
    const target = new EventTarget();
    const dataset = { playerRole: role };
    Object.defineProperties(target, {
      bilikaraNative: { value: true },
      bilikaraNativeController: { value: controller },
      dataset: { value: dataset },
      currentTime: {
        get: () => controller.position(),
        set: (value) => { void controller.seek(Number(value), null).catch(() => {}); },
      },
      duration: { get: () => controller.duration() },
      paused: { get: () => !controller.intentPlaying() },
      ended: { get: () => controller.ended() },
      seeking: { get: () => controller.seeking() },
      readyState: { get: () => (controller.ready() ? 4 : 0) },
      error: { get: () => (controller.failure() ? { code: 4, message: controller.failure() } : null) },
      networkState: { get: () => (controller.ready() ? 1 : 2) },
      buffered: { get: () => ({ length: 0, start: () => 0, end: () => 0 }) },
      currentSrc: { get: () => "" },
      src: { get: () => "", set: () => {} },
      isConnected: { get: () => false },
      playbackRate: { get: () => 1, set: () => {} },
      defaultPlaybackRate: { get: () => 1, set: () => {} },
      controls: { get: () => false, set: () => {} },
      volume: { get: () => controller.volume(), set: () => {} },
      muted: { get: () => controller.muted(), set: () => {} },
      videoWidth: { get: () => 0 },
      videoHeight: { get: () => 0 },
    });
    target.play = () => controller.play();
    target.pause = () => { void controller.pause(); };
    target.load = () => {};
    target.focus = () => {};
    target.setAttribute = () => {};
    target.getAttribute = () => null;
    target.removeAttribute = () => {};
    target.hasAttribute = () => false;
    target.getVideoPlaybackQuality = () => ({
      droppedVideoFrames: 0,
      totalVideoFrames: controller.framesRendered(),
    });
    return target;
  }

  /* One controller per claimed program. All commands carry the full identity;
   * observations for any other identity are ignored. */
  function createController({ program, settings, onObservation = () => {} }) {
    const bound = Object.freeze(Object.fromEntries(fields.map(key => [key, program[key]])));
    const now = () => performance.now();
    const state = {
      ready: false, intent: false, playing: false, ended: false, failure: null,
      position: 0, positionAt: now(), duration: NaN, seq: 0, disposed: false,
      lastSeekId: 0, settledSeekId: 0, waiters: [], volume: 1, muted: false,
      frames: 0, loadRequested: false,
    };
    let unsubscribe = null;
    const facades = {};

    const dispatch = (type) => {
      for (const facade of [facades.video, facades.audio]) {
        try { facade?.dispatchEvent(new Event(type)); } catch { /* ignore */ }
      }
    };

    const position = () => {
      let value = state.position;
      if (state.playing && !state.ended) value += (now() - state.positionAt) / 1000;
      if (Number.isFinite(state.duration) && state.duration > 0) value = Math.min(value, state.duration);
      return Math.max(0, value);
    };

    const resolveWaiters = () => {
      const remaining = [];
      for (const waiter of state.waiters) {
        if (state.settledSeekId >= waiter.id) waiter.resolve(true);
        else remaining.push(waiter);
      }
      state.waiters = remaining;
    };

    const rejectWaiters = (reason) => {
      for (const waiter of state.waiters) waiter.resolve(false);
      state.waiters = [];
      void reason;
    };

    function accept(observation) {
      if (state.disposed || !same(observation?.program, bound)) return false;
      const seq = Number(observation.seq);
      if (!Number.isSafeInteger(seq) || seq <= state.seq) return false;
      state.seq = seq;
      const type = String(observation.type || "");
      const previousPlaying = state.playing;
      if (Number.isFinite(observation.position)) {
        state.position = Math.max(0, Number(observation.position));
        state.positionAt = now();
      }
      if (Number.isFinite(observation.duration) && observation.duration > 0) {
        const changed = state.duration !== Number(observation.duration);
        state.duration = Number(observation.duration);
        if (changed) dispatch("durationchange");
      }
      switch (type) {
        case "ready":
          state.ready = true;
          dispatch("loadedmetadata");
          dispatch("canplay");
          break;
        case "playing":
          state.playing = true;
          state.ended = false;
          state.intent = true;
          break;
        case "paused":
          state.playing = false;
          break;
        case "seek-settled":
          state.settledSeekId = Math.max(state.settledSeekId, Number(observation.seek_id) || 0);
          resolveWaiters();
          dispatch("seeked");
          break;
        case "eos":
          state.playing = false;
          state.ended = true;
          state.intent = false;
          break;
        case "error":
          if (observation.fatal) {
            state.failure = String(observation.code || "native-error");
            state.playing = false;
            state.intent = false;
            rejectWaiters(state.failure);
          }
          break;
        case "stopped":
          state.playing = false;
          break;
        default:
          break;
      }
      if (previousPlaying !== state.playing) dispatch(state.playing ? "play" : "pause");
      if (type === "position" || type === "seek-settled") dispatch("timeupdate");
      if (type === "eos") dispatch("ended");
      if (type === "error" && observation.fatal) dispatch("error");
      try { onObservation(Object.freeze({ ...observation, program: bound })); } catch { /* ignore */ }
      return true;
    }

    const send = async (payload) => {
      if (state.disposed) return { accepted: false, code: "disposed" };
      return command(payload);
    };

    const controller = {
      program: bound,
      position,
      duration: () => state.duration,
      intentPlaying: () => state.intent,
      observedPlaying: () => state.playing,
      ended: () => state.ended,
      ready: () => state.ready,
      failure: () => state.failure,
      seeking: () => state.settledSeekId < state.lastSeekId,
      volume: () => Math.min(1, state.volume),
      muted: () => state.muted,
      framesRendered: () => state.frames,
      accept,
      async load({ videoUrl, audioUrl, startSeconds = 0, play = false }) {
        if (state.loadRequested) return false;
        state.loadRequested = true;
        state.intent = Boolean(play);
        unsubscribe = subscribe(accept);
        await ensureListener();
        if (state.disposed) return false;
        if (settings) await controller.applySettings(settings);
        const result = await send({
          op: "load", program: bound, video_url: videoUrl, audio_url: audioUrl,
          start_seconds: Math.max(0, Number(startSeconds) || 0), play: Boolean(play),
        });
        if (!result.accepted) {
          state.failure = String(result.code || "load-rejected");
          return false;
        }
        if (Number.isSafeInteger(result.seek_id)) state.lastSeekId = Math.max(state.lastSeekId, result.seek_id);
        state.position = Math.max(0, Number(startSeconds) || 0);
        state.positionAt = now();
        return true;
      },
      async play() {
        state.intent = true;
        const result = await send({ op: "play", program: bound });
        if (!result.accepted) {
          throw failure(String(result.code || "play-rejected"));
        }
        return undefined;
      },
      async pause() {
        state.intent = false;
        const result = await send({ op: "pause", program: bound });
        return Boolean(result.accepted);
      },
      /* Accurate seek; `play` (when boolean) atomically sets the resulting
       * intent. Resolves true once this or a later seek settled. */
      seek(seconds, play = null) {
        if (!Number.isFinite(seconds) || seconds < 0) return Promise.resolve(false);
        if (typeof play === "boolean") state.intent = play;
        state.position = seconds;
        state.positionAt = now();
        state.ended = false;
        dispatch("seeking");
        return send({ op: "seek", program: bound, seconds, play: typeof play === "boolean" ? play : null })
          .then((result) => {
            if (!result.accepted || !Number.isSafeInteger(result.seek_id)) return false;
            state.lastSeekId = Math.max(state.lastSeekId, result.seek_id);
            if (state.settledSeekId >= result.seek_id) return true;
            return new Promise(resolve => state.waiters.push({ id: result.seek_id, resolve }));
          });
      },
      async applySettings({ volume, muted, keyShift, avDelayMs }) {
        const payload = { op: "settings" };
        if (Number.isFinite(volume)) { payload.volume = Math.max(0, Math.min(4, volume)); state.volume = payload.volume; }
        if (typeof muted === "boolean") { payload.muted = muted; state.muted = muted; }
        if (Number.isFinite(keyShift)) payload.key_shift = Math.max(-12, Math.min(12, keyShift));
        if (Number.isFinite(avDelayMs)) payload.av_delay_ms = Math.max(-5000, Math.min(5000, Math.round(avDelayMs)));
        const result = await command(payload);
        return Boolean(result.accepted);
      },
      async stop() {
        if (state.disposed) return false;
        const result = await command({ op: "stop", program: bound });
        controller.dispose();
        return Boolean(result.accepted);
      },
      dispose() {
        if (state.disposed) return;
        state.disposed = true;
        unsubscribe?.();
        rejectWaiters("disposed");
      },
      get disposed() { return state.disposed; },
    };
    facades.video = createFacade(controller, "video");
    facades.audio = createFacade(controller, "audio");
    controller.video = facades.video;
    controller.audio = facades.audio;
    return controller;
  }

  /* Same domain contract as the Legacy adapter (docs/media-backend.md). */
  function createGStreamerPlaybackAdapter({ program, current, controller, capabilities = {} }) {
    const backend = globalThis.BilikaraMediaBackend;
    return backend.createLegacyPlaybackAdapter({
      program,
      current,
      capabilities: { independentAudio: true, pitch: true, signedAvDelay: true,
        output: "native-composited", ...capabilities, engine: "gstreamer" },
      ports: {
        load: () => controller.loadPort?.() ?? false,
        play: () => controller.play(),
        pause: () => controller.pause(),
        seek: seconds => controller.seek(seconds),
        setVolume: (volume, muted) => controller.applySettings({ volume, muted }),
        setKeyShift: keyShift => controller.applySettings({ keyShift }),
        setAvDelay: avDelayMs => controller.applySettings({ avDelayMs }),
        snapshot: () => ({ program: controller.program, ready: controller.ready(),
          playing: controller.observedPlaying(), timeSeconds: controller.position(),
          audioTimeSeconds: controller.position(), audioTimeBasis: "native-pipeline",
          durationSeconds: controller.duration() }),
        stop: () => controller.stop(),
      },
    });
  }

  globalThis.BilikaraNativePlayback = Object.freeze({
    OBSERVATION_EVENT,
    available: () => Boolean(tauriInvoke()),
    status,
    setPreference,
    command,
    snapshot,
    subscribe,
    createSurfaceTracker,
    createController,
    createGStreamerPlaybackAdapter,
    same,
  });
})();
