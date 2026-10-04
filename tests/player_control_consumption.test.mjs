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
