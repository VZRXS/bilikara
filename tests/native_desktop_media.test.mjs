import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root } from './desktop_construction_support.mjs';
import { runDesktopBrowser } from './run_desktop_rust_host.mjs';
import './shared_workspace_icon.test.mjs';
import './shared_host_layout_browser.test.mjs';

for (const [name, options, marker] of [
  ['actual native Host, login, media clocks, LAN/Internet controls, exports and restart', [], 'Desktop Rust entry/browser core loop passed'],
  ['actual native cache policy, immutable publications, cancellation and persisted settings', ['--cache-policy'], 'Actual desktop import, exports, native mutations and no-reimport restart passed'],
  ['actual native BBDown executor with a compiled tool, failures and process cancellation', ['--bbdown'], 'Actual desktop import, exports, native mutations and no-reimport restart passed'],
]) test(name, {
  skip: process.platform !== 'linux' && 'Linux scoped TLS/WebKit media gate; native Windows/macOS gates remain separate',
  timeout: 360000,
}, async t => {
  const evidence = mkdtempSync(path.join(root, '.tmp/native desktop media 中文 $() & '));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const result = await runDesktopBrowser(evidence, options);
  assert.ok(result.stdout.includes(marker), result.stdout);
  const fixture = JSON.parse(readFileSync(path.join(evidence, 'fixture-summary.json')));
  assert.equal(fixture.forwarded_external_requests, 0);
  if (options.includes('--cache-policy')) {
    const cache = JSON.parse(readFileSync(path.join(evidence, 'cache-policy-summary.json')));
    assert.equal(cache.passed, true); assert.deepEqual(cache.desktopCounts, [1, 2, 4, 5]);
    for (const fact of ['actualRustJobs', 'delayedReplacement', 'hiresFlac', 'effectiveNoop', 'atomicRejectedPatch', 'restartPersistence', 'transientPlayerFacts']) assert.equal(cache[fact], true, fact);
  }
  if (options.includes('--bbdown')) {
    const bbdown = JSON.parse(readFileSync(path.join(evidence, 'bbdown-summary.json')));
    assert.equal(bbdown.passed, true);
    assert.deepEqual(bbdown.outcomes.map(({ failure, children }) => [failure, children]), [['missing', 2], ['invalid', 2], ['exit', 2]]);
  }
});
