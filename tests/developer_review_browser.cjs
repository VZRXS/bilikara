"use strict";
// Offline: real Host markup/styles and production action functions. No server,
// production credentials, dependency installation or D1 traffic is involved.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, "static", name), "utf8").replace(/\r\n/g, "\n");
const source = read("app.js"), html = read("index.html");
const translations = JSON.parse(read("i18n.json")).languages;
function fn(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert(match, name);
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}
const functions = ["openExpandedRequestWorkspace", "closeExpandedRequestWorkspace", "trapDeveloperDialogFocus",
  "closeHighestRequestTaskLayerForEscape", "openDeveloperTagResetModal", "renderDeveloperTagResetModal",
  "closeDeveloperTagResetModal", "renderDeveloperActionFields", "developerDeleteSnapshot", "developerFieldValue",
  "openPendingReviewRejectModal", "rejectPendingReviewPage", "rejectPendingReviewEntry", "confirmDeveloperAction",
  "ensurePendingReviewView", "renderPendingReviewView", "removePendingReviewItem", "loadPendingReviewItems",
  "approvePendingReviewVisibleItems"];
const handlers = source.slice(source.indexOf('elements.requestWorkspaceExpand?.addEventListener'),
  source.indexOf('elements.developerTagResetDeleteMid?.addEventListener'));
(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BILIKARA_TEST_BROWSER_CHANNEL || undefined });
  try {
    for (const [width, language, portrait] of [[1440, "zh", false], [900, "en", false], [390, "ja", true]]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.route("**/*", route => route.abort());
      await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, ""));
      for (const match of html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)) {
        await page.addStyleTag({ content: read(match[1]) });
      }
      await page.evaluate(({ language, translations, portrait }) => {
        const byId = id => document.getElementById(id);
        window.state = { developerMode: false, bilikaraSecret: "offline", requestWorkspaceExpansion: null,
          pendingReviewItems: [], pendingReviewTotal: 22, pendingReviewExportCount: 50000,
          pendingReviewLoaded: true, pendingReviewSeq: 0, developerTagResetSaving: false, catalogAdvancedTool: "review" };
        document.documentElement.style.setProperty("--accent", "#cf593f");
        document.documentElement.style.setProperty("--accent-deep", "#aa3d27");
        window.t = (key, params = {}) => (translations[language][key] || key).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ""));
        window.elements = { appShell: byId("app-shell"), requestWorkspace: byId("host-workspace-request"),
          catalogAdvancedContent: byId("catalog-advanced-content"), catalogAdvancedMenu: byId("catalog-advanced-menu") };
        for (const name of ["requestWorkspaceExpand", "requestWorkspaceCollapse", "requestWorkspaceModal", "requestWorkspaceModalCard",
          "requestWorkspaceModalBackdrop", "developerTagResetModal", "developerTagResetTitle", "developerTagResetText", "developerTagResetNote",
          "developerTagResetError", "developerTagResetFields", "developerTagResetConfirm", "developerTagResetCancel", "developerTagResetClose",
          "developerTagResetDeleteMid", "developerTagResetBackdrop"]) {
          elements[name] = byId(name.replace(/[A-Z]/g, c => "-" + c.toLowerCase()));
        }
        elements.requestWorkspaceModalBackdrop = byId("request-workspace-modal-backdrop");
        window.developerDeletePreferredFieldKeys = ["bvid", "title"];
        window.searchResultBvid = item => item.bvid;
        window.selectedRequesterName = () => "Offline reviewer";
        window.searchDetailController = { isOpen: () => false };
        window.renderHostWorkspaceSelection = () => {};
        window.messages = [];
        window.setAppMessage = (message, error) => messages.push({ message, error });
        window.renderSearchResultItems = (container, items) => {
          container.classList.remove("hidden");
          container.replaceChildren(...items.map(item => {
            const card = document.createElement("article"); card.className = "search-result-item";
            const title = document.createElement("p"); title.className = "search-result-title"; title.textContent = item.title;
            card.append(title); return card;
          }));
        };
        window.nextItems = [{ bvid: "BV0000000003", title: "Next page — must not be rejected" }];
        window.refreshes = 0;
        window.fetchPendingReviewItems = async () => { refreshes++; return { items: nextItems, total_pending: 20, export_count: 50000 }; };
        window.apiCalls = [];
        window.apiPost = async (url, body) => { apiCalls.push(body.bvid); };
        window.fixtureItems = [{ bvid: "BV0000000001", title: "Pending first 日本語 中文" }, { bvid: "BV0000000002", title: "Pending second English" }];
        state.pendingReviewItems = fixtureItems.slice();
        for (const panel of document.querySelectorAll("[data-host-workspace-panel]")) { panel.hidden = panel !== elements.requestWorkspace; panel.inert = panel.hidden; }
        for (const panel of document.querySelectorAll("[data-request-panel]")) { panel.hidden = panel.id !== "request-discover-panel"; panel.inert = panel.hidden; }
        byId("request-discover-categories").hidden = true;
        byId("catalog-advanced-view").hidden = false; byId("catalog-advanced-view").inert = false;
        window.savedPanel = elements.requestWorkspace;
        // Host normally creates media elements during player bootstrap. Supply
        // real nodes in this offline fixture; null === null is not preservation.
        const video = document.createElement("video"), audio = document.createElement("audio");
        video.muted = true; audio.volume = 0.37;
        document.querySelector(".player-panel").append(video, audio);
        window.savedVideo = document.querySelector("video");
        window.savedAudio = audio;
        window.savedDraft = byId("search-input") || elements.requestWorkspace.querySelector("input"); savedDraft.value = "Draft must survive";
        if (portrait) {
          document.documentElement.dataset.hostLayout = "portrait";
          document.documentElement.dataset.hostPage = "request";
          byId("android-request-tabs").append(document.querySelector(".request-subview-tabs"));
        }
        window.savedTabsParent = document.querySelector(".request-subview-tabs").parentNode;
      }, { language, translations, portrait });
      await page.addScriptTag({ content: functions.map(fn).join("\n") + "\n" + handlers });
      await page.evaluate(() => {
        renderPendingReviewView();
        elements.requestWorkspace.addEventListener("click", event => {
          if (event.target.closest("[data-pending-review-reject]")) openPendingReviewRejectModal();
        });
        document.addEventListener("keydown", event => {
          if (event.key === "Escape" && closeHighestRequestTaskLayerForEscape()) event.preventDefault();
        });
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator("#request-workspace-expand").isVisible(), false, "ordinary users must not see Expand");
      await page.evaluate(() => openExpandedRequestWorkspace());
      await page.locator("#request-workspace-modal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => state.requestWorkspaceExpansion), null);
      await page.evaluate(() => { state.developerMode = true; document.body.classList.add("developer-mode"); renderPendingReviewView(); });
      await page.locator("#request-workspace-expand").click();
      await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
      const geometry = await page.evaluate(() => {
        const modal = elements.requestWorkspaceModalCard, button = elements.requestWorkspaceCollapse;
        const rect = node => node.getBoundingClientRect().toJSON();
        return { card: rect(modal), button: rect(button), radius: getComputedStyle(modal).borderRadius,
          backdrop: getComputedStyle(elements.requestWorkspaceModalBackdrop).backgroundColor,
          titleFont: getComputedStyle(document.getElementById("workspace-request-heading")).fontSize,
          mediaSame: Boolean(savedVideo) && savedVideo === document.querySelector("video") && savedAudio === document.querySelector("audio") && savedAudio.volume === 0.37,
          nodeSame: savedPanel === elements.requestWorkspace,
          tabsInside: modal.contains(document.querySelector(".request-subview-tabs")), shellInert: elements.appShell.inert };
      });
      assert(geometry.card.width > width * 0.75 && geometry.card.right <= width && geometry.card.bottom <= 900);
      assert.equal(geometry.radius, "18px"); assert.equal(geometry.titleFont, "18px");
      assert.equal(geometry.backdrop, "rgba(0, 0, 0, 0)");
      assert(geometry.nodeSame && geometry.mediaSame && geometry.tabsInside && geometry.shellInert);
      assert(geometry.button.width === 32 && geometry.button.height === 32, JSON.stringify(geometry));
      assert(Math.abs(geometry.button.right - geometry.card.right + 16) <= 2, "close belongs in the upper-right corner");
      assert(Math.abs(geometry.button.top - geometry.card.top - 16) <= 2, "close keeps the shared top inset: " + JSON.stringify(geometry));
      await page.locator("[data-pending-review-approve]").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.dataset.requestView), "quick", "Tab wraps inside the modal");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.locator("[data-pending-review-approve]").evaluate(el => el === document.activeElement), true);
      if (process.env.BILIKARA_TEST_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.BILIKARA_TEST_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR, `review-expanded-${width}.png`) });
      }
      await page.locator("[data-pending-review-reject]").click();
      assert(await page.locator("#developer-tag-reset-modal").isVisible());
      await page.evaluate(() => {
        window.failSecond = true;
        apiPost = async (url, body) => {
          apiCalls.push(body.bvid);
          if (body.bvid === fixtureItems[0].bvid) await new Promise(resolve => { window.releaseFirst = resolve; });
          if (body.bvid === fixtureItems[1].bvid && failSecond) throw new Error("Offline simulated failure");
        };
        elements.developerTagResetConfirm.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      });
      assert.equal(await page.evaluate(() => apiCalls.length), 0, "IME Enter is not confirmation");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => typeof releaseFirst === "function");
      assert.equal(await page.locator("#developer-tag-reset-confirm").getAttribute("aria-busy"), "true");
      await page.keyboard.press("Enter");
      assert.deepEqual(await page.evaluate(() => apiCalls), ["BV0000000001"], "no duplicate while pending");
      await page.evaluate(() => releaseFirst());
      await page.waitForFunction(() => !state.developerTagResetSaving);
      assert.deepEqual(await page.evaluate(() => state.developerTagResetItem.items.map(x => x.bvid)), ["BV0000000002"]);
      assert.equal(await page.evaluate(() => refreshes), 0, "failed page must not load another page");
      assert(await page.locator("#developer-tag-reset-error").isVisible());
      await page.evaluate(() => { failSecond = false; });
      await page.locator("#developer-tag-reset-confirm").press("Enter");
      await page.waitForFunction(() => !state.developerTagResetItem);
      assert.deepEqual(await page.evaluate(() => apiCalls), ["BV0000000001", "BV0000000002", "BV0000000002"]);
      assert.equal(await page.evaluate(() => refreshes), 1, "only one refresh after the entire confirmed page");
      assert.deepEqual(await page.evaluate(() => state.pendingReviewItems.map(x => x.bvid)), ["BV0000000003"]);
      await page.keyboard.press("Escape");
      await page.locator("#request-workspace-modal").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#request-workspace-modal").isVisible(), false);
      assert(await page.evaluate(() => savedPanel === elements.requestWorkspace && savedVideo === document.querySelector("video")
        && savedDraft.value === "Draft must survive" && savedTabsParent === document.querySelector(".request-subview-tabs").parentNode && !elements.appShell.inert));
      // Repeated opens keep scroll/focus and the original node; backdrop and the
      // icon close work independently of Escape and cannot accumulate handlers.
      await page.locator("#request-workspace-expand").click();
      await page.evaluate(() => {
        const spacer = document.createElement("div"); spacer.style.height = "1800px";
        elements.catalogAdvancedContent.append(spacer);
        document.getElementById("catalog-advanced-view").scrollTop = 80;
      });
      await page.locator("#request-workspace-collapse").click();
      await page.locator("#request-workspace-modal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement.id), "request-workspace-expand");
      assert.equal(await page.evaluate(() => document.getElementById("catalog-advanced-view").scrollTop), 80);
      await page.locator("#request-workspace-expand").click();
      assert.equal(await page.evaluate(() => document.getElementById("catalog-advanced-view").scrollTop), 80);
      await page.locator("#request-workspace-modal-backdrop").click({ position: { x: 1, y: 1 } });
      await page.locator("#request-workspace-modal").waitFor({ state: "hidden" });
      // Cancel by keyboard must not turn into the default destructive action.
      await page.evaluate(() => openDeveloperTagResetModal(developerDeleteSnapshot(nextItems[0]), "reject-entry"));
      const before = await page.evaluate(() => apiCalls.length);
      await page.locator("#developer-tag-reset-cancel").press("Enter");
      await page.locator("#developer-tag-reset-modal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => apiCalls.length), before);
      assert.equal(await page.locator("#developer-tag-reset-modal").isVisible(), false);
      // Committed writes survive an unavailable next-page refresh.
      await page.evaluate(async () => {
        approvePendingReviewItems = async () => ({ approved: 1, approved_bvids: [nextItems[0].bvid], skipped_missing: 0, refresh_error: "offline" });
        await approvePendingReviewVisibleItems();
      });
      assert.equal(await page.evaluate(() => state.pendingReviewItems.length), 0);
      assert.equal(await page.evaluate(() => state.pendingReviewLoaded), false);
      assert.match(await page.locator("[data-pending-review-message]").innerText(), /刷新|refresh|更新/);
      assert.deepEqual(errors, []);
      console.log(`PASS developer review ${width}px / ${language} / portrait=${portrait}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
