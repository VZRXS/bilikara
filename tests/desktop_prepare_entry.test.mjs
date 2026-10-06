import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, copyFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const command = 'cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- prepare-desktop';

test('real npm release and development entries share the independent Rust tool', () => {
  assert.equal(pkg.scripts['prepare:desktop'], command);
  assert.equal(tauri.build.beforeDevCommand.script, command);
  assert.equal(tauri.build.beforeDevCommand.wait, true);
  assert.equal(pkg.scripts.dev, 'tauri dev');
  assert.equal(pkg.scripts['dev:rust'], 'tauri dev');
  assert.equal(pkg.scripts.build, command.replace('prepare-desktop', 'build-desktop'));
  assert.equal(tauri.build.beforeBuildCommand, '');
});

for (const platform of ['android', 'ios']) {
  test(`actual ${platform} development hook does not prepare desktop resources`, () => {
    const [program, ...args] = tauri.build.beforeDevCommand.script.split(' ');
    const env = { ...process.env, TAURI_ENV_PLATFORM: platform, TAURI_ENV_DEBUG: 'false',
      BILIKARA_LIBAV_PREFIX: 'invalid-prefix-must-never-be-read', TAURI_ENV_TARGET_TRIPLE: 'invalid-desktop-target',
      CARGO_BUILD_TARGET: 'invalid-target-must-not-cross-compile-the-build-tool' };
    const result = spawnSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Native build complete/);
    assert.doesNotMatch(result.stderr, /Compiling bilikara_runtime/);
  });
}

test('actual npm release entry requires prepared inputs even in a Tauri debug/mobile environment', () => {
  const env = { ...process.env, TAURI_ENV_PLATFORM: 'android', TAURI_ENV_DEBUG: 'true',
    BILIKARA_LIBAV_PREFIX: '', CARGO_BUILD_TARGET: '', TAURI_ENV_TARGET_TRIPLE: '' };
  const program = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(program, ['run', 'build'], { cwd: root, env, encoding: 'utf8', timeout: 120_000,
    shell: process.platform === 'win32' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BILIKARA_LIBAV_PREFIX is required for a complete native bundle/);
  assert.doesNotMatch(result.stdout + result.stderr, /build_bundle\.py|embed_macos_backend\.py/);
});

test('retired Python construction and duplicate Source entries have no live caller', () => {
  for (const name of ['build_bundle.py', 'scripts/native_desktop_bundle.py', 'scripts/embed_macos_backend.py',
    'media-libav/build.py', 'scripts/libav_cache.py', 'scripts/libav_bundle.py', 'scripts/windows_libav_preview.py',
    'server.py', 'start_bilikara.py']) {
    assert.equal(existsSync(path.join(root, name)), false, name);
  }
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8');
  assert.match(workflow, /python -m compileall -q bilikara\s*\n/);
  assert.doesNotMatch(workflow, /py_compile[^\n]*(?:start_bilikara|server\.py|build_bundle)/);
  for (const [file, invocation] of [['build_windows.bat', /call npm run build/], ['build_macos.command', /npm run build/]]) {
    const wrapper = readFileSync(path.join(root, file), 'utf8');
    assert.match(wrapper, /npm ci/);
    assert.match(wrapper, invocation);
    assert.doesNotMatch(wrapper, /python|\bpy\b|\bpip\b|build_bundle/);
    assert(wrapper.indexOf('npm ci') < wrapper.indexOf('npm run build'));
  }
});

test('actual Windows batch wrapper invokes npm and stops after failed installation', {
  skip: process.platform !== 'win32' && 'Native cmd.exe/linker execution requires Windows',
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'desktop-wrapper-'));
  try {
    const kit = path.join(directory, 'checkout 中文 空');
    const bin = path.join(directory, 'native-bin');
    mkdirSync(kit); mkdirSync(bin);
    copyFileSync(path.join(root, 'build_windows.bat'), path.join(kit, 'build_windows.bat'));
    const compile = spawnSync('rustc', ['--edition=2024', '--crate-name', 'wrapper_fixture',
      path.join(root, 'tests/fixtures/desktop_prepare_cargo.rs'), '-o', path.join(bin, 'npm-fixture.exe')],
      { cwd: root, encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\n"%~dp0npm-fixture.exe" %*\r\n', 'utf8');
    const log = path.join(directory, 'commands.jsonl');
    const env = { ...process.env, XTASK_WRAPPER_LOG: log, PATH: `${bin}${path.delimiter}${process.env.SystemRoot}\\System32` };
    const run = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'build_windows.bat'],
      { cwd: kit, env, encoding: 'utf8', timeout: 30_000, input: '' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
      { cwd: realpathSync(kit), args: ['ci'] }, { cwd: realpathSync(kit), args: ['run', 'build'] },
    ]);
    rmSync(log);
    const failure = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'build_windows.bat'],
      { cwd: kit, env: { ...env, XTASK_WRAPPER_FAIL_INSTALL: '1' }, encoding: 'utf8', timeout: 30_000, input: '' });
    assert.equal(failure.status, 1);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [{ cwd: realpathSync(kit), args: ['ci'] }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual macOS shell wrapper anchors npm at its root and propagates install failure', {
  skip: process.platform === 'win32' && 'Bash wrapper is exercised on POSIX; Windows batch remains native CI coverage',
}, () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'desktop-wrapper-'));
  try {
    const kit = path.join(directory, 'checkout 中文 空 $()');
    const bin = path.join(directory, 'native-bin');
    mkdirSync(kit); mkdirSync(bin);
    const wrapper = path.join(kit, 'build_macos.command');
    const fixture = path.join(bin, 'npm');
    copyFileSync(path.join(root, 'build_macos.command'), wrapper);
    const compile = spawnSync('rustc', ['--edition=2024', '--crate-name', 'wrapper_fixture',
      path.join(root, 'tests/fixtures/desktop_prepare_cargo.rs'), '-o', fixture], { cwd: root, encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const log = path.join(directory, 'commands.jsonl');
    const env = { ...process.env, XTASK_WRAPPER_LOG: log, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    const run = spawnSync('/bin/bash', [wrapper], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [
      { cwd: realpathSync(kit), args: ['ci'] }, { cwd: realpathSync(kit), args: ['run', 'build'] },
    ]);
    rmSync(log);
    const failure = spawnSync('/bin/bash', [wrapper], { cwd: directory,
      env: { ...env, XTASK_WRAPPER_FAIL_INSTALL: '1' }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(failure.status, 7);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), [{ cwd: realpathSync(kit), args: ['ci'] }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
