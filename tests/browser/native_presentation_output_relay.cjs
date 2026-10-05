"use strict";
// Real native Host HTTP/SSE and real Host/audience pages. The Host and audience
// run in separate browser contexts, so browser storage and BroadcastChannel are
// never shared, as with independent desktop WebView data stores. Only the Tauri
// shell is emulated, following src-tauri/src/presentation.rs: role-scoped
// commands, activation order, and the output-state relay with its validation.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const playwright = require("playwright");

const [binary, output, engine = "chromium"] = process.argv.slice(2);
const MAX_OUTPUT_STATE_BYTES = 2 * 1024 * 1024;
const commandsByRole = {
  main: new Set(["get_presentation_session", "get_presentation_displays", "set_window_fullscreen", "activate_local_presentation",
    "mark_presentation_host_ready", "publish_presentation_playback_state", "publish_presentation_output_state",
    "deactivate_local_presentation"]),
  controller: new Set(["get_presentation_session", "mark_presentation_controller_ready",
    "request_presentation_output_state", "deactivate_local_presentation"]),
};

(async () => {
  const evidence = path.resolve(output);
  await fs.mkdir(evidence, { recursive: true });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "output-relay-"));
  const server = spawn(path.resolve(binary), ["--headless", "--data-dir", home,
    "--static-dir", path.resolve(__dirname, "../../static")], {
    cwd: home,
    env: { ...process.env, BILIKARA_SHUTDOWN_TOKEN: "fixture-private",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", browser, ready;
  server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  const lines = createInterface({ input: server.stdout });
  try {
    ready = JSON.parse(await Promise.race([
      once(lines, "line").then(value => value[0]),
      once(server, "exit").then(() => { throw Error(stderr); }),
    ]));
    browser = await playwright[engine].launch({ headless: true });
    const shell = {
      relay: false,
      relayed: 0,
      session: { mode: "singleScreen", phase: "inactive", generation: 1, selectedOutputDisplayId: "",
        controllerDisplayId: "d1", hostReady: false, controllerReady: false, lastAcceptedCommandSequence: 0,
        lastAppliedCommandSequence: 0, playbackAuthority: "host", mediaRendererOwner: "host", recoveryReason: "" },
      published: false,
      pages: { main: null, controller: null },
    };
    const snapshot = () => JSON.parse(JSON.stringify(shell.session));
    const emit = async (target, name, payload) => {
      const page = shell.pages[target];
      if (page && !page.isClosed()) {
        await page.evaluate(([event, value]) => window.__shellEmit?.(event, value), [name, payload]).catch(() => {});
      }
    };
    const emitState = async () => {
      const payload = { session: snapshot() };
      await emit("main", "bilikara-presentation-state", payload);
      await emit("controller", "bilikara-presentation-state", payload);
    };
    const finalizeIfReady = async () => {
      const current = shell.session;
      if (current.phase !== "activating" || !current.hostReady || !current.controllerReady || !shell.published) return;
      shell.session.phase = "active";
      await emitState();
    };
    const outputGenerationIsCurrent = generation => generation === shell.session.generation
      && shell.session.mode === "localDualScreen" && ["activating", "active"].includes(shell.session.phase);
    const audience = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "zh-CN" });
    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
    const install = async context => {
      await context.exposeBinding("__shellInvoke", async ({ page }, name, args) => {
        const role = page === shell.pages.main ? "main" : page === shell.pages.controller ? "controller" : "";
        if (!commandsByRole[role]?.has(name)) throw Error(`${role || "unknown"} is not permitted to invoke ${name}`);
        switch (name) {
          case "set_window_fullscreen":
            assert.equal(typeof args.fullscreen, "boolean");
            shell.fullscreen = args.fullscreen;
            return;
          case "get_presentation_session": return snapshot();
          case "get_presentation_displays":
            return { monitorCount: 2, controllerDisplayId: "d1", recommendedDisplayId: "d2", displays: [
              { id: "d1", name: "Built-in", width: 1280, height: 800, scaleFactor: 1, builtIn: true, controller: true,
                primary: true, selectable: false, mirrored: false, identityStable: true, identityQuality: "stable" },
              { id: "d2", name: "Projector", positionX: 1280, width: 1920, height: 1080, scaleFactor: 1, builtIn: false,
                controller: false, primary: false, selectable: true, mirrored: false, identityStable: true, identityQuality: "stable" },
            ] };
          case "activate_local_presentation": {
            assert.equal(shell.session.phase, "inactive");
            shell.session = { ...shell.session, mode: "localDualScreen", phase: "activating",
              generation: shell.session.generation + 1, selectedOutputDisplayId: args.displayId,
              hostReady: false, controllerReady: false };
            shell.published = false;
            const generation = shell.session.generation;
            // The shell builds the hidden audience window before publishing the state.
            const controller = await audience.newPage();
            shell.pages.controller = controller;
            void controller.goto(`${ready.bootstrapUrl}?presentationGeneration=${generation}&page=controller`);
            await emitState();
            await emit("main", "bilikara-presentation-host-composition", { generation, composition: "stageOnly" });
            shell.published = true;
            await finalizeIfReady();
            return snapshot();
          }
          case "mark_presentation_host_ready":
          case "mark_presentation_controller_ready": {
            if (args.generation !== shell.session.generation || shell.session.phase !== "activating") {
              throw Error("presentation readiness generation is stale");
            }
            shell.session[name === "mark_presentation_host_ready" ? "hostReady" : "controllerReady"] = true;
            await emitState();
            await finalizeIfReady();
            return snapshot();
          }
          case "publish_presentation_playback_state": return { accepted: true };
          case "publish_presentation_output_state": {
            const envelope = args.envelope;
            assert.equal(typeof envelope, "object");
            assert.equal(envelope.type, "master-state");
            assert.equal(envelope.payload?.scene?.generation, args.generation);
            assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_OUTPUT_STATE_BYTES);
            if (!outputGenerationIsCurrent(args.generation)) throw Error("presentation output generation is stale");
            if (shell.relay) {
              shell.relayed += 1;
              await emit("controller", "bilikara-presentation-output-state", envelope);
            }
            return null;
          }
          case "request_presentation_output_state":
            if (!outputGenerationIsCurrent(args.generation)) throw Error("presentation output generation is stale");
            if (shell.relay) await emit("main", "bilikara-presentation-output-request", { generation: args.generation });
            return null;
          case "deactivate_local_presentation":
            shell.session = { ...shell.session, mode: "singleScreen", phase: "inactive", hostReady: false, controllerReady: false };
            await emitState();
            await emit("main", "bilikara-presentation-host-composition", { generation: shell.session.generation, composition: "combined" });
            if (shell.pages.controller && !shell.pages.controller.isClosed()) await shell.pages.controller.close();
            shell.pages.controller = null;
            return snapshot();
          default:
            throw Error(`Unexpected command: ${name}`);
        }
      });
      await context.addInitScript(() => {
        const listeners = new Map();
        window.__shellEmit = (name, payload) => {
          for (const callback of listeners.get(name) || []) callback({ payload });
        };
        window.__TAURI__ = {
          core: { invoke: (name, args) => window.__shellInvoke(name, args ?? null) },
          event: { listen: async (name, callback) => {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
            return () => listeners.set(name, (listeners.get(name) || []).filter(value => value !== callback));
          } },
        };
      });
    };
    await install(hostContext);
    await install(audience);

    const host = await hostContext.newPage();
    shell.pages.main = host;
    const errors = [];
    host.on("pageerror", error => errors.push(`host: ${error.message}`));
    await host.goto(ready.bootstrapUrl);
    await host.waitForFunction(() => typeof state !== "undefined" && state.data?.remote_access);
    await host.waitForFunction(() => state.presentationDisplayInfo?.displays?.length === 2);
    // A full menu replaces the top-layer preview without a compact-layout exit flash.
    const phoneTrigger = host.locator("#remote-mini-trigger");
    const phonePopup = host.locator("#remote-mini-popover");
    await phoneTrigger.hover();
    await host.waitForFunction(() => document.querySelector("#remote-mini-popover").matches(":popover-open"));
    await phoneTrigger.click();
    assert.equal(await phonePopup.evaluate(node => node.matches(":popover-open")), false);
    await phoneTrigger.click();
    assert.deepEqual(await phonePopup.evaluate(node => ({
      visibility: getComputedStyle(node).visibility,
      transition: getComputedStyle(node).transitionDuration,
    })), { visibility: "hidden", transition: "0s" });
    await host.mouse.move(20, 300);
    await phoneTrigger.hover();
    await host.waitForFunction(() => getComputedStyle(document.querySelector("#remote-mini-popover")).opacity === "1");
    await phoneTrigger.click();
    await host.mouse.click(20, 300);
    assert.equal(await phonePopup.evaluate(node => getComputedStyle(node).visibility), "hidden");
    // Older WebViews lack both the Popover API and its :popover-open selector.
    await host.evaluate(() => {
      const popup = document.querySelector("#remote-mini-popover");
      const matches = popup.matches;
      popup.showPopover = undefined;
      popup.hidePopover = undefined;
      popup.matches = function(selector) {
        if (selector === ":popover-open") throw new DOMException("Unsupported selector", "SyntaxError");
        return matches.call(this, selector);
      };
      try {
        setRemoteQrPinned(true);
        if (!state.remoteQrPinned) throw Error("Fallback management menu did not open");
        setRemoteQrPinned(false);
        if (getComputedStyle(popup).visibility !== "hidden") throw Error("Fallback management menu did not close");
      } finally {
        delete popup.showPopover;
        delete popup.hidePopover;
        delete popup.matches;
      }
    });
    // Native fullscreen does not enter the browser top layer. Narrow desktop
    // stacking contexts used to leave the toolbar, rail and workspace on top.
    await host.evaluate(() => {
      document.body.dataset.tauriPlatform = "windows";
      window.fullscreenSavedItem = state.data.current_item;
      state.data.current_item = { id: "fullscreen-layout", title: "Fullscreen layout fixture" };
      window.fullscreenMedia = document.createElement("video");
      window.fullscreenSavedMountedVideo = mountedLocalVideoElement;
      mountedLocalVideoElement = () => window.fullscreenMedia;
      document.querySelector("#player-frame").appendChild(window.fullscreenMedia);
      renderPlayerFullscreenButton();
    });
    for (const width of [700, 1100, 1230, 1231, 1600]) {
      await host.setViewportSize({ width, height: 800 });
      await host.evaluate(() => activateHostWorkspace("queue", { inputOrigin: "programmatic" }));
      await host.evaluate(() => { window.fullscreenMedia.controls = true; });
      await host.locator("#player-fullscreen-button").click();
      assert.equal(shell.fullscreen, true);
      assert.equal(await host.evaluate(() => window.fullscreenMedia.controls), false);
      await host.evaluate(() => revealMountedPlayerControlsForUserInteraction());
      assert.equal(await host.evaluate(() => window.fullscreenMedia.controls), false);
      const qr = host.locator(".fullscreen-remote-popover");
      assert.equal(await qr.evaluate(node => getComputedStyle(node).visibility), "hidden");
      await host.mouse.move(20, 300);
      await host.locator("#player-fullscreen-button").hover();
      await host.waitForFunction(() => getComputedStyle(document.querySelector(".fullscreen-remote-popover")).opacity === "1");
      await host.mouse.move(20, 300);
      await host.waitForFunction(() => getComputedStyle(document.querySelector(".fullscreen-remote-popover")).visibility === "hidden");
      assert.equal(await host.evaluate(() => document.fullscreenElement), null);
      for (const selector of [".topbar", ".work-rail", ".host-workspace-region", ".host-workspace-backdrop"]) {
        assert.equal(await host.locator(selector).isVisible(), false, `${selector} hidden at ${width}px`);
      }
      const stage = await host.locator(".player-panel").boundingBox();
      assert.deepEqual(stage, { x: 0, y: 0, width, height: 800 });
      assert.equal(await host.evaluate(() => window.fullscreenMedia.isConnected), true);
      if (width === 1100) await host.screenshot({ path: path.join(evidence, `${engine}-native-fullscreen.png`) });
      await host.keyboard.press("Escape");
      await host.waitForFunction(() => !document.body.classList.contains("is-tauri-fullscreen-active"));
      assert.equal(shell.fullscreen, false);
      for (const selector of [".topbar", ".work-rail", ".host-workspace-region"]) {
        assert.equal(await host.locator(selector).isVisible(), true, `${selector} restored at ${width}px`);
      }
      assert.equal(await host.evaluate(() => window.fullscreenMedia.isConnected), true);
    }
    await host.evaluate(async () => {
      window.fullscreenMedia.remove();
      mountedLocalVideoElement = window.fullscreenSavedMountedVideo;
      state.data.current_item = window.fullscreenSavedItem;
      renderPlayerFullscreenButton();
      const displays = structuredClone(state.presentationDisplayInfo);
      applyPresentationDisplayInfo({ ...displays, monitorCount: 1, displays: displays.displays.slice(0, 1) });
      if (document.querySelectorAll(".presentation-display-option").length !== 1
          || !document.querySelector(".presentation-display-empty")) throw Error("single-display guidance missing");
      applyPresentationDisplayInfo({ ...displays, displays: displays.displays.map(display => ({
        ...display, selectable: false, mirrored: true,
      })) });
      if (!document.querySelector(".presentation-display-empty")) throw Error("mirrored displays must stay unavailable");
      applyPresentationDisplayInfo(displays);
      if (document.querySelector(".presentation-display-empty")) throw Error("extended display must be selectable");
    });
    await host.setViewportSize({ width: 1280, height: 800 });
    const expectedUrl = await host.evaluate(() => localRemoteAccessView(state.data.remote_access).url);
    assert.match(expectedUrl, /^http:\/\/.+\/remote$/);
    const expectedQr = await host.evaluate(() => state.data.remote_access.qr_image);
    const activate = async () => {
      await host.evaluate(() => { selectPresentationDisplay("d2"); return toggleLocalPresentation(); });
      await host.waitForFunction(() => state.presentationSession.phase === "active", null, { timeout: 15000 });
      const controller = shell.pages.controller;
      controller.on("pageerror", error => errors.push(`controller: ${error.message}`));
      await controller.waitForURL(url => url.pathname === "/controller.html");
      return controller;
    };
    const localEntry = controller => controller.evaluate(() => ({
      qrWidth: document.querySelector("#controller-remote-qr-image").naturalWidth,
      qrSource: document.querySelector("#controller-remote-qr-image").getAttribute("src") || "",
      href: document.querySelector("#controller-remote-url-link").getAttribute("href") || "",
      hint: document.querySelector("#controller-remote-url-hint").textContent.trim(),
    }));

    // Isolation control: without the shell relay the separate contexts must not
    // exchange output state, or the relay assertions below would prove nothing.
    let controller = await activate();
    await controller.waitForTimeout(3000);
    const isolated = await localEntry(controller);
    assert.equal(isolated.qrWidth, 0, JSON.stringify(isolated));
    assert.equal(isolated.href, "", JSON.stringify(isolated));
    await controller.screenshot({ path: path.join(evidence, `${engine}-isolated-without-relay.png`) });
    await host.evaluate(() => toggleLocalPresentation());
    await host.waitForFunction(() => state.presentationSession.phase === "inactive");

    shell.relay = true;
    controller = await activate();
    await controller.waitForFunction(() => document.querySelector("#controller-remote-qr-image").naturalWidth > 0,
      null, { timeout: 15000 });
    const relayed = await localEntry(controller);
    assert.equal(relayed.href, expectedUrl);
    assert.equal(relayed.qrSource, expectedQr);
    assert.ok(shell.relayed > 0);
    assert.equal(await controller.locator(".presentation-output-remote-popover").evaluate(node => getComputedStyle(node).visibility), "hidden");
    await controller.locator("#controller-exit").hover();
    await controller.waitForFunction(() => getComputedStyle(document.querySelector(".presentation-output-remote-popover")).opacity === "1");
    await controller.mouse.move(20, 300);
    await controller.waitForFunction(() => getComputedStyle(document.querySelector(".presentation-output-remote-popover")).visibility === "hidden");
    await controller.locator("#controller-exit").hover();
    await controller.waitForTimeout(300);
    await controller.screenshot({ path: path.join(evidence, `${engine}-relayed-local-entry.png`) });

    // Queue additions reach an isolated audience through the same native relay.
    await host.evaluate(() => {
      const next = structuredClone(state.data);
      next.state_revision += 1;
      next.revision += 1;
      next.playlist.push({ id: "notice-demo", display_title: "新点歌曲目", cache_status: "pending" });
      if (!acceptHostStateSnapshot(next)) throw Error("fixture snapshot rejected");
    });
    await controller.waitForFunction(() => document.querySelector("#controller-request-toast.is-visible")?.textContent.includes("新点歌曲目"));
    await controller.screenshot({ path: path.join(evidence, `${engine}-incoming-request.png`) });
    await controller.waitForTimeout(4800);
    await host.evaluate(() => publishPresentationOutputState());
    await controller.waitForTimeout(200);
    assert.equal(await controller.locator("#controller-request-toast").isVisible(), false);

    // Progress uses the existing role-scoped relay, including isolated reloads.
    // These are display fixtures, not evidence of a real media download.
    const savedCurrent = await host.evaluate(() => structuredClone(state.data.current_item));
    await host.evaluate(() => {
      state.data.current_item = { id: "audience-cache", display_title: "正在准备的歌曲", cache_status: "downloading",
        cache_message: "视频下载中", cache_download_current_bytes: 20, cache_download_total_bytes: 100 };
      publishPresentationOutputState();
    });
    const download = controller.locator(".presentation-download-status");
    await controller.waitForFunction(() => document.querySelector(".presentation-download-status progress")?.value === 20);
    assert.equal(await download.isVisible(), true);
    assert.equal(await download.locator("[data-download-title]").innerText(), "正在准备的歌曲");
    await controller.evaluate(() => {
      window.savedDownloadPanel = document.querySelector(".presentation-download-status");
      window.savedDownloadMedia = document.createElement("video");
      document.querySelector("#controller-stage-frame").appendChild(window.savedDownloadMedia);
    });
    const progressRevision = await host.evaluate(() => currentPresentationScene().revision);
    await host.evaluate(() => { state.data.current_item.cache_download_current_bytes = 40; publishPresentationOutputState(); });
    await controller.waitForFunction(() => document.querySelector(".presentation-download-status progress")?.value === 40);
    assert.deepEqual(await controller.evaluate(() => ({
      panel: window.savedDownloadPanel === document.querySelector(".presentation-download-status"),
      media: window.savedDownloadMedia.isConnected,
    })), { panel: true, media: true }, "Progress must not remount existing media");
    assert.equal(await host.evaluate(() => currentPresentationScene().revision), progressRevision);
    await controller.mouse.move(20, 300);
    await controller.waitForFunction(() => getComputedStyle(document.querySelector(".presentation-output-remote-popover")).visibility === "hidden");
    await controller.screenshot({ path: path.join(evidence, `${engine}-audience-download-progress.png`) });
    await host.evaluate(() => {
      state.data.current_item.cache_download_total_bytes = 0;
      state.data.current_item.cache_download_current_bytes = 0;
      state.data.current_item.cache_message = "<unsafe>正在连接</unsafe>";
      publishPresentationOutputState();
    });
    await controller.waitForFunction(() => {
      const panel = document.querySelector(".presentation-download-status");
      return panel && !panel.querySelector("progress").hasAttribute("value") && panel.textContent.includes("<unsafe>");
    });
    assert.equal(await download.locator("unsafe").count(), 0, "Details are plain text");
    await controller.reload();
    await controller.waitForFunction(() => document.querySelector(".presentation-download-status")?.textContent.includes("<unsafe>"));
    assert.equal(await download.isVisible(), true, "Reloaded audience receives the current progress");
    for (const status of ["pending", "failed", "ready"]) {
      await host.evaluate(status => {
        state.data.current_item.cache_status = status;
        state.data.current_item.cache_message = status;
        publishPresentationOutputState();
      }, status);
      await controller.waitForFunction(status => {
        const panel = document.querySelector(".presentation-download-status");
        return panel && (status === "ready" ? panel.hidden : !panel.hidden && panel.textContent.includes(status));
      }, status);
      assert.equal(await download.isVisible(), status !== "ready", status);
      assert.equal(await download.locator("progress").isVisible(), false, status);
    }
    await host.evaluate(current => { state.data.current_item = current; publishPresentationOutputState(); }, savedCurrent);
    await download.waitFor({ state: "hidden" });
    console.log("audience download progress: PASS");

    // Theme, language and the public room each follow the idle Host through the relay.
    await host.evaluate(() => applyTheme("dark"));
    await controller.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 15000 });
    await host.evaluate(() => setLanguage("ja"));
    await controller.waitForFunction(() => document.documentElement.lang === "ja", null, { timeout: 15000 });
    await host.evaluate(() => {
      document.dispatchEvent(new CustomEvent("bilikara:internet-remote-display", { detail: {
        mode: "internet", active: true, url: "https://example.test/room", password: "246810",
        qr_image: state.data.remote_access.qr_image, connected_count: 2,
      } }));
    });
    await controller.waitForFunction(() => document.querySelector("#controller-internet-remote-password").textContent === "246810"
      && document.querySelector("#controller-internet-remote-qr-image").naturalWidth > 0, null, { timeout: 15000 });
    await controller.locator("#controller-exit").hover();
    await controller.waitForTimeout(300);
    await controller.screenshot({ path: path.join(evidence, `${engine}-relayed-room-ja-dark.png`) });

    // A reloaded audience page asks the idle Host to replay its output.
    const relayedBeforeReload = shell.relayed;
    await controller.reload();
    await controller.waitForURL(url => url.pathname === "/controller.html");
    await controller.waitForFunction(() => document.querySelector("#controller-remote-qr-image").naturalWidth > 0
      && document.querySelector("#controller-internet-remote-password").textContent === "246810", null, { timeout: 15000 });
    assert.ok(shell.relayed > relayedBeforeReload);
    assert.equal((await localEntry(controller)).href, expectedUrl);

    await host.evaluate(() => toggleLocalPresentation());
    await host.waitForFunction(() => state.presentationSession.phase === "inactive");
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(evidence, `${engine}-results.json`), JSON.stringify({
      engine, expectedUrl, isolated, relayed: { href: relayed.href, qrWidth: relayed.qrWidth }, relayCount: shell.relayed,
    }, null, 2), "utf8");
    console.log(`PASS: ${engine} audience output crosses isolated WebView storage through the shell relay`);
  } finally {
    if (browser) await browser.close();
    if (ready) await fetch(ready.baseUrl + "/api/app/shutdown", { method: "POST",
      headers: { "X-Bilikara-Shutdown-Token": "fixture-private" } }).catch(() => {});
    if (server.exitCode === null) {
      const timer = setTimeout(() => server.kill("SIGKILL"), 25000);
      await once(server, "exit"); clearTimeout(timer);
    }
    lines.close(); await fs.rm(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
