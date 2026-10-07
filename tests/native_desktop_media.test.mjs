import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test, { before } from 'node:test';
import { chromium } from 'playwright';
import { root } from './desktop_construction_support.mjs';
import { TransportFixture } from './native_transport_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { runDesktopBrowser } from './run_desktop_rust_host.mjs';
import './shared_workspace_icon.test.mjs';
import './shared_host_layout_browser.test.mjs';

let nativeHost;
before(async () => {
  if (process.platform === 'linux') nativeHost = await buildNativeHost();
}, { timeout: 300000 });

test('actual Host serves a working Signalsmith AudioWorklet under pinned Chromium', {
  skip: process.platform !== 'linux' && 'Linux browser gate; no foreign audio-device qualification',
  timeout: 45000,
}, async t => {
  const fixture = await TransportFixture.start(nativeHost);
  t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.host.base
    ? route.continue() : route.abort());
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(fixture.host.bootstrapUrl);
  // The private entry is a separate document with a zero-delay meta refresh.
  await page.waitForURL(fixture.host.base + '/');
  await page.waitForFunction(() => typeof state !== 'undefined' && state.hasValidStateResponse);
  assert.equal(await page.title(), 'bilikara host');
  await page.evaluate(() => { window.workletProbeContext = new AudioContext(); });
  await page.mouse.click(10, 10);
  await page.evaluate(() => {
    window.workletProbe = (async () => {
      const audioContext = window.workletProbeContext;
      let node;
      try {
        await audioContext.resume();
        const url = new URL('/vendor/signalsmith-stretch/SignalsmithStretch.js', location.href).href;
        const { default: factory } = await import(url);
        factory.moduleUrl = url;
        await audioContext.audioWorklet.addModule(url);
        node = await factory(audioContext, {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2,
          channelCountMode: 'max', channelInterpretation: 'speakers',
        }, new AbortController().signal);
        await node.configure({ preset: 'default' });
        return { state: audioContext.state, latency: await node.latency(), inputs: node.numberOfInputs, outputs: node.numberOfOutputs };
      } finally {
        node?.destroy();
        await audioContext.close();
      }
    })();
    window.workletProbe.then(result => { window.workletProbeResult = result; }, error => {
      window.workletProbeResult = { error: error.message };
    });
  });
  await page.waitForFunction(() => window.workletProbeResult, null, { timeout: 15000 });
  const result = await page.evaluate(() => window.workletProbeResult);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.state, 'running');
  assert.equal(result.inputs, 1);
  assert.equal(result.outputs, 1);
  assert.ok(Number.isFinite(result.latency) && result.latency > 0 && result.latency <= 1, JSON.stringify(result));
  assert.deepEqual(pageErrors, []);
});

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
