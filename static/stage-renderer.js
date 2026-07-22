(function initStageRenderer(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  globalScope.BilikaraStageRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStageRenderer() {
  "use strict";

  const overlaySelector = ".player-delay-overlay";

  function setText(node, value) {
    if (node) {
      node.textContent = String(value || "");
    }
  }

  function replaceSceneNodes(root, nodes) {
    if (!root) {
      return;
    }
    const overlay = root.querySelector(overlaySelector);
    Array.from(root.childNodes).forEach((node) => {
      if (node !== overlay) {
        node.remove();
      }
    });
    root.prepend(...nodes);
    if (overlay && overlay.parentElement !== root) {
      root.appendChild(overlay);
    }
  }

  function mountMedia(root, scene, options = {}) {
    if (!root) {
      return { video: null, audio: null };
    }
    const videoUrl = String(scene?.videoUrl || "");
    const audioUrl = String(scene?.audioUrl || "");
    const video = document.createElement("video");
    video.dataset.playerRole = "video";
    video.dataset.stageMedia = "video";
    video.playsInline = true;
    video.preload = options.preload || "metadata";
    video.controls = Boolean(options.controls);
    if (video.controls) {
      video.setAttribute("controls", "");
      video.setAttribute("controlsList", "nofullscreen");
    }
    video.autoplay = Boolean(options.autoplay);
    video.muted = Boolean(options.muted);
    if (video.muted) {
      video.defaultMuted = true;
      video.setAttribute("muted", "");
    }
    if (videoUrl) {
      video.src = videoUrl;
    }

    const nodes = [video];
    let audio = null;
    if (options.includeAudio && audioUrl) {
      audio = document.createElement("audio");
      audio.dataset.playerRole = "audio";
      audio.dataset.stageMedia = "audio";
      audio.preload = "auto";
      audio.src = audioUrl;
      nodes.push(audio);
    }
    replaceSceneNodes(root, nodes);
    return { video, audio };
  }

  function renderEmpty(root, message = "") {
    if (!root) {
      return;
    }
    const empty = document.createElement("div");
    empty.className = "empty-state stage-empty-state";
    const text = document.createElement("p");
    text.textContent = String(message || "");
    empty.appendChild(text);
    replaceSceneNodes(root, [empty]);
  }

  function ensureOverlay(root, labels = {}) {
    if (!root) {
      return null;
    }
    let overlay = root.querySelector(overlaySelector);
    if (overlay) {
      return overlay;
    }
    overlay = document.createElement("div");
    overlay.className = "player-delay-overlay hidden";
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="player-delay-card">
        <div class="player-delay-head">
          <p class="player-delay-heading" data-delay-heading></p>
          <div class="player-delay-countdown" data-delay-countdown>
            <svg class="player-delay-count-ring" viewBox="0 0 44 44" aria-hidden="true">
              <circle class="player-delay-count-track" cx="22" cy="22" r="19"></circle>
              <circle class="player-delay-count-progress" cx="22" cy="22" r="19"></circle>
            </svg>
            <span class="player-delay-count-text"><span data-delay-count>0</span>s</span>
          </div>
        </div>
        <div class="player-delay-now-row">
          <span class="player-delay-play-icon" aria-hidden="true">▶</span>
          <p class="player-delay-song-title" data-delay-next-title></p>
          <p class="player-delay-requester" data-delay-next-requester></p>
          <p class="player-delay-duration" data-delay-next-duration></p>
        </div>
        <p class="player-delay-section-title" data-delay-queue-heading></p>
        <div class="player-delay-list" data-delay-list></div>
        <p class="player-delay-total" data-delay-total></p>
      </div>
    `;
    const countdown = overlay.querySelector("[data-delay-countdown]");
    if (countdown) {
      countdown.setAttribute("aria-label", String(labels.countdownLabel || ""));
    }
    root.appendChild(overlay);
    return overlay;
  }

  function createQueueRow(row, index) {
    const item = document.createElement("div");
    item.className = "player-delay-list-row";

    const indexNode = document.createElement("span");
    indexNode.className = "player-delay-list-index";
    indexNode.textContent = String(index);
    const title = document.createElement("p");
    title.className = "player-delay-song-title";
    title.textContent = String(row?.title || "");
    const requester = document.createElement("p");
    requester.className = "player-delay-requester";
    requester.textContent = String(row?.requester || "");
    const duration = document.createElement("p");
    duration.className = "player-delay-duration";
    duration.textContent = String(row?.duration || "");
    item.append(indexNode, title, requester, duration);
    return item;
  }

  function renderOverlay(overlay, model, options = {}) {
    if (!overlay) {
      return;
    }
    const visible = Boolean(model?.visible);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const deadline = Math.max(0, Number(model?.deadline || 0));
    const durationMs = Math.max(1000, Number(model?.durationMs || 0));
    const remainingMs = visible ? Math.max(0, deadline - now) : 0;
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const progress = Math.max(0, Math.min(1, remainingMs / durationMs));

    setText(overlay.querySelector("[data-delay-heading]"), model?.heading);
    setText(overlay.querySelector("[data-delay-count]"), remainingSeconds);
    setText(overlay.querySelector("[data-delay-next-title]"), model?.title);
    setText(overlay.querySelector("[data-delay-next-requester]"), model?.requester);
    setText(overlay.querySelector("[data-delay-next-duration]"), model?.duration);
    setText(overlay.querySelector("[data-delay-queue-heading]"), model?.queueHeading);
    setText(overlay.querySelector("[data-delay-total]"), model?.totalText);
    overlay.style.setProperty("--delay-ring-offset", String(119.38 * (1 - progress)));
    overlay.classList.toggle("is-compact", Boolean(options.compact));

    const countdown = overlay.querySelector("[data-delay-countdown]");
    if (countdown) {
      countdown.setAttribute("aria-label", String(model?.countdownLabel || ""));
    }
    const list = overlay.querySelector("[data-delay-list]");
    if (list) {
      const rows = Array.isArray(model?.rows) ? model.rows.slice(0, 5) : [];
      const nodes = rows.map((row, index) => createQueueRow(row, index + 1));
      if (!nodes.length && model?.emptyText) {
        const empty = document.createElement("div");
        empty.className = "player-delay-list-more";
        empty.textContent = String(model.emptyText);
        nodes.push(empty);
      }
      if (model?.remainingText) {
        const remaining = document.createElement("div");
        remaining.className = "player-delay-list-more";
        remaining.textContent = String(model.remainingText);
        nodes.push(remaining);
      }
      list.replaceChildren(...nodes);
    }

    if (options.manageVisibility !== false) {
      overlay.classList.toggle("hidden", !visible);
      overlay.classList.toggle("is-visible", visible);
      overlay.classList.remove("is-entering", "is-leaving");
      overlay.setAttribute("aria-hidden", String(!visible));
    }
  }

  return {
    mountMedia,
    renderEmpty,
    ensureOverlay,
    renderOverlay,
  };
});
