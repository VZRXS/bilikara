import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const bootstrap = readFileSync(new URL('../static/android-alpha.js', import.meta.url), 'utf8');
const native = readFileSync(new URL('../src-tauri/gen/android/app/src/main/java/com/bilikara/app/HostWebViewDiagnostics.kt', import.meta.url), 'utf8');
const probe = /internal val PROBE = """([\s\S]*?)"""\.trimIndent\(\)/u.exec(native)[1];
const valid = {schema_version: 3, stage: 'native-host-alpha', backend: 'rust', revision: 0,
  host_api_ready: true, persistence_ready: true, playback_ready: true, window_controls_ready: true,
  bootstrap_url: 'http://127.0.0.1:12345/bootstrap/' + 'a'.repeat(43)};

function fixture({inert = true, css = () => true, invoke = async () => valid} = {}) {
  const listeners = {}, status = {textContent: ''}, attributes = new Map();
  const button = {disabled: false, addEventListener: (name, handler) => {listeners[name] = handler;},
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key)};
  let destination;
  const context = vm.createContext({URL, AbortController, crypto: {getRandomValues() {}}, ResizeObserver: function () {}, Element: {prototype: {getAnimations() {}}}, CSS: {supports: css},
    navigator: {userAgent: 'Fixture: no Android/device acceptance'},
    document: {getElementById: id => id === 'bootstrap-status' ? status : id === 'webview-diagnostics' ? button : null,
      documentElement: {getAttribute: () => null}, createElement: () => inert ? {inert: false} : {}},
    window: {__TAURI__: {core: {invoke}}, location: {replace: url => {destination = url;}}}});
  return {context, button, status, attributes, click: () => listeners.click(), destination: () => destination};
}

for (const [label, options] of [
  ['inert', {inert: false}],
  ...['selector(:has(*))', 'height: 100dvh', 'color: color-mix(in srgb, black, white)']
    .map(rule => [rule, {css: value => value !== rule}]),
]) test(`full Android bootstrap and native diagnostic probe reject missing ${label}`, async () => {
  const f = fixture(options);
  await vm.runInContext(bootstrap, f.context);
  assert.equal(f.destination(), undefined);
  assert.match(f.status.textContent, /Chromium 111.*兼容性自检/u);
  assert.match(f.status.textContent, /标准模式/u);
  assert.match(f.status.textContent, /进入兼容模式/u);
  assert.doesNotMatch(f.status.textContent, /latest|legacy/u);
  const report = JSON.parse(vm.runInContext(probe, f.context));
  assert.equal(report.missing.length, 1);
});

test('diagnosis remains clickable when startup is blocked; duplicate activation and errors recover', async () => {
  let resolve, reject, calls = 0;
  const f = fixture({inert: false, invoke(name) {
    assert.equal(name, 'android_webview_diagnostics'); calls++;
    return new Promise((ok, bad) => {resolve = ok; reject = bad;});
  }});
  await vm.runInContext(bootstrap, f.context);
  assert.equal(calls, 1, 'blocked startup automatically opens diagnostics');
  resolve(); await Promise.resolve(); calls = 0;
  const first = f.click();
  assert.equal(f.button.disabled, true); assert.equal(f.attributes.get('aria-busy'), 'true');
  await f.click(); assert.equal(calls, 1);
  resolve(); await first;
  assert.equal(f.button.disabled, false); assert.equal(f.attributes.has('aria-busy'), false);
  const second = f.click(); reject(new Error('native fixture failure')); await second;
  assert.match(f.status.textContent, /native fixture failure/u);
  assert.equal(f.button.disabled, false); assert.equal(f.attributes.has('aria-busy'), false);
});

test('working frontend primitives do not conceal an unavailable native bridge', async () => {
  const f = fixture({invoke: async () => ({...valid, window_controls_ready: false})});
  await vm.runInContext(bootstrap, f.context);
  assert.equal(f.destination(), undefined);
  assert.match(f.status.textContent, /原生消息桥未就绪/u);
});

test('supported capability fixture proceeds through the existing authenticated bootstrap', async () => {
  const f = fixture(); await vm.runInContext(bootstrap, f.context);
  assert.equal(f.destination(), valid.bootstrap_url);
  assert.equal(JSON.parse(vm.runInContext(probe, f.context)).missing.length, 0);
});

test('legacy requires an explicit action, keeps authentication, and rejects duplicate startup', async () => {
  let complete, hostCalls = 0, diagnoses = 0;
  const f = fixture({inert: false, invoke(name) {
    if (name === 'android_webview_diagnostics') { diagnoses++; return Promise.resolve(); }
    assert.equal(name, 'android_alpha_status'); hostCalls++;
    return new Promise(resolve => { complete = resolve; });
  }});
  await vm.runInContext(bootstrap, f.context);
  assert.equal(diagnoses, 1); assert.equal(hostCalls, 0); assert.equal(f.destination(), undefined);
  assert.equal(f.context.window.bilikaraStartLegacy(), true);
  assert.equal(f.context.window.bilikaraStartLegacy(), false);
  assert.equal(hostCalls, 1);
  complete(valid); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.destination(), valid.bootstrap_url + '?webviewMode=legacy');
});

test('legacy cannot bypass native readiness or malformed bootstrap URLs', async () => {
  for (const result of [{...valid, window_controls_ready: false}, {...valid, persistence_ready: false},
    {...valid, bootstrap_url: 'https://untrusted.invalid/bootstrap/' + 'a'.repeat(43)}]) {
    const f = fixture({inert: false, invoke: async name => name === 'android_alpha_status' ? result : undefined});
    await vm.runInContext(bootstrap, f.context);
    f.context.window.bilikaraStartLegacy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.destination(), undefined); assert.match(f.status.textContent, /启动检查失败/u);
  }
});
