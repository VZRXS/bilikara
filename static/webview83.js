/* Narrow, opt-in WebView 83 adaptations; latest and legacy 91 keep native paths. */
(function () {
  "use strict";
  var compatibility = window.BilikaraWebViewCompatibility;
  if (!compatibility || compatibility.engine !== 83) return;
  var root = document.documentElement, cleanups = [], frame = 0, stopped = false, observer, sizes;
  compatibility.adapters.push("CSS 83 syntax", "simplified CSS motion");
  root.setAttribute("data-legacy-engine", "83");
  // CSS animation enumeration and completion arrived after this engine. Keep
  // panel transitions immediate. Title marquees have no completion lifecycle,
  // so they retain shared CSS motion and its reduced-motion rule.
  var motion = document.createElement("style");
  motion.textContent = 'html[data-legacy-engine="83"] *:not(.current-title-text),html[data-legacy-engine="83"] *::before,html[data-legacy-engine="83"] *::after{animation:none!important;transition:none!important}*{--legacy-aspect-ratio:auto}';
  document.head.appendChild(motion);
  var gapProbe = document.createElement("div");
  gapProbe.style.cssText = "position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px;padding:0;border:0";
  gapProbe.innerHTML = '<div style="height:1px"></div><div style="height:1px"></div>';
  root.appendChild(gapProbe);
  var flexMissing = gapProbe.scrollHeight !== 3, ratioMissing = !CSS.supports("aspect-ratio", "16 / 9");
  gapProbe.remove();
  if (flexMissing) compatibility.adapters.push("CSS flex gap");
  if (ratioMissing) compatibility.adapters.push("CSS aspect-ratio");
  if (!("finished" in Animation.prototype)) compatibility.adapters.push("Animation.finished");
  if (typeof Element.prototype.getAnimations !== "function") compatibility.adapters.push("Element.getAnimations");
  var playing = new WeakMap(), completions = new WeakMap();
  if (!("finished" in Animation.prototype)) Object.defineProperty(Animation.prototype, "finished", {
    configurable: true, get: function () {
      var animation = this;
      if (completions.has(animation)) return completions.get(animation);
      var promise = new Promise(function (resolve, reject) {
        function clear() { animation.removeEventListener("finish", finish); animation.removeEventListener("cancel", cancel); }
        function finish() { clear(); resolve(animation); }
        function cancel() { clear(); completions.delete(animation); reject(new DOMException("Animation cancelled", "AbortError")); }
        if (animation.playState === "finished") finish();
        else { animation.addEventListener("finish", finish); animation.addEventListener("cancel", cancel); }
      });
      // Consumers may cancel without awaiting it, just like native Animation.
      promise.catch(function () {});
      completions.set(animation, promise); return promise;
    }
  });
  if (typeof Element.prototype.getAnimations !== "function") {
    var animate = Element.prototype.animate;
    Element.prototype.animate = function () {
      var node = this, animation = animate.apply(node, arguments), entries = playing.get(node);
      if (!entries) { entries = new Set(); playing.set(node, entries); }
      entries.add(animation);
      function done() { entries.delete(animation); animation.removeEventListener("finish", done); animation.removeEventListener("cancel", done); }
      animation.addEventListener("finish", done); animation.addEventListener("cancel", done);
      return animation;
    };
    Object.defineProperty(Element.prototype, "getAnimations", {configurable: true, writable: true, value: function () {
      return Array.from(playing.get(this) || []).filter(function (animation) { return animation.playState !== "finished" && animation.playState !== "idle"; });
    }});
  }
  var flexSelectors = new Set(), ratioSelectors = new Set(), margins = new Map(), heights = new Map(), observed = new Set();
  function collect(rules) {
    Array.from(rules || []).forEach(function (rule) {
      if (rule.cssRules) collect(rule.cssRules);
      if (!rule.style || !rule.selectorText) return;
      if (rule.style.gap || rule.style.rowGap || rule.style.columnGap) flexSelectors.add(rule.selectorText);
      if (rule.style.getPropertyValue("--legacy-aspect-ratio")) ratioSelectors.add(rule.selectorText);
    });
  }
  function candidates(selectors) {
    var nodes = new Set();
    selectors.forEach(function (selector) { document.querySelectorAll(selector).forEach(function (node) { nodes.add(node); }); });
    return nodes;
  }
  function restore(map) {
    map.forEach(function (values, node) { Object.keys(values).forEach(function (property) { node.style[property] = values[property]; }); });
    map.clear();
  }
  function margin(node, property, amount) {
    if (!amount) return;
    var original = margins.get(node) || {};
    if (!(property in original)) original[property] = node.style[property];
    margins.set(node, original);
    node.style[property] = (parseFloat(getComputedStyle(node)[property]) + amount) + "px";
  }
  function paint() {
    frame = 0;
    restore(margins); restore(heights);
    var nextObserved = new Set();
    function watch(node) { nextObserved.add(node); if (!observed.has(node)) sizes.observe(node); }
    if (ratioMissing) candidates(ratioSelectors).forEach(function (node) {
      var ratio = getComputedStyle(node).getPropertyValue("--legacy-aspect-ratio").trim().split("/").map(Number);
      if (!(ratio[0] > 0) || !node.getClientRects().length) return;
      var value = node.getBoundingClientRect().width * (ratio[1] || 1) / ratio[0];
      heights.set(node, {height: node.style.height}); node.style.height = value + "px"; watch(node);
    });
    if (flexMissing) candidates(flexSelectors).forEach(function (node) {
      var style = getComputedStyle(node);
      if (style.display !== "flex" && style.display !== "inline-flex") return;
      var children = Array.from(node.children).filter(function (child) {
        var childStyle = getComputedStyle(child);
        return child.getClientRects().length && childStyle.position !== "absolute" && childStyle.position !== "fixed";
      });
      var column = style.flexDirection.indexOf("column") === 0, reverse = /reverse/.test(style.flexDirection);
      var main = parseFloat(column ? style.rowGap : style.columnGap) || 0;
      var cross = parseFloat(column ? style.columnGap : style.rowGap) || 0;
      var property = column ? (reverse ? "marginBottom" : "marginTop") : (reverse ? "marginRight" : "marginLeft");
      children.slice(1).forEach(function (child) { margin(child, property, main); });
      if (style.flexWrap !== "nowrap" && !column && children.length) {
        var first = children[0].offsetTop, previous = first;
        children.forEach(function (child, index) {
          var top = child.offsetTop;
          if (index && top !== previous) {
            var saved = margins.get(child);
            if (saved && property in saved) { child.style[property] = saved[property]; delete saved[property]; }
          }
          if (top > first) margin(child, "marginTop", cross);
          previous = top;
        });
      }
      watch(node);
    });
    // Retire removed/hidden candidates instead of observing old list/card nodes
    // for the lifetime of this long-running Host document.
    observed.forEach(function (node) { if (!nextObserved.has(node)) sizes.unobserve(node); });
    observed = nextObserved;
  }
  function schedule() { if (!stopped && !frame) frame = requestAnimationFrame(paint); }
  sizes = new ResizeObserver(schedule);
  Array.from(document.querySelectorAll('link[rel="stylesheet"]')).forEach(function (link) {
    var url = new URL(link.href);
    if (url.origin !== location.origin || !/^\/[a-z-]+\.css$/.test(url.pathname)) return;
    // An old stylesheet load event can already be queued while this parser-
    // blocking script replaces its href. Observe the replacement load as well.
    function loaded() { if (link.sheet) collect(link.sheet.cssRules); compatibility.refreshStyles(); schedule(); }
    link.addEventListener("load", loaded);
    cleanups.push(function () { link.removeEventListener("load", loaded); });
    link.href = "/compat83" + url.pathname;
  });
  function start() {
    Array.from(document.styleSheets).forEach(function (sheet) { if (sheet.href && new URL(sheet.href).origin === location.origin) collect(sheet.cssRules); });
    compatibility.refreshStyles();
    observer = new MutationObserver(schedule);
    observer.observe(root, {subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "hidden", "open", "data-theme", "data-active-workspace", "data-host-layout"]});
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once: true}); else start();
  function resize() { schedule(); }
  function resourcesReady() { if (stopped) return; compatibility.refreshStyles(); schedule(); }
  window.addEventListener("load", resourcesReady);
  cleanups.push(function () { window.removeEventListener("load", resourcesReady); });
  if (document.fonts) {
    document.fonts.ready.then(resourcesReady);
    document.fonts.addEventListener("loadingdone", resourcesReady);
    cleanups.push(function () { document.fonts.removeEventListener("loadingdone", resourcesReady); });
  }
  window.addEventListener("resize", resize);
  cleanups.push(function () { window.removeEventListener("resize", resize); });
  window.addEventListener("pagehide", function stop(event) {
    if (event.persisted) return;
    stopped = true; window.removeEventListener("pagehide", stop); if (frame) cancelAnimationFrame(frame);
    if (observer) observer.disconnect(); sizes.disconnect(); observed.clear(); restore(margins); restore(heights);
    cleanups.forEach(function (cleanup) { cleanup(); });
  });
})();
