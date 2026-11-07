import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/ios-startup.js', import.meta.url), 'utf8');
const valid = {schema_version: 1, platform: 'ios', backend: 'rust', revision: 0,
  host_api_ready: true, persistence_ready: true, playback: 'unverified',
  bootstrap_url: `http://127.0.0.1:12345/bootstrap/${'a'.repeat(43)}`};

async function run(invoke, capabilities = {}) {
  const status = {textContent: ''};
  let destination;
  const context = {URL, AbortController, ResizeObserver: class {}, CSS: {supports: () => true},
    document: {getElementById: () => status, createElement: () => ({inert: false})}, window: {
    location: {replace: url => {destination = url;}},
    ...(invoke ? {__TAURI__: {core: {invoke}}} : {}),
  }, ...capabilities};
  await vm.runInNewContext(source, context);
  return {text: status.textContent, destination};
}

test('iOS startup opens the authenticated listener without claiming playback verification', async () => {
  let calls = 0;
  const result = await run(async command => {calls++; assert.equal(command, 'ios_host_status'); return valid;});
  assert.equal(calls, 1);
  assert.equal(result.destination, valid.bootstrap_url);
  assert.match(result.text, /Host 已就绪/);
  assert.ok(!result.text.includes('a'.repeat(43)));
});

test('iOS startup rejects incompatible facts and every untrusted URL before navigation', async () => {
  const invalid = [
    undefined, {...valid, schema_version: 3}, {...valid, platform: 'android'}, {...valid, backend: 'python'},
    {...valid, revision: NaN}, {...valid, revision: -1}, {...valid, revision: Number.MAX_SAFE_INTEGER + 1},
    {...valid, host_api_ready: false}, {...valid, persistence_ready: false}, {...valid, playback: 'ready'},
    ...['https://127.0.0.1:12345/', 'http://localhost:12345/', 'http://127.0.0.1/',
      'http://127.0.0.1:0/', 'http://user@127.0.0.1:12345/', 'http://evil.test:12345/']
      .map(origin => ({...valid, bootstrap_url: `${origin}bootstrap/${'a'.repeat(43)}`})),
    ...['?leak=1', '#leak', '/extra'].map(suffix => ({...valid, bootstrap_url: valid.bootstrap_url + suffix})),
    {...valid, bootstrap_url: 'not a url'}, {...valid, bootstrap_url: null},
    {...valid, bootstrap_url: valid.bootstrap_url.slice(0, -1)},
  ];
  for (const facts of invalid) {
    const result = await run(async () => facts);
    assert.equal(result.destination, undefined);
    assert.match(result.text, /启动检查失败/);
    assert.ok(!result.text.includes('a'.repeat(43)));
  }
});

test('startup failures preserve a diagnostic and never reveal arbitrary native errors', async () => {
  for (const error of ['native_storage_invalid', new Error('private /var/mobile/secret token=credential'), 'constructor', '__proto__']) {
    const result = await run(async () => {throw error;});
    assert.equal(result.destination, undefined);
    assert.match(result.text, /启动检查失败/);
    assert.ok(!result.text.includes('credential'));
    assert.ok(!result.text.includes('/var/mobile'));
    if (error === 'native_storage_invalid') assert.match(result.text, /存档损坏/);
  }
  assert.equal((await run()).destination, undefined);
});

test('startup reports validated stages and OS facts without exposing error payloads', async () => {
  const failure = {schema_version: 1, stage: 'cache_recovery', last_completed: 'state_initialize',
    code: 'cache_storage', io_kind: 'PermissionDenied', os_error: 13,
    message: '/var/mobile/private?token=credential', path: '/var/mobile/private'};
  const result = await run(async () => {throw failure;});
  assert.match(result.text, /stage=cache_recovery, last=state_initialize, io_kind=PermissionDenied, os_error=13/);
  assert.equal(result.destination, undefined);
  for (const secret of ['credential', '/var/mobile', 'token=']) assert.ok(!result.text.includes(secret));
  for (const invalid of [{...failure, stage: '/private/credential'}, {...failure, last_completed: 'token=credential'},
    {...failure, schema_version: 2}, {...failure, code: 'token=credential'}]) {
    const rejected = await run(async () => {throw invalid;});
    assert.ok(!rejected.text.includes('credential'));
    assert.ok(!rejected.text.includes('stage='));
  }
  const unknownFacts = await run(async () => {throw {...failure, io_kind: 'private/credential', os_error: 'token=credential'};});
  assert.ok(!unknownFacts.text.includes('credential'));
  assert.ok(!unknownFacts.text.includes('io_kind='));
  assert.ok(!unknownFacts.text.includes('os_error='));
});

test('unsupported WebKit stays on the diagnostic page without selecting Android compatibility mode', async () => {
  let calls = 0;
  for (const capabilities of [{CSS: {supports: () => false}}, {ResizeObserver: undefined}, {AbortController: undefined}]) {
    const result = await run(async () => {calls++; return valid;}, capabilities);
    assert.equal(result.destination, undefined);
    assert.match(result.text, /iOS WebView/);
  }
  assert.equal(calls, 0);
});

test('iOS startup capability cannot grant HTTP Host, Remote, other windows or desktop IPC', () => {
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/ios-startup.json', import.meta.url), 'utf8'));
  assert.deepEqual(capability.platforms, ['iOS']);
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.permissions, ['allow-ios-host-status']);
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.ios.conf.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.app.security.capabilities, ['ios-startup']);
  assert.equal(config.app.windows[0].create, false);
  assert.equal(config.app.windows[0].url, 'ios-startup.html');
  assert.equal(config.build.beforeDevCommand, null);
  assert.equal(config.build.devUrl, null);
  assert.ok(config.app.security.csp.includes("frame-src 'none'"));
});
