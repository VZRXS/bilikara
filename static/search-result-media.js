/* Keep cover metadata readable as Host/Remote card widths change. */
(function () {
  "use strict";
  const selector = ".search-result-cover";
  const covers = new Set();
  const pending = new Set();
  let frame = 0;

  function schedule(cover) {
    if (!covers.has(cover)) return;
    pending.add(cover);
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function layout() {
    frame = 0;
    const changes = [];
    // Read all widths before moving badges, so a large Host grid lays out once.
    for (const cover of pending) {
      if (!cover.isConnected || !cover.clientWidth) continue;
      const stats = cover.querySelector(".search-result-cover-stats");
      const rating = cover.querySelector(".search-result-rating-badge");
      if (!stats || !rating) continue;
      const plays = stats.querySelector(".search-result-plays");
      const duration = stats.querySelector(".search-result-duration");
      const style = getComputedStyle(stats);
      const gap = parseFloat(style.columnGap) || 0;
      const available = stats.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // Measure the full count even if its current flex box is already clipped.
      const playWidth = plays ? plays.querySelector("svg").getBoundingClientRect().width
        + (parseFloat(getComputedStyle(plays).columnGap) || 0) + plays.lastElementChild.scrollWidth : 0;
      const required = playWidth + rating.firstElementChild.getBoundingClientRect().width + (duration?.scrollWidth || 0)
        + gap * (Number(Boolean(plays)) + Number(Boolean(duration)));
      changes.push({ cover, stats, rating, duration, raised: required > available });
    }
    pending.clear();
    for (const { cover, stats, rating, duration, raised } of changes) {
      cover.classList.toggle("is-rating-raised", raised);
      if (raised && rating.parentElement !== cover) cover.appendChild(rating);
      else if (!raised && rating.parentElement !== stats) stats.insertBefore(rating, duration);
    }
  }

  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    for (const { target } of entries) schedule(target.matches(selector) ? target : target.parentElement);
  }) : null;

  function add(cover) {
    if (covers.has(cover) || !cover.querySelector(".search-result-rating-badge")) return;
    covers.add(cover);
    resize?.observe(cover);
    resize?.observe(cover.querySelector(".search-result-cover-stats"));
    schedule(cover);
  }

  function remove(cover) {
    if (cover.isConnected) return;
    covers.delete(cover);
    pending.delete(cover);
    resize?.unobserve(cover);
    const stats = cover.querySelector(".search-result-cover-stats");
    if (stats) resize?.unobserve(stats);
  }

  function visit(node, action) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.matches(selector)) action(node);
    node.querySelectorAll(selector).forEach(action);
  }

  new MutationObserver(records => {
    for (const record of records) {
      record.removedNodes.forEach(node => visit(node, remove));
      record.addedNodes.forEach(node => visit(node, add));
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll(selector).forEach(add);
  const refresh = () => covers.forEach(schedule);
  window.addEventListener("resize", refresh);
  document.fonts?.ready.then(refresh);
  document.fonts?.addEventListener("loadingdone", refresh);
})();
