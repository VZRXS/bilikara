"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`
      <style>
        :root { --line: rgb(100, 100, 100); }
        .selection-modal { width: 500px; }
        .columns { display: flex; }
        .selection-option-list { overflow-y: auto; height: 25vh; width: 50%; }
        .content { height: 600px; }
        [hidden] { display: none !important; }
      </style>
      <div class="selection-modal">
        <header class="selection-modal-head"><h2>Selection</h2></header>
        <div class="columns">
          <div class="selection-option-list" id="left"><div class="content"></div></div>
          <div class="selection-option-list" id="right"><div class="content"></div></div>
        </div>
        <footer class="selection-modal-actions"><button>Confirm</button></footer>
      </div>
    `);
    await page.addStyleTag({ path: path.join(__dirname, "../static/ui-surfaces.css") });
    async function edges() {
      assert.deepEqual(await page.evaluate(() => {
        const head = document.querySelector(".selection-modal-head");
        const foot = document.querySelector(".selection-modal-actions");
        return [getComputedStyle(head).borderBottomWidth, getComputedStyle(foot).borderTopWidth,
          head.hasAttribute("data-scroll-edge-top"), foot.hasAttribute("data-scroll-edge-bottom")];
      }), ["0px", "0px", false, false]);
    }
    const scroll = (id, y) => page.locator(id).evaluate((el, y) => { el.scrollTop = y; }, y);
    await edges();
    const initialFooter = await page.locator(".selection-modal-actions").boundingBox();
    await scroll("#left", 100);
    await edges();
    await scroll("#left", 9999);
    await edges(); // Independent columns must not introduce separators.
    await scroll("#right", 9999);
    await edges();
    assert.deepEqual(await page.locator(".selection-modal-actions").boundingBox(), initialFooter);

    // Content changes and native scroll clamping keep borders absent.
    await page.locator(".content").evaluateAll(nodes => nodes.forEach(el => { el.style.height = "20px"; }));
    await edges();
    await page.locator("#right .content").evaluate(el => { el.style.height = "600px"; });
    await edges();
    await page.locator("#right").evaluate(el => { el.hidden = true; });
    await edges();
    await page.locator("#right").evaluate(el => { el.hidden = false; });
    await edges();

    // Resizing may change overflow but must not bring separators back.
    await page.setViewportSize({ width: 900, height: 2600 });
    await edges();
    await page.setViewportSize({ width: 900, height: 700 });
    await edges();
    await page.locator(".selection-modal").evaluate(el => { el.hidden = true; });
    await edges();
    await page.locator(".selection-modal").evaluate(el => { el.hidden = false; });
    await edges();

    // Rebuilt/reinserted panels need no scroll observer attributes.
    await page.locator(".selection-modal").evaluate(el => { window.detachedPanel = el; el.remove(); });
    await page.evaluate(() => document.body.append(window.detachedPanel));
    await scroll("#right", 9999);
    await edges();
    await page.locator("#right").evaluate(el => el.replaceChildren());
    await edges();

    // Shared close-button rules must not paint the drawer's icon-only collapse.
    await page.setContent(`
      <header class="playback-sheet-status-header">
        <span class="playback-sheet-status-label">正在播放</span>
        <button id="playback-sheet-collapse" class="playback-sheet-collapse">⌄</button>
        <div class="playback-sheet-status-actions">
          <button id="open-rating-button">评价</button>
          <button id="refresh-button">刷新</button>
        </div>
      </header>
    `);
    await page.evaluate(() => { document.documentElement.dataset.uiClient = "remote"; });
    await page.addStyleTag({ path: path.join(__dirname, "../static/remote.css") });
    await page.addStyleTag({ path: path.join(__dirname, "../static/ui-surfaces.css") });
    for (const theme of ["light", "dark", "blue"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator("#playback-sheet-collapse").focus();
      await page.locator("#playback-sheet-collapse").hover();
      const controls = await page.locator("#playback-sheet-collapse, #open-rating-button").evaluateAll(nodes =>
        nodes.map(node => ({ background: getComputedStyle(node).backgroundColor, height: node.getBoundingClientRect().height })),
      );
      assert.equal(controls[0].background, "rgba(0, 0, 0, 0)", theme);
      assert.equal(controls[0].height, 32, theme);
      assert.equal(controls[1].height, 32, theme);
      assert.notEqual(controls[1].background, "rgba(0, 0, 0, 0)", theme);
    }
    for (const client of ["host", "remote"]) {
      for (const markup of [
        `<section class="selection-modal-card" data-panel><header class="selection-modal-head">
          <h2>测试标题</h2><div class="pool-config-head-actions">
          <button class="toolbar-button ghost-button">重置</button>
          <button class="banner-close binding-sheet-close" data-close>×</button>
          </div></header></section>`,
        `<section class="rating-card" data-panel><button class="rating-close" data-close>×</button>
          <div class="rating-body"><h2 class="rating-title">测试标题</h2></div></section>`,
        client === "remote" ? `<dialog class="history-export-dialog" open data-panel>
          <header class="binding-sheet-head"><h2>导出歌单</h2>
          <button class="binding-sheet-close" data-close>×</button></header></dialog>` :
        `<section id="confirm-popover" class="confirm-popover" data-panel>
          <h2 id="confirm-title">测试标题</h2><button id="confirm-close" class="banner-close" data-close>×</button></section>`,
      ]) {
        const fixture = client === "remote" && markup.includes("selection-modal-card")
          ? `<div class="binding-sheet is-open">${markup
            .replaceAll("selection-modal-card", "binding-sheet-panel")
            .replaceAll("selection-modal-head", "binding-sheet-head")}</div>`
          : markup;
        await page.setContent(fixture);
        await page.evaluate(client => { document.documentElement.dataset.uiClient = client; }, client);
        await page.addStyleTag({ path: path.join(__dirname, client === "host" ? "../static/styles.css" : "../static/remote.css") });
        await page.addStyleTag({ path: path.join(__dirname, "../static/ui-surfaces.css") });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("[data-close]").waitFor({ state: "visible" });
        await page.locator("[data-panel]").evaluate(async panel => {
          await Promise.all(panel.getAnimations({ subtree: true }).map(animation => animation.finished));
        });
        const insets = await page.locator("[data-panel]").evaluate(panel => {
          const p = panel.getBoundingClientRect(), c = panel.querySelector("[data-close]").getBoundingClientRect();
          return { top: c.top - p.top, right: p.right - c.right, height: c.height };
        });
        assert.ok(Math.abs(insets.top - insets.right) < 0.1, `${client}: ${JSON.stringify(insets)}`);
        assert.equal(insets.height, 32, `${client}: ${markup}`);
      }
    }
    assert.deepEqual(errors, []);
    console.log("PASS: no scroll separators; icon-only collapse in all themes; equal Host/Remote top-right action insets");
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
