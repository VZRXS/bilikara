import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
