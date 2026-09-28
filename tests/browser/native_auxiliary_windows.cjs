"use strict";
// Real native HTTP authentication/assets and browser cookie behavior. Only the
// OS display/session bridge is a fixture; no Host cookies are pre-installed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const playwright = require("playwright");

const [binary, output, engine = "chromium"] = process.argv.slice(2);
(async () => {
  const evidence = path.resolve(output);
  await fs.mkdir(evidence, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "auxiliary-window-"));
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
    browser = await playwright[engine].launch({ headless: true });
    const anonymous = await browser.newContext();
    const before = await anonymous.newPage();
    const rejected = await before.goto(ready.baseUrl + "/controller.html?presentationGeneration=42");
    assert.equal(rejected.status(), 403);
    assert.match(await before.locator("body").innerText(), /forbidden/);
    await before.screenshot({ path: path.join(evidence, `${engine}-unauthenticated.png`) });
    await anonymous.close();

    const results = [];
    for (const [pageName, query, document] of [
      ["controller", "presentationGeneration=42", "controller.html"],
      ["display-identifier", "number=2&theme=dark&language=ja&role=audience", "display-identifier.html"],
    ]) {
      const context = await browser.newContext({ viewport: { width: 960, height: 600 }, locale: "zh-CN" });
      assert.deepEqual(await context.cookies(), []);
      await context.addInitScript(() => {
        window.bridgeCalls = [];
        const session = { mode: "localDualScreen", phase: "activating", generation: 42,
          playbackAuthority: "host", mediaRendererOwner: "host", controllerReady: false };
        window.__TAURI__ = {
          core: { invoke: async name => {
            window.bridgeCalls.push(name);
            if (name === "mark_presentation_controller_ready") {
              session.phase = "active"; session.controllerReady = true;
            } else if (name !== "get_presentation_session") throw Error(`Unexpected command: ${name}`);
            return { ...session };
          } },
          event: { listen: async () => () => {} },
        };
      });
      const page = await context.newPage(), errors = [], failedResponses = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
      });
      await page.goto(ready.bootstrapUrl + "?page=" + pageName + "&" + query);
      await page.waitForURL(url => url.pathname === "/" + document);
      if (pageName === "controller") {
        await page.waitForFunction(() => window.bridgeCalls.includes("mark_presentation_controller_ready"));
        assert.equal(await page.title(), "Bilikara Stage");
        assert.equal(await page.locator("#controller-exit").isEnabled(), true);
        assert.equal(await page.locator("#controller-unavailable").isVisible(), false);
      } else {
        await page.waitForFunction(() => document.querySelector("#display-identifier-number").textContent === "2");
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        assert.equal(await page.locator("html").getAttribute("lang"), "ja");
      }
      assert.equal(new URL(page.url()).searchParams.get("presentationGeneration"), pageName === "controller" ? "42" : null);
      const cookie = (await context.cookies()).find(item => item.name === "bilikara_native");
      assert.ok(cookie.httpOnly); assert.equal(cookie.sameSite, "Strict");
      assert.equal(await page.evaluate(() => document.cookie.includes("bilikara_native")), false);
      assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []);
      await page.screenshot({ path: path.join(evidence, `${engine}-${pageName}.png`) });
      await page.reload();
      if (pageName === "controller") await page.waitForFunction(() => window.bridgeCalls.includes("mark_presentation_controller_ready"));
      else await page.waitForFunction(() => document.querySelector("#display-identifier-number").textContent === "2");
      assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []);
      results.push({ page: pageName, freshCookieJar: true, strictHttpOnly: true, reload: true, errors });
      await context.close();
    }
    await fs.writeFile(path.join(evidence, `${engine}-results.json`), JSON.stringify({ engine, results }, null, 2), "utf8");
    console.log(`PASS: ${engine} fresh auxiliary windows authenticate, render and reload`);
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
