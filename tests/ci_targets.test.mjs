import {desktopChecks, mobileChecks} from './ci_workflow_support.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectTargets} from '../scripts/ci_targets.mjs';
import {automaticScope} from '../scripts/ci_scope.mjs';

test('All and every supported group select exactly the declared native targets', () => {
  const expected = {
    all: ['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64', 'android-arm64', 'ios-arm64'],
    desktop: ['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64'],
    mobile: ['android-arm64', 'ios-arm64'], windows: ['windows-x64', 'windows-arm64'],
    macos: ['macos-arm64', 'macos-x64'], android: ['android-arm64'], ios: ['ios-arm64'],
  };
  for (const [target, wanted] of Object.entries(expected)) {
    const plan = selectTargets(target);
    const actual = [...plan.desktop.include.map(row => `${row.slug}-${row.arch}`),
      ...plan.mobile.include.map(row => `${row.platform.toLowerCase()}-arm64`)];
    assert.deepEqual(actual, wanted);
    assert.equal(plan.has_desktop, wanted.some(row => /windows|macos/.test(row)));
    assert.equal(plan.has_mobile, wanted.some(row => /android|ios/.test(row)));
    assert.equal(plan.ios_adhoc, false);
  }
  assert.deepEqual(selectTargets('ios').desktop.include, []);
  for (const [label, key] of Object.entries({All: 'all', Desktop: 'desktop', Mobile: 'mobile', Windows: 'windows', macOS: 'macos', Android: 'android', iOS: 'ios'})) {
    assert.deepEqual(selectTargets(label), selectTargets(key));
  }
  for (const target of ['', 'linux', 'IOS', 'all\nmalicious=1', null]) assert.throws(() => selectTargets(target));
  for (const version of ['v1.2.3\noutput=1', '$(touch file)', '../tag', 'v1.2.3-beta.1', 'v' + '1'.repeat(70), null]) {
    assert.throws(() => selectTargets('all', version));
  }
  assert.equal(selectTargets('all', 'v0.9.0-preview.3').version, 'v0.9.0-preview.3');
  for (const target of ['desktop', 'windows', 'macos', 'android']) assert.throws(() => selectTargets(target, '', true), /Ad Hoc/);
  assert.throws(() => selectTargets('ios', '', 'true'), /boolean/);
});

test('real preflight fails before emitting any plan for invalid signing, without printing secrets', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bilikara-ci-plan-'));
  try {
    const env = {...process.env, BUNDLE_TARGET: 'ios', BUNDLE_IOS_ADHOC: 'false',
      GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REPOSITORY: 'VZRXS/bilikara-next', GITHUB_REF: 'refs/heads/feature/ios'};
    for (const key of ['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION']) delete env[key];
    const invoke = overrides => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci_targets.mjs', import.meta.url))],
      {env: {...env, ...overrides}, encoding: 'utf8', timeout: 10000});
    assert.equal(invoke({}).status, 0);
    const plan = readFileSync(env.GITHUB_OUTPUT, 'utf8');
    assert.match(plan, /has_desktop=false\nhas_mobile=true/);
    for (const overrides of [{BUNDLE_IOS_ADHOC: 'true'}, {BUNDLE_IOS_ADHOC: 'true', BUNDLE_TARGET: 'windows'},
      {BUNDLE_IOS_ADHOC: 'true', GITHUB_REPOSITORY: 'untrusted/repo', IOS_CERTIFICATE: 'private-signing-bytes'},
      {BUNDLE_TARGET: 'unknown'}, {BUNDLE_IOS_ADHOC: 'yes'}]) {
      const result = invoke(overrides);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8'), plan);
      assert.ok(!(result.stdout + result.stderr).includes('private-signing-bytes'));
    }
  } finally {rmSync(directory, {recursive: true, force: true});}
});

// Actual workflow preflight/Gate cases are exercised in ci_plan.test.mjs.

test('automatic risk classification expands native/build/unknown/partial changes to Full', () => {
  for (const files of [undefined, [], Array(300).fill('docs/readme.md'), ['static/app.js'], ['rust-runtime/src/file_publication.rs'],
    ['src-tauri/src/ios.rs'], ['src-tauri/icons/ios/AppIcon-20x20@2x.png'], ['.github/workflows/bundle.yml'],
    ['package-lock.json'], ['scripts/ios.mjs'], ['new/unknown.file'], ['static/../private.html']]) assert.equal(automaticScope(files), 'full');
  assert.equal(automaticScope(['static/host-layout.css', 'static/index.html', 'docs/ios-host.md']), 'fast');
  assert.equal(automaticScope(['static/host-layout.css', 'rust/src/app_state.rs']), 'full');
});

test('shared test ownership is explicit while Full retains native data/media/package gates', () => {
  const read = name => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
  const desktop = desktopChecks, mobile = mobileChecks;
  assert.ok(desktop.includes('node scripts/ci_tests.mjs shared'));
  assert.ok(desktop.includes("needs.preflight.outputs.scope == 'full'"));
  assert.ok(desktop.includes('CI_SCOPE: full'));
  assert.ok(!desktop.includes('inputs.scope'), 'A Fast request that falls back to Full must execute every native check');
  assert.ok(!mobile.includes('npm run test:frontend'));
  assert.ok(!mobile.includes('cargo test --manifest-path rust/Cargo.toml'));
  assert.ok(desktop.includes('if [ "${RUNNER_OS:-Linux}" = Linux ]; then\n            cargo fmt --check'));
  assert.ok(desktop.includes('if [ "${CI_SCOPE:-full}" = full ]; then env -u CARGO_BUILD_TARGET cargo build --release --locked; fi'));
  const shell = desktop.split('cd ../src-tauri')[1].split('cd ..')[0];
  assert.ok(!shell.includes('build --release'));
  for (const command of ['test:native-import', 'test:native-smoke', 'ci_tests.mjs shared', 'test:libav-prerequisites',
    'test:purek-controller', 'test:native-http', 'cargo test --features native-host --locked', 'python -m unittest']) assert.ok(desktop.includes(command), command);
  assert.ok(mobile.includes('cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked'));
  assert.ok(mobile.includes('node scripts/ios.mjs check'));
  assert.ok(!mobile.includes('test:ios-playback'));
  assert.ok(desktop.includes("if: failure() && runner.os == 'Linux'"));
  assert.ok(desktop.includes('retention-days: 3'));
});
