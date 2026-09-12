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
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), path.resolve(video), path.resolve(audio)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {...process.env, BILIKARA_NATIVE_FIXTURE_THREE_PARTS: "1"},
  });
  const lines = createInterface({input: server.stdout});
  server.stderr.on("data", () => {});
  let browser;
  try {
    const bootstrap = JSON.parse(await Promise.race([
      once(lines, "line").then(v => v[0]),
      once(server, "exit").then(() => { throw Error("Host exited"); }),
    ])).bootstrap_url;
    browser = await chromium.launch({headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext({viewport: {width: 392, height: 817}, isMobile: true, hasTouch: true, locale: "zh-CN"});
    await context.addInitScript(() => {
      Object.defineProperty(screen.orientation, "type", {configurable: true, get: () => window.testOrientation || "portrait-primary"});
      window.exportRequests = [];
      window.BilikaraHostExport = {postMessage: value => window.exportRequests.push(JSON.parse(value))};
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
    const navigate = async name => {
      await page.locator(`#android-host-dock [data-android-page="${name}"]`).click();
      // The app correctly remembers History within this dock page. Each queue
      // assertion must explicitly select Queue after the export/history case.
      if (name === "queue") await page.locator('[data-android-workspace="queue"]').click();
    };
    const cases = {
      async historyExport() {
        await navigate("queue");
        await page.locator('[data-android-workspace="history"]').click();
        for (const [format, button, status] of [["csv", "confirm-secondary", "cancelled"], ["image", "confirm-ok", "saved"]]) {
          await page.locator("#history-export-button").click();
          await page.waitForFunction(() => state.playedSessionsLoaded);
          await page.locator("#confirm-source").selectOption("history");
          await page.locator(`#${button}`).click();
          await page.waitForFunction(() => window.exportRequests.length > 0);
          assert.equal(await page.locator(`#${button}`).isDisabled(), true);
          assert.equal(await page.locator(`#${button}`).getAttribute("aria-busy"), "true");
          const request = await page.evaluate(() => window.exportRequests.shift());
          assert.equal(request.format, format);
          assert.equal(request.source, "history");
          await page.evaluate(({id, status}) => BilikaraHostExport.onmessage({data: JSON.stringify({id, status})}), {id: request.id, status});
          await page.waitForFunction(button => !document.getElementById(button).disabled, button);
          assert.equal(await page.locator(`#${button}`).getAttribute("aria-busy"), null);
          if (status === "cancelled") await page.locator("#confirm-cancel").click();
        }
      },
      async gatchaCard() {
        await navigate("request");
        await page.locator("#android-request-random").click();
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          await page.evaluate(() => {
            state.gatchaCandidate = {bvid: "BV1z84y1p7oS", title: "歌曲标题 <script>not HTML</script>",
              url: "https://www.bilibili.com/video/BV1z84y1p7oS", cover_url: "/pic/icon.png",
              owner_name: "Test UP", preserved_1: "241", played_count: "12345"};
            state.gatchaView = "candidate";
            renderGatchaWorkspace();
          });
          const card = page.locator("#gatcha-candidate-card");
          assert.equal(await card.locator("img").count(), 1);
          assert.equal(await card.locator("img").isVisible(), true, "The actual cover must be painted, not just present in the DOM");
          await card.locator("img").scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const image = document.querySelector("#gatcha-candidate-card img");
            return image.complete && image.naturalWidth > 0;
          });
          const artwork = await card.locator("img").boundingBox();
          assert.ok(artwork.width > 150 && artwork.height > 80, "Cover has a usable rendered size");
          assert.ok(Math.abs(artwork.width / artwork.height - 16 / 9) < 0.05, "Cover keeps search's aspect ratio");
          assert.equal(await card.locator(".search-result-duration").isVisible(), true);
          assert.equal(await card.locator(".search-result-status").isVisible(), true);
          assert.equal(await card.locator(".search-result-duration").textContent(), "4:01");
          assert.ok((await card.textContent()).includes("Test UP"));
          assert.equal(await card.locator("script,button").count(), 0, "Text is escaped and Confirm remains the only add action");
          const box = await card.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width);
          await page.locator("#gatcha-confirm-button").click({trial: true});
          assert.equal(await card.evaluate(el => {
            const image = el.querySelector("img"); renderGatchaWorkspace(); return image === el.querySelector("img");
          }), true, "Playback renders do not reload the cover");
        }
        await page.evaluate(() => { state.gatchaCandidate = {title: "No artwork", bvid: "BV1z84y1p7oS"}; renderGatchaWorkspace(); });
        assert.equal(await page.locator("#gatcha-candidate-card .search-result-cover-fallback").count(), 1);
      },
      async tooltip() {
        await navigate("playback");
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          for (const id of ["host-av-sync-info", "host-key-shift-info"]) {
            await page.locator(`[aria-describedby="${id}"]`).tap();
            await page.locator(`#${id}`).waitFor({state: "visible"});
            const result = await page.locator(`#${id}`).evaluate(tooltip => {
              // Coarse-pointer tooltips are intentionally not interactive. Opt
              // into hit testing only to inspect their actual paint order.
              tooltip.style.pointerEvents = "auto";
              const rect = tooltip.getBoundingClientRect();
              const points = [0.2, 0.5, 0.8].flatMap(x => [0.3, 0.7].map(y => [rect.x + rect.width * x, rect.y + rect.height * y]));
              const covered = points.map(([x, y]) => document.elementFromPoint(x, y)).filter(el => !tooltip.contains(el));
              tooltip.style.removeProperty("pointer-events");
              return {left: rect.left, right: rect.right, covered: covered.map(el => el?.className)};
            });
            assert.ok(result.left >= 0 && result.right <= width, "Tooltip stays on screen");
            assert.deepEqual(result.covered, [], `Tooltip paints above parts and controls: ${JSON.stringify(result)}`);
            await page.locator(`[aria-describedby="${id}"]`).tap();
          }
        }
      },
      async centeredValues() {
        await navigate("playback");
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          for (const [id, values] of [["av-offset-input", ["0", "200", "-5000"]], ["key-shift-input", ["0", "-6", "6"]]]) {
            for (const [value, mode] of ["input", "render"].flatMap(mode => values.map(value => [value, mode]))) {
              const metrics = await page.evaluate(({id, value, mode}) => {
                const input = document.getElementById(id);
                const settings = structuredClone(state.data.player_settings);
                if (mode === "input") {
                  input.value = value;
                  input.dispatchEvent(new Event("input", {bubbles: true}));
                } else if (id === "av-offset-input") {
                  state.data.player_settings.av_delay.effective_delay_ms = Number(value);
                  renderAvSyncControls("local", state.data.player_settings);
                } else {
                  state.data.player_settings.key_shift = Number(value);
                  renderKeyShiftControls("local");
                }
                const field = input.parentElement.getBoundingClientRect();
                const number = input.getBoundingClientRect(), unit = input.nextElementSibling.getBoundingClientRect();
                const style = getComputedStyle(input), canvas = document.createElement("canvas").getContext("2d");
                canvas.font = style.font;
                const textWidth = canvas.measureText(value).width;
                const inkLeft = style.textAlign === "right" ? number.right - textWidth : style.textAlign === "center" ? (number.left + number.right - textWidth) / 2 : number.left;
                state.data.player_settings = settings;
                return {fieldCenter: (field.left + field.right) / 2, valueCenter: (inkLeft + unit.right) / 2,
                  left: number.left, right: unit.right, fieldLeft: field.left, fieldRight: field.right};
              }, {id, value, mode});
              assert.ok(Math.abs(metrics.fieldCenter - metrics.valueCenter) <= 1, `${id} ${value} ${mode}: value and unit centered together ${JSON.stringify(metrics)}`);
              assert.ok(metrics.left >= metrics.fieldLeft && metrics.right <= metrics.fieldRight, "Values remain inside narrow fields");
            }
          }
        }
      },
      async queueMenu() {
        await navigate("queue");
        for (const width of [320, 358, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          for (const language of ["zh", "en", "ja"]) {
            await page.evaluate(language => {
              const item = state.data.playlist[0];
              renderPlaylist([item], state.data.current_item, state.data.cache_policy);
              const texts = {zh: ["立即播放", "顶歌"], en: ["Play now", "Move next"], ja: ["今すぐ再生", "次に再生"]}[language];
              document.querySelector('#playlist [data-action="play-now"]').textContent = texts[0];
              document.querySelector('#playlist [data-action="move-next"]').textContent = texts[1];
            }, language);
            await page.locator('#playlist [data-action="toggle-menu"]').click();
            const boxes = await page.locator("#playlist .song-actions").evaluate(menu => {
              const box = el => el.getBoundingClientRect().toJSON();
              return {menu: box(menu), list: box(document.getElementById("playlist")), buttons: [...menu.children].map(box)};
            });
            for (const button of boxes.buttons) {
              assert.ok(button.left >= Math.max(0, boxes.list.left) && button.right <= Math.min(width, boxes.list.right), `Every ${language} action fits ${width}px: ${JSON.stringify(boxes)}`);
              assert.ok(button.top >= boxes.menu.top && button.bottom <= boxes.menu.bottom, "Actions stay within the menu");
            }
            for (const button of await page.locator("#playlist .song-actions button:enabled").all()) await button.click({trial: true});
            await page.locator('#playlist [data-action="toggle-menu"]').click();
          }
        }
      },
      async cache() {
        await navigate("queue");
        const ready = await page.evaluate(() => {
          const item = state.data.playlist.find(item => item.cache_status === "ready");
          if (!item) throw Error("The Rust fixture must publish a completed queue item");
          renderPlaylist([item], state.data.current_item, state.data.cache_policy);
          return {status: item.cache_status, size: item.cache_size_bytes || 0,
            label: document.querySelector("#playlist .song-size-label").textContent,
            expected: t("status.ready"), checkVisible: !document.querySelector("#playlist .song-badge-check").classList.contains("hidden")};
        });
        assert.equal(ready.size, 0, "Native snapshot has no byte-size metadata");
        assert.equal(ready.checkVisible, true);
        assert.equal(ready.label, ready.expected, "Missing size must not turn a ready cache into Pending");
        const labels = await page.evaluate(() => ({
          knownSize: cacheSizeLabelForItem({cache_status: "ready", cache_size_bytes: 1048576}),
          expectedSize: formatCompactBytes(1048576),
          failed: cacheSizeLabelForItem({cache_status: "failed"}), expectedFailed: t("status.failed"),
          pending: cacheSizeLabelForItem({cache_status: "pending"}), expectedPending: t("status.pendingCache"),
          downloading: cacheSizeLabelForItem({cache_status: "downloading", cache_progress: 25}),
        }));
        assert.equal(labels.knownSize, labels.expectedSize);
        assert.equal(labels.failed, labels.expectedFailed);
        assert.equal(labels.pending, labels.expectedPending);
        assert.equal(labels.downloading, "25%");
      },
      async queue() {
        await navigate("queue");
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          for (const requester of ["kevinx96", "非常非常长的点歌人 VeryLongRequester", ""]) {
            const metrics = await page.evaluate(requester => {
              renderQueueCurrent({...state.data.current_item, display_title: "【ニコカラ/卡拉OK】【自用】家庭教师歌曲串烧 - Long title ".repeat(4), requester_name: requester});
              const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
              return {title: rect("queue-current-title"), button: rect("next-button"), requester: rect("queue-current-requester")};
            }, requester);
            assert.ok(metrics.button.y >= metrics.title.bottom, "Skip stays below the title");
            if (requester) {
              assert.ok(Math.abs(metrics.button.y + metrics.button.height / 2 - metrics.requester.y - metrics.requester.height / 2) <= 1, `Skip aligns with the requester row: ${JSON.stringify(metrics)}`);
              assert.equal(metrics.button.height, metrics.requester.height, "Skip is the same compact pill height as the desktop-style requester badge");
              assert.ok(metrics.requester.right <= metrics.button.x, "Long requester must not overlap Skip");
            }
            const touchArea = await page.locator("#next-button").evaluate(button => {
              const rect = button.getBoundingClientRect();
              return [-7, rect.height + 7].every(y => button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + y)));
            });
            assert.ok(touchArea, "Compact Skip keeps a 44px touch area above and below its visible pill");
          }
        }
        await page.locator("#next-button").click({trial: true});
      },
      async binding() {
        await navigate("playback");
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 740});
          await page.evaluate(() => openBindingModal({}, {pages: [
            {page: 1, part: "on vocal", duration: 241},
            {page: 2, part: "off vocal 有和声", duration: 241},
            {page: 3, part: "off vocal 无和声 — a long translated title", duration: 241},
          ]}));
          const metrics = await page.locator("#binding-modal").evaluate(modal => ({
            columns: getComputedStyle(modal.querySelector(".selection-modal-grid")).gridTemplateColumns.split(" ").length,
            title: parseFloat(getComputedStyle(modal.querySelector("h2")).fontSize),
            options: [...modal.querySelectorAll(".selection-option-title")].map(el => ({font: parseFloat(getComputedStyle(el).fontSize), width: el.clientWidth})),
          }));
          assert.equal(metrics.columns, 1, "Phone binding groups stack instead of squeezing labels into two columns");
          assert.ok(metrics.title <= 20);
          for (const option of metrics.options) assert.ok(option.font >= 13 && option.font <= 14 && option.width > 180, JSON.stringify(option));
          await page.locator('#binding-audio-options input[value="3"]').check();
          assert.equal(await page.locator('#binding-video-options input[value="1"]').isChecked(), true);
          assert.equal(await page.locator('#binding-audio-options input[value="3"]').isChecked(), true);
          await page.locator("#binding-modal-confirm").click({trial: true});
          await page.screenshot({path: path.join(directory, `binding-${width}.png`)});
          await page.locator("#binding-modal-cancel").click();
        }
      },
      async variants() {
        await navigate("playback");
        assert.deepEqual(await page.evaluate(() => state.data.current_item.available_pages), [1, 2, 3],
          "The native fixture and live snapshots must retain all three available parts");
        for (const width of [320, 392, 412]) {
          await page.setViewportSize({width, height: 817});
          await page.evaluate(() => {
            renderAudioVariantBar(state.data.current_item, "local");
            syncAudioVariantOverflow();
          });
          const metrics = await page.locator(".audio-variant-list").evaluate(list => {
            const box = el => el.getBoundingClientRect().toJSON();
            return {list: box(list), buttons: [...list.children].map(box)};
          });
          assert.equal(metrics.buttons.length, 3);
          for (const button of metrics.buttons) {
            assert.ok(button.y >= metrics.list.y && button.bottom <= metrics.list.bottom + 1, "Part buttons must not be vertically clipped");
          }
          await page.locator("#audio-variant-toggle").tap();
          assert.equal(await page.locator("#audio-variant-toggle").getAttribute("aria-expanded"), "true");
          const popover = await page.locator("#audio-variant-bar").boundingBox();
          assert.ok(popover.x >= 0 && popover.x + popover.width <= width, "Expanded parts fit the phone width");
          for (const button of await page.locator(".audio-variant-button").all()) await button.click({trial: true});
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#audio-variant-toggle").getAttribute("aria-expanded"), "false");
        }
      },
      async bindingMany() {
        await navigate("playback");
        for (const [width, height] of [[320, 740], [392, 817], [412, 400]]) {
          await page.setViewportSize({width, height});
          await page.evaluate(() => openBindingModal({}, {pages: Array.from({length: 60}, (_, i) => ({
            page: i + 1, part: `僕らのLIVE 君とのLIFE — HONOKA Mix / とても長いタイトル ${i + 1}`, duration: 333,
          }))}));
          const layout = await page.locator("#binding-modal").evaluate(modal => {
            const box = el => el.getBoundingClientRect().toJSON();
            return {
              groups: [...modal.querySelectorAll(".selection-modal-column")].map(box),
              options: [...modal.querySelectorAll(".selection-option")].map(el => ({
                row: box(el), title: box(el.querySelector(".selection-option-title")), meta: box(el.querySelector(".selection-option-meta")),
              })),
              actions: box(modal.querySelector(".selection-modal-actions")),
            };
          });
          for (const {row, title, meta} of layout.options) {
            assert.ok(title.top >= row.top && meta.bottom <= row.bottom, `Long labels/durations stay inside their own row: ${JSON.stringify({row, title, meta})}`);
          }
          assert.ok(layout.groups[0].bottom <= layout.groups[1].top, "Video and audio groups do not overlap");
          assert.ok(layout.actions.bottom <= height, "Confirm/cancel stay in the viewport");
          for (const group of ["video", "audio"]) {
            const last = page.locator(`#binding-${group}-options input[value="60"]`);
            await last.scrollIntoViewIfNeeded();
            await last.check();
            assert.equal(await last.isChecked(), true, `Last ${group} part is reachable and selectable`);
          }
          assert.equal(await page.locator('#binding-video-options input[value="60"]').isChecked(), true);
          await page.locator("#binding-modal-confirm").click({trial: true});
          await page.screenshot({path: path.join(directory, `binding-many-${width}.png`)});
          await page.locator("#binding-modal-cancel").click();
        }
      },
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
