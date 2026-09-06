(function initializeDisplayIdentifier() {
  "use strict";

  const parameters = new URLSearchParams(window.location.search);
  const language = ["zh", "en", "ja"].includes(parameters.get("language"))
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

  const number = document.getElementById("display-identifier-number");
  const roleLabel = document.getElementById("display-identifier-role");
  document.documentElement.dataset.displayRole = role;
  number.textContent = String(displayNumber);
  roleLabel.textContent = fallbackLabels[language][role];

  fetch("/i18n.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((catalog) => {
      const translated = catalog?.languages?.[language]?.[roleKeys[role]];
      if (translated) roleLabel.textContent = translated;
    })
    .catch(() => {});
})();
