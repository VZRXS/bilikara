import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {runNative,root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';

test('actual JVM Bilibili video whitelist [BILIBILI-EXTERNAL-LINK]',{timeout:60000},async t=>{
  const directory=ownedDirectory('Bilibili video');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const javaHome=process.env.BILIKARA_TEST_JAVA_HOME || process.env.JAVA_HOME;
  const executable=name=>javaHome?path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':'')):name;
  const source=path.join(root,'src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostBilibiliVideo.java');
  const harness=path.join(directory,'AdmissionTest.java');
  writeFileSync(harness,`package com.bilikara.app;
public class AdmissionTest {
 static void check(boolean value) {if(!value)throw new AssertionError("Bilibili video");}
 public static void main(String[] args) {
  String base="https://www.bilibili.com/video/BV1yyjzzCEQn";
  check(HostBilibiliVideo.validated(base).equals(base));
  check(HostBilibiliVideo.validated(base+"?p=2").equals(base+"?p=2"));
  for(String value:new String[]{"http://www.bilibili.com/video/BV1yyjzzCEQn", "https://www.bilibili.com:443/video/BV1yyjzzCEQn", "https://user@www.bilibili.com/video/BV1yyjzzCEQn", "https://www.bilibili.com.evil.test/video/BV1yyjzzCEQn", "javascript:alert(1)", "file:///video/BV1yyjzzCEQn", "https://account.bilibili.com/login", base+"/", base+"#x", base+"?p=0", base+"?p=-1", base+"?p=01", base+"?p=1.5", base+"?p=2147483648", base+"?p=2&p=3", base+"?redirect=x", base+"?p=2&redirect=x", base+"x".repeat(200)})check(HostBilibiliVideo.validated(value)==null);
  System.out.println("admission checks passed");
 }
}`, 'utf8');
  const env={...process.env};
  const compile=await runNative(executable('javac'),['-J-XX:-UsePerfData','-J-Djava.io.tmpdir='+directory,'-d',directory,source,harness],env,45000);
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=await runNative(executable('java'),['-XX:-UsePerfData','-Djava.io.tmpdir='+directory,'-cp',directory,'com.bilikara.app.AdmissionTest'],env,15000);
  assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/admission checks passed/);
});
