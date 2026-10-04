import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { hasContent, sourceIndex, concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteLateResponseTest = {
async run_handler(body) {
let functions, harness, offset, queue, result, script, source;
source = readFileSync(path.join(ROOT, "static/remote.js"), "utf8");
function extract(start, end) {
offset = sourceIndex(source, start);
return source.slice(offset, sourceIndex(source, end, offset));
}
functions = [extract("function currentStateRevision(", "const CACHE_VOLATILE_ITEM_KEYS"), extract("function applyStateSnapshot(", "function clearEventStreamReconnectTimer("), extract("async function handleAddByHistory(", "async function addByUrl("), extract("async function dispatchRemoteAvDelayAction(", "function clearRemoteVolumeCommitTimer(")].join(`
`);
queue = readFileSync(path.join(ROOT, "static/remote-queue.js"), "utf8");
functions += concatenate(`
`, queue.slice(sourceIndex(queue, "const pendingQueueActions"), sourceIndex(queue, "const dragScrollThresholdPx")));
functions += concatenate(`
`, queue.slice(sourceIndex(queue, "async function reorderQueue"), sourceIndex(queue, "function beginDrag")));
harness = `
const assert = require('node:assert/strict');
const state = {data:null, remoteVolumeSaveSeq:0};
const elements = {};
const busy = new Set();
const document = {activeElement:{setAttribute:key=>busy.add(key),removeAttribute:key=>busy.delete(key)}};
const renderSignatureForSnapshot = JSON.stringify;
let renders = 0;
function scheduleRender() { renders++; }
function renderCacheStatusOnly() {}
function clearRemoteVolumeCommitTimer() {}
function currentPlayerStatus() { return null; }
function clearCurrentPlaybackClock() {}
function syncRemoteIdentityWithSnapshot() {}
function scheduleFavlistBrowseReloadFromState() {}
function renderRemoteAvSyncControls() {}
function frontendPlaybackMode() { return 'local'; }
function selectedRequesterName() { return 'fixture'; }
function setFormMessage() {}
function t() { return ''; }
const avDelayRequestTimeoutMs = 10000;
const window = {confirm:()=>true};
function render() { renders++; }
class Button {
  constructor(action='remove', id='song') { this.disabled=false; this.dataset={action,id}; this.attributes={}; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  setAttribute(k,v) { this.attributes[k]=v; }
  removeAttribute(k) { delete this.attributes[k]; }
}
let resolvePost, rejectPost, posts=0;
const apiPost = () => { posts++; return new Promise((resolve,reject) => {resolvePost = resolve;rejectPost=reject;}); };
const apiPostExactStateCommand = async () => {await apiPost();return {commandApplied:true};};
const submitAddRequestWithDuplicateConfirm = () => apiPost();
const snapshot = (epoch, revision, volume=80, queue=[]) => ({
  state_epoch:epoch,state_revision:revision,playlist:queue,current_item:null,
  playback_generation:1,player_settings:{volume_percent:volume,av_offset_ms:0,av_delay:{effective_delay_ms:0}},
});
`;
script = concatenate(concatenate(concatenate(concatenate(harness, functions), `
(async()=>{
`), body), `
console.log(JSON.stringify({passed:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});`);
result = (await runNative("node", ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, result.stderr);
assert.ok(hasContent(JSON.parse(result.stdout)["passed"]));
},
async test_delayed_resort_and_add_cannot_replace_newer_sse_even_with_force_render() {
(await this.run_handler(`
for (const action of ['resort','add']) {
  const old = snapshot('host',5,80,[{id:'removed-song'}]);
  state.data = old;
  const pending = action === 'resort' ? resortPlaylistByCycle() : handleAddByHistory('fixture','tail');
  const latest = snapshot('host',6,90,[]);
  assert.equal(applyStateSnapshot(latest),true);
  resolvePost(action === 'resort' ? old : {data:old,cancelled:false});
  await pending;
  assert.equal(state.data,latest);
  assert.deepEqual(state.data.playlist,[]);
  assert.equal(state.data.player_settings.volume_percent,90);
  assert.equal(applyStateSnapshot(snapshot('host',0),{forceRender:true}),false);
  const before = renders;
  assert.equal(applyStateSnapshot(latest,{forceRender:true}),true);
  assert.equal(renders,before+1,'same revision may explicitly redraw');
}
`));
},
async test_bare_av_decision_only_applies_if_request_snapshot_is_still_current() {
(await this.run_handler(`
for (const change of ['none','same-epoch','restart','song','own-sse']) {
  const original = snapshot('host-'+change,10);
  state.data = original;
  const pending = dispatchRemoteAvDelayAction({type:'set_effective',effective_delay_ms:2000});
  assert.equal(state.remoteAvDelaySaving,true);
  assert.equal(busy.has('aria-busy'),true);
  let latest = original;
  if (change !== 'none') {
    latest = snapshot(change === 'restart' ? 'new-host' : original.state_epoch,change === 'restart' ? 1 : 11);
    if (change === 'song') {
      latest.playback_generation = 2;
      latest.current_item = {id:'new-song',item_incarnation_id:'new-incarnation'};
    }
    if (change === 'own-sse') latest.player_settings.av_offset_ms = 2000;
    assert.equal(applyStateSnapshot(latest),true);
  }
  resolvePost({effective_delay_ms:2000,locked:true});
  await pending;
  if (change === 'none') {
    assert.equal(state.data.player_settings.av_offset_ms,2000);
    assert.equal(state.data.player_settings.av_delay.locked,true);
  } else {
    assert.equal(state.data,latest);
    assert.equal(state.data.player_settings.av_offset_ms,change === 'own-sse' ? 2000 : 0);
  }
  assert.equal(state.remoteAvDelaySaving,false);
  assert.equal(busy.size,0);
}
`));
},
async test_queue_actions_and_drag_reject_late_snapshots_across_revision_and_epoch() {
(await this.run_handler(`
for (const change of ['revision','epoch']) {
  for (const action of ['play-now','move-next','remove','drag']) {
    const old = snapshot('old-'+change+action,5,80,[{id:'song'}]);
    state.data=old;
    const pending = action==='drag' ? reorderQueue('song',0) : handleQueueAction(action,'song','i',new Button(action));
    const latest = snapshot(change==='epoch' ? 'new-'+action : old.state_epoch,change==='epoch' ? 1 : 6,90,[]);
    assert.equal(applyStateSnapshot(latest),true);
    resolvePost(old);
    await pending;
    assert.equal(state.data,latest);
    assert.equal(state.data.player_settings.volume_percent,90);
    assert.deepEqual(state.data.playlist,[]);
  }
}
`));
},
async test_queue_busy_survives_button_replacement_and_clears_after_success_or_failure() {
(await this.run_handler(`
for (const fails of [false,true]) {
  for (const action of ['play-now','move-next','remove','retry-cache']) {
    state.data=snapshot('busy',5);
    const button=new Button(action), before=posts;
    const pending=handleQueueAction(action,'song','i',button);
    assert.equal(button.disabled,true);
    assert.equal(button.getAttribute('aria-busy'),'true');
    await handleQueueAction(action,'song','i',button);
    const replacement=new Button(action);
    syncQueueActionBusy(replacement);
    assert.equal(replacement.disabled,true);
    assert.equal(replacement.getAttribute('aria-busy'),'true');
    // Also exercise logical admission without relying on the DOM disabled flag.
    await handleQueueAction(action,'song','i',new Button(action));
    assert.equal(posts,before+1);
    if(fails) rejectPost(new Error('request failed')); else resolvePost(state.data);
    await pending;
    for(const b of [button,replacement]) {
      assert.equal(b.disabled,false);
      assert.equal(b.getAttribute('aria-busy'),null);
    }
    assert.equal(pendingQueueActions.size,0);
    const next=handleQueueAction(action,'song','i',button);
    assert.equal(posts,before+2);
    resolvePost(state.data);await next;
  }
}
`));
},
async test_resort_guards_repeated_activation_and_restores_original_disabled_state() {
(await this.run_handler(`
for (const fails of [false,true]) {
  for (const disabled of [false,true]) {
    state.data=snapshot('resort',5);
    const button=elements.resortPlaylistButton=new Button();button.disabled=disabled;
    const before=posts, pending=resortPlaylistByCycle();
    assert.equal(button.disabled,true);
    assert.equal(button.getAttribute('aria-busy'),'true');
    await resortPlaylistByCycle();await resortPlaylistByCycle();
    assert.equal(posts,before+1);
    if(fails) rejectPost(new Error('request failed')); else resolvePost(state.data);
    if(fails) await assert.rejects(pending);else await pending;
    assert.equal(button.disabled,disabled);
    assert.equal(button.getAttribute('aria-busy'),null);
    assert.equal(state.resortingPlaylist,false);
  }
}
`));
}
};
test("RemoteLateResponseTest.test_delayed_resort_and_add_cannot_replace_newer_sse_even_with_force_render", async () => { const instance = Object.create(RemoteLateResponseTest); await instance.test_delayed_resort_and_add_cannot_replace_newer_sse_even_with_force_render(); });
test("RemoteLateResponseTest.test_bare_av_decision_only_applies_if_request_snapshot_is_still_current", async () => { const instance = Object.create(RemoteLateResponseTest); await instance.test_bare_av_decision_only_applies_if_request_snapshot_is_still_current(); });
test("RemoteLateResponseTest.test_queue_actions_and_drag_reject_late_snapshots_across_revision_and_epoch", async () => { const instance = Object.create(RemoteLateResponseTest); await instance.test_queue_actions_and_drag_reject_late_snapshots_across_revision_and_epoch(); });
test("RemoteLateResponseTest.test_queue_busy_survives_button_replacement_and_clears_after_success_or_failure", async () => { const instance = Object.create(RemoteLateResponseTest); await instance.test_queue_busy_survives_button_replacement_and_clears_after_success_or_failure(); });
test("RemoteLateResponseTest.test_resort_guards_repeated_activation_and_restores_original_disabled_state", async () => { const instance = Object.create(RemoteLateResponseTest); await instance.test_resort_guards_repeated_activation_and_restores_original_disabled_state(); });
