const pollIntervalMs = 1500;
const audioVariantSwitchDebounceMs = 350;

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  submitting: false,
  listView: "queue",
  playerControlPendingAction: "",
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantSwitchTimer: null,
  gatchaCandidate: null,
};

const elements = {
  currentTitle: document.getElementById("current-title"),
  currentRequester: document.getElementById("current-requester"),
  currentMeta: document.getElementById("current-meta"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  playerControlPanel: document.getElementById("player-control-panel"),
  playerControlHint: document.getElementById("player-control-hint"),
  remoteAvSyncPanel: document.getElementById("remote-av-sync-panel"),
  remoteAvOffsetInput: document.getElementById("remote-av-offset-input"),
  remoteVolumePanel: document.getElementById("remote-volume-panel"),
  remoteVolumeMuteButton: document.getElementById("remote-volume-mute-button"),
  remoteVolumeSlider: document.getElementById("remote-volume-slider"),
  remoteVolumeValue: document.getElementById("remote-volume-value"),
  requestForm: document.getElementById("request-form"),
  requesterSelect: document.getElementById("requester-select"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  searchForm: document.getElementById("search-form"),
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchResults: document.getElementById("search-results"),
  addNextButton: document.getElementById("add-next-button"),
  refreshButton: document.getElementById("refresh-button"),
  gatchaButton: document.getElementById("gatcha-button"),
  gatchaConfirmButton: document.getElementById("gatcha-confirm-button"),
  gatchaRetryButton: document.getElementById("gatcha-retry-button"),
  gatchaInitView: document.getElementById("gatcha-init-view"),
  gatchaResultView: document.getElementById("gatcha-result-view"),
  gatchaCandidateTitle: document.getElementById("gatcha-candidate-title"),
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

function requesterBadgeText(requesterName) {
  const normalized = String(requesterName || "").trim();
  return normalized ? `点歌人 ${normalized}` : "";
}

function selectedRequesterName() {
  return String(elements.requesterSelect?.value || "").trim();
}

function setFormMessage(message, isError = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle("error", isError);
}

function duplicateConfirmMessage(duplicateItem, sessionEntry, activeItem) {
  const title = duplicateItem?.display_title || activeItem?.display_title || sessionEntry?.display_title || "这首歌";
  const count = Number(sessionEntry?.request_count || 0);
  if (activeItem && count > 0) {
    return `《${title}》当前列表里已经有了，而且本次已点过 ${count} 次，仍要继续点歌吗？`;
  }
  if (activeItem) {
    return `《${title}》当前列表里已经有了，仍要继续点歌吗？`;
  }
  return `《${title}》本次已经点过 ${count || 1} 次，仍要继续点歌吗？`;
}

async function apiPost(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    error.code = data.code || "";
    error.payload = data;
    throw error;
  }
  return data.data;
}

async function submitAddRequest(url, position, options = {}) {
  return apiPost("/api/playlist/add", {
    url,
    position,
    requester_name: String(options.requesterName || ""),
    allow_repeat: Boolean(options.allowRepeat),
  });
}

async function submitAddRequestWithDuplicateConfirm(url, position, requesterName) {
  try {
    return {
      cancelled: false,
      data: await submitAddRequest(url, position, { requesterName }),
    };
  } catch (error) {
    if (error.code !== "duplicate_session_request") {
      throw error;
    }
    const confirmed = window.confirm(
      duplicateConfirmMessage(
        error.payload?.duplicate_item,
        error.payload?.session_entry,
        error.payload?.active_item,
      ),
    );
    if (!confirmed) {
      return { cancelled: true, data: null };
    }
    return {
      cancelled: false,
      data: await submitAddRequest(url, position, {
        requesterName,
        allowRepeat: true,
      }),
    };
  }
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

async function searchGatchaCache(query) {
  const normalizedQuery = String(query || "").trim();
  const response = await fetch(`/api/gatcha/search?q=${encodeURIComponent(normalizedQuery)}`, {
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Search failed");
  }
  return Array.isArray(payload.data?.items) ? payload.data.items : [];
}

function hideSearchResults() {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.add("hidden");
}

function renderSearchResults(items) {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.remove("hidden");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = "No cached matches found.";
    elements.searchResults.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "search-result-item";

    const meta = document.createElement("div");

    const title = document.createElement("div");
    title.className = "search-result-title";
    title.textContent = String(item.title || "");

    const url = document.createElement("div");
    url.className = "search-result-url";
    url.textContent = String(item.bvid || "");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.dataset.url = String(item.url || "");
    button.textContent = "Add";

    meta.append(title, url);
    row.append(meta, button);
    elements.searchResults.appendChild(row);
  });
}

async function handleGatchaDraw() {
  setFormMessage("Loading a random cached gatcha entry...");
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Gatcha failed");
    }

    state.gatchaCandidate = payload.data;
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
    elements.gatchaInitView.classList.add("hidden");
    elements.gatchaResultView.classList.remove("hidden");
    setFormMessage("Gatcha result ready.");
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

function render() {
  const data = state.data;
  if (!data) {
    return;
  }

  renderRequesterSelect(data.session_users || []);
  renderCurrentItem(data.current_item, data.playback_mode);
  renderAudioVariantBar(data.current_item, data.playback_mode);
  renderPlayerControls(data.current_item, data.playback_mode);
  renderRemoteAvSyncControls(data.playback_mode, data.player_settings);
  renderRemoteVolumeControls(data.playback_mode, data.player_settings);
  renderListHeader(data.playlist || [], data.history || []);
  renderQueue(Array.isArray(data.playlist) ? data.playlist : []);
  renderHistory(Array.isArray(data.history) ? data.history : []);
  syncListView();
}

function renderRequesterSelect(sessionUsers) {
  const users = Array.isArray(sessionUsers) ? sessionUsers : [];
  const previousValue = selectedRequesterName();
  elements.requesterSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = users.length ? "选择点歌人" : "请先让服务端添加用户";
  elements.requesterSelect.appendChild(placeholder);

  users.forEach((userName) => {
    const option = document.createElement("option");
    option.value = userName;
    option.textContent = userName;
    elements.requesterSelect.appendChild(option);
  });

  if (previousValue && users.includes(previousValue)) {
    elements.requesterSelect.value = previousValue;
  } else if (users.length) {
    elements.requesterSelect.value = users[0];
  } else {
    elements.requesterSelect.value = "";
  }
  elements.requesterSelect.disabled = users.length === 0;
}

function renderCurrentItem(current, playbackMode) {
  if (current) {
    elements.currentTitle.textContent = current.display_title;
    const requesterText = requesterBadgeText(current.requester_name);
    elements.currentRequester.textContent = requesterText;
    elements.currentRequester.classList.toggle("hidden", !requesterText);
    const modeLabel = playbackMode === "online" ? "在线播放" : "本地播放";
    const cacheText = current.cache_message || "等待缓存";
    elements.currentMeta.textContent = `${modeLabel} · ${cacheText}`;
    return;
  }

  elements.currentTitle.textContent = "当前还没有正在播放的歌曲";
  elements.currentRequester.textContent = "";
  elements.currentRequester.classList.add("hidden");
  elements.currentMeta.textContent = "点歌后会进入主队列，轮到时由服务端页面播放。";
}

function audioVariantsForItem(item) {
  if (!item || !Array.isArray(item.audio_variants)) {
    return [];
  }
  return item.audio_variants.filter((variant) => variant && variant.media_url);
}

function selectedAudioVariantForItem(item) {
  const variants = audioVariantsForItem(item);
  if (!variants.length) {
    return null;
  }
  const selectedId = String(item.selected_audio_variant_id || "").trim();
  return variants.find((variant) => variant.id === selectedId) || variants[0];
}

function audioVariantSwitchLocked() {
  if (state.audioVariantSwitchInFlight && Date.now() >= state.audioVariantSwitchUnlockAt) {
    state.audioVariantSwitchInFlight = false;
  }
  return state.audioVariantSwitchInFlight || Date.now() < state.audioVariantSwitchUnlockAt;
}

function scheduleAudioVariantSwitchUnlock() {
  if (state.audioVariantSwitchTimer) {
    window.clearTimeout(state.audioVariantSwitchTimer);
    state.audioVariantSwitchTimer = null;
  }
  const remainingMs = Math.max(0, state.audioVariantSwitchUnlockAt - Date.now());
  state.audioVariantSwitchTimer = window.setTimeout(() => {
    state.audioVariantSwitchInFlight = false;
    state.audioVariantSwitchUnlockAt = 0;
    state.audioVariantSwitchTimer = null;
    if (state.data) {
      renderAudioVariantBar(state.data.current_item, state.data.playback_mode);
    }
  }, remainingMs);
}

function renderAudioVariantBar(currentItem, playbackMode) {
  if (playbackMode !== "local" || !currentItem) {
    elements.audioVariantBar.innerHTML = "";
    elements.audioVariantBar.classList.add("hidden");
    return;
  }

  const variants = audioVariantsForItem(currentItem);
  if (variants.length <= 1) {
    elements.audioVariantBar.innerHTML = "";
    elements.audioVariantBar.classList.add("hidden");
    return;
  }

  const selectedVariant = selectedAudioVariantForItem(currentItem);
  const buttonsDisabled = audioVariantSwitchLocked();
  elements.audioVariantBar.innerHTML = "";
  variants.forEach((variant) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "audio-variant-button";
    button.textContent = variant.label || variant.id;
    button.dataset.itemId = currentItem.id;
    button.dataset.variantId = variant.id;
    button.disabled = buttonsDisabled;
    button.classList.toggle("active", variant.id === selectedVariant?.id);
    elements.audioVariantBar.appendChild(button);
  });
  elements.audioVariantBar.classList.remove("hidden");
}

function currentRemoteAvOffsetMs(playerSettings) {
  return Number(playerSettings?.av_offset_ms || 0);
}

function currentRemoteVolumePercent(playerSettings) {
  return Math.max(0, Math.min(100, Number(playerSettings?.volume_percent ?? 100)));
}

function currentRemoteMuted(playerSettings) {
  return Boolean(playerSettings?.is_muted);
}

function renderRemoteAvSyncControls(playbackMode, playerSettings) {
  if (!elements.remoteAvSyncPanel || !elements.remoteAvOffsetInput) {
    return;
  }
  const isLocalMode = playbackMode === "local";
  elements.remoteAvSyncPanel.classList.toggle("hidden", !isLocalMode);
  elements.remoteAvOffsetInput.value = String(currentRemoteAvOffsetMs(playerSettings));
}

function renderRemoteVolumeControls(playbackMode, playerSettings) {
  if (!elements.remoteVolumePanel || !elements.remoteVolumeSlider || !elements.remoteVolumeMuteButton || !elements.remoteVolumeValue) {
    return;
  }
  const isLocalMode = playbackMode === "local";
  elements.remoteVolumePanel.classList.toggle("hidden", !isLocalMode);
  const volumePercent = currentRemoteVolumePercent(playerSettings);
  const isMuted = currentRemoteMuted(playerSettings);
  elements.remoteVolumeSlider.value = String(volumePercent);
  elements.remoteVolumeValue.textContent = `${Math.round(volumePercent)}%`;
  elements.remoteVolumeMuteButton.textContent = isMuted ? "取消静音" : "静音";
  elements.remoteVolumeMuteButton.classList.toggle("is-muted", isMuted);
}

async function setRemoteAvOffset(offsetMs) {
  const numeric = Number(offsetMs || 0);
  if (!Number.isFinite(numeric)) {
    return;
  }
  try {
    state.data = await apiPost("/api/player/av-offset", { offset_ms: Math.max(-5000, Math.min(5000, Math.round(numeric))) });
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function setRemoteVolumeSettings({ volumePercent, isMuted } = {}) {
  const payload = {};
  if (volumePercent !== undefined) {
    const numeric = Number(volumePercent);
    if (!Number.isFinite(numeric)) {
      return;
    }
    payload.volume_percent = Math.max(0, Math.min(100, Math.round(numeric)));
  }
  if (isMuted !== undefined) {
    payload.is_muted = Boolean(isMuted);
  }
  if (!Object.keys(payload).length) {
    return;
  }
  try {
    state.data = await apiPost("/api/player/volume", payload);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

function canRemoteControlPlayer(currentItem, playbackMode) {
  return Boolean(currentItem && playbackMode === "local" && currentItem.local_media_url);
}

function currentPlayerStatus(currentItem) {
  const playerStatus = state.data?.player_status;
  if (!currentItem || !playerStatus) {
    return null;
  }
  if (String(playerStatus.item_id || "") !== String(currentItem.id || "")) {
    return null;
  }
  return playerStatus;
}

function renderPlayerControls(currentItem, playbackMode) {
  if (!currentItem) {
    elements.playerControlPanel.classList.add("hidden");
    elements.playerControlHint.textContent = "";
    return;
  }

  const canControl = canRemoteControlPlayer(currentItem, playbackMode);
  const playerStatus = currentPlayerStatus(currentItem);
  const isPaused = Boolean(playerStatus?.is_paused);
  const toggleButton = elements.playerControlPanel.querySelector('[data-control-action="toggle-play"]');
  elements.playerControlPanel.classList.remove("hidden");

  elements.playerControlPanel.querySelectorAll("button[data-control-action]").forEach((button) => {
    const isPending = button.dataset.controlAction === state.playerControlPendingAction;
    button.disabled = !canControl || Boolean(state.playerControlPendingAction);
    button.classList.toggle("is-pending", isPending);
  });

  if (toggleButton) {
    toggleButton.textContent = isPaused ? "播放" : "暂停";
    toggleButton.classList.toggle("is-paused", isPaused);
    toggleButton.classList.toggle("is-playing", !isPaused);
  }

  if (playbackMode !== "local") {
    elements.playerControlHint.textContent = "当前是在线播放，暂不支持远程控制播放。";
    return;
  }
  if (!currentItem.local_media_url) {
    elements.playerControlHint.textContent = "当前歌曲还没有完成本地缓存，暂时无法远程控制。";
    return;
  }
  elements.playerControlHint.textContent = isPaused
    ? "当前已暂停，可以恢复播放或前后跳转。"
    : "当前正在播放，可以暂停或前后跳转。";
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
    elements.queueList.innerHTML = '<div class="queue-empty">队列暂时是空的，可以继续点下一首歌。</div>';
    return;
  }

  playlist.forEach((item, index) => {
    const node = elements.queueItemTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("ready", item.cache_status === "ready");
    const orderNode = node.querySelector(".queue-order");
    if (orderNode) {
      orderNode.textContent = String(index + 1);
    }
    node.querySelector(".queue-title").textContent = item.display_title;
    const noteNode = node.querySelector(".queue-note");
    const noteText = queueNoteText(item);
    noteNode.textContent = noteText;
    noteNode.classList.toggle("hidden", !noteText);
    node.querySelector(".queue-main").classList.toggle("is-compact", !noteText);
    node.querySelector(".queue-state").textContent = queueStateLabel(item);
    const requesterNode = node.querySelector(".queue-requester");
    const requesterText = requesterBadgeText(item.requester_name);
    requesterNode.textContent = requesterText;
    requesterNode.classList.toggle("hidden", !requesterText);
    elements.queueList.appendChild(node);
  });
}

function queueNoteText(item) {
  if (!item) {
    return "";
  }
  if (item.cache_status === "ready") {
    return "";
  }
  const message = String(item.cache_message || "").trim();
  if (!message) {
    return "";
  }
  if (message === "已缓存" || message === "缓存已完成") {
    return "";
  }
  return message;
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
    const requesterNode = node.querySelector(".history-requester");
    const requesterText = requesterBadgeText(entry.requester_name);
    requesterNode.textContent = requesterText;
    requesterNode.classList.toggle("hidden", !requesterText);
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
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    if (!url) {
      setFormMessage("请输入 bilibili 链接、BV 号或 av 号。", true);
    }
    return;
  }
  if (!requesterName) {
    setFormMessage("请先选择点歌人。", true);
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? "正在顶歌..." : "正在加入队列...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    state.data = result.data;
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
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    return;
  }
  if (!requesterName) {
    setFormMessage("请先选择点歌人。", true);
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? "正在从历史记录顶歌..." : "正在从历史记录加入队列...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    state.data = result.data;
    setFormMessage(position === "next" ? "已从历史记录顶歌到下一首。" : "已从历史记录加入队列。");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.submitting = false;
  }
}

async function addByUrl(url, position = "tail") {
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    return;
  }
  if (!requesterName) {
    setFormMessage("Please select a requester first.", true);
    return;
  }

  state.submitting = true;
  setFormMessage("Adding selected song...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    state.data = result.data;
    hideSearchResults();
    elements.searchQuery.value = "";
    state.gatchaCandidate = null;
    elements.gatchaResultView.classList.add("hidden");
    elements.gatchaInitView.classList.remove("hidden");
    setFormMessage("Song added.");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.submitting = false;
  }
}

async function sendPlayerControl(action, deltaSeconds = 0) {
  const currentItem = state.data?.current_item;
  const playbackMode = state.data?.playback_mode;
  if (!currentItem || !canRemoteControlPlayer(currentItem, playbackMode)) {
    return;
  }

  const message = action === "toggle-play"
    ? "已发送播放 / 暂停指令。"
    : deltaSeconds > 0
      ? "已发送快进 15 秒指令。"
      : "已发送后退 15 秒指令。";

  try {
    state.playerControlPendingAction = action;
    if (action === "toggle-play") {
      const existingStatus = currentPlayerStatus(currentItem) || { item_id: currentItem.id, is_paused: false };
      state.data.player_status = {
        ...existingStatus,
        item_id: currentItem.id,
        is_paused: !Boolean(existingStatus.is_paused),
      };
      renderPlayerControls(currentItem, playbackMode);
    } else {
      renderPlayerControls(currentItem, playbackMode);
    }
    state.data = await apiPost("/api/player/control", {
      action,
      item_id: currentItem.id,
      delta_seconds: deltaSeconds,
    });
    setFormMessage(message);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
    await fetchState().catch(() => {});
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, state.data?.playback_mode);
}

function queueNoteText() {
  return "";
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

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.searchQuery.value || "").trim();
  if (!query) {
    hideSearchResults();
    setFormMessage("Please enter a search keyword.", true);
    return;
  }

  elements.searchButton.disabled = true;
  setFormMessage("Searching local cache...");
  try {
    const items = await searchGatchaCache(query);
    renderSearchResults(items);
    setFormMessage(items.length ? `Found ${items.length} cached result(s).` : "No cached matches found.");
  } catch (error) {
    hideSearchResults();
    setFormMessage(error.message, true);
  } finally {
    elements.searchButton.disabled = false;
  }
});

elements.searchResults.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) {
    return;
  }
  await addByUrl(String(button.dataset.url || ""), "tail");
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
  } finally {
    state.audioVariantSwitchInFlight = false;
    scheduleAudioVariantSwitchUnlock();
  }
});

elements.remoteAvSyncPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-av-step]");
  if (!button) {
    return;
  }
  await setRemoteAvOffset(
    currentRemoteAvOffsetMs(state.data?.player_settings) + Number(button.dataset.avStep || "0"),
  );
});

elements.remoteAvOffsetInput?.addEventListener("change", async (event) => {
  await setRemoteAvOffset(event.target.value);
});

elements.remoteAvOffsetInput?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  await setRemoteAvOffset(event.target.value);
});

elements.remoteVolumeSlider?.addEventListener("input", async (event) => {
  await setRemoteVolumeSettings({
    volumePercent: event.target.value,
    isMuted: currentRemoteMuted(state.data?.player_settings),
  });
});

elements.remoteVolumeMuteButton?.addEventListener("click", async () => {
  await setRemoteVolumeSettings({
    volumePercent: currentRemoteVolumePercent(state.data?.player_settings),
    isMuted: !currentRemoteMuted(state.data?.player_settings),
  });
});

elements.gatchaButton.addEventListener("click", handleGatchaDraw);
elements.gatchaRetryButton.addEventListener("click", handleGatchaDraw);

elements.gatchaConfirmButton.addEventListener("click", async () => {
  if (!state.gatchaCandidate?.url) {
    return;
  }
  await addByUrl(String(state.gatchaCandidate.url), "tail");
});

elements.audioVariantBar.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-variant-id]");
  const currentItem = state.data?.current_item;
  if (!button || !currentItem || audioVariantSwitchLocked()) {
    return;
  }
  if (button.dataset.itemId !== currentItem.id) {
    return;
  }

  const nextVariantId = button.dataset.variantId || "";
  const selectedVariant = selectedAudioVariantForItem(currentItem);
  if (!nextVariantId || nextVariantId === selectedVariant?.id) {
    return;
  }

  try {
    state.audioVariantSwitchInFlight = true;
    state.audioVariantSwitchUnlockAt = Date.now() + audioVariantSwitchDebounceMs;
    renderAudioVariantBar(currentItem, state.data?.playback_mode);
    state.data = await apiPost("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
    });
    render();
    const activeItem = state.data?.current_item;
    const activeVariant = activeItem ? selectedAudioVariantForItem(activeItem) : null;
    setFormMessage(`已切换到 ${activeVariant?.label || nextVariantId}`);
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.audioVariantSwitchInFlight = false;
    scheduleAudioVariantSwitchUnlock();
  }
});

elements.playerControlPanel.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-control-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.controlAction || "";
  const deltaSeconds = Number(button.dataset.delta || "0");
  await sendPlayerControl(action, deltaSeconds);
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
