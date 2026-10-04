// Independent verification facts and owned test setup; no production imports.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildXtask, root, runNative } from './desktop_construction_support.mjs';
import { nativeTarget, suffix } from './desktop_construction_expectations.mjs';

export { root, runNative, nativeTarget, suffix };
export const companionName = { win32: 'bilikara_media_libav.dll', darwin: 'libbilikara_media_libav.dylib', linux: 'libbilikara_media_libav.so' }[process.platform];
export const testCompanionName = process.platform === 'win32' ? 'bilikara_media_libav_test.dll' : companionName?.replace('libav.', 'libav_test.');
export const libraryVersions = [
  { name: 'libavutil', version: 3998053 }, { name: 'libavcodec', version: 4129125 }, { name: 'libavformat', version: 4129125 },
];
export const runtimeNames = ['libbilikara_media_libav.so', 'libavcodec.so.63', 'libavformat.so.63', 'libavutil.so.61', 'libswresample.so.7'].sort();
export const systemImports = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'librt.so.1', 'libresolv.so.2',
  'libgcc_s.so.1', 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1']);
export const json = file => JSON.parse(readFileSync(file, 'utf8'));

export function ownedDirectory(label) { return realpathSync(mkdtempSync(path.join(tmpdir(), `${label} 中文 $() & `))); }
export function copyFile(from, to) { copyFileSync(from, to); chmodSync(to, lstatSync(from).mode & 0o7777); }
export function copyTree(from, to, filter = () => true) {
  cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, filter });
}
export function inventory(directory, excludeManifest = false) {
  const entries = new Map();
  function visit(parent, prefix) {
    for (const name of readdirSync(parent).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (excludeManifest && relative === 'cache-manifest.json') continue;
      const file = path.join(parent, name), stat = lstatSync(file);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) entries.set(relative, { kind: 'link', mode, target: readlinkSync(file) });
      else if (stat.isDirectory()) { entries.set(relative, { kind: 'directory', mode }); visit(file, relative); }
      else {
        assert.ok(stat.isFile(), `unexpected native input type: ${relative}`);
        entries.set(relative, { kind: 'file', mode, size: stat.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
      }
    }
  }
  visit(directory, ''); return entries;
}

// Python's former ensure_ascii=True header expectation, independently specified
// using UTF-16 code units (including surrogate pairs), not xtask serialization.
export function asciiString(value) {
  let result = '"';
  const escapes = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i), ch = value[i];
    result += escapes[ch] ?? (code < 0x20 || code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : ch);
  }
  return `${result}"`;
}

function requiredInput() {
  const supplied = process.env.BILIKARA_TEST_LIBAV_COMPANION;
  assert.ok(supplied?.trim(), 'BILIKARA_TEST_LIBAV_COMPANION is required for real native libav prerequisite checks; prepare the native prefix first');
  try {
    const companion = realpathSync(supplied);
    assert.equal(path.basename(companion), companionName, 'the supplied companion must match the executing native platform');
    assert.equal(path.basename(path.dirname(companion)), 'bin', 'expected the actual prepared prefix/bin companion');
    assert.ok(lstatSync(companion).isFile(), 'companion must be a regular native library');
    const bytes = readFileSync(companion);
    assert.ok(bytes.length >= 64, 'invalid native companion');
    if (process.platform === 'linux') {
      assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', 'invalid ELF companion');
      assert.equal(bytes[4], 2, 'expected ELF64'); assert.equal(bytes[5], 1, 'expected little-endian ELF');
      assert.equal(bytes.readUInt16LE(16), 3, 'expected shared-library ELF');
      assert.equal(bytes.readUInt16LE(18), process.arch === 'arm64' ? 183 : 62, 'incompatible native companion architecture');
    }
    const prefix = realpathSync(path.join(path.dirname(companion), '..'));
    return { prefix, companion };
  } catch (cause) { throw new Error(`Invalid BILIKARA_TEST_LIBAV_COMPANION / required native prefix: ${cause.message}`, { cause }); }
}

export async function prepareRealInputs() {
  const inputs = requiredInput();
  const directory = ownedDirectory('libav prerequisites');
  try {
    const { tool, compiledTargets } = await buildXtask();
    assert.ok(!compiledTargets.some(name => /^bilikara_(?:runtime|rust)$/.test(name)), 'independent xtask bootstrap must not build the application');
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:BILIKARA_|TAURI_ENV_|GITHUB_|CARGO_BUILD_TARGET$|LD_LIBRARY_PATH$|LD_PRELOAD$|DYLD_LIBRARY_PATH$|DYLD_INSERT_LIBRARIES$)/i.test(key)));
    environment.LC_ALL = 'C';
    const probe = path.join(directory, `independent-libav-probe${suffix}`);
    const source = path.join(root, 'tests/fixtures/libav_prerequisite_probe.c');
    const command = process.platform === 'win32' ? 'cl.exe' : environment.CC || 'cc';
    const args = process.platform === 'win32'
      ? ['/nologo', '/std:c11', '/O2', '/MD', '/W3', '/we4013', source, `/Fe${probe}`, `/Fo${directory}${path.sep}`, '/link', 'kernel32.lib']
      : ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, ...(process.platform === 'linux' ? ['-ldl'] : []), '-o', probe];
    const built = await runNative(command, args, environment, 120_000, directory);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const names = {
      win32: ['avutil-61.dll', 'swresample-7.dll', 'avcodec-63.dll', 'avformat-63.dll'],
      darwin: ['libavutil.61.dylib', 'libswresample.7.dylib', 'libavcodec.63.dylib', 'libavformat.63.dylib'],
      linux: ['libavutil.so.61', 'libswresample.so.7', 'libavcodec.so.63', 'libavformat.so.63'],
    }[process.platform];
    const libraries = names.map(name => {
      const parent = realpathSync(path.join(inputs.prefix, process.platform === 'win32' ? 'bin' : 'lib'));
      const file = realpathSync(path.join(parent, name));
      assert.ok(file.startsWith(`${parent}${path.sep}`) && lstatSync(file).isFile(), `selected library escapes prefix: ${name}`);
      return file;
    });
    const loaded = await runNative(probe, [...libraries, inputs.companion], environment);
    assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
    const lines = loaded.stdout.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['3998053', '4129125', '4129125', '9.0.1'], 'actual independently loaded library facts');
    const configuration = lines.slice(4).join('\n');
    assert.ok(Buffer.byteLength(configuration) <= 2048);
    for (const flag of ['--disable-network', '--enable-shared', '--disable-programs', '--disable-autodetect']) assert.ok(configuration.split(/\s+/).includes(flag), flag);
    return { ...inputs, directory, tool, environment, configuration, before: inventory(inputs.prefix) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export async function invoke(inputs, args, success = true, overrides = {}) {
  const result = await runNative(inputs.tool, args, { ...inputs.environment, ...overrides }, 180_000);
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  return result;
}
