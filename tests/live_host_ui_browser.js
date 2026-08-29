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
  const consoleErrors = [];
  const pageErrors = [];
  const hostPlayerRequests = [];
  const updateCheckRequests = [];
  const updateInstallRequests = [];
  const larkSearchRequests = [];
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

    const shellPage = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const shellConsoleErrors = [];
    const shellPageErrors = [];
    const shellPlayerRequests = [];
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
      if (new URL(request.url()).pathname.startsWith("/api/player/")) {
        shellPlayerRequests.push(request.url());
      }
    });
    await shellPage.route("**/api/app/update/check", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { state: "checking", include_preview: false } }),
    }));
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
          search: document.querySelectorAll("#search-panel").length,
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
      Math.abs(shellInitial.railWidth - 104) <= 2
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

    const queueNodeBeforeFlip = await shellPage.locator(".queue-card").evaluate((element) => {
      window.__hostShellQueueBeforeFlip = element;
      return Boolean(element);
    });
    await shellPage.locator("#history-toggle-button").click();
    await shellPage.waitForTimeout(520);
    assert(
      queueNodeBeforeFlip
        && await shellPage.evaluate(() => state.listView === "history"
          && document.querySelector(".queue-card") === window.__hostShellQueueBeforeFlip),
      "Queue workspace did not retain its existing History flip on the same card",
    );
    await shellPage.locator("#history-toggle-button").click();
    await shellPage.waitForTimeout(520);
    assert(
      await shellPage.evaluate(() => state.listView === "queue"
        && document.querySelector(".queue-card") === window.__hostShellQueueBeforeFlip),
      "History did not return to Queue on the existing feature node",
    );

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
        && navigationState.focused === "request"
        && navigationState.roving.join(",") === "request",
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
        request: document.querySelector("#host-workspace-request-direct"),
        search: document.querySelector("#search-panel"),
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

    const wideWidths = {};
    for (const workspace of ["queue", "request", "random", "users"]) {
      await shellPage.locator(`#work-rail-${workspace}`).click();
      wideWidths[workspace] = await shellPage.evaluate(() => ({
        workspace: elements.hostWorkspaceRegion?.getBoundingClientRect().width || 0,
        stage: document.querySelector(".left-column")?.getBoundingClientRect().width || 0,
        railIndependent: document.querySelector(".layout > .work-rail")?.parentElement
          === document.querySelector(".layout"),
        railGap: document.querySelector(".work-rail").getBoundingClientRect().left
          - elements.hostWorkspaceRegion.getBoundingClientRect().right,
        stageToolGap: elements.hostWorkspaceRegion.getBoundingClientRect().left
          - elements.playerPanel.getBoundingClientRect().right,
        sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
      }));
    }
    assert(
      Object.values(wideWidths).every((entry) => Math.abs(entry.workspace - 536) <= 2)
        && Object.values(wideWidths).every((entry) => entry.railIndependent
          && Math.abs(entry.railGap - 12) <= 1
          && Math.abs(entry.stageToolGap - 12) <= 1)
        && Object.values(wideWidths).every((entry) => entry.stage >= 760 && entry.sameFrame),
      "wide shell did not preserve one stable tool-card width and a useful persistent Stage",
      wideWidths,
    );

    const draftAndScroll = await shellPage.evaluate(() => {
      document.querySelector("#url-input").value = "BV-DRAFT-REQUEST";
      document.querySelector("#lark-search-query").value = "search draft";
      document.querySelector("#gatcha-uid-input").value = "random draft";
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
          document.querySelector("#gatcha-uid-input").value,
          document.querySelector("#session-user-input").value,
        ],
        sameNodes: document.querySelector(".queue-card") === window.__hostShellNodes.queue
          && document.querySelector("#host-workspace-request-direct") === window.__hostShellNodes.request
          && document.querySelector("#search-panel") === window.__hostShellNodes.search
          && document.querySelector("#gatcha-panel") === window.__hostShellNodes.random
          && document.querySelector("#session-users-panel") === window.__hostShellNodes.users,
      };
    });
    assert(
      draftAndScroll.storedBefore > 0
        && draftAndScroll.restored === draftAndScroll.storedBefore
        && draftAndScroll.drafts.join("|") === "BV-DRAFT-REQUEST|search draft|random draft|user draft"
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
    await shellPage.locator("#display-settings-toggle").click();
    await shellPage.locator("#cache-settings-toggle").click();
    assert(await shellPage.locator("#cache-panel").isVisible(), "compact toolbar lost Service settings");
    await shellPage.locator("#cache-settings-toggle").click();

    const shellWideScreenshotPath = suffixedPath(screenshotPath, "-wide");
    const shellMediumScreenshotPath = suffixedPath(screenshotPath, "-medium");
    const shellNarrowScreenshotPath = suffixedPath(screenshotPath, "-narrow");
    if (shellWideScreenshotPath) {
      await shellPage.locator("#work-rail-request").click();
      await shellPage.screenshot({ path: shellWideScreenshotPath, fullPage: false });
    }

    await shellPage.setViewportSize({ width: 1240, height: 800 });
    await shellPage.locator("#work-rail-queue").click();
    const mediumQueue = await shellPage.evaluate(() => ({
      railWidth: document.querySelector(".work-rail")?.getBoundingClientRect().width || 0,
      workspaceWidth: elements.hostWorkspaceRegion?.getBoundingClientRect().width || 0,
      stageWidth: document.querySelector(".left-column")?.getBoundingClientRect().width || 0,
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
    }));
    assert(
      Math.abs(mediumQueue.railWidth - 100) <= 2
        && Math.abs(mediumQueue.workspaceWidth - 500) <= 2
        && mediumQueue.stageWidth >= 580
        && mediumQueue.sameFrame,
      "medium Queue did not remain docked beside a useful Stage",
      mediumQueue,
    );
    await shellPage.locator("#work-rail-request").click();
    const mediumRequestOpen = await shellPage.evaluate(() => ({
      active: state.activeHostWorkspace,
      overlayOpen: state.hostWorkspaceOverlayOpen
        && hostRequestWorkspaceUsesOverlay(),
      width: elements.hostWorkspaceRegion?.getBoundingClientRect().width || 0,
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
      sameSearch: document.querySelector("#search-panel") === window.__hostShellNodes.search,
      draft: document.querySelector("#url-input").value,
      bodyScrollY: window.scrollY,
    }));
    assert(
      mediumRequestOpen.active === "request"
        && !mediumRequestOpen.overlayOpen
        && Math.abs(mediumRequestOpen.width - 500) <= 2
        && mediumRequestOpen.sameFrame
        && mediumRequestOpen.sameSearch
        && mediumRequestOpen.draft === "BV-DRAFT-REQUEST"
        && mediumRequestOpen.bodyScrollY === 0,
      "medium Request did not use the same stable direct tool-card geometry",
      mediumRequestOpen,
    );
    if (shellMediumScreenshotPath) {
      await shellPage.screenshot({ path: shellMediumScreenshotPath, fullPage: false });
    }
    const mediumRequestClosed = { overlayOpen: false, directDock: true };

    await shellPage.setViewportSize({ width: 840, height: 760 });
    await shellPage.locator("#work-rail-queue").click();
    const narrowInitial = await shellPage.evaluate(() => ({
      mode: elements.appShell?.dataset.stageMode,
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
      bodyScrollY: window.scrollY,
      bodyOverflow: getComputedStyle(document.body).overflow,
      stageClientHeight: document.querySelector(".left-column")?.clientHeight || 0,
      stageScrollHeight: document.querySelector(".left-column")?.scrollHeight || 0,
      railIndependent: document.querySelector(".layout > .work-rail")?.parentElement
        === document.querySelector(".layout"),
    }));
    assert(
      narrowInitial.mode === "narrow"
        && narrowInitial.sameFrame
        && narrowInitial.bodyScrollY === 0
        && narrowInitial.bodyOverflow === "hidden"
        && narrowInitial.stageScrollHeight <= narrowInitial.stageClientHeight + 1
        && narrowInitial.railIndependent,
      "narrow shell did not keep a bounded Stage beside its independent rail",
      narrowInitial,
    );
    await shellPage.locator("#stage-controls-toggle").click();
    await shellPage.waitForTimeout(180);
    const narrowControlEvidence = await shellPage.evaluate(() => ({
      open: !elements.stageControlTray.hidden && !elements.stageControlTray.inert,
      backdrop: !elements.stageControlBackdrop.hidden && !elements.stageControlBackdrop.inert,
      focusAtClose: document.activeElement === elements.stageControlsClose,
      oneDeck: document.querySelectorAll("#stage-extended-controls").length,
      controls: ["#av-offset-input", "#volume-slider", "#key-shift-input"].map((selector) => {
        const control = document.querySelector(selector);
        return Boolean(control?.offsetWidth || control?.offsetHeight || control?.getClientRects().length);
      }),
      sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
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
    assert(
      narrowControlEvidence.open
        && narrowControlEvidence.backdrop
        && narrowControlEvidence.focusAtClose
        && narrowControlEvidence.oneDeck === 1
        && narrowControlEvidence.controls.every(Boolean)
        && Object.values(narrowControlEvidence.geometry).every(Boolean)
        && narrowControlEvidence.sameFrame,
      "narrow floating playback panel did not expose the one existing control deck",
      narrowControlEvidence,
    );
    await shellPage.locator("#stage-control-backdrop").click({ position: { x: 4, y: 4 } });
    assert(await shellPage.evaluate(() => elements.stageControlTray.hidden
      && elements.stageControlBackdrop.hidden
      && document.activeElement === elements.stageControlsToggle),
    "Stage control backdrop did not close the panel and restore its opener");
    const narrowWorkspaces = {};
    for (const workspace of ["queue", "request", "random", "users"]) {
      await shellPage.locator(`#work-rail-${workspace}`).click();
      narrowWorkspaces[workspace] = await shellPage.evaluate((name) => ({
        active: state.activeHostWorkspace,
        visible: Array.from(elements.hostWorkspacePanels || [])
          .filter((panel) => !panel.hidden)
          .every((panel) => panel.dataset.hostWorkspacePanel === name),
        bodyScrollY: window.scrollY,
        sameFrame: elements.playerFrame === window.__hostShellNodes.frame,
        requestOverlay: state.hostWorkspaceOverlayOpen && hostRequestWorkspaceUsesOverlay(),
      }), workspace);
    }
    assert(
      Object.entries(narrowWorkspaces).every(([workspace, entry]) => entry.active === workspace
        && entry.visible
        && entry.bodyScrollY === 0
        && entry.sameFrame
        && !entry.requestOverlay),
      "not every workspace remained reachable in the interim narrow shell",
      narrowWorkspaces,
    );
    const narrowLocalScroll = await shellPage.evaluate(() => {
      activateHostWorkspace("random", { inputOrigin: "programmatic" });
      const spacer = document.createElement("div");
      spacer.style.height = "1500px";
      spacer.style.flex = "0 0 1500px";
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
    assert(
      narrowLocalScroll.workspaceScrollTop > 0
        && narrowLocalScroll.workspaceScrollHeight > narrowLocalScroll.workspaceClientHeight
        && narrowLocalScroll.bodyScrollY === 0,
      "active narrow workspace did not own its bounded local scroll",
      narrowLocalScroll,
    );
    if (shellNarrowScreenshotPath) {
      await shellPage.evaluate(() => {
        activateHostWorkspace("queue", { inputOrigin: "programmatic" });
        state.hostWorkspaceScrollPositions.queue = 0;
        elements.hostWorkspaceRegion.scrollTop = 0;
        document.querySelector(".left-column").scrollTop = 0;
        for (const owner of [
          elements.appShell,
          document.querySelector(".shell-body"),
          document.querySelector(".layout"),
          document.querySelector(".host-content-region"),
        ]) {
          owner.scrollTop = 0;
        }
      });
      await shellPage.screenshot({ path: shellNarrowScreenshotPath, fullPage: false });
    }
    assert(shellPageErrors.length === 0, "unexpected Host shell page errors", shellPageErrors);
    assert(shellConsoleErrors.length === 0, "unexpected Host shell console errors", shellConsoleErrors);
    const shellEvidence = {
      initial: shellInitial,
      navigation: navigationState,
      switchFetchCount,
      legacyLayoutEvidence,
      playerIdentity,
      playerRequestCount: shellPlayerRequests.length - playerRequestsBeforeSwitching,
      wideWidths,
      draftAndScroll,
      bannerEvidence,
      mediumQueue,
      mediumRequestOpen,
      mediumRequestClosed,
      narrowInitial,
      narrowControlEvidence,
      narrowWorkspaces,
      narrowLocalScroll,
      consoleErrors: shellConsoleErrors,
      pageErrors: shellPageErrors,
      screenshots: {
        wide: shellWideScreenshotPath,
        medium: shellMediumScreenshotPath,
        narrow: shellNarrowScreenshotPath,
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
    assert(await page.locator("#search-panel").isVisible(), "Request rail did not expose the existing Search panel");
    await page.evaluate(() => {
      document.querySelector("#lark-search-query").value = "host ui";
      document.querySelector("#lark-search-form").dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForSelector("#lark-search-results .search-result-item");
    await page.click("#search-expand-button");
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
    await page.locator(".search-modal-sidebar").hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(60);
    const backgroundScrollTop = await page.evaluate(() => window.scrollY);
    assert(backgroundScrollTop === 0, "expanded search allowed background page scrolling", {
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
    assert(
      await page.locator("#search-modal").evaluate((element) => !element.classList.contains("hidden")),
      "closing detail also closed expanded search",
    );
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
    assert(
      await page.locator("#search-modal").evaluate((element) => !element.classList.contains("hidden")),
      "Escape on detail closed expanded search",
    );

    await opener.click();
    await detail.waitFor({ state: "visible" });
    await detail.locator("[data-song-detail-close]").click();
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden")),
      "explicit detail close button did not close detail",
    );

    await page.locator("#search-modal-close").click();
    await page.waitForTimeout(250);
    assert(
      await page.evaluate(() => document.querySelector("#search-card-content")?.parentElement
        === document.querySelector("#search-panel .search-card")),
      "Search expand did not restore the same content DOM to the Request workspace",
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
    await page.locator("#work-rail-queue").click();
    await page.locator("#stage-controls-toggle").click();
    await page.waitForTimeout(180);
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

    await page.locator("#stage-controls-close").click();
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
    const installablePrecondition = await page.evaluate(() => ({
      eligible: isEligibleCurrentChannelUpdate(),
      update: state.data.app_update,
      previewEnabled: state.updatePreviewEnabled,
      panelOpen: state.cacheSettingsOpen,
      buttonDisabled: elements.updateCheckButton.disabled,
    }));
    assert(installablePrecondition.eligible, "known installable update lost its deterministic action precondition", installablePrecondition);
    await page.locator("#update-check-button").click();
    assert(await confirmPopover.isVisible(), "known installable update did not require an explicit confirmation", {
      installablePrecondition,
      after: await page.evaluate(() => ({
        eligible: isEligibleCurrentChannelUpdate(),
        update: state.data.app_update,
        confirmIntent: state.confirmIntent,
        confirmHidden: elements.confirmPopover.classList.contains("hidden"),
      })),
    });
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
    assert(!await remotePopover.isVisible(), "Escape did not close pinned QR popup");
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
    await coarsePage.locator("#stage-controls-toggle").click();
    await coarsePage.waitForTimeout(180);
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
    await coarsePage.locator("#stage-control-tray-title").tap();
    assert(await coarsePlaybackInfo.getAttribute("aria-expanded") === "false", "Host playback touch outside tap did not close information");
    await coarsePage.locator("#stage-controls-close").click();
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
      wheelScrollTop,
      backgroundScrollTop,
      detailHidden,
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
