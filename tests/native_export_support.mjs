// Independent test readers. No export production or filesystem extraction.
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

export function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= Math.max(0, bytes.length - 65557));
  const count = bytes.readUInt16LE(end + 10), entries = new Map(); let pos = bytes.readUInt32LE(end + 16);
  assert.ok(count > 0 && count <= 1000);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(pos), 0x02014b50);
    const method = bytes.readUInt16LE(pos + 10), sum = bytes.readUInt32LE(pos + 16), compressed = bytes.readUInt32LE(pos + 20), size = bytes.readUInt32LE(pos + 24), names = bytes.readUInt16LE(pos + 28), extras = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32), local = bytes.readUInt32LE(pos + 42);
    const name = bytes.subarray(pos + 46, pos + 46 + names).toString(); assert.ok(!entries.has(name)); assert.ok(size <= 64 * 1024 * 1024);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28); assert.ok(start + compressed <= pos);
    const data = bytes.subarray(start, start + compressed), decoded = method === 0 ? data : (assert.equal(method, 8), inflateRawSync(data, { maxOutputLength: size }));
    assert.equal(decoded.length, size); assert.equal(crc32(decoded), sum); entries.set(name, decoded); pos += 46 + names + extras + comment;
  }
  return entries;
}

export function csvRows(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, ''), rows = [];
  let row = [], parts = [], start = 0, quoted = false;
  function field(end, last = false) {
    parts.push(text.slice(start, end));
    const value = parts.join('');
    row.push(last ? value.replace(/\r$/, '') : value);
    parts = [];
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      parts.push(text.slice(start, i));
      if (quoted && text[i + 1] === '"') { parts.push('"'); i++; }
      else quoted = !quoted;
      start = i + 1;
    } else if (!quoted && c === ',') { field(i); start = i + 1; }
    else if (!quoted && c === '\n') { field(i, true); rows.push(row); row = []; start = i + 1; }
  }
  assert.equal(quoted, false);
  if (row.length || start < text.length || parts.length) { field(text.length); rows.push(row); }
  return rows;
}
