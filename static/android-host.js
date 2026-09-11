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
  const cacheSettings = byId("cache-settings");
  const cacheAnchor = document.createComment("desktop cache settings position");
  cacheSettings.before(cacheAnchor);
  const pages = new Set(["playback", "queue", "request", "users", "my"]);
  let portrait = false;
  let page = "playback";
  let settings = false;
  let queueView = "queue";
  let requestView = "request";

  function settingsEmbedded() { return portrait && page === "my" && settings; }

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
    settingsBack.hidden = !settingsEmbedded();
    tools.hidden = queueTabs.hidden && requestTabs.hidden && settingsBack.hidden;
    for (const button of dock.querySelectorAll("[data-android-page]")) {
      if (button.dataset.androidPage === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const button of tools.querySelectorAll("[data-android-workspace]")) {
      button.setAttribute("aria-pressed", String(button.dataset.androidWorkspace === state.activeHostWorkspace));
    }
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
      byId("android-settings-slot").append(cacheSettings);
      navigate(page, {openSettings: settings, remember: false});
    } else {
      cacheAnchor.after(cacheSettings);
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

  window.BilikaraAndroidHost = {isPortrait: () => portrait, syncVisibility, workspaceActivated, settingsEmbedded};
  dock.addEventListener("click", (event) => {
    const button = event.target.closest("[data-android-page]");
    if (button) navigate(button.dataset.androidPage);
  });
  tools.addEventListener("click", (event) => {
    const button = event.target.closest("[data-android-workspace]");
    if (!button) return;
    const workspace = button.dataset.androidWorkspace;
    if (page === "queue") queueView = workspace;
    else if (page === "request") requestView = workspace;
    activateHostWorkspace(workspace, {inputOrigin: "android-navigation"});
    saveRoute(true);
  });
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
