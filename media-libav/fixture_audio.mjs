// Test fixtures only: the accepted PCM WAV format, never product audio policy.
import assert from 'node:assert/strict';

export function pcmWave(rate, bits, frames, sample) {
  const width = bits / 8, bytes = frames * 2 * width;
  assert.ok([16, 24].includes(bits) && Number.isSafeInteger(bytes) && bytes <= 2 * 1024 * 1024);
  const result = Buffer.alloc(44 + bytes);
  result.write('RIFF'); result.writeUInt32LE(36 + bytes, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(2, 22);
  result.writeUInt32LE(rate, 24); result.writeUInt32LE(rate * 2 * width, 28);
  result.writeUInt16LE(2 * width, 32); result.writeUInt16LE(bits, 34); result.write('data', 36); result.writeUInt32LE(bytes, 40);
  for (let n = 0; n < frames; n++) for (let channel = 0; channel < 2; channel++) result.writeIntLE(sample(n, channel), 44 + (n * 2 + channel) * width, width);
  return result;
}
