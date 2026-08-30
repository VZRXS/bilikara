"use strict";

const { chromium } = require("playwright");

const [baseUrl, executablePath, screenshotPath] = process.argv.slice(2);

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

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const maintenanceBusyScreenshotPath = suffixedPath(screenshotPath, "-maintenance-busy");
  const consoleErrors = [];
  const pageErrors = [];
  const hostPlayerRequests = [];
  const updateCheckRequests = [];
  const updateInstallRequests = [];
  const larkSearchRequests = [];
  const localSearchRequests = [];
  const d1BrowseRequests = [];
  const categoryBrowseRequests = [];
  const sourceBrowseRequests = [];
  const sourceUidPreviewRequests = [];
  const sourceUidAddRequests = [];
  const maintenanceRequests = [];
  let releaseMonthlyMaintenance;
  const monthlyMaintenanceGate = new Promise((resolve) => {
    releaseMonthlyMaintenance = resolve;
  });
  let releaseTaggerMaintenance;
  const taggerMaintenanceGate = new Promise((resolve) => {
    releaseTaggerMaintenance = resolve;
  });
  let pendingStartupUpdateRoute = null;
  let resolveStartupUpdateSeen;
  const startupUpdateSeen = new Promise((resolve) => { resolveStartupUpdateSeen = resolve; });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/player/")) {
      hostPlayerRequests.push(request.url());
    }
  });
  await page.route("**/api/app/update/check", (route) => {
    const payload = route.request().postDataJSON();
    updateCheckRequests.push(payload);
    if (updateCheckRequests.length === 1) {
      pendingStartupUpdateRoute = route;
      resolveStartupUpdateSeen();
      return;
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { state: "checking", include_preview: Boolean(payload?.include_preview) },
      }),
    });
  });
  await page.route("**/api/app/update/install", (route) => {
    const payload = route.request().postDataJSON();
    updateInstallRequests.push(payload);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { state: "checking", include_preview: Boolean(payload?.include_preview), message: "install requested" },
      }),
    });
  });
  await page.route("**/api/lark/search?**", (route) => {
    larkSearchRequests.push(route.request().url());
    const items = Array.from({ length: 36 }, (_, index) => ({
      bvid: `BVHOSTUI${index}`,
      title: `Host UI result ${index}`,
      url: `https://www.bilibili.com/video/BVHOSTUI${index}`,
      owner_name: "Host UI owner",
      played_count: 1000 + index,
      rank: 4.5,
    }));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { items } }),
    });
  });
  await page.route("**/api/gatcha/search?**", (route) => {
    localSearchRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items: [{
            bvid: "BVLOCALUI",
            title: "Local configured-source result",
            url: "https://www.bilibili.com/video/BVLOCALUI",
            owner_name: "Local owner",
          }],
        },
      }),
    });
  });
  await page.route("**/api/d1/browse?**", async (route) => {
    d1BrowseRequests.push(route.request().url());
    const requestUrl = new URL(route.request().url());
    const kind = requestUrl.searchParams.get("kind") || "name";
    const tag = requestUrl.searchParams.get("tag") || "";
    const query = requestUrl.searchParams.get("q") || "";
    if (query === "delayed-old") {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: tag
          ? {
            items: Array.from({ length: 80 }, (_, index) => ({
              bvid: `BV${kind.toUpperCase()}${tag.replace(/\W/g, "")}${index}`,
              title: `${kind} ${tag} ${query || "items"} ${index}`,
              url: `https://www.bilibili.com/video/BV${kind.toUpperCase()}${index}`,
            })),
          }
          : {
            tags: Array.from({ length: 70 }, (_, index) => ({
              tag: index === 0 ? "Anime" : `${kind} tag ${index}`,
              locale: index % 2 ? "ja" : "en",
              count: 100 - index,
            })),
          },
      }),
    });
  });
  await page.route("**/api/d1/category-browse?**", async (route) => {
    categoryBrowseRequests.push(route.request().url());
    const requestUrl = new URL(route.request().url());
    const offset = Number(requestUrl.searchParams.get("offset") || 0);
    const query = requestUrl.searchParams.get("q") || "";
    if (query === "delayed-old") {
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    const start = offset > 0 ? offset - 1 : 0;
    const count = offset > 0 ? 31 : 100;
    const items = Array.from({ length: count }, (_, index) => {
      const itemIndex = start + index;
      return {
        bvid: `BVCATEGORY${itemIndex}`,
        title: `Category ${query || "items"} ${itemIndex}`,
        url: `https://www.bilibili.com/video/BVCATEGORY${itemIndex}`,
      };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          items,
          has_more: offset === 0,
          next_offset: offset === 0 ? 100 : 130,
        },
      }),
    });
  });
  await page.route("**/api/gatcha/browse**", (route) => {
    sourceBrowseRequests.push(route.request().url());
    const requestUrl = new URL(route.request().url());
    const uid = requestUrl.searchParams.get("uid") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: uid
          ? { selected_uid: uid, owners: [{ uid, name: "Source owner", count: 1 }], items: [{ bvid: "BVSOURCE", title: "Source song", url: "https://www.bilibili.com/video/BVSOURCE" }] }
          : { selected_uid: "", owners: [{ uid: "42", name: "Source owner", count: 1 }], items: [] },
      }),
    });
  });
  await page.route("**/api/gatcha/favlist/browse**", (route) => {
    sourceBrowseRequests.push(route.request().url());
    const requestUrl = new URL(route.request().url());
    const folderId = requestUrl.searchParams.get("folder_id") || "";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: folderId
          ? { selected_folder_id: folderId, folders: [{ id: folderId, title: "Favorites", media_count: 1 }], items: [{ bvid: "BVFAVORITE", title: "Favorite song", url: "https://www.bilibili.com/video/BVFAVORITE" }] }
          : { selected_folder_id: "", folders: [{ id: "7", title: "Favorites", media_count: 1 }], items: [] },
      }),
    });
  });
  await page.route("**/api/gatcha/uids/preview", (route) => {
    sourceUidPreviewRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { uid: "4242", name: "Canonical source", cache_mode: "incremental", already_followed: false },
      }),
    });
  });
  await page.route("**/api/gatcha/uids/add", (route) => {
    sourceUidAddRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          uid: "4242",
          name: "Canonical source",
          added: true,
          cache: { mode: "incremental", added_count: 1, total_count: 1 },
        },
      }),
    });
  });
  await page.route("**/api/admin-maintenance/trigger", async (route) => {
    const payload = route.request().postDataJSON();
    maintenanceRequests.push(payload);
    if (payload?.job === "monthly-d1-refresh") {
      await monthlyMaintenanceGate;
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            success: true,
            job: "monthly-d1-refresh",
            instance_id: "local-browser-1",
            status: "running",
            execution: "local",
          },
        }),
      });
    }
    await taggerMaintenanceGate;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "workflow unavailable" }),
    });
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const identity = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyTextLength: String(document.body?.innerText || "").trim().length,
      frameworkOverlay: Boolean(document.querySelector(
        "nextjs-portal, vite-error-overlay, #webpack-dev-server-client-overlay",
      )),
    }));
    assert(identity.url === `${baseUrl}/`, "browser opened the wrong Host page", identity);
    assert(identity.title && identity.bodyTextLength > 0, "Host page was blank", identity);
    assert(!identity.frameworkOverlay, "Host page showed a framework error overlay", identity);
    await Promise.race([
      startupUpdateSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("startup update check was not requested")), 3000)),
    ]);
    assert(await page.locator("#current-title").isVisible(), "startup update check blocked the first usable Host render");
    assert(await page.locator("#cache-settings-toggle").isVisible(), "startup update check blocked Host settings");
    assert(
      await page.locator("#update-automatic-checkbox").isChecked(),
      "automatic update checking did not default to enabled",
    );
    assert(
      !await page.locator("#update-preview-checkbox").isChecked(),
      "preview releases did not default to disabled",
    );
    assert(updateCheckRequests.length === 1 && updateCheckRequests[0].include_preview === false,
      "first accepted Host state did not trigger one stable-only check", updateCheckRequests);
    assert(!await page.locator("#app-toast").isVisible(), "automatic update startup showed an intrusive toast");
    await pendingStartupUpdateRoute.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { state: "checking", include_preview: false } }),
    });
    pendingStartupUpdateRoute = null;
    await page.waitForTimeout(120);
    await page.evaluate(() => { render(); render(); });
    await page.waitForTimeout(1200);
    assert(updateCheckRequests.length === 1, "repeated renders or state polls repeated the startup update check", updateCheckRequests);

    const startupReadinessEvidence = await page.evaluate(() => {
      const originalData = state.data;
      const originalRemoteSignature = state.remoteAccessRenderSignature;
      const originalRenderRemoteAccess = renderRemoteAccess;
      let remoteRenderCalls = 0;
      renderRemoteAccess = (...args) => {
        remoteRenderCalls += 1;
        return originalRenderRemoteAccess(...args);
      };
      const loading = {
        ...originalData,
        remote_access: null,
        bbdown: { available: false, status: "loading" },
        ffmpeg: { available: false, status: "loading" },
      };
      state.data = loading;
      state.remoteAccessRenderSignature = "";
      render();
      const ready = {
        ...loading,
        remote_access: {
          preferred_url: "http://192.0.2.44:8000/remote",
          local_url: "http://127.0.0.1:8000/remote",
          lan_urls: ["http://192.0.2.44:8000/remote"],
        },
        bbdown: { available: true, status: "ready" },
        ffmpeg: { available: true, status: "ready" },
      };
      const accepted = acceptHostStateSnapshot(ready);
      if (accepted) {
        render();
      }
      const link = elements.remoteUrlLink.href;
      const qrSource = elements.remoteQrImage.src;
      elements.remoteQrImage.onload?.(new Event("load"));
      const delayedSuccess = !elements.remoteQrImage.classList.contains("hidden")
        && elements.remoteQrPlaceholder.classList.contains("hidden");
      elements.remoteQrImage.onerror?.(new Event("error"));
      const failure = elements.remoteQrImage.classList.contains("hidden")
        && !elements.remoteQrPlaceholder.classList.contains("hidden")
        && Boolean(elements.remoteQrPlaceholder.textContent.trim())
        && elements.remoteUrlLink.href === link;
      state.data = originalData;
      state.remoteAccessRenderSignature = "";
      renderRemoteAccess = originalRenderRemoteAccess;
      render();
      state.remoteAccessRenderSignature = originalRemoteSignature;
      return {
        accepted,
        remoteRenderCalls,
        link,
        qrSource,
        delayedSuccess,
        failure,
      };
    });
    assert(
      startupReadinessEvidence.accepted
        && startupReadinessEvidence.remoteRenderCalls >= 2
        && startupReadinessEvidence.link.includes("192.0.2.44")
        && startupReadinessEvidence.qrSource.includes("api.qrserver.com")
        && startupReadinessEvidence.delayedSuccess
        && startupReadinessEvidence.failure,
      "same-revision startup readiness or delayed QR success/failure required user interaction",
      startupReadinessEvidence,
    );

    const shellPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const shellConsoleErrors = [];
    const shellPageErrors = [];
    const shellPlayerRequests = [];
    const shellPlayedSessionRequests = [];
    const shellGatchaCandidateRequests = [];
    const shellGatchaCandidateRoutes = [];
    const shellPoolConfigRequests = [];
    const shellPoolConfigRoutes = [];
    const shellSourceManagementRequests = [];
    const fulfillJson = (route, data, { status = 200, ok = status < 400 } = {}) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(ok ? { ok: true, data } : { ok: false, error: data }),
    });
    const longPoolProjection = (uidWeight, suffix = "accepted") => ({
      uid_weight: uidWeight,
      favlist_weight: 100 - uidWeight,
      excluded_uids: [],
      excluded_favlist_folders: [],
      updated_at: uidWeight,
      uid_options: Array.from({ length: 36 }, (_, index) => ({
        uid: `uid-${suffix}-${index}`,
        name: `A deliberately long configured uploader ${suffix} ${index}`,
        count: 100 + index,
      })),
      favlist_folder_options: Array.from({ length: 34 }, (_, index) => ({
        id: `folder-${suffix}-${index}`,
        uid: `owner-${index}`,
        title: `A deliberately long favorite folder ${suffix} ${index}`,
        count: 80 + index,
      })),
    });
    await shellPage.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.__hostShellIntervalIds = [];
      window.setInterval = (...args) => {
        const intervalId = nativeSetInterval(...args);
        window.__hostShellIntervalIds.push(intervalId);
        return intervalId;
      };
    });
    shellPage.on("console", (message) => {
      if (message.type() === "error") {
        shellConsoleErrors.push(message.text());
      }
    });
    shellPage.on("pageerror", (error) => shellPageErrors.push(error.message));
    shellPage.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/player/")) {
        shellPlayerRequests.push(request.url());
      }
      if (pathname === "/api/played-sessions") {
        shellPlayedSessionRequests.push(request.url());
      }
      if (
        pathname === "/api/gatcha/browse"
        || pathname === "/api/gatcha/favlist/browse"
        || pathname.startsWith("/api/gatcha/uids/")
        || pathname === "/api/gatcha/refresh"
        || pathname === "/api/gatcha/favlist"
      ) {
        shellSourceManagementRequests.push({
          method: request.method(),
          pathname,
        });
      }
    });
    await shellPage.route("**/api/app/update/check", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { state: "checking", include_preview: false } }),
    }));
    await shellPage.route("**/api/gatcha/candidate", (route) => {
      shellGatchaCandidateRequests.push(route.request().url());
      shellGatchaCandidateRoutes.push(route);
    });
    await shellPage.route("**/api/gatcha/pool-config", (route) => {
      shellPoolConfigRequests.push({
        method: route.request().method(),
        payload: route.request().method() === "POST" ? route.request().postDataJSON() : null,
      });
      shellPoolConfigRoutes.push(route);
    });
    await shellPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await shellPage.waitForTimeout(900);
    await shellPage.evaluate(() => {
      for (const intervalId of window.__hostShellIntervalIds || []) {
        window.clearInterval(intervalId);
      }
    });

    const shellInitial = await shellPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("[data-host-workspace]"));
      const panels = Array.from(document.querySelectorAll("[data-host-workspace-panel]"));
      const ids = Array.from(document.querySelectorAll("[id]"), (element) => element.id);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      return {
        activeWorkspace: state.activeHostWorkspace,
        shellWorkspace: elements.appShell?.dataset.activeWorkspace,
        selected: buttons.filter((button) => button.getAttribute("aria-selected") === "true")
          .map((button) => button.dataset.hostWorkspace),
        roving: buttons.filter((button) => button.tabIndex === 0)
          .map((button) => button.dataset.hostWorkspace),
        visiblePanels: [...new Set(panels.filter((panel) => !panel.hidden)
          .map((panel) => panel.dataset.hostWorkspacePanel))],
        inactiveInteractive: panels.some((panel) => panel.hidden && !panel.inert),
        toolbarHeight: document.querySelector(".topbar")?.getBoundingClientRect().height || 0,
        globalActions: [
          "#remote-mini-trigger",
          "#display-settings-toggle",
          "#presentation-settings-toggle",
          "#cache-settings-toggle",
        ].map((selector) => {
          const action = document.querySelector(selector);
          const rect = action.getBoundingClientRect();
          return {
            selector,
            visible: Boolean(action.offsetWidth || action.offsetHeight || action.getClientRects().length),
            width: rect.width,
            height: rect.height,
            labelSize: Number.parseFloat(getComputedStyle(action.querySelector(".control-label")).fontSize),
          };
        }),
        railWidth: document.querySelector(".work-rail")?.getBoundingClientRect().width || 0,
        railTargetHeights: buttons.map((button) => button.getBoundingClientRect().height),
        bodyScrollY: window.scrollY,
        bodyOverflow: getComputedStyle(document.body).overflow,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        outerScrollTops: [
          elements.appShell,
          document.querySelector(".shell-body"),
          document.querySelector(".layout"),
          document.querySelector(".host-content-region"),
        ].map((element) => element?.scrollTop || 0),
        duplicateIds,
        playerFrameCount: document.querySelectorAll("#player-frame").length,
        featureCounts: {
          queue: document.querySelectorAll(".queue-card").length,
          directRequest: document.querySelectorAll("#add-form").length,
          search: document.querySelectorAll("#request-search-panel").length,
          random: document.querySelectorAll("#gatcha-panel").length,
          users: document.querySelectorAll("#session-users-panel").length,
        },
        retiredLayoutSelector: document.querySelectorAll("#layout-mode-switch, #display-layout-summary").length,
      };
    });
    assert(
      shellInitial.activeWorkspace === "queue"
        && shellInitial.shellWorkspace === "queue"
        && shellInitial.selected.join(",") === "queue"
        && shellInitial.roving.join(",") === "queue"
        && shellInitial.visiblePanels.join(",") === "queue"
        && !shellInitial.inactiveInteractive,
      "Queue was not the one accessible default Host workspace",
      shellInitial,
    );
    assert(shellInitial.toolbarHeight < 102, "global toolbar was not materially compacted", shellInitial);
    assert(
      shellInitial.globalActions.every((action) => action.visible
        && action.height >= 40
        && action.labelSize >= 13),
      "browser Host lost a readable one-line global toolbar action",
      shellInitial.globalActions,
    );
    assert(
      shellInitial.railWidth >= 99 && shellInitial.railWidth <= 105
        && shellInitial.railTargetHeights.every((height) => height >= 40),
      "wide work rail did not preserve its intended width and fine-pointer targets",
      shellInitial,
    );
    assert(
      shellInitial.bodyScrollY === 0
        && shellInitial.bodyOverflow === "hidden"
        && shellInitial.htmlOverflow === "hidden"
        && shellInitial.outerScrollTops.every((scrollTop) => scrollTop === 0),
      "document/body retained primary Host navigation scrolling",
      shellInitial,
    );
    assert(shellInitial.duplicateIds.length === 0, "Host shell introduced duplicate ids", shellInitial.duplicateIds);
    assert(
      shellInitial.playerFrameCount === 1
        && Object.values(shellInitial.featureCounts).every((count) => count === 1),
      "Host shell duplicated a Stage or feature subtree",
      shellInitial,
    );
    assert(shellInitial.retiredLayoutSelector === 0, "retired Host Basic/Full UI remained visible", shellInitial);

    const directListInitial = await shellPage.evaluate(() => {
      window.__hostShellQueueNodes = {
        queue: document.querySelector("#host-workspace-queue"),
        history: document.querySelector("#host-workspace-history"),
        playlist: elements.playlist,
        historyList: elements.historyList,
      };
      return {
        workspace: state.activeHostWorkspace,
        selected: Array.from(elements.hostWorkspaceButtons || [])
          .filter((button) => button.getAttribute("aria-selected") === "true")
          .map((button) => button.dataset.hostWorkspace),
        queueVisible: !document.querySelector("#host-workspace-queue").hidden,
        historyHidden: document.querySelector("#host-workspace-history").hidden
          && document.querySelector("#host-workspace-history").inert,
        nextInStage: Boolean(document.querySelector(".player-panel #next-button")),
        nextCount: document.querySelectorAll("#next-button").length,
      };
    });
    assert(
      directListInitial.workspace === "queue"
        && directListInitial.selected.join(",") === "queue"
        && directListInitial.queueVisible
        && directListInitial.historyHidden
        && directListInitial.nextInStage
        && directListInitial.nextCount === 1,
      "Queue was not the one accessible default direct list workspace",
      directListInitial,
    );
    await shellPage.locator("#work-rail-history").click();
    await shellPage.waitForTimeout(80);
    const directHistory = await shellPage.evaluate(() => ({
      workspace: state.activeHostWorkspace,
      selected: Array.from(elements.hostWorkspaceButtons || [])
        .filter((button) => button.getAttribute("aria-selected") === "true")
        .map((button) => button.dataset.hostWorkspace),
      queueHidden: document.querySelector("#host-workspace-queue").hidden
        && document.querySelector("#host-workspace-queue").inert,
      historyVisible: !document.querySelector("#host-workspace-history").hidden,
      stableNodes: document.querySelector("#host-workspace-queue") === window.__hostShellQueueNodes.queue
        && document.querySelector("#host-workspace-history") === window.__hostShellQueueNodes.history
        && elements.playlist === window.__hostShellQueueNodes.playlist
        && elements.historyList === window.__hostShellQueueNodes.historyList,
    }));
    assert(
      directHistory.workspace === "history"
        && directHistory.selected.join(",") === "history"
        && directHistory.queueHidden
        && directHistory.historyVisible
        && directHistory.stableNodes,
      "History was not an immediate stable direct rail workspace",
      directHistory,
    );
    await shellPage.locator("#work-rail-queue").click();
    await shellPage.locator("#work-rail-history").click();
    await shellPage.waitForTimeout(80);
    assert(
      shellPlayedSessionRequests.length === 1,
      "History direct switching repeated its bounded lazy session load",
      shellPlayedSessionRequests,
    );
    await shellPage.locator("#work-rail-queue").focus();
    await shellPage.keyboard.press("ArrowDown");
    assert(
      await shellPage.evaluate(() => state.activeHostWorkspace === "history"
        && document.activeElement === document.querySelector("#work-rail-history")),
      "Queue/History direct rail keyboard operation did not move focus",
    );
    await shellPage.keyboard.press("Enter");
    assert(
      await shellPage.evaluate(() => state.activeHostWorkspace === "history"
        && document.activeElement?.id === "workspace-history-heading"),
      "History direct rail keyboard activation did not focus its heading",
    );
    await shellPage.locator("#work-rail-queue").click();

    await shellPage.locator("#work-rail-queue").focus();
    await shellPage.keyboard.press("ArrowDown");
    let navigationState = await shellPage.evaluate(() => ({
      active: state.activeHostWorkspace,
      focused: document.activeElement?.dataset?.hostWorkspace || "",
      roving: Array.from(elements.hostWorkspaceButtons || [])
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.dataset.hostWorkspace),
    }));
    assert(
      navigationState.active === "queue"
        && navigationState.focused === "history"
        && navigationState.roving.join(",") === "history",
      "ArrowDown activated instead of only moving manual rail focus",
      navigationState,
    );
    await shellPage.keyboard.press("End");
    assert(
      await shellPage.evaluate(() => document.activeElement?.dataset?.hostWorkspace) === "users"
        && await shellPage.evaluate(() => state.activeHostWorkspace) === "queue",
      "End did not move rail focus without activation",
    );
    await shellPage.keyboard.press("Home");
    assert(
      await shellPage.evaluate(() => document.activeElement?.dataset?.hostWorkspace) === "queue",
      "Home did not return rail focus to Queue",
    );
    await shellPage.keyboard.press("ArrowUp");
    assert(
      await shellPage.evaluate(() => document.activeElement?.dataset?.hostWorkspace) === "users",
      "ArrowUp did not wrap manual rail focus",
    );
    await shellPage.keyboard.press("Space");
    navigationState = await shellPage.evaluate(() => ({
      active: state.activeHostWorkspace,
      activeElement: document.activeElement?.id || "",
      visible: [...new Set(Array.from(elements.hostWorkspacePanels || [])
        .filter((panel) => !panel.hidden)
        .map((panel) => panel.dataset.hostWorkspacePanel))],
    }));
    assert(
      navigationState.active === "users"
        && navigationState.activeElement === "workspace-users-heading"
        && navigationState.visible.join(",") === "users",
      "Space activation did not select Users and focus its heading",
      navigationState,
    );
    await shellPage.locator("#work-rail-request").focus();
    await shellPage.keyboard.press("Enter");
    assert(
      await shellPage.evaluate(() => state.activeHostWorkspace === "request"
        && document.activeElement?.id === "workspace-request-heading"),
      "Enter activation did not select Request and focus its heading",
    );
    await shellPage.locator("#work-rail-random").click();
    assert(
      await shellPage.evaluate(() => state.activeHostWorkspace === "random"
        && document.activeElement?.id === "work-rail-random"),
      "pointer activation did not retain predictable focus on its rail trigger",
    );

    const switchFetchCount = await shellPage.evaluate(() => {
      let requestCount = 0;
      const nativeFetch = window.fetch;
      window.fetch = (...args) => {
        requestCount += 1;
        return nativeFetch(...args);
      };
      for (let cycle = 0; cycle < 20; cycle += 1) {
        for (const workspace of ["queue", "request", "random", "users", "queue"]) {
          activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
        }
      }
      window.fetch = nativeFetch;
      return requestCount;
    });
    assert(switchFetchCount === 0, "workspace switching issued a fetch", switchFetchCount);

    const legacyLayoutValues = ["basic", "normal", "full", "malformed", null];
    const legacyLayoutEvidence = await shellPage.evaluate((values) => values.map((value) => {
      if (value === null) {
        localStorage.removeItem("bilikara.layout.mode");
      } else {
        localStorage.setItem("bilikara.layout.mode", value);
      }
      initializeHostShell();
      const visibleByWorkspace = {};
      for (const workspace of ["queue", "request", "random", "users"]) {
        activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
        visibleByWorkspace[workspace] = Array.from(elements.hostWorkspacePanels || [])
          .filter((panel) => !panel.hidden)
          .every((panel) => panel.dataset.hostWorkspacePanel === workspace);
      }
      return {
        value,
        removed: localStorage.getItem("bilikara.layout.mode") === null,
        visibleByWorkspace,
        oldClasses: elements.appShell?.classList.contains("layout-mode-basic")
          || elements.appShell?.classList.contains("layout-mode-full"),
      };
    }), legacyLayoutValues);
    assert(
      legacyLayoutEvidence.every((entry) => entry.removed
        && !entry.oldClasses
        && Object.values(entry.visibleByWorkspace).every(Boolean)),
      "a legacy Host layout value still hid a feature",
      legacyLayoutEvidence,
    );

    const playerRequestsBeforeSwitching = shellPlayerRequests.length;
    const playerIdentity = await shellPage.evaluate(() => {
      const program = Object.freeze({
        item_id: "browser-shell-item",
        item_incarnation_id: "browser-shell-incarnation",
        selected_audio_variant_id: "browser-shell-audio",
        artifact_set_id: "browser-shell-artifact",
      });
      const currentItem = {
        id: "browser-shell-item",
        item_incarnation_id: "browser-shell-incarnation",
        title: "Browser shell identity",
        url: "https://www.bilibili.com/video/BVSHELL",
        bvid: "BVSHELL",
        status: "ready",
        video_media_url: "/browser-shell-video.mp4",
        audio_variants: [{ id: "browser-shell-audio", audio_url: "/browser-shell-audio.m4a" }],
      };
      state.data = {
        ...(state.data || {}),
        current_item: currentItem,
        playback_mode: "local",
        playback_generation: 701,
        playback_program: program,
        playlist: [],
        history: [],
      };
      const session = createHostPlaybackSession(701, program);
      state.hostPlaybackSession = session;
      setHostPlaybackSessionPhase(session, "binding");
      const pair = mountHostPlaybackSessionElements(session, currentItem, {
        videoUrl: "/browser-shell-video.mp4",
        audioUrl: "/browser-shell-audio.m4a",
        mountable: true,
      });
      session.readyCommitted = true;
      session.logicalPlayIntent = true;
      setHostPlaybackSessionPhase(session, "playing");
      const frame = elements.playerFrame;
      const video = pair.video;
      const audio = pair.audio;
      const captured = {
        session,
        program,
        frame,
        video,
        audio,
        videoSrc: video.src,
        videoCurrentSrc: video.currentSrc,
        audioSrc: audio.src,
        audioCurrentSrc: audio.currentSrc,
        generation: session.playbackGeneration,
        currentTime: video.currentTime,
      };
      window.__hostShellNodes = {
        ...captured,
        queue: document.querySelector(".queue-card"),
        request: document.querySelector("#host-workspace-request"),
        search: document.querySelector("#request-search-panel"),
        random: document.querySelector("#gatcha-panel"),
        users: document.querySelector("#session-users-panel"),
      };

      const forbidden = {
        mount: 0,
        replace: 0,
        claim: 0,
        retire: 0,
        load: 0,
        play: 0,
        pause: 0,
        seekEvents: 0,
        playerApiCalls: 0,
      };
      const originalMount = mountHostPlaybackSessionElements;
      const originalReplace = replaceHostPlayerView;
      const originalClaim = beginHostPlaybackSessionOwnershipClaim;
      const originalRetire = retireHostPlaybackSession;
      const originalApiPost = apiPost;
      const originalApiPostStateSnapshot = apiPostStateSnapshot;
      mountHostPlaybackSessionElements = (...args) => {
        forbidden.mount += 1;
        return originalMount(...args);
      };
      replaceHostPlayerView = (...args) => {
        forbidden.replace += 1;
        return originalReplace(...args);
      };
      beginHostPlaybackSessionOwnershipClaim = (...args) => {
        forbidden.claim += 1;
        return originalClaim(...args);
      };
      retireHostPlaybackSession = (...args) => {
        forbidden.retire += 1;
        return originalRetire(...args);
      };
      apiPost = (path, ...args) => {
        if (String(path).startsWith("/api/player/")) forbidden.playerApiCalls += 1;
        return originalApiPost(path, ...args);
      };
      apiPostStateSnapshot = (path, ...args) => {
        if (String(path).startsWith("/api/player/")) forbidden.playerApiCalls += 1;
        return originalApiPostStateSnapshot(path, ...args);
      };
      for (const media of [video, audio]) {
        Object.defineProperty(media, "load", {
          configurable: true,
          value: () => { forbidden.load += 1; },
        });
        Object.defineProperty(media, "play", {
          configurable: true,
          value: () => { forbidden.play += 1; return Promise.resolve(); },
        });
        Object.defineProperty(media, "pause", {
          configurable: true,
          value: () => { forbidden.pause += 1; },
        });
        media.addEventListener("seeking", () => { forbidden.seekEvents += 1; });
        media.addEventListener("seeked", () => { forbidden.seekEvents += 1; });
      }
      const frameObserver = new MutationObserver(() => {});
      frameObserver.observe(frame, { childList: true, subtree: true });
      let switchFrameMutations = 0;
      let snapshotFrameMutations = 0;
      let mediaMutations = 0;
      const consumeFrameMutations = (bucket) => {
        const records = frameObserver.takeRecords();
        if (bucket === "switch") switchFrameMutations += records.length;
        if (bucket === "snapshot") snapshotFrameMutations += records.length;
        mediaMutations += records.filter((record) => (
          [...record.addedNodes, ...record.removedNodes].some((node) => (
            node === video
            || node === audio
            || (node instanceof Element && Boolean(node.querySelector("video, audio")))
          ))
        )).length;
      };
      const scenarios = [];
      for (const scenario of [
        { phase: "playing", presentation: false, snapshot: false },
        { phase: "paused", presentation: false, snapshot: false },
        { phase: "binding", presentation: false, snapshot: true },
        { phase: "playing", presentation: true, snapshot: false },
      ]) {
        setHostPlaybackSessionPhase(session, scenario.phase);
        session.readyCommitted = scenario.phase !== "binding";
        if (scenario.presentation) {
          document.body.classList.add("is-presentation-stage-only");
        }
        for (let cycle = 0; cycle < 20; cycle += 1) {
          for (const workspace of ["request", "random", "users", "queue"]) {
            activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
            consumeFrameMutations("switch");
          }
          if (scenario.snapshot && cycle === 9) {
            render();
            consumeFrameMutations("snapshot");
          }
        }
        document.body.classList.remove("is-presentation-stage-only");
        scenarios.push({
          ...scenario,
          healthy: isCurrentHostPlaybackSession(session, video, audio),
          sessionStable: state.hostPlaybackSession === captured.session,
          programStable: session.playbackProgram === captured.program
            && state.data.playback_program === captured.program,
          frameStable: elements.playerFrame === captured.frame,
          videoStable: session.video === captured.video,
          audioStable: session.audio === captured.audio,
        });
      }
      consumeFrameMutations("snapshot");
      frameObserver.disconnect();
      mountHostPlaybackSessionElements = originalMount;
      replaceHostPlayerView = originalReplace;
      beginHostPlaybackSessionOwnershipClaim = originalClaim;
      retireHostPlaybackSession = originalRetire;
      apiPost = originalApiPost;
      apiPostStateSnapshot = originalApiPostStateSnapshot;
      setHostPlaybackSessionPhase(session, "paused");
      session.readyCommitted = true;
      return {
        scenarios,
        forbidden,
        switchFrameMutations,
        snapshotNonMediaFrameMutations: snapshotFrameMutations - mediaMutations,
        mediaMutations,
        videoCount: frame.querySelectorAll("video").length,
        audioCount: frame.querySelectorAll("audio").length,
        videoVisible: getComputedStyle(video).display !== "none",
        audioHidden: getComputedStyle(audio).display === "none",
        sourcesStable: video.src === captured.videoSrc
          && video.currentSrc === captured.videoCurrentSrc
          && audio.src === captured.audioSrc
          && audio.currentSrc === captured.audioCurrentSrc,
        generationStable: session.playbackGeneration === captured.generation
          && state.data.playback_generation === captured.generation,
        currentTimeStable: video.currentTime === captured.currentTime,
        finalWorkspace: state.activeHostWorkspace,
      };
    });
    assert(
      playerIdentity.scenarios.every((scenario) => scenario.healthy
        && scenario.sessionStable
        && scenario.programStable
        && scenario.frameStable
        && scenario.videoStable
        && scenario.audioStable),
      "rail cycling changed accepted playback ownership in a browser",
      playerIdentity,
    );
    assert(
      playerIdentity.videoCount === 1
        && playerIdentity.audioCount === 1
        && playerIdentity.videoVisible
        && playerIdentity.audioHidden
        && playerIdentity.sourcesStable
        && playerIdentity.generationStable
        && playerIdentity.currentTimeStable
        && playerIdentity.switchFrameMutations === 0
        && playerIdentity.mediaMutations === 0
        && Object.values(playerIdentity.forbidden).every((count) => count === 0)
        && playerIdentity.finalWorkspace === "queue",
      "workspace switching remounted or operated on the exact media pair",
      playerIdentity,
    );
    assert(
      shellPlayerRequests.length === playerRequestsBeforeSwitching,
      "workspace switching issued a network player request",
      shellPlayerRequests,
    );

    const queueSeed = await shellPage.evaluate(() => {
      const makeItem = (index, overrides = {}) => ({
        id: `queue-${index}`,
        item_incarnation_id: `queue-incarnation-${index}`,
        title: `Queue song ${index}`,
        display_title: `Queue song ${index}`,
        original_url: `https://www.bilibili.com/video/BVQUEUE${index}`,
        resolved_url: `https://www.bilibili.com/video/BVQUEUE${index}`,
        requester_name: `Singer ${index % 4}`,
        owner_name: `Owner ${index}`,
        cache_status: "ready",
        cache_progress: 1,
        cache_size_bytes: 2048 + index,
        requested_at: 1_700_000_000 + index,
        request_count: index + 1,
        key: `history-${index}`,
        ...overrides,
      });
      const currentItem = {
        ...state.data.current_item,
        display_title: "Browser shell current song",
        requester_name: "Current singer",
        owner_name: "Current owner",
        cache_status: "ready",
        cache_progress: 1,
        cache_size_bytes: 4096,
      };
      state.data = {
        ...state.data,
        current_item: currentItem,
        playlist: Array.from({ length: 28 }, (_, index) => makeItem(index)),
        history: Array.from({ length: 32 }, (_, index) => makeItem(index + 100)),
        state_revision: Number(state.data.state_revision || 0) + 1,
        player_settings: {
          ...(state.data.player_settings || {}),
          advance_delay_seconds: 0,
        },
      };
      state.listHeaderRenderSignature = "";
      state.historyRenderSignature = "";
      state.playlistEmptyRenderSignature = "";
      render();
      window.__queueAcceptance = {
        currentItem,
        playlist: [...state.data.playlist],
        history: [...state.data.history],
        originalApiPostStateSnapshot: apiPostStateSnapshot,
        originalApiPostExactStateCommand: apiPostExactStateCommand,
        originalRequestNextTrack: requestNextTrack,
        commands: [],
        nextCalls: [],
        reorderAccepted: true,
        session: state.hostPlaybackSession,
        frame: elements.playerFrame,
        video: state.hostPlaybackSession?.video,
        audio: state.hostPlaybackSession?.audio,
      };
      apiPostStateSnapshot = async (path, payload = {}) => {
        window.__queueAcceptance.commands.push({ path, payload });
        if (path === "/api/playlist/reorder") {
          if (!window.__queueAcceptance.reorderAccepted) {
            return false;
          }
          const items = [...state.data.playlist];
          const sourceIndex = items.findIndex((item) => item.id === payload.item_id);
          if (sourceIndex >= 0) {
            const [item] = items.splice(sourceIndex, 1);
            items.splice(Math.max(0, Math.min(payload.index, items.length)), 0, item);
            state.data.playlist = items;
          }
          return true;
        }
        return true;
      };
      apiPostExactStateCommand = async (path, payload = {}) => {
        window.__queueAcceptance.commands.push({ path, payload });
        return { snapshotAccepted: true, commandApplied: true };
      };
      requestNextTrack = async (expectedPlaybackGeneration = null) => {
        window.__queueAcceptance.nextCalls.push({
          expectedPlaybackGeneration,
          workspace: state.activeHostWorkspace,
          button: elements.nextButton,
        });
        return true;
      };
      return {
        queueRows: elements.playlist.querySelectorAll(".song-item").length,
        historyRows: elements.historyList.querySelectorAll(".history-item").length,
        currentVisible: !elements.queueCurrent.classList.contains("hidden"),
        nextOwner: elements.nextButton.closest(".player-panel") === elements.playerPanel,
        resortOwner: elements.resortPlaylistButton.closest("#host-workspace-queue")
          === document.querySelector("#host-workspace-queue"),
        requestHasResort: Boolean(document.querySelector("#host-workspace-request #resort-playlist-button")),
      };
    });
    assert(
      queueSeed.queueRows === 28
        && queueSeed.historyRows === 32
        && queueSeed.currentVisible
        && queueSeed.nextOwner
        && queueSeed.resortOwner
        && !queueSeed.requestHasResort,
      "long Queue/History data did not render on the final action owners",
      queueSeed,
    );

    const queueFixedBefore = await shellPage.evaluate(() => ({
      headerTop: document.querySelector(".queue-card-head").getBoundingClientRect().top,
      currentTop: elements.queueCurrent.getBoundingClientRect().top,
      workspaceScrollTop: elements.hostWorkspaceRegion.scrollTop,
      cardScrollTop: document.querySelector(".queue-card").scrollTop,
      playlistClientHeight: elements.playlist.clientHeight,
      playlistScrollHeight: elements.playlist.scrollHeight,
    }));
    const queueWheelScrollTop = {};
    for (const selector of [".song-title", ".song-progress-badge", ".menu-toggle"]) {
      await shellPage.locator("#playlist").evaluate((element) => { element.scrollTop = 0; });
      await shellPage.locator(`#playlist ${selector}`).first().hover();
      await shellPage.mouse.wheel(0, 260);
      await shellPage.waitForTimeout(60);
      queueWheelScrollTop[selector] = await shellPage.locator("#playlist").evaluate((element) => element.scrollTop);
    }
    await shellPage.locator("#playlist").evaluate((element) => { element.scrollTop = 0; });
    await shellPage.locator("#playlist .menu-toggle").first().click();
    await shellPage.locator("#playlist .menu-content:not(.hidden) [data-action='play-now']").hover();
    await shellPage.mouse.wheel(0, 260);
    await shellPage.waitForTimeout(60);
    queueWheelScrollTop.action = await shellPage.locator("#playlist").evaluate((element) => element.scrollTop);
    await shellPage.keyboard.press("Escape");
    await shellPage.locator("#playlist").evaluate((element) => { element.scrollTop = 0; });
    const firstRowBox = await shellPage.locator("#playlist .song-item").first().boundingBox();
    const secondRowBox = await shellPage.locator("#playlist .song-item").nth(1).boundingBox();
    assert(firstRowBox && secondRowBox, "Queue rows did not have rendered geometry");
    await shellPage.mouse.move(
      firstRowBox.x + (firstRowBox.width / 2),
      (firstRowBox.y + firstRowBox.height + secondRowBox.y) / 2,
    );
    await shellPage.mouse.wheel(0, 260);
    await shellPage.waitForTimeout(60);
    queueWheelScrollTop.gap = await shellPage.locator("#playlist").evaluate((element) => element.scrollTop);
    const queueFixedAfter = await shellPage.evaluate(() => ({
      headerTop: document.querySelector(".queue-card-head").getBoundingClientRect().top,
      currentTop: elements.queueCurrent.getBoundingClientRect().top,
      workspaceScrollTop: elements.hostWorkspaceRegion.scrollTop,
      cardScrollTop: document.querySelector(".queue-card").scrollTop,
      playlistScrollTop: elements.playlist.scrollTop,
      bodyScrollY: window.scrollY,
    }));
    assert(
      queueFixedBefore.playlistScrollHeight > queueFixedBefore.playlistClientHeight
        && Object.values(queueWheelScrollTop).every((scrollTop) => scrollTop > 0)
        && queueFixedAfter.headerTop === queueFixedBefore.headerTop
        && queueFixedAfter.currentTop === queueFixedBefore.currentTop
        && queueFixedAfter.workspaceScrollTop === 0
        && queueFixedAfter.cardScrollTop === 0
        && queueFixedAfter.bodyScrollY === 0,
      "Queue did not keep one native local list scroll owner below fixed content",
      { queueFixedBefore, queueFixedAfter, queueWheelScrollTop },
    );

    const directListScroll = await shellPage.evaluate(() => {
      elements.playlist.scrollTop = 311;
      activateHostWorkspace("history", { inputOrigin: "programmatic" });
      elements.historyList.scrollTop = 227;
      activateHostWorkspace("queue", { inputOrigin: "programmatic" });
      const queueRestored = elements.playlist.scrollTop;
      for (const workspace of ["history", "request", "random", "users", "queue"]) {
        activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
      }
      const roundTripQueue = elements.playlist.scrollTop;
      activateHostWorkspace("history", { inputOrigin: "programmatic" });
      const historyRestored = elements.historyList.scrollTop;
      render();
      render();
      const repeatedHistory = elements.historyList.scrollTop;
      activateHostWorkspace("queue", { inputOrigin: "programmatic" });
      const repeatedQueue = elements.playlist.scrollTop;
      return {
        queueRestored,
        roundTripQueue,
        historyRestored,
        repeatedQueue,
        repeatedHistory,
        activeWorkspace: state.activeHostWorkspace,
        sameQueue: elements.playlist === window.__hostShellQueueNodes.playlist,
        sameHistory: elements.historyList === window.__hostShellQueueNodes.historyList,
      };
    });
    assert(
      directListScroll.queueRestored === 311
        && directListScroll.roundTripQueue === 311
        && directListScroll.historyRestored === 227
        && directListScroll.repeatedQueue === 311
        && directListScroll.repeatedHistory === 227
        && directListScroll.activeWorkspace === "queue"
        && directListScroll.sameQueue
        && directListScroll.sameHistory,
      "Queue/History independent scroll state did not survive direct workspace and render round trips",
      directListScroll,
    );

    await shellPage.locator("#work-rail-history").click();
    const historyMenuTrigger = shellPage.locator("#history-list .menu-toggle").first();
    await historyMenuTrigger.click();
    await shellPage.keyboard.press("Escape");
    assert(
      await historyMenuTrigger.evaluate((element) => document.activeElement === element
        && element.getAttribute("aria-expanded") === "false")
        && !await shellPage.locator("#history-list .menu-content").first().isVisible(),
      "History row menu Escape did not close first and restore its trigger",
    );
    await historyMenuTrigger.click();
    await shellPage.locator("#work-rail-queue").click();
    assert(
      !await shellPage.locator("#history-list .menu-content").first().isVisible(),
      "hidden History retained an interactive row menu",
    );

    const layeredMenuTrigger = shellPage.locator("#playlist .menu-toggle").first();
    await layeredMenuTrigger.click();
    const layeredMenuAction = shellPage.locator("#playlist .menu-content:not(.hidden) button:not(:disabled)").first();
    await layeredMenuAction.focus();
    await shellPage.evaluate(() => {
      openConfirm({
        type: "escape-priority-proof",
        message: "Escape priority proof",
        focusElement: document.activeElement,
        x: 320,
        y: 220,
      });
      elements.confirmCancel.focus({ preventScroll: true });
    });
    await shellPage.keyboard.press("Escape");
    const confirmationMenuLayer = await shellPage.evaluate(() => ({
      confirmVisible: !elements.confirmPopover.classList.contains("hidden"),
      menuVisible: !document.querySelector("#playlist .menu-content")?.classList.contains("hidden"),
      activeAction: document.activeElement?.dataset?.action || "",
      openTriggerAction: state.openRowMenuTrigger?.dataset?.action || "",
    }));
    assert(
      !confirmationMenuLayer.confirmVisible
        && confirmationMenuLayer.menuVisible
        && await layeredMenuAction.evaluate((element) => document.activeElement === element),
      "confirmation Escape did not leave the lower row menu open and restore its opener",
      confirmationMenuLayer,
    );
    await shellPage.keyboard.press("Escape");
    assert(
      !await shellPage.locator("#playlist .menu-content").first().isVisible()
        && await layeredMenuTrigger.evaluate((element) => document.activeElement === element),
      "the next Escape did not close the row menu and restore its trigger",
    );

    const clearQueueCurrentId = await shellPage.evaluate(() => state.data.current_item?.id || "");
    await shellPage.locator("#clear-playlist-button").click();
    const clearQueueConfirmation = await shellPage.evaluate((currentId) => ({
      text: elements.confirmText.textContent,
      currentId,
      stillCurrent: state.data.current_item?.id === currentId,
      queueSize: state.data.playlist.length,
    }), clearQueueCurrentId);
    assert(
      await shellPage.locator("#confirm-popover").isVisible()
        && clearQueueConfirmation.text.includes("当前")
        && (clearQueueConfirmation.text.includes("保留")
          || clearQueueConfirmation.text.includes("不会受影响"))
        && clearQueueConfirmation.stillCurrent
        && clearQueueConfirmation.queueSize === 28,
      "Clear Queue confirmation did not explicitly preserve the current song",
      clearQueueConfirmation,
    );
    await shellPage.locator("#confirm-cancel").click();

    await shellPage.locator("#resort-playlist-button").click();
    const resortEvidence = await shellPage.evaluate(() => ({
      calls: window.__queueAcceptance.commands.filter((entry) => entry.path === "/api/playlist/resort"),
      busy: elements.resortPlaylistButton.getAttribute("aria-busy"),
      disabled: elements.resortPlaylistButton.disabled,
    }));
    assert(
      resortEvidence.calls.length === 1
        && resortEvidence.busy === null
        && !resortEvidence.disabled,
      "Queue-owned Resort did not preserve one guarded command",
      resortEvidence,
    );

    const firstMoveUp = shellPage.locator("#playlist .song-item").first().locator("[data-action='move-up']");
    const lastMoveDown = shellPage.locator("#playlist .song-item").last().locator("[data-action='move-down']");
    assert(await firstMoveUp.isDisabled() && await lastMoveDown.isDisabled(), "Queue reorder boundaries were enabled");
    const movingId = await shellPage.locator("#playlist .song-item").nth(1).getAttribute("data-id");
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] .menu-toggle`).click();
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] [data-action='move-up']`).click();
    assert(
      await shellPage.locator("#confirm-cancel").evaluate((element) => document.activeElement === element),
      "keyboard Queue move did not place focus inside its confirmation",
    );
    await shellPage.locator("#confirm-cancel").click();
    assert(
      await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] .menu-toggle`)
        .evaluate((element) => document.activeElement === element)
        && await shellPage.evaluate(() => window.__queueAcceptance.commands
          .filter((entry) => entry.path === "/api/playlist/reorder").length) === 0,
      "cancelled Queue move did not restore local focus without sending a command",
    );
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] .menu-toggle`).click();
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] [data-action='move-down']`).click();
    await shellPage.locator("#confirm-ok").click();
    await shellPage.waitForTimeout(60);
    const moveAccepted = await shellPage.evaluate((itemId) => ({
      orderIndex: state.data.playlist.findIndex((item) => item.id === itemId),
      call: window.__queueAcceptance.commands.filter((entry) => entry.path === "/api/playlist/reorder").at(-1),
      focusId: document.activeElement?.closest(".song-item")?.dataset.id || "",
      focusAction: document.activeElement?.dataset.action || "",
      announcement: elements.appToast.textContent,
    }), movingId);
    assert(
      moveAccepted.orderIndex === 2
        && moveAccepted.call?.payload?.item_id === movingId
        && moveAccepted.call?.payload?.index === 2
        && moveAccepted.focusId === movingId
        && moveAccepted.focusAction === "toggle-menu"
        && moveAccepted.announcement.includes("3"),
      "Move down did not send one exact target index, restore focus, and announce acceptance",
      moveAccepted,
    );
    await shellPage.evaluate(() => {
      window.__queueAcceptance.reorderAccepted = false;
      setAppMessage("");
    });
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] .menu-toggle`).click();
    await shellPage.locator(`#playlist .song-item[data-id='${movingId}'] [data-action='move-up']`).click();
    await shellPage.locator("#confirm-ok").click();
    await shellPage.waitForTimeout(60);
    const moveRejected = await shellPage.evaluate((itemId) => ({
      orderIndex: state.data.playlist.findIndex((item) => item.id === itemId),
      reorderCalls: window.__queueAcceptance.commands.filter((entry) => entry.path === "/api/playlist/reorder").length,
      focusId: document.activeElement?.closest(".song-item")?.dataset.id || "",
      announcement: elements.appToast.textContent,
      toastHidden: elements.appToast.classList.contains("hidden"),
    }), movingId);
    assert(
      moveRejected.orderIndex === 2
        && moveRejected.reorderCalls === 2
        && moveRejected.focusId === movingId
        && moveRejected.toastHidden
        && moveRejected.announcement === "",
      "rejected Queue reorder mutated order or announced false success",
      moveRejected,
    );

    await shellPage.evaluate(() => { window.__queueAcceptance.reorderAccepted = true; });
    const dragSource = shellPage.locator("#playlist .song-item").first().locator(".song-badge-column");
    const dragTarget = shellPage.locator("#playlist .song-item").nth(2);
    await dragSource.dragTo(dragTarget, { targetPosition: { x: 80, y: 70 } });
    assert(await shellPage.locator("#confirm-popover").isVisible(), "pointer drag did not retain reorder confirmation");
    await shellPage.locator("#confirm-ok").click();
    await shellPage.waitForTimeout(60);
    assert(
      await shellPage.evaluate(() => window.__queueAcceptance.commands
        .filter((entry) => entry.path === "/api/playlist/reorder").length) === 3,
      "pointer drag reorder did not share the single reorder command",
    );

    const retryEvidence = await shellPage.evaluate(() => {
      state.data.current_item.cache_status = "failed";
      state.data.current_item.cache_message = "browser retry proof";
      state.queueCurrentRenderSignature = "";
      renderQueueCurrent(state.data.current_item);
      return {
        visible: !elements.queueCurrentRetry.classList.contains("hidden"),
        id: elements.queueCurrentRetry.dataset.id,
        incarnation: elements.queueCurrentRetry.dataset.itemIncarnationId,
      };
    });
    assert(retryEvidence.visible, "current failed cache did not expose retry", retryEvidence);
    await shellPage.locator("#queue-current-retry").click();
    const retryCall = await shellPage.evaluate(() => window.__queueAcceptance.commands
      .filter((entry) => entry.path === "/api/cache/retry").at(-1));
    assert(
      retryCall?.payload?.item_id === retryEvidence.id
        && retryCall?.payload?.expected_item_incarnation_id === retryEvidence.incarnation
        && retryCall?.payload?.force === true,
      "current retry lost exact item-incarnation targeting",
      retryCall,
    );
    await shellPage.evaluate(() => {
      state.data.current_item.cache_status = "ready";
      state.data.current_item.cache_message = "";
      state.queueCurrentRenderSignature = "";
      renderQueueCurrent(state.data.current_item);
    });

    const nextButtonNode = await shellPage.locator("#next-button").evaluate((element) => {
      window.__queueNextButton = element;
      return Boolean(element.closest(".player-panel"));
    });
    assert(nextButtonNode, "Next was not Stage-owned");
    const nextVisibility = {};
    await shellPage.locator("#work-rail-queue").click();
    await shellPage.locator("#next-button").click();
    for (const workspace of ["queue", "history", "request", "random", "users"]) {
      await shellPage.locator(`#work-rail-${workspace}`).click();
      nextVisibility[workspace] = await shellPage.locator("#next-button").isVisible();
    }
    const nextEvidence = await shellPage.evaluate(() => ({
      calls: window.__queueAcceptance.nextCalls.map((entry) => entry.workspace),
      oneButton: document.querySelectorAll("#next-button").length,
      sameButton: elements.nextButton === window.__queueNextButton,
      sameSession: state.hostPlaybackSession === window.__queueAcceptance.session,
      sameFrame: elements.playerFrame === window.__queueAcceptance.frame,
      sameVideo: state.hostPlaybackSession?.video === window.__queueAcceptance.video,
      sameAudio: state.hostPlaybackSession?.audio === window.__queueAcceptance.audio,
    }));
    assert(
      nextEvidence.calls.join(",") === "queue"
        && Object.values(nextVisibility).every(Boolean)
        && nextEvidence.oneButton === 1
        && nextEvidence.sameButton
        && nextEvidence.sameSession
        && nextEvidence.sameFrame
        && nextEvidence.sameVideo
        && nextEvidence.sameAudio,
      "Stage Next was duplicated, hidden by a tool, or changed playback identity",
      nextEvidence,
    );

    const emptyQueueEvidence = await shellPage.evaluate(() => {
      activateHostWorkspace("queue", { inputOrigin: "programmatic" });
      const current = state.data.current_item;
      state.data.playlist = [];
      state.playlistEmptyRenderSignature = "";
      renderQueueCurrent(current);
      renderPlaylist([], current, state.data.cache_policy);
      const currentOnly = {
        currentVisible: !elements.queueCurrent.classList.contains("hidden"),
        emptyText: elements.playlist.textContent,
      };
      state.data.current_item = null;
      state.queueCurrentRenderSignature = "";
      state.playlistEmptyRenderSignature = "";
      renderQueueCurrent(null);
      renderPlaylist([], null, state.data.cache_policy);
      const noCurrent = {
        currentHidden: elements.queueCurrent.classList.contains("hidden"),
        emptyText: elements.playlist.textContent,
      };
      state.data.current_item = current;
      state.data.playlist = [...window.__queueAcceptance.playlist];
      state.queueCurrentRenderSignature = "";
      state.playlistEmptyRenderSignature = "";
      renderQueueCurrent(current);
      renderPlaylist(state.data.playlist, current, state.data.cache_policy);
      return { currentOnly, noCurrent };
    });
    assert(
      emptyQueueEvidence.currentOnly.currentVisible
        && emptyQueueEvidence.currentOnly.emptyText.length > 0
        && emptyQueueEvidence.noCurrent.currentHidden
        && emptyQueueEvidence.noCurrent.emptyText.length > 0
        && emptyQueueEvidence.currentOnly.emptyText !== emptyQueueEvidence.noCurrent.emptyText,
      "current-only and no-current Queue states were not distinct and honest",
      emptyQueueEvidence,
    );

    const queueAcceptance = await shellPage.evaluate(() => {
      const evidence = {
        commands: window.__queueAcceptance.commands,
        nextCalls: window.__queueAcceptance.nextCalls.length,
        sameSession: state.hostPlaybackSession === window.__queueAcceptance.session,
        sameFrame: elements.playerFrame === window.__queueAcceptance.frame,
        sameVideo: state.hostPlaybackSession?.video === window.__queueAcceptance.video,
        sameAudio: state.hostPlaybackSession?.audio === window.__queueAcceptance.audio,
        bodyScrollY: window.scrollY,
      };
      apiPostStateSnapshot = window.__queueAcceptance.originalApiPostStateSnapshot;
      apiPostExactStateCommand = window.__queueAcceptance.originalApiPostExactStateCommand;
      requestNextTrack = window.__queueAcceptance.originalRequestNextTrack;
      return evidence;
    });
    assert(
      queueAcceptance.sameSession
        && queueAcceptance.sameFrame
        && queueAcceptance.sameVideo
        && queueAcceptance.sameAudio
        && queueAcceptance.bodyScrollY === 0,
      "Queue/History acceptance changed exact playback identity or body scroll",
      queueAcceptance,
    );

    async function collectRequestSubviewLayout(subview) {
      await shellPage.locator(`[data-request-view="${subview}"]`).click();
      return shellPage.evaluate((activeSubview) => {
        const workspace = elements.requestWorkspace;
        const panel = workspace.querySelector(`[data-request-panel="${activeSubview}"]`);
        const owner = activeRequestScrollOwner() || panel;
        const workspaceRect = elements.hostWorkspaceRegion.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return {
          subview: activeSubview,
          width: elements.hostWorkspaceRegion.getBoundingClientRect().width,
          overlay: state.hostWorkspaceOverlayOpen && hostRequestWorkspaceUsesOverlay(),
          bodyScrollX: window.scrollX,
          bodyScrollY: window.scrollY,
          horizontalPageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          requestScrollTop: workspace.scrollTop,
          regionScrollTop: elements.hostWorkspaceRegion.scrollTop,
          workspaceOverflowY: getComputedStyle(workspace).overflowY,
          ownerOverflowY: getComputedStyle(owner).overflowY,
          ownerIsPanel: owner === panel,
          ownerScrollHeight: owner.scrollHeight,
          ownerClientHeight: owner.clientHeight,
          fixedControlsFit: panelRect.left >= workspaceRect.left - 1
            && panelRect.right <= workspaceRect.right + 1
            && panel.scrollWidth <= panel.clientWidth + 1,
          sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
          sameVideo: state.hostPlaybackSession?.video === window.__hostShellNodes.video,
          sameAudio: state.hostPlaybackSession?.audio === window.__hostShellNodes.audio,
        };
      }, subview);
    }

    const wideWidths = {};
    for (const workspace of ["queue", "history", "request", "random", "users"]) {
      await shellPage.locator(`#work-rail-${workspace}`).click();
      wideWidths[workspace] = await shellPage.evaluate(() => ({
        workspace: elements.hostWorkspaceRegion?.getBoundingClientRect().width || 0,
        stage: document.querySelector(".left-column")?.getBoundingClientRect().width || 0,
        sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
      }));
    }
    assert(
      Object.values(wideWidths).every((entry) => Math.abs(entry.workspace - wideWidths.queue.workspace) <= 1)
        && Math.abs(wideWidths.queue.workspace + shellInitial.railWidth - 640) <= 2
        && Object.values(wideWidths).every((entry) => entry.stage >= 760 && entry.sameFrame),
      "wide shell did not preserve one 640px tool-dock width and a useful persistent Stage",
      wideWidths,
    );
    await shellPage.locator("#work-rail-request").click();
    const wideRequestSubviews = {};
    for (const subview of ["quick", "search", "discover", "sources"]) {
      wideRequestSubviews[subview] = await collectRequestSubviewLayout(subview);
    }
    assert(
      Object.values(wideRequestSubviews).every((entry) => (
        Math.abs(entry.width - wideWidths.queue.workspace) <= 1
          && !entry.overlay
          && entry.bodyScrollX === 0
          && entry.bodyScrollY === 0
          && !entry.horizontalPageScroll
          && entry.requestScrollTop === 0
          && entry.regionScrollTop === 0
          && entry.workspaceOverflowY === "hidden"
          && entry.fixedControlsFit
          && entry.sameFrame
          && entry.sameVideo
          && entry.sameAudio
      )),
      "wide Request subviews did not preserve the stable dock width, bounded controls, local scrolling, and Stage identity",
      wideRequestSubviews,
    );
    await shellPage.locator('[data-request-view="search"]').click();

    const draftAndScroll = await shellPage.evaluate(() => {
      document.querySelector("#url-input").value = "BV-DRAFT-REQUEST";
      document.querySelector("#lark-search-query").value = "search draft";
      document.querySelector("#modal-follow-uid-input").value = "source draft";
      document.querySelector("#session-user-input").value = "user draft";
      activateHostWorkspace("random", { inputOrigin: "programmatic" });
      const spacer = document.createElement("div");
      spacer.id = "host-shell-scroll-proof";
      spacer.style.height = "1800px";
      spacer.style.flex = "0 0 1800px";
      document.querySelector("#gatcha-main-view").appendChild(spacer);
      elements.gatchaStage.scrollTop = 275;
      const storedBefore = elements.gatchaStage.scrollTop;
      activateHostWorkspace("queue", { inputOrigin: "programmatic" });
      activateHostWorkspace("random", { inputOrigin: "programmatic" });
      const restored = elements.gatchaStage.scrollTop;
      spacer.remove();
      return {
        storedBefore,
        restored,
        drafts: [
          document.querySelector("#url-input").value,
          document.querySelector("#lark-search-query").value,
          document.querySelector("#modal-follow-uid-input").value,
          document.querySelector("#session-user-input").value,
        ],
        sameNodes: document.querySelector(".queue-card") === window.__hostShellNodes.queue
          && document.querySelector("#host-workspace-request") === window.__hostShellNodes.request
          && document.querySelector("#request-search-panel") === window.__hostShellNodes.search
          && document.querySelector("#gatcha-panel") === window.__hostShellNodes.random
          && document.querySelector("#session-users-panel") === window.__hostShellNodes.users,
      };
    });
    assert(
      draftAndScroll.storedBefore > 0
        && draftAndScroll.restored === draftAndScroll.storedBefore
        && draftAndScroll.drafts.join("|") === "BV-DRAFT-REQUEST|search draft|source draft|user draft"
        && draftAndScroll.sameNodes,
      "workspace-local draft, scroll, or DOM state did not survive switching",
      draftAndScroll,
    );

    const bannerEvidence = await shellPage.evaluate(async () => {
      const banner = document.querySelector("#backup-banner");
      const region = document.querySelector("#critical-banner-region");
      const frame = elements.playerFrame;
      const collapsed = region.getBoundingClientRect().height;
      banner.classList.remove("hidden");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const expanded = region.getBoundingClientRect().height;
      const sameFrameExpanded = elements.playerFrame === frame;
      banner.classList.add("hidden");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        collapsed,
        expanded,
        collapsedAgain: region.getBoundingClientRect().height,
        sameFrameExpanded,
        sameFrameCollapsed: elements.playerFrame === frame,
      };
    });
    assert(
      bannerEvidence.collapsed === 0
        && bannerEvidence.expanded > 0
        && bannerEvidence.collapsedAgain === 0
        && bannerEvidence.sameFrameExpanded
        && bannerEvidence.sameFrameCollapsed,
      "critical banner row did not expand/collapse without recreating the Stage",
      bannerEvidence,
    );

    await shellPage.locator("#work-rail-queue").click();
    await shellPage.locator("#display-settings-toggle").click();
    assert(await shellPage.locator("#display-settings-panel").isVisible(), "compact toolbar lost Display settings");
    await shellPage.keyboard.press("Escape");
    await shellPage.locator("#cache-settings-toggle").click();
    assert(await shellPage.locator("#cache-panel").isVisible(), "compact toolbar lost Service settings");
    await shellPage.keyboard.press("Escape");

    const shellWideScreenshotPath = suffixedPath(screenshotPath, "-wide");
    const shellMediumScreenshotPath = suffixedPath(screenshotPath, "-medium");
    const shellNarrowScreenshotPath = suffixedPath(screenshotPath, "-narrow");
    const shellDefaultScreenshotPath = suffixedPath(screenshotPath, "-default-1024x700");
    const shellShortScreenshotPath = suffixedPath(screenshotPath, "-short-1280x640");
    const queueWideScreenshotPath = suffixedPath(screenshotPath, "-wide-queue");
    const historyWideScreenshotPath = suffixedPath(screenshotPath, "-wide-history");
    const queueMediumScreenshotPath = suffixedPath(screenshotPath, "-medium-queue");
    const queueNarrowScreenshotPath = suffixedPath(screenshotPath, "-narrow-queue");
    const historyNarrowScreenshotPath = suffixedPath(screenshotPath, "-narrow-history");
    const narrowControlsScreenshotPath = suffixedPath(screenshotPath, "-narrow-controls");
    if (shellWideScreenshotPath) {
      await shellPage.locator("#work-rail-queue").click();
      await shellPage.screenshot({ path: queueWideScreenshotPath, fullPage: false });
      await shellPage.locator("#work-rail-history").click();
      await shellPage.screenshot({ path: historyWideScreenshotPath, fullPage: false });
      await shellPage.locator("#work-rail-request").click();
      await shellPage.screenshot({ path: shellWideScreenshotPath, fullPage: false });
    }

    async function collectResponsiveFrame(label, width, height) {
      await shellPage.setViewportSize({ width, height });
      await shellPage.waitForTimeout(120);
      const tools = {};
      for (const workspace of ["queue", "history", "request", "random", "users"]) {
        await shellPage.locator(`#work-rail-${workspace}`).click();
        tools[workspace] = await shellPage.evaluate((name) => {
          const regionElement = elements.hostWorkspaceRegion;
          const railElement = document.querySelector(".work-rail");
          const region = regionElement.getBoundingClientRect();
          const rail = railElement.getBoundingClientRect();
          const stage = document.querySelector(".left-column").getBoundingClientRect();
          const playerCard = elements.playerPanel.getBoundingClientRect();
          return {
            active: state.activeHostWorkspace,
            visible: Array.from(elements.hostWorkspacePanels || [])
              .filter((panel) => !panel.hidden)
              .every((panel) => panel.dataset.hostWorkspacePanel === name),
            contentWidth: region.width,
            railWidth: rail.width,
            dockRight: rail.right,
            railGap: rail.left - region.right,
            railIndependent: railElement.parentElement?.classList.contains("layout")
              && regionElement.parentElement?.classList.contains("host-content-region"),
            stageWidth: stage.width,
            stageHeight: stage.height,
            stageToolGap: window.matchMedia("(max-width: 1039px)").matches
              ? region.top - playerCard.bottom
              : region.left - playerCard.right,
            mode: elements.appShell.dataset.stageMode,
            sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
            sameVideo: state.hostPlaybackSession?.video === window.__hostShellNodes.video,
            sameAudio: state.hostPlaybackSession?.audio === window.__hostShellNodes.audio,
          };
        }, workspace);
      }
      await shellPage.locator("#work-rail-request").click();
      const requestSubviews = {};
      for (const subview of ["quick", "search", "discover", "sources"]) {
        requestSubviews[subview] = await collectRequestSubviewLayout(subview);
      }
      const shell = await shellPage.evaluate(() => {
        const toolbar = document.querySelector(".topbar").getBoundingClientRect();
        const rail = document.querySelector(".work-rail").getBoundingClientRect();
        const left = document.querySelector(".left-column");
        return {
          toolbarHeight: toolbar.height,
          rightEdgeDelta: Math.abs(toolbar.right - rail.right),
          bodyScrollX: window.scrollX,
          bodyScrollY: window.scrollY,
          pageHorizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          pageVerticalScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
          stageMode: elements.appShell.dataset.stageMode,
          stageClientHeight: left.clientHeight,
          stageScrollHeight: left.scrollHeight,
          trayClosed: elements.stageControlTray.hidden && elements.stageControlTray.inert,
        };
      });
      const toolValues = Object.values(tools);
      const contentWidth = toolValues[0].contentWidth;
      assert(
        toolValues.every((entry) => entry.active
          && entry.visible
          && Math.abs(entry.contentWidth - contentWidth) <= 1
          && entry.railGap >= 8
          && entry.stageToolGap >= 8
          && entry.railIndependent
          && entry.stageHeight >= 180
          && entry.sameFrame
          && entry.sameVideo
          && entry.sameAudio),
        `${label} changed tool geometry or media identity while switching direct tools`,
        { tools, shell },
      );
      assert(
        Object.values(requestSubviews).every((entry) => Math.abs(entry.width - contentWidth) <= 1
          && !entry.overlay
          && entry.bodyScrollX === 0
          && entry.bodyScrollY === 0
          && !entry.horizontalPageScroll
          && entry.workspaceOverflowY === "hidden"
          && entry.fixedControlsFit
          && entry.sameFrame
          && entry.sameVideo
          && entry.sameAudio),
        `${label} changed dock width or media identity between Request subviews`,
        requestSubviews,
      );
      assert(
        shell.toolbarHeight >= 52
          && shell.toolbarHeight <= 64
          && shell.rightEdgeDelta <= 1
          && shell.bodyScrollX === 0
          && shell.bodyScrollY === 0
          && !shell.pageHorizontalScroll
          && !shell.pageVerticalScroll
          && shell.stageScrollHeight <= shell.stageClientHeight + 1,
        `${label} violated toolbar alignment, page-scroll, or fitted Stage geometry`,
        { tools, requestSubviews, shell },
      );
      return { width, height, tools, requestSubviews, shell };
    }

    const responsiveFrames = {};
    for (const [label, width, height] of [
      ["wide1600", 1600, 900],
      ["wide1536", 1536, 1024],
      ["wide1496", 1496, 992],
      ["medium1240", 1240, 800],
      ["default1024", 1024, 700],
      ["narrow840", 840, 760],
      ["short1280", 1280, 640],
      ["minimum700", 700, 700],
    ]) {
      responsiveFrames[label] = await collectResponsiveFrame(label, width, height);
      if (label === "medium1240" && shellMediumScreenshotPath) {
        await shellPage.screenshot({ path: shellMediumScreenshotPath, fullPage: false });
      }
      if (label === "default1024" && shellDefaultScreenshotPath) {
        await shellPage.screenshot({ path: shellDefaultScreenshotPath, fullPage: false });
      }
      if (label === "narrow840" && shellNarrowScreenshotPath) {
        await shellPage.screenshot({ path: shellNarrowScreenshotPath, fullPage: false });
      }
      if (label === "short1280" && shellShortScreenshotPath) {
        await shellPage.screenshot({ path: shellShortScreenshotPath, fullPage: false });
      }
    }
    assert(
      Math.abs(responsiveFrames.wide1600.tools.queue.contentWidth - 536) <= 2
        && Math.abs(responsiveFrames.wide1536.tools.queue.contentWidth - 536) <= 2
        && Math.abs(responsiveFrames.medium1240.tools.queue.contentWidth - 500) <= 2
        && Math.abs(responsiveFrames.wide1600.tools.queue.railWidth - 104) <= 2
        && Math.abs(responsiveFrames.medium1240.tools.queue.railWidth - 100) <= 2,
      "wide/medium states did not keep one stable tool-card width beside the independent rail",
      responsiveFrames,
    );

    await shellPage.setViewportSize({ width: 1240, height: 800 });
    await shellPage.locator("#work-rail-queue").click();
    const mediumQueue = await shellPage.evaluate(() => ({
      mode: elements.appShell.dataset.stageMode,
      listClientHeight: elements.playlist.clientHeight,
      listScrollHeight: elements.playlist.scrollHeight,
      nextVisible: Boolean(elements.nextButton.offsetWidth || elements.nextButton.offsetHeight),
      bodyScrollY: window.scrollY,
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
    }));
    assert(mediumQueue.listClientHeight > 40
      && mediumQueue.listScrollHeight > mediumQueue.listClientHeight
      && mediumQueue.nextVisible
      && mediumQueue.bodyScrollY === 0
      && mediumQueue.sameFrame,
    "medium Queue lost its fixed actions or useful local list owner", mediumQueue);
    if (queueMediumScreenshotPath) {
      await shellPage.screenshot({ path: queueMediumScreenshotPath, fullPage: false });
    }
    const mediumRequestOpen = responsiveFrames.medium1240.shell;
    const mediumRequestSubviews = responsiveFrames.medium1240.requestSubviews;
    const mediumRequestClosed = { overlayOpen: false, directDock: true };

    await shellPage.setViewportSize({ width: 840, height: 760 });
    await shellPage.waitForTimeout(120);
    await shellPage.locator("#work-rail-queue").click();
    const narrowInitial = responsiveFrames.narrow840.shell;
    const narrowQueue = await shellPage.evaluate(() => ({
      workspace: state.activeHostWorkspace,
      listClientHeight: elements.playlist.clientHeight,
      listScrollHeight: elements.playlist.scrollHeight,
      nextVisible: Boolean(elements.nextButton.offsetWidth || elements.nextButton.offsetHeight),
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
    }));
    assert(narrowQueue.workspace === "queue"
      && narrowQueue.listClientHeight > 40
      && narrowQueue.listScrollHeight > narrowQueue.listClientHeight
      && narrowQueue.nextVisible
      && narrowQueue.sameFrame,
    "narrow Queue lost direct actions or its local list owner", narrowQueue);
    if (queueNarrowScreenshotPath) {
      await shellPage.screenshot({ path: queueNarrowScreenshotPath, fullPage: false });
    }
    await shellPage.locator("#work-rail-history").click();
    const narrowHistory = await shellPage.evaluate(() => ({
      workspace: state.activeHostWorkspace,
      listClientHeight: elements.historyList.clientHeight,
      listScrollHeight: elements.historyList.scrollHeight,
      actionsVisible: Boolean(elements.clearHistoryButton.offsetWidth || elements.clearHistoryButton.offsetHeight),
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
    }));
    assert(narrowHistory.workspace === "history"
      && narrowHistory.listClientHeight > 40
      && narrowHistory.listScrollHeight > narrowHistory.listClientHeight
      && narrowHistory.actionsVisible
      && narrowHistory.sameFrame,
    "narrow History lost direct actions or its local list owner", narrowHistory);
    if (historyNarrowScreenshotPath) {
      await shellPage.screenshot({ path: historyNarrowScreenshotPath, fullPage: false });
    }

    await shellPage.locator("#stage-controls-toggle").click();
    await shellPage.waitForTimeout(180);
    const narrowControlEvidence = await shellPage.evaluate(() => ({
      mode: elements.appShell.dataset.stageMode,
      open: !elements.stageControlTray.hidden && !elements.stageControlTray.inert,
      backdrop: !elements.stageControlBackdrop.hidden && !elements.stageControlBackdrop.inert,
      opacity: Number(getComputedStyle(elements.stageControlTray).opacity),
      focusAtClose: document.activeElement === elements.stageControlsClose,
      activeElement: document.activeElement?.id || document.activeElement?.tagName || "",
      oneDeck: document.querySelectorAll("#stage-extended-controls").length,
      controls: ["#av-offset-input", "#volume-slider", "#key-shift-input"].map((selector) => {
        const control = document.querySelector(selector);
        return Boolean(control?.offsetWidth || control?.offsetHeight || control?.getClientRects().length);
      }),
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
      sameVideo: state.hostPlaybackSession?.video === window.__hostShellNodes.video,
      sameAudio: state.hostPlaybackSession?.audio === window.__hostShellNodes.audio,
      geometry: (() => {
        const player = elements.playerPanel.getBoundingClientRect();
        const trigger = elements.stageControlsToggle.getBoundingClientRect();
        const tray = elements.stageControlTray.getBoundingClientRect();
        return {
          triggerAtLowerLeft: trigger.left - player.left <= 32
            && player.bottom - trigger.bottom <= 32,
          expandsRightAndUp: tray.right > trigger.right && tray.top < trigger.top,
          trayInsideViewport: tray.left >= 0 && tray.top >= 0
            && tray.right <= window.innerWidth + 1 && tray.bottom <= window.innerHeight + 1,
        };
      })(),
    }));
    assert(narrowControlEvidence.mode === "narrow"
      && narrowControlEvidence.open
      && narrowControlEvidence.backdrop
      && narrowControlEvidence.opacity === 1
      && narrowControlEvidence.focusAtClose
      && narrowControlEvidence.oneDeck === 1
      && narrowControlEvidence.controls.every(Boolean)
      && Object.values(narrowControlEvidence.geometry).every(Boolean)
      && narrowControlEvidence.sameFrame
      && narrowControlEvidence.sameVideo
      && narrowControlEvidence.sameAudio,
    "narrow bounded control tray did not expose the one existing control deck", narrowControlEvidence);
    if (narrowControlsScreenshotPath) {
      await shellPage.screenshot({ path: narrowControlsScreenshotPath, fullPage: false });
    }
    await shellPage.keyboard.press("Shift+Tab");
    assert(
      await shellPage.evaluate(() => elements.stageControlTray.contains(document.activeElement)),
      "Stage tray did not contain backward keyboard focus",
    );
    await shellPage.locator("#stage-control-backdrop").click({ position: { x: 4, y: 4 } });
    assert(await shellPage.evaluate(() => elements.stageControlTray.hidden
      && elements.stageControlBackdrop.hidden
      && document.activeElement === elements.stageControlsToggle),
    "Stage tray backdrop did not close the floating layer and restore its opener");
    await shellPage.locator("#stage-controls-toggle").click();
    await shellPage.locator("#stage-controls-close").click();
    assert(await shellPage.evaluate(() => elements.stageControlTray.hidden
      && elements.stageControlBackdrop.hidden
      && document.activeElement === elements.stageControlsToggle),
    "Stage tray close button did not close the floating layer and restore its opener");
    await shellPage.locator("#stage-controls-toggle").click();
    await shellPage.keyboard.press("Escape");
    assert(await shellPage.evaluate(() => elements.stageControlTray.hidden
      && elements.stageControlBackdrop.hidden
      && elements.stageControlTray.inert
      && document.activeElement === elements.stageControlsToggle),
    "Stage tray Escape did not close one layer and restore its opener");
    const narrowWorkspaces = responsiveFrames.narrow840.tools;
    const narrowRequestSubviews = responsiveFrames.narrow840.requestSubviews;
    const narrowLocalScroll = await shellPage.evaluate(() => {
      activateHostWorkspace("random", { inputOrigin: "programmatic" });
      const spacer = document.createElement("div");
      spacer.style.height = "1500px";
      document.querySelector("#gatcha-main-view").appendChild(spacer);
      elements.gatchaStage.scrollTop = 360;
      const evidence = {
        workspaceScrollTop: elements.gatchaStage.scrollTop,
        workspaceClientHeight: elements.gatchaStage.clientHeight,
        workspaceScrollHeight: elements.gatchaStage.scrollHeight,
        bodyScrollY: window.scrollY,
      };
      spacer.remove();
      return evidence;
    });
    assert(narrowLocalScroll.workspaceScrollTop > 0
      && narrowLocalScroll.workspaceScrollHeight > narrowLocalScroll.workspaceClientHeight
      && narrowLocalScroll.bodyScrollY === 0,
    "active narrow workspace did not own its bounded local scroll", narrowLocalScroll);

    const gatchaWideScreenshotPath = suffixedPath(screenshotPath, "-wide-gatcha");
    const gatchaErrorScreenshotPath = suffixedPath(screenshotPath, "-wide-gatcha-error");
    const gatchaPoolScreenshotPath = suffixedPath(screenshotPath, "-wide-gatcha-pool");
    const gatchaMediumScreenshotPath = suffixedPath(screenshotPath, "-medium-gatcha");
    const gatchaNarrowScreenshotPath = suffixedPath(screenshotPath, "-narrow-gatcha");
    const playerRequestsBeforeGatcha = shellPlayerRequests.length;
    await shellPage.evaluate(() => {
      window.__gatchaInvariant = {
        mount: 0,
        replace: 0,
        claim: 0,
        retire: 0,
        originalMount: mountHostPlaybackSessionElements,
        originalReplace: replaceHostPlayerView,
        originalClaim: beginHostPlaybackSessionOwnershipClaim,
        originalRetire: retireHostPlaybackSession,
      };
      mountHostPlaybackSessionElements = (...args) => {
        window.__gatchaInvariant.mount += 1;
        return window.__gatchaInvariant.originalMount(...args);
      };
      replaceHostPlayerView = (...args) => {
        window.__gatchaInvariant.replace += 1;
        return window.__gatchaInvariant.originalReplace(...args);
      };
      beginHostPlaybackSessionOwnershipClaim = (...args) => {
        window.__gatchaInvariant.claim += 1;
        return window.__gatchaInvariant.originalClaim(...args);
      };
      retireHostPlaybackSession = (...args) => {
        window.__gatchaInvariant.retire += 1;
        return window.__gatchaInvariant.originalRetire(...args);
      };
    });
    await shellPage.setViewportSize({ width: 1600, height: 900 });
    await shellPage.waitForTimeout(120);
    await shellPage.locator("#work-rail-random").click();
    const gatchaInitial = await shellPage.evaluate(() => {
      state.data = {
        ...(state.data || {}),
        session_users: ["Exact Requester"],
      };
      renderRequesterSelect(state.data.session_users);
      elements.requesterSelect.value = "Exact Requester";
      window.__gatchaNodes = {
        panel: elements.gatchaPanel,
        stage: elements.gatchaStage,
        main: elements.gatchaMainView,
        session: state.hostPlaybackSession,
        frame: elements.playerFrame,
        video: state.hostPlaybackSession?.video,
        audio: state.hostPlaybackSession?.audio,
      };
      return {
        view: state.gatchaView,
        candidate: state.gatchaCandidate,
        visibleViews: Array.from(elements.gatchaStateViews)
          .filter((view) => !view.hidden)
          .map((view) => view.dataset.gatchaView),
        drawVisible: !elements.gatchaButton.hidden,
        poolVisible: !elements.gatchaPoolConfigToggle.hidden,
        manageVisible: !elements.manageSourcesButton.hidden,
        candidateCount: document.querySelectorAll("#gatcha-panel").length,
        poolCount: document.querySelectorAll("#gatcha-pool-config-modal").length,
        manageCount: document.querySelectorAll("#manage-sources-button").length,
        bodyScrollY: window.scrollY,
      };
    });
    assert(
      gatchaInitial.view === "idle"
        && gatchaInitial.candidate === null
        && gatchaInitial.visibleViews.join(",") === "idle"
        && gatchaInitial.drawVisible
        && gatchaInitial.poolVisible
        && gatchaInitial.manageVisible
        && gatchaInitial.candidateCount === 1
        && gatchaInitial.poolCount === 1
        && gatchaInitial.manageCount === 1
        && gatchaInitial.bodyScrollY === 0
        && shellGatchaCandidateRequests.length === 0
        && shellPoolConfigRequests.length === 0,
      "fresh Gatcha was not one honest idle workspace or fetched implicitly",
      { gatchaInitial, shellGatchaCandidateRequests, shellPoolConfigRequests },
    );

    await shellPage.locator("#gatcha-button").click();
    await shellPage.waitForTimeout(40);
    const gatchaDrawing = await shellPage.evaluate(() => ({
      view: state.gatchaView,
      busy: state.gatchaDrawBusy,
      disabled: elements.gatchaButton.disabled,
      ariaBusy: elements.gatchaButton.getAttribute("aria-busy"),
      label: elements.gatchaButton.textContent,
      candidate: state.gatchaCandidate,
    }));
    await shellPage.locator("#gatcha-button").evaluate((button) => {
      button.click();
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", bubbles: true }));
    });
    await shellPage.locator("#work-rail-queue").click();
    await shellPage.locator("#work-rail-random").click();
    assert(
      gatchaDrawing.view === "drawing"
        && gatchaDrawing.busy
        && gatchaDrawing.disabled
        && gatchaDrawing.ariaBusy === "true"
        && gatchaDrawing.label.length > 0
        && gatchaDrawing.candidate === null
        && shellGatchaCandidateRequests.length === 1
        && shellPoolConfigRequests.length === 0,
      "Draw did not expose one immediate busy request across a workspace round trip",
      { gatchaDrawing, requests: shellGatchaCandidateRequests.length },
    );
    const firstDrawRoute = shellGatchaCandidateRoutes.shift();
    assert(firstDrawRoute, "Draw did not leave one deferred candidate route");
    await fulfillJson(firstDrawRoute, {
      bvid: "BVGATCHA1",
      url: "https://www.bilibili.com/video/BVGATCHA1",
      title: "First accepted Gatcha candidate",
    });
    await shellPage.waitForFunction(() => state.gatchaView === "candidate" && !state.gatchaDrawBusy);
    const gatchaRoundTrip = await shellPage.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "gatcha-round-trip-spacer";
      spacer.style.height = "1200px";
      spacer.style.flex = "0 0 1200px";
      elements.gatchaMainView.appendChild(spacer);
      elements.gatchaStage.scrollTop = 167;
      const before = elements.gatchaStage.scrollTop;
      for (const workspace of ["queue", "request", "users", "random"]) {
        activateHostWorkspace(workspace, { inputOrigin: "programmatic" });
      }
      render();
      render();
      const evidence = {
        title: state.gatchaCandidate?.title,
        view: state.gatchaView,
        scrollBefore: before,
        scrollAfter: elements.gatchaStage.scrollTop,
        samePanel: elements.gatchaPanel === window.__gatchaNodes.panel,
        sameStage: elements.gatchaStage === window.__gatchaNodes.stage,
        sameMain: elements.gatchaMainView === window.__gatchaNodes.main,
        sameSession: state.hostPlaybackSession === window.__gatchaNodes.session,
        sameFrame: elements.playerFrame === window.__gatchaNodes.frame,
        sameVideo: state.hostPlaybackSession?.video === window.__gatchaNodes.video,
        sameAudio: state.hostPlaybackSession?.audio === window.__gatchaNodes.audio,
      };
      spacer.remove();
      return evidence;
    });
    assert(
      gatchaRoundTrip.title === "First accepted Gatcha candidate"
        && gatchaRoundTrip.view === "candidate"
        && gatchaRoundTrip.scrollBefore > 0
        && gatchaRoundTrip.scrollAfter === gatchaRoundTrip.scrollBefore
        && gatchaRoundTrip.samePanel
        && gatchaRoundTrip.sameStage
        && gatchaRoundTrip.sameMain
        && gatchaRoundTrip.sameSession
        && gatchaRoundTrip.sameFrame
        && gatchaRoundTrip.sameVideo
        && gatchaRoundTrip.sameAudio
        && shellGatchaCandidateRequests.length === 1
        && shellPoolConfigRequests.length === 0,
      "accepted Gatcha state, scroll, DOM, or playback identity did not survive render/workspace round trips",
      gatchaRoundTrip,
    );

    await shellPage.locator("#gatcha-retry-button").click();
    await shellPage.waitForTimeout(30);
    const oldDrawRoute = shellGatchaCandidateRoutes.shift();
    assert(oldDrawRoute, "stale draw proof did not capture the older route");
    await shellPage.evaluate(() => {
      state.gatchaDrawBusy = false;
      state.gatchaView = "error";
      renderGatchaWorkspace();
    });
    await shellPage.locator("#gatcha-retry-button").click();
    await shellPage.waitForTimeout(30);
    const newDrawRoute = shellGatchaCandidateRoutes.shift();
    assert(newDrawRoute, "stale draw proof did not capture the newer route");
    await fulfillJson(newDrawRoute, {
      bvid: "BVGATCHA2",
      url: "https://www.bilibili.com/video/BVGATCHA2",
      title: "Newer accepted Gatcha candidate",
    });
    await shellPage.waitForFunction(() => state.gatchaCandidate?.bvid === "BVGATCHA2");
    await fulfillJson(oldDrawRoute, {
      bvid: "BVGATCHAOLD",
      url: "https://www.bilibili.com/video/BVGATCHAOLD",
      title: "Obsolete delayed candidate",
    });
    await shellPage.waitForTimeout(80);
    const staleDraw = await shellPage.evaluate(() => ({
      bvid: state.gatchaCandidate?.bvid,
      title: state.gatchaCandidate?.title,
      view: state.gatchaView,
      busy: state.gatchaDrawBusy,
    }));
    assert(
      staleDraw.bvid === "BVGATCHA2"
        && staleDraw.title === "Newer accepted Gatcha candidate"
        && staleDraw.view === "candidate"
        && !staleDraw.busy,
      "a delayed older draw overwrote the newer accepted candidate",
      staleDraw,
    );

    await shellPage.locator("#gatcha-retry-button").click();
    await shellPage.waitForTimeout(30);
    const failedDrawRoute = shellGatchaCandidateRoutes.shift();
    await fulfillJson(
      failedDrawRoute,
      "A bounded but deliberately long Gatcha draw error that remains inside the workspace and offers a retry action.",
      { ok: false },
    );
    await shellPage.waitForFunction(() => state.gatchaView === "error" && !state.gatchaDrawBusy);
    const drawError = await shellPage.evaluate(() => ({
      view: state.gatchaView,
      retainedBvid: state.gatchaCandidate?.bvid,
      retryVisible: !elements.gatchaRetryButton.hidden,
      message: elements.gatchaMessage.textContent,
      bodyScrollY: window.scrollY,
    }));
    assert(
      drawError.view === "error"
        && drawError.retainedBvid === "BVGATCHA2"
        && drawError.retryVisible
        && drawError.message.includes("deliberately long")
        && drawError.bodyScrollY === 0,
      "failed Draw did not retain the last accepted candidate and an honest bounded retry state",
      drawError,
    );
    if (gatchaErrorScreenshotPath) {
      await shellPage.screenshot({ path: gatchaErrorScreenshotPath, fullPage: false });
    }
    await shellPage.locator("#gatcha-retry-button").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellGatchaCandidateRoutes.shift(), {
      bvid: "BVGATCHA3",
      url: "https://www.bilibili.com/video/BVGATCHA3",
      title: "Recovered candidate with deliberately long copy ".repeat(8),
    });
    await shellPage.waitForFunction(() => state.gatchaCandidate?.bvid === "BVGATCHA3");
    if (gatchaWideScreenshotPath) {
      await shellPage.screenshot({ path: gatchaWideScreenshotPath, fullPage: false });
    }

    const sourceCountsBeforeManage = {
      candidate: shellGatchaCandidateRequests.length,
      pool: shellPoolConfigRequests.length,
      management: shellSourceManagementRequests.length,
    };
    await shellPage.locator("#manage-sources-button").click();
    const manageSources = await shellPage.evaluate(() => ({
      workspace: state.activeHostWorkspace,
      subview: state.requestSubview,
      sourcesMode: state.sourcesMode,
      candidateBvid: state.gatchaCandidate?.bvid,
      samePanel: elements.gatchaPanel === window.__gatchaNodes.panel,
    }));
    assert(
      manageSources.workspace === "request"
        && manageSources.subview === "sources"
        && manageSources.candidateBvid === "BVGATCHA3"
        && manageSources.samePanel
        && shellGatchaCandidateRequests.length === sourceCountsBeforeManage.candidate
        && shellPoolConfigRequests.length === sourceCountsBeforeManage.pool
        && shellSourceManagementRequests.length === sourceCountsBeforeManage.management,
      "Manage sources changed Gatcha state or issued a source/Gatcha request",
      { manageSources, sourceCountsBeforeManage },
    );
    await shellPage.locator("#work-rail-random").click();

    await shellPage.evaluate(() => {
      window.__gatchaAddCalls = [];
      window.__gatchaAddPlan = [];
      window.__originalGatchaSubmitAddRequest = submitAddRequest;
      submitAddRequest = async (url, position, options = {}) => {
        window.__gatchaAddCalls.push({ url, position, options: { ...options } });
        const plan = window.__gatchaAddPlan.shift() || { accepted: true };
        if (plan.type === "failure") {
          throw new Error(plan.message || "Gatcha add failed");
        }
        if (plan.type === "binding") {
          const error = new Error("manual binding required");
          error.code = "manual_binding_required";
          error.payload = {
            binding: {
              title: "Multipart Gatcha candidate",
              preferred_page: 1,
              pages: [
                { page: 1, part: "Video", duration: 180 },
                { page: 2, part: "Instrumental", duration: 180 },
              ],
            },
          };
          throw error;
        }
        if (plan.type === "duplicate") {
          const error = new Error("duplicate request");
          error.code = "duplicate_session_request";
          error.payload = {
            duplicate_item: { display_title: "Duplicate Gatcha candidate" },
            session_entry: { request_count: 2 },
          };
          throw error;
        }
        return plan.accepted !== false;
      };
      elements.urlInput.value = "BV-QUICK-DRAFT-MUST-SURVIVE";
    });
    const seedCandidate = async (suffix) => shellPage.evaluate((value) => {
      state.gatchaCandidate = {
        bvid: `BVADD${value}`,
        url: `https://www.bilibili.com/video/BVADD${value}`,
        title: `Gatcha request candidate ${value}`,
      };
      state.gatchaView = "candidate";
      state.gatchaDrawError = "";
      setGatchaMessage("");
      renderGatchaWorkspace();
    }, suffix);

    await seedCandidate("FAIL");
    await shellPage.evaluate(() => { window.__gatchaAddPlan = [{ type: "failure", message: "visible add failure" }]; });
    await shellPage.locator("#gatcha-confirm-button").click();
    await shellPage.waitForFunction(() => !state.gatchaRequestBusy);
    const failedAdd = await shellPage.evaluate(() => ({
      candidate: state.gatchaCandidate?.bvid,
      message: state.gatchaMessage,
      call: window.__gatchaAddCalls.at(-1),
      quickDraft: elements.urlInput.value,
    }));
    assert(
      failedAdd.candidate === "BVADDFAIL"
        && failedAdd.message === "visible add failure"
        && failedAdd.call.url.endsWith("BVADDFAIL")
        && failedAdd.call.position === "tail"
        && failedAdd.call.options.requesterName === "Exact Requester"
        && failedAdd.quickDraft === "BV-QUICK-DRAFT-MUST-SURVIVE",
      "failed Gatcha request lost the candidate, requester, Tail position, or Quick Request draft",
      failedAdd,
    );

    await seedCandidate("STALE");
    await shellPage.evaluate(() => { window.__gatchaAddPlan = [{ accepted: false }]; });
    await shellPage.locator("#gatcha-confirm-button").click();
    await shellPage.waitForFunction(() => !state.gatchaRequestBusy);
    assert(
      await shellPage.evaluate(() => state.gatchaCandidate?.bvid === "BVADDSTALE"
        && state.gatchaMessageIsError),
      "stale Gatcha add cleared its candidate",
    );

    await seedCandidate("BINDCANCEL");
    await shellPage.evaluate(() => { window.__gatchaAddPlan = [{ type: "binding" }]; });
    await shellPage.locator("#gatcha-confirm-button").click();
    await shellPage.waitForSelector("#binding-modal:not(.hidden)");
    await shellPage.locator("#binding-modal-cancel").click();
    assert(
      await shellPage.evaluate(() => state.gatchaCandidate?.bvid === "BVADDBINDCANCEL"
        && document.activeElement === elements.gatchaConfirmButton),
      "cancelled manual binding did not retain the candidate and restore its action focus",
    );

    await seedCandidate("BIND");
    await shellPage.evaluate(() => { window.__gatchaAddPlan = [{ type: "binding" }, { accepted: true }]; });
    await shellPage.locator("#gatcha-confirm-button").click();
    await shellPage.waitForSelector("#binding-modal:not(.hidden)");
    await shellPage.locator('#binding-audio-options input[value="2"]').check();
    await shellPage.locator("#binding-modal-confirm").click();
    await shellPage.waitForFunction(() => !state.bindingIntent && !state.gatchaCandidate);
    const bindingAdd = await shellPage.evaluate(() => ({
      calls: window.__gatchaAddCalls.slice(-2),
      focus: document.activeElement?.id,
      quickDraft: elements.urlInput.value,
    }));
    assert(
      bindingAdd.calls.length === 2
        && bindingAdd.calls[0].position === "tail"
        && bindingAdd.calls[0].options.requesterName === "Exact Requester"
        && bindingAdd.calls[1].options.selectedVideoPage === 1
        && bindingAdd.calls[1].options.selectedAudioPages.join(",") === "2"
        && bindingAdd.focus === "gatcha-button"
        && bindingAdd.quickDraft === "BV-QUICK-DRAFT-MUST-SURVIVE",
      "manual binding did not reuse the exact Gatcha Tail/requester path or settle focus safely",
      bindingAdd,
    );

    await seedCandidate("DUPLICATE");
    await shellPage.evaluate(() => { window.__gatchaAddPlan = [{ type: "duplicate" }, { accepted: true }]; });
    const callsBeforeDuplicate = await shellPage.evaluate(() => window.__gatchaAddCalls.length);
    await shellPage.locator("#gatcha-confirm-button").click();
    await shellPage.waitForTimeout(100);
    const duplicateOpenState = await shellPage.evaluate(() => ({
      intent: state.confirmIntent,
      candidate: state.gatchaCandidate,
      requestBusy: state.gatchaRequestBusy,
      buttonDisabled: elements.gatchaConfirmButton.disabled,
      calls: window.__gatchaAddCalls,
      plan: window.__gatchaAddPlan,
      message: state.gatchaMessage,
    }));
    assert(
      duplicateOpenState.intent?.type === "duplicate-add",
      "Gatcha duplicate attempt did not open the existing confirmation flow",
      duplicateOpenState,
    );
    const duplicatePending = await shellPage.evaluate(() => ({
      candidate: state.gatchaCandidate?.bvid,
      source: state.confirmIntent?.source,
      requesterName: state.confirmIntent?.requesterName,
      position: state.confirmIntent?.position,
      quickDraft: elements.urlInput.value,
    }));
    await shellPage.locator("#confirm-ok").evaluate((button) => {
      button.click();
      button.click();
    });
    await shellPage.waitForFunction(() => !state.confirmIntent && !state.gatchaCandidate);
    const duplicateAccepted = await shellPage.evaluate((before) => ({
      addedCalls: window.__gatchaAddCalls.length - before,
      repeatCall: window.__gatchaAddCalls.at(-1),
      focus: document.activeElement?.id,
      quickDraft: elements.urlInput.value,
    }), callsBeforeDuplicate);
    assert(
      duplicatePending.candidate === "BVADDDUPLICATE"
        && duplicatePending.source === "gatcha"
        && duplicatePending.requesterName === "Exact Requester"
        && duplicatePending.position === "tail"
        && duplicatePending.quickDraft === "BV-QUICK-DRAFT-MUST-SURVIVE"
        && duplicateAccepted.addedCalls === 2
        && duplicateAccepted.repeatCall.options.allowRepeat === true
        && duplicateAccepted.repeatCall.options.requesterName === "Exact Requester"
        && duplicateAccepted.focus === "gatcha-button"
        && duplicateAccepted.quickDraft === "BV-QUICK-DRAFT-MUST-SURVIVE",
      "duplicate confirmation lost Gatcha routing or allowed more than one accepted enqueue attempt",
      { duplicatePending, duplicateAccepted },
    );

    const gatchaRequest = {
      failed: failedAdd,
      binding: bindingAdd,
      duplicatePending,
      duplicateAccepted,
      allCalls: await shellPage.evaluate(() => window.__gatchaAddCalls),
    };

    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    const poolLoading = await shellPage.evaluate(() => ({
      visible: !elements.poolConfigModal.classList.contains("hidden"),
      loading: state.poolConfigLoading,
      saving: state.poolConfigSaving,
      focus: document.activeElement?.id,
      accepted: state.poolConfigAccepted,
      draft: state.poolConfigDraft,
      sourceListCount: document.querySelectorAll("#gatcha-pool-source-list").length,
    }));
    assert(
      poolLoading.visible
        && poolLoading.loading
        && !poolLoading.saving
        && poolLoading.focus === "gatcha-pool-config-modal-close"
        && poolLoading.sourceListCount === 1
        && shellPoolConfigRequests.length === 1
        && shellPoolConfigRequests[0].method === "GET",
      "Configure did not open one focused task sheet with one explicit GET",
      { poolLoading, shellPoolConfigRequests },
    );
    await fulfillJson(shellPoolConfigRoutes.shift(), longPoolProjection(60, "first"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading);
    const poolLoaded = await shellPage.evaluate(() => ({
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      draftWeight: state.poolConfigDraft?.uid_weight,
      distinct: state.poolConfigAccepted !== state.poolConfigDraft,
      uidCount: state.poolConfigDraft?.uid_options?.length,
      folderCount: state.poolConfigDraft?.favlist_folder_options?.length,
    }));
    assert(
      poolLoaded.acceptedWeight === 60
        && poolLoaded.draftWeight === 60
        && poolLoaded.distinct
        && poolLoaded.uidCount === 36
        && poolLoaded.folderCount === 34,
      "loaded pool projection and mutable draft were not distinct",
      poolLoaded,
    );

    await shellPage.locator("#gatcha-pool-weight-slider").evaluate((slider) => {
      slider.value = "70";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await shellPage.locator("#gatcha-pool-uid-select-none").click();
    await shellPage.locator("#gatcha-pool-favlist-select-all").click();
    const poolDraftBeforeReset = await shellPage.evaluate(() => ({
      acceptedWeight: state.poolConfigAccepted.uid_weight,
      acceptedExcluded: state.poolConfigAccepted.excluded_uids.length,
      draftWeight: state.poolConfigDraft.uid_weight,
      draftExcluded: state.poolConfigDraft.excluded_uids.length,
    }));
    assert(
      poolDraftBeforeReset.acceptedWeight === 60
        && poolDraftBeforeReset.acceptedExcluded === 0
        && poolDraftBeforeReset.draftWeight === 70
        && poolDraftBeforeReset.draftExcluded === 36
        && shellPoolConfigRequests.filter((entry) => entry.method === "POST").length === 0,
      "pool draft controls mutated the accepted projection or saved before Save",
      poolDraftBeforeReset,
    );
    await shellPage.locator("#gatcha-pool-config-modal-reset").click();
    const poolReset = await shellPage.evaluate(() => ({
      acceptedWeight: state.poolConfigAccepted.uid_weight,
      acceptedExcluded: state.poolConfigAccepted.excluded_uids.length,
      draftWeight: state.poolConfigDraft.uid_weight,
      draftExcludedUids: state.poolConfigDraft.excluded_uids.length,
      draftExcludedFolders: state.poolConfigDraft.excluded_favlist_folders.length,
    }));
    assert(
      poolReset.acceptedWeight === 60
        && poolReset.acceptedExcluded === 0
        && poolReset.draftWeight === 50
        && poolReset.draftExcludedUids === 0
        && poolReset.draftExcludedFolders === 0
        && shellPoolConfigRequests.filter((entry) => entry.method === "POST").length === 0,
      "Reset did not remain a draft-only operation",
      poolReset,
    );
    await shellPage.keyboard.press("Escape");
    const poolCancelled = await shellPage.evaluate(() => ({
      hidden: elements.poolConfigModal.classList.contains("hidden"),
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      draft: state.poolConfigDraft,
      focus: document.activeElement?.id,
    }));
    assert(
      poolCancelled.hidden
        && poolCancelled.acceptedWeight === 60
        && poolCancelled.draft === null
        && poolCancelled.focus === "gatcha-pool-config-toggle",
      "Escape did not discard the unaccepted pool draft and restore the exact opener",
      poolCancelled,
    );

    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    const stalePoolLoadRoute = shellPoolConfigRoutes.shift();
    await shellPage.locator("#gatcha-pool-config-modal-backdrop").evaluate((backdrop) => backdrop.click());
    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    const freshPoolLoadRoute = shellPoolConfigRoutes.shift();
    assert(stalePoolLoadRoute && freshPoolLoadRoute, "pool stale-load proof did not capture both GET routes");
    await fulfillJson(freshPoolLoadRoute, longPoolProjection(80, "fresh"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading && state.poolConfigDraft?.uid_weight === 80);
    await fulfillJson(stalePoolLoadRoute, longPoolProjection(20, "obsolete"));
    await shellPage.waitForTimeout(80);
    const stalePoolLoad = await shellPage.evaluate(() => ({
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      draftWeight: state.poolConfigDraft?.uid_weight,
      firstUid: state.poolConfigDraft?.uid_options?.[0]?.uid,
      visible: !elements.poolConfigModal.classList.contains("hidden"),
    }));
    assert(
      stalePoolLoad.acceptedWeight === 80
        && stalePoolLoad.draftWeight === 80
        && stalePoolLoad.firstUid === "uid-fresh-0"
        && stalePoolLoad.visible,
      "an older pool GET overwrote a newer open/draft generation",
      stalePoolLoad,
    );

    await shellPage.locator("#gatcha-pool-weight-slider").evaluate((slider) => {
      slider.value = "65";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await shellPage.locator('#gatcha-pool-uid-options input[value="uid-fresh-0"]').uncheck();
    const acceptedBeforeSave = await shellPage.evaluate(() => state.poolConfigAccepted.uid_weight);
    const postsBeforeSave = shellPoolConfigRequests.filter((entry) => entry.method === "POST").length;
    await shellPage.locator("#gatcha-pool-config-modal-save").click();
    await shellPage.waitForTimeout(30);
    const poolSaveBusy = await shellPage.evaluate(() => ({
      saving: state.poolConfigSaving,
      disabled: elements.poolConfigModalSave.disabled,
      ariaBusy: elements.poolConfigModalSave.getAttribute("aria-busy"),
      acceptedWeight: state.poolConfigAccepted.uid_weight,
      draftWeight: state.poolConfigDraft.uid_weight,
    }));
    await shellPage.locator("#gatcha-pool-config-modal-save").evaluate((button) => button.click());
    const saveRequest = shellPoolConfigRequests.filter((entry) => entry.method === "POST").at(-1);
    assert(
      poolSaveBusy.saving
        && poolSaveBusy.disabled
        && poolSaveBusy.ariaBusy === "true"
        && poolSaveBusy.acceptedWeight === acceptedBeforeSave
        && poolSaveBusy.draftWeight === 65
        && shellPoolConfigRequests.filter((entry) => entry.method === "POST").length === postsBeforeSave + 1
        && saveRequest.payload.uid_weight === 65
        && saveRequest.payload.favlist_weight === 35
        && saveRequest.payload.excluded_uids.join(",") === "uid-fresh-0"
        && saveRequest.payload.excluded_favlist_folders.length === 0,
      "Save did not send the exact existing payload once with immediate busy state",
      { poolSaveBusy, saveRequest },
    );
    await fulfillJson(shellPoolConfigRoutes.shift(), {
      ...longPoolProjection(65, "saved"),
      excluded_uids: ["uid-fresh-0"],
    });
    await shellPage.waitForFunction(() => elements.poolConfigModal.classList.contains("hidden"));
    const poolSaved = await shellPage.evaluate(() => ({
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      acceptedExcluded: state.poolConfigAccepted?.excluded_uids,
      draft: state.poolConfigDraft,
      snapshotWeight: state.data?.gatcha_pool_config?.uid_weight,
      focus: document.activeElement?.id,
    }));
    assert(
      poolSaved.acceptedWeight === 65
        && poolSaved.acceptedExcluded.join(",") === "uid-fresh-0"
        && poolSaved.draft === null
        && poolSaved.snapshotWeight === 65
        && poolSaved.focus === "gatcha-pool-config-toggle",
      "accepted pool Save did not update the accepted projection, close, and restore focus",
      poolSaved,
    );

    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellPoolConfigRoutes.shift(), {
      ...longPoolProjection(65, "saved"),
      excluded_uids: ["uid-fresh-0"],
    });
    await shellPage.waitForFunction(() => !state.poolConfigLoading);
    await shellPage.locator("#gatcha-pool-weight-slider").evaluate((slider) => {
      slider.value = "55";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await shellPage.locator("#gatcha-pool-config-modal-save").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellPoolConfigRoutes.shift(), "visible pool save failure", { ok: false });
    await shellPage.waitForFunction(() => !state.poolConfigSaving);
    const failedPoolSave = await shellPage.evaluate(() => ({
      visible: !elements.poolConfigModal.classList.contains("hidden"),
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      draftWeight: state.poolConfigDraft?.uid_weight,
      message: elements.poolConfigMessage.textContent,
      isError: elements.poolConfigMessage.classList.contains("is-error"),
    }));
    assert(
      failedPoolSave.visible
        && failedPoolSave.acceptedWeight === 65
        && failedPoolSave.draftWeight === 55
        && failedPoolSave.message.includes("visible pool save failure")
        && failedPoolSave.isError,
      "failed pool Save did not retain its draft and honest error",
      failedPoolSave,
    );

    await shellPage.locator("#gatcha-pool-config-modal-save").click();
    await shellPage.waitForTimeout(30);
    const stalePoolSaveRoute = shellPoolConfigRoutes.shift();
    await shellPage.locator("#gatcha-pool-config-modal-cancel").click();
    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    const newerPoolLoadRoute = shellPoolConfigRoutes.shift();
    await fulfillJson(newerPoolLoadRoute, longPoolProjection(77, "newer"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading && state.poolConfigDraft?.uid_weight === 77);
    await fulfillJson(stalePoolSaveRoute, longPoolProjection(10, "stale-save"));
    await shellPage.waitForTimeout(80);
    const stalePoolSave = await shellPage.evaluate(() => ({
      visible: !elements.poolConfigModal.classList.contains("hidden"),
      acceptedWeight: state.poolConfigAccepted?.uid_weight,
      draftWeight: state.poolConfigDraft?.uid_weight,
      firstUid: state.poolConfigDraft?.uid_options?.[0]?.uid,
    }));
    assert(
      stalePoolSave.visible
        && stalePoolSave.acceptedWeight === 77
        && stalePoolSave.draftWeight === 77
        && stalePoolSave.firstUid === "uid-newer-0",
      "an older pool Save overwrote or closed a newer accepted/draft generation",
      stalePoolSave,
    );

    await shellPage.evaluate(() => openConfirm({
      type: "browser-layer-proof",
      message: "Child confirmation",
      focusElement: elements.poolConfigModalSave,
    }));
    await shellPage.keyboard.press("Escape");
    const poolAfterChildEscape = await shellPage.evaluate(() => ({
      confirmClosed: !state.confirmIntent,
      poolVisible: !elements.poolConfigModal.classList.contains("hidden"),
    }));
    await shellPage.keyboard.press("Escape");
    const poolAfterOwnEscape = await shellPage.evaluate(() => ({
      poolHidden: elements.poolConfigModal.classList.contains("hidden"),
      focus: document.activeElement?.id,
    }));
    assert(
      poolAfterChildEscape.confirmClosed
        && poolAfterChildEscape.poolVisible
        && poolAfterOwnEscape.poolHidden
        && poolAfterOwnEscape.focus === "gatcha-pool-config-toggle",
      "Escape did not close exactly one child/task layer and restore the pool opener",
      { poolAfterChildEscape, poolAfterOwnEscape },
    );

    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellPoolConfigRoutes.shift(), longPoolProjection(77, "switch"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading);
    await shellPage.locator("#gatcha-pool-weight-slider").evaluate((slider) => {
      slider.value = "66";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await shellPage.evaluate(() => activateHostWorkspace("queue", { inputOrigin: "programmatic" }));
    const poolAcrossWorkspace = await shellPage.evaluate(() => ({
      workspace: state.activeHostWorkspace,
      poolVisible: !elements.poolConfigModal.classList.contains("hidden"),
      draftWeight: state.poolConfigDraft?.uid_weight,
    }));
    await shellPage.keyboard.press("Escape");
    const poolSafeDestinationFocus = await shellPage.evaluate(() => document.activeElement?.id);
    assert(
      poolAcrossWorkspace.workspace === "queue"
        && poolAcrossWorkspace.poolVisible
        && poolAcrossWorkspace.draftWeight === 66
        && poolSafeDestinationFocus === "work-rail-queue",
      "pool task did not remain modal with its draft or restore safe destination focus after a workspace switch",
      { poolAcrossWorkspace, poolSafeDestinationFocus },
    );

    await shellPage.locator("#work-rail-random").click();
    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellPoolConfigRoutes.shift(), longPoolProjection(50, "scroll"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading);
    const poolScroll = await shellPage.evaluate(() => {
      const owner = elements.poolConfigSourceList;
      owner.scrollTop = 260;
      return {
        ownerScrollTop: owner.scrollTop,
        ownerClientHeight: owner.clientHeight,
        ownerScrollHeight: owner.scrollHeight,
        ownerOverflow: getComputedStyle(owner).overflowY,
        uidOverflow: getComputedStyle(elements.poolConfigUidOptions).overflowY,
        favOverflow: getComputedStyle(elements.poolConfigFavlistOptions).overflowY,
        workspaceScrollTop: elements.hostWorkspaceRegion.scrollTop,
        bodyScrollY: window.scrollY,
      };
    });
    assert(
      poolScroll.ownerScrollTop > 0
        && poolScroll.ownerScrollHeight > poolScroll.ownerClientHeight
        && poolScroll.ownerOverflow === "auto"
        && poolScroll.uidOverflow === "visible"
        && poolScroll.favOverflow === "visible"
        && poolScroll.workspaceScrollTop === 0
        && poolScroll.bodyScrollY === 0,
      "pool task did not own one bounded source-list scroll without background/body scrolling",
      poolScroll,
    );
    if (gatchaPoolScreenshotPath) {
      await shellPage.screenshot({ path: gatchaPoolScreenshotPath, fullPage: false });
    }
    await shellPage.locator("#gatcha-pool-config-modal-cancel").click();

    const gatchaPool = {
      loading: poolLoading,
      loaded: poolLoaded,
      draftBeforeReset: poolDraftBeforeReset,
      reset: poolReset,
      cancelled: poolCancelled,
      staleLoad: stalePoolLoad,
      saveBusy: poolSaveBusy,
      saved: poolSaved,
      failedSave: failedPoolSave,
      staleSave: stalePoolSave,
      layering: { poolAfterChildEscape, poolAfterOwnEscape },
      acrossWorkspace: poolAcrossWorkspace,
      scroll: poolScroll,
      requests: shellPoolConfigRequests,
    };

    await seedCandidate("RESPONSIVE");
    await shellPage.evaluate(() => {
      state.gatchaCandidate.title = "A responsive Gatcha candidate with long wrapping text ".repeat(9);
      renderGatchaWorkspace();
    });
    await shellPage.setViewportSize({ width: 1600, height: 900 });
    const gatchaWide = await shellPage.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "900px";
      spacer.style.flex = "0 0 900px";
      elements.gatchaMainView.appendChild(spacer);
      const headerTop = document.querySelector(".gatcha-head").getBoundingClientRect().top;
      elements.gatchaStage.scrollTop = 220;
      const evidence = {
        workspaceWidth: elements.hostWorkspaceRegion.getBoundingClientRect().width,
        stageWidth: document.querySelector(".left-column").getBoundingClientRect().width,
        headerTop,
        headerTopAfterScroll: document.querySelector(".gatcha-head").getBoundingClientRect().top,
        ownerScrollTop: elements.gatchaStage.scrollTop,
        ownerOverflow: getComputedStyle(elements.gatchaStage).overflowY,
        outerOverflow: getComputedStyle(elements.hostWorkspaceRegion).overflowY,
        bodyScrollY: window.scrollY,
      };
      spacer.remove();
      elements.gatchaStage.scrollTop = 0;
      return evidence;
    });
    assert(
      Math.abs(gatchaWide.workspaceWidth - responsiveFrames.wide1600.tools.random.contentWidth) <= 2
        && gatchaWide.stageWidth >= 720
        && gatchaWide.headerTopAfterScroll === gatchaWide.headerTop
        && gatchaWide.ownerScrollTop > 0
        && gatchaWide.ownerOverflow === "auto"
        && gatchaWide.outerOverflow === "hidden"
        && gatchaWide.bodyScrollY === 0,
      "wide Gatcha did not keep the stable dock width, fixed header, and sole local scroll owner",
      gatchaWide,
    );

    await shellPage.setViewportSize({ width: 1240, height: 800 });
    await shellPage.waitForTimeout(120);
    const gatchaMedium = await shellPage.evaluate(() => ({
      workspaceWidth: elements.hostWorkspaceRegion.getBoundingClientRect().width,
      stageWidth: document.querySelector(".left-column").getBoundingClientRect().width,
      headerHeight: document.querySelector(".gatcha-head").getBoundingClientRect().height,
      regionHeight: elements.hostWorkspaceRegion.getBoundingClientRect().height,
      horizontalPageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      bodyScrollY: window.scrollY,
      actionsFit: document.querySelector(".gatcha-head-actions").getBoundingClientRect().right
        <= elements.hostWorkspaceRegion.getBoundingClientRect().right + 1,
    }));
    assert(
      Math.abs(gatchaMedium.workspaceWidth - responsiveFrames.medium1240.tools.random.contentWidth) <= 2
        && gatchaMedium.stageWidth >= 500
        && gatchaMedium.headerHeight < gatchaMedium.regionHeight
        && !gatchaMedium.horizontalPageScroll
        && gatchaMedium.bodyScrollY === 0
        && gatchaMedium.actionsFit,
      "medium Gatcha did not keep the shared dock width, useful Stage width, and fitted actions",
      gatchaMedium,
    );
    if (gatchaMediumScreenshotPath) {
      await shellPage.screenshot({ path: gatchaMediumScreenshotPath, fullPage: false });
    }

    await shellPage.setViewportSize({ width: 840, height: 760 });
    await shellPage.waitForTimeout(120);
    const gatchaNarrow = await shellPage.evaluate(() => {
      const region = elements.hostWorkspaceRegion.getBoundingClientRect();
      const stage = document.querySelector(".left-column").getBoundingClientRect();
      const header = document.querySelector(".gatcha-head").getBoundingClientRect();
      return {
        classification: elements.appShell.dataset.stageMode,
        regionTop: region.top,
        stageBottom: stage.bottom,
        regionWidth: region.width,
        headerHeight: header.height,
        regionHeight: region.height,
        drawReachable: !elements.gatchaButton.hidden,
        retryReachable: !elements.gatchaRetryButton.hidden,
        confirmReachable: !elements.gatchaConfirmButton.hidden,
        configureVisible: !elements.gatchaPoolConfigToggle.hidden,
        manageVisible: !elements.manageSourcesButton.hidden,
        horizontalPageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        bodyScrollY: window.scrollY,
      };
    });
    assert(
      gatchaNarrow.classification === "narrow"
        && gatchaNarrow.regionTop >= gatchaNarrow.stageBottom - 1
        && gatchaNarrow.regionWidth > 700
        && gatchaNarrow.headerHeight < gatchaNarrow.regionHeight
        && gatchaNarrow.retryReachable
        && gatchaNarrow.confirmReachable
        && gatchaNarrow.configureVisible
        && gatchaNarrow.manageVisible
        && !gatchaNarrow.horizontalPageScroll
        && gatchaNarrow.bodyScrollY === 0,
      "narrow Gatcha lost reachable actions, local fit, or the compact Stage foundation",
      gatchaNarrow,
    );
    await shellPage.locator("#gatcha-confirm-button").scrollIntoViewIfNeeded();
    const gatchaNarrowActionScroll = await shellPage.evaluate(() => {
      const confirm = elements.gatchaConfirmButton.getBoundingClientRect();
      const retry = elements.gatchaRetryButton.getBoundingClientRect();
      const owner = elements.gatchaStage.getBoundingClientRect();
      return {
        ownerScrollTop: elements.gatchaStage.scrollTop,
        ownerClientHeight: elements.gatchaStage.clientHeight,
        ownerScrollHeight: elements.gatchaStage.scrollHeight,
        confirmVisible: confirm.top >= owner.top && confirm.bottom <= owner.bottom,
        retryVisible: retry.top >= owner.top && retry.bottom <= owner.bottom,
        bodyScrollY: window.scrollY,
      };
    });
    assert(
      (gatchaNarrowActionScroll.ownerScrollTop > 0
        || gatchaNarrowActionScroll.ownerScrollHeight <= gatchaNarrowActionScroll.ownerClientHeight + 1)
        && gatchaNarrowActionScroll.confirmVisible
        && gatchaNarrowActionScroll.retryVisible
        && gatchaNarrowActionScroll.bodyScrollY === 0,
      "narrow candidate actions were not reachable through the Gatcha-local scroll owner",
      gatchaNarrowActionScroll,
    );
    if (gatchaNarrowScreenshotPath) {
      await shellPage.screenshot({ path: gatchaNarrowScreenshotPath, fullPage: false });
    }

    await shellPage.locator("#gatcha-pool-config-toggle").click();
    await shellPage.waitForTimeout(30);
    await fulfillJson(shellPoolConfigRoutes.shift(), longPoolProjection(50, "narrow"));
    await shellPage.waitForFunction(() => !state.poolConfigLoading);
    const narrowPool = await shellPage.evaluate(() => {
      const card = document.querySelector(".gatcha-pool-config-card").getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      return {
        card,
        viewport,
        sourceListHeight: elements.poolConfigSourceList.clientHeight,
        sourceListScrollable: elements.poolConfigSourceList.scrollHeight > elements.poolConfigSourceList.clientHeight,
        saveVisible: elements.poolConfigModalSave.getBoundingClientRect().bottom <= viewport.height,
        cancelVisible: elements.poolConfigModalCancel.getBoundingClientRect().bottom <= viewport.height,
        bodyScrollY: window.scrollY,
      };
    });
    assert(
      narrowPool.card.left >= 0
        && narrowPool.card.right <= narrowPool.viewport.width
        && narrowPool.card.top >= 0
        && narrowPool.card.bottom <= narrowPool.viewport.height
        && narrowPool.sourceListHeight > 0
        && narrowPool.sourceListScrollable
        && narrowPool.saveVisible
        && narrowPool.cancelVisible
        && narrowPool.bodyScrollY === 0,
      "narrow pool task clipped its controls or lost local source-list scrolling",
      narrowPool,
    );
    await shellPage.locator("#gatcha-pool-config-modal-cancel").click();

    await shellPage.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await shellPage.evaluate(() => {
      const before = state.gatchaView;
      state.gatchaView = "error";
      renderGatchaWorkspace();
      const errorVisible = !elements.gatchaErrorView.hidden;
      state.gatchaView = "candidate";
      renderGatchaWorkspace();
      return {
        before,
        errorVisible,
        candidateVisible: !elements.gatchaResultView.hidden,
        workspaceTransition: getComputedStyle(elements.hostWorkspaceRegion).transitionDuration,
      };
    });
    assert(
      reducedMotion.errorVisible
        && reducedMotion.candidateVisible
        && reducedMotion.workspaceTransition === "0s",
      "reduced-motion Gatcha did not switch direct states without shell movement",
      reducedMotion,
    );
    await shellPage.emulateMedia({ reducedMotion: "no-preference" });

    const gatchaPlayback = await shellPage.evaluate(() => {
      const invariant = window.__gatchaInvariant;
      mountHostPlaybackSessionElements = invariant.originalMount;
      replaceHostPlayerView = invariant.originalReplace;
      beginHostPlaybackSessionOwnershipClaim = invariant.originalClaim;
      retireHostPlaybackSession = invariant.originalRetire;
      submitAddRequest = window.__originalGatchaSubmitAddRequest;
      return {
        sameSession: state.hostPlaybackSession === window.__gatchaNodes.session,
        sameFrame: elements.playerFrame === window.__gatchaNodes.frame,
        sameVideo: state.hostPlaybackSession?.video === window.__gatchaNodes.video,
        sameAudio: state.hostPlaybackSession?.audio === window.__gatchaNodes.audio,
        frameCount: document.querySelectorAll("#player-frame").length,
        videoCount: elements.playerFrame.querySelectorAll("video").length,
        audioCount: elements.playerFrame.querySelectorAll("audio").length,
        remounts: {
          mount: invariant.mount,
          replace: invariant.replace,
          claim: invariant.claim,
          retire: invariant.retire,
        },
        bodyScrollY: window.scrollY,
      };
    });
    gatchaPlayback.playerRequests = shellPlayerRequests.length - playerRequestsBeforeGatcha;
    assert(
      gatchaPlayback.sameSession
        && gatchaPlayback.sameFrame
        && gatchaPlayback.sameVideo
        && gatchaPlayback.sameAudio
        && gatchaPlayback.frameCount === 1
        && gatchaPlayback.videoCount === 1
        && gatchaPlayback.audioCount === 1
        && Object.values(gatchaPlayback.remounts).every((count) => count === 0)
        && gatchaPlayback.playerRequests === 0
        && gatchaPlayback.bodyScrollY === 0,
      "Gatcha navigation/draw/request/pool/responsive work changed exact playback identity or sent player work",
      gatchaPlayback,
    );

    const gatchaResponsive = {
      wide: gatchaWide,
      medium: gatchaMedium,
      narrow: gatchaNarrow,
      narrowActionScroll: gatchaNarrowActionScroll,
      narrowPool,
      reducedMotion,
    };
    const gatchaAcceptance = {
      initial: gatchaInitial,
      drawing: gatchaDrawing,
      roundTrip: gatchaRoundTrip,
      staleDraw,
      error: drawError,
      manageSources,
      request: gatchaRequest,
      pool: gatchaPool,
      responsive: gatchaResponsive,
      playback: gatchaPlayback,
      candidateRequestCount: shellGatchaCandidateRequests.length,
    };
    assert(shellPageErrors.length === 0, "unexpected Host shell page errors", shellPageErrors);
    assert(shellConsoleErrors.length === 0, "unexpected Host shell console errors", shellConsoleErrors);
    const shellEvidence = {
      initial: shellInitial,
      navigation: navigationState,
      switchFetchCount,
      legacyLayoutEvidence,
      playerIdentity,
      playerRequestCount: shellPlayerRequests.length - playerRequestsBeforeSwitching,
      queueHistory: {
        initial: directListInitial,
        history: directHistory,
        lazyHistoryRequests: shellPlayedSessionRequests.length,
        seed: queueSeed,
        fixedBefore: queueFixedBefore,
        wheel: queueWheelScrollTop,
        scrollRestoration: directListScroll,
        clearConfirmation: clearQueueConfirmation,
        resort: resortEvidence,
        moveAccepted,
        moveRejected,
        retry: retryCall,
        next: nextEvidence,
        emptyStates: emptyQueueEvidence,
        playbackInvariant: queueAcceptance,
      },
      wideWidths,
      wideRequestSubviews,
      responsiveFrames,
      draftAndScroll,
      bannerEvidence,
      mediumQueue,
      mediumRequestOpen,
      mediumRequestSubviews,
      mediumRequestClosed,
      narrowInitial,
      narrowQueue,
      narrowHistory,
      narrowControlEvidence,
      narrowWorkspaces,
      narrowRequestSubviews,
      narrowLocalScroll,
      gatcha: gatchaAcceptance,
      consoleErrors: shellConsoleErrors,
      pageErrors: shellPageErrors,
      screenshots: {
        wide: shellWideScreenshotPath,
        medium: shellMediumScreenshotPath,
        narrow: shellNarrowScreenshotPath,
        default1024x700: shellDefaultScreenshotPath,
        short1280x640: shellShortScreenshotPath,
        queueWide: queueWideScreenshotPath,
        historyWide: historyWideScreenshotPath,
        queueMedium: queueMediumScreenshotPath,
        queueNarrow: queueNarrowScreenshotPath,
        historyNarrow: historyNarrowScreenshotPath,
        narrowControls: narrowControlsScreenshotPath,
        gatchaWide: gatchaWideScreenshotPath,
        gatchaError: gatchaErrorScreenshotPath,
        gatchaPool: gatchaPoolScreenshotPath,
        gatchaMedium: gatchaMediumScreenshotPath,
        gatchaNarrow: gatchaNarrowScreenshotPath,
      },
    };
    await shellPage.close();

    const disabledAutoPage = await browser.newPage({ viewport: { width: 800, height: 700 } });
    let disabledAutoChecks = 0;
    await disabledAutoPage.addInitScript(() => {
      localStorage.setItem("bilikara.update.automatic", "false");
    });
    await disabledAutoPage.route("**/api/app/update/check", (route) => {
      disabledAutoChecks += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { state: "checking", include_preview: false } }),
      });
    });
    await disabledAutoPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await disabledAutoPage.waitForTimeout(1200);
    assert(!await disabledAutoPage.locator("#update-automatic-checkbox").isChecked(),
      "saved disabled automatic-check preference was not restored");
    assert(disabledAutoChecks === 0, "disabled preference did not suppress the startup update check");
    await disabledAutoPage.close();

    await page.locator("#work-rail-request").click();
    assert(await page.locator("#request-search-panel").isVisible(), "Request rail did not expose the existing Search panel");
    await page.evaluate(() => {
      document.querySelector("#lark-search-query").value = "host ui";
      document.querySelector("#lark-search-form").dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForSelector("#lark-search-results .search-result-item");
    const results = page.locator("#lark-search-results");
    await results.locator(".search-result-item").first().evaluate((card) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "host-ui-wheel-control";
      button.textContent = "Control";
      card.querySelector(".search-result-meta")?.appendChild(button);
    });

    const wheelScrollTop = {};
    for (const selector of [
      ".search-result-cover",
      ".search-result-title",
      ".search-result-status",
      ".host-ui-wheel-control",
    ]) {
      await results.evaluate((element) => { element.scrollTop = 0; });
      await results.locator(selector).first().hover();
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(60);
      wheelScrollTop[selector] = await results.evaluate((element) => element.scrollTop);
      assert(wheelScrollTop[selector] > 0, `wheel did not scroll over ${selector}`, wheelScrollTop);
    }

    await results.evaluate((element) => { element.scrollTop = 0; });
    const firstCard = await results.locator(".search-result-item").first().boundingBox();
    const secondCard = await results.locator(".search-result-item").nth(1).boundingBox();
    assert(firstCard && secondCard, "expanded result cards were not laid out");
    await page.mouse.move(
      (firstCard.x + firstCard.width + secondCard.x) / 2,
      firstCard.y + 40,
    );
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(60);
    wheelScrollTop.gap = await results.evaluate((element) => element.scrollTop);
    assert(wheelScrollTop.gap > 0, "wheel did not scroll over the results grid gap", wheelScrollTop);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#host-workspace-request").hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(60);
    const backgroundScrollTop = await page.evaluate(() => window.scrollY);
    assert(backgroundScrollTop === 0, "Request workspace allowed background page scrolling", {
      backgroundScrollTop,
    });

    await results.evaluate((element) => { element.scrollTop = 0; });
    const opener = results.locator(".search-result-item").first();
    await opener.click();
    const detail = page.locator(".song-detail-view");
    await detail.waitFor({ state: "visible" });
    await detail.locator(".song-detail-title").click();
    assert(await detail.isVisible(), "clicking detail card content closed detail");
    await detail.locator(".song-detail-cover").click();
    assert(await detail.isVisible(), "clicking the detail cover closed detail");
    const detailBox = await detail.boundingBox();
    assert(detailBox, "song detail did not have a rendered surface");
    await page.mouse.click(detailBox.x + 5, detailBox.y + 5);
    await page.waitForTimeout(250);
    const detailHidden = await detail.evaluate((element) => element.classList.contains("hidden"));
    assert(detailHidden, "blank song-detail backdrop click did not close detail");
    assert(await page.locator("#host-workspace-request").isVisible(), "closing detail also closed Request");
    assert(
      await opener.evaluate((element) => document.activeElement === element),
      "detail close did not restore focus to its result card",
    );

    await opener.click();
    await detail.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.matches("[data-song-detail-close]"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden")),
      "Escape did not close song detail",
    );
    assert(await page.locator("#host-workspace-request").isVisible(), "Escape on detail closed Request");

    await opener.click();
    await detail.waitFor({ state: "visible" });
    await detail.locator("[data-song-detail-close]").click();
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden")),
      "explicit detail close button did not close detail",
    );

    await page.evaluate(() => {
      window.__requestSharedNode = elements.larkSearchResults;
      window.__requestLocalNode = elements.searchResults;
    });
    const requestCountBeforeTabs = larkSearchRequests.length + localSearchRequests.length
      + d1BrowseRequests.length + sourceBrowseRequests.length;
    await page.locator('[data-search-mode="local"]').click();
    await page.locator("#search-query").fill("local draft");
    await page.locator('[data-search-mode="shared"]').click();
    assert(
      await page.locator("#lark-search-query").inputValue() === "host ui"
        && await page.locator("#lark-search-results .search-result-item").count() === 36,
      "Shared/Local switching lost Shared state",
    );
    await page.locator('[data-search-mode="shared"]').focus();
    await page.keyboard.press("ArrowRight");
    assert(
      await page.evaluate(() => state.searchMode === "local"
        && document.activeElement?.dataset.searchMode === "local"),
      "Search tabs did not support arrow-key activation",
    );
    await page.keyboard.press("Home");
    await page.locator('[data-request-view="discover"]').click();
    await page.locator('[data-discover-mode="name"]').click();
    await page.locator('[data-discover-mode="artist"]').click();
    await page.locator('[data-request-view="sources"]').click();
    await page.locator('[data-sources-mode="favorites"]').click();
    await page.locator('[data-request-view="search"]').click();
    const requestCountAfterTabs = larkSearchRequests.length + localSearchRequests.length
      + d1BrowseRequests.length + sourceBrowseRequests.length;
    assert(requestCountAfterTabs === requestCountBeforeTabs,
      "direct Request tab switching issued a fetch",
      { requestCountBeforeTabs, requestCountAfterTabs });
    assert(
      await page.evaluate(() => elements.larkSearchResults === window.__requestSharedNode
        && elements.searchResults === window.__requestLocalNode),
      "Request tab switching reconstructed Search results",
    );
    const larkRequestsBeforeWorkspaceRoundTrip = larkSearchRequests.length;
    await page.locator("#work-rail-queue").click();
    await page.locator("#work-rail-request").click();
    assert(
      await page.locator("#lark-search-results .search-result-item").count() === 36
        && await page.locator("#lark-search-query").inputValue() === "host ui"
        && larkSearchRequests.length === larkRequestsBeforeWorkspaceRoundTrip,
      "Request workspace round trip lost Search state or reran the query",
      { larkSearchRequests },
    );

    await page.locator('[data-search-mode="local"]').click();
    await page.locator("#search-query").fill("configured source");
    await page.locator("#search-form").evaluate((form) => form.requestSubmit());
    await page.waitForSelector("#search-results .search-result-item");
    assert(localSearchRequests.length === 1, "Local search did not use its existing bounded endpoint", localSearchRequests);
    await page.locator('[data-search-mode="shared"]').click();
    await page.locator('[data-search-mode="local"]').click();
    assert(
      await page.locator("#search-query").inputValue() === "configured source"
        && await page.locator("#search-results .search-result-item").count() === 1,
      "Local mode round trip lost its independent draft or results",
    );

    await page.setViewportSize({ width: 1200, height: 520 });
    await page.locator('[data-request-view="discover"]').click();
    await page.locator('[data-discover-mode="categories"]').click();
    await page.waitForSelector('#request-discover-categories [data-category-id]');
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const categoryPanel = page.locator("#request-discover-categories");
    const categoryHomeScroll = await categoryPanel.evaluate((element) => {
      element.scrollTop = Math.min(173, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    assert(categoryHomeScroll > 0, "category home fixture did not expose a nonzero scroll range");
    const retainedCategoryId = await categoryPanel.locator("[data-category-id]").nth(2).getAttribute("data-category-id");
    await categoryPanel.locator(`[data-category-id="${retainedCategoryId}"]`).first().evaluate((button) => button.click());
    await page.waitForFunction(() => state.categoryBrowseItems.length === 100 && !state.categoryBrowseLoading);
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const categoryDetailScroll = await categoryPanel.evaluate((element) => {
      element.scrollTop = Math.min(281, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    assert(categoryDetailScroll > 0 && categoryDetailScroll !== categoryHomeScroll,
      "category detail fixture did not expose a distinct nonzero scroll range");
    const categoryRequestsBeforeBack = categoryBrowseRequests.length;
    await categoryPanel.locator("[data-category-browse-back]").evaluate((button) => button.click());
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const categoryBackEvidence = await page.evaluate(() => ({
      level: state.categoryBrowseLevel,
      selectedId: state.categoryBrowseSelectedId,
      query: state.categoryBrowseQuery,
      offset: state.categoryBrowseOffset,
      hasMore: state.categoryBrowseHasMore,
      itemCount: state.categoryBrowseItems.length,
      scrollTop: elements.discoverCategoriesPanel.scrollTop,
      scrollHeight: elements.discoverCategoriesPanel.scrollHeight,
      clientHeight: elements.discoverCategoriesPanel.clientHeight,
      savedScrolls: { ...state.categoryBrowseScrollPositions },
    }));
    assert(
      categoryBackEvidence.level === "home"
        && categoryBackEvidence.selectedId === retainedCategoryId
        && categoryBackEvidence.offset === 100
        && categoryBackEvidence.hasMore
        && categoryBackEvidence.itemCount === 100
        && categoryBackEvidence.scrollTop === categoryHomeScroll
        && categoryBrowseRequests.length === categoryRequestsBeforeBack,
      "category Back did not restore the exact retained parent context without refetch",
      { categoryBackEvidence, categoryHomeScroll, categoryBrowseRequests },
    );
    await categoryPanel.locator(`[data-category-id="${retainedCategoryId}"]`).first().evaluate((button) => button.click());
    await page.waitForFunction(() => state.categoryBrowseLevel === "detail");
    await page.waitForFunction(() => !state.requestScrollRestoring);
    assert(
      categoryBrowseRequests.length === categoryRequestsBeforeBack
        && await categoryPanel.evaluate((element) => element.scrollTop) === categoryDetailScroll,
      "re-entering a retained category did not restore exact detail scroll without a request",
      { categoryDetailScroll, categoryBrowseRequests },
    );
    await categoryPanel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => state.categoryBrowseOffset === 130 && !state.categoryBrowseLoading);
    const categoryPagination = await page.evaluate(() => ({
      offset: state.categoryBrowseOffset,
      hasMore: state.categoryBrowseHasMore,
      itemCount: state.categoryBrowseItems.length,
      uniqueCount: new Set(state.categoryBrowseItems.map((item) => item.bvid)).size,
    }));
    assert(
      categoryPagination.offset === 130
        && !categoryPagination.hasMore
        && categoryPagination.itemCount === 130
        && categoryPagination.uniqueCount === 130,
      "category load-more changed offset/has-more semantics or duplicated rows",
      categoryPagination,
    );
    await categoryPanel.locator("[data-category-browse-query]").fill("delayed-old");
    await categoryPanel.locator("[data-category-browse-search]").evaluate((form) => form.requestSubmit());
    const newerCategoryTab = categoryPanel.locator("[data-category-browser-tabs] [data-category-id]").nth(1);
    const newerCategoryId = await newerCategoryTab.getAttribute("data-category-id");
    await newerCategoryTab.evaluate((button) => button.click());
    await page.waitForFunction((categoryId) => state.categoryBrowseSelectedId === categoryId && !state.categoryBrowseLoading,
      newerCategoryId);
    await page.waitForTimeout(220);
    const categoryStaleEvidence = await page.evaluate(() => ({
      selectedId: state.categoryBrowseSelectedId,
      query: state.categoryBrowseQuery,
      staleItem: state.categoryBrowseItems.some((item) => String(item.title || "").includes("delayed-old")),
    }));
    assert(
      categoryStaleEvidence.selectedId === newerCategoryId
        && categoryStaleEvidence.query === ""
        && !categoryStaleEvidence.staleItem,
      "a delayed old category response overwrote the newer category/query level",
      categoryStaleEvidence,
    );

    await page.locator('[data-discover-mode="name"]').click();
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const namePanel = page.locator("#request-discover-name");
    const nameAlphabetScroll = await namePanel.evaluate((element) => {
      element.scrollTop = Math.min(61, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    assert(nameAlphabetScroll > 0, "Name alphabet fixture did not expose a nonzero scroll range");
    await namePanel.locator('[data-letter="A"]').evaluate((button) => button.click());
    await page.waitForSelector('#request-discover-name [data-tag="Anime"]');
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const nameTagsScroll = await namePanel.evaluate((element) => {
      element.scrollTop = Math.min(149, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    await namePanel.locator('[data-tag="Anime"]').evaluate((button) => button.click());
    await page.waitForFunction(() => state.d1BrowseKind === "name" && state.d1BrowseData?.items?.length === 80);
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const nameItemsScroll = await namePanel.evaluate((element) => {
      element.scrollTop = Math.min(337, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    const nameRequestsBeforeBack = d1BrowseRequests.length;
    await namePanel.locator("[data-d1-browse-back]").evaluate((button) => button.click());
    await page.waitForFunction(() => !state.requestScrollRestoring);
    assert(
      d1BrowseRequests.length === nameRequestsBeforeBack
        && await namePanel.evaluate((element) => element.scrollTop) === nameTagsScroll
        && await page.evaluate(() => state.d1BrowseLevel === "tags" && state.d1BrowseLetter === "A"),
      "Name results Back did not restore the exact tag-list context without refetch",
      { nameTagsScroll, d1BrowseRequests },
    );
    await namePanel.locator("[data-d1-browse-back]").evaluate((button) => button.click());
    await page.waitForFunction(() => !state.requestScrollRestoring);
    assert(
      d1BrowseRequests.length === nameRequestsBeforeBack
        && await namePanel.evaluate((element) => element.scrollTop) === nameAlphabetScroll
        && await page.evaluate(() => state.d1BrowseLevel === "alphabet"),
      "Name tag-list Back did not restore exact alphabet context without refetch",
      { nameAlphabetScroll, d1BrowseRequests },
    );
    await namePanel.locator('[data-letter="A"]').evaluate((button) => button.click());
    await page.waitForFunction(() => !state.requestScrollRestoring);
    await namePanel.locator('[data-tag="Anime"]').evaluate((button) => button.click());
    await page.waitForFunction(() => !state.requestScrollRestoring);
    assert(
      d1BrowseRequests.length === nameRequestsBeforeBack
        && await namePanel.evaluate((element) => element.scrollTop) === nameItemsScroll,
      "Name retained hierarchy did not restore its exact items scroll",
      { nameItemsScroll, d1BrowseRequests },
    );

    const requestsBeforeArtist = d1BrowseRequests.length;
    await page.locator('[data-discover-mode="artist"]').click();
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const artistPanel = page.locator("#request-discover-artist");
    assert(
      d1BrowseRequests.length === requestsBeforeArtist
        && await page.evaluate(() => state.d1BrowseKind === "artist" && state.d1BrowseLevel === "alphabet"),
      "Name/Artist mode-only switching issued a request or shared a hierarchy level",
      d1BrowseRequests,
    );
    const artistAlphabetScroll = await artistPanel.evaluate((element) => {
      element.scrollTop = Math.min(37, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    await artistPanel.locator('[data-letter="B"]').evaluate((button) => button.click());
    await page.waitForSelector('#request-discover-artist [data-tag="Anime"]');
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const artistTagsScroll = await artistPanel.evaluate((element) => {
      element.scrollTop = Math.min(113, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    await artistPanel.locator('[data-tag="Anime"]').evaluate((button) => button.click());
    await page.waitForFunction(() => state.d1BrowseKind === "artist" && state.d1BrowseData?.items?.length === 80);
    await page.waitForFunction(() => !state.requestScrollRestoring);
    const artistItemsScroll = await artistPanel.evaluate((element) => {
      element.scrollTop = Math.min(263, element.scrollHeight - element.clientHeight);
      return element.scrollTop;
    });
    const requestsBeforeNameReturn = d1BrowseRequests.length;
    await page.locator('[data-discover-mode="name"]').click();
    assert(
      d1BrowseRequests.length === requestsBeforeNameReturn
        && await page.evaluate(() => state.d1BrowseKind === "name" && state.d1BrowseLetter === "A" && state.d1BrowseTag === "Anime")
        && await namePanel.evaluate((element) => element.scrollTop) === nameItemsScroll,
      "Name/Artist round trip shared selection/scroll state or issued a request",
      { nameItemsScroll, artistAlphabetScroll, artistTagsScroll, artistItemsScroll, d1BrowseRequests },
    );
    await namePanel.locator("[data-d1-browse-query]").fill("delayed-old");
    await namePanel.locator("[data-d1-browse-search]").evaluate((form) => form.requestSubmit());
    await namePanel.locator("[data-d1-browse-back]").evaluate((button) => button.click());
    await page.waitForTimeout(220);
    assert(
      await page.evaluate(() => state.d1BrowseLevel === "tags"
        && !JSON.stringify(state.d1BrowseData || {}).includes("delayed-old")),
      "a delayed old Name response wrote into a newer hierarchy level",
    );
    await page.locator('[data-discover-mode="artist"]').click();
    assert(
      await page.evaluate(() => state.d1BrowseKind === "artist"
        && state.d1BrowseLetter === "B"
        && state.d1BrowseTag === "Anime")
        && await artistPanel.evaluate((element) => element.scrollTop) === artistItemsScroll,
      "Artist hierarchy did not remain independent after delayed Name work",
    );
    await page.setViewportSize({ width: 1200, height: 1000 });

    const maintenancePlayerRequestsBefore = hostPlayerRequests.length;
    await page.evaluate(() => {
      window.__maintenancePlaybackNodes = {
        session: state.hostPlaybackSession,
        frame: elements.playerFrame,
        video: state.hostPlaybackSession?.video,
        audio: state.hostPlaybackSession?.audio,
        language: state.language,
      };
      state.bilikaraSecret = "verified-secret";
      setDeveloperMode(true);
    });
    const advancedMenu = page.locator("#catalog-advanced-menu");
    const advancedSummary = advancedMenu.locator("summary");
    const maintenanceAction = advancedMenu.locator('[data-catalog-tool="maintenance"]');
    assert(await advancedMenu.isVisible() && await maintenanceAction.count() === 1,
      "developer mode did not expose exactly one current-catalog Maintenance action");

    await advancedSummary.click();
    await maintenanceAction.click();
    const monthlyButton = page.locator('[data-maintenance-job="monthly-d1-refresh"]');
    await monthlyButton.focus();
    const monthlyFocusBefore = await monthlyButton.evaluate((element) => (
      document.activeElement === element ? element.dataset.maintenanceJob : ""
    ));
    assert(monthlyFocusBefore === "monthly-d1-refresh",
      "monthly maintenance action was not focused before activation");
    const monthlyRequestSeen = page.waitForRequest((request) => (
      new URL(request.url()).pathname === "/api/admin-maintenance/trigger"
        && request.postDataJSON()?.job === "monthly-d1-refresh"
    ));
    await monthlyButton.click();
    await monthlyRequestSeen;
    await page.waitForFunction(() => state.maintenanceJobRunning === "monthly-d1-refresh");
    await page.waitForFunction(() => (
      document.querySelector('[data-maintenance-job="monthly-d1-refresh"]')?.getAttribute("aria-disabled") === "true"
    ));
    const monthlyBusy = await page.evaluate(() => {
      const button = document.querySelector('[data-maintenance-job="monthly-d1-refresh"]');
      button?.click();
      button?.click();
      return {
        disabled: Boolean(button?.disabled),
        ariaDisabled: button?.getAttribute("aria-disabled"),
        ariaBusy: button?.getAttribute("aria-busy"),
        label: button?.textContent,
        focus: document.activeElement?.dataset?.maintenanceJob || document.activeElement?.tagName || "",
      };
    });
    await page.waitForFunction(() => (
      document.querySelector('[data-maintenance-job="monthly-d1-refresh"]')?.getAttribute("aria-disabled") === "true"
    ));
    assert(
      maintenanceRequests.filter((request) => request.job === "monthly-d1-refresh").length === 1
        && (monthlyBusy.disabled || monthlyBusy.ariaDisabled === "true")
        && monthlyBusy.ariaBusy === "true",
      "monthly maintenance did not enter an accessible single-request busy state",
      { maintenanceRequests, monthlyBusy },
    );
    if (maintenanceBusyScreenshotPath) {
      await page.screenshot({ path: maintenanceBusyScreenshotPath, fullPage: false });
    }
    releaseMonthlyMaintenance();
    await page.waitForFunction(() => !state.maintenanceJobRunning);
    const monthlySuccess = await page.locator(".maintenance-job-message").textContent();
    const monthlyFocusAfter = await page.evaluate(() => (
      document.activeElement?.dataset?.maintenanceJob || document.activeElement?.tagName || ""
    ));
    assert(
      monthlySuccess.includes("local-browser-1")
        && await monthlyButton.getAttribute("aria-busy") === null,
      "monthly maintenance did not restore its control and expose bounded success copy",
      { monthlySuccess, monthlyFocusAfter },
    );
    await page.locator("#catalog-advanced-back").click();
    assert(
      await advancedSummary.evaluate((element) => document.activeElement === element),
      "Maintenance Back did not restore focus to the advanced-menu summary",
    );

    await advancedSummary.click();
    await maintenanceAction.click();
    const taggerRequestSeen = page.waitForRequest((request) => (
      new URL(request.url()).pathname === "/api/admin-maintenance/trigger"
        && request.postDataJSON()?.job === "tagger-yomi"
    ));
    const taggerButton = page.locator('[data-maintenance-job="tagger-yomi"]');
    await taggerButton.focus();
    const taggerFocusBefore = await taggerButton.evaluate((element) => (
      document.activeElement === element ? element.dataset.maintenanceJob : ""
    ));
    assert(taggerFocusBefore === "tagger-yomi",
      "tagger-yomi maintenance action was not focused before activation");
    await taggerButton.click();
    await taggerRequestSeen;
    await page.waitForFunction(() => state.maintenanceJobRunning === "tagger-yomi");
    const taggerBusy = await page.evaluate(() => {
      const button = document.querySelector('[data-maintenance-job="tagger-yomi"]');
      button?.click();
      button?.click();
      return {
        disabled: Boolean(button?.disabled),
        ariaDisabled: button?.getAttribute("aria-disabled"),
        ariaBusy: button?.getAttribute("aria-busy"),
        focus: document.activeElement?.dataset?.maintenanceJob || document.activeElement?.tagName || "",
      };
    });
    assert(
      maintenanceRequests.filter((request) => request.job === "tagger-yomi").length === 1
        && (taggerBusy.disabled || taggerBusy.ariaDisabled === "true")
        && taggerBusy.ariaBusy === "true",
      "tagger-yomi maintenance did not preserve focus during its single request",
      { maintenanceRequests, taggerBusy },
    );
    releaseTaggerMaintenance();
    await page.waitForFunction(() => !state.maintenanceJobRunning && Boolean(state.maintenanceJobError));
    const taggerError = await page.locator(".maintenance-job-message.is-error").textContent();
    const taggerFocusAfter = await page.evaluate(() => (
      document.activeElement?.dataset?.maintenanceJob || document.activeElement?.tagName || ""
    ));
    assert(
      maintenanceRequests.filter((request) => request.job === "tagger-yomi").length === 1
        && taggerError.includes("workflow unavailable"),
      "tagger-yomi did not send exactly one workflow request and expose error copy",
      { maintenanceRequests, taggerError, taggerFocusAfter },
    );
    await page.keyboard.press("Escape");
    assert(
      await advancedSummary.evaluate((element) => document.activeElement === element),
      "Maintenance Escape did not restore focus to the advanced-menu summary",
    );

    await advancedSummary.click();
    await maintenanceAction.click();
    const maintenanceRequestsBeforeNavigation = maintenanceRequests.length;
    await page.locator('[data-maintenance-job="monthly-d1-refresh"]').focus();
    await page.evaluate(() => setLanguage("en"));
    const languageFocus = await page.evaluate(() => (
      document.activeElement?.dataset?.maintenanceJob || document.activeElement?.tagName || ""
    ));
    assert(
      await page.locator(".maintenance-browser h2").textContent() === "D1 Maintenance"
        && maintenanceRequests.length === maintenanceRequestsBeforeNavigation,
      "language switching did not rerender Maintenance copy without a backend request",
      { languageFocus, maintenanceRequests },
    );
    await page.evaluate(() => setLanguage(window.__maintenancePlaybackNodes.language));
    await page.locator('[data-request-view="sources"]').click();
    await page.locator('[data-request-view="discover"]').click();
    const maintenancePlaybackEvidence = await page.evaluate(() => ({
      tool: state.catalogAdvancedTool,
      visible: !elements.catalogAdvancedView.hidden,
      sameSession: state.hostPlaybackSession === window.__maintenancePlaybackNodes.session,
      sameFrame: elements.playerFrame === window.__maintenancePlaybackNodes.frame,
      sameVideo: state.hostPlaybackSession?.video === window.__maintenancePlaybackNodes.video,
      sameAudio: state.hostPlaybackSession?.audio === window.__maintenancePlaybackNodes.audio,
    }));
    assert(
      maintenanceRequests.length === maintenanceRequestsBeforeNavigation
        && maintenancePlaybackEvidence.tool === "maintenance"
        && maintenancePlaybackEvidence.visible
        && maintenancePlaybackEvidence.sameSession
        && maintenancePlaybackEvidence.sameFrame
        && maintenancePlaybackEvidence.sameVideo
        && maintenancePlaybackEvidence.sameAudio
        && hostPlayerRequests.length === maintenancePlayerRequestsBefore,
      "Maintenance navigation reran a job, requested player work, or remounted playback identity",
      { maintenanceRequests, maintenancePlaybackEvidence, hostPlayerRequests },
    );
    const maintenanceFocusEvidence = {
      monthly: { before: monthlyFocusBefore, during: monthlyBusy.focus, after: monthlyFocusAfter },
      tagger: { before: taggerFocusBefore, during: taggerBusy.focus, after: taggerFocusAfter },
      language: languageFocus,
    };
    assert(
      monthlyFocusBefore === "monthly-d1-refresh"
        && !monthlyBusy.disabled
        && monthlyBusy.ariaDisabled === "true"
        && monthlyBusy.focus === "monthly-d1-refresh"
        && monthlyFocusAfter === "monthly-d1-refresh"
        && taggerFocusBefore === "tagger-yomi"
        && !taggerBusy.disabled
        && taggerBusy.ariaDisabled === "true"
        && taggerBusy.focus === "tagger-yomi"
        && taggerFocusAfter === "tagger-yomi"
        && languageFocus === "monthly-d1-refresh",
      "Maintenance actions did not preserve logical focus across request and language rerenders",
      maintenanceFocusEvidence,
    );
    await page.locator("#catalog-advanced-back").click();
    await page.evaluate(() => setDeveloperMode(false));
    assert(
      await page.evaluate(() => !state.maintenanceJobRunning
        && !state.maintenanceJobMessage
        && !state.maintenanceJobError
        && !state.catalogAdvancedTool),
      "disabling developer mode did not reset Maintenance state",
    );

    await page.locator('[data-request-view="sources"]').click();
    await page.locator('[data-sources-mode="uids"]').click();
    const sourcesBeforeOpen = sourceBrowseRequests.length;
    await page.locator("#open-added-uids-button").click();
    await page.waitForSelector("#follow-up-grid button[data-uid='42']");
    await page.locator("#follow-up-grid button[data-uid='42']").click();
    await page.waitForSelector("#follow-song-results .search-result-item");
    await page.locator("#follow-browse-back").click();
    await page.locator('[data-sources-mode="favorites"]').click();
    const sourcesBeforeFavoriteOpen = sourceBrowseRequests.length;
    await page.locator("#open-favorites-button").click();
    await page.waitForSelector("#favlist-grid button[data-folder-id='7']");
    await page.locator("#favlist-grid button[data-folder-id='7']").click();
    await page.waitForSelector("#favlist-song-results .search-result-item");
    assert(
      sourceBrowseRequests.length === sourcesBeforeFavoriteOpen + 2
        && sourcesBeforeFavoriteOpen === sourcesBeforeOpen + 2,
      "Sources did not load only from explicit owner/folder actions",
      sourceBrowseRequests,
    );

    assert(sourceUidAddRequests.length === 0,
      "a non-Sources Request/Discover/Random surface sent an Add UID command",
      sourceUidAddRequests);
    await page.locator('[data-sources-mode="uids"]').click();
    await page.locator("#modal-follow-uid-input").fill("https://space.bilibili.com/4242");
    await page.locator("#modal-follow-uid-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => state.confirmIntent?.type === "gatcha-uid-add");
    assert(
      sourceUidPreviewRequests.length === 1
        && sourceUidPreviewRequests[0].uid === "https://space.bilibili.com/4242"
        && sourceUidAddRequests.length === 0,
      "canonical Sources Add UID did not stop after one preview for confirmation",
      { sourceUidPreviewRequests, sourceUidAddRequests },
    );
    await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => !state.gatchaUidSaving);
    assert(
      sourceUidAddRequests.length === 1 && sourceUidAddRequests[0].uid === "4242",
      "canonical Sources confirmation did not send exactly one normalized accepted Add UID command",
      sourceUidAddRequests,
    );

    const detailOriginEvidence = [];
    async function verifyDetailOrigin({ key, setup, resultSelector, subview, mode, source }) {
      await setup();
      const row = page.locator(resultSelector).first();
      await row.waitFor({ state: "visible" });
      await row.evaluate((element) => element.click());
      await detail.waitFor({ state: "visible" });
      const evidence = await page.evaluate((originKey) => {
        const selected = state.requestDetailSelections?.[originKey];
        return {
          activeKey: state.activeRequestDetailOriginKey || "",
          selectedKey: selected?.selectedKey || "",
          origin: selected?.origin || null,
          closedForNavigation: selected?.closedForNavigation,
          selectedRows: document.querySelectorAll(`[data-request-result-origin="${originKey}"].is-selected`).length,
        };
      }, key);
      assert(
        evidence.activeKey === key
          && evidence.selectedKey
          && evidence.origin?.subview === subview
          && evidence.origin?.mode === mode
          && evidence.origin?.source === source
          && evidence.closedForNavigation === false
          && evidence.selectedRows === 1,
        `song detail did not record exact ${key} origin and selected row`,
        evidence,
      );
      detailOriginEvidence.push({ key, ...evidence });
      await detail.locator("[data-song-detail-close]").evaluate((button) => button.click());
      await page.waitForTimeout(250);
      assert(await detail.evaluate((element) => element.classList.contains("hidden")),
        `${key} detail did not close after origin inspection`);
    }

    await verifyDetailOrigin({
      key: "shared",
      setup: async () => {
        await page.locator('[data-request-view="search"]').click();
        await page.locator('[data-search-mode="shared"]').click();
      },
      resultSelector: "#lark-search-results .search-result-item",
      subview: "search",
      mode: "shared",
      source: "lark",
    });
    await verifyDetailOrigin({
      key: "local",
      setup: async () => { await page.locator('[data-search-mode="local"]').click(); },
      resultSelector: "#search-results .search-result-item",
      subview: "search",
      mode: "local",
      source: "search",
    });
    await verifyDetailOrigin({
      key: "categories",
      setup: async () => {
        await page.locator('[data-request-view="discover"]').click();
        await page.locator('[data-discover-mode="categories"]').click();
      },
      resultSelector: "#request-discover-categories .search-result-item",
      subview: "discover",
      mode: "categories",
      source: "discover",
    });
    await verifyDetailOrigin({
      key: "name",
      setup: async () => {
        await page.locator('[data-discover-mode="name"]').click();
        if (await page.evaluate(() => state.d1BrowseLevel !== "items")) {
          await page.locator('#request-discover-name [data-tag="Anime"]').evaluate((button) => button.click());
        }
      },
      resultSelector: "#request-discover-name .search-result-item",
      subview: "discover",
      mode: "name",
      source: "discover",
    });
    await verifyDetailOrigin({
      key: "artist",
      setup: async () => { await page.locator('[data-discover-mode="artist"]').click(); },
      resultSelector: "#request-discover-artist .search-result-item",
      subview: "discover",
      mode: "artist",
      source: "discover",
    });
    await verifyDetailOrigin({
      key: "uids",
      setup: async () => {
        await page.locator('[data-request-view="sources"]').click();
        await page.locator('[data-sources-mode="uids"]').click();
        if (!await page.locator("#follow-song-results .search-result-item").count()) {
          await page.locator("#follow-up-grid button[data-uid='42']").click();
          await page.waitForSelector("#follow-song-results .search-result-item");
        }
      },
      resultSelector: "#follow-song-results .search-result-item",
      subview: "sources",
      mode: "uids",
      source: "modalFollow",
    });
    await verifyDetailOrigin({
      key: "favorites",
      setup: async () => { await page.locator('[data-sources-mode="favorites"]').click(); },
      resultSelector: "#favlist-song-results .search-result-item",
      subview: "sources",
      mode: "favorites",
      source: "modalFavlist",
    });
    assert(
      new Set(detailOriginEvidence.map((entry) => entry.selectedKey)).size === 7,
      "Request result origins did not retain seven independent selections",
      detailOriginEvidence,
    );

    await page.locator('[data-request-view="search"]').click();
    await page.locator('[data-search-mode="shared"]').click();
    await page.locator("#lark-search-results .search-result-item").first().evaluate((element) => element.click());
    await detail.waitFor({ state: "visible" });
    await page.evaluate(() => {
      window.__requestDetailNavigationCloseCount = 0;
      const close = searchDetailController.close.bind(searchDetailController);
      searchDetailController.close = (options) => {
        window.__requestDetailNavigationCloseCount += 1;
        return close(options);
      };
      activateSearchMode("local");
    });
    const navigationCloseEvidence = await page.evaluate(() => ({
      count: window.__requestDetailNavigationCloseCount,
      detailHidden: searchDetailController.root.classList.contains("hidden"),
      activeKey: state.activeRequestDetailOriginKey || "",
      sharedClosedForNavigation: state.requestDetailSelections?.shared?.closedForNavigation,
      localSelectedKey: state.requestDetailSelections?.local?.selectedKey || "",
    }));
    assert(
      navigationCloseEvidence.count === 1
        && navigationCloseEvidence.detailHidden
        && !navigationCloseEvidence.activeKey
        && navigationCloseEvidence.sharedClosedForNavigation === true
        && navigationCloseEvidence.localSelectedKey,
      "mode navigation did not close only the visible prior-mode detail while retaining independent selections",
      navigationCloseEvidence,
    );
    await page.locator('[data-search-mode="shared"]').click();
    assert(
      await page.locator('#lark-search-results [data-request-result-origin="shared"].is-selected').count() === 1
        && await detail.evaluate((element) => element.classList.contains("hidden")),
      "returning to Shared did not restore only its selected row without reopening detail",
    );

    await page.locator('[data-search-mode="local"]').click();
    await page.locator("#search-results .search-result-item").first().evaluate((element) => element.click());
    await detail.waitFor({ state: "visible" });
    await page.locator("#search-results .search-result-item").first().evaluate((element) => element.remove());
    await detail.locator("[data-song-detail-close]").evaluate((button) => button.click());
    await page.waitForTimeout(250);
    const detachedFocusEvidence = await page.evaluate(() => ({
      activeSearchMode: document.activeElement?.dataset?.searchMode || "",
      activeId: document.activeElement?.id || "",
      detached: !state.requestDetailSelections?.local?.focusElement?.isConnected,
    }));
    assert(
      detachedFocusEvidence.detached
        && ["local", "search-results"].includes(detachedFocusEvidence.activeSearchMode || detachedFocusEvidence.activeId),
      "detached detail origin did not return focus to a safe owning mode control/result list",
      detachedFocusEvidence,
    );

    await page.locator('[data-search-mode="shared"]').click();
    const layeredDetailOpener = page.locator("#lark-search-results .search-result-item").nth(1);
    await layeredDetailOpener.evaluate((element) => element.click());
    await detail.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden"))
        && await page.evaluate(() => state.hostWorkspaceOverlayOpen)
        && await layeredDetailOpener.evaluate((element) => document.activeElement === element),
      "song-detail Escape did not close only detail above Request overlay and restore its result",
    );

    await page.locator('[data-request-view="sources"]').click();
    await page.locator('[data-sources-mode="uids"]').click();
    await page.locator("#modal-add-follow-uid-button").focus();
    await page.evaluate(() => {
      openBindingModal({
        source: "modalFollow",
        focusElement: document.activeElement,
      }, {
        title: "Layered source task",
        preferred_page: 1,
        pages: [{ page: 1, part: "P1", duration: 120 }],
      });
      elements.bindingModalCancel.focus({ preventScroll: true });
    });
    await page.keyboard.press("Escape");
    assert(
      !await page.locator("#binding-modal").isVisible()
        && await page.evaluate(() => state.hostWorkspaceOverlayOpen)
        && await page.locator("#modal-add-follow-uid-button").evaluate((element) => document.activeElement === element),
      "source/page task Escape did not close only the task above Request overlay and restore its opener",
    );

    await page.locator("#work-rail-random").click();
    assert(await page.locator("#manage-sources-button").isVisible(), "Random lost its single Manage sources entry");
    await page.locator("#manage-sources-button").click();
    assert(
      await page.evaluate(() => state.activeHostWorkspace === "request"
        && state.requestSubview === "sources"
        && !elements.requestWorkspace.hidden),
      "Random Manage sources did not route to the unified Sources subview",
    );
    await page.locator("#work-rail-queue").click();
    if (await page.locator("#stage-controls-toggle").isVisible()) {
      await page.locator("#stage-controls-toggle").click();
    }
    const playbackInfoRegions = page.locator(".playback-contextual-info-region");
    const playbackInfoButtons = page.locator(".playback-contextual-info-button");
    assert(await playbackInfoButtons.count() === 2, "Host A/V and Key did not expose exactly two information triggers");
    assert(
      await playbackInfoButtons.locator(".contextual-info-glyph").allTextContents()
        .then((glyphs) => glyphs.every((glyph) => glyph.trim() === "i")),
      "Host playback information did not use the lowercase i glyph",
    );
    assert(await page.locator("#av-sync-panel .av-sync-hint").count() === 0, "Host A/V retained its persistent explanation");
    assert(await page.locator("#key-shift-panel .av-sync-hint").count() === 0, "Host Key retained its persistent explanation");
    assert(await page.locator("#volume-panel .volume-hint").count() === 0, "Host volume retained its redundant explanation");
    assert(await page.locator("#volume-panel .playback-contextual-info-button").count() === 0, "Host volume gained a mechanical information trigger");

    await page.evaluate(() => {
      window.__hostPlaybackInfoActions = 0;
      window.__hostPlaybackInfoSession = state.hostPlaybackSession;
      for (const selector of [
        ".av-sync-step-button",
        "#av-offset-input",
        "#av-offset-reset-button",
        "#av-delay-lock-button",
        "#volume-mute-button",
        "#volume-slider",
        "#key-shift-input",
        "#key-shift-reset-button",
        "#player-fullscreen-button",
        "#next-button",
      ]) {
        document.querySelectorAll(selector).forEach((element) => {
          for (const eventName of ["click", "input", "change"]) {
            element.addEventListener(eventName, () => { window.__hostPlaybackInfoActions += 1; });
          }
        });
      }
    });
    const hostPlayerRequestCountBeforeInfo = hostPlayerRequests.length;
    const playbackPanelGeometryBeforeInfo = await page.locator(".player-panel").evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }));
    const avInfo = playbackInfoButtons.first();
    const avTooltip = page.locator(`#${await avInfo.getAttribute("aria-describedby")}`);
    await playbackInfoRegions.first().locator(".section-tag").hover();
    await page.waitForTimeout(220);
    assert(await avTooltip.isVisible(), "Host A/V title hover did not expose contextual information");
    const avTooltipBox = await avTooltip.boundingBox();
    const playbackViewport = page.viewportSize();
    const avPanelBox = await page.locator("#av-sync-panel").boundingBox();
    assert(
      avTooltipBox && avPanelBox
        && avTooltipBox.x >= 0 && avTooltipBox.y >= 0
        && avTooltipBox.x + avTooltipBox.width <= playbackViewport.width
        && avTooltipBox.y + avTooltipBox.height <= playbackViewport.height,
      "Host A/V information was not bounded within the compact control tray viewport",
      { avTooltipBox, avPanelBox, playbackViewport },
    );
    await avTooltip.hover();
    await page.waitForTimeout(140);
    assert(await avTooltip.isVisible(), "moving into Host A/V information dismissed it");
    await page.locator("#stage-control-tray-title").hover();
    await page.waitForTimeout(330);
    assert(!await avTooltip.isVisible(), "Host A/V pointer leave did not dismiss transient information");

    const keyInfo = playbackInfoButtons.nth(1);
    const keyTooltip = page.locator(`#${await keyInfo.getAttribute("aria-describedby")}`);
    await keyInfo.focus();
    assert(await keyTooltip.isVisible(), "Host Key focus did not expose contextual information");
    assert(await keyInfo.evaluate((element) => document.activeElement === element), "Host Key information moved focus");
    await avInfo.click();
    assert(await avTooltip.isVisible() && await page.locator(".cache-advanced-info.is-visible").count() === 1,
      "Host playback click did not pin exactly one explanation");
    await page.locator("#stage-control-tray-title").hover();
    assert(await avTooltip.isVisible(), "Host playback pointer leave cleared pinned information");
    await keyInfo.click();
    await page.waitForTimeout(180);
    const playbackInfoTransfer = {
      avVisible: await avTooltip.isVisible(),
      keyVisible: await keyTooltip.isVisible(),
      visibleCount: await page.locator(".cache-advanced-info.is-visible").count(),
      avExpanded: await avInfo.getAttribute("aria-expanded"),
      keyExpanded: await keyInfo.getAttribute("aria-expanded"),
    };
    assert(
      !playbackInfoTransfer.avVisible && playbackInfoTransfer.keyVisible,
      "Host playback information did not transfer one-visible ownership",
      playbackInfoTransfer,
    );
    await page.locator("#stage-control-tray-title").click();
    await page.waitForTimeout(180);
    assert(!await keyTooltip.isVisible(), "Host playback outside click did not close contextual information");
    await keyInfo.click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(180);
    assert(!await keyTooltip.isVisible(), "Host playback Escape did not close contextual information");
    assert(await keyInfo.evaluate((element) => document.activeElement === element), "Host playback Escape moved focus from the trigger");
    assert(
      await page.evaluate(() => ({
        actions: window.__hostPlaybackInfoActions,
        sameSession: window.__hostPlaybackInfoSession === state.hostPlaybackSession,
      })).then((proof) => proof.actions === 0 && proof.sameSession),
      "Host playback information issued a control action or remounted the playback session",
    );
    const playbackPanelGeometryAfterInfo = await page.locator(".player-panel").evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }));
    assert(
      playbackPanelGeometryAfterInfo.width === playbackPanelGeometryBeforeInfo.width
        && playbackPanelGeometryAfterInfo.height === playbackPanelGeometryBeforeInfo.height,
      "Host contextual information changed playback-panel geometry",
      { playbackPanelGeometryBeforeInfo, playbackPanelGeometryAfterInfo },
    );
    assert(
      hostPlayerRequests.length === hostPlayerRequestCountBeforeInfo,
      "Host contextual information issued a player API request",
      { before: hostPlayerRequestCountBeforeInfo, requests: hostPlayerRequests },
    );
    if (await page.locator("#stage-controls-close").isVisible()) {
      await page.locator("#stage-controls-close").click();
    }

    await page.locator("#cache-settings-toggle").click();
    await page.locator("#cache-panel-advanced-trigger").click();
    const cachePanel = page.locator("#cache-panel");
    const confirmPopover = page.locator("#confirm-popover");

    await page.locator("#data-reset-button").click();
    assert(await confirmPopover.isVisible(), "service-settings child confirmation did not open");
    const dataResetConfirmation = await page.locator("#confirm-text").textContent();
    assert(
      dataResetConfirmation.includes("当前点歌列表")
        && dataResetConfirmation.includes("用户")
        && dataResetConfirmation.includes("历史记录")
        && dataResetConfirmation.includes("缓存")
        && dataResetConfirmation.includes("保留已唱归档")
        && dataResetConfirmation.includes("抽卡缓存"),
      "data-cleanup confirmation did not expose both deleted and retained scope",
      dataResetConfirmation,
    );
    await page.locator("#confirm-cancel").click();
    assert(!await confirmPopover.isVisible(), "child Cancel did not close its confirmation");
    assert(await cachePanel.isVisible(), "child Cancel closed the parent service-settings menu");

    await page.locator("#player-reset-button").click();
    await page.locator("#confirm-ok").click();
    await confirmPopover.waitFor({ state: "hidden" });
    assert(await cachePanel.isVisible(), "child Confirm closed the parent service-settings menu");

    await page.locator("#data-reset-button").click();
    await page.keyboard.press("Escape");
    assert(!await confirmPopover.isVisible(), "Escape did not close the service-settings child layer");
    assert(await cachePanel.isVisible(), "one Escape closed both child and parent settings layers");
    await page.keyboard.press("Escape");
    assert(!await cachePanel.isVisible(), "a later Escape did not close parent service settings");

    await page.locator("#cache-settings-toggle").click();
    await page.locator("#cache-panel-advanced-trigger").click();
    const advancedInfoRegions = page.locator("#cache-advanced-inline-view .cache-contextual-info-region");
    const advancedInfoButtons = page.locator("#cache-advanced-inline-view .cache-advanced-info-button");
    assert(await advancedInfoButtons.count() === 2, "advanced settings did not keep the audited two contextual explanations");
    assert(
      await advancedInfoButtons.locator(".contextual-info-glyph").allTextContents()
        .then((glyphs) => glyphs.every((glyph) => glyph.trim() === "i")),
      "advanced settings did not use the unified i glyph",
    );
    assert(
      await page.locator("#cache-advanced-inline-view .cache-advanced-info-button", { hasText: "?" }).count() === 0,
      "advanced settings retained a row-level question-mark trigger",
    );
    assert(
      await page.locator(".cache-data-cleanup-scope").isVisible(),
      "destructive data-cleanup scope was not retained inline",
    );
    const cleanupScope = await page.locator(".cache-data-cleanup-scope").textContent();
    assert(
      cleanupScope.includes("当前点歌列表")
        && cleanupScope.includes("用户")
        && cleanupScope.includes("历史记录")
        && cleanupScope.includes("缓存")
        && cleanupScope.includes("保留已唱归档")
        && cleanupScope.includes("抽卡缓存"),
      "inline data-cleanup scope did not identify deleted and retained data",
      cleanupScope,
    );
    assert(
      await page.locator(".cache-panel-update-row .cache-advanced-info-button").count() === 0,
      "the redundant stable-release explanation retained an info trigger",
    );
    assert(
      await page.locator("#data-reset-button").getAttribute("aria-describedby") === null,
      "data cleanup still depended on tooltip-only consent information",
    );

    const firstRegion = advancedInfoRegions.first();
    const firstInfo = advancedInfoButtons.first();
    const firstTooltipId = await firstInfo.getAttribute("aria-describedby");
    const firstTooltip = page.locator(`#${firstTooltipId}`);
    assert(await firstTooltip.getAttribute("role") === "tooltip", "advanced information lost its tooltip relationship");
    await firstRegion.locator(".cache-panel-label").hover();
    await page.waitForTimeout(220);
    const tooltipBox = await firstTooltip.boundingBox();
    assert(tooltipBox, "fine-pointer label hover did not expose advanced information");
    const viewport = page.viewportSize();
    assert(
      tooltipBox.x >= 0 && tooltipBox.y >= 0
        && tooltipBox.x + tooltipBox.width <= viewport.width
        && tooltipBox.y + tooltipBox.height <= viewport.height,
      "advanced tooltip escaped the viewport",
      { tooltipBox, viewport },
    );
    await firstTooltip.hover();
    await page.waitForTimeout(140);
    assert(await firstTooltip.isVisible(), "moving from the label into its bubble dismissed the tooltip");
    await page.mouse.move(10, 500);
    await page.waitForTimeout(330);
    assert(!await firstTooltip.isVisible(), "pointer leave did not dismiss transient advanced information");

    await advancedInfoButtons.nth(1).focus();
    assert(
      await page.locator(`#${await advancedInfoButtons.nth(1).getAttribute("aria-describedby")}`).isVisible(),
      "keyboard focus did not expose advanced information",
    );
    assert(
      await advancedInfoButtons.nth(1).evaluate((element) => document.activeElement === element),
      "keyboard-opened information moved focus away from its trigger",
    );

    await page.evaluate(() => {
      window.__hostInfoUnderlyingActions = 0;
      for (const selector of [
        "#current-cache-retry-button",
        "#player-reset-button",
        "#diagnostic-copy-button",
        "#diagnostic-package-button",
      ]) {
        document.querySelector(selector)?.addEventListener("click", () => {
          window.__hostInfoUnderlyingActions += 1;
        });
      }
    });
    await firstInfo.click();
    assert(await firstInfo.getAttribute("aria-expanded") === "true", "click did not pin advanced information");
    assert(
      await firstInfo.locator(".contextual-info-glyph").textContent() === "i",
      "pinning changed the visible information glyph",
    );
    assert(
      await page.evaluate(() => window.__hostInfoUnderlyingActions) === 0,
      "opening advanced information activated an underlying row action",
    );
    assert(!await confirmPopover.isVisible(), "opening advanced information opened an action confirmation");
    await page.mouse.move(10, 500);
    assert(
      await firstTooltip.isVisible(),
      "pinned advanced information did not survive pointer leave",
    );
    await advancedInfoRegions.nth(1).locator(".cache-panel-label").hover();
    await page.waitForTimeout(220);
    assert(
      await firstTooltip.isVisible() && await page.locator(".cache-advanced-info.is-visible").count() === 1,
      "hybrid hover displaced a tap-pinned explanation",
    );
    await firstInfo.click();
    assert(await firstInfo.getAttribute("aria-expanded") === "false", "a repeated click did not unpin advanced information");
    await page.waitForTimeout(180);
    assert(!await firstTooltip.isVisible(), "unpinning left advanced information visible");

    await advancedInfoButtons.nth(1).click();
    assert(await page.locator(".cache-advanced-info.is-visible").count() === 1, "Host exposed more than one explanation");
    await page.locator("#cache-panel-version").click();
    assert(await page.locator(".cache-advanced-info.is-visible").count() === 0, "outside click did not close pinned Host information");
    assert(await cachePanel.isVisible(), "outside information click closed the parent service-settings panel");
    assert(await page.locator("#cache-advanced-inline-view").isVisible(), "outside information click closed advanced settings");

    await advancedInfoButtons.nth(1).click();
    await page.keyboard.press("Escape");
    assert(await page.locator(".cache-advanced-info.is-visible").count() === 0, "Escape did not close pinned Host information");
    assert(
      await advancedInfoButtons.nth(1).evaluate((element) => document.activeElement === element),
      "Escape moved focus away from the Host information trigger",
    );
    assert(await cachePanel.isVisible(), "information Escape closed the parent service-settings panel");
    assert(await page.locator("#cache-advanced-inline-view").isVisible(), "information Escape closed advanced settings");

    const serviceHealthClass = await page.locator("#service-status-indicator").getAttribute("class");
    await page.evaluate(() => {
      elements.appToast.classList.add("hidden");
      if (state.appToastTimer) window.clearTimeout(state.appToastTimer);
      state.appToastTimer = null;
    });
    const renderUpdateState = async (update, previewEnabled = false) => page.evaluate(
      ({ nextUpdate, preview }) => {
        state.updatePreviewEnabled = preview;
        state.updateCheckRequestInFlight = false;
        state.manualUpdateCheck = null;
        state.data.app_update = nextUpdate;
        renderUpdatePreviewControl();
        return {
          serviceRing: elements.serviceUpdateIndicator.classList.contains("has-update"),
          advancedIndicator: !elements.advancedUpdateIndicator.classList.contains("hidden"),
          rowHighlighted: elements.appUpdateRow.classList.contains("has-update"),
          versionBadge: elements.updateVersionBadge.classList.contains("hidden")
            ? ""
            : elements.updateVersionBadge.textContent,
          buttonText: elements.updateCheckButton.textContent,
          statusText: elements.appUpdateStatus.textContent,
          serviceAccessible: elements.serviceUpdateIndicator.getAttribute("aria-label"),
        };
      },
      { nextUpdate: update, preview: previewEnabled },
    );
    const noBadgeStates = {
      unknown: { state: "idle", include_preview: false, updated_at: 10 },
      checking: { state: "checking", operation: "check", include_preview: false, updated_at: 11 },
      current: { state: "idle", operation: "check", include_preview: false, updated_at: 12, update_action: "no_action", message: "current" },
      failed: { state: "failed", operation: "check", include_preview: false, updated_at: 13, error: "offline" },
    };
    for (const [name, update] of Object.entries(noBadgeStates)) {
      const rendered = await renderUpdateState(update);
      assert(
        !rendered.serviceRing && !rendered.advancedIndicator
          && !rendered.rowHighlighted && !rendered.versionBadge,
        `${name} update state showed an availability badge`,
        rendered,
      );
      assert(!await page.locator("#app-toast").isVisible(), `${name} automatic update state showed an intrusive toast`);
    }

    const installableUpdate = {
      state: "available",
      operation: "check",
      include_preview: false,
      updated_at: 14,
      update_action: "normal_upgrade",
      update_reason: "newer_version",
      eligible_update: true,
      update_available: true,
      latest_version: "v0.8.1",
      release_url: "https://example.test/releases/v0.8.1",
      auto_update_supported: true,
      message: "available",
    };
    const installableRendered = await renderUpdateState(installableUpdate);
    assert(
      installableRendered.serviceRing && installableRendered.advancedIndicator
        && installableRendered.rowHighlighted
        && installableRendered.versionBadge.includes("v0.8.1")
        && installableRendered.buttonText.includes("v0.8.1")
        && installableRendered.serviceAccessible?.includes("v0.8.1"),
      "eligible installable update did not ring Service health and show its detailed action",
      installableRendered,
    );
    assert(
      await page.locator("#service-status-indicator").getAttribute("class") === serviceHealthClass,
      "update availability altered the independent service-health indicator",
    );
    await page.locator("#cache-panel-advanced-trigger").click();
    assert(!await page.locator("#cache-advanced-inline-view").isVisible(), "advanced settings did not collapse for indicator proof");
    assert(await page.locator("#advanced-update-indicator").isVisible(), "collapsed advanced entry hid the update indicator");
    await page.locator("#cache-panel-advanced-trigger").click();

    await renderUpdateState(installableUpdate);
    await page.locator("#update-check-button").click();
    assert(await confirmPopover.isVisible(), "known installable update did not require an explicit confirmation");
    assert(updateInstallRequests.length === 0, "update action installed before explicit confirmation");
    await page.locator("#confirm-ok").click();
    await page.waitForTimeout(100);
    assert(updateInstallRequests.length === 1, "explicit update confirmation did not invoke the install route");

    await page.evaluate(() => {
      window.__openedUpdateReleaseUrls = [];
      window.open = (url) => { window.__openedUpdateReleaseUrls.push(String(url)); return null; };
    });
    const viewOnlyUpdate = {
      ...installableUpdate,
      updated_at: 15,
      latest_version: "v0.8.2",
      release_url: "https://example.test/releases/v0.8.2",
      auto_update_supported: false,
    };
    const viewRendered = await renderUpdateState(viewOnlyUpdate);
    assert(viewRendered.buttonText.includes("v0.8.2"), "unsupported update did not show a version-specific view action");
    await page.locator("#update-check-button").click();
    const openedUpdateReleaseUrls = await page.evaluate(() => window.__openedUpdateReleaseUrls);
    assert(
      openedUpdateReleaseUrls.length === 1 && openedUpdateReleaseUrls[0].includes("v0.8.2"),
      "version-specific view action did not open the validated release URL",
    );
    assert(updateInstallRequests.length === 1, "view-only action invoked automatic installation");

    const updateChecksBeforeManual = updateCheckRequests.length;
    await renderUpdateState({ state: "idle", operation: "check", include_preview: false, updated_at: 16 });
    await page.locator("#update-check-button").focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    assert(
      updateCheckRequests.length === updateChecksBeforeManual + 1
        && updateCheckRequests.at(-1).include_preview === false,
      "manual Check for updates did not invoke stable check-only",
      updateCheckRequests,
    );
    assert(updateInstallRequests.length === 1, "manual Check for updates invoked installation");
    await page.evaluate(() => {
      state.data.app_update = {
        state: "failed",
        operation: "check",
        include_preview: false,
        updated_at: 17,
        error: "manual offline",
      };
      renderUpdatePreviewControl();
    });
    assert(await page.locator("#app-toast").isVisible(), "manual check failure did not use the bounded message pattern");
    assert((await page.locator("#app-toast").textContent()).includes("manual offline"), "manual failure message was not preserved");
    await page.evaluate(() => {
      elements.appToast.classList.add("hidden");
      if (state.appToastTimer) window.clearTimeout(state.appToastTimer);
      state.appToastTimer = null;
    });

    await renderUpdateState(installableUpdate);
    await page.locator('label[for="update-preview-checkbox"]').click();
    assert(await page.locator("#update-preview-checkbox").isChecked(), "preview preference was not keyboard/touch-accessible");
    assert(
      !await page.locator("#service-update-indicator").evaluate((element) => element.classList.contains("has-update")),
      "stable result remained current after selecting preview",
    );
    const updateChecksBeforePreview = updateCheckRequests.length;
    await page.locator("#update-check-button").click();
    await page.waitForTimeout(100);
    assert(
      updateCheckRequests.length === updateChecksBeforePreview + 1
        && updateCheckRequests.at(-1).include_preview === true,
      "preview selection did not produce an explicit preview check-only request",
      updateCheckRequests,
    );
    assert(updateInstallRequests.length === 1, "preview toggle caused automatic installation");
    const previewRendered = await renderUpdateState({
      ...installableUpdate,
      include_preview: true,
      updated_at: 18,
      latest_version: "v0.9.0-preview.1",
    }, true);
    assert(previewRendered.serviceRing, "eligible preview result did not become current on the preview channel");
    const staleStableRendered = await renderUpdateState(installableUpdate, true);
    assert(!staleStableRendered.serviceRing, "stale stable result overwrote the selected preview channel");
    await renderUpdateState({
      ...installableUpdate,
      include_preview: true,
      updated_at: 18,
      latest_version: "v0.9.0-preview.1",
    }, true);
    const updateScreenshotPath = screenshotPath
      ? screenshotPath.replace(/(\.[^./]+)$/, "-update$1")
      : "";
    if (updateScreenshotPath) {
      await page.screenshot({ path: updateScreenshotPath, fullPage: false });
    }

    const hostInfoVisualMetrics = await firstInfo.evaluate((button) => {
      const glyph = button.querySelector(".contextual-info-glyph");
      const buttonRect = button.getBoundingClientRect();
      const glyphRect = glyph.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        glyphWidth: glyphRect.width,
        glyphHeight: glyphRect.height,
        opacity: Number(getComputedStyle(button).opacity),
      };
    });
    assert(
      hostInfoVisualMetrics.buttonWidth > hostInfoVisualMetrics.glyphWidth
        && hostInfoVisualMetrics.buttonHeight > hostInfoVisualMetrics.glyphHeight
        && hostInfoVisualMetrics.opacity < 1,
      "fine-pointer Host information control was not compact and low-noise with a larger hit target",
      hostInfoVisualMetrics,
    );

    const remoteControl = page.locator("#remote-mini-control");
    const remoteTrigger = page.locator("#remote-mini-trigger");
    const remotePopover = page.locator("#remote-mini-popover");
    await remoteControl.hover();
    assert(await remotePopover.isVisible(), "QR hover preview was lost");
    await page.mouse.move(10, 500);
    assert(!await remotePopover.isVisible(), "transient QR preview remained after pointer leave");
    await remoteTrigger.focus();
    assert(await remotePopover.isVisible(), "QR keyboard focus did not expose preview");
    await remoteTrigger.click();
    assert(await remoteTrigger.getAttribute("aria-expanded") === "true", "QR click did not pin the popup");
    await page.mouse.move(10, 500);
    assert(await remotePopover.isVisible(), "pinned QR popup did not survive pointer leave");
    await remoteTrigger.click();
    assert(!await remotePopover.isVisible(), "a second QR trigger click did not close the pinned popup");
    await remoteTrigger.click();
    assert(await remotePopover.isVisible(), "QR popup did not reopen after a repeated trigger click");
    await remotePopover.locator(".remote-mini-popover-card").click({ position: { x: 12, y: 12 } });
    assert(await remotePopover.isVisible(), "clicking inside the QR popup closed it");
    assert(await cachePanel.isVisible(), "QR popup interaction closed parent service settings");
    assert(
      Number(await remotePopover.evaluate((element) => getComputedStyle(element).zIndex))
        > Number(await cachePanel.evaluate((element) => getComputedStyle(element).zIndex)),
      "QR popup was not above Host settings surfaces",
    );
    await page.locator("#remote-mini-popover-close").click();
    assert(!await remotePopover.isVisible(), "explicit QR close action did not close the popup");
    assert(await cachePanel.isVisible(), "explicit QR close action closed parent service settings");
    await remoteTrigger.click();
    await page.keyboard.press("Escape");
    const qrEscapeEvidence = await page.evaluate(() => ({
      remoteQrPinned: state.remoteQrPinned,
      cacheSettingsOpen: state.cacheSettingsOpen,
      overlayOpen: state.hostWorkspaceOverlayOpen,
      activeWorkspace: state.activeHostWorkspace,
      visibleInfo: document.querySelectorAll(".cache-advanced-info.is-visible").length,
      rowMenu: Boolean(state.openRowMenuTrigger),
    }));
    assert(!await remotePopover.isVisible(), "Escape did not close pinned QR popup", qrEscapeEvidence);
    assert(await cachePanel.isVisible(), "QR Escape closed parent service settings");
    assert(await page.locator("#remote-mini-popover").count() === 1, "QR popup nodes were duplicated");
    await remoteTrigger.click();
    await page.locator("h1").click();
    assert(!await remotePopover.isVisible(), "true outside click did not close pinned QR popup");
    assert(!await cachePanel.isVisible(), "true outside click did not retain parent outside-click behavior");

    await page.locator("#work-rail-users").click();
    const sessionUserList = page.locator("#session-user-list");
    await sessionUserList.scrollIntoViewIfNeeded();
    const emptyHeight = await sessionUserList.locator(".session-user-empty").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await sessionUserList.evaluate((element) => {
      element.innerHTML = '<div class="session-user-badge" draggable="true"><span class="session-user-order-number">1</span><span>User</span></div>';
    });
    const badgeHeight = await sessionUserList.locator(".session-user-badge").evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    assert(emptyHeight === badgeHeight, "empty-user prompt height did not match one badge row", {
      emptyHeight,
      badgeHeight,
    });
    const fittingMetrics = await sessionUserList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    assert(fittingMetrics.scrollHeight <= fittingMetrics.clientHeight, "fitting user list had effective scrolling", fittingMetrics);
    await sessionUserList.hover();
    const pageScrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(60);
    assert(await sessionUserList.evaluate((element) => element.scrollTop) === 0, "fitting user list consumed wheel movement");
    assert(
      await page.evaluate(() => window.scrollY) === pageScrollBefore,
      "wheel over a fitting user list escaped into document/body scrolling",
    );

    await sessionUserList.evaluate((element) => {
      element.innerHTML = Array.from({ length: 5 }, (_, index) => (
        `<div class="session-user-badge" draggable="true"><span class="session-user-order-number">${index + 1}</span><span>User ${index}</span></div>`
      )).join("");
    });
    const severalUserMetrics = await sessionUserList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    assert(
      severalUserMetrics.scrollHeight <= severalUserMetrics.clientHeight,
      "a fitting several-user list had effective scrolling",
      severalUserMetrics,
    );

    await sessionUserList.evaluate((element) => {
      element.innerHTML = Array.from({ length: 120 }, (_, index) => (
        `<div class="session-user-badge" draggable="true"><span class="session-user-order-number">${index + 1}</span><span>User ${index}</span></div>`
      )).join("");
    });
    await sessionUserList.scrollIntoViewIfNeeded();
    await sessionUserList.hover();
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(60);
    const overflowingMetrics = await sessionUserList.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    assert(
      overflowingMetrics.scrollHeight > overflowingMetrics.clientHeight && overflowingMetrics.scrollTop > 0,
      "overflowing user list did not scroll natively",
      overflowingMetrics,
    );
    await page.setViewportSize({ width: 840, height: 1000 });
    assert(
      await sessionUserList.evaluate((element) => element.scrollHeight > element.clientHeight),
      "responsive resize lost overflowing user-list ownership",
    );
    await page.locator("#cache-settings-toggle").click();
    if (!await page.locator("#cache-advanced-inline-view").isVisible()) {
      await page.locator("#cache-panel-advanced-trigger").click();
    }
    for (let index = 0; index < await advancedInfoButtons.count(); index += 1) {
      const infoButton = advancedInfoButtons.nth(index);
      await advancedInfoRegions.nth(index).locator(".cache-panel-label").hover();
      await page.waitForTimeout(220);
      const tooltip = page.locator(`#${await infoButton.getAttribute("aria-describedby")}`);
      const box = await tooltip.boundingBox();
      const narrowViewport = page.viewportSize();
      assert(
        box && box.x >= 0 && box.y >= 0
          && box.x + box.width <= narrowViewport.width
          && box.y + box.height <= narrowViewport.height,
        "advanced tooltip escaped the narrow viewport",
        { index, box, narrowViewport },
      );
    }
    await sessionUserList.evaluate((element) => {
      element.replaceChildren(element.firstElementChild);
      element.scrollTop = 0;
    });
    assert(
      await sessionUserList.evaluate((element) => element.scrollHeight <= element.clientHeight),
      "removing users did not return the list to a fitting layout",
    );

    const remotePage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const remoteConsoleErrors = [];
    const remotePageErrors = [];
    const remoteRequestUrls = [];
    let remotePlayerControlRequests = 0;
    remotePage.on("console", (message) => {
      if (message.type() === "error") {
        remoteConsoleErrors.push(message.text());
      }
    });
    remotePage.on("pageerror", (error) => remotePageErrors.push(error.message));
    remotePage.on("request", (request) => remoteRequestUrls.push(request.url()));
    await remotePage.route("**/api/player/control", (route) => {
      remotePlayerControlRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "browser control proof" }),
      });
    });
    await remotePage.goto(`${baseUrl}/remote`, { waitUntil: "domcontentloaded" });
    await remotePage.waitForTimeout(700);
    const remoteIdentity = await remotePage.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyTextLength: String(document.body?.innerText || "").trim().length,
      frameworkOverlay: Boolean(document.querySelector(
        "nextjs-portal, vite-error-overlay, #webpack-dev-server-client-overlay",
      )),
    }));
    assert(remoteIdentity.url === `${baseUrl}/remote`, "browser opened the wrong Remote page", remoteIdentity);
    assert(remoteIdentity.title && remoteIdentity.bodyTextLength > 0, "Remote page was blank", remoteIdentity);
    assert(!remoteIdentity.frameworkOverlay, "Remote page showed a framework error overlay", remoteIdentity);

    await remotePage.evaluate(() => {
      closeEventStream();
      clearStateFallbackTimer();
      elements.remoteIdentityModal?.classList.add("hidden");
      document.body.classList.remove("remote-identity-modal-open");
      if (elements.remoteShell) {
        elements.remoteShell.inert = false;
      }
      const currentItem = {
        id: "browser-remote-item",
        item_incarnation_id: "browser-remote-incarnation",
        video_media_url: "/browser-video.mp4",
        audio_variants: [{ id: "browser-audio", audio_url: "/browser-audio.m4a" }],
      };
      state.data = {
        ...(state.data || {}),
        current_item: currentItem,
        playback_mode: "local",
        playback_generation: 1,
        player_status: {
          playback_generation: 1,
          is_paused: true,
          updated_at: 1,
        },
      };
      renderPlayerControls(currentItem, "local");
      renderFloatingControlTrigger(currentItem, "local");
    });
    const floatingTrigger = remotePage.locator("#floating-control-trigger");
    const floatingOverlay = remotePage.locator("#floating-control-overlay");
    await floatingTrigger.click();
    assert(await floatingOverlay.isVisible(), "Remote floating playback console did not open");
    await remotePage.waitForTimeout(500);
    const floatingToggle = remotePage.locator('#floating-player-control-panel [data-control-action="toggle-play"]');
    assert(await floatingToggle.isVisible() && !await floatingToggle.isDisabled(), "floating playback operation was unavailable");
    await floatingToggle.click();
    await remotePage.waitForTimeout(100);
    assert(
      remotePlayerControlRequests === 1,
      "floating playback operation did not dispatch its existing request",
      {
        remoteRequestUrls,
        state: await remotePage.evaluate(() => ({
          currentItem: state.data?.current_item,
          playbackMode: state.data?.playback_mode,
          playbackGeneration: state.data?.playback_generation,
          buttonDisabled: elements.floatingPlayerControlPanel
            ?.querySelector('[data-control-action="toggle-play"]')?.disabled,
        })),
      },
    );
    assert(await floatingOverlay.isVisible(), "floating playback operation closed its console");

    const remoteInfoRegions = remotePage.locator(".remote-contextual-info-region");
    const remoteInfoButtons = remotePage.locator(".remote-info-button");
    assert(await remoteInfoButtons.count() === 3, "Remote lost a playback information trigger");
    assert(
      await remoteInfoButtons.locator(".contextual-info-glyph").allTextContents()
        .then((glyphs) => glyphs.every((glyph) => glyph.trim() === "i")),
      "Remote playback controls lost the unified i glyph",
    );
    for (let index = 0; index < await remoteInfoButtons.count(); index += 1) {
      const button = remoteInfoButtons.nth(index);
      const tooltip = remotePage.locator(`#${await button.getAttribute("aria-describedby")}`);
      assert(await tooltip.getAttribute("role") === "tooltip", "Remote information lost its tooltip relationship", index);
    }

    const firstRemoteInfo = remoteInfoButtons.first();
    const firstRemoteTooltip = remotePage.locator(`#${await firstRemoteInfo.getAttribute("aria-describedby")}`);
    await remoteInfoRegions.first().locator(".panel-tag").hover();
    await remotePage.waitForTimeout(220);
    assert(await firstRemoteTooltip.isVisible(), "Remote fine-pointer label hover did not expose information");
    const remoteTooltipBox = await firstRemoteTooltip.boundingBox();
    const remoteViewport = remotePage.viewportSize();
    assert(
      remoteTooltipBox && remoteTooltipBox.x >= 0 && remoteTooltipBox.y >= 0
        && remoteTooltipBox.x + remoteTooltipBox.width <= remoteViewport.width
        && remoteTooltipBox.y + remoteTooltipBox.height <= remoteViewport.height,
      "Remote tooltip escaped the viewport",
      { remoteTooltipBox, remoteViewport },
    );
    await firstRemoteTooltip.hover();
    await remotePage.waitForTimeout(140);
    assert(await firstRemoteTooltip.isVisible(), "moving into the Remote bubble dismissed it");
    await remotePage.locator("#floating-control-title").hover();
    await remotePage.waitForTimeout(330);
    assert(!await firstRemoteTooltip.isVisible(), "Remote pointer leave did not dismiss transient information");

    await remoteInfoButtons.nth(1).focus();
    assert(
      await remotePage.locator(`#${await remoteInfoButtons.nth(1).getAttribute("aria-describedby")}`).isVisible(),
      "Remote keyboard focus did not expose information",
    );
    await firstRemoteInfo.click();
    assert(await firstRemoteInfo.getAttribute("aria-expanded") === "true", "Remote click did not pin information");
    await remotePage.locator("#floating-control-title").hover();
    assert(await firstRemoteTooltip.isVisible(), "Remote pointer leave cleared tap-pinned information");
    await remoteInfoRegions.nth(1).locator(".panel-tag").hover();
    await remotePage.waitForTimeout(220);
    assert(
      await firstRemoteTooltip.isVisible()
        && await remotePage.locator(".info-trigger-wrap.is-visible").count() === 1,
      "Remote hybrid hover displaced a tap-pinned explanation",
    );
    const remoteScreenshotPath = screenshotPath
      ? screenshotPath.replace(/(\.[^./]+)$/, "-remote$1")
      : "";
    if (remoteScreenshotPath) {
      await remotePage.screenshot({ path: remoteScreenshotPath, fullPage: false });
    }
    await remoteInfoButtons.nth(1).click();
    assert(
      await remotePage.locator(".info-trigger-wrap.is-visible").count() === 1
        && await firstRemoteInfo.getAttribute("aria-expanded") === "false",
      "Remote did not transfer one-visible ownership to the clicked trigger",
    );
    await remotePage.locator("#floating-control-title").click();
    assert(await remotePage.locator(".info-trigger-wrap.is-visible").count() === 0, "Remote outside click did not close information");
    assert(await floatingOverlay.isVisible(), "Remote information outside click closed the floating console");
    await remoteInfoButtons.nth(1).click();
    await remotePage.keyboard.press("Escape");
    assert(await remotePage.locator(".info-trigger-wrap.is-visible").count() === 0, "Remote Escape did not close information");
    assert(
      await remoteInfoButtons.nth(1).evaluate((element) => document.activeElement === element),
      "Remote Escape moved focus away from the information trigger",
    );
    assert(await floatingOverlay.isVisible(), "Remote information Escape closed the floating console");
    assert(await remotePage.locator(".remote-tooltip-bubble").count() === 3, "Remote duplicated tooltip nodes");
    await remotePage.locator("#floating-control-close").click();
    await floatingOverlay.waitFor({ state: "hidden" });
    assert(!await floatingOverlay.isVisible(), "Remote floating playback console did not close normally");

    const coarseContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const coarsePage = await coarseContext.newPage();
    const coarseUpdateChecks = [];
    await coarsePage.route("**/api/app/update/check", (route) => {
      const payload = route.request().postDataJSON();
      coarseUpdateChecks.push(payload);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { state: "checking", include_preview: Boolean(payload?.include_preview) } }),
      });
    });
    await coarsePage.route("**/api/gatcha/pool-config", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          uid_weight: 50,
          excluded_uids: [],
          excluded_favlist_folders: [],
          uid_options: [{ mid: "touch-uid", name: "Touch UID" }],
          favlist_options: [{ media_id: "touch-fav", title: "Touch favorite" }],
        },
      }),
    }));
    await coarsePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await coarsePage.waitForTimeout(700);
    assert(
      coarseUpdateChecks.length === 1 && coarseUpdateChecks[0].include_preview === false,
      "coarse Host startup did not keep the stable-only automatic check",
      coarseUpdateChecks,
    );
    const coarseRailTrigger = coarsePage.locator("#work-rail-random");
    const coarseRailBox = await coarseRailTrigger.boundingBox();
    assert(
      coarseRailBox && coarseRailBox.height >= 44,
      "coarse-pointer rail destination was smaller than 44px",
      coarseRailBox,
    );
    await coarsePage.touchscreen.tap(
      coarseRailBox.x + (coarseRailBox.width / 2),
      coarseRailBox.y + (coarseRailBox.height / 2),
    );
    assert(
      await coarsePage.evaluate(() => state.activeHostWorkspace) === "random"
        && await coarsePage.locator("#gatcha-panel").isVisible(),
      "touch activation did not switch to Random exactly once",
    );
    const coarseGatchaMetrics = await coarsePage.evaluate(() => {
      const ids = ["gatcha-pool-config-toggle", "manage-sources-button", "gatcha-button"];
      return Object.fromEntries(ids.map((id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return [id, { width: rect.width, height: rect.height }];
      }));
    });
    assert(
      Object.values(coarseGatchaMetrics).every(({ height }) => height >= 44),
      "coarse-pointer Gatcha actions were smaller than 44px",
      coarseGatchaMetrics,
    );
    await coarsePage.locator("#gatcha-pool-config-toggle").tap();
    await coarsePage.waitForFunction(() => !state.poolConfigLoading);
    const coarsePoolMetrics = await coarsePage.evaluate(() => {
      const selectors = [
        "#gatcha-pool-config-modal-close",
        "#gatcha-pool-config-modal-cancel",
        "#gatcha-pool-config-modal-save",
        "#gatcha-pool-uid-select-all",
        "#gatcha-pool-uid-select-none",
        "#gatcha-pool-config-modal-reset",
        ".pool-config-option",
      ];
      return Object.fromEntries(selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return [selector, { width: rect.width, height: rect.height }];
      }));
    });
    assert(
      Object.values(coarsePoolMetrics).every(({ height }) => height >= 44),
      "coarse-pointer pool task controls were smaller than 44px",
      coarsePoolMetrics,
    );
    await coarsePage.locator("#gatcha-pool-config-modal-cancel").tap();
    if (await coarsePage.locator("#stage-controls-toggle").isVisible()) {
      await coarsePage.locator("#stage-controls-toggle").tap();
    }
    await coarsePage.evaluate(() => {
      window.__coarsePlaybackInfoActions = 0;
      document.querySelectorAll([
        ".av-sync-step-button",
        "#av-offset-input",
        "#av-offset-reset-button",
        "#av-delay-lock-button",
        "#volume-mute-button",
        "#volume-slider",
        "#key-shift-input",
        "#key-shift-reset-button",
      ].join(",")).forEach((element) => {
        for (const eventName of ["click", "input", "change"]) {
          element.addEventListener(eventName, () => { window.__coarsePlaybackInfoActions += 1; });
        }
      });
    });
    const coarsePlaybackInfo = coarsePage.locator(".playback-contextual-info-button").first();
    await coarsePlaybackInfo.scrollIntoViewIfNeeded();
    const coarsePlaybackMetrics = await coarsePlaybackInfo.evaluate((button) => {
      const glyph = button.querySelector(".contextual-info-glyph");
      const buttonRect = button.getBoundingClientRect();
      const glyphRect = glyph.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        glyphWidth: glyphRect.width,
        glyphHeight: glyphRect.height,
        opacity: Number(getComputedStyle(button).opacity),
      };
    });
    assert(
      coarsePlaybackMetrics.buttonWidth >= 40 && coarsePlaybackMetrics.buttonHeight >= 40
        && coarsePlaybackMetrics.buttonWidth > coarsePlaybackMetrics.glyphWidth
        && coarsePlaybackMetrics.buttonHeight > coarsePlaybackMetrics.glyphHeight
        && coarsePlaybackMetrics.opacity === 1,
      "coarse-pointer Host playback information target was not discoverable and usable",
      coarsePlaybackMetrics,
    );
    const coarsePlaybackBox = await coarsePlaybackInfo.boundingBox();
    await coarsePage.touchscreen.tap(
      coarsePlaybackBox.x + (coarsePlaybackBox.width / 2),
      coarsePlaybackBox.y + (coarsePlaybackBox.height / 2),
    );
    assert(await coarsePlaybackInfo.getAttribute("aria-expanded") === "true", "Host playback touch tap did not pin information");
    assert(
      await coarsePage.evaluate(() => window.__coarsePlaybackInfoActions) === 0,
      "Host playback touch tap activated an adjacent playback control",
    );
    await coarsePage.locator("#stage-control-tray .stage-control-tray-head strong").tap();
    assert(await coarsePlaybackInfo.getAttribute("aria-expanded") === "false", "Host playback touch outside tap did not close information");
    await coarsePage.locator("#stage-controls-close").tap();
    await coarsePage.locator("#cache-settings-toggle").click();
    await coarsePage.locator("#cache-panel-advanced-trigger").click();
    await coarsePage.locator('label[for="update-automatic-checkbox"]').tap();
    assert(
      !await coarsePage.locator("#update-automatic-checkbox").isChecked()
        && await coarsePage.evaluate(() => localStorage.getItem("bilikara.update.automatic")) === "false",
      "coarse-pointer automatic-check preference was not touch-usable and persistent",
    );
    const coarseHostInfo = coarsePage.locator("#cache-advanced-inline-view .cache-advanced-info-button").first();
    await coarseHostInfo.scrollIntoViewIfNeeded();
    const coarseHostMetrics = await coarseHostInfo.evaluate((button) => {
      const glyph = button.querySelector(".contextual-info-glyph");
      const buttonRect = button.getBoundingClientRect();
      const glyphRect = glyph.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        glyphWidth: glyphRect.width,
        glyphHeight: glyphRect.height,
        opacity: Number(getComputedStyle(button).opacity),
      };
    });
    assert(
      coarseHostMetrics.buttonWidth >= 40 && coarseHostMetrics.buttonHeight >= 40
        && coarseHostMetrics.buttonWidth > coarseHostMetrics.glyphWidth
        && coarseHostMetrics.buttonHeight > coarseHostMetrics.glyphHeight
        && coarseHostMetrics.opacity === 1,
      "coarse-pointer Host information target was not visible and reliably sized",
      coarseHostMetrics,
    );
    const coarseHostBox = await coarseHostInfo.boundingBox();
    await coarsePage.touchscreen.tap(
      coarseHostBox.x + (coarseHostBox.width / 2),
      coarseHostBox.y + (coarseHostBox.height / 2),
    );
    assert(await coarseHostInfo.getAttribute("aria-expanded") === "true", "Host touch tap did not pin information");
    await coarsePage.locator("#cache-panel-version").tap();
    assert(await coarseHostInfo.getAttribute("aria-expanded") === "false", "Host touch outside tap did not close information");

    await coarsePage.goto(`${baseUrl}/remote`, { waitUntil: "domcontentloaded" });
    await coarsePage.waitForTimeout(700);
    await coarsePage.evaluate(() => {
      elements.remoteIdentityModal?.classList.add("hidden");
      document.body.classList.remove("remote-identity-modal-open");
      if (elements.remoteShell) {
        elements.remoteShell.inert = false;
      }
      elements.floatingControlOverlay?.classList.remove("hidden");
    });
    const coarseRemoteInfo = coarsePage.locator(".remote-info-button").first();
    await coarseRemoteInfo.scrollIntoViewIfNeeded();
    const coarseRemoteMetrics = await coarseRemoteInfo.evaluate((button) => {
      const glyph = button.querySelector(".contextual-info-glyph");
      const buttonRect = button.getBoundingClientRect();
      const glyphRect = glyph.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        glyphWidth: glyphRect.width,
        glyphHeight: glyphRect.height,
        opacity: Number(getComputedStyle(button).opacity),
      };
    });
    assert(
      coarseRemoteMetrics.buttonWidth >= 44 && coarseRemoteMetrics.buttonHeight >= 44
        && coarseRemoteMetrics.buttonWidth > coarseRemoteMetrics.glyphWidth
        && coarseRemoteMetrics.buttonHeight > coarseRemoteMetrics.glyphHeight
        && coarseRemoteMetrics.opacity === 1,
      "coarse-pointer Remote information target was not visible and reliably sized",
      coarseRemoteMetrics,
    );
    const coarseRemoteBox = await coarseRemoteInfo.boundingBox();
    await coarsePage.touchscreen.tap(
      coarseRemoteBox.x + (coarseRemoteBox.width / 2),
      coarseRemoteBox.y + (coarseRemoteBox.height / 2),
    );
    assert(await coarseRemoteInfo.getAttribute("aria-expanded") === "true", "Remote touch tap did not pin information");
    await coarsePage.touchscreen.tap(20, 20);
    assert(await coarseRemoteInfo.getAttribute("aria-expanded") === "false", "Remote touch outside tap did not close information");
    await coarseContext.close();

    assert(pageErrors.length === 0, "unexpected page errors", pageErrors);
    assert(consoleErrors.length === 0, "unexpected console errors", consoleErrors);
    assert(remotePageErrors.length === 0, "unexpected Remote page errors", remotePageErrors);
    assert(remoteConsoleErrors.length === 0, "unexpected Remote console errors", remoteConsoleErrors);
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    return {
      passed: true,
      identity,
      startupReadinessEvidence,
      wheelScrollTop,
      backgroundScrollTop,
      detailHidden,
      maintenance: {
        requests: maintenanceRequests,
        focus: maintenanceFocusEvidence,
        playbackIdentity: maintenancePlaybackEvidence,
        screenshotPath: maintenanceBusyScreenshotPath,
      },
      shell: shellEvidence,
      settings: {
        advancedInfoCount: await advancedInfoButtons.count(),
        layeredConfirmActions: true,
        qrPinning: true,
        updateScreenshotPath,
      },
      sessionUsers: {
        emptyHeight,
        badgeHeight,
        fittingMetrics,
        severalUserMetrics,
        overflowingMetrics,
      },
      consoleErrors,
      pageErrors,
      remote: {
        identity: remoteIdentity,
        infoCount: await remoteInfoButtons.count(),
        playerControlRequests: remotePlayerControlRequests,
        consoleErrors: remoteConsoleErrors,
        pageErrors: remotePageErrors,
        screenshotPath: remoteScreenshotPath,
      },
      coarse: {
        host: coarseHostMetrics,
        playback: coarsePlaybackMetrics,
        remote: coarseRemoteMetrics,
        gatcha: coarseGatchaMetrics,
        pool: coarsePoolMetrics,
      },
      screenshotPath: screenshotPath || "",
    };
  } finally {
    await browser.close();
  }
}

run().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stdout.write(`${JSON.stringify({
      passed: false,
      error: error.message,
      detail: error.detail,
      stack: error.stack,
    })}\n`);
    process.exitCode = 1;
  },
);
