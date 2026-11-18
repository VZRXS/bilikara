// Required real native pipelines. FFmpeg only constructs independent fixtures;
// application output still runs through the native DSP, AAC and TS companion.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

// Decode only in the outer test process. The isolated Host and its receiver
// retain their executable-denying PATH and cannot depend on a media CLI.
async function verifyCastAudio(directory){
  const ts=path.join(directory,'captured.ts'),pcm=path.join(directory,'captured.f32');
  const decoded=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFMPEG||'ffmpeg',[
    '-hide_banner','-loglevel','error','-y','-i',ts,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le',pcm,
  ],process.env,30000);
  assert.equal(decoded.status,0,decoded.stderr);
  const samples=readFileSync(pcm);
  function tone(start,end){
    const first=Math.round(start*48000),last=Math.round(end*48000);
    assert.ok(samples.length>=last*4,'actual decoded tail');
    let crossings=0,power=0;
    for(let i=first;i<last;i++){
      const value=samples.readFloatLE(i*4);assert.ok(Number.isFinite(value));
      power+=value*value;
      if(i>first&&samples.readFloatLE((i-1)*4)<=0&&value>0)crossings++;
    }
    return {frequency:crossings/(end-start),rms:Math.sqrt(power/(last-first))};
  }
  // Sample after the live producer's bounded lead and the edit sequence, so
  // these windows measure the stable opening and final DSP states.
  const before=tone(0.7,1.2),after=tone(8.0,8.5);
  assert.ok(Math.abs(before.frequency-440)<4,`original 440Hz tone: ${JSON.stringify(before)}`);
  assert.ok(Math.abs(after.frequency-660*2**(2/12))<4,`FLAC track with +2 semitones: ${JSON.stringify(after)}`);
  assert.ok(Math.abs(after.rms/before.rms-0.35)<0.035,`live 35% gain: ${after.rms/before.rms}`);
}

async function makeVideo(home,name,frames){
  const output=path.join(home,name);
  const fixture=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFMPEG||'ffmpeg',[
    '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:r=24000/1001',
    '-frames:v',String(frames),'-c:v','libx264','-preset','ultrafast','-g','24','-keyint_min','24','-sc_threshold','0','-pix_fmt','yuv420p',
    '-movflags','+faststart',output,
  ],process.env,30000);
  assert.equal(fixture.status,0,fixture.stderr);
  return output;
}

test('vendored native DSP matches the pinned upstream blobs and ships both licenses',()=>{
  const base=path.join(root,'media-libav/signalsmith');
  const manifest=JSON.parse(readFileSync(path.join(base,'sources.json'),'utf8'));
  assert.equal(manifest.schema_version,1);assert.equal(manifest.files.length,22);
  const revisions=new Map([
    ['Signalsmith-Audio/signalsmith-stretch','57b93f4e9206a089a45387eaa39bdc9f310d3308'],
    ['Signalsmith-Audio/linear','7bb1c8f36794d6980080ce817c91f8da8fe56a66'],
  ]);
  const names=new Set();
  for(const file of manifest.files){
    assert.match(file.path,/^[\w./-]+$/);assert.ok(!file.path.split('/').includes('..'));
    assert.ok(!path.isAbsolute(file.path));assert.ok(!names.has(file.path));names.add(file.path);
    assert.ok(revisions.has(file.repository));
    assert.equal(file.revision,revisions.get(file.repository));
    const bytes=readFileSync(path.join(base,file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),file.git_blob,file.path);
  }
  for(const license of ['LICENSE.txt','signalsmith-linear/LICENSE.txt']){
    assert.ok(names.has(license));assert.match(readFileSync(path.join(base,license),'utf8'),/Permission is hereby granted/);
  }
});

test('P2 native Signalsmith, AAC/FLAC L1, independent TS and live Host edits',{timeout:240000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion),'actual L1 companion is required');
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-l1-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=await buildPurekTests(),env=isolatedEnvironment(home);
  env.BILIKARA_TEST_LIBAV_COMPANION=companion;env.BILIKARA_LIBAV_COMPANION=companion;
  env.BILIKARA_TEST_L1_OUTPUT=path.join(home,'ts');
  for(const name of [
    'experimental_libav::live_audio::native::real_signalsmith_pitch_and_impulse_verify_frequency_and_latency_compensation',
    'experimental_libav::live_audio::tests::real_l1_tracks_offsets_pitch_gain_and_resampling_keep_one_ts_clock',
    'experimental_libav::live_audio::events::tests::real_l1_seek_reports_actual_source_and_preserves_ts_bytes',
  ]){
    const result=await runNative(binary,['--exact',name,'--ignored','--nocapture'],env,30000,root);
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
  }
  for(const name of ['splice','gradual'])inspectTs(readFileSync(path.join(env.BILIKARA_TEST_L1_OUTPUT,name+'.ts')),{channels:2,sampleRate:48000});
  // P6 retains standalone L1 HLS instead of the retired receiver transport.
  // A one-second GOP keeps startup inside its six-segment window; the former
  // all-IDR fixture made a segment per frame and evicted the first two seconds.
  // Still require all 144 video frames and the same complete TS/audio checks.
  env.BILIKARA_TEST_PUREK_VIDEO=await makeVideo(home,'l1-video.mp4',144);
  env.BILIKARA_TEST_PUREK_L1='1';env.BILIKARA_TEST_PUREK_HOME=path.join(home,'data');mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  env.BILIKARA_TEST_NODE=process.execPath;env.BILIKARA_CF_API_URL='';env.BILIKARA_CATALOG_SHEETS_URL='';
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,90000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
  // P8 additionally routes the same real L1 fixture and edit contract through
  // T4. Keep the independent standalone invocation and every assertion above.
  // Use a longer live fixture to leave steady output after the edits, even
  // when HTTP round trips and the producer's lead put them late in the stream.
  env.BILIKARA_TEST_PUREK_VIDEO=await makeVideo(home,'cast-l1-video.mp4',240);
  for(const [key,name,frequency,codec] of [
    ['BILIKARA_TEST_PUREK_AUDIO','tone.m4a',440,['-c:a','aac']],
    ['BILIKARA_TEST_PUREK_SECOND_AUDIO','second.mp4',660,['-c:a','flac','-strict','-2']],
  ]){
    env[key]=path.join(home,name);
    const audio=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFMPEG||'ffmpeg',[
      '-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=10.1`,
      '-ac','2',...codec,env[key],
    ],process.env,30000);
    assert.equal(audio.status,0,audio.stderr);
  }
  env.BILIKARA_TEST_L1_T4='1';
  env.BILIKARA_TEST_PUREK_HOME=path.join(home,'cast-data');mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  const cast=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,90000,root);
  assert.equal(cast.status,0,cast.stdout+cast.stderr);assert.match(cast.stdout,/1 passed; 0 failed; 0 ignored/);
  await verifyCastAudio(env.BILIKARA_TEST_PUREK_HOME);
});

test('L1 rejects actual decoded PCM timestamp holes instead of concealing them',{timeout:240000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion));
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-l1-gap-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
  for(const [fixture,output,encoding] of [
    ['video-reordered-start.mp4',video,['-c','copy']],
    ['audio.m4a',audio,['-af','asetpts=N/SR/TB+floor(N/12000)*0.02/TB','-c:a','aac','-ar','48000']],
  ]){
    const result=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',fixture),'-t','3',...encoding,'-movflags','+faststart',output],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
  // Independent FFmpeg decoding proves this is a real sample-clock gap, not
  // a mocked error result or a malformed/unsupported container.
  const facts=await runNative(process.env.BILIKARA_TEST_FIXTURE_FFPROBE||'ffprobe',['-v','error','-select_streams','a:0','-show_frames','-show_streams','-show_entries','stream=time_base,sample_rate:frame=best_effort_timestamp,nb_samples','-of','json',audio],process.env,30000);
  assert.equal(facts.status,0,facts.stderr);
  const {frames,streams}=JSON.parse(facts.stdout);assert.equal(streams[0].time_base,'1/48000');assert.equal(streams[0].sample_rate,'48000');
  assert.ok(frames.some((f,i)=>i>0&&Number(f.best_effort_timestamp)-Number(frames[i-1].best_effort_timestamp)-frames[i-1].nb_samples>48),'the fixture must contain a decoded timestamp hole greater than quantization');
  const binary=await buildPurekTests(),env=isolatedEnvironment(home);
  env.BILIKARA_TEST_LIBAV_COMPANION=companion;env.BILIKARA_TEST_L1_GAP_VIDEO=video;env.BILIKARA_TEST_L1_GAP_AUDIO=audio;
  const result=await runNative(binary,['--exact','experimental_libav::live_audio::tests::real_l1_rejects_pcm_timestamp_holes','--ignored','--nocapture'],env,30000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
});
