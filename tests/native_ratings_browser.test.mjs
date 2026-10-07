import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root } from './desktop_construction_support.mjs';
import { runRatings } from './run_native_ratings_catalog.mjs';

test('real native HTTP, Internet dispatch and rendered Host/Remote ratings remain isolated', {
  skip: process.platform !== 'linux' && 'local TLS fixture requires Linux SSL_CERT_FILE; foreign GUI not qualified',
  timeout: 300000,
}, async t => {
  const evidence = mkdtempSync(path.join(root, '.tmp/ratings screenshots 中文 & '));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const result = await runRatings(evidence);
  assert.match(result.stdout, /closed-peer checks: PASS/);
  assert.match(result.stdout, /bounded append queue: PASS/);
  assert.match(result.stdout, /stopped Host reject late adds without contributions: PASS/);
  const browser = JSON.parse(readFileSync(path.join(evidence, 'browser-summary.json')));
  assert.equal(browser.passed, true); assert.deepEqual(browser.pageErrors, []);
  assert.deepEqual(browser.summaries.map(({ role, width, failureRetry }) => [role, width, failureRetry]), [
    ['host', 1440, true], ['host', 412, true], ['remote', 1440, true], ['remote', 412, true],
  ]);
  assert.equal(browser.playbackEvidence, false);
  const fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture-summary.json')));
  assert.deepEqual(fixture.failures, []); assert.equal(fixture.forwarded_external_requests, 0);
  assert.ok(fixture.calls.some(call => call.path === '/rate-song' && !call.accepted));
  assert.ok(fixture.calls.some(call => call.path === '/rate-song' && call.accepted));
  assert.ok(fixture.calls.some(call => call.path === '/batch-add' && !call.accepted));
  assert.ok(fixture.calls.some(call => call.path === '/batch-add' && call.accepted));
});
