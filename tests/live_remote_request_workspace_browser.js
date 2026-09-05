"use strict";

function assert(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
}

function suffixedPath(path, suffix) {
  return path ? path.replace(/(\.[^./]+)$/, `${suffix}$1`) : "";
}

function resultItems(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    bvid: `BV${prefix}${String(index).padStart(2, "0")}`,
    title: `${prefix} result ${index + 1}`,
    url: `https://www.bilibili.com/video/BV${prefix}${String(index).padStart(2, "0")}`,
    owner_name: `${prefix} owner`,
    played_count: 12800 + index,
    rank: 4.6,
    duration: 210 + index,
  }));
}

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function waitForThemeControlsSettled(page) {
  await page.waitForFunction(() => {
    const activePanel = document.querySelector('.remote-request-view:not([hidden])');
    const activeTabs = [
      document.querySelector('.remote-request-tab[aria-selected="true"]'),
      activePanel?.querySelector('[role="tab"][aria-selected="true"]'),
    ].filter(Boolean);
    const peerActions = [
      document.querySelector("#resort-playlist-button"),
      document.querySelector("#gatcha-pool-config-toggle"),
    ].filter(Boolean);
    if (activeTabs.length !== 2 || peerActions.length !== 2) return false;
    const resolveThemePair = (backgroundVariable, colorVariable) => {
      const probe = document.createElement("span");
      probe.style.cssText = `position:fixed;pointer-events:none;transition:none;background:${backgroundVariable};color:${colorVariable}`;
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const pair = { backgroundColor: style.backgroundColor, color: style.color };
      probe.remove();
      return pair;
    };
    const segmentedTarget = resolveThemePair(
      "var(--remote-segmented-control-active-bg)",
      "var(--remote-segmented-control-active-color)",
    );
    const primaryTarget = resolveThemePair(
      "var(--remote-primary-button-bg)",
      "var(--remote-primary-button-color)",
    );
    const secondaryTarget = resolveThemePair(
      "var(--remote-secondary-button-bg)",
      "var(--remote-secondary-button-color)",
    );
    const tabsSettled = activeTabs.every((tab) => {
      const style = getComputedStyle(tab);
      return style.backgroundColor === segmentedTarget.backgroundColor
        && style.color === segmentedTarget.color;
    });
    const peerActionsSettled = peerActions.every((action) => {
      const style = getComputedStyle(action);
      return style.backgroundColor === secondaryTarget.backgroundColor
        && style.color === secondaryTarget.color;
    });
    return tabsSettled && peerActionsSettled && (
      segmentedTarget.backgroundColor !== primaryTarget.backgroundColor
        || segmentedTarget.color !== primaryTarget.color
    );
  });
}

function segmentedControlsUseDistinctSelection(styles) {
  return styles.topActive.backgroundColor === styles.secondaryActive.backgroundColor
    && styles.topActive.color === styles.secondaryActive.color
    && (
      styles.topActive.backgroundColor !== styles.primaryButton.backgroundColor
        || styles.topActive.color !== styles.primaryButton.color
    );
}

function peerHeaderActionsShareTheme(actions) {
  return actions.every((action) => (
    action.backgroundColor === actions[0].backgroundColor
      && action.color === actions[0].color
  ));
}

async function capture(page, path, fullPage = false) {
  if (path) await page.screenshot({ path, fullPage });
}

function workspaceRouteState() {
  return {
    snapshot: null,
    apiRequests: [],
    addRequests: [],
    sharedSearchRequests: [],
    localSearchRequests: [],
    categoryRequests: [],
    d1Requests: [],
    uploaderRequests: [],
    favoriteRequests: [],
    refreshRequests: [],
    remoteIdentityRequests: [],
  };
}

async function installWorkspaceRoutes(context, routeState) {
  await context.route("**/api/remote-identity", (route) => {
    routeState.remoteIdentityRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          registered: true,
          name: "Browser QA",
          session_id: "browser-remote-session",
        },
      }),
    });
  });
  await context.route("**/api/playlist/add", (route) => {
    routeState.addRequests.push(route.request().postDataJSON());
    routeState.snapshot = {
      ...(routeState.snapshot || {}),
      state_revision: Number(routeState.snapshot?.state_revision || 1000) + 1,
      remote_session_id: "browser-remote-session",
      session_users: ["Browser QA"],
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: routeState.snapshot }),
    });
  });
  await context.route("**/api/lark/search?**", (route) => {
    routeState.sharedSearchRequests.push(route.request().url());
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: query === "workspace-empty" ? [] : resultItems("SHARED", 5) },
      }),
    });
  });
  await context.route("**/api/gatcha/search?**", (route) => {
    routeState.localSearchRequests.push(route.request().url());
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { items: query === "workspace-empty" ? [] : resultItems("LOCAL", 4) },
      }),
    });
  });
  await context.route("**/api/d1/category-browse?**", (route) => {
    routeState.categoryRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") || 0);
    const items = resultItems("CATEGORY", 4);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items,
          offset,
          next_offset: offset + items.length,
          has_more: false,
        },
      }),
    });
  });
  await context.route("**/api/d1/browse?**", (route) => {
    routeState.d1Requests.push(route.request().url());
    const url = new URL(route.request().url());
    const kind = url.searchParams.get("kind") === "artist" ? "artist" : "name";
    const letter = url.searchParams.get("letter") || "";
    const tag = url.searchParams.get("tag") || "";
    const data = tag
      ? { kind, letter, tag, tags: [], items: resultItems(kind === "artist" ? "ARTIST" : "NAME", 4) }
      : {
        kind,
        letter,
        tag: "",
        tags: [{ tag: kind === "artist" ? "Artist A" : "Name A", locale: "", count: 4 }],
        items: [],
      };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data }),
    });
  });
  await context.route("**/api/gatcha/favlist/browse**", (route) => {
    routeState.favoriteRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const folderId = url.searchParams.get("folder_id") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          selected_folder_id: folderId,
          query: url.searchParams.get("q") || "",
          folders: [{ id: "7", title: "Browser favorites", media_count: 4 }],
          items: folderId ? resultItems("FAVORITE", 4) : [],
        },
      }),
    });
  });
  await context.route("**/api/gatcha/browse**", (route) => {
    routeState.uploaderRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const uid = url.searchParams.get("uid") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          selected_uid: uid,
          query: url.searchParams.get("q") || "",
          owners: [{ uid: "42", name: "Browser uploader", count: 4 }],
          items: uid ? resultItems("UPLOADER", 4) : [],
        },
      }),
    });
  });
  await context.route("**/api/gatcha/refresh", (route) => {
    routeState.refreshRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { started: false } }),
    });
  });
}

async function prepareRemotePage(page, baseUrl, routeState) {
  await page.goto(`${baseUrl}/remote`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (
    typeof activateRemoteRequestView === "function"
      && typeof activateRemoteDiscoverMode === "function"
      && typeof activateRemoteSourcesMode === "function"
      && state.translationsLoaded
  ));
  await page.evaluate(() => {
    closeEventStream();
    clearStateFallbackTimer();
    clearRemoteConnectionOfflineTimer();
    state.remoteIdentity = {
      registered: true,
      name: "Browser QA",
      sessionId: "browser-remote-session",
    };
    state.remoteIdentityChecking = false;
    state.remoteIdentitySaving = false;
    state.remoteIdentityError = "";
    state.data = {
      ...(state.data || {}),
      remote_session_id: "browser-remote-session",
      session_users: ["Browser QA"],
    };
    elements.remoteIdentityModal?.classList.add("hidden");
    document.body.classList.remove("remote-identity-modal-open");
    if (elements.remoteShell) elements.remoteShell.inert = false;
    renderRemoteIdentity();
    setLanguage("zh");
    applyTheme("light");
    activateRemoteRequestView("quick");
    document.activeElement?.blur?.();
  });
  await page.waitForFunction(() => (
    !document.querySelector("#remote-shell")?.inert
      && document.querySelector("#remote-identity-modal")?.classList.contains("hidden")
      && document.querySelector("#remote-identity-name")?.textContent?.trim() === "Browser QA"
  ));
  routeState.snapshot = await page.evaluate(() => ({
    ...(state.data || {}),
    state_revision: Math.max(1000, Number(state.data?.state_revision || 0) + 1),
    remote_session_id: "browser-remote-session",
    session_users: ["Browser QA"],
  }));
  await nextPaint(page);
}

async function requestWorkspaceMetrics(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const lineCount = (element) => {
      if (!element) return 0;
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    };
    const requestCard = document.querySelector(".request-panel");
    const heading = requestCard?.querySelector(".remote-request-head");
    const viewport = requestCard?.querySelector(".remote-request-tabs-viewport");
    const strip = viewport?.querySelector(".remote-request-tabs");
    const tabs = Array.from(strip?.querySelectorAll(".remote-request-tab") || []);
    const activePanel = requestCard?.querySelector('.remote-request-view:not([hidden])');
    const visualStyle = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        height: style.height,
      };
    };
    const visibleDescendant = (selector) => Array.from(activePanel?.querySelectorAll(selector) || [])
      .find((element) => element.getClientRects().length > 0);
    const quickActionRow = activePanel?.querySelector(".request-action-row");
    const quickPrimaryAction = quickActionRow?.querySelector(".primary-button");
    const quickNextAction = quickActionRow?.querySelector("#add-next-button");
    const verticalOwners = Array.from(requestCard?.querySelectorAll("div, section, form, article") || [])
      .filter((element) => {
        const style = getComputedStyle(element);
        return ["auto", "scroll"].includes(style.overflowY)
          && element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => ({
        id: element.id,
        className: String(element.className || ""),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentElement: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      body: {
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
        overflowY: getComputedStyle(document.body).overflowY,
      },
      scrollY,
      requestCard: rect(requestCard),
      requestCardOverflowY: getComputedStyle(requestCard).overflowY,
      requestCardMinHeight: getComputedStyle(requestCard).minHeight,
      heading: rect(heading),
      railViewport: rect(viewport),
      railStrip: rect(strip),
      railClientWidth: viewport?.clientWidth || 0,
      railScrollWidth: viewport?.scrollWidth || 0,
      railScrollLeft: viewport?.scrollLeft || 0,
      stripClientWidth: strip?.clientWidth || 0,
      stripScrollWidth: strip?.scrollWidth || 0,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        label: tab.textContent.trim(),
        selected: tab.getAttribute("aria-selected"),
        tabIndex: tab.tabIndex,
        bounds: rect(tab),
        lines: lineCount(tab),
        textFits: tab.scrollWidth <= tab.clientWidth + 1,
        ...visualStyle(tab),
      })),
      segmentedStyles: {
        topActive: visualStyle(strip?.querySelector('[aria-selected="true"]')),
        secondaryActive: visualStyle(activePanel?.querySelector('[role="tab"][aria-selected="true"]')),
        primaryButton: visualStyle(activePanel?.querySelector(".primary-button")),
      },
      formControls: {
        field: visualStyle(visibleDescendant("input, textarea, select")),
        primaryButton: visualStyle(visibleDescendant("form .primary-button")),
      },
      quickActions: quickActionRow ? {
        row: rect(quickActionRow),
        primary: rect(quickPrimaryAction),
        next: rect(quickNextAction),
        gap: rect(quickNextAction).left - rect(quickPrimaryAction).right,
        gridTemplateColumns: getComputedStyle(quickActionRow).gridTemplateColumns,
        horizontalOverflow: quickActionRow.scrollWidth > quickActionRow.clientWidth + 1,
      } : null,
      peerHeaderActions: [
        document.querySelector("#resort-playlist-button"),
        document.querySelector("#gatcha-pool-config-toggle"),
      ].map((element) => ({ id: element?.id || "", ...visualStyle(element) })),
      activePanelId: activePanel?.id || "",
      activePanel: rect(activePanel),
      panelStates: Array.from(requestCard?.querySelectorAll("[data-remote-request-panel]") || [])
        .map((panel) => ({
          id: panel.id,
          hidden: panel.hidden,
          inert: panel.inert,
          ariaHidden: panel.getAttribute("aria-hidden"),
        })),
      activeElement: document.activeElement?.id
        || document.activeElement?.dataset?.remoteRequestView
        || document.activeElement?.tagName
        || "",
      activeElementTag: document.activeElement?.tagName || "",
      verticalOwners,
      searchModalCount: document.querySelectorAll("#search-modal, .remote-search-modal").length,
      gatchaUidEntryCount: document.querySelectorAll("#gatcha-uid-toggle, #gatcha-uid-view").length,
      gatchaVisible: document.querySelector(".gatcha-panel")?.getBoundingClientRect().height > 0,
    };
  });
}

function assertWorkspaceGeometry(metrics, label, { requireNoRailOverflow = false } = {}) {
  assert(
    metrics.documentElement.scrollWidth <= metrics.documentElement.clientWidth + 1
      && metrics.body.scrollWidth <= metrics.body.clientWidth + 1,
    `${label}: document gained horizontal overflow`,
    metrics,
  );
  assert(metrics.tabs.length === 4, `${label}: top rail does not contain four stable tabs`, metrics.tabs);
  assert(
    metrics.tabs.every((tab) => tab.bounds.height >= 44 && tab.lines === 1 && tab.textFits),
    `${label}: tab touch target or unwrapped/unclipped label contract failed`,
    metrics.tabs,
  );
  assert(
    metrics.tabs.every((tab) => Math.abs(tab.bounds.top - metrics.tabs[0].bounds.top) <= 1),
    `${label}: top tabs wrapped out of one row`,
    metrics.tabs,
  );
  assert(
    metrics.heading.bottom <= metrics.railViewport.top + 1
      && metrics.railViewport.left >= metrics.requestCard.left - 1
      && metrics.railViewport.right <= metrics.requestCard.right + 1,
    `${label}: full-width rail is not below the heading and inside the card`,
    metrics,
  );
  assert(
    metrics.panelStates.filter((panel) => !panel.hidden && !panel.inert).length === 1
      && metrics.panelStates.filter((panel) => panel.hidden && panel.inert).length === 3,
    `${label}: top panel hidden/inert ownership is invalid`,
    metrics.panelStates,
  );
  assert(
    metrics.verticalOwners.length === 0
      && !["auto", "scroll"].includes(metrics.requestCardOverflowY),
    `${label}: Request card acquired an internal vertical scroller`,
    metrics.verticalOwners,
  );
  assert(metrics.searchModalCount === 0, `${label}: retired advanced modal is still present`, metrics);
  assert(metrics.gatchaUidEntryCount === 0, `${label}: retired Gatcha UID entry is still present`, metrics);
  if (requireNoRailOverflow) {
    assert(
      metrics.railScrollWidth <= metrics.railClientWidth + 1
        && metrics.stripScrollWidth <= metrics.stripClientWidth + 1,
      `${label}: four localized tabs require scrolling at 375px`,
      metrics,
    );
    const viewport = metrics.railViewport;
    assert(
      metrics.tabs.every((tab) => tab.bounds.left >= viewport.left - 1 && tab.bounds.right <= viewport.right + 1),
      `${label}: one or more top tabs are not simultaneously visible`,
      metrics.tabs,
    );
  }
  if (metrics.quickActions) {
    const actions = metrics.quickActions;
    assert(
      Math.abs(actions.primary.top - actions.next.top) <= 1
        && Math.abs(actions.primary.bottom - actions.next.bottom) <= 1
        && Math.abs(actions.primary.left - actions.row.left) <= 1
        && Math.abs(actions.next.right - actions.row.right) <= 1
        && actions.primary.width > actions.next.width
        && actions.gap >= 9 && actions.gap <= 11
        && actions.gridTemplateColumns.split(/\s+/).filter(Boolean).length === 2
        && !actions.horizontalOverflow,
      `${label}: Quick request actions are not one Host-style flexible-primary/minimum-secondary row`,
      actions,
    );
  }
}

async function bringRequestCardIntoView(page) {
  await page.locator(".request-panel").evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "auto" });
  });
  await nextPaint(page);
}

async function activateAndCapture(page, selector, screenshot, activePanelId) {
  await page.locator(selector).click();
  await page.waitForFunction((id) => {
    const panel = document.getElementById(id);
    return panel && !panel.hidden && !panel.inert;
  }, activePanelId);
  await bringRequestCardIntoView(page);
  await capture(page, screenshot);
  return requestWorkspaceMetrics(page);
}

async function requestFirstResult(page, containerSelector, routeState, label) {
  const row = page.locator(`${containerSelector} .search-result-item[data-url]`).first();
  const expectedUrl = await row.getAttribute("data-url");
  const before = routeState.addRequests.length;
  await row.click({ position: { x: 12, y: 12 } });
  await page.waitForFunction(() => document.querySelector(".request-panel > .song-detail-view:not(.hidden)"));
  try {
    await Promise.all([
      page.waitForResponse((candidate) => (
        new URL(candidate.url()).pathname === "/api/playlist/add"
      ), { timeout: 10000 }),
      page.locator(".request-panel > .song-detail-view [data-song-detail-request]").click(),
    ]);
  } catch (error) {
    error.detail = await page.evaluate(({ selector, url }) => ({
      selector,
      url,
      submitting: state.submitting,
      requester: selectedRequesterName(),
      activeView: state.remoteRequestView,
      discoverMode: state.remoteDiscoverMode,
      sourcesMode: state.remoteSourcesMode,
      detailOpen: searchDetailController?.isOpen?.(),
      rows: Array.from(document.querySelectorAll(`${selector} .search-result-item[data-url]`)).map((candidate) => ({
        url: candidate.dataset.url,
        connected: candidate.isConnected,
      })),
    }), { selector: containerSelector, url: expectedUrl });
    throw new Error(`${error.message}\n${label} diagnostics: ${JSON.stringify(error.detail)}`);
  }
  await page.waitForFunction(() => !state.submitting);
  await page.waitForFunction(() => document.querySelector(".request-panel > .song-detail-view")?.classList.contains("hidden"));
  assert(
    routeState.addRequests.length === before + 1
      && routeState.addRequests.at(-1)?.url === expectedUrl,
    `${label}: result request did not preserve its URL and request path`,
    { expectedUrl, requests: routeState.addRequests.slice(before) },
  );
}

async function runPrimaryGate(browser, baseUrl, screenshotPath) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    screen: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  const routeState = workspaceRouteState();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      routeState.apiRequests.push(request.url());
    }
  });
  await installWorkspaceRoutes(context, routeState);
  const paths = Object.fromEntries([
    "quick",
    "searchSharedEmpty",
    "searchSharedResults",
    "searchLocal",
    "categoriesHome",
    "categoriesDetail",
    "name",
    "artist",
    "uploaderList",
    "uploaderDetail",
    "favoritesList",
    "favoritesDetail",
    "railEnglish",
    "railEnglishDark",
    "railJapaneseBlue",
  ].map((name) => [name, suffixedPath(screenshotPath, `-remote-stage2-375-${name}`)]));

  try {
    await prepareRemotePage(page, baseUrl, routeState);
    await page.evaluate(() => {
      elements.urlInput.value = "BV1PRESERVEDQUICK";
      window.__stage2Nodes = {
        quick: elements.requestForm,
        sharedForm: elements.larkSearchForm,
        sharedResults: elements.larkSearchResults,
        localForm: elements.searchForm,
        localResults: elements.searchResults,
      };
    });
    await bringRequestCardIntoView(page);
    const states = {};
    states.quick = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.quick, "375 Quick", { requireNoRailOverflow: true });
    assert(states.quick.activePanelId === "remote-request-quick-panel", "Quick is not the initial view", states.quick);
    await capture(page, paths.quick);

    const beforeSearchSwitch = routeState.apiRequests.length;
    await page.locator("#remote-identity-rename").focus();
    states.searchSharedEmpty = await activateAndCapture(
      page,
      "#remote-request-search-tab",
      paths.searchSharedEmpty,
      "remote-request-search-panel",
    );
    assert(
      routeState.apiRequests.length === beforeSearchSwitch,
      "Quick to Search issued a network request",
      routeState.apiRequests.slice(beforeSearchSwitch),
    );
    assert(states.searchSharedEmpty.activeElementTag !== "INPUT", "Search tab activation auto-focused an input", states.searchSharedEmpty);
    assertWorkspaceGeometry(states.searchSharedEmpty, "375 Search / Shared empty", { requireNoRailOverflow: true });

    const sharedResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/lark/search"
    ));
    await page.locator("#lark-search-query").fill("workspace-results");
    await page.locator("#lark-search-form").evaluate((form) => form.requestSubmit());
    await sharedResponse;
    await page.waitForFunction(() => document.querySelectorAll("#lark-search-results .search-result-item").length === 5);
    await bringRequestCardIntoView(page);
    states.searchSharedResults = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.searchSharedResults, "375 Search / Shared results", { requireNoRailOverflow: true });
    await capture(page, paths.searchSharedResults);
    await requestFirstResult(page, "#lark-search-results", routeState, "Shared");

    const localSwitchCount = routeState.apiRequests.length;
    await page.locator("#remote-search-local-tab").click();
    await nextPaint(page);
    assert(routeState.apiRequests.length === localSwitchCount, "Shared to Local issued a network request");
    const localResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/gatcha/search"
    ));
    await page.locator("#search-query").fill("workspace-local");
    await page.locator("#search-form").evaluate((form) => form.requestSubmit());
    await localResponse;
    await page.waitForFunction(() => document.querySelectorAll("#search-results .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.searchLocal = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.searchLocal, "375 Search / Local", { requireNoRailOverflow: true });
    await capture(page, paths.searchLocal);
    await requestFirstResult(page, "#search-results", routeState, "Local");

    states.categoriesHome = await activateAndCapture(
      page,
      "#remote-request-discover-tab",
      paths.categoriesHome,
      "remote-request-discover-panel",
    );
    assertWorkspaceGeometry(states.categoriesHome, "375 Discover / Categories home", { requireNoRailOverflow: true });
    assert(await page.locator("#remote-discover-categories-panel .category-browser-card").count() > 0, "Categories home is empty");

    const categoryResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/d1/category-browse"
    ));
    await page.locator("#remote-discover-categories-panel .category-browser-card").first().click();
    await categoryResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-categories-panel .search-result-item").length === 4);
    const categorySearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/category-browse" && url.searchParams.get("q") === "workspace-category";
    });
    await page.locator("#remote-discover-categories-panel [data-category-browse-query]").fill("workspace-category");
    await page.locator("#remote-discover-categories-panel [data-category-browse-search]")
      .evaluate((form) => form.requestSubmit());
    await categorySearchResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-categories-panel .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.categoriesDetail = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.categoriesDetail, "375 Discover / Categories detail", { requireNoRailOverflow: true });
    await capture(page, paths.categoriesDetail);
    await requestFirstResult(page, "#remote-discover-categories-panel", routeState, "Categories");
    await page.locator("#remote-discover-categories-panel [data-category-browse-back]").click();
    await page.waitForFunction(() => (
      !document.querySelector("#remote-discover-categories-panel [data-category-browser-home]")?.classList.contains("hidden")
    ));

    await page.locator("#remote-discover-name-tab").click();
    const nameTagsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse" && url.searchParams.get("kind") === "name";
    });
    await page.locator('#remote-discover-name-panel [data-letter="A"]').click();
    await nameTagsResponse;
    const nameItemsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse" && url.searchParams.has("tag") && url.searchParams.get("kind") === "name";
    });
    await page.locator("#remote-discover-name-panel [data-tag]").first().click();
    await nameItemsResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-name-panel .search-result-item").length === 4);
    const nameSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse"
        && url.searchParams.get("kind") === "name"
        && url.searchParams.get("q") === "workspace-name";
    });
    await page.locator("#remote-discover-name-panel [data-d1-browse-query]").fill("workspace-name");
    await page.locator("#remote-discover-name-panel [data-d1-browse-search]").evaluate((form) => form.requestSubmit());
    await nameSearchResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-name-panel .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.name = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.name, "375 Discover / Name", { requireNoRailOverflow: true });
    await capture(page, paths.name);
    await requestFirstResult(page, "#remote-discover-name-panel", routeState, "Name");
    const nameBackResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse"
        && url.searchParams.get("kind") === "name"
        && !url.searchParams.has("tag");
    });
    await page.locator("#remote-discover-name-panel [data-d1-browse-back]").click();
    await nameBackResponse;
    await page.locator("#remote-discover-name-panel [data-d1-browse-back]").click();
    await page.waitForFunction(() => !document.querySelector("#remote-discover-name-panel [data-d1-browse-alphabet]")?.classList.contains("hidden"));

    await page.locator("#remote-discover-artist-tab").click();
    const artistTagsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse" && url.searchParams.get("kind") === "artist";
    });
    await page.locator('#remote-discover-artist-panel [data-letter="A"]').click();
    await artistTagsResponse;
    const artistItemsResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse" && url.searchParams.has("tag") && url.searchParams.get("kind") === "artist";
    });
    await page.locator("#remote-discover-artist-panel [data-tag]").first().click();
    await artistItemsResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-artist-panel .search-result-item").length === 4);
    const artistSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/d1/browse"
        && url.searchParams.get("kind") === "artist"
        && url.searchParams.get("q") === "workspace-artist";
    });
    await page.locator("#remote-discover-artist-panel [data-d1-browse-query]").fill("workspace-artist");
    await page.locator("#remote-discover-artist-panel [data-d1-browse-search]").evaluate((form) => form.requestSubmit());
    await artistSearchResponse;
    await page.waitForFunction(() => document.querySelectorAll("#remote-discover-artist-panel .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.artist = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.artist, "375 Discover / Artist", { requireNoRailOverflow: true });
    await capture(page, paths.artist);
    await requestFirstResult(page, "#remote-discover-artist-panel", routeState, "Artist");

    const uploaderListResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/gatcha/browse"
    ));
    await page.locator("#remote-request-sources-tab").click();
    await uploaderListResponse;
    await page.waitForFunction(() => document.querySelectorAll("#sources-follow-grid [data-uid]").length === 1);
    await bringRequestCardIntoView(page);
    states.uploaderList = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.uploaderList, "375 Sources / Uploader List", { requireNoRailOverflow: true });
    await capture(page, paths.uploaderList);
    const refreshRequestCount = routeState.refreshRequests.length;
    await page.locator("#refresh-gatcha-cache-button").click();
    await page.waitForFunction(() => !state.gatchaRefreshSaving);
    assert(
      routeState.refreshRequests.length === refreshRequestCount + 1,
      "Sources / Uploader List did not retain the cache refresh action",
      routeState.refreshRequests,
    );
    const refreshStatus = (await page.locator("#gatcha-uid-message").textContent() || "").trim();
    assert(Boolean(refreshStatus), "Sources cache refresh did not expose status feedback");

    const uploaderDetailResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/gatcha/browse" && url.searchParams.get("uid") === "42";
    });
    await page.locator("#sources-follow-grid [data-uid]").click();
    await uploaderDetailResponse;
    await page.waitForFunction(() => document.querySelectorAll("#sources-follow-results .search-result-item").length === 4);
    const uploaderSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/gatcha/browse" && url.searchParams.get("q") === "workspace-uploader";
    });
    await page.locator("#sources-follow-search-query").fill("workspace-uploader");
    await page.locator("#sources-follow-search-form").evaluate((form) => form.requestSubmit());
    await uploaderSearchResponse;
    await page.waitForFunction(() => document.querySelectorAll("#sources-follow-results .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.uploaderDetail = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.uploaderDetail, "375 Sources / selected uploader", { requireNoRailOverflow: true });
    await capture(page, paths.uploaderDetail);
    await requestFirstResult(page, "#sources-follow-results", routeState, "Uploader List");

    const uploaderRow = page.locator("#sources-follow-results .search-result-item").first();
    await uploaderRow.click({ position: { x: 12, y: 12 } });
    await page.waitForFunction(() => document.querySelector(".request-panel > .song-detail-view:not(.hidden)"));
    await page.evaluate(() => {
      state.sourcesFollowBrowseRenderSignature = "";
      renderSourcesFollowBrowse();
    });
    await page.locator(".request-panel > .song-detail-view .song-detail-close").click();
    await page.waitForFunction(() => document.querySelector(".request-panel > .song-detail-view")?.classList.contains("hidden"));
    const restoredFocus = await page.evaluate(() => ({
      owner: document.activeElement?.dataset?.requestResultOwner || "",
      id: document.activeElement?.id || "",
      className: String(document.activeElement?.className || ""),
      key: document.activeElement?.dataset?.requestResultKey || "",
      selectedKey: state.requestDetailSelections.uids.selectedKey,
      rows: Array.from(document.querySelectorAll("#sources-follow-results .search-result-item"))
        .map((row) => ({ owner: row.dataset.requestResultOwner, key: row.dataset.requestResultKey })),
    }));
    assert(restoredFocus.owner === "uids", "Detached uploader detail opener did not recover focus in its owner", restoredFocus);
    await page.locator("#sources-follow-back").click();
    await page.waitForFunction(() => !document.querySelector("#sources-follow-list-view")?.classList.contains("hidden"));

    const favoritesListResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/gatcha/favlist/browse"
    ));
    await page.locator("#remote-sources-favorites-tab").click();
    await favoritesListResponse;
    await page.waitForFunction(() => document.querySelectorAll("#favlist-grid [data-folder-id]").length === 1);
    await bringRequestCardIntoView(page);
    states.favoritesList = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.favoritesList, "375 Sources / Favorites", { requireNoRailOverflow: true });
    await capture(page, paths.favoritesList);

    const favoritesDetailResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/gatcha/favlist/browse" && url.searchParams.get("folder_id") === "7";
    });
    await page.locator("#favlist-grid [data-folder-id]").click();
    await favoritesDetailResponse;
    await page.waitForFunction(() => document.querySelectorAll("#favlist-song-results .search-result-item").length === 4);
    const favoriteSearchResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/gatcha/favlist/browse" && url.searchParams.get("q") === "workspace-favorites";
    });
    await page.locator("#favlist-search-query").fill("workspace-favorites");
    await page.locator("#favlist-search-form").evaluate((form) => form.requestSubmit());
    await favoriteSearchResponse;
    await page.waitForFunction(() => document.querySelectorAll("#favlist-song-results .search-result-item").length === 4);
    await bringRequestCardIntoView(page);
    states.favoritesDetail = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(states.favoritesDetail, "375 Sources / selected folder", { requireNoRailOverflow: true });
    await capture(page, paths.favoritesDetail);
    await requestFirstResult(page, "#favlist-song-results", routeState, "Favorites");
    await page.locator("#favlist-browse-back").click();
    await page.waitForFunction(() => !document.querySelector("#favlist-list-view")?.classList.contains("hidden"));

    const retainedNodes = await page.evaluate(() => ({
      quick: window.__stage2Nodes.quick === elements.requestForm,
      sharedForm: window.__stage2Nodes.sharedForm === elements.larkSearchForm,
      sharedResults: window.__stage2Nodes.sharedResults === elements.larkSearchResults,
      localForm: window.__stage2Nodes.localForm === elements.searchForm,
      localResults: window.__stage2Nodes.localResults === elements.searchResults,
      quickValue: elements.urlInput.value,
      sharedValue: elements.larkSearchQuery.value,
      localValue: elements.searchQuery.value,
      sharedRows: elements.larkSearchResults.children.length,
      localRows: elements.searchResults.children.length,
    }));
    assert(
      Object.values(retainedNodes).slice(0, 5).every(Boolean)
        && retainedNodes.quickValue === "BV1PRESERVEDQUICK"
        && retainedNodes.sharedValue === "workspace-results"
        && retainedNodes.localValue === "workspace-local"
        && retainedNodes.sharedRows === 5
        && retainedNodes.localRows === 4,
      "Switching views remounted or cleared Quick/Search owners",
      retainedNodes,
    );

    const pureSwitchBefore = routeState.apiRequests.length;
    await page.evaluate(() => {
      activateRemoteRequestView("quick");
      activateRemoteRequestView("search");
      activateRemoteSearchMode("shared");
      activateRemoteSearchMode("local");
      activateRemoteRequestView("discover");
      activateRemoteDiscoverMode("categories");
      activateRemoteDiscoverMode("name");
      activateRemoteDiscoverMode("artist");
      activateRemoteRequestView("sources");
      activateRemoteSourcesMode("uids");
      activateRemoteSourcesMode("favorites");
    });
    await nextPaint(page);
    assert(
      routeState.apiRequests.length === pureSwitchBefore,
      "Pure changes among loaded tabs issued a request",
      routeState.apiRequests.slice(pureSwitchBefore),
    );

    const selectedBeforeLanguage = await page.evaluate(() => ({
      top: state.remoteRequestView,
      search: state.remoteSearchMode,
      discover: state.remoteDiscoverMode,
      sources: state.remoteSourcesMode,
    }));
    const languageMetrics = {};
    for (const language of ["zh", "en", "ja"]) {
      await page.evaluate((value) => setLanguage(value), language);
      await waitForThemeControlsSettled(page);
      await bringRequestCardIntoView(page);
      languageMetrics[language] = await requestWorkspaceMetrics(page);
      assertWorkspaceGeometry(languageMetrics[language], `375 ${language} rail`, { requireNoRailOverflow: true });
      if (language === "en") await capture(page, paths.railEnglish);
    }
    assert(
      Object.values(languageMetrics).every((metrics) => (
        metrics.tabs.every((tab) => tab.fontSize === "16px")
      )),
      "Segmented labels are not aligned with the 16px form-control type scale",
      languageMetrics,
    );
    assert(
      Object.values(languageMetrics).every((metrics) => (
        segmentedControlsUseDistinctSelection(metrics.segmentedStyles)
      )),
      "Light segmented controls are not visually distinct from action buttons",
      languageMetrics,
    );

    const formControlStates = [
      states.searchSharedEmpty,
      states.searchSharedResults,
      states.searchLocal,
      states.categoriesDetail,
      states.name,
      states.artist,
      states.uploaderList,
      states.uploaderDetail,
      states.favoritesList,
      states.favoritesDetail,
    ];
    assert(
      formControlStates.every(({ formControls }) => (
        formControls.field?.height === "48px"
          && formControls.field?.fontSize === "16px"
          && formControls.field?.borderRadius === "16px"
          && formControls.primaryButton?.height === "48px"
          && formControls.primaryButton?.fontSize === "16px"
          && formControls.primaryButton?.borderRadius === "16px"
      )),
      "Request form controls do not share 48px / 16px / 16px geometry",
      formControlStates.map(({ activePanelId, formControls }) => ({ activePanelId, formControls })),
    );
    assert(
      states.quick.peerHeaderActions.every((action) => (
        action.height === "44px"
          && action.fontSize === "16px"
          && action.borderRadius === "14px"
      )),
      "Peer card-heading actions do not share 44px / 16px / 14px geometry",
      states.quick.peerHeaderActions,
    );
    assert(
      states.quick.peerHeaderActions.every((action) => (
        action.borderStyle === "none" && action.borderWidth === "0px"
      )),
      "Light peer card-heading actions should match Host's borderless secondary buttons",
      states.quick.peerHeaderActions,
    );
    await page.evaluate(() => {
      setLanguage("en");
      applyTheme("dark");
    });
    await waitForThemeControlsSettled(page);
    languageMetrics.enDark = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(languageMetrics.enDark, "375 English dark rail", { requireNoRailOverflow: true });
    assert(
      segmentedControlsUseDistinctSelection(languageMetrics.enDark.segmentedStyles),
      "Dark segmented controls are not visually distinct from action buttons",
      languageMetrics.enDark.segmentedStyles,
    );
    assert(
      peerHeaderActionsShareTheme(languageMetrics.enDark.peerHeaderActions),
      "Dark peer card-heading actions do not share the theme's secondary colors",
      languageMetrics.enDark.peerHeaderActions,
    );
    assert(
      languageMetrics.enDark.peerHeaderActions.every((action) => (
        action.borderStyle === "solid" && action.borderWidth === "1px"
      )),
      "Dark peer card-heading actions should match Host's low-contrast 1px border",
      languageMetrics.enDark.peerHeaderActions,
    );
    await capture(page, paths.railEnglishDark);
    await page.evaluate(() => {
      setLanguage("ja");
      applyTheme("blue");
    });
    await waitForThemeControlsSettled(page);
    languageMetrics.jaBlue = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(languageMetrics.jaBlue, "375 Japanese blue rail", { requireNoRailOverflow: true });
    assert(
      segmentedControlsUseDistinctSelection(languageMetrics.jaBlue.segmentedStyles),
      "Blue segmented controls are not visually distinct from action buttons",
      languageMetrics.jaBlue.segmentedStyles,
    );
    assert(
      peerHeaderActionsShareTheme(languageMetrics.jaBlue.peerHeaderActions),
      "Blue peer card-heading actions do not share the theme's secondary colors",
      languageMetrics.jaBlue.peerHeaderActions,
    );
    assert(
      languageMetrics.jaBlue.peerHeaderActions.every((action) => (
        action.borderStyle === "solid" && action.borderWidth === "1px"
      )),
      "Blue peer card-heading actions should match Host's low-contrast 1px border",
      languageMetrics.jaBlue.peerHeaderActions,
    );
    await capture(page, paths.railJapaneseBlue);
    const selectedAfterLanguage = await page.evaluate(() => ({
      top: state.remoteRequestView,
      search: state.remoteSearchMode,
      discover: state.remoteDiscoverMode,
      sources: state.remoteSourcesMode,
    }));
    assert(
      JSON.stringify(selectedBeforeLanguage) === JSON.stringify(selectedAfterLanguage),
      "Language/theme changes reset tab state",
      { selectedBeforeLanguage, selectedAfterLanguage },
    );

    await page.evaluate(() => {
      setLanguage("zh");
      applyTheme("light");
      document.querySelector(".request-panel")?.scrollIntoView({ block: "start", behavior: "auto" });
    });
    const scrollBeforeCompact = await page.evaluate(() => scrollY);
    await page.evaluate(() => activateRemoteRequestView("quick"));
    await nextPaint(page);
    const compactMetrics = await requestWorkspaceMetrics(page);
    assert(
      Math.abs(compactMetrics.scrollY - scrollBeforeCompact) <= 1,
      "Switching to Quick programmatically scrolled the document",
      { scrollBeforeCompact, after: compactMetrics.scrollY },
    );
    assert(
      compactMetrics.requestCard.height < states.favoritesDetail.requestCard.height,
      "Request card did not shrink naturally after leaving a result view",
      { quick: compactMetrics.requestCard.height, results: states.favoritesDetail.requestCard.height },
    );
    assert(compactMetrics.gatchaVisible, "Gatcha is no longer a separate visible card");
    assert(routeState.addRequests.length === 7, "Not every retained result owner requested successfully", routeState.addRequests);
    assert(consoleErrors.length === 0, "375 workspace produced console errors", consoleErrors);
    assert(pageErrors.length === 0, "375 workspace produced page errors", pageErrors);

    return {
      viewport: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      states,
      compactMetrics,
      languageMetrics,
      retainedNodes,
      focus: { detachedUploaderReturn: restoredFocus },
      network: {
        totalApiRequests: routeState.apiRequests.length,
        pureSwitchDelta: routeState.apiRequests.length - pureSwitchBefore,
        sharedSearchCount: routeState.sharedSearchRequests.length,
        localSearchCount: routeState.localSearchRequests.length,
        categoryCount: routeState.categoryRequests.length,
        d1Count: routeState.d1Requests.length,
        uploaderCount: routeState.uploaderRequests.length,
        favoriteCount: routeState.favoriteRequests.length,
        refreshCount: routeState.refreshRequests.length,
        addCount: routeState.addRequests.length,
      },
      screenshots: paths,
      consoleErrors,
      pageErrors,
    };
  } finally {
    if (!page.isClosed()) await page.close({ runBeforeUnload: false });
    await context.close();
  }
}

async function runSecondaryViewport(browser, baseUrl, screenshotPath, scenario) {
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: scenario.height },
    screen: { width: scenario.width, height: scenario.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const routeState = workspaceRouteState();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installWorkspaceRoutes(context, routeState);
  try {
    await prepareRemotePage(page, baseUrl, routeState);
    await page.evaluate(({ language, theme, textScale }) => {
      state.followBrowseData = { owners: [], items: [], selected_uid: "" };
      state.favlistBrowseData = { folders: [], items: [], selected_folder_id: "" };
      state.sourcesFollowBrowseRenderSignature = "";
      state.favlistBrowseRenderSignature = "";
      setLanguage(language);
      applyTheme(theme);
      if (textScale > 1) {
        const style = document.createElement("style");
        style.id = "remote-stage2-text-scale";
        style.textContent = `.remote-request-tab { font-size: ${16 * textScale}px !important; }`;
        document.head.appendChild(style);
      }
      activateRemoteRequestView("sources");
      activateRemoteSourcesMode("favorites");
    }, scenario);
    await page.waitForFunction(() => {
      const viewport = document.querySelector(".remote-request-tabs-viewport")?.getBoundingClientRect();
      const tab = document.getElementById("remote-request-sources-tab")?.getBoundingClientRect();
      return viewport && tab && tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1;
    });
    await waitForThemeControlsSettled(page);
    await bringRequestCardIntoView(page);
    const metrics = await requestWorkspaceMetrics(page);
    assertWorkspaceGeometry(metrics, `${scenario.width}x${scenario.height} ${scenario.name}`);
    assert(
      metrics.tabs[3].bounds.left >= metrics.railViewport.left - 1
        && metrics.tabs[3].bounds.right <= metrics.railViewport.right + 1,
      `${scenario.name}: final tab was not fully revealed`,
      metrics,
    );
    if (scenario.textScale > 1) {
      assert(
        metrics.railScrollWidth > metrics.railClientWidth + 1 && metrics.railScrollLeft > 0,
        "200% text stress did not use the native horizontal rail",
        metrics,
      );
    }
    assert(metrics.activeElementTag !== "INPUT", `${scenario.name}: activation auto-focused an input`, metrics);
    const path = suffixedPath(
      screenshotPath,
      `-remote-stage2-${scenario.width}x${scenario.height}-${scenario.name}`,
    );
    await capture(page, path);
    assert(consoleErrors.length === 0, `${scenario.name}: console errors`, consoleErrors);
    assert(pageErrors.length === 0, `${scenario.name}: page errors`, pageErrors);
    return { ...scenario, metrics, screenshot: path, consoleErrors, pageErrors };
  } finally {
    if (!page.isClosed()) await page.close({ runBeforeUnload: false });
    await context.close();
  }
}

async function runRemoteRequestWorkspaceGate(browser, baseUrl, screenshotPath) {
  const primary = await runPrimaryGate(browser, baseUrl, screenshotPath);
  const scenarios = [
    { name: "ja-overflow", width: 320, height: 640, language: "ja", theme: "light", textScale: 1 },
    { name: "en-dark", width: 390, height: 844, language: "en", theme: "dark", textScale: 1 },
    { name: "zh-blue", width: 430, height: 932, language: "zh", theme: "blue", textScale: 1 },
    { name: "en-wide", width: 720, height: 900, language: "en", theme: "light", textScale: 1 },
    { name: "en-200pct", width: 375, height: 812, language: "en", theme: "light", textScale: 2 },
  ];
  const secondary = [];
  for (const scenario of scenarios) {
    secondary.push(await runSecondaryViewport(browser, baseUrl, screenshotPath, scenario));
  }
  return { passed: true, primary, secondary };
}

module.exports = { runRemoteRequestWorkspaceGate };
