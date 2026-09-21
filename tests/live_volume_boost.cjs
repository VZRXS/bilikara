"use strict";

// Offline synthetic media only. Run against an isolated native Host directory.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const playwright = require("playwright");

async function assertVolumeFieldsInRow(page) {
  const fields = await page.locator(".volume-adjust-fields").evaluate((element) =>
    [...element.children].map((child) => {
      const { left, right, top, bottom } = child.getBoundingClientRect();
      return { left, right, top, bottom };
    }));
  assert.equal(fields.length, 3);
  for (const field of fields) {
    assert(Math.abs(field.top - fields[0].top) < 1 && Math.abs(field.bottom - fields[0].bottom) < 1,
      `Volume controls must share one row: ${JSON.stringify(fields)}`);
  }
  assert(fields.slice(1).every((field, index) => fields[index].right <= field.left),
    `Volume controls must not overlap: ${JSON.stringify(fields)}`);
}

async function main() {
  const [binary, directory, video, audio, engine = "chromium", executablePath] = process.argv.slice(2);
  assert(binary && directory && video && audio, "native binary, private directory and synthetic video/audio required");
  await fs.mkdir(directory, { recursive: true });
  const host = spawn(binary, [directory, path.resolve(__dirname, "../static"), video, audio, "3"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: host.stdout });
  const bootstrapLine = new Promise((resolve, reject) => {
    const finish = (error, line) => {
      clearTimeout(timeout);
      lines.off("line", onLine);
      host.off("exit", onExit);
      host.off("error", onError);
      if (error) reject(error); else resolve(line);
    };
    const onLine = (line) => finish(null, line);
    const onExit = (code) => finish(new Error(`Fixture Host exited before startup (${code}); use a fresh private directory`));
    const onError = (error) => finish(error);
    const timeout = setTimeout(() => finish(new Error("Fixture Host startup timed out")), 15000);
    lines.once("line", onLine);
    host.once("exit", onExit);
    host.once("error", onError);
  });
  let browser, hostPage, remote;
  const errors = [], warnings = [], requests = [];
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        let source = "";
        try { source = new URL(message.location().url).pathname; } catch {}
        warnings.push(`${source}: ${message.text()}`);
      }
    });
  };
  try {
    const bootstrap = JSON.parse(await bootstrapLine).bootstrap_url;
    browser = await playwright[engine].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    context.setDefaultTimeout(15000);
    const onlyLocal = (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1") return route.abort();
      return route.continue();
    };
    await context.route("**/*", onlyLocal);
    hostPage = await context.newPage();
    watch(hostPage);
    await hostPage.goto(bootstrap);
    await hostPage.waitForFunction(() => typeof state !== "undefined" && state.data?.current_item?.id === "fixture-first");
    assert.equal(await hostPage.title(), "bilikara host");
    const trayToggle = hostPage.locator("#stage-controls-toggle");
    if (await trayToggle.isVisible() && await trayToggle.getAttribute("aria-expanded") !== "true") await trayToggle.click();
    await hostPage.locator('#volume-panel [aria-describedby="host-volume-info"]').click();
    assert.equal(await hostPage.locator('#volume-panel [aria-describedby="host-volume-info"]').getAttribute("aria-expanded"), "true");
    assert.match(await hostPage.locator("#host-volume-info").textContent(), /100%.*500%/);
    await hostPage.locator('#volume-panel [aria-describedby="host-volume-info"]').click();
    await hostPage.locator("#volume-value").click();
    await hostPage.locator(".volume-adjust-popover input").fill("500");
    const hostPeers = await hostPage.evaluate(() => {
      const css = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        button: css('.volume-adjust-popover [data-volume-step="10"]').backgroundColor,
        peer: css('#av-sync-panel [data-step="200"]').backgroundColor,
        border: css('.volume-adjust-popover [data-volume-step="10"]').border,
        peerBorder: css('#av-sync-panel [data-step="200"]').border,
        radius: css('.volume-adjust-popover .av-sync-input-wrap').borderRadius,
        peerRadius: css('#av-sync-panel .av-sync-input-wrap').borderRadius,
      };
    });
    assert.equal(hostPeers.button, hostPeers.peer);
    assert.equal(hostPeers.border, hostPeers.peerBorder);
    assert.equal(await hostPage.locator('.volume-adjust-popover [type="submit"]').count(), 0);
    assert.equal(await hostPage.locator("[data-volume-info], .volume-adjust-hint").count(), 0);
    assert.equal(hostPeers.radius, hostPeers.peerRadius);
    await assertVolumeFieldsInRow(hostPage);
    await hostPage.locator(".volume-adjust-popover").screenshot({ path: path.join(directory, "host-volume-editor.png") });
    await hostPage.locator(".volume-adjust-popover input").press("Enter");
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 500);
    await hostPage.waitForFunction(() => state.hostPlaybackSession?.audio?.bilikaraVolumeGain?.gain.value === 5);
    await hostPage.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    await hostPage.screenshot({ path: path.join(directory, "host-volume-default.png") });
    await hostPage.keyboard.press("Escape");
    await hostPage.waitForFunction(() => !document.querySelector('.volume-adjust-popover').open);
    await hostPage.locator("#volume-panel").screenshot({ path: path.join(directory, "host-volume-500.png") });
    const before = await hostPage.evaluate(() => ({ volume: state.localPlayerVolume,
      nativeVolume: state.hostPlaybackSession.audio.volume, generation: state.data.playback_generation }));
    assert.equal(before.volume, 5);
    assert.equal(before.nativeVolume, 1);

    // Measure actual decoded audio before/after the same gain node, not just its setting.
    if (engine === "chromium") {
      const start = hostPage.locator(".split-playback-start-button");
      if (await start.isVisible()) await start.click();
      await hostPage.waitForFunction(() => {
        const audio = state.hostPlaybackSession?.audio;
        return audio && !audio.paused && audio.currentTime > 0.1;
      });
      await hostPage.evaluate(async () => {
        const { audio } = activeLocalPlayerElements();
        await state.audioContext.resume();
        const input = state.audioContext.createAnalyser(), output = state.audioContext.createAnalyser();
        input.fftSize = output.fftSize = 2048;
        audio.bilikaraPitchSource.connect(input);
        audio.bilikaraVolumeGain.connect(output);
        window.volumeSample = () => {
          const rms = (node) => {
            const data = new Float32Array(2048); node.getFloatTimeDomainData(data);
            return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
          };
          return { input: rms(input), output: rms(output) };
        };
      });
      await hostPage.waitForFunction(() => window.volumeSample().input > 0.001);
      const samples = await hostPage.evaluate(() => window.volumeSample());
      assert(samples.output / samples.input > 4.8 && samples.output / samples.input < 5.2, JSON.stringify(samples));
      console.log(JSON.stringify({ audioAmplitudeRatio: samples.output / samples.input }));
    }

    const invite = await hostPage.evaluate(() => state.data.remote_access.local_url);
    // Host and Remote have distinct authentication cookies, as on real devices.
    const remoteContext = await browser.newContext({ viewport: { width: 375, height: 667 }, locale: "zh-CN", hasTouch: true });
    remoteContext.setDefaultTimeout(15000);
    await remoteContext.route("**/*", onlyLocal);
    remote = await remoteContext.newPage();
    watch(remote);
    await remote.setViewportSize({ width: 375, height: 667 });
    remote.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/player/volume" && request.method() === "POST") requests.push(request.postDataJSON());
    });
    await remote.goto(invite);
    await remote.locator("#remote-identity-input").fill("Volume tester");
    await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(() => state.remoteIdentity?.registered);
    assert.equal(await remote.title(), "bilikara remote");
    await remote.locator("#playback-dock").click();
    await remote.locator("#remote-volume-value").scrollIntoViewIfNeeded();
    await remote.waitForFunction(() => document.getElementById("remote-volume-value").textContent === "500%");
    const open = async () => {
      await remote.locator("#remote-volume-value").click();
      await remote.locator(".volume-adjust-popover").evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations({subtree: true}).map((animation) => animation.finished));
      });
    };
    const input = remote.locator(".volume-adjust-popover input");
    const plus = remote.locator('[data-volume-step="10"]');
    const reset = remote.locator('[data-volume-reset]');
    const closeEditor = async () => {
      await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
      await remote.keyboard.press("Escape");
      await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover').open);
    };
    assert.equal(await remote.locator('.volume-adjust-popover [type="submit"]').count(), 0);
    await remote.locator('#remote-volume-panel [aria-describedby="remote-volume-info"]').click();
    assert.equal(await remote.locator('#remote-volume-panel [aria-describedby="remote-volume-info"]').getAttribute("aria-expanded"), "true");
    assert.match(await remote.locator("#remote-volume-info").textContent(), /100%.*500%/);
    await remote.screenshot({ path: path.join(directory, "remote-volume-help.png") });
    await remote.locator('#remote-volume-panel [aria-describedby="remote-volume-info"]').click();
    await open();
    await input.fill("375");
    await remote.screenshot({ path: path.join(directory, "remote-volume-edit-375.png") });
    await input.press("Enter");
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 375 && state.localPlayerVolume === 3.75);
    assert.equal(await remote.locator("#remote-volume-value").textContent(), "375%");
    assert.equal(await remote.locator(".volume-adjust-popover").evaluate((element) => element.open), true);
    await closeEditor();

    // Narrow themes/translations, numeric validation, Escape and focus restoration.
    for (const [width, language, theme] of [[375, "zh", "light"], [320, "en", "dark"], [320, "ja", "blue"]]) {
      await remote.setViewportSize({ width, height: 667 });
      await remote.evaluate(({ language, theme }) => {
        setLanguage(language); document.documentElement.dataset.theme = theme;
      }, { language, theme });
      await open();
      const peers = await remote.evaluate(async () => {
        const selectors = ['.volume-adjust-popover [data-volume-step="10"]',
          '#remote-av-sync-panel [data-av-step="200"]', '.volume-adjust-popover .remote-input-wrap',
          '#remote-av-sync-panel .remote-input-wrap'];
        await Promise.allSettled(selectors.flatMap((selector) => document.querySelector(selector).getAnimations())
          .map((animation) => animation.finished));
        const css = (selector) => getComputedStyle(document.querySelector(selector));
        const step = css('.volume-adjust-popover [data-volume-step="10"]');
        const peer = css('#remote-av-sync-panel [data-av-step="200"]');
        const input = css('.volume-adjust-popover .remote-input-wrap');
        const peerInput = css('#remote-av-sync-panel .remote-input-wrap');
        return { button: step.backgroundColor, peerButton: peer.backgroundColor,
          input: input.backgroundColor, peerInput: peerInput.backgroundColor,
          radius: input.borderRadius, peerRadius: peerInput.borderRadius,
          buttonBorder: step.border, peerBorder: peer.border,
          buttonRadius: step.borderRadius, peerButtonRadius: peer.borderRadius };
      });
      assert.equal(peers.button, peers.peerButton);
      assert.equal(peers.input, peers.peerInput);
      assert.equal(peers.radius, peers.peerRadius);
      assert.equal(peers.buttonBorder, peers.peerBorder);
      assert.equal(peers.buttonRadius, peers.peerButtonRadius);
      assert.equal(await remote.locator("[data-volume-info], .volume-adjust-hint").count(), 0);
      await assertVolumeFieldsInRow(remote);
      const geometry = await remote.locator(".volume-adjust-popover").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const viewport = visualViewport;
        return { left: box.left, right: box.right, width: innerWidth, scroll: element.scrollWidth, client: element.clientWidth,
          centerX: box.x + box.width / 2, centerY: box.y + box.height / 2,
          viewportX: viewport.offsetLeft + viewport.width / 2, viewportY: viewport.offsetTop + viewport.height / 2 };
      });
      assert(geometry.left >= 0 && geometry.right <= geometry.width && geometry.scroll <= geometry.client, JSON.stringify(geometry));
      assert(Math.abs(geometry.centerX - geometry.viewportX) < 1 && Math.abs(geometry.centerY - geometry.viewportY) < 1, JSON.stringify(geometry));
      await input.fill("501");
      const count = requests.length;
      await input.press("Enter");
      assert.equal(requests.length, count);
      assert.equal(await remote.locator(".volume-adjust-popover").evaluate((element) => element.open), true);
      await input.fill("375");
      await remote.screenshot({ path: path.join(directory, `remote-volume-${width}-${language}.png`) });
      await remote.keyboard.press("Escape");
      await remote.waitForFunction(() => document.getElementById("remote-volume-value").getAttribute("aria-expanded") === "false");
      assert.equal(await remote.locator("#remote-volume-value").getAttribute("aria-expanded"), "false");
      assert.equal(await remote.evaluate(() => playbackSheetIsOpen()), true);
    }

    // Buttons are guarded for the entire request and recover after a failure.
    await remote.setViewportSize({width: 375, height: 667});
    await remote.evaluate(() => { setLanguage("zh"); document.documentElement.dataset.theme = "light"; });
    await open();
    await remote.screenshot({ path: path.join(directory, "remote-volume-default.png") });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    await remote.route("**/api/player/volume", async (route) => {
      await waiting;
      await route.fulfill({ status: 503, json: { ok: false, error: "Fixture rejected" } });
    });
    await plus.click();
    await remote.waitForFunction(() => document.querySelector('[data-volume-step="10"]').getAttribute("aria-busy") === "true");
    assert.equal(await plus.isDisabled(), true);
    assert.equal(await input.isDisabled(), true);
    const pendingCount = requests.length;
    await plus.dispatchEvent("click");
    await remote.locator(".volume-adjust-popover form").dispatchEvent("submit");
    assert.equal(requests.length, pendingCount);
    release();
    await remote.waitForFunction(() => !document.querySelector('[data-volume-step="10"]').disabled);
    await remote.unroute("**/api/player/volume");
    assert.equal(await remote.locator(".volume-adjust-popover").evaluate((element) => element.open), true);
    assert.equal(await remote.locator(".volume-adjust-error").isVisible(), true);
    assert.equal(await input.inputValue(), "375", "failed adjustment restores the saved value");
    await plus.click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 3.85);
    await remote.waitForFunction(() => !document.querySelector('[data-volume-step="10"]').disabled);
    await reset.click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 1);
    await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    assert.equal(await reset.isDisabled(), true);
    assert.equal(await reset.textContent(), "复位");
    await input.fill("250");
    await input.press("Tab");
    await hostPage.waitForFunction(() => state.localPlayerVolume === 2.5);
    await closeEditor();

    const slider = remote.locator("#remote-volume-slider");
    const dragVolume = async (fraction) => {
      const track = await slider.boundingBox();
      const x = (position) => track.x + 10 + (track.width - 20) * position;
      const y = track.y + track.height / 2;
      await remote.mouse.move(x(Number(await slider.inputValue()) / 100), y);
      await remote.mouse.down();
      await remote.mouse.move(x(fraction), y, { steps: 6 });
      await remote.mouse.up();
    };
    // A continuous drag from below 100 cannot activate boost, even past the end.
    await dragVolume(.5);
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent < 100);
    await dragVolume(1.2);
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 100);
    assert.equal(await remote.locator(".volume-adjust-popover").evaluate((el) => el.open), false);
    // Only a fresh rightward drag starting on the 100% thumb opens the editor.
    if (engine === "chromium") {
      const cdp = await remoteContext.newCDPSession(remote);
      const box = await slider.boundingBox();
      const x = box.x + box.width - 10, y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x, y}]});
      for (const dx of [5, 10, 20, 30]) {
        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: x + dx, y}]});
      }
      await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
      await cdp.detach();
    } else {
      await dragVolume(1.2);
    }
    await input.waitFor({state: "visible"});
    assert.equal(await input.inputValue(), "100");
    assert.equal(await remote.locator("[data-volume-info], .volume-adjust-hint").count(), 0);
    await remote.locator('[data-volume-step="10"]').click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 1.1);
    await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    assert.equal(await input.inputValue(), "110");
    assert.equal(await remote.locator("[data-volume-info], .volume-adjust-hint").count(), 0);
    await remote.locator('[data-volume-step="-10"]').click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 1);
    await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    assert.equal(await input.inputValue(), "100");
    await input.fill("65");
    await input.press("Enter");
    await hostPage.waitForFunction(() => state.localPlayerVolume === .65);
    await closeEditor();
    assert.equal(await remote.locator(".volume-control.is-boosted").count(), 0);
    await slider.focus();
    await remote.keyboard.press("ArrowRight");
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 66);
    await remote.keyboard.press("Home");
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 0);
    await remote.keyboard.press("End");
    await hostPage.waitForFunction(() => state.data.player_settings.volume_percent === 100);
    await open();
    await input.fill("500");
    await input.press("Enter");
    await hostPage.waitForFunction(() => state.localPlayerVolume === 5);
    await closeEditor();
    await remote.locator("#remote-volume-mute-button").click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 5 && state.hostPlaybackSession.audio.muted);
    await remote.locator("#remote-volume-mute-button").click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 5 && !state.hostPlaybackSession.audio.muted);
    await hostPage.locator("#key-shift-inc-button").click();
    await hostPage.waitForFunction(() => state.hostPlaybackSession.audio.bilikaraPitch?.applied === 1 && state.hostPlaybackSession.audio.bilikaraVolumeGain.bilikaraTarget === 5);
    await hostPage.locator("#key-shift-reset-button").click();
    await hostPage.waitForFunction(() => state.hostPlaybackSession.audio.bilikaraPitch?.applied === 0 && state.hostPlaybackSession.audio.bilikaraVolumeGain.bilikaraTarget === 5);
    if (await hostPage.locator("#stage-control-backdrop").isVisible()) await hostPage.locator("#stage-control-backdrop").click();
    await hostPage.evaluate(() => { window.previousVolumeAudio = state.hostPlaybackSession.audio; });
    await hostPage.locator('#audio-variant-bar [data-variant-id="p2_instrumental"]').click();
    await hostPage.waitForFunction(() => state.hostPlaybackSession.audio !== window.previousVolumeAudio && state.hostPlaybackSession.audio?.bilikaraVolumeGain?.bilikaraTarget === 5);
    assert.equal(await hostPage.evaluate(() => window.previousVolumeAudio.bilikaraVolumeGain), null);
    await remote.locator("#remote-volume-mute-button").click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 5 && state.localPlayerMuted);
    await hostPage.locator("#next-button").click();
    await hostPage.waitForFunction(() => state.data.current_item?.id === "fixture-second" && state.localPlayerVolume === 1 && state.hostPlaybackSession.audio?.muted);
    await remote.waitForFunction(() => document.getElementById("remote-volume-value").textContent === "100%");
    await remote.locator("#remote-volume-mute-button").click();
    await hostPage.waitForFunction(() => state.localPlayerVolume === 1 && !state.hostPlaybackSession.audio.muted);
    assert.equal(await slider.inputValue(), "100");

    // A focused draft and an already-sent write both belong to the old song.
    await open();
    await input.fill("375");
    await input.press("Enter");
    await hostPage.waitForFunction(() => state.localPlayerVolume === 3.75);
    await remote.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    await input.fill("450");
    if (await trayToggle.isVisible() && await trayToggle.getAttribute("aria-expanded") !== "true") await trayToggle.click();
    await hostPage.locator("#volume-value").click();
    const hostInput = hostPage.locator('.volume-adjust-popover input');
    await hostInput.fill("500");
    let releaseOldVolume;
    const delayedVolume = new Promise((resolve) => { releaseOldVolume = resolve; });
    let oldVolumeBody;
    await hostPage.route("**/api/player/volume", async (route) => {
      oldVolumeBody = route.request().postDataJSON();
      await delayedVolume;
      await route.continue();
    });
    const oldIncarnation = await hostPage.evaluate(() => state.data.current_item.item_incarnation_id);
    await hostInput.press("Enter");
    await hostPage.waitForFunction(() => document.querySelector('.volume-adjust-popover input').disabled);
    await hostPage.evaluate(async () => {
      const next = await apiPost('/api/player/next', {playback_generation: state.data.playback_generation});
      acceptHostStateSnapshot(next);
    });
    await hostPage.waitForFunction(() => state.data.current_item?.id === "fixture-third" && state.localPlayerVolume === 1);
    await remote.waitForFunction(() => state.data.current_item?.id === "fixture-third");
    assert.equal(await input.inputValue(), "100", "song reset overwrites the focused draft");
    assert.equal(await hostInput.inputValue(), "100", "song reset overwrites the pending editor value");
    const oldResponse = hostPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/player/volume');
    releaseOldVolume();
    assert.equal((await oldResponse).status(), 409, "late volume write must be rejected by Rust");
    assert.equal(oldVolumeBody.expected_item_incarnation_id, oldIncarnation);
    await hostPage.waitForFunction(() => !document.querySelector('.volume-adjust-popover input').disabled);
    await hostPage.unroute("**/api/player/volume");
    assert.equal(await hostInput.inputValue(), "100");
    assert.equal(await input.inputValue(), "100");
    await input.press("Enter");
    const finalSettings = await hostPage.evaluate(async () => (await (await fetch('/api/state', {cache: 'no-store'})).json()).data.player_settings);
    assert.equal(finalSettings.volume_percent, 100);
    assert.equal(await remote.locator(".volume-adjust-error").isVisible(), false);
    assert.equal(await hostPage.locator(".volume-adjust-error").isVisible(), false);
    await remote.screenshot({path: path.join(directory, "remote-volume-song-reset.png")});
    await hostPage.screenshot({path: path.join(directory, "host-volume-song-reset.png")});
    const expectedWarnings = [
      /^\/api\/player\/volume:.*409/, // Deliberately delayed request belongs to the previous song.
      /^\/api\/player\/status:.*409/, // In-flight status from the retired generation is rejected.
      /^\/api\/player\/volume:.*503/, // Explicit failed-write fixture above.
      /^\/api\/remote\/connection-diagnostic:.*403/, // Initial diagnostic precedes identity registration.
      /Viewport argument key "interactive-widget" not recognized/, // Existing WebKit viewport warning.
      /FaviconLoader\.sys\.mjs:.*favicon\.ico.*default-src/, // Firefox inspects the bootstrap document's icon.
    ];
    const unexpectedWarnings = warnings.filter((line) => !expectedWarnings.some((pattern) => pattern.test(line)));
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedWarnings, []);
    console.log(JSON.stringify({ engine, passed: true, requests: requests.length, errors, warnings }));
  } catch (error) {
    console.error(JSON.stringify({ errors, warnings, host: await hostPage?.evaluate(() => ({
      settings: state.data?.player_settings, phase: state.hostPlaybackSession?.phase,
      selected: state.data?.current_item?.selected_audio_variant_id, advancing: state.localAdvanceInFlight, sessionCurrent: isCurrentHostPlaybackSession(state.hostPlaybackSession),
      volume: state.localPlayerVolume, muted: state.localPlayerMuted, suppressRemaining: state.playerSettingsEchoSuppressUntil - Date.now(), gain: state.hostPlaybackSession?.audio?.bilikaraVolumeGain?.bilikaraTarget,
      audioError: state.hostPlaybackSession?.audio?.error?.code,
      message: document.getElementById("app-message")?.textContent,
    })).catch((failure) => failure.message) }));
    await hostPage?.screenshot({ path: path.join(directory, "host-failure.png") }).catch(() => {});
    await remote?.screenshot({ path: path.join(directory, "remote-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    if (host.pid && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.stdin.end("stop\n");
      await exited;
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
