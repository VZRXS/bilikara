const audioVariantSwitchDebounceMs = 350;
const playerSettingsEchoSuppressMs = 1800;
const remoteVolumeCommitDebounceMs = 160;
const viewportScaleResetDelaysMs = [0, 120, 360];
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const larkSearchTableCount = 5;
const playerControlStatusRefreshDelaysMs = [180, 520, 1100, 1800];
const playerControlStatusSyncTimeoutMs = 3200;
const storageKeys = {
  language: "bilikara.ui.language",
  layoutMode: "bilikara.remote.layout.mode",
};

const state = {
  language: "zh",
  translations: {},
  translationsLoaded: false,
  clientId: createClientId(),
  disconnectSent: false,
  data: null,
  submitting: false,
  listView: "queue",
  openQueueMenuId: null,
  openHistoryMenuId: null,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  playerControlStatusRefreshTimers: [],
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
  gatchaFavlistSheetOpen: false,
  gatchaFavlistIntent: null,
  reorderConfirmSheetOpen: false,
  reorderConfirmIntent: null,
  reorderConfirmSaving: false,
  bindingAccordion: {
    video: false,
    audio: false,
  },
  eventSource: null,
  eventStreamReconnectTimer: null,
  eventStreamRetryMs: eventStreamInitialRetryMs,
  gatchaCandidate: null,
  gatchaUidVisible: false,
  gatchaUidSaving: false,
  gatchaRefreshSaving: false,
  gatchaFavlistSaving: false,
  gatchaTaskLastMessageSignature: "",
  gatchaTaskWatchStartedAt: Date.now() / 1000,
  followBrowseVisible: false,
  larkSearchVisible: false,
  larkSearchLoading: false,
  larkSearchSeq: 0,
  remoteSearchStageView: "",
  remoteSearchStageAngle: 0,
  remoteSearchFlipTimer: null,
  remoteSearchFlipFrame: null,
  remoteSearchPruneTimer: null,
  gatchaStageView: "",
  gatchaStageAngle: 0,
  gatchaFlipTimer: null,
  gatchaFlipFrame: null,
  gatchaPruneTimer: null,
  gatchaMidpointCallback: null,
  followBrowseData: null,
  followBrowseSelectedUid: "",
  followBrowseLoading: false,
  followBrowseRenderSignature: "",
  requesterSelectRenderSignature: "",
  dataRenderSignature: "",
  currentNowPlayingSignature: "",
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
  playerControlsRenderSignature: "",
  listHeaderRenderSignature: "",
  queueRenderSignature: "",
  historyRenderSignature: "",
  layoutMode: "full",
  remoteAccessRenderSignature: "",
  viewportScaleResetTimers: [],
  renderDebounceTimer: null,
};

const elements = {
  viewportMeta: document.getElementById("viewport-meta"),
  remoteShell: document.getElementById("remote-shell"),
  languageSwitch: document.getElementById("language-switch"),
  layoutModeSwitch: document.getElementById("layout-mode-switch"),
  remoteQrControl: document.getElementById("remote-qr-control"),
  remoteQrToggle: document.getElementById("remote-qr-toggle"),
  remoteMiniQrImage: document.getElementById("remote-mini-qr-image"),
  remoteMiniQrPlaceholder: document.getElementById("remote-mini-qr-placeholder"),
  remoteQrPopover: document.getElementById("remote-qr-popover"),
  remoteQrPopoverClose: document.getElementById("remote-qr-popover-close"),
  remotePopoverQrImage: document.getElementById("remote-popover-qr-image"),
  remotePopoverQrPlaceholder: document.getElementById("remote-popover-qr-placeholder"),
  remotePopoverUrlLink: document.getElementById("remote-popover-url-link"),
  remotePopoverUrlHint: document.getElementById("remote-popover-url-hint"),
  currentTitle: document.getElementById("current-title"),
  currentRequester: document.getElementById("current-requester"),
  currentOwner: document.getElementById("current-owner"),
  currentCacheState: document.getElementById("current-cache-state"),
  currentMeta: document.getElementById("current-meta"),
  audioVariantBar: document.getElementById("audio-variant-bar"),
  playerControlPanel: document.getElementById("player-control-panel"),
  playerControlHint: document.getElementById("player-control-hint"),
  remoteAvSyncPanel: document.getElementById("remote-av-sync-panel"),
  remoteAvOffsetInput: document.getElementById("remote-av-offset-input"),
  remoteAvOffsetResetButton: document.getElementById("remote-av-offset-reset-button"),
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
  gatchaFavlistSheet: document.getElementById("gatcha-favlist-sheet"),
  gatchaFavlistSheetBackdrop: document.getElementById("gatcha-favlist-sheet-backdrop"),
  gatchaFavlistSheetText: document.getElementById("gatcha-favlist-sheet-text"),
  gatchaFavlistSheetOptions: document.getElementById("gatcha-favlist-sheet-options"),
  gatchaFavlistSheetClose: document.getElementById("gatcha-favlist-sheet-close"),
  gatchaFavlistSheetCancel: document.getElementById("gatcha-favlist-sheet-cancel"),
  gatchaFavlistSheetConfirm: document.getElementById("gatcha-favlist-sheet-confirm"),
  reorderConfirmSheet: document.getElementById("reorder-confirm-sheet"),
  reorderConfirmSheetBackdrop: document.getElementById("reorder-confirm-sheet-backdrop"),
  reorderConfirmSheetText: document.getElementById("reorder-confirm-sheet-text"),
  reorderConfirmSheetClose: document.getElementById("reorder-confirm-sheet-close"),
  reorderConfirmSheetCancel: document.getElementById("reorder-confirm-sheet-cancel"),
  reorderConfirmSheetConfirm: document.getElementById("reorder-confirm-sheet-confirm"),
  requestForm: document.getElementById("request-form"),
  requesterSelect: document.getElementById("requester-select"),
  urlInput: document.getElementById("url-input"),
  formMessage: document.getElementById("form-message"),
  searchForm: document.getElementById("search-form"),
  searchQuery: document.getElementById("search-query"),
  searchButton: document.getElementById("search-button"),
  searchMessage: document.getElementById("search-message"),
  searchResults: document.getElementById("search-results"),
  remoteSearchStage: document.getElementById("remote-search-stage"),
  remoteSearchStageInner: document.getElementById("remote-search-stage-inner"),
  searchTag: document.querySelector(".search-panel .panel-tag"),
  searchTitle: document.querySelector(".search-panel .panel-title"),
  larkSearchToggle: document.getElementById("lark-search-toggle"),
  larkSearchView: document.getElementById("lark-search-view"),
  larkSearchForm: document.getElementById("lark-search-form"),
  larkSearchQuery: document.getElementById("lark-search-query"),
  larkSearchButton: document.getElementById("lark-search-button"),
  larkSearchMessage: document.getElementById("lark-search-message"),
  larkSearchResults: document.getElementById("lark-search-results"),
  followBrowseToggle: document.getElementById("follow-browse-toggle"),
  followBrowseView: document.getElementById("follow-browse-view"),
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
  addNextButton: document.getElementById("add-next-button"),
  resortPlaylistButton: document.getElementById("resort-playlist-button"),
  refreshButton: document.getElementById("refresh-button"),
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
  return normalized ? t("request.requesterBadge", { name: normalized }) : "";
}

function ownerLineText(ownerName) {
  const normalized = String(ownerName || "").trim();
  return normalized ? t("owner.upOwner", { name: normalized }) : "";
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function htmlT(key, replacements = {}) {
  const escapedReplacements = {};
  Object.entries(replacements).forEach(([name, value]) => {
    escapedReplacements[name] = escapeHtml(value);
  });
  return t(key, escapedReplacements);
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
  state.followBrowseRenderSignature = "";
  state.requesterSelectRenderSignature = "";
  state.gatchaTaskLastMessageSignature = "";
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
  if (state.data) {
    render();
  }
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

function setRemoteQrPopoverOpen(open) {
  state.remoteQrPopoverOpen = Boolean(open);
  elements.remoteQrPopover?.classList.toggle("hidden", !state.remoteQrPopoverOpen);
  elements.remoteQrToggle?.setAttribute("aria-expanded", String(state.remoteQrPopoverOpen));
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
    { image: elements.remoteMiniQrImage, placeholder: elements.remoteMiniQrPlaceholder, size: 132 },
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
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle("error", isError);
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
  if (source === "follow") {
    setFollowBrowseMessage(message, isError);
    return;
  }
  if (source === "gatcha") {
    setGatchaMessage(message, isError);
    return;
  }
  setFormMessage(message, isError);
}

function setRemoteSearchStageView(view) {
  if (!elements.remoteSearchStage) {
    return;
  }
  const nextView = ["search", "browse", "lark"].includes(view) ? view : "search";
  const previousView = state.remoteSearchStageView || "search";
  const isInitialRender = !state.remoteSearchStageView;
  if (state.remoteSearchStageView === nextView) {
    return;
  }
  state.remoteSearchStageView = nextView;

  if (state.remoteSearchFlipTimer) {
    window.clearTimeout(state.remoteSearchFlipTimer);
    state.remoteSearchFlipTimer = null;
  }
  if (state.remoteSearchPruneTimer) {
    window.clearTimeout(state.remoteSearchPruneTimer);
    state.remoteSearchPruneTimer = null;
  }
  elements.remoteSearchStage.classList.remove("is-flip-pruned");
  if (state.remoteSearchFlipFrame) {
    window.cancelAnimationFrame(state.remoteSearchFlipFrame);
    state.remoteSearchFlipFrame = null;
    elements.remoteSearchStage.classList.remove("is-preparing-flip", "is-flip-pruned");
  }

  const applySearchStageClass = (activeView) => {
    elements.remoteSearchStage.classList.toggle("is-browse-view", activeView === "browse");
    elements.remoteSearchStage.classList.toggle("is-lark-view", activeView === "lark");
  };
  const clearFlip = () => {
    elements.remoteSearchStage?.classList.remove("is-flipping", "is-preparing-flip", "is-flip-pruned");
    elements.remoteSearchStage?.removeAttribute("data-previous-view");
    elements.remoteSearchStage?.removeAttribute("data-next-view");
    elements.remoteSearchStage?.removeAttribute("data-skipped-view");
    state.remoteSearchFlipTimer = null;
  };

  if (isInitialRender) {
    const initialAngles = { search: 0, browse: -120, lark: 120 };
    state.remoteSearchStageAngle = initialAngles[nextView] ?? 0;
    if (elements.remoteSearchStageInner) {
      elements.remoteSearchStageInner.style.transform = `rotateY(${state.remoteSearchStageAngle}deg)`;
    }
    applySearchStageClass(nextView);
    elements.remoteSearchStage.classList.remove("is-flipping", "is-preparing-flip", "is-flip-pruned");
    elements.remoteSearchStage.removeAttribute("data-previous-view");
    elements.remoteSearchStage.removeAttribute("data-next-view");
    elements.remoteSearchStage.removeAttribute("data-skipped-view");
    return;
  }

  const searchViewOrder = ["search", "browse", "lark"];
  const previousIndex = searchViewOrder.indexOf(previousView);
  const nextIndex = searchViewOrder.indexOf(nextView);
  const forwardSteps = (nextIndex - previousIndex + searchViewOrder.length) % searchViewOrder.length;
  const skippedView = searchViewOrder.find((candidate) => candidate !== previousView && candidate !== nextView) || "";
  const startAngle = state.remoteSearchStageAngle;
  if (forwardSteps === 1) {
    state.remoteSearchStageAngle -= 120;
  } else if (forwardSteps === 2) {
    state.remoteSearchStageAngle += 120;
  }

  elements.remoteSearchStage.dataset.previousView = previousView;
  elements.remoteSearchStage.dataset.nextView = nextView;
  if (skippedView) {
    elements.remoteSearchStage.dataset.skippedView = skippedView;
  } else {
    elements.remoteSearchStage.removeAttribute("data-skipped-view");
  }
  elements.remoteSearchStage.classList.add("is-preparing-flip", "is-flipping");
  if (elements.remoteSearchStageInner) {
    elements.remoteSearchStageInner.style.transform = `rotateY(${startAngle}deg)`;
    elements.remoteSearchStageInner.getBoundingClientRect();
  }
  state.remoteSearchFlipFrame = window.requestAnimationFrame(() => {
    state.remoteSearchFlipFrame = null;
    elements.remoteSearchStage?.classList.remove("is-preparing-flip");
    if (elements.remoteSearchStageInner) {
      elements.remoteSearchStageInner.style.transform = `rotateY(${state.remoteSearchStageAngle}deg)`;
    }
  });
  state.remoteSearchPruneTimer = window.setTimeout(() => {
    state.remoteSearchPruneTimer = null;
    elements.remoteSearchStage?.classList.add("is-flip-pruned");
    applySearchStageClass(nextView);
  }, 150);
  state.remoteSearchFlipTimer = window.setTimeout(clearFlip, 420);
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
  const searchInner = elements.remoteSearchStage?.querySelector(".remote-search-stage-inner");
  if (searchInner) {
    elements.remoteSearchStageInner = searchInner;
    elements.followBrowseView?.classList.remove("hidden");
    elements.followBrowseView?.classList.add("remote-search-face", "remote-search-face-back", "follow-browser");
    elements.larkSearchView?.classList.add("remote-search-face", "remote-search-face-lark");
    if (elements.followBrowseView && elements.followBrowseView.parentElement !== searchInner) {
      searchInner.insertBefore(elements.followBrowseView, elements.larkSearchView || null);
    }
  }

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

async function apiPost(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: clientHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || t("error.requestFailed"));
    error.status = response.status;
    error.code = data.code || "";
    error.payload = data;
    throw error;
  }
  return data.data;
}

function filenameFromContentDisposition(headerValue, fallback) {
  const value = String(headerValue || "");
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }
  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch ? plainMatch[1].trim() : fallback;
}

function selectedHistoryExportSource() {
  const source = String(elements.historyExportSource?.value || "played").trim().toLowerCase();
  return source === "history" ? "history" : "played";
}

function selectedHistoryExportPageSize() {
  const pageSize = Number.parseInt(String(elements.historyExportPageSize?.value || "200"), 10);
  return [200, 150, 100, 80, 60, 50].includes(pageSize) ? pageSize : 200;
}

async function downloadHistoryExport(format, source = selectedHistoryExportSource(), pageSize = selectedHistoryExportPageSize()) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  const normalizedSource = source === "history" ? "history" : "played";
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
  const response = await fetch(`/api/playlist/export?${params.toString()}`, {
    cache: "no-store",
    headers: clientHeaders(),
  });
  if (!response.ok) {
    let message = t("history.exportFailed");
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      // Keep the generic message when the response is not JSON.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const sourceName = normalizedSource === "played" ? "played" : "history";
  const fallback = normalizedFormat === "csv" ? `bilikara-${sourceName}.csv` : `bilikara-${sourceName}.png`;
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

async function exportHistory(format) {
  const source = selectedHistoryExportSource();
  const pageSize = selectedHistoryExportPageSize();
  const sourceLabel = source === "played" ? t("history.playedSource") : t("history.allSource");
  setAppMessage(format === "csv"
    ? t("remote.exportingCsv", { source: sourceLabel })
    : t("remote.exportingImagePaged", { source: sourceLabel, count: pageSize }));
  try {
    await downloadHistoryExport(format, source, pageSize);
    setAppMessage(format === "csv"
      ? t("history.csvDownloadStarted", { source: sourceLabel })
      : t("history.imageDownloadStarted", { source: sourceLabel }));
  } catch (error) {
    setAppMessage(error.message, true);
  }
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
    throw new Error(payload.error || t("error.stateFailed"));
  }
  applyStateSnapshot(payload.data, { forceRender: force || !state.data });
}

async function refreshCacheStatusOnly() {
  try {
    const response = await fetch("/api/state", { headers: clientHeaders() });
    const payload = await response.json();
    if (response.ok && payload.ok && payload.data) {
      state.data = payload.data;
      const current = state.data.current_item;
      if (current) {
        renderCurrentPlaybackState(current);
        if (current.cache_status === "downloading" || current.cache_status === "queued" || current.cache_status === "waiting") {
          state.autoRefreshTimer = setTimeout(refreshCacheStatusOnly, 1000);
          return;
        }
      }
    }
  } catch (e) {
    // 静默失败
  }
  state.autoRefreshTimer = null;
}
function currentStateRevision(snapshot = state.data) {
  const revision = Number(snapshot?.state_revision || 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function renderSignatureForSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return "";
  }
  const { player_status: _playerStatus, state_revision: _stateRevision, ...renderedData } = snapshot;
  return JSON.stringify(renderedData);
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
  const nextRenderSignature = renderSignatureForSnapshot(snapshot);
  const shouldRender = forceRender
    || !state.data
    || nextRenderSignature !== state.dataRenderSignature;
  state.data = snapshot;
  
  // 简单的渲染防抖，合并 50ms 内的多次状态变更（如切歌时的密集事件）
  if (shouldRender) {
    state.dataRenderSignature = nextRenderSignature;
    scheduleRender();
  } else if (!state.renderDebounceTimer) {
    renderPlaybackStatusOnly();
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
    throw new Error(payload.error || t("error.searchFailed"));
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
    throw new Error(payload.error || t("error.larkSearchFailed"));
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
    throw new Error(payload.error || t("error.larkSearchFailed"));
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
    throw new Error(payload.error || t("error.browseFailed"));
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

function gatchaTaskBusyMessage() {
  return state.data?.gatcha?.message || t("gatcha.busyFallback");
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
  const detail = task.last_error ? `${task.last_message || fallback} ${task.last_error}` : task.last_message || fallback;
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

function createSearchResultUrlLine(item) {
  const line = document.createElement("div");
  line.className = "search-result-url";

  const bvid = document.createElement("span");
  bvid.className = "search-result-bvid";
  bvid.textContent = String(item?.bvid || item?.url || "");
  line.appendChild(bvid);

  const ownerName = searchResultOwnerName(item);
  if (ownerName) {
    const owner = document.createElement("span");
    owner.className = "search-result-owner";
    owner.textContent = t("owner.tooltip", { name: ownerName });
    line.appendChild(owner);
  }

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

function setFollowBrowseMessage(message, isError = false) {
  if (!elements.followBrowseMessage) {
    return;
  }
  elements.followBrowseMessage.textContent = message || "";
  elements.followBrowseMessage.classList.toggle("is-error", Boolean(isError));
  elements.followBrowseMessage.classList.toggle("hidden", !message);
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

function renderFollowSongResults(items, emptyText) {
  if (!elements.followSongResults) {
    return;
  }
  elements.followSongResults.innerHTML = "";
  elements.followSongResults.classList.remove("hidden");

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = emptyText;
    elements.followSongResults.appendChild(empty);
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

    const url = createSearchResultUrlLine(item);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.dataset.url = String(item.url || "");
    button.textContent = t("search.add");

    meta.append(title, url);
    row.append(meta, button);
    elements.followSongResults.appendChild(row);
  });
}

function renderFollowBrowse() {
  if (!elements.followBrowseView || !elements.followUpGrid || !elements.followSongResults) {
    return;
  }

  const showFollow = Boolean(state.followBrowseVisible);
  const showLark = Boolean(state.larkSearchVisible);
  setRemoteSearchStageView(showFollow ? "browse" : showLark ? "lark" : "search");
  if (elements.followBrowseToggle) {
    elements.followBrowseToggle.textContent = showFollow ? t("search.followBrowseBack") : t("search.followBrowse");
    elements.followBrowseToggle.setAttribute("aria-pressed", String(showFollow));
  }
  if (elements.larkSearchToggle) {
    elements.larkSearchToggle.textContent = showLark ? t("search.larkBack") : t("search.larkSearch");
    elements.larkSearchToggle.setAttribute("aria-pressed", String(showLark));
  }
  if (elements.searchTag) {
    elements.searchTag.textContent = showLark ? t("search.larkTag") : showFollow ? t("search.followTag") : t("search.localTag");
  }
  if (elements.searchTitle) {
    elements.searchTitle.textContent = showLark ? t("search.larkSearch") : showFollow ? t("follow.title") : t("search.title");
  }
  if (!state.followBrowseVisible) {
    return;
  }

  const owners = Array.isArray(state.followBrowseData?.owners) ? state.followBrowseData.owners : [];
  const items = Array.isArray(state.followBrowseData?.items) ? state.followBrowseData.items : [];
  const signature = JSON.stringify({
    language: state.language,
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
        elements.followUpGrid.appendChild(button);
      });
    }
    setFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingOwners") : "");
    return;
  }

  const owner = selectedFollowOwner();
  if (elements.followBrowseTitle) {
    elements.followBrowseTitle.textContent = followOwnerDisplayName(owner) || `UID ${state.followBrowseSelectedUid}`;
  }
  if (elements.followBrowseCount) {
    const totalCount = Number(owner?.count || items.length || 0);
    elements.followBrowseCount.textContent = t("follow.itemCount", { shown: items.length, total: totalCount });
  }
  renderFollowSongResults(
    items,
    state.followBrowseLoading ? t("follow.loadingItems") : t("follow.noItems"),
  );
  setFollowBrowseMessage(state.followBrowseLoading ? t("follow.loadingItems") : "");
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

async function refreshFollowBrowseAfterGatchaUidAdd(uid = "") {
  state.followBrowseRenderSignature = "";
  const currentUid = String(state.followBrowseSelectedUid || "").trim();
  const nextUid = currentUid || String(uid || "").trim();
  await loadFollowBrowse({ uid: nextUid, query: "", keepQuery: false });
}

async function handleGatchaDraw() {
  state.gatchaUidVisible = false;
  renderGatchaUidView();
  setGatchaMessage(t("gatcha.drawing"));
  try {
    const response = await fetch("/api/gatcha/candidate", { headers: clientHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || t("gatcha.drawFailed"));
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
  if (taskBusy) {
    if (elements.refreshGatchaCacheButton) {
      elements.refreshGatchaCacheButton.textContent = t("gatcha.globalCooldown");
    }
    if (elements.pullGatchaFavlistButton) {
      elements.pullGatchaFavlistButton.textContent = t("gatcha.globalCooldown");
    }
  }
}

async function handleGatchaUidSubmit(event) {
  event.preventDefault();
  const uid = String(elements.gatchaUidInput?.value || "").trim();
  if (!uid) {
    setGatchaUidMessage(t("gatcha.uidRequired"), true);
    return;
  }
  if (state.gatchaUidSaving) {
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidMessage(gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }

  state.gatchaUidSaving = true;
  renderGatchaUidView();
  setGatchaUidMessage(t("gatcha.checkingUid"));
  try {
    const preview = await previewGatchaUid(uid);
    const ownerName = preview?.name || `UID ${preview?.uid || uid}`;
    const modeLabel = preview?.cache_mode_label || (preview?.cache_mode === "incremental" ? t("gatcha.latestMode") : t("gatcha.allMode"));
    const followedPrefix = preview?.already_followed ? t("gatcha.alreadyFollowedPrefix") : "";
    setGatchaUidMessage(t("gatcha.detectedOwner", { prefix: followedPrefix, owner: ownerName }));

    if (!window.confirm(t("gatcha.confirmPullOwner", { owner: ownerName, mode: modeLabel }))) {
      setGatchaUidMessage(t("remote.uidAddCancelled"));
      return;
    }

    const normalizedUid = preview?.uid || uid;
    if (gatchaTaskBusy()) {
      setGatchaUidMessage(gatchaTaskBusyMessage(), true);
      renderGatchaUidView();
      return;
    }
    setGatchaUidMessage(t("gatcha.pullingOwnerItems", { name: ownerName }));
    const result = await addGatchaUid(normalizedUid);
    setGatchaUidMessage(gatchaUidResultMessage(result, normalizedUid));
    if (elements.gatchaUidInput) {
      elements.gatchaUidInput.value = "";
    }
    await refreshFollowBrowseAfterGatchaUidAdd(result?.uid || normalizedUid);
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaUidSaving = false;
    renderGatchaUidView();
  }
}

function render() {
  const data = state.data;
  if (!data) {
    return;
  }
  const playbackMode = frontendPlaybackMode(data.playback_mode);

  renderRequesterSelect(data.session_users || []);
  renderCurrentItem(data.current_item, playbackMode);
  renderAudioVariantBar(data.current_item, playbackMode);
  renderPlayerControls(data.current_item, playbackMode);
  renderRemoteAvSyncControls(playbackMode, data.player_settings);
  renderRemoteVolumeControls(playbackMode, data.player_settings);
  renderRemoteAccess(data.remote_access);
  renderFollowBrowse();
  renderListHeader(data.playlist || [], data.history || []);
  renderQueue(Array.isArray(data.playlist) ? data.playlist : []);
  renderHistory(Array.isArray(data.history) ? data.history : []);
  syncListView();
  renderLayoutMode();
  renderGatchaUidView();
}

function frontendPlaybackMode(_mode) {
  return "local";
}

function renderRequesterSelect(sessionUsers) {
  const users = Array.isArray(sessionUsers) ? sessionUsers : [];
  const signature = JSON.stringify({ language: state.language, users });
  if (signature === state.requesterSelectRenderSignature) {
    return;
  }
  state.requesterSelectRenderSignature = signature;

  const previousValue = selectedRequesterName();
  elements.requesterSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = users.length ? t("session.selectRequester") : t("remote.addUserFirst");
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
      elements.currentOwner.textContent = ownerText;
      elements.currentOwner.classList.toggle("hidden", !ownerText);
      elements.currentMeta.textContent = ""; // 不显示 log 避免高度抖动
    }
    
    renderCurrentPlaybackState(current);
    elements.currentCacheState.classList.remove("hidden");
    
    if (current.cache_status === "downloading" || current.cache_status === "queued" || current.cache_status === "waiting") {
      if (!state.autoRefreshTimer) {
        state.autoRefreshTimer = setTimeout(refreshCacheStatusOnly, 1000);
      }
    } else if (state.autoRefreshTimer) {
      clearTimeout(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
    
    elements.currentCacheState.classList.toggle("ready", current.cache_status === "ready");
    elements.currentCacheState.classList.toggle("failed", current.cache_status === "failed");
    elements.currentMeta.textContent = ""; // 不显示 log 避免高度抖动
    return;
  }

  if (state.currentNowPlayingSignature !== "__empty__") {
    state.currentNowPlayingSignature = "__empty__";
    clearCurrentPlaybackClock();
    elements.currentTitle.textContent = t("remote.noCurrentSong");
    elements.currentRequester.textContent = "";
    elements.currentRequester.classList.add("hidden");
    if (elements.currentOwner) {
      elements.currentOwner.textContent = "";
      elements.currentOwner.classList.add("hidden");
    }
    elements.currentCacheState.textContent = "";
    elements.currentCacheState.classList.add("hidden");
    elements.currentCacheState.classList.remove("ready", "failed");
    elements.currentMeta.textContent = t("remote.noCurrentHint");
  }
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
  toggleButton.setAttribute("aria-label", state.audioVariantBarExpanded ? t("player.collapseParts") : t("player.expandParts"));
  toggleButton.innerHTML = '<span aria-hidden="true">▾</span>';

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
  if (elements.remoteAvOffsetResetButton) {
    elements.remoteAvOffsetResetButton.disabled = offsetMs === 0;
  }
  if (document.activeElement !== elements.remoteAvOffsetInput) {
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
  elements.bindingSheetText.textContent = t("binding.videoHasParts", { title: payload.title || t("binding.thisVideo") });
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

function openGatchaFavlistSheet(uid, payload) {
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];
  if (!folders.length) {
    setGatchaUidMessage(t("favlist.none"), true);
    return;
  }
  state.gatchaFavlistIntent = { uid, folders };
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
  const folderIds = selectedGatchaFavlistFolderIds();
  if (!folderIds.length) {
    setGatchaUidMessage(t("favlist.selectAtLeastOne"), true);
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidMessage(gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }

  state.gatchaFavlistSaving = true;
  renderGatchaUidView();
  setGatchaUidMessage(t("favlist.pullingSelected"));
  try {
    const result = await pullGatchaFavlist(intent.uid, folderIds);
    closeGatchaFavlistSheet();
    setGatchaUidMessage(t("favlist.pullResult", {
      folders: result?.matched_folder_count || 0,
      items: result?.item_count || 0,
    }));
  } catch (error) {
    setGatchaUidMessage(error.message, true);
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
    return;
  }
  if (!selectedAudioPages.length) {
    setMessageForSource(source, t("binding.selectAudioPart"), true);
    return;
  }

  state.submitting = true;
  setMessageForSource(source, intent.position === "next" ? t("remote.bindingAddingNext") : t("remote.bindingAddingTail"));
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
    if (intent.clearInput) {
      elements.urlInput.value = "";
    }
    if (intent.source === "search") {
      hideSearchResults();
      elements.searchQuery.value = "";
    }
    if (intent.source === "lark") {
      hideLarkSearchResults();
      if (elements.larkSearchQuery) {
        elements.larkSearchQuery.value = "";
      }
    }
    if (intent.source === "follow") {
      setFollowBrowseMessage("");
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
  renderRemoteAvSyncControls(frontendPlaybackMode(state.data?.playback_mode), state.data?.player_settings);
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

function clearPlayerControlStatusSync() {
  state.playerControlStatusSync = null;
  clearPlayerControlStatusRefreshTimers();
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
  if (!currentItem || String(currentItem.id || "") !== sync.itemId) {
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
  const timers = playerControlStatusRefreshDelaysMs.map((delayMs) => (
    window.setTimeout(async () => {
      if (!state.playerControlStatusSync) {
        return;
      }
      await fetchState({ force: true }).catch(() => {});
      const currentItem = state.data?.current_item;
      playerControlStatusSyncPending(currentItem);
      renderAfterPlayerControlStatusSync();
    }, delayMs)
  ));
  timers.push(window.setTimeout(() => {
    if (!state.playerControlStatusSync) {
      return;
    }
    clearPlayerControlStatusSync();
    renderAfterPlayerControlStatusSync();
  }, playerControlStatusSyncTimeoutMs));
  state.playerControlStatusRefreshTimers = timers;
}

function beginPlayerControlStatusSync(currentItem) {
  const itemId = String(currentItem?.id || "").trim();
  if (!itemId) {
    clearPlayerControlStatusSync();
    return;
  }
  state.playerControlStatusSync = {
    itemId,
    updatedAfter: playerStatusUpdatedAt(currentPlayerStatus(currentItem)),
    expiresAt: Date.now() + playerControlStatusSyncTimeoutMs,
  };
  schedulePlayerControlStatusRefresh();
}

function renderPlayerControls(currentItem, playbackMode) {
  if (!currentItem) {
    state.playerControlsRenderSignature = "__empty__";
    elements.playerControlPanel.classList.add("hidden");
    elements.playerControlHint.textContent = "";
    return;
  }

  const canControl = canRemoteControlPlayer(currentItem, playbackMode);
  const playerStatus = currentPlayerStatus(currentItem);
  const isPaused = Boolean(playerStatus?.is_paused);
  const controlSignature = JSON.stringify({
    itemId: currentItem.id || "",
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
    toggleButton.textContent = isPaused ? t("remote.play") : t("remote.pause");
    toggleButton.classList.toggle("is-paused", isPaused);
    toggleButton.classList.toggle("is-playing", !isPaused);
  }

  if (playbackMode !== "local") {
    elements.playerControlHint.textContent = t("remote.controlUnsupported");
    return;
  }
  if (!hasLocalSplitMedia(currentItem)) {
    elements.playerControlHint.textContent = t("remote.controlCachePending");
    return;
  }
  elements.playerControlHint.textContent = isPaused
    ? t("remote.controlPausedHint")
    : t("remote.controlPlayingHint");
}

function renderListHeader(playlist, history) {
  const isHistoryView = state.listView === "history";
  const signature = JSON.stringify({
    view: state.listView,
    playlistLength: playlist.length,
    historyLength: history.length,
  });
  if (signature === state.listHeaderRenderSignature) {
    return;
  }
  state.listHeaderRenderSignature = signature;

  elements.listTag.textContent = isHistoryView ? t("history.tag") : t("list.tag");
  elements.listTitle.textContent = isHistoryView ? t("history.title") : t("list.title");
  elements.listCount.textContent = t("follow.countSongs", { count: isHistoryView ? history.length : playlist.length });

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

function renderQueue(playlist) {
  const signature = JSON.stringify(playlist || []);
  if (signature === state.queueRenderSignature) {
    return;
  }
  state.queueRenderSignature = signature;

  elements.queueList.innerHTML = "";
  if (!playlist.length) {
    elements.queueList.innerHTML = `<div class="queue-empty">${htmlT("remote.queueEmpty")}</div>`;
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
    return t("status.ready");
  }
  if (item.cache_status === "downloading") {
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

function currentCacheStateLabel(item) {
  if (!item) {
    return "";
  }
  if (item.cache_status === "downloading") {
    const message = String(item.cache_message || "").trim();
    if (message) {
      return message;
    }
    const size = Number(item.cache_size_bytes || 0);
    return size > 0 ? t("status.cachingWithSize", { size: formatBytes(size) }) : t("status.caching");
  }
  return queueStateLabel(item);
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
  const durationSeconds = Math.max(0, Number(state.currentPlaybackClockDurationSeconds || 0));
  if (!(durationSeconds > 0)) {
    return "";
  }
  const baseSeconds = Math.max(0, Number(state.currentPlaybackClockBaseSeconds || 0));
  const elapsedSeconds = state.currentPlaybackClockPaused
    ? 0
    : Math.max(0, (Date.now() - Number(state.currentPlaybackClockStartedAt || Date.now())) / 1000);
  const currentSeconds = Math.min(durationSeconds, baseSeconds + elapsedSeconds);
  return `${formatPlaybackClockSeconds(currentSeconds)} / ${formatPlaybackClockSeconds(durationSeconds)}`;
}

function paintCurrentPlaybackClock() {
  const text = currentPlaybackClockText();
  if (!text || !elements.currentCacheState) {
    return;
  }
  if (elements.currentCacheState.textContent !== text) {
    elements.currentCacheState.textContent = text;
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
    if (elements.currentCacheState) {
      elements.currentCacheState.textContent = currentCacheStateLabel(current);
    }
    return;
  }

  const playerStatus = currentPlayerStatus(current);
  const durationSeconds = Number(playerStatus?.duration || 0);
  const currentSeconds = Math.max(0, Number(playerStatus?.current_time || 0));
  const isPaused = Boolean(playerStatus?.is_paused);
  const waitingForHostStatus = playerControlStatusSyncPending(current, playerStatus);
  if (!(durationSeconds > 0) || (!currentSeconds && isPaused)) {
    clearCurrentPlaybackClock();
    if (elements.currentCacheState) {
      elements.currentCacheState.textContent = currentCacheStateLabel(current);
    }
    return;
  }

  const signature = [
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
    history: history || [],
    openHistoryMenuId: state.openHistoryMenuId || "",
  });
  if (signature === state.historyRenderSignature) {
    return;
  }
  state.historyRenderSignature = signature;

  elements.historyList.innerHTML = "";

  if (!history.length) {
    elements.historyList.innerHTML =
      `<div class="queue-empty"><p>${htmlT("history.emptyTitle")}</p><p>${htmlT("history.emptyHint")}</p></div>`;
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
    return;
  }
  if (!requesterName) {
    setMessageForSource(source, t("session.requireRequester"), true);
    return;
  }

  state.submitting = true;
  setMessageForSource(source, t("remote.addingSelected"));
  try {
    const result = await submitAddRequestWithDuplicateConfirm(url, position, requesterName);
    if (result.cancelled) {
      setMessageForSource(source, t("remote.cancelledDuplicate"));
      return;
    }
    applyStateSnapshot(result.data, { forceRender: true });
    if (source === "search") {
      hideSearchResults();
      elements.searchQuery.value = "";
    }
    if (source === "lark") {
      hideLarkSearchResults();
      if (elements.larkSearchQuery) {
        elements.larkSearchQuery.value = "";
      }
    }
    if (source === "gatcha") {
      state.gatchaCandidate = null;
      renderGatchaUidView();
    }
    setMessageForSource(source, t("request.success"));
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
      return;
    }
    setMessageForSource(source, error.message, true);
  } finally {
    state.submitting = false;
  }
}

async function sendPlayerControl(action, deltaSeconds = 0) {
  const currentItem = state.data?.current_item;
  const playbackMode = frontendPlaybackMode(state.data?.playback_mode);
  if (!currentItem || !canRemoteControlPlayer(currentItem, playbackMode)) {
    return;
  }

  const message = action === "toggle-play"
    ? t("remote.controlSentToggle")
    : deltaSeconds > 0
      ? t("remote.controlSentForward")
      : t("remote.controlSentBack");

  try {
    state.playerControlPendingAction = action;
    beginPlayerControlStatusSync(currentItem);
    renderCurrentPlaybackState(currentItem);
    renderPlayerControls(currentItem, playbackMode);
    applyStateSnapshot(await apiPost("/api/player/control", {
      action,
      item_id: currentItem.id,
      delta_seconds: deltaSeconds,
    }));
    setFormMessage(message);
  } catch (error) {
    clearPlayerControlStatusSync();
    setFormMessage(error.message, true);
    await fetchState().catch(() => {});
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
}

async function sendPlayerNext() {
  if (!state.data?.current_item) {
    return;
  }
  try {
    state.playerControlPendingAction = "next-track";
    renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
    applyStateSnapshot(await apiPost("/api/player/next"));
    setFormMessage(t("remote.nextSent"));
  } catch (error) {
    setFormMessage(error.message, true);
    await fetchState().catch(() => {});
  }
  state.playerControlPendingAction = "";
  renderPlayerControls(state.data?.current_item, frontendPlaybackMode(state.data?.playback_mode));
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
  if (!button) {
    return;
  }
  await addByUrl(String(button.dataset.url || ""), "tail", "search");
});

elements.larkSearchToggle?.addEventListener("click", () => {
  state.followBrowseVisible = false;
  state.larkSearchVisible = !state.larkSearchVisible;
  renderFollowBrowse();
});

elements.larkSearchForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = String(elements.larkSearchQuery?.value || "").trim();
  if (!query) {
    hideLarkSearchResults();
    setLarkSearchMessage(t("search.keywordRequired"), true);
    return;
  }

  state.larkSearchLoading = true;
  if (elements.larkSearchButton) {
    elements.larkSearchButton.disabled = true;
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
      appendLarkSearchResults(freshItems);
    }
    if (state.larkSearchSeq !== searchSeq) {
      return;
    }
    if (!collectedItems.length) {
      renderLarkSearchResults([]);
    }
    setLarkSearchMessage(
      collectedItems.length
        ? partialFailure
          ? t("search.larkFoundPartial", { count: collectedItems.length })
          : t("search.larkFound", { count: collectedItems.length })
        : partialFailure
          ? t("search.larkPartialNoResults")
          : t("search.larkNoResults"),
      partialFailure && !collectedItems.length,
    );
  } catch (error) {
    hideLarkSearchResults();
    setLarkSearchMessage(error.message, true);
  } finally {
    if (state.larkSearchSeq === searchSeq) {
      state.larkSearchLoading = false;
      if (elements.larkSearchButton) {
        elements.larkSearchButton.disabled = false;
      }
    }
  }
});

elements.larkSearchResults?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button) {
    return;
  }
  await addByUrl(String(button.dataset.url || ""), "tail", "lark");
});

elements.followBrowseToggle?.addEventListener("click", () => {
  state.larkSearchVisible = false;
  state.followBrowseVisible = !state.followBrowseVisible;
  renderFollowBrowse();
  if (state.followBrowseVisible && !state.followBrowseLoading) {
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
    await addByUrl(url, "tail", "follow");
  } finally {
    button.disabled = false;
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

elements.layoutModeSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-layout-mode]");
  if (!button) {
    return;
  }
  setLayoutMode(button.dataset.layoutMode);
});

elements.languageSwitch?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-language]");
  if (!button) {
    return;
  }
  setLanguage(button.dataset.language);
});

elements.remoteQrToggle?.addEventListener("click", () => {
  setRemoteQrPopoverOpen(!state.remoteQrPopoverOpen);
});

elements.remoteQrPopoverClose?.addEventListener("click", () => {
  setRemoteQrPopoverOpen(false);
});

document.addEventListener("click", (event) => {
  if (!state.remoteQrPopoverOpen) {
    return;
  }
  if (event.target.closest("#remote-qr-control")) {
    return;
  }
  setRemoteQrPopoverOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setRemoteQrPopoverOpen(false);
  }
});

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
  const button = event.target.closest("button[data-av-step], button[data-reset-av-offset]");
  if (!button) {
    return;
  }
  if (button.disabled) {
    return;
  }
  if (button.hasAttribute("data-reset-av-offset")) {
    await setRemoteAvOffset(0);
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

elements.gatchaUidToggle?.addEventListener("click", () => {
  state.gatchaUidVisible = !state.gatchaUidVisible;
  renderGatchaUidView();
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
  const uid = String(elements.gatchaUidInput?.value || "").trim();
  if (!uid) {
    setGatchaUidMessage(t("gatcha.uidRequired"), true);
    return;
  }
  if (gatchaTaskBusy()) {
    setGatchaUidMessage(gatchaTaskBusyMessage(), true);
    renderGatchaUidView();
    return;
  }
  state.gatchaFavlistSaving = true;
  renderGatchaUidView();
  setGatchaUidMessage(t("gatcha.readingFavlists"));
  try {
    const result = await previewGatchaFavlist(uid);
    openGatchaFavlistSheet(result?.uid || uid, result);
    setGatchaUidMessage(t("gatcha.chooseFavlists"));
  } catch (error) {
    setGatchaUidMessage(error.message, true);
  } finally {
    state.gatchaFavlistSaving = false;
    renderGatchaUidView();
  }
});

elements.gatchaConfirmButton.addEventListener("click", async () => {
  if (!state.gatchaCandidate?.url) {
    return;
  }
  await addByUrl(String(state.gatchaCandidate.url), "tail", "gatcha");
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
    applyStateSnapshot(await apiPost("/api/player/audio-variant", {
      item_id: currentItem.id,
      variant_id: nextVariantId,
    }));
    const activeItem = state.data?.current_item;
    const activeVariant = activeItem ? selectedAudioVariantForItem(activeItem) : null;
    setFormMessage(t("player.switchedPart", { part: activeVariant?.label || nextVariantId }));
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
  if (state.reorderConfirmSheetOpen) {
    closeReorderConfirmSheet();
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
  setupRemoteFlipStages();
  hydrateLocalPreferences();
  await loadTranslations();
  renderLayoutMode();
  try {
    await fetchState();
  } catch (error) {
    setFormMessage(error.message, true);
  }
  connectStateStream();
}

startRemoteSession();
