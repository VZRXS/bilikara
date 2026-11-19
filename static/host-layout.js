/* Shared native Host adaptive presentation. All actions and media stay in the shared
   Host tree; this module owns neither playback nor application state. */
(() => {
  "use strict";
  const root = document.documentElement;
  let edgeBack = null, backTransition = null;
  // Runtime settings share content-based wrapping on every Host platform.
  const sourceRow = document.getElementById?.("cache-source-row");
  let sourceRowFrame = null;
  function scheduleSourceRowLayout() {
    if (sourceRowFrame !== null || !sourceRow?.clientWidth) return;
    sourceRowFrame = window.requestAnimationFrame(() => {
      sourceRowFrame = null;
      if (!sourceRow?.clientWidth) return;
      const style = getComputedStyle(sourceRow);
      const labels = Array.from(sourceRow.querySelectorAll(".cache-panel-label"));
      const widths = labels.map(label => {
        // Measure the full translated label even while the narrow layout wraps it.
        const measure = label.cloneNode(true);
        measure.removeAttribute("data-i18n");
        measure.setAttribute("aria-hidden", "true");
        measure.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:max-content;max-width:none;pointer-events:none";
        label.after(measure);
        const width = measure.getBoundingClientRect().width;
        measure.remove();
        return width;
      });
      const required = Math.max(widths[0], parseFloat(style.getPropertyValue("--cache-source-control-width")))
        + Math.max(widths[1], sourceRow.querySelector(".cache-hires-switch").getBoundingClientRect().width)
        + parseFloat(style.getPropertyValue("--cache-source-inline-gap"));
      const layout = Math.ceil(required) > sourceRow.clientWidth ? "stacked" : "inline";
      if (sourceRow.dataset.layout !== layout) sourceRow.dataset.layout = layout;
    });
  }

  if (sourceRow && typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleSourceRowLayout);
    observer.observe(sourceRow);
    sourceRow.querySelectorAll(".cache-panel-label").forEach(label => observer.observe(label));
  }
  document.addEventListener("bilikara:i18n", scheduleSourceRowLayout);
  document.fonts?.ready.then(scheduleSourceRowLayout);
  document.fonts?.addEventListener?.("loadingdone", scheduleSourceRowLayout);
  window.addEventListener("resize", scheduleSourceRowLayout);
  scheduleSourceRowLayout();
  if (root.dataset.nativeHost !== "true") return;
  const mobileLabel = document.querySelector('.native-alpha-notice > [data-mobile-build-label]');
  if (mobileLabel && ['android', 'ios'].includes(root.dataset.hostPlatform)) {
    const requestedChannel = root.dataset.hostChannel;
    const channel = ['stable', 'beta', 'preview', 'development'].includes(requestedChannel)
      ? requestedChannel : (root.dataset.hostPlatform === 'ios' ? 'beta' : 'stable');
    const preview = ['beta', 'preview', 'development'].includes(channel);
    const key = `mobile.${root.dataset.hostPlatform}${preview ? 'BetaLabel' : 'Label'}`;
    mobileLabel.dataset.i18n = key;
    mobileLabel.textContent = t(key);
  }
  // Platform selects the mobile workflow; width only selects its arrangement.
  // Desktop keeps its existing workspace/rail even in a narrow touch window.
  if (!["android", "ios"].includes(root.dataset.hostPlatform)) {
    root.dataset.hostLayout = "landscape";
    return;
  }

  const byId = (id) => document.getElementById(id);
  const dock = byId("android-host-dock");
  const tools = byId("android-page-tools");
  const pageHeading = byId("android-page-heading");
  const pageHeadingAnchor = document.createComment("workspace heading container position");
  pageHeading.before(pageHeadingAnchor);
  const toolsAnchor = document.createComment("mobile contextual tabs position");
  tools.before(toolsAnchor);
  // Reuse the live desktop headings (including queue counts and translations).
  // Only their position changes; restore them before returning to desktop.
  const headingPositions = ["workspace-queue-heading", "workspace-history-heading", "workspace-request-heading", "workspace-users-heading", "android-my-title"]
    .map(id => {
      const heading = byId(id).parentElement;
      const anchor = document.createComment("desktop workspace heading position");
      heading.before(anchor);
      return {id, heading, anchor};
    });
  const headingActions = Array.from(document.querySelectorAll(".queue-card-head > .queue-toolbar"), toolbar => {
    const anchor = document.createComment("desktop queue actions position");
    toolbar.before(anchor);
    return {toolbar, anchor, workspace: toolbar.closest("[data-host-workspace-panel]").dataset.hostWorkspacePanel};
  });
  const myPage = byId("android-my-page");
  const myScroll = byId("android-my-scroll");
  let myScrollTop = 0;
  const settingsBack = byId("android-settings-back");
  const settingsBackAnchor = document.createComment("settings back position");
  settingsBack.before(settingsBackAnchor);
  const queueTabs = byId("android-queue-tabs");
  const requestTabs = byId("android-request-tabs");
  const sharedRequestTabs = document.querySelector(".request-subview-tabs");
  const requestTabsAnchor = document.createComment("desktop request tabs position");
  sharedRequestTabs.before(requestTabsAnchor);
  const contextualHeads = Array.from(document.querySelectorAll(".request-subview > .request-mode-head"), head => {
    const anchor = document.createComment("desktop contextual tabs position");
    head.before(anchor);
    return {head, anchor, view: head.parentElement.dataset.requestPanel};
  });
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
  for (const [index, link] of Array.from(document.querySelectorAll("[data-shared-workspace]")).entries()) {
    const source = workspaceButton(link.dataset.sharedWorkspace);
    const label = source.querySelector(".work-rail-label").cloneNode(true);
    label.removeAttribute("class");
    link.append(label);
    if (link.hasAttribute("data-workspace-icon")) {
      const icon = source.querySelector(".work-rail-icon").cloneNode(true);
      icon.removeAttribute("class");
      // Each SVG mask belongs to its copy; duplicate document IDs can bind
      // the compact icon to a hidden desktop definition.
      for (const definition of icon.querySelectorAll("[id]")) {
        const original = definition.id;
        definition.id = `compact-workspace-${index}-${original}`;
        for (const reference of icon.querySelectorAll("[mask]")) {
          if (reference.getAttribute("mask") === `url(#${original})`) {
            reference.setAttribute("mask", `url(#${definition.id})`);
          }
        }
      }
      link.prepend(icon);
    }
    link.setAttribute("aria-controls", source.getAttribute("aria-controls"));
  }
  const pages = new Set(Array.from(dock.querySelectorAll("[data-android-page]"), button => button.dataset.androidPage));
  let portrait = false;
  let preferences = {layout: "auto", orientation: "system"};
  let preferencesReady = false;
  let preferenceError = false;
  const layoutApi = window.BilikaraHostWindowPreferences;
  let page = "playback";
  let settings = false;
  let queueView = "queue";
  let requestView = "request";
  let finishSettingsTransition = null;
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
      external_display: (window.BilikaraNativePresentation || window.BilikaraAndroidPresentation)?.diagnostics(),
      ios_viewport: window.BilikaraIOSHost?.diagnostics(),
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
    const contextual = !random && state.requestSubview !== "quick";
    requestTabs.hidden = page !== "request";
    sharedRequestTabs.hidden = contextual;
    for (const entry of contextualHeads) {
      if (contextual && entry.view === state.requestSubview) {
        if (entry.head.parentElement !== requestTabs) requestTabs.append(entry.head);
      } else if (entry.anchor.nextSibling !== entry.head) entry.anchor.after(entry.head);
    }
    tools.hidden = queueTabs.hidden && requestTabs.hidden;
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
    // Snapshot renders must not hide either participant while a navigation
    // animation owns their visibility. The route commits only on completion.
    if (!portrait || backTransition || finishSettingsTransition) return;
    syncPlayerFieldWidths();
    root.dataset.hostPage = page;
    root.dataset.hostSettings = String(settings);
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
    const returningToMy = myHome && myPage.hidden;
    myPage.hidden = !myHome;
    if (returningToMy) myScroll.scrollTop = myScrollTop;
    myPage.inert = !myHome;
    queueTabs.hidden = page !== "queue";
    requestTabs.hidden = page !== "request";
    settingsBack.hidden = !(page === "my" && settings);
    const headingId = page === "queue" ? `workspace-${state.activeHostWorkspace}-heading`
      : page === "request" ? "workspace-request-heading"
      : page === "users" ? "workspace-users-heading"
      : myHome ? "android-my-title" : "";
    for (const entry of headingPositions) {
      if (entry.id === headingId) {
        if (entry.heading.parentElement !== pageHeading) pageHeading.append(entry.heading);
      } else if (entry.anchor.nextSibling !== entry.heading) entry.anchor.after(entry.heading);
    }
    for (const entry of headingActions) {
      if (page === "queue" && entry.workspace === state.activeHostWorkspace) {
        if (entry.toolbar.parentElement !== pageHeading) pageHeading.append(entry.toolbar);
      } else if (entry.anchor.nextSibling !== entry.toolbar) entry.anchor.after(entry.toolbar);
    }
    const settingsPage = page === "my" && settings;
    pageHeading.classList.toggle("has-page-actions", page === "queue" || settingsPage);
    tools.classList.toggle("is-title-only", page !== "queue" && page !== "request" && !settingsPage);
    if (settingsPage) {
      if (settingsBack.parentElement !== pageHeading) pageHeading.prepend(settingsBack);
    } else if (settingsBackAnchor.nextSibling !== settingsBack) settingsBackAnchor.after(settingsBack);
    pageHeading.hidden = !headingId && !settingsPage;
    tools.hidden = queueTabs.hidden && requestTabs.hidden;
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
    const route = {page, settings, queueView, requestView, requestSubTabs: {
      view: state.requestSubview, search: state.searchMode, discover: state.discoverMode, sources: state.sourcesMode,
    }};
    // Same-document history also gives the system Back gesture a real parent
    // page; do not put credentials, room handles or business state in the URL.
    history[replace ? "replaceState" : "pushState"]({...history.state, hostLayout: route}, "");
  }

  function syncPlayerFieldWidths() {
    for (const id of ["av-offset-input", "key-shift-input"]) {
      const input = byId(id);
      input.style.setProperty("--android-value-chars", String(Math.max(1, input.value.length)));
    }
  }

  function navigationHeader(openSettings) {
    return {node: openSettings ? settingsBack : headingPositions.find(entry => entry.id === "android-my-title").heading,
      page: openSettings ? "settings" : "my", bounds: pageHeading.getBoundingClientRect(), className: pageHeading.className};
  }

  function navigationPageBounds(node) {
    const content = node.getBoundingClientRect();
    const frame = document.querySelector(".shell-body").getBoundingClientRect();
    // The page moves over the complete usable viewport. Its content retains
    // the resident gutters inside that frame instead of clipping the motion
    // to the former card/content column.
    return {top: content.top, left: frame.left, width: frame.width, height: content.height,
      paddingLeft: content.left-frame.left, paddingRight: frame.right-content.right};
  }

  function mountNavigationHeaders(headers, bounds, interactive = false) {
    const bar = pageHeading.closest(".topbar"), barBounds = bar.getBoundingClientRect();
    const hidden = pageHeading.hidden, previous = root.dataset.hostNavigationTransition;
    const positions = headers.map(({node}) => ({node, parent: node.parentNode, next: node.nextSibling, hidden: node.hidden}));
    const frames = headers.map((header, index) => {
      const frame = document.createElement("div");
      frame.className = "mobile-navigation-header";
      frame.dataset.page = header.page;
      frame.inert = interactive || index === 0;
      bar.append(frame);
      const parent = frame.offsetParent, parentBounds = parent.getBoundingClientRect();
      Object.assign(frame.style, {left: `${bounds[index].left-parentBounds.left-parent.clientLeft+parent.scrollLeft}px`,
        top: `${barBounds.top-parentBounds.top-parent.clientTop+parent.scrollTop}px`,
        width: `${bounds[index].width}px`, height: `${barBounds.height}px`, zIndex: String(index+1)});
      const content = document.createElement("div");
      content.className = header.className;
      content.classList.toggle("has-page-actions", header.page === "settings");
      Object.assign(content.style, {position: "absolute", left: `${header.bounds.left-bounds[index].left}px`,
        top: `${header.bounds.top-barBounds.top}px`, width: `${header.bounds.width}px`, margin: "0"});
      header.node.hidden = false;
      content.append(header.node); frame.append(content);
      const divider = document.createElement("div");
      divider.className = "mobile-navigation-divider";
      Object.assign(divider.style, {left: `${header.bounds.left-bounds[index].left}px`, width: `${header.bounds.width}px`});
      frame.append(divider);
      return frame;
    });
    pageHeading.hidden = true;
    root.dataset.hostNavigationTransition = "true";
    return {frames, restore() {
      for (const {node,parent,next,hidden} of positions) {
        parent.insertBefore(node, next?.parentNode === parent ? next : null);
        node.hidden = hidden;
      }
      frames.forEach(frame => frame.remove());
      pageHeading.hidden = hidden;
      if (previous === undefined) delete root.dataset.hostNavigationTransition;
      else root.dataset.hostNavigationTransition = previous;
    }};
  }

  function restoreNavigationFocus(node, selection = null) {
    if (!node?.isConnected || node === document.body || node.closest("[hidden], [inert]")) return;
    node.focus({preventScroll: true});
    if (selection) node.setSelectionRange(...selection);
  }

  function navigate(next, {openSettings = false, remember = true, animate = true} = {}) {
    const focused = document.activeElement;
    if (backTransition) endEdgeBack(false, true);
    if (!portrait || !pages.has(next)) return;
    finishSettingsTransition?.({restoreFocus: false});
    if (!myPage.hidden) myScrollTop = Number(myScroll.scrollTop) || 0;
    const withinMy = page === "my" && next === "my" && settings !== openSettings;
    const slide = animate && withinMy
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const forward = openSettings;
    const previousCard = settings ? elements.hostWorkspaceRegion : myPage;
    const outgoingBounds = slide ? navigationPageBounds(previousCard) : null;
    const outgoingHeader = slide ? navigationHeader(settings) : null;
    const ownedFocus = previousCard.contains(focused) || pageHeading.contains(focused);
    const changed = next !== page || settings !== openSettings;
    if (changed) {
      leaveSourceEditors();
      resetMobileLogoutConfirmation();
    }
    page = next;
    settings = page === "my" && openSettings;
    state.cacheSettingsOpen = settingsEmbedded();
    syncCachePanelVisibility();
    const workspace = page === "queue" ? queueView : page === "request" ? requestView : defaultWorkspaces.get(page);
    if (workspace) activateHostWorkspace(workspace, {inputOrigin: "host-navigation"});
    syncVisibility();
    scheduleSourceRowLayout();
    schedulePersistentStageMeasurement();
    if (remember && changed) saveRoute();
    const restoreFocus = () => {
      if (withinMy && ownedFocus && (document.activeElement === document.body || document.activeElement === focused)) {
        restoreNavigationFocus(openSettings ? settingsBack : byId("android-open-settings"));
      }
    };
    if (slide) {
      const incoming = openSettings ? elements.hostWorkspaceRegion : myPage;
      const outgoing = openSettings ? myPage : elements.hostWorkspaceRegion;
      const nodes = [outgoing, incoming];
      const bounds = [outgoingBounds, navigationPageBounds(incoming)];
      const headers = mountNavigationHeaders([outgoingHeader, navigationHeader(openSettings)], bounds);
      const saved = nodes.map(node => ["position", "top", "left", "width", "height", "padding-left", "padding-right", "z-index", "clip-path"].map(key =>
        [key, node.style.getPropertyValue(key)]));
      nodes.forEach((node, index) => {
        node.hidden = false;
        node.inert = index === 0;
        node.style.position = "absolute";
        const parent = node.offsetParent;
        const frame = parent.getBoundingClientRect();
        Object.assign(node.style, {
          top: `${bounds[index].top - frame.top - parent.clientTop + parent.scrollTop}px`,
          left: `${bounds[index].left - frame.left - parent.clientLeft + parent.scrollLeft}px`,
          width: `${bounds[index].width}px`, height: `${bounds[index].height}px`, zIndex: String(index + 1),
          paddingLeft: `${bounds[index].paddingLeft}px`, paddingRight: `${bounds[index].paddingRight}px`,
        });
      });
      // Absolute card bounds restore the scroller's real viewport. Restore its
      // offset now, before the first animation frame, rather than only on exit.
      if (!forward) myScroll.scrollTop = myScrollTop;
      const sign = forward ? 1 : -1;
      const frames = [
        // The incoming page has transparent gaps. Clip the covered part of the
        // outgoing page at the same eased boundary instead of adding a flat base.
        [{transform: "translateX(0)", clipPath: "inset(0 0 0 0)"},
          {transform: `translateX(${-sign * bounds[0].width*.2}px)`, clipPath: forward ? "inset(0 80% 0 0)" : "inset(0 0 0 80%)"}],
        [{transform: `translateX(${sign * bounds[1].width}px)`}, {transform: "translateX(0)"}],
      ];
      const animations = nodes.flatMap((node,index) => [node,headers.frames[index]].map(part =>
        part.animate(frames[index], {duration: 200, easing: "ease-out", fill: "both"})));
      const finish = ({restoreFocus: focus = true} = {}) => {
        if (finishSettingsTransition !== finish) return;
        finishSettingsTransition = null;
        animations.forEach(animation => animation.cancel());
        nodes.forEach((node, index) => saved[index].forEach(([key, value]) =>
          value ? node.style.setProperty(key, value) : node.style.removeProperty(key)));
        headers.restore();
        syncVisibility();
        if (page === "my" && !settings) myScroll.scrollTop = myScrollTop;
        if (focus) restoreFocus();
      };
      finishSettingsTransition = finish;
      Promise.allSettled(animations.map(animation => animation.finished)).then(() => finish());
    } else restoreFocus();
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

  const inPagePlayerFullscreen = () => Boolean(document.body?.classList.contains("is-tauri-fullscreen-active"));
  function updateOrientation() {
    // This is a layout choice, not a physical orientation lock. Window width
    // handles tablets, folding and split windows without treating IME height
    // changes as rotation. The shared desktop shell adapts to remaining height.
    // In-page player fullscreen (iOS, desktop) may rotate a phone to landscape
    // (V7). Keep the current shell underneath until it ends: rebuilding the
    // landscape shell there left its rail column beside the iOS player.
    if (root.dataset.hostLayout && inPagePlayerFullscreen()) return;
    const width = document.documentElement.clientWidth || window.innerWidth;
    const next = window.BilikaraLayoutPolicy.resolveLayout(preferences.layout, width) === "phone";
    if (next !== portrait) finishSettingsTransition?.({restoreFocus: false});
    root.dataset.hostLayoutMode = preferences.layout;
    if (root.dataset.hostLayout && next === portrait) return;
    if (state.requestWorkspaceExpansion) closeExpandedRequestWorkspace({ restoreFocus: false });
    const focused = document.activeElement;
    const selection = focused && typeof focused.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const scrolls = Array.from(document.querySelectorAll(".host-workspace-panel, .settings-workspace-body, #cache-panel, .android-my-scroll"))
      .map(node => ({node, top: node.scrollTop, left: node.scrollLeft}));
    portrait = next;
    root.dataset.hostLayout = portrait ? "portrait" : "landscape";
    dock.hidden = !portrait;
    state.hostWorkspaceTransition = null;
    if (state.hostWorkspaceTransitionTimer) clearTimeout(state.hostWorkspaceTransitionTimer);
    state.hostWorkspaceTransitionTimer = null;
    if (portrait) {
      document.querySelector(".topbar .host-brand").after(pageHeading);
      elements.hostWorkspaceRegion.prepend(tools);
      byId("remote-mini-control").before(byId("presentation-settings"));
      requestTabs.append(sharedRequestTabs);
      // Desktop anchoring writes inline coordinates. Release them before the
      // same panel returns to normal flow inside the phone's My page.
      for (const property of ["position", "left", "right", "top"]) {
        elements.cachePanel.style.removeProperty(property);
      }
      byId("android-settings-slot").append(cacheSettings);
      byId("android-account-slot").append(account);
      byId("android-account-heading").append(accountStatus);
      navigate(page, {openSettings: settings, remember: false});
    } else {
      pageHeadingAnchor.after(pageHeading);
      toolsAnchor.after(tools);
      byId("presentation-settings").before(byId("remote-mini-control"));
      for (const entry of headingPositions) entry.anchor.after(entry.heading);
      settingsBackAnchor.after(settingsBack);
      for (const entry of headingActions) entry.anchor.after(entry.toolbar);
      for (const entry of contextualHeads) entry.anchor.after(entry.head);
      sharedRequestTabs.hidden = false;
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

  if (layoutApi?.client) {
    layoutApi.client.load().then(() => {
      // Normal windows follow system rotation and available width. Former
      // manual preferences must not pin the shared responsive interface.
      preferences = {layout: "auto", orientation: "system"};
      preferencesReady = true;
      updateOrientation();
    }).catch(() => {
      preferenceError = true;
      setAppMessage(t("mobile.windowPreferenceFailed"), true);
    });
  }

  function rememberSubTabs(workspace = state.activeHostWorkspace) {
    const primary = workspaceButton(workspace)?.dataset.compactPage;
    // This adapter can remember only leaves of the already selected section.
    // It never calls navigate(), changes the primary page or sends dock input.
    if (primary !== page || !['queue','request'].includes(page)) return;
    if (page === 'queue') queueView = workspace;
    else requestView = workspace;
    if (portrait) syncVisibility();
    saveRoute(true);
  }
  window.BilikaraHostLayout = {isPortrait: () => portrait, syncVisibility, syncPlayerFieldWidths, workspaceActivated, settingsEmbedded, syncRequestTabs, diagnosticsMarkdown, rememberSubTabs, primarySection: () => page};
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
  window.addEventListener("bilikara:ios-dock-select", event => {
    const button = dock.querySelectorAll("[data-android-page]")[event.detail?.index];
    if (root.dataset.hostPlatform === "ios" && portrait && button && !dock.hidden) navigate(button.dataset.androidPage);
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
  // Interactive DOM presentation on the shared route. This is deliberately
  // not described as a UIKit navigation-stack transition.
  function beginEdgeBack() {
    const focused = document.activeElement;
    finishSettingsTransition?.({restoreFocus: false});
    const outgoing = elements.hostWorkspaceRegion, incoming = myPage;
    const bounds = navigationPageBounds(outgoing);
    const nodes = [incoming, outgoing];
    const saved = nodes.map(node => ({css: node.style.cssText, hidden: node.hidden, inert: node.inert}));
    const selection = focused && typeof focused.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const headers = mountNavigationHeaders([navigationHeader(false),navigationHeader(true)], [bounds,bounds], true);
    nodes.forEach((node, index) => {
      node.hidden = false; node.inert = true;
      const parent = node.offsetParent;
      const frame = parent.getBoundingClientRect();
      Object.assign(node.style, {position: 'absolute', top: `${bounds.top-frame.top-parent.clientTop+parent.scrollTop}px`,
        left: `${bounds.left-frame.left-parent.clientLeft+parent.scrollLeft}px`, width: `${bounds.width}px`,
        paddingLeft: `${bounds.paddingLeft}px`, paddingRight: `${bounds.paddingRight}px`,
        height: `${bounds.height}px`, zIndex: String(index+1), transition: 'none'});
    });
    myScroll.scrollTop = myScrollTop;
    backTransition = {nodes, saved, headers, focused, selection, width: bounds.width, progress: 0, finishing: false};
  }
  function paintEdgeBack(progress) {
    if (!backTransition || backTransition.finishing) return;
    const transition = backTransition;
    transition.progress = Math.max(0, Math.min(1, progress));
    const [incoming, outgoing] = transition.nodes;
    for (const node of [incoming,transition.headers.frames[0]]) {
      node.style.transform = `translateX(${-(1-transition.progress)*transition.width*.25}px)`;
      node.style.clipPath = `inset(0 ${(1-transition.progress)*75}% 0 0)`;
    }
    for (const node of [outgoing,transition.headers.frames[1]]) node.style.transform = `translateX(${transition.progress*transition.width}px)`;
  }
  function endEdgeBack(commit, immediate = false) {
    const transition = backTransition;
    if (!transition) return;
    const restore = () => {
      if (backTransition !== transition) return;
      backTransition = null;
      transition.animations?.forEach(animation => animation.cancel());
      transition.nodes.forEach((node, index) => {
        node.style.cssText = transition.saved[index].css;
        node.hidden = transition.saved[index].hidden; node.inert = transition.saved[index].inert;
      });
      transition.headers.restore();
      if (commit && edgeBackAllowed()) {
        navigate('my', {remember: false, animate: false}); saveRoute(true);
        restoreNavigationFocus(byId("android-open-settings"));
      } else restoreNavigationFocus(transition.focused, transition.selection);
    };
    if (immediate) {restore(); return;}
    transition.finishing = true;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
    transition.animations = transition.nodes.flatMap((node, index) => [node,transition.headers.frames[index]].map(part => part.animate(
      [{transform: part.style.transform, clipPath: part.style.clipPath || "inset(0 0 0 0)"},
        {transform: `translateX(${index === 1 ? (commit ? transition.width : 0) : (commit ? 0 : -transition.width*.25)}px)`,
          clipPath: index === 0 && !commit ? "inset(0 75% 0 0)" : "inset(0 0 0 0)"}],
      {duration, easing: 'ease-out', fill: 'forwards'})));
    Promise.allSettled(transition.animations.map(animation => animation.finished)).then(restore);
  }
  const edgeBackAllowed = () => root.dataset.hostPlatform === "ios" && portrait && page === "my" && settings
    && ![...document.querySelectorAll('dialog[open], [aria-modal="true"]:not([hidden]):not(.hidden)')]
      .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
  document.addEventListener("touchstart", event => {
    if (root.dataset.iosNativeBack === "true") return;
    if (backTransition) endEdgeBack(false, true);
    edgeBack = null;
    if (!edgeBackAllowed() || event.touches.length !== 1
      || event.target.closest('button,a,input,select,textarea,[contenteditable],[role="slider"],.session-user-badge')) return;
    const touch = event.touches[0];
    if (touch.clientX > 24) return;
    edgeBack = {id:touch.identifier,x:touch.clientX,y:touch.clientY,claimed:false};
  }, {passive:true,capture:true});
  document.addEventListener("touchmove", event => {
    if (!edgeBack) return;
    const touch = [...event.touches].find(touch => touch.identifier === edgeBack.id);
    if (!edgeBackAllowed() || !touch || event.touches.length !== 1) {edgeBack=null;endEdgeBack(false);return;}
    const dx=touch.clientX-edgeBack.x,dy=Math.abs(touch.clientY-edgeBack.y);
    if(dx<0 || dy>18&&dy>Math.abs(dx)*.6){edgeBack=null;endEdgeBack(false);return;}
    if(dx>12&&dx>dy*1.5){
      if (!edgeBack.claimed) beginEdgeBack();
      edgeBack.claimed=true;event.preventDefault();
    }
    if (edgeBack.claimed) paintEdgeBack(dx / backTransition.width);
  }, {passive:false,capture:true});
  document.addEventListener("touchend", event => {
    const gesture=edgeBack;edgeBack=null;
    if(!gesture?.claimed) return;
    event.preventDefault();
    const touch=[...event.changedTouches].find(touch=>touch.identifier===gesture.id);
    endEdgeBack(Boolean(edgeBackAllowed() && touch && backTransition?.progress >= .35
      && Math.abs(touch.clientY-gesture.y) <= 40));
  }, {passive:false,capture:true});
  document.addEventListener("touchcancel",()=>{
    // UIKit cancels the WebView touch stream when its edge recognizer takes
    // ownership. Only the native cancelled phase may cancel that transition.
    if (root.dataset.iosNativeBack === "true") return;
    edgeBack=null;endEdgeBack(false);
  }, {passive:true,capture:true});
  window.addEventListener("bilikara:ios-back", event => {
    if (root.dataset.iosNativeBack !== "true") return;
    const {phase, progress, velocity} = event.detail || {};
    if (phase === "cancelled" || !edgeBackAllowed()) {endEdgeBack(false); return;}
    if (phase === "began") {
      if (backTransition) endEdgeBack(false, true);
      edgeBack = null; beginEdgeBack();
    }
    if (!backTransition || backTransition.finishing) return;
    paintEdgeBack(progress);
    if (phase === "ended") endEdgeBack(progress >= .35 || (progress >= .08 && velocity > 600));
  });
  window.addEventListener("popstate", (event) => {
    const route = event.state?.hostLayout;
    if (!route || !pages.has(route.page)) return;
    queueView = route.queueView === "history" ? "history" : "queue";
    requestView = route.requestView === "random" ? "random" : "request";
    window.BilikaraHostSubTabs?.restore(route.requestSubTabs);
    // Back while landscape is visible only updates the remembered mobile route.
    if (portrait) navigate(route.page, {openSettings: Boolean(route.settings), remember: false});
    else { page = route.page; settings = Boolean(route.settings); }
  });
  window.screen?.orientation?.addEventListener("change", updateOrientation);
  // Re-evaluate the deferred layout once in-page player fullscreen ends.
  let playerFullscreen = inPagePlayerFullscreen();
  if (typeof MutationObserver === "function" && document.body) new MutationObserver(() => {
    const active = inPagePlayerFullscreen();
    if (playerFullscreen && !active) updateOrientation();
    playerFullscreen = active;
  }).observe(document.body, {attributes: true, attributeFilter: ["class"]});
  for (const id of ["av-offset-input", "key-shift-input"]) {
    byId(id).addEventListener("input", syncPlayerFieldWidths);
  }
  window.addEventListener("resize", () => {
    edgeBack=null;endEdgeBack(false, true);
    finishSettingsTransition?.();
    updateOrientation();
    if (typeof ResizeObserver !== "function") scheduleSourceRowLayout();
  });

  window.addEventListener("pagehide", () => {endEdgeBack(false, true); finishSettingsTransition?.({restoreFocus: false});});
  window.addEventListener("bilikara:ime", event => {
    const pixels = Math.max(0, Number(event.detail?.bottom) || 0);
    const height = Math.min(window.innerHeight, pixels / (window.devicePixelRatio || 1));
    root.style.setProperty("--android-ime-height", `${height}px`);
    if (height > 0) window.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused?.matches("input, textarea, [contenteditable='true']")) focused.scrollIntoView({block: "nearest"});
    });
  });
  updateOrientation();
  saveRoute(true);
})();
