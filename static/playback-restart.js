// One shared, optional playback affordance. Existing controls and protocol own playback.
(() => {
  "use strict";

  async function restart({ context, isCurrent, post }) {
    const body = { item_id: context.itemId, playback_generation: context.generation, delta_seconds: 0 };
    if (!isCurrent()) throw new Error("stale");
    const seek = await post("/api/player/control", { ...body, action: "seek-absolute", target_seconds: 0 });
    if (!seek.commandApplied || !isCurrent()) throw new Error("stale");
    // Explicit play preserves pause/resume semantics and uses the existing ordered queue.
    // An uncertain/failed seek never submits play or retries either command.
    const play = await post("/api/player/control", { ...body, action: "play" });
    if (!play.commandApplied || !isCurrent()) throw new Error("stale");
  }

  // Reuse the rendered -15s arrow, including its arc, head, stroke and transform.
  // Only the central meaning changes from "15" to play; Host/Remote stay aligned.
  function createRestartIcon(anchor) {
    const source = anchor.querySelector("svg");
    if (!source) return null;
    const icon = source.cloneNode(true);
    icon.querySelectorAll("text").forEach(node => node.remove());
    icon.querySelector("path")?.setAttribute("data-restart-ring", "");
    const play = document.createElementNS("http://www.w3.org/2000/svg", "path");
    play.setAttribute("d", "m10.25 8.5 5.25 3.5-5.25 3.5z");
    play.setAttribute("fill", "currentColor");
    icon.append(play);
    return icon;
  }

  function firstUseStore(surface, invoke = null) {
    if (surface === "host" && invoke) return {
      read: async () => {
        const seen = await invoke("get_playback_restart_hint_seen");
        if (typeof seen !== "boolean") throw new Error("hint_unavailable");
        return seen;
      },
      mark: () => invoke("mark_playback_restart_hint_seen"),
    };
    const key = `bilikara.ui.playback-restart-seen.${surface}.v1`;
    return {
      read: () => { try { return window.localStorage.getItem(key) === "true"; } catch { return false; } },
      mark: () => { try { window.localStorage.setItem(key, "true"); } catch { /* Once per page if storage is unavailable. */ } },
    };
  }

  function create({ anchor, iconSource, getContext, label, onRestart, onBusy, onError,
    firstUse = null, canShowHint = () => true, alwaysInline = false, hoverHints = false, extraHintControls = [] }) {
    if (!anchor || !iconSource) return null;
    const icon = createRestartIcon(iconSource);
    if (!icon) return null;
    const landscape = window.matchMedia("(orientation: landscape)");
    const expanded = () => alwaysInline || landscape.matches;
    const group = document.createElement("div");
    group.className = "playback-song-actions";
    const inlineAction = document.createElement("button");
    inlineAction.type = "button";
    inlineAction.className = "playback-restart-action";
    inlineAction.append(icon.cloneNode(true));
    anchor.before(group);
    // Preserve the original Next node, its application handlers and command guard.
    group.append(inlineAction, anchor);
    const popup = document.createElement("div");
    popup.className = "playback-restart-popover";
    popup.id = `${anchor.id || "playback-next"}-restart-menu`;
    popup.setAttribute("role", "menu");
    popup.hidden = true;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "playback-restart-action";
    action.setAttribute("role", "menuitem");
    action.append(icon);
    // Keep the original Next above the capsule in the same stacking context.
    // A top-layer popup with a masked hole can intermittently erase the button
    // underneath its animated backdrop, even when computed opacity stays 1.
    popup.append(action);
    group.prepend(popup);
    anchor.dataset.playbackRestartAnchor = "";
    const controls = anchor.closest(".player-control-row, .presentation-host-transport-row") || group;
    const hintRoots = [controls, ...extraHintControls.map(entry => entry.button).filter(Boolean)];
    const controlSelector = "button.player-transport-button, button.presentation-host-seek-button, button.presentation-host-play, button.presentation-host-next, button.playback-restart-action";
    const bubble = document.createElement("div");
    bubble.id = `${popup.id}-hint`;
    bubble.className = "remote-tooltip-bubble playback-control-hint";
    bubble.setAttribute("role", "tooltip");
    bubble.setAttribute("popover", "manual");
    bubble.hidden = true;
    document.body.append(bubble);

    let captured = null, hold = null, hideTimer = null, hoverTimer = null, busy = false, suppressUntil = 0, cancelledPointerId = null;
    let destroyed = false, hintRead = !firstUse, hintSeen = !firstUse, hintDone = false, hintMarked = false;
    let hintTimer = null, hintActive = false, hintKey = null, hintSequence = 0, lastInput = -Infinity;
    let swallowHintClick = false;
    let hintAnchor = null, controlHintVisible = false, controlHintSequence = 0;
    const listeners = new AbortController();
    const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: listeners.signal });
    const current = () => captured && getContext()?.key === captured.key;
    const hintControl = node => {
      const extra = extraHintControls.find(entry => entry.button?.contains(node));
      const button = extra?.button || node?.closest?.(controlSelector);
      return button && (extra || controls.contains(button)) && button.querySelector("svg") ? button : null;
    };
    const hintControlEnabled = button => button && !button.disabled && button.getClientRects().length
      && !button.closest("[hidden], [inert], .hidden") && canShowHint()
      && extraHintControls.find(entry => entry.button === button)?.enabled?.() !== false;
    function unlinkControlHint() {
      if (!hintAnchor) return;
      const ids = (hintAnchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== bubble.id);
      if (ids.length) hintAnchor.setAttribute("aria-describedby", ids.join(" "));
      else hintAnchor.removeAttribute("aria-describedby");
      hintAnchor = null;
    }
    function hideControlHint(immediate = false) {
      if (bubble.hidden) return;
      const closing = ++controlHintSequence;
      controlHintVisible = false;
      bubble.classList.remove("is-visible");
      bubble.classList.add("is-closing");
      bubble.setAttribute("aria-hidden", "true");
      const finish = () => {
        if (controlHintSequence !== closing || controlHintVisible) return;
        if (bubble.hidePopover && bubble.matches(":popover-open")) bubble.hidePopover();
        bubble.hidden = true;
        bubble.classList.remove("is-closing");
        unlinkControlHint();
      };
      if (immediate) finish();
      else Promise.allSettled(bubble.getAnimations().map(animation => animation.finished)).then(finish);
    }
    function positionControlHint() {
      if (!hintAnchor || bubble.hidden) return;
      const viewport = window.visualViewport, gap = 7, inset = 8;
      const leftEdge = (viewport?.offsetLeft || 0) + inset, topEdge = (viewport?.offsetTop || 0) + inset;
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 2 * inset;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 2 * inset;
      bubble.style.maxWidth = `${Math.min(320, rightEdge - leftEdge)}px`;
      const bounds = hintAnchor.getBoundingClientRect(), size = bubble.getBoundingClientRect();
      const { width, height } = size;
      const center = bounds.left + bounds.width / 2;
      const left = Math.max(leftEdge, Math.min(center - width / 2, rightEdge - width));
      const above = bounds.top - topEdge - gap, below = bottomEdge - bounds.bottom - gap;
      const direction = above >= height || above >= below ? "up" : "down";
      const top = direction === "up" ? bounds.top - height - gap : bounds.bottom + gap;
      bubble.dataset.tooltipDirection = direction;
      // Keep fractional text widths inside the inset, including the 3px
      // entry/exit translation. Integer layout sizes can push the right edge out.
      bubble.style.left = `${left}px`;
      bubble.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height - 3))}px`;
      bubble.style.setProperty("--remote-tooltip-arrow-left", `${Math.max(10, Math.min(width - 10, center - left)) - 6}px`);
    }
    function showControlHint(button) {
      if (!hintControlEnabled(button)) { hideControlHint(); return; }
      const copy = button === anchor && !expanded() && getContext()?.enabled
        ? label("player.nextSongGestureHint")
        : button.classList.contains("playback-restart-action")
          ? `${label("player.restart")}\n${label("player.restartDescription")}`
          : button.getAttribute("aria-label");
      if (!copy) { hideControlHint(); return; }
      const changed = hintAnchor !== button || bubble.textContent !== copy || !controlHintVisible;
      if (!changed) return;
      ++controlHintSequence;
      unlinkControlHint();
      hintAnchor = button;
      const ids = (button.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      button.setAttribute("aria-describedby", [...new Set([...ids, bubble.id])].join(" "));
      bubble.textContent = copy;
      bubble.removeAttribute("aria-hidden");
      bubble.hidden = false;
      bubble.classList.add("is-closing");
      if (bubble.showPopover && !bubble.matches(":popover-open")) bubble.showPopover();
      positionControlHint();
      void getComputedStyle(bubble).opacity;
      controlHintVisible = true;
      bubble.classList.remove("is-closing");
      bubble.classList.add("is-visible");
    }
    function markHint() {
      hintSeen = hintDone = true;
      if (!firstUse || hintMarked) return;
      hintMarked = true;
      Promise.resolve().then(() => firstUse.mark()).catch(() => {});
    }
    function cancelHint({ interrupted = false } = {}) {
      hintSequence += 1;
      window.clearTimeout(hintTimer);
      hintTimer = null;
      if (!hintActive) return;
      if (interrupted) hintDone = true;
      hintActive = false;
      hintKey = null;
      popup.classList.remove("is-open", "is-closing", "is-hint", "is-hint-open");
      popup.removeAttribute("aria-hidden");
      popup.inert = false;
      action.disabled = busy || anchor.disabled || !getContext()?.enabled;
      if (!captured) {
        popup.hidden = true;
      }
    }
    function hintEligible() {
      return !destroyed && hintRead && !hintSeen && !hintDone && !expanded() && !document.hidden
        && !busy && !captured && !hold && !anchor.disabled && document.activeElement !== anchor && getContext()?.enabled
        && anchor.getClientRects().length > 0 && !anchor.closest("[inert]") && canShowHint();
    }
    function positionPopup() {
      const bounds = anchor.getBoundingClientRect(), width = popup.offsetWidth, height = popup.offsetHeight;
      const targetInset = (height - bounds.height) / 2;
      const parent = group.getBoundingClientRect();
      // The right target stays over Next; only the restart target expands left.
      popup.style.left = `${bounds.right + targetInset - width - parent.left}px`;
      popup.style.top = `${bounds.top - targetInset - parent.top}px`;
    }
    function scheduleHint() {
      if (hintActive) {
        if (!hintEligible() || hintKey !== getContext()?.key) cancelHint({ interrupted: true });
        return;
      }
      if (!hintEligible()) { cancelHint(); return; }
      if (hintTimer !== null) return;
      const sequence = ++hintSequence, key = getContext()?.key;
      hintTimer = window.setTimeout(() => {
        hintTimer = null;
        if (sequence !== hintSequence || !hintEligible() || key !== getContext()?.key) return;
        if (hideTimer !== null) window.clearTimeout(hideTimer);
        hideTimer = null;
        hintActive = true;
        hintKey = key;
        popup.classList.add("is-hint");
        popup.classList.remove("is-closing");
        popup.classList.remove("is-held-open");
        action.disabled = true;
        popup.setAttribute("aria-hidden", "true");
        popup.hidden = false;
        positionPopup();
        window.requestAnimationFrame(() => {
          if (sequence !== hintSequence || !hintActive) return;
          popup.classList.add("is-open", "is-hint-open");
          hintTimer = window.setTimeout(() => {
            if (sequence !== hintSequence) return;
            popup.classList.remove("is-open", "is-hint-open");
            popup.classList.add("is-closing");
            hintTimer = window.setTimeout(() => {
              if (sequence !== hintSequence) return;
              markHint();
              cancelHint();
            }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
          }, 1400);
        });
      }, Math.max(700, 900 - (performance.now() - lastInput)));
    }
    const clearHold = ({ cancel = false } = {}) => {
      action.classList.remove("is-held-target");
      if (hold) {
        if (cancel) cancelledPointerId = hold.id;
        window.clearTimeout(hold.timer);
        if (hold.fired) {
          try { if (document.documentElement.hasPointerCapture(hold.id)) document.documentElement.releasePointerCapture(hold.id); } catch { /* Retired pointer. */ }
        }
      }
      hold = null;
      hideControlHint();
    };
    const finishClose = () => {
      if (captured) return;
      hideTimer = null;
      popup.hidden = true;
      popup.classList.remove("is-closing");
    };
    function close({ focus = false, immediate = false } = {}) {
      window.clearTimeout(hoverTimer);
      cancelHint({ interrupted: true });
      clearHold({ cancel: true });
      if (immediate) hideControlHint(true);
      captured = null;
      popup.classList.remove("is-open");
      if (!popup.hidden && !immediate) popup.classList.add("is-closing");
      if (expanded()) anchor.removeAttribute("aria-expanded");
      else anchor.setAttribute("aria-expanded", "false");
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      if (immediate) finishClose();
      else hideTimer = window.setTimeout(finishClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
      if (focus && anchor.isConnected && !anchor.disabled) anchor.focus({ preventScroll: true });
    }
    function refresh() {
      if (destroyed) return;
      group.classList.toggle("is-expanded", expanded());
      inlineAction.hidden = !expanded();
      for (const button of [action, inlineAction]) {
        button.setAttribute("aria-label", label("player.restart"));
        button.setAttribute("aria-description", label("player.restartDescription"));
        button.disabled = (button === action && hintActive) || busy || anchor.disabled || !getContext()?.enabled;
      }
      if (expanded()) {
        anchor.removeAttribute("aria-haspopup");
        anchor.removeAttribute("aria-controls");
        anchor.removeAttribute("aria-expanded");
        anchor.removeAttribute("aria-description");
      } else {
        anchor.setAttribute("aria-haspopup", "menu");
        anchor.setAttribute("aria-controls", popup.id);
        anchor.setAttribute("aria-expanded", String(Boolean(captured)));
        anchor.setAttribute("aria-description", label("player.restartHint"));
      }
      if (hold && (hold.key !== getContext()?.key || !hintControlEnabled(hold.button))) clearHold({ cancel: true });
      if (controlHintVisible) showControlHint(hintAnchor);
      if (captured && (!current() || anchor.disabled || !anchor.getClientRects().length)) close({ immediate: true });
      scheduleHint();
    }
    function open(keyboard = false, held = false) {
      const context = getContext();
      // Opening is presentation only; readiness continues to guard the action.
      if (expanded() || busy || anchor.disabled || !context?.itemId || !anchor.getClientRects().length) return;
      cancelHint();
      markHint();
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
      captured = context;
      refresh();
      popup.classList.remove("is-closing");
      popup.classList.toggle("is-held-open", held);
      popup.hidden = false;
      positionPopup();
      void getComputedStyle(popup, "::before").clipPath;
      popup.classList.add("is-open");
      anchor.setAttribute("aria-expanded", "true");
      if (keyboard) (action.disabled ? anchor : action).focus({ preventScroll: true });
    }
    for (const root of hintRoots) listen(root, "pointerdown", event => {
      if (!event.isPrimary || event.button !== 0) return;
      const button = hintControl(event.target);
      if (!hintControlEnabled(button)) return;
      clearHold();
      cancelledPointerId = null;
      suppressUntil = 0;
      if (busy) return;
      const gesture = { id: event.pointerId, button, key: getContext()?.key, x: event.clientX, y: event.clientY, fired: false, timer: null };
      gesture.timer = window.setTimeout(() => {
        if (hold !== gesture) return;
        if (gesture.key !== getContext()?.key || !hintControlEnabled(button)) { clearHold({ cancel: true }); return; }
        gesture.fired = true;
        try { document.documentElement.setPointerCapture(gesture.id); } catch { /* Document listeners also own the hold. */ }
        if (button === anchor && !expanded()) {
          open(false, true);
          gesture.target = action.getBoundingClientRect();
        }
        showControlHint(button);
      }, 500);
      hold = gesture;
    });
    listen(document, "pointermove", event => {
      if (!hold || hold.id !== event.pointerId) return;
      if (hold.fired) {
        event.preventDefault();
        const over = hintControl(document.elementFromPoint(event.clientX, event.clientY));
        showControlHint(over);
        const target = hold.target;
        const armed = current() && !action.disabled && over === action && target && event.clientX >= target.left && event.clientX <= target.right
          && event.clientY >= target.top && event.clientY <= target.bottom
          && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >= 6;
        hold.armed = Boolean(armed);
        action.classList.toggle("is-held-target", hold.armed);
        return;
      }
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) {
        suppressUntil = performance.now() + 1000;
        clearHold({ cancel: true });
      }
    }, { capture: true, passive: false });
    listen(document, "pointerup", event => {
      if (cancelledPointerId === event.pointerId) {
        cancelledPointerId = null;
        suppressUntil = performance.now() + 1000;
        swallowHintClick = true;
        event.preventDefault();
        return;
      }
      if (hold?.id !== event.pointerId) return;
      const context = hold.armed && current() && hintControl(document.elementFromPoint(event.clientX, event.clientY)) === action ? captured : null;
      if (hold.fired) { suppressUntil = performance.now() + 1000; swallowHintClick = true; event.preventDefault(); }
      clearHold();
      if (context) activate(action, context);
    }, { capture: true });
    // Native range controls also react to touchstart, independently of the
    // pointer/click sequence (including the capsule's clipped entry frame).
    listen(document, "touchstart", event => {
      if (swallowHintClick) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { capture: true, passive: false });
    listen(document, "pointercancel", () => { suppressUntil = performance.now() + 1000; close(); }, { capture: true });
    listen(anchor, "click", event => {
      if (event.detail !== 0 && performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
      else close();
    }, { capture: true });
    for (const root of hintRoots) listen(root, "contextmenu", event => {
      if (hintControl(event.target) && (hold || event.pointerType === "touch")) event.preventDefault();
    });
    listen(anchor, "contextmenu", event => { event.preventDefault(); if (!hold?.fired) open(); });
    listen(anchor, "keydown", event => {
      if (["ArrowLeft", "ArrowUp", "ArrowDown", "ContextMenu"].includes(event.key) || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault(); open(true);
      }
    });
    listen(document, "keydown", event => {
      if (!captured) return;
      if (["Enter", " "].includes(event.key) && (popup.contains(event.target) || anchor.contains(event.target))) popup.classList.remove("is-held-open");
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close({ focus: true }); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && (popup.contains(event.target) || anchor.contains(event.target))) {
        event.preventDefault(); (document.activeElement === action ? anchor : action).focus();
      } else if (event.key === "Tab") close();
    }, { capture: true });
    listen(document, "pointerdown", event => {
      swallowHintClick = false;
      if (!event.isPrimary && hold) {
        close({ immediate: true });
        return;
      }
      if (captured && !action.contains(event.target) && !anchor.contains(event.target)) {
        if (popup.contains(event.target)) {
          swallowHintClick = true;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        close();
      }
      if (hintActive && anchor.contains(event.target)) {
        lastInput = performance.now();
        open();
        return;
      }
      if (hintActive) {
        const bounds = action.getBoundingClientRect();
        // The passive extra icon overlaps seek on small screens. Dismiss its
        // first touch without letting that touch operate the covered control.
        if (event.clientX >= bounds.left && event.clientX <= bounds.right
          && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
          swallowHintClick = true;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
      lastInput = performance.now();
      cancelHint({ interrupted: true });
    }, { capture: true });
    listen(document, "pointerup", event => {
      if (swallowHintClick) event.preventDefault();
      window.requestAnimationFrame(refresh);
    }, { capture: true });
    listen(document, "click", event => {
      if (swallowHintClick && event.detail !== 0) {
        swallowHintClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
    listen(document, "keydown", () => { lastInput = performance.now(); cancelHint({ interrupted: true }); clearHold({ cancel: true }); }, { capture: true });
    // Suppress the hold's compatibility click, but allow a fresh deliberate tap.
    listen(document, "pointerdown", event => {
      if (popup.contains(event.target)) {
        suppressUntil = 0;
        popup.classList.remove("is-held-open");
      }
    }, { capture: true });
    listen(popup, "click", event => {
      if (event.detail !== 0 && performance.now() < suppressUntil) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, { capture: true });
    listen(document, "scroll", () => close(), { capture: true });
    listen(window, "resize", () => { close({ immediate: true }); refresh(); });
    listen(landscape, "change", () => { close({ immediate: true }); refresh(); });
    listen(window, "blur", () => close({ immediate: true }));
    listen(document, "fullscreenchange", () => close({ immediate: true }));
    listen(document.fonts, "loadingdone", () => { if (controlHintVisible) positionControlHint(); });
    listen(document, "visibilitychange", () => {
      if (document.hidden) close({ immediate: true });
      else refresh();
    });
    listen(window, "focus", refresh);
    const activate = async (button, context) => {
      if (busy || !context || context.key !== getContext()?.key || !getContext()?.enabled || anchor.disabled) { close({ immediate: true }); return; }
      busy = true;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      close();
      try { onBusy?.(true); await onRestart(context); }
      catch (error) { onError(error); }
      finally { busy = false; button.removeAttribute("aria-busy"); onBusy?.(false); refresh(); }
    };
    listen(action, "click", () => activate(action, captured));
    listen(inlineAction, "click", () => activate(inlineAction, getContext()));
    if (hoverHints) for (const button of [action, inlineAction, ...extraHintControls.map(entry => entry.button).filter(Boolean)]) {
      listen(button, "pointerenter", event => {
        if (event.pointerType !== "mouse" || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
        window.clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(() => showControlHint(button), 160);
      });
      listen(button, "pointerleave", () => { window.clearTimeout(hoverTimer); if (!hold?.fired) hideControlHint(); });
      listen(button, "focus", () => { if (button.matches(":focus-visible")) showControlHint(button); });
      listen(button, "blur", () => { if (!hold?.fired) hideControlHint(); });
    }
    if (firstUse) Promise.resolve().then(() => firstUse.read()).then(seen => {
      hintRead = true;
      if (!hintSeen) hintSeen = seen === true;
      refresh();
    }).catch(() => { hintRead = hintSeen = true; });
    refresh();
    return { refresh, close, destroy() { destroyed = true; window.clearTimeout(hoverTimer); close({ immediate: true }); listeners.abort(); popup.remove(); bubble.remove(); group.before(anchor); group.remove(); anchor.removeAttribute("data-playback-restart-anchor"); anchor.removeAttribute("aria-haspopup"); anchor.removeAttribute("aria-controls"); anchor.removeAttribute("aria-expanded"); anchor.removeAttribute("aria-description"); } };
  }

  globalThis.BilikaraPlaybackRestart = Object.freeze({ create, restart, firstUseStore });
})();
