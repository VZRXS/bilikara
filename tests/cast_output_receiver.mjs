import assert from 'node:assert/strict';
import {fixture,transfer} from './cast_receiver_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';
import {waitFor} from './native_host_support.mjs';

const f=await fixture({vendor:true,rejectMetadata:true});
try{
  for(const path of ['/api/purek/connect','/api/purek/disconnect','/api/purek/output/start','/api/purek/output/pause','/api/purek/output/stop','/api/purek/preferences']){
    const response=await f.client.request(path,{});assert.equal(response.status,410,path);assert.equal(JSON.parse(response.body).code,'purek_retired');
    assert.equal((await f.remote.request(path,{})).status,403,path);
  }
  await f.connect();await f.status('streaming');await waitFor(()=>f.media.length,'real file body');
  const file=f.media[0];inspectTs(file.bytes,{profile:'cast-file'});assert.equal(f.retried,true);
  const head=await transfer(f.uri,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);
  assert.equal(Number(head.headers['content-length']),file.bytes.length);assert.equal(head.headers['content-type'],'video/MP2T');
  const range=await transfer(f.uri,{headers:{Range:'bytes=188-375'}});assert.equal(range.status,206);assert.deepEqual(range.bytes,file.bytes.subarray(188,376));
  assert.equal(range.headers['content-range'],`bytes 188-375/${file.bytes.length}`);
  assert.equal((await transfer(f.uri,{headers:{Range:`bytes=${file.bytes.length}-`}})).status,416);
  assert.deepEqual((await transfer(f.uri,{headers:{Range:'bytes=-188'}})).bytes,file.bytes.subarray(-188));
  for(let i=0;i<5;i++)assert.equal((await transfer(f.uri,{headersOnly:true})).status,200,'new readers never get 409');
  assert.equal((await transfer(f.uri,{localAddress:'127.0.0.2'})).status,200,'LAN peer mismatch does not reject possession of the URI');
  assert.equal((await f.client.request('/api/player/key-shift',{key_shift:1})).status,409,'R1 raw output explicitly rejects L1-only edits');
  const selected=(await f.state()).cast.selected;
  await f.client.api('/api/player/output',{target:'local'});let s=await f.status('authorized');
  assert.equal(s.cast.connected,true);assert.equal(s.cast.owns_playback,false);assert.equal(f.releases,0);
  await f.client.api('/api/cast/command',{command:'cast.set_device_mode',device_key:selected,revision:s.revision,mode:'live'});
  await f.client.api('/api/player/output',{target:'purek',experimental:true});s=await f.status('streaming');
  assert.equal(s.cast.effective_mode,'live');const live=f.uri;
  assert.notEqual(live,file.uri);assert.equal((await transfer(live,{method:'HEAD'})).headers['content-length'],undefined);
  const body=await transfer(live,{headers:{Range:'bytes=188-375'}});assert.equal(body.status,200);assert.ok(body.bytes.length>188);
  await f.command('pause');await f.status('paused');
  await f.command('play');await f.status('streaming');assert.notEqual(f.uri,live);
  assert.equal((await f.remote.request('/api/player/control',{action:'seek-absolute',target_seconds:1,item_id:s.current_item.id,playback_generation:s.playback_generation})).status,409,'live Seek stays explicitly unavailable');
  s=await f.disconnect();assert.equal(s.cast.connected,false);assert.ok(f.releases>0);
  assert.equal(s.media_output.target,'local');assert.equal(s.player_control_command.action,'seek-absolute');
  const report=await f.client.api('/api/cast/report');assert.ok(report.diagnostics.cast.output);assert.ok(!JSON.stringify(report).includes('synthetic-only'));
  process.stdout.write('purek-node-receiver-ok\n');
}finally{await f.close();}
