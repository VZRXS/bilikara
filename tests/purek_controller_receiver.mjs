// P6 mapping: real R1 SOAP Pause/Seek replaces the previous L1 rebuild policy.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

const dlna=process.env.BILIKARA_TEST_PUREK_DLNA==='1';
const f=await fixture({vendor:!dlna,rejectMetadata:dlna});
try{
  assert.equal((await f.remote.request('/api/player/output',{target:'purek',experimental:true})).status,403);
  assert.equal((await f.client.request('/api/player/output',{target:'purek'})).status,400);
  const initial=await f.state();await f.connect();let s=await f.status('streaming');
  assert.equal(s.purek.connection_type,dlna?'dlna':'purek');assert.equal(s.media_output.qualified,false);assert.equal(s.media_output.pipeline_level,'L1');assert.equal(s.media_output.pipeline_reason,null);
  assert.equal((await f.client.api('/api/player/claim-program',{playback_generation:s.playback_generation,item_incarnation_id:s.current_item.item_incarnation_id,artifact_set_id:s.current_item.artifact_set_id},{'X-Bilikara-Client':'controller-fixture'})).claimed,false);
  assert.equal((await f.client.request('/api/player/control-ack',{seq:1})).status,409);
  const publicState=await f.remote.api('/api/state');assert.equal(publicState.media_output.can_manage,false);assert.equal(publicState.purek,undefined);assert.equal(publicState.cast,undefined);
  assert.ok(!JSON.stringify(publicState.media_output).includes('Controller fixture'));
  assert.deepEqual(Object.keys(s.media_output).sort(),['schema_version','target','requested_target','status','available','authorized','can_manage','experimental','qualified','busy','desired_playing','position','duration','transition_remaining_ms','pipeline_level','pipeline_reason','stream_generation','producer_eof','preview_tail_sequence','offset_mode','last_error','measured_adjust_latency_ms','position_source','thermal_status','thermal_headroom','failure'].sort());
  // Exact next 3057fb7 wire fields: the adapter may not leak the new authority.
  const keys=(value,expected)=>assert.deepEqual(Object.keys(value).sort(),expected.split(' ').sort());
  keys(s.purek,'auto_discovery busy connected room_name connection_type discovered error_code error_stage capabilities output revision state_epoch');
  keys(s.purek.output,'schema_version target_room_id generation status capabilities pipeline_level offset_mode last_error measured_adjust_latency_ms');
  keys(s.purek.output.capabilities,'has_av_transport has_rendering_control has_connection_manager protocol_info_state protocol_info_error supports_play supports_pause supports_seek supports_live_stream supports_midstream_param_change supports_runtime_av_offset supports_track_switch supports_pitch_shift sink_formats');
  keys(s.ktv_assistance,'devices session recovery host_epoch revision candidate_owned authorization_link_available');
  keys(s.ktv_assistance.recovery,'available source_label remaining_seconds');
  keys(publicState.ktv_room,'status connected connection_type');
  assert.equal(typeof s.purek.output.target_room_id,'string');
  assert.equal(s.purek.state_epoch,s.state_epoch);
  assert.equal((await f.remote.request('/api/player/control',{action:'pause',playback_generation:s.playback_generation})).status,400);
  assert.equal((await f.remote.request('/api/player/control',{action:'next-track',item_id:s.current_item.id,playback_generation:s.playback_generation,expected_queue_version:5})).status,400);
  const first=f.uri;await f.command('pause');s=await f.status('paused');assert.equal(s.player_status.is_paused,true);assert.ok(f.actions.includes('Pause'));
  await f.command('play');await f.status('streaming');assert.equal(f.uri,first,'file resume uses receiver Play');
  await f.command('seek-absolute',{target_seconds:15});await waitFor(()=>f.position===15,'real receiver Seek');await f.status('streaming');assert.equal(f.uri,first);
  await f.command('pause');await f.status('paused');await f.command('seek-absolute',{target_seconds:20});await waitFor(()=>f.position===20,'paused receiver Seek');await f.status('paused');
  await f.command('play');await f.status('streaming');
  // File DSP edits regenerate the file (covered by cast_l1_receiver.mjs);
  // restarting the program stays unavailable while the receiver owns playback.
  assert.equal((await f.client.request('/api/player/restart-program',{})).status,409,'restart-program is explicit while casting');
  assert.equal((await f.remote.request('/api/player/next',{playback_generation:s.playback_generation,expected_queue_version:'stale'})).status,409);
  await f.remote.api('/api/player/next',{playback_generation:s.playback_generation});
  s=await waitFor(async()=>{const s=await f.state();return s.current_item?.id!==initial.current_item.id&&s.media_output.status==='streaming'&&!s.media_output.busy&&s;},'next cached song');
  assert.equal(s.current_item.id,'purek-fixture-1');assert.notEqual(f.uri,first);
  f.position=37;await waitFor(async()=>(await f.state()).cast.position===37,'receiver position');f.refuse=true;
  s=await waitFor(async()=>{const s=await f.state();return s.media_output.status==='error'&&s.media_output.target==='local'&&s;},'recovery returns local',20000);assert.equal(s.media_output.target,'local');assert.equal(s.cast.connected,false);assert.equal(s.cast.resume.position,37);
  assert.equal(s.player_control_command.action,'seek-absolute');assert.equal(s.player_control_command.target_seconds,37);
  // Atomic handback: the restore seek carries the receiver's playing intent.
  keys(s.player_control_command,'seq action item_id playback_generation delta_seconds target_seconds issued_at play_intent');
  assert.equal(s.player_control_command.play_intent,true);
  f.refuse=false;await f.connect();await f.status('streaming');await waitFor(()=>f.media.length>=3,'real reconnected bytes');
  f.position=119;await waitFor(async()=>(await f.state()).cast.position===119,'near-end observation');f.transport='STOPPED';
  s=await waitFor(async()=>{const s=await f.state();return s.current_item?.id==='purek-fixture-2'&&s.cast.phase==='idle'&&s;},'receiver natural finish advances once');
  assert.equal(s.media_output.target,'local');assert.equal(s.cast.error_code,'cast_media_unavailable','uncached next item produces the R1 explicit error');
  await delay(500);assert.equal((await f.state()).current_item.id,'purek-fixture-2');
  const full=f.media[0];inspectTs(full.bytes,{profile:'cast-file'});assert.ok(s.session_played.some(x=>x.item_id==='purek-fixture-1'&&x.threshold_reached));
  await f.disconnect();const counts=Object.fromEntries([...new Set(f.actions)].map(a=>[a,f.actions.filter(v=>v===a).length]));
  assert.equal(f.registrations>0,!dlna);assert.equal(f.releases>0,!dlna);
  writeFileSync(process.env.BILIKARA_TEST_PUREK_REPORT,JSON.stringify({connection_type:dlna?'dlna':'purek',qualified:false,actions:counts,empty_metadata_retry:dlna&&f.retried,stream_bytes:full.bytes.length,video_frames:24})+'\n');
  process.stdout.write('purek-node-receiver-ok\n');
}finally{await f.close();}
