(async () => {
  "use strict";
  const status = document.getElementById("bootstrap-status");
  const details = document.getElementById("bootstrap-details");
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") throw new Error("请在 Android Alpha 应用中打开此页面。");
    const result = await invoke("android_alpha_status");
    if (result?.schema_version !== 2 || result.stage !== "native-persistence" || result.backend !== "rust"
      || !Number.isSafeInteger(result.revision) || result.revision < 0
      || result.host_api_ready !== false || result.persistence_ready !== true || result.playback_ready !== false) {
      throw new Error("原生启动检查返回了不兼容的数据。");
    }
    status.textContent = "Rust AppState 已就绪，原生存档已接入。完整 Host 功能尚未接入。";
    details.textContent = JSON.stringify(result, null, 2);
    details.hidden = false;
  } catch (error) {
    status.textContent = "启动检查失败：" + (error?.message || String(error));
  }
})();
