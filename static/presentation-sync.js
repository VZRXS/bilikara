(function initPresentationSync(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  globalScope.BilikaraPresentationSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPresentationSync() {
  "use strict";

  const protocolVersion = 1;
  const channelName = "bilikara-presentation-output-v1";
  const storageKey = "bilikara.presentation.output.v1";
  const softSyncThresholdSeconds = 0.06;
  const hardSyncThresholdSeconds = 0.3;
  const playbackRateCorrection = 0.04;

  function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function normalizeClock(clock) {
    return {
      itemIdentity: String(clock?.itemIdentity || ""),
      mediaTime: Math.max(0, finiteNumber(clock?.mediaTime)),
      sampledAt: Math.max(0, finiteNumber(clock?.sampledAt)),
      paused: Boolean(clock?.paused),
      playbackRate: Math.max(0.1, finiteNumber(clock?.playbackRate, 1)),
      seeking: Boolean(clock?.seeking),
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
    if (!previous || String(candidate.senderId || "") !== String(previous.senderId || "")) {
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
    const normalized = normalizeClock(clock);
    const targetTime = predictedMediaTime(normalized, nowMs);
    const currentTime = Math.max(0, finiteNumber(follower?.currentTime));
    const driftSeconds = targetTime - currentTime;
    const absoluteDrift = Math.abs(driftSeconds);

    if (normalized.seeking || absoluteDrift > hardSyncThresholdSeconds) {
      return {
        action: "seek",
        targetTime,
        driftSeconds,
        playbackRate: normalized.playbackRate,
        shouldPlay: !normalized.paused,
      };
    }
    if (normalized.paused) {
      return {
        action: follower?.paused ? "none" : "pause",
        targetTime,
        driftSeconds,
        playbackRate: normalized.playbackRate,
        shouldPlay: false,
      };
    }
    if (follower?.paused) {
      return {
        action: "play",
        targetTime,
        driftSeconds,
        playbackRate: normalized.playbackRate,
        shouldPlay: true,
      };
    }
    const rate = absoluteDrift <= softSyncThresholdSeconds
      ? normalized.playbackRate
      : Math.max(
        0.1,
        normalized.playbackRate
          + (driftSeconds > 0 ? playbackRateCorrection : -playbackRateCorrection),
      );
    return {
      action: "rate",
      targetTime,
      driftSeconds,
      playbackRate: rate,
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
    makeEnvelope,
    acceptsEnvelope,
    predictedMediaTime,
    planClockCorrection,
  };
});
