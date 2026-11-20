// L2, the composited cast, over the actual R1 T4 endpoint. The receiver only
// captures bytes; the outer test decodes them (video and audio) with FFmpeg.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';

const f=await fixture({vendor:true});
try{
  await f.connect();let s=await f.status('streaming');
  const connection=s.purek.output.target_room_id,device=s.cast.selected;
  assert.equal(s.cast.picture,'pure');assert.equal(s.media_output.picture,'pure');
  assert.equal(s.media_output.composite_encoder,null);
  const streaming=(label,check)=>waitFor(async()=>{const s=await f.state();return s.media_output.status==='streaming'&&!s.media_output.busy&&check(s)&&s;},label,30000);
  // Choosing the composited picture restarts the output live, as L2, on the
  // same receiver connection and Pure K registration.
  const before=f.uri;
  await f.client.api('/api/cast/command',{command:'cast.set_device_picture',device_key:device,revision:s.revision,picture:'composited'});
  s=await streaming('composited publication',s=>s.media_output.pipeline_level==='L2'&&f.uri!==before);
  assert.equal(s.cast.picture,'composited');assert.equal(s.cast.effective_mode,'live');
  assert.equal(s.cast.devices[device].picture,'composited');
  assert.equal(s.media_output.picture,'composited');assert.equal(s.media_output.pipeline_reason,null);
  // Linux packages no H.264 encoder: the companion's software MPEG-2 transcode.
  assert.equal(s.media_output.composite_encoder,'companion_mpeg2');assert.equal(s.media_output.composite_reason,null);
  assert.equal(s.purek.output.target_room_id,connection);assert.equal(f.registrations,1);
  // The L1 audio renderer stays live: DSP edits reach the receiver unrestarted.
  for(const key of ['supports_pitch_shift','supports_runtime_av_offset','supports_track_switch'])assert.equal(s.purek.output.capabilities[key],true,key);
  const uri=f.uri,setActions=f.actions.filter(a=>a==='SetAVTransportURI').length;
  // The Host page publishes the Audience view-model; frames rendered after it
  // carry the request toast and an operation card. Invalid models are refused.
  await assert.rejects(f.client.api('/api/cast/overlay',{toast:{key:'k',label:'x',title:'t',expires_at:Date.now()+3_600_000}}),
    e=>e.status===400&&/expiry/i.test(e.data?.error));
  await assert.rejects(f.remote.api('/api/cast/overlay',{toast:null,feedback:[]}));
  const now=Date.now();
  await f.client.api('/api/cast/overlay',{toast:{key:'k',label:'新点歌',title:'Composited fixture',expires_at:now+55_000},
    feedback:[{key:'v',label:'变调',value:'+2',expires_at:now+55_000}]});
  await f.remote.api('/api/player/key-shift',{key_shift:2});
  await delay(200);
  s=await f.state();assert.equal(s.player_settings.key_shift,2);assert.equal(s.media_output.pipeline_level,'L2');
  assert.equal(f.uri,uri);assert.equal(f.actions.filter(a=>a==='SetAVTransportURI').length,setActions,'edits must not restart the receiver');
  const full=await waitFor(()=>f.media.find(m=>m.uri===uri),'complete composited capture',60000);
  writeFileSync(path.join(process.env.BILIKARA_TEST_PUREK_HOME,'composited.ts'),full.bytes);
  // Back to pure media: L1 copies the source video again.
  s=await f.state();
  await f.client.api('/api/cast/command',{command:'cast.set_device_picture',device_key:device,revision:s.revision,picture:'pure'});
  s=await waitFor(async()=>{const s=await f.state();return s.cast.picture==='pure'&&!s.media_output.busy&&s.media_output.pipeline_level!=='L2'&&s;},'pure picture again',30000);
  assert.equal(s.media_output.composite_encoder,null);assert.equal(s.cast.devices[device].picture,'pure');
  const pure=f.uri;assert.notEqual(pure,uri);
  await waitFor(()=>f.media.some(m=>m.uri===pure),'pure stream completes',60000);
  await f.disconnect();assert.equal(f.releases,1);
  process.stdout.write('purek-node-receiver-ok\n');
}finally{await f.close();}
