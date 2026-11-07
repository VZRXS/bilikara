import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unusedSdkPackages} from '../scripts/ci_sdk_space.mjs';

const inventory = `Installed packages:
Path | Version | Description | Location
ndk;27.0.12077973 | 27.0 | required compiler | ndk/27.0.12077973
ndk;30.0.16248370 | 30.0 | unused compiler | ndk/30.0.16248370
platforms;android-36 | 1 | required API | platforms/android-36
platforms;android-35 | 2 | unused API | platforms/android-35
build-tools;36.0.0 | 36.0.0 | required tools | build-tools/36.0.0
build-tools;35.0.0 | 35.0.0 | unused tools | build-tools/35.0.0
system-images;android-35;google_apis;x86_64 | 1 | emulator | system-images/android-35
cmdline-tools;22.0 | 22.0 | package manager | cmdline-tools/22.0
platform-tools | 37 | adb | platform-tools
cmake;3.31.6 | 3.31.6 | cmake | cmake/3.31.6
ndk;../../other | 1 | invalid | other
ndk;30.0.16248370 | 30.0 | repeated row | ndk/30.0.16248370`;

test('SDK reclamation keeps the exact Android toolchain and never uninstalls package-manager or unrelated packages', () => {
  assert.deepEqual(unusedSdkPackages(inventory, 'android'), ['build-tools;35.0.0', 'ndk;30.0.16248370',
    'platforms;android-35', 'system-images;android-35;google_apis;x86_64']);
  assert.deepEqual(unusedSdkPackages(inventory, 'desktop'), ['build-tools;35.0.0', 'build-tools;36.0.0',
    'ndk;27.0.12077973', 'ndk;30.0.16248370', 'platforms;android-35', 'platforms;android-36',
    'system-images;android-35;google_apis;x86_64']);
  assert.deepEqual(unusedSdkPackages('', 'desktop'), []);
  assert.throws(() => unusedSdkPackages(inventory, 'all'));
});

test('actual SDK preparation refuses local and self-hosted execution before accessing SDK contents', () => {
  const script = fileURLToPath(new URL('../scripts/ci_sdk_space.mjs', import.meta.url));
  for (const environment of [{GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'github-hosted'},
    {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted'}]) {
    const result = spawnSync(process.execPath, [script, 'desktop'], {env: {...process.env, ...environment},
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024});
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires a disposable GitHub-hosted Linux runner/);
    assert.ok(!result.stdout.includes('Uninstalling'));
  }
});
