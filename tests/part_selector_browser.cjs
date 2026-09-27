"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const source = name => fs.readFileSync(path.join(root, "static", name), "utf8");
const host = source("app.js"), remote = source("remote.js");
const slice = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BILIKARA_TEST_BROWSER_CHANNEL || undefined });
  try {
    for (const client of ["host", "remote"]) {
      for (const width of client === "host" ? [1000, 700] : [375, 700]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.setContent(`<title>${client} part selector</title><main id="panel"><div id="body"><div class="audio-variant-anchor" id="anchor"><div class="audio-variant-bar" id="bar"></div>${client === "host" ? '<button class="audio-variant-toggle" id="toggle"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>' : ""}</div></div><div class="audio-variant-popover" id="popover" hidden></div><div id="backdrop" hidden></div></main>`);
        for (const file of [client === "host" ? "styles.css" : "remote.css", "accent-palette.css", "ui-surfaces.css"]) {
          await page.addStyleTag({ path: path.join(root, "static", file) });
        }
        await page.addStyleTag({ content: "body{margin:0;padding:20px}#panel{position:relative;height:740px;width:100%;max-width:640px;margin:auto}#body{height:100%;padding-top:300px}#anchor{width:100%}#bar{margin:0}#toggle svg{fill:none;stroke:currentColor;stroke-width:2}#popover{box-sizing:border-box}#backdrop{pointer-events:none}" });
        await page.addScriptTag({ path: path.join(root, "static/part-selector.js") });
        await page.evaluate(client => {
          window.state = { language: "zh", audioVariantBarExpanded: false, audioVariantBarItemId: "", audioVariantBarRenderSignature: "", stageControlTrayOpen: false };
          const el = id => document.getElementById(id);
          window.elements = { audioVariantBar: el("bar"), audioVariantAnchor: el("anchor"), audioVariantPopover: el("popover"), audioVariantToggle: el("toggle"), audioVariantBackdrop: el("backdrop"), playbackSheetPanel: el("panel"), playbackSheetBody: el("body") };
          window.t = key => key;
          window.partOptionsForItem = item => item.variants;
          window.selectedAudioVariantForItem = item => item.variants.find(v => v.id === item.selected) || item.variants[0];
          window.audioVariantSwitchLocked = () => false;
          window.setClassToggle = (el, name, value) => el.classList.toggle(name, value);
          window.stageControlsAreInline = () => true;
          window.closeCacheAdvancedInfo = window.setRemoteQrPinned = window.schedulePersistentStageMeasurement = () => {};
          window.playbackCssPixels = value => Number.parseFloat(value) || 0;
          const labels = ["on vocal", "off vocal", "P3 比较长的分P标题", "P4 " + "超过整行宽度的完整分P名称 ".repeat(10), ...Array.from({ length: 18 }, (_, i) => `P${i + 5} 曲目 ${"长".repeat(i % 5)}`)];
          window.item = { id: "many-parts", selected: "p1", variants: labels.map((label, i) => ({ id: `p${i + 1}`, label, page: i + 1, bound: i < 2 })) };
          window.client = client;
        }, client);
        await page.addScriptTag({ content: client === "host"
          ? slice(host, "function preferredAudioVariantPopoverDirection", "function renderAvSyncControls")
          : slice(remote, "function audioVariantPopover()", "function boundedRemoteVolumePercent") });
        await page.evaluate(() => renderAudioVariantBar(item, "local"));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const bar = await page.locator("#bar").boundingBox();
        assert(bar.height > 0 && bar.height < 60);
        assert.equal(await page.locator("#bar .audio-variant-summary").count(), 0);
        assert(await page.locator("#bar .audio-variant-button.active").isVisible());
        await page.evaluate(() => setAudioVariantPopoverOpen(true));
        await page.locator("#popover").evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        const evidence = await page.evaluate(() => {
          const pop = elements.audioVariantPopover, buttons = [...pop.querySelectorAll(".audio-variant-button")];
          const widths = buttons.map(b => b.getBoundingClientRect().width);
          const long = buttons[3].querySelector(".audio-variant-button-label");
          const text = long.querySelector(".audio-variant-button-text");
          window.savedToggle = client === "host" ? elements.audioVariantToggle : elements.audioVariantBar.querySelector(".audio-variant-toggle");
          window.savedText = text;
          pop.scrollTop = 30;
          return { widths, popup: pop.getBoundingClientRect().toJSON(), clientWidth: pop.clientWidth, scrollWidth: pop.scrollWidth, longOverflow: text.scrollWidth > long.clientWidth, animation: getComputedStyle(text).animationName, scrolling: pop.scrollTop > 0 };
        });
        assert(Math.max(...evidence.widths) - Math.min(...evidence.widths) > 40, "pills must use their natural widths");
        assert(evidence.scrollWidth <= evidence.clientWidth + 1, "no horizontal popup overflow");
        assert(evidence.longOverflow && evidence.animation === "part-label-scroll", "full-row long labels must scroll instead of ellipsis");
        assert(evidence.scrolling, "many rows remain vertically scrollable");
        for (let i = 0; i < 8; i++) {
          await page.evaluate(() => renderAudioVariantBar({ ...item, progress: Math.random() }, "local"));
          await page.waitForTimeout(40);
        }
        assert(await page.evaluate(() => savedToggle === (client === "host" ? elements.audioVariantToggle : elements.audioVariantBar.querySelector(".audio-variant-toggle"))), "progress updates must preserve the arrow node");
        assert(await page.evaluate(() => savedText === elements.audioVariantPopover.querySelectorAll(".audio-variant-button-text")[3]), "progress updates must preserve label animation");
        assert(await page.evaluate(() => elements.audioVariantPopover.scrollTop > 0), "progress updates preserve reading position");
        if (process.env.BILIKARA_TEST_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.BILIKARA_TEST_SCREENSHOT_DIR, { recursive: true });
          await page.evaluate(() => { elements.audioVariantPopover.scrollTop = 0; });
          await page.screenshot({ path: path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR, `parts-${client}-${width}.png`) });
        }
        const close = await page.evaluate(() => {
          const p = elements.audioVariantPopover;
          const before = p.style.width;
          setAudioVariantPopoverOpen(false);
          return { before, during: p.style.width };
        });
        assert.equal(close.during, close.before, "exit must retain popup geometry");
        await page.waitForFunction(() => !elements.audioVariantPopover.style.width);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.evaluate(() => setAudioVariantPopoverOpen(true));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.equal(await page.evaluate(() => getComputedStyle(elements.audioVariantPopover.querySelectorAll(".audio-variant-button-text")[3]).animationName), "none");
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    // Use the shipped menu markup and all surface styles to catch occupied
    // heights differing from button hit boxes (negative-margin regressions).
    const menu = await browser.newPage({ viewport: { width: 375, height: 550 } });
    const markup = source("remote.html");
    const start = markup.indexOf('          <div\n            id="remote-menu-panel"');
    await menu.setContent(markup.slice(start, markup.indexOf("</header>", start)));
    for (const file of ["remote.css", "accent-palette.css", "ui-surfaces.css"]) {
      await menu.addStyleTag({ path: path.join(root, "static", file) });
    }
    await menu.addStyleTag({ content: "#remote-menu-panel{position:relative;top:16px;right:auto;margin:0 auto}" });
    await menu.evaluate(() => document.querySelector("#remote-menu-panel").classList.remove("hidden"));
    const rows = await menu.evaluate(() => ["#remote-connection-status-row", ".remote-menu-qr-section", ".remote-menu-settings-section"].map(selector => {
      const row = document.querySelector(selector), box = row.getBoundingClientRect();
      const button = row.querySelector("button").getBoundingClientRect();
      return { height: box.height, contained: button.top >= box.top && button.bottom <= box.bottom };
    }));
    assert.deepEqual(rows.map(row => row.height), [44, 44, 44]);
    assert(rows.every(row => row.contained), "menu hit boxes must stay within their own rows");
    const overlap = await menu.evaluate(() => {
      const panel = document.querySelector("#remote-menu-panel");
      const header = document.createElement("header");
      header.className = "remote-header";
      panel.before(header);
      header.append(panel);
      const toggle = document.createElement("button");
      toggle.className = "remote-menu-toggle";
      toggle.setAttribute("aria-expanded", "true");
      header.append(toggle);
      const dock = document.createElement("button");
      dock.className = "playback-dock";
      dock.style.cssText = "left:0;right:0;bottom:0;height:100px";
      document.body.append(dock);
      panel.style.cssText = "position:fixed;top:auto;bottom:16px;right:16px";
      const rect = panel.getBoundingClientRect();
      const x = rect.left + 50, y = rect.bottom - 20;
      const opened = panel.contains(document.elementFromPoint(x, y));
      toggle.setAttribute("aria-expanded", "false");
      return { opened, closed: dock === document.elementFromPoint(x, y) };
    });
    assert(overlap.opened && overlap.closed, "open menus must cover the playback dock without permanently raising the header");
    await menu.close();
    console.log("Part selector checks passed: natural widths, long-label scrolling, stable arrows/scroll, retained exit geometry, Host/Remote and reduced motion.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
