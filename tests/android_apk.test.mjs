// Requires an actual built APK; no foreign binary is executed on this host.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildXtask,runNative,root} from './desktop_construction_support.mjs';
test('final Android APK native closure, rebuild kit and corrupt-input rejection',{timeout:120000},async t=>{
  const ndk=process.env.BILIKARA_TEST_ANDROID_NDK,apk=process.env.BILIKARA_TEST_ANDROID_APK;
  assert.ok(ndk&&path.isAbsolute(ndk),'pinned NDK required');assert.ok(apk&&path.isAbsolute(apk),'actual APK required');
  const dir=mkdtempSync(path.join(tmpdir(),'bilikara APK 中文 & '));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const copy=path.join(dir,'built app.apk');copyFileSync(apk,copy);
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),before=hash(copy);
  const {tool}=await buildXtask();
  const run=(file,abi='arm64-v8a')=>runNative(tool,['verify-android-apk','--ndk',ndk,'--abi',abi,'--apk',file],process.env,60000,root);
  let result=await run(copy);assert.equal(result.status,0,result.stdout+result.stderr);
  const info=JSON.parse(result.stdout);assert.equal(info.rebuild_kit_verified,true);assert.equal(Object.keys(info.libraries).length,7);
  assert.deepEqual(info.libraries['libbilikara_app.so'].imports,['libandroid.so','libc.so','libdl.so','liblog.so','libm.so']);
  assert.equal(hash(copy),before,'verification cannot modify signed APK');
  result=await run(copy,'x86_64');assert.notEqual(result.status,0);assert.match(result.stderr,/selected ABI/);
  const truncated=path.join(dir,'truncated.apk');writeFileSync(truncated,readFileSync(copy).subarray(0,1000));
  result=await run(truncated);assert.notEqual(result.status,0);assert.equal(hash(copy),before);
});
