// Explicit TEST-only use of the selected same-build CLI. No product CLI fallback.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runNative } from '../tests/desktop_construction_support.mjs';
import { pcmWave } from './fixture_audio.mjs';

export async function generateFixtures({ prefix, h264Source, out }) {
  for (const file of [prefix, h264Source, out]) assert.ok(path.isAbsolute(file), 'all fixture paths must be absolute');
  mkdirSync(out, { recursive: true });
  const environment = { ...process.env, LD_LIBRARY_PATH: path.join(prefix, 'lib') };
  const ffmpeg = path.join(prefix, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  async function run(...args) {
    const result = await runNative(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...args], environment);
    assert.equal(result.status, 0, result.stderr);
  }
  await run('-i', h264Source, '-map', '0:v:0', '-t', '1', '-c', 'copy', path.join(out, 'video.mp4'));
  const pcm = path.join(out, 'synthetic.wav');
  writeFileSync(pcm, pcmWave(96000, 24, 96000, n => Math.trunc(1_000_000 * Math.sin(2 * Math.PI * 997 * n / 96000))));
  await run('-i', pcm, '-ar', '48000', '-c:a', 'aac', path.join(out, 'aac.m4a'));
  await run('-i', path.join(out, 'video.mp4'), '-i', path.join(out, 'aac.m4a'), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', path.join(out, 'av.mp4'));
  await run('-i', pcm, '-c:a', 'flac', path.join(out, 'audio.flac'));
  await run('-i', path.join(out, 'audio.flac'), '-c', 'copy', '-strict', '-2', path.join(out, 'flac.mp4'));
  await run('-i', path.join(out, 'audio.flac'), '-c:a', 'pcm_s16le', path.join(out, 'outside.wav'));
  writeFileSync(path.join(out, 'truncated.mp4'), readFileSync(path.join(out, 'aac.m4a')).subarray(0, 64));
  writeFileSync(path.join(out, 'unknown.bin'), 'not a media container\n', 'utf8');
  const raw = readFileSync(path.join(out, 'audio.flac'));
  raw.writeBigUInt64BE(raw.readBigUInt64BE(18) & ~((1n << 36n) - 1n), 18);
  writeFileSync(path.join(out, 'unknown-duration.flac'), raw);
  const damaged = readFileSync(path.join(out, 'aac.m4a'));
  let offset = 0, found = false;
  while (offset + 8 <= damaged.length) {
    const size = damaged.readUInt32BE(offset);
    if (damaged.subarray(offset + 4, offset + 8).toString('ascii') === 'mdat') { damaged.write('free', offset + 4); found = true; break; }
    assert.ok(size >= 8, 'unexpected generated MP4 layout'); offset += size;
  }
  assert.ok(found, 'generated AAC fixture lacks mdat'); writeFileSync(path.join(out, 'missing-mdat.m4a'), damaged);
  writeFileSync(path.join(out, 'local.ffconcat'), "ffconcat version 1.0\nfile 'audio.flac'\n", 'utf8');
  writeFileSync(path.join(out, 'network.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/forbidden\n#EXT-X-ENDLIST\n', 'utf8');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['prefix', 'h264-source', 'out'].map(name => [name, { type: 'string' }])) });
  for (const name of ['prefix', 'h264-source', 'out']) assert.ok(values[name], `--${name} is required`);
  console.log(await generateFixtures({ prefix: values.prefix, h264Source: values['h264-source'], out: values.out }));
}
