(async () => {
  "use strict";
  const status = document.getElementById("bootstrap-status");
  const details = document.getElementById("bootstrap-details");
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") throw new Error("请在 Android Alpha 应用中打开此页面。");
    const result = await invoke("android_alpha_status");
    if (result?.schema_version !== 3 || result.stage !== "native-host-alpha" || result.backend !== "rust"
      || !Number.isSafeInteger(result.revision) || result.revision < 0
      || result.host_api_ready !== true || result.persistence_ready !== true || result.playback_ready !== true) {
      throw new Error("原生启动检查返回了不兼容的数据。");
    }
    const destination = new URL(result.bootstrap_url);
    if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1"
      || !destination.port || destination.username || destination.password
      || !/^\/bootstrap\/[A-Za-z0-9_-]{43}$/.test(destination.pathname)
      || destination.search || destination.hash) {
      throw new Error("原生 Host 返回了不安全的启动地址。");
    }
    status.textContent = "Rust Host 已就绪，正在打开点歌和播放界面…";
    // The one-process Host credential is not displayed or logged. The local
    // redirect exchanges it for an HttpOnly cookie before loading shared UI.
    window.location.replace(destination.href);
  } catch (error) {
    status.textContent = "启动检查失败：" + (error?.message || String(error));
  }
})();
