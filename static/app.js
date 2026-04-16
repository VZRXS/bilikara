const pollIntervalMs = 1000;
const bannerAutoHideMs = 5000;
const stalledRetrySeconds = 5;
const gatchaCooldownMs = 15000;
const localPlayerSyncIntervalMs = 120;
const audioVariantSwitchDebounceMs = 350;
const maxAvOffsetMs = 5000;
const playerClickDelayMs = 220;
const storageKeys = {
  playerVolume: "bilikara.player.volume",
  playerMuted: "bilikara.player.muted",
  avOffsetMs: "bilikara.player.av_offset_ms",
  layoutMode: "bilikara.layout.mode",
};

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  playerSignature: "",
  playerContext: null,
  localPlayerSyncTimer: null,
  listView: "queue",
  cacheSettingsOpen: false,
  cacheLimitSaving: false,
  avOffsetSaving: false,
  localPreferencesHydrated: false,
  localOffsetRestoreApplied: false,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantSwitchTimer: null,
  audioVariantBarExpanded: false,
  audioVariantBarItemId: "",
  backupBannerShown: false,
  backupBannerDismissed: false,
  backupBannerTimer: null,
  backupBannerCountdownTimer: null,
  backupBannerDeadline: 0,
  backupBannerRemainingMs: bannerAutoHideMs,
  backupBannerPaused: false,
  backupDismissHover: false,
  localAdvanceInFlight: false,
  localShouldBePlaying: false,
  localSeekResumePending: false,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  pendingPlaybackRestore: null,
  lastAppliedPlayerControlSeq: 0,
  lastReportedPlayerStatusSignature: "",
  playerFrameClickTimer: null,
  dragItemId: "",
  dragTargetId: "",
  dragTargetAfter: false,
  confirmIntent: null,
  bindingIntent: null,
  retryActivityById: {},
  gatchaCandidate: null,
  gatchaCooldownUntil: 0,
  gatchaCooldownTimer: null,
  gatchaCookieVisible: false,
  bbdownLoginRequesting: false,
  appToastTimer: null,
  layoutMode: "full",
};

const elements = {
  appShell: document.getElementById("app-shell"),
  serviceStatusIndicator: document.getElementById("service-status-indicator"),
  playbackModeSummary: document.getElementById("playback-mode-summary"),
  playbackModeCurrent: document.getElementById("playback-mode-current"),
  cacheChipMeta: document.getElementById("cache-chip-meta"),
  cacheSettings: document.getElementById("cache-settings"),
  cacheSettingsToggle: document.getElementById("cache-settings-toggle"),
  cachePanel: document.getElementById("cache-panel"),
  cacheUsageDetail: document.getElementById("cache-usage-detail"),
  bbdownStatusRow: document.getElementById("bbdown-status-row"),
  bbdownLoginButton: document.getElementById("bbdown-login-button"),
  bbdownLoginPanel: document.getElementById("bbdown-login-panel"),
  bbdownLoginQrImage: document.getElementById("bbdown-login-qr-image"),
  bbdownLoginQrText: document.getElementById("bbdown-login-qr-text"),
  bbdownLoginMessage: document.getElementById("bbdown-login-message"),
  bbdownLoginRefresh: document.getElementById("bbdown-login-refresh"),
  ffmpegStatusRow: document.getElementById("ffmpeg-status-row"),
  bbdownPanelStatusIndicator: document.getElementById("bbdown-panel-status-indicator"),
  ffmpegPanelStatusIndicator: document.getElementById("ffmpeg-panel-status-indicator"),
  cacheLimitValue: document.getElementById("cache-limit-value"),
  cacheLimitSlider: document.getElementById("cache-limit-slider"),
  cacheLimitScale: document.getElementById("cache-limit-scale"),
  currentTitle: document.getElementById("current-title"),
  playerPanel: document.querySelector(".player-panel"),
  playerFrame: document.getElementById("player-frame"),
  playerFullscreenButton: document.getElementById("player-fullscreen-button"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  avSyncPanel: document.getElementById("av-sync-panel"),
  avOffsetInput: document.getElementById("av-offset-input"),
  volumePanel: document.getElementById("volume-panel"),
  volumeMuteButton: document.getElementById("volume-mute-button"),
  volumeSlider: document.getElementById("volume-slider"),
  volumeValue: document.getElementById("volume-value"),
  addForm: document.getElementById("add-form"),
  requesterSelect: document.getElementById("requester-select"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  appToast: document.getElementById("app-toast"),
  sessionUserForm: document.getElementById("session-user-form"),
  sessionUserInput: document.getElementById("session-user-input"),
  sessionUserList: document.getElementById("session-user-list"),
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
  queueCurrentRequester: document.getElementById("queue-current-requester"),
  queueCurrentRetry: document.getElementById("queue-current-retry"),
  listStage: document.getElementById("list-stage"),
  modeSwitch: document.getElementById("mode-switch"),
  layoutModeSwitch: document.getElementById("layout-mode-switch"),
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
  bindingModal: document.getElementById("binding-modal"),
  bindingModalBackdrop: document.getElementById("binding-modal-backdrop"),
  bindingModalText: document.getElementById("binding-modal-text"),
  bindingVideoOptions: document.getElementById("binding-video-options"),
  bindingAudioOptions: document.getElementById("binding-audio-options"),
  bindingModalClose: document.getElementById("binding-modal-close"),
  bindingModalCancel: document.getElementById("binding-modal-cancel"),
  bindingModalConfirm: document.getElementById("binding-modal-confirm"),
  copyRemoteUrlButton: document.getElementById("copy-remote-url-button"),
  remoteQrImage: document.getElementById("remote-qr-image"),
  remoteQrPlaceholder: document.getElementById("remote-qr-placeholder"),
  remoteUrlLink: document.getElementById("remote-url-link"),
  remoteUrlHint: document.getElementById("remote-url-hint"),
  remoteMiniQrImage: document.getElementById("remote-mini-qr-image"),
  remoteMiniQrPlaceholder: document.getElementById("remote-mini-qr-placeholder"),
  remotePopoverQrImage: document.getElementById("remote-popover-qr-image"),
  remotePopoverQrPlaceholder: document.getElementById("remote-popover-qr-placeholder"),
  remotePopoverUrlLink: document.getElementById("remote-popover-url-link"),
  remotePopoverUrlHint: document.getElementById("remote-popover-url-hint"),
  gatchaPanel: document.getElementById("gatcha-panel"),
  gatchaTag: document.getElementById("gatcha-tag"),
  gatchaTitle: document.getElementById("gatcha-title"),
  gatchaStage: document.getElementById("gatcha-stage"),
  gatchaButton: document.getElementById("gatcha-button"),
  gatchaCookieToggle: document.getElementById("gatcha-cookie-toggle"),
  gatchaMainView: document.getElementById("gatcha-main-view"),
  gatchaCookieView: document.getElementById("gatcha-cookie-view"),
  gatchaConfirmButton: document.getElementById("gatcha-confirm-button"),
  gatchaRetryButton: document.getElementById("gatcha-retry-button"),
  gatchaMessage: document.getElementById("gatcha-message"),
  gatchaInitView: document.getElementById("gatcha-init-view"),
  gatchaResultView: document.getElementById("gatcha-result-view"),
  gatchaCandidateTitle: document.getElementById("gatcha-candidate-title"),
  searchForm: document.getElementById("search-form"),
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchMessage: document.getElementById("search-message"),
  searchResults: document.getElementById("search-results"),
  cookieSessdata: document.getElementById("cookie-sessdata"),
  cookieJct: document.getElementById("cookie-jct"),
  saveCookieButton: document.getElementById("save-cookie-button"),
  cookieMessage: document.getElementById("cookie-message"),
};

function setFormMessage(message, isError = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.style.color = isError ? "var(--red)" : "var(--muted)";
}

function setSearchMessage(message, isError = false) {
  if (!elements.searchMessage) {
    return;
  }
  elements.searchMessage.textContent = message || "";
  elements.searchMessage.classList.toggle("is-error", Boolean(isError));
}

function setAppMessage(message, isError = false) {
  if (!elements.appToast) {
    return;
  }
  if (state.appToastTimer) {
    window.clearTimeout(state.appToastTimer);
    state.appToastTimer = null;
  }
  elements.appToast.textContent = message || "";
  elements.appToast.classList.toggle("is-error", Boolean(isError));
  elements.appToast.classList.toggle("hidden", !message);
  if (message) {
    state.appToastTimer = window.setTimeout(() => {
      elements.appToast.classList.add("hidden");
      state.appToastTimer = null;
    }, isError ? 5200 : 3200);
  }
}

function requesterBadgeText(requesterName) {
  const normalized = String(requesterName || "").trim();
  return normalized ? `点歌人 ${normalized}` : "";
}

function selectedRequesterName() {
  return String(elements.requesterSelect?.value || "").trim();
}

function createClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isPlayerPanelFullscreen() {
  return fullscreenElement() === elements.playerPanel;
}

function supportsPlayerFullscreen() {
  return Boolean(
    elements.playerPanel
    && (
      typeof elements.playerPanel.requestFullscreen === "function"
      || typeof elements.playerPanel.webkitRequestFullscreen === "function"
    )
    && (
      typeof document.exitFullscreen === "function"
      || typeof document.webkitExitFullscreen === "function"
    ),
  );
}

function canTogglePlayerFullscreen() {
  return supportsPlayerFullscreen() && (Boolean(state.data?.current_item) || isPlayerPanelFullscreen());
}

function renderPlayerFullscreenButton() {
  const button = elements.playerFullscreenButton;
  if (!button) {
    return;
  }
  const active = isPlayerPanelFullscreen();
  const enabled = canTogglePlayerFullscreen();
  button.disabled = !enabled;
  button.textContent = active ? "退出全屏" : "全屏显示";
  button.setAttribute("aria-pressed", String(active));
  button.title = enabled
    ? (active ? "退出播放器区域全屏" : "将播放器区域切换为全屏")
    : supportsPlayerFullscreen()
      ? "当前没有可全屏的播放内容"
      : "当前环境不支持区域全屏";
}

function requestElementFullscreen(element) {
  if (!element) {
    return Promise.resolve(false);
  }
  if (typeof element.requestFullscreen === "function") {
    return element.requestFullscreen().then(() => true).catch(() => false);
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    element.webkitRequestFullscreen();
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

function exitDocumentFullscreen() {
  if (typeof document.exitFullscreen === "function") {
    return document.exitFullscreen().then(() => true).catch(() => false);
  }
  if (typeof document.webkitExitFullscreen === "function") {
    document.webkitExitFullscreen();
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}

async function togglePlayerFullscreen() {
  if (!supportsPlayerFullscreen()) {
    return;
  }
  if (isPlayerPanelFullscreen()) {
    await exitDocumentFullscreen();
    return;
  }
  if (!state.data?.current_item) {
    return;
  }
  const activeFullscreen = fullscreenElement();
  if (activeFullscreen && activeFullscreen !== elements.playerPanel) {
    await exitDocumentFullscreen();
  }
  await requestElementFullscreen(elements.playerPanel);
}

function clearPlayerFrameClickTimer() {
  if (!state.playerFrameClickTimer) {
    return;
  }
  window.clearTimeout(state.playerFrameClickTimer);
  state.playerFrameClickTimer = null;
}

function toggleMountedLocalPlayback() {
  if (state.data?.playback_mode !== "local" || !state.data?.current_item) {
    return false;
  }
  const video = activePrimaryVideoElement();
  if (!video) {
    return false;
  }
  if (video.paused) {
    state.localShouldBePlaying = true;
    video.play().catch(() => {});
  } else {
    state.localShouldBePlaying = false;
    video.pause();
  }
  return true;
}

function queuePlayerFrameSingleClick() {
  clearPlayerFrameClickTimer();
  state.playerFrameClickTimer = window.setTimeout(() => {
    state.playerFrameClickTimer = null;
    toggleMountedLocalPlayback();
  }, playerClickDelayMs);
}

async function handlePlayerFrameDoubleClick() {
  clearPlayerFrameClickTimer();
  if (!supportsPlayerFullscreen()) {
    return;
  }
  if (!state.data?.current_item && !isPlayerPanelFullscreen()) {
    return;
  }
  await togglePlayerFullscreen();
  renderPlayerFullscreenButton();
}

function readLocalNumber(key, fallbackValue) {
  try {
    const rawValue = window.localStorage?.getItem(key);
    if (rawValue == null) {
      return fallbackValue;
    }
    const numeric = Number(rawValue);
    return Number.isFinite(numeric) ? numeric : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function readLocalBoolean(key, fallbackValue) {
  try {
    const rawValue = window.localStorage?.getItem(key);
    if (rawValue == null) {
      return fallbackValue;
    }
    return rawValue === "true";
  } catch {
    return fallbackValue;
  }
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

function hydrateLocalPreferences() {
  state.localPlayerVolume = Math.max(
    0,
    Math.min(1, readLocalNumber(storageKeys.playerVolume, state.localPlayerVolume)),
  );
  state.localPlayerMuted = readLocalBoolean(storageKeys.playerMuted, state.localPlayerMuted);
  state.layoutMode = normalizeLayoutMode(readLocalString(storageKeys.layoutMode, state.layoutMode));
}

function normalizeLayoutMode(value) {
  if (value === "basic" || value === "normal") {
    return "basic";
  }
  return "full";
}

function renderLayoutMode() {
  const layoutMode = normalizeLayoutMode(state.layoutMode);
  elements.appShell?.classList.toggle("layout-mode-basic", layoutMode === "basic");
  elements.appShell?.classList.toggle("layout-mode-full", layoutMode === "full");
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

function rememberedAvOffsetMs() {
  return boundedAvOffsetMs(readLocalNumber(storageKeys.avOffsetMs, 0));
}

function rememberedVolumePercent() {
  return Math.max(0, Math.min(100, Math.round(readLocalNumber(storageKeys.playerVolume, 1) * 100)));
}

function rememberedMuted() {
  return readLocalBoolean(storageKeys.playerMuted, false);
}

function syncLocalPlayerSettingsFromSnapshot(playerSettings) {
  const volumePercent = Math.max(0, Math.min(100, Number(playerSettings?.volume_percent ?? 100)));
  state.localPlayerVolume = volumePercent / 100;
  state.localPlayerMuted = Boolean(playerSettings?.is_muted);
  persistLocalVolumePreferences();
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
    const error = new Error(data.error || "请求失败");
    error.status = response.status;
    error.code = data.code || "";
    error.payload = data;
    throw error;
  }
  return data.data;
}

async function fetchState() {
  const previousOffsetMs = currentAvOffsetMs();
  const response = await fetch("/api/state", {
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "获取状态失败");
  }
  state.data = payload.data;
  syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
  if (!state.localOffsetRestoreApplied) {
    const rememberedOffset = rememberedAvOffsetMs();
    const serverOffset = Number(payload.data?.player_settings?.av_offset_ms || 0);
    if (rememberedOffset !== serverOffset) {
      state.localOffsetRestoreApplied = true;
      state.data = await apiPost("/api/player/av-offset", { offset_ms: rememberedOffset });
    } else {
      state.localOffsetRestoreApplied = true;
    }
  }
  if (!state.localPreferencesHydrated) {
    const rememberedVolume = rememberedVolumePercent();
    const rememberedMute = rememberedMuted();
    const serverVolume = Number(state.data?.player_settings?.volume_percent ?? 100);
    const serverMuted = Boolean(state.data?.player_settings?.is_muted);
    state.localPreferencesHydrated = true;
    if (rememberedVolume !== serverVolume || rememberedMute !== serverMuted) {
      state.data = await apiPost("/api/player/volume", {
        volume_percent: rememberedVolume,
        is_muted: rememberedMute,
      });
      syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
    }
  }
  render();
  if (previousOffsetMs !== currentAvOffsetMs()) {
    syncMountedLocalPlayer(true);
  }
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
    meta.className = "search-result-meta";

    const title = document.createElement("div");
    title.className = "search-result-title";
    title.textContent = String(item.title || "");

    const url = document.createElement("div");
    url.className = "search-result-url";
    url.textContent = String(item.bvid || "");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "next-button";
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
  setGatchaMessage("正在连接 B 站寻找幸运投稿...");
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "获取幸运歌曲失败");
    }

    state.gatchaCandidate = payload.data;
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
    startGatchaCooldown();
    
    // 切换界面
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

function setCookieMessage(message, isError = false) {
  if (!elements.cookieMessage) {
    return;
  }
  elements.cookieMessage.textContent = message || "";
  elements.cookieMessage.classList.toggle("is-error", Boolean(isError));
}

function renderGatchaCookieFace() {
  const showCookie = Boolean(state.gatchaCookieVisible);
  elements.gatchaPanel?.classList.toggle("is-cookie-view", showCookie);
  elements.gatchaStage?.classList.toggle("is-cookie-view", showCookie);
  if (elements.gatchaTag) {
    elements.gatchaTag.textContent = showCookie ? "Cookie Config" : "gatcha Draw";
  }
  if (elements.gatchaTitle) {
    elements.gatchaTitle.textContent = showCookie ? "Cookie" : "试试运气";
  }
  if (elements.gatchaCookieToggle) {
    elements.gatchaCookieToggle.textContent = showCookie ? "返回抽卡" : "输入 Cookie";
    elements.gatchaCookieToggle.setAttribute("aria-pressed", String(showCookie));
  }
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
  renderRequesterSelect(data.session_users || []);
  renderSessionUsers(data.session_users || []);
  renderCacheSettings(data.bbdown, data.ffmpeg, data.cache_policy);
  renderRemoteAccess(data.remote_access);
  renderLayoutMode();

  renderAudioVariantBar(currentItem, data.playback_mode);
  renderAvSyncControls(data.playback_mode, data.player_settings);
  renderVolumeControls(data.playback_mode);
  applyStoredVolumeToMountedPlayer();
  renderPlayer(currentItem, data.playback_mode);
  renderPlayerFullscreenButton();
  applyRemotePlayerControl(data.player_control_command, currentItem, data.playback_mode);
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
  renderGatchaCookieFace();
  renderConfirmPopover();
}

function activeScrollableList() {
  return state.listView === "history" ? elements.historyList : elements.playlist;
}

function normalizeWheelDelta(event, container) {
  if (event.deltaMode === 1) {
    return event.deltaY * 18;
  }
  if (event.deltaMode === 2) {
    return event.deltaY * container.clientHeight;
  }
  return event.deltaY;
}

function renderRequesterSelect(sessionUsers) {
  const users = Array.isArray(sessionUsers) ? sessionUsers : [];
  const previousValue = selectedRequesterName();
  elements.requesterSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = users.length ? "选择点歌人" : "请先添加用户";
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

function renderSessionUsers(sessionUsers) {
  const users = Array.isArray(sessionUsers) ? sessionUsers : [];
  elements.sessionUserList.innerHTML = "";

  if (!users.length) {
    elements.sessionUserList.innerHTML =
      '<div class="queue-empty session-user-empty">先添加本场用户，服务端和客户端才能开始点歌。</div>';
    return;
  }

  users.forEach((userName, index) => {
    const item = document.createElement("article");
    item.className = "session-user-item";
    item.innerHTML = `
      <div class="session-user-main">
        <span class="session-user-order">${index + 1}</span>
        <strong class="session-user-name">${escapeHtml(userName)}</strong>
      </div>
      <div class="session-user-actions">
        <button type="button" data-action="move-up" data-name="${escapeHtml(userName)}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" data-action="move-down" data-name="${escapeHtml(userName)}" ${index === users.length - 1 ? "disabled" : ""}>下移</button>
        <button type="button" data-action="remove" data-name="${escapeHtml(userName)}" class="danger">删除</button>
      </div>
    `;
    elements.sessionUserList.appendChild(item);
  });
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

function renderRemoteAccess(remoteAccess) {
  const preferredUrl = String(remoteAccess?.preferred_url || "");
  const lanUrls = Array.isArray(remoteAccess?.lan_urls) ? remoteAccess.lan_urls : [];
  const localUrl = String(remoteAccess?.local_url || "");
  const displayUrl = preferredUrl || localUrl || `${window.location.origin}/remote`;
  const displayHint = lanUrls.length > 1
    ? `可用局域网地址: ${lanUrls.join(" · ")}`
    : lanUrls.length === 1
      ? "请确保手机和服务端在同一个局域网内。"
      : "暂未检测到局域网地址，可稍后刷新或手动检查网络。";

  [elements.remoteUrlLink, elements.remotePopoverUrlLink].forEach((link) => {
    if (!link) {
      return;
    }
    link.href = displayUrl;
    link.textContent = displayUrl;
  });

  [elements.remoteUrlHint, elements.remotePopoverUrlHint].forEach((hint) => {
    if (hint) {
      hint.textContent = displayHint;
    }
  });

  renderRemoteQr(displayUrl, [
    { image: elements.remoteQrImage, placeholder: elements.remoteQrPlaceholder, size: 220 },
    { image: elements.remotePopoverQrImage, placeholder: elements.remotePopoverQrPlaceholder, size: 220 },
    { image: elements.remoteMiniQrImage, placeholder: elements.remoteMiniQrPlaceholder, size: 132 },
  ]);
}

function renderRemoteQr(url, targets = []) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    targets.forEach(({ image, placeholder }) => {
      image?.classList.add("hidden");
      if (placeholder) {
        placeholder.textContent = "暂无可用访问地址";
        placeholder.classList.remove("hidden");
      }
    });
    return;
  }

  targets.forEach(({ image, placeholder, size = 220 }) => {
    if (!image || !placeholder) {
      return;
    }

    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&data=${encodeURIComponent(normalizedUrl)}`;
    if (image.dataset.qrUrl === qrUrl) {
      return;
    }

    image.dataset.qrUrl = qrUrl;
    image.classList.add("hidden");
    placeholder.textContent = "正在生成二维码...";
    placeholder.classList.remove("hidden");
    image.onload = () => {
      placeholder.classList.add("hidden");
      image.classList.remove("hidden");
    };
    image.onerror = () => {
      image.classList.add("hidden");
      placeholder.textContent = "二维码生成失败，请稍后重试";
      placeholder.classList.remove("hidden");
    };
    image.src = qrUrl;
  });
}

async function copyRemoteUrl() {
  const url = elements.remoteUrlLink.href;
  if (!url) {
    setAppMessage("当前没有可复制的手机访问地址。", true);
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
    setAppMessage("手机访问链接已复制。");
  } catch {
    setAppMessage("复制失败，请手动复制页面中的链接。", true);
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
  syncToolIndicator(elements.serviceStatusIndicator, aggregateToolStatusState(bbdown, ffmpeg));
  if (elements.playbackModeSummary) {
    elements.playbackModeSummary.textContent = formatPlaybackMode(state.data?.playback_mode);
  }
  if (elements.playbackModeCurrent) {
    elements.playbackModeCurrent.textContent = formatPlaybackMode(state.data?.playback_mode);
  }
  elements.cacheChipMeta.textContent = formatCacheChipMeta(cachePolicy);
  elements.cacheUsageDetail.textContent = formatCacheUsage(cachePolicy);
  syncToolIndicator(elements.bbdownPanelStatusIndicator, bbdown?.state);
  syncToolIndicator(elements.ffmpegPanelStatusIndicator, ffmpeg?.state);
  renderBBDownLogin(bbdown?.login || { logged_in: Boolean(bbdown?.logged_in) });
  if (elements.bbdownStatusRow) {
    elements.bbdownStatusRow.title = `BBDown ${formatBBDownHint(bbdown)}`;
  }
  if (elements.ffmpegStatusRow) {
    elements.ffmpegStatusRow.title = `FFmpeg ${formatFFmpegHint(ffmpeg)}`;
  }

  renderCacheSlider(cachePolicy);
  syncCachePanelVisibility();
}

function renderBBDownLogin(login) {
  const loggedIn = Boolean(login?.logged_in);
  if (elements.bbdownLoginButton) {
    elements.bbdownLoginButton.classList.toggle("is-logged", loggedIn);
    elements.bbdownLoginButton.classList.toggle("is-unlogged", !loggedIn);
    elements.bbdownLoginButton.classList.remove("is-unknown");
    const label = elements.bbdownLoginButton.querySelector(".bbdown-login-label");
    if (label) {
      label.textContent = loggedIn ? "已登录" : "未登录";
    }
    elements.bbdownLoginButton.title = loggedIn ? "点击退出 BBDown 登录" : "点击生成 BBDown 登录二维码";
  }

  elements.bbdownLoginPanel?.classList.toggle("hidden", loggedIn);
  if (loggedIn) {
    return;
  }

  const qrImage = String(login?.qr_image || "");
  const qrText = String(login?.qr_text || "");
  if (elements.bbdownLoginQrImage) {
    elements.bbdownLoginQrImage.classList.toggle("hidden", !qrImage);
    if (qrImage && elements.bbdownLoginQrImage.src !== qrImage) {
      elements.bbdownLoginQrImage.src = qrImage;
    } else if (!qrImage) {
      elements.bbdownLoginQrImage.removeAttribute("src");
    }
  }
  if (elements.bbdownLoginQrText) {
    elements.bbdownLoginQrText.classList.toggle("hidden", Boolean(qrImage) || !qrText);
    elements.bbdownLoginQrText.textContent = qrText;
  }
  if (elements.bbdownLoginMessage) {
    elements.bbdownLoginMessage.textContent = login?.message || "正在准备二维码...";
    elements.bbdownLoginMessage.classList.toggle("is-error", login?.state === "failed");
  }
  maybeStartBBDownLogin(login);
}

function maybeStartBBDownLogin(login, options = {}) {
  if (!state.cacheSettingsOpen || state.bbdownLoginRequesting || login?.logged_in) {
    return;
  }
  const force = Boolean(options.force);
  const loginState = String(login?.state || "idle");
  if (!force && (loginState === "starting" || loginState === "waiting")) {
    return;
  }
  if (!force && loginState !== "idle") {
    return;
  }
  startBBDownLogin({ force });
}

async function startBBDownLogin(options = {}) {
  state.bbdownLoginRequesting = true;
  try {
    state.data = await apiPost("/api/bbdown/login/start", {
      force: Boolean(options.force),
    });
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  } finally {
    state.bbdownLoginRequesting = false;
  }
}

function syncToolIndicator(indicator, state) {
  if (!indicator) {
    return;
  }
  const normalizedState = String(state || "idle");
  indicator.classList.remove("is-ready", "is-failed", "is-loading", "is-pending");
  indicator.textContent = "";
  if (normalizedState === "ready") {
    indicator.classList.add("is-ready");
    indicator.textContent = "✓";
  } else if (normalizedState === "failed") {
    indicator.classList.add("is-failed");
    indicator.textContent = "×";
  } else if (normalizedState === "checking" || normalizedState === "installing" || normalizedState === "loading") {
    indicator.classList.add("is-loading");
  } else {
    indicator.classList.add("is-pending");
    indicator.textContent = "·";
  }
}

function aggregateToolStatusState(bbdown, ffmpeg) {
  const states = [bbdown?.state, ffmpeg?.state].map((value) => String(value || "idle"));
  if (states.includes("failed")) {
    return "failed";
  }
  if (states.every((stateValue) => stateValue === "ready")) {
    return "ready";
  }
  return "loading";
}

function formatPlaybackMode(mode) {
  return mode === "online" ? "在线外挂" : "本地缓存";
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

function syncCachePanelVisibility(options = {}) {
  elements.cacheSettingsToggle.setAttribute("aria-expanded", String(state.cacheSettingsOpen));
  elements.cachePanel.classList.toggle("hidden", !state.cacheSettingsOpen);
  maybeStartBBDownLogin(state.data?.bbdown?.login, {
    force: Boolean(options.forceLoginRefresh),
  });
}

function renderQueueCurrent(currentItem) {
  if (!currentItem) {
    elements.queueCurrent.classList.add("hidden");
    elements.queueCurrent.dataset.state = "idle";
    elements.queueCurrentTag.textContent = "播放中";
    elements.queueCurrentTitle.textContent = "还没有歌曲";
    elements.queueCurrentRetry.classList.add("hidden");
    elements.queueCurrentRetry.removeAttribute("data-id");
    return;
  }

  elements.queueCurrent.classList.remove("hidden");
  const currentState = currentStatusForItem(currentItem);
  elements.queueCurrent.dataset.state = currentState.state;
  elements.queueCurrentTag.textContent = currentState.label;
  elements.queueCurrentTitle.textContent = currentItem.display_title;
  const requesterText = requesterBadgeText(currentItem.requester_name);
  elements.queueCurrentRequester.textContent = requesterText;
  elements.queueCurrentRequester.classList.toggle("hidden", !requesterText);
  syncRetryButton(elements.queueCurrentRetry, currentItem);
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

function audioVariantsForItem(item) {
  if (!item || !Array.isArray(item.audio_variants)) {
    return [];
  }
  return item.audio_variants.filter(
    (variant) => variant && (variant.audio_url || variant.media_url),
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
    return [];
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
  if (!availableParts.length) {
    return [];
  }

  const cachedVariantsById = new Map(
    audioVariantsForItem(item).map((variant) => [String(variant.id || "").trim(), variant]),
  );

  return availableParts.map((entry) => {
    const cachedVariant = cachedVariantsById.get(entry.id);
    return {
      ...entry,
      media_url: String(cachedVariant?.media_url || ""),
      audio_url: String(cachedVariant?.audio_url || ""),
    };
  });
}

function selectedAudioVariantForItem(item) {
  const variants = partOptionsForItem(item).filter((variant) => variant.bound);
  if (!variants.length) {
    return null;
  }
  const selectedId = String(item.selected_audio_variant_id || "").trim();
  if (selectedId) {
    const selected = variants.find((variant) => variant.id === selectedId);
    if (selected) {
      return selected;
    }
  }
  if (item && Array.isArray(item.selected_pages) && Array.isArray(item.selected_parts)) {
    const currentPage = Number(item.page || 0);
    const pageIndex = item.selected_pages.findIndex((page) => Number(page) === currentPage);
    if (pageIndex >= 0 && pageIndex < variants.length) {
      return variants[pageIndex];
    }
  }
  return variants[0];
}

function selectedMediaUrlForItem(item) {
  const selectedVariant = selectedAudioVariantForItem(item);
  return selectedVariant?.media_url || item.local_media_url || "";
}

function selectedVideoUrlForItem(item) {
  return String(item?.video_media_url || item?.local_media_url || "").trim();
}

function selectedAudioUrlForItem(item) {
  const selectedVariant = selectedAudioVariantForItem(item);
  return String(selectedVariant?.audio_url || selectedVariant?.media_url || "").trim();
}

function currentAvOffsetMs() {
  return Number(state.data?.player_settings?.av_offset_ms || 0);
}

function currentAvOffsetSeconds() {
  return currentAvOffsetMs() / 1000;
}

function boundedAvOffsetMs(rawValue) {
  const numeric = Number(rawValue || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(-maxAvOffsetMs, Math.min(maxAvOffsetMs, Math.round(numeric)));
}

function clampMediaTime(media, nextTime) {
  const target = Math.max(0, Number(nextTime || 0));
  if (!Number.isFinite(media?.duration)) {
    return target;
  }
  return Math.min(target, Number(media.duration));
}

function clearLocalPlayerSyncTimer() {
  if (state.localPlayerSyncTimer) {
    window.clearInterval(state.localPlayerSyncTimer);
    state.localPlayerSyncTimer = null;
  }
}

function teardownMountedPlayer() {
  clearLocalPlayerSyncTimer();
  elements.playerFrame.querySelectorAll("video, audio").forEach((media) => {
    try {
      media.pause();
    } catch {
      // Ignore pause failures during teardown.
    }
    try {
      media.removeAttribute("src");
      media.load();
    } catch {
      // Ignore cleanup failures and let DOM replacement finish the teardown.
    }
  });
}

function activeLocalPlayerElements() {
  return {
    video: elements.playerFrame.querySelector('video[data-player-role="video"]'),
    audio: elements.playerFrame.querySelector('audio[data-player-role="audio"]'),
  };
}

function activePrimaryVideoElement() {
  return elements.playerFrame.querySelector("video");
}

function captureLocalPlayerPreferences() {
  const { video, audio } = activeLocalPlayerElements();
  const primaryVideo = video || activePrimaryVideoElement();
  const mediaWithVolume = audio || primaryVideo;
  if (mediaWithVolume) {
    const volume = Number(mediaWithVolume.volume);
    if (Number.isFinite(volume)) {
      state.localPlayerVolume = Math.max(0, Math.min(1, volume));
    }
    state.localPlayerMuted = Boolean(mediaWithVolume.muted);
    persistLocalVolumePreferences();
  }
  if (primaryVideo) {
    state.localShouldBePlaying = !primaryVideo.paused;
  }
}

function applyStoredVolumeToSplitPlayer(video, audio) {
  if (!video || !audio) {
    return;
  }
  video.volume = state.localPlayerVolume;
  video.muted = state.localPlayerMuted;
  audio.volume = state.localPlayerVolume;
  audio.muted = state.localPlayerMuted;
}

function syncSplitPlayerVolumeFromVideo(video, audio) {
  if (!video || !audio) {
    return;
  }
  state.localPlayerVolume = Number.isFinite(video.volume)
    ? Math.max(0, Math.min(1, Number(video.volume)))
    : state.localPlayerVolume;
  state.localPlayerMuted = Boolean(video.muted);
  persistLocalVolumePreferences();
  audio.volume = state.localPlayerVolume;
  audio.muted = state.localPlayerMuted;
  renderVolumeControls(state.data?.playback_mode || "local");
}

function syncSplitPlayer(video, audio, offsetSeconds, forceSeek = false) {
  if (!video || !audio) {
    return;
  }

  syncSplitPlayerVolumeFromVideo(video, audio);
  audio.playbackRate = Number(video.playbackRate || 1) || 1;
  const targetAudioTime = clampMediaTime(audio, Number(video.currentTime || 0) - offsetSeconds);
  const drift = Math.abs(Number(audio.currentTime || 0) - targetAudioTime);

  if (forceSeek || drift > 0.08) {
    audio.currentTime = targetAudioTime;
  }

  if (video.paused) {
    if (!audio.paused) {
      audio.pause();
    }
    return;
  }

  if (targetAudioTime <= 0) {
    if (!audio.paused) {
      audio.pause();
    }
    return;
  }

  if (audio.paused || forceSeek) {
    audio.play().catch(() => {});
  }
}

function syncMountedLocalPlayer(forceSeek = false) {
  const { video, audio } = activeLocalPlayerElements();
  if (!video || !audio) {
    return;
  }
  syncSplitPlayer(video, audio, currentAvOffsetSeconds(), forceSeek);
}

function applyStoredVolumeToSinglePlayer(video) {
  if (!video) {
    return;
  }
  video.volume = state.localPlayerVolume;
  video.muted = state.localPlayerMuted;
}

function applyStoredVolumeToMountedPlayer() {
  const { video, audio } = activeLocalPlayerElements();
  if (video && audio) {
    applyStoredVolumeToSplitPlayer(video, audio);
    return;
  }
  applyStoredVolumeToSinglePlayer(activePrimaryVideoElement());
}

function volumePercentText() {
  return `${Math.round(state.localPlayerVolume * 100)}%`;
}

function setRangeFillPercent(input, percent) {
  if (!input) {
    return;
  }
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  input.style.setProperty("--range-fill-percent", `${normalizedPercent}%`);
}

function renderVolumeControls(playbackMode) {
  if (!elements.volumePanel || !elements.volumeSlider || !elements.volumeMuteButton || !elements.volumeValue) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  const volumePercent = Math.round(state.localPlayerVolume * 100);
  elements.volumePanel.classList.toggle("hidden", !isLocalMode);
  elements.volumeSlider.value = String(volumePercent);
  setRangeFillPercent(elements.volumeSlider, volumePercent);
  elements.volumeValue.textContent = volumePercentText();
  elements.volumeMuteButton.textContent = state.localPlayerMuted ? "取消静音" : "静音";
  elements.volumeMuteButton.classList.toggle("is-muted", state.localPlayerMuted);
}

function persistLocalVolumePreferences() {
  writeLocalPreference(storageKeys.playerVolume, state.localPlayerVolume);
  writeLocalPreference(storageKeys.playerMuted, state.localPlayerMuted);
}

async function setLocalPlayerVolume(nextVolume, { unmute = true } = {}) {
  const normalizedVolume = Math.max(0, Math.min(1, Number(nextVolume || 0)));
  const previousVolume = state.localPlayerVolume;
  const previousMuted = state.localPlayerMuted;
  state.localPlayerVolume = normalizedVolume;
  if (unmute && normalizedVolume > 0) {
    state.localPlayerMuted = false;
  }
  persistLocalVolumePreferences();
  applyStoredVolumeToMountedPlayer();
  renderVolumeControls(state.data?.playback_mode || "local");
  try {
    state.data = await apiPost("/api/player/volume", {
      volume_percent: Math.round(normalizedVolume * 100),
      is_muted: state.localPlayerMuted,
    });
    syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
    render();
  } catch (error) {
    state.localPlayerVolume = previousVolume;
    state.localPlayerMuted = previousMuted;
    persistLocalVolumePreferences();
    applyStoredVolumeToMountedPlayer();
    renderVolumeControls(state.data?.playback_mode || "local");
    setAppMessage(error.message, true);
  }
}

async function toggleLocalPlayerMute() {
  const previousMuted = state.localPlayerMuted;
  state.localPlayerMuted = !state.localPlayerMuted;
  persistLocalVolumePreferences();
  applyStoredVolumeToMountedPlayer();
  renderVolumeControls(state.data?.playback_mode || "local");
  try {
    state.data = await apiPost("/api/player/volume", {
      volume_percent: Math.round(state.localPlayerVolume * 100),
      is_muted: state.localPlayerMuted,
    });
    syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
    render();
  } catch (error) {
    state.localPlayerMuted = previousMuted;
    persistLocalVolumePreferences();
    applyStoredVolumeToMountedPlayer();
    renderVolumeControls(state.data?.playback_mode || "local");
    setAppMessage(error.message, true);
  }
}

function audioVariantSwitchLocked() {
  return state.audioVariantSwitchInFlight || Date.now() < state.audioVariantSwitchUnlockAt;
}

function scheduleAudioVariantSwitchUnlock() {
  if (state.audioVariantSwitchTimer) {
    window.clearTimeout(state.audioVariantSwitchTimer);
    state.audioVariantSwitchTimer = null;
  }
  const remainingMs = Math.max(0, state.audioVariantSwitchUnlockAt - Date.now());
  state.audioVariantSwitchTimer = window.setTimeout(() => {
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
  toggleButton.setAttribute("aria-label", state.audioVariantBarExpanded ? "收起分P列表" : "展开分P列表");
  toggleButton.setAttribute("aria-expanded", String(state.audioVariantBarExpanded));
  toggleButton.innerHTML = '<span aria-hidden="true">▾</span>';

  elements.audioVariantBar.append(list, toggleButton);

  const firstButton = list.querySelector(".audio-variant-button");
  const firstRowHeight = firstButton
    ? Math.ceil(firstButton.getBoundingClientRect().height) + 6
    : 44;
  const isWrapped = list.scrollHeight > firstRowHeight + 2;

  elements.audioVariantBar.classList.toggle("is-collapsed", isWrapped && !state.audioVariantBarExpanded);
  elements.audioVariantBar.classList.toggle("is-expanded", isWrapped && state.audioVariantBarExpanded);
  toggleButton.classList.toggle("hidden", !isWrapped);
  if (isWrapped) {
    list.style.setProperty("--audio-variant-collapsed-height", `${firstRowHeight}px`);
    toggleButton.classList.toggle("is-expanded", state.audioVariantBarExpanded);
  } else {
    state.audioVariantBarExpanded = false;
  }
  elements.audioVariantBar.classList.remove("hidden");
}

function renderAvSyncControls(playbackMode, playerSettings) {
  if (!elements.avSyncPanel || !elements.avOffsetInput) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  elements.avSyncPanel.classList.toggle("hidden", !isLocalMode);
  const offsetMs = boundedAvOffsetMs(playerSettings?.av_offset_ms || 0);
  elements.avOffsetInput.disabled = state.avOffsetSaving;
  if (document.activeElement !== elements.avOffsetInput || state.avOffsetSaving) {
    elements.avOffsetInput.value = String(offsetMs);
  }
}

function renderPlayer(currentItem, playbackMode) {
  const selectedMediaUrl = currentItem ? selectedMediaUrlForItem(currentItem) : "";
  const selectedVideoUrl = currentItem ? selectedVideoUrlForItem(currentItem) : "";
  const selectedAudioUrl = currentItem ? selectedAudioUrlForItem(currentItem) : "";
  const hasSplitPlayback = Boolean(selectedVideoUrl && selectedAudioUrl);
  const signature = [
    currentItem ? currentItem.id : "none",
    playbackMode,
    hasSplitPlayback ? selectedVideoUrl : selectedMediaUrl,
    hasSplitPlayback ? selectedAudioUrl : "",
    currentItem ? currentItem.cache_status : "",
  ].join("|");

  if (signature === state.playerSignature) {
    if (hasSplitPlayback) {
      syncMountedLocalPlayer(false);
    }
    return;
  }

  const previousPlayerContext = state.playerContext;
  if (
    !state.pendingPlaybackRestore
    && playbackMode === "local"
    && currentItem
    && (hasSplitPlayback || selectedMediaUrl)
    && previousPlayerContext?.playbackMode === "local"
    && previousPlayerContext.itemId === currentItem.id
    && (
      previousPlayerContext.mediaUrl !== selectedMediaUrl
      || previousPlayerContext.videoUrl !== selectedVideoUrl
      || previousPlayerContext.audioUrl !== selectedAudioUrl
    )
  ) {
    const currentVideo = elements.playerFrame.querySelector("video");
    if (currentVideo) {
      captureLocalPlayerPreferences();
      state.pendingPlaybackRestore = {
        itemId: currentItem.id,
        variantId: selectedAudioVariantForItem(currentItem)?.id || "",
        currentTime: Number(currentVideo.currentTime || 0),
        wasPlaying: !currentVideo.paused,
      };
    }
  }

  state.playerSignature = signature;
  state.playerContext = {
    itemId: currentItem ? currentItem.id : "",
    mediaUrl: selectedMediaUrl,
    videoUrl: selectedVideoUrl,
    audioUrl: selectedAudioUrl,
    playbackMode,
  };
  captureLocalPlayerPreferences();
  teardownMountedPlayer();

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

  if (hasSplitPlayback) {
    elements.playerFrame.innerHTML = `
      <video
        data-player-role="video"
        controls
        controlsList="nofullscreen"
        autoplay
        playsinline
        preload="metadata"
        src="${escapeHtml(selectedVideoUrl)}"
      ></video>
      <audio
        data-player-role="audio"
        preload="auto"
        src="${escapeHtml(selectedAudioUrl)}"
      ></audio>
    `;
    const video = elements.playerFrame.querySelector('video[data-player-role="video"]');
    const audio = elements.playerFrame.querySelector('audio[data-player-role="audio"]');
    if (video && audio) {
      applyStoredVolumeToSplitPlayer(video, audio);
      const reportCurrentVideoStatus = () => {
        reportPlayerStatus(currentItem.id, video);
      };
      let restoreApplied = false;
      const maybeRestorePlayback = () => {
        const pendingRestore = state.pendingPlaybackRestore;
        if (
          restoreApplied
          || !pendingRestore
          || pendingRestore.itemId !== currentItem.id
          || pendingRestore.variantId !== selectedAudioVariantForItem(currentItem)?.id
          || video.readyState < 1
          || audio.readyState < 1
        ) {
          return;
        }

        restoreApplied = true;
        if (Number.isFinite(pendingRestore.currentTime)) {
          video.currentTime = clampMediaTime(video, pendingRestore.currentTime);
        }
        state.localShouldBePlaying = Boolean(pendingRestore.wasPlaying);
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
        if (pendingRestore.wasPlaying) {
          video.play().catch(() => {});
        }
        state.pendingPlaybackRestore = null;
        reportCurrentVideoStatus();
      };

      video.addEventListener("loadedmetadata", () => {
        maybeRestorePlayback();
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
        reportCurrentVideoStatus();
      });
      audio.addEventListener("loadedmetadata", () => {
        maybeRestorePlayback();
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
      });
      video.addEventListener("play", () => {
        state.localShouldBePlaying = true;
        state.localSeekResumePending = false;
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
        reportCurrentVideoStatus();
      });
      video.addEventListener("pause", () => {
        if (state.localSeekResumePending) {
          return;
        }
        if (document.hidden && state.localShouldBePlaying) {
          window.setTimeout(() => {
            video.play().catch(() => {});
            syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
          }, 0);
          return;
        }
        state.localShouldBePlaying = false;
        if (!audio.paused) {
          audio.pause();
        }
        reportCurrentVideoStatus();
      });
      video.addEventListener("seeking", () => {
        state.localSeekResumePending = !video.paused || state.localShouldBePlaying;
      });
      video.addEventListener("seeked", () => {
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
        if (state.localSeekResumePending) {
          video.play().catch(() => {});
        }
        state.localSeekResumePending = false;
        reportCurrentVideoStatus();
      });
      video.addEventListener("ratechange", () => {
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
      });
      video.addEventListener("volumechange", () => {
        syncSplitPlayerVolumeFromVideo(video, audio);
      });
      video.addEventListener("ended", async () => {
        state.localShouldBePlaying = false;
        state.localSeekResumePending = false;
        audio.pause();
        reportCurrentVideoStatus();
        await handleLocalPlaybackEnded();
      });
      audio.addEventListener("ended", () => {
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
      });
      state.localPlayerSyncTimer = window.setInterval(() => {
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
      }, localPlayerSyncIntervalMs);
      window.setTimeout(() => {
        maybeRestorePlayback();
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
        reportCurrentVideoStatus();
      }, 0);
    }
    return;
  }

  if (selectedMediaUrl) {
    elements.playerFrame.innerHTML = `
      <video
        controls
        controlsList="nofullscreen"
        autoplay
        playsinline
        preload="metadata"
        src="${escapeHtml(selectedMediaUrl)}"
      ></video>
    `;
    const video = elements.playerFrame.querySelector("video");
    if (video) {
      video.volume = state.localPlayerVolume;
      video.muted = state.localPlayerMuted;
      const reportCurrentVideoStatus = () => {
        reportPlayerStatus(currentItem.id, video);
      };
      const pendingRestore = state.pendingPlaybackRestore;
      if (
        pendingRestore
        && pendingRestore.itemId === currentItem.id
        && pendingRestore.variantId === selectedAudioVariantForItem(currentItem)?.id
      ) {
        video.addEventListener("loadedmetadata", () => {
          if (Number.isFinite(pendingRestore.currentTime)) {
            video.currentTime = clampMediaTime(video, pendingRestore.currentTime);
          }
          if (pendingRestore.wasPlaying) {
            video.play().catch(() => {});
          }
          state.pendingPlaybackRestore = null;
          reportCurrentVideoStatus();
        }, { once: true });
      }
      video.addEventListener("loadedmetadata", reportCurrentVideoStatus);
      video.addEventListener("play", () => {
        state.localShouldBePlaying = true;
        state.localSeekResumePending = false;
        reportCurrentVideoStatus();
      });
      video.addEventListener("pause", () => {
        if (state.localSeekResumePending) {
          return;
        }
        if (document.hidden && state.localShouldBePlaying) {
          window.setTimeout(() => {
            video.play().catch(() => {});
          }, 0);
          return;
        }
        state.localShouldBePlaying = false;
        reportCurrentVideoStatus();
      });
      video.addEventListener("seeking", () => {
        state.localSeekResumePending = !video.paused || state.localShouldBePlaying;
      });
      video.addEventListener("seeked", () => {
        if (state.localSeekResumePending) {
          video.play().catch(() => {});
        }
        state.localSeekResumePending = false;
        reportCurrentVideoStatus();
      });
      video.addEventListener("volumechange", () => {
        state.localPlayerVolume = Number.isFinite(video.volume)
          ? Math.max(0, Math.min(1, Number(video.volume)))
          : state.localPlayerVolume;
        state.localPlayerMuted = Boolean(video.muted);
        persistLocalVolumePreferences();
        renderVolumeControls(state.data?.playback_mode || "local");
      });
      video.addEventListener("ended", async () => {
        state.localShouldBePlaying = false;
        state.localSeekResumePending = false;
        reportCurrentVideoStatus();
        await handleLocalPlaybackEnded();
      });
      window.setTimeout(reportCurrentVideoStatus, 0);
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

function applyRemotePlayerControl(command, currentItem, playbackMode) {
  const seq = Number(command?.seq || 0);
  if (!Number.isInteger(seq) || seq <= state.lastAppliedPlayerControlSeq) {
    return;
  }

  const action = String(command?.action || "");
  const commandItemId = String(command?.item_id || "");

  if (
    playbackMode === "local"
    && currentItem
    && (!commandItemId || commandItemId === currentItem.id)
  ) {
    const video = elements.playerFrame.querySelector("video");
    const audio = elements.playerFrame.querySelector('audio[data-player-role="audio"]');
    if (video) {
      if (action === "toggle-play") {
        if (video.paused) {
          state.localShouldBePlaying = true;
          video.play().catch(() => {});
        } else {
          state.localShouldBePlaying = false;
          video.pause();
        }
      } else if (action === "seek-relative") {
        const deltaSeconds = Number(command?.delta_seconds || 0);
        if (Number.isFinite(deltaSeconds) && deltaSeconds !== 0) {
          state.localSeekResumePending = !video.paused || state.localShouldBePlaying;
          const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
          const nextTime = Math.max(0, Number(video.currentTime || 0) + deltaSeconds);
          video.currentTime = Number.isFinite(duration)
            ? Math.min(nextTime, duration)
            : nextTime;
          if (audio) {
            syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
          }
          if (state.localSeekResumePending) {
            video.play().catch(() => {});
          }
        }
      }
    }
  }

  if (!action) {
    return;
  }

  state.lastAppliedPlayerControlSeq = seq;
  ackRemotePlayerControl(seq);
}

async function ackRemotePlayerControl(seq) {
  try {
    await apiPost("/api/player/control-ack", { seq });
  } catch {
    // Ignore ack failures and let the next polling cycle recover.
  }
}

function reportPlayerStatus(itemId, video) {
  const normalizedItemId = String(itemId || "").trim();
  if (!normalizedItemId || !video) {
    return;
  }

  const currentTime = Number(video.currentTime || 0);
  const signature = [
    normalizedItemId,
    video.paused ? "paused" : "playing",
    Math.round(currentTime),
  ].join("|");
  if (signature === state.lastReportedPlayerStatusSignature) {
    return;
  }
  state.lastReportedPlayerStatusSignature = signature;

  apiPost("/api/player/status", {
    item_id: normalizedItemId,
    is_paused: video.paused,
    current_time: currentTime,
  }).catch(() => {});
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
    const retryButton = node.querySelector(".song-retry-button");
    const note = node.querySelector(".song-note");
    const titleNode = node.querySelector(".song-title");
    const requesterNode = node.querySelector(".song-requester");

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
    syncRetryButton(retryButton, item);

    titleNode.textContent = item.display_title;
    const ownerTooltip = ownerTooltipForEntry(item);
    node.title = ownerTooltip;
    titleNode.title = ownerTooltip;
    const requesterText = requesterBadgeText(item.requester_name);
    requesterNode.textContent = requesterText;
    requesterNode.classList.toggle("hidden", !requesterText);

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

function shouldShowRetryButton(item) {
  if (!item) {
    return false;
  }
  const itemId = String(item.id || "");
  if (!itemId) {
    return false;
  }
  if (item.local_media_url || item.cache_status === "ready") {
    delete state.retryActivityById[itemId];
    return false;
  }
  if (item.cache_status === "failed") {
    delete state.retryActivityById[itemId];
    return true;
  }
  if (item.cache_status !== "downloading") {
    delete state.retryActivityById[itemId];
    return false;
  }
  const now = Date.now() / 1000;
  const lastActivity = Number(item.cache_activity_at || 0);
  const cacheSizeBytes = Number(item.cache_size_bytes || 0);
  const cacheProgress = Number(item.cache_progress || 0);
  const cacheMessage = String(item.cache_message || "");
  const previous = state.retryActivityById[itemId];

  const hasFreshActivity = !previous
    || lastActivity > Number(previous.lastActivity || 0)
    || cacheSizeBytes > Number(previous.cacheSizeBytes || 0)
    || cacheProgress > Number(previous.cacheProgress || 0)
    || cacheMessage !== String(previous.cacheMessage || "");

  const observedAt = hasFreshActivity
    ? now
    : Number(previous?.observedAt || 0);

  state.retryActivityById[itemId] = {
    observedAt,
    lastActivity,
    cacheSizeBytes,
    cacheProgress,
    cacheMessage,
  };

  if (observedAt <= 0) {
    return false;
  }
  return now - observedAt >= stalledRetrySeconds;
}

function syncRetryButton(button, item) {
  if (!button) {
    return;
  }
  const visible = shouldShowRetryButton(item);
  button.classList.toggle("hidden", !visible);
  if (!visible) {
    button.removeAttribute("data-id");
    button.removeAttribute("title");
    button.removeAttribute("aria-label");
    return;
  }
  const tooltip = "点击重新下载";
  button.dataset.id = item.id;
  button.title = tooltip;
  button.setAttribute("aria-label", tooltip);
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
    const requester = node.querySelector(".history-requester");
    title.textContent = entry.display_title;
    const ownerTooltip = ownerTooltipForEntry(entry);
    node.title = ownerTooltip;
    title.title = ownerTooltip;
    const requesterText = requesterBadgeText(entry.requester_name);
    requester.textContent = requesterText;
    requester.classList.toggle("hidden", !requesterText);
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

function ownerTooltipForEntry(entry) {
  const ownerName = String(entry?.owner_name || "").trim();
  if (!ownerName) {
    return "";
  }
  return `UP主: ${ownerName}`;
}

function formatBBDownHint(bbdown) {
  if (!bbdown) {
    return "未知";
  }
  const labelMap = {
    idle: "待准备",
    checking: "检查中",
    installing: "更新中",
    ready: "已就绪",
    failed: "异常",
  };
  return labelMap[bbdown.state] || bbdown.state || "未知";
}

function formatFFmpegHint(ffmpeg) {
  if (!ffmpeg) {
    return "未知";
  }
  const labelMap = {
    idle: "待准备",
    checking: "检查中",
    ready: "已就绪",
    failed: "异常",
  };
  return labelMap[ffmpeg.state] || ffmpeg.state || "未知";
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
    updateBackupDismissButton();
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
  state.backupBannerPaused = false;
  state.backupBannerRemainingMs = bannerAutoHideMs;
  state.backupBannerDeadline = Date.now() + state.backupBannerRemainingMs;
  updateBackupDismissButton();
  startBackupBannerCountdown();
}

function startBackupBannerCountdown() {
  clearBackupBannerCountdown();
  state.backupBannerCountdownTimer = window.setInterval(() => {
    if (state.backupBannerPaused) {
      return;
    }
    state.backupBannerRemainingMs = Math.max(0, state.backupBannerDeadline - Date.now());
    updateBackupDismissButton();
    if (state.backupBannerRemainingMs <= 0) {
      dismissBackupBanner();
    }
  }, 250);
}

function pauseBackupBannerTimer() {
  if (state.backupBannerDismissed || state.backupBannerPaused) {
    return;
  }
  state.backupBannerRemainingMs = Math.max(0, state.backupBannerDeadline - Date.now());
  state.backupBannerPaused = true;
  clearBackupBannerCountdown();
  updateBackupDismissButton();
}

function resumeBackupBannerTimer() {
  if (state.backupBannerDismissed || !state.backupBannerPaused) {
    return;
  }
  state.backupBannerPaused = false;
  state.backupBannerDeadline = Date.now() + state.backupBannerRemainingMs;
  updateBackupDismissButton();
  startBackupBannerCountdown();
}

function clearBackupBannerTimer() {
  if (state.backupBannerTimer) {
    window.clearTimeout(state.backupBannerTimer);
    state.backupBannerTimer = null;
  }
  clearBackupBannerCountdown();
  state.backupBannerDeadline = 0;
  state.backupBannerRemainingMs = bannerAutoHideMs;
  state.backupBannerPaused = false;
}

function clearBackupBannerCountdown() {
  if (state.backupBannerCountdownTimer) {
    window.clearInterval(state.backupBannerCountdownTimer);
    state.backupBannerCountdownTimer = null;
  }
}

function updateBackupDismissButton() {
  if (!elements.dismissBackupButton) {
    return;
  }
  if (state.backupBannerDismissed || state.backupDismissHover) {
    elements.dismissBackupButton.textContent = "×";
    return;
  }
  const remainingSeconds = Math.max(1, Math.ceil(state.backupBannerRemainingMs / 1000));
  elements.dismissBackupButton.textContent = `${remainingSeconds}`;
}

function dismissBackupBanner() {
  state.backupBannerDismissed = true;
  elements.backupBanner.classList.add("hidden");
  clearBackupBannerTimer();
  updateBackupDismissButton();
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

function currentBindingSelection() {
  if (!state.bindingIntent) {
    return { selectedVideoPage: null, selectedAudioPages: [] };
  }
  const selectedVideo = elements.bindingVideoOptions.querySelector('input[name="binding-video-page"]:checked');
  const selectedAudioPages = [...elements.bindingAudioOptions.querySelectorAll('input[name="binding-audio-page"]:checked')]
    .map((input) => Number(input.value || 0))
    .filter((page) => page > 0);
  return {
    selectedVideoPage: selectedVideo ? Number(selectedVideo.value || 0) : null,
    selectedAudioPages,
  };
}

function closeBindingModal() {
  state.bindingIntent = null;
  elements.bindingModal?.classList.add("hidden");
  if (elements.bindingVideoOptions) {
    elements.bindingVideoOptions.innerHTML = "";
  }
  if (elements.bindingAudioOptions) {
    elements.bindingAudioOptions.innerHTML = "";
  }
}

function renderBindingOption(inputType, name, entry, checked) {
  const label = document.createElement("label");
  label.className = "selection-option";

  const input = document.createElement("input");
  input.type = inputType;
  input.name = name;
  input.value = String(entry.page);
  input.checked = checked;

  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "selection-option-title";
  title.textContent = `P${entry.page} · ${entry.part}`;
  const meta = document.createElement("div");
  meta.className = "selection-option-meta";
  meta.textContent = entry.duration > 0 ? `${entry.duration}s` : "时长未知";
  copy.append(title, meta);

  label.append(input, copy);
  return label;
}

function openBindingModal(intent, payload) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (!pages.length) {
    setFormMessage("无法读取分P列表", true);
    return;
  }
  state.bindingIntent = {
    ...intent,
    binding: payload,
  };
  elements.bindingModalText.textContent = `《${payload.title || "该视频"}》包含多个分P，请选择要下载的视频画面和音频轨道。`;
  elements.bindingVideoOptions.innerHTML = "";
  elements.bindingAudioOptions.innerHTML = "";

  const preferredPage = Number(payload.preferred_page || pages[0]?.page || 1);
  pages.forEach((entry) => {
    elements.bindingVideoOptions.appendChild(
      renderBindingOption("radio", "binding-video-page", entry, Number(entry.page) === preferredPage),
    );
    elements.bindingAudioOptions.appendChild(
      renderBindingOption("checkbox", "binding-audio-page", entry, Number(entry.page) === preferredPage),
    );
  });
  elements.bindingModal.classList.remove("hidden");
}

async function confirmBindingModal() {
  const intent = state.bindingIntent;
  if (!intent?.url) {
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

  try {
    state.data = await submitAddRequest(intent.url, intent.position || "tail", {
      requesterName: intent.requesterName || selectedRequesterName(),
      allowRepeat: Boolean(intent.allowRepeat),
      selectedVideoPage,
      selectedAudioPages,
    });
    closeBindingModal();
    if (!intent.preserveInput) {
      elements.urlInput.value = "";
    }
    setFormMessage(intent.position === "next" ? "已按绑定关系顶歌到下一首" : "已按绑定关系加入列表");
    render();
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url: intent.url,
          position: intent.position || "tail",
          requesterName: intent.requesterName || selectedRequesterName(),
          preserveInput: intent.preserveInput,
          allowRepeat: intent.allowRepeat,
        },
        error.payload?.binding,
      );
      return;
    }
    if (error.code === "duplicate_session_request") {
      const point = anchorPointForEvent({}, elements.addForm);
      closeBindingModal();
      openConfirm({
        type: "duplicate-add",
        url: intent.url,
        position: intent.position || "tail",
        requesterName: intent.requesterName || selectedRequesterName(),
        preserveInput: intent.preserveInput,
        selectedVideoPage,
        selectedAudioPages,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: point.x,
        y: point.y,
      });
      return;
    }
    setFormMessage(error.message, true);
  }
}

async function handleAdd(position, anchorPoint) {
  const url = elements.urlInput.value.trim();
  const requesterName = selectedRequesterName();
  console.log({
    selectValue: elements.requesterSelect?.value,
    selectOptions: [...(elements.requesterSelect?.options || [])].map((o) => o.value),
    selectedRequesterName: selectedRequesterName(),
    sessionUsers: state.data?.session_users,
  });
  if (!url) {
    setFormMessage("请输入 B 站视频链接或 BV 号", true);
    return;
  }

  setFormMessage("正在解析视频信息并加入列表...");
  try {
    state.data = await submitAddRequest(url, position, { requesterName });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? "已顶歌到下一首" : "已加入列表末尾");
    render();
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url,
          position,
          requesterName,
          preserveInput: true,
        },
        error.payload?.binding,
      );
      return;
    }
    if (error.code === "duplicate_session_request") {
      openConfirm({
        type: "duplicate-add",
        url,
        position,
        requesterName,
        preserveInput: true,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: anchorPoint?.x ?? anchorPointForEvent({}, elements.addForm).x,
        y: anchorPoint?.y ?? anchorPointForEvent({}, elements.addForm).y,
      });
      setFormMessage("这首歌已经在当前列表中，或本次已经点过，确认后可继续加入。");
      return;
    }
    setFormMessage(error.message, true);
  }
}

async function handleAddByUrl(url, position, anchorPoint) {
  const requesterName = selectedRequesterName();
  setFormMessage("正在从历史记录加入列表...");
  try {
    state.data = await submitAddRequest(url, position, { requesterName });
    setFormMessage(position === "next" ? "已从历史顶歌到下一首" : "已从历史加入列表");
    render();
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url,
          position,
          requesterName,
          preserveInput: false,
        },
        error.payload?.binding,
      );
      return;
    }
    if (error.code === "duplicate_session_request") {
      openConfirm({
        type: "duplicate-add",
        url,
        position,
        requesterName,
        preserveInput: false,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: anchorPoint?.x ?? anchorPointForEvent({}, elements.historyList).x,
        y: anchorPoint?.y ?? anchorPointForEvent({}, elements.historyList).y,
      });
      setFormMessage("这首歌已经在当前列表中，或本次已经点过，确认后可继续加入。");
      return;
    }
    setFormMessage(error.message, true);
  }
}

async function discardBackup() {
  try {
    state.data = await apiPost("/api/backup/discard");
    dismissBackupBanner();
    closeConfirm();
    setAppMessage("已清空本地备份。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function clearPlaylist() {
  try {
    state.data = await apiPost("/api/playlist/clear");
    closeConfirm();
    setAppMessage("播放列表已清空。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

/*
  const name = String(elements.sessionUserInput.value || "").trim();
  if (!name) {
    setFormMessage("璇疯緭鍏ョ敤鎴峰悕銆?, true);
    return;
  }
  try {
    state.data = await apiPost("/api/session-users/add", { name });
    elements.sessionUserInput.value = "";
    setFormMessage(`宸叉坊鍔?${name} 鍒版湰鍦篕TV 鐢ㄦ埛鍒楄〃銆?);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function moveSessionUser(name, index) {
  try {
    state.data = await apiPost("/api/session-users/reorder", { name, index });
    setFormMessage("宸叉洿鏂扮敤鎴烽『搴忋€?);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

async function removeSessionUser(name) {
  try {
    state.data = await apiPost("/api/session-users/remove", { name });
    if (elements.requesterSelect.value === name) {
      elements.requesterSelect.value = "";
    }
    setFormMessage(`宸茬Щ闄?${name}銆?);
    render();
  } catch (error) {
    setFormMessage(error.message, true);
  }
}

*/

async function addSessionUser() {
  const name = String(elements.sessionUserInput.value || "").trim();
  if (!name) {
    setAppMessage("请输入用户名。", true);
    return;
  }
  try {
    state.data = await apiPost("/api/session-users/add", { name });
    elements.sessionUserInput.value = "";
    setAppMessage(`已将 ${name} 加入本场 KTV 用户列表。`);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function moveSessionUser(name, index) {
  try {
    state.data = await apiPost("/api/session-users/reorder", { name, index });
    setAppMessage("已更新用户顺序。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function removeSessionUser(name) {
  try {
    state.data = await apiPost("/api/session-users/remove", { name });
    if (elements.requesterSelect.value === name) {
      elements.requesterSelect.value = "";
    }
    setAppMessage(`已移除 ${name}。`);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
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
    setAppMessage(error.message, true);
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
    setAppMessage(`自动缓存窗口已调整为缓存 ${maxCacheItems} 首。`);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
    render();
  } finally {
    state.cacheLimitSaving = false;
    if (state.data) {
      renderCacheSlider(state.data.cache_policy);
    }
  }
}

async function setAvOffset(offsetMs) {
  if (state.avOffsetSaving) {
    return;
  }

  const boundedOffsetMs = boundedAvOffsetMs(offsetMs);
  const currentValue = currentAvOffsetMs();
  if (boundedOffsetMs === currentValue) {
    writeLocalPreference(storageKeys.avOffsetMs, boundedOffsetMs);
    if (elements.avOffsetInput) {
      elements.avOffsetInput.value = String(boundedOffsetMs);
    }
    return;
  }

  state.avOffsetSaving = true;
  renderAvSyncControls(state.data?.playback_mode, state.data?.player_settings);
  try {
    state.data = await apiPost("/api/player/av-offset", { offset_ms: boundedOffsetMs });
    writeLocalPreference(storageKeys.avOffsetMs, boundedOffsetMs);
    render();
    syncMountedLocalPlayer(true)
  } catch (error) {
    setAppMessage(error.message, true);
    render();
  } finally {
    state.avOffsetSaving = false;
    renderAvSyncControls(state.data?.playback_mode, state.data?.player_settings);
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
    "retry-cache": ["/api/cache/retry", { item_id: itemId }],
  };

  const target = actionMap[action];
  if (!target) {
    return;
  }

  try {
    state.data = await apiPost(target[0], target[1]);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const point = anchorPointForEvent(event.submitter || event, elements.addForm);
  await handleAdd("tail", point);
});

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.searchQuery.value || "").trim();
  if (!query) {
    hideSearchResults();
    setSearchMessage("请输入搜索关键词。", true);
    return;
  }

  elements.searchButton.disabled = true;
  setSearchMessage("Searching local cache...");
  try {
    const items = await searchGatchaCache(query);
    renderSearchResults(items);
    setSearchMessage(items.length ? `搜索到 ${items.length} 条缓存结果。` : "缓存中未找到结果。");
  } catch (error) {
    hideSearchResults();
    setSearchMessage(error.message, true);
  } finally {
    elements.searchButton.disabled = false;
  }
});

elements.searchResults.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) {
    return;
  }

  const url = String(button.dataset.url || "").trim();
  if (!url) {
    return;
  }

  button.disabled = true;
  try {
    await handleAddByUrl(url, "tail", anchorPointForEvent(event, button));
    hideSearchResults();
    setSearchMessage("");
    elements.searchQuery.value = "";
  } finally {
    button.disabled = false;
  }
});

elements.sessionUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await addSessionUser();
});

elements.sessionUserList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.data?.session_users?.length) {
    return;
  }

  const name = String(button.dataset.name || "");
  const users = state.data.session_users;
  const index = users.indexOf(name);
  if (!name || index === -1) {
    return;
  }

  if (button.dataset.action === "move-up") {
    await moveSessionUser(name, Math.max(0, index - 1));
    return;
  }
  if (button.dataset.action === "move-down") {
    await moveSessionUser(name, Math.min(users.length - 1, index + 1));
    return;
  }
  if (button.dataset.action === "remove") {
    await removeSessionUser(name);
  }
});

elements.queueNextButton.addEventListener("click", async (event) => {
  const point = anchorPointForEvent(event, elements.queueNextButton);
  await handleAdd("next", point);
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

elements.backupBanner.addEventListener("mouseenter", () => {
  pauseBackupBannerTimer();
});

elements.backupBanner.addEventListener("mouseleave", () => {
  resumeBackupBannerTimer();
});

elements.dismissBackupButton.addEventListener("mouseenter", () => {
  state.backupDismissHover = true;
  updateBackupDismissButton();
});

elements.dismissBackupButton.addEventListener("mouseleave", () => {
  state.backupDismissHover = false;
  updateBackupDismissButton();
});

elements.dismissBackupButton.addEventListener("focus", () => {
  state.backupDismissHover = true;
  updateBackupDismissButton();
});

elements.dismissBackupButton.addEventListener("blur", () => {
  state.backupDismissHover = false;
  updateBackupDismissButton();
});

elements.cacheSettingsToggle.addEventListener("click", () => {
  state.cacheSettingsOpen = !state.cacheSettingsOpen;
  syncCachePanelVisibility({ forceLoginRefresh: state.cacheSettingsOpen });
});

elements.bbdownLoginButton?.addEventListener("click", async () => {
  const loggedIn = Boolean(state.data?.bbdown?.login?.logged_in || state.data?.bbdown?.logged_in);
  if (!loggedIn) {
    await startBBDownLogin({ force: true });
    return;
  }
  try {
    state.data = await apiPost("/api/bbdown/logout");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
});

elements.bbdownLoginRefresh?.addEventListener("click", async () => {
  await startBBDownLogin({ force: true });
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

elements.avSyncPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-step]");
  if (!button) {
    return;
  }
  const step = Number(button.dataset.step || 0);
  if (!Number.isFinite(step) || step === 0) {
    return;
  }
  await setAvOffset(currentAvOffsetMs() + step);
});

elements.avOffsetInput?.addEventListener("change", async (event) => {
  await setAvOffset(event.target.value);
});

elements.avOffsetInput?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  await setAvOffset(event.target.value);
});

elements.volumeSlider?.addEventListener("input", (event) => {
  setRangeFillPercent(event.target, event.target.value);
  setLocalPlayerVolume(Number(event.target.value || "0") / 100);
});

elements.volumeMuteButton?.addEventListener("click", () => {
  toggleLocalPlayerMute();
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

elements.playerFullscreenButton?.addEventListener("click", async () => {
  await togglePlayerFullscreen();
  renderPlayerFullscreenButton();
});

elements.playerFrame?.addEventListener("click", (event) => {
  if (event.target.closest("button, input, select, textarea, a")) {
    return;
  }
  if (!event.target.closest("video")) {
    return;
  }
  queuePlayerFrameSingleClick();
});

elements.playerFrame?.addEventListener("dblclick", (event) => {
  if (event.target.closest("button, input, select, textarea, a")) {
    return;
  }
  handlePlayerFrameDoubleClick().catch(() => {});
});

elements.nextButton.addEventListener("click", async () => {
  try {
    state.data = await apiPost("/api/player/next");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
});

elements.queueCurrentRetry.addEventListener("click", async () => {
  const itemId = elements.queueCurrentRetry.dataset.id;
  if (!itemId) {
    return;
  }
  try {
    state.data = await apiPost("/api/cache/retry", { item_id: itemId });
    setAppMessage("已重新开始缓存。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
});

elements.modeSwitch?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  const nextMode = state.data?.playback_mode === "online" ? "local" : "online";
  try {
    state.data = await apiPost("/api/mode", { mode: nextMode });
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
});

elements.layoutModeSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-layout-mode]");
  if (!button) {
    return;
  }
  setLayoutMode(button.dataset.layoutMode);
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
  if (!button || !state.data?.current_item) {
    return;
  }

  const currentItem = state.data.current_item;
  if (button.dataset.itemId !== currentItem.id) {
    return;
  }

  if (button.dataset.bound !== "true") {
    const page = Number(button.dataset.page || 0);
    if (!page) {
      return;
    }
    try {
      state.data = await submitAddRequest(currentItem.original_url || currentItem.resolved_url, "tail", {
        requesterName: selectedRequesterName(),
        selectedVideoPage: page,
        selectedAudioPages: [page],
      });
      setAppMessage("已将分P加入下载列表");
      render();
    } catch (error) {
      if (error.code === "duplicate_session_request") {
        const point = anchorPointForEvent(event, button);
        openConfirm({
          type: "duplicate-add",
          url: currentItem.original_url || currentItem.resolved_url,
          position: "tail",
          requesterName: selectedRequesterName(),
          preserveInput: false,
          selectedVideoPage: page,
          selectedAudioPages: [page],
          message: duplicateConfirmMessage(
            error.payload?.duplicate_item,
            error.payload?.session_entry,
            error.payload?.active_item,
          ),
          x: point.x,
          y: point.y,
        });
        return;
      }
      setAppMessage(error.message, true);
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

  const video = elements.playerFrame.querySelector("video");
  state.audioVariantSwitchInFlight = true;
  state.audioVariantSwitchUnlockAt = Date.now() + audioVariantSwitchDebounceMs;
  renderAudioVariantBar(currentItem, state.data?.playback_mode);
  state.pendingPlaybackRestore = {
    itemId: currentItem.id,
    variantId: nextVariantId,
    currentTime: video ? Number(video.currentTime || 0) : 0,
    wasPlaying: video ? !video.paused : true,
  };
  try {
    state.data = await apiPost("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
    });
    state.playerSignature = "";
    render();
  } catch (error) {
    state.pendingPlaybackRestore = null;
    setAppMessage(error.message, true);
  } finally {
    state.audioVariantSwitchInFlight = false;
    scheduleAudioVariantSwitchUnlock();
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
  const point = anchorPointForEvent(event, button);
  await handleAddByUrl(url, button.dataset.action === "history-next" ? "next" : "tail", point);
});

elements.confirmCancel.addEventListener("click", () => {
  closeConfirm();
});

elements.bindingModalClose?.addEventListener("click", () => {
  closeBindingModal();
});

elements.bindingModalCancel?.addEventListener("click", () => {
  closeBindingModal();
});

elements.bindingModalBackdrop?.addEventListener("click", () => {
  closeBindingModal();
});

elements.bindingModalConfirm?.addEventListener("click", async () => {
  await confirmBindingModal();
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
      setAppMessage("已移除这首歌。");
      render();
      return;
    }
    if (intent.type === "duplicate-add" && intent.url) {
      state.data = await submitAddRequest(intent.url, intent.position || "tail", {
        requesterName: intent.requesterName || selectedRequesterName(),
        allowRepeat: true,
        selectedVideoPage: Number.isInteger(intent.selectedVideoPage) ? intent.selectedVideoPage : undefined,
        selectedAudioPages: Array.isArray(intent.selectedAudioPages) ? intent.selectedAudioPages : undefined,
      });
      closeConfirm();
      if (!intent.preserveInput) {
        elements.urlInput.value = "";
      } else {
        elements.urlInput.value = "";
      }
      setFormMessage(intent.position === "next" ? "已确认插队到下一首" : "已确认加入列表");
      render();
    }
  } catch (error) {
    if (intent?.type === "duplicate-add") {
      setFormMessage(error.message, true);
    } else {
      setAppMessage(error.message, true);
    }
  }
});

document.addEventListener("click", (event) => {
  if (state.confirmIntent) {
    if (
      event.target.closest("#confirm-popover") ||
      event.target.closest("#clear-playlist-button") ||
      event.target.closest('button[data-action="remove"]') ||
      event.target.closest("#queue-next-button") ||
      event.target.closest("#add-form") ||
      event.target.closest("#history-list")
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
  if (state.bindingIntent) {
    closeBindingModal();
  }
  if (state.confirmIntent) {
    closeConfirm();
  }
  if (state.cacheSettingsOpen) {
    state.cacheSettingsOpen = false;
    syncCachePanelVisibility();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!state.localShouldBePlaying) {
    return;
  }
  const { video, audio } = activeLocalPlayerElements();
  const primaryVideo = video || activePrimaryVideoElement();
  if (primaryVideo) {
    primaryVideo.play().catch(() => {});
  }
  if (video && audio) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  }
});

document.addEventListener("fullscreenchange", renderPlayerFullscreenButton);
document.addEventListener("webkitfullscreenchange", renderPlayerFullscreenButton);

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
    setAppMessage(error.message, true);
  }
});

elements.listStage.addEventListener("wheel", (event) => {
  const list = activeScrollableList();
  if (!list) {
    return;
  }

  const deltaY = normalizeWheelDelta(event, list);
  if (!deltaY || list.scrollHeight <= list.clientHeight) {
    return;
  }

  const nextScrollTop = list.scrollTop + deltaY;
  const maxScrollTop = list.scrollHeight - list.clientHeight;
  const clampedScrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));

  if (clampedScrollTop === list.scrollTop) {
    return;
  }

  event.preventDefault();
  list.scrollTop = clampedScrollTop;
}, { passive: false });

elements.gatchaButton.addEventListener("click", handleGatchaDraw);
elements.gatchaRetryButton.addEventListener("click", handleGatchaDraw);

elements.gatchaCookieToggle?.addEventListener("click", () => {
  state.gatchaCookieVisible = !state.gatchaCookieVisible;
  renderGatchaCookieFace();
});

elements.gatchaConfirmButton.addEventListener("click", async () => {
  if (!state.gatchaCandidate) return;

  const url = state.gatchaCandidate.url;
  const requesterName = selectedRequesterName();
  setGatchaMessage("Nozomi power注入！");
  try {
    state.data = await submitAddRequest(url, "tail", { requesterName });
    setFormMessage(`点歌成功：${state.gatchaCandidate.title}`);
    

    state.gatchaCandidate = null;
    elements.gatchaResultView.classList.add("hidden");
    elements.gatchaInitView.classList.remove("hidden");
    render();
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url,
          position: "tail",
          requesterName,
          preserveInput: false,
        },
        error.payload?.binding,
      );
      return;
    }
    if (error.code === "duplicate_session_request") {
      const point = anchorPointForEvent({}, elements.gatchaConfirmButton);
      openConfirm({
        type: "duplicate-add",
        url,
        position: "tail",
        preserveInput: false,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: point.x,
        y: point.y,
      });
      return;
    }
    setGatchaMessage(error.message, true);
  }
});

elements.saveCookieButton.addEventListener("click", async () => {
  const sessdata = elements.cookieSessdata.value.trim();
  const jct = elements.cookieJct.value.trim();

  setCookieMessage("正在更新 Cookie 配置...");
  try {
    await apiPost("/api/config/cookie", {
      sessdata: sessdata,
      bili_jct: jct
    });
    setCookieMessage("Cookie 已更新，正在拉取稿件信息（第一次拉取稿件数量会影响拉取时间）");
    elements.cookieSessdata.value = "";
    elements.cookieJct.value = "";
  } catch (error) {
    setCookieMessage(error.message, true);
  }
});

async function startPolling() {
  hydrateLocalPreferences();
  renderLayoutMode();
  try {
    await fetchState();
  } catch (error) {
    setAppMessage(error.message, true);
  }
  window.setInterval(async () => {
    try {
      await fetchState();
    } catch {
      // Ignore transient polling errors and keep the last state on screen.
    }
  }, pollIntervalMs);
}

window.addEventListener("pagehide", () => {
  teardownMountedPlayer();
  disconnectClient();
});
window.addEventListener("beforeunload", disconnectClient);

startPolling();
