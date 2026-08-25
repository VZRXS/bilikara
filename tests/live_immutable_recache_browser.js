"use strict";

const { chromium } = require("playwright");

const [baseUrl, scenario, executablePath, screenshotPath] = process.argv.slice(2);
const observations = [];
const consoleErrors = [];
const pageErrors = [];
let pageIdentity = null;

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
      videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
      audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
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

async function clickPlayerReset(page) {
  const settingsToggle = page.locator("#cache-settings-toggle");
  if ((await settingsToggle.getAttribute("aria-expanded")) !== "true") {
    await settingsToggle.click();
  }
  const advancedToggle = page.locator("#cache-panel-advanced-trigger");
  if ((await advancedToggle.getAttribute("aria-expanded")) !== "true") {
    await advancedToggle.click();
  }
  await page.locator("#player-reset-button").click();
  const confirm = page.locator("#confirm-popover");
  assert(
    !(await confirm.evaluate((element) => element.classList.contains("hidden"))),
    "player reset confirmation did not open",
  );
  const responsePromise = page.waitForResponse(
    (response) => response.url() === `${baseUrl}/api/player/reset`
      && response.request().method() === "POST",
  );
  await page.locator("#confirm-ok").click();
  const response = await responsePromise;
  assert(response.ok(), "player reset request failed", response.status());
  const payload = await response.json();
  assert(payload?.ok === true, "player reset response was rejected", payload);
  await waitFor(
    async () => (await confirm.evaluate((element) => element.classList.contains("hidden"))),
    "player reset confirmation did not close",
  );
  return payload.data;
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

async function playerReset(page) {
  const started = await startPlayback(page, "A");
  const before = await state(page);
  assert(before.playback_program?.item_id === "A", "reset fixture had no requested program", before.playback_program);
  assert(before.playback_program?.artifact_set_id, "reset fixture was not mountable", before.playback_program);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptanceResetOldVideo = document.querySelector('video[data-player-role="video"]');
    window.__acceptanceResetOldAudio = document.querySelector('audio[data-player-role="audio"]');
  });

  const response = await clickPlayerReset(page);
  assert(
    JSON.stringify(response.playback_program) === JSON.stringify(before.playback_program),
    "reset response changed the program descriptor",
    { before: before.playback_program, after: response.playback_program },
  );
  assert(
    response.playback_generation === before.playback_generation + 1,
    "reset response did not advance exactly one program generation",
    { before: before.playback_generation, after: response.playback_generation },
  );

  const remounted = await waitForMedia(page, "A");
  assert(remounted.currentTime < started.currentTime, "reset did not restart the media clock", { started, remounted });
  const retirement = await page.evaluate(() => {
    const video = document.querySelector('video[data-player-role="video"]');
    const audio = document.querySelector('audio[data-player-role="audio"]');
    return {
      oldVideoConnected: Boolean(window.__acceptanceResetOldVideo?.isConnected),
      oldAudioConnected: Boolean(window.__acceptanceResetOldAudio?.isConnected),
      oldVideoSrc: window.__acceptanceResetOldVideo?.getAttribute("src") || "",
      oldAudioSrc: window.__acceptanceResetOldAudio?.getAttribute("src") || "",
      videoReplaced: video !== window.__acceptanceResetOldVideo,
      audioReplaced: audio !== window.__acceptanceResetOldAudio,
    };
  });
  assert(
    !retirement.oldVideoConnected
      && !retirement.oldAudioConnected
      && !retirement.oldVideoSrc
      && !retirement.oldAudioSrc
      && retirement.videoReplaced
      && retirement.audioReplaced,
    "reset did not retire the old media pair",
    retirement,
  );
  const automatic = await observeAutomaticPlayback(page, "A", 0.15);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await state(page);
  const stable = await media(page);
  assert(
    JSON.stringify(after.playback_program) === JSON.stringify(before.playback_program),
    "post-reset state changed the program descriptor",
    { before: before.playback_program, after: after.playback_program },
  );
  assert(
    after.playback_generation === before.playback_generation + 1,
    "post-reset state duplicated or lost the generation advance",
    { before: before.playback_generation, after: after.playback_generation },
  );
  assert(after.current_item?.id === "A", "player reset unexpectedly advanced the playlist", after.current_item);
  assert(
    stable.videoCount === 1
      && stable.audioCount === 1
      && stable.replacementCount === 1
      && stable.itemId === "A"
      && !stable.preparing
      && !stable.paused
      && stable.currentTime > automatic.currentTime,
    "reset did not settle as exactly one stable automatically playing pair",
    { stable, automatic },
  );
  observations.push({
    boundary: "player-reset-fresh-lifetime",
    before: {
      playbackProgram: before.playback_program,
      playbackGeneration: before.playback_generation,
      currentTime: started.currentTime,
    },
    response: {
      playbackProgram: response.playback_program,
      playbackGeneration: response.playback_generation,
    },
    retirement,
    media: stable,
  });
}

async function failedPlayerReset(page) {
  await startPlayback(page, "A");
  const before = await state(page);
  await installReplacementObserver(page);
  const captured = await page.evaluate(() => {
    window.__acceptanceFailedResetVideo = document.querySelector('video[data-player-role="video"]');
    window.__acceptanceFailedResetAudio = document.querySelector('audio[data-player-role="audio"]');
    return {
      currentTime: Number(window.__acceptanceFailedResetVideo?.currentTime || 0),
      volumePreference: window.localStorage.getItem("bilikara.player.volume"),
      mutedPreference: window.localStorage.getItem("bilikara.player.muted"),
    };
  });
  await page.route("**/api/player/reset", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "injected reset failure" }),
    });
  }, { times: 1 });

  const settingsToggle = page.locator("#cache-settings-toggle");
  if ((await settingsToggle.getAttribute("aria-expanded")) !== "true") {
    await settingsToggle.click();
  }
  const advancedToggle = page.locator("#cache-panel-advanced-trigger");
  if ((await advancedToggle.getAttribute("aria-expanded")) !== "true") {
    await advancedToggle.click();
  }
  await page.locator("#player-reset-button").click();
  const responsePromise = page.waitForResponse(
    (response) => response.url() === `${baseUrl}/api/player/reset`
      && response.request().method() === "POST",
  );
  await page.locator("#confirm-ok").click();
  const response = await responsePromise;
  const payload = await response.json();
  assert(response.ok() && payload?.ok === false, "failed-reset fixture did not reject the request", payload);
  await page.unroute("**/api/player/reset");

  const advanced = await waitFor(async () => {
    const value = await media(page);
    return !value.paused && value.currentTime > captured.currentTime + 0.25 ? value : null;
  }, "failed player reset stopped the healthy playback clock");
  const after = await state(page);
  const identity = await page.evaluate(() => ({
    sameVideo: document.querySelector('video[data-player-role="video"]')
      === window.__acceptanceFailedResetVideo,
    sameAudio: document.querySelector('audio[data-player-role="audio"]')
      === window.__acceptanceFailedResetAudio,
    volumePreference: window.localStorage.getItem("bilikara.player.volume"),
    mutedPreference: window.localStorage.getItem("bilikara.player.muted"),
  }));
  assert(
    identity.sameVideo
      && identity.sameAudio
      && identity.volumePreference === captured.volumePreference
      && identity.mutedPreference === captured.mutedPreference
      && advanced.videoCount === 1
      && advanced.audioCount === 1
      && advanced.replacementCount === 0,
    "failed player reset changed the healthy media lifetime or local preferences",
    { captured, identity, advanced },
  );
  assert(
    after.revision === before.revision
      && after.playback_generation === before.playback_generation
      && JSON.stringify(after.playback_program) === JSON.stringify(before.playback_program)
      && JSON.stringify(after.player_settings) === JSON.stringify(before.player_settings),
    "failed player reset changed authoritative state",
    { before, after },
  );
  observations.push({
    boundary: "failed-player-reset-preserves-session",
    generation: after.playback_generation,
    identity,
    media: advanced,
  });
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

async function sessionRerender(page) {
  const started = await startPlayback(page, "A");
  await installReplacementObserver(page);
  const before = await state(page);
  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#player-frame");
    const video = frame?.querySelector('video[data-player-role="video"]') || null;
    const audio = frame?.querySelector('audio[data-player-role="audio"]') || null;
    window.__acceptanceSessionVideo = video;
    window.__acceptanceSessionAudio = audio;
    const beforeTime = Number(video?.currentTime || 0);

    setLanguage("ja");
    applyTheme("dark");
    render();
    const settingsAccepted = await apiPostStateSnapshot("/api/player/volume", {
      volume_percent: 73,
      is_muted: false,
    });
    render();
    const queueAccepted = await apiPostStateSnapshot("/api/playlist/remove", {
      item_id: "B",
    });
    render();

    const activeSession = applyPresentationSession({
      mode: "localDualScreen",
      phase: "active",
      generation: 1,
      selectedOutputDisplayId: "display:audience",
      controllerDisplayId: "display:controller",
      hostReady: true,
      controllerReady: true,
      lastAcceptedCommandSequence: 0,
      lastAppliedCommandSequence: 0,
      playbackAuthority: "host",
      mediaRendererOwner: "host",
      recoveryReason: "",
    });
    const entered = applyPresentationCompositionDom(1, "stageOnly");
    const stage = {
      sameVideo: frame.querySelector('video[data-player-role="video"]') === video,
      sameAudio: frame.querySelector('audio[data-player-role="audio"]') === audio,
      inert: frame.inert,
      activeClass: document.body.classList.contains("is-presentation-stage-only"),
    };
    applyPresentationSession({
      ...activeSession,
      phase: "recovering",
      generation: 2,
      hostReady: false,
      controllerReady: false,
    });
    const exited = applyPresentationCompositionDom(2, "combined");
    render();
    return {
      beforeTime,
      settingsAccepted,
      queueAccepted,
      entered,
      exited,
      stage,
      exit: {
        sameVideo: frame.querySelector('video[data-player-role="video"]') === video,
        sameAudio: frame.querySelector('audio[data-player-role="audio"]') === audio,
        inert: frame.inert,
        activeClass: document.body.classList.contains("is-presentation-stage-only"),
      },
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const settled = await media(page);
  const identity = await page.evaluate(() => ({
    sameVideo: document.querySelector('video[data-player-role="video"]')
      === window.__acceptanceSessionVideo,
    sameAudio: document.querySelector('audio[data-player-role="audio"]')
      === window.__acceptanceSessionAudio,
  }));
  const after = await state(page);
  assert(result.entered && result.exited, "presentation composition did not apply", result);
  assert(
    result.stage.sameVideo && result.stage.sameAudio && result.stage.inert && result.stage.activeClass,
    "dual-screen composition replaced the Host media pair",
    result.stage,
  );
  assert(
    result.exit.sameVideo && result.exit.sameAudio && !result.exit.inert && !result.exit.activeClass,
    "single-screen composition replaced the Host media pair",
    result.exit,
  );
  assert(
    identity.sameVideo
      && identity.sameAudio
      && settled.videoCount === 1
      && settled.audioCount === 1
      && settled.replacementCount === 0
      && settled.currentTime > Math.max(started.currentTime, result.beforeTime) + 0.2,
    "unchanged-program rerenders did not preserve one advancing pair",
    { started, result, identity, settled },
  );
  assert(
    after.current_item?.id === "A"
      && (after.playlist || []).length === 0
      && after.player_settings?.volume_percent === 73
      && after.player_settings?.is_muted === false,
    "settings/queue rerenders did not reach the authoritative snapshot",
    { result, after },
  );
  assert(after.playback_generation === before.playback_generation, "unchanged rerenders advanced playback generation", { before, after });
  observations.push({ boundary: "unchanged-program-rerenders", result, identity, media: settled });
}

async function inverseSnapshot(page) {
  await startPlayback(page, "A");
  await installReplacementObserver(page);
  let releaseOlder;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  let olderCapturedResolve;
  const olderCaptured = new Promise((resolve) => { olderCapturedResolve = resolve; });
  let newerDeliveredResolve;
  const newerDelivered = new Promise((resolve) => { newerDeliveredResolve = resolve; });
  const responses = {};

  await page.route("**/api/playlist/play-now", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    const response = await route.fetch();
    const responseBody = await response.body();
    const payload = JSON.parse(responseBody.toString("utf8"));
    responses[body.item_id] = payload.data;
    if (body.item_id === "B") {
      olderCapturedResolve();
      await olderGate;
    }
    await route.fulfill({ response, body: responseBody });
    if (body.item_id === "C") {
      newerDeliveredResolve();
    }
  });

  await clickPlayNow(page, "B");
  await olderCaptured;
  await clickPlayNow(page, "C");
  await newerDelivered;
  const cPlaying = await observeAutomaticPlayback(page, "C", 0.15);
  releaseOlder();
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.unroute("**/api/playlist/play-now");

  const after = await state(page);
  const settled = await media(page);
  assert(
    responses.C.state_revision > responses.B.state_revision,
    "inverse fixture did not produce ordered complete snapshots",
    responses,
  );
  assert(
    after.current_item?.id === "C"
      && settled.itemId === "C"
      && settled.replacementCount === 1
      && settled.videoCount === 1
      && settled.audioCount === 1
      && !settled.paused
      && settled.currentTime > cPlaying.currentTime + 0.1,
    "late older complete snapshot rolled back or remounted the accepted program",
    { responses, after: after.current_item, cPlaying, settled },
  );
  assert(
    responses.C.playback_generation > responses.B.playback_generation,
    "inverse snapshots did not carry distinct Rust program generations",
    responses,
  );
  observations.push({
    boundary: "inverse-full-snapshot-ordering",
    older: {
      stateRevision: responses.B.state_revision,
      revision: responses.B.revision,
      playbackGeneration: responses.B.playback_generation,
    },
    newer: {
      stateRevision: responses.C.state_revision,
      revision: responses.C.revision,
      playbackGeneration: responses.C.playback_generation,
    },
    media: settled,
  });
}

async function pageRestore(page) {
  const started = await startPlayback(page, "A");
  const before = await state(page);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptancePageHideVideo = document.querySelector('video[data-player-role="video"]');
    window.__acceptancePageHideAudio = document.querySelector('audio[data-player-role="audio"]');
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  const retired = await page.evaluate(() => ({
    videoSrc: window.__acceptancePageHideVideo?.getAttribute("src") || "",
    audioSrc: window.__acceptancePageHideAudio?.getAttribute("src") || "",
    videoPaused: Boolean(window.__acceptancePageHideVideo?.paused),
    audioPaused: Boolean(window.__acceptancePageHideAudio?.paused),
  }));
  assert(!retired.videoSrc && !retired.audioSrc && retired.videoPaused && retired.audioPaused, "pagehide did not retire the exact media pair", retired);

  const responsePromise = page.waitForResponse(
    (response) => response.url() === `${baseUrl}/api/player/restart-program`
      && response.request().method() === "POST",
  );
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  const response = await responsePromise;
  const payload = await response.json();
  assert(response.ok() && payload?.ok === true, "page restore restart request failed", payload);
  assert(
    payload.data.playback_generation === before.playback_generation + 1
      && payload.data.revision === before.revision + 1
      && payload.data.state_revision > before.state_revision
      && JSON.stringify(payload.data.playback_program) === JSON.stringify(before.playback_program)
      && JSON.stringify(payload.data.player_settings) === JSON.stringify(before.player_settings),
    "page restore restart did not preserve the Rust program and settings",
    { before, response: payload.data },
  );
  const automatic = await observeAutomaticPlayback(page, "A", 0.15);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const settled = await media(page);
  const retirement = await page.evaluate(() => ({
    oldVideoConnected: Boolean(window.__acceptancePageHideVideo?.isConnected),
    oldAudioConnected: Boolean(window.__acceptancePageHideAudio?.isConnected),
    sameVideo: document.querySelector('video[data-player-role="video"]')
      === window.__acceptancePageHideVideo,
    sameAudio: document.querySelector('audio[data-player-role="audio"]')
      === window.__acceptancePageHideAudio,
  }));
  assert(
    !retirement.oldVideoConnected
      && !retirement.oldAudioConnected
      && !retirement.sameVideo
      && !retirement.sameAudio
      && settled.replacementCount === 1
      && settled.videoCount === 1
      && settled.audioCount === 1
      && !settled.paused
      && settled.currentTime > automatic.currentTime + 0.1,
    "page restore did not settle as one fresh automatically playing pair",
    { started, automatic, retirement, settled },
  );
  observations.push({
    boundary: "pagehide-pageshow-rust-restart",
    beforeGeneration: before.playback_generation,
    afterGeneration: payload.data.playback_generation,
    beforeStateRevision: before.state_revision,
    afterStateRevision: payload.data.state_revision,
    retired,
    retirement,
    media: settled,
  });

  const beforeReload = await state(page);
  const reloadResponsePromise = page.waitForResponse(
    (candidate) => candidate.url() === `${baseUrl}/api/player/restart-program`
      && candidate.request().method() === "POST",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadResponse = await reloadResponsePromise;
  const reloadPayload = await reloadResponse.json();
  assert(
    reloadResponse.ok()
      && reloadPayload?.ok === true
      && reloadPayload.data.playback_generation === beforeReload.playback_generation + 1
      && reloadPayload.data.revision === beforeReload.revision + 1
      && reloadPayload.data.state_revision > beforeReload.state_revision
      && JSON.stringify(reloadPayload.data.playback_program) === JSON.stringify(beforeReload.playback_program)
      && JSON.stringify(reloadPayload.data.player_settings) === JSON.stringify(beforeReload.player_settings),
    "Host reload bootstrap did not advance one settings-preserving Rust lifetime",
    { beforeReload, response: reloadPayload?.data },
  );
  const reloadAutomatic = await observeAutomaticPlayback(page, "A", 0.15);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const reloadSettled = await media(page);
  assert(
    reloadSettled.videoCount === 1
      && reloadSettled.audioCount === 1
      && !reloadSettled.paused
      && reloadSettled.currentTime > reloadAutomatic.currentTime + 0.1,
    "Host reload bootstrap did not settle as one automatically playing pair",
    { reloadAutomatic, reloadSettled },
  );
  observations.push({
    boundary: "host-reload-rust-bootstrap",
    beforeGeneration: beforeReload.playback_generation,
    afterGeneration: reloadPayload.data.playback_generation,
    beforeStateRevision: beforeReload.state_revision,
    afterStateRevision: reloadPayload.data.state_revision,
    media: reloadSettled,
  });
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
    pageIdentity = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyTextLength: String(document.body?.innerText || "").trim().length,
      frameworkOverlay: Boolean(document.querySelector(
        "nextjs-portal, vite-error-overlay, #webpack-dev-server-client-overlay",
      )),
    }));
    assert(pageIdentity.url === `${baseUrl}/`, "browser opened the wrong Host page", pageIdentity);
    assert(pageIdentity.title && pageIdentity.bodyTextLength > 0, "Host page was blank", pageIdentity);
    assert(!pageIdentity.frameworkOverlay, "Host page showed a framework error overlay", pageIdentity);
    await waitFor(async () => (await state(page)).current_item?.cache_status === "ready", "initial current item was not Ready");
    await waitForMedia(page, "A");
    if (scenario === "player-reset") {
      await playerReset(page);
    } else if (scenario === "failed-reset") {
      await failedPlayerReset(page);
    } else if (scenario === "recache-playing") {
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
    } else if (scenario === "session-rerender") {
      await sessionRerender(page);
    } else if (scenario === "inverse-snapshot") {
      await inverseSnapshot(page);
    } else if (scenario === "page-restore") {
      await pageRestore(page);
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
    const allowedConsoleErrors = consoleErrors.filter(allowedConsoleError);
    const unexpectedConsoleErrors = consoleErrors.filter((entry) => !allowedConsoleError(entry));
    assert(pageErrors.length === 0, "unexpected page errors", pageErrors);
    assert(unexpectedConsoleErrors.length === 0, "unexpected console errors", unexpectedConsoleErrors);
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    return { passed: true, scenario, pageIdentity, observations, consoleErrors, allowedConsoleErrors, pageErrors, screenshotPath };
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
      pageIdentity,
      observations,
      consoleErrors,
      pageErrors,
    })}\n`);
    process.exitCode = 1;
  },
);
