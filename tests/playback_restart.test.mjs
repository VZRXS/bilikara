import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const sandbox = {};
runInNewContext(readFileSync(new URL('../static/playback-restart.js', import.meta.url), 'utf8'), sandbox);
const {restart} = sandbox.BilikaraPlaybackRestart;
const context = {itemId:'current-song', generation:7, key:'current-song:incarnation:7'};

test('Remote restart requires a playable observation for the current song and generation', () => {
  const source=readFileSync(new URL('../static/remote.js',import.meta.url),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const state={data:{current_item:{id:'current-song',item_incarnation_id:'incarnation'},playback_generation:7,playback_mode:'local'}};
  const fixture={state,canRemoteControlPlayer:()=>true,frontendPlaybackMode:value=>value};
  runInNewContext(section('function currentPlayerStatus(', 'function durationSecondsForItem(')
    +section('function remoteRestartContext()', 'let restartControlSync'),fixture);
  assert.equal(fixture.remoteRestartContext().enabled,false,'Media URLs alone do not prove Host readiness');
  for(const phase of ['starting','needs-user-gesture','failed','unknown']) {
    state.data.player_status={item_id:'current-song',playback_generation:7,observed_phase:phase};
    assert.equal(fixture.remoteRestartContext().enabled,false,phase);
  }
  for(const phase of ['playing','paused','ready-paused','ended']) {
    state.data.player_status={item_id:'current-song',playback_generation:7,observed_phase:phase};
    assert.equal(fixture.remoteRestartContext().enabled,true,phase);
  }
  for(const status of [{item_id:'old-song',playback_generation:7}, {item_id:'current-song',playback_generation:6}]) {
    state.data.player_status={...status,observed_phase:'playing'};
    assert.equal(fixture.remoteRestartContext().enabled,false,'Old observations cannot enable Restart');
  }
  fixture.canRemoteControlPlayer=()=>false;
  state.data.player_status={item_id:'current-song',playback_generation:7,observed_phase:'playing'};
  assert.equal(fixture.remoteRestartContext().enabled,false,'Existing media/mode gate still applies');
});

test('restart uses existing ordered seek/play commands bound to the captured song', async () => {
  const requests = [];
  await restart({context, isCurrent:()=>true, post:async (url,body)=>{requests.push([url,JSON.parse(JSON.stringify(body))]); return {commandApplied:true};}});
  assert.deepEqual(requests, [
    ['/api/player/control', {item_id:'current-song', playback_generation:7, delta_seconds:0, action:'seek-absolute', target_seconds:0}],
    ['/api/player/control', {item_id:'current-song', playback_generation:7, delta_seconds:0, action:'play'}],
  ]);
});
test('song changed before activation sends neither command', async () => {
  let requests=0;
  await assert.rejects(restart({context,isCurrent:()=>false,post:async()=>{requests++;}}),/stale/);
  assert.equal(requests,0);
});
test('song changed during held seek prevents the later play from touching its replacement', async () => {
  let current=true, release;
  const requests=[];
  const operation=restart({context,isCurrent:()=>current,post:(url,body)=>{requests.push(body.action); return new Promise(resolve=>{release=resolve;});}});
  current=false; release({commandApplied:true});
  await assert.rejects(operation,/stale/);
  assert.deepEqual(requests,['seek-absolute']);
});
for (const [name,reply] of [['rejected',async()=>({commandApplied:false})],['uncertain',async()=>{throw Error('timeout');}]]) {
  test(`${name} seek submits no play and never retries a mutation`,async()=>{
    let requests=0;
    await assert.rejects(restart({context,isCurrent:()=>true,post:async()=>{requests++;return reply();}}));
    assert.equal(requests,1);
  });
}
test('uncertain play after an accepted seek never resubmits either command',async()=>{
  const requests=[];
  await assert.rejects(restart({context,isCurrent:()=>true,post:async(url,body)=>{
    requests.push(body.action);
    if(body.action==='play') throw Error('timeout');
    return {commandApplied:true};
  }}),/timeout/);
  assert.deepEqual(requests,['seek-absolute','play']);
});

test('native first-use receipt uses fixed shell commands across Host origins', async () => {
  const calls=[];
  const store=sandbox.BilikaraPlaybackRestart.firstUseStore('host',async command=>{calls.push(command);return false;});
  assert.equal(await store.read(),false);
  await store.mark();
  assert.deepEqual(calls,['get_playback_restart_hint_seen','mark_playback_restart_hint_seen']);
  for (const response of [null,{},'false',0]) {
    const invalid=sandbox.BilikaraPlaybackRestart.firstUseStore('host',async()=>response);
    await assert.rejects(invalid.read(),/hint_unavailable/);
  }
});
test('Remote receipt contains only a versioned surface flag and tolerates denied storage', () => {
  const values=new Map();
  sandbox.window={localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)}};
  const store=sandbox.BilikaraPlaybackRestart.firstUseStore('remote');
  assert.equal(store.read(),false);store.mark();assert.equal(store.read(),true);
  assert.deepEqual([...values],[['bilikara.ui.playback-restart-seen.remote.v1','true']]);
  sandbox.window.localStorage={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
  assert.equal(store.read(),false);assert.doesNotThrow(()=>store.mark());
});
