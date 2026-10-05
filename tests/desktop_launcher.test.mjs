import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';
import { verifyLauncher } from './desktop_launcher_smoke.mjs';

test('missing configured native launcher fails without an ambient or stale fallback', {skip: process.platform !== 'linux'}, async () => {
  const previous = process.env.BILIKARA_TEST_TAURI_EXE;
  try {
    process.env.BILIKARA_TEST_TAURI_EXE = path.join(root, '.tmp/missing launcher 中文');
    await assert.rejects(verifyLauncher(path.join(root, '.tmp/unused launcher evidence')), /declare an existing absolute/);
  } finally { if (previous === undefined) delete process.env.BILIKARA_TEST_TAURI_EXE; else process.env.BILIKARA_TEST_TAURI_EXE = previous; }
});

test('installed runtime data is rejected before copying or executing a candidate', {skip: process.platform !== 'linux'}, async t => {
  const source = mkdtempSync(path.join(root, '.tmp/launcher safety 中文 '));
  t.after(() => rmSync(source, {recursive: true, force: true}));
  mkdirSync(path.join(source, 'runtime')); const sentinel = path.join(source, 'runtime/private-data');
  writeFileSync(sentinel, 'untouched'); const executable = path.join(source, 'bilikara-desktop'); writeFileSync(executable, 'unexecuted');
  const previous = process.env.BILIKARA_TEST_TAURI_EXE;
  try {
    process.env.BILIKARA_TEST_TAURI_EXE = executable;
    await assert.rejects(verifyLauncher(path.join(source, 'unused')), /without installed user runtime data/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched'); assert.equal(existsSync(path.join(source, 'unused')), false);
  } finally { if (previous === undefined) delete process.env.BILIKARA_TEST_TAURI_EXE; else process.env.BILIKARA_TEST_TAURI_EXE = previous; }
});

test('real Tauri startup, first-start consent/cancel and later import preserve backups and reap their Host', {timeout: 650000}, async t => {
  const required = process.env.BILIKARA_REQUIRE_NATIVE_LAUNCHER === '1';
  if (process.platform !== 'linux') { assert.equal(required, false, 'required launcher gate must run on Linux'); t.skip('Linux native X11/WebKit unavailable'); return; }
  const executable = process.env.BILIKARA_TEST_TAURI_EXE;
  if (!executable) { assert.equal(required, false, 'required launcher gate needs a current assembled candidate'); t.skip('no current assembled candidate declared'); return; }
  assert.ok(existsSync(executable), 'declared native launcher must exist');
  const output = mkdtempSync(path.join(root, '.tmp/launcher regression receipts 中文 '));
  t.after(() => rmSync(output, {recursive: true, force: true}));
  const checked = await runNative(process.execPath, ['tests/run_desktop_launcher.mjs', output], process.env, 620000);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, 'launcher-summary.json'))), ['default', 'override', 'import', 'restart', 'first-start'].map(backend =>
    ({backend, realTauri: true, ready: true, windowClose: true, childReaped: true, listenerClosed: true})));
});
