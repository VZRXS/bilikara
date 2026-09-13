"use strict";
// Real Rust preferences + Host DOM, across fresh processes and browser origins.
// Signed-out isolated profiles and offline catalog routes: no Bilibili/D1 calls.
// node tests/live_native_language.js EXE NEW_PRIVATE_DIR CHROME
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const {chromium} = require("playwright");
const [exe, directory, executablePath] = process.argv.slice(2);

async function withHost(browser, profile, locale, check) {
  const server = spawn(exe, [profile, path.resolve("static")], {stdio: ["pipe", "pipe", "pipe"]});
  server.stderr.on("data", () => {});
  const lines = createInterface({input: server.stdout});
  let context, timer;
  try {
    const bootstrap = JSON.parse(await Promise.race([
      once(lines, "line").then(value => value[0]),
      once(server, "exit").then(() => {throw Error("Host exited before bootstrap");}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error("Host bootstrap timeout")), 10000);}),
    ])).bootstrap_url;
    clearTimeout(timer);
    assert.equal(new URL(bootstrap).hostname, "127.0.0.1");
    context = await browser.newContext({viewport: {width: 392, height: 817}, isMobile: true, hasTouch: true, locale});
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
    await page.waitForFunction(() => state.translationsLoaded && state.data && BilikaraAndroidHost.isPortrait());
    await check(page, context);
    assert.deepEqual(errors, []);
  } finally {
    clearTimeout(timer);
    if (context) await context.close();
    lines.close();
    server.stdin.end("stop\n");
    if (server.exitCode === null) await once(server, "exit");
  }
}

(async () => {
  // Never reuse a real profile; mkdir without recursive must fail if it exists.
  await fs.mkdir(path.dirname(path.resolve(directory)), {recursive: true});
  await fs.mkdir(directory);
  const browser = await chromium.launch({headless: true, executablePath});
  try {
    for (const [locale, expected] of [["en-US", "en"], ["ja-JP", "ja"], ["zh-TW", "zh"]]) {
      const profile = path.resolve(directory, expected);
      await fs.mkdir(profile);
      const saved = async () => JSON.parse(await fs.readFile(path.join(profile, "native-preferences.json"), "utf8"));
      await withHost(browser, profile, locale, async page => {
        assert.equal(await page.evaluate(() => state.language), expected);
        assert.equal((await saved()).language, expected, "First launch persists without manual selection");
      });
      // New process, empty browser storage, different system locale.
      await withHost(browser, profile, expected === "en" ? "ja-JP" : "en-US", async (page, context) => {
        assert.equal(await page.evaluate(() => state.language), expected);
        await page.locator('#android-host-dock [data-android-page="my"]').click();
        await page.locator("#android-open-settings").click();
        const next = expected === "en" ? "zh" : "en";
        let release, entered, writes = 0;
        const blocked = new Promise(resolve => {release = resolve;});
        const waiting = new Promise(resolve => {entered = resolve;});
        await context.route("**/api/ui-language", async route => {
          if (route.request().method() === "POST") {writes++; entered(); await blocked;}
          await route.continue();
        });
        const button = page.locator(`#language-switch [data-language="${next}"]`);
        await button.click();
        await waiting;
        assert.equal(await button.isDisabled(), true);
        assert.equal(await button.getAttribute("aria-busy"), "true");
        await page.locator('#language-switch [data-language="ja"]').dispatchEvent("click");
        assert.equal(writes, 1, "Second activation cannot create a concurrent language write");
        release();
        await page.waitForFunction(language => state.language === language, next);
        await page.waitForFunction(() => !document.querySelector("#language-switch button").disabled);
        assert.equal(await button.getAttribute("aria-busy"), null);
        assert.equal((await saved()).language, next);
        await context.unroute("**/api/ui-language");
        await context.route("**/api/ui-language", route => route.fulfill({status: 503, json: {ok: false}}));
        await page.locator(`#language-switch [data-language="${expected}"]`).click();
        await page.waitForFunction(() => !document.querySelector("#language-switch button").disabled);
        assert.equal(await page.evaluate(() => state.language), next, "Failed save keeps visible language");
        assert.equal((await saved()).language, next);
        await page.screenshot({path: path.join(profile, "language.png")});
      });
      await withHost(browser, profile, locale, async page => {
        assert.equal(await page.evaluate(() => state.language), expected === "en" ? "zh" : "en", "Explicit choice survives another restart");
      });
    }
  } finally {await browser.close();}
  console.log("PASS real native Host: en/ja/zh first launch, 9 processes with fresh origins, durable explicit choice, busy/duplicate guard and failed-save preservation; offline");
})().catch(error => {console.error(error); process.exitCode = 1;});
