import shutil
import subprocess
import unittest
from pathlib import Path


class IncomingRequestFrontendTest(unittest.TestCase):
    def test_queue_diff_and_notice_replay_expiry(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node unavailable')
        source = (Path(__file__).resolve().parents[1] / 'static/incoming-request.js').read_text(encoding='utf-8')
        script = r'''
const assert = require('node:assert/strict');
let now = 1000, nextTimer = 0; const timers = new Map();
Date.now = () => now;
globalThis.setTimeout = (fn, delay) => { timers.set(++nextTimer,{fn,delay}); return nextTimer; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.requestAnimationFrame = fn => fn();
globalThis.document = {createElement: () => ({textContent:'',className:''})};
const hidden = new Set(['hidden']);
const element = {children:[],classList:{add:v=>hidden.add(v),remove:v=>hidden.delete(v),contains:v=>hidden.has(v)},
 replaceChildren(...children){this.children=children},querySelector(){return this.children[0]}};
''' + source + r'''
const {newestAddition,create}=BilikaraIncomingRequest;
const old={current_item:{id:'current'},playlist:[{id:'queued'}]};
const next={...old,playlist:[{id:'queued'},{id:'new',title:'new song'}]};
assert.equal(newestAddition(null,next),null);
assert.equal(newestAddition(old,old),null);
assert.equal(newestAddition(old,{...next,current_item:{id:'replacement'}}),null);
assert.equal(newestAddition(old,next).id,'new');
assert.equal(newestAddition(next,{...next,playlist:[...next.playlist].reverse()}),null);
let label='新点歌';const toast=create(element,()=>label);
const notice={key:'2:new',title:'new song',expiresAt:5200};
assert.equal(toast.show(notice),true);assert.equal(hidden.has('hidden'),false);
assert.equal(element.children[1].textContent,'new song');
const firstTimer=nextTimer;label='New Request';
assert.equal(toast.show(notice),false);assert.equal(nextTimer,firstTimer);
assert.equal(element.children[0].textContent,label);
now=5201;timers.get(firstTimer).fn();timers.get(nextTimer).fn();
assert.equal(hidden.has('hidden'),true);assert.equal(toast.show(notice),false);
assert.equal(toast.show({...notice,key:'old',expiresAt:999}),false);
assert.equal(toast.show({...notice,key:'invalid',expiresAt:'oops'}),false);
assert.equal(toast.show({...notice,key:'next',expiresAt:7000}),true);
assert.equal(hidden.has('hidden'),false);
'''
        completed = subprocess.run([node, '-'], input=script, capture_output=True, encoding='utf-8', timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
