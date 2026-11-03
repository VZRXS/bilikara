import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const room = readFileSync(new URL('../static/internet-remote-host.js', import.meta.url), 'utf8');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));

// Execute the production request functions in their own realm. Missing timeout
// never mutates Node's AbortSignal or any other test's browser globals.
function fixture(kind) {
  const timers = new Map(), signals = [], events = [];
  let next = 0, mode = 'success', liveListeners = 0;
  const state = kind === 'state' ? { data: null, remoteAccessRequestSequence: 0, localPreferencesHydrated: true }
    : { busy: false, roomId: '', password: '' };
  const success = kind === 'state' ? { ok: true, data: { player_settings: {}, remote_access: { qr_image: 'local QR' } } }
    : { room_id: 'r'.repeat(27), created_at: 1000, expires_at: 1000 + 3600000 };
  const noop = () => {};
  const context = vm.createContext({
    AbortSignal: {}, AbortController, performance, console, state, window: {},
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      signals.push(options.signal);
      const response = { status: mode === 'http' ? 503 : 200, ok: mode !== 'http', json: async () => {
        if (mode === 'json') throw new SyntaxError('invalid JSON');
        if (mode === 'body') return hang(options.signal);
        return mode === 'http' ? { ok: false, error: 'fixture unavailable' } : success;
      } };
      if (mode === 'network') throw new TypeError('fixture network failure');
      if (mode === 'fetch') return hang(options.signal);
      return response;
    },
    async parseApiResponse(response) { return response.json(); },
    currentAvOffsetMs: () => 0, clientHeaders: () => ({ 'X-Fixture': 'host' }),
    localizedApiMessage: value => value, t: value => value,
    updateRemoteAccessFailure: failure => { state.remoteAccessFailure = failure; },
    validatedHostSnapshotIdentity: () => true,
    acceptHostStateSnapshot: data => { state.data = data; return true; },
    scheduleStartupAppUpdateCheck: noop, syncLocalPlayerSettingsFromSnapshot: noop,
    scheduleFavlistBrowseReloadFromState: noop, renderSignatureForData: JSON.stringify,
    render: noop, hasDownloadingItems: () => false, resyncMountedLocalPlayerIfOffsetChanged: noop,
    roomCreationProblem: () => '', elements: { password: { value: '1234' }, duration: { value: '1' } },
    MIN_ROOM_LIFETIME_HOURS: 1, MAX_ROOM_LIFETIME_HOURS: 24, MILLISECONDS_PER_HOUR: 3600000,
    SIGNAL_ORIGIN: 'https://signaling.invalid',
    transport: { randomBase64Url: count => 'x'.repeat(count), sha256: async () => 'fixture hash' },
    tr: (_key, fallback, args = {}) => fallback.replace('{error}', args.error || ''),
    setStatus: (message, tone) => events.push({ message, tone }), notifyAction: noop,
    recordDiagnostic: noop, connectSignaling: noop, expireRoom: noop,
    async localPost(url) { assert.equal(url, '/api/internet-remote/qr'); return { image: 'locally generated QR' }; },
    async stopRoom() { clearRoom(); },
  });
  function clearRoom() { timers.delete(state.expiryTimer); state.roomId = ''; state.qrImage = ''; }
  function hang(signal) {
    assert.ok(signal, 'a real cancelable signal must reach fetch/body consumption');
    return new Promise((resolve, reject) => {
      liveListeners++;
      signal.addEventListener('abort', () => { liveListeners--; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }
  vm.runInContext(kind === 'state'
    ? slice(app, 'async function fetchState()', 'function renderSignatureForData')
    : slice(room, 'function diagnosticError(', 'function pageOriginClass')
      + slice(room, 'async function startRoom()', 'function expireRoom'), context);
  return { state, signals, events, timers, context, clearRoom,
    mode(value) { mode = value; },
    run: () => context[kind === 'state' ? 'fetchState' : 'startRoom'](),
    expire() { const entry = [...timers].find(([, timer]) => timer.ms === (kind === 'state' ? 10000 : 15000));
      assert.ok(entry, 'original deadline must remain scheduled'); timers.delete(entry[0]); entry[1].fn(); },
    clean() { assert.equal([...timers.values()].filter(t => t.ms <= 15000).length, 0); assert.equal(liveListeners, 0); },
  };
}

for (const kind of ['state', 'room']) {
  test(`${kind}: missing AbortSignal.timeout still succeeds and clears its deadline`, async () => {
    const f = fixture(kind); await f.run();
    assert.equal(f.signals.length, 1, 'request must actually reach fetch');
    assert.equal(f.signals[0].aborted, false); f.clean();
    assert.ok(kind === 'state' ? f.state.hasValidStateResponse : f.state.qrImage);
    f.clearRoom(); assert.equal(f.timers.size, 0);
  });
  for (const phase of ['fetch', 'body']) test(`${kind}: ${phase} timeout cancels, cleans up and recovers`, async () => {
    const f = fixture(kind); f.mode(phase);
    const pending = kind === 'state' ? assert.rejects(f.run(), { name: 'AbortError' }) : f.run();
    await tick(); f.expire(); await pending;
    assert.equal(f.signals[0].aborted, true); f.clean();
    if (kind === 'state') { assert.equal(f.state.hasValidStateResponse, undefined); assert.ok(f.state.remoteAccessFailure); }
    else { assert.equal(f.state.busy, false); assert.equal(f.state.roomId, ''); assert.equal(f.state.roomFailure, true); assert.ok(f.events.some(e => e.tone === 'bad')); }
    f.mode('success'); await f.run(); f.clean();
    assert.ok(kind === 'state' ? f.state.hasValidStateResponse : f.state.qrImage);
    f.clearRoom(); assert.equal(f.timers.size, 0);
  });
  for (const mode of ['http', 'json', 'network']) test(`${kind}: ${mode} failures remain visible and clear timers`, async () => {
    const f = fixture(kind); f.mode(mode);
    if (kind === 'state') await assert.rejects(f.run()); else await f.run();
    f.clean(); assert.equal(f.signals[0].aborted, false);
    if (kind === 'room') { assert.equal(f.state.roomFailure, true); assert.equal(f.state.busy, false); assert.ok(f.events.some(e => e.tone === 'bad')); }
    f.mode('success'); await f.run(); f.clean(); f.clearRoom(); assert.equal(f.timers.size, 0);
  });
}

const bootstrap = readFileSync(new URL('../static/android-alpha.js', import.meta.url), 'utf8');
for (const missing of ['AbortController', 'Object.hasOwn', 'Array.prototype.at', 'String.prototype.replaceAll', 'Promise.allSettled']) {
  test(`Android bootstrap explains missing ${missing} before Host IPC, with automatic diagnostics`, async () => {
    const status = { textContent: '' }; let invoked = false, navigated = false;
    const context = vm.createContext({ AbortController, document: { getElementById: id => id === "bootstrap-status" ? status : null },
      window: { __TAURI__: { core: { invoke(name) { if (name === "android_alpha_status") invoked = true; return Promise.resolve(); } } }, location: { replace() { navigated = true; } } } });
    vm.runInContext(`${missing} = undefined`, context);
    await vm.runInContext(bootstrap, context);
    assert.equal(invoked, false); assert.equal(navigated, false);
    assert.match(status.textContent, /Android System WebView.*兼容性自检/);
    assert.doesNotMatch(status.textContent, /系统应用商店|请更新/u);
    assert.match(status.textContent, /无需清除应用数据/);
  });
}
