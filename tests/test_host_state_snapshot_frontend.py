from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HostStateSnapshotFrontendTest(unittest.TestCase):
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

    def run_node(self, body: str) -> dict:
        functions = self.source_slice(
            "function isSafeHostSnapshotInteger",
            "function syncCachePanelVisibility",
        )
        script = f"""
const state = {{ data: null }};
const window = {{ location: {{ href: "http://127.0.0.1:8080/" }} }};
let apiPostImpl = async () => {{ throw new Error("apiPost was not configured"); }};
async function apiPost(...args) {{ return apiPostImpl(...args); }}
{functions}

function currentItem({{
  itemId = "song-a",
  incarnation = "i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
  variantId = "instrumental",
  artifactId = "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
  mountable = true,
}} = {{}}) {{
  const directory = `artifacts/${{incarnation}}/${{artifactId}}`;
  return {{
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: mountable ? variantId : "",
    artifact_set_id: mountable ? artifactId : "",
    video_media_url: mountable ? `/media/${{directory}}/video.mp4` : "",
    audio_variants: mountable
      ? [{{ id: variantId, audio_url: `/media/${{directory}}/${{variantId}}.m4a` }}]
      : [],
  }};
}}

function snapshot({{
  stateRevision = 10,
  revision = 10,
  generation = 10,
  item = currentItem(),
  marker = "candidate",
  settings = {{ volume_percent: 100 }},
}} = {{}}) {{
  return {{
    state_revision: stateRevision,
    revision,
    playback_generation: generation,
    playback_program: item ? {{
      item_id: item.id,
      item_incarnation_id: item.item_incarnation_id,
      selected_audio_variant_id: item.selected_audio_variant_id,
      artifact_set_id: item.artifact_set_id || null,
    }} : null,
    current_item: item,
    player_settings: settings,
    marker,
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

    def test_acceptance_matrix_is_fail_closed_and_structural(self):
        result = self.run_node(
            """
const results = {};
const first = snapshot({ marker: "first" });
results.first = acceptHostStateSnapshot(first);
const accepted = state.data;

const duplicate = snapshot({ marker: "duplicate" });
duplicate.playback_program = {
  artifact_set_id: duplicate.playback_program.artifact_set_id,
  selected_audio_variant_id: duplicate.playback_program.selected_audio_variant_id,
  item_incarnation_id: duplicate.playback_program.item_incarnation_id,
  item_id: duplicate.playback_program.item_id,
};
results.duplicate = acceptHostStateSnapshot(duplicate);
results.duplicatePreserved = state.data === accepted;

results.lowerStateRevision = acceptHostStateSnapshot(snapshot({
  stateRevision: 9, revision: 11, generation: 11, marker: "lower-host",
}));
results.equalStateDifferentRust = acceptHostStateSnapshot(snapshot({
  stateRevision: 10, revision: 11, marker: "equal-host-rust",
}));
const other = currentItem({ itemId: "song-b" });
results.equalStateDifferentProgram = acceptHostStateSnapshot(snapshot({
  stateRevision: 10, item: other, marker: "equal-host-program",
}));
results.higherStateLowerRust = acceptHostStateSnapshot(snapshot({
  stateRevision: 11, revision: 9, marker: "lower-rust",
}));
results.higherStateLowerGeneration = acceptHostStateSnapshot(snapshot({
  stateRevision: 11, revision: 11, generation: 9, marker: "lower-generation",
}));
results.descriptorChangeSameGeneration = acceptHostStateSnapshot(snapshot({
  stateRevision: 11, revision: 11, generation: 10, item: other,
  marker: "descriptor-without-generation",
}));
results.generationChangeSameRust = acceptHostStateSnapshot(snapshot({
  stateRevision: 11, revision: 10, generation: 11,
  marker: "generation-without-rust",
}));
results.pythonOnly = acceptHostStateSnapshot(snapshot({
  stateRevision: 11, revision: 10, generation: 10, marker: "python-only",
}));

const beforeMalformed = state.data;
const malformed = snapshot({ stateRevision: 12, revision: 11, generation: 11 });
malformed.playback_program.item_incarnation_id = "i-wrong";
results.malformed = acceptHostStateSnapshot(malformed);
results.malformedPreserved = state.data === beforeMalformed;
results.finalMarker = state.data.marker;
process.stdout.write(JSON.stringify(results));
"""
        )
        self.assertEqual(
            result,
            {
                "first": True,
                "duplicate": False,
                "duplicatePreserved": True,
                "lowerStateRevision": False,
                "equalStateDifferentRust": False,
                "equalStateDifferentProgram": False,
                "higherStateLowerRust": False,
                "higherStateLowerGeneration": False,
                "descriptorChangeSameGeneration": False,
                "generationChangeSameRust": False,
                "pythonOnly": True,
                "malformed": False,
                "malformedPreserved": True,
                "finalMarker": "python-only",
            },
        )

    def test_descriptor_and_locator_validation_rejects_transport_corruption(self):
        result = self.run_node(
            """
const candidates = {};
const mismatchItem = snapshot();
mismatchItem.playback_program.item_id = "other";
candidates.itemMismatch = mismatchItem;
const mismatchIncarnation = snapshot();
mismatchIncarnation.current_item.item_incarnation_id = "i-other";
candidates.incarnationMismatch = mismatchIncarnation;
const mismatchSelection = snapshot();
mismatchSelection.current_item.selected_audio_variant_id = "original";
candidates.selectionMismatch = mismatchSelection;
const mismatchArtifact = snapshot();
mismatchArtifact.current_item.artifact_set_id = "a-other";
candidates.artifactMismatch = mismatchArtifact;
const invalidVideo = snapshot();
invalidVideo.current_item.video_media_url = "javascript:alert(1)";
candidates.invalidVideo = invalidVideo;
const duplicateAudio = snapshot();
duplicateAudio.current_item.audio_variants.push({
  ...duplicateAudio.current_item.audio_variants[0],
});
candidates.duplicateAudio = duplicateAudio;
const invalidAudio = snapshot();
invalidAudio.current_item.audio_variants[0].audio_url = "file:///tmp/audio.m4a";
candidates.invalidAudio = invalidAudio;
const absentProgram = snapshot();
absentProgram.playback_program = null;
candidates.absentProgram = absentProgram;
const absentCurrent = snapshot();
absentCurrent.current_item = null;
candidates.absentCurrent = absentCurrent;
const forgedPendingArtifact = snapshot({ item: currentItem({ mountable: false }) });
forgedPendingArtifact.current_item.artifact_set_id = "a-forged";
candidates.forgedPendingArtifact = forgedPendingArtifact;
const unsafeHostRevision = snapshot();
unsafeHostRevision.state_revision = Number.MAX_SAFE_INTEGER + 1;
candidates.unsafeHostRevision = unsafeHostRevision;
const unsafeRustRevision = snapshot();
unsafeRustRevision.revision = Number.MAX_SAFE_INTEGER + 1;
candidates.unsafeRustRevision = unsafeRustRevision;
const unsafeGeneration = snapshot();
unsafeGeneration.playback_generation = Number.MAX_SAFE_INTEGER + 1;
candidates.unsafeGeneration = unsafeGeneration;

const rejected = Object.fromEntries(
  Object.entries(candidates).map(([name, candidate]) => [
    name,
    acceptHostStateSnapshot(candidate),
  ]),
);
const emptyAccepted = acceptHostStateSnapshot(snapshot({
  stateRevision: 1, revision: 1, generation: 1, item: null, marker: "empty",
}));
const pendingAccepted = acceptHostStateSnapshot(snapshot({
  stateRevision: 2,
  revision: 2,
  generation: 2,
  item: currentItem({ mountable: false }),
  marker: "pending",
}));
process.stdout.write(JSON.stringify({ rejected, emptyAccepted, pendingAccepted }));
"""
        )
        self.assertTrue(all(value is False for value in result["rejected"].values()))
        self.assertTrue(result["emptyAccepted"])
        self.assertTrue(result["pendingAccepted"])

    def test_inverse_complete_responses_never_roll_back_program_or_settings(self):
        result = self.run_node(
            """
function runInverse(base, newer, older) {
  state.data = null;
  const first = acceptHostStateSnapshot(base);
  const acceptedNewer = acceptHostStateSnapshot(newer);
  const afterNewer = state.data;
  const rejectedOlder = acceptHostStateSnapshot(older);
  return {
    first,
    acceptedNewer,
    rejectedOlder,
    preserved: state.data === afterNewer,
    itemId: state.data.playback_program?.item_id || null,
    variantId: state.data.playback_program?.selected_audio_variant_id || null,
    artifactId: state.data.playback_program?.artifact_set_id || null,
    generation: state.data.playback_generation,
    volume: state.data.player_settings?.volume_percent,
  };
}
const a = currentItem();
const b = currentItem({ itemId: "song-b", incarnation: "i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001", artifactId: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001" });
const variant = currentItem({ variantId: "original" });
const recached = currentItem({ artifactId: "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000002" });
const base = snapshot({ stateRevision: 10, revision: 10, generation: 10, item: a });
const cases = {
  playNow: runInverse(base, snapshot({ stateRevision: 12, revision: 12, generation: 12, item: b }), snapshot({ stateRevision: 11, revision: 11, generation: 11, item: a })),
  variant: runInverse(base, snapshot({ stateRevision: 12, revision: 12, generation: 12, item: variant }), snapshot({ stateRevision: 11, revision: 11, generation: 11, item: a })),
  recache: runInverse(base, snapshot({ stateRevision: 12, revision: 12, generation: 12, item: recached }), snapshot({ stateRevision: 11, revision: 11, generation: 11, item: a })),
  reset: runInverse(base, snapshot({ stateRevision: 12, revision: 12, generation: 12, item: a }), snapshot({ stateRevision: 11, revision: 11, generation: 11, item: a })),
  settings: runInverse(base, snapshot({ stateRevision: 12, revision: 12, generation: 10, item: a, settings: { volume_percent: 60 } }), snapshot({ stateRevision: 11, revision: 11, generation: 10, item: a, settings: { volume_percent: 20 } })),
};
process.stdout.write(JSON.stringify(cases));
"""
        )
        for case in result.values():
            self.assertTrue(case["first"])
            self.assertTrue(case["acceptedNewer"])
            self.assertFalse(case["rejectedOlder"])
            self.assertTrue(case["preserved"])
        self.assertEqual(result["playNow"]["itemId"], "song-b")
        self.assertEqual(result["variant"]["variantId"], "original")
        self.assertTrue(result["recache"]["artifactId"].endswith("0002"))
        self.assertEqual(result["reset"]["generation"], 12)
        self.assertEqual(result["settings"]["volume"], 60)

    def test_complete_post_wrapper_uses_the_same_acceptance_path(self):
        result = self.run_node(
            """
(async () => {
  const routes = [
    "/api/playlist/add", "/api/player/next", "/api/playlist/remove",
    "/api/playlist/clear", "/api/history/clear", "/api/history/remove",
    "/api/session-users/add", "/api/session-users/remove",
    "/api/session-users/reorder", "/api/playlist/reorder",
    "/api/playlist/resort", "/api/playlist/move-next",
    "/api/playlist/play-now", "/api/mode", "/api/player/advance-delay",
    "/api/player/key-shift", "/api/player/volume", "/api/cache/retry",
    "/api/player/audio-variant", "/api/cache-policy",
    "/api/backup/discard", "/api/session/continue-previous",
    "/api/player/reset", "/api/player/restart-program", "/api/data/reset",
    "/api/bbdown/login/start", "/api/bbdown/logout",
  ];
  let candidate = null;
  apiPostImpl = async () => candidate;
  const outcomes = {};
  for (const route of routes) {
    state.data = null;
    candidate = snapshot({ marker: `${route}:first` });
    const first = await apiPostStateSnapshot(route);
    const accepted = state.data;
    candidate = snapshot({ stateRevision: 9, revision: 9, generation: 9, marker: `${route}:stale` });
    const stale = await apiPostStateSnapshot(route);
    outcomes[route] = { first, stale, preserved: state.data === accepted };
  }
  process.stdout.write(JSON.stringify(outcomes));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertTrue(result)
        for route, outcome in result.items():
            with self.subTest(route=route):
                self.assertEqual(
                    outcome,
                    {"first": True, "stale": False, "preserved": True},
                )

    def test_polling_rejects_before_any_snapshot_side_effect(self):
        guard = self.source_slice(
            "function isSafeHostSnapshotInteger",
            "function syncCachePanelVisibility",
        )
        fetch_state = self.source_slice(
            "async function fetchState",
            "function renderSignatureForData",
        )
        script = f"""
(async () => {{
  const window = {{ location: {{ href: "http://127.0.0.1:8080/" }} }};
  const item = {{
    id: "song-a",
    item_incarnation_id: "i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
    selected_audio_variant_id: "instrumental",
    artifact_set_id: "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
    video_media_url: "/media/artifacts/i/a/video.mp4",
    audio_variants: [{{ id: "instrumental", audio_url: "/media/artifacts/i/a/audio.m4a" }}],
  }};
  const make = (stateRevision, revision, generation, marker) => ({{
    state_revision: stateRevision, revision, playback_generation: generation,
    playback_program: {{
      item_id: item.id,
      item_incarnation_id: item.item_incarnation_id,
      selected_audio_variant_id: item.selected_audio_variant_id,
      artifact_set_id: item.artifact_set_id,
    }},
    current_item: item, player_settings: {{ volume_percent: 100, is_muted: false }},
    marker,
  }});
  const state = {{
    data: make(42, 42, 42, "current"), hasValidStateResponse: false,
    localPreferencesHydrated: true, lastPollRenderSignature: "",
  }};
  let candidate = make(41, 41, 41, "stale");
  let sideEffects = 0;
  async function fetch() {{ return {{ ok: true }}; }}
  function clientHeaders() {{ return {{}}; }}
  async function parseApiResponse() {{ return {{ ok: true, data: candidate }}; }}
  function currentAvOffsetMs() {{ return 0; }}
  function localizedApiMessage(value) {{ return value; }}
  function t(key) {{ return key; }}
  function maybeShowIncomingRequestToast() {{ sideEffects += 1; }}
  function maybeShowSongTransitionOverlay() {{ sideEffects += 1; }}
  function syncLocalPlayerSettingsFromSnapshot() {{ sideEffects += 1; }}
  function scheduleFavlistBrowseReloadFromState() {{ sideEffects += 1; }}
  function renderSignatureForData(data) {{ return JSON.stringify(data); }}
  function render() {{ sideEffects += 1; }}
  function hasDownloadingItems() {{ return false; }}
  function refreshRetryButtons() {{ sideEffects += 1; }}
  function resyncMountedLocalPlayerIfOffsetChanged() {{ sideEffects += 1; }}
  function rememberedVolumePercent() {{ return 100; }}
  function rememberedMuted() {{ return false; }}
  async function apiPostStateSnapshot() {{ throw new Error("not used"); }}
  {guard}
  {fetch_state}
  await fetchState();
  const stale = {{ marker: state.data.marker, valid: state.hasValidStateResponse, sideEffects }};
  candidate = make(43, 43, 43, "fresh");
  await fetchState();
  const fresh = {{ marker: state.data.marker, valid: state.hasValidStateResponse, sideEffects }};
  process.stdout.write(JSON.stringify({{ stale, fresh }}));
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
            result["stale"],
            {"marker": "current", "valid": False, "sideEffects": 0},
        )
        self.assertEqual(result["fresh"]["marker"], "fresh")
        self.assertTrue(result["fresh"]["valid"])
        self.assertGreater(result["fresh"]["sideEffects"], 0)

    def test_only_the_central_acceptor_assigns_complete_host_state(self):
        assignments = [
            match.start()
            for match in re.finditer(r"\bstate\.data\s*=", self.source)
        ]
        self.assertEqual(len(assignments), 1)
        acceptor = self.source_slice(
            "function acceptHostStateSnapshot",
            "async function apiPostStateSnapshot",
        )
        self.assertIn("state.data = snapshot", acceptor)

    def test_processing_backend_control_and_translations_are_absent(self):
        sources = {
            name: (ROOT / name).read_text(encoding="utf-8")
            for name in (
                "static/app.js",
                "static/index.html",
                "static/styles.css",
                "static/i18n.json",
            )
        }
        forbidden = (
            "playback" + "Selector",
            "playback-" + "selector",
            "playback_" + "selector",
        )
        for name, source in sources.items():
            for token in forbidden:
                with self.subTest(file=name, token=token):
                    self.assertNotIn(token, source)


if __name__ == "__main__":
    unittest.main()
