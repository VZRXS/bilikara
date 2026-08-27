"use strict";

const { chromium } = require("playwright");

const [baseUrl, executablePath, screenshotPath] = process.argv.slice(2);

function assert(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/lark/search?**", (route) => {
    const items = Array.from({ length: 36 }, (_, index) => ({
      bvid: `BVHOSTUI${index}`,
      title: `Host UI result ${index}`,
      url: `https://www.bilibili.com/video/BVHOSTUI${index}`,
      owner_name: "Host UI owner",
      played_count: 1000 + index,
      rank: 4.5,
    }));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { items } }),
    });
  });

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const identity = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyTextLength: String(document.body?.innerText || "").trim().length,
      frameworkOverlay: Boolean(document.querySelector(
        "nextjs-portal, vite-error-overlay, #webpack-dev-server-client-overlay",
      )),
    }));
    assert(identity.url === `${baseUrl}/`, "browser opened the wrong Host page", identity);
    assert(identity.title && identity.bodyTextLength > 0, "Host page was blank", identity);
    assert(!identity.frameworkOverlay, "Host page showed a framework error overlay", identity);

    await page.evaluate(() => {
      document.querySelector("#lark-search-query").value = "host ui";
      document.querySelector("#lark-search-form").dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForSelector("#lark-search-results .search-result-item");
    await page.click("#search-expand-button");
    const results = page.locator("#lark-search-results");
    await results.locator(".search-result-item").first().evaluate((card) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "host-ui-wheel-control";
      button.textContent = "Control";
      card.querySelector(".search-result-meta")?.appendChild(button);
    });

    const wheelScrollTop = {};
    for (const selector of [
      ".search-result-cover",
      ".search-result-title",
      ".search-result-status",
      ".host-ui-wheel-control",
    ]) {
      await results.evaluate((element) => { element.scrollTop = 0; });
      await results.locator(selector).first().hover();
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(60);
      wheelScrollTop[selector] = await results.evaluate((element) => element.scrollTop);
      assert(wheelScrollTop[selector] > 0, `wheel did not scroll over ${selector}`, wheelScrollTop);
    }

    await results.evaluate((element) => { element.scrollTop = 0; });
    const firstCard = await results.locator(".search-result-item").first().boundingBox();
    const secondCard = await results.locator(".search-result-item").nth(1).boundingBox();
    assert(firstCard && secondCard, "expanded result cards were not laid out");
    await page.mouse.move(
      (firstCard.x + firstCard.width + secondCard.x) / 2,
      firstCard.y + 40,
    );
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(60);
    wheelScrollTop.gap = await results.evaluate((element) => element.scrollTop);
    assert(wheelScrollTop.gap > 0, "wheel did not scroll over the results grid gap", wheelScrollTop);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".search-modal-sidebar").hover();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(60);
    const backgroundScrollTop = await page.evaluate(() => window.scrollY);
    assert(backgroundScrollTop === 0, "expanded search allowed background page scrolling", {
      backgroundScrollTop,
    });

    await results.evaluate((element) => { element.scrollTop = 0; });
    const opener = results.locator(".search-result-item").first();
    await opener.click();
    const detail = page.locator(".song-detail-view");
    await detail.waitFor({ state: "visible" });
    await detail.locator(".song-detail-title").click();
    assert(await detail.isVisible(), "clicking detail card content closed detail");
    await detail.locator(".song-detail-cover").click();
    assert(await detail.isVisible(), "clicking the detail cover closed detail");
    const detailBox = await detail.boundingBox();
    assert(detailBox, "song detail did not have a rendered surface");
    await page.mouse.click(detailBox.x + 5, detailBox.y + 5);
    await page.waitForTimeout(250);
    const detailHidden = await detail.evaluate((element) => element.classList.contains("hidden"));
    assert(detailHidden, "blank song-detail backdrop click did not close detail");
    assert(
      await page.locator("#search-modal").evaluate((element) => !element.classList.contains("hidden")),
      "closing detail also closed expanded search",
    );
    assert(
      await opener.evaluate((element) => document.activeElement === element),
      "detail close did not restore focus to its result card",
    );

    await opener.click();
    await detail.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.activeElement?.matches("[data-song-detail-close]"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden")),
      "Escape did not close song detail",
    );
    assert(
      await page.locator("#search-modal").evaluate((element) => !element.classList.contains("hidden")),
      "Escape on detail closed expanded search",
    );

    await opener.click();
    await detail.waitFor({ state: "visible" });
    await detail.locator("[data-song-detail-close]").click();
    await page.waitForTimeout(250);
    assert(
      await detail.evaluate((element) => element.classList.contains("hidden")),
      "explicit detail close button did not close detail",
    );

    assert(pageErrors.length === 0, "unexpected page errors", pageErrors);
    assert(consoleErrors.length === 0, "unexpected console errors", consoleErrors);
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    return {
      passed: true,
      identity,
      wheelScrollTop,
      backgroundScrollTop,
      detailHidden,
      consoleErrors,
      pageErrors,
      screenshotPath: screenshotPath || "",
    };
  } finally {
    await browser.close();
  }
}

run().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  (error) => {
    process.stdout.write(`${JSON.stringify({
      passed: false,
      error: error.message,
      detail: error.detail,
      stack: error.stack,
    })}\n`);
    process.exitCode = 1;
  },
);
