import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';


const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = path.join(root, '.tmp');
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, CARGO_BUILD_JOBS: '8', TEMP: scratch, TMP: scratch, TMPDIR: scratch };
function cargo(args) {
  const result = spawnSync('cargo', args, { cwd: root, env, encoding: 'utf8', timeout: 240_000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const build = cargo(['build', '--manifest-path', 'xtask/Cargo.toml', '--locked', '--target', 'host-tuple', '--message-format=json']);
const executable = build.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  .find(record => record.reason === 'compiler-artifact' && record.target.name === 'bilikara-xtask' && record.executable)?.executable;
assert.ok(executable, 'Cargo must identify the current host-native xtask executable');

test('vendored DSP files retain exact pinned upstream bytes on every host', () => {
  const directory = path.join(root, 'media-libav/signalsmith');
  const manifest = JSON.parse(readFileSync(path.join(directory, 'sources.json'), 'utf8'));
  assert.equal(manifest.files.length, 22);
  for (const file of manifest.files) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(directory, file.path))).digest('hex'),
      file.sha256, `Preserve pinned upstream bytes (including LF checkout): ${file.path}`);
  }
});

test('Android ELF, source integrity, output ownership and source-kit behavior', () => {
  const result = cargo(['test', '--manifest-path', 'xtask/Cargo.toml', '--locked', '--target', 'host-tuple', 'android_libav::tests']);
  assert.match(result, /0 failed/);
});

test('real CLI preserves argument boundaries, stable C cache identity and failure isolation', () => {
  const directory = mkdtempSync(path.join(scratch, 'android media 中文 & $()-'));
  try {
    const ndk = path.join(directory, 'selected NDK');
    const host = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
    assert.ok(host, 'supported native test host');
    const bin = path.join(ndk, 'toolchains/llvm/prebuilt', `${host}-x86_64`, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(ndk, 'source.properties'), 'Pkg.Revision = 27.0.12077973\n');
    // A native executable that accepts --version; never a shell or recording
    // script. This tests CLI/cache identity, not NDK code generation.
    for (const tool of ['clang', 'clang++', 'llvm-strip', 'llvm-readelf']) {
      copyFileSync(process.execPath, path.join(bin, tool + (process.platform === 'win32' ? '.exe' : '')));
    }
    const out = path.join(directory, 'output');
    const cache = path.join(directory, 'cache');
    const source = path.join(directory, 'source');
    mkdirSync(source);
    for (const name of ['ffmpeg-9.0.1.tar.xz', 'ffmpeg-9.0.1.tar.xz.asc', 'ffmpeg-devel.asc']) {
      writeFileSync(path.join(source, name), 'intentionally invalid source fixture');
    }
    const base = ['android-libav', '--ndk', ndk, '--abi', 'arm64-v8a', '--out', out, '--cache', cache];
    const run = (extra, args = base) => spawnSync(executable, [...args, ...extra], {
      cwd: directory, env, encoding: 'utf8', timeout: 30_000,
    });
    const first = run(['--cache-key']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^key=android-libav-v1-arm64-v8a-[a-f0-9]{64}\r?\n$/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(cache), false);
    assert.equal(run(['--cache-key', '--with-signalsmith']).stdout, first.stdout, 'downstream switch must not rotate C cache');
    const other = [...base]; other[4] = 'x86_64';
    assert.notEqual(run(['--cache-key'], other).stdout, first.stdout);
    const overlap = [...base]; overlap[6] = cache;
    const rejected = run(['--cache-key'], overlap);
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /overlap/);
    const bad = run(['--source-dir', source]);
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Pinned FFmpeg source digest mismatch/);
    assert.equal(existsSync(out), false, 'failed preparation must not publish output');
    assert.deepEqual(readdirSync(cache), [], 'failed source verification must not create a completed cache');
    mkdirSync(out); writeFileSync(path.join(out, 'unrelated.txt'), 'preserve');
    assert.notEqual(run(['--source-dir', source]).status, 0);
    assert.equal(readFileSync(path.join(out, 'unrelated.txt'), 'utf8'), 'preserve');
    writeFileSync(path.join(ndk, 'source.properties'), 'Pkg.Revision = 28.0.0\n');
    const wrongNdk = run(['--cache-key']);
    assert.notEqual(wrongNdk.status, 0); assert.match(wrongNdk.stderr, /pinned NDK/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Gradle packages only verified JNI/assets and leaves source kit beside the APK', () => {
  const build = readFileSync(path.join(root, 'src-tauri/gen/android/app/build.gradle.kts'), 'utf8');
  const media = readFileSync(path.join(root, 'src-tauri/gen/android/app/media.gradle.kts'), 'utf8');
  assert.match(build, /apply\(from = "media\.gradle\.kts"\)/);
  assert.match(media, /packaging\.jniLibs\.useLegacyPackaging = true/);
  assert.match(media, /packaging\.jniLibs\.keepDebugSymbols \+= "\*\*\/libc\+\+_shared\.so"/);
  assert.match(media, /ndkVersion = "27\.0\.12077973"/);
  assert.match(media, /jniLibs\.srcDir\(mediaOutput\.map \{ it\.dir\("\$abi\/jniLibs"\)/);
  assert.match(media, /assets\.srcDir\(mediaOutput\.map \{ it\.dir\("\$abi\/assets"\)/);
  assert.doesNotMatch(media, /srcDir[^\n]*sources/);
  assert.match(media, /endsWith\("JniLibFolders"\)/);
  assert.match(media, /endsWith\("Assets"\)/);
  assert.match(media, /dependsOn\(prepareMedia\)/);
  assert.match(media, /"--target", "host-tuple"/);
  assert.match(media, /BILIKARA_ANDROID_LIBAV_CACHE/);
  assert.match(media, /BILIKARA_LIBAV_SOURCE_DIR/);
  assert.match(media, /@get:Inject abstract val execOperations: ExecOperations/);
  assert.match(media, /mediaProcesses\.execOperations\.exec/);
  assert.doesNotMatch(media, /project\.exec/);
  assert.match(build, /targetSdk = 36/);
});

test('real Android libraries contain no build-machine paths or username', {
  skip: !process.env.BILIKARA_TEST_ANDROID_LIBAV_DIR && 'Set BILIKARA_TEST_ANDROID_LIBAV_DIR to real NDK-built jniLibs/<abi> to qualify binary strings',
}, () => {
  const directory = process.env.BILIKARA_TEST_ANDROID_LIBAV_DIR;
  const names = ['libavcodec.so', 'libavformat.so', 'libavutil.so', 'libswresample.so', 'libbilikara_media_libav.so', 'libc++_shared.so'];
  assert.deepEqual(readdirSync(directory).sort(), [...names].sort());
  const user = userInfo().username.toLowerCase();
  for (const name of names) {
    const bytes = readFileSync(path.join(directory, name));
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', name);
    // Scan printable strings rather than interpreting arbitrary binary bytes as UTF-8.
    const strings = bytes.toString('latin1').match(/[\x20-\x7e]{4,}/g).join('\n').toLowerCase();
    for (const marker of ['/users/', '\\users\\', '/home/', '.android-libav-build-', '.android-libav-output-',
      root.toLowerCase(), root.toLowerCase().replaceAll('\\', '/')]) {
      assert.ok(!strings.includes(marker), `${name} contains a build path marker: ${marker}`);
    }
    for (const home of [`/home/${user}/`, `/users/${user}/`, `\\users\\${user}\\`]) {
      assert.ok(!strings.includes(home), `${name} contains the build user's home path`);
    }
    if (name !== 'libc++_shared.so') assert.ok(strings.includes('--prefix=/bilikara-android-libav'), `${name} lacks fixed FFmpeg prefix`);
  }
});
