import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';

test('required native shell validation cannot pass by skipping or missing a declared artifact', async () => {
  const environment = {...process.env, BILIKARA_REQUIRE_TAURI_SMOKE: '1', BILIKARA_TEST_TAURI_EXE: path.join(root, '.tmp/absent shell 中文/bilikara')};
  delete environment.NODE_TEST_CONTEXT;
  const result = await runNative(process.execPath, ['--test', 'tests/macos_tauri_smoke.test.mjs'], environment);
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /required Tauri smoke must run on macOS|declared native Tauri executable missing/);
});

test('required Linux launcher validation fails without its declared candidate', async () => {
  const environment = {...process.env, BILIKARA_REQUIRE_NATIVE_LAUNCHER: '1', BILIKARA_TEST_TAURI_EXE: path.join(root, '.tmp/absent launcher 中文/bilikara-desktop')};
  delete environment.NODE_TEST_CONTEXT;
  const result = await runNative(process.execPath, ['--test', 'tests/desktop_launcher.test.mjs'], environment);
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /required launcher gate must run on Linux|declared native launcher must exist/);
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:native-launcher'], 'node --test tests/desktop_launcher.test.mjs');
});

test('native process contracts and extracted macOS shell checks use real Node entries after required prerequisites', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8');
  const command = 'node --test tests/macos_tauri_smoke.test.mjs';
  const block = workflow.split(/\n      - /).find(step => step.includes(command)); assert.ok(block);
  assert.ok(block.includes('BILIKARA_REQUIRE_TAURI_SMOKE=1')); assert.ok(block.includes('test_extract/dist_release/bilikara-desktop.app/Contents/MacOS/bilikara'));
  assert.ok(block.indexOf('verify-native-desktop "$backend"') < block.indexOf(command));
  assert.doesNotMatch(block, /python|setup-python/);
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:native-smoke'], 'node tests/run_native_smoke.mjs');
  assert.equal(workflow.split('\n').filter(line => line.trim() === 'npm run test:native-smoke').length, 1);
  const testJob = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  bundle:'));
  const nativeGraphs = testJob.indexOf('cd ../src-tauri');
  assert.ok(nativeGraphs >= 0 && nativeGraphs < testJob.indexOf('npm run test:frontend'));
  assert.ok(nativeGraphs < testJob.indexOf('npm run test:native-smoke'), 'offline manifest checks follow actual native Cargo graphs');
});
