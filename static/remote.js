const audioVariantSwitchDebounceMs = 350;
const playerSettingsEchoSuppressMs = 1800;
const remoteVolumeCommitDebounceMs = 160;
const avDelayRequestTimeoutMs = 8000;
const viewportScaleResetDelaysMs = [0, 120, 360];
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
const stateFallbackRefreshMs = 1000;
const remoteConnectionOfflineGraceMs = 3000;
const larkSearchTableCount = 5;
const expandedSearchEagerCoverCount = 6;
const d1BrowseItemLimit = 450;
const d1BrowseTagLimit = 450;
const d1BrowseLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("");
const categoryBrowsePageSize = 100;
const searchResultItemByElement = new WeakMap();
let searchDetailController = null;
let searchModalCloseTimer = 0;
const categoryBrowseDefinitionsRaw = [
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
const categoryBrowseFullFieldTags = new Set([
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
const categoryBrowseImageUrls = [
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
const playerControlStatusSyncTimeoutMs = 3200;
const remoteRatingPromptThreshold = 0.5;
const storageKeys = {
  language: "bilikara.ui.language",
  theme: "bilikara.ui.theme",
};

function categoryBrowseTagKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function categoryBrowseUsesFullFieldSearch(tag) {
  return categoryBrowseFullFieldTags.has(categoryBrowseTagKey(tag));
}

const state = {
  language: "zh",
  translations: {},
  translationsLoaded: false,
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  submitting: false,
  retryActivityById: {},
  listView: "queue",
  openQueueMenuId: null,
  openHistoryMenuId: null,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  playerControlStatusRefreshTimers: [],
  autoRefreshTimer: null,
  stateFallbackFetchInFlight: false,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantSwitchTimer: null,
  remoteAvDelaySaving: false,
  remoteVolumeSaveSeq: 0,
  remoteSettingsEchoSuppressUntil: 0,
  remoteLocalVolumePercent: null,
  remoteLocalMuted: null,
  remoteVolumeCommitTimer: null,
  remoteLocalKeyShift: null,
  remoteKeyShiftEchoSuppressUntil: 0,
  remoteKeyShiftSaveSeq: 0,
  audioVariantBarExpanded: false,
  audioVariantBarItemId: "",
  bindingSheetOpen: false,
  bindingIntent: null,
  gatchaFavlistSheetOpen: false,
  gatchaFavlistIntent: null,
  poolConfigSheetOpen: false,
  poolConfigData: null,
  poolConfigSaving: false,
  reorderConfirmSheetOpen: false,
  reorderConfirmIntent: null,
  reorderConfirmSaving: false,
  bindingAccordion: {
    video: false,
    audio: false,
  },
  eventSource: null,
  eventStreamHealthy: false,
  eventStreamReconnectTimer: null,
  eventStreamRetryMs: eventStreamInitialRetryMs,
  gatchaCandidate: null,
  gatchaUidVisible: false,
  gatchaUidSaving: false,
  gatchaRefreshSaving: false,
  gatchaFavlistSaving: false,
  gatchaTaskLastMessageSignature: "",
  gatchaTaskWatchStartedAt: Date.now() / 1000,
  remoteRequestView: "quick",
  remoteSearchMode: "shared",
  searchModalOpen: false,
  searchModalView: "follow",
  gatchaStageView: "",
  gatchaStageAngle: 0,
  gatchaFlipTimer: null,
  gatchaFlipFrame: null,
  gatchaPruneTimer: null,
  gatchaMidpointCallback: null,
  remoteMenuOpen: false,
  remoteQrSectionOpen: false,
  remoteSettingsSectionOpen: false,
  remoteConnectionPhase: "connecting",
  remoteConnectionOfflineTimer: null,
  remoteConnectionFailureStartedAt: null,
  remoteIssueSignatures: new Set(),
  followBrowseData: null,
  followBrowseSelectedUid: "",
  followBrowseLoading: false,
  modalFollowBrowseRenderSignature: "",
  favlistBrowseData: null,
  favlistBrowseSelectedFolderId: "",
  favlistBrowseLoading: false,
  favlistBrowseRenderSignature: "",
  favlistBrowseReloadTimer: null,
  d1BrowseKind: "",
  d1BrowseLetter: "",
  d1BrowseTag: "",
  d1BrowseLocale: "",
  d1BrowseQuery: "",
  d1BrowseData: null,
  d1BrowseLoading: false,
  d1BrowseSeq: 0,
  categoryBrowseSelectedId: "",
  categoryBrowseQuery: "",
  categoryBrowseItems: [],
  categoryBrowseOffset: 0,
  categoryBrowseHasMore: false,
  categoryBrowseLoading: false,
  categoryBrowseSeq: 0,
  categoryBrowseError: "",
  remoteIdentity: {
    registered: false,
    name: "",
    sessionId: "",
  },
  remoteIdentityChecking: true,
  remoteIdentitySaving: false,
  remoteIdentityModalMode: "register",
  remoteIdentityError: "",
  dataRenderSignature: "",
  currentNowPlayingSignature: "",
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
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
  // Deferred auto-ratings: items that crossed the play threshold but whose
  // auto score=5 has not been submitted yet. The auto-rating fires TWO songs
  // later (when the next-next song starts), so the user has a full song's
  // duration to manually rate first. Map: playId -> { item, playId }.
  pendingAutoRatings: new Map(),
  // Ordered list of playIds waiting to be flushed. On each song transition,
  // the current song's pending auto-rating is moved here. Only the head
  // (oldest) is flushed — this gives a one-song buffer so A's auto-rating
  // fires when C starts, not when B starts.
  autoRatingFlushQueue: [],
  // Track the playId of the song currently being played so we can detect
  // song transitions and flush the previous song's deferred auto-rating.
  ratingCurrentPlayId: "",
  playerControlsRenderSignature: "",
  listHeaderRenderSignature: "",
  queueRenderSignature: "",
  historyRenderSignature: "",
  remoteAccessRenderSignature: "",
  viewportScaleResetTimers: [],
  renderDebounceTimer: null,
  theme: "light",
};

const elements = {
  viewportMeta: document.getElementById("viewport-meta"),
  remoteShell: document.getElementById("remote-shell"),
  languageSwitch: document.getElementById("language-switch"),
  themeSwitch: document.getElementById("theme-switch"),
  remoteMenuToggle: document.getElementById("remote-menu-toggle"),
  remoteMenuPanel: document.getElementById("remote-menu-panel"),
  remoteConnectionIndicator: document.getElementById("remote-connection-indicator"),
  remoteConnectionStatusIndicator: document.getElementById("remote-connection-status-indicator"),
  remoteConnectionStatusTrigger: document.getElementById("remote-connection-status-trigger"),
  remoteConnectionStatusValue: document.getElementById("remote-connection-status-value"),
  remoteConnectionStatusText: document.getElementById("remote-connection-status-text"),
  remoteQrToggle: document.getElementById("remote-qr-toggle"),
  remoteQrContent: document.getElementById("remote-qr-content"),
  remoteSettingsToggle: document.getElementById("remote-settings-toggle"),
  remoteSettingsContent: document.getElementById("remote-settings-content"),
  remotePopoverQrImage: document.getElementById("remote-popover-qr-image"),
  remotePopoverQrPlaceholder: document.getElementById("remote-popover-qr-placeholder"),
  remotePopoverUrlLink: document.getElementById("remote-popover-url-link"),
  remotePopoverUrlHint: document.getElementById("remote-popover-url-hint"),
  currentTitle: document.getElementById("current-title"),
  currentRequester: document.getElementById("current-requester"),
  currentOwner: document.getElementById("current-owner"),
  currentCacheState: document.getElementById("current-cache-state"),
  currentMeta: document.getElementById("current-meta"),
  currentRatingButton: document.getElementById("current-rating-button"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  playerControlPanel: document.getElementById("player-control-panel"),
  floatingPlayerControlPanel: document.getElementById("floating-player-control-panel"),
  remoteAvSyncPanel: document.getElementById("remote-av-sync-panel"),
  remoteAvOffsetInput: document.getElementById("remote-av-offset-input"),
  remoteAvOffsetResetButton: document.getElementById("remote-av-offset-reset-button"),
  remoteAvDelayLockButton: document.getElementById("remote-av-delay-lock-button"),
  remoteVolumePanel: document.getElementById("remote-volume-panel"),
  remoteVolumeMuteButton: document.getElementById("remote-volume-mute-button"),
  remoteVolumeSlider: document.getElementById("remote-volume-slider"),
  remoteVolumeValue: document.getElementById("remote-volume-value"),
  remoteKeyShiftPanel: document.getElementById("remote-key-shift-panel"),
  remoteKeyShiftResetButton: document.getElementById("remote-key-shift-reset-button"),
  remoteKeyShiftDecButton: document.getElementById("remote-key-shift-dec-button"),
  remoteKeyShiftInput: document.getElementById("remote-key-shift-input"),
  remoteKeyShiftIncButton: document.getElementById("remote-key-shift-inc-button"),
  floatingControlTrigger: document.getElementById("floating-control-trigger"),
  floatingControlOverlay: document.getElementById("floating-control-overlay"),
  floatingControlBackdrop: document.getElementById("floating-control-backdrop"),
  floatingControlCard: document.getElementById("floating-control-card"),
  floatingControlClose: document.getElementById("floating-control-close"),
  bindingSheet: document.getElementById("binding-sheet"),
  bindingSheetBackdrop: document.getElementById("binding-sheet-backdrop"),
  bindingVideoToggle: document.getElementById("binding-video-toggle"),
  bindingAudioToggle: document.getElementById("binding-audio-toggle"),
  bindingSheetVideoOptionsWrap: document.getElementById("binding-sheet-video-options-wrap"),
  bindingSheetAudioOptionsWrap: document.getElementById("binding-sheet-audio-options-wrap"),
  bindingSheetVideoOptions: document.getElementById("binding-sheet-video-options"),
  bindingSheetAudioOptions: document.getElementById("binding-sheet-audio-options"),
  bindingSheetClose: document.getElementById("binding-sheet-close"),
  bindingSheetCancel: document.getElementById("binding-sheet-cancel"),
  bindingSheetConfirm: document.getElementById("binding-sheet-confirm"),
  gatchaFavlistSheet: document.getElementById("gatcha-favlist-sheet"),
  gatchaFavlistSheetBackdrop: document.getElementById("gatcha-favlist-sheet-backdrop"),
  gatchaFavlistSheetText: document.getElementById("gatcha-favlist-sheet-text"),
  gatchaFavlistSheetOptions: document.getElementById("gatcha-favlist-sheet-options"),
  gatchaFavlistSheetClose: document.getElementById("gatcha-favlist-sheet-close"),
  gatchaFavlistSheetCancel: document.getElementById("gatcha-favlist-sheet-cancel"),
  gatchaFavlistSheetConfirm: document.getElementById("gatcha-favlist-sheet-confirm"),
  poolConfigSheet: document.getElementById("gatcha-pool-config-sheet"),
  poolConfigSheetBackdrop: document.getElementById("gatcha-pool-config-sheet-backdrop"),
  poolConfigSheetClose: document.getElementById("gatcha-pool-config-sheet-close"),
  poolConfigSheetCancel: document.getElementById("gatcha-pool-config-sheet-cancel"),
  poolConfigSheetReset: document.getElementById("gatcha-pool-config-sheet-reset"),
  poolConfigSheetSave: document.getElementById("gatcha-pool-config-sheet-save"),
  poolConfigWeightSlider: document.getElementById("gatcha-pool-weight-slider"),
  poolConfigWeightLabel: document.getElementById("gatcha-pool-weight-label"),
  poolConfigUidOptions: document.getElementById("gatcha-pool-uid-options"),
  poolConfigFavlistOptions: document.getElementById("gatcha-pool-favlist-options"),
  poolConfigUidSelectAll: document.getElementById("gatcha-pool-uid-select-all"),
  poolConfigUidSelectNone: document.getElementById("gatcha-pool-uid-select-none"),
  poolConfigFavlistSelectAll: document.getElementById("gatcha-pool-favlist-select-all"),
  poolConfigFavlistSelectNone: document.getElementById("gatcha-pool-favlist-select-none"),
  poolConfigMessage: document.getElementById("gatcha-pool-config-message"),
  reorderConfirmSheet: document.getElementById("reorder-confirm-sheet"),
  reorderConfirmSheetBackdrop: document.getElementById("reorder-confirm-sheet-backdrop"),
  reorderConfirmSheetText: document.getElementById("reorder-confirm-sheet-text"),
  reorderConfirmSheetClose: document.getElementById("reorder-confirm-sheet-close"),
  reorderConfirmSheetCancel: document.getElementById("reorder-confirm-sheet-cancel"),
  reorderConfirmSheetConfirm: document.getElementById("reorder-confirm-sheet-confirm"),
  requestForm: document.getElementById("request-form"),
  remoteRequestViewButtons: document.querySelectorAll("[data-remote-request-view]"),
  remoteRequestViewPanels: document.querySelectorAll("[data-remote-request-panel]"),
  remoteSearchModeButtons: document.querySelectorAll("[data-remote-search-mode]"),
  remoteSearchModePanels: document.querySelectorAll("[data-remote-search-panel]"),
  remoteIdentityName: document.getElementById("remote-identity-name"),
  remoteIdentityRename: document.getElementById("remote-identity-rename"),
  remoteIdentityModal: document.getElementById("remote-identity-modal"),
  remoteIdentityBackdrop: document.getElementById("remote-identity-backdrop"),
  remoteIdentityForm: document.getElementById("remote-identity-form"),
  remoteIdentityTitle: document.getElementById("remote-identity-title"),
  remoteIdentityDescription: document.getElementById("remote-identity-description"),
  remoteIdentityInput: document.getElementById("remote-identity-input"),
  remoteIdentityMessage: document.getElementById("remote-identity-message"),
  remoteIdentityCancel: document.getElementById("remote-identity-cancel"),
  remoteIdentitySubmit: document.getElementById("remote-identity-submit"),
  urlInput: document.getElementById("url-input"),
  searchForm: document.getElementById("search-form"),
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchMessage: document.getElementById("search-message"),
  searchResults: document.getElementById("search-results"),
  searchLibraryOpen: document.getElementById("search-library-open"),
  searchModal: document.getElementById("search-modal"),
  searchModalBackdrop: document.getElementById("search-modal-backdrop"),
  searchModalClose: document.getElementById("search-modal-close"),
  searchModalTabs: document.querySelectorAll(".remote-search-modal-tab"),
  favlistBrowserView: document.getElementById("favlist-browser-view"),
  favlistListView: document.getElementById("favlist-list-view"),
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
  modalFollowBrowserView: document.getElementById("modal-follow-browser-view"),
  modalFollowUpListView: document.getElementById("modal-follow-up-list-view"),
  modalFollowUidForm: document.getElementById("modal-follow-uid-form"),
  modalFollowUidInput: document.getElementById("modal-follow-uid-input"),
  modalAddFollowUidButton: document.getElementById("modal-add-follow-uid-button"),
  modalFollowUpGrid: document.getElementById("modal-follow-up-grid"),
  modalFollowUpItemsView: document.getElementById("modal-follow-up-items-view"),
  modalFollowBrowseBack: document.getElementById("modal-follow-browse-back"),
  modalFollowBrowseAvatar: document.getElementById("modal-follow-browse-avatar"),
  modalFollowBrowseTitle: document.getElementById("modal-follow-browse-title"),
  modalFollowBrowseCount: document.getElementById("modal-follow-browse-count"),
  modalFollowSearchForm: document.getElementById("modal-follow-search-form"),
  modalFollowSearchQuery: document.getElementById("modal-follow-search-query"),
  modalFollowSearchButton: document.getElementById("modal-follow-search-button"),
  modalFollowSongResults: document.getElementById("modal-follow-song-results"),
  modalFollowBrowseMessage: document.getElementById("modal-follow-browse-message"),
  modalFavlistPullForm: document.getElementById("modal-favlist-pull-form"),
  modalFavlistUidInput: document.getElementById("modal-favlist-uid-input"),
  modalPullFavlistButton: document.getElementById("modal-pull-favlist-button"),
  searchModalOtherView: document.getElementById("search-modal-other-view"),
  larkSearchForm: document.getElementById("lark-search-form"),
  larkSearchQuery: document.getElementById("lark-search-query"),
  larkSearchButton: document.getElementById("lark-search-button"),
  larkSearchMessage: document.getElementById("lark-search-message"),
  larkSearchResults: document.getElementById("lark-search-results"),
  addNextButton: document.getElementById("add-next-button"),
  resortPlaylistButton: document.getElementById("resort-playlist-button"),
  refreshButton: document.getElementById("refresh-button"),
  openRatingButton: document.getElementById("open-rating-button"),
  gatchaPoolConfigToggle: document.getElementById("gatcha-pool-config-toggle"),
  gatchaUidToggle: document.getElementById("gatcha-uid-toggle"),
  gatchaButton: document.getElementById("gatcha-button"),
  gatchaConfirmButton: document.getElementById("gatcha-confirm-button"),
  gatchaRetryButton: document.getElementById("gatcha-retry-button"),
  gatchaMessage: document.getElementById("gatcha-message"),
  gatchaInitView: document.getElementById("gatcha-init-view"),
  gatchaResultView: document.getElementById("gatcha-result-view"),
  gatchaCandidateTitle: document.getElementById("gatcha-candidate-title"),
  gatchaStage: document.getElementById("gatcha-stage"),
  gatchaStageInner: document.getElementById("gatcha-stage-inner"),
  gatchaUidView: document.getElementById("gatcha-uid-view"),
  gatchaUidForm: document.getElementById("gatcha-uid-form"),
  gatchaUidInput: document.getElementById("gatcha-uid-input"),
  addGatchaUidButton: document.getElementById("add-gatcha-uid-button"),
  refreshGatchaCacheButton: document.getElementById("refresh-gatcha-cache-button"),
  pullGatchaFavlistButton: document.getElementById("pull-gatcha-favlist-button"),
  gatchaUidMessage: document.getElementById("gatcha-uid-message"),
  listTag: document.getElementById("list-tag"),
  listTitle: document.getElementById("list-title"),
  listTitleText: document.getElementById("list-title-text"),
  listCount: document.getElementById("list-count"),
  queueViewButton: document.getElementById("queue-view-button"),
  historyViewButton: document.getElementById("history-view-button"),
  historyExportRow: document.getElementById("history-export-row"),
  historyExportSource: document.getElementById("history-export-source"),
  historyExportPageSize: document.getElementById("history-export-page-size"),
  historyExportImageButton: document.getElementById("history-export-image-button"),
  historyExportCsvButton: document.getElementById("history-export-csv-button"),
  appToast: document.getElementById("app-toast"),
  queueList: document.getElementById("queue-list"),
  historyList: document.getElementById("history-list"),
  queueItemTemplate: document.getElementById("queue-item-template"),
  historyItemTemplate: document.getElementById("history-item-template"),
  gatchaTag: document.getElementById("gatcha-tag"),
  gatchaTitle: document.getElementById("gatcha-title"),
};

const historyExportGuard = window.BilikaraExportGuard.createExportGuard([
  elements.historyExportImageButton,
  elements.historyExportCsvButton,
]);

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

function requesterBadgeText(requesterName) {
  const normalized = String(requesterName || "").trim();
  return normalized ? t("request.requesterBadge", { name: normalized }) : "";
}

function ownerLineText(ownerName) {
  return String(ownerName || "").trim();
}

function selectedRequesterName() {
  return state.remoteIdentity.registered ? String(state.remoteIdentity.name || "").trim() : "";
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

function normalizeLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cn" || normalized === "zh-cn" || normalized === "zh_hans" || normalized === "zh-hans") {
    return "zh";
  }
  if (normalized === "jp" || normalized === "ja-jp") {
    return "ja";
  }
  if (normalized === "en" || normalized === "ja" || normalized === "zh") {
    return normalized;
  }
  return "zh";
}

function t(key, replacements = {}) {
  const fallbackLanguage = state.translations.defaultLanguage || "zh";
  const languages = state.translations.languages || {};
  const activeMessages = languages[state.language] || {};
  const fallbackMessages = languages[fallbackLanguage] || {};
  const source = Object.prototype.hasOwnProperty.call(activeMessages, key)
    ? activeMessages[key]
    : fallbackMessages[key] || key;
  return String(source).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(replacements, name) ? String(replacements[name]) : match
  ));
}

function activeLocale() {
  if (state.language === "en") {
    return "en-US";
  }
  if (state.language === "ja") {
    return "ja-JP";
  }
  return "zh-CN";
}

function setTextContent(element, key, replacements = {}) {
  if (!element) {
    return;
  }
  element.textContent = t(key, replacements);
}

function setElementAttribute(element, attribute, key, replacements = {}) {
  if (!element) {
    return;
  }
  element.setAttribute(attribute, t(key, replacements));
}

function setElementTitle(element, key, replacements = {}) {
  setElementAttribute(element, "title", key, replacements);
}

function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    setTextContent(element, element.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    setElementAttribute(element, "placeholder", element.dataset.i18nPlaceholder);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((element) => {
    setElementTitle(element, element.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    setElementAttribute(element, "aria-label", element.dataset.i18nAriaLabel);
  });
  root.querySelectorAll("[data-i18n-alt]").forEach((element) => {
    setElementAttribute(element, "alt", element.dataset.i18nAlt);
  });
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : state.language;
  document.title = t("document.remoteTitle");
}

function renderLanguageSwitch() {
  elements.languageSwitch?.querySelectorAll("button[data-language]").forEach((button) => {
    button.classList.toggle("active", normalizeLanguage(button.dataset.language) === state.language);
  });
}

function invalidateLanguageSensitiveRenderCache() {
  state.remoteAccessRenderSignature = "";
  state.modalFollowBrowseRenderSignature = "";
  state.favlistBrowseRenderSignature = "";
  state.gatchaTaskLastMessageSignature = "";
  state.listHeaderRenderSignature = "";
  state.queueRenderSignature = "";
  state.historyRenderSignature = "";
  state.playerControlsRenderSignature = "";
  state.currentNowPlayingSignature = "";
}

function setLanguage(language) {
  const nextLanguage = normalizeLanguage(language);
  if (state.language === nextLanguage) {
    renderLanguageSwitch();
    renderRemoteConnectionStatus();
    return;
  }
  state.language = nextLanguage;
  writeLocalPreference(storageKeys.language, nextLanguage);
  invalidateLanguageSensitiveRenderCache();
  applyStaticI18n();
  renderLanguageSwitch();
  renderRemoteConnectionStatus();
  if (state.data) {
    render();
  }
  syncBilikaraSearchView();
  if (state.searchModalOpen) {
    renderSearchModalView(state.searchModalView);
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
    if (response.ok) {
      state.translations = await response.json();
    }
  } catch {
    state.translations = {};
  } finally {
    state.translationsLoaded = true;
    applyStaticI18n();
    renderLanguageSwitch();
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

function closeOpenMenus() {
  document.querySelectorAll(".menu-content").forEach((menu) => {
    menu.classList.add("hidden");
  });
  state.openQueueMenuId = null;
  state.openHistoryMenuId = null;
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

function normalizeRemoteRequestView(value, fallback = "quick") {
  const candidate = String(value || "").trim().toLowerCase();
  return candidate === "quick" || candidate === "search" ? candidate : fallback;
}

function normalizeRemoteSearchMode(value, fallback = "shared") {
  const candidate = String(value || "").trim().toLowerCase();
  return candidate === "shared" || candidate === "local" ? candidate : fallback;
}

function setRemoteTabPanelVisibility(panel, visible) {
  if (!panel) {
    return;
  }
  panel.hidden = !visible;
  panel.inert = !visible;
  panel.setAttribute("aria-hidden", String(!visible));
}

function syncRemoteSearchModeSelection() {
  const activeMode = normalizeRemoteSearchMode(state.remoteSearchMode);
  state.remoteSearchMode = activeMode;
  elements.remoteSearchModeButtons?.forEach((button) => {
    const mode = normalizeRemoteSearchMode(button.dataset.remoteSearchMode, "");
    const selected = mode === activeMode;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  elements.remoteSearchModePanels?.forEach((panel) => {
    setRemoteTabPanelVisibility(
      panel,
      panel.dataset.remoteSearchPanel === activeMode,
    );
  });
}

function syncRemoteRequestViewSelection() {
  const activeView = normalizeRemoteRequestView(state.remoteRequestView);
  state.remoteRequestView = activeView;
  if (elements.remoteShell) {
    elements.remoteShell.dataset.remoteRequestView = activeView;
  }
  elements.remoteRequestViewButtons?.forEach((button) => {
    const view = normalizeRemoteRequestView(button.dataset.remoteRequestView, "");
    const selected = view === activeView;
    button.hidden = false;
    button.inert = false;
    button.setAttribute("aria-hidden", "false");
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  elements.remoteRequestViewPanels?.forEach((panel) => {
    setRemoteTabPanelVisibility(
      panel,
      panel.dataset.remoteRequestPanel === activeView,
    );
  });
  syncRemoteSearchModeSelection();
}

function activateRemoteRequestView(view, { focusTab = false } = {}) {
  const nextView = normalizeRemoteRequestView(view, "");
  if (!nextView) {
    return false;
  }
  const changed = state.remoteRequestView !== nextView;
  state.remoteRequestView = nextView;
  syncRemoteRequestViewSelection();
  if (focusTab) {
    Array.from(elements.remoteRequestViewButtons || [])
      .find((button) => button.dataset.remoteRequestView === nextView && !button.hidden)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function activateRemoteSearchMode(mode, { focusTab = false } = {}) {
  const nextMode = normalizeRemoteSearchMode(mode, "");
  if (!nextMode) {
    return false;
  }
  const changed = state.remoteSearchMode !== nextMode;
  state.remoteSearchMode = nextMode;
  syncRemoteSearchModeSelection();
  if (focusTab) {
    Array.from(elements.remoteSearchModeButtons || [])
      .find((button) => button.dataset.remoteSearchMode === nextMode)
      ?.focus({ preventScroll: true });
  }
  return changed;
}

function handleRemoteHorizontalTabKeydown(event, values, currentValue, activate) {
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

function handleRemoteRequestTabKeydown(event) {
  return handleRemoteHorizontalTabKeydown(
    event,
    ["quick", "search"],
    String(event.currentTarget?.dataset?.remoteRequestView || ""),
    activateRemoteRequestView,
  );
}

function handleRemoteSearchModeTabKeydown(event) {
  return handleRemoteHorizontalTabKeydown(
    event,
    ["shared", "local"],
    String(event.currentTarget?.dataset?.remoteSearchMode || ""),
    activateRemoteSearchMode,
  );
}

function hydrateLocalPreferences() {
  // Hydrate and apply theme
  state.theme = normalizeTheme(readLocalString(storageKeys.theme, state.theme));
  applyTheme(state.theme);
}

function remoteConnectionStatusKey(phase = state.remoteConnectionPhase) {
  if (phase === "connected") {
    return "remote.connectionConnected";
  }
  if (phase === "reconnecting") {
    return "remote.connectionReconnecting";
  }
  if (phase === "offline") {
    return "remote.connectionOffline";
  }
  return "remote.connectionConnecting";
}

function normalizeRemoteConnectionPhase(phase) {
  return phase === "connected"
    || phase === "reconnecting"
    || phase === "offline"
    ? phase
    : "connecting";
}

function syncRemoteConnectionIndicatorNode(indicator, phase) {
  if (!indicator) {
    return;
  }
  const normalizedPhase = normalizeRemoteConnectionPhase(phase);
  if (indicator.dataset.connectionPhase === normalizedPhase) {
    return;
  }
  indicator.dataset.connectionPhase = normalizedPhase;
  indicator.classList.remove("is-ready", "is-failed", "is-loading", "is-pending");
  if (normalizedPhase === "connected") {
    indicator.classList.add("is-ready");
    indicator.textContent = "✓";
  } else if (normalizedPhase === "offline") {
    indicator.classList.add("is-failed");
    indicator.textContent = "×";
  } else {
    indicator.classList.add("is-loading");
    indicator.textContent = "";
  }
}

function syncRemoteConnectionIndicator(phase) {
  const normalizedPhase = normalizeRemoteConnectionPhase(phase);
  syncRemoteConnectionIndicatorNode(elements.remoteConnectionIndicator, normalizedPhase);
  syncRemoteConnectionIndicatorNode(elements.remoteConnectionStatusIndicator, normalizedPhase);
}

function renderRemoteConnectionStatus() {
  const phase = normalizeRemoteConnectionPhase(state.remoteConnectionPhase);
  const statusText = t(remoteConnectionStatusKey(phase));
  syncRemoteConnectionIndicator(phase);
  setTextContent(elements.remoteConnectionStatusValue, remoteConnectionStatusKey(phase));
  setTextContent(elements.remoteConnectionStatusText, remoteConnectionStatusKey(phase));
  if (elements.remoteConnectionStatusTrigger) {
    elements.remoteConnectionStatusTrigger.setAttribute(
      "aria-label",
      t("remote.connectionIndicatorLabel", { status: statusText }),
    );
  }
  if (elements.remoteMenuToggle) {
    elements.remoteMenuToggle.setAttribute("aria-label", t("remote.menuLabel", { status: statusText }));
  }
}

function setRemoteConnectionPhase(phase) {
  const nextPhase = normalizeRemoteConnectionPhase(phase);
  if (state.remoteConnectionPhase === nextPhase) {
    return false;
  }
  state.remoteConnectionPhase = nextPhase;
  renderRemoteConnectionStatus();
  return true;
}

function setRemoteMenuOpen(open, { restoreFocus = false } = {}) {
  const nextOpen = Boolean(open);
  state.remoteMenuOpen = nextOpen;
  elements.remoteMenuPanel?.classList.toggle("hidden", !nextOpen);
  elements.remoteMenuToggle?.setAttribute("aria-expanded", String(nextOpen));
  if (!nextOpen) {
    setRemoteQrSectionOpen(false);
    setRemoteSettingsSectionOpen(false);
    if (typeof closeRemoteContextualInfo === "function") {
      closeRemoteContextualInfo();
    }
    if (restoreFocus && typeof elements.remoteMenuToggle?.focus === "function") {
      elements.remoteMenuToggle.focus({ preventScroll: true });
    }
  }
}

function setRemoteQrSectionOpen(open) {
  state.remoteQrSectionOpen = Boolean(open);
  elements.remoteQrContent?.classList.toggle("hidden", !state.remoteQrSectionOpen);
  elements.remoteQrToggle?.setAttribute("aria-expanded", String(state.remoteQrSectionOpen));
  elements.remoteQrToggle?.classList.toggle("is-expanded", state.remoteQrSectionOpen);
}

function setRemoteSettingsSectionOpen(open) {
  state.remoteSettingsSectionOpen = Boolean(open);
  elements.remoteSettingsContent?.classList.toggle("hidden", !state.remoteSettingsSectionOpen);
  elements.remoteSettingsToggle?.setAttribute("aria-expanded", String(state.remoteSettingsSectionOpen));
  elements.remoteSettingsToggle?.classList.toggle("is-expanded", state.remoteSettingsSectionOpen);
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
  const signature = JSON.stringify({ language: state.language, displayUrl, displayHint });
  if (signature === state.remoteAccessRenderSignature) {
    return;
  }
  state.remoteAccessRenderSignature = signature;

  if (elements.remotePopoverUrlLink) {
    elements.remotePopoverUrlLink.href = displayUrl;
    elements.remotePopoverUrlLink.textContent = displayUrl;
  }
  if (elements.remotePopoverUrlHint) {
    elements.remotePopoverUrlHint.textContent = displayHint;
  }
  renderRemoteQr(displayUrl, [
    { image: elements.remotePopoverQrImage, placeholder: elements.remotePopoverQrPlaceholder, size: 220 },
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

function setFormMessage(message, isError = false) {
  setAppMessage(message, isError);
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
    }, 2800);
  }
}

function setSearchMessage(message, isError = false) {
  if (!elements.searchMessage) {
    return;
  }
  elements.searchMessage.textContent = message || "";
  elements.searchMessage.classList.toggle("error", Boolean(isError));
}

function setLarkSearchMessage(message, isError = false) {
  if (!elements.larkSearchMessage) {
    return;
  }
  elements.larkSearchMessage.textContent = message || "";
  elements.larkSearchMessage.classList.toggle("error", Boolean(isError));
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
  if (source === "modalFavlist") {
    setFavlistBrowseMessage(message, isError);
    return;
  }
  if (source === "modalFollow") {
    setModalFollowBrowseMessage(message, isError);
    return;
  }
  if (source === "modalBrowse") {
    const messageElement = elements.searchModalOtherView?.querySelector(".tag-browser-message");
    if (messageElement) {
      messageElement.textContent = message || "";
      messageElement.classList.toggle("is-error", Boolean(isError));
      return;
    }
  }
  if (source === "gatcha") {
    setGatchaMessage(message, isError);
    return;
  }
  setFormMessage(message, isError);
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

function setGatchaStageView(showUid, onMidpoint) {
  if (!elements.gatchaStage) {
    if (typeof onMidpoint === "function") {
      onMidpoint();
    }
    return;
  }
  const nextView = showUid ? "uid" : "draw";
  const previousView = state.gatchaStageView || "draw";
  const isInitialRender = !state.gatchaStageView;
  if (state.gatchaStageView === nextView) {
    if (elements.gatchaStage.classList.contains("is-flipping") && !elements.gatchaStage.classList.contains("is-flip-pruned")) {
      state.gatchaMidpointCallback = onMidpoint;
      return;
    }
    if (typeof onMidpoint === "function") {
      onMidpoint();
    }
    return;
  }
  state.gatchaStageView = nextView;

  if (state.gatchaFlipTimer) {
    window.clearTimeout(state.gatchaFlipTimer);
    state.gatchaFlipTimer = null;
  }
  if (state.gatchaPruneTimer) {
    window.clearTimeout(state.gatchaPruneTimer);
    state.gatchaPruneTimer = null;
  }
  elements.gatchaStage.classList.remove("is-flip-pruned");
  if (state.gatchaFlipFrame) {
    window.cancelAnimationFrame(state.gatchaFlipFrame);
    state.gatchaFlipFrame = null;
    elements.gatchaStage.classList.remove("is-preparing-flip", "is-flip-pruned");
  }

  const applyGatchaStageClass = (activeView) => {
    elements.gatchaStage.classList.toggle("is-uid-view", activeView === "uid");
  };
  const clearFlip = () => {
    elements.gatchaStage?.classList.remove("is-flipping", "is-preparing-flip", "is-flip-pruned");
    elements.gatchaStage?.removeAttribute("data-previous-view");
    state.gatchaFlipTimer = null;
  };

  if (isInitialRender) {
    state.gatchaStageAngle = nextView === "uid" ? 180 : 0;
    if (elements.gatchaStageInner) {
      elements.gatchaStageInner.style.transform = `rotateY(${state.gatchaStageAngle}deg)`;
    }
    applyGatchaStageClass(nextView);
    elements.gatchaStage.classList.remove("is-flipping", "is-preparing-flip", "is-flip-pruned");
    elements.gatchaStage.removeAttribute("data-previous-view");
    if (typeof onMidpoint === "function") {
      onMidpoint();
    }
    return;
  }

  const startAngle = state.gatchaStageAngle;
  state.gatchaStageAngle += nextView === "uid" ? 180 : -180;
  state.gatchaMidpointCallback = onMidpoint;
  elements.gatchaStage.dataset.previousView = previousView;
  elements.gatchaStage.classList.add("is-preparing-flip", "is-flipping");
  if (elements.gatchaStageInner) {
    elements.gatchaStageInner.style.transform = `rotateY(${startAngle}deg)`;
    elements.gatchaStageInner.getBoundingClientRect();
  }
  state.gatchaFlipFrame = window.requestAnimationFrame(() => {
    state.gatchaFlipFrame = null;
    elements.gatchaStage?.classList.remove("is-preparing-flip");
    if (elements.gatchaStageInner) {
      elements.gatchaStageInner.style.transform = `rotateY(${state.gatchaStageAngle}deg)`;
    }
  });
  state.gatchaPruneTimer = window.setTimeout(() => {
    state.gatchaPruneTimer = null;
    elements.gatchaStage?.classList.add("is-flip-pruned");
    applyGatchaStageClass(nextView);
    const midpointCallback = state.gatchaMidpointCallback;
    state.gatchaMidpointCallback = null;
    if (typeof midpointCallback === "function") {
      midpointCallback();
    }
  }, 150);
  state.gatchaFlipTimer = window.setTimeout(clearFlip, 420);
}

function setupRemoteFlipStages() {
  if (elements.gatchaStage || !elements.gatchaInitView || !elements.gatchaResultView || !elements.gatchaUidView) {
    return;
  }
  const gatchaPanel = elements.gatchaInitView.closest(".gatcha-panel");
  if (!gatchaPanel) {
    return;
  }

  const stage = document.createElement("div");
  stage.id = "gatcha-stage";
  stage.className = "gatcha-stage";
  const inner = document.createElement("div");
  inner.id = "gatcha-stage-inner";
  inner.className = "gatcha-stage-inner";
  const mainFace = document.createElement("div");
  mainFace.id = "gatcha-main-view";
  mainFace.className = "gatcha-face gatcha-face-front";

  gatchaPanel.insertBefore(stage, elements.gatchaInitView);
  stage.appendChild(inner);
  inner.appendChild(mainFace);
  mainFace.append(elements.gatchaInitView, elements.gatchaResultView);
  elements.gatchaUidView.classList.remove("hidden");
  elements.gatchaUidView.classList.add("gatcha-face", "gatcha-face-back");
  inner.appendChild(elements.gatchaUidView);

  elements.gatchaStage = stage;
  elements.gatchaStageInner = inner;
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
      credentials: "same-origin",
      headers: clientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const data = await response.json();
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

async function apiPostExactStateCommand(url, payload = {}, options = {}) {
  const envelope = await apiPost(url, payload, {
    ...options,
    returnEnvelope: true,
  });
  return {
    snapshotAccepted: applyStateSnapshot(envelope.data),
    commandApplied: envelope.stale !== true,
  };
}

function normalizedRemoteIdentity(payload) {
  return {
    registered: Boolean(payload?.registered),
    name: String(payload?.name || "").trim(),
    sessionId: String(payload?.session_id || "").trim(),
  };
}

function renderRemoteIdentity() {
  const identity = state.remoteIdentity;
  const registered = Boolean(identity.registered && identity.name);
  const renameMode = registered && state.remoteIdentityModalMode === "rename";
  const modalOpen = !registered || renameMode;

  if (elements.remoteIdentityName) {
    elements.remoteIdentityName.textContent = registered ? identity.name : "—";
  }
  if (elements.remoteIdentityRename) {
    elements.remoteIdentityRename.disabled = !registered || state.remoteIdentitySaving;
  }
  elements.remoteIdentityModal?.classList.toggle("hidden", !modalOpen);
  document.body.classList.toggle("remote-identity-modal-open", modalOpen);
  if (elements.remoteShell) {
    elements.remoteShell.inert = modalOpen;
  }
  if (elements.remoteIdentityTitle) {
    elements.remoteIdentityTitle.textContent = t(renameMode ? "remoteIdentity.renameTitle" : "remoteIdentity.registerTitle");
  }
  if (elements.remoteIdentityDescription) {
    elements.remoteIdentityDescription.textContent = t(
      renameMode ? "remoteIdentity.renameDescription" : "remoteIdentity.registerDescription",
    );
  }
  if (elements.remoteIdentityCancel) {
    elements.remoteIdentityCancel.classList.toggle("hidden", !renameMode);
  }
  if (elements.remoteIdentitySubmit) {
    elements.remoteIdentitySubmit.textContent = t(
      state.remoteIdentitySaving
        ? "remoteIdentity.saving"
        : renameMode
          ? "remoteIdentity.renameSubmit"
          : "remoteIdentity.registerSubmit",
    );
    elements.remoteIdentitySubmit.disabled = state.remoteIdentityChecking || state.remoteIdentitySaving;
  }
  if (elements.remoteIdentityInput) {
    elements.remoteIdentityInput.disabled = state.remoteIdentityChecking || state.remoteIdentitySaving;
  }
  if (elements.remoteIdentityMessage) {
    elements.remoteIdentityMessage.textContent = state.remoteIdentityChecking
      ? t("remoteIdentity.checking")
      : state.remoteIdentityError;
    elements.remoteIdentityMessage.classList.toggle("is-error", Boolean(state.remoteIdentityError));
  }
}

function applyRemoteIdentity(payload) {
  state.remoteIdentity = normalizedRemoteIdentity(payload);
  state.remoteIdentityChecking = false;
  state.remoteIdentitySaving = false;
  state.remoteIdentityModalMode = "register";
  state.remoteIdentityError = "";
  renderRemoteIdentity();
}

async function fetchRemoteIdentity({ showExpired = false } = {}) {
  state.remoteIdentityChecking = true;
  state.remoteIdentityError = "";
  renderRemoteIdentity();
  try {
    const response = await fetch("/api/remote-identity", {
      cache: "no-store",
      credentials: "same-origin",
      headers: clientHeaders(),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(localizedApiMessage(payload.error) || t("error.requestFailed"));
    }
    applyRemoteIdentity(payload.data);
    if (showExpired && !state.remoteIdentity.registered) {
      state.remoteIdentityError = t("remoteIdentity.expired");
      renderRemoteIdentity();
    }
  } catch (error) {
    state.remoteIdentity = normalizedRemoteIdentity(null);
    state.remoteIdentityChecking = false;
    state.remoteIdentityError = error?.message || t("error.requestFailed");
    renderRemoteIdentity();
  }
}

function syncRemoteIdentityWithSnapshot(snapshot) {
  if (!state.remoteIdentity.registered) {
    renderRemoteIdentity();
    return;
  }
  if (state.remoteIdentitySaving || state.remoteIdentityChecking) {
    return;
  }
  const sessionId = String(snapshot?.remote_session_id || "").trim();
  const users = Array.isArray(snapshot?.session_users) ? snapshot.session_users : [];
  const identityIsCurrent = sessionId
    && sessionId === state.remoteIdentity.sessionId
    && users.includes(state.remoteIdentity.name);
  if (identityIsCurrent) {
    return;
  }
  // Re-check only when SSE reveals a session/name mismatch. This keeps other
  // tabs in sync after rename without adding a polling loop.
  void fetchRemoteIdentity({ showExpired: true });
}

function openRemoteIdentityRename() {
  if (!state.remoteIdentity.registered || state.remoteIdentitySaving) {
    return;
  }
  state.remoteIdentityModalMode = "rename";
  state.remoteIdentityError = "";
  if (elements.remoteIdentityInput) {
    elements.remoteIdentityInput.value = state.remoteIdentity.name;
  }
  renderRemoteIdentity();
  elements.remoteIdentityInput?.focus();
  elements.remoteIdentityInput?.select();
}

function closeRemoteIdentityRename() {
  if (!state.remoteIdentity.registered || state.remoteIdentitySaving) {
    return;
  }
  state.remoteIdentityModalMode = "register";
  state.remoteIdentityError = "";
  renderRemoteIdentity();
}

async function submitRemoteIdentity(event) {
  event.preventDefault();
  if (state.remoteIdentityChecking || state.remoteIdentitySaving) {
    return;
  }
  const name = String(elements.remoteIdentityInput?.value || "").trim();
  if (!name) {
    state.remoteIdentityError = t("remoteIdentity.required");
    renderRemoteIdentity();
    return;
  }
  const renameMode = state.remoteIdentity.registered && state.remoteIdentityModalMode === "rename";
  state.remoteIdentitySaving = true;
  state.remoteIdentityError = "";
  renderRemoteIdentity();
  try {
    const identity = await apiPost(
      renameMode ? "/api/remote-identity/rename" : "/api/remote-identity/register",
      { name },
    );
    applyRemoteIdentity(identity);
    if (elements.remoteIdentityInput) {
      elements.remoteIdentityInput.value = "";
    }
  } catch (error) {
    if (error.code === "session_user_already_exists") {
      const confirmClaim = confirm(
        t("remoteIdentity.confirmClaim", { name }) || `该用户 "${name}" 已存在，是否认领该身份？`
      );
      if (confirmClaim) {
        try {
          state.remoteIdentitySaving = true;
          renderRemoteIdentity();
          const identity = await apiPost("/api/remote-identity/register", { name, claim: true });
          applyRemoteIdentity(identity);
          if (elements.remoteIdentityInput) {
            elements.remoteIdentityInput.value = "";
          }
          return;
        } catch (innerError) {
          state.remoteIdentitySaving = false;
          state.remoteIdentityError = innerError?.message || t("error.requestFailed");
          renderRemoteIdentity();
          return;
        }
      }
    }
    state.remoteIdentitySaving = false;
    state.remoteIdentityError = error?.message || t("error.requestFailed");
    renderRemoteIdentity();
  }
}

function ratingLog(message) {
  console.log("[rating]", message);
  try {
    fetch("/api/rating/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* ignore */ }
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
    ratingLog("submit BLOCKED by dedup: playId=" + playId + " score=" + score);
    return false;
  }
  if (submissionKey) {
    state.ratingSubmittedKeys.add(submissionKey);
    // The user submitted a manual rating — cancel any pending auto-rating
    // for this item so the auto score=5 doesn't override the user's choice.
    state.pendingAutoRatings.delete(playId);
    // Also remove it from the flush queue if it's already been moved there.
    state.autoRatingFlushQueue = state.autoRatingFlushQueue.filter(
      (entry) => entry.playId !== playId
    );
  }
  ratingLog("submit OK: playId=" + playId + " score=" + score + " user=" + sessionUserName);
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
    keepalive: true,
  }).catch((error) => {
    if (submissionKey) {
      state.ratingSubmittedKeys.delete(submissionKey);
      renderCurrentRatingButton(state.data?.current_item);
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

function isItemRateable(item, isCurrent = false) {
  const bvid = String(item?.bvid || "").trim();
  if (!item || !bvid) {
    return false;
  }
  // Manual rating is no longer gated by the play threshold. The user can
  // rate at any time — the auto-rating defers to the user's choice.
  return true;
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
    const isRateable = tab === "current" ? state.ratingPromptCurrentRateable : state.ratingPromptPreviousRateable;
    button.disabled = !isRateable;
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
  const addUpButton = root.querySelector("[data-rating-add-up]");
  if (addUpButton) {
    const ownerUid = ratingOwnerUid(activeItem);
    addUpButton.disabled = !ownerUid;
    addUpButton.textContent = ownerUid ? t("rating.addUp") : t("rating.missingUid");
  }
  renderRatingStars();
}

function setRatingPromptActiveTab(tab) {
  if (!state.ratingPromptElement || !state.ratingPromptItems?.[tab]) {
    return;
  }
  state.ratingPromptActiveTab = tab;
  const activeItem = state.ratingPromptItems[tab];
  state.ratingPromptItemId = String(activeItem?.id || activeItem?.bvid || "").trim();
  renderRatingPromptContent();
}

function setRatingOptOut(enabled) {
  state.ratingOptOut = Boolean(enabled);
}

function closeRatingPrompt({ submit = true } = {}) {
  const root = state.ratingPromptElement;
  if (!root) {
    return;
  }
  const promptItem = activeRatingPromptItem();
  const bvid = state.ratingPromptBvid;
  const shouldSubmit = submit && !state.ratingPromptSubmitted && !state.ratingOptOut && bvid;
  state.ratingPromptSubmitted = true;

  root.classList.add("closing");

  state.ratingPromptElement = null;
  state.ratingPromptItem = null;
  state.ratingPromptItems = null;
  state.ratingPromptActiveTab = "current";
  state.ratingPromptItemId = "";
  state.ratingPromptBvid = "";

  setTimeout(() => {
    root.remove();
  }, 250);

  if (shouldSubmit) {
    submitSongRating({ ...(promptItem || {}), bvid }, state.ratingPromptScore);
  }
}

function openRatingPrompt(item, { manual = false } = {}) {
  const bvid = String(item?.bvid || "").trim();
  const playId = String(item?.id || bvid).trim();
  if (!item || !bvid || !playId || (!manual && (state.ratingOptOut || state.ratingPromptSeenPlayIds.has(playId)))) {
    return;
  }

  const promptItems = ratingPromptItemsForItem(item);
  const currentRateable = isItemRateable(promptItems.current, true);
  const previousRateable = isItemRateable(promptItems.previous, false);

  if (!currentRateable && !previousRateable) {
    return;
  }

  closeRatingPrompt({ submit: true });

  const defaultTab = currentRateable ? "current" : "previous";
  const activeItem = promptItems[defaultTab];
  const activePlayId = String(activeItem?.id || activeItem?.bvid || "").trim();

  if (activePlayId) {
    state.ratingPromptSeenPlayIds.add(activePlayId);
  }

  state.ratingPromptItems = promptItems;
  state.ratingPromptActiveTab = defaultTab;
  state.ratingPromptItem = activeItem;
  state.ratingPromptItemId = activePlayId;
  state.ratingPromptBvid = String(activeItem?.bvid || "").trim();
  state.ratingPromptScore = 5;
  state.ratingPromptSubmitted = false;
  state.ratingPromptCurrentRateable = currentRateable;
  state.ratingPromptPreviousRateable = previousRateable;

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
  const addUpButton = document.createElement("button");
  addUpButton.type = "button";
  addUpButton.className = "secondary-button";
  addUpButton.dataset.ratingAddUp = "";
  addUpButton.textContent = t("rating.addUp");
  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "primary-button";
  doneButton.dataset.ratingClose = "";
  doneButton.textContent = t("rating.done");
  const optOutButton = document.createElement("button");
  optOutButton.type = "button";
  optOutButton.className = "secondary-button";
  optOutButton.dataset.ratingOptOutBtn = "";
  optOutButton.textContent = t("rating.optOutBtn");
  actions.append(addUpButton, doneButton, optOutButton);

  const tabs = document.createElement("div");
  tabs.className = "rating-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("rating.dialogLabel"));
  const previousTab = document.createElement("button");
  previousTab.type = "button";
  previousTab.dataset.ratingTab = "previous";
  previousTab.setAttribute("role", "tab");
  previousTab.disabled = !previousRateable;
  previousTab.textContent = t("rating.previousTab");
  const currentTab = document.createElement("button");
  currentTab.type = "button";
  currentTab.dataset.ratingTab = "current";
  currentTab.setAttribute("role", "tab");
  currentTab.disabled = !currentRateable;
  currentTab.textContent = t("rating.currentTab");
  tabs.append(previousTab, currentTab);

  const message = document.createElement("p");
  message.className = "rating-message";
  message.dataset.ratingMessage = "";
  card.append(closeButton, content, stars, actions, tabs, message);
  root.append(backdrop, card);
  document.body.appendChild(root);
  state.ratingPromptElement = root;
  renderRatingPromptContent();
}

function currentPlaybackClockSeconds() {
  const durationSeconds = Math.max(0, Number(state.currentPlaybackClockDurationSeconds || 0));
  if (!(durationSeconds > 0)) {
    return { currentSeconds: 0, durationSeconds: 0 };
  }
  const baseSeconds = Math.max(0, Number(state.currentPlaybackClockBaseSeconds || 0));
  const elapsedSeconds = state.currentPlaybackClockPaused
    ? 0
    : Math.max(0, (Date.now() - Number(state.currentPlaybackClockStartedAt || Date.now())) / 1000);
  return {
    currentSeconds: Math.min(durationSeconds, baseSeconds + elapsedSeconds),
    durationSeconds,
  };
}

function flushPendingAutoRating(playId, itemData) {
  if (!playId) {
    return;
  }
  // itemData may be provided directly (when flushing from the queue, where
  // the item was already removed from pendingAutoRatings). Otherwise look
  // it up in pendingAutoRatings.
  let pending = itemData;
  if (!pending) {
    pending = state.pendingAutoRatings.get(playId);
    if (!pending) {
      ratingLog("flush: no pending for " + playId);
      return;
    }
    state.pendingAutoRatings.delete(playId);
  }
  // If the user already submitted a manual rating, skip the auto-rating.
  const submissionKey = ratingSubmissionKey({ ...pending.item, play_id: playId });
  if (submissionKey && state.ratingSubmittedKeys.has(submissionKey)) {
    ratingLog("flush: skipping " + playId + " (user already rated)");
    return;
  }
  ratingLog("flush: submitting auto score=5 for " + playId);
  submitSongRating(pending.item, 5);
}

function flushAllPendingAutoRatings() {
  // On session close, flush everything in order: the queue first, then any
  // remaining pending items (the current/last song).
  for (const entry of state.autoRatingFlushQueue.splice(0)) {
    flushPendingAutoRating(entry.playId, entry);
  }
  const playIds = Array.from(state.pendingAutoRatings.keys());
  for (const playId of playIds) {
    flushPendingAutoRating(playId);
  }
}

function maybeUpdateRemoteRatingPrompt(currentItem) {
  const promptItems = ratingPromptItemsForItem(currentItem);
  const currentRateable = isItemRateable(promptItems.current, true);
  const previousRateable = isItemRateable(promptItems.previous, false);

  if (elements.openRatingButton) {
    elements.openRatingButton.disabled = !currentRateable && !previousRateable;
  }

  // Handle live-update, tab switching, and auto-closing of an already-open rating modal.
  if (state.ratingPromptElement && state.ratingPromptItemId) {
    const currentPromptId = String(promptItems.current?.id || promptItems.current?.bvid || "").trim();
    const previousPromptId = String(promptItems.previous?.id || promptItems.previous?.bvid || "").trim();

    if (state.ratingPromptItemId === currentPromptId && currentRateable) {
      // The item being rated is still the current item, and is rateable.
      const tabsChanged =
        state.ratingPromptCurrentRateable !== currentRateable
        || state.ratingPromptPreviousRateable !== previousRateable;
      state.ratingPromptItems = promptItems;
      state.ratingPromptCurrentRateable = currentRateable;
      state.ratingPromptPreviousRateable = previousRateable;
      if (tabsChanged) {
        renderRatingPromptContent();
      }
    } else if (state.ratingPromptItemId === previousPromptId && previousRateable) {
      // The item being rated is the previous item, and is rateable.
      const needsTabTransition = state.ratingPromptActiveTab !== "previous";
      const tabsChanged =
        state.ratingPromptCurrentRateable !== currentRateable
        || state.ratingPromptPreviousRateable !== previousRateable;
      state.ratingPromptItems = promptItems;
      state.ratingPromptActiveTab = "previous";
      state.ratingPromptCurrentRateable = currentRateable;
      state.ratingPromptPreviousRateable = previousRateable;
      if (needsTabTransition || tabsChanged) {
        renderRatingPromptContent();
      }
    } else {
      // The item being rated is no longer rateable (neither current nor previous, or not rateable).
      closeRatingPrompt({ submit: false });
    }
  }

  const { currentSeconds, durationSeconds } = currentPlaybackClockSeconds();
  const bvid = String(currentItem?.bvid || "").trim();
  const playId = String(currentItem?.id || bvid).trim();
  // Detect song transition: when the current playId changes, move the
  // previous song's pending auto-rating into the flush queue, then flush
  // the queue head (the oldest un-rated song). Songs that the user already
  // manually rated are removed from the queue at submit time, so the head
  // is always a song that still needs its auto score=5.
  if (playId && state.ratingCurrentPlayId && state.ratingCurrentPlayId !== playId) {
    const prevPlayId = state.ratingCurrentPlayId;
    ratingLog("transition: " + prevPlayId + " -> " + playId
      + " pending=" + Array.from(state.pendingAutoRatings.keys()).join(",")
      + " queue=" + state.autoRatingFlushQueue.map((e) => e.playId).join(","));
    // Move the previous song's pending auto-rating into the flush queue.
    if (state.pendingAutoRatings.has(prevPlayId)) {
      const entry = state.pendingAutoRatings.get(prevPlayId);
      state.pendingAutoRatings.delete(prevPlayId);
      state.autoRatingFlushQueue.push(entry);
      ratingLog("moved " + prevPlayId + " to flush queue (len=" + state.autoRatingFlushQueue.length + ")");
    }
    // Flush the head of the queue — it's the oldest song that hasn't been
    // manually rated. If the user rated it, submitSongRating already removed
    // it from the queue, so the head is always a genuinely pending auto-rating.
    if (state.autoRatingFlushQueue.length > 0) {
      const headEntry = state.autoRatingFlushQueue.shift();
      flushPendingAutoRating(headEntry.playId, headEntry);
    }
  }
  if (playId) {
    state.ratingCurrentPlayId = playId;
  }

  if (!currentItem || !bvid || !playId || !(durationSeconds > 0)) {
    ratingLog("early return: playId=" + playId + " dur=" + durationSeconds + " cur=" + currentSeconds);
    return;
  }

  const ratio = currentSeconds / durationSeconds;
  if (ratio >= remoteRatingPromptThreshold && !state.ratingPromptSeenPlayIds.has(playId)) {
    ratingLog("threshold reached: playId=" + playId + " ratio=" + ratio.toFixed(2)
      + " seen=" + state.ratingPromptSeenPlayIds.has(playId));
  }
  if (ratio >= remoteRatingPromptThreshold) {
    // Mark as seen so the auto-prompt can fire, but do NOT auto-submit
    // score=5 immediately. Instead, queue it as a pending auto-rating
    // that will be flushed when the next song starts or on session close.
    // This gives the user time to manually rate first.
    if (!state.ratingPromptSeenPlayIds.has(playId)) {
      state.ratingPromptSeenPlayIds.add(playId);
      const ratingItem = { ...currentItem, play_id: playId };
      const submissionKey = ratingSubmissionKey({ ...ratingItem, play_id: playId });
      // Only queue if the user hasn't already submitted a manual rating.
      if (!submissionKey || !state.ratingSubmittedKeys.has(submissionKey)) {
        state.pendingAutoRatings.set(playId, { item: ratingItem, playId });
        ratingLog("queued pending auto for " + playId
          + " pending=" + Array.from(state.pendingAutoRatings.keys()).join(","));
      }
    }
  }
}

function selectedHistoryExportSource() {
  return String(elements.historyExportSource?.value || "played").trim();
}

function selectedHistoryExportPageSize() {
  const pageSize = Number.parseInt(String(elements.historyExportPageSize?.value || "200"), 10);
  return [200, 150, 100, 80, 60, 50].includes(pageSize) ? pageSize : 200;
}

async function downloadHistoryExport(format, source = selectedHistoryExportSource(), pageSize = selectedHistoryExportPageSize()) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  const normalizedSource = source;
  const requestedPageSize = Number.parseInt(String(pageSize || "200"), 10);
  const normalizedPageSize = [200, 150, 100, 80, 60, 50].includes(requestedPageSize) ? requestedPageSize : 200;
  if (!["csv", "image"].includes(normalizedFormat)) {
    return;
  }
  const params = new URLSearchParams({
    format: normalizedFormat,
    source: normalizedSource,
    page_size: String(normalizedPageSize),
  });
  const exportUrl = `/api/playlist/export?${params.toString()}`;
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
  });
}

elements.openRatingButton?.addEventListener("click", () => {
  if (state.data?.current_item) {
    openRatingPrompt(state.data.current_item, { manual: true });
  }
});

async function exportHistory(format) {
  return historyExportGuard.run(async () => {
    const source = selectedHistoryExportSource();
    const pageSize = selectedHistoryExportPageSize();
    const sourceLabel = source === "played" ? t("history.playedSource") : t("history.allSource");
    setAppMessage(format === "csv"
      ? t("remote.exportingCsv", { source: sourceLabel })
      : t("remote.exportingImagePaged", { source: sourceLabel, count: pageSize }));
    try {
      const saved = await downloadHistoryExport(format, source, pageSize);
      if (!saved) {
        setAppMessage("");
        return;
      }
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

async function fetchState(options = {}) {
  const { force = true } = options;
  const response = await fetch("/api/state", { headers: clientHeaders() });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(localizedApiMessage(payload.error) || t("error.stateFailed"));
  }
  applyStateSnapshot(payload.data, { forceRender: force || !state.data });
  noteRemoteFallbackSuccess();
}

function clearRemoteConnectionOfflineTimer() {
  if (state.remoteConnectionOfflineTimer === null || state.remoteConnectionOfflineTimer === undefined) {
    return;
  }
  window.clearTimeout(state.remoteConnectionOfflineTimer);
  state.remoteConnectionOfflineTimer = null;
}

function remoteIssueSignatureSet() {
  if (!(state.remoteIssueSignatures instanceof Set)) {
    state.remoteIssueSignatures = new Set();
  }
  return state.remoteIssueSignatures;
}

function reportRemoteIssue(signature, message, isError = true) {
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSignature || remoteIssueSignatureSet().has(normalizedSignature)) {
    return false;
  }
  remoteIssueSignatureSet().add(normalizedSignature);
  if (typeof setAppMessage === "function") {
    setAppMessage(message, isError);
  }
  return true;
}

function clearRemoteIssue(signature) {
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSignature) {
    return false;
  }
  return remoteIssueSignatureSet().delete(normalizedSignature);
}

function clearRemoteIssueByPrefix(prefix, keepSignature = "") {
  const normalizedPrefix = String(prefix || "").trim();
  const normalizedKeepSignature = String(keepSignature || "").trim();
  if (!normalizedPrefix) {
    return 0;
  }
  let cleared = 0;
  for (const signature of remoteIssueSignatureSet()) {
    if (
      signature !== normalizedKeepSignature
      && (signature === normalizedPrefix || signature.startsWith(`${normalizedPrefix}:`))
    ) {
      remoteIssueSignatureSet().delete(signature);
      cleared += 1;
    }
  }
  return cleared;
}

function noteRemoteFallbackSuccess() {
  clearRemoteConnectionOfflineTimer();
  state.remoteConnectionFailureStartedAt = null;
  clearRemoteIssue("remote-connection-offline");
  if (!state.eventStreamHealthy && typeof setRemoteConnectionPhase === "function") {
    setRemoteConnectionPhase(remoteConnectionRecoveryPhase());
  }
}

function clearStateFallbackTimer() {
  if (!state.autoRefreshTimer) {
    return;
  }
  window.clearTimeout(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function scheduleStateFallbackRefresh(delayMs = stateFallbackRefreshMs) {
  if (
    state.eventStreamHealthy
    || state.autoRefreshTimer
    || state.stateFallbackFetchInFlight
  ) {
    return;
  }
  const boundedDelayMs = Math.max(
    stateFallbackRefreshMs,
    Number(delayMs) || stateFallbackRefreshMs,
  );
  state.autoRefreshTimer = window.setTimeout(() => {
    state.autoRefreshTimer = null;
    return refreshCacheStatusOnly();
  }, boundedDelayMs);
}

async function refreshCacheStatusOnly() {
  if (state.eventStreamHealthy || state.stateFallbackFetchInFlight) {
    return;
  }
  state.stateFallbackFetchInFlight = true;
  try {
    await fetchState({ force: false });
  } catch (e) {
    noteRemoteFallbackFailure();
  } finally {
    state.stateFallbackFetchInFlight = false;
    if (!state.eventStreamHealthy) {
      scheduleStateFallbackRefresh();
    }
  }
}

function armRemoteConnectionOfflineGrace() {
  if (
    state.remoteConnectionOfflineTimer !== null
    && state.remoteConnectionOfflineTimer !== undefined
  ) {
    return;
  }
  if (state.remoteConnectionFailureStartedAt === null || state.remoteConnectionFailureStartedAt === undefined) {
    return;
  }
  const graceMs = typeof remoteConnectionOfflineGraceMs === "number"
    ? remoteConnectionOfflineGraceMs
    : 3000;
  const startedAt = state.remoteConnectionFailureStartedAt;
  state.remoteConnectionOfflineTimer = window.setTimeout(() => {
    state.remoteConnectionOfflineTimer = null;
    if (
      state.eventStreamHealthy
      || state.remoteConnectionFailureStartedAt !== startedAt
    ) {
      return;
    }
    if (typeof setRemoteConnectionPhase === "function") {
      setRemoteConnectionPhase("offline");
    }
    reportRemoteIssue("remote-connection-offline", t("remote.connectionOfflineToast"));
  }, graceMs);
}

function noteRemoteFallbackFailure() {
  if (state.eventStreamHealthy) {
    return;
  }
  if (remoteIssueSignatureSet().has("remote-connection-offline")) {
    if (typeof setRemoteConnectionPhase === "function") {
      setRemoteConnectionPhase("offline");
    }
    return;
  }
  if (state.remoteConnectionFailureStartedAt === null || state.remoteConnectionFailureStartedAt === undefined) {
    state.remoteConnectionFailureStartedAt = Date.now();
  }
  if (typeof setRemoteConnectionPhase === "function") {
    setRemoteConnectionPhase(remoteConnectionRecoveryPhase());
  }
  armRemoteConnectionOfflineGrace();
}

function currentStateRevision(snapshot = state.data) {
  const revision = Number(snapshot?.state_revision || 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

const CACHE_VOLATILE_ITEM_KEYS = new Set([
  "cache_activity_at",
  "cache_download_current_bytes",
  "cache_download_total_bytes",
  "cache_download_tracks",
  "cache_message",
  "cache_progress",
  "cache_size_bytes",
]);

function stableItemForRenderSignature(item) {
  if (!item || typeof item !== "object") {
    return item || null;
  }
  const stableItem = { ...item };
  CACHE_VOLATILE_ITEM_KEYS.forEach((key) => {
    delete stableItem[key];
  });
  return stableItem;
}

function stableSnapshotForRenderSignature(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const {
    app_update: _appUpdate,
    bbdown: _bbdown,
    cache_policy: _cachePolicy,
    ffmpeg: _ffmpeg,
    player_status: _playerStatus,
    state_revision: _stateRevision,
    updated_at: _updatedAt,
    ...renderedData
  } = snapshot;
  return {
    ...renderedData,
    current_item: stableItemForRenderSignature(renderedData.current_item),
    playlist: Array.isArray(renderedData.playlist)
      ? renderedData.playlist.map(stableItemForRenderSignature)
      : renderedData.playlist,
  };
}

function renderSignatureForSnapshot(snapshot) {
  const stableSnapshot = stableSnapshotForRenderSignature(snapshot);
  return stableSnapshot ? JSON.stringify(stableSnapshot) : "";
}

function playerStatusSignature(snapshot) {
  return JSON.stringify(snapshot?.player_status || null);
}

function scheduleRender() {
  if (state.renderDebounceTimer) {
    clearTimeout(state.renderDebounceTimer);
  }
  state.renderDebounceTimer = setTimeout(() => {
    state.renderDebounceTimer = null;
    render();
  }, 50);
}

function renderPlaybackStatusOnly() {
  const currentItem = state.data?.current_item;
  if (!currentItem) {
    return;
  }
  renderCurrentPlaybackState(currentItem);
  renderPlayerControls(currentItem, frontendPlaybackMode(state.data?.playback_mode));
}

function renderCacheStatusOnly(previousSnapshot = null) {
  const currentItem = state.data?.current_item;
  if (currentItem) {
    renderCurrentPlaybackState(currentItem);
  }
  renderQueueCacheStatus(Array.isArray(state.data?.playlist) ? state.data.playlist : []);
  if (playerStatusSignature(previousSnapshot) !== playerStatusSignature(state.data)) {
    renderPlayerControls(currentItem, frontendPlaybackMode(state.data?.playback_mode));
  }
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
  const previousSnapshot = state.data;
  const nextRenderSignature = renderSignatureForSnapshot(snapshot);
  const shouldRender = forceRender
    || !state.data
    || nextRenderSignature !== state.dataRenderSignature;
  state.data = snapshot;
  const programChanged = Boolean(
    previousSnapshot
    && previousSnapshot.playback_generation !== snapshot.playback_generation
  );
  if (programChanged || !currentPlayerStatus(snapshot.current_item, snapshot)) {
    clearCurrentPlaybackClock();
  }
  syncRemoteIdentityWithSnapshot(snapshot);
  scheduleFavlistBrowseReloadFromState(previousSnapshot, snapshot);

  // 简单的渲染防抖，合并 50ms 内的多次状态变更（如切歌时的密集事件）
  if (shouldRender) {
    state.dataRenderSignature = nextRenderSignature;
    scheduleRender();
  } else if (!state.renderDebounceTimer) {
    renderCacheStatusOnly(previousSnapshot);
  }

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
  state.eventStreamHealthy = false;
  if (!state.eventSource) {
    return;
  }
  state.eventSource.close();
  state.eventSource = null;
}

function eventStreamReconnectDelayMs(baseDelayMs, randomValue = Math.random()) {
  const baseDelay = Math.max(
    eventStreamInitialRetryMs,
    Math.min(eventStreamMaxRetryMs, Number(baseDelayMs) || eventStreamInitialRetryMs),
  );
  const jitterSpan = Math.max(250, Math.round(baseDelay * eventStreamRetryJitterRatio));
  const lowerBound = baseDelay >= eventStreamMaxRetryMs
    ? Math.max(eventStreamInitialRetryMs, baseDelay - jitterSpan)
    : baseDelay;
  const upperBound = baseDelay >= eventStreamMaxRetryMs
    ? baseDelay
    : Math.min(eventStreamMaxRetryMs, baseDelay + jitterSpan);
  const boundedRandom = Math.max(0, Math.min(1, Number(randomValue) || 0));
  return Math.round(lowerBound + ((upperBound - lowerBound) * boundedRandom));
}

function scheduleEventStreamReconnect() {
  clearEventStreamReconnectTimer();
  const baseDelayMs = state.eventStreamRetryMs;
  const delayMs = eventStreamReconnectDelayMs(baseDelayMs);
  state.eventStreamReconnectTimer = window.setTimeout(() => {
    state.eventStreamReconnectTimer = null;
    connectStateStream();
  }, delayMs);
  state.eventStreamRetryMs = Math.min(eventStreamMaxRetryMs, baseDelayMs * 2);
  return delayMs;
}

function eventStreamStateIsCurrent(snapshot) {
  if (
    !snapshot
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !Object.prototype.hasOwnProperty.call(snapshot, "state_revision")
  ) {
    return false;
  }
  const nextRevision = Number(snapshot.state_revision);
  if (!Number.isFinite(nextRevision) || nextRevision < 0) {
    return false;
  }
  return !state.data || nextRevision >= currentStateRevision();
}

function remoteConnectionRecoveryPhase() {
  return state.remoteConnectionPhase === "connecting" && !state.eventStreamHealthy
    ? "connecting"
    : "reconnecting";
}

function connectStateStream() {
  const recoveryPhase = remoteConnectionRecoveryPhase();
  if (typeof window.EventSource !== "function") {
    state.eventStreamHealthy = false;
    if (typeof setRemoteConnectionPhase === "function") {
      setRemoteConnectionPhase(recoveryPhase);
    }
    scheduleStateFallbackRefresh();
    return;
  }
  closeEventStream();
  if (typeof setRemoteConnectionPhase === "function") {
    setRemoteConnectionPhase(recoveryPhase);
  }
  const source = new window.EventSource(`/api/events?client_id=${encodeURIComponent(state.clientId)}`);
  state.eventSource = source;
  scheduleStateFallbackRefresh();

  source.addEventListener("state", (event) => {
    if (state.eventSource !== source) {
      return;
    }
    try {
      const snapshot = JSON.parse(event.data);
      const confirmsCurrentState = eventStreamStateIsCurrent(snapshot);
      applyStateSnapshot(snapshot);
      if (!confirmsCurrentState) {
        return;
      }
      state.eventStreamHealthy = true;
      state.eventStreamRetryMs = eventStreamInitialRetryMs;
      clearStateFallbackTimer();
      clearRemoteConnectionOfflineTimer();
      state.remoteConnectionFailureStartedAt = null;
      clearRemoteIssue("remote-connection-offline");
      if (typeof setRemoteConnectionPhase === "function") {
        setRemoteConnectionPhase("connected");
      }
    } catch {
      // Ignore malformed events and wait for the next valid snapshot.
    }
  });

  source.addEventListener("error", () => {
    if (state.eventSource !== source) {
      return;
    }
    const nextPhase = remoteConnectionRecoveryPhase();
    closeEventStream();
    if (typeof setRemoteConnectionPhase === "function") {
      setRemoteConnectionPhase(nextPhase);
    }
    const reconnectDelayMs = scheduleEventStreamReconnect();
    scheduleStateFallbackRefresh(reconnectDelayMs + stateFallbackRefreshMs);
  });
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

function gatchaUidResultMessage(result, fallbackUid = "") {
  const cache = result?.cache || {};
  const addedCount = Number(cache.added_count || 0);
  const totalCount = Number(cache.total_count || 0);
  const modeLabel = cache.mode === "incremental" ? t("gatcha.latestMode") : t("gatcha.allMode");
  const ownerLabel = result?.name ? t("gatcha.ownerName", { name: result.name }) : `UID ${result?.uid || fallbackUid}`;
  const listAction = result?.added ? t("gatcha.addedToFollow") : t("gatcha.alreadyFollowed");
  return t("gatcha.uidResult", {
    owner: ownerLabel,
    action: listAction,
    mode: modeLabel,
    added: addedCount,
    total: totalCount,
  });
}

function hideSearchResults() {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.add("hidden");
}

function hideLarkSearchResults() {
  if (!elements.larkSearchResults) {
    return;
  }
  elements.larkSearchResults.innerHTML = "";
  elements.larkSearchResults.classList.add("hidden");
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

  return line;
}

function renderSearchResults(items) {
  elements.searchResults.innerHTML = "";
  elements.searchResults.classList.remove("hidden");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = t("search.empty");
    elements.searchResults.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "search-result-item";
    searchResultItemByElement.set(row, item);

    const meta = document.createElement("div");
    meta.className = "search-result-meta";

    const title = document.createElement("div");
    title.className = "search-result-title";
    title.textContent = String(item.title || "");

    const url = createSearchResultUrlLine(item);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.dataset.url = String(item.url || "");
    button.textContent = t("search.add");

    meta.append(title, url);
    row.append(meta, button);
    elements.searchResults.appendChild(row);
  });
}

function renderLarkSearchResults(items) {
  if (!elements.larkSearchResults) {
    return;
  }
  elements.larkSearchResults.innerHTML = "";
  elements.larkSearchResults.classList.remove("hidden");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = t("search.larkNoResults");
    elements.larkSearchResults.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "search-result-item";
    searchResultItemByElement.set(row, item);

    const meta = document.createElement("div");
    meta.className = "search-result-meta";
    const title = document.createElement("div");
    title.className = "search-result-title";
    title.textContent = String(item.title || "");

    const url = createSearchResultUrlLine(item);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.dataset.url = String(item.url || "");
    button.textContent = t("search.add");

    meta.append(title, url);
    row.append(meta, button);
    elements.larkSearchResults.appendChild(row);
  });
}

function appendLarkSearchResults(items) {
  if (!elements.larkSearchResults || !items.length) {
    return;
  }
  const existingEmpty = elements.larkSearchResults.querySelector(".search-empty");
  if (existingEmpty) {
    existingEmpty.remove();
  }
  elements.larkSearchResults.classList.remove("hidden");
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "search-result-item";
    searchResultItemByElement.set(row, item);

    const meta = document.createElement("div");
    meta.className = "search-result-meta";
    const title = document.createElement("div");
    title.className = "search-result-title";
    title.textContent = String(item.title || "");

    const url = createSearchResultUrlLine(item);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.dataset.url = String(item.url || "");
    button.textContent = t("search.add");

    meta.append(title, url);
    row.append(meta, button);
    elements.larkSearchResults.appendChild(row);
  });
}

function setModalFollowBrowseMessage(message, isError = false) {
  if (!elements.modalFollowBrowseMessage) {
    return;
  }
  elements.modalFollowBrowseMessage.textContent = message || "";
  elements.modalFollowBrowseMessage.classList.toggle("is-error", Boolean(isError));
  elements.modalFollowBrowseMessage.classList.toggle("hidden", !message);
}

function setFavlistBrowseMessage(message, isError = false) {
  if (!elements.favlistBrowseMessage) {
    return;
  }
  elements.favlistBrowseMessage.textContent = message || "";
  elements.favlistBrowseMessage.classList.toggle("is-error", Boolean(isError));
  elements.favlistBrowseMessage.classList.toggle("hidden", !message);
}

function setGatchaUidFlowMessage(target, message, isError = false) {
  if (target === "follow-modal") {
    setModalFollowBrowseMessage(message, isError);
    return;
  }
  if (target === "favlist-modal") {
    setFavlistBrowseMessage(message, isError);
    return;
  }
  setGatchaUidMessage(message, isError);
}

function appendSearchResultCoverFallback(cover, item, stateName) {
  const fallback = document.createElement("span");
  fallback.className = "search-result-cover-fallback";
  fallback.textContent = String(item?.bvid || "Bili");
  cover.appendChild(fallback);
  cover.classList.add("is-empty");
  cover.classList.toggle("is-error", stateName === "error");
  cover.dataset.coverState = stateName;
}

function createSearchResultCover(item, { eagerCover = false } = {}) {
  const coverUrl = searchResultCoverUrl(item);
  const cover = document.createElement("div");
  cover.className = "search-result-cover";
  if (coverUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = eagerCover ? "eager" : "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    cover.dataset.coverState = "loading";
    image.onload = () => {
      cover.dataset.coverState = "loaded";
    };
    image.onerror = () => {
      if (cover.dataset.coverState === "error") {
        return;
      }
      image.remove();
      appendSearchResultCoverFallback(cover, item, "error");
    };
    cover.appendChild(image);
    image.src = coverUrl;
  } else {
    appendSearchResultCoverFallback(cover, item, "missing");
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
  return cover;
}

function createSearchResultRow(item, { eagerCover = false } = {}) {
  const row = document.createElement("article");
  row.className = "search-result-item";
  searchResultItemByElement.set(row, item);
  const itemUrl = String(item?.url || "").trim();
  if (itemUrl) {
    row.dataset.url = itemUrl;
  }

  const cover = createSearchResultCover(item, { eagerCover });

  const meta = document.createElement("div");
  meta.className = "search-result-meta search-result-body";
  const title = document.createElement("div");
  title.className = "search-result-title";
  title.textContent = String(item?.title || "");

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
  button.className = "primary-button search-result-add";
  button.dataset.url = itemUrl;
  button.textContent = t("search.detail");

  meta.append(title);
  if (statusLine.children.length) {
    meta.appendChild(statusLine);
  }
  meta.appendChild(url);
  row.append(cover, meta, button);
  return row;
}

function renderSearchResultItems(container, items, emptyText = "") {
  if (!container) {
    return;
  }
  const normalizedItems = Array.isArray(items) ? items : [];
  container.innerHTML = "";
  container.classList.remove("hidden");
  if (!normalizedItems.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = emptyText || t("search.empty");
    container.appendChild(empty);
    return;
  }
  normalizedItems.forEach((item, index) => {
    container.appendChild(createSearchResultRow(item, {
      eagerCover: index < expandedSearchEagerCoverCount,
    }));
  });
}

function appendSearchResultItems(container, items) {
  if (!container || !Array.isArray(items) || !items.length) {
    return;
  }
  const existingEmpty = container.querySelector(".search-empty");
  if (existingEmpty) {
    existingEmpty.remove();
  }
  container.classList.remove("hidden");
  items.forEach((item) => {
    container.appendChild(createSearchResultRow(item));
  });
}

const canonicalBilikaraSearch = {
  query: "",
  items: [],
  message: "",
  isError: false,
  hasSearched: false,
  seq: 0,
  loading: false,
};

function syncBilikaraSearchView() {
  const query = canonicalBilikaraSearch.query;
  const items = canonicalBilikaraSearch.items;
  const message = canonicalBilikaraSearch.message;
  const isError = canonicalBilikaraSearch.isError;
  const hasSearched = canonicalBilikaraSearch.hasSearched;
  const loading = canonicalBilikaraSearch.loading;

  if (elements.larkSearchQuery && elements.larkSearchQuery.value !== query) {
    elements.larkSearchQuery.value = query;
  }

  setLarkSearchMessage(message, isError);

  if (elements.larkSearchResults) {
    if ((loading && !items.length) || (!hasSearched && !items.length && !message)) {
      elements.larkSearchResults.innerHTML = "";
      elements.larkSearchResults.classList.add("hidden");
    } else {
      renderLarkSearchResults(items);
    }
  }
}

async function executeCanonicalBilikaraSearch(queryStr) {
  const query = String(queryStr || "").trim();
  if (!query) {
    canonicalBilikaraSearch.query = "";
    canonicalBilikaraSearch.items = [];
    canonicalBilikaraSearch.message = t("search.keywordRequired");
    canonicalBilikaraSearch.isError = true;
    canonicalBilikaraSearch.hasSearched = false;
    syncBilikaraSearchView();
    return;
  }

  const searchSeq = canonicalBilikaraSearch.seq + 1;
  canonicalBilikaraSearch.seq = searchSeq;
  canonicalBilikaraSearch.query = query;
  canonicalBilikaraSearch.loading = true;
  canonicalBilikaraSearch.message = t("search.larkSearching");
  canonicalBilikaraSearch.isError = false;
  canonicalBilikaraSearch.hasSearched = true;
  syncBilikaraSearchView();

  if (elements.larkSearchButton) elements.larkSearchButton.disabled = true;

  try {
    const poolItems = await searchLarkPool(query);
    if (canonicalBilikaraSearch.seq !== searchSeq) {
      return;
    }
    const seenBvids = new Set();
    const freshItems = poolItems.filter((item) => {
      const bvid = String(item?.bvid || "").trim();
      if (!bvid || seenBvids.has(bvid)) {
        return false;
      }
      seenBvids.add(bvid);
      return true;
    });

    canonicalBilikaraSearch.items = freshItems;
    canonicalBilikaraSearch.message = freshItems.length
      ? t("search.larkFound", { count: freshItems.length })
      : t("search.larkNoResults");
    canonicalBilikaraSearch.isError = false;
  } catch (error) {
    if (canonicalBilikaraSearch.seq !== searchSeq) {
      return;
    }
    canonicalBilikaraSearch.items = [];
    canonicalBilikaraSearch.message = error.message || t("error.larkSearchFailed");
    canonicalBilikaraSearch.isError = true;
  } finally {
    if (canonicalBilikaraSearch.seq === searchSeq) {
      canonicalBilikaraSearch.loading = false;
      if (elements.larkSearchButton) elements.larkSearchButton.disabled = false;
      syncBilikaraSearchView();
    }
  }
}

function d1BrowseTitle(kind = state.d1BrowseKind) {
  return kind === "artist" ? t("search.artistBrowse") : t("search.nameBrowse");
}

function d1BrowsePickLetterText(kind = state.d1BrowseKind) {
  return kind === "artist" ? t("search.browsePickArtistLetter") : t("search.browsePickLetter");
}

function d1BrowseSearchPlaceholder(kind = state.d1BrowseKind) {
  return state.d1BrowseTag ? t("search.browseItemPlaceholder") : t("search.tagBrowsePlaceholder", { title: d1BrowseTitle(kind) });
}

function d1BrowseItemKey(item) {
  return String(item?.bvid || item?.url || item?.id || `${item?.title || ""}\n${searchResultOwnerName(item)}`).trim();
}

function categoryBrowseIdForName(name) {
  return encodeURIComponent(String(name || "").trim()).replace(/%/g, "_");
}

function categoryBrowseDefinitions() {
  const groups = [];
  const byKey = new Map();
  categoryBrowseDefinitionsRaw.forEach((definition) => {
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
        coverUrl: categoryBrowseImageUrls[imageIndex] || "",
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
  if (!elements.searchModalOtherView) {
    return null;
  }
  elements.searchModalOtherView.classList.add("remote-search-browser-view");
  let view = elements.searchModalOtherView.querySelector("[data-d1-browse-view]");
  if (view) {
    return view;
  }
  elements.searchModalOtherView.textContent = "";
  view = document.createElement("div");
  view.className = "tag-browser";
  view.dataset.d1BrowseView = "1";
  view.innerHTML = `
    <form class="tag-browser-search" data-d1-browse-search>
      <input type="text" autocomplete="off" data-d1-browse-query>
      <button type="submit" class="primary-button" data-d1-browse-submit></button>
    </form>
    <div class="tag-browser-alphabet" data-d1-browse-alphabet></div>
    <div class="tag-browser-nav">
      <button type="button" class="secondary-button tag-browser-back hidden" data-d1-browse-back></button>
      <div class="tag-browser-current" data-d1-browse-current></div>
    </div>
    <div class="tag-browser-tags" data-d1-browse-tags></div>
    <div class="search-results hidden" data-d1-browse-results></div>
    <p class="gatcha-message tag-browser-message" data-d1-browse-message role="status"></p>
  `;
  elements.searchModalOtherView.appendChild(view);
  return view;
}

function renderD1BrowseView() {
  const view = ensureD1BrowseView();
  if (!view) {
    return;
  }
  const kind = state.d1BrowseKind || "name";
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
  }
  if (alphabet) {
    alphabet.innerHTML = "";
    alphabet.classList.toggle("hidden", Boolean(state.d1BrowseLetter));
    d1BrowseLetters.forEach((letter) => {
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
  view.classList.toggle("has-letter", Boolean(state.d1BrowseLetter));
  view.classList.toggle("has-tag", Boolean(state.d1BrowseTag));
  if (backButton) {
    backButton.textContent = t("common.back");
    backButton.classList.toggle("hidden", !state.d1BrowseLetter);
    backButton.disabled = state.d1BrowseLoading;
  }

  const tags = Array.isArray(state.d1BrowseData?.tags) ? state.d1BrowseData.tags : [];
  const items = Array.isArray(state.d1BrowseData?.items) ? state.d1BrowseData.items : [];
  if (current) {
    const parts = [title];
    if (state.d1BrowseLetter) {
      parts.push(state.d1BrowseLetter);
    }
    if (state.d1BrowseTag) {
      parts.push(state.d1BrowseTag);
    }
    current.textContent = parts.join(" / ");
  }
  if (tagGrid) {
    tagGrid.innerHTML = "";
    tagGrid.classList.toggle("hidden", Boolean(state.d1BrowseTag));
    if (!state.d1BrowseTag) {
      if (state.d1BrowseLoading) {
        const loading = document.createElement("div");
        loading.className = "search-empty";
        loading.textContent = t("search.browseLoading");
        tagGrid.appendChild(loading);
      } else if (!state.d1BrowseLetter) {
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
    if (state.d1BrowseTag) {
      renderSearchResultItems(results, items, t("search.larkNoResults"));
    } else {
      results.innerHTML = "";
      results.classList.add("hidden");
    }
  }
  if (message) {
    let text = "";
    if (state.d1BrowseTag && !state.d1BrowseLoading) {
      text = items.length ? t("search.larkFound", { count: items.length }) : t("search.larkNoResults");
    } else if (!state.d1BrowseTag && tags.length) {
      text = t("search.browseTagsFound", { count: tags.length });
    }
    message.textContent = state.d1BrowseLoading ? t("search.browseLoading") : text;
    message.classList.toggle("is-error", false);
  }
}

async function loadD1Browse({ kind = state.d1BrowseKind || "name", letter = state.d1BrowseLetter, query = state.d1BrowseQuery, tag = "", locale = "" } = {}) {
  const searchSeq = state.d1BrowseSeq + 1;
  state.d1BrowseSeq = searchSeq;
  state.d1BrowseKind = kind === "artist" ? "artist" : "name";
  state.d1BrowseLetter = String(letter || "").trim().toUpperCase();
  state.d1BrowseQuery = String(query || "").trim();
  state.d1BrowseTag = String(tag || "").trim();
  state.d1BrowseLocale = String(locale || "").trim();
  state.d1BrowseLoading = true;
  renderD1BrowseView();
  try {
    const data = await fetchD1Browse({
      kind: state.d1BrowseKind,
      letter: state.d1BrowseLetter,
      query: state.d1BrowseQuery,
      tag: state.d1BrowseTag,
      locale: state.d1BrowseLocale,
      limit: state.d1BrowseTag ? d1BrowseItemLimit : d1BrowseTagLimit,
    });
    if (state.d1BrowseSeq !== searchSeq) {
      return;
    }
    state.d1BrowseData = data || {};
  } catch (error) {
    const view = ensureD1BrowseView();
    const message = view?.querySelector("[data-d1-browse-message]");
    if (message) {
      message.textContent = error.message;
      message.classList.add("is-error");
    }
  } finally {
    if (state.d1BrowseSeq === searchSeq) {
      state.d1BrowseLoading = false;
      renderD1BrowseView();
    }
  }
}

function ensureCategoryBrowseView() {
  if (!elements.searchModalOtherView) {
    return null;
  }
  elements.searchModalOtherView.classList.add("remote-search-browser-view");
  let view = elements.searchModalOtherView.querySelector("[data-category-browse-view]");
  if (view) {
    return view;
  }
  elements.searchModalOtherView.textContent = "";
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
        <button type="submit" class="primary-button" data-category-browse-submit></button>
      </form>
      <div class="category-browser-tabs" data-category-browser-tabs></div>
      <div class="tag-browser-nav">
        <button type="button" class="secondary-button tag-browser-back" data-category-browse-back></button>
        <div class="tag-browser-current hidden" data-category-browse-current></div>
      </div>
      <div class="search-results category-browser-results" data-category-browse-results></div>
      <p class="gatcha-message tag-browser-message" data-category-browse-message role="status"></p>
    </div>
  `;
  elements.searchModalOtherView.appendChild(view);
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
    const image = document.createElement("img");
    image.src = category.coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    media.appendChild(image);
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
  const selected = selectedCategoryBrowseDefinition();
  const home = view.querySelector("[data-category-browser-home]");
  const detail = view.querySelector("[data-category-browser-detail]");
  const grid = view.querySelector("[data-category-browser-grid]");
  const tabs = view.querySelector("[data-category-browser-tabs]");
  const queryInput = view.querySelector("[data-category-browse-query]");
  const submitButton = view.querySelector("[data-category-browse-submit]");
  const backButton = view.querySelector("[data-category-browse-back]");
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
    backButton.disabled = state.categoryBrowseLoading;
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
    state.categoryBrowseSelectedId = "";
    state.categoryBrowseItems = [];
    state.categoryBrowseOffset = 0;
    state.categoryBrowseHasMore = false;
    renderCategoryBrowseView();
    return;
  }
  const searchSeq = state.categoryBrowseSeq + 1;
  state.categoryBrowseSeq = searchSeq;
  state.categoryBrowseSelectedId = category.id;
  state.categoryBrowseQuery = String(query || "").trim();
  state.categoryBrowseError = "";
  if (!append) {
    state.categoryBrowseItems = [];
    state.categoryBrowseOffset = 0;
    state.categoryBrowseHasMore = true;
  }
  state.categoryBrowseLoading = true;
  renderCategoryBrowseView();
  try {
    const data = await fetchD1CategoryBrowse({
      tags: category.tags,
      query: state.categoryBrowseQuery,
      offset: append ? state.categoryBrowseOffset : 0,
      limit: categoryBrowsePageSize,
    });
    if (state.categoryBrowseSeq !== searchSeq) {
      return;
    }
    const nextItems = Array.isArray(data.items) ? data.items : [];
    state.categoryBrowseItems = append ? mergeCategoryBrowseItems(state.categoryBrowseItems, nextItems) : mergeCategoryBrowseItems([], nextItems);
    state.categoryBrowseHasMore = Boolean(data.has_more);
    state.categoryBrowseOffset = Number(data.next_offset ?? (append ? state.categoryBrowseOffset + nextItems.length : nextItems.length)) || state.categoryBrowseItems.length;
  } catch (error) {
    if (state.categoryBrowseSeq === searchSeq) {
      state.categoryBrowseError = error.message;
    }
  } finally {
    if (state.categoryBrowseSeq === searchSeq) {
      state.categoryBrowseLoading = false;
      renderCategoryBrowseView();
    }
  }
}

function maybeLoadMoreCategoryBrowse(scrollContainer) {
  if (
    !state.categoryBrowseSelectedId
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

function selectedFavlistFolder() {
  const folders = Array.isArray(state.favlistBrowseData?.folders) ? state.favlistBrowseData.folders : [];
  return folders.find((folder) => String(folder.id || "") === state.favlistBrowseSelectedFolderId) || null;
}

function renderFavlistBrowse() {
  if (!elements.favlistGrid || !elements.favlistSongResults) {
    return;
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
  state.favlistBrowseLoading = true;
  state.favlistBrowseSelectedFolderId = String(folderId || "").trim();
  renderFavlistBrowse();
  let caughtError = null;
  try {
    const nextData = await fetchGatchaFavlistBrowse(state.favlistBrowseSelectedFolderId, query);
    state.favlistBrowseData = nextData;
    state.favlistBrowseSelectedFolderId = String(
      nextData.selected_folder_id || state.favlistBrowseSelectedFolderId || "",
    );
    if (!keepQuery && elements.favlistSearchQuery) {
      elements.favlistSearchQuery.value = String(nextData.query || "");
    }
  } catch (error) {
    caughtError = error;
  } finally {
    state.favlistBrowseLoading = false;
    renderFavlistBrowse();
    if (caughtError) {
      setFavlistBrowseMessage(caughtError.message, true);
    }
  }
}

function normalizeSearchModalView(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return ["follow", "favlist", "category", "name", "artist"].includes(candidate)
    ? candidate
    : "follow";
}

function setSearchModalOpen(open) {
  const shouldOpen = Boolean(open);
  state.searchModalOpen = shouldOpen;
  if (shouldOpen) {
    window.clearTimeout(searchModalCloseTimer);
    searchModalCloseTimer = 0;
    elements.searchModal?.classList.remove("hidden", "closing");
    document.body.classList.add("remote-search-modal-open");
    renderSearchModalView(state.searchModalView);
    return;
  }
  searchDetailController?.close({ immediate: true });
  if (!elements.searchModal || elements.searchModal.classList.contains("hidden")) {
    document.body.classList.remove("remote-search-modal-open");
    return;
  }
  if (elements.searchModal.classList.contains("closing")) {
    return;
  }
  elements.searchModal.classList.add("closing");
  window.clearTimeout(searchModalCloseTimer);
  searchModalCloseTimer = window.setTimeout(() => {
    elements.searchModal?.classList.add("hidden");
    elements.searchModal?.classList.remove("closing");
    document.body.classList.remove("remote-search-modal-open");
    searchModalCloseTimer = 0;
  }, 220);
}

function openSearchResultDetail(event, container, source) {
  if (!searchDetailController || !container?.closest("#search-modal")) {
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
  const avatarUrl = window.BilikaraSongDetail.ownerAvatarFromCachedOwners(
    item,
    state.followBrowseData?.owners,
  );
  event.preventDefault();
  searchDetailController.open({
    ...item,
    avatar_url: avatarUrl,
    detailSource: source,
  });
  return true;
}

function initSearchDetailController() {
  if (searchDetailController || !window.BilikaraSongDetail) {
    return;
  }
  const container = elements.searchModal?.querySelector(".remote-search-modal-card");
  searchDetailController = window.BilikaraSongDetail.createSongDetailController({
    container,
    t,
    requestButtonClass: "primary-button",
    nextButtonClass: "secondary-button",
    onRequest: (url, position, item) => addByUrl(
      url,
      position,
      String(item?.detailSource || "modalBrowse"),
    ),
  });
}

function renderSearchModalView(target = state.searchModalView) {
  const nextTarget = normalizeSearchModalView(target);
  state.searchModalView = nextTarget;
  elements.searchModalTabs?.forEach((button) => {
    const selected = button.dataset.target === nextTarget;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const followActive = nextTarget === "follow";
  const favlistActive = nextTarget === "favlist";
  const otherActive = ["category", "name", "artist"].includes(nextTarget);
  elements.modalFollowBrowserView?.classList.toggle("hidden", !followActive);
  elements.favlistBrowserView?.classList.toggle("hidden", !favlistActive);
  elements.searchModalOtherView?.classList.toggle("hidden", !otherActive);
  setRemoteTabPanelVisibility(elements.modalFollowBrowserView, followActive);
  setRemoteTabPanelVisibility(elements.favlistBrowserView, favlistActive);
  setRemoteTabPanelVisibility(elements.searchModalOtherView, otherActive);
  if (otherActive) {
    elements.searchModalOtherView?.setAttribute("aria-labelledby", `search-modal-${nextTarget}-tab`);
  }

  if (nextTarget === "follow") {
    if (!state.followBrowseData && !state.followBrowseLoading) {
      state.followBrowseSelectedUid = "";
      if (elements.modalFollowSearchQuery) {
        elements.modalFollowSearchQuery.value = "";
      }
      loadFollowBrowse({ uid: "", query: "" });
    } else {
      renderModalFollowBrowse();
    }
    return;
  }
  if (nextTarget === "favlist") {
    if (!state.favlistBrowseData && !state.favlistBrowseLoading) {
      state.favlistBrowseSelectedFolderId = "";
      if (elements.favlistSearchQuery) {
        elements.favlistSearchQuery.value = "";
      }
      loadFavlistBrowse({ folderId: "", query: "" });
    } else {
      renderFavlistBrowse();
    }
    return;
  }
  if (nextTarget === "category") {
    renderCategoryBrowseView();
    return;
  }
  if (nextTarget === "name" || nextTarget === "artist") {
    if (state.d1BrowseKind !== nextTarget) {
      state.d1BrowseData = null;
      state.d1BrowseLetter = "";
      state.d1BrowseTag = "";
      state.d1BrowseLocale = "";
      state.d1BrowseQuery = "";
    }
    state.d1BrowseKind = nextTarget;
    renderD1BrowseView();
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
    state.favlistBrowseRenderSignature = "";
    loadFavlistBrowse({
      folderId: state.favlistBrowseSelectedFolderId,
      query: String(elements.favlistSearchQuery?.value || "").trim(),
      keepQuery: true,
    });
  }, 0);
}

function renderModalFollowBrowse() {
  if (!elements.modalFollowBrowserView || !elements.modalFollowUpGrid || !elements.modalFollowSongResults) {
    return;
  }

  const owners = Array.isArray(state.followBrowseData?.owners) ? state.followBrowseData.owners : [];
  const items = Array.isArray(state.followBrowseData?.items) ? state.followBrowseData.items : [];
  const taskBusy = gatchaTaskBusy();
  const signature = JSON.stringify({
    loading: state.followBrowseLoading,
    selected: state.followBrowseSelectedUid,
    owners,
    items,
    uidSaving: state.gatchaUidSaving,
    taskBusy,
    language: state.language,
  });
  if (signature === state.modalFollowBrowseRenderSignature) {
    return;
  }
  state.modalFollowBrowseRenderSignature = signature;

  const hasSelectedUid = Boolean(state.followBrowseSelectedUid);
  elements.modalFollowUpListView?.classList.toggle("hidden", hasSelectedUid);
  elements.modalFollowUpItemsView?.classList.toggle("hidden", !hasSelectedUid);
  if (elements.modalFollowUidInput) {
    elements.modalFollowUidInput.disabled = state.gatchaUidSaving || taskBusy;
  }
  if (elements.modalAddFollowUidButton) {
    elements.modalAddFollowUidButton.disabled = state.gatchaUidSaving || taskBusy;
    elements.modalAddFollowUidButton.textContent = taskBusy
      ? t("gatcha.globalCooldown")
      : state.gatchaUidSaving
        ? t("gatcha.adding")
        : t("gatcha.add");
  }

  if (!hasSelectedUid) {
    elements.modalFollowUpGrid.innerHTML = "";
    if (!owners.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = state.followBrowseLoading ? t("follow.loadingOwners") : t("follow.noOwners");
      elements.modalFollowUpGrid.appendChild(empty);
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

        elements.modalFollowUpGrid.appendChild(button);
      });
    }
    setModalFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingOwners") : "");
    return;
  }

  const owner = selectedFollowOwner();
  if (elements.modalFollowBrowseAvatar) {
    const avatarUrl = String(owner?.avatar_url || "").trim();
    elements.modalFollowBrowseAvatar.classList.toggle("hidden", !avatarUrl);
    if (avatarUrl) {
      elements.modalFollowBrowseAvatar.src = avatarUrl;
    } else {
      elements.modalFollowBrowseAvatar.removeAttribute("src");
    }
  }
  if (elements.modalFollowBrowseTitle) {
    elements.modalFollowBrowseTitle.textContent = followOwnerDisplayName(owner) || `UID ${state.followBrowseSelectedUid}`;
  }
  if (elements.modalFollowBrowseCount) {
    const totalCount = Number(owner?.count || items.length || 0);
    elements.modalFollowBrowseCount.textContent = t("follow.itemCount", { shown: items.length, total: totalCount });
  }
  renderSearchResultItems(
    elements.modalFollowSongResults,
    items,
    state.followBrowseLoading ? t("follow.loadingItems") : t("follow.noItems"),
  );
  setModalFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingItems") : "");
}

async function loadFollowBrowse({ uid = state.followBrowseSelectedUid, query = "", keepQuery = false } = {}) {
  state.followBrowseLoading = true;
  state.followBrowseSelectedUid = String(uid || "").trim();
  renderModalFollowBrowse();
  try {
    const nextData = await fetchGatchaBrowse(state.followBrowseSelectedUid, query);
    state.followBrowseData = nextData;
    state.followBrowseSelectedUid = String(nextData.selected_uid || state.followBrowseSelectedUid || "");
    if (!keepQuery && elements.modalFollowSearchQuery) {
      elements.modalFollowSearchQuery.value = String(nextData.query || "");
    }
  } catch (error) {
    setModalFollowBrowseMessage(error.message, true);
  } finally {
    state.followBrowseLoading = false;
    renderModalFollowBrowse();
  }
}

async function refreshFollowBrowseAfterGatchaUidAdd(uid = "") {
  state.modalFollowBrowseRenderSignature = "";
  const currentUid = String(state.followBrowseSelectedUid || "").trim();
  const nextUid = currentUid || String(uid || "").trim();
  await loadFollowBrowse({ uid: nextUid, query: "", keepQuery: false });
}

async function addGatchaUidFromInput(input, { messageTarget = "gatcha" } = {}) {
  const uid = String(input?.value || "").trim();
  if (!uid) {
    setGatchaUidFlowMessage(messageTarget, t("gatcha.uidRequired"), true);
    return;
  }
  if (state.gatchaUidSaving) {
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }

  state.gatchaUidSaving = true;
  renderGatchaUidView();
  setGatchaUidFlowMessage(messageTarget, t("gatcha.checkingUid"));
  try {
    const preview = await previewGatchaUid(uid);
    const ownerName = preview?.name || `UID ${preview?.uid || uid}`;
    const modeLabel = preview?.cache_mode === "incremental" ? t("gatcha.latestMode") : t("gatcha.allMode");
    const followedPrefix = preview?.already_followed ? t("gatcha.alreadyFollowedPrefix") : "";
    setGatchaUidFlowMessage(messageTarget, t("gatcha.detectedOwner", { prefix: followedPrefix, owner: ownerName }));

    if (!window.confirm(t("gatcha.confirmPullOwner", { owner: ownerName, mode: modeLabel }))) {
      setGatchaUidFlowMessage(messageTarget, t("remote.uidAddCancelled"));
      return;
    }

    const normalizedUid = preview?.uid || uid;
    if (gatchaTaskBusy()) {
      setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
      renderGatchaUidView();
      return;
    }
    setGatchaUidFlowMessage(messageTarget, t("gatcha.pullingOwnerItems", { name: ownerName }));
    const result = await addGatchaUid(normalizedUid);
    setGatchaUidFlowMessage(messageTarget, gatchaUidResultMessage(result, normalizedUid));
    if (input) {
      input.value = "";
    }
    await refreshFollowBrowseAfterGatchaUidAdd(result?.uid || normalizedUid);
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidView();
  }
}

async function previewGatchaFavlistFromInput(input, { messageTarget = "gatcha" } = {}) {
  const uid = String(input?.value || "").trim();
  if (!uid) {
    setGatchaUidFlowMessage(messageTarget, t("gatcha.uidRequired"), true);
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidFlowMessage(messageTarget, gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }
  state.gatchaFavlistSaving = true;
  renderGatchaUidView();
  setGatchaUidFlowMessage(messageTarget, t("gatcha.readingFavlists"));
  try {
    const result = await previewGatchaFavlist(uid);
    openGatchaFavlistSheet(result?.uid || uid, result, { messageTarget });
    setGatchaUidFlowMessage(messageTarget, t("gatcha.chooseFavlists"));
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaFavlistSaving = false;
    renderGatchaUidView();
  }
}

async function handleGatchaDraw() {
  state.gatchaUidVisible = false;
  renderGatchaUidView();
  setGatchaMessage(t("gatcha.drawing"));
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(localizedApiMessage(payload.error) || t("gatcha.drawFailed"));
    }

    state.gatchaCandidate = payload.data;
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
    renderGatchaUidView();
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
  elements.gatchaMessage.classList.toggle("hidden", !message);
}

function setGatchaUidMessage(message, isError = false) {
  if (!elements.gatchaUidMessage) {
    return;
  }
  elements.gatchaUidMessage.textContent = message || "";
  elements.gatchaUidMessage.classList.toggle("is-error", Boolean(isError));
  elements.gatchaUidMessage.classList.toggle("hidden", !message);
}

function syncGatchaMainContent(showUid, hasCandidate) {
  elements.gatchaInitView?.classList.toggle("hidden", showUid || hasCandidate);
  elements.gatchaResultView?.classList.toggle("hidden", showUid || !hasCandidate);
}

function renderGatchaUidView() {
  syncGatchaTaskTerminalMessage();
  const showUid = Boolean(state.gatchaUidVisible);
  const hasCandidate = Boolean(state.gatchaCandidate);
  const taskBusy = gatchaTaskBusy();
  if (elements.gatchaCandidateTitle && state.gatchaCandidate?.title) {
    elements.gatchaCandidateTitle.textContent = state.gatchaCandidate.title;
  }
  setGatchaStageView(showUid, () => {
    syncGatchaMainContent(showUid, hasCandidate);
  });
  if (elements.gatchaUidToggle) {
    elements.gatchaUidToggle.textContent = showUid ? t("gatcha.backToDraw") : t("gatcha.addUid");
    elements.gatchaUidToggle.setAttribute("aria-pressed", String(showUid));
  }
  if (elements.gatchaTag) {
    elements.gatchaTag.textContent = showUid ? t("gatcha.uidTag") : t("gatcha.tag");
  }
  if (elements.gatchaTitle) {
    elements.gatchaTitle.textContent = showUid ? t("gatcha.uidTitle") : t("gatcha.title");
  }
  if (elements.gatchaConfirmButton && !elements.gatchaConfirmButton.disabled) {
    elements.gatchaConfirmButton.textContent = t("gatcha.confirm");
  }
  if (elements.gatchaButton) {
    elements.gatchaButton.disabled = false;
    elements.gatchaButton.textContent = t("gatcha.title");
  }
  if (elements.gatchaRetryButton) {
    elements.gatchaRetryButton.disabled = false;
    elements.gatchaRetryButton.textContent = t("gatcha.retry");
  }
  if (elements.gatchaUidInput) {
    elements.gatchaUidInput.disabled = state.gatchaUidSaving;
  }
  if (elements.addGatchaUidButton) {
    elements.addGatchaUidButton.disabled = state.gatchaUidSaving || taskBusy;
    elements.addGatchaUidButton.textContent = state.gatchaUidSaving ? t("gatcha.adding") : t("gatcha.add");
  }
  if (elements.refreshGatchaCacheButton) {
    elements.refreshGatchaCacheButton.disabled = state.gatchaRefreshSaving || taskBusy;
    elements.refreshGatchaCacheButton.textContent = state.gatchaRefreshSaving ? t("gatcha.refreshing") : t("gatcha.refresh");
  }
  if (elements.pullGatchaFavlistButton) {
    elements.pullGatchaFavlistButton.disabled = state.gatchaFavlistSaving || taskBusy;
    elements.pullGatchaFavlistButton.textContent = state.gatchaFavlistSaving ? t("gatcha.pulling") : t("gatcha.pullFavlist");
  }
  if (elements.modalFavlistUidInput) {
    elements.modalFavlistUidInput.disabled = state.gatchaFavlistSaving || taskBusy;
  }
  if (elements.modalPullFavlistButton) {
    elements.modalPullFavlistButton.disabled = state.gatchaFavlistSaving || taskBusy;
    elements.modalPullFavlistButton.textContent = state.gatchaFavlistSaving ? t("gatcha.pulling") : t("gatcha.pullFavlist");
  }
  if (taskBusy) {
    if (elements.refreshGatchaCacheButton) {
      elements.refreshGatchaCacheButton.textContent = t("gatcha.globalCooldown");
    }
    if (elements.pullGatchaFavlistButton) {
      elements.pullGatchaFavlistButton.textContent = t("gatcha.globalCooldown");
    }
    if (elements.modalPullFavlistButton) {
      elements.modalPullFavlistButton.textContent = t("gatcha.globalCooldown");
    }
  }
  renderModalFollowBrowse();
}

async function handleGatchaUidSubmit(event) {
  event.preventDefault();
  await addGatchaUidFromInput(elements.gatchaUidInput, { messageTarget: "gatcha" });
}

function render() {
  const data = state.data;
  if (!data) {
    return;
  }
  const playbackMode = frontendPlaybackMode(data.playback_mode);

  renderRemoteIdentity();
  renderCurrentItem(data.current_item, playbackMode);
  renderCurrentRatingButton(data.current_item);
  renderAudioVariantBar(data.current_item, playbackMode);
  renderPlayerControls(data.current_item, playbackMode);
  renderRemoteAvSyncControls(playbackMode, data.player_settings);
  renderRemoteVolumeControls(playbackMode, data.player_settings);
  renderRemoteKeyShiftControls(playbackMode, data.player_settings);
  renderRemoteAccess(data.remote_access);
  renderModalFollowBrowse();
  renderListHeader(data.playlist || [], data.history || []);
  renderQueue(Array.isArray(data.playlist) ? data.playlist : []);
  renderHistory(Array.isArray(data.history) ? data.history : []);
  syncListView();
  syncRemoteRequestViewSelection();
  renderGatchaUidView();
  renderFloatingControlTrigger(data.current_item, playbackMode);
}

function frontendPlaybackMode(_mode) {
  return "local";
}

function renderCurrentItem(current, playbackMode) {
  if (current) {
    const requesterText = requesterBadgeText(current.requester_name);
    const ownerText = ownerLineText(current.owner_name);
    const nowPlayingSignature = JSON.stringify([
      current.id || "",
      current.display_title || "",
      requesterText,
      ownerText,
    ]);
    if (nowPlayingSignature !== state.currentNowPlayingSignature) {
      state.currentNowPlayingSignature = nowPlayingSignature;
      elements.currentTitle.textContent = current.display_title;
      elements.currentRequester.textContent = requesterText;
      elements.currentRequester.classList.toggle("hidden", !requesterText);
      renderOwnerBadgeLabel(elements.currentOwner, ownerText);
      elements.currentOwner.classList.toggle("hidden", !ownerText);
      if (elements.openRatingButton) {
        elements.openRatingButton.classList.toggle("hidden", !current.bvid);
      }
      elements.currentMeta.textContent = ""; // 不显示 log 避免高度抖动
    }

    renderCurrentPlaybackState(current);
    try {
      maybeUpdateRemoteRatingPrompt(current);
    } catch (error) {
      console.warn("Rating prompt update failed in renderCurrentItem:", error);
    }
    syncCurrentCacheState(current);

    elements.currentMeta.textContent = ""; // 不显示 log 避免高度抖动
    return;
  }

  if (state.currentNowPlayingSignature !== "__empty__") {
    state.currentNowPlayingSignature = "__empty__";
    clearCurrentPlaybackClock();
    elements.currentTitle.textContent = t("remote.noCurrentSong");
    elements.currentRequester.textContent = "";
    elements.currentRequester.classList.add("hidden");
    if (elements.openRatingButton) {
      elements.openRatingButton.classList.add("hidden");
    }
    if (elements.currentOwner) {
      elements.currentOwner.textContent = "";
      elements.currentOwner.classList.add("hidden");
    }
    syncCurrentCacheState(null);
    elements.currentMeta.textContent = t("remote.noCurrentHint");
  }
}

function renderCurrentRatingButton(current) {
  const button = elements.currentRatingButton;
  if (!button) {
    return;
  }
  const enabled = Boolean(current?.bvid);
  const submitted = enabled && hasSubmittedSongRating(current);
  button.disabled = !enabled || submitted;
  button.textContent = submitted ? t("rating.rated") : t("rating.rate");
  button.title = submitted ? t("rating.ratedTitle") : t("rating.rateTitle");
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
      // Remote controls only need to know whether split audio_url exists.
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
      renderAudioVariantBar(state.data.current_item, frontendPlaybackMode(state.data.playback_mode));
    }
  }, remainingMs);
}

function renderAudioVariantBar(currentItem, playbackMode) {
  if (playbackMode !== "local" || !currentItem) {
    elements.audioVariantBar.replaceChildren();
    elements.audioVariantBar.classList.add("hidden");
    state.audioVariantBarExpanded = false;
    state.audioVariantBarItemId = "";
    return;
  }

  const variants = partOptionsForItem(currentItem);
  if (variants.length <= 1) {
    elements.audioVariantBar.replaceChildren();
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
  toggleButton.setAttribute("aria-expanded", String(state.audioVariantBarExpanded));
  toggleButton.setAttribute("aria-label", state.audioVariantBarExpanded ? t("player.collapseParts") : t("player.expandParts"));
  const toggleIcon = document.createElement("span");
  toggleIcon.setAttribute("aria-hidden", "true");
  toggleIcon.textContent = "▾";
  toggleButton.appendChild(toggleIcon);

  elements.audioVariantBar.append(list, toggleButton);
  elements.audioVariantBar.classList.remove("hidden");

  requestAnimationFrame(() => {
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
  });
}

function boundedRemoteVolumePercent(volumePercent) {
  const numeric = Number(volumePercent);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function serverRemoteAvOffsetMs(playerSettings = state.data?.player_settings) {
  return Number(playerSettings?.av_delay?.effective_delay_ms ?? playerSettings?.av_offset_ms ?? 0);
}

function currentRemoteAvOffsetMs(playerSettings = state.data?.player_settings) {
  return serverRemoteAvOffsetMs(playerSettings);
}

function serverRemoteKeyShift(playerSettings = state.data?.player_settings) {
  return Math.max(-6, Math.min(6, Number(playerSettings?.key_shift ?? 0)));
}

function currentRemoteKeyShift(playerSettings = state.data?.player_settings) {
  if (state.remoteLocalKeyShift !== null && Date.now() < state.remoteKeyShiftEchoSuppressUntil) {
    return state.remoteLocalKeyShift;
  }
  state.remoteLocalKeyShift = null;
  return serverRemoteKeyShift(playerSettings);
}

function markRemoteKeyShiftWrite(keyShift) {
  state.remoteLocalKeyShift = Math.max(-6, Math.min(6, Number(keyShift || 0)));
  state.remoteKeyShiftEchoSuppressUntil = Date.now() + playerSettingsEchoSuppressMs;
  state.remoteKeyShiftSaveSeq += 1;
  return state.remoteKeyShiftSaveSeq;
}

async function setRemoteKeyShift(keyShift) {
  const boundedKeyShift = Math.max(-6, Math.min(6, Number(keyShift || 0)));
  const currentValue = currentRemoteKeyShift();
  if (boundedKeyShift === currentValue) {
    markRemoteKeyShiftWrite(boundedKeyShift);
    return;
  }

  const requestSeq = markRemoteKeyShiftWrite(boundedKeyShift);
  renderRemoteKeyShiftControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
  try {
    const nextData = await apiPost("/api/player/key-shift", { key_shift: boundedKeyShift });
    if (requestSeq !== state.remoteKeyShiftSaveSeq) {
      return;
    }
    applyStateSnapshot(nextData);
  } catch (error) {
    if (requestSeq !== state.remoteKeyShiftSaveSeq) {
      return;
    }
    state.remoteLocalKeyShift = null;
    state.remoteKeyShiftEchoSuppressUntil = 0;
    setFormMessage(error.message, true);
    renderRemoteKeyShiftControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
  }
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

function muteIcon(isMuted) {
  return isMuted ? "🔇" : "🔊";
}

function renderRemoteAvSyncControls(playbackMode, playerSettings) {
  if (!elements.remoteAvSyncPanel || !elements.remoteAvOffsetInput) {
    return;
  }
  const isLocalMode = playbackMode === "local";
  elements.remoteAvSyncPanel.classList.toggle("hidden", !isLocalMode);
  const offsetMs = currentRemoteAvOffsetMs(playerSettings);
  const delayState = playerSettings?.av_delay || {};
  elements.remoteAvOffsetInput.disabled = state.remoteAvDelaySaving;
  elements.remoteAvSyncPanel.querySelectorAll("button[data-av-step]").forEach((button) => {
    button.disabled = state.remoteAvDelaySaving;
  });
  if (elements.remoteAvOffsetResetButton) {
    elements.remoteAvOffsetResetButton.disabled = state.remoteAvDelaySaving || !Boolean(delayState.has_local_adjustment);
  }
  if (elements.remoteAvDelayLockButton) {
    const locked = Boolean(delayState.locked);
    const hasLocal = Boolean(delayState.has_local_adjustment);
    elements.remoteAvDelayLockButton.textContent = locked ? "🔒" : "🔓";
    elements.remoteAvDelayLockButton.disabled = state.remoteAvDelaySaving || !Boolean(delayState.lock_button_enabled);
    elements.remoteAvDelayLockButton.dataset.locked = String(locked);
    elements.remoteAvDelayLockButton.dataset.hasLocal = String(hasLocal);
    elements.remoteAvDelayLockButton.setAttribute("aria-pressed", String(locked));
    const labelKey = locked
      ? hasLocal ? "player.unlockAvDelayAdjusted" : "player.unlockAvDelay"
      : hasLocal ? "player.lockAvDelayAdjusted" : "player.lockAvDelay";
    elements.remoteAvDelayLockButton.setAttribute("aria-label", t(labelKey));
    elements.remoteAvDelayLockButton.title = t(labelKey);
  }
  if (document.activeElement !== elements.remoteAvOffsetInput || state.remoteAvDelaySaving) {
    elements.remoteAvOffsetInput.value = String(offsetMs);
  }
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
  setRangeFillPercent(elements.remoteVolumeSlider, volumePercent);
  elements.remoteVolumeValue.textContent = `${Math.round(volumePercent)}%`;
  const muteLabel = isMuted ? t("player.unmute") : t("player.mute");
  elements.remoteVolumeMuteButton.textContent = muteIcon(isMuted);
  elements.remoteVolumeMuteButton.setAttribute("aria-label", muteLabel);
  elements.remoteVolumeMuteButton.setAttribute("title", muteLabel);
  elements.remoteVolumeMuteButton.classList.toggle("is-muted", isMuted);
}

function renderRemoteKeyShiftControls(playbackMode, playerSettings) {
  if (!elements.remoteKeyShiftPanel || !elements.remoteKeyShiftInput) {
    return;
  }
  const isLocalMode = playbackMode === "local";
  elements.remoteKeyShiftPanel.classList.toggle("hidden", !isLocalMode);
  const keyShift = currentRemoteKeyShift(playerSettings);
  if (document.activeElement !== elements.remoteKeyShiftInput) {
    elements.remoteKeyShiftInput.value = String(keyShift);
  }
  if (elements.remoteKeyShiftResetButton) {
    elements.remoteKeyShiftResetButton.disabled = keyShift === 0;
  }
}

function openBindingSheet(intent, payload) {
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (!pages.length) {
    setFormMessage(t("binding.readFailed"), true);
    return;
  }
  state.bindingIntent = {
    ...intent,
    binding: payload,
  };
  elements.bindingSheetVideoOptions.innerHTML = "";
  elements.bindingSheetAudioOptions.innerHTML = "";
  state.bindingAccordion.video = false;
  state.bindingAccordion.audio = false;

  const preferredPage = Number(payload.preferred_page || pages[0]?.page || 1);
  pages.forEach((entry) => {
    elements.bindingSheetVideoOptions.appendChild(renderBindingOption("radio", "binding-video-page", entry, Number(entry.page) === preferredPage));
    elements.bindingSheetAudioOptions.appendChild(renderBindingOption("checkbox", "binding-audio-page", entry, false));
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

function selectedGatchaFavlistFolderIds() {
  return [...(elements.gatchaFavlistSheetOptions?.querySelectorAll('input[name="gatcha-favlist-folder"]:checked') || [])]
    .map((input) => String(input.value || "").trim())
    .filter(Boolean);
}

function renderGatchaFavlistOption(folder) {
  const label = document.createElement("label");
  label.className = "binding-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "gatcha-favlist-folder";
  input.value = String(folder.id || "");
  input.checked = Boolean(folder.selected);

  const copy = document.createElement("div");
  const title = document.createElement("div");
  title.className = "binding-option-title";
  title.textContent = folder.title || t("favlist.folderWithId", { id: folder.id || "" });
  const meta = document.createElement("div");
  meta.className = "binding-option-meta";
  const count = Number(folder.media_count || 0);
  meta.textContent = t(folder.selected ? "favlist.mediaCountSelected" : "favlist.mediaCount", { count: count || 0 });
  copy.append(title, meta);

  label.append(input, copy);
  return label;
}

function openGatchaFavlistSheet(uid, payload, { messageTarget = "gatcha" } = {}) {
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];
  if (!folders.length) {
    setGatchaUidFlowMessage(messageTarget, t("favlist.none"), true);
    return;
  }
  state.gatchaFavlistIntent = { uid, folders, messageTarget };
  elements.gatchaFavlistSheetText.textContent = t("favlist.chooseForUid", {
    uid: payload?.uid || uid,
    count: payload?.public_folder_count || folders.length,
  });
  elements.gatchaFavlistSheetOptions.innerHTML = "";
  folders.forEach((folder) => {
    elements.gatchaFavlistSheetOptions.appendChild(renderGatchaFavlistOption(folder));
  });
  state.gatchaFavlistSheetOpen = true;
  elements.gatchaFavlistSheet.classList.remove("hidden");
  elements.gatchaFavlistSheet.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    elements.gatchaFavlistSheet.classList.add("is-open");
  });
}

function closeGatchaFavlistSheet() {
  state.gatchaFavlistSheetOpen = false;
  state.gatchaFavlistIntent = null;
  elements.gatchaFavlistSheet.classList.remove("is-open");
  elements.gatchaFavlistSheet.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (state.gatchaFavlistSheetOpen) {
      return;
    }
    elements.gatchaFavlistSheet.classList.add("hidden");
    elements.gatchaFavlistSheetOptions.innerHTML = "";
  }, 280);
}

function poolConfigFolderId(folder) {
  return String(folder?.id || folder?.folder_id || "").trim();
}

function poolConfigSetMessage(message, isError = false) {
  if (!elements.poolConfigMessage) {
    return;
  }
  elements.poolConfigMessage.textContent = message || "";
  elements.poolConfigMessage.classList.toggle("is-error", Boolean(isError));
  elements.poolConfigMessage.classList.toggle("hidden", !message);
}

function updatePoolConfigWeightLabel() {
  const uidWeight = Math.max(0, Math.min(100, Number(elements.poolConfigWeightSlider?.value || 50)));
  const favlistWeight = 100 - uidWeight;
  setRangeFillPercent(elements.poolConfigWeightSlider, uidWeight);
  if (elements.poolConfigWeightLabel) {
    elements.poolConfigWeightLabel.textContent = t("gatcha.poolWeightValue", {
      uid: uidWeight,
      favlist: favlistWeight,
    });
  }
}

function renderPoolConfigOption({ type, id, title, meta, checked }) {
  const label = document.createElement("label");
  label.className = "binding-option pool-config-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = type === "uid" ? "gatcha-pool-uid" : "gatcha-pool-favlist";
  input.value = String(id || "");
  input.checked = Boolean(checked);

  const copy = document.createElement("div");
  const titleEl = document.createElement("div");
  titleEl.className = "binding-option-title";
  titleEl.textContent = title || id;
  const metaEl = document.createElement("div");
  metaEl.className = "binding-option-meta";
  metaEl.textContent = meta || "";
  copy.append(titleEl, metaEl);
  label.append(input, copy);
  return label;
}

function renderPoolConfigSheet() {
  const data = state.poolConfigData || {};
  const excludedUids = new Set((Array.isArray(data.excluded_uids) ? data.excluded_uids : []).map(String));
  const excludedFolders = new Set((Array.isArray(data.excluded_favlist_folders) ? data.excluded_favlist_folders : []).map(String));
  const uidWeight = Math.max(0, Math.min(100, Number(data.uid_weight ?? 50)));

  if (elements.poolConfigWeightSlider) {
    elements.poolConfigWeightSlider.value = String(uidWeight);
    elements.poolConfigWeightSlider.disabled = state.poolConfigSaving;
  }
  updatePoolConfigWeightLabel();

  if (elements.poolConfigUidOptions) {
    elements.poolConfigUidOptions.innerHTML = "";
    const uids = Array.isArray(data.uid_options) ? data.uid_options : [];
    if (!uids.length) {
      const empty = document.createElement("p");
      empty.className = "muted pool-config-empty";
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
      empty.className = "muted pool-config-empty";
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
    if (button) button.disabled = state.poolConfigSaving || !hasUidOptions;
  });
  [elements.poolConfigFavlistSelectAll, elements.poolConfigFavlistSelectNone].forEach((button) => {
    if (button) button.disabled = state.poolConfigSaving || !hasFavlistOptions;
  });
  if (elements.poolConfigSheetReset) {
    const detailLoaded = Array.isArray(data.uid_options) || Array.isArray(data.favlist_folder_options);
    elements.poolConfigSheetReset.disabled = state.poolConfigSaving || !detailLoaded;
  }
  if (elements.poolConfigSheetSave) {
    const detailLoaded = Array.isArray(data.uid_options) || Array.isArray(data.favlist_folder_options);
    elements.poolConfigSheetSave.disabled = state.poolConfigSaving || !detailLoaded;
    elements.poolConfigSheetSave.textContent = state.poolConfigSaving ? t("gatcha.poolSaving") : t("gatcha.poolSave");
  }
}

async function openPoolConfigSheet() {
  if (!elements.poolConfigSheet || state.poolConfigSheetOpen) {
    return;
  }
  state.poolConfigSheetOpen = true;
  state.poolConfigSaving = false;
  state.poolConfigData = state.data?.gatcha_pool_config || {};
  elements.poolConfigSheet.classList.remove("hidden");
  elements.poolConfigSheet.setAttribute("aria-hidden", "false");
  renderPoolConfigSheet();
  poolConfigSetMessage(t("gatcha.poolLoading"));
  requestAnimationFrame(() => {
    elements.poolConfigSheet.classList.add("is-open");
  });
  try {
    state.poolConfigData = await fetchPoolConfig();
    poolConfigSetMessage("");
  } catch (error) {
    poolConfigSetMessage(error.message, true);
  }
  renderPoolConfigSheet();
}

function closePoolConfigSheet() {
  state.poolConfigSheetOpen = false;
  state.poolConfigSaving = false;
  elements.poolConfigSheet?.classList.remove("is-open");
  elements.poolConfigSheet?.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (state.poolConfigSheetOpen) {
      return;
    }
    elements.poolConfigSheet?.classList.add("hidden");
    state.poolConfigData = null;
    poolConfigSetMessage("");
  }, 280);
}

function setPoolConfigChecked(name, checked) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.checked = Boolean(checked);
  });
}

function resetPoolConfigControls() {
  if (elements.poolConfigWeightSlider) {
    elements.poolConfigWeightSlider.value = "50";
  }
  updatePoolConfigWeightLabel();
  setPoolConfigChecked("gatcha-pool-uid", true);
  setPoolConfigChecked("gatcha-pool-favlist", true);
  poolConfigSetMessage("");
}

function poolConfigExcludedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]`)]
    .filter((input) => !input.checked)
    .map((input) => String(input.value || "").trim())
    .filter(Boolean);
}

async function submitPoolConfigSheet() {
  if (state.poolConfigSaving) {
    return;
  }
  const uidWeight = Math.max(0, Math.min(100, Number(elements.poolConfigWeightSlider?.value || 50)));
  const payload = {
    uid_weight: uidWeight,
    favlist_weight: 100 - uidWeight,
    excluded_uids: poolConfigExcludedValues("gatcha-pool-uid"),
    excluded_favlist_folders: poolConfigExcludedValues("gatcha-pool-favlist"),
  };
  state.poolConfigData = {
    ...(state.poolConfigData || {}),
    ...payload,
  };
  state.poolConfigSaving = true;
  renderPoolConfigSheet();
  poolConfigSetMessage(t("gatcha.poolSaving"));
  try {
    state.poolConfigData = await savePoolConfig(payload);
    if (state.data) {
      state.data.gatcha_pool_config = {
        uid_weight: state.poolConfigData.uid_weight,
        favlist_weight: state.poolConfigData.favlist_weight,
        excluded_uids: state.poolConfigData.excluded_uids || [],
        excluded_favlist_folders: state.poolConfigData.excluded_favlist_folders || [],
        updated_at: state.poolConfigData.updated_at || 0,
      };
    }
    closePoolConfigSheet();
  } catch (error) {
    poolConfigSetMessage(error.message, true);
  } finally {
    state.poolConfigSaving = false;
    if (state.poolConfigSheetOpen) {
      renderPoolConfigSheet();
    }
  }
}

function openReorderConfirmSheet(intent) {
  if (!intent?.itemId || !Number.isInteger(intent.targetIndex) || !elements.reorderConfirmSheet) {
    return;
  }

  const title = String(intent.title || "").trim() || t("request.thisSong");
  state.reorderConfirmIntent = {
    itemId: intent.itemId,
    targetIndex: intent.targetIndex,
    title,
  };
  state.reorderConfirmSaving = false;
  state.reorderConfirmSheetOpen = true;
  if (elements.reorderConfirmSheetText) {
    elements.reorderConfirmSheetText.textContent = t("remote.queueOrderMessage", {
      title,
      index: intent.targetIndex + 1,
    });
  }
  if (elements.reorderConfirmSheetConfirm) {
    elements.reorderConfirmSheetConfirm.disabled = false;
    elements.reorderConfirmSheetConfirm.textContent = t("remote.queueOrderConfirm");
  }
  elements.reorderConfirmSheet.classList.remove("hidden");
  elements.reorderConfirmSheet.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    elements.reorderConfirmSheet.classList.add("is-open");
  });
}

function closeReorderConfirmSheet() {
  state.reorderConfirmSheetOpen = false;
  state.reorderConfirmIntent = null;
  state.reorderConfirmSaving = false;
  elements.reorderConfirmSheet?.classList.remove("is-open");
  elements.reorderConfirmSheet?.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    if (state.reorderConfirmSheetOpen) {
      return;
    }
    elements.reorderConfirmSheet?.classList.add("hidden");
    if (elements.reorderConfirmSheetText) {
      elements.reorderConfirmSheetText.textContent = "";
    }
    if (elements.reorderConfirmSheetConfirm) {
      elements.reorderConfirmSheetConfirm.disabled = false;
      elements.reorderConfirmSheetConfirm.textContent = t("remote.queueOrderConfirm");
    }
  }, 280);
}

async function confirmReorderConfirmSheet() {
  const intent = state.reorderConfirmIntent;
  if (!intent?.itemId || !Number.isInteger(intent.targetIndex) || state.reorderConfirmSaving) {
    return;
  }

  state.reorderConfirmSaving = true;
  if (elements.reorderConfirmSheetConfirm) {
    elements.reorderConfirmSheetConfirm.disabled = true;
    elements.reorderConfirmSheetConfirm.textContent = t("remote.queueOrderMoving");
  }

  try {
    state.data = await apiPost("/api/playlist/reorder", {
      item_id: intent.itemId,
      index: intent.targetIndex,
    });
    closeReorderConfirmSheet();
    setFormMessage(t("remote.queueOrderUpdated"));
    render();
  } catch (error) {
    state.reorderConfirmSaving = false;
    if (elements.reorderConfirmSheetConfirm) {
      elements.reorderConfirmSheetConfirm.disabled = false;
      elements.reorderConfirmSheetConfirm.textContent = t("remote.queueOrderConfirm");
    }
    setFormMessage(error.message, true);
  }
}
async function confirmGatchaFavlistSheet() {
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
    renderGatchaUidView();
    return;
  }

  state.gatchaFavlistSaving = true;
  renderGatchaUidView();
  setGatchaUidFlowMessage(messageTarget, t("favlist.pullingSelected"));
  closeGatchaFavlistSheet();
  try {
    const result = await pullGatchaFavlist(intent.uid, folderIds);
    setGatchaUidFlowMessage(messageTarget, t("favlist.pullResult", {
      folders: result?.matched_folder_count || 0,
      items: result?.item_count || 0,
    }));
    if (state.favlistBrowseData) {
      state.favlistBrowseRenderSignature = "";
      await loadFavlistBrowse({
        folderId: state.favlistBrowseSelectedFolderId,
        query: String(elements.favlistSearchQuery?.value || "").trim(),
        keepQuery: true,
      });
    }
  } catch (error) {
    setGatchaUidFlowMessage(messageTarget, error.message, true);
  } finally {
    state.gatchaFavlistSaving = false;
    renderGatchaUidView();
  }
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
  meta.textContent = entry.duration > 0 ? t("player.durationSeconds", { seconds: entry.duration }) : t("player.durationUnknown");
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
  const source = intent.source || "request-form";
  const { selectedVideoPage, selectedAudioPages } = currentBindingSelection();
  if (!selectedVideoPage) {
    setMessageForSource(source, t("binding.selectVideoPart"), true);
    setAppMessage(t("binding.selectVideoPart"), true);
    return;
  }
  if (!selectedAudioPages.length) {
    setMessageForSource(source, t("binding.selectAudioPart"), true);
    setAppMessage(t("binding.selectAudioPart"), true);
    return;
  }

  state.submitting = true;
  setMessageForSource(source, intent.position === "next" ? t("remote.bindingAddingNext") : t("remote.bindingAddingTail"));

  const button = elements.bindingSheetConfirm;
  let originalText = "";
  if (button) {
    button.disabled = true;
    originalText = button.textContent;
    button.textContent = t("search.adding") || "添加中...";
  }

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
      setMessageForSource(source, t("remote.cancelledDuplicate"));
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    closeBindingSheet();
    if (["modalFollow", "modalFavlist", "modalBrowse"].includes(source)) {
      searchDetailController?.close({ immediate: true });
    }
    if (intent.clearInput) {
      elements.urlInput.value = "";
    }
    if (intent.source === "gatcha") {
      state.gatchaCandidate = null;
      renderGatchaUidView();
    }
    setMessageForSource(source, intent.position === "next" ? t("binding.addedNext") : t("binding.addedTail"));
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(intent, error.payload?.binding);
      return;
    }
    setMessageForSource(source, error.message, true);
    setAppMessage(error.message, true);
  } finally {
    state.submitting = false;
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function setRemoteAvOffset(offsetMs) {
  const numeric = Number(offsetMs);
  if (!Number.isFinite(numeric)) {
    return;
  }
  await dispatchRemoteAvDelayAction({ type: "set_effective", effective_delay_ms: Math.round(numeric) });
}

async function dispatchRemoteAvDelayAction(action) {
  if (state.remoteAvDelaySaving) {
    return;
  }
  const activeElement = document.activeElement;
  activeElement?.setAttribute?.("aria-busy", "true");
  state.remoteAvDelaySaving = true;
  renderRemoteAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
  try {
    const decision = await apiPost(
      "/api/player/av-delay-action",
      action,
      { timeoutMs: avDelayRequestTimeoutMs },
    );
    state.data = {
      ...state.data,
      player_settings: {
        ...state.data?.player_settings,
        av_offset_ms: Number(decision?.effective_delay_ms || 0),
        av_delay: decision,
      },
    };
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.remoteAvDelaySaving = false;
    activeElement?.removeAttribute?.("aria-busy");
    renderRemoteAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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
    renderRemoteVolumeControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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
  renderRemoteVolumeControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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

function currentPlayerStatus(currentItem, snapshot = state.data) {
  const playerStatus = snapshot?.player_status;
  if (!currentItem || !playerStatus) {
    return null;
  }
  const snapshotGeneration = Number(snapshot?.playback_generation);
  const statusGeneration = Number(playerStatus.playback_generation);
  if (
    !Number.isSafeInteger(snapshotGeneration)
    || snapshotGeneration < 1
    || !Number.isSafeInteger(statusGeneration)
    || statusGeneration !== snapshotGeneration
  ) {
    return null;
  }
  if (String(playerStatus.item_id || "") !== String(currentItem.id || "")) {
    return null;
  }
  return playerStatus;
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

function playerStatusUpdatedAt(playerStatus) {
  const updatedAt = Number(playerStatus?.updated_at || 0);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
}

function clearPlayerControlStatusRefreshTimers() {
  state.playerControlStatusRefreshTimers.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  state.playerControlStatusRefreshTimers = [];
}

function clearPlayerControlStatusSync(expectedSync = null) {
  if (expectedSync && state.playerControlStatusSync !== expectedSync) {
    return false;
  }
  state.playerControlStatusSync = null;
  clearPlayerControlStatusRefreshTimers();
  return true;
}

function renderAfterPlayerControlStatusSync() {
  const currentItem = state.data?.current_item;
  renderCurrentPlaybackState(currentItem);
  renderPlayerControls(currentItem, frontendPlaybackMode(state.data?.playback_mode));
}

function playerControlStatusSyncPending(currentItem, playerStatus = currentPlayerStatus(currentItem)) {
  const sync = state.playerControlStatusSync;
  if (!sync) {
    return false;
  }
  if (
    !currentItem
    || String(currentItem.id || "") !== sync.itemId
    || state.data?.playback_generation !== sync.playbackGeneration
  ) {
    clearPlayerControlStatusSync();
    return false;
  }
  if (playerStatusUpdatedAt(playerStatus) > sync.updatedAfter) {
    clearPlayerControlStatusSync();
    return false;
  }
  if (Date.now() >= sync.expiresAt) {
    clearPlayerControlStatusSync();
    return false;
  }
  return true;
}

function schedulePlayerControlStatusRefresh() {
  clearPlayerControlStatusRefreshTimers();
  const sync = state.playerControlStatusSync;
  if (!sync) {
    return;
  }
  const timeoutId = window.setTimeout(() => {
    if (state.playerControlStatusSync !== sync) {
      return;
    }
    clearPlayerControlStatusSync(sync);
    renderAfterPlayerControlStatusSync();
  }, Math.max(0, sync.expiresAt - Date.now()));
  state.playerControlStatusRefreshTimers = [timeoutId];
}

function beginPlayerControlStatusSync(currentItem) {
  const itemId = String(currentItem?.id || "").trim();
  if (!itemId) {
    clearPlayerControlStatusSync();
    return;
  }
  const sync = {
    itemId,
    playbackGeneration: state.data?.playback_generation,
    updatedAfter: playerStatusUpdatedAt(currentPlayerStatus(currentItem)),
    expiresAt: Date.now() + playerControlStatusSyncTimeoutMs,
  };
  state.playerControlStatusSync = sync;
  schedulePlayerControlStatusRefresh();
  return sync;
}

function renderPlayerControls(currentItem, playbackMode) {
  if (!currentItem) {
    state.playerControlsRenderSignature = "__empty__";
    elements.playerControlPanel.classList.add("hidden");
    if (elements.floatingPlayerControlPanel) {
      elements.floatingPlayerControlPanel.classList.add("hidden");
    }
    if (typeof clearRemoteIssueByPrefix === "function") {
      clearRemoteIssueByPrefix("player-control-unsupported");
      clearRemoteIssueByPrefix("player-control-cache-pending");
    }
    return;
  }

  const unsupportedIssueSignature = remotePlayerIssueSignature(
    "player-control-unsupported",
    currentItem,
  );
  const cachePendingIssueSignature = remotePlayerIssueSignature(
    "player-control-cache-pending",
    currentItem,
  );
  const canControl = canRemoteControlPlayer(currentItem, playbackMode);
  const playerStatus = currentPlayerStatus(currentItem);
  const isPaused = playerStatus ? Boolean(playerStatus.is_paused) : true;
  const controlSignature = JSON.stringify({
    itemId: currentItem.id || "",
    itemIncarnationId: currentItem.item_incarnation_id || "",
    playbackGeneration: state.data?.playback_generation || 0,
    playbackMode,
    canControl,
    hasLocalSplitMedia: hasLocalSplitMedia(currentItem),
    isPaused,
    pendingAction: state.playerControlPendingAction || "",
  });
  if (controlSignature === state.playerControlsRenderSignature) {
    return;
  }
  state.playerControlsRenderSignature = controlSignature;

  const toggleButton = elements.playerControlPanel.querySelector('[data-control-action="toggle-play"]');
  const floatingToggleButton = elements.floatingPlayerControlPanel?.querySelector('[data-control-action="toggle-play"]');

  elements.playerControlPanel.classList.remove("hidden");
  if (elements.floatingPlayerControlPanel) {
    elements.floatingPlayerControlPanel.classList.remove("hidden");
  }

  const updateButtons = (panel) => {
    if (!panel) return;
    panel.querySelectorAll("button[data-control-action]").forEach((button) => {
      const action = button.dataset.controlAction || "";
      const isPending = action === state.playerControlPendingAction;
      const disabled = action === "next-track"
        ? Boolean(state.playerControlPendingAction)
        : !canControl || Boolean(state.playerControlPendingAction);
      button.disabled = disabled;
      button.classList.toggle("is-pending", isPending);
    });
  };

  updateButtons(elements.playerControlPanel);
  updateButtons(elements.floatingPlayerControlPanel);

  const updateToggleState = (btn) => {
    if (!btn) return;
    btn.textContent = isPaused ? t("remote.play") : t("remote.pause");
    btn.classList.toggle("is-paused", isPaused);
    btn.classList.toggle("is-playing", !isPaused);
  };

  updateToggleState(toggleButton);
  updateToggleState(floatingToggleButton);

  if (playbackMode !== "local") {
    if (typeof clearRemoteIssueByPrefix === "function") {
      clearRemoteIssueByPrefix("player-control-cache-pending");
    }
    if (typeof reportRemoteIssue === "function") {
      clearRemoteIssueByPrefix("player-control-unsupported", unsupportedIssueSignature);
      reportRemoteIssue(unsupportedIssueSignature, t("remote.controlUnsupported"));
    }
    return;
  }
  if (!hasLocalSplitMedia(currentItem)) {
    if (typeof clearRemoteIssueByPrefix === "function") {
      clearRemoteIssueByPrefix("player-control-unsupported");
    }
    if (typeof reportRemoteIssue === "function") {
      clearRemoteIssueByPrefix("player-control-cache-pending", cachePendingIssueSignature);
      reportRemoteIssue(cachePendingIssueSignature, t("remote.controlCachePending"));
    }
    return;
  }
  if (typeof clearRemoteIssueByPrefix === "function") {
    clearRemoteIssueByPrefix("player-control-unsupported");
    clearRemoteIssueByPrefix("player-control-cache-pending");
  }
}

function renderListHeader(playlist, history) {
  const isHistoryView = state.listView === "history";
  const signature = JSON.stringify({
    language: state.language,
    view: state.listView,
    playlistLength: playlist.length,
    historyLength: history.length,
  });
  if (signature === state.listHeaderRenderSignature) {
    return;
  }
  state.listHeaderRenderSignature = signature;

  elements.listTag.textContent = isHistoryView ? t("history.tag") : t("list.tag");
  setTextContent(elements.listTitleText, isHistoryView ? "history.title" : "list.title");
  setTextContent(
    elements.listCount,
    isHistoryView ? "history.count" : "list.count",
    { count: isHistoryView ? history.length : playlist.length },
  );

  elements.queueViewButton.classList.toggle("active", !isHistoryView);
  elements.queueViewButton.setAttribute("aria-selected", String(!isHistoryView));
  elements.historyViewButton.classList.toggle("active", isHistoryView);
  elements.historyViewButton.setAttribute("aria-selected", String(isHistoryView));
  elements.historyExportRow?.classList.toggle("hidden", !isHistoryView);
  setTextContent(elements.queueViewButton, "list.title");
  setTextContent(elements.historyViewButton, "history.title");
}

function syncListView() {
  const isHistoryView = state.listView === "history";
  elements.queueList.classList.toggle("hidden", isHistoryView);
  elements.historyList.classList.toggle("hidden", !isHistoryView);
}

function queueRenderSignatureForItem(item, index) {
  return {
    index,
    id: String(item?.id || ""),
    title: String(item?.display_title || ""),
    requester: String(item?.requester_name || ""),
    cacheStatus: String(item?.cache_status || ""),
  };
}

function createQueueEmptyNode(message) {
  const node = document.createElement("div");
  node.className = "queue-empty";
  node.textContent = message;
  return node;
}

function renderQueue(playlist) {
  const items = Array.isArray(playlist) ? playlist : [];
  const signature = JSON.stringify({
    language: state.language,
    playlist: items.map(queueRenderSignatureForItem),
  });
  if (signature === state.queueRenderSignature) {
    renderQueueCacheStatus(items);
    return;
  }
  state.queueRenderSignature = signature;

  elements.queueList.replaceChildren();
  if (!items.length) {
    elements.queueList.appendChild(createQueueEmptyNode(t("remote.queueEmpty")));
    return;
  }

  items.forEach((item, index) => {
    const node = elements.queueItemTemplate.content.firstElementChild.cloneNode(true);
    applyStaticI18n(node);
    node.dataset.id = String(item.id || "");
    const orderNode = node.querySelector(".queue-order");
    if (orderNode) {
      orderNode.textContent = String(index + 1);
    }
    node.querySelector(".queue-title").textContent = item.display_title;
    const requesterNode = node.querySelector(".queue-requester");
    const requesterText = requesterBadgeText(item.requester_name);
    requesterNode.textContent = requesterText;
    requesterNode.classList.toggle("hidden", !requesterText);
    syncQueueItemCacheStatus(node, item);
    elements.queueList.appendChild(node);
  });
}

function renderQueueCacheStatus(playlist) {
  const items = Array.isArray(playlist) ? playlist : [];
  const itemsById = new Map(items.map((item) => [String(item.id || ""), item]));
  elements.queueList.querySelectorAll(".queue-item").forEach((node) => {
    const item = itemsById.get(String(node.dataset.id || ""));
    if (item) {
      syncQueueItemCacheStatus(node, item);
    }
  });
}

function syncQueueItemCacheStatus(node, item) {
  if (!node || !item) {
    return;
  }
  const noteNode = node.querySelector(".queue-note");
  const noteText = queueNoteText(item);
  if (noteNode && noteNode.textContent !== noteText) {
    noteNode.textContent = noteText;
  }
  noteNode?.classList.toggle("hidden", !noteText);
  node.querySelector(".queue-main")?.classList.toggle("is-compact", !noteText);

  const stateNode = node.querySelector(".queue-state");
  const stateText = queueStateLabel(item);
  if (stateNode && stateNode.textContent !== stateText) {
    stateNode.textContent = stateText;
  }
  node.classList.toggle("ready", item.cache_status === "ready");

  syncQueueItemRetryButton(node, item);
}

function queueNoteText(item) {
  if (!item) {
    return "";
  }
  if (item.cache_status === "ready") {
    return "";
  }
  if (item.cache_status === "downloading") {
    return cacheDownloadTotalSizeLabel(item);
  }
  const message = String(item.cache_message || "").trim();
  if (!message) {
    return "";
  }
  const localizedMessage = localizedCacheMessage(message, item.cache_status);
  if (localizedMessage === t("cache.ready")) {
    return "";
  }
  return localizedMessage;
}

function queueStateLabel(item) {
  if (item.cache_status === "ready") {
    return t("status.ready");
  }
  if (item.cache_status === "downloading") {
    const progressPercent = cacheProgressPercentForItem(item);
    if (progressPercent !== null) {
      return `${progressPercent}%`;
    }
    return t("status.caching");
  }
  if (item.cache_status === "failed") {
    return t("status.failed");
  }
  if (item.cache_status === "queued") {
    return t("status.queued");
  }
  return t("status.waiting");
}

function shouldShowRetryButton(item) {
  if (!item) return false;
  const itemId = String(item.id || "");
  if (!itemId) return false;
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

  const observedAt = hasFreshActivity ? now : Number(previous?.observedAt || 0);

  state.retryActivityById[itemId] = {
    observedAt,
    lastActivity,
    cacheSizeBytes,
    cacheProgress,
    cacheMessage,
  };

  if (observedAt <= 0) return false;
  return now - observedAt >= 5; // stalledRetrySeconds = 5
}

function syncQueueItemRetryButton(node, item) {
  if (!node || !item) return;
  const retryBtn = node.querySelector(".queue-retry-button");
  if (retryBtn) {
    const visible = shouldShowRetryButton(item);
    retryBtn.classList.toggle("hidden", !visible);
  }
}

function syncCurrentCacheState(current) {
  if (!elements.currentCacheState) return;
  if (!current) {
    const textNode = elements.currentCacheState.querySelector(".cache-state-text");
    if (textNode) textNode.textContent = "";
    else elements.currentCacheState.textContent = "";
    const retryBtn = elements.currentCacheState.querySelector("#current-cache-retry");
    if (retryBtn) {
      retryBtn.classList.add("hidden");
      delete retryBtn.dataset.id;
      delete retryBtn.dataset.itemIncarnationId;
    }
    elements.currentCacheState.classList.add("hidden");
    elements.currentCacheState.classList.remove("ready", "failed");
    return;
  }

  elements.currentCacheState.classList.remove("hidden");
  elements.currentCacheState.classList.toggle("ready", current.cache_status === "ready");
  elements.currentCacheState.classList.toggle("failed", current.cache_status === "failed");

  const label = currentCacheStateLabel(current);
  const textNode = elements.currentCacheState.querySelector(".cache-state-text");
  if (textNode) {
    if (textNode.textContent !== label) {
      textNode.textContent = label;
    }
  } else {
    elements.currentCacheState.textContent = label;
  }

  const retryBtn = elements.currentCacheState.querySelector("#current-cache-retry");
  if (retryBtn) {
    const showRetry = shouldShowRetryButton(current);
    retryBtn.classList.toggle("hidden", !showRetry);
    if (showRetry) {
      retryBtn.dataset.id = current.id;
      retryBtn.dataset.itemIncarnationId = current.item_incarnation_id;
    } else {
      delete retryBtn.dataset.id;
      delete retryBtn.dataset.itemIncarnationId;
    }
  }
}



function currentCacheStateLabel(item) {
  if (!item) {
    return "";
  }
  if (item.cache_status === "downloading") {
    const progressLabel = cacheDownloadTotalProgressLabel(item);
    if (progressLabel) {
      return progressLabel;
    }
    const message = localizedCacheMessage(item.cache_message, item.cache_status);
    if (message) {
      return message;
    }
    const size = Number(item.cache_size_bytes || 0);
    return size > 0 ? t("status.cachingWithSize", { size: formatBytes(size) }) : t("status.caching");
  }
  return queueStateLabel(item);
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

function cacheDownloadTotalSizeLabel(item) {
  const totalBytes = Number(item?.cache_download_total_bytes || 0);
  const currentBytes = Number(item?.cache_download_current_bytes || 0);
  if (totalBytes > 0) {
    return `${formatBytes(Math.min(currentBytes, totalBytes))} / ${formatBytes(totalBytes)}`;
  }
  if (currentBytes > 0) {
    return t("status.cachingWithSize", { size: formatBytes(currentBytes) });
  }
  return "";
}

function cacheDownloadTotalProgressLabel(item) {
  const sizeLabel = cacheDownloadTotalSizeLabel(item);
  const progressPercent = cacheProgressPercentForItem(item);
  if (sizeLabel && progressPercent !== null) {
    return `${sizeLabel} · ${progressPercent}%`;
  }
  if (progressPercent !== null) {
    return `${t("status.caching")} ${progressPercent}%`;
  }
  return sizeLabel;
}

function formatPlaybackClockSeconds(seconds) {
  const normalizedSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(normalizedSeconds / 3600);
  const minutes = Math.floor((normalizedSeconds % 3600) / 60);
  const restSeconds = normalizedSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(restSeconds).padStart(2, "0")}`;
}

function clearCurrentPlaybackClock() {
  if (state.currentPlaybackClockTimer) {
    window.clearInterval(state.currentPlaybackClockTimer);
    state.currentPlaybackClockTimer = null;
  }
  state.currentPlaybackClockSignature = "";
  state.currentPlaybackClockBaseSeconds = 0;
  state.currentPlaybackClockDurationSeconds = 0;
  state.currentPlaybackClockStartedAt = 0;
  state.currentPlaybackClockPaused = true;
}

function currentPlaybackClockText() {
  const { currentSeconds, durationSeconds } = currentPlaybackClockSeconds();
  if (!(durationSeconds > 0)) {
    return "";
  }
  return `${formatPlaybackClockSeconds(currentSeconds)} / ${formatPlaybackClockSeconds(durationSeconds)}`;
}

function paintCurrentPlaybackClock() {
  const text = currentPlaybackClockText();
  if (!text || !elements.currentCacheState) {
    return;
  }
  const textNode = elements.currentCacheState.querySelector(".cache-state-text");
  if (textNode) {
    if (textNode.textContent !== text) {
      textNode.textContent = text;
    }
  } else {
    if (elements.currentCacheState.textContent !== text) {
      elements.currentCacheState.textContent = text;
    }
  }
  try {
    maybeUpdateRemoteRatingPrompt(state.data?.current_item);
  } catch (error) {
    console.warn("Rating prompt update failed:", error);
  }
}

function renderCurrentPlaybackState(current) {
  if (!current || current.cache_status !== "ready") {
    if (
      state.playerControlStatusSync
      && (!current || String(current.id || "") !== state.playerControlStatusSync.itemId)
    ) {
      clearPlayerControlStatusSync();
    }
    clearCurrentPlaybackClock();
    syncCurrentCacheState(current);
    return;
  }

  const playerStatus = currentPlayerStatus(current);
  const itemDurationSeconds = durationSecondsForItem(current);
  const reportedDurationSeconds = Number(playerStatus?.duration || 0);
  const durationSeconds = itemDurationSeconds > 0 ? itemDurationSeconds : reportedDurationSeconds;
  const currentSeconds = Math.max(0, Number(playerStatus?.current_time || 0));
  const isPaused = playerStatus ? Boolean(playerStatus.is_paused) : true;
  const waitingForHostStatus = playerControlStatusSyncPending(current, playerStatus);
  if (!(durationSeconds > 0) || (!currentSeconds && isPaused)) {
    clearCurrentPlaybackClock();
    syncCurrentCacheState(current);
    return;
  }

  const signature = [
    state.data?.playback_generation || 0,
    current.id || "",
    Math.round(currentSeconds),
    Math.round(durationSeconds),
    isPaused ? "paused" : "playing",
    waitingForHostStatus ? "host-sync" : "live",
  ].join("|");
  if (signature !== state.currentPlaybackClockSignature) {
    state.currentPlaybackClockSignature = signature;
    state.currentPlaybackClockBaseSeconds = currentSeconds;
    state.currentPlaybackClockDurationSeconds = durationSeconds;
    state.currentPlaybackClockStartedAt = Date.now();
    state.currentPlaybackClockPaused = waitingForHostStatus || isPaused;
  }

  paintCurrentPlaybackClock();
  if (waitingForHostStatus || isPaused) {
    if (state.currentPlaybackClockTimer) {
      window.clearInterval(state.currentPlaybackClockTimer);
      state.currentPlaybackClockTimer = null;
    }
    return;
  }
  if (!state.currentPlaybackClockTimer) {
    state.currentPlaybackClockTimer = window.setInterval(paintCurrentPlaybackClock, 1000);
  }
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

function renderHistory(history) {
  const signature = JSON.stringify({
    language: state.language,
    history: history || [],
    openHistoryMenuId: state.openHistoryMenuId || "",
  });
  if (signature === state.historyRenderSignature) {
    return;
  }
  state.historyRenderSignature = signature;

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
    const node = elements.historyItemTemplate.content.firstElementChild.cloneNode(true);
    applyStaticI18n(node);
    node.querySelector(".history-title").textContent = entry.display_title;
    const requesterNode = node.querySelector(".history-requester");
    const requesterText = requesterBadgeText(entry.requester_name);
    requesterNode.textContent = requesterText;
    requesterNode.classList.toggle("hidden", !requesterText);
    node.querySelector(".history-time").textContent = formatHistoryTime(entry.requested_at);
    node.querySelector(".history-count").textContent = t("history.requestCount", { count: entry.request_count });
    node.querySelectorAll("button").forEach((button) => {
      button.dataset.url = entry.original_url || entry.resolved_url || "";
    });
    if (state.openHistoryMenuId === (entry.original_url || entry.resolved_url || "")) {
      const menu = node.querySelector(".menu-content");
      if (menu) {
        menu.classList.remove("hidden");
        menu.classList.add("no-animate");
      }
    }
    elements.historyList.appendChild(node);
  });
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

async function submitRequest(position) {
  const url = elements.urlInput.value.trim();
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    if (!url) {
      setFormMessage(t("request.urlRequired"), true);
    }
    return;
  }
  if (!requesterName) {
    setFormMessage(t("session.requireRequester"), true);
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? t("remote.addingNext") : t("remote.addingTail"));

  const button = position === "next"
    ? elements.addNextButton
    : elements.requestForm?.querySelector('button[type="submit"]');
  let originalText = "";
  if (button) {
    button.disabled = true;
    originalText = button.textContent;
    button.textContent = t("search.adding") || "添加中...";
  }

  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage(t("remote.cancelledDuplicate"));
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    elements.urlInput.value = "";
    setFormMessage(position === "next" ? t("request.addedNext") : t("request.addedTail"));
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
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function handleAddByHistory(url, position) {
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    return;
  }
  if (!requesterName) {
    setFormMessage(t("session.requireRequester"), true);
    return;
  }

  state.submitting = true;
  setFormMessage(position === "next" ? t("remote.historyAddingNext") : t("history.addingFromHistory"));
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setFormMessage(t("remote.cancelledDuplicate"));
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    setFormMessage(position === "next" ? t("history.addedNext") : t("history.addedTail"));
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

async function resortPlaylistByCycle() {
  state.data = await apiPost("/api/playlist/resort");
  applyStateSnapshot(state.data, { forceRender: true });
  setFormMessage(t("list.resorted"));
}

async function addByUrl(url, position = "tail", source = "search") {
  const requesterName = selectedRequesterName();
  if (!url || state.submitting) {
    return false;
  }
  if (!requesterName) {
    setMessageForSource(source, t("session.requireRequester"), true);
    return false;
  }

  state.submitting = true;
  setMessageForSource(source, t("remote.addingSelected"));
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setMessageForSource(source, t("remote.cancelledDuplicate"));
      return false;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    if (source === "gatcha") {
      state.gatchaCandidate = null;
      renderGatchaUidView();
    }
    setMessageForSource(source, t("request.success"));
    return true;
  } catch (error) {
    if (error.code === "manual_binding_required") {
      openBindingSheet(
        {
          url,
          position,
          requesterName,
          clearInput: false,
          source,
        },
        error.payload?.binding,
      );
      return false;
    }
    setMessageForSource(source, error.message, true);
    return false;
  } finally {
    state.submitting = false;
  }
}

async function confirmGatchaCandidate() {
  const button = elements.gatchaConfirmButton;
  if (!button || button.disabled || state.submitting || !state.gatchaCandidate?.url) {
    return false;
  }

  const previousText = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = t("search.adding");
  try {
    await addByUrl(String(state.gatchaCandidate.url), "tail", "gatcha");
    return true;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = previousText;
  }
}

function remotePlayerIssueSignature(kind, currentItem, playbackGeneration = state.data?.playback_generation) {
  return [
    String(kind || "").trim(),
    String(currentItem?.id || "").trim(),
    String(currentItem?.item_incarnation_id || "").trim(),
    String(playbackGeneration ?? "").trim(),
  ].join(":");
}

async function sendPlayerControl(action, deltaSeconds = 0) {
  const currentItem = state.data?.current_item;
  const playbackMode = frontendPlaybackMode(state.data?.playback_mode);
  const expectedPlaybackGeneration = state.data?.playback_generation;
  if (
    !currentItem
    || !canRemoteControlPlayer(currentItem, playbackMode)
    || !Number.isSafeInteger(expectedPlaybackGeneration)
    || expectedPlaybackGeneration < 1
  ) {
    return;
  }

  const issueSignature = remotePlayerIssueSignature(
    `player-command:${action}`,
    currentItem,
    expectedPlaybackGeneration,
  );
  const message = action === "toggle-play"
    ? t("remote.controlSentToggle")
    : deltaSeconds > 0
      ? t("remote.controlSentForward")
      : t("remote.controlSentBack");

  let controlSync = null;
  try {
    state.playerControlPendingAction = action;
    controlSync = beginPlayerControlStatusSync(currentItem);
    renderCurrentPlaybackState(currentItem);
    renderPlayerControls(currentItem, playbackMode);
    const outcome = await apiPostExactStateCommand("/api/player/control", {
      action,
      item_id: currentItem.id,
      delta_seconds: deltaSeconds,
      playback_generation: expectedPlaybackGeneration,
    });
    if (outcome.commandApplied) {
      if (typeof clearRemoteIssue === "function") {
        clearRemoteIssue(issueSignature);
      }
      setFormMessage(message);
    } else {
      clearPlayerControlStatusSync(controlSync);
      renderAfterPlayerControlStatusSync();
      if (typeof reportRemoteIssue === "function") {
        reportRemoteIssue(issueSignature, t("remote.controlRejected"));
      }
    }
  } catch (error) {
    clearPlayerControlStatusSync(controlSync);
    setFormMessage(error.message, true);
    if (typeof reportRemoteIssue === "function") {
      reportRemoteIssue(issueSignature, error.message || t("remote.controlCommandFailed"));
    }
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
}

async function sendPlayerNext() {
  const currentItem = state.data?.current_item;
  if (!currentItem) {
    return;
  }
  const expectedPlaybackGeneration = state.data.playback_generation;
  if (!Number.isSafeInteger(expectedPlaybackGeneration) || expectedPlaybackGeneration < 1) {
    return;
  }
  const issueSignature = remotePlayerIssueSignature(
    "player-command:next-track",
    currentItem,
    expectedPlaybackGeneration,
  );
  try {
    state.playerControlPendingAction = "next-track";
    renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
    const outcome = await apiPostExactStateCommand("/api/player/next", {
      playback_generation: expectedPlaybackGeneration,
    });
    if (outcome.commandApplied) {
      if (typeof clearRemoteIssue === "function") {
        clearRemoteIssue(issueSignature);
      }
      setFormMessage(t("remote.nextSent"));
    } else if (typeof reportRemoteIssue === "function") {
      reportRemoteIssue(issueSignature, t("remote.controlRejected"));
    }
  } catch (error) {
    setFormMessage(error.message, true);
    if (typeof reportRemoteIssue === "function") {
      reportRemoteIssue(issueSignature, error.message || t("remote.controlCommandFailed"));
    }
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
}

function disconnectClient() {
  // Flush any pending auto-ratings before disconnecting so songs that
  // crossed the threshold but never got a deferred flush (e.g. the last
  // song in the session) still get their auto score=5 submitted.
  try {
    flushAllPendingAutoRatings();
  } catch (error) {
    console.warn("Failed to flush pending auto-ratings on disconnect:", error);
  }
  clearStateFallbackTimer();
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

elements.remoteRequestViewButtons?.forEach((button) => {
  button.addEventListener("click", () => {
    activateRemoteRequestView(button.dataset.remoteRequestView);
  });
  button.addEventListener("keydown", handleRemoteRequestTabKeydown);
});

elements.remoteSearchModeButtons?.forEach((button) => {
  button.addEventListener("click", () => {
    activateRemoteSearchMode(button.dataset.remoteSearchMode);
  });
  button.addEventListener("keydown", handleRemoteSearchModeTabKeydown);
});

elements.requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitRequest("tail");
});

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.searchQuery.value || "").trim();
  if (!query) {
    hideSearchResults();
    setSearchMessage(t("search.keywordRequired"), true);
    return;
  }

  elements.searchButton.disabled = true;
  setSearchMessage(t("search.localSearching"));
  try {
    const items = await searchGatchaCache(query);
    renderSearchResults(items);
    setSearchMessage(items.length ? t("search.localFound", { count: items.length }) : t("search.localNotFound"));
  } catch (error) {
    hideSearchResults();
    setSearchMessage(error.message, true);
  } finally {
    elements.searchButton.disabled = false;
  }
});

elements.searchResults.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button || button.disabled) {
    return;
  }
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = t("search.adding") || "添加中...";
  try {
    await addByUrl(String(button.dataset.url || ""), "tail", "search");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

elements.searchLibraryOpen?.addEventListener("click", () => {
  setSearchModalOpen(true);
});

elements.searchModalClose?.addEventListener("click", () => {
  setSearchModalOpen(false);
});

elements.searchModalBackdrop?.addEventListener("click", () => {
  setSearchModalOpen(false);
});

elements.searchModalTabs?.forEach((button) => {
  button.addEventListener("click", () => {
    renderSearchModalView(button.dataset.target);
  });
});

elements.favlistGrid?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-folder-id]");
  if (!button) {
    return;
  }
  const folderId = String(button.dataset.folderId || "").trim();
  if (!folderId) {
    return;
  }
  state.favlistBrowseSelectedFolderId = folderId;
  if (elements.favlistSearchQuery) {
    elements.favlistSearchQuery.value = "";
  }
  await loadFavlistBrowse({ folderId, query: "" });
});

elements.favlistBrowseBack?.addEventListener("click", () => {
  state.favlistBrowseSelectedFolderId = "";
  if (elements.favlistSearchQuery) {
    elements.favlistSearchQuery.value = "";
  }
  state.favlistBrowseRenderSignature = "";
  renderFavlistBrowse();
});

elements.favlistSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  const target = event.target.closest(".search-result-item[data-url], button[data-url]");
  if (!target || !elements.favlistSongResults.contains(target)) {
    return;
  }
  const button = target.closest("button[data-url]");
  if (button && button.disabled) {
    return;
  }
  const url = String(target.dataset.url || button?.dataset.url || "").trim();
  if (!url) {
    return;
  }
  let originalText = "";
  if (button) {
    originalText = button.textContent;
    button.disabled = true;
    button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await addByUrl(url, "tail", "modalFavlist");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
});

elements.searchModalOtherView?.addEventListener("submit", (event) => {
  const categoryForm = event.target.closest("[data-category-browse-search]");
  if (categoryForm && elements.searchModalOtherView.contains(categoryForm)) {
    event.preventDefault();
    const input = categoryForm.querySelector("[data-category-browse-query]");
    loadCategoryBrowse({
      query: input?.value || "",
      append: false,
    });
    return;
  }
  const form = event.target.closest("[data-d1-browse-search]");
  if (!form || !elements.searchModalOtherView.contains(form)) {
    return;
  }
  event.preventDefault();
  const input = form.querySelector("[data-d1-browse-query]");
  if (!state.d1BrowseLetter) {
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
  if (state.d1BrowseTag) {
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

elements.searchModalOtherView?.addEventListener("click", (event) => {
  const categoryBackButton = event.target.closest("[data-category-browse-back]");
  if (categoryBackButton && elements.searchModalOtherView.contains(categoryBackButton)) {
    state.categoryBrowseSelectedId = "";
    state.categoryBrowseQuery = "";
    state.categoryBrowseItems = [];
    state.categoryBrowseOffset = 0;
    state.categoryBrowseHasMore = false;
    state.categoryBrowseError = "";
    renderCategoryBrowseView();
    return;
  }
  const categoryButton = event.target.closest("[data-category-id]");
  if (categoryButton && elements.searchModalOtherView.contains(categoryButton)) {
    loadCategoryBrowse({
      categoryId: categoryButton.dataset.categoryId || "",
      query: "",
      append: false,
    });
    return;
  }
  const backButton = event.target.closest("[data-d1-browse-back]");
  if (backButton && elements.searchModalOtherView.contains(backButton)) {
    if (state.d1BrowseTag) {
      loadD1Browse({
        kind: state.d1BrowseKind || "name",
        letter: state.d1BrowseLetter,
        query: "",
        tag: "",
        locale: "",
      });
    } else if (state.d1BrowseLetter) {
      state.d1BrowseLetter = "";
      state.d1BrowseTag = "";
      state.d1BrowseLocale = "";
      state.d1BrowseQuery = "";
      state.d1BrowseData = null;
      renderD1BrowseView();
    }
    return;
  }
  const letterButton = event.target.closest("[data-letter]");
  if (letterButton && elements.searchModalOtherView.contains(letterButton)) {
    loadD1Browse({
      kind: state.d1BrowseKind || "name",
      letter: letterButton.dataset.letter || "",
      query: "",
      tag: "",
      locale: "",
    });
    return;
  }
  const tagButton = event.target.closest("[data-tag]");
  if (tagButton && elements.searchModalOtherView.contains(tagButton)) {
    loadD1Browse({
      kind: state.d1BrowseKind || "name",
      letter: state.d1BrowseLetter,
      query: "",
      tag: tagButton.dataset.tag || "",
      locale: tagButton.dataset.locale || "",
    });
  }
});

elements.searchModalOtherView?.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.searchModalOtherView, "modalBrowse")) {
    return;
  }
  const target = event.target.closest(".search-result-item[data-url], button[data-url]");
  if (!target || !elements.searchModalOtherView.contains(target)) {
    return;
  }
  const button = target.closest("button[data-url]");
  if (button && button.disabled) {
    return;
  }
  const url = String(target.dataset.url || button?.dataset.url || "").trim();
  if (!url) {
    return;
  }
  let originalText = "";
  if (button) {
    originalText = button.textContent;
    button.disabled = true;
    button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await addByUrl(url, "tail", "modalBrowse");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
});

elements.searchModalOtherView?.addEventListener("scroll", (event) => {
  const target = event.target;
  if (target instanceof Element && target.matches("[data-category-browse-results]")) {
    maybeLoadMoreCategoryBrowse(target);
  }
}, true);

elements.larkSearchQuery?.addEventListener("input", () => {
  canonicalBilikaraSearch.query = String(elements.larkSearchQuery?.value || "");
});

elements.larkSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await executeCanonicalBilikaraSearch(elements.larkSearchQuery?.value);
});

elements.larkSearchResults?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button || button.disabled) {
    return;
  }
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = t("search.adding") || "添加中...";
  try {
    await addByUrl(String(button.dataset.url || ""), "tail", "lark");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

elements.modalFollowUidForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await addGatchaUidFromInput(elements.modalFollowUidInput, { messageTarget: "follow-modal" });
});

elements.modalFollowUpGrid?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-uid]");
  if (!button) {
    return;
  }
  const uid = String(button.dataset.uid || "").trim();
  if (!uid) {
    return;
  }
  state.followBrowseSelectedUid = uid;
  if (elements.modalFollowSearchQuery) {
    elements.modalFollowSearchQuery.value = "";
  }
  await loadFollowBrowse({ uid, query: "" });
});

elements.modalFollowBrowseBack?.addEventListener("click", () => {
  state.followBrowseSelectedUid = "";
  if (elements.modalFollowSearchQuery) {
    elements.modalFollowSearchQuery.value = "";
  }
  renderModalFollowBrowse();
});

elements.modalFollowSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.modalFollowSearchQuery?.value || "").trim();
  await loadFollowBrowse({
    uid: state.followBrowseSelectedUid,
    query,
    keepQuery: true,
  });
});

elements.modalFollowSongResults?.addEventListener("click", async (event) => {
  if (openSearchResultDetail(event, elements.modalFollowSongResults, "modalFollow")) {
    return;
  }
  const target = event.target.closest(".search-result-item[data-url], button[data-url]");
  if (!target || !elements.modalFollowSongResults.contains(target)) {
    return;
  }
  const button = target.closest("button[data-url]");
  if (button && button.disabled) {
    return;
  }
  const url = String(target.dataset.url || button?.dataset.url || "").trim();
  if (!url) {
    return;
  }
  let originalText = "";
  if (button) {
    originalText = button.textContent;
    button.disabled = true;
    button.textContent = t("search.adding") || "添加中...";
  }
  try {
    await addByUrl(url, "tail", "modalFollow");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
});

elements.addNextButton.addEventListener("click", async () => {
  await submitRequest("next");
});

elements.resortPlaylistButton?.addEventListener("click", async () => {
  try {
    await resortPlaylistByCycle();
  } catch (error) {
    setFormMessage(error.message, true);
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

elements.remoteMenuToggle?.addEventListener("click", () => {
  setRemoteMenuOpen(!state.remoteMenuOpen);
});

elements.remoteQrToggle?.addEventListener("click", () => {
  setRemoteQrSectionOpen(!state.remoteQrSectionOpen);
});

elements.remoteSettingsToggle?.addEventListener("click", () => {
  setRemoteSettingsSectionOpen(!state.remoteSettingsSectionOpen);
});

const remoteContextualInfoHoverDelayMs = 160;
const remoteContextualInfoLeaveDelayMs = 90;
let remoteContextualInfoHoverTimer = null;
let remoteContextualInfoLeaveTimer = null;
let remoteContextualInfoPositionFrame = null;

function positionRemoteContextualTooltip(wrap) {
  const button = wrap?.querySelector?.(".remote-info-button");
  const tooltip = wrap?.querySelector?.(".remote-tooltip-bubble");
  if (!button || !tooltip || !wrap.classList.contains("is-visible")) {
    return false;
  }
  const viewportInset = 8;
  const tooltipGap = 7;
  const containerRect = wrap.closest(".binding-sheet-panel, .floating-control-card, .remote-menu-panel")?.getBoundingClientRect();
  const boundaryLeft = Math.max(viewportInset, (containerRect?.left ?? viewportInset) + (containerRect ? 8 : 0));
  const boundaryRight = Math.min(
    window.innerWidth - viewportInset,
    (containerRect?.right ?? (window.innerWidth - viewportInset)) - (containerRect ? 8 : 0),
  );
  const boundaryTop = Math.max(viewportInset, (containerRect?.top ?? viewportInset) + (containerRect ? 8 : 0));
  const boundaryBottom = Math.min(
    window.innerHeight - viewportInset,
    (containerRect?.bottom ?? (window.innerHeight - viewportInset)) - (containerRect ? 8 : 0),
  );
  const buttonRect = button.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const width = Math.min(240, Math.max(0, boundaryRight - boundaryLeft));
  tooltip.style.width = `${Math.round(width)}px`;
  tooltip.style.left = "0px";
  tooltip.style.right = "auto";
  tooltip.style.top = "0px";
  tooltip.style.bottom = "auto";
  const height = tooltip.getBoundingClientRect().height;
  const buttonCenter = buttonRect.left + (buttonRect.width / 2);
  const left = Math.max(
    boundaryLeft,
    Math.min(buttonCenter - (width / 2), boundaryRight - width),
  );
  const spaceAbove = buttonRect.top - boundaryTop - tooltipGap;
  const spaceBelow = boundaryBottom - buttonRect.bottom - tooltipGap;
  const direction = spaceAbove >= height || spaceAbove >= spaceBelow ? "up" : "down";
  const preferredTop = direction === "up"
    ? buttonRect.top - tooltipGap - height
    : buttonRect.bottom + tooltipGap;
  const top = Math.max(boundaryTop, Math.min(preferredTop, boundaryBottom - height));
  const arrowCenter = Math.max(10, Math.min(width - 10, buttonCenter - left));
  tooltip.dataset.tooltipDirection = direction;
  tooltip.style.left = `${Math.round(left - wrapRect.left)}px`;
  tooltip.style.top = `${Math.round(top - wrapRect.top)}px`;
  tooltip.style.setProperty("--remote-tooltip-arrow-left", `${arrowCenter - 6}px`);
  tooltip.style.setProperty(
    "--remote-tooltip-transform-origin",
    `${Math.round(arrowCenter)}px ${direction === "up" ? "bottom" : "top"}`,
  );
  return true;
}

function syncVisibleRemoteContextualTooltipPosition() {
  remoteContextualInfoPositionFrame = null;
  document.querySelectorAll(".info-trigger-wrap.is-visible").forEach(positionRemoteContextualTooltip);
}

function scheduleRemoteContextualTooltipPositionSync() {
  if (remoteContextualInfoPositionFrame !== null) {
    return;
  }
  remoteContextualInfoPositionFrame = window.requestAnimationFrame(
    syncVisibleRemoteContextualTooltipPosition,
  );
}

function setRemoteContextualInfoVisible(wrap, { pinned = false } = {}) {
  if (!wrap) {
    return false;
  }
  document.querySelectorAll(".info-trigger-wrap.is-visible").forEach((candidate) => {
    if (candidate === wrap) {
      return;
    }
    candidate.classList.remove("is-visible", "is-pinned");
    candidate.querySelector(".remote-info-button")?.setAttribute("aria-expanded", "false");
  });
  wrap.classList.add("is-visible");
  wrap.classList.toggle("is-pinned", pinned);
  wrap.querySelector(".remote-info-button")?.setAttribute("aria-expanded", "true");
  positionRemoteContextualTooltip(wrap);
  return true;
}

function closeRemoteContextualInfo({ includePinned = true } = {}) {
  if (remoteContextualInfoHoverTimer) {
    window.clearTimeout(remoteContextualInfoHoverTimer);
    remoteContextualInfoHoverTimer = null;
  }
  if (remoteContextualInfoLeaveTimer) {
    window.clearTimeout(remoteContextualInfoLeaveTimer);
    remoteContextualInfoLeaveTimer = null;
  }
  let closed = false;
  document.querySelectorAll(".info-trigger-wrap.is-visible").forEach((wrap) => {
    if (!includePinned && wrap.classList.contains("is-pinned")) {
      return;
    }
    closed = true;
    wrap.classList.remove("is-visible", "is-pinned");
    wrap.querySelector(".remote-info-button")?.setAttribute("aria-expanded", "false");
  });
  return closed;
}

function showRemoteContextualInfoTransient(wrap, source) {
  if (wrap?.classList.contains("is-pinned")) {
    return true;
  }
  const pinned = document.querySelector(".info-trigger-wrap.is-pinned");
  if (source === "pointer" && pinned && pinned !== wrap) {
    return false;
  }
  return setRemoteContextualInfoVisible(wrap);
}

function remoteContextualInfoSupportsHover(event) {
  if (event.pointerType === "touch") {
    return false;
  }
  return window.matchMedia?.("(any-hover: hover) and (any-pointer: fine)").matches !== false;
}

document.querySelectorAll(".remote-contextual-info-region").forEach((region) => {
  const wrap = region.querySelector(".info-trigger-wrap");
  region.addEventListener("pointerenter", (event) => {
    if (!wrap || !remoteContextualInfoSupportsHover(event) || wrap.classList.contains("is-visible")) {
      return;
    }
    if (remoteContextualInfoLeaveTimer) {
      window.clearTimeout(remoteContextualInfoLeaveTimer);
      remoteContextualInfoLeaveTimer = null;
    }
    if (remoteContextualInfoHoverTimer) {
      window.clearTimeout(remoteContextualInfoHoverTimer);
    }
    remoteContextualInfoHoverTimer = window.setTimeout(() => {
      remoteContextualInfoHoverTimer = null;
      if (region.matches(":hover")) {
        showRemoteContextualInfoTransient(wrap, "pointer");
      }
    }, remoteContextualInfoHoverDelayMs);
  });
  region.addEventListener("pointerleave", () => {
    if (remoteContextualInfoHoverTimer) {
      window.clearTimeout(remoteContextualInfoHoverTimer);
      remoteContextualInfoHoverTimer = null;
    }
    if (remoteContextualInfoLeaveTimer) {
      window.clearTimeout(remoteContextualInfoLeaveTimer);
    }
    remoteContextualInfoLeaveTimer = window.setTimeout(() => {
      remoteContextualInfoLeaveTimer = null;
      if (
        !wrap?.classList.contains("is-pinned")
        && !region.matches(":hover")
        && !wrap?.contains(document.activeElement)
      ) {
        wrap?.classList.remove("is-visible");
        wrap?.querySelector(".remote-info-button")?.setAttribute("aria-expanded", "false");
      }
    }, remoteContextualInfoLeaveDelayMs);
  });
  region.addEventListener("focusin", (event) => {
    if (!event.target.closest(".remote-info-button")) {
      return;
    }
    showRemoteContextualInfoTransient(wrap, "keyboard");
  });
  region.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (
        !wrap?.classList.contains("is-pinned")
        && !region.contains(document.activeElement)
        && !region.matches(":hover")
      ) {
        wrap?.classList.remove("is-visible");
        wrap?.querySelector(".remote-info-button")?.setAttribute("aria-expanded", "false");
      }
    }, 0);
  });
});

document.addEventListener("click", (event) => {
  const infoBtn = event.target.closest(".remote-info-button");
  if (infoBtn) {
    const wrap = infoBtn.closest(".info-trigger-wrap");
    event.preventDefault();
    event.stopPropagation();
    if (wrap?.classList.contains("is-pinned")) {
      closeRemoteContextualInfo();
    } else {
      closeRemoteContextualInfo();
      setRemoteContextualInfoVisible(wrap, { pinned: true });
    }
  } else if (!event.target.closest(".remote-contextual-info-region")) {
    closeRemoteContextualInfo();
  }

  if (state.remoteMenuOpen && !event.target.closest("#remote-header-menu")) {
    setRemoteMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (closeRemoteContextualInfo()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (state.searchModalOpen) {
      setSearchModalOpen(false);
    }
    if (state.remoteMenuOpen) {
      setRemoteMenuOpen(false, { restoreFocus: true });
      event.preventDefault();
    }
  }
});

window.addEventListener("resize", scheduleRemoteContextualTooltipPositionSync);
window.addEventListener("scroll", scheduleRemoteContextualTooltipPositionSync, true);

elements.refreshButton.addEventListener("click", async () => {
  try {
    await fetchState({ force: true });
    setFormMessage(t("remote.refreshed"));
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    state.audioVariantSwitchInFlight = false;
    scheduleAudioVariantSwitchUnlock();
  }
});

elements.remoteAvSyncPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-av-step], button[data-reset-av-offset], button[data-av-delay-lock]");
  if (!button) {
    return;
  }
  if (button.disabled) {
    return;
  }
  if (button.hasAttribute("data-reset-av-offset")) {
    await dispatchRemoteAvDelayAction({ type: "reset_local" });
    return;
  }
  if (button.hasAttribute("data-av-delay-lock")) {
    await dispatchRemoteAvDelayAction({ type: "toggle_lock" });
    return;
  }
  await dispatchRemoteAvDelayAction({ type: "adjust", delta_ms: Number(button.dataset.avStep || "0") });
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

elements.remoteKeyShiftPanel?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  const currentKey = currentRemoteKeyShift(state.data?.player_settings);
  if (button.id === "remote-key-shift-reset-button") {
    await setRemoteKeyShift(0);
  } else if (button.id === "remote-key-shift-dec-button") {
    await setRemoteKeyShift(currentKey - 1);
  } else if (button.id === "remote-key-shift-inc-button") {
    await setRemoteKeyShift(currentKey + 1);
  }
});

elements.remoteKeyShiftInput?.addEventListener("change", async (event) => {
  await setRemoteKeyShift(event.target.value);
});

elements.remoteKeyShiftInput?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  await setRemoteKeyShift(event.target.value);
});

elements.remoteIdentityRename?.addEventListener("click", openRemoteIdentityRename);
elements.remoteIdentityCancel?.addEventListener("click", closeRemoteIdentityRename);
elements.remoteIdentityBackdrop?.addEventListener("click", closeRemoteIdentityRename);
elements.remoteIdentityForm?.addEventListener("submit", submitRemoteIdentity);

elements.gatchaButton.addEventListener("click", handleGatchaDraw);
elements.gatchaRetryButton.addEventListener("click", handleGatchaDraw);

elements.gatchaUidToggle?.addEventListener("click", () => {
  state.gatchaUidVisible = !state.gatchaUidVisible;
  renderGatchaUidView();
});

elements.gatchaPoolConfigToggle?.addEventListener("click", async () => {
  await openPoolConfigSheet();
});

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
  const optOutBtn = event.target.closest("[data-rating-opt-out-btn]");
  if (optOutBtn) {
    setRatingOptOut(true);
    closeRatingPrompt({ submit: false });
    return;
  }
  const addUpButton = event.target.closest("[data-rating-add-up]");
  if (addUpButton) {
    const promptItem = activeRatingPromptItem();
    const uid = ratingOwnerUid(promptItem);
    const message = root.querySelector("[data-rating-message]");
    if (!uid) {
      if (message) message.textContent = t("rating.missingUidMessage");
      return;
    }
    addUpButton.disabled = true;
    if (message) message.textContent = t("rating.addingUp");
    try {
      await addGatchaUid(uid);
      if (message) message.textContent = t("rating.addedUp");
    } catch (error) {
      if (message) message.textContent = error.message || t("rating.addFailed");
    } finally {
      addUpButton.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-rating-close]")) {
    closeRatingPrompt({ submit: true });
  }
});

elements.gatchaUidForm?.addEventListener("submit", handleGatchaUidSubmit);

elements.refreshGatchaCacheButton?.addEventListener("click", async () => {
  if (gatchaTaskBusy()) {
    setGatchaUidMessage(gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }
  state.gatchaRefreshSaving = true;
  renderGatchaUidView();
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
    setGatchaUidMessage(result?.started === false ? t("gatcha.busyFallback") : t("gatcha.refreshStarted"));
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaRefreshSaving = false;
    renderGatchaUidView();
  }
});

elements.pullGatchaFavlistButton?.addEventListener("click", async () => {
  await previewGatchaFavlistFromInput(elements.gatchaUidInput, { messageTarget: "gatcha" });
});

elements.modalFavlistPullForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await previewGatchaFavlistFromInput(elements.modalFavlistUidInput, { messageTarget: "favlist-modal" });
});

elements.gatchaConfirmButton.addEventListener("click", async () => {
  await confirmGatchaCandidate();
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

elements.gatchaFavlistSheetClose?.addEventListener("click", () => {
  closeGatchaFavlistSheet();
});

elements.gatchaFavlistSheetCancel?.addEventListener("click", () => {
  closeGatchaFavlistSheet();
});

elements.gatchaFavlistSheetBackdrop?.addEventListener("click", () => {
  closeGatchaFavlistSheet();
});

elements.gatchaFavlistSheetConfirm?.addEventListener("click", async () => {
  await confirmGatchaFavlistSheet();
});

elements.poolConfigSheetClose?.addEventListener("click", () => {
  closePoolConfigSheet();
});

elements.poolConfigSheetCancel?.addEventListener("click", () => {
  closePoolConfigSheet();
});

elements.poolConfigSheetBackdrop?.addEventListener("click", () => {
  closePoolConfigSheet();
});

elements.poolConfigWeightSlider?.addEventListener("input", () => {
  updatePoolConfigWeightLabel();
});

elements.poolConfigSheetReset?.addEventListener("click", () => {
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

elements.poolConfigSheetSave?.addEventListener("click", async () => {
  await submitPoolConfigSheet();
});

elements.reorderConfirmSheetClose?.addEventListener("click", () => {
  closeReorderConfirmSheet();
});

elements.reorderConfirmSheetCancel?.addEventListener("click", () => {
  closeReorderConfirmSheet();
});

elements.reorderConfirmSheetBackdrop?.addEventListener("click", () => {
  closeReorderConfirmSheet();
});

elements.reorderConfirmSheetConfirm?.addEventListener("click", async () => {
  await confirmReorderConfirmSheet();
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
      renderAudioVariantBar(state.data.current_item, frontendPlaybackMode(state.data.playback_mode));
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
      setFormMessage(t("session.requireRequester"), true);
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
        setFormMessage(t("remote.cancelledDuplicate"));
        return;
      }
      applyStateSnapshot(result.data, { forceRender: true });
      setFormMessage(t("player.partAddedToCache"));
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
    renderAudioVariantBar(currentItem, frontendPlaybackMode(state.data?.playback_mode));
    const outcome = await apiPostExactStateCommand("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
      expected_item_incarnation_id: currentItem.item_incarnation_id,
    });
    if (outcome.commandApplied) {
      const activeItem = state.data?.current_item;
      const activeVariant = activeItem ? selectedAudioVariantForItem(activeItem) : null;
      setFormMessage(t("player.switchedPart", { part: activeVariant?.label || nextVariantId }));
    } else {
      state.audioVariantSwitchUnlockAt = 0;
    }
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

if (elements.floatingPlayerControlPanel) {
  elements.floatingPlayerControlPanel.addEventListener("click", async (event) => {
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
}

elements.queueViewButton.addEventListener("click", () => {
  state.listView = "queue";
  render();
});

elements.historyViewButton.addEventListener("click", () => {
  state.listView = "history";
  render();
});

elements.currentCacheState?.addEventListener("click", async (event) => {
  const retryBtn = event.target.closest("#current-cache-retry");
  if (!retryBtn) {
    return;
  }
  event.stopPropagation();
  const itemId = retryBtn.dataset.id;
  const itemIncarnationId = retryBtn.dataset.itemIncarnationId;
  if (!itemId || !itemIncarnationId) {
    return;
  }
  if (retryBtn.getAttribute("aria-busy") === "true") {
    return;
  }
  const confirmed = window.confirm(t("cache.retryConfirm") || "确定要重新缓存吗？");
  if (!confirmed) {
    return;
  }
  const originallyDisabled = retryBtn.disabled;
  retryBtn.disabled = true;
  retryBtn.setAttribute("aria-busy", "true");
  try {
    const outcome = await apiPostExactStateCommand("/api/cache/retry", {
      item_id: itemId,
      expected_item_incarnation_id: itemIncarnationId,
      force: true,
    });
    render();
    if (outcome.commandApplied) {
      setFormMessage(t("cache.retryStarted"));
    }
  } catch (error) {
    setFormMessage(error.message, true);
  } finally {
    retryBtn.disabled = originallyDisabled;
    retryBtn.removeAttribute("aria-busy");
  }
});

elements.historyExportImageButton?.addEventListener("click", async () => {
  await exportHistory("image");
});

elements.historyExportCsvButton?.addEventListener("click", async () => {
  await exportHistory("csv");
});

elements.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  if (button.dataset.action === "toggle-menu") {
    const wrap = button.closest(".history-actions-wrap");
    const content = wrap?.querySelector(".menu-content");
    if (content) {
      const isHidden = content.classList.contains("hidden");
      closeOpenMenus();
      if (isHidden) {
        content.classList.remove("hidden");
        content.classList.remove("no-animate");
        state.openHistoryMenuId = button.dataset.url;
      }
    }
    return;
  }

  const url = button.dataset.url;
  if (!url) {
    return;
  }
  closeOpenMenus();
  await handleAddByHistory(url, button.dataset.action === "history-next" ? "next" : "tail");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".queue-actions-wrap") && !event.target.closest(".history-actions-wrap")) {
    closeOpenMenus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (state.bindingSheetOpen) {
    closeBindingSheet();
  }
  if (state.gatchaFavlistSheetOpen) {
    closeGatchaFavlistSheet();
  }
  if (state.poolConfigSheetOpen) {
    closePoolConfigSheet();
  }
  if (state.reorderConfirmSheetOpen) {
    closeReorderConfirmSheet();
  }
  if (elements.floatingControlOverlay && !elements.floatingControlOverlay.classList.contains("hidden")) {
    hideFloatingControlOverlay();
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

let floatingControlBackdropIgnoreUntil = 0;

function makeElementDraggable(element, onClick) {
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let isDragging = false;
  let moved = false;
  let suppressClickUntil = 0;
  let pctX = null;
  let pctY = null;
  let activeTouchId = null;

  const invokeClick = () => {
    if (typeof onClick === "function") {
      onClick();
    }
  };

  const suppressNextClick = () => {
    suppressClickUntil = Date.now() + 450;
  };

  const dragStart = (e) => {
    if (e.type === "mousedown" && e.button !== 0) {
      return;
    }

    clearDragListeners();
    const rect = element.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    if (e.type === "touchstart") {
      const touch = e.changedTouches?.[0] || e.touches[0];
      activeTouchId = Number.isFinite(touch?.identifier) ? touch.identifier : null;
      startX = touch.clientX;
      startY = touch.clientY;
    } else {
      activeTouchId = null;
      startX = e.clientX;
      startY = e.clientY;
    }

    isDragging = true;
    moved = false;

    if (e.type === "touchstart") {
      document.addEventListener("touchmove", dragMove, { passive: false });
      document.addEventListener("touchend", dragEnd, { passive: false });
      document.addEventListener("touchcancel", dragCancel);
    } else {
      document.addEventListener("mousemove", dragMove);
      document.addEventListener("mouseup", dragEnd);
    }
  };

  const dragMove = (e) => {
    if (!isDragging) return;

    let currentX = 0;
    let currentY = 0;

    if (e.type === "touchmove") {
      const touch = activeTouchId === null
        ? e.touches[0]
        : [...e.touches].find((candidate) => candidate.identifier === activeTouchId);
      if (!touch) {
        dragCancel();
        return;
      }
      if (e.cancelable) {
        e.preventDefault();
      }
      currentX = touch.clientX;
      currentY = touch.clientY;
    } else {
      currentX = e.clientX;
      currentY = e.clientY;
    }

    const deltaX = currentX - startX;
    const deltaY = currentY - startY;

    if (!moved && Math.hypot(deltaX, deltaY) > 5) {
      moved = true;
      element.classList.add("dragging");
    }

    if (moved) {
      if (e.cancelable) {
        e.preventDefault();
      }
      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      const maxLeft = window.innerWidth - element.offsetWidth;
      const maxTop = window.innerHeight - element.offsetHeight;

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      element.style.left = `${newLeft}px`;
      element.style.top = `${newTop}px`;
      element.style.bottom = "auto";
      element.style.right = "auto";

      pctX = maxLeft > 0 ? newLeft / maxLeft : 1.0;
      pctY = maxTop > 0 ? newTop / maxTop : 1.0;
    }
  };

  const clearDragListeners = () => {
    document.removeEventListener("touchmove", dragMove);
    document.removeEventListener("touchend", dragEnd);
    document.removeEventListener("touchcancel", dragCancel);
    document.removeEventListener("mousemove", dragMove);
    document.removeEventListener("mouseup", dragEnd);
  };

  const dragEnd = (e) => {
    if (
      e.type === "touchend"
      && activeTouchId !== null
      && ![...(e.changedTouches || [])].some((touch) => touch.identifier === activeTouchId)
    ) {
      return;
    }
    isDragging = false;
    activeTouchId = null;
    element.classList.remove("dragging");
    clearDragListeners();

    if (e.type === "touchend" && e.cancelable) {
      e.preventDefault();
    }

    if (moved) {
      suppressNextClick();
      return;
    }

    invokeClick();
    suppressNextClick();
  };

  function dragCancel() {
    const wasDragging = isDragging;
    isDragging = false;
    activeTouchId = null;
    moved = false;
    element.classList.remove("dragging");
    clearDragListeners();
    if (wasDragging) {
      suppressNextClick();
    }
  }

  element.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    invokeClick();
  });
  element.addEventListener("mousedown", dragStart);
  element.addEventListener("touchstart", dragStart);
  window.addEventListener("blur", dragCancel);
  window.addEventListener("pagehide", dragCancel);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      dragCancel();
    }
  });

  window.addEventListener("resize", () => {
    if (pctX === null || pctY === null) {
      return;
    }
    const maxLeft = window.innerWidth - element.offsetWidth;
    const maxTop = window.innerHeight - element.offsetHeight;
    const nextLeft = Math.max(0, Math.min(pctX * maxLeft, maxLeft));
    const nextTop = Math.max(0, Math.min(pctY * maxTop, maxTop));
    element.style.left = `${nextLeft}px`;
    element.style.top = `${nextTop}px`;
    element.style.bottom = "auto";
    element.style.right = "auto";
  });
}

function showFloatingControlOverlay() {
  if (!elements.floatingControlOverlay) return;
  const wasHidden = elements.floatingControlOverlay.classList.contains("hidden");
  elements.floatingControlOverlay.classList.remove("closing");
  elements.floatingControlOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (wasHidden) {
    floatingControlBackdropIgnoreUntil = Date.now() + 450;
  }
}

function hideFloatingControlOverlay() {
  if (!elements.floatingControlOverlay) return;
  if (elements.floatingControlOverlay.classList.contains("hidden")) return;

  closeRemoteContextualInfo();
  elements.floatingControlOverlay.classList.add("closing");

  setTimeout(() => {
    if (elements.floatingControlOverlay.classList.contains("closing")) {
      elements.floatingControlOverlay.classList.add("hidden");
      elements.floatingControlOverlay.classList.remove("closing");
      document.body.style.overflow = "";
    }
  }, 250);
}

function initFloatingControlConsole() {
  if (!elements.floatingControlTrigger) {
    return;
  }
  makeElementDraggable(elements.floatingControlTrigger, () => {
    showFloatingControlOverlay();
  });
  elements.floatingControlClose?.addEventListener("click", () => {
    hideFloatingControlOverlay();
  });
  elements.floatingControlOverlay?.addEventListener("click", (event) => {
    if (Date.now() < floatingControlBackdropIgnoreUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  elements.floatingControlBackdrop?.addEventListener("click", (event) => {
    if (Date.now() < floatingControlBackdropIgnoreUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    hideFloatingControlOverlay();
  });
}

function renderFloatingControlTrigger(currentItem, playbackMode) {
  if (!elements.floatingControlTrigger) {
    return;
  }
  const isLocalMode = playbackMode === "local";
  const hasCurrentItem = Boolean(currentItem);
  const visible = isLocalMode && hasCurrentItem;
  elements.floatingControlTrigger.classList.toggle("hidden", !visible);

  if (!visible && elements.floatingControlOverlay && !elements.floatingControlOverlay.classList.contains("hidden")) {
    hideFloatingControlOverlay();
  }
}

async function startRemoteSession() {
  setupRemoteFlipStages();
  hydrateLocalPreferences();
  initFloatingControlConsole();
  await loadTranslations();
  renderRemoteConnectionStatus();
  initSearchDetailController();
  syncRemoteRequestViewSelection();
  renderRemoteIdentity();
  await fetchRemoteIdentity();
  try {
    await fetchState();
  } catch (error) {
    setFormMessage(error.message, true);
  }
  connectStateStream();
}

startRemoteSession();
