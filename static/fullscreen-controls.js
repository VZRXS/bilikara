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
  window.BilikaraFullscreenControls = { bind };
})();
