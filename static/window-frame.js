(function attachWindowFrame(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BilikaraWindowFrame = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function createWindowFrameApi() {
  function detectTauriWindow(host) {
    const tauri = host && host.__TAURI__;
    const webviewWindow = tauri && tauri.webviewWindow;
    if (typeof (webviewWindow && webviewWindow.getCurrentWebviewWindow) === "function") {
      try {
        return webviewWindow.getCurrentWebviewWindow();
      } catch {
        // Try the Tauri v2 window API below.
      }
    }

    const tauriWindow = tauri && tauri.window;
    if (typeof (tauriWindow && tauriWindow.getCurrentWindow) === "function") {
      try {
        return tauriWindow.getCurrentWindow();
      } catch {
        return null;
      }
    }
    return null;
  }

  function supportsWindowFrame(appWindow) {
    return Boolean(
      appWindow
      && typeof appWindow.minimize === "function"
      && typeof appWindow.toggleMaximize === "function"
      && typeof appWindow.isMaximized === "function"
      && typeof appWindow.close === "function"
    );
  }

  function createController(options) {
    const settings = options || {};
    const host = settings.root || (typeof window !== "undefined" ? window : null);
    const doc = settings.document || (host && host.document) || null;
    const translate = typeof settings.translate === "function"
      ? settings.translate
      : (key) => key;
    const onError = typeof settings.onError === "function"
      ? settings.onError
      : (error) => {
        if (host && host.console && typeof host.console.warn === "function") {
          host.console.warn("Window frame action failed:", error);
        }
      };
    const appWindow = settings.appWindow || detectTauriWindow(host);
    const elements = doc ? {
      titlebar: doc.getElementById("tauri-titlebar"),
      dragRegion: doc.getElementById("tauri-titlebar-drag-region"),
      minimize: doc.getElementById("tauri-window-minimize"),
      maximize: doc.getElementById("tauri-window-maximize"),
      close: doc.getElementById("tauri-window-close"),
    } : {};
    let enabled = false;
    let maximized = false;
    let maximizedSyncSequence = 0;
    let resizeSyncTimeout = null;

    function reportError(error) {
      try {
        onError(error);
      } catch {
        // Error reporting must never create an unhandled window-action failure.
      }
    }

    function setButtonBusy(button, busy) {
      if (!button) {
        return;
      }
      button.disabled = Boolean(busy);
      if (busy) {
        button.setAttribute("aria-busy", "true");
      } else {
        button.removeAttribute("aria-busy");
      }
    }

    function refreshLabels() {
      if (!enabled) {
        return;
      }
      const minimizeLabel = translate("window.minimize");
      const maximizeLabel = translate(maximized ? "window.restore" : "window.maximize");
      const closeLabel = translate("window.close");
      elements.minimize.setAttribute("aria-label", minimizeLabel);
      elements.minimize.setAttribute("title", minimizeLabel);
      elements.maximize.setAttribute("aria-label", maximizeLabel);
      elements.maximize.setAttribute("title", maximizeLabel);
      elements.close.setAttribute("aria-label", closeLabel);
      elements.close.setAttribute("title", closeLabel);
    }

    function applyMaximized(nextMaximized) {
      maximized = Boolean(nextMaximized);
      elements.maximize.classList.toggle("is-maximized", maximized);
      elements.maximize.setAttribute("aria-pressed", String(maximized));
      refreshLabels();
    }

    async function syncMaximized() {
      if (!enabled) {
        return false;
      }
      const syncSequence = ++maximizedSyncSequence;
      try {
        const nextMaximized = await appWindow.isMaximized();
        if (syncSequence === maximizedSyncSequence) {
          applyMaximized(nextMaximized);
        }
        return true;
      } catch (error) {
        reportError(error);
        return false;
      }
    }

    async function runButtonAction(button, action, syncAfter) {
      if (!enabled || !button || button.disabled) {
        return false;
      }
      setButtonBusy(button, true);
      try {
        await action();
        if (syncAfter) {
          await syncMaximized();
        }
        return true;
      } catch (error) {
        reportError(error);
        return false;
      } finally {
        setButtonBusy(button, false);
      }
    }

    function toggleMaximize() {
      return runButtonAction(
        elements.maximize,
        () => appWindow.toggleMaximize(),
        true,
      );
    }

    function setFullscreen(fullscreen) {
      if (!doc || !doc.documentElement) {
        return;
      }
      doc.documentElement.classList.toggle("tauri-window-fullscreen", Boolean(fullscreen));
    }

    function initialize() {
      const completeMarkup = Boolean(
        elements.titlebar
        && elements.dragRegion
        && elements.minimize
        && elements.maximize
        && elements.close
      );
      if (!completeMarkup || !supportsWindowFrame(appWindow)) {
        if (elements.titlebar) {
          elements.titlebar.classList.add("hidden");
          elements.titlebar.setAttribute("aria-hidden", "true");
        }
        return false;
      }

      enabled = true;
      elements.titlebar.classList.remove("hidden");
      elements.titlebar.setAttribute("aria-hidden", "false");
      doc.documentElement.classList.add("tauri-window-frame");
      elements.minimize.addEventListener("click", () => {
        void runButtonAction(elements.minimize, () => appWindow.minimize(), false);
      });
      elements.maximize.addEventListener("click", () => {
        void toggleMaximize();
      });
      elements.close.addEventListener("click", () => {
        void runButtonAction(elements.close, () => appWindow.close(), false);
      });
      if (host && typeof host.addEventListener === "function") {
        host.addEventListener("resize", () => {
          if (resizeSyncTimeout !== null) {
            host.clearTimeout(resizeSyncTimeout);
          }
          resizeSyncTimeout = host.setTimeout(() => {
            resizeSyncTimeout = null;
            void syncMaximized();
          }, 100);
        });
      }
      refreshLabels();
      void syncMaximized();
      return true;
    }

    return {
      initialize,
      refreshLabels,
      setFullscreen,
      syncMaximized,
      isEnabled: () => enabled,
    };
  }

  return {
    createController,
    detectTauriWindow,
    supportsWindowFrame,
  };
});
