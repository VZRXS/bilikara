// Required real native artifacts. No CLI, browser DSP or semantic stand-in.
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
  ]){
    const result=await runNative(binary,['--exact',name,'--ignored','--nocapture'],env,30000,root);
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
  }
  for(const name of ['splice','gradual'])inspectTs(readFileSync(path.join(env.BILIKARA_TEST_L1_OUTPUT,name+'.ts')),{channels:2,sampleRate:48000});
  env.BILIKARA_TEST_PUREK_L1='1';env.BILIKARA_TEST_PUREK_HOME=path.join(home,'data');mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  env.BILIKARA_TEST_NODE=process.execPath;env.BILIKARA_CF_API_URL='';env.BILIKARA_CATALOG_SHEETS_URL='';
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,90000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
});
