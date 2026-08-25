from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HostPlaybackSessionFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")

    @classmethod
    def source_slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_foundation(self, body: str) -> dict:
        equality = self.source_slice(
            "function playbackProgramDescriptorsEqual",
            "function isValidHostMediaLocator",
        )
        listener_lifecycle = self.source_slice(
            "function clearLocalPlayerEventListeners",
            "function clearLocalPlayerSeekState",
        )
        seek_cleanup = self.source_slice(
            "function takeLocalPlayerSeekCompletion",
            "function playerDelayOverlay",
        )
        foundation = self.source_slice(
            "function hostPlaybackMountData",
            "function renderPlayer",
        )
        recovery = self.source_slice(
            "async function restartHostPlaybackAfterBootstrap",
            "startPolling();",
        )
        resets = self.source_slice(
            "async function resetRuntimeData",
            "async function installAppUpdate",
        )
        script = f"""
const windowListeners = {{}};
class FakeNode {{
  constructor(tagName) {{
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {{}};
    this.className = "";
    this.textContent = "";
    this.attributes = {{}};
    this.currentTime = 0;
    this.paused = true;
    this.src = "";
    this.controls = false;
    this.listeners = new Map();
  }}
  append(...nodes) {{ nodes.forEach((node) => {{ node.parentElement = this; this.children.push(node); }}); }}
  appendChild(node) {{ this.append(node); return node; }}
  prepend(...nodes) {{ nodes.reverse().forEach((node) => {{ node.parentElement = this; this.children.unshift(node); }}); }}
  replaceChildren(...nodes) {{
    this.children.forEach((node) => {{ node.parentElement = null; }});
    this.children = [];
    this.append(...nodes);
  }}
  remove() {{
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    this.parentElement = null;
  }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  removeAttribute(name) {{ delete this.attributes[name]; if (name === "src") this.src = ""; }}
  pause() {{ this.paused = true; }}
  load() {{}}
  addEventListener(name, listener) {{
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }}
  removeEventListener(name, listener) {{
    this.listeners.set(
      name,
      (this.listeners.get(name) || []).filter((entry) => entry !== listener),
    );
  }}
  queuedListeners(name) {{ return [...(this.listeners.get(name) || [])]; }}
  dispatchEventName(name) {{
    this.queuedListeners(name).forEach((listener) => listener({{ type: name, target: this }}));
  }}
  querySelector(selector) {{
    if (selector === ".empty-state .empty-hint") {{
      return this.children.flatMap((node) => node.children || []).find((node) => node.className === "empty-hint") || null;
    }}
    return this.children.find((node) => {{
      if (selector.startsWith("video")) return node.tagName === "VIDEO";
      if (selector.startsWith("audio")) return node.tagName === "AUDIO";
      return false;
    }}) || null;
  }}
  querySelectorAll(selector) {{
    if (selector === "video, audio") return this.children.filter((node) => ["VIDEO", "AUDIO"].includes(node.tagName));
    return [];
  }}
}}
const document = {{ createElement: (tagName) => new FakeNode(tagName) }};
const window = {{
  clearTimeout() {{}},
  clearInterval() {{}},
  addEventListener(name, listener) {{ windowListeners[name] = listener; }},
}};
const elements = {{ playerFrame: new FakeNode("div") }};
const state = {{
  data: null,
  language: "en",
  hostPlaybackSession: null,
  hostPlaybackBootstrapRestartPending: false,
  hasValidStateResponse: true,
  pendingPlaybackRestore: null,
  localShouldBePlaying: true,
  localPlayerEventCleanups: [],
  localPlaybackStartState: "idle",
  localPlaybackStartGeneration: 0,
  localPlaybackStartPromisesSettled: false,
  localPlaybackEndHandled: false,
  localPlayerSyncLastSeekAt: 0,
  localPlayerSyncLastAction: "",
  localPlayerSyncLastDiagnosticAt: 0,
  localVideoHeldForAudio: false,
  localVideoDeferredRecovery: false,
  localAudioPlaybackBlocked: false,
  localVideoPlaybackBlocked: false,
  localWebKitStartRetryDone: false,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localPlayerVolume: 0.42,
  localPlayerMuted: true,
  playerSettingsEchoSuppressUntil: 1,
  volumeSaveSeq: 0,
  avOffsetSaving: true,
}};
function selectedVideoUrlForItem(item) {{ return String(item?.video_media_url || ""); }}
function selectedAudioUrlForItem(item) {{
  return String(item?.audio_variants?.find((variant) => variant.id === item.selected_audio_variant_id)?.audio_url || "");
}}
function hostCacheDetailTextForItem(item) {{ return String(item?.cache_message || ""); }}
function t(key) {{ return key; }}
function setTextContent(element, value) {{ element.textContent = String(value); }}
function playerDelayOverlay() {{ return null; }}
function clearWebKitAudioStarvationTimer() {{}}
function clearLocalPlayerSyncTimer() {{}}
function clearLocalPlayerControlsHideTimer() {{}}
function clearPlayerFrameClickTimer() {{}}
function clearTauriMediaSessionState() {{}}
function clearLocalAdvanceDelay() {{}}
function disposeAudioPitchShifter() {{}}
function captureLocalPlayerPreferences() {{}}
const preferenceWrites = [];
function persistLocalVolumePreferences() {{
  preferenceWrites.push([state.localPlayerVolume, state.localPlayerMuted]);
}}
function shouldHoldCurrentItemForTransition() {{ return false; }}
function hasPendingSongTransitionOverlayForItem() {{ return false; }}
function hasLocalAdvanceDelayOverlay() {{ return false; }}
function teardownMountedPlayer() {{
  return retireHostPlaybackSession(state.hostPlaybackSession);
}}
function scheduleConfirmPopoverPositionSync() {{}}
function initializeLocalPresentation() {{ return Promise.resolve(); }}
function renderVolumeControls() {{}}
function frontendPlaybackMode() {{ return "local"; }}
let sharedAudioContextDisposals = 0;
function disposeSharedAudioContext() {{ sharedAudioContextDisposals += 1; }}
function teardownLocalPresentationListeners() {{}}
function disconnectClient() {{}}
function setAppMessage() {{}}
function closeConfirm() {{}}
function dismissBackupBanner() {{}}
let apiPostStateSnapshotImpl = async () => false;
async function apiPostStateSnapshot(...args) {{
  const accepted = await apiPostStateSnapshotImpl(...args);
  if (accepted && typeof args[2]?.onAccepted === "function") {{
    args[2].onAccepted();
  }}
  return accepted;
}}
let renderImpl = () => {{}};
function render() {{ renderImpl(); }}
{listener_lifecycle}
{seek_cleanup}
{equality}
{foundation}
{recovery}
{resets}

function item({{
  itemId = "song-a",
  incarnation = "i-a",
  variantId = "instrumental",
  artifactId = "a-1",
  mountable = true,
  cacheMessage = "ready",
}} = {{}}) {{
  return {{
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: mountable ? variantId : "",
    artifact_set_id: mountable ? artifactId : "",
    video_media_url: mountable ? `/media/${{artifactId}}/video.mp4` : "",
    audio_variants: mountable ? [{{ id: variantId, audio_url: `/media/${{artifactId}}/${{variantId}}.m4a` }}] : [],
    cache_message: cacheMessage,
  }};
}}
function installSnapshot(generation, current, extras = {{}}) {{
  state.data = {{
    playback_generation: generation,
    playback_program: current ? {{
      item_id: current.id,
      item_incarnation_id: current.item_incarnation_id,
      selected_audio_variant_id: current.selected_audio_variant_id,
      artifact_set_id: current.artifact_set_id || null,
    }} : null,
    current_item: current,
    ...extras,
  }};
}}
function counts() {{
  return {{
    video: elements.playerFrame.children.filter((node) => node.tagName === "VIDEO").length,
    audio: elements.playerFrame.children.filter((node) => node.tagName === "AUDIO").length,
  }};
}}
{body}
"""
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_session_state_machine_owns_one_exact_pair(self):
        result = self.run_foundation(
            """
const observations = {};
installSnapshot(1, null);
observations.empty = { kind: reconcileHostPlaybackSession(null).kind, counts: counts() };

const pending = item({ mountable: false, cacheMessage: "queued" });
installSnapshot(2, pending);
const pendingResult = reconcileHostPlaybackSession(pending);
observations.pending = {
  kind: pendingResult.kind,
  state: state.hostPlaybackSession.cleanupState,
  counts: counts(),
};

const firstItem = item();
installSnapshot(3, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
const firstVideo = first.video;
const firstAudio = first.audio;
firstVideo.currentTime = 23.5;
firstVideo.paused = false;
observations.first = { kind: first.kind, counts: counts() };

const rerenderChanges = [
  { language: "ja" }, { theme: "dark" }, { cache_progress: 42 },
  { player_settings: { volume_percent: 55 } }, { playlist: [{ id: "queued" }] },
  { presentation: { composition: "stageOnly" } },
];
observations.rerenders = rerenderChanges.map((change) => {
  installSnapshot(3, { ...firstItem, cache_message: change.cache_progress ? "refreshing" : "ready" }, change);
  const rendered = reconcileHostPlaybackSession(state.data.current_item);
  return {
    kind: rendered.kind,
    sameVideo: rendered.video === firstVideo,
    sameAudio: rendered.audio === firstAudio,
    time: rendered.video.currentTime,
    counts: counts(),
  };
});

const stale = item({ itemId: "song-stale", incarnation: "i-stale", artifactId: "a-stale" });
installSnapshot(2, stale);
const staleResult = reconcileHostPlaybackSession(stale);
observations.stale = {
  kind: staleResult.kind,
  sameVideo: state.hostPlaybackSession.video === firstVideo,
  sameAudio: state.hostPlaybackSession.audio === firstAudio,
  time: firstVideo.currentTime,
  counts: counts(),
};

installSnapshot(4, firstItem);
const reset = reconcileHostPlaybackSession(firstItem);
const resetVideo = reset.video;
const resetAudio = reset.audio;
observations.reset = {
  kind: reset.kind,
  freshVideo: resetVideo !== firstVideo,
  freshAudio: resetAudio !== firstAudio,
  counts: counts(),
};
observations.resetDuplicate = {
  kind: reconcileHostPlaybackSession(firstItem).kind,
  sameVideo: state.hostPlaybackSession.video === resetVideo,
  sameAudio: state.hostPlaybackSession.audio === resetAudio,
  counts: counts(),
};

const variant = item({ variantId: "original" });
installSnapshot(5, variant);
const variantResult = reconcileHostPlaybackSession(variant);
const variantVideo = variantResult.video;
observations.variant = {
  kind: variantResult.kind,
  freshVideo: variantVideo !== resetVideo,
  freshAudio: variantResult.audio !== resetAudio,
  counts: counts(),
};

const recached = item({ variantId: "original", artifactId: "a-2" });
installSnapshot(6, recached);
const artifactResult = reconcileHostPlaybackSession(recached);
const currentSession = state.hostPlaybackSession;
observations.artifact = {
  kind: artifactResult.kind,
  freshVideo: artifactResult.video !== variantVideo,
  counts: counts(),
};
observations.oldRetirement = {
  retiredAgain: retireHostPlaybackSession(first.session),
  pointerPreserved: state.hostPlaybackSession === currentSession,
  pairPreserved: state.hostPlaybackSession.video === artifactResult.video,
  counts: counts(),
};
observations.retirement = {
  first: retireHostPlaybackSession(currentSession),
  second: retireHostPlaybackSession(currentSession),
  state: currentSession.cleanupState,
};
process.stdout.write(JSON.stringify(observations));
"""
        )
        self.assertEqual(result["empty"], {"kind": "empty", "counts": {"video": 0, "audio": 0}})
        self.assertEqual(result["pending"]["kind"], "pending")
        self.assertEqual(result["pending"]["state"], "active")
        self.assertEqual(result["pending"]["counts"], {"video": 0, "audio": 0})
        self.assertEqual(result["first"], {"kind": "mounted", "counts": {"video": 1, "audio": 1}})
        for rerender in result["rerenders"]:
            self.assertEqual(rerender["kind"], "reused")
            self.assertTrue(rerender["sameVideo"])
            self.assertTrue(rerender["sameAudio"])
            self.assertEqual(rerender["time"], 23.5)
            self.assertEqual(rerender["counts"], {"video": 1, "audio": 1})
        self.assertEqual(result["stale"]["kind"], "stale")
        self.assertTrue(result["stale"]["sameVideo"])
        self.assertTrue(result["stale"]["sameAudio"])
        self.assertEqual(result["stale"]["time"], 23.5)
        self.assertEqual(result["stale"]["counts"], {"video": 1, "audio": 1})
        for boundary in ("reset", "variant", "artifact"):
            self.assertEqual(result[boundary]["kind"], "mounted")
            self.assertTrue(result[boundary]["freshVideo"])
            self.assertEqual(result[boundary]["counts"], {"video": 1, "audio": 1})
        self.assertTrue(result["reset"]["freshAudio"])
        self.assertTrue(result["variant"]["freshAudio"])
        self.assertEqual(
            result["resetDuplicate"],
            {
                "kind": "reused",
                "sameVideo": True,
                "sameAudio": True,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["oldRetirement"],
            {
                "retiredAgain": False,
                "pointerPreserved": True,
                "pairPreserved": True,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["retirement"],
            {"first": True, "second": False, "state": "retired"},
        )

    def test_current_session_predicate_requires_authority_and_exact_elements(self):
        result = self.run_foundation(
            """
const current = item();
installSnapshot(7, current);
const mounted = reconcileHostPlaybackSession(current);
const session = mounted.session;
const impostor = { ...session };
const otherVideo = new FakeNode("video");
const checks = {
  current: isCurrentHostPlaybackSession(session),
  exactPair: isCurrentHostPlaybackSession(session, mounted.video, mounted.audio),
  wrongObject: isCurrentHostPlaybackSession(impostor),
  wrongVideo: isCurrentHostPlaybackSession(session, otherVideo, mounted.audio),
};
session.cleanupState = "retiring";
checks.retiring = isCurrentHostPlaybackSession(session, mounted.video, mounted.audio);
session.cleanupState = "active";
state.data.playback_generation = 8;
checks.wrongGeneration = isCurrentHostPlaybackSession(session, mounted.video, mounted.audio);
process.stdout.write(JSON.stringify(checks));
"""
        )
        self.assertEqual(
            result,
            {
                "current": True,
                "exactPair": True,
                "wrongObject": False,
                "wrongVideo": False,
                "retiring": False,
                "wrongGeneration": False,
            },
        )

    def test_queued_media_listener_rechecks_exact_session_before_effects(self):
        result = self.run_foundation(
            """
const firstItem = item();
installSnapshot(7, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
let oldEndedEffects = 0;
addMountedPlayerListener(first.video, "ended", () => {
  oldEndedEffects += 1;
  state.hostPlaybackSession.video.pause();
});
const queuedOldEnded = first.video.queuedListeners("ended");

const secondItem = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
installSnapshot(8, secondItem);
const second = reconcileHostPlaybackSession(secondItem);
second.video.paused = false;
queuedOldEnded.forEach((listener) => listener({ type: "ended", target: first.video }));
const afterRetiredEvent = {
  oldEndedEffects,
  secondPaused: second.video.paused,
  currentSession: state.hostPlaybackSession === second.session,
};

let currentEndedEffects = 0;
addMountedPlayerListener(second.video, "ended", () => {
  currentEndedEffects += 1;
  second.video.pause();
});
second.video.dispatchEventName("ended");
process.stdout.write(JSON.stringify({
  afterRetiredEvent,
  current: { currentEndedEffects, secondPaused: second.video.paused },
}));
"""
        )
        self.assertEqual(
            result,
            {
                "afterRetiredEvent": {
                    "oldEndedEffects": 0,
                    "secondPaused": False,
                    "currentSession": True,
                },
                "current": {"currentEndedEffects": 1, "secondPaused": True},
            },
        )

    def test_retirement_settles_owned_seek_once_without_clearing_new_session(self):
        result = self.run_foundation(
            """
const firstItem = item();
installSnapshot(7, firstItem);
const first = reconcileHostPlaybackSession(firstItem);
const firstSettlements = [];
first.session.seekSettling = true;
first.session.seekSettleTimer = 41;
first.session.seekSettleCallback = (applied) => firstSettlements.push(applied);
const firstRetire = retireHostPlaybackSession(first.session);
const duplicateRetire = retireHostPlaybackSession(first.session);

const secondItem = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
installSnapshot(8, secondItem);
const second = reconcileHostPlaybackSession(secondItem);
const secondSettlements = [];
second.session.seekSettling = true;
second.session.seekSettleTimer = 42;
second.session.seekSettleCallback = (applied) => secondSettlements.push(applied);
const staleCleanup = retireHostPlaybackSession(first.session);
const beforeSecondRetire = {
  currentPreserved: state.hostPlaybackSession === second.session,
  secondSettlements: [...secondSettlements],
  secondSeekTimer: second.session.seekSettleTimer,
};
const secondRetire = retireHostPlaybackSession(second.session);
process.stdout.write(JSON.stringify({
  firstRetire,
  duplicateRetire,
  staleCleanup,
  firstSettlements,
  beforeSecondRetire,
  secondRetire,
  secondSettlements,
}));
"""
        )
        self.assertEqual(
            result,
            {
                "firstRetire": True,
                "duplicateRetire": False,
                "staleCleanup": False,
                "firstSettlements": [False],
                "beforeSecondRetire": {
                    "currentPreserved": True,
                    "secondSettlements": [],
                    "secondSeekTimer": 42,
                },
                "secondRetire": True,
                "secondSettlements": [False],
            },
        )

    def test_player_signature_and_context_are_not_lifetime_authority(self):
        self.assertNotIn("playerSignature", self.source)
        self.assertNotIn("playerContext", self.source)

    def test_bootstrap_restarts_before_mounting_one_current_program_pair(self):
        result = self.run_foundation(
            """
(async () => {
  const current = item();
  installSnapshot(7, current);
  state.hostPlaybackBootstrapRestartPending = true;
  const beforeRestart = reconcileHostPlaybackSession(current);
  const retiredGeneration = state.hostPlaybackSession.playbackGeneration;
  let restartCalls = 0;
  let renderCalls = 0;
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    installSnapshot(8, current);
    return true;
  };
  renderImpl = () => {
    renderCalls += 1;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  const restarted = await restartHostPlaybackAfterBootstrap();
  const mounted = state.hostPlaybackSession;
  const mountedObservation = {
    generation: mounted.playbackGeneration,
    cleanupState: mounted.cleanupState,
    freshPair: Boolean(mounted.video && mounted.audio),
    counts: counts(),
  };
  const duplicate = await restartHostPlaybackAfterBootstrap();

  retireHostPlaybackSession(mounted);
  state.hostPlaybackSession = null;
  installSnapshot(9, null);
  state.hostPlaybackBootstrapRestartPending = true;
  reconcileHostPlaybackSession(null);
  const noCurrent = await restartHostPlaybackAfterBootstrap();
  process.stdout.write(JSON.stringify({
    beforeRestart: beforeRestart.kind,
    retiredGeneration,
    restarted,
    duplicate,
    noCurrent,
    restartCalls,
    renderCalls,
    mounted: mountedObservation,
    finalCounts: counts(),
    pending: state.hostPlaybackBootstrapRestartPending,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result,
            {
                "beforeRestart": "retired",
                "retiredGeneration": 7,
                "restarted": True,
                "duplicate": False,
                "noCurrent": False,
                "restartCalls": 1,
                "renderCalls": 1,
                "mounted": {
                    "generation": 8,
                    "cleanupState": "active",
                    "freshPair": True,
                    "counts": {"video": 1, "audio": 1},
                },
                "finalCounts": {"video": 0, "audio": 0},
                "pending": False,
            },
        )

    def test_page_restore_restarts_rust_program_before_one_fresh_mount(self):
        result = self.run_foundation(
            """
(async () => {
  const current = item();
  installSnapshot(7, current);
  const mounted = reconcileHostPlaybackSession(current);
  const oldSession = mounted.session;
  let restartCalls = 0;
  let renderCalls = 0;
  let retiredBeforeRestart = false;
  let preRestartRenderSuppressed = false;
  let generationSeenByRender = 0;
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    retiredBeforeRestart = oldSession.cleanupState === "retired";
    installSnapshot(8, current);
    render();
    preRestartRenderSuppressed = state.hostPlaybackSession.cleanupState === "retired"
      && state.hostPlaybackSession.playbackGeneration === 8
      && state.hostPlaybackSession.video === null
      && state.hostPlaybackSession.audio === null
      && elements.playerFrame.querySelector("video") === mounted.video
      && elements.playerFrame.querySelector("audio") === mounted.audio;
    installSnapshot(9, current);
    return true;
  };
  renderImpl = () => {
    renderCalls += 1;
    generationSeenByRender = state.data.playback_generation;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  windowListeners.pagehide();
  const afterHide = {
    cleanupState: oldSession.cleanupState,
    restartRequired: state.pageHidePlaybackRestartRequired,
    counts: counts(),
  };
  windowListeners.pageshow();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const newSession = state.hostPlaybackSession;
  const afterShow = {
    restartCalls,
    renderCalls,
    retiredBeforeRestart,
    preRestartRenderSuppressed,
    generationSeenByRender,
    generation: newSession.playbackGeneration,
    freshVideo: newSession.video !== mounted.video,
    freshAudio: newSession.audio !== mounted.audio,
    counts: counts(),
  };
  windowListeners.pageshow();
  await Promise.resolve();
  const afterDuplicateShow = { restartCalls, renderCalls };

  installSnapshot(9, null);
  state.pageHidePlaybackRestartRequired = true;
  const noCurrent = await restartHostPlaybackAfterPageRestore();
  process.stdout.write(JSON.stringify({ afterHide, afterShow, afterDuplicateShow, noCurrent }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result["afterHide"],
            {
                "cleanupState": "retired",
                "restartRequired": True,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["afterShow"],
            {
                "restartCalls": 1,
                "renderCalls": 2,
                "retiredBeforeRestart": True,
                "preRestartRenderSuppressed": True,
                "generationSeenByRender": 9,
                "generation": 9,
                "freshVideo": True,
                "freshAudio": True,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["afterDuplicateShow"],
            {"restartCalls": 1, "renderCalls": 2},
        )
        self.assertFalse(result["noCurrent"])

    def test_page_restore_reconciles_a_newer_accepted_program_after_a_stale_response(self):
        result = self.run_foundation(
            """
(async () => {
  const current = item();
  installSnapshot(7, current);
  const mounted = reconcileHostPlaybackSession(current);
  const oldVideo = mounted.video;
  const oldAudio = mounted.audio;
  let restartCalls = 0;
  let renderCalls = 0;
  let releaseRestart;
  const restartGate = new Promise((resolve) => { releaseRestart = resolve; });
  apiPostStateSnapshotImpl = async (url) => {
    if (url !== "/api/player/restart-program") throw new Error("unexpected route");
    restartCalls += 1;
    installSnapshot(9, current, { state_revision: 9 });
    render();
    await restartGate;
    return false;
  };
  renderImpl = () => {
    renderCalls += 1;
    reconcileHostPlaybackSession(state.data.current_item);
  };

  windowListeners.pagehide();
  const firstRestore = restartHostPlaybackAfterPageRestore();
  const duplicateRestore = await restartHostPlaybackAfterPageRestore();
  releaseRestart();
  const accepted = await firstRestore;
  const newerSession = state.hostPlaybackSession;
  const newer = {
    accepted,
    duplicateRestore,
    restartCalls,
    renderCalls,
    generation: newerSession.playbackGeneration,
    active: newerSession.cleanupState === "active",
    freshVideo: newerSession.video !== oldVideo,
    freshAudio: newerSession.audio !== oldAudio,
    counts: counts(),
  };

  state.pageHidePlaybackRestartRequired = false;
  retireHostPlaybackSession(newerSession);
  state.hostPlaybackSession = null;
  installSnapshot(20, current, { state_revision: 20 });
  reconcileHostPlaybackSession(current);
  let failedCalls = 0;
  apiPostStateSnapshotImpl = async () => {
    failedCalls += 1;
    installSnapshot(20, current, { state_revision: 21, cache_progress: 50 });
    render();
    throw new Error("network failed");
  };
  windowListeners.pagehide();
  const failed = await restartHostPlaybackAfterPageRestore();
  const sameGeneration = {
    failed,
    failedCalls,
    renderCalls,
    generation: state.hostPlaybackSession.playbackGeneration,
    cleanupState: state.hostPlaybackSession.cleanupState,
    videoSrc: state.hostPlaybackSession.video?.src || "",
    audioSrc: state.hostPlaybackSession.audio?.src || "",
    counts: counts(),
  };
  process.stdout.write(JSON.stringify({ newer, sameGeneration }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result["newer"],
            {
                "accepted": False,
                "duplicateRestore": False,
                "restartCalls": 1,
                "renderCalls": 2,
                "generation": 9,
                "active": True,
                "freshVideo": True,
                "freshAudio": True,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["sameGeneration"],
            {
                "failed": False,
                "failedCalls": 1,
                "renderCalls": 3,
                "generation": 20,
                "cleanupState": "retired",
                "videoSrc": "",
                "audioSrc": "",
                "counts": {"video": 1, "audio": 1},
            },
        )

    def test_resets_retire_only_after_an_authoritative_snapshot_is_accepted(self):
        result = self.run_foundation(
            """
(async () => {
  const current = item();
  installSnapshot(7, current, { player_settings: { volume_percent: 42, is_muted: true } });
  const mounted = reconcileHostPlaybackSession(current);
  const oldVideo = mounted.video;
  const oldAudio = mounted.audio;
  oldVideo.currentTime = 18.25;
  oldVideo.paused = false;
  oldAudio.paused = false;
  renderImpl = () => reconcileHostPlaybackSession(state.data.current_item);

  apiPostStateSnapshotImpl = async () => { throw new Error("network failed"); };
  await resetPlayerState();
  const failedPlayerReset = {
    sameSession: state.hostPlaybackSession === mounted.session,
    sameVideo: state.hostPlaybackSession.video === oldVideo,
    sameAudio: state.hostPlaybackSession.audio === oldAudio,
    cleanupState: mounted.session.cleanupState,
    videoPaused: oldVideo.paused,
    audioPaused: oldAudio.paused,
    currentTime: oldVideo.currentTime,
    volume: state.localPlayerVolume,
    muted: state.localPlayerMuted,
    serverVolume: state.data.player_settings.volume_percent,
    serverMuted: state.data.player_settings.is_muted,
    preferenceWrites: preferenceWrites.length,
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => false;
  await resetRuntimeData();
  const failedDataReset = {
    sameSession: state.hostPlaybackSession === mounted.session,
    cleanupState: mounted.session.cleanupState,
    videoPaused: oldVideo.paused,
    audioPaused: oldAudio.paused,
    generation: state.data.playback_generation,
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => {
    installSnapshot(8, current, { player_settings: { volume_percent: 100, is_muted: false } });
    return true;
  };
  await resetPlayerState();
  const resetSession = state.hostPlaybackSession;
  const acceptedPlayerReset = {
    generation: resetSession.playbackGeneration,
    freshVideo: resetSession.video !== oldVideo,
    freshAudio: resetSession.audio !== oldAudio,
    oldRetired: mounted.session.cleanupState,
    volume: state.localPlayerVolume,
    muted: state.localPlayerMuted,
    preferenceWrites: preferenceWrites.length,
    disposals: sharedAudioContextDisposals,
    counts: counts(),
  };

  const newer = item({ itemId: "song-b", incarnation: "i-b", artifactId: "a-b" });
  apiPostStateSnapshotImpl = async () => {
    installSnapshot(9, newer);
    render();
    return false;
  };
  await resetPlayerState();
  const newerSession = state.hostPlaybackSession;
  const stalePlayerReset = {
    generation: newerSession.playbackGeneration,
    itemId: newerSession.playbackProgram.item_id,
    cleanupState: newerSession.cleanupState,
    counts: counts(),
    disposals: sharedAudioContextDisposals,
  };

  apiPostStateSnapshotImpl = async () => {
    installSnapshot(10, null);
    return true;
  };
  await resetRuntimeData();
  const acceptedDataReset = {
    generation: state.data.playback_generation,
    currentItem: state.data.current_item,
    cleanupState: newerSession.cleanupState,
    disposals: sharedAudioContextDisposals,
    counts: counts(),
  };
  process.stdout.write(JSON.stringify({
    failedPlayerReset,
    failedDataReset,
    acceptedPlayerReset,
    stalePlayerReset,
    acceptedDataReset,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result["failedPlayerReset"],
            {
                "sameSession": True,
                "sameVideo": True,
                "sameAudio": True,
                "cleanupState": "active",
                "videoPaused": False,
                "audioPaused": False,
                "currentTime": 18.25,
                "volume": 0.42,
                "muted": True,
                "serverVolume": 42,
                "serverMuted": True,
                "preferenceWrites": 0,
                "disposals": 0,
            },
        )
        self.assertEqual(
            result["failedDataReset"],
            {
                "sameSession": True,
                "cleanupState": "active",
                "videoPaused": False,
                "audioPaused": False,
                "generation": 7,
                "disposals": 0,
            },
        )
        self.assertEqual(
            result["acceptedPlayerReset"],
            {
                "generation": 8,
                "freshVideo": True,
                "freshAudio": True,
                "oldRetired": "retired",
                "volume": 1,
                "muted": False,
                "preferenceWrites": 1,
                "disposals": 1,
                "counts": {"video": 1, "audio": 1},
            },
        )
        self.assertEqual(
            result["stalePlayerReset"],
            {
                "generation": 9,
                "itemId": "song-b",
                "cleanupState": "active",
                "counts": {"video": 1, "audio": 1},
                "disposals": 1,
            },
        )
        self.assertEqual(
            result["acceptedDataReset"],
            {
                "generation": 10,
                "currentItem": None,
                "cleanupState": "retired",
                "disposals": 2,
                "counts": {"video": 0, "audio": 0},
            },
        )


if __name__ == "__main__":
    unittest.main()
