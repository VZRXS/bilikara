import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = name => readFileSync(new URL(`../static/${name}`, import.meta.url), 'utf8');
const candidate = index => ({ candidate: `candidate:${index} 1 udp 1 192.0.2.1 ${5000 + index} typ srflx`, sdpMid: '0', sdpMLineIndex: 0 });
const event = (type, values) => Object.assign(new Event(type), values);

// Only native ICE/signaling boundaries and unrelated UI are fixtures. Load both
// production owners verbatim; no authenticated native dispatch is fabricated.
function ownerFixture(role) {
  class Peer extends EventTarget {
    constructor() {
      super();
      this.iceGatheringState = 'gathering';
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.added = [];
    }
    createDataChannel(label) { return Object.assign(new EventTarget(), { label, readyState: 'connecting', close() {} }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { if (this.remoteGate) await this.remoteGate; this.remoteDescription = value; }
    async addIceCandidate(value) { assert.ok(this.remoteDescription, 'must wait for the remote description'); this.added.push(value); }
    close() { this.connectionState = 'closed'; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; this.frames = []; }
    send(value) { this.frames.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const storage = new Map();
  const sandbox = {
    console, crypto: webcrypto, TextEncoder, Event, CustomEvent, URLSearchParams, URL, Response, btoa,
    RTCPeerConnection: Peer, WebSocket: Socket,
    fetch: async () => { throw new Error('Unexpected HTTP request'); },
    location: { hash: `#room=${'R'.repeat(27)}&join=${'J'.repeat(43)}`, origin: 'https://remote.example.test', protocol: 'https:', hostname: 'remote.example.test' },
    localStorage: { getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {},
    // Deterministically reach the production gathering deadline; no long timers
    // or authentication retries escape this isolated fixture.
    setTimeout: (fn, ms) => ms === 8_000 ? setTimeout(fn, 1) : 0,
    clearTimeout, clearInterval,
    document: { readyState: 'loading', addEventListener() {}, documentElement: { dataset: {} } },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source('internet-remote-transport.js'), context);
  const host = role === 'host';
  const expose = host
    ? 'render = () => {}; setStatus = () => {}; window.owner = { state, peers, createPeer, connectSignaling, closePeer }; })();'
    : 'global.owner = { state, acceptOffer, connectSignaling, resetPeer }; })(globalThis);';
  vm.runInContext(source(host ? 'internet-remote-host.js' : 'remote-transport-client.js')
    .replace(host ? /\}\)\(\);\s*$/u : /\}\)\(globalThis\);\s*$/u, expose), context);
  const owner = sandbox.owner;
  if (host) Object.assign(owner.state, { stopped: false, roomId: 'R'.repeat(27), hostToken: 'H'.repeat(43), hostPeerId: 'P'.repeat(22) });
  else owner.state.connectButton = { disabled: false, dataset: {}, hasAttribute: () => false, removeAttribute() {} };
  owner.connectSignaling();
  return { owner, sandbox, peerId: 'P'.repeat(22) };
}

for (const role of ['host', 'remote']) {
  test(`${role} sends candidates gathered after the SDP deadline`, async () => {
    const { owner, peerId } = ownerFixture(role);
    if (role === 'host') await owner.createPeer(peerId);
    else await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
    const peer = role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer;
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
    const frames = owner.state.socket.frames;
    assert.deepEqual(frames.map(frame => frame.type), [role === 'host' ? 'offer' : 'answer', 'candidate']);
    assert.deepEqual(frames[1].payload, candidate(1));
    const before = frames.length;
    if (role === 'host') owner.closePeer(peerId, false);
    else owner.resetPeer();
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(2) } }));
    assert.equal(frames.length, before, 'a retired peer must not signal for its replacement');
  });
}

test('Host queues early candidates until the answer is applied, then preserves order', async () => {
  const { owner, peerId } = ownerFixture('host');
  await owner.createPeer(peerId);
  const peer = owner.peers.get(peerId).pc;
  const socket = owner.state.socket;
  let release;
  peer.remoteGate = new Promise(resolve => { release = resolve; });
  const incoming = (type, payload) => socket.dispatchEvent(event('message', { data: JSON.stringify({ from: peerId, type, payload }) }));
  incoming('candidate', candidate(1));
  incoming('answer', { type: 'answer', sdp: 'v=0\r\n' });
  incoming('candidate', candidate(2));
  assert.deepEqual(peer.added, []);
  release(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1), candidate(2)]);
  incoming('candidate', candidate(3)); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1), candidate(2), candidate(3)]);
  owner.closePeer(peerId, false);
  incoming('candidate', candidate(4)); await tick();
  assert.equal(peer.added.length, 3);
});

test('Remote consumes trickled candidates only from its current signaling socket', async () => {
  const { owner } = ownerFixture('remote');
  const retired = owner.state.socket;
  owner.connectSignaling();
  await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
  const peer = owner.state.peer;
  const frame = JSON.stringify({ from: 'H'.repeat(22), type: 'candidate', payload: candidate(1) });
  retired.dispatchEvent(event('message', { data: frame }));
  await tick(); assert.equal(peer.added.length, 0);
  owner.state.socket.dispatchEvent(event('message', { data: frame }));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1)]);
  owner.resetPeer();
});

test('retired Host signaling cannot expire the replacement room', () => {
  const { owner } = ownerFixture('host');
  const retired = owner.state.socket;
  owner.connectSignaling();
  const current = owner.state.socket;
  retired.dispatchEvent(event('close', { code: 4003 }));
  assert.equal(owner.state.socket, current);
  assert.equal(owner.state.expired, false);
  assert.equal(owner.state.stopped, false);
});

test('retired Remote signaling cannot overwrite the new connection status', () => {
  const { owner } = ownerFixture('remote');
  const retired = owner.state.socket;
  owner.connectSignaling();
  const initial = owner.state.connectionMessage;
  retired.dispatchEvent(event('open', {}));
  retired.dispatchEvent(event('error', {}));
  assert.equal(owner.state.connectionMessage, initial);
  assert.equal(owner.state.connectionIsError, false);
  owner.state.socket.dispatchEvent(event('open', {}));
  assert.equal(owner.state.connectionMessage, '等待 Host…');
});

test('candidate input and pre-answer queues are bounded, with no work for retired peers', async () => {
  const { sandbox } = ownerFixture('host');
  const peer = new sandbox.RTCPeerConnection();
  let current = true;
  const exchange = sandbox.BilikaraInternetTransport.createIceCandidateExchange(peer, {
    isCurrent: () => current, sendCandidate() {}, onError() { assert.fail('unexpected signaling failure'); },
  });
  for (const invalid of [null, 'candidate', {}, { candidate: 'x'.repeat(4097) }]) {
    await assert.rejects(exchange.addCandidate(invalid), /Invalid/);
  }
  for (let i = 0; i < 128; i++) await exchange.addCandidate(candidate(i));
  await assert.rejects(exchange.addCandidate(candidate(128)), /excessive/);
  assert.equal(peer.added.length, 0, 'no candidate can bypass description readiness');
  current = false;
  await exchange.addCandidate(candidate(129));
  await exchange.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\n' });
  assert.equal(peer.added.length, 0, 'retired queued work must not reach native ICE');
});

test('authenticated channels survive late ICE after signaling detaches', async () => {
  for (const role of ['host', 'remote']) {
    const { owner, peerId } = ownerFixture(role);
    if (role === 'host') await owner.createPeer(peerId);
    else await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
    const peer = role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer;
    if (role === 'host') owner.peers.get(peerId).authorized = true;
    else owner.state.authorized = true;
    const socket = owner.state.socket;
    socket.close();
    const before = socket.frames.length;
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
    assert.equal(socket.frames.length, before);
    assert.equal(peer.connectionState, 'new', 'late gathering must not close the live peer');
    assert.equal(role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer, peer);
    // Avoid native peer-close I/O: only the connection-boundary fixture is used.
    if (role === 'host') owner.peers.get(peerId).authorized = false;
    else owner.state.authorized = false;
    if (role === 'host') owner.closePeer(peerId, false);
    else owner.resetPeer();
  }
});

test('SDP candidates remain sufficient for legacy peers; empty end markers and send failures are handled', async () => {
  const { sandbox } = ownerFixture('host');
  const peer = new sandbox.RTCPeerConnection();
  const sent = [], errors = [];
  const exchange = sandbox.BilikaraInternetTransport.createIceCandidateExchange(peer, {
    isCurrent: () => true,
    sendCandidate: value => { if (value.candidate === 'fail') throw new Error('socket closed'); sent.push(value); },
    onError: error => errors.push(error.message),
  });
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
  assert.deepEqual(sent, [], 'early candidates stay in the initial SDP, avoiding redundant signaling');
  exchange.descriptionSent();
  peer.dispatchEvent(event('icecandidate', { candidate: null }));
  const end = { candidate: '', sdpMid: '0', sdpMLineIndex: 0 };
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => end } }));
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => ({ candidate: 'fail' }) } }));
  assert.deepEqual(sent, [end]); assert.deepEqual(errors, ['socket closed']);
  await exchange.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\n' });
  await exchange.addCandidate(end);
  assert.deepEqual(peer.added, [end]);
});
