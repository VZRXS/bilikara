import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { castSamplesIncluded, checkMedia, mediaLibraries, ndkRuntimeSha256, sampleHash, verifyElf, verifyLicenses, verifyPrivacy, verifySample, zipReader } from '../scripts/android_media_check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(root, '.tmp');
function temporary(t) {
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(path.join(scratch, 'android-package-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Independent minimal ZIP writer: exercise both APK storage methods, central
// directory offsets, CRC validation and archive-controlled names without tools.
function zip(files, method = 8) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, payload] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(payload);
    const encoded = method === 0 ? bytes : deflateRawSync(bytes);
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(encoded.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(encoded.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, encoded); central.push(entry, filename);
    offset += header.length + filename.length + encoded.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const identity = abi => ({ ndk: '27.0.12077973', sha256: ndkRuntimeSha256[abi] });
const elf = name => `ELF Header:
  Machine: AArch64
Program Headers:
  LOAD 0x000000 0x000000 0x000000 0x010000 0x010000 R E 0x4000
  LOAD 0x010000 0x014000 0x014000 0x002000 0x004000 RW 0x4000
  GNU_RELRO 0x010000 0x014000 0x014000 0x002000 0x004000 R 0x1
Dynamic section:
  0x000000000000000e (SONAME) Library soname: [${name}]
  0x0000000000000001 (NEEDED) Shared library: [libavcodec.so]
  0x0000000000000001 (NEEDED) Shared library: [libc.so]
`;

test('all six ELF reports require 16 KiB LOAD/RELRO, exact SONAME and closed NEEDED', () => {
  for (const name of mediaLibraries) {
    const good = elf(name).replace('Shared library: [libavcodec.so]', 'Shared library: [libc++_shared.so]');
    assert.equal(verifyElf(good, name, 'arm64-v8a', identity('arm64-v8a')).minimumPageSize, 16384);
    assert.equal(verifyElf(good.replace('Machine: AArch64', 'Machine:                           AArch64'), name, 'arm64-v8a', identity('arm64-v8a')).soname, name);
    assert.equal(verifyElf(good.replace('Machine: AArch64', 'Machine: Advanced Micro Devices X86-64'), name, 'x86_64', identity('x86_64')).soname, name);
    for (const [bad, error] of [
      [good.replaceAll('0x4000', '0x1000'), /LOAD alignment/],
      [good.replace('0x014000 0x014000 0x002000 0x004000 RW', '0x015000 0x014000 0x002000 0x004000 RW'), /LOAD alignment/],
      [good.replace('0x004000 R 0x1', '0x003000 R 0x1'), /RELRO end|isolated LOAD tail/],
      [good.replace('GNU_RELRO', 'IGNORED'), /missing LOAD\/GNU_RELRO/],
      [good.replace(`soname: [${name}]`, `soname: [${name}.1]`), /SONAME/],
      [good + `  0 (SONAME) Library soname: [${name}]\n`, /SONAME/],
      [good.replace('Shared library: [libc.so]', 'Shared library: [libssl.so]'), /undeclared NEEDED/],
      [good.replace('Shared library: [libc.so]', 'Shared library: [/build/libc.so]'), /undeclared NEEDED/],
      [good.replace('Machine: AArch64', 'Machine: ARM'), /machine mismatch/],
      [good + '  0 (RUNPATH) Library runpath: [/build]\n', /loader path/],
      [good.replace('0x004000 R 0x1', '0xffffffffffffffff R 0x1'), /overflow/],
    ]) assert.throws(() => verifyElf(bad, name, 'arm64-v8a', identity('arm64-v8a')), error, name);
  }
});

test('binary privacy checks actual bytes, fixed prefix, home/build paths and username', () => {
  const bytes = extra => Buffer.from(`\x7fELF\0--prefix=/bilikara-android-libav\0${extra}`, 'latin1');
  verifyPrivacy(bytes('safe'), 'libavcodec.so');
  verifyPrivacy(Buffer.from('\x7fELF\0NDK runtime'), 'libc++_shared.so');
  assert.throws(() => verifyPrivacy(Buffer.from('\x7fELF\0/home/builder/ndk'), 'libc++_shared.so'), /build-machine/);
  verifyPrivacy(bytes('/tmp/%sXXXXXX\0'), 'libavutil.so');
  for (const marker of ['/home/runner/work/repo', 'C:\\Users\\builder\\repo', '/Users/builder/repo', '/root/repo',
    '/tmp/build', '/tmp/%sXXXXXX/private/path', '.android-libav-output-123', '/opt/build/repo', '/home/unique-builder/']) {
    assert.throws(() => verifyPrivacy(bytes(marker), 'libavcodec.so', { paths: ['/opt/build/repo'], username: 'unique-builder' }), /build-machine/);
  }
  assert.throws(() => verifyPrivacy(Buffer.from('\x7fELF bad prefix'), 'libavcodec.so'), /fixed FFmpeg prefix/);
  assert.throws(() => verifyPrivacy(Buffer.from('not ELF'), 'libavcodec.so'), /ELF magic/);
});

test('usernames match home-path segments, never ordinary library strings', () => {
  const bytes = value => Buffer.from(`\x7fELF\0--prefix=/bilikara-android-libav\0${value}\0`, 'latin1');
  for (const username of ['root', 'user', 'build', 'dev', 'ci', 'runner', 'unique-builder']) {
    verifyPrivacy(bytes(`root user build dev ci runner unique-builder /dev/urandom ${username}`), 'libavutil.so', { username });
    for (const value of [`/home/${username}/work`, `/Users/${username}/work`, `C:\\Users\\${username}\\work`]) {
      assert.throws(() => verifyPrivacy(bytes(value), 'libavutil.so', { username }), /build-machine/);
    }
  }
});

test('privacy detects MSYS/Cygwin/WSL paths and macOS/hosted toolchain paths', () => {
  const bytes = value => Buffer.from(`\x7fELF\0--prefix=/bilikara-android-libav\0${value}\0`, 'latin1');
  for (const value of ['/c/Users/runner/work', '/cygdrive/d/repo/target', '/var/folders/ab/build',
    '/private/var/folders/ab/build', '/opt/hostedtoolcache/ndk/lib', '/mnt/d/repo/target']) {
    assert.throws(() => verifyPrivacy(bytes(value), 'libavutil.so'), /build-machine/, value);
  }
  for (const value of ['D:\\bilikara\\ws\\target', 'd:/bilikara/ws/target', '/d/bilikara/ws/target',
    '/cygdrive/d/bilikara/ws/target', '/mnt/d/bilikara/ws/target', '/d/bilikara/ws']) {
    assert.throws(() => verifyPrivacy(bytes(value), 'libavutil.so', { paths: ['D:\\bilikara\\ws'] }), /build-machine/, value);
  }
  for (const value of ['/d/bilikara/ws-other/target', 'D:/bilikara/ws_other/target']) {
    verifyPrivacy(bytes(value), 'libavutil.so', { paths: ['D:\\bilikara\\ws'] });
  }
});

test('APK ZIP reader verifies compressed/stored payloads and rejects corruption/unsafe names', () => {
  for (const method of [0, 8]) {
    const bytes = zip({ 'lib/arm64-v8a/libavcodec.so': 'ELF fixture', 'assets/license': 'license' }, method);
    const reader = zipReader(bytes);
    assert.equal(reader.read('assets/license').toString(), 'license');
    assert.equal(reader.read(reader.names[0]).toString(), 'ELF fixture');
    assert.throws(() => reader.read('absent'), /missing ZIP payload/);
    const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(0, corrupt.indexOf(Buffer.from('PK\x01\x02')) + 16);
    assert.throws(() => zipReader(corrupt).read(reader.names[0]), /CRC mismatch/);
  }
  for (const name of ['../escape', '/absolute', 'C:/drive', 'back\\slash']) assert.throws(() => zipReader(zip({ [name]: 'bad' })), /Unsafe/);
  const duplicate = zip({ one: 'a', two: 'b' });
  let offset = -1;
  while ((offset = duplicate.indexOf('two', offset + 1)) !== -1) duplicate.write('one', offset);
  assert.throws(() => zipReader(duplicate), /duplicate/);
  assert.throws(() => zipReader(Buffer.from('not ZIP')), /end record/);
});

test('APK sample B is required by default; the exact A4 Gradle property permits opt-out', () => {
  const absent = zipReader(zip({ 'assets/other': 'x' }));
  assert.equal(castSamplesIncluded(), true);
  assert.equal(castSamplesIncluded('bilikara.includeCastSamples=true'), true);
  assert.equal(castSamplesIncluded('bilikara.includeCastSamples=false'), false);
  for (const property of ['includeCastSamples=false', 'bilikara.includeCastSample=false', 'bilikara.includeCastSamples=FALSE', 'bilikara.includeCastSamples=']) {
    assert.throws(() => castSamplesIncluded(property), /Expected Gradle property/);
  }
  assert.throws(() => verifySample(absent), /Required sample B asset is missing/);
  assert.match(verifySample(absent, castSamplesIncluded('bilikara.includeCastSamples=false')), /absent/);
  const sample = readFileSync(path.join(root, 'resources/cast-samples/sample-b.ts'));
  assert.match(verifySample(zipReader(zip({ 'assets/cast-samples/sample-b.ts': sample }))), new RegExp(sampleHash));
  assert.throws(() => verifySample(zipReader(zip({ 'assets/cast/sample-b.ts': 'corrupt' }))), /SHA-256 mismatch/);
  assert.throws(() => verifySample(zipReader(zip({ 'assets/cast/sample-b.ts': 'corrupt' })), false), /SHA-256 mismatch/);
  assert.throws(() => verifySample(zipReader(zip({ 'assets/a/sample-b.ts': 'a', 'assets/b/sample-b.ts': 'b' }))), /Duplicate/);
  const runtime = readFileSync(path.join(root, 'rust-runtime/src/native_host/cast_session/self_test/samples.rs'), 'utf8');
  assert.match(runtime, /8624fbee0c7f4653e6f1c7c2f7a6de9aca5d2b3a3a729a218d7f740b9417aef3/);
});

test('licenses, pinned source notices and rebuild materials reject missing or corrupt corresponding source', t => {
  const directory = temporary(t);
  const base = 'assets/bilikara-media/arm64-v8a/';
  const files = {
    [base + 'licenses/libav/COPYING.LGPLv2.1']: 'LGPL', [base + 'licenses/libav/LICENSE.md']: 'License',
    [base + 'licenses/THIRD_PARTY_NOTICES.md']: 'Notices',
    [base + 'licenses/Signalsmith-Stretch.txt']: 'MIT', [base + 'licenses/Signalsmith-Linear.txt']: 'MIT',
    [base + 'licenses/Android-NDK-NOTICE.txt']: 'NDK',
    [base + 'build-info.json']: JSON.stringify({ schema_version: 1, ndk: '27.0.12077973', signalsmith: true, abi: 'arm64-v8a', ffmpeg: '9.0.1', source_kit: 'bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip' }),
    [base + 'licenses/libav-source.txt']: 'FFmpeg 9.0.1 LGPL-2.1 Source SHA-256: Signing fingerprint: Configuration:',
  };
  assert.throws(() => verifyLicenses(zipReader(zip(files)), 'arm64-v8a', 'absent.zip'), /source-location/);
  const kit = path.join(directory, 'bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip');
  files[base + 'licenses/libav-source.txt'] = `FFmpeg 9.0.1 LGPL-2.1
Source SHA-256: cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635
Signing fingerprint: FCF986EA15E6E293A5644F10B4322F04D67658D8
Configuration: --prefix=/bilikara-android-libav
Corresponding source: ${path.basename(kit)}
Distributed separately alongside this APK`;
  const materials = Object.fromEntries(['source/ffmpeg-9.0.1.tar.xz', 'source/ffmpeg-9.0.1.tar.xz.asc', 'source/ffmpeg-devel.asc',
    'licenses/COPYING.LGPLv2.1', 'records/config.h', 'media-libav/probe.c', 'xtask/src/android_libav.rs',
    'xtask/Cargo.toml', 'xtask/Cargo.lock', 'rust-toolchain.toml', 'REBUILD-ANDROID.md',
    'media-libav/stretch.cpp', 'media-libav/live_audio.c', 'media-libav/live_ts.c',
    'media-libav/signalsmith/LICENSE.txt', 'media-libav/signalsmith/signalsmith-linear/LICENSE.txt'].map(name => [name, 'corrupt source fixture']));
  writeFileSync(kit, zip(materials));
  files[base + 'build-info.json'] = JSON.stringify({...JSON.parse(files[base + 'build-info.json']), source_kit_sha256:createHash('sha256').update(readFileSync(kit)).digest('hex')});
  assert.throws(() => verifyLicenses(zipReader(zip(files)), 'arm64-v8a', kit), /archive SHA-256 mismatch/);
  delete materials['REBUILD-ANDROID.md'];
  writeFileSync(kit, zip(materials));
  files[base + 'build-info.json'] = JSON.stringify({...JSON.parse(files[base + 'build-info.json']), source_kit_sha256:createHash('sha256').update(readFileSync(kit)).digest('hex')});
  assert.throws(() => verifyLicenses(zipReader(zip(files)), 'arm64-v8a', kit), /missing ZIP payload/);
  files['assets/source-kit.zip'] = 'source must not be in APK';
  assert.throws(() => verifyLicenses(zipReader(zip(files)), 'arm64-v8a', kit), /separately from APK/);
  delete files['assets/source-kit.zip'];
  delete files[base + 'licenses/libav/LICENSE.md'];
  assert.throws(() => verifyLicenses(zipReader(zip(files)), 'arm64-v8a', 'absent.zip'), /missing ZIP payload/);
});

test('package gate and CLI reject missing libraries and preserve readelf failures', t => {
  const directory = temporary(t), apk = path.join(directory, 'fixture 中文 & $().apk');
  writeFileSync(apk, zip({ 'assets/other': 'x' }));
  assert.throws(() => checkMedia({ apk, sourceKit: 'absent', readelf: process.execPath, scratch: directory }), /library inventory/);
  const files = Object.fromEntries(mediaLibraries.map(name => [`lib/arm64-v8a/${name}`, '\x7fELF\0--prefix=/bilikara-android-libav']));
  writeFileSync(apk, zip(files));
  assert.throws(() => checkMedia({ apk, sourceKit: 'absent', readelf: path.join(directory, 'missing-readelf'), scratch: directory }), /ENOENT/);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/android_media_check.mjs'), '--apk', apk, '--readelf', process.execPath, '--source-kit', apk, '--scratch', directory], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /bad option|Command failed/);
});

test('real NDK readelf rejects an ELF copy with deliberately broken p_align', {
  skip: !process.env.BILIKARA_TEST_ANDROID_LIBAV_DIR && 'Set BILIKARA_TEST_ANDROID_LIBAV_DIR to qualify a real ELF mutation',
}, t => {
  const directory = temporary(t);
  const host = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  assert.ok(process.env.NDK_HOME, 'NDK_HOME is required when real libraries are requested');
  const readelf = path.join(process.env.NDK_HOME, `toolchains/llvm/prebuilt/${host}-x86_64/bin/llvm-readelf${process.platform === 'win32' ? '.exe' : ''}`);
  const name = 'libc++_shared.so';
  const bytes = readFileSync(path.join(process.env.BILIKARA_TEST_ANDROID_LIBAV_DIR, name));
  assert.equal(bytes.subarray(0, 6).toString('hex'), '7f454c460201', '64-bit little-endian ELF');
  const file = path.join(directory, name);
  const inspect = () => execFileSync(readelf, ['--wide', '--file-header', '--program-headers', '--dynamic', file], { encoding: 'utf8', timeout: 30_000 });
  writeFileSync(file, bytes);
  const runtime = { ndk: '27.0.12077973', sha256: createHash('sha256').update(bytes).digest('hex') };
  verifyPrivacy(bytes, name, {paths:[root, process.env.NDK_HOME]});
  verifyElf(inspect(), name, 'arm64-v8a', runtime);
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  assert.equal(size, 56, 'ELF64 program-header size');
  assert.ok(offset + size * count <= bytes.length);
  let changed = false;
  for (let i = 0; i < count; i++) {
    const entry = offset + i * size;
    if (bytes.readUInt32LE(entry) === 1) { // PT_LOAD.p_align in our copy only.
      bytes.writeBigUInt64LE(4096n, entry + 48);
      changed = true;
      break;
    }
  }
  assert.ok(changed, 'fixture must modify a real PT_LOAD header');
  writeFileSync(file, bytes);
  assert.throws(() => verifyElf(inspect(), name, 'arm64-v8a', runtime), /LOAD alignment/);
  assert.throws(() => verifyElf(inspect(), name, 'arm64-v8a', { ...runtime, sha256:createHash('sha256').update(bytes).digest('hex') }), /version\/SHA-256/);
});


test('only pinned NDK libc++ gets the verified isolated-RELRO exception', () => {
  const name = 'libc++_shared.so';
  const good = elf(name).replaceAll('0x004000', '0x003000');
  const check = (text, id = identity('arm64-v8a')) => verifyElf(text, name, 'arm64-v8a', id);
  assert.match(check(good).relroAlignmentException, /pinned NDK runtime exception/);
  for (const id of [{}, { ...identity('arm64-v8a'), ndk: '28.0.0' }, { ...identity('arm64-v8a'), sha256: 'tampered' }]) {
    assert.throws(() => check(good, id), /version\/SHA-256/);
  }
  assert.throws(() => check(good.replace('R E 0x4000', 'R E 0x1000')), /LOAD alignment/);
  assert.throws(() => check(good.replace('0x003000 R 0x1', '0x002000 R 0x1')), /isolated LOAD tail/);
  assert.throws(() => check(good + 'LOAD 0x013000 0x017000 0x017000 0x1000 0x1000 RW 0x4000\n'), /isolated LOAD tail/);
  for (const other of mediaLibraries.filter(value => value !== name)) {
    assert.throws(() => verifyElf(elf(other).replace('0x004000 R 0x1', '0x003000 R 0x1'), other, 'arm64-v8a', identity('arm64-v8a')), /RELRO end/);
  }
});
