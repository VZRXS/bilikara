// Requires an actual built APK and its separate source kit; no foreign binary
// is executed on this host. Verification must leave signed APK bytes intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {buildXtask, runNative, root} from './desktop_construction_support.mjs';

test('final Android APK native closure, separate rebuild kit and corrupt-input rejection', {timeout: 120000}, async t => {
  const ndk = process.env.BILIKARA_TEST_ANDROID_NDK;
  const apk = process.env.BILIKARA_TEST_ANDROID_APK;
  const kit = process.env.BILIKARA_TEST_ANDROID_SOURCE_KIT;
  assert.ok(ndk && path.isAbsolute(ndk), 'pinned NDK required');
  assert.ok(apk && path.isAbsolute(apk), 'actual APK required');
  assert.ok(kit && path.isAbsolute(kit), 'separate matching source kit required');
  mkdirSync(path.join(root, '.tmp'), {recursive: true});
  const dir = mkdtempSync(path.join(root, '.tmp/bilikara APK 中文 & '));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const copy = path.join(dir, 'built app.apk');
  copyFileSync(apk, copy);
  const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  const before = hash(copy);
  const {tool} = await buildXtask();
  const run = (file, abi = 'arm64-v8a', sourceKit = kit) => runNative(tool,
    ['verify-android-apk', '--ndk', ndk, '--abi', abi, '--apk', file, '--source-kit', sourceKit],
    process.env, 60000, root);
  let result = await run(copy);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.rebuild_kit_verified, true);
  assert.equal(Object.keys(info.libraries).length, 7);
  assert.deepEqual(info.libraries['libbilikara_app.so'].imports, ['libandroid.so', 'libc.so', 'libdl.so', 'liblog.so', 'libm.so']);
  assert.match(info.libraries['libc++_shared.so'].relro_alignment_exception, /pinned NDK runtime exception/);
  assert.equal(hash(copy), before, 'verification cannot modify signed APK');
  result = await run(copy, 'x86_64');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selected ABI/);
  const corruptKit = path.join(dir, path.basename(kit));
  const damaged = Buffer.from(readFileSync(kit));
  damaged[0] ^= 1;
  writeFileSync(corruptKit, damaged);
  result = await run(copy, 'arm64-v8a', corruptKit);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source kit does not match/);
  assert.equal(hash(copy), before);
  const truncated = path.join(dir, 'truncated.apk');
  writeFileSync(truncated, readFileSync(copy).subarray(0, 1000));
  result = await run(truncated);
  assert.notEqual(result.status, 0);
  assert.equal(hash(copy), before);
});
