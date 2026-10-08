// Experimental Host gesture. No local playlist mutation: one guarded Rust
// command both promotes the next song and retains the current request/cache.
(function (root) {
  "use strict";

  function identity(snapshot) {
    const item = snapshot?.current_item;
    const playlist = snapshot?.playlist || [];
    if (!item?.id || !item.item_incarnation_id || !playlist.length
      || !Number.isSafeInteger(snapshot.playback_generation) || snapshot.playback_generation < 1) return null;
    return {
      item_id: item.id,
      expected_item_incarnation_id: item.item_incarnation_id,
      playback_generation: snapshot.playback_generation,
      expected_playlist_item_ids: playlist.map(entry => entry.id),
    };
  }

  function mount({ handle, card, list, getSnapshot, submit, changed, failed, started }) {
    let gesture = null, pending = false, suppressClick = false, frame = 0;

    function paint() {
      list.querySelectorAll(".song-item").forEach(node => {
        const target = gesture?.moved && node.dataset.id === gesture.targetId;
        node.classList.toggle("defer-drop-before", Boolean(target && !gesture.after));
        node.classList.toggle("defer-drop-after", Boolean(target && gesture.after));
      });
      card.classList.toggle("defer-dragging", Boolean(gesture?.moved));
    }

    function cancel() {
      if (!gesture) return;
      const { pointerId, moved } = gesture;
      gesture = null;
      suppressClick = moved;
      cancelAnimationFrame(frame);
      frame = 0;
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      paint();
    }

    function sync() {
      const current = identity(getSnapshot());
      if (gesture && (JSON.stringify(current) !== JSON.stringify(gesture.identity)
        || !handle.getClientRects().length)) cancel();
      handle.disabled = pending || !current;
      if (pending) handle.setAttribute("aria-busy", "true");
      else handle.removeAttribute("aria-busy");
    }

    function targetAtPointer() {
      if (!gesture) return;
      const { x, y } = gesture;
      const rect = list.getBoundingClientRect();
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      const cards = [...list.querySelectorAll(".song-item")];
      const target = inside ? (cards.find(node => {
        const bounds = node.getBoundingClientRect();
        return y < bounds.bottom;
      }) || cards.at(-1)) : null;
      gesture.targetId = target?.dataset.id || "";
      gesture.after = Boolean(target && y >= target.getBoundingClientRect().top + target.offsetHeight / 2);
      paint();
    }

    function scrollFrame() {
      frame = 0;
      if (!gesture?.moved) return;
      const bounds = list.getBoundingClientRect();
      if (gesture.x >= bounds.left && gesture.x <= bounds.right
        && gesture.y >= bounds.top && gesture.y <= bounds.bottom) {
        const delta = gesture.y < bounds.top + 40 ? -8 : gesture.y > bounds.bottom - 40 ? 8 : 0;
        if (delta) list.scrollTop += delta;
      }
      targetAtPointer();
      frame = requestAnimationFrame(scrollFrame);
    }

    handle.addEventListener("dragstart", event => event.preventDefault());
    handle.addEventListener("contextmenu", event => event.preventDefault());
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.isPrimary === false || pending || gesture) return;
      const current = identity(getSnapshot());
      if (!current) return;
      gesture = { identity: current, pointerId: event.pointerId, startX: event.clientX,
        startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, targetId: "", after: false };
      suppressClick = false;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      if (!gesture.moved) {
        if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 6) return;
        gesture.moved = true;
        started?.();
        frame = requestAnimationFrame(scrollFrame);
      }
      event.preventDefault();
      targetAtPointer();
    });
    handle.addEventListener("pointerup", async event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      targetAtPointer();
      const drag = gesture;
      const unchanged = JSON.stringify(identity(getSnapshot())) === JSON.stringify(drag.identity);
      const hoverIndex = drag.identity.expected_playlist_item_ids.indexOf(drag.targetId);
      cancel();
      if (!drag.moved || !unchanged || hoverIndex < 0) { sync(); return; }
      // B is promoted, so a drop on either edge of B leaves A next after B.
      const payload = { ...drag.identity, index: Math.max(0, hoverIndex + Number(drag.after) - 1) };
      pending = true;
      sync();
      try {
        await submit(payload);
        changed?.();
      } catch (error) {
        failed?.(error);
      } finally {
        pending = false;
        sync();
      }
    });
    handle.addEventListener("click", event => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    document.addEventListener("visibilitychange", () => { if (document.hidden) cancel(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") cancel(); });
    sync();
    return { sync, cancel };
  }

  root.BilikaraQueueDefer = { mount };
})(typeof window === "undefined" ? globalThis : window);
