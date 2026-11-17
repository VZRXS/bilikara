// Required actual NDK/FFmpeg artifacts; foreign ELF is inspected, not executed
// on the host. Android runtime qualification belongs to device tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {userInfo} from 'node:os';
import './android_media_check.test.mjs';
import './android_libav_contract.test.mjs';
import {verifyPrivacy} from '../scripts/android_media_check.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildXtask,runNative,root} from './desktop_construction_support.mjs';
import {inventory} from './libav_prerequisite_support.mjs';
import {zipEntries} from './native_export_support.mjs';

test('actual Android companion, ELF closure, C cache reuse and failure preserve previous output',{timeout:1200000},async t=>{
  const ndk=process.env.BILIKARA_TEST_ANDROID_NDK,cache=process.env.BILIKARA_TEST_ANDROID_LIBAV_CACHE;
  assert.ok(ndk&&path.isAbsolute(ndk),'actual pinned NDK required');
  assert.ok(cache&&path.isAbsolute(cache),'explicit private C cache required');
  const base=realpathSync(mkdtempSync(path.join(path.join(root,'.tmp'),'bilikara-android-media 中文 & ')));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const {tool}=await buildXtask(),out=path.join(base,'media 输出');
  const common=['android-libav','--ndk',ndk,'--abi','arm64-v8a','--cache',cache,'--out',out];
  const source=process.env.BILIKARA_LIBAV_SOURCE_DIR;
  if(source)common.push('--source-dir',source);
  const run=args=>runNative(tool,args,process.env,1000000,root);
  let result=await run(common);assert.equal(result.status,0,result.stdout+result.stderr);
  const info=JSON.parse(readFileSync(path.join(out,'build-info.json'),'utf8'));
  assert.equal(info.kind,'android-libav');assert.equal(info.abi,'arm64-v8a');assert.equal(info.ndk,'27.0.12077973');
  assert.deepEqual(readdirSync(path.join(out,'jniLibs/arm64-v8a')).sort(),['libavcodec.so','libavformat.so','libavutil.so','libbilikara_media_libav.so','libc++_shared.so','libswresample.so'].sort());
  for(const [name,facts] of Object.entries(info.libraries)){assert.equal(facts.machine,'AArch64');assert.equal(facts.minimum_page_size,16384);assert.equal(facts.relro_page_size,name==='libc++_shared.so'?4096:16384);
    if(name==='libc++_shared.so')assert.match(facts.relro_alignment_exception,/pinned NDK runtime exception/);assert.equal(facts.soname,name);}
  assert.ok(info.libraries['libbilikara_media_libav.so'].imports.includes('libc++_shared.so'));
  const assets=path.join(out,'assets/bilikara-media/arm64-v8a');
  assert.match(readFileSync(path.join(assets,'licenses/Signalsmith-Stretch.txt'),'utf8'),/Permission is hereby granted/);
  assert.equal(info.signalsmith,true);
  assert.equal(existsSync(path.join(assets,'source-kit.zip')),false,'source kit must stay outside APK assets');
  const kitBytes=readFileSync(path.join(out,'sources',info.source_kit));
  assert.equal(info.source_kit_sha256,createHash('sha256').update(kitBytes).digest('hex'));
  const kit=zipEntries(kitBytes);
  const dspManifest=JSON.parse(readFileSync(path.join(root,'media-libav/signalsmith/sources.json'),'utf8'));
  assert.deepEqual(JSON.parse(kit.get('media-libav/signalsmith/sources.json').toString('utf8')),dspManifest);
  assert.equal(dspManifest.files.length,22);
  for(const file of dspManifest.files)assert.equal(createHash('sha256').update(kit.get(`media-libav/signalsmith/${file.path}`)).digest('hex'),file.sha256,file.path);
  for(const name of readdirSync(path.join(out,'jniLibs/arm64-v8a'))) verifyPrivacy(readFileSync(path.join(out,'jniLibs/arm64-v8a',name)),name,{paths:[root,base,ndk],username:userInfo().username});
  const sourceArchive=kit.get('source/ffmpeg-9.0.1.tar.xz');assert.ok(sourceArchive,'exact upstream source must ship');
  assert.equal(createHash('sha256').update(sourceArchive).digest('hex'),'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635');
  for(const name of ['media-libav/stretch.cpp','media-libav/live_audio.c','media-libav/signalsmith/LICENSE.txt',
    'media-libav/cast_mux.c','media-libav/cast_audio.c','media-libav/CAST_MUX.md',
    'xtask/src/android_libav.rs','xtask/Cargo.lock','THIRD_PARTY_NOTICES.md','REBUILD-ANDROID.md','records/config.h'])assert.ok(kit.has(name),name);
  const before=inventory(path.join(cache,info.c_cache_key));
  result=await run(common);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/C cache hit:/);
  assert.deepEqual(inventory(path.join(cache,info.c_cache_key)),before,'companion rebuilding cannot mutate upstream C cache');
  result=await run([...common,'--verify-only']);assert.equal(result.status,0,result.stdout+result.stderr);
  const previous=inventory(out);
  const bad=path.join(base,'unrelated');mkdirSync(bad);writeFileSync(path.join(bad,'user-data'),'preserve');
  result=await run(common.map(value=>value===out?bad:value));assert.notEqual(result.status,0);
  assert.equal(readFileSync(path.join(bad,'user-data'),'utf8'),'preserve');assert.deepEqual(inventory(out),previous);
  result=await run([...common,'--abi','x86_64']);assert.notEqual(result.status,0,'duplicate target cannot be silently accepted');
  const cacheLibrary=path.join(cache,info.c_cache_key,'lib/libavutil.so');
  // A separate cache copy would be needed for destructive corruption checks;
  // the supplied shared cache remains unchanged throughout this gate.
  assert.ok(readFileSync(cacheLibrary).length>100000);
  // Rebuild from the actual shipped kit in an unrelated CJK/metachar cwd,
  // without application Rust/Python. A companion-only edit must reuse C cache.
  const rebuild=path.join(base,'source-kit 源码');mkdirSync(rebuild);
  for(const [name,bytes] of kit){
    assert.ok(!path.isAbsolute(name)&&!name.split('/').some(p=>p==='..'||p===''));
    const file=path.join(rebuild,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,bytes);
  }
  const cpp=path.join(rebuild,'media-libav/stretch.cpp');writeFileSync(cpp,readFileSync(cpp,'utf8')+'\n// kit rebuild verification\n');
  const fromKit=await runNative('cargo',['run','--manifest-path',path.join(rebuild,'xtask/Cargo.toml'),'--locked','--target','host-tuple','--',
    'android-libav','--ndk',ndk,'--abi','arm64-v8a','--cache',cache,'--out',path.join(base,'rebuilt 媒体'),
    '--source-dir',path.join(rebuild,'source')],{...process.env,CARGO_TARGET_DIR:path.join(base,'cargo-target')},300000,rebuild);
  assert.equal(fromKit.status,0,fromKit.stdout+fromKit.stderr);assert.match(fromKit.stdout,/C cache hit:/);
  assert.deepEqual(inventory(path.join(cache,info.c_cache_key)),before);
});
