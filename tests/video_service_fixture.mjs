// Local HTTP/TLS fixture; CONNECT terminates here and never forwards traffic.
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './desktop_construction_support.mjs';

export async function localServer(handler) {
  const errors = [], sockets = new Set();
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); chunks.push(chunk); }
      const body = bytes ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const result = await handler(request, body);
      const data = result?.rawBody ?? Buffer.from(JSON.stringify(result?.data ?? result)); response.writeHead(result?.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...(result?.headers || {}) }); response.end(data);
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, errors, base: `http://127.0.0.1:${server.address().port}`, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); } };
}

export async function videoFixture(respond, certs = path.join(root, 'tests/fixtures/video_service'), postHandler) {
  const requests = [], posts = [], headers = [], tlsErrors = [];
  const fixture = await localServer(async (request, body) => {
    if (request.method === 'POST') { posts.push([request.url, body]); return postHandler ? postHandler(request, body) : { data: { success: true, added: 1 } }; }
    requests.push(request.url); headers.push([request.url, request.headers]);
    const reply = await respond(request.url, request.headers);
    return reply?.fixtureResponse ? reply.fixtureResponse : { data: reply };
  });
  const context = tls.createSecureContext({ cert: readFileSync(path.join(certs, 'cert.pem')), key: readFileSync(path.join(certs, 'key.pem')) });
  fixture.server.on('connect', (request, socket, head) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
    // Optional Host probes may reject this deliberately restricted certificate
    // for another domain. Record those refusals; never forward or bypass TLS.
    // Actual supported API failures are still asserted by the caller's routes.
    secure.on('error', error => tlsErrors.push({ target: request.url, code: error.code })); fixture.server.emit('connection', secure);
  });
  return { ...fixture, requests, headers, posts, tlsErrors, environment: { HTTP_PROXY: fixture.base, HTTPS_PROXY: fixture.base, ALL_PROXY: fixture.base, http_proxy: fixture.base, https_proxy: fixture.base, all_proxy: fixture.base, NO_PROXY: '', no_proxy: '', SSL_CERT_FILE: path.join(certs, 'ca.pem'), SSL_CERT_DIR: certs } };
}
