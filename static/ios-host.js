/* iOS viewport adaptation only. The shared Host owns navigation and media;
   this document has no native system bridge or application-state authority. */
(function (scope) {
  "use strict";
  function keyboardInset(viewport, height, editing) {
    if (!editing || !viewport || Math.abs(viewport.scale - 1) > 0.01) return 0;
    const inset = height - viewport.height - viewport.offsetTop;
    return Number.isFinite(inset) ? Math.max(0, Math.min(height, inset)) : 0;
  }
  if (typeof module === "object" && module.exports) module.exports = {keyboardInset};
  const root = scope.document?.documentElement;
  if (root?.dataset.nativeHost !== "true" || root.dataset.hostPlatform !== "ios") return;

  const viewport = scope.visualViewport;
  let frame = null, attached = false, inset = 0;
  function update() {
    frame = null;
    const focused = scope.document.activeElement;
    const editing = Boolean(focused?.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, [contenteditable='true']"));
    const next = Math.round(keyboardInset(viewport, scope.innerHeight, editing));
    if (next === inset) return;
    inset = next;
    root.style.setProperty("--mobile-ime-height", `${inset}px`);
    if (inset > 0 && !focused.closest("[inert], [hidden]")) {
      focused.scrollIntoView({block: "nearest", inline: "nearest"});
    }
  }
  function schedule() {
    if (frame === null) frame = scope.requestAnimationFrame(update);
  }
  function start() {
    if (attached) return;
    attached = true;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    scope.addEventListener("resize", schedule);
    scope.document.addEventListener("focusin", schedule);
    scope.document.addEventListener("focusout", schedule);
    schedule();
  }
  function stop() {
    attached = false;
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    scope.removeEventListener("resize", schedule);
    scope.document.removeEventListener("focusin", schedule);
    scope.document.removeEventListener("focusout", schedule);
    if (frame !== null) scope.cancelAnimationFrame(frame);
    frame = null;
    inset = 0;
    root.style.removeProperty("--mobile-ime-height");
  }
  scope.BilikaraIOSHost = Object.freeze({diagnostics: () => ({keyboard_inset: inset, visual_viewport: Boolean(viewport)})});
  scope.addEventListener("pagehide", stop);
  scope.addEventListener("pageshow", start);
  start();
})(globalThis);
