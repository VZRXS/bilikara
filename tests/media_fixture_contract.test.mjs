// Explicit real TEST-oracle entry. A declared missing prefix must fail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { root } from './desktop_construction_support.mjs';
import { generateFixtures } from '../media-libav/generate_fixtures.mjs';

const prefix = process.env.BILIKARA_TEST_MEDIA_PREFIX;
assert.ok(prefix && path.isAbsolute(prefix), 'BILIKARA_TEST_MEDIA_PREFIX must be an explicit same-build TEST-oracle prefix');
test('real fixture encoding, independent inventory/mutations and repeated bytes', async t => {
  const out = mkdtempSync(path.join(tmpdir(), 'media fixtures 中文 $() & '));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeFileSync(path.join(out, 'unrelated.txt'), 'keep');
  const options = { prefix, h264Source: path.join(root, 'media-libav/fixtures/synthetic.h264'), out };
  await generateFixtures(options);
  const names = ['aac.m4a', 'audio.flac', 'av.mp4', 'flac.mp4', 'local.ffconcat', 'missing-mdat.m4a', 'network.m3u8', 'outside.wav', 'synthetic.wav', 'truncated.mp4', 'unknown-duration.flac', 'unknown.bin', 'unrelated.txt', 'video.mp4'];
  assert.deepEqual(readdirSync(out).sort(), names);
  const before = Object.fromEntries(names.map(name => [name, readFileSync(path.join(out, name))]));
  const wave = before['synthetic.wav'];
  assert.equal(wave.length, 576044); assert.equal(wave.readUInt32LE(24), 96000); assert.equal(wave.readUInt16LE(34), 24);
  // Accepted original fixture samples: 0, 65207, 130136, 194512, repeated stereo.
  assert.equal(wave.subarray(44, 68).toString('hex'), '000000000000b7fe00b7fe0058fc0158fc01d0f702d0f702');
  assert.deepEqual(before['truncated.mp4'], before['aac.m4a'].subarray(0, 64));
  assert.equal(before['unknown.bin'].toString(), 'not a media container\n');
  const raw = before['audio.flac'], unknown = before['unknown-duration.flac'];
  assert.equal(unknown.readBigUInt64BE(18) & ((1n << 36n) - 1n), 0n);
  assert.deepEqual(raw.subarray(0, 18), unknown.subarray(0, 18)); assert.deepEqual(raw.subarray(26), unknown.subarray(26));
  const aac = before['aac.m4a'], damaged = before['missing-mdat.m4a']; let pos = 0;
  while (aac.subarray(pos + 4, pos + 8).toString() !== 'mdat') { const size = aac.readUInt32BE(pos); assert.ok(size >= 8 && pos + size + 8 <= aac.length); pos += size; }
  assert.equal(damaged.subarray(pos + 4, pos + 8).toString(), 'free');
  assert.deepEqual(aac.subarray(0, pos + 4), damaged.subarray(0, pos + 4)); assert.deepEqual(aac.subarray(pos + 8), damaged.subarray(pos + 8));
  assert.equal(before['local.ffconcat'].toString(), "ffconcat version 1.0\nfile 'audio.flac'\n");
  assert.equal(before['network.m3u8'].toString(), '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/forbidden\n#EXT-X-ENDLIST\n');
  await generateFixtures(options); for (const name of names) assert.deepEqual(readFileSync(path.join(out, name)), before[name], name);
});
