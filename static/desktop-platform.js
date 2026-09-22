// Narrow desktop OS operations. The shell separately checks main-window origin
// and the backend privately authorizes update activation; these flags grant no authority.
(() => {
  if (document.documentElement.dataset.hostPlatform !== "desktop") return;
  const invoke = (...args) => {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) return Promise.reject(new Error("This action requires the desktop application."));
    return call(...args);
  };
  const activating = new Set();
  window.BilikaraDesktopPlatform = Object.freeze({
    startUpdate(includePreview) { return invoke("start_desktop_update", { includePreview }); },
    cancelUpdate() { return invoke("cancel_desktop_update"); },
    openExternal(url) { return invoke("open_external_web_url", { url }); },
    async applyUpdate(status) {
      const operation = status?.operation;
      if (status?.state !== "prepared" || !Number.isSafeInteger(operation) || activating.has(operation)) return;
      activating.add(operation);
      await invoke("apply_desktop_update", { operation });
    },
  });
})();
