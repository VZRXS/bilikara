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
    localUncreated: suffixedPath(screenshotPath, "-internet-remote-local-uncreated"),
    creating: suffixedPath(screenshotPath, "-internet-remote-creating"),
    active: suffixedPath(screenshotPath, "-internet-remote-active"),
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
    await page.locator("#remote-mini-trigger").click();
    await page.locator("#internet-remote-public-row").click();
    const intervalBaseline = await page.evaluate(() => window.__internetRemoteIntervalCount);
    const uncreated = await page.evaluate(() => {
      const room = document.querySelector("#internet-remote-room");
      const actions = document.querySelector(".internet-remote-actions");
      const content = document.querySelector("#internet-remote-internet-content");
      const status = document.querySelector("#internet-remote-status");
      const link = document.querySelector("#remote-popover-url-link");
      const roomStyle = getComputedStyle(room);
      const statusRect = status.getBoundingClientRect();
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
        && uncreated.localQrVisible,
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
      const localQr = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQr = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      const localQrWrap = document.querySelector("#remote-popover-qr-image").parentElement.getBoundingClientRect();
      const publicQrWrap = document.querySelector("#internet-remote-qr").parentElement.getBoundingClientRect();
      const publicLink = document.querySelector("#internet-remote-url");
      const localLink = document.querySelector("#remote-popover-url-link");
      return {
        localQr: { left: localQr.left, width: localQr.width, height: localQr.height },
        publicQr: { left: publicQr.left, width: publicQr.width, height: publicQr.height },
        localQrWrap: { left: localQrWrap.left, width: localQrWrap.width, height: localQrWrap.height },
        publicQrWrap: { left: publicQrWrap.left, width: publicQrWrap.width, height: publicQrWrap.height },
        publicUrl: publicLink.getAttribute("href"),
        publicText: publicLink.textContent,
        publicDisplay: getComputedStyle(publicLink).display,
        localUrl: localLink.getAttribute("href"),
        expiry: document.querySelector("#internet-remote-expiry").textContent.trim(),
        resultHidden: document.querySelector("#internet-remote-room").classList.contains("hidden"),
        statusText: document.querySelector("#internet-remote-public-meta").textContent.trim(),
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
        && active.expiry.length > 0
        && active.statusText.includes("连接 0")
        && active.statusLiveRegionHeight <= 1
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
      expiry: document.querySelector("#internet-remote-expiry").textContent.trim(),
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
      assert(
        evidence.backgroundAlpha === 1
          && Object.values(evidence.popupSurfaces).every((surface) => surface.alpha === 1)
          && evidence.restartBackground === expectedThemeColors.restartBackground
          && evidence.restartColor === expectedThemeColors.restartColor
          && evidence.successColor === expectedThemeColors.successColor
          && !evidence.cardOverflow
          && !evidence.actionOverflow
          && evidence.publicRightGap >= -1
          && evidence.clippedActionLabels.length === 0
          && evidence.localLinkVisible
          && evidence.localLinkText === localShareUrl
          && evidence.openButtonCount === 0,
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
      uncreated,
      pending,
      active,
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
