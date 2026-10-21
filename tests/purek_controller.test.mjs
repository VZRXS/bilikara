// Required real companion and isolated native Host. No device qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';

for(const dlna of [false,true])test(`${dlna?'ordinary DLNA':'Pure K'} P3 real native controller, shared transport, rebuilds, EOF and failure hold`,{timeout:240000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion),'actual L1 companion is required');
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-controller-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=await buildPurekTests(),env=isolatedEnvironment(home);
  Object.assign(env,{BILIKARA_TEST_LIBAV_COMPANION:companion,BILIKARA_LIBAV_COMPANION:companion,
    BILIKARA_TEST_PUREK_L1:'1',BILIKARA_TEST_PUREK_CONTROLLER:'1',BILIKARA_TEST_PUREK_HOME:path.join(home,'data'),
    BILIKARA_TEST_NODE:process.execPath,BILIKARA_TEST_PUREK_DLNA:dlna?'1':'0',
    BILIKARA_TEST_PUREK_REPORT:path.join(home,'receiver-report.json'),BILIKARA_CF_API_URL:'',BILIKARA_CATALOG_SHEETS_URL:''});
  mkdirSync(env.BILIKARA_TEST_PUREK_HOME);
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],env,90000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed; 0 failed; 0 ignored/);
  const report=JSON.parse(readFileSync(env.BILIKARA_TEST_PUREK_REPORT,'utf8'));
  assert.equal(report.connection_type,dlna?'dlna':'purek');assert.equal(report.qualified,false);
  assert.ok(report.stream_bytes>0);assert.equal(report.video_frames,144);
  for(const action of ['GetProtocolInfo','Stop','SetAVTransportURI','Play','GetTransportInfo'])assert.ok(report.actions[action]>0,action);
  assert.equal(report.actions.Pause,undefined);assert.equal(report.actions.Seek,undefined);
  assert.equal(report.actions.SetDeviceAuthorization===undefined,dlna);
  assert.equal(report.empty_metadata_retry,dlna);
  if(dlna&&process.env.BILIKARA_TEST_DLNA_EVIDENCE){
    assert.ok(path.isAbsolute(process.env.BILIKARA_TEST_DLNA_EVIDENCE));
    writeFileSync(process.env.BILIKARA_TEST_DLNA_EVIDENCE,JSON.stringify(report,null,2)+'\n','utf8');
  }
});
