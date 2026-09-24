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


if __name__ == "__main__":
    unittest.main()
