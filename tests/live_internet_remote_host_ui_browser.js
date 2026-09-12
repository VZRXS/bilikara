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

async function qrFixture(baseUrl, url) {
  const response = await fetch(`${baseUrl}/api/internet-remote/qr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const payload = await response.json();
  const image = String(payload?.data?.image || "");
  const match = image.match(/^data:image\/png;base64,(.+)$/u);
  assert(response.ok && payload?.ok && match, "local QR fixture generation failed");
  return Buffer.from(match[1], "base64");
}

async function runInternetRemoteHostGate(browser, baseUrl, screenshotPath) {
  const localShareUrl = "http://192.0.2.44:6764/remote?entry=host-local-review";
  const localQrPng = await qrFixture(
    baseUrl,
    "https://rtc.kevinx96.icu/remote.html#room=LOCALFIXTURE000000000000000&join=LOCALFIXTUREJOIN000000000000000000000000000&expires=1788649200000",
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const createRequests = [];
  const releaseRequests = [];
  const publicQrRequests = [];
  const localQrTargets = [];
  let createOutcome = "success";
  let holdCreate = false;
  let releaseHeldCreate = null;
  let failNextPublicQr = false;
  let roomSequence = 0;

  const screenshots = {
    hoverPreview: suffixedPath(screenshotPath, "-internet-remote-hover-preview"),
    localUncreated: suffixedPath(screenshotPath, "-internet-remote-local-uncreated"),
    creating: suffixedPath(screenshotPath, "-internet-remote-creating"),
    active: suffixedPath(screenshotPath, "-internet-remote-active"),
    activePreview: suffixedPath(screenshotPath, "-internet-remote-active-preview"),
    draft: suffixedPath(screenshotPath, "-internet-remote-draft"),
    unreadyFailure: suffixedPath(screenshotPath, "-internet-remote-unready-failure"),
    narrowDarkJa: suffixedPath(screenshotPath, "-internet-remote-narrow-dark-ja"),
    narrowBlueEn: suffixedPath(screenshotPath, "-internet-remote-narrow-blue-en"),
    publicQr: suffixedPath(screenshotPath, "-internet-remote-public-qr"),
  };

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.__internetRemoteFeedback = [];
    window.__internetRemoteDisplays = [];
    window.__internetRemoteCopied = [];
    window.__internetRemoteOpened = [];
    window.__internetRemoteIntervalCount = 0;
    window.__internetRemoteIntervalSources = [];
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (...args) => {
      window.__internetRemoteIntervalCount += 1;
      window.__internetRemoteIntervalSources.push(String(new Error().stack || ""));
      return nativeSetInterval(...args);
    };
    document.addEventListener("bilikara:internet-remote-feedback", (event) => {
      window.__internetRemoteFeedback.push({ ...event.detail });
    });
    document.addEventListener("bilikara:internet-remote-display", (event) => {
      window.__internetRemoteDisplays.push({ ...event.detail });
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          window.__internetRemoteCopied.push(String(value));
        },
      },
    });
    window.open = (url) => {
      window.__internetRemoteOpened.push(String(url));
      return null;
    };
    class FixtureWebSocket extends EventTarget {
      static OPEN = 1;

      constructor(url, protocols) {
        super();
        this.url = url;
        this.protocols = protocols;
        this.readyState = FixtureWebSocket.OPEN;
        window.__internetRemoteSockets ||= [];
        window.__internetRemoteSockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send() {}

      close(code = 1000) {
        if (this.readyState !== FixtureWebSocket.OPEN) return;
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code }));
      }

      expire() {
        if (this.readyState !== FixtureWebSocket.OPEN) return;
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code: 4003 }));
      }
    }
    window.WebSocket = FixtureWebSocket;
  });

  await page.route("https://api.qrserver.com/**", (route) => {
    const url = new URL(route.request().url());
    localQrTargets.push(url.searchParams.get("data") || "");
    return route.fulfill({ status: 200, contentType: "image/png", body: localQrPng });
  });
  await page.route("**/api/internet-remote/qr", async (route) => {
    const payload = route.request().postDataJSON();
    const target = String(payload?.url || "");
    if (!target.startsWith("https://rtc.kevinx96.icu/remote.html#")) {
      return route.fallback();
    }
    publicQrRequests.push(target);
    if (failNextPublicQr) {
      failNextPublicQr = false;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "fixture_qr_failure" }),
      });
    }
    return route.fallback();
  });
  await page.route("https://rtc.kevinx96.icu/v1/rooms**", async (route) => {
    const request = route.request();
    const method = request.method();
    const corsHeaders = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "POST,DELETE,OPTIONS",
    };
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    if (method === "DELETE") {
      releaseRequests.push(request.url());
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    assert(method === "POST", "unexpected signaling fixture request", { method, url: request.url() });
    const payload = request.postDataJSON();
    createRequests.push(payload);
    if (holdCreate) {
      await new Promise((resolve) => { releaseHeldCreate = resolve; });
      releaseHeldCreate = null;
      holdCreate = false;
    }
    if (createOutcome === "failure") {
      return route.fulfill({
        status: 503,
        headers: corsHeaders,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture_room_creation_failed" }),
      });
    }
    roomSequence += 1;
    const createdAt = Date.now();
    const lifetimeHours = Number(payload?.lifetime_hours || 12);
    return route.fulfill({
      status: 201,
      headers: corsHeaders,
      contentType: "application/json",
      body: JSON.stringify({
        room_id: `ROOM${String(roomSequence).padStart(23, "0")}`,
        created_at: createdAt,
        expires_at: createdAt + (lifetimeHours * 60 * 60 * 1000),
      }),
    });
  });

  async function screenshot(name) {
    const path = screenshots[name];
    if (path) await page.screenshot({ path, fullPage: false });
  }

  async function waitForRoomResult() {
    await page.locator("#internet-remote-restart").waitFor({ state: "visible" });
    await page.waitForFunction(() => (
      document.querySelector("#internet-remote-restart")?.getAttribute("aria-busy") !== "true"
      && !document.querySelector("#internet-remote-room")?.classList.contains("hidden")
    ));
  }

  try {
    await page.goto(`${baseUrl}/?bilikara_smoke_bypass_fullscreen=1`, { waitUntil: "domcontentloaded" });
    await page.locator("#remote-mini-trigger").waitFor({ state: "visible" });
    await page.evaluate((shareUrl) => {
      const remoteAccess = {
        preferred_url: shareUrl,
        lan_urls: [shareUrl],
        local_url: `${window.location.origin}/remote`,
      };
      state.data = { ...(state.data || {}), remote_access: remoteAccess };
      renderRemoteAccess(remoteAccess);
    }, localShareUrl);
    await page.locator("#remote-mini-control").hover();
    const hoverPreview = await page.evaluate(() => {
      const card = document.querySelector("#remote-mini-popover .remote-access-card");
      const cardRect = card.getBoundingClientRect();
      const localQr = document.querySelector("#remote-popover-qr-image")
        .closest(".remote-access-qr").getBoundingClientRect();
      return {
        localVisible: document.querySelector("#internet-remote-local-content").getBoundingClientRect().height > 0,
        publicVisible: document.querySelector("#internet-remote-public-row").getBoundingClientRect().height > 0,
        controlsVisible: getComputedStyle(document.querySelector("#internet-remote-internet-content")).display !== "none",
        localOnly: card.classList.contains("is-local-only-preview"),
        copyTitleVisible: [...document.querySelectorAll("#remote-mini-popover .remote-access-copy-title")]
          .some((node) => getComputedStyle(node).display !== "none"),
        cardColumns: getComputedStyle(card).gridTemplateColumns,
        localColumns: getComputedStyle(document.querySelector("#internet-remote-local-content")).gridTemplateColumns,
        localQr: {
          left: localQr.left,
          top: localQr.top,
          width: localQr.width,
          height: localQr.height,
          offsetLeft: localQr.left - cardRect.left,
          offsetTop: localQr.top - cardRect.top,
        },
      };
    });
    assert(
      hoverPreview.localVisible
        && !hoverPreview.publicVisible
        && !hoverPreview.controlsVisible
        && hoverPreview.localOnly
        && hoverPreview.copyTitleVisible
        && hoverPreview.cardColumns.split(" ").length === 1
        && hoverPreview.localColumns.includes("160px")
        && hoverPreview.localQr.width === 160
        && hoverPreview.localQr.height === 160,
      "uncreated Host hover preview retained an empty public column or changed local QR geometry",
      hoverPreview,
    );
    await screenshot("hoverPreview");
    await page.locator("#remote-mini-trigger").click();
    assert(
      await page.locator("#internet-remote-internet-content").isVisible(),
      "Host click did not expand the full public-room menu",
    );
    const intervalBaseline = await page.evaluate(() => window.__internetRemoteIntervalCount);
    const uncreated = await page.evaluate(() => {
      const room = document.querySelector("#internet-remote-room");
      const actions = document.querySelector(".internet-remote-actions");
      const content = document.querySelector("#internet-remote-internet-content");
      const status = document.querySelector("#internet-remote-status");
      const link = document.querySelector("#remote-popover-url-link");
      const roomStyle = getComputedStyle(room);
      const statusRect = status.getBoundingClientRect();
      const card = document.querySelector("#remote-mini-popover .remote-access-card");
      const cardRect = card.getBoundingClientRect();
      const localQr = document.querySelector("#remote-popover-qr-image")
        .closest(".remote-access-qr").getBoundingClientRect();
      return {
        roomHidden: room.classList.contains("hidden"),
        roomDisplay: roomStyle.display,
        stopHidden: document.querySelector("#internet-remote-stop").classList.contains("hidden"),
        contentBottomGap: content.getBoundingClientRect().bottom - actions.getBoundingClientRect().bottom,
        statusWidth: statusRect.width,
        statusHeight: statusRect.height,
        localLinkText: link.textContent,
        localLinkDisplay: getComputedStyle(link).display,
        localTarget: link.getAttribute("href"),
        localQrVisible: !document.querySelector("#remote-popover-qr-image").classList.contains("hidden"),
        managementLayout: card.classList.contains("is-management-layout"),
        localQr: {
          left: localQr.left,
          top: localQr.top,
          width: localQr.width,
          height: localQr.height,
          offsetLeft: localQr.left - cardRect.left,
          offsetTop: localQr.top - cardRect.top,
        },
      };
    });
    assert(
      uncreated.roomHidden
        && uncreated.roomDisplay === "none"
        && uncreated.stopHidden
        && uncreated.contentBottomGap < 4
        && uncreated.statusWidth <= 1
        && uncreated.statusHeight <= 1
        && uncreated.localLinkText === localShareUrl
        && uncreated.localLinkDisplay !== "none"
        && uncreated.localTarget === localShareUrl
        && uncreated.localQrVisible
        && uncreated.managementLayout
        && Math.abs(uncreated.localQr.left - hoverPreview.localQr.left) <= 1
        && Math.abs(uncreated.localQr.top - hoverPreview.localQr.top) <= 1
        && Math.abs(uncreated.localQr.offsetLeft - hoverPreview.localQr.offsetLeft) <= 1
        && Math.abs(uncreated.localQr.offsetTop - hoverPreview.localQr.offsetTop) <= 1
        && uncreated.localQr.width === hoverPreview.localQr.width
        && uncreated.localQr.height === hoverPreview.localQr.height,
      "uncreated public room reserved result space or hid the Local access URL",
      uncreated,
    );
    await screenshot("localUncreated");

    holdCreate = true;
    await page.locator("#internet-remote-restart").click();
    await page.waitForTimeout(120);
    const pending = await page.evaluate(() => ({
      roomHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      stopHidden: document.querySelector("#internet-remote-stop").classList.contains("hidden"),
      buttonBusy: document.querySelector("#internet-remote-restart").getAttribute("aria-busy"),
      buttonText: document.querySelector("#internet-remote-restart").textContent.trim(),
      visibleStatusHeight: document.querySelector("#internet-remote-status").getBoundingClientRect().height,
    }));
    assert(
      pending.roomHidden && pending.stopHidden && pending.buttonBusy === "true"
        && pending.buttonText === "创建中…" && pending.visibleStatusHeight <= 1,
      "creating state leaked a result or duplicated its feedback",
      pending,
    );
    await screenshot("creating");
    assert(typeof releaseHeldCreate === "function", "held creation request was not reached");
    releaseHeldCreate();
    await waitForRoomResult();
    await page.waitForFunction(() => document.querySelector("#internet-remote-qr")?.naturalWidth > 0);
    await page.waitForFunction(() => document.querySelector("#app-toast")?.classList.contains("hidden"));

    const active = await page.evaluate(() => {
      const card = document.querySelector("#remote-mini-popover .remote-access-card")
        .getBoundingClientRect();
      const localQr = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQr = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      const localQrWrap = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQrWrap = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      const publicLink = document.querySelector("#internet-remote-url");
      const localLink = document.querySelector("#remote-popover-url-link");
      return {
        localQr: {
          left: localQr.left,
          top: localQr.top,
          width: localQr.width,
          height: localQr.height,
          offsetLeft: localQr.left - card.left,
          offsetTop: localQr.top - card.top,
        },
        publicQr: { left: publicQr.left, width: publicQr.width, height: publicQr.height },
        localQrWrap: { left: localQrWrap.left, width: localQrWrap.width, height: localQrWrap.height },
        publicQrWrap: { left: publicQrWrap.left, width: publicQrWrap.width, height: publicQrWrap.height },
        publicUrl: publicLink.getAttribute("href"),
        publicText: publicLink.textContent,
        publicDisplay: getComputedStyle(publicLink).display,
        localUrl: localLink.getAttribute("href"),
        expiryCount: document.querySelectorAll("#internet-remote-expiry").length,
        resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
        statusText: document.querySelector("#internet-remote-public-meta").textContent.trim(),
        statusVisualWidth: document.querySelector("#internet-remote-public-meta").getBoundingClientRect().width,
        connectionIndicatorDisplay: getComputedStyle(
          document.querySelector(".remote-access-public-connection-indicator"),
        ).display,
        connectionCount: document.querySelector("#internet-remote-public-connection-count").textContent.trim(),
        copyTitleDisplay: getComputedStyle(document.querySelector(".remote-access-copy-title")).display,
        statusLiveRegionHeight: document.querySelector("#internet-remote-status").getBoundingClientRect().height,
      };
    });
    assert(
      !active.resultHidden
        && active.publicText === ""
        && active.publicDisplay === "none"
        && active.publicUrl.startsWith("https://rtc.kevinx96.icu/remote.html#room=")
        && active.publicUrl.includes("&join=")
        && active.publicUrl.includes("&expires=")
        && active.expiryCount === 0
        && active.statusText.includes("连接 0")
        && active.statusVisualWidth > 1
        && active.connectionIndicatorDisplay === "none"
        && active.connectionCount === "0"
        && active.copyTitleDisplay !== "none"
        && active.statusLiveRegionHeight <= 1
        && Math.abs(active.localQr.offsetLeft - hoverPreview.localQr.offsetLeft) <= 1
        && Math.abs(active.localQr.offsetTop - hoverPreview.localQr.offsetTop) <= 1
        && Math.abs(active.localQrWrap.left - active.publicQrWrap.left) <= 1
        && active.localQrWrap.width === 160
        && active.publicQrWrap.width === 160
        && active.localQr.width === active.publicQr.width
        && active.publicQr.width === active.publicQr.height,
      "active room result did not use the shared horizontal layout",
      active,
    );
    assert(publicQrRequests.at(-1) === active.publicUrl, "public QR content diverged from the active URL");
    assert(localQrTargets.filter((url) => url === localShareUrl).length === 2, "local QR was regenerated or targeted a different URL", localQrTargets);
    await screenshot("active");
    if (screenshots.publicQr) {
      await page.locator("#internet-remote-qr").screenshot({ path: screenshots.publicQr });
    }
    const contextualInfoHitEvidence = {};
    for (const [name, rowTarget, infoButton, tooltip] of [
      ["local", "#internet-remote-summary", ".internet-remote-summary-info .cache-advanced-info-button", "#internet-remote-mode-description"],
      ["public", "#internet-remote-disclosure", ".internet-remote-public-info .cache-advanced-info-button", "#internet-remote-public-description"],
    ]) {
      await page.locator(rowTarget).hover();
      await page.waitForTimeout(220);
      const rowOpenedTooltip = await page.locator(tooltip).evaluate((node) => (
        getComputedStyle(node).visibility === "visible"
      ));
      await page.locator(infoButton).hover();
      await page.waitForTimeout(220);
      const buttonOpenedTooltip = await page.locator(tooltip).evaluate((node) => (
        getComputedStyle(node).visibility === "visible"
      ));
      const buttonBounds = await page.locator(infoButton).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      contextualInfoHitEvidence[name] = { rowOpenedTooltip, buttonOpenedTooltip, buttonBounds };
      await page.mouse.move(600, 700);
      await page.waitForTimeout(240);
    }
    assert(
      Object.values(contextualInfoHitEvidence).every((entry) => (
        !entry.rowOpenedTooltip
          && entry.buttonOpenedTooltip
          && entry.buttonBounds.width === 32
          && entry.buttonBounds.height === 32
      )),
      "Local/Public contextual help still used the complete entry row as its hover target",
      contextualInfoHitEvidence,
    );
    await page.evaluate(() => setRemoteQrPinned(false));
    await page.locator("#remote-mini-control").hover();
    await page.waitForTimeout(80);
    const activePreview = await page.evaluate(() => {
      const cardNode = document.querySelector("#remote-mini-popover .remote-mini-popover-card");
      const card = cardNode.getBoundingClientRect();
      const cardStyle = getComputedStyle(cardNode);
      const local = document.querySelector("#internet-remote-local-content").getBoundingClientRect();
      const publicRoom = document.querySelector("#internet-remote-room").getBoundingClientRect();
      const localQr = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQr = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        local: { left: local.left, right: local.right, top: local.top, bottom: local.bottom },
        publicRoom: {
          left: publicRoom.left,
          right: publicRoom.right,
          top: publicRoom.top,
          bottom: publicRoom.bottom,
        },
        localQr: {
          left: localQr.left,
          right: localQr.right,
          top: localQr.top,
          width: localQr.width,
          height: localQr.height,
          offsetLeft: localQr.left - card.left,
          offsetTop: localQr.top - card.top,
        },
        localQrImage: (() => {
          const rect = document.querySelector("#remote-popover-qr-image").getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        })(),
        publicQr: {
          left: publicQr.left,
          right: publicQr.right,
          top: publicQr.top,
          width: publicQr.width,
          height: publicQr.height,
        },
        publicQrImage: (() => {
          const rect = document.querySelector("#internet-remote-qr").getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        })(),
        publicQrVisible: !document.querySelector("#internet-remote-qr").classList.contains("hidden"),
        passwordVisible: !document.querySelector("#internet-remote-current-password").classList.contains("hidden"),
        password: document.querySelector("#internet-remote-current-password-value").textContent.trim(),
        publishedPassword: window.__internetRemoteDisplays.at(-1).password,
        publishedConnectedCount: window.__internetRemoteDisplays.at(-1).connected_count,
        configVisible: getComputedStyle(document.querySelector(".internet-remote-config-row")).display !== "none",
        actionsVisible: getComputedStyle(document.querySelector(".internet-remote-actions")).display !== "none",
        copyVisible: document.querySelector("#internet-remote-copy-link").getBoundingClientRect().height > 0,
        copyTitleVisible: [...document.querySelectorAll("#remote-mini-popover .remote-access-copy-title")]
          .some((node) => getComputedStyle(node).display !== "none"),
        expandHint: document.querySelector(".remote-access-expand-hint").textContent.trim(),
        expandHintVisible: document.querySelector(".remote-access-expand-hint").getBoundingClientRect().height > 0,
        publicStatusVisualWidth: document.querySelector("#internet-remote-public-meta").getBoundingClientRect().width,
        publicConnectionIndicator: (() => {
          const node = document.querySelector(".remote-access-public-connection-indicator");
          const rect = node.getBoundingClientRect();
          return {
            display: getComputedStyle(node).display,
            width: rect.width,
            height: rect.height,
            svgCount: node.querySelectorAll("svg").length,
            count: node.textContent.trim(),
          };
        })(),
        localDetailOrder: [...document.querySelector("#internet-remote-local-content .remote-access-details").children]
          .map((node) => node.id || node.className),
        horizontalOverflow: document.querySelector("#remote-mini-popover .remote-mini-popover-card").scrollWidth
          > document.querySelector("#remote-mini-popover .remote-mini-popover-card").clientWidth,
        horizontalStudy: {
          currentWidth: card.width,
          columns: cardStyle.gridTemplateColumns,
          inlinePadding: Number.parseFloat(cardStyle.paddingLeft)
            + Number.parseFloat(cardStyle.paddingRight),
          qrGap: publicQr.left - localQr.right,
        },
      };
    });
    assert(
      Math.abs(activePreview.local.top - activePreview.publicRoom.top) <= 1
        && activePreview.local.right < activePreview.publicRoom.left
        && activePreview.localQr.right < activePreview.publicQr.left
        && Math.abs(activePreview.localQr.top - activePreview.publicQr.top) <= 1
        && activePreview.localQr.width === 160
        && activePreview.localQr.height === 160
        && activePreview.publicQr.width === 160
        && activePreview.publicQr.height === 160
        && Math.abs(activePreview.localQr.offsetLeft - hoverPreview.localQr.offsetLeft) <= 1
        && Math.abs(activePreview.localQr.offsetTop - hoverPreview.localQr.offsetTop) <= 1
        && Math.abs(activePreview.localQrImage.width - 154) <= 1
        && Math.abs(activePreview.publicQrImage.width - activePreview.localQrImage.width) <= 1
        && activePreview.publicQrVisible
        && activePreview.passwordVisible
        && activePreview.password === activePreview.publishedPassword
        && activePreview.publishedConnectedCount === 0
        && !activePreview.configVisible
        && !activePreview.actionsVisible
        && !activePreview.copyVisible
        && !activePreview.copyTitleVisible
        && activePreview.expandHintVisible
        && activePreview.expandHint.length > 0
        && activePreview.publicStatusVisualWidth <= 1
        && ["flex", "inline-flex"].includes(activePreview.publicConnectionIndicator.display)
        && activePreview.publicConnectionIndicator.width >= 20
        && activePreview.publicConnectionIndicator.height === 17
        && activePreview.publicConnectionIndicator.svgCount === 1
        && activePreview.publicConnectionIndicator.count === "0"
        && activePreview.localDetailOrder.indexOf("remote-popover-url-link")
          < activePreview.localDetailOrder.indexOf("remote-popover-url-hint")
        && !activePreview.horizontalOverflow,
      "active hover preview did not place Local/Public QR entries side by side without management controls",
      activePreview,
    );
    await screenshot("activePreview");
    await page.evaluate(() => setRemoteQrPinned(true));
    await page.locator("#remote-popover-copy-link").click();
    await page.locator("#internet-remote-copy-link").click();
    await page.locator("#remote-popover-url-link").click();
    const actions = await page.evaluate(() => ({
      copied: [...window.__internetRemoteCopied],
      opened: [...window.__internetRemoteOpened],
    }));
    assert(
      actions.copied.includes(active.localUrl)
        && actions.copied.includes(active.publicUrl)
        && actions.opened.includes(active.localUrl),
      "copy/link actions did not preserve their complete QR target URLs",
      actions,
    );

    const acceptedDisplay = await page.evaluate(() => window.__internetRemoteDisplays.at(-1));
    const acceptedPassword = acceptedDisplay.password;
    const acceptedExpiry = new URL(acceptedDisplay.url.replace("#", "?")).searchParams.get("expires");
    await page.locator("#internet-remote-password").fill("654321");
    await page.locator("#internet-remote-duration").fill("6");
    const draft = await page.evaluate(() => ({
      resultUrl: document.querySelector("#internet-remote-url").getAttribute("href"),
      passwordVisible: !document.querySelector("#internet-remote-current-password").classList.contains("hidden"),
      actualPassword: document.querySelector("#internet-remote-current-password-value").textContent,
      button: document.querySelector("#internet-remote-restart").textContent.trim(),
      feedbackCount: window.__internetRemoteFeedback.length,
    }));
    assert(
      draft.resultUrl === acceptedDisplay.url
        && draft.resultUrl.includes(`expires=${acceptedExpiry}`)
        && draft.passwordVisible
        && draft.actualPassword === acceptedPassword
        && draft.button === "重建并应用",
      "draft room parameters replaced accepted room output before rebuild",
      draft,
    );
    await page.locator("#internet-remote-duration").dispatchEvent("input");
    const feedbackAfterRender = await page.evaluate(() => window.__internetRemoteFeedback.length);
    assert(feedbackAfterRender === draft.feedbackCount, "a normal render emitted duplicate operation feedback");
    await page.waitForFunction(() => document.querySelector("#app-toast")?.classList.contains("hidden"));
    await screenshot("draft");

    createOutcome = "success";
    const createCountBeforeRebuild = createRequests.length;
    await page.locator("#internet-remote-restart").click();
    await waitForRoomResult();
    const rebuilt = await page.evaluate(() => ({
      url: document.querySelector("#internet-remote-url").getAttribute("href"),
      passwordVisible: !document.querySelector("#internet-remote-current-password").classList.contains("hidden"),
      password: window.__internetRemoteDisplays.at(-1).password,
    }));
    assert(
      createRequests.length === createCountBeforeRebuild + 1
        && rebuilt.url !== active.publicUrl
        && rebuilt.password === "654321"
        && !rebuilt.passwordVisible,
      "successful rebuild did not apply exactly one draft configuration",
      rebuilt,
    );

    createOutcome = "failure";
    await page.locator("#internet-remote-password").fill("765432");
    const createCountBeforeFailedRebuild = createRequests.length;
    await page.locator("#internet-remote-restart").click();
    await page.waitForFunction(() => document.querySelector("#internet-remote-public-meta")?.textContent.includes("失败"));
    const failedRebuild = await page.evaluate(() => ({
      resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      stopHidden: document.querySelector("#internet-remote-stop").classList.contains("hidden"),
      passwordDraft: document.querySelector("#internet-remote-password").value,
      status: document.querySelector("#internet-remote-public-meta").textContent.trim(),
    }));
    assert(
      createRequests.length === createCountBeforeFailedRebuild + 1
        && failedRebuild.resultHidden
        && failedRebuild.stopHidden
        && failedRebuild.passwordDraft === "765432",
      "failed rebuild restored a room that the existing stop-first strategy had invalidated",
      failedRebuild,
    );

    const firstFailureCount = createRequests.length;
    await page.locator("#internet-remote-restart").click();
    await page.waitForFunction(() => document.querySelector("#internet-remote-restart")?.getAttribute("aria-busy") !== "true");
    assert(createRequests.length === firstFailureCount + 1, "retry issued an unexpected number of room requests");
    await page.evaluate(() => {
      const remoteAccess = {
        preferred_url: `${window.location.origin}/remote`,
        lan_urls: [],
        local_url: `${window.location.origin}/remote`,
      };
      state.data = { ...(state.data || {}), remote_access: remoteAccess };
      renderRemoteAccess(remoteAccess);
    });
    const unreadyFailure = await page.evaluate(() => ({
      localQrHidden: document.querySelector("#remote-popover-qr-image").classList.contains("hidden"),
      localPlaceholder: document.querySelector("#remote-popover-qr-placeholder").textContent.trim(),
      localCopyHidden: document.querySelector("#remote-popover-copy-link").classList.contains("hidden"),
      localLinkText: document.querySelector("#remote-popover-url-link").textContent.trim(),
      localLinkTitle: document.querySelector("#remote-popover-url-link").title,
      publicResultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      publicStatus: document.querySelector("#internet-remote-public-meta").textContent.trim(),
    }));
    assert(
      unreadyFailure.localQrHidden
        && unreadyFailure.localPlaceholder === "未就绪"
        && unreadyFailure.localCopyHidden
        && unreadyFailure.localLinkText.startsWith("http://127.0.0.1:")
        && unreadyFailure.localLinkTitle === "在本机打开"
        && unreadyFailure.publicResultHidden
        && unreadyFailure.publicStatus.includes("失败"),
      "loopback-only Local access was presented as a phone-shareable QR entry",
      unreadyFailure,
    );
    await screenshot("unreadyFailure");

    createOutcome = "success";
    await page.locator("#internet-remote-restart").click();
    await waitForRoomResult();
    await page.evaluate(() => window.__internetRemoteSockets.at(-1).expire());
    const expired = await page.evaluate(() => ({
      status: document.querySelector("#internet-remote-public-meta").textContent.trim(),
      resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      stopHidden: document.querySelector("#internet-remote-stop").classList.contains("hidden"),
      restart: document.querySelector("#internet-remote-restart").textContent.trim(),
    }));
    assert(
      expired.status.includes("过期") && expired.resultHidden && expired.stopHidden
        && expired.restart.includes("重建"),
      "expired room kept share actions or lost its rebuild entry",
      expired,
    );

    await page.locator("#internet-remote-restart").click();
    await waitForRoomResult();
    await page.locator("#internet-remote-stop").click();
    await page.waitForFunction(() => document.querySelector("#internet-remote-public-meta")?.textContent.includes("未创建"));
    const closed = await page.evaluate(() => ({
      resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      stopHidden: document.querySelector("#internet-remote-stop").classList.contains("hidden"),
    }));
    assert(closed.resultHidden && closed.stopHidden, "closed room kept active sharing controls", closed);

    failNextPublicQr = true;
    await page.locator("#internet-remote-restart").click();
    await waitForRoomResult();
    const qrFailure = await page.evaluate(() => ({
      resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
      qrHidden: document.querySelector("#internet-remote-qr").classList.contains("hidden"),
      placeholder: document.querySelector("#internet-remote-qr-placeholder").textContent.trim(),
      copyDisabled: document.querySelector("#internet-remote-copy-link").disabled,
      url: document.querySelector("#internet-remote-url").getAttribute("href"),
    }));
    assert(
      !qrFailure.resultHidden && qrFailure.qrHidden && qrFailure.placeholder.length > 0
        && !qrFailure.copyDisabled && qrFailure.url.includes("#room="),
      "QR generation failure was misrepresented as a missing room",
      qrFailure,
    );
    await page.locator("#internet-remote-stop").click();
    await page.waitForFunction(() => document.querySelector("#internet-remote-public-meta")?.textContent.includes("未创建"));

    await page.evaluate((shareUrl) => {
      const remoteAccess = {
        preferred_url: shareUrl,
        lan_urls: [shareUrl],
        local_url: `${window.location.origin}/remote`,
      };
      state.data = { ...(state.data || {}), remote_access: remoteAccess };
      state.language = "ja";
      invalidateLanguageSensitiveRenderCache();
      applyStaticI18n();
      announceStaticI18n();
      renderLanguageSwitch();
      renderRemoteAccess(remoteAccess);
      applyTheme("dark");
    }, localShareUrl);
    await page.locator("#internet-remote-restart").click();
    await waitForRoomResult();
    await page.waitForFunction(() => document.querySelector("#app-toast")?.classList.contains("hidden"));
    await page.setViewportSize({ width: 390, height: 812 });
    await page.evaluate(() => {
      setRemoteQrPinned(true);
      scheduleTopControlPopoverPositionSync();
    });
    await page.waitForTimeout(80);
    const narrow = await page.evaluate(() => {
      const popup = document.querySelector("#remote-mini-popover").getBoundingClientRect();
      const card = document.querySelector("#remote-mini-popover .remote-mini-popover-card").getBoundingClientRect();
      const localQr = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQr = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      return {
        popup: { left: popup.left, right: popup.right, top: popup.top, bottom: popup.bottom },
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        localQrWidth: localQr.width,
        publicQrWidth: publicQr.width,
        localColumns: getComputedStyle(document.querySelector("#internet-remote-local-content")).gridTemplateColumns,
        publicColumns: getComputedStyle(document.querySelector("#internet-remote-room")).gridTemplateColumns,
        horizontalOverflow: card.scrollWidth > card.clientWidth,
        background: getComputedStyle(document.querySelector(".remote-mini-popover-card")).backgroundColor,
        language: document.documentElement.lang,
      };
    });
    assert(
      narrow.popup.left >= 0 && narrow.popup.right <= 390
        && narrow.popup.top >= 0 && narrow.popup.bottom <= 812
        && narrow.card.left >= 0 && narrow.card.right <= 390
        && !narrow.horizontalOverflow
        && narrow.localQrWidth === 160
        && narrow.publicQrWidth === 160
        && narrow.localColumns.includes("160px")
        && narrow.publicColumns.includes("160px")
        && narrow.language === "ja",
      "narrow dark Japanese popup overflowed or collapsed prematurely",
      narrow,
    );
    await screenshot("narrowDarkJa");

    const themeLanguageVariants = [];
    for (const variant of [
      { language: "zh", theme: "light" },
      { language: "en", theme: "blue" },
      { language: "ja", theme: "dark" },
    ]) {
      await page.evaluate(({ language, theme }) => {
        state.language = language;
        invalidateLanguageSensitiveRenderCache();
        applyStaticI18n();
        announceStaticI18n();
        renderLanguageSwitch();
        renderRemoteAccess(state.data?.remote_access || {});
        applyTheme(theme);
        setRemoteQrPinned(true);
        scheduleTopControlPopoverPositionSync();
        document.activeElement?.blur();
      }, variant);
      await page.waitForTimeout(360);
      const evidence = await page.evaluate(({ language, theme }) => {
        const colorAlpha = (color) => {
          const channels = String(color || "").match(/[\d.]+/gu) || [];
          return channels.length >= 4 ? Number(channels[3]) : 1;
        };
        const card = document.querySelector("#remote-mini-popover .remote-mini-popover-card");
        const publicContent = document.querySelector("#internet-remote-internet-content");
        const publicActions = document.querySelector(".internet-remote-actions");
        const restart = document.querySelector("#internet-remote-restart");
        const localLink = document.querySelector("#remote-popover-url-link");
        const cardRect = card.getBoundingClientRect();
        const publicRect = publicContent.getBoundingClientRect();
        const menuProbe = document.createElement("div");
        menuProbe.className = "menu-content";
        document.body.append(menuProbe);
        const audioVariants = document.querySelector("#audio-variant-bar");
        audioVariants.classList.add("is-expanded");
        const popupSurfaceSelectors = {
          mobileRemote: "#remote-mini-popover .remote-mini-popover-card",
          runtimeSettings: "#cache-panel",
          presentationSettings: "#presentation-settings-panel",
          contextualInfo: "#internet-remote-mode-description",
          confirmation: "#confirm-popover",
          stageControls: "#stage-control-tray",
          fullscreenRemote: ".fullscreen-remote-popover-card",
          audioVariants: "#audio-variant-bar",
        };
        const popupSurfaces = Object.fromEntries(Object.entries(popupSurfaceSelectors).map(([name, selector]) => {
          const background = getComputedStyle(document.querySelector(selector)).backgroundColor;
          return [name, { background, alpha: colorAlpha(background) }];
        }));
        const menuBackground = getComputedStyle(menuProbe).backgroundColor;
        popupSurfaces.contextMenu = { background: menuBackground, alpha: colorAlpha(menuBackground) };
        menuProbe.remove();
        audioVariants.classList.remove("is-expanded");
        return {
          language,
          theme,
          background: getComputedStyle(card).backgroundColor,
          backgroundAlpha: colorAlpha(getComputedStyle(card).backgroundColor),
          popupSurfaces,
          cardOverflow: card.scrollWidth > card.clientWidth,
          actionOverflow: publicActions.scrollWidth > publicActions.clientWidth,
          publicRightGap: cardRect.right - publicRect.right,
          actionLabels: [...publicActions.querySelectorAll("button")].map((button) => button.textContent.trim()),
          restartBackground: getComputedStyle(restart).backgroundColor,
          restartColor: getComputedStyle(restart).color,
          restartDisabled: restart.disabled,
          successColor: getComputedStyle(document.querySelector("#internet-remote-public-meta")).color,
          entryTitleFontSize: getComputedStyle(
            document.querySelector("#remote-mini-popover .internet-remote-entry-title"),
          ).fontSize,
          shareTitleFontSize: getComputedStyle(
            document.querySelector("#remote-mini-popover .internet-remote-share-title"),
          ).fontSize,
          shareMetaFontSize: getComputedStyle(
            document.querySelector("#remote-mini-popover .internet-remote-share-meta"),
          ).fontSize,
          localScanTitle: document.querySelector(
            '#remote-mini-popover [data-i18n="internetRemote.localScanTitle"]',
          ).textContent.trim(),
          publicScanTitle: document.querySelector(
            '#remote-mini-popover [data-i18n="internetRemote.publicScanTitle"]',
          ).textContent.trim(),
          clippedActionLabels: [...publicActions.querySelectorAll("button")].filter((button) => (
            button.scrollWidth > button.clientWidth
          )).map((button) => button.textContent.trim()),
          localLinkVisible: getComputedStyle(localLink).display !== "none",
          localLinkText: localLink.textContent.trim(),
          openButtonCount: document.querySelectorAll("#remote-popover-open-link, #internet-remote-open-link").length,
        };
      }, variant);
      const expectedThemeColors = {
        light: {
          restartBackground: "rgb(208, 90, 63)",
          restartColor: "rgb(255, 255, 255)",
          successColor: "rgb(43, 123, 96)",
        },
        dark: {
          restartBackground: "rgb(224, 108, 83)",
          restartColor: "rgb(255, 255, 255)",
          successColor: "rgb(95, 202, 157)",
        },
        blue: {
          restartBackground: "rgb(0, 210, 255)",
          restartColor: "rgb(5, 8, 16)",
          successColor: "rgb(0, 255, 163)",
        },
      }[variant.theme];
      const sharedRemoteAlpha = evidence.popupSurfaces.mobileRemote.alpha;
      const expectedScanTitles = {
        zh: ["扫码连接", "扫码后输入房间密码"],
        en: ["Scan to connect", "Scan, then enter password"],
        ja: ["QRを読み取って接続", "QRを読み取り、パスワードを入力"],
      }[variant.language];
      assert(
        evidence.backgroundAlpha === sharedRemoteAlpha
          && evidence.popupSurfaces.fullscreenRemote.alpha === sharedRemoteAlpha
          && sharedRemoteAlpha === 1
          && evidence.restartBackground === expectedThemeColors.restartBackground
          && evidence.restartColor === expectedThemeColors.restartColor
          && evidence.successColor === expectedThemeColors.successColor
          && !evidence.cardOverflow
          && !evidence.actionOverflow
          && evidence.publicRightGap >= -1
          && evidence.clippedActionLabels.length === 0
          && evidence.localLinkVisible
          && evidence.localLinkText === localShareUrl
          && evidence.openButtonCount === 0
          && evidence.entryTitleFontSize === "14px"
          && evidence.shareTitleFontSize === "14px"
          && evidence.shareMetaFontSize === "12px"
          && evidence.localScanTitle === expectedScanTitles[0]
          && evidence.publicScanTitle === expectedScanTitles[1],
        "theme or translated Internet access controls overflowed the popup",
        evidence,
      );
      themeLanguageVariants.push(evidence);
      if (variant.language === "en" && variant.theme === "blue") await screenshot("narrowBlueEn");
    }

    const intervalFinal = await page.evaluate(() => window.__internetRemoteIntervalCount);
    const internetRemotePollingIntervals = await page.evaluate(() => (
      window.__internetRemoteIntervalSources.filter((source) => source.includes("internet-remote-host.js"))
    ));
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !message.includes("Failed to load resource: the server responded with a status of"),
    );
    assert(internetRemotePollingIntervals.length === 0, "room UI introduced a polling interval", {
      intervalBaseline,
      intervalFinal,
      internetRemotePollingIntervals,
    });
    assert(pageErrors.length === 0, "Internet Remote fixture page raised page errors", pageErrors);
    assert(unexpectedConsoleErrors.length === 0, "Internet Remote fixture page logged console errors", unexpectedConsoleErrors);
    return {
      passed: true,
      hoverPreview,
      uncreated,
      pending,
      active,
      activePreview,
      contextualInfoHitEvidence,
      draft,
      rebuilt,
      failedRebuild,
      unreadyFailure,
      expired,
      closed,
      qrFailure,
      narrow,
      themeLanguageVariants,
      requestCounts: {
        create: createRequests.length,
        release: releaseRequests.length,
        publicQr: publicQrRequests.length,
        localQr: localQrTargets.length,
        intervalsAdded: internetRemotePollingIntervals.length,
      },
      screenshots,
      consoleErrors,
      unexpectedConsoleErrors,
      pageErrors,
    };
  } finally {
    await context.close();
  }
}

module.exports = { runInternetRemoteHostGate };
