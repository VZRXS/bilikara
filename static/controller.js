(function initializeController() {
  "use strict";

  const invoke = window.__TAURI__?.core?.invoke || null;
  const listen = window.__TAURI__?.event?.listen || null;
  const expectedGeneration = Number(
    new URLSearchParams(window.location.search).get("presentationGeneration"),
  );

  const state = {
    session: null,
    playback: null,
    lastPlaybackSequence: 0,
    lastSubmittedCommandSequence: 0,
    readyGeneration: -1,
    commandBusy: false,
    failedClosed: false,
    listenersReady: false,
    unlisteners: [],
    language: "zh",
    translations: {},
    sessionRefreshPromise: null,
  };

  const elements = {
    shell: document.getElementById("controller-shell"),
    status: document.getElementById("controller-status"),
    title: document.getElementById("controller-title"),
    time: document.getElementById("controller-time"),
    seek: document.getElementById("controller-seek"),
    play: document.getElementById("controller-play-toggle"),
    back: document.getElementById("controller-back-10"),
    forward: document.getElementById("controller-forward-10"),
    next: document.getElementById("controller-next"),
    volume: document.getElementById("controller-volume"),
    volumeValue: document.getElementById("controller-volume-value"),
    mute: document.getElementById("controller-mute"),
    exit: document.getElementById("controller-exit"),
    error: document.getElementById("controller-error"),
    unavailable: document.getElementById("controller-unavailable"),
    commandControls: Array.from(document.querySelectorAll("[data-command-control]")),
  };

  function t(key, params = {}) {
    const template = String(state.translations[key] || key);
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
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
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
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
      if (translated) {
        element.textContent = translated;
      }
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      const translated = state.translations[element.dataset.i18nAriaLabel];
      if (translated) {
        element.setAttribute("aria-label", translated);
      }
    });
    const title = state.translations["document.controllerTitle"];
    if (title) {
      document.title = title;
    }
  }

  function setError(message = "") {
    const normalized = String(message || "").trim();
    elements.error.textContent = normalized;
    elements.error.classList.toggle("hidden", !normalized);
  }

  function failClosed(message = "") {
    if (message) {
      setError(message);
    }
    elements.unavailable.classList.remove("hidden");
    state.session = null;
    state.playback = null;
    state.commandBusy = false;
    state.failedClosed = true;
    render();
  }

  function normalizeSession(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const generation = Number(candidate.generation);
    const accepted = Number(candidate.lastAcceptedCommandSequence || 0);
    const applied = Number(candidate.lastAppliedCommandSequence || 0);
    if (
      !["singleScreen", "localDualScreen"].includes(candidate.mode)
      || !["inactive", "activating", "active", "recovering"].includes(candidate.phase)
      || !Number.isSafeInteger(generation)
      || generation < 0
      || !Number.isSafeInteger(accepted)
      || accepted < 0
      || !Number.isSafeInteger(applied)
      || applied < 0
      || applied > accepted
      || candidate.playbackAuthority !== "host"
      || candidate.mediaRendererOwner !== "host"
    ) {
      return null;
    }
    return {
      mode: candidate.mode,
      phase: candidate.phase,
      generation,
      hostReady: Boolean(candidate.hostReady),
      controllerReady: Boolean(candidate.controllerReady),
      lastAcceptedCommandSequence: accepted,
      lastAppliedCommandSequence: applied,
    };
  }

  function normalizePlaybackEvent(candidate) {
    if (!candidate || typeof candidate !== "object" || !candidate.state) return null;
    const generation = Number(candidate.generation);
    const sequence = Number(candidate.sequence);
    const revision = Number(candidate.state.revision);
    const currentTimeSeconds = Number(candidate.state.currentTimeSeconds);
    const durationValue = candidate.state.durationSeconds;
    const durationSeconds = durationValue == null ? null : Number(durationValue);
    const volumePercent = Number(candidate.state.volumePercent);
    if (
      !Number.isSafeInteger(generation)
      || !Number.isSafeInteger(sequence)
      || sequence < 1
      || !Number.isSafeInteger(revision)
      || revision < 1
      || !Number.isFinite(currentTimeSeconds)
      || currentTimeSeconds < 0
      || (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0))
      || !Number.isInteger(volumePercent)
      || volumePercent < 0
      || volumePercent > 100
      || typeof candidate.state.muted !== "boolean"
    ) {
      return null;
    }
    return {
      generation,
      sequence,
      revision,
      itemIdentity: candidate.state.itemIdentity == null
        ? null
        : String(candidate.state.itemIdentity),
      title: String(candidate.state.title || ""),
      paused: Boolean(candidate.state.paused),
      currentTimeSeconds,
      durationSeconds,
      volumePercent,
      muted: candidate.state.muted,
      canSkip: Boolean(candidate.state.canSkip),
    };
  }

  function formatTime(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(value / 60);
    const remainder = Math.floor(value % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function controlsAvailable() {
    return !state.failedClosed
      && state.session?.phase === "active"
      && state.session?.mode === "localDualScreen"
      && state.playback?.generation === state.session.generation
      && !state.commandBusy;
  }

  function render() {
    const session = state.session;
    const playback = state.playback;
    const available = controlsAvailable();
    const duration = playback?.durationSeconds ?? 0;
    const hasPlayableMedia = available
      && playback?.itemIdentity != null
      && Number.isFinite(duration)
      && duration > 0;
    const statusKey = session?.phase === "active"
      ? "controller.statusActive"
      : session?.phase === "activating"
        ? "controller.statusActivating"
        : session?.phase === "recovering"
          ? "controller.statusRecovering"
          : "controller.statusUnavailable";
    elements.status.textContent = t(statusKey);
    elements.title.textContent = playback?.title || t("controller.noSong");
    elements.play.querySelector("span").textContent = playback?.paused !== false
      ? t("controller.play")
      : t("controller.pause");
    elements.mute.querySelector("span").textContent = playback?.muted
      ? t("controller.unmute")
      : t("controller.mute");

    const current = Math.min(playback?.currentTimeSeconds ?? 0, duration || Infinity);
    if (document.activeElement !== elements.seek) {
      elements.seek.max = String(duration);
      elements.seek.value = String(Number.isFinite(current) ? current : 0);
    }
    elements.time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    if (document.activeElement !== elements.volume) {
      elements.volume.value = String(playback?.volumePercent ?? 100);
    }
    elements.volumeValue.textContent = `${elements.volume.value}%`;

    elements.commandControls.forEach((control) => {
      control.disabled = !available;
    });
    elements.play.disabled = !hasPlayableMedia;
    elements.back.disabled = !hasPlayableMedia;
    elements.forward.disabled = !hasPlayableMedia;
    elements.next.disabled = !available || !playback?.canSkip;
    elements.seek.disabled = !hasPlayableMedia;
    elements.exit.disabled = state.commandBusy
      || !session
      || !["activating", "active"].includes(session.phase);
  }

  function applySession(candidate) {
    if (state.failedClosed) {
      return null;
    }
    const session = normalizeSession(candidate);
    if (!session) {
      failClosed(t("controller.invalidState"));
      return null;
    }
    if (state.session && session.generation < state.session.generation) {
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
    if (!state.session || session.generation !== state.session.generation) {
      state.playback = null;
      state.lastPlaybackSequence = 0;
      state.lastSubmittedCommandSequence = session.lastAcceptedCommandSequence;
    }
    state.session = session;
    state.lastSubmittedCommandSequence = Math.max(
      state.lastSubmittedCommandSequence,
      session.lastAcceptedCommandSequence,
    );
    render();
    return session;
  }

  async function ensureControllerReady(session) {
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

  async function refreshSession() {
    if (state.sessionRefreshPromise) {
      return state.sessionRefreshPromise;
    }
    const pending = (async () => {
      const session = applySession(await invoke("get_presentation_session"));
      await ensureControllerReady(session);
      return state.session;
    })();
    const tracked = pending.finally(() => {
      if (state.sessionRefreshPromise === tracked) {
        state.sessionRefreshPromise = null;
      }
    });
    state.sessionRefreshPromise = tracked;
    return tracked;
  }

  function applyPlaybackEvent(candidate) {
    const playback = normalizePlaybackEvent(candidate);
    if (
      !playback
      || !state.session
      || playback.generation !== state.session.generation
      || playback.sequence <= state.lastPlaybackSequence
    ) {
      return;
    }
    state.lastPlaybackSequence = playback.sequence;
    state.playback = playback;
    render();
  }

  async function withBusy(element, action) {
    if (state.commandBusy) return;
    state.commandBusy = true;
    element.disabled = true;
    element.setAttribute("aria-busy", "true");
    setError();
    render();
    try {
      await action();
    } catch (error) {
      setError(error?.message || String(error));
    } finally {
      state.commandBusy = false;
      element.removeAttribute("aria-busy");
      render();
    }
  }

  async function sendCommand(element, command) {
    if (!controlsAvailable()) return;
    await withBusy(element, async () => {
      const generation = state.session.generation;
      const sequence = Math.max(
        state.session.lastAcceptedCommandSequence,
        state.lastSubmittedCommandSequence,
      ) + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw new Error(t("controller.commandFailed"));
      }
      const accepted = await invoke("send_presentation_command", {
        request: { generation, sequence, command },
      });
      if (
        Number(accepted?.generation) !== generation
        || Number(accepted?.sequence) !== sequence
      ) {
        throw new Error(t("controller.invalidAcknowledgement"));
      }
      state.lastSubmittedCommandSequence = sequence;
      await refreshSession();
    });
  }

  function installControls() {
    elements.play.addEventListener("click", () => {
      sendCommand(elements.play, { type: state.playback?.paused ? "play" : "pause" });
    });
    elements.back.addEventListener("click", () => {
      sendCommand(elements.back, { type: "seekRelative", deltaSeconds: -10 });
    });
    elements.forward.addEventListener("click", () => {
      sendCommand(elements.forward, { type: "seekRelative", deltaSeconds: 10 });
    });
    elements.next.addEventListener("click", () => {
      sendCommand(elements.next, { type: "nextTrack" });
    });
    elements.seek.addEventListener("input", () => {
      elements.time.textContent = `${formatTime(elements.seek.value)} / ${formatTime(elements.seek.max)}`;
    });
    elements.seek.addEventListener("change", () => {
      sendCommand(elements.seek, {
        type: "seekAbsolute",
        targetSeconds: Number(elements.seek.value),
      });
    });
    elements.volume.addEventListener("input", () => {
      elements.volumeValue.textContent = `${elements.volume.value}%`;
    });
    elements.volume.addEventListener("change", () => {
      sendCommand(elements.volume, {
        type: "setVolume",
        volumePercent: Number(elements.volume.value),
        muted: Boolean(state.playback?.muted),
      });
    });
    elements.mute.addEventListener("click", () => {
      sendCommand(elements.mute, {
        type: "setVolume",
        volumePercent: Number(state.playback?.volumePercent ?? elements.volume.value),
        muted: !state.playback?.muted,
      });
    });
    elements.exit.addEventListener("click", () => {
      if (!state.session) return;
      withBusy(elements.exit, async () => {
        applySession(await invoke("deactivate_local_presentation", {
          generation: state.session.generation,
        }));
      });
    });
  }

  function teardown() {
    state.listenersReady = false;
    state.unlisteners.splice(0).forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        // The WebView may already have released the native listener.
      }
    });
  }

  async function start() {
    loadTranslations().then(() => render());
    installControls();
    render();
    if (typeof invoke !== "function" || typeof listen !== "function") {
      failClosed(t("controller.tauriRequired"));
      return;
    }
    try {
      const unlistenState = await listen("bilikara-presentation-state", (event) => {
        const session = applySession(event?.payload?.session);
        if (!state.listenersReady) {
          return;
        }
        ensureControllerReady(session).catch((error) => {
          failClosed(error?.message || String(error));
        });
      });
      const unlistenPlayback = await listen(
        "bilikara-presentation-playback-state",
        (event) => applyPlaybackEvent(event?.payload),
      );
      state.unlisteners.push(unlistenState, unlistenPlayback);
      state.listenersReady = true;
      await refreshSession();
    } catch (error) {
      teardown();
      failClosed(error?.message || String(error));
    }
  }

  window.addEventListener("pagehide", teardown);
  start();
})();
