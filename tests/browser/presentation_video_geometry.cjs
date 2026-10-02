"use strict";
// Real audience HTML/CSS/video layout; only the desktop shell bridge is mocked.
// The browser records its own offline portrait/landscape fixtures, so no media
// download, codec executable, product dependency or physical display is needed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "../../static");
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const content = await fs.readFile(file);
      const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" }[path.extname(file)];
      response.writeHead(200, { "Content-Type": type || "application/octet-stream" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      const listeners = new Map();
      window.geometryCalls = [];
      window.failGeometryLog = false;
      window.__emit = (name, payload) => { for (const fn of listeners.get(name) || []) fn({ payload }); };
      window.__TAURI__ = {
        core: { invoke: async (name, args) => {
          if (name === "record_presentation_video_geometry") {
            window.geometryCalls.push(args);
            if (window.failGeometryLog) throw Error("diagnostics unavailable");
            return;
          }
          if (name === "request_presentation_output_state") { window.outputReady = true; return; }
          if (name === "get_presentation_session") return { mode: "localDualScreen", phase: "active", generation: 42,
            controllerReady: true, playbackAuthority: "host", mediaRendererOwner: "host" };
          throw Error(`Unexpected shell command: ${name}`);
        } },
        event: { listen: async (name, callback) => {
          if (!listeners.has(name)) listeners.set(name, []);
          listeners.get(name).push(callback);
          return () => listeners.set(name, listeners.get(name).filter(fn => fn !== callback));
        } },
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/controller.html?presentationGeneration=42`);
    await page.waitForFunction(() => window.outputReady);
    await page.evaluate(async () => {
      window.mediaFixtures = [];
      for (const [width, height] of [[360, 640], [1920, 480]]) {
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const painter = canvas.getContext("2d");
        painter.fillStyle = "#00c889"; painter.fillRect(0, 0, width, height);
        painter.fillStyle = "#ef5350"; painter.fillRect(0, 0, width, 20); painter.fillRect(0, height - 20, width, 20);
        const stream = canvas.captureStream(10);
        const chunks = [], recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
        recorder.ondataavailable = event => chunks.push(event.data);
        const finished = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start();
        painter.fillRect(0, 0, width, 20);
        stream.getVideoTracks()[0].requestFrame();
        await new Promise(resolve => setTimeout(resolve, 250));
        recorder.stop(); await finished;
        stream.getTracks().forEach(track => track.stop());
        window.mediaFixtures.push(URL.createObjectURL(new Blob(chunks, { type: "video/webm" })));
      }
      window.sendScene = (index, sequence) => {
        window.__emit("bilikara-presentation-output-state", window.BilikaraPresentationSync.makeEnvelope("master-state", {
          scene: { generation: 42, revision: index + 1, currentItemIdentity: `fixture-${index}`, videoUrl: window.mediaFixtures[index], theme: "dark" },
          clock: { itemIdentity: `fixture-${index}`, paused: true, mediaTime: 0, sampledAt: Date.now() },
        }, { senderId: "fixture-host", sequence, sentAt: Date.now() }));
      };
      window.sendScene(0, 1);
    });
    await page.waitForFunction(() => document.querySelector("video")?.videoHeight === 640).catch(async error => {
      console.error("fixture state", await page.evaluate(() => {
        const video = document.querySelector("video");
        return { width: video?.videoWidth, height: video?.videoHeight, ready: video?.readyState,
          error: video?.error?.message, status: document.getElementById("controller-error").textContent };
      }), errors);
      throw error;
    });
    const bounds = () => page.evaluate(() => {
      const video = document.querySelector("video"), frame = document.getElementById("controller-stage-frame");
      return { video: video.getBoundingClientRect().toJSON(), frame: frame.getBoundingClientRect().toJSON(),
        viewport: [innerWidth, innerHeight], natural: [video.videoWidth, video.videoHeight], objectFit: getComputedStyle(video).objectFit };
    });
    const assertFits = async label => {
      const result = await bounds();
      console.log(label, JSON.stringify(result));
      assert.equal(result.objectFit, "contain");
      for (const side of ["x", "y", "width", "height"]) {
        assert.ok(Math.abs(result.video[side] - result.frame[side]) < 1, `${label}: video ${side} overflows stage: ${JSON.stringify(result)}`);
      }
      assert.deepEqual([result.frame.width, result.frame.height], result.viewport);
    };
    await assertFits("portrait in landscape window");
    await page.waitForFunction(() => window.geometryCalls.some(call => call.geometry.videoHeight === 640));
    const portraitLog = await page.evaluate(() => window.geometryCalls.findLast(call => call.geometry.videoHeight === 640));
    assert.equal(portraitLog.generation, 42);
    assert.equal(portraitLog.geometry.videoWidth, 360);
    assert.equal(portraitLog.geometry.viewportWidth, 1280);
    assert.equal(portraitLog.geometry.viewportHeight, 720);
    assert.equal(portraitLog.geometry.devicePixelRatio, 1.5);
    assert.equal(portraitLog.geometry.videoBounds.height, 720);
    assert.ok(portraitLog.geometry.windowWidth > 0 && portraitLog.geometry.windowHeight > 0);
    assert.ok(!JSON.stringify(portraitLog).includes("blob:"));
    await page.evaluate(() => { window.originalVideo = document.querySelector("video"); });
    for (const viewport of [{ width: 720, height: 1280 }, { width: 1600, height: 600 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(size => window.geometryCalls.some(call => call.geometry.viewportWidth === size.width
        && call.geometry.viewportHeight === size.height), viewport);
      await assertFits(`portrait resized to ${viewport.width}x${viewport.height}`);
      assert.ok(await page.evaluate(() => window.originalVideo === document.querySelector("video")), "resize must preserve the media node");
    }
    const beforeTicks = await page.evaluate(() => window.geometryCalls.length);
    await page.evaluate(() => { for (let i = 2; i <= 22; i++) window.sendScene(0, i); });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.geometryCalls.length), beforeTicks, "progress-only updates must not log geometry");
    assert.ok(await page.evaluate(() => window.originalVideo === document.querySelector("video")));
    await page.evaluate(() => { window.failGeometryLog = true; window.sendScene(1, 23); });
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth === 1920);
    await assertFits("ultrawide video after track switch");
    await page.waitForFunction(() => window.geometryCalls.some(call => call.geometry.videoWidth === 1920));
    // Retired media must no longer schedule geometry or replace the current node.
    const retiredCount = await page.evaluate(() => {
      window.originalVideo.dispatchEvent(new Event("resize"));
      window.originalVideo.dispatchEvent(new Event("loadedmetadata"));
      return window.geometryCalls.length;
    });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.geometryCalls.length), retiredCount);
    assert.deepEqual(errors, [], "diagnostic failure must not surface as a player/page error");
    console.log("PASS: layout, native geometry payload, resize, media-node preservation and best-effort logging");
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
