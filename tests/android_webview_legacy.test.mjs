import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Deliberately use raw CDP: modern Playwright's injected JS itself requires a
// newer engine. This test must never pass by substituting a modern Chromium.
const executable = process.env.BILIKARA_TEST_LEGACY_CHROMIUM;
test('actual pre-93 Chromium can render the Android compatibility message before native IPC', {
  skip: !executable && 'Set BILIKARA_TEST_LEGACY_CHROMIUM to an isolated historic Chromium; no automatic download', timeout: 30000,
}, async t => {
  const profile = mkdtempSync(path.join(tmpdir(), 'bilikara-legacy-webview-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    const name = req.url === '/' ? 'android-alpha.html' : req.url.slice(1);
    if (!['android-alpha.html', 'android-alpha.js', 'android-alpha.css'].includes(name)) return res.writeHead(404).end();
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    // Same script/style restrictions as the packaged bootstrap; no unsafe-eval.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'");
    res.end(readFileSync(new URL('../static/' + name, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:1', '--proxy-bypass-list=127.0.0.1;localhost', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  let startupTimer;
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.stderr.on('data', data => {
      output = (output + data.toString()).slice(-8192);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(startupTimer); resolve(match[1]); }
    });
    startupTimer = setTimeout(() => reject(new Error('Historic Chromium startup deadline')), 15000);
  }).finally(() => clearTimeout(startupTimer));
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    const targets = await (await fetch('http://127.0.0.1:' + new URL(endpoint).port + '/json/list')).json();
    target = targets.find(candidate => candidate.type === 'page');
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'Historic browser must create the actual page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  t.after(() => socket.close());
  let sequence = 0;
  const pending = new Map(), errors = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.id) {
      const promise = pending.get(message.id); pending.delete(message.id);
      if (message.error) promise.reject(message.error); else promise.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++sequence, { resolve, reject }); socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  const facts = (await send('Runtime.evaluate', { expression: 'JSON.stringify({ua:navigator.userAgent,hasOwn:typeof Object.hasOwn})', returnByValue: true })).result.value;
  const observed = JSON.parse(facts);
  assert.ok(Number(/Chrome\/(\d+)/.exec(observed.ua)[1]) < 93, 'A modern engine is not historic WebView evidence');
  assert.equal(observed.hasOwn, 'undefined', 'Use an actual missing primitive, not a permanent global patch');
  const loaded = new Promise(resolve => {
    const listener = event => { if (JSON.parse(event.data).method === 'Page.loadEventFired') { socket.removeEventListener('message', listener); resolve(); } };
    socket.addEventListener('message', listener);
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await loaded;
  const status = (await send('Runtime.evaluate', { expression: 'document.getElementById("bootstrap-status").textContent', returnByValue: true })).result.value;
  assert.match(status, /Android System WebView.*WebView 兼容性自检/);
  assert.doesNotMatch(status, /系统应用商店|请更新/u);
  assert.match(status, /无需清除应用数据/);
  // An unsupported unit inside var()/env() survives parsing and fails only at
  // computed-value time, discarding an earlier declaration. Exercise the actual
  // shared safe-area bound in this genuinely old engine, not a modern mock.
  const boundRule = readFileSync(new URL('../static/styles.css', import.meta.url), 'utf8').split('\n')
    .find(line => line.includes('max-height:') && line.includes('env(safe-area-inset-top, 0px)') && line.includes('--legacy-vh'));
  const computed = (await send('Runtime.evaluate', { expression:
    '(function(){document.documentElement.style.setProperty("--legacy-vh","6px");var n=document.createElement("div");n.style.cssText='
      + JSON.stringify(boundRule) + ';document.body.appendChild(n);return getComputedStyle(n).maxHeight;})()', returnByValue: true })).result.value;
  assert.equal(computed, '552px', 'legacy safe-area bound survives computed-value validation');
  assert.deepEqual(errors, []);
});
