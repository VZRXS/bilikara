const pollIntervalMs = 1500;

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  submitting: false,
  listView: "queue",
};

const elements = {
  currentTitle: document.getElementById("current-title"),
  currentMeta: document.getElementById("current-meta"),
  requestForm: document.getElementById("request-form"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  addNextButton: document.getElementById("add-next-button"),
  refreshButton: document.getElementById("refresh-button"),
  listTag: document.getElementById("list-tag"),
  listTitle: document.getElementById("list-title"),
  listCount: document.getElementById("list-count"),
  queueViewButton: document.getElementById("queue-view-button"),
  historyViewButton: document.getElementById("history-view-button"),
  queueList: document.getElementById("queue-list"),
  historyList: document.getElementById("history-list"),
  queueItemTemplate: document.getElementById("queue-item-template"),
  historyItemTemplate: document.getElementById("history-item-template"),
};

function createClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `remote-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clientHeaders(extraHeaders = {}) {
  return {
    "X-Bilikara-Client": state.clientId,
    ...extraHeaders,
  };
}

function setFormMessage(message, isError = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle("error", isError);
}

async function apiPost(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data.data;
}

async function fetchState() {
  const response = await fetch("/api/state", { headers: clientHeaders() });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "获取状态失败");
  }
  state.data = payload.data;
  render();
}

function render() {
  const data = state.data;
  if (!data) {
    return;
  }

  renderCurrentItem(data.current_item, data.playback_mode);
  renderListHeader(data.playlist || [], data.history || []);
  renderQueue(Array.isArray(data.playlist) ? data.playlist : []);
  renderHistory(Array.isArray(data.history) ? data.history : []);
  syncListView();
}

function renderCurrentItem(current, playbackMode) {
  if (current) {
    elements.currentTitle.textContent = current.display_title;
    const modeLabel = playbackMode === "online" ? "在线播放" : "本地播放";
    const cacheText = current.cache_message || "等待缓存";
    elements.currentMeta.textContent = `${modeLabel} · ${cacheText}`;
    return;
  }

  elements.currentTitle.textContent = "当前还没有正在播放的歌曲";
  elements.currentMeta.textContent = "点歌后会进入主队列，轮到时由服务端页面播放。";
}

function renderListHeader(playlist, history) {
  const isHistoryView = state.listView === "history";
  elements.listTag.textContent = isHistoryView ? "History" : "Queue";
  elements.listTitle.textContent = isHistoryView ? "点歌历史" : "播放队列";
  elements.listCount.textContent = `${isHistoryView ? history.length : playlist.length} 首`;

  elements.queueViewButton.classList.toggle("active", !isHistoryView);
  elements.queueViewButton.setAttribute("aria-selected", String(!isHistoryView));
  elements.historyViewButton.classList.toggle("active", isHistoryView);
  elements.historyViewButton.setAttribute("aria-selected", String(isHistoryView));
}

function syncListView() {
  const isHistoryView = state.listView === "history";
  elements.queueList.classList.toggle("hidden", isHistoryView);
  elements.historyList.classList.toggle("hidden", !isHistoryView);
}

function renderQueue(playlist) {
  elements.queueList.innerHTML = "";
  if (!playlist.length) {
    elements.queueList.innerHTML = '<div class="queue-empty">队列暂时是空的，可以直接点下一首歌。</div>';
    return;
  }

  playlist.forEach((item, index) => {
    const node = elements.queueItemTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("ready", item.cache_status === "ready");
    node.querySelector(".queue-title").textContent = `${index + 1}. ${item.display_title}`;
    node.querySelector(".queue-note").textContent = item.cache_message || "等待缓存";
    node.querySelector(".queue-state").textContent = queueStateLabel(item);
    elements.queueList.appendChild(node);
  });
}

function queueStateLabel(item) {
  if (item.cache_status === "ready") {
    return "已缓存";
  }
  if (item.cache_status === "downloading") {
    return `${Math.round(Number(item.cache_progress || 0))}%`;
  }
  if (item.cache_status === "failed") {
    return "失败";
  }
  if (item.cache_status === "queued") {
    return "排队中";
  }
  return "等待中";
}

function renderHistory(history) {
  elements.historyList.innerHTML = "";

  if (!history.length) {
    elements.historyList.innerHTML =
      '<div class="queue-empty"><p>还没有点歌历史。</p><p>点过的歌曲会自动出现在这里。</p></div>';
    return;
  }

  history.forEach((entry) => {
    const node = elements.historyItemTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".history-title").textContent = entry.display_title;
    node.querySelector(".history-time").textContent = formatHistoryTime(entry.requested_at);
    node.querySelector(".history-count").textContent = `点歌 ${entry.request_count} 次`;
    node.querySelectorAll("button").forEach((button) => {
      button.dataset.url = entry.resolved_url || entry.original_url;
    });
    elements.historyList.appendChild(node);
  });
}

function formatHistoryTime(timestamp) {
  if (!timestamp) {
    return "刚刚点过";
  }
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function submitRequest(position) {
  const url = elements.urlInput.value.trim();
  if (!url || state.submitting) {
    if (!url) {
      setFormMessage("请输入 bilibili 链接、BV 号或 av 号。", true);
    }
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? "正在顶歌..." : "正在加入队列...");
  try {
    state.data = await apiPost("/api/playlist/add", { url, position });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? "已经顶歌到下一首。" : "已经加入播放队列。");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.submitting = false;
  }
}

async function handleAddByHistory(url, position) {
  if (!url || state.submitting) {
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? "正在从历史记录顶歌..." : "正在从历史记录加入队列...");
  try {
    state.data = await apiPost("/api/playlist/add", { url, position });
    setFormMessage(position === "next" ? "已从历史记录顶歌到下一首。" : "已从历史记录加入队列。");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.submitting = false;
  }
}

function disconnectClient() {
  if (state.disconnectSent) {
    return;
  }
  state.disconnectSent = true;
  const body = JSON.stringify({ client_id: state.clientId });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/client/disconnect", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/client/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

elements.requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitRequest("tail");
});

elements.addNextButton.addEventListener("click", async () => {
  await submitRequest("next");
});

elements.refreshButton.addEventListener("click", async () => {
  try {
    await fetchState();
    setFormMessage("列表已刷新。");
  } catch (error) {
    setFormMessage(error.message, true);
  }
});

elements.queueViewButton.addEventListener("click", () => {
  state.listView = "queue";
  render();
});

elements.historyViewButton.addEventListener("click", () => {
  state.listView = "history";
  render();
});

elements.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const url = button.dataset.url;
  if (!url) {
    return;
  }
  await handleAddByHistory(url, button.dataset.action === "history-next" ? "next" : "tail");
});

window.addEventListener("pagehide", disconnectClient);
window.addEventListener("beforeunload", disconnectClient);

async function startPolling() {
  try {
    await fetchState();
  } catch (error) {
    setFormMessage(error.message, true);
  }
  window.setInterval(async () => {
    try {
      await fetchState();
    } catch {
      // Keep the last successful state on screen.
    }
  }, pollIntervalMs);
}

startPolling();
