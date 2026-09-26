"""Execute real Remote action handlers with POST responses delayed behind SSE."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "requires Node.js")
class RemoteLateResponseTest(unittest.TestCase):
    def run_handler(self, body):
        source = (ROOT / "static/remote.js").read_text(encoding="utf-8")
        def extract(start, end):
            offset = source.index(start)
            return source[offset:source.index(end, offset)]
        functions = "\n".join([
            extract("function currentStateRevision(", "const CACHE_VOLATILE_ITEM_KEYS"),
            extract("function applyStateSnapshot(", "function clearEventStreamReconnectTimer("),
            extract("async function handleAddByHistory(", "async function addByUrl("),
            extract("async function dispatchRemoteAvDelayAction(", "function clearRemoteVolumeCommitTimer("),
        ])
        queue = (ROOT / "static/remote-queue.js").read_text(encoding="utf-8")
        functions += "\n" + queue[queue.index("const pendingQueueActions"):queue.index("const dragScrollThresholdPx")]
        functions += "\n" + queue[queue.index("async function reorderQueue"):queue.index("function beginDrag")]
        harness = r'''
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
'''
        script = harness + functions + "\n(async()=>{\n" + body + "\nconsole.log(JSON.stringify({passed:true}));\n})().catch(error=>{console.error(error);process.exitCode=1;});"
        result = subprocess.run(["node", "-"], input=script, cwd=ROOT, text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["passed"])

    def test_delayed_resort_and_add_cannot_replace_newer_sse_even_with_force_render(self):
        self.run_handler(r'''
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
''')

    def test_bare_av_decision_only_applies_if_request_snapshot_is_still_current(self):
        self.run_handler(r'''
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
''')

    def test_queue_actions_and_drag_reject_late_snapshots_across_revision_and_epoch(self):
        self.run_handler(r'''
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
''')

    def test_queue_busy_survives_button_replacement_and_clears_after_success_or_failure(self):
        self.run_handler(r'''
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
''')

    def test_resort_guards_repeated_activation_and_restores_original_disabled_state(self):
        self.run_handler(r'''
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
''')
