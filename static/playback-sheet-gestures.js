// Presentation only: existing open/close functions still own focus and modal state.
(() => {
  "use strict";
  const clamp = value => Math.max(0, Math.min(1, value));
  const mix = (a, b, progress) => a + (b - a) * progress;
  const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };

  function shouldExpand(progress, velocity, travel) {
    // A short, deliberate flick can finish a gesture; old samples do not count.
    return clamp(progress + Math.max(-1800, Math.min(1800, velocity)) * 0.18 / travel) >= 0.5;
  }

  function create({ dock, sheet, panel, header, body, collapse, isOpen, canUse,
    getKey, open, close, layout, onFinish, variant = "morph" }) {
    if (!dock || !sheet || !panel || !header || !body || !collapse) return null;
    if (!["morph", "slide"].includes(variant)) throw new Error("Unknown playback sheet gesture");
    const listeners = new AbortController();
    const listen = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...options, signal: listeners.signal });
    let gesture = null, frame = null, settling = null, ghost = null, suppressUntil = 0, destroyed = false;
    let restoredStyles = [];
    const backdrop = sheet.querySelector(".playback-sheet-backdrop");
    const headerContent = [...header.querySelectorAll(".playback-sheet-status-label, .playback-sheet-status-actions"), collapse];
    const properties = ["left", "top", "width", "height", "content-width", "body-height", "header-width", "radius", "bottom-radius", "translate"];
    function ownStyle(node, names) {
      if (!node) return;
      for (const name of names) restoredStyles.push([node, name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]);
    }
    function writeStyle(node, name, value) {
      if (node && node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    }
    const active = () => Boolean(gesture?.started || settling);
    function clearFrame() { if (frame !== null) window.cancelAnimationFrame(frame); frame = null; }
    function releaseCapture(pointerId) {
      try { if (document.documentElement.hasPointerCapture(pointerId)) document.documentElement.releasePointerCapture(pointerId); } catch { /* Pointer already retired. */ }
    }
    function reset() {
      clearFrame();
      sheet.classList.remove("is-gesturing", "is-dragging", "is-gesture-measuring");
      delete sheet.dataset.gestureVariant;
      sheet.style.removeProperty("--playback-sheet-drag-progress");
      for (const property of properties) panel.style.removeProperty(`--sheet-gesture-${property}`);
      for (const [node, name, value, priority] of restoredStyles) {
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
      restoredStyles = [];
      ghost?.remove(); ghost = null;
    }
    function finish(expanded) {
      const owner = gesture || settling;
      gesture = settling = null;
      if (owner) { body.inert = owner.bodyInert; releaseCapture(owner.id); }
      reset();
      if (!expanded) close({ immediate: true, restoreFocus: owner?.restoreFocus ?? false });
      onFinish?.();
    }
    function cancel({ restore = true } = {}) {
      const owner = gesture || settling;
      if (!owner) return;
      suppressUntil = owner.started ? performance.now() + 700 : suppressUntil;
      if (restore && owner.started) finish(owner.wasOpen && canUse());
      else {
        gesture = settling = null;
        body.inert = owner.bodyInert ?? body.inert;
        releaseCapture(owner.id);
        reset();
      }
    }
    function paint(owner, progress) {
      owner.progress = clamp(progress);
      const p = owner.progress, from = owner.dock, to = owner.panel;
      if (variant === "morph") {
        const left = mix(from.left, to.left, p), top = mix(from.top, to.top, p);
        const width = mix(from.width, to.width, p), height = mix(from.height, to.height, p);
        const radius = mix(owner.dockRadius, owner.radius, p), bottom = mix(owner.dockRadius, owner.bottomRadius, p);
        // Keep the laid-out surface/content fixed. Only its visible rectangle
        // moves/grows, avoiding layout and inherited-variable cascades per frame.
        writeStyle(panel, "transform", `translate3d(${left - to.left}px, ${top - to.top}px, 0)`);
        writeStyle(panel, "clip-path", `inset(0px ${Math.max(0, owner.canvasWidth - width)}px ${Math.max(0, owner.canvasHeight - height)}px 0px round ${radius}px ${radius}px ${bottom}px ${bottom}px)`);
      } else writeStyle(panel, "transform", `translate3d(0, ${(1 - p) * owner.travel}px, 0)`);
      writeStyle(backdrop, "opacity", String(p));
      const opacity = String(variant === "morph" ? smooth((p - 0.12) / 0.58) : 1);
      writeStyle(body, "opacity", opacity);
      for (const node of headerContent) writeStyle(node, "opacity", opacity);
      writeStyle(ghost, "opacity", String(1 - smooth(p / 0.28)));
    }
    function schedulePaint(owner) {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (gesture !== owner) return;
        paint(owner, owner.pendingProgress);
      });
    }
    function begin(owner) {
      // Capture outside the shell before open() makes the collapsed dock inert.
      if (owner.pointerDriven) {
        try { document.documentElement.setPointerCapture(owner.id); } catch { /* Document listeners also own cancellation. */ }
      }
      owner.dock = dock.getBoundingClientRect();
      owner.dockRadius = parseFloat(getComputedStyle(dock).borderTopLeftRadius) || 18;
      sheet.classList.add("is-gesture-measuring");
      if (!owner.wasOpen && !open()) { cancel({ restore: false }); return false; }
      layout?.();
      owner.panel = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      owner.radius = parseFloat(style.borderTopLeftRadius) || 18;
      owner.bottomRadius = parseFloat(style.borderBottomLeftRadius) || 0;
      owner.bodyInert = body.inert;
      owner.canvasWidth = variant === "morph" ? Math.max(owner.dock.width, owner.panel.width) : owner.panel.width;
      owner.canvasHeight = variant === "morph" ? Math.max(owner.dock.height, owner.panel.height) : owner.panel.height;
      owner.travel = Math.max(80, variant === "morph" ? owner.dock.top - owner.panel.top : innerHeight - owner.panel.top);
      owner.catchUp = Math.max(0, innerHeight - owner.y + Math.min(header.offsetHeight / 2, 28));
      owner.started = true;
      body.inert = true;
      sheet.dataset.gestureVariant = variant;
      const surface = {left: owner.panel.left, top: owner.panel.top, width: owner.canvasWidth, height: owner.canvasHeight,
        radius: variant === "morph" ? 0 : owner.radius, "bottom-radius": variant === "morph" ? 0 : owner.bottomRadius, translate: 0};
      for (const [name, value] of Object.entries(surface)) panel.style.setProperty(`--sheet-gesture-${name}`, `${value}px`);
      panel.style.setProperty("--sheet-gesture-header-width", `${header.getBoundingClientRect().width}px`);
      panel.style.setProperty("--sheet-gesture-content-width", `${body.getBoundingClientRect().width}px`);
      panel.style.setProperty("--sheet-gesture-body-height", `${body.getBoundingClientRect().height}px`);
      if (variant === "morph") {
        // A passive copy of the existing dock content bridges the two surfaces.
        // It contains no media player, controls, handlers or independent state.
        const content = dock.querySelector(".playback-dock-content");
        if (content) {
          ghost = content.cloneNode(true);
          for (const node of [ghost, ...ghost.querySelectorAll("*")]) node.removeAttribute("id");
          ghost.classList.add("playback-sheet-dock-ghost");
          ghost.style.width = `${owner.dock.width}px`;
          ghost.setAttribute("aria-hidden", "true");
          ghost.inert = true;
          panel.append(ghost);
        }
      }
      sheet.classList.add("is-gesturing");
      ownStyle(panel, ["transform", "clip-path"]);
      ownStyle(body, ["opacity"]);
      ownStyle(backdrop, ["opacity"]);
      for (const node of headerContent) ownStyle(node, ["opacity"]);
      sheet.classList.toggle("is-dragging", owner.pointerDriven);
      sheet.classList.remove("is-gesture-measuring");
      paint(owner, owner.wasOpen ? 1 : 0);
      return true;
    }
    function settle(owner, expanded) {
      clearFrame();
      gesture = null;
      settling = owner;
      sheet.classList.remove("is-dragging");
      releaseCapture(owner.id);
      const from = owner.progress, to = expanded ? 1 : 0, started = performance.now();
      const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
      function tick(now) {
        frame = null;
        if (settling !== owner || destroyed) return;
        if (owner.key !== getKey() || !canUse()) { cancel(); return; }
        const time = duration ? clamp((now - started) / duration) : 1;
        paint(owner, mix(from, to, 1 - (1 - time) ** 3));
        if (time >= 1) finish(expanded);
        else frame = requestAnimationFrame(tick);
      }
      tick(started);
    }
    function animateTo(expanded, { restoreFocus = true } = {}) {
      if (destroyed || !canUse()) return false;
      const previous = gesture || settling;
      if (previous?.started && previous.key === getKey()) {
        previous.restoreFocus = restoreFocus;
        // Reverse the same measured surface; never measure a partial sheet as
        // its destination or allow an old animation to finish a replacement.
        settle(previous, expanded);
        return true;
      }
      if (previous) cancel({ restore: false });
      if (isOpen() === expanded) return true;
      const owner = { id: null, pointerDriven: false, wasOpen: isOpen(), key: getKey(), restoreFocus };
      gesture = owner;
      if (!begin(owner)) return false;
      settle(owner, expanded);
      return true;
    }
    function pointerDown(event) {
      if (!event.isPrimary || event.button !== 0 || !["touch", "pen"].includes(event.pointerType) || !canUse() || settling || gesture) return;
      const wasOpen = isOpen();
      let fromControl = false;
      if (wasOpen) {
        if (!panel.contains(event.target)) return;
        // Native text/range/select editing keeps its gesture. Ordinary buttons
        // remain clickable until a deliberate vertical drag claims the press.
        if (event.target.closest("input, a, select, textarea, label, [role='slider'], [role='spinbutton'], [contenteditable]:not([contenteditable='false'])")) return;
        fromControl = Boolean(event.target.closest("button, [role='button']") && !collapse.contains(event.target));
        // Any scrollable content ancestor owns its whole gesture, including
        // at the top edge. Never change an in-flight scroll into a sheet drag.
        for (let node = event.target; node && node !== panel; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
        }
      } else if (!dock.contains(event.target)) return;
      gesture = { id: event.pointerId, pointerDriven: true, wasOpen, x: event.clientX, y: event.clientY,
        key: getKey(), fromControl, started: false, progress: wasOpen ? 1 : 0, samples: [], lastAt: performance.now() };
    }
    function pointerMove(event) {
      const owner = gesture;
      if (!owner || owner.id !== event.pointerId) return;
      if (!event.isPrimary || owner.key !== getKey() || !canUse()) { cancel(); return; }
      const dx = event.clientX - owner.x, dy = event.clientY - owner.y;
      if (!owner.started) {
        if (Math.hypot(dx, dy) < (owner.fromControl ? 12 : 8)) return;
        if (Math.abs(dx) * (owner.fromControl ? 1.25 : 1) > Math.abs(dy) || (!owner.wasOpen && dy >= 0) || (owner.wasOpen && dy <= 0)) { cancel({ restore: false }); return; }
        if (!begin(owner)) return;
      }
      event.preventDefault();
      const upward = Math.max(0, -dy);
      const distance = variant === "slide" && !owner.wasOpen
        ? upward + Math.min(upward, owner.catchUp) : -dy;
      const progress = clamp((owner.wasOpen ? 1 : 0) + distance / owner.travel);
      const now = performance.now();
      owner.samples.push({ at: now, progress });
      owner.samples = owner.samples.filter(sample => now - sample.at <= 100).slice(-8);
      owner.lastAt = now;
      owner.pendingProgress = progress;
      schedulePaint(owner);
    }
    function pointerUp(event) {
      const owner = gesture;
      if (!owner || owner.id !== event.pointerId) return;
      if (!owner.started) { gesture = null; return; }
      event.preventDefault();
      suppressUntil = performance.now() + 700;
      paint(owner, owner.pendingProgress ?? owner.progress);
      const first = owner.samples[0], last = owner.samples.at(-1);
      const velocity = first && last && last.at > first.at && performance.now() - owner.lastAt < 100
        ? (last.progress - first.progress) * owner.travel * 1000 / (last.at - first.at) : 0;
      settle(owner, shouldExpand(owner.progress, velocity, owner.travel));
    }
    listen(dock, "pointerdown", pointerDown);
    listen(panel, "pointerdown", pointerDown);
    listen(document, "pointerdown", event => {
      suppressUntil = 0;
      if (!event.isPrimary && gesture) cancel();
    }, { capture: true });
    listen(document, "pointermove", pointerMove, { capture: true, passive: false });
    listen(document, "pointerup", pointerUp, { capture: true, passive: false });
    listen(document, "pointercancel", event => { if (gesture?.id === event.pointerId) cancel(); }, { capture: true });
    listen(document, "lostpointercapture", event => {
      if (event.target === document.documentElement && gesture?.started && gesture.id === event.pointerId) cancel();
    }, { capture: true });
    listen(document, "click", event => {
      if (event.detail !== 0 && performance.now() < suppressUntil && (dock.contains(event.target) || sheet.contains(event.target) || event.target === document.documentElement)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, { capture: true });
    listen(header, "contextmenu", event => { if (!event.target.closest("input, textarea")) event.preventDefault(); });
    listen(window, "resize", () => cancel());
    if (window.visualViewport) listen(window.visualViewport, "resize", () => cancel());
    listen(window, "blur", () => cancel());
    listen(window, "pagehide", () => cancel());
    listen(document, "visibilitychange", () => { if (document.hidden) cancel(); });
    return {
      get active() { return active(); }, cancel, animateTo,
      refresh() { if ((gesture || settling) && ((gesture || settling).key !== getKey() || !canUse())) cancel(); },
      destroy() { cancel(); destroyed = true; listeners.abort(); },
    };
  }
  globalThis.BilikaraPlaybackSheetGestures = Object.freeze({ create, shouldExpand });
})();
