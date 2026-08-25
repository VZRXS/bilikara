"use strict";

const { chromium } = require("playwright");

const [baseUrl, scenario, executablePath] = process.argv.slice(2);
const observations = [];
const consoleErrors = [];
const pageErrors = [];

function assert(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(message);
    error.detail = detail;
    throw error;
  }
}

async function waitFor(fn, message, timeoutMs = 12000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      if (lastValue) {
        return lastValue;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(message);
  error.detail = { lastValue, lastError: lastError?.message || "" };
  throw error;
}

async function state(page) {
  const response = await page.request.get(`${baseUrl}/api/state`);
  assert(response.ok(), "state endpoint failed", response.status());
  const payload = await response.json();
  assert(payload?.ok === true, "state payload was rejected", payload);
  return payload.data;
}

function descriptor(item) {
  return {
    id: item?.id || "",
    artifactSetId: item?.artifact_set_id || "",
    directory: item?.artifact_relative_directory || "",
    videoUrl: item?.video_media_url || "",
    audioUrl: item?.audio_variants?.[0]?.audio_url || "",
    status: item?.cache_status || "",
    selectedVariant: item?.selected_audio_variant_id || "",
  };
}

async function media(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video[data-player-role="video"]');
    const audio = document.querySelector('audio[data-player-role="audio"]');
    return {
      present: Boolean(video && audio),
      itemId: video?.dataset.playerItemId || "",
      videoSrc: video?.getAttribute("src") || "",
      audioSrc: audio?.getAttribute("src") || "",
      currentTime: Number(video?.currentTime || 0),
      audioTime: Number(audio?.currentTime || 0),
      duration: Number(video?.duration || 0),
      paused: Boolean(video?.paused),
      ended: Boolean(video?.ended),
      readyState: Number(video?.readyState || 0),
      audioReadyState: Number(audio?.readyState || 0),
      preparing: Boolean(document.querySelector("#player-frame .empty-state")),
      replacementCount: Number(window.__acceptanceReplacementCount || 0),
      replacements: Array.isArray(window.__acceptanceReplacements)
        ? window.__acceptanceReplacements.slice()
        : [],
      naturalEndedCount: Number(window.__acceptanceNaturalEndedCount || 0),
    };
  });
}

async function waitForMedia(page, itemId) {
  return waitFor(async () => {
    const value = await media(page);
    return value.present
      && value.itemId === itemId
      && value.readyState >= 1
      && value.audioReadyState >= 1
      ? value
      : null;
  }, `media did not become ready for ${itemId}`);
}

async function clickPlayer(page) {
  await page.locator("#player-frame").click({ position: { x: 40, y: 40 } });
}

async function startPlayback(page, itemId, minimumTime = 0.65) {
  await waitForMedia(page, itemId);
  const before = await media(page);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const autoplayProbe = await media(page);
  const alreadyPlaying = !autoplayProbe.paused
    && autoplayProbe.currentTime > before.currentTime + 0.1;
  if (!alreadyPlaying) {
    await clickPlayer(page);
  }
  const started = await waitFor(async () => {
    const value = await media(page);
    return !value.paused && value.currentTime > minimumTime ? value : null;
  }, `real playback clock did not start for ${itemId}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stable = await media(page);
  assert(!stable.paused && stable.currentTime > started.currentTime + 0.1, `real playback did not remain stable for ${itemId}`, { started, stable });
  observations.push({
    boundary: `${itemId}-playback-started`,
    startAction: alreadyPlaying ? "product-autoplay" : "player-frame-click",
    media: stable,
  });
  return stable;
}

async function observeAutomaticPlayback(page, itemId, minimumTime = 0.15) {
  await waitForMedia(page, itemId);
  const before = await media(page);
  const started = await waitFor(async () => {
    const value = await media(page);
    return value.itemId === itemId
      && !value.paused
      && value.currentTime > Math.max(minimumTime, before.currentTime + 0.1)
      ? value
      : null;
  }, `automatic real playback clock did not start for ${itemId}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const stable = await media(page);
  assert(
    stable.itemId === itemId
      && !stable.paused
      && stable.currentTime > started.currentTime + 0.1,
    `automatic real playback did not remain stable for ${itemId}`,
    { before, started, stable },
  );
  observations.push({
    boundary: `${itemId}-automatic-playback-observed`,
    startAction: "product-autoplay",
    media: stable,
  });
  return stable;
}

async function pausePlayback(page, itemId) {
  await clickPlayer(page);
  const paused = await waitFor(async () => {
    const value = await media(page);
    return value.itemId === itemId && value.paused && value.currentTime > 0.2
      ? value
      : null;
  }, `real playback did not pause for ${itemId}`);
  observations.push({ boundary: `${itemId}-paused`, media: paused });
  return paused;
}

async function rangeRead(page, url, start = 0, end = 127) {
  const response = await page.request.get(`${baseUrl}${url}`, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  const body = await response.body();
  return {
    status: response.status(),
    length: body.length,
    contentRange: response.headers()["content-range"] || "",
    firstByte: body.length ? body[0] : null,
    lastByte: body.length ? body[body.length - 1] : null,
  };
}

async function installReplacementObserver(page) {
  await page.evaluate(() => {
    const frame = document.querySelector("#player-frame");
    window.__acceptanceReplacementCount = 0;
    window.__acceptanceReplacements = [];
    window.__acceptanceOriginalVideo = frame?.querySelector(
      'video[data-player-role="video"]',
    ) || null;
    let previousVideo = window.__acceptanceOriginalVideo;
    window.clearInterval(window.__acceptanceOldMediaSampler);
    window.__acceptanceLastOldObservation = {
      currentTime: Number(previousVideo?.currentTime || 0),
      paused: Boolean(previousVideo?.paused),
      src: previousVideo?.getAttribute("src") || "",
    };
    window.__acceptanceOldMediaSampler = window.setInterval(() => {
      if (window.__acceptanceOriginalVideo?.isConnected) {
        window.__acceptanceLastOldObservation = {
          currentTime: Number(window.__acceptanceOriginalVideo.currentTime || 0),
          paused: Boolean(window.__acceptanceOriginalVideo.paused),
          src: window.__acceptanceOriginalVideo.getAttribute("src") || "",
        };
      }
    }, 10);
    window.__acceptanceReplacementObserver?.disconnect?.();
    window.__acceptanceReplacementObserver = new MutationObserver(() => {
      const nextVideo = frame?.querySelector('video[data-player-role="video"]') || null;
      if (nextVideo !== previousVideo) {
        const sampledOld = window.__acceptanceLastOldObservation || {};
        window.__acceptanceReplacementCount += 1;
        window.__acceptanceReplacements.push({
          oldTime: Number(sampledOld.currentTime || 0),
          oldPaused: Boolean(sampledOld.paused),
          oldSrc: sampledOld.src || "",
          nextSrc: nextVideo?.getAttribute("src") || "",
          observedAt: performance.now(),
        });
        previousVideo = nextVideo;
      }
    });
    window.__acceptanceReplacementObserver.observe(frame, {
      childList: true,
      subtree: true,
    });
  });
}

async function clickCurrentRecache(page) {
  const settingsToggle = page.locator("#cache-settings-toggle");
  if ((await settingsToggle.getAttribute("aria-expanded")) !== "true") {
    await settingsToggle.click();
  }
  const advancedToggle = page.locator("#cache-panel-advanced-trigger");
  if ((await advancedToggle.getAttribute("aria-expanded")) !== "true") {
    await advancedToggle.click();
  }
  const button = page.locator("#current-cache-retry-button");
  await button.click();
  await waitFor(
    async () => (await button.getAttribute("aria-busy")) !== "true",
    "current recache button remained busy",
  );
  await settingsToggle.click();
}

async function clickPlayNow(page, itemId) {
  const item = page.locator(`.song-item[data-id="${itemId}"]`);
  await item.locator('button[data-action="toggle-menu"]').click();
  await item.locator('button[data-action="play-now"]').click();
}

async function oldDescriptorAndRange(page) {
  const snapshot = await state(page);
  const old = descriptor(snapshot.current_item);
  assert(old.status === "ready", "current item was not Ready before recache", old);
  assert(old.artifactSetId && old.directory, "old immutable descriptor was incomplete", old);
  const videoRange = await rangeRead(page, old.videoUrl);
  const audioRange = await rangeRead(page, old.audioUrl);
  assert(videoRange.status === 206 && videoRange.length > 0, "old video Range failed", videoRange);
  assert(audioRange.status === 206 && audioRange.length > 0, "old audio Range failed", audioRange);
  return { snapshot, old, videoRange, audioRange };
}

async function assertRefreshStillCommitted(page, old, beforeTime, shouldAdvance) {
  await new Promise((resolve) => setTimeout(resolve, 450));
  const duringState = await state(page);
  const during = descriptor(duringState.current_item);
  const duringMedia = await media(page);
  assert(during.artifactSetId === old.artifactSetId, "refresh replaced descriptor before publication", { old, during });
  assert(during.videoUrl === old.videoUrl && during.audioUrl === old.audioUrl, "refresh cleared or changed old URLs", { old, during });
  assert(during.status === "ready", "refresh downgraded committed Ready projection", during);
  assert(!duringMedia.preparing && duringMedia.present, "Host entered preparing gap during refresh", duringMedia);
  assert(
    await page.evaluate(() => document.querySelector('video[data-player-role="video"]') === window.__acceptanceOriginalVideo),
    "refresh remounted media before publication",
  );
  if (shouldAdvance) {
    assert(duringMedia.currentTime > beforeTime + 0.15, "media clock stopped during refresh", { beforeTime, duringMedia });
  }
  const overlapping = await Promise.all([
    rangeRead(page, old.videoUrl, 0, 63),
    rangeRead(page, old.videoUrl, 32, 95),
    rangeRead(page, old.audioUrl, 0, 63),
  ]);
  assert(overlapping.every((entry) => entry.status === 206), "concurrent old Range reads failed", overlapping);
  observations.push({ boundary: "refresh-in-flight", descriptor: during, media: duringMedia, overlapping });
}

async function waitForReplacement(page, old) {
  const nextState = await waitFor(async () => {
    const snapshot = await state(page);
    const next = descriptor(snapshot.current_item);
    return next.artifactSetId && next.artifactSetId !== old.artifactSetId
      ? { snapshot, next }
      : null;
  }, "new immutable artifact set did not commit");
  const nextMedia = await waitFor(async () => {
    const value = await media(page);
    return value.present
      && value.itemId === nextState.snapshot.current_item.id
      && value.videoSrc === nextState.next.videoUrl
      && value.audioSrc === nextState.next.audioUrl
      && value.readyState >= 1
      && value.audioReadyState >= 1
      ? value
      : null;
  }, "Host did not mount the newly committed immutable URLs");
  const oldVideoRange = await rangeRead(page, old.videoUrl);
  const oldAudioRange = await rangeRead(page, old.audioUrl);
  const newVideoRange = await rangeRead(page, nextState.next.videoUrl);
  const newAudioRange = await rangeRead(page, nextState.next.audioUrl);
  for (const [label, value] of Object.entries({ oldVideoRange, oldAudioRange, newVideoRange, newAudioRange })) {
    assert(value.status === 206 && value.length > 0, `${label} failed across publication`, value);
  }
  assert(nextState.next.directory !== old.directory, "replacement reused committed directory", { old, next: nextState.next });
  assert(nextState.next.videoUrl !== old.videoUrl && nextState.next.audioUrl !== old.audioUrl, "replacement URLs were not immutable-versioned", { old, next: nextState.next });
  observations.push({
    boundary: "refresh-committed",
    descriptor: nextState.next,
    media: nextMedia,
    ranges: { oldVideoRange, oldAudioRange, newVideoRange, newAudioRange },
  });
  return { ...nextState, media: nextMedia };
}

async function recachePlaying(page) {
  const started = await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  await clickCurrentRecache(page);
  await assertRefreshStillCommitted(page, old, started.currentTime, true);
  const replaced = await waitForReplacement(page, old);
  const settled = await waitFor(async () => {
    const value = await media(page);
    return !value.paused && value.currentTime > 0.1 ? value : null;
  }, "playing refresh did not resume prior play intent");
  assert(settled.replacementCount === 1, "playing refresh did not replace media exactly once", settled);
  const replacement = settled.replacements[0];
  assert(Math.abs(settled.currentTime - replacement.oldTime) <= 1.25, "playing refresh time was not restored within 1.25s", { settled, replacement });
  observations.push({ boundary: "playing-refresh-restored", media: settled, replacement, descriptor: replaced.next });
}

async function recachePaused(page) {
  await startPlayback(page, "A");
  const pausedBefore = await pausePlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  await clickCurrentRecache(page);
  await assertRefreshStillCommitted(page, old, pausedBefore.currentTime, false);
  await waitForReplacement(page, old);
  const settled = await waitFor(async () => {
    const value = await media(page);
    return value.paused && value.replacementCount === 1 ? value : null;
  }, "paused refresh did not stay paused");
  const replacement = settled.replacements[0];
  assert(Math.abs(settled.currentTime - replacement.oldTime) <= 0.75, "paused refresh time was not restored within 0.75s", { settled, replacement });
  observations.push({ boundary: "paused-refresh-restored", media: settled, replacement });
}

async function recacheFailed(page) {
  const started = await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  await clickCurrentRecache(page);
  await assertRefreshStillCommitted(page, old, started.currentTime, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const snapshot = await state(page);
  const after = descriptor(snapshot.current_item);
  const afterMedia = await media(page);
  assert(after.artifactSetId === old.artifactSetId && after.status === "ready", "failed refresh destroyed old Ready descriptor", { old, after });
  assert(afterMedia.replacementCount === 0 && !afterMedia.paused, "failed refresh changed mounted playback", afterMedia);
  assert((await rangeRead(page, old.videoUrl)).status === 206, "old URL unreadable after failed refresh");
  observations.push({ boundary: "failed-refresh-retained", descriptor: after, media: afterMedia });
}

async function recacheCancelled(page) {
  const started = await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  await clickCurrentRecache(page);
  await assertRefreshStillCommitted(page, old, started.currentTime, true);
  await clickCurrentRecache(page);
  const replaced = await waitForReplacement(page, old);
  const settled = await waitFor(async () => {
    const value = await media(page);
    return value.replacementCount === 1 && !value.paused ? value : null;
  }, "superseding refresh did not settle exactly once");
  assert((await rangeRead(page, old.videoUrl)).status === 206, "old URL unreadable after cancellation/supersession");
  observations.push({ boundary: "cancelled-refresh-retained-then-newest-committed", descriptor: replaced.next, media: settled });
}

async function normalSwitch(page) {
  await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptanceOldVideo = document.querySelector('video[data-player-role="video"]');
  });
  await clickCurrentRecache(page);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.locator("#next-button").click();
  await waitFor(async () => (await state(page)).current_item?.id === "B", "normal next did not make B current");
  const bPlaying = await observeAutomaticPlayback(page, "B", 0.15);
  await page.evaluate(() => window.__acceptanceOldVideo?.dispatchEvent(new Event("ended")));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await state(page);
  const afterMedia = await media(page);
  assert(after.current_item?.id === "B" && afterMedia.itemId === "B", "late A ended callback changed B", { after: after.current_item, afterMedia });
  assert(!afterMedia.paused && afterMedia.currentTime > bPlaying.currentTime + 0.1, "normal Next reached B without stable real playback", { bPlaying, afterMedia });
  assert(documentTextIncludes(await page.textContent("body"), "Fixture Song B"), "Host title did not correspond to B");
  assert((await rangeRead(page, old.videoUrl)).status === 206, "A old URL unreadable after normal switch");
  observations.push({ boundary: "normal-switch-stable", currentItem: after.current_item?.id, media: afterMedia });
}

function documentTextIncludes(text, expected) {
  return String(text || "").includes(expected);
}

function allowedConsoleError(entry) {
  try {
    const location = new URL(entry?.location?.url || "");
    const expectedOrigin = new URL(baseUrl).origin;
    return entry?.text === "Failed to load resource: the server responded with a status of 404 (Not Found)"
      && location.origin === expectedOrigin
      && location.pathname === "/favicon.ico";
  } catch (_error) {
    return false;
  }
}

async function playNow(page, uncached) {
  await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await page.evaluate(() => {
    window.__acceptanceOldVideo = document.querySelector('video[data-player-role="video"]');
  });
  await clickCurrentRecache(page);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await clickPlayNow(page, "C");
  const cState = await waitFor(async () => {
    const snapshot = await state(page);
    return snapshot.current_item?.id === "C" ? snapshot : null;
  }, "Play Now did not make C authoritative");
  if (uncached) {
    const initialMedia = await media(page);
    observations.push({ boundary: "uncached-play-now-transition", descriptor: descriptor(cState.current_item), media: initialMedia });
    assert(
      cState.current_item.cache_status !== "ready" || initialMedia.itemId === "C",
      "uncached Play Now exposed media for the wrong item",
      { current: cState.current_item, initialMedia },
    );
  }
  const playing = await observeAutomaticPlayback(page, "C", 0.15);
  await page.evaluate(() => window.__acceptanceOldVideo?.dispatchEvent(new Event("ended")));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const after = await state(page);
  const afterMedia = await media(page);
  assert(after.current_item?.id === "C" && afterMedia.itemId === "C", "late A completion/event pulled Host away from C", { after: after.current_item, afterMedia });
  assert(!afterMedia.paused && afterMedia.currentTime >= playing.currentTime, "late A event altered C play intent/time", { playing, afterMedia });
  assert(documentTextIncludes(await page.textContent("body"), "Fixture Song C"), "Host title did not correspond to C");
  assert((await rangeRead(page, old.videoUrl)).status === 206, "A old URL unreadable after Play Now");
  observations.push({ boundary: uncached ? "play-now-uncached-stable" : "play-now-ready-stable", currentItem: after.current_item?.id, media: playing });
}

async function naturalEnded(page) {
  await waitForMedia(page, "A");
  await page.evaluate(() => {
    window.__acceptanceNaturalEndedCount = 0;
    window.__acceptanceOldVideo = document.querySelector('video[data-player-role="video"]');
    window.__acceptanceOldVideo.addEventListener("ended", () => {
      window.__acceptanceNaturalEndedCount += 1;
    });
  });
  await startPlayback(page, "A", 0.15);
  const bState = await waitFor(async () => {
    const snapshot = await state(page);
    return snapshot.current_item?.id === "B" ? snapshot : null;
  }, "natural media end did not advance to B", 15000);
  const bPlaying = await observeAutomaticPlayback(page, "B", 0.15);
  const naturalCount = await page.evaluate(() => window.__acceptanceNaturalEndedCount);
  assert(naturalCount === 1, "first ended signal was not one natural video end", naturalCount);
  await page.evaluate(() => window.__acceptanceOldVideo.dispatchEvent(new Event("ended")));
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await state(page);
  const afterMedia = await media(page);
  assert(after.current_item?.id === "B" && afterMedia.itemId === "B", "duplicate old-element ended skipped B", { after: after.current_item, afterMedia });
  assert(!afterMedia.preparing, "natural advance left Host stuck preparing", afterMedia);
  assert(!afterMedia.paused && afterMedia.currentTime > bPlaying.currentTime + 0.1, "natural advance reached B without stable real playback", { bPlaying, afterMedia });
  observations.push({ boundary: "natural-ended-advanced-once", currentItem: bState.current_item?.id, naturalEndedCount: naturalCount, media: afterMedia });
}

async function run() {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitFor(async () => (await state(page)).current_item?.cache_status === "ready", "initial current item was not Ready");
    await waitForMedia(page, "A");
    if (scenario === "recache-playing") {
      await recachePlaying(page);
    } else if (scenario === "recache-paused") {
      await recachePaused(page);
    } else if (scenario === "recache-failed") {
      await recacheFailed(page);
    } else if (scenario === "recache-cancelled") {
      await recacheCancelled(page);
    } else if (scenario === "normal-switch") {
      await normalSwitch(page);
    } else if (scenario === "play-now-ready") {
      await playNow(page, false);
    } else if (scenario === "play-now-uncached") {
      await playNow(page, true);
    } else if (scenario === "natural-ended") {
      await naturalEnded(page);
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
    const allowedConsoleErrors = consoleErrors.filter(allowedConsoleError);
    const unexpectedConsoleErrors = consoleErrors.filter((entry) => !allowedConsoleError(entry));
    assert(pageErrors.length === 0, "unexpected page errors", pageErrors);
    assert(unexpectedConsoleErrors.length === 0, "unexpected console errors", unexpectedConsoleErrors);
    return { passed: true, scenario, observations, consoleErrors, allowedConsoleErrors, pageErrors };
  } finally {
    await browser.close();
  }
}

run().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  (error) => {
    process.stdout.write(`${JSON.stringify({
      passed: false,
      scenario,
      error: error.message,
      detail: error.detail,
      stack: error.stack,
      observations,
      consoleErrors,
      pageErrors,
    })}\n`);
    process.exitCode = 1;
  },
);
