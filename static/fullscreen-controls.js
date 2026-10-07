/* Fullscreen layout changes can leave WebView :hover latched at its old location.
   Require a pointer move on the actual control; touch uses explicit tap pinning. */
(() => {
  function bind(control, { enabled = () => true, onEnter = () => {} } = {}) {
    if (!control) return { reset() {} };
    const reset = () => control.classList.remove("is-pointer-hover");
    control.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse" || !enabled()
          || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
        reset();
        return;
      }
      if (!control.classList.contains("is-pointer-hover")) {
        onEnter();
        control.classList.add("is-pointer-hover");
      }
    });
    control.addEventListener("pointerleave", reset);
    control.addEventListener("pointercancel", reset);
    control.addEventListener("pointerdown", event => {
      if (event.pointerType !== "mouse") reset();
    });
    window.addEventListener("blur", reset);
    window.addEventListener("resize", reset);
    return { reset };
  }
  // Single-screen playback starts without UA controls. Fullscreen/resizes may
  // retarget hover or restore focus without physical input, so remember screen
  // coordinates (not window-relative client coordinates) across the transition.
  function bindPlayer(panel, { active, transitioning, revealControls }) {
    const doc = panel.ownerDocument;
    let point = null, movedEvent = null, keyboardIntent = false;
    let cursorTimer = null, focused = true;
    const pointers = new Set();
    const enabled = () => active() && !transitioning();
    const clearTimer = () => {
      if (cursorTimer !== null) window.clearTimeout(cursorTimer);
      cursorTimer = null;
    };
    function revealCursor() {
      clearTimer();
      panel.classList.remove("is-player-cursor-hidden");
      if (!enabled() || !focused || doc.hidden || pointers.size) return;
      const timer = window.setTimeout(() => {
        if (cursorTimer !== timer) return;
        cursorTimer = null;
        if (enabled() && focused && !doc.hidden && !pointers.size) {
          panel.classList.add("is-player-cursor-hidden");
        }
      }, 1800);
      cursorTimer = timer;
    }
    function sync() {
      movedEvent = null;
      keyboardIntent = false;
      pointers.clear();
      revealCursor();
    }
    function rememberPoint(event) {
      const next = { x: event.screenX, y: event.screenY };
      const moved = point
        ? next.x !== point.x || next.y !== point.y
        : Boolean(event.movementX || event.movementY);
      point = next;
      return moved;
    }
    doc.addEventListener("pointermove", event => {
      // UA seekbars can consume pointerdown. Their retargeted move still tells
      // us a button is held, and lostpointercapture releases native scrubbing.
      if (enabled() && event.buttons && panel.contains(event.target)) pointers.add(event.pointerId);
      else if (event.buttons === 0) pointers.delete(event.pointerId);
      const moved = rememberPoint(event);
      movedEvent = enabled() && moved ? event : null;
      if (movedEvent) {
        keyboardIntent = false;
        revealCursor();
      }
    }, { capture: true, passive: true });
    doc.addEventListener("pointerdown", event => {
      rememberPoint(event);
      keyboardIntent = false;
      if (enabled() && panel.contains(event.target)) pointers.add(event.pointerId);
      revealCursor();
    }, { capture: true, passive: true });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      doc.addEventListener(name, event => {
        pointers.delete(event.pointerId);
        revealCursor();
      }, { capture: true, passive: true });
    }
    doc.addEventListener("keydown", event => {
      if (!enabled()) return;
      keyboardIntent = true;
      revealCursor();
      if (event.key !== "Escape" && panel.contains(event.target) && event.target.matches("video")) {
        revealControls(event);
      }
    }, true);
    window.addEventListener("blur", () => { focused = false; sync(); });
    window.addEventListener("focus", () => { focused = true; sync(); });
    window.addEventListener("resize", sync);
    doc.addEventListener("visibilitychange", sync);
    window.addEventListener("pagehide", () => { focused = false; sync(); });
    return {
      sync,
      holdingPointer: () => enabled() && pointers.size > 0,
      allowsReveal(event) {
        if (!enabled() || !event) return false;
        return event.type === "pointerdown" || event.type === "touchstart"
          || (event.type === "pointermove" && event === movedEvent)
          || ((event.type === "focus" || event.type === "keydown") && keyboardIntent);
      },
    };
  }
  window.BilikaraFullscreenControls = { bind, bindPlayer };
})();
