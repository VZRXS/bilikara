// Full Host DOM with controlled output events. The Windows DLL/TS smoke is
// separate; this fixture does not claim a physical display or DLNA receiver.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { RunningHost, isolatedEnvironment } from "./native_host_support.mjs";

const executable = process.env.BILIKARA_TEST_SHOW_HOST_EXE;

test("DLNA uses the dual-screen console and returns to the local player", {
  skip: !executable && "set BILIKARA_TEST_SHOW_HOST_EXE to the native desktop Host",
  timeout: 45000,
}, async (t) => {
  const home = mkdtempSync(path.join(realpathSync.native(tmpdir()), "bilikara-cast-ui-"));
  const host = await RunningHost.start(executable, home,
    ["--data-dir", path.join(home, "data"), "--static-dir", path.resolve("static"), "--headless", "--port", "0"],
    isolatedEnvironment(home));
  let browser;
  t.after(async () => {
    await browser?.close();
    await host.close();
    rmSync(home, { recursive: true, force: true });
  });
  const device = { id: "test-tv", name: "测试大屏" };
  const state = await host.api("/api/state");
  const song = (id, name, requester) => ({
    id, item_incarnation_id: "inc-" + id, artifact_set_id: "set-" + id,
    bvid: "BV1z84y1p7oS", page: 1, title: name, display_title: name + " - 原唱",
    part_title: "原唱", selected_parts: ["原唱"], requester_name: requester,
    cache_status: "ready", cover_url: "", original_url: "", owner_name: "",
    video_media_url: "/media/artifacts/" + id + "/video.mp4",
    selected_audio_variant_id: "original",
    audio_variants: [{ id: "original", label: "原唱", page: 1, audio_url: "/media/artifacts/" + id + "/audio.m4a" }],
  });
  state.current_item = song("current", "当前歌曲", "Alice");
  Object.assign(state.current_item, {
    selected_pages: [1, 2],
    selected_parts: ["原唱", "伴奏"],
  });
  state.current_item.audio_variants.push({
    id: "instrumental", label: "伴奏", page: 2, audio_url: "/media/artifacts/current/audio-p2.m4a",
  });
  state.playlist = [song("next", "下一首", "Bob")];
  state.queue_version = "cast-ui-fixture";
  state.playback_generation += 1;
  state.revision += 1;
  state.state_revision += 100;
  state.playback_program = {
    item_id: state.current_item.id, item_incarnation_id: state.current_item.item_incarnation_id,
    selected_audio_variant_id: "original", artifact_set_id: state.current_item.artifact_set_id,
  };
  state.show_cast = { supported: true, available: true, phase: "idle", renderers: [] };
  const commands = [], captions = [], errors = [], castTransitions = [], selections = [];
  browser = await chromium.launch({ headless: true, channel: process.env.BILIKARA_TEST_CHROMIUM_CHANNEL });
  const context = await browser.newContext({ viewport: { width: 700, height: 600 } });
  await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
  await context.addInitScript(() => {
    localStorage.setItem("bilikara.ui.language", "zh");
    localStorage.setItem("bilikara.update.automatic", "false");
    window.__TAURI__ = {
      core: { invoke: async (command) => {
        if (command === "get_presentation_session" || command === "deactivate_local_presentation") {
          if (command === "deactivate_local_presentation") window.fixtureClosedPhysical = true;
          return { generation: command === "get_presentation_session" ? 0 : 1, phase: "inactive",
            mode: "singleScreen", playbackAuthority: "host", mediaRendererOwner: "host" };
        }
        if (command === "get_presentation_displays") return { monitorCount: 0, displays: [] };
        return null;
      } },
      event: { listen: async () => () => {} },
    };
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== host.base) return route.abort();
    const pathname = url.pathname;
    // Keep the local program mounted but avoid codec/download dependencies.
    if (pathname.startsWith("/media/")) return route.fulfill({ status: 200, body: "" });
    const send = (data) => route.fulfill({ json: { ok: true, data } });
    const changed = () => { state.state_revision += 1; return send(state); };
    if (pathname === "/api/state") return send(state);
    if (pathname === "/api/player/restart-program") {
      state.playback_generation += 1;
      state.revision += 1;
      return changed();
    }
    if (pathname === "/api/player/claim-program") return send({ claimed: true });
    if (pathname === "/api/player/retire-program") return send({ released: true });
    if (pathname === "/api/player/status") return send({ accepted: true });
    if (pathname === "/api/show-cast/discover") {
      Object.assign(state.show_cast, { phase: "discovering", renderers: [] });
      return changed();
    }
    if (pathname === "/api/show-cast/connect") {
      assert.deepEqual(route.request().postDataJSON(), { renderer_id: device.id });
      castTransitions.push(["connect", state.show_cast.phase]);
      state.cast_active = true;
      Object.assign(state.show_cast, { phase: "active", owns_playback: true, selected_renderer_id: device.id });
      state.player_status = { position_source: "show_sender", current_time: 12, duration: 60, is_paused: false, observed_phase: "playing" };
      return changed();
    }
    if (pathname === "/api/show-cast/hud") {
      captions.push(route.request().postDataJSON());
      return send({ accepted: true });
    }
    if (pathname === "/api/player/audio-variant") {
      const input = route.request().postDataJSON();
      selections.push(input);
      state.current_item.selected_audio_variant_id = input.variant_id;
      state.playback_program.selected_audio_variant_id = input.variant_id;
      state.playback_generation += 1;
      state.revision += 1;
      state.player_status.playback_generation = state.playback_generation;
      return changed();
    }
    if (pathname === "/api/player/control" || pathname === "/api/player/key-shift") {
      const input = route.request().postDataJSON();
      commands.push(input);
      if (pathname.endsWith("/key-shift")) state.player_settings.key_shift = input.key_shift;
      return changed();
    }
    if (pathname === "/api/show-cast/disconnect") {
      castTransitions.push(["disconnect", state.show_cast.phase]);
      if (state.show_cast.phase === "discovering") {
        state.show_cast.phase = "idle";
        return changed();
      }
      delete state.cast_active;
      delete state.player_status;
      state.playback_generation += 1;
      state.revision += 1;
      Object.assign(state.show_cast, {
        phase: "idle", owns_playback: false, selected_renderer_id: null,
        resume: { playback_generation: state.playback_generation, item_id: "current", current_time: 27, was_playing: false },
      });
      return changed();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(host.base);
  await page.locator("#player-frame video").waitFor({ state: "attached" });
  await page.evaluate(() => {
    state.presentationSession = { ...state.presentationSession, generation: 1, mode: "localDualScreen", phase: "active" };
    applyPresentationCompositionDom(1, "stageOnly");
  });
  await page.locator("#presentation-settings-toggle").click();
  const toggle = page.locator("#show-cast-switch");
  const refresh = page.locator("#show-cast-refresh");
  const deviceRow = page.getByRole("button", { name: "测试大屏" });
  const status = page.locator("#show-cast-status");
  const pushDevices = async (renderers) => {
    state.show_cast.renderers = renderers;
    state.state_revision += 1;
    await page.evaluate((snapshot) => {
      if (!acceptHostStateSnapshot(snapshot)) throw new Error("Discovery snapshot was not accepted");
      render();
    }, state);
  };
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("#show-cast-refresh").classList.contains("is-loading"));
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.getAttribute("aria-busy"), "true");
  assert.equal(await toggle.isEnabled(), true);
  assert.match(await status.textContent(), /正在搜索/);
  await pushDevices([device]);
  assert.equal(await deviceRow.isEnabled(), true);
  await deviceRow.focus();
  await pushDevices([{ id: "second-tv", name: "Another TV" }, device]);
  assert.equal(await deviceRow.evaluate((row) => document.activeElement === row), true);
  await deviceRow.click();
  assert.deepEqual(castTransitions, [["connect", "discovering"]]);
  assert.equal(await page.evaluate(() => window.fixtureClosedPhysical && state.presentationSession.phase === "inactive"), true);
  await page.locator("#presentation-host-controls").waitFor({ state: "visible" });
  assert.equal(await page.locator("#player-frame video, #player-frame audio").count(), 0);
  assert.equal(await page.locator("#presentation-host-announcement").isVisible(), true);
  assert.equal(await page.locator("#presentation-host-progress").isDisabled(), true);
  assert.equal(await page.locator("#presentation-host-progress").inputValue(), "12");
  assert.equal(await page.locator("#av-offset-input").isDisabled(), true);
  assert.equal(await page.locator("#presentation-host-forward").isEnabled(), true);
  assert.equal(await page.locator("#key-shift-panel input").isEnabled(), true);
  await page.locator("#presentation-settings-toggle").click();
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/player/audio-variant")),
    page.locator("#audio-variant-bar button[data-variant-id='instrumental']").click(),
  ]);
  assert.deepEqual(selections, [{
    item_id: "current", variant_id: "instrumental", expected_item_incarnation_id: "inc-current",
  }]);
  assert.equal(await page.locator("#player-frame video, #player-frame audio").count(), 0);
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/player/control")),
    page.locator("#presentation-host-forward").click(),
  ]);
  assert.equal(commands.at(-1).action, "seek-relative");
  assert.equal(commands.at(-1).delta_seconds, 15);
  if (!await page.locator("#key-shift-input").isVisible()) {
    await page.locator("#stage-controls-toggle").click();
  }
  await page.locator("#key-shift-input").fill("2");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/player/key-shift")),
    page.locator("#key-shift-input").press("Tab"),
  ]);
  assert.deepEqual(commands.at(-1), { key_shift: 2 });
  if (await page.locator("#stage-control-tray").getAttribute("aria-hidden") === "false") {
    await page.keyboard.press("Escape");
  }
  assert.equal(captions.at(-1).current, "当前歌曲");
  assert.deepEqual(captions.at(-1).upcoming, ["下一首"]);
  await page.locator("#presentation-settings-toggle").click();
  await page.locator("#show-cast-switch").click();
  await page.locator("#presentation-host-controls").waitFor({ state: "hidden" });
  await page.locator("#player-frame video").waitFor({ state: "attached" });
  assert.equal(await page.locator("#av-offset-input").isEnabled(), true);

  await toggle.click();
  await page.waitForFunction(() => document.querySelector("#show-cast-refresh").classList.contains("is-loading"));
  await toggle.click();
  await page.waitForFunction(() => document.querySelector("#show-cast-switch").getAttribute("aria-checked") === "false");
  assert.deepEqual(castTransitions, [["connect", "discovering"], ["disconnect", "active"], ["disconnect", "discovering"]]);
  assert.equal(await page.locator("#player-frame video").count(), 1);
  assert.deepEqual(errors, []);
});
