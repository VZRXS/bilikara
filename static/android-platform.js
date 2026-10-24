(function (root) {
  "use strict";
  if (root.document?.documentElement?.dataset?.nativeHost !== "true" || root.document.documentElement.dataset.hostPlatform !== "android") return;
  const bridge = root.BilikaraHostPlatform;
  if (!bridge?.postMessage) return;
  const pending = new Map();
  let sequence = 0;
  bridge.onmessage = event => {
    let result;
    try { result = JSON.parse(event.data); } catch { return; }
    const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id);
    clearTimeout(request.timeout);
    if (result.ok) request.resolve(result.data);
    else request.reject(new Error(result.error || "Android 系统操作失败"));
  };
  function call(action, data = {}, timeoutMs = 30000) {
    if (pending.size >= 8) return Promise.reject(new Error("Android 系统操作繁忙"));
    return new Promise((resolve, reject) => {
      const id = `platform-${++sequence}`;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Android 系统操作超时"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try { bridge.postMessage(JSON.stringify({ ...data, action, id })); }
      catch (error) { clearTimeout(timeout); pending.delete(id); reject(error); }
    });
  }
  root.BilikaraAndroidPlatform = {
    updatePreferences: {
      load: () => call("get-update-preferences"),
      save: preferences => call("save-update-preferences", {preferences}),
    },
    openLoginLink: url => call("open-bilibili-login", {url}),
    openRoomAuthorization: url => call("open-room-authorization", {url}),
    environment: () => call("environment"),
    webviewDiagnostics: () => call("webview-diagnostics"),
    installUpdate: candidate => call("install-update", {package:candidate}, 540000),
  };
  const diagnosticsButton = document.getElementById("webview-diagnostics-button");
  if (diagnosticsButton) {
    diagnosticsButton.hidden = false;
    diagnosticsButton.addEventListener("click", async () => {
      if (diagnosticsButton.disabled) return;
      diagnosticsButton.disabled = true;
      diagnosticsButton.setAttribute("aria-busy", "true");
      try { await root.BilikaraAndroidPlatform.webviewDiagnostics(); }
      catch (error) { root.dispatchEvent(new CustomEvent("bilikara:webview-diagnostics-error", {detail: error.message})); }
      finally { diagnosticsButton.disabled = false; diagnosticsButton.removeAttribute("aria-busy"); }
    });
  }
})(globalThis);
