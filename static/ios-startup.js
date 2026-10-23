(async () => {
  "use strict";
  const status = document.getElementById("bootstrap-status");
  const errors = {
    native_storage_invalid: "存档损坏，请保留应用数据后排查。",
    native_storage_version: "存档版本不兼容，请使用对应的应用版本。",
    native_storage_in_use: "数据正在使用中，请重新打开应用。",
    native_storage_full: "存储空间不足，请释放空间后重新打开应用。",
    native_storage_path: "应用存储目录不可用。",
    native_storage_io: "无法读写应用数据，请保留数据后排查。",
    mobile_start_already_attempted: "本机 Host 已尝试启动，请重新打开应用。",
    host_startup_failed: "本机 Host 启动失败，请保留应用数据后排查。",
    host_unavailable: "本机 Host 不可用。",
    app_state_unavailable: "应用状态不可用。",
    startup_origin_denied: "启动页面身份校验失败。",
    invalid_startup_response: "启动检查返回了不兼容的数据。",
    invalid_host_origin: "本机 Host 启动地址校验失败。",
    native_entry_unavailable: "请在 bilikara iOS 应用中打开此页面。",
    ios_webview_unsupported: "当前 iOS WebView 缺少共用界面所需的功能，请升级系统后重试。",
  };
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") throw new Error("native_entry_unavailable");
    // Probe the shared UI's actual requirements, without an Android user-agent
    // identity or Chromium version rule. Keep failures on this diagnostic page.
    if (typeof Object.hasOwn !== "function" || typeof Array.prototype.at !== "function"
      || typeof String.prototype.replaceAll !== "function" || typeof Promise.allSettled !== "function"
      || typeof AbortController !== "function" || typeof ResizeObserver !== "function"
      || !("inert" in document.createElement("div")) || typeof CSS === "undefined"
      || !CSS.supports("selector(:has(*))") || !CSS.supports("height: 100dvh")
      || !CSS.supports("color: color-mix(in srgb, black, white)")) throw new Error("ios_webview_unsupported");
    const result = await invoke("ios_host_status");
    if (!result || result.schema_version !== 1 || result.platform !== "ios" || result.backend !== "rust"
      || !Number.isSafeInteger(result.revision) || result.revision < 0
      || result.host_api_ready !== true || result.persistence_ready !== true
      || result.playback !== "unverified" || typeof result.bootstrap_url !== "string") {
      throw new Error("invalid_startup_response");
    }
    let destination;
    try { destination = new URL(result.bootstrap_url); }
    catch { throw new Error("invalid_host_origin"); }
    if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1"
      || !destination.port || Number(destination.port) === 0 || destination.username || destination.password
      || !/^\/bootstrap\/[A-Za-z0-9_-]{43}$/.test(destination.pathname)
      || destination.search || destination.hash) throw new Error("invalid_host_origin");
    status.textContent = "本机 Host 已就绪，正在打开…";
    // Exchange the process credential for the existing HttpOnly Host cookie.
    // Neither rendering nor readiness claims expose or depend on that secret.
    window.location.replace(destination.href);
  } catch (error) {
    const code = typeof error === "string" ? error : error?.message;
    status.textContent = "启动检查失败：" + (Object.prototype.hasOwnProperty.call(errors, code) ? errors[code] : errors.host_startup_failed);
  }
})();
