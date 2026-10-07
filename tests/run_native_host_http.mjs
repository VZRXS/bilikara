// Native Rust HTTP assertions with a rejecting local proxy, never forwarding
// diagnostics to public services. The driver owns no Host/business policy.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNativeHostHttp } from './native_runtime_artifacts.mjs';
import { runNative } from './desktop_construction_support.mjs';
import { isolatedEnvironment } from './native_host_support.mjs';

export async function rejectingProxy() {
  const requests = [], sockets = new Set();
  const server = http.createServer((request, response) => {
    try { requests.push(new URL(request.url).hostname); } catch { requests.push(null); }
    response.writeHead(503, {'Content-Length': '0'}); response.end();
  });
  server.on('connect', (request, socket) => {
    try { requests.push(new URL('http://' + request.url).hostname); } catch { requests.push(null); }
    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

export async function main() {
  const binary = await buildNativeHostHttp();
  const proxy = await rejectingProxy();
  const home = mkdtempSync(path.join(os.tmpdir(), 'native-http 中文 '));
  let result;
  try {
    const environment = isolatedEnvironment(home);
    for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) environment[name] = proxy.endpoint;
    for (const name of ['no_proxy', 'NO_PROXY']) environment[name] = 'localhost,127.0.0.1,::1';
    result = await runNative(binary, ['--nocapture'], environment, 180_000);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  } finally { await proxy.close(); rmSync(home, {recursive: true, force: true}); }
  const covered = ['api.bilibili.com', 'api.github.com', 'api.kevinx96.icu'].every(host => proxy.requests.includes(host));
  process.stdout.write(JSON.stringify({offline_connectivity_fixture: covered, destinations: [...new Set(proxy.requests)].sort(),
    forwarded_external_requests: 0, native_exit_code: result.status}) + '\n');
  return result.status || Number(!covered);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
