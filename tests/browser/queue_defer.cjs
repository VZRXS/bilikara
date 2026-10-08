"use strict";
// Offline interaction/geometry test using the shipped queue markup and styles.
// Rust AppState/HTTP tests cover the real mutation; this is not Android-device evidence.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "../../static");
  const markup = await fs.readFile(path.join(root, "index.html"), "utf8");
  const translations = JSON.parse(await fs.readFile(path.join(root, "i18n.json"), "utf8"));
  const evidence = process.argv[2] && path.resolve(process.argv[2]);
  if (evidence) await fs.mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  try {
    for (const [width, touch] of [[1440, false], [700, false], [700, true], [393, true]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.abort());
      await page.setContent('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>');
      // Network is blocked, so load the stylesheet imported by styles.css too.
      for (const file of ["accent-palette.css", "styles.css", "host-layout.css", "ui-surfaces.css"]) {
        await page.addStyleTag({ path: path.join(root, file) });
      }
      await page.evaluate(({ markup, phone }) => {
        if (phone) document.documentElement.dataset.hostLayout = "portrait";
        const source = new DOMParser().parseFromString(markup, "text/html");
        const panel = source.querySelector("#host-workspace-queue");
        panel.hidden = false;
        panel.inert = false;
        panel.style.cssText = "position:fixed;left:12px;top:12px;width:calc(100vw - 24px);max-width:640px;height:820px;display:flex;flex-direction:column";
        document.body.append(panel, source.querySelector("#playlist-item-template"));
        document.querySelector("#playlist").style.cssText = "overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:12px";
        document.querySelector("#queue-current").classList.remove("hidden");
        document.querySelector("#queue-current-title").textContent = "A · Current song / 当前歌曲";
        document.querySelector("#queue-current-progress-badge").classList.add("ready");
      }, { markup, phone: width < 700 });
      await page.addScriptTag({ path: path.join(root, "queue-defer.js") });
      await page.evaluate(() => {
        window.requests = []; window.outcomes = []; window.helpClicks = 0;
        window.snapshot = { current_item: { id: "a", item_incarnation_id: "i-a" }, playback_generation: 7,
          playlist: ["b", "c", "d"].map(id => ({ id })) };
        const handle = document.querySelector("#queue-current-progress-badge");
        const list = document.querySelector("#playlist");
        window.paintQueue = () => {
          list.replaceChildren(...snapshot.playlist.map((item, index) => {
            const node = document.querySelector("#playlist-item-template").content.firstElementChild.cloneNode(true);
            node.dataset.id = item.id;
            node.querySelector(".song-title").textContent = `${item.id.toUpperCase()} · Queued song`;
            node.querySelector(".song-index-label").textContent = index + 1;
            return node;
          }));
        };
        paintQueue();
        window.controller = BilikaraQueueDefer.mount({ handle, card: document.querySelector("#queue-current"), list,
          getSnapshot: () => snapshot,
          submit: payload => { requests.push(payload); return new Promise((resolve, reject) => { window.complete = resolve; window.rejectRequest = reject; }); },
          changed: () => outcomes.push("changed"), failed: error => outcomes.push(error.message),
        });
        handle.addEventListener("click", () => helpClicks++);
      });
      const handle = page.locator("#queue-current-progress-badge");
      const handleRect = await handle.boundingBox();
      assert(handleRect.width >= 44 && handleRect.height >= 44);
      assert(Math.abs(handleRect.width - handleRect.height) < 1);
      const origin = { x: handleRect.x + handleRect.width / 2, y: handleRect.y + handleRect.height / 2 };
      const target = async (id, after) => {
        const rect = await page.locator(`.song-item[data-id="${id}"]`).boundingBox();
        return { x: rect.x + rect.width / 2, y: rect.y + (after ? rect.height - 10 : 10) };
      };
      const cdp = touch ? await context.newCDPSession(page) : null;
      const down = async point => touch
        ? cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] })
        : (await page.mouse.move(point.x, point.y), page.mouse.down());
      const move = async point => touch
        ? cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, id: 1 }] })
        : page.mouse.move(point.x, point.y, { steps: 8 });
      const up = async () => touch
        ? cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }) : page.mouse.up();
      const drop = async point => { await down(origin); await move(point); await up(); };

      // Jitter is a help tap, not a reorder or next command.
      await down(origin); await move({ x: origin.x + 2, y: origin.y + 2 }); await up();
      assert.equal(await page.evaluate(() => requests.length), 0);
      assert.equal(await page.evaluate(() => helpClicks), 1);
      // Drop AFTER C => B current, waiting C/A/D, hence index 1.
      const afterC = await target("c", true);
      await down(origin); await move(afterC);
      assert.equal(await page.locator('.song-item[data-id="c"]').evaluate(e => e.classList.contains("defer-drop-after")), true);
      const insertionMarker = await page.locator('.song-item[data-id="c"]').evaluate(element => {
        const style = getComputedStyle(element, "::before");
        return { content: style.content, display: style.display, height: style.height,
          bottom: style.bottom, background: style.backgroundImage, opacity: style.opacity };
      });
      assert.equal(insertionMarker.content, '""', JSON.stringify(insertionMarker));
      assert.notEqual(insertionMarker.display, "none", JSON.stringify(insertionMarker));
      assert.equal(insertionMarker.height, "4px", JSON.stringify(insertionMarker));
      assert.equal(insertionMarker.bottom, "-2px", JSON.stringify(insertionMarker));
      assert.notEqual(insertionMarker.background, "none", JSON.stringify(insertionMarker));
      assert.equal(insertionMarker.opacity, "1", JSON.stringify(insertionMarker));
      if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${touch ? "touch" : "mouse"}.png`) });
      await up();
      await page.waitForFunction(() => requests.length === 1);
      assert.deepEqual(await page.evaluate(() => requests[0]), {
        item_id: "a", expected_item_incarnation_id: "i-a", playback_generation: 7,
        expected_playlist_item_ids: ["b", "c", "d"], index: 1,
      });
      assert.equal(await handle.getAttribute("aria-busy"), "true");
      assert.equal(await handle.isDisabled(), true);
      await drop(afterC);
      assert.equal(await page.evaluate(() => requests.length), 1, "busy gesture cannot submit twice");
      assert.equal(await page.evaluate(() => helpClicks), 1, "drag must not open help");
      await page.evaluate(() => complete());
      await page.waitForFunction(() => !document.querySelector("#queue-current-progress-badge").disabled);
      assert.equal(await handle.getAttribute("aria-busy"), null);

      // Cancel outside, Escape, capture loss, visibility interruption, and queue races.
      await drop({ x: width - 2, y: 880 });
      await down(origin); await move(afterC); await page.keyboard.press("Escape"); await up();
      await down(origin); await move(afterC);
      await page.evaluate(() => controller.cancel()); await up();
      await down(origin); await move(afterC);
      if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      else { await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await up(); }
      await down(origin); await move(afterC);
      await page.evaluate(() => { snapshot.playlist.reverse(); controller.sync(); }); await up();
      assert.equal(await page.evaluate(() => requests.length), 1);
      await page.evaluate(() => { snapshot.playlist.reverse(); controller.sync(); });
      // A progress-only revision does not invalidate the captured order.
      await down(origin); await move(await target("b", false));
      assert.equal(await page.locator('.song-item[data-id="b"]').evaluate(element =>
        getComputedStyle(element, "::before").top), "-2px");
      await page.evaluate(() => { snapshot.state_revision = 999; controller.sync(); });
      await up();
      await page.waitForFunction(() => requests.length === 2);
      assert.equal(await page.evaluate(() => requests[1].index), 0);
      await page.evaluate(() => rejectRequest(new Error("offline fixture")));
      await page.waitForFunction(() => outcomes.includes("offline fixture"));
      assert.equal(await handle.isDisabled(), false);
      // End of queue insertion and localization retain the same button/node.
      for (const language of ["en", "ja", "zh"]) {
        await handle.evaluate((element, label) => element.setAttribute("aria-label", label), translations.languages[language]["queue.deferCurrent"]);
        assert.equal(await handle.boundingBox().then(rect => rect.width), handleRect.width);
      }
      await drop(await target("d", true));
      assert.equal(await page.evaluate(() => requests[2].index), 2);
      await page.evaluate(() => complete());
      await page.waitForFunction(() => outcomes.length === 3);
      // A long queue remains reachable while the pointer is held at its edge.
      await page.evaluate(() => {
        snapshot.playlist = Array.from({ length: 30 }, (_, i) => ({ id: `queued-${i}` }));
        paintQueue(); controller.sync();
      });
      const listRect = await page.locator("#playlist").boundingBox();
      await down(origin); await move({ x: listRect.x + listRect.width / 2, y: listRect.y + listRect.height - 3 });
      await page.waitForFunction(() => document.querySelector("#playlist").scrollTop > 120);
      await page.keyboard.press("Escape"); await up();
      assert.equal(await page.evaluate(() => requests.length), 3);
      await page.evaluate(() => { snapshot.playlist = []; controller.sync(); });
      assert.equal(await handle.isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(`PASS queue defer ${width}px ${touch ? "touch" : "mouse"}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
