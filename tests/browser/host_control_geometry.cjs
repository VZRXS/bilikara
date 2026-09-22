"use strict";
// Focused shared-layout regression; desktop Chromium is not Android evidence.
// node tests/browser/host_control_geometry.cjs PRIVATE_BOOTSTRAP_JSON OUTPUT_DIR
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");

(async () => {
  const [bootstrapFile, output] = process.argv.slice(2);
  const bootstrap = JSON.parse(await fs.readFile(bootstrapFile, "utf8"));
  await fs.mkdir(output, {recursive: true});
  const browser = await chromium.launch({headless: true, chromiumSandbox: true,
    ...(process.env.BILIKARA_BROWSER_EXECUTABLE ? {executablePath: process.env.BILIKARA_BROWSER_EXECUTABLE} : {})});
  const errors = [], measurements = [];
  try {
    const context = await browser.newContext({viewport: {width: 412, height: 850}, locale: "en-US"});
    // No requests, login, ratings or external catalog operations in this geometry test.
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (/^\/api\/(catalog|d1|lark|gatcha)\//.test(url.pathname)) {
        return route.fulfill({json: {ok: true, data: {items: [], tags: [], sources: [], state: "idle"}}});
      }
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(bootstrap.bootstrapUrl || bootstrap.bootstrap_url);
    await page.waitForFunction(() => typeof state !== "undefined" && state.data && window.BilikaraHostLayout);
    for (const width of [320, 412, 699, 1440]) {
      await page.setViewportSize({width, height: 850});
      await page.waitForFunction(phone => BilikaraHostLayout.isPortrait() === phone, width < 700);
      const toggle = page.locator("#stage-controls-toggle");
      if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      await page.locator("#volume-slider").waitFor({state: "visible"});
      const measure = await page.evaluate(() => {
        const rect = node => {const r = node.getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width};};
        const slider = document.getElementById("volume-slider");
        return {width:innerWidth, layout:document.documentElement.dataset.hostLayout,
          slider:rect(slider), controls:rect(slider.parentElement), value:rect(document.getElementById("volume-value")),
          delay:[...document.querySelectorAll("#av-sync-panel .av-sync-controls > *")].map(rect)};
      });
      assert.ok(measure.slider.width >= 44, "Volume range remains touch-usable");
      assert.ok(measure.slider.left >= measure.controls.left - 1 && measure.slider.right <= measure.controls.right + 1,
        `Volume range stays inside its controls: ${JSON.stringify(measure)}`);
      assert.ok(measure.slider.right <= measure.value.left + 1, "Volume range does not overlap its value button");
      for (const button of measure.delay) assert.ok(button.left >= 0 && button.right <= width + 1);
      measurements.push(measure);
      await page.screenshot({path:path.join(output, `controls-${width}.png`)});
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output,"result.json"),JSON.stringify({passed:true,measurements,errors},null,2));
    console.log(JSON.stringify({passed:true,widths:measurements.map(x=>x.width),errors}));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
