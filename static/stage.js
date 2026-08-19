(function startStage() {
  "use strict";

  const sync = window.BilikaraStageSync;
  const renderer = window.BilikaraStageRenderer;
  const frame = document.getElementById("stage-frame");
  const fullscreenHint = document.getElementById("stage-fullscreen-hint");
  const tauriInvoke = window.__TAURI__?.core?.invoke || null;
  const nativeFullscreenRequested = new URLSearchParams(window.location.search)
    .get("nativeFullscreen") === "1";
  const cursorHideDelayMs = 2200;
  const senderId = `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let channel = null;
  let lastMasterEnvelope = null;
  let lastScene = null;
  let lastClock = null;
  let video = null;
  let overlay = null;
  let lastDriftSeconds = 0;
  let cursorHideTimer = null;
  let nativeFullscreenActive = false;

  function revealStageCursor() {
    document.body.classList.remove("is-cursor-hidden");
    if (cursorHideTimer) {
      window.clearTimeout(cursorHideTimer);
    }
    cursorHideTimer = window.setTimeout(() => {
      document.body.classList.add("is-cursor-hidden");
      cursorHideTimer = null;
    }, cursorHideDelayMs);
  }

  function fullscreenHintNeeded() {
    return !nativeFullscreenActive && !document.fullscreenElement;
  }

  async function enterStageFullscreen() {
    if (typeof tauriInvoke === "function") {
      await tauriInvoke("set_window_fullscreen", { fullscreen: true });
      nativeFullscreenActive = true;
      fullscreenHint?.classList.remove("is-visible");
      return;
    }
    await document.documentElement.requestFullscreen?.();
    fullscreenHint?.classList.toggle("is-visible", !document.fullscreenElement);
  }

  function send(type, payload = {}) {
    const envelope = sync.makeEnvelope(type, payload, {
      senderId,
      sequence: ++sequence,
      sentAt: Date.now(),
    });
    channel?.postMessage(envelope);
    try {
      localStorage.setItem(sync.storageKey, JSON.stringify(envelope));
      localStorage.removeItem(sync.storageKey);
    } catch {
      // BroadcastChannel is the primary transport; storage is only a fallback.
    }
  }

  function sceneChanged(nextScene) {
    return !lastScene
      || nextScene.revision !== lastScene.revision
      || nextScene.itemId !== lastScene.itemId
      || nextScene.videoUrl !== lastScene.videoUrl;
  }

  function mountScene(scene) {
    document.documentElement.dataset.theme = scene.theme;
    document.title = scene.title ? `${scene.title} · Bilikara Stage` : "Bilikara Stage";
    if (!scene.videoUrl) {
      renderer.renderEmpty(frame, "正在等待预览画面…");
      video = null;
    } else {
      const mounted = renderer.mountMedia(frame, scene, {
        autoplay: false,
        controls: false,
        includeAudio: false,
        muted: true,
        preload: "auto",
      });
      video = mounted.video;
      video.addEventListener("error", () => {
        send("stage-status", {
          ready: false,
          itemId: scene.itemId,
          error: "video-error",
        });
      });
      video.addEventListener("loadedmetadata", applyClock);
      video.addEventListener("canplay", applyClock);
    }
    overlay = renderer.ensureOverlay(frame, {
      countdownLabel: scene.overlay?.countdownLabel,
    });
    renderOverlay();
  }

  function renderOverlay() {
    if (!lastScene) {
      return;
    }
    overlay = overlay || renderer.ensureOverlay(frame, {
      countdownLabel: lastScene.overlay?.countdownLabel,
    });
    renderer.renderOverlay(overlay, lastScene.overlay || { visible: false }, {
      compact: false,
      manageVisibility: true,
      now: Date.now(),
    });
  }

  function safeSeek(targetTime) {
    if (!video || video.readyState < 1) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(Number(targetTime || 0), duration));
    try {
      video.currentTime = target;
    } catch {
      // A later clock tick will retry after metadata is available.
    }
  }

  function applyClock() {
    if (!video || !lastClock || lastClock.itemId !== lastScene?.itemId) {
      return;
    }
    const correction = sync.planClockCorrection(lastClock, {
      currentTime: video.currentTime,
      paused: video.paused,
    }, Date.now());
    lastDriftSeconds = correction.driftSeconds;

    if (correction.action === "seek") {
      safeSeek(correction.targetTime);
    }
    if (Math.abs(video.playbackRate - correction.playbackRate) > 0.001) {
      video.playbackRate = correction.playbackRate;
    }
    if (!correction.shouldPlay) {
      if (!video.paused) {
        video.pause();
      }
      return;
    }
    if (video.paused && !video.ended && video.readyState >= 1) {
      video.play().catch(() => {
        fullscreenHint?.classList.add("is-visible");
        send("stage-status", {
          ready: true,
          itemId: lastScene?.itemId || "",
          autoplayBlocked: true,
        });
      });
    }
  }

  function handleMasterMessage(candidate) {
    if (candidate?.type === "stage-close") {
      window.close();
      return;
    }
    if (candidate?.type !== "master-state" || !sync.acceptsEnvelope(lastMasterEnvelope, candidate)) {
      return;
    }
    lastMasterEnvelope = candidate;
    const nextScene = sync.normalizeScene(candidate.payload?.scene);
    lastClock = sync.normalizeClock(candidate.payload?.clock);
    const shouldMount = sceneChanged(nextScene);
    lastScene = nextScene;
    if (shouldMount) {
      mountScene(nextScene);
    } else {
      document.documentElement.dataset.theme = nextScene.theme;
      renderOverlay();
    }
    applyClock();
  }

  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(sync.channelName);
    channel.addEventListener("message", (event) => handleMasterMessage(event.data));
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== sync.storageKey || !event.newValue) {
      return;
    }
    try {
      handleMasterMessage(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed transport fallback messages.
    }
  });

  fullscreenHint?.addEventListener("click", () => {
    enterStageFullscreen().catch(() => {
      fullscreenHint.classList.add("is-visible");
    });
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenHint?.classList.toggle("is-visible", fullscreenHintNeeded());
  });
  document.addEventListener("pointermove", () => {
    revealStageCursor();
    if (fullscreenHintNeeded()) {
      fullscreenHint?.classList.add("is-visible");
    }
  }, { passive: true });
  document.addEventListener("pointerdown", revealStageCursor, { passive: true });
  document.addEventListener("keydown", revealStageCursor);

  window.setInterval(() => {
    applyClock();
    renderOverlay();
  }, 100);
  window.setInterval(() => {
    send("stage-ready", {
      ready: true,
      itemId: lastScene?.itemId || "",
    });
    if (video) {
      send("stage-status", {
        ready: true,
        itemId: lastScene?.itemId || "",
        currentTime: Number(video.currentTime || 0),
        paused: Boolean(video.paused),
        driftSeconds: lastDriftSeconds,
      });
    }
  }, 1000);
  window.addEventListener("pagehide", () => {
    if (cursorHideTimer) {
      window.clearTimeout(cursorHideTimer);
    }
    send("stage-status", { ready: false, closed: true });
    channel?.close();
  });

  revealStageCursor();
  if (nativeFullscreenRequested && typeof tauriInvoke === "function") {
    window.setTimeout(() => {
      enterStageFullscreen().catch(() => {
        fullscreenHint?.classList.add("is-visible");
      });
    }, 250);
  } else {
    fullscreenHint?.classList.toggle("is-visible", fullscreenHintNeeded());
  }
  send("stage-ready", { ready: true });
})();
