"use strict";
// Real native Host queue, SSE snapshots and Host/Remote pages. The only fixture
// is the network boundary: a proxy that holds connections open keeps queued
// favorite folders waiting or running, then resets them so the jobs settle.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const playwright = require("playwright");

const [binary, output, engine = "chromium"] = process.argv.slice(2);

(async () => {
  const evidence = path.resolve(output);
  await fs.mkdir(evidence, { recursive: true });
  let reset = false;
  const sockets = new Set();
  const proxy = net.createServer(socket => {
    socket.on("error", () => {});
    if (reset) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "source-placeholders-"));
  const server = spawn(path.resolve(binary), ["--headless", "--data-dir", home,
    "--static-dir", path.resolve(__dirname, "../../static")], {
    cwd: home,
    env: { ...process.env, BILIKARA_SHUTDOWN_TOKEN: "fixture-private",
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", browser, ready;
  server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  const lines = createInterface({ input: server.stdout });
  const cards = (page, grid) => page.evaluate(selector => [...document.querySelectorAll(`${selector} .follow-up-button`)]
    .map(card => ({ placeholder: card.classList.contains("source-card-placeholder"), id: card.dataset.folderId || card.dataset.uid,
      name: card.querySelector(".follow-up-name")?.textContent || "", count: card.querySelector(".follow-up-count")?.textContent || "",
      spinner: Boolean(card.querySelector(".source-card-spinner")), border: getComputedStyle(card).borderTopStyle,
      size: (box => [Math.round(box.width), Math.round(box.height)])(card.getBoundingClientRect()) })), grid);
  try {
    ready = JSON.parse(await Promise.race([
      once(lines, "line").then(value => value[0]),
      once(server, "exit").then(() => { throw Error(stderr); }),
    ]));
    browser = await playwright[engine].launch({ headless: true });
    const errors = [];
    const hostContext = await browser.newContext({ viewport: { width: 1180, height: 800 }, locale: "zh-CN" });
    const host = await hostContext.newPage();
    host.on("pageerror", error => errors.push(`host: ${error.message}`));
    await host.goto(ready.bootstrapUrl);
    await host.waitForFunction(() => typeof state !== "undefined" && state.data?.capabilities?.source_queue);
    await host.locator('[data-request-view="sources"]').first().click();
    await host.locator('[data-sources-mode="favorites"]').first().click();
    // The favlist preview is the network boundary; its success path opens this dialog.
    for (const [uid, folders] of [
      ["1001", [{ id: "11", title: "周末合唱", media_count: 30, selected: true }, { id: "12", title: "动漫经典", media_count: 12, selected: true }]],
      ["1002", [{ id: "21", title: "睡前歌单", media_count: 8, selected: true }]],
    ]) {
      await host.evaluate(([owner, list]) => openGatchaFavlistModal(owner,
        { uid: owner, folders: list, public_folder_count: list.length }, { messageTarget: "favlist-modal" }), [uid, folders]);
      await host.locator("#gatcha-favlist-modal-confirm").click();
      await host.waitForFunction(() => !state.gatchaFavlistSaving);
    }
    await host.waitForFunction(() => document.querySelectorAll("#request-sources-favorites .source-card-placeholder").length === 3,
      null, { timeout: 15000 });
    const hostCards = await cards(host, "#request-sources-favorites");
    assert.deepEqual(hostCards.map(card => [card.id, card.name, card.placeholder]), [
      ["1001:11", "周末合唱", true], ["1001:12", "动漫经典", true], ["1002:21", "睡前歌单", true],
    ]);
    assert.deepEqual(hostCards.map(card => card.spinner), [true, true, false], JSON.stringify(hostCards));
    assert.equal(hostCards[2].count, "等待拉取");
    assert.ok(hostCards.every(card => card.border === "dashed" && card.size.join() === hostCards[0].size.join()), JSON.stringify(hostCards));
    assert.equal(await host.locator("#request-sources-favorites .search-empty:visible").count(), 0);
    await host.screenshot({ path: path.join(evidence, `${engine}-host-placeholders.png`) });

    // Presentation-only check: UP jobs need a verified login to enter the queue,
    // so render the same snapshot shape synchronously with the Host's own code.
    const upCards = await host.evaluate(() => {
      const saved = state.data.gatcha.source_queue;
      state.data.gatcha.source_queue = { ...saved, active: { uid: "2001", folder_ids: null }, pending: [{ uid: "2002", folder_ids: null }] };
      window.BilikaraSourceStatus.rememberSource({ uid: "2001", title: "测试 UP" });
      state.followBrowseData = { owners: [{ uid: "2002", name: "Listed", count: 3 }], items: [] };
      state.followBrowseRenderSignature = "";
      renderFollowBrowse();
      const result = [...document.querySelectorAll("#follow-up-grid .follow-up-button")].map(card => [card.dataset.uid,
        card.querySelector(".follow-up-name").textContent, card.classList.contains("source-card-placeholder"),
        Boolean(card.querySelector(".source-card-spinner"))]);
      state.data.gatcha.source_queue = saved;
      state.followBrowseRenderSignature = "";
      renderFollowBrowse();
      return result;
    });
    assert.deepEqual(upCards, [["2001", "测试 UP", true, true], ["2002", "Listed", false, false]]);

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", hasTouch: true, isMobile: true });
    const remote = await phone.newPage();
    remote.on("pageerror", error => errors.push(`remote: ${error.message}`));
    await remote.goto(ready.baseUrl + "/remote");
    await remote.waitForFunction(() => typeof state !== "undefined" && state.data);
    if (await remote.locator("#remote-identity-input").isVisible()) {
      await remote.locator("#remote-identity-input").fill("手机用户");
      await remote.locator("#remote-identity-submit").click();
    }
    await remote.locator('[data-remote-request-view="sources"]').first().click();
    await remote.locator('[data-remote-sources-mode="favorites"]').first().click();
    await remote.waitForFunction(() => document.querySelectorAll("#favlist-grid .source-card-placeholder").length === 3,
      null, { timeout: 15000 });
    const remoteCards = await cards(remote, "#favlist-grid");
    // Titles confirmed on the Host are not queue data; the phone names folders by id.
    assert.deepEqual(remoteCards.map(card => [card.id, card.name, card.spinner]), [
      ["1001:11", "收藏夹 11", true], ["1001:12", "收藏夹 12", true], ["1002:21", "收藏夹 21", false],
    ]);
    assert.equal(remoteCards[2].count, "等待拉取");
    await remote.locator("#favlist-grid").scrollIntoViewIfNeeded();
    await remote.screenshot({ path: path.join(evidence, `${engine}-remote-placeholders.png`) });

    // Let every queued job settle; placeholders leave both clients with the queue.
    reset = true;
    for (const socket of sockets) socket.destroy();
    await host.waitForFunction(() => {
      const queue = state.data?.gatcha?.source_queue;
      return queue && !queue.active && !queue.pending?.length && queue.completed?.favorites === 2;
    }, null, { timeout: 60000 });
    await host.waitForFunction(() => !document.querySelector("#request-sources-favorites .source-card-placeholder"), null, { timeout: 15000 });
    await remote.waitForFunction(() => !document.querySelector("#favlist-grid .source-card-placeholder"), null, { timeout: 15000 });
    await host.screenshot({ path: path.join(evidence, `${engine}-host-settled.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS: ${engine} queued sources show placeholders on Host and Remote until their jobs settle`);
  } finally {
    if (browser) await browser.close();
    if (ready) await fetch(ready.baseUrl + "/api/app/shutdown", { method: "POST",
      headers: { "X-Bilikara-Shutdown-Token": "fixture-private" } }).catch(() => {});
    if (server.exitCode === null) {
      const timer = setTimeout(() => server.kill("SIGKILL"), 25000);
      await once(server, "exit"); clearTimeout(timer);
    }
    for (const socket of sockets) socket.destroy();
    proxy.close();
    lines.close(); await fs.rm(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
