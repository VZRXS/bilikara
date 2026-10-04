import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const readableFields = new Set(['name', 'sha256', 'object_key', 'metadata_object_key', 'url']);
const strings = ['arch', 'name', 'url', 'sha256', 'version', 'source_url',
  'source_sha256', 'recipe_revision', 'object_key', 'metadata_object_key'];

function singleLine(value) {
  assert.equal(typeof value, 'string', 'Metadata value must be a string');
  assert.ok(value.length > 0 && value.length <= 8192 && !/[\r\n\0]/.test(value), 'Invalid metadata value');
  return value;
}

export function readMetadata(file) {
  assert.ok(statSync(file).size <= 65536, 'Metadata exceeds 64 KiB');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'Expected metadata object');
  return data;
}

export function verifyMetadata(data, arch) {
  assert.equal(data.schema_version, 2);
  assert.ok(arch === 'x64' || arch === 'arm64', 'Unsupported macOS architecture');
  assert.equal(data.arch, arch);
  assert.ok(singleLine(data.url).startsWith('https://'));
  assert.equal(singleLine(data.sha256).length, 64);
}

export function archiveMetadata(values) {
  assert.equal(values.length, strings.length, 'Expected ten metadata values');
  const data = { schema_version: 2, tool: 'aria2c', provider: 'bilikara-r2', platform: 'darwin' };
  strings.forEach((field, i) => { data[field] = singleLine(values[i]); });
  verifyMetadata(data, data.arch);
  return data;
}

export function serializeMetadata(data) {
  // Preserve the existing content-addressed metadata bytes: sorted keys, ASCII
  // JSON escapes, two spaces, LF. This also preserves surrogate pairs.
  const sorted = Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]]));
  return JSON.stringify(sorted, null, 2).replace(/[\u007f-\uffff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

export function main(args) {
  const [command, file, ...values] = args;
  if (command === 'write') {
    writeFileSync(file, serializeMetadata(archiveMetadata(values)), 'utf8');
  } else if (command === 'read' && values.length === 1 && readableFields.has(values[0])) {
    process.stdout.write(singleLine(readMetadata(file)[values[0]]) + '\n');
  } else if (command === 'check' && values.length === 1) {
    const data = readMetadata(file);
    verifyMetadata(data, values[0]);
    process.stdout.write(`locked aria2c metadata: arch=${data.arch} sha256=${data.sha256}\n`);
  } else {
    throw new Error('Usage: tool_asset_metadata.mjs write FILE VALUES... | read FILE FIELD | check FILE ARCH');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
