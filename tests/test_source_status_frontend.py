import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is required")
class SourceStatusFrontendTest(unittest.TestCase):
    def run_client(self, client, script):
        source = (ROOT / "static" / f"{client}.js").read_text(encoding="utf-8")
        shared = (ROOT / "static" / "source-status.js").read_text(encoding="utf-8")
        start = source.index("function syncGatchaTaskTerminalMessage() {")
        sync = source[start:source.index("\n}\n", start) + 2]
        start = source.index('elements.refreshGatchaCacheButton?.addEventListener("click"')
        handler = source[start:source.index("\n});", start) + 4]
        result = subprocess.run(["node", "-"], input=f"""
const assert = require('node:assert/strict');
const window = globalThis;
{shared}
const state = {{ data: {{gatcha:{{last_status:'idle'}}}},
  followBrowseData: {{query:'kept query'}}, favlistBrowseData: {{query:'kept query'}},
  followBrowseQuery: 'kept query', favlistBrowseQuery: 'kept query',
  followBrowseSelectedUid: '123', favlistBrowseSelectedFolderId:'42',
  followBrowseLoading:false, favlistBrowseLoading:false }};
let click, pulls=0, reads=[];
const elements = {{refreshGatchaCacheButton:{{addEventListener:(_event, fn)=>click=fn}}}};
const t=key=>key;
function localizedGatchaTaskMessage(message) {{return message;}}
function setGatchaUidMessage() {{}}
function setGatchaUidInlineMessage() {{}}
function setGatchaUidLoadingMessage() {{}}
function gatchaTaskBusy() {{return Boolean(state.data.gatcha.busy);}}
function gatchaTaskBusyMessage() {{return 'busy';}}
function loadFollowBrowse(args) {{reads.push(['uids',args]);}}
function loadFavlistBrowse(args) {{reads.push(['favorites',args]);}}
function renderGatchaUidFace() {{syncGatchaTaskTerminalMessage();}}
function renderSourceManagementControls() {{syncGatchaTaskTerminalMessage();}}
let refreshImpl;
async function refreshGatchaCache() {{pulls++;return refreshImpl();}}
async function fetchState() {{ /* same authoritative completion already delivered */ }}
{sync}
{handler}
(async()=>{{
  syncGatchaTaskTerminalMessage();
  {script}
}})().catch(error=>{{console.error(error);process.exit(1);}});
""", text=True, encoding="utf-8", capture_output=True, timeout=10, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_completion_before_post_response_survives_clock_skew(self):
        for client in ("app", "remote"):
            with self.subTest(client=client):
                self.run_client(client, """
let release;
refreshImpl=()=>new Promise(resolve=>release=resolve);
const pending=click();
assert.equal(state.gatchaRefreshSaving,true);
await click();
assert.equal(pulls,1,'Ignore duplicate activation while POST is pending');
state.data.gatcha={busy:false,background_busy:false,last_status:'success',last_updated_at:1};
syncGatchaTaskTerminalMessage();
assert.equal(reads.length,0,'Wait for request guard to settle');
release({started:true});await pending;
assert.equal(state.data.gatcha.last_status,'success','Do not overwrite an early completion');
assert.equal(state.gatchaRefreshSaving,false);
assert.equal(reads.length,2,'Reload both views despite an older Host clock');
assert.equal(reads[0][1].uid,'123');assert.equal(reads[0][1].query,'kept query');
assert.equal(reads[1][1].folderId,'42');
syncGatchaTaskTerminalMessage();
assert.equal(reads.length,2,'Do not reload on every state poll');
""")

    def test_failed_completion_queues_behind_initial_browse_and_refreshes_once(self):
        for client in ("app", "remote"):
            with self.subTest(client=client):
                self.run_client(client, """
state.followBrowseData=null;state.followBrowseLoading=true;
state.favlistBrowseData=null;state.favlistBrowseLoading=true;
state.data.gatcha={last_status:'running',busy:true};
syncGatchaTaskTerminalMessage();
state.data.gatcha={last_status:'failed',busy:false,last_updated_at:1};
syncGatchaTaskTerminalMessage();
assert.equal(reads.length,0);
state.followBrowseLoading=false;state.favlistBrowseLoading=false;
BilikaraSourceStatus.flush('uids');BilikaraSourceStatus.flush('favorites');
assert.equal(reads.length,2,'Even a partial write followed by error invalidates displayed data');
BilikaraSourceStatus.flush('uids');BilikaraSourceStatus.flush('favorites');
assert.equal(reads.length,2);
""")

    def test_each_committed_source_refreshes_while_batch_remains_busy(self):
        for client in ("app", "remote"):
            with self.subTest(client=client):
                self.run_client(client, """
const publish=(uids,favorites)=>{
 state.data.gatcha={last_status:'running',busy:true,last_result:{rebuild:{sources:{generation:5,uids,favorites}}}};
 syncGatchaTaskTerminalMessage();
};
publish(0,0);assert.equal(reads.length,0);
publish(1,0);assert.deepEqual(reads.map(r=>r[0]),['uids']);
publish(1,0);assert.equal(reads.length,1,'No reload for a duplicate snapshot');
publish(2,0);assert.equal(reads.length,2,'Second UP updates before batch completion');
publish(2,1);assert.equal(reads.at(-1)[0],'favorites');
assert.equal(state.data.gatcha.busy,true);
state.followBrowseLoading=true;publish(3,1);publish(4,1);
assert.equal(reads.length,3,'Wait for an ongoing read');
state.followBrowseLoading=false;BilikaraSourceStatus.flush('uids');
assert.equal(reads.length,4,'Coalesce concurrent commits into one fresh read');
""")

    def test_queued_completion_is_not_lost_when_next_job_already_started(self):
        for client in ("app", "remote"):
            with self.subTest(client=client):
                self.run_client(client, """
state.data.gatcha={busy:true,last_status:'running',source_queue:{completed:{uids:1,favorites:0}}};
syncGatchaTaskTerminalMessage();
assert.deepEqual(reads.map(r=>r[0]),['uids']);
syncGatchaTaskTerminalMessage();assert.equal(reads.length,1);
const task={last_status:'running',background_busy:true,last_result:{rebuild:{
 current_uid:'2',phase:'uid',pending_uids:['3'],failed_uids:['1']}}};
assert.equal(BilikaraSourceStatus.sourceState(task,{uid:'1'}),'failed');
assert.equal(BilikaraSourceStatus.sourceState(task,{uid:'2'}),'running');
assert.equal(BilikaraSourceStatus.sourceState(task,{uid:'3'}),'queued');
task.source_queue={pending:[{uid:'7',folder_ids:['42']}]};
assert.equal(BilikaraSourceStatus.sourceState(task,{folderId:'7:42'}),'queued');
assert.equal(BilikaraSourceStatus.sourceState(task,{folderId:'8:42'}),'');
""")


    def test_folder_titles_are_sent_only_to_capable_hosts(self):
        for client in ("app", "remote"):
            source = (ROOT / "static" / f"{client}.js").read_text(encoding="utf-8")
            start = source.index("async function pullGatchaFavlist(")
            function = source[start:source.index("\n}\n", start) + 2]
            script = """
const assert = require('node:assert/strict');
const state = {data:{capabilities:{source_queue:true}}};
const apiPost = async (_path, body) => body;
""" + function + """
(async () => {
 const folders = [{id:'42',title:'🎤 收藏'}, {id:'43',title:'Unselected'}];
 const legacy = await pullGatchaFavlist('7',['42'],folders);
 assert.equal(Object.hasOwn(legacy,'folder_titles'),false);
 state.data.capabilities.source_queue_titles=true;
 const current = await pullGatchaFavlist('7',['42'],folders);
 assert.deepEqual(current.folder_titles, {'42':'🎤 收藏'});
 assert.deepEqual(current.folder_ids, ['42']);
 assert.equal(current.queue,true);
})().catch(error=>{console.error(error);process.exitCode=1});
"""
            result = subprocess.run(["node", "-"], input=script, text=True,
                                    encoding="utf-8", capture_output=True, timeout=10, cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_queued_sources_are_placeholders_until_the_library_lists_them(self):
        shared = (ROOT / "static" / "source-status.js").read_text(encoding="utf-8")
        result = subprocess.run(["node", "-"], input=f"""
const assert = require('node:assert/strict');
const window = globalThis;
{shared}
const status = BilikaraSourceStatus;
status.rememberSource({{uid:'7', title:'Seven'}});
status.rememberSource({{folderId:'9:77', title:'Weekend'}});
const task = {{source_queue:{{
  active:{{uid:'7', folder_ids:null}},
  pending:[{{uid:'8', folder_ids:null}}, {{uid:'7', folder_ids:null}}, {{uid:'9', folder_ids:['77', '78']}}],
  failed:[{{uid:'10', folder_ids:null}}],
}}}};
// Waiting and running UPs appear once; listed or failed sources do not.
assert.deepEqual(status.queuedSources(task, 'uids', []),
  [{{placeholder:true, uid:'7', name:'Seven'}}, {{placeholder:true, uid:'8', name:''}}]);
assert.deepEqual(status.queuedSources(task, 'uids', ['8']), [{{placeholder:true, uid:'7', name:'Seven'}}]);
// Folder jobs use plain ids; browse cards use "uid:folder".
assert.deepEqual(status.queuedSources(task, 'favorites', ['9:78']),
  [{{placeholder:true, uid:'9', id:'9:77', folder_id:'77', title:'Weekend'}}]);
assert.deepEqual(status.queuedSources(task, 'favorites', ['77', '78']), []);
// A second browser has no local remembered title; shared queue metadata wins.
task.source_queue.pending[2].folder_titles = {{'77':'Shared folder name', '78':'別の收藏夹'}};
assert.equal(status.queuedSources(task, 'favorites', [])[0].title, 'Shared folder name');
assert.equal(status.queuedSources(task, 'favorites', [])[1].title, '別の收藏夹');
assert.equal(status.sourceState(task, {{uid:'7'}}), 'running');
assert.equal(status.sourceState(task, {{uid:'8'}}), 'queued');
assert.equal(status.sourceState(task, {{folderId:'9:77'}}), 'queued');
assert.deepEqual(status.queuedSources({{}}, 'uids', []), []);
assert.deepEqual(status.queuedSources({{source_queue:{{active:null, pending:[]}}}}, 'favorites', []), []);
""", text=True, encoding="utf-8", capture_output=True, timeout=10, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        for client in ("app", "remote"):
            with self.subTest(client=client):
                source = (ROOT / "static" / f"{client}.js").read_text(encoding="utf-8")
                self.assertIn('queuedSources?.(state.data?.gatcha, "uids"', source)
                self.assertIn('queuedSources?.(state.data?.gatcha, "favorites"', source)
                self.assertIn("rememberSource(", source)
                self.assertIn("source-card-placeholder", source)

if __name__ == "__main__":
    unittest.main()
