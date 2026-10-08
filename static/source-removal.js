/* Shared local-library editing. Platform differences are input gestures only. */
(function (root) {
  "use strict";
  const trash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg>';
  function create(grid, { source, translate: t, remove, reportError }) {
    if (!grid) return null;
    const toolbar = document.createElement("div");
    toolbar.className = "source-removal-toolbar";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "source-removal-toggle";
    toggle.setAttribute("aria-controls", grid.id);
    toolbar.append(toggle);
    grid.before(toolbar);
    let editing = false;
    let press = null;
    let suppressClick = null;
    const pending = new Set();

    function cancelPress() {
      if (press) root.clearTimeout(press.timer);
      press = null;
    }
    function paint() {
      toggle.innerHTML = editing ? "" : trash;
      if (editing) toggle.textContent = t("sources.doneRemoving");
      toggle.title = t(editing ? "sources.doneRemoving" : "sources.removeMode");
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-pressed", String(editing));
      for (const card of grid.querySelectorAll(".source-removal-card")) {
        const button = card.querySelector(".source-removal-delete");
        if (!button) continue;
        card.classList.toggle("is-editing", editing);
        button.hidden = !editing;
        button.disabled = pending.size > 0;
        const busy = pending.has(card.dataset.sourceId);
        button.toggleAttribute("aria-busy", busy);
        if (busy) button.setAttribute("aria-busy", "true");
        button.title = t(busy ? "sources.removing" : "sources.removeLocal", { name: card.dataset.sourceTitle });
        button.setAttribute("aria-label", button.title);
      }
    }
    function setEditing(value) {
      cancelPress();
      editing = value;
      paint();
    }
    toggle.addEventListener("click", () => setEditing(!editing));
    grid.addEventListener("keydown", event => {
      if (event.key === "Escape" && editing) {
        event.preventDefault();
        setEditing(false);
        toggle.focus({ preventScroll: true });
      }
    });
    grid.addEventListener("pointerdown", event => {
      cancelPress();
      suppressClick = null;
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      if (event.isPrimary === false || event.target.closest(".source-removal-delete")) return;
      const card = event.target.closest(".source-removal-card");
      if (!card || !card.querySelector(".source-removal-delete")) return;
      const current = { card, id: event.pointerId, x: event.clientX, y: event.clientY };
      current.timer = root.setTimeout(() => {
        if (press !== current || !card.isConnected || !card.getClientRects().length) return;
        suppressClick = card;
        setEditing(true);
      }, 550);
      press = current;
    }, { passive: true });
    document.addEventListener("pointermove", event => {
      if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancelPress();
    }, { passive: true });
    document.addEventListener("pointerup", cancelPress, { passive: true });
    document.addEventListener("pointercancel", cancelPress, { passive: true });
    document.addEventListener("scroll", cancelPress, { capture: true, passive: true });
    root.addEventListener("blur", cancelPress);
    document.addEventListener("visibilitychange", cancelPress);
    grid.addEventListener("contextmenu", event => {
      // Suppress Android's text/image context menu, but retain native scrolling.
      if (event.target.closest(".source-removal-card")) event.preventDefault();
    });
    grid.addEventListener("click", event => {
      const card = event.target.closest(".source-removal-card");
      if (card && (card === suppressClick || (editing && !event.target.closest(".source-removal-delete")))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      suppressClick = null;
    }, true);

    return {
      sync: paint,
      card(button, { id, title, placeholder = false }) {
        if (placeholder) return button;
        const card = document.createElement("div");
        card.className = "source-removal-card";
        card.dataset.sourceId = String(id);
        card.dataset.sourceTitle = title;
        if (grid.getAttribute("role") === "list") card.setAttribute("role", "listitem");
        const action = document.createElement("button");
        action.type = "button";
        action.className = "source-removal-delete";
        action.innerHTML = trash;
        action.hidden = !editing;
        action.disabled = pending.size > 0;
        const busy = pending.has(String(id));
        if (busy) action.setAttribute("aria-busy", "true");
        action.title = t(busy ? "sources.removing" : "sources.removeLocal", { name: title });
        action.setAttribute("aria-label", action.title);
        card.classList.toggle("is-editing", editing);
        card.append(button, action);
        action.addEventListener("click", async event => {
          event.preventDefault();
          event.stopPropagation();
          if (!editing || pending.size || action.disabled) return;
          pending.add(String(id));
          paint();
          try { await remove({ source, id: String(id) }); }
          catch (error) { reportError(error?.message || String(error)); }
          finally {
            pending.delete(String(id));
            paint();
            if (!action.isConnected) toggle.focus({ preventScroll: true });
          }
        });
        return card;
      },
    };
  }
  root.BilikaraSourceRemoval = Object.freeze({ create });
})(window);
