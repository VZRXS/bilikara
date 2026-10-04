import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { root, runNative } from './desktop_construction_support.mjs';
import { isolatedEnvironment } from './native_host_support.mjs';
import { buildNativeAlpha } from './native_runtime_artifacts.mjs';

test('actual Host and two Remotes preserve stable identities through roster editing', {
  timeout: 300000,
}, async t => {
  const executable = await buildNativeAlpha();
  const directory = mkdtempSync(path.join(root, '.tmp/session users 中文 & '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await runNative(process.execPath, ['tests/live_session_user_editor.cjs', executable,
    directory, chromium.executablePath()], isolatedEnvironment(directory), 240000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.passed.length, 10);
  assert.ok(evidence.passed.includes('atomic batch deletion revokes both devices'));
  assert.ok(evidence.passed.includes('touch checkbox selection, immediate group drag, and interrupted gesture cancellation'));
});
