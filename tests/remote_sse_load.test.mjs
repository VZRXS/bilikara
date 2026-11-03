import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { parseOptions, runLoad, summary } from '../tools/load_test_remote_sse.mjs';
import { runNative, root } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { RunningHost } from './native_host_support.mjs';

// Keep socket deadlines real while Node's test clock controls only the load
// duration and reconnect delay. A fixed wall window cannot prove two timeouts.
const realTimeout = globalThis.setTimeout;
async function fixture(handler) {
  const sockets = new Set(), requests = [], events = [], started = performance.now();
  let closed = 0;
  const event = (kind, client) => events.push({kind, client, ms: Math.round(performance.now() - started)});
  const server = http.createServer((request, response) => {
    requests.push({method: request.method, path: request.url, headers: request.headers});
    event('request', new URL(request.url, 'http://fixture').searchParams.get('client_id'));
    handler(request, response, requests.length);
  });
  server.on('connection', socket => {sockets.add(socket); socket.on('close', () => {sockets.delete(socket); closed++; event('close');});});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {requests, sockets, events, get closed() {return closed;}, base: `http://127.0.0.1:${server.address().port}`,
    async waitFor(predicate) {
      const deadline = performance.now() + 2000;
      while (!predicate()) {
        assert.ok(performance.now() < deadline, 'bounded real socket lifecycle: ' + JSON.stringify(events));
        await new Promise(resolve => realTimeout(resolve, 5));
      }
      // Let the client error/abort continuations settle before advancing time.
      await new Promise(setImmediate);
    },
    async close() {for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));}};
}
const args = base => parseOptions([base, '--clients', '4', '--duration', '.8', '--connect-timeout', '1', '--reconnect-delay', '.25']);

test('load CLI keeps aliases/defaults/IPv6/base paths and rejects ambiguous, nonfinite and invalid inputs', async () => {
  assert.equal(parseOptions([]).url.href, 'http://127.0.0.1:8080/');
  assert.equal(parseOptions(['--host', '::1', '--port', '8899']).url.href, 'http://[::1]:8899/');
  assert.equal(parseOptions(['127.0.0.1:8899/path/']).url.pathname, '/path/');
  assert.equal(parseOptions(['https://example.test']).url.protocol, 'https:');
  for (const argv of [['http://x', '--host', 'y'], ['--port', '0'], ['--port', '65536'], ['--clients', '0'], ['--clients', '1.5'],
    ['--duration', '0'], ['--duration', 'Infinity'], ['--connect-timeout', 'NaN'], ['--reconnect-delay', '.24'], ['--duration'], ['--unknown'],
    ['http://x/path?q=x'], ['http://x/#x'], ['ftp://x'], ['http://x:99999'], ['first', 'second']]) assert.throws(() => parseOptions(argv));
  const cli = path.join(root, 'tools/load_test_remote_sse.mjs');
  for (const [argv, status] of [[['--help'], 0], [['--clients', '0'], 2]]) assert.equal((await runNative(process.execPath, [cli, ...argv], process.env)).status, status);
});

test('concurrent read-only streams retain multiline, fragmented UTF-8, state revisions, reconnects and clean shutdown', async () => {
  const service = await fixture((request, response) => {
    response.writeHead(200, {'Content-Type': 'Text/Event-Stream; charset=utf-8'});
    const frame = Buffer.from(':comment\r\nevent: state\r\ndata: {"state_revision":\r\ndata: "7","title":"中文"}\r\n\r\nevent: state\ndata: invalid\n\nevent: state\ndata: {"state_revision":-2}\n\nevent:\ndata: hello\n\ndata: unfinished');
    const split = frame.indexOf(Buffer.from('中')) + 1;
    response.write(frame.subarray(0, split)); response.end(frame.subarray(split));
  });
  try {
    const result = await runLoad(args(service.base + '/base 中文'));
    assert.equal(result.status, 0);
    for (const stats of result.snapshots) {
      assert.equal(stats.connected, true); assert.equal(stats.errors, 0); assert.ok(stats.successful_connections >= 2);
      assert.equal(stats.events, stats.successful_connections * 4); assert.equal(stats.state_events, stats.successful_connections * 3);
      assert.equal(stats.revisionMin, 7); assert.equal(stats.revisionMax, 7);
      assert.equal(stats.disconnects, stats.successful_connections); assert.equal(stats.reconnects, stats.attempts - 1);
    }
    for (const request of service.requests) {
      assert.equal(request.method, 'GET'); assert.match(request.path, /^\/base%20%E4%B8%AD%E6%96%87\/api\/events\?client_id=load-test-[1-4]$/);
      assert.equal(request.headers.accept, 'text/event-stream'); assert.equal(request.headers['cache-control'], 'no-cache');
      assert.equal(request.headers['user-agent'], 'bilikara-remote-sse-load-test/1'); assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined);
    }
    assert.match(summary(result), /requested clients: 4\n  successful clients: 4/); assert.match(summary(result), /errors: 0/);
    assert.ok(result.runtime < 2, 'bounded run and owned socket shutdown');
  } finally {await service.close();}
});

test('HTTP, wrong content type, interrupted and quiet timed-out streams fail and retry without lingering sockets', async t => {
  for (const mode of ['status', 'type', 'interrupted', 'quiet']) {
    const service = await fixture((_request, response) => {
      if (mode === 'status') {response.writeHead(503); response.end('offline');}
      else if (mode === 'type') {response.writeHead(200, {'Content-Type': 'text/plain'}); response.end('wrong');}
      else {response.writeHead(200, {'Content-Type': 'text/event-stream'}); response.flushHeaders(); if (mode === 'interrupted') response.destroy();}
    });
    t.mock.timers.enable({apis: ['setTimeout']});
    const controlledDelay = timersPromises.setTimeout;
    const reconnects = t.mock.method(timersPromises, 'setTimeout', (...arguments_) => controlledDelay(...arguments_));
    syncBuiltinESMExports();
    const run = runLoad({...args(service.base), duration: mode === 'quiet' ? .8 : .4, connectTimeout: .08});
    let result;
    try {
      // Server-side close can precede the client's error continuation. A
      // registered reconnect delay proves that continuation consumed the error.
      await service.waitFor(() => service.closed === 4 && reconnects.mock.callCount() === 4);
      t.mock.timers.tick(249); await new Promise(setImmediate);
      assert.equal(service.requests.length, 4, 'no retry before the configured 250ms delay');
      t.mock.timers.tick(1);
      await service.waitFor(() => service.closed === 8 && reconnects.mock.callCount() === 8);
      if (mode === 'quiet') {
        // Cancel real open sockets too, not only sleeping reconnect tasks.
        t.mock.timers.tick(250);
        await service.waitFor(() => service.requests.length === 12 && service.sockets.size === 4);
        t.mock.timers.tick(300);
      } else {
        // Stop sleeping clients before their third admission at mock time 500ms.
        t.mock.timers.tick(150);
      }
      result = await run;
      assert.equal(result.status, 1, mode);
      for (const stats of result.snapshots) {
        assert.equal(stats.errors, 2, mode);
        assert.equal(stats.attempts, mode === 'quiet' ? 3 : 2, mode);
        assert.equal(stats.reconnects, stats.attempts - 1, mode); assert.ok(stats.last_error, mode);
        if (mode === 'quiet') {assert.ok(stats.successful_connections >= 2); assert.equal(stats.last_error, 'connection timed out');}
      }
      await service.waitFor(() => service.sockets.size === 0);
      assert.equal(service.closed, mode === 'quiet' ? 12 : 8, 'every owned socket closes');
    } catch (error) {
      t.mock.timers.tick(800); result ??= await run;
      t.diagnostic(JSON.stringify({mode, node: process.version, platform: process.platform,
        runtime: result?.runtime, clients: result?.snapshots, events: service.events,
        registeredReconnects: reconnects.mock.callCount(), openSockets: service.sockets.size}));
      throw error;
    } finally {t.mock.timers.tick(800); await run; t.mock.reset(); t.mock.timers.reset(); syncBuiltinESMExports(); await service.close();}
  }
});

test('the same read-only CLI preserves native Host authorization refusal with isolated data', async () => {
  const executable = await buildNativeHost(), home = mkdtempSync(path.join(os.tmpdir(), 'sse load 中文 '));
  let host;
  try {
    host = await RunningHost.start(executable, home, ['--headless', '--no-browser', '--port', '0', '--data-dir', path.join(home, 'data'), '--static-dir', path.join(root, 'static')]);
    const result = await runNative(process.execPath, [path.join(root, 'tools/load_test_remote_sse.mjs'), host.base,
      '--clients', '2', '--duration', '.55', '--connect-timeout', '1', '--reconnect-delay', '.25'], process.env, 10000);
    assert.equal(result.status, 1); assert.match(result.stdout, /successful clients: 0/); assert.match(result.stdout, /HTTP 403/);
    assert.equal((await host.api('/api/state')).playlist.length, 0, 'load tool causes no product mutation');
  } finally {if (host) await host.close(); rmSync(home, {recursive: true, force: true});}
});
