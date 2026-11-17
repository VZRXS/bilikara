// Actual native libav + isolated Rust Host; Node is only a MediaRenderer and
// independent TS observer. No real room addresses, identities or credentials.
import assert from 'node:assert/strict';
import test,{before} from 'node:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

const standaloneReceiver=process.argv.includes('--receiver')||process.argv.includes('--receiver-l1');
let binary;
if(!standaloneReceiver)before(async()=>{binary=await buildPurekTests();},{timeout:300000});

if(standaloneReceiver){
  if(process.argv.includes('--receiver-l1'))await import('./native_output_receiver.mjs');
  else await import('./cast_output_receiver.mjs');
}else {
test('P1 real native pipeline and isolated Node MediaRenderer',{timeout:180000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion),'actual P1 companion is required');
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-p1-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const environment=isolatedEnvironment(home);
  environment.BILIKARA_TEST_CAST_COMPANION=process.env.BILIKARA_TEST_CAST_COMPANION||companion;environment.BILIKARA_TEST_LIBAV_COMPANION=companion;environment.BILIKARA_LIBAV_COMPANION=companion;
  environment.BILIKARA_TEST_PUREK_TS=path.join(home,'live.ts');
  const pipeline=await runNative(binary,['--exact','experimental_libav::live_ts::tests::real_pipeline_copy_and_native_ts_inspection','--ignored','--nocapture'],environment,30000);
  assert.equal(pipeline.status,0,pipeline.stdout+pipeline.stderr);inspectTs(readFileSync(environment.BILIKARA_TEST_PUREK_TS));
  const data=path.join(home,'data');mkdirSync(data);
  environment.BILIKARA_TEST_PUREK_HOME=data;environment.BILIKARA_TEST_NODE=process.execPath;
  environment.BILIKARA_CF_API_URL='';environment.BILIKARA_CATALOG_SHEETS_URL='';
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],environment,90000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed/);
});

 test('R1 T4 Range, peer aliases, concurrent GETs, keyframe joins and 15-second write-stall contract',{timeout:300000},async()=>{
   const env={...process.env,BILIKARA_TEST_CAST_COMPANION:process.env.BILIKARA_TEST_CAST_COMPANION||process.env.BILIKARA_TEST_LIBAV_COMPANION};
   const result=await runNative(binary,['dlna::cast_http::','--include-ignored','--test-threads=1','--nocapture'],env,240000,root);
   assert.equal(result.status,0,result.stdout+result.stderr);
   for(const name of ['file_range_boundaries_head_and_common_headers','lan_peer_alias_is_allowed_and_mismatch_is_structured','fifth_get_closes_oldest_and_all_new_gets_return_200','live_midstream_join_uses_playback_keyframe_and_ignores_every_range','real_backpressure_pauses_three_and_ten_seconds_then_resumes','real_backpressure_disconnects_only_after_fifteen_seconds_without_progress'])assert.match(result.stdout,new RegExp(name+' \.\.\. ok'));
 });
}
