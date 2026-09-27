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
    assert.deepEqual(errors, []);
    console.log("PASS: no separators at scroll endpoints, in independent columns, after resizing or panel reinsertion; stable geometry");
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
