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

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];
  const hostPlayerRequests = [];
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
  await page.route("**/api/lark/search?**", (route) => {
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
        && avTooltipBox.y + avTooltipBox.height <= playbackViewport.height
        && avTooltipBox.y + avTooltipBox.height <= avPanelBox.y,
      "Host A/V information was not bounded above its control panel",
      { avTooltipBox, avPanelBox, playbackViewport },
    );
    await avTooltip.hover();
    await page.waitForTimeout(140);
    assert(await avTooltip.isVisible(), "moving into Host A/V information dismissed it");
    await page.locator("#current-title").hover();
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
    await page.locator("#current-title").hover();
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
    await page.locator("#current-title").click();
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
    assert(await page.evaluate(() => window.scrollY) > pageScrollBefore, "wheel did not pass through a fitting user list");

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
    await page.setViewportSize({ width: 680, height: 1000 });
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
    await coarsePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await coarsePage.waitForTimeout(700);
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
    await coarsePage.locator("#current-title").tap();
    assert(await coarsePlaybackInfo.getAttribute("aria-expanded") === "false", "Host playback touch outside tap did not close information");
    await coarsePage.locator("#cache-settings-toggle").click();
    await coarsePage.locator("#cache-panel-advanced-trigger").click();
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
      settings: {
        advancedInfoCount: await advancedInfoButtons.count(),
        layeredConfirmActions: true,
        qrPinning: true,
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
