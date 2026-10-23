// These are argument/entry fixtures, not an Apple SDK or signing qualification.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {iosInvocation} from '../scripts/ios.mjs';

const apple = {iphoneos: "/fixture/SDK 真机 '$(literal)'", iphonesimulator: '/fixture/Simulator SDK'};
test('iOS development retains a packaged origin and forwards locked Cargo arguments through Xcode', () => {
  const args = ['--open', '--', '--locked', '--offline'];
  const env = {RUSTUP_TOOLCHAIN: '1.97.0', BINDGEN_EXTRA_CLANG_ARGS: '-DUSER_FLAG=1'};
  const call = iosInvocation('dev', args, apple, env);
  const separator = call.args.indexOf('--');
  assert.ok(call.args.slice(0, separator).includes('--no-dev-server'));
  assert.ok(call.args.slice(separator + 1).includes('--offline'));
  assert.equal(call.args.filter(arg => arg === '--locked').length, 1);
  assert.equal(call.env.RUSTUP_TOOLCHAIN, '1.97.0');
  assert.ok(call.env['BINDGEN_EXTRA_CLANG_ARGS_aarch64-apple-ios'].startsWith('-DUSER_FLAG=1 -isysroot '));
  assert.deepEqual(args, ['--open', '--', '--locked', '--offline']);
  assert.deepEqual(env, {RUSTUP_TOOLCHAIN: '1.97.0', BINDGEN_EXTRA_CLANG_ARGS: '-DUSER_FLAG=1'});
});

test('real Cargo accepts forwarded SDK configuration without shell evaluation or dependency resolution', () => {
  const call = iosInvocation('build', ['--debug', '--no-sign', '--target', 'aarch64-sim'], apple, {});
  assert.ok(!call.args.includes('--no-dev-server'));
  const cargoArgs = call.args.slice(call.args.indexOf('--') + 1);
  const result = spawnSync('cargo', ['metadata', '--manifest-path', 'rust/Cargo.toml', '--format-version', '1', '--no-deps', '--offline', ...cargoArgs],
    {cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).packages[0].name, 'bilikara_rust');
  assert.notEqual(call.env['BINDGEN_EXTRA_CLANG_ARGS_aarch64-apple-ios'], call.env['BINDGEN_EXTRA_CLANG_ARGS_aarch64-apple-ios-sim']);
});

test('initialization does not receive build flags; non-Apple hosts fail before invoking Tauri', () => {
  assert.equal(iosInvocation('init', ['--ci'], apple, {}).args.includes('--locked'), false);
  assert.throws(() => iosInvocation('init', ['--', '--locked'], apple, {}));
  if (process.platform === 'darwin') return;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ios.mjs', import.meta.url)), 'doctor'],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require macOS with Xcode/);
});
