(function initPresentationRenderer(globalScope, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  globalScope.BilikaraPresentationRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPresentationRenderer() {
  "use strict";

  const overlaySelector = ".player-delay-overlay";
  const svgNamespace = "http://www.w3.org/2000/svg";

  function createElement(tagName, className = "") {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    return node;
  }

  function createDataElement(tagName, className, dataName) {
    const node = createElement(tagName, className);
    node.setAttribute(`data-${dataName}`, "");
    return node;
  }

  function createCircle(className) {
    const circle = document.createElementNS(svgNamespace, "circle");
    circle.setAttribute("class", className);
    circle.setAttribute("cx", "22");
    circle.setAttribute("cy", "22");
    circle.setAttribute("r", "19");
    return circle;
  }

  function setText(node, value) {
    if (node) {
      node.textContent = String(value ?? "");
    }
  }

  function ensureOverlay(root) {
    if (!root) {
      return null;
    }
    const existing = root.querySelector(overlaySelector);
    if (existing) {
      return existing;
    }

    const overlay = createElement("div", "player-delay-overlay hidden");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("aria-hidden", "true");
    overlay.dataset.presentationOverlay = "true";

    const card = createElement("div", "player-delay-card");
    const head = createElement("div", "player-delay-head");
    const heading = createDataElement("p", "player-delay-heading", "delay-heading");
    const countdown = createDataElement("div", "player-delay-countdown", "delay-countdown");
    const ring = document.createElementNS(svgNamespace, "svg");
    ring.setAttribute("class", "player-delay-count-ring");
    ring.setAttribute("viewBox", "0 0 44 44");
    ring.setAttribute("aria-hidden", "true");
    ring.append(createCircle("player-delay-count-track"), createCircle("player-delay-count-progress"));
    const countText = createElement("span", "player-delay-count-text");
    const count = createDataElement("span", "", "delay-count");
    count.textContent = "0";
    countText.append(count, document.createTextNode("s"));
    countdown.append(ring, countText);
    head.append(heading, countdown);

    const nowRow = createElement("div", "player-delay-now-row");
    const playIcon = createElement("span", "player-delay-play-icon");
    playIcon.setAttribute("aria-hidden", "true");
    playIcon.textContent = "▶";
    nowRow.append(
      playIcon,
      createDataElement("p", "player-delay-song-title", "delay-next-title"),
      createDataElement("p", "player-delay-requester", "delay-next-requester"),
      createDataElement("p", "player-delay-duration", "delay-next-duration"),
    );

    const queueHeading = createDataElement(
      "p",
      "player-delay-section-title",
      "delay-queue-heading",
    );
    const list = createDataElement("div", "player-delay-list", "delay-list");
    const total = createDataElement("p", "player-delay-total", "delay-total");
    card.append(head, nowRow, queueHeading, list, total);
    overlay.appendChild(card);
    root.appendChild(overlay);
    return overlay;
  }

  function createQueueRow(row, index) {
    const item = createElement("div", "player-delay-list-row");
    const indexNode = createElement("span", "player-delay-list-index");
    indexNode.textContent = String(index);
    const title = createElement("p", "player-delay-song-title");
    title.textContent = String(row?.title ?? "");
    const requester = createElement("p", "player-delay-requester");
    requester.textContent = String(row?.requester ?? "");
    const duration = createElement("p", "player-delay-duration");
    duration.textContent = String(row?.duration ?? "");
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
      countdown.setAttribute("aria-label", String(model?.countdownLabel ?? ""));
    }
    const list = overlay.querySelector("[data-delay-list]");
    if (list) {
      const rows = Array.isArray(model?.rows) ? model.rows.slice(0, 5) : [];
      const rowsSignature = JSON.stringify({
        rows,
        emptyText: String(model?.emptyText || ""),
        remainingText: String(model?.remainingText || ""),
      });
      if (list.dataset.presentationRows !== rowsSignature) {
        const nodes = rows.map((row, index) => createQueueRow(row, index + 1));
        if (!nodes.length && model?.emptyText) {
          const empty = createElement("div", "player-delay-list-more");
          empty.textContent = String(model.emptyText);
          nodes.push(empty);
        }
        if (model?.remainingText) {
          const remaining = createElement("div", "player-delay-list-more");
          remaining.textContent = String(model.remainingText);
          nodes.push(remaining);
        }
        list.replaceChildren(...nodes);
        list.dataset.presentationRows = rowsSignature;
      }
    }

    if (options.manageVisibility !== false) {
      overlay.classList.toggle("hidden", !visible);
      overlay.classList.toggle("is-visible", visible);
      overlay.classList.remove("is-entering", "is-leaving");
      overlay.setAttribute("aria-hidden", String(!visible));
    }
  }

  function renderScene(root, scene, options = {}) {
    if (!root || !scene) {
      return null;
    }
    root.dataset.presentationGeneration = String(scene.generation || 0);
    root.dataset.presentationRevision = String(scene.revision || 0);
    root.dataset.presentationItemIdentity = String(scene.currentItemIdentity || "");
    root.dataset.presentationTitle = String(scene.title || "");
    const overlay = ensureOverlay(root);
    renderOverlay(overlay, scene.overlay || { visible: false }, options);
    return overlay;
  }

  return {
    ensureOverlay,
    renderOverlay,
    renderScene,
  };
});
