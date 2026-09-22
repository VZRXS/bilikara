// Android window/display operations only; Host navigation and actions are shared.
(() => {
  "use strict";
  if (document.documentElement.dataset.hostPlatform !== "android") return;
  const fullscreenRemote = document.getElementById("android-fullscreen-remote-button");
  const displayBridge = window.BilikaraAndroidPresentation;
  if (displayBridge) {
    const heartbeat = window.setInterval(() => {
      if (displayBridge.isForeground() && !document.hidden) publishPresentationOutputState();
    }, 250);
    const refreshDisplayDiagnostics = () => displayBridge.refreshDiagnostics().catch(() => {});
    displayBridge.listen("bilikara-presentation-state", refreshDisplayDiagnostics);
    displayBridge.listen("displays-changed", refreshDisplayDiagnostics);
    refreshDisplayDiagnostics();
    window.addEventListener("pagehide", () => window.clearInterval(heartbeat));
  }
  document.addEventListener("fullscreenchange", () => {
    const active = isPlayerPanelFullscreen();
    if (!active) fullscreenRemote.setAttribute("aria-expanded", "false");
    // WebView does not implement screen.orientation.lock(). The scoped native
    // bridge only controls this window, leaving the shared media DOM untouched.
    if (window.BilikaraHostWindow) window.BilikaraHostWindow.postMessage(active ? "enter" : "exit");
    else if (active) setAppMessage(t("mobile.fullscreenOrientationUnavailable"), true);
  });
})();
