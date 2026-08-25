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
  data: {{ current_item: oldItem, playlist: [nextItem], player_settings: {{ song_advance_delay_seconds: 3 }} }},
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
let apiCalls = 0; let heldBeforeResponse = false; let renders = 0;
async function apiPost() {{
  apiCalls += 1;
  heldBeforeResponse = shouldHoldCurrentItemForTransition(nextItem)
    && state.localShouldBePlaying === false;
  await Promise.resolve();
  return {{ current_item: nextItem, playlist: [], player_settings: {{ song_advance_delay_seconds: 3 }} }};
}}
function maybeShowSongTransitionOverlay() {{}}
function render() {{ renders += 1; }}
function syncMountedLocalPlayer() {{}}
function setAppMessage() {{}}
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
  shouldPlay: state.localShouldBePlaying,
}}));
"""
        )
        self.assertEqual(result["apiCalls"], 1)
        self.assertTrue(result["heldBeforeResponse"])
        self.assertEqual(result["renders"], 1)
        self.assertTrue(result["inFlight"])
        self.assertEqual(result["holdItem"], "next")
        self.assertFalse(result["shouldPlay"])

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
  data: {{ current_item: {{ id: "old" }}, playlist: [nextItem] }},
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
let apiCalls = 0;
async function apiPost() {{ apiCalls += 1; return {{ current_item: nextItem, playlist: [] }}; }}
function maybeShowSongTransitionOverlay() {{ throw new Error("zero delay must not register overlay"); }}
function render() {{}}
function syncMountedLocalPlayer() {{}}
function setAppMessage() {{}}
{hold_functions}
{advance_functions}
await requestNextTrack();
console.log(JSON.stringify({{
  apiCalls, inFlight: state.localAdvanceInFlight,
  generation: state.manualTransitionHoldGeneration,
  shouldPlay: state.localShouldBePlaying,
}}));
"""
        )
        self.assertEqual(
            result,
            {"apiCalls": 1, "inFlight": False, "generation": 0, "shouldPlay": True},
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
const state = {{
  data: {{ current_item: {{ id: "new" }} }},
  manualTransitionHoldItemId: "new", manualTransitionHoldGeneration: 2,
  localShouldBePlaying: false, localPlaybackStartState: "established",
}};
function currentItemIdFromData(data) {{ return String(data?.current_item?.id || ""); }}
function activeLocalPlayerElements() {{ return {{ video, audio }}; }}
let stale = 0; let syncs = 0; let clears = 0;
function reportSplitSyncDiagnostic() {{ stale += 1; }}
function clearLocalAdvanceDelay() {{
  clears += 1; state.manualTransitionHoldItemId = "";
  state.manualTransitionHoldGeneration = 0;
}}
function syncSplitPlayer() {{ syncs += 1; }}
function currentAvOffsetSeconds() {{ return 0; }}
{resume_function}
resumeMountedPlayerAfterOverlay("old", 1);
resumeMountedPlayerAfterOverlay("new", 2);
resumeMountedPlayerAfterOverlay("new", 2);
console.log(JSON.stringify({{ stale, syncs, clears, shouldPlay: state.localShouldBePlaying }}));
"""
        )
        self.assertEqual(
            result,
            {"stale": 2, "syncs": 1, "clears": 1, "shouldPlay": True},
        )

    def test_configured_countdown_holds_correct_item_and_resumes_once(self):
        show_function = self.source_slice(
            "function showSongTransitionOverlayForData",
            "function maybeShowSongTransitionOverlay",
        )
        result = self.run_node(
            f"""
const item = {{ id: "next", title: "Next song" }};
const state = {{
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


if __name__ == "__main__":
    unittest.main()
