"use strict";

// Real shared pages + real native HTTP/AppState; generated local media only.
// Usage: node tests/live_native_host_alpha.js EXE PRIVATE_DIR VIDEO AUDIO [CHROME]
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const path = require("node:path");
const fs = require("node:fs/promises");
const { chromium } = require("playwright");
const [executable, directory, video, audio, executablePath] = process.argv.slice(2);

async function run() {
  const server = spawn(executable, [path.resolve(directory), path.resolve("static"), path.resolve(video), path.resolve(audio)], {stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: server.stdout});
  let browser;
  let page;
  let remote;
  const errors = [];
  let stderr = "";
  server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
  try {
    const line = await Promise.race([once(lines, "line").then(v => v[0]), once(server, "exit").then(() => {throw new Error("Native harness exited before listening");})]);
    const bootstrap = JSON.parse(line).bootstrap_url;
    browser = await chromium.launch({headless: true, executablePath, args: ["--autoplay-policy=no-user-gesture-required"]});
    const hostContext = await browser.newContext({viewport: {width: 1100, height: 760}});
    page = await hostContext.newPage();
    page.on("pageerror", error => errors.push(error.message));
    // Exercise the real Android startup script from Tauri's asset origin, not
    // page.goto(bootstrap), which incorrectly gives Sec-Fetch-Site: none.
    // Only native IPC is stubbed; the destination is the real Rust HTTP server.
    await page.route("http://tauri.localhost/**", async route => {
      const name = new URL(route.request().url()).pathname.slice(1);
      const mime = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
      assert.ok(["android-alpha.html", "android-alpha.js", "android-alpha.css"].includes(name));
      await route.fulfill({contentType: mime, body: await fs.readFile(path.join("static", name))});
    });
    await page.addInitScript(url => {
      if (location.origin !== "http://tauri.localhost") return;
      window.__TAURI__ = {core: {invoke: async () => ({schema_version: 3, stage: "native-host-alpha", backend: "rust",
        revision: 1, host_api_ready: true, persistence_ready: true, playback_ready: true, bootstrap_url: url})}};
    }, bootstrap);
    const entryResponse = page.waitForResponse(response => response.url() === bootstrap);
    await page.goto("http://tauri.localhost/android-alpha.html");
    const entry = await entryResponse;
    assert.equal(entry.request().isNavigationRequest(), true);
    assert.equal(entry.status(), 200, `Android startup rejected: ${await entry.text()}`);
    // A same-origin landing document, not a cross-site HTTP redirect chain,
    // must establish the Strict cookie before loading authenticated assets/API.
    await page.waitForURL(new URL("/", bootstrap).href);
    const hostCookie = (await hostContext.cookies(page.url())).find(cookie => cookie.name === "bilikara_native");
    assert.equal(hostCookie?.httpOnly, true);
    assert.equal(hostCookie?.sameSite, "Strict");
    assert.equal(await page.evaluate(() => document.cookie.includes("bilikara_native")), false);
    await page.waitForFunction(() => state.data?.current_item?.cache_status === "ready");
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.3, null, {timeout: 20000});
    assert.equal(await page.locator("html").getAttribute("data-native-host"), "true");
    await page.locator("#work-rail-request").click();
    assert.equal(await page.locator('[data-request-view="search"]').isVisible(), true);
    assert.equal(await page.evaluate(() => tauriInvoke()), null);
    await page.waitForFunction(() => state.data?.player_status?.observed_phase === "playing");
    const retiredMedia = await page.evaluate(() => state.data.current_item.video_relative_path);
    const invite = await page.evaluate(() => state.data.remote_access.local_url);
    const remoteContext = await browser.newContext({viewport: {width: 412, height: 850}, isMobile: true, hasTouch: true});
    remote = await remoteContext.newPage();
    remote.on("pageerror", error => errors.push(error.message));
    // Scanning/opening an invite can also originate from a different site.
    await remote.route("http://invite.localhost/", route => route.fulfill({
      contentType: "text/html", body: '<!doctype html><button id="join">Join</button>',
    }));
    await remote.goto("http://invite.localhost/");
    await remote.evaluate(url => document.querySelector("#join").addEventListener("click", () => location.assign(url)), invite);
    const joinResponse = remote.waitForResponse(response => response.url() === invite);
    await remote.locator("#join").click();
    assert.equal((await joinResponse).status(), 200);
    await remote.waitForURL(new URL("/remote", invite).href);
    const remoteCookie = (await remoteContext.cookies(remote.url())).find(cookie => cookie.name === "bilikara_native");
    assert.equal(remoteCookie?.httpOnly, true);
    assert.equal(remoteCookie?.sameSite, "Strict");
    assert.notEqual(remoteCookie?.value, hostCookie.value);
    await remote.locator("#remote-identity-input").fill("Native Remote");
    await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(() => document.querySelector("#remote-identity-modal").classList.contains("hidden"));
    await remote.waitForFunction(() => state.data?.current_item?.id === "fixture-first");
    assert.equal(await remote.evaluate(() => state.data.playlist.length), 1);
    await remote.locator("#playback-dock").click();
    await remote.locator('[data-control-action="toggle-play"]').click();
    await page.waitForFunction(() => document.querySelector("video")?.paused === true);
    await remote.waitForFunction(() => state.data?.player_status?.is_paused === true);
    await remote.locator('[data-control-action="toggle-play"]').click();
    await page.waitForFunction(() => document.querySelector("video")?.paused === false);
    const before = await page.evaluate(() => document.querySelector("video").currentTime);
    await remote.locator('[data-control-action="seek-relative"][data-delta="15"]').click();
    await page.waitForFunction(value => document.querySelector("video")?.currentTime > value + 10, before);
    // The shared vocal selector sends the exact generation-bound command.
    await remote.locator('[data-action="toggle-audio-variants"]').click();
    await remote.locator('[data-variant-id="p2_instrumental"]').click();
    await page.waitForFunction(() => state.data.current_item.selected_audio_variant_id === "p2_instrumental");
    await page.waitForFunction(() => document.querySelector("audio")?.currentTime > 0.3 && !document.querySelector("audio").paused);
    await remote.evaluate(() => sendPlayerNext());
    await page.waitForFunction(() => state.data.current_item?.id === "fixture-second");
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.3 && !document.querySelector("video").paused);
    await remote.waitForFunction(() => state.data.history.length > 0);
    let oldMediaGone = false;
    for (let n = 0; n < 30; n++) {
      try { await fs.access(path.join(directory, "media", retiredMedia)); }
      catch (error) { if (error.code !== "ENOENT") throw error; oldMediaGone = true; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(oldMediaGone, true, "Retired song media remained pinned after switching songs");
    const response = await hostContext.request.post(new URL("/api/diagnostics/markdown", page.url()).href, {data: {}});
    assert.equal(response.status(), 200);
    assert.ok((await response.json()).data.markdown.includes("rust-native"));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.3 && !document.querySelector("video").paused);
    assert.deepEqual(errors, []);
    await page.screenshot({path: path.join(directory, "host.png")});
    await remote.screenshot({path: path.join(directory, "remote.png")});
    console.log(JSON.stringify({passed: true, crossSiteBootstrap: true, crossSiteInvite: true, strictCookies: true, nativeHttp: true, sharedUi: true, realMedia: true, remotePauseSeekVocalNext: true, history: true, cacheRetirement: true, reload: true, errors}));
  } catch (error) {
    if (page) console.log("Host state", await page.evaluate(() => ({
      item: state.data?.current_item?.id, cache: state.data?.current_item?.cache_status,
      message: state.data?.current_item?.cache_message, player: state.data?.player_status,
      controls: state.data?.player_control_command, video: document.querySelector("video") ? {paused: document.querySelector("video").paused, time: document.querySelector("video").currentTime, error: document.querySelector("video").error?.message} : null,
      toast: document.querySelector("#app-toast")?.textContent,
      session: state.hostPlaybackSession ? {phase: state.hostPlaybackSession.phase, ready: state.hostPlaybackSession.readyCommitted,
        intent: state.hostPlaybackSession.logicalPlayIntent, applied: state.hostPlaybackSession.initialIntentApplied,
        ownership: state.hostPlaybackSession.ownershipClaimed, settling: state.hostPlaybackSession.seekSettling} : null,
      hold: shouldHoldCurrentItemForTransition(),
      transition: {pending: state.pendingSongTransitionOverlayData?.current_item?.id,
        held: state.manualTransitionHoldItemId, generation: state.manualTransitionHoldGeneration,
        deadline: state.localAdvanceDelayDeadline, now: Date.now(), timer: state.localAdvanceDelayTimer,
        overlay: Boolean(playerDelayOverlay()), visible: hasLocalAdvanceDelayOverlay()},
      audio: document.querySelector("audio") ? {ready: document.querySelector("audio").readyState,
        time: document.querySelector("audio").currentTime, paused: document.querySelector("audio").paused} : null,
    })).catch(() => ({})));
    if (remote) console.log("Remote state", await remote.evaluate(() => ({
      toast: document.querySelector("#app-toast")?.textContent,
      identity: document.querySelector("#remote-identity-message")?.textContent,
    })).catch(() => ({})));
    console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[URL]"), errors);
    if (stderr) console.error(stderr.replace(/https?:\/\/[^\s]+/g, "[URL]"));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.stdin.end("stop\n");
    lines.close();
    if (server.exitCode === null) await once(server, "exit");
  }
}
run().catch(error => {console.error(error.message);process.exitCode=1;});
