"use strict";

const { workspaceRouteState, installWorkspaceRoutes, prepareRemotePage } = require("./live_remote_request_workspace_browser");
function assert(value, message) { if (!value) throw new Error(message); }
const shotPath = (path, suffix) => path?.replace(/(\.[^./]+)$/, `-polish-${suffix}$1`);

async function runRemoteUiPolishGate(browser, baseUrl, screenshotPath) {
  const evidence = [];
  for (const scenario of [
    { width: 375, height: 812, language: "zh", theme: "light" },
    { width: 768, height: 1024, language: "en", theme: "dark" },
    { width: 320, height: 640, language: "ja", theme: "blue" },
    { width: 1024, height: 768, language: "zh", theme: "light" },
  ]) {
    const context = await browser.newContext({ viewport: scenario, deviceScaleFactor: 1, acceptDownloads: true, hasTouch: scenario.width < 400 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const fixture = workspaceRouteState();
    let exports = [];
    let releaseExport;
    let exportGate = Promise.resolve();
    try {
      await installWorkspaceRoutes(context, fixture);
      await context.route("**/api/played-sessions", (route) => route.fulfill({ json: { ok: true, data: [
        { id: "played-2026-09-01_12-00-00.json", started_at: 1788264000 },
      ] } }));
      await context.route("**/api/playlist/export?**", async (route) => {
        exports.push(route.request().url());
        await exportGate;
        const csv = new URL(route.request().url()).searchParams.get("format") === "csv";
        await route.fulfill({ status: 200, contentType: csv ? "text/csv" : "image/png",
          headers: { "Content-Disposition": `attachment; filename="fixture.${csv ? "csv" : "png"}"` },
          body: csv ? "title\nSynthetic song\n" : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64") });
      });
      await page.goto(`${baseUrl}/remote`);
      await page.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
      assert(await page.evaluate(() => state.remoteRequestView === "quick"), "Remote must default to Quick");
      await prepareRemotePage(page, baseUrl, fixture);
      await page.evaluate(({ language, theme }) => {
        setLanguage(language); applyTheme(theme);
        state.data = { ...state.data, current_item: null, playlist: [], history: [] };
        renderQueue([]); renderHistory([]); renderListHeader([], []);
        window.scrollTo(0, 0);
      }, scenario);
      const geometry = await page.evaluate(() => {
        const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const url = document.querySelector("#url-input");
        const id = document.querySelector(".remote-identity-summary");
        const queue = document.querySelector(".queue-empty");
        return { title: document.title, urlTag: url.tagName, input: box(url), identity: box(id),
          overflow: document.documentElement.scrollWidth > innerWidth,
          menuBorder: getComputedStyle(document.querySelector("#remote-menu-toggle")).borderTopWidth,
          emptyFont: getComputedStyle(queue).fontSize, emptyCopy: queue.innerText,
          expectedCopy: [t("list.emptyTitle"), t("list.emptyHint")].join("\n"),
          emptyAlign: getComputedStyle(queue).textAlign };
      });
      assert(geometry.title === "bilikara remote" && !geometry.overflow, "Remote identity/viewport invalid");
      assert(geometry.urlTag === "INPUT" && Math.abs(geometry.input.height - geometry.identity.height) <= 1, "Quick input and ID must share single-row height");
      assert(geometry.menuBorder === "1px" && geometry.emptyFont === "13px" && geometry.emptyAlign === "center", "Menu/empty presentation differs from contract");
      assert(geometry.emptyCopy.replace(/\n+/g, "\n") === geometry.expectedCopy, `Queue must use Host copy: ${JSON.stringify(geometry)}`);
      if (screenshotPath) await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-quick`), fullPage: false });

      await page.locator("#remote-menu-toggle").click();
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => {
        const button = document.querySelector("#remote-menu-toggle");
        const s = getComputedStyle(button);
        const expected = getComputedStyle(document.documentElement).getPropertyValue("--top-control-border").trim();
        return s.borderTopWidth === "1px" && s.borderTopColor !== "rgba(0, 0, 0, 0)" && expected.includes(s.borderTopColor);
      });
      await page.locator("#remote-qr-toggle").click();
      await page.locator("#remote-settings-toggle").click();
      await page.waitForFunction(() => !elements.remotePopoverQrImage.classList.contains("hidden"));
      const menuMetrics = () => page.locator("#remote-menu-panel").evaluate((node) => ({
        width: node.clientWidth, scrollWidth: node.scrollWidth,
        height: node.clientHeight, scrollHeight: node.scrollHeight,
        bottom: node.getBoundingClientRect().bottom,
      }));
      let menu = await menuMetrics();
      assert(menu.scrollWidth <= menu.width + 1 && menu.bottom <= scenario.height, `Menu overflows: ${JSON.stringify(menu)}`);
      if (scenario.height >= 768) assert(menu.scrollHeight <= menu.height + 1, "Roomy menu must not scroll");
      // Use synthetic credentials only. The real transport accessor is tested separately.
      await page.evaluate(() => {
        window.BilikaraRemoteTransport = { mode: "internet", invitation: () => ({
          url: `${location.origin}/remote.html#room=${"A".repeat(27)}&join=${"B".repeat(43)}&expires=2000000000000`,
          password: "300201",
        }) };
        renderRemoteAccess(null);
      });
      await page.waitForFunction(() => !document.querySelector("#remote-public-qr-image").classList.contains("hidden"));
      assert(!await page.locator("#remote-popover-url-link").isVisible(), "Public invitation URL must not be printed");
      assert(await page.locator("#remote-share-password").innerText() === "300201", "Missing public password");
      menu = await menuMetrics();
      assert(menu.scrollWidth <= menu.width + 1, "Public menu scrolls horizontally");
      if (scenario.height >= 768) assert(menu.scrollHeight <= menu.height + 1, "Roomy public menu must not scroll");
      if (screenshotPath) {
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
        await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-public-menu`), fullPage: false });
        await page.locator("#remote-public-qr-image").screenshot({ path: shotPath(screenshotPath, `${scenario.width}-public-qr`) });
      }
      await page.setViewportSize({ width: scenario.width, height: 360 });
      await page.waitForFunction(() => {
        const menu = document.querySelector("#remote-menu-panel");
        return menu.scrollHeight > menu.clientHeight && menu.getBoundingClientRect().bottom <= innerHeight;
      });
      await page.locator("#remote-menu-panel").hover();
      await page.mouse.wheel(0, 250);
      await page.waitForFunction(() => document.querySelector("#remote-menu-panel").scrollTop > 0);
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.evaluate(() => renderRemoteAccess({ preferred_url: "http://192.168.0.212:5725/remote" }));
      await page.waitForFunction(() => !elements.remotePopoverQrImage.classList.contains("hidden"));
      assert(await page.locator("#remote-share-local").isVisible() && await page.locator("#remote-share-public").isVisible(), "Both known entries must render");
      if (screenshotPath) await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-dual-menu`), fullPage: false });
      await page.evaluate(() => {
        window.BilikaraRemoteTransport.invitation = () => null;
        renderRemoteAccess(null);
      });
      assert(!await page.locator("#remote-public-qr-image").isVisible() && !await page.locator("#remote-share-password").isVisible(), "Stale invitation survived invalidation");
      await page.locator("#remote-menu-toggle").click();
      await page.evaluate(() => { window.BilikaraRemoteTransport = { mode: "local" }; });

      await page.locator("#history-view-button").click();
      assert(!await page.locator("#resort-playlist-button").isVisible(), "History must not show resort");
      if (screenshotPath) await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-history`), fullPage: false });
      await page.locator("#history-export-button").click();
      await page.waitForFunction(() => document.querySelector("#history-export-source optgroup option"));
      const dialog = await page.locator("#history-export-dialog").evaluate((node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
          clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
          open: node.open, viewportHeight: innerHeight, viewportWidth: innerWidth };
      });
      assert(dialog.open && dialog.top >= 0 && dialog.bottom <= dialog.viewportHeight + 1
        && dialog.left >= 0 && dialog.right <= dialog.viewportWidth + 1, "Export dialog exceeds viewport");
      const close = page.locator("#history-export-close");
      const noPointerRing = async (locator) => locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return style.outlineStyle === "none" || style.outlineWidth === "0px";
      });
      assert(await noPointerRing(close), "Mouse-opened modal inherited a keyboard ring");
      await close.hover();
      assert(await noPointerRing(close), "Close hover added an outline");
      await page.mouse.down();
      assert(await noPointerRing(close), "Close pointer press added an outline");
      await page.mouse.up();
      await page.locator("#history-export-button").click();
      if (scenario.width < 400) {
        await close.tap();
        await page.locator("#history-export-button").tap();
        assert(await noPointerRing(close), "Touch-opened modal inherited a keyboard ring");
      }
      await page.locator("#history-export-close").focus();
      await page.keyboard.press("Shift+Tab");
      assert(await page.evaluate(() => elements.historyExportDialog.contains(document.activeElement)), "Modal focus escaped via Shift+Tab");
      await page.keyboard.press("Tab");
      assert(!await noPointerRing(close), "Keyboard navigation lost its visible focus cue");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => elements.historyExportDialog.open);
      assert(!await noPointerRing(close), "Keyboard-opened modal lost its focus cue");
      await close.click();
      await page.locator("#history-export-button").click();
      assert(await noPointerRing(close), "Switching from keyboard to mouse retained the ring");
      await page.mouse.move(0, 0);
      if (screenshotPath) await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-export`), fullPage: false });
      const closeSize = await page.evaluate(() => [
        getComputedStyle(elements.historyExportClose).width,
        getComputedStyle(document.querySelector("#binding-sheet-close")).width,
      ]);
      assert(closeSize[0] === closeSize[1], "Export close differs from existing sheets");
      const closeAlignment = await page.locator("#history-export-close").evaluate((node) => {
        const button = node.getBoundingClientRect();
        const icon = node.querySelector("svg").getBoundingClientRect();
        const style = getComputedStyle(node);
        return { dx: icon.x + icon.width / 2 - button.x - button.width / 2,
          dy: icon.y + icon.height / 2 - button.y - button.height / 2,
          padding: style.padding, text: node.textContent.trim() };
      });
      assert(Math.abs(closeAlignment.dx) < 0.1 && Math.abs(closeAlignment.dy) < 0.1
        && closeAlignment.padding === "0px" && !closeAlignment.text, "Close SVG is not symmetrically centered");
      for (const id of ["history-export-source-info", "history-export-page-info"]) {
        await page.locator(`[aria-describedby="${id}"]`).click();
        await page.waitForFunction((id) => document.getElementById(id).classList.contains("is-visible"), id);
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
        const bounds = await page.locator(`#${id}`).boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= scenario.width + 1
          && bounds.y + bounds.height <= scenario.height + 1, "Export help clipped");
        assert(await page.locator(`#${id}`).getAttribute("data-tooltip-direction") === "up", "Export help must use viewport space above");
        if (screenshotPath && id === "history-export-source-info") await page.screenshot({ path: shotPath(screenshotPath, `${scenario.width}-export-help`), fullPage: false });
        await page.locator(`[aria-describedby="${id}"]`).click();
      }
      await page.locator("#history-export-source").selectOption("played-2026-09-01_12-00-00.json");
      await page.locator("#history-export-page-size").selectOption("50");
      exportGate = new Promise((resolve) => { releaseExport = resolve; });
      await page.locator("#history-export-csv-button").click();
      await page.waitForFunction(() => document.querySelector("#history-export-csv-button").getAttribute("aria-busy") === "true");
      await page.evaluate(() => { document.querySelector("#history-export-csv-button").click(); document.querySelector("#history-export-image-button").click(); });
      assert(exports.length === 1, "Pending export issued duplicate logical requests");
      const downloaded = page.waitForEvent("download");
      releaseExport();
      const download = await downloaded;
      assert(download.suggestedFilename() === "fixture.csv", "CSV filename was lost");
      await page.waitForFunction(() => !document.querySelector("#history-export-csv-button").disabled);
      const query = new URL(exports[0]).searchParams;
      assert(query.get("source") === "played-2026-09-01_12-00-00.json" && query.get("page_size") === "50", "Export settings were not captured");
      const imageDownload = page.waitForEvent("download");
      await page.locator("#history-export-image-button").click();
      assert((await imageDownload).suggestedFilename() === "fixture.png", "Image download failed");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !elements.historyExportDialog.open && document.activeElement === elements.historyExportButton
        && !document.body.classList.contains("playback-sheet-scroll-locked"));
      await page.evaluate(() => { window.BilikaraRemoteTransport = { mode: "internet" }; });
      await page.locator("#history-export-button").click();
      assert(!await page.locator("#history-export-row").isVisible(), "Internet must not expose LAN-only export controls");
      await page.evaluate(async () => { try { await downloadHistoryExport("csv"); } catch {} });
      assert(exports.length === 2, "Internet attempted a direct LAN export");
      await page.locator("#history-export-close").click();
      await page.locator("#history-export-button").click();
      await page.mouse.click(2, 2);
      await page.waitForFunction(() => !elements.historyExportDialog.open);
      await page.evaluate(() => { delete window.BilikaraRemoteTransport; activateRemoteRequestView("search"); });
      await page.reload();
      await page.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
      assert(await page.evaluate(() => state.remoteRequestView === "search"), "View selection must survive same-tab reload");
      const fresh = await context.newPage();
      await fresh.goto(`${baseUrl}/remote`);
      await fresh.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
      assert(await fresh.evaluate(() => state.remoteRequestView === "quick"), "New Remote tab must start Quick");
      await fresh.close();
      assert(errors.length === 0, `Remote console errors: ${errors.join("; ")}`);
      evidence.push({ scenario, geometry, dialog, exportCount: exports.length, errors });
    } finally { releaseExport?.(); await context.close(); }
  }
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  try {
    const host = await context.newPage();
    await host.goto(baseUrl);
    await host.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
    assert(await host.evaluate(() => state.requestSubview === "quick"), "Host must start Quick");
    await host.evaluate(() => activateRequestSubview("search"));
    await host.reload();
    await host.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
    assert(await host.evaluate(() => state.requestSubview === "search"), "Host session selection was lost");
    const fresh = await context.newPage();
    await fresh.goto(baseUrl);
    await fresh.waitForFunction(() => typeof state !== "undefined" && state.translationsLoaded);
    assert(await fresh.evaluate(() => state.requestSubview === "quick"), "New Host tab inherited old selection");
    await fresh.evaluate(() => {
      state.data = { ...state.data, current_item: null }; renderPlaylist([], null, {});
    });
    const empty = await fresh.locator("#playlist .queue-empty").evaluate((node) => {
      const s = getComputedStyle(node); return { border: s.borderTopWidth, align: s.textAlign, font: s.fontSize };
    });
    assert(empty.border === "0px" && empty.align === "center" && empty.font === "13px", "Host empty message style differs");
    if (screenshotPath) await fresh.screenshot({ path: shotPath(screenshotPath, "host-empty"), fullPage: false });
    await fresh.evaluate(() => activateHostWorkspace("history"));
    await fresh.locator("#history-export-button").click();
    await fresh.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    assert(!await fresh.locator("#confirm-text").isVisible(), "Host export still prints help");
    await fresh.locator('[aria-describedby="confirm-source-info"]').click();
    assert(await fresh.locator("#confirm-source-info").isVisible(), "Host export help missing");
    await fresh.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    const help = await fresh.locator("#confirm-source-info").boundingBox();
    const helpButton = await fresh.locator('[aria-describedby="confirm-source-info"]').boundingBox();
    assert(help.y >= 0 && help.y + help.height < helpButton.y, "Host help must open above the button without clipping");
    assert(await fresh.locator("#confirm-source-info").evaluate((node) => node.matches(":popover-open")
      && node.contains(document.elementFromPoint(node.getBoundingClientRect().x + 12, node.getBoundingClientRect().y + 12))), "Host help is not in the visible top layer");
    if (screenshotPath) await fresh.screenshot({ path: shotPath(screenshotPath, "host-export-help"), fullPage: false });
    await fresh.evaluate(() => {
      closeCacheAdvancedInfo();
      state.confirmIntent.x = 12;
      state.confirmIntent.y = 12;
      renderConfirmPopover();
    });
    await fresh.locator('[aria-describedby="confirm-source-info"]').click();
    assert(await fresh.locator("#confirm-source-info").getAttribute("data-tooltip-direction") === "down", "Help must flip down at the viewport top");
    await fresh.evaluate(() => closeConfirm());
    assert(!await fresh.locator("#confirm-source-info").evaluate((node) => node.matches(":popover-open")), "Closing export left a top-layer tooltip behind");
    evidence.push({ host: empty });
  } finally { await context.close(); }
  return { passed: true, evidence };
}
module.exports = { runRemoteUiPolishGate };
