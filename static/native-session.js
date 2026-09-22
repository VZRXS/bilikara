// Shared native startup choice. The Rust session remains authoritative.
(() => {
  "use strict";
  if (document.documentElement.dataset.nativeHost !== "true") return;
  const byId = (id) => document.getElementById(id);
  const sessionChoice = byId("android-session-choice");
  let sessionChoiceBusy = false;
  function syncSessionChoice() {
    const pending = Boolean(state.data?.session_flags?.startup_choice_pending);
    if (pending && !sessionChoice.open) sessionChoice.showModal();
    else if (!pending && sessionChoice.open) sessionChoice.close();
    return pending;
  }
  sessionChoice.addEventListener("cancel", event => event.preventDefault());
  sessionChoice.addEventListener("click", async event => {
    const button = event.target.closest("[data-session-choice]");
    if (!button || sessionChoiceBusy) return;
    sessionChoiceBusy = true;
    const buttons = Array.from(sessionChoice.querySelectorAll("button"));
    const disabled = buttons.map(item => item.disabled);
    const label = button.textContent;
    buttons.forEach(item => { item.disabled = true; });
    button.setAttribute("aria-busy", "true");
    button.textContent = t("remoteIdentity.saving");
    byId("android-session-choice-error").textContent = "";
    try {
      await apiPostStateSnapshot("/api/session/startup-choice", {choice:button.dataset.sessionChoice});
      // Android admits operational reports only after this explicit choice.
      // Report once here; the common bootstrap reports for fresh sessions.
      try { await reportMediaCapabilities(); } catch { /* Rust limits remain. */ }
      render();
      syncSessionChoice();
    } catch (error) {
      byId("android-session-choice-error").textContent = error.message;
    } finally {
      buttons.forEach((item,index) => { item.disabled = disabled[index]; });
      button.removeAttribute("aria-busy");
      button.textContent = label;
      sessionChoiceBusy = false;
    }
  });
  window.BilikaraNativeSession = {syncSessionChoice};
})();
