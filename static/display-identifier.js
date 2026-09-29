(function initializeDisplayIdentifier() {
  "use strict";

  const parameters = new URLSearchParams(window.location.search);
  let language = ["zh", "en", "ja"].includes(parameters.get("language"))
    ? parameters.get("language")
    : "zh";
  const rawNumber = Number(parameters.get("number"));
  const displayNumber = Number.isSafeInteger(rawNumber) && rawNumber > 0 && rawNumber <= 99
    ? rawNumber
    : 1;
  const role = ["host", "audience", "unavailable"].includes(parameters.get("role"))
    ? parameters.get("role")
    : "unavailable";
  const roleKeys = {
    host: "display.identifierCurrentHost",
    audience: "display.identifierAudience",
    unavailable: "display.identifierUnavailable",
  };
  const fallbackLabels = {
    zh: { host: "当前 Host", audience: "可选观众屏", unavailable: "不可选择" },
    en: { host: "Current Host", audience: "Audience display", unavailable: "Unavailable" },
    ja: { host: "現在の Host", audience: "観客用画面", unavailable: "選択不可" },
  };

  let catalog = null;
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = ["dark", "blue"].includes(theme) ? theme : "light";
  };
  const render = () => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : language;
    const number = document.getElementById("display-identifier-number");
    const roleLabel = document.getElementById("display-identifier-role");
    if (number) number.textContent = String(displayNumber);
    if (roleLabel) roleLabel.textContent = catalog?.languages?.[language]?.[roleKeys[role]] || fallbackLabels[language][role];
  };
  // External, blocking head script: the native Host's CSP rejects inline
  // scripts. Set the theme before loading CSS, then localize once DOM is ready.
  applyTheme(parameters.get("theme"));
  document.documentElement.dataset.displayRole = role;
  render();
  document.addEventListener("DOMContentLoaded", render, { once: true });
  window.addEventListener("storage", (event) => {
    if (event.key === "bilikara.ui.theme") applyTheme(event.newValue);
    if (event.key === "bilikara.ui.language") {
      language = ["en", "ja"].includes(event.newValue) ? event.newValue : "zh";
      render();
    }
  });
  if (typeof window.BroadcastChannel === "function") {
    const channel = new window.BroadcastChannel("bilikara-host-appearance");
    channel.addEventListener("message", ({ data }) => {
      if (!data || typeof data !== "object") return;
      applyTheme(data.theme);
      language = ["en", "ja"].includes(data.language) ? data.language : "zh";
      render();
    });
    window.addEventListener("pagehide", () => channel.close(), { once: true });
  }

  fetch("/i18n.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((translations) => {
      catalog = translations;
      render();
    })
    .catch(() => {});
})();
