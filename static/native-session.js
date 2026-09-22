// Shared native startup choice. The Rust session remains authoritative.
(() => {
  "use strict";
  if (document.documentElement.dataset.nativeHost !== "true") return;
  const byId = (id) => document.getElementById(id);
  const sessionChoice = byId("native-session-choice");
  const dismissButton = byId("native-session-dismiss");
  const countdown = dismissButton.querySelector("[data-session-countdown]");
  const motion = {backupBannerMotionFrame:null, backupBannerMotionTimer:null};
  let sessionChoiceBusy = false;
  let active = false, failed = false, timer = null;
  let remainingMs = 10000, deadline = 0;

  function paused() {
    return document.hidden || sessionChoice.matches(":hover, :focus-within");
  }
  function updateDismissButton() {
    dismissButton.classList.toggle("is-close-glyph", paused() || failed || sessionChoiceBusy);
    countdown.textContent = String(Math.max(1, Math.ceil(remainingMs / 1000)));
  }
  function stopCountdown() {
    if (timer === null) return;
    remainingMs = Math.max(0, deadline - performance.now());
    window.clearInterval(timer);
    timer = null;
  }
  function syncCountdown() {
    if (!active || sessionChoiceBusy || failed || paused()) {
      stopCountdown();
    } else if (timer === null) {
      deadline = performance.now() + remainingMs;
      timer = window.setInterval(() => {
        remainingMs = Math.max(0, deadline - performance.now());
        updateDismissButton();
        if (remainingMs === 0) void chooseSession(dismissButton);
      }, 100);
    }
    updateDismissButton();
  }
  function syncSessionChoice() {
    const pending = Boolean(state.data?.session_flags?.startup_choice_pending);
    if (pending) {
      if (!active) {
        active = true;
        failed = false;
        remainingMs = 10000;
      }
      hideBackupBanner({immediate:true});
      showBackupBanner(sessionChoice, motion);
    } else {
      active = false;
      hideBackupBanner({banner:sessionChoice, motion});
    }
    // SSE updates and layout/language renders do not restart the countdown.
    syncCountdown();
    return pending;
  }

  async function chooseSession(button) {
    if (!active || sessionChoiceBusy) return;
    sessionChoiceBusy = true;
    stopCountdown();
    updateDismissButton();
    const buttons = Array.from(sessionChoice.querySelectorAll("button"));
    const disabled = buttons.map(item => item.disabled);
    const label = button.textContent;
    buttons.forEach(item => { item.disabled = true; });
    button.setAttribute("aria-busy", "true");
    if (button !== dismissButton) button.textContent = t("remoteIdentity.saving");
    byId("native-session-choice-error").textContent = "";
    try {
      await apiPostStateSnapshot("/api/session/startup-choice", {choice:button.dataset.sessionChoice});
      // Android admits operational reports only after Rust resolves the choice.
      // Report once here; the common bootstrap reports for fresh sessions.
      try { await reportMediaCapabilities(); } catch { /* Rust limits remain. */ }
      render();
      syncSessionChoice();
    } catch (error) {
      // Keep the choice available for an explicit retry, without a timer loop.
      failed = true;
      byId("native-session-choice-error").textContent = error.message;
    } finally {
      buttons.forEach((item,index) => { item.disabled = disabled[index]; });
      button.removeAttribute("aria-busy");
      if (button !== dismissButton) button.textContent = label;
      sessionChoiceBusy = false;
      syncCountdown();
    }
  }
  sessionChoice.addEventListener("click", event => {
    const button = event.target.closest("[data-session-choice]");
    if (button) void chooseSession(button);
  });
  sessionChoice.addEventListener("mouseenter", syncCountdown);
  sessionChoice.addEventListener("mouseleave", syncCountdown);
  sessionChoice.addEventListener("focusin", syncCountdown);
  sessionChoice.addEventListener("focusout", () => queueMicrotask(syncCountdown));
  document.addEventListener("visibilitychange", syncCountdown);
  window.BilikaraNativeSession = {syncSessionChoice};
})();
