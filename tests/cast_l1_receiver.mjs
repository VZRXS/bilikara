// P8: the retained L1 edit/TS contract over the actual R1 T4 HTTP endpoint.
// No product parser or DSP is imported by this receiver.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture,transfer} from './cast_receiver_support.mjs';
import {waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

function firstVideo(bytes){
  for(let n=0;n<bytes.length;n+=188){
    const p=bytes.subarray(n,n+188);assert.equal(p[0],0x47);
    if(!(p[1]&64)||!(p[3]&16))continue;
    const b=p.subarray((p[3]&32)?5+p[4]:4);
    if(b[0]!==0||b[1]!==0||b[2]!==1||b[3]<0xe0||b[3]>0xef)continue;
    const t=b.subarray(9,14),pts=((t[0]>>1)&7)*2**30+t[1]*2**22+(t[2]>>1)*2**15+t[3]*128+(t[4]>>1);
    assert.ok(b.subarray(9+b[8]).includes(Buffer.from([0,0,0,1,0x09])),'video access unit delimiter');
    return {pts,pid:((p[1]&31)<<8)|p[2]};
  }
  assert.fail('video PES at joined keyframe');
}

const f=await fixture({vendor:true});
try{
  await f.connect();let s=await f.status('streaming');
  const original=s.current_item,connection=s.purek.output.target_room_id;
  assert.equal(s.media_output.pipeline_level,'L0');
  // The R1 file/no-L1 retreat rejects controls without changing their values.
  const settings=s.player_settings;
  for(const [route,body] of [['/api/player/key-shift',{key_shift:2}],['/api/player/av-delay-action',{type:'adjust',delta_ms:20}]]){
    assert.equal((await f.remote.request(route,body)).status,409);
    assert.deepEqual((await f.state()).player_settings,settings);
  }
  await f.client.api('/api/cast/command',{command:'cast.set_device_mode',device_key:s.cast.selected,revision:s.revision,mode:'live'});
  s=await waitFor(async()=>{const s=await f.state();return s.media_output.pipeline_level==='L1'&&s.media_output.status==='streaming'&&!s.media_output.busy&&s;},'T4 L1 publication');
  const uri=f.uri,generation=s.media_output.stream_generation,playback=s.playback_generation;
  assert.equal(s.cast.effective_mode,'live');assert.equal(s.media_output.authorized,true);
  assert.equal(s.purek.output.target_room_id,connection);
  for(const key of ['supports_midstream_param_change','supports_pitch_shift','supports_runtime_av_offset','supports_track_switch'])assert.equal(s.purek.output.capabilities[key],true,key);
  const head=await transfer(uri,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers['content-length'],undefined);assert.equal(head.headers['content-type'],'video/MP2T');
  const beforeActions=f.actions.filter(a=>['Stop','SetAVTransportURI','Play'].includes(a));
  const offset=value=>f.remote.api('/api/player/av-delay-action',{type:'set_effective',effective_delay_ms:value});
  const change=async action=>{await action();await delay(120);};
  await change(()=>offset(150));await change(()=>offset(0));await change(()=>offset(-150));
  await change(()=>f.remote.api('/api/player/output',{offset_mode:'gradual'}));
  await change(()=>offset(150));await change(()=>offset(0));
  await change(()=>f.remote.api('/api/player/audio-variant',{item_id:original.id,expected_item_incarnation_id:original.item_incarnation_id,variant_id:'instrumental'}));
  await change(()=>f.remote.api('/api/player/key-shift',{key_shift:2}));
  await change(()=>f.remote.api('/api/player/volume',{volume_percent:35,is_muted:true}));
  await change(()=>f.remote.api('/api/player/volume',{is_muted:false}));
  await change(()=>f.remote.api('/api/player/output',{offset_mode:'splice'}));
  s=await f.state();assert.equal(s.media_output.stream_generation,generation);assert.equal(f.uri,uri);
  assert.equal(s.media_output.offset_mode,'splice');assert.equal(s.current_item.selected_audio_variant_id,'instrumental');
  assert.equal(s.playback_generation,playback+1);assert.equal(s.player_settings.key_shift,2);
  assert.equal(s.player_settings.volume_percent,35);assert.equal(s.player_settings.is_muted,false);
  assert.deepEqual(f.actions.filter(a=>['Stop','SetAVTransportURI','Play'].includes(a)),beforeActions,'edits must not restart the receiver');
  // Join after a later GOP exists, while the original reader is still active.
  await delay(1000);
  const late=await transfer(uri,{headers:{Range:'bytes=188-375'},localAddress:'127.0.0.2'});
  assert.equal(late.status,200);assert.equal(late.headers['content-length'],undefined);
  const full=await waitFor(()=>f.media.find(m=>m.uri===uri),'complete primary T4 capture');
  inspectTs(full.bytes,{videoFrames:144,channels:2,sampleRate:48000});
  const first=firstVideo(full.bytes),joined=firstVideo(late.bytes);
  const skipped=(joined.pts-first.pts)/(90000*1001/24000);
  assert.ok(Number.isInteger(skipped)&&skipped>=24&&skipped<=96,'join a later one-second keyframe, before EOF');
  assert.equal(skipped%24,0);assert.ok(late.bytes.includes(Buffer.from([0,0,1,0x65])),'joined IDR');
  inspectTs(late.bytes,{videoFrames:144-skipped,channels:2,sampleRate:48000});
  writeFileSync(path.join(process.env.BILIKARA_TEST_PUREK_HOME,'captured.ts'),full.bytes);
  const counters=new Map();for(let i=0;i<late.bytes.length;i+=188){const p=late.bytes.subarray(i,i+188),pid=((p[1]&31)<<8)|p[2];if(pid!==8191&&(p[3]&16)&&!counters.has(pid)){assert.equal(p[3]&15,0,'fresh reader starts each PID at zero');counters.set(pid,0);}}
  // T5 program replacement retains the receiver connection and registration.
  await f.remote.api('/api/player/next',{playback_generation:s.playback_generation});
  s=await waitFor(async()=>{const s=await f.state();return s.current_item?.id!==original.id&&s.media_output.status==='streaming'&&!s.media_output.busy&&s;},'next song remains cast');
  assert.equal(s.media_output.pipeline_level,'L1');assert.equal(s.purek.output.target_room_id,connection);
  assert.equal(f.registrations,1);assert.equal(f.releases,0);assert.notEqual(f.uri,uri);
  const nextUri=f.uri;await waitFor(()=>f.media.some(m=>m.uri===nextUri),'next stream completes');
  await f.command('pause');s=await f.status('paused');
  const pausedGeneration=s.media_output.stream_generation,pausedUri=f.uri;
  const pausedActions=f.actions.filter(a=>['Stop','SetAVTransportURI','Play'].includes(a));
  await f.remote.api('/api/player/audio-variant',{item_id:s.current_item.id,expected_item_incarnation_id:s.current_item.item_incarnation_id,variant_id:'instrumental'});
  await delay(250);s=await f.state();
  assert.equal(s.media_output.status,'paused');assert.equal(s.media_output.pipeline_level,'L1');
  assert.equal(s.media_output.stream_generation,pausedGeneration);assert.equal(f.uri,pausedUri);
  assert.equal(s.current_item.selected_audio_variant_id,'instrumental');
  assert.deepEqual(f.actions.filter(a=>['Stop','SetAVTransportURI','Play'].includes(a)),pausedActions,'paused track edit must stay paused');
  await f.client.api('/api/player/output',{target:'local'});
  s=await waitFor(async()=>{const s=await f.state();return s.media_output.target==='local'&&!s.media_output.busy&&s;},'suspend L1');
  assert.equal(s.cast.connected,true);assert.equal(f.releases,0);
  assert.equal(s.media_output.pipeline_level,null);
  assert.equal((await transfer(uri)).status,404,'retired T4 generation');
  await f.disconnect();assert.equal(f.releases,1);
  process.stdout.write('purek-node-receiver-ok\n');
}finally{await f.close();}
