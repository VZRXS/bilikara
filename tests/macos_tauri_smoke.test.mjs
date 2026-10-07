import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root } from './desktop_construction_support.mjs';
import { verifyTauri } from './macos_tauri_smoke.mjs';

test('real macOS shell resolves embedded backend in shell/Finder environments', async t => {
  const required = process.env.BILIKARA_REQUIRE_TAURI_SMOKE === '1';
  if (process.platform !== 'darwin') {if (required) assert.fail('required Tauri smoke must run on macOS'); t.skip('macOS native shell unavailable'); return;}
  const exe = process.env.BILIKARA_TEST_TAURI_EXE || path.join(root, 'dist_release/bilikara-desktop.app/Contents/MacOS/bilikara');
  if (!existsSync(exe)) {if (required || process.env.BILIKARA_TEST_TAURI_EXE) assert.fail('declared native Tauri executable missing'); t.skip('no native macOS shell candidate'); return;}
  await verifyTauri();
});
