"use strict";

const { chromium } = require("playwright");

const [baseUrl, scenario, executablePath, screenshotPath] = process.argv.slice(2);
const observations = [];
const consoleErrors = [];
const pageErrors = [];
const mediaPublications = [];
let pageIdentity = null;
let releaseStaggeredVideo = null;
let staggeredReadinessEvidence = null;

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
    const session = state.hostPlaybackSession;
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
      sessionPhase: session?.phase || "",
      readyCommitted: Boolean(session?.readyCommitted),
      readyCommitCount: Number(session?.readyCommitCount || 0),
      initialIntentApplied: Boolean(session?.initialIntentApplied),
      playbackGeneration: Number(session?.playbackGeneration || 0),
      sessionArtifactSetId: session?.playbackProgram?.artifact_set_id || "",
      ownershipClaimed: Boolean(session?.ownershipClaimed),
      ownershipClaimFailed: Boolean(session?.ownershipClaimFailed),
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
  const newVideoRange = await rangeRead(page, nextState.next.videoUrl);
  const newAudioRange = await rangeRead(page, nextState.next.audioUrl);
  for (const [label, value] of Object.entries({ newVideoRange, newAudioRange })) {
    assert(value.status === 206 && value.length > 0, `${label} failed across publication`, value);
  }
  assert(nextState.next.directory !== old.directory, "replacement reused committed directory", { old, next: nextState.next });
  assert(nextState.next.videoUrl !== old.videoUrl && nextState.next.audioUrl !== old.audioUrl, "replacement URLs were not immutable-versioned", { old, next: nextState.next });
  observations.push({
    boundary: "refresh-committed",
    descriptor: nextState.next,
    media: nextMedia,
    ranges: { newVideoRange, newAudioRange },
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

async function retireHeldRange(page) {
  const started = await startPlayback(page, "A");
  const { old } = await oldDescriptorAndRange(page);
  await installReplacementObserver(page);
  const heldResponse = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: {
        Range: "bytes=0-255",
        "X-Bilikara-Acceptance-Hold-Range": "1",
      },
    });
    window.__acceptanceHeldRangeBody = response.arrayBuffer().then((body) => ({
      length: body.byteLength,
    }));
    return {
      status: response.status,
      contentRange: response.headers.get("content-range") || "",
    };
  }, old.videoUrl);
  assert(heldResponse.status === 206, "held old-artifact Range did not open", heldResponse);

  await clickCurrentRecache(page);
  await assertRefreshStillCommitted(page, old, started.currentTime, true);
  const replaced = await waitForReplacement(page, old);
  const heldBody = await page.evaluate(() => window.__acceptanceHeldRangeBody);
  assert(heldBody?.length > 0, "held old-artifact Range did not finish", heldBody);
  const retiredOldRange = await waitFor(async () => {
    const value = await rangeRead(page, old.videoUrl, 0, 31);
    return value.status === 404 ? value : null;
  }, "old artifact remained servable after held Range release", 12000);
  const stable = await waitFor(async () => {
    const value = await media(page);
    return value.itemId === "A"
      && value.videoCount === 1
      && value.audioCount === 1
      && !value.paused
      && value.currentTime > 0.1
      ? value
      : null;
  }, "replacement playback did not remain stable after old reader release");
  const replacementRange = await rangeRead(page, replaced.next.videoUrl, 0, 31);
  assert(
    replacementRange.status === 206 && replacementRange.length > 0,
    "replacement artifact stopped serving after old retirement",
    replacementRange,
  );
  observations.push({
    boundary: "held-range-retirement-settled",
    old,
    replacement: replaced.next,
    heldResponse,
    heldBody,
    retiredOldRange,
    replacementRange,
    media: stable,
  });
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
  observations.push({ boundary: "normal-switch-stable", currentItem: after.current_item?.id, media: afterMedia });
}

async function staleNextRecache(page, { firstCarrier = false } = {}) {
  const started = await startPlayback(page, "A");
  await page.evaluate(() => setAdvanceDelay(2));
  const before = await state(page);
  assert(
    before.player_settings?.song_advance_delay_seconds === 2,
    "stale Next fixture did not enable a nonzero transition delay",
    before.player_settings,
  );
  const oldDescriptor = descriptor(before.current_item);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptanceStaleNextVideo = document.querySelector('video[data-player-role="video"]');
    window.__acceptanceStaleNextAudio = document.querySelector('audio[data-player-role="audio"]');
  });

  const frozenResponse = await page.request.get(`${baseUrl}/api/state`);
  assert(frozenResponse.ok(), "failed to capture the pre-race Host snapshot");
  const frozenPayload = await frozenResponse.json();
  await page.route("**/api/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(frozenPayload),
    });
  });

  let releaseNext;
  const nextGate = new Promise((resolve) => { releaseNext = resolve; });
  let nextCapturedResolve;
  const nextCaptured = new Promise((resolve) => { nextCapturedResolve = resolve; });
  let nextRequestCount = 0;
  let serverNextStatus = 0;
  let serverNextPayload = null;
  await page.route("**/api/player/next", async (route) => {
    nextRequestCount += 1;
    nextCapturedResolve();
    await nextGate;
    const response = await route.fetch();
    serverNextStatus = response.status();
    serverNextPayload = await response.json();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(serverNextPayload),
    });
  });

  const nextResponsePromise = page.waitForResponse(
    (response) => response.url() === `${baseUrl}/api/player/next`
      && response.request().method() === "POST",
  );
  await page.locator("#next-button").click();
  await nextCaptured;
  const optimistic = await page.evaluate(() => ({
    holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    inFlight: state.localAdvanceInFlight,
  }));
  assert(
    optimistic.holdItem === "B"
      && optimistic.holdGeneration > 0
      && !optimistic.pendingItem
      && optimistic.inFlight,
    "delayed Next did not establish the expected optimistic hold-only state",
    optimistic,
  );

  await clickCurrentRecache(page);
  const authoritativeReplacement = await waitFor(async () => {
    const snapshot = await state(page);
    return snapshot.current_item?.id === "A"
      && snapshot.playback_generation === before.playback_generation + 1
      && snapshot.current_item?.artifact_set_id
      && snapshot.current_item.artifact_set_id !== oldDescriptor.artifactSetId
      ? snapshot
      : null;
  }, "recache did not create one authoritative replacement program", 20000);

  let carriedReplacement = null;
  let reconciledPlaying = null;
  if (!firstCarrier) {
    carriedReplacement = await page.evaluate(async () => {
      await setLocalPlayerKeyShift(1);
      const session = state.hostPlaybackSession;
      window.__acceptanceSettingsVideo = session?.video || null;
      window.__acceptanceSettingsAudio = session?.audio || null;
      return {
        stateGeneration: state.data?.playback_generation,
        stateArtifactSetId: state.data?.playback_program?.artifact_set_id || "",
        sessionGeneration: session?.playbackGeneration || 0,
        sessionArtifactSetId: session?.playbackProgram?.artifact_set_id || "",
        sessionCurrent: isCurrentHostPlaybackSession(
          session,
          session?.video,
          session?.audio,
        ),
        sessionPhase: session?.phase || "",
        readyCommitted: Boolean(session?.readyCommitted),
        videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
        audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
        oldVideoConnected: Boolean(window.__acceptanceStaleNextVideo?.isConnected),
        oldAudioConnected: Boolean(window.__acceptanceStaleNextAudio?.isConnected),
        holdItem: state.manualTransitionHoldItemId,
        inFlight: state.localAdvanceInFlight,
      };
    });
    assert(
      carriedReplacement.stateGeneration === authoritativeReplacement.playback_generation
        && carriedReplacement.stateArtifactSetId === authoritativeReplacement.playback_program.artifact_set_id
        && carriedReplacement.sessionGeneration === authoritativeReplacement.playback_generation
        && carriedReplacement.sessionArtifactSetId === authoritativeReplacement.playback_program.artifact_set_id
        && carriedReplacement.sessionCurrent
        && carriedReplacement.videoCount === 1
        && carriedReplacement.audioCount === 1
        && !carriedReplacement.oldVideoConnected
        && !carriedReplacement.oldAudioConnected
        && carriedReplacement.holdItem === "B"
        && carriedReplacement.inFlight,
      "the settings-carried replacement did not reconcile at the stale Next boundary",
      { carriedReplacement, authoritativeReplacement },
    );
    reconciledPlaying = await observeAutomaticPlayback(page, "A", 0.15);
  }

  releaseNext();
  const nextResponse = await nextResponsePromise;
  const nextPayload = await nextResponse.json();
  assert(
    nextResponse.ok()
      && nextPayload?.ok === true
      && nextPayload?.stale === true
      && serverNextStatus === 200
      && serverNextPayload?.ok === true
      && serverNextPayload?.stale === true
      && nextPayload?.data?.current_item?.id === "A"
      && nextPayload?.data?.playlist?.[0]?.id === "B"
      && nextPayload?.data?.playback_generation === authoritativeReplacement.playback_generation
      && nextPayload?.data?.playback_program?.artifact_set_id
        === authoritativeReplacement.playback_program.artifact_set_id,
    "delayed Next was not consumed as an exact-generation no-effect settlement",
    {
      browserStatus: nextResponse.status(),
      serverStatus: serverNextStatus,
      browserPayload: nextPayload,
      serverPayload: serverNextPayload,
    },
  );
  if (firstCarrier) {
    carriedReplacement = await waitFor(async () => page.evaluate(() => {
      const session = state.hostPlaybackSession;
      if (
        state.data?.playback_generation !== session?.playbackGeneration
        || state.data?.playback_program?.artifact_set_id
          !== session?.playbackProgram?.artifact_set_id
        || !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
      ) {
        return null;
      }
      window.__acceptanceSettingsVideo = session?.video || null;
      window.__acceptanceSettingsAudio = session?.audio || null;
      return {
        stateGeneration: state.data?.playback_generation,
        stateArtifactSetId: state.data?.playback_program?.artifact_set_id || "",
        sessionGeneration: session?.playbackGeneration || 0,
        sessionArtifactSetId: session?.playbackProgram?.artifact_set_id || "",
        sessionCurrent: true,
        sessionPhase: session?.phase || "",
        readyCommitted: Boolean(session?.readyCommitted),
        videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
        audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
        oldVideoConnected: Boolean(window.__acceptanceStaleNextVideo?.isConnected),
        oldAudioConnected: Boolean(window.__acceptanceStaleNextAudio?.isConnected),
        holdItem: state.manualTransitionHoldItemId,
        holdGeneration: state.manualTransitionHoldGeneration,
        pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
        inFlight: state.localAdvanceInFlight,
      };
    }), "the stale Next response did not carry and reconcile the first replacement snapshot");
    assert(
      carriedReplacement.stateGeneration === authoritativeReplacement.playback_generation
        && carriedReplacement.stateArtifactSetId === authoritativeReplacement.playback_program.artifact_set_id
        && carriedReplacement.sessionGeneration === authoritativeReplacement.playback_generation
        && carriedReplacement.sessionArtifactSetId === authoritativeReplacement.playback_program.artifact_set_id
        && carriedReplacement.sessionCurrent
        && carriedReplacement.videoCount === 1
        && carriedReplacement.audioCount === 1
        && !carriedReplacement.oldVideoConnected
        && !carriedReplacement.oldAudioConnected
        && !carriedReplacement.holdItem
        && carriedReplacement.holdGeneration === 0
        && !carriedReplacement.pendingItem
        && !carriedReplacement.inFlight,
      "the first-carrier stale Next did not reconcile authority and settle its own hold",
      { carriedReplacement, authoritativeReplacement },
    );
    reconciledPlaying = await observeAutomaticPlayback(page, "A", 0.15);
  }
  const released = await waitFor(async () => {
    const value = await page.evaluate(() => ({
      holdItem: state.manualTransitionHoldItemId,
      holdGeneration: state.manualTransitionHoldGeneration,
      pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
      pendingGeneration: state.pendingSongTransitionGeneration,
      delayItem: state.localAdvanceDelayItemId,
      delayDeadline: state.localAdvanceDelayDeadline,
      delayTimer: Boolean(state.localAdvanceDelayTimer),
      countdownTimer: Boolean(state.localAdvanceCountdownTimer),
      inFlight: state.localAdvanceInFlight,
    }));
    return !value.holdItem
      && value.holdGeneration === 0
      && !value.pendingItem
      && value.pendingGeneration === 0
      && !value.delayItem
      && value.delayDeadline === 0
      && !value.delayTimer
      && !value.countdownTimer
      && !value.inFlight
      ? value
      : null;
  }, "stale Next cleanup did not settle");
  assert(
    !released.holdItem
      && released.holdGeneration === 0
      && !released.pendingItem
      && released.pendingGeneration === 0
      && !released.delayItem
      && released.delayDeadline === 0
      && !released.delayTimer
      && !released.countdownTimer
      && !released.inFlight,
    "stale Next left an orphaned local transition",
    released,
  );
  assert(nextRequestCount === 1, "stale Next sent a retry or duplicate request", nextRequestCount);

  await new Promise((resolve) => setTimeout(resolve, 350));
  const reconciledMedia = await media(page);
  const reconciledIdentity = await page.evaluate(() => ({
    sameVideo: document.querySelector('video[data-player-role="video"]')
      === window.__acceptanceSettingsVideo,
    sameAudio: document.querySelector('audio[data-player-role="audio"]')
      === window.__acceptanceSettingsAudio,
    oldVideoConnected: Boolean(window.__acceptanceStaleNextVideo?.isConnected),
    oldAudioConnected: Boolean(window.__acceptanceStaleNextAudio?.isConnected),
  }));
  assert(
    reconciledIdentity.sameVideo
      && reconciledIdentity.sameAudio
      && !reconciledIdentity.oldVideoConnected
      && !reconciledIdentity.oldAudioConnected
      && reconciledMedia.videoCount === 1
      && reconciledMedia.audioCount === 1
      && reconciledMedia.readyCommitted
      && !reconciledMedia.paused
      && reconciledMedia.currentTime > reconciledPlaying.currentTime + 0.1,
    "stale Next cleanup modified or stopped the reconciled replacement pair",
    { reconciledPlaying, reconciledIdentity, reconciledMedia },
  );

  await page.unroute("**/api/state");
  await page.unroute("**/api/player/next");
  await page.evaluate(() => setAdvanceDelay(0));
  const replacementMedia = await waitForMedia(page, "A");
  const automatic = await observeAutomaticPlayback(page, "A", 0.15);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const after = await state(page);
  const settled = await media(page);
  const identity = await page.evaluate(() => ({
    oldVideoConnected: Boolean(window.__acceptanceStaleNextVideo?.isConnected),
    oldAudioConnected: Boolean(window.__acceptanceStaleNextAudio?.isConnected),
    holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    delayDeadline: state.localAdvanceDelayDeadline,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
  }));
  assert(
    after.current_item?.id === "A"
      && after.playlist?.[0]?.id === "B"
      && after.playback_generation === before.playback_generation + 1,
    "stale Next skipped or changed the authoritative queue",
    { before, after },
  );
  assert(
    settled.itemId === "A"
      && settled.videoCount === 1
      && settled.audioCount === 1
      && settled.replacementCount === 1
      && !settled.paused
      && settled.currentTime > automatic.currentTime + 0.1
      && !identity.oldVideoConnected
      && !identity.oldAudioConnected
      && !identity.holdItem
      && identity.holdGeneration === 0
      && !identity.pendingItem
      && identity.delayDeadline === 0
      && !identity.inFlight
      && identity.shouldPlay,
    "stale Next did not settle as one playable unheld recache replacement pair",
    { started, replacementMedia, automatic, settled, identity },
  );
  observations.push({
    boundary: firstCarrier
      ? "stale-next-first-carrier-generation-settlement"
      : "stale-next-recache-generation-settlement",
    carrier: firstCarrier ? "stale-next-response" : "settings-response",
    beforeGeneration: before.playback_generation,
    replacementGeneration: authoritativeReplacement.playback_generation,
    optimistic,
    carriedReplacement,
    released,
    reconciledMedia,
    nextRequestCount,
    media: settled,
  });
}

async function staggeredReadiness(page) {
  await waitFor(
    async () => staggeredReadinessEvidence?.videoGateInterceptCount > 0
      ? staggeredReadinessEvidence
      : null,
    "exact staggered video request did not engage the gate",
  );
  const audioReadyOnly = await waitFor(async () => {
    const value = await media(page);
    return value.present
      && value.itemId === "A"
      && value.readyState < 2
      && value.audioReadyState >= 2
      ? value
      : null;
  }, "audio did not become ready while the video request remained gated");
  staggeredReadinessEvidence.audioReadyBeforeRelease = true;
  const beforeReleasePlayCalls = await page.evaluate(
    () => (window.__acceptanceReadinessPlayCalls || []).slice(),
  );
  const prematureStatus = mediaPublications.filter(
    (entry) => entry.pathname === "/api/player/status",
  );
  assert(
    audioReadyOnly.sessionPhase === "binding"
      && !audioReadyOnly.readyCommitted
      && audioReadyOnly.readyCommitCount === 0
      && audioReadyOnly.videoCount === 1
      && audioReadyOnly.audioCount === 1
      && audioReadyOnly.paused
      && staggeredReadinessEvidence.videoGateInterceptCount > 0
      && staggeredReadinessEvidence.audioRequestedBeforeRelease
      && staggeredReadinessEvidence.audioResponseReceivedBeforeRelease
      && staggeredReadinessEvidence.audioResponseStatus > 0
      && !staggeredReadinessEvidence.videoResponseReceivedBeforeRelease
      && staggeredReadinessEvidence.videoResponseStatus === null
      && beforeReleasePlayCalls.length === 0
      && prematureStatus.length === 0,
    "one ready stream committed, started, or published the candidate early",
    {
      audioReadyOnly,
      staggeredReadinessEvidence,
      beforeReleasePlayCalls,
      prematureStatus,
    },
  );

  assert(typeof releaseStaggeredVideo === "function", "staggered video gate was unavailable");
  releaseStaggeredVideo();
  const playing = await observeAutomaticPlayback(page, "A", 0.15);
  await waitFor(
    async () => staggeredReadinessEvidence?.videoResponseStatus
      ? staggeredReadinessEvidence
      : null,
    "released staggered video request produced no response",
  );
  const settled = await media(page);
  const playCalls = await page.evaluate(
    () => (window.__acceptanceReadinessPlayCalls || []).slice(),
  );
  const roleCounts = Object.fromEntries(
    ["video", "audio"].map((role) => [
      role,
      playCalls.filter((entry) => entry.role === role && entry.itemId === "A").length,
    ]),
  );
  assert(
    settled.readyCommitted
      && settled.readyCommitCount === 1
      && settled.initialIntentApplied
      && settled.sessionPhase === "playing"
      && settled.videoCount === 1
      && settled.audioCount === 1
      && !settled.paused
      && settled.currentTime >= playing.currentTime
      && roleCounts.video === 1
      && roleCounts.audio === 1,
    "both ready streams did not commit once and start one exact pair",
    { playing, settled, playCalls, roleCounts },
  );
  observations.push({
    boundary: "staggered-readiness-single-commit",
    gate: { ...staggeredReadinessEvidence },
    audioReadyOnly,
    playCalls,
    media: settled,
  });
}

async function rapidUnreadySwitch(page) {
  await startPlayback(page, "A");
  await installReplacementObserver(page);
  const initial = await state(page);
  const itemB = initial.playlist?.find((item) => item.id === "B");
  const descriptorB = descriptor(itemB);
  assert(
    descriptorB.videoUrl && descriptorB.audioUrl,
    "rapid unready switch fixture did not expose B media",
    descriptorB,
  );

  let releaseB;
  const bGate = new Promise((resolve) => { releaseB = resolve; });
  await page.route("**/media/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === descriptorB.videoUrl || pathname === descriptorB.audioUrl) {
      await bGate;
    }
    try {
      await route.continue();
    } catch (_error) {
      // Retiring B aborts its gated requests before this test releases them.
    }
  });

  await clickPlayNow(page, "B");
  await waitFor(
    async () => (await state(page)).current_item?.id === "B",
    "rapid switch did not make B authoritative",
  );
  const unreadyB = await waitFor(async () => page.evaluate(() => {
    const session = state.hostPlaybackSession;
    if (
      state.data?.current_item?.id !== "B"
      || session?.video?.dataset?.playerItemId !== "B"
      || session?.phase !== "binding"
    ) {
      return null;
    }
    window.__acceptanceUnreadyBVideo = session.video;
    window.__acceptanceUnreadyBAudio = session.audio;
    return {
      readyCommitted: Boolean(session.readyCommitted),
      readyCommitCount: Number(session.readyCommitCount || 0),
      phase: session.phase,
      videoReadyState: Number(session.video.readyState || 0),
      audioReadyState: Number(session.audio.readyState || 0),
      videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
      audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
    };
  }), "B did not remain one uncommitted candidate");
  const bPlayCallsBeforeC = await page.evaluate(() => (
    window.__acceptanceReadinessPlayCalls || []
  ).filter((entry) => entry.itemId === "B"));
  assert(
    !unreadyB.readyCommitted
      && unreadyB.readyCommitCount === 0
      && unreadyB.videoCount === 1
      && unreadyB.audioCount === 1
      && bPlayCallsBeforeC.length === 0,
    "unready B committed or started before C superseded it",
    { unreadyB, bPlayCallsBeforeC },
  );

  await clickPlayNow(page, "C");
  await waitFor(
    async () => (await state(page)).current_item?.id === "C",
    "rapid switch did not make C authoritative",
  );
  const cPlaying = await observeAutomaticPlayback(page, "C", 0.15);
  await page.evaluate(() => {
    window.__acceptanceCommittedCVideo = state.hostPlaybackSession?.video || null;
    window.__acceptanceCommittedCAudio = state.hostPlaybackSession?.audio || null;
  });
  releaseB();
  await new Promise((resolve) => setTimeout(resolve, 600));

  const finalMedia = await media(page);
  const identity = await page.evaluate(() => {
    const session = state.hostPlaybackSession;
    return {
      currentSession: isCurrentHostPlaybackSession(
        session,
        session?.video,
        session?.audio,
      ),
      sameCVideo: session?.video === window.__acceptanceCommittedCVideo,
      sameCAudio: session?.audio === window.__acceptanceCommittedCAudio,
      bVideoConnected: Boolean(window.__acceptanceUnreadyBVideo?.isConnected),
      bAudioConnected: Boolean(window.__acceptanceUnreadyBAudio?.isConnected),
      bVideoSrc: window.__acceptanceUnreadyBVideo?.getAttribute("src") || "",
      bAudioSrc: window.__acceptanceUnreadyBAudio?.getAttribute("src") || "",
      bVideoPaused: Boolean(window.__acceptanceUnreadyBVideo?.paused),
      bAudioPaused: Boolean(window.__acceptanceUnreadyBAudio?.paused),
    };
  });
  const playCalls = await page.evaluate(
    () => (window.__acceptanceReadinessPlayCalls || []).slice(),
  );
  const staleBStatus = mediaPublications.filter(
    (entry) => entry.pathname === "/api/player/status" && entry.payload?.item_id === "B",
  );
  assert(
    finalMedia.itemId === "C"
      && finalMedia.readyCommitted
      && finalMedia.readyCommitCount === 1
      && finalMedia.sessionPhase === "playing"
      && finalMedia.videoCount === 1
      && finalMedia.audioCount === 1
      && finalMedia.replacementCount === 2
      && !finalMedia.paused
      && finalMedia.currentTime > cPlaying.currentTime + 0.1
      && identity.currentSession
      && identity.sameCVideo
      && identity.sameCAudio
      && !identity.bVideoConnected
      && !identity.bAudioConnected
      && !identity.bVideoSrc
      && !identity.bAudioSrc
      && identity.bVideoPaused
      && identity.bAudioPaused
      && playCalls.filter((entry) => entry.itemId === "B").length === 0
      && staleBStatus.length === 0,
    "retired unready B affected the exact committed C pair",
    { cPlaying, finalMedia, identity, playCalls, staleBStatus },
  );
  await page.unroute("**/media/**");
  observations.push({
    boundary: "rapid-unready-candidate-supersession",
    unreadyB,
    identity,
    playCalls,
    media: finalMedia,
  });
}

async function settingsProgramReconciliation(page) {
  const started = await startPlayback(page, "A");
  const before = await state(page);
  const old = descriptor(before.current_item);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptanceSettingsOldVideo = state.hostPlaybackSession?.video || null;
    window.__acceptanceSettingsOldAudio = state.hostPlaybackSession?.audio || null;
  });

  const frozenResponse = await page.request.get(`${baseUrl}/api/state`);
  const frozenPayload = await frozenResponse.json();
  await page.route("**/api/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(frozenPayload),
    });
  });

  await clickCurrentRecache(page);
  const authoritative = await waitFor(async () => {
    const snapshot = await state(page);
    return snapshot.playback_generation === before.playback_generation + 1
      && snapshot.current_item?.artifact_set_id
      && snapshot.current_item.artifact_set_id !== old.artifactSetId
      ? snapshot
      : null;
  }, "settings reconciliation recache did not publish a newer Rust program", 20000);

  const carried = await page.evaluate(async () => {
    await setLocalPlayerKeyShift(2);
    const session = state.hostPlaybackSession;
    window.__acceptanceSettingsCurrentVideo = session?.video || null;
    window.__acceptanceSettingsCurrentAudio = session?.audio || null;
    return {
      stateGeneration: Number(state.data?.playback_generation || 0),
      sessionGeneration: Number(session?.playbackGeneration || 0),
      stateArtifactSetId: state.data?.playback_program?.artifact_set_id || "",
      sessionArtifactSetId: session?.playbackProgram?.artifact_set_id || "",
      currentSession: isCurrentHostPlaybackSession(
        session,
        session?.video,
        session?.audio,
      ),
      phase: session?.phase || "",
      videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
      audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
      oldVideoConnected: Boolean(window.__acceptanceSettingsOldVideo?.isConnected),
      oldAudioConnected: Boolean(window.__acceptanceSettingsOldAudio?.isConnected),
    };
  });
  assert(
    carried.stateGeneration === authoritative.playback_generation
      && carried.sessionGeneration === authoritative.playback_generation
      && carried.stateArtifactSetId === authoritative.playback_program.artifact_set_id
      && carried.sessionArtifactSetId === authoritative.playback_program.artifact_set_id
      && carried.currentSession
      && carried.videoCount === 1
      && carried.audioCount === 1
      && !carried.oldVideoConnected
      && !carried.oldAudioConnected,
    "nominal settings response left accepted state ahead of the Host session",
    { authoritative, carried },
  );

  const playing = await observeAutomaticPlayback(page, "A", 0.15);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const frozenPollProof = await page.evaluate(() => {
    const session = state.hostPlaybackSession;
    return {
      sameVideo: session?.video === window.__acceptanceSettingsCurrentVideo,
      sameAudio: session?.audio === window.__acceptanceSettingsCurrentAudio,
      stateGeneration: Number(state.data?.playback_generation || 0),
      sessionGeneration: Number(session?.playbackGeneration || 0),
      replacementCount: Number(window.__acceptanceReplacementCount || 0),
    };
  });
  const settled = await media(page);
  assert(
    frozenPollProof.sameVideo
      && frozenPollProof.sameAudio
      && frozenPollProof.stateGeneration === authoritative.playback_generation
      && frozenPollProof.sessionGeneration === authoritative.playback_generation
      && frozenPollProof.replacementCount === 1
      && settled.readyCommitted
      && settled.readyCommitCount === 1
      && settled.videoCount === 1
      && settled.audioCount === 1
      && !settled.paused
      && settled.currentTime > playing.currentTime + 0.1,
    "settings-carried reconciliation waited for polling or remounted twice",
    { started, playing, frozenPollProof, settled },
  );
  await page.unroute("**/api/state");
  observations.push({
    boundary: "settings-response-program-reconciliation",
    beforeGeneration: before.playback_generation,
    carried,
    frozenPollProof,
    media: settled,
  });
}

async function skippedIntermediateProgram(page) {
  const started = await startPlayback(page, "A");
  const before = await state(page);
  const old = descriptor(before.current_item);
  await installReplacementObserver(page);
  await page.evaluate(() => {
    window.__acceptanceSkippedOldVideo = state.hostPlaybackSession?.video || null;
    window.__acceptanceSkippedOldAudio = state.hostPlaybackSession?.audio || null;
  });

  const frozenResponse = await page.request.get(`${baseUrl}/api/state`);
  assert(frozenResponse.ok(), "failed to capture the pre-intermediate Host snapshot");
  const frozenPayload = await frozenResponse.json();
  await page.route("**/api/state", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(frozenPayload),
    });
  });

  const serializedPrograms = await page.evaluate(async () => {
    const g2 = await apiPost("/api/player/restart-program");
    const g3 = await apiPost("/api/player/restart-program");
    return {
      g2Generation: Number(g2?.playback_generation || 0),
      g2ArtifactSetId: g2?.playback_program?.artifact_set_id || "",
      g3Generation: Number(g3?.playback_generation || 0),
      g3ArtifactSetId: g3?.playback_program?.artifact_set_id || "",
      acceptedGeneration: Number(state.data?.playback_generation || 0),
      sessionGeneration: Number(state.hostPlaybackSession?.playbackGeneration || 0),
      claimRequestsStarted: Boolean(state.hostPlaybackSession?.ownershipClaimStarted),
    };
  });
  assert(
    serializedPrograms.g2Generation === before.playback_generation + 1
      && serializedPrograms.g3Generation === before.playback_generation + 2
      && serializedPrograms.g2ArtifactSetId === old.artifactSetId
      && serializedPrograms.g3ArtifactSetId === old.artifactSetId
      && serializedPrograms.acceptedGeneration === before.playback_generation
      && serializedPrograms.sessionGeneration === before.playback_generation
      && serializedPrograms.claimRequestsStarted,
    "intermediate restart responses changed the central Host without acceptance",
    { before, old, serializedPrograms },
  );

  await page.unroute("**/api/state");
  const mountedG3 = await waitFor(async () => page.evaluate((expectedGeneration) => {
    const session = state.hostPlaybackSession;
    if (
      Number(state.data?.playback_generation || 0)
        !== Number(session?.playbackGeneration || 0)
      || Number(session?.playbackGeneration || 0) !== expectedGeneration
      || !session?.ownershipClaimed
      || !isCurrentHostPlaybackSession(session, session.video, session.audio)
    ) {
      return null;
    }
    return {
      generation: session.playbackGeneration,
      artifactSetId: session.playbackProgram?.artifact_set_id || "",
      videoCount: document.querySelectorAll('video[data-player-role="video"]').length,
      audioCount: document.querySelectorAll('audio[data-player-role="audio"]').length,
    };
  }, serializedPrograms.g3Generation), "Host did not accept and claim only the final serialized program");
  assert(
    mountedG3.generation === serializedPrograms.g3Generation
      && mountedG3.artifactSetId === old.artifactSetId
      && mountedG3.videoCount === 1
      && mountedG3.audioCount === 1,
    "Host mounted an unexpected serialized program",
    { mountedG3, serializedPrograms },
  );
  const g3Playing = await observeAutomaticPlayback(page, "A", 0.15);

  await clickCurrentRecache(page);
  const replacement = await waitForReplacement(page, old);
  const finalPlaying = await observeAutomaticPlayback(page, "A", 0.15);
  const settled = await waitFor(async () => {
    const value = await media(page);
    return !value.paused && value.currentTime > finalPlaying.currentTime + 0.1
      ? value
      : null;
  }, "replacement playback did not continue after skipped intermediate programs");
  const identity = await page.evaluate(() => ({
    oldVideoConnected: Boolean(window.__acceptanceSkippedOldVideo?.isConnected),
    oldAudioConnected: Boolean(window.__acceptanceSkippedOldAudio?.isConnected),
    currentSession: isCurrentHostPlaybackSession(
      state.hostPlaybackSession,
      state.hostPlaybackSession?.video,
      state.hostPlaybackSession?.audio,
    ),
  }));
  assert(
    replacement.next.artifactSetId !== old.artifactSetId
      && settled.ownershipClaimed
      && !settled.ownershipClaimFailed
      && settled.videoCount === 1
      && settled.audioCount === 1
      && settled.replacementCount === 2
      && !settled.paused
      && settled.currentTime > finalPlaying.currentTime + 0.1
      && identity.currentSession
      && !identity.oldVideoConnected
      && !identity.oldAudioConnected,
    "skipped intermediate ownership did not settle to one protected replacement pair",
    { started, g3Playing, replacement, finalPlaying, settled, identity },
  );
  observations.push({
    boundary: "serialized-intermediate-program-was-never-owned",
    beforeGeneration: before.playback_generation,
    serializedPrograms,
    mountedG3,
    oldArtifactSetId: old.artifactSetId,
    finalArtifactSetId: replacement.next.artifactSetId,
    media: settled,
  });
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

async function rapidSessionSwitch(page) {
  await waitFor(async () => {
    const probe = await page.evaluate(() => ({
      overrideInstalled: Boolean(window.__acceptancePlayOverrideInstalled),
      pendingCount: (window.__acceptancePendingOldPlays || []).length,
      playCalls: window.__acceptanceMediaPlayCalls || [],
      startState: state.localPlaybackStartState,
      shouldPlay: state.localShouldBePlaying,
      videoReadyState: Number(state.hostPlaybackSession?.video?.readyState || 0),
      audioReadyState: Number(state.hostPlaybackSession?.audio?.readyState || 0),
    }));
    if (probe.pendingCount < 2) {
      throw new Error(JSON.stringify(probe));
    }
    return probe;
  }, "A did not leave two media play promises pending");
  await page.evaluate(() => {
    window.__acceptanceRapidOldVideo = document.querySelector(
      'video[data-player-role="video"]',
    );
    window.__acceptanceRapidOldAudio = document.querySelector(
      'audio[data-player-role="audio"]',
    );
  });

  await page.locator("#next-button").click();
  await waitFor(
    async () => (await state(page)).current_item?.id === "B",
    "rapid switch did not make B authoritative",
  );
  const bPlaying = await observeAutomaticPlayback(page, "B", 0.15);
  const beforeSettlement = await page.evaluate(() => {
    const session = state.hostPlaybackSession;
    window.__acceptanceRapidBVideo = session?.video || null;
    window.__acceptanceRapidBAudio = session?.audio || null;
    return {
      startState: state.localPlaybackStartState,
      shouldPlay: state.localShouldBePlaying,
      sessionCurrent: isCurrentHostPlaybackSession(
        session,
        session?.video,
        session?.audio,
      ),
      playbackGeneration: session?.playbackGeneration || 0,
      authoritativeGeneration: state.data?.playback_generation || 0,
    };
  });
  assert(
    beforeSettlement.startState === "established"
      && beforeSettlement.shouldPlay
      && beforeSettlement.sessionCurrent
      && beforeSettlement.playbackGeneration === beforeSettlement.authoritativeGeneration,
    "B was not established as the exact current session before A settled",
    beforeSettlement,
  );

  const publicationBoundary = mediaPublications.length;
  await page.evaluate(() => {
    const pending = window.__acceptancePendingOldPlays || [];
    const videoPlay = pending.find((entry) => entry.role === "video");
    const audioPlay = pending.find((entry) => entry.role === "audio");
    videoPlay?.resolve();
    audioPlay?.reject(new DOMException("retired autoplay rejection", "NotAllowedError"));
  });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const afterSettlement = await page.evaluate(() => {
    const session = state.hostPlaybackSession;
    return {
      startState: state.localPlaybackStartState,
      shouldPlay: state.localShouldBePlaying,
      sameVideo: session?.video === window.__acceptanceRapidBVideo,
      sameAudio: session?.audio === window.__acceptanceRapidBAudio,
      sessionCurrent: isCurrentHostPlaybackSession(
        session,
        session?.video,
        session?.audio,
      ),
      oldVideoPaused: Boolean(window.__acceptanceRapidOldVideo?.paused),
      oldAudioPaused: Boolean(window.__acceptanceRapidOldAudio?.paused),
      oldVideoSrc: window.__acceptanceRapidOldVideo?.getAttribute("src") || "",
      oldAudioSrc: window.__acceptanceRapidOldAudio?.getAttribute("src") || "",
    };
  });
  const afterMedia = await media(page);
  const stalePublications = mediaPublications.slice(publicationBoundary).filter(
    (entry) => entry?.payload?.item_id === "A",
  );
  assert(
    afterSettlement.startState === "established"
      && afterSettlement.shouldPlay
      && afterSettlement.sameVideo
      && afterSettlement.sameAudio
      && afterSettlement.sessionCurrent,
    "late A play settlement changed B's session or start state",
    afterSettlement,
  );
  assert(
    afterMedia.itemId === "B"
      && afterMedia.videoCount === 1
      && afterMedia.audioCount === 1
      && !afterMedia.paused
      && afterMedia.currentTime > bPlaying.currentTime + 0.1,
    "late A play settlement disturbed B's real playback",
    { bPlaying, afterMedia },
  );
  assert(
    afterSettlement.oldVideoPaused
      && afterSettlement.oldAudioPaused
      && !afterSettlement.oldVideoSrc
      && !afterSettlement.oldAudioSrc,
    "A's exact retired elements were not reset",
    afterSettlement,
  );
  assert(
    stalePublications.length === 0,
    "retired A published player status or diagnostics after settlement",
    stalePublications,
  );
  observations.push({
    boundary: "rapid-session-switch-rejected-late-play-settlement",
    beforeSettlement,
    afterSettlement,
    media: afterMedia,
  });
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
  const context = await browser.newContext(
    scenario === "rapid-session-switch"
      ? {
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
        }
      : {},
  );
  const page = await context.newPage();
  if (scenario === "rapid-session-switch") {
    await page.addInitScript(() => {
      const nativePlay = HTMLMediaElement.prototype.play;
      window.__acceptancePlayOverrideInstalled = true;
      window.__acceptancePendingOldPlays = [];
      window.__acceptanceMediaPlayCalls = [];
      HTMLMediaElement.prototype.play = function acceptancePlay() {
        const itemId = this.dataset?.playerItemId
          || document.querySelector('video[data-player-role="video"]')?.dataset?.playerItemId
          || "";
        window.__acceptanceMediaPlayCalls.push({
          itemId,
          role: this.dataset?.playerRole || "",
        });
        if (itemId !== "A") {
          return nativePlay.call(this);
        }
        const media = this;
        return new Promise((resolve, reject) => {
          window.__acceptancePendingOldPlays.push({
            role: media.dataset?.playerRole || "",
            resolve,
            reject,
          });
        });
      };
    });
  }
  if (scenario === "staggered-readiness" || scenario === "rapid-unready-switch") {
    await page.addInitScript(() => {
      const nativePlay = HTMLMediaElement.prototype.play;
      window.__acceptanceReadinessPlayCalls = [];
      HTMLMediaElement.prototype.play = function acceptanceReadinessPlay() {
        const itemId = this.dataset?.playerItemId
          || document.querySelector('video[data-player-role="video"]')?.dataset?.playerItemId
          || "";
        window.__acceptanceReadinessPlayCalls.push({
          itemId,
          role: this.dataset?.playerRole || "",
        });
        return nativePlay.call(this);
      };
    });
  }
  if (scenario === "staggered-readiness") {
    const initialSnapshot = await state(page);
    const candidate = descriptor(initialSnapshot.current_item);
    assert(
      initialSnapshot.current_item?.id === "A"
        && candidate.videoUrl
        && candidate.audioUrl,
      "staggered readiness fixture did not expose one exact candidate pair",
      { currentItem: initialSnapshot.current_item?.id || "", candidate },
    );
    const candidateVideoUrl = new URL(candidate.videoUrl, baseUrl);
    const candidateAudioUrl = new URL(candidate.audioUrl, baseUrl);
    staggeredReadinessEvidence = {
      candidateVideoUrl: candidateVideoUrl.href,
      candidateVideoPathname: candidateVideoUrl.pathname,
      candidateAudioUrl: candidateAudioUrl.href,
      candidateAudioPathname: candidateAudioUrl.pathname,
      videoGateInterceptCount: 0,
      interceptedVideoUrl: "",
      interceptedVideoPathname: "",
      audioRequestedBeforeRelease: false,
      audioResponseReceivedBeforeRelease: false,
      audioResponseStatus: null,
      audioReadyBeforeRelease: false,
      videoResponseReceivedBeforeRelease: false,
      videoResponseStatus: null,
      released: false,
    };
    let releaseVideo;
    const videoGate = new Promise((resolve) => { releaseVideo = resolve; });
    releaseStaggeredVideo = () => {
      if (staggeredReadinessEvidence.released) {
        return;
      }
      staggeredReadinessEvidence.released = true;
      releaseVideo();
    };
    await page.route((url) => url.href === candidateVideoUrl.href, async (route) => {
      const request = route.request();
      staggeredReadinessEvidence.videoGateInterceptCount += 1;
      staggeredReadinessEvidence.interceptedVideoUrl = request.url();
      staggeredReadinessEvidence.interceptedVideoPathname = new URL(request.url()).pathname;
      await videoGate;
      try {
        await route.continue();
      } catch (_error) {
        // The exact candidate can retire while a gated request is pending.
      }
    });
    page.on("request", (request) => {
      if (
        request.url() === candidateAudioUrl.href
        && !staggeredReadinessEvidence.released
      ) {
        staggeredReadinessEvidence.audioRequestedBeforeRelease = true;
      }
    });
    page.on("response", (response) => {
      if (response.url() === candidateAudioUrl.href) {
        staggeredReadinessEvidence.audioResponseStatus = response.status();
        if (!staggeredReadinessEvidence.released) {
          staggeredReadinessEvidence.audioResponseReceivedBeforeRelease = true;
        }
      } else if (response.url() === candidateVideoUrl.href) {
        staggeredReadinessEvidence.videoResponseStatus = response.status();
        if (!staggeredReadinessEvidence.released) {
          staggeredReadinessEvidence.videoResponseReceivedBeforeRelease = true;
        }
      }
    });
  }
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({ text: message.text(), location: message.location() });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST"
      && (pathname === "/api/player/status" || pathname === "/api/player/diagnostic")
    ) {
      let payload = null;
      try {
        payload = request.postDataJSON();
      } catch (_error) {
        payload = null;
      }
      mediaPublications.push({ pathname, payload });
    }
  });
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
    if (scenario !== "staggered-readiness") {
      await waitForMedia(page, "A");
    }
    if (scenario === "player-reset") {
      await playerReset(page);
    } else if (scenario === "failed-reset") {
      await failedPlayerReset(page);
    } else if (scenario === "recache-playing") {
      await recachePlaying(page);
    } else if (scenario === "retire-held-range") {
      await retireHeldRange(page);
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
    } else if (scenario === "rapid-session-switch") {
      await rapidSessionSwitch(page);
    } else if (scenario === "stale-next-recache") {
      await staleNextRecache(page);
    } else if (scenario === "stale-next-first-carrier") {
      await staleNextRecache(page, { firstCarrier: true });
    } else if (scenario === "staggered-readiness") {
      await staggeredReadiness(page);
    } else if (scenario === "rapid-unready-switch") {
      await rapidUnreadySwitch(page);
    } else if (scenario === "settings-program-reconciliation") {
      await settingsProgramReconciliation(page);
    } else if (scenario === "skipped-intermediate-program") {
      await skippedIntermediateProgram(page);
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
      staggeredReadinessEvidence,
      observations,
      consoleErrors,
      pageErrors,
    })}\n`);
    process.exitCode = 1;
  },
);
