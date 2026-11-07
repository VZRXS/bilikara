// Actual shared native pipeline; synthetic receiver and control contradictions.
import assert from 'node:assert/strict';
import test,{before} from 'node:test';
import {existsSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';

let binary;
before(async()=>{binary=await buildPurekTests();},{timeout:300000});

for(const eof of [false,true])for(const dlna of [false,true])test(`${dlna?'DLNA':'Pure K'} ${eof?'sender EOF settles once despite stale PLAYING [PUREK-P1-B]':'advancing delivery reconciles contradictory transport [PUREK-P1-A]'}`,{timeout:240000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion));
  const home=ownedDirectory('receiver monitor');t.after(()=>rmSync(home,{recursive:true,force:true}));
  const env=isolatedEnvironment(home);
  Object.assign(env,{BILIKARA_TEST_LIBAV_COMPANION:companion,BILIKARA_LIBAV_COMPANION:companion,
    BILIKARA_TEST_PUREK_L1:'1',BILIKARA_TEST_PUREK_MONITOR:'1',BILIKARA_TEST_PUREK_HOME:path.join(home,'data'),
    BILIKARA_TEST_PUREK_DLNA:dlna?'1':'0',BILIKARA_TEST_NODE:process.execPath});
  if(eof)env.BILIKARA_TEST_PUREK_EOF='1';
  mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,180000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/1 passed; 0 failed/);
});
