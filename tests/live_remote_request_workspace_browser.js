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
    title: `${prefix} mobile result ${index + 1}`,
    url: `https://www.bilibili.com/video/BV${prefix}${String(index).padStart(2, "0")}`,
    owner_name: `${prefix} owner`,
    played_count: 12800 + index,
    rank: 4.6,
  }));
}

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function capture(page, path, { fullPage = false } = {}) {
  if (!path) {
    return;
  }
  await page.screenshot({ path, fullPage });
}

async function waitForVisualAnimations(page, selector) {
  await page.locator(selector).evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true });
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
  });
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
    const currentRevision = Number(routeState.snapshot?.state_revision || 0);
    routeState.snapshot = {
      ...(routeState.snapshot || {}),
      state_revision: currentRevision + 1,
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
        data: { items: query === "workspace-empty" ? [] : resultItems("SHARED", 12) },
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
        data: { items: query === "workspace-empty" ? [] : resultItems("LOCAL", 10) },
      }),
    });
  });
  await context.route("**/api/gatcha/browse**", (route) => {
    routeState.advancedRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          selected_uid: "",
          owners: [{ uid: "42", name: "Browser followed uploader", count: 3 }],
          items: [],
        },
      }),
    });
  });
  await context.route("**/api/gatcha/favlist/browse**", (route) => {
    routeState.advancedRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          selected_folder_id: "",
          folders: [{ id: "7", title: "Browser favorites", media_count: 2 }],
          items: [],
        },
      }),
    });
  });
}

async function stabilizeRemotePage(page, routeState) {
  await page.waitForFunction(() => (
    typeof activateRemoteRequestView === "function"
      && typeof activateRemoteSearchMode === "function"
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
    state.remoteIdentityModalMode = "register";
    state.remoteIdentityError = "";
    state.data = {
      ...(state.data || {}),
      remote_session_id: "browser-remote-session",
      session_users: ["Browser QA"],
    };
    elements.remoteIdentityModal?.classList.add("hidden");
    document.body.classList.remove("remote-identity-modal-open");
    if (elements.remoteShell) {
      elements.remoteShell.inert = false;
    }
    renderRemoteIdentity();
    setLanguage("zh");
    applyTheme("light");
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

async function prepareRemotePage(page, baseUrl, routeState) {
  await page.goto(`${baseUrl}/remote`, { waitUntil: "domcontentloaded" });
  await stabilizeRemotePage(page, routeState);
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
    const byId = (id) => document.getElementById(id);
    const textLineCount = (element) => {
      const textNode = Array.from(element?.childNodes || [])
        .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!textNode) return 0;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      return range.getClientRects().length;
    };
    const styleSnapshot = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        backgroundClip: style.backgroundClip,
        boxShadow: style.boxShadow,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        marginTop: style.marginTop,
        gap: style.gap,
        padding: style.padding,
      };
    };
    const requestCard = document.querySelector(".request-panel");
    const requestHead = requestCard?.querySelector(".remote-request-head");
    const requestHeading = requestHead?.firstElementChild;
    const activePanel = requestCard?.querySelector('.remote-request-view:not([hidden])');
    const structuralVerticalOwners = Array.from(requestCard?.querySelectorAll("div, section, form, article") || [])
      .filter((element) => {
        const style = getComputedStyle(element);
        return ["auto", "scroll"].includes(style.overflowY)
          && element.scrollHeight > element.clientHeight + 1;
      })
      .map((element) => ({
        id: element.id || "",
        className: String(element.className || ""),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
    const formControlIds = [
      "remote-identity-name",
      "remote-identity-rename",
      "url-input",
      "add-next-button",
      "lark-search-query",
      "lark-search-button",
      "search-query",
      "search-button",
    ];
    const formControls = Object.fromEntries(formControlIds.map((id) => [id, rect(byId(id))]));
    const modeTabs = document.querySelector(".remote-search-mode-tabs");
    const shellBox = rect(byId("remote-shell"));
    const cardBox = rect(requestCard);
    const viewportWidth = document.documentElement.clientWidth;
    return {
      documentElement: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      body: {
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
        clientHeight: document.body.clientHeight,
        scrollHeight: document.body.scrollHeight,
      },
      viewportWidth,
      scrollY: window.scrollY,
      activeElement: document.activeElement?.id || document.activeElement?.tagName || "",
      shell: shellBox,
      shellGutters: shellBox ? {
        left: shellBox.left,
        right: viewportWidth - shellBox.right,
      } : null,
      requestCard: cardBox,
      requestCardOverflowY: requestCard ? getComputedStyle(requestCard).overflowY : "",
      requestHead: rect(requestHead),
      requestHeading: rect(requestHeading),
      requestHeadingStyles: {
        tag: styleSnapshot(requestHeading?.querySelector(".panel-tag")),
        title: styleSnapshot(requestHeading?.querySelector(".panel-title")),
      },
      activePanel: rect(activePanel),
      activePanelId: activePanel?.id || "",
      topTabList: rect(document.querySelector(".remote-request-tabs")),
      topTabs: {
        quick: rect(byId("remote-request-quick-tab")),
        search: rect(byId("remote-request-search-tab")),
      },
      topTabLabels: [
        byId("remote-request-quick-tab")?.textContent?.trim() || "",
        byId("remote-request-search-tab")?.textContent?.trim() || "",
      ],
      topTabLineCounts: [
        textLineCount(byId("remote-request-quick-tab")),
        textLineCount(byId("remote-request-search-tab")),
      ],
      searchToolbar: rect(document.querySelector(".remote-search-toolbar")),
      searchModeTabs: rect(modeTabs),
      searchControls: {
        shared: rect(byId("remote-search-shared-tab")),
        local: rect(byId("remote-search-local-tab")),
        moreBrowse: rect(byId("search-library-open")),
      },
      searchControlTextFits: [
        byId("remote-search-shared-tab"),
        byId("remote-search-local-tab"),
        byId("search-library-open"),
      ].every((element) => !element || element.scrollWidth <= element.clientWidth + 1),
      queueTabList: rect(document.querySelector(".view-toggle")),
      queueTabs: {
        queue: rect(byId("queue-view-button")),
        history: rect(byId("history-view-button")),
      },
      sharedResults: rect(byId("lark-search-results")),
      localResults: rect(byId("search-results")),
      formControls,
      inlineFormMessagePresent: Boolean(byId("form-message")),
      styles: {
        menuTrigger: styleSnapshot(byId("remote-menu-toggle")),
        topRail: styleSnapshot(document.querySelector(".remote-request-tabs")),
        searchRail: styleSnapshot(modeTabs),
        queueRail: styleSnapshot(document.querySelector(".view-toggle")),
        topSelected: styleSnapshot(document.querySelector('.remote-request-tab[aria-selected="true"]')),
        searchSelected: styleSnapshot(document.querySelector('.remote-search-mode-tab[aria-selected="true"]')),
        queueSelected: styleSnapshot(document.querySelector(".toggle-button.active")),
        moreBrowse: styleSnapshot(byId("search-library-open")),
        secondaryButton: styleSnapshot(byId("remote-identity-rename")),
        sharedSubmit: styleSnapshot(byId("lark-search-button")),
        sharedResultRequest: styleSnapshot(document.querySelector("#lark-search-results .primary-button")),
      },
      structuralVerticalOwners,
      modal: rect(document.querySelector("#search-modal .remote-search-modal-card")),
      modalHidden: byId("search-modal")?.classList.contains("hidden") ?? true,
    };
  });
}

async function appearanceMenuMetrics(page) {
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
    const settingsContent = document.getElementById("remote-settings-content");
    const menuTrigger = document.getElementById("remote-menu-toggle");
    const menuTriggerStyle = menuTrigger ? getComputedStyle(menuTrigger) : null;
    const rows = Array.from(settingsContent?.querySelectorAll(".remote-menu-setting-row") || []);
    const sectionToggles = Array.from(document.querySelectorAll(".remote-menu-section-toggle"));
    return {
      trigger: menuTriggerStyle ? {
        borderColor: menuTriggerStyle.borderColor,
        borderWidth: menuTriggerStyle.borderWidth,
        outlineStyle: menuTriggerStyle.outlineStyle,
      } : null,
      menu: rect(document.getElementById("remote-menu-panel")),
      settings: rect(settingsContent),
      sections: sectionToggles.map((toggle) => {
        const toggleStyle = getComputedStyle(toggle);
        const title = toggle.querySelector(".remote-menu-section-title");
        const titleStyle = title ? getComputedStyle(title) : null;
        return {
          id: toggle.id,
          expanded: toggle.getAttribute("aria-expanded"),
          backgroundColor: toggleStyle.backgroundColor,
          titleFontSize: titleStyle?.fontSize || "",
          titleColor: titleStyle?.color || "",
        };
      }),
      rows: rows.map((row) => ({
        label: row.querySelector(".remote-menu-setting-label")?.textContent?.trim() || "",
        labelStyle: (() => {
          const label = row.querySelector(".remote-menu-setting-label");
          const style = label ? getComputedStyle(label) : null;
          return style ? {
            color: style.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            letterSpacing: style.letterSpacing,
            textTransform: style.textTransform,
          } : null;
        })(),
        controls: Array.from(row.querySelectorAll("button")).map((button) => (
          button.dataset.language || button.dataset.theme || button.id || "info"
        )),
      })),
      layoutDomCount: document.querySelectorAll("#layout-mode-switch, [data-layout-mode]").length,
      layoutFocusableCount: Array.from(document.querySelectorAll("button, [tabindex]"))
        .filter((element) => (
          element.id === "layout-mode-switch"
            || element.hasAttribute("data-layout-mode")
            || element.closest("#layout-mode-switch")
        ) && !element.hidden && element.tabIndex >= 0).length,
    };
  });
}

async function retiredLayoutPreferenceEvidence(page) {
  return page.evaluate(() => ({
    storedValue: localStorage.getItem("bilikara.remote.layout.mode"),
    storageWrites: [...(window.__retiredLayoutStorageWrites || [])],
    layoutDomCount: document.querySelectorAll("#layout-mode-switch, [data-layout-mode]").length,
    layoutClassPresent: document.getElementById("remote-shell")?.classList.contains("layout-mode-basic")
      || document.getElementById("remote-shell")?.classList.contains("layout-mode-full"),
    stateHasLayoutMode: Object.prototype.hasOwnProperty.call(state, "layoutMode"),
    elementsHasLayoutModeSwitch: Object.prototype.hasOwnProperty.call(elements, "layoutModeSwitch"),
    storageKeysHasLayoutMode: Object.prototype.hasOwnProperty.call(storageKeys, "layoutMode"),
    searchTabVisible: !document.getElementById("remote-request-search-tab")?.hidden
      && getComputedStyle(document.getElementById("remote-request-search-tab")).display !== "none",
    gatchaVisible: getComputedStyle(document.querySelector(".gatcha-panel")).display !== "none",
  }));
}

async function measureTitleRowFeasibility(page) {
  return page.evaluate(() => {
    const originalLanguage = state.language;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const result = {};
    const number = (value) => Number.parseFloat(value) || 0;
    const measureRail = (buttons, { fontSize, paddingInline, gap, railPadding }) => {
      const buttonStyle = getComputedStyle(buttons[0]);
      context.font = `${buttonStyle.fontWeight} ${fontSize}px ${buttonStyle.fontFamily}`;
      const buttonWidths = buttons.map((button) => Math.max(
        44,
        Math.ceil(context.measureText(button.textContent.trim()).width) + (paddingInline * 2),
      ));
      return {
        buttonWidths,
        width: buttonWidths.reduce((sum, width) => sum + width, 0)
          + gap
          + (railPadding * 2),
      };
    };

    for (const language of ["zh", "en", "ja"]) {
      setLanguage(language);
      const card = document.querySelector(".request-panel");
      const rail = document.querySelector(".remote-request-tabs");
      const buttons = Array.from(rail.querySelectorAll(".remote-request-tab"));
      const railStyle = getComputedStyle(rail);
      const buttonStyle = getComputedStyle(buttons[0]);
      const heading = card.querySelector(".panel-head > div");
      const textWidth = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().width;
      };
      const headingWidth = Math.ceil(Math.max(
        ...Array.from(heading.children).map(textWidth),
      ));
      const requestHead = card.querySelector(".remote-request-head");
      const availableWidth = requestHead.getBoundingClientRect().width;
      const headingGap = number(getComputedStyle(requestHead).gap);
      const current = measureRail(buttons, {
        fontSize: number(buttonStyle.fontSize),
        paddingInline: number(buttonStyle.paddingLeft),
        gap: number(railStyle.columnGap),
        railPadding: number(railStyle.paddingLeft),
      });
      const compact = measureRail(buttons, {
        fontSize: 14,
        paddingInline: 8,
        gap: 4,
        railPadding: 4,
      });
      for (const candidate of [current, compact]) {
        candidate.requiredWidth = headingWidth + headingGap + candidate.width;
        candidate.slack = availableWidth - candidate.requiredWidth;
        candidate.opticalGap = headingGap + candidate.slack;
        candidate.comfortable = candidate.opticalGap >= 12;
      }
      result[language] = {
        labels: buttons.map((button) => button.textContent.trim()),
        availableWidth,
        headingWidth,
        headingGap,
        current,
        compact,
      };
    }
    setLanguage(originalLanguage);
    return result;
  });
}

async function collectThemeButtonEvidence(page, theme) {
  await page.evaluate((nextTheme) => applyTheme(nextTheme), theme);
  await waitForVisualAnimations(page, "#remote-shell");
  return page.evaluate(() => {
    const colors = (element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
      };
    };
    return {
      primarySearch: colors(document.getElementById("lark-search-button")),
      primaryResult: colors(document.querySelector("#lark-search-results .primary-button")),
      moreBrowse: colors(document.getElementById("search-library-open")),
      secondary: colors(document.getElementById("remote-identity-rename")),
      requestSelected: colors(document.querySelector('.remote-request-tab[aria-selected="true"]')),
      searchSelected: colors(document.querySelector('.remote-search-mode-tab[aria-selected="true"]')),
      queueSelected: colors(document.querySelector(".toggle-button.active")),
    };
  });
}

function rectInside(inner, outer, tolerance = 1) {
  return Boolean(inner && outer
    && inner.left >= outer.left - tolerance
    && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance
    && inner.bottom <= outer.bottom + tolerance);
}

function rectanglesOverlap(first, second, tolerance = 1) {
  if (!first || !second) return false;
  return first.left < second.right - tolerance
    && first.right > second.left + tolerance
    && first.top < second.bottom - tolerance
    && first.bottom > second.top + tolerance;
}

function assertHorizontalFit(metrics, label) {
  assert(
    metrics.documentElement.scrollWidth <= metrics.documentElement.clientWidth + 1,
    `${label}: documentElement has horizontal overflow`,
    metrics,
  );
  assert(
    metrics.body.scrollWidth <= metrics.body.clientWidth + 1,
    `${label}: body has horizontal overflow`,
    metrics,
  );
  assert(
    metrics.shell && metrics.shell.left >= -1 && metrics.shell.right <= metrics.viewportWidth + 1,
    `${label}: Remote shell escaped the viewport`,
    metrics,
  );
  assert(
    metrics.requestCard && metrics.requestCard.left >= -1
      && metrics.requestCard.right <= metrics.viewportWidth + 1,
    `${label}: request card escaped the viewport`,
    metrics,
  );
}

function assertPrimaryTabGeometry(metrics, label) {
  const { quick, search } = metrics.topTabs;
  assert(
    quick && search && quick.height >= 44 && search.height >= 44,
    `${label}: top-level tabs are below the 44px touch target`,
    metrics.topTabs,
  );
  assert(
    Math.abs(quick.top - search.top) <= 1 && Math.abs(quick.bottom - search.bottom) <= 1,
    `${label}: top-level tabs did not stay on one row`,
    metrics.topTabs,
  );
  assert(
    metrics.topTabLineCounts.every((count) => count === 1),
    `${label}: a top-level tab label wrapped onto multiple lines`,
    { labels: metrics.topTabLabels, lineCounts: metrics.topTabLineCounts },
  );
}

function assertRequestTitleRow(metrics, label) {
  assert(
    metrics.requestHead && metrics.requestHeading && metrics.topTabList
      && rectInside(metrics.requestHeading, metrics.requestHead)
      && rectInside(metrics.topTabList, metrics.requestHead),
    `${label}: title or request tabs escaped the request-card heading`,
    metrics,
  );
  assert(
    !rectanglesOverlap(metrics.requestHeading, metrics.topTabList)
      && Math.abs(metrics.requestHeading.bottom - metrics.topTabList.bottom) <= 1,
    `${label}: title and request tabs do not share a clean title row`,
    metrics,
  );
  assert(
    Math.abs(metrics.requestHead.height - 48) <= 1
      && Math.abs(metrics.topTabList.height - 48) <= 1
      && metrics.requestHead.height - metrics.requestHeading.height <= 3,
    `${label}: compact tabs changed the title row height instead of fitting it`,
    {
      requestHead: metrics.requestHead,
      requestHeading: metrics.requestHeading,
      topTabList: metrics.topTabList,
      requestHeadingStyles: metrics.requestHeadingStyles,
    },
  );
}

function assertSegmentedControlHeight(metrics, label, activeSearchControlIds = []) {
  const railStyles = [metrics.styles.topRail, metrics.styles.searchRail, metrics.styles.queueRail];
  const segmentedTabs = [
    metrics.topTabs.quick,
    metrics.topTabs.search,
    metrics.queueTabs.queue,
    metrics.queueTabs.history,
  ];
  const selectedTabStyles = [
    metrics.styles.topSelected,
    metrics.styles.searchSelected,
    metrics.styles.queueSelected,
  ];
  assert(
    Math.abs(metrics.topTabList.height - 48) <= 1
      && Math.abs(metrics.queueTabList.height - 48) <= 1
      && railStyles.every((style) => style?.padding === "0px 4px")
      && segmentedTabs.every((tab) => tab && Math.abs(tab.height - 48) <= 1),
    `${label}: segmented controls do not share the 48px rail / 48px hit target template`,
    {
      topTabList: metrics.topTabList,
      topTabs: metrics.topTabs,
      queueTabList: metrics.queueTabList,
      queueTabs: metrics.queueTabs,
      railStyles,
    },
  );
  assert(
    selectedTabStyles.every((style) => (
      style?.borderTopWidth === "4px"
        && style?.borderBottomWidth === "4px"
        && style?.borderLeftWidth === "0px"
        && style?.borderRightWidth === "0px"
        && style?.backgroundClip === "padding-box"
        && style?.boxShadow === "none"
    )),
    `${label}: selected sliders do not keep a clean, shadowless 4px block inset`,
    selectedTabStyles,
  );
  if (!activeSearchControlIds.length) return;
  const searchFormControls = activeSearchControlIds.map((id) => metrics.formControls[id]);
  assert(
    Math.abs(metrics.searchModeTabs.height - 48) <= 1
      && Math.abs(metrics.searchControls.moreBrowse.height - 48) <= 1
      && [metrics.searchControls.shared, metrics.searchControls.local]
        .every((tab) => tab && Math.abs(tab.height - 48) <= 1)
      && searchFormControls.every((control) => control && Math.abs(control.height - 48) <= 1),
    `${label}: search tabs, action, and form controls do not share the compact height template`,
    {
      searchModeTabs: metrics.searchModeTabs,
      searchControls: metrics.searchControls,
      searchFormControls,
    },
  );
}

function assertSearchToolbar(metrics, label) {
  const { shared, local, moreBrowse } = metrics.searchControls;
  assert(
    shared && local && moreBrowse
      && shared.height >= 44 && local.height >= 44 && moreBrowse.height >= 44,
    `${label}: search toolbar lost a 44px touch target`,
    metrics.searchControls,
  );
  assert(
    rectInside(shared, metrics.searchModeTabs)
      && rectInside(local, metrics.searchModeTabs)
      && rectInside(moreBrowse, metrics.requestCard),
    `${label}: a search toolbar control was clipped`,
    metrics,
  );
  assert(
    !rectanglesOverlap(metrics.searchModeTabs, moreBrowse),
    `${label}: More Browse overlaps the search mode tabs`,
    metrics.searchControls,
  );
  const oneRow = Math.abs(metrics.searchModeTabs.top - moreBrowse.top) <= 1;
  const deliberateSecondRow = moreBrowse.top >= metrics.searchModeTabs.bottom - 1;
  assert(oneRow || deliberateSecondRow, `${label}: search toolbar wrapped unintentionally`, metrics);
  assert(metrics.searchControlTextFits, `${label}: search toolbar text was clipped`, metrics);
}

function assertNoRequestCardScroller(metrics, label) {
  assert(
    metrics.requestCardOverflowY !== "auto" && metrics.requestCardOverflowY !== "scroll",
    `${label}: request card became a vertical scroll owner`,
    metrics,
  );
  assert(
    metrics.structuralVerticalOwners.length === 0,
    `${label}: a request-card descendant became a vertical scroll owner`,
    metrics.structuralVerticalOwners,
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
  await context.addInitScript(() => {
    const retiredKey = "bilikara.remote.layout.mode";
    const nativeSetItem = Storage.prototype.setItem;
    window.__retiredLayoutStorageWrites = [];
    Storage.prototype.setItem = function setItem(key, value) {
      if (String(key) === retiredKey) {
        window.__retiredLayoutStorageWrites.push(String(value));
      }
      return nativeSetItem.call(this, key, value);
    };
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const apiRequests = [];
  const routeState = {
    snapshot: null,
    addRequests: [],
    sharedSearchRequests: [],
    localSearchRequests: [],
    advancedRequests: [],
    remoteIdentityRequests: [],
  };
  const paths = Object.fromEntries([
    "quickEmptyZhLight",
    "quickFilledZhLight",
    "quickToastZhLight",
    "sharedEmptyZhLight",
    "sharedResultsZhLight",
    "localEmptyZhLight",
    "localResultsZhLight",
    "advancedModalZhLight",
    "appearanceMenuZhLight",
    "retiredBasicValueZhLight",
    "sharedResultsEnLight",
    "sharedResultsJaBlue",
  ].map((name) => [name, suffixedPath(screenshotPath, `-remote-workspace-375-${name}`)]));

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await installWorkspaceRoutes(context, routeState);

  try {
    await prepareRemotePage(page, baseUrl, routeState);
    const titleRowFeasibility = await measureTitleRowFeasibility(page);
    assert(
      JSON.stringify(titleRowFeasibility.zh.labels) === JSON.stringify(["快速点歌", "搜索"])
        && JSON.stringify(titleRowFeasibility.en.labels) === JSON.stringify(["Quick", "Search"])
        && JSON.stringify(titleRowFeasibility.ja.labels) === JSON.stringify(["クイック", "検索"])
        && Object.values(titleRowFeasibility).every((entry) => entry.current.comfortable),
      "The compact multilingual labels do not fit comfortably beside the request title",
      titleRowFeasibility,
    );
    await page.evaluate(() => {
      window.__workspaceNodeRefs = {
        requestForm: document.getElementById("request-form"),
        sharedForm: document.getElementById("lark-search-form"),
        sharedQuery: document.getElementById("lark-search-query"),
        sharedResults: document.getElementById("lark-search-results"),
        localForm: document.getElementById("search-form"),
        localQuery: document.getElementById("search-query"),
        localResults: document.getElementById("search-results"),
      };
      const card = document.querySelector(".request-panel");
      window.scrollTo(0, Math.max(0, card.offsetTop - 10));
    });
    await nextPaint(page);

    const quickEmpty = await requestWorkspaceMetrics(page);
    assertHorizontalFit(quickEmpty, "375 quick empty");
    assertPrimaryTabGeometry(quickEmpty, "375 quick empty");
    assertRequestTitleRow(quickEmpty, "375 Chinese quick empty");
    assertSegmentedControlHeight(quickEmpty, "375 Chinese quick empty");
    assertNoRequestCardScroller(quickEmpty, "375 quick empty");
    assert(
      Math.abs(quickEmpty.shellGutters.left - quickEmpty.shellGutters.right) <= 1,
      "375 quick empty: shell gutters are not symmetric",
      quickEmpty.shellGutters,
    );
    assert(quickEmpty.activePanelId === "remote-request-quick-panel", "Remote did not start on Quick", quickEmpty);
    await capture(page, paths.quickEmptyZhLight);

    const realisticDraft = "https://www.bilibili.com/video/BV1BrowserQA";
    await page.locator("#url-input").fill(realisticDraft);
    await capture(page, paths.quickFilledZhLight);
    const addResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/playlist/add");
    await page.locator('#request-form button[type="submit"]').click();
    await addResponse;
    await page.waitForFunction(() => (
      document.getElementById("url-input")?.value === ""
        && !document.querySelector('#request-form button[type="submit"]')?.disabled
        && !document.getElementById("app-toast")?.classList.contains("hidden")
    ));
    assert(routeState.addRequests.length === 1, "Quick request dispatched more than once", routeState.addRequests);
    assert(
      routeState.addRequests[0]?.url === realisticDraft
        && routeState.addRequests[0]?.requester_name === "Browser QA"
        && routeState.addRequests[0]?.position === "tail",
      "Quick request changed its payload semantics",
      routeState.addRequests[0],
    );
    const quickToast = await page.evaluate(() => ({
      inlineFormMessagePresent: Boolean(document.getElementById("form-message")),
      visible: !elements.appToast.classList.contains("hidden"),
      text: elements.appToast.textContent.trim(),
      isError: elements.appToast.classList.contains("is-error"),
    }));
    assert(
      !quickToast.inlineFormMessagePresent && quickToast.visible && quickToast.text && !quickToast.isError,
      "Quick request feedback did not use the toast exclusively",
      quickToast,
    );
    await capture(page, paths.quickToastZhLight);
    await page.evaluate(() => setAppMessage(""));
    await page.locator("#url-input").fill(realisticDraft);

    const apiBeforeSearchTab = apiRequests.length;
    const scrollBeforeSearchTab = await page.evaluate(() => window.scrollY);
    const activeBeforeSearchTab = await page.evaluate(() => (
      document.activeElement?.id || document.activeElement?.tagName || ""
    ));
    await page.locator("#remote-request-search-tab").click();
    await nextPaint(page);
    const scrollAfterSearchTab = await page.evaluate(() => window.scrollY);
    const sharedEmpty = await requestWorkspaceMetrics(page);
    assert(apiRequests.length === apiBeforeSearchTab, "Search tab selection made a network request", {
      before: apiBeforeSearchTab,
      after: apiRequests.length,
      apiRequests,
    });
    assert(sharedEmpty.activeElement !== "lark-search-query" && sharedEmpty.activeElement !== "search-query",
      "Search tab selection focused an input", sharedEmpty.activeElement);
    assert(
      scrollAfterSearchTab > 0 && Math.abs(scrollAfterSearchTab - scrollBeforeSearchTab) <= 8,
      "Search tab selection reset or substantially changed document scroll position",
      { scrollBeforeSearchTab, scrollAfterSearchTab },
    );
    assert(sharedEmpty.activePanelId === "remote-request-search-panel", "Search panel did not activate", sharedEmpty);
    assertSearchToolbar(sharedEmpty, "375 shared empty");
    assertSegmentedControlHeight(
      sharedEmpty,
      "375 shared empty",
      ["lark-search-query", "lark-search-button"],
    );
    assertHorizontalFit(sharedEmpty, "375 shared empty");
    assertPrimaryTabGeometry(sharedEmpty, "375 shared empty");
    assertNoRequestCardScroller(sharedEmpty, "375 shared empty");
    assert(
      sharedEmpty.activePanel.height < 300,
      "375 shared empty: active panel still resembles the retired 360px stage",
      sharedEmpty.activePanel,
    );
    assert(
      sharedEmpty.requestCard.height < 360,
      "375 shared empty: request card still resembles the retired 360px stage",
      sharedEmpty.requestCard,
    );
    assert(
      Math.abs(quickEmpty.topTabList.width - sharedEmpty.topTabList.width) <= 1
        && Math.abs(quickEmpty.topTabList.height - sharedEmpty.topTabList.height) <= 1,
      "Selected styling changed top-level tablist geometry",
      { quick: quickEmpty.topTabList, search: sharedEmpty.topTabList },
    );
    await capture(page, paths.sharedEmptyZhLight);

    await page.locator("#lark-search-query").fill("workspace-shared");
    const sharedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/lark/search");
    await page.locator("#lark-search-button").click();
    await sharedResponse;
    await page.waitForFunction(() => (
      document.querySelectorAll("#lark-search-results .search-result-item").length === 12
        && !document.getElementById("lark-search-button")?.disabled
    ));
    const sharedPopulated = await requestWorkspaceMetrics(page);
    assertHorizontalFit(sharedPopulated, "375 shared results");
    assertNoRequestCardScroller(sharedPopulated, "375 shared results");
    assert(
      sharedPopulated.documentElement.scrollHeight > sharedPopulated.documentElement.clientHeight,
      "Populated shared results did not grow the document",
      sharedPopulated.documentElement,
    );
    await capture(page, paths.sharedResultsZhLight, { fullPage: true });

    const apiBeforeLocalTab = apiRequests.length;
    const scrollBeforeLocalTab = await page.evaluate(() => window.scrollY);
    const activeBeforeLocalTab = await page.evaluate(() => (
      document.activeElement?.id || document.activeElement?.tagName || ""
    ));
    await page.locator("#remote-search-local-tab").click();
    await nextPaint(page);
    const scrollAfterLocalTab = await page.evaluate(() => window.scrollY);
    const localEmpty = await requestWorkspaceMetrics(page);
    assert(apiRequests.length === apiBeforeLocalTab, "Local tab selection made a network request", apiRequests);
    assert(localEmpty.activeElement !== "lark-search-query" && localEmpty.activeElement !== "search-query",
      "Local tab selection focused an input", localEmpty.activeElement);
    assert(
      Math.abs(scrollAfterLocalTab - scrollBeforeLocalTab) <= 1,
      "Local tab selection changed document scroll position",
      { scrollBeforeLocalTab, scrollAfterLocalTab },
    );
    assert(localEmpty.activePanel.height < 300, "375 local empty retained fixed stage height", localEmpty.activePanel);
    assert(localEmpty.requestCard.height < 360, "375 local empty request card retained fixed stage height", localEmpty.requestCard);
    assertSearchToolbar(localEmpty, "375 local empty");
    assertSegmentedControlHeight(
      localEmpty,
      "375 local empty",
      ["search-query", "search-button"],
    );
    assertHorizontalFit(localEmpty, "375 local empty");
    assertNoRequestCardScroller(localEmpty, "375 local empty");
    await capture(page, paths.localEmptyZhLight);

    await page.locator("#search-query").fill("workspace-local");
    const localResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/gatcha/search");
    await page.locator("#search-button").click();
    await localResponse;
    await page.waitForFunction(() => (
      document.querySelectorAll("#search-results .search-result-item").length === 10
        && !document.getElementById("search-button")?.disabled
    ));
    const localPopulated = await requestWorkspaceMetrics(page);
    assertHorizontalFit(localPopulated, "375 local results");
    assertNoRequestCardScroller(localPopulated, "375 local results");
    await capture(page, paths.localResultsZhLight, { fullPage: true });

    await page.locator("#remote-search-shared-tab").click();
    assert(await page.locator("#lark-search-query").inputValue() === "workspace-shared",
      "Returning to Shared lost its query");
    assert(await page.locator("#lark-search-results .search-result-item").count() === 12,
      "Returning to Shared lost its results");
    await page.locator("#remote-request-quick-tab").click();
    assert(await page.locator("#url-input").inputValue() === realisticDraft,
      "Returning to Quick lost the URL draft");
    assert((await page.locator("#remote-identity-name").textContent()).trim() === "Browser QA",
      "Returning to Quick lost Remote identity");
    assert(await page.evaluate(() => {
      const refs = window.__workspaceNodeRefs;
      return refs.requestForm === document.getElementById("request-form")
        && refs.sharedForm === document.getElementById("lark-search-form")
        && refs.sharedQuery === document.getElementById("lark-search-query")
        && refs.sharedResults === document.getElementById("lark-search-results")
        && refs.localForm === document.getElementById("search-form")
        && refs.localQuery === document.getElementById("search-query")
        && refs.localResults === document.getElementById("search-results");
    }), "Tab switching remounted a form, input, or result owner");

    await page.locator("#remote-request-search-tab").click();
    await page.locator("#search-library-open").click();
    await page.waitForFunction(() => state.searchModalOpen && !elements.searchModal.classList.contains("hidden"));
    const advancedViews = [];
    for (const target of ["follow", "favlist", "category", "name", "artist"]) {
      await page.locator(`.remote-search-modal-tab[data-target="${target}"]`).click();
      await page.waitForFunction((expected) => state.searchModalView === expected, target);
      advancedViews.push(await page.evaluate(() => state.searchModalView));
    }
    assert(
      (await page.locator(".remote-search-modal-tab").count()) === 5
        && !await page.locator('.remote-search-modal-tab[data-target="search"]').count(),
      "Advanced modal did not retain exactly the five advanced views",
      advancedViews,
    );
    await page.locator('.remote-search-modal-tab[data-target="follow"]').click();
    await waitForVisualAnimations(page, "#search-modal");
    const modalOpen = await requestWorkspaceMetrics(page);
    assert(
      modalOpen.modal && modalOpen.modal.left >= 13 && modalOpen.modal.right <= 362,
      "375 advanced modal lost deliberate side gutters",
      modalOpen.modal,
    );
    assertHorizontalFit(modalOpen, "375 advanced modal");
    await capture(page, paths.advancedModalZhLight);

    await page.locator("#search-modal-close").click();
    await page.locator("#search-modal").waitFor({ state: "hidden" });
    await page.locator("#remote-menu-toggle").click();
    await page.locator("#remote-settings-toggle").click();
    await page.locator("#remote-settings-content").waitFor({ state: "visible" });
    await waitForVisualAnimations(page, "#remote-menu-toggle");
    const appearanceMenu = await appearanceMenuMetrics(page);
    assert(
      appearanceMenu.rows.length === 2
        && JSON.stringify(appearanceMenu.rows.map((row) => row.label)) === JSON.stringify(["语言", "切换主题"]),
      "Appearance menu does not contain exactly language and theme",
      appearanceMenu,
    );
    const expandedSettingsSection = appearanceMenu.sections.find((section) => section.id === "remote-settings-toggle");
    assert(
      expandedSettingsSection?.expanded === "true"
        && expandedSettingsSection.backgroundColor === "rgba(0, 0, 0, 0)"
        && appearanceMenu.rows.every((row) => (
          row.labelStyle?.fontSize === expandedSettingsSection.titleFontSize
            && row.labelStyle?.fontWeight === "400"
            && row.labelStyle?.color === expandedSettingsSection.titleColor
            && row.labelStyle?.textTransform === "uppercase"
        )),
      "Remote appearance section retained a selected fill or stronger item typography than its section title",
      appearanceMenu,
    );
    assert(
      appearanceMenu.layoutDomCount === 0 && appearanceMenu.layoutFocusableCount === 0,
      "Appearance menu retained a visible or focusable layout selector",
      appearanceMenu,
    );
    assert(
      appearanceMenu.menu && appearanceMenu.settings
        && appearanceMenu.menu.left >= 0 && appearanceMenu.menu.right <= 375
        && rectInside(appearanceMenu.settings, appearanceMenu.menu),
      "Appearance menu escaped the 375px viewport",
      appearanceMenu,
    );
    assert(
      quickEmpty.styles.menuTrigger.borderWidth !== "0px"
        && quickEmpty.styles.menuTrigger.borderColor !== "rgba(0, 0, 0, 0)"
        && appearanceMenu.trigger.borderWidth === quickEmpty.styles.menuTrigger.borderWidth
        && appearanceMenu.trigger.borderColor === "rgba(0, 0, 0, 0)",
      "Expanded menu trigger did not remove only its themed border color",
      { closed: quickEmpty.styles.menuTrigger, expanded: appearanceMenu.trigger },
    );
    await capture(page, paths.appearanceMenuZhLight);
    await page.locator("#remote-menu-toggle").click();
    await page.locator("#remote-menu-panel").waitFor({ state: "hidden" });

    await page.evaluate(() => {
      activateRemoteRequestView("search");
      activateRemoteSearchMode("shared");
    });
    const selectionBeforeLanguage = await page.evaluate(() => ({
      request: state.remoteRequestView,
      mode: state.remoteSearchMode,
    }));
    await page.evaluate(() => setLanguage("en"));
    const english = await requestWorkspaceMetrics(page);
    assertSearchToolbar(english, "375 English shared results");
    assertHorizontalFit(english, "375 English shared results");
    assertRequestTitleRow(english, "375 English shared results");
    assert(
      JSON.stringify(english.topTabLabels) === JSON.stringify(["Quick", "Search"])
        && Math.abs(english.searchModeTabs.top - english.searchControls.moreBrowse.top) <= 1,
      "English labels are not compact or the search toolbar still wraps",
      english,
    );
    await capture(page, paths.sharedResultsEnLight);

    await page.evaluate(() => {
      setLanguage("ja");
      applyTheme("blue");
    });
    await waitForVisualAnimations(page, "#remote-shell");
    const japaneseBlue = await requestWorkspaceMetrics(page);
    const selectionAfterLanguage = await page.evaluate(() => ({
      request: state.remoteRequestView,
      mode: state.remoteSearchMode,
    }));
    assert(
      JSON.stringify(selectionBeforeLanguage) === JSON.stringify(selectionAfterLanguage),
      "Language changes reset the active request/search tabs",
      { selectionBeforeLanguage, selectionAfterLanguage },
    );
    assertSearchToolbar(japaneseBlue, "375 Japanese blue shared results");
    assertHorizontalFit(japaneseBlue, "375 Japanese blue shared results");
    assertRequestTitleRow(japaneseBlue, "375 Japanese blue shared results");
    assert(
      JSON.stringify(japaneseBlue.topTabLabels) === JSON.stringify(["クイック", "検索"]),
      "Japanese request labels are not compact",
      japaneseBlue.topTabLabels,
    );
    assert(
      japaneseBlue.styles.topRail.backgroundColor === japaneseBlue.styles.searchRail.backgroundColor
        && japaneseBlue.styles.topRail.backgroundColor === japaneseBlue.styles.queueRail.backgroundColor
        && japaneseBlue.styles.topRail.gap === japaneseBlue.styles.searchRail.gap
        && japaneseBlue.styles.topRail.gap === japaneseBlue.styles.queueRail.gap
        && japaneseBlue.styles.topRail.padding === japaneseBlue.styles.searchRail.padding
        && japaneseBlue.styles.topRail.padding === japaneseBlue.styles.queueRail.padding,
      "Segmented-control rails do not share the queue/history visual contract",
      japaneseBlue.styles,
    );
    assert(
      japaneseBlue.styles.topSelected.backgroundColor === japaneseBlue.styles.searchSelected.backgroundColor
        && japaneseBlue.styles.topSelected.backgroundColor === japaneseBlue.styles.queueSelected.backgroundColor
        && japaneseBlue.styles.topSelected.color === japaneseBlue.styles.searchSelected.color
        && japaneseBlue.styles.topSelected.color === japaneseBlue.styles.queueSelected.color
        && japaneseBlue.styles.topSelected.borderRadius === japaneseBlue.styles.searchSelected.borderRadius
        && japaneseBlue.styles.topSelected.borderRadius === japaneseBlue.styles.queueSelected.borderRadius
        && Number(japaneseBlue.styles.topSelected.fontWeight) >= 700
        && Number(japaneseBlue.styles.searchSelected.fontWeight) >= 700
        && Number(japaneseBlue.styles.queueSelected.fontWeight) >= 700,
      "Segmented-control selected states are inconsistent",
      japaneseBlue.styles,
    );
    assert(
      japaneseBlue.styles.sharedSubmit.backgroundColor
          === japaneseBlue.styles.sharedResultRequest.backgroundColor
        && japaneseBlue.styles.sharedSubmit.color === japaneseBlue.styles.sharedResultRequest.color,
      "Blue-theme primary Search and result Request buttons do not share colors",
      japaneseBlue.styles,
    );
    assert(
      japaneseBlue.styles.moreBrowse.backgroundColor
          === japaneseBlue.styles.secondaryButton.backgroundColor
        && japaneseBlue.styles.moreBrowse.color
          === japaneseBlue.styles.secondaryButton.color,
      "More Browse diverges from the existing ghost/secondary button surface",
      japaneseBlue.styles,
    );
    await capture(page, paths.sharedResultsJaBlue);

    const themeButtonEvidence = {};
    for (const theme of ["light", "dark", "blue"]) {
      const evidence = await collectThemeButtonEvidence(page, theme);
      themeButtonEvidence[theme] = evidence;
      assert(
        evidence.primarySearch.backgroundColor === evidence.primaryResult.backgroundColor
          && evidence.primarySearch.color === evidence.primaryResult.color,
        `${theme} theme gives same-class primary buttons different colors`,
        evidence,
      );
      assert(
        evidence.requestSelected.backgroundColor === evidence.searchSelected.backgroundColor
          && evidence.requestSelected.backgroundColor === evidence.queueSelected.backgroundColor
          && evidence.requestSelected.color === evidence.searchSelected.color
          && evidence.requestSelected.color === evidence.queueSelected.color,
        `${theme} theme gives segmented selected states different colors`,
        evidence,
      );
      assert(
        evidence.moreBrowse.backgroundColor === evidence.secondary.backgroundColor
          && evidence.moreBrowse.color === evidence.secondary.color,
        `${theme} theme gives More Browse a custom surface instead of the existing button style`,
        evidence,
      );
    }

    await page.evaluate(() => {
      localStorage.setItem("bilikara.remote.layout.mode", "basic");
    });
    const reloadedIdentity = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/remote-identity"
    ));
    const reloadedState = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/state"
    ));
    const reloadedEventStream = page.waitForRequest((request) => (
      new URL(request.url()).pathname === "/api/events"
    ));
    await page.reload({ waitUntil: "domcontentloaded" });
    await Promise.all([reloadedIdentity, reloadedState, reloadedEventStream]);
    await stabilizeRemotePage(page, routeState);
    const retiredLayout = await retiredLayoutPreferenceEvidence(page);
    assert(
      retiredLayout.storedValue === "basic"
        && retiredLayout.storageWrites.length === 0
        && retiredLayout.layoutDomCount === 0
        && !retiredLayout.layoutClassPresent
        && !retiredLayout.stateHasLayoutMode
        && !retiredLayout.elementsHasLayoutModeSwitch
        && !retiredLayout.storageKeysHasLayoutMode,
      "The retired Basic preference still has an active DOM, state, class, or storage path",
      retiredLayout,
    );
    assert(
      retiredLayout.searchTabVisible && retiredLayout.gatchaVisible,
      "The retired Basic value still hides Search or Gatcha",
      retiredLayout,
    );
    const apiBeforeRetiredValueSearch = apiRequests.length;
    await page.locator("#remote-request-search-tab").click();
    await nextPaint(page);
    retiredLayout.searchPanelVisible = await page.locator("#remote-request-search-panel").isVisible();
    retiredLayout.searchTabNetworkDelta = apiRequests.length - apiBeforeRetiredValueSearch;
    assert(
      retiredLayout.searchPanelVisible && retiredLayout.searchTabNetworkDelta === 0,
      "Search is not usable after reloading with the retired Basic value",
      retiredLayout,
    );
    const retiredLayoutWorkspace = await requestWorkspaceMetrics(page);
    assertHorizontalFit(retiredLayoutWorkspace, "375 retired Basic value");
    assertPrimaryTabGeometry(retiredLayoutWorkspace, "375 retired Basic value");
    assertSearchToolbar(retiredLayoutWorkspace, "375 retired Basic value");
    assertNoRequestCardScroller(retiredLayoutWorkspace, "375 retired Basic value");
    await capture(page, paths.retiredBasicValueZhLight, { fullPage: true });

    assert(consoleErrors.length === 0, "375 workspace produced console errors", consoleErrors);
    assert(pageErrors.length === 0, "375 workspace produced page errors", pageErrors);

    return {
      viewport: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      quickEmpty,
      sharedEmpty,
      sharedPopulated,
      localEmpty,
      localPopulated,
      modalOpen,
      appearanceMenu,
      retiredLayout,
      retiredLayoutWorkspace,
      english,
      japaneseBlue,
      quickToast,
      titleRowFeasibility,
      themeButtonEvidence,
      scroll: {
        quickToSearch: { before: scrollBeforeSearchTab, after: scrollAfterSearchTab },
        sharedToLocal: { before: scrollBeforeLocalTab, after: scrollAfterLocalTab },
      },
      focus: {
        quickToSearch: { before: activeBeforeSearchTab, after: sharedEmpty.activeElement },
        sharedToLocal: { before: activeBeforeLocalTab, after: localEmpty.activeElement },
      },
      network: {
        addRequests: routeState.addRequests,
        sharedSearchCount: routeState.sharedSearchRequests.length,
        localSearchCount: routeState.localSearchRequests.length,
        advancedRequestCount: routeState.advancedRequests.length,
      },
      advancedViews,
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
  const routeState = {
    snapshot: null,
    addRequests: [],
    sharedSearchRequests: [],
    localSearchRequests: [],
    advancedRequests: [],
    remoteIdentityRequests: [],
  };
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installWorkspaceRoutes(context, routeState);
  try {
    await prepareRemotePage(page, baseUrl, routeState);
    await page.evaluate(({ language, theme, view, mode, populated, draft, modal }) => {
      setLanguage(language);
      applyTheme(theme);
      activateRemoteRequestView(view);
      activateRemoteSearchMode(mode);
      if (draft) elements.urlInput.value = draft;
      if (populated === "shared") {
        canonicalBilikaraSearch.query = "secondary shared";
        canonicalBilikaraSearch.items = Array.from({ length: 4 }, (_, index) => ({
          bvid: `BVSECONDARYS${index}`,
          title: `Secondary shared ${index + 1}`,
          url: `https://www.bilibili.com/video/BVSECONDARYS${index}`,
          owner_name: "Secondary owner",
        }));
        canonicalBilikaraSearch.hasSearched = true;
        canonicalBilikaraSearch.loading = false;
        canonicalBilikaraSearch.message = "";
        syncBilikaraSearchView();
      } else if (populated === "local") {
        renderSearchResults(Array.from({ length: 4 }, (_, index) => ({
          bvid: `BVSECONDARYL${index}`,
          title: `Secondary local ${index + 1}`,
          url: `https://www.bilibili.com/video/BVSECONDARYL${index}`,
          owner_name: "Secondary owner",
        })));
      }
      if (modal) setSearchModalOpen(true);
      document.querySelector(".request-panel")?.scrollIntoView({ block: "start" });
    }, scenario);
    await waitForVisualAnimations(page, "#remote-shell");
    if (scenario.modal) {
      await page.waitForFunction(() => state.searchModalOpen && !elements.searchModal.classList.contains("hidden"));
      await waitForVisualAnimations(page, "#search-modal");
    }
    await nextPaint(page);
    const metrics = await requestWorkspaceMetrics(page);
    assertHorizontalFit(metrics, `${scenario.width}x${scenario.height}`);
    if (scenario.view === "search" && !scenario.modal) {
      assertSearchToolbar(metrics, `${scenario.width}x${scenario.height}`);
    }
    if (!scenario.modal) assertNoRequestCardScroller(metrics, `${scenario.width}x${scenario.height}`);
    const path = suffixedPath(
      screenshotPath,
      `-remote-workspace-${scenario.width}x${scenario.height}-${scenario.name}`,
    );
    await capture(page, path, { fullPage: Boolean(scenario.populated) });
    assert(consoleErrors.length === 0, `${scenario.width} secondary check produced console errors`, consoleErrors);
    assert(pageErrors.length === 0, `${scenario.width} secondary check produced page errors`, pageErrors);
    return { ...scenario, metrics, screenshot: path, consoleErrors, pageErrors };
  } finally {
    if (!page.isClosed()) await page.close({ runBeforeUnload: false });
    await context.close();
  }
}

async function runRemoteRequestWorkspaceGate(browser, baseUrl, screenshotPath) {
  const primary = await runPrimaryGate(browser, baseUrl, screenshotPath);
  const scenarios = [
    {
      name: "en-shared-empty",
      width: 320,
      height: 640,
      language: "en",
      theme: "light",
      view: "search",
      mode: "shared",
      populated: "",
      draft: "",
      modal: false,
    },
    {
      name: "ja-local-results-blue",
      width: 390,
      height: 844,
      language: "ja",
      theme: "blue",
      view: "search",
      mode: "local",
      populated: "local",
      draft: "",
      modal: false,
    },
    {
      name: "zh-quick-filled-dark",
      width: 430,
      height: 932,
      language: "zh",
      theme: "dark",
      view: "quick",
      mode: "shared",
      populated: "",
      draft: "BV1SecondaryViewport",
      modal: false,
    },
    {
      name: "en-advanced-modal",
      width: 720,
      height: 900,
      language: "en",
      theme: "light",
      view: "search",
      mode: "shared",
      populated: "shared",
      draft: "",
      modal: true,
    },
  ];
  const secondary = [];
  for (const scenario of scenarios) {
    secondary.push(await runSecondaryViewport(browser, baseUrl, screenshotPath, scenario));
  }
  return { passed: true, primary, secondary };
}

module.exports = { runRemoteRequestWorkspaceGate };
