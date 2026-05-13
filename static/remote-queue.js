(function enhanceRemoteQueue() {
  if (
    typeof state === "undefined"
    || typeof elements === "undefined"
    || typeof apiPost !== "function"
    || typeof setFormMessage !== "function"
  ) {
    return;
  }

  state.dragItemId = "";
  state.dragTargetId = "";
  state.dragTargetAfter = false;
  state.dragPointerId = null;
  state.dragMoved = false;

  const dragScrollThresholdPx = 56;
  const dragScrollStepPx = 18;

  renderQueue = function renderQueueWithActions(playlist) {
    if (state.dragItemId) {
      syncDropIndicators();
      return;
    }

    elements.queueList.innerHTML = "";
    if (!playlist.length) {
      elements.queueList.innerHTML =
        `<div class="queue-empty">${typeof htmlT === "function" ? htmlT("remote.queueEmpty") : "remote.queueEmpty"}</div>`;
      return;
    }

    playlist.forEach((item, index) => {
      const node = elements.queueItemTemplate.content.firstElementChild.cloneNode(true);
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
      node.querySelectorAll("button[data-action]").forEach((button) => {
        button.dataset.id = item.id;
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
    if (!state.dragItemId) {
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

  async function reorderQueue(itemId, index) {
    state.data = await apiPost("/api/playlist/reorder", { item_id: itemId, index });
    setFormMessage(typeof t === "function" ? t("remote.queueOrderUpdated") : "remote.queueOrderUpdated");
    render();
  }

  async function handleQueueAction(action, itemId) {
    if (!itemId) {
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
    };

    const target = actionMap[action];
    if (!target) {
      return;
    }

    if (action === "remove" && !window.confirm(typeof t === "function" ? t("list.removeConfirm") : "list.removeConfirm")) {
      return;
    }

    try {
      state.data = await apiPost(target.url, target.payload);
      setFormMessage(target.message);
      render();
    } catch (error) {
      setFormMessage(error.message, true);
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

    event.preventDefault();
    state.dragItemId = item.dataset.id || "";
    state.dragTargetId = "";
    state.dragTargetAfter = false;
    state.dragPointerId = event.pointerId;
    state.dragMoved = false;
    elements.queueList.classList.add("drag-active");
    handle.setPointerCapture?.(event.pointerId);
    syncDropIndicators();
  }

  async function finishDrag(pointerId) {
    if (!state.dragItemId || state.dragPointerId !== pointerId) {
      return;
    }

    const draggedId = state.dragItemId;
    const playlist = Array.isArray(state.data?.playlist) ? state.data.playlist : [];
    const sourceIndex = playlist.findIndex((item) => item.id === draggedId);
    const targetIndex = reorderTargetIndex(playlist, draggedId);
    clearDragState();

    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      render();
      return;
    }

    const draggedItem = playlist[sourceIndex];
    if (typeof openReorderConfirmSheet === "function") {
      openReorderConfirmSheet({
        itemId: draggedId,
        targetIndex,
        title: draggedItem?.display_title || "",
      });
      render();
      return;
    }

    try {
      await reorderQueue(draggedId, targetIndex);
    } catch (error) {
      setFormMessage(error.message, true);
    }
  }

  elements.queueViewButton.addEventListener("click", clearDragState);
  elements.historyViewButton.addEventListener("click", clearDragState);

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
    await handleQueueAction(button.dataset.action, button.dataset.id);
  });

  elements.queueList.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle) {
      return;
    }
    beginDrag(handle, event);
  });

  document.addEventListener("pointermove", (event) => {
    if (!state.dragItemId || state.dragPointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    state.dragMoved = true;
    maybeAutoScrollQueue(event.clientY);
    updateDragTarget(event.clientX, event.clientY);
  }, { passive: false });

  document.addEventListener("pointerup", async (event) => {
    await finishDrag(event.pointerId);
  });

  document.addEventListener("pointercancel", async (event) => {
    await finishDrag(event.pointerId);
  });
})();
