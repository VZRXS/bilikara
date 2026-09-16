"use strict";

const assert = require("node:assert/strict");
const { workspaceRouteState, installWorkspaceRoutes, prepareRemotePage } = require("./live_remote_request_workspace_browser");

// Synthetic snapshots only: use the existing browser harness and actual UI handlers.
async function runHostPartsGate(browser, baseUrl, screenshotPath) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const snapshot = {
    state_revision: 1, playlist: [], history: [], session_history: [], current_item: null,
    session_users: ["Browser QA"], remote_session_id: "browser-remote-session", playback_mode: "local",
    bbdown: { logged_in: false }, player_settings: {}, gatcha: {}, gatcha_pool_config: {},
  };
  await context.route("**/api/**", route => route.fulfill({ json: { ok: true, data: snapshot } }));
  await installWorkspaceRoutes(context, workspaceRouteState());
  await context.route("**/api/events*", route => route.fulfill({
    contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`,
  }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const capture = async suffix => {
    await page.waitForFunction(() => {
      const svg = elements.audioVariantToggle?.querySelector("svg");
      if (!state.audioVariantBarExpanded || !svg) return true;
      return getComputedStyle(svg).transform === "matrix(-1, 0, 0, -1, 0, 0)";
    });
    if (screenshotPath) await page.screenshot({ path: screenshotPath.replace(/(\.[^./]+)$/, `-${suffix}$1`) });
  };
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => state.translationsLoaded);
    // Freeze transport polling, then render controlled snapshots with the real renderer.
    await page.evaluate(() => { disconnectClient(); });
    const scenarios = [{ width: 1280, height: 800 }, { width: 900, height: 500 }, { width: 640, height: 400 }];
    for (const viewport of scenarios) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        const pages = Array.from({ length: 60 }, (_, i) => i + 1);
        const item = {
          id: "browser-many-parts", item_incarnation_id: "browser-incarnation", title: "多分 P 测试",
          page: 1, available_pages: pages, available_parts: pages.map(p => `P${p} · 長い曲名 (HONOKA Mix)`),
          selected_pages: [1, 3, 60], selected_audio_variant_id: "p3_track",
          audio_variants: [1, 3, 60].map(page => ({ id: `p${page}_track`, page, audio_url: `/fixture-${page}.m4a` })),
        };
        state.data = { ...state.data, current_item: item, playback_mode: "local" };
        state.audioVariantBarRenderSignature = "";
        renderAudioVariantBar(item, "local");
      });
      await page.waitForFunction(() => !elements.audioVariantToggle.classList.contains("hidden"));
      await page.locator("#audio-variant-toggle").click();
      const popup = await page.evaluate(() => {
        const popover = elements.audioVariantPopover;
        const list = popover.querySelector(".audio-variant-list");
        window.__partsList = list;
        const rect = popover.getBoundingClientRect();
        const first = list.firstElementChild.getBoundingClientRect();
        return {
          pages: [...list.children].map(button => Number(button.dataset.page)),
          top: rect.top, bottom: rect.bottom, firstTop: first.top, firstBottom: first.bottom,
          scrollTop: popover.scrollTop, height: rect.height, viewportHeight: innerHeight,
          summary: elements.audioVariantBar.querySelector(".audio-variant-summary").textContent,
        };
      });
      assert.deepEqual(popup.pages, Array.from({ length: 60 }, (_, i) => i + 1));
      assert.ok(popup.top >= 0 && popup.bottom <= popup.viewportHeight && popup.height <= 241, JSON.stringify(popup));
      assert.ok(popup.firstTop >= popup.top && popup.firstBottom <= popup.bottom, JSON.stringify(popup));
      assert.match(popup.summary, /^P3 /);
      await capture(`parts-${viewport.width}`);
      assert.ok(await page.evaluate(() => {
        const popover = elements.audioVariantPopover;
        popover.scrollTop = popover.scrollHeight;
        const last = popover.querySelector(".audio-variant-list").lastElementChild.getBoundingClientRect();
        const rect = popover.getBoundingClientRect();
        return last.top >= rect.top && last.bottom <= rect.bottom;
      }));
      await page.evaluate(() => { syncAudioVariantOverflow(); });
      assert.ok(await page.evaluate(() => elements.audioVariantPopover.firstElementChild === window.__partsList));
      assert.ok(await page.locator("#audio-variant-popover").evaluate(e => e.scrollTop > 0));
      await page.keyboard.press("Escape");
      await page.locator("#audio-variant-toggle").click();
      assert.equal(await page.locator("#audio-variant-popover").evaluate(e => e.scrollTop), 0);
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        openBindingModal({ url: "https://www.bilibili.com/video/BVfixture" }, {
          pages: Array.from({ length: 60 }, (_, i) => ({ page: i + 1, part: `P${i + 1} · 長い曲名 (HONOKA Mix)`, duration: 333 })),
        });
      });
      const binding = await page.evaluate(() => {
        const footer = elements.bindingModalConfirm.getBoundingClientRect();
        const list = elements.bindingAudioOptions;
        return { top: footer.top, bottom: footer.bottom, viewportHeight: innerHeight,
          count: list.children.length, scrolls: list.scrollHeight > list.clientHeight };
      });
      assert.ok(binding.top >= 0 && binding.bottom <= binding.viewportHeight && binding.scrolls, JSON.stringify(binding));
      assert.equal(binding.count, 60);
      await page.locator('#binding-audio-options input[value="60"]').check();
      await capture(`binding-${viewport.width}`);
      await page.locator("#binding-modal-cancel").click();
      assert.ok(await page.locator("#binding-modal").isHidden());
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const item = { ...state.data.current_item, available_pages: [1, 2], available_parts: ["On vocal", "Off vocal"], selected_pages: [1, 2] };
      state.audioVariantBarRenderSignature = "";
      renderAudioVariantBar(item, "local");
    });
    await page.waitForFunction(() => elements.audioVariantBar.classList.contains("is-inline"));
    assert.ok(await page.locator("#audio-variant-toggle").isHidden());
    assert.deepEqual(await page.locator("#audio-variant-bar .audio-variant-button").evaluateAll(buttons => buttons.map(b => b.dataset.page)), ["1", "2"]);
    assert.ok(await page.locator("#audio-variant-bar .audio-variant-button").first().evaluate(button => (
      button.getBoundingClientRect().width < button.closest(".audio-variant-bar").clientWidth / 2
    )), "Short inline parts should retain their intrinsic width");
    await capture("inline");
    // Removal closes any old popup and removes its buttons, even after a snapshot update.
    await page.evaluate(() => renderAudioVariantBar(null, "local"));
    assert.equal(await page.locator("#audio-variant-popover button").count(), 0);
    assert.ok(await page.locator("#audio-variant-popover").isHidden());
    await prepareRemotePage(page, baseUrl, workspaceRouteState());
    assert.equal(await page.evaluate(() => {
      const toggle = document.createElement("button"); toggle.className = "audio-variant-toggle";
      document.body.append(toggle); const shadow = getComputedStyle(toggle).boxShadow; toggle.remove(); return shadow;
    }), "none");
    assert.deepEqual(errors, []);
    return { passed: true, parts: 60, viewports: scenarios, consoleErrors: errors };
  } finally { await context.close(); }
}
module.exports = { runHostPartsGate };
