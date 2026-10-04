import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
import { pcmWave } from '../media-libav/fixture_audio.mjs';

const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;

test('explicit media entry uses the native driver; missing inputs fail before Cargo', async t => {
  const out = mkdtempSync(path.join(tmpdir(), 'media missing 中文 $() & '));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = await runNative(process.execPath, ['media-libav/test_comparison.mjs', '--out', out], environment);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /--companion requires an absolute native input/);
  assert.ok(!result.stdout.includes('skipped'));
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:media'], 'node media-libav/test_comparison.mjs');
  for (const document of ['COMPARISON.md', 'PACKET_SCAN.md', 'COPY_REMUX.md', 'FLAC_NORMALIZATION.md']) {
    const text = readFileSync(path.join(root, 'media-libav', document), 'utf8');
    assert.ok(text.includes('npm run test:media --')); assert.ok(!text.includes('test_comparison.py'));
  }
});

test('fixture entry rejects relative paths and unknown options', async () => {
  for (const args of [[], ['--prefix', '.', '--h264-source', '.', '--out', '.'], ['--prefix', '/absent', '--unsafe']]) {
    const result = await runNative(process.execPath, ['media-libav/generate_fixtures.mjs', ...args], environment);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /required|absolute|Unknown option/);
  }
});

test('PCM fixture bytes have independent signed stereo/WAV expectations', () => {
  const wave = pcmWave(48000, 16, 2, (n, channel) => [[-32768, 32767], [1, -1]][n][channel]);
  assert.equal(wave.toString('hex'), '524946462c00000057415645666d7420100000000100020080bb000000ee02000400100064617461080000000080ff7f0100ffff');
  assert.equal(pcmWave(96000, 24, 1, (_, channel) => [-8388608, 8388607][channel]).subarray(44).toString('hex'), '000080ffff7f');
  assert.throws(() => pcmWave(48000, 8, 1, () => 0));
  assert.throws(() => pcmWave(48000, 24, 1_000_000, () => 0));
});
