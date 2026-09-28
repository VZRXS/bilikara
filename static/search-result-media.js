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

/* Compact titles share two lines; only the overflowing remainder moves.
   Size/content/font changes trigger measurement, never a polling timer. */
(function () {
  "use strict";
  const selector = ".follow-up-name, .tag-browser-tag-name";
  const titles = new Map();
  const visible = new Set();
  const pending = new Set();
  const measure = document.createElement("canvas").getContext("2d");
  const segmenter = typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, {granularity: "grapheme"}) : null;
  let frame = null;
  const toggle = (node, name, enabled) => {
    if (node.classList.contains(name) !== enabled) node.classList.toggle(name, enabled);
  };
  function syncRunning(title) {
    toggle(title, "is-card-title-visible", visible.has(title) && !document.hidden);
  }
  function schedule(title) {
    if (!titles.has(title)) return;
    pending.add(title);
    if (frame === null) frame = requestAnimationFrame(flush);
  }
  function splitTitle(text, width) {
    const chars = segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
    let low = 0, high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure.measureText(chars.slice(0, middle).join("")).width <= width) low = middle;
      else high = middle - 1;
    }
    let first = chars.slice(0, low).join("");
    // Prefer a word boundary for Latin text; CJK may break between characters.
    if (low < chars.length) {
      const space = first.lastIndexOf(" ");
      if (space > first.length / 2 && /^[\p{Script=Latin}\p{Number}]/u.test(first.slice(space + 1))) {
        first = first.slice(0, space + 1);
      }
    }
    return [first, text.slice(first.length)];
  }
  function flush() {
    frame = null;
    const changes = [];
    // Batch layout reads before writes to avoid relayout for each card.
    for (const title of pending) {
      const entry = titles.get(title);
      if (!entry || !title.isConnected || !title.clientWidth) continue;
      const style = getComputedStyle(title);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const width = title.clientWidth, remainderWidth = entry.second.clientWidth;
      const signature = JSON.stringify([entry.text, width, remainderWidth, font, style.letterSpacing]);
      if (signature === entry.signature) continue;
      measure.font = font;
      if ("letterSpacing" in measure) measure.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      const [first, rest] = splitTitle(entry.text, width);
      changes.push({title, entry, signature, first, rest,
        distance: Math.max(0, Math.ceil(measure.measureText(rest).width - remainderWidth))});
    }
    pending.clear();
    for (const {title, entry, signature, first, rest, distance} of changes) {
      entry.signature = signature;
      if (entry.first.textContent !== first) entry.first.textContent = first;
      if (entry.track.textContent !== rest) entry.track.textContent = rest;
      toggle(title, "is-card-title-overflowing", distance > 1);
      for (const [key, value] of [
        ["--request-card-title-distance", `${distance}px`],
        ["--request-card-title-duration", `${Math.max(8, distance / 24 + 4)}s`],
      ]) {
        if (title.style.getPropertyValue(key) !== value) title.style.setProperty(key, value);
      }
    }
  }
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    entries.forEach(({target}) => schedule(target));
  }) : null;
  const intersection = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const {target, isIntersecting, intersectionRect} of entries) {
      if (isIntersecting && intersectionRect.width && intersectionRect.height) visible.add(target);
      else visible.delete(target);
      syncRunning(target);
    }
  }) : null;
  function add(title) {
    const existing = titles.get(title), text = title.textContent;
    if (existing && text === existing.text && existing.first.parentElement === title
      && existing.second.parentElement === title && existing.track.parentElement === existing.second) return;
    const first = document.createElement("span"), second = document.createElement("span");
    const track = document.createElement("span");
    first.className = "request-card-title-line";
    second.className = "request-card-title-line request-card-title-remainder";
    track.className = "request-card-title-track";
    track.textContent = text;
    second.append(track);
    title.replaceChildren(first, second);
    titles.set(title, {text, first, second, track, signature: null});
    if (!existing) {
      resize?.observe(title);
      intersection?.observe(title);
      if (!intersection) visible.add(title);
      syncRunning(title);
    }
    schedule(title);
  }
  function remove(title) {
    if (title.isConnected) return;
    titles.delete(title);
    visible.delete(title);
    pending.delete(title);
    resize?.unobserve(title);
    intersection?.unobserve(title);
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
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      const title = target?.closest(selector);
      if (title?.isConnected) add(title);
      // Adding/removing an avatar changes only the second line's available width.
      if ([...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE
        && node.matches(".follow-up-avatar"))) target?.querySelectorAll(selector).forEach(schedule);
    }
  }).observe(document.body, {childList: true, characterData: true, subtree: true});
  document.querySelectorAll(selector).forEach(add);
  const refresh = () => {
    for (const [title, entry] of titles) { entry.signature = null; schedule(title); }
  };
  window.addEventListener("resize", refresh);
  document.fonts?.ready.then(refresh);
  document.fonts?.addEventListener("loadingdone", refresh);
  document.addEventListener("visibilitychange", () => titles.forEach((entry, title) => syncRunning(title)));
})();
