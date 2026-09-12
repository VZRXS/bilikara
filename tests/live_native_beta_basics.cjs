"use strict";
// Real native HTTP/frontend contracts, offline fixture media; never contacts D1.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");
const [exe, directory, video, audio, executablePath, check = "all"] = process.argv.slice(2);
(async () => {
  await fs.mkdir(directory, { recursive: true });
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), video, audio, "3"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: server.stdout });
  let browser;
  server.stderr.on("data", () => {});
  try {
    const first = await Promise.race([once(lines, "line").then(v => v[0]), once(server, "exit").then(() => { throw Error("Host exited during startup"); })]);
    const url = JSON.parse(first).bootstrap_url;
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ viewport: { width: 822, height: 370 }, locale: "zh-CN" });
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => state.data?.current_item?.cache_status === "ready");
    if (["all", "reorder"].includes(check)) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/playlist/reorder");
      // The return value only says whether this snapshot beat SSE. Check both
      // HTTP success and the actual ordering, even if SSE arrived first.
      await page.evaluate(() => reorderPlaylist("fixture-third", 0));
      assert.equal((await response).status(), 200);
      await page.waitForFunction(() => state.data.playlist[0]?.id === "fixture-third");
      const invalid = await page.request.post(new URL("/api/playlist/reorder", url).href, { data: { item_id: "fixture-second", index: "not-an-index" } });
      assert.equal(invalid.ok(), false, "Invalid indices must remain rejected");
    }
    if (["all", "cache"].includes(check)) {
      await page.waitForFunction(() => state.data.cache_policy.usage_bytes > 0 && state.data.cache_policy.cached_item_count === 3, null, { timeout: 5000 });
    }
    if (["all", "layout"].includes(check)) {
      await page.evaluate(() => {
        document.body.replaceChildren();
        const root = document.createElement("div");
        root.style.cssText = "position:fixed;inset:0;overflow:hidden";
        document.body.append(root);
        BilikaraPresentationRenderer.renderScene(root, { overlay: {
          visible: true, deadline: Date.now() + 60000, durationMs: 60000,
          heading: "即将播放", title: "【卡拉OK/极纯】「wi(l)d-screen baroque」Hi-Res 无损完整版",
          requester: "Singer", duration: "4:17", queueHeading: "后续点歌列表", totalText: "共 2 首",
          rows: [{ title: "Second song", requester: "Singer", duration: "3:20" }],
        } });
      });
      await page.screenshot({ path: path.join(directory, "landscape-transition.png") });
      const row = await page.locator(".player-delay-list-row").boundingBox();
      const list = await page.locator(".player-delay-list").boundingBox();
      assert.ok(list.height >= row.height && row.y + row.height <= 370, "Upcoming song must be visible, not clipped by the countdown card");
    }
    console.log(JSON.stringify({ passed: true, check }));
  } finally {
    if (browser) await browser.close();
    lines.close(); server.stdin.end("stop\n");
    if (server.exitCode === null) await once(server, "exit");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
