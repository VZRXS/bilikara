"use strict";
// Real Host DOM, Rust state and local media; never contact Bilibili or D1.
// node tests/live_android_controls.js EXE PRIVATE_DIR VIDEO AUDIO CHROME [CASE]
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, video, audio, executablePath, selected = "all"] = process.argv.slice(2);

(async () => {
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), path.resolve(video), path.resolve(audio)], {stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: server.stdout});
  server.stderr.on("data", () => {});
  let browser;
  try {
    const bootstrap = JSON.parse(await Promise.race([
      once(lines, "line").then(v => v[0]),
      once(server, "exit").then(() => { throw Error("Host exited"); }),
    ])).bootstrap_url;
    browser = await chromium.launch({headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext({viewport: {width: 392, height: 817}, isMobile: true, hasTouch: true});
    await context.addInitScript(() => {
      Object.defineProperty(screen.orientation, "type", {configurable: true, get: () => window.testOrientation || "portrait-primary"});
    });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (/^\/api\/(d1|lark|gatcha)/.test(url.pathname)) return route.fulfill({json: {ok: true, data: {items: [], tags: [], has_more: false}}});
      if (url.pathname.startsWith("/api/bbdown/login/")) return route.abort();
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(bootstrap);
    await page.waitForFunction(() => window.BilikaraAndroidHost?.isPortrait() && state.data?.current_item?.cache_status === "ready");
    const navigate = name => page.locator(`#android-host-dock [data-android-page="${name}"]`).click();
    const cases = {
      async settings() {
        await navigate("my");
        for (const id of ["cache-settings", "cache-panel"]) {
          const style = await page.locator(`#${id}`).evaluate(el => {
            const style = getComputedStyle(el);
            return {shadow: style.boxShadow, blur: style.backdropFilter, border: style.borderWidth};
          });
          assert.deepEqual(style, {shadow: "none", blur: "none", border: "0px"}, "Embedded download settings do not retain the desktop floating frame");
        }
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          const headings = await page.evaluate(() => ["android-account-title", "android-download-settings-title", "android-open-settings"].map(id => {
            const node = document.getElementById(id);
            const heading = id === "android-open-settings" ? node.querySelector("strong") : node;
            const card = id === "android-open-settings" ? node : node.parentElement;
            const style = getComputedStyle(heading);
            return {font: style.fontSize, weight: style.fontWeight, inset: heading.getBoundingClientRect().left - card.getBoundingClientRect().left};
          }));
          for (const heading of headings.slice(1)) {
            assert.equal(heading.font, headings[0].font, "My card headings have the same size");
            assert.equal(heading.weight, headings[0].weight, "My card headings have the same weight");
            assert.ok(Math.abs(heading.inset - headings[0].inset) <= 1, "All headings sit inside their card");
          }
          for (const id of ["advance-delay-field", "cache-source-row"]) {
            assert.equal(await page.locator(`#${id}`).evaluate(el => !!el.closest("#android-settings-slot")), true, `${id} belongs in My, not nested Settings`);
            await page.locator(`#${id}`).scrollIntoViewIfNeeded();
            assert.equal(await page.locator(`#${id}`).isVisible(), true);
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        }
        await page.locator("#android-open-settings").click();
        assert.equal(await page.locator("#diagnostic-copy-button").isVisible(), true);
        assert.equal(await page.locator("#advance-delay-field").isVisible(), false);
        await page.locator("#android-settings-back").click();
        await page.evaluate(() => { window.testOrientation = "landscape-primary"; screen.orientation.dispatchEvent(new Event("change")); });
        assert.equal(await page.locator("#advance-delay-field").evaluate(el => !!el.closest("#cache-panel")), true, "Landscape restores the existing settings tree");
        await page.evaluate(() => { window.testOrientation = "portrait-primary"; screen.orientation.dispatchEvent(new Event("change")); });
        await page.locator("#android-my-page").evaluate(el => { el.scrollTop = 0; });
      },
    };
    assert.ok(selected === "all" || cases[selected], `Unknown case ${selected}`);
    for (const [name, run] of Object.entries(cases)) {
      if (selected !== "all" && selected !== name) continue;
      await run();
      await page.screenshot({path: path.join(directory, `${name}.png`)});
      console.log(`PASS Android controls: ${name}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    const exited = once(server, "exit");
    server.stdin.end("stop\n");
    if (server.exitCode === null) await exited;
    lines.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
