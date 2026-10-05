import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root } from './desktop_construction_support.mjs';
import { runTransportBrowser } from './run_native_transport.mjs';

test('actual native HTTP/RTC browser consumes controls and preserves timeout/reconnect semantics', {
  skip: process.platform !== 'linux' && 'Linux Chromium and local verified TLS; no foreign GUI qualification', timeout: 200000,
}, async t => {
  const evidence = mkdtempSync(path.join(root, '.tmp/native transport browser 中文 $() & '));
  t.after(() => rmSync(evidence, {recursive: true, force: true}));
  const result = await runTransportBrowser(evidence);
  assert.deepEqual(result.checks.map(row => [row.name, row.passed]), [
    ['real_webrtc_authenticated_two_ordered_lanes', true],
    ['real_webrtc_authenticates_with_candidates_trickled_after_empty_sdp', true], ['browser_consumes_both_accepted_relative_seeks', true],
    ['browser_ignores_old_generation_control', true], ['bulk_delay_does_not_block_control_datachannel', true],
    ['internet_relative_av_delay_preserves_concurrent_lan_increment', true],
    ['timeout_reconnect_late_response_does_not_resubmit_mutation', true],
    ['close_rebuild_room_with_real_webrtc_keeps_lan_usable', true], ['browser_identity_render_and_console', true],
  ]);
  const evidenceFor = name => result.checks.find(row => row.name === name).evidence;
  assert.equal(evidenceFor('browser_consumes_both_accepted_relative_seeks').position, 18);
  assert.equal(evidenceFor('browser_consumes_both_accepted_relative_seeks').commands, 2);
  assert.equal(evidenceFor('internet_relative_av_delay_preserves_concurrent_lan_increment').actual, 100);
  assert.equal(evidenceFor('timeout_reconnect_late_response_does_not_resubmit_mutation').mutationSends, 1);
  assert.equal(evidenceFor('timeout_reconnect_late_response_does_not_resubmit_mutation').pending, 0);
  assert.equal(JSON.parse(readFileSync(path.join(evidence,'fixture-summary.json'))).forwarded_external_requests, 0);
});
