/* One shared UI. Adapters run only after an explicit legacy selection. */
(function () {
  "use strict";
  var root = document.documentElement;
  var selected = location.hash === "#bilikara-legacy";
  var major = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  var legacy = selected && major && Number(major[1]) >= 83;
  root.setAttribute("data-webview-mode", legacy ? "legacy" : "latest");
  if (!legacy) return;
  window.BilikaraWebViewCompatibility = { mode: "legacy", chromiumMajor: Number(major[1]), engine: Number(major[1]) < 91 ? 83 : 91, adapters: [
    ["Element.replaceChildren", typeof Element.prototype.replaceChildren !== "function"],
    ["String.replaceAll", typeof String.prototype.replaceAll !== "function"],
    ["Object.hasOwn", typeof Object.hasOwn !== "function"],
    ["Array.at", typeof Array.prototype.at !== "function"],
    ["crypto.randomUUID", typeof crypto.randomUUID !== "function"],
    ["HTMLElement.inert", !("inert" in HTMLElement.prototype)],
    ["CSS :has()", !CSS.supports("selector(:has(*))")],
    ["CSS dvh", !CSS.supports("height: 100dvh")],
    ["CSS containers", !CSS.supports("container-type: size")],
    ["CSS color-mix()", !CSS.supports("color: color-mix(in srgb, black, white)")]
  ].filter(function (entry) { return entry[1]; }).map(function (entry) { return entry[0]; }) };

  [Element.prototype, DocumentFragment.prototype].forEach(function (prototype) {
    if (typeof prototype.replaceChildren === "function") return;
    Object.defineProperty(prototype, "replaceChildren", { configurable: true, writable: true, value: function () {
      var parent = this, fragment = document.createDocumentFragment();
      Array.from(arguments).forEach(function (child) {
        if (child instanceof Node && (child === parent || child.contains(parent))) throw new DOMException("Invalid child", "HierarchyRequestError");
      });
      // Prepare before removing: moving retained children preserves their identity
      // and handlers; invalid node conversions do not empty the existing parent.
      fragment.append.apply(fragment, arguments);
      while (parent.firstChild) parent.removeChild(parent.firstChild);
      parent.appendChild(fragment);
    }});
  });
  if (typeof String.prototype.replaceAll !== "function") Object.defineProperty(String.prototype, "replaceAll", {
    configurable: true, writable: true, value: function (search, replacement) {
      if (this == null) throw new TypeError("replaceAll requires a string");
      // Application callers use literal strings. Retain native replacement-token
      // and callback behavior, and reject a non-global regular expression.
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError("replaceAll requires a global RegExp");
        return String(this).replace(search, replacement);
      }
      var escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return String(this).replace(new RegExp(escaped, "g"), replacement);
    }
  });
  if (typeof Object.hasOwn !== "function") Object.defineProperty(Object, "hasOwn", {
    configurable: true, writable: true, value: function (object, key) {
      if (object == null) throw new TypeError("Object.hasOwn requires an object");
      return Object.prototype.hasOwnProperty.call(object, key);
    }
  });
  if (typeof Array.prototype.at !== "function") Object.defineProperty(Array.prototype, "at", {
    configurable: true, writable: true, value: function (index) {
      if (this == null) throw new TypeError("Array.at requires an object");
      var object = Object(this), length = Math.min(Math.max(Math.floor(+object.length) || 0, 0), Number.MAX_SAFE_INTEGER);
      var offset = +index || 0;
      offset = offset < 0 ? Math.ceil(offset) : Math.floor(offset);
      var position = offset < 0 ? length + offset : offset;
      return position < 0 || position >= length ? undefined : object[position];
    }
  });
  if (typeof crypto.randomUUID !== "function") Object.defineProperty(crypto, "randomUUID", {
    configurable: true, writable: true, value: function () {
      // Keep cryptographic entropy; never substitute Math.random for identities.
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.from(bytes, function (n) { return n.toString(16).padStart(2, "0"); });
      return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("")
        + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10).join("");
    }
  });

  var cleanups = [], scheduled = false;
  var inertMissing = !("inert" in HTMLElement.prototype);
  var hasMissing = !CSS.supports("selector(:has(*))");
  var viewportMissing = !CSS.supports("height: 100dvh");
  var containerMissing = !CSS.supports("container-type: size");
  var colorsMissing = !CSS.supports("color: color-mix(in srgb, black, white)");
  root.toggleAttribute("data-legacy-inert", inertMissing);
  root.toggleAttribute("data-legacy-containers", containerMissing);
  root.toggleAttribute("data-legacy-colors", colorsMissing);
  var colorSignature;
  // The 83 loader replaces stylesheets after this script has started. Theme
  // identity alone cannot invalidate colors computed before those sheets load.
  window.BilikaraWebViewCompatibility.refreshStyles = function () { colorSignature = undefined; schedule(); };
  function synchronizeColors() {
    if (!colorsMissing || !document.body) return;
    var style = getComputedStyle(root);
    var inputs = ["--sync-btn-bg", "--ink", "--btn-secondary-bg", "--accent"].map(function (name) { return style.getPropertyValue(name).trim(); });
    // An in-flight stylesheet must not poison the cache with canvas's default
    // black. Tokens may arrive/change without a data-theme attribute change.
    if (inputs.some(function (value) { return !value; })) return;
    var signature = [root.getAttribute("data-theme")].concat(inputs).join("|");
    if (colorSignature === signature) return;
    colorSignature = signature;
    var context = document.createElement("canvas").getContext("2d");
    function color(name) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = style.getPropertyValue(name).trim();
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data;
    }
    function mix(name, first, second, weight) {
      var a = color(first), b = color(second), alpha = (a[3] * weight + b[3] * (1 - weight)) / 255;
      var rgb = [0, 1, 2].map(function (i) { return Math.round((a[i] * a[3] * weight + b[i] * b[3] * (1 - weight)) / (alpha * 255 || 1)); });
      root.style.setProperty(name, "rgba(" + rgb.join(",") + "," + alpha + ")");
    }
    mix("--legacy-pressed", "--sync-btn-bg", "--ink", 0.94);
    mix("--legacy-dismiss", "--btn-secondary-bg", "--ink", 0.88);
    mix("--legacy-selected", "--accent", "--btn-secondary-bg", 0.15);
  }
  var tabs = new Map(), hidden = new Map();
  var focusable = "a[href],area[href],button,input,select,textarea,iframe,[tabindex],[contenteditable]";
  if (inertMissing) Object.defineProperty(HTMLElement.prototype, "inert", {
    configurable: true,
    get: function () { return this.hasAttribute("inert"); },
    set: function (value) { this.toggleAttribute("inert", Boolean(value)); synchronizeInert(); }
  });
  function restore(node, attribute, value) {
    if (value === null) node.removeAttribute(attribute); else node.setAttribute(attribute, value);
  }
  function synchronizeInert() {
    if (!inertMissing || !document.body) return;
    var next = new Set(), roots = new Set(document.querySelectorAll("[inert]"));
    roots.forEach(function (node) {
      if (!hidden.has(node)) hidden.set(node, node.getAttribute("aria-hidden"));
      if (node.getAttribute("aria-hidden") !== "true") node.setAttribute("aria-hidden", "true");
      if (node.matches(focusable)) next.add(node);
      node.querySelectorAll(focusable).forEach(function (child) { next.add(child); });
    });
    tabs.forEach(function (value, node) {
      if (!next.has(node)) { restore(node, "tabindex", value); tabs.delete(node); }
    });
    hidden.forEach(function (value, node) {
      if (!roots.has(node)) { restore(node, "aria-hidden", value); hidden.delete(node); }
    });
    next.forEach(function (node) {
      if (!tabs.has(node)) tabs.set(node, node.getAttribute("tabindex"));
      if (node.getAttribute("tabindex") !== "-1") node.setAttribute("tabindex", "-1");
    });
    var active = document.activeElement;
    if (active && active.closest("[inert]")) active.blur();
  }
  function blockInert(event) {
    var target = event.target instanceof Element ? event.target : null;
    if (target && target.closest("[inert]")) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === "focusin") target.blur();
    }
  }
  function listen(target, type, handler, capture) {
    target.addEventListener(type, handler, capture);
    cleanups.push(function () { target.removeEventListener(type, handler, capture); });
  }
  if (inertMissing) ["focusin", "click", "pointerdown", "keydown"].forEach(function (type) {
    listen(document, type, blockInert, true);
  });

  // These are the relationships used by our shared CSS, not a general :has polyfill.
  var relations = [
  [
    "r0",
    ":is(.player-control-row, .presentation-host-transport-row)",
    ".playback-song-actions.is-expanded"
  ],
  [
    "r1",
    ":root",
    ".app-shell"
  ],
  [
    "r2",
    ".follow-up-button",
    ".follow-up-avatar"
  ],
  [
    "r3",
    ".browse-search-bar",
    "> .category-browser-tabs"
  ],
  [
    "r4",
    ".critical-banner-region",
    ".backup-banner:not(.hidden)"
  ],
  [
    "r5",
    ":is(.mode-control, .status-chip)",
    "> button:not(:disabled):hover"
  ],
  [
    "r6",
    ":is(.mode-control, .status-chip)",
    "> button:not(:disabled)[aria-expanded=\"true\"]"
  ],
  [
    "r7",
    ":is(.mode-control, .status-chip)",
    "> button:not(:disabled):active"
  ],
  [
    "r8",
    ".selection-modal-head.host-peer-head",
    ".section-tag"
  ],
  [
    "r9",
    ".gatcha-main-view",
    ".gatcha-prerequisite-notices:not([hidden])"
  ],
  [
    "r10",
    ".request-mode-panel",
    "> .host-search-summary:not([hidden])"
  ],
  [
    "r11",
    ".announcement-card",
    "> #announcements-status:not(:empty)"
  ],
  [
    "r12",
    ".announcement-card",
    "> #announcements-content:empty"
  ],
  [
    "r13",
    ".request-panel",
    "> .remote-request-view:not([hidden])\n  :is(.remote-search-mode-panel, .remote-discover-mode-panel, .remote-sources-mode-panel):not([hidden])\n  .result-pager:not([hidden])"
  ],
  [
    "r14",
    ".category-browser-home",
    "> .result-pager"
  ],
  [
    "r15",
    ".result-page-viewport",
    "> .hidden"
  ],
  [
    "r16",
    ".remote-header",
    ".remote-menu-toggle[aria-expanded=\"true\"]"
  ],
  [
    "r17",
    ".remote-menu-panel",
    ".remote-menu-settings-content:not(.hidden)"
  ],
  [
    "r18",
    ".remote-menu-panel",
    ".remote-share-card.is-dual"
  ],
  [
    "r19",
    ".remote-search-toolbar",
    "> *"
  ],
  [
    "r20",
    "html",
    "body.playback-sheet-scroll-locked"
  ],
  [
    "r21",
    ".remote-access-qr-placeholder",
    "svg"
  ],
  [
    "r22",
    ":is(.banner-close, .binding-sheet-close, .rating-close, .song-detail-close)",
    "> .close-icon"
  ],
  [
    "r23",
    ".source-action-row",
    "> .source-uid-form"
  ],
  [
    "r24",
    ".source-uid-form",
    "> .source-refresh-button"
  ],
  [
    "r25",
    ".android-my-card",
    ".host-account-settings.is-logged"
  ],
  [
    "r26",
    ".source-mode-panel",
    "> .source-frame-footer > .host-result-pager:not([hidden])"
  ],
  [
    "r27",
    ".source-frame-footer",
    "> .host-result-pager:not([hidden])"
  ],
  [
    "r28",
    ".media-output-targets",
    "input:disabled"
  ]
];
  if (window.BilikaraWebViewCompatibility.engine === 83) relations.forEach(function (rule) {
    rule[1] = rule[1].replace(/:is\(/g, ":-webkit-any(");
    rule[2] = rule[2].replace(/:is\(/g, ":-webkit-any(");
  });
  function synchronizeRelations() {
    if (!hasMissing) return;
    var values = new Map();
    relations.forEach(function (rule) {
      document.querySelectorAll(rule[1]).forEach(function (node) {
        if (!values.has(node)) values.set(node, []);
        var selector = rule[2].trim();
        if (node.querySelector(selector[0] === ">" ? ":scope " + selector : selector)) values.get(node).push(rule[0]);
      });
    });
    values.forEach(function (keys, node) {
      var value = Array.from(new Set(keys)).join(" ");
      if (node.getAttribute("data-legacy-has") !== value) node.setAttribute("data-legacy-has", value);
    });
  }
  function paint() {
    scheduled = false;
    synchronizeInert(); synchronizeRelations(); synchronizeColors();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(paint);
  }
  var observer;
  function start() {
    paint();
    observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["inert", "hidden", "class", "aria-expanded", "disabled", "tabindex", "href", "contenteditable", "data-theme"], characterData: true });
  }
  if (document.readyState === "loading") listen(document, "DOMContentLoaded", start, { once: true }); else start();
  if (hasMissing) ["pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel"].forEach(function (type) {
    listen(document, type, schedule, true);
  });
  function resizeViewport() {
    if (!viewportMissing) return;
    root.style.setProperty("--legacy-vh", ((window.visualViewport ? visualViewport.height : innerHeight) / 100) + "px");
  }
  resizeViewport();
  if (viewportMissing) {
    listen(window, "resize", resizeViewport);
    if (window.visualViewport) listen(visualViewport, "resize", resizeViewport);
  }
  var sizes;
  if (containerMissing) {
    sizes = new ResizeObserver(function (entries) {
      entries.forEach(function (entry) {
        var node = entry.target, width = entry.contentRect.width, height = entry.contentRect.height;
        node.style.setProperty("--legacy-cqw", width / 100 + "px");
        node.style.setProperty("--legacy-cqh", height / 100 + "px");
        node.toggleAttribute("data-legacy-wide", width >= 500);
      });
    });
    function observeSizes() {
      document.querySelectorAll(".request-workspace, .presentation-host-announcement").forEach(function (node) { sizes.observe(node); });
    }
    if (document.readyState === "loading") listen(document, "DOMContentLoaded", observeSizes, { once: true }); else observeSizes();
  }
  listen(window, "pagehide", function (event) {
    if (event.persisted) return; // A cached document resumes with its scoped observers.
    if (observer) observer.disconnect();
    if (sizes) sizes.disconnect();
    cleanups.splice(0).forEach(function (remove) { remove(); });
    tabs.forEach(function (value, node) { restore(node, "tabindex", value); });
    hidden.forEach(function (value, node) { restore(node, "aria-hidden", value); });
    tabs.clear(); hidden.clear();
  });
})();
