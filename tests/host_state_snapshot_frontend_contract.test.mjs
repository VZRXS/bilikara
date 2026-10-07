import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, iterableValues, concatenate, subtract } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const HostStateSnapshotFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.source = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
},
async source_slice(start, end) {
let start_index;
start_index = sourceIndex(this.source, start);
return this.source.slice(start_index, sourceIndex(this.source, end, start_index));
},
async run_node(body) {
let completed, functions, script;
functions = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
script = (`
const state = {
  data: null,
  hostPlaybackSession: null,
  pendingHostPlaybackProgramReconciliation: null,
};
const window = { location: { href: "http://127.0.0.1:8080/" } };
let apiPostImpl = async () => { throw new Error("apiPost was not configured"); };
async function apiPost(...args) { return apiPostImpl(...args); }
let renderPlayerImpl = () => {};
function renderPlayer(...args) { return renderPlayerImpl(...args); }
let transitionImpl = () => {};
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay(...args) { return transitionImpl(...args); }
function syncLocalPlayerSettingsFromSnapshot(settings) { state.syncedPlayerSettings = settings; }
function frontendPlaybackMode(mode) { return mode || "local"; }
function isCurrentHostPlaybackSession() { return false; }
` + String(functions) + `

function currentItem({
  itemId = "song-a",
  incarnation = "i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
  variantId = "instrumental",
  artifactId = "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
  mountable = true,
} = {}) {
  const directory = \`artifacts/\${incarnation}/\${artifactId}\`;
  return {
    id: itemId,
    item_incarnation_id: incarnation,
    selected_audio_variant_id: mountable ? variantId : "",
    artifact_set_id: mountable ? artifactId : "",
    video_media_url: mountable ? \`/media/\${directory}/video.mp4\` : "",
    audio_variants: mountable
      ? [{ id: variantId, audio_url: \`/media/\${directory}/\${variantId}.m4a\` }]
      : [],
  };
}

function snapshot({
  stateRevision = 10,
  revision = 10,
  generation = 10,
  item = currentItem(),
  marker = "candidate",
  settings = { volume_percent: 100 },
} = {}) {
  return {
    state_revision: stateRevision,
    revision,
    playback_generation: generation,
    playback_program: item ? {
      item_id: item.id,
      item_incarnation_id: item.item_incarnation_id,
      selected_audio_variant_id: item.selected_audio_variant_id,
      artifact_set_id: item.artifact_set_id || null,
    } : null,
    current_item: item,
    player_settings: settings,
    marker,
  };
}

` + String(body) + `
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_song_change_applies_volume_reset_before_media_mount() {
let result;
result = (await this.run_node(`
acceptHostStateSnapshot(snapshot({settings: {volume_percent: 500, is_muted: true}}));
state.playerSettingsEchoSuppressUntil = Date.now() + 10000;
state.volumeSaveSeq = 2;
acceptHostStateSnapshot(snapshot({stateRevision: 11, revision: 11, generation: 11,
  item: currentItem({variantId: "original"}), settings: {volume_percent: 500, is_muted: true}}));
const variantKeptSuppression = state.playerSettingsEchoSuppressUntil > Date.now();
acceptHostStateSnapshot(snapshot({stateRevision: 12, revision: 12, generation: 12,
  item: currentItem({incarnation: "i-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002"}),
  settings: {volume_percent: 100, is_muted: true}}));
console.log(JSON.stringify({variantKeptSuppression, suppression: state.playerSettingsEchoSuppressUntil,
  sequence: state.volumeSaveSeq, settings: state.syncedPlayerSettings}));
`));
assert.deepEqual(result, {["variantKeptSuppression"]: true, ["suppression"]: 0, ["sequence"]: 3, ["settings"]: {["volume_percent"]: 100, ["is_muted"]: true}});
},
async run_slider_contract(control) {
let acceptance, cache_fill, completed, configs, listeners, marker, renderers, replacements, script, setters, value;
configs = {["cache"]: {["slider"]: "cacheLimitSlider", ["scale"]: "cacheLimitScale", ["endpoint"]: "/api/cache-policy", ["payloadKey"]: "max_cache_items"}, ["advance"]: {["slider"]: "advanceDelaySlider", ["scale"]: "advanceDelayScale", ["endpoint"]: "/api/player/advance-delay", ["payloadKey"]: "delay_seconds"}};
acceptance = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
renderers = (await this.source_slice("function renderCacheSlider", "function renderCachePolicyControls"));
cache_fill = (await this.source_slice("function updateCacheSliderFill", "async function handlePlaylistAction"));
setters = (await this.source_slice("async function setCacheLimit", "function isDownkyiDownloadSource"));
listeners = (await this.source_slice("elements.cacheLimitSlider.addEventListener(\"input\"", "elements.cacheQualitySelect?.addEventListener(\"change\""));
script = `
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
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() {}
function renderPlayer() {}
function isCurrentHostPlaybackSession() { return false; }
const messages = [];
function setAppMessage(message, isError = false) {
  messages.push({ message: String(message), isError: Boolean(isError) });
}
function t(key, values = {}) {
  const value = values.count ?? values.seconds;
  return value === undefined ? key : \`\${key}:\${value}\`;
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
`;
replacements = {["__CONFIG__"]: JSON.stringify(configs[control]), ["__ACCEPTANCE__"]: acceptance, ["__RENDERERS__"]: renderers, ["__CACHE_FILL__"]: cache_fill, ["__SETTERS__"]: setters, ["__LISTENERS__"]: listeners};
for (const [marker, value] of iterableValues(Object.entries(replacements))) {
script = script.replaceAll(marker, value);
}
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async assert_slider_draft_contract(control) {
let config, effective, key, observation, result, value;
result = (await this.run_slider_contract(control));
effective = {["immediate"]: 4, ["requestStarted"]: 4, ["afterUnrelated"]: 4, ["afterRepeatedRender"]: 4, ["afterAcknowledgement"]: 4, ["afterExternal"]: 1, ["afterMismatch"]: 3, ["duringFailure"]: 4, ["afterFailure"]: 1, ["rapidBeforeFirstCompletion"]: 5, ["rapidAfterOldSnapshot"]: 5, ["rapidAfterFirstCompletion"]: 5, ["rapidFinal"]: 5, ["afterInverse"]: 5, ["finalExternal"]: 3};
for (const [key, value] of iterableValues(Object.entries(effective))) {
{
observation = (((key === "requestStarted")) ? result[key]["observation"] : result[key]);
assert.deepEqual(observation["value"], value);
assert.deepEqual(observation["active"], value);
assert.deepEqual(observation["fill"], (String((subtract(value, 1) * 25)) + "%"));
assert.ok(!hasContent(observation["disabled"]));
}
}
assert.deepEqual(result["requestStarted"]["requests"], 1);
assert.deepEqual(result["requestStarted"]["observation"]["busy"], "true");
assert.deepEqual(result["rapidBeforeFirstCompletion"]["busy"], "true");
assert.deepEqual(result["rapidAfterFirstCompletion"]["busy"], "true");
assert.equal(result["afterAcknowledgement"]["busy"], null);
assert.equal(result["afterFailure"]["busy"], null);
assert.equal(result["rapidFinal"]["busy"], null);
assert.ok(hasContent(result["unrelatedAccepted"]));
assert.ok(hasContent(result["externalAccepted"]));
assert.ok(hasContent(result["failureExternalAccepted"]));
assert.ok(hasContent(result["rapidOldAccepted"]));
assert.ok(!hasContent(result["inverseAccepted"]));
assert.ok(hasContent(result["finalExternalAccepted"]));
assert.deepEqual(result["queuedRequestCount"], 5);
config = {["cache"]: ["/api/cache-policy", "service.cacheLimitUpdated"], ["advance"]: ["/api/player/advance-delay", "service.advanceDelayUpdated"]}[control];
assert.deepEqual(result["requests"], [{["url"]: config[0], ["value"]: 4}, {["url"]: config[0], ["value"]: 2}, {["url"]: config[0], ["value"]: 4}, {["url"]: config[0], ["value"]: 2}, {["url"]: config[0], ["value"]: 5}]);
assert.deepEqual(result["messagesAfterMismatch"], [{["message"]: (String(config[1]) + ":4"), ["isError"]: false}]);
assert.deepEqual(result["messages"], [{["message"]: (String(config[1]) + ":4"), ["isError"]: false}, {["message"]: "write failed", ["isError"]: true}, {["message"]: (String(config[1]) + ":2"), ["isError"]: false}, {["message"]: (String(config[1]) + ":5"), ["isError"]: false}]);
assert.ok(hasContent(result["panelOpen"]));
},
async test_cache_limit_slider_preserves_draft_until_authoritative_acknowledgement() {
(await this.assert_slider_draft_contract("cache"));
},
async test_advance_delay_slider_preserves_draft_until_authoritative_acknowledgement() {
(await this.assert_slider_draft_contract("advance"));
},
async test_acceptance_matrix_is_fail_closed_and_structural() {
let result;
result = (await this.run_node(`
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
`));
assert.deepEqual(result, {["first"]: true, ["duplicate"]: false, ["duplicatePreserved"]: true, ["lowerStateRevision"]: false, ["equalStateDifferentRust"]: false, ["equalStateDifferentProgram"]: false, ["higherStateLowerRust"]: false, ["higherStateLowerGeneration"]: false, ["descriptorChangeSameGeneration"]: false, ["generationChangeSameRust"]: false, ["pythonOnly"]: true, ["malformed"]: false, ["malformedPreserved"]: true, ["finalMarker"]: "python-only"});
},
async test_descriptor_and_locator_validation_rejects_transport_corruption() {
let result, value;
result = (await this.run_node(`
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
`));
assert.ok(hasContent(Array.from(Array.from(iterableValues(Object.values(result["rejected"])))).map((value) => ((value === false))).every(Boolean)));
assert.ok(hasContent(result["emptyAccepted"]));
assert.ok(hasContent(result["pendingAccepted"]));
},
async test_inverse_complete_responses_never_roll_back_program_or_settings() {
let result, testCase;
result = (await this.run_node(`
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
`));
for (const testCase of iterableValues(Object.values(result))) {
assert.ok(hasContent(testCase["first"]));
assert.ok(hasContent(testCase["acceptedNewer"]));
assert.ok(!hasContent(testCase["rejectedOlder"]));
assert.ok(hasContent(testCase["preserved"]));
}
assert.deepEqual(result["playNow"]["itemId"], "song-b");
assert.deepEqual(result["variant"]["variantId"], "original");
assert.ok(hasContent(result["recache"]["artifactId"].endsWith("0002")));
assert.deepEqual(result["reset"]["generation"], 12);
assert.deepEqual(result["settings"]["volume"], 60);
},
async test_complete_post_wrapper_uses_the_same_acceptance_path() {
let outcome, result, route;
result = (await this.run_node(`
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
    candidate = snapshot({ marker: \`\${route}:first\` });
    const first = await apiPostStateSnapshot(route);
    const accepted = state.data;
    candidate = snapshot({ stateRevision: 9, revision: 9, generation: 9, marker: \`\${route}:stale\` });
    const stale = await apiPostStateSnapshot(route);
    outcomes[route] = { first, stale, preserved: state.data === accepted };
  }
  process.stdout.write(JSON.stringify(outcomes));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`));
assert.ok(hasContent(result));
for (const [route, outcome] of iterableValues(Object.entries(result))) {
{
assert.deepEqual(outcome, {["first"]: true, ["stale"]: false, ["preserved"]: true});
}
}
},
async test_exact_command_keeps_snapshot_acceptance_separate_from_application() {
let result;
result = (await this.run_node(`
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
`));
assert.deepEqual(result, {["firstCarrier"]: {["snapshotAccepted"]: true, ["commandApplied"]: false}, ["duplicateCarrier"]: {["snapshotAccepted"]: false, ["commandApplied"]: false}, ["olderCarrier"]: {["snapshotAccepted"]: false, ["commandApplied"]: false}, ["applied"]: {["snapshotAccepted"]: true, ["commandApplied"]: true}, ["finalMarker"]: "applied", ["finalItem"]: "song-b", ["finalGeneration"]: 12});
},
async test_accepted_program_change_schedules_one_narrow_player_reconciliation() {
let result;
result = (await this.run_node(`
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
`));
assert.ok(hasContent(result["acceptedSettings"]));
assert.deepEqual(result["beforeScheduledWork"], 1);
assert.deepEqual(result["afterSettings"], [{["generation"]: 11, ["artifactId"]: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001", ["itemId"]: "song-b", ["mode"]: "local"}]);
assert.ok(hasContent(result["acceptedSameProgram"]));
assert.ok(!hasContent(result["duplicate"]));
assert.ok(!hasContent(result["rejected"]));
assert.ok(hasContent(result["acceptedFirstPath"]));
assert.ok(hasContent(result["acceptedSecondPath"]));
assert.deepEqual(result["reconciliations"], [{["generation"]: 11, ["artifactId"]: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000001", ["itemId"]: "song-b", ["mode"]: "local"}, {["generation"]: 12, ["artifactId"]: "a-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-0000000000000002", ["itemId"]: "song-b", ["mode"]: "local"}]);
assert.deepEqual(result["transitions"], [["song-a", "song-b"]]);
},
async test_polling_rejects_before_any_snapshot_side_effect() {
let completed, fetch_state, guard, remote_access_failure, result, script;
guard = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
fetch_state = (await this.source_slice("async function fetchState", "function renderSignatureForData"));
remote_access_failure = (await this.source_slice("function updateRemoteAccessFailure", "function localRemoteAccessView"));
script = (`
(async () => {
  const window = { location: { href: "http://127.0.0.1:8080/" } };
  const item = {
    id: "song-a",
    item_incarnation_id: "i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
    selected_audio_variant_id: "instrumental",
    artifact_set_id: "a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-0000000000000001",
    video_media_url: "/media/artifacts/i/a/video.mp4",
    audio_variants: [{ id: "instrumental", audio_url: "/media/artifacts/i/a/audio.m4a" }],
  };
  const make = (stateRevision, revision, generation, marker) => ({
    state_revision: stateRevision, revision, playback_generation: generation,
    playback_program: {
      item_id: item.id,
      item_incarnation_id: item.item_incarnation_id,
      selected_audio_variant_id: item.selected_audio_variant_id,
      artifact_set_id: item.artifact_set_id,
    },
    current_item: item, player_settings: { volume_percent: 100, is_muted: false },
    marker,
  });
  const state = {
    data: make(42, 42, 42, "current"), hasValidStateResponse: false,
    localPreferencesHydrated: true, lastPollRenderSignature: "",
    hostPlaybackSession: null, pendingHostPlaybackProgramReconciliation: null,
    remoteAccessFailure: null, remoteAccessRequestSequence: 0, remoteAccessOutcomeSequence: 0,
  };
  let candidate = make(41, 41, 41, "stale");
  let sideEffects = 0;
  async function fetch() { return { ok: true }; }
  function clientHeaders() { return {}; }
  async function parseApiResponse() { return { ok: true, data: candidate }; }
  function currentAvOffsetMs() { return 0; }
  function localizedApiMessage(value) { return value; }
  function t(key) { return key; }
  function maybeShowIncomingRequestToast() { sideEffects += 1; }
  function maybeShowSongTransitionOverlay() { sideEffects += 1; }
  function scheduleStartupAppUpdateCheck() { sideEffects += 1; }
  function syncLocalPlayerSettingsFromSnapshot() { sideEffects += 1; }
  function scheduleFavlistBrowseReloadFromState() { sideEffects += 1; }
  function renderSignatureForData(data) { return JSON.stringify(data); }
  function render() { sideEffects += 1; }
  function renderPlayer() { sideEffects += 1; }
  function renderRemoteAccess() { sideEffects += 1; }
  function publishPresentationOutputState() { sideEffects += 1; }
  function frontendPlaybackMode(mode) { return mode || "local"; }
  function isCurrentHostPlaybackSession() { return false; }
  function hasDownloadingItems() { return false; }
  function refreshRetryButtons() { sideEffects += 1; }
  function resyncMountedLocalPlayerIfOffsetChanged() { sideEffects += 1; }
  function rememberedVolumePercent() { return 100; }
  function rememberedMuted() { return false; }
  async function apiPostStateSnapshot() { throw new Error("not used"); }
  ` + String(guard) + `
  ` + String(remote_access_failure) + `
  ` + String(fetch_state) + `
  await fetchState();
  const stale = { marker: state.data.marker, valid: state.hasValidStateResponse, sideEffects };
  candidate = make(43, 43, 43, "fresh");
  await fetchState();
  const fresh = { marker: state.data.marker, valid: state.hasValidStateResponse, sideEffects };
  process.stdout.write(JSON.stringify({ stale, fresh }));
})().catch((error) => { process.stderr.write(String(error)); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result["stale"], {["marker"]: "current", ["valid"]: false, ["sideEffects"]: 0});
assert.deepEqual(result["fresh"]["marker"], "fresh");
assert.ok(hasContent(result["fresh"]["valid"]));
assert.ok(result["fresh"]["sideEffects"] > 0);
},
async test_only_the_central_acceptor_assigns_complete_host_state() {
let acceptor, assignments, match;
assignments = Array.from(Array.from(iterableValues(Array.from(this.source.matchAll(new RegExp("\\bstate\\.data\\s*=","g")))))).map((match) => match.index);
assert.deepEqual(assignments.length, 1);
acceptor = (await this.source_slice("function acceptHostStateSnapshot", "async function apiPostStateSnapshot"));
assert.ok(contains("state.data = snapshot", acceptor));
},
async test_processing_backend_control_and_translations_are_absent() {
let forbidden, name, source, sources, token;
sources = Object.fromEntries(Array.from(Array.from(iterableValues(["static/app.js", "static/index.html", "static/styles.css", "static/i18n.json"]))).map((name) => [name, readFileSync(path.join(ROOT, name), "utf8")]));
forbidden = [concatenate("playback", "Selector"), concatenate("playback-", "selector"), concatenate("playback_", "selector")];
for (const [name, source] of iterableValues(Object.entries(sources))) {
for (const token of iterableValues(forbidden)) {
{
assert.ok(!contains(token, source));
}
}
}
}
};
test("HostStateSnapshotFrontendTest.test_song_change_applies_volume_reset_before_media_mount", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_song_change_applies_volume_reset_before_media_mount(); });
test("HostStateSnapshotFrontendTest.test_cache_limit_slider_preserves_draft_until_authoritative_acknowledgement", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_cache_limit_slider_preserves_draft_until_authoritative_acknowledgement(); });
test("HostStateSnapshotFrontendTest.test_advance_delay_slider_preserves_draft_until_authoritative_acknowledgement", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_advance_delay_slider_preserves_draft_until_authoritative_acknowledgement(); });
test("HostStateSnapshotFrontendTest.test_acceptance_matrix_is_fail_closed_and_structural", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_acceptance_matrix_is_fail_closed_and_structural(); });
test("HostStateSnapshotFrontendTest.test_descriptor_and_locator_validation_rejects_transport_corruption", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_descriptor_and_locator_validation_rejects_transport_corruption(); });
test("HostStateSnapshotFrontendTest.test_inverse_complete_responses_never_roll_back_program_or_settings", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_inverse_complete_responses_never_roll_back_program_or_settings(); });
test("HostStateSnapshotFrontendTest.test_complete_post_wrapper_uses_the_same_acceptance_path", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_complete_post_wrapper_uses_the_same_acceptance_path(); });
test("HostStateSnapshotFrontendTest.test_exact_command_keeps_snapshot_acceptance_separate_from_application", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_exact_command_keeps_snapshot_acceptance_separate_from_application(); });
test("HostStateSnapshotFrontendTest.test_accepted_program_change_schedules_one_narrow_player_reconciliation", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_accepted_program_change_schedules_one_narrow_player_reconciliation(); });
test("HostStateSnapshotFrontendTest.test_polling_rejects_before_any_snapshot_side_effect", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_polling_rejects_before_any_snapshot_side_effect(); });
test("HostStateSnapshotFrontendTest.test_only_the_central_acceptor_assigns_complete_host_state", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_only_the_central_acceptor_assigns_complete_host_state(); });
test("HostStateSnapshotFrontendTest.test_processing_backend_control_and_translations_are_absent", async () => { const instance = Object.create(HostStateSnapshotFrontendTest); await instance.setUpClass(); await instance.test_processing_backend_control_and_translations_are_absent(); });
