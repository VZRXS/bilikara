"use strict";
// Real shared Host and Chromium touch/native media controls, with offline media.
// node tests/live_android_player_gestures.cjs EXE PRIVATE_DIR VIDEO AUDIO CHROME
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, videoPath, audioPath, executablePath] = process.argv.slice(2);

(async () => {
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), path.resolve(videoPath), path.resolve(audioPath)], {stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: server.stdout});
  server.stderr.on("data", () => {});
  let browser, page;
  try {
    const bootstrap = JSON.parse(await Promise.race([
      once(lines, "line").then(result => result[0]),
      once(server, "exit").then(() => {throw Error("Host exited");}),
    ])).bootstrap_url;
    browser = await chromium.launch({headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext({viewport: {width: 412, height: 850}, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"});
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (/^\/api\/(d1|lark|catalog|gatcha)/.test(url.pathname)) return route.fulfill({json: {ok: true, data: {items: [], tags: [], has_more: false}}});
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
    page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(bootstrap);
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.3 && window.BilikaraHostLayout);
    assert.equal(await page.evaluate(() => isAndroidNativePlaybackRuntime() && !!window.BilikaraAndroidPlayback), true,
      "The fixture must exercise Android playback, not merely a narrow desktop window");
    await page.evaluate(() => {
      window.gestureEvents = [];
      for (const type of ["click", "dblclick", "play", "pause", "seeking", "seeked", "pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "touchcancel"]) {
        document.addEventListener(type, event => {
          if (!event.target.closest?.("#player-frame")) return;
          queueMicrotask(() => {
            const video = document.querySelector("video");
            gestureEvents.push({type, detail: event.detail, target: event.target.tagName,
              prevented: event.defaultPrevented, time: performance.now(),
              paused: video.paused, seeking: video.seeking, intent: state.localShouldBePlaying, controls: video.controls,
              touching: window.BilikaraAndroidPlayback.isTouchingVideo(video),
              mediaTime: video.currentTime});
            if (gestureEvents.length > 120) gestureEvents.shift();
          });
        }, true);
      }
    });
    const touch = await context.newCDPSession(page);
    const send = (type, points) => touch.send("Input.dispatchTouchEvent", {type, touchPoints: points});
    const tap = async point => {await send("touchStart", [point]); await send("touchEnd", []);};
    const canvasPoint = async () => {
      const box = await page.locator("#player-frame video").boundingBox();
      assert.ok(box); return {x: box.x + box.width / 2, y: box.y + box.height / 3};
    };
    const playing = async expected => {
      await page.waitForFunction(expected => {
        const {video, audio} = activeLocalPlayerElements();
        return video && audio && video.paused === !expected && audio.paused === !expected && state.localShouldBePlaying === expected;
      }, expected, {timeout: 5000});
    };
    const nativeControl = async pseudo => {
      // UA shadow controls are deliberately opaque to application JavaScript.
      // CDP is used only by this test to hit the real thumb/button geometry.
      const {root} = await touch.send("DOM.getDocument", {depth: -1, pierce: true});
      const find = node => {
        const attributes = node.attributes || [];
        if (attributes.some((value, index) => index % 2 === 1 && value === pseudo)) return node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
          const match = find(child); if (match) return match;
        }
        return null;
      };
      const node = find(root); assert.ok(node, `Native control ${pseudo} is present`);
      const {model} = await touch.send("DOM.getBoxModel", {backendNodeId: node.backendNodeId});
      return {x: model.content[0], y: model.content[1], width: model.width, height: model.height};
    };
    const metrics = [];
    for (const [width, height, fullscreen] of [[412, 850, false], [1000, 600, false], [1000, 600, true]]) {
      await page.setViewportSize({width, height});
      if (fullscreen) {
        await page.locator("#player-fullscreen-button").click();
        await page.waitForFunction(() => isPlayerPanelFullscreen());
      }
      await page.locator("#player-frame video").scrollIntoViewIfNeeded();
      await playing(true);
      const start = await page.evaluate(() => document.querySelector("video").currentTime);
      await tap(await canvasPoint());
      // Wait beyond the old desktop click timer; single tap must only reveal.
      await page.waitForTimeout(650);
      await playing(true);
      assert.ok(await page.evaluate(start => document.querySelector("video").currentTime > start, start));
      assert.equal(await page.locator("#player-frame video").evaluate(video => video.controls), true);

      const point = await canvasPoint();
      await tap(point); await tap(point);
      await playing(false);
      assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), fullscreen);
      await page.waitForTimeout(650);
      await tap(point); await tap(point);
      await playing(true);
      await page.waitForTimeout(650);

      // Grab the actual native timeline, rather than assigning currentTime.
      // Chromium can dismiss its controls after the preceding double tap.
      await tap(await canvasPoint());
      await page.waitForTimeout(120);
      await playing(true);
      const track = await nativeControl("-webkit-media-controls-timeline");
      const beforeSeek = await page.evaluate(() => document.querySelector("video").currentTime);
      const duration = await page.evaluate(() => document.querySelector("video").duration);
      const targetFraction = width === 412 ? 0.45 : 0.75;
      const y = track.y + track.height / 2;
      await send("touchStart", [{x: track.x + track.width * beforeSeek / duration, y}]);
      if (width === 412 && !fullscreen) {
        await page.waitForTimeout(5200);
        assert.equal(await page.locator("#player-frame video").evaluate(video => video.controls), true,
          "The five-second auto-hide must not remove controls while the thumb is held");
      }
      for (let step = 1; step <= 6; step++) {
        await send("touchMove", [{x: track.x + track.width * (beforeSeek / duration + (targetFraction - beforeSeek / duration) * step / 6), y}]);
        await page.waitForTimeout(50);
      }
      await send("touchEnd", []);
      await page.waitForFunction(before => document.querySelector("video").currentTime > before + 5, beforeSeek);
      await playing(true);
      await page.waitForTimeout(350);
      await playing(true);
      const resumedAt = await page.evaluate(() => document.querySelector("video").currentTime);
      const pauseButton = await nativeControl("-webkit-media-controls-play-button");
      await tap({x: pauseButton.x + pauseButton.width / 2, y: pauseButton.y + pauseButton.height / 2});
      await playing(false);
      const pausedTrack = await nativeControl("-webkit-media-controls-timeline");
      const pausedY = pausedTrack.y + pausedTrack.height / 2;
      await send("touchStart", [{x: pausedTrack.x + pausedTrack.width * resumedAt / duration, y: pausedY}]);
      await send("touchMove", [{x: pausedTrack.x + pausedTrack.width * 0.2, y: pausedY}]);
      await send("touchEnd", []);
      await page.waitForFunction(before => Math.abs(document.querySelector("video").currentTime - before) > 5, resumedAt);
      await page.waitForTimeout(350);
      await playing(false);
      const playButton = await nativeControl("-webkit-media-controls-play-button");
      await tap({x: playButton.x + playButton.width / 2, y: playButton.y + playButton.height / 2});
      await playing(true);
      metrics.push({width, height, fullscreen, singleTap: "controls-only", doubleTap: "pause/resume",
        nativeSeek: resumedAt, pausedSeek: "stays-paused", nativePlayButton: "single-tap"});
      if (fullscreen) {
        await page.locator("#player-fullscreen-button").click();
        await page.waitForFunction(() => !isPlayerPanelFullscreen());
      }
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({passed: true, metrics}, null, 2));
    console.log(JSON.stringify({passed: true, metrics}));
  } catch (error) {
    if (page) await page.screenshot({path: path.join(directory, "failed.png")}).catch(() => {});
    if (page) await fs.writeFile(path.join(directory, "failed-events.json"), JSON.stringify(await page.evaluate(() => window.gestureEvents), null, 2)).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    const exited = once(server, "exit"); server.stdin.end("stop\n");
    if (server.exitCode === null) await exited;
    lines.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
