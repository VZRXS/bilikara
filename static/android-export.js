(function (root) {
  "use strict";
  if (root.document?.documentElement?.dataset?.nativeHost !== "true") return;
  const bridge = root.BilikaraHostExport;
  if (!bridge?.postMessage) return;
  root.document.documentElement.dataset.nativeExportReady = "true";
  let pending = null;
  let sequence = 0;
  bridge.onmessage = event => {
    let result;
    try { result = JSON.parse(event.data); } catch { return; }
    if (!pending || result.id !== pending.id) return;
    const job = pending;
    pending = null;
    root.BilikaraExportDownload?.recordExportDiagnostic({surface: "host", runtime: "tauri",
      format: job.format, source: job.source, pageSize: job.pageSize,
      stage: "android-system-save", status: result.status,
      errorMessage: result.status === "failed" ? result.errorMessage : undefined});
    if (result.status === "saved" || result.status === "cancelled") job.resolve(result.status === "saved");
    else job.reject(new Error(result.errorMessage || "Android 导出失败"));
  };
  root.BilikaraAndroidExport = {
    saveHistory(format, source, pageSize) {
      if (pending) return Promise.reject(new Error("另一项导出尚未完成"));
      if (!["csv", "image"].includes(format) || !(["played", "history"].includes(source) || /^played-[A-Za-z0-9._-]{1,128}\.json$/.test(source))
        || ![50, 60, 80, 100, 150, 200].includes(pageSize)) return Promise.reject(new Error("无效的导出选项"));
      return new Promise((resolve, reject) => {
        const id = `export-${++sequence}`;
        pending = {id, format, source, pageSize, resolve, reject};
        try { bridge.postMessage(JSON.stringify({id, format, source, pageSize})); }
        catch (error) { pending = null; reject(error); }
      });
    },
  };
})(globalThis);
