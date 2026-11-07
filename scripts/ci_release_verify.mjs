import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from './ci_release.mjs';

export async function verifyReleaseBytes(manifest, directory) {
  assert.equal(manifest.schema_version, 1);
  const actual = await fs.readdir(directory, {withFileTypes: true});
  assert.ok(actual.every(entry => entry.isFile() && !entry.isSymbolicLink()));
  assert.deepEqual(actual.map(entry => entry.name).sort(), manifest.assets.map(asset => asset.name).sort());
  for (const asset of manifest.assets) {
    assert.equal(path.basename(asset.name), asset.name);
    const file = path.join(directory, asset.name);
    assert.equal((await fs.stat(file)).size, asset.size, `Wrong size: ${asset.name}`);
    assert.equal(await digest(file), asset.digest, `Wrong SHA-256: ${asset.name}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyReleaseBytes(JSON.parse(await fs.readFile(process.argv[2], 'utf8')), process.argv[3]);
}
