const pollIntervalMs = 1000;
const bannerAutoHideMs = 5000;

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  playerSignature: "",
  listView: "queue",
  cacheSettingsOpen: false,
  cacheLimitSaving: false,
  backupBannerShown: false,
  backupBannerDismissed: false,
  backupBannerTimer: null,
  localAdvanceInFlight: false,
  dragItemId: "",
  dragTargetId: "",
  dragTargetAfter: false,
  confirmIntent: null,
};

const elements = {
  bbdownStatus: document.getElementById("bbdown-status"),
  cacheChipMeta: document.getElementById("cache-chip-meta"),
  cacheSettings: document.getElementById("cache-settings"),
  cacheSettingsToggle: document.getElementById("cache-settings-toggle"),
  cachePanel: document.getElementById("cache-panel"),
  cacheUsageDetail: document.getElementById("cache-usage-detail"),
  ffmpegStatusHint: document.getElementById("ffmpeg-status-hint"),
  cacheLimitValue: document.getElementById("cache-limit-value"),
  cacheLimitSlider: document.getElementById("cache-limit-slider"),
  cacheLimitScale: document.getElementById("cache-limit-scale"),
  currentTitle: document.getElementById("current-title"),
  playerFrame: document.getElementById("player-frame"),
  addForm: document.getElementById("add-form"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  backupBanner: document.getElementById("backup-banner"),
  backupText: document.getElementById("backup-text"),
  discardBackupButton: document.getElementById("discard-backup-button"),
  dismissBackupButton: document.getElementById("dismiss-backup-button"),
  listTag: document.getElementById("list-tag"),
  listTitle: document.getElementById("list-title"),
  playlist: document.getElementById("playlist"),
  historyList: document.getElementById("history-list"),
  queueCount: document.getElementById("queue-count"),
  queueCurrent: document.getElementById("queue-current"),
  queueCurrentIndicator: document.getElementById("queue-current-indicator"),
  queueCurrentTag: document.getElementById("queue-current-tag"),
  queueCurrentTitle: document.getElementById("queue-current-title"),
  listStage: document.getElementById("list-stage"),
  modeSwitch: document.getElementById("mode-switch"),
  nextButton: document.getElementById("next-button"),
  queueNextButton: document.getElementById("queue-next-button"),
  historyToggleButton: document.getElementById("history-toggle-button"),
  clearPlaylistButton: document.getElementById("clear-playlist-button"),
  playlistTemplate: document.getElementById("playlist-item-template"),
  historyTemplate: document.getElementById("history-item-template"),
  confirmPopover: document.getElementById("confirm-popover"),
  confirmText: document.getElementById("confirm-text"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmOk: document.getElementById("confirm-ok"),
  copyRemoteUrlButton: document.getElementById("copy-remote-url-button"),
  remoteQrImage: document.getElementById("remote-qr-image"),
  remoteQrPlaceholder: document.getElementById("remote-qr-placeholder"),
  remoteUrlLink: document.getElementById("remote-url-link"),
  remoteUrlHint: document.getElementById("remote-url-hint"),
};

function setFormMessage(message, isError = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.style.color = isError ? "var(--red)" : "var(--muted)";
}

function createClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clientHeaders(extraHeaders = {}) {
  return {
    "X-Bilikara-Client": state.clientId,
    ...extraHeaders,
  };
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
  const response = await fetch("/api/state", {
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "获取状态失败");
  }
  state.data = payload.data;
  render();
}

function disconnectClient() {
  if (state.disconnectSent) {
    return;
  }
  state.disconnectSent = true;
  const body = JSON.stringify({ client_id: state.clientId });
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon("/api/client/disconnect", blob);
    return;
  }
  fetch("/api/client/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function render() {
  const data = state.data;
  if (!data) {
    return;
  }

  const currentItem = data.current_item;
  elements.currentTitle.textContent = currentItem
    ? currentItem.display_title
    : "还没有歌曲";
  renderListHeader(data.playlist, data.history || []);
  renderCacheSettings(data.bbdown, data.ffmpeg, data.cache_policy);
  renderRemoteAccess(data.remote_access);

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === data.playback_mode);
  });

  renderPlayer(currentItem, data.playback_mode);
  renderQueueCurrent(currentItem);
  if (!state.dragItemId) {
    renderPlaylist(data.playlist, data.current_item, data.cache_policy);
  }
  renderHistory(data.history || []);
  renderBackupBanner(
    data.backup,
    Boolean(currentItem),
    data.playlist.length,
    Boolean(data.session_flags?.auto_restored_backup),
  );
  elements.listStage.classList.toggle("is-history-view", state.listView === "history");
  renderConfirmPopover();
}

function renderRemoteAccess(remoteAccess) {
  const preferredUrl = String(remoteAccess?.preferred_url || "");
  const lanUrls = Array.isArray(remoteAccess?.lan_urls) ? remoteAccess.lan_urls : [];
  const localUrl = String(remoteAccess?.local_url || "");
  const displayUrl = preferredUrl || localUrl || `${window.location.origin}/remote`;

  elements.remoteUrlLink.href = displayUrl;
  elements.remoteUrlLink.textContent = displayUrl;

  if (lanUrls.length > 1) {
    elements.remoteUrlHint.textContent = `同网地址候选：${lanUrls.join(" · ")}`;
  } else if (lanUrls.length === 1) {
    elements.remoteUrlHint.textContent = "手机和服务端在同一个局域网内时，可直接扫码访问。";
  } else {
    elements.remoteUrlHint.textContent = "暂未识别到局域网地址，可手动复制当前地址访问。";
  }

  renderRemoteQr(displayUrl);
}

function renderRemoteQr(url) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    elements.remoteQrImage.classList.add("hidden");
    elements.remoteQrPlaceholder.textContent = "暂无可用访问地址";
    elements.remoteQrPlaceholder.classList.remove("hidden");
    return;
  }

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(normalizedUrl)}`;
  if (elements.remoteQrImage.dataset.qrUrl === qrUrl) {
    return;
  }

  elements.remoteQrImage.dataset.qrUrl = qrUrl;
  elements.remoteQrImage.classList.add("hidden");
  elements.remoteQrPlaceholder.textContent = "正在生成二维码...";
  elements.remoteQrPlaceholder.classList.remove("hidden");
  elements.remoteQrImage.onload = () => {
    elements.remoteQrPlaceholder.classList.add("hidden");
    elements.remoteQrImage.classList.remove("hidden");
  };
  elements.remoteQrImage.onerror = () => {
    elements.remoteQrImage.classList.add("hidden");
    elements.remoteQrPlaceholder.textContent = "二维码加载失败，请复制下方链接到手机访问。";
    elements.remoteQrPlaceholder.classList.remove("hidden");
  };
  elements.remoteQrImage.src = qrUrl;
}

async function copyRemoteUrl() {
  const url = elements.remoteUrlLink.href;
  if (!url) {
    setFormMessage("当前没有可复制的手机访问地址。", true);
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setFormMessage("手机访问链接已复制。");
  } catch {
    setFormMessage("复制失败，请手动复制页面中的链接。", true);
  }
}

function renderListHeader(playlist, history) {
  const isHistoryView = state.listView === "history";
  elements.listTag.textContent = isHistoryView ? "History" : "Queue";
  elements.listTitle.textContent = isHistoryView ? "历史记录" : "播放列表";
  elements.queueCount.textContent = isHistoryView
    ? `(${history.length}首)`
    : `(${playlist.length}首)`;
  elements.historyToggleButton.textContent = isHistoryView ? "返回队列" : "历史记录";
  elements.clearPlaylistButton.classList.toggle("hidden", isHistoryView);
  elements.nextButton.classList.toggle("hidden", isHistoryView);
}

function renderCacheSettings(bbdown, ffmpeg, cachePolicy) {
  elements.bbdownStatus.textContent = formatBBDownStatus(bbdown);
  elements.bbdownStatus.title = bbdown?.message || "";
  elements.cacheChipMeta.textContent = formatCacheChipMeta(cachePolicy);
  elements.cacheUsageDetail.textContent = formatCacheUsage(cachePolicy);
  elements.ffmpegStatusHint.textContent = formatFFmpegHint(ffmpeg);

  renderCacheSlider(cachePolicy);
  syncCachePanelVisibility();
}

function renderCacheSlider(cachePolicy) {
  const choices = Array.isArray(cachePolicy?.choices) && cachePolicy.choices.length
    ? cachePolicy.choices
    : [1, 2, 3, 4, 5];
  const minValue = Number(choices[0] || 1);
  const maxValue = Number(choices[choices.length - 1] || 5);
  const currentValue = Number(cachePolicy?.max_cache_items || minValue);

  elements.cacheLimitSlider.min = String(minValue);
  elements.cacheLimitSlider.max = String(maxValue);
  elements.cacheLimitSlider.step = "1";
  elements.cacheLimitSlider.value = String(currentValue);
  elements.cacheLimitSlider.disabled = state.cacheLimitSaving;
  elements.cacheLimitValue.textContent = `缓存 ${currentValue} 首`;
  updateCacheSliderFill(currentValue, minValue, maxValue);

  elements.cacheLimitScale.innerHTML = "";
  choices.forEach((choice) => {
    const mark = document.createElement("span");
    mark.textContent = String(choice);
    mark.classList.toggle("active", Number(choice) === currentValue);
    elements.cacheLimitScale.appendChild(mark);
  });
}

function syncCachePanelVisibility() {
  elements.cacheSettingsToggle.setAttribute("aria-expanded", String(state.cacheSettingsOpen));
  elements.cachePanel.classList.toggle("hidden", !state.cacheSettingsOpen);
}

function renderQueueCurrent(currentItem) {
  if (!currentItem) {
    elements.queueCurrent.classList.add("hidden");
    elements.queueCurrent.dataset.state = "idle";
    elements.queueCurrentTag.textContent = "播放中";
    elements.queueCurrentTitle.textContent = "还没有歌曲";
    return;
  }

  elements.queueCurrent.classList.remove("hidden");
  const currentState = currentStatusForItem(currentItem);
  elements.queueCurrent.dataset.state = currentState.state;
  elements.queueCurrentTag.textContent = currentState.label;
  elements.queueCurrentTitle.textContent = currentItem.display_title;
}

function currentStatusForItem(item) {
  if (!item) {
    return { state: "idle", label: "播放中" };
  }
  if (item.local_media_url || item.cache_status === "ready") {
    return { state: "playing", label: "播放中" };
  }
  if (item.cache_status === "failed") {
    return { state: "failed", label: "失败" };
  }
  const size = Number(item.cache_size_bytes || 0);
  if (size > 0) {
    return { state: "caching", label: formatCompactBytes(size) };
  }
  if (item.cache_status === "downloading") {
    return { state: "caching", label: "缓存中" };
  }
  return { state: "pending", label: "待缓存" };
}

function renderPlayer(currentItem, playbackMode) {
  const signature = [
    currentItem ? currentItem.id : "none",
    playbackMode,
    currentItem ? currentItem.local_media_url : "",
    currentItem ? currentItem.cache_status : "",
  ].join("|");

  if (signature === state.playerSignature) {
    return;
  }
  state.playerSignature = signature;

  if (!currentItem) {
    elements.playerFrame.innerHTML =
      '<div class="empty-state"><p>把 B 站视频链接加入列表后，这里会开始播放。</p></div>';
    return;
  }

  if (playbackMode === "online") {
    elements.playerFrame.innerHTML = `
      <iframe
        src="${escapeHtml(currentItem.embed_url)}"
        allow="autoplay; fullscreen"
        allowfullscreen="true"
        referrerpolicy="origin"
        sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"
        title="${escapeHtml(currentItem.display_title)}"
      ></iframe>
    `;
    return;
  }

  if (currentItem.local_media_url) {
    elements.playerFrame.innerHTML = `
      <video
        controls
        autoplay
        preload="metadata"
        src="${escapeHtml(currentItem.local_media_url)}"
      ></video>
    `;
    const video = elements.playerFrame.querySelector("video");
    if (video) {
      video.addEventListener("ended", async () => {
        await handleLocalPlaybackEnded();
      });
    }
    return;
  }

  elements.playerFrame.innerHTML = `
    <div class="empty-state">
      <p>当前歌曲还没有完成本地缓存。</p>
      <p class="empty-hint">${escapeHtml(currentItem.cache_message || "正在后台缓存")}</p>
    </div>
  `;
}

function renderPlaylist(playlist, currentItem, cachePolicy) {
  const existingNodes = new Map(
    [...elements.playlist.querySelectorAll(".song-item")].map((node) => [node.dataset.id, node]),
  );

  if (!playlist.length) {
    elements.playlist.innerHTML = "";
    const emptyMessage = state.data?.current_item
      ? '<div class="queue-empty"><p>待播队列已经空了。</p><p>可以继续从左侧加入下一首。</p></div>'
      : '<div class="queue-empty"><p>播放列表还是空的。</p><p>把链接加到左侧输入框里就行。</p></div>';
    elements.playlist.innerHTML = emptyMessage;
    return;
  }

  elements.playlist.querySelectorAll(".queue-empty").forEach((node) => {
    node.remove();
  });

  playlist.forEach((item, index) => {
    const node = existingNodes.get(item.id)
      || elements.playlistTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;
    node.title = item.display_title;

    const badge = node.querySelector(".song-progress-badge");
    const indexLabel = node.querySelector(".song-index-label");
    const sizeLabel = node.querySelector(".song-size-label");
    const readyIndicator = node.querySelector(".song-badge-check");
    const note = node.querySelector(".song-note");

    indexLabel.textContent = String(index + 1);

    const badgeState = badgeStateForItem(item, index, currentItem, cachePolicy);
    badge.classList.toggle("active", badgeState === "active");
    badge.classList.toggle("idle", badgeState === "idle");
    badge.classList.toggle("ready", item.cache_status === "ready");
    badge.classList.toggle("failed", item.cache_status === "failed");
    badge.style.setProperty("--badge-delay", badgeAnimationDelay(item.id));
    readyIndicator.classList.toggle("hidden", item.cache_status !== "ready");
    badge.setAttribute("title", badgeTitleForItem(item));

    const sizeText = cacheSizeLabelForItem(item);
    sizeLabel.textContent = sizeText;
    sizeLabel.classList.toggle("hidden", !sizeText);

    node.querySelector(".song-title").textContent = item.display_title;

    const noteText = noteForItem(item);
    note.textContent = noteText;
    note.classList.toggle("hidden", !noteText);

    node.querySelectorAll("button").forEach((button) => {
      button.dataset.id = item.id;
    });

    elements.playlist.appendChild(node);
    existingNodes.delete(item.id);
  });

  existingNodes.forEach((node) => {
    node.remove();
  });
}

function badgeStateForItem(item, index, currentItem, cachePolicy) {
  if (item.cache_status === "ready" || item.cache_status === "failed") {
    return item.cache_status;
  }

  if (item.cache_status === "downloading") {
    return "active";
  }
  return "idle";
}

function renderHistory(history) {
  elements.historyList.innerHTML = "";

  if (!history.length) {
    elements.historyList.innerHTML =
      '<div class="queue-empty"><p>还没有点歌历史。</p><p>点过的歌曲会自动出现在这里。</p></div>';
    return;
  }

  history.forEach((entry) => {
    const node = elements.historyTemplate.content.firstElementChild.cloneNode(true);
    const title = node.querySelector(".history-title");
    title.textContent = entry.display_title;
    node.querySelector(".history-time").textContent = formatHistoryTime(entry.requested_at);
    node.querySelector(".history-count").textContent = `点歌 ${entry.request_count} 次`;
    node.querySelectorAll("button").forEach((button) => {
      button.dataset.url = entry.resolved_url || entry.original_url;
    });
    elements.historyList.appendChild(node);
  });
}

function badgeTitleForItem(item) {
  if (item.cache_status === "ready") {
    return "缓存已完成";
  }
  if (item.cache_status === "failed") {
    return item.cache_message || "缓存失败";
  }
  return item.cache_message || "正在缓存";
}

function noteForItem(item) {
  if (item.cache_status === "failed") {
    return item.cache_message || "缓存失败";
  }
  return "";
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

function formatBBDownStatus(bbdown) {
  if (!bbdown) {
    return "未知";
  }
  const labelMap = {
    idle: "空闲",
    checking: "检查中",
    ready: "已就绪",
    failed: "异常",
  };
  const stateLabel = labelMap[bbdown.state] || bbdown.state || "未知";
  if (bbdown.version) {
    return `${stateLabel} · ${bbdown.version}`;
  }
  return stateLabel;
}

function formatFFmpegStatus(ffmpeg) {
  if (!ffmpeg) {
    return "未知";
  }
  const labelMap = {
    idle: "空闲",
    checking: "检查中",
    ready: "已就绪",
    failed: "异常",
  };
  const stateLabel = labelMap[ffmpeg.state] || ffmpeg.state || "未知";
  if (ffmpeg.version) {
    return `${stateLabel} · ${ffmpeg.version}`;
  }
  return stateLabel;
}

function formatFFmpegHint(ffmpeg) {
  if (!ffmpeg) {
    return "FFmpeg 未知";
  }
  const labelMap = {
    idle: "空闲",
    checking: "检查中",
    ready: "已就绪",
    failed: "异常",
  };
  const stateLabel = labelMap[ffmpeg.state] || ffmpeg.state || "未知";
  return `FFmpeg ${stateLabel}`;
}

function formatCacheChipMeta(cachePolicy) {
  const limit = Number(cachePolicy?.max_cache_items || 0);
  return `${formatBytes(cachePolicy?.usage_bytes || 0)} · 缓存 ${limit} 首`;
}

function formatCacheUsage(cachePolicy) {
  const usage = formatBytes(cachePolicy?.usage_bytes || 0);
  const cachedItemCount = Number(cachePolicy?.cached_item_count || 0);
  return `${usage} · ${cachedItemCount} 首已缓存`;
}

function cacheSizeLabelForItem(item) {
  const size = Number(item.cache_size_bytes || 0);
  if (size > 0) {
    return formatCompactBytes(size);
  }
  if (item.cache_status === "failed") {
    return "失败";
  }
  if (item.cache_status === "downloading") {
    return "缓存中";
  }
  if (item.cache_status === "queued" || item.cache_status === "pending") {
    return "待缓存";
  }
  return "待缓存";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes <= 0) {
    return "0 MB";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = size >= 100 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function formatCompactBytes(value) {
  const bytes = Number(value || 0);
  if (bytes <= 0) {
    return "";
  }
  const units = ["B", "K", "M", "G", "T"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = size >= 100 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(fractionDigits)}${units[unitIndex]}`;
}

function badgeAnimationDelay(itemId) {
  const duration = 1.45;
  const nowSeconds = Date.now() / 1000;
  let hash = 0;
  for (const char of String(itemId || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997;
  }
  const phase = (nowSeconds + hash * 0.013) % duration;
  return `${-phase}s`;
}

function renderBackupBanner(backup, hasCurrentItem, queueLength, autoRestoredBackup) {
  if (!backup?.available || !autoRestoredBackup) {
    clearBackupBannerTimer();
    elements.backupBanner.classList.add("hidden");
    return;
  }

  if (!state.backupBannerShown) {
    state.backupBannerShown = true;
    state.backupBannerDismissed = false;
    startBackupBannerTimer();
  }

  if (hasCurrentItem || queueLength > 0) {
    elements.backupText.textContent = `已自动恢复上次歌单，共 ${backup.playlist_count} 首。`;
  } else {
    elements.backupText.textContent = `检测到本地备份，共 ${backup.playlist_count} 首。`;
  }

  elements.backupBanner.classList.toggle("hidden", state.backupBannerDismissed);
}

function startBackupBannerTimer() {
  clearBackupBannerTimer();
  state.backupBannerTimer = window.setTimeout(() => {
    dismissBackupBanner();
  }, bannerAutoHideMs);
}

function clearBackupBannerTimer() {
  if (state.backupBannerTimer) {
    window.clearTimeout(state.backupBannerTimer);
    state.backupBannerTimer = null;
  }
}

function dismissBackupBanner() {
  state.backupBannerDismissed = true;
  elements.backupBanner.classList.add("hidden");
  clearBackupBannerTimer();
}

function openConfirm(intent) {
  state.confirmIntent = intent;
  renderConfirmPopover();
}

function closeConfirm() {
  state.confirmIntent = null;
  renderConfirmPopover();
}

function renderConfirmPopover() {
  const intent = state.confirmIntent;
  if (!intent) {
    elements.confirmPopover.classList.add("hidden");
    return;
  }

  const width = 260;
  const popoverHeight = 112;
  const margin = 12;
  const left = Math.min(
    Math.max(intent.x, margin),
    window.innerWidth - width - margin,
  );
  const top = Math.min(
    Math.max(intent.y, margin),
    window.innerHeight - popoverHeight - margin,
  );

  elements.confirmText.textContent = intent.message;
  elements.confirmPopover.style.left = `${left}px`;
  elements.confirmPopover.style.top = `${top}px`;
  elements.confirmPopover.classList.remove("hidden");
}

function anchorPointForEvent(event, fallbackElement) {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return {
      x: event.clientX + 10,
      y: event.clientY + 10,
    };
  }
  const rect = fallbackElement.getBoundingClientRect();
  return {
    x: rect.right - 20,
    y: rect.bottom + 8,
  };
}

function clearDropIndicators() {
  elements.playlist.querySelectorAll(".song-item").forEach((node) => {
    node.classList.remove("dragging", "drop-before", "drop-after");
  });
}

function clearDragState() {
  state.dragItemId = "";
  state.dragTargetId = "";
  state.dragTargetAfter = false;
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

  const draggingNode = elements.playlist.querySelector(
    `.song-item[data-id="${escapeSelector(state.dragItemId)}"]`,
  );
  if (draggingNode) {
    draggingNode.classList.add("dragging");
  }

  if (state.dragTargetId) {
    const targetNode = elements.playlist.querySelector(
      `.song-item[data-id="${escapeSelector(state.dragTargetId)}"]`,
    );
    if (targetNode) {
      targetNode.classList.add(state.dragTargetAfter ? "drop-after" : "drop-before");
    }
    return;
  }

  const candidates = [...elements.playlist.querySelectorAll(".song-item")].filter(
    (node) => node.dataset.id !== state.dragItemId,
  );
  const lastNode = candidates[candidates.length - 1];
  if (lastNode) {
    lastNode.classList.add("drop-after");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function handleAdd(position) {
  const url = elements.urlInput.value.trim();
  if (!url) {
    setFormMessage("请输入 B 站视频链接或 BV 号", true);
    return;
  }

  setFormMessage("正在解析视频信息并加入列表...");
  try {
    state.data = await apiPost("/api/playlist/add", { url, position });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? "已顶歌到下一首" : "已加入列表末尾");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function handleAddByUrl(url, position) {
  setFormMessage("正在从历史记录加入列表...");
  try {
    state.data = await apiPost("/api/playlist/add", { url, position });
    setFormMessage(position === "next" ? "已从历史顶歌到下一首" : "已从历史加入列表");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function discardBackup() {
  try {
    state.data = await apiPost("/api/backup/discard");
    dismissBackupBanner();
    closeConfirm();
    setFormMessage("已清空本地备份。");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function clearPlaylist() {
  try {
    state.data = await apiPost("/api/playlist/clear");
    closeConfirm();
    setFormMessage("播放列表已清空。");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function handleLocalPlaybackEnded() {
  if (state.localAdvanceInFlight) {
    return;
  }
  state.localAdvanceInFlight = true;
  try {
    state.data = await apiPost("/api/player/next");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.localAdvanceInFlight = false;
  }
}

async function reorderPlaylist(itemId, index) {
  state.data = await apiPost("/api/playlist/reorder", { item_id: itemId, index });
  render();
}

async function setCacheLimit(maxCacheItems) {
  if (state.cacheLimitSaving) {
    return;
  }

  const currentValue = Number(state.data?.cache_policy?.max_cache_items || 0);
  if (maxCacheItems === currentValue) {
    return;
  }

  state.cacheLimitSaving = true;
  renderCacheSlider(state.data?.cache_policy);
  try {
    state.data = await apiPost("/api/cache-policy", { max_cache_items: maxCacheItems });
    setFormMessage(`自动缓存窗口已调整为缓存 ${maxCacheItems} 首。`);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
    render();
  } finally {
    state.cacheLimitSaving = false;
    if (state.data) {
      renderCacheSlider(state.data.cache_policy);
    }
  }
}

function updateCacheSliderFill(value, minValue, maxValue) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const current = Number(value);
  const ratio = max <= min ? 1 : (current - min) / (max - min);
  elements.cacheLimitSlider.style.setProperty("--slider-progress", `${ratio * 100}%`);
}

async function handlePlaylistAction(button) {
  const itemId = button.dataset.id;
  const action = button.dataset.action;

  const actionMap = {
    remove: ["/api/playlist/remove", { item_id: itemId }],
    "move-next": ["/api/playlist/move-next", { item_id: itemId }],
    "play-now": ["/api/playlist/play-now", { item_id: itemId }],
  };

  const target = actionMap[action];
  if (!target) {
    return;
  }

  try {
    state.data = await apiPost(target[0], target[1]);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleAdd("tail");
});

elements.queueNextButton.addEventListener("click", async () => {
  await handleAdd("next");
});

elements.copyRemoteUrlButton.addEventListener("click", async () => {
  await copyRemoteUrl();
});

elements.discardBackupButton.addEventListener("click", async () => {
  await discardBackup();
});

elements.dismissBackupButton.addEventListener("click", () => {
  dismissBackupBanner();
});

elements.cacheSettingsToggle.addEventListener("click", () => {
  state.cacheSettingsOpen = !state.cacheSettingsOpen;
  syncCachePanelVisibility();
});

elements.cacheLimitSlider.addEventListener("input", (event) => {
  const currentValue = Number(event.target.value || "1");
  const minValue = Number(elements.cacheLimitSlider.min || "1");
  const maxValue = Number(elements.cacheLimitSlider.max || "5");
  elements.cacheLimitValue.textContent = `缓存 ${currentValue} 首`;
  updateCacheSliderFill(currentValue, minValue, maxValue);
  elements.cacheLimitScale.querySelectorAll("span").forEach((mark) => {
    mark.classList.toggle("active", Number(mark.textContent || "0") === currentValue);
  });
});

elements.cacheLimitSlider.addEventListener("change", async (event) => {
  await setCacheLimit(Number(event.target.value || "1"));
});

elements.clearPlaylistButton.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.clearPlaylistButton);
  openConfirm({
    type: "clear-playlist",
    message: "确定清空播放列表吗？当前正在播放的歌曲不会受影响。",
    x: point.x,
    y: point.y,
  });
});

elements.historyToggleButton.addEventListener("click", () => {
  state.listView = state.listView === "history" ? "queue" : "history";
  render();
});

elements.nextButton.addEventListener("click", async () => {
  try {
    state.data = await apiPost("/api/player/next");
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
});

elements.modeSwitch.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) {
    return;
  }
  try {
    state.data = await apiPost("/api/mode", { mode: button.dataset.mode });
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
});

elements.playlist.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  if (button.dataset.action === "remove") {
    event.stopPropagation();
    const point = anchorPointForEvent(event, button);
    openConfirm({
      type: "remove-item",
      itemId: button.dataset.id,
      message: "确定从播放列表移除这首歌吗？",
      x: point.x,
      y: point.y,
    });
    return;
  }
  await handlePlaylistAction(button);
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
  await handleAddByUrl(url, button.dataset.action === "history-next" ? "next" : "tail");
});

elements.confirmCancel.addEventListener("click", () => {
  closeConfirm();
});

elements.confirmOk.addEventListener("click", async () => {
  const intent = state.confirmIntent;
  if (!intent) {
    return;
  }

  try {
    if (intent.type === "clear-playlist") {
      await clearPlaylist();
      return;
    }
    if (intent.type === "remove-item" && intent.itemId) {
      state.data = await apiPost("/api/playlist/remove", { item_id: intent.itemId });
      closeConfirm();
      setFormMessage("已移除这首歌。");
      render();
    }
  } catch (error) {
    setFormMessage(error.message, true);
  }
});

document.addEventListener("click", (event) => {
  if (state.confirmIntent) {
    if (
      event.target.closest("#confirm-popover") ||
      event.target.closest("#clear-playlist-button") ||
      event.target.closest('button[data-action="remove"]')
    ) {
      return;
    }
    closeConfirm();
  }

  if (state.cacheSettingsOpen && !event.target.closest("#cache-settings")) {
    state.cacheSettingsOpen = false;
    syncCachePanelVisibility();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (state.confirmIntent) {
    closeConfirm();
  }
  if (state.cacheSettingsOpen) {
    state.cacheSettingsOpen = false;
    syncCachePanelVisibility();
  }
});

elements.playlist.addEventListener("dragstart", (event) => {
  const item = event.target.closest(".song-item");
  if (!item) {
    return;
  }
  if (event.target.closest("button")) {
    event.preventDefault();
    return;
  }

  state.dragItemId = item.dataset.id || "";
  state.dragTargetId = "";
  state.dragTargetAfter = false;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.dragItemId);
  }

  syncDropIndicators();
});

elements.playlist.addEventListener("dragover", (event) => {
  if (!state.dragItemId) {
    return;
  }
  event.preventDefault();

  const targetItem = event.target.closest(".song-item");
  if (!targetItem || targetItem.dataset.id === state.dragItemId) {
    state.dragTargetId = "";
    state.dragTargetAfter = false;
    syncDropIndicators();
    return;
  }

  const rect = targetItem.getBoundingClientRect();
  state.dragTargetId = targetItem.dataset.id || "";
  state.dragTargetAfter = event.clientY >= rect.top + rect.height / 2;
  syncDropIndicators();
});

elements.playlist.addEventListener("dragleave", (event) => {
  if (!state.dragItemId) {
    return;
  }
  if (!elements.playlist.contains(event.relatedTarget)) {
    state.dragTargetId = "";
    state.dragTargetAfter = false;
    syncDropIndicators();
  }
});

elements.playlist.addEventListener("dragend", () => {
  clearDragState();
  render();
});

elements.playlist.addEventListener("drop", async (event) => {
  if (!state.dragItemId || !state.data?.playlist?.length) {
    return;
  }
  event.preventDefault();

  const draggedId = state.dragItemId;
  const playlist = state.data.playlist;
  const sourceIndex = playlist.findIndex((item) => item.id === draggedId);
  if (sourceIndex === -1) {
    clearDragState();
    render();
    return;
  }

  let targetIndex = playlist.length - 1;
  if (state.dragTargetId) {
    const hoverIndex = playlist.findIndex((item) => item.id === state.dragTargetId);
    if (hoverIndex !== -1) {
      targetIndex = hoverIndex + (state.dragTargetAfter ? 1 : 0);
      if (sourceIndex < targetIndex) {
        targetIndex -= 1;
      }
    }
  }

  targetIndex = Math.max(0, Math.min(targetIndex, playlist.length - 1));
  clearDragState();

  if (targetIndex === sourceIndex) {
    render();
    return;
  }

  try {
    await reorderPlaylist(draggedId, targetIndex);
  } catch (error) {
    setFormMessage(error.message, true);
  }
});

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
      // Ignore transient polling errors and keep the last state on screen.
    }
  }, pollIntervalMs);
}

window.addEventListener("pagehide", disconnectClient);
window.addEventListener("beforeunload", disconnectClient);

startPolling();
