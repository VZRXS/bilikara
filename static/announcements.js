// Presentation only. Rust selects eligibility/order and persists shown IDs.
(function (root) {
  "use strict";
  function localized(values, language) {
    return values?.[language] || values?.en || values?.zh || values?.ja || "";
  }
  function inline(document, parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(start, match.index)));
      const token = match[0];
      let element;
      if (token.startsWith("`")) {
        element = document.createElement("code"); element.textContent = token.slice(1, -1);
      } else if (token.startsWith("**")) {
        element = document.createElement("strong"); element.textContent = token.slice(2, -2);
      } else {
        const split = token.indexOf("](");
        const href = token.slice(split + 2, -1);
        let url;
        try { url = new URL(href); } catch { /* Invalid links remain plain text. */ }
        if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
          element = document.createTextNode(token);
        } else {
          element = document.createElement("a"); element.textContent = token.slice(1, split);
          element.href = url.href; element.target = "_blank"; element.rel = "noopener noreferrer";
        }
      }
      parent.append(element);
      start = match.index + token.length;
    }
    parent.append(document.createTextNode(text.slice(start)));
  }
  // Deliberately small Markdown subset: no HTML, embeds, images, remote fonts,
  // executable URLs or Markdown extensions that can initiate network requests.
  function markdown(document, text) {
    const fragment = document.createDocumentFragment();
    let paragraph = [], list = null, code = null;
    const flush = () => {
      if (paragraph.length) {
        const p = document.createElement("p"); inline(document, p, paragraph.join("\n")); fragment.append(p);
        paragraph = [];
      }
    };
    for (const line of String(text).split(/\r?\n/)) {
      if (line.startsWith("```")) {
        flush(); list = null;
        if (code) { code = null; }
        else { const pre = document.createElement("pre"); code = document.createElement("code"); pre.append(code); fragment.append(pre); }
      } else if (code) {
        code.append(document.createTextNode(`${line}\n`));
      } else if (!line.trim()) { flush(); list = null; }
      else if (/^#{1,6} /.test(line)) {
        flush(); list = null;
        const heading = document.createElement("h4"); inline(document, heading, line.replace(/^#{1,6} /, "")); fragment.append(heading);
      } else if (/^(?:[-*] |\d+\. )/.test(line)) {
        flush();
        const kind = /^\d/.test(line) ? "OL" : "UL";
        if (!list || list.tagName !== kind) { list = document.createElement(kind.toLowerCase()); fragment.append(list); }
        const li = document.createElement("li"); inline(document, li, line.replace(/^(?:[-*] |\d+\. )/, "")); list.append(li);
      } else { list = null; paragraph.push(line); }
    }
    flush();
    return fragment;
  }

  function create({ document, request, t, language, ready, canOpen = () => true, windowBridge = () => null, openLink = null }) {
    const button = document.getElementById("announcements-button");
    const modal = document.getElementById("announcements-modal");
    const closeButton = document.getElementById("announcements-close");
    const content = document.getElementById("announcements-content");
    const status = document.getElementById("announcements-status");
    let opened = false, automaticStarted = false, deferred = false, manualStarted = false;
    let manualBusy = false, inFlight = null, generation = 0, focusBefore = null, inert = [];
    let visibleItems = [], viewError = "";
    function check() {
      if (!inFlight) inFlight = Promise.resolve().then(() => request("/api/announcements/check", {})).finally(() => { inFlight = null; });
      return inFlight;
    }
    function isOpen() { return opened; }
    function show() {
      if (opened) return;
      opened = true;
      focusBefore = document.activeElement;
      inert = Array.from(document.body.children).filter(el => el !== modal && !["SCRIPT", "STYLE", "LINK"].includes(el.tagName)).map(el => [el, el.inert]);
      inert.forEach(([el]) => { el.inert = true; });
      modal.classList.remove("hidden");
      closeButton.focus({ preventScroll: true });
      windowBridge()?.postMessage("announcements-open");
    }
    function close() {
      if (!opened) return;
      opened = false; generation++;
      modal.classList.add("hidden");
      inert.forEach(([el, previous]) => { el.inert = previous; }); inert = [];
      windowBridge()?.postMessage("announcements-close");
      if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
    }
    function date(value, withTime = false) {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(language(), {
        year: "numeric", month: "numeric", day: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" } : {}),
      }) : value;
    }
    function render() {
      document.getElementById("announcements-title").textContent = t("announcements.title");
      closeButton.setAttribute("aria-label", t("common.close"));
      status.textContent = viewError ? t(viewError) : "";
      const nodes = document.createDocumentFragment();
      for (const item of visibleItems) {
        const article = document.createElement("article");
        article.className = `announcement-item${item.kind === "notice" ? " is-active-notice" : ""}`;
        const meta = document.createElement("div"); meta.className = "announcement-meta";
        const badge = document.createElement("span"); badge.className = "announcement-kind";
        badge.textContent = t(item.kind === "notice" ? "announcements.notice" : "announcements.release");
        const time = document.createElement("time"); time.dateTime = item.published_at; time.textContent = date(item.published_at);
        meta.append(badge, time);
        const title = document.createElement("h3"); title.textContent = localized(item.title, language());
        const body = document.createElement("div"); body.className = "announcement-markdown";
        body.append(markdown(document, localized(item.body_markdown, language())));
        const heading = document.createElement("header"); heading.className = "announcement-heading";
        heading.append(title, meta); article.append(heading);
        if (item.version || item.ends_at) {
          const detail = document.createElement("span"); detail.className = "announcement-detail";
          detail.textContent = item.version ? `v${item.version.replace(/^v/, "")}` : `${t("announcements.validUntil")} ${date(item.ends_at, true)}`;
          meta.append(detail);
        }
        article.append(body); nodes.append(article);
      }
      if (!visibleItems.length && !viewError) {
        const empty = document.createElement("p"); empty.className = "announcement-empty"; empty.textContent = t("announcements.empty"); nodes.append(empty);
      }
      content.replaceChildren(nodes);
    }
    async function present(data, automatic, token) {
      if (token !== generation) return;
      const ids = new Set(data.automatic_ids || []);
      // Rust owns deadline evaluation; also ignore expired notices supplied by
      // an older Host response rather than presenting an ended-history badge.
      visibleItems = (data.items || []).filter(item => (item.kind !== "notice" || !item.expired) && (!automatic || ids.has(item.id)));
      if (automatic && !visibleItems.length) return;
      viewError = data.storage_error ? "announcements.storageError"
        : data.error ? (data.available ? "announcements.cached" : "announcements.unavailable") : "";
      render(); show(); content.scrollTop = 0;
      if (!visibleItems.length) return;
      // Mark the successfully presented batch, not scroll positions. Closing
      // remains available throughout this request and never pauses playback.
      try { await request("/api/announcements/shown", { ids: visibleItems.map(item => item.id) }); }
      catch {
        if (opened && token === generation) { viewError = "announcements.storageError"; status.textContent = t(viewError); }
      }
    }
    async function manual() {
      if (manualBusy || !ready()) return;
      manualStarted = true; deferred = false; manualBusy = true;
      const token = ++generation, previousDisabled = button.disabled, label = button.textContent;
      button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = t("announcements.loading");
      visibleItems = []; viewError = "announcements.loading"; render(); show();
      try {
        const data = await check();
        if (opened && token === generation) await present(data, false, token);
      } catch {
        if (opened && token === generation) { viewError = "announcements.unavailable"; render(); }
      } finally {
        button.disabled = previousDisabled; button.removeAttribute("aria-busy"); button.textContent = label;
        manualBusy = false;
      }
    }
    async function sync() {
      button.classList.toggle("hidden", !ready());
      if (!ready() || manualStarted || (automaticStarted && !deferred) || inFlight || !canOpen() || opened) return;
      automaticStarted = true; deferred = false;
      const token = generation;
      try {
        const data = await check();
        if (manualStarted || token !== generation) return;
        if (!canOpen()) { deferred = true; return; }
        await present(data, true, token);
      } catch { /* Startup is fail-open; manual entry can retry after the short cache. */ }
    }
    button.addEventListener("click", () => { void manual(); });
    closeButton.addEventListener("click", close);
    document.getElementById("announcements-backdrop").addEventListener("click", close);
    content.addEventListener("click", event => {
      const link = event.target.closest("a[href]");
      if (link && openLink) { event.preventDefault(); openLink(link.href); }
    });
    document.addEventListener("keydown", event => {
      if (!opened) { queueMicrotask(() => { void sync(); }); return; }
      // Do not send player keyboard shortcuts through the dialog.
      event.stopImmediatePropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const focusable = Array.from(modal.querySelectorAll("button, a[href], [tabindex='0']")).filter(el => !el.disabled);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }, true);
    document.addEventListener("bilikara:i18n", () => { if (opened) render(); });
    document.addEventListener("visibilitychange", () => { void sync(); });
    document.addEventListener("fullscreenchange", () => { void sync(); });
    document.addEventListener("click", () => { queueMicrotask(() => { void sync(); }); });
    return { sync, close, isOpen, manual };
  }
  const api = { create, markdown, localized };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BilikaraAnnouncementView = api;
  if (root.document?.documentElement.dataset.nativeHost === "true") {
    root.BilikaraAnnouncements = create({
      document: root.document, request: (...args) => apiPost(...args, { timeoutMs: 15000 }),
      t: key => t(key), language: () => state.language,
      ready: () => state.hasValidStateResponse && state.data?.capabilities?.announcements === true,
      canOpen: () => !document.hidden && !document.fullscreenElement && !state.data?.session_flags?.startup_choice_pending
        && !Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')).some(el => el.id !== "announcements-modal" && el.getClientRects().length),
      windowBridge: () => root.BilikaraHostWindow,
      // Keep the native Host on its playback page; use the same platform
      // adapter and deferred Android-link behavior as the rest of the app.
      openLink: href => openExternalUrl(href),
    });
    void root.BilikaraAnnouncements.sync();
  }
})(globalThis);
