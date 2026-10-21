// Protocol compatibility uses a real native Host and companion. Receiver XML
// and TS expectations are independent of the product's parser and selector.
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';

test('legacy Pure K and ordinary DLNA capability queries cannot block an explicit real-media trial',{timeout:240000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion),'actual L1 companion is required');
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-dlna-compat-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=await buildPurekTests(),env=isolatedEnvironment(home);
  Object.assign(env,{BILIKARA_TEST_LIBAV_COMPANION:companion,BILIKARA_LIBAV_COMPANION:companion,
    BILIKARA_TEST_PUREK_L1:'1',BILIKARA_TEST_PUREK_COMPATIBILITY:'1',BILIKARA_TEST_PUREK_HOME:path.join(home,'data'),
    BILIKARA_TEST_NODE:process.execPath,BILIKARA_TEST_PUREK_REPORT:path.join(home,'report.json'),
    BILIKARA_CF_API_URL:'',BILIKARA_CATALOG_SHEETS_URL:''});
  mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,180000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const report=JSON.parse(readFileSync(env.BILIKARA_TEST_PUREK_REPORT,'utf8'));
  assert.equal(report.qualified,false);
  assert.deepEqual(report.played,['ordinary','legacy-namespace','missing-action','http-error','empty','wildcard','av-only','iso-mpeg']);
  assert.deepEqual(report.refused,['audio-only','rtsp-only','mp4-only','ac3-only','ps-only','tts-192']);
  assert.equal(report.query_failure_preserved,true);
  assert.equal(report.no_premature_streaming,true);
  assert.equal(report.rejected_uri_held,true);
});
