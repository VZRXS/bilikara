// Actual locked native Host + real Chromium/RTC; test-only FFmpeg clip oracle.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { TransportFixture } from './native_transport_support.mjs';

export async function runTransportBrowser(evidence) {
  assert.equal(process.platform, 'linux', 'Linux scoped actual TLS/browser gate');
  const chromium = createRequire(import.meta.url)('playwright').chromium;
  const browser = process.env.BILIKARA_BROWSER_EXECUTABLE || chromium.executablePath();
  assert.ok(existsSync(browser), 'actual installed Chromium required');
  mkdirSync(evidence, {recursive: true}); const media = path.join(evidence, 'synthetic.webm');
  const built = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x224466:s=640x360:r=10:d=60', '-c:v', 'libvpx', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', media]);
  assert.equal(built.status, 0, built.stderr);
  const fixture = await TransportFixture.start(await buildNativeHost());
  try {
    const checked = await runNative(process.execPath, [path.join(root, 'tests/live_transport_concurrency.js'), fixture.host.base, browser, path.resolve(evidence)], {
      ...process.env, BILIKARA_TRANSPORT_BOOTSTRAP: fixture.host.bootstrapUrl,
      BILIKARA_TRANSPORT_MEDIA: media, BILIKARA_TRANSPORT_PROVIDER: fixture.provider.base,
    }, 150000);
    writeFileSync(path.join(evidence, 'browser.stdout.log'), checked.stdout); writeFileSync(path.join(evidence, 'browser.stderr.log'), checked.stderr);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const summary = JSON.parse(readFileSync(path.join(evidence, 'browser-results.json')));
    assert.equal(summary.passed, true); assert.equal(summary.checks.length, 10); assert.deepEqual(summary.errors, []);
    // Every provider request is served locally; no proxy forwarding exists.
    writeFileSync(path.join(evidence, 'fixture-summary.json'), JSON.stringify({requests: fixture.provider.requests, forwarded_external_requests: 0}, null, 2));
    return summary;
  } finally { await fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.deepEqual(process.argv.slice(2, 3), ['--output'], 'usage: node tests/run_native_transport.mjs --output DIRECTORY');
  assert.equal(process.argv.length, 4, 'output directory required');
  await runTransportBrowser(path.resolve(process.argv[3]));
  console.log('Actual native transport/browser concurrency: PASS');
}
