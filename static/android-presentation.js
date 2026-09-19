/* Narrow Android display adapter. No Tauri IPC emulation and no application
   state: the shared Host/controller own playback and rendering as on desktop. */
(() => {
  "use strict";
  const bridge = window.BilikaraHostPresentation;
  if (!bridge?.postMessage) return;
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  let latest = null;
  let output = null;
  let foreground = true;
  const supported = new Set([
    "get_presentation_session", "get_presentation_displays", "activate_local_presentation",
    "deactivate_local_presentation", "mark_presentation_host_ready", "mark_presentation_controller_ready",
    "publish_presentation_playback_state", "show_presentation_display_identifiers",
    "dismiss_presentation_display_identifiers", "diagnostics",
  ]);

  function dispatch(name, payload) {
    for (const handler of listeners.get(name) || []) {
      Promise.resolve().then(() => handler({payload})).catch(() => {});
    }
  }
  bridge.onmessage = event => {
    let result;
    try { result = JSON.parse(event.data); } catch { return; }
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    clearTimeout(request.timeout);
    if (result.ok) request.resolve(result.data);
    else request.reject(new Error(String(result.error || "display_operation_failed")));
  };
  window.addEventListener("bilikara-native-presentation", event => {
    const {name, payload} = event.detail || {};
    if (name === "foreground") foreground = Boolean(payload?.foreground);
    if (name === "output-diagnostics") output = payload;
    dispatch(name, payload);
  });

  function invoke(command, args = {}) {
    if (!supported.has(command)) return Promise.reject(new Error("unsupported_command"));
    if (pending.size >= 24) return Promise.reject(new Error("display_busy"));
    return new Promise((resolve, reject) => {
      const id = `display-${++sequence}`;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("display_timeout"));
      }, 20000);
      pending.set(id, {resolve, reject, timeout});
      try { bridge.postMessage(JSON.stringify({id, command, args})); }
      catch (error) { pending.delete(id); clearTimeout(timeout); reject(error); }
    });
  }
  function send(command, args) {
    try { bridge.postMessage(JSON.stringify({command, args})); } catch { /* Teardown. */ }
  }
  const api = {
    invoke,
    listen: async (name, handler) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name)?.delete(handler);
    },
    postMaster: envelope => send("master-state", envelope),
    reportOutput: data => send("output-diagnostics", data),
    isForeground: () => foreground,
    refreshDiagnostics: async () => { latest = await invoke("diagnostics"); return latest; },
    diagnostics: () => ({...latest, foreground, output: output || latest?.output || null}),
  };
  window.BilikaraAndroidPresentation = api;
  window.addEventListener("pagehide", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("display_page_closed"));
    }
    pending.clear();
  });
})();
