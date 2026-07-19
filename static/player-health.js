(function initBilikaraPlayerHealth(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BilikaraPlayerHealth = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function buildPlayerHealth() {
  "use strict";

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function positiveDuration(value) {
    const number = finiteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  function durationToleranceSeconds(expectedDuration, fallbackDuration) {
    const reference = positiveDuration(expectedDuration) || positiveDuration(fallbackDuration) || 0;
    return Math.max(3, reference * 0.02);
  }

  function remainingSeconds(duration, currentTime) {
    const normalizedDuration = positiveDuration(duration);
    const normalizedCurrent = finiteNumber(currentTime);
    if (normalizedDuration === null || normalizedCurrent === null) {
      return null;
    }
    return Math.max(0, normalizedDuration - normalizedCurrent);
  }

  function classifyAudioEnded(input) {
    const values = input || {};
    const videoRemaining = remainingSeconds(values.videoDuration, values.videoCurrentTime);
    const expectedRemaining = remainingSeconds(values.expectedDuration, values.videoCurrentTime);
    const tolerance = durationToleranceSeconds(values.expectedDuration, values.videoDuration);
    const offset = Math.abs(finiteNumber(values.avOffsetSeconds) || 0);
    const allowedRemaining = tolerance + offset;
    const suspiciousRemaining = Math.max(videoRemaining || 0, expectedRemaining || 0);
    if (suspiciousRemaining > allowedRemaining) {
      return {
        classification: "audio-ended-early",
        fault: true,
        remainingSeconds: suspiciousRemaining,
        toleranceSeconds: allowedRemaining,
      };
    }
    return {
      classification: "normal-end",
      fault: false,
      remainingSeconds: suspiciousRemaining,
      toleranceSeconds: allowedRemaining,
    };
  }

  function classifyVideoEnded(input) {
    const values = input || {};
    const expectedRemaining = remainingSeconds(values.expectedDuration, values.videoCurrentTime);
    const audioRemaining = remainingSeconds(values.audioDuration, values.audioCurrentTime);
    const tolerance = durationToleranceSeconds(values.expectedDuration, values.videoDuration);
    const offset = Math.abs(finiteNumber(values.avOffsetSeconds) || 0);
    const allowedRemaining = tolerance + offset;
    const suspiciousRemaining = Math.max(expectedRemaining || 0, audioRemaining || 0);
    if (suspiciousRemaining > allowedRemaining) {
      return {
        classification: "video-ended-early",
        fault: true,
        remainingSeconds: suspiciousRemaining,
        toleranceSeconds: allowedRemaining,
      };
    }
    return {
      classification: "normal-end",
      fault: false,
      remainingSeconds: suspiciousRemaining,
      toleranceSeconds: allowedRemaining,
    };
  }

  function classifyBuffering(input) {
    const values = input || {};
    const eventCount = Math.max(0, Number(values.eventCount || 0));
    const readyState = Math.max(0, Number(values.readyState || 0));
    const networkState = Math.max(0, Number(values.networkState || 0));
    const noSource = networkState === 3;
    const repeatedUnavailable = eventCount >= 3 && readyState < 3;
    return {
      classification: noSource ? "media-no-source" : "media-repeated-buffering",
      // waiting/stalled also fire during ordinary buffering and intentional
      // audio resyncs. Only a hard no-source state justifies redownloading.
      fault: noSource,
      transient: repeatedUnavailable && !noSource,
      eventCount,
      readyState,
      networkState,
    };
  }

  function classifyMediaError(mediaKind, errorCode) {
    const code = Number(errorCode || 0);
    return {
      classification: `${String(mediaKind || "media")}-error`,
      fault: true,
      errorCode: code,
    };
  }

  function shouldGuardAdvance(reason) {
    return String(reason || "") === "media-ended";
  }

  return {
    durationToleranceSeconds,
    remainingSeconds,
    classifyAudioEnded,
    classifyVideoEnded,
    classifyBuffering,
    classifyMediaError,
    shouldGuardAdvance,
  };
}));
