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
const state = {{
  data: null,
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
}};
const window = {{ location: {{ href: "http://127.0.0.1:8080/" }} }};
let apiPostImpl = async () => {{ throw new Error("apiPost was not configured"); }};
async function apiPost(...args) {{ return apiPostImpl(...args); }}
let renderPlayerImpl = () => {{}};
function renderPlayer(...args) {{ return renderPlayerImpl(...args); }}
let transitionImpl = () => {{}};
function maybeShowSongTransitionOverlay(...args) {{ return transitionImpl(...args); }}
function frontendPlaybackMode(mode) {{ return mode || "local"; }}
function isCurrentHostPlaybackSession() {{ return false; }}
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

    def run_slider_contract(self, control: str) -> dict:
        configs = {
            "cache": {
                "slider": "cacheLimitSlider",
                "scale": "cacheLimitScale",
                "endpoint": "/api/cache-policy",
                "payloadKey": "max_cache_items",
            },
            "advance": {
                "slider": "advanceDelaySlider",
                "scale": "advanceDelayScale",
                "endpoint": "/api/player/advance-delay",
                "payloadKey": "delay_seconds",
            },
        }
        acceptance = self.source_slice(
            "function isSafeHostSnapshotInteger",
            "function syncCachePanelVisibility",
        )
        renderers = self.source_slice(
            "function renderCacheSlider",
            "function renderCachePolicyControls",
        )
        cache_fill = self.source_slice(
            "function updateCacheSliderFill",
            "async function handlePlaylistAction",
        )
        setters = self.source_slice(
            "async function setCacheLimit",
            "function isDownkyiDownloadSource",
        )
        listeners = self.source_slice(
            'elements.cacheLimitSlider.addEventListener("input"',
            'elements.cacheQualitySelect?.addEventListener("change"',
        )
        script = r"""
class ClassList {
  constructor() { this.values = new Set(); }
  toggle(name, force) {
    if (force) this.values.add(name); else this.values.delete(name);
    return this.values.has(name);
  }
  contains(name) { return this.values.has(name); }
}
class Scale {
  constructor(values = []) {
    this.marks = values.map((value) => ({
      textContent: String(value), classList: new ClassList(),
    }));
  }
  set innerHTML(value) { if (value === "") this.marks = []; }
  appendChild(mark) { this.marks.push(mark); }
  querySelectorAll() { return this.marks; }
}
class Slider {
  constructor() {
    this.value = "";
    this.min = "";
    this.max = "";
    this.step = "";
    this.disabled = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)); },
      getPropertyValue(name) { return this.values.get(name) || ""; },
    };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  dispatch(name, value = undefined) {
    if (value !== undefined) this.value = String(value);
    return this.listeners.get(name)({ target: this });
  }
}

const config = __CONFIG__;
const window = { location: { href: "http://127.0.0.1:8080/" } };
const document = {
  createElement() { return { textContent: "", classList: new ClassList() }; },
};
const elements = {
  cacheLimitSlider: new Slider(),
  cacheLimitScale: new Scale(),
  advanceDelaySlider: new Slider(),
  advanceDelayScale: new Scale([1, 2, 3, 4, 5]),
};
function makeSnapshot(value, stateRevision) {
  return {
    state_revision: stateRevision,
    revision: stateRevision,
    playback_generation: 1,
    playback_program: null,
    current_item: null,
    cache_policy: {
      choices: [1, 2, 3, 4, 5],
      max_cache_items: config.slider === "cacheLimitSlider" ? value : 2,
    },
    player_settings: {
      song_advance_delay_seconds: config.slider === "advanceDelaySlider" ? value : 2,
    },
  };
}
const state = {
  data: makeSnapshot(2, 1),
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
  cacheSettingsOpen: true,
  cacheSliderRenderSignature: "",
  advanceDelaySliderRenderSignature: "",
  cacheLimitSaving: false,
  cacheLimitDraftValue: null,
  cacheLimitQueuedValue: null,
  cacheLimitSubmittedValue: null,
  cacheLimitRequestSequence: 0,
  cacheLimitActiveRequestSequence: 0,
  advanceDelaySaving: false,
  advanceDelayDraftValue: null,
  advanceDelayQueuedValue: null,
  advanceDelaySubmittedValue: null,
  advanceDelayRequestSequence: 0,
  advanceDelayActiveRequestSequence: 0,
};
function currentSongAdvanceDelaySeconds(settings = state.data?.player_settings) {
  return Number(settings?.song_advance_delay_seconds ?? 3);
}
function frontendPlaybackMode(mode) { return mode || "local"; }
function maybeShowSongTransitionOverlay() {}
function renderPlayer() {}
function isCurrentHostPlaybackSession() { return false; }
const messages = [];
function setAppMessage(message, isError = false) {
  messages.push({ message: String(message), isError: Boolean(isError) });
}
function t(key, values = {}) {
  const value = values.count ?? values.seconds;
  return value === undefined ? key : `${key}:${value}`;
}
let renders = 0;
function render() {
  renders += 1;
  renderCacheSlider(state.data.cache_policy);
  renderAdvanceDelaySlider(state.data.player_settings);
}
const requests = [];
function deferredRequest(url, payload) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  requests.push({ url, payload, resolve, reject });
  return promise;
}
async function apiPost(url, payload) { return deferredRequest(url, payload); }

__ACCEPTANCE__
__RENDERERS__
__CACHE_FILL__
__SETTERS__
__LISTENERS__

const slider = elements[config.slider];
const scale = elements[config.scale];
function observed() {
  return {
    value: Number(slider.value),
    fill: slider.style.getPropertyValue("--slider-progress"),
    active: Number(scale.marks.find((mark) => mark.classList.contains("active"))?.textContent || 0),
    disabled: slider.disabled,
    busy: slider.getAttribute("aria-busy"),
  };
}
async function waitForRequestCount(count) {
  for (let index = 0; index < 20 && requests.length < count; index += 1) {
    await Promise.resolve();
  }
}

(async () => {
  render();
  await slider.dispatch("input", 4);
  const immediate = observed();
  const firstWrite = slider.dispatch("change");
  const requestStarted = { observation: observed(), requests: requests.length };
  const unrelatedAccepted = acceptHostStateSnapshot(makeSnapshot(2, 2));
  render();
  const afterUnrelated = observed();
  render();
  const afterRepeatedRender = observed();
  requests[0].resolve(makeSnapshot(4, 3));
  await firstWrite;
  const afterAcknowledgement = observed();

  const externalAccepted = acceptHostStateSnapshot(makeSnapshot(1, 4));
  render();
  const afterExternal = observed();

  await slider.dispatch("input", 2);
  const mismatchWrite = slider.dispatch("change");
  requests[1].resolve(makeSnapshot(3, 5));
  await mismatchWrite;
  const afterMismatch = observed();
  const messagesAfterMismatch = [...messages];

  await slider.dispatch("input", 4);
  const failedWrite = slider.dispatch("change");
  const failureExternalAccepted = acceptHostStateSnapshot(makeSnapshot(1, 6));
  render();
  const duringFailure = observed();
  requests[2].reject(new Error("write failed"));
  await failedWrite;
  const afterFailure = observed();

  await slider.dispatch("input", 2);
  const rapidFirst = slider.dispatch("change");
  await slider.dispatch("input", 5);
  const rapidSecond = slider.dispatch("change");
  const rapidBeforeFirstCompletion = observed();
  const rapidOldAccepted = acceptHostStateSnapshot(makeSnapshot(1, 7));
  render();
  const rapidAfterOldSnapshot = observed();
  requests[3].resolve(makeSnapshot(2, 8));
  await rapidSecond;
  await waitForRequestCount(5);
  const rapidAfterFirstCompletion = observed();
  const queuedRequestCount = requests.length;
  if (requests[4]) requests[4].resolve(makeSnapshot(5, 9));
  await rapidFirst;
  const rapidFinal = observed();

  const inverseAccepted = acceptHostStateSnapshot(makeSnapshot(2, 8));
  render();
  const afterInverse = observed();
  const finalExternalAccepted = acceptHostStateSnapshot(makeSnapshot(3, 10));
  render();
  const finalExternal = observed();

  process.stdout.write(JSON.stringify({
    immediate,
    requestStarted,
    unrelatedAccepted,
    afterUnrelated,
    afterRepeatedRender,
    afterAcknowledgement,
    externalAccepted,
    afterExternal,
    afterMismatch,
    messagesAfterMismatch,
    failureExternalAccepted,
    duringFailure,
    afterFailure,
    rapidBeforeFirstCompletion,
    rapidOldAccepted,
    rapidAfterOldSnapshot,
    rapidAfterFirstCompletion,
    queuedRequestCount,
    rapidFinal,
    inverseAccepted,
    afterInverse,
    finalExternalAccepted,
    finalExternal,
    requests: requests.map((request) => ({ url: request.url, value: request.payload[config.payloadKey] })),
    messages,
    panelOpen: state.cacheSettingsOpen,
    renders,
  }));
})().catch((error) => {
  process.stderr.write(String(error.stack || error));
  process.exit(1);
});
"""
        replacements = {
            "__CONFIG__": json.dumps(configs[control]),
            "__ACCEPTANCE__": acceptance,
            "__RENDERERS__": renderers,
            "__CACHE_FILL__": cache_fill,
            "__SETTERS__": setters,
            "__LISTENERS__": listeners,
        }
        for marker, value in replacements.items():
            script = script.replace(marker, value)
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

    def assert_slider_draft_contract(self, control: str) -> None:
        result = self.run_slider_contract(control)
        effective = {
            "immediate": 4,
            "requestStarted": 4,
            "afterUnrelated": 4,
            "afterRepeatedRender": 4,
            "afterAcknowledgement": 4,
            "afterExternal": 1,
            "afterMismatch": 3,
            "duringFailure": 4,
            "afterFailure": 1,
            "rapidBeforeFirstCompletion": 5,
            "rapidAfterOldSnapshot": 5,
            "rapidAfterFirstCompletion": 5,
            "rapidFinal": 5,
            "afterInverse": 5,
            "finalExternal": 3,
        }
        for key, value in effective.items():
            with self.subTest(control=control, observation=key):
                observation = (
                    result[key]["observation"]
                    if key == "requestStarted"
                    else result[key]
                )
                self.assertEqual(observation["value"], value)
                self.assertEqual(observation["active"], value)
                self.assertEqual(
                    observation["fill"], f"{(value - 1) * 25}%"
                )
                self.assertFalse(observation["disabled"])
        self.assertEqual(result["requestStarted"]["requests"], 1)
        self.assertEqual(result["requestStarted"]["observation"]["busy"], "true")
        self.assertEqual(result["rapidBeforeFirstCompletion"]["busy"], "true")
        self.assertEqual(result["rapidAfterFirstCompletion"]["busy"], "true")
        self.assertIsNone(result["afterAcknowledgement"]["busy"])
        self.assertIsNone(result["afterFailure"]["busy"])
        self.assertIsNone(result["rapidFinal"]["busy"])
        self.assertTrue(result["unrelatedAccepted"])
        self.assertTrue(result["externalAccepted"])
        self.assertTrue(result["failureExternalAccepted"])
        self.assertTrue(result["rapidOldAccepted"])
        self.assertFalse(result["inverseAccepted"])
        self.assertTrue(result["finalExternalAccepted"])
        self.assertEqual(result["queuedRequestCount"], 5)
        config = {
            "cache": ("/api/cache-policy", "service.cacheLimitUpdated"),
            "advance": (
                "/api/player/advance-delay",
                "service.advanceDelayUpdated",
            ),
        }[control]
        self.assertEqual(
            result["requests"],
            [
                {"url": config[0], "value": 4},
                {"url": config[0], "value": 2},
                {"url": config[0], "value": 4},
                {"url": config[0], "value": 2},
                {"url": config[0], "value": 5},
            ],
        )
        self.assertEqual(
            result["messagesAfterMismatch"],
            [{"message": f"{config[1]}:4", "isError": False}],
        )
        self.assertEqual(
            result["messages"],
            [
                {"message": f"{config[1]}:4", "isError": False},
                {"message": "write failed", "isError": True},
                {"message": f"{config[1]}:2", "isError": False},
                {"message": f"{config[1]}:5", "isError": False},
            ],
        )
        self.assertTrue(result["panelOpen"])

    def test_cache_limit_slider_preserves_draft_until_authoritative_acknowledgement(self):
        self.assert_slider_draft_contract("cache")

    def test_advance_delay_slider_preserves_draft_until_authoritative_acknowledgement(
        self,
    ):
        self.assert_slider_draft_contract("advance")

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

    def test_exact_command_keeps_snapshot_acceptance_separate_from_application(self):
        result = self.run_node(
            """
(async () => {
  const initial = snapshot({
    stateRevision: 10, revision: 10, generation: 10, marker: "initial",
  });
  if (!acceptHostStateSnapshot(initial)) throw new Error("initial rejected");
  await Promise.resolve();

  let envelope = null;
  apiPostImpl = async () => envelope;
  const firstCarrierItem = currentItem({
    artifactId: "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000002",
  });
  const firstCarrierSnapshot = snapshot({
    stateRevision: 11,
    revision: 11,
    generation: 11,
    item: firstCarrierItem,
    marker: "first-carrier",
  });
  envelope = { ok: true, stale: true, data: firstCarrierSnapshot };
  const firstCarrier = await apiPostExactStateCommand("/api/player/next");
  await Promise.resolve();

  envelope = { ok: true, stale: true, data: firstCarrierSnapshot };
  const duplicateCarrier = await apiPostExactStateCommand("/api/player/next");

  envelope = { ok: true, stale: true, data: initial };
  const olderCarrier = await apiPostExactStateCommand("/api/player/next");

  const nextItem = currentItem({
    itemId: "song-b",
    incarnation: "i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
    artifactId: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
  });
  const appliedSnapshot = snapshot({
    stateRevision: 12,
    revision: 12,
    generation: 12,
    item: nextItem,
    marker: "applied",
  });
  envelope = { ok: true, data: appliedSnapshot };
  const applied = await apiPostExactStateCommand("/api/player/next");
  await Promise.resolve();

  process.stdout.write(JSON.stringify({
    firstCarrier,
    duplicateCarrier,
    olderCarrier,
    applied,
    finalMarker: state.data.marker,
    finalItem: state.data.current_item.id,
    finalGeneration: state.data.playback_generation,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertEqual(
            result,
            {
                "firstCarrier": {
                    "snapshotAccepted": True,
                    "commandApplied": False,
                },
                "duplicateCarrier": {
                    "snapshotAccepted": False,
                    "commandApplied": False,
                },
                "olderCarrier": {
                    "snapshotAccepted": False,
                    "commandApplied": False,
                },
                "applied": {
                    "snapshotAccepted": True,
                    "commandApplied": True,
                },
                "finalMarker": "applied",
                "finalItem": "song-b",
                "finalGeneration": 12,
            },
        )

    def test_accepted_program_change_schedules_one_narrow_player_reconciliation(self):
        result = self.run_node(
            """
(async () => {
  const reconciliations = [];
  const transitions = [];
  renderPlayerImpl = (item, mode) => {
    reconciliations.push({
      generation: state.data.playback_generation,
      artifactId: state.data.playback_program?.artifact_set_id || null,
      itemId: item?.id || null,
      mode,
    });
  };
  transitionImpl = (previous, next) => {
    if (previous?.current_item?.id === next?.current_item?.id) {
      return;
    }
    transitions.push([
      previous?.current_item?.id || null,
      next?.current_item?.id || null,
    ]);
  };

  const initial = snapshot({ marker: "initial" });
  state.data = initial;
  let candidate = null;
  apiPostImpl = async () => candidate;

  const recached = currentItem({
    itemId: "song-b",
    incarnation: "i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
    artifactId: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
  });
  candidate = snapshot({
    stateRevision: 11,
    revision: 11,
    generation: 11,
    item: recached,
    marker: "settings-carried-program",
  });
  const acceptedSettings = await apiPostStateSnapshot("/api/player/key-shift", {
    key_shift: 1,
  });
  const beforeScheduledWork = reconciliations.length;
  await Promise.resolve();
  const afterSettings = reconciliations.slice();

  candidate = snapshot({
    stateRevision: 12,
    revision: 11,
    generation: 11,
    item: recached,
    marker: "same-program-settings",
    settings: { volume_percent: 73 },
  });
  const acceptedSameProgram = await apiPostStateSnapshot("/api/player/volume");
  await Promise.resolve();

  const duplicate = await apiPostStateSnapshot("/api/player/volume");
  candidate = initial;
  const rejected = await apiPostStateSnapshot("/api/state");
  await Promise.resolve();

  const nextArtifact = currentItem({
    itemId: "song-b",
    incarnation: "i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
    artifactId: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002",
  });
  candidate = snapshot({
    stateRevision: 13,
    revision: 12,
    generation: 12,
    item: nextArtifact,
    marker: "first-path",
  });
  const acceptedFirstPath = await apiPostStateSnapshot("/api/cache/retry");
  candidate = snapshot({
    stateRevision: 14,
    revision: 12,
    generation: 12,
    item: nextArtifact,
    marker: "second-path-same-program",
  });
  const acceptedSecondPath = await apiPostStateSnapshot("/api/state");
  await Promise.resolve();

  process.stdout.write(JSON.stringify({
    acceptedSettings,
    beforeScheduledWork,
    afterSettings,
    acceptedSameProgram,
    duplicate,
    rejected,
    acceptedFirstPath,
    acceptedSecondPath,
    reconciliations,
    transitions,
  }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
"""
        )
        self.assertTrue(result["acceptedSettings"])
        self.assertEqual(result["beforeScheduledWork"], 1)
        self.assertEqual(
            result["afterSettings"],
            [
                {
                    "generation": 11,
                    "artifactId": "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
                    "itemId": "song-b",
                    "mode": "local",
                }
            ],
        )
        self.assertTrue(result["acceptedSameProgram"])
        self.assertFalse(result["duplicate"])
        self.assertFalse(result["rejected"])
        self.assertTrue(result["acceptedFirstPath"])
        self.assertTrue(result["acceptedSecondPath"])
        self.assertEqual(
            result["reconciliations"],
            [
                {
                    "generation": 11,
                    "artifactId": "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001",
                    "itemId": "song-b",
                    "mode": "local",
                },
                {
                    "generation": 12,
                    "artifactId": "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002",
                    "itemId": "song-b",
                    "mode": "local",
                },
            ],
        )
        self.assertEqual(result["transitions"], [["song-a", "song-b"]])

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
    hostPlaybackSession: null, pendingHostPlaybackProgramReconciliation: null,
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
  function renderPlayer() {{ sideEffects += 1; }}
  function frontendPlaybackMode(mode) {{ return mode || "local"; }}
  function isCurrentHostPlaybackSession() {{ return false; }}
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
