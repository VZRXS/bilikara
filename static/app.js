const pollIntervalMs = 1000;
const bannerAutoHideMs = 5000;
const stalledRetrySeconds = 5;
const localPlayerSyncIntervalMs = 120;
const localPlayerHardSyncThresholdSeconds = 0.08;
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerSeekSettlePollMs = 50;
const localPlayerSeekSettleMaxMs = 1400;
const audioVariantSwitchDebounceMs = 350;
const playerSettingsEchoSuppressMs = 1800;
const maxAvOffsetMs = 5000;
const playerClickDelayMs = 220;
const playerControlsAutoHideMs = 5000;
const defaultSongAdvanceDelaySeconds = 3;
const maxSongAdvanceDelaySeconds = 30;
const appUpdateCheckTimeoutMs = 10000;
const fullscreenRequestToastMs = 4200;
const fullscreenRequestToastFadeMs = 500;
const localAdvanceOverlayFadeMs = 500;
const localAdvanceOverlayMaxRows = 5;
const storageKeys = {
  playerVolume: "bilikara.player.volume",
  playerMuted: "bilikara.player.muted",
  avOffsetMs: "bilikara.player.av_offset_ms",
  layoutMode: "bilikara.layout.mode",
  updatePreview: "bilikara.update.preview",
};

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  lastPollRenderSignature: "",
  currentTitleRenderSignature: "",
  listHeaderRenderSignature: "",
  requesterSelectRenderSignature: "",
  sessionUsersRenderSignature: "",
  remoteAccessRenderSignature: "",
  cacheSettingsRenderSignature: "",
  bbdownLoginRenderSignature: "",
  searchCookieFaceRenderSignature: "",
  gatchaUidFaceRenderSignature: "",
  historyRenderSignature: "",
  playlistEmptyRenderSignature: "",
  cacheSliderRenderSignature: "",
  advanceDelaySliderRenderSignature: "",
  advanceDelaySaving: false,
  cachePolicyControlRenderSignature: "",
  playerFullscreenButtonRenderSignature: "",
  volumeControlsRenderSignature: "",
  queueCurrentRenderSignature: "",
  audioVariantBarRenderSignature: "",
  playerSignature: "",
  playerContext: null,
  localPlayerSyncTimer: null,
  localPlayerControlsHideTimer: null,
  listView: "queue",
  listStageView: "",
  listFlipTimer: null,
  listFlipFrame: null,
  cacheSettingsOpen: false,
  cacheLimitSaving: false,
  cachePolicySaving: false,
  avOffsetSaving: false,
  avOffsetSaveSeq: 0,
  avOffsetEchoSuppressUntil: 0,
  localAvOffsetMs: null,
  volumeSaveSeq: 0,
  playerSettingsEchoSuppressUntil: 0,
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
  localAdvanceDelayTimer: null,
  localAdvanceCountdownTimer: null,
  localAdvanceOverlayHideTimer: null,
  localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0,
  localAdvanceOverlayMode: "",
  localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null,
  localAdvanceOverlayTotalCount: null,
  pendingSongTransitionOverlayData: null,
  lastSongTransitionOverlayKey: "",
  localAdvanceDelayToken: 0,
  localAdvanceDelayItemId: "",
  localShouldBePlaying: false,
  localSeekResumePending: false,
  localSeekSettling: false,
  localSeekResumeAfterSettle: false,
  localSeekSettleStartedAt: 0,
  localSeekSettleTimer: null,
  localSeekSettleCallback: null,
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
  searchCookieVisible: false,
  searchStageView: "",
  searchFlipTimer: null,
  searchFlipFrame: null,
  followBrowseData: null,
  followBrowseSelectedUid: "",
  followBrowseLoading: false,
  followBrowseRenderSignature: "",
  gatchaUidVisible: false,
  gatchaUidSaving: false,
  gatchaRefreshSaving: false,
  bbdownLoginRequesting: false,
  updateChecking: false,
  updatePreviewEnabled: false,
  appToastTimer: null,
  fullscreenRequestToastTimer: null,
  fullscreenRequestToastHideTimer: null,
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
  cacheLimitSlider: document.getElementById("cache-limit-slider"),
  cacheLimitScale: document.getElementById("cache-limit-scale"),
  advanceDelaySlider: document.getElementById("advance-delay-slider"),
  advanceDelayScale: document.getElementById("advance-delay-scale"),
  cacheQualitySelect: document.getElementById("cache-quality-select"),
  cacheHiresCheckbox: document.getElementById("cache-hires-checkbox"),
  dataResetButton: document.getElementById("data-reset-button"),
  currentCacheRetryButton: document.getElementById("current-cache-retry-button"),
  playerResetButton: document.getElementById("player-reset-button"),
  updatePreviewCheckbox: document.getElementById("update-preview-checkbox"),
  updateCheckButton: document.getElementById("update-check-button"),
  currentTitle: document.getElementById("current-title"),
  playerPanel: document.querySelector(".player-panel"),
  playerFrame: document.getElementById("player-frame"),
  playerFullscreenButton: document.getElementById("player-fullscreen-button"),
  fullscreenRequestToast: document.getElementById("fullscreen-request-toast"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  avSyncPanel: document.getElementById("av-sync-panel"),
  avOffsetInput: document.getElementById("av-offset-input"),
  avOffsetResetButton: document.getElementById("av-offset-reset-button"),
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
  queueCurrentProgressBadge: document.getElementById("queue-current-progress-badge"),
  queueCurrentIconWrap: document.getElementById("queue-current-icon-wrap"),
  queueCurrentTag: document.getElementById("queue-current-tag"),
  queueCurrentTitle: document.getElementById("queue-current-title"),
  queueCurrentRequester: document.getElementById("queue-current-requester"),
  queueCurrentRetry: document.getElementById("queue-current-retry"),
  listStage: document.getElementById("list-stage"),
  modeSwitch: document.getElementById("mode-switch"),
  layoutModeSwitch: document.getElementById("layout-mode-switch"),
  nextButton: document.getElementById("next-button"),
  queueNextButton: document.getElementById("queue-next-button"),
  resortPlaylistButton: document.getElementById("resort-playlist-button"),
  historyToggleButton: document.getElementById("history-toggle-button"),
  clearPlaylistButton: document.getElementById("clear-playlist-button"),
  historyExportButton: document.getElementById("history-export-button"),
  clearHistoryButton: document.getElementById("clear-history-button"),
  playlistTemplate: document.getElementById("playlist-item-template"),
  historyTemplate: document.getElementById("history-item-template"),
  confirmPopover: document.getElementById("confirm-popover"),
  confirmText: document.getElementById("confirm-text"),
  confirmSource: document.getElementById("confirm-source"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmSecondary: document.getElementById("confirm-secondary"),
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
  searchPanel: document.getElementById("search-panel"),
  searchTag: document.getElementById("search-tag"),
  searchTitle: document.getElementById("search-title"),
  searchCookieToggle: document.getElementById("search-cookie-toggle"),
  searchStage: document.getElementById("search-stage"),
  searchMainView: document.getElementById("search-main-view"),
  searchCookieView: document.getElementById("search-cookie-view"),
  gatchaPanel: document.getElementById("gatcha-panel"),
  gatchaTag: document.getElementById("gatcha-tag"),
  gatchaTitle: document.getElementById("gatcha-title"),
  gatchaStage: document.getElementById("gatcha-stage"),
  gatchaButton: document.getElementById("gatcha-button"),
  gatchaUidToggle: document.getElementById("gatcha-uid-toggle"),
  gatchaMainView: document.getElementById("gatcha-main-view"),
  gatchaUidView: document.getElementById("gatcha-uid-view"),
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
  followUpListView: document.getElementById("follow-up-list-view"),
  followUpGrid: document.getElementById("follow-up-grid"),
  followUpItemsView: document.getElementById("follow-up-items-view"),
  followBrowseBack: document.getElementById("follow-browse-back"),
  followBrowseTitle: document.getElementById("follow-browse-title"),
  followBrowseCount: document.getElementById("follow-browse-count"),
  followSearchForm: document.getElementById("follow-search-form"),
  followSearchQuery: document.getElementById("follow-search-query"),
  followSearchButton: document.getElementById("follow-search-button"),
  followSongResults: document.getElementById("follow-song-results"),
  followBrowseMessage: document.getElementById("follow-browse-message"),
  gatchaUidForm: document.getElementById("gatcha-uid-form"),
  gatchaUidInput: document.getElementById("gatcha-uid-input"),
  addGatchaUidButton: document.getElementById("add-gatcha-uid-button"),
  refreshGatchaCacheButton: document.getElementById("refresh-gatcha-cache-button"),
  gatchaUidMessage: document.getElementById("gatcha-uid-message"),
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

function hideFullscreenRequestToast() {
  if (state.fullscreenRequestToastTimer) {
    window.clearTimeout(state.fullscreenRequestToastTimer);
    state.fullscreenRequestToastTimer = null;
  }
  const toast = elements.fullscreenRequestToast;
  if (!toast || toast.classList.contains("hidden")) {
    return;
  }
  toast.classList.remove("is-visible");
  if (state.fullscreenRequestToastHideTimer) {
    window.clearTimeout(state.fullscreenRequestToastHideTimer);
  }
  state.fullscreenRequestToastHideTimer = window.setTimeout(() => {
    toast.classList.add("hidden");
    state.fullscreenRequestToastHideTimer = null;
  }, fullscreenRequestToastFadeMs);
}

function showFullscreenRequestToast(title) {
  const toast = elements.fullscreenRequestToast;
  const normalizedTitle = String(title || "").trim();
  if (!toast || !normalizedTitle || !isPlayerPanelFullscreen()) {
    return;
  }
  if (state.fullscreenRequestToastTimer) {
    window.clearTimeout(state.fullscreenRequestToastTimer);
    state.fullscreenRequestToastTimer = null;
  }
  if (state.fullscreenRequestToastHideTimer) {
    window.clearTimeout(state.fullscreenRequestToastHideTimer);
    state.fullscreenRequestToastHideTimer = null;
  }
  toast.replaceChildren();
  const label = document.createElement("span");
  label.className = "fullscreen-request-toast-label";
  label.textContent = "新点歌";
  const titleNode = document.createElement("span");
  titleNode.className = "fullscreen-request-toast-title";
  titleNode.textContent = normalizedTitle;
  toast.append(label, titleNode);
  toast.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });
  state.fullscreenRequestToastTimer = window.setTimeout(() => {
    hideFullscreenRequestToast();
  }, fullscreenRequestToastMs);
}

function maybeShowIncomingRequestToast(previousData, nextData) {
  if (!previousData || !nextData || !isPlayerPanelFullscreen()) {
    return;
  }
  const previousId = currentItemIdFromData(previousData);
  const nextId = currentItemIdFromData(nextData);
  if (previousId !== nextId && nextId) {
    return;
  }
  const previousItems = [
    previousData.current_item,
    ...(Array.isArray(previousData.playlist) ? previousData.playlist : []),
  ];
  const previousIds = new Set(previousItems.map((item) => String(item?.id || "")).filter(Boolean));
  const nextItems = [
    ...(Array.isArray(nextData.playlist) ? nextData.playlist : []),
    nextData.current_item,
  ];
  const newItems = nextItems
    .filter((item) => item?.id && !previousIds.has(String(item.id)));
  if (!newItems.length) {
    return;
  }
  const item = newItems[newItems.length - 1];
  showFullscreenRequestToast(item.display_title || item.title || "新点歌");
}

function requesterBadgeText(requesterName) {
  const normalized = String(requesterName || "").trim();
  return normalized ? `点歌人 ${normalized}` : "";
}

function setTextContent(element, value) {
  if (!element) {
    return;
  }
  const nextValue = String(value ?? "");
  if (element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

function setClassToggle(element, className, force) {
  if (!element) {
    return;
  }
  const shouldHaveClass = Boolean(force);
  if (element.classList.contains(className) !== shouldHaveClass) {
    element.classList.toggle(className, shouldHaveClass);
  }
}

function setElementAttribute(element, name, value) {
  if (!element) {
    return;
  }
  const nextValue = String(value ?? "");
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

function setElementTitle(element, value) {
  if (!element) {
    return;
  }
  const nextValue = String(value ?? "");
  if (element.title !== nextValue) {
    element.title = nextValue;
  }
}

function selectedRequesterName() {
  return String(elements.requesterSelect?.value || "").trim();
}

function hasSessionUsers() {
  return Array.isArray(state.data?.session_users) && state.data.session_users.length > 0;
}

function validatedRequesterNameForAdd(showMessage = setFormMessage) {
  if (!hasSessionUsers()) {
    showMessage("请先在服务端添加本场 KTV 用户", true);
    return "";
  }
  const requesterName = selectedRequesterName();
  if (!requesterName) {
    showMessage("请先选择点歌人。", true);
    return "";
  }
  return requesterName;
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
  const label = active ? "退出全屏" : "全屏显示";
  const title = enabled
    ? (active ? "退出播放器区域全屏" : "将播放器区域切换为全屏")
    : supportsPlayerFullscreen()
      ? "当前没有可全屏的播放内容"
      : "当前环境不支持区域全屏";
  const signature = JSON.stringify({ active, enabled, label, title });

  if (signature === state.playerFullscreenButtonRenderSignature) {
    return;
  }
  state.playerFullscreenButtonRenderSignature = signature;

  if (button.disabled !== !enabled) {
    button.disabled = !enabled;
  }
  setTextContent(button, label);
  setElementAttribute(button, "aria-pressed", String(active));
  setElementTitle(button, title);
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

function clearLocalPlayerControlsHideTimer() {
  if (!state.localPlayerControlsHideTimer) {
    return;
  }
  window.clearTimeout(state.localPlayerControlsHideTimer);
  state.localPlayerControlsHideTimer = null;
}

function mountedLocalVideoElement() {
  return elements.playerFrame.querySelector('video[data-player-role="video"]')
    || elements.playerFrame.querySelector("video");
}

function hideMountedPlayerControls() {
  clearLocalPlayerControlsHideTimer();
  const video = mountedLocalVideoElement();
  if (!video) {
    return;
  }
  video.controls = false;
  video.removeAttribute("controls");
}

function scheduleMountedPlayerControlsHide() {
  clearLocalPlayerControlsHideTimer();
  const video = mountedLocalVideoElement();
  if (!video || !video.controls) {
    return;
  }
  state.localPlayerControlsHideTimer = window.setTimeout(() => {
    state.localPlayerControlsHideTimer = null;
    hideMountedPlayerControls();
  }, playerControlsAutoHideMs);
}

function showMountedPlayerControls() {
  const video = mountedLocalVideoElement();
  if (!video) {
    return;
  }
  video.controls = true;
  video.setAttribute("controls", "");
  scheduleMountedPlayerControlsHide();
}

function toggleMountedLocalPlayback() {
  if (frontendPlaybackMode(state.data?.playback_mode) !== "local" || !state.data?.current_item) {
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
  state.updatePreviewEnabled = readLocalBoolean(storageKeys.updatePreview, state.updatePreviewEnabled);
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
  if (Date.now() < state.playerSettingsEchoSuppressUntil) {
    return;
  }
  const volumePercent = Math.max(0, Math.min(100, Number(playerSettings?.volume_percent ?? 100)));
  state.localPlayerVolume = volumePercent / 100;
  state.localPlayerMuted = Boolean(playerSettings?.is_muted);
  persistLocalVolumePreferences();
}

function markLocalVolumeWrite() {
  state.playerSettingsEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.volumeSaveSeq += 1;
  return state.volumeSaveSeq;
}

function markLocalAvOffsetWrite(offsetMs) {
  state.localAvOffsetMs = boundedAvOffsetMs(offsetMs);
  state.avOffsetEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.avOffsetSaveSeq += 1;
  return state.avOffsetSaveSeq;
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

async function apiGet(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: clientHeaders(),
    signal: options.signal,
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
  const previousData = state.data;
  const response = await fetch("/api/state", {
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "获取状态失败");
  }
  state.data = payload.data;
  maybeShowIncomingRequestToast(previousData, state.data);
  maybeShowSongTransitionOverlay(previousData, state.data);
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
  const renderSignature = renderSignatureForData(state.data);
  if (renderSignature !== state.lastPollRenderSignature) {
    state.lastPollRenderSignature = renderSignature;
    render();
  } else if (hasDownloadingItems(state.data)) {
    refreshRetryButtons();
  }
  if (previousOffsetMs !== currentAvOffsetMs()) {
    syncMountedLocalPlayer(true);
  }
}

function renderSignatureForData(data) {
  if (!data) {
    return "";
  }
  const { player_status: _playerStatus, ...renderedData } = data;
  return JSON.stringify(renderedData);
}

function hasDownloadingItems(data) {
  if (!data) {
    return false;
  }
  const items = [
    data.current_item,
    ...(Array.isArray(data.playlist) ? data.playlist : []),
  ];
  return items.some((item) => item?.cache_status === "downloading");
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

async function fetchGatchaBrowse(uid = "", query = "") {
  const params = new URLSearchParams();
  const normalizedUid = String(uid || "").trim();
  const normalizedQuery = String(query || "").trim();
  if (normalizedUid) {
    params.set("uid", normalizedUid);
  }
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  const queryString = params.toString();
  const response = await fetch(`/api/gatcha/browse${queryString ? `?${queryString}` : ""}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || "Browse failed");
  }
  return payload.data || { owners: [], items: [] };
}

async function previewGatchaUid(uid) {
  return apiPost("/api/gatcha/uids/preview", { uid: String(uid || "").trim() });
}

async function addGatchaUid(uid) {
  return apiPost("/api/gatcha/uids/add", { uid: String(uid || "").trim() });
}

async function refreshGatchaCache() {
  return apiPost("/api/gatcha/refresh");
}

function gatchaUidResultMessage(result, fallbackUid = "") {
  const cache = result?.cache || {};
  const addedCount = Number(cache.added_count || 0);
  const totalCount = Number(cache.total_count || 0);
  const modeLabel = cache.mode === "incremental" ? "最新" : "所有";
  const ownerLabel = result?.name ? `UP 主 ${result.name}` : `UID ${result?.uid || fallbackUid}`;
  const listAction = result?.added ? "已添加" : "已在关注列表中";
  return `${ownerLabel} ${listAction}，已拉取${modeLabel}稿件，新增 ${addedCount} 条，缓存共 ${totalCount} 条。`;
}

async function confirmGatchaUidAdd(intent) {
  closeConfirm();
  state.gatchaUidSaving = true;
  renderGatchaUidFace();
  setGatchaUidMessage(`正在拉取 UP 主：${intent.name || intent.uid} 的稿件...`);
  try {
    const result = await addGatchaUid(intent.uid);
    setGatchaUidMessage(gatchaUidResultMessage(result, intent.uid));
    if (elements.gatchaUidInput) {
      elements.gatchaUidInput.value = "";
    }
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidFace();
  }
}

function hideSearchResults() {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.add("hidden");
}

function renderSearchResultItems(container, items, emptyText = "No cached matches found.") {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  container.classList.remove("hidden");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = emptyText;
    container.appendChild(empty);
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
    container.appendChild(row);
  });
}

function renderSearchResults(items) {
  renderSearchResultItems(elements.searchResults, items);
}

function selectedFollowOwner() {
  const owners = Array.isArray(state.followBrowseData?.owners) ? state.followBrowseData.owners : [];
  return owners.find((owner) => String(owner.uid || "") === state.followBrowseSelectedUid) || null;
}

function ownerNameFromStateByUid(uid) {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid || !state.data) {
    return "";
  }
  const entries = [
    state.data.current_item,
    ...(Array.isArray(state.data.playlist) ? state.data.playlist : []),
    ...(Array.isArray(state.data.history) ? state.data.history : []),
  ];
  for (const entry of entries) {
    if (String(entry?.owner_mid || "").trim() !== normalizedUid) {
      continue;
    }
    const ownerName = String(entry?.owner_name || "").trim();
    if (ownerName) {
      return ownerName;
    }
  }
  return "";
}

function followOwnerDisplayName(owner) {
  const uid = String(owner?.uid || "").trim();
  const ownerName = String(owner?.name || "").trim();
  const stateOwnerName = ownerNameFromStateByUid(uid);
  if (ownerName && ownerName !== `UID ${uid}`) {
    return ownerName;
  }
  return stateOwnerName || ownerName || `UID ${uid}`;
}

function renderFollowBrowse() {
  if (!elements.followUpGrid || !elements.followSongResults) {
    return;
  }
  const owners = Array.isArray(state.followBrowseData?.owners) ? state.followBrowseData.owners : [];
  const items = Array.isArray(state.followBrowseData?.items) ? state.followBrowseData.items : [];
  const signature = JSON.stringify({
    loading: state.followBrowseLoading,
    selected: state.followBrowseSelectedUid,
    owners,
    items,
  });
  if (signature === state.followBrowseRenderSignature) {
    return;
  }
  state.followBrowseRenderSignature = signature;

  const hasSelectedUid = Boolean(state.followBrowseSelectedUid);
  elements.followUpListView?.classList.toggle("hidden", hasSelectedUid);
  elements.followUpItemsView?.classList.toggle("hidden", !hasSelectedUid);

  if (!hasSelectedUid) {
    elements.followUpGrid.innerHTML = "";
    if (!owners.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = state.followBrowseLoading ? "正在读取关注缓存..." : "还没有可浏览的关注 UID。";
      elements.followUpGrid.appendChild(empty);
    } else {
      owners.forEach((owner) => {
        const displayName = followOwnerDisplayName(owner);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "follow-up-button";
        button.dataset.uid = String(owner.uid || "");
        button.title = displayName;

        const name = document.createElement("span");
        name.className = "follow-up-name";
        name.textContent = displayName;

        const count = document.createElement("span");
        count.className = "follow-up-count";
        count.textContent = `${Number(owner.count || 0)} 首`;

        button.append(name, count);
        elements.followUpGrid.appendChild(button);
      });
    }
    setFollowBrowseMessage(state.followBrowseLoading ? "正在读取关注列表..." : "");
    return;
  }

  const owner = selectedFollowOwner();
  if (elements.followBrowseTitle) {
    elements.followBrowseTitle.textContent = followOwnerDisplayName(owner) || `UID ${state.followBrowseSelectedUid}`;
  }
  if (elements.followBrowseCount) {
    const totalCount = Number(owner?.count || items.length || 0);
    elements.followBrowseCount.textContent = `${items.length}/${totalCount} 首`;
  }
  renderSearchResultItems(
    elements.followSongResults,
    items,
    state.followBrowseLoading ? "正在读取稿件..." : "这个 UP 的缓存稿件里没有匹配结果。",
  );
  setFollowBrowseMessage(state.followBrowseLoading ? "正在读取稿件..." : "");
}

async function loadFollowBrowse({ uid = state.followBrowseSelectedUid, query = "", keepQuery = false } = {}) {
  state.followBrowseLoading = true;
  state.followBrowseSelectedUid = String(uid || "").trim();
  renderFollowBrowse();
  try {
    const nextData = await fetchGatchaBrowse(state.followBrowseSelectedUid, query);
    state.followBrowseData = nextData;
    state.followBrowseSelectedUid = String(nextData.selected_uid || state.followBrowseSelectedUid || "");
    if (!keepQuery && elements.followSearchQuery) {
      elements.followSearchQuery.value = String(nextData.query || "");
    }
  } catch (error) {
    setFollowBrowseMessage(error.message, true);
  } finally {
    state.followBrowseLoading = false;
    renderFollowBrowse();
  }
}

async function handleGatchaDraw() {
  setGatchaMessage("正在连接 B 站寻找幸运投稿...");
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "获取幸运歌曲失败");
    }

    state.gatchaCandidate = payload.data;
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
    
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

function setFollowBrowseMessage(message, isError = false) {
  if (!elements.followBrowseMessage) {
    return;
  }
  elements.followBrowseMessage.textContent = message || "";
  elements.followBrowseMessage.classList.toggle("is-error", Boolean(isError));
}

function setGatchaUidMessage(message, isError = false) {
  if (!elements.gatchaUidMessage) {
    return;
  }
  elements.gatchaUidMessage.textContent = message || "";
  elements.gatchaUidMessage.classList.toggle("is-error", Boolean(isError));
}

function syncSearchStageView(showCookie) {
  const nextView = showCookie ? "browse" : "search";
  const isInitialRender = !state.searchStageView;
  if (state.searchStageView === nextView) {
    return;
  }
  state.searchStageView = nextView;

  if (state.searchFlipTimer) {
    window.clearTimeout(state.searchFlipTimer);
    state.searchFlipTimer = null;
  }
  if (state.searchFlipFrame) {
    window.cancelAnimationFrame(state.searchFlipFrame);
    state.searchFlipFrame = null;
  }

  if (isInitialRender) {
    setClassToggle(elements.searchStage, "is-cookie-view", showCookie);
    elements.searchStage?.classList.remove("is-flipping");
    return;
  }

  elements.searchStage?.classList.add("is-flipping");
  state.searchFlipFrame = window.requestAnimationFrame(() => {
    state.searchFlipFrame = null;
    setClassToggle(elements.searchStage, "is-cookie-view", showCookie);
  });
  state.searchFlipTimer = window.setTimeout(() => {
    elements.searchStage?.classList.remove("is-flipping");
    state.searchFlipTimer = null;
  }, 440);
}

function renderSearchCookieFace() {
  const showCookie = Boolean(state.searchCookieVisible);
  const signature = JSON.stringify({
    face: showCookie ? "browse" : "search",
    selected: state.followBrowseSelectedUid,
    loading: state.followBrowseLoading,
  });
  if (signature === state.searchCookieFaceRenderSignature) {
    return;
  }
  state.searchCookieFaceRenderSignature = signature;

  setClassToggle(elements.searchPanel, "is-cookie-view", showCookie);
  syncSearchStageView(showCookie);
  setTextContent(elements.searchTag, showCookie ? "Follow Browse" : "Local Search");
  setTextContent(elements.searchTitle, showCookie ? "关注列表" : "搜索");
  setTextContent(elements.searchCookieToggle, showCookie ? "返回搜索" : "关注浏览");
  if (elements.searchCookieToggle?.getAttribute("aria-pressed") !== String(showCookie)) {
    elements.searchCookieToggle.setAttribute("aria-pressed", String(showCookie));
  }
  if (showCookie) {
    renderFollowBrowse();
  }
}

function renderGatchaUidFace() {
  const showUid = Boolean(state.gatchaUidVisible);
  const signature = JSON.stringify({
    showUid,
    saving: state.gatchaUidSaving,
    refreshing: state.gatchaRefreshSaving,
  });
  if (signature === state.gatchaUidFaceRenderSignature) {
    return;
  }
  state.gatchaUidFaceRenderSignature = signature;

  setClassToggle(elements.gatchaPanel, "is-uid-view", showUid);
  setClassToggle(elements.gatchaStage, "is-uid-view", showUid);
  setTextContent(elements.gatchaTag, showUid ? "Follow UID" : "gatcha Draw");
  setTextContent(elements.gatchaTitle, showUid ? "关注 UID" : "试试运气");
  setTextContent(elements.gatchaUidToggle, showUid ? "返回抽卡" : "添加 UID");
  if (elements.gatchaUidToggle?.getAttribute("aria-pressed") !== String(showUid)) {
    elements.gatchaUidToggle.setAttribute("aria-pressed", String(showUid));
  }
  if (elements.addGatchaUidButton) {
    elements.addGatchaUidButton.disabled = state.gatchaUidSaving;
    elements.addGatchaUidButton.textContent = state.gatchaUidSaving ? "处理中" : "添加";
  }
  if (elements.refreshGatchaCacheButton) {
    elements.refreshGatchaCacheButton.disabled = state.gatchaRefreshSaving;
    elements.refreshGatchaCacheButton.textContent = state.gatchaRefreshSaving ? "更新中" : "手动更新";
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
  const currentTitle = currentItem ? currentItem.display_title : "还没有歌曲";
  if (currentTitle !== state.currentTitleRenderSignature) {
    state.currentTitleRenderSignature = currentTitle;
    setTextContent(elements.currentTitle, currentTitle);
  }
  renderListHeader(data.playlist, data.history || []);
  renderRequesterSelect(data.session_users || []);
  renderSessionUsers(data.session_users || []);
  renderCacheSettings(data.bbdown, data.ffmpeg, data.cache_policy);
  renderPlaybackRepairControls(currentItem);
  renderRemoteAccess(data.remote_access);
  renderLayoutMode();

  const playbackMode = frontendPlaybackMode(data.playback_mode);
  renderAudioVariantBar(currentItem, playbackMode);
  renderAvSyncControls(playbackMode, data.player_settings);
  renderVolumeControls(playbackMode);
  applyStoredVolumeToMountedPlayer();
  renderPlayer(currentItem, playbackMode);
  renderPlayerFullscreenButton();
  applyRemotePlayerControl(data.player_control_command, currentItem, playbackMode);
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
  syncListStageView();
  renderSearchCookieFace();
  renderGatchaUidFace();
  renderConfirmPopover();
  flushPendingSongTransitionOverlay();
  state.lastPollRenderSignature = renderSignatureForData(data);
}

function syncListStageView() {
  const nextView = state.listView === "history" ? "history" : "queue";
  const isInitialRender = !state.listStageView;
  if (state.listStageView === nextView) {
    return;
  }
  state.listStageView = nextView;

  if (state.listFlipTimer) {
    window.clearTimeout(state.listFlipTimer);
    state.listFlipTimer = null;
  }
  if (state.listFlipFrame) {
    window.cancelAnimationFrame(state.listFlipFrame);
    state.listFlipFrame = null;
  }

  if (isInitialRender) {
    setClassToggle(elements.listStage, "is-history-view", nextView === "history");
    elements.listStage?.classList.remove("is-flipping");
    return;
  }

  elements.listStage?.classList.add("is-flipping");
  state.listFlipFrame = window.requestAnimationFrame(() => {
    state.listFlipFrame = null;
    setClassToggle(elements.listStage, "is-history-view", nextView === "history");
  });
  state.listFlipTimer = window.setTimeout(() => {
    elements.listStage?.classList.remove("is-flipping");
    state.listFlipTimer = null;
  }, 440);
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
  const signature = JSON.stringify(users);
  if (signature === state.requesterSelectRenderSignature) {
    return;
  }
  state.requesterSelectRenderSignature = signature;

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
  const signature = JSON.stringify(users);
  if (signature === state.sessionUsersRenderSignature) {
    return;
  }
  state.sessionUsersRenderSignature = signature;

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
  const signature = JSON.stringify({ displayUrl, displayHint });
  if (signature === state.remoteAccessRenderSignature) {
    return;
  }
  state.remoteAccessRenderSignature = signature;

  [elements.remoteUrlLink, elements.remotePopoverUrlLink].forEach((link) => {
    if (!link) {
      return;
    }
    if (link.getAttribute("href") !== displayUrl) {
      link.href = displayUrl;
    }
    setTextContent(link, displayUrl);
  });

  [elements.remoteUrlHint, elements.remotePopoverUrlHint].forEach((hint) => {
    setTextContent(hint, displayHint);
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
  const listTag = isHistoryView ? "History" : "Requests";
  const listTitle = isHistoryView ? "历史记录" : "点歌列表";
  const queueCount = isHistoryView ? `(${history.length}首)` : `(${playlist.length}首)`;
  const historyButtonText = isHistoryView ? "点歌列表" : "历史记录";
  const signature = JSON.stringify({
    isHistoryView,
    queueCount,
  });

  if (signature === state.listHeaderRenderSignature) {
    return;
  }
  state.listHeaderRenderSignature = signature;

  setTextContent(elements.listTag, listTag);
  setTextContent(elements.listTitle, listTitle);
  setTextContent(elements.queueCount, queueCount);
  setTextContent(elements.historyToggleButton, historyButtonText);
  setClassToggle(elements.clearPlaylistButton, "hidden", isHistoryView);
  setClassToggle(elements.historyExportButton, "hidden", !isHistoryView);
  setClassToggle(elements.clearHistoryButton, "hidden", !isHistoryView || !history.length);
  setClassToggle(elements.nextButton, "hidden", isHistoryView);
}

function renderCacheSettings(bbdown, ffmpeg, cachePolicy) {
  const serviceState = aggregateToolStatusState(bbdown, ffmpeg);
  const playbackModeText = formatPlaybackMode(state.data?.playback_mode);
  const cacheChipMeta = formatCacheChipMeta(cachePolicy);
  const cacheUsageDetail = formatCacheUsage(cachePolicy);
  const bbdownTitle = `BBDown ${formatBBDownHint(bbdown)}`;
  const ffmpegTitle = `FFmpeg ${formatFFmpegHint(ffmpeg)}`;
  const signature = JSON.stringify({
    serviceState,
    playbackModeText,
    bbdownState: bbdown?.state,
    ffmpegState: ffmpeg?.state,
    bbdownTitle,
    ffmpegTitle,
    login: bbdown?.login || { logged_in: Boolean(bbdown?.logged_in) },
  });

  if (signature !== state.cacheSettingsRenderSignature) {
    state.cacheSettingsRenderSignature = signature;

    syncToolIndicator(elements.serviceStatusIndicator, serviceState);
    setTextContent(elements.playbackModeSummary, playbackModeText);
    setTextContent(elements.playbackModeCurrent, playbackModeText);
    syncToolIndicator(elements.bbdownPanelStatusIndicator, bbdown?.state);
    syncToolIndicator(elements.ffmpegPanelStatusIndicator, ffmpeg?.state);
    renderBBDownLogin(bbdown?.login || { logged_in: Boolean(bbdown?.logged_in) });
    if (elements.bbdownStatusRow && elements.bbdownStatusRow.title !== bbdownTitle) {
      elements.bbdownStatusRow.title = bbdownTitle;
    }
    if (elements.ffmpegStatusRow && elements.ffmpegStatusRow.title !== ffmpegTitle) {
      elements.ffmpegStatusRow.title = ffmpegTitle;
    }
  }

  setTextContent(elements.cacheChipMeta, cacheChipMeta);
  setTextContent(elements.cacheUsageDetail, cacheUsageDetail);
  renderCacheSlider(cachePolicy);
  renderAdvanceDelaySlider(state.data?.player_settings);
  renderCachePolicyControls(cachePolicy);
  renderUpdatePreviewControl();
  syncCachePanelVisibility();
}

function renderUpdatePreviewControl() {
  if (!elements.updatePreviewCheckbox) {
    return;
  }
  elements.updatePreviewCheckbox.checked = state.updatePreviewEnabled;
  elements.updatePreviewCheckbox.disabled = state.updateChecking;
}

function renderPlaybackRepairControls(currentItem) {
  const button = elements.currentCacheRetryButton;
  if (!button) {
    return;
  }
  const hasCurrentItem = Boolean(currentItem?.id);
  button.disabled = !hasCurrentItem;
  button.title = hasCurrentItem
    ? "重新缓存当前歌曲"
    : "当前没有正在播放的歌曲";
}

function renderBBDownLogin(login) {
  const loggedIn = Boolean(login?.logged_in);
  const signature = JSON.stringify(login || {});
  if (signature !== state.bbdownLoginRenderSignature) {
    state.bbdownLoginRenderSignature = signature;
    if (elements.bbdownLoginButton) {
      setClassToggle(elements.bbdownLoginButton, "is-logged", loggedIn);
      setClassToggle(elements.bbdownLoginButton, "is-unlogged", !loggedIn);
      elements.bbdownLoginButton.classList.remove("is-unknown");
      const label = elements.bbdownLoginButton.querySelector(".bbdown-login-label");
      setTextContent(label, loggedIn ? "已登录" : "未登录");
      elements.bbdownLoginButton.title = loggedIn ? "点击退出 BBDown 登录" : "点击生成 BBDown 登录二维码";
    }

    setClassToggle(elements.bbdownLoginPanel, "hidden", loggedIn);
    if (!loggedIn) {
      const qrImage = String(login?.qr_image || "");
      const qrText = String(login?.qr_text || "");
      if (elements.bbdownLoginQrImage) {
        setClassToggle(elements.bbdownLoginQrImage, "hidden", !qrImage);
        if (qrImage && elements.bbdownLoginQrImage.src !== qrImage) {
          elements.bbdownLoginQrImage.src = qrImage;
        } else if (!qrImage && elements.bbdownLoginQrImage.hasAttribute("src")) {
          elements.bbdownLoginQrImage.removeAttribute("src");
        }
      }
      if (elements.bbdownLoginQrText) {
        setClassToggle(elements.bbdownLoginQrText, "hidden", Boolean(qrImage) || !qrText);
        setTextContent(elements.bbdownLoginQrText, qrText);
      }
      if (elements.bbdownLoginMessage) {
        setTextContent(elements.bbdownLoginMessage, login?.message || "正在准备二维码...");
        setClassToggle(elements.bbdownLoginMessage, "is-error", login?.state === "failed");
      }
    }
  }

  if (loggedIn) {
    return;
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
  if (indicator.dataset.toolState === normalizedState) {
    return;
  }
  indicator.dataset.toolState = normalizedState;
  indicator.classList.remove("is-ready", "is-failed", "is-loading", "is-pending");
  setTextContent(indicator, "");
  if (normalizedState === "ready") {
    indicator.classList.add("is-ready");
    setTextContent(indicator, "✓");
  } else if (normalizedState === "failed") {
    indicator.classList.add("is-failed");
    setTextContent(indicator, "×");
  } else if (normalizedState === "checking" || normalizedState === "installing" || normalizedState === "loading") {
    indicator.classList.add("is-loading");
  } else {
    indicator.classList.add("is-pending");
    setTextContent(indicator, "·");
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

function frontendPlaybackMode(_mode) {
  return "local";
}

function formatPlaybackMode(_mode) {
  return "本地缓存";
}

function renderCacheSlider(cachePolicy) {
  const choices = Array.isArray(cachePolicy?.choices) && cachePolicy.choices.length
    ? cachePolicy.choices
    : [1, 2, 3, 4, 5];
  const minValue = Number(choices[0] || 1);
  const maxValue = Number(choices[choices.length - 1] || 5);
  const currentValue = Number(cachePolicy?.max_cache_items || minValue);
  const signature = JSON.stringify({
    choices,
    currentValue,
    saving: state.cacheLimitSaving,
  });

  if (signature === state.cacheSliderRenderSignature) {
    return;
  }
  state.cacheSliderRenderSignature = signature;

  elements.cacheLimitSlider.min = String(minValue);
  elements.cacheLimitSlider.max = String(maxValue);
  elements.cacheLimitSlider.step = "1";
  elements.cacheLimitSlider.value = String(currentValue);
  elements.cacheLimitSlider.disabled = state.cacheLimitSaving;
  updateCacheSliderFill(currentValue, minValue, maxValue);

  elements.cacheLimitScale.innerHTML = "";
  choices.forEach((choice) => {
    const mark = document.createElement("span");
    mark.textContent = String(choice);
    mark.classList.toggle("active", Number(choice) === currentValue);
    elements.cacheLimitScale.appendChild(mark);
  });
}

function renderAdvanceDelaySlider(playerSettings) {
  if (!elements.advanceDelaySlider) {
    return;
  }
  const currentValue = currentSongAdvanceDelaySeconds(playerSettings);
  const signature = JSON.stringify({
    currentValue,
    saving: state.advanceDelaySaving,
  });

  if (signature === state.advanceDelaySliderRenderSignature) {
    return;
  }
  state.advanceDelaySliderRenderSignature = signature;

  elements.advanceDelaySlider.min = "1";
  elements.advanceDelaySlider.max = "5";
  elements.advanceDelaySlider.step = "1";
  elements.advanceDelaySlider.value = String(currentValue);
  elements.advanceDelaySlider.disabled = state.advanceDelaySaving;
  updateAdvanceDelaySliderFill(currentValue);

  elements.advanceDelayScale.querySelectorAll("span").forEach((mark) => {
    mark.classList.toggle("active", Number(mark.textContent || "0") === currentValue);
  });
}

function updateAdvanceDelaySliderFill(value) {
  const min = 1;
  const max = 5;
  const current = Number(value);
  const ratio = max <= min ? 1 : (current - min) / (max - min);
  elements.advanceDelaySlider.style.setProperty("--slider-progress", `${ratio * 100}%`);
}

function renderCachePolicyControls(cachePolicy) {
  const rawChoices = Array.isArray(cachePolicy?.video_quality_choices)
    ? cachePolicy.video_quality_choices
    : [];
  const choices = rawChoices.length
    ? rawChoices.map((choice) => {
      if (typeof choice === "string") {
        return { value: choice, label: choice };
      }
      return {
        value: String(choice?.value || ""),
        label: String(choice?.label || choice?.value || ""),
      };
    }).filter((choice) => choice.value)
    : [
      { value: "1080P 高码率", label: "1080P 高码率" },
      { value: "1080P 高清", label: "1080P 高清" },
      { value: "720P 高清", label: "720P 高清" },
      { value: "480P 清晰", label: "480P 清晰" },
      { value: "360P 流畅", label: "360P 流畅" },
    ];
  const currentQuality = String(cachePolicy?.video_quality || choices[0]?.value || "1080P 高码率");
  const audioHires = Boolean(cachePolicy?.audio_hires);
  const signature = JSON.stringify({
    choices,
    currentQuality,
    audioHires,
    saving: state.cachePolicySaving,
  });

  if (signature === state.cachePolicyControlRenderSignature) {
    return;
  }
  state.cachePolicyControlRenderSignature = signature;

  if (elements.cacheQualitySelect) {
    const choicesSignature = JSON.stringify(choices);
    if (elements.cacheQualitySelect.dataset.choicesSignature !== choicesSignature) {
      elements.cacheQualitySelect.innerHTML = "";
      choices.forEach((choice) => {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        elements.cacheQualitySelect.appendChild(option);
      });
      elements.cacheQualitySelect.dataset.choicesSignature = choicesSignature;
    }
    elements.cacheQualitySelect.value = currentQuality;
    elements.cacheQualitySelect.disabled = state.cachePolicySaving;
  }

  if (elements.cacheHiresCheckbox) {
    elements.cacheHiresCheckbox.checked = audioHires;
    elements.cacheHiresCheckbox.disabled = state.cachePolicySaving;
  }
}

function syncCachePanelVisibility(options = {}) {
  const expanded = String(state.cacheSettingsOpen);
  if (elements.cacheSettingsToggle.getAttribute("aria-expanded") !== expanded) {
    elements.cacheSettingsToggle.setAttribute("aria-expanded", expanded);
  }
  setClassToggle(elements.cachePanel, "hidden", !state.cacheSettingsOpen);
  maybeStartBBDownLogin(state.data?.bbdown?.login, {
    force: Boolean(options.forceLoginRefresh),
  });
}

function renderQueueCurrent(currentItem) {
  if (!currentItem) {
    const signature = "empty";
    if (signature === state.queueCurrentRenderSignature) {
      return;
    }
    state.queueCurrentRenderSignature = signature;
    setClassToggle(elements.queueCurrent, "hidden", true);
    if (elements.queueCurrent.dataset.state !== "idle") {
      elements.queueCurrent.dataset.state = "idle";
    }
    setTextContent(elements.queueCurrentTag, "播放中");
    setTextContent(elements.queueCurrentTitle, "还没有歌曲");
    setElementTitle(elements.queueCurrentTitle, "");
    setClassToggle(elements.queueCurrentRetry, "hidden", true);
    elements.queueCurrentRetry.removeAttribute("data-id");
    return;
  }

  const currentState = currentStatusForItem(currentItem);
  const requesterText = requesterBadgeText(currentItem.requester_name);
  const signature = JSON.stringify({
    id: currentItem.id,
    state: currentState.state,
    label: currentState.label,
    title: currentItem.display_title,
    requesterText,
  });

  if (signature !== state.queueCurrentRenderSignature) {
    state.queueCurrentRenderSignature = signature;
    setClassToggle(elements.queueCurrent, "hidden", false);
    if (elements.queueCurrent.dataset.state !== currentState.state) {
      elements.queueCurrent.dataset.state = currentState.state;
    }
    setTextContent(elements.queueCurrentTag, currentState.label);
    setTextContent(elements.queueCurrentTitle, currentItem.display_title);
    setElementTitle(elements.queueCurrentTitle, ownerTooltipForEntry(currentItem));
    setTextContent(elements.queueCurrentRequester, requesterText);
    setClassToggle(elements.queueCurrentRequester, "hidden", !requesterText);

    setClassToggle(elements.queueCurrentProgressBadge, "idle", currentState.state === "pending");
    setClassToggle(elements.queueCurrentProgressBadge, "active", currentState.state === "caching");
    setClassToggle(elements.queueCurrentProgressBadge, "ready", currentState.state === "playing");
    setClassToggle(elements.queueCurrentProgressBadge, "failed", currentState.state === "failed");
  }

  syncRetryButton(elements.queueCurrentRetry, currentItem);
}

function currentStatusForItem(item) {
  if (!item) {
    return { state: "idle", label: "播放中" };
  }
  if (item.cache_status === "ready") {
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

  const normalizedPages = Array.isArray(pages) && pages.length
    ? pages
    : [Number(item.page || 1)];

  return normalizedPages
    .map((page, index) => {
      const numericPage = Number(page || 0);
      if (!numericPage) {
        return null;
      }
      const label = String(parts?.[index] || item.part_title || `P${numericPage}`).trim() || `P${numericPage}`;
      return {
        page: numericPage,
        label,
        duration: Number(durations?.[index] || 0),
        id: variantIdForLabel(numericPage, label, index),
        bound: Array.isArray(item.selected_pages)
          ? item.selected_pages.some((selectedPage) => Number(selectedPage) === numericPage)
          : numericPage === Number(item.page || 0),
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
      audio_url: String(cachedVariant?.audio_url || ""),
      // LEGACY: cachedVariant.media_url used to point to a muxed MP4 variant.
      // The host player now uses video_media_url + audio_url split playback.
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

// LEGACY: single-file/muxed playback helper. Current local playback reads
// selectedVideoUrlForItem() and selectedAudioUrlForItem() separately.
// function selectedMediaUrlForItem(item) {
//   const selectedVariant = selectedAudioVariantForItem(item);
//   return String(selectedVariant?.media_url || "").trim();
// }

function selectedVideoUrlForItem(item) {
  return String(item?.video_media_url || "").trim();
}

function selectedAudioUrlForItem(item) {
  const selectedVariant = selectedAudioVariantForItem(item);
  return String(selectedVariant?.audio_url || "").trim();
}
function serverAvOffsetMs(playerSettings = state.data?.player_settings) {
  return boundedAvOffsetMs(playerSettings?.av_offset_ms || 0);
}

function currentAvOffsetMs() {
  if (state.localAvOffsetMs !== null && Date.now() < state.avOffsetEchoSuppressUntil) {
    return state.localAvOffsetMs;
  }
  state.localAvOffsetMs = null;
  return serverAvOffsetMs();
}

function currentAvOffsetSeconds() {
  return currentAvOffsetMs() / 1000;
}

function currentSongAdvanceDelaySeconds(playerSettings = state.data?.player_settings) {
  const rawValue = Number(playerSettings?.song_advance_delay_seconds ?? defaultSongAdvanceDelaySeconds);
  if (!Number.isFinite(rawValue)) {
    return defaultSongAdvanceDelaySeconds;
  }
  return Math.max(1, Math.min(maxSongAdvanceDelaySeconds, Math.round(rawValue)));
}

function queuedNextItem() {
  const playlist = state.data?.playlist;
  return Array.isArray(playlist) && playlist.length ? playlist[0] : null;
}

function currentItemIdFromData(data) {
  return String(data?.current_item?.id || "");
}

function durationSecondsForItem(item) {
  if (!item) {
    return 0;
  }
  const selectedDurations = Array.isArray(item.selected_durations) ? item.selected_durations : [];
  const selectedPages = Array.isArray(item.selected_pages) ? item.selected_pages : [];
  const currentPage = Number(item.page || item.video_page || selectedPages[0] || 0);
  const selectedIndex = selectedPages.findIndex((page) => Number(page) === currentPage);
  const selectedDuration = Number(selectedDurations[selectedIndex >= 0 ? selectedIndex : 0] || 0);
  if (selectedDuration > 0) {
    return Math.round(selectedDuration);
  }

  const availableDurations = Array.isArray(item.available_durations) ? item.available_durations : [];
  const availablePages = Array.isArray(item.available_pages) ? item.available_pages : [];
  const availableIndex = availablePages.findIndex((page) => Number(page) === currentPage);
  const availableDuration = Number(availableDurations[availableIndex >= 0 ? availableIndex : 0] || 0);
  return availableDuration > 0 ? Math.round(availableDuration) : 0;
}

function formatDurationSeconds(seconds) {
  const normalizedSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  if (!normalizedSeconds) {
    return "—";
  }
  const minutes = Math.floor(normalizedSeconds / 60);
  const restSeconds = normalizedSeconds % 60;
  return `${minutes}:${String(restSeconds).padStart(2, "0")}`;
}

function escapeRegExpText(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delayOverlayTitleForItem(item, fallback = "未命名歌曲") {
  let title = String(item?.display_title || item?.title || fallback).trim();
  const partCandidates = [
    item?.part_title,
    ...(Array.isArray(item?.selected_parts) ? item.selected_parts : []),
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  for (const partTitle of partCandidates) {
    const escapedPart = escapeRegExpText(partTitle);
    title = title
      .replace(new RegExp(`\\s*(?:-|–|—|·|\\||/)?\\s*${escapedPart}\\s*$`, "i"), "")
      .trim();
  }
  return title || fallback;
}

function delayOverlayItemSignature(item) {
  if (!item) {
    return "";
  }
  return [
    item.id || "",
    delayOverlayTitleForItem(item, ""),
    item.requester_name || "",
    durationSecondsForItem(item),
  ].join("|");
}

function manualTransitionOverlaySeconds(data = state.data) {
  const delaySeconds = currentSongAdvanceDelaySeconds(data?.player_settings);
  return delaySeconds > 0 ? delaySeconds : defaultSongAdvanceDelaySeconds;
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

function setMediaCurrentTime(media, nextTime, toleranceSeconds = localPlayerForceSyncEpsilonSeconds) {
  if (!media) {
    return false;
  }
  const target = clampMediaTime(media, nextTime);
  const currentTime = Number(media.currentTime || 0);
  if (Number.isFinite(currentTime) && Math.abs(currentTime - target) <= toleranceSeconds) {
    return false;
  }
  try {
    media.currentTime = target;
    return true;
  } catch {
    return false;
  }
}

function clearLocalPlayerSyncTimer() {
  if (state.localPlayerSyncTimer) {
    window.clearInterval(state.localPlayerSyncTimer);
    state.localPlayerSyncTimer = null;
  }
}

function clearLocalPlayerSeekState() {
  if (state.localSeekSettleTimer) {
    window.clearTimeout(state.localSeekSettleTimer);
    state.localSeekSettleTimer = null;
  }
  state.localSeekSettling = false;
  state.localSeekResumeAfterSettle = false;
  state.localSeekSettleStartedAt = 0;
  state.localSeekSettleCallback = null;
  state.localSeekResumePending = false;
}

function playerDelayOverlay() {
  return elements.playerPanel?.querySelector(".player-delay-overlay") || null;
}

function ensurePlayerDelayOverlay() {
  let overlay = playerDelayOverlay();
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.className = "player-delay-overlay hidden";
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="player-delay-card">
      <div class="player-delay-head">
        <p class="player-delay-heading">\u5373\u5c06\u64ad\u653e</p>
        <div class="player-delay-countdown" aria-label="\u5207\u6b4c\u5012\u8ba1\u65f6">
          <svg class="player-delay-count-ring" viewBox="0 0 44 44" aria-hidden="true">
            <circle class="player-delay-count-track" cx="22" cy="22" r="19"></circle>
            <circle class="player-delay-count-progress" cx="22" cy="22" r="19"></circle>
          </svg>
          <span class="player-delay-count-text"><span data-delay-count>0</span>s</span>
        </div>
      </div>
      <div class="player-delay-now-row">
        <span class="player-delay-play-icon" aria-hidden="true">\u25b6</span>
        <p class="player-delay-song-title" data-delay-next-title>\u51c6\u5907\u4e0b\u4e00\u9996</p>
        <p class="player-delay-requester" data-delay-next-requester>\u70b9\u6b4c\u4eba</p>
        <p class="player-delay-duration" data-delay-next-duration>\u65f6\u957f</p>
      </div>
      <p class="player-delay-section-title">\u540e\u7eed\u70b9\u6b4c\u5217\u8868</p>
      <div class="player-delay-list" data-delay-list></div>
      <p class="player-delay-total" data-delay-total>\u5171 0 \u9996</p>
    </div>
  `;
  elements.playerPanel.appendChild(overlay);
  return overlay;
}

function setPlayerDelayOverlayVisible(overlay) {
  if (!overlay) {
    return;
  }
  if (state.localAdvanceOverlayHideTimer) {
    window.clearTimeout(state.localAdvanceOverlayHideTimer);
    state.localAdvanceOverlayHideTimer = null;
  }
  overlay.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    overlay.classList.add("is-visible");
  });
}

function hidePlayerDelayOverlay() {
  const overlay = playerDelayOverlay();
  if (!overlay || overlay.classList.contains("hidden")) {
    return;
  }
  overlay.classList.remove("is-visible");
  if (state.localAdvanceOverlayHideTimer) {
    window.clearTimeout(state.localAdvanceOverlayHideTimer);
  }
  state.localAdvanceOverlayHideTimer = window.setTimeout(() => {
    overlay.classList.add("hidden");
    state.localAdvanceOverlayHideTimer = null;
  }, localAdvanceOverlayFadeMs);
}

function showSongTransitionOverlayForData(data) {
  if (!data || !isPlayerPanelFullscreen()) {
    return;
  }
  const playlist = Array.isArray(data.playlist) ? data.playlist : [];
  const primaryItem = data.current_item || playlist[0] || null;
  if (!primaryItem) {
    return;
  }
  const delaySeconds = manualTransitionOverlaySeconds(data);
  clearLocalAdvanceDelay({ resetInFlight: false, hideOverlay: false });
  const token = state.localAdvanceDelayToken;

  state.localAdvanceOverlayMode = "manual";
  state.localAdvanceOverlayPrimaryItem = primaryItem;
  state.localAdvanceOverlayFollowItems = data.current_item ? playlist : playlist.slice(1);
  state.localAdvanceOverlayTotalCount = (data.current_item ? 1 : 0) + playlist.length;
  state.localAdvanceOverlayDurationMs = delaySeconds * 1000;
  state.localAdvanceDelayDeadline = Date.now() + state.localAdvanceOverlayDurationMs;
  updateLocalAdvanceDelayOverlay();
  state.localAdvanceCountdownTimer = window.setInterval(updateLocalAdvanceDelayOverlay, 250);
  state.localAdvanceDelayTimer = window.setTimeout(() => {
    if (state.localAdvanceDelayToken === token) {
      clearLocalAdvanceDelay({ resetInFlight: false });
    }
  }, state.localAdvanceOverlayDurationMs);
}

function maybeShowSongTransitionOverlay(previousData, nextData, { force = false } = {}) {
  if (!nextData || !isPlayerPanelFullscreen()) {
    return;
  }
  const previousId = currentItemIdFromData(previousData);
  const nextId = currentItemIdFromData(nextData);
  if (!nextId || (!force && previousId === nextId)) {
    return;
  }
  const transitionKey = `${nextId}|${Number(nextData.state_revision || 0)}`;
  if (!force && state.lastSongTransitionOverlayKey === transitionKey) {
    return;
  }
  state.lastSongTransitionOverlayKey = transitionKey;
  state.pendingSongTransitionOverlayData = nextData;
}

function flushPendingSongTransitionOverlay() {
  if (!state.pendingSongTransitionOverlayData) {
    return;
  }
  const overlayData = state.pendingSongTransitionOverlayData;
  state.pendingSongTransitionOverlayData = null;
  showSongTransitionOverlayForData(overlayData);
}

function renderPlayerDelayItemRow(item, index) {
  const row = document.createElement("div");
  row.className = "player-delay-list-row";

  const indexNode = document.createElement("span");
  indexNode.className = "player-delay-list-index";
  indexNode.textContent = String(index);

  const titleNode = document.createElement("p");
  titleNode.className = "player-delay-song-title";
  titleNode.textContent = delayOverlayTitleForItem(item);

  const requesterNode = document.createElement("p");
  requesterNode.className = "player-delay-requester";
  requesterNode.textContent = item?.requester_name || "—";

  const durationNode = document.createElement("p");
  durationNode.className = "player-delay-duration";
  durationNode.textContent = formatDurationSeconds(durationSecondsForItem(item));

  row.append(indexNode, titleNode, requesterNode, durationNode);
  return row;
}

function renderLocalAdvanceDelayQueue(overlay) {
  const playlist = Array.isArray(state.data?.playlist) ? state.data.playlist : [];
  const primaryItem = state.localAdvanceOverlayPrimaryItem || playlist[0] || null;
  const followItemsSource = Array.isArray(state.localAdvanceOverlayFollowItems)
    ? state.localAdvanceOverlayFollowItems
    : playlist.slice(1);
  const totalCount = Number.isFinite(state.localAdvanceOverlayTotalCount)
    ? Number(state.localAdvanceOverlayTotalCount)
    : (state.data?.current_item ? 1 : 0) + playlist.length;
  const signature = [
    state.localAdvanceOverlayMode || "auto",
    delayOverlayItemSignature(primaryItem),
    ...followItemsSource.map(delayOverlayItemSignature),
    totalCount,
  ].join("||");
  if (overlay.dataset.queueSignature === signature) {
    return;
  }
  overlay.dataset.queueSignature = signature;

  setTextContent(overlay.querySelector("[data-delay-next-title]"), delayOverlayTitleForItem(primaryItem, "准备下一首"));
  setTextContent(overlay.querySelector("[data-delay-next-requester]"), primaryItem?.requester_name || "—");
  setTextContent(overlay.querySelector("[data-delay-next-duration]"), formatDurationSeconds(durationSecondsForItem(primaryItem)));

  const listNode = overlay.querySelector("[data-delay-list]");
  if (listNode) {
    const followItems = followItemsSource.slice(0, localAdvanceOverlayMaxRows);
    const rows = followItems.map((item, index) => renderPlayerDelayItemRow(item, index + 1));
    if (!rows.length) {
      const emptyRow = document.createElement("div");
      emptyRow.className = "player-delay-list-more";
      emptyRow.textContent = "后续点歌列表暂时为空";
      rows.push(emptyRow);
    }
    const remainingCount = Math.max(0, followItemsSource.length - followItems.length);
    if (remainingCount > 0) {
      const moreRow = document.createElement("div");
      moreRow.className = "player-delay-list-more";
      moreRow.textContent = `还有 ${remainingCount} 首点歌等待中`;
      rows.push(moreRow);
    }
    listNode.replaceChildren(...rows);
  }

  setTextContent(overlay.querySelector("[data-delay-total]"), `共 ${totalCount} 首`);
}

function updateLocalAdvanceDelayOverlay() {
  const overlay = ensurePlayerDelayOverlay();
  const remainingSeconds = Math.max(
    0,
    Math.ceil((state.localAdvanceDelayDeadline - Date.now()) / 1000),
  );
  const countNode = overlay.querySelector("[data-delay-count]");
  setTextContent(countNode, String(remainingSeconds));
  const totalDurationMs = Math.max(1000, Number(state.localAdvanceOverlayDurationMs || 0));
  const remainingMs = Math.max(0, state.localAdvanceDelayDeadline - Date.now());
  const progress = Math.max(0, Math.min(1, remainingMs / totalDurationMs));
  overlay.style.setProperty("--delay-ring-offset", String(119.38 * (1 - progress)));
  renderLocalAdvanceDelayQueue(overlay);
  if (state.localAdvanceDelayDeadline > 0 && isPlayerPanelFullscreen()) {
    setPlayerDelayOverlayVisible(overlay);
  } else {
    hidePlayerDelayOverlay();
  }
}

function clearLocalAdvanceDelay({ resetInFlight = false, hideOverlay = true } = {}) {
  if (state.localAdvanceDelayTimer) {
    window.clearTimeout(state.localAdvanceDelayTimer);
    state.localAdvanceDelayTimer = null;
  }
  if (state.localAdvanceCountdownTimer) {
    window.clearInterval(state.localAdvanceCountdownTimer);
    state.localAdvanceCountdownTimer = null;
  }
  if (hideOverlay) {
    state.localAdvanceDelayDeadline = 0;
    state.localAdvanceOverlayDurationMs = 0;
    state.localAdvanceOverlayMode = "";
    state.localAdvanceOverlayPrimaryItem = null;
    state.localAdvanceOverlayFollowItems = null;
    state.localAdvanceOverlayTotalCount = null;
    state.localAdvanceDelayItemId = "";
    hidePlayerDelayOverlay();

    // 延迟结束后自动开始播放音视频
    const video = activePrimaryVideoElement();
    if (video && video.paused) {
      state.localShouldBePlaying = true;
      video.play().catch(() => {});
    }
  }
  state.localAdvanceDelayToken += 1;
  if (resetInFlight) {
    state.localAdvanceInFlight = false;
  }
}

function startLocalAdvanceDelay(delaySeconds) {
  const currentItemId = String(state.data?.current_item?.id || "");
  if (!currentItemId) {
    return;
  }
  clearLocalAdvanceDelay();
  state.localAdvanceInFlight = true;
  state.localAdvanceDelayItemId = currentItemId;
  state.localAdvanceDelayToken += 1;
  const token = state.localAdvanceDelayToken;
  state.localAdvanceOverlayMode = "auto";
  state.localAdvanceOverlayDurationMs = delaySeconds * 1000;
  state.localAdvanceDelayDeadline = Date.now() + state.localAdvanceOverlayDurationMs;
  updateLocalAdvanceDelayOverlay();
  showMountedPlayerControls();
  state.localAdvanceCountdownTimer = window.setInterval(updateLocalAdvanceDelayOverlay, 250);
  state.localAdvanceDelayTimer = window.setTimeout(() => {
    finishLocalAdvanceDelay(token, currentItemId).catch(() => {});
  }, delaySeconds * 1000);
}

async function finishLocalAdvanceDelay(token, itemId) {
  if (token !== state.localAdvanceDelayToken || itemId !== state.localAdvanceDelayItemId) {
    return;
  }
  clearLocalAdvanceDelay({ resetInFlight: true });
  await advanceLocalPlayerNow({ showTransition: false });
}

function teardownMountedPlayer() {
  clearLocalPlayerSyncTimer();
  clearLocalPlayerControlsHideTimer();
  clearLocalPlayerSeekState();
  clearLocalAdvanceDelay({ resetInFlight: true });
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
  return mountedLocalVideoElement();
}

function isActiveSplitPlayer(video, audio) {
  const active = activeLocalPlayerElements();
  return active.video === video && active.audio === audio;
}

function isSplitPlayerSeekSettling(video, audio) {
  return state.localSeekSettling && isActiveSplitPlayer(video, audio);
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
  if (primaryVideo && !state.localSeekSettling) {
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
  const nextVolume = Number.isFinite(video.volume)
    ? Math.max(0, Math.min(1, Number(video.volume)))
    : state.localPlayerVolume;
  const nextMuted = Boolean(video.muted);
  const changed = Math.abs(nextVolume - state.localPlayerVolume) > 0.001
    || nextMuted !== state.localPlayerMuted;

  if (changed) {
    state.localPlayerVolume = nextVolume;
    state.localPlayerMuted = nextMuted;
    persistLocalVolumePreferences();
    renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
  }

  if (Math.abs(audio.volume - state.localPlayerVolume) > 0.001) {
    audio.volume = state.localPlayerVolume;
  }
  if (audio.muted !== state.localPlayerMuted) {
    audio.muted = state.localPlayerMuted;
  }
}

function syncSplitSeekAudioTarget(video, audio) {
  if (!video || !audio || audio.readyState < 1) {
    return 0;
  }
  const targetAudioTime = clampMediaTime(audio, Number(video.currentTime || 0) - currentAvOffsetSeconds());
  setMediaCurrentTime(audio, targetAudioTime);
  return targetAudioTime;
}

function scheduleSplitPlayerSeekSettle(video, audio) {
  if (!isSplitPlayerSeekSettling(video, audio)) {
    return;
  }
  if (state.localSeekSettleTimer) {
    window.clearTimeout(state.localSeekSettleTimer);
    state.localSeekSettleTimer = null;
  }
  state.localSeekSettleTimer = window.setTimeout(() => {
    state.localSeekSettleTimer = null;
    settleSplitPlayerSeek(video, audio);
  }, localPlayerSeekSettlePollMs);
}

function beginSplitPlayerSeek(video, audio, options = {}) {
  if (!video || !audio || !isActiveSplitPlayer(video, audio)) {
    return;
  }

  const resumeAfterSeek = Boolean(options.resumeAfterSeek);
  state.localSeekSettling = true;
  state.localSeekResumeAfterSettle = resumeAfterSeek;
  state.localSeekSettleStartedAt = Date.now();
  state.localSeekResumePending = resumeAfterSeek;
  state.localShouldBePlaying = resumeAfterSeek;
  if (typeof options.onSettled === "function") {
    state.localSeekSettleCallback = options.onSettled;
  }

  if (!audio.paused) {
    audio.pause();
  }
  if (!video.paused) {
    video.pause();
  }
  if (Number.isFinite(options.targetTime)) {
    setMediaCurrentTime(video, options.targetTime);
  }

  syncSplitSeekAudioTarget(video, audio);
  scheduleSplitPlayerSeekSettle(video, audio);
}

function settleSplitPlayerSeek(video, audio, force = false) {
  if (!isSplitPlayerSeekSettling(video, audio)) {
    return false;
  }

  const targetAudioTime = syncSplitSeekAudioTarget(video, audio);
  const elapsedMs = Date.now() - state.localSeekSettleStartedAt;
  const audioNeedsData = targetAudioTime > 0 && audio.readyState < 2;
  const waitingForMedia = video.seeking || audio.seeking || video.readyState < 2 || audio.readyState < 1 || audioNeedsData;
  if (!force && waitingForMedia && elapsedMs < localPlayerSeekSettleMaxMs) {
    scheduleSplitPlayerSeekSettle(video, audio);
    return false;
  }

  const resumeAfterSettle = state.localSeekResumeAfterSettle && !video.ended;
  const onSettled = state.localSeekSettleCallback;
  clearLocalPlayerSeekState();

  syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  if (resumeAfterSettle) {
    state.localShouldBePlaying = true;
    video.play()
      .then(() => syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true))
      .catch(() => {});
  } else {
    state.localShouldBePlaying = false;
    if (!audio.paused) {
      audio.pause();
    }
  }

  if (typeof onSettled === "function") {
    onSettled();
  }
  return true;
}

function syncSplitPlayer(video, audio, offsetSeconds, forceSeek = false) {
  if (!video || !audio) {
    return;
  }

  syncSplitPlayerVolumeFromVideo(video, audio);
  audio.playbackRate = Number(video.playbackRate || 1) || 1;

  if (isSplitPlayerSeekSettling(video, audio)) {
    if (!audio.paused) {
      audio.pause();
    }
    return;
  }

  if (video.seeking) {
    if (!audio.paused) {
      audio.pause();
    }
    return;
  }
  if (!video.paused && video.readyState < 2) {
    if (!audio.paused) {
      audio.pause();
    }
    return;
  }
  if (audio.seeking && !forceSeek) {
    return;
  }

  const targetAudioTime = clampMediaTime(audio, Number(video.currentTime || 0) - offsetSeconds);
  const drift = Math.abs(Number(audio.currentTime || 0) - targetAudioTime);

  if (
    (forceSeek && drift > localPlayerForceSyncEpsilonSeconds)
    || (!forceSeek && drift > localPlayerHardSyncThresholdSeconds)
  ) {
    setMediaCurrentTime(audio, targetAudioTime);
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

function muteIcon(isMuted) {
  return isMuted ? "🔇" : "🔊";
}

function setRangeFillPercent(input, percent) {
  if (!input) {
    return;
  }
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
  const nextValue = `${normalizedPercent}%`;
  if (input.style.getPropertyValue("--range-fill-percent") !== nextValue) {
    input.style.setProperty("--range-fill-percent", nextValue);
  }
}

function renderVolumeControls(playbackMode) {
  if (!elements.volumePanel || !elements.volumeSlider || !elements.volumeMuteButton || !elements.volumeValue) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  const volumePercent = Math.round(state.localPlayerVolume * 100);
  const label = volumePercentText();
  const muteLabel = state.localPlayerMuted ? "取消静音" : "静音";
  const muteButtonText = muteIcon(state.localPlayerMuted);
  const signature = JSON.stringify({
    isLocalMode,
    volumePercent,
    label,
    muteLabel,
    muteButtonText,
    muted: state.localPlayerMuted,
  });

  if (signature === state.volumeControlsRenderSignature) {
    return;
  }
  state.volumeControlsRenderSignature = signature;

  setClassToggle(elements.volumePanel, "hidden", !isLocalMode);
  if (elements.volumeSlider.value !== String(volumePercent)) {
    elements.volumeSlider.value = String(volumePercent);
  }
  setRangeFillPercent(elements.volumeSlider, volumePercent);
  setTextContent(elements.volumeValue, label);
  setTextContent(elements.volumeMuteButton, muteButtonText);
  elements.volumeMuteButton.setAttribute("aria-label", muteLabel);
  elements.volumeMuteButton.setAttribute("title", muteLabel);
  setClassToggle(elements.volumeMuteButton, "is-muted", state.localPlayerMuted);
}

function persistLocalVolumePreferences() {
  writeLocalPreference(storageKeys.playerVolume, state.localPlayerVolume);
  writeLocalPreference(storageKeys.playerMuted, state.localPlayerMuted);
}

async function setLocalPlayerVolume(nextVolume, { unmute = true } = {}) {
  const normalizedVolume = Math.max(0, Math.min(1, Number(nextVolume || 0)));
  const previousVolume = state.localPlayerVolume;
  const previousMuted = state.localPlayerMuted;
  const requestSeq = markLocalVolumeWrite();
  state.localPlayerVolume = normalizedVolume;
  if (unmute && normalizedVolume > 0) {
    state.localPlayerMuted = false;
  }
  persistLocalVolumePreferences();
  applyStoredVolumeToMountedPlayer();
  renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
  try {
    const nextData = await apiPost("/api/player/volume", {
      volume_percent: Math.round(normalizedVolume * 100),
      is_muted: state.localPlayerMuted,
    });
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    state.data = nextData;
    render();
  } catch (error) {
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    state.playerSettingsEchoSuppressUntil = 0;
    state.localPlayerVolume = previousVolume;
    state.localPlayerMuted = previousMuted;
    persistLocalVolumePreferences();
    applyStoredVolumeToMountedPlayer();
    renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
    setAppMessage(error.message, true);
  }
}

async function toggleLocalPlayerMute() {
  const previousMuted = state.localPlayerMuted;
  const requestSeq = markLocalVolumeWrite();
  state.localPlayerMuted = !state.localPlayerMuted;
  persistLocalVolumePreferences();
  applyStoredVolumeToMountedPlayer();
  renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
  try {
    const nextData = await apiPost("/api/player/volume", {
      volume_percent: Math.round(state.localPlayerVolume * 100),
      is_muted: state.localPlayerMuted,
    });
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    state.data = nextData;
    render();
  } catch (error) {
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    state.playerSettingsEchoSuppressUntil = 0;
    state.localPlayerMuted = previousMuted;
    persistLocalVolumePreferences();
    applyStoredVolumeToMountedPlayer();
    renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
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
      renderAudioVariantBar(state.data.current_item, frontendPlaybackMode(state.data.playback_mode));
    }
  }, remainingMs);
}

function renderAudioVariantBar(currentItem, playbackMode) {
  if (playbackMode !== "local" || !currentItem) {
    const signature = JSON.stringify({ hidden: true, playbackMode, itemId: currentItem?.id || "" });
    if (signature === state.audioVariantBarRenderSignature) {
      return;
    }
    state.audioVariantBarRenderSignature = signature;
    if (elements.audioVariantBar.childElementCount) {
      elements.audioVariantBar.innerHTML = "";
    }
    setClassToggle(elements.audioVariantBar, "hidden", true);
    state.audioVariantBarExpanded = false;
    state.audioVariantBarItemId = "";
    return;
  }

  const variants = partOptionsForItem(currentItem);
  if (variants.length <= 1) {
    const signature = JSON.stringify({
      hidden: true,
      playbackMode,
      itemId: currentItem.id,
      variantCount: variants.length,
    });
    if (signature === state.audioVariantBarRenderSignature) {
      return;
    }
    state.audioVariantBarRenderSignature = signature;
    if (elements.audioVariantBar.childElementCount) {
      elements.audioVariantBar.innerHTML = "";
    }
    setClassToggle(elements.audioVariantBar, "hidden", true);
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
  const signature = JSON.stringify({
    hidden: false,
    itemId: currentItem.id,
    selectedVariantId: selectedVariant?.id || "",
    buttonsDisabled,
    expanded: state.audioVariantBarExpanded,
    variants: variants.map((variant) => ({
      id: variant.id,
      label: variant.label || variant.id,
      page: variant.page || "",
      bound: Boolean(variant.bound),
    })),
  });
  if (signature === state.audioVariantBarRenderSignature) {
    return;
  }
  state.audioVariantBarRenderSignature = signature;

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
  setClassToggle(elements.audioVariantBar, "hidden", false);
}

function renderAvSyncControls(playbackMode, playerSettings) {
  if (!elements.avSyncPanel || !elements.avOffsetInput) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  elements.avSyncPanel.classList.toggle("hidden", !isLocalMode);
  const offsetMs = currentAvOffsetMs();
  elements.avOffsetInput.disabled = state.avOffsetSaving;
  if (elements.avOffsetResetButton) {
    elements.avOffsetResetButton.disabled = state.avOffsetSaving || offsetMs === 0;
  }
  if (document.activeElement !== elements.avOffsetInput || state.avOffsetSaving) {
    elements.avOffsetInput.value = String(offsetMs);
  }
}

function renderPlayer(currentItem, playbackMode) {
  const selectedVideoUrl = currentItem ? selectedVideoUrlForItem(currentItem) : "";
  const selectedAudioUrl = currentItem ? selectedAudioUrlForItem(currentItem) : "";
  const hasSplitPlayback = Boolean(selectedVideoUrl && selectedAudioUrl);

  const signature = [
    currentItem ? currentItem.id : "none",
    playbackMode,
    selectedVideoUrl,
    selectedAudioUrl,
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
    && hasSplitPlayback
    && previousPlayerContext?.playbackMode === "local"
    && previousPlayerContext.itemId === currentItem.id
    && (
      previousPlayerContext.videoUrl !== selectedVideoUrl
      || previousPlayerContext.audioUrl !== selectedAudioUrl
    )
  ) {
    const currentVideo = elements.playerFrame.querySelector('video[data-player-role="video"]')
      || elements.playerFrame.querySelector("video");

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
    videoUrl: selectedVideoUrl,
    audioUrl: selectedAudioUrl,
    playbackMode,
  };

  captureLocalPlayerPreferences();
  teardownMountedPlayer();

  if (!currentItem) {
    elements.playerFrame.innerHTML =
      '<div class="empty-state"><p>把 B 站视频链接加入点歌列表后，这里会开始播放。</p></div>';
    return;
  }

  // LEGACY: online embed playback is kept for reference, but normal frontend
  // rendering now passes only the local mode.
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

  if (!hasSplitPlayback) {
    elements.playerFrame.innerHTML = `
      <div class="empty-state">
        <p>当前歌曲正在准备独立音视频轨。</p>
        <p class="empty-hint">${escapeHtml(currentItem.cache_message || "正在后台缓存")}</p>
      </div>
    `;
    return;
  }

  const willShowOverlay = Boolean(state.pendingSongTransitionOverlayData);
  const isDelaying = state.localAdvanceDelayDeadline > 0 && Date.now() < state.localAdvanceDelayDeadline;
  const shouldAutoplay = !(willShowOverlay || isDelaying);
  const autoplayAttr = shouldAutoplay ? "autoplay" : "";

  elements.playerFrame.innerHTML = `
    <video
      data-player-role="video"
      controls
      controlsList="nofullscreen"
      ${autoplayAttr}
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

  if (!video || !audio) {
    return;
  }

  applyStoredVolumeToSplitPlayer(video, audio);
  showMountedPlayerControls();

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
    state.pendingPlaybackRestore = null;
    beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek: Boolean(pendingRestore.wasPlaying),
      targetTime: pendingRestore.currentTime,
      onSettled: reportCurrentVideoStatus,
    });
  };

  video.addEventListener("loadedmetadata", () => {
    showMountedPlayerControls();
    maybeRestorePlayback();
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
    } else {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
    }
    reportCurrentVideoStatus();
  });

  audio.addEventListener("loadedmetadata", () => {
    maybeRestorePlayback();
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
    } else {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
    }
  });

  video.addEventListener("play", () => {
    if (isSplitPlayerSeekSettling(video, audio)) {
      state.localSeekResumeAfterSettle = true;
      state.localShouldBePlaying = true;
      state.localSeekResumePending = true;
      video.pause();
      return;
    }
    state.localShouldBePlaying = true;
    state.localSeekResumePending = false;
    showMountedPlayerControls();
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
    showMountedPlayerControls();
    reportCurrentVideoStatus();
  });

  video.addEventListener("seeking", () => {
    beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek: !video.paused || state.localShouldBePlaying,
      onSettled: reportCurrentVideoStatus,
    });
  });

  video.addEventListener("seeked", () => {
    showMountedPlayerControls();
    if (!settleSplitPlayerSeek(video, audio)) {
      reportCurrentVideoStatus();
    }
  });

  video.addEventListener("canplay", () => {
    settleSplitPlayerSeek(video, audio);
  });

  audio.addEventListener("seeked", () => {
    settleSplitPlayerSeek(video, audio);
  });

  audio.addEventListener("canplay", () => {
    settleSplitPlayerSeek(video, audio);
  });

  video.addEventListener("waiting", () => {
    if (!audio.paused) {
      audio.pause();
    }
  });

  video.addEventListener("playing", () => {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  });

  video.addEventListener("ratechange", () => {
    showMountedPlayerControls();
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  });

  video.addEventListener("volumechange", () => {
    showMountedPlayerControls();
    syncSplitPlayerVolumeFromVideo(video, audio);
  });

  ["pointermove", "pointerdown", "touchstart"].forEach((eventName) => {
    video.addEventListener(eventName, () => {
      showMountedPlayerControls();
    }, { passive: true });
  });

  video.addEventListener("ended", async () => {
    state.localShouldBePlaying = false;
    state.localSeekResumePending = false;
    audio.pause();
    showMountedPlayerControls();
    reportCurrentVideoStatus();
    await handleLocalPlaybackEnded();
  });

  audio.addEventListener("ended", () => {
    if (isSplitPlayerSeekSettling(video, audio)) {
      return;
    }
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  });

  state.localPlayerSyncTimer = window.setInterval(() => {
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
      reportCurrentVideoStatus();
      return;
    }
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    reportCurrentVideoStatus();
  }, localPlayerSyncIntervalMs);

  window.setTimeout(() => {
    showMountedPlayerControls();
    maybeRestorePlayback();
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
    } else {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
    }
    reportCurrentVideoStatus();
  }, 0);
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
    if (action === "next-track") {
      requestNextTrack().catch(() => {});
    } else {
      const video = elements.playerFrame.querySelector("video");
      const audio = elements.playerFrame.querySelector('audio[data-player-role="audio"]');
      if (video) {
        if (action === "toggle-play") {
          if (audio && isSplitPlayerSeekSettling(video, audio)) {
            const shouldResume = !state.localSeekResumeAfterSettle;
            state.localSeekResumeAfterSettle = shouldResume;
            state.localShouldBePlaying = shouldResume;
            state.localSeekResumePending = shouldResume;
            if (!shouldResume) {
              video.pause();
              audio.pause();
            }
          } else if (video.paused) {
            state.localShouldBePlaying = true;
            video.play().catch(() => {});
          } else {
            state.localShouldBePlaying = false;
            video.pause();
          }
        } else if (action === "seek-relative" || action === "seek-absolute") {
          const deltaSeconds = Number(command?.delta_seconds || 0);
          const targetSeconds = Number(command?.target_seconds ?? 0);
          if (
            (action === "seek-relative" && Number.isFinite(deltaSeconds) && deltaSeconds !== 0)
            || (action === "seek-absolute" && Number.isFinite(targetSeconds))
          ) {
            const resumeAfterSeek = !video.paused || state.localShouldBePlaying;
            const duration = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
            const nextTime = action === "seek-absolute"
              ? Math.max(0, targetSeconds)
              : Math.max(0, Number(video.currentTime || 0) + deltaSeconds);
            const clampedNextTime = Number.isFinite(duration)
              ? Math.min(nextTime, duration)
              : nextTime;
            if (audio) {
              beginSplitPlayerSeek(video, audio, {
                resumeAfterSeek,
                targetTime: clampedNextTime,
                onSettled: () => reportPlayerStatus(currentItem.id, video),
              });
            } else {
              state.localSeekResumePending = resumeAfterSeek;
              setMediaCurrentTime(video, clampedNextTime);
            }
            if (!audio && state.localSeekResumePending) {
              video.play().catch(() => {});
            }
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
  const duration = Number.isFinite(video.duration) ? Number(video.duration) : 0;
  const signature = [
    normalizedItemId,
    video.paused ? "paused" : "playing",
    Math.round(currentTime),
    Math.round(duration),
  ].join("|");
  if (signature === state.lastReportedPlayerStatusSignature) {
    return;
  }
  state.lastReportedPlayerStatusSignature = signature;

  apiPost("/api/player/status", {
    item_id: normalizedItemId,
    is_paused: video.paused,
    current_time: currentTime,
    duration,
  }).catch(() => {});
}

function renderPlaylist(playlist, currentItem, cachePolicy) {
  if (!playlist.length) {
    const emptyMessage = state.data?.current_item
      ? '<div class="queue-empty"><p>点歌列表已经空了。</p><p>可以继续从左侧点下一首。</p></div>'
      : '<div class="queue-empty"><p>点歌列表还是空的。</p><p>把链接加到左侧输入框里就行。</p></div>';
    const signature = state.data?.current_item ? "empty-with-current" : "empty";
    if (signature === state.playlistEmptyRenderSignature) {
      return;
    }
    state.playlistEmptyRenderSignature = signature;
    elements.playlist.innerHTML = emptyMessage;
    return;
  }

  state.playlistEmptyRenderSignature = "";
  const existingNodes = new Map(
    [...elements.playlist.querySelectorAll(".song-item")].map((node) => [node.dataset.id, node]),
  );

  elements.playlist.querySelectorAll(".queue-empty").forEach((node) => {
    node.remove();
  });

  playlist.forEach((item, index) => {
    const node = existingNodes.get(item.id)
      || elements.playlistTemplate.content.firstElementChild.cloneNode(true);
    if (node.dataset.id !== item.id) {
      node.dataset.id = item.id;
    }

    const badge = node.querySelector(".song-progress-badge");
    const indexLabel = node.querySelector(".song-index-label");
    const sizeLabel = node.querySelector(".song-size-label");
    const readyIndicator = node.querySelector(".song-badge-check");
    const retryButton = node.querySelector(".song-retry-button");
    const note = node.querySelector(".song-note");
    const titleNode = node.querySelector(".song-title");
    const requesterNode = node.querySelector(".song-requester");

    const badgeState = badgeStateForItem(item, index, currentItem, cachePolicy);
    const sizeText = cacheSizeLabelForItem(item);
    const ownerTooltip = ownerTooltipForEntry(item);
    const requesterText = requesterBadgeText(item.requester_name);
    const noteText = noteForItem(item);
    const staticSignature = JSON.stringify({
      title: item.display_title,
      ownerTooltip,
      requesterText,
    });
    if (node.dataset.staticSignature !== staticSignature) {
      node.dataset.staticSignature = staticSignature;
      setTextContent(titleNode, item.display_title);
      setElementTitle(node, "");
      setElementTitle(titleNode, ownerTooltip);
      setTextContent(requesterNode, requesterText);
      setClassToggle(requesterNode, "hidden", !requesterText);
      node.querySelectorAll("button").forEach((button) => {
        if (button.dataset.id !== item.id) {
          button.dataset.id = item.id;
        }
      });
    }

    const badgeDelay = badgeAnimationDelay(item.id);
    const dynamicSignature = JSON.stringify({
      index,
      badgeState,
      cacheStatus: item.cache_status,
      badgeDelay,
      badgeTitle: badgeTitleForItem(item),
      sizeText,
      noteText,
      cacheProgress: item.cache_progress,
    });
    if (node.dataset.dynamicSignature !== dynamicSignature) {
      node.dataset.dynamicSignature = dynamicSignature;
      setTextContent(indexLabel, String(index + 1));
      setClassToggle(badge, "active", badgeState === "active");
      setClassToggle(badge, "idle", badgeState === "idle");
      setClassToggle(badge, "ready", item.cache_status === "ready");
      setClassToggle(badge, "failed", item.cache_status === "failed");
      if (badge.style.getPropertyValue("--badge-delay") !== badgeDelay) {
        badge.style.setProperty("--badge-delay", badgeDelay);
      }
      setClassToggle(readyIndicator, "hidden", item.cache_status !== "ready");
      setElementTitle(badge, badgeTitleForItem(item));
      setTextContent(sizeLabel, sizeText);
      setClassToggle(sizeLabel, "hidden", !sizeText);
      setTextContent(note, noteText);
      setClassToggle(note, "hidden", !noteText);
    }
    syncRetryButton(retryButton, item);

    const referenceNode = elements.playlist.children[index] || null;
    if (node !== referenceNode) {
      elements.playlist.insertBefore(node, referenceNode);
    }
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
  if (item.cache_status === "ready") {
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
  setClassToggle(button, "hidden", !visible);
  if (!visible) {
    if (button.hasAttribute("data-id")) {
      button.removeAttribute("data-id");
    }
    if (button.hasAttribute("title")) {
      button.removeAttribute("title");
    }
    if (button.hasAttribute("aria-label")) {
      button.removeAttribute("aria-label");
    }
    return;
  }
  const tooltip = "点击重新下载";
  if (button.dataset.id !== item.id) {
    button.dataset.id = item.id;
  }
  setElementTitle(button, tooltip);
  setElementAttribute(button, "aria-label", tooltip);
}

function refreshRetryButtons() {
  const data = state.data;
  if (!data) {
    return;
  }

  syncRetryButton(elements.queueCurrentRetry, data.current_item);
  const itemsById = new Map(
    (Array.isArray(data.playlist) ? data.playlist : []).map((item) => [String(item.id || ""), item]),
  );
  elements.playlist.querySelectorAll(".song-item").forEach((node) => {
    const item = itemsById.get(String(node.dataset.id || ""));
    if (!item) {
      return;
    }
    syncRetryButton(node.querySelector(".song-retry-button"), item);
  });
}

function renderHistory(history) {
  const signature = JSON.stringify(history || []);
  if (signature === state.historyRenderSignature) {
    return;
  }
  state.historyRenderSignature = signature;
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
    node.title = "";
    title.title = ownerTooltip;
    const requesterText = requesterBadgeText(entry.requester_name);
    requester.textContent = requesterText;
    requester.classList.toggle("hidden", !requesterText);
    node.querySelector(".history-time").textContent = formatHistoryTime(entry.requested_at);
    node.querySelector(".history-count").textContent = `点歌 ${entry.request_count} 次`;
    node.querySelectorAll("button[data-action]").forEach((button) => {
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
  return `UP 主: ${ownerName}`;
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
  let hash = 0;
  for (const char of String(itemId || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 997;
  }
  const phase = (hash * 0.013) % duration;
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

  const hasSecondaryAction = Boolean(intent.secondaryLabel);
  const hasSourceSelect = Boolean(intent.sourceSelect);
  const hideMessage = Boolean(intent.hideMessage);
  const width = hasSourceSelect ? 340 : 260;
  const popoverHeight = (hasSecondaryAction ? 126 : 112)
    + (hasSourceSelect ? 48 : 0)
    - (hideMessage ? 34 : 0);
  const margin = 12;
  const left = Math.min(
    Math.max(intent.x, margin),
    window.innerWidth - width - margin,
  );
  const top = Math.min(
    Math.max(intent.y, margin),
    window.innerHeight - popoverHeight - margin,
  );

  elements.confirmText.textContent = intent.message || "";
  elements.confirmText.classList.toggle("hidden", hideMessage);
  if (elements.confirmSource) {
    elements.confirmSource.classList.toggle("hidden", !hasSourceSelect);
    if (hasSourceSelect) {
      elements.confirmSource.value = normalizedHistoryExportSource(intent.source);
    }
  }
  elements.confirmOk.textContent = intent.primaryLabel || "确认";
  if (elements.confirmSecondary) {
    elements.confirmSecondary.textContent = intent.secondaryLabel || "";
    elements.confirmSecondary.classList.toggle("hidden", !hasSecondaryAction);
  }
  elements.confirmPopover.style.left = `${left}px`;
  elements.confirmPopover.style.top = `${top}px`;
  elements.confirmPopover.classList.toggle("confirm-popover-wide", hasSourceSelect);
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
    return `《${title}》当前点歌列表里已经有了，而且本次已点过 ${count} 次，仍要继续点歌吗？`;
  }
  if (activeItem) {
    return `《${title}》当前点歌列表里已经有了，仍要继续点歌吗？`;
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
    setFormMessage(intent.position === "next" ? "已按绑定关系顶歌到下一首" : "已按绑定关系加入点歌列表");
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
  if (!url) {
    setFormMessage("请输入 B 站视频链接或 BV 号", true);
    return;
  }
  const requesterName = validatedRequesterNameForAdd();
  if (!requesterName) {
    return;
  }

  setFormMessage("正在解析视频信息并加入点歌列表...");
  try {
    state.data = await submitAddRequest(url, position, { requesterName });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? "已顶歌到下一首" : "已加入点歌列表末尾");
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
      setFormMessage("这首歌已经在当前点歌列表中，或本次已经点过，确认后可继续加入。");
      return;
    }
    setFormMessage(error.message, true);
  }
}

async function handleAddByUrl(url, position, anchorPoint) {
  const requesterName = validatedRequesterNameForAdd();
  if (!requesterName) {
    return;
  }
  setFormMessage("正在从历史记录加入点歌列表...");
  try {
    state.data = await submitAddRequest(url, position, { requesterName });
    setFormMessage(position === "next" ? "已从历史顶歌到下一首" : "已从历史加入点歌列表");
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
      setFormMessage("这首歌已经在当前点歌列表中，或本次已经点过，确认后可继续加入。");
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
    setAppMessage("点歌列表已清空。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function clearHistory() {
  try {
    state.data = await apiPost("/api/history/clear");
    closeConfirm();
    setAppMessage("\u5386\u53f2\u8bb0\u5f55\u5df2\u6e05\u7a7a\u3002");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

function filenameFromContentDisposition(header, fallback) {
  const value = String(header || "");
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return fallback;
    }
  }
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }
  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch ? plainMatch[1].trim() : fallback;
}

function normalizedHistoryExportSource(source) {
  return String(source || "").trim().toLowerCase() === "history" ? "history" : "played";
}

function historyExportSourceLabel(source) {
  return normalizedHistoryExportSource(source) === "history" ? "全部历史" : "本场记录";
}

function selectedConfirmHistoryExportSource(intent) {
  return normalizedHistoryExportSource(elements.confirmSource?.value || intent?.source);
}

async function downloadHistoryExport(format, source = "played") {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  const normalizedSource = normalizedHistoryExportSource(source);
  if (!["csv", "image"].includes(normalizedFormat)) {
    return;
  }
  const params = new URLSearchParams({
    format: normalizedFormat,
    source: normalizedSource,
  });
  const response = await fetch(`/api/playlist/export?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  if (!response.ok) {
    let message = "导出失败";
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep the generic message when the response is not JSON.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const fallback = normalizedFormat === "csv"
    ? `bilikara-${normalizedSource}.csv`
    : `bilikara-${normalizedSource}.png`;
  const filename = filenameFromContentDisposition(response.headers.get("Content-Disposition"), fallback);
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

async function exportHistory(format, source = "played") {
  const normalizedSource = normalizedHistoryExportSource(source);
  const sourceLabel = historyExportSourceLabel(normalizedSource);
  try {
    await downloadHistoryExport(format, normalizedSource);
    closeConfirm();
    setAppMessage(format === "csv" ? `${sourceLabel} CSV 已开始下载。` : `${sourceLabel}图片已开始下载。`);
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function resetRuntimeData() {
  try {
    teardownMountedPlayer();
    state.playerSignature = "";
    state.playerContext = null;
    state.data = await apiPost("/api/data/reset");
    closeConfirm();
    dismissBackupBanner();
    state.listView = "queue";
    setAppMessage("已清空 data，保留已唱归档和抽卡缓存。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function resetPlayerState() {
  try {
    teardownMountedPlayer();
    state.playerSignature = "";
    state.playerContext = null;
    state.localPlayerVolume = 1;
    state.localPlayerMuted = false;
    state.localAvOffsetMs = 0;
    state.playerSettingsEchoSuppressUntil = 0;
    state.avOffsetEchoSuppressUntil = 0;
    state.volumeSaveSeq += 1;
    state.avOffsetSaveSeq += 1;
    state.avOffsetSaving = false;
    persistLocalVolumePreferences();
    writeLocalPreference(storageKeys.avOffsetMs, 0);
    state.data = await apiPost("/api/player/reset");
    closeConfirm();
    render();
    setAppMessage("\u64ad\u653e\u5668\u72b6\u6001\u5df2\u91cd\u7f6e\u3002");
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function checkAppUpdate(event) {
  if (state.updateChecking) {
    return;
  }
  const button = elements.updateCheckButton;
  const point = anchorPointForEvent(event, button || elements.cacheSettings);
  state.updateChecking = true;
  renderUpdatePreviewControl();
  if (button) {
    button.disabled = true;
    button.textContent = "检查中";
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), appUpdateCheckTimeoutMs)
    : null;
  try {
    const query = state.updatePreviewEnabled ? "?include_preview=1" : "";
    const result = await apiGet(`/api/app/update${query}`, { signal: controller?.signal });
    if (result?.update_available || result?.switch_to_release_available) {
      const fallbackMessage = result?.switch_to_release_available
        ? "当前为开发版或非正式版。是否打开 GitHub Releases 下载最新正式版？"
        : "发现新版本。是否打开 GitHub Releases 下载更新？";
      const message = result?.message
        ? `${result.message} 是否打开 GitHub Releases？`
        : fallbackMessage;
      openConfirm({
        type: "open-release",
        releaseUrl: result.release_url,
        message,
        ...point,
      });
      return;
    }
    setAppMessage(result?.message || "当前已是最新版本。");
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "连接 GitHub Releases 超时，请稍后重试。"
      : error?.message || "检查更新失败，请稍后重试。";
    setAppMessage(message, true);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    state.updateChecking = false;
    renderUpdatePreviewControl();
    if (button) {
      button.disabled = false;
      button.textContent = "检查更新";
    }
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

async function advanceLocalPlayerNow({ showTransition = true } = {}) {
  if (state.localAdvanceInFlight) {
    return;
  }
  clearLocalAdvanceDelay({ hideOverlay: !showTransition });
  state.localAdvanceInFlight = true;
  try {
    const previousData = state.data;
    state.data = await apiPost("/api/player/next");
    if (showTransition) {
      maybeShowSongTransitionOverlay(previousData, state.data, { force: true });
    }
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  } finally {
    state.localAdvanceInFlight = false;
  }
}

async function requestNextTrack() {
  await advanceLocalPlayerNow();
}

async function handleLocalPlaybackEnded() {
  if (state.localAdvanceInFlight) {
    return;
  }
  const delaySeconds = currentSongAdvanceDelaySeconds();
  if (!isPlayerPanelFullscreen() || delaySeconds <= 0 || !queuedNextItem()) {
    await advanceLocalPlayerNow();
    return;
  }
  startLocalAdvanceDelay(delaySeconds);
}

async function reorderPlaylist(itemId, index) {
  state.data = await apiPost("/api/playlist/reorder", { item_id: itemId, index });
  render();
}

async function resortPlaylistByCycle() {
  state.data = await apiPost("/api/playlist/resort");
  setAppMessage("已按本场用户座次重新排序点歌列表。");
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

async function setAdvanceDelay(delaySeconds) {
  if (state.advanceDelaySaving) {
    return;
  }

  const currentValue = currentSongAdvanceDelaySeconds();
  if (delaySeconds === currentValue) {
    return;
  }

  state.advanceDelaySaving = true;
  renderAdvanceDelaySlider(state.data?.player_settings);
  try {
    state.data = await apiPost("/api/player/advance-delay", { delay_seconds: delaySeconds });
    setAppMessage(`切歌延迟已调整为 ${delaySeconds} 秒。`);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
    render();
  } finally {
    state.advanceDelaySaving = false;
    if (state.data) {
      renderAdvanceDelaySlider(state.data.player_settings);
    }
  }
}

async function setCachePolicyPreference(payload, successMessage) {
  if (state.cachePolicySaving) {
    return;
  }
  state.cachePolicySaving = true;
  renderCachePolicyControls(state.data?.cache_policy);
  try {
    state.data = await apiPost("/api/cache-policy", payload);
    setAppMessage(successMessage);
    render();
  } catch (error) {
    setAppMessage(error.message, true);
    render();
  } finally {
    state.cachePolicySaving = false;
    if (state.data) {
      renderCachePolicyControls(state.data.cache_policy);
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
    markLocalAvOffsetWrite(boundedOffsetMs);
    if (elements.avOffsetInput) {
      elements.avOffsetInput.value = String(boundedOffsetMs);
    }
    syncMountedLocalPlayer(true);
    return;
  }

  const previousOffsetMs = currentValue;
  const requestSeq = markLocalAvOffsetWrite(boundedOffsetMs);
  writeLocalPreference(storageKeys.avOffsetMs, boundedOffsetMs);
  if (elements.avOffsetInput) {
    elements.avOffsetInput.value = String(boundedOffsetMs);
  }
  syncMountedLocalPlayer(true);
  state.avOffsetSaving = true;
  renderAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
  try {
    const nextData = await apiPost("/api/player/av-offset", { offset_ms: boundedOffsetMs });
    if (requestSeq !== state.avOffsetSaveSeq) {
      return;
    }
    state.data = nextData;
    render();
    syncMountedLocalPlayer(true);
  } catch (error) {
    if (requestSeq !== state.avOffsetSaveSeq) {
      return;
    }
    state.localAvOffsetMs = previousOffsetMs;
    state.avOffsetEchoSuppressUntil = 0;
    writeLocalPreference(storageKeys.avOffsetMs, previousOffsetMs);
    setAppMessage(error.message, true);
    render();
  } finally {
    if (requestSeq === state.avOffsetSaveSeq) {
      state.avOffsetSaving = false;
      renderAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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
    "retry-cache": ["/api/cache/retry", { item_id: itemId }],
  };

  const target = actionMap[action];
  if (!target) {
    return;
  }

  try {
    const previousData = state.data;
    state.data = await apiPost(target[0], target[1]);
    if (action === "play-now") {
      maybeShowSongTransitionOverlay(previousData, state.data, { force: true });
    }
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

elements.resortPlaylistButton?.addEventListener("click", async () => {
  try {
    await resortPlaylistByCycle();
  } catch (error) {
    setAppMessage(error.message, true);
  }
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
    setAppMessage("BBDown 已退出登录。");
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
  updateCacheSliderFill(currentValue, minValue, maxValue);
  elements.cacheLimitScale.querySelectorAll("span").forEach((mark) => {
    mark.classList.toggle("active", Number(mark.textContent || "0") === currentValue);
  });
});

elements.cacheLimitSlider.addEventListener("change", async (event) => {
  await setCacheLimit(Number(event.target.value || "1"));
});

elements.advanceDelaySlider?.addEventListener("input", (event) => {
  const currentValue = Number(event.target.value || "1");
  updateAdvanceDelaySliderFill(currentValue);
  elements.advanceDelayScale.querySelectorAll("span").forEach((mark) => {
    mark.classList.toggle("active", Number(mark.textContent || "0") === currentValue);
  });
});

elements.advanceDelaySlider?.addEventListener("change", async (event) => {
  await setAdvanceDelay(Number(event.target.value || "1"));
});

elements.cacheQualitySelect?.addEventListener("change", async (event) => {
  const quality = String(event.target.value || "").trim();
  if (!quality || quality === String(state.data?.cache_policy?.video_quality || "")) {
    return;
  }
  await setCachePolicyPreference(
    { video_quality: quality },
    `默认清晰度已调整为 ${quality}。`,
  );
});

elements.cacheHiresCheckbox?.addEventListener("change", async (event) => {
  const audioHires = Boolean(event.target.checked);
  if (audioHires === Boolean(state.data?.cache_policy?.audio_hires)) {
    return;
  }
  await setCachePolicyPreference(
    { audio_hires: audioHires },
    audioHires ? "已启用 Hi-Res 音频优先。" : "已关闭 Hi-Res 音频优先。",
  );
});

elements.updatePreviewCheckbox?.addEventListener("change", (event) => {
  state.updatePreviewEnabled = Boolean(event.target.checked);
  writeLocalPreference(storageKeys.updatePreview, state.updatePreviewEnabled);
  renderUpdatePreviewControl();
});

elements.avSyncPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-step], button[data-reset-av-offset]");
  if (!button) {
    return;
  }
  if (button.disabled) {
    return;
  }
  if (button.hasAttribute("data-reset-av-offset")) {
    await setAvOffset(0);
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
    message: "确定清空点歌列表吗？当前正在播放的歌曲不会受影响。",
    x: point.x,
    y: point.y,
  });
});

elements.clearHistoryButton?.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.clearHistoryButton);
  openConfirm({
    type: "clear-history",
    message: "\u786e\u5b9a\u6e05\u7a7a\u5386\u53f2\u8bb0\u5f55\u5417\uff1f\u8fd9\u4e0d\u4f1a\u5f71\u54cd\u5f53\u524d\u64ad\u653e\u6216\u6392\u961f\u4e2d\u7684\u6b4c\u66f2\u3002",
    x: point.x,
    y: point.y,
  });
});

elements.historyExportButton?.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.historyExportButton);
  openConfirm({
    type: "export-history",
    source: "played",
    sourceSelect: true,
    message: "选择导出范围和格式。本场记录是本次启动后已播放的歌曲，全部历史是累计点歌历史。",
    primaryLabel: "导出图片",
    secondaryLabel: "导出 CSV",
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
    await requestNextTrack();
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

// LEGACY: the online embed mode endpoint still exists server-side, but the
// frontend no longer exposes a switch into it.
elements.modeSwitch?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  try {
    state.data = await apiPost("/api/mode", { mode: "local" });
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

elements.dataResetButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const point = anchorPointForEvent(event, elements.dataResetButton);
  openConfirm({
    type: "reset-data",
    message: "确认清空 data？会清空当前点歌列表、用户、历史记录和缓存，但保留已唱归档与抽卡缓存。",
    ...point,
  });
});

elements.currentCacheRetryButton?.addEventListener("click", async (event) => {
  event.stopPropagation();
  const currentItem = state.data?.current_item;
  if (!currentItem?.id) {
    setAppMessage("当前没有正在播放的歌曲。", true);
    return;
  }
  try {
    elements.currentCacheRetryButton.disabled = true;
    state.data = await apiPost("/api/cache/retry", {
      item_id: currentItem.id,
      force: true,
    });
    setAppMessage("已重新开始缓存当前歌曲。");
    render();
  } catch (error) {
    setAppMessage(error.message, true);
    renderPlaybackRepairControls(state.data?.current_item);
  }
});

elements.playerResetButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const point = anchorPointForEvent(event, elements.playerResetButton);
  openConfirm({
    type: "reset-player",
    message: "\u786e\u8ba4\u91cd\u7f6e\u64ad\u653e\u5668\u72b6\u6001\uff1f\u4f1a\u91cd\u65b0\u8f7d\u5165\u5f53\u524d\u64ad\u653e\u5668\u5e76\u6062\u590d\u64ad\u653e\u5668\u8bbe\u7f6e\u3002\u6b4c\u5355\u3001\u5386\u53f2\u548c\u7f13\u5b58\u4e0d\u4f1a\u88ab\u6e05\u7a7a\u3002",
    ...point,
  });
});

elements.updateCheckButton?.addEventListener("click", async (event) => {
  event.stopPropagation();
  await checkAppUpdate(event);
});

elements.audioVariantBar.addEventListener("click", async (event) => {
  const toggleButton = event.target.closest('button[data-action="toggle-audio-variants"]');
  if (toggleButton) {
    state.audioVariantBarExpanded = !state.audioVariantBarExpanded;
    if (state.data?.current_item) {
      renderAudioVariantBar(state.data.current_item, frontendPlaybackMode(state.data.playback_mode));
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
    const requesterName = validatedRequesterNameForAdd(setAppMessage);
    if (!requesterName) {
      return;
    }
    try {
      state.data = await submitAddRequest(currentItem.original_url || currentItem.resolved_url, "tail", {
        requesterName,
        selectedVideoPage: page,
        selectedAudioPages: [page],
      });
      setAppMessage("已将分P加入缓存任务");
      render();
    } catch (error) {
      if (error.code === "duplicate_session_request") {
        const point = anchorPointForEvent(event, button);
        openConfirm({
          type: "duplicate-add",
          url: currentItem.original_url || currentItem.resolved_url,
          position: "tail",
          requesterName,
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
  renderAudioVariantBar(currentItem, frontendPlaybackMode(state.data?.playback_mode));
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
      message: "确定从点歌列表移除这首歌吗？",
      x: point.x,
      y: point.y,
    });
    return;
  }
  await handlePlaylistAction(button);
});

elements.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.dataset.action === "toggle-menu") {
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

elements.confirmSecondary?.addEventListener("click", async () => {
  const intent = state.confirmIntent;
  if (!intent) {
    return;
  }
  if (intent.type === "export-history") {
    await exportHistory("csv", selectedConfirmHistoryExportSource(intent));
    return;
  }
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
    if (intent.type === "clear-history") {
      await clearHistory();
      return;
    }
    if (intent.type === "export-history") {
      await exportHistory("image", selectedConfirmHistoryExportSource(intent));
      return;
    }
    if (intent.type === "reset-data") {
      await resetRuntimeData();
      return;
    }
    if (intent.type === "reset-player") {
      await resetPlayerState();
      return;
    }
    if (intent.type === "open-release" && intent.releaseUrl) {
      window.open(intent.releaseUrl, "_blank", "noopener");
      closeConfirm();
      setAppMessage("已打开 GitHub Releases。");
      return;
    }
    if (intent.type === "remove-item" && intent.itemId) {
      state.data = await apiPost("/api/playlist/remove", { item_id: intent.itemId });
      closeConfirm();
      setAppMessage("已移除这首歌。");
      render();
      return;
    }
    if (intent.type === "gatcha-uid-add" && intent.uid) {
      await confirmGatchaUidAdd(intent);
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
      setFormMessage(intent.position === "next" ? "已确认插队到下一首" : "已确认加入点歌列表");
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
      event.target.closest("#history-export-button") ||
      event.target.closest("#clear-history-button") ||
      event.target.closest('button[data-action="remove"]') ||
      event.target.closest("#queue-next-button") ||
      event.target.closest("#data-reset-button") ||
      event.target.closest("#current-cache-retry-button") ||
      event.target.closest("#player-reset-button") ||
      event.target.closest("#update-check-button") ||
      event.target.closest("#add-form") ||
      event.target.closest("#gatcha-uid-form") ||
      event.target.closest("#refresh-gatcha-cache-button") ||
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

document.addEventListener("click", (event) => {
  const toggle = event.target.closest('[data-action="toggle-menu"]');
  if (toggle) {
    const wrap = toggle.closest(".song-actions-wrap, .history-actions-wrap");
    const menu = wrap?.querySelector(".menu-content");
    if (menu) {
      const isHidden = menu.classList.contains("hidden");
      // Close all other menus first
      document.querySelectorAll(".menu-content").forEach((m) => m.classList.add("hidden"));
      if (isHidden) {
        menu.classList.remove("hidden");
      }
      event.stopPropagation();
      return;
    }
  }

  // Close menus if clicking outside
  if (!event.target.closest(".menu-content")) {
    document.querySelectorAll(".menu-content").forEach((m) => m.classList.add("hidden"));
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
  if (!document.hidden) {
    showMountedPlayerControls();
  }
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

function handleFullscreenChange() {
  if (!isPlayerPanelFullscreen()) {
    hideFullscreenRequestToast();
    hidePlayerDelayOverlay();
  }
  renderPlayerFullscreenButton();
}

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

elements.playlist.addEventListener("dragstart", (event) => {
  const item = event.target.closest(".song-item");
  if (!item) {
    return;
  }
  const dragHandle = event.target.closest("[data-drag-handle]");
  if (!dragHandle || event.target.closest("button")) {
    event.preventDefault();
    return;
  }

  state.dragItemId = item.dataset.id || "";
  state.dragTargetId = "";
  state.dragTargetAfter = false;

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.dragItemId);
    if (typeof event.dataTransfer.setDragImage === "function") {
      const rect = item.getBoundingClientRect();
      event.dataTransfer.setDragImage(
        item,
        Math.max(0, event.clientX - rect.left),
        Math.max(0, event.clientY - rect.top),
      );
    }
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
  if (sourceIndex === -1 || !state.dragTargetId) {
    clearDragState();
    render();
    return;
  }

  let targetIndex = sourceIndex;
  const hoverIndex = playlist.findIndex((item) => item.id === state.dragTargetId);
  if (hoverIndex !== -1) {
    targetIndex = hoverIndex + (state.dragTargetAfter ? 1 : 0);
    if (sourceIndex < targetIndex) {
      targetIndex -= 1;
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

elements.searchCookieToggle?.addEventListener("click", () => {
  state.searchCookieVisible = !state.searchCookieVisible;
  renderSearchCookieFace();
  if (state.searchCookieVisible && !state.followBrowseLoading) {
    state.followBrowseSelectedUid = "";
    if (elements.followSearchQuery) {
      elements.followSearchQuery.value = "";
    }
    loadFollowBrowse({ uid: "", query: "" });
  }
});

elements.followUpGrid?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-uid]");
  if (!button) {
    return;
  }
  const uid = String(button.dataset.uid || "").trim();
  if (!uid) {
    return;
  }
  state.followBrowseSelectedUid = uid;
  if (elements.followSearchQuery) {
    elements.followSearchQuery.value = "";
  }
  await loadFollowBrowse({ uid, query: "" });
});

elements.followBrowseBack?.addEventListener("click", () => {
  state.followBrowseSelectedUid = "";
  if (elements.followSearchQuery) {
    elements.followSearchQuery.value = "";
  }
  renderFollowBrowse();
  renderSearchCookieFace();
});

elements.followSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.followSearchQuery?.value || "").trim();
  await loadFollowBrowse({
    uid: state.followBrowseSelectedUid,
    query,
    keepQuery: true,
  });
});

elements.followSongResults?.addEventListener("click", async (event) => {
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
  } finally {
    button.disabled = false;
  }
});

elements.gatchaUidToggle?.addEventListener("click", () => {
  state.gatchaUidVisible = !state.gatchaUidVisible;
  renderGatchaUidFace();
});

elements.gatchaConfirmButton.addEventListener("click", async () => {
  if (!state.gatchaCandidate) return;

  const url = state.gatchaCandidate.url;
  const requesterName = validatedRequesterNameForAdd(setGatchaMessage);
  if (!requesterName) {
    return;
  }
  setGatchaMessage("Nozomi power 注入！");
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

elements.gatchaUidForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const uid = String(elements.gatchaUidInput?.value || "").trim();
  if (!uid) {
    setGatchaUidMessage("请输入 UID", true);
    return;
  }

  state.gatchaUidSaving = true;
  renderGatchaUidFace();
  setGatchaUidMessage("正在检测 UID...");
  try {
    const preview = await previewGatchaUid(uid);
    const ownerName = preview?.name || `UID ${preview?.uid || uid}`;
    const modeLabel = preview?.cache_mode_label || (preview?.cache_mode === "incremental" ? "最新" : "所有");
    const followedPrefix = preview?.already_followed ? "已在关注列表中，" : "";
    const point = anchorPointForEvent(event, elements.addGatchaUidButton);
    openConfirm({
      type: "gatcha-uid-add",
      uid: preview?.uid || uid,
      name: ownerName,
      message: `确认拉取 UP 主：${ownerName} 的${modeLabel}稿件？`,
      ...point,
    });
    setGatchaUidMessage(`${followedPrefix}检测到 UP 主：${ownerName}`);
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidFace();
  }
});

elements.refreshGatchaCacheButton?.addEventListener("click", async () => {
  state.gatchaRefreshSaving = true;
  renderGatchaUidFace();
  setGatchaUidMessage("正在后台更新抽卡缓存...");
  try {
    const result = await refreshGatchaCache();
    setGatchaUidMessage(result?.started === false ? "抽卡缓存已经在更新中。" : "已开始更新抽卡缓存。");
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaRefreshSaving = false;
    renderGatchaUidFace();
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
window.addEventListener("pageshow", () => {
  showMountedPlayerControls();
  renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
});

startPolling();
