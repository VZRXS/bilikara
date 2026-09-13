"use strict";
// Production closures are exposed for observation only; their algorithms are
// loaded verbatim. SDP signaling is a local fixture; RTCPeerConnection, ordered
// DataChannels, authentication, decoder, Host dispatch, HTTP and FFI are real.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const [base, executablePath, output] = process.argv.slice(2);
const read = (file) => fs.readFileSync(path.join(__dirname, "../static", file), "utf8");
const checks = [], errors = [], external = [];
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function check(name, operation) {
  try { checks.push({ name, passed: true, evidence: await operation() }); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); }
}
async function main() {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) {
        external.push({ method: route.request().method(), origin: url.origin, path: url.pathname });
        if (route.request().method() === "DELETE" && url.origin === "https://rtc.kevinx96.icu") {
          return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
        }
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-methods": "DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type" } });
        throw new Error(`Unexpected external request blocked: ${url.origin}${url.pathname}`);
      }
      if (url.pathname === "/__fixture/host") return route.fulfill({ contentType: "text/html", body:
        read("index.html").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, "") });
      if (url.pathname === "/__fixture/remote") return route.fulfill({ contentType: "text/html", body:
        '<!doctype html><html><head><meta charset="utf-8"><title>Internet concurrency fixture</title><style>.hidden{display:none}body{font:18px sans-serif;padding:24px;background:#f4f7fa;color:#172536}pre{white-space:pre-wrap}</style></head><body><h1>Internet Remote · deterministic regression</h1><pre id="connection-evidence"></pre></body></html>' });
      return route.continue();
    });
    const host = await context.newPage(), remote = await context.newPage();
    for (const page of [host, remote]) {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    }
    await host.goto(`${base}/__fixture/host`);
    await remote.goto(`${base}/__fixture/remote#room=${"R".repeat(27)}&join=${"J".repeat(43)}`);
    for (const page of [host, remote]) {
      await page.addScriptTag({ content: read("internet-remote-transport.js") });
      await page.evaluate(() => { BilikaraInternetTransport.iceConfiguration = { iceServers: [] }; });
    }
    await host.addScriptTag({ content: read("internet-remote-host.js").replace(/\}\)\(\);\s*$/u,
      "window.__host = {state, peers, createPeer, stopRoom, publishState}; })();") });
    await remote.addScriptTag({ content: read("remote-transport-client.js").replace(/\}\)\(globalThis\);\s*$/u,
      "global.__remote = {state, acceptOffer, request, handleDataMessage, resetPeer, scheduleReconnect, ensureJoinOverlay}; })(globalThis);") });
    await host.exposeFunction("fixtureSignal", async (message) => {
      if (message.type === "offer") await remote.evaluate((description) => __remote.acceptOffer(description), message.payload);
    });
    await remote.exposeFunction("fixtureSignal", async (message) => {
      if (message.type === "answer") await host.evaluate((description) => __host.peers.get("browser-peer").pc.setRemoteDescription(description), message.payload);
    });
    async function connect() {
      await remote.evaluate(() => {
        clearTimeout(__remote.state.reconnectTimer);
        __remote.state.reconnectTimer = null;
        __remote.resetPeer();
        __remote.ensureJoinOverlay();
        __remote.state.overlay.classList.remove("hidden");
        __remote.state.remoteState = null;
        __remote.state.identity = "Fixture ID";
        __remote.state.password = "fixture-password";
        __remote.state.socket = { readyState: 1, close() {}, send: (wire) => void fixtureSignal(JSON.parse(wire)) };
      });
      await host.evaluate(async () => {
        Object.assign(__host.state, { password: "fixture-password", roomId: "R".repeat(27), hostToken: "H".repeat(43), stopped: false, mode: "internet" });
        __host.state.socket = { readyState: 1, close() {}, send: (wire) => void fixtureSignal(JSON.parse(wire)) };
        await __host.createPeer("browser-peer");
      });
      await remote.waitForFunction(() => __remote.state.authorized && __remote.state.pending.size === 0 && __remote.state.remoteState?.current_item &&
        __remote.state.overlay.classList.contains("hidden"));
    }
    await connect();
    const nativeFetch = async (route, body) => {
      const response = await fetch(base + route, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return response.json();
    };
    const send = (route, body) => remote.evaluate(async ({ route, body }) => (await fetch(route, {
      method: "POST", body: JSON.stringify(body) })).json(), { route, body });
    const initial = (await nativeFetch("/api/state")).data;
    const target = { item_id: initial.current_item.id, playback_generation: initial.playback_generation };
    const apply = read("app.js").slice(read("app.js").indexOf("function applyRemotePlayerControl("), read("app.js").indexOf("function observedHostPlayerStatus("));
    // A real seekable HTMLVideoElement; only unrelated playback/session plumbing
    // is fixture-owned. applyRemotePlayerControl and ACK are production source.
    await host.evaluate(({ initial, apply }) => {
      document.body.insertAdjacentHTML("afterbegin", '<section id="concurrency-evidence" style="position:fixed;inset:0;z-index:999999;background:#f4f7fa;padding:32px;color:#172536"><h1>LAN / Internet concurrency baseline</h1><p>Real Chromium video + WebRTC DataChannels + desktop HTTP / Rust FFI</p><div id="fixture-player"><video controls preload="auto" width="640" src="/__fixture/media.webm"></video></div><pre id="fixture-result"></pre></section>');
      const video = document.querySelector("#fixture-player video");
      const state = { data: initial, hostPlaybackSession: { playbackGeneration: initial.playback_generation }, lastAppliedPlayerControlSeq: 0, localShouldBePlaying: false };
      const elements = { playerFrame: document.querySelector("#fixture-player") };
      const isCurrentHostPlaybackSession = (session) => session === state.hostPlaybackSession;
      const setMediaCurrentTime = (media, at) => { media.currentTime = at; window.__seekAssignment = {
        requested: at, immediatelyAfter: media.currentTime, duration: media.duration,
        seekable: Array.from({ length: media.seekable.length }, (_, i) => [media.seekable.start(i), media.seekable.end(i)]),
      }; };
      const apiPost = async (route, body) => (await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      const requestNextTrack = (generation) => apiPost("/api/player/next", { playback_generation: generation });
      eval(`${apply}; window.__player = {state, video, applyRemotePlayerControl};`);
    }, { initial, apply });
    try {
      await host.waitForFunction(() => __player.video.readyState >= 2 && __player.video.duration >= 59 &&
        __player.video.seekable.length && __player.video.seekable.end(0) >= 59, null, { timeout: 10000 });
    } catch (error) {
      throw new Error(JSON.stringify(await host.evaluate(() => ({ ready: __player.video.readyState,
        duration: __player.video.duration, error: __player.video.error?.message, src: __player.video.currentSrc }))), { cause: error });
    }
    await check("real_webrtc_authenticated_two_ordered_lanes", async () => {
      const result = await remote.evaluate(() => ({
        real: __remote.state.peer instanceof RTCPeerConnection,
        connection: __remote.state.peer.connectionState,
        control: { label: __remote.state.control.label, ordered: __remote.state.control.ordered },
        bulk: { label: __remote.state.bulk.label, ordered: __remote.state.bulk.ordered },
        overlayHidden: __remote.state.overlay.classList.contains("hidden"),
      }));
      assert.equal(result.connection, "connected"); assert.equal(result.real, true);
      assert.equal(result.control.ordered && result.bulk.ordered && result.overlayHidden, true);
      return result;
    });
    await check("browser_consumes_both_accepted_relative_seeks", async () => {
      const accepted = await Promise.all([
        nativeFetch("/api/player/control", { ...target, action: "seek-relative", delta_seconds: 7 }),
        send("/api/player/control", { ...target, action: "seek-relative", delta_seconds: 11 }),
      ]);
      assert(accepted.every((result) => result.ok));
      const commands = [];
      // Explicitly wait for both acceptances before the first Host observation.
      for (let n = 0; n < 4; n++) {
        const command = (await nativeFetch("/api/state")).data.player_control_command;
        if (!command) break;
        commands.push(command);
        await host.evaluate((command) => __player.applyRemotePlayerControl(command, __player.state.data.current_item, "local"), command);
        // Idempotent duplicate ACK also makes the consumption barrier explicit.
        await nativeFetch("/api/player/control-ack", { seq: command.seq });
      }
      const position = await host.evaluate(() => __player.video.currentTime);
      await host.evaluate((data) => { document.querySelector("#fixture-result").textContent = JSON.stringify(data, null, 2); }, { position, expected: 18, accepted: 2, delivered: commands.length });
      assert.equal(position, 18, JSON.stringify({ commands, position, expected: 18,
        assignment: await host.evaluate(() => window.__seekAssignment || { seq: __player.state.lastAppliedPlayerControlSeq, state: __player.state }) }));
      return { position, commands: commands.length };
    });
    await check("browser_ignores_old_generation_control", async () => {
      const accepted = await nativeFetch("/api/player/control", { ...target,
        action: "seek-relative", delta_seconds: 20 });
      assert.equal(accepted.ok, true);
      const command = (await nativeFetch("/api/state")).data.player_control_command;
      assert(command, "fixture must capture a real accepted command before switching generation");
      assert.equal((await nativeFetch("/api/player/restart-program", {})).ok, true);
      const current = (await nativeFetch("/api/state")).data;
      assert.equal(current.player_control_command, null);
      const rejected = await nativeFetch("/api/player/control", { ...target, action: "pause" });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, "stale_command");
      Object.assign(target, { item_id: current.current_item.id, playback_generation: current.playback_generation });
      await host.evaluate((data) => {
        __player.state.data = data;
        __player.state.hostPlaybackSession.playbackGeneration = data.playback_generation;
      }, current);
      const result = await host.evaluate((command) => {
        const before = __player.video.currentTime;
        __player.applyRemotePlayerControl(command, __player.state.data.current_item, "local");
        return { before, after: __player.video.currentTime };
      }, command);
      assert.equal(result.after, result.before); return result;
    });
    await check("bulk_delay_does_not_block_control_datachannel", async () => {
      const entered = deferred(), release = deferred();
      const pattern = "**/api/internet-remote/dispatch";
      const handler = async (route) => {
        const envelope = JSON.parse(route.request().postDataJSON().message);
        if (envelope.kind !== "catalog.search") return route.fallback();
        entered.resolve(); await release.promise;
        await route.fulfill({ json: { ok: true, data: { request_id: envelope.id, sequence: envelope.seq,
          accepted: true, stale: false, revision: 1, data: { items: [] } } } });
      };
      await host.route(pattern, handler);
      let searchDone = false;
      const search = remote.evaluate(async () => (await fetch("/api/catalog/search?q=synthetic")).json()).then((r) => { searchDone = true; return r; });
      await entered.promise;
      try {
        const response = await send("/api/player/key-shift", { key_shift: 2 });
        assert.equal(response.ok, true); assert.equal(searchDone, false);
      } finally { release.resolve(); await search; await host.unroute(pattern, handler); }
      return { controlCompletedBeforeBulkRelease: true, bulkMetadata: "local fixture" };
    });
    await check("internet_relative_av_delay_preserves_concurrent_lan_increment", async () => {
      await nativeFetch("/api/player/av-delay-action", { type: "set_effective", effective_delay_ms: 0 });
      await host.evaluate(() => __host.publishState());
      await remote.waitForFunction(() => __remote.state.remoteState.player_settings.effective_av_delay_ms === 0);
      // Delay the actual translated Internet request until LAN's increment is
      // committed. The click-time baseline is intentionally still zero.
      const entered = deferred(), release = deferred();
      let translated;
      const pattern = "**/api/internet-remote/dispatch";
      const handler = async (route) => {
        const envelope = JSON.parse(route.request().postDataJSON().message);
        if (!["player.set_av_delay", "player.av_delay_action"].includes(envelope.kind)) return route.fallback();
        translated = envelope; entered.resolve(); await release.promise; return route.continue();
      };
      await host.route(pattern, handler);
      const internet = send("/api/player/av-delay-action", { type: "adjust", delta_ms: 50 });
      await entered.promise;
      try { await nativeFetch("/api/player/av-delay-action", { type: "adjust", delta_ms: 50 }); }
      finally { release.resolve(); await internet; await host.unroute(pattern, handler); }
      const actual = (await nativeFetch("/api/state")).data.player_settings.av_offset_ms;
      assert.equal(actual, 100, JSON.stringify({ actual, expected: 100, translated: translated.body }));
      return { actual };
    });
    await check("timeout_reconnect_late_response_does_not_resubmit_mutation", async () => {
      const committed = deferred(), release = deferred();
      const pattern = "**/api/internet-remote/dispatch";
      let mutationSends = 0;
      const handler = async (route) => {
        const envelope = JSON.parse(route.request().postDataJSON().message);
        if (envelope.kind !== "player.set_key_shift" || envelope.body.key_shift !== 4) return route.fallback();
        mutationSends++;
        // Actual HTTP/FFI mutation commits, but its response is held until the
        // client has timed out AND authenticated a replacement RTC connection.
        const response = await route.fetch();
        committed.resolve(); await release.promise;
        return route.fulfill({ response });
      };
      await host.route(pattern, handler);
      await remote.evaluate(() => {
        window.__nativeTimer = window.setTimeout;
        window.setTimeout = (callback, ms, ...args) => {
          if (ms === 15000) window.__requestTimeout = callback;
          return __nativeTimer(callback, ms, ...args);
        };
      });
      const mutation = send("/api/player/key-shift", { key_shift: 4 });
      await committed.promise;
      try {
        assert.equal((await nativeFetch("/api/state")).data.player_settings.key_shift, 4);
        await remote.evaluate(() => { window.setTimeout = __nativeTimer; __requestTimeout(); __remote.scheduleReconnect(); });
        const response = await mutation;
        assert.equal(response.ok, false); assert.match(response.error, /超时/u);
        // Real channels are rebuilt; production acceptOffer/resetPeer and
        // password/identity authentication execute again with a new epoch.
        await host.evaluate(() => { window.__latePeer = __host.peers.get("browser-peer"); });
        await connect();
      } finally {
        release.resolve();
        await remote.evaluate(() => { window.setTimeout = __nativeTimer; });
      }
      // Wait for the actual old Host lane to finish its delayed HTTP response.
      // sendPeer checks peer identity and discards the retired peer's reply.
      await host.evaluate(() => window.__latePeer.queues.control);
      await host.unroute(pattern, handler);
      assert.equal(mutationSends, 1);
      assert.equal((await nativeFetch("/api/state")).data.player_settings.key_shift, 4);
      return { mutationSends, committedDespiteClientTimeout: true, reauthenticatedBeforeLateResponse: true,
        pending: await remote.evaluate(() => __remote.state.pending.size) };
    });
    await check("close_rebuild_room_with_real_webrtc_keeps_lan_usable", async () => {
      await host.evaluate(() => __host.stopRoom(true));
      assert.equal((await nativeFetch("/api/player/key-shift", { key_shift: 1 })).ok, true);
      await connect();
      assert.equal((await send("/api/player/key-shift", { key_shift: 3 })).ok, true);
      assert.equal((await nativeFetch("/api/player/key-shift", { key_shift: -1 })).ok, true);
      assert.equal((await nativeFetch("/api/state")).data.player_settings.key_shift, -1);
      return { roomRebuilt: true, lanDuringClosedRoom: true, network: "loopback; fixture signaling" };
    });
    await host.screenshot({ path: path.join(output, "host-consumption.png") });
    await remote.evaluate(() => { document.querySelector("#connection-evidence").textContent = JSON.stringify({
      connection: __remote.state.peer.connectionState, authenticated: __remote.state.authorized,
      identity: __remote.state.identity, control: __remote.state.control.label, bulk: __remote.state.bulk.label,
      pendingRequests: __remote.state.pending.size, signaling: "Local SDP fixture; no external STUN/TURN",
    }, null, 2); });
    await remote.screenshot({ path: path.join(output, "remote-connection.png") });
    await check("browser_identity_render_and_console", async () => {
      assert.equal(await host.locator("#concurrency-evidence video").isVisible(), true);
      assert.equal(await remote.locator(".internet-remote-join-overlay").evaluate((e) => e.classList.contains("hidden")), true);
      assert.equal(new URL(host.url()).pathname, "/__fixture/host");
      assert.equal(new URL(remote.url()).pathname, "/__fixture/remote");
      assert.deepEqual(errors, []); return { errors, screenshots: ["host-consumption.png", "remote-connection.png"] };
    });
    await remote.evaluate(() => BilikaraRemoteTransport.disconnect());
    await host.evaluate(() => __host.stopRoom(true));
    await context.close();
  } finally { await browser.close(); }
}
main().catch((error) => checks.push({ name: "harness", passed: false, error: error.stack })).finally(() => {
  const result = { passed: checks.every((c) => c.passed), checks, errors, external,
    scope: "local Chromium; fixture SDP signaling; no STUN/TURN/NAT or phone acceptance" };
  fs.writeFileSync(path.join(output, "browser-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
});
