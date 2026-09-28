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
  main: new Set(["get_presentation_session", "get_presentation_displays", "activate_local_presentation",
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
    await controller.locator("#controller-exit").hover();
    await controller.waitForTimeout(300);
    await controller.screenshot({ path: path.join(evidence, `${engine}-relayed-local-entry.png`) });

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
