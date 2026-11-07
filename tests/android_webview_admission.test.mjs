import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {runNative,root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';

test('actual JVM OEM provider / UA / feature admission [ANDROID-OEM-ADMISSION]',{timeout:60000},async t=>{
  const directory=ownedDirectory('WebView admission');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const javaHome=process.env.BILIKARA_TEST_JAVA_HOME || process.env.JAVA_HOME;
  const executable=name=>javaHome?path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':'')):name;
  const source=path.join(root,'src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostWebViewAdmission.java');
  const harness=path.join(directory,'AdmissionTest.java');
  writeFileSync(harness,`package com.bilikara.app;
public class AdmissionTest {
 static void check(boolean value) {if(!value)throw new AssertionError("WebView admission");}
 public static void main(String[] args) {
  String provider="14.0.2.319", ua="Mozilla/5.0 Chrome/99.0.4844.88";
  check(HostWebViewAdmission.chromiumHint(ua)==99 && !provider.startsWith("99"));
  check(HostWebViewAdmission.legacy(ua,true,true,true,true,0));
  check(!HostWebViewAdmission.legacy(ua,false,true,true,true,0));
  check(!HostWebViewAdmission.legacy(ua,true,false,true,true,0));
  check(!HostWebViewAdmission.legacy(ua,true,true,false,true,0));
  check(!HostWebViewAdmission.legacy(ua,true,true,true,false,0));
  check(!HostWebViewAdmission.legacy(ua,true,true,true,true,1));
  check(!HostWebViewAdmission.legacy(ua,true,true,true,true,null));
  check(HostWebViewAdmission.chromiumHint("Custom OEM") == null);
  check(HostWebViewAdmission.legacy("Custom OEM",true,true,true,true,0));
  check(!HostWebViewAdmission.legacy("Chrome/82.0",true,true,true,true,0));
  check(HostWebViewAdmission.legacy("Chrome/83.0",true,true,true,true,0));
  check(HostWebViewAdmission.standard(true,true,0));
  check(!HostWebViewAdmission.standard(true,true,4));
  check(!HostWebViewAdmission.standard(false,true,0));
  check(!HostWebViewAdmission.standard(true,false,0));
  check(!HostWebViewAdmission.standard(true,true,null));
  System.out.println("admission checks passed");
 }
}`, 'utf8');
  const env={...process.env};
  const compile=await runNative(executable('javac'),['-J-XX:-UsePerfData','-J-Djava.io.tmpdir='+directory,'-d',directory,source,harness],env,45000);
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=await runNative(executable('java'),['-XX:-UsePerfData','-Djava.io.tmpdir='+directory,'-cp',directory,'com.bilikara.app.AdmissionTest'],env,15000);
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/admission checks passed/);
});
