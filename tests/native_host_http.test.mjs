import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { main, rejectingProxy } from './run_native_host_http.mjs';

test('offline proxy rejects both HTTP/CONNECT, records only hostnames and closes without forwarding', async () => {
  const proxy = await rejectingProxy();
  try {
    for (const method of ['GET', 'CONNECT']) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request(proxy.endpoint, {method, path: method === 'CONNECT' ? 'api.example.test:443' : 'http://api.example.test/private?token=synthetic',
          headers: {Authorization: 'synthetic-private-token'}});
        request.on('response', response => {response.resume(); resolve(response.statusCode);});
        request.on('connect', (response, socket) => {socket.destroy(); resolve(response.statusCode);});
        request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('fixture deadline'))); request.end();
      });
      assert.equal(status, 503);
    }
    assert.deepEqual(proxy.requests, ['api.example.test', 'api.example.test']);
  } finally { await proxy.close(); }
});

test('current host-native Rust HTTP integration executes with all diagnostics terminating locally', async () => {
  assert.equal(await main(), 0);
});
