"use strict";
// Real native Host and Remote pages; catalog/network requests stay offline.
// Scrollbars remain visible (Playwright hides them by default), because a
// classic horizontal scrollbar is what moves a row box's center.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const playwright = require("playwright");

const [binary, output] = process.argv.slice(2);
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

async function box(page, selector) {
  return page.evaluate(query => {
    const node = document.querySelector(query);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, center: rect.y + rect.height / 2 };
  }, selector);
}

(async () => {
  const evidence = path.resolve(output);
  await fs.mkdir(evidence, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "request-alignment-"));
  const server = spawn(path.resolve(binary), ["--headless", "--data-dir", home,
    "--static-dir", path.resolve(__dirname, "../../static")], {
    cwd: home,
    env: { ...process.env, BILIKARA_SHUTDOWN_TOKEN: "fixture-private",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", browser, ready;
  server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  const lines = createInterface({ input: server.stdout });
  try {
    ready = JSON.parse(await Promise.race([
      once(lines, "line").then(value => value[0]),
      once(server, "exit").then(() => { throw Error(stderr); }),
    ]));
    browser = await playwright.chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
    const results = [];
    for (const [width, height] of [[700, 800], [1024, 700], [1180, 760], [1440, 900]]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
      const page = await context.newPage();
      await page.goto(ready.bootstrapUrl);
      await page.waitForFunction(() => typeof state !== "undefined" && state.data);
      await page.evaluate(async () => {
        try { await apiPostStateSnapshot("/api/session-users/add", { name: "对齐测试" }); } catch { /* Already present. */ }
        render();
      });
      assert.equal(await page.evaluate(() => document.documentElement.dataset.hostLayout), "landscape");
      if (await page.locator("#work-rail-request").isVisible()) await page.locator("#work-rail-request").click();
      const view = async name => {
        await page.locator(`[data-request-view="${name}"]`).first().click();
        await page.waitForTimeout(150);
      };
      await view("quick");
      const quick = await box(page, "#requester-select");
      await view("search");
      const search = await box(page, "#lark-search-query");
      const submit = await box(page, "#lark-search-button");
      await view("sources");
      const sources = await box(page, "#modal-follow-uid-input");
      // Switching tabs keeps the first control row in one position and height.
      for (const candidate of [search, sources]) {
        assert.ok(near(candidate.x, quick.x) && near(candidate.y, quick.y) && near(candidate.height, quick.height),
          JSON.stringify({ width, quick, search, sources }));
      }
      assert.ok(near(submit.height, search.height) && near(submit.center, search.center), JSON.stringify({ width, search, submit }));

      await view("discover");
      await page.locator(".category-browser-card").first().click();
      await page.locator(".category-browser-tabs .category-browser-tab").first().waitFor();
      await page.waitForTimeout(250);
      const row = await box(page, ".category-browser-tabs");
      const back = await box(page, ".category-browser-tabs .tag-browser-back");
      const tab = await box(page, ".category-browser-tabs .category-browser-tab");
      const action = await box(page, ".browse-search-bar .browse-search-cancel");
      assert.ok(row.height > tab.height, JSON.stringify({ width, row, tab }));
      assert.ok(near(back.center, tab.center) && near(action.center, tab.center), JSON.stringify({ width, back, tab, action }));
      await page.locator(".browse-search-bar .browse-search-cancel").click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      const cancel = await box(page, ".browse-search-bar .browse-search-cancel");
      const opened = await box(page, ".browse-search-bar .browse-search-form");
      assert.ok(near(cancel.center, tab.center) && near(opened.center, tab.center), JSON.stringify({ width, cancel, opened, tab }));
      await page.screenshot({ path: path.join(evidence, `host-${width}x${height}.png`) });
      results.push({ width, quick, search, sources, row: row.height, tab: tab.center, action: action.center });
      await context.close();
    }

    // A narrow desktop keeps its workspace and tool rail, with the same aligned actions.
    const portraitContext = await browser.newContext({ viewport: { width: 600, height: 900 }, locale: "zh-CN" });
    const portrait = await portraitContext.newPage();
    await portrait.goto(ready.bootstrapUrl);
    await portrait.waitForFunction(() => typeof state !== "undefined" && state.data);
    assert.equal(await portrait.evaluate(() => document.documentElement.dataset.hostLayout), "landscape");
    assert.equal(await portrait.locator("#android-host-dock").isVisible(), false);
    assert.equal(await portrait.locator("#cache-settings").evaluate(n => Boolean(n.closest(".topbar"))), true);
    await portrait.evaluate(() => activateHostWorkspace("request"));
    await portrait.evaluate(() => activateRequestSubview("search"));
    await portrait.waitForTimeout(250);
    const portraitSearch = await box(portrait, "#lark-search-query");
    const portraitSubmit = await box(portrait, "#lark-search-button");
    assert.ok(near(portraitSubmit.height, portraitSearch.height) && near(portraitSubmit.center, portraitSearch.center),
      JSON.stringify({ portraitSearch, portraitSubmit }));
    await portrait.evaluate(() => activateRequestSubview("discover"));
    await portrait.locator(".category-browser-card").first().click();
    await portrait.locator(".category-browser-tabs .category-browser-tab").first().waitFor();
    await portrait.waitForTimeout(250);
    const chip = await box(portrait, ".category-browser-tabs .category-browser-tab");
    const chipBack = await box(portrait, ".category-browser-tabs .tag-browser-back");
    const chipAction = await box(portrait, ".browse-search-bar .browse-search-form");
    assert.ok(near(chipBack.center, chip.center) && near(chipAction.center, chip.center), JSON.stringify({ chip, chipBack, chipAction }));
    await portrait.screenshot({ path: path.join(evidence, "host-desktop-narrow-600x900.png") });
    await portraitContext.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", hasTouch: true, isMobile: true });
    const remote = await phone.newPage();
    await remote.goto(ready.baseUrl + "/remote");
    await remote.waitForFunction(() => typeof state !== "undefined" && state.data);
    if (await remote.locator("#remote-identity-input").isVisible()) {
      await remote.locator("#remote-identity-input").fill("对齐手机");
      await remote.locator("#remote-identity-submit").click();
    }
    await remote.locator('[data-remote-request-view="discover"]').first().click();
    await remote.locator(".category-browser-card").first().click();
    await remote.locator(".category-browser-tabs .category-browser-tab").first().waitFor();
    await remote.waitForTimeout(250);
    const remoteTab = await box(remote, ".category-browser-tabs .category-browser-tab");
    const remoteAction = await box(remote, ".browse-search-bar .browse-search-form");
    assert.ok(near(remoteAction.center, remoteTab.center), JSON.stringify({ remoteTab, remoteAction }));
    await remote.screenshot({ path: path.join(evidence, "remote-categories-390.png") });
    await fs.writeFile(path.join(evidence, "request-alignment.json"), JSON.stringify({ results, remoteTab, remoteAction }, null, 2), "utf8");
    console.log("PASS: request rows and category search actions share their tracks on Host and Remote");
  } finally {
    if (browser) await browser.close();
    if (ready) await fetch(ready.baseUrl + "/api/app/shutdown", { method: "POST",
      headers: { "X-Bilikara-Shutdown-Token": "fixture-private" } }).catch(() => {});
    if (server.exitCode === null) {
      const timer = setTimeout(() => server.kill("SIGKILL"), 25000);
      await once(server, "exit"); clearTimeout(timer);
    }
    lines.close(); await fs.rm(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
