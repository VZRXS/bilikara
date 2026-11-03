/* Transient presentation feedback; application state remains snapshot-owned. */
(function (root) {
  "use strict";
  function newestAddition(previous, next) {
    if (!previous || !next) return null;
    if (previous.session_generation !== next.session_generation
      || previous.session_flags?.startup_choice_pending || next.session_flags?.startup_choice_pending) return null;
    const known = new Set([previous.current_item, ...(Array.isArray(previous.playlist) ? previous.playlist : [])]
      .map(item => String(item?.id || "")).filter(Boolean));
    const added = [...(Array.isArray(next.playlist) ? next.playlist : []), next.current_item]
      .filter(item => item?.id && !known.has(String(item.id)));
    return added.at(-1) || null;
  }

  function create(element, translate) {
    let timer = null;
    let exitTimer = null;
    let lastKey = "";
    let active = false;
    function hide() {
      active = false;
      clearTimeout(timer);
      timer = null;
      if (!element) return;
      element.classList.remove("is-visible");
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => element.classList.add("hidden"), 500);
    }
    function show(notice) {
      if (!element || !notice || typeof notice.title !== "string") return false;
      const remaining = Math.min(4200, Number(notice.expiresAt) - Date.now());
      if (!Number.isFinite(remaining) || remaining <= 0 || !notice.key) return false;
      if (notice.key === lastKey) {
        const label = element.querySelector(".fullscreen-request-toast-label");
        if (label) label.textContent = translate("toast.incomingRequest");
        return false;
      }
      lastKey = notice.key;
      active = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      const label = document.createElement("span");
      label.className = "fullscreen-request-toast-label";
      label.textContent = translate("toast.incomingRequest");
      const title = document.createElement("span");
      title.className = "fullscreen-request-toast-title";
      title.textContent = notice.title;
      element.replaceChildren(label, title);
      element.classList.remove("hidden");
      requestAnimationFrame(() => {
        if (active && lastKey === notice.key) element.classList.add("is-visible");
      });
      timer = setTimeout(hide, remaining);
      return true;
    }
    return { show, hide };
  }
  root.BilikaraIncomingRequest = { newestAddition, create };
})(globalThis);
