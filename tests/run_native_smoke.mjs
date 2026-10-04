// Portable process contracts plus an explicitly separate native macOS GUI gate.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
import { nativeTarget, suffix } from './desktop_construction_expectations.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'native smoke fixture 中文 '));
try {
  const binary = path.join(directory, `smoke-process${suffix}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CARGO_BUILD_TARGET'));
  const compile = await runNative('rustc', ['--edition=2024', '--target', nativeTarget(), '--crate-name', 'smoke_process', path.join(root, 'tests/fixtures/smoke_process.rs'), '-o', binary], env);
  assert.equal(compile.status, 0, compile.stderr);
  const args = ['--test', 'tests/native_smoke_process.test.mjs', 'tests/native_smoke_entry.test.mjs', 'tests/macos_tauri_source_contract.test.mjs', 'tests/macos_tauri_smoke.test.mjs'];
  const command = process.platform === 'linux' ? binary : process.execPath;
  const checked = await runNative(command, process.platform === 'linux' ? ['supervise', process.execPath, ...args] : args,
    {...env, BILIKARA_TEST_PROCESS_FIXTURE: binary}, 360000);
  process.stdout.write(checked.stdout); process.stderr.write(checked.stderr); process.exitCode = checked.status;
} finally {rmSync(directory, {recursive: true, force: true});}
