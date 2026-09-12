/* Android portrait presentation only. All actions and media stay in the shared
   Host tree; this module owns neither playback nor application state. */
(() => {
  "use strict";
  const root = document.documentElement;
  if (root.dataset.nativeHost !== "true") return;

  const byId = (id) => document.getElementById(id);
  const dock = byId("android-host-dock");
  const tools = byId("android-page-tools");
  const myPage = byId("android-my-page");
  const settingsBack = byId("android-settings-back");
  const queueTabs = byId("android-queue-tabs");
  const requestTabs = byId("android-request-tabs");
  const sharedRequestTabs = document.querySelector(".request-subview-tabs");
  const requestTabsAnchor = document.createComment("desktop request tabs position");
  sharedRequestTabs.before(requestTabsAnchor);
  const cacheSettings = byId("cache-settings");
  const cacheAnchor = document.createComment("desktop cache settings position");
  cacheSettings.before(cacheAnchor);
  const loginNodes = ["bbdown-status-row", "bbdown-login-panel"].map(id => {
    const node = byId(id);
    const anchor = document.createComment("desktop login position");
    node.before(anchor);
    return {node, anchor};
  });
  const advancedNodes = ["advance-delay-field", "cache-source-row"].map(id => {
    const node = byId(id);
    const anchor = document.createComment("desktop playback setting position");
    node.before(anchor);
    return {node, anchor};
  });
  const pages = new Set(["playback", "queue", "request", "users", "my"]);
  let portrait = false;
  let page = "playback";
  let settings = false;
  let queueView = "queue";
  let requestView = "request";
  let blockedImages = 0;
  const qrIds = ["remote-qr-image", "remote-popover-qr-image", "remote-mini-qr-image", "player-fullscreen-remote-qr-image"];

  function retryFailedQr() {
    let retry = false;
    for (const id of qrIds) {
      const image = byId(id);
      if (!image || !["failed", "missing-source", "invalid-source"].includes(image.dataset.qrState)) continue;
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      delete image.dataset.qrUrl;
      retry = true;
    }
    if (retry) {
      state.remoteAccessRenderSignature = "";
      renderRemoteAccess(state.data?.remote_access);
    }
  }

  function diagnosticsMarkdown() {
    // Fixed fields only: never capture URLs, QR data, credentials, arbitrary
    // error text or a securitypolicyviolation's blockedURI.
    const source = String(state.data?.remote_access?.qr_image || "");
    const safeStates = new Set(["no-address", "missing-source", "invalid-source", "loading", "loaded", "failed"]);
    const data = {
      layout: portrait ? "portrait" : "landscape", page,
      native_window_controls: Boolean(window.BilikaraHostWindow),
      viewport: {width: window.innerWidth, height: window.innerHeight},
      qr_source: !source ? "missing" : source.startsWith("data:image/svg+xml;base64,") ? "inline-svg" : "invalid",
      qr_source_chars: source.length, image_policy_blocks: blockedImages,
      qr_images: qrIds.map(id => {
        const image = byId(id);
        return {surface:id, state:safeStates.has(image?.dataset.qrState) ? image.dataset.qrState : "unknown",
          decoded:Boolean(image?.complete && image.naturalWidth > 0), failures:Number(image?.dataset.qrFailures) || 0};
      }),
    };
    return "\n\n## Android UI (sanitized)\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```\n";
  }

  function settingsEmbedded() { return portrait && page === "my" && !settings; }

  function syncAccount() {
    if (!portrait) return;
    const login = state.data?.bbdown?.login;
    const idle = !login?.state || login.state === "idle";
    // The account card waits for an explicit tap; merely visiting My must not
    // create a login request. Active QR/polling continues through shared code.
    byId("bbdown-login-panel").classList.toggle("hidden", Boolean(login?.logged_in) || idle);
    byId("android-account-slot").classList.toggle("is-logged", Boolean(login?.logged_in));
  }

  function syncRequestTabs() {
    if (!portrait) return;
    const random = state.activeHostWorkspace === "random";
    const randomButton = byId("android-request-random");
    randomButton.setAttribute("aria-selected", String(random));
    randomButton.tabIndex = random ? 0 : -1;
    for (const button of sharedRequestTabs.querySelectorAll("[data-request-view]")) {
      const active = !random && button.dataset.requestView === state.requestSubview;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
  }

  function syncVisibility() {
    if (!portrait) return;
    root.dataset.androidPage = page;
    const playingPage = page === "playback";
    const myHome = page === "my" && !settings;
    // Keep the decoder and split-player DOM connected and laid out offscreen.
    // Never reload/reparent/pause media simply because the user changes pages.
    elements.leftColumn.classList.toggle("android-stage-away", !playingPage);
    elements.leftColumn.inert = !playingPage;
    elements.leftColumn.setAttribute("aria-hidden", String(!playingPage));
    elements.hostWorkspaceRegion.hidden = playingPage || myHome;
    elements.hostWorkspaceRegion.inert = playingPage || myHome;
    elements.hostWorkspaceRegion.setAttribute("aria-hidden", String(playingPage || myHome));
    myPage.hidden = !myHome;
    myPage.inert = !myHome;
    queueTabs.hidden = page !== "queue";
    requestTabs.hidden = page !== "request";
    settingsBack.hidden = !(page === "my" && settings);
    tools.hidden = queueTabs.hidden && requestTabs.hidden && settingsBack.hidden;
    for (const button of dock.querySelectorAll("[data-android-page]")) {
      if (button.dataset.androidPage === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const button of tools.querySelectorAll("[data-android-workspace]")) {
      button.setAttribute("aria-pressed", String(button.dataset.androidWorkspace === state.activeHostWorkspace));
    }
    syncRequestTabs();
    syncAccount();
  }

  function saveRoute(replace = false) {
    const route = {page, settings, queueView, requestView};
    // Same-document history also gives Android's Back gesture a real parent
    // page; do not put credentials, room handles or business state in the URL.
    history[replace ? "replaceState" : "pushState"]({...history.state, androidHost: route}, "");
  }

  function navigate(next, {openSettings = false, remember = true} = {}) {
    if (!portrait || !pages.has(next)) return;
    const changed = next !== page || settings !== openSettings;
    page = next;
    settings = page === "my" && openSettings;
    state.cacheSettingsOpen = settingsEmbedded();
    syncCachePanelVisibility();
    const workspace = {queue: queueView, request: requestView, users: "users", my: "settings"}[page];
    if (workspace) activateHostWorkspace(workspace, {inputOrigin: "android-navigation"});
    syncVisibility();
    schedulePersistentStageMeasurement();
    if (remember && changed) saveRoute();
  }

  function workspaceActivated(workspace, inputOrigin) {
    if (!portrait || inputOrigin === "android-navigation") return;
    // Existing flows (e.g. asking the user to add a session user) must still
    // reveal their target page, even when the currently visible page is Play.
    const target = {queue: "queue", history: "queue", request: "request", random: "request", users: "users", settings: "my"}[workspace];
    if (!target) return;
    if (target === "queue") queueView = workspace;
    if (target === "request") requestView = workspace;
    navigate(target, {openSettings: target === "my"});
  }

  function updateOrientation() {
    // The keyboard can make visualViewport wider than tall. Screen orientation
    // does not change with the IME, so typing must not restore the desktop rail.
    const type = window.screen?.orientation?.type;
    const next = type ? type.startsWith("portrait") : window.matchMedia("(orientation: portrait)").matches;
    if (root.dataset.androidLayout && next === portrait) return;
    portrait = next;
    root.dataset.androidLayout = portrait ? "portrait" : "landscape";
    dock.hidden = !portrait;
    state.hostWorkspaceTransition = null;
    if (state.hostWorkspaceTransitionTimer) clearTimeout(state.hostWorkspaceTransitionTimer);
    state.hostWorkspaceTransitionTimer = null;
    if (portrait) {
      requestTabs.append(sharedRequestTabs);
      byId("android-settings-slot").append(cacheSettings);
      for (const {node} of loginNodes) byId("android-account-slot").append(node);
      for (const {node} of advancedNodes) byId("cache-panel").append(node);
      navigate(page, {openSettings: settings, remember: false});
    } else {
      requestTabsAnchor.after(sharedRequestTabs);
      cacheAnchor.after(cacheSettings);
      for (const {node, anchor} of loginNodes) anchor.after(node);
      for (const {node, anchor} of advancedNodes) anchor.after(node);
      byId("bbdown-login-panel").classList.toggle("hidden", Boolean(state.data?.bbdown?.login?.logged_in));
      state.cacheSettingsOpen = false;
      syncCachePanelVisibility();
      elements.leftColumn.classList.remove("android-stage-away");
      elements.leftColumn.inert = false;
      elements.leftColumn.removeAttribute("aria-hidden");
      elements.hostWorkspaceRegion.hidden = false;
      myPage.hidden = true;
      myPage.inert = true;
      tools.hidden = true;
    }
    renderHostWorkspaceSelection();
    schedulePersistentStageMeasurement();
  }

  window.BilikaraAndroidHost = {isPortrait: () => portrait, syncVisibility, workspaceActivated, settingsEmbedded, syncRequestTabs, syncAccount, diagnosticsMarkdown};
  const fullscreenRemote = byId("android-fullscreen-remote-button");
  fullscreenRemote.addEventListener("click", () => {
    if (!state.playerFullscreenRemotePinned) retryFailedQr();
    setPlayerFullscreenRemotePinned(!state.playerFullscreenRemotePinned);
    fullscreenRemote.setAttribute("aria-expanded", String(state.playerFullscreenRemotePinned));
  });
  document.addEventListener("bilikara:remote-access-menu", event => {
    if (event.detail?.expanded) retryFailedQr();
  });
  document.addEventListener("securitypolicyviolation", event => {
    if (event.effectiveDirective === "img-src") blockedImages++;
  });
  document.addEventListener("fullscreenchange", () => {
    const active = isPlayerPanelFullscreen();
    if (!active) fullscreenRemote.setAttribute("aria-expanded", "false");
    // WebView does not implement screen.orientation.lock(). The scoped native
    // bridge only controls this window, leaving the shared media DOM untouched.
    if (window.BilikaraHostWindow) window.BilikaraHostWindow.postMessage(active ? "enter" : "exit");
    else if (active) setAppMessage(t("mobile.fullscreenOrientationUnavailable"), true);
  });
  dock.addEventListener("click", (event) => {
    const button = event.target.closest("[data-android-page]");
    if (button) navigate(button.dataset.androidPage);
  });
  tools.addEventListener("click", (event) => {
    const button = event.target.closest("[data-android-workspace], [data-request-view]");
    if (!button) return;
    const workspace = button.dataset.requestView ? "request" : button.dataset.androidWorkspace;
    if (page === "queue") queueView = workspace;
    else if (page === "request") requestView = workspace;
    activateHostWorkspace(workspace, {inputOrigin: "android-navigation"});
    saveRoute(true);
  });
  sharedRequestTabs.addEventListener("keydown", (event) => {
    if (!portrait || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    // Capture before the desktop four-tab handler: the portrait row has five.
    event.preventDefault();
    event.stopImmediatePropagation();
    const buttons = Array.from(sharedRequestTabs.querySelectorAll("button"));
    let index = buttons.indexOf(event.target);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else index = (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.click();
    buttons[index]?.focus();
  }, true);
  byId("android-open-settings").addEventListener("click", () => navigate("my", {openSettings: true}));
  settingsBack.addEventListener("click", () => {
    navigate("my", {remember: false});
    // Retire the child route; system Back must not reopen Settings after the
    // user has explicitly returned to its parent page.
    saveRoute(true);
  });
  window.addEventListener("popstate", (event) => {
    const route = event.state?.androidHost;
    if (!route || !pages.has(route.page)) return;
    queueView = route.queueView === "history" ? "history" : "queue";
    requestView = route.requestView === "random" ? "random" : "request";
    // Back while landscape is visible only updates the remembered mobile route.
    page = route.page;
    settings = Boolean(route.settings);
    navigate(page, {openSettings: settings, remember: false});
  });
  window.screen?.orientation?.addEventListener("change", updateOrientation);
  window.addEventListener("resize", updateOrientation);
  updateOrientation();
  saveRoute(true);
})();
