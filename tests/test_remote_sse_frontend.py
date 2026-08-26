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
        start = source.index("async function sendPlayerControl")
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

        self.assertIn("applyStateSnapshot(payload.data);", polling_source)
        self.assertNotIn("state.data = payload.data", polling_source)

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
  inverseAccepted,
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
        self.assertFalse(result["inverseAccepted"])
        self.assertEqual(result["finalGeneration"], 2)

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
const currentCacheState = new FakeElement();
const elements = {{ audioVariantBar, currentCacheState }};
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
  await audioVariantBar.listeners.click({{ target: audioEventButton(state.data.current_item) }});
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
  await audioVariantBar.listeners.click({{ target: audioEventButton(state.data.current_item) }});
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
