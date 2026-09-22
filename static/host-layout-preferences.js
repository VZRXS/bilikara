// Shared layout policy; persistence is a narrow desktop/Android window adapter.
(function (root) {
  "use strict";
  const modes = ["auto", "desktop", "phone"];
  function resolveLayout(mode, width) {
    // A keyboard changes height, not the selected layout. Desktop's existing
    // minimum window width remains 700; phone mode is an explicit preference.
    return mode === "phone" || (mode !== "desktop" && (!Number.isFinite(Number(width)) || Number(width) < 700)) ? "phone" : "desktop";
  }
  function browserClient(storage) {
    const key = "bilikara.host.layout";
    const result = layout => ({layout, orientation: "system"});
    return {
      async load() {
        const saved = storage?.getItem(key);
        return result(modes.includes(saved) ? saved : "auto");
      },
      async saveLayout(mode) {
        if (!modes.includes(mode)) throw new Error("invalid_layout");
        storage?.setItem(key, mode);
        return result(mode);
      },
    };
  }
  if (typeof module === "object" && module.exports) module.exports = {resolveLayout, browserClient};
  root.BilikaraLayoutPolicy = {resolveLayout};
  if (root.document?.documentElement?.dataset?.hostPlatform === "desktop") {
    let storage;
    try { storage = root.localStorage; } catch { }
    root.BilikaraHostWindowPreferences = {
      orientation: false,
      client: root.__TAURI__?.core?.invoke ? root.BilikaraDesktopPlatform.windowPreferences : browserClient(storage),
    };
  }
})(globalThis);
