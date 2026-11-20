// The continuous composited cast (L2) over the actual R1 T4 endpoint: one
// SetAVTransportURI for the whole show, while the Host pauses, seeks, edits
// pitch and moves to the next song. The receiver only captures bytes; the
// outer test decodes them (video and audio) with FFmpeg.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';

const f=await fixture({vendor:true,maxMediaBytes:64*1024*1024});
try{
  await f.connect();let s=await f.status('streaming');
  const connection=s.purek.output.target_room_id,device=s.cast.selected;
  assert.equal(s.cast.picture,'pure');assert.equal(s.media_output.picture,'pure');
  assert.equal(s.media_output.composite_encoder,null);
  // The receiver declared video/MP2T without a profile: either codec.
  assert.deepEqual(s.media_output.receiver_capabilities.missing,{pure:[],composited:[]});
  await f.client.api('/api/player/advance-delay',{delay_seconds:3});
  const timeline=[],mark=label=>timeline.push([label,Date.now()]);
  // Choosing the composited picture hands the receiver one live URI.
  const before=f.uri;
  s=await f.state();
  await f.client.api('/api/cast/command',{command:'cast.set_device_picture',device_key:device,revision:s.revision,picture:'composited'});
  s=await waitFor(async()=>{const s=await f.state();return s.media_output.pipeline_level==='L2'&&f.uri!==before&&!s.media_output.busy&&s;},'composited show',30000);
  mark('show');
  assert.equal(s.cast.picture,'composited');assert.equal(s.cast.effective_mode,'live');
  assert.equal(s.media_output.picture,'composited');assert.equal(s.media_output.pipeline_reason,null);
  // Linux packages no H.264 encoder: the companion's software MPEG-2.
  assert.match(s.media_output.composite_encoder,/^(companion_mpeg2|mpeg2_software)$/);
  assert.equal(s.media_output.composite_reason,null);
  assert.equal(s.purek.output.target_room_id,connection);assert.equal(f.registrations,1);
  for(const key of ['supports_pitch_shift','supports_runtime_av_offset','supports_track_switch'])assert.equal(s.purek.output.capabilities[key],true,key);
  const uri=f.uri,setActions=()=>f.actions.filter(a=>a==='SetAVTransportURI').length,sets=setActions();
  // The Host's notices and the card labels; invalid models are refused.
  await assert.rejects(f.client.api('/api/cast/overlay',{toast:{key:'k',label:'x',title:'t',expires_at:Date.now()+3_600_000}}),
    e=>e.status===400&&/expiry/i.test(e.data?.error));
  await assert.rejects(f.remote.api('/api/cast/overlay',{toast:null,feedback:[]}));
  const now=Date.now();
  await f.client.api('/api/cast/overlay',{toast:{key:'k',label:'新点歌',title:'Composited fixture',expires_at:now+55_000},
    feedback:[{key:'v',label:'变调',value:'+2',expires_at:now+55_000}],labels:{paused:'Paused',next:'Up next'}});
  await delay(1500);
  // A pitch edit is rendered live, without touching the receiver.
  await f.remote.api('/api/player/key-shift',{key_shift:2});mark('pitch');
  await delay(2000);
  // Pause holds the picture (silence) and play continues from there; the
  // receiver is never paused or reloaded.
  await f.command('pause');s=await f.status('paused');mark('pause');
  assert.equal(s.player_status.is_paused,true);
  await delay(2500);
  await f.command('play');await f.status('streaming');mark('play');
  await delay(1500);
  // A seek near the end: the song ends, the 3 s card, then the next song.
  const first=(await f.state()).current_item.id;
  await f.command('seek-absolute',{target_seconds:7});mark('seek');
  s=await waitFor(async()=>{const s=await f.state();return s.current_item?.id!==first&&s;},'the show advances to the next song',30000);
  mark('next-song');
  assert.equal(s.media_output.pipeline_level,'L2');
  await delay(3000);
  assert.equal(f.uri,uri);assert.equal(setActions(),sets,'one URI for the whole show');
  for(const action of ['Pause','Seek'])assert.ok(!f.actions.includes(action),`${action} never reaches the receiver`);
  // Back to pure media: the show ends (its capture completes) and the
  // per-song pipeline publishes the current song again.
  s=await f.state();
  await f.client.api('/api/cast/command',{command:'cast.set_device_picture',device_key:device,revision:s.revision,picture:'pure'});
  s=await waitFor(async()=>{const s=await f.state();return s.cast.picture==='pure'&&!s.media_output.busy&&s.media_output.pipeline_level!=='L2'&&f.uri!==uri&&s;},'pure picture again',30000);
  assert.equal(s.media_output.composite_encoder,null);assert.equal(s.cast.devices[device].picture,'pure');
  const show=await waitFor(()=>f.media.find(m=>m.uri===uri),'complete show capture',30000);
  writeFileSync(path.join(process.env.BILIKARA_TEST_PUREK_HOME,'composited.ts'),show.bytes);
  const origin=timeline[0][1];
  writeFileSync(path.join(process.env.BILIKARA_TEST_PUREK_HOME,'composited-timeline.json'),
    JSON.stringify(timeline.map(([label,at])=>[label,(at-origin)/1000])));
  await f.disconnect();assert.equal(f.releases,1);
  process.stdout.write('purek-node-receiver-ok\n');
}finally{await f.close();}
