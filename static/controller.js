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
    translationCatalog: {},
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
    remoteAccessCard: document.querySelector("#controller-remote-popover .remote-access-card"),
    remoteQrImage: document.getElementById("controller-remote-qr-image"),
    remoteQrPlaceholder: document.getElementById("controller-remote-qr-placeholder"),
    remoteUrlLink: document.getElementById("controller-remote-url-link"),
    remoteUrlHint: document.getElementById("controller-remote-url-hint"),
    internetRemoteMeta: document.getElementById("controller-internet-remote-meta"),
    internetRemoteConnectionCount: document.getElementById("controller-internet-remote-connection-count"),
    internetRemoteRoom: document.getElementById("controller-internet-remote-room"),
    internetRemoteQrImage: document.getElementById("controller-internet-remote-qr-image"),
    internetRemoteQrPlaceholder: document.getElementById("controller-internet-remote-qr-placeholder"),
    internetRemotePassword: document.getElementById("controller-internet-remote-password"),
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

  function applyLanguage(language) {
    const nextLanguage = ["zh", "en", "ja"].includes(language) ? language : "zh";
    state.language = nextLanguage;
    state.translations = state.translationCatalog[nextLanguage]
      || state.translationCatalog.zh
      || {};
    document.documentElement.lang = nextLanguage === "zh" ? "zh-CN" : nextLanguage;
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
    syncExitExpandedWidth();
  }

  function syncExitExpandedWidth() {
    const button = elements.exit;
    const label = button?.querySelector(".presentation-output-exit-label");
    const exitIcon = button?.querySelector(".presentation-output-exit-icon");
    if (!button || !label || !exitIcon) return;
    const buttonStyle = getComputedStyle(button);
    const iconStyle = getComputedStyle(exitIcon);
    const controlStyle = getComputedStyle(elements.outputControl);
    const number = (value) => Number.parseFloat(value) || 0;
    const labelWidth = Math.max(label.scrollWidth, label.getBoundingClientRect().width);
    const expandedWidth = Math.ceil(
      number(buttonStyle.paddingLeft)
        + number(buttonStyle.paddingRight)
        + number(buttonStyle.borderLeftWidth)
        + number(buttonStyle.borderRightWidth)
        + number(iconStyle.width)
        + number(controlStyle.getPropertyValue("--presentation-action-label-gap"))
        + labelWidth,
    );
    elements.outputControl.style.setProperty(
      "--presentation-action-expanded-width",
      `${Math.max(112, expandedWidth)}px`,
    );
    elements.outputControl.style.setProperty(
      "--presentation-action-label-width",
      `${Math.ceil(labelWidth)}px`,
    );
  }

  async function loadTranslations() {
    try {
      const response = await fetch("/i18n.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = await response.json();
      state.translationCatalog = catalog?.languages || {};
    } catch {
      state.translationCatalog = {};
    }
    applyLanguage(preferredLanguage());
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
    elements.remoteUrlHint.textContent = t("internetRemote.localSameNetwork");
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

  function renderInternetRemote(candidate) {
    const active = Boolean(candidate?.active);
    elements.remoteAccessCard.classList.toggle("is-local-only-preview", !active);
    const connectedCount = active
      ? Math.max(0, Math.trunc(Number(candidate?.connected_count) || 0))
      : 0;
    elements.internetRemoteMeta.textContent = active
      ? t("internetRemote.createdStatus").replace("{count}", String(connectedCount))
      : t("internetRemote.notCreated");
    elements.internetRemoteMeta.classList.toggle("is-active", active);
    elements.internetRemoteConnectionCount.textContent = String(connectedCount);
    elements.internetRemoteRoom.classList.toggle("hidden", !active);
    elements.internetRemotePassword.textContent = active
      ? String(candidate?.password || "").slice(0, 32)
      : "";
    const qrImage = active && String(candidate?.qr_image || "").startsWith("data:image/png;base64,")
      ? String(candidate.qr_image)
      : "";
    if (elements.internetRemoteQrImage.__bilikaraQrImage === qrImage) return;
    elements.internetRemoteQrImage.__bilikaraQrImage = qrImage;
    elements.internetRemoteQrImage.classList.add("hidden");
    if (!qrImage) {
      elements.internetRemoteQrImage.removeAttribute("src");
      elements.internetRemoteQrPlaceholder.textContent = active
        ? t("remote.qrImageFailed")
        : t("internetRemote.notCreated");
      elements.internetRemoteQrPlaceholder.classList.toggle("hidden", !active);
      return;
    }
    elements.internetRemoteQrPlaceholder.textContent = t("remote.qrLoading");
    elements.internetRemoteQrPlaceholder.classList.remove("hidden");
    elements.internetRemoteQrImage.onload = () => {
      if (elements.internetRemoteQrImage.__bilikaraQrImage !== qrImage) return;
      elements.internetRemoteQrImage.classList.remove("hidden");
      elements.internetRemoteQrPlaceholder.classList.add("hidden");
    };
    elements.internetRemoteQrImage.onerror = () => {
      if (elements.internetRemoteQrImage.__bilikaraQrImage !== qrImage) return;
      elements.internetRemoteQrImage.classList.add("hidden");
      elements.internetRemoteQrPlaceholder.textContent = t("remote.qrImageFailed");
      elements.internetRemoteQrPlaceholder.classList.remove("hidden");
    };
    elements.internetRemoteQrImage.src = qrImage;
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

  function setError(message = "", key = "") {
    if (key) elements.error.dataset.i18n = key;
    else delete elements.error.dataset.i18n;
    const normalized = message === key ? "" : String(message || "").trim();
    elements.error.textContent = normalized;
    elements.error.classList.toggle("hidden", !normalized);
    if (state.failedClosed) {
      // The generic status is already shown in the empty stage; avoid overlapping alerts.
      elements.unavailable.classList.toggle("hidden", Boolean(normalized));
    }
  }

  function failClosed(message = "", key = "") {
    state.failedClosed = true;
    state.session = null;
    elements.exit.disabled = true;
    elements.unavailable.classList.remove("hidden");
    if (elements.status) {
      elements.status.dataset.i18n = "controller.unavailable";
      elements.status.textContent = elements.unavailable.textContent;
    }
    if (message) setError(message, key);
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
      elements.status.dataset.i18n = session?.phase === "active"
        ? "controller.noSong"
        : "controller.statusActivating";
      elements.status.textContent = t(elements.status.dataset.i18n);
    }
  }

  function applySession(candidate) {
    if (state.failedClosed) return null;
    const session = normalizeSession(candidate);
    if (!session) {
      failClosed(t("controller.invalidState"), "controller.invalidState");
      return null;
    }
    if (
      Number.isSafeInteger(expectedGeneration)
      && expectedGeneration > 0
      && session.generation !== expectedGeneration
    ) {
      failClosed(t("controller.staleWindow"), "controller.staleWindow");
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

  function showEmpty(key) {
    if (elements.status) {
      elements.status.dataset.i18n = key;
      elements.status.textContent = t(key);
    }
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
        setError(t("controller.autoplayBlocked"), "controller.autoplayBlocked");
      });
    }
  }

  function mountScene(scene) {
    document.documentElement.dataset.theme = scene.theme;
    document.title = scene.title ? `${scene.title} · Bilikara Stage` : "Bilikara Stage";
    if (!scene.videoUrl) {
      showEmpty("controller.noSong");
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
    video.addEventListener("error", () => setError(t("controller.outputVideoFailed"), "controller.outputVideoFailed"));
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
    applyLanguage(candidate.payload?.language);
    renderRemoteAccess(candidate.payload?.remoteAccess);
    renderInternetRemote(candidate.payload?.internetRemote);
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
      failClosed(t("controller.tauriRequired"), "controller.tauriRequired");
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
