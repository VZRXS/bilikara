(function initPresentationScene(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  globalScope.BilikaraPresentationScene = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPresentationSceneApi() {
  "use strict";

  const supportedThemes = new Set(["light", "dark", "blue"]);
  const maxOverlayRows = 5;

  /** @param {unknown} value @param {number} fallback */
  function finiteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  /** @param {unknown} value */
  function text(value) {
    return String(value ?? "");
  }

  /**
   * @typedef {Object} PresentationOverlayRow
   * @property {string} title
   * @property {string} requester
   * @property {string} duration
   */

  /**
   * @typedef {Object} PresentationScene
   * @property {number} generation
   * @property {number} revision
   * @property {string} currentItemIdentity
   * @property {string} title
   * @property {string} videoUrl
   * @property {{requester: string, duration: string, detail: string}} displayMetadata
   * @property {"light"|"dark"|"blue"} theme
   * @property {Object|null} overlay
   */

  function normalizeOverlay(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const rows = Array.isArray(candidate.rows)
      ? candidate.rows.slice(0, maxOverlayRows).map((row) => ({
        title: text(row?.title),
        requester: text(row?.requester),
        duration: text(row?.duration),
      }))
      : [];
    return {
      visible: Boolean(candidate.visible),
      heading: text(candidate.heading),
      countdownLabel: text(candidate.countdownLabel),
      deadline: Math.max(0, finiteNumber(candidate.deadline)),
      durationMs: Math.max(0, finiteNumber(candidate.durationMs)),
      title: text(candidate.title),
      requester: text(candidate.requester),
      duration: text(candidate.duration),
      queueHeading: text(candidate.queueHeading),
      rows,
      emptyText: text(candidate.emptyText),
      remainingText: text(candidate.remainingText),
      totalText: text(candidate.totalText),
    };
  }

  /** @param {unknown} candidate @returns {PresentationScene} */
  function normalizePresentationScene(candidate) {
    const scene = candidate && typeof candidate === "object" ? candidate : {};
    const metadata = scene.displayMetadata && typeof scene.displayMetadata === "object"
      ? scene.displayMetadata
      : {};
    return {
      generation: Math.max(0, Math.trunc(finiteNumber(scene.generation))),
      revision: Math.max(0, Math.trunc(finiteNumber(scene.revision))),
      currentItemIdentity: text(scene.currentItemIdentity),
      title: text(scene.title),
      videoUrl: text(scene.videoUrl),
      displayMetadata: {
        requester: text(metadata.requester),
        duration: text(metadata.duration),
        detail: text(metadata.detail),
      },
      theme: supportedThemes.has(scene.theme) ? scene.theme : "light",
      overlay: normalizeOverlay(scene.overlay),
    };
  }

  return {
    maxOverlayRows,
    normalizeOverlay,
    normalizePresentationScene,
  };
});
