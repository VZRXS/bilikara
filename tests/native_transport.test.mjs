import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { TransportFixture, transportVideos } from './native_transport_support.mjs';
import { waitFor } from './native_host_support.mjs';

const executable = await buildNativeHost();
const options = {skip: process.platform !== 'linux' ? 'actual Linux local TLS fixture' : false, timeout: 60000};
function accepted(response) { assert.equal(response.status,200,response.body.toString()); assert.equal(response.json.ok,true); assert.equal(response.json.data.accepted,true); }
function decoded(response) { return JSON.parse(response.body); }

test('actual LAN/Internet controls remain queued until Host consumption; ACKs preserve current heads', options, async () => {
  const fixture = await TransportFixture.start(executable), host = fixture.host;
  try {
    const target = await fixture.target();
    const [lan,internet] = await Promise.all([host.request('/api/player/control',{...target,action:'seek-relative',delta_seconds:7}),fixture.remote('playback.seek_relative',{...target,delta_seconds:11})]);
    assert.equal(lan.status,200);accepted(internet);
    assert.deepEqual((await fixture.drain()).map(row=>row.delta_seconds).sort((a,b)=>a-b),[7,11]);
    await host.api('/api/player/control',{...target,action:'pause'}); const head=(await fixture.state()).player_control_command;
    await host.api('/api/player/control-ack',{seq:head.seq+100});assert.deepEqual((await fixture.state()).player_control_command,head);
    const first=(await fixture.drain())[0];await host.api('/api/player/control',{...target,action:'play'});const next=(await fixture.state()).player_control_command;
    for(const seq of [first.seq,first.seq]){await host.api('/api/player/control-ack',{seq});assert.deepEqual((await fixture.state()).player_control_command,next);}
    const forbidden=await fixture.remoteClient.request('/api/player/control-ack',{seq:next.seq});assert.equal(forbidden.status,403);
    for(const seq of [0,true,-1,2**53,1.5]){const invalid=await host.request('/api/player/control-ack',{seq});assert.equal(invalid.status,400);assert.deepEqual((await fixture.state()).player_control_command,next);}
    assert.equal((await fixture.drain()).length,1);
  }finally{await fixture.close();}
});

test('actual simultaneous Next executes once; saturation recovers and reset retires old controls', options, async () => {
  const fixture=await TransportFixture.start(executable),host=fixture.host;
  try{
    const target=await fixture.target(),before=await fixture.state();accepted(await fixture.remote('playback.next',{playback_generation:target.playback_generation}));
    const responses=await Promise.all([host.request('/api/player/next',{playback_generation:target.playback_generation}),host.request('/api/player/next',{playback_generation:target.playback_generation})]);
    assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);assert.equal(decoded(responses.find(row=>row.status===409)).code,'playback_generation_mismatch');
    assert.equal((await fixture.target()).item_id,before.playlist[0].id);const obsolete=await fixture.remote('playback.seek_relative',{...target,delta_seconds:11});assert.equal(obsolete.json.data.accepted,false);assert.equal(obsolete.json.data.stale,true);
    assert.equal((await fixture.state()).player_control_command,null);
    const current=await fixture.target();for(let i=0;i<16;i++)await host.api('/api/player/control',{...current,action:'pause'});
    const first=(await fixture.state()).player_control_command;
    const busy=await host.request('/api/player/control',{...current,action:'play'});assert.equal(busy.status,429);assert.equal(decoded(busy).code,'player_busy');
    const remoteBusy=await fixture.remote('playback.pause',current);assert.equal(remoteBusy.status,429);assert.equal(remoteBusy.json.code,'player_busy');
    assert.equal((await fixture.drain()).length,16);await host.api('/api/player/control',{...current,action:'play'});await host.api('/api/player/reset',{});assert.equal((await fixture.state()).player_control_command,null);
    const late=await host.request('/api/player/control',{...current,action:'pause'});assert.equal(late.status,409);assert.equal(decoded(late).code,'stale_command');
    await host.api('/api/player/control',{...await fixture.target(),action:'play'});const next=(await fixture.state()).player_control_command;assert.ok(next.seq>first.seq);await host.api('/api/player/control-ack',{seq:first.seq});assert.deepEqual((await fixture.state()).player_control_command,next);
  }finally{await fixture.close();}
});

test('actual absolute writes follow commit order; LAN/Internet adjustments add and epochs revoke', options, async () => {
  const fixture=await TransportFixture.start(executable),host=fixture.host;let pending;
  try{
    const bytes=Buffer.from(JSON.stringify({key_shift:-1}));let request,complete;
    pending=new Promise((resolve,reject)=>{request=http.request(host.base+'/api/player/key-shift',{method:'POST',headers:{Origin:host.base,Cookie:[...host.cookies].map(([k,v])=>`${k}=${v}`).join('; '),'Content-Type':'application/json','Content-Length':bytes.length},timeout:10000},response=>{const chunks=[];response.on('data',data=>chunks.push(data));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks)}));response.on('error',reject);});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('held request deadline')));request.write(bytes.subarray(0,3));complete=()=>request.end(bytes.subarray(3));});
    let finished=false;pending.then(()=>{finished=true;});await delay(30);accepted(await fixture.remote('player.set_key_shift',{key_shift:2}));assert.equal(finished,false);assert.equal((await fixture.state()).player_settings.key_shift,2);complete();assert.equal((await pending).status,200);assert.equal((await fixture.state()).player_settings.key_shift,-1);
    const [lan,internet]=await Promise.all([host.request('/api/player/av-delay-action',{type:'adjust',delta_ms:50}),fixture.remote('player.av_delay_action',{type:'adjust',delta_ms:50})]);assert.equal(lan.status,200);accepted(internet);assert.equal((await fixture.state()).player_settings.av_offset_ms,100);
    for(const action of [{type:'toggle_lock'},{type:'adjust',delta_ms:50},{type:'reset_local'}])accepted(await fixture.remote('player.av_delay_action',action));const settings=(await fixture.state()).player_settings;assert.equal(settings.av_offset_ms,100);assert.equal(settings.av_delay.locked,true);
    await host.api('/api/player/av-delay-action',{type:'set_effective',effective_delay_ms:0});
    const adjustments=await Promise.all([0,1].map(()=>host.request('/api/player/av-delay-action',{type:'adjust',delta_ms:50})));assert.deepEqual(adjustments.map(result=>result.status),[200,200]);assert.equal((await fixture.state()).player_settings.av_offset_ms,100);
    const old=fixture.epoch;await host.api('/api/internet-remote/peer/close',{peer_id:'fixture-peer'});await host.api('/api/player/key-shift',{key_shift:1});assert.equal((await fixture.remote('connection.health',{})).json.ok,false);
    fixture.epoch='z'.repeat(22);await fixture.open();assert.equal((await fixture.remote('connection.health',{},'control',old)).json.ok,false);accepted(await fixture.remote('session.set_identity',{name:'Internet ID'}));accepted(await fixture.remote('playback.pause',await fixture.target()));await host.api('/api/player/key-shift',{key_shift:3});assert.equal((await fixture.state()).player_settings.key_shift,3);
  }finally{if(pending)await pending.catch(()=>{});await fixture.close();}
});

test('actual delayed metadata rechecks duplicates after concurrent remove and reorder', options, async () => {
  const fixture=await TransportFixture.start(executable),host=fixture.host;let pending,gate;
  try{
    const before=await fixture.state(),removed=before.playlist[0].id,remaining=before.playlist[1].id;
    gate=fixture.gate('metadata',1);let completed=false;
    pending=fixture.remote('playlist.add',{catalog_item_id:transportVideos[3],position:'tail',allow_repeat:false,expected_revision:before.revision},'bulk').then(value=>{completed=true;return value;});
    pending.catch(()=>{});
    await fixture.wait(gate);accepted(await fixture.remote('playback.pause',await fixture.target()));assert.equal(completed,false);
    // Identical guest reads intentionally share one upstream flight. A real
    // synthetic login changes the credential scope, so the second metadata
    // request can finish independently while the first completion is held.
    await host.api('/api/bbdown/login/start',{});await waitFor(async()=>JSON.stringify((await fixture.state()).bbdown).includes('"logged_in":true'),'synthetic login did not complete');
    await fixture.add(transportVideos[3]);const added=(await fixture.state()).playlist.find(item=>item.bvid===transportVideos[3]);assert.ok(added);
    await host.api('/api/playlist/remove',{item_id:removed});await host.api('/api/playlist/reorder',{item_id:added.id,index:0});
    const stale=await fixture.remote('playlist.move',{item_id:remaining,target_index:0,expected_revision:before.revision});assert.equal(stale.json.data.accepted,false);assert.equal(stale.json.data.stale,true);
    gate.release();const result=await pending;assert.equal(result.status,409,JSON.stringify(result.json));assert.equal(result.json.ok,false);assert.equal(result.json.code,'duplicate_session_request');
    const after=await fixture.state();assert.deepEqual(after.playlist.map(item=>item.id),[added.id,remaining]);assert.ok(after.revision>before.revision);
  }finally{gate?.release();if(pending)await pending.catch(()=>{});await fixture.close();}
});

test('actual upstream catalog search holds no state lock or control lane', options, async () => {
  const fixture=await TransportFixture.start(executable);let pending,gate;
  try{
    gate=fixture.gate('search');let completed=false;
    pending=fixture.remote('catalog.search',{query:'synthetic',limit:5},'bulk').then(value=>{completed=true;return value;});
    await fixture.wait(gate);accepted(await fixture.remote('playback.pause',await fixture.target()));assert.equal(completed,false);
    assert.deepEqual((await fixture.drain()).map(command=>command.action),['pause']);gate.release();const result=await pending;
    assert.equal(result.status,200);assert.equal(result.json.data.accepted,true);assert.deepEqual(result.json.data.data.items.map(row=>row.bvid),transportVideos);
  }finally{gate?.release();if(pending)await pending.catch(()=>{});await fixture.close();}
});

test('actual racing Internet control and generation changes never publish a retired control', options, async () => {
  const fixture=await TransportFixture.start(executable),host=fixture.host;
  try{
    for(let count=0;count<12;count++){
      const target=await fixture.target();const [control,change]=await Promise.all([
        fixture.remote('playback.seek_relative',{...target,delta_seconds:7}),host.request('/api/player/restart-program',{}),
      ]);
      assert.equal(change.status,200);assert.ok([200,409].includes(control.status));const after=await fixture.state();
      assert.ok(after.playback_generation>target.playback_generation);assert.equal(after.player_control_command,null);
      const late=await fixture.remote('playback.seek_relative',{...target,delta_seconds:7});assert.equal(late.json.data.accepted,false);assert.equal(late.json.data.stale,true);
    }
  }finally{await fixture.close();}
});
