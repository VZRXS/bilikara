from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemoteSseFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        source = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.source = source
        cls.queue_source = (ROOT / "static" / "remote-queue.js").read_text(
            encoding="utf-8"
        )
        start = source.index("function clearEventStreamReconnectTimer")
        end = source.index("function connectStateStream", start)
        cls.reconnect_source = source[start:end]
        start = source.index("function currentPlaybackClockSeconds")
        end = source.index("function flushPendingAutoRating", start)
        cls.clock_value_source = source[start:end]
        start = source.index("function currentPlayerStatus")
        end = source.index("function durationSecondsForItem", start)
        cls.current_status_source = source[start:end]
        start = source.index("function formatPlaybackClockSeconds")
        end = source.index("function formatBytes", start)
        cls.clock_render_source = source[start:end]
        start = source.index("function applyStateSnapshot")
        end = source.index("function clearEventStreamReconnectTimer", start)
        cls.apply_snapshot_source = source[start:end]
        start = source.index("async function fetchState")
        end = source.index("async function searchGatchaCache", start)
        cls.state_transport_source = source[start:end]
        start = source.index("function renderCurrentItem")
        end = source.index("function renderCurrentRatingButton", start)
        cls.current_item_render_source = source[start:end]
        start = source.index("function currentPlayerStatus")
        end = source.index("function renderPlayerControls", start)
        cls.player_status_sync_source = source[start:end]
        start = source.index("function remoteIssueSignatureSet")
        end = source.index("function noteRemoteFallbackSuccess", start)
        cls.issue_source = source[start:end]
        start = source.index("function remotePlayerIssueSignature")
        end = source.index("function disconnectClient", start)
        cls.player_control_source = source[start:end]

    def run_node(self, body: str) -> dict:
        script = f"""
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
{self.reconnect_source}
{body}
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_audio_variant_request_uses_only_the_observed_item_incarnation(self):
        start = self.source.index('elements.audioVariantBar.addEventListener("click"')
        end = self.source.index(
            'elements.playerControlPanel.addEventListener("click"',
            start,
        )
        listener = self.source[start:end]
        self.assertIn(
            "expected_item_incarnation_id: currentItem.item_incarnation_id",
            listener,
        )
        self.assertNotIn("playback_generation", listener)

    def test_current_cache_retry_forwards_the_observed_item_incarnation(self):
        start = self.source.index("function syncCurrentCacheState")
        end = self.source.index(
            'elements.historyExportImageButton?.addEventListener("click"',
            start,
        )
        retry_flow = self.source[start:end]
        self.assertIn(
            "retryBtn.dataset.itemIncarnationId = current.item_incarnation_id",
            retry_flow,
        )
        self.assertIn(
            "expected_item_incarnation_id: itemIncarnationId",
            retry_flow,
        )
        self.assertIn(
            "button.dataset.itemIncarnationId = item.item_incarnation_id",
            self.queue_source,
        )
        self.assertIn(
            "expected_item_incarnation_id: itemIncarnationId",
            self.queue_source,
        )

    def test_reconnect_jitter_is_bounded_and_never_subsecond(self):
        result = self.run_node(
            """
console.log(JSON.stringify({
  initial: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(1000, value)),
  middle: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(4000, value)),
  capped: [0, 0.5, 1].map((value) => eventStreamReconnectDelayMs(15000, value)),
}));
"""
        )
        self.assertEqual(result["initial"], [1000, 1125, 1250])
        self.assertEqual(result["middle"], [4000, 4400, 4800])
        self.assertEqual(result["capped"], [12000, 13500, 15000])
        self.assertGreaterEqual(min(result["initial"] + result["middle"] + result["capped"]), 1000)
        self.assertLessEqual(max(result["initial"] + result["middle"] + result["capped"]), 15000)

    def test_scheduler_jitters_each_attempt_but_doubles_only_base_delay(self):
        result = self.run_node(
            """
const delays = [];
const callbacks = new Map();
const cleared = [];
let nextTimerId = 1;
let connectCalls = 0;
const randomValues = [0.4, 0.75];
Math.random = () => randomValues.shift();
const state = { eventStreamRetryMs: 1000, eventStreamReconnectTimer: null };
const window = {
  setTimeout(callback, delayMs) {
    const timerId = nextTimerId++;
    callbacks.set(timerId, callback);
    delays.push(delayMs);
    return timerId;
  },
  clearTimeout(timerId) {
    callbacks.delete(timerId);
    cleared.push(timerId);
  },
};
function connectStateStream() { connectCalls += 1; }
scheduleEventStreamReconnect();
const firstNextBase = state.eventStreamRetryMs;
scheduleEventStreamReconnect();
const secondTimerId = state.eventStreamReconnectTimer;
const secondNextBase = state.eventStreamRetryMs;
callbacks.get(secondTimerId)();
console.log(JSON.stringify({
  delays,
  cleared,
  firstNextBase,
  secondNextBase,
  connectCalls,
  activeTimer: state.eventStreamReconnectTimer,
}));
"""
        )
        self.assertEqual(
            result,
            {
                "delays": [1100, 2300],
                "cleared": [1],
                "firstNextBase": 2000,
                "secondNextBase": 4000,
                "connectCalls": 1,
                "activeTimer": None,
            },
        )

    def test_cache_polling_uses_the_revision_guard(self):
        start = self.source.index("async function refreshCacheStatusOnly")
        end = self.source.index("function currentStateRevision", start)
        polling_source = self.source[start:end]

        self.assertIn("await fetchState({ force: false });", polling_source)
        self.assertNotIn("state.data = payload.data", polling_source)

    def run_state_transport_node(
        self,
        body: str,
        *,
        event_source_supported: bool = True,
    ) -> dict:
        event_source_value = "FakeEventSource" if event_source_supported else "undefined"
        script = f"""
const eventStreamInitialRetryMs = 1000;
const eventStreamMaxRetryMs = 15000;
const eventStreamRetryJitterRatio = 0.2;
const stateFallbackRefreshMs = 1000;
let nowMs = 0;
Date.now = () => nowMs;
Math.random = () => 0;
let nextTimerId = 1;
const timers = new Map();
const requests = [];
const stateGetSnapshots = [];
const stateGetFailures = [];
const connectionPhases = [];
const appMessages = [];
const renderedCacheStatuses = [];
const renderedCacheProgress = [];
const renderedQueueLengths = [];

async function advanceTime(deltaMs) {{
  const target = nowMs + deltaMs;
  while (true) {{
    const due = [...timers.entries()]
      .filter(([, task]) => task.due <= target)
      .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
    if (!due) break;
    const [timerId, task] = due;
    timers.delete(timerId);
    nowMs = task.due;
    await task.callback();
    await Promise.resolve();
  }}
  nowMs = target;
  await Promise.resolve();
}}

class FakeClassList {{
  add() {{}}
  remove() {{}}
  toggle() {{}}
}}
class FakeEventSource {{
  static instances = [];
  constructor(url) {{
    this.url = url;
    this.listeners = {{}};
    this.closeCalls = 0;
    FakeEventSource.instances.push(this);
  }}
  addEventListener(name, listener) {{
    (this.listeners[name] ||= []).push(listener);
  }}
  async emit(name, data = "") {{
    const event = {{ data: typeof data === "string" ? data : JSON.stringify(data) }};
    await Promise.all((this.listeners[name] || []).map((listener) => listener(event)));
  }}
  close() {{ this.closeCalls += 1; }}
}}

const window = {{
  EventSource: {event_source_value},
  setTimeout(callback, delayMs) {{
    const timerId = nextTimerId++;
    timers.set(timerId, {{ callback, due: nowMs + Number(delayMs || 0) }});
    return timerId;
  }},
  clearTimeout(timerId) {{ timers.delete(timerId); }},
}};
globalThis.setTimeout = window.setTimeout;
globalThis.clearTimeout = window.clearTimeout;

const state = {{
  clientId: "remote-test",
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  autoRefreshTimer: null,
  stateFallbackFetchInFlight: false,
  eventSource: null,
  eventStreamHealthy: false,
  eventStreamReconnectTimer: null,
  eventStreamRetryMs: eventStreamInitialRetryMs,
  remoteConnectionPhase: "connecting",
  remoteConnectionOfflineTimer: null,
  remoteConnectionFailureStartedAt: null,
  remoteIssueSignatures: new Set(),
  currentNowPlayingSignature: "",
  playerControlStatusSync: null,
}};
const elements = {{
  currentTitle: {{ textContent: "" }},
  currentRequester: {{ textContent: "", classList: new FakeClassList() }},
  currentOwner: {{ textContent: "", classList: new FakeClassList() }},
  openRatingButton: {{ classList: new FakeClassList() }},
  currentMeta: {{ textContent: "" }},
  playbackDock: {{
    classList: new FakeClassList(),
    setAttribute() {{}},
    removeAttribute() {{}},
  }},
  playbackDockTitle: {{ textContent: "" }},
  playbackDockRequester: {{ textContent: "", classList: new FakeClassList() }},
  playbackDockCoverImage: {{}},
  playbackSheetCoverImage: {{}},
  remoteShell: {{ classList: new FakeClassList() }},
}};
function clientHeaders() {{ return {{}}; }}
function localizedApiMessage(value) {{ return String(value || ""); }}
function t(key) {{ return key; }}
function setRemoteConnectionPhase(phase) {{
  if (state.remoteConnectionPhase !== phase) {{
    state.remoteConnectionPhase = phase;
    connectionPhases.push(phase);
  }}
}}
function setAppMessage(message, isError) {{
  appMessages.push({{ message: String(message), isError: Boolean(isError) }});
}}
function requesterBadgeText() {{ return ""; }}
function ownerLineText() {{ return ""; }}
function normalizedPlaybackCoverUrl() {{ return ""; }}
function syncPlaybackCoverImage() {{}}
function setPlaybackDockMarqueeText(container, _textNode, value) {{ container.textContent = value; }}
function schedulePlaybackDockMarquee() {{}}
function resetPlaybackDockMarquees() {{}}
function closePlaybackSheet() {{}}
function closePlaybackMetadataPopover() {{}}
function syncPlaybackMetadataFieldVisibility() {{}}
function renderOwnerBadgeLabel() {{}}
function maybeUpdateRemoteRatingPrompt() {{}}
function syncCurrentCacheState(current) {{
  renderedCacheStatuses.push(current?.cache_status || "empty");
  renderedCacheProgress.push(Number(current?.cache_progress || 0));
}}
function renderCurrentPlaybackState(current) {{ syncCurrentCacheState(current); }}
function renderPlayerControls() {{}}
function renderQueueCacheStatus() {{}}
function frontendPlaybackMode() {{ return "local"; }}
function currentPlayerStatus() {{ return null; }}
function clearCurrentPlaybackClock() {{}}
function syncRemoteIdentityWithSnapshot() {{}}
function scheduleFavlistBrowseReloadFromState() {{}}
function render() {{
  renderedQueueLengths.push(Array.isArray(state.data?.playlist) ? state.data.playlist.length : 0);
  renderCurrentItem(state.data?.current_item, "local");
}}
async function fetch(url) {{
  requests.push({{ url, at: nowMs }});
  if (stateGetFailures.length) {{
    stateGetFailures.shift();
    return {{
      ok: false,
      async json() {{ return {{ ok: false, error: "fallback failed" }}; }},
    }};
  }}
  const snapshot = stateGetSnapshots.length
    ? stateGetSnapshots.shift()
    : state.data;
  return {{
    ok: true,
    async json() {{ return {{ ok: true, data: snapshot }}; }},
  }};
}}
{self.state_transport_source}
{self.current_item_render_source}
function snapshot(revision, cacheStatus, progress = 0, queueSize = 0) {{
  return {{
    state_revision: revision,
    playback_generation: 1,
    playback_mode: "local",
    current_item: {{
      id: "song-a",
      display_title: "Song A",
      cache_status: cacheStatus,
      cache_progress: progress,
    }},
    playlist: Array.from({{ length: queueSize }}, (_, index) => ({{ id: `queued-${{index}}` }})),
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

    def test_healthy_sse_is_the_only_continuous_cache_state_feed(self):
        result = self.run_state_transport_node(
            """
(async () => {
  stateGetSnapshots.push(snapshot(1, "downloading", 0));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;

  connectStateStream();
  const source = FakeEventSource.instances[0];
  await source.emit("open");
  const healthyAfterOpenOnly = state.eventStreamHealthy;
  await source.emit("state", snapshot(1, "downloading", 0));
  for (let second = 1; second <= 10; second += 1) {
    await source.emit("state", snapshot(second + 1, "downloading", second * 9));
    await advanceTime(1000);
  }
  const cacheGetsAfterBootstrap = requests.length - bootstrapGets;
  await source.emit("state", snapshot(12, "ready", 100, 1));
  await advanceTime(50);
  await source.emit("state", snapshot(13, "failed", 100));
  await advanceTime(50);
  process.stdout.write(JSON.stringify({
    bootstrapGets,
    cacheGetsAfterBootstrap,
    healthyAfterOpenOnly,
    healthy: state.eventStreamHealthy,
    autoRefreshTimer: state.autoRefreshTimer,
    renderedCacheStatuses,
    renderedCacheProgress,
    renderedQueueLengths,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(result["bootstrapGets"], 1)
        self.assertEqual(result["cacheGetsAfterBootstrap"], 0)
        self.assertFalse(result["healthyAfterOpenOnly"])
        self.assertTrue(result["healthy"])
        self.assertIsNone(result["autoRefreshTimer"])
        self.assertIn("downloading", result["renderedCacheStatuses"])
        self.assertIn("ready", result["renderedCacheStatuses"])
        self.assertIn("failed", result["renderedCacheStatuses"])
        self.assertIn(90, result["renderedCacheProgress"])
        self.assertIn(1, result["renderedQueueLengths"])

    def test_event_source_unsupported_uses_one_bounded_fallback_timer(self):
        result = self.run_state_transport_node(
            """
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  stateGetSnapshots.push(
    snapshot(2, "downloading", 20),
    snapshot(1, "queued", 0),
    snapshot(3, "ready", 100),
  );
  connectStateStream();
  await advanceTime(3000);
  process.stdout.write(JSON.stringify({
    fallbackGets: requests.length - bootstrapGets,
    activeFallbackTimers: state.autoRefreshTimer === null ? 0 : 1,
    fallbackFetchInFlight: state.stateFallbackFetchInFlight,
    finalRevision: state.data?.state_revision,
    finalStatus: state.data?.current_item?.cache_status,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
""",
            event_source_supported=False,
        )
        self.assertEqual(result["fallbackGets"], 3)
        self.assertEqual(result["activeFallbackTimers"], 1)
        self.assertFalse(result["fallbackFetchInFlight"])
        self.assertEqual(result["finalRevision"], 3)
        self.assertEqual(result["finalStatus"], "ready")

    def test_event_source_without_valid_state_uses_then_cancels_fallback(self):
        result = self.run_state_transport_node(
            """
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  stateGetSnapshots.push(snapshot(2, "downloading", 40));
  connectStateStream();
  const source = FakeEventSource.instances[0];
  await source.emit("open");
  await advanceTime(1000);
  const getsWithoutValidState = requests.length - bootstrapGets;
  await source.emit("state", snapshot(3, "ready", 100));
  await advanceTime(5000);
  process.stdout.write(JSON.stringify({
    getsWithoutValidState,
    getsAfterRecovery: requests.length - bootstrapGets,
    healthy: state.eventStreamHealthy,
    fallbackTimer: state.autoRefreshTimer,
    finalRevision: state.data?.state_revision,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(result["getsWithoutValidState"], 1)
        self.assertEqual(result["getsAfterRecovery"], 1)
        self.assertTrue(result["healthy"])
        self.assertIsNone(result["fallbackTimer"])
        self.assertEqual(result["finalRevision"], 3)

    def test_remote_connection_phase_tracks_sse_and_bounded_fallback_recovery(self):
        result = self.run_state_transport_node(
            """
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  const initialPhase = state.remoteConnectionPhase;

  connectStateStream();
  const first = FakeEventSource.instances[0];
  await first.emit("open");
  const phaseAfterOpen = state.remoteConnectionPhase;
  await first.emit("state", "not-json");
  const readyAfterMalformed = state.eventStreamHealthy;
  await first.emit("state", snapshot(0, "stale", 0));
  const readyAfterStale = state.eventStreamHealthy;
  await first.emit("state", snapshot(1, "ready", 100));
  const phaseAfterValidState = state.remoteConnectionPhase;

  await first.emit("error");
  const phaseAfterError = state.remoteConnectionPhase;
  const messagesAfterError = appMessages.length;
  stateGetSnapshots.push(snapshot(2, "downloading", 40));
  await advanceTime(2000);
  const phaseAfterFallbackSuccess = state.remoteConnectionPhase;
  const healthyAfterFallbackSuccess = state.eventStreamHealthy;

  stateGetFailures.push(true, true, true, true, true);
  await advanceTime(4000);
  const phaseAfterOfflineGrace = state.remoteConnectionPhase;
  const messagesAfterOffline = appMessages.length;
  await advanceTime(1000);
  const phaseAfterRepeatedFailure = state.remoteConnectionPhase;
  const messagesAfterRepeatedFailure = appMessages.length;

  const recoverySource = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  await recoverySource.emit("state", snapshot(3, "ready", 100));
  const phaseAfterRecovery = state.remoteConnectionPhase;
  process.stdout.write(JSON.stringify({
    initialPhase,
    phaseAfterOpen,
    readyAfterMalformed,
    readyAfterStale,
    phaseAfterValidState,
    phaseAfterError,
    messagesAfterError,
    phaseAfterFallbackSuccess,
    healthyAfterFallbackSuccess,
    phaseAfterOfflineGrace,
    messagesAfterOffline,
    phaseAfterRepeatedFailure,
    messagesAfterRepeatedFailure,
    phaseAfterRecovery,
    offlineIssuePresent: state.remoteIssueSignatures.has("remote-connection-offline"),
    eventSourceCount: FakeEventSource.instances.length,
    stateRequestUrls: requests.map((request) => request.url),
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(result["initialPhase"], "connecting")
        self.assertEqual(result["phaseAfterOpen"], "connecting")
        self.assertFalse(result["readyAfterMalformed"])
        self.assertFalse(result["readyAfterStale"])
        self.assertEqual(result["phaseAfterValidState"], "connected")
        self.assertEqual(result["phaseAfterError"], "reconnecting")
        self.assertEqual(result["messagesAfterError"], 0)
        self.assertEqual(result["phaseAfterFallbackSuccess"], "reconnecting")
        self.assertFalse(result["healthyAfterFallbackSuccess"])
        self.assertEqual(result["phaseAfterOfflineGrace"], "offline")
        self.assertEqual(result["messagesAfterOffline"], 1)
        self.assertEqual(result["phaseAfterRepeatedFailure"], "offline")
        self.assertEqual(result["messagesAfterRepeatedFailure"], 1)
        self.assertEqual(result["phaseAfterRecovery"], "connected")
        self.assertFalse(result["offlineIssuePresent"])
        self.assertEqual(result["eventSourceCount"], 2)
        self.assertTrue(all(url == "/api/state" for url in result["stateRequestUrls"]))

    def test_transient_sse_reconnect_has_no_parallel_full_state_get(self):
        result = self.run_state_transport_node(
            """
(async () => {
  stateGetSnapshots.push(snapshot(1, "ready", 100));
  await fetchState();
  await advanceTime(50);
  const bootstrapGets = requests.length;
  connectStateStream();
  const first = FakeEventSource.instances[0];
  await first.emit("state", snapshot(1, "ready", 100));
  await first.emit("error");
  const getsImmediatelyAfterError = requests.length - bootstrapGets;
  const timersAfterFirstError = timers.size;
  await first.emit("error");
  const timersAfterRepeatedError = timers.size;

  await advanceTime(1000);
  const second = FakeEventSource.instances[1];
  await first.emit("error");
  const newerSourceCloseCallsAfterOldError = second.closeCalls;
  await second.emit("state", snapshot(2, "downloading", 50));
  await advanceTime(5000);
  process.stdout.write(JSON.stringify({
    getsImmediatelyAfterError,
    getsAfterRecovery: requests.length - bootstrapGets,
    timersAfterFirstError,
    timersAfterRepeatedError,
    sourceCount: FakeEventSource.instances.length,
    firstCloseCalls: first.closeCalls,
    newerSourceCloseCallsAfterOldError,
    healthy: state.eventStreamHealthy,
    fallbackTimer: state.autoRefreshTimer,
    reconnectTimer: state.eventStreamReconnectTimer,
    finalRevision: state.data?.state_revision,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(result["getsImmediatelyAfterError"], 0)
        self.assertEqual(result["getsAfterRecovery"], 0)
        self.assertLessEqual(result["timersAfterFirstError"], 2)
        self.assertEqual(
            result["timersAfterRepeatedError"], result["timersAfterFirstError"]
        )
        self.assertEqual(result["sourceCount"], 2)
        self.assertEqual(result["firstCloseCalls"], 1)
        self.assertEqual(result["newerSourceCloseCallsAfterOldError"], 0)
        self.assertTrue(result["healthy"])
        self.assertIsNone(result["fallbackTimer"])
        self.assertIsNone(result["reconnectTimer"])
        self.assertEqual(result["finalRevision"], 2)

    def test_startup_retains_initial_get_before_connecting_sse(self):
        start = self.source.index("async function startRemoteSession")
        end = self.source.index("startRemoteSession();", start)
        startup_source = self.source[start:end]
        self.assertLess(
            startup_source.index("await fetchState();"),
            startup_source.index("connectStateStream();"),
        )

    def test_player_status_and_clock_fail_closed_by_playback_generation(self):
        script = f"""
let nowMs = 1000;
Date.now = () => nowMs;
let nextTimerId = 1;
const activeIntervals = new Set();
const window = {{
  setInterval(_callback, _delayMs) {{
    const timerId = nextTimerId++;
    activeIntervals.add(timerId);
    return timerId;
  }},
  clearInterval(timerId) {{ activeIntervals.delete(timerId); }},
}};
const state = {{
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlStatusSync: null,
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
  remoteIssueSignatures: new Set(),
}};
const clockText = {{ textContent: "" }};
const elements = {{
  currentCacheState: {{
    textContent: "",
    querySelector() {{ return clockText; }},
  }},
}};
function currentStateRevision(snapshot) {{ return Number(snapshot?.state_revision || 0); }}
function renderSignatureForSnapshot(snapshot) {{
  return JSON.stringify({{
    playback_generation: snapshot?.playback_generation,
    current_item: snapshot?.current_item,
  }});
}}
function syncRemoteIdentityWithSnapshot() {{}}
function scheduleFavlistBrowseReloadFromState() {{}}
function scheduleRender() {{}}
function renderCacheStatusOnly() {{}}
function durationSecondsForItem(item) {{ return Number(item?.duration || 0); }}
function playerControlStatusSyncPending() {{ return false; }}
function clearPlayerControlStatusSync() {{}}
function syncCurrentCacheState() {{}}
function maybeUpdateRemoteRatingPrompt() {{}}
console.warn = () => {{}};
{self.clock_value_source}
{self.current_status_source}
{self.clock_render_source}
{self.apply_snapshot_source}
function snapshot(revision, generation, status, extra = {{}}) {{
  return {{
    state_revision: revision,
    playback_generation: generation,
    playback_program: {{
      item_id: "song-a",
      item_incarnation_id: `i-${{generation}}`,
      selected_audio_variant_id: "instrumental",
      artifact_set_id: `a-${{generation}}`,
    }},
    current_item: {{ id: "song-a", cache_status: "ready", duration: 100 }},
    player_status: status,
    ...extra,
  }};
}}
function status(generation, currentTime) {{
  return {{
    playback_generation: generation,
    item_id: "song-a",
    observed_phase: "playing",
    is_paused: false,
    current_time: currentTime,
    duration: 100,
    updated_at: generation * 100,
  }};
}}

const first = snapshot(1, 1, status(1, 10));
const acceptedFirst = applyStateSnapshot(first);
renderCurrentPlaybackState(state.data.current_item);
const firstTimer = state.currentPlaybackClockTimer;
const matchingFirst = currentPlayerStatus(state.data.current_item);

const sameProgram = snapshot(2, 1, status(1, 10), {{ python_only: "changed" }});
const acceptedSame = applyStateSnapshot(sameProgram);
const retainedTimer = state.currentPlaybackClockTimer;
const sameProgramRetained = firstTimer === retainedTimer && activeIntervals.has(firstTimer);

const mismatched = snapshot(3, 2, status(1, 80));
const acceptedMismatch = applyStateSnapshot(mismatched);
const mismatchResult = {{
  currentStatus: currentPlayerStatus(state.data.current_item),
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
}};

const replacement = snapshot(4, 2, status(2, 3));
const acceptedReplacement = applyStateSnapshot(replacement);
renderCurrentPlaybackState(state.data.current_item);
const replacementResult = {{
  generation: currentPlayerStatus(state.data.current_item)?.playback_generation,
  timer: state.currentPlaybackClockTimer,
  paused: state.currentPlaybackClockPaused,
  base: state.currentPlaybackClockBaseSeconds,
}};

const duplicateAccepted = applyStateSnapshot(snapshot(4, 2, status(2, 90)));
const inverseAccepted = applyStateSnapshot(snapshot(3, 1, status(1, 90)));
console.log(JSON.stringify({{
  acceptedFirst,
  matchingFirstGeneration: matchingFirst?.playback_generation,
  acceptedSame,
  sameProgramRetained,
  acceptedMismatch,
  mismatchResult,
  acceptedReplacement,
  replacementResult,
  duplicateAccepted,
  inverseAccepted,
  finalCurrentTime: state.data.player_status.current_time,
  finalGeneration: state.data.playback_generation,
}}));
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
        result = json.loads(completed.stdout)
        self.assertTrue(result["acceptedFirst"])
        self.assertEqual(result["matchingFirstGeneration"], 1)
        self.assertTrue(result["acceptedSame"])
        self.assertTrue(result["sameProgramRetained"], result)
        self.assertTrue(result["acceptedMismatch"])
        self.assertEqual(
            result["mismatchResult"],
            {"currentStatus": None, "timer": None, "paused": True, "base": 0},
        )
        self.assertTrue(result["acceptedReplacement"])
        self.assertEqual(result["replacementResult"]["generation"], 2)
        self.assertIsNotNone(result["replacementResult"]["timer"])
        self.assertFalse(result["replacementResult"]["paused"])
        self.assertEqual(result["replacementResult"]["base"], 3)
        self.assertFalse(result["duplicateAccepted"])
        self.assertFalse(result["inverseAccepted"])
        self.assertEqual(result["finalCurrentTime"], 3)
        self.assertEqual(result["finalGeneration"], 2)

    def run_player_control_sync_node(self, body: str) -> dict:
        script = f"""
const playerControlStatusRefreshDelaysMs = [180, 520, 1100, 1800];
const playerControlStatusSyncTimeoutMs = 3200;
let nowMs = 1000;
Date.now = () => nowMs;
let nextTimerId = 1;
const timers = new Map();
const intervals = new Map();
const commandRequests = [];
const messages = [];
const fallbackSnapshots = [];
let fetchStateCalls = 0;
let commandApplied = true;

async function advanceTime(deltaMs) {{
  const target = nowMs + deltaMs;
  while (true) {{
    const due = [...timers.entries()]
      .filter(([, task]) => task.due <= target)
      .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
    if (!due) break;
    const [timerId, task] = due;
    timers.delete(timerId);
    nowMs = task.due;
    await task.callback();
    await Promise.resolve();
  }}
  nowMs = target;
  await Promise.resolve();
}}

const window = {{
  setTimeout(callback, delayMs) {{
    const timerId = nextTimerId++;
    timers.set(timerId, {{ callback, due: nowMs + Number(delayMs || 0) }});
    return timerId;
  }},
  clearTimeout(timerId) {{ timers.delete(timerId); }},
  setInterval(callback, delayMs) {{
    const timerId = nextTimerId++;
    intervals.set(timerId, {{ callback, delayMs }});
    return timerId;
  }},
  clearInterval(timerId) {{ intervals.delete(timerId); }},
}};

const state = {{
  data: null,
  eventStreamHealthy: true,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  playerControlStatusRefreshTimers: [],
  currentPlaybackClockSignature: "",
  currentPlaybackClockBaseSeconds: 0,
  currentPlaybackClockDurationSeconds: 0,
  currentPlaybackClockStartedAt: 0,
  currentPlaybackClockPaused: true,
  currentPlaybackClockTimer: null,
}};
const clockText = {{ textContent: "" }};
const elements = {{
  currentCacheState: {{
    textContent: "",
    querySelector() {{ return clockText; }},
  }},
}};
function frontendPlaybackMode() {{ return "local"; }}
function canRemoteControlPlayer() {{ return true; }}
function renderPlayerControls() {{}}
function syncCurrentCacheState() {{}}
function maybeUpdateRemoteRatingPrompt() {{}}
function setFormMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function t(key) {{ return key; }}
console.warn = () => {{}};
function applyStateSnapshot(snapshot) {{
  if (
    state.data
    && Number(snapshot?.state_revision || 0) <= Number(state.data?.state_revision || 0)
  ) return false;
  const previousGeneration = state.data?.playback_generation;
  state.data = snapshot;
  if (
    previousGeneration !== undefined
    && previousGeneration !== snapshot.playback_generation
  ) clearCurrentPlaybackClock();
  renderCurrentPlaybackState(snapshot.current_item);
  renderPlayerControls(snapshot.current_item, "local");
  return true;
}}
async function fetchState() {{
  fetchStateCalls += 1;
  if (fallbackSnapshots.length) applyStateSnapshot(fallbackSnapshots.shift());
}}
async function apiPost(path, payload) {{
  commandRequests.push({{ path, payload: {{ ...payload }} }});
  return {{
    ...state.data,
    state_revision: Number(state.data?.state_revision || 0) + 1,
  }};
}}
async function apiPostExactStateCommand(path, payload) {{
  const snapshot = await apiPost(path, payload);
  return {{
    snapshotAccepted: applyStateSnapshot(snapshot),
    commandApplied,
  }};
}}
function playerSnapshot(revision, generation, itemId, updatedAt, currentTime, isPaused = false) {{
  return {{
    state_revision: revision,
    playback_generation: generation,
    playback_mode: "local",
    current_item: {{
      id: itemId,
      cache_status: "ready",
      duration: 120,
      video_url: "/media/video.mp4",
      audio_url: "/media/audio.m4a",
    }},
    player_status: updatedAt === null ? null : {{
      playback_generation: generation,
      item_id: itemId,
      observed_phase: isPaused ? "paused" : "playing",
      is_paused: isPaused,
      current_time: currentTime,
      duration: 120,
      updated_at: updatedAt,
    }},
  }};
}}
{self.clock_value_source}
{self.player_status_sync_source}
{self.clock_render_source}
{self.issue_source}
{self.player_control_source}
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

    def test_healthy_sse_settles_player_control_without_refresh_burst(self):
        result = self.run_player_control_sync_node(
            """
(async () => {
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  await sendPlayerControl("seek-relative", 15);
  const timersAfterCommand = state.playerControlStatusRefreshTimers.length;
  await advanceTime(2000);
  const getsBeforeMatchingStatus = fetchStateCalls;

  applyStateSnapshot(playerSnapshot(3, 7, "song-a", 200, 30));
  const matchingStatus = {
    pending: state.playerControlStatusSync,
    clockBase: state.currentPlaybackClockBaseSeconds,
    clockPaused: state.currentPlaybackClockPaused,
    clockTimerActive: state.currentPlaybackClockTimer !== null,
  };
  await advanceTime(2000);

  commandApplied = false;
  await sendPlayerControl("toggle-play", 0);
  const staleOutcome = {
    pending: state.playerControlStatusSync,
    messageCount: messages.length,
    pendingAction: state.playerControlPendingAction,
  };

  commandApplied = true;
  beginPlayerControlStatusSync(state.data.current_item);
  applyStateSnapshot(playerSnapshot(5, 8, "song-b", null, 0, true));
  process.stdout.write(JSON.stringify({
    commandRequests,
    timersAfterCommand,
    getsBeforeMatchingStatus,
    finalFetchStateCalls: fetchStateCalls,
    matchingStatus,
    staleOutcome,
    messages,
    pendingAfterProgramChange: state.playerControlStatusSync,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(len(result["commandRequests"]), 2)
        self.assertEqual(result["timersAfterCommand"], 1)
        self.assertEqual(result["getsBeforeMatchingStatus"], 0)
        self.assertEqual(result["finalFetchStateCalls"], 0)
        self.assertEqual(
            result["matchingStatus"],
            {
                "pending": None,
                "clockBase": 30,
                "clockPaused": False,
                "clockTimerActive": True,
            },
        )
        self.assertEqual(
            result["staleOutcome"],
            {"pending": None, "messageCount": 1, "pendingAction": ""},
        )
        self.assertEqual(
            result["messages"],
            [{"message": "remote.controlSentForward", "isError": False}],
        )
        self.assertIsNone(result["pendingAfterProgramChange"])

    def test_player_control_without_usable_sse_has_no_refresh_burst_or_retry(self):
        result = self.run_player_control_sync_node(
            """
(async () => {
  state.eventStreamHealthy = false;
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  await sendPlayerControl("toggle-play", 0);
  await advanceTime(3300);
  process.stdout.write(JSON.stringify({
    commandRequestCount: commandRequests.length,
    fetchStateCalls,
    pending: state.playerControlStatusSync,
    pendingAction: state.playerControlPendingAction,
    activeStatusTimers: state.playerControlStatusRefreshTimers.length,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(result["commandRequestCount"], 1)
        self.assertLessEqual(result["fetchStateCalls"], 1)
        self.assertIsNone(result["pending"])
        self.assertEqual(result["pendingAction"], "")
        self.assertEqual(result["activeStatusTimers"], 0)

    def test_failed_player_commands_use_incarnation_scoped_deduplicated_toasts(self):
        result = self.run_player_control_sync_node(
            """
(async () => {
  globalThis.setAppMessage = (message, isError) => messages.push({ message: String(message), isError: Boolean(isError) });
  commandApplied = false;
  applyStateSnapshot(playerSnapshot(1, 7, "song-a", 100, 10));
  state.data.current_item.item_incarnation_id = "incarnation-a";
  await sendPlayerControl("seek-relative", 15);
  await sendPlayerControl("seek-relative", 15);
  state.data = {
    ...state.data,
    playback_generation: 8,
    current_item: {
      ...state.data.current_item,
      item_incarnation_id: "incarnation-b",
    },
  };
  await sendPlayerControl("seek-relative", 15);
  process.stdout.write(JSON.stringify({
    messages,
    issueSignatures: [...state.remoteIssueSignatures],
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result["messages"],
            [
                {"message": "remote.controlRejected", "isError": True},
                {"message": "remote.controlRejected", "isError": True},
            ],
        )
        self.assertEqual(
            result["issueSignatures"],
            [
                "player-command:seek-relative:song-a:incarnation-a:7",
                "player-command:seek-relative:song-a:incarnation-b:8",
            ],
        )

    def test_remote_program_relative_controls_capture_the_observed_rust_generation(self):
        script = f"""
const requests = [];
const state = {{
  data: {{
    state_revision: 10,
    playback_generation: 41,
    current_item: {{ id: "song-a" }},
  }},
  playerControlPendingAction: "",
}};
function frontendPlaybackMode() {{ return "local"; }}
function canRemoteControlPlayer() {{ return true; }}
function beginPlayerControlStatusSync() {{}}
function clearPlayerControlStatusSync() {{}}
function renderCurrentPlaybackState() {{}}
function renderPlayerControls() {{}}
function setFormMessage() {{}}
function t(key) {{ return key; }}
function applyStateSnapshot(snapshot) {{ state.data = snapshot; return true; }}
async function fetchState() {{}}
async function apiPost(path, payload) {{
  requests.push({{ path, payload: {{ ...payload }} }});
  return {{ ...state.data, state_revision: state.data.state_revision + 1 }};
}}
async function apiPostExactStateCommand(path, payload) {{
  const snapshot = await apiPost(path, payload);
  return {{
    snapshotAccepted: applyStateSnapshot(snapshot),
    commandApplied: true,
  }};
}}
{self.player_control_source}
(async () => {{
  await sendPlayerControl("seek-relative", 15);
  await sendPlayerControl("seek-absolute", 42);
  state.data = {{ ...state.data, state_revision: 99 }};
  await sendPlayerNext();
  await sendPlayerControl("next-track");
  process.stdout.write(JSON.stringify(requests));
}})();
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
        requests = json.loads(completed.stdout)
        self.assertEqual(
            requests,
            [
                {
                    "path": "/api/player/control",
                    "payload": {
                        "action": "seek-relative",
                        "item_id": "song-a",
                        "delta_seconds": 15,
                        "playback_generation": 41,
                    },
                },
                {
                    "path": "/api/player/control",
                    "payload": {
                        "action": "seek-absolute",
                        "item_id": "song-a",
                        "delta_seconds": 0,
                        "playback_generation": 41,
                        "target_seconds": 42,
                    },
                },
                {
                    "path": "/api/player/next",
                    "payload": {"playback_generation": 41},
                },
                {
                    "path": "/api/player/control",
                    "payload": {
                        "action": "next-track",
                        "item_id": "song-a",
                        "delta_seconds": 0,
                        "playback_generation": 41,
                    },
                },
            ],
        )

    def test_stale_exact_commands_update_state_without_success_ui_or_refetch(self):
        script = f"""
const state = {{
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlPendingAction: "",
  playerControlStatusSync: null,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
}};
const messages = [];
const requests = [];
let fetchStateCalls = 0;
let controlRenders = 0;
function currentStateRevision(snapshot) {{ return Number(snapshot?.state_revision || 0); }}
function renderSignatureForSnapshot(snapshot) {{
  return JSON.stringify({{
    revision: snapshot?.state_revision || 0,
    generation: snapshot?.playback_generation || 0,
    incarnation: snapshot?.current_item?.item_incarnation_id || "",
  }});
}}
function currentPlayerStatus() {{ return null; }}
function clearCurrentPlaybackClock() {{}}
function syncRemoteIdentityWithSnapshot() {{}}
function scheduleFavlistBrowseReloadFromState() {{}}
function scheduleRender() {{}}
function renderCacheStatusOnly() {{}}
function frontendPlaybackMode() {{ return "local"; }}
function canRemoteControlPlayer() {{ return true; }}
function beginPlayerControlStatusSync() {{}}
function clearPlayerControlStatusSync() {{}}
function renderCurrentPlaybackState() {{}}
function renderPlayerControls() {{ controlRenders += 1; }}
function setFormMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function t(key) {{ return key; }}
async function fetchState() {{ fetchStateCalls += 1; }}
{self.apply_snapshot_source}

const initial = {{
  state_revision: 10,
  playback_generation: 41,
  playback_mode: "local",
  current_item: {{ id: "song-a", item_incarnation_id: "i-a" }},
}};
const replacement = {{
  state_revision: 11,
  playback_generation: 42,
  playback_mode: "local",
  current_item: {{ id: "song-a", item_incarnation_id: "i-b" }},
}};
applyStateSnapshot(initial);
async function apiPostExactStateCommand(path, payload) {{
  requests.push({{ path, payload }});
  return {{
    snapshotAccepted: applyStateSnapshot(replacement),
    commandApplied: false,
  }};
}}
{self.player_control_source}
(async () => {{
  await sendPlayerNext();
  process.stdout.write(JSON.stringify({{
    requests,
    messages,
    fetchStateCalls,
    controlRenders,
    pendingAction: state.playerControlPendingAction,
    acceptedRevision: state.data.state_revision,
    acceptedGeneration: state.data.playback_generation,
    acceptedIncarnation: state.data.current_item.item_incarnation_id,
  }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
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
        result = json.loads(completed.stdout)
        self.assertEqual(
            result,
            {
                "requests": [
                    {
                        "path": "/api/player/next",
                        "payload": {"playback_generation": 41},
                    }
                ],
                "messages": [],
                "fetchStateCalls": 0,
                "controlRenders": 2,
                "pendingAction": "",
                "acceptedRevision": 11,
                "acceptedGeneration": 42,
                "acceptedIncarnation": "i-b",
            },
        )

    def test_remote_variant_and_retry_stale_ui_settles_once(self):
        audio_listener = self.source[
            self.source.index('elements.audioVariantBar.addEventListener("click"') :
            self.source.index(
                'elements.playerControlPanel.addEventListener("click"',
                self.source.index('elements.audioVariantBar.addEventListener("click"'),
            )
        ]
        retry_listener = self.source[
            self.source.index('elements.currentCacheState?.addEventListener("click"') :
            self.source.index(
                'elements.historyExportImageButton?.addEventListener("click"',
                self.source.index('elements.currentCacheState?.addEventListener("click"'),
            )
        ]
        script = f"""
class FakeElement {{
  constructor(dataset = {{}}) {{
    this.dataset = {{ ...dataset }};
    this.listeners = {{}};
    this.attributes = {{}};
    this.disabled = false;
  }}
  addEventListener(name, listener) {{ this.listeners[name] = listener; }}
  getAttribute(name) {{ return this.attributes[name] ?? null; }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  removeAttribute(name) {{ delete this.attributes[name]; }}
}}
const audioVariantBar = new FakeElement();
const audioVariantPopover = new FakeElement();
const currentCacheState = new FakeElement();
const elements = {{ audioVariantBar, audioVariantPopover, currentCacheState }};
const window = {{ confirm: () => true }};
const audioVariantSwitchDebounceMs = 350;
const state = {{
  data: null,
  dataRenderSignature: "",
  renderDebounceTimer: null,
  playerControlStatusSync: null,
  audioVariantSwitchInFlight: false,
  audioVariantSwitchUnlockAt: 0,
  audioVariantBarExpanded: false,
}};
const messages = [];
const requests = [];
const responses = [];
let renders = 0;
let unlockSchedules = 0;
let busyObservations = 0;
function currentStateRevision(snapshot) {{ return Number(snapshot?.state_revision || 0); }}
function renderSignatureForSnapshot(snapshot) {{ return JSON.stringify(snapshot); }}
function currentPlayerStatus() {{ return null; }}
function clearCurrentPlaybackClock() {{}}
function syncRemoteIdentityWithSnapshot() {{}}
function scheduleFavlistBrowseReloadFromState() {{}}
function scheduleRender() {{}}
function renderCacheStatusOnly() {{}}
function frontendPlaybackMode() {{ return "local"; }}
function renderAudioVariantBar() {{}}
function setAudioVariantPopoverOpen() {{}}
function audioVariantSwitchLocked() {{
  return state.audioVariantSwitchInFlight || Date.now() < state.audioVariantSwitchUnlockAt;
}}
function scheduleAudioVariantSwitchUnlock() {{ unlockSchedules += 1; }}
function selectedAudioVariantForItem(item) {{
  return item?.audio_variants?.find((variant) => variant.id === item.selected_audio_variant_id) || null;
}}
function setFormMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function t(key) {{ return key; }}
function render() {{ renders += 1; }}
{self.apply_snapshot_source}
function item(incarnation, selectedVariant = "instrumental", cacheStatus = "failed") {{
  return {{
    id: "song-a",
    item_incarnation_id: incarnation,
    selected_audio_variant_id: selectedVariant,
    cache_status: cacheStatus,
    audio_variants: [
      {{ id: "instrumental", label: "Instrumental", audio_url: "/media/i.m4a" }},
      {{ id: "vocal", label: "Vocal", audio_url: "/media/v.m4a" }},
    ],
  }};
}}
function snapshot(revision, currentItem) {{
  return {{
    state_revision: revision,
    playback_generation: revision,
    playback_mode: "local",
    current_item: currentItem,
    playlist: [],
  }};
}}
async function apiPostExactStateCommand(path, payload) {{
  requests.push({{ path, payload }});
  if (path === "/api/cache/retry") {{
    const button = activeRetryButton;
    if (button?.disabled && button?.getAttribute("aria-busy") === "true") {{
      busyObservations += 1;
    }}
  }}
  const response = responses.shift();
  return {{
    snapshotAccepted: applyStateSnapshot(response.snapshot),
    commandApplied: response.applied,
  }};
}}
{audio_listener}
{retry_listener}
let activeRetryButton = null;
function audioEventButton(currentItem) {{
  const button = new FakeElement({{
    itemId: currentItem.id,
    bound: "true",
    variantId: "vocal",
  }});
  return {{ closest: (selector) => selector === "button[data-variant-id]" ? button : null }};
}}
function retryEventButton(currentItem) {{
  const button = new FakeElement({{
    id: currentItem.id,
    itemIncarnationId: currentItem.item_incarnation_id,
  }});
  activeRetryButton = button;
  return {{ button, event: {{ target: {{ closest: () => button }}, stopPropagation() {{}} }} }};
}}

(async () => {{
  applyStateSnapshot(snapshot(1, item("i-1")));
  responses.push({{ snapshot: snapshot(2, item("i-2")), applied: false }});
  await audioVariantPopover.listeners.click({{ target: audioEventButton(state.data.current_item) }});
  const staleAudio = {{
    messages: messages.splice(0),
    inFlight: state.audioVariantSwitchInFlight,
    unlockAt: state.audioVariantSwitchUnlockAt,
    incarnation: state.data.current_item.item_incarnation_id,
  }};

  responses.push({{ snapshot: snapshot(3, item("i-3")), applied: false }});
  const staleRetryTarget = retryEventButton(state.data.current_item);
  await currentCacheState.listeners.click(staleRetryTarget.event);
  const staleRetry = {{
    messages: messages.splice(0),
    disabled: staleRetryTarget.button.disabled,
    busy: staleRetryTarget.button.getAttribute("aria-busy"),
    incarnation: state.data.current_item.item_incarnation_id,
  }};

  responses.push({{ snapshot: snapshot(4, item("i-3", "vocal")), applied: true }});
  await audioVariantPopover.listeners.click({{ target: audioEventButton(state.data.current_item) }});
  const validAudio = {{ messages: messages.splice(0) }};

  responses.push({{ snapshot: snapshot(5, item("i-3", "vocal", "downloading")), applied: true }});
  const validRetryTarget = retryEventButton(state.data.current_item);
  await currentCacheState.listeners.click(validRetryTarget.event);
  const validRetry = {{
    messages: messages.splice(0),
    disabled: validRetryTarget.button.disabled,
    busy: validRetryTarget.button.getAttribute("aria-busy"),
  }};

  process.stdout.write(JSON.stringify({{
    staleAudio,
    staleRetry,
    validAudio,
    validRetry,
    requests,
    renders,
    unlockSchedules,
    busyObservations,
  }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
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
        result = json.loads(completed.stdout)
        self.assertEqual(
            result["staleAudio"],
            {"messages": [], "inFlight": False, "unlockAt": 0, "incarnation": "i-2"},
        )
        self.assertEqual(
            result["staleRetry"],
            {"messages": [], "disabled": False, "busy": None, "incarnation": "i-3"},
        )
        self.assertEqual(
            result["validAudio"],
            {"messages": [{"message": "player.switchedPart", "isError": False}]},
        )
        self.assertEqual(
            result["validRetry"],
            {
                "messages": [{"message": "cache.retryStarted", "isError": False}],
                "disabled": False,
                "busy": None,
            },
        )
        self.assertEqual(len(result["requests"]), 4)
        self.assertEqual(result["renders"], 2)
        self.assertEqual(result["unlockSchedules"], 2)
        self.assertEqual(result["busyObservations"], 2)

    def test_remote_queue_retry_stale_releases_only_its_button(self):
        start = self.queue_source.index("async function handleQueueAction")
        end = self.queue_source.index("function beginDrag", start)
        queue_action = self.queue_source[start:end]
        script = f"""
class FakeButton {{
  constructor() {{ this.disabled = false; this.attributes = {{}}; }}
  getAttribute(name) {{ return this.attributes[name] ?? null; }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  removeAttribute(name) {{ delete this.attributes[name]; }}
}}
const state = {{ data: {{ state_revision: 1 }} }};
const window = {{ confirm: () => true }};
const messages = [];
let commandApplied = false;
let requests = 0;
let busyObservations = 0;
let renders = 0;
function t(key) {{ return key; }}
function setFormMessage(message, isError = false) {{ messages.push({{ message, isError }}); }}
function render() {{ renders += 1; }}
async function apiPost() {{ throw new Error("generic post must not handle exact retry"); }}
async function apiPostExactStateCommand(path, payload) {{
  requests += 1;
  if (
    path !== "/api/cache/retry"
    || payload.item_id !== "song-a"
    || payload.expected_item_incarnation_id !== "i-a"
  ) throw new Error("wrong exact retry payload");
  if (activeButton.disabled && activeButton.getAttribute("aria-busy") === "true") {{
    busyObservations += 1;
  }}
  return {{ snapshotAccepted: true, commandApplied }};
}}
{queue_action}
let activeButton = new FakeButton();
(async () => {{
  await handleQueueAction("retry-cache", "song-a", "i-a", activeButton);
  const stale = {{
    messages: messages.splice(0),
    disabled: activeButton.disabled,
    busy: activeButton.getAttribute("aria-busy"),
  }};
  commandApplied = true;
  activeButton = new FakeButton();
  await handleQueueAction("retry-cache", "song-a", "i-a", activeButton);
  const valid = {{
    messages: messages.splice(0),
    disabled: activeButton.disabled,
    busy: activeButton.getAttribute("aria-busy"),
  }};
  process.stdout.write(JSON.stringify({{
    stale, valid, requests, busyObservations, renders,
  }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
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
        result = json.loads(completed.stdout)
        self.assertEqual(
            result,
            {
                "stale": {"messages": [], "disabled": False, "busy": None},
                "valid": {
                    "messages": [
                        {"message": "cache.retryStarted", "isError": False}
                    ],
                    "disabled": False,
                    "busy": None,
                },
                "requests": 2,
                "busyObservations": 2,
                "renders": 2,
            },
        )


if __name__ == "__main__":
    unittest.main()
