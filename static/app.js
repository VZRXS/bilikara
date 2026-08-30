const pollIntervalMs = 1000;
const bannerAutoHideMs = 5000;
const stalledRetrySeconds = 5;
const localPlayerSyncIntervalMs = 120;
const localPlayerDriftToleranceSeconds = 0.045;
const localPlayerModerateSyncThresholdSeconds = 0.14;
const localPlayerHardSyncThresholdSeconds = 0.5;
const localPlayerForceSyncEpsilonSeconds = 0.015;
const localPlayerSyncSeekCooldownMs = 750;
const localPlayerSyncDiagnosticThrottleMs = 2000;
const localPlayerSeekSettlePollMs = 50;
const localPlayerSeekSettleMaxMs = 1400;
const splitPlaybackStartupWatchdogMs = 3000;
const tauriMediaSessionPositionUpdateMs = 1000;
const playerStatusMaxSeconds = 7 * 24 * 60 * 60;
const mediaPlayPromisesInFlight = new WeakSet();
const audioVariantSwitchDebounceMs = 350;
const playerSettingsEchoSuppressMs = 1800;
const playerClickDelayMs = 220;
const playerControlsAutoHideMs = 5000;
const defaultSongAdvanceDelaySeconds = 3;
const maxSongAdvanceDelaySeconds = 30;
const appUpdateCheckTimeoutMs = 10000;
const avDelayRequestTimeoutMs = 8000;
const fullscreenRequestToastMs = 4200;
const fullscreenRequestToastFadeMs = 500;
const localAdvanceOverlayFadeMs = 500;
const localAdvanceOverlayMaxRows = 5;
const larkSearchTableCount = 5;
const smokeTestBypassPlayerFullscreen = new URLSearchParams(window.location.search)
  .has("bilikara_smoke_bypass_fullscreen");
const developerModeRequesterName = "VZRXS";
const projectUrl = "https://github.com/VZRXS/bilikara";
const searchResultItemByElement = new WeakMap();
let searchDetailController = null;

function openExternalUrl(url) {
  if (window.__TAURI__) {
    apiPost("/api/app/open-url", { url }).catch((err) => {
      console.error("Failed to open URL via backend:", err);
      window.location.href = url;
    });
  } else {
    window.open(url, "_blank");
  }
}
const developerTagResetFieldKeys = [
  "tag_1",
  "tag_2",
  "tag_3",
  "tag_4",
  "tag_5",
  "preserved_2",
  "preserved_3",
  "preserved_4",
  "preserved_5",
];
const developerDeletePreferredFieldKeys = [
  "bvid",
  "mid",
  "title",
  "url",
  "owner_name",
  "owner_url",
  "cover_url",
  "rank",
  "played_count",
  "tag_1",
  "tag_2",
  "tag_3",
  "tag_4",
  "tag_5",
  "tag_status",
  "preserved_1",
  "preserved_2",
  "preserved_3",
  "preserved_4",
  "preserved_5",
];
const storageKeys = {
  playerVolume: "bilikara.player.volume",
  playerMuted: "bilikara.player.muted",
  language: "bilikara.ui.language",
  updateAutomatic: "bilikara.update.automatic",
  updatePreview: "bilikara.update.preview",
  theme: "bilikara.ui.theme",
};

const state = {
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  hasValidStateResponse: false,
  lastPollRenderSignature: "",
  currentTitleRenderSignature: "",
  listHeaderRenderSignature: "",
  requesterSelectRenderSignature: "",
  sessionUsersRenderSignature: "",
  remoteAccessRenderSignature: "",
  cacheSettingsRenderSignature: "",
  bbdownLoginRenderSignature: "",
  gatchaUidFaceRenderSignature: "",
  gatchaTaskLastMessageSignature: "",
  confirmPopoverRenderSignature: "",
  gatchaTaskWatchStartedAt: Date.now() / 1000,
  historyRenderSignature: "",
  playlistEmptyRenderSignature: "",
  cacheSliderRenderSignature: "",
  advanceDelaySliderRenderSignature: "",
  advanceDelaySaving: false,
  advanceDelayDraftValue: null,
  advanceDelayQueuedValue: null,
  advanceDelaySubmittedValue: null,
  advanceDelayRequestSequence: 0,
  advanceDelayActiveRequestSequence: 0,
  cachePolicyControlRenderSignature: "",
  playerFullscreenButtonRenderSignature: "",
  volumeControlsRenderSignature: "",
  queueCurrentRenderSignature: "",
  audioVariantBarRenderSignature: "",
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
  hostPlaybackBootstrapRestartPending: true,
  pageHidePlaybackRestartRequired: false,
  pageHiddenPlaybackGeneration: null,
  pageRestoreRestartInFlight: false,
  audioContext: null,
  localPlayerRequestedRate: 1,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localPlaybackStartGeneration: 0,
  localPlaybackStartPromisesSettled: false,
  localPlaybackEndHandled: false,
  localPlayerControlsHideTimer: null,
  localPlayerControlsHideGeneration: 0,
  localWebKitStartRetryDone: false,
  stageControlTrayOpen: false,
  stageControlInlineCollapsed: false,
  stageControlTrayDirection: "up",
  stageControlTrayFocusHandler: null,
  stageResizeObserver: null,
  stageMeasureFrame: null,
  queueScrollResizeObserver: null,
  queueScrollMeasureFrame: null,
  openRowMenuTrigger: null,
  playedSessionsLoaded: false,
  playedSessionsLoadPromise: null,
  cacheSettingsOpen: false,
  cacheAdvancedOpen: false,
  remoteQrPinned: false,
  displaySettingsOpen: false,
  presentationSettingsOpen: false,
  cacheLimitSaving: false,
  cacheLimitDraftValue: null,
  cacheLimitQueuedValue: null,
  cacheLimitSubmittedValue: null,
  cacheLimitRequestSequence: 0,
  cacheLimitActiveRequestSequence: 0,
  cachePolicySaving: false,
  diagnosticsBusy: false,
  diagnosticsCopyController: null,
  applicationRestartInFlight: false,
  avOffsetSaving: false,
  volumeSaveSeq: 0,
  playerSettingsEchoSuppressUntil: 0,
  localPreferencesHydrated: false,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantSwitchTimer: null,
  audioVariantBarExpanded: false,
  audioVariantBarItemId: "",
  backupBannerShown: false,
  backupBannerDismissed: false,
  backupBannerMode: "",
  previousSessionPromptChecked: false,
  previousSessionPromptEligible: false,
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
  localAdvanceDelayStartAt: 0,
  localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0,
  localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null,
  localAdvanceOverlayTotalCount: null,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  lastSongTransitionOverlayKey: "",
  songTransitionGeneration: 0,
  manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
  localAdvanceDelayToken: 0,
  localAdvanceDelayItemId: "",
  localShouldBePlaying: false,
  localPlayerVolume: 1,
  localPlayerMuted: false,
  pendingPlaybackRestore: null,
  lastAppliedPlayerControlSeq: 0,
  tauriMediaSessionOwner: null,
  lastTauriMediaSessionPositionAt: 0,
  dragItemId: "",
  dragTargetId: "",
  dragTargetAfter: false,
  confirmIntent: null,
  bindingIntent: null,
  gatchaFavlistIntent: null,
  poolConfigOpener: null,
  bilikaraSecretOpener: null,
  developerTagResetOpener: null,
  ratingPromptOpener: null,
  poolConfigAccepted: null,
  poolConfigDraft: null,
  poolConfigLoading: false,
  poolConfigSaving: false,
  poolConfigOpenGeneration: 0,
  poolConfigLoadSequence: 0,
  poolConfigSaveSequence: 0,
  poolConfigMessage: "",
  poolConfigMessageIsError: false,
  developerMode: false,
  bilikaraSecret: "",
  bilikaraSecretVerifying: false,
  developerTagResetItem: null,
  developerTagResetAction: "",
  developerTagResetSaving: false,
  retryActivityById: {},
  gatchaCandidate: null,
  gatchaView: "idle",
  gatchaDrawBusy: false,
  gatchaDrawSequence: 0,
  gatchaDrawControlId: "gatcha-button",
  gatchaDrawError: "",
  gatchaMessage: "",
  gatchaMessageIsError: false,
  gatchaRequestBusy: false,
  gatchaScrollTop: 0,
  requestSubview: "search",
  focusedRequestSubview: "search",
  searchMode: "shared",
  focusedSearchMode: "shared",
  discoverMode: "categories",
  focusedDiscoverMode: "categories",
  sourcesMode: "uids",
  focusedSourcesMode: "uids",
  catalogAdvancedTool: "",
  requestScrollPositions: {
    search: { shared: 0, local: 0 },
    discover: { categories: 0, name: 0, artist: 0 },
    sources: { uids: 0, favorites: 0 },
  },
  requestScrollRestoring: false,
  requestScrollRestoreToken: 0,
  sourceParentScrollPositions: { uids: 0, favorites: 0 },
  sourceItemScrollPositions: { uids: 0, favorites: 0 },
  searchModeState: {
    shared: { draft: "", submitted: "", items: [], error: "", message: "", seq: 0 },
    local: { draft: "", submitted: "", items: [], error: "", message: "", seq: 0 },
  },
  requestDetailSelections: {
    shared: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    local: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    categories: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    name: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    artist: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    uids: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
    favorites: { selectedKey: "", origin: null, focusElement: null, closedForNavigation: false },
  },
  activeRequestDetailOriginKey: "",
  larkSearchLoading: false,
  larkSearchSeq: 0,
  followBrowseData: null,
  followBrowseSelectedUid: "",
  followBrowseLoading: false,
  followBrowseSeq: 0,
  followBrowseQuery: "",
  followBrowseRenderSignature: "",
  favlistBrowseData: null,
  favlistBrowseSelectedFolderId: "",
  favlistBrowseLoading: false,
  favlistBrowseSeq: 0,
  favlistBrowseQuery: "",
  favlistBrowseRenderSignature: "",
  favlistBrowseReloadTimer: null,
  d1BrowseKind: "",
  d1BrowseLevel: "alphabet",
  d1BrowseLetter: "",
  d1BrowseTag: "",
  d1BrowseLocale: "",
  d1BrowseQuery: "",
  d1BrowseData: null,
  d1BrowseLoading: false,
  d1BrowseSeq: 0,
  d1BrowseError: "",
  d1BrowseModes: {
    name: {
      level: "alphabet", letter: "", tag: "", locale: "", query: "", data: null,
      tagData: null, itemData: null, loading: false, seq: 0, error: "",
      scrollPositions: { alphabet: 0, tags: 0, items: 0 },
    },
    artist: {
      level: "alphabet", letter: "", tag: "", locale: "", query: "", data: null,
      tagData: null, itemData: null, loading: false, seq: 0, error: "",
      scrollPositions: { alphabet: 0, tags: 0, items: 0 },
    },
  },
  categoryBrowseLevel: "home",
  categoryBrowseSelectedId: "",
  categoryBrowseQuery: "",
  categoryBrowseItems: [],
  categoryBrowseOffset: 0,
  categoryBrowseHasMore: false,
  categoryBrowseLoading: false,
  categoryBrowseSeq: 0,
  categoryBrowseError: "",
  categoryBrowseLoaded: false,
  categoryBrowseScrollPositions: { home: 0, detail: 0 },
  pendingReviewItems: [],
  pendingReviewTotal: 0,
  pendingReviewExportCount: 0,
  pendingReviewLoaded: false,
  pendingReviewLoading: false,
  pendingReviewApproving: false,
  pendingReviewSeq: 0,
  pendingReviewMessage: "",
  pendingReviewError: "",
  blacklistItems: [],
  blacklistTotal: 0,
  blacklistOffset: 0,
  blacklistLimit: 20,
  blacklistHasMore: false,
  blacklistQuery: "",
  blacklistLoaded: false,
  blacklistLoading: false,
  blacklistSeq: 0,
  blacklistMessage: "",
  blacklistError: "",
  maintenanceJobRunning: "",
  maintenanceJobMessage: "",
  maintenanceJobError: "",
  gatchaUidSaving: false,
  gatchaRefreshSaving: false,
  gatchaFavlistSaving: false,
  bbdownLoginRequesting: false,
  updateAutomaticEnabled: true,
  updateAutomaticAttemptedChannels: new Set(),
  startupUpdateCheckScheduled: false,
  updateCheckRequestInFlight: false,
  manualUpdateCheck: null,
  updateManualVisibleChannel: "",
  updatePreviewEnabled: false,
  ratingPromptElement: null,
  ratingPromptItem: null,
  ratingPromptItems: null,
  ratingPromptActiveTab: "current",
  ratingPromptItemId: "",
  ratingPromptBvid: "",
  ratingPromptScore: 5,
  ratingPromptSubmitted: false,
  ratingPromptSeenPlayIds: new Set(),
  ratingSubmittedKeys: new Set(),
  ratingOptOut: false,
  appToastTimer: null,
  fullscreenRequestToastTimer: null,
  fullscreenRequestToastHideTimer: null,
  presentationSession: {
    mode: "singleScreen",
    phase: "inactive",
    generation: 0,
    selectedOutputDisplayId: "",
    controllerDisplayId: "",
    hostReady: true,
    controllerReady: false,
    lastAcceptedCommandSequence: 0,
    lastAppliedCommandSequence: 0,
    playbackAuthority: "host",
    mediaRendererOwner: "host",
    recoveryReason: "",
  },
  presentationDisplayInfo: null,
  presentationDisplayError: "",
  presentationSelectedDisplayId: "",
  presentationSelectionInitialized: false,
  presentationControlBusy: false,
  presentationDisplayBusy: false,
  presentationOutputRenderSignature: "",
  presentationSceneKey: "",
  presentationSceneRevision: 0,
  presentationPlaybackRevision: 0,
  presentationPlaybackPublishSignature: "",
  presentationPlaybackPublishPromise: null,
  presentationCommandApplyPromise: Promise.resolve(),
  presentationLastAppliedCommandSequence: 0,
  presentationAppliedComposition: "combined",
  presentationCompositionGeneration: 0,
  presentationHostReadyKey: "",
  presentationListenersReady: false,
  presentationUnlisteners: [],
  presentationCursorHideTimer: null,
  activeHostWorkspace: "queue",
  focusedHostWorkspace: "queue",
  hostWorkspaceOverlayOpen: false,
  hostNarrowToolSheetActive: false,
  hostWorkspaceScrollPositions: {
    queue: 0,
    request: 0,
    random: 0,
    users: 0,
  },
  language: "zh",
  translations: {},
  translationsLoaded: false,
  theme: "light",
};

function legacyPlaybackStartStateForSession(session = state.hostPlaybackSession) {
  const phase = String(session?.phase || "");
  if (phase === "starting") {
    return "starting";
  }
  if (phase === "playing" || phase === "paused") {
    return "established";
  }
  if (phase === "needs-user-gesture") {
    return "needs-user-gesture";
  }
  if (phase === "failed") {
    return "startup-failed";
  }
  if (
    phase === "requested"
    || phase === "binding"
    || phase === "ready-paused"
    || phase === "start-retry-wait"
  ) {
    return "pending";
  }
  return "idle";
}

function setHostPlaybackSessionPhase(session, phase) {
  if (!session) {
    return false;
  }
  session.phase = phase;
  return true;
}

Object.defineProperty(state, "localPlaybackStartState", {
  configurable: false,
  enumerable: true,
  get() {
    return legacyPlaybackStartStateForSession();
  },
});

const elements = {
  appShell: document.getElementById("app-shell"),
  topbar: document.querySelector(".topbar"),
  hostContentRegion: document.querySelector(".host-content-region"),
  leftColumn: document.querySelector(".left-column"),
  hostWorkspaceRegion: document.getElementById("host-workspace-region"),
  hostWorkspaceButtons: document.querySelectorAll("[data-host-workspace]"),
  hostWorkspacePanels: document.querySelectorAll("[data-host-workspace-panel]"),
  hostWorkspaceBackdrop: document.getElementById("host-workspace-backdrop"),
  developerModeTrigger: document.getElementById("developer-mode-trigger"),
  serviceStatusIndicator: document.getElementById("service-status-indicator"),
  playbackModeSummary: document.getElementById("playback-mode-summary"),
  playbackModeCurrent: document.getElementById("playback-mode-current"),
  cacheChipMeta: document.getElementById("cache-chip-meta"),
  cacheSettings: document.getElementById("cache-settings"),
  cacheSettingsToggle: document.getElementById("cache-settings-toggle"),
  cachePanel: document.getElementById("cache-panel"),
  cacheAdvancedInlineView: document.getElementById("cache-advanced-inline-view"),
  cachePanelAdvancedTrigger: document.getElementById("cache-panel-advanced-trigger"),
  cacheUsageDetail: document.getElementById("cache-usage-detail"),
  cachePanelVersion: document.getElementById("cache-panel-version"),
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
  cacheDownloadSourceSelect: document.getElementById("cache-download-source-select"),
  cacheHiresCheckbox: document.getElementById("cache-hires-checkbox"),
  resetOffsetCheckbox: document.getElementById("reset-offset-checkbox"),
  dataResetButton: document.getElementById("data-reset-button"),
  currentCacheRetryButton: document.getElementById("current-cache-retry-button"),
  playerResetButton: document.getElementById("player-reset-button"),
  updatePreviewCheckbox: document.getElementById("update-preview-checkbox"),
  updateAutomaticCheckbox: document.getElementById("update-automatic-checkbox"),
  updateCheckButton: document.getElementById("update-check-button"),
  serviceUpdateIndicator: document.getElementById("service-update-indicator"),
  advancedUpdateIndicator: document.getElementById("advanced-update-indicator"),
  appUpdateRow: document.getElementById("app-update-row"),
  appUpdateStatus: document.getElementById("app-update-status"),
  updateVersionBadge: document.getElementById("update-version-badge"),
  applicationRestartRow: document.getElementById("application-restart-row"),
  applicationRestartButton: document.getElementById("application-restart-button"),
  diagnosticCopyButton: document.getElementById("diagnostic-copy-button"),
  diagnosticPackageButton: document.getElementById("diagnostic-package-button"),
  currentTitle: document.getElementById("current-title"),
  playerPanel: document.querySelector(".player-panel"),
  playerFrame: document.getElementById("player-frame"),
  playerFullscreenButton: document.getElementById("player-fullscreen-button"),
  stageControlsToggle: document.getElementById("stage-controls-toggle"),
  stageControlsClose: document.getElementById("stage-controls-close"),
  stageControlBackdrop: document.getElementById("stage-control-backdrop"),
  stageControlTray: document.getElementById("stage-control-tray"),
  stageExtendedControls: document.getElementById("stage-extended-controls"),
  fullscreenRequestToast: document.getElementById("fullscreen-request-toast"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  avSyncPanel: document.getElementById("av-sync-panel"),
  avOffsetInput: document.getElementById("av-offset-input"),
  avOffsetResetButton: document.getElementById("av-offset-reset-button"),
  avDelayLockButton: document.getElementById("av-delay-lock-button"),
  volumePanel: document.getElementById("volume-panel"),
  volumeMuteButton: document.getElementById("volume-mute-button"),
  volumeSlider: document.getElementById("volume-slider"),
  volumeValue: document.getElementById("volume-value"),
  keyShiftPanel: document.getElementById("key-shift-panel"),
  keyShiftInput: document.getElementById("key-shift-input"),
  keyShiftDecButton: document.getElementById("key-shift-dec-button"),
  keyShiftIncButton: document.getElementById("key-shift-inc-button"),
  keyShiftResetButton: document.getElementById("key-shift-reset-button"),
  addForm: document.getElementById("add-form"),
  requesterSelect: document.getElementById("requester-select"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  appToast: document.getElementById("app-toast"),
  sessionUserForm: document.getElementById("session-user-form"),
  sessionUserInput: document.getElementById("session-user-input"),
  sessionUsersPanel: document.getElementById("session-users-panel"),
  sessionUserList: document.getElementById("session-user-list"),
  sessionUserTrash: document.getElementById("session-user-trash"),
  backupBanner: document.getElementById("backup-banner"),
  backupTitle: document.getElementById("backup-title"),
  backupText: document.getElementById("backup-text"),
  backupActionButton: document.getElementById("backup-action-button"),
  dismissBackupButton: document.getElementById("dismiss-backup-button"),
  listTag: document.getElementById("list-tag"),
  listTitle: document.getElementById("list-title"),
  playlist: document.getElementById("playlist"),
  historyList: document.getElementById("history-list"),
  queueCount: document.getElementById("queue-count"),
  historyCount: document.getElementById("history-count"),
  queueCurrent: document.getElementById("queue-current"),
  queueCurrentProgressBadge: document.getElementById("queue-current-progress-badge"),
  queueCurrentIconWrap: document.getElementById("queue-current-icon-wrap"),
  queueCurrentTag: document.getElementById("queue-current-tag"),
  queueCurrentTitle: document.getElementById("queue-current-title"),
  queueCurrentRequester: document.getElementById("queue-current-requester"),
  queueCurrentCacheDetail: document.getElementById("queue-current-cache-detail"),
  queueCurrentRetry: document.getElementById("queue-current-retry"),
  listStage: document.getElementById("list-stage"),
  modeSwitch: document.getElementById("mode-switch"),
  displaySettings: document.getElementById("display-settings"),
  displaySettingsToggle: document.getElementById("display-settings-toggle"),
  displaySettingsPanel: document.getElementById("display-settings-panel"),
  presentationSettings: document.getElementById("presentation-settings"),
  presentationSettingsToggle: document.getElementById("presentation-settings-toggle"),
  presentationSettingsPanel: document.getElementById("presentation-settings-panel"),
  presentationOutputButton: document.getElementById("presentation-output-button"),
  presentationOutputStatus: document.getElementById("presentation-output-status"),
  presentationOutputSummary: document.getElementById("presentation-output-summary"),
  presentationOutputMeta: document.getElementById("presentation-output-meta"),
  presentationStateDot: document.getElementById("presentation-state-dot"),
  presentationDisplayList: document.getElementById("presentation-display-list"),
  presentationRefreshButton: document.getElementById("presentation-refresh-button"),
  languageSwitch: document.getElementById("language-switch"),
  themeSwitch: document.getElementById("theme-switch"),
  nextButton: document.getElementById("next-button"),
  queueNextButton: document.getElementById("queue-next-button"),
  resortPlaylistButton: document.getElementById("resort-playlist-button"),
  clearPlaylistButton: document.getElementById("clear-playlist-button"),
  historyExportButton: document.getElementById("history-export-button"),
  clearHistoryButton: document.getElementById("clear-history-button"),
  playlistTemplate: document.getElementById("playlist-item-template"),
  historyTemplate: document.getElementById("history-item-template"),
  confirmPopover: document.getElementById("confirm-popover"),
  confirmText: document.getElementById("confirm-text"),
  confirmSource: document.getElementById("confirm-source"),
  confirmPageSize: document.getElementById("confirm-page-size"),
  confirmPageSizeNote: document.getElementById("confirm-page-size-note"),
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
  gatchaFavlistModal: document.getElementById("gatcha-favlist-modal"),
  gatchaFavlistModalBackdrop: document.getElementById("gatcha-favlist-modal-backdrop"),
  gatchaFavlistModalText: document.getElementById("gatcha-favlist-modal-text"),
  gatchaFavlistOptions: document.getElementById("gatcha-favlist-options"),
  gatchaFavlistModalClose: document.getElementById("gatcha-favlist-modal-close"),
  gatchaFavlistModalCancel: document.getElementById("gatcha-favlist-modal-cancel"),
  gatchaFavlistModalConfirm: document.getElementById("gatcha-favlist-modal-confirm"),
  poolConfigModal: document.getElementById("gatcha-pool-config-modal"),
  poolConfigModalBackdrop: document.getElementById("gatcha-pool-config-modal-backdrop"),
  poolConfigModalClose: document.getElementById("gatcha-pool-config-modal-close"),
  poolConfigModalCancel: document.getElementById("gatcha-pool-config-modal-cancel"),
  poolConfigModalReset: document.getElementById("gatcha-pool-config-modal-reset"),
  poolConfigModalSave: document.getElementById("gatcha-pool-config-modal-save"),
  poolConfigSourceList: document.getElementById("gatcha-pool-source-list"),
  poolConfigWeightSlider: document.getElementById("gatcha-pool-weight-slider"),
  poolConfigWeightLabel: document.getElementById("gatcha-pool-weight-label"),
  poolConfigUidOptions: document.getElementById("gatcha-pool-uid-options"),
  poolConfigFavlistOptions: document.getElementById("gatcha-pool-favlist-options"),
  poolConfigUidSelectAll: document.getElementById("gatcha-pool-uid-select-all"),
  poolConfigUidSelectNone: document.getElementById("gatcha-pool-uid-select-none"),
  poolConfigFavlistSelectAll: document.getElementById("gatcha-pool-favlist-select-all"),
  poolConfigFavlistSelectNone: document.getElementById("gatcha-pool-favlist-select-none"),
  poolConfigMessage: document.getElementById("gatcha-pool-config-message"),
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
  windowDragRegion: document.getElementById("window-drag-region"),
  windowControls: document.getElementById("window-controls"),
  windowMinimize: document.getElementById("window-minimize"),
  windowMaximize: document.getElementById("window-maximize"),
  windowClose: document.getElementById("window-close"),
  remoteMiniControl: document.getElementById("remote-mini-control"),
  remoteMiniTrigger: document.getElementById("remote-mini-trigger"),
  remoteMiniPopover: document.getElementById("remote-mini-popover"),
  remoteMiniPopoverClose: document.getElementById("remote-mini-popover-close"),
  requestWorkspace: document.getElementById("host-workspace-request"),
  requestSubviewButtons: document.querySelectorAll("[data-request-view]"),
  requestSubviewPanels: document.querySelectorAll("[data-request-panel]"),
  searchModeButtons: document.querySelectorAll("[data-search-mode]"),
  searchModePanels: document.querySelectorAll("[data-search-panel]"),
  searchModeContract: document.getElementById("search-mode-contract"),
  discoverModeButtons: document.querySelectorAll("[data-discover-mode]"),
  discoverModePanels: document.querySelectorAll("[data-discover-panel]"),
  discoverCategoriesPanel: document.getElementById("request-discover-categories"),
  discoverNamePanel: document.getElementById("request-discover-name"),
  discoverArtistPanel: document.getElementById("request-discover-artist"),
  catalogAdvancedMenu: document.getElementById("catalog-advanced-menu"),
  catalogAdvancedView: document.getElementById("catalog-advanced-view"),
  catalogAdvancedContent: document.getElementById("catalog-advanced-content"),
  catalogAdvancedBack: document.getElementById("catalog-advanced-back"),
  catalogToolButtons: document.querySelectorAll("[data-catalog-tool]"),
  sourcesModeButtons: document.querySelectorAll("[data-sources-mode]"),
  sourcesModePanels: document.querySelectorAll("[data-sources-panel]"),
  sourcesUidScroll: document.getElementById("request-sources-uids-scroll"),
  sourcesFavoritesScroll: document.getElementById("request-sources-favorites-scroll"),
  openAddedUidsButton: document.getElementById("open-added-uids-button"),
  openFavoritesButton: document.getElementById("open-favorites-button"),
  favlistBrowserView: document.getElementById("favlist-browser-view"),
  bilikaraSecretModal: document.getElementById("bilikara-secret-modal"),
  bilikaraSecretBackdrop: document.getElementById("bilikara-secret-backdrop"),
  bilikaraSecretClose: document.getElementById("bilikara-secret-close"),
  bilikaraSecretCancel: document.getElementById("bilikara-secret-cancel"),
  bilikaraSecretForm: document.getElementById("bilikara-secret-form"),
  bilikaraSecretInput: document.getElementById("bilikara-secret-input"),
  bilikaraSecretConfirm: document.getElementById("bilikara-secret-confirm"),
  bilikaraSecretMessage: document.getElementById("bilikara-secret-message"),
  developerTagResetModal: document.getElementById("developer-tag-reset-modal"),
  developerTagResetBackdrop: document.getElementById("developer-tag-reset-backdrop"),
  developerTagResetClose: document.getElementById("developer-tag-reset-close"),
  developerTagResetCancel: document.getElementById("developer-tag-reset-cancel"),
  developerTagResetConfirm: document.getElementById("developer-tag-reset-confirm"),
  developerTagResetDeleteMid: document.getElementById("developer-tag-reset-delete-mid"),
  developerTagResetTitle: document.getElementById("developer-tag-reset-title"),
  developerTagResetText: document.getElementById("developer-tag-reset-text"),
  developerTagResetFields: document.getElementById("developer-tag-reset-fields"),
  developerTagResetNote: document.getElementById("developer-tag-reset-note"),
  gatchaPanel: document.getElementById("gatcha-panel"),
  gatchaTag: document.getElementById("gatcha-tag"),
  gatchaTitle: document.getElementById("gatcha-title"),
  gatchaStage: document.getElementById("gatcha-stage"),
  gatchaButton: document.getElementById("gatcha-button"),
  gatchaPoolConfigToggle: document.getElementById("gatcha-pool-config-toggle"),
  manageSourcesButton: document.getElementById("manage-sources-button"),
  gatchaMainView: document.getElementById("gatcha-main-view"),
  gatchaConfirmButton: document.getElementById("gatcha-confirm-button"),
  gatchaRetryButton: document.getElementById("gatcha-retry-button"),
  gatchaMessage: document.getElementById("gatcha-message"),
  gatchaInitView: document.getElementById("gatcha-init-view"),
  gatchaDrawingView: document.getElementById("gatcha-drawing-view"),
  gatchaResultView: document.getElementById("gatcha-result-view"),
  gatchaErrorView: document.getElementById("gatcha-error-view"),
  gatchaStateViews: document.querySelectorAll("[data-gatcha-view]"),
  gatchaCandidateTitle: document.getElementById("gatcha-candidate-title"),
  searchForm: document.getElementById("search-form"),
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchMessage: document.getElementById("search-message"),
  searchResults: document.getElementById("search-results"),
  followUpListView: document.getElementById("follow-up-list-view"),
  modalFollowUidForm: document.getElementById("modal-follow-uid-form"),
  modalFollowUidInput: document.getElementById("modal-follow-uid-input"),
  modalAddFollowUidButton: document.getElementById("modal-add-follow-uid-button"),
  followUpGrid: document.getElementById("follow-up-grid"),
  followUpItemsView: document.getElementById("follow-up-items-view"),
  followBrowseBack: document.getElementById("follow-browse-back"),
  followBrowseAvatar: document.getElementById("follow-browse-avatar"),
  followBrowseTitle: document.getElementById("follow-browse-title"),
  followBrowseCount: document.getElementById("follow-browse-count"),
  followSearchForm: document.getElementById("follow-search-form"),
  followSearchQuery: document.getElementById("follow-search-query"),
  followSearchButton: document.getElementById("follow-search-button"),
  followSongResults: document.getElementById("follow-song-results"),
  followBrowseMessage: document.getElementById("follow-browse-message"),
  favlistListView: document.getElementById("favlist-list-view"),
  modalFavlistPullForm: document.getElementById("modal-favlist-pull-form"),
  modalFavlistUidInput: document.getElementById("modal-favlist-uid-input"),
  modalPullFavlistButton: document.getElementById("modal-pull-favlist-button"),
  favlistGrid: document.getElementById("favlist-grid"),
  favlistItemsView: document.getElementById("favlist-items-view"),
  favlistBrowseBack: document.getElementById("favlist-browse-back"),
  favlistBrowseAvatar: document.getElementById("favlist-browse-avatar"),
  favlistBrowseTitle: document.getElementById("favlist-browse-title"),
  favlistBrowseCount: document.getElementById("favlist-browse-count"),
  favlistSearchForm: document.getElementById("favlist-search-form"),
  favlistSearchQuery: document.getElementById("favlist-search-query"),
  favlistSearchButton: document.getElementById("favlist-search-button"),
  favlistSongResults: document.getElementById("favlist-song-results"),
  favlistBrowseMessage: document.getElementById("favlist-browse-message"),
  larkSearchForm: document.getElementById("lark-search-form"),
  larkSearchQuery: document.getElementById("lark-search-query"),
  larkSearchButton: document.getElementById("lark-search-button"),
  larkSearchMessage: document.getElementById("lark-search-message"),
  larkSearchResults: document.getElementById("lark-search-results"),
  refreshGatchaCacheButton: document.getElementById("refresh-gatcha-cache-button"),
  gatchaUidMessage: document.getElementById("gatcha-uid-message"),
};

const historyExportGuard = window.BilikaraExportGuard.createExportGuard([
  elements.confirmOk,
  elements.confirmSecondary,
]);

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

function setMessageForSource(source, message, isError = false) {
  if (source === "search") {
    setSearchMessage(message, isError);
    return;
  }
  if (source === "lark") {
    setLarkSearchMessage(message, isError);
    return;
  }
  if (source === "modalFollow") {
    setFollowBrowseMessage(message, isError);
    return;
  }
  if (source === "modalFavlist") {
    setFavlistBrowseMessage(message, isError);
    return;
  }
  if (source === "modalBrowse") {
    const msgElements = elements.requestWorkspace?.querySelectorAll(".tag-browser-message");
    if (msgElements && msgElements.length > 0) {
      msgElements.forEach((el) => {
        el.textContent = message || "";
        el.classList.toggle("is-error", Boolean(isError));
      });
    }
    return;
  }
  if (source === "gatcha") {
    setGatchaMessage(message, isError);
    return;
  }
  // Default fallback (e.g. "history" or others)
  setFormMessage(message, isError);
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
  if (!toast || !normalizedTitle || !isAudiencePlayerSurface()) {
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
  label.textContent = t("toast.incomingRequest");
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
  if (!previousData || !nextData || !isAudiencePlayerSurface()) {
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
  showFullscreenRequestToast(item.display_title || item.title || t("toast.incomingRequest"));
}

function requesterBadgeText(requesterName) {
  const normalized = String(requesterName || "").trim();
  return normalized ? t("request.requesterBadge", { name: normalized }) : "";
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

function normalizeLanguage(value) {
  return ["zh", "en", "ja"].includes(value) ? value : "zh";
}

function t(key, values = {}) {
  const normalizedKey = String(key || "");
  const active = state.translations?.[state.language] || {};
  const fallback = state.translations?.zh || {};
  let text = active[normalizedKey] || fallback[normalizedKey] || normalizedKey;
  Object.entries(values || {}).forEach(([name, value]) => {
    text = text.split(`{${name}}`).join(String(value ?? ""));
  });
  return text;
}

function htmlT(key, values = {}) {
  return escapeHtml(t(key, values));
}

function activeLocale() {
  if (state.language === "ja") {
    return "ja-JP";
  }
  if (state.language === "en") {
    return "en-US";
  }
  return "zh-CN";
}

function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    setTextContent(node, t(node.dataset.i18n));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((node) => {
    setElementTitle(node, t(node.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    setElementAttribute(node, "aria-label", t(node.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-alt]").forEach((node) => {
    setElementAttribute(node, "alt", t(node.dataset.i18nAlt));
  });
  document.title = t("document.title");
  document.documentElement.lang = state.language === "ja" ? "ja" : state.language === "en" ? "en" : "zh-CN";
}

function renderLanguageSwitch() {
  elements.languageSwitch?.querySelectorAll("button[data-language]").forEach((button) => {
    button.classList.toggle("active", button.dataset.language === state.language);
  });
}

function invalidateLanguageSensitiveRenderCache() {
  state.lastPollRenderSignature = "";
  state.requesterSelectRenderSignature = "";
  state.sessionUsersRenderSignature = "";
  state.playerFullscreenButtonRenderSignature = "";
  state.followBrowseRenderSignature = "";
  state.favlistBrowseRenderSignature = "";
  state.gatchaUidFaceRenderSignature = "";
  state.gatchaTaskLastMessageSignature = "";
  state.currentTitleRenderSignature = "";
  state.remoteAccessRenderSignature = "";
  state.listHeaderRenderSignature = "";
  state.cacheSettingsRenderSignature = "";
  state.bbdownLoginRenderSignature = "";
  state.cachePolicyControlRenderSignature = "";
  state.queueCurrentRenderSignature = "";
  state.playlistEmptyRenderSignature = "";
  state.historyRenderSignature = "";
  state.audioVariantBarRenderSignature = "";
  state.volumeControlsRenderSignature = "";
  state.playedSessionsLoaded = false;
}

function setLanguage(language) {
  const nextLanguage = normalizeLanguage(language);
  if (state.language === nextLanguage) {
    renderLanguageSwitch();
    return;
  }
  state.language = nextLanguage;
  writeLocalPreference(storageKeys.language, nextLanguage);
  invalidateLanguageSensitiveRenderCache();
  applyStaticI18n();
  renderLanguageSwitch();
  render();
  if (state.catalogAdvancedTool === "maintenance") {
    renderMaintenanceView();
  }
}

function applyTheme(theme) {
  const nextTheme = normalizeTheme(theme);
  state.theme = nextTheme;
  document.documentElement.setAttribute("data-theme", nextTheme);
  writeLocalPreference(storageKeys.theme, nextTheme);
  renderThemeSwitch();
}

function normalizeTheme(theme) {
  return theme === "dark" || theme === "blue" ? theme : "light";
}

function renderThemeSwitch() {
  elements.themeSwitch?.querySelectorAll("button[data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === state.theme);
  });
}

async function loadTranslations() {
  state.language = normalizeLanguage(readLocalString(storageKeys.language, state.language));
  try {
    const response = await fetch("/i18n.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    state.translations = payload?.languages || {};
  } catch {
    state.translations = {
      zh: {
        "top.language": "语言",
        "top.mobileRemote": "手机点歌",
        "remote.qrLoading": "正在生成二维码...",
        "player.empty": "把 Bilibili 视频链接加入点歌列表后，这里会开始播放。",
        "player.startPlayback": "开始播放",
        "player.waitingToStart": "音视频准备中…",
        "backup.previousSessionTag": "上一场",
        "backup.previousSessionDetected": "检测到上一场记录，共 {count} 首。",
        "backup.continuePreviousSession": "继续上一场",
        "backup.previousSessionContinued": "已继续上一场。",
        "backup.previousSessionUnavailable": "上一场记录已不可用。",
        "gatcha.adding": "处理中",
      },
    };
  }
  state.translationsLoaded = true;
  applyStaticI18n();
  renderLanguageSwitch();
}

function closeOpenMenus({ restoreFocus = false } = {}) {
  const trigger = state.openRowMenuTrigger;
  let closed = false;
  document.querySelectorAll(".menu-content").forEach((menu) => {
    if (!menu.classList.contains("hidden")) {
      closed = true;
    }
    menu.classList.add("hidden");
    menu.closest(".song-actions-wrap, .history-actions-wrap")
      ?.querySelector('[data-action="toggle-menu"]')
      ?.setAttribute("aria-expanded", "false");
  });
  state.openRowMenuTrigger = null;
  if (
    restoreFocus
    && trigger?.isConnected
    && !trigger.closest("[hidden], [inert]")
  ) {
    trigger.focus({ preventScroll: true });
  }
  return closed;
}

function selectedRequesterName() {
  return String(elements.requesterSelect?.value || "").trim();
}

function hasSessionUsers() {
  return Array.isArray(state.data?.session_users) && state.data.session_users.length > 0;
}

function validatedRequesterNameForAdd(showMessage = setFormMessage) {
  if (!hasSessionUsers()) {
    showMessage(t("session.requireUsers"), true);
    return "";
  }
  const requesterName = selectedRequesterName();
  if (!requesterName) {
    showMessage(t("session.requireRequester"), true);
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

function isWebKitPlaybackRuntime() {
  if (typeof navigator === "undefined" || !navigator.userAgent) {
    return false;
  }
  const ua = navigator.userAgent;
  const hasWebKit = /AppleWebKit/i.test(ua);
  const hasChromium = /Chrome|Chromium|Edg/i.test(ua);
  return hasWebKit && !hasChromium;
}

function isTauriWebKitRuntime() {
  return Boolean(window.__TAURI__) && isWebKitPlaybackRuntime();
}

function clearWebKitAudioStarvationTimer(session = state.hostPlaybackSession) {
  if (!session?.audioStarvationTimer) {
    return;
  }
  window.clearTimeout(session.audioStarvationTimer);
  session.audioStarvationTimer = null;
}

function isPlayerPanelFullscreen() {
  return fullscreenElement() === elements.playerPanel
    || Boolean(elements.playerPanel?.classList.contains("is-tauri-fullscreen"));
}

function isAudiencePlayerSurface() {
  return isPlayerPanelFullscreen() || presentationCompositionActive();
}

function isPlayerPanelFullscreenForTransition() {
  return isPlayerPanelFullscreen() || smokeTestBypassPlayerFullscreen;
}

function supportsPlayerFullscreen() {
  if (isTauriWebKitRuntime()) {
    return Boolean(elements.playerPanel);
  }
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
  return state.presentationSession.phase === "inactive"
    && supportsPlayerFullscreen()
    && (Boolean(state.data?.current_item) || isPlayerPanelFullscreen());
}

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || null;
}

function syncApplicationRestartAvailability() {
  const available = typeof tauriInvoke() === "function";
  elements.applicationRestartRow?.classList.toggle("hidden", !available);
  elements.applicationRestartRow?.setAttribute("aria-hidden", available ? "false" : "true");
  if (elements.applicationRestartButton) {
    elements.applicationRestartButton.disabled = !available || state.applicationRestartInFlight;
    if (state.applicationRestartInFlight) {
      elements.applicationRestartButton.setAttribute("aria-busy", "true");
    } else {
      elements.applicationRestartButton.removeAttribute("aria-busy");
    }
  }
  return available;
}

async function restartApplication() {
  const invoke = tauriInvoke();
  if (typeof invoke !== "function") {
    throw new Error(t("service.restartApplicationFailed"));
  }
  if (state.applicationRestartInFlight) {
    return false;
  }
  state.applicationRestartInFlight = true;
  syncApplicationRestartAvailability();
  try {
    await invoke("restart_application");
    return true;
  } catch {
    state.applicationRestartInFlight = false;
    syncApplicationRestartAvailability();
    throw new Error(t("service.restartApplicationFailed"));
  }
}

function isTauriCommandNotFoundError(error) {
  const msg = (
    typeof error === "string"
      ? error
      : error && typeof error.message === "string"
        ? error.message
        : ""
  ).toLowerCase();

  if (!msg.includes("save_backend_download")) {
    return false;
  }

  const patterns = [
    /command\s+['"]?save_backend_download['"]?\s+not\s+found/,
    /unknown\s+command\s+['"]?save_backend_download['"]?/,
  ];
  return patterns.some((re) => re.test(msg));
}

async function saveTauriBackendDownload(path, body = null, fallback = t("history.exportFailed"), extraContext = {}) {
  if (!window.__TAURI__) {
    return null;
  }
  const invoke = tauriInvoke();
  const exportDownload = window.BilikaraExportDownload;
  if (typeof invoke !== "function") {
    return null;
  }
  const startTime = Date.now();
  const surface = extraContext.surface || "host";
  let parsedFormat = extraContext.format || null;
  let parsedSource = extraContext.source || null;
  let parsedPageSize = extraContext.pageSize || null;
  if (path && typeof path === "string" && path.includes("?")) {
    try {
      const dummyUrl = new URL(path, "http://bilikara.invalid");
      if (!parsedFormat && dummyUrl.searchParams.has("format")) {
        parsedFormat = dummyUrl.searchParams.get("format");
      }
      if (!parsedSource && dummyUrl.searchParams.has("source")) {
        parsedSource = dummyUrl.searchParams.get("source");
      }
      if (!parsedPageSize && dummyUrl.searchParams.has("page_size")) {
        parsedPageSize = Number(dummyUrl.searchParams.get("page_size")) || null;
      }
    } catch {
      // Ignore URL parsing errors.
    }
  }

  let result;
  try {
    result = await invoke("save_backend_download", {
      request: {
        path,
        body,
        clientId: state.clientId,
      },
    });
  } catch (error) {
    const isNotFound = exportDownload?.isTauriCommandNotFoundError
      ? exportDownload.isTauriCommandNotFoundError(error)
      : isTauriCommandNotFoundError(error);
    if (isNotFound) {
      return null;
    }
    const errMessage = exportDownload
      ? exportDownload.normalizedErrorMessage(error, fallback)
      : String(error || fallback);
    if (exportDownload?.recordExportDiagnostic) {
      exportDownload.recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "tauri",
        format: parsedFormat,
        source: parsedSource,
        pageSize: parsedPageSize,
        stage: "invoke",
        status: "failed",
        errorCode: "INVOKE_REJECTED",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
    }
    throw new Error(errMessage);
  }

  const isValidResult = exportDownload?.isValidNativeDownloadResult
    ? exportDownload.isValidNativeDownloadResult(result)
    : false;

  if (!isValidResult) {
    const errMessage = exportDownload
      ? exportDownload.normalizedErrorMessage(null, fallback)
      : String(fallback || "");
    if (exportDownload?.recordExportDiagnostic) {
      exportDownload.recordExportDiagnostic({
        timestamp: new Date().toISOString(),
        surface,
        runtime: "tauri",
        format: parsedFormat,
        source: parsedSource,
        pageSize: parsedPageSize,
        stage: "validate_native_result",
        status: "failed",
        errorCode: "MALFORMED_NATIVE_RESULT",
        errorMessage: errMessage,
        elapsedMs: Date.now() - startTime,
      });
    }
    throw new Error(errMessage);
  }

  if (exportDownload?.recordExportDiagnostic) {
    exportDownload.recordExportDiagnostic({
      timestamp: new Date().toISOString(),
      surface,
      runtime: "tauri",
      format: result.format || parsedFormat,
      source: result.source || parsedSource,
      pageSize: result.pageSize || parsedPageSize,
      stage: result.stage || null,
      status: result.status || null,
      httpStatus: result.httpStatus || null,
      contentType: result.contentType || null,
      bytes: result.bytes || null,
      filenameExtension: result.filenameExtension || null,
      elapsedMs: typeof result.elapsedMs === "number" ? result.elapsedMs : (Date.now() - startTime),
      stageTimings: result.stageTimings || null,
      errorCode: result.errorCode || null,
      errorMessage: result.errorMessage || null,
    });
  }

  if (!exportDownload || typeof exportDownload.nativeDownloadStatus !== "function") {
    throw new Error(exportDownload ? exportDownload.normalizedErrorMessage(null, fallback) : fallback);
  }

  return exportDownload.nativeDownloadStatus(result, fallback);
}

async function setTauriWindowFullscreen(enabled) {
  const fullscreen = Boolean(enabled);
  const invoke = tauriInvoke();
  if (typeof invoke !== "function") {
    return false;
  }
  try {
    await invoke("set_window_fullscreen", { fullscreen });
    return true;
  } catch {
    return false;
  }
}

function presentationSceneApi() {
  return window.BilikaraPresentationScene || null;
}

function presentationRendererApi() {
  return window.BilikaraPresentationRenderer || null;
}

function presentationOverlayModel() {
  const playlist = Array.isArray(state.data?.playlist) ? state.data.playlist : [];
  const primaryItem = state.localAdvanceOverlayPrimaryItem || playlist[0] || null;
  const followItems = Array.isArray(state.localAdvanceOverlayFollowItems)
    ? state.localAdvanceOverlayFollowItems
    : playlist.slice(1);
  const visible = state.localAdvanceDelayDeadline > 0;
  const totalCount = Number.isFinite(state.localAdvanceOverlayTotalCount)
    ? Number(state.localAdvanceOverlayTotalCount)
    : (state.data?.current_item ? 1 : 0) + playlist.length;
  const visibleRows = followItems.slice(0, localAdvanceOverlayMaxRows);
  const remainingCount = Math.max(0, followItems.length - visibleRows.length);
  return {
    visible,
    heading: t("player.upNext"),
    countdownLabel: t("player.advanceCountdown"),
    deadline: Number(state.localAdvanceDelayDeadline || 0),
    durationMs: Number(state.localAdvanceOverlayDurationMs || 0),
    title: delayOverlayTitleForItem(primaryItem, t("player.prepareNext")),
    requester: primaryItem?.requester_name || "—",
    duration: formatDurationSeconds(durationSecondsForItem(primaryItem)),
    queueHeading: t("player.followingQueue"),
    rows: visibleRows.map((item) => ({
      title: delayOverlayTitleForItem(item),
      requester: item?.requester_name || "—",
      duration: formatDurationSeconds(durationSecondsForItem(item)),
    })),
    emptyText: visibleRows.length ? "" : t("player.followingQueueEmpty"),
    remainingText: remainingCount > 0 ? t("player.remainingQueue", { count: remainingCount }) : "",
    totalText: t("player.totalSongs", { count: totalCount }),
  };
}

function currentPresentationScene() {
  const currentItem = state.data?.current_item || null;
  const sceneKey = JSON.stringify({
    generation: state.presentationSession.generation,
    item: currentItem?.id || "",
    title: currentItem?.display_title || currentItem?.title || "",
    theme: state.theme,
  });
  if (sceneKey !== state.presentationSceneKey) {
    state.presentationSceneKey = sceneKey;
    state.presentationSceneRevision += 1;
  }
  const candidate = {
    generation: state.presentationSession.generation,
    revision: state.presentationSceneRevision,
    currentItemIdentity: String(currentItem?.id || ""),
    title: String(currentItem?.display_title || currentItem?.title || ""),
    displayMetadata: {
      requester: String(currentItem?.requester_name || ""),
      duration: formatDurationSeconds(durationSecondsForItem(currentItem)),
      detail: String(currentItem?.owner_name || ""),
    },
    theme: state.theme,
    overlay: presentationOverlayModel(),
  };
  return presentationSceneApi()?.normalizePresentationScene(candidate) || candidate;
}

function renderCurrentPresentationScene() {
  const renderer = presentationRendererApi();
  if (!renderer || !elements.playerFrame) {
    return;
  }
  renderer.renderScene(elements.playerFrame, currentPresentationScene(), {
    compact: !(isPlayerPanelFullscreen() || presentationCompositionActive()),
    manageVisibility: false,
    now: Date.now(),
  });
}

const presentationModes = new Set(["singleScreen", "localDualScreen"]);
const presentationPhases = new Set(["inactive", "activating", "active", "recovering"]);

function normalizePresentationSession(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const mode = String(candidate.mode || "");
  const phase = String(candidate.phase || "");
  const generation = Number(candidate.generation);
  const lastAcceptedCommandSequence = Number(candidate.lastAcceptedCommandSequence || 0);
  const lastAppliedCommandSequence = Number(candidate.lastAppliedCommandSequence || 0);
  if (
    !presentationModes.has(mode)
    || !presentationPhases.has(phase)
    || !Number.isSafeInteger(generation)
    || generation < 0
    || !Number.isSafeInteger(lastAcceptedCommandSequence)
    || lastAcceptedCommandSequence < 0
    || !Number.isSafeInteger(lastAppliedCommandSequence)
    || lastAppliedCommandSequence < 0
    || lastAppliedCommandSequence > lastAcceptedCommandSequence
    || candidate.playbackAuthority !== "host"
    || candidate.mediaRendererOwner !== "host"
  ) {
    return null;
  }
  return {
    mode,
    phase,
    generation,
    selectedOutputDisplayId: String(candidate.selectedOutputDisplayId || ""),
    controllerDisplayId: String(candidate.controllerDisplayId || ""),
    hostReady: Boolean(candidate.hostReady),
    controllerReady: Boolean(candidate.controllerReady),
    lastAcceptedCommandSequence,
    lastAppliedCommandSequence,
    playbackAuthority: "host",
    mediaRendererOwner: "host",
    recoveryReason: String(candidate.recoveryReason || ""),
  };
}

function presentationPhaseRank(session) {
  if (session.phase === "inactive") return 4;
  if (session.phase === "recovering") return 3;
  if (session.phase === "active") return 2;
  if (session.phase === "activating") return 1;
  return 0;
}

function presentationCompositionActive(session = state.presentationSession) {
  return state.presentationAppliedComposition === "stageOnly"
    && session.mode === "localDualScreen"
    && (session.phase === "activating" || session.phase === "active");
}

function clearPresentationCursorTimer() {
  if (state.presentationCursorHideTimer) {
    window.clearTimeout(state.presentationCursorHideTimer);
    state.presentationCursorHideTimer = null;
  }
}

function revealPresentationCursor() {
  document.body?.classList.remove("is-presentation-cursor-hidden");
  clearPresentationCursorTimer();
  if (!presentationCompositionActive()) {
    return;
  }
  state.presentationCursorHideTimer = window.setTimeout(() => {
    state.presentationCursorHideTimer = null;
    if (presentationCompositionActive()) {
      document.body?.classList.add("is-presentation-cursor-hidden");
    }
  }, 1800);
}

function handlePresentationPointerMove() {
  if (presentationCompositionActive()) {
    revealPresentationCursor();
  }
}

function applyPresentationCompositionDom(generation, composition) {
  if (
    !Number.isSafeInteger(generation)
    || generation !== state.presentationSession.generation
    || !["combined", "stageOnly"].includes(composition)
  ) {
    return false;
  }
  const active = composition === "stageOnly"
    && state.presentationSession.mode === "localDualScreen"
    && ["activating", "active"].includes(state.presentationSession.phase);
  state.presentationAppliedComposition = active ? "stageOnly" : "combined";
  state.presentationCompositionGeneration = generation;
  document.body?.classList.toggle("is-presentation-stage-only", active);
  if (elements.playerFrame) {
    elements.playerFrame.inert = active;
  }
  if (active) {
    hideMountedPlayerControls();
    revealPresentationCursor();
  } else {
    clearPresentationCursorTimer();
    document.body?.classList.remove("is-presentation-cursor-hidden");
  }
  renderCurrentPresentationScene();
  renderPlayerFullscreenButton();
  return true;
}

function presentationAnimationFrame() {
  if (typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function applyPresentationComposition(candidate) {
  const generation = Number(candidate?.generation);
  const composition = String(candidate?.composition || "");
  if (!applyPresentationCompositionDom(generation, composition)) {
    return false;
  }
  const session = state.presentationSession;
  const shouldAcknowledge = (
    composition === "stageOnly"
    && session.phase === "activating"
    && !session.hostReady
  ) || (
    composition === "combined"
    && session.phase === "recovering"
    && !session.hostReady
  );
  const readyKey = `${generation}:${composition}`;
  if (!shouldAcknowledge || state.presentationHostReadyKey === readyKey) {
    return true;
  }
  state.presentationHostReadyKey = readyKey;
  await presentationAnimationFrame();
  const invoke = tauriInvoke();
  if (typeof invoke !== "function") {
    return false;
  }
  try {
    await handlePresentationSession(await invoke("mark_presentation_host_ready", {
      generation,
      composition,
    }));
  } catch (error) {
    state.presentationHostReadyKey = "";
    setAppMessage(t("display.presentationReadyFailed", {
      message: error?.message || String(error),
    }), true);
    return false;
  }
  return true;
}

function applyPresentationSession(candidate) {
  const session = normalizePresentationSession(candidate);
  if (!session) {
    return null;
  }
  const current = state.presentationSession;
  if (
    session.generation < current.generation
    || (
      session.generation === current.generation
      && presentationPhaseRank(session) < presentationPhaseRank(current)
    )
  ) {
    return null;
  }
  if (session.generation !== current.generation) {
    state.presentationLastAppliedCommandSequence = 0;
    state.presentationPlaybackRevision = 0;
    state.presentationPlaybackPublishSignature = "";
    state.presentationHostReadyKey = "";
  }
  state.presentationSession = session;
  state.presentationLastAppliedCommandSequence = Math.max(
    state.presentationLastAppliedCommandSequence,
    session.lastAppliedCommandSequence,
  );
  if (session.selectedOutputDisplayId) {
    state.presentationSelectedDisplayId = session.selectedOutputDisplayId;
  }
  renderPresentationOutputControl();
  return session;
}

function normalizePresentationDisplayInfo(candidate) {
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.displays)) {
    return null;
  }
  const displays = candidate.displays.flatMap((display) => {
    if (!display || typeof display !== "object") {
      return [];
    }
    const id = String(display.id || "").trim();
    if (!id || id.length > 1024) {
      return [];
    }
    return [{
      id,
      name: String(display.name || ""),
      positionX: Number(display.positionX || 0),
      positionY: Number(display.positionY || 0),
      width: Math.max(0, Number(display.width || 0)),
      height: Math.max(0, Number(display.height || 0)),
      scaleFactor: Math.max(0, Number(display.scaleFactor || 0)),
      controller: Boolean(display.controller),
      primary: Boolean(display.primary),
      selectable: Boolean(display.selectable),
      mirrored: Boolean(display.mirrored),
      identityStable: Boolean(display.identityStable),
      identityQuality: display.identityQuality === "stable" ? "stable" : "unstable",
    }];
  });
  return {
    monitorCount: Math.max(displays.length, Number(candidate.monitorCount || 0)),
    displays,
    controllerDisplayId: String(candidate.controllerDisplayId || ""),
    recommendedDisplayId: String(candidate.recommendedDisplayId || ""),
  };
}

function applyPresentationDisplayInfo(candidate) {
  const info = normalizePresentationDisplayInfo(candidate);
  if (!info) {
    return null;
  }
  state.presentationDisplayInfo = info;
  state.presentationDisplayError = "";
  if (state.presentationSession.phase === "inactive" && !state.presentationSelectionInitialized) {
    state.presentationSelectionInitialized = true;
    if (info.displays.some(
      (display) => display.id === info.recommendedDisplayId && display.selectable,
    )) {
      state.presentationSelectedDisplayId = info.recommendedDisplayId;
    }
  }
  if (
    state.presentationSession.phase === "inactive"
    && state.presentationSelectedDisplayId
    && !info.displays.some(
      (display) => display.id === state.presentationSelectedDisplayId && display.selectable,
    )
  ) {
    state.presentationSelectedDisplayId = "";
  }
  renderPresentationOutputControl();
  return info;
}

async function refreshPresentationDisplays({ announceError = false } = {}) {
  const invoke = tauriInvoke();
  if (typeof invoke !== "function" || state.presentationDisplayBusy) {
    return null;
  }
  state.presentationDisplayBusy = true;
  renderPresentationOutputControl();
  try {
    return applyPresentationDisplayInfo(await invoke("get_presentation_displays"));
  } catch (error) {
    state.presentationDisplayError = error?.message || String(error);
    if (announceError) {
      setAppMessage(t("display.presentationDiscoveryFailed", {
        message: state.presentationDisplayError,
      }), true);
    }
    return null;
  } finally {
    state.presentationDisplayBusy = false;
    renderPresentationOutputControl();
  }
}

function presentationDisplayById(displayId) {
  return state.presentationDisplayInfo?.displays?.find(
    (display) => display.id === displayId,
  ) || null;
}

const presentationDeviceIconShapes = Object.freeze({
  controller: [
    ["rect", { x: "5", y: "2.5", width: "14", height: "19", rx: "2" }],
    ["path", { d: "M9 18.5h6" }],
  ],
  monitor: [
    ["rect", { x: "2.5", y: "3.5", width: "19", height: "14", rx: "2" }],
    ["path", { d: "M8 21h8M12 17.5V21" }],
  ],
});

function createPresentationDeviceIcon(iconType) {
  const iconElement = document.createElement("span");
  iconElement.className = "presentation-device-icon";
  iconElement.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const shapes = presentationDeviceIconShapes[iconType] || presentationDeviceIconShapes.monitor;
  for (const [tagName, attributes] of shapes) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  iconElement.append(svg);
  return iconElement;
}

function createPresentationDisplayOption(display) {
  const selected = display.id === state.presentationSelectedDisplayId;
  const sessionActive = state.presentationSession.phase !== "inactive";
  const active = display.id === state.presentationSession.selectedOutputDisplayId
    && state.presentationSession.phase === "active";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `presentation-display-option${selected ? " is-selected" : ""}`;
  button.dataset.presentationDisplayId = display.id;
  button.disabled = state.presentationControlBusy
    || state.presentationDisplayBusy
    || sessionActive
    || !display.selectable;
  button.setAttribute("aria-pressed", String(selected));

  const copy = document.createElement("span");
  copy.className = "presentation-display-copy";
  const name = document.createElement("span");
  name.className = "presentation-display-name";
  name.textContent = display.name || t("display.unnamedDisplay", { number: 1 });
  const detail = document.createElement("span");
  detail.className = "presentation-display-detail";
  const resolution = display.width && display.height
    ? `${display.width} × ${display.height}`
    : t("display.resolutionUnknown");
  detail.textContent = display.mirrored
    ? `${resolution} · ${t("display.presentationMirrored")}`
    : display.identityStable && display.identityQuality === "stable"
      ? resolution
      : `${resolution} · ${t("display.presentationIdentityUnavailable")}`;
  copy.append(name, detail);
  const status = document.createElement("span");
  status.className = "presentation-display-state";
  status.textContent = active
    ? t("display.displaying")
    : selected
      ? t("display.selected")
      : display.controller
        ? t("display.controllerDisplay")
        : "";
  button.append(
    createPresentationDeviceIcon(display.controller ? "controller" : "monitor"),
    copy,
    status,
  );
  return button;
}

function renderPresentationDisplayList() {
  const list = elements.presentationDisplayList;
  if (!list) {
    return;
  }
  const displays = state.presentationDisplayInfo?.displays || [];
  const fragment = document.createDocumentFragment();
  for (const display of displays) {
    fragment.append(createPresentationDisplayOption(display));
  }
  if (!displays.some((display) => display.selectable)) {
    const empty = document.createElement("p");
    empty.className = "presentation-display-empty";
    empty.textContent = state.presentationDisplayError
      ? t("display.presentationUnavailable")
      : t("display.presentationNoExternalDisplay");
    fragment.append(empty);
  }
  if (state.presentationDisplayBusy) {
    list.setAttribute("aria-busy", "true");
  } else {
    list.removeAttribute("aria-busy");
  }
  list.replaceChildren(fragment);
}

function renderPresentationOutputControl() {
  const settings = elements.presentationSettings;
  const button = elements.presentationOutputButton;
  const status = elements.presentationOutputStatus;
  if (!settings || !button || !status) {
    return;
  }
  const nativeAvailable = typeof tauriInvoke() === "function";
  settings.classList.toggle("hidden", false);
  if (!nativeAvailable) {
    button.disabled = true;
    button.removeAttribute("aria-busy");
    setElementAttribute(button, "aria-label", t("display.presentationUnavailable"));
    setTextContent(status, t("display.presentationUnavailable"));
    setTextContent(elements.presentationOutputSummary, t("display.outputOff"));
    setTextContent(elements.presentationOutputMeta, t("display.presentationUnavailable"));
    return;
  }
  const session = state.presentationSession;
  const selectedId = session.selectedOutputDisplayId || state.presentationSelectedDisplayId;
  const selected = presentationDisplayById(selectedId);
  const monitorName = selected?.name || t("display.secondaryDisplay");
  const hasSelectableDisplay = Boolean(
    state.presentationDisplayInfo?.displays?.some((display) => display.selectable),
  );
  const noExternalDisplayAvailable = (
    session.phase === "inactive"
      && !state.presentationDisplayBusy
      && !state.presentationDisplayError
      && Boolean(state.presentationDisplayInfo)
      && !hasSelectableDisplay
  );
  const statusText = state.presentationControlBusy
    ? t("display.presentationTransitioning")
    : session.phase === "active"
      ? t("display.presentationActive", { monitor: monitorName })
      : session.phase === "activating"
        ? t("display.presentationActivating", { monitor: monitorName })
        : session.phase === "recovering"
          ? t("display.presentationRecovering")
          : noExternalDisplayAvailable
            ? t("display.presentationNoExternalDisplay")
            : state.presentationSelectedDisplayId
              ? t("display.presentationTargetSelected", { monitor: monitorName })
              : t("display.presentationSelectDisplay");
  const summaryText = state.presentationControlBusy
    ? t("display.presentationTransitioning")
    : session.phase === "active"
      ? t("display.dualOutputOn")
      : session.phase === "inactive"
        ? t("display.outputOff")
        : t("display.presentationTransitioning");
  const metaText = state.presentationDisplayBusy
    ? t("display.detectingDisplays")
    : state.presentationDisplayError
      ? t("display.presentationUnavailable")
      : state.presentationDisplayInfo
        ? t("display.displayCount", { count: state.presentationDisplayInfo.monitorCount })
        : t("display.detectingDisplays");
  const canActivate = session.phase === "inactive"
    && Boolean(presentationDisplayById(state.presentationSelectedDisplayId)?.selectable);
  const canDeactivate = session.phase === "active" || session.phase === "activating";
  const disabled = state.presentationControlBusy
    || state.presentationDisplayBusy
    || !(canActivate || canDeactivate);
  const signature = JSON.stringify({
    session,
    selectedId: state.presentationSelectedDisplayId,
    displayInfo: state.presentationDisplayInfo,
    displayError: state.presentationDisplayError,
    displayBusy: state.presentationDisplayBusy,
    controlBusy: state.presentationControlBusy,
    language: state.language,
  });
  if (signature === state.presentationOutputRenderSignature) {
    return;
  }
  state.presentationOutputRenderSignature = signature;
  setTextContent(status, statusText);
  setTextContent(elements.presentationOutputSummary, summaryText);
  setTextContent(elements.presentationOutputMeta, metaText);
  button.disabled = disabled;
  setElementAttribute(button, "aria-checked", String(session.phase !== "inactive"));
  setElementAttribute(
    button,
    "aria-label",
    canDeactivate ? t("display.stopPresentation") : t("display.startPresentation"),
  );
  if (state.presentationControlBusy) {
    setElementAttribute(button, "aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
  setClassToggle(settings, "is-active", session.phase === "active");
  setClassToggle(elements.presentationStateDot, "is-active", session.phase === "active");
  setClassToggle(
    elements.presentationStateDot,
    "is-connecting",
    session.phase === "activating" || session.phase === "recovering",
  );
  setClassToggle(elements.presentationRefreshButton, "is-loading", state.presentationDisplayBusy);
  if (elements.presentationRefreshButton) {
    elements.presentationRefreshButton.disabled = state.presentationDisplayBusy
      || state.presentationControlBusy
      || session.phase !== "inactive";
    if (state.presentationDisplayBusy) {
      elements.presentationRefreshButton.setAttribute("aria-busy", "true");
    } else {
      elements.presentationRefreshButton.removeAttribute("aria-busy");
    }
  }
  renderPresentationDisplayList();
}

async function handlePresentationSession(candidate) {
  const session = applyPresentationSession(candidate);
  if (!session) {
    return null;
  }
  await applyPresentationComposition({
    generation: session.generation,
    composition: ["activating", "active"].includes(session.phase)
      ? "stageOnly"
      : "combined",
  });
  if (session.phase === "active") {
    publishPresentationPlaybackState().catch(() => {});
  } else if (
    session.phase === "inactive"
    && session.recoveryReason === "displayDisconnected"
  ) {
    state.presentationSelectedDisplayId = "";
    setAppMessage(t("display.presentationDisconnected"), true);
    await refreshPresentationDisplays();
  }
  return session;
}

async function activateLocalPresentation() {
  const invoke = tauriInvoke();
  const displayId = state.presentationSelectedDisplayId;
  const selected = presentationDisplayById(displayId);
  if (typeof invoke !== "function" || !selected?.selectable) {
    throw new Error(t("display.presentationSelectDisplay"));
  }
  await handlePresentationSession(await invoke("activate_local_presentation", { displayId }));
}

async function deactivateLocalPresentation() {
  const invoke = tauriInvoke();
  if (typeof invoke !== "function") {
    throw new Error(t("display.presentationUnavailable"));
  }
  await handlePresentationSession(await invoke("deactivate_local_presentation", {
    generation: state.presentationSession.generation,
  }));
}

async function toggleLocalPresentation() {
  if (state.presentationControlBusy || state.presentationDisplayBusy) {
    return;
  }
  state.presentationControlBusy = true;
  renderPresentationOutputControl();
  try {
    if (state.presentationSession.phase === "inactive") {
      await activateLocalPresentation();
    } else {
      await deactivateLocalPresentation();
    }
  } catch (error) {
    setAppMessage(t("display.presentationTransitionFailed", {
      message: error?.message || String(error),
    }), true);
  } finally {
    state.presentationControlBusy = false;
    renderPresentationOutputControl();
  }
}

function selectPresentationDisplay(displayId) {
  if (
    state.presentationControlBusy
    || state.presentationDisplayBusy
    || state.presentationSession.phase !== "inactive"
  ) {
    return;
  }
  const target = presentationDisplayById(String(displayId || ""));
  if (!target?.selectable) {
    return;
  }
  state.presentationSelectedDisplayId = target.id;
  renderPresentationOutputControl();
  const replacement = Array.from(
    elements.presentationDisplayList?.querySelectorAll("[data-presentation-display-id]") || [],
  ).find((option) => option.dataset.presentationDisplayId === target.id);
  replacement?.focus();
}

function normalizeControllerCommandEnvelope(candidate) {
  if (!candidate || typeof candidate !== "object" || candidate.target !== "host") {
    return null;
  }
  const generation = Number(candidate.generation);
  const sequence = Number(candidate.sequence);
  const command = candidate.command;
  if (
    !Number.isSafeInteger(generation)
    || generation < 0
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || !command
    || typeof command !== "object"
  ) {
    return null;
  }
  return { generation, sequence, command };
}

function validControllerSeekTarget(value) {
  return Number.isFinite(value) && value >= 0 && value <= 7 * 24 * 60 * 60;
}

function seekHostPlayer(video, audio, targetTime) {
  if (!video || !validControllerSeekTarget(targetTime)) {
    return Promise.reject(new Error("Invalid Controller seek target"));
  }
  if (!audio || !isActiveSplitPlayer(video, audio)) {
    return Promise.reject(new Error("The Host player is not ready for seeking"));
  }
  const playbackSession = state.hostPlaybackSession;
  if (!playbackSession.readyCommitted) {
    const error = new Error("The Host playback session is not ready for seeking");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const rejectCancelledSeek = () => {
      const retired = !isCurrentHostPlaybackSession(playbackSession, video, audio);
      const error = new Error(
        retired
          ? "The Host playback session retired before seeking completed"
          : "The Host seek was cancelled before completion",
      );
      if (retired) {
        error.name = "AbortError";
      }
      reject(error);
    };
    const started = beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek: state.localShouldBePlaying,
      targetTime,
      diagnosticAction: "presentation-controller-seek",
      onSettled: (applied) => {
        if (!applied) {
          rejectCancelledSeek();
          return;
        }
        reportPlayerStatus(
          video.dataset.playerItemId || "",
          video,
          playbackSession,
        );
        resolve(true);
      },
    });
    if (!started) {
      rejectCancelledSeek();
    }
  });
}

async function acknowledgeControllerCommand(generation, sequence) {
  const invoke = tauriInvoke();
  if (typeof invoke !== "function") {
    throw new Error("Tauri presentation commands are unavailable");
  }
  await handlePresentationSession(await invoke("acknowledge_presentation_command", {
    generation,
    sequence,
  }));
  state.presentationLastAppliedCommandSequence = sequence;
}

async function applyControllerCommand(candidate) {
  const envelope = normalizeControllerCommandEnvelope(candidate);
  const session = state.presentationSession;
  if (
    !envelope
    || session.phase !== "active"
    || session.playbackAuthority !== "host"
    || envelope.generation !== session.generation
    || envelope.sequence !== state.presentationLastAppliedCommandSequence + 1
    || envelope.sequence > session.lastAcceptedCommandSequence
  ) {
    return false;
  }
  const programRelativeCommand = ["seekRelative", "seekAbsolute", "nextTrack"].includes(
    envelope.command.type,
  );
  if (programRelativeCommand) {
    const expectedPlaybackGeneration = Number(
      envelope.command.expectedPlaybackGeneration,
    );
    if (
      !Number.isSafeInteger(expectedPlaybackGeneration)
      || expectedPlaybackGeneration < 1
    ) {
      throw new Error("Invalid Controller playback target");
    }
    const playbackSession = state.hostPlaybackSession;
    if (
      expectedPlaybackGeneration !== state.data?.playback_generation
      || playbackSession?.playbackGeneration !== expectedPlaybackGeneration
      || !isCurrentHostPlaybackSession(playbackSession)
    ) {
      await acknowledgeControllerCommand(envelope.generation, envelope.sequence);
      return false;
    }
  }
  const { video, audio } = activeLocalPlayerElements();
  let cancelledByPlaybackProgramChange = false;
  try {
    switch (envelope.command.type) {
      case "play":
        if (!video || !audio || !setSplitPlaybackIntent(video, audio, true, {
          source: "presentation-controller-play",
        })) {
          throw new Error("The Host player is not ready to play");
        }
        break;
      case "pause":
        if (!video || !audio || !setSplitPlaybackIntent(video, audio, false, {
          source: "presentation-controller-pause",
        })) {
          throw new Error("The Host player is not ready to pause");
        }
        break;
      case "seekRelative": {
        const deltaSeconds = Number(envelope.command.deltaSeconds);
        if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0 || Math.abs(deltaSeconds) > 600) {
          throw new Error("Invalid Controller relative seek command");
        }
        const targetTime = Math.max(0, Number(video?.currentTime || 0) + deltaSeconds);
        await seekHostPlayer(video, audio, targetTime);
        break;
      }
      case "seekAbsolute": {
        const targetSeconds = Number(envelope.command.targetSeconds);
        if (!validControllerSeekTarget(targetSeconds)) {
          throw new Error("Invalid Controller absolute seek command");
        }
        await seekHostPlayer(video, audio, targetSeconds);
        break;
      }
      case "nextTrack": {
        const expectedPlaybackGeneration = envelope.command.expectedPlaybackGeneration;
        const advanced = await requestNextTrack(expectedPlaybackGeneration);
        if (!advanced) {
          if (
            state.data?.playback_generation === expectedPlaybackGeneration
            && state.hostPlaybackSession?.playbackGeneration === expectedPlaybackGeneration
            && isCurrentHostPlaybackSession(state.hostPlaybackSession)
          ) {
            throw new Error("The Host could not advance to the next track");
          }
          cancelledByPlaybackProgramChange = true;
        }
        break;
      }
      case "setVolume": {
        const volumePercent = Number(envelope.command.volumePercent);
        if (
          !Number.isInteger(volumePercent)
          || volumePercent < 0
          || volumePercent > 100
          || typeof envelope.command.muted !== "boolean"
        ) {
          throw new Error("Invalid Controller volume command");
        }
        await setLocalPlayerVolumeAndMuted(volumePercent / 100, envelope.command.muted, {
          reportError: false,
        });
        break;
      }
      default:
        throw new Error("Unsupported Controller command");
    }
  } catch (error) {
    if (
      error?.name !== "AbortError"
      || (envelope.command.type !== "seekRelative" && envelope.command.type !== "seekAbsolute")
    ) {
      throw error;
    }
    cancelledByPlaybackProgramChange = true;
  }
  await acknowledgeControllerCommand(envelope.generation, envelope.sequence);
  if (cancelledByPlaybackProgramChange) {
    return false;
  }
  publishPresentationPlaybackState().catch((error) => {
    setAppMessage(error?.message || String(error), true);
  });
  return true;
}

function hostPlaybackSessionObservedPlaying(
  session = state.hostPlaybackSession,
  video = session?.video,
  audio = session?.audio,
) {
  return Boolean(
    session
    && session === state.hostPlaybackSession
    && session.readyCommitted
    && session.phase === "playing"
    && session.video === video
    && session.audio === audio
    && isActiveSplitPlayer(video, audio)
    && !video.paused
    && !audio.paused
  );
}

function presentationPlaybackStateModel(session = state.hostPlaybackSession) {
  const currentItem = state.data?.current_item || null;
  const { video, audio } = activeLocalPlayerElements();
  const media = video || activePrimaryVideoElement();
  const duration = Number(media?.duration);
  const currentTime = Number(media?.currentTime);
  const volumeSource = audio || media;
  return {
    playbackGeneration: session?.playbackGeneration ?? null,
    itemIdentity: currentItem?.id ? String(currentItem.id) : null,
    title: String(currentItem?.display_title || currentItem?.title || t("player.noSong")),
    paused: audio
      ? !hostPlaybackSessionObservedPlaying(session, video, audio)
      : !media || Boolean(media.paused),
    currentTimeSeconds: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : null,
    volumePercent: Math.round(
      Math.max(0, Math.min(1, Number(volumeSource?.volume ?? state.localPlayerVolume))) * 100,
    ),
    muted: Boolean(volumeSource?.muted ?? state.localPlayerMuted),
    canSkip: Boolean(currentItem) && !state.localAdvanceInFlight,
  };
}

function publishPresentationPlaybackState(session = state.hostPlaybackSession) {
  const invoke = tauriInvoke();
  const capturedVideo = session?.video;
  const capturedAudio = session?.audio;
  if (
    typeof invoke !== "function"
    || !["activating", "active"].includes(state.presentationSession.phase)
    || (session && !session.readyCommitted)
    || (
      session
      && !isCurrentHostPlaybackSession(session, capturedVideo, capturedAudio)
    )
  ) {
    return Promise.resolve(null);
  }
  const playbackState = presentationPlaybackStateModel(session);
  const signature = JSON.stringify({
    generation: state.presentationSession.generation,
    playbackGeneration: session?.playbackGeneration ?? null,
    playbackProgram: session?.playbackProgram ?? null,
    playbackState,
  });
  if (signature === state.presentationPlaybackPublishSignature) {
    return state.presentationPlaybackPublishPromise || Promise.resolve(null);
  }
  state.presentationPlaybackPublishSignature = signature;
  playbackState.revision = ++state.presentationPlaybackRevision;
  const generation = state.presentationSession.generation;
  const previous = state.presentationPlaybackPublishPromise || Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(() => {
      if (
        state.presentationSession.generation !== generation
        || (
          session
            ? !isCurrentHostPlaybackSession(session, capturedVideo, capturedAudio)
            : state.hostPlaybackSession !== session
        )
      ) {
        return null;
      }
      return invoke("publish_presentation_playback_state", {
        generation,
        playbackState,
      });
    })
    .catch((error) => {
      if (
        state.presentationSession.generation === generation
        && state.presentationPlaybackPublishSignature === signature
        && (
          session
            ? isCurrentHostPlaybackSession(session, capturedVideo, capturedAudio)
            : state.hostPlaybackSession === session
        )
      ) {
        state.presentationPlaybackPublishSignature = "";
      }
      throw error;
    });
  const tracked = pending.finally(() => {
    if (state.presentationPlaybackPublishPromise === tracked) {
      state.presentationPlaybackPublishPromise = null;
    }
  });
  state.presentationPlaybackPublishPromise = tracked;
  return tracked;
}

function tauriEventListen() {
  return window.__TAURI__?.event?.listen || null;
}

function teardownLocalPresentationListeners() {
  state.presentationUnlisteners.splice(0).forEach((unlisten) => {
    try {
      unlisten();
    } catch {
      // The native listener may already have been released with the WebView.
    }
  });
  state.presentationListenersReady = false;
  document.removeEventListener("pointermove", handlePresentationPointerMove);
  clearPresentationCursorTimer();
}

async function initializeLocalPresentation() {
  const invoke = tauriInvoke();
  const listen = tauriEventListen();
  if (typeof invoke !== "function" || typeof listen !== "function") {
    renderPresentationOutputControl();
    return;
  }
  if (state.presentationListenersReady) {
    return;
  }
  state.presentationListenersReady = true;
  document.addEventListener("pointermove", handlePresentationPointerMove);
  try {
    const unlistenSession = await listen("bilikara-presentation-state", (event) => {
      handlePresentationSession(event?.payload?.session).catch((error) => {
        setAppMessage(error?.message || String(error), true);
      });
    });
    const unlistenComposition = await listen(
      "bilikara-presentation-host-composition",
      (event) => {
        applyPresentationComposition(event?.payload).catch((error) => {
          setAppMessage(error?.message || String(error), true);
        });
      },
    );
    const unlistenCommand = await listen("bilikara-presentation-host-command", (event) => {
      const commandGeneration = Number(event?.payload?.generation);
      const pending = state.presentationCommandApplyPromise
        .catch(() => {})
        .then(() => applyControllerCommand(event?.payload));
      state.presentationCommandApplyPromise = pending;
      pending.catch(async (error) => {
        setAppMessage(error?.message || String(error), true);
        if (
          !Number.isSafeInteger(commandGeneration)
          || state.presentationSession.phase !== "active"
          || state.presentationSession.generation !== commandGeneration
        ) {
          return;
        }
        try {
          await handlePresentationSession(await invoke("deactivate_local_presentation", {
            generation: commandGeneration,
          }));
        } catch (recoveryError) {
          setAppMessage(recoveryError?.message || String(recoveryError), true);
        }
      });
    });
    state.presentationUnlisteners.push(
      unlistenSession,
      unlistenComposition,
      unlistenCommand,
    );
    await handlePresentationSession(await invoke("get_presentation_session"));
    await refreshPresentationDisplays();
  } catch (error) {
    teardownLocalPresentationListeners();
    state.presentationDisplayError = error?.message || String(error);
    renderPresentationOutputControl();
  }
}

function renderPlayerFullscreenButton() {
  const button = elements.playerFullscreenButton;
  if (!button) {
    return;
  }
  const active = isPlayerPanelFullscreen();
  const enabled = canTogglePlayerFullscreen();
  const label = active ? t("player.fullscreenExit") : t("player.fullscreen");
  const title = enabled
    ? (active ? t("player.fullscreenExitLabel") : t("player.fullscreenEnterLabel"))
    : supportsPlayerFullscreen()
      ? t("player.fullscreenDisabled")
      : t("player.fullscreenUnsupported");
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
  if (!canTogglePlayerFullscreen()) {
    return;
  }
  if (isPlayerPanelFullscreen()) {
    const exitFullscreenPromise = exitDocumentFullscreen();
    const tauriFullscreenPromise = setTauriWindowFullscreen(false);
    elements.playerPanel?.classList.remove("is-tauri-fullscreen");
    document.body?.classList.remove("is-tauri-fullscreen-active");
    await exitFullscreenPromise;
    await tauriFullscreenPromise;
    renderPlayerFullscreenButton();
    return;
  }
  if (!state.data?.current_item) {
    return;
  }
  const activeFullscreen = fullscreenElement();
  if (activeFullscreen && activeFullscreen !== elements.playerPanel) {
    await exitDocumentFullscreen();
    await setTauriWindowFullscreen(false);
    elements.playerPanel?.classList.remove("is-tauri-fullscreen");
    document.body?.classList.remove("is-tauri-fullscreen-active");
  }
  const elementFullscreenPromise = requestElementFullscreen(elements.playerPanel);
  const tauriFullscreenPromise = setTauriWindowFullscreen(true);
  const elementFullscreenStarted = await elementFullscreenPromise;
  const tauriFullscreenStarted = await tauriFullscreenPromise;
  if (!elementFullscreenStarted) {
    if (isTauriWebKitRuntime() && tauriFullscreenStarted) {
      elements.playerPanel?.classList.add("is-tauri-fullscreen");
      document.body?.classList.add("is-tauri-fullscreen-active");
    } else if (tauriFullscreenStarted) {
      await setTauriWindowFullscreen(false);
    }
  }
  renderPlayerFullscreenButton();
}

function clearPlayerFrameClickTimer(session = state.hostPlaybackSession) {
  if (!session?.frameClickTimer) {
    return;
  }
  window.clearTimeout(session.frameClickTimer);
  session.frameClickTimer = null;
}

function clearLocalPlayerControlsHideTimer() {
  state.localPlayerControlsHideGeneration = (state.localPlayerControlsHideGeneration || 0) + 1;
  if (state.localPlayerControlsHideTimer === null) {
    return;
  }
  window.clearTimeout(state.localPlayerControlsHideTimer);
  state.localPlayerControlsHideTimer = null;
}

function mountedLocalVideoElement() {
  const session = state.hostPlaybackSession;
  return isCurrentHostPlaybackSession(session, session?.video, session?.audio)
    ? session.video
    : null;
}

function hidePlayerControls(video) {
  if (!video) {
    return;
  }
  video.controls = false;
  video.removeAttribute("controls");
}

function hideMountedPlayerControls() {
  clearLocalPlayerControlsHideTimer();
  hidePlayerControls(mountedLocalVideoElement());
}

function scheduleMountedPlayerControlsHide() {
  clearLocalPlayerControlsHideTimer();
  const video = mountedLocalVideoElement();
  if (!video || !video.controls) {
    return;
  }
  const hideGeneration = state.localPlayerControlsHideGeneration;
  const hideTimer = window.setTimeout(() => {
    if (
      state.localPlayerControlsHideTimer !== hideTimer
      || state.localPlayerControlsHideGeneration !== hideGeneration
      || mountedLocalVideoElement() !== video
    ) {
      return;
    }
    state.localPlayerControlsHideTimer = null;
    hidePlayerControls(video);
  }, playerControlsAutoHideMs);
  state.localPlayerControlsHideTimer = hideTimer;
}

function revealMountedPlayerControlsForUserInteraction() {
  if (presentationCompositionActive()) {
    hideMountedPlayerControls();
    return;
  }
  const video = mountedLocalVideoElement();
  if (!video) {
    return;
  }
  const { video: splitVideo, audio } = activeLocalPlayerElements();
  if (
    audio
    && splitVideo === video
    && (
      state.localPlaybackStartState === "pending"
      || state.localPlaybackStartState === "starting"
    )
  ) {
    hideMountedPlayerControls();
    return;
  }
  video.controls = true;
  video.setAttribute("controls", "");
  scheduleMountedPlayerControlsHide();
}

function toggleMountedLocalPlayback() {
  if (presentationCompositionActive()) {
    return true;
  }
  if (frontendPlaybackMode(state.data?.playback_mode) !== "local" || !state.data?.current_item) {
    return false;
  }
  if (isLocalAdvanceHoldingItem(state.data.current_item.id)) {
    return true;
  }
  const video = activePrimaryVideoElement();
  if (!video) {
    return false;
  }
  const { audio } = activeLocalPlayerElements();
  if (audio) {
    if (
      requestSplitPlaybackStartFromUserGesture(
        video,
        audio,
        "player-toggle-start-intent",
      )
    ) {
      return true;
    }
    setSplitPlaybackIntent(video, audio, !state.localShouldBePlaying, {
      source: "player-toggle-intent",
      userGesture: true,
    });
    return true;
  }
  if (video.paused) {
    state.localShouldBePlaying = true;
    if (audio) {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
    } else {
      video.play().catch(() => {});
    }
  } else {
    state.localShouldBePlaying = false;
    video.pause();
  }
  return true;
}

function queuePlayerFrameSingleClick() {
  const session = state.hostPlaybackSession;
  const video = session?.video;
  const audio = session?.audio;
  if (!isCurrentHostPlaybackSession(session, video, audio)) {
    return false;
  }
  clearPlayerFrameClickTimer(session);
  let clickTimer = null;
  clickTimer = window.setTimeout(() => {
    if (session.frameClickTimer !== clickTimer) {
      return;
    }
    session.frameClickTimer = null;
    if (!isCurrentHostPlaybackSession(session, video, audio)) {
      return;
    }
    toggleMountedLocalPlayback();
  }, playerClickDelayMs);
  session.frameClickTimer = clickTimer;
  return true;
}

async function handlePlayerFrameDoubleClick() {
  clearPlayerFrameClickTimer();
  if (!canTogglePlayerFullscreen()) {
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
  state.updateAutomaticEnabled = readLocalBoolean(
    storageKeys.updateAutomatic,
    state.updateAutomaticEnabled,
  );
  state.updatePreviewEnabled = readLocalBoolean(storageKeys.updatePreview, state.updatePreviewEnabled);

  // Hydrate and apply theme
  state.theme = normalizeTheme(readLocalString(storageKeys.theme, state.theme));
  applyTheme(state.theme);
}

function normalizeRequestSubview(value, fallback = "search") {
  const candidate = String(value || "").trim().toLowerCase();
  return ["quick", "search", "discover", "sources"].includes(candidate)
    ? candidate
    : fallback;
}

function normalizeSearchMode(value, fallback = "shared") {
  const candidate = String(value || "").trim().toLowerCase();
  return ["shared", "local"].includes(candidate) ? candidate : fallback;
}

function normalizeDiscoverMode(value, fallback = "categories") {
  const candidate = String(value || "").trim().toLowerCase();
  return ["categories", "name", "artist"].includes(candidate) ? candidate : fallback;
}

function normalizeSourcesMode(value, fallback = "uids") {
  const candidate = String(value || "").trim().toLowerCase();
  return ["uids", "favorites"].includes(candidate) ? candidate : fallback;
}

function setRequestPanelVisibility(panel, visible) {
  if (!panel) {
    return;
  }
  panel.hidden = !visible;
  panel.inert = !visible;
  panel.setAttribute("aria-hidden", String(!visible));
}

function activeRequestScrollOwner() {
  const subview = normalizeRequestSubview(state.requestSubview);
  if (subview === "search") {
    return normalizeSearchMode(state.searchMode) === "shared"
      ? elements.larkSearchResults
      : elements.searchResults;
  }
  if (subview === "discover") {
    if (state.catalogAdvancedTool) {
      return elements.catalogAdvancedView;
    }
    const mode = normalizeDiscoverMode(state.discoverMode);
    return mode === "categories"
      ? elements.discoverCategoriesPanel
      : mode === "artist"
        ? elements.discoverArtistPanel
        : elements.discoverNamePanel;
  }
  if (subview === "sources") {
    return normalizeSourcesMode(state.sourcesMode) === "favorites"
      ? elements.sourcesFavoritesScroll
      : elements.sourcesUidScroll;
  }
  return null;
}

function normalizedD1BrowseLevel(value) {
  return ["alphabet", "tags", "items"].includes(value) ? value : "alphabet";
}

function rememberDiscoverHierarchyScrollPosition(owner = activeRequestScrollOwner(), mode = state.discoverMode) {
  const normalizedMode = normalizeDiscoverMode(mode);
  if (!owner) {
    return;
  }
  const scrollTop = Math.max(0, Number(owner.scrollTop || 0));
  if (normalizedMode === "categories") {
    const level = state.categoryBrowseLevel === "detail" ? "detail" : "home";
    state.categoryBrowseScrollPositions[level] = scrollTop;
  } else {
    const modeState = d1BrowseModeState(normalizedMode);
    const level = normalizedD1BrowseLevel(modeState.level);
    modeState.scrollPositions[level] = scrollTop;
  }
  state.requestScrollPositions.discover[normalizedMode] = scrollTop;
}

function discoverHierarchyScrollPosition(mode = state.discoverMode) {
  const normalizedMode = normalizeDiscoverMode(mode);
  if (normalizedMode === "categories") {
    const level = state.categoryBrowseLevel === "detail" ? "detail" : "home";
    return Math.max(0, Number(state.categoryBrowseScrollPositions[level] || 0));
  }
  const modeState = d1BrowseModeState(normalizedMode);
  const level = normalizedD1BrowseLevel(modeState.level);
  return Math.max(0, Number(modeState.scrollPositions[level] || 0));
}

function rememberRequestScrollPosition() {
  const owner = activeRequestScrollOwner();
  if (!owner) {
    return;
  }
  const subview = normalizeRequestSubview(state.requestSubview);
  if (subview === "discover") {
    rememberDiscoverHierarchyScrollPosition(owner);
    return;
  }
  const mode = subview === "search"
    ? normalizeSearchMode(state.searchMode)
    : subview === "discover"
      ? normalizeDiscoverMode(state.discoverMode)
      : subview === "sources"
        ? normalizeSourcesMode(state.sourcesMode)
        : "";
  if (mode && state.requestScrollPositions?.[subview]) {
    state.requestScrollPositions[subview][mode] = Math.max(0, Number(owner.scrollTop || 0));
  }
}

function restoreRequestScrollPosition() {
  const owner = activeRequestScrollOwner();
  if (!owner) {
    return;
  }
  const subview = normalizeRequestSubview(state.requestSubview);
  if (subview === "discover") {
    const expectedScrollTop = discoverHierarchyScrollPosition();
    const restoreToken = state.requestScrollRestoreToken + 1;
    state.requestScrollRestoreToken = restoreToken;
    state.requestScrollRestoring = true;
    owner.scrollTop = expectedScrollTop;
    window.requestAnimationFrame(() => {
      if (state.requestScrollRestoreToken !== restoreToken || activeRequestScrollOwner() !== owner) {
        return;
      }
      owner.scrollTop = expectedScrollTop;
      window.requestAnimationFrame(() => {
        if (state.requestScrollRestoreToken === restoreToken) {
          state.requestScrollRestoring = false;
        }
      });
    });
    return;
  }
  const mode = subview === "search"
    ? normalizeSearchMode(state.searchMode)
    : subview === "discover"
      ? normalizeDiscoverMode(state.discoverMode)
      : subview === "sources"
        ? normalizeSourcesMode(state.sourcesMode)
        : "";
  owner.scrollTop = Math.max(0, Number(state.requestScrollPositions?.[subview]?.[mode] || 0));
}

function syncSearchModeSelection() {
  const activeMode = normalizeSearchMode(state.searchMode);
  const focusedMode = normalizeSearchMode(state.focusedSearchMode, activeMode);
  state.searchMode = activeMode;
  state.focusedSearchMode = focusedMode;
  elements.searchModeButtons?.forEach((button) => {
    const mode = normalizeSearchMode(button.dataset.searchMode, "");
    button.setAttribute("aria-selected", String(mode === activeMode));
    button.tabIndex = mode === focusedMode ? 0 : -1;
  });
  elements.searchModePanels?.forEach((panel) => {
    setRequestPanelVisibility(panel, panel.dataset.searchPanel === activeMode);
  });
  setTextContent(
    elements.searchModeContract,
    t(activeMode === "shared" ? "search.sharedContract" : "search.localContract"),
  );
}

function syncDiscoverModeSelection() {
  const activeMode = normalizeDiscoverMode(state.discoverMode);
  const focusedMode = normalizeDiscoverMode(state.focusedDiscoverMode, activeMode);
  const advancedOpen = Boolean(state.catalogAdvancedTool);
  state.discoverMode = activeMode;
  state.focusedDiscoverMode = focusedMode;
  elements.discoverModeButtons?.forEach((button) => {
    const mode = normalizeDiscoverMode(button.dataset.discoverMode, "");
    button.setAttribute("aria-selected", String(mode === activeMode && !advancedOpen));
    button.tabIndex = mode === focusedMode ? 0 : -1;
  });
  elements.discoverModePanels?.forEach((panel) => {
    setRequestPanelVisibility(
      panel,
      !advancedOpen && panel.dataset.discoverPanel === activeMode,
    );
  });
  setRequestPanelVisibility(elements.catalogAdvancedView, advancedOpen);
  if (!advancedOpen) {
    if (activeMode === "categories") {
      renderCategoryBrowseView();
    } else {
      restoreD1BrowseMode(activeMode);
      renderD1BrowseView();
    }
  }
}

function syncSourcesModeSelection() {
  const activeMode = normalizeSourcesMode(state.sourcesMode);
  const focusedMode = normalizeSourcesMode(state.focusedSourcesMode, activeMode);
  state.sourcesMode = activeMode;
  state.focusedSourcesMode = focusedMode;
  elements.sourcesModeButtons?.forEach((button) => {
    const mode = normalizeSourcesMode(button.dataset.sourcesMode, "");
    button.setAttribute("aria-selected", String(mode === activeMode));
    button.tabIndex = mode === focusedMode ? 0 : -1;
  });
  elements.sourcesModePanels?.forEach((panel) => {
    setRequestPanelVisibility(panel, panel.dataset.sourcesPanel === activeMode);
  });
  if (activeMode === "uids") {
    renderFollowBrowse();
  } else {
    renderFavlistBrowse();
  }
}

function syncRequestSubviewSelection() {
  const activeSubview = normalizeRequestSubview(state.requestSubview);
  const focusedSubview = normalizeRequestSubview(state.focusedRequestSubview, activeSubview);
  state.requestSubview = activeSubview;
  state.focusedRequestSubview = focusedSubview;
  if (elements.requestWorkspace) {
    elements.requestWorkspace.dataset.requestSubview = activeSubview;
  }
  if (elements.appShell) {
    elements.appShell.dataset.requestSubview = activeSubview;
  }
  elements.requestSubviewButtons?.forEach((button) => {
    const subview = normalizeRequestSubview(button.dataset.requestView, "");
    button.setAttribute("aria-selected", String(subview === activeSubview));
    button.tabIndex = subview === focusedSubview ? 0 : -1;
  });
  elements.requestSubviewPanels?.forEach((panel) => {
    setRequestPanelVisibility(panel, panel.dataset.requestPanel === activeSubview);
  });
  if (activeSubview === "search") {
    syncSearchModeSelection();
  } else if (activeSubview === "discover") {
    syncDiscoverModeSelection();
  } else if (activeSubview === "sources") {
    syncSourcesModeSelection();
  }
}

function closeRequestDetailForNavigation() {
  if (!searchDetailController?.isOpen?.()) {
    return false;
  }
  const activeKey = state.activeRequestDetailOriginKey;
  const selected = activeKey ? state.requestDetailSelections?.[activeKey] : null;
  if (selected) {
    selected.closedForNavigation = true;
  }
  searchDetailController.close({ immediate: true, restoreFocus: false, reason: "navigation" });
  state.activeRequestDetailOriginKey = "";
  return true;
}

function activateRequestSubview(subview, { focusTab = false } = {}) {
  const nextSubview = normalizeRequestSubview(subview, "");
  if (!nextSubview) {
    return false;
  }
  rememberRequestScrollPosition();
  const changed = state.requestSubview !== nextSubview;
  if (changed) {
    closeRequestDetailForNavigation();
  }
  state.requestSubview = nextSubview;
  state.focusedRequestSubview = nextSubview;
  syncRequestSubviewSelection();
  restoreRequestScrollPosition();
  if (focusTab) {
    Array.from(elements.requestSubviewButtons || [])
      .find((button) => button.dataset.requestView === nextSubview)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function activateSearchMode(mode, { focusTab = false } = {}) {
  const nextMode = normalizeSearchMode(mode, "");
  if (!nextMode) {
    return false;
  }
  rememberRequestScrollPosition();
  const changed = state.searchMode !== nextMode;
  if (changed) {
    closeRequestDetailForNavigation();
  }
  state.searchMode = nextMode;
  state.focusedSearchMode = nextMode;
  syncSearchModeSelection();
  restoreRequestScrollPosition();
  if (focusTab) {
    Array.from(elements.searchModeButtons || [])
      .find((button) => button.dataset.searchMode === nextMode)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function activateDiscoverMode(mode, { focusTab = false } = {}) {
  const nextMode = normalizeDiscoverMode(mode, "");
  if (!nextMode) {
    return false;
  }
  rememberRequestScrollPosition();
  if (["name", "artist"].includes(state.discoverMode)) {
    rememberD1BrowseMode(state.discoverMode);
  }
  const changed = state.discoverMode !== nextMode || Boolean(state.catalogAdvancedTool);
  if (changed) {
    closeRequestDetailForNavigation();
  }
  state.catalogAdvancedTool = "";
  state.discoverMode = nextMode;
  state.focusedDiscoverMode = nextMode;
  syncDiscoverModeSelection();
  restoreRequestScrollPosition();
  if (focusTab) {
    Array.from(elements.discoverModeButtons || [])
      .find((button) => button.dataset.discoverMode === nextMode)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function activateSourcesMode(mode, { focusTab = false } = {}) {
  const nextMode = normalizeSourcesMode(mode, "");
  if (!nextMode) {
    return false;
  }
  rememberRequestScrollPosition();
  const changed = state.sourcesMode !== nextMode;
  if (changed) {
    closeRequestDetailForNavigation();
  }
  state.sourcesMode = nextMode;
  state.focusedSourcesMode = nextMode;
  syncSourcesModeSelection();
  restoreRequestScrollPosition();
  if (focusTab) {
    Array.from(elements.sourcesModeButtons || [])
      .find((button) => button.dataset.sourcesMode === nextMode)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function handleHorizontalTabKeydown(event, values, activate) {
  const currentValue = String(
    event.currentTarget?.dataset?.requestView
      || event.currentTarget?.dataset?.searchMode
      || event.currentTarget?.dataset?.discoverMode
      || event.currentTarget?.dataset?.sourcesMode
      || "",
  );
  const currentIndex = Math.max(0, values.indexOf(currentValue));
  let targetIndex = null;
  if (event.key === "ArrowRight") {
    targetIndex = (currentIndex + 1) % values.length;
  } else if (event.key === "ArrowLeft") {
    targetIndex = (currentIndex - 1 + values.length) % values.length;
  } else if (event.key === "Home") {
    targetIndex = 0;
  } else if (event.key === "End") {
    targetIndex = values.length - 1;
  } else {
    return false;
  }
  event.preventDefault();
  activate(values[targetIndex], { focusTab: true });
  return true;
}

function renderHostWorkspaceSelection() {
  syncNarrowToolLayout();
  const activeWorkspace = normalizeHostWorkspaceName(state.activeHostWorkspace, "queue");
  const focusedWorkspace = normalizeHostWorkspaceName(
    state.focusedHostWorkspace,
    activeWorkspace,
  );
  const requestOverlay = activeWorkspace === "request"
    && state.hostWorkspaceOverlayOpen
    && hostRequestWorkspaceUsesOverlay();
  const requestOverlayClosed = activeWorkspace === "request"
    && !state.hostWorkspaceOverlayOpen
    && hostRequestWorkspaceUsesOverlay();
  const narrowToolSheet = hostNarrowToolSheetUsesOverlay();
  if (narrowToolSheet && !state.hostNarrowToolSheetActive) {
    state.hostWorkspaceOverlayOpen = false;
  } else if (!narrowToolSheet) {
    state.hostWorkspaceOverlayOpen = false;
  }
  state.hostNarrowToolSheetActive = narrowToolSheet;
  const narrowToolSheetClosed = narrowToolSheet && !state.hostWorkspaceOverlayOpen;

  state.activeHostWorkspace = activeWorkspace;
  state.focusedHostWorkspace = focusedWorkspace;
  if (elements.appShell) {
    elements.appShell.dataset.activeWorkspace = activeWorkspace;
    elements.appShell.classList.toggle("host-workspace-overlay-open", requestOverlay);
    elements.appShell.classList.toggle("host-tool-sheet-open", narrowToolSheet && !narrowToolSheetClosed);
    elements.appShell.classList.toggle("host-tool-sheet-closed", narrowToolSheetClosed);
  }
  if (elements.hostWorkspaceRegion) {
    elements.hostWorkspaceRegion.dataset.activeWorkspace = activeWorkspace;
    elements.hostWorkspaceRegion.setAttribute(
      "aria-labelledby",
      `work-rail-${activeWorkspace}`,
    );
    elements.hostWorkspaceRegion.inert = narrowToolSheetClosed;
    elements.hostWorkspaceRegion.setAttribute("aria-hidden", String(narrowToolSheetClosed));
  }
  elements.hostWorkspaceButtons?.forEach((button) => {
    const workspace = normalizeHostWorkspaceName(button.dataset.hostWorkspace, "");
    const selected = workspace === activeWorkspace;
    button.setAttribute("aria-selected", String(selected));
    if (narrowToolSheet) {
      button.setAttribute("aria-expanded", String(selected && !narrowToolSheetClosed));
    } else {
      button.removeAttribute?.("aria-expanded");
    }
    button.tabIndex = workspace === focusedWorkspace ? 0 : -1;
  });
  elements.hostWorkspacePanels?.forEach((panel) => {
    const workspace = normalizeHostWorkspaceName(panel.dataset.hostWorkspacePanel, "");
    const visible = workspace === activeWorkspace
      && !requestOverlayClosed
      && !narrowToolSheetClosed;
    panel.hidden = !visible;
    panel.inert = !visible;
    panel.setAttribute("aria-hidden", String(!visible));
  });
  if (elements.hostWorkspaceBackdrop) {
    elements.hostWorkspaceBackdrop.hidden = !requestOverlay;
    elements.hostWorkspaceBackdrop.inert = !requestOverlay;
    elements.hostWorkspaceBackdrop.setAttribute("aria-hidden", String(!requestOverlay));
  }
  if (typeof scheduleQueueScrollOwnershipSync === "function") {
    scheduleQueueScrollOwnershipSync();
  }
}

function normalizeHostWorkspaceName(value, fallback = "queue") {
  const candidate = String(value || "").trim().toLowerCase();
  return ["queue", "history", "request", "random", "users"].includes(candidate)
    ? candidate
    : fallback;
}

function hostRequestWorkspaceUsesOverlay() {
  return false;
}

function narrowHostViewport() {
  return typeof window !== "undefined"
    && Boolean(window.matchMedia?.("(max-width: 1179px)")?.matches);
}

function syncNarrowToolLayout() {
  if (!elements.appShell) {
    return "wide";
  }
  if (!narrowHostViewport()) {
    elements.appShell.dataset.narrowToolLayout = "wide";
    elements.appShell.style?.removeProperty?.("--narrow-stage-resident-height");
    return "wide";
  }
  const contentRect = elements.hostContentRegion?.getBoundingClientRect?.();
  const canReadComputedStyle = typeof window.getComputedStyle === "function";
  const panelStyle = elements.playerPanel && canReadComputedStyle
    ? window.getComputedStyle(elements.playerPanel)
    : null;
  const contentWidth = Math.max(0, Number(contentRect?.width || 0));
  const contentHeight = Math.max(0, Number(contentRect?.height || 0));
  const panelPaddingInline = (parseFloat(panelStyle?.paddingLeft) || 0)
    + (parseFloat(panelStyle?.paddingRight) || 0);
  const panelPaddingBlock = (parseFloat(panelStyle?.paddingTop) || 0)
    + (parseFloat(panelStyle?.paddingBottom) || 0);
  const panelGap = parseFloat(panelStyle?.rowGap || panelStyle?.gap) || 10;
  const headerHeight = elements.playerPanel
    ?.querySelector(".panel-head")
    ?.getBoundingClientRect?.().height || 42;
  const toggleHeight = elements.stageControlsToggle?.getBoundingClientRect?.().height || 40;
  const frameWidth = Math.max(0, contentWidth - panelPaddingInline);
  const frameHeight = frameWidth * (9 / 16);
  const compactStageHeight = Math.ceil(
    panelPaddingBlock + headerHeight + toggleHeight + frameHeight + (panelGap * 2),
  );
  const shellGap = canReadComputedStyle
    ? parseFloat(
      window.getComputedStyle(elements.appShell).getPropertyValue("--host-shell-gap"),
    ) || 12
    : 12;
  const minimumResidentToolHeight = 300;
  const availableStageHeight = Math.floor(
    contentHeight - minimumResidentToolHeight - shellGap,
  );
  const resident = contentWidth > 0
    && contentHeight > 0
    && availableStageHeight >= compactStageHeight;
  if (!resident) {
    elements.appShell.dataset.narrowToolLayout = "overlay";
    elements.appShell.style?.removeProperty?.("--narrow-stage-resident-height");
    return "overlay";
  }
  const inlineTraySize = measureStageControlTrayNaturalSize(
    Math.max(280, frameWidth),
    { layout: "inline" },
  );
  const inlineTrayHeight = inlineTraySize.height;
  const inlineTrayFitsWidth = inlineTraySize.width <= frameWidth + 1
    && inlineTraySize.contentFits;
  const fullStageHeight = Math.ceil(
    panelPaddingBlock + headerHeight + frameHeight + inlineTrayHeight + (panelGap * 2),
  );
  const residentStageHeight = inlineTrayFitsWidth && availableStageHeight >= fullStageHeight
    ? fullStageHeight
    : compactStageHeight;
  elements.appShell.dataset.narrowToolLayout = "resident";
  elements.appShell.style?.setProperty?.(
    "--narrow-stage-resident-height",
    `${Math.max(1, Math.floor(residentStageHeight))}px`,
  );
  return "resident";
}

function hostNarrowToolSheetUsesOverlay() {
  return narrowHostViewport()
    && elements.appShell?.dataset.narrowToolLayout !== "resident";
}

function hostWorkspaceButton(workspace) {
  const normalized = normalizeHostWorkspaceName(workspace, "");
  return Array.from(elements.hostWorkspaceButtons || []).find(
    (button) => button.dataset.hostWorkspace === normalized,
  ) || null;
}

function rememberHostWorkspaceScrollPosition(workspace = state.activeHostWorkspace) {
  const normalized = normalizeHostWorkspaceName(workspace, "");
  if (!normalized || !elements.hostWorkspaceRegion) {
    return;
  }
  state.hostWorkspaceScrollPositions ||= {};
  state.hostWorkspaceScrollPositions[normalized] = Math.max(
    0,
    Number(elements.hostWorkspaceRegion.scrollTop || 0),
  );
}

function restoreHostWorkspaceScrollPosition(workspace = state.activeHostWorkspace) {
  const normalized = normalizeHostWorkspaceName(workspace, "");
  if (!normalized || !elements.hostWorkspaceRegion) {
    return;
  }
  const scrollTop = Math.max(
    0,
    Number(state.hostWorkspaceScrollPositions?.[normalized] || 0),
  );
  elements.hostWorkspaceRegion.scrollTop = scrollTop;
}

function activateHostWorkspace(workspace, { inputOrigin = "pointer" } = {}) {
  const nextWorkspace = normalizeHostWorkspaceName(workspace, "");
  if (!nextWorkspace) {
    return false;
  }
  rememberHostWorkspaceScrollPosition();
  if (state.activeHostWorkspace === "request" && typeof rememberRequestScrollPosition === "function") {
    rememberRequestScrollPosition();
  }
  const changed = state.activeHostWorkspace !== nextWorkspace;
  const interactiveActivation = inputOrigin === "pointer" || inputOrigin === "keyboard";
  const previousToolSheetOpen = state.hostWorkspaceOverlayOpen;
  if (changed) {
    if (typeof closeOpenMenus === "function") {
      closeOpenMenus({ restoreFocus: false });
    }
    if (typeof closeRequestDetailForNavigation === "function") {
      closeRequestDetailForNavigation();
    } else if (typeof searchDetailController !== "undefined") {
      searchDetailController?.close({ immediate: true });
    }
  }
  state.activeHostWorkspace = nextWorkspace;
  state.focusedHostWorkspace = nextWorkspace;
  if (hostNarrowToolSheetUsesOverlay()) {
    state.hostWorkspaceOverlayOpen = !changed && interactiveActivation
      ? !state.hostWorkspaceOverlayOpen
      : true;
  } else {
    state.hostWorkspaceOverlayOpen = false;
  }
  renderHostWorkspaceSelection();
  if (nextWorkspace === "request" && typeof syncRequestSubviewSelection === "function") {
    syncRequestSubviewSelection();
    if (typeof restoreRequestScrollPosition === "function") {
      restoreRequestScrollPosition();
    }
  }
  if (nextWorkspace === "history") {
    loadPlayedSessions().catch((error) => {
      console.warn("加载历史场次失败:", error);
    });
  }
  restoreHostWorkspaceScrollPosition(nextWorkspace);

  const trigger = hostWorkspaceButton(nextWorkspace);
  if (inputOrigin === "pointer") {
    trigger?.focus({ preventScroll: true });
  } else if (inputOrigin === "keyboard") {
    const heading = Array.from(elements.hostWorkspacePanels || [])
      .find((panel) => (
        panel.dataset.hostWorkspacePanel === nextWorkspace && !panel.hidden
      ))
      ?.querySelector("[data-host-workspace-heading]");
    heading?.focus({ preventScroll: true });
  }
  return changed || previousToolSheetOpen !== state.hostWorkspaceOverlayOpen;
}

function focusHostWorkspaceRailItem(workspace) {
  const nextWorkspace = normalizeHostWorkspaceName(workspace, "");
  const trigger = hostWorkspaceButton(nextWorkspace);
  if (!nextWorkspace || !trigger) {
    return false;
  }
  state.focusedHostWorkspace = nextWorkspace;
  elements.hostWorkspaceButtons?.forEach((button) => {
    button.tabIndex = button === trigger ? 0 : -1;
  });
  trigger.focus({ preventScroll: true });
  return true;
}

function handleHostWorkspaceRailKeydown(event) {
  const currentWorkspace = normalizeHostWorkspaceName(
    event.currentTarget?.dataset?.hostWorkspace,
    state.focusedHostWorkspace,
  );
  const workspaces = ["queue", "history", "request", "random", "users"];
  const currentIndex = Math.max(0, workspaces.indexOf(currentWorkspace));
  let targetIndex = null;
  if (event.key === "ArrowDown") {
    targetIndex = (currentIndex + 1) % workspaces.length;
  } else if (event.key === "ArrowUp") {
    targetIndex = (currentIndex - 1 + workspaces.length) % workspaces.length;
  } else if (event.key === "Home") {
    targetIndex = 0;
  } else if (event.key === "End") {
    targetIndex = workspaces.length - 1;
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activateHostWorkspace(currentWorkspace, { inputOrigin: "keyboard" });
    return true;
  } else {
    return false;
  }
  event.preventDefault();
  focusHostWorkspaceRailItem(workspaces[targetIndex]);
  return true;
}

function closeHostWorkspaceOverlay({ restoreFocus = true } = {}) {
  if (hostNarrowToolSheetUsesOverlay() && state.hostWorkspaceOverlayOpen) {
    rememberHostWorkspaceScrollPosition();
    state.hostWorkspaceOverlayOpen = false;
    renderHostWorkspaceSelection();
    if (restoreFocus) {
      focusHostWorkspaceRailItem(state.activeHostWorkspace);
    }
    return true;
  }
  if (
    state.activeHostWorkspace !== "request"
    || !state.hostWorkspaceOverlayOpen
    || !hostRequestWorkspaceUsesOverlay()
  ) {
    return false;
  }
  rememberHostWorkspaceScrollPosition("request");
  state.hostWorkspaceOverlayOpen = false;
  renderHostWorkspaceSelection();
  if (restoreFocus) {
    state.focusedHostWorkspace = "request";
    focusHostWorkspaceRailItem("request");
  }
  return true;
}

function closeHighestRequestTaskLayerForEscape() {
  if (state.bindingIntent) {
    closeBindingModal();
    return true;
  }
  if (state.gatchaFavlistIntent) {
    closeGatchaFavlistModal();
    return true;
  }
  if (elements.poolConfigModal && !elements.poolConfigModal.classList.contains("hidden")) {
    closePoolConfigModal();
    return true;
  }
  if (elements.bilikaraSecretModal && !elements.bilikaraSecretModal.classList.contains("hidden")) {
    closeBilikaraSecretModal();
    return true;
  }
  if (elements.developerTagResetModal && !elements.developerTagResetModal.classList.contains("hidden")) {
    closeDeveloperTagResetModal();
    return true;
  }
  if (state.catalogAdvancedTool) {
    state.catalogAdvancedTool = "";
    syncDiscoverModeSelection();
    restoreRequestScrollPosition();
    elements.catalogAdvancedMenu?.querySelector("summary")?.focus({ preventScroll: true });
    return true;
  }
  if (state.ratingPromptElement) {
    closeRatingPrompt({ submit: true });
    return true;
  }
  return false;
}

function closeOrdinaryPopoverForEscape() {
  const infoTrigger = document.querySelector(
    ".cache-advanced-info.is-visible .cache-advanced-info-button",
  );
  if (closeCacheAdvancedInfo()) {
    infoTrigger?.focus({ preventScroll: true });
    return true;
  }
  if (state.remoteQrPinned) {
    setRemoteQrPinned(false, { dismissTransient: true });
    elements.remoteMiniTrigger?.focus({ preventScroll: true });
    elements.remoteMiniControl?.classList.add("is-qr-dismissed");
    return true;
  }
  if (state.cacheSettingsOpen) {
    state.cacheSettingsOpen = false;
    syncCachePanelVisibility();
    elements.cacheSettingsToggle?.focus({ preventScroll: true });
    return true;
  }
  if (state.displaySettingsOpen) {
    state.displaySettingsOpen = false;
    syncDisplayPanelVisibility();
    elements.displaySettingsToggle?.focus({ preventScroll: true });
    return true;
  }
  if (state.presentationSettingsOpen) {
    state.presentationSettingsOpen = false;
    syncPresentationPanelVisibility();
    elements.presentationSettingsToggle?.focus({ preventScroll: true });
    return true;
  }
  if (elements.catalogAdvancedMenu?.open) {
    elements.catalogAdvancedMenu.open = false;
    elements.catalogAdvancedMenu.querySelector("summary")?.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function stageControlsAreInline() {
  return elements.appShell?.dataset.stageControlsLayout === "inline";
}

function measureStageControlTrayNaturalSize(width, { layout = "" } = {}) {
  if (!elements.stageControlTray) {
    return { width: 0, height: 0, contentFits: false };
  }
  const tray = elements.stageControlTray;
  const previousLayout = elements.appShell?.dataset.stageControlsLayout;
  const previousStyle = tray.getAttribute("style");
  const previousHidden = tray.hidden;
  if (layout && elements.appShell) {
    elements.appShell.dataset.stageControlsLayout = layout;
  }
  tray.classList.add("is-measuring");
  tray.hidden = false;
  tray.style.width = `${Math.max(280, Math.round(width))}px`;
  tray.style.maxHeight = "none";
  const visibleChildren = (container) => [...(container?.children || [])]
    .filter((child) => !child.hidden && (child.offsetWidth || child.offsetHeight));
  const controlsStayOnOneRow = [
    ...tray.querySelectorAll(".av-sync-controls, .volume-controls"),
  ].every((controls) => {
    const children = visibleChildren(controls);
    if (children.length < 2) {
      return true;
    }
    const centers = children.map((child) => {
      const rect = child.getBoundingClientRect();
      return rect.top + (rect.height / 2);
    });
    return Math.max(...centers) - Math.min(...centers) <= 2;
  });
  const panelColumnsStayAligned = [...tray.querySelectorAll(".av-sync-panel")]
    .every((panel) => {
      const copy = panel.querySelector(".av-sync-copy")?.getBoundingClientRect?.();
      const controls = panel.querySelector(".av-sync-controls")?.getBoundingClientRect?.();
      return copy && controls
        && controls.left >= copy.right - 1
        && Math.min(copy.bottom, controls.bottom) - Math.max(copy.top, controls.top) > 0;
    });
  const labelledButtonsFit = [...tray.querySelectorAll("button")]
    .filter((button) => !button.hidden && (button.offsetWidth || button.offsetHeight))
    .every((button) => button.scrollWidth <= button.clientWidth + 1);
  const size = {
    width: Math.ceil(tray.scrollWidth || width),
    height: Math.ceil(tray.scrollHeight || 0),
    contentFits: controlsStayOnOneRow && panelColumnsStayAligned && labelledButtonsFit,
  };
  tray.classList.remove("is-measuring");
  tray.hidden = previousHidden;
  if (previousStyle === null) {
    tray.removeAttribute("style");
  } else {
    tray.setAttribute("style", previousStyle);
  }
  if (elements.appShell) {
    if (previousLayout === undefined) {
      delete elements.appShell.dataset.stageControlsLayout;
    } else {
      elements.appShell.dataset.stageControlsLayout = previousLayout;
    }
  }
  return size;
}

function clearStageControlTrayPosition() {
  if (!elements.stageControlTray) {
    return;
  }
  for (const property of ["left", "top", "width", "maxHeight", "transformOrigin"]) {
    elements.stageControlTray.style[property] = "";
  }
  delete elements.stageControlTray.dataset.popoverDirection;
}

function positionStageControlTray() {
  if (!elements.stageControlTray || !elements.stageControlsToggle || stageControlsAreInline()) {
    clearStageControlTrayPosition();
    return;
  }
  const anchor = elements.stageControlsToggle.getBoundingClientRect();
  const toolbar = elements.topbar?.getBoundingClientRect();
  const viewportInset = 12;
  const popupGap = 10;
  const topBoundary = Math.max(viewportInset, Number(toolbar?.bottom || 0) + 8);
  const availableWidth = Math.max(280, window.innerWidth - (viewportInset * 2));
  const width = Math.min(860, availableWidth);
  const naturalHeight = measureStageControlTrayNaturalSize(width).height || 520;
  const spaceBelow = Math.max(0, window.innerHeight - anchor.bottom - viewportInset - popupGap);
  const spaceAbove = Math.max(0, anchor.top - topBoundary - popupGap);
  const direction = spaceBelow >= naturalHeight ? "down" : "up";
  const directionSpace = direction === "down" ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(120, Math.min(naturalHeight, directionSpace));
  const left = Math.max(
    viewportInset,
    Math.min(anchor.left, window.innerWidth - viewportInset - width),
  );
  const top = direction === "down"
    ? anchor.bottom + popupGap
    : Math.max(topBoundary, anchor.top - popupGap - maxHeight);
  state.stageControlTrayDirection = direction;
  elements.stageControlTray.dataset.popoverDirection = direction;
  elements.stageControlTray.style.left = `${Math.round(left)}px`;
  elements.stageControlTray.style.top = `${Math.round(top)}px`;
  elements.stageControlTray.style.width = `${Math.round(width)}px`;
  elements.stageControlTray.style.maxHeight = `${Math.round(maxHeight)}px`;
  elements.stageControlTray.style.transformOrigin = direction === "down" ? "0 0" : "0 100%";
}

function setStageControlTrayOpen(open, { restoreFocus = false, moveFocus = true } = {}) {
  if (state.stageControlTrayFocusHandler && elements.stageControlTray) {
    elements.stageControlTray.removeEventListener("transitionend", state.stageControlTrayFocusHandler);
    state.stageControlTrayFocusHandler = null;
  }
  state.stageControlTrayOpen = Boolean(open);
  const inline = stageControlsAreInline();
  if (state.stageControlTrayOpen) {
    if (!inline) {
      closeCacheAdvancedInfo();
      setRemoteQrPinned(false, { dismissTransient: true });
      state.cacheSettingsOpen = false;
      state.displaySettingsOpen = false;
      state.presentationSettingsOpen = false;
      syncCachePanelVisibility();
      syncDisplayPanelVisibility();
      syncPresentationPanelVisibility();
    }
    if (elements.stageControlTray) {
      elements.stageControlTray.hidden = false;
      elements.stageControlTray.inert = false;
      elements.stageControlTray.setAttribute("aria-hidden", "false");
      elements.stageControlTray.setAttribute("role", inline ? "region" : "dialog");
      if (inline) {
        elements.stageControlTray.removeAttribute("aria-modal");
      } else {
        elements.stageControlTray.setAttribute("aria-modal", "true");
      }
    }
    if (elements.stageControlBackdrop) {
      elements.stageControlBackdrop.hidden = inline;
      elements.stageControlBackdrop.inert = inline;
      elements.stageControlBackdrop.setAttribute("aria-hidden", String(inline));
    }
    positionStageControlTray();
  }
  elements.stageControlTray?.classList.toggle("is-open", state.stageControlTrayOpen);
  elements.stageControlsToggle?.setAttribute("aria-expanded", String(state.stageControlTrayOpen));
  if (state.stageControlTrayOpen && !inline && moveFocus) {
    const focusCloseAfterOpen = (event) => {
      if (event.target !== elements.stageControlTray || event.propertyName !== "opacity") {
        return;
      }
      elements.stageControlTray.removeEventListener("transitionend", focusCloseAfterOpen);
      state.stageControlTrayFocusHandler = null;
      if (state.stageControlTrayOpen && !elements.stageControlTray.inert) {
        elements.stageControlsClose?.focus({ preventScroll: true });
      }
    };
    state.stageControlTrayFocusHandler = focusCloseAfterOpen;
    elements.stageControlTray?.addEventListener("transitionend", focusCloseAfterOpen);
    elements.stageControlsClose?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (state.stageControlTrayOpen && !elements.stageControlTray?.inert) {
        elements.stageControlsClose?.focus({ preventScroll: true });
      }
    });
    return;
  }
  if (state.stageControlTrayOpen) {
    return;
  }
  if (elements.stageControlTray) {
    elements.stageControlTray.hidden = true;
    elements.stageControlTray.inert = true;
    elements.stageControlTray.setAttribute("aria-hidden", "true");
  }
  if (elements.stageControlBackdrop) {
    elements.stageControlBackdrop.hidden = true;
    elements.stageControlBackdrop.inert = true;
    elements.stageControlBackdrop.setAttribute("aria-hidden", "true");
  }
  if (restoreFocus) {
    elements.stageControlsToggle?.focus({ preventScroll: true });
  }
}

function measurePersistentStage() {
  state.stageMeasureFrame = null;
  if (!elements.appShell || !elements.leftColumn || !elements.playerPanel) {
    return "compact";
  }
  const panelStyle = window.getComputedStyle(elements.playerPanel);
  const panelPaddingInline = (parseFloat(panelStyle.paddingLeft) || 0)
    + (parseFloat(panelStyle.paddingRight) || 0);
  const panelPaddingBlock = (parseFloat(panelStyle.paddingTop) || 0)
    + (parseFloat(panelStyle.paddingBottom) || 0);
  const panelGap = parseFloat(panelStyle.rowGap || panelStyle.gap) || 0;
  const innerWidth = Math.max(0, elements.playerPanel.clientWidth - panelPaddingInline);
  const innerHeight = Math.max(0, elements.playerPanel.clientHeight - panelPaddingBlock);
  const headerHeight = elements.playerPanel.querySelector(".panel-head")?.getBoundingClientRect().height || 0;
  const toggleHeight = elements.stageControlsToggle?.getBoundingClientRect().height || 40;
  const fullFrameWidth = innerWidth;
  const fullFrameHeight = fullFrameWidth * (9 / 16);
  const trayMeasureWidth = Math.max(280, innerWidth);
  const inlineTraySize = measureStageControlTrayNaturalSize(
    trayMeasureWidth,
    { layout: "inline" },
  );
  const trayHeight = inlineTraySize.height;
  const inlineFrameHeight = innerHeight
    - headerHeight
    - trayHeight
    - (panelGap * 2);
  const narrowShell = Boolean(window.matchMedia?.("(max-width: 1179px)")?.matches);
  const minimumUsefulFrameHeight = Math.min(
    fullFrameHeight,
    Math.max(180, innerHeight * 0.3),
  );
  const inlineControls = trayMeasureWidth <= innerWidth + 1
    && inlineTraySize.width <= trayMeasureWidth + 1
    && inlineTraySize.contentFits
    && trayHeight > 0
    && inlineFrameHeight >= minimumUsefulFrameHeight;
  const controlLayout = inlineControls ? "inline" : "popup";
  const reservedControlsHeight = inlineControls
    ? headerHeight + trayHeight + (panelGap * 2)
    : headerHeight + toggleHeight + (panelGap * 2);
  const frameHeight = Math.max(0, Math.min(fullFrameHeight, innerHeight - reservedControlsHeight));
  const frameWidth = Math.max(0, Math.min(fullFrameWidth, frameHeight * (16 / 9)));
  const mode = narrowShell
    ? "narrow"
    : inlineControls
      ? "full"
      : "compact";
  const previousMode = elements.appShell.dataset.stageMode;
  const previousLayout = elements.appShell.dataset.stageControlsLayout;
  elements.appShell.dataset.stageMode = mode;
  elements.appShell.dataset.stageControlsLayout = controlLayout;
  elements.playerPanel.style.setProperty("--stage-frame-inline-size", `${Math.floor(frameWidth)}px`);
  if (previousLayout !== controlLayout) {
    if (inlineControls) {
      state.stageControlInlineCollapsed = false;
      clearStageControlTrayPosition();
      setStageControlTrayOpen(true, { moveFocus: false });
    } else {
      setStageControlTrayOpen(false, { moveFocus: false });
    }
  } else if (inlineControls && !state.stageControlTrayOpen) {
    state.stageControlInlineCollapsed = false;
    setStageControlTrayOpen(true, { moveFocus: false });
  } else if (state.stageControlTrayOpen && previousMode !== mode) {
    positionStageControlTray();
  }
  return mode;
}

function schedulePersistentStageMeasurement() {
  if (state.stageMeasureFrame !== null) {
    return;
  }
  state.stageMeasureFrame = window.requestAnimationFrame(measurePersistentStage);
}

function initializePersistentStageFitting() {
  if (typeof ResizeObserver === "function") {
    state.stageResizeObserver?.disconnect?.();
    state.stageResizeObserver = new ResizeObserver(schedulePersistentStageMeasurement);
    state.stageResizeObserver.observe(elements.leftColumn);
    state.stageResizeObserver.observe(elements.playerPanel);
    state.queueScrollResizeObserver?.disconnect?.();
    state.queueScrollResizeObserver = new ResizeObserver(scheduleQueueScrollOwnershipSync);
    state.queueScrollResizeObserver.observe(elements.listStage);
    state.queueScrollResizeObserver.observe(elements.playlist);
  }
  schedulePersistentStageMeasurement();
  scheduleQueueScrollOwnershipSync();
}

function initializeWindowChrome() {
  const tauriWindowApi = window.__TAURI__?.window;
  const appWindow = tauriWindowApi?.getCurrentWindow?.();
  const userAgent = String(navigator.userAgent || "");
  const platform = /Windows/i.test(userAgent)
    ? "windows"
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? "macos"
      : "linux";
  document.body.dataset.tauriPlatform = appWindow ? platform : "browser";
  if (!appWindow) {
    return;
  }
  if (platform === "windows") {
    elements.windowControls.hidden = false;
    elements.windowMinimize?.addEventListener("click", () => appWindow.minimize().catch(() => {}));
    elements.windowMaximize?.addEventListener("click", () => appWindow.toggleMaximize().catch(() => {}));
    elements.windowClose?.addEventListener("click", () => appWindow.close().catch(() => {}));
  }
  elements.windowDragRegion?.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || platform !== "windows") {
      return;
    }
    appWindow.toggleMaximize().catch(() => {});
  });
}

function initializeHostShell() {
  state.activeHostWorkspace = "queue";
  state.focusedHostWorkspace = "queue";
  state.hostWorkspaceOverlayOpen = false;
  state.requestSubview = "search";
  state.focusedRequestSubview = "search";
  state.searchMode = "shared";
  state.focusedSearchMode = "shared";
  renderHostWorkspaceSelection();
  renderGatchaWorkspace();
  initializeWindowChrome();
  initializePersistentStageFitting();
  if (typeof syncRequestSubviewSelection === "function") {
    syncRequestSubviewSelection();
  }
  try {
    window.localStorage?.removeItem("bilikara.layout.mode");
  } catch {
    // The retired Host preference is optional; responsive shell behavior is unconditional.
  }
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

  const { audio } = activeLocalPlayerElements();
  if (audio) {
    applyKeyShiftToAudio(audio);
  }
}

function markLocalVolumeWrite() {
  state.playerSettingsEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.volumeSaveSeq += 1;
  return state.volumeSaveSeq;
}

function clientHeaders(extraHeaders = {}) {
  return {
    "X-Bilikara-Client": state.clientId,
    ...extraHeaders,
  };
}

function localizedBBDownLoginMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "";
  }
  if (raw === "请使用哔哩哔哩 App 扫码登录" || raw.includes("扫码登录")) {
    return t("service.scanWithBilibiliApp");
  }
  if (raw === "正在启动 BBDown 登录" || raw.includes("启动 BBDown 登录")) {
    return t("service.startingBBDownLogin");
  }
  if (raw === "BBDown 已登录" || raw === "已登录") {
    return t("service.bbdownLoggedIn");
  }
  if (raw === "BBDown 登录失败，请重试" || raw.includes("登录失败")) {
    return t("service.bbdownLoginFailed");
  }
  if (raw === "未登录") {
    return t("service.notLoggedIn");
  }
  return raw;
}

function localizedApiMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) {
    return "";
  }
  const bbdownMessage = localizedBBDownLoginMessage(raw);
  if (bbdownMessage && bbdownMessage !== raw) {
    return bbdownMessage;
  }
  const gatchaMessage = localizedGatchaTaskMessage(raw);
  if (gatchaMessage && gatchaMessage !== raw) {
    return gatchaMessage;
  }
  const cacheMessage = localizedCacheMessage(raw);
  if (cacheMessage && cacheMessage !== raw) {
    return cacheMessage;
  }
  return raw;
}

async function parseApiResponse(response, requestUrl = "") {
  const status = Number(response?.status || 0);
  const responseOk = Boolean(response?.ok);
  const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
  const jsonContentType = contentType
    .split(";", 1)[0]
    .trim()
    .match(/^(?:application|text)\/(?:[a-z0-9.+-]*\+)?json$/);
  let responseUrl = String(response?.url || "");
  if (!responseUrl && requestUrl) {
    try {
      responseUrl = new URL(requestUrl, window.location?.href || undefined).href;
    } catch {
      responseUrl = String(requestUrl);
    }
  }
  const tauriAssetApiResponse = /^(?:tauri:\/\/localhost|https?:\/\/tauri\.localhost)\/api(?:\/|$)/i
    .test(responseUrl);

  if (!jsonContentType) {
    const error = new Error("Backend returned a non-JSON response");
    error.kind = "non_json_response";
    error.status = status;
    error.contentType = contentType;
    error.responseUrl = responseUrl;
    error.backendNotReady = responseOk && tauriAssetApiResponse;
    throw error;
  }

  try {
    return await response.json();
  } catch (cause) {
    const error = new Error("Backend returned invalid JSON");
    error.kind = "invalid_json_response";
    error.status = status;
    error.contentType = contentType;
    error.responseUrl = responseUrl;
    error.cause = cause;
    throw error;
  }
}

function shouldReportStateFetchError(error) {
  if (!state.hasValidStateResponse) {
    return !error?.backendNotReady;
  }
  return ["non_json_response", "invalid_json_response"].includes(error?.kind);
}

async function apiPost(url, payload = {}, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const returnEnvelope = options.returnEnvelope === true;
  const controller = timeoutMs > 0 && typeof AbortController === "function"
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: clientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await parseApiResponse(response, url);
    if (!response.ok || !data.ok) {
      const error = new Error(localizedApiMessage(data.error) || t("error.requestFailed"));
      error.status = response.status;
      error.code = data.code || "";
      error.payload = data;
      throw error;
    }
    return returnEnvelope ? data : data.data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(t("error.requestTimeout"));
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function submitSongRating(item, score) {
  const bvid = String(item?.bvid || "").trim();
  const playId = ratingSubmissionPlayId(item);
  const sessionUserName = ratingSubmissionUserName(item);
  if (!bvid) {
    return null;
  }
  const submissionKey = ratingSubmissionKey({ ...item, play_id: playId, requester_name: sessionUserName });
  if (submissionKey && state.ratingSubmittedKeys.has(submissionKey)) {
    return false;
  }
  if (submissionKey) {
    state.ratingSubmittedKeys.add(submissionKey);
  }
  const payload = {
    session_user_name: sessionUserName,
    play_id: playId,
    bvid,
    score: Math.max(1, Math.min(5, Math.trunc(Number(score) || 5))),
  };
  fetch("/api/rating/submit", {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  }).catch((error) => {
    if (submissionKey) {
      state.ratingSubmittedKeys.delete(submissionKey);
    }
    console.warn("Rating submit failed:", error);
  });
  return true;
}

function ratingItemUrl(item) {
  return String(item?.resolved_url || item?.original_url || item?.url || "").trim();
}

function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function renderOwnerBadgeLabel(element, ownerName) {
  const normalized = String(ownerName || "").trim();
  element.replaceChildren();
  if (!normalized) {
    element.removeAttribute("aria-label");
    return;
  }
  const badge = document.createElement("span");
  badge.className = "owner-badge";
  badge.textContent = "UP";
  badge.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "owner-badge-name";
  name.textContent = normalized;
  element.append(badge, name);
  element.setAttribute("aria-label", t("owner.tooltip", { name: normalized }));
}

function ratingOwnerUid(item) {
  const rawMid = item?.owner_mid ?? item?.mid;
  const uid = String(rawMid || "").trim();
  return /^\d+$/.test(uid) ? uid : "";
}

function ratingSubmissionUserName(item) {
  return selectedRequesterName()
    || String(item?.requester_name || "").trim()
    || String(state.data?.current_item?.requester_name || "").trim()
    || String(state.data?.session_users?.[0] || "").trim()
    || "unknown";
}

function ratingSubmissionPlayId(item) {
  const bvid = String(item?.bvid || "").trim();
  return String(item?.play_id || item?.id || state.ratingPromptItemId || bvid).trim();
}

function ratingSubmissionKey(item) {
  const playId = ratingSubmissionPlayId(item);
  if (!playId) {
    return "";
  }
  return `${ratingSubmissionUserName(item).toLowerCase()}::${playId}`;
}

function hasSubmittedSongRating(item) {
  const key = ratingSubmissionKey(item);
  return Boolean(key && state.ratingSubmittedKeys.has(key));
}

function normalizeRatingPromptItem(item) {
  if (!item) {
    return null;
  }
  const id = String(item.id || item.item_id || item.play_id || item.bvid || "").trim();
  return {
    ...item,
    id,
    play_id: String(item.play_id || item.item_id || id).trim(),
    bvid: String(item.bvid || "").trim(),
    cover_url: String(item.cover_url || "").trim(),
  };
}

function previousRatingPromptItem(currentItem) {
  const currentId = String(currentItem?.id || "").trim();
  const playedItems = Array.isArray(state.data?.session_played) ? state.data.session_played : [];
  for (let index = playedItems.length - 1; index >= 0; index -= 1) {
    const entry = playedItems[index];
    const entryId = String(entry?.item_id || entry?.id || "").trim();
    if (entryId && entryId !== currentId) {
      const candidate = normalizeRatingPromptItem({ ...entry, id: entryId, play_id: entryId });
      return candidate?.bvid ? candidate : null;
    }
  }
  return null;
}

function ratingPromptItemsForItem(item) {
  return {
    previous: previousRatingPromptItem(item),
    current: normalizeRatingPromptItem(item),
  };
}

function activeRatingPromptItem() {
  return normalizeRatingPromptItem(
    state.ratingPromptItems?.[state.ratingPromptActiveTab]
      || state.ratingPromptItems?.current
      || state.ratingPromptItem,
  );
}

function renderRatingStars() {
  const root = state.ratingPromptElement;
  if (!root) {
    return;
  }
  root.querySelectorAll("[data-rating-score]").forEach((button) => {
    const score = Number(button.dataset.ratingScore || "0");
    button.classList.toggle("active", score <= state.ratingPromptScore);
    button.setAttribute("aria-pressed", score === state.ratingPromptScore ? "true" : "false");
  });
}

function renderRatingPromptContent() {
  const root = state.ratingPromptElement;
  if (!root) {
    return;
  }
  const activeItem = activeRatingPromptItem();
  state.ratingPromptItem = activeItem;
  state.ratingPromptBvid = String(activeItem?.bvid || "").trim();

  root.querySelectorAll("[data-rating-tab]").forEach((button) => {
    const tab = button.dataset.ratingTab;
    const hasItem = Boolean(state.ratingPromptItems?.[tab]);
    button.disabled = !hasItem;
    button.classList.toggle("active", tab === state.ratingPromptActiveTab);
    button.setAttribute("aria-selected", tab === state.ratingPromptActiveTab ? "true" : "false");
  });

  const content = root.querySelector("[data-rating-content]");
  if (!content || !activeItem) {
    return;
  }
  const bvid = String(activeItem.bvid || "").trim();
  const ownerName = String(activeItem.owner_name || "").trim() || t("rating.unknownOwner");
  const coverUrl = safeHttpUrl(activeItem.cover_url);
  const url = safeHttpUrl(ratingItemUrl(activeItem) || (bvid ? `https://www.bilibili.com/video/${bvid}` : ""));
  const titleKey = state.ratingPromptActiveTab === "previous" ? "rating.previousTitle" : "rating.title";
  const media = document.createElement("div");
  media.className = "rating-media";
  if (coverUrl) {
    const image = document.createElement("img");
    image.className = "rating-cover";
    image.src = coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    media.appendChild(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "rating-cover rating-cover-empty";
    media.appendChild(placeholder);
  }
  const copy = document.createElement("div");
  copy.className = "rating-copy";
  const kicker = document.createElement("p");
  kicker.className = "rating-kicker";
  kicker.textContent = t("rating.kicker");
  const title = document.createElement("h2");
  title.textContent = t(titleKey);
  const hint = document.createElement("p");
  hint.className = "rating-hint";
  hint.textContent = t("rating.hint");
  const owner = document.createElement("p");
  owner.className = "rating-owner owner-badge-label";
  renderOwnerBadgeLabel(owner, ownerName);
  copy.append(kicker, title, hint, owner);
  if (url) {
    const link = document.createElement("a");
    link.className = "rating-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = url;
    copy.appendChild(link);
  }
  media.appendChild(copy);
  content.replaceChildren(media);
  renderRatingStars();
}

function setRatingPromptActiveTab(tab) {
  if (!state.ratingPromptElement || !state.ratingPromptItems?.[tab]) {
    return;
  }
  state.ratingPromptActiveTab = tab;
  renderRatingPromptContent();
}

function closeRatingPrompt({ submit = true } = {}) {
  const root = state.ratingPromptElement;
  if (!root) {
    return;
  }
  const item = state.data?.current_item;
  const bvid = state.ratingPromptBvid;
  const shouldSubmit = submit && !state.ratingPromptSubmitted && !state.ratingOptOut && bvid;
  state.ratingPromptSubmitted = true;
  const promptItem = activeRatingPromptItem();
  root.remove();
  state.ratingPromptElement = null;
  state.ratingPromptItem = null;
  state.ratingPromptItems = null;
  state.ratingPromptActiveTab = "current";
  state.ratingPromptItemId = "";
  state.ratingPromptBvid = "";
  const opener = state.ratingPromptOpener;
  state.ratingPromptOpener = null;

  if (shouldSubmit) {
    submitSongRating({ ...(promptItem || item), bvid }, state.ratingPromptScore);
  }
  if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
}

function setRatingOptOut(enabled) {
  state.ratingOptOut = Boolean(enabled);
}

function openRatingPrompt(item) {
  const bvid = String(item?.bvid || "").trim();
  const playId = String(item?.id || bvid).trim();
  if (!item || !bvid || !playId || state.ratingOptOut || state.ratingPromptSeenPlayIds.has(playId)) {
    return;
  }
  if (fullscreenElement()) {
    return;
  }
  const promptItems = ratingPromptItemsForItem(item);
  closeRatingPrompt({ submit: true });
  state.ratingPromptSeenPlayIds.add(playId);
  state.ratingPromptItemId = playId;
  state.ratingPromptItems = promptItems;
  state.ratingPromptActiveTab = "current";
  state.ratingPromptItem = promptItems.current;
  state.ratingPromptBvid = bvid;
  state.ratingPromptScore = 5;
  state.ratingPromptSubmitted = false;
  state.ratingPromptOpener = document.activeElement;

  const root = document.createElement("div");
  root.className = "rating-modal";

  const backdrop = document.createElement("div");
  backdrop.className = "rating-modal-backdrop";
  backdrop.dataset.ratingClose = "";

  const card = document.createElement("section");
  card.className = "rating-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", t("rating.dialogLabel"));

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "rating-close";
  closeButton.dataset.ratingClose = "";
  closeButton.setAttribute("aria-label", t("rating.closeLabel"));
  closeButton.textContent = "\u00d7";

  const content = document.createElement("div");
  content.dataset.ratingContent = "";

  const stars = document.createElement("div");
  stars.className = "rating-stars";
  stars.setAttribute("role", "radiogroup");
  stars.setAttribute("aria-label", t("rating.scoreLabel"));
  [1, 2, 3, 4, 5].forEach((score) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.ratingScore = String(score);
    button.setAttribute("aria-label", t("rating.scoreAria", { score }));
    button.textContent = "\u2605";
    stars.appendChild(button);
  });

  const actions = document.createElement("div");
  actions.className = "rating-actions";
  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "next-button";
  doneButton.dataset.ratingClose = "";
  doneButton.textContent = t("rating.done");
  actions.appendChild(doneButton);

  const optOut = document.createElement("label");
  optOut.className = "rating-opt-out";
  const optOutInput = document.createElement("input");
  optOutInput.type = "checkbox";
  optOutInput.dataset.ratingOptOut = "";
  const optOutText = document.createElement("span");
  optOutText.textContent = t("rating.optOut");
  optOut.append(optOutInput, optOutText);

  const tabs = document.createElement("div");
  tabs.className = "rating-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("rating.dialogLabel"));
  const previousTab = document.createElement("button");
  previousTab.type = "button";
  previousTab.dataset.ratingTab = "previous";
  previousTab.setAttribute("role", "tab");
  previousTab.disabled = !promptItems.previous;
  previousTab.textContent = t("rating.previousTab");
  const currentTab = document.createElement("button");
  currentTab.type = "button";
  currentTab.dataset.ratingTab = "current";
  currentTab.setAttribute("role", "tab");
  currentTab.textContent = t("rating.currentTab");
  tabs.append(previousTab, currentTab);

  const message = document.createElement("p");
  message.className = "rating-message";
  message.dataset.ratingMessage = "";
  card.append(closeButton, content, stars, actions, optOut, tabs, message);
  root.append(backdrop, card);
  document.body.appendChild(root);
  state.ratingPromptElement = root;
  renderRatingPromptContent();
}

function maybeShowRatingPromptForProgress(item, currentTime, duration) {
  return;
}

function handleRatingCurrentItemChange(currentItem) {
  if (!state.ratingPromptElement) {
    return;
  }
  const currentId = String(currentItem?.id || "");
  if (!currentId || currentId !== state.ratingPromptItemId) {
    closeRatingPrompt({ submit: true });
    return;
  }
}

function handleRequesterSelectionChange() {
  render();
}

async function apiGet(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: clientHeaders(),
    signal: options.signal,
  });
  const data = await parseApiResponse(response, url);
  if (!response.ok || !data.ok) {
    const error = new Error(localizedApiMessage(data.error) || t("error.requestFailed"));
    error.status = response.status;
    error.code = data.code || "";
    error.payload = data;
    throw error;
  }
  return data.data;
}

const hevcCanPlayTypes = [
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
];

const avcPlaybackLevels = [
  { name: "High@L5.2", codec: 'video/mp4; codecs="avc1.640034"', maxAvcQualityIndex: 0 },
  { name: "High@L5.1", codec: 'video/mp4; codecs="avc1.640033"', maxAvcQualityIndex: 0 },
  { name: "High@L5.0", codec: 'video/mp4; codecs="avc1.640032"', maxAvcQualityIndex: 1 },
  { name: "High@L4.2", codec: 'video/mp4; codecs="avc1.64002A"', maxAvcQualityIndex: 1 },
  { name: "High@L4.1", codec: 'video/mp4; codecs="avc1.640029"', maxAvcQualityIndex: 2 },
  { name: "Main@L4.1", codec: 'video/mp4; codecs="avc1.4D0029"', maxAvcQualityIndex: 2 },
  { name: "High@L4.0", codec: 'video/mp4; codecs="avc1.640028"', maxAvcQualityIndex: 3 },
  { name: "Main@L4.0", codec: 'video/mp4; codecs="avc1.4D0028"', maxAvcQualityIndex: 3 },
  { name: "High@L3.2", codec: 'video/mp4; codecs="avc1.640020"', maxAvcQualityIndex: 3 },
  { name: "Main@L3.2", codec: 'video/mp4; codecs="avc1.4D0020"', maxAvcQualityIndex: 3 },
  { name: "High@L3.1", codec: 'video/mp4; codecs="avc1.64001F"', maxAvcQualityIndex: 4 },
  { name: "Main@L3.1", codec: 'video/mp4; codecs="avc1.4D001F"', maxAvcQualityIndex: 4 },
  { name: "Main@L3.0", codec: 'video/mp4; codecs="avc1.4D001E"', maxAvcQualityIndex: 5 },
  { name: "Baseline@L3.0", codec: 'video/mp4; codecs="avc1.42E01E"', maxAvcQualityIndex: 5 },
  { name: "Main@L2.1", codec: 'video/mp4; codecs="avc1.4D0015"', maxAvcQualityIndex: 6 },
  { name: "Baseline@L2.1", codec: 'video/mp4; codecs="avc1.42E015"', maxAvcQualityIndex: 6 },
];

function isSupportedCanPlayTypeResult(result) {
  return result === "probably" || result === "maybe";
}

function detectMediaCapabilities() {
  const video = document.createElement("video");
  const canPlayType = {};
  let hevcSupported = false;
  for (const mimeType of hevcCanPlayTypes) {
    const result = typeof video.canPlayType === "function"
      ? video.canPlayType(mimeType)
      : "";
    canPlayType[mimeType] = result;
    if (isSupportedCanPlayTypeResult(result)) {
      hevcSupported = true;
    }
  }
  let supportedAvcLevel = null;
  const avcLevels = avcPlaybackLevels.map((level) => {
    const result = typeof video.canPlayType === "function"
      ? video.canPlayType(level.codec)
      : "";
    canPlayType[level.codec] = result;
    const supported = isSupportedCanPlayTypeResult(result);
    if (!supportedAvcLevel && supported) {
      supportedAvcLevel = level;
    }
    return {
      name: level.name,
      codec: level.codec,
      can_play_type: result,
      max_avc_quality_index: level.maxAvcQualityIndex,
    };
  });
  const assumeHighestAvcLevel = !supportedAvcLevel
    && avcLevels.length > 0
    && avcLevels.every((level) => !level.can_play_type);
  const effectiveAvcLevel = supportedAvcLevel || (assumeHighestAvcLevel ? avcPlaybackLevels[0] : null);
  return {
    hevc_supported: hevcSupported,
    avc_supported: Boolean(effectiveAvcLevel),
    max_avc_quality_index: effectiveAvcLevel ? effectiveAvcLevel.maxAvcQualityIndex : 6,
    avc_levels: avcLevels,
    can_play_type: canPlayType,
    user_agent: window.navigator?.userAgent || "",
    platform: window.navigator?.platform || "",
  };
}

async function reportMediaCapabilities() {
  const capabilities = detectMediaCapabilities();
  const signature = JSON.stringify(capabilities);
  if (state.mediaCapabilitiesReported && state.mediaCapabilitiesSignature === signature) {
    return;
  }
  await apiPost("/api/client/media-capabilities", capabilities);
  state.mediaCapabilitiesReported = true;
  state.mediaCapabilitiesSignature = signature;
}

async function fetchState() {
  const previousOffsetMs = currentAvOffsetMs();
  const previousData = state.data;
  const response = await fetch("/api/state", {
    headers: clientHeaders(),
  });
  const payload = await parseApiResponse(response, "/api/state");
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.stateFailed"));
  }
  if (!acceptHostStateSnapshot(payload.data)) {
    return false;
  }
  state.hasValidStateResponse = true;
  scheduleStartupAppUpdateCheck();
  maybeShowIncomingRequestToast(previousData, state.data);
  maybeShowSongTransitionOverlay(previousData, state.data);

  syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
  if (!state.localPreferencesHydrated) {
    const rememberedVolume = rememberedVolumePercent();
    const rememberedMute = rememberedMuted();
    const serverVolume = Number(state.data?.player_settings?.volume_percent ?? 100);
    const serverMuted = Boolean(state.data?.player_settings?.is_muted);
    state.localPreferencesHydrated = true;
    if (rememberedVolume !== serverVolume || rememberedMute !== serverMuted) {
      await apiPostStateSnapshot("/api/player/volume", {
        volume_percent: rememberedVolume,
        is_muted: rememberedMute,
      });
      syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
    }
  }
  scheduleFavlistBrowseReloadFromState(previousData, state.data);
  const renderSignature = renderSignatureForData(state.data);
  if (renderSignature !== state.lastPollRenderSignature) {
    state.lastPollRenderSignature = renderSignature;
    render();
  } else if (hasDownloadingItems(state.data)) {
    refreshRetryButtons();
  }
  resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs);
  return true;
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
    throw new Error(localizedApiMessage(payload.error) || t("error.searchFailed"));
  }
  return Array.isArray(payload.data?.items) ? payload.data.items : [];
}

async function searchLarkPool(query) {
  const normalizedQuery = String(query || "").trim();
  const params = new URLSearchParams();
  params.set("q", normalizedQuery);
  params.set("limit", "80");
  const response = await fetch(`/api/lark/search?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.larkSearchFailed"));
  }
  return Array.isArray(payload.data?.items) ? payload.data.items : [];
}

async function searchLarkPoolTable(query, tableIndex) {
  const normalizedQuery = String(query || "").trim();
  const params = new URLSearchParams();
  params.set("q", normalizedQuery);
  params.set("table", String(tableIndex));
  params.set("limit", "80");
  const response = await fetch(`/api/lark/search?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.larkSearchFailed"));
  }
  return Array.isArray(payload.data?.items) ? payload.data.items : [];
}

async function fetchD1Browse({ kind = "name", letter = "", query = "", tag = "", locale = "", limit = 100 } = {}) {
  const params = new URLSearchParams();
  params.set("kind", kind === "artist" ? "artist" : "name");
  params.set("limit", String(limit));
  const normalizedLetter = String(letter || "").trim().toUpperCase();
  const normalizedQuery = String(query || "").trim();
  const normalizedTag = String(tag || "").trim();
  const normalizedLocale = String(locale || "").trim();
  if (normalizedLetter) {
    params.set("letter", normalizedLetter);
  }
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  if (normalizedTag) {
    params.set("tag", normalizedTag);
  }
  if (normalizedLocale) {
    params.set("locale", normalizedLocale);
  }
  const response = await fetch(`/api/d1/browse?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.larkSearchFailed"));
  }
  return payload.data || { kind, letter: normalizedLetter, query: normalizedQuery, tag: normalizedTag, tags: [], items: [] };
}

async function fetchPendingReviewItems() {
  return apiPost("/api/admin-review/pending", {
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
    limit: 20,
  });
}

async function approvePendingReviewItems(bvids) {
  return apiPost("/api/admin-review/approve", {
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
    bvids: Array.isArray(bvids) ? bvids : [],
    limit: 20,
  });
}

async function fetchBlacklistItems({ query = "", offset = 0, limit = 20 } = {}) {
  return apiPost("/api/admin-blacklist/list", {
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
    query: String(query || "").trim(),
    offset: Math.max(0, Number(offset) || 0),
    limit: Math.max(1, Number(limit) || 20),
  });
}

async function restoreBlacklistItem(bvid, restoreVideo = false) {
  return apiPost("/api/admin-blacklist/restore", {
    bvid: String(bvid || "").trim(),
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
    restore_video: Boolean(restoreVideo),
    restored_by: selectedRequesterName() || developerModeRequesterName,
  });
}

function uniqueD1BrowseTags(tags) {
  const seen = new Set();
  return (Array.isArray(tags) ? tags : []).reduce((results, value) => {
    const tag = String(value || "").trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      results.push(tag);
    }
    return results;
  }, []);
}

async function fetchD1CategoryBrowse({ tags = [], query = "", offset = 0, limit = 100 } = {}) {
  const params = new URLSearchParams();
  const normalizedTags = uniqueD1BrowseTags(tags);
  normalizedTags.forEach((tag) => {
    params.append(categoryBrowseUsesFullFieldSearch(tag) ? "tag" : "tag45", tag);
  });
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  const response = await fetch(`/api/d1/category-browse?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.larkSearchFailed"));
  }
  return payload.data || {
    tags: normalizedTags,
    query: normalizedQuery,
    offset,
    limit,
    items: [],
    has_more: false,
    next_offset: offset,
  };
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
    throw new Error(localizedApiMessage(payload.error) || t("error.browseFailed"));
  }
  return payload.data || { owners: [], items: [] };
}

async function fetchGatchaFavlistBrowse(folderId = "", query = "") {
  const params = new URLSearchParams();
  const normalizedFolderId = String(folderId || "").trim();
  const normalizedQuery = String(query || "").trim();
  if (normalizedFolderId) {
    params.set("folder_id", normalizedFolderId);
  }
  if (normalizedQuery) {
    params.set("q", normalizedQuery);
  }
  const queryString = params.toString();
  const response = await fetch(`/api/gatcha/favlist/browse${queryString ? `?${queryString}` : ""}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.browseFailed"));
  }
  return payload.data || { folders: [], items: [] };
}

async function fetchPoolConfig() {
  const response = await fetch("/api/gatcha/pool-config", {
    cache: "no-store",
    headers: clientHeaders(),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("gatcha.poolLoadFailed"));
  }
  return payload.data || {};
}

async function savePoolConfig(payload) {
  return apiPost("/api/gatcha/pool-config", payload);
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

async function previewGatchaFavlist(uid) {
  return apiPost("/api/gatcha/favlist/preview", { uid: String(uid || "").trim() });
}

async function pullGatchaFavlist(uid, folderIds = []) {
  return apiPost("/api/gatcha/favlist", {
    uid: String(uid || "").trim(),
    folder_ids: Array.isArray(folderIds) ? folderIds : [],
  });
}

function gatchaUidResultMessage(result, fallbackUid = "") {
  const cache = result?.cache || {};
  const addedCount = Number(cache.added_count || 0);
  const totalCount = Number(cache.total_count || 0);
  const modeLabel = cache.mode === "incremental" ? t("gatcha.latestMode") : t("gatcha.allMode");
  const ownerLabel = result?.name
    ? t("owner.upOwner", { name: result.name })
    : t("owner.uid", { uid: result?.uid || fallbackUid });
  const listAction = result?.added ? t("gatcha.addedToFollow") : t("gatcha.alreadyFollowed");
  return t("gatcha.uidResult", {
    owner: ownerLabel,
    action: listAction,
    mode: modeLabel,
    added: addedCount,
    total: totalCount,
  });
}

async function confirmGatchaUidAdd(intent) {
  closeConfirm();
  const messageTarget = intent.messageTarget || "gatcha";
  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidFace();
    return;
  }
  state.gatchaUidSaving = true;
  renderGatchaUidFace();
  setGatchaUidFlowMessage(messageTarget, t("gatcha.pullingOwnerItems", { name: intent.name || intent.uid }));
  try {
    const result = await addGatchaUid(intent.uid);
    setGatchaUidFlowMessage(messageTarget, gatchaUidResultMessage(result, intent.uid));
    clearGatchaUidFlowInput(intent.clearInputId || "modal-follow-uid-input");
    await refreshFollowBrowseAfterGatchaUidAdd(result?.uid || intent.uid);
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidFace();
  }
}

function setDeveloperMode(enabled) {
  state.developerMode = Boolean(enabled);
  if (!state.developerMode) {
    state.bilikaraSecret = "";
    state.pendingReviewItems = [];
    state.pendingReviewTotal = 0;
    state.pendingReviewExportCount = 0;
    state.pendingReviewLoaded = false;
    state.pendingReviewLoading = false;
    state.pendingReviewSeq += 1;
    state.pendingReviewMessage = "";
    state.pendingReviewError = "";
    state.blacklistItems = [];
    state.blacklistTotal = 0;
    state.blacklistOffset = 0;
    state.blacklistHasMore = false;
    state.blacklistQuery = "";
    state.blacklistLoaded = false;
    state.blacklistLoading = false;
    state.blacklistSeq += 1;
    state.blacklistMessage = "";
    state.blacklistError = "";
    state.maintenanceJobRunning = "";
    state.maintenanceJobMessage = "";
    state.maintenanceJobError = "";
    state.catalogAdvancedTool = "";
    elements.catalogAdvancedMenu?.removeAttribute("open");
    if (state.requestSubview === "discover") {
      syncDiscoverModeSelection();
    }
  }
  document.body?.classList.toggle("developer-mode", state.developerMode);
  elements.appShell?.classList.toggle("developer-mode", state.developerMode);
  elements.developerModeTrigger?.classList.toggle("active", state.developerMode);
  elements.developerModeTrigger?.setAttribute("aria-pressed", String(state.developerMode));
}

function openBilikaraSecretModal() {
  if (state.developerMode) {
    return;
  }
  if (selectedRequesterName() !== developerModeRequesterName) {
    openExternalUrl(projectUrl);
    return;
  }
  if (elements.bilikaraSecretInput) {
    elements.bilikaraSecretInput.value = "";
  }
  if (elements.bilikaraSecretMessage) {
    elements.bilikaraSecretMessage.textContent = "";
    elements.bilikaraSecretMessage.classList.remove("is-error");
  }
  state.bilikaraSecretOpener = document.activeElement;
  elements.bilikaraSecretModal?.classList.remove("hidden");
  window.setTimeout(() => elements.bilikaraSecretInput?.focus(), 0);
}

function closeBilikaraSecretModal({ restoreFocus = true } = {}) {
  if (state.bilikaraSecretVerifying) {
    return;
  }
  elements.bilikaraSecretModal?.classList.add("hidden");
  if (elements.bilikaraSecretInput) {
    elements.bilikaraSecretInput.value = "";
  }
  if (elements.bilikaraSecretMessage) {
    elements.bilikaraSecretMessage.textContent = "";
    elements.bilikaraSecretMessage.classList.remove("is-error");
  }
  const opener = state.bilikaraSecretOpener;
  state.bilikaraSecretOpener = null;
  if (restoreFocus && opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
}

async function verifyBilikaraSecret() {
  if (state.bilikaraSecretVerifying) {
    return;
  }
  if (selectedRequesterName() !== developerModeRequesterName) {
    openExternalUrl(projectUrl);
    return;
  }
  const bilikaraSecret = String(elements.bilikaraSecretInput?.value || "").trim();
  if (!bilikaraSecret) {
    if (elements.bilikaraSecretMessage) {
      elements.bilikaraSecretMessage.textContent = "请输入 BILIKARA_ADMIN_SECRET。";
      elements.bilikaraSecretMessage.classList.add("is-error");
    }
    return;
  }
  state.bilikaraSecretVerifying = true;
  if (elements.bilikaraSecretConfirm) {
    elements.bilikaraSecretConfirm.disabled = true;
  }
  if (elements.bilikaraSecretMessage) {
    elements.bilikaraSecretMessage.textContent = "验证中...";
    elements.bilikaraSecretMessage.classList.remove("is-error");
  }
  try {
    await apiPost("/api/bilikara-secret/verify", { BILIKARA_ADMIN_SECRET: bilikaraSecret });
    state.bilikaraSecret = bilikaraSecret;
    setDeveloperMode(true);
    state.bilikaraSecretVerifying = false;
    closeBilikaraSecretModal();
  } catch {
    if (elements.bilikaraSecretMessage) {
      elements.bilikaraSecretMessage.textContent = "验证失败。";
      elements.bilikaraSecretMessage.classList.add("is-error");
    }
  } finally {
    state.bilikaraSecretVerifying = false;
    if (elements.bilikaraSecretConfirm) {
      elements.bilikaraSecretConfirm.disabled = false;
    }
  }
}
function closeDeveloperTagResetModal({ restoreFocus = true } = {}) {
  if (state.developerTagResetSaving) {
    return;
  }
  state.developerTagResetItem = null;
  state.developerTagResetAction = "";
  elements.developerTagResetModal?.classList.add("hidden");
  if (elements.developerTagResetFields) {
    elements.developerTagResetFields.innerHTML = "";
  }
  elements.developerTagResetDeleteMid?.classList.add("hidden");
  const opener = state.developerTagResetOpener;
  state.developerTagResetOpener = null;
  if (restoreFocus && opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
}

function renderDeveloperActionFields(fields) {
  if (!elements.developerTagResetFields) {
    return;
  }
  elements.developerTagResetFields.innerHTML = "";
  Object.entries(fields || {}).forEach(([key, rawValue]) => {
    const row = document.createElement("div");
    row.className = "developer-tag-reset-field";
    const name = document.createElement("span");
    name.className = "developer-tag-reset-field-name";
    name.textContent = key;
    const value = document.createElement("span");
    value.className = "developer-tag-reset-field-value";
    value.textContent = String(rawValue ?? "") || "空";
    row.append(name, value);
    elements.developerTagResetFields.appendChild(row);
  });
}

function openDeveloperTagResetModal(snapshot, action = "reset-tags") {
  if (!state.developerMode || !snapshot?.bvid) {
    return;
  }
  state.developerTagResetOpener = document.activeElement;
  state.developerTagResetItem = snapshot;
  state.developerTagResetAction = action;
  const isDelete = action === "delete-entry";
  const isReject = action === "reject-entry";
  const isBlacklistRelease = action === "blacklist-release";
  const isBlacklistRestore = action === "blacklist-release-restore";
  if (elements.developerTagResetTitle) {
    elements.developerTagResetTitle.textContent = isReject
      ? "拒绝并加入黑名单"
      : isBlacklistRestore
        ? t("search.blacklistReleaseRestore")
        : isBlacklistRelease
          ? t("search.blacklistRelease")
          : isDelete
            ? "删除 D1 条目"
            : "重置标签字段";
  }
  if (elements.developerTagResetText) {
    const title = snapshot.title ? `《${snapshot.title}》` : "当前条目";
    elements.developerTagResetText.textContent = isReject
      ? `确认拒绝 ${title} (${snapshot.bvid})，并阻止收藏夹再次写入 D1？`
      : isBlacklistRestore
        ? `确认解除 ${title} (${snapshot.bvid}) 的黑名单并恢复删除前记录？`
        : isBlacklistRelease
          ? `确认解除 ${title} (${snapshot.bvid}) 的黑名单？此操作不会立即恢复视频。`
          : isDelete
            ? `确认从 D1 删除 ${title} (${snapshot.bvid})？`
            : `确认重置 ${title} (${snapshot.bvid}) 的标签字段？`;
  }
  renderDeveloperActionFields(snapshot.fields);
  if (elements.developerTagResetNote) {
    elements.developerTagResetNote.textContent = isReject
      ? "视频快照会保存在黑名单中；点歌和本地播放不受影响。"
      : isBlacklistRestore
        ? "将从黑名单快照恢复 D1 记录，并重新建立名称/歌手浏览索引。"
        : isBlacklistRelease
          ? "只解除写入拦截；后续收藏夹刷新可以再次收录该视频。"
          : isDelete
            ? "确认后将按 bvid 删除 D1 中对应条目；此操作不会删除 B 站视频本体。"
            : "确认后目标变更：清空 tag_1-5、preserved_2-5，并将 tag_status 改为 0。";
  }
  if (elements.developerTagResetConfirm) {
    elements.developerTagResetConfirm.disabled = false;
    elements.developerTagResetConfirm.textContent = isReject
      ? "确认拒绝"
      : isBlacklistRestore
        ? t("search.blacklistReleaseRestore")
        : isBlacklistRelease
          ? t("search.blacklistRelease")
          : isDelete
            ? "确认删除"
            : "确认重置";
    elements.developerTagResetConfirm.classList.toggle("danger-button", isDelete || isReject);
  }
  if (elements.developerTagResetDeleteMid) {
    const mid = String(snapshot.fields?.mid || "").trim();
    elements.developerTagResetDeleteMid.classList.toggle("hidden", !isDelete || !mid);
    elements.developerTagResetDeleteMid.disabled = false;
    elements.developerTagResetDeleteMid.textContent = mid ? `按 MID 删除 ${mid}` : "按 MID 删除";
  }
  elements.developerTagResetModal?.classList.remove("hidden");
}

function parseDeveloperActionButton(button) {
  try {
    const snapshot = JSON.parse(String(button?.dataset?.item || "{}"));
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function handleDeveloperTagResetButtonClick(event) {
  const button = event.target.closest("button[data-dev-action]");
  if (!button || !elements.requestWorkspace?.contains(button)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const snapshot = parseDeveloperActionButton(button);
  if (snapshot) {
    let action = String(button.dataset.devAction || "reset-tags");
    if (
      action === "delete-entry"
      && button.closest("[data-pending-review-view]")
      && state.pendingReviewItems.some((item) => searchResultBvid(item) === snapshot.bvid)
    ) {
      action = "reject-entry";
    }
    openDeveloperTagResetModal(snapshot, action);
  }
}

async function deleteDeveloperD1Entry(snapshot) {
  await apiPost("/api/admin-video/delete", {
    bvid: snapshot.bvid,
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
  });
  const reviewCacheExhausted = removePendingReviewItem(snapshot.bvid);
  if (reviewCacheExhausted) {
    await loadPendingReviewItems({ force: true });
  }
  setAppMessage(`已删除 ${snapshot.bvid} 的 D1 条目。`);
}

async function rejectPendingReviewEntry(snapshot) {
  await apiPost("/api/admin-review/reject", {
    bvid: snapshot.bvid,
    record: snapshot.fields,
    rejected_by: selectedRequesterName() || developerModeRequesterName,
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
  });
  const reviewCacheExhausted = removePendingReviewItem(snapshot.bvid);
  if (reviewCacheExhausted) {
    await loadPendingReviewItems({ force: true });
  }
  setAppMessage(`已拒绝 ${snapshot.bvid} 并加入黑名单。`);
}

async function restoreDeveloperBlacklistEntry(snapshot, restoreVideo) {
  await restoreBlacklistItem(snapshot.bvid, restoreVideo);
  const nextOffset = state.blacklistItems.length <= 1 && state.blacklistOffset > 0
    ? Math.max(0, state.blacklistOffset - state.blacklistLimit)
    : state.blacklistOffset;
  await loadBlacklistItems({ force: true, offset: nextOffset });
  state.blacklistMessage = t(restoreVideo ? "search.blacklistRestored" : "search.blacklistReleased", {
    bvid: snapshot.bvid,
  });
  renderBlacklistView();
}

async function deleteDeveloperD1EntriesByMid(snapshot) {
  const mid = String(snapshot.fields?.mid || "").trim();
  if (!mid) {
    throw new Error("缺少 MID，无法按 MID 删除。");
  }
  const result = await apiPost("/api/admin-video/delete-mid", {
    mid,
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
  });
  if (Array.isArray(state.pendingReviewItems) && mid) {
    const previousCount = state.pendingReviewItems.length;
    state.pendingReviewItems = state.pendingReviewItems.filter((item) => String(item?.mid || "").trim() !== mid);
    const removedCount = previousCount - state.pendingReviewItems.length;
    state.pendingReviewTotal = Math.max(0, Number(state.pendingReviewTotal || 0) - removedCount);
    if (removedCount && state.pendingReviewItems.length === 0) {
      state.pendingReviewLoaded = false;
      await loadPendingReviewItems({ force: true });
    }
    if (elements.catalogAdvancedContent?.querySelector("[data-pending-review-view]")) {
      renderPendingReviewView();
    }
  }
  const deleted = Number(result?.deleted_count ?? result?.changed ?? 0);
  setAppMessage(`已按 MID ${mid} 删除 ${deleted} 条 D1 条目。`);
}

async function resetDeveloperTagFields(snapshot) {
  await apiPost("/api/admin-tags/reset", {
    bvid: snapshot.bvid,
    BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
  });
  setAppMessage(`已重置 ${snapshot.bvid} 的标签字段。`);
}

async function confirmDeveloperAction() {
  if (state.developerTagResetSaving) {
    return;
  }
  const snapshot = state.developerTagResetItem;
  const action = state.developerTagResetAction || "reset-tags";
  if (!state.developerMode || !state.bilikaraSecret || !snapshot?.bvid) {
    closeDeveloperTagResetModal();
    return;
  }
  state.developerTagResetSaving = true;
  if (elements.developerTagResetConfirm) {
    elements.developerTagResetConfirm.disabled = true;
  }
  if (elements.developerTagResetDeleteMid) {
    elements.developerTagResetDeleteMid.disabled = true;
  }
  try {
    if (action === "delete-entry") {
      await deleteDeveloperD1Entry(snapshot);
    } else if (action === "reject-entry") {
      await rejectPendingReviewEntry(snapshot);
    } else if (action === "blacklist-release" || action === "blacklist-release-restore") {
      await restoreDeveloperBlacklistEntry(snapshot, action === "blacklist-release-restore");
    } else {
      await resetDeveloperTagFields(snapshot);
    }
    state.developerTagResetSaving = false;
    closeDeveloperTagResetModal();
  } catch (error) {
    const fallbackMessage = action === "delete-entry"
      ? "删除失败。"
      : action === "reject-entry"
        ? "加入黑名单失败。"
        : action === "blacklist-release" || action === "blacklist-release-restore"
          ? "解除黑名单失败。"
          : "重置失败。";
    setAppMessage(error?.message || fallbackMessage, true);
  } finally {
    state.developerTagResetSaving = false;
    if (elements.developerTagResetConfirm) {
      elements.developerTagResetConfirm.disabled = false;
    }
    if (elements.developerTagResetDeleteMid) {
      elements.developerTagResetDeleteMid.disabled = false;
    }
  }
}

function hideSearchResults() {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.add("hidden");
}

function searchResultOwnerName(item) {
  return String(item?.owner_name || item?.author || "").trim();
}

function firstSearchResultValue(item, keys) {
  for (const key of keys) {
    const value = String(item?.[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function searchResultBvid(item) {
  const direct = String(item?.bvid || "").trim();
  if (direct) {
    return direct;
  }
  const source = String(item?.url || item?.resolved_url || item?.original_url || "").trim();
  const match = source.match(/BV[0-9A-Za-z]{10}/);
  return match ? match[0] : "";
}

function developerTagResetSnapshot(item) {
  const snapshot = {
    bvid: searchResultBvid(item),
    title: String(item?.title || "").trim(),
    fields: {},
  };
  developerTagResetFieldKeys.forEach((key) => {
    snapshot.fields[key] = String(item?.[key] ?? "").trim();
  });
  return snapshot;
}

async function confirmDeveloperDeleteMid() {
  if (state.developerTagResetSaving) {
    return;
  }
  const snapshot = state.developerTagResetItem;
  if (!state.developerMode || !state.bilikaraSecret || !snapshot?.fields?.mid) {
    closeDeveloperTagResetModal();
    return;
  }
  state.developerTagResetSaving = true;
  if (elements.developerTagResetConfirm) {
    elements.developerTagResetConfirm.disabled = true;
  }
  if (elements.developerTagResetDeleteMid) {
    elements.developerTagResetDeleteMid.disabled = true;
  }
  try {
    await deleteDeveloperD1EntriesByMid(snapshot);
    state.developerTagResetSaving = false;
    closeDeveloperTagResetModal();
  } catch (error) {
    setAppMessage(error?.message || "按 MID 删除失败。", true);
  } finally {
    state.developerTagResetSaving = false;
    if (elements.developerTagResetConfirm) {
      elements.developerTagResetConfirm.disabled = false;
    }
    if (elements.developerTagResetDeleteMid) {
      elements.developerTagResetDeleteMid.disabled = false;
    }
  }
}

function developerFieldValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

function developerDeleteSnapshot(item) {
  const snapshot = {
    bvid: searchResultBvid(item),
    title: String(item?.title || "").trim(),
    fields: {},
  };
  if (snapshot.bvid) {
    snapshot.fields.bvid = snapshot.bvid;
  }
  const itemKeys = Object.keys(item || {});
  const orderedKeys = [
    ...developerDeletePreferredFieldKeys,
    ...itemKeys.filter((key) => !developerDeletePreferredFieldKeys.includes(key)).sort(),
  ];
  orderedKeys.forEach((key) => {
    if (key === "bvid" && snapshot.fields.bvid) {
      return;
    }
    if (key in (item || {})) {
      snapshot.fields[key] = developerFieldValue(item[key]);
    }
  });
  return snapshot;
}

function createDeveloperTagResetButton(item) {
  const snapshot = developerTagResetSnapshot(item);
  if (!snapshot.bvid) {
    return null;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toolbar-button developer-reset-tag-button";
  button.dataset.devAction = "reset-tags";
  button.dataset.item = JSON.stringify(snapshot);
  button.textContent = "重置";
  button.title = "重置标签字段";
  return button;
}

function createDeveloperDeleteButton(item) {
  const snapshot = developerDeleteSnapshot(item);
  if (!snapshot.bvid) {
    return null;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toolbar-button developer-delete-entry-button";
  button.dataset.devAction = "delete-entry";
  button.dataset.item = JSON.stringify(snapshot);
  button.textContent = "删除";
  button.title = "删除 D1 条目";
  return button;
}

function searchResultCoverUrl(item) {
  const coverUrl = firstSearchResultValue(item, ["cover_url", "cover", "pic", "pic_url", "thumbnail"]);
  return window.BilikaraSongDetail?.normalizeBilibiliImageUrl?.(coverUrl) || coverUrl;
}

function formatCompactCount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    return raw;
  }
  if (numeric >= 100000000) {
    return `${Number((numeric / 100000000).toFixed(numeric >= 1000000000 ? 0 : 1))}亿`;
  }
  if (numeric >= 10000) {
    return `${Number((numeric / 10000).toFixed(numeric >= 100000 ? 0 : 1))}万`;
  }
  return String(Math.round(numeric));
}

function formatSearchDuration(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  if (raw.includes(":")) {
    return raw;
  }
  const totalSeconds = Number(raw);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return raw;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

function searchResultRatingValue(item) {
  const raw = firstSearchResultValue(item, ["rank", "rating", "score"]);
  const value = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(0, Math.min(5, value));
}

function formatSearchRating(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return Number(value.toFixed(1)).toString();
}

function searchResultRatingText(item) {
  const rating = searchResultRatingValue(item);
  return rating == null ? t("search.ratingNone") : t("search.ratingValue", { rating: formatSearchRating(rating) });
}

function createSearchResultRatingStars(item) {
  const rating = searchResultRatingValue(item);
  if (rating == null) {
    return null;
  }
  const stars = document.createElement("span");
  stars.className = "search-result-rating-stars";
  stars.setAttribute("aria-label", searchResultRatingText(item));
  stars.style.setProperty("--rating-width", `${(rating / 5) * 100}%`);
  stars.innerHTML = `<span class="search-result-rating-stars-base">★★★★★</span><span class="search-result-rating-stars-fill">★★★★★</span>`;
  return stars;
}

function searchResultStatusLabel(item) {
  const localSource = String(item?.local_source || "").trim();
  if (localSource === "favlist") {
    return t("search.favorited");
  }
  if (localSource === "follow") {
    return t("search.followed");
  }

  const source = String(item?.source || "").trim();
  if (source === "bilikara" || source === "cloudflare") {
    return "";
  }
  if (source === "favlist") {
    return t("search.favorited");
  }
  if (String(item?.mid || item?.fav_uid || "").trim()) {
    return t("search.followed");
  }
  return "";
}

function createSearchResultUrlLine(item) {
  const line = document.createElement("div");
  line.className = "search-result-url";

  const bvid = document.createElement("span");
  bvid.className = "search-result-bvid";
  bvid.textContent = String(item?.bvid || item?.url || "");

  const ownerName = searchResultOwnerName(item);
  if (ownerName) {
    const owner = document.createElement("span");
    owner.className = "search-result-owner owner-badge-label";
    renderOwnerBadgeLabel(owner, ownerName);
    line.appendChild(owner);
  }
  const rating = document.createElement("span");
  rating.className = "search-result-rating-text";
  rating.textContent = searchResultRatingText(item);
  line.appendChild(rating);
  line.appendChild(bvid);

  return line;
}

function requestResultItemKey(item) {
  return String(
    item?.bvid
      || item?.url
      || item?.id
      || `${item?.title || ""}\n${searchResultOwnerName(item)}`,
  ).trim();
}

function requestDetailOriginForContainer(container, source = "") {
  if (!container) {
    return null;
  }
  if (container === elements.larkSearchResults || container.closest?.("#request-search-shared")) {
    return { key: "shared", subview: "search", mode: "shared", source: source || "lark" };
  }
  if (container === elements.searchResults || container.closest?.("#request-search-local")) {
    return { key: "local", subview: "search", mode: "local", source: source || "search" };
  }
  if (container === elements.followSongResults || container.closest?.("#request-sources-uids")) {
    return { key: "uids", subview: "sources", mode: "uids", source: source || "modalFollow" };
  }
  if (container === elements.favlistSongResults || container.closest?.("#request-sources-favorites")) {
    return { key: "favorites", subview: "sources", mode: "favorites", source: source || "modalFavlist" };
  }
  if (container === elements.discoverCategoriesPanel || container.closest?.("#request-discover-categories")) {
    return { key: "categories", subview: "discover", mode: "categories", source: source || "discover" };
  }
  if (container === elements.discoverNamePanel || container.closest?.("#request-discover-name")) {
    return { key: "name", subview: "discover", mode: "name", source: source || "discover" };
  }
  if (container === elements.discoverArtistPanel || container.closest?.("#request-discover-artist")) {
    return { key: "artist", subview: "discover", mode: "artist", source: source || "discover" };
  }
  if (container === elements.requestDiscoverPanel || container.closest?.("#request-discover-panel")) {
    const mode = normalizeDiscoverMode(state.discoverMode);
    return { key: mode, subview: "discover", mode, source: source || "discover" };
  }
  return null;
}

function applyRequestResultSelection(row, item, origin) {
  if (!row || !origin?.key) {
    return;
  }
  const itemKey = requestResultItemKey(item);
  row.dataset.requestResultOrigin = origin.key;
  row.dataset.requestResultKey = itemKey;
  const selected = state.requestDetailSelections?.[origin.key];
  const isSelected = Boolean(itemKey && selected?.selectedKey === itemKey);
  row.classList.toggle("is-selected", isSelected);
  row.setAttribute("aria-current", isSelected ? "true" : "false");
}

function requestResultContainerForOrigin(originKey) {
  const containers = {
    shared: elements.larkSearchResults,
    local: elements.searchResults,
    categories: elements.discoverCategoriesPanel?.querySelector?.("[data-category-browse-results]"),
    name: elements.discoverNamePanel?.querySelector?.("[data-d1-browse-results]"),
    artist: elements.discoverArtistPanel?.querySelector?.("[data-d1-browse-results]"),
    uids: elements.followSongResults,
    favorites: elements.favlistSongResults,
  };
  return containers[originKey] || null;
}

function requestModeControlForOrigin(originKey) {
  if (["shared", "local"].includes(originKey)) {
    return Array.from(elements.searchModeButtons || [])
      .find((button) => button.dataset.searchMode === originKey) || null;
  }
  if (["categories", "name", "artist"].includes(originKey)) {
    return Array.from(elements.discoverModeButtons || [])
      .find((button) => button.dataset.discoverMode === originKey) || null;
  }
  return Array.from(elements.sourcesModeButtons || [])
    .find((button) => button.dataset.sourcesMode === originKey) || null;
}

function resolveRequestDetailReturnFocus(_previouslyFocused, item) {
  const originKey = String(item?.detailOrigin?.key || "");
  const selectedKey = String(item?.detailSelectedKey || "");
  const container = requestResultContainerForOrigin(originKey);
  const recoveredRow = Array.from(container?.querySelectorAll?.(".search-result-item") || [])
    .find((row) => row.dataset.requestResultKey === selectedKey);
  if (recoveredRow?.isConnected) {
    return recoveredRow;
  }
  if (container?.isConnected && !container.closest?.("[inert]")) {
    if (container.tabIndex < 0) {
      container.tabIndex = -1;
    }
    return container;
  }
  return requestModeControlForOrigin(originKey);
}

function createSearchResultItem(item, options = {}) {
  const row = document.createElement("article");
  row.className = "search-result-item";
  searchResultItemByElement.set(row, item);
  const itemUrl = String(item?.url || "").trim();
  const bvid = searchResultBvid(item);
  if (itemUrl) {
    row.dataset.url = itemUrl;
  }
  if (bvid) {
    row.dataset.bvid = bvid;
  }

  const coverUrl = searchResultCoverUrl(item);
  const cover = document.createElement("div");
  cover.className = "search-result-cover";
  if (coverUrl) {
    const image = document.createElement("img");
    image.src = coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    cover.appendChild(image);
  } else {
    const fallback = document.createElement("span");
    fallback.textContent = String(item?.bvid || "Bili");
    cover.appendChild(fallback);
    cover.classList.add("is-empty");
  }

  const duration = formatSearchDuration(firstSearchResultValue(item, ["preserved_1", "duration", "length"]));
  if (duration) {
    const durationNode = document.createElement("span");
    durationNode.className = "search-result-duration";
    durationNode.textContent = duration;
    cover.appendChild(durationNode);
  }
  const ratingStars = createSearchResultRatingStars(item);
  if (ratingStars) {
    cover.appendChild(ratingStars);
  }
  if (options.showDeveloperActions !== false) {
    const developerDeleteButton = createDeveloperDeleteButton(item);
    if (developerDeleteButton) {
      cover.appendChild(developerDeleteButton);
    }
    const developerResetButton = createDeveloperTagResetButton(item);
    if (developerResetButton) {
      cover.appendChild(developerResetButton);
    }
  }

  const body = document.createElement("div");
  body.className = "search-result-meta search-result-body";

  const title = document.createElement("div");
  title.className = "search-result-title";
  title.textContent = String(item.title || "");

  const statusLine = document.createElement("div");
  statusLine.className = "search-result-status";
  const statusLabel = searchResultStatusLabel(item);
  if (statusLabel) {
    const status = document.createElement("span");
    status.className = "search-result-follow";
    status.textContent = statusLabel;
    statusLine.appendChild(status);
  }
  const playCount = formatCompactCount(firstSearchResultValue(item, ["played_count", "play_count", "play", "view", "views"]));
  if (playCount) {
    const plays = document.createElement("span");
    plays.className = "search-result-plays";
    const playLabel = document.createElement("span");
    playLabel.className = "search-result-play-label";
    playLabel.textContent = t("search.playCountLabel");
    const playValue = document.createElement("span");
    playValue.textContent = playCount;
    plays.append(playLabel, playValue);
    statusLine.appendChild(plays);
  }

  const url = createSearchResultUrlLine(item);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "next-button search-result-add";
  button.dataset.url = itemUrl;
  button.textContent = t("search.add");

  body.append(title);
  if (statusLine.children.length) {
    body.appendChild(statusLine);
  }
  body.appendChild(url);
  row.append(cover, body);
  if (options.showPrimaryAction !== false) {
    row.appendChild(button);
  }
  applyRequestResultSelection(row, item, options.requestOrigin);
  return row;
}

function renderSearchResultItems(container, items, emptyText = t("search.empty")) {
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

  const requestOrigin = requestDetailOriginForContainer(container);
  items.forEach((item) => {
    const row = createSearchResultItem(item, { requestOrigin });
    container.appendChild(row);
  });
}

function appendSearchResultItems(container, items) {
  if (!container || !items.length) {
    return;
  }
  const existingEmpty = container.querySelector(".search-empty");
  if (existingEmpty) {
    existingEmpty.remove();
  }
  container.classList.remove("hidden");

  const requestOrigin = requestDetailOriginForContainer(container);
  items.forEach((item) => {
    const row = createSearchResultItem(item, { requestOrigin });
    container.appendChild(row);
  });
}

function renderSearchResults(items) {
  renderSearchResultItems(elements.searchResults, items);
}

function d1BrowseTitle(kind = state.d1BrowseKind) {
  return kind === "artist" ? t("search.artistBrowse") : t("search.nameBrowse");
}

function d1BrowsePickLetterText(kind = state.d1BrowseKind) {
  return kind === "artist" ? t("search.browsePickArtistLetter") : t("search.browsePickLetter");
}

function d1BrowseSearchPlaceholder(kind = state.d1BrowseKind) {
  return state.d1BrowseLevel === "items"
    ? t("search.browseItemPlaceholder")
    : t("search.tagBrowsePlaceholder", { title: d1BrowseTitle(kind) });
}

const D1_BROWSE_ITEM_LIMIT = 450;
const D1_BROWSE_TAG_LIMIT = 450;
const D1_BROWSE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");
const CATEGORY_BROWSE_PAGE_SIZE = 100;
const CATEGORY_BROWSE_DEFINITIONS = [
  { key: "hotBlood", tags: ["热血", "战斗"] },
  { key: "fantasy", tags: ["奇幻", "冒险", "魔法", "科幻"] },
  { key: "yuri", tags: ["百合"] },
  { key: "vtuberSeries", tags: ["vtuber系列", "Hololive", "Vtuber"] },
  { key: "idol", tags: ["偶像", "bangdream", "Lovelive系列", "偶像大师系列","SHOW BY ROCK!!","ガールズバンドクライ","22/7","Togenashi Togeari"] },
  { key: "school", tags: ["校园", "学园","社团"] },
  { key: "healing", tags: ["治愈", "催泪", "致郁"] },
  { key: "vocaloid", tags: ["V家", "VOCALOID","DECO*27","Giga"] },
  { key: "workplace", tags: ["职场"] },
  { key: "detective", tags: ["推理","名探偵コナン","智斗"] },
  { key: "mecha", tags: ["机战", "高达系列"] },
  { key: "sliceOfLife", tags: ["日常"] },
  { key: "moe", tags: ["萌系"] },
  { key: "sports", tags: ["运动"] },
  { key: "original", tags: ["原创"] },
  { key: "mangaAdapted", tags: ["漫画改", "漫改", "动漫改"] },
  { key: "gameAdapted", tags: ["游戏改", "Galgame", "GALGAME","鳴潮","ウマ娘","Key社","MAGES","Leaf","柚子社","August","游戏","ヘブンバーンズレッド","原神"] },
  { key: "novelAdapted", tags: ["小说改", "轻改","轻小说改"] },
  { key: "pjsk", tags: ["pjsk","プロジェクトセカイ"] },
  { key: "symphogear", tags: ["战姬绝唱","戦姫絶唱シンフォギア"] },
  { key: "pokemonSeries", tags: ["宝可梦系列"] },
  { key: "childhood", tags: ["童年", "宝可梦系列"] },
  { key: "bangDream", tags: ["bangdream","BanG Dream!","バンドリ！"] },
  { key: "loveLive", tags: ["Lovelive系列","ラブライブ!"] },
  { key: "idolmaster", tags: ["偶像大师系列","アイドルマスター"] },
  { key: "isekai", tags: ["异世界", "穿越"] },
  { key: "kamitsubaki", tags: ["神椿", "KAMITSUBAKI", "神椿工作室", "KAMITSUBAKI STUDIO","V.W.P","ヰ世界情緒","Albemuth","花譜"] },
  { key: "youth", tags: ["青春","WHITE ALBUM2","HoneyWorks","励志"] },
  { key: "otome", tags: ["乙女", "逆后宫"] },
  { key: "kids", tags: ["子供向"] },
  { key: "comedy", tags: ["搞笑", "喜剧"] },
  { key: "tokusatsu", tags: ["特摄"] },
  { key: "dark", tags: ["黑暗", "悬疑", "战争", "心理", "恐怖", "犯罪","扭曲"] },
  { key: "godsDemons", tags: ["神魔"] },
  { key: "workplace", tags: ["职场"] },
  { key: "gourmet", tags: ["美食"] },
  { key: "history", tags: ["历史","架空"] },
  { key: "touhouProject", tags: ["东方project"] },
  { key: "macross", tags: ["マクロス", "超时空要塞"] },
  { key: "gundam", tags: ["高达系列"] },
  { key: "longRunning", tags: ["名探偵コナン","NARUTO","ナルト","BLEACH","ONE PIECE","火影忍者","海贼王","銀魂","银魂","家庭教師ヒットマンREBORN!","家庭教师","鬼滅の刃","鬼灭之刃","呪術廻戦","咒术回战","ジョジョの奇妙な冒険","ドラゴンボール","聖闘士星矢","幽☆遊☆白書","THE FIRST SLAM DUNK","FAIRY TAIL"] },
];
const CATEGORY_BROWSE_FULL_FIELD_TAGS = new Set([
  "Hololive",
  "Vtuber",
  "SHOW BY ROCK!!",
  "ガールズバンドクライ",
  "22/7",
  "Togenashi Togeari",
  "VOCALOID",
  "DECO*27",
  "Giga",
  "名探偵コナン",
  "Galgame",
  "GALGAME",
  "鳴潮",
  "ウマ娘",
  "Key社",
  "MAGES",
  "Leaf",
  "柚子社",
  "August",
  "游戏",
  "ヘブンバーンズレッド",
  "原神",
  "プロジェクトセカイ",
  "戦姫絶唱シンフォギア",
  "BanG Dream!",
  "バンドリ！",
  "ラブライブ!",
  "アイドルマスター",
  "KAMITSUBAKI",
  "神椿工作室",
  "KAMITSUBAKI STUDIO",
  "V.W.P",
  "ヰ世界情緒",
  "Albemuth",
  "花譜",
  "WHITE ALBUM2",
  "HoneyWorks",
  "超时空要塞",
  "东方project",
  "マクロス",
  "NARUTO",
  "ナルト",
  "BLEACH",
  "ONE PIECE",
  "火影忍者",
  "海贼王",
  "銀魂",
  "银魂",
  "家庭教師ヒットマンREBORN!",
  "家庭教师",
  "鬼滅の刃",
  "鬼灭之刃",
  "呪術廻戦",
  "咒术回战",
  "ジョジョの奇妙な冒険",
  "ドラゴンボール",
  "聖闘士星矢",
  "幽☆遊☆白書",
  "THE FIRST SLAM DUNK",
  "FAIRY TAIL",
].map(categoryBrowseTagKey));
const CATEGORY_BROWSE_IMAGE_URLS = [
  "/pic/cat_1.png",
  "/pic/cat_2.png",
  "/pic/cat_3.png",
  "/pic/cat_4.png",
  "/pic/cat_5.png",
  "/pic/cat_6.png",
  "/pic/cat_7.jpg",
  "/pic/cat_8.jpg",
  "/pic/cat_9.png",
  "/pic/cat_10.jpg",
  "/pic/cat_11.jpg",
  "/pic/cat_12.jpg",
  "/pic/cat_13.jpg",
  "/pic/cat_14.png",
  "/pic/cat_15.png",
  "/pic/cat_16.jpg",
  "/pic/cat_17.jpg",
  "/pic/cat_18.jpg",
  "/pic/cat_19.jpg",
  "/pic/cat_20.jpg",
  "/pic/cat_21.png",
  "/pic/cat_22.jpg",
  "/pic/cat_23.jpg",
  "/pic/cat_24.jpg",
  "/pic/cat_25.png",
  "/pic/cat_26.png",
  "/pic/cat_27.jpg",
  "/pic/cat_28.jpg",
  "/pic/cat_29.png",
  "/pic/cat_30.jpg",
  "/pic/cat_31.jpg",
  "/pic/cat_32.jpg",
  "/pic/cat_33.jpg",
  "/pic/cat_34.jpg",
  "/pic/cat_35.jpg",
  "/pic/cat_36.jpg",
  "/pic/cat_37.jpg",
  "/pic/cat_38.jpg",
  "/pic/cat_39.webp",
  "/pic/cat_40.png",
];

function categoryBrowseTagKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function categoryBrowseUsesFullFieldSearch(tag) {
  return CATEGORY_BROWSE_FULL_FIELD_TAGS.has(categoryBrowseTagKey(tag));
}

function d1BrowseItemKey(item) {
  return String(item?.bvid || item?.url || item?.id || `${item?.title || ""}\n${searchResultOwnerName(item)}`).trim();
}

function d1BrowseModeState(kind = state.d1BrowseKind || state.discoverMode) {
  const normalized = kind === "artist" ? "artist" : "name";
  state.d1BrowseModes[normalized] ||= {
    level: "alphabet", letter: "", tag: "", locale: "", query: "", data: null,
    tagData: null, itemData: null, loading: false, seq: 0, error: "",
    scrollPositions: { alphabet: 0, tags: 0, items: 0 },
  };
  const mode = state.d1BrowseModes[normalized];
  mode.level = normalizedD1BrowseLevel(mode.level);
  mode.scrollPositions ||= { alphabet: 0, tags: 0, items: 0 };
  mode.tagData ??= mode.level === "tags" ? mode.data : null;
  mode.itemData ??= mode.level === "items" ? mode.data : null;
  return mode;
}

function rememberD1BrowseMode(kind = state.d1BrowseKind) {
  if (!kind) {
    return;
  }
  const mode = d1BrowseModeState(kind);
  mode.level = normalizedD1BrowseLevel(state.d1BrowseLevel);
  mode.letter = state.d1BrowseLetter;
  mode.tag = state.d1BrowseTag;
  mode.locale = state.d1BrowseLocale;
  mode.query = state.d1BrowseQuery;
  mode.data = state.d1BrowseData;
  mode.loading = state.d1BrowseLoading;
  mode.seq = state.d1BrowseSeq;
  mode.error = state.d1BrowseError;
}

function restoreD1BrowseMode(kind) {
  const normalized = kind === "artist" ? "artist" : "name";
  const mode = d1BrowseModeState(normalized);
  state.d1BrowseKind = normalized;
  state.d1BrowseLevel = normalizedD1BrowseLevel(mode.level);
  state.d1BrowseLetter = mode.letter;
  state.d1BrowseTag = mode.tag;
  state.d1BrowseLocale = mode.locale;
  state.d1BrowseQuery = mode.query;
  state.d1BrowseData = mode.data;
  state.d1BrowseLoading = mode.loading;
  state.d1BrowseSeq = mode.seq;
  state.d1BrowseError = mode.error;
}

function categoryBrowseIdForName(name) {
  return encodeURIComponent(String(name || "").trim()).replace(/%/g, "_");
}

function categoryBrowseDefinitions() {
  const groups = [];
  const byKey = new Map();
  CATEGORY_BROWSE_DEFINITIONS.forEach((definition) => {
    const key = String(definition?.key || "").trim();
    const tags = (Array.isArray(definition?.tags) ? definition.tags : []).map((value) => String(value || "").trim()).filter(Boolean);
    if (!key || !tags.length) {
      return;
    }
    let group = byKey.get(key);
    if (!group) {
      const imageIndex = groups.length;
      group = {
        id: categoryBrowseIdForName(key),
        key,
        name: t(`search.category.${key}`),
        coverUrl: CATEGORY_BROWSE_IMAGE_URLS[imageIndex] || "",
        tags: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    tags.forEach((tag) => {
      if (!group.tags.includes(tag)) {
        group.tags.push(tag);
      }
    });
  });
  return groups;
}

function selectedCategoryBrowseDefinition() {
  const selectedId = String(state.categoryBrowseSelectedId || "");
  return categoryBrowseDefinitions().find((entry) => entry.id === selectedId) || null;
}

function mergeCategoryBrowseItems(existingItems, nextItems) {
  const seen = new Set();
  const items = [];
  [...(Array.isArray(existingItems) ? existingItems : []), ...(Array.isArray(nextItems) ? nextItems : [])].forEach((item) => {
    const key = d1BrowseItemKey(item);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    items.push(item);
  });
  return items;
}

function ensureD1BrowseView() {
  const container = state.d1BrowseKind === "artist"
    ? elements.discoverArtistPanel
    : elements.discoverNamePanel;
  if (!container) {
    return null;
  }
  let view = container.querySelector("[data-d1-browse-view]");
  if (view) {
    return view;
  }
  container.textContent = "";
  view = document.createElement("div");
  view.className = "tag-browser";
  view.dataset.d1BrowseView = "1";
  view.innerHTML = `
    <form class="tag-browser-search" data-d1-browse-search>
      <input type="text" autocomplete="off" data-d1-browse-query>
      <button type="submit" class="next-button" data-d1-browse-submit></button>
    </form>
    <div class="tag-browser-alphabet" data-d1-browse-alphabet></div>
    <div class="tag-browser-nav">
      <button type="button" class="tag-browser-back hidden" data-d1-browse-back></button>
      <div class="tag-browser-current" data-d1-browse-current></div>
    </div>
    <div class="tag-browser-tags" data-d1-browse-tags></div>
    <div class="search-results hidden" data-d1-browse-results></div>
    <p class="gatcha-message tag-browser-message" data-d1-browse-message role="status"></p>
  `;
  container.appendChild(view);
  return view;
}

function renderD1BrowseView() {
  const view = ensureD1BrowseView();
  if (!view) {
    return;
  }
  const kind = state.d1BrowseKind || "name";
  const mode = d1BrowseModeState(kind);
  const level = normalizedD1BrowseLevel(mode.level);
  state.d1BrowseLevel = level;
  const title = d1BrowseTitle(kind);
  const queryInput = view.querySelector("[data-d1-browse-query]");
  const submitButton = view.querySelector("[data-d1-browse-submit]");
  const alphabet = view.querySelector("[data-d1-browse-alphabet]");
  const backButton = view.querySelector("[data-d1-browse-back]");
  const current = view.querySelector("[data-d1-browse-current]");
  const tagGrid = view.querySelector("[data-d1-browse-tags]");
  const results = view.querySelector("[data-d1-browse-results]");
  const message = view.querySelector("[data-d1-browse-message]");

  if (queryInput && document.activeElement !== queryInput) {
    queryInput.value = state.d1BrowseQuery || "";
  }
  if (queryInput) {
    queryInput.placeholder = d1BrowseSearchPlaceholder(kind);
  }
  if (submitButton) {
    submitButton.textContent = t("search.submit");
    submitButton.disabled = state.d1BrowseLoading;
    submitButton.toggleAttribute("aria-busy", state.d1BrowseLoading);
  }
  if (alphabet) {
    alphabet.innerHTML = "";
    D1_BROWSE_LETTERS.forEach((letter) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tag-letter-button";
      button.dataset.letter = letter;
      button.textContent = letter;
      button.classList.toggle("active", state.d1BrowseLetter === letter);
      button.disabled = state.d1BrowseLoading;
      alphabet.appendChild(button);
    });
  }
  if (backButton) {
    backButton.textContent = t("common.back");
    backButton.classList.toggle("hidden", level === "alphabet");
    backButton.disabled = false;
  }

  const tags = Array.isArray(mode.tagData?.tags) ? mode.tagData.tags : [];
  const items = Array.isArray(mode.itemData?.items) ? mode.itemData.items : [];
  if (current) {
    const parts = [title];
    if (level !== "alphabet" && state.d1BrowseLetter) {
      parts.push(state.d1BrowseLetter);
    }
    if (level === "items" && state.d1BrowseTag) {
      parts.push(state.d1BrowseTag);
    }
    current.textContent = parts.join(" / ");
  }
  if (tagGrid) {
    tagGrid.innerHTML = "";
    tagGrid.classList.toggle("hidden", level === "items");
    if (level !== "items") {
      if (state.d1BrowseLoading) {
        const loading = document.createElement("div");
        loading.className = "search-empty";
        loading.textContent = t("search.browseLoading");
        tagGrid.appendChild(loading);
      } else if (level === "alphabet") {
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = d1BrowsePickLetterText(kind);
        tagGrid.appendChild(empty);
      } else if (!tags.length) {
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = t("search.browseNoTags");
        tagGrid.appendChild(empty);
      } else {
        tags.forEach((entry) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "tag-browser-tag";
          button.dataset.tag = String(entry.tag || "");
          button.dataset.locale = String(entry.locale || "");
          const name = document.createElement("span");
          name.className = "tag-browser-tag-name";
          name.textContent = String(entry.tag || "");
          const count = document.createElement("span");
          count.className = "tag-browser-tag-count";
          count.textContent = t("search.browseTagCount", { count: Number(entry.count || 0) });
          button.append(name, count);
          tagGrid.appendChild(button);
        });
      }
    }
  }
  if (results) {
    if (level === "items") {
      renderSearchResultItems(results, items, t("search.larkNoResults"));
    } else {
      results.innerHTML = "";
      results.classList.add("hidden");
    }
  }
  if (message) {
    let text = "";
    if (level === "items" && !state.d1BrowseLoading) {
      text = items.length ? t("search.larkFound", { count: items.length }) : t("search.larkNoResults");
    } else if (level === "tags" && tags.length) {
      text = t("search.browseTagsFound", { count: tags.length });
    }
    message.textContent = state.d1BrowseError
      || (state.d1BrowseLoading ? t("search.browseLoading") : text);
    message.classList.toggle("is-error", Boolean(state.d1BrowseError));
  }
}

async function loadD1Browse({ kind = state.d1BrowseKind || "name", letter = state.d1BrowseLetter, query = state.d1BrowseQuery, tag = "", locale = "" } = {}) {
  const normalizedKind = kind === "artist" ? "artist" : "name";
  const normalizedLetter = String(letter || "").trim().toUpperCase();
  const normalizedQuery = String(query || "").trim();
  const normalizedTag = String(tag || "").trim();
  const normalizedLocale = String(locale || "").trim();
  const targetLevel = normalizedTag ? "items" : "tags";
  const isolatedMode = typeof d1BrowseModeState === "function"
    ? d1BrowseModeState(normalizedKind)
    : null;
  const searchSeq = (isolatedMode?.seq ?? state.d1BrowseSeq) + 1;
  if (isolatedMode) {
    isolatedMode.level = targetLevel;
    isolatedMode.letter = normalizedLetter;
    isolatedMode.query = normalizedQuery;
    isolatedMode.tag = normalizedTag;
    isolatedMode.locale = normalizedLocale;
    isolatedMode.loading = true;
    isolatedMode.error = "";
    isolatedMode.seq = searchSeq;
    isolatedMode.scrollPositions[targetLevel] = 0;
  }
  state.d1BrowseKind = normalizedKind;
  state.d1BrowseLevel = targetLevel;
  state.d1BrowseLetter = normalizedLetter;
  state.d1BrowseQuery = normalizedQuery;
  state.d1BrowseTag = normalizedTag;
  state.d1BrowseLocale = normalizedLocale;
  state.d1BrowseLoading = true;
  state.d1BrowseError = "";
  state.d1BrowseSeq = searchSeq;
  renderD1BrowseView();
  if (state.discoverMode === normalizedKind && typeof restoreRequestScrollPosition === "function") {
    restoreRequestScrollPosition();
  }
  try {
    const data = await fetchD1Browse({
      kind: normalizedKind,
      letter: normalizedLetter,
      query: normalizedQuery,
      tag: normalizedTag,
      locale: normalizedLocale,
      limit: normalizedTag ? D1_BROWSE_ITEM_LIMIT : D1_BROWSE_TAG_LIMIT,
    });
    if ((isolatedMode?.seq ?? state.d1BrowseSeq) !== searchSeq) {
      return;
    }
    if (isolatedMode) {
      if (targetLevel === "items") {
        isolatedMode.itemData = data || {};
      } else {
        isolatedMode.tagData = data || {};
      }
      isolatedMode.data = data || {};
    }
    if (!isolatedMode || state.d1BrowseKind === normalizedKind) {
      state.d1BrowseData = data || {};
    }
  } catch (error) {
    if ((isolatedMode?.seq ?? state.d1BrowseSeq) === searchSeq) {
      if (isolatedMode) {
        isolatedMode.error = error.message;
      }
      if (!isolatedMode || state.d1BrowseKind === normalizedKind) {
        state.d1BrowseError = error.message;
      }
    }
  } finally {
    if ((isolatedMode?.seq ?? state.d1BrowseSeq) === searchSeq) {
      if (isolatedMode) {
        isolatedMode.loading = false;
      }
      if (!isolatedMode || state.d1BrowseKind === normalizedKind) {
        state.d1BrowseLoading = false;
        if (isolatedMode) {
          state.d1BrowseLevel = normalizedD1BrowseLevel(isolatedMode.level);
          state.d1BrowseData = targetLevel === "items"
            ? isolatedMode.itemData
            : isolatedMode.tagData;
          state.d1BrowseError = isolatedMode.error;
        }
        renderD1BrowseView();
        if (typeof restoreRequestScrollPosition === "function") {
          restoreRequestScrollPosition();
        }
      }
    }
  }
}

function ensurePendingReviewView() {
  if (!elements.catalogAdvancedContent) {
    return null;
  }
  let view = elements.catalogAdvancedContent.querySelector("[data-pending-review-view]");
  if (view) {
    return view;
  }
  elements.catalogAdvancedContent.textContent = "";
  view = document.createElement("div");
  view.className = "pending-review-browser";
  view.dataset.pendingReviewView = "1";
  view.innerHTML = `
    <div class="pending-review-head">
      <div class="pending-review-title-block">
        <p class="section-tag" data-pending-review-eyebrow></p>
        <h2 data-pending-review-title></h2>
      </div>
      <button type="button" class="toolbar-button" data-pending-review-refresh></button>
    </div>
    <div class="search-results pending-review-results hidden" data-pending-review-results></div>
    <p class="gatcha-message pending-review-message" data-pending-review-message role="status"></p>
    <div class="pending-review-actions">
      <button type="button" class="next-button" data-pending-review-approve></button>
    </div>
  `;
  elements.catalogAdvancedContent.appendChild(view);
  return view;
}

function renderPendingReviewView() {
  const view = ensurePendingReviewView();
  if (!view) {
    return;
  }
  const eyebrow = view.querySelector("[data-pending-review-eyebrow]");
  const title = view.querySelector("[data-pending-review-title]");
  const refreshButton = view.querySelector("[data-pending-review-refresh]");
  const results = view.querySelector("[data-pending-review-results]");
  const message = view.querySelector("[data-pending-review-message]");
  const approveButton = view.querySelector("[data-pending-review-approve]");
  const items = Array.isArray(state.pendingReviewItems) ? state.pendingReviewItems : [];

  if (eyebrow) {
    eyebrow.textContent = "D1 REVIEW";
  }
  if (title) {
    title.textContent = t("search.reviewPending");
  }
  if (refreshButton) {
    refreshButton.textContent = t("search.reviewRefresh");
    refreshButton.disabled = state.pendingReviewLoading || state.pendingReviewApproving;
  }
  if (results) {
    renderSearchResultItems(
      results,
      items,
      state.pendingReviewLoading ? t("search.reviewLoading") : t("search.reviewEmpty"),
    );
  }
  if (message) {
    let text = state.pendingReviewMessage || "";
    if (state.pendingReviewError) {
      text = state.pendingReviewError;
    } else if (state.pendingReviewLoading) {
      text = t("search.reviewLoading");
    } else if (!text && items.length) {
      text = t("search.reviewFound", {
        count: items.length,
        total: state.pendingReviewTotal,
        exportCount: state.pendingReviewExportCount,
      });
    }
    message.textContent = text;
    message.classList.toggle("is-error", Boolean(state.pendingReviewError));
  }
  if (approveButton) {
    approveButton.textContent = state.pendingReviewApproving ? t("search.reviewApproving") : t("search.reviewApprove");
    approveButton.disabled = state.pendingReviewLoading || state.pendingReviewApproving || !items.length;
  }
}

async function loadPendingReviewItems({ force = false } = {}) {
  if (!state.developerMode || !state.bilikaraSecret) {
    state.pendingReviewItems = [];
    state.pendingReviewLoaded = false;
    state.pendingReviewMessage = "";
    state.pendingReviewError = t("search.reviewNeedDeveloper");
    renderPendingReviewView();
    return;
  }
  if (!force && (state.pendingReviewLoaded || state.pendingReviewLoading)) {
    renderPendingReviewView();
    return;
  }
  const reviewSeq = state.pendingReviewSeq + 1;
  state.pendingReviewSeq = reviewSeq;
  state.pendingReviewLoading = true;
  state.pendingReviewMessage = "";
  state.pendingReviewError = "";
  renderPendingReviewView();
  try {
    const payload = await fetchPendingReviewItems();
    if (state.pendingReviewSeq !== reviewSeq) {
      return;
    }
    state.pendingReviewItems = Array.isArray(payload?.items) ? payload.items : [];
    state.pendingReviewTotal = Number(payload?.total_pending || 0);
    state.pendingReviewExportCount = Number(payload?.export_count || 0);
    state.pendingReviewLoaded = true;
  } catch (error) {
    if (state.pendingReviewSeq === reviewSeq) {
      state.pendingReviewItems = [];
      state.pendingReviewLoaded = false;
      state.pendingReviewError = error?.message || t("error.requestFailed");
    }
  } finally {
    if (state.pendingReviewSeq === reviewSeq) {
      state.pendingReviewLoading = false;
      renderPendingReviewView();
    }
  }
}

function removePendingReviewItem(bvid) {
  const normalizedBvid = String(bvid || "").trim();
  if (!normalizedBvid || !Array.isArray(state.pendingReviewItems)) {
    return false;
  }
  const nextItems = state.pendingReviewItems.filter((item) => searchResultBvid(item) !== normalizedBvid);
  if (nextItems.length === state.pendingReviewItems.length) {
    return false;
  }
  state.pendingReviewItems = nextItems;
  state.pendingReviewTotal = Math.max(0, Number(state.pendingReviewTotal || 0) - 1);
  const exhausted = nextItems.length === 0;
  if (exhausted) {
    state.pendingReviewLoaded = false;
  }
  if (elements.catalogAdvancedContent?.querySelector("[data-pending-review-view]")) {
    renderPendingReviewView();
  }
  return exhausted;
}

async function approvePendingReviewVisibleItems() {
  if (state.pendingReviewLoading || state.pendingReviewApproving) {
    return;
  }
  const bvids = (Array.isArray(state.pendingReviewItems) ? state.pendingReviewItems : [])
    .map((item) => searchResultBvid(item))
    .filter(Boolean);
  if (!bvids.length) {
    return;
  }
  state.pendingReviewApproving = true;
  state.pendingReviewMessage = "";
  state.pendingReviewError = "";
  renderPendingReviewView();
  try {
    const payload = await approvePendingReviewItems(bvids);
    state.pendingReviewItems = Array.isArray(payload?.items) ? payload.items : [];
    state.pendingReviewTotal = Number(payload?.total_pending || 0);
    state.pendingReviewExportCount = Number(payload?.export_count || 0);
    state.pendingReviewLoaded = true;
    state.pendingReviewMessage = t("search.reviewApproved", {
      count: Number(payload?.approved || 0),
      skipped: Number(payload?.skipped_missing || 0),
    });
  } catch (error) {
    state.pendingReviewError = error?.message || t("error.requestFailed");
  } finally {
    state.pendingReviewApproving = false;
    renderPendingReviewView();
  }
}

function createBlacklistResultItem(item) {
  const row = createSearchResultItem(item, {
    showDeveloperActions: false,
    showPrimaryAction: false,
  });
  row.classList.add("blacklist-result-item");
  const body = row.querySelector(".search-result-body");
  if (body) {
    const audit = document.createElement("div");
    audit.className = "blacklist-result-audit";
    const rejectedAt = Number(item?.rejected_at || 0);
    const rejectedText = rejectedAt > 0 ? new Date(rejectedAt * 1000).toLocaleString() : "";
    audit.textContent = [
      rejectedText,
      String(item?.rejected_by || "").trim(),
      String(item?.reason_code || "").trim(),
    ].filter(Boolean).join(" · ");
    if (audit.textContent) {
      body.appendChild(audit);
    }
  }
  const snapshot = developerDeleteSnapshot(item);
  const actions = document.createElement("div");
  actions.className = "blacklist-result-actions";
  const releaseButton = document.createElement("button");
  releaseButton.type = "button";
  releaseButton.className = "toolbar-button ghost";
  releaseButton.dataset.devAction = "blacklist-release";
  releaseButton.dataset.item = JSON.stringify(snapshot);
  releaseButton.textContent = t("search.blacklistRelease");
  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.className = "next-button";
  restoreButton.dataset.devAction = "blacklist-release-restore";
  restoreButton.dataset.item = JSON.stringify(snapshot);
  restoreButton.textContent = t("search.blacklistReleaseRestore");
  actions.append(releaseButton, restoreButton);
  row.appendChild(actions);
  return row;
}

function renderBlacklistItems(container, items) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  container.classList.remove("hidden");
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = state.blacklistLoading ? t("search.blacklistLoading") : t("search.blacklistEmpty");
    container.appendChild(empty);
    return;
  }
  items.forEach((item) => container.appendChild(createBlacklistResultItem(item)));
}

function ensureBlacklistView() {
  if (!elements.catalogAdvancedContent) {
    return null;
  }
  let view = elements.catalogAdvancedContent.querySelector("[data-blacklist-view]");
  if (view) {
    return view;
  }
  elements.catalogAdvancedContent.textContent = "";
  view = document.createElement("div");
  view.className = "pending-review-browser blacklist-browser";
  view.dataset.blacklistView = "1";
  view.innerHTML = `
    <div class="pending-review-head">
      <div class="pending-review-title-block">
        <p class="section-tag">D1 BLACKLIST</p>
        <h2 data-blacklist-title></h2>
      </div>
      <button type="button" class="toolbar-button" data-blacklist-refresh></button>
    </div>
    <form class="blacklist-search-form" data-blacklist-search>
      <input type="search" data-blacklist-query autocomplete="off">
      <button type="submit" class="next-button" data-blacklist-search-submit></button>
    </form>
    <div class="search-results pending-review-results hidden" data-blacklist-results></div>
    <p class="gatcha-message pending-review-message" data-blacklist-message role="status"></p>
    <div class="pending-review-actions blacklist-pagination">
      <button type="button" class="toolbar-button ghost" data-blacklist-previous></button>
      <button type="button" class="toolbar-button ghost" data-blacklist-next></button>
    </div>
  `;
  elements.catalogAdvancedContent.appendChild(view);
  return view;
}

function renderBlacklistView() {
  const view = ensureBlacklistView();
  if (!view) {
    return;
  }
  const title = view.querySelector("[data-blacklist-title]");
  const refreshButton = view.querySelector("[data-blacklist-refresh]");
  const queryInput = view.querySelector("[data-blacklist-query]");
  const searchButton = view.querySelector("[data-blacklist-search-submit]");
  const results = view.querySelector("[data-blacklist-results]");
  const message = view.querySelector("[data-blacklist-message]");
  const previousButton = view.querySelector("[data-blacklist-previous]");
  const nextButton = view.querySelector("[data-blacklist-next]");
  if (title) title.textContent = t("search.blacklistTitle");
  if (refreshButton) {
    refreshButton.textContent = t("search.blacklistRefresh");
    refreshButton.disabled = state.blacklistLoading;
    refreshButton.setAttribute("aria-busy", String(state.blacklistLoading));
  }
  if (queryInput && document.activeElement !== queryInput) {
    queryInput.value = state.blacklistQuery;
  }
  if (queryInput) queryInput.placeholder = t("search.blacklistSearchPlaceholder");
  if (searchButton) {
    searchButton.textContent = t("search.modalSearch");
    searchButton.disabled = state.blacklistLoading;
    searchButton.setAttribute("aria-busy", String(state.blacklistLoading));
  }
  renderBlacklistItems(results, state.blacklistItems);
  if (message) {
    const start = state.blacklistItems.length ? state.blacklistOffset + 1 : 0;
    const end = state.blacklistOffset + state.blacklistItems.length;
    message.textContent = state.blacklistError
      || (state.blacklistLoading ? t("search.blacklistLoading") : "")
      || state.blacklistMessage
      || (state.blacklistTotal ? t("search.blacklistFound", { start, end, total: state.blacklistTotal }) : "");
    message.classList.toggle("is-error", Boolean(state.blacklistError));
  }
  if (previousButton) {
    previousButton.textContent = t("search.blacklistPrevious");
    previousButton.disabled = state.blacklistLoading || state.blacklistOffset <= 0;
  }
  if (nextButton) {
    nextButton.textContent = t("search.blacklistNext");
    nextButton.disabled = state.blacklistLoading || !state.blacklistHasMore;
  }
}

async function loadBlacklistItems({ force = false, query = state.blacklistQuery, offset = state.blacklistOffset } = {}) {
  if (!state.developerMode || !state.bilikaraSecret) {
    state.blacklistItems = [];
    state.blacklistLoaded = false;
    state.blacklistError = t("search.reviewNeedDeveloper");
    renderBlacklistView();
    return;
  }
  if (!force && state.blacklistLoading) {
    return;
  }
  const seq = state.blacklistSeq + 1;
  state.blacklistSeq = seq;
  state.blacklistLoading = true;
  state.blacklistQuery = String(query || "").trim();
  state.blacklistOffset = Math.max(0, Number(offset) || 0);
  state.blacklistMessage = "";
  state.blacklistError = "";
  renderBlacklistView();
  try {
    const payload = await fetchBlacklistItems({
      query: state.blacklistQuery,
      offset: state.blacklistOffset,
      limit: state.blacklistLimit,
    });
    if (state.blacklistSeq !== seq) {
      return;
    }
    state.blacklistItems = Array.isArray(payload?.items) ? payload.items : [];
    state.blacklistTotal = Number(payload?.total || 0);
    state.blacklistHasMore = Boolean(payload?.has_more);
    state.blacklistLoaded = true;
  } catch (error) {
    if (state.blacklistSeq === seq) {
      state.blacklistItems = [];
      state.blacklistLoaded = false;
      state.blacklistError = error?.message || t("error.requestFailed");
    }
  } finally {
    if (state.blacklistSeq === seq) {
      state.blacklistLoading = false;
      renderBlacklistView();
    }
  }
}

const maintenanceJobDefinitions = [
  {
    job: "monthly-d1-refresh",
    titleKey: "maintenance.monthlyTitle",
    descriptionKey: "maintenance.monthlyDescription",
  },
  {
    job: "tagger-yomi",
    titleKey: "maintenance.taggerYomiTitle",
    descriptionKey: "maintenance.taggerYomiDescription",
  },
];

function boundedMaintenanceMessage(value, limit = 360) {
  return String(value || "").trim().slice(0, limit);
}

function renderMaintenanceView() {
  if (!elements.catalogAdvancedContent) {
    return;
  }
  const focusedJob = elements.catalogAdvancedContent.contains(document.activeElement)
    ? String(document.activeElement?.dataset?.maintenanceJob || "")
    : "";
  const scrollTop = Math.max(0, Number(elements.catalogAdvancedView?.scrollTop || 0));
  elements.catalogAdvancedContent.textContent = "";

  const view = document.createElement("section");
  view.className = "maintenance-browser";
  view.dataset.maintenanceView = "1";

  const heading = document.createElement("div");
  heading.className = "maintenance-browser-head";
  const title = document.createElement("h2");
  title.textContent = t("maintenance.title");
  const description = document.createElement("p");
  description.textContent = t("maintenance.description");
  heading.append(title, description);

  const jobs = document.createElement("div");
  jobs.className = "maintenance-job-list";
  maintenanceJobDefinitions.forEach((definition) => {
    const card = document.createElement("article");
    card.className = "maintenance-job-card";
    const copy = document.createElement("div");
    const jobTitle = document.createElement("h3");
    jobTitle.textContent = t(definition.titleKey);
    const jobDescription = document.createElement("p");
    jobDescription.textContent = t(definition.descriptionKey);
    copy.append(jobTitle, jobDescription);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "next-button";
    button.dataset.maintenanceJob = definition.job;
    const isRunning = state.maintenanceJobRunning === definition.job;
    button.disabled = Boolean(state.maintenanceJobRunning);
    if (isRunning) {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
    button.textContent = isRunning ? t("maintenance.starting") : t("maintenance.start");
    card.append(copy, button);
    jobs.appendChild(card);
  });

  const message = document.createElement("p");
  message.className = "gatcha-message maintenance-job-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.textContent = state.maintenanceJobError || state.maintenanceJobMessage;
  message.classList.toggle("is-error", Boolean(state.maintenanceJobError));
  view.append(heading, jobs, message);
  elements.catalogAdvancedContent.appendChild(view);
  if (elements.catalogAdvancedView) {
    elements.catalogAdvancedView.scrollTop = scrollTop;
  }
  if (focusedJob) {
    view.querySelector(`[data-maintenance-job="${focusedJob}"]`)?.focus({ preventScroll: true });
  }
}

async function triggerMaintenanceJob(job) {
  if (state.maintenanceJobRunning || !state.developerMode || !state.bilikaraSecret) {
    return;
  }
  const definition = maintenanceJobDefinitions.find((item) => item.job === job);
  if (!definition) {
    return;
  }
  state.maintenanceJobRunning = job;
  state.maintenanceJobMessage = t("maintenance.starting");
  state.maintenanceJobError = "";
  renderMaintenanceView();
  try {
    const result = await apiPost("/api/admin-maintenance/trigger", {
      job,
      BILIKARA_ADMIN_SECRET: state.bilikaraSecret,
      requested_by: boundedMaintenanceMessage(
        selectedRequesterName() || developerModeRequesterName,
        120,
      ),
    });
    if (!state.developerMode || !state.bilikaraSecret) {
      return;
    }
    state.maintenanceJobMessage = boundedMaintenanceMessage(t("maintenance.started", {
      job: t(definition.titleKey),
      id: boundedMaintenanceMessage(result?.instance_id || "-", 120),
    }));
    state.maintenanceJobError = "";
  } catch (error) {
    if (state.developerMode && state.bilikaraSecret) {
      state.maintenanceJobError = boundedMaintenanceMessage(
        error?.message || t("error.requestFailed"),
      );
      state.maintenanceJobMessage = "";
    }
  } finally {
    state.maintenanceJobRunning = "";
    if (state.catalogAdvancedTool === "maintenance") {
      renderMaintenanceView();
      elements.catalogAdvancedContent
        ?.querySelector(`[data-maintenance-job="${job}"]`)
        ?.focus({ preventScroll: true });
    }
  }
}

function ensureCategoryBrowseView() {
  if (!elements.discoverCategoriesPanel) {
    return null;
  }
  let view = elements.discoverCategoriesPanel.querySelector("[data-category-browse-view]");
  if (view) {
    return view;
  }
  elements.discoverCategoriesPanel.textContent = "";
  view = document.createElement("div");
  view.className = "category-browser";
  view.dataset.categoryBrowseView = "1";
  view.innerHTML = `
    <div class="category-browser-home" data-category-browser-home>
      <div class="category-browser-grid" data-category-browser-grid></div>
    </div>
    <div class="category-browser-detail hidden" data-category-browser-detail>
      <form class="tag-browser-search category-browser-search" data-category-browse-search>
        <input type="text" autocomplete="off" data-category-browse-query>
        <button type="submit" class="next-button" data-category-browse-submit></button>
      </form>
      <div class="category-browser-tabs" data-category-browser-tabs></div>
      <div class="tag-browser-nav">
        <button type="button" class="tag-browser-back" data-category-browse-back></button>
        <div class="tag-browser-current" data-category-browse-current></div>
      </div>
      <div class="search-results category-browser-results" data-category-browse-results></div>
      <p class="gatcha-message tag-browser-message" data-category-browse-message role="status"></p>
    </div>
  `;
  elements.discoverCategoriesPanel.appendChild(view);
  return view;
}

function createCategoryBrowseCard(category, { compact = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = compact ? "category-browser-tab" : "category-browser-card";
  button.dataset.categoryId = category.id;
  const media = document.createElement("span");
  media.className = compact ? "category-browser-tab-media" : "category-browser-card-media";
  if (category.coverUrl) {
    media.style.backgroundImage = `linear-gradient(135deg, rgba(0, 210, 255, 0.18), rgba(255, 102, 51, 0.14)), url("${category.coverUrl}")`;
  }
  const name = document.createElement("span");
  name.className = compact ? "category-browser-tab-name" : "category-browser-card-name";
  name.textContent = category.name;
  button.append(media, name);
  return button;
}

function renderCategoryBrowseView() {
  const view = ensureCategoryBrowseView();
  if (!view) {
    return;
  }
  const categories = categoryBrowseDefinitions();
  const retainedCategory = selectedCategoryBrowseDefinition();
  const selected = state.categoryBrowseLevel === "detail" ? retainedCategory : null;
  const home = view.querySelector("[data-category-browser-home]");
  const detail = view.querySelector("[data-category-browser-detail]");
  const grid = view.querySelector("[data-category-browser-grid]");
  const tabs = view.querySelector("[data-category-browser-tabs]");
  const queryInput = view.querySelector("[data-category-browse-query]");
  const submitButton = view.querySelector("[data-category-browse-submit]");
  const backButton = view.querySelector("[data-category-browse-back]");
  const current = view.querySelector("[data-category-browse-current]");
  const results = view.querySelector("[data-category-browse-results]");
  const message = view.querySelector("[data-category-browse-message]");

  home?.classList.toggle("hidden", Boolean(selected));
  detail?.classList.toggle("hidden", !selected);
  if (grid && !selected) {
    grid.innerHTML = "";
    categories.forEach((category) => {
      grid.appendChild(createCategoryBrowseCard(category));
    });
  }
  if (!selected) {
    return;
  }
  if (queryInput && document.activeElement !== queryInput) {
    queryInput.value = state.categoryBrowseQuery || "";
  }
  if (queryInput) {
    queryInput.placeholder = t("search.browseItemPlaceholder");
  }
  if (submitButton) {
    submitButton.textContent = t("search.submit");
    submitButton.disabled = state.categoryBrowseLoading;
  }
  if (backButton) {
    backButton.textContent = t("common.back");
    backButton.disabled = false;
  }
  if (current) {
    current.textContent = "";
    current.classList.add("hidden");
  }
  if (tabs) {
    tabs.innerHTML = "";
    categories.forEach((category) => {
      const tab = createCategoryBrowseCard(category, { compact: true });
      tab.classList.toggle("active", category.id === selected.id);
      tab.disabled = state.categoryBrowseLoading && category.id === selected.id;
      tabs.appendChild(tab);
    });
  }
  if (results) {
    renderSearchResultItems(results, state.categoryBrowseItems, t("search.larkNoResults"));
  }
  if (message) {
    let text = "";
    if (state.categoryBrowseError) {
      text = state.categoryBrowseError;
    } else if (state.categoryBrowseLoading && !state.categoryBrowseItems.length) {
      text = t("search.browseLoading");
    } else if (state.categoryBrowseItems.length) {
      text = state.categoryBrowseHasMore
        ? t("search.categoryLoadedMore", { count: state.categoryBrowseItems.length })
        : t("search.categoryLoadedAll", { count: state.categoryBrowseItems.length });
    } else if (!state.categoryBrowseLoading) {
      text = t("search.larkNoResults");
    }
    message.textContent = text;
    message.classList.toggle("is-error", Boolean(state.categoryBrowseError));
  }
}

async function loadCategoryBrowse({ categoryId = state.categoryBrowseSelectedId, query = state.categoryBrowseQuery, append = false } = {}) {
  const category = categoryBrowseDefinitions().find((entry) => entry.id === categoryId);
  if (!category) {
    state.categoryBrowseLevel = "home";
    state.categoryBrowseSelectedId = "";
    state.categoryBrowseItems = [];
    state.categoryBrowseOffset = 0;
    state.categoryBrowseHasMore = false;
    renderCategoryBrowseView();
    return;
  }
  const searchSeq = state.categoryBrowseSeq + 1;
  state.categoryBrowseSeq = searchSeq;
  state.categoryBrowseLevel = "detail";
  state.categoryBrowseSelectedId = category.id;
  state.categoryBrowseQuery = String(query || "").trim();
  state.categoryBrowseError = "";
  if (!append) {
    state.categoryBrowseItems = [];
    state.categoryBrowseOffset = 0;
    state.categoryBrowseHasMore = true;
    state.categoryBrowseLoaded = false;
    state.categoryBrowseScrollPositions.detail = 0;
  }
  state.categoryBrowseLoading = true;
  renderCategoryBrowseView();
  restoreRequestScrollPosition();
  try {
    const data = await fetchD1CategoryBrowse({
      tags: category.tags,
      query: state.categoryBrowseQuery,
      offset: append ? state.categoryBrowseOffset : 0,
      limit: CATEGORY_BROWSE_PAGE_SIZE,
    });
    if (state.categoryBrowseSeq !== searchSeq) {
      return;
    }
    const nextItems = Array.isArray(data.items) ? data.items : [];
    state.categoryBrowseItems = append ? mergeCategoryBrowseItems(state.categoryBrowseItems, nextItems) : mergeCategoryBrowseItems([], nextItems);
    state.categoryBrowseHasMore = Boolean(data.has_more);
    state.categoryBrowseOffset = Number(data.next_offset ?? (append ? state.categoryBrowseOffset + nextItems.length : nextItems.length)) || state.categoryBrowseItems.length;
    state.categoryBrowseLoaded = true;
  } catch (error) {
    if (state.categoryBrowseSeq === searchSeq) {
      state.categoryBrowseError = error.message;
    }
  } finally {
    if (state.categoryBrowseSeq === searchSeq) {
      state.categoryBrowseLoading = false;
      state.categoryBrowseLoaded = true;
      renderCategoryBrowseView();
      restoreRequestScrollPosition();
    }
  }
}

function maybeLoadMoreCategoryBrowse(scrollContainer) {
  if (
    state.categoryBrowseLevel !== "detail"
    || !state.categoryBrowseSelectedId
    || state.categoryBrowseLoading
    || !state.categoryBrowseHasMore
    || !scrollContainer
  ) {
    return;
  }
  const remaining = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
  if (remaining <= 160) {
    loadCategoryBrowse({ append: true });
  }
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
  if (elements.followSearchButton) {
    elements.followSearchButton.disabled = state.followBrowseLoading;
    elements.followSearchButton.toggleAttribute("aria-busy", state.followBrowseLoading);
    elements.followSearchButton.textContent = state.followBrowseLoading
      ? t("follow.loadingItems")
      : t("search.submit");
  }
  const owners = Array.isArray(state.followBrowseData?.owners) ? state.followBrowseData.owners : [];
  const items = Array.isArray(state.followBrowseData?.items) ? state.followBrowseData.items : [];
  const signature = JSON.stringify({
    loading: state.followBrowseLoading,
    selected: state.followBrowseSelectedUid,
    owners,
    items,
    language: state.language,
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
      empty.textContent = state.followBrowseLoading ? t("follow.loadingOwners") : t("follow.noOwners");
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
        count.textContent = t("follow.countSongs", { count: Number(owner.count || 0) });

        button.append(name, count);

        if (owner.avatar_url) {
          const avatar = document.createElement("img");
          avatar.className = "follow-up-avatar";
          avatar.src = owner.avatar_url;
          avatar.alt = "";
          avatar.loading = "lazy";
          avatar.referrerPolicy = "no-referrer";
          button.append(avatar);
        }

        elements.followUpGrid.appendChild(button);
      });
    }
    setFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingOwners") : "");
    return;
  }

  const owner = selectedFollowOwner();
  if (elements.followBrowseAvatar) {
    const avatarUrl = String(owner?.avatar_url || "").trim();
    elements.followBrowseAvatar.classList.toggle("hidden", !avatarUrl);
    if (avatarUrl) {
      elements.followBrowseAvatar.src = avatarUrl;
    } else {
      elements.followBrowseAvatar.removeAttribute("src");
    }
  }
  if (elements.followBrowseTitle) {
    elements.followBrowseTitle.textContent = followOwnerDisplayName(owner) || `UID ${state.followBrowseSelectedUid}`;
  }
  if (elements.followBrowseCount) {
    const totalCount = Number(owner?.count || items.length || 0);
    elements.followBrowseCount.textContent = t("follow.itemCount", { shown: items.length, total: totalCount });
  }
  renderSearchResultItems(
    elements.followSongResults,
    items,
    state.followBrowseLoading ? t("follow.loadingItems") : t("follow.noItems"),
  );
  setFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingItems") : "");
}

async function loadFollowBrowse({ uid = state.followBrowseSelectedUid, query = "", keepQuery = false } = {}) {
  const seq = state.followBrowseSeq + 1;
  state.followBrowseSeq = seq;
  state.followBrowseLoading = true;
  state.followBrowseSelectedUid = String(uid || "").trim();
  state.followBrowseQuery = String(query || "");
  renderFollowBrowse();
  try {
    const nextData = await fetchGatchaBrowse(state.followBrowseSelectedUid, query);
    if (state.followBrowseSeq !== seq) {
      return;
    }
    state.followBrowseData = nextData;
    state.followBrowseSelectedUid = String(nextData.selected_uid || state.followBrowseSelectedUid || "");
    if (!keepQuery && elements.followSearchQuery) {
      elements.followSearchQuery.value = String(nextData.query || "");
    }
  } catch (error) {
    if (state.followBrowseSeq === seq) {
      setFollowBrowseMessage(error.message, true);
    }
  } finally {
    if (state.followBrowseSeq === seq) {
      state.followBrowseLoading = false;
      renderFollowBrowse();
    }
  }
}

async function refreshFollowBrowseAfterGatchaUidAdd(uid = "") {
  state.followBrowseRenderSignature = "";
  const currentUid = String(state.followBrowseSelectedUid || "").trim();
  const nextUid = currentUid || String(uid || "").trim();
  await loadFollowBrowse({ uid: nextUid, query: "", keepQuery: false });
}

function selectedFavlistFolder() {
  const folders = Array.isArray(state.favlistBrowseData?.folders) ? state.favlistBrowseData.folders : [];
  return folders.find((folder) => String(folder.id || "") === state.favlistBrowseSelectedFolderId) || null;
}

function renderFavlistBrowse() {
  if (!elements.favlistGrid || !elements.favlistSongResults) {
    return;
  }
  if (elements.favlistSearchButton) {
    elements.favlistSearchButton.disabled = state.favlistBrowseLoading;
    elements.favlistSearchButton.toggleAttribute("aria-busy", state.favlistBrowseLoading);
    elements.favlistSearchButton.textContent = state.favlistBrowseLoading
      ? t("favlist.loadingItems")
      : t("search.submit");
  }
  const folders = Array.isArray(state.favlistBrowseData?.folders) ? state.favlistBrowseData.folders : [];
  const items = Array.isArray(state.favlistBrowseData?.items) ? state.favlistBrowseData.items : [];
  const signature = JSON.stringify({
    loading: state.favlistBrowseLoading,
    selected: state.favlistBrowseSelectedFolderId,
    folders,
    items,
    language: state.language,
  });
  if (signature === state.favlistBrowseRenderSignature) {
    return;
  }
  state.favlistBrowseRenderSignature = signature;

  const hasSelectedFolder = Boolean(state.favlistBrowseSelectedFolderId);
  elements.favlistListView?.classList.toggle("hidden", hasSelectedFolder);
  elements.favlistItemsView?.classList.toggle("hidden", !hasSelectedFolder);

  if (!hasSelectedFolder) {
    elements.favlistGrid.innerHTML = "";
    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = state.favlistBrowseLoading ? t("favlist.loadingFolders") : t("favlist.noBrowseFolders");
      elements.favlistGrid.appendChild(empty);
    } else {
      folders.forEach((folder) => {
        const folderId = String(folder.id || "").trim();
        const title = String(folder.title || folderId || t("favlist.folder")).trim();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "follow-up-button favlist-browse-button";
        button.dataset.folderId = folderId;
        button.title = title;

        const name = document.createElement("span");
        name.className = "follow-up-name favlist-browse-name";
        name.textContent = title;

        const count = document.createElement("span");
        count.className = "follow-up-count favlist-browse-count";
        count.textContent = t("favlist.mediaCount", { count: Number(folder.media_count || folder.count || 0) });

        button.append(name, count);

        if (folder.avatar_url) {
          const avatar = document.createElement("img");
          avatar.className = "follow-up-avatar favlist-browse-avatar";
          avatar.src = folder.avatar_url;
          avatar.alt = "";
          avatar.loading = "lazy";
          avatar.referrerPolicy = "no-referrer";
          button.append(avatar);
        }

        elements.favlistGrid.appendChild(button);
      });
    }
    setFavlistBrowseMessage(state.favlistBrowseLoading ? t("favlist.loadingFolders") : "");
    return;
  }

  const folder = selectedFavlistFolder();
  if (elements.favlistBrowseAvatar) {
    const avatarUrl = String(folder?.avatar_url || "").trim();
    elements.favlistBrowseAvatar.classList.toggle("hidden", !avatarUrl);
    if (avatarUrl) {
      elements.favlistBrowseAvatar.src = avatarUrl;
    } else {
      elements.favlistBrowseAvatar.removeAttribute("src");
    }
  }
  if (elements.favlistBrowseTitle) {
    elements.favlistBrowseTitle.textContent = String(folder?.title || state.favlistBrowseSelectedFolderId || t("favlist.folder"));
  }
  if (elements.favlistBrowseCount) {
    const totalCount = Number(folder?.media_count || folder?.count || items.length || 0);
    elements.favlistBrowseCount.textContent = t("follow.itemCount", { shown: items.length, total: totalCount });
  }
  renderSearchResultItems(
    elements.favlistSongResults,
    items,
    state.favlistBrowseLoading ? t("favlist.loadingItems") : t("favlist.noItems"),
  );
  setFavlistBrowseMessage(state.favlistBrowseLoading ? t("favlist.loadingItems") : "");
}

async function loadFavlistBrowse({
  folderId = state.favlistBrowseSelectedFolderId,
  query = "",
  keepQuery = false,
} = {}) {
  const seq = state.favlistBrowseSeq + 1;
  state.favlistBrowseSeq = seq;
  state.favlistBrowseLoading = true;
  state.favlistBrowseSelectedFolderId = String(folderId || "").trim();
  state.favlistBrowseQuery = String(query || "");
  renderFavlistBrowse();
  let caughtError = null;
  try {
    const nextData = await fetchGatchaFavlistBrowse(state.favlistBrowseSelectedFolderId, query);
    if (state.favlistBrowseSeq !== seq) {
      return;
    }
    state.favlistBrowseData = nextData;
    state.favlistBrowseSelectedFolderId = String(
      nextData.selected_folder_id || state.favlistBrowseSelectedFolderId || "",
    );
    if (!keepQuery && elements.favlistSearchQuery) {
      elements.favlistSearchQuery.value = String(nextData.query || "");
    }
  } catch (error) {
    if (state.favlistBrowseSeq === seq) {
      caughtError = error;
    }
  } finally {
    if (state.favlistBrowseSeq === seq) {
      state.favlistBrowseLoading = false;
      renderFavlistBrowse();
      if (caughtError) {
        setFavlistBrowseMessage(caughtError.message, true);
      }
    }
  }
}

async function refreshFavlistBrowseAfterPull() {
  if (!state.favlistBrowseData) {
    return;
  }
  state.favlistBrowseRenderSignature = "";
  await loadFavlistBrowse({
    folderId: state.favlistBrowseSelectedFolderId,
    query: String(elements.favlistSearchQuery?.value || "").trim(),
    keepQuery: true,
  });
}

function scheduleFavlistBrowseReloadFromState(previousSnapshot, nextSnapshot) {
  const previousUpdatedAt = Number(previousSnapshot?.gatcha_favlist_updated_at || 0);
  const nextUpdatedAt = Number(nextSnapshot?.gatcha_favlist_updated_at || 0);
  if (!state.favlistBrowseData || state.favlistBrowseLoading || !nextUpdatedAt || nextUpdatedAt <= previousUpdatedAt) {
    return;
  }
  if (state.favlistBrowseReloadTimer) {
    window.clearTimeout(state.favlistBrowseReloadTimer);
  }
  state.favlistBrowseReloadTimer = window.setTimeout(() => {
    state.favlistBrowseReloadTimer = null;
    if (!state.favlistBrowseData || state.favlistBrowseLoading) {
      return;
    }
    refreshFavlistBrowseAfterPull();
  }, 0);
}

async function previewGatchaUidAddFromInput(input, {
  messageTarget = "gatcha",
  anchor = elements.modalAddFollowUidButton,
  event = null,
} = {}) {
  const uid = String(input?.value || "").trim();
  if (!uid) {
    setGatchaUidFlowMessage(messageTarget, t("gatcha.uidRequired"), true);
    return;
  }

  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidFace();
    return;
  }

  state.gatchaUidSaving = true;
  renderGatchaUidFace();
  setGatchaUidFlowMessage(messageTarget, t("gatcha.checkingUid"));
  try {
    const preview = await previewGatchaUid(uid);
    const ownerName = preview?.name || `UID ${preview?.uid || uid}`;
    const modeLabel = preview?.cache_mode === "incremental" ? t("gatcha.latestMode") : t("gatcha.allMode");
    const followedPrefix = preview?.already_followed ? t("gatcha.alreadyFollowedPrefix") : "";
    const point = anchorPointForEvent(event || {}, anchor || input);
    openConfirm({
      type: "gatcha-uid-add",
      uid: preview?.uid || uid,
      name: ownerName,
      message: t("gatcha.confirmPullOwner", { owner: ownerName, mode: modeLabel }),
      messageTarget,
      clearInputId: input?.id || "",
      ...point,
    });
    setGatchaUidFlowMessage(messageTarget, t("gatcha.detectedOwner", { prefix: followedPrefix, owner: ownerName }));
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidFace();
  }
}

async function previewGatchaFavlistFromInput(input, {
  messageTarget = "gatcha",
  modalSource = "gatcha",
} = {}) {
  const uid = String(input?.value || "").trim();
  if (!uid) {
    setGatchaUidFlowMessage(messageTarget, t("gatcha.uidRequired"), true);
    return;
  }

  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidFace();
    return;
  }

  state.gatchaFavlistSaving = true;
  renderGatchaUidFace();
  setGatchaUidFlowMessage(messageTarget, t("gatcha.readingFavlists"));
  try {
    const result = await previewGatchaFavlist(uid);
    openGatchaFavlistModal(result?.uid || uid, result, { messageTarget: modalSource });
    setGatchaUidFlowMessage(messageTarget, t("gatcha.chooseFavlists"));
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaFavlistSaving = false;
    renderGatchaUidFace();
  }
}

function normalizedGatchaView(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return ["idle", "drawing", "candidate", "error"].includes(candidate)
    ? candidate
    : "idle";
}

function setGatchaControlVisibility(control, visible) {
  if (!control) {
    return;
  }
  control.hidden = !visible;
  control.inert = !visible;
  control.setAttribute("aria-hidden", String(!visible));
}

function renderGatchaWorkspace() {
  let view = normalizedGatchaView(state.gatchaView);
  if (state.gatchaDrawBusy) {
    view = "drawing";
  } else if (view === "candidate" && !state.gatchaCandidate) {
    view = state.gatchaDrawError ? "error" : "idle";
  }
  state.gatchaView = view;

  elements.gatchaStateViews?.forEach((panel) => {
    const visible = panel.dataset.gatchaView === view;
    panel.hidden = !visible;
    panel.inert = !visible;
    panel.setAttribute("aria-hidden", String(!visible));
  });
  if (elements.gatchaCandidateTitle) {
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate?.title || t("gatcha.titleLoading");
  }
  if (elements.gatchaMessage) {
    elements.gatchaMessage.textContent = state.gatchaMessage || "";
    elements.gatchaMessage.classList.toggle("is-error", Boolean(state.gatchaMessageIsError));
  }

  const drawingWithRetry = state.gatchaDrawBusy
    && state.gatchaDrawControlId === "gatcha-retry-button";
  setGatchaControlVisibility(
    elements.gatchaButton,
    view === "idle" || (view === "drawing" && !drawingWithRetry),
  );
  setGatchaControlVisibility(elements.gatchaConfirmButton, view === "candidate");
  setGatchaControlVisibility(
    elements.gatchaRetryButton,
    view === "candidate" || view === "error" || drawingWithRetry,
  );

  const drawingControl = drawingWithRetry ? elements.gatchaRetryButton : elements.gatchaButton;
  [elements.gatchaButton, elements.gatchaRetryButton].forEach((button) => {
    if (!button) {
      return;
    }
    const busy = state.gatchaDrawBusy && button === drawingControl;
    button.disabled = state.gatchaDrawBusy;
    button.textContent = busy
      ? t("gatcha.drawing")
      : t(button === elements.gatchaRetryButton ? "gatcha.retry" : "gatcha.title");
    if (busy) {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
  });
  if (elements.gatchaConfirmButton) {
    elements.gatchaConfirmButton.disabled = state.gatchaRequestBusy;
    elements.gatchaConfirmButton.textContent = state.gatchaRequestBusy
      ? t("search.adding")
      : t("gatcha.confirm");
    if (state.gatchaRequestBusy) {
      elements.gatchaConfirmButton.setAttribute("aria-busy", "true");
    } else {
      elements.gatchaConfirmButton.removeAttribute("aria-busy");
    }
  }
}

function clearAcceptedGatchaCandidate({ focusDraw = true } = {}) {
  state.gatchaCandidate = null;
  state.gatchaView = "idle";
  state.gatchaDrawError = "";
  renderGatchaWorkspace();
  if (
    focusDraw
    && state.activeHostWorkspace === "random"
    && elements.gatchaButton?.isConnected
  ) {
    elements.gatchaButton.focus({ preventScroll: true });
  }
}

async function handleGatchaDraw(event = null) {
  if (state.gatchaDrawBusy) {
    return false;
  }
  const control = event?.currentTarget === elements.gatchaRetryButton
    ? elements.gatchaRetryButton
    : elements.gatchaButton;
  const idleLabel = control?.textContent || "";
  const drawSequence = state.gatchaDrawSequence + 1;
  state.gatchaDrawSequence = drawSequence;
  state.gatchaDrawControlId = control?.id || "gatcha-button";
  state.gatchaDrawBusy = true;
  state.gatchaView = "drawing";
  state.gatchaDrawError = "";
  setGatchaMessage(t("gatcha.drawing"));
  renderGatchaWorkspace();
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (state.gatchaDrawSequence !== drawSequence) {
      return false;
    }
    if (!response.ok || !payload.ok) {
      throw new Error(localizedApiMessage(payload.error) || t("gatcha.drawFailed"));
    }

    state.gatchaCandidate = payload.data;
    state.gatchaView = "candidate";
    state.gatchaDrawError = "";
    setGatchaMessage("");
    return true;
  } catch (error) {
    if (state.gatchaDrawSequence === drawSequence) {
      state.gatchaView = "error";
      state.gatchaDrawError = error.message;
      setGatchaMessage(error.message, true);
    }
    return false;
  } finally {
    if (state.gatchaDrawSequence === drawSequence) {
      state.gatchaDrawBusy = false;
      renderGatchaWorkspace();
      if (control) {
        control.textContent = idleLabel;
      }
    }
  }
}

function setGatchaMessage(message, isError = false) {
  state.gatchaMessage = message || "";
  state.gatchaMessageIsError = Boolean(isError);
  if (elements.gatchaMessage) {
    elements.gatchaMessage.textContent = state.gatchaMessage;
    elements.gatchaMessage.classList.toggle("is-error", state.gatchaMessageIsError);
  }
}

function setFollowBrowseMessage(message, isError = false) {
  if (!elements.followBrowseMessage) {
    return;
  }
  elements.followBrowseMessage.textContent = message || "";
  elements.followBrowseMessage.classList.toggle("is-error", Boolean(isError));
}

function setFavlistBrowseMessage(message, isError = false) {
  if (!elements.favlistBrowseMessage) {
    return;
  }
  elements.favlistBrowseMessage.textContent = message || "";
  elements.favlistBrowseMessage.classList.toggle("is-error", Boolean(isError));
}

function setLarkSearchMessage(message, isError = false) {
  if (!elements.larkSearchMessage) {
    return;
  }
  elements.larkSearchMessage.textContent = message || "";
  elements.larkSearchMessage.classList.toggle("is-error", Boolean(isError));
}

function localizedCacheMessage(message, cacheStatus = "") {
  let raw = String(message || "").trim();
  if (raw.includes("\n")) {
    raw = raw.split("\n")[0].trim();
  }
  const status = String(cacheStatus || "").trim();
  if (!raw) {
    return "";
  }
  if (raw === "已缓存" || raw === "缓存已完成" || raw.includes("缓存完成")) {
    return t("cache.ready");
  }
  if (raw === "等待缓存" || raw === "等待缓存队列" || raw.includes("等待优先缓存")) {
    return t("status.pendingCache");
  }
  if (raw === "正在校验缓存") {
    return t("status.checking");
  }
  const progressMatch = raw.match(/^缓存中\s*([0-9.]+)%$/);
  if (progressMatch) {
    return `${t("status.caching")} ${progressMatch[1]}%`;
  }
  if (raw.startsWith("缓存失败:")) {
    const detail = raw.slice("缓存失败:".length).trim();
    return detail ? `${t("cache.failed")}: ${detail}` : t("cache.failed");
  }
  if (raw.includes("开始缓存视频") || raw.includes("正在缓存")) {
    return t("cache.caching");
  }
  if (status === "failed" && raw === "缓存失败") {
    return t("cache.failed");
  }
  let localized = raw;
  if (localized.includes("视频轨")) {
    localized = localized.replace(/视频轨/g, t("cache.videoTrack"));
  }
  if (localized.includes("音轨")) {
    localized = localized.replace(/音轨/g, t("cache.audioTrack"));
  }
  if (localized.includes("（校验中）") || localized.includes("(校验中)")) {
    localized = localized.replace(/（校验中）|\(校验中\)/g, `(${t("status.validating")})`);
  } else if (localized === "校验中") {
    localized = t("status.validating");
  }
  if (localized !== raw) {
    return localized;
  }
  return raw;
}

function localizedCacheMessageLines(message, cacheStatus = "") {
  const lines = String(message || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "";
  }
  return lines
    .map((line) => localizedCacheMessage(line, cacheStatus) || line)
    .join("\n");
}

function syncLarkSearchInputs(value) {
  const nextValue = String(value || "");
  if (elements.larkSearchQuery && elements.larkSearchQuery.value !== nextValue) {
    elements.larkSearchQuery.value = nextValue;
  }
}

function setGatchaUidMessage(message, isError = false) {
  if (!elements.gatchaUidMessage) {
    return;
  }
  elements.gatchaUidMessage.textContent = message || "";
  elements.gatchaUidMessage.classList.toggle("is-error", Boolean(isError));
}

function setGatchaUidFlowMessage(target, message, isError = false) {
  if (target === "follow-modal") {
    setFollowBrowseMessage(message, isError);
    return;
  }
  if (target === "favlist-modal") {
    setFavlistBrowseMessage(message, isError);
    return;
  }
  setGatchaUidMessage(message, isError);
}

function clearGatchaUidFlowInput(inputId) {
  const input = inputId ? document.getElementById(inputId) : null;
  if (input instanceof HTMLInputElement) {
    input.value = "";
  }
}

function gatchaTaskBusy() {
  return Boolean(state.data?.gatcha?.busy);
}

function localizedGatchaTaskMessage(message, status = "") {
  const raw = String(message || "").trim();
  if (!raw) {
    if (status === "success") {
      return t("gatcha.refreshDone");
    }
    if (status === "partial") {
      return t("gatcha.refreshPartial");
    }
    if (status === "failed") {
      return t("gatcha.refreshFailed");
    }
    return "";
  }
  if (raw.includes("拉取任务执行中")) {
    return t("gatcha.busyFallback");
  }
  if (raw.includes("部分更新")) {
    return t("gatcha.refreshPartial");
  }
  if (raw.includes("更新完成") || raw.includes("重建完成")) {
    return t("gatcha.refreshDone");
  }
  if (raw.includes("更新失败")) {
    return t("gatcha.refreshFailed");
  }
  if (raw.includes("正在重建") || raw.includes("更新中")) {
    return t("gatcha.refreshingBackground");
  }
  return raw;
}

function gatchaTaskBusyMessage() {
  return localizedGatchaTaskMessage(state.data?.gatcha?.message, "running") || t("gatcha.busyFallback");
}

function syncGatchaTaskTerminalMessage() {
  const task = state.data?.gatcha || {};
  if (task.busy || state.gatchaUidSaving || state.gatchaRefreshSaving || state.gatchaFavlistSaving) {
    return;
  }
  const status = String(task.last_status || "");
  if (!["success", "partial", "failed"].includes(status)) {
    return;
  }
  const updatedAt = Number(task.last_updated_at || 0);
  if (updatedAt && updatedAt < state.gatchaTaskWatchStartedAt - 1) {
    return;
  }
  const signature = JSON.stringify({
    status,
    message: task.last_message || "",
    error: task.last_error || "",
    updatedAt,
  });
  if (signature === state.gatchaTaskLastMessageSignature) {
    return;
  }
  state.gatchaTaskLastMessageSignature = signature;
  const fallback =
    status === "success"
      ? t("gatcha.refreshDone")
      : status === "partial"
        ? t("gatcha.refreshPartial")
        : t("gatcha.refreshFailed");
  const message = localizedGatchaTaskMessage(task.last_message, status) || fallback;
  const detail = task.last_error ? `${message} ${task.last_error}` : message;
  setGatchaUidMessage(detail, status !== "success");
}

function renderGatchaUidFace() {
  syncGatchaTaskTerminalMessage();
  const taskBusy = gatchaTaskBusy();
  const signature = JSON.stringify({
    saving: state.gatchaUidSaving,
    refreshing: state.gatchaRefreshSaving,
    favlistSaving: state.gatchaFavlistSaving,
    taskBusy,
    taskMessage: gatchaTaskBusyMessage(),
    taskLastStatus: state.data?.gatcha?.last_status || "",
    taskLastUpdatedAt: state.data?.gatcha?.last_updated_at || 0,
    language: state.language,
  });
  if (signature === state.gatchaUidFaceRenderSignature) {
    return;
  }
  state.gatchaUidFaceRenderSignature = signature;

  setTextContent(elements.gatchaTag, t("gatcha.tag"));
  setTextContent(elements.gatchaTitle, t("gatcha.title"));
  if (elements.gatchaConfirmButton && !elements.gatchaConfirmButton.disabled) {
    elements.gatchaConfirmButton.textContent = t("gatcha.confirm");
  }
  if (elements.modalFollowUidInput) {
    elements.modalFollowUidInput.disabled = state.gatchaUidSaving || taskBusy;
  }
  if (elements.modalFavlistUidInput) {
    elements.modalFavlistUidInput.disabled = state.gatchaFavlistSaving || taskBusy;
  }
  if (elements.modalAddFollowUidButton) {
    elements.modalAddFollowUidButton.disabled = state.gatchaUidSaving || taskBusy;
    elements.modalAddFollowUidButton.toggleAttribute("aria-busy", state.gatchaUidSaving);
    elements.modalAddFollowUidButton.textContent = state.gatchaUidSaving ? t("gatcha.adding") : t("gatcha.add");
  }
  if (elements.refreshGatchaCacheButton) {
    elements.refreshGatchaCacheButton.disabled = state.gatchaRefreshSaving || taskBusy;
    elements.refreshGatchaCacheButton.toggleAttribute("aria-busy", state.gatchaRefreshSaving);
    elements.refreshGatchaCacheButton.textContent = state.gatchaRefreshSaving ? t("gatcha.refreshing") : t("gatcha.refresh");
  }
  if (elements.modalPullFavlistButton) {
    elements.modalPullFavlistButton.disabled = state.gatchaFavlistSaving || taskBusy;
    elements.modalPullFavlistButton.toggleAttribute("aria-busy", state.gatchaFavlistSaving);
    elements.modalPullFavlistButton.textContent = state.gatchaFavlistSaving ? t("gatcha.pulling") : t("gatcha.pullFavlist");
  }
  if (taskBusy) {
    if (elements.refreshGatchaCacheButton) {
      elements.refreshGatchaCacheButton.textContent = t("gatcha.globalCooldown");
    }
    if (elements.modalAddFollowUidButton) {
      elements.modalAddFollowUidButton.textContent = t("gatcha.globalCooldown");
    }
    if (elements.modalPullFavlistButton) {
      elements.modalPullFavlistButton.textContent = t("gatcha.globalCooldown");
    }
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
  const currentTitle = currentItem ? currentItem.display_title : t("player.noSong");
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
  renderHostWorkspaceSelection();
  renderGatchaWorkspace();

  const playbackMode = frontendPlaybackMode(data.playback_mode);
  renderAudioVariantBar(currentItem, playbackMode);
  renderAvSyncControls(playbackMode, data.player_settings);
  renderVolumeControls(playbackMode);
  renderKeyShiftControls(playbackMode);
  applyStoredVolumeToMountedPlayer();
  renderPlayer(currentItem, playbackMode);
  renderCurrentPresentationScene();
  renderPlayerFullscreenButton();
  renderPresentationOutputControl();
  applyRemotePlayerControl(data.player_control_command, currentItem, playbackMode);
  publishPresentationPlaybackState().catch(() => {});
  renderQueueCurrent(currentItem);
  if (!state.dragItemId) {
    renderPlaylist(data.playlist, data.current_item, data.cache_policy);
  }
  renderHistory(data.history || []);
  renderBackupBanner(
    data.backup,
    data.previous_session,
    Boolean(currentItem),
    data.playlist.length,
    Boolean(data.session_flags?.auto_restored_backup),
  );
  syncRequestSubviewSelection();
  renderGatchaUidFace();
  renderConfirmPopover();
  flushPendingSongTransitionOverlay();
  state.lastPollRenderSignature = renderSignatureForData(data);
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
  placeholder.textContent = users.length ? t("session.selectRequester") : t("session.addUserFirst");
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
    elements.sessionUserList.innerHTML = `<div class="queue-empty session-user-empty">${htmlT("session.empty")}</div>`;
    return;
  }

  users.forEach((userName, index) => {
    const item = document.createElement("div");
    item.className = "session-user-badge";
    item.draggable = true;
    item.dataset.index = index;
    item.dataset.name = userName;
    item.innerHTML = `
      <span class="session-user-order-number">${index + 1}</span>
      <span class="session-user-name">${escapeHtml(userName)}</span>
    `;

    elements.sessionUserList.appendChild(item);
  });
}


function setRemoteQrPinned(pinned, { dismissTransient = false } = {}) {
  state.remoteQrPinned = Boolean(pinned);
  elements.remoteMiniControl?.classList.toggle("is-qr-pinned", state.remoteQrPinned);
  elements.remoteMiniControl?.classList.toggle(
    "is-qr-dismissed",
    !state.remoteQrPinned && Boolean(dismissTransient),
  );
  elements.remoteMiniTrigger?.setAttribute("aria-expanded", String(state.remoteQrPinned));
  if (!state.remoteQrPinned && dismissTransient) {
    const activeElement = document.activeElement;
    if (activeElement && elements.remoteMiniControl?.contains(activeElement)) {
      activeElement.blur();
    }
  }
}

const cacheAdvancedInfoHoverDelayMs = 160;
const cacheAdvancedInfoLeaveDelayMs = 90;
let cacheAdvancedInfoHoverTimer = null;
let cacheAdvancedInfoLeaveTimer = null;

function setCacheAdvancedInfoVisible(info, { pinned = false } = {}) {
  if (!info) {
    return false;
  }
  document.querySelectorAll(".cache-advanced-info.is-visible").forEach((candidate) => {
    if (candidate === info) {
      return;
    }
    candidate.classList.remove("is-visible", "is-pinned");
    candidate.querySelector(".cache-advanced-info-button")?.setAttribute("aria-expanded", "false");
  });
  info.classList.add("is-visible");
  info.classList.toggle("is-pinned", pinned);
  info.querySelector(".cache-advanced-info-button")?.setAttribute("aria-expanded", "true");
  return true;
}

function closeCacheAdvancedInfo({ includePinned = true } = {}) {
  if (cacheAdvancedInfoHoverTimer) {
    window.clearTimeout(cacheAdvancedInfoHoverTimer);
    cacheAdvancedInfoHoverTimer = null;
  }
  if (cacheAdvancedInfoLeaveTimer) {
    window.clearTimeout(cacheAdvancedInfoLeaveTimer);
    cacheAdvancedInfoLeaveTimer = null;
  }
  let closed = false;
  document.querySelectorAll(".cache-advanced-info.is-visible").forEach((info) => {
    if (!includePinned && info.classList.contains("is-pinned")) {
      return;
    }
    closed = true;
    info.classList.remove("is-visible", "is-pinned");
    info.querySelector(".cache-advanced-info-button")?.setAttribute("aria-expanded", "false");
  });
  return closed;
}

function showCacheAdvancedInfoTransient(info, source) {
  if (info?.classList.contains("is-pinned")) {
    return true;
  }
  const pinned = document.querySelector(".cache-advanced-info.is-pinned");
  if (source === "pointer" && pinned && pinned !== info) {
    return false;
  }
  return setCacheAdvancedInfoVisible(info);
}

function cacheAdvancedInfoSupportsHover(event) {
  if (event.pointerType === "touch") {
    return false;
  }
  return window.matchMedia?.("(any-hover: hover) and (any-pointer: fine)").matches !== false;
}


function renderRemoteAccess(remoteAccess) {
  const preferredUrl = String(remoteAccess?.preferred_url || "");
  const lanUrls = Array.isArray(remoteAccess?.lan_urls) ? remoteAccess.lan_urls : [];
  const localUrl = String(remoteAccess?.local_url || "");
  const displayUrl = preferredUrl || localUrl || `${window.location.origin}/remote`;
  const displayHint = lanUrls.length > 1
    ? t("remote.multipleLanHint", { urls: lanUrls.join(" · ") })
    : lanUrls.length === 1
      ? t("remote.defaultHint")
      : t("remote.noLanHint");
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
        placeholder.textContent = t("remote.noAddress");
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
    placeholder.textContent = t("remote.qrLoading");
    placeholder.classList.remove("hidden");
    image.onload = () => {
      placeholder.classList.add("hidden");
      image.classList.remove("hidden");
    };
    image.onerror = () => {
      image.classList.add("hidden");
      placeholder.textContent = t("remote.qrFailed");
      placeholder.classList.remove("hidden");
    };
    image.src = qrUrl;
  });
}

async function copyRemoteUrl() {
  const url = elements.remoteUrlLink.href;
  if (!url) {
    setAppMessage(t("remote.copyUnavailable"), true);
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
    setAppMessage(t("remote.copySuccess"));
  } catch {
    setAppMessage(t("remote.copyFailed"), true);
  }
}

function renderListHeader(playlist, history) {
  const signature = JSON.stringify({
    queueCount: playlist.length,
    historyCount: history.length,
    language: state.language,
  });

  if (signature === state.listHeaderRenderSignature) {
    return;
  }
  state.listHeaderRenderSignature = signature;

  setTextContent(elements.listTag, t("list.tag"));
  setTextContent(elements.listTitle, t("list.title"));
  setTextContent(elements.queueCount, t("list.count", { count: playlist.length }));
  setTextContent(elements.historyCount, t("history.count", { count: history.length }));
  setClassToggle(elements.clearHistoryButton, "hidden", !history.length);
}

function renderCacheSettings(bbdown, ffmpeg, cachePolicy) {
  const serviceState = aggregateToolStatusState(bbdown, ffmpeg);
  const currentQuality = String(cachePolicy?.video_quality || "1080P 高码率");
  const playbackModeText = formatQualityLabel(currentQuality);
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
    language: state.language,
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
  renderCacheUsageDetail(cacheUsageDetail);
  renderCacheSlider(cachePolicy);
  renderAdvanceDelaySlider(state.data?.player_settings);
  renderCachePolicyControls(cachePolicy);
  renderUpdatePreviewControl();
  if (elements.cachePanelVersion) {
    const version = state.data?.app?.version || "";
    const versionText = version ? `bilikara ${version}` : "bilikara";
    if (elements.cachePanelVersion.textContent !== versionText) {
      elements.cachePanelVersion.textContent = versionText;
    }
  }
  syncCachePanelVisibility();
}

function appUpdateStatus() {
  return state.data?.app_update || {};
}

function isAppUpdateBusy(update = appUpdateStatus()) {
  return ["checking", "downloading", "installing", "restarting"].includes(String(update?.state || ""));
}

function appUpdateMatchesSelectedChannel(update = appUpdateStatus()) {
  return typeof update?.include_preview === "boolean"
    && update.include_preview === state.updatePreviewEnabled;
}

function isEligibleCurrentChannelUpdate(update = appUpdateStatus()) {
  if (
    !appUpdateMatchesSelectedChannel(update)
    || String(update?.state || "") !== "available"
    || update?.error
    || update?.requires_recheck
  ) {
    return false;
  }
  const eligibleActions = new Set([
    "normal_upgrade",
    "preview_to_stable",
    "development_to_stable",
    "development_to_preview",
  ]);
  if (!eligibleActions.has(String(update?.update_action || ""))) {
    return false;
  }
  return Boolean(
    update?.eligible_update
    ?? (update?.update_available || update?.switch_to_release_available),
  );
}

function selectedUpdateChannel() {
  return state.updatePreviewEnabled ? "preview" : "stable";
}

function shouldPresentCurrentChannelUpdate(update = appUpdateStatus()) {
  if (!isEligibleCurrentChannelUpdate(update)) {
    return false;
  }
  return state.updateAutomaticEnabled
    || state.updateManualVisibleChannel === selectedUpdateChannel();
}

function appUpdateProgressPercent(update = appUpdateStatus()) {
  const totalBytes = Number(update?.total_bytes || 0);
  const downloadedBytes = Number(update?.downloaded_bytes || 0);
  let percent = Number(update?.progress || 0) * 100;
  if (totalBytes > 0 && downloadedBytes >= 0) {
    percent = (downloadedBytes / totalBytes) * 100;
  }
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function appUpdateButtonText(update = appUpdateStatus()) {
  const stateValue = String(update?.state || "");
  if (state.updateCheckRequestInFlight || stateValue === "checking") {
    return t("status.checking");
  }
  if (stateValue === "downloading") {
    const percent = appUpdateProgressPercent(update);
    return percent > 0
      ? t("service.updateDownloadingPercent", { percent })
      : t("service.updateDownloading");
  }
  if (stateValue === "installing") {
    return t("service.updateInstalling");
  }
  if (stateValue === "restarting") {
    return t("service.updateRestarting");
  }
  if (shouldPresentCurrentChannelUpdate(update)) {
    const version = String(update?.latest_version || "").trim();
    return update?.auto_update_supported
      ? t("service.update")
      : t("service.viewVersion", { version });
  }
  return t("service.checkUpdate");
}

function updateIndicatorAccessibleText(update = appUpdateStatus()) {
  const version = String(update?.latest_version || "").trim();
  const action = update?.auto_update_supported
    ? t("service.update")
    : t("service.viewVersion", { version });
  return t("service.updateAvailableAction", { version, action });
}

function syncUpdateIndicator(element, visible, accessibleText) {
  if (!element) {
    return;
  }
  setClassToggle(element, "hidden", !visible);
  if (visible) {
    element.setAttribute("aria-label", accessibleText);
  } else {
    element.removeAttribute("aria-label");
  }
}

function maybeReportManualUpdateCheckOutcome(update) {
  const pending = state.manualUpdateCheck;
  if (
    !pending
    || !appUpdateMatchesSelectedChannel(update)
    || Boolean(update?.include_preview) !== pending.includePreview
    || Number(update?.updated_at || 0) <= pending.startedAt
    || String(update?.state || "") === "checking"
  ) {
    return;
  }
  state.manualUpdateCheck = null;
  state.updateManualVisibleChannel = isEligibleCurrentChannelUpdate(update)
    ? selectedUpdateChannel()
    : "";
  if (String(update?.state || "") === "failed") {
    setAppMessage(update?.error || update?.message || t("service.updateFailed"), true);
    return;
  }
  if (update?.requires_recheck) {
    setAppMessage(t("service.updateChannelNeedsRecheck"));
    return;
  }
  if (!isEligibleCurrentChannelUpdate(update)) {
    setAppMessage(t("service.upToDate"));
  }
}

function renderUpdatePreviewControl() {
  const update = appUpdateStatus();
  maybeReportManualUpdateCheckOutcome(update);
  const busy = state.updateCheckRequestInFlight || isAppUpdateBusy(update);
  const eligible = shouldPresentCurrentChannelUpdate(update);
  const accessibleText = eligible ? updateIndicatorAccessibleText(update) : "";
  if (elements.updateAutomaticCheckbox) {
    elements.updateAutomaticCheckbox.checked = state.updateAutomaticEnabled;
    elements.updateAutomaticCheckbox.disabled = false;
  }
  if (elements.updatePreviewCheckbox) {
    elements.updatePreviewCheckbox.checked = state.updatePreviewEnabled;
    elements.updatePreviewCheckbox.disabled = false;
  }
  if (elements.updateCheckButton) {
    elements.updateCheckButton.disabled = busy;
    if (busy) {
      elements.updateCheckButton.setAttribute("aria-busy", "true");
    } else {
      elements.updateCheckButton.removeAttribute("aria-busy");
    }
    setTextContent(elements.updateCheckButton, appUpdateButtonText(update));
    setElementTitle(
      elements.updateCheckButton,
      appUpdateMatchesSelectedChannel(update)
        ? update?.message || update?.error || t("service.checkUpdateTitle")
        : t("service.checkUpdateTitle"),
    );
  }
  if (elements.serviceUpdateIndicator) {
    elements.serviceUpdateIndicator.classList.toggle("has-update", false);
    elements.serviceUpdateIndicator.removeAttribute("aria-label");
  }
  syncUpdateIndicator(elements.advancedUpdateIndicator, eligible, accessibleText);
  setClassToggle(elements.appUpdateRow, "has-update", eligible);
  if (elements.updateVersionBadge) {
    setClassToggle(elements.updateVersionBadge, "hidden", !eligible);
    setTextContent(
      elements.updateVersionBadge,
      eligible
        ? t("service.newVersionBadge", { version: String(update?.latest_version || "") })
        : "",
    );
    if (eligible) {
      elements.updateVersionBadge.setAttribute("aria-label", accessibleText);
    } else {
      elements.updateVersionBadge.removeAttribute("aria-label");
    }
  }
  if (elements.appUpdateStatus) {
    let statusText = "";
    if (eligible) {
      statusText = "";
    } else if (!state.updateAutomaticEnabled && !state.manualUpdateCheck) {
      statusText = "";
    } else if (!appUpdateMatchesSelectedChannel(update) && String(update?.state || "") !== "idle") {
      statusText = t("service.updateChannelNeedsRecheck");
    } else if (String(update?.state || "") === "checking") {
      statusText = t("status.checking");
    } else {
      statusText = String(update?.error || update?.message || "");
    }
    setTextContent(elements.appUpdateStatus, statusText);
  }
}

function renderPlaybackRepairControls(currentItem) {
  const button = elements.currentCacheRetryButton;
  if (!button) {
    return;
  }
  const hasCurrentItem = Boolean(currentItem?.id);
  button.disabled = !hasCurrentItem || button.getAttribute("aria-busy") === "true";
  button.title = hasCurrentItem
    ? t("service.retryCurrentTitle")
    : t("service.noCurrentSong");
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
      setTextContent(label, loggedIn ? t("service.loggedIn") : t("service.notLoggedIn"));
      elements.bbdownLoginButton.title = loggedIn ? t("service.bbdownLogoutTitle") : t("service.bbdownLoginTitle");
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
        setTextContent(elements.bbdownLoginMessage, localizedBBDownLoginMessage(login?.message) || t("service.qrPreparing"));
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
    await apiPostStateSnapshot("/api/bbdown/login/start", {
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

function formatQualityLabel(value) {
  const normalized = String(value || "").trim();
  const labels = {
    "1080P 高码率": t("quality.1080pHighBitrate"),
    "1080P 高帧率": t("quality.1080p60"),
    "1080P 高清": t("quality.1080p"),
    "720P 高清": t("quality.720p"),
    "480P 清晰": t("quality.480p"),
    "360P 流畅": t("quality.360p"),
  };
  return labels[normalized] || normalized;
}

function formatPlaybackMode(_mode) {
  return t("service.localPlayback");
}

function renderCacheSlider(cachePolicy) {
  const choices = Array.isArray(cachePolicy?.choices) && cachePolicy.choices.length
    ? cachePolicy.choices
    : [1, 2, 3, 4, 5];
  const minValue = Number(choices[0] || 1);
  const maxValue = Number(choices[choices.length - 1] || 5);
  const confirmedValue = Number(cachePolicy?.max_cache_items || minValue);
  const currentValue = state.cacheLimitDraftValue ?? confirmedValue;
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
  elements.cacheLimitSlider.disabled = false;
  if (state.cacheLimitSaving) {
    elements.cacheLimitSlider.setAttribute("aria-busy", "true");
  } else {
    elements.cacheLimitSlider.removeAttribute("aria-busy");
  }
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
  const confirmedValue = currentSongAdvanceDelaySeconds(playerSettings);
  const currentValue = state.advanceDelayDraftValue ?? confirmedValue;
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
  elements.advanceDelaySlider.disabled = false;
  if (state.advanceDelaySaving) {
    elements.advanceDelaySlider.setAttribute("aria-busy", "true");
  } else {
    elements.advanceDelaySlider.removeAttribute("aria-busy");
  }
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
        return { value: choice, label: formatQualityLabel(choice) };
      }
      const value = String(choice?.value || "");
      return {
        value,
        label: formatQualityLabel(choice?.label || value),
      };
    }).filter((choice) => choice.value)
    : [
      { value: "1080P 高码率", label: t("quality.1080pHighBitrate") },
      { value: "1080P 高帧率", label: t("quality.1080p60") },
      { value: "1080P 高清", label: t("quality.1080p") },
      { value: "720P 高清", label: t("quality.720p") },
      { value: "480P 清晰", label: t("quality.480p") },
      { value: "360P 流畅", label: t("quality.360p") },
    ];
  const currentQuality = String(cachePolicy?.video_quality || choices[0]?.value || "1080P 高码率");
  const audioHires = Boolean(cachePolicy?.audio_hires);
  const resetOffsetOnNext = Boolean(cachePolicy?.reset_offset_on_next);
  const rawSourceChoices = Array.isArray(cachePolicy?.download_source_choices)
    ? cachePolicy.download_source_choices
    : [];
  const sourceChoices = rawSourceChoices.length
    ? rawSourceChoices.map((choice) => {
      if (typeof choice === "string") {
        return { value: choice, label: choice };
      }
      const value = String(choice?.value || "");
      return {
        value,
        label: String(choice?.label || value),
      };
    }).filter((choice) => choice.value)
    : [
      { value: "bbdown", label: "BBDown" },
      { value: "downkyi", label: "Downkyi (aria2c)" },
      { value: "native", label: "Rust Native" },
    ];
  const currentDownloadSource = String(cachePolicy?.download_source || sourceChoices[0]?.value || "bbdown");
  const signature = JSON.stringify({
    choices,
    currentQuality,
    sourceChoices,
    currentDownloadSource,
    audioHires,
    resetOffsetOnNext,
    saving: state.cachePolicySaving,
    downloadSourcePreparing: state.downloadSourcePreparing,
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

  if (elements.cacheDownloadSourceSelect) {
    const choicesSignature = JSON.stringify(sourceChoices);
    if (elements.cacheDownloadSourceSelect.dataset.choicesSignature !== choicesSignature) {
      elements.cacheDownloadSourceSelect.innerHTML = "";
      sourceChoices.forEach((choice) => {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        elements.cacheDownloadSourceSelect.appendChild(option);
      });
      elements.cacheDownloadSourceSelect.dataset.choicesSignature = choicesSignature;
    }
    elements.cacheDownloadSourceSelect.value = currentDownloadSource;
    elements.cacheDownloadSourceSelect.disabled = state.cachePolicySaving || state.downloadSourcePreparing;
  }

  if (elements.cacheHiresCheckbox) {
    elements.cacheHiresCheckbox.checked = audioHires;
    elements.cacheHiresCheckbox.disabled = state.cachePolicySaving;
  }

  if (elements.resetOffsetCheckbox) {
    elements.resetOffsetCheckbox.checked = resetOffsetOnNext;
    elements.resetOffsetCheckbox.disabled = state.cachePolicySaving;
  }
}

function isSafeHostSnapshotInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function playbackProgramDescriptorsEqual(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return Boolean(
    left
    && right
    && left.item_id === right.item_id
    && left.item_incarnation_id === right.item_incarnation_id
    && left.selected_audio_variant_id === right.selected_audio_variant_id
    && left.artifact_set_id === right.artifact_set_id
  );
}

function isValidHostMediaLocator(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const locator = new URL(value, window.location.href);
    if (locator.protocol !== "http:" && locator.protocol !== "https:") {
      return false;
    }
    const decodedPath = decodeURIComponent(locator.pathname);
    if (!decodedPath.startsWith("/media/")) {
      return false;
    }
    const segments = decodedPath.slice("/media/".length).split("/");
    return segments.length > 0
      && segments.every((segment) => segment && segment !== "." && segment !== "..");
  } catch {
    return false;
  }
}

function validatedHostSnapshotIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const stateRevision = snapshot.state_revision;
  const rustRevision = snapshot.revision;
  const playbackGeneration = snapshot.playback_generation;
  if (
    !isSafeHostSnapshotInteger(stateRevision)
    || !isSafeHostSnapshotInteger(rustRevision, 1)
    || !isSafeHostSnapshotInteger(playbackGeneration, 1)
    || !Object.hasOwn(snapshot, "playback_program")
    || !Object.hasOwn(snapshot, "current_item")
  ) {
    return null;
  }

  const program = snapshot.playback_program;
  const currentItem = snapshot.current_item;
  if ((program === null) !== (currentItem === null)) {
    return null;
  }
  if (program === null) {
    return { stateRevision, rustRevision, playbackGeneration, program: null };
  }
  if (
    typeof program !== "object"
    || Array.isArray(program)
    || Object.keys(program).length !== 4
    || !Object.hasOwn(program, "item_id")
    || !Object.hasOwn(program, "item_incarnation_id")
    || !Object.hasOwn(program, "selected_audio_variant_id")
    || !Object.hasOwn(program, "artifact_set_id")
    || typeof program.item_id !== "string"
    || !program.item_id
    || typeof program.item_incarnation_id !== "string"
    || !program.item_incarnation_id
    || typeof program.selected_audio_variant_id !== "string"
    || (program.artifact_set_id !== null
      && (typeof program.artifact_set_id !== "string" || !program.artifact_set_id))
    || !currentItem
    || typeof currentItem !== "object"
    || Array.isArray(currentItem)
    || currentItem.id !== program.item_id
    || currentItem.item_incarnation_id !== program.item_incarnation_id
    || currentItem.selected_audio_variant_id !== program.selected_audio_variant_id
    || typeof currentItem.artifact_set_id !== "string"
    || !Array.isArray(currentItem.audio_variants)
  ) {
    return null;
  }

  if (program.artifact_set_id === null) {
    if (
      currentItem.artifact_set_id
      || String(currentItem.video_media_url || "").trim()
      || currentItem.audio_variants.length > 0
    ) {
      return null;
    }
  } else {
    if (
      currentItem.artifact_set_id !== program.artifact_set_id
      || !isValidHostMediaLocator(currentItem.video_media_url)
    ) {
      return null;
    }
    const selectedVariants = currentItem.audio_variants.filter(
      (variant) => variant
        && typeof variant === "object"
        && !Array.isArray(variant)
        && variant.id === program.selected_audio_variant_id,
    );
    if (
      selectedVariants.length !== 1
      || !isValidHostMediaLocator(selectedVariants[0].audio_url)
    ) {
      return null;
    }
  }

  return { stateRevision, rustRevision, playbackGeneration, program };
}

const hostReadinessSnapshotFields = Object.freeze([
  "remote_access",
  "bbdown",
  "ffmpeg",
  "cache_policy",
  "gatcha",
  "gatcha_pool_config",
  "gatcha_favlist_updated_at",
  "app_update",
]);

function hostReadinessSnapshotSignature(snapshot) {
  return JSON.stringify(Object.fromEntries(
    hostReadinessSnapshotFields.map((field) => [field, snapshot?.[field]]),
  ));
}

function mergeHostReadinessSnapshot(snapshot) {
  const merged = { ...state.data };
  hostReadinessSnapshotFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
      merged[field] = snapshot[field];
    }
  });
  return merged;
}

function acceptHostStateSnapshot(snapshot) {
  const next = validatedHostSnapshotIdentity(snapshot);
  if (!next) {
    return false;
  }
  const previousSnapshot = state.data;
  const current = state.data ? validatedHostSnapshotIdentity(state.data) : null;
  if (state.data && !current) {
    return false;
  }
  const sameProgram = current
    ? playbackProgramDescriptorsEqual(current.program, next.program)
    : false;
  let readinessOnly = false;
  if (current) {
    if (next.stateRevision < current.stateRevision) {
      return false;
    }
    if (next.stateRevision === current.stateRevision) {
      if (
        next.rustRevision !== current.rustRevision
        || next.playbackGeneration !== current.playbackGeneration
        || !sameProgram
      ) {
        return false;
      }
      if (hostReadinessSnapshotSignature(snapshot) === hostReadinessSnapshotSignature(state.data)) {
        return false;
      }
      snapshot = mergeHostReadinessSnapshot(snapshot);
      readinessOnly = true;
    }
    if (
      next.rustRevision < current.rustRevision
      || next.playbackGeneration < current.playbackGeneration
      || (next.rustRevision === current.rustRevision
        && (next.playbackGeneration !== current.playbackGeneration || !sameProgram))
      || (next.playbackGeneration === current.playbackGeneration && !sameProgram)
      || (next.playbackGeneration > current.playbackGeneration
        && next.rustRevision <= current.rustRevision)
    ) {
      return false;
    }
  }
  state.data = snapshot;
  if (readinessOnly) {
    return true;
  }
  if (
    !current
    || next.playbackGeneration !== current.playbackGeneration
    || !sameProgram
  ) {
    maybeShowSongTransitionOverlay(previousSnapshot, snapshot);
    scheduleAcceptedHostPlaybackProgramReconciliation(
      next.playbackGeneration,
      next.program,
    );
  }
  return true;
}

function scheduleAcceptedHostPlaybackProgramReconciliation(
  playbackGeneration,
  playbackProgram,
) {
  const pending = state.pendingHostPlaybackProgramReconciliation;
  if (
    pending
    && pending.playbackGeneration === playbackGeneration
    && playbackProgramDescriptorsEqual(pending.playbackProgram, playbackProgram)
  ) {
    return false;
  }
  const reconciliation = { playbackGeneration, playbackProgram };
  state.pendingHostPlaybackProgramReconciliation = reconciliation;
  queueMicrotask(() => {
    if (state.pendingHostPlaybackProgramReconciliation !== reconciliation) {
      return;
    }
    state.pendingHostPlaybackProgramReconciliation = null;
    const accepted = validatedHostSnapshotIdentity(state.data);
    if (
      !accepted
      || accepted.playbackGeneration !== playbackGeneration
      || !playbackProgramDescriptorsEqual(accepted.program, playbackProgram)
    ) {
      return;
    }
    const session = state.hostPlaybackSession;
    if (
      session
      && session.playbackGeneration === playbackGeneration
      && playbackProgramDescriptorsEqual(session.playbackProgram, playbackProgram)
      && isCurrentHostPlaybackSession(session)
    ) {
      return;
    }
    renderPlayer(
      state.data?.current_item ?? null,
      frontendPlaybackMode(state.data?.playback_mode),
    );
  });
  return true;
}

async function apiPostStateSnapshot(url, payload = {}, options = {}) {
  const { onAccepted, ...requestOptions } = options;
  const accepted = acceptHostStateSnapshot(await apiPost(url, payload, requestOptions));
  if (accepted && typeof onAccepted === "function") {
    onAccepted();
  }
  return accepted;
}

async function apiPostExactStateCommand(url, payload = {}, options = {}) {
  const { onAccepted, ...requestOptions } = options;
  const envelope = await apiPost(url, payload, {
    ...requestOptions,
    returnEnvelope: true,
  });
  const snapshotAccepted = acceptHostStateSnapshot(envelope.data);
  if (snapshotAccepted && typeof onAccepted === "function") {
    onAccepted();
  }
  return {
    snapshotAccepted,
    commandApplied: envelope.stale !== true,
  };
}

function syncCachePanelVisibility(options = {}) {
  const expanded = String(state.cacheSettingsOpen);
  if (elements.cacheSettingsToggle.getAttribute("aria-expanded") !== expanded) {
    elements.cacheSettingsToggle.setAttribute("aria-expanded", expanded);
  }
  setClassToggle(elements.cachePanel, "hidden", !state.cacheSettingsOpen);
  if (!state.cacheSettingsOpen) {
    state.cacheAdvancedOpen = false;
  }
  if (!state.cacheAdvancedOpen) {
    closeCacheAdvancedInfo();
  }
  setClassToggle(elements.cacheAdvancedInlineView, "hidden", !state.cacheAdvancedOpen);
  if (elements.cachePanelAdvancedTrigger) {
    elements.cachePanelAdvancedTrigger.setAttribute("aria-expanded", String(state.cacheAdvancedOpen));
  }
  maybeStartBBDownLogin(state.data?.bbdown?.login, {
    force: Boolean(options.forceLoginRefresh),
  });
}

function syncDisplayPanelVisibility() {
  const expanded = String(state.displaySettingsOpen);
  if (elements.displaySettingsToggle && elements.displaySettingsToggle.getAttribute("aria-expanded") !== expanded) {
    elements.displaySettingsToggle.setAttribute("aria-expanded", expanded);
  }
  setClassToggle(elements.displaySettingsPanel, "hidden", !state.displaySettingsOpen);
}

function syncPresentationPanelVisibility() {
  const expanded = String(state.presentationSettingsOpen);
  if (elements.presentationSettingsToggle?.getAttribute("aria-expanded") !== expanded) {
    elements.presentationSettingsToggle?.setAttribute("aria-expanded", expanded);
  }
  setClassToggle(
    elements.presentationSettingsPanel,
    "hidden",
    !state.presentationSettingsOpen,
  );
}

function renderQueueCurrent(currentItem) {
  if (!currentItem) {
    const signature = `empty|${state.language}`;
    if (signature === state.queueCurrentRenderSignature) {
      return;
    }
    state.queueCurrentRenderSignature = signature;
    setClassToggle(elements.queueCurrent, "hidden", true);
    if (elements.queueCurrent.dataset.state !== "idle") {
      elements.queueCurrent.dataset.state = "idle";
    }
    setTextContent(elements.queueCurrentTag, t("status.playing"));
    setTextContent(elements.queueCurrentTitle, t("player.noSong"));
    setElementTitle(elements.queueCurrentTitle, "");
    setTextContent(elements.queueCurrentCacheDetail, "");
    setClassToggle(elements.queueCurrentCacheDetail, "hidden", true);
    setElementTitle(elements.queueCurrentCacheDetail, "");
    setClassToggle(elements.queueCurrentRetry, "hidden", true);
    elements.queueCurrentRetry.removeAttribute("data-id");
    return;
  }

  const currentState = currentStatusForItem(currentItem);
  const requesterText = requesterBadgeText(currentItem.requester_name);
  const cacheDetailText = queueCurrentCacheDetailForItem(currentItem, currentState.state);
  const signature = JSON.stringify({
    id: currentItem.id,
    state: currentState.state,
    label: currentState.label,
    title: currentItem.display_title,
    requesterText,
    cacheDetailText,
    cacheProgress: currentItem.cache_progress,
    cacheSizeBytes: currentItem.cache_size_bytes,
    cacheDownloadCurrent: currentItem.cache_download_current_bytes,
    cacheDownloadTotal: currentItem.cache_download_total_bytes,
    cacheDownloadTracks: currentItem.cache_download_tracks || [],
    language: state.language,
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
    setTextContent(elements.queueCurrentCacheDetail, cacheDetailText);
    setClassToggle(elements.queueCurrentCacheDetail, "hidden", !cacheDetailText);
    setElementTitle(elements.queueCurrentCacheDetail, cacheDetailText);

    setClassToggle(elements.queueCurrentProgressBadge, "idle", currentState.state === "pending");
    setClassToggle(elements.queueCurrentProgressBadge, "active", currentState.state === "caching");
    setClassToggle(elements.queueCurrentProgressBadge, "ready", currentState.state === "playing");
    setClassToggle(elements.queueCurrentProgressBadge, "failed", currentState.state === "failed");
    syncCacheProgressBadge(elements.queueCurrentProgressBadge, currentItem, currentState.state === "caching");
  }

  syncRetryButton(elements.queueCurrentRetry, currentItem);
}

function currentStatusForItem(item) {
  if (!item) {
    return { state: "idle", label: t("status.playing") };
  }
  if (item.cache_status === "ready") {
    return { state: "playing", label: t("status.playing") };
  }
  if (item.cache_status === "failed") {
    return { state: "failed", label: t("status.failed") };
  }
  const progressPercent = cacheProgressPercentForItem(item);
  if (progressPercent !== null) {
    return { state: "caching", label: `${progressPercent}%` };
  }
  const size = Number(item.cache_size_bytes || 0);
  if (size > 0) {
    return { state: "caching", label: formatCompactBytes(size) };
  }
  if (item.cache_status === "downloading") {
    return { state: "caching", label: t("status.caching") };
  }
  return { state: "pending", label: t("status.pendingCache") };
}

function normalizedCacheDownloadTracks(item) {
  if (!Array.isArray(item?.cache_download_tracks)) {
    return [];
  }
  return item.cache_download_tracks
    .filter((track) => track && typeof track === "object")
    .map((track) => ({ ...track }))
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

function cacheProgressBytesLabel(currentBytes, targetBytes) {
  const current = Math.max(0, Number(currentBytes || 0));
  const target = Math.max(0, Number(targetBytes || 0));
  if (target > 0) {
    return `${formatBytes(Math.min(current, target))} / ${formatBytes(target)}`;
  }
  return `${formatBytes(current)} / ${t("cache.estimating")}`;
}

function cacheTrackDetailTextForItem(item) {
  const tracks = normalizedCacheDownloadTracks(item);
  if (!tracks.length) {
    return "";
  }

  let totalCurrent = 0;
  let totalTarget = 0;
  let allTargetsKnown = true;
  tracks.forEach((track) => {
    const current = Math.max(0, Number(track.current_bytes || 0));
    const target = Math.max(0, Number(track.target_bytes || 0));
    if (target > 0) {
      totalCurrent += Math.min(current, target);
      totalTarget += target;
    } else {
      totalCurrent += current;
      allTargetsKnown = false;
    }
  });

  const lines = [
    `${t("cache.total")}：${allTargetsKnown && totalTarget > 0
      ? `${formatBytes(totalCurrent)} / ${formatBytes(totalTarget)}`
      : `${formatBytes(totalCurrent)} / ${t("cache.estimating")}`}`,
  ];
  tracks.forEach((track, index) => {
    const label = String(track.label || `Track ${index + 1}`).trim() || `Track ${index + 1}`;
    lines.push(`${label}：${cacheProgressBytesLabel(track.current_bytes, track.target_bytes)}`);
  });
  return lines.join("\n");
}

function hostCacheDetailTextForItem(item) {
  if (!item) {
    return "";
  }
  if (item.cache_status === "ready") {
    return "";
  }
  if (item.cache_status === "downloading") {
    return cacheTrackDetailTextForItem(item)
      || localizedCacheMessageLines(item.cache_message, item.cache_status)
      || t("status.caching");
  }
  return localizedCacheMessageLines(item.cache_message, item.cache_status)
    || (item.cache_status === "failed" ? t("cache.failed") : t("status.pendingCache"));
}

function queueCurrentCacheDetailForItem(item, currentState) {
  return "";
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

  const cachedVariants = audioVariantsForItem(item);
  const cachedVariantsById = new Map(
    cachedVariants.map((variant) => [String(variant.id || "").trim(), variant]),
  );

  return availableParts.map((entry) => {
    const cachedVariant = cachedVariantForPartEntry(entry, cachedVariantsById, cachedVariants);
    return {
      ...entry,
      id: String(cachedVariant?.id || entry.id || "").trim(),
      audio_url: String(cachedVariant?.audio_url || ""),
      // LEGACY: cachedVariant.media_url used to point to a muxed MP4 variant.
      // The host player now uses video_media_url + audio_url split playback.
      // media_url: String(cachedVariant?.media_url || ""),
    };
  });
}

function audioVariantPageNumber(variant) {
  const directPage = Number(variant?.page || 0);
  if (Number.isFinite(directPage) && directPage > 0) {
    return directPage;
  }
  const idMatch = String(variant?.id || "").trim().match(/^p(\d+)(?:_|$)/i);
  return idMatch ? Number(idMatch[1] || 0) : 0;
}

function cachedVariantForPartEntry(entry, cachedVariantsById, cachedVariants) {
  const exactMatch = cachedVariantsById.get(String(entry?.id || "").trim());
  if (exactMatch) {
    return exactMatch;
  }
  const page = Number(entry?.page || 0);
  if (!page) {
    return null;
  }
  return cachedVariants.find((variant) => audioVariantPageNumber(variant) === page) || null;
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
  return Number(playerSettings?.av_delay?.effective_delay_ms ?? playerSettings?.av_offset_ms ?? 0);
}

function currentAvOffsetMs() {
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
  return Math.max(0, Math.min(maxSongAdvanceDelaySeconds, Math.round(rawValue)));
}

function queuedNextItem() {
  const playlist = state.data?.playlist;
  return Array.isArray(playlist) && playlist.length ? playlist[0] : null;
}

function currentItemIdFromData(data) {
  return String(data?.current_item?.id || "");
}

function durationSecondsForItemPage(item, page) {
  if (!item) {
    return 0;
  }
  const targetPage = Number(page || 0);
  for (const [pagesKey, durationsKey] of [
    ["selected_pages", "selected_durations"],
    ["available_pages", "available_durations"],
  ]) {
    const pages = Array.isArray(item[pagesKey]) ? item[pagesKey] : [];
    const durations = Array.isArray(item[durationsKey]) ? item[durationsKey] : [];
    const index = pages.findIndex((candidate) => Number(candidate) === targetPage);
    const duration = Number(durations[index] || 0);
    if (index >= 0 && Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  }
  return 0;
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

function delayOverlayTitleForItem(item, fallback = t("player.untitledSong")) {
  let originalTitle = String(item?.display_title || item?.title || "").trim();
  let title = originalTitle;
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
  return title || originalTitle || fallback;
}

function manualTransitionOverlaySeconds(data = state.data) {
  return currentSongAdvanceDelaySeconds(data?.player_settings);
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

function clearSplitPlaybackStartupWatchdog(session = state.hostPlaybackSession) {
  if (!session?.startupWatchdogTimer) {
    return;
  }
  window.clearTimeout(session.startupWatchdogTimer);
  session.startupWatchdogTimer = null;
}

function clearLocalPlayerSyncTimer(session = state.hostPlaybackSession) {
  if (!session) {
    return;
  }
  if (session.syncTimer) {
    window.clearInterval(session.syncTimer);
    session.syncTimer = null;
  }
  if (session.startupTimer) {
    window.clearTimeout(session.startupTimer);
    session.startupTimer = null;
  }
  if (session.webkitRetryTimer) {
    window.clearTimeout(session.webkitRetryTimer);
    session.webkitRetryTimer = null;
  }
  if (session.hiddenPauseTimer) {
    window.clearTimeout(session.hiddenPauseTimer);
    session.hiddenPauseTimer = null;
  }
  clearSplitPlaybackStartupWatchdog(session);
}

function clearLocalPlayerEventListeners(session = state.hostPlaybackSession) {
  const cleanups = Array.isArray(session?.eventCleanups) ? session.eventCleanups : [];
  cleanups.splice(0).forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      // The media element may already have been detached.
    }
  });
}

function addMountedPlayerListener(media, eventName, listener, options) {
  const session = state.hostPlaybackSession;
  if (
    !isCurrentHostPlaybackSession(session)
    || (media !== session.video && media !== session.audio)
  ) {
    return false;
  }
  const guardedListener = (event) => {
    if (
      !isCurrentHostPlaybackSession(session, session.video, session.audio)
      || (media !== session.video && media !== session.audio)
    ) {
      return;
    }
    listener.call(media, event);
  };
  media.addEventListener(eventName, guardedListener, options);
  session.eventCleanups.push(() => {
    media.removeEventListener(eventName, guardedListener, options);
  });
  return true;
}

function takeLocalPlayerSeekCompletion(session) {
  if (!session) {
    return null;
  }
  if (session.seekSettleTimer) {
    window.clearTimeout(session.seekSettleTimer);
    session.seekSettleTimer = null;
  }
  const completion = session.seekSettleCallback;
  session.seekSettleCallback = null;
  session.seekSettling = false;
  session.seekResumeAfterSettle = false;
  session.seekSettleStartedAt = 0;
  session.seekResumePending = false;
  session.seekUpdatesLogicalIntent = true;
  return completion;
}

function clearLocalPlayerSeekState(session = state.hostPlaybackSession) {
  const completion = takeLocalPlayerSeekCompletion(session);
  if (typeof completion === "function") {
    try {
      completion(false);
    } catch {
      // Session retirement must finish even if a local completion observer fails.
    }
  }
}

function playerDelayOverlay() {
  return elements.playerFrame?.querySelector(".player-delay-overlay") || null;
}

function ensurePlayerDelayOverlay() {
  let overlay = playerDelayOverlay();
  if (overlay) {
    return overlay;
  }
  const renderer = presentationRendererApi();
  if (!renderer) {
    return null;
  }
  overlay = renderer.ensureOverlay(elements.playerFrame, {
    countdownLabel: t("player.advanceCountdown"),
  });
  return overlay;
}

function resumeMountedPlayerAfterOverlay(itemId, generation, session) {
  if (
    !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
  ) {
    return false;
  }
  const currentItemId = currentItemIdFromData(state.data);
  if (
    generation !== state.manualTransitionHoldGeneration
    || itemId !== state.manualTransitionHoldItemId
    || itemId !== currentItemId
  ) {
    const { video, audio } = activeLocalPlayerElements();
    if (video && audio) {
      reportSplitSyncDiagnostic(itemId, video, audio, "stale-callback", true);
    }
    return false;
  }
  clearLocalAdvanceDelay({ resetInFlight: true, hideOverlay: true });
  const { video, audio } = activeLocalPlayerElements();
  if (
    !video
    || !audio
    || String(video.dataset.playerItemId || "") !== itemId
  ) {
    return false;
  }
  session.logicalPlayIntent = true;
  state.localShouldBePlaying = true;
  if (!session.readyCommitted) {
    return true;
  }
  if (!session.initialIntentApplied) {
    return applyInitialHostPlaybackIntent(session, video, audio);
  }
  if (state.localPlaybackStartState === "established") {
    setSplitPlaybackIntent(video, audio, true);
  } else if (
    state.localPlaybackStartState !== "needs-user-gesture"
    && state.localPlaybackStartState !== "startup-failed"
  ) {
    startSplitPlaybackPair(video, audio);
  } else {
    updateSplitPlaybackStartOverlay(video, audio);
  }
  return true;
}

function shouldHoldCurrentItemForTransition(item = state.data?.current_item) {
  const normalizedItemId = String(item?.id || item || "");
  return Boolean(
    normalizedItemId
    && (
      currentItemIdFromData(state.pendingSongTransitionOverlayData) === normalizedItemId
      || (
        state.manualTransitionHoldGeneration > 0
        && state.manualTransitionHoldItemId === normalizedItemId
      )
      || (
        state.localAdvanceDelayDeadline > 0
        && state.localAdvanceDelayItemId === normalizedItemId
      )
    ),
  );
}

function isLocalAdvanceHoldingItem(itemId) {
  return shouldHoldCurrentItemForTransition(String(itemId || ""));
}

function registerManualTransitionHold(itemId) {
  const normalizedItemId = String(itemId || "");
  if (!normalizedItemId) {
    return 0;
  }
  if (
    state.manualTransitionHoldItemId === normalizedItemId
    && state.manualTransitionHoldGeneration > 0
  ) {
    state.localShouldBePlaying = false;
    return state.manualTransitionHoldGeneration;
  }
  state.songTransitionGeneration += 1;
  state.manualTransitionHoldGeneration = state.songTransitionGeneration;
  state.manualTransitionHoldItemId = normalizedItemId;
  state.localShouldBePlaying = false;
  return state.manualTransitionHoldGeneration;
}

function stopMountedPlayerForAdvanceDelay(itemId) {
  if (!isLocalAdvanceHoldingItem(itemId)) {
    return;
  }
  state.localShouldBePlaying = false;
  clearLocalPlayerSeekState();

  const { video, audio } = activeLocalPlayerElements();
  if (audio && !audio.paused) {
    audio.pause();
  }
  if (video && !video.paused) {
    video.pause();
  }
}

function setPlayerDelayOverlayVisible(overlay) {
  if (!overlay) {
    return;
  }
  if (state.localAdvanceOverlayHideTimer) {
    window.clearTimeout(state.localAdvanceOverlayHideTimer);
    state.localAdvanceOverlayHideTimer = null;
  }
  if (
    !overlay.classList.contains("hidden")
    && (
      overlay.classList.contains("is-visible")
      || overlay.classList.contains("is-entering")
    )
  ) {
    return;
  }
  overlay.classList.remove("is-visible", "is-leaving");
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  // Force the browser to commit the hidden/base style so the following class
  // change always starts an animation.
  overlay.getBoundingClientRect();
  overlay.classList.add("is-entering");
  let showTimer = null;
  showTimer = window.setTimeout(() => {
    if (state.localAdvanceOverlayHideTimer !== showTimer) {
      return;
    }
    overlay.classList.remove("is-entering");
    overlay.classList.add("is-visible");
    state.localAdvanceOverlayHideTimer = null;
  }, localAdvanceOverlayFadeMs);
  state.localAdvanceOverlayHideTimer = showTimer;
}

function hidePlayerDelayOverlay({ onHidden = null } = {}) {
  const overlay = playerDelayOverlay();
  if (!overlay) {
    if (typeof onHidden === "function") {
      onHidden();
    }
    return;
  }
  if (overlay.classList.contains("hidden")) {
    if (typeof onHidden === "function") {
      onHidden();
    }
    return;
  }
  if (state.localAdvanceOverlayHideTimer) {
    window.clearTimeout(state.localAdvanceOverlayHideTimer);
  }
  overlay.classList.remove("hidden", "is-entering", "is-leaving");
  overlay.classList.add("is-visible");
  overlay.setAttribute("aria-hidden", "false");
  // Same idea as show: make sure the visible style is committed before
  // entering the leaving animation.
  overlay.getBoundingClientRect();
  overlay.classList.remove("is-visible");
  overlay.classList.add("is-leaving");
  let hideTimer = null;
  hideTimer = window.setTimeout(() => {
    if (state.localAdvanceOverlayHideTimer !== hideTimer) {
      return;
    }
    overlay.classList.remove("is-leaving", "is-entering", "is-visible");
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    state.localAdvanceOverlayHideTimer = null;
    if (typeof onHidden === "function") {
      onHidden();
    }
  }, localAdvanceOverlayFadeMs);
  state.localAdvanceOverlayHideTimer = hideTimer;
}

function showSongTransitionOverlayForData(
  data,
  generation = 0,
  { preserveDeadline = false } = {},
) {
  if (!data) {
    return;
  }
  const playlist = Array.isArray(data.playlist) ? data.playlist : [];
  const primaryItem = data.current_item || playlist[0] || null;
  if (!primaryItem) {
    return;
  }
  const session = state.hostPlaybackSession;
  if (
    !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
    || String(session.video?.dataset?.playerItemId || "") !== String(primaryItem.id || "")
  ) {
    return;
  }
  const delaySeconds = manualTransitionOverlaySeconds(data);
  const itemId = String(primaryItem.id || "");
  if (delaySeconds <= 0) {
    if (
      itemId === state.manualTransitionHoldItemId
      && (!generation || generation === state.manualTransitionHoldGeneration)
    ) {
      clearLocalAdvanceDelay({ resetInFlight: true });
    }
    return;
  }
  const reuseTiming = Boolean(
    preserveDeadline
    && generation > 0
    && generation === state.manualTransitionHoldGeneration
    && itemId === state.manualTransitionHoldItemId
    && itemId === state.localAdvanceDelayItemId
    && state.localAdvanceDelayDeadline > 0
  );
  const preservedStartAt = Number(state.localAdvanceDelayStartAt || 0);
  const preservedDeadline = Number(state.localAdvanceDelayDeadline || 0);
  const preservedDurationMs = Number(state.localAdvanceOverlayDurationMs || 0);
  clearLocalAdvanceDelay({ resetInFlight: true, hideOverlay: false });
  const token = state.localAdvanceDelayToken;
  const activeGeneration = generation || registerManualTransitionHold(itemId);

  state.localAdvanceOverlayPrimaryItem = primaryItem;
  state.localAdvanceOverlayFollowItems = data.current_item ? playlist : playlist.slice(1);
  state.localAdvanceOverlayTotalCount = (data.current_item ? 1 : 0) + playlist.length;
  state.localAdvanceDelayItemId = itemId;
  state.manualTransitionHoldItemId = itemId;
  state.manualTransitionHoldGeneration = activeGeneration;
  state.localAdvanceInFlight = true;
  state.localShouldBePlaying = false;
  if (reuseTiming) {
    state.localAdvanceOverlayDurationMs = preservedDurationMs;
    state.localAdvanceDelayStartAt = preservedStartAt;
    state.localAdvanceDelayDeadline = preservedDeadline;
  } else {
    state.localAdvanceOverlayDurationMs = delaySeconds * 1000;
    state.localAdvanceDelayStartAt = Date.now() + localAdvanceOverlayFadeMs;
    state.localAdvanceDelayDeadline = state.localAdvanceDelayStartAt + state.localAdvanceOverlayDurationMs;
  }
  updateLocalAdvanceDelayOverlay(session);
  let countdownTimer = null;
  countdownTimer = window.setInterval(() => {
    if (
      state.localAdvanceCountdownTimer !== countdownTimer
      || !isCurrentHostPlaybackSession(session, session.video, session.audio)
    ) {
      return;
    }
    updateLocalAdvanceDelayOverlay(session);
  }, 250);
  state.localAdvanceCountdownTimer = countdownTimer;
  let delayTimer = null;
  delayTimer = window.setTimeout(() => {
    if (
      state.localAdvanceDelayTimer === delayTimer
      && state.localAdvanceDelayToken === token
      && state.manualTransitionHoldGeneration === activeGeneration
      && state.manualTransitionHoldItemId === itemId
      && isCurrentHostPlaybackSession(session, session.video, session.audio)
    ) {
      updateLocalAdvanceDelayOverlay(session);
      state.localAdvanceDelayTimer = null;
      if (state.localAdvanceCountdownTimer) {
        window.clearInterval(state.localAdvanceCountdownTimer);
        state.localAdvanceCountdownTimer = null;
      }
      hidePlayerDelayOverlay({
        onHidden: () => resumeMountedPlayerAfterOverlay(itemId, activeGeneration, session),
      });
    }
  }, Math.max(0, state.localAdvanceDelayDeadline - Date.now()));
  state.localAdvanceDelayTimer = delayTimer;
}

function maybeShowSongTransitionOverlay(previousData, nextData, { force = false, generation = 0 } = {}) {
  if (!nextData) {
    return;
  }
  const previousId = currentItemIdFromData(previousData);
  const nextId = currentItemIdFromData(nextData);
  if (!nextId || (!force && previousId === nextId)) {
    return;
  }
  if (
    currentItemIdFromData(state.pendingSongTransitionOverlayData) === nextId
    || (
      state.localAdvanceDelayItemId === nextId
      && hasLocalAdvanceDelayOverlay()
    )
  ) {
    return;
  }
  const transitionKey = `${nextId}|${Number(nextData.state_revision || 0)}`;
  if (!force && state.lastSongTransitionOverlayKey === transitionKey) {
    return;
  }
  state.lastSongTransitionOverlayKey = transitionKey;
  if (manualTransitionOverlaySeconds(nextData) <= 0) {
    if (nextId === state.manualTransitionHoldItemId) {
      clearLocalAdvanceDelay({ resetInFlight: true });
    }
    return;
  }
  const activeGeneration = generation || registerManualTransitionHold(nextId);
  state.manualTransitionHoldItemId = nextId;
  state.manualTransitionHoldGeneration = activeGeneration;
  state.localShouldBePlaying = false;
  state.pendingSongTransitionOverlayData = nextData;
  state.pendingSongTransitionGeneration = activeGeneration;
}

function hasPendingSongTransitionOverlayForItem(item) {
  const itemId = String(item?.id || "");
  return Boolean(
    itemId
    && currentItemIdFromData(state.pendingSongTransitionOverlayData) === itemId,
  );
}

function flushPendingSongTransitionOverlay() {
  if (!state.pendingSongTransitionOverlayData) {
    return;
  }
  const overlayItemId = currentItemIdFromData(state.pendingSongTransitionOverlayData);
  const currentItemId = currentItemIdFromData(state.data);
  if (!overlayItemId || overlayItemId !== currentItemId) {
    state.pendingSongTransitionOverlayData = null;
    state.pendingSongTransitionGeneration = 0;
    return;
  }
  const currentItem = state.data?.current_item;
  if (!selectedVideoUrlForItem(currentItem) || !selectedAudioUrlForItem(currentItem)) {
    return;
  }
  const generation = state.pendingSongTransitionGeneration;
  state.pendingSongTransitionOverlayData = null;
  state.pendingSongTransitionGeneration = 0;
  showSongTransitionOverlayForData(state.data, generation);
}

function updateLocalAdvanceDelayOverlay(session = state.hostPlaybackSession) {
  if (
    session
    && !isCurrentHostPlaybackSession(session, session.video, session.audio)
  ) {
    return false;
  }
  const overlay = ensurePlayerDelayOverlay();
  if (!overlay) {
    return;
  }
  const now = Date.now();
  const countdownStartAt = Number(state.localAdvanceDelayStartAt || 0);
  const countdownNow = countdownStartAt > 0 ? Math.max(now, countdownStartAt) : now;
  const isAudienceSurface = isPlayerPanelFullscreen() || presentationCompositionActive();
  presentationRendererApi()?.renderOverlay(overlay, presentationOverlayModel(), {
    compact: !isAudienceSurface,
    manageVisibility: false,
    now: countdownNow,
  });
  if (state.localAdvanceDelayDeadline > 0) {
    setPlayerDelayOverlayVisible(overlay);
  } else {
    hidePlayerDelayOverlay();
  }
  publishPresentationPlaybackState(session).catch(() => {});
  return true;
}

function hasLocalAdvanceDelayOverlay() {
  return Boolean(
    state.localAdvanceDelayDeadline > 0
    || state.localAdvanceDelayStartAt > 0
    || state.localAdvanceDelayTimer
    || state.localAdvanceCountdownTimer,
  );
}

function startLocalAdvanceDelay(delaySeconds) {
  const currentItemId = String(state.data?.current_item?.id || "");
  if (!currentItemId) {
    return;
  }
  const session = state.hostPlaybackSession;
  if (!isCurrentHostPlaybackSession(session, session?.video, session?.audio)) {
    return;
  }
  clearLocalAdvanceDelay();
  state.localAdvanceInFlight = true;
  state.localAdvanceDelayItemId = currentItemId;
  state.localAdvanceDelayToken += 1;
  const token = state.localAdvanceDelayToken;
  state.localAdvanceOverlayDurationMs = delaySeconds * 1000;
  state.localAdvanceDelayStartAt = Date.now() + localAdvanceOverlayFadeMs;
  state.localAdvanceDelayDeadline = state.localAdvanceDelayStartAt + state.localAdvanceOverlayDurationMs;
  stopMountedPlayerForAdvanceDelay(currentItemId);
  updateLocalAdvanceDelayOverlay(session);
  let countdownTimer = null;
  countdownTimer = window.setInterval(() => {
    if (
      state.localAdvanceCountdownTimer !== countdownTimer
      || !isCurrentHostPlaybackSession(session, session.video, session.audio)
    ) {
      return;
    }
    updateLocalAdvanceDelayOverlay(session);
  }, 250);
  state.localAdvanceCountdownTimer = countdownTimer;
  let delayTimer = null;
  delayTimer = window.setTimeout(() => {
    if (state.localAdvanceDelayTimer !== delayTimer) {
      return;
    }
    finishLocalAdvanceDelay(token, currentItemId, session).catch(() => {});
  }, Math.max(0, state.localAdvanceDelayDeadline - Date.now()));
  state.localAdvanceDelayTimer = delayTimer;
}

function clearLocalAdvanceDelay({ resetInFlight = false, hideOverlay = true, onOverlayHidden = null } = {}) {
  if (state.localAdvanceDelayTimer) {
    window.clearTimeout(state.localAdvanceDelayTimer);
    state.localAdvanceDelayTimer = null;
  }
  if (state.localAdvanceCountdownTimer) {
    window.clearInterval(state.localAdvanceCountdownTimer);
    state.localAdvanceCountdownTimer = null;
  }
  if (hideOverlay) {
    state.localAdvanceDelayStartAt = 0;
    state.localAdvanceDelayDeadline = 0;
    state.localAdvanceOverlayDurationMs = 0;
    state.localAdvanceOverlayPrimaryItem = null;
    state.localAdvanceOverlayFollowItems = null;
    state.localAdvanceOverlayTotalCount = null;
    state.localAdvanceDelayItemId = "";
    state.manualTransitionHoldItemId = "";
    state.manualTransitionHoldGeneration = 0;
    hidePlayerDelayOverlay({ onHidden: onOverlayHidden });
  }
  state.localAdvanceDelayToken += 1;
  if (resetInFlight) {
    state.localAdvanceInFlight = false;
  }
}

async function finishLocalAdvanceDelay(token, itemId, session) {
  if (
    token !== state.localAdvanceDelayToken
    || itemId !== state.localAdvanceDelayItemId
    || !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
  ) {
    return;
  }
  updateLocalAdvanceDelayOverlay(session);
  clearLocalAdvanceDelay({
    resetInFlight: true,
    onOverlayHidden: () => {
      if (isCurrentHostPlaybackSession(session, session.video, session.audio)) {
        advanceLocalPlayerNow({ showTransition: false, session }).catch(() => {});
      }
    },
  });
}

function setPlayerFrameContent(html) {
  const overlay = playerDelayOverlay();
  const template = document.createElement("template");
  template.innerHTML = html;
  const nextNodes = Array.from(template.content.childNodes);
  Array.from(elements.playerFrame.childNodes).forEach((node) => {
    if (node !== overlay) {
      node.remove();
    }
  });
  elements.playerFrame.prepend(...nextNodes);
  if (overlay && overlay.parentElement !== elements.playerFrame) {
    elements.playerFrame.appendChild(overlay);
  }
}

function syncPlayerFrameCacheHint(currentItem) {
  const hint = elements.playerFrame.querySelector(".empty-state .empty-hint");
  if (!hint || !currentItem) {
    return;
  }
  setTextContent(hint, hostCacheDetailTextForItem(currentItem) || t("player.cachingFallback"));
}

function teardownMountedPlayer({ preserveAdvanceDelayOverlay = false } = {}) {
  return retireHostPlaybackSession(state.hostPlaybackSession, {
    preserveAdvanceDelayOverlay,
  });
}

function activeLocalPlayerElements() {
  const session = state.hostPlaybackSession;
  if (!isCurrentHostPlaybackSession(session, session?.video, session?.audio)) {
    return { video: null, audio: null };
  }
  return {
    video: session.video,
    audio: session.audio,
  };
}

function activePrimaryVideoElement() {
  return mountedLocalVideoElement();
}

function isActiveSplitPlayer(video, audio) {
  return isCurrentHostPlaybackSession(state.hostPlaybackSession, video, audio);
}

function isSplitPlayerSeekSettling(video, audio) {
  const session = state.hostPlaybackSession;
  return Boolean(
    session?.seekSettling
    && isCurrentHostPlaybackSession(session, video, audio),
  );
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
  if (
    primaryVideo
    && !state.hostPlaybackSession?.seekSettling
    && !shouldHoldCurrentItemForTransition(state.data?.current_item)
  ) {
    state.localShouldBePlaying = audio ? !audio.paused || state.localShouldBePlaying : !primaryVideo.paused;
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
  const session = state.hostPlaybackSession;
  if (
    !isActiveSplitPlayer(video, audio)
    || !session.seekSettling
  ) {
    return;
  }
  if (session.seekSettleTimer) {
    window.clearTimeout(session.seekSettleTimer);
    session.seekSettleTimer = null;
  }
  let seekSettleTimer = null;
  seekSettleTimer = window.setTimeout(() => {
    if (
      session.seekSettleTimer !== seekSettleTimer
      || !isActiveSplitPlayer(video, audio)
    ) {
      return;
    }
    session.seekSettleTimer = null;
    settleSplitPlayerSeek(video, audio);
  }, localPlayerSeekSettlePollMs);
  session.seekSettleTimer = seekSettleTimer;
}

function beginSplitPlayerSeek(video, audio, options = {}) {
  const session = state.hostPlaybackSession;
  if (
    !video
    || !audio
    || !isActiveSplitPlayer(video, audio)
    || (!session.readyCommitted && !options.allowUncommitted)
  ) {
    return false;
  }

  clearLocalPlayerSeekState(session);

  const resumeAfterSeek = Boolean(
    options.resumeAfterSeek
    && !shouldHoldCurrentItemForTransition(video.dataset.playerItemId),
  );
  session.seekSettling = true;
  session.seekResumeAfterSettle = resumeAfterSeek;
  session.seekSettleStartedAt = Date.now();
  session.seekResumePending = resumeAfterSeek;
  session.seekUpdatesLogicalIntent = options.updateIntent !== false;
  if (session.seekUpdatesLogicalIntent) {
    session.logicalPlayIntent = resumeAfterSeek;
    state.localShouldBePlaying = resumeAfterSeek;
  }
  if (typeof options.onSettled === "function") {
    session.seekSettleCallback = options.onSettled;
  }

  if (!audio.paused) {
    audio.pause();
  }
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
  if (Number.isFinite(options.targetTime)) {
    seekVideoForNavigation(video, options.targetTime);
  }

  syncSplitSeekAudioTarget(video, audio);
  reportSplitSyncDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    options.diagnosticAction || "manual-video-seek",
  );
  scheduleSplitPlayerSeekSettle(video, audio);
  return true;
}

function targetAudioTimeFromVideo(video, audio) {
  if (!video || !audio) {
    return 0;
  }
  return clampMediaTime(audio, Number(video.currentTime || 0) - currentAvOffsetSeconds());
}

function settleSplitPlayerSeek(video, audio, force = false) {
  const session = state.hostPlaybackSession;
  if (
    !isActiveSplitPlayer(video, audio)
    || !session.seekSettling
  ) {
    return false;
  }

  const isWebKit = isWebKitPlaybackRuntime();
  const targetAudioTime = isWebKit
    ? targetAudioTimeFromVideo(video, audio)
    : syncSplitSeekAudioTarget(video, audio);
  const elapsedMs = Date.now() - session.seekSettleStartedAt;
  const audioNeedsData = targetAudioTime > 0 && audio.readyState < 2;
  const waitingForMedia = video.seeking || audio.seeking || video.readyState < 2 || audio.readyState < 1 || audioNeedsData;
  if (!force && waitingForMedia && elapsedMs < localPlayerSeekSettleMaxMs) {
    scheduleSplitPlayerSeekSettle(video, audio);
    return false;
  }

  if (isWebKit) {
    syncSplitSeekAudioTarget(video, audio);
  }
  const resumeAfterSettle = session.seekResumeAfterSettle;
  const updateIntent = session.seekUpdatesLogicalIntent;
  const onSettled = takeLocalPlayerSeekCompletion(session);

  if (
    updateIntent
    &&
    resumeAfterSettle
    && !shouldHoldCurrentItemForTransition(video.dataset.playerItemId)
  ) {
    session.logicalPlayIntent = true;
    state.localShouldBePlaying = true;
    if (state.localPlaybackStartState === "pending") {
      startSplitPlaybackPair(video, audio);
    } else {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), !isWebKit);
    }
  } else if (updateIntent) {
    session.logicalPlayIntent = false;
    state.localShouldBePlaying = false;
    if (!audio.paused) {
      audio.pause();
    }
  }

  if (typeof onSettled === "function") {
    onSettled(true);
  }
  return true;
}

function mediaUrlBasename(media) {
  const source = String(media?.currentSrc || media?.src || "");
  if (!source) {
    return "";
  }
  try {
    const parsed = new URL(source, window.location.href);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "");
  } catch {
    return "";
  }
}

function bufferedMediaEnd(media) {
  try {
    return media?.buffered?.length
      ? Number(media.buffered.end(media.buffered.length - 1))
      : null;
  } catch {
    return null;
  }
}

function splitVideoFrameStats(video) {
  try {
    const quality = video?.getVideoPlaybackQuality?.();
    return {
      dropped_video_frames: Number(quality?.droppedVideoFrames ?? video?.webkitDroppedFrameCount ?? 0),
      total_video_frames: Number(quality?.totalVideoFrames ?? video?.webkitDecodedFrameCount ?? 0),
    };
  } catch {
    return { dropped_video_frames: null, total_video_frames: null };
  }
}

function splitSyncSnapshot(video, audio, offsetSeconds, action) {
  const audioTime = Number(audio?.currentTime || 0);
  const videoTime = Number(video?.currentTime || 0);
  const targetVideoTime = clampMediaTime(video, audioTime + offsetSeconds);
  return {
    audio_current_time: audioTime,
    video_current_time: videoTime,
    target_video_time: targetVideoTime,
    drift_seconds: videoTime - targetVideoTime,
    effective_av_delay_seconds: offsetSeconds,
    audio_playback_rate: Number(audio?.playbackRate || 1),
    video_playback_rate: Number(video?.playbackRate || 1),
    audio_ready_state: Number(audio?.readyState || 0),
    video_ready_state: Number(video?.readyState || 0),
    audio_network_state: Number(audio?.networkState || 0),
    video_network_state: Number(video?.networkState || 0),
    audio_paused: Boolean(audio?.paused),
    video_paused: Boolean(video?.paused),
    audio_seeking: Boolean(audio?.seeking),
    video_seeking: Boolean(video?.seeking),
    audio_ended: Boolean(audio?.ended),
    video_ended: Boolean(video?.ended),
    audio_buffered_end: bufferedMediaEnd(audio),
    video_buffered_end: bufferedMediaEnd(video),
    synchronization_action: action,
    playback_start_state: state.localPlaybackStartState,
    local_should_be_playing: state.localShouldBePlaying,
    local_audio_playback_blocked: state.localAudioPlaybackBlocked,
    local_video_playback_blocked: state.localVideoPlaybackBlocked,
    is_webkit_runtime: isWebKitPlaybackRuntime(),
    is_tauri_runtime: Boolean(window.__TAURI__),
    is_tauri_webkit_runtime: isTauriWebKitRuntime(),
    pause_reason: action === "transition-hold"
      ? "transition-hold"
      : action === "wait-for-audio" || action === "wait-for-video" || action === "defer-video-recovery"
        ? "media-starvation"
        : state.localShouldBePlaying
          ? "internal"
          : "user-or-transition",
    transition_generation: state.manualTransitionHoldGeneration,
    pending_transition_item_id: currentItemIdFromData(state.pendingSongTransitionOverlayData),
    transition_hold_item_id: state.manualTransitionHoldItemId,
    active_delay_deadline: state.localAdvanceDelayDeadline,
    ...splitVideoFrameStats(video),
  };
}

function reportMediaDiagnostic(
  itemId,
  mediaKind,
  media,
  eventName,
  video = null,
  audio = null,
  action = "none",
  playRejection = null,
) {
  if (
    !media
    || !video
    || !audio
    || !isActiveSplitPlayer(video, audio)
    || (media !== video && media !== audio)
  ) {
    return false;
  }
  const mediaError = media.error;
  const payload = {
    event: eventName,
    item_id: String(itemId || ""),
    media_kind: mediaKind,
    current_time: Number.isFinite(media.currentTime) ? Number(media.currentTime) : null,
    duration: Number.isFinite(media.duration) ? Number(media.duration) : null,
    ready_state: Number(media.readyState || 0),
    network_state: Number(media.networkState || 0),
    paused: Boolean(media.paused),
    seeking: Boolean(media.seeking),
    ended: Boolean(media.ended),
    playback_rate: Number(media.playbackRate || 1),
    buffered_end: bufferedMediaEnd(media),
    error_code: mediaError ? Number(mediaError.code || 0) : null,
    error_message: playRejection
      ? `${String(playRejection.name || "Error")}: ${String(playRejection.message || "")}`
      : mediaError
        ? String(mediaError.message || "")
        : "",
    play_rejection_name: playRejection ? String(playRejection.name || "Error") : "",
    url_basename: mediaUrlBasename(media),
    ...(video && audio ? splitSyncSnapshot(video, audio, currentAvOffsetSeconds(), action) : {}),
  };
  console.info("[player-media]", payload);
  apiPost("/api/player/diagnostic", payload).catch(() => {});
  return true;
}

function reportSplitStartupDiagnostic(itemId, video, audio, eventName) {
  reportMediaDiagnostic(itemId, "split", audio, eventName, video, audio, eventName);
}

function reportSplitSyncDiagnostic(itemId, video, audio, action, force = false) {
  if (!isActiveSplitPlayer(video, audio)) {
    return false;
  }
  const now = Date.now();
  if (
    !force
    && now - state.localPlayerSyncLastDiagnosticAt < localPlayerSyncDiagnosticThrottleMs
  ) {
    return false;
  }
  state.localPlayerSyncLastAction = action;
  state.localPlayerSyncLastDiagnosticAt = now;
  reportMediaDiagnostic(itemId, "split", audio, `sync-${action}`, video, audio, action);
  return true;
}

function attachSplitPlayerDiagnostics(itemId, video, audio) {
  const eventNames = ["loadedmetadata", "canplay", "waiting", "stalled", "suspend", "error", "ended"];
  eventNames.forEach((eventName) => {
    addMountedPlayerListener(video, eventName, () => {
      reportMediaDiagnostic(itemId, "video", video, eventName, video, audio);
    });
    addMountedPlayerListener(audio, eventName, () => {
      reportMediaDiagnostic(itemId, "audio", audio, eventName, video, audio);
    });
  });
}

async function handleSplitVideoEnded(currentItem, video, audio, reportStatus) {
  if (
    !isActiveSplitPlayer(video, audio)
    || !state.hostPlaybackSession?.readyCommitted
  ) {
    return false;
  }
  reportStatus();
  if (!audio.ended) {
    state.localVideoDeferredRecovery = true;
    reportSplitSyncDiagnostic(currentItem.id, video, audio, "defer-video-recovery", true);
    return false;
  }
  return handleSplitAudioEnded(currentItem, video, audio, reportStatus);
}

async function handleSplitAudioEnded(currentItem, video, audio, reportStatus) {
  if (
    state.localPlaybackEndHandled
    || !isActiveSplitPlayer(video, audio)
    || !state.hostPlaybackSession?.readyCommitted
  ) {
    return;
  }
  state.localPlaybackEndHandled = true;
  state.localShouldBePlaying = false;
  state.hostPlaybackSession.seekResumePending = false;
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
  reportStatus();
  await handleLocalPlaybackEnded("media-ended", state.hostPlaybackSession);
  return true;
}

function holdVideoForAudio(video) {
  state.localVideoHeldForAudio = true;
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
}

function splitPlaybackStartOverlay() {
  return elements.playerFrame?.querySelector(".split-playback-start-overlay") || null;
}

function splitPlaybackPairCanStartAutomatically(video, audio) {
  if (!video || !audio) {
    return false;
  }
  const minimumReadyState = isWebKitPlaybackRuntime() ? 1 : 2;
  return video.readyState >= minimumReadyState && audio.readyState >= minimumReadyState;
}

function applyInitialHostPlaybackIntent(session, video, audio) {
  if (
    state.hostPlaybackSession !== session
    || !isActiveSplitPlayer(video, audio)
    || !session.readyCommitted
    || session.phase !== "ready-paused"
    || session.initialIntentApplied
    || shouldHoldCurrentItemForTransition(video.dataset.playerItemId)
  ) {
    return false;
  }
  session.initialIntentApplied = true;
  state.localShouldBePlaying = Boolean(session.logicalPlayIntent);
  if (session.logicalPlayIntent) {
    return startSplitPlaybackPair(video, audio);
  }
  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    "startup-ready-no-play-intent",
  );
  setHostPlaybackSessionPhase(session, "paused");
  syncTauriMediaSessionState(video, { forcePosition: true });
  publishPresentationPlaybackState(session).catch(() => {});
  return true;
}

function commitHostPlaybackSessionReadyPaused(session, video, audio) {
  if (
    state.hostPlaybackSession !== session
    || !isActiveSplitPlayer(video, audio)
    || session.readyCommitted
    || session.phase !== "binding"
    || session.seekSettling
    || !splitPlaybackPairCanStartAutomatically(video, audio)
  ) {
    return false;
  }
  if (!audio.paused) {
    audio.pause();
  }
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
  session.readyCommitted = true;
  session.readyCommitCount += 1;
  setHostPlaybackSessionPhase(session, "ready-paused");
  clearSplitPlaybackStartupWatchdog(session);
  syncTauriMediaSessionState(video, { forcePosition: true });
  publishPresentationPlaybackState(session).catch(() => {});
  applyInitialHostPlaybackIntent(session, video, audio);
  return true;
}

function failHostPlaybackCandidate(session, video, audio, diagnosticAction) {
  if (
    state.hostPlaybackSession !== session
    || !isActiveSplitPlayer(video, audio)
    || session.readyCommitted
    || session.phase !== "binding"
  ) {
    return false;
  }
  session.failureStage = "media-readiness";
  session.playbackRestore = null;
  clearLocalPlayerSeekState(session);
  clearLocalPlayerSyncTimer(session);
  return failSplitPlaybackStartup(video, audio, "media-readiness", {
    diagnosticAction,
  });
}

function isRecoverableSplitPlaybackStartState(startState = state.localPlaybackStartState) {
  return startState === "pending"
    || startState === "starting"
    || startState === "needs-user-gesture"
    || startState === "startup-failed";
}

function splitPlaybackPairNeedsStart(video, audio) {
  return Boolean(
    video
    && audio
    && isActiveSplitPlayer(video, audio)
    && isRecoverableSplitPlaybackStartState()
    && (video.paused || audio.paused),
  );
}

function updateSplitPlaybackStartOverlay(video, audio) {
  const overlay = splitPlaybackStartOverlay();
  if (!overlay) {
    return;
  }
  const button = overlay.querySelector(".split-playback-start-button");
  const needsManualRecovery = state.localPlaybackStartState === "needs-user-gesture"
    || state.localPlaybackStartState === "startup-failed";
  overlay.classList.toggle("hidden", !needsManualRecovery);
  overlay.setAttribute("aria-hidden", String(!needsManualRecovery));
  if (button) {
    button.disabled = false;
    button.textContent = t("player.startPlayback");
    button.removeAttribute("aria-busy");
  }
}

function scheduleSplitPlaybackStartupWatchdog(video, audio) {
  const session = state.hostPlaybackSession;
  if (!isActiveSplitPlayer(video, audio)) {
    return false;
  }
  clearSplitPlaybackStartupWatchdog(session);
  if (
    !video
    || !audio
    || !isActiveSplitPlayer(video, audio)
    || !session.ownershipClaimed
    || !session.loadingStarted
    || !["binding", "starting", "start-retry-wait"].includes(session.phase)
  ) {
    return false;
  }

  const watchdogGeneration = state.localPlaybackStartGeneration;
  const watchdogItemId = String(video.dataset.playerItemId || "");
  let watchdogTimer = null;
  watchdogTimer = window.setTimeout(() => {
    if (session.startupWatchdogTimer !== watchdogTimer) {
      return;
    }
    session.startupWatchdogTimer = null;
    if (
      !isActiveSplitPlayer(video, audio)
      || state.localPlaybackStartGeneration !== watchdogGeneration
      || String(video.dataset.playerItemId || "") !== watchdogItemId
      || !["binding", "starting", "start-retry-wait"].includes(session.phase)
    ) {
      return;
    }

    let diagnosticAction = "startup-timeout-before-play-attempt";
    if (session.phase === "starting" || session.phase === "start-retry-wait") {
      if (!state.localPlaybackStartPromisesSettled) {
        diagnosticAction = "startup-play-promise-timeout";
      } else if (video.paused || audio.paused) {
        diagnosticAction = "resolved-but-still-paused";
      } else {
        diagnosticAction = "startup-timeout-after-play-resolution";
      }
    }
    if (session.phase === "binding") {
      failHostPlaybackCandidate(session, video, audio, diagnosticAction);
    } else {
      failSplitPlaybackStartup(video, audio, "startup-timeout", { diagnosticAction });
    }
  }, splitPlaybackStartupWatchdogMs);
  session.startupWatchdogTimer = watchdogTimer;
  return true;
}

function setSplitPlaybackStartState(nextState, video, audio) {
  const session = state.hostPlaybackSession;
  if (!isActiveSplitPlayer(video, audio)) {
    return false;
  }
  if (nextState === "pending") {
    setHostPlaybackSessionPhase(
      session,
      session.readyCommitted ? "ready-paused" : "binding",
    );
  } else if (nextState === "starting") {
    setHostPlaybackSessionPhase(session, "starting");
  } else if (nextState === "established") {
    setHostPlaybackSessionPhase(
      session,
      video.paused || audio.paused ? "paused" : "playing",
    );
  } else if (nextState === "needs-user-gesture") {
    setHostPlaybackSessionPhase(session, "needs-user-gesture");
  } else if (nextState === "startup-failed") {
    setHostPlaybackSessionPhase(session, "failed");
  } else {
    return false;
  }
  if (nextState === "pending" || nextState === "starting") {
    state.localPlaybackStartPromisesSettled = false;
    scheduleSplitPlaybackStartupWatchdog(video, audio);
  } else {
    clearSplitPlaybackStartupWatchdog(session);
  }
  updateSplitPlaybackStartOverlay(video, audio);
  return true;
}

function isPlaybackPolicyRejection(error) {
  return String(error?.name || "") === "NotAllowedError";
}

function requestSplitPlaybackStart(
  video,
  audio,
  { source = "", userGesture = false } = {},
) {
  if (
    !splitPlaybackPairNeedsStart(video, audio)
    || shouldHoldCurrentItemForTransition(video.dataset.playerItemId)
  ) {
    return false;
  }

  const itemId = video.dataset.playerItemId || "";
  if (source) {
    reportSplitStartupDiagnostic(itemId, video, audio, source);
  }

  if (state.localPlaybackStartState === "needs-user-gesture" && !userGesture) {
    state.hostPlaybackSession.logicalPlayIntent = true;
    state.localShouldBePlaying = false;
    updateSplitPlaybackStartOverlay(video, audio);
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  state.hostPlaybackSession.logicalPlayIntent = true;
  state.localShouldBePlaying = true;
  if (state.localPlaybackStartState === "starting" && !userGesture) {
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  state.localWebKitStartRetryDone = false;
  setSplitPlaybackStartState("pending", video, audio);
  startSplitPlaybackPair(video, audio, { userGesture });
  syncTauriMediaSessionState(video, { forcePosition: true });
  return true;
}

function requestSplitPlaybackStartFromUserGesture(video, audio, source = "user-start-intent") {
  return requestSplitPlaybackStart(video, audio, { source, userGesture: true });
}

function requireSplitPlaybackUserGesture(video, audio, action) {
  if (!video || !audio || !isActiveSplitPlayer(video, audio)) {
    return false;
  }
  const newlyRequired = state.localPlaybackStartState !== "needs-user-gesture";
  state.localWebKitStartRetryDone = false;
  state.localShouldBePlaying = false;
  setSplitPlaybackStartState("needs-user-gesture", video, audio);
  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    action,
  );
  if (!audio.paused) {
    audio.pause();
  }
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
  if (newlyRequired) {
    reportSplitSyncDiagnostic(video.dataset.playerItemId || "", video, audio, action, true);
    if (action !== "user-start-required") {
      reportSplitSyncDiagnostic(
        video.dataset.playerItemId || "",
        video,
        audio,
        "user-start-required",
        true,
      );
    }
  }
  syncTauriMediaSessionState(video, { forcePosition: true });
  return true;
}

function setSplitPlaybackIntent(
  video,
  audio,
  shouldPlay,
  {
    source = "",
    synchronizeStartupPlayer = null,
    userGesture = false,
  } = {},
) {
  const session = state.hostPlaybackSession;
  if (!video || !audio || !isActiveSplitPlayer(video, audio)) {
    return false;
  }

  const itemId = video.dataset.playerItemId || "";
  const nextIntent = Boolean(shouldPlay);
  session.logicalPlayIntent = nextIntent;
  if (!session.readyCommitted) {
    state.localShouldBePlaying = shouldHoldCurrentItemForTransition(itemId)
      ? false
      : nextIntent;
    session.seekResumeAfterSettle = false;
    session.seekResumePending = false;
    if (!audio.paused) {
      audio.pause();
    }
    if (!video.paused) {
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
    }
    if (source) {
      reportSplitStartupDiagnostic(itemId, video, audio, source);
    }
    return true;
  }
  if (shouldHoldCurrentItemForTransition(itemId)) {
    state.localShouldBePlaying = false;
    session.seekResumeAfterSettle = false;
    session.seekResumePending = false;
    if (!audio.paused) {
      audio.pause();
    }
    if (!video.paused) {
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
    }
    if (source) {
      reportSplitStartupDiagnostic(itemId, video, audio, `${source}-transition-hold`);
    }
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  state.localShouldBePlaying = nextIntent;
  if (source) {
    reportSplitStartupDiagnostic(itemId, video, audio, source);
  }

  if (!nextIntent) {
    session.seekResumeAfterSettle = false;
    session.seekResumePending = false;
    if (!audio.paused) {
      audio.pause();
    }
    if (!video.paused) {
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
    }
    setHostPlaybackSessionPhase(session, "paused");
    clearSplitPlaybackStartupWatchdog(session);
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  if (isSplitPlayerSeekSettling(video, audio)) {
    session.seekResumeAfterSettle = true;
    session.seekResumePending = true;
    if (!audio.paused) {
      audio.pause();
    }
    if (!video.paused) {
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
    }
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  if (state.localPlaybackStartState === "needs-user-gesture" && !userGesture) {
    syncTauriMediaSessionState(video, { forcePosition: true });
    return true;
  }

  if (session.phase === "paused" || session.phase === "ready-paused") {
    setHostPlaybackSessionPhase(session, "ready-paused");
    startSplitPlaybackPair(video, audio, { userGesture });
  } else if (state.localPlaybackStartState !== "established") {
    if (state.localPlaybackStartState !== "starting") {
      if (typeof synchronizeStartupPlayer === "function") {
        synchronizeStartupPlayer();
      } else {
        startSplitPlaybackPair(video, audio, { userGesture });
      }
    }
  } else {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
  }
  syncTauriMediaSessionState(video, { forcePosition: true });
  return true;
}

function tauriWebKitMediaSession() {
  if (!isTauriWebKitRuntime()) {
    return null;
  }
  const mediaSession = window.navigator?.mediaSession;
  return mediaSession && typeof mediaSession.setActionHandler === "function"
    ? mediaSession
    : null;
}

function clearTauriMediaSessionState() {
  const mediaSession = tauriWebKitMediaSession();
  if (!mediaSession) {
    return;
  }
  try {
    mediaSession.playbackState = "none";
  } catch {
    // Ignore incomplete Media Session implementations.
  }
  if (typeof mediaSession.setPositionState === "function") {
    try {
      mediaSession.setPositionState({});
    } catch {
      // Ignore incomplete Media Session implementations.
    }
  }
  state.lastTauriMediaSessionPositionAt = 0;
}

function syncTauriMediaSessionState(video, { forcePosition = false } = {}) {
  const mediaSession = tauriWebKitMediaSession();
  const { video: activeVideo, audio } = activeLocalPlayerElements();
  if (!mediaSession || !video || video !== activeVideo || !audio) {
    return false;
  }
  if (!state.hostPlaybackSession?.readyCommitted) {
    clearTauriMediaSessionState();
    return false;
  }

  try {
    mediaSession.playbackState = hostPlaybackSessionObservedPlaying(
      state.hostPlaybackSession,
      video,
      audio,
    ) ? "playing" : "paused";
  } catch {
    // Ignore incomplete Media Session implementations.
  }

  if (typeof mediaSession.setPositionState !== "function") {
    return true;
  }
  const now = Date.now();
  if (
    !forcePosition
    && now - Number(state.lastTauriMediaSessionPositionAt || 0)
      < tauriMediaSessionPositionUpdateMs
  ) {
    return true;
  }

  const duration = Number(video.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return true;
  }
  const currentTime = Number(video.currentTime || 0);
  const position = Math.max(0, Math.min(Number.isFinite(currentTime) ? currentTime : 0, duration));
  const requestedRate = Number(video.playbackRate || 1);
  const playbackRate = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : 1;
  try {
    mediaSession.setPositionState({ duration, position, playbackRate });
    state.lastTauriMediaSessionPositionAt = now;
  } catch {
    // Ignore incomplete Media Session implementations.
  }
  return true;
}

function tauriMediaSessionActionEvent(action) {
  return {
    play: "media-session-play",
    pause: "media-session-pause",
    seekbackward: "media-session-seek-backward",
    seekforward: "media-session-seek-forward",
    seekto: "media-session-seek-to",
    nexttrack: "media-session-next-track",
  }[action] || "media-session-unsupported";
}

function handleTauriMediaSessionAction(action, details = {}) {
  const mediaSession = tauriWebKitMediaSession();
  if (!mediaSession) {
    return false;
  }
  const { video, audio } = activeLocalPlayerElements();
  const playbackSession = state.hostPlaybackSession;
  if (!video || !audio) {
    clearTauriMediaSessionState();
    return false;
  }

  const eventName = tauriMediaSessionActionEvent(action);
  reportSplitStartupDiagnostic(video.dataset.playerItemId || "", video, audio, eventName);
  if (action === "play") {
    setSplitPlaybackIntent(video, audio, true, { userGesture: true });
  } else if (action === "pause") {
    setSplitPlaybackIntent(video, audio, false);
  } else if (action === "seekbackward" || action === "seekforward" || action === "seekto") {
    const resumeAfterSeek = state.localShouldBePlaying;
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime || 0);
    let targetTime = currentTime;
    if (action === "seekto") {
      targetTime = Number(details.seekTime);
    } else {
      const requestedOffset = Number(details.seekOffset);
      const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
        ? requestedOffset
        : 10;
      targetTime += action === "seekbackward" ? -offset : offset;
    }
    if (!Number.isFinite(targetTime)) {
      return false;
    }
    const clampedTarget = Math.max(
      0,
      Number.isFinite(duration) && duration > 0 ? Math.min(targetTime, duration) : targetTime,
    );
    beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek,
      targetTime: clampedTarget,
      diagnosticAction: eventName,
      onSettled: (applied) => {
        if (applied) {
          reportPlayerStatus(
            video.dataset.playerItemId || "",
            video,
            playbackSession,
          );
        }
      },
    });
  } else if (action === "nexttrack") {
    requestNextTrack().catch(() => {});
  } else {
    return false;
  }

  syncTauriMediaSessionState(video, { forcePosition: true });
  return true;
}

function ensureTauriMediaSessionHandlers() {
  const mediaSession = tauriWebKitMediaSession();
  if (!mediaSession || state.tauriMediaSessionOwner === mediaSession) {
    return Boolean(mediaSession);
  }
  ["play", "pause", "seekbackward", "seekforward", "seekto", "nexttrack"].forEach((action) => {
    try {
      mediaSession.setActionHandler(action, (details) => {
        handleTauriMediaSessionAction(action, details || {});
      });
    } catch {
      // Unsupported actions must not prevent the remaining handlers.
    }
  });
  state.tauriMediaSessionOwner = mediaSession;
  return true;
}

function invokeMediaPlay(media, { internalVideo = false } = {}) {
  if (internalVideo) {
    media.dataset.bilikaraInternalPlay = "true";
  }
  try {
    return Promise.resolve(media.play());
  } catch (error) {
    return Promise.reject(error);
  }
}

function pauseSplitPlaybackForStartupRecovery(video, audio) {
  if (!audio.paused) {
    audio.pause();
  }
  if (!video.paused) {
    video.dataset.bilikaraInternalPause = "true";
    video.pause();
  }
}

function failSplitPlaybackStartup(
  video,
  audio,
  prefix,
  { diagnosticAction = `${prefix}-retry-exhausted` } = {},
) {
  if (!isActiveSplitPlayer(video, audio)) {
    return false;
  }
  pauseSplitPlaybackForStartupRecovery(video, audio);
  state.localWebKitStartRetryDone = false;
  state.localShouldBePlaying = false;
  setSplitPlaybackStartState("startup-failed", video, audio);
  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    diagnosticAction,
  );
  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    "startup-failed",
  );
  reportSplitSyncDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    "startup-failed",
    true,
  );
  syncTauriMediaSessionState(video, { forcePosition: true });
  return true;
}

function scheduleWebKitSplitPlaybackRetry(video, audio, { userGesture, prefix }) {
  const session = state.hostPlaybackSession;
  if (!isActiveSplitPlayer(video, audio)) {
    return false;
  }
  pauseSplitPlaybackForStartupRecovery(video, audio);
  setHostPlaybackSessionPhase(session, "start-retry-wait");
  state.localPlaybackStartPromisesSettled = false;
  scheduleSplitPlaybackStartupWatchdog(video, audio);
  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    `${prefix}-retry-scheduled`,
  );

  let retryStarted = false;
  const retryWhenReady = () => {
    if (
      retryStarted
      || !isActiveSplitPlayer(video, audio)
      || session.phase !== "start-retry-wait"
      || !state.localShouldBePlaying
      || isSplitPlayerSeekSettling(video, audio)
      || video.seeking
      || audio.seeking
      || video.readyState < 2
      || audio.readyState < 2
    ) {
      return false;
    }
    retryStarted = true;
    if (session.webkitRetryTimer) {
      window.clearTimeout(session.webkitRetryTimer);
      session.webkitRetryTimer = null;
    }
    reportSplitStartupDiagnostic(
      video.dataset.playerItemId || "",
      video,
      audio,
      `${prefix}-retry-attempt`,
    );
    startSplitPlaybackPair(video, audio, { userGesture });
    return true;
  };

  [video, audio].forEach((media) => {
    ["canplay", "seeked"].forEach((eventName) => {
      addMountedPlayerListener(media, eventName, retryWhenReady);
    });
  });
  let webkitRetryTimer = null;
  webkitRetryTimer = window.setTimeout(() => {
    if (session.webkitRetryTimer !== webkitRetryTimer) {
      return;
    }
    session.webkitRetryTimer = null;
    retryWhenReady();
  }, 50);
  session.webkitRetryTimer = webkitRetryTimer;
  return true;
}

function startSplitPlaybackPair(video, audio, { userGesture = false } = {}) {
  const session = state.hostPlaybackSession;
  if (
    !video
    || !audio
    || !isActiveSplitPlayer(video, audio)
    || !session?.readyCommitted
    || ![
      "ready-paused",
      "start-retry-wait",
      "needs-user-gesture",
      "failed",
    ].includes(session.phase)
    || (session.phase === "failed" && !userGesture)
    || shouldHoldCurrentItemForTransition(video.dataset.playerItemId)
    || isSplitPlayerSeekSettling(video, audio)
    || video.seeking
    || audio.seeking
  ) {
    return false;
  }
  if (
    !userGesture
    && (!state.localShouldBePlaying || !splitPlaybackPairCanStartAutomatically(video, audio))
  ) {
    updateSplitPlaybackStartOverlay(video, audio);
    return false;
  }
  if (state.localPlaybackStartState === "starting") {
    return false;
  }

  state.localShouldBePlaying = true;
  session.logicalPlayIntent = true;
  state.localAudioPlaybackBlocked = false;
  state.localVideoPlaybackBlocked = false;
  state.localPlaybackStartGeneration = Number(state.localPlaybackStartGeneration || 0) + 1;
  const attemptGeneration = state.localPlaybackStartGeneration;
  setSplitPlaybackStartState("starting", video, audio);
  syncSplitPlayerVolumeFromVideo(video, audio);
  const targetAudioTime = clampMediaTime(
    audio,
    Number(video.currentTime || 0) - currentAvOffsetSeconds(),
  );
  setMediaCurrentTime(audio, targetAudioTime);
  resumeAudioContextBestEffort();

  reportSplitStartupDiagnostic(
    video.dataset.playerItemId || "",
    video,
    audio,
    userGesture ? "user-start-attempt" : "autoplay-attempt",
  );

  // Keep these calls adjacent and before any await/Promise callback. WebKit
  // must see both media starts in the same application-owned click stack.
  const videoPlay = invokeMediaPlay(video, { internalVideo: true });
  const audioPlay = invokeMediaPlay(audio);
  const attemptState = state.localPlaybackStartState;

  if (isWebKitPlaybackRuntime()) {
    let policyRejectionHandled = false;
    const prefix = userGesture ? "user-start" : "autoplay";
    const reportPlayRejection = (mediaKind, media, error) => {
      const action = `${prefix}-${mediaKind}-play-rejected`;
      reportMediaDiagnostic(
        video.dataset.playerItemId || "",
        mediaKind,
        media,
        action,
        video,
        audio,
        action,
        error,
      );
    };
    const handleRejection = (mediaKind, error) => {
      if (
        !isActiveSplitPlayer(video, audio)
        || state.localPlaybackStartState !== attemptState
        || state.localPlaybackStartGeneration !== attemptGeneration
        || policyRejectionHandled
      ) {
        return;
      }
      if (isPlaybackPolicyRejection(error)) {
        policyRejectionHandled = true;
        delete video.dataset.bilikaraInternalPlay;
        requireSplitPlaybackUserGesture(
          video,
          audio,
          `${prefix}-${mediaKind}-blocked`,
        );
      }
    };

    const reportPlayResolution = (mediaKind) => {
      if (
        isActiveSplitPlayer(video, audio)
        && state.localPlaybackStartState === attemptState
        && state.localPlaybackStartGeneration === attemptGeneration
      ) {
        reportSplitStartupDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${prefix}-${mediaKind}-play-resolved`,
        );
      }
    };

    videoPlay.then(
      () => reportPlayResolution("video"),
      (error) => {
        reportPlayRejection("video", video, error);
        handleRejection("video", error);
      },
    );
    audioPlay.then(
      () => reportPlayResolution("audio"),
      (error) => {
        reportPlayRejection("audio", audio, error);
        handleRejection("audio", error);
      },
    );

    Promise.all([
      videoPlay.then(
        () => ({ mediaKind: "video", error: null }),
        (error) => ({ mediaKind: "video", error }),
      ),
      audioPlay.then(
        () => ({ mediaKind: "audio", error: null }),
        (error) => ({ mediaKind: "audio", error }),
      ),
    ]).then((results) => {
      if (
        !isActiveSplitPlayer(video, audio)
        || state.localPlaybackStartState !== attemptState
        || state.localPlaybackStartGeneration !== attemptGeneration
        || policyRejectionHandled
      ) {
        return;
      }
      state.localPlaybackStartPromisesSettled = true;
      const failed = results.filter((result) => result.error);
      if (failed.length) {
        delete video.dataset.bilikaraInternalPlay;
        const policyFailure = failed.find((result) => isPlaybackPolicyRejection(result.error));
        if (policyFailure) {
          handleRejection(policyFailure.mediaKind, policyFailure.error);
          return;
        }

        const firstFailure = failed[0];
        reportSplitSyncDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${prefix}-${firstFailure.mediaKind}-aborted`,
        );

        if (!state.localWebKitStartRetryDone) {
          state.localWebKitStartRetryDone = true;
          scheduleWebKitSplitPlaybackRetry(video, audio, { userGesture, prefix });
        } else {
          reportSplitSyncDiagnostic(
            video.dataset.playerItemId || "",
            video,
            audio,
            `${prefix}-${firstFailure.mediaKind}-retry-failed`,
          );
          failSplitPlaybackStartup(video, audio, prefix);
        }
        return;
      }

      if (video.paused || audio.paused) {
        delete video.dataset.bilikaraInternalPlay;
        reportSplitStartupDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${prefix}-resolved-but-still-paused`,
        );
        if (!state.localWebKitStartRetryDone) {
          state.localWebKitStartRetryDone = true;
          scheduleWebKitSplitPlaybackRetry(video, audio, { userGesture, prefix });
        } else {
          failSplitPlaybackStartup(video, audio, prefix, {
            diagnosticAction: "resolved-but-still-paused",
          });
        }
        return;
      }

      delete video.dataset.bilikaraInternalPlay;
      setSplitPlaybackStartState("established", video, audio);
      state.localShouldBePlaying = true;
      syncTauriMediaSessionState(video, { forcePosition: true });
      if (state.localWebKitStartRetryDone) {
        reportSplitStartupDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${prefix}-retry-success`,
        );
      }
      reportSplitStartupDiagnostic(
        video.dataset.playerItemId || "",
        video,
        audio,
        userGesture ? "user-start-success" : "autoplay-success",
      );
      reportSplitSyncDiagnostic(
        video.dataset.playerItemId || "",
        video,
        audio,
        userGesture ? "user-start-success" : "autoplay-success",
        true,
      );
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
    });
    return true;
  }

  Promise.all([
    videoPlay.then(
      () => ({ mediaKind: "video", error: null }),
      (error) => ({ mediaKind: "video", error }),
    ),
    audioPlay.then(
      () => ({ mediaKind: "audio", error: null }),
      (error) => ({ mediaKind: "audio", error }),
    ),
  ]).then((results) => {
    if (
      !isActiveSplitPlayer(video, audio)
      || state.localPlaybackStartState !== attemptState
      || state.localPlaybackStartGeneration !== attemptGeneration
    ) {
      return;
    }
    state.localPlaybackStartPromisesSettled = true;
    const failed = results.filter((result) => result.error);
    if (failed.length) {
      delete video.dataset.bilikaraInternalPlay;
      const policyFailure = failed.find((result) => isPlaybackPolicyRejection(result.error));
      const prefix = userGesture ? "user-start" : "autoplay";
      if (policyFailure) {
        requireSplitPlaybackUserGesture(
          video,
          audio,
          `${prefix}-${policyFailure.mediaKind}-blocked`,
        );
      } else {
        const failure = failed[0];
        reportSplitSyncDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${prefix}-${failure.mediaKind}-failed`,
          true,
        );
        failSplitPlaybackStartup(video, audio, prefix, {
          diagnosticAction: `${prefix}-${failure.mediaKind}-failed`,
        });
      }
      return;
    }
    if (video.paused || audio.paused) {
      failSplitPlaybackStartup(video, audio, userGesture ? "user-start" : "autoplay", {
        diagnosticAction: "resolved-but-still-paused",
      });
      return;
    }
    delete video.dataset.bilikaraInternalPlay;
    setSplitPlaybackStartState("established", video, audio);
    state.localShouldBePlaying = true;
    syncTauriMediaSessionState(video, { forcePosition: true });
    reportSplitStartupDiagnostic(
      video.dataset.playerItemId || "",
      video,
      audio,
      userGesture ? "user-start-success" : "autoplay-success",
    );
    reportSplitSyncDiagnostic(
      video.dataset.playerItemId || "",
      video,
      audio,
      userGesture ? "user-start-success" : "autoplay-success",
      true,
    );
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  });
  return true;
}

function createSplitPlaybackStartOverlay(video, audio) {
  const overlay = document.createElement("div");
  overlay.className = "split-playback-start-overlay hidden";
  overlay.setAttribute("aria-hidden", "true");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "split-playback-start-button";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    requestSplitPlaybackStartFromUserGesture(video, audio, "overlay-start-intent");
  });
  overlay.appendChild(button);
  elements.playerFrame.appendChild(overlay);
  updateSplitPlaybackStartOverlay(video, audio);
  return overlay;
}

function playMediaBestEffort(
  media,
  { internalVideo = false, video = null, audio = null, mediaKind = "media" } = {},
) {
  const guardPendingPlay = isWebKitPlaybackRuntime();
  if (
    !media
    || !media.paused
    || media.ended
    || (guardPendingPlay && mediaPlayPromisesInFlight.has(media))
  ) {
    return false;
  }
  if (guardPendingPlay) {
    mediaPlayPromisesInFlight.add(media);
  }
  invokeMediaPlay(media, { internalVideo }).then(
    () => {
      if (guardPendingPlay) {
        mediaPlayPromisesInFlight.delete(media);
      }
      if (internalVideo) {
        delete media.dataset.bilikaraInternalPlay;
      }
    },
    (error) => {
      if (guardPendingPlay) {
        mediaPlayPromisesInFlight.delete(media);
      }
      if (internalVideo) {
        delete media.dataset.bilikaraInternalPlay;
      }
      if (video && audio && isPlaybackPolicyRejection(error)) {
        requireSplitPlaybackUserGesture(video, audio, `${mediaKind}-playback-blocked`);
      } else if (video && audio) {
        reportSplitSyncDiagnostic(
          video.dataset.playerItemId || "",
          video,
          audio,
          `${mediaKind}-playback-failed`,
        );
      }
    },
  );
  return true;
}

function seekVideoForNavigation(video, targetTime) {
  video.dataset.bilikaraInternalSeek = "true";
  const changed = setMediaCurrentTime(video, targetTime);
  if (!changed) {
    delete video.dataset.bilikaraInternalSeek;
  }
  return changed;
}

function syncSplitPlayer(video, audio, offsetSeconds, forceCorrection = false) {
  if (!video || !audio || !isActiveSplitPlayer(video, audio)) {
    return "none";
  }
  if (audio.ended) {
    return "none";
  }

  syncSplitPlayerVolumeFromVideo(video, audio);
  const requestedRate = Number(state.localPlayerRequestedRate || video.playbackRate || 1) || 1;
  if (Math.abs(audio.playbackRate - requestedRate) > 0.001) {
    audio.playbackRate = requestedRate;
  }
  if (Math.abs(video.playbackRate - requestedRate) > 0.001) {
    video.playbackRate = requestedRate;
  }

  const reportAction = (action, force = false) => {
    reportSplitSyncDiagnostic(video.dataset.playerItemId || "", video, audio, action, force);
    return action;
  };
  const isWebKit = isWebKitPlaybackRuntime();

  if (shouldHoldCurrentItemForTransition(video.dataset.playerItemId)) {
    state.localShouldBePlaying = false;
    if (!audio.paused) {
      audio.pause();
    }
    if (!video.paused) {
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
    }
    return reportAction("transition-hold");
  }

  if (isSplitPlayerSeekSettling(video, audio)) {
    if (!audio.paused) {
      audio.pause();
    }
    return reportAction("pause");
  }

  if (video.seeking) {
    if (!audio.paused) {
      audio.pause();
    }
    return reportAction("pause");
  }
  if (audio.seeking) {
    return reportAction("wait-for-audio");
  }

  if (state.localPlaybackStartState === "needs-user-gesture") {
    return reportAction("user-start-required");
  }
  if (state.localPlaybackStartState === "startup-failed") {
    return reportAction("startup-failed");
  }
  if (
    state.localPlaybackStartState === "pending"
    || state.localPlaybackStartState === "starting"
  ) {
    return reportAction("startup-pending");
  }

  if (!state.localShouldBePlaying) {
    if (!audio.paused) {
      audio.pause();
    }
    return reportAction("pause");
  }

  const videoTime = Number(video.currentTime || 0);
  if (video.ended) {
    if (audio.readyState >= 2 && !state.localAudioPlaybackBlocked) {
      playMediaBestEffort(audio, { video, audio, mediaKind: "audio" });
    }
    return reportAction("finish-audio");
  }

  if (video.readyState < 2 || state.localVideoPlaybackBlocked) {
    state.localVideoDeferredRecovery = true;
    if (!isWebKit && !audio.paused) {
      audio.pause();
    }
    return reportAction("wait-for-video");
  }

  const rawTargetAudioTime = videoTime - offsetSeconds;
  if (rawTargetAudioTime < 0) {
    if (!audio.paused) {
      audio.pause();
    }
    state.localVideoDeferredRecovery = false;
    state.localVideoHeldForAudio = false;
    playMediaBestEffort(video, {
      internalVideo: true,
      video,
      audio,
      mediaKind: "video",
    });
    return reportAction("start");
  }

  if (audio.readyState < 2 || state.localAudioPlaybackBlocked) {
    holdVideoForAudio(video);
    return reportAction("wait-for-audio");
  }

  const audioTime = Number(audio.currentTime || 0);
  const targetAudioTime = clampMediaTime(audio, rawTargetAudioTime);
  const drift = audioTime - targetAudioTime;
  const absoluteDrift = Math.abs(drift);

  const recovering = state.localVideoDeferredRecovery || state.localVideoHeldForAudio;
  const recoveringFromWebKitVideoStarvation = isWebKit && state.localVideoDeferredRecovery;
  const now = Date.now();
  const seekThreshold = isWebKit
    ? localPlayerHardSyncThresholdSeconds
    : forceCorrection
      ? localPlayerForceSyncEpsilonSeconds
      : recovering
        ? localPlayerDriftToleranceSeconds
        : absoluteDrift >= localPlayerHardSyncThresholdSeconds
          ? localPlayerHardSyncThresholdSeconds
          : localPlayerModerateSyncThresholdSeconds;
  const seekAllowed = (!isWebKit && forceCorrection)
    || now - state.localPlayerSyncLastSeekAt >= localPlayerSyncSeekCooldownMs;
  let action = "none";
  if (!recoveringFromWebKitVideoStarvation && absoluteDrift >= seekThreshold && seekAllowed) {
    if (setMediaCurrentTime(audio, targetAudioTime)) {
      state.localPlayerSyncLastSeekAt = now;
      action = "audio-drift-correction";
    }
  }

  state.localVideoDeferredRecovery = false;
  state.localVideoHeldForAudio = false;
  playMediaBestEffort(video, {
    internalVideo: true,
    video,
    audio,
    mediaKind: "video",
  });
  if (targetAudioTime < Number(audio.duration || Number.POSITIVE_INFINITY) - localPlayerForceSyncEpsilonSeconds) {
    playMediaBestEffort(audio, { video, audio, mediaKind: "audio" });
  }
  if (action === "none" && recovering) {
    action = "resume";
  }
  return reportAction(action, action === "audio-drift-correction");
}

function syncMountedLocalPlayer(forceCorrection = false) {
  const { video, audio } = activeLocalPlayerElements();
  if (!video || !audio) {
    return;
  }
  syncSplitPlayer(video, audio, currentAvOffsetSeconds(), forceCorrection);
}

function resyncMountedLocalPlayerForOffsetChange() {
  const { video, audio } = activeLocalPlayerElements();
  if (!video || !audio) {
    return;
  }
  const rawTargetAudioTime = Number(video.currentTime || 0) - currentAvOffsetSeconds();
  const targetAudioTime = clampMediaTime(audio, rawTargetAudioTime);
  const audioRepositioned = audio.readyState >= 1
    && setMediaCurrentTime(audio, targetAudioTime);
  const shouldContinuePlaying = Boolean(
    (state.localShouldBePlaying || !video.paused)
    && !video.ended
    && !audio.ended
    && !state.localPlaybackEndHandled
    && !shouldHoldCurrentItemForTransition(video.dataset.playerItemId),
  );

  if (!shouldContinuePlaying || rawTargetAudioTime < 0) {
    if (!audio.paused) {
      audio.pause();
    }
  } else if (
    state.localPlaybackStartState === "established"
    && audio.readyState >= 2
    && !state.localAudioPlaybackBlocked
  ) {
    playMediaBestEffort(audio, { video, audio, mediaKind: "audio" });
  }

  if (audioRepositioned) {
    reportSplitSyncDiagnostic(
      video.dataset.playerItemId || "",
      video,
      audio,
      "av-delay-audio-resync",
      true,
    );
  }
  return audioRepositioned;
}

function resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs) {
  if (Number(previousOffsetMs) === currentAvOffsetMs()) {
    return false;
  }
  resyncMountedLocalPlayerForOffsetChange();
  return true;
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
  const muteLabel = state.localPlayerMuted ? t("player.unmute") : t("player.mute");
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

function renderKeyShiftControls(playbackMode) {
  if (!elements.keyShiftPanel || !elements.keyShiftInput) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  setClassToggle(elements.keyShiftPanel, "hidden", !isLocalMode);

  const keyShift = Number(state.data?.player_settings?.key_shift ?? 0);
  if (document.activeElement !== elements.keyShiftInput) {
    elements.keyShiftInput.value = String(keyShift);
  }

  if (elements.keyShiftResetButton) {
    elements.keyShiftResetButton.disabled = keyShift === 0;
  }
}

async function setLocalPlayerKeyShift(keyShift) {
  const boundedKeyShift = Math.max(-6, Math.min(6, Number(keyShift || 0)));
  const requestSeq = markLocalVolumeWrite();

  const { audio } = activeLocalPlayerElements();
  if (audio) {
    applyKeyShiftToAudio(audio, boundedKeyShift);
  }

  if (state.data && state.data.player_settings) {
    state.data.player_settings.key_shift = boundedKeyShift;
  }
  renderKeyShiftControls(frontendPlaybackMode(state.data?.playback_mode));

  try {
    const nextData = await apiPost("/api/player/key-shift", { key_shift: boundedKeyShift });
    const accepted = acceptHostStateSnapshot(nextData);
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    if (accepted) {
      syncLocalPlayerSettingsFromSnapshot(state.data?.player_settings);
    }
    renderKeyShiftControls(frontendPlaybackMode(state.data?.playback_mode));
  } catch (error) {
    // Ignore or handle errors gracefully
  }
}

function disposeAudioPitchProcessor(audio) {
  if (!audio?.jungle) {
    return;
  }
  try {
    audio.jungle.dispose();
  } catch {
    // A partially initialized or already-disposed graph must not block playback cleanup.
  }
  audio.jungle = null;
  audio.bilikaraPitchRoute = "";
}

function disconnectAudioPitchSource(audio) {
  if (!audio?.bilikaraPitchSource) {
    return;
  }
  try {
    audio.bilikaraPitchSource.disconnect();
  } catch {
    // Disconnect is idempotent across route changes and teardown.
  }
  audio.bilikaraPitchRoute = "";
}

function disposeAudioPitchShifter(audio) {
  if (!audio) {
    return;
  }
  disposeAudioPitchProcessor(audio);
  disconnectAudioPitchSource(audio);
  audio.bilikaraPitchSource = null;
}

function disposeSharedAudioContext() {
  const audioContext = state.audioContext;
  state.audioContext = null;
  if (!audioContext || audioContext.state === "closed") {
    return;
  }
  try {
    const closeResult = audioContext.close?.();
    closeResult?.catch?.(() => {});
  } catch {
    // Page and reset teardown must remain best-effort across browser implementations.
  }
}

function resumeAudioContextBestEffort() {
  const audioContext = state.audioContext;
  if (!audioContext || audioContext.state !== "suspended") {
    return;
  }
  try {
    const resumeResult = audioContext.resume?.();
    resumeResult?.catch?.(() => {});
  } catch {
    // Autoplay policy and browser teardown races must not interrupt playback control.
  }
}

function ensureAudioPitchSource(audio) {
  if (audio.bilikaraPitchSource) {
    return audio.bilikaraPitchSource;
  }
  if (!window.AudioContext && !window.webkitAudioContext) {
    return null;
  }
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  addMountedPlayerListener(audio, "play", resumeAudioContextBestEffort);
  audio.bilikaraPitchSource = state.audioContext.createMediaElementSource(audio);
  return audio.bilikaraPitchSource;
}

function setupAudioPitchShifter(audio) {
  applyKeyShiftToAudio(audio);
}

function applyKeyShiftToAudio(audio, overrideKeyShift = null) {
  if (!audio) {
    return;
  }
  const rawKeyShift = overrideKeyShift !== null
    ? Number(overrideKeyShift)
    : Number(state.data?.player_settings?.key_shift ?? 0);
  const keyShift = Number.isFinite(rawKeyShift) ? Math.max(-6, Math.min(6, rawKeyShift)) : 0;

  if (keyShift === 0) {
    if (!audio.jungle) {
      return;
    }
    disposeAudioPitchProcessor(audio);
    const source = audio.bilikaraPitchSource;
    if (!source || !state.audioContext) {
      return;
    }
    disconnectAudioPitchSource(audio);
    source.connect(state.audioContext.destination);
    audio.bilikaraPitchRoute = "direct";
    return;
  }

  try {
    const source = ensureAudioPitchSource(audio);
    if (!source || !state.audioContext) {
      return;
    }
    if (!audio.jungle) {
      disconnectAudioPitchSource(audio);
      const jungle = new Jungle(state.audioContext);
      audio.jungle = jungle;
      source.connect(jungle.input);
      jungle.output.connect(state.audioContext.destination);
      audio.bilikaraPitchRoute = "processor";
      if (audio.paused === false) {
        resumeAudioContextBestEffort();
      }
    }
    const ratio = Math.pow(2, keyShift / 12);
    audio.jungle.setPitchOffset(ratio - 1);
  } catch (error) {
    disposeAudioPitchProcessor(audio);
    const source = audio.bilikaraPitchSource;
    if (source && state.audioContext) {
      disconnectAudioPitchSource(audio);
      try {
        source.connect(state.audioContext.destination);
        audio.bilikaraPitchRoute = "direct";
      } catch {
        // If Web Audio setup failed, leave the native media lifecycle intact.
      }
    }
    console.error("Failed to setup Web Audio pitch shifter:", error);
  }
}

function persistLocalVolumePreferences() {
  writeLocalPreference(storageKeys.playerVolume, state.localPlayerVolume);
  writeLocalPreference(storageKeys.playerMuted, state.localPlayerMuted);
}

async function setLocalPlayerVolumeAndMuted(
  nextVolume,
  nextMuted,
  { reportError = true } = {},
) {
  const normalizedVolume = Math.max(0, Math.min(1, Number(nextVolume || 0)));
  const normalizedMuted = Boolean(nextMuted);
  const previousVolume = state.localPlayerVolume;
  const previousMuted = state.localPlayerMuted;
  const requestSeq = markLocalVolumeWrite();
  state.localPlayerVolume = normalizedVolume;
  state.localPlayerMuted = normalizedMuted;
  persistLocalVolumePreferences();
  applyStoredVolumeToMountedPlayer();
  renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
  try {
    const nextData = await apiPost("/api/player/volume", {
      volume_percent: Math.round(normalizedVolume * 100),
      is_muted: state.localPlayerMuted,
    });
    const accepted = acceptHostStateSnapshot(nextData);
    if (requestSeq !== state.volumeSaveSeq) {
      return;
    }
    if (accepted) {
      render();
    }
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
    if (reportError) {
      setAppMessage(error.message, true);
    }
    throw error;
  }
}

async function setLocalPlayerVolume(nextVolume, { unmute = true } = {}) {
  const normalizedVolume = Math.max(0, Math.min(1, Number(nextVolume || 0)));
  const nextMuted = unmute && normalizedVolume > 0 ? false : state.localPlayerMuted;
  try {
    await setLocalPlayerVolumeAndMuted(normalizedVolume, nextMuted);
  } catch {
    // The shared setter already restored the previous state and reported the error.
  }
}

async function toggleLocalPlayerMute() {
  try {
    await setLocalPlayerVolumeAndMuted(state.localPlayerVolume, !state.localPlayerMuted);
  } catch {
    // The shared setter already restored the previous state and reported the error.
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
    const signature = JSON.stringify({ hidden: true, playbackMode, itemId: currentItem?.id || "", language: state.language });
    if (signature === state.audioVariantBarRenderSignature) {
      return;
    }
    state.audioVariantBarRenderSignature = signature;
    if (elements.audioVariantBar.childElementCount) {
      elements.audioVariantBar.replaceChildren();
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
      language: state.language,
    });
    if (signature === state.audioVariantBarRenderSignature) {
      return;
    }
    state.audioVariantBarRenderSignature = signature;
    if (elements.audioVariantBar.childElementCount) {
      elements.audioVariantBar.replaceChildren();
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
    language: state.language,
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

  elements.audioVariantBar.replaceChildren();
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
  toggleButton.setAttribute("aria-label", state.audioVariantBarExpanded ? t("player.collapseParts") : t("player.expandParts"));
  toggleButton.setAttribute("aria-expanded", String(state.audioVariantBarExpanded));
  const toggleIcon = document.createElement("span");
  toggleIcon.setAttribute("aria-hidden", "true");
  toggleIcon.textContent = "▾";
  toggleButton.appendChild(toggleIcon);

  elements.audioVariantBar.append(list, toggleButton);
  elements.audioVariantBar.classList.remove("is-collapsed", "is-expanded");
  setClassToggle(elements.audioVariantBar, "hidden", false);

  requestAnimationFrame(() => {
    if (!elements.audioVariantBar.contains(list)) {
      return;
    }
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
  });
}

function renderAvSyncControls(playbackMode, playerSettings) {
  if (!elements.avSyncPanel || !elements.avOffsetInput) {
    return;
  }

  const isLocalMode = playbackMode === "local";
  elements.avSyncPanel.classList.toggle("hidden", !isLocalMode);
  const offsetMs = currentAvOffsetMs();
  const delayState = playerSettings?.av_delay || {};
  elements.avOffsetInput.disabled = state.avOffsetSaving;
  elements.avSyncPanel.querySelectorAll("button[data-step]").forEach((button) => {
    button.disabled = state.avOffsetSaving;
  });
  if (elements.avOffsetResetButton) {
    elements.avOffsetResetButton.disabled = state.avOffsetSaving || !Boolean(delayState.has_local_adjustment);
  }
  if (elements.avDelayLockButton) {
    const locked = Boolean(delayState.locked);
    const hasLocal = Boolean(delayState.has_local_adjustment);
    elements.avDelayLockButton.textContent = locked ? "🔒" : "🔓";
    elements.avDelayLockButton.disabled = state.avOffsetSaving || !Boolean(delayState.lock_button_enabled);
    elements.avDelayLockButton.dataset.locked = String(locked);
    elements.avDelayLockButton.dataset.hasLocal = String(hasLocal);
    elements.avDelayLockButton.setAttribute("aria-pressed", String(locked));
    const labelKey = locked
      ? hasLocal ? "player.unlockAvDelayAdjusted" : "player.unlockAvDelay"
      : hasLocal ? "player.lockAvDelayAdjusted" : "player.lockAvDelay";
    elements.avDelayLockButton.setAttribute("aria-label", t(labelKey));
    elements.avDelayLockButton.title = t(labelKey);
  }
  if (document.activeElement !== elements.avOffsetInput || state.avOffsetSaving) {
    elements.avOffsetInput.value = String(offsetMs);
  }
}

function createSplitPlayerStartupSynchronizer(video, audio, maybeRestorePlayback) {
  return () => {
    const session = state.hostPlaybackSession;
    if (state.hostPlaybackSession !== session || !isActiveSplitPlayer(video, audio)) {
      return false;
    }
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
      return true;
    }
    if (session.readyCommitted || session.phase !== "binding") {
      return false;
    }
    if (!splitPlaybackPairCanStartAutomatically(video, audio)) {
      updateSplitPlaybackStartOverlay(video, audio);
      return true;
    }
    if (!session.restoreStarted && maybeRestorePlayback()) {
      session.restoreStarted = true;
      return true;
    }
    return commitHostPlaybackSessionReadyPaused(session, video, audio);
  };
}

function hostPlaybackMountData(currentItem, program = state.data?.playback_program) {
  return {
    videoUrl: selectedVideoUrlForItem(currentItem),
    audioUrl: selectedAudioUrlForItem(currentItem),
    mountable: Boolean(program?.artifact_set_id),
  };
}

function createHostPlaybackSession(playbackGeneration, playbackProgram) {
  return {
    playbackGeneration,
    playbackProgram,
    phase: "requested",
    video: null,
    audio: null,
    mountData: null,
    loadingStarted: false,
    readyCommitted: false,
    readyCommitCount: 0,
    statusSequence: 0,
    lastReportedStatusSignature: "",
    lastStatusHeartbeatAt: 0,
    logicalPlayIntent: true,
    initialIntentApplied: false,
    restoreStarted: false,
    failureStage: "",
    eventCleanups: [],
    syncTimer: null,
    startupTimer: null,
    startupWatchdogTimer: null,
    webkitRetryTimer: null,
    audioStarvationTimer: null,
    hiddenPauseTimer: null,
    frameClickTimer: null,
    seekSettling: false,
    seekResumeAfterSettle: false,
    seekSettleStartedAt: 0,
    seekSettleTimer: null,
    seekSettleCallback: null,
    seekResumePending: false,
    seekUpdatesLogicalIntent: true,
    playbackRestore: null,
    ownershipClaimStarted: false,
    ownershipClaimed: false,
    ownershipClaimFailed: false,
    ownershipClaimRequest: null,
    retirementReleaseSent: false,
  };
}

function isCurrentHostPlaybackSession(session, video, audio) {
  if (
    !session
    || state.hostPlaybackSession !== session
    || session.phase === "retiring"
    || session.phase === "retired"
    || state.data?.playback_generation !== session.playbackGeneration
    || !playbackProgramDescriptorsEqual(
      state.data?.playback_program ?? null,
      session.playbackProgram,
    )
  ) {
    return false;
  }
  if (video !== undefined && session.video !== video) {
    return false;
  }
  if (audio !== undefined && session.audio !== audio) {
    return false;
  }
  return true;
}

function retireHostPlaybackSession(
  session,
  { preserveAdvanceDelayOverlay = false } = {},
) {
  if (
    !session
    || session.phase === "retiring"
    || session.phase === "retired"
  ) {
    return false;
  }
  const ownsCurrentSession = state.hostPlaybackSession === session;
  setHostPlaybackSessionPhase(session, "retiring");
  clearLocalPlayerEventListeners(session);
  clearWebKitAudioStarvationTimer(session);
  clearLocalPlayerSyncTimer(session);
  clearPlayerFrameClickTimer(session);
  clearLocalPlayerSeekState(session);
  session.playbackRestore = null;

  if (ownsCurrentSession) {
    state.localWebKitStartRetryDone = false;
    clearLocalPlayerControlsHideTimer();
    state.localPlayerSyncLastSeekAt = 0;
    state.localPlayerSyncLastAction = "";
    state.localPlayerSyncLastDiagnosticAt = 0;
    state.localVideoHeldForAudio = false;
    state.localVideoDeferredRecovery = false;
    state.localAudioPlaybackBlocked = false;
    state.localVideoPlaybackBlocked = false;
    state.localPlaybackStartGeneration = 0;
    state.localPlaybackStartPromisesSettled = false;
    state.localPlaybackEndHandled = false;
    clearTauriMediaSessionState();
    if (!preserveAdvanceDelayOverlay) {
      state.pendingSongTransitionOverlayData = null;
      state.pendingSongTransitionGeneration = 0;
      clearLocalAdvanceDelay({ resetInFlight: true });
    }
  }

  const retiredMedia = [session.video, session.audio].filter(Boolean);
  retiredMedia.forEach((media) => {
    disposeAudioPitchShifter(media);
    try {
      media.pause();
    } catch {
      // Ignore pause failures during exact session retirement.
    }
    try {
      media.removeAttribute("src");
      media.load();
    } catch {
      // Detached media can finish retiring without further cleanup.
    }
  });
  session.video = null;
  session.audio = null;
  session.mountData = null;
  setHostPlaybackSessionPhase(session, "retired");
  if (state.hostPlaybackSession === session) {
    state.hostPlaybackSession = null;
  }
  acknowledgeRetiredHostPlaybackSession(session);
  return true;
}

function acknowledgeRetiredHostPlaybackSession(session) {
  const identity = exactHostPlaybackOwnershipIdentity(session);
  if (
    !identity
    || !session.ownershipClaimStarted
    || session.retirementReleaseSent
  ) {
    return false;
  }
  session.retirementReleaseSent = true;
  apiPost("/api/player/retire-program", identity).catch(() => {
    // A lost retirement acknowledgement fails closed on the Host server.
  });
  return true;
}

function exactHostPlaybackOwnershipIdentity(session) {
  const playbackGeneration = Number(session?.playbackGeneration);
  const itemIncarnationId = String(
    session?.playbackProgram?.item_incarnation_id || "",
  );
  const artifactSetId = String(
    session?.playbackProgram?.artifact_set_id || "",
  );
  if (
    !session
    || !Number.isSafeInteger(playbackGeneration)
    || playbackGeneration < 1
    || !itemIncarnationId
    || !artifactSetId
  ) {
    return null;
  }
  return {
    playback_generation: playbackGeneration,
    item_incarnation_id: itemIncarnationId,
    artifact_set_id: artifactSetId,
  };
}

function failHostPlaybackOwnershipClaim(session) {
  if (
    !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
    || session.phase !== "binding"
    || session.loadingStarted
  ) {
    return false;
  }
  session.ownershipClaimFailed = true;
  session.failureStage = "artifact-ownership";
  retireHostPlaybackSession(session);
  state.hostPlaybackSession = session;
  renderPreparingHostPlaybackState(state.data?.current_item ?? null);
  return true;
}

function beginHostPlaybackSessionOwnershipClaim(session) {
  if (
    !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
    || session.phase !== "binding"
    || session.loadingStarted
    || session.ownershipClaimStarted
  ) {
    return false;
  }
  const identity = exactHostPlaybackOwnershipIdentity(session);
  if (!identity) {
    failHostPlaybackOwnershipClaim(session);
    return false;
  }
  session.ownershipClaimStarted = true;
  session.ownershipClaimRequest = Promise.resolve()
    .then(() => apiPost("/api/player/claim-program", identity))
    .then(
      (result) => {
        if (result?.claimed !== true) {
          failHostPlaybackOwnershipClaim(session);
          return;
        }
        session.ownershipClaimed = true;
        if (!isCurrentHostPlaybackSession(session, session.video, session.audio)) {
          return;
        }
        if (!beginHostPlaybackSessionElementLoading(session)) {
          failHostPlaybackCandidate(
            session,
            session.video,
            session.audio,
            "media-loading-could-not-start",
          );
        }
      },
      () => {
        failHostPlaybackOwnershipClaim(session);
      },
    );
  return true;
}

function replaceHostPlayerView(...nodes) {
  const overlay = playerDelayOverlay();
  elements.playerFrame.replaceChildren(...nodes);
  if (overlay) {
    elements.playerFrame.appendChild(overlay);
  }
}

function renderEmptyHostPlaybackState() {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const text = document.createElement("p");
  text.textContent = t("player.emptyShort");
  empty.appendChild(text);
  replaceHostPlayerView(empty);
}

function renderPreparingHostPlaybackState(currentItem) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const text = document.createElement("p");
  text.textContent = t("player.preparingTracks");
  const hint = document.createElement("p");
  hint.className = "empty-hint";
  hint.textContent = hostCacheDetailTextForItem(currentItem) || t("player.cachingFallback");
  empty.append(text, hint);
  replaceHostPlayerView(empty);
}

function captureHostPlaybackRestoreForReplacement(session, nextProgram, currentItem) {
  if (
    state.pendingPlaybackRestore
    || !session
    || !session.readyCommitted
    || session.phase === "retiring"
    || session.phase === "retired"
    || state.hostPlaybackSession !== session
    || !session.video
    || !session.audio
    || !session.playbackProgram?.artifact_set_id
    || !nextProgram?.artifact_set_id
    || session.playbackProgram.item_id !== nextProgram.item_id
    || session.playbackProgram.item_incarnation_id !== nextProgram.item_incarnation_id
    || playbackProgramDescriptorsEqual(session.playbackProgram, nextProgram)
  ) {
    return;
  }
  captureLocalPlayerPreferences();
  state.pendingPlaybackRestore = {
    itemId: currentItem.id,
    itemIncarnationId: nextProgram.item_incarnation_id,
    variantId: nextProgram.selected_audio_variant_id,
    currentTime: Number(session.video.currentTime || 0),
    wasPlaying: Boolean(session.logicalPlayIntent),
  };
}

function claimPendingHostPlaybackRestore(session, currentItem) {
  const pendingRestore = state.pendingPlaybackRestore;
  if (!pendingRestore) {
    return null;
  }
  if (
    pendingRestore.itemIncarnationId !== currentItem.item_incarnation_id
    || pendingRestore.itemIncarnationId !== session.playbackProgram?.item_incarnation_id
  ) {
    state.pendingPlaybackRestore = null;
    return null;
  }
  if (
    pendingRestore.itemId !== currentItem.id
    || pendingRestore.variantId !== session.playbackProgram?.selected_audio_variant_id
  ) {
    return null;
  }
  state.pendingPlaybackRestore = null;
  return pendingRestore;
}

function mountHostPlaybackSessionElements(session, currentItem, mountData) {
  const video = document.createElement("video");
  video.dataset.playerRole = "video";
  video.controls = false;
  video.removeAttribute("controls");
  video.setAttribute("controlsList", "nofullscreen");
  // Start the split pair together once both streams expose metadata. Waiting
  // for canplay deadlocks WebKit when the video intentionally preloads metadata.
  video.autoplay = false;
  video.playsInline = true;
  video.tabIndex = 0;
  video.preload = "metadata";
  const audio = document.createElement("audio");
  audio.dataset.playerRole = "audio";
  audio.preload = "auto";
  video.dataset.playerItemId = currentItem.id;
  session.video = video;
  session.audio = audio;
  session.mountData = mountData;
  replaceHostPlayerView(video, audio);
  return { video, audio };
}

function beginHostPlaybackSessionElementLoading(session) {
  if (
    !isCurrentHostPlaybackSession(session, session?.video, session?.audio)
    || session.phase !== "binding"
    || session.loadingStarted
    || !session.mountData?.videoUrl
    || !session.mountData?.audioUrl
  ) {
    return false;
  }
  session.loadingStarted = true;
  session.video.src = session.mountData.videoUrl;
  session.audio.src = session.mountData.audioUrl;
  session.video.load();
  session.audio.load();
  scheduleSplitPlaybackStartupWatchdog(session.video, session.audio);
  return true;
}

function reconcileHostPlaybackSession(currentItem) {
  const playbackGeneration = state.data?.playback_generation;
  const playbackProgram = state.data?.playback_program ?? null;
  const existing = state.hostPlaybackSession;

  if (!playbackProgram || !currentItem) {
    retireHostPlaybackSession(existing);
    state.pendingPlaybackRestore = null;
    renderEmptyHostPlaybackState();
    return { kind: "empty", session: null, video: null, audio: null };
  }

  if (
    state.hostPlaybackBootstrapRestartPending
    || state.pageHidePlaybackRestartRequired
  ) {
    if (
      !existing
      || existing.playbackGeneration !== playbackGeneration
      || !playbackProgramDescriptorsEqual(existing.playbackProgram, playbackProgram)
    ) {
      retireHostPlaybackSession(existing);
      const retiredSession = createHostPlaybackSession(
        playbackGeneration,
        playbackProgram,
      );
      setHostPlaybackSessionPhase(retiredSession, "retired");
      state.hostPlaybackSession = retiredSession;
      return {
        kind: "retired",
        session: retiredSession,
        video: null,
        audio: null,
      };
    }
    retireHostPlaybackSession(existing);
    return { kind: "retired", session: existing, video: null, audio: null };
  }

  const sameAcceptedProgram = Boolean(
    existing
    && existing.playbackGeneration === playbackGeneration
    && playbackProgramDescriptorsEqual(existing.playbackProgram, playbackProgram)
  );
  if (sameAcceptedProgram) {
    if (existing.phase === "retiring" || existing.phase === "retired") {
      return { kind: "retired", session: existing, video: null, audio: null };
    }
    if (existing.video || existing.audio) {
      if (!existing.video || !existing.audio) {
        return { kind: "inconsistent", session: existing, video: null, audio: null };
      }
      return {
        kind: "reused",
        session: existing,
        video: existing.video,
        audio: existing.audio,
      };
    }
    renderPreparingHostPlaybackState(currentItem);
    return { kind: "pending", session: existing, video: null, audio: null };
  }

  if (existing && playbackGeneration <= existing.playbackGeneration) {
    return {
      kind: "stale",
      session: existing,
      video: existing.video,
      audio: existing.audio,
    };
  }
  if (
    state.pendingPlaybackRestore
    && state.pendingPlaybackRestore.itemId !== currentItem.id
  ) {
    state.pendingPlaybackRestore = null;
  }
  captureHostPlaybackRestoreForReplacement(existing, playbackProgram, currentItem);
  const preserveAdvanceDelayOverlay = Boolean(
    hasPendingSongTransitionOverlayForItem(currentItem)
    || hasLocalAdvanceDelayOverlay()
    || (
      state.localAdvanceInFlight
      && state.manualTransitionHoldGeneration > 0
      && state.manualTransitionHoldItemId
    )
  );
  const preservedTransitionGeneration = (
    existing
    && hasLocalAdvanceDelayOverlay()
    && state.localAdvanceDelayItemId === currentItem.id
    && state.manualTransitionHoldItemId === currentItem.id
    && state.manualTransitionHoldGeneration > 0
  ) ? state.manualTransitionHoldGeneration : 0;
  const mountData = hostPlaybackMountData(currentItem, playbackProgram);
  retireHostPlaybackSession(existing, { preserveAdvanceDelayOverlay });

  const session = createHostPlaybackSession(playbackGeneration, playbackProgram);
  state.hostPlaybackSession = session;
  session.playbackRestore = mountData.mountable
    ? claimPendingHostPlaybackRestore(session, currentItem)
    : null;
  session.logicalPlayIntent = session.playbackRestore
    ? Boolean(session.playbackRestore.wasPlaying)
    : true;
  state.localShouldBePlaying = shouldHoldCurrentItemForTransition(currentItem)
    ? false
    : session.logicalPlayIntent;
  if (!mountData.mountable) {
    setHostPlaybackSessionPhase(session, "requested");
    renderPreparingHostPlaybackState(currentItem);
    return { kind: "pending", session, video: null, audio: null };
  }
  setHostPlaybackSessionPhase(session, "binding");
  const pair = mountHostPlaybackSessionElements(session, currentItem, mountData);
  if (preservedTransitionGeneration) {
    showSongTransitionOverlayForData(state.data, preservedTransitionGeneration, {
      preserveDeadline: true,
    });
  }
  return { kind: "mounted", session, ...pair };
}

function renderPlayer(currentItem, playbackMode) {
  handleRatingCurrentItemChange(currentItem);
  const reconciliation = reconcileHostPlaybackSession(currentItem);
  if (reconciliation.kind !== "mounted") {
    return;
  }
  const { session, video, audio } = reconciliation;

  state.localPlayerRequestedRate = Number(video.playbackRate || 1) || 1;
  applyStoredVolumeToSplitPlayer(video, audio);
  setupAudioPitchShifter(audio);
  attachSplitPlayerDiagnostics(currentItem.id, video, audio);
  createSplitPlaybackStartOverlay(video, audio);
  ensureTauriMediaSessionHandlers();
  syncTauriMediaSessionState(video, { forcePosition: true });
  ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "seeked", "volumechange"].forEach((eventName) => {
    addMountedPlayerListener(video, eventName, () => {
      publishPresentationPlaybackState(session).catch(() => {});
    });
  });

  const reportCurrentVideoStatus = () => {
    reportPlayerStatus(currentItem.id, video, session);
  };

  let restoreApplied = false;
  const maybeRestorePlayback = () => {
    const pendingRestore = session.playbackRestore;
    if (
      restoreApplied
      || !pendingRestore
      || pendingRestore.itemId !== currentItem.id
      || pendingRestore.variantId !== selectedAudioVariantForItem(currentItem)?.id
    ) {
      return false;
    }

    restoreApplied = true;
    session.playbackRestore = null;
    const started = beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek: false,
      allowUncommitted: true,
      updateIntent: false,
      targetTime: pendingRestore.currentTime,
      diagnosticAction: "restore-video-seek",
      onSettled: (applied) => {
        if (!applied) {
          return;
        }
        reportCurrentVideoStatus();
        commitHostPlaybackSessionReadyPaused(session, video, audio);
      },
    });
    if (!started) {
      failHostPlaybackCandidate(
        session,
        video,
        audio,
        "restore-seek-could-not-start",
      );
    }
    return true;
  };

  const synchronizeStartupPlayer = createSplitPlayerStartupSynchronizer(
    video,
    audio,
    maybeRestorePlayback,
  );

  addMountedPlayerListener(video, "loadedmetadata", () => {
    synchronizeStartupPlayer();
    reportCurrentVideoStatus();
  });

  addMountedPlayerListener(audio, "loadedmetadata", () => {
    synchronizeStartupPlayer();
  });

  addMountedPlayerListener(video, "error", () => {
    failHostPlaybackCandidate(session, video, audio, "video-error-before-readiness");
  });

  addMountedPlayerListener(audio, "error", () => {
    failHostPlaybackCandidate(session, video, audio, "audio-error-before-readiness");
  });

  addMountedPlayerListener(video, "play", () => {
    if (video.dataset.bilikaraInternalPlay === "true") {
      delete video.dataset.bilikaraInternalPlay;
      return;
    }
    if (isLocalAdvanceHoldingItem(currentItem.id)) {
      stopMountedPlayerForAdvanceDelay(currentItem.id);
      return;
    }
    if (isSplitPlayerSeekSettling(video, audio)) {
      session.seekResumeAfterSettle = true;
      state.localShouldBePlaying = true;
      session.seekResumePending = true;
      video.dataset.bilikaraInternalPause = "true";
      video.pause();
      return;
    }
    setSplitPlaybackIntent(video, audio, true, {
      source: "native-video-play-intent",
      synchronizeStartupPlayer,
    });
    reportCurrentVideoStatus();
  });

  addMountedPlayerListener(video, "pause", () => {
    if (video.dataset.bilikaraInternalPause === "true") {
      delete video.dataset.bilikaraInternalPause;
      return;
    }
    if (session.seekResumePending) {
      return;
    }
    if (video.ended && !audio.ended) {
      return;
    }
    if (document.hidden && state.localShouldBePlaying) {
      if (session.hiddenPauseTimer) {
        window.clearTimeout(session.hiddenPauseTimer);
      }
      let hiddenPauseTimer = null;
      hiddenPauseTimer = window.setTimeout(() => {
        if (
          session.hiddenPauseTimer !== hiddenPauseTimer
          || !isCurrentHostPlaybackSession(session, video, audio)
        ) {
          return;
        }
        session.hiddenPauseTimer = null;
        if (shouldHoldCurrentItemForTransition(currentItem)) {
          return;
        }
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
      }, 0);
      session.hiddenPauseTimer = hiddenPauseTimer;
      return;
    }
    setSplitPlaybackIntent(video, audio, false, { source: "native-video-pause-intent" });
    reportCurrentVideoStatus();
  });

  addMountedPlayerListener(video, "seeking", () => {
    if (video.dataset.bilikaraInternalSeek === "true") {
      return;
    }
    beginSplitPlayerSeek(video, audio, {
      resumeAfterSeek: !video.paused || state.localShouldBePlaying,
      onSettled: reportCurrentVideoStatus,
    });
  });

  addMountedPlayerListener(video, "seeked", () => {
    if (video.dataset.bilikaraInternalSeek === "true") {
      delete video.dataset.bilikaraInternalSeek;
      return;
    }
    if (!settleSplitPlayerSeek(video, audio)) {
      reportCurrentVideoStatus();
    }
    maybeShowRatingPromptForProgress(currentItem, audio.currentTime, audio.duration);
  });

  addMountedPlayerListener(video, "canplay", () => {
    state.localVideoPlaybackBlocked = false;
    updateSplitPlaybackStartOverlay(video, audio);
    if (!synchronizeStartupPlayer()) {
      syncSplitPlayer(
        video,
        audio,
        currentAvOffsetSeconds(),
        !isWebKitPlaybackRuntime() && state.localVideoDeferredRecovery,
      );
    }
  });

  addMountedPlayerListener(audio, "seeked", () => {
    settleSplitPlayerSeek(video, audio);
  });

  addMountedPlayerListener(audio, "canplay", () => {
    state.localAudioPlaybackBlocked = false;
    updateSplitPlaybackStartOverlay(video, audio);
    if (!synchronizeStartupPlayer()) {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), state.localVideoDeferredRecovery);
    }
  });

  addMountedPlayerListener(video, "playing", () => {
    state.localVideoPlaybackBlocked = false;
    if (session.readyCommitted && !video.paused && !audio.paused) {
      setHostPlaybackSessionPhase(session, "playing");
    }
    if (!synchronizeStartupPlayer()) {
      syncSplitPlayer(
        video,
        audio,
        currentAvOffsetSeconds(),
        !isWebKitPlaybackRuntime() && state.localVideoDeferredRecovery,
      );
    }
  });

  addMountedPlayerListener(video, "waiting", () => {
    state.localVideoPlaybackBlocked = true;
    state.localVideoDeferredRecovery = true;
    if (!isWebKitPlaybackRuntime()) {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    }
  });

  addMountedPlayerListener(video, "stalled", () => {
    state.localVideoPlaybackBlocked = true;
    state.localVideoDeferredRecovery = true;
    if (!isWebKitPlaybackRuntime()) {
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    }
  });

  addMountedPlayerListener(video, "timeupdate", () => {
    reportPlayerStatusHeartbeat(currentItem.id, video, session);
  });

  addMountedPlayerListener(video, "ratechange", () => {
    state.localPlayerRequestedRate = Number(video.playbackRate || 1) || 1;
    audio.playbackRate = state.localPlayerRequestedRate;
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  });

  addMountedPlayerListener(video, "volumechange", () => {
    syncSplitPlayerVolumeFromVideo(video, audio);
  });

  ["pointerenter", "pointermove", "pointerdown", "touchstart", "focus"].forEach((eventName) => {
    addMountedPlayerListener(video, eventName, () => {
      revealMountedPlayerControlsForUserInteraction();
    }, { passive: true });
  });

  addMountedPlayerListener(video, "pointerleave", () => {
    hideMountedPlayerControls();
  });

  addMountedPlayerListener(video, "ended", async () => {
    await handleSplitVideoEnded(currentItem, video, audio, reportCurrentVideoStatus);
  });

  addMountedPlayerListener(audio, "waiting", () => {
    if (isWebKitPlaybackRuntime()) {
      clearWebKitAudioStarvationTimer(session);
      let audioStarvationTimer = null;
      audioStarvationTimer = window.setTimeout(() => {
        if (
          session.audioStarvationTimer !== audioStarvationTimer
          || !isCurrentHostPlaybackSession(session, video, audio)
        ) {
          return;
        }
        session.audioStarvationTimer = null;
        state.localAudioPlaybackBlocked = true;
        syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
      }, 200);
      session.audioStarvationTimer = audioStarvationTimer;
    } else {
      state.localAudioPlaybackBlocked = true;
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    }
  });

  addMountedPlayerListener(audio, "stalled", () => {
    if (!isWebKitPlaybackRuntime()) {
      state.localAudioPlaybackBlocked = true;
      syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    }
  });

  addMountedPlayerListener(audio, "playing", () => {
    clearWebKitAudioStarvationTimer(session);
    state.localAudioPlaybackBlocked = false;
    if (session.readyCommitted && !video.paused && !audio.paused) {
      setHostPlaybackSessionPhase(session, "playing");
    }
  });

  addMountedPlayerListener(audio, "ended", async () => {
    await handleSplitAudioEnded(currentItem, video, audio, reportCurrentVideoStatus);
  });

  addMountedPlayerListener(audio, "timeupdate", () => {
    maybeShowRatingPromptForProgress(currentItem, audio.currentTime, audio.duration);
  });

  let syncTimer = null;
  syncTimer = window.setInterval(() => {
    if (
      session.syncTimer !== syncTimer
      || !isCurrentHostPlaybackSession(session, video, audio)
    ) {
      return;
    }
    if (isSplitPlayerSeekSettling(video, audio)) {
      settleSplitPlayerSeek(video, audio);
      reportCurrentVideoStatus();
      return;
    }
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), false);
    reportCurrentVideoStatus();
    maybeShowRatingPromptForProgress(currentItem, audio.currentTime, audio.duration);
  }, localPlayerSyncIntervalMs);
  session.syncTimer = syncTimer;

  let startupTimer = null;
  startupTimer = window.setTimeout(() => {
    if (
      session.startupTimer !== startupTimer
      || !isCurrentHostPlaybackSession(session, video, audio)
    ) {
      return;
    }
    session.startupTimer = null;
    synchronizeStartupPlayer();
    reportCurrentVideoStatus();
  }, 0);
  session.startupTimer = startupTimer;
  beginHostPlaybackSessionOwnershipClaim(session);
}


function applyRemotePlayerControl(command, currentItem, playbackMode) {
  const seq = Number(command?.seq || 0);
  if (!Number.isInteger(seq) || seq <= state.lastAppliedPlayerControlSeq) {
    return;
  }

  const action = String(command?.action || "");
  const commandItemId = String(command?.item_id || "");
  const expectedPlaybackGeneration = Number(command?.playback_generation);
  const exactPlaybackProgram = Boolean(
    Number.isSafeInteger(expectedPlaybackGeneration)
    && expectedPlaybackGeneration >= 1
    && expectedPlaybackGeneration === state.data?.playback_generation
    && state.hostPlaybackSession?.playbackGeneration === expectedPlaybackGeneration
    && isCurrentHostPlaybackSession(state.hostPlaybackSession)
  );

  if (
    exactPlaybackProgram
    && playbackMode === "local"
    && currentItem
    && (!commandItemId || commandItemId === currentItem.id)
  ) {
    if (action === "next-track") {
      requestNextTrack(expectedPlaybackGeneration).catch(() => {});
    } else {
      const video = elements.playerFrame.querySelector("video");
      const audio = elements.playerFrame.querySelector('audio[data-player-role="audio"]');
      const playbackSession = state.hostPlaybackSession;
      if (video && isCurrentHostPlaybackSession(playbackSession, video, audio)) {
        // WebKit can keep a successful active pair in "starting" until its
        // initial play promises settle. Remote controls must treat that pair
        // as an established session instead of re-entering startup policy.
        const hasEstablishedTauriWebKitSession = Boolean(
          audio
          && isTauriWebKitRuntime()
          && (
            state.localPlaybackStartState === "established"
            || (
              state.localPlaybackStartState === "starting"
              && state.localShouldBePlaying
              && !video.paused
              && !audio.paused
            )
          )
        );
        if (
          hasEstablishedTauriWebKitSession
          && state.localPlaybackStartState === "starting"
        ) {
          setSplitPlaybackStartState("established", video, audio);
        }
        if (action === "toggle-play") {
          if (audio) {
            if (hasEstablishedTauriWebKitSession) {
              setSplitPlaybackIntent(video, audio, !state.localShouldBePlaying, {
                source: "remote-toggle-intent",
              });
            } else if (!requestSplitPlaybackStart(video, audio, { source: "remote-play-intent" })) {
              setSplitPlaybackIntent(video, audio, !state.localShouldBePlaying, {
                source: "remote-toggle-intent",
              });
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
            const resumeAfterSeek = audio && isTauriWebKitRuntime()
              ? state.localShouldBePlaying
              : !video.paused || state.localShouldBePlaying;
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
                diagnosticAction: "manual-video-seek",
                onSettled: (applied) => {
                  if (applied) {
                    reportPlayerStatus(currentItem.id, video, playbackSession);
                  }
                },
              });
            } else {
              const session = state.hostPlaybackSession;
              if (session) {
                session.seekResumePending = resumeAfterSeek;
              }
              setMediaCurrentTime(video, clampedNextTime);
            }
            if (!audio && state.hostPlaybackSession?.seekResumePending) {
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

function observedHostPlayerStatus(itemId, session, video, audio = session?.audio) {
  const normalizedItemId = String(itemId || "").trim();
  if (
    !normalizedItemId
    || !video
    || !audio
    || !isCurrentHostPlaybackSession(session, video, audio)
    || !session.readyCommitted
  ) {
    return null;
  }

  const rawCurrentTime = Number(video.currentTime || 0);
  const rawDuration = Number(video.duration);
  if (
    !Number.isFinite(rawCurrentTime)
    || rawCurrentTime < 0
    || rawCurrentTime > playerStatusMaxSeconds
    || (Number.isFinite(rawDuration) && (rawDuration < 0 || rawDuration > playerStatusMaxSeconds))
  ) {
    return null;
  }
  let observedPhase = "paused";
  if (audio.ended) {
    observedPhase = "ended";
  } else if (hostPlaybackSessionObservedPlaying(session, video, audio)) {
    observedPhase = "playing";
  } else if (session.phase === "ready-paused") {
    observedPhase = "ready-paused";
  } else if (session.phase === "starting" || session.phase === "start-retry-wait") {
    observedPhase = "starting";
  } else if (session.phase === "needs-user-gesture") {
    observedPhase = "needs-user-gesture";
  } else if (session.phase === "failed") {
    observedPhase = "failed";
  }
  return {
    observed_phase: observedPhase,
    is_paused: observedPhase !== "playing",
    current_time: rawCurrentTime,
    duration: Number.isFinite(rawDuration) ? rawDuration : 0,
  };
}

function nextHostPlayerStatusSequence(session) {
  const currentSequence = Number(session?.statusSequence);
  if (
    !session
    || !Number.isSafeInteger(currentSequence)
    || currentSequence < 0
    || currentSequence >= Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  const nextSequence = currentSequence + 1;
  if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) {
    return null;
  }
  session.statusSequence = nextSequence;
  return nextSequence;
}

function reportPlayerStatus(itemId, video, session) {
  const observed = observedHostPlayerStatus(itemId, session, video, session?.audio);
  const playbackGeneration = Number(session?.playbackGeneration);
  if (
    !observed
    || !Number.isSafeInteger(playbackGeneration)
    || playbackGeneration < 1
  ) {
    return false;
  }

  const normalizedItemId = String(itemId || "").trim();
  syncTauriMediaSessionState(video);
  publishPresentationPlaybackState(session).catch(() => {});
  const currentItem = state.data?.current_item;
  if (currentItem && String(currentItem.id || "") === normalizedItemId) {
    maybeShowRatingPromptForProgress(
      currentItem,
      observed.current_time,
      observed.duration,
    );
  }
  const signature = [
    normalizedItemId,
    observed.observed_phase,
    observed.is_paused ? "paused" : "playing",
    Math.round(observed.current_time),
    Math.round(observed.duration),
  ].join("|");
  if (signature === session.lastReportedStatusSignature) {
    return false;
  }
  const statusSequence = nextHostPlayerStatusSequence(session);
  if (statusSequence === null) {
    return false;
  }
  session.lastReportedStatusSignature = signature;

  apiPost("/api/player/status", {
    playback_generation: playbackGeneration,
    status_sequence: statusSequence,
    item_id: normalizedItemId,
    ...observed,
    client_info: {
      user_agent: String(window.navigator?.userAgent || ""),
      platform: String(window.navigator?.platform || ""),
      language: String(window.navigator?.language || ""),
      vendor: String(window.navigator?.vendor || ""),
    },
  }).catch(() => {});
  return true;
}

function reportPlayerStatusHeartbeat(itemId, video, session) {
  if (
    !video
    || video.paused
    || !isCurrentHostPlaybackSession(session, video, session?.audio)
    || !session.readyCommitted
  ) {
    return;
  }
  const now = Date.now();
  if (now - Number(session.lastStatusHeartbeatAt || 0) < 5000) {
    return;
  }
  session.lastStatusHeartbeatAt = now;
  reportPlayerStatus(itemId, video, session);
}

function renderPlaylist(playlist, currentItem, cachePolicy) {
  if (!playlist.length) {
    const signature = `${state.data?.current_item ? "empty-with-current" : "empty"}|${state.language}`;
    if (signature === state.playlistEmptyRenderSignature) {
      return;
    }
    state.playlistEmptyRenderSignature = signature;
    const emptyNode = document.createElement("div");
    emptyNode.className = "queue-empty";
    const title = document.createElement("p");
    title.textContent = state.data?.current_item ? t("list.emptyWithCurrentTitle") : t("list.emptyTitle");
    const hint = document.createElement("p");
    hint.textContent = state.data?.current_item ? t("list.emptyWithCurrentHint") : t("list.emptyHint");
    emptyNode.append(title, hint);
    elements.playlist.replaceChildren(emptyNode);
    scheduleQueueScrollOwnershipSync();
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
    let node = existingNodes.get(item.id);
    if (!node) {
      node = elements.playlistTemplate.content.firstElementChild.cloneNode(true);
      applyStaticI18n(node);
    }
    if (node.dataset.id !== item.id) {
      node.dataset.id = item.id;
    }

    const badge = node.querySelector(".song-progress-badge");
    const indexLabel = node.querySelector(".song-index-label");
    const sizeLabel = node.querySelector(".song-size-label");
    const readyIndicator = node.querySelector(".song-badge-check");
    const retryButton = node.querySelector(".song-retry-button");
    const moveUpButton = node.querySelector('[data-action="move-up"]');
    const moveDownButton = node.querySelector('[data-action="move-down"]');
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
      language: state.language,
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
      cacheDownloadCurrent: item.cache_download_current_bytes,
      cacheDownloadTotal: item.cache_download_total_bytes,
      progressPercent: cacheProgressPercentForItem(item),
      language: state.language,
    });
    if (node.dataset.dynamicSignature !== dynamicSignature) {
      node.dataset.dynamicSignature = dynamicSignature;
      setTextContent(indexLabel, String(index + 1));
      setClassToggle(badge, "active", badgeState === "active");
      setClassToggle(badge, "idle", badgeState === "idle");
      setClassToggle(badge, "ready", item.cache_status === "ready");
      setClassToggle(badge, "failed", item.cache_status === "failed");
      syncCacheProgressBadge(badge, item, badgeState === "active");
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
    if (moveUpButton) {
      moveUpButton.disabled = index === 0;
      moveUpButton.dataset.targetIndex = String(index - 1);
    }
    if (moveDownButton) {
      moveDownButton.disabled = index === playlist.length - 1;
      moveDownButton.dataset.targetIndex = String(index + 1);
    }

    const referenceNode = elements.playlist.children[index] || null;
    if (node !== referenceNode) {
      elements.playlist.insertBefore(node, referenceNode);
    }
    existingNodes.delete(item.id);
  });

  existingNodes.forEach((node) => {
    if (node.contains(state.openRowMenuTrigger)) {
      closeOpenMenus({ restoreFocus: false });
    }
    node.remove();
  });
  scheduleQueueScrollOwnershipSync();
}

function syncQueueScrollOwnership() {
  state.queueScrollMeasureFrame = null;
  const playlist = elements.playlist;
  if (!playlist || playlist.clientHeight <= 0) {
    return false;
  }
  const scrollable = playlist.scrollHeight > playlist.clientHeight + 1;
  playlist.classList.toggle("is-scrollable", scrollable);
  playlist.classList.toggle("is-content-fit", !scrollable);
  if (!scrollable && playlist.scrollTop !== 0) {
    playlist.scrollTop = 0;
  }
  return scrollable;
}

function scheduleQueueScrollOwnershipSync() {
  if (state.queueScrollMeasureFrame !== null) {
    return;
  }
  state.queueScrollMeasureFrame = window.requestAnimationFrame(syncQueueScrollOwnership);
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
    if (button.hasAttribute("data-item-incarnation-id")) {
      button.removeAttribute("data-item-incarnation-id");
    }
    if (button.hasAttribute("title")) {
      button.removeAttribute("title");
    }
    if (button.hasAttribute("aria-label")) {
      button.removeAttribute("aria-label");
    }
    return;
  }
  const tooltip = t("cache.retryClick");
  if (button.dataset.id !== item.id) {
    button.dataset.id = item.id;
  }
  if (button.dataset.itemIncarnationId !== item.item_incarnation_id) {
    button.dataset.itemIncarnationId = item.item_incarnation_id;
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
  const signature = JSON.stringify({ history: history || [], language: state.language });
  if (signature === state.historyRenderSignature) {
    return;
  }
  state.historyRenderSignature = signature;
  if (elements.historyList.contains(state.openRowMenuTrigger)) {
    closeOpenMenus({ restoreFocus: false });
  }
  elements.historyList.replaceChildren();

  if (!history.length) {
    const emptyNode = document.createElement("div");
    emptyNode.className = "queue-empty";
    const title = document.createElement("p");
    title.textContent = t("history.emptyTitle");
    const hint = document.createElement("p");
    hint.textContent = t("history.emptyHint");
    emptyNode.append(title, hint);
    elements.historyList.appendChild(emptyNode);
    return;
  }

  history.forEach((entry) => {
    const node = elements.historyTemplate.content.firstElementChild.cloneNode(true);
    applyStaticI18n(node);
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
    node.querySelector(".history-count").textContent = t("history.requestCount", { count: entry.request_count });
    node.querySelectorAll("button[data-action]").forEach((button) => {
      button.dataset.url = entry.resolved_url || entry.original_url;
      button.dataset.key = entry.key || "";
    });
    elements.historyList.appendChild(node);
  });
}

function badgeTitleForItem(item) {
  if (item.cache_status === "ready") {
    return t("cache.ready");
  }
  if (item.cache_status === "failed") {
    return localizedCacheMessage(item.cache_message, item.cache_status) || t("cache.failed");
  }
  return localizedCacheMessage(item.cache_message, item.cache_status) || t("cache.caching");
}

function noteForItem(item) {
  if (item.cache_status === "failed") {
    return localizedCacheMessage(item.cache_message, item.cache_status) || t("cache.failed");
  }
  return "";
}

function formatHistoryTime(timestamp) {
  if (!timestamp) {
    return t("history.justNow");
  }
  return new Date(timestamp * 1000).toLocaleString(activeLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ownerTooltipForEntry(entry) {
  const fullTitle = String(entry?.title || entry?.display_title || "").trim();
  const ownerName = String(entry?.owner_name || "").trim();
  const lines = [];
  if (fullTitle) {
    lines.push(fullTitle);
  }
  if (ownerName) {
    lines.push(t("owner.tooltip", { name: ownerName }));
  }
  return lines.join("\n");
}

function formatBBDownHint(bbdown) {
  if (!bbdown) {
    return t("status.unknown");
  }
  const labelMap = {
    idle: t("status.idle"),
    checking: t("status.checking"),
    installing: t("status.installing"),
    ready: t("status.ready"),
    failed: t("status.error"),
  };
  return labelMap[bbdown.state] || bbdown.state || t("status.unknown");
}

function formatFFmpegHint(ffmpeg) {
  if (!ffmpeg) {
    return t("status.unknown");
  }
  const labelMap = {
    idle: t("status.idle"),
    checking: t("status.checking"),
    ready: t("status.ready"),
    failed: t("status.error"),
  };
  return labelMap[ffmpeg.state] || ffmpeg.state || t("status.unknown");
}

function formatCacheChipMeta(cachePolicy) {
  const limit = Number(cachePolicy?.max_cache_items || 0);
  return t("service.cacheChipMeta", { usage: formatBytes(cachePolicy?.usage_bytes || 0), limit });
}

function formatCacheUsage(cachePolicy) {
  const usage = formatBytes(cachePolicy?.usage_bytes || 0);
  const cachedItemCount = Number(cachePolicy?.cached_item_count || 0);
  return t("service.cacheUsageDetail", { usage, count: cachedItemCount });
}

function renderCacheUsageDetail(detailText) {
  if (!elements.cacheUsageDetail) {
    return;
  }
  const lines = String(detailText || "").split(/\n+/);
  const usageLine = lines.shift() || "";
  const countLine = lines.join(" ").trim();
  const usageEl = elements.cacheUsageDetail.querySelector(".cache-usage-size");
  const countEl = elements.cacheUsageDetail.querySelector(".cache-usage-count");
  if (!usageEl || !countEl) {
    setTextContent(elements.cacheUsageDetail, detailText);
    return;
  }
  setTextContent(usageEl, usageLine);
  setTextContent(countEl, countLine);
}

function cacheProgressPercentForItem(item) {
  if (!item || item.cache_status !== "downloading") {
    return null;
  }
  const totalBytes = Number(item.cache_download_total_bytes || 0);
  const currentBytes = Number(item.cache_download_current_bytes || 0);
  if (totalBytes > 0) {
    return Math.max(0, Math.min(99, Math.round((currentBytes / totalBytes) * 100)));
  }
  const cacheProgress = Number(item.cache_progress || 0);
  if (cacheProgress > 0 && cacheProgress < 100) {
    return Math.max(0, Math.min(99, Math.round(cacheProgress)));
  }
  return null;
}

function syncCacheProgressBadge(badge, item, isActive) {
  if (!badge) {
    return;
  }
  const progressPercent = isActive ? cacheProgressPercentForItem(item) : null;
  const hasProgress = progressPercent !== null;
  setClassToggle(badge, "has-progress", hasProgress);
  setClassToggle(badge, "indeterminate", Boolean(isActive && !hasProgress));
  const progressValue = hasProgress ? String(Math.max(0, Math.min(100, progressPercent))) : "0";
  if (badge.style.getPropertyValue("--badge-progress-value") !== progressValue) {
    badge.style.setProperty("--badge-progress-value", progressValue);
  }
}

function cacheSizeLabelForItem(item) {
  const progressPercent = cacheProgressPercentForItem(item);
  if (progressPercent !== null) {
    return `${progressPercent}%`;
  }
  const size = Number(item.cache_size_bytes || 0);
  if (size > 0) {
    return formatCompactBytes(size);
  }
  if (item.cache_status === "failed") {
    return t("status.failed");
  }
  if (item.cache_status === "downloading") {
    return t("status.caching");
  }
  if (item.cache_status === "queued" || item.cache_status === "pending") {
    return t("status.pendingCache");
  }
  return t("status.pendingCache");
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

function renderBackupBanner(
  backup,
  previousSession,
  hasCurrentItem,
  queueLength,
  autoRestoredBackup,
) {
  if (!state.previousSessionPromptChecked) {
    state.previousSessionPromptChecked = true;
    state.previousSessionPromptEligible = Boolean(
      previousSession?.available
      && !autoRestoredBackup
      && !hasCurrentItem
      && queueLength === 0
    );
  } else if (state.previousSessionPromptEligible && (hasCurrentItem || queueLength > 0)) {
    state.previousSessionPromptEligible = false;
  }

  let mode = "";
  if (backup?.available && autoRestoredBackup) {
    mode = "auto_restored";
  } else if (state.previousSessionPromptEligible && previousSession?.available) {
    mode = "previous_session";
  }

  if (!mode) {
    clearBackupBannerTimer();
    state.backupBannerMode = "";
    elements.backupBanner.classList.add("hidden");
    updateBackupDismissButton();
    return;
  }

  if (state.backupBannerMode !== mode) {
    state.backupBannerMode = mode;
    state.backupBannerShown = false;
  }
  if (!state.backupBannerShown) {
    state.backupBannerShown = true;
    state.backupBannerDismissed = false;
    startBackupBannerTimer();
  }

  if (mode === "previous_session") {
    elements.backupTitle.textContent = t("backup.previousSessionTag");
    elements.backupText.textContent = t("backup.previousSessionDetected", {
      count: previousSession.item_count,
    });
    elements.backupActionButton.textContent = t("backup.continuePreviousSession");
  } else if (hasCurrentItem || queueLength > 0) {
    elements.backupTitle.textContent = t("backup.tag");
    elements.backupText.textContent = t("backup.restored", { count: backup.playlist_count });
    elements.backupActionButton.textContent = t("backup.clear");
  } else {
    elements.backupTitle.textContent = t("backup.tag");
    elements.backupText.textContent = t("backup.localDetected", { count: backup.playlist_count });
    elements.backupActionButton.textContent = t("backup.clear");
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
  state.confirmIntent = {
    ...intent,
    focusElement: intent?.focusElement || document.activeElement,
  };
  renderConfirmPopover();
}

function closeConfirm({ restoreFocus = true } = {}) {
  const focusElement = state.confirmIntent?.focusElement;
  state.confirmIntent = null;
  state.confirmPopoverRenderSignature = "";
  renderConfirmPopover();
  if (restoreFocus && focusElement?.isConnected && typeof focusElement.focus === "function") {
    focusElement.focus({ preventScroll: true });
  }
}

function confirmPopoverAnchorElement(intent) {
  const anchorElementId = String(intent?.anchorElementId || "").trim();
  return anchorElementId ? document.getElementById(anchorElementId) : null;
}

function confirmPopoverAnchorRect(intent) {
  const anchorElement = confirmPopoverAnchorElement(intent);
  return anchorElement ? anchorElement.getBoundingClientRect() : null;
}

function confirmPopoverRenderSignature(intent) {
  if (!intent) {
    return "";
  }
  const anchorRect = confirmPopoverAnchorRect(intent);
  return JSON.stringify({
    type: intent.type || "",
    message: intent.message || "",
    primaryLabel: intent.primaryLabel || "",
    secondaryLabel: intent.secondaryLabel || "",
    sourceSelect: Boolean(intent.sourceSelect),
    pageSizeSelect: Boolean(intent.pageSizeSelect),
    hideMessage: Boolean(intent.hideMessage),
    source: normalizedHistoryExportSource(intent.source),
    pageSize: selectedConfirmHistoryExportPageSize(intent),
    x: Math.round(Number(intent.x || 0)),
    y: Math.round(Number(intent.y || 0)),
    anchorElementId: String(intent.anchorElementId || ""),
    anchorAlign: String(intent.anchorAlign || ""),
    anchorGap: Math.round(Number(intent.anchorGap || 0)),
    anchorLeft: anchorRect ? Math.round(anchorRect.left) : 0,
    anchorTop: anchorRect ? Math.round(anchorRect.top) : 0,
    anchorRight: anchorRect ? Math.round(anchorRect.right) : 0,
    anchorBottom: anchorRect ? Math.round(anchorRect.bottom) : 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function confirmPopoverPlacement(intent, width, popoverHeight) {
  const margin = 12;
  const anchorRect = confirmPopoverAnchorRect(intent);
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - popoverHeight - margin);
  const anchorGap = Number.isFinite(Number(intent.anchorGap)) ? Number(intent.anchorGap) : 10;
  let rawLeft = Number(intent.x || 0);
  let rawTop = Number(intent.y || 0);

  if (anchorRect) {
    const align = String(intent.anchorAlign || "end");
    rawTop = anchorRect.bottom + anchorGap;
    if (align === "start") {
      rawLeft = anchorRect.left;
    } else if (align === "center") {
      rawLeft = anchorRect.left + ((anchorRect.width - width) / 2);
    } else {
      rawLeft = anchorRect.right - width;
    }

    const aboveTop = anchorRect.top - popoverHeight - anchorGap;
    if (rawTop + popoverHeight > window.innerHeight - margin && aboveTop >= margin) {
      rawTop = aboveTop;
    }
  }

  const left = Math.min(Math.max(rawLeft, margin), maxLeft);
  if (!anchorRect) {
    return {
      left,
      top: Math.min(Math.max(rawTop, margin), maxTop),
    };
  }

  const anchorOutsideViewport = anchorRect.bottom < margin || anchorRect.top > window.innerHeight - margin;
  return {
    left,
    top: anchorOutsideViewport ? rawTop : Math.min(Math.max(rawTop, margin), maxTop),
  };
}

function renderConfirmPopover() {
  const intent = state.confirmIntent;
  if (!intent) {
    state.confirmPopoverRenderSignature = "";
    elements.confirmPopover.classList.add("hidden");
    return;
  }

  const renderSignature = confirmPopoverRenderSignature(intent);
  if (
    renderSignature === state.confirmPopoverRenderSignature &&
    !elements.confirmPopover.classList.contains("hidden")
  ) {
    return;
  }
  state.confirmPopoverRenderSignature = renderSignature;

  const hasSecondaryAction = Boolean(intent.secondaryLabel);
  const hasSourceSelect = Boolean(intent.sourceSelect);
  const hasPageSizeSelect = Boolean(intent.pageSizeSelect);
  const hideMessage = Boolean(intent.hideMessage);
  const width = hasSourceSelect || hasPageSizeSelect ? 420 : 260;
  const popoverHeight = (hasSecondaryAction ? 126 : 112)
    + (hasSourceSelect || hasPageSizeSelect ? 76 : 0)
    - (hideMessage ? 34 : 0);
  const { left, top } = confirmPopoverPlacement(intent, width, popoverHeight);

  elements.confirmText.textContent = intent.message || "";
  elements.confirmText.classList.toggle("hidden", hideMessage);
  if (elements.confirmSource) {
    elements.confirmSource.classList.toggle("hidden", !hasSourceSelect);
    if (hasSourceSelect) {
      elements.confirmSource.value = normalizedHistoryExportSource(intent.source);
    }
  }
  if (elements.confirmPageSize) {
    elements.confirmPageSize.classList.toggle("hidden", !hasPageSizeSelect);
    if (hasPageSizeSelect) {
      elements.confirmPageSize.value = String(selectedConfirmHistoryExportPageSize(intent));
    }
  }
  elements.confirmPageSizeNote?.classList.toggle("hidden", !hasPageSizeSelect);
  const shouldGroupExportControls = hasSourceSelect && hasPageSizeSelect && elements.confirmSource && elements.confirmPageSize;
  if (shouldGroupExportControls) {
    let controls = elements.confirmPopover.querySelector(".confirm-export-controls");
    if (!controls) {
      controls = document.createElement("div");
      controls.className = "confirm-export-controls";
      elements.confirmSource.before(controls);
    }
    controls.append(elements.confirmSource, elements.confirmPageSize);
  } else {
    const controls = elements.confirmPopover.querySelector(".confirm-export-controls");
    if (controls) {
      controls.before(elements.confirmSource);
      elements.confirmSource.after(elements.confirmPageSize);
      controls.remove();
    }
  }
  elements.confirmOk.textContent = intent.primaryLabel || t("common.confirm");
  if (elements.confirmSecondary) {
    elements.confirmSecondary.textContent = intent.secondaryLabel || "";
    elements.confirmSecondary.classList.toggle("hidden", !hasSecondaryAction);
  }
  elements.confirmPopover.style.left = `${left}px`;
  elements.confirmPopover.style.top = `${top}px`;
  elements.confirmPopover.classList.toggle("confirm-popover-wide", hasSourceSelect || hasPageSizeSelect);
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

let confirmPopoverPositionFrame = 0;

function scheduleConfirmPopoverPositionSync() {
  if (!state.confirmIntent || confirmPopoverPositionFrame) {
    return;
  }
  confirmPopoverPositionFrame = window.requestAnimationFrame(() => {
    confirmPopoverPositionFrame = 0;
    if (!state.confirmIntent) {
      return;
    }
    state.confirmPopoverRenderSignature = "";
    renderConfirmPopover();
  });
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

function focusPlaylistItemMenuTrigger(itemId) {
  const normalizedId = String(itemId || "");
  if (!normalizedId) {
    return false;
  }
  const trigger = elements.playlist.querySelector(
    `.song-item[data-id="${escapeSelector(normalizedId)}"] [data-action="toggle-menu"]`,
  );
  if (!trigger) {
    return false;
  }
  trigger.focus({ preventScroll: true });
  return true;
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
  const title = duplicateItem?.display_title || activeItem?.display_title || sessionEntry?.display_title || t("request.thisSong");
  const count = Number(sessionEntry?.request_count || 0);
  if (activeItem && count > 0) {
    return t("request.duplicateActiveAndSession", { title, count });
  }
  if (activeItem) {
    return t("request.duplicateActive", { title });
  }
  return t("request.duplicateSession", { title, count: count || 1 });
}

async function submitAddRequest(url, position, options = {}) {
  return apiPostStateSnapshot("/api/playlist/add", {
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

function closeBindingModal({ restoreFocus = true } = {}) {
  const opener = state.bindingIntent?.focusElement;
  state.bindingIntent = null;
  elements.bindingModal?.classList.add("hidden");
  if (elements.bindingVideoOptions) {
    elements.bindingVideoOptions.innerHTML = "";
  }
  if (elements.bindingAudioOptions) {
    elements.bindingAudioOptions.innerHTML = "";
  }
  if (restoreFocus && opener?.isConnected) {
    opener.focus({ preventScroll: true });
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
  meta.textContent = entry.duration > 0 ? t("player.durationSeconds", { seconds: entry.duration }) : t("player.durationUnknown");
  copy.append(title, meta);

  label.append(input, copy);
  return label;
}

function openBindingModal(intent, payload) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (!pages.length) {
    setMessageForSource(intent?.source || "request-form", t("binding.readFailed"), true);
    return;
  }
  state.bindingIntent = {
    ...intent,
    binding: payload,
    focusElement: intent?.focusElement || document.activeElement,
  };
  elements.bindingModalText.textContent = t("binding.videoHasParts", { title: payload.title || t("binding.thisVideo") });
  elements.bindingVideoOptions.innerHTML = "";
  elements.bindingAudioOptions.innerHTML = "";

  const preferredPage = Number(payload.preferred_page || pages[0]?.page || 1);
  pages.forEach((entry) => {
    elements.bindingVideoOptions.appendChild(
      renderBindingOption("radio", "binding-video-page", entry, Number(entry.page) === preferredPage),
    );
    elements.bindingAudioOptions.appendChild(
      renderBindingOption("checkbox", "binding-audio-page", entry, false),
    );
  });
  elements.bindingModal.classList.remove("hidden");
}

function closeGatchaFavlistModal({ restoreFocus = true } = {}) {
  const opener = state.gatchaFavlistIntent?.focusElement;
  state.gatchaFavlistIntent = null;
  elements.gatchaFavlistModal?.classList.add("hidden");
  if (elements.gatchaFavlistOptions) {
    elements.gatchaFavlistOptions.innerHTML = "";
  }
  if (restoreFocus && opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
}

function selectedGatchaFavlistFolderIds() {
  return [...(elements.gatchaFavlistOptions?.querySelectorAll('input[name="gatcha-favlist-folder"]:checked') || [])]
    .map((input) => String(input.value || "").trim())
    .filter(Boolean);
}

function renderGatchaFavlistOption(folder) {
  const label = document.createElement("label");
  label.className = "selection-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "gatcha-favlist-folder";
  input.value = String(folder.id || "");
  input.checked = Boolean(folder.selected);

  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "selection-option-title";
  title.textContent = folder.title || t("favlist.folderWithId", { id: folder.id || "" });
  const meta = document.createElement("div");
  meta.className = "selection-option-meta";
  const count = Number(folder.media_count || 0);
  meta.textContent = folder.selected
    ? t("favlist.mediaCountSelected", { count: count || 0 })
    : t("favlist.mediaCount", { count: count || 0 });
  copy.append(title, meta);

  label.append(input, copy);
  return label;
}

function openGatchaFavlistModal(uid, payload, { messageTarget = "gatcha" } = {}) {
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];
  if (!folders.length) {
    setGatchaUidFlowMessage(messageTarget, t("favlist.none"), true);
    return;
  }
  state.gatchaFavlistIntent = {
    uid,
    folders,
    messageTarget,
    focusElement: document.activeElement,
  };
  elements.gatchaFavlistModalText.textContent = t("favlist.chooseForUid", {
    uid: payload?.uid || uid,
    count: payload?.public_folder_count || folders.length,
  });
  elements.gatchaFavlistOptions.innerHTML = "";
  folders.forEach((folder) => {
    elements.gatchaFavlistOptions.appendChild(renderGatchaFavlistOption(folder));
  });
  elements.gatchaFavlistModal.classList.remove("hidden");
}

async function confirmGatchaFavlistModal() {
  const intent = state.gatchaFavlistIntent;
  if (!intent?.uid) {
    return;
  }
  const messageTarget = intent.messageTarget || "gatcha";
  const folderIds = selectedGatchaFavlistFolderIds();
  if (!folderIds.length) {
    setGatchaUidFlowMessage(messageTarget, t("favlist.selectAtLeastOne"), true);
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidFace();
    return;
  }

  state.gatchaFavlistSaving = true;
  renderGatchaUidFace();
  setGatchaUidFlowMessage(messageTarget, t("favlist.pullingSelected"));
  closeGatchaFavlistModal();
  try {
    const result = await pullGatchaFavlist(intent.uid, folderIds);
    setGatchaUidFlowMessage(
      messageTarget,
      t("favlist.pullResult", { folders: result?.matched_folder_count || 0, items: result?.item_count || 0 }),
    );
    await refreshFavlistBrowseAfterPull();
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaFavlistSaving = false;
    renderGatchaUidFace();
  }
}

function poolConfigFolderId(folder) {
  return String(folder?.id || folder?.folder_id || "").trim();
}

function clonePoolConfigProjection(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...source,
    excluded_uids: Array.isArray(source.excluded_uids)
      ? source.excluded_uids.map(String)
      : [],
    excluded_favlist_folders: Array.isArray(source.excluded_favlist_folders)
      ? source.excluded_favlist_folders.map(String)
      : [],
    uid_options: Array.isArray(source.uid_options)
      ? source.uid_options.map((entry) => ({ ...entry }))
      : source.uid_options,
    favlist_folder_options: Array.isArray(source.favlist_folder_options)
      ? source.favlist_folder_options.map((entry) => ({ ...entry }))
      : source.favlist_folder_options,
  };
}

function poolConfigSetMessage(message, isError = false) {
  state.poolConfigMessage = message || "";
  state.poolConfigMessageIsError = Boolean(isError);
  if (elements.poolConfigMessage) {
    elements.poolConfigMessage.textContent = state.poolConfigMessage;
    elements.poolConfigMessage.classList.toggle("is-error", state.poolConfigMessageIsError);
  }
}

function updatePoolConfigWeightLabel() {
  const uidWeight = Math.max(0, Math.min(100, Number(elements.poolConfigWeightSlider?.value || 50)));
  const favlistWeight = 100 - uidWeight;
  if (elements.poolConfigWeightLabel) {
    elements.poolConfigWeightLabel.textContent = t("gatcha.poolWeightValue", {
      uid: uidWeight,
      favlist: favlistWeight,
    });
  }
}

function renderPoolConfigOption({ type, id, title, meta, checked }) {
  const label = document.createElement("label");
  label.className = "selection-option pool-config-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = type === "uid" ? "gatcha-pool-uid" : "gatcha-pool-favlist";
  input.value = String(id || "");
  input.checked = Boolean(checked);
  input.disabled = state.poolConfigLoading || state.poolConfigSaving;

  const copy = document.createElement("div");
  const titleEl = document.createElement("div");
  titleEl.className = "selection-option-title";
  titleEl.textContent = title || id;
  const metaEl = document.createElement("div");
  metaEl.className = "selection-option-meta";
  metaEl.textContent = meta || "";
  copy.append(titleEl, metaEl);
  label.append(input, copy);
  return label;
}

function renderPoolConfigModal() {
  const data = state.poolConfigDraft || {};
  const excludedUids = new Set((Array.isArray(data.excluded_uids) ? data.excluded_uids : []).map(String));
  const excludedFolders = new Set((Array.isArray(data.excluded_favlist_folders) ? data.excluded_favlist_folders : []).map(String));
  const uidWeight = Math.max(0, Math.min(100, Number(data.uid_weight ?? 50)));
  const detailLoaded = Array.isArray(data.uid_options) || Array.isArray(data.favlist_folder_options);

  if (elements.poolConfigWeightSlider) {
    elements.poolConfigWeightSlider.value = String(uidWeight);
    elements.poolConfigWeightSlider.disabled = state.poolConfigLoading
      || state.poolConfigSaving
      || !detailLoaded;
  }
  updatePoolConfigWeightLabel();

  if (elements.poolConfigUidOptions) {
    elements.poolConfigUidOptions.innerHTML = "";
    const uids = Array.isArray(data.uid_options) ? data.uid_options : [];
    if (!uids.length) {
      const empty = document.createElement("p");
      empty.className = "pool-config-empty";
      empty.textContent = t("gatcha.poolEmptyUid");
      elements.poolConfigUidOptions.appendChild(empty);
    } else {
      uids.forEach((owner) => {
        const uid = String(owner.uid || "").trim();
        elements.poolConfigUidOptions.appendChild(renderPoolConfigOption({
          type: "uid",
          id: uid,
          title: owner.name || `UID ${uid}`,
          meta: t("gatcha.poolOptionCount", { count: Number(owner.count || 0) }),
          checked: uid && !excludedUids.has(uid),
        }));
      });
    }
  }

  if (elements.poolConfigFavlistOptions) {
    elements.poolConfigFavlistOptions.innerHTML = "";
    const folders = Array.isArray(data.favlist_folder_options) ? data.favlist_folder_options : [];
    if (!folders.length) {
      const empty = document.createElement("p");
      empty.className = "pool-config-empty";
      empty.textContent = t("gatcha.poolEmptyFavlist");
      elements.poolConfigFavlistOptions.appendChild(empty);
    } else {
      folders.forEach((folder) => {
        const id = poolConfigFolderId(folder);
        const title = folder.title || t("favlist.folderWithId", { id });
        const meta = folder.uid
          ? t("gatcha.poolFavlistMeta", { uid: folder.uid, count: Number(folder.count || folder.media_count || 0) })
          : t("gatcha.poolOptionCount", { count: Number(folder.count || folder.media_count || 0) });
        elements.poolConfigFavlistOptions.appendChild(renderPoolConfigOption({
          type: "favlist",
          id,
          title,
          meta,
          checked: id && !excludedFolders.has(id),
        }));
      });
    }
  }

  const hasUidOptions = Boolean(elements.poolConfigUidOptions?.querySelector('input[name="gatcha-pool-uid"]'));
  const hasFavlistOptions = Boolean(elements.poolConfigFavlistOptions?.querySelector('input[name="gatcha-pool-favlist"]'));
  [elements.poolConfigUidSelectAll, elements.poolConfigUidSelectNone].forEach((button) => {
    if (button) button.disabled = state.poolConfigLoading || state.poolConfigSaving || !hasUidOptions;
  });
  [elements.poolConfigFavlistSelectAll, elements.poolConfigFavlistSelectNone].forEach((button) => {
    if (button) button.disabled = state.poolConfigLoading || state.poolConfigSaving || !hasFavlistOptions;
  });
  if (elements.poolConfigModalReset) {
    elements.poolConfigModalReset.disabled = state.poolConfigLoading || state.poolConfigSaving || !detailLoaded;
  }
  if (elements.poolConfigModalSave) {
    elements.poolConfigModalSave.disabled = state.poolConfigLoading || state.poolConfigSaving || !detailLoaded;
    elements.poolConfigModalSave.textContent = state.poolConfigSaving ? t("gatcha.poolSaving") : t("gatcha.poolSave");
    if (state.poolConfigSaving) {
      elements.poolConfigModalSave.setAttribute("aria-busy", "true");
    } else {
      elements.poolConfigModalSave.removeAttribute("aria-busy");
    }
  }
  if (elements.poolConfigMessage) {
    elements.poolConfigMessage.textContent = state.poolConfigMessage || "";
    elements.poolConfigMessage.classList.toggle("is-error", Boolean(state.poolConfigMessageIsError));
  }
}

async function openPoolConfigModal() {
  if (!elements.poolConfigModal || !elements.poolConfigModal.classList.contains("hidden")) {
    return;
  }
  const openGeneration = state.poolConfigOpenGeneration + 1;
  const loadSequence = state.poolConfigLoadSequence + 1;
  state.poolConfigOpenGeneration = openGeneration;
  state.poolConfigLoadSequence = loadSequence;
  state.poolConfigSaveSequence += 1;
  state.poolConfigLoading = true;
  state.poolConfigSaving = false;
  state.poolConfigOpener = document.activeElement;
  state.poolConfigDraft = clonePoolConfigProjection(
    state.poolConfigAccepted || state.data?.gatcha_pool_config || {},
  );
  elements.poolConfigModal.classList.remove("hidden");
  poolConfigSetMessage(t("gatcha.poolLoading"));
  renderPoolConfigModal();
  elements.poolConfigModalClose?.focus({ preventScroll: true });
  try {
    const loaded = await fetchPoolConfig();
    if (
      state.poolConfigLoadSequence !== loadSequence
      || state.poolConfigOpenGeneration !== openGeneration
      || elements.poolConfigModal.classList.contains("hidden")
    ) {
      return false;
    }
    state.poolConfigAccepted = clonePoolConfigProjection(loaded);
    state.poolConfigDraft = clonePoolConfigProjection(loaded);
    poolConfigSetMessage("");
    return true;
  } catch (error) {
    if (
      state.poolConfigLoadSequence === loadSequence
      && state.poolConfigOpenGeneration === openGeneration
      && !elements.poolConfigModal.classList.contains("hidden")
    ) {
      poolConfigSetMessage(error.message, true);
    }
    return false;
  } finally {
    if (
      state.poolConfigLoadSequence === loadSequence
      && state.poolConfigOpenGeneration === openGeneration
      && !elements.poolConfigModal.classList.contains("hidden")
    ) {
      state.poolConfigLoading = false;
      renderPoolConfigModal();
    }
  }
}

function closePoolConfigModal({ restoreFocus = true } = {}) {
  state.poolConfigOpenGeneration += 1;
  state.poolConfigLoadSequence += 1;
  state.poolConfigSaveSequence += 1;
  state.poolConfigLoading = false;
  state.poolConfigSaving = false;
  state.poolConfigDraft = null;
  elements.poolConfigModal?.classList.add("hidden");
  poolConfigSetMessage("");
  const opener = state.poolConfigOpener;
  state.poolConfigOpener = null;
  if (restoreFocus) {
    const openerIsVisible = opener?.isConnected
      && !(typeof opener.closest === "function" && opener.closest("[hidden], [inert]"));
    const focusTarget = openerIsVisible
      ? opener
      : hostWorkspaceButton(state.activeHostWorkspace);
    focusTarget?.focus({ preventScroll: true });
  }
}

function capturePoolConfigDraftFromControls() {
  if (!state.poolConfigDraft) {
    return null;
  }
  const uidWeight = Math.max(0, Math.min(100, Number(elements.poolConfigWeightSlider?.value || 50)));
  state.poolConfigDraft = {
    ...state.poolConfigDraft,
    uid_weight: uidWeight,
    favlist_weight: 100 - uidWeight,
    excluded_uids: poolConfigExcludedValues("gatcha-pool-uid"),
    excluded_favlist_folders: poolConfigExcludedValues("gatcha-pool-favlist"),
  };
  return state.poolConfigDraft;
}

function setPoolConfigChecked(name, checked) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.checked = Boolean(checked);
  });
  capturePoolConfigDraftFromControls();
}

function resetPoolConfigControls() {
  if (!state.poolConfigDraft || state.poolConfigLoading || state.poolConfigSaving) {
    return;
  }
  state.poolConfigDraft = {
    ...state.poolConfigDraft,
    uid_weight: 50,
    favlist_weight: 50,
    excluded_uids: [],
    excluded_favlist_folders: [],
  };
  poolConfigSetMessage("");
  renderPoolConfigModal();
}

function poolConfigExcludedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]`)]
    .filter((input) => !input.checked)
    .map((input) => String(input.value || "").trim())
    .filter(Boolean);
}

async function submitPoolConfigModal() {
  if (state.poolConfigSaving || state.poolConfigLoading || !state.poolConfigDraft) {
    return false;
  }
  const draft = capturePoolConfigDraftFromControls();
  const payload = {
    uid_weight: draft.uid_weight,
    favlist_weight: draft.favlist_weight,
    excluded_uids: [...draft.excluded_uids],
    excluded_favlist_folders: [...draft.excluded_favlist_folders],
  };
  const openGeneration = state.poolConfigOpenGeneration;
  const saveSequence = state.poolConfigSaveSequence + 1;
  state.poolConfigSaveSequence = saveSequence;
  state.poolConfigSaving = true;
  poolConfigSetMessage(t("gatcha.poolSaving"));
  renderPoolConfigModal();
  try {
    const saved = await savePoolConfig(payload);
    if (
      state.poolConfigSaveSequence !== saveSequence
      || state.poolConfigOpenGeneration !== openGeneration
      || elements.poolConfigModal.classList.contains("hidden")
    ) {
      return false;
    }
    state.poolConfigAccepted = clonePoolConfigProjection(saved);
    state.poolConfigDraft = clonePoolConfigProjection(saved);
    if (state.data) {
      state.data.gatcha_pool_config = {
        uid_weight: state.poolConfigAccepted.uid_weight,
        favlist_weight: state.poolConfigAccepted.favlist_weight,
        excluded_uids: state.poolConfigAccepted.excluded_uids || [],
        excluded_favlist_folders: state.poolConfigAccepted.excluded_favlist_folders || [],
        updated_at: state.poolConfigAccepted.updated_at || 0,
      };
    }
    closePoolConfigModal();
    setAppMessage(t("gatcha.poolSaved"));
    return true;
  } catch (error) {
    if (
      state.poolConfigSaveSequence === saveSequence
      && state.poolConfigOpenGeneration === openGeneration
      && !elements.poolConfigModal.classList.contains("hidden")
    ) {
      poolConfigSetMessage(error.message, true);
    }
    return false;
  } finally {
    if (
      state.poolConfigSaveSequence === saveSequence
      && state.poolConfigOpenGeneration === openGeneration
      && elements.poolConfigModal
      && !elements.poolConfigModal.classList.contains("hidden")
    ) {
      state.poolConfigSaving = false;
      renderPoolConfigModal();
    }
  }
}

async function confirmBindingModal() {
  const intent = state.bindingIntent;
  if (!intent?.url) {
    return;
  }
  const source = intent.source || "request-form";
  const { selectedVideoPage, selectedAudioPages } = currentBindingSelection();
  if (!selectedVideoPage) {
    setMessageForSource(source, t("binding.selectVideoPart"), true);
    return;
  }
  if (!selectedAudioPages.length) {
    setMessageForSource(source, t("binding.selectAudioPart"), true);
    return;
  }

  const button = elements.bindingModalConfirm;
  let originalText = "";
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    originalText = button.textContent;
    button.textContent = t("search.adding") || "添加中...";
  }

  try {
    const accepted = await submitAddRequest(intent.url, intent.position || "tail", {
      requesterName: intent.requesterName || selectedRequesterName(),
      allowRepeat: Boolean(intent.allowRepeat),
      selectedVideoPage,
      selectedAudioPages,
    });
    if (!accepted && source === "gatcha") {
      setMessageForSource(source, t("error.requestFailed"), true);
      return;
    }
    closeBindingModal({ restoreFocus: source !== "gatcha" });
    if (intent.originatedFromDetail) {
      if (typeof searchDetailController !== "undefined") searchDetailController?.close({ immediate: true });
    }
    if (source !== "gatcha" && !intent.preserveInput) {
      elements.urlInput.value = "";
    }
    if (source === "gatcha") {
      setGatchaMessage(t("gatcha.nozomi"));
      clearAcceptedGatchaCandidate();
    }
    const message = intent.position === "next" ? t("binding.addedNext") : t("binding.addedTail");
    setMessageForSource(source, message);
    setAppMessage(message);
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
          originatedFromDetail: Boolean(intent.originatedFromDetail),
          source,
          title: intent.title,
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
        originatedFromDetail: Boolean(intent.originatedFromDetail),
        source,
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
    setMessageForSource(source, error.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = originalText;
    }
  }
}

async function handleAdd(position, anchorPoint) {
  const url = elements.urlInput.value.trim();
  if (!url) {
    setFormMessage(t("request.urlRequired"), true);
    return;
  }
  const requesterName = validatedRequesterNameForAdd();
  if (!requesterName) {
    return;
  }

  const button = position === "next"
    ? elements.queueNextButton
    : elements.addForm?.querySelector('button[type="submit"]');
  let originalText = "";
  if (button) {
    button.disabled = true;
    originalText = button.textContent;
    button.textContent = t("search.adding") || "添加中...";
  }

  setFormMessage(t("request.parsing"));
  try {
    await submitAddRequest(url, position, { requesterName });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? t("request.addedNext") : t("request.addedTail"));
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
      setFormMessage(t("request.duplicateHint"));
      return;
    }
    setFormMessage(error.message, true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function handleAddByUrl(
  url,
  position,
  anchorPoint,
  source = "search",
  { originatedFromDetail = false } = {},
) {
  const requesterName = validatedRequesterNameForAdd();
  if (!requesterName) {
    return false;
  }
  const isHistory = source === "history";
  setMessageForSource(source, isHistory ? t("history.addingFromHistory") : t("request.parsing"));
  try {
    await submitAddRequest(url, position, { requesterName });
    const message = isHistory
      ? (position === "next" ? t("history.addedNext") : t("history.addedTail"))
      : (position === "next" ? t("request.addedNext") : t("request.addedTail"));
    setMessageForSource(source, message);
    setAppMessage(message);
    if (originatedFromDetail) {
      if (typeof searchDetailController !== "undefined") searchDetailController?.close({ immediate: true });
    }
    render();
    return true;
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url,
          position,
          requesterName,
          preserveInput: false,
          originatedFromDetail: Boolean(originatedFromDetail),
          source,
        },
        error.payload?.binding,
      );
      return false;
    }
    if (error.code === "duplicate_session_request") {
      openConfirm({
        type: "duplicate-add",
        url,
        position,
        requesterName,
        preserveInput: false,
        originatedFromDetail: Boolean(originatedFromDetail),
        source,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: anchorPoint?.x ?? anchorPointForEvent({}, isHistory ? elements.historyList : elements.addForm).x,
        y: anchorPoint?.y ?? anchorPointForEvent({}, isHistory ? elements.historyList : elements.addForm).y,
      });
      setMessageForSource(source, t("request.duplicateHint"));
      return false;
    }
    setMessageForSource(source, error.message, true);
    return false;
  }
}

async function discardBackup() {
  try {
    await apiPostStateSnapshot("/api/backup/discard");
    dismissBackupBanner();
    closeConfirm();
    setAppMessage(t("backup.cleared"));
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function continuePreviousSession() {
  try {
    await apiPostStateSnapshot("/api/session/continue-previous");
    state.previousSessionPromptEligible = false;
    dismissBackupBanner();
    setAppMessage(t("backup.previousSessionContinued"));
    render();
  } catch (error) {
    const message = String(error.message || "").trim() === "没有可继续的上一场记录"
      ? t("backup.previousSessionUnavailable")
      : error.message;
    setAppMessage(message, true);
  }
}

async function clearPlaylist() {
  try {
    await apiPostStateSnapshot("/api/playlist/clear");
    closeConfirm();
    setAppMessage(t("list.cleared"));
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function clearHistory() {
  try {
    await apiPostStateSnapshot("/api/history/clear");
    closeConfirm();
    setAppMessage(t("history.cleared"));
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
  const val = String(source || "").trim();
  if (val.toLowerCase() === "history") {
    return "history";
  }
  if (val.toLowerCase().startsWith("played-") && val.toLowerCase().endsWith(".json")) {
    return val;
  }
  return "played";
}

function historyExportSourceLabel(source) {
  const normalized = normalizedHistoryExportSource(source);
  if (elements.confirmSource) {
    const opt = [...elements.confirmSource.options].find((o) => o.value === normalized);
    if (opt) {
      const parent = opt.parentElement;
      if (parent && parent.tagName.toLowerCase() === "optgroup") {
        return `${parent.label} ${opt.textContent}`;
      }
      return opt.textContent;
    }
  }
  return normalized === "history" ? t("history.allSource") : t("history.playedSource");
}

function selectedConfirmHistoryExportSource(intent) {
  return normalizedHistoryExportSource(elements.confirmSource?.value || intent?.source);
}

function normalizedHistoryExportPageSize(pageSize) {
  const normalizedPageSize = Number.parseInt(String(pageSize || "200"), 10);
  return [200, 150, 100, 80, 60, 50].includes(normalizedPageSize) ? normalizedPageSize : 200;
}

function selectedConfirmHistoryExportPageSize(intent) {
  return normalizedHistoryExportPageSize(elements.confirmPageSize?.value || intent?.pageSize);
}

function updateConfirmHistoryExportSource() {
  if (state.confirmIntent?.type !== "export-history") {
    return;
  }
  state.confirmIntent.source = selectedConfirmHistoryExportSource(state.confirmIntent);
  state.confirmPopoverRenderSignature = "";
}

function updateConfirmHistoryExportPageSize() {
  if (state.confirmIntent?.type !== "export-history") {
    return;
  }
  state.confirmIntent.pageSize = selectedConfirmHistoryExportPageSize(state.confirmIntent);
  state.confirmPopoverRenderSignature = "";
}

async function fetchPlayedSessions() {
  if (!elements.confirmSource) return false;
  try {
    const response = await fetch("/api/played-sessions", {
      headers: clientHeaders(),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const res = await response.json();
    if (res && res.ok && Array.isArray(res.data)) {
      const currentVal = elements.confirmSource.value;
      elements.confirmSource.replaceChildren();

      // 1. 本场记录
      const playedOpt = document.createElement("option");
      playedOpt.value = "played";
      playedOpt.textContent = t("history.playedSource") || "本场记录";
      playedOpt.dataset.i18n = "history.playedSource";
      elements.confirmSource.appendChild(playedOpt);

      // 2. 全部历史
      const historyOpt = document.createElement("option");
      historyOpt.value = "history";
      historyOpt.textContent = t("history.allSource") || "全部历史";
      historyOpt.dataset.i18n = "history.allSource";
      elements.confirmSource.appendChild(historyOpt);

      // 3. 历史场次 (限制显示最近 10 场)
      const rawSessions = res.data;
      const displaySessions = rawSessions.slice(0, 10);

      // Helper to parse filename as fallback if backend returns old model
      const parseSessionId = (id) => {
        let stem = id || "";
        if (stem.startsWith("played-")) {
          stem = stem.substring(7);
        }
        if (stem.endsWith(".json")) {
          stem = stem.substring(0, stem.length - 5);
        }
        const parts = stem.split("_");
        if (parts.length === 2) {
          const dateParts = parts[0].split("-");
          const timeParts = parts[1].split("-");
          if (dateParts.length === 3 && timeParts.length >= 2) {
            const year = parseInt(dateParts[0], 10);
            const month = parseInt(dateParts[1], 10);
            const day = parseInt(dateParts[2], 10);
            const hour = parseInt(timeParts[0], 10);
            const minute = parseInt(timeParts[1], 10);
            if (!isNaN(year) && !isNaN(month) && !isNaN(day) && !isNaN(hour) && !isNaN(minute)) {
              return { year, month, day, hour, minute };
            }
          }
        }
        return null;
      };

      // Group displaySessions by year and month
      const groups = [];
      displaySessions.forEach(session => {
        const parsed = (session.year > 0 && session.month > 0)
          ? session
          : (parseSessionId(session.id) || { year: 0, month: 0, day: 0, hour: 0, minute: 0 });

        let groupLabel = "";
        if (parsed.year > 0 && parsed.month > 0) {
          const lang = state.language || "zh";
          if (lang === "en") {
            const monthNames = [
              "January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November", "December"
            ];
            groupLabel = `${monthNames[parsed.month - 1]} ${parsed.year}`;
          } else {
            groupLabel = `${parsed.year} 年 ${parsed.month} 月`;
          }
        } else {
          groupLabel = t("history.otherSessions") || "其他场次";
        }

        let group = groups.find(g => g.label === groupLabel);
        if (!group) {
          group = { label: groupLabel, options: [] };
          groups.push(group);
        }

        // Format day and time: "x日 xx:xx" or "Day x, xx:xx"
        let optionText = "";
        if (parsed.day > 0) {
          const lang = state.language || "zh";
          const paddedHour = String(parsed.hour).padStart(2, "0");
          const paddedMinute = String(parsed.minute).padStart(2, "0");
          if (lang === "en") {
            optionText = `Day ${parsed.day}, ${paddedHour}:${paddedMinute}`;
          } else {
            optionText = `${parsed.day} 日 ${paddedHour}:${paddedMinute}`;
          }
        } else {
          optionText = session.id;
        }

        group.options.push({ value: session.id, text: optionText });
      });

      // Append groups to select element
      groups.forEach(group => {
        const optGroup = document.createElement("optgroup");
        optGroup.label = group.label;
        group.options.forEach(optData => {
          const opt = document.createElement("option");
          opt.value = optData.value;
          opt.textContent = optData.text;
          optGroup.appendChild(opt);
        });
        elements.confirmSource.appendChild(optGroup);
      });

      // 4. (仅显示最近 10 场) note
      if (rawSessions.length > 10) {
        const noteOpt = document.createElement("option");
        noteOpt.disabled = true;
        noteOpt.textContent = t("history.onlyRecentTen") || "（仅显示最近 10 场）";
        noteOpt.dataset.i18n = "history.onlyRecentTen";
        elements.confirmSource.appendChild(noteOpt);
      }

      if ([...elements.confirmSource.options].some(opt => opt.value === currentVal)) {
        elements.confirmSource.value = currentVal;
      }
      return true;
    }
  } catch (error) {
    console.error("加载场次列表失败:", error);
  }
  return false;
}

async function loadPlayedSessions() {
  if (state.playedSessionsLoaded) {
    return true;
  }
  if (state.playedSessionsLoadPromise) {
    return state.playedSessionsLoadPromise;
  }
  const request = fetchPlayedSessions();
  state.playedSessionsLoadPromise = request;
  try {
    const loaded = await request;
    state.playedSessionsLoaded = Boolean(loaded);
    return state.playedSessionsLoaded;
  } finally {
    if (state.playedSessionsLoadPromise === request) {
      state.playedSessionsLoadPromise = null;
    }
  }
}

async function downloadHistoryExport(format, source = "played", pageSize = 200) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  const normalizedSource = normalizedHistoryExportSource(source);
  const normalizedPageSize = normalizedHistoryExportPageSize(pageSize);
  if (!["csv", "image"].includes(normalizedFormat)) {
    return;
  }
  const params = new URLSearchParams({
    format: normalizedFormat,
    source: normalizedSource,
    page_size: String(normalizedPageSize),
  });
  const exportUrl = `/api/playlist/export?${params.toString()}`;
  const tauriStatus = await saveTauriBackendDownload(exportUrl);
  if (tauriStatus !== null) {
    return tauriStatus === "saved";
  }
  const exportDownload = window.BilikaraExportDownload;
  if (!exportDownload
    || typeof exportDownload.downloadBrowserFile !== "function") {
    throw new Error(t("history.exportFailed"));
  }
  const fallbackFilename = normalizedFormat === "csv"
    ? "bilikara-playlist.csv"
    : "bilikara-playlist.png";
  return exportDownload.downloadBrowserFile(exportUrl, {
    fallbackFilename,
    fallbackMessage: t("history.exportFailed"),
    headers: clientHeaders(),
    surface: "host",
    format: normalizedFormat,
    source: normalizedSource,
    pageSize: normalizedPageSize,
  });
}

async function exportHistory(format, source = "played", pageSize = 200) {
  return historyExportGuard.run(async () => {
    const normalizedSource = normalizedHistoryExportSource(source);
    const normalizedPageSize = normalizedHistoryExportPageSize(pageSize);
    const sourceLabel = historyExportSourceLabel(normalizedSource);
    try {
      const saved = await downloadHistoryExport(format, normalizedSource, normalizedPageSize);
      if (!saved) {
        return;
      }
      closeConfirm();
      setAppMessage(format === "csv"
        ? t("history.csvDownloadStarted", { source: sourceLabel })
        : t("history.imageDownloadStarted", { source: sourceLabel }));
    } catch (error) {
      setAppMessage(
        window.BilikaraExportDownload.normalizedErrorMessage(error, t("history.exportFailed")),
        true,
      );
    }
  });
}

function diagnosticBrowserInfo() {
  const userAgentData = navigator.userAgentData;
  const brands = Array.isArray(userAgentData?.brands)
    ? userAgentData.brands.map((item) => ({
      brand: String(item?.brand || ""),
      version: String(item?.version || ""),
    }))
    : [];
  return {
    user_agent: String(navigator.userAgent || ""),
    platform: String(userAgentData?.platform || navigator.platform || ""),
    mobile: Boolean(userAgentData?.mobile),
    brands,
  };
}

function setDiagnosticsBusy(busy) {
  state.diagnosticsBusy = Boolean(busy);
  if (elements.diagnosticCopyButton) {
    elements.diagnosticCopyButton.disabled = state.diagnosticsBusy;
  }
  if (elements.diagnosticPackageButton) {
    elements.diagnosticPackageButton.disabled = state.diagnosticsBusy;
  }
}

async function diagnosticResponse(path) {
  const exportDiagnostics = window.BilikaraExportDownload?.getExportDiagnosticsSnapshot
    ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot()
    : [];
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      browser: diagnosticBrowserInfo(),
      export_diagnostics: exportDiagnostics,
    }),
  });
  if (!response.ok) {
    let message = t("service.diagnosticsFailed");
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep the generic message for non-JSON failures.
    }
    throw new Error(message);
  }
  return response;
}

async function generateDiagnosticsMarkdown() {
  const response = await diagnosticResponse("/api/diagnostics/markdown");
  const payload = await response.json();
  return typeof payload?.data?.markdown === "string"
    ? payload.data.markdown
    : "";
}

function diagnosticsCopyController() {
  if (!state.diagnosticsCopyController) {
    const helper = window.BilikaraDiagnosticsCopy;
    if (!helper || typeof helper.createRetryController !== "function"
      || typeof helper.copyText !== "function") {
      throw new Error(t("service.diagnosticsFailed"));
    }
    state.diagnosticsCopyController = helper.createRetryController({
      generate: generateDiagnosticsMarkdown,
      copyText: (markdown) => helper.copyText(markdown, {
        fallbackMessage: t("service.diagnosticsFailed"),
      }),
      invalidMessage: t("service.diagnosticsFailed"),
    });
  }
  return state.diagnosticsCopyController;
}

async function copyDiagnosticsMarkdown() {
  if (state.diagnosticsBusy) {
    return;
  }
  setDiagnosticsBusy(true);
  try {
    const controller = diagnosticsCopyController();
    setAppMessage(controller.hasPendingMarkdown()
      ? t("service.diagnosticsReadyToCopy")
      : t("service.diagnosticsGenerating"));
    const result = await controller.copy();
    if (result.status === "copied") {
      setAppMessage(t("service.diagnosticsCopied"));
    } else {
      setAppMessage(t("service.diagnosticsReadyToCopy"), true);
    }
  } catch (error) {
    setAppMessage(
      window.BilikaraExportDownload.normalizedErrorMessage(
        error,
        t("service.diagnosticsFailed"),
      ),
      true,
    );
  } finally {
    setDiagnosticsBusy(false);
  }
}

async function downloadDiagnosticsPackage() {
  if (state.diagnosticsBusy) {
    return;
  }
  setDiagnosticsBusy(true);
  setAppMessage(t("service.diagnosticsGenerating"));
  try {
    const exportDiagnostics = window.BilikaraExportDownload?.getExportDiagnosticsSnapshot
      ? window.BilikaraExportDownload.getExportDiagnosticsSnapshot()
      : [];
    const tauriStatus = await saveTauriBackendDownload(
      "/api/diagnostics/package",
      JSON.stringify({
        browser: diagnosticBrowserInfo(),
        export_diagnostics: exportDiagnostics,
      }),
      t("service.diagnosticsFailed"),
      { format: "zip", source: "diagnostics", surface: "host" },
    );
    if (tauriStatus !== null) {
      if (tauriStatus === "saved") {
        setAppMessage(t("service.diagnosticsDownloaded"));
      } else {
        setAppMessage("");
      }
      return;
    }
    const response = await diagnosticResponse("/api/diagnostics/package");
    const blob = await response.blob();
    const filename = filenameFromContentDisposition(
      response.headers.get("Content-Disposition"),
      "bilikara-diagnostics.zip",
    );
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setAppMessage(t("service.diagnosticsDownloaded"));
  } catch (error) {
    setAppMessage(
      window.BilikaraExportDownload.normalizedErrorMessage(
        error,
        t("service.diagnosticsFailed"),
      ),
      true,
    );
  } finally {
    setDiagnosticsBusy(false);
  }
}

async function resetRuntimeData() {
  try {
    await apiPostStateSnapshot("/api/data/reset", {}, {
      onAccepted: () => {
        teardownMountedPlayer();
        disposeSharedAudioContext();
        closeConfirm();
        dismissBackupBanner();
        setAppMessage(t("service.dataCleared"));
        render();
      },
    });
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function resetPlayerState() {
  try {
    await apiPostStateSnapshot("/api/player/reset", {}, {
      onAccepted: () => {
        teardownMountedPlayer();
        disposeSharedAudioContext();
        state.localPlayerVolume = 1;
        state.localPlayerMuted = false;
        state.playerSettingsEchoSuppressUntil = 0;
        state.volumeSaveSeq += 1;
        state.avOffsetSaving = false;
        persistLocalVolumePreferences();
        closeConfirm();
        render();
        setAppMessage(t("service.playerReset"));
      },
    });
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function requestAppUpdateCheck({ automatic = false, force = false } = {}) {
  const includePreview = Boolean(state.updatePreviewEnabled);
  const channel = includePreview ? "preview" : "stable";
  if (automatic) {
    if (
      !state.updateAutomaticEnabled
      || (!force && state.updateAutomaticAttemptedChannels.has(channel))
    ) {
      return false;
    }
    state.updateAutomaticAttemptedChannels.add(channel);
  }
  if (state.updateCheckRequestInFlight) {
    return false;
  }
  const currentUpdate = appUpdateStatus();
  if (["downloading", "installing", "restarting"].includes(String(currentUpdate?.state || ""))) {
    return false;
  }

  state.updateCheckRequestInFlight = true;
  if (!automatic) {
    state.updateManualVisibleChannel = "";
    state.manualUpdateCheck = {
      includePreview,
      startedAt: Number(currentUpdate?.updated_at || 0),
    };
  }
  renderUpdatePreviewControl();
  try {
    await apiPost("/api/app/update/check", {
      include_preview: includePreview,
    }, { timeoutMs: appUpdateCheckTimeoutMs });
    return true;
  } catch (error) {
    if (!automatic) {
      state.manualUpdateCheck = null;
      setAppMessage(error?.message || t("service.updateFailed"), true);
    }
    return false;
  } finally {
    state.updateCheckRequestInFlight = false;
    renderUpdatePreviewControl();
  }
}

function scheduleStartupAppUpdateCheck() {
  if (state.startupUpdateCheckScheduled || !state.hasValidStateResponse) {
    return false;
  }
  state.startupUpdateCheckScheduled = true;
  if (!state.updateAutomaticEnabled) {
    return false;
  }
  requestAppUpdateCheck({ automatic: true }).catch(() => {});
  return true;
}

async function installAppUpdate(includePreview = false) {
  try {
    const updateStatus = await apiPost("/api/app/update/install", {
      include_preview: Boolean(includePreview),
    });
    closeConfirm();
    renderUpdatePreviewControl();
    const stateValue = String(updateStatus?.state || "");
    setAppMessage(
      updateStatus?.message || t("service.updateStarting"),
      stateValue === "failed" || stateValue === "unsupported",
    );
  } catch (error) {
    setAppMessage(error?.message || t("service.updateFailed"), true);
  }
}

async function checkAppUpdate(event) {
  if (state.updateCheckRequestInFlight || isAppUpdateBusy()) {
    return;
  }
  const update = appUpdateStatus();
  if (!shouldPresentCurrentChannelUpdate(update)) {
    await requestAppUpdateCheck({ automatic: false });
    return;
  }

  if (!update?.auto_update_supported) {
    const releaseUrl = safeHttpUrl(update?.release_url);
    if (releaseUrl) {
      openExternalUrl(releaseUrl);
      setAppMessage(t("service.openedReleases"));
    } else {
      setAppMessage(t("service.updateReleaseUrlInvalid"), true);
    }
    return;
  }

  const button = elements.updateCheckButton;
  const point = anchorPointForEvent(event, button || elements.cacheSettings);
  openConfirm({
    type: "install-app-update",
    includePreview: Boolean(update.include_preview),
    releaseUrl: update.release_url,
    message: t("service.installUpdatePrompt", {
      message: update?.message || t("service.updateFoundPrompt"),
    }),
    primaryLabel: t("service.update"),
    ...point,
    anchorElementId: button?.id || "update-check-button",
    anchorAlign: "end",
    anchorGap: 8,
  });
}


async function addSessionUser() {
  const name = String(elements.sessionUserInput.value || "").trim();
  if (!name) {
    setAppMessage(t("session.nameRequired"), true);
    return;
  }
  try {
    await apiPostStateSnapshot("/api/session-users/add", { name });
    elements.sessionUserInput.value = "";
    setAppMessage(t("session.added", { name }));
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function moveSessionUser(name, index) {
  try {
    await apiPostStateSnapshot("/api/session-users/reorder", { name, index });
    setAppMessage(t("session.orderUpdated"));
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function removeSessionUser(name) {
  try {
    await apiPostStateSnapshot("/api/session-users/remove", { name });
    if (elements.requesterSelect.value === name) {
      elements.requesterSelect.value = "";
    }
    setAppMessage(t("session.removed", { name }));
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
}

async function advanceLocalPlayerNow({
  showTransition = true,
  session = null,
  expectedPlaybackGeneration: issuedPlaybackGeneration = null,
} = {}) {
  if (
    session
    && !isCurrentHostPlaybackSession(session, session.video, session.audio)
  ) {
    return false;
  }
  if (state.localAdvanceInFlight) {
    return false;
  }
  const expectedPlaybackGeneration = issuedPlaybackGeneration
    ?? session?.playbackGeneration
    ?? state.data?.playback_generation;
  if (
    !isSafeHostSnapshotInteger(expectedPlaybackGeneration, 1)
    || (
      issuedPlaybackGeneration !== null
      && state.data?.playback_generation !== expectedPlaybackGeneration
    )
  ) {
    return false;
  }
  const shouldResumeOnFailure = state.localShouldBePlaying;
  const nextItemId = String(queuedNextItem()?.id || "");
  const delaySeconds = manualTransitionOverlaySeconds(state.data);
  clearLocalAdvanceDelay({ hideOverlay: !showTransition });
  state.pendingSongTransitionOverlayData = null;
  state.pendingSongTransitionGeneration = 0;
  const transitionGeneration = (
    showTransition && delaySeconds > 0 && nextItemId
      ? registerManualTransitionHold(nextItemId)
      : 0
  );
  const localAdvanceOwnershipToken = state.localAdvanceDelayToken;
  const releaseOwnedLocalAdvance = () => {
    const ownsLocalAdvance = Boolean(
      state.localAdvanceDelayToken === localAdvanceOwnershipToken
      && !state.pendingSongTransitionOverlayData
      && state.pendingSongTransitionGeneration === 0
      && (
        transitionGeneration > 0
          ? transitionGeneration === state.manualTransitionHoldGeneration
          : state.manualTransitionHoldGeneration === 0
      )
    );
    if (!ownsLocalAdvance) {
      return false;
    }
    clearLocalAdvanceDelay({ resetInFlight: true });
    if (
      state.data?.playback_generation === expectedPlaybackGeneration
      && (
        !session
        || isCurrentHostPlaybackSession(session, session.video, session.audio)
      )
    ) {
      state.localShouldBePlaying = shouldResumeOnFailure;
      syncMountedLocalPlayer(true);
    }
    return true;
  };
  state.localAdvanceInFlight = true;
  try {
    const previousData = state.data;
    const outcome = await apiPostExactStateCommand("/api/player/next", {
      playback_generation: expectedPlaybackGeneration,
    });
    if (!outcome.commandApplied) {
      releaseOwnedLocalAdvance();
      return false;
    }
    if (!outcome.snapshotAccepted) {
      if (
        nextItemId
        && currentItemIdFromData(state.data) === nextItemId
        && state.data?.playback_generation > expectedPlaybackGeneration
      ) {
        if (showTransition && transitionGeneration) {
          maybeShowSongTransitionOverlay(previousData, state.data, {
            force: true,
            generation: transitionGeneration,
          });
        }
        render();
        return true;
      }
      releaseOwnedLocalAdvance();
      return false;
    }
    if (showTransition && transitionGeneration) {
      maybeShowSongTransitionOverlay(previousData, state.data, {
        force: true,
        generation: transitionGeneration,
      });
    }
    render();
    return true;
  } catch (error) {
    releaseOwnedLocalAdvance();
    setAppMessage(error.message, true);
    return false;
  } finally {
    if (!shouldHoldCurrentItemForTransition(state.data?.current_item)) {
      state.localAdvanceInFlight = false;
    }
  }
}

async function requestNextTrack(expectedPlaybackGeneration = null) {
  if (
    expectedPlaybackGeneration !== null
    && (
      !isSafeHostSnapshotInteger(expectedPlaybackGeneration, 1)
      || state.data?.playback_generation !== expectedPlaybackGeneration
    )
  ) {
    return false;
  }
  const session = state.hostPlaybackSession;
  const capturedSession = isCurrentHostPlaybackSession(
    session,
    session?.video,
    session?.audio,
  ) ? session : null;
  return handleLocalPlaybackEnded(
    "manual-next",
    capturedSession,
    expectedPlaybackGeneration,
  );
}

async function handleLocalPlaybackEnded(
  reason = "media-ended",
  session = null,
  expectedPlaybackGeneration = null,
) {
  if (
    session
    && !isCurrentHostPlaybackSession(session, session.video, session.audio)
  ) {
    return false;
  }
  if (state.localAdvanceInFlight) {
    return false;
  }
  const delaySeconds = currentSongAdvanceDelaySeconds();
  if (delaySeconds <= 0 || !queuedNextItem()) {
    return advanceLocalPlayerNow({
      showTransition: false,
      session,
      expectedPlaybackGeneration,
    });
  }
  return advanceLocalPlayerNow({
    showTransition: true,
    session,
    expectedPlaybackGeneration,
  });
}

async function reorderPlaylist(itemId, index) {
  const accepted = await apiPostStateSnapshot("/api/playlist/reorder", { item_id: itemId, index });
  render();
  return accepted;
}

async function resortPlaylistByCycle() {
  await apiPostStateSnapshot("/api/playlist/resort");
  setAppMessage(t("list.resorted"));
  render();
}

async function setCacheLimit(maxCacheItems) {
  state.cacheLimitDraftValue = maxCacheItems;
  state.cacheLimitQueuedValue = maxCacheItems;
  renderCacheSlider(state.data?.cache_policy);
  if (state.cacheLimitSaving) {
    return;
  }

  const currentValue = Number(state.data?.cache_policy?.max_cache_items || 0);
  if (maxCacheItems === currentValue) {
    state.cacheLimitDraftValue = null;
    state.cacheLimitQueuedValue = null;
    renderCacheSlider(state.data?.cache_policy);
    return;
  }

  state.cacheLimitSaving = true;
  renderCacheSlider(state.data?.cache_policy);
  try {
    while (state.cacheLimitQueuedValue !== null) {
      const submittedValue = state.cacheLimitQueuedValue;
      state.cacheLimitQueuedValue = null;
      if (submittedValue === Number(state.data?.cache_policy?.max_cache_items || 0)) {
        if (state.cacheLimitDraftValue === submittedValue) {
          state.cacheLimitDraftValue = null;
        }
        continue;
      }

      const requestSequence = state.cacheLimitRequestSequence + 1;
      state.cacheLimitRequestSequence = requestSequence;
      state.cacheLimitActiveRequestSequence = requestSequence;
      state.cacheLimitSubmittedValue = submittedValue;
      let acknowledged = false;
      let requestError = null;
      try {
        await apiPostStateSnapshot(
          "/api/cache-policy",
          { max_cache_items: submittedValue },
          {
            onAccepted() {
              acknowledged = Number(
                state.data?.cache_policy?.max_cache_items || 0,
              ) === submittedValue;
            },
          },
        );
      } catch (error) {
        requestError = error;
      }
      if (state.cacheLimitActiveRequestSequence !== requestSequence) {
        continue;
      }
      if (state.cacheLimitDraftValue === submittedValue) {
        state.cacheLimitDraftValue = null;
      }
      if (state.cacheLimitQueuedValue === submittedValue) {
        state.cacheLimitQueuedValue = null;
      }
      state.cacheLimitSubmittedValue = null;
      state.cacheLimitActiveRequestSequence = 0;
      if (requestError) {
        setAppMessage(requestError.message, true);
      } else if (acknowledged) {
        setAppMessage(t("service.cacheLimitUpdated", { count: submittedValue }));
      }
      render();
    }
  } finally {
    state.cacheLimitSaving = false;
    state.cacheLimitSubmittedValue = null;
    state.cacheLimitActiveRequestSequence = 0;
    if (state.data) {
      renderCacheSlider(state.data.cache_policy);
    }
  }
}

async function setAdvanceDelay(delaySeconds) {
  state.advanceDelayDraftValue = delaySeconds;
  state.advanceDelayQueuedValue = delaySeconds;
  renderAdvanceDelaySlider(state.data?.player_settings);
  if (state.advanceDelaySaving) {
    return;
  }

  const currentValue = currentSongAdvanceDelaySeconds();
  if (delaySeconds === currentValue) {
    state.advanceDelayDraftValue = null;
    state.advanceDelayQueuedValue = null;
    renderAdvanceDelaySlider(state.data?.player_settings);
    return;
  }

  state.advanceDelaySaving = true;
  renderAdvanceDelaySlider(state.data?.player_settings);
  try {
    while (state.advanceDelayQueuedValue !== null) {
      const submittedValue = state.advanceDelayQueuedValue;
      state.advanceDelayQueuedValue = null;
      if (submittedValue === currentSongAdvanceDelaySeconds()) {
        if (state.advanceDelayDraftValue === submittedValue) {
          state.advanceDelayDraftValue = null;
        }
        continue;
      }

      const requestSequence = state.advanceDelayRequestSequence + 1;
      state.advanceDelayRequestSequence = requestSequence;
      state.advanceDelayActiveRequestSequence = requestSequence;
      state.advanceDelaySubmittedValue = submittedValue;
      let acknowledged = false;
      let requestError = null;
      try {
        await apiPostStateSnapshot(
          "/api/player/advance-delay",
          { delay_seconds: submittedValue },
          {
            onAccepted() {
              acknowledged = currentSongAdvanceDelaySeconds() === submittedValue;
            },
          },
        );
      } catch (error) {
        requestError = error;
      }
      if (state.advanceDelayActiveRequestSequence !== requestSequence) {
        continue;
      }
      if (state.advanceDelayDraftValue === submittedValue) {
        state.advanceDelayDraftValue = null;
      }
      if (state.advanceDelayQueuedValue === submittedValue) {
        state.advanceDelayQueuedValue = null;
      }
      state.advanceDelaySubmittedValue = null;
      state.advanceDelayActiveRequestSequence = 0;
      if (requestError) {
        setAppMessage(requestError.message, true);
      } else if (acknowledged) {
        setAppMessage(t("service.advanceDelayUpdated", { seconds: submittedValue }));
      }
      render();
    }
  } finally {
    state.advanceDelaySaving = false;
    state.advanceDelaySubmittedValue = null;
    state.advanceDelayActiveRequestSequence = 0;
    if (state.data) {
      renderAdvanceDelaySlider(state.data.player_settings);
    }
  }
}

function isDownkyiDownloadSource(downloadSource) {
  return String(downloadSource || "").trim().toLowerCase() === "downkyi";
}

function currentCacheDownloadSource() {
  return String(state.data?.cache_policy?.download_source || "bbdown");
}

function restoreCacheDownloadSourceSelect() {
  if (elements.cacheDownloadSourceSelect) {
    elements.cacheDownloadSourceSelect.value = currentCacheDownloadSource();
  }
}

function aria2cPrepareConfirmMessage(status) {
  const path = String(status?.manual_path || status?.path || "tools/aria2c");
  const url = String(status?.install_url || "https://github.com/aria2/aria2/releases");
  if (status?.auto_prepare_supported) {
    return t("service.aria2cDownloadConfirm", { path });
  }
  return t("service.aria2cInstallRequired", { path, url });
}

async function setDownloadSourcePreference(downloadSource, selectedLabel) {
  if (!downloadSource || downloadSource === currentCacheDownloadSource()) {
    return;
  }

  if (isDownkyiDownloadSource(downloadSource)) {
    state.downloadSourcePreparing = true;
    renderCachePolicyControls(state.data?.cache_policy);
    let status = null;
    try {
      status = await apiPost("/api/cache-downloader/status", { download_source: downloadSource });
    } catch (error) {
      restoreCacheDownloadSourceSelect();
      setAppMessage(error.message, true);
      return;
    } finally {
      state.downloadSourcePreparing = false;
      if (state.data) {
        renderCachePolicyControls(state.data.cache_policy);
      }
    }

    if (!status?.ready) {
      if (status?.auto_prepare_supported) {
        await prepareDownloadSourceAndApply({
          type: "prepare-download-source",
          downloadSource,
          selectedLabel,
          canPrepare: true,
        });
        return;
      }
      restoreCacheDownloadSourceSelect();
      openConfirm({
        type: "prepare-download-source",
        downloadSource,
        selectedLabel,
        canPrepare: false,
        message: aria2cPrepareConfirmMessage(status),
        primaryLabel: t("common.confirm"),
        anchorElementId: "cache-download-source-select",
        anchorAlign: "end",
        anchorGap: 8,
      });
      return;
    }
  }

  await setCachePolicyPreference(
    { download_source: downloadSource },
    t("service.downloadSourceUpdated", { source: selectedLabel }),
  );
}

async function prepareDownloadSourceAndApply(intent) {
  const downloadSource = String(intent?.downloadSource || "").trim();
  if (!downloadSource) {
    closeConfirm();
    return;
  }
  if (!intent?.canPrepare) {
    closeConfirm();
    restoreCacheDownloadSourceSelect();
    setAppMessage(intent?.message || t("service.aria2cInstallRequired", { path: "tools/aria2c", url: "https://github.com/aria2/aria2/releases" }), true);
    return;
  }

  state.downloadSourcePreparing = true;
  renderCachePolicyControls(state.data?.cache_policy);
  setAppMessage(t("service.aria2cPreparing"));
  try {
    await apiPost("/api/cache-downloader/prepare", { download_source: downloadSource });
    await apiPostStateSnapshot("/api/cache-policy", { download_source: downloadSource });
    closeConfirm();
    setAppMessage(t("service.downloadSourceUpdated", { source: intent.selectedLabel || downloadSource }));
    render();
  } catch (error) {
    restoreCacheDownloadSourceSelect();
    setAppMessage(error.message, true);
  } finally {
    state.downloadSourcePreparing = false;
    if (state.data) {
      renderCachePolicyControls(state.data.cache_policy);
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
    await apiPostStateSnapshot("/api/cache-policy", payload);
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
  const numeric = Number(offsetMs);
  if (!Number.isFinite(numeric)) {
    return;
  }
  await dispatchAvDelayAction({ type: "set_effective", effective_delay_ms: Math.round(numeric) });
}

async function dispatchAvDelayAction(action) {
  if (state.avOffsetSaving) {
    return;
  }
  const previousOffsetMs = currentAvOffsetMs();
  const activeElement = document.activeElement;
  activeElement?.setAttribute?.("aria-busy", "true");
  state.avOffsetSaving = true;
  renderAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
  try {
    const decision = await apiPost(
      "/api/player/av-delay-action",
      action,
      { timeoutMs: avDelayRequestTimeoutMs },
    );
    state.data.player_settings = {
      ...state.data?.player_settings,
      av_offset_ms: Number(decision?.effective_delay_ms || 0),
      av_delay: decision,
    };
    render();
    resyncMountedLocalPlayerIfOffsetChanged(previousOffsetMs);
  } catch (error) {
    setAppMessage(error.message, true);
    render();
  } finally {
    state.avOffsetSaving = false;
    activeElement?.removeAttribute?.("aria-busy");
    renderAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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
    "retry-cache": [
      "/api/cache/retry",
      {
        item_id: itemId,
        expected_item_incarnation_id: button.dataset.itemIncarnationId,
      },
    ],
  };

  const target = actionMap[action];
  if (!target) {
    return;
  }
  if (
    action === "play-now"
    && manualTransitionOverlaySeconds(state.data) > 0
    && state.localAdvanceInFlight
  ) {
    return;
  }
  if (button.getAttribute("aria-busy") === "true") {
    return;
  }
  const originallyDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");

  const shouldResumeOnFailure = state.localShouldBePlaying;
  let transitionGeneration = 0;
  if (action === "play-now" && manualTransitionOverlaySeconds(state.data) > 0) {
    clearLocalAdvanceDelay();
    state.pendingSongTransitionOverlayData = null;
    state.pendingSongTransitionGeneration = 0;
    transitionGeneration = registerManualTransitionHold(itemId);
    state.localAdvanceInFlight = true;
  }
  try {
    const previousData = state.data;
    const outcome = action === "retry-cache"
      ? await apiPostExactStateCommand(target[0], target[1])
      : {
        snapshotAccepted: await apiPostStateSnapshot(target[0], target[1]),
        commandApplied: true,
      };
    if (!outcome.commandApplied) {
      if (outcome.snapshotAccepted) {
        render();
      }
      return;
    }
    if (!outcome.snapshotAccepted) {
      return;
    }
    if (action === "play-now") {
      maybeShowSongTransitionOverlay(previousData, state.data, {
        force: true,
        generation: transitionGeneration,
      });
    }
    if (action === "play-now" || action === "move-next") {
      closeOpenMenus({ restoreFocus: true });
    }
    render();
  } catch (error) {
    if (
      transitionGeneration
      && transitionGeneration === state.manualTransitionHoldGeneration
    ) {
      clearLocalAdvanceDelay({ resetInFlight: true });
      state.localShouldBePlaying = shouldResumeOnFailure;
      syncMountedLocalPlayer(true);
    }
    setAppMessage(error.message, true);
  } finally {
    button.disabled = originallyDisabled;
    button.removeAttribute("aria-busy");
    if (!shouldHoldCurrentItemForTransition(state.data?.current_item)) {
      state.localAdvanceInFlight = false;
    }
  }
}

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const point = anchorPointForEvent(event.submitter || event, elements.addForm);
  await handleAdd("tail", point);
});

elements.searchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.searchModeState.local.loading) {
    return;
  }
  const query = String(elements.searchQuery.value || "").trim();
  const modeState = state.searchModeState.local;
  modeState.draft = String(elements.searchQuery.value || "");
  if (!query) {
    hideSearchResults();
    modeState.items = [];
    modeState.error = t("search.keywordRequired");
    modeState.message = "";
    setSearchMessage(modeState.error, true);
    return;
  }

  const seq = modeState.seq + 1;
  modeState.seq = seq;
  modeState.loading = true;
  modeState.submitted = query;
  modeState.error = "";
  modeState.message = t("search.localSearching");
  elements.searchButton.disabled = true;
  elements.searchButton.setAttribute("aria-busy", "true");
  setSearchMessage(modeState.message);
  try {
    const items = await searchGatchaCache(query);
    if (modeState.seq !== seq) {
      return;
    }
    modeState.items = items;
    modeState.message = items.length ? t("search.localFound", { count: items.length }) : t("search.localNotFound");
    renderSearchResults(items);
    setSearchMessage(modeState.message);
  } catch (error) {
    if (modeState.seq === seq) {
      modeState.items = [];
      modeState.error = error.message;
      hideSearchResults();
      setSearchMessage(modeState.error, true);
    }
  } finally {
    if (modeState.seq === seq) {
      modeState.loading = false;
      elements.searchButton.disabled = false;
      elements.searchButton.removeAttribute("aria-busy");
    }
  }
});

elements.searchQuery?.addEventListener("input", () => {
  state.searchModeState.local.draft = elements.searchQuery.value;
});

function searchResultRequestTarget(event, container) {
  if (event.target.closest("button[data-dev-action]")) {
    return null;
  }
  const button = event.target.closest("button[data-url]");
  if (button && container?.contains(button)) {
    return {
      url: String(button.dataset.url || "").trim(),
      anchor: button,
      button,
    };
  }
  return null;
}

function openSearchResultDetail(event, container, source) {
  if (!searchDetailController || !container || event.target.closest("button[data-url]")) {
    return false;
  }
  if (event.target.closest("button[data-dev-action]")) {
    return false;
  }
  const card = event.target.closest(".search-result-item[data-url]");
  if (!card || !container.contains(card)) {
    return false;
  }
  const item = searchResultItemByElement.get(card);
  if (!item) {
    return false;
  }
  const origin = requestDetailOriginForContainer(card, source);
  if (!origin?.key) {
    return false;
  }
  const selectedKey = requestResultItemKey(item);
  const selected = state.requestDetailSelections[origin.key];
  selected.selectedKey = selectedKey;
  selected.origin = { ...origin };
  selected.focusElement = card;
  selected.closedForNavigation = false;
  state.activeRequestDetailOriginKey = origin.key;
  Array.from(container.querySelectorAll?.(".search-result-item") || []).forEach((row) => {
    if (row.dataset.requestResultOrigin !== origin.key) {
      return;
    }
    const isSelected = row === card;
    row.classList.toggle("is-selected", isSelected);
    row.setAttribute("aria-current", isSelected ? "true" : "false");
  });
  const avatarUrl = window.BilikaraSongDetail.ownerAvatarFromCachedOwners(
    item,
    state.followBrowseData?.owners,
  );
  event.preventDefault();
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
  searchDetailController.open({
    ...item,
    avatar_url: avatarUrl,
    detailSource: source,
    detailOrigin: { ...origin },
    detailSelectedKey: selectedKey,
  });
  return true;
}

function initSearchDetailController() {
  if (searchDetailController || !window.BilikaraSongDetail) {
    return;
  }
  const container = elements.requestWorkspace;
  searchDetailController = window.BilikaraSongDetail.createSongDetailController({
    container,
    t,
    requestButtonClass: "next-button",
    nextButtonClass: "toolbar-button",
    onOpenExternal: openExternalUrl,
    resolveReturnFocus: resolveRequestDetailReturnFocus,
    onClose: ({ item, reason }) => {
      const originKey = String(item?.detailOrigin?.key || state.activeRequestDetailOriginKey || "");
      const selected = originKey ? state.requestDetailSelections?.[originKey] : null;
      if (selected && reason !== "navigation") {
        selected.closedForNavigation = false;
      }
      if (state.activeRequestDetailOriginKey === originKey) {
        state.activeRequestDetailOriginKey = "";
      }
    },
    onRequest: (url, position, item) => handleAddByUrl(
      url,
      position,
      anchorPointForEvent({}, searchDetailController?.root || container),
      String(item?.detailSource || "modalSearch"),
      { originatedFromDetail: true },
    ),
  });
}

elements.searchResults.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.searchResults, "search")) {
    return;
  }
  const target = searchResultRequestTarget(event, elements.searchResults);
  if (!target) {
    return;
  }
  if (!target.url || (target.button && target.button.disabled)) {
    return;
  }

  let originalText = "";
  if (target.button) {
    target.button.disabled = true;
    target.button.setAttribute("aria-busy", "true");
    originalText = target.button.textContent;
    target.button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await handleAddByUrl(target.url, "tail", anchorPointForEvent(event, target.anchor), "search");
  } finally {
    if (target.button) {
      target.button.disabled = false;
      target.button.removeAttribute("aria-busy");
      target.button.textContent = originalText;
    }
  }
});

async function handleLarkSearchSubmit(event) {
  event.preventDefault();
  const modeState = state.searchModeState.shared;
  if (state.larkSearchLoading || modeState.loading) {
    return;
  }
  const query = String(elements.larkSearchQuery?.value || "").trim();
  modeState.draft = String(elements.larkSearchQuery?.value || "");
  if (!query) {
    renderSearchResultItems(elements.larkSearchResults, []);
    modeState.items = [];
    modeState.error = t("search.keywordRequired");
    modeState.message = "";
    setLarkSearchMessage(modeState.error, true);
    return;
  }

  state.larkSearchLoading = true;
  modeState.loading = true;
  modeState.submitted = query;
  modeState.error = "";
  if (elements.larkSearchButton) {
    elements.larkSearchButton.disabled = true;
    elements.larkSearchButton.setAttribute("aria-busy", "true");
  }
  const searchSeq = state.larkSearchSeq + 1;
  state.larkSearchSeq = searchSeq;
  const seenBvids = new Set();
  const collectedItems = [];
  let partialFailure = false;
  if (elements.larkSearchResults) {
    elements.larkSearchResults.innerHTML = "";
    elements.larkSearchResults.classList.remove("hidden");
  }
  setLarkSearchMessage(t("search.larkSearching"));
  try {
    const poolItems = await searchLarkPool(query);
    if (state.larkSearchSeq !== searchSeq) {
      return;
    }
    const freshItems = poolItems.filter((item) => {
      const bvid = String(item?.bvid || "").trim();
      if (!bvid || seenBvids.has(bvid)) {
        return false;
      }
      seenBvids.add(bvid);
      return true;
    });
    if (freshItems.length) {
      collectedItems.push(...freshItems);
      appendSearchResultItems(elements.larkSearchResults, freshItems);
    }
    if (state.larkSearchSeq !== searchSeq) {
      return;
    }
    if (!collectedItems.length) {
      renderSearchResultItems(elements.larkSearchResults, [], t("search.larkNoResults"));
    }
    modeState.items = collectedItems;
    modeState.message = (
      collectedItems.length
        ? t(partialFailure ? "search.larkFoundPartial" : "search.larkFound", { count: collectedItems.length })
        : partialFailure
          ? t("search.larkPartialNoResults")
          : t("search.larkNoResultsLong")
    );
    setLarkSearchMessage(modeState.message, partialFailure && !collectedItems.length);
  } catch (error) {
    if (state.larkSearchSeq === searchSeq) {
      modeState.items = [];
      modeState.error = error.message;
      renderSearchResultItems(elements.larkSearchResults, []);
      setLarkSearchMessage(modeState.error, true);
    }
  } finally {
    if (state.larkSearchSeq === searchSeq) {
      state.larkSearchLoading = false;
      modeState.loading = false;
      if (elements.larkSearchButton) {
        elements.larkSearchButton.disabled = false;
        elements.larkSearchButton.removeAttribute("aria-busy");
      }
    }
  }
}

elements.larkSearchForm?.addEventListener("submit", handleLarkSearchSubmit);
elements.larkSearchQuery?.addEventListener("input", () => {
  state.searchModeState.shared.draft = elements.larkSearchQuery.value;
});

elements.larkSearchResults?.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.larkSearchResults, "lark")) {
    return;
  }
  const target = searchResultRequestTarget(event, elements.larkSearchResults);
  if (!target) {
    return;
  }
  if (!target.url || (target.button && target.button.disabled)) {
    return;
  }
  let originalText = "";
  if (target.button) {
    target.button.disabled = true;
    target.button.setAttribute("aria-busy", "true");
    originalText = target.button.textContent;
    target.button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await handleAddByUrl(target.url, "tail", anchorPointForEvent(event, target.anchor), "lark");
  } finally {
    if (target.button) {
      target.button.disabled = false;
      target.button.removeAttribute("aria-busy");
      target.button.textContent = originalText;
    }
  }
});

elements.sessionUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await addSessionUser();
});

let draggedSessionUser = null;

function clearSessionUserDropIndicators() {
  elements.sessionUserList
    ?.querySelectorAll(".session-user-badge")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

async function removeDraggedSessionUser() {
  if (!draggedSessionUser || draggedSessionUser.dataset.deleted === "true") {
    return;
  }
  const name = draggedSessionUser.dataset.name;
  draggedSessionUser.dataset.deleted = "true";
  draggedSessionUser.style.display = "none";
  await removeSessionUser(name);
}

function finishSessionUserDragUi() {
  draggedSessionUser?.classList.remove("dragging");
  elements.sessionUsersPanel?.classList.remove("is-dragging");
  elements.sessionUserTrash?.classList.remove("drag-over");
  clearSessionUserDropIndicators();
}

// 1. Prevent default on document dragenter to remove the forbidden icon in WebView/WebKit.
document.addEventListener("dragenter", (e) => {
  if (draggedSessionUser) {
    e.preventDefault();
  }
});

// 2. Prevent default on document dragover to permit drop anywhere.
document.addEventListener("dragover", (e) => {
  if (!draggedSessionUser) {
    return;
  }
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "move";
  }
  // If we drag outside the list and we are not natively over the trash, clear drop indicators.
  const target = e.target instanceof Element ? e.target : null;
  if (target && !elements.sessionUserList.contains(target) && target !== elements.sessionUserTrash && !elements.sessionUserTrash.contains(target)) {
    state.sessionUserDragTarget = null;
    state.sessionUserDragAfter = false;
    clearSessionUserDropIndicators();
  }
});

document.addEventListener("drop", (e) => {
  if (draggedSessionUser) {
    e.preventDefault();
  }
});

// 3. Handle drag start for badge items.
elements.sessionUserList.addEventListener("dragstart", (e) => {
  const badge = e.target.closest(".session-user-badge");
  if (!badge) return;
  draggedSessionUser = badge;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", badge.dataset.name);
  if (typeof e.dataTransfer.setDragImage === "function") {
    const rect = badge.getBoundingClientRect();
    e.dataTransfer.setDragImage(
      badge,
      Math.max(0, e.clientX - rect.left),
      Math.max(0, e.clientY - rect.top),
    );
  }
  setTimeout(() => {
    badge.classList.add("dragging");
    elements.sessionUsersPanel?.classList.add("is-dragging");
  }, 0);
});

// 4. Handle dragover for reordering.
elements.sessionUserList.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (!draggedSessionUser) return;
  e.dataTransfer.dropEffect = "move";

  const allElements = [...elements.sessionUserList.querySelectorAll(".session-user-badge")];
  const draggableElements = allElements.filter(el => el !== draggedSessionUser);
  allElements.forEach(el => el.classList.remove("drop-before", "drop-after"));

  if (allElements.length === 0) {
    state.sessionUserDragTarget = null;
    state.sessionUserDragAfter = false;
    return;
  }

  let closestElement = null;
  let minDistance = Infinity;

  for (const child of allElements) {
    const box = child.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const distance = (e.clientX - centerX) ** 2 + (e.clientY - centerY) ** 2;
    if (distance < minDistance) {
      minDistance = distance;
      closestElement = child;
    }
  }

  if (closestElement) {
    const box = closestElement.getBoundingClientRect();
    const isAfter = e.clientX >= box.left + box.width / 2;

    if (closestElement === draggedSessionUser) {
      if (isAfter) {
        const next = draggedSessionUser.nextElementSibling;
        if (next && next.classList.contains("session-user-badge")) {
          state.sessionUserDragTarget = next;
          state.sessionUserDragAfter = false;
          next.classList.add("drop-before");
        } else {
          state.sessionUserDragTarget = null;
          state.sessionUserDragAfter = true;
          draggedSessionUser.classList.add("drop-after");
        }
      } else {
        state.sessionUserDragTarget = draggedSessionUser;
        state.sessionUserDragAfter = false;
        const prev = draggedSessionUser.previousElementSibling;
        if (prev && prev.classList.contains("session-user-badge")) {
          prev.classList.add("drop-after");
        } else {
          draggedSessionUser.classList.add("drop-before");
        }
      }
    } else {
      if (isAfter) {
        if (closestElement.nextElementSibling === draggedSessionUser) {
          state.sessionUserDragTarget = draggedSessionUser;
          state.sessionUserDragAfter = false;
          closestElement.classList.add("drop-after");
        } else {
          const idx = draggableElements.indexOf(closestElement);
          if (idx !== -1 && idx < draggableElements.length - 1) {
            state.sessionUserDragTarget = draggableElements[idx + 1];
            state.sessionUserDragAfter = false;
            draggableElements[idx + 1].classList.add("drop-before");
          } else {
            state.sessionUserDragTarget = null;
            state.sessionUserDragAfter = true;
            closestElement.classList.add("drop-after");
          }
        }
      } else {
        state.sessionUserDragTarget = closestElement;
        state.sessionUserDragAfter = false;
        closestElement.classList.add("drop-before");
      }
    }
  }
});

// 5. Handle drag end.
document.addEventListener("dragend", async (e) => {
  if (draggedSessionUser) {
    finishSessionUserDragUi();

    if (!draggedSessionUser.dataset.deleted) {
      if (state.sessionUserDragTarget) {
        elements.sessionUserList.insertBefore(draggedSessionUser, state.sessionUserDragTarget);
      } else if (state.sessionUserDragAfter) {
        elements.sessionUserList.appendChild(draggedSessionUser);
      }

      const name = draggedSessionUser.dataset.name;
      const newElements = [...elements.sessionUserList.querySelectorAll(".session-user-badge")];
      const newIndex = newElements.indexOf(draggedSessionUser);
      const oldIndex = parseInt(draggedSessionUser.dataset.index, 10);

      if (newIndex !== -1 && newIndex !== oldIndex) {
        await moveSessionUser(name, newIndex);
      }
    }
    draggedSessionUser = null;
    state.sessionUserDragTarget = null;
    state.sessionUserDragAfter = false;
  }
});

// 6. Handle trash can events natively.
if (elements.sessionUserTrash) {
  elements.sessionUserTrash.addEventListener("dragenter", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    elements.sessionUserTrash.classList.add("drag-over");
    clearSessionUserDropIndicators();
  });

  elements.sessionUserTrash.addEventListener("dragleave", (e) => {
    elements.sessionUserTrash.classList.remove("drag-over");
  });

  elements.sessionUserTrash.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    elements.sessionUserTrash.classList.add("drag-over");
    clearSessionUserDropIndicators();
  });

  elements.sessionUserTrash.addEventListener("drop", async (e) => {
    e.preventDefault();
    finishSessionUserDragUi();
    await removeDraggedSessionUser();
  });
}


elements.queueNextButton.addEventListener("click", async (event) => {
  const point = anchorPointForEvent(event, elements.queueNextButton);
  await handleAdd("next", point);
});

elements.resortPlaylistButton?.addEventListener("click", async () => {
  if (elements.resortPlaylistButton.disabled) {
    return;
  }

  const prevText = elements.resortPlaylistButton.textContent;
  elements.resortPlaylistButton.disabled = true;
  elements.resortPlaylistButton.setAttribute("aria-busy", "true");
  elements.resortPlaylistButton.textContent = t("gatcha.adding") || "处理中…";

  try {
    await resortPlaylistByCycle();
  } catch (error) {
    setAppMessage(error.message, true);
  } finally {
    elements.resortPlaylistButton.disabled = false;
    elements.resortPlaylistButton.removeAttribute("aria-busy");
    elements.resortPlaylistButton.textContent = prevText;
  }
});

elements.copyRemoteUrlButton.addEventListener("click", async () => {
  await copyRemoteUrl();
});

elements.backupActionButton.addEventListener("click", async () => {
  if (elements.backupActionButton.disabled) {
    return;
  }
  const previousText = elements.backupActionButton.textContent;
  elements.backupActionButton.disabled = true;
  elements.backupActionButton.setAttribute("aria-busy", "true");
  elements.backupActionButton.textContent = t("gatcha.adding");
  try {
    if (state.backupBannerMode === "previous_session") {
      await continuePreviousSession();
    } else {
      await discardBackup();
    }
  } finally {
    elements.backupActionButton.disabled = false;
    elements.backupActionButton.removeAttribute("aria-busy");
    elements.backupActionButton.textContent = previousText;
  }
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
  if (state.cacheSettingsOpen) {
    state.displaySettingsOpen = false;
    state.presentationSettingsOpen = false;
    syncDisplayPanelVisibility();
    syncPresentationPanelVisibility();
  }
  syncCachePanelVisibility({ forceLoginRefresh: state.cacheSettingsOpen });
});

elements.cachePanelAdvancedTrigger?.addEventListener("click", () => {
  state.cacheAdvancedOpen = !state.cacheAdvancedOpen;
  syncCachePanelVisibility();
});

document.querySelectorAll(".cache-contextual-info-region").forEach((region) => {
  const info = region.querySelector(".cache-advanced-info");
  region.addEventListener("click", (event) => {
    const button = event.target.closest(".cache-advanced-info-button");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (info?.classList.contains("is-pinned")) {
      closeCacheAdvancedInfo();
      return;
    }
    closeCacheAdvancedInfo();
    setCacheAdvancedInfoVisible(info, { pinned: true });
  });
  region.addEventListener("pointerenter", (event) => {
    if (!info || !cacheAdvancedInfoSupportsHover(event) || info.classList.contains("is-visible")) {
      return;
    }
    if (cacheAdvancedInfoLeaveTimer) {
      window.clearTimeout(cacheAdvancedInfoLeaveTimer);
      cacheAdvancedInfoLeaveTimer = null;
    }
    if (cacheAdvancedInfoHoverTimer) {
      window.clearTimeout(cacheAdvancedInfoHoverTimer);
    }
    cacheAdvancedInfoHoverTimer = window.setTimeout(() => {
      cacheAdvancedInfoHoverTimer = null;
      if (region.matches(":hover")) {
        showCacheAdvancedInfoTransient(info, "pointer");
      }
    }, cacheAdvancedInfoHoverDelayMs);
  });
  region.addEventListener("pointerleave", () => {
    if (cacheAdvancedInfoHoverTimer) {
      window.clearTimeout(cacheAdvancedInfoHoverTimer);
      cacheAdvancedInfoHoverTimer = null;
    }
    if (cacheAdvancedInfoLeaveTimer) {
      window.clearTimeout(cacheAdvancedInfoLeaveTimer);
    }
    cacheAdvancedInfoLeaveTimer = window.setTimeout(() => {
      cacheAdvancedInfoLeaveTimer = null;
      if (
        !info?.classList.contains("is-pinned")
        && !region.matches(":hover")
        && !info?.contains(document.activeElement)
      ) {
        info?.classList.remove("is-visible");
        info?.querySelector(".cache-advanced-info-button")?.setAttribute("aria-expanded", "false");
      }
    }, cacheAdvancedInfoLeaveDelayMs);
  });
  region.addEventListener("focusin", (event) => {
    if (!event.target.closest(".cache-advanced-info-button")) {
      return;
    }
    showCacheAdvancedInfoTransient(info, "keyboard");
  });
  region.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (
        !info?.classList.contains("is-pinned")
        && !region.contains(document.activeElement)
        && !region.matches(":hover")
      ) {
        info?.classList.remove("is-visible");
        info?.querySelector(".cache-advanced-info-button")?.setAttribute("aria-expanded", "false");
      }
    }, 0);
  });
});

elements.hostWorkspaceButtons?.forEach((button) => {
  button.addEventListener("click", () => {
    activateHostWorkspace(button.dataset.hostWorkspace, { inputOrigin: "pointer" });
  });
  button.addEventListener("keydown", handleHostWorkspaceRailKeydown);
});

elements.stageControlsToggle?.addEventListener("click", (event) => {
  event.preventDefault();
  if (stageControlsAreInline()) {
    return;
  }
  setStageControlTrayOpen(!state.stageControlTrayOpen);
});

elements.stageControlsClose?.addEventListener("click", () => {
  if (stageControlsAreInline()) {
    return;
  }
  setStageControlTrayOpen(false, { restoreFocus: true });
});

elements.stageControlBackdrop?.addEventListener("click", () => {
  setStageControlTrayOpen(false, { restoreFocus: true });
});

elements.stageControlTray?.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !state.stageControlTrayOpen || stageControlsAreInline()) {
    return;
  }
  const focusable = [...elements.stageControlTray.querySelectorAll(
    'button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), select:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
  )].filter((element) => !element.closest("[hidden], [inert]"));
  if (!focusable.length) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
});

for (const eventName of ["wheel", "touchmove"]) {
  elements.hostWorkspaceBackdrop?.addEventListener(
    eventName,
    (event) => event.preventDefault(),
    { passive: false },
  );
}

elements.remoteMiniTrigger?.addEventListener("focus", () => {
  elements.remoteMiniControl?.classList.remove("is-qr-dismissed");
});

elements.remoteMiniControl?.addEventListener("mouseenter", () => {
  elements.remoteMiniControl?.classList.remove("is-qr-dismissed");
});

elements.remoteMiniControl?.addEventListener("mouseleave", () => {
  if (!state.remoteQrPinned) {
    elements.remoteMiniControl?.classList.remove("is-qr-dismissed");
  }
});

elements.remoteMiniTrigger?.addEventListener("click", () => {
  const wasPinned = state.remoteQrPinned;
  setRemoteQrPinned(!wasPinned, { dismissTransient: wasPinned });
});

elements.remoteMiniPopoverClose?.addEventListener("click", () => {
  setRemoteQrPinned(false, { dismissTransient: true });
});

elements.displaySettingsToggle?.addEventListener("click", () => {
  state.displaySettingsOpen = !state.displaySettingsOpen;
  if (state.displaySettingsOpen) {
    state.cacheSettingsOpen = false;
    state.presentationSettingsOpen = false;
    syncCachePanelVisibility();
    syncPresentationPanelVisibility();
  }
  syncDisplayPanelVisibility();
});

elements.presentationSettingsToggle?.addEventListener("click", () => {
  state.presentationSettingsOpen = !state.presentationSettingsOpen;
  if (state.presentationSettingsOpen) {
    state.cacheSettingsOpen = false;
    state.displaySettingsOpen = false;
    syncCachePanelVisibility();
    syncDisplayPanelVisibility();
    refreshPresentationDisplays().catch(() => {});
  }
  syncPresentationPanelVisibility();
});

elements.presentationDisplayList?.addEventListener("click", (event) => {
  const option = event.target.closest("[data-presentation-display-id]");
  if (!option || option.disabled) {
    return;
  }
  selectPresentationDisplay(option.dataset.presentationDisplayId || "");
});

elements.presentationRefreshButton?.addEventListener("click", () => {
  refreshPresentationDisplays({ announceError: true }).catch(() => {});
});

elements.bbdownLoginButton?.addEventListener("click", async () => {
  const loggedIn = Boolean(state.data?.bbdown?.login?.logged_in || state.data?.bbdown?.logged_in);
  if (!loggedIn) {
    await startBBDownLogin({ force: true });
    return;
  }
  try {
    await apiPostStateSnapshot("/api/bbdown/logout");
    setAppMessage(t("service.bbdownLoggedOut"));
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
  state.cacheLimitDraftValue = currentValue;
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
  state.advanceDelayDraftValue = currentValue;
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
  const selectedLabel = event.target.selectedOptions?.[0]?.textContent || quality;
  await setCachePolicyPreference(
    { video_quality: quality },
    t("service.qualityUpdated", { quality: selectedLabel }),
  );
});

elements.cacheDownloadSourceSelect?.addEventListener("change", async (event) => {
  const downloadSource = String(event.target.value || "").trim();
  if (!downloadSource || downloadSource === String(state.data?.cache_policy?.download_source || "")) {
    return;
  }
  const selectedLabel = event.target.selectedOptions?.[0]?.textContent || downloadSource;
  await setDownloadSourcePreference(downloadSource, selectedLabel);
});

elements.cacheHiresCheckbox?.addEventListener("change", async (event) => {
  const audioHires = Boolean(event.target.checked);
  if (audioHires === Boolean(state.data?.cache_policy?.audio_hires)) {
    return;
  }
  await setCachePolicyPreference(
    { audio_hires: audioHires },
    audioHires ? t("service.hiresEnabled") : t("service.hiresDisabled"),
  );
});

elements.resetOffsetCheckbox?.addEventListener("change", async (event) => {
  const resetOffset = Boolean(event.target.checked);
  if (resetOffset === Boolean(state.data?.cache_policy?.reset_offset_on_next)) {
    return;
  }
  await setCachePolicyPreference(
    { reset_offset_on_next: resetOffset },
    resetOffset ? t("service.resetOffsetEnabled") : t("service.resetOffsetDisabled"),
  );
});

elements.updatePreviewCheckbox?.addEventListener("change", async (event) => {
  const hadVisibleUpdate = shouldPresentCurrentChannelUpdate();
  state.updatePreviewEnabled = Boolean(event.target.checked);
  writeLocalPreference(storageKeys.updatePreview, state.updatePreviewEnabled);
  state.manualUpdateCheck = null;
  state.updateManualVisibleChannel = "";
  renderUpdatePreviewControl();
  if (hadVisibleUpdate) {
    await requestAppUpdateCheck({
      automatic: state.updateAutomaticEnabled,
      force: true,
    });
  }
});

elements.updateAutomaticCheckbox?.addEventListener("change", async (event) => {
  state.updateAutomaticEnabled = Boolean(event.target.checked);
  writeLocalPreference(storageKeys.updateAutomatic, state.updateAutomaticEnabled);
  state.manualUpdateCheck = null;
  state.updateManualVisibleChannel = "";
  renderUpdatePreviewControl();
  if (state.updateAutomaticEnabled) {
    await requestAppUpdateCheck({ automatic: true, force: true });
  }
});

elements.diagnosticCopyButton?.addEventListener("click", copyDiagnosticsMarkdown);
elements.diagnosticPackageButton?.addEventListener("click", downloadDiagnosticsPackage);

elements.avSyncPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-step], button[data-reset-av-offset], button[data-av-delay-lock]");
  if (!button) {
    return;
  }
  if (button.disabled) {
    return;
  }
  if (button.hasAttribute("data-reset-av-offset")) {
    await dispatchAvDelayAction({ type: "reset_local" });
    return;
  }
  if (button.hasAttribute("data-av-delay-lock")) {
    await dispatchAvDelayAction({ type: "toggle_lock" });
    return;
  }
  const step = Number(button.dataset.step || 0);
  if (!Number.isFinite(step) || step === 0) {
    return;
  }
  await dispatchAvDelayAction({ type: "adjust", delta_ms: step });
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

elements.keyShiftDecButton?.addEventListener("click", () => {
  const currentKey = Number(state.data?.player_settings?.key_shift ?? 0);
  setLocalPlayerKeyShift(currentKey - 1);
});

elements.keyShiftIncButton?.addEventListener("click", () => {
  const currentKey = Number(state.data?.player_settings?.key_shift ?? 0);
  setLocalPlayerKeyShift(currentKey + 1);
});

elements.keyShiftResetButton?.addEventListener("click", () => {
  setLocalPlayerKeyShift(0);
});

elements.keyShiftInput?.addEventListener("change", async (event) => {
  await setLocalPlayerKeyShift(event.target.value);
});

elements.keyShiftInput?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  await setLocalPlayerKeyShift(event.target.value);
});

document.addEventListener("click", () => {
  if (state.audioContext && state.audioContext.state === "suspended") {
    state.audioContext.resume().catch(() => {});
  }
});

elements.clearPlaylistButton.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.clearPlaylistButton);
  openConfirm({
    type: "clear-playlist",
    message: t("list.clearConfirm"),
    x: point.x,
    y: point.y,
  });
});

elements.clearHistoryButton?.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.clearHistoryButton);
  openConfirm({
    type: "clear-history",
    message: t("history.clearConfirm"),
    x: point.x,
    y: point.y,
  });
});

elements.historyExportButton?.addEventListener("click", (event) => {
  const point = anchorPointForEvent(event, elements.historyExportButton);
  loadPlayedSessions().catch((err) => {
    console.warn("加载历史场次失败:", err);
  });
  openConfirm({
    type: "export-history",
    source: "played",
    pageSize: 200,
    sourceSelect: true,
    pageSizeSelect: true,
    message: t("history.exportPromptWithPageSize"),
    primaryLabel: t("history.exportImage"),
    secondaryLabel: t("history.exportCsv"),
    x: point.x,
    y: point.y,
  });
});

elements.playerFullscreenButton?.addEventListener("click", async () => {
  await togglePlayerFullscreen();
  renderPlayerFullscreenButton();
});

elements.presentationOutputButton?.addEventListener("click", toggleLocalPresentation);

elements.playerFrame?.addEventListener("click", (event) => {
  if (event.target.closest("button, input, select, textarea, a")) {
    return;
  }
  if (!event.target.closest("video")) {
    return;
  }
  const { video, audio } = activeLocalPlayerElements();
  if (isTauriWebKitRuntime()) {
    clearPlayerFrameClickTimer();
    if (video && audio) {
      requestSplitPlaybackStartFromUserGesture(video, audio, "tauri-video-click-start-intent");
    }
    revealMountedPlayerControlsForUserInteraction();
    return;
  }
  if (
    video
    && audio
    && requestSplitPlaybackStartFromUserGesture(video, audio, "host-video-click-start-intent")
  ) {
    clearPlayerFrameClickTimer();
    revealMountedPlayerControlsForUserInteraction();
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
  const itemIncarnationId = elements.queueCurrentRetry.dataset.itemIncarnationId;
  if (!itemId || !itemIncarnationId) {
    return;
  }
  const button = elements.queueCurrentRetry;
  if (button.getAttribute("aria-busy") === "true") {
    return;
  }
  const originallyDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const outcome = await apiPostExactStateCommand("/api/cache/retry", {
      item_id: itemId,
      expected_item_incarnation_id: itemIncarnationId,
      force: true,
    });
    render();
    if (outcome.commandApplied) {
      setAppMessage(t("cache.retryStarted"));
    }
  } catch (error) {
    setAppMessage(error.message, true);
  } finally {
    button.disabled = originallyDisabled;
    button.removeAttribute("aria-busy");
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
    await apiPostStateSnapshot("/api/mode", { mode: "local" });
    render();
  } catch (error) {
    setAppMessage(error.message, true);
  }
});

elements.languageSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-language]");
  if (!button) {
    return;
  }
  setLanguage(button.dataset.language);
});

elements.themeSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-theme]");
  if (!button) {
    return;
  }
  applyTheme(button.dataset.theme);
});

elements.dataResetButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const point = anchorPointForEvent(event, elements.dataResetButton);
  openConfirm({
    type: "reset-data",
    message: t("service.resetDataConfirm"),
    ...point,
  });
});

elements.currentCacheRetryButton?.addEventListener("click", async (event) => {
  event.stopPropagation();
  const button = elements.currentCacheRetryButton;
  if (button.getAttribute("aria-busy") === "true") {
    return;
  }
  const currentItem = state.data?.current_item;
  if (!currentItem?.id) {
    setAppMessage(t("service.noCurrentSong"), true);
    return;
  }
  const originallyDisabled = button.disabled;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const outcome = await apiPostExactStateCommand("/api/cache/retry", {
      item_id: currentItem.id,
      expected_item_incarnation_id: currentItem.item_incarnation_id,
      force: true,
    });
    render();
    if (outcome.commandApplied) {
      setAppMessage(t("service.retryCurrentStarted"));
    }
  } catch (error) {
    setAppMessage(error.message, true);
    renderPlaybackRepairControls(state.data?.current_item);
  } finally {
    button.disabled = originallyDisabled;
    button.removeAttribute("aria-busy");
    renderPlaybackRepairControls(state.data?.current_item);
  }
});

elements.playerResetButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  const point = anchorPointForEvent(event, elements.playerResetButton);
  openConfirm({
    type: "reset-player",
    message: t("service.resetPlayerConfirm"),
    ...point,
  });
});

elements.updateCheckButton?.addEventListener("click", async (event) => {
  event.stopPropagation();
  await checkAppUpdate(event);
});

elements.applicationRestartButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!syncApplicationRestartAvailability() || state.applicationRestartInFlight) {
    return;
  }
  const point = anchorPointForEvent(event, elements.applicationRestartButton);
  openConfirm({
    type: "restart-application",
    message: t("service.restartApplicationConfirm"),
    primaryLabel: t("service.restartApplication"),
    ...point,
    anchorElementId: "application-restart-button",
    anchorAlign: "end",
    anchorGap: 8,
  });
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
      await submitAddRequest(currentItem.original_url || currentItem.resolved_url, "tail", {
        requesterName,
        selectedVideoPage: page,
        selectedAudioPages: [page],
      });
      setAppMessage(t("player.partAddedToCache"));
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

  const playbackSession = state.hostPlaybackSession;
  const video = playbackSession?.video;
  if (
    !isCurrentHostPlaybackSession(
      playbackSession,
      video,
      playbackSession?.audio,
    )
  ) {
    return;
  }
  state.audioVariantSwitchInFlight = true;
  state.audioVariantSwitchUnlockAt = Date.now() + audioVariantSwitchDebounceMs;
  renderAudioVariantBar(currentItem, frontendPlaybackMode(state.data?.playback_mode));
  const pendingRestore = {
    itemId: currentItem.id,
    itemIncarnationId: currentItem.item_incarnation_id,
    variantId: nextVariantId,
    currentTime: video ? Number(video.currentTime || 0) : 0,
    wasPlaying: video ? !video.paused : true,
  };
  state.pendingPlaybackRestore = pendingRestore;
  try {
    const outcome = await apiPostExactStateCommand("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
      expected_item_incarnation_id: currentItem.item_incarnation_id,
    });
    if (!outcome.commandApplied) {
      if (state.pendingPlaybackRestore === pendingRestore) {
        state.pendingPlaybackRestore = null;
      }
      state.audioVariantSwitchUnlockAt = 0;
    }
    render();
  } catch (error) {
    if (state.pendingPlaybackRestore === pendingRestore) {
      state.pendingPlaybackRestore = null;
    }
    setAppMessage(error.message, true);
  } finally {
    state.audioVariantSwitchInFlight = false;
    scheduleAudioVariantSwitchUnlock();
  }
});

elements.playlist.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) {
    return;
  }
  if (button.dataset.action === "move-up" || button.dataset.action === "move-down") {
    event.stopPropagation();
    const itemId = button.dataset.id || "";
    const targetIndex = Number.parseInt(button.dataset.targetIndex || "", 10);
    const item = state.data?.playlist?.find((candidate) => candidate.id === itemId);
    if (!itemId || !Number.isInteger(targetIndex) || !item) {
      return;
    }
    const point = anchorPointForEvent(event, button);
    closeOpenMenus({ restoreFocus: false });
    openConfirm({
      type: "reorder-item",
      itemId,
      targetIndex,
      focusItemId: itemId,
      announcePosition: targetIndex + 1,
      x: point.x,
      y: point.y,
      message: t("remote.queueOrderMessage", {
        title: item.display_title || t("request.thisSong"),
        index: targetIndex + 1,
      }),
      primaryLabel: t("remote.queueOrderConfirm"),
    });
    elements.confirmCancel.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.action === "remove") {
    event.stopPropagation();
    const point = anchorPointForEvent(event, button);
    closeOpenMenus({ restoreFocus: false });
    openConfirm({
      type: "remove-item",
      itemId: button.dataset.id,
      message: t("list.removeConfirm"),
      x: point.x,
      y: point.y,
    });
    return;
  }
  await handlePlaylistAction(button);
});

elements.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.dataset.action === "toggle-menu" || button.disabled) {
    return;
  }
  const action = button.dataset.action;
  const point = anchorPointForEvent(event, button);
  if (action === "history-remove") {
    const key = button.dataset.key || "";
    if (!key) {
      return;
    }
    closeOpenMenus();
    openConfirm({
      type: "remove-history",
      key,
      message: t("history.removeConfirm"),
      x: point.x,
      y: point.y,
    });
    return;
  }
  const url = button.dataset.url;
  if (!url) {
    return;
  }

  const prevText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = t("search.adding");

  try {
    await handleAddByUrl(url, action === "history-next" ? "next" : "tail", point, "history");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = prevText;
    closeOpenMenus({ restoreFocus: true });
  }
});

elements.confirmCancel.addEventListener("click", () => {
  const intent = state.confirmIntent;
  closeConfirm();
  if (intent?.type === "reorder-item" && intent.focusItemId) {
    focusPlaylistItemMenuTrigger(intent.focusItemId);
  }
});

elements.confirmSource?.addEventListener("change", () => {
  updateConfirmHistoryExportSource();
});

elements.confirmPageSize?.addEventListener("change", () => {
  updateConfirmHistoryExportPageSize();
});

elements.confirmSecondary?.addEventListener("click", async () => {
  const intent = state.confirmIntent;
  if (!intent) {
    return;
  }
  if (intent.type === "export-history") {
    await exportHistory("csv", selectedConfirmHistoryExportSource(intent), selectedConfirmHistoryExportPageSize(intent));
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

elements.gatchaFavlistModalClose?.addEventListener("click", () => {
  closeGatchaFavlistModal();
});

elements.gatchaFavlistModalCancel?.addEventListener("click", () => {
  closeGatchaFavlistModal();
});

elements.gatchaFavlistModalBackdrop?.addEventListener("click", () => {
  closeGatchaFavlistModal();
});

elements.gatchaFavlistModalConfirm?.addEventListener("click", async () => {
  await confirmGatchaFavlistModal();
});

elements.poolConfigModalClose?.addEventListener("click", () => {
  closePoolConfigModal();
});

elements.poolConfigModalCancel?.addEventListener("click", () => {
  closePoolConfigModal();
});

elements.poolConfigModalBackdrop?.addEventListener("click", () => {
  closePoolConfigModal();
});

elements.poolConfigWeightSlider?.addEventListener("input", () => {
  capturePoolConfigDraftFromControls();
  updatePoolConfigWeightLabel();
});

[elements.poolConfigUidOptions, elements.poolConfigFavlistOptions].forEach((list) => {
  list?.addEventListener("change", (event) => {
    if (event.target?.matches?.('input[type="checkbox"]')) {
      capturePoolConfigDraftFromControls();
      poolConfigSetMessage("");
    }
  });
});

elements.poolConfigModal?.addEventListener("keydown", (event) => {
  if (
    event.key !== "Tab"
    || state.confirmIntent
    || elements.poolConfigModal.classList.contains("hidden")
  ) {
    return;
  }
  const focusable = [...elements.poolConfigModal.querySelectorAll(
    'button:not(:disabled):not([hidden]), input:not(:disabled):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])',
  )].filter((element) => !element.closest("[hidden], [inert]"));
  if (!focusable.length) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
});

elements.poolConfigModalReset?.addEventListener("click", () => {
  resetPoolConfigControls();
});

elements.poolConfigUidSelectAll?.addEventListener("click", () => {
  setPoolConfigChecked("gatcha-pool-uid", true);
});

elements.poolConfigUidSelectNone?.addEventListener("click", () => {
  setPoolConfigChecked("gatcha-pool-uid", false);
});

elements.poolConfigFavlistSelectAll?.addEventListener("click", () => {
  setPoolConfigChecked("gatcha-pool-favlist", true);
});

elements.poolConfigFavlistSelectNone?.addEventListener("click", () => {
  setPoolConfigChecked("gatcha-pool-favlist", false);
});

elements.poolConfigModalSave?.addEventListener("click", async () => {
  await submitPoolConfigModal();
});

elements.developerModeTrigger?.addEventListener("click", () => {
  openBilikaraSecretModal();
});

elements.developerModeTrigger?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  openBilikaraSecretModal();
});

elements.bilikaraSecretForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await verifyBilikaraSecret();
});

elements.bilikaraSecretClose?.addEventListener("click", () => {
  closeBilikaraSecretModal();
});

elements.bilikaraSecretCancel?.addEventListener("click", () => {
  closeBilikaraSecretModal();
});

elements.bilikaraSecretBackdrop?.addEventListener("click", () => {
  closeBilikaraSecretModal();
});

document.addEventListener("click", handleDeveloperTagResetButtonClick);

elements.developerTagResetClose?.addEventListener("click", () => {
  closeDeveloperTagResetModal();
});

elements.developerTagResetCancel?.addEventListener("click", () => {
  closeDeveloperTagResetModal();
});

elements.developerTagResetBackdrop?.addEventListener("click", () => {
  closeDeveloperTagResetModal();
});

elements.developerTagResetConfirm?.addEventListener("click", async () => {
  await confirmDeveloperAction();
});

elements.developerTagResetDeleteMid?.addEventListener("click", async () => {
  await confirmDeveloperDeleteMid();
});

elements.confirmOk.addEventListener("click", async () => {
  const intent = state.confirmIntent;
  if (!intent || elements.confirmOk.disabled) {
    return;
  }

  const prevOkText = elements.confirmOk.textContent;
  elements.confirmOk.disabled = true;
  elements.confirmOk.setAttribute("aria-busy", "true");
  elements.confirmOk.textContent = t("gatcha.adding") || "处理中…";

  if (elements.confirmSecondary) {
    elements.confirmSecondary.disabled = true;
    elements.confirmSecondary.setAttribute("aria-busy", "true");
  }

  let keepBusyUntilApplicationExit = false;
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
      await exportHistory("image", selectedConfirmHistoryExportSource(intent), selectedConfirmHistoryExportPageSize(intent));
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
    if (intent.type === "install-app-update") {
      await installAppUpdate(Boolean(intent.includePreview));
      return;
    }
    if (intent.type === "restart-application") {
      keepBusyUntilApplicationExit = await restartApplication();
      return;
    }
    if (intent.type === "prepare-download-source") {
      await prepareDownloadSourceAndApply(intent);
      return;
    }
    if (intent.type === "open-release" && intent.releaseUrl) {
      const releaseUrl = safeHttpUrl(intent.releaseUrl);
      if (!releaseUrl) {
        throw new Error(t("service.updateReleaseUrlInvalid"));
      }
      openExternalUrl(releaseUrl);
      closeConfirm();
      setAppMessage(t("service.openedReleases"));
      return;
    }
    if (intent.type === "remove-item" && intent.itemId) {
      await apiPostStateSnapshot("/api/playlist/remove", { item_id: intent.itemId });
      closeConfirm();
      setAppMessage(t("list.removedSong"));
      render();
      return;
    }
    if (intent.type === "remove-history" && intent.key) {
      await apiPostStateSnapshot("/api/history/remove", { key: intent.key });
      closeConfirm();
      setAppMessage(t("history.removed"));
      render();
      return;
    }
    if (intent.type === "reorder-item" && intent.itemId && Number.isInteger(intent.targetIndex)) {
      const accepted = await reorderPlaylist(intent.itemId, intent.targetIndex);
      closeConfirm();
      if (intent.focusItemId) {
        focusPlaylistItemMenuTrigger(intent.focusItemId);
      }
      if (accepted) {
        setAppMessage(intent.announcePosition
          ? t("list.movedPosition", { index: intent.announcePosition })
          : t("remote.queueOrderUpdated"));
      }
      return;
    }
    if (intent.type === "gatcha-uid-add" && intent.uid) {
      await confirmGatchaUidAdd(intent);
      return;
    }
    if (intent.type === "duplicate-add" && intent.url) {
      const source = intent.source || "request-form";
      const accepted = await submitAddRequest(intent.url, intent.position || "tail", {
        requesterName: intent.requesterName || selectedRequesterName(),
        allowRepeat: true,
        selectedVideoPage: Number.isInteger(intent.selectedVideoPage) ? intent.selectedVideoPage : undefined,
        selectedAudioPages: Array.isArray(intent.selectedAudioPages) ? intent.selectedAudioPages : undefined,
      });
      if (!accepted && source === "gatcha") {
        setMessageForSource(source, t("error.requestFailed"), true);
        return;
      }
      closeConfirm({ restoreFocus: source !== "gatcha" });
      if (intent.originatedFromDetail) {
        if (typeof searchDetailController !== "undefined") searchDetailController?.close({ immediate: true });
      }
      if (source !== "gatcha") {
        if (!intent.preserveInput) {
          elements.urlInput.value = "";
        } else {
          elements.urlInput.value = "";
        }
      }
      const message = intent.position === "next" ? t("request.confirmedNext") : t("request.confirmedTail");
      setMessageForSource(source, message);
      setAppMessage(message);
      if (source === "gatcha") {
        clearAcceptedGatchaCandidate();
      }
      render();
    }
  } catch (error) {
    if (intent?.type === "duplicate-add") {
      setMessageForSource(intent.source || "request-form", error.message, true);
    } else {
      setAppMessage(error.message, true);
    }
  } finally {
    if (!keepBusyUntilApplicationExit) {
      elements.confirmOk.disabled = false;
      elements.confirmOk.removeAttribute("aria-busy");
      elements.confirmOk.textContent = prevOkText;
      if (elements.confirmSecondary) {
        elements.confirmSecondary.disabled = false;
        elements.confirmSecondary.removeAttribute("aria-busy");
      }
    }
  }
});

document.addEventListener("click", (event) => {
  if (event.target.closest("#confirm-popover")) {
    return;
  }
  if (state.confirmIntent) {
    if (
      event.target.closest("#clear-playlist-button") ||
      event.target.closest("#history-export-button") ||
      event.target.closest("#clear-history-button") ||
      event.target.closest('button[data-action="remove"]') ||
      event.target.closest("#queue-next-button") ||
      event.target.closest("#data-reset-button") ||
      event.target.closest("#current-cache-retry-button") ||
      event.target.closest("#player-reset-button") ||
      event.target.closest("#update-check-button") ||
      event.target.closest("#application-restart-button") ||
      event.target.closest("#cache-download-source-select") ||
      event.target.closest("#add-form") ||
      event.target.closest("#gatcha-uid-form") ||
      event.target.closest("#modal-follow-uid-form") ||
      event.target.closest("#refresh-gatcha-cache-button") ||
      event.target.closest("#history-list")
    ) {
      return;
    }
    closeConfirm();
  }

  if (!event.target.closest(".cache-contextual-info-region")) {
    closeCacheAdvancedInfo();
  }

  const clickedInsideRemoteQr = Boolean(event.target.closest("#remote-mini-control"));
  if (state.remoteQrPinned && !clickedInsideRemoteQr) {
    setRemoteQrPinned(false);
  }

  if (
    state.cacheSettingsOpen
    && !event.target.closest("#cache-settings")
    && !clickedInsideRemoteQr
  ) {
    state.cacheSettingsOpen = false;
    syncCachePanelVisibility();
  }

  if (state.displaySettingsOpen && !event.target.closest("#display-settings")) {
    state.displaySettingsOpen = false;
    syncDisplayPanelVisibility();
  }

  const presentationClickPath = typeof event.composedPath === "function" ? event.composedPath() : [];
  const clickedInsidePresentationSettings = presentationClickPath.includes(
    elements.presentationSettings,
  ) || Boolean(event.target.closest("#presentation-settings"));
  if (state.presentationSettingsOpen && !clickedInsidePresentationSettings) {
    state.presentationSettingsOpen = false;
    syncPresentationPanelVisibility();
  }
});

document.addEventListener("click", (event) => {
  const toggle = event.target.closest('[data-action="toggle-menu"]');
  if (toggle) {
    const wrap = toggle.closest(".song-actions-wrap, .history-actions-wrap");
    const menu = wrap?.querySelector(".menu-content");
    if (menu) {
      const isHidden = menu.classList.contains("hidden");
      closeOpenMenus({ restoreFocus: false });
      if (isHidden) {
        menu.classList.remove("hidden");
        toggle.setAttribute("aria-expanded", "true");
        state.openRowMenuTrigger = toggle;
        menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
      } else {
        toggle.focus({ preventScroll: true });
      }
      event.stopPropagation();
      return;
    }
  }

  // Close menus if clicking outside
  if (!event.target.closest(".menu-content")) {
    closeOpenMenus({ restoreFocus: true });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (state.confirmIntent) {
    closeConfirm();
    event.preventDefault();
    return;
  }
  if (closeHighestRequestTaskLayerForEscape()) {
    event.preventDefault();
    return;
  }
  if (searchDetailController?.isOpen?.()) {
    searchDetailController.close({ reason: "escape" });
    event.preventDefault();
    return;
  }
  if (closeOrdinaryPopoverForEscape()) {
    event.preventDefault();
    return;
  }
  if (state.stageControlTrayOpen && !stageControlsAreInline()) {
    setStageControlTrayOpen(false, { restoreFocus: true });
    event.preventDefault();
    return;
  }
  if (closeHostWorkspaceOverlay()) {
    event.preventDefault();
    return;
  }
  if (closeOpenMenus({ restoreFocus: true })) {
    event.preventDefault();
  }
});

document.addEventListener("visibilitychange", () => {
  if (
    !state.localShouldBePlaying
    || shouldHoldCurrentItemForTransition(state.data?.current_item)
  ) {
    return;
  }
  const { video, audio } = activeLocalPlayerElements();
  const primaryVideo = video || activePrimaryVideoElement();
  if (video && audio) {
    syncSplitPlayer(video, audio, currentAvOffsetSeconds(), true);
  } else if (primaryVideo) {
    primaryVideo.play().catch(() => {});
  }
});

function handleFullscreenChange() {
  const isFullscreen = isPlayerPanelFullscreen();
  if (!isFullscreen) {
    hideFullscreenRequestToast();
    if (hasLocalAdvanceDelayOverlay()) {
      updateLocalAdvanceDelayOverlay();
    } else {
      hidePlayerDelayOverlay();
    }
  }
  if (state.presentationSession.phase === "inactive") {
    setTauriWindowFullscreen(isFullscreen).catch(() => {});
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

  const draggedItem = playlist[sourceIndex];
  const point = anchorPointForEvent(event, elements.playlist);
  openConfirm({
    type: "reorder-item",
    itemId: draggedId,
    targetIndex,
    x: point.x,
    y: point.y,
    message: t("remote.queueOrderMessage", {
      title: draggedItem?.display_title || t("request.thisSong"),
      index: targetIndex + 1,
    }),
    primaryLabel: t("remote.queueOrderConfirm"),
  });
  render();
});

elements.gatchaButton.addEventListener("click", handleGatchaDraw);
elements.gatchaRetryButton.addEventListener("click", handleGatchaDraw);

document.addEventListener("click", async (event) => {
  const root = state.ratingPromptElement;
  if (!root || !root.contains(event.target)) {
    return;
  }
  const tabButton = event.target.closest("[data-rating-tab]");
  if (tabButton) {
    setRatingPromptActiveTab(tabButton.dataset.ratingTab || "current");
    return;
  }
  const scoreButton = event.target.closest("[data-rating-score]");
  if (scoreButton) {
    state.ratingPromptScore = Math.max(1, Math.min(5, Number(scoreButton.dataset.ratingScore || "5")));
    renderRatingStars();
    return;
  }
  const optOutInput = event.target.closest("[data-rating-opt-out]");
  if (optOutInput) {
    setRatingOptOut(optOutInput.checked);
    if (optOutInput.checked) {
      closeRatingPrompt({ submit: false });
    }
    return;
  }
  if (event.target.closest("[data-rating-close]")) {
    closeRatingPrompt({ submit: true });
  }
});

function handleRatingFullscreenChange() {
  if (fullscreenElement()) {
    return;
  }
  const currentItem = state.data?.current_item;
  const video = elements.playerFrame?.querySelector?.('video[data-player-role="video"]');
  if (currentItem && video) {
    maybeShowRatingPromptForProgress(currentItem, video.currentTime, video.duration);
  }
}

document.addEventListener("fullscreenchange", handleRatingFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleRatingFullscreenChange);

elements.requesterSelect?.addEventListener("change", handleRequesterSelectionChange);

elements.requestSubviewButtons?.forEach((button) => {
  button.addEventListener("click", () => activateRequestSubview(button.dataset.requestView));
  button.addEventListener("keydown", (event) => {
    handleHorizontalTabKeydown(event, ["quick", "search", "discover", "sources"], activateRequestSubview);
  });
});

elements.searchModeButtons?.forEach((button) => {
  button.addEventListener("click", () => activateSearchMode(button.dataset.searchMode));
  button.addEventListener("keydown", (event) => {
    handleHorizontalTabKeydown(event, ["shared", "local"], activateSearchMode);
  });
});

elements.discoverModeButtons?.forEach((button) => {
  button.addEventListener("click", () => activateDiscoverMode(button.dataset.discoverMode));
  button.addEventListener("keydown", (event) => {
    handleHorizontalTabKeydown(event, ["categories", "name", "artist"], activateDiscoverMode);
  });
});

elements.sourcesModeButtons?.forEach((button) => {
  button.addEventListener("click", () => activateSourcesMode(button.dataset.sourcesMode));
  button.addEventListener("keydown", (event) => {
    handleHorizontalTabKeydown(event, ["uids", "favorites"], activateSourcesMode);
  });
});

elements.catalogToolButtons?.forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.developerMode) {
      return;
    }
    const tool = String(button.dataset.catalogTool || "");
    if (!["review", "blacklist", "maintenance"].includes(tool)) {
      return;
    }
    closeRequestDetailForNavigation();
    rememberRequestScrollPosition();
    state.catalogAdvancedTool = tool;
    elements.catalogAdvancedMenu?.removeAttribute("open");
    syncDiscoverModeSelection();
    if (tool === "maintenance") {
      renderMaintenanceView();
    } else if (tool === "blacklist") {
      state.blacklistLoaded || state.blacklistLoading
        ? renderBlacklistView()
        : loadBlacklistItems({ force: true, offset: 0 });
    } else {
      state.pendingReviewLoaded || state.pendingReviewLoading
        ? renderPendingReviewView()
        : loadPendingReviewItems();
    }
  });
});

elements.catalogAdvancedBack?.addEventListener("click", () => {
  state.catalogAdvancedTool = "";
  syncDiscoverModeSelection();
  restoreRequestScrollPosition();
  elements.catalogAdvancedMenu?.querySelector("summary")?.focus({ preventScroll: true });
});

elements.manageSourcesButton?.addEventListener("click", () => {
  activateHostWorkspace("request", { inputOrigin: "pointer" });
  activateRequestSubview("sources", { focusTab: true });
});

async function runRequestBusyAction(button, loadingLabel, action) {
  if (!button || button.disabled) {
    return;
  }
  const wasDisabled = button.disabled;
  const originalText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = loadingLabel;
  try {
    await action();
  } finally {
    button.disabled = wasDisabled;
    button.removeAttribute("aria-busy");
    button.textContent = originalText;
  }
}

elements.openAddedUidsButton?.addEventListener("click", async () => {
  await runRequestBusyAction(
    elements.openAddedUidsButton,
    t("follow.loadingOwners"),
    () => loadFollowBrowse({ uid: "", query: state.followBrowseQuery }),
  );
});

elements.openFavoritesButton?.addEventListener("click", async () => {
  await runRequestBusyAction(
    elements.openFavoritesButton,
    t("favlist.loadingFolders"),
    () => loadFavlistBrowse({ folderId: "", query: state.favlistBrowseQuery }),
  );
});

elements.requestWorkspace?.addEventListener("submit", (event) => {
  const blacklistForm = event.target.closest("[data-blacklist-search]");
  if (blacklistForm && elements.requestWorkspace.contains(blacklistForm)) {
    event.preventDefault();
    const input = blacklistForm.querySelector("[data-blacklist-query]");
    loadBlacklistItems({ force: true, query: input?.value || "", offset: 0 });
    return;
  }
  const categoryForm = event.target.closest("[data-category-browse-search]");
  if (categoryForm && elements.requestWorkspace.contains(categoryForm)) {
    event.preventDefault();
    const input = categoryForm.querySelector("[data-category-browse-query]");
    loadCategoryBrowse({
      query: input?.value || "",
      append: false,
    });
    return;
  }
  const form = event.target.closest("[data-d1-browse-search]");
  if (!form || !elements.requestWorkspace.contains(form)) {
    return;
  }
  event.preventDefault();
  if (state.d1BrowseLoading) {
    return;
  }
  const input = form.querySelector("[data-d1-browse-query]");
  if (state.d1BrowseLevel === "alphabet") {
    if (input) {
      input.value = "";
    }
    state.d1BrowseQuery = "";
    state.d1BrowseTag = "";
    state.d1BrowseLocale = "";
    state.d1BrowseData = null;
    renderD1BrowseView();
    return;
  }
  if (state.d1BrowseLevel === "items") {
    loadD1Browse({
      kind: state.d1BrowseKind || "name",
      letter: state.d1BrowseLetter,
      query: input?.value || "",
      tag: state.d1BrowseTag,
      locale: state.d1BrowseLocale,
    });
    return;
  }
  loadD1Browse({
    kind: state.d1BrowseKind || "name",
    letter: state.d1BrowseLetter,
    query: input?.value || "",
    tag: "",
    locale: "",
  });
});

elements.requestWorkspace?.addEventListener("click", (event) => {
  const maintenanceButton = event.target.closest("[data-maintenance-job]");
  if (maintenanceButton && elements.requestWorkspace.contains(maintenanceButton)) {
    void triggerMaintenanceJob(maintenanceButton.dataset.maintenanceJob || "");
    return;
  }
  const blacklistRefreshButton = event.target.closest("[data-blacklist-refresh]");
  if (blacklistRefreshButton && elements.requestWorkspace.contains(blacklistRefreshButton)) {
    loadBlacklistItems({ force: true });
    return;
  }
  const blacklistPreviousButton = event.target.closest("[data-blacklist-previous]");
  if (blacklistPreviousButton && elements.requestWorkspace.contains(blacklistPreviousButton)) {
    loadBlacklistItems({
      force: true,
      offset: Math.max(0, state.blacklistOffset - state.blacklistLimit),
    });
    return;
  }
  const blacklistNextButton = event.target.closest("[data-blacklist-next]");
  if (blacklistNextButton && elements.requestWorkspace.contains(blacklistNextButton)) {
    loadBlacklistItems({
      force: true,
      offset: state.blacklistOffset + state.blacklistLimit,
    });
    return;
  }
  const reviewRefreshButton = event.target.closest("[data-pending-review-refresh]");
  if (reviewRefreshButton && elements.requestWorkspace.contains(reviewRefreshButton)) {
    loadPendingReviewItems({ force: true });
    return;
  }
  const reviewApproveButton = event.target.closest("[data-pending-review-approve]");
  if (reviewApproveButton && elements.requestWorkspace.contains(reviewApproveButton)) {
    approvePendingReviewVisibleItems();
    return;
  }
  const categoryBackButton = event.target.closest("[data-category-browse-back]");
  if (categoryBackButton && elements.requestWorkspace.contains(categoryBackButton)) {
    rememberDiscoverHierarchyScrollPosition(elements.discoverCategoriesPanel, "categories");
    state.categoryBrowseSeq += 1;
    state.categoryBrowseLoading = false;
    state.categoryBrowseLevel = "home";
    renderCategoryBrowseView();
    restoreRequestScrollPosition();
    return;
  }
  const categoryButton = event.target.closest("[data-category-id]");
  if (categoryButton && elements.requestWorkspace.contains(categoryButton)) {
    const categoryId = String(categoryButton.dataset.categoryId || "");
    rememberDiscoverHierarchyScrollPosition(elements.discoverCategoriesPanel, "categories");
    if (categoryId === state.categoryBrowseSelectedId && state.categoryBrowseLoaded) {
      state.categoryBrowseLevel = "detail";
      renderCategoryBrowseView();
      restoreRequestScrollPosition();
      return;
    }
    loadCategoryBrowse({
      categoryId,
      query: "",
      append: false,
    });
    return;
  }
  const backButton = event.target.closest("[data-d1-browse-back]");
  if (backButton && elements.requestWorkspace.contains(backButton)) {
    const kind = state.d1BrowseKind || "name";
    const mode = d1BrowseModeState(kind);
    rememberDiscoverHierarchyScrollPosition(activeRequestScrollOwner(), kind);
    mode.seq += 1;
    mode.loading = false;
    mode.level = state.d1BrowseLevel === "items" ? "tags" : "alphabet";
    restoreD1BrowseMode(kind);
    state.d1BrowseData = mode.level === "items" ? mode.itemData : mode.tagData;
    renderD1BrowseView();
    restoreRequestScrollPosition();
    return;
  }
  const letterButton = event.target.closest("[data-letter]");
  if (letterButton && elements.requestWorkspace.contains(letterButton)) {
    const kind = state.d1BrowseKind || "name";
    const mode = d1BrowseModeState(kind);
    const letter = String(letterButton.dataset.letter || "");
    rememberDiscoverHierarchyScrollPosition(activeRequestScrollOwner(), kind);
    if (mode.letter === letter && mode.tagData) {
      mode.level = "tags";
      restoreD1BrowseMode(kind);
      state.d1BrowseData = mode.tagData;
      renderD1BrowseView();
      restoreRequestScrollPosition();
      return;
    }
    mode.scrollPositions.tags = 0;
    mode.scrollPositions.items = 0;
    loadD1Browse({
      kind,
      letter,
      query: "",
      tag: "",
      locale: "",
    });
    return;
  }
  const tagButton = event.target.closest("[data-tag]");
  if (tagButton && elements.requestWorkspace.contains(tagButton)) {
    const kind = state.d1BrowseKind || "name";
    const mode = d1BrowseModeState(kind);
    const tag = String(tagButton.dataset.tag || "");
    const locale = String(tagButton.dataset.locale || "");
    rememberDiscoverHierarchyScrollPosition(activeRequestScrollOwner(), kind);
    if (mode.tag === tag && mode.locale === locale && mode.itemData) {
      mode.level = "items";
      restoreD1BrowseMode(kind);
      state.d1BrowseData = mode.itemData;
      renderD1BrowseView();
      restoreRequestScrollPosition();
      return;
    }
    mode.scrollPositions.items = 0;
    loadD1Browse({
      kind,
      letter: state.d1BrowseLetter,
      query: "",
      tag,
      locale,
    });
  }
});

elements.requestWorkspace?.addEventListener("click", async (event) => {
  const browseContainer = event.target.closest(
    "#request-discover-panel, #catalog-advanced-view",
  );
  if (!browseContainer || !elements.requestWorkspace.contains(browseContainer)) {
    return;
  }
  if (openSearchResultDetail(event, browseContainer, "discover")) {
    return;
  }
  const target = searchResultRequestTarget(event, browseContainer);
  if (!target?.url || (target.button && target.button.disabled)) {
    return;
  }
  let originalText = "";
  if (target.button) {
    target.button.disabled = true;
    target.button.setAttribute("aria-busy", "true");
    originalText = target.button.textContent;
    target.button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await handleAddByUrl(target.url, "tail", anchorPointForEvent(event, target.anchor), "discover");
  } finally {
    if (target.button) {
      target.button.disabled = false;
      target.button.removeAttribute("aria-busy");
      target.button.textContent = originalText;
    }
  }
});

elements.requestWorkspace?.addEventListener("scroll", (event) => {
  const target = event.target;
  if (state.requestScrollRestoring) {
    return;
  }
  if (target === elements.discoverCategoriesPanel) {
    rememberDiscoverHierarchyScrollPosition(target, "categories");
    maybeLoadMoreCategoryBrowse(target);
  } else if (target === elements.discoverNamePanel) {
    rememberDiscoverHierarchyScrollPosition(target, "name");
  } else if (target === elements.discoverArtistPanel) {
    rememberDiscoverHierarchyScrollPosition(target, "artist");
  }
}, true);

elements.followUpGrid?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-uid]");
  if (!button || button.disabled) {
    return;
  }
  const uid = String(button.dataset.uid || "").trim();
  if (!uid) {
    return;
  }
  state.sourceParentScrollPositions.uids = Number(elements.sourcesUidScroll?.scrollTop || 0);
  state.followBrowseSelectedUid = uid;
  if (elements.followSearchQuery) {
    elements.followSearchQuery.value = "";
  }
  await runRequestBusyAction(
    button,
    t("follow.loadingItems"),
    () => loadFollowBrowse({ uid, query: "" }),
  );
  if (elements.sourcesUidScroll) {
    elements.sourcesUidScroll.scrollTop = state.sourceItemScrollPositions.uids;
  }
});

elements.followBrowseBack?.addEventListener("click", () => {
  state.sourceItemScrollPositions.uids = Number(elements.sourcesUidScroll?.scrollTop || 0);
  state.followBrowseSelectedUid = "";
  if (elements.followSearchQuery) {
    elements.followSearchQuery.value = "";
  }
  renderFollowBrowse();
  if (elements.sourcesUidScroll) {
    elements.sourcesUidScroll.scrollTop = state.sourceParentScrollPositions.uids;
  }
});

elements.followSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.followBrowseLoading) {
    return;
  }
  const query = String(elements.followSearchQuery?.value || "").trim();
  await loadFollowBrowse({
    uid: state.followBrowseSelectedUid,
    query,
    keepQuery: true,
  });
});

elements.followSongResults?.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.followSongResults, "modalFollow")) {
    return;
  }
  const target = searchResultRequestTarget(event, elements.followSongResults);
  if (!target) {
    return;
  }
  if (!target.url || (target.button && target.button.disabled)) {
    return;
  }

  let originalText = "";
  if (target.button) {
    target.button.disabled = true;
    target.button.setAttribute("aria-busy", "true");
    originalText = target.button.textContent;
    target.button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await handleAddByUrl(target.url, "tail", anchorPointForEvent(event, target.anchor), "modalFollow");
  } finally {
    if (target.button) {
      target.button.disabled = false;
      target.button.removeAttribute("aria-busy");
      target.button.textContent = originalText;
    }
  }
});

elements.favlistGrid?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-folder-id]");
  if (!button || button.disabled) {
    return;
  }
  const folderId = String(button.dataset.folderId || "").trim();
  if (!folderId) {
    return;
  }
  state.sourceParentScrollPositions.favorites = Number(elements.sourcesFavoritesScroll?.scrollTop || 0);
  state.favlistBrowseSelectedFolderId = folderId;
  if (elements.favlistSearchQuery) {
    elements.favlistSearchQuery.value = "";
  }
  await runRequestBusyAction(
    button,
    t("favlist.loadingItems"),
    () => loadFavlistBrowse({ folderId, query: "" }),
  );
  if (elements.sourcesFavoritesScroll) {
    elements.sourcesFavoritesScroll.scrollTop = state.sourceItemScrollPositions.favorites;
  }
});

elements.favlistBrowseBack?.addEventListener("click", () => {
  state.sourceItemScrollPositions.favorites = Number(elements.sourcesFavoritesScroll?.scrollTop || 0);
  state.favlistBrowseSelectedFolderId = "";
  if (elements.favlistSearchQuery) {
    elements.favlistSearchQuery.value = "";
  }
  renderFavlistBrowse();
  if (elements.sourcesFavoritesScroll) {
    elements.sourcesFavoritesScroll.scrollTop = state.sourceParentScrollPositions.favorites;
  }
});

elements.favlistSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.favlistBrowseLoading) {
    return;
  }
  const query = String(elements.favlistSearchQuery?.value || "").trim();
  await loadFavlistBrowse({
    folderId: state.favlistBrowseSelectedFolderId,
    query,
    keepQuery: true,
  });
});

elements.favlistSongResults?.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.favlistSongResults, "modalFavlist")) {
    return;
  }
  const target = searchResultRequestTarget(event, elements.favlistSongResults);
  if (!target) {
    return;
  }
  if (!target.url || (target.button && target.button.disabled)) {
    return;
  }

  let originalText = "";
  if (target.button) {
    target.button.disabled = true;
    target.button.setAttribute("aria-busy", "true");
    originalText = target.button.textContent;
    target.button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await handleAddByUrl(target.url, "tail", anchorPointForEvent(event, target.anchor), "modalFavlist");
  } finally {
    if (target.button) {
      target.button.disabled = false;
      target.button.removeAttribute("aria-busy");
      target.button.textContent = originalText;
    }
  }
});

elements.sourcesUidScroll?.addEventListener("scroll", () => {
  const bucket = state.followBrowseSelectedUid ? state.sourceItemScrollPositions : state.sourceParentScrollPositions;
  bucket.uids = Number(elements.sourcesUidScroll.scrollTop || 0);
  state.requestScrollPositions.sources.uids = bucket.uids;
});

elements.sourcesFavoritesScroll?.addEventListener("scroll", () => {
  const bucket = state.favlistBrowseSelectedFolderId ? state.sourceItemScrollPositions : state.sourceParentScrollPositions;
  bucket.favorites = Number(elements.sourcesFavoritesScroll.scrollTop || 0);
  state.requestScrollPositions.sources.favorites = bucket.favorites;
});

elements.gatchaStage?.addEventListener("scroll", () => {
  state.gatchaScrollTop = Math.max(0, Number(elements.gatchaStage.scrollTop || 0));
});

elements.gatchaPoolConfigToggle?.addEventListener("click", async () => {
  await openPoolConfigModal();
});

async function confirmGatchaCandidate(event = null) {
  event?.stopPropagation?.();
  if (!state.gatchaCandidate || state.gatchaRequestBusy) {
    return false;
  }

  const url = state.gatchaCandidate.url;
  const title = state.gatchaCandidate.title;
  const idleLabel = elements.gatchaConfirmButton.textContent;
  const requesterName = validatedRequesterNameForAdd(setGatchaMessage);
  if (!requesterName) {
    renderGatchaWorkspace();
    return false;
  }

  state.gatchaRequestBusy = true;
  setGatchaMessage(t("gatcha.nozomi"));
  renderGatchaWorkspace();
  try {
    const accepted = await submitAddRequest(url, "tail", { requesterName });
    if (!accepted) {
      setGatchaMessage(t("error.requestFailed"), true);
      return false;
    }
    setFormMessage(t("gatcha.requestSuccess", { title }));
    clearAcceptedGatchaCandidate();
    render();
    return true;
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingModal(
        {
          url,
          position: "tail",
          requesterName,
          preserveInput: false,
          source: "gatcha",
          title,
          focusElement: elements.gatchaConfirmButton,
        },
        error.payload?.binding,
      );
      return false;
    }
    if (error.code === "duplicate_session_request") {
      const point = anchorPointForEvent({}, elements.gatchaConfirmButton);
      openConfirm({
        type: "duplicate-add",
        url,
        position: "tail",
        requesterName,
        preserveInput: false,
        source: "gatcha",
        title,
        focusElement: elements.gatchaConfirmButton,
        message: duplicateConfirmMessage(
          error.payload?.duplicate_item,
          error.payload?.session_entry,
          error.payload?.active_item,
        ),
        x: point.x,
        y: point.y,
      });
      return false;
    }
    setGatchaMessage(error.message, true);
    return false;
  } finally {
    state.gatchaRequestBusy = false;
    renderGatchaWorkspace();
    elements.gatchaConfirmButton.textContent = idleLabel;
  }
}

elements.gatchaConfirmButton.addEventListener("click", confirmGatchaCandidate);

elements.modalFollowUidForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await previewGatchaUidAddFromInput(elements.modalFollowUidInput, {
    messageTarget: "follow-modal",
    anchor: elements.modalAddFollowUidButton,
    event,
  });
});

elements.refreshGatchaCacheButton?.addEventListener("click", async () => {
  if (gatchaTaskBusy()) {
    setGatchaUidMessage(gatchaTaskBusyMessage(), true);
    renderGatchaUidFace();
    return;
  }
  state.gatchaRefreshSaving = true;
  renderGatchaUidFace();
  setGatchaUidMessage(t("gatcha.refreshingBackground"));
  try {
    const result = await refreshGatchaCache();
    if (result?.started !== false && state.data) {
      state.data.gatcha = {
        ...(state.data.gatcha || {}),
        busy: true,
        message: gatchaTaskBusyMessage(),
        last_status: "running",
      };
    }
    setGatchaUidMessage(result?.started === false ? t("gatcha.refreshAlreadyRunning") : t("gatcha.refreshStarted"));
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaRefreshSaving = false;
    renderGatchaUidFace();
  }
});

elements.modalFavlistPullForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await previewGatchaFavlistFromInput(elements.modalFavlistUidInput, {
    messageTarget: "favlist-modal",
    modalSource: "favlist-modal",
  });
});


async function startPolling() {
  hydrateLocalPreferences();
  await loadTranslations();
  initializeHostShell();
  syncApplicationRestartAvailability();
  initSearchDetailController();
  await initializeLocalPresentation();
  try {
    await reportMediaCapabilities();
  } catch {
    // Playback capability reporting should not block the host UI from loading.
  }
  try {
    await fetchState();
  } catch (error) {
    if (shouldReportStateFetchError(error)) {
      setAppMessage(error.message, true);
    }
  }
  await restartHostPlaybackAfterBootstrap();
  window.setInterval(async () => {
    try {
      await fetchState();
    } catch (error) {
      if (shouldReportStateFetchError(error)) {
        setAppMessage(error.message, true);
      }
    }
    await restartHostPlaybackAfterBootstrap();
  }, pollIntervalMs);
}

async function restartHostPlaybackAfterBootstrap() {
  if (!state.hostPlaybackBootstrapRestartPending || !state.hasValidStateResponse) {
    return false;
  }
  state.hostPlaybackBootstrapRestartPending = false;
  if (!state.data?.playback_program) {
    return false;
  }
  try {
    const accepted = await apiPostStateSnapshot("/api/player/restart-program");
    if (accepted) {
      render();
    }
    return accepted;
  } catch (error) {
    setAppMessage(error.message, true);
    return false;
  }
}

async function restartHostPlaybackAfterPageRestore() {
  if (
    !state.pageHidePlaybackRestartRequired
    || state.pageRestoreRestartInFlight
  ) {
    return false;
  }
  if (!state.data?.playback_program) {
    state.pageHidePlaybackRestartRequired = false;
    state.pageHiddenPlaybackGeneration = null;
    return false;
  }
  const pageHiddenPlaybackGeneration = state.pageHiddenPlaybackGeneration;
  state.pageRestoreRestartInFlight = true;
  let accepted = false;
  try {
    accepted = await apiPostStateSnapshot("/api/player/restart-program");
  } catch (error) {
    setAppMessage(error.message, true);
  } finally {
    state.pageHidePlaybackRestartRequired = false;
    state.pageHiddenPlaybackGeneration = null;
    state.pageRestoreRestartInFlight = false;
  }
  const acceptedNewerProgramWhileRestartWasPending = Boolean(
    !accepted
    && Number.isSafeInteger(pageHiddenPlaybackGeneration)
    && Number.isSafeInteger(state.data?.playback_generation)
    && state.data.playback_generation > pageHiddenPlaybackGeneration
    && state.data?.playback_program
  );
  if (accepted || acceptedNewerProgramWhileRestartWasPending) {
    const session = state.hostPlaybackSession;
    if (
      session?.phase === "retired"
      && session.playbackGeneration === state.data.playback_generation
      && playbackProgramDescriptorsEqual(
        session.playbackProgram,
        state.data.playback_program,
      )
      && !session.video
      && !session.audio
    ) {
      state.hostPlaybackSession = null;
    }
    render();
  }
  return accepted;
}

window.addEventListener("resize", () => {
  scheduleConfirmPopoverPositionSync();
  renderHostWorkspaceSelection();
  schedulePersistentStageMeasurement();
});
window.addEventListener("scroll", scheduleConfirmPopoverPositionSync, true);

window.addEventListener("pagehide", () => {
  const session = state.hostPlaybackSession;
  const restartRequired = Boolean(
    state.data?.playback_program
    && session?.video
    && session?.audio
    && isCurrentHostPlaybackSession(session, session.video, session.audio),
  );
  state.pageHidePlaybackRestartRequired = restartRequired;
  state.pageHiddenPlaybackGeneration = restartRequired
    ? session.playbackGeneration
    : null;
  teardownMountedPlayer();
  disposeSharedAudioContext();
  teardownLocalPresentationListeners();
  disconnectClient();
});
window.addEventListener("beforeunload", disconnectClient);
window.addEventListener("pageshow", () => {
  initializeLocalPresentation().catch(() => {});
  renderVolumeControls(frontendPlaybackMode(state.data?.playback_mode));
  restartHostPlaybackAfterPageRestore().catch(() => {});
});

startPolling();
