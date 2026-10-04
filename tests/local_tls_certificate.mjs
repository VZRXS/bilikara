// Test-owned CA/keys only; validates hostnames and never disables TLS verification.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runNative } from './desktop_construction_support.mjs';

export async function localCertificate(directory, hosts) {
  assert.ok(hosts.length && hosts.every(host => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(host)));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = name => path.join(directory, name);
  async function openssl(args) { const result = await runNative('openssl', args, process.env, 30000); assert.equal(result.status, 0, result.stderr); }
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('ca-key.pem'), '-out', file('ca.pem'), '-days', '1', '-subj', '/CN=Bilikara ephemeral test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('key.pem'), '-out', file('server.csr'), '-subj', `/CN=${hosts[0]}`]);
  writeFileSync(file('server.ext'), `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  await openssl(['x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca-key.pem'), '-CAcreateserial', '-out', file('cert.pem'), '-days', '1', '-extfile', file('server.ext')]);
  for (const name of ['ca-key.pem', 'key.pem']) chmodSync(file(name), 0o600);
  return directory;
}
