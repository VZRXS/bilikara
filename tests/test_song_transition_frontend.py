from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


class SongTransitionFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text(
            encoding="utf-8"
        )

    @classmethod
    def source_slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            [
                "node",
                "-e",
                (
                    "(async () => {\n"
                    "function applyFreshStateSnapshot(snapshot) { state.data = snapshot; return true; }\n"
                    "async function apiPostStateSnapshot(url, payload) { return applyFreshStateSnapshot(await apiPost(url, payload)); }\n"
                    f"{script}\n"
                    "})().catch((error) => { console.error(error); process.exit(1); });"
                ),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    def test_configured_zero_delay_is_not_replaced_with_default(self):
        functions = self.source_slice(
            "function currentSongAdvanceDelaySeconds", "function clampMediaTime"
        )
        result = self.run_node(
            f"""
const state = {{ data: {{ player_settings: {{ song_advance_delay_seconds: 0 }} }} }};
const defaultSongAdvanceDelaySeconds = 3;
const maxSongAdvanceDelaySeconds = 30;
{functions}
console.log(JSON.stringify({{
  current: currentSongAdvanceDelaySeconds(),
  manual: manualTransitionOverlaySeconds(),
}}));
"""
        )
        self.assertEqual(result, {"current": 0, "manual": 0})

    def test_manual_next_registers_hold_before_backend_and_deduplicates_races(self):
        hold_functions = self.source_slice(
            "function shouldHoldCurrentItemForTransition",
            "function stopMountedPlayerForAdvanceDelay",
        )
        advance_functions = self.source_slice(
            "async function advanceLocalPlayerNow", "async function reorderPlaylist"
        )
        result = self.run_node(
            f"""
const oldItem = {{ id: "old" }}; const nextItem = {{ id: "next" }};
const state = {{
  data: {{
    playback_generation: 9,
    current_item: oldItem,
    playlist: [nextItem],
    player_settings: {{ song_advance_delay_seconds: 3 }},
  }},
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function queuedNextItem() {{ return state.data.playlist[0] || null; }}
function manualTransitionOverlaySeconds() {{ return 3; }}
function currentSongAdvanceDelaySeconds() {{ return 3; }}
function clearLocalAdvanceDelay() {{
  state.manualTransitionHoldItemId = ""; state.manualTransitionHoldGeneration = 0;
}}
let apiCalls = 0; let heldBeforeResponse = false; let renders = 0; let nextPayload = null;
async function apiPost(_url, payload) {{
  apiCalls += 1;
  nextPayload = payload;
  heldBeforeResponse = shouldHoldCurrentItemForTransition(nextItem)
    && state.localShouldBePlaying === false;
  await Promise.resolve();
  return {{ current_item: nextItem, playlist: [], player_settings: {{ song_advance_delay_seconds: 3 }} }};
}}
function maybeShowSongTransitionOverlay() {{}}
function render() {{ renders += 1; }}
function syncMountedLocalPlayer() {{}}
function setAppMessage() {{}}
function isCurrentHostPlaybackSession() {{ return false; }}
function isSafeHostSnapshotInteger(value, minimum = 0) {{
  return Number.isSafeInteger(value) && value >= minimum;
}}
{hold_functions}
{advance_functions}
await Promise.all([
  handleLocalPlaybackEnded("media-ended"),
  handleLocalPlaybackEnded("manual-next"),
]);
await requestNextTrack();
console.log(JSON.stringify({{
  apiCalls, heldBeforeResponse, renders,
  inFlight: state.localAdvanceInFlight,
  holdItem: state.manualTransitionHoldItemId,
  shouldPlay: state.localShouldBePlaying, nextPayload,
}}));
"""
        )
        self.assertEqual(result["apiCalls"], 1)
        self.assertTrue(result["heldBeforeResponse"])
        self.assertEqual(result["renders"], 1)
        self.assertTrue(result["inFlight"])
        self.assertEqual(result["holdItem"], "next")
        self.assertFalse(result["shouldPlay"])
        self.assertEqual(result["nextPayload"], {"playback_generation": 9})

    def test_manual_next_zero_delay_mutates_once_without_hold(self):
        hold_functions = self.source_slice(
            "function shouldHoldCurrentItemForTransition",
            "function stopMountedPlayerForAdvanceDelay",
        )
        advance_functions = self.source_slice(
            "async function advanceLocalPlayerNow", "async function reorderPlaylist"
        )
        result = self.run_node(
            f"""
const nextItem = {{ id: "next" }};
const state = {{
  data: {{ playback_generation: 12, current_item: {{ id: "old" }}, playlist: [nextItem] }},
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function queuedNextItem() {{ return state.data.playlist[0] || null; }}
function manualTransitionOverlaySeconds() {{ return 0; }}
function currentSongAdvanceDelaySeconds() {{ return 0; }}
function clearLocalAdvanceDelay() {{}}
let apiCalls = 0; let nextPayload = null;
async function apiPost(_url, payload) {{
  apiCalls += 1;
  nextPayload = payload;
  return {{ playback_generation: 13, current_item: nextItem, playlist: [] }};
}}
function maybeShowSongTransitionOverlay() {{ throw new Error("zero delay must not register overlay"); }}
function render() {{}}
function syncMountedLocalPlayer() {{}}
function setAppMessage() {{}}
function isCurrentHostPlaybackSession() {{ return false; }}
function isSafeHostSnapshotInteger(value, minimum = 0) {{
  return Number.isSafeInteger(value) && value >= minimum;
}}
{hold_functions}
{advance_functions}
await requestNextTrack();
console.log(JSON.stringify({{
  apiCalls, inFlight: state.localAdvanceInFlight,
  generation: state.manualTransitionHoldGeneration,
  shouldPlay: state.localShouldBePlaying, nextPayload,
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "apiCalls": 1,
                "inFlight": False,
                "generation": 0,
                "shouldPlay": True,
                "nextPayload": {"playback_generation": 12},
            },
        )

    def test_stale_next_releases_only_its_transition_after_program_replacement(self):
        hold_functions = self.source_slice(
            "function shouldHoldCurrentItemForTransition",
            "function stopMountedPlayerForAdvanceDelay",
        )
        maybe_transition = self.source_slice(
            "function maybeShowSongTransitionOverlay",
            "function hasPendingSongTransitionOverlayForItem",
        )
        clear_delay = self.source_slice(
            "function clearLocalAdvanceDelay",
            "async function finishLocalAdvanceDelay",
        )
        advance_functions = self.source_slice(
            "async function advanceLocalPlayerNow", "async function reorderPlaylist"
        )
        result = self.run_node(
            f"""
const window = {{
  clearTimeout() {{}}, clearInterval() {{}},
}};
const oldItem = {{ id: "A" }};
const nextItem = {{ id: "B" }};
const programA = {{ item_id: "A", selected_audio_variant_id: "instrumental", artifact_set_id: "set-a1" }};
const state = {{
  data: {{
    playback_generation: 9, playback_program: programA,
    current_item: oldItem, playlist: [nextItem],
    player_settings: {{ song_advance_delay_seconds: 3 }},
  }},
  hostPlaybackSession: null,
  localShouldBePlaying: true, localAdvanceInFlight: false,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
  localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
  localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
  songTransitionGeneration: 0, manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function queuedNextItem() {{ return state.data.playlist[0] || null; }}
function manualTransitionOverlaySeconds() {{ return 3; }}
function currentSongAdvanceDelaySeconds() {{ return 3; }}
function hidePlayerDelayOverlay() {{}}
function hasLocalAdvanceDelayOverlay() {{ return false; }}
function isSafeHostSnapshotInteger(value, minimum = 0) {{
  return Number.isSafeInteger(value) && value >= minimum;
}}
function sameProgram(left, right) {{
  return left?.item_id === right?.item_id
    && left?.selected_audio_variant_id === right?.selected_audio_variant_id
    && left?.artifact_set_id === right?.artifact_set_id;
}}
function isCurrentHostPlaybackSession(session, video, audio) {{
  return session === state.hostPlaybackSession
    && session?.cleanupState === "active"
    && session.playbackGeneration === state.data.playback_generation
    && sameProgram(session.playbackProgram, state.data.playback_program)
    && session.video === video && session.audio === audio;
}}
let rejectNext = null;
let resolveNext = null;
let apiCalls = 0;
let syncCalls = 0;
let replacementPairEffects = 0;
async function apiPost() {{
  apiCalls += 1;
  return new Promise((resolve, reject) => {{
    resolveNext = resolve;
    rejectNext = reject;
  }});
}}
function render() {{}}
function setAppMessage() {{}}
function syncMountedLocalPlayer() {{
  syncCalls += 1;
  const session = state.hostPlaybackSession;
  if (session?.playbackGeneration === state.data.playback_generation) {{
    replacementPairEffects += 1;
  }}
}}
{hold_functions}
{maybe_transition}
{clear_delay}
{advance_functions}

async function runReplacement(selectedVariant, artifactSetId) {{
  Object.assign(state, {{
    data: {{
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem],
      player_settings: {{ song_advance_delay_seconds: 3 }},
    }},
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  }});
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  const oldSession = {{
    cleanupState: "active", playbackGeneration: 9, playbackProgram: programA,
    video: {{}}, audio: {{}},
  }};
  state.hostPlaybackSession = oldSession;
  const pending = requestNextTrack();
  const heldBeforeReplacement = state.manualTransitionHoldItemId === "B"
    && state.manualTransitionHoldGeneration === 1
    && state.localAdvanceInFlight;

  const replacementProgram = {{
    item_id: "A", selected_audio_variant_id: selectedVariant,
    artifact_set_id: artifactSetId,
  }};
  state.data = {{
    playback_generation: 10, playback_program: replacementProgram,
    current_item: oldItem, playlist: [nextItem],
    player_settings: {{ song_advance_delay_seconds: 3 }},
  }};
  oldSession.cleanupState = "retired";
  state.hostPlaybackSession = {{
    cleanupState: "active", playbackGeneration: 10,
    playbackProgram: replacementProgram, video: {{}}, audio: {{}},
  }};
  rejectNext(new Error("playback_generation_mismatch"));
  await pending;
  return {{
    heldBeforeReplacement, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingOverlay: state.pendingSongTransitionOverlayData,
    delayTimer: state.localAdvanceDelayTimer,
    countdownTimer: state.localAdvanceCountdownTimer,
    deadline: state.localAdvanceDelayDeadline,
    inFlight: state.localAdvanceInFlight,
    replacementPairEffects, syncCalls, apiCalls,
  }};
}}

async function runNetworkFailure() {{
  Object.assign(state, {{
    data: {{
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem],
      player_settings: {{ song_advance_delay_seconds: 3 }},
    }},
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  }});
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  state.hostPlaybackSession = {{
    cleanupState: "active", playbackGeneration: 9, playbackProgram: programA,
    video: {{}}, audio: {{}},
  }};
  const pending = requestNextTrack();
  rejectNext(new Error("network failure"));
  await pending;
  return {{
    holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  }};
}}

async function runNewerTransition() {{
  Object.assign(state, {{
    data: {{
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem], state_revision: 1,
      player_settings: {{ song_advance_delay_seconds: 3 }},
    }},
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  }});
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  const oldSession = {{
    cleanupState: "active", playbackGeneration: 9, playbackProgram: programA,
    video: {{}}, audio: {{}},
  }};
  state.hostPlaybackSession = oldSession;
  const pending = requestNextTrack();
  const oldGeneration = state.manualTransitionHoldGeneration;
  const previousData = state.data;
  const newerItem = {{ id: "C" }};
  const newerProgram = {{
    item_id: "C", selected_audio_variant_id: "instrumental",
    artifact_set_id: "set-c1",
  }};
  state.data = {{
    playback_generation: 10, playback_program: newerProgram,
    current_item: newerItem, playlist: [], state_revision: 2,
    player_settings: {{ song_advance_delay_seconds: 3 }},
  }};
  maybeShowSongTransitionOverlay(previousData, state.data);
  oldSession.cleanupState = "retired";
  state.hostPlaybackSession = {{
    cleanupState: "active", playbackGeneration: 10,
    playbackProgram: newerProgram, video: {{}}, audio: {{}},
  }};
  rejectNext(new Error("playback_generation_mismatch"));
  await pending;
  return {{
    oldGeneration, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    pendingGeneration: state.pendingSongTransitionGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  }};
}}

async function runAcceptedInverseResponse() {{
  Object.assign(state, {{
    data: {{
      playback_generation: 9, playback_program: programA,
      current_item: oldItem, playlist: [nextItem], state_revision: 1,
      player_settings: {{ song_advance_delay_seconds: 3 }},
    }},
    localShouldBePlaying: true, localAdvanceInFlight: false,
    pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
    localAdvanceDelayTimer: null, localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0, localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0, localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null, localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "", localAdvanceDelayToken: 0,
    songTransitionGeneration: 0, manualTransitionHoldItemId: "",
    manualTransitionHoldGeneration: 0, lastSongTransitionOverlayKey: "",
  }});
  apiCalls = 0; syncCalls = 0; replacementPairEffects = 0;
  state.hostPlaybackSession = {{
    cleanupState: "active", playbackGeneration: 9, playbackProgram: programA,
    video: {{}}, audio: {{}},
  }};
  const originalApply = applyFreshStateSnapshot;
  applyFreshStateSnapshot = (snapshot) => snapshot?.inverse
    ? false
    : originalApply(snapshot);
  const pending = requestNextTrack();
  const acceptedItem = {{ id: "B" }};
  const acceptedProgram = {{
    item_id: "B", selected_audio_variant_id: "instrumental",
    artifact_set_id: "set-b1",
  }};
  state.data = {{
    playback_generation: 10, playback_program: acceptedProgram,
    current_item: acceptedItem, playlist: [], state_revision: 3,
    player_settings: {{ song_advance_delay_seconds: 3 }},
  }};
  resolveNext({{ inverse: true }});
  const accepted = await pending;
  applyFreshStateSnapshot = originalApply;
  return {{
    accepted, holdItem: state.manualTransitionHoldItemId,
    holdGeneration: state.manualTransitionHoldGeneration,
    pendingItem: state.pendingSongTransitionOverlayData?.current_item?.id || "",
    pendingGeneration: state.pendingSongTransitionGeneration,
    inFlight: state.localAdvanceInFlight,
    shouldPlay: state.localShouldBePlaying,
    replacementPairEffects, syncCalls, apiCalls,
  }};
}}
console.log(JSON.stringify({{
  variant: await runReplacement("vocal", "set-a1"),
  artifact: await runReplacement("instrumental", "set-a2"),
  network: await runNetworkFailure(),
  newerTransition: await runNewerTransition(),
  acceptedInverse: await runAcceptedInverseResponse(),
}}));
"""
        )
        expected = {
            "heldBeforeReplacement": True,
            "holdItem": "",
            "holdGeneration": 0,
            "pendingOverlay": None,
            "delayTimer": None,
            "countdownTimer": None,
            "deadline": 0,
            "inFlight": False,
            "replacementPairEffects": 0,
            "syncCalls": 0,
            "apiCalls": 1,
        }
        self.assertEqual(result["variant"], expected)
        self.assertEqual(result["artifact"], expected)
        self.assertEqual(
            result["network"],
            {
                "holdItem": "",
                "holdGeneration": 0,
                "inFlight": False,
                "shouldPlay": True,
                "replacementPairEffects": 1,
                "syncCalls": 1,
                "apiCalls": 1,
            },
        )
        self.assertEqual(
            result["newerTransition"],
            {
                "oldGeneration": 1,
                "holdItem": "C",
                "holdGeneration": 2,
                "pendingItem": "C",
                "pendingGeneration": 2,
                "inFlight": True,
                "shouldPlay": False,
                "replacementPairEffects": 0,
                "syncCalls": 0,
                "apiCalls": 1,
            },
        )
        self.assertEqual(
            result["acceptedInverse"],
            {
                "accepted": True,
                "holdItem": "B",
                "holdGeneration": 1,
                "pendingItem": "B",
                "pendingGeneration": 1,
                "inFlight": True,
                "shouldPlay": False,
                "replacementPairEffects": 0,
                "syncCalls": 0,
                "apiCalls": 1,
            },
        )

    def test_inverse_play_now_responses_cannot_restore_an_older_current_item(self):
        freshness = self.source_slice(
            "function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"
        )
        playlist_action = self.source_slice(
            "async function handlePlaylistAction", "elements.addForm.addEventListener"
        )
        result = self.run_node(
            f"""
const state = {{
  data: snapshot(1, 1, 1, "song-a", "i-a", "a-a"),
  localShouldBePlaying: true,
  localAdvanceInFlight: false,
}};
const window = {{ location: {{ href: "http://127.0.0.1:8080/" }} }};
function snapshot(stateRevision, revision, generation, itemId, incarnation, artifact) {{
  const variantId = "instrumental";
  const currentItem = {{
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: variantId,
    artifact_set_id: artifact,
    video_media_url: `/media/${{artifact}}/video.mp4`,
    audio_variants: [{{ id: variantId, audio_url: `/media/${{artifact}}/audio.m4a` }}],
  }};
  return {{
    state_revision: stateRevision,
    revision,
    playback_generation: generation,
    playback_program: {{
      item_id: itemId,
      item_incarnation_id: incarnation,
      selected_audio_variant_id: variantId,
      artifact_set_id: artifact,
    }},
    current_item: currentItem,
  }};
}}
class Button {{
  constructor(id) {{
    this.dataset = {{ id, action: "play-now" }};
    this.disabled = false;
    this.attributes = new Map();
  }}
  getAttribute(name) {{ return this.attributes.get(name) || null; }}
  setAttribute(name, value) {{ this.attributes.set(name, String(value)); }}
  removeAttribute(name) {{ this.attributes.delete(name); }}
}}
const pending = new Map();
function apiPost(_url, payload) {{
  return new Promise((resolve) => pending.set(payload.item_id, resolve));
}}
function manualTransitionOverlaySeconds() {{ return 0; }}
function shouldHoldCurrentItemForTransition() {{ return false; }}
function closeOpenMenus() {{}}
function setAppMessage(message) {{ throw new Error(message); }}
const rendered = [];
function render() {{ rendered.push(state.data.current_item.id); }}
function clearLocalAdvanceDelay() {{}}
function registerManualTransitionHold() {{ return 0; }}
function maybeShowSongTransitionOverlay() {{}}
function syncMountedLocalPlayer() {{}}
{freshness}
{playlist_action}
const playB = handlePlaylistAction(new Button("song-b"));
const playC = handlePlaylistAction(new Button("song-c"));
pending.get("song-c")(snapshot(3, 3, 3, "song-c", "i-c", "a-c"));
await Promise.resolve();
pending.get("song-b")(snapshot(2, 2, 2, "song-b", "i-b", "a-b"));
await Promise.all([playB, playC]);
console.log(JSON.stringify({{
  current: state.data.current_item.id,
  revision: state.data.state_revision,
  rendered,
}}));
"""
        )
        self.assertEqual(
            result,
            {"current": "song-c", "revision": 3, "rendered": ["song-c"]},
        )

    def test_polling_same_transition_does_not_register_again(self):
        hold_functions = self.source_slice(
            "function shouldHoldCurrentItemForTransition",
            "function stopMountedPlayerForAdvanceDelay",
        )
        maybe_function = self.source_slice(
            "function maybeShowSongTransitionOverlay",
            "function hasPendingSongTransitionOverlayForItem",
        )
        result = self.run_node(
            f"""
const previous = {{ current_item: {{ id: "old" }}, state_revision: 1 }};
const next = {{ current_item: {{ id: "next", title: "Next" }}, state_revision: 2 }};
const state = {{
  data: next, localShouldBePlaying: true,
  pendingSongTransitionOverlayData: null, pendingSongTransitionGeneration: 0,
  lastSongTransitionOverlayKey: "", songTransitionGeneration: 0,
  manualTransitionHoldItemId: "", manualTransitionHoldGeneration: 0,
  localAdvanceDelayDeadline: 0, localAdvanceDelayItemId: "",
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function manualTransitionOverlaySeconds() {{ return 3; }}
function hasLocalAdvanceDelayOverlay() {{ return false; }}
function clearLocalAdvanceDelay() {{}}
{hold_functions}
{maybe_function}
maybeShowSongTransitionOverlay(previous, next);
const firstGeneration = state.manualTransitionHoldGeneration;
maybeShowSongTransitionOverlay(previous, next);
console.log(JSON.stringify({{
  firstGeneration,
  finalGeneration: state.manualTransitionHoldGeneration,
  pendingItem: state.pendingSongTransitionOverlayData.current_item.id,
}}));
"""
        )
        self.assertEqual(
            result,
            {"firstGeneration": 1, "finalGeneration": 1, "pendingItem": "next"},
        )

    def test_stale_completion_cannot_resume_newer_item_and_valid_completion_runs_once(self):
        resume_function = self.source_slice(
            "function resumeMountedPlayerAfterOverlay",
            "function shouldHoldCurrentItemForTransition",
        )
        result = self.run_node(
            f"""
const video = {{ dataset: {{ playerItemId: "new" }} }}; const audio = {{}};
const oldVideo = {{ dataset: {{ playerItemId: "new" }} }}; const oldAudio = {{}};
const program = {{
  item_id: "new", item_incarnation_id: "i-new",
  selected_audio_variant_id: "v", artifact_set_id: "a",
}};
const oldSession = {{
  playbackGeneration: 1, playbackProgram: program, cleanupState: "retired",
  video: oldVideo, audio: oldAudio,
}};
const currentSession = {{
  playbackGeneration: 2, playbackProgram: program, cleanupState: "active",
  video, audio,
}};
const state = {{
  data: {{
    current_item: {{ id: "new" }},
    playback_generation: 2,
    playback_program: program,
  }},
  hostPlaybackSession: currentSession,
  manualTransitionHoldItemId: "new", manualTransitionHoldGeneration: 2,
  localShouldBePlaying: false, localPlaybackStartState: "established",
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
function isCurrentHostPlaybackSession(session, exactVideo, exactAudio) {{
  return session === state.hostPlaybackSession
    && session?.cleanupState === "active"
    && session.playbackGeneration === state.data.playback_generation
    && session.playbackProgram === state.data.playback_program
    && (exactVideo === undefined || session.video === exactVideo)
    && (exactAudio === undefined || session.audio === exactAudio);
}}
let stale = 0; let syncs = 0; let clears = 0;
function reportSplitSyncDiagnostic() {{ stale += 1; }}
function clearLocalAdvanceDelay() {{
  clears += 1; state.manualTransitionHoldItemId = "";
  state.manualTransitionHoldGeneration = 0;
}}
function syncSplitPlayer() {{ syncs += 1; }}
function currentAvOffsetSeconds() {{ return 0; }}
{resume_function}
resumeMountedPlayerAfterOverlay("new", 2, oldSession);
resumeMountedPlayerAfterOverlay("new", 2, currentSession);
resumeMountedPlayerAfterOverlay("new", 2, currentSession);
console.log(JSON.stringify({{ stale, syncs, clears, shouldPlay: state.localShouldBePlaying }}));
"""
        )
        self.assertEqual(
            result,
            {"stale": 1, "syncs": 1, "clears": 1, "shouldPlay": True},
        )

    def test_same_item_replacement_rebinds_active_countdown_to_the_new_session(self):
        equality = self.source_slice(
            "function playbackProgramDescriptorsEqual",
            "function isValidHostMediaLocator",
        )
        resume = self.source_slice(
            "function resumeMountedPlayerAfterOverlay",
            "function shouldHoldCurrentItemForTransition",
        )
        show = self.source_slice(
            "function showSongTransitionOverlayForData",
            "function maybeShowSongTransitionOverlay",
        )
        has_overlay = self.source_slice(
            "function hasLocalAdvanceDelayOverlay",
            "function startLocalAdvanceDelay",
        )
        clear_delay = self.source_slice(
            "function clearLocalAdvanceDelay",
            "async function finishLocalAdvanceDelay",
        )
        sessions = self.source_slice(
            "function hostPlaybackMountData",
            "function renderPlayer",
        )
        result = self.run_node(
            f"""
const localAdvanceOverlayFadeMs = 500;
let now = 1000;
const timers = [];
const intervals = [];
const window = {{
  setTimeout(callback, delay) {{
    const timer = {{ callback, delay, active: true }};
    timers.push(timer);
    return timer;
  }},
  clearTimeout(timer) {{ if (timer) timer.active = false; }},
  setInterval(callback, delay) {{
    const timer = {{ callback, delay, active: true }};
    intervals.push(timer);
    return timer;
  }},
  clearInterval(timer) {{ if (timer) timer.active = false; }},
}};
Date.now = () => now;

class FakeMedia {{
  constructor(tagName) {{
    this.tagName = tagName.toUpperCase();
    this.dataset = {{}};
    this.currentTime = 12;
    this.paused = true;
    this.attributes = {{}};
  }}
  setAttribute(name, value) {{ this.attributes[name] = String(value); }}
  removeAttribute(name) {{ delete this.attributes[name]; if (name === "src") this.src = ""; }}
  pause() {{ this.paused = true; }}
  load() {{}}
}}
class FakeFrame {{
  constructor() {{ this.children = []; }}
  querySelector() {{ return null; }}
  replaceChildren(...nodes) {{ this.children = [...nodes]; }}
  appendChild(node) {{ this.children.push(node); return node; }}
}}
const document = {{ createElement: (tagName) => new FakeMedia(tagName) }};
const elements = {{ playerFrame: new FakeFrame() }};
const state = {{
  data: null,
  hostPlaybackSession: null,
  hostPlaybackBootstrapRestartPending: false,
  pageHidePlaybackRestartRequired: false,
  pendingPlaybackRestore: null,
  pendingSongTransitionOverlayData: null,
  pendingSongTransitionGeneration: 0,
  localAdvanceDelayTimer: null,
  localAdvanceCountdownTimer: null,
  localAdvanceDelayStartAt: 0,
  localAdvanceDelayDeadline: 0,
  localAdvanceOverlayDurationMs: 0,
  localAdvanceOverlayPrimaryItem: null,
  localAdvanceOverlayFollowItems: null,
  localAdvanceOverlayTotalCount: null,
  localAdvanceDelayItemId: "",
  localAdvanceDelayToken: 0,
  localAdvanceInFlight: false,
  manualTransitionHoldItemId: "",
  manualTransitionHoldGeneration: 0,
  localShouldBePlaying: true,
  localPlaybackStartState: "established",
}};
let updates = 0;
let resumes = 0;
let syncs = 0;
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function manualTransitionOverlaySeconds() {{ return 3; }}
function updateLocalAdvanceDelayOverlay() {{ updates += 1; return true; }}
function hidePlayerDelayOverlay({{ onHidden = null }} = {{}}) {{ onHidden?.(); }}
function activeLocalPlayerElements() {{
  const session = state.hostPlaybackSession;
  return {{ video: session?.video || null, audio: session?.audio || null }};
}}
function syncSplitPlayer() {{ syncs += 1; }}
function startSplitPlaybackPair() {{ syncs += 1; }}
function currentAvOffsetSeconds() {{ return 0; }}
function selectedVideoUrlForItem(item) {{ return item.video_media_url; }}
function selectedAudioUrlForItem(item) {{
  return item.audio_variants.find((variant) => variant.id === item.selected_audio_variant_id)?.audio_url || "";
}}
function playerDelayOverlay() {{ return null; }}
function hasPendingSongTransitionOverlayForItem() {{ return false; }}
function captureLocalPlayerPreferences() {{}}
function renderEmptyHostPlaybackState() {{ elements.playerFrame.replaceChildren(); }}
function renderPreparingHostPlaybackState() {{ elements.playerFrame.replaceChildren(); }}
function clearLocalPlayerEventListeners() {{}}
function clearWebKitAudioStarvationTimer() {{}}
function clearLocalPlayerSyncTimer() {{}}
function clearPlayerFrameClickTimer() {{}}
function clearLocalPlayerSeekState() {{}}
function clearLocalPlayerControlsHideTimer() {{}}
function clearTauriMediaSessionState() {{}}
function disposeAudioPitchShifter() {{}}
function t(key) {{ return key; }}
{equality}
{resume}
{show}
{has_overlay}
{clear_delay}
{sessions}

function item(artifact, variant) {{
  return {{
    id: "song-b",
    item_incarnation_id: "inc-b",
    selected_audio_variant_id: variant,
    artifact_set_id: artifact,
    video_media_url: `/media/${{artifact}}/video.mp4`,
    audio_variants: [
      {{ id: "instrumental", audio_url: `/media/${{artifact}}/instrumental.m4a` }},
      {{ id: "vocal", audio_url: `/media/${{artifact}}/vocal.m4a` }},
    ],
  }};
}}
function program(artifact, variant) {{
  return {{
    item_id: "song-b",
    item_incarnation_id: "inc-b",
    selected_audio_variant_id: variant,
    artifact_set_id: artifact,
  }};
}}
function runReplacement(nextArtifact, nextVariant) {{
  now = 1000;
  timers.length = 0;
  intervals.length = 0;
  resumes = 0;
  syncs = 0;
  Object.assign(state, {{
    pendingPlaybackRestore: null,
    localAdvanceDelayTimer: null,
    localAdvanceCountdownTimer: null,
    localAdvanceDelayStartAt: 0,
    localAdvanceDelayDeadline: 0,
    localAdvanceOverlayDurationMs: 0,
    localAdvanceOverlayPrimaryItem: null,
    localAdvanceOverlayFollowItems: null,
    localAdvanceOverlayTotalCount: null,
    localAdvanceDelayItemId: "",
    localAdvanceDelayToken: 0,
    localAdvanceInFlight: false,
    manualTransitionHoldItemId: "song-b",
    manualTransitionHoldGeneration: 7,
    localShouldBePlaying: false,
    localPlaybackStartState: "established",
  }});
  const firstItem = item("artifact-1", "instrumental");
  const firstProgram = program("artifact-1", "instrumental");
  state.data = {{
    playback_generation: 10,
    playback_program: firstProgram,
    current_item: firstItem,
    playlist: [],
  }};
  const firstSession = createHostPlaybackSession(10, firstProgram);
  state.hostPlaybackSession = firstSession;
  mountHostPlaybackSessionElements(firstSession, firstItem, hostPlaybackMountData(firstItem, firstProgram));
  showSongTransitionOverlayForData(state.data, 7);
  const originalDeadline = state.localAdvanceDelayDeadline;
  const oldTimer = state.localAdvanceDelayTimer;

  now = 2000;
  const replacementItem = item(nextArtifact, nextVariant);
  const replacementProgram = program(nextArtifact, nextVariant);
  state.data = {{
    playback_generation: 11,
    playback_program: replacementProgram,
    current_item: replacementItem,
    playlist: [],
  }};
  const reconciliation = reconcileHostPlaybackSession(replacementItem);
  const replacementSession = state.hostPlaybackSession;
  const reboundTimer = state.localAdvanceDelayTimer;

  now = originalDeadline;
  oldTimer.callback();
  const afterOld = {{
    session: state.hostPlaybackSession === replacementSession,
    inFlight: state.localAdvanceInFlight,
    resumes,
  }};
  reboundTimer.callback();
  reboundTimer.callback();
  return {{
    kind: reconciliation.kind,
    oldRetired: firstSession.cleanupState,
    rebound: reboundTimer !== oldTimer,
    remainingDelay: reboundTimer.delay,
    deadlinePreserved: originalDeadline === 4500,
    afterOld,
    final: {{
      inFlight: state.localAdvanceInFlight,
      holdItem: state.manualTransitionHoldItemId,
      deadline: state.localAdvanceDelayDeadline,
      shouldPlay: state.localShouldBePlaying,
      resumes,
      syncs,
      media: elements.playerFrame.children.map((node) => node.tagName),
    }},
  }};
}}

const originalResume = resumeMountedPlayerAfterOverlay;
resumeMountedPlayerAfterOverlay = (...args) => {{
  const resumed = originalResume(...args);
  if (resumed) resumes += 1;
  return resumed;
}};
console.log(JSON.stringify({{
  artifact: runReplacement("artifact-2", "instrumental"),
  variant: runReplacement("artifact-1", "vocal"),
}}));
"""
        )
        for replacement in (result["artifact"], result["variant"]):
            self.assertEqual(replacement["kind"], "mounted")
            self.assertEqual(replacement["oldRetired"], "retired")
            self.assertTrue(replacement["rebound"])
            self.assertEqual(replacement["remainingDelay"], 2500)
            self.assertTrue(replacement["deadlinePreserved"])
            self.assertEqual(
                replacement["afterOld"],
                {"session": True, "inFlight": True, "resumes": 0},
            )
            self.assertEqual(
                replacement["final"],
                {
                    "inFlight": False,
                    "holdItem": "",
                    "deadline": 0,
                    "shouldPlay": True,
                    "resumes": 1,
                    "syncs": 1,
                    "media": ["VIDEO", "AUDIO"],
                },
            )

    def test_configured_countdown_holds_correct_item_and_resumes_once(self):
        show_function = self.source_slice(
            "function showSongTransitionOverlayForData",
            "function maybeShowSongTransitionOverlay",
        )
        result = self.run_node(
            f"""
const item = {{ id: "next", title: "Next song" }};
const video = {{ dataset: {{ playerItemId: "next" }} }};
const audio = {{}};
const session = {{ cleanupState: "active", video, audio }};
const state = {{
  data: {{ current_item: item }}, hostPlaybackSession: session,
  localAdvanceDelayToken: 4, localAdvanceInFlight: false,
  localAdvanceCountdownTimer: null, localAdvanceDelayTimer: null,
  manualTransitionHoldItemId: "next", manualTransitionHoldGeneration: 7,
  localShouldBePlaying: true,
}};
const localAdvanceOverlayFadeMs = 200;
const timers = []; const intervals = []; let updates = 0; let resumes = 0;
const window = {{
  setTimeout(callback, delay) {{ timers.push({{ callback, delay }}); return timers.length; }},
  setInterval(callback, delay) {{ intervals.push({{ callback, delay }}); return intervals.length; }},
  clearInterval() {{}},
}};
Date.now = () => 1000;
function manualTransitionOverlaySeconds() {{ return 3; }}
function isCurrentHostPlaybackSession(candidate, exactVideo, exactAudio) {{
  return candidate === state.hostPlaybackSession
    && candidate?.cleanupState === "active"
    && (exactVideo === undefined || candidate.video === exactVideo)
    && (exactAudio === undefined || candidate.audio === exactAudio);
}}
function clearLocalAdvanceDelay({{ resetInFlight = false }} = {{}}) {{
  state.localAdvanceDelayToken += 1;
  if (resetInFlight) state.localAdvanceInFlight = false;
}}
function updateLocalAdvanceDelayOverlay() {{ updates += 1; }}
function registerManualTransitionHold() {{ return 7; }}
function hidePlayerDelayOverlay({{ onHidden }}) {{ onHidden(); }}
function resumeMountedPlayerAfterOverlay(itemId, generation) {{
  if (itemId === "next" && generation === 7) {{
    resumes += 1;
    state.manualTransitionHoldItemId = "";
    state.manualTransitionHoldGeneration = 0;
    state.localAdvanceInFlight = false;
  }}
}}
{show_function}
showSongTransitionOverlayForData({{
  current_item: item,
  playlist: [{{ id: "later" }}],
  player_settings: {{ song_advance_delay_seconds: 3 }},
}}, 7);
const held = state.localShouldBePlaying === false;
const delay = timers[0].delay;
timers[0].callback();
timers[0].callback();
console.log(JSON.stringify({{
  held, delay, resumes, updates,
  itemId: state.localAdvanceDelayItemId,
  inFlight: state.localAdvanceInFlight,
}}));
"""
        )
        self.assertEqual(result["delay"], 3200)
        self.assertTrue(result["held"])
        self.assertEqual(result["resumes"], 1)
        self.assertEqual(result["itemId"], "next")
        self.assertFalse(result["inFlight"])
        self.assertGreaterEqual(result["updates"], 2)

    def test_all_mount_and_recovery_paths_use_authoritative_hold(self):
        renderer = self.source_slice(
            "function renderPlayer(currentItem, playbackMode)",
            "function applyRemotePlayerControl",
        )
        sync = self.source_slice("function syncSplitPlayer", "function syncMountedLocalPlayer")
        self.assertIn("const shouldAutoplay = !shouldHoldCurrentItemForTransition(currentItem)", renderer)
        self.assertIn("shouldHoldCurrentItemForTransition(currentItem)", renderer)
        self.assertIn("shouldHoldCurrentItemForTransition(video.dataset.playerItemId)", sync)
        self.assertIn('return reportAction("transition-hold")', sync)
        self.assertIn("pendingSongTransitionGeneration", self.source)
        self.assertIn("registerManualTransitionHold(nextItemId)", self.source)
        self.assertIn("generation: transitionGeneration", self.source)
        self.assertIn('requestNextTrack().catch(() => {})', self.source)
        self.assertIn('action === "play-now"', self.source)
        self.assertIn("state.pendingSongTransitionOverlayData = null", self.source_slice(
            "function retireHostPlaybackSession", "function replaceHostPlayerView"
        ))

    def test_all_next_surfaces_share_the_exact_rust_generation_transport(self):
        advance = self.source_slice(
            "async function advanceLocalPlayerNow",
            "async function reorderPlaylist",
        )
        media_session = self.source_slice(
            "function handleTauriMediaSessionAction",
            "function ensureTauriMediaSessionHandlers",
        )
        controller = self.source_slice(
            "async function applyControllerCommand",
            "function presentationPlaybackStateModel",
        )
        remote_control = self.source_slice(
            "function applyRemotePlayerControl",
            "async function ackRemotePlayerControl",
        )
        ended = self.source_slice(
            "async function handleSplitAudioEnded",
            "function holdVideoForAudio",
        )
        overlay_completion = self.source_slice(
            "async function finishLocalAdvanceDelay",
            "function setPlayerFrameContent",
        )
        remote_source = (
            Path(__file__).resolve().parents[1] / "static" / "remote.js"
        ).read_text(encoding="utf-8")
        remote_next_start = remote_source.index("async function sendPlayerNext")
        remote_next_end = remote_source.index("function disconnectClient", remote_next_start)
        remote_next = remote_source[remote_next_start:remote_next_end]

        self.assertIn("session?.playbackGeneration", advance)
        self.assertIn("playback_generation: expectedPlaybackGeneration", advance)
        self.assertIn('apiPostStateSnapshot("/api/player/next", {', advance)
        self.assertIn('handleLocalPlaybackEnded("media-ended", state.hostPlaybackSession)', ended)
        self.assertIn("advanceLocalPlayerNow({ showTransition: false, session })", overlay_completion)
        self.assertIn('requestNextTrack().catch(() => {})', media_session)
        self.assertIn('case "nextTrack"', controller)
        self.assertIn("await requestNextTrack()", controller)
        self.assertIn('action === "next-track"', remote_control)
        self.assertIn('requestNextTrack().catch(() => {})', remote_control)
        self.assertIn("state.data.playback_generation", remote_next)
        self.assertIn("playback_generation: expectedPlaybackGeneration", remote_next)


if __name__ == "__main__":
    unittest.main()
