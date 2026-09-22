/* Shared native Host adaptive presentation. All actions and media stay in the shared
   Host tree; this module owns neither playback nor application state. */
(() => {
  "use strict";
  const root = document.documentElement;
  if (root.dataset.nativeHost !== "true") return;

  const byId = (id) => document.getElementById(id);
  // Only the phone layout embeds this selector in Settings. The desktop layout
  // restores the original node, not a second copy with duplicate handlers.
  const displaySettings = byId("presentation-settings");
  const displayAnchor = document.createComment("desktop display settings position");
  displaySettings?.before(displayAnchor);
  const settingsBody = document.querySelector("#host-workspace-settings .settings-workspace-body");
  let displaySection = null;
  if (displaySettings && settingsBody) {
    const section = document.createElement("section");
    section.className = "settings-section android-display-settings";
    section.hidden = true;
    const hint = document.createElement("p");
    hint.className = "android-display-hint";
    hint.dataset.i18n = "mobile.externalDisplayHint";
    hint.textContent = t("mobile.externalDisplayHint");
    section.append(hint);
    settingsBody.prepend(section);
    displaySection = section;
  }

  let selectedSessionUser = "";
  let userActionBusy = false;
  function syncSessionUsers() {
    if (!state.data?.session_users?.includes(selectedSessionUser)) selectedSessionUser = "";
    const list = byId("session-user-list");
    const touchActions = portrait || root.dataset.hostPlatform === "android";
    root.dataset.hostTouchUsers = String(touchActions);
    const help = document.querySelector('[data-i18n="session.help"], [data-i18n="mobile.sessionHelp"]');
    if (help) {
      help.dataset.i18n = touchActions ? "mobile.sessionHelp" : "session.help";
      help.textContent = t(help.dataset.i18n);
    }
    for (const badge of list.querySelectorAll(".session-user-badge")) {
      if (!touchActions) {
        badge.draggable = true;
        const toggle = badge.querySelector(".android-user-toggle");
        if (toggle) {
          const name = document.createElement("span");
          name.className = "session-user-name";
          name.textContent = badge.dataset.name;
          toggle.replaceWith(name);
          badge.querySelector(".android-user-actions")?.remove();
        }
        badge.classList.remove("is-actions-open");
        continue;
      }
      badge.draggable = false;
      let toggle = badge.querySelector(".android-user-toggle");
      if (!toggle) {
        toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "android-user-toggle";
        toggle.textContent = badge.dataset.name;
        badge.querySelector(".session-user-name").replaceWith(toggle);
        const actions = document.createElement("div");
        actions.className = "android-user-actions";
        for (const [action,label] of [["up","↑"],["down","↓"],["remove",t("common.delete")]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.userAction = action;
          button.textContent = label;
          button.setAttribute("aria-label", action === "remove" ? t("common.delete") : t(action === "up" ? "common.moveUp" : "common.moveDown"));
          actions.append(button);
        }
        badge.append(actions);
      }
      const open = badge.dataset.name === selectedSessionUser;
      badge.querySelector(".android-user-actions").hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      badge.classList.toggle("is-actions-open", open);
      for (const button of badge.querySelectorAll("[data-user-action]")) {
        const index = Number(badge.dataset.index);
        button.disabled = userActionBusy || (button.dataset.userAction === "up" && index === 0)
          || (button.dataset.userAction === "down" && index === (state.data?.session_users?.length || 0) - 1);
      }
    }
  }
  byId("session-user-list").addEventListener("contextmenu", event => { if (root.dataset.hostTouchUsers === "true") event.preventDefault(); });
  byId("session-user-list").addEventListener("click", async event => {
    const badge = event.target.closest(".session-user-badge");
    if (!badge || userActionBusy || root.dataset.hostTouchUsers !== "true") return;
    const button = event.target.closest("[data-user-action]");
    if (!button) {
      selectedSessionUser = selectedSessionUser === badge.dataset.name ? "" : badge.dataset.name;
      syncSessionUsers();
      return;
    }
    if (button.disabled) return;
    userActionBusy = true;
    const label = button.textContent;
    button.textContent = t("remoteIdentity.saving");
    button.setAttribute("aria-busy", "true");
    syncSessionUsers();
    try {
      if (button.dataset.userAction === "remove") await removeSessionUser(badge.dataset.name);
      else await moveSessionUser(badge.dataset.name, Number(badge.dataset.index) + (button.dataset.userAction === "up" ? -1 : 1));
    } finally {
      button.textContent = label;
      button.removeAttribute("aria-busy");
      userActionBusy = false;
      syncSessionUsers();
    }
  });
  document.addEventListener("click", event => {
    if (event.target.closest("#session-user-list") || userActionBusy || !selectedSessionUser) return;
    selectedSessionUser = "";
    syncSessionUsers();
  });
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
  let preferences = {layout: "auto", orientation: "system"};
  let preferencesReady = false;
  let preferenceBusy = false;
  let preferenceError = false;
  const layoutApi = window.BilikaraHostWindowPreferences;
  const layoutSwitch = byId("android-layout-switch");
  const orientationSwitch = byId("android-orientation-switch");
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
      layout_mode: preferences.layout, resolved_layout: portrait ? "phone" : "desktop",
      requested_orientation: preferences.orientation,
      screen_orientation: window.screen?.orientation?.type || "unknown",
      window_preferences_ready: preferencesReady, window_preferences_error: preferenceError,
      native_window_controls: Boolean(window.BilikaraHostWindow || window.__TAURI__?.core?.invoke),
      playback_visibility: window.BilikaraAndroidPlayback?.diagnostics() || null,
      external_display: window.BilikaraAndroidPresentation?.diagnostics(),
      viewport: {width: window.innerWidth, height: window.innerHeight},
      qr_source: !source ? "missing" : source.startsWith("data:image/svg+xml;base64,") ? "inline-svg" : "invalid",
      qr_source_chars: source.length, image_policy_blocks: blockedImages,
      qr_images: qrIds.map(id => {
        const image = byId(id);
        return {surface:id, state:safeStates.has(image?.dataset.qrState) ? image.dataset.qrState : "unknown",
          decoded:Boolean(image?.complete && image.naturalWidth > 0), failures:Number(image?.dataset.qrFailures) || 0};
      }),
    };
    return "\n\n## Host UI (sanitized)\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```\n";
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
    syncPlayerFieldWidths();
    root.dataset.hostPage = page;
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
    history[replace ? "replaceState" : "pushState"]({...history.state, hostLayout: route}, "");
  }

  function syncPlayerFieldWidths() {
    for (const id of ["av-offset-input", "key-shift-input"]) {
      const input = byId(id);
      input.style.setProperty("--android-value-chars", String(Math.max(1, input.value.length)));
    }
  }

  function navigate(next, {openSettings = false, remember = true} = {}) {
    if (!portrait || !pages.has(next)) return;
    const changed = next !== page || settings !== openSettings;
    page = next;
    settings = page === "my" && openSettings;
    state.cacheSettingsOpen = settingsEmbedded();
    syncCachePanelVisibility();
    const workspace = {queue: queueView, request: requestView, users: "users", my: "settings"}[page];
    if (workspace) activateHostWorkspace(workspace, {inputOrigin: "host-navigation"});
    syncVisibility();
    schedulePersistentStageMeasurement();
    if (remember && changed) saveRoute();
  }

  function workspaceActivated(workspace, inputOrigin) {
    if (inputOrigin === "host-navigation") return;
    // Existing flows (e.g. asking the user to add a session user) must still
    // reveal their target page, even when the currently visible page is Play.
    const target = {queue: "queue", history: "queue", request: "request", random: "request", users: "users", settings: "my"}[workspace];
    if (!target) return;
    if (target === "queue") queueView = workspace;
    if (target === "request") requestView = workspace;
    if (!portrait) {
      page = target;
      settings = target === "my";
      saveRoute(true);
      return;
    }
    navigate(target, {openSettings: target === "my"});
  }

  function updateOrientation() {
    // This is a layout choice, not a physical orientation lock. Window width
    // handles tablets, folding and split windows without treating IME height
    // changes as rotation. The shared desktop shell adapts to remaining height.
    const width = document.documentElement.clientWidth || window.innerWidth;
    const next = window.BilikaraLayoutPolicy.resolveLayout(preferences.layout, width) === "phone";
    root.dataset.hostLayoutMode = preferences.layout;
    if (root.dataset.hostLayout && next === portrait) return;
    const focused = document.activeElement;
    const selection = focused && typeof focused.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const scrolls = Array.from(document.querySelectorAll(".host-workspace-panel, .settings-workspace-body, #cache-panel, #android-my-page"))
      .map(node => ({node, top: node.scrollTop, left: node.scrollLeft}));
    portrait = next;
    root.dataset.hostLayout = portrait ? "portrait" : "landscape";
    dock.hidden = !portrait;
    state.hostWorkspaceTransition = null;
    if (state.hostWorkspaceTransitionTimer) clearTimeout(state.hostWorkspaceTransitionTimer);
    state.hostWorkspaceTransitionTimer = null;
    if (portrait) {
      if (displaySection) {
        displaySection.hidden = false;
        displaySection.prepend(displaySettings);
      }
      requestTabs.append(sharedRequestTabs);
      byId("android-settings-slot").append(cacheSettings);
      for (const {node} of loginNodes) byId("android-account-slot").append(node);
      for (const {node} of advancedNodes) byId("cache-panel").append(node);
      navigate(page, {openSettings: settings, remember: false});
    } else {
      if (displaySection) {
        displayAnchor.after(displaySettings);
        displaySection.hidden = true;
      }
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
      elements.hostWorkspaceRegion.inert = false;
      elements.hostWorkspaceRegion.removeAttribute("aria-hidden");
      myPage.hidden = true;
      myPage.inert = true;
      tools.hidden = true;
    }
    renderHostWorkspaceSelection();
    syncSessionUsers();
    for (const {node, top, left} of scrolls) { node.scrollTop = top; node.scrollLeft = left; }
    if (focused?.isConnected && !focused.closest("[inert], [hidden]")) {
      focused.focus({preventScroll: true});
      if (selection) focused.setSelectionRange(...selection);
    }
    schedulePersistentStageMeasurement();
  }

  function syncWindowPreferences() {
    for (const [group, attribute, value] of [
      [layoutSwitch, "androidLayoutMode", preferences.layout],
      [orientationSwitch, "androidOrientationMode", preferences.orientation],
    ]) {
      for (const button of group.querySelectorAll("button")) {
        const selected = button.dataset[attribute] === value;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.disabled = !preferencesReady || preferenceBusy;
      }
    }
  }

  async function changeWindowPreference(event, field, group) {
    const button = event.target.closest("button");
    if (!button || !group.contains(button) || button.disabled || preferenceBusy) return;
    const mode = button.dataset[field === "layout" ? "androidLayoutMode" : "androidOrientationMode"];
    if (mode === preferences[field]) return;
    preferenceBusy = true;
    button.setAttribute("aria-busy", "true");
    syncWindowPreferences();
    try {
      preferences = await (field === "layout" ? layoutApi.client.saveLayout(mode) : layoutApi.client.saveOrientation(mode));
      preferenceError = false;
      updateOrientation();
    } catch {
      preferenceError = true;
      setAppMessage(t("mobile.windowPreferenceFailed"), true);
    } finally {
      preferenceBusy = false;
      button.removeAttribute("aria-busy");
      syncWindowPreferences();
    }
  }

  byId("android-layout-settings").hidden = false;
  byId("android-orientation-settings").hidden = !layoutApi?.orientation;
  layoutSwitch.addEventListener("click", event => changeWindowPreference(event, "layout", layoutSwitch));
  orientationSwitch.addEventListener("click", event => changeWindowPreference(event, "orientation", orientationSwitch));
  syncWindowPreferences();
  if (layoutApi?.client) {
    layoutApi.client.load().then(saved => {
      preferences = saved;
      preferencesReady = true;
      updateOrientation();
      syncWindowPreferences();
    }).catch(() => {
      preferenceError = true;
      setAppMessage(t("mobile.windowPreferenceFailed"), true);
    });
  }

  window.BilikaraHostLayout = {isPortrait: () => portrait, syncSessionUsers, syncVisibility, syncPlayerFieldWidths, workspaceActivated, settingsEmbedded, syncRequestTabs, syncAccount, diagnosticsMarkdown};
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
    activateHostWorkspace(workspace, {inputOrigin: "host-navigation"});
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
    const route = event.state?.hostLayout;
    if (!route || !pages.has(route.page)) return;
    queueView = route.queueView === "history" ? "history" : "queue";
    requestView = route.requestView === "random" ? "random" : "request";
    // Back while landscape is visible only updates the remembered mobile route.
    page = route.page;
    settings = Boolean(route.settings);
    navigate(page, {openSettings: settings, remember: false});
  });
  window.screen?.orientation?.addEventListener("change", updateOrientation);
  for (const id of ["av-offset-input", "key-shift-input"]) {
    byId(id).addEventListener("input", syncPlayerFieldWidths);
  }
  window.addEventListener("resize", updateOrientation);
  updateOrientation();
  saveRoute(true);
})();
