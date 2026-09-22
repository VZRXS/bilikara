// One Host update action contract; OS verification/consent stays in its adapter.
(function (root) {
  "use strict";
  function create({platform, desktop, android, request}) {
    if (platform === "desktop") return {
      manualRelease: true,
      environment: async () => undefined,
      install: includePreview => desktop.startUpdate(includePreview),
      cancel: () => desktop.cancelUpdate(),
      applyPrepared: status => desktop.applyUpdate(status),
    };
    if (platform === "android") return {
      manualRelease: false,
      environment: async () => android?.environment().catch(() => ({})) || {},
      async install(includePreview) {
        if (!android) throw new Error("Android update adapter unavailable");
        const status = await request("/api/app/update/install", {include_preview: includePreview});
        if (!status.android_package) return status;
        let result = "failed";
        let finished;
        try {
          const outcome = await android.installUpdate(status.android_package);
          result = outcome.result;
        } finally {
          // The native APK adapter verifies signatures and requests system consent;
          // shared Rust settles its operation, including failed adapter calls.
          finished = await request("/api/app/update/finish", {operation: status.operation, result});
        }
        return finished;
      },
    };
    return null;
  }
  if (typeof module === "object" && module.exports) module.exports = {create};
  if (root.document?.documentElement?.dataset?.nativeHost === "true") {
    root.BilikaraHostUpdates = create({
      platform: root.document.documentElement.dataset.hostPlatform,
      desktop: root.BilikaraDesktopPlatform, android: root.BilikaraAndroidPlatform,
      request: (...args) => root.apiPost(...args),
    });
  }
})(globalThis);
