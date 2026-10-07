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
  // retarget hover or restore focus without physical input. Native fullscreen
  // also changes the window origin, so a stationary cursor can be re-reported
  // with shifted screen coordinates and movement. After each transition, only
  // re-anchor until the layout settles; then require a few pixels of travel.
  const SETTLE_MS = 600, MOVE_THRESHOLD_PX = 4;
  function bindPlayer(panel, { active, transitioning, revealControls }) {
    const doc = panel.ownerDocument;
    let point = null, movedEvent = null, keyboardIntent = false;
    let cursorTimer = null, focused = true, settleTimer = null;
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
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      const timer = window.setTimeout(() => {
        if (settleTimer === timer) settleTimer = null;
      }, SETTLE_MS);
      settleTimer = timer;
      revealCursor();
    }
    function rememberPoint(event) {
      const next = { x: event.screenX, y: event.screenY };
      if (!point || settleTimer !== null) {
        point = next;
        return false;
      }
      // Accumulate from the anchor so slow deliberate motion still counts,
      // while sub-threshold DPI rounding never does.
      if (Math.abs(next.x - point.x) + Math.abs(next.y - point.y) < MOVE_THRESHOLD_PX) return false;
      point = next;
      return true;
    }
    doc.addEventListener("pointermove", event => {
      // UA seekbars can consume pointerdown. Their retargeted move still tells
      // us a button is held, and lostpointercapture releases native scrubbing.
      if (enabled() && event.buttons && panel.contains(event.target)) pointers.add(event.pointerId);
      else if (event.buttons === 0) pointers.delete(event.pointerId);
      // A held button is deliberate input (UA seekbar drags may hide pointerdown).
      const moved = rememberPoint(event) || Boolean(event.buttons);
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
