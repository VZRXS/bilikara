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
    hint.hidden = root.dataset.hostPlatform !== "android";
    hint.dataset.i18n = "mobile.externalDisplayHint";
    hint.textContent = t("mobile.externalDisplayHint");
    section.append(hint);
    settingsBody.prepend(section);
    displaySection = section;
  }

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
  const account = byId("host-account-settings");
  const accountAnchor = document.createComment("desktop account section position");
  account.before(accountAnchor);
  const accountStatus = byId("bbdown-status-row");
  const accountStatusAnchor = document.createComment("desktop account status position");
  accountStatus.before(accountStatusAnchor);
  // The desktop rail owns shared workspace labels, icons, targets and grouping.
  // Compact navigation has its own outer shell, not another content definition.
  const workspaceButtons = Array.from(document.querySelectorAll("[data-host-workspace]"));
  const workspaceButton = workspace => workspaceButtons.find(button => button.dataset.hostWorkspace === workspace);
  const defaultWorkspaces = new Map();
  for (const button of workspaceButtons) {
    if (!defaultWorkspaces.has(button.dataset.compactPage)) defaultWorkspaces.set(button.dataset.compactPage, button.dataset.hostWorkspace);
  }
  for (const link of document.querySelectorAll("[data-shared-workspace]")) {
    const source = workspaceButton(link.dataset.sharedWorkspace);
    const label = source.querySelector(".work-rail-label").cloneNode(true);
    label.removeAttribute("class");
    link.append(label);
    if (link.hasAttribute("data-workspace-icon")) {
      const icon = source.querySelector(".work-rail-icon").cloneNode(true);
      icon.removeAttribute("class");
      link.prepend(icon);
    }
    link.setAttribute("aria-controls", source.getAttribute("aria-controls"));
  }
  const pages = new Set(Array.from(dock.querySelectorAll("[data-android-page]"), button => button.dataset.androidPage));
  let portrait = false;
  let preferences = {layout: "auto", orientation: "system"};
  let preferencesReady = false;
  let preferenceBusy = false;
  let preferenceError = false;
  const layoutApi = window.BilikaraHostWindowPreferences;
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

  function syncRequestTabs() {
    if (!portrait) return;
    const random = state.activeHostWorkspace === "random";
    // The contextual row occupies the primary row's place on phones. All
    // secondary tabs and content stay in their original shared DOM nodes.
    requestTabs.hidden = page !== "request" || (!random && state.requestSubview !== "quick");
    tools.hidden = queueTabs.hidden && requestTabs.hidden && settingsBack.hidden;
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
    syncHostAccountPresentation();
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
    const workspace = page === "queue" ? queueView : page === "request" ? requestView : defaultWorkspaces.get(page);
    if (workspace) activateHostWorkspace(workspace, {inputOrigin: "host-navigation"});
    syncVisibility();
    schedulePersistentStageMeasurement();
    if (remember && changed) saveRoute();
  }

  function workspaceActivated(workspace, inputOrigin) {
    if (inputOrigin === "host-navigation") return;
    // Existing flows (e.g. asking the user to add a session user) must still
    // reveal their target page, even when the currently visible page is Play.
    const target = workspaceButton(workspace)?.dataset.compactPage;
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
      byId("android-account-slot").append(account);
      account.prepend(accountStatus);
      navigate(page, {openSettings: settings, remember: false});
    } else {
      if (displaySection) {
        displayAnchor.after(displaySettings);
        displaySection.hidden = true;
      }
      requestTabsAnchor.after(sharedRequestTabs);
      cacheAnchor.after(cacheSettings);
      accountAnchor.after(account);
      accountStatusAnchor.after(accountStatus);
      syncHostAccountPresentation();
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
    syncSessionUserControls();
    for (const {node, top, left} of scrolls) { node.scrollTop = top; node.scrollLeft = left; }
    if (focused?.isConnected && !focused.closest("[inert], [hidden]")) {
      focused.focus({preventScroll: true});
      if (selection) focused.setSelectionRange(...selection);
    }
    schedulePersistentStageMeasurement();
  }

  function syncWindowPreferences() {
    for (const [group, attribute, value] of [
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

  async function changeWindowPreference(event) {
    const group = orientationSwitch;
    const button = event.target.closest("button");
    if (!button || !group.contains(button) || button.disabled || preferenceBusy) return;
    const mode = button.dataset.androidOrientationMode;
    if (mode === preferences.orientation) return;
    preferenceBusy = true;
    button.setAttribute("aria-busy", "true");
    syncWindowPreferences();
    try {
      preferences = {...await layoutApi.client.saveOrientation(mode), layout: "auto"};
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

  byId("android-orientation-settings").hidden = !layoutApi?.orientation;
  orientationSwitch.addEventListener("click", changeWindowPreference);
  syncWindowPreferences();
  if (layoutApi?.client) {
    layoutApi.client.load().then(saved => {
      // Preview 2 exposes responsive layout only. Retain saved platform data,
      // but do not let an earlier hidden manual selection pin the interface.
      preferences = {...saved, layout: "auto"};
      preferencesReady = true;
      updateOrientation();
      syncWindowPreferences();
    }).catch(() => {
      preferenceError = true;
      setAppMessage(t("mobile.windowPreferenceFailed"), true);
    });
  }

  window.BilikaraHostLayout = {isPortrait: () => portrait, syncVisibility, syncPlayerFieldWidths, workspaceActivated, settingsEmbedded, syncRequestTabs, diagnosticsMarkdown};
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
  for (const button of document.querySelectorAll("[data-request-back]")) {
    button.addEventListener("click", () => {
      const previous = state.requestSubview;
      activateRequestSubview("quick");
      sharedRequestTabs.querySelector(`[data-request-view="${previous}"]`)?.focus();
    });
  }
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
    const target = requestTabs.hidden
      ? document.querySelector(".request-subview:not([hidden]) .request-mode-tabs [aria-selected='true']")
      : buttons[index];
    target?.focus();
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
