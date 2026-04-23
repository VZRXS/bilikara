const audioVariantSwitchDebounceMs = 350;
const gatchaCooldownMs = 15000;
const playerSettingsEchoSuppressMs = 1800;
const remoteVolumeCommitDebounceMs = 160;
const viewportScaleResetDelaysMs = [0, 120, 360];
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const storageKeys = {
  layoutMode: "bilikara.remote.layout.mode",
};

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
  remoteAvOffsetSaveSeq: 0,
  remoteAvOffsetEchoSuppressUntil: 0,
  remoteLocalAvOffsetMs: null,
  remoteVolumeSaveSeq: 0,
  remoteSettingsEchoSuppressUntil: 0,
  remoteLocalVolumePercent: null,
  remoteLocalMuted: null,
  remoteVolumeCommitTimer: null,
  audioVariantBarExpanded: false,
  audioVariantBarItemId: "",
  bindingSheetOpen: false,
  bindingIntent: null,
  bindingAccordion: {
    video: false,
    audio: false,
  },
  eventSource: null,
  eventStreamReconnectTimer: null,
  eventStreamRetryMs: eventStreamInitialRetryMs,
  gatchaCandidate: null,
  gatchaCooldownUntil: 0,
  gatchaCooldownTimer: null,
  layoutMode: "full",
  viewportScaleResetTimers: [],
};

const elements = {
  viewportMeta: document.getElementById("viewport-meta"),
  remoteShell: document.getElementById("remote-shell"),
  layoutModeSwitch: document.getElementById("layout-mode-switch"),
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
  bindingSheet: document.getElementById("binding-sheet"),
  bindingSheetBackdrop: document.getElementById("binding-sheet-backdrop"),
  bindingSheetText: document.getElementById("binding-sheet-text"),
  bindingVideoToggle: document.getElementById("binding-video-toggle"),
  bindingAudioToggle: document.getElementById("binding-audio-toggle"),
  bindingSheetVideoOptionsWrap: document.getElementById("binding-sheet-video-options-wrap"),
  bindingSheetAudioOptionsWrap: document.getElementById("binding-sheet-audio-options-wrap"),
  bindingSheetVideoOptions: document.getElementById("binding-sheet-video-options"),
  bindingSheetAudioOptions: document.getElementById("binding-sheet-audio-options"),
  bindingSheetClose: document.getElementById("binding-sheet-close"),
  bindingSheetCancel: document.getElementById("binding-sheet-cancel"),
  bindingSheetConfirm: document.getElementById("binding-sheet-confirm"),
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
  gatchaMessage: document.getElementById("gatcha-message"),
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

function readLocalString(key, fallbackValue) {
  try {
    const rawValue = window.localStorage?.getItem(key);
    return rawValue == null ? fallbackValue : String(rawValue);
  } catch {
    return fallbackValue;
  }
}

function writeLocalPreference(key, value) {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {
    // Ignore storage failures and keep runtime behavior working.
  }
}

function isEditableElement(element) {
  return element instanceof HTMLElement
    && (
      element.tagName === "INPUT"
      || element.tagName === "TEXTAREA"
      || element.tagName === "SELECT"
      || element.isContentEditable
    );
}

function blurActiveEditableElement() {
  const activeElement = document.activeElement;
  if (!isEditableElement(activeElement) || typeof activeElement.blur !== "function") {
    return;
  }
  activeElement.blur();
}

function isAppleTabletClient() {
  const userAgent = String(window.navigator?.userAgent || "");
  if (/iPad/i.test(userAgent)) {
    return true;
  }
  return window.navigator?.platform === "MacIntel" && Number(window.navigator?.maxTouchPoints || 0) > 1;
}

function currentViewportScale() {
  const scale = Number(window.visualViewport?.scale || 1);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function clearViewportScaleResetTimers() {
  state.viewportScaleResetTimers.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  state.viewportScaleResetTimers = [];
}

function forceViewportScaleReset(force = false) {
  if (!isAppleTabletClient() || isEditableElement(document.activeElement) || document.hidden) {
    return;
  }
  const viewportMeta = elements.viewportMeta;
  if (!viewportMeta) {
    return;
  }
  const currentScale = currentViewportScale();
  if (!force && currentScale <= 1.01) {
    return;
  }

  const baseContent = viewportMeta.dataset.baseContent || viewportMeta.getAttribute("content") || "";
  if (!baseContent) {
    return;
  }

  viewportMeta.dataset.baseContent = baseContent;
  viewportMeta.setAttribute("content", `${baseContent}, maximum-scale=1, user-scalable=no`);

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      viewportMeta.setAttribute("content", baseContent);
    });
  });
}

function scheduleViewportScaleReset(force = false) {
  if (!isAppleTabletClient()) {
    return;
  }
  clearViewportScaleResetTimers();
  state.viewportScaleResetTimers = viewportScaleResetDelaysMs.map((delayMs) => (
    window.setTimeout(() => {
      forceViewportScaleReset(force);
    }, delayMs)
  ));
}

function normalizeLayoutMode(value) {
  if (value === "basic" || value === "normal") {
    return "basic";
  }
  return "full";
}

function hydrateLocalPreferences() {
  state.layoutMode = normalizeLayoutMode(readLocalString(storageKeys.layoutMode, state.layoutMode));
}

function renderLayoutMode() {
  const layoutMode = normalizeLayoutMode(state.layoutMode);
  elements.remoteShell?.classList.toggle("layout-mode-basic", layoutMode === "basic");
  elements.remoteShell?.classList.toggle("layout-mode-full", layoutMode === "full");
  elements.layoutModeSwitch?.querySelectorAll("button[data-layout-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.layoutMode === layoutMode);
  });
}

function setLayoutMode(mode) {
  const nextMode = normalizeLayoutMode(mode);
  if (state.layoutMode === nextMode) {
    renderLayoutMode();
    return;
  }
  state.layoutMode = nextMode;
  writeLocalPreference(storageKeys.layoutMode, nextMode);
  renderLayoutMode();
}

function setFormMessage(message, isError = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle("error", isError);
}

function duplicateConfirmMessage(duplicateItem, sessionEntry, activeItem) {
  const title = duplicateItem?.display_title || activeItem?.display_title || sessionEntry?.display_title || "这首歌";
  const count = Number(sessionEntry?.request_count || 0);
  if (activeItem && count > 0) {
    return `《${title}》当前点歌列表里已经有了，而且本次已点过 ${count} 次，仍要继续点歌吗？`;
  }
  if (activeItem) {
    return `《${title}》当前点歌列表里已经有了，仍要继续点歌吗？`;
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
    selected_video_page: Number.isInteger(options.selectedVideoPage) ? options.selectedVideoPage : undefined,
    selected_audio_pages: Array.isArray(options.selectedAudioPages) ? options.selectedAudioPages : undefined,
  });
}

async function submitAddRequestWithDuplicateConfirm(url, position, requesterName, options = {}) {
  try {
    return {
      cancelled: false,
      data: await submitAddRequest(url, position, { requesterName, ...options }),
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
        selectedVideoPage: Number.isInteger(options.selectedVideoPage) ? options.selectedVideoPage : undefined,
        selectedAudioPages: Array.isArray(options.selectedAudioPages) ? options.selectedAudioPages : undefined,
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
  applyStateSnapshot(payload.data, { forceRender: !state.data });
}
function currentStateRevision(snapshot = state.data) {
  const revision = Number(snapshot?.state_revision || 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function applyStateSnapshot(snapshot, { forceRender = false } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  const nextRevision = currentStateRevision(snapshot);
  const currentRevision = currentStateRevision(state.data);
  if (!forceRender && state.data) {
    if (nextRevision > 0 && nextRevision <= currentRevision) {
      return false;
    }
    if (nextRevision === 0 && currentRevision > 0) {
      return false;
    }
  }
  state.data = snapshot;
  render();
  return true;
}

function clearEventStreamReconnectTimer() {
  if (!state.eventStreamReconnectTimer) {
    return;
  }
  window.clearTimeout(state.eventStreamReconnectTimer);
  state.eventStreamReconnectTimer = null;
}

function closeEventStream() {
  clearEventStreamReconnectTimer();
  if (!state.eventSource) {
    return;
  }
  state.eventSource.close();
  state.eventSource = null;
}

function scheduleEventStreamReconnect() {
  clearEventStreamReconnectTimer();
  const delayMs = state.eventStreamRetryMs;
  state.eventStreamReconnectTimer = window.setTimeout(() => {
    state.eventStreamReconnectTimer = null;
    connectStateStream();
  }, delayMs);
  state.eventStreamRetryMs = Math.min(eventStreamMaxRetryMs, delayMs * 2);
}

function connectStateStream() {
  if (typeof window.EventSource !== "function") {
    return;
  }
  closeEventStream();
  const source = new window.EventSource(`/api/events?client_id=${encodeURIComponent(state.clientId)}`);
  state.eventSource = source;

  source.addEventListener("open", () => {
    state.eventStreamRetryMs = eventStreamInitialRetryMs;
  });

  source.addEventListener("state", (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      applyStateSnapshot(snapshot);
      state.eventStreamRetryMs = eventStreamInitialRetryMs;
    } catch {
      // Ignore malformed events and wait for the next valid snapshot.
    }
  });

  source.addEventListener("error", async () => {
    if (state.eventSource !== source) {
      return;
    }
    closeEventStream();
    try {
      await fetchState();
    } catch {
      // Keep the last successful state on screen while reconnecting.
    }
    scheduleEventStreamReconnect();
  });
}

async function searchGatchaCache(query) {
  const normalizedQuery = String(query || "").trim();
  const response = await fetch(`/api/gatcha/search?q=${encodeURIComponent(normalizedQuery)}`, {
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "搜索失败");
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
    empty.textContent = "未找到缓存结果。";
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
    button.textContent = "点歌";

    meta.append(title, url);
    row.append(meta, button);
    elements.searchResults.appendChild(row);
  });
}

async function handleGatchaDraw() {
  if (gatchaCooldownRemainingSeconds() > 0) {
    syncGatchaCooldownButtons();
    return;
  }
  setGatchaMessage("正在随机抽取一首歌曲...");
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "试试运气失败");
    }

    state.gatchaCandidate = payload.data;
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
    startGatchaCooldown();
    elements.gatchaInitView.classList.add("hidden");
    elements.gatchaResultView.classList.remove("hidden");
    setGatchaMessage("");
  } catch (error) {
    setGatchaMessage(error.message, true);
  }
}

function setGatchaMessage(message, isError = false) {
  if (!elements.gatchaMessage) {
    return;
  }
  elements.gatchaMessage.textContent = message || "";
  elements.gatchaMessage.classList.toggle("is-error", Boolean(isError));
}

function gatchaCooldownRemainingSeconds() {
  return Math.max(0, Math.ceil((state.gatchaCooldownUntil - Date.now()) / 1000));
}

function startGatchaCooldown() {
  state.gatchaCooldownUntil = Date.now() + gatchaCooldownMs;
  syncGatchaCooldownButtons();
  if (state.gatchaCooldownTimer) {
    clearInterval(state.gatchaCooldownTimer);
  }
  state.gatchaCooldownTimer = setInterval(() => {
    syncGatchaCooldownButtons();
    if (gatchaCooldownRemainingSeconds() <= 0) {
      clearInterval(state.gatchaCooldownTimer);
      state.gatchaCooldownTimer = null;
    }
  }, 250);
}

function syncGatchaCooldownButtons() {
  const remainingSeconds = gatchaCooldownRemainingSeconds();
  const coolingDown = remainingSeconds > 0;
  const cooldownText = `等待 ${remainingSeconds}s`;
  if (elements.gatchaButton) {
    elements.gatchaButton.disabled = coolingDown;
    elements.gatchaButton.textContent = coolingDown ? cooldownText : "试试运气";
  }
  if (elements.gatchaRetryButton) {
    elements.gatchaRetryButton.disabled = coolingDown;
    elements.gatchaRetryButton.textContent = coolingDown ? cooldownText : "重新再来";
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
  renderLayoutMode();
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
    const modeLabel = playbackMode === "online" ? "在线外挂" : "本地缓存";
    const cacheText = current.cache_message || "等待缓存";
    elements.currentMeta.textContent = `${modeLabel} · ${cacheText}`;
    return;
  }

  elements.currentTitle.textContent = "当前还没有正在播放的歌曲";
  elements.currentRequester.textContent = "";
  elements.currentRequester.classList.add("hidden");
  elements.currentMeta.textContent = "点歌后会进入点歌列表，轮到时由服务端页面播放。";
}

function audioVariantsForItem(item) {
  if (!item || !Array.isArray(item.audio_variants)) {
    return [];
  }
  return item.audio_variants.filter(
    (variant) => variant && variant.audio_url,
  );
}

function variantIdForLabel(page, label, index) {
  const normalized = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = normalized || `track_${index + 1}`;
  return `p${Math.max(1, Number(page || index + 1))}_${suffix}`;
}

function availablePartEntriesForItem(item) {
  if (!item) {
    return [];
  }
  const pages = Array.isArray(item.available_pages) && item.available_pages.length
    ? item.available_pages
    : item.selected_pages;
  const parts = Array.isArray(item.available_parts) && item.available_parts.length
    ? item.available_parts
    : item.selected_parts;
  const durations = Array.isArray(item.available_durations) && item.available_durations.length
    ? item.available_durations
    : item.selected_durations;
  if (!Array.isArray(pages) || !Array.isArray(parts) || pages.length <= 1) {
    return null;
  }
  return pages
    .map((page, index) => {
      const numericPage = Number(page || 0);
      if (!numericPage) {
        return null;
      }
      const label = String(parts[index] || `P${numericPage}`).trim() || `P${numericPage}`;
      return {
        page: numericPage,
        label,
        duration: Number(durations[index] || 0),
        id: variantIdForLabel(numericPage, label, index),
        bound: Array.isArray(item.selected_pages)
          ? item.selected_pages.some((selectedPage) => Number(selectedPage) === numericPage)
          : false,
      };
    })
    .filter(Boolean);
}

function partOptionsForItem(item) {
  const availableParts = availablePartEntriesForItem(item);
  if (!availableParts?.length) {
    return [];
  }
  const cachedVariantsById = new Map(
    audioVariantsForItem(item).map((variant) => [String(variant.id || "").trim(), variant]),
  );
  return availableParts.map((entry) => {
    const cachedVariant = cachedVariantsById.get(entry.id);
    return {
      ...entry,
      audio_url: String(cachedVariant?.audio_url || ""),
      // LEGACY: cachedVariant.media_url used to point to a muxed MP4 variant.
      // Remote controls only need to know whether split audio_url exists.
      // media_url: String(cachedVariant?.media_url || ""),
    };
  });
}

function selectedAudioVariantForItem(item) {
  const variants = partOptionsForItem(item).filter((variant) => variant.bound);
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
    state.audioVariantBarExpanded = false;
    state.audioVariantBarItemId = "";
    return;
  }

  const variants = partOptionsForItem(currentItem);
  if (variants.length <= 1) {
    elements.audioVariantBar.innerHTML = "";
    elements.audioVariantBar.classList.add("hidden");
    state.audioVariantBarExpanded = false;
    state.audioVariantBarItemId = currentItem.id;
    return;
  }

  if (state.audioVariantBarItemId !== currentItem.id) {
    state.audioVariantBarExpanded = false;
    state.audioVariantBarItemId = currentItem.id;
  }

  const selectedVariant = selectedAudioVariantForItem(currentItem);
  const buttonsDisabled = audioVariantSwitchLocked();
  elements.audioVariantBar.innerHTML = "";
  const list = document.createElement("div");
  list.className = "audio-variant-list";
  variants.forEach((variant) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "audio-variant-button";
    button.textContent = variant.label || variant.id;
    button.dataset.itemId = currentItem.id;
    button.dataset.variantId = variant.id;
    button.dataset.page = String(variant.page || "");
    button.dataset.bound = String(Boolean(variant.bound));
    button.disabled = variant.bound ? buttonsDisabled : false;
    button.classList.toggle("active", variant.bound && variant.id === selectedVariant?.id);
    button.classList.toggle("pending-bind", !variant.bound);
    list.appendChild(button);
  });

  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "audio-variant-toggle";
  toggleButton.dataset.action = "toggle-audio-variants";
  toggleButton.setAttribute("aria-expanded", String(state.audioVariantBarExpanded));
  toggleButton.setAttribute("aria-label", state.audioVariantBarExpanded ? "收起分P列表" : "展开分P列表");
  toggleButton.innerHTML = '<span aria-hidden="true">▾</span>';

  elements.audioVariantBar.append(list, toggleButton);

  const firstButton = list.querySelector(".audio-variant-button");
  const firstRowHeight = firstButton
    ? Math.ceil(firstButton.getBoundingClientRect().height) + 6
    : 44;
  const isWrapped = list.scrollHeight > firstRowHeight + 2;
  elements.audioVariantBar.classList.toggle("is-collapsed", isWrapped && !state.audioVariantBarExpanded);
  toggleButton.classList.toggle("hidden", !isWrapped);
  if (isWrapped) {
    list.style.setProperty("--audio-variant-collapsed-height", `${firstRowHeight}px`);
    toggleButton.classList.toggle("is-expanded", state.audioVariantBarExpanded);
  } else {
    state.audioVariantBarExpanded = false;
  }
  elements.audioVariantBar.classList.remove("hidden");
}

function boundedRemoteAvOffsetMs(offsetMs) {
  const numeric = Number(offsetMs || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(-5000, Math.min(5000, Math.round(numeric)));
}

function boundedRemoteVolumePercent(volumePercent) {
  const numeric = Number(volumePercent);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function serverRemoteAvOffsetMs(playerSettings = state.data?.player_settings) {
  return boundedRemoteAvOffsetMs(playerSettings?.av_offset_ms || 0);
}

function currentRemoteAvOffsetMs(playerSettings = state.data?.player_settings) {
  if (state.remoteLocalAvOffsetMs !== null && Date.now() < state.remoteAvOffsetEchoSuppressUntil) {
    return state.remoteLocalAvOffsetMs;
  }
  state.remoteLocalAvOffsetMs = null;
  return serverRemoteAvOffsetMs(playerSettings);
}

function serverRemoteVolumePercent(playerSettings = state.data?.player_settings) {
  return Math.max(0, Math.min(100, Number(playerSettings?.volume_percent ?? 100)));
}

function currentRemoteVolumePercent(playerSettings = state.data?.player_settings) {
  if (state.remoteLocalVolumePercent !== null && Date.now() < state.remoteSettingsEchoSuppressUntil) {
    return state.remoteLocalVolumePercent;
  }
  state.remoteLocalVolumePercent = null;
  return serverRemoteVolumePercent(playerSettings);
}

function serverRemoteMuted(playerSettings = state.data?.player_settings) {
  return Boolean(playerSettings?.is_muted);
}

function currentRemoteMuted(playerSettings = state.data?.player_settings) {
  if (state.remoteLocalMuted !== null && Date.now() < state.remoteSettingsEchoSuppressUntil) {
    return state.remoteLocalMuted;
  }
  state.remoteLocalMuted = null;
  return serverRemoteMuted(playerSettings);
}

function markRemoteAvOffsetWrite(offsetMs) {
  state.remoteLocalAvOffsetMs = boundedRemoteAvOffsetMs(offsetMs);
  state.remoteAvOffsetEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.remoteAvOffsetSaveSeq += 1;
  return state.remoteAvOffsetSaveSeq;
}

function markRemoteVolumeWrite(payload) {
  if (payload.volume_percent !== undefined) {
    state.remoteLocalVolumePercent = payload.volume_percent;
  }
  if (payload.is_muted !== undefined) {
    state.remoteLocalMuted = payload.is_muted;
  }
  state.remoteSettingsEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.remoteVolumeSaveSeq += 1;
  return state.remoteVolumeSaveSeq;
}

function setRangeFillPercent(input, percent) {
  if (!input) {
    return;
  }
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  input.style.setProperty("--range-fill-percent", `${normalizedPercent}%`);
}

function renderRemoteAvSyncControls(playbackMode, playerSettings) {
  if (!elements.remoteAvSyncPanel || !elements.remoteAvOffsetInput) {
    return;
  }
  const isLocalMode = playbackMode === "local" && normalizeLayoutMode(state.layoutMode) === "full";
  elements.remoteAvSyncPanel.classList.toggle("hidden", !isLocalMode);
  if (document.activeElement !== elements.remoteAvOffsetInput) {
    elements.remoteAvOffsetInput.value = String(currentRemoteAvOffsetMs(playerSettings));
  }
}

function renderRemoteVolumeControls(playbackMode, playerSettings) {
  if (!elements.remoteVolumePanel || !elements.remoteVolumeSlider || !elements.remoteVolumeMuteButton || !elements.remoteVolumeValue) {
    return;
  }
  const isLocalMode = playbackMode === "local" && normalizeLayoutMode(state.layoutMode) === "full";
  elements.remoteVolumePanel.classList.toggle("hidden", !isLocalMode);
  const volumePercent = currentRemoteVolumePercent(playerSettings);
  const isMuted = currentRemoteMuted(playerSettings);
  elements.remoteVolumeSlider.value = String(volumePercent);
  setRangeFillPercent(elements.remoteVolumeSlider, volumePercent);
  elements.remoteVolumeValue.textContent = `${Math.round(volumePercent)}%`;
  elements.remoteVolumeMuteButton.textContent = isMuted ? "取消静音" : "静音";
  elements.remoteVolumeMuteButton.classList.toggle("is-muted", isMuted);
}

function openBindingSheet(intent, payload) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (!pages.length) {
    setFormMessage("无法读取分P列表", true);
    return;
  }
  state.bindingIntent = {
    ...intent,
    binding: payload,
  };
  elements.bindingSheetText.textContent = `《${payload.title || "该视频"}》包含多个分P，请选择要下载的视频画面和音频轨道。`;
  elements.bindingSheetVideoOptions.innerHTML = "";
  elements.bindingSheetAudioOptions.innerHTML = "";
  state.bindingAccordion.video = false;
  state.bindingAccordion.audio = false;

  const preferredPage = Number(payload.preferred_page || pages[0]?.page || 1);
  pages.forEach((entry) => {
    elements.bindingSheetVideoOptions.appendChild(renderBindingOption("radio", "binding-video-page", entry, Number(entry.page) === preferredPage));
    elements.bindingSheetAudioOptions.appendChild(renderBindingOption("checkbox", "binding-audio-page", entry, Number(entry.page) === preferredPage));
  });
  renderBindingAccordion();

  state.bindingSheetOpen = true;
  elements.bindingSheet.classList.remove("hidden");
  elements.bindingSheet.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    elements.bindingSheet.classList.add("is-open");
  });
}

function closeBindingSheet() {
  state.bindingSheetOpen = false;
  state.bindingIntent = null;
  state.bindingAccordion.video = false;
  state.bindingAccordion.audio = false;
  elements.bindingSheet.classList.remove("is-open");
  elements.bindingSheet.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (state.bindingSheetOpen) {
      return;
    }
    elements.bindingSheet.classList.add("hidden");
    elements.bindingSheetVideoOptions.innerHTML = "";
    elements.bindingSheetAudioOptions.innerHTML = "";
    renderBindingAccordion();
  }, 280);
}

function renderBindingAccordion() {
  const sections = [
    {
      key: "video",
      button: elements.bindingVideoToggle,
      panel: elements.bindingSheetVideoOptionsWrap,
    },
    {
      key: "audio",
      button: elements.bindingAudioToggle,
      panel: elements.bindingSheetAudioOptionsWrap,
    },
  ];
  sections.forEach(({ key, button, panel }) => {
    if (!button || !panel) {
      return;
    }
    const expanded = Boolean(state.bindingAccordion[key]);
    button.setAttribute("aria-expanded", String(expanded));
    panel.classList.toggle("hidden", !expanded);
  });
}

function renderBindingOption(inputType, name, entry, checked) {
  const label = document.createElement("label");
  label.className = "binding-option";

  const input = document.createElement("input");
  input.type = inputType;
  input.name = name;
  input.value = String(entry.page);
  input.checked = checked;

  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "binding-option-title";
  title.textContent = `P${entry.page} · ${entry.part}`;
  const meta = document.createElement("div");
  meta.className = "binding-option-meta";
  meta.textContent = entry.duration > 0 ? `${entry.duration}s` : "时长未知";
  copy.append(title, meta);

  label.append(input, copy);
  return label;
}

function currentBindingSelection() {
  const selectedVideo = elements.bindingSheetVideoOptions.querySelector('input[name="binding-video-page"]:checked');
  const selectedAudioPages = [...elements.bindingSheetAudioOptions.querySelectorAll('input[name="binding-audio-page"]:checked')]
    .map((input) => Number(input.value || 0))
    .filter((page) => page > 0);
  return {
    selectedVideoPage: selectedVideo ? Number(selectedVideo.value || 0) : null,
    selectedAudioPages,
  };
}

async function confirmBindingSheet() {
  const intent = state.bindingIntent;
  if (!intent?.url || state.submitting) {
    return;
  }
  const { selectedVideoPage, selectedAudioPages } = currentBindingSelection();
  if (!selectedVideoPage) {
    setFormMessage("请先选择一个视频分P", true);
    return;
  }
  if (!selectedAudioPages.length) {
    setFormMessage("请至少选择一个音频分P", true);
    return;
  }

  state.submitting = true;
  setFormMessage(intent.position === "next" ? "正在按绑定关系顶歌..." : "正在按绑定关系加入点歌列表...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(
      intent.url,
      intent.position || "tail",
      intent.requesterName || selectedRequesterName(),
      {
        selectedVideoPage,
        selectedAudioPages,
      },
    );
    if (result.cancelled) {
      setFormMessage("已取消重复添加");
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    closeBindingSheet();
    if (intent.clearInput) {
      elements.urlInput.value = "";
    }
    if (intent.source === "search") {
      hideSearchResults();
      elements.searchQuery.value = "";
    }
    if (intent.source === "gatcha") {
      state.gatchaCandidate = null;
      elements.gatchaResultView.classList.add("hidden");
      elements.gatchaInitView.classList.remove("hidden");
    }
    setFormMessage(intent.position === "next" ? "已按绑定关系顶歌到下一首" : "已按绑定关系加入点歌列表");
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(intent, error.payload?.binding);
      return;
    }
    setFormMessage(error.message, true);
  } finally {
    state.submitting = false;
  }
}

async function setRemoteAvOffset(offsetMs) {
  const boundedOffsetMs = boundedRemoteAvOffsetMs(offsetMs);
  const currentValue = currentRemoteAvOffsetMs();
  if (boundedOffsetMs === currentValue) {
    markRemoteAvOffsetWrite(boundedOffsetMs);
    if (elements.remoteAvOffsetInput) {
      elements.remoteAvOffsetInput.value = String(boundedOffsetMs);
    }
    return;
  }

  const requestSeq = markRemoteAvOffsetWrite(boundedOffsetMs);
  if (elements.remoteAvOffsetInput) {
    elements.remoteAvOffsetInput.value = String(boundedOffsetMs);
  }
  renderRemoteAvSyncControls(state.data?.playback_mode, state.data?.player_settings);
  try {
    const nextData = await apiPost("/api/player/av-offset", { offset_ms: boundedOffsetMs });
    if (requestSeq !== state.remoteAvOffsetSaveSeq) {
      return;
    }
    applyStateSnapshot(nextData);
  } catch (error) {
    if (requestSeq !== state.remoteAvOffsetSaveSeq) {
      return;
    }
    state.remoteLocalAvOffsetMs = null;
    state.remoteAvOffsetEchoSuppressUntil = 0;
    setFormMessage(error.message, true);
    renderRemoteAvSyncControls(state.data?.playback_mode, state.data?.player_settings);
  }
}

function clearRemoteVolumeCommitTimer() {
  if (!state.remoteVolumeCommitTimer) {
    return;
  }
  window.clearTimeout(state.remoteVolumeCommitTimer);
  state.remoteVolumeCommitTimer = null;
}

async function commitRemoteVolumeSettings(payload, requestSeq) {
  try {
    const nextData = await apiPost("/api/player/volume", payload);
    if (requestSeq !== state.remoteVolumeSaveSeq) {
      return;
    }
    applyStateSnapshot(nextData);
  } catch (error) {
    if (requestSeq !== state.remoteVolumeSaveSeq) {
      return;
    }
    state.remoteLocalVolumePercent = null;
    state.remoteLocalMuted = null;
    state.remoteSettingsEchoSuppressUntil = 0;
    setFormMessage(error.message, true);
    renderRemoteVolumeControls(state.data?.playback_mode, state.data?.player_settings);
  }
}

async function setRemoteVolumeSettings({ volumePercent, isMuted } = {}, options = {}) {
  const payload = {};
  if (volumePercent !== undefined) {
    const boundedVolumePercent = boundedRemoteVolumePercent(volumePercent);
    if (boundedVolumePercent === null) {
      return;
    }
    payload.volume_percent = boundedVolumePercent;
  }
  if (isMuted !== undefined) {
    payload.is_muted = Boolean(isMuted);
  }
  if (!Object.keys(payload).length) {
    return;
  }

  const requestSeq = markRemoteVolumeWrite(payload);
  renderRemoteVolumeControls(state.data?.playback_mode, state.data?.player_settings);
  if (options.debounce) {
    clearRemoteVolumeCommitTimer();
    state.remoteVolumeCommitTimer = window.setTimeout(() => {
      state.remoteVolumeCommitTimer = null;
      commitRemoteVolumeSettings(payload, requestSeq);
    }, remoteVolumeCommitDebounceMs);
    return;
  }

  clearRemoteVolumeCommitTimer();
  await commitRemoteVolumeSettings(payload, requestSeq);
}

function hasLocalSplitMedia(item) {
  return Boolean(
    item
      && item.video_media_url
      && Array.isArray(item.audio_variants)
      && item.audio_variants.some((variant) => (
        variant && String(variant.audio_url || "").trim()
      ))
  );
}

function canRemoteControlPlayer(currentItem, playbackMode) {
  return Boolean(currentItem && playbackMode === "local" && hasLocalSplitMedia(currentItem));
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
    const action = button.dataset.controlAction || "";
    const isPending = action === state.playerControlPendingAction;
    const disabled = action === "next-track"
      ? Boolean(state.playerControlPendingAction)
      : !canControl || Boolean(state.playerControlPendingAction);
    button.disabled = disabled;
    button.classList.toggle("is-pending", isPending);
  });

  if (toggleButton) {
    toggleButton.textContent = isPaused ? "播放" : "暂停";
    toggleButton.classList.toggle("is-paused", isPaused);
    toggleButton.classList.toggle("is-playing", !isPaused);
  }

  if (playbackMode !== "local") {
    elements.playerControlHint.textContent = "当前是在线外挂，暂不支持远程控制播放。";
    return;
  }
  if (!hasLocalSplitMedia(currentItem)) {
    elements.playerControlHint.textContent = "当前歌曲还没有完成本地缓存，暂时无法远程控制。";
    return;
  }
  elements.playerControlHint.textContent = isPaused
    ? "当前已暂停，可以恢复播放、前后跳转，或直接切歌。"
    : "当前正在播放，可以暂停、前后跳转，或直接切歌。";
}

function renderListHeader(playlist, history) {
  const isHistoryView = state.listView === "history";
  elements.listTag.textContent = isHistoryView ? "History" : "Requests";
  elements.listTitle.textContent = isHistoryView ? "历史记录" : "点歌列表";
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
    elements.queueList.innerHTML = '<div class="queue-empty">点歌列表暂时是空的，可以继续点下一首歌。</div>';
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
  setFormMessage(position === "next" ? "正在顶歌..." : "正在加入点歌列表...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? "已经顶歌到下一首。" : "已经加入点歌列表。");
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(
        {
          url,
          position,
          requesterName,
          clearInput: true,
          source: "request-form",
        },
        error.payload?.binding,
      );
      return;
    }
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
  setFormMessage(position === "next" ? "正在从历史记录顶歌..." : "正在从历史记录加入点歌列表...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    setFormMessage(position === "next" ? "已从历史记录顶歌到下一首。" : "已从历史记录加入点歌列表。");
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(
        {
          url,
          position,
          requesterName,
          clearInput: false,
          source: "history",
        },
        error.payload?.binding,
      );
      return;
    }
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
    setFormMessage("请先选择点歌人。", true);
    return;
  }

  state.submitting = true;
  setFormMessage("正在添加已选歌曲...");
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage("已取消重复点歌。");
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    hideSearchResults();
    elements.searchQuery.value = "";
    state.gatchaCandidate = null;
    elements.gatchaResultView.classList.add("hidden");
    elements.gatchaInitView.classList.remove("hidden");
    setFormMessage("点歌成功。");
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(
        {
          url,
          position,
          requesterName,
          clearInput: false,
          source: state.gatchaCandidate?.url === url ? "gatcha" : "search",
        },
        error.payload?.binding,
      );
      return;
    }
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
    applyStateSnapshot(await apiPost("/api/player/control", {
      action,
      item_id: currentItem.id,
      delta_seconds: deltaSeconds,
    }));
    setFormMessage(message);
  } catch (error) {
    setFormMessage(error.message, true);
    await fetchState().catch(() => {});
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, state.data?.playback_mode);
}

async function sendPlayerNext() {
  if (!state.data?.current_item) {
    return;
  }
  try {
    state.playerControlPendingAction = "next-track";
    renderPlayerControls(state.data?.current_item, state.data?.playback_mode);
    applyStateSnapshot(await apiPost("/api/player/next"));
    setFormMessage("已切到下一首。");
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
  closeEventStream();
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
    setFormMessage("请输入搜索关键词。", true);
    return;
  }

  elements.searchButton.disabled = true;
  setFormMessage("正在搜索本地目录...");
  try {
    const items = await searchGatchaCache(query);
    renderSearchResults(items);
    setFormMessage(items.length ? `找到 ${items.length} 条缓存结果。` : "未找到缓存结果。");
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

elements.layoutModeSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-layout-mode]");
  if (!button) {
    return;
  }
  setLayoutMode(button.dataset.layoutMode);
});

elements.refreshButton.addEventListener("click", async () => {
  try {
    await fetchState();
    setFormMessage("点歌列表已刷新。");
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
  setRangeFillPercent(event.target, event.target.value);
  await setRemoteVolumeSettings({
    volumePercent: event.target.value,
    isMuted: currentRemoteMuted(state.data?.player_settings),
  }, {
    debounce: true,
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

elements.bindingSheetClose?.addEventListener("click", () => {
  closeBindingSheet();
});

elements.bindingSheetCancel?.addEventListener("click", () => {
  closeBindingSheet();
});

elements.bindingSheetBackdrop?.addEventListener("click", () => {
  closeBindingSheet();
});

elements.bindingSheetConfirm?.addEventListener("click", async () => {
  await confirmBindingSheet();
});

elements.bindingVideoToggle?.addEventListener("click", () => {
  state.bindingAccordion.video = !state.bindingAccordion.video;
  renderBindingAccordion();
});

elements.bindingAudioToggle?.addEventListener("click", () => {
  state.bindingAccordion.audio = !state.bindingAccordion.audio;
  renderBindingAccordion();
});

elements.audioVariantBar.addEventListener("click", async (event) => {
  const toggleButton = event.target.closest('button[data-action="toggle-audio-variants"]');
  if (toggleButton) {
    state.audioVariantBarExpanded = !state.audioVariantBarExpanded;
    if (state.data?.current_item) {
      renderAudioVariantBar(state.data.current_item, state.data.playback_mode);
    }
    return;
  }

  const button = event.target.closest("button[data-variant-id]");
  const currentItem = state.data?.current_item;
  if (!button || !currentItem) {
    return;
  }
  if (button.dataset.itemId !== currentItem.id) {
    return;
  }

  if (button.dataset.bound !== "true") {
    const page = Number(button.dataset.page || 0);
    const requesterName = selectedRequesterName();
    if (!page || state.submitting) {
      return;
    }
    if (!requesterName) {
      setFormMessage("请先选择点歌人", true);
      return;
    }
    try {
      state.submitting = true;
      const result = await submitAddRequestWithDuplicateConfirm(
        currentItem.original_url || currentItem.resolved_url,
        "tail",
        requesterName,
        {
          selectedVideoPage: page,
          selectedAudioPages: [page],
        },
      );
      if (result.cancelled) {
        setFormMessage("已取消重复添加");
        return;
      }
      applyStateSnapshot(result.data, { forceRender: true });
      setFormMessage("已将分P加入缓存任务");
    } catch (error) {
      setFormMessage(error.message, true);
    } finally {
      state.submitting = false;
    }
    return;
  }

  if (audioVariantSwitchLocked()) {
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
    applyStateSnapshot(await apiPost("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
    }));
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
  if (action === "next-track") {
    await sendPlayerNext();
    return;
  }
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.bindingSheetOpen) {
    closeBindingSheet();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearViewportScaleResetTimers();
    blurActiveEditableElement();
    return;
  }
  scheduleViewportScaleReset();
});

window.addEventListener("pageshow", () => {
  window.requestAnimationFrame(() => {
    blurActiveEditableElement();
  });
  scheduleViewportScaleReset();
});

window.addEventListener("focus", () => {
  scheduleViewportScaleReset();
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    if (document.hidden || isEditableElement(document.activeElement) || currentViewportScale() <= 1.01) {
      return;
    }
    scheduleViewportScaleReset();
  });
}

window.addEventListener("pagehide", blurActiveEditableElement);
window.addEventListener("pagehide", clearViewportScaleResetTimers);
window.addEventListener("pagehide", disconnectClient);
window.addEventListener("beforeunload", disconnectClient);

async function startRemoteSession() {
  hydrateLocalPreferences();
  renderLayoutMode();
  try {
    await fetchState();
  } catch (error) {
    setFormMessage(error.message, true);
  }
  connectStateStream();
}

startRemoteSession();
