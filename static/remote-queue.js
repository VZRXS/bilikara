(function enhanceRemoteQueue() {
  if (
    typeof state === "undefined"
    || typeof elements === "undefined"
    || typeof apiPost !== "function"
    || typeof setFormMessage !== "function"
  ) {
    return;
  }

  // Queue/history own bounded scroll regions; unlike request cards they do
  // not use document scrolling. Reserve a gap only while they overflow.
  if (typeof ResizeObserver === "function" && typeof MutationObserver === "function") {
    for (const list of [elements.queueList, elements.historyList]) {
      if (!list) continue;
      let frame = 0;
      const measure = () => {
        frame = 0;
        if (list.clientHeight > 0) list.classList.toggle("has-scroll-inset", list.scrollHeight > list.clientHeight + 1);
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
      new ResizeObserver(schedule).observe(list);
      new MutationObserver(records => {
        if (records.some(record => record.target === list
          || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1))) schedule();
      }).observe(list, { childList: true, subtree: true });
      document.fonts?.ready.then(schedule);
      schedule();
    }
  }

  state.dragItemId = "";
  state.dragTargetId = "";
  state.dragTargetAfter = false;
  state.dragPointerId = null;
  state.dragMoved = false;

  // A queue rerender replaces buttons while their requests may still be in
  // flight. Keep admission by logical action, and restore every painted button.
  const pendingQueueActions = new Map();

  function queueActionKey(action, itemId) {
    return JSON.stringify([state.data?.state_epoch, action, itemId]);
  }

  function syncQueueActionBusy(button, buttons = pendingQueueActions.get(
    queueActionKey(button.dataset.action, button.dataset.id),
  )) {
    if (!buttons) {
      return;
    }
    if (!buttons.has(button)) {
      buttons.set(button, button.disabled);
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }

  const dragScrollThresholdPx = 56;
  const dragScrollStepPx = 18;
  const dragActivationDistancePx = 6;
  let dragStartX = 0;
  let dragStartY = 0;
  let suppressDragClick = false;

  const dragHandleRestoreDelayMs = 5000;
  let activeDragHandleId = "";
  let dragHandleRestoreTimer = null;

  function clearDragHandleRestoreTimer() {
    if (dragHandleRestoreTimer !== null) {
      window.clearTimeout(dragHandleRestoreTimer);
      dragHandleRestoreTimer = null;
    }
  }

  function syncQueueDragHandles() {
    elements.queueList.querySelectorAll("[data-drag-handle]").forEach((handle) => {
      handle.classList.toggle("is-drag-ready", Boolean(activeDragHandleId)
        && handle.closest(".queue-item")?.dataset.id === activeDragHandleId);
    });
  }

  function restoreQueueDragHandle() {
    clearDragHandleRestoreTimer();
    const handle = elements.queueList.querySelector("[data-drag-handle].is-drag-ready");
    if (handle?.getAttribute("aria-expanded") === "true") {
      hideRemoteContextualInfo(handle.closest(".info-trigger-wrap"));
    }
    activeDragHandleId = "";
    syncQueueDragHandles();
  }

  function scheduleDragHandleRestore() {
    clearDragHandleRestoreTimer();
    if (!activeDragHandleId || state.dragItemId) return;
    dragHandleRestoreTimer = window.setTimeout(restoreQueueDragHandle, dragHandleRestoreDelayMs);
  }

  function activateQueueDragHandle(itemId) {
    activeDragHandleId = itemId;
    syncQueueDragHandles();
    scheduleDragHandleRestore();
  }

  let renderedQueue = [];
  let renderedQueueVersion = "";
  let dragQueue = null;

  renderQueue = function renderQueueWithActions(playlist) {
    if (state.dragItemId) {
      syncDropIndicators();
      return;
    }

    renderedQueue = playlist;
    renderedQueueVersion = state.data?.queue_version || "";
    if (activeDragHandleId && !playlist.some((item) => item.id === activeDragHandleId)) {
      restoreQueueDragHandle();
    }
    const signature = JSON.stringify({
      language: state.language,
      hasCurrentItem: Boolean(state.data?.current_item),
      playlist: playlist.map(queueRenderSignatureForItem),
    });
    if (signature === state.queueRenderSignature) {
      renderQueueCacheStatus(playlist);
      elements.queueList.querySelectorAll("button[data-action]").forEach((button) => {
        syncQueueActionBusy(button);
      });
      syncQueueDragHandles();
      return;
    }
    state.queueRenderSignature = signature;

    elements.queueList.replaceChildren();
    if (!playlist.length) {
      if (typeof createQueueEmptyNode === "function" && typeof t === "function") {
        elements.queueList.appendChild(createQueueEmptyNode());
      } else {
        const emptyNode = document.createElement("div");
        emptyNode.className = "queue-empty";
        emptyNode.textContent = typeof t === "function" ? t("list.emptyTitle") : "list.emptyTitle";
        elements.queueList.appendChild(emptyNode);
      }
      return;
    }

    playlist.forEach((item, index) => {
      const node = elements.queueItemTemplate.content.firstElementChild.cloneNode(true);
      if (typeof applyStaticI18n === "function") {
        applyStaticI18n(node);
      }
      node.dataset.id = item.id;
      node.classList.toggle("ready", item.cache_status === "ready");
      const orderNode = node.querySelector(".queue-order");
      if (orderNode) {
        orderNode.textContent = String(index + 1);
      }
      node.querySelector(".queue-title").textContent = item.display_title;
      const requesterNode = node.querySelector(".queue-requester");
      const requesterText = typeof requesterBadgeText === "function"
        ? requesterBadgeText(item.requester_name)
        : String(item.requester_name || "").trim();
      if (requesterNode) {
        requesterNode.textContent = requesterText;
        requesterNode.classList.toggle("hidden", !requesterText);
      }
      const noteNode = node.querySelector(".queue-note");
      const noteText = typeof queueNoteText === "function"
        ? queueNoteText(item)
        : String(item.cache_message || "").trim();
      noteNode.textContent = noteText;
      noteNode.classList.toggle("hidden", !noteText);
      node.querySelector(".queue-main").classList.toggle("is-compact", !noteText);
      node.querySelector(".queue-state").textContent = queueStateLabel(item);
      if (typeof syncQueueItemRetryButton === "function") {
        syncQueueItemRetryButton(node, item);
      }
      node.querySelectorAll("button[data-action]").forEach((button) => {
        button.dataset.id = item.id;
        if (button.dataset.action === "retry-cache") {
          button.dataset.itemIncarnationId = item.item_incarnation_id;
        }
        syncQueueActionBusy(button);
      });
      if (state.openQueueMenuId === item.id) {
        const menu = node.querySelector(".menu-content");
        if (menu) {
          menu.classList.remove("hidden");
          menu.classList.add("no-animate");
        }
      }
      elements.queueList.appendChild(node);
    });
    syncQueueDragHandles();
  };

  function clearDropIndicators() {
    elements.queueList.querySelectorAll(".queue-item").forEach((node) => {
      node.classList.remove("dragging", "drop-before", "drop-after");
    });
  }

  function clearDragState() {
    state.dragItemId = "";
    state.dragTargetId = "";
    state.dragTargetAfter = false;
    state.dragPointerId = null;
    state.dragMoved = false;
    elements.queueList.classList.remove("drag-active");
    clearDropIndicators();
  }

  function escapeSelector(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replaceAll('"', '\\"');
  }

  function syncDropIndicators() {
    clearDropIndicators();
    if (!state.dragItemId || !state.dragMoved) {
      return;
    }

    const draggingNode = elements.queueList.querySelector(
      `.queue-item[data-id="${escapeSelector(state.dragItemId)}"]`,
    );
    if (draggingNode) {
      draggingNode.classList.add("dragging");
    }

    if (state.dragTargetId) {
      const targetNode = elements.queueList.querySelector(
        `.queue-item[data-id="${escapeSelector(state.dragTargetId)}"]`,
      );
      if (targetNode) {
        targetNode.classList.add(state.dragTargetAfter ? "drop-after" : "drop-before");
      }
    }
  }

  function updateDragTarget(clientX, clientY) {
    const targetItem = document.elementFromPoint(clientX, clientY)?.closest(".queue-item");
    if (!targetItem || targetItem.dataset.id === state.dragItemId) {
      state.dragTargetId = "";
      state.dragTargetAfter = false;
      syncDropIndicators();
      return;
    }

    const rect = targetItem.getBoundingClientRect();
    state.dragTargetId = targetItem.dataset.id || "";
    state.dragTargetAfter = clientY >= rect.top + rect.height / 2;
    syncDropIndicators();
  }

  function maybeAutoScrollQueue(clientY) {
    const rect = elements.queueList.getBoundingClientRect();
    if (clientY < rect.top + dragScrollThresholdPx) {
      elements.queueList.scrollTop -= dragScrollStepPx;
      return;
    }
    if (clientY > rect.bottom - dragScrollThresholdPx) {
      elements.queueList.scrollTop += dragScrollStepPx;
    }
  }

  function reorderTargetIndex(playlist, draggedId) {
    const sourceIndex = playlist.findIndex((item) => item.id === draggedId);
    if (sourceIndex === -1) {
      return -1;
    }
    if (!state.dragMoved || !state.dragTargetId) {
      return sourceIndex;
    }

    let targetIndex = playlist.length - 1;
    const hoverIndex = playlist.findIndex((item) => item.id === state.dragTargetId);
    if (hoverIndex !== -1) {
      targetIndex = hoverIndex + (state.dragTargetAfter ? 1 : 0);
      if (sourceIndex < targetIndex) {
        targetIndex -= 1;
      }
    }

    return Math.max(0, Math.min(targetIndex, playlist.length - 1));
  }

  async function reorderQueue(itemId, index, queueVersion) {
    applyStateSnapshot(await apiPost("/api/playlist/reorder", { item_id: itemId, index, expected_queue_version: queueVersion }), { forceRender: true });
    setFormMessage(typeof t === "function" ? t("remote.queueOrderUpdated") : "remote.queueOrderUpdated");
    render();
  }

  async function handleQueueAction(action, itemId, itemIncarnationId, button = null) {
    if (!itemId) {
      return;
    }
    if (action === "retry-cache" && !itemIncarnationId) {
      return;
    }

    const actionMap = {
      remove: {
        url: "/api/playlist/remove",
        payload: { item_id: itemId },
        message: typeof t === "function" ? t("list.removedSong") : "list.removedSong",
      },
      "move-next": {
        url: "/api/playlist/move-next",
        payload: { item_id: itemId },
        message: typeof t === "function" ? t("remote.movedNext") : "remote.movedNext",
      },
      "play-now": {
        url: "/api/playlist/play-now",
        payload: { item_id: itemId },
        message: typeof t === "function" ? t("remote.playNowSuccess") : "remote.playNowSuccess",
      },
      "retry-cache": {
        url: "/api/cache/retry",
        payload: {
          item_id: itemId,
          expected_item_incarnation_id: itemIncarnationId,
          force: true,
        },
        message: typeof t === "function" ? t("cache.retryStarted") : "cache.retryStarted",
      },
    };

    const target = actionMap[action];
    if (!target) {
      return;
    }

    const actionKey = queueActionKey(action, itemId);
    if (pendingQueueActions.has(actionKey) || button?.getAttribute("aria-busy") === "true") {
      return;
    }

    if (action === "remove" && !window.confirm(typeof t === "function" ? t("list.removeConfirm") : "list.removeConfirm")) {
      return;
    }

    if (action === "retry-cache") {
      const confirmText = typeof t === "function" ? t("cache.retryConfirm") : "确定要重新缓存吗？";
      if (!window.confirm(confirmText)) {
        return;
      }
    }

    const busyButtons = new Map();
    pendingQueueActions.set(actionKey, busyButtons);
    if (button) {
      syncQueueActionBusy(button, busyButtons);
    }
    try {
      if (action === "retry-cache") {
        const outcome = await apiPostExactStateCommand(target.url, target.payload);
        render();
        if (outcome.commandApplied) {
          setFormMessage(target.message);
        }
        return;
      }
      applyStateSnapshot(await apiPost(target.url, target.payload), { forceRender: true });
      setFormMessage(target.message);
      render();
    } catch (error) {
      setFormMessage(error.message, true);
    } finally {
      pendingQueueActions.delete(actionKey);
      busyButtons.forEach((originallyDisabled, busyButton) => {
        busyButton.disabled = originallyDisabled;
        busyButton.removeAttribute("aria-busy");
      });
    }
  }

  function beginDrag(handle, event) {
    if (state.listView !== "queue") {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const item = handle.closest(".queue-item");
    if (!item) {
      return;
    }

    clearDragHandleRestoreTimer();
    // Touch already has touch-action:none and selection/callout suppression.
    // Cancelling its pointerdown also suppresses the tap's click on WebKit.
    if (event.pointerType !== "touch") event.preventDefault();
    state.dragItemId = item.dataset.id || "";
    dragQueue = { playlist: renderedQueue, version: renderedQueueVersion };
    state.dragTargetId = "";
    state.dragTargetAfter = false;
    state.dragPointerId = event.pointerId;
    state.dragMoved = false;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    suppressDragClick = false;
    handle.setPointerCapture?.(event.pointerId);
  }

  async function finishDrag(pointerId) {
    if (!state.dragItemId || state.dragPointerId !== pointerId) {
      return;
    }

    const draggedId = state.dragItemId;
    const playlist = dragQueue?.playlist || [];
    const queueVersion = dragQueue?.version || "";
    const sourceIndex = playlist.findIndex((item) => item.id === draggedId);
    const targetIndex = reorderTargetIndex(playlist, draggedId);
    suppressDragClick = state.dragMoved;
    clearDragState();
    scheduleDragHandleRestore();

    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      render();
      return;
    }

    const draggedItem = playlist[sourceIndex];
    if (typeof openReorderConfirmSheet === "function") {
      openReorderConfirmSheet({
        itemId: draggedId,
        targetIndex,
        queueVersion,
        title: draggedItem?.display_title || "",
      });
      render();
      return;
    }

    try {
      await reorderQueue(draggedId, targetIndex, queueVersion);
    } catch (error) {
      setFormMessage(error.message, true);
    }
  }

  const resetQueueDragFeedback = () => {
    clearDragState();
    restoreQueueDragHandle();
  };
  elements.queueViewButton.addEventListener("click", resetQueueDragFeedback);
  elements.historyViewButton.addEventListener("click", resetQueueDragFeedback);

  document.addEventListener("click", (event) => {
    if (activeDragHandleId && !event.target.closest("[data-drag-handle]")) {
      restoreQueueDragHandle();
    }
  });

  elements.queueList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "toggle-menu") {
      const wrap = button.closest(".queue-actions-wrap");
      const content = wrap?.querySelector(".menu-content");
      if (content) {
        const isHidden = content.classList.contains("hidden");
        if (typeof closeOpenMenus === "function") {
          closeOpenMenus();
        } else {
          document.querySelectorAll(".menu-content").forEach((el) => el.classList.add("hidden"));
          state.openQueueMenuId = null;
        }
        if (isHidden) {
          content.classList.remove("hidden");
          content.classList.remove("no-animate");
          state.openQueueMenuId = button.dataset.id;
        }
      }
      return;
    }

    if (button.dataset.action === "play-now" || button.dataset.action === "move-next") {
      if (typeof closeOpenMenus === "function") {
        closeOpenMenus();
      } else {
        document.querySelectorAll(".menu-content").forEach((el) => el.classList.add("hidden"));
        state.openQueueMenuId = null;
      }
    }
    await handleQueueAction(
      button.dataset.action,
      button.dataset.id,
      button.dataset.itemIncarnationId,
      button,
    );
  });

  elements.queueList.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) {
      return;
    }
    beginDrag(handle, event);
  });

  // Native text selection/callouts can take over a held touch before it moves.
  // Limit suppression to the drag target; song text remains selectable.
  for (const type of ["selectstart", "contextmenu"]) {
    elements.queueList.addEventListener(type, (event) => {
      if (event.target.closest("[data-drag-handle]")) {
        event.preventDefault();
      }
    });
  }

  // A tap reaches the shared click-to-open help handler. A completed drag must
  // not also open help from the synthetic click following pointerup.
  elements.queueList.addEventListener("click", (event) => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) return;
    if (event.detail !== 0 && suppressDragClick) {
      suppressDragClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    activateQueueDragHandle(handle.closest(".queue-item")?.dataset.id || "");
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!state.dragItemId || state.dragPointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    if (!state.dragMoved) {
      if (Math.hypot(event.clientX - dragStartX, event.clientY - dragStartY) < dragActivationDistancePx) {
        return;
      }
      state.dragMoved = true;
      activateQueueDragHandle(state.dragItemId);
      closeRemoteContextualInfo();
      elements.queueList.classList.add("drag-active");
    }
    maybeAutoScrollQueue(event.clientY);
    updateDragTarget(event.clientX, event.clientY);
  }, { passive: false });

  document.addEventListener("pointerup", async (event) => {
    await finishDrag(event.pointerId);
  });

  document.addEventListener("pointercancel", (event) => {
    if (state.dragPointerId !== event.pointerId) return;
    suppressDragClick = true;
    clearDragState();
    scheduleDragHandleRestore();
    render();
  });
})();
