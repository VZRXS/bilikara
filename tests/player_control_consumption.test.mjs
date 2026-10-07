// Actual production consumer with held/rejected ACKs; no backend policy mirror.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { setImmediate as microtaskTurn } from 'node:timers/promises';
import test from 'node:test';
import { root } from './desktop_construction_support.mjs';

test('failed ACK retries its head without applying a relative seek twice or sending parallel ACKs', async () => {
  const source = readFileSync(path.join(root,'static/app.js'),'utf8');
  const start = source.indexOf('function applyRemotePlayerControl('), end = source.indexOf('function observedHostPlayerStatus(',start);
  assert.ok(start >= 0 && end > start);
  const state = {data:{playback_generation:1},hostPlaybackSession:{playbackGeneration:1},lastAppliedPlayerControlSeq:0,localShouldBePlaying:false};
  const video = {currentTime:0,duration:60,paused:true}; let applied=0,calls=0,rejectAck,resolveAck;
  const apply = runInNewContext(source.slice(start,end)+'; applyRemotePlayerControl;',{
    state,elements:{playerFrame:{querySelector:selector=>selector==='video'?video:null}},
    isCurrentHostPlaybackSession:session=>session===state.hostPlaybackSession,
    setMediaCurrentTime:(media,time)=>{applied++;media.currentTime=time;},
    apiPost:(route,body)=>{assert.equal(route,'/api/player/control-ack');assert.equal(body.seq,1);calls++;return new Promise((resolve,reject)=>{resolveAck=resolve;rejectAck=reject;});},
  });
  const command={seq:1,action:'seek-relative',item_id:'fixture',playback_generation:1,delta_seconds:7};
  const consume=()=>apply(command,{id:'fixture'},'local');
  consume();consume();assert.equal(calls,1);assert.equal(applied,1);
  rejectAck(new Error('controlled ACK failure'));await microtaskTurn();
  consume();consume();assert.equal(calls,2);assert.equal(applied,1);assert.equal(video.currentTime,7);
  resolveAck({ok:true});await microtaskTurn();assert.equal(state.playerControlAckInFlight.size,0);
});

for (const [action, timing, expected] of [
  ['seek-relative', {delta_seconds: 7}, 27],
  ['seek-absolute', {target_seconds: 12}, 12],
]) test(`${action} remains at the FIFO head when the media pair cannot yet seek`, async () => {
  const source = readFileSync(path.join(root, 'static/app.js'), 'utf8');
  const start = source.indexOf('function applyRemotePlayerControl('), end = source.indexOf('function observedHostPlayerStatus(', start);
  assert.ok(start >= 0 && end > start);
  const state = {data: {playback_generation: 3}, hostPlaybackSession: {playbackGeneration: 3, readyCommitted: false},
    lastAppliedPlayerControlSeq: 0, localShouldBePlaying: true};
  const video = {currentTime: 0, duration: NaN, paused: true}, audio = {};
  const seeks = [], acknowledgements = [];
  const apply = runInNewContext(source.slice(start, end) + '; applyRemotePlayerControl;', {
    state, elements: {playerFrame: {querySelector: selector => selector === 'video' ? video : audio}},
    isCurrentHostPlaybackSession: session => session === state.hostPlaybackSession,
    isTauriWebKitRuntime: () => false,
    beginSplitPlayerSeek: (_video, _audio, options) => {
      if (!state.hostPlaybackSession.readyCommitted) return false;
      seeks.push(options.targetTime); video.currentTime = options.targetTime; return true;
    },
    apiPost: async (route, body) => { assert.equal(route, '/api/player/control-ack'); acknowledgements.push(body.seq); },
  });
  const command = {seq: 7, action, item_id: 'same-song', playback_generation: 3, ...timing};
  const consume = () => apply(command, {id: 'same-song'}, 'local');
  consume(); consume();
  assert.equal(state.lastAppliedPlayerControlSeq, 0);
  assert.deepEqual(seeks, []); assert.deepEqual(acknowledgements, []);
  video.currentTime = 20; video.duration = 90; video.paused = false;
  state.hostPlaybackSession.readyCommitted = true;
  consume(); consume();
  assert.deepEqual(seeks, [expected]); assert.equal(state.lastAppliedPlayerControlSeq, 7);
  assert.deepEqual(acknowledgements, [7]);
  await microtaskTurn();
});
