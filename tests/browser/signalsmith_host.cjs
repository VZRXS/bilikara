"use strict";
// Isolated real Host, real shared player, synthetic fixture files only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const playwright = require("playwright");

(async () => {
  const [binary, directory, videoFile, audioFile, engine = "webkit", mode = "supported"] = process.argv.slice(2);
  assert(binary && directory && videoFile && audioFile);
  await fs.mkdir(directory, {recursive: true});
  const host = spawn(path.resolve(binary), [path.resolve(directory), path.resolve(__dirname, "../../static"), path.resolve(videoFile), path.resolve(audioFile), "3"], {stdio: ["pipe", "pipe", "pipe"]});
  let hostErrors = "";
  host.stderr.on("data", data => { hostErrors += data; });
  const lines = createInterface({input: host.stdout});
  let browser, page;
  const errors = [], warnings = [], snapshots = [], httpErrors = [];
  const snapshot = async (label) => {
    const data = await page.evaluate(() => {
      const {video, audio} = activeLocalPlayerElements();
      return {item: state.data?.current_item?.id, phase: state.hostPlaybackSession?.phase,
        capabilityFailure: state.pitchContextFailure || null,
        pitch: audio?.bilikaraPitch?.snapshot(), videoTime: video?.currentTime, audioTime: audio?.currentTime,
        paused: audio?.paused, videoPaused: video?.paused, videoReady: video?.readyState, audioReady: audio?.readyState, videoDuration: video?.duration, audioDuration: audio?.duration, blocked: [state.localVideoPlaybackBlocked, state.localAudioPlaybackBlocked], held: state.localVideoHeldForAudio, startupSettled: state.localPlaybackStartPromisesSettled, requested: state.data?.player_settings?.key_shift,
        avDelay: state.data?.player_settings?.av_delay_ms, shouldPlay: state.localShouldBePlaying,
        drift: video && audio ? splitSyncSnapshot(video, audio, currentAvOffsetSeconds(), "test").drift_seconds : null};
    });
    snapshots.push({label, ...data}); return data;
  };
  try {
    const bootstrap = JSON.parse((await Promise.race([
      once(lines, "line"),
      once(host, "exit").then(([code]) => { throw new Error(`Host exited ${code}: ${hostErrors}`); }),
    ]))[0]).bootstrap_url;
    browser = await playwright[engine].launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: "zh-CN"});
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) warnings.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) httpErrors.push({path: new URL(response.url()).pathname, status: response.status()}); });
    await page.goto(bootstrap);
    await page.waitForFunction(() => typeof state !== "undefined" && state.hostPlaybackSession?.readyCommitted);
    assert.equal(await page.title(), "bilikara host");
    await page.evaluate(() => {
      window.pitchSources = 0;
      const create = AudioContext.prototype.createMediaElementSource;
      AudioContext.prototype.createMediaElementSource = function(...args) { window.pitchSources++; return create.apply(this, args); };
      window.oldPitchNodes = [];
      window.pitchTrace = [];
      const sync = syncSplitPlayer;
      syncSplitPlayer = function(video, audio, ...args) {
        const result = sync(video, audio, ...args);
        const p = audio.bilikaraPitch;
        if (p && (pitchTrace.at(-1)?.result !== result || pitchTrace.at(-1)?.pitch !== p.phase)) {
          pitchTrace.push({result, pitch: p.phase, v:video.currentTime, a:audio.currentTime, vp:video.paused, ap:audio.paused, vr:video.readyState, ar:audio.readyState, vb:state.localVideoPlaybackBlocked, ab:state.localAudioPlaybackBlocked, phase:state.hostPlaybackSession.phase});
        }
        return result;
      };
    });
    const start = page.locator(".split-playback-start-button");
    if (await start.isVisible()) await start.click();
    else if (await page.evaluate(() => state.hostPlaybackSession.audio.paused)) await page.locator("#player-frame video").click();
    const tray = page.locator("#stage-controls-toggle");
    if (await tray.isVisible() && await tray.getAttribute("aria-expanded") !== "true") await tray.click();
    await page.waitForFunction(() => state.hostPlaybackSession?.audio?.currentTime > .3 && !state.hostPlaybackSession.audio.paused);
    assert.equal(await page.evaluate(() => Boolean(state.hostPlaybackSession.audio.bilikaraPitch)), false);
    if (mode === "clock-fallback-boost") {
      await page.evaluate(() => setLocalPlayerVolumeAndMuted(5, false));
    }
    const shift = async (value) => {
      await page.locator("#key-shift-input").fill(String(value));
      await page.locator("#key-shift-input").dispatchEvent("change");
      await page.waitForFunction(value => state.data.player_settings.key_shift === value, value);
    };
    const active = value => page.waitForFunction(value => {
      const p = state.hostPlaybackSession?.audio?.bilikaraPitch;
      return p?.phase === "active" && p.applied === value;
    }, value);
    await shift(3);
    if (mode.startsWith("clock-fallback")) {
      await page.waitForFunction(() => state.pitchContextFailure === "media-clock"
        && state.hostPlaybackSession?.readyCommitted && !state.hostPlaybackSession.audio.paused
        && !state.hostPlaybackSession.audio.bilikaraPitchSource);
      assert.equal(await page.evaluate(() => state.data.player_settings.key_shift), 3);
      if (mode === "clock-fallback-boost") {
        assert.equal(await page.evaluate(() => state.localPlayerVolume), 5);
        assert.equal(await page.evaluate(() => state.hostPlaybackSession.audio.volume), 1);
      }
      assert(await page.locator("#pitch-status").isVisible());
      const recovery = await snapshot("unavailable-native-recovery");
      assert(Math.abs(recovery.drift) < .15, JSON.stringify(recovery));
      await page.evaluate(() => {
        const {video, audio} = activeLocalPlayerElements();
        setSplitPlaybackIntent(video, audio, false, {source: "fallback-pause"});
        beginSplitPlayerSeek(video, audio, {targetTime: 8, resumeAfterSeek: false});
      });
      await page.waitForFunction(() => !state.hostPlaybackSession.seekSettling);
      assert.equal((await snapshot("fallback-paused-seek")).paused, true);
      await page.locator("#key-shift-input").click();
      await page.evaluate(() => { const {video, audio} = activeLocalPlayerElements(); setSplitPlaybackIntent(video, audio, true, {userGesture: true}); });
      await page.waitForFunction(() => !state.hostPlaybackSession.audio.paused && state.hostPlaybackSession.audio.currentTime > 8.3);
      await snapshot("fallback-resume");
      await shift(0);
      assert.equal(await page.locator("#pitch-status").isVisible(), false);
      await page.screenshot({path: path.join(directory, "host-fallback.png"), fullPage: false});
      assert.deepEqual(errors, []);
      const report = {engine, version: browser.version(), mode, snapshots, errors, warnings, httpErrors};
      await fs.writeFile(path.join(directory, "host.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      return;
    }
    await active(3); await snapshot("plus3");
    await page.evaluate(() => { window.firstPitchNode = state.hostPlaybackSession.audio.bilikaraPitch.node; });
    await shift(-6); await active(-6);
    assert(await page.evaluate(() => firstPitchNode === state.hostPlaybackSession.audio.bilikaraPitch.node));
    await page.evaluate(async () => { await Promise.all([setLocalPlayerKeyShift(-3), setLocalPlayerKeyShift(3), setLocalPlayerKeyShift(6)]); });
    await active(6); await snapshot("rapid-latest");
    await shift(0);
    await page.waitForFunction(() => state.hostPlaybackSession.audio.bilikaraPitch.phase === "direct");
    assert.equal(await page.evaluate(() => pitchSources), 1);
    await snapshot("zero");
    await shift(3); await active(3);
    await page.evaluate(() => { const {video, audio} = activeLocalPlayerElements(); setSplitPlaybackIntent(video, audio, false, {source: "test-pause"}); });
    await page.waitForFunction(() => state.hostPlaybackSession.audio.paused && state.hostPlaybackSession.video.paused);
    assert.equal(await page.evaluate(() => state.hostPlaybackSession.audio.bilikaraPitch.gate.gain.value), 0);
    await page.evaluate(() => { const {video, audio} = activeLocalPlayerElements(); beginSplitPlayerSeek(video, audio, {targetTime: 8, resumeAfterSeek: false}); });
    await page.waitForFunction(() => !state.hostPlaybackSession.seekSettling);
    assert.equal((await snapshot("paused-seek")).paused, true);
    // A real click supplies WebKit's gesture; the normal Host resume handler owns play().
    await page.locator("#key-shift-input").click();
    await page.evaluate(() => { const {video, audio} = activeLocalPlayerElements(); setSplitPlaybackIntent(video, audio, true, {source: "test-resume", userGesture: true}); });
    await active(3);
    await page.evaluate(() => { const {video, audio} = activeLocalPlayerElements(); beginSplitPlayerSeek(video, audio, {targetTime: 15, resumeAfterSeek: true}); });
    await active(3); await snapshot("playing-seek");
    for (const offset of [-250, 300, 0]) {
      await page.evaluate(offset => setAvOffset(offset), offset);
      await active(3);
      const data = await snapshot(`offset-${offset}`);
      assert(Math.abs(data.drift) < .12, JSON.stringify(data));
    }
    // Repeated transitions under small concurrent UI work, with one retained source.
    for (let i = 0; i < 6; i++) {
      await shift(0); await page.waitForFunction(() => state.hostPlaybackSession.audio.bilikaraPitch.phase === "direct");
      await shift(i % 2 ? 3 : -3); await active(i % 2 ? 3 : -3);
      await page.evaluate(() => { for (let i = 0; i < 20; i++) renderKeyShiftControls("local"); });
    }
    assert.equal(await page.evaluate(() => pitchSources), 1);
    await page.evaluate(() => { window.retiredPitchAudio = state.hostPlaybackSession.audio; });
    await page.locator('#audio-variant-bar [data-variant-id="p2_instrumental"]').click();
    await page.waitForFunction(() => state.hostPlaybackSession.audio !== window.retiredPitchAudio);
    await active(3);
    assert.equal(await page.evaluate(() => retiredPitchAudio.bilikaraPitch), null);
    await snapshot("variant-replacement");
    await page.screenshot({path: path.join(directory, "host-pitch.png"), fullPage: false});
    await page.locator("#next-button").click();
    await page.waitForFunction(() => state.data.current_item?.id === "fixture-second");
    await page.waitForFunction(() => typeof state !== "undefined" && state.hostPlaybackSession?.readyCommitted);
    await active(3);
    await snapshot("explicit-next");
    // Exercise real input ending and wait for the Host's tail/advance contract.
    await page.evaluate(() => {
      const {video, audio} = activeLocalPlayerElements();
      window.tailObservation = {};
      audio.addEventListener("ended", () => { tailObservation.inputEnded = performance.now(); }, {once: true});
      beginSplitPlayerSeek(video, audio, {targetTime: Math.max(0, audio.duration - 1), resumeAfterSeek: true});
    });
    await page.waitForFunction(() => window.tailObservation.inputEnded);
    await page.waitForFunction(() => state.data.current_item?.id !== "fixture-second");
    const tailElapsedMs = await page.evaluate(() => performance.now() - tailObservation.inputEnded);
    assert(tailElapsedMs >= 200, String(tailElapsedMs));
    await snapshot("natural-end");
    assert.deepEqual(errors, []);
    const report = {engine, version: browser.version(), snapshots, tailElapsedMs, errors, warnings};
    await fs.writeFile(path.join(directory, "host.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    if (page) { try { await snapshot("failure"); await page.screenshot({path: path.join(directory, "failure.png")}); } catch {} }
    console.error(JSON.stringify({snapshots, errors, warnings, trace: page ? await page.evaluate(() => window.pitchTrace) : []})); throw error;
  } finally { await browser?.close(); host.stdin.end(); host.kill(); lines.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
