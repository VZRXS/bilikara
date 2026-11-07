import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('real Tauri CLI honors the pinned NDK and rejects an invalid override without selecting a newer SDK', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-ndk-selection-'));
  try {
    // CI installs the repository toolchain without a rustup default. The CLI
    // invokes Cargo from this isolated fixture, so retain that toolchain context.
    copyFileSync(new URL('../rust-toolchain.toml', import.meta.url), path.join(home, 'rust-toolchain.toml'));
    const sdk = path.join(home, 'sdk');
    const selected = path.join(sdk, 'ndk', '27.0.12077973');
    const newer = path.join(sdk, 'ndk', '30.0.16248370');
    for (const directory of [selected, newer, path.join(home, 'static'), path.join(home, 'src-tauri/src'),
      path.join(home, 'src-tauri/gen/android/app/src/main/java/com/example/fixture')]) mkdirSync(directory, {recursive: true});
    writeFileSync(path.join(home, 'static/index.html'), '<!doctype html>fixture', 'utf8');
    writeFileSync(path.join(home, 'src-tauri/src/lib.rs'), '', 'utf8');
    writeFileSync(path.join(home, 'src-tauri/Cargo.toml'),
      '[package]\nname="fixture"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="src/lib.rs"\n', 'utf8');
    writeFileSync(path.join(home, 'src-tauri/tauri.conf.json'), JSON.stringify({productName: 'fixture',
      version: '0.1.0', identifier: 'com.example.fixture', build: {frontendDist: '../static', beforeBuildCommand: ''}}), 'utf8');
    const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
    const invoke = ndk => {
      const result = spawnSync(process.execPath, [cli, 'android', 'build', '--apk', '--ci', '--target', 'aarch64'], {
        cwd: home, env: {...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, NDK_HOME: ndk, CARGO_NET_OFFLINE: 'true'},
        encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, 'fixture deliberately has no real SDK/compiler');
      return result.stdout + result.stderr;
    };
    const output = invoke(selected);
    assert.ok(output.includes(`Using installed NDK: ${selected}`), output);
    assert.ok(!output.includes(`Using installed NDK: ${newer}`), output);
    const invalid = invoke(path.join(sdk, 'ndk', 'missing'));
    assert.ok(invalid.includes('Android NDK invalid'), invalid);
    assert.ok(!invalid.includes('Using installed NDK:'), invalid);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});
