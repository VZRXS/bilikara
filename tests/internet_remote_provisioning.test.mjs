import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

// These tests execute the shared browser code without network access. They
// verify provisioning/diagnostic contracts, never claim real ICE or TURN.
function transportFixture() {
  const sandbox = { TextEncoder, Date, console };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync(new URL('../static/internet-remote-transport.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.BilikaraInternetTransport;
}
const plain = value => JSON.parse(JSON.stringify(value));
const instant = 1_790_000_000_000;
const payload = (overrides = {}) => ({
  expires_at: instant + 60_000,
  ice_servers: [{ urls: ['turn:relay.example.invalid:3478?transport=udp', 'turns:relay.example.invalid:5349?transport=tcp'],
    username: 'ephemeral-test-user', credential: 'ephemeral-test-credential' }],
  ...overrides,
});
const assertCode = (operation, code = 'internet_remote_ice_invalid') => assert.throws(operation, error => error.code === code);

test('missing optional provisioning retains the legacy direct configuration without network access', () => {
  const api = transportFixture(), store = api.createIceProvisioning({ now: () => instant });
  assert.deepEqual(plain(store.configuration()), plain(api.iceConfiguration));
  assert.equal(store.configuration().iceTransportPolicy ?? 'all', 'all', 'the legacy browser default is all');
  assert.ok(store.configuration().iceServers.every(server => !server.username && !server.credential));
});

test('trusted ephemeral servers use standard all policy and defensive configuration copies', () => {
  const store = transportFixture().createIceProvisioning({ now: () => instant }), input = payload();
  store.accept(input);
  const config = store.configuration();
  assert.deepEqual(plain(config), { iceServers: input.ice_servers, iceTransportPolicy: 'all', iceCandidatePoolSize: 0 });
  config.iceServers[0].urls[0] = 'turn:changed.example.invalid';
  config.iceServers[0].credential = 'changed';
  input.ice_servers[0].urls.push('turn:changed-input.example.invalid');
  assert.equal(store.configuration().iceServers[0].urls.length, 2);
  assert.equal(store.configuration().iceServers[0].credential, 'ephemeral-test-credential');
  assert.equal(store.configuration().iceServers[0].urls[0], 'turn:relay.example.invalid:3478?transport=udp');
});

test('configuration expires before a new negotiation without affecting an already copied peer config', () => {
  let time = instant;
  const store = transportFixture().createIceProvisioning({ now: () => time });
  store.accept(payload());
  const activePeerConfiguration = store.configuration();
  time = instant + 54_999;
  assert.equal(store.configuration().iceServers[0].username, 'ephemeral-test-user');
  time++;
  assertCode(() => store.configuration(), 'internet_remote_ice_expired');
  assert.equal(activePeerConfiguration.iceServers[0].credential, 'ephemeral-test-credential');
  store.accept(payload({ expires_at: time + 60_000 }));
  assert.equal(store.configuration().iceTransportPolicy, 'all');
});

test('malformed advertised provisioning fails closed until a fresh valid service message or reset', () => {
  const api = transportFixture(), store = api.createIceProvisioning({ now: () => instant });
  store.accept(payload());
  assertCode(() => store.accept(payload({ ice_servers: [{ urls: ['turn:relay.example.invalid'] }] })));
  assertCode(() => store.configuration());
  store.accept(payload());
  assert.equal(store.configuration().iceServers.length, 1);
  store.reset();
  assert.deepEqual(plain(store.configuration()), plain(api.iceConfiguration));
  assertCode(() => store.accept(null));
  store.reset();
  assert.deepEqual(plain(store.configuration()), plain(api.iceConfiguration));
});

test('issuance payload validates finite lifetime, exact shape and independent bounded server/URL counts', () => {
  const store = transportFixture().createIceProvisioning({ now: () => instant });
  for (const expires_at of [instant - 1, instant, instant + 29_999, instant + 600_001, NaN, Infinity, '1790000060000']) {
    assertCode(() => store.accept(payload({ expires_at })));
  }
  for (const expires_at of [instant + 30_000, instant + 600_000]) store.accept(payload({ expires_at }));
  for (const invalid of [undefined, [], {}, payload({ extra: true }), payload({ ice_servers: [] }),
    payload({ ice_servers: Array.from({ length: 5 }, () => ({ urls: ['stun:stun.example.invalid'] })) }),
    payload({ ice_servers: [{ urls: Array.from({ length: 9 }, () => 'stun:stun.example.invalid') }] }),
    payload({ extra: 'x'.repeat(16_384) })]) assertCode(() => store.accept(invalid));
  store.accept(payload({ ice_servers: Array.from({ length: 4 }, () => ({ urls: ['stun:stun.example.invalid', 'stun:192.0.2.1:3478'] })) }));
  assert.equal(store.configuration().iceServers.length, 4);
  for (const server of [
    { urls: 'turn:relay.example.invalid', username: 'user', credential: 'secret' },
    { urls: [], username: 'user', credential: 'secret' },
    { urls: ['turn:relay.example.invalid'], username: '', credential: 'secret' },
    { urls: ['turn:relay.example.invalid'], username: 'u'.repeat(257), credential: 'secret' },
    { urls: ['turn:relay.example.invalid'], username: 'user', credential: 's'.repeat(257) },
    { urls: ['turn:relay.example.invalid'], username: 'user', credential: 'with space' },
    { urls: ['turn:relay.example.invalid'], username: 'user\n', credential: 'secret' },
    { urls: ['turn:relay.example.invalid'], username: 'user', credential: 'secret', credentialType: 'oauth' },
    { urls: ['stun:stun.example.invalid'], username: 'user', credential: 'secret' },
  ]) assertCode(() => store.accept(payload({ ice_servers: [server] })));
});

test('ICE URLs exclude arbitrary protocols, query overrides, userinfo, paths and malformed ports', () => {
  const store = transportFixture().createIceProvisioning({ now: () => instant });
  for (const url of [
    'https://relay.example.invalid', 'wss://relay.example.invalid', 'turn://relay.example.invalid',
    'turn:user:secret@relay.example.invalid', 'turn:relay.example.invalid/path',
    'turn:relay.example.invalid#secret', 'turn:relay.example.invalid?transport=udp&endpoint=https://evil.invalid',
    'turn:relay.example.invalid?transport=ws', 'turns:relay.example.invalid?transport=udp',
    'stun:stun.example.invalid?transport=tcp', 'turn:relay.example.invalid:0', 'turn:relay.example.invalid:65536',
    'turn:relay.example.invalid:03478garbage', 'turn:relay..example.invalid', 'turn:relay.example.invalid\n',
    'turn:' + 'a'.repeat(510) + '.invalid',
  ]) assertCode(() => store.accept(payload({ ice_servers: [{ ...payload().ice_servers[0], urls: [url] }] })));
  for (const url of ['stun:stun.example.invalid:3478', 'turn:192.0.2.1:3478?transport=tcp',
    'turn:[2001:db8::1]:3478?transport=udp', 'turns:relay.example.invalid:5349']) {
    store.accept(payload({ ice_servers: [{ urls: [url], ...(url.startsWith('stun:') ? {} : { username: 'user', credential: 'secret' }) }] }));
    assert.equal(store.configuration().iceServers[0].urls[0], url);
  }
});

function socketOwnerFixture(role) {
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor(url, protocols) { super(); Object.assign(this, { url, protocols, readyState: 1 }); }
    close() { this.readyState = 3; }
  }
  const storage = new Map([['bilikara.internetRemote.iceServers', JSON.stringify(payload())]]);
  const sandbox = {
    TextEncoder, Event, CustomEvent, URL, URLSearchParams, Response, console, crypto: webcrypto, btoa,
    RTCPeerConnection: class {}, WebSocket: Socket,
    fetch: async () => { throw new Error('network is unavailable in this contract fixture'); },
    location: { hash: `#room=${'R'.repeat(27)}&join=${'J'.repeat(43)}&turn=turn:untrusted.example.invalid`,
      href: 'https://remote.example.invalid/remote.html?signal=wss://untrusted.example.invalid',
      origin: 'https://remote.example.invalid', protocol: 'https:', hostname: 'remote.example.invalid' },
    localStorage: { getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    document: { readyState: 'loading', addEventListener() {}, documentElement: { dataset: {} } },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = name => readFileSync(new URL(`../static/${name}`, import.meta.url), 'utf8');
  vm.runInContext(source('internet-remote-transport.js'), context);
  const host = role === 'host';
  vm.runInContext(source(host ? 'internet-remote-host.js' : 'remote-transport-client.js')
    .replace(host ? /\}\)\(\);\s*$/u : /\}\)\(globalThis\);\s*$/u, host
      ? 'render = () => {}; setStatus = () => {}; window.owner = { state, iceProvisioning, connectSignaling }; })();'
      : 'setConnectionStatus = () => {}; global.owner = { state, iceProvisioning, connectSignaling }; })(globalThis);'), context);
  const owner = sandbox.owner;
  if (host) Object.assign(owner.state, { stopped: false, roomId: 'R'.repeat(27), hostToken: 'H'.repeat(43), hostPeerId: 'P'.repeat(22) });
  else owner.state.connectButton = { disabled: false, dataset: {}, removeAttribute() {} };
  owner.connectSignaling();
  const send = (socket, frame) => socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  return { owner, send, api: sandbox.BilikaraInternetTransport };
}

for (const role of ['host', 'remote']) {
  test(`${role} accepts ICE provisioning only from its current service socket and ignores URL/storage/peer overrides`, () => {
    const { owner, send, api } = socketOwnerFixture(role), retired = owner.state.socket;
    assert.deepEqual(plain(owner.iceProvisioning.configuration()), plain(api.iceConfiguration));
    assert.ok(!owner.state.socket.url.includes('untrusted'));
    assert.ok(!owner.state.socket.url.includes('H'.repeat(43)) && !owner.state.socket.url.includes('J'.repeat(43)));
    assert.ok(owner.state.socket.protocols.some(value => value.startsWith(role === 'host' ? 'host.H' : 'remote.J')));
    const valid = payload({ expires_at: Date.now() + 60_000 });
    send(retired, { type: 'ice.config', from: 'P'.repeat(22), payload: valid });
    assert.deepEqual(plain(owner.iceProvisioning.configuration()), plain(api.iceConfiguration), 'a peer cannot supply TURN credentials');
    send(retired, { type: 'ice.config', payload: valid });
    assert.equal(owner.iceProvisioning.configuration().iceServers[0].username, 'ephemeral-test-user');
    owner.connectSignaling();
    const replacement = owner.state.socket;
    assert.notEqual(replacement, retired); assert.equal(retired.readyState, 3);
    send(retired, { type: 'ice.config', payload: valid });
    assert.deepEqual(plain(owner.iceProvisioning.configuration()), plain(api.iceConfiguration), 'a retired callback cannot configure its replacement');
    send(replacement, { type: 'ice.config', payload: valid });
    assert.equal(owner.iceProvisioning.configuration().iceTransportPolicy, 'all');
  });
}

test('diagnostics sanitize only the actual selected pair and finite stage/failure vocabularies', async () => {
  const reports = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', localCandidateId: 'relay', remoteCandidateId: 'peer', state: 'succeeded' }],
    ['unused', { type: 'candidate-pair', localCandidateId: 'direct', remoteCandidateId: 'peer', state: 'succeeded' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: '10.0.0.1', port: 12345, url: 'turns:secret.invalid' }],
    ['peer', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '10.0.0.2', usernameFragment: 'private' }],
    ['direct', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
  ]);
  const pc = { iceConnectionState: 'connected', iceGatheringState: 'complete', connectionState: 'connected', getStats: async () => reports };
  const diagnostics = transportFixture().createConnectionDiagnostics(pc);
  diagnostics.channels({ control: { readyState: 'open' }, bulk: { readyState: 'open' } });
  diagnostics.stage('transport'); diagnostics.stage('transport'); diagnostics.stage('password=secret');
  const snapshot = await diagnostics.capture();
  assert.deepEqual(plain(snapshot.selected_pair), { local_type: 'relay', remote_type: 'host', protocol: 'udp', relay_protocol: 'tls' });
  assert.equal(snapshot.stages.length, 1);
  assert.equal(snapshot.stages[0].stage, 'transport');
  assert.ok(Number.isFinite(snapshot.stages[0].elapsed_ms) && snapshot.stages[0].elapsed_ms >= 0);
  assert.equal(snapshot.control_state, 'open'); assert.equal(snapshot.bulk_state, 'open');
  assert.ok(!/10\.0\.0|12345|secret|username|password|credential|sdp/i.test(JSON.stringify(snapshot)));
  snapshot.selected_pair.local_type = 'host'; snapshot.stages[0].stage = 'injected';
  assert.equal(diagnostics.snapshot().selected_pair.local_type, 'relay');
  assert.equal(diagnostics.snapshot().stages[0].stage, 'transport');
  diagnostics.fail('wrong_password'); assert.equal(diagnostics.snapshot().failure_code, 'wrong_password');
  diagnostics.fail('private-user=Alice'); assert.equal(diagnostics.snapshot().failure_code, 'protocol_error');
});

test('attaching a negotiated peer preserves signaling and waiting-offer timing', () => {
  const diagnostics = transportFixture().createConnectionDiagnostics();
  diagnostics.stage('signaling'); diagnostics.stage('waiting_offer');
  diagnostics.attachPeer({ iceConnectionState: 'checking', iceGatheringState: 'gathering', connectionState: 'connecting' });
  diagnostics.stage('transport');
  const snapshot = diagnostics.snapshot();
  assert.deepEqual(plain(snapshot.stages.map(row => row.stage)), ['signaling', 'waiting_offer', 'transport']);
  assert.equal(snapshot.ice_state, 'checking'); assert.equal(snapshot.connection_state, 'connecting');
  assert.ok(snapshot.stages[2].elapsed_ms >= snapshot.stages[0].elapsed_ms);
});

test('unsupported/unselected stats stay unknown and retired asynchronous captures cannot publish evidence', async () => {
  const api = transportFixture();
  const unavailable = api.createConnectionDiagnostics({ connectionState: 'injected-secret', getStats: async () => { throw new Error('unsupported-private'); } });
  assert.equal((await unavailable.capture()).connection_state, 'unknown');
  assert.equal(unavailable.snapshot().selected_pair, null);
  const unselected = api.createConnectionDiagnostics({ getStats: async () => new Map([
    ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'relay' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay' }],
  ]) });
  assert.equal((await unselected.capture()).selected_pair, null, 'a gathered/succeeded candidate is not selection proof');
  let finish;
  const retired = api.createConnectionDiagnostics({ getStats: () => new Promise(resolve => { finish = resolve; }) });
  const capture = retired.capture(); retired.dispose();
  finish(new Map([
    ['pair', { type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'relay' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay' }],
  ]));
  assert.equal((await capture).selected_pair, null);
  retired.stage('ready'); assert.equal(retired.snapshot().stages.length, 0);
});
