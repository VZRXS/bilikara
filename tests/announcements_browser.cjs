"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const start = source.indexOf('  <div class="selection-modal hidden" id="announcements-modal"');
const modal = source.slice(start, source.indexOf('  <script src="/pitch-player.js"', start));
const button = source.match(/<button[^>]*id="announcements-button"[^>]*>[\s\S]*?<\/button>/)[0];
const messages = JSON.parse(fs.readFileSync(path.join(root, "static/i18n.json"), "utf8")).languages;
const sample = JSON.parse(fs.readFileSync(path.join(root, "announcements/example.json"), "utf8")).announcements;

async function setup(browser, viewport, options = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [], network = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => network.push(request.url()));
  await page.setContent(`<main id="underlying">${button}<video id="player"></video><input id="draft" value="unchanged"></main>${modal}`);
  for (const match of source.matchAll(/<link rel="stylesheet" href="\/([^"?]+)"/g)) {
    await page.addStyleTag({ path: path.join(root, "static", match[1]) });
  }
  await page.addScriptTag({ path: path.join(root, "static/announcements.js") });
  await page.evaluate(({ items, messages, options }) => {
    window.calls = []; window.bridge = []; window.allowOpen = !options.blocked; window.lang = "zh";
    window.mediaBefore = document.getElementById("player");
    window.feed = {
      available: true, items: items.map(item => ({ ...item, expired: false })),
      automatic_ids: items.map(item => item.id),
    };
    window.board = BilikaraAnnouncementView.create({
      document, ready: () => true, canOpen: () => window.allowOpen,
      language: () => window.lang, t: key => messages[window.lang][key] || key,
      windowBridge: () => ({ postMessage: message => window.bridge.push(message) }),
      request: async (url, body) => {
        window.calls.push({ url, body });
        if (url.endsWith("/shown")) {
          if (options.ackSlow) await new Promise(resolve => { window.acknowledge = resolve; });
          window.feed.automatic_ids = [];
          return { saved: true };
        }
        if (options.slow) await new Promise(resolve => { window.resolveCheck = resolve; });
        return window.feed;
      },
    });
  }, { items: sample, messages, options });
  return { page, errors, network };
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BILIKARA_TEST_BROWSER_CHANNEL || undefined });
  try {
    for (const viewport of [{ width: 360, height: 740 }, { width: 900, height: 640 }, { width: 740, height: 360 }]) {
      const { page, errors, network } = await setup(browser, viewport, { blocked: true, ackSlow: true });
      await page.evaluate(() => board.sync());
      assert.equal(await page.evaluate(() => calls.length), 0, "startup choice/modal defers the check");
      await page.evaluate(() => {
        allowOpen = true;
        feed.items[0].body_markdown.zh = "# 内容\n" + "- 一段较长的公告。\n".repeat(80);
        void board.sync();
      });
      await page.waitForFunction(() => typeof acknowledge === "function");
      await page.locator(".announcement-card").evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)));
      const closeBefore = await page.locator("#announcements-close").boundingBox();
      assert.notEqual(await page.locator("#announcements-close .close-icon").evaluate(el => getComputedStyle(el).stroke), "none", "the close glyph must remain visible");
      const card = await page.locator(".announcement-card").boundingBox();
      assert(card.x >= 0 && card.y >= 0 && card.x + card.width <= viewport.width + 1 && card.y + card.height <= viewport.height + 1);
      const scrolled = await page.locator("#announcements-content").evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
      assert(scrolled > 0, "long batches scroll");
      assert.deepEqual(await page.locator("#announcements-close").boundingBox(), closeBefore, "close stays fixed");
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("announcements-backdrop")).backdropFilter), "none");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => board.isOpen()), false, "Escape works during acknowledgement");
      assert.equal(await page.evaluate(() => document.getElementById("underlying").inert), false);
      await page.evaluate(() => { acknowledge(); });
      await page.evaluate(() => board.sync());
      assert.equal(await page.evaluate(() => calls.filter(c => c.url.endsWith("/check")).length), 1);
      assert.equal(await page.evaluate(() => mediaBefore === document.getElementById("player")), true);
      assert.equal(await page.locator("#draft").inputValue(), "unchanged");
      assert.deepEqual(await page.evaluate(() => bridge), ["announcements-open", "announcements-close"]);
      assert.deepEqual(errors, []); assert.deepEqual(network, []);
      if (process.env.BILIKARA_TEST_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.BILIKARA_TEST_SCREENSHOT_DIR, { recursive: true });
        await page.evaluate(() => { void board.manual(); });
        await page.waitForFunction(() => board.isOpen());
        await page.locator(".announcement-item").first().waitFor();
        await page.screenshot({ path: path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR, `announcements-${viewport.width}.png`) });
        await page.evaluate(() => { acknowledge(); board.close(); });
      }
      await page.close();
    }
    {
      const { page, errors } = await setup(browser, { width: 360, height: 740 }, { slow: true });
      await page.evaluate(() => { void board.manual(); void board.manual(); });
      await page.waitForFunction(() => typeof resolveCheck === "function");
      assert.equal(await page.locator("#announcements-button").getAttribute("aria-busy"), "true");
      assert.equal(await page.locator("#announcements-button").isDisabled(), true);
      await page.locator("#announcements-close").click();
      await page.evaluate(() => resolveCheck());
      await page.waitForFunction(() => !document.getElementById("announcements-button").disabled);
      assert.equal(await page.evaluate(() => calls.length), 1, "closing while loading must not mark unseen content");
      assert.equal(await page.evaluate(() => board.isOpen()), false, "late response must not reopen a dismissed panel");
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const { page, errors, network } = await setup(browser, { width: 360, height: 740 });
      await page.evaluate(() => {
        feed.automatic_ids = [];
        feed.error = "announcement_network";
        feed.items[1].expired = true;
        feed.items[0].title.zh = '<img src="https://example.invalid/x" onerror="alert(1)">';
        feed.items[0].body_markdown.zh = '<script>window.compromised = 1</script>\n\n[bad](javascript:alert(1))\n\n[broken](http://%)\n\n**安全** `code` [文档](https://example.com/)';
      });
      await page.evaluate(() => board.sync());
      assert.equal(await page.evaluate(() => board.isOpen()), false);
      await page.evaluate(() => board.manual());
      assert.equal(await page.locator("#announcements-content img, #announcements-content script").count(), 0);
      assert.equal(await page.locator("#announcements-content a").count(), 1);
      assert.equal(await page.locator("#announcements-content a").getAttribute("rel"), "noopener noreferrer");
      assert.equal(await page.locator(".announcement-kind").last().textContent(), messages.zh["announcements.ended"]);
      assert.equal(await page.locator("#announcements-status").textContent(), messages.zh["announcements.cached"]);
      await page.locator("#announcements-content a").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "announcements-close");
      await page.evaluate(() => { lang = "ja"; document.dispatchEvent(new CustomEvent("bilikara:i18n")); });
      assert.equal(await page.locator("#announcements-title").textContent(), messages.ja["announcements.title"]);
      await page.locator("#announcements-close").click();
      assert.deepEqual(errors, []); assert.deepEqual(network, []); await page.close();
    }
    console.log("Announcement browser checks passed: portrait/desktop/landscape, scrolling, dismissal, busy guards, once-only batch, focus, safe Markdown, localization, unchanged media/drafts; no network.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
