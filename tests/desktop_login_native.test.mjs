import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildDesktopLoginTests, buildNativeHost } from './native_runtime_artifacts.mjs';
import { localCertificate } from './local_tls_certificate.mjs';
import { HttpClient, RunningHost, isolatedEnvironment, waitFor } from './native_host_support.mjs';
import { videoFixture } from './video_service_fixture.mjs';

const cookies = ['SESSDATA=synthetic-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly', 'bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/; Secure', 'b_nut=synthetic-nut; Domain=.bilibili.com; Path=/; Secure'];
test('real shared desktop login ABI: QR decoding, credentials, failures and generation cancellation', { skip: process.platform !== 'linux' && 'requires Linux SSL_CERT_FILE native trust', timeout: 180000 }, async () => {
  const binary = await buildDesktopLoginTests();
  const executable = await buildNativeHost();
  const home = mkdtempSync(path.join(root, '.tmp/login 服务 中文 & '));
  let fixture, mode = 'success', hold = '', stages = [], releases = [], held = [], payload = 'https://passport.bilibili.com/scan?name=カラオケ🎤';
  try {
    const certs = await localCertificate(path.join(home, 'certs'), ['passport.bilibili.com']);
    fixture = await videoFixture(async raw => {
      const url = new URL(raw, 'http://fixture.test');
      if (url.pathname === '/fixture/control') {
        for (const release of releases.splice(0)) release();
        mode = url.searchParams.get('mode') ?? 'success'; hold = url.searchParams.get('hold') ?? ''; stages = []; held = [];
        if (url.searchParams.has('payload')) payload = url.searchParams.get('payload');
        return { stages };
      }
      if (url.pathname === '/fixture/stats') return { stages, held };
      if (url.pathname === '/fixture/release') { const index = Number(url.searchParams.get('index') ?? 0); releases[index]?.(); return {}; }
      const stage = url.pathname === '/x/passport-login/web/qrcode/generate' ? 'generate' : url.pathname === '/x/passport-login/web/qrcode/poll' ? 'poll' : undefined;
      assert.ok(stage, `unexpected external fixture path: ${url.pathname}`); stages.push(stage);
      if (stage === hold) await new Promise(resolve => { held.push(releases.length); releases.push(resolve); setTimeout(resolve, 15000).unref(); });
      if (stage === 'generate') {
        if (mode === 'generate_http') return { fixtureResponse: { status: 403, data: {} } };
        if (mode === 'generate_api') return { code: -1, message: 'synthetic-secret' };
        if (mode === 'generate_json') return { fixtureResponse: { rawBody: Buffer.from('synthetic-bad-json') } };
        return { code: 0, data: { url: payload, qrcode_key: 'synthetic-key' } };
      }
      let data = { code: 0, data: { code: 0 } }, headerCookies = cookies;
      if (mode === 'poll_api') data = { code: -1, data: { code: 0 } };
      if (mode === 'unknown') data.data.code = 1;
      if (mode === 'expired') data.data.code = stages.filter(stage => stage === 'poll').length === 1 ? 86090 : 86038;
      if (mode === 'ticket') headerCookies = ['access_token=synthetic; Domain=.bilibili.com; Path=/'];
      if (mode === 'host_only') headerCookies = ['SESSDATA=synthetic; Path=/', 'bili_jct=synthetic; Path=/'];
      return { fixtureResponse: { data, headers: { 'Set-Cookie': headerCookies } } };
    }, certs);
    const env = { ...isolatedEnvironment(home), ...fixture.environment, BILIKARA_TEST_LOGIN_HOME: home, BILIKARA_TEST_LOGIN_FIXTURE: fixture.base };
    const result = await runNative(binary, ['--exact', 'shared_desktop_login_publication_and_generation_contract', '--ignored', '--nocapture'], env, 150000, home);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /1 passed; 0 failed/);
    const control = async route => { const reply = await new HttpClient(fixture.base).request(`/fixture/${route}`); assert.equal(reply.status, 200); return JSON.parse(reply.body); };
    // Exercise the current HTTP consumer too, including actual Host shutdown.
    // The legacy cache shutdown forwards cancel to the separately tested ABI.
    for (const stage of ['generate', 'poll']) {
      const data = path.join(home, `native ${stage}`);
      await control(`control?mode=success&hold=${stage}`);
      const host = await RunningHost.start(executable, home, ['--headless', '--no-browser', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')], { ...isolatedEnvironment(home), ...fixture.environment });
      try {
        const remote = new HttpClient(host.base); await remote.request('/remote');
        assert.equal((await remote.request('/api/bbdown/login/start', {})).status, 403);
        await host.api('/api/bbdown/login/start', {}); await waitFor(async () => (await control('stats')).held.length === 1, 'first HTTP login did not reach held generation');
        await host.api('/api/bbdown/login/start', {}); assert.equal((await control('stats')).held.length, 1);
        await host.api('/api/bbdown/login/start', { force: true }); await waitFor(async () => (await control('stats')).held.length === 2, 'replacement HTTP login did not reach fixture');
        await host.api('/api/bbdown/logout', {}); assert.equal((await host.api('/api/state')).bbdown.login.state, 'idle');
        await host.api('/api/bbdown/login/start', {}); await waitFor(async () => (await control('stats')).held.length === 3, 'shutdown login not in flight');
        // Keep response pending until real shutdown has invalidated its owner.
        await host.close(async () => { await control('release?index=0'); await control('release?index=1'); await control('release?index=2'); });
        assert.ok(!existsSync(path.join(data, 'BBDown.data'))); assert.ok(!existsSync(path.join(data, 'bilibili-login.json'))); assert.ok(!existsSync(path.join(data, 'qrcode.png')));
      } finally { for (const release of releases) release(); if (host.process.exitCode === null) await host.close(); }
    }
  } finally { for (const release of releases) release(); if (fixture) await fixture.close(); rmSync(home, { recursive: true, force: true }); }
});
