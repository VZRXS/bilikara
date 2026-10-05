/* Passive confirmed-operation feedback; two recent categories, no waiting queue. */
(function (root) {
  "use strict";
  const durationMs = 2000, exitMs = 120, maxVisible = 2;
  const icons = {
    volume: ['M11 5 6 9H3v6h3l5 4Z', 'M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'],
    muted: ['M11 5 6 9H3v6h3l5 4Z', 'm16 9 6 6m0-6-6 6'],
    delay: ['M3 5h18v12H3Z', 'M8 21h8m-4-4v4', 'M7 9h2m6 4h2'],
    'delay-lock': ['M6 11h12v10H6Z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    pitch: ['M9 18V5l12-2v13', 'M9 5v4l12-2', 'M3 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0m12-2a3 3 0 1 0 6 0 3 3 0 1 0-6 0'],
    play: ['M8 5v14l11-7Z'], pause: ['M7 5v14m10-14v14'],
    seek: ['M4 6v12l8-6Z', 'M12 6v12l8-6Z'], next: ['M6 5v14l11-7Z', 'M20 5v14'],
  };
  const category = kind => kind === "muted" ? "volume" : ["play", "pause"].includes(kind) ? "playback" : kind;
  function snapshot(data) {
    if (!data) return null;
    const settings = data.player_settings || {};
    return { session: data.session_generation,
      item: String(data.current_item?.item_incarnation_id || data.current_item?.id || ""),
      volume: settings.volume_percent, muted: Boolean(settings.is_muted),
      delay: settings.av_delay?.effective_delay_ms ?? settings.av_offset_ms,
      locked: settings.av_delay?.locked, pitch: settings.key_shift };
  }
  function changes(previous, next) {
    if (!previous || !next || previous.session !== next.session || previous.item !== next.item) return [];
    const result = [];
    if (Number.isFinite(next.delay) && Number.isFinite(previous.delay) && next.delay !== previous.delay)
      result.push({ kind: "delay", value: `${next.delay > 0 ? "+" : ""}${next.delay}ms` });
    if (typeof next.locked === "boolean" && typeof previous.locked === "boolean" && next.locked !== previous.locked)
      result.push({ kind: "delay-lock", value: next.locked ? "locked" : "unlocked" });
    if (Number.isFinite(next.pitch) && Number.isFinite(previous.pitch) && next.pitch !== previous.pitch)
      result.push({ kind: "pitch", value: `${next.pitch > 0 ? "+" : ""}${next.pitch}` });
    if (Number.isFinite(next.volume) && Number.isFinite(previous.volume) && (next.volume !== previous.volume || next.muted !== previous.muted))
      result.push({ kind: next.muted ? "muted" : "volume", value: `${next.volume}%` });
    return result;
  }
  function change(previous, next) { return changes(previous, next)[0] || null; }
  function recent(existing, additions, now = Date.now()) {
    const entries = (existing?.entries || (existing?.key ? [existing] : [])).filter(item => item.expiresAt > now);
    for (const notice of additions) {
      const old = entries.findIndex(item => category(item.kind) === category(notice.kind));
      if (old >= 0) entries.splice(old, 1);
      entries.push(notice);
      if (entries.length > maxVisible) entries.shift();
    }
    const latest = entries.at(-1);
    return latest ? { ...latest, entries } : null;
  }
  function create(element, translate) {
    const cards = new Map(), seen = new Map();
    let order = 0;
    const svgNS = "http://www.w3.org/2000/svg";
    function remove(card) {
      clearTimeout(card.timer); clearTimeout(card.exitTimer); cancelAnimationFrame(card.frame);
      card.node.remove();
      if (cards.get(card.category) === card) cards.delete(card.category);
      if (!cards.size) element.classList.add("hidden");
    }
    function position() {
      const visible = [...cards.values()].filter(card => card.active).sort((a, b) => b.order - a.order);
      visible.forEach((card, index) => card.node.style.setProperty("--feedback-offset",
        visible.length === 1 ? "-50%" : index === 0 ? "calc(-100% - 4px)" : "4px"));
      element.classList.toggle("is-visible", visible.length > 0);
    }
    function dismiss(card) {
      if (!card.active) return;
      card.active = false;
      clearTimeout(card.timer); cancelAnimationFrame(card.frame);
      card.node.classList.remove("is-visible");
      card.exitTimer = setTimeout(() => remove(card), exitMs);
      position();
    }
    function hide() { for (const card of cards.values()) dismiss(card); }
    function content(card, notice) {
      const changedKind = card.kind && card.kind !== notice.kind;
      card.label.textContent = translate(`presentation.feedback.${notice.kind}`);
      card.value.textContent = notice.kind === "muted" ? "" : notice.kind === "delay-lock"
        ? translate(`presentation.feedback.${notice.value}`) : notice.value.slice(0, 512);
      card.value.hidden = !card.value.textContent;
      if (card.kind === notice.kind) return;
      card.kind = notice.kind;
      const icon = document.createElementNS(svgNS, "svg");
      for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none",
        stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round" })) icon.setAttribute(key, value);
      for (const d of icons[notice.kind]) {
        const path = document.createElementNS(svgNS, "path"); path.setAttribute("d", d); icon.appendChild(path);
      }
      card.icon.replaceChildren(icon);
      if (changedKind && !root.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        for (const node of [card.icon, card.label, card.value]) {
          for (const animation of node.getAnimations?.() || []) animation.cancel();
          node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: exitMs, easing: "ease" });
        }
      }
    }
    function one(notice) {
      const now = Date.now(), remaining = Math.min(durationMs, Number(notice?.expiresAt) - now);
      if (!notice?.key || !(remaining > 0) || !Object.hasOwn(icons, notice.kind) || typeof notice.value !== "string"
        || (notice.kind === "delay-lock" && !["locked", "unlocked"].includes(notice.value))) return false;
      for (const [key, deadline] of seen) if (deadline <= now) seen.delete(key);
      const type = category(notice.kind);
      let card = cards.get(type);
      if (seen.has(notice.key)) {
        if (card?.active && card.notice.key === notice.key) content(card, notice);
        return false;
      }
      seen.set(notice.key, now + remaining);
      if (seen.size > 64) seen.delete(seen.keys().next().value);
      if (!card?.active) {
        // Limit visible categories without keeping stale controls in a backlog.
        const active = [...cards.values()].filter(item => item.active);
        if (active.length >= maxVisible) dismiss(active.sort((a, b) => a.order - b.order)[0]);
      }
      if (!card) {
        // Each bounded category retains its geometry through its exit. Rapid
        // reopening cancels that category's old exit rather than duplicating it.
        const node = document.createElement("div"); node.className = "presentation-feedback-card";
        node.dataset.feedbackCategory = type;
        const icon = document.createElement("span"); icon.className = "presentation-feedback-icon";
        const label = document.createElement("span"); label.className = "presentation-feedback-label";
        const value = document.createElement("span"); value.className = "presentation-feedback-value";
        node.append(icon, label, value); element.appendChild(node);
        card = { category: type, node, icon, label, value }; cards.set(type, card);
      }
      clearTimeout(card.timer); clearTimeout(card.exitTimer); cancelAnimationFrame(card.frame);
      card.active = true; card.notice = notice; card.order = ++order;
      content(card, notice); element.classList.remove("hidden"); position();
      card.frame = requestAnimationFrame(() => { if (card.active) card.node.classList.add("is-visible"); });
      card.timer = setTimeout(() => dismiss(card), remaining);
      return true;
    }
    function show(notice) {
      const entries = Array.isArray(notice?.entries) ? notice.entries : [notice];
      let changed = false;
      for (const entry of entries.slice(-maxVisible)) changed = one(entry) || changed;
      return changed;
    }
    return { show, hide };
  }
  root.BilikaraPresentationFeedback = { snapshot, change, changes, recent, create, durationMs, maxVisible };
})(globalThis);
