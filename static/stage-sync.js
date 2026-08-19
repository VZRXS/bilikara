(function initStageSync(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  globalScope.BilikaraStageSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStageSync() {
  "use strict";

  const protocolVersion = 1;
  const channelName = "bilikara-stage-v1";
  const storageKey = "bilikara.stage.message.v1";
  const softSyncThresholdSeconds = 0.06;
  const hardSyncThresholdSeconds = 0.30;
  const playbackRateCorrection = 0.04;

  function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function normalizeClock(clock) {
    return {
      itemId: String(clock?.itemId || ""),
      mediaTime: Math.max(0, finiteNumber(clock?.mediaTime)),
      sampledAt: Math.max(0, finiteNumber(clock?.sampledAt)),
      paused: Boolean(clock?.paused),
      playbackRate: Math.max(0.1, finiteNumber(clock?.playbackRate, 1)),
      seeking: Boolean(clock?.seeking),
    };
  }

  function normalizeScene(scene) {
    const overlayRows = Array.isArray(scene?.overlay?.rows)
      ? scene.overlay.rows.slice(0, 5).map((row) => ({
        title: String(row?.title || ""),
        requester: String(row?.requester || ""),
        duration: String(row?.duration || ""),
      }))
      : [];
    const overlay = scene?.overlay && typeof scene.overlay === "object"
      ? {
        visible: Boolean(scene.overlay.visible),
        heading: String(scene.overlay.heading || ""),
        countdownLabel: String(scene.overlay.countdownLabel || ""),
        deadline: Math.max(0, finiteNumber(scene.overlay.deadline)),
        durationMs: Math.max(0, finiteNumber(scene.overlay.durationMs)),
        title: String(scene.overlay.title || ""),
        requester: String(scene.overlay.requester || ""),
        duration: String(scene.overlay.duration || ""),
        queueHeading: String(scene.overlay.queueHeading || ""),
        rows: overlayRows,
        emptyText: String(scene.overlay.emptyText || ""),
        remainingText: String(scene.overlay.remainingText || ""),
        totalText: String(scene.overlay.totalText || ""),
      }
      : null;
    return {
      revision: Math.max(0, Math.trunc(finiteNumber(scene?.revision))),
      itemId: String(scene?.itemId || ""),
      title: String(scene?.title || ""),
      videoUrl: String(scene?.videoUrl || ""),
      theme: ["light", "dark", "blue"].includes(scene?.theme) ? scene.theme : "light",
      overlay,
    };
  }

  function makeEnvelope(type, payload, options = {}) {
    return {
      protocol: protocolVersion,
      type: String(type || ""),
      senderId: String(options.senderId || ""),
      sequence: Math.max(0, Math.trunc(finiteNumber(options.sequence))),
      sentAt: Math.max(0, finiteNumber(options.sentAt, Date.now())),
      payload: payload && typeof payload === "object" ? payload : {},
    };
  }

  function acceptsEnvelope(previous, candidate) {
    if (!candidate || Number(candidate.protocol) !== protocolVersion) {
      return false;
    }
    if (!previous) {
      return true;
    }
    if (String(candidate.senderId || "") !== String(previous.senderId || "")) {
      return true;
    }
    return Number(candidate.sequence || 0) > Number(previous.sequence || 0);
  }

  function predictedMediaTime(clock, nowMs = Date.now()) {
    const normalized = normalizeClock(clock);
    if (normalized.paused || normalized.seeking || normalized.sampledAt <= 0) {
      return normalized.mediaTime;
    }
    const elapsedSeconds = Math.max(0, finiteNumber(nowMs) - normalized.sampledAt) / 1000;
    return Math.max(0, normalized.mediaTime + elapsedSeconds * normalized.playbackRate);
  }

  function planClockCorrection(clock, follower, nowMs = Date.now()) {
    const normalizedClock = normalizeClock(clock);
    const targetTime = predictedMediaTime(normalizedClock, nowMs);
    const currentTime = Math.max(0, finiteNumber(follower?.currentTime));
    const driftSeconds = targetTime - currentTime;
    const absoluteDrift = Math.abs(driftSeconds);
    const followerPaused = Boolean(follower?.paused);

    if (normalizedClock.seeking || absoluteDrift > hardSyncThresholdSeconds) {
      return {
        action: "seek",
        targetTime,
        driftSeconds,
        playbackRate: normalizedClock.playbackRate,
        shouldPlay: !normalizedClock.paused,
      };
    }

    if (normalizedClock.paused) {
      return {
        action: followerPaused ? "none" : "pause",
        targetTime,
        driftSeconds,
        playbackRate: normalizedClock.playbackRate,
        shouldPlay: false,
      };
    }

    if (followerPaused) {
      return {
        action: "play",
        targetTime,
        driftSeconds,
        playbackRate: normalizedClock.playbackRate,
        shouldPlay: true,
      };
    }

    if (absoluteDrift <= softSyncThresholdSeconds) {
      return {
        action: "rate",
        targetTime,
        driftSeconds,
        playbackRate: normalizedClock.playbackRate,
        shouldPlay: true,
      };
    }

    return {
      action: "rate",
      targetTime,
      driftSeconds,
      playbackRate: Math.max(
        0.1,
        normalizedClock.playbackRate + (driftSeconds > 0 ? playbackRateCorrection : -playbackRateCorrection),
      ),
      shouldPlay: true,
    };
  }

  return {
    protocolVersion,
    channelName,
    storageKey,
    softSyncThresholdSeconds,
    hardSyncThresholdSeconds,
    normalizeClock,
    normalizeScene,
    makeEnvelope,
    acceptsEnvelope,
    predictedMediaTime,
    planClockCorrection,
  };
});
