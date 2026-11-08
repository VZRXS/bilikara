import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context=vm.createContext({queueMicrotask});
vm.runInContext(readFileSync(new URL('../static/media-backend.js',import.meta.url),'utf8'),context);
const {createLegacyPlaybackAdapter,identity}=context.BilikaraMediaBackend;
const program={playback_generation:7,item_id:'song',item_incarnation_id:'i1',
  selected_audio_variant_id:'track',artifact_set_id:'a1'};

test('facade delegates all operations without wrapping results or owning media',async()=>{
  const calls=[], promise=Promise.resolve(42), token={};
  const ports=Object.fromEntries(['load','play','pause','seek','setVolume','setKeyShift','setAvDelay',
    'selectAudioVariant','snapshot','stop'].map(name=>[name,(...args)=>{
      calls.push([name,args]);return name==='seek'?promise:token;
    }]));
  const adapter=createLegacyPlaybackAdapter({program,current:()=>program,ports});
  assert.ok(Object.isFrozen(adapter.program));
  for(const name of Object.keys(ports)) assert.equal(adapter[name](program,3),name==='seek'?promise:token);
  assert.deepEqual(calls.map(([name])=>name),Object.keys(ports));
  assert.deepEqual(calls.find(([name])=>name==='setAvDelay')[1],[3]);
  assert.equal(await promise,42);
});

test('every identity field rejects stale commands before effects; stale observations cannot ACK EOS',()=>{
  let current=program, effects=0, events=0;
  const adapter=createLegacyPlaybackAdapter({program,current:()=>current,ports:{play:()=>effects++}});
  adapter.subscribe(()=>events++);
  for(const key of Object.keys(program)) {
    const stale={...program,[key]:key==='playback_generation'?8:'changed'};
    assert.throws(()=>adapter.play(stale),{code:'stale-program'});
    assert.equal(adapter.observe(stale,{type:'eos'}),false);
  }
  current={...program,playback_generation:8};
  assert.throws(()=>adapter.play(program),{code:'stale-program'});
  assert.equal(adapter.observe(program,{type:'eos'}),false);
  assert.equal(effects,0);assert.equal(events,0);
});

test('ready, playing and drained EOS remain distinct observations; disposal is exactly once',async()=>{
  let disposed=0;
  const adapter=createLegacyPlaybackAdapter({program,current:()=>program,ports:{dispose:()=>disposed++}});
  const events=[];
  const off=adapter.subscribe(event=>events.push(event.type));
  adapter.subscribe(()=>{throw Error('observer');});
  for(const type of ['ready','playing','eos'])assert.equal(adapter.observe(program,{type}),true);
  assert.deepEqual(events,[]);
  await Promise.resolve();
  assert.deepEqual(events,['ready','playing','eos']);off();
  adapter.dispose();adapter.dispose();assert.equal(disposed,1);
  assert.throws(()=>adapter.load(program),{code:'disposed'});
  assert.equal(adapter.observe(program,{type:'playing'}),false);
});

test('observation callbacks cannot interleave the owner commit; retired delivery is cancelled',async()=>{
  let committed=false,stops=0;
  const adapter=createLegacyPlaybackAdapter({program,current:()=>program,ports:{stop:()=>{assert.ok(committed);stops++;}}});
  adapter.subscribe(()=>adapter.stop(program));
  adapter.observe(program,{type:'ready'});committed=true;
  assert.equal(stops,0);await Promise.resolve();assert.equal(stops,1);
  adapter.observe(program,{type:'eos'});adapter.dispose();await Promise.resolve();assert.equal(stops,1);
});

test('invalid identities and unsupported operations fail explicitly',()=>{
  for(const invalid of [null,{...program,playback_generation:NaN},{...program,item_incarnation_id:''}]) {
    assert.throws(()=>identity(invalid),{name:'TypeError'});
  }
  const adapter=createLegacyPlaybackAdapter({program,current:()=>program,ports:{}});
  assert.throws(()=>adapter.seek(program,2),{code:'unsupported-seek'});
});
