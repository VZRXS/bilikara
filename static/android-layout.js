/* Window/UI preferences only. The shared Host retains all application/media state. */
(function (root) {
  "use strict";
  const layouts = ["auto", "desktop", "phone"];
  const orientations = ["system", "landscape", "portrait"];
  // Match the shared desktop shell's supported narrow-window floor. Use CSS
  // window width, not screen resolution or height reduced by the keyboard.
  function resolveLayout(mode, width) {
    return mode === "phone" || (mode !== "desktop" && (!Number.isFinite(Number(width)) || Number(width) < 700)) ? "phone" : "desktop";
  }
  function createClient(bridge, timers = root) {
    const pending = new Map();
    let sequence = 0;
    let closed = false;
    bridge.onmessage = event => {
      let result;
      try { result = JSON.parse(event.data); } catch { return; } // Legacy fullscreen replies.
      if (!result || typeof result !== "object") return;
      const request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id);
      timers.clearTimeout(request.timer);
      if (!result.ok || !layouts.includes(result.data?.layout) || !orientations.includes(result.data?.orientation)) {
        request.reject(new Error("window_preferences_failed"));
      } else request.resolve(result.data);
    };
    function call(action, mode) {
      if (closed) return Promise.reject(new Error("window_closed"));
      if (pending.size >= 4) return Promise.reject(new Error("window_preferences_busy"));
      return new Promise((resolve, reject) => {
        const id = `window-${++sequence}`;
        const timer = timers.setTimeout(() => {
          pending.delete(id);
          reject(new Error("window_preferences_timeout"));
        }, 10000);
        pending.set(id, {resolve, reject, timer});
        try { bridge.postMessage(JSON.stringify({id, action, mode})); }
        catch (error) { pending.delete(id); timers.clearTimeout(timer); reject(error); }
      });
    }
    return {
      load: () => call("get-preferences"),
      saveLayout: mode => layouts.includes(mode) ? call("set-layout", mode) : Promise.reject(new Error("invalid_layout")),
      saveOrientation: mode => orientations.includes(mode) ? call("set-orientation", mode) : Promise.reject(new Error("invalid_orientation")),
      close() {
        closed = true;
        for (const request of pending.values()) {
          timers.clearTimeout(request.timer);
          request.reject(new Error("window_closed"));
        }
        pending.clear();
      },
    };
  }
  if (typeof module === "object" && module.exports) module.exports = {resolveLayout, createClient};
  if (root.document?.documentElement?.dataset?.hostPlatform === "android") {
    const client = root.BilikaraHostWindow?.postMessage ? createClient(root.BilikaraHostWindow) : null;
    root.BilikaraAndroidLayout = {resolveLayout, client};
    root.addEventListener("pagehide", () => client?.close());
  }
})(globalThis);
