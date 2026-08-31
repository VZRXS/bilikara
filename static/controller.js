(function initializePresentationOutput() {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke || null;
  const listen = window.__TAURI__?.event?.listen || null;
  const sceneApi = window.BilikaraPresentationScene;
  const renderer = window.BilikaraPresentationRenderer;
  const sync = window.BilikaraPresentationSync;
  const expectedGeneration = Number(
    new URLSearchParams(window.location.search).get("presentationGeneration"),
  );
  const senderId = `output-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const cursorHideDelayMs = 1800;

  const state = {
    session: null,
    lastMasterEnvelope: null,
    scene: null,
    clock: null,
    video: null,
    channel: null,
    sequence: 0,
    readyGeneration: -1,
    failedClosed: false,
    language: "zh",
    translations: {},
    unlisteners: [],
    cursorHideTimer: null,
    remoteQrPinned: false,
    lastPointerType: "",
  };

  const elements = {
    shell: document.getElementById("controller-shell"),
    frame: document.getElementById("controller-stage-frame"),
    empty: document.getElementById("controller-empty"),
    status: document.getElementById("controller-status"),
    outputControl: document.getElementById("controller-output-control"),
    exit: document.getElementById("controller-exit"),
    remotePopover: document.getElementById("controller-remote-popover"),
    remoteQrImage: document.getElementById("controller-remote-qr-image"),
    remoteQrPlaceholder: document.getElementById("controller-remote-qr-placeholder"),
    remoteUrlLink: document.getElementById("controller-remote-url-link"),
    remoteUrlHint: document.getElementById("controller-remote-url-hint"),
    error: document.getElementById("controller-error"),
    unavailable: document.getElementById("controller-unavailable"),
  };

  function t(key) {
    return String(state.translations[key] || key);
  }

  function preferredLanguage() {
    const languages = Array.isArray(navigator.languages)
      ? navigator.languages
      : [navigator.language];
    for (const language of languages) {
      const normalized = String(language || "").toLowerCase();
      if (normalized.startsWith("ja")) return "ja";
      if (normalized.startsWith("en")) return "en";
      if (normalized.startsWith("zh")) return "zh";
    }
    return "zh";
  }

  async function loadTranslations() {
    try {
      const response = await fetch("/i18n.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = await response.json();
      state.language = preferredLanguage();
      state.translations = catalog?.languages?.[state.language]
        || catalog?.languages?.[catalog?.defaultLanguage]
        || {};
    } catch {
      state.language = "zh";
      state.translations = {};
    }
    document.documentElement.lang = state.language;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const translated = state.translations[element.dataset.i18n];
      if (translated) element.textContent = translated;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const translated = state.translations[element.dataset.i18nAriaLabel];
      if (translated) element.setAttribute("aria-label", translated);
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((element) => {
      const translated = state.translations[element.dataset.i18nAlt];
      if (translated) element.setAttribute("alt", translated);
    });
  }

  function normalizedHttpUrl(value) {
    const normalized = String(value || "").trim();
    return normalized.startsWith("http://") || normalized.startsWith("https://")
      ? normalized
      : "";
  }

  function renderRemoteAccess(candidate) {
    const preferredUrl = normalizedHttpUrl(candidate?.preferred_url);
    const localUrl = normalizedHttpUrl(candidate?.local_url);
    const url = preferredUrl || localUrl;
    if (!url) return;
    if (elements.remoteUrlLink.href !== url) elements.remoteUrlLink.href = url;
    elements.remoteUrlLink.textContent = url;
    elements.remoteUrlHint.textContent = t("remote.defaultHint");
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(url)}`;
    if (elements.remoteQrImage.dataset.qrUrl === qrUrl) return;
    elements.remoteQrImage.dataset.qrUrl = qrUrl;
    elements.remoteQrImage.classList.add("hidden");
    elements.remoteQrPlaceholder.textContent = t("remote.qrLoading");
    elements.remoteQrPlaceholder.classList.remove("hidden");
    elements.remoteQrImage.onload = () => {
      if (elements.remoteQrImage.dataset.qrUrl !== qrUrl) return;
      elements.remoteQrImage.classList.remove("hidden");
      elements.remoteQrPlaceholder.classList.add("hidden");
    };
    elements.remoteQrImage.onerror = () => {
      if (elements.remoteQrImage.dataset.qrUrl !== qrUrl) return;
      elements.remoteQrImage.classList.add("hidden");
      elements.remoteQrPlaceholder.textContent = t("remote.qrImageFailed");
      elements.remoteQrPlaceholder.classList.remove("hidden");
    };
    elements.remoteQrImage.src = qrUrl;
  }

  function setRemoteQrPinned(pinned) {
    state.remoteQrPinned = Boolean(pinned);
    elements.outputControl.classList.toggle("is-qr-pinned", state.remoteQrPinned);
    elements.exit.setAttribute("aria-expanded", String(state.remoteQrPinned));
  }

  function activationUsesTouch(event) {
    const pointerType = state.lastPointerType;
    state.lastPointerType = "";
    if (pointerType) return pointerType === "touch";
    return Boolean(
      event?.detail
      && window.matchMedia?.("(hover: none), (pointer: coarse)")?.matches,
    );
  }

  async function openExternalUrl(url) {
    const normalized = normalizedHttpUrl(url);
    if (!normalized) return;
    try {
      const response = await fetch("/api/app/open-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch {
      window.open(normalized, "_blank", "noopener,noreferrer");
    }
  }

  function setError(message = "") {
    const normalized = String(message || "").trim();
    elements.error.textContent = normalized;
    elements.error.classList.toggle("hidden", !normalized);
  }

  function failClosed(message = "") {
    state.failedClosed = true;
    state.session = null;
    elements.exit.disabled = true;
    elements.unavailable.classList.remove("hidden");
    if (message) setError(message);
  }

  function normalizeSession(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const generation = Number(candidate.generation);
    if (
      !["singleScreen", "localDualScreen"].includes(candidate.mode)
      || !["inactive", "activating", "active", "recovering"].includes(candidate.phase)
      || !Number.isSafeInteger(generation)
      || generation < 0
      || candidate.playbackAuthority !== "host"
      || candidate.mediaRendererOwner !== "host"
    ) {
      return null;
    }
    return {
      mode: candidate.mode,
      phase: candidate.phase,
      generation,
      controllerReady: Boolean(candidate.controllerReady),
    };
  }

  function renderSession() {
    const session = state.session;
    elements.exit.disabled = state.failedClosed
      || !session
      || !["activating", "active"].includes(session.phase);
    if (!state.scene?.videoUrl && elements.status) {
      elements.status.textContent = session?.phase === "active"
        ? t("controller.noSong")
        : t("controller.statusActivating");
    }
  }

  function applySession(candidate) {
    if (state.failedClosed) return null;
    const session = normalizeSession(candidate);
    if (!session) {
      failClosed(t("controller.invalidState"));
      return null;
    }
    if (
      Number.isSafeInteger(expectedGeneration)
      && expectedGeneration > 0
      && session.generation !== expectedGeneration
    ) {
      failClosed(t("controller.staleWindow"));
      return null;
    }
    state.session = session;
    renderSession();
    return session;
  }

  async function ensureOutputReady(session) {
    if (
      session?.phase !== "activating"
      || session.controllerReady
      || state.readyGeneration === session.generation
    ) {
      return session;
    }
    state.readyGeneration = session.generation;
    try {
      return applySession(await invoke("mark_presentation_controller_ready", {
        generation: session.generation,
      }));
    } catch (error) {
      state.readyGeneration = -1;
      throw error;
    }
  }

  function postEnvelope(type, payload = {}) {
    if (!sync) return;
    const envelope = sync.makeEnvelope(type, payload, {
      senderId,
      sequence: ++state.sequence,
      sentAt: Date.now(),
    });
    state.channel?.postMessage(envelope);
    try {
      localStorage.setItem(sync.storageKey, JSON.stringify(envelope));
      localStorage.removeItem(sync.storageKey);
    } catch {
      // BroadcastChannel is primary; storage is only a same-origin fallback.
    }
  }

  function preserveOverlayAndReplace(...nodes) {
    const overlay = elements.frame.querySelector(".player-delay-overlay");
    elements.frame.replaceChildren(...nodes);
    if (overlay) elements.frame.appendChild(overlay);
  }

  function showEmpty(message) {
    if (elements.status) elements.status.textContent = String(message || "");
    preserveOverlayAndReplace(elements.empty);
    state.video = null;
  }

  function renderOverlay() {
    if (!renderer || !state.scene) return;
    renderer.renderScene(elements.frame, state.scene, {
      compact: false,
      manageVisibility: true,
      now: Date.now(),
    });
  }

  function safeSeek(targetTime) {
    const video = state.video;
    if (!video || video.readyState < 1) return;
    const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
    try {
      video.currentTime = Math.max(0, Math.min(Number(targetTime || 0), duration));
    } catch {
      // Metadata readiness events retry the latest clock.
    }
  }

  function applyClock() {
    const video = state.video;
    if (
      !video
      || !state.clock
      || state.clock.itemIdentity !== state.scene?.currentItemIdentity
    ) {
      return;
    }
    const correction = sync.planClockCorrection(state.clock, {
      currentTime: video.currentTime,
      paused: video.paused,
    }, Date.now());
    if (correction.action === "seek") safeSeek(correction.targetTime);
    if (Math.abs(Number(video.playbackRate || 1) - correction.playbackRate) > 0.001) {
      video.playbackRate = correction.playbackRate;
    }
    if (!correction.shouldPlay) {
      if (!video.paused) video.pause();
      return;
    }
    if (video.paused && !video.ended && video.readyState >= 1) {
      video.play().catch(() => {
        setError(t("controller.autoplayBlocked"));
      });
    }
  }

  function mountScene(scene) {
    document.documentElement.dataset.theme = scene.theme;
    document.title = scene.title ? `${scene.title} · Bilikara Stage` : "Bilikara Stage";
    if (!scene.videoUrl) {
      showEmpty(t("controller.noSong"));
      renderOverlay();
      return;
    }
    const video = document.createElement("video");
    video.dataset.presentationOutputVideo = "true";
    video.playsInline = true;
    video.preload = "auto";
    video.autoplay = false;
    video.controls = false;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    video.src = scene.videoUrl;
    video.addEventListener("loadedmetadata", applyClock);
    video.addEventListener("canplay", applyClock);
    video.addEventListener("error", () => setError(t("controller.outputVideoFailed")));
    state.video = video;
    preserveOverlayAndReplace(video);
    renderOverlay();
    applyClock();
  }

  function handleMasterMessage(candidate) {
    if (
      candidate?.type !== "master-state"
      || !sync?.acceptsEnvelope(state.lastMasterEnvelope, candidate)
    ) {
      return;
    }
    state.lastMasterEnvelope = candidate;
    renderRemoteAccess(candidate.payload?.remoteAccess);
    const nextScene = sceneApi?.normalizePresentationScene(candidate.payload?.scene);
    const nextClock = sync.normalizeClock(candidate.payload?.clock);
    if (!nextScene || nextScene.generation !== state.session?.generation) return;
    const shouldMount = !state.scene
      || nextScene.revision !== state.scene.revision
      || nextScene.currentItemIdentity !== state.scene.currentItemIdentity
      || nextScene.videoUrl !== state.scene.videoUrl;
    state.scene = nextScene;
    state.clock = nextClock;
    setError("");
    if (shouldMount) {
      mountScene(nextScene);
    } else {
      renderOverlay();
      applyClock();
    }
  }

  function revealCursor() {
    document.body.classList.remove("is-cursor-hidden");
    if (state.cursorHideTimer) window.clearTimeout(state.cursorHideTimer);
    state.cursorHideTimer = window.setTimeout(() => {
      state.cursorHideTimer = null;
      document.body.classList.add("is-cursor-hidden");
    }, cursorHideDelayMs);
  }

  async function start() {
    await loadTranslations();
    if (
      typeof invoke !== "function"
      || typeof listen !== "function"
      || !sceneApi
      || !renderer
      || !sync
      || !Number.isSafeInteger(expectedGeneration)
      || expectedGeneration < 1
    ) {
      failClosed(t("controller.tauriRequired"));
      return;
    }
    if (typeof BroadcastChannel === "function") {
      state.channel = new BroadcastChannel(sync.channelName);
      state.channel.addEventListener("message", (event) => handleMasterMessage(event.data));
    }
    window.addEventListener("storage", (event) => {
      if (event.key !== sync.storageKey || !event.newValue) return;
      try {
        handleMasterMessage(JSON.parse(event.newValue));
      } catch {
        // Ignore malformed same-origin fallback messages.
      }
    });
    state.unlisteners.push(await listen("bilikara-presentation-state", async (event) => {
      const session = applySession(event?.payload?.session);
      try {
        await ensureOutputReady(session);
      } catch (error) {
        failClosed(error?.message || String(error));
      }
    }));
    const session = applySession(await invoke("get_presentation_session"));
    await ensureOutputReady(session);
    postEnvelope("output-ready", { generation: expectedGeneration });
    window.setInterval(() => {
      applyClock();
      renderOverlay();
    }, 100);
  }

  elements.exit.addEventListener("pointerdown", (event) => {
    state.lastPointerType = String(event.pointerType || "");
  });

  elements.exit.addEventListener("click", async (event) => {
    const generation = state.session?.generation;
    if (!Number.isSafeInteger(generation) || elements.exit.disabled) return;
    if (activationUsesTouch(event) && !state.remoteQrPinned) {
      setRemoteQrPinned(true);
      return;
    }
    setRemoteQrPinned(false);
    elements.exit.disabled = true;
    elements.exit.setAttribute("aria-busy", "true");
    try {
      applySession(await invoke("deactivate_local_presentation", { generation }));
    } catch (error) {
      setError(error?.message || String(error));
      renderSession();
    } finally {
      elements.exit.removeAttribute("aria-busy");
    }
  });

  elements.remoteUrlLink.addEventListener("click", (event) => {
    event.preventDefault();
    openExternalUrl(elements.remoteUrlLink.href);
  });

  document.addEventListener("click", (event) => {
    if (state.remoteQrPinned && !event.target.closest("#controller-output-control")) {
      setRemoteQrPinned(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.remoteQrPinned) {
      setRemoteQrPinned(false);
      elements.exit.focus({ preventScroll: true });
      event.preventDefault();
    }
  });

  ["pointermove", "pointerdown", "keydown"].forEach((eventName) => {
    document.addEventListener(eventName, revealCursor, { passive: true });
  });
  window.addEventListener("pagehide", () => {
    if (state.cursorHideTimer) window.clearTimeout(state.cursorHideTimer);
    state.unlisteners.splice(0).forEach((unlisten) => unlisten?.());
    state.channel?.close();
  });

  revealCursor();
  start().catch((error) => failClosed(error?.message || String(error)));
})();
