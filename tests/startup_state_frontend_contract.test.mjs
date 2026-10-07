import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
const __file__ = fileURLToPath(import.meta.url);
import { contains, hasContent, sourceIndex } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const StartupStateFrontendTest = {
async setUpClass() {
this.repo_root = path.resolve(path.resolve(__file__), "..", "..");
this.source = readFileSync(path.join(path.join(this.repo_root, "static"), "app.js"), "utf8");
},
async source_slice(start_marker, end_marker) {
let end, start;
start = sourceIndex(this.source, start_marker);
end = sourceIndex(this.source, end_marker, start);
return this.source.slice(start, end);
},
async run_state_sequence(responses) {
let completed, fetch_state, remote_access_failure, response_parser, script, snapshot_acceptance;
response_parser = (await this.source_slice("async function parseApiResponse", "async function apiPost"));
fetch_state = (await this.source_slice("async function fetchState", "function renderSignatureForData"));
snapshot_acceptance = (await this.source_slice("function isSafeHostSnapshotInteger", "function syncCachePanelVisibility"));
remote_access_failure = (await this.source_slice("function updateRemoteAccessFailure", "function localRemoteAccessView"));
script = (`
const responseSpecs = ` + String(JSON.stringify(responses)) + `;
let responseIndex = 0;
let jsonCalls = 0;
let renderPlayerCalls = 0;
const messages = [];
const window = { location: { href: "http://tauri.localhost/" } };
const state = {
  data: null,
  hasValidStateResponse: false,
  localPreferencesHydrated: true,
  lastPollRenderSignature: "",
  pendingHostPlaybackProgramReconciliation: null,
  hostPlaybackSession: null,
  remoteAccessFailure: null,
  remoteAccessRequestSequence: 0,
  remoteAccessOutcomeSequence: 0,
};

function makeResponse(spec) {
  return {
    url: spec.url,
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? spec.contentType : null;
      },
    },
    async json() {
      jsonCalls += 1;
      if (spec.jsonError) throw new SyntaxError(spec.jsonError);
      return spec.payload;
    },
  };
}

async function fetch() {
  return makeResponse(responseSpecs[responseIndex++]);
}
function clientHeaders() { return {}; }
function localizedApiMessage(message) { return String(message || ""); }
function t() { return "State request failed"; }
function currentAvOffsetMs() { return 0; }
function frontendPlaybackMode() { return "local"; }
function maybeShowIncomingRequestToast() {}
function maybeShowSongTransitionOverlay() {}
function scheduleStartupAppUpdateCheck() {}
function syncLocalPlayerSettingsFromSnapshot() {}
function rememberedVolumePercent() { return 100; }
function rememberedMuted() { return false; }
async function apiPost() { throw new Error("apiPost must not run"); }
function scheduleFavlistBrowseReloadFromState() {}
function renderSignatureForData(data) { return JSON.stringify(data); }
function render() {}
function renderPlayer() { renderPlayerCalls += 1; }
function renderRemoteAccess() {}
function publishPresentationOutputState() {}
function hasDownloadingItems() { return false; }
function refreshRetryButtons() {}
function resyncMountedLocalPlayerIfOffsetChanged() {}
function setAppMessage(message, isError) {
  messages.push({ message: String(message), isError: Boolean(isError) });
}

` + String(response_parser) + `
` + String(snapshot_acceptance) + `
` + String(remote_access_failure) + `
` + String(fetch_state) + `

async function pollOnce() {
  try {
    await fetchState();
    return null;
  } catch (error) {
    if (shouldReportStateFetchError(error)) {
      setAppMessage(error.message, true);
    }
    return {
      message: error.message,
      kind: error.kind,
      status: error.status,
      contentType: error.contentType,
      backendNotReady: Boolean(error.backendNotReady),
    };
  }
}

(async () => {
  const firstError = await pollOnce();
  const afterFirst = {
    data: state.data,
    ready: state.hasValidStateResponse,
    messages: [...messages],
    jsonCalls,
    remoteAccessFailure: state.remoteAccessFailure,
  };
  const secondError = await pollOnce();
  console.log(JSON.stringify({
    firstError,
    secondError,
    afterFirst,
    finalData: state.data,
    finalReady: state.hasValidStateResponse,
    messages,
    jsonCalls,
    renderPlayerCalls,
    remoteAccessFailure: state.remoteAccessFailure,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`);
completed = (await runNative("node", ["-e", script], process.env, 120000, this.repo_root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_pre_ready_tauri_html_keeps_loading_then_valid_state_initializes() {
let result;
result = (await this.run_state_sequence([{["url"]: "http://tauri.localhost/api/state", ["status"]: 200, ["contentType"]: "text/html; charset=utf-8", ["jsonError"]: "Unexpected token '<'"}, {["url"]: "http://127.0.0.1:43123/api/state", ["status"]: 200, ["contentType"]: "application/json; charset=utf-8", ["payload"]: {["ok"]: true, ["data"]: {["state_revision"]: 1, ["revision"]: 1, ["playback_generation"]: 1, ["playback_program"]: null, ["current_item"]: null, ["playlist"]: []}}}]));
assert.deepEqual(result["firstError"], {["message"]: "Backend returned a non-JSON response", ["kind"]: "non_json_response", ["status"]: 200, ["contentType"]: "text/html; charset=utf-8", ["backendNotReady"]: true});
assert.equal(result["afterFirst"]["data"], null);
assert.ok(!hasContent(result["afterFirst"]["ready"]));
assert.deepEqual(result["afterFirst"]["messages"], []);
assert.deepEqual(result["afterFirst"]["jsonCalls"], 0);
assert.deepEqual(result["afterFirst"]["remoteAccessFailure"], {["kind"]: "invalid", ["status"]: 200});
assert.equal(result["secondError"], null);
assert.equal(result["remoteAccessFailure"], null);
assert.ok(hasContent(result["finalReady"]));
assert.deepEqual(result["finalData"]["state_revision"], 1);
assert.deepEqual(result["messages"], []);
assert.deepEqual(result["jsonCalls"], 1);
assert.deepEqual(result["renderPlayerCalls"], 1);
},
async test_post_ready_non_json_state_response_remains_observable() {
let result;
result = (await this.run_state_sequence([{["url"]: "http://127.0.0.1:43123/api/state", ["status"]: 200, ["contentType"]: "application/json", ["payload"]: {["ok"]: true, ["data"]: {["state_revision"]: 1, ["revision"]: 1, ["playback_generation"]: 1, ["playback_program"]: null, ["current_item"]: null, ["playlist"]: []}}}, {["url"]: "http://127.0.0.1:43123/api/state", ["status"]: 502, ["contentType"]: "text/html", ["jsonError"]: "Unexpected token '<' at <!DOCTYPE html>"}]));
assert.equal(result["firstError"], null);
assert.ok(hasContent(result["afterFirst"]["ready"]));
assert.deepEqual(result["secondError"]["kind"], "non_json_response");
assert.deepEqual(result["remoteAccessFailure"], {["kind"]: "http", ["status"]: 502});
assert.ok(!hasContent(result["secondError"]["backendNotReady"]));
assert.deepEqual(result["messages"], [{["message"]: "Backend returned a non-JSON response", ["isError"]: true}]);
assert.ok(!contains("Unexpected token", result["messages"][0]["message"]));
assert.ok(!contains("DOCTYPE", result["messages"][0]["message"]));
assert.deepEqual(result["jsonCalls"], 1);
assert.deepEqual(result["renderPlayerCalls"], 1);
}
};
test("StartupStateFrontendTest.test_pre_ready_tauri_html_keeps_loading_then_valid_state_initializes", async () => { const instance = Object.create(StartupStateFrontendTest); await instance.setUpClass(); await instance.test_pre_ready_tauri_html_keeps_loading_then_valid_state_initializes(); });
test("StartupStateFrontendTest.test_post_ready_non_json_state_response_remains_observable", async () => { const instance = Object.create(StartupStateFrontendTest); await instance.setUpClass(); await instance.test_post_ready_non_json_state_response_remains_observable(); });
