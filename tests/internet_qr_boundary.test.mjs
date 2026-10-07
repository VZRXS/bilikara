import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeHost, buildNativeImages } from './native_runtime_artifacts.mjs';
import { HttpClient, RunningHost, isolatedEnvironment } from './native_host_support.mjs';

const executable = await buildNativeHost();
const decoder = await buildNativeImages();
const prefix = 'https://rtc.kevinx96.icu/remote.html#';
test('real Internet QR keeps the 2048-character contract independently of UTF-8 capacity', async t => {
  const home = mkdtempSync(path.join(root, '.tmp/qr 字符边界 '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const host = await RunningHost.start(executable, home, ['--headless', '--no-browser', '--data-dir', path.join(home, 'data'), '--static-dir', path.join(root, 'static')]);
  try {
    for (const url of [prefix + '中'.repeat(700), prefix + 'x'.repeat(2048 - prefix.length), prefix + 'url=https%3A%2F%2Fexample.test%2Fa%3Fx%3D1&x=a+b%20c%2f%2F#fragment', prefix + 'room=合成测试&name=カラオケ🎤&value=%E4%B8%AD#片段']) {
      assert.ok([...url].length <= 2048);
      const response = await host.request('/api/internet-remote/qr', { url });
      assert.equal(response.status, 200, response.body.toString());
      const data = JSON.parse(response.body); assert.deepEqual(Object.keys(data).sort(), ['data', 'ok']);
      assert.equal(data.ok, true); assert.deepEqual(Object.keys(data.data), ['image']);
      assert.ok(data.data.image.startsWith('data:image/svg+xml;base64,'));
      const svg = Buffer.from(data.data.image.split(',')[1], 'base64').toString('utf8');
      assert.match(svg, /<svg [^>]*viewBox="0 0 \d+ \d+"/); assert.match(svg, /<path /);
      const file = path.join(home, 'actual QR 中文.svg'); writeFileSync(file, svg);
      const result = await runNative(decoder, ['--ignored', '--exact', 'isolated_remote_svg'], { ...isolatedEnvironment(home), BILIKARA_TEST_QR_SVG: file, BILIKARA_TEST_QR_URL: url }, 30000, home);
      assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /1 passed; 0 failed/);
    }
    const overflow = await host.request('/api/internet-remote/qr', { url: prefix + '🎤'.repeat(1000) });
    assert.equal(overflow.status, 400); const error = JSON.parse(overflow.body);
    assert.equal(error.ok, false); assert.equal(error.error, '无法生成二维码'); assert.ok(!('data' in error)); assert.ok(!error.error.includes('🎤'));
    for (const url of ['', 'https://example.test/', 'http://rtc.kevinx96.icu/remote.html#x', prefix + 'x'.repeat(2049 - prefix.length), prefix + '\n']) {
      const response = await host.request('/api/internet-remote/qr', { url }); assert.equal(response.status, 400); assert.ok(!('data' in JSON.parse(response.body)));
    }
    const remote = new HttpClient(host.base); await remote.request('/remote');
    assert.equal((await remote.request('/api/internet-remote/qr', { url: prefix + 'valid' })).status, 403);
  } finally { await host.close(); }
});
