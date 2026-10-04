import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { archiveMetadata, readMetadata, serializeMetadata, verifyMetadata } from '../scripts/tool_asset_metadata.mjs';
import { root, runNative } from './desktop_construction_support.mjs';

const sha = '0123456789abcdef'.repeat(4);
const args = ['arm64', 'aria2 中文 🐱.tar.gz', 'https://example.test/aria2/中文', sha,
  '1.37.0', 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz',
  '60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b',
  'portable-macos-appletls-v2', 'bilikara/tools/aria2/archive.tar.gz', 'bilikara/tools/aria2/metadata.json'];
const command = path.join(root, 'scripts/tool_asset_metadata.mjs');
const invoke = values => runNative(process.execPath, [command, ...values], process.env, 10_000);

test('metadata preserves all fourteen independent fields and the previous ASCII JSON bytes', () => {
  const data = archiveMetadata(args);
  assert.deepEqual(data, { schema_version: 2, tool: 'aria2c', provider: 'bilikara-r2', platform: 'darwin',
    arch: 'arm64', name: args[1], url: args[2], sha256: sha, version: '1.37.0', source_url: args[5],
    source_sha256: args[6], recipe_revision: 'portable-macos-appletls-v2', object_key: args[8], metadata_object_key: args[9] });
  const serialized = serializeMetadata(data);
  assert.equal(serialized, `{
  "arch": "arm64",
  "metadata_object_key": "bilikara/tools/aria2/metadata.json",
  "name": "aria2 \\u4e2d\\u6587 \\ud83d\\udc31.tar.gz",
  "object_key": "bilikara/tools/aria2/archive.tar.gz",
  "platform": "darwin",
  "provider": "bilikara-r2",
  "recipe_revision": "portable-macos-appletls-v2",
  "schema_version": 2,
  "sha256": "${sha}",
  "source_sha256": "60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b",
  "source_url": "https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz",
  "tool": "aria2c",
  "url": "https://example.test/aria2/\\u4e2d\\u6587",
  "version": "1.37.0"
}\n`);
});

test('native CLI keeps Unicode paths/arguments and refuses incomplete or injectable success output', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aria2 metadata 中文 ; $() '));
  // Quotes are legal POSIX filenames but forbidden by the Windows filesystem.
  // Both paths retain Unicode, spaces and shell metacharacters passed as argv.
  const file = path.join(directory, process.platform === 'win32' ? 'metadata & $() 中文.json' : 'metadata " 中文.json');
  try {
    let result = await invoke(['write', file, ...args]);
    assert.equal(result.status, 0, result.stderr);
    const saved = readFileSync(file);
    assert.deepEqual(readMetadata(file), archiveMetadata(args));
    for (const [field, value] of [['name', args[1]], ['url', args[2]], ['sha256', sha], ['object_key', args[8]], ['metadata_object_key', args[9]]]) {
      result = await invoke(['read', file, field]);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, value + '\n');
    }
    assert.equal((await invoke(['check', file, 'arm64'])).status, 0);
    assert.notEqual((await invoke(['check', file, 'x64'])).status, 0);
    for (const values of [args.slice(1), args.map((v, i) => i === 1 ? 'bad\nENV=value' : v), args.map((v, i) => i === 2 ? 'http://example.test' : v)]) {
      result = await invoke(['write', file, ...values]);
      assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
      assert.deepEqual(readFileSync(file), saved, 'invalid input must leave existing metadata unchanged');
    }
    assert.notEqual((await invoke(['read', file, 'authorization'])).status, 0);
    writeFileSync(file, '{'); assert.notEqual((await invoke(['read', file, 'name'])).status, 0);
    writeFileSync(file, ' '.repeat(65537)); assert.throws(() => readMetadata(file), /64 KiB/);
    writeFileSync(file, JSON.stringify({ name: 'bad\r\nENV=value' }));
    result = await invoke(['read', file, 'name']); assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('locked metadata rejects wrong schema/target/TLS/digest and both current architecture pins remain independent', () => {
  for (const [arch, expected] of [['arm64', 'c65d5a04e7cfe6703940db63d3a25b9caa1bbbf8a84a4aff936d280d7d6b18eb'], ['x64', '33985c31bdc342c7745d2aebe1672d52d40dcbcb0dd5c8016f148faf53a0277f']]) {
    const data = readMetadata(path.join(root, `tools/aria2/macos-${arch}.json`));
    verifyMetadata(data, arch);
    assert.equal(data.tool, 'aria2c'); assert.equal(data.version, '1.37.0'); assert.equal(data.platform, 'darwin');
    assert.equal(data.sha256, expected); assert.ok(data.url.includes(data.name)); assert.ok(data.recipe_revision);
    for (const replacement of [{schema_version: 1}, {arch: 'other'}, {url: 'http://example.test'}, {sha256: 'short'}]) {
      assert.throws(() => verifyMetadata({...data, ...replacement}, arch));
    }
  }
});

test('staged macOS README checker accepts original bytes and refuses each missing required contract', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'macOS README 中文 '));
  try {
    const file = path.join(directory, 'README.txt'); const text = readFileSync(path.join(root, 'README-macOS.txt'), 'utf8');
    const check = () => runNative(process.execPath, [path.join(root, 'scripts/check_macos_bundle_readme.mjs'), file], process.env, 10_000);
    writeFileSync(file, text); assert.equal((await check()).status, 0);
    for (const required of ['bilikara-desktop.app', 'bilikara-backend.app', 'license/', '隐私与安全性', '仍要打开']) {
      writeFileSync(file, text.replaceAll(required, 'removed')); assert.notEqual((await check()).status, 0);
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
