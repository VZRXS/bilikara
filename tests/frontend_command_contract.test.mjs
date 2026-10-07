import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNative } from './desktop_construction_support.mjs';
// Each existing fixture asserts real loaded frontend functions. Browser/native
// window acceptance stays separate; no Python Host or fabricated route server.
for (const fixture of ['native_remote_rating', 'android_player_gestures', 'android_presentation', 'android_layout', 'host_language', 'android_export_bridge', 'android_portrait_navigation', 'android_login_action', 'android_playback_visibility', 'native_host_transition', 'incoming_request']) {
  test(`existing frontend behavior: ${fixture}`, async () => {
    const result = await runNative(process.execPath, [`tests/${fixture}.cjs`], process.env, 20000); assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
