// Independent expected records, never writes a product or imports xtask rules.
// Complete keys/bytes/modes/links are compared; only JSON/plist formatting and
// macOS signature bytes are insignificant. Foreign descriptors are not executed.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const suffix = process.platform === 'win32' ? '.exe' : '';
export function nativeTarget() {
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const os = { win32: 'pc-windows-msvc', darwin: 'apple-darwin', linux: 'unknown-linux-gnu' }[process.platform];
  assert.ok(arch && os, 'construction tests need a supported native runner');
  return `${arch}-${os}`;
}
const mode = stat => process.platform === 'win32' ? null : stat.mode & 0o7777;
const directoryMode = process.platform === 'win32' ? null : 0o777 & ~process.umask();
const fileMode = process.platform === 'win32' ? null : 0o666 & ~process.umask();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function platformOutput(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fileRecord(file) {
  const metadata = statSync(file); const name = path.basename(file); let bytes = readFileSync(file);
  const record = { kind: 'file', mode: mode(metadata) };
  if (['_CodeSignature'].includes(path.basename(path.dirname(file)))) return { ...record, signature: true };
  if (['native-desktop.json', 'ffmpeg-runtime.json'].includes(name)) return { ...record, json: JSON.parse(bytes) };
  if (name === 'Info.plist') return { ...record, plist: JSON.parse(platformOutput('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file])) };
  if (process.platform === 'darwin' && ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface'].includes(bytes.subarray(0, 4).toString('hex'))) {
    const temporary = mkdtempSync(path.join(tmpdir(), 'construction-signature-'));
    try {
      const copy = path.join(temporary, 'code'); copyFileSync(file, copy);
      // Normalize the signature envelope on this disposable copy first. Rustc
      // and bundle codesign can otherwise leave different signature reservations
      // even after --remove-signature. Every remaining code/data byte is hashed.
      platformOutput('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none',
        '--identifier', 'bilikara.construction.comparison',
        '--preserve-metadata=entitlements,requirements,flags', copy]);
      platformOutput('/usr/bin/codesign', ['--remove-signature', copy]); bytes = readFileSync(copy);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return { ...record, sha256: hash(bytes), bytes: bytes.length };
}

export function inventory(directory) {
  const records = new Map();
  function visit(parent, prefix) {
    for (const entry of readdirSync(parent)) {
      const relative = prefix ? `${prefix}/${entry}` : entry; const file = path.join(parent, entry); const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) records.set(relative, { kind: 'symlink', mode: mode(metadata), target: readlinkSync(file), live: existsSync(file) });
      else if (metadata.isDirectory()) { records.set(relative, { kind: 'directory', mode: mode(metadata) }); visit(file, relative); }
      else { assert.ok(metadata.isFile(), `unexpected file type: ${relative}`); records.set(relative, fileRecord(file)); }
    }
  }
  visit(directory, ''); return records;
}
export function assertInventory(expected, actual) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), 'complete product paths');
  for (const [name, value] of expected) assert.deepEqual(actual.get(name), value, `product bytes/metadata/mode/link: ${name}`);
}

export function expectedPackage(fixture, environment, { development, prefix, macosApp = false, compliance = false, shell = false }) {
  const records = new Map();
  const resources = macosApp ? 'Contents/Resources' : '_internal';
  const code = macosApp ? 'Contents/MacOS' : resources;
  const vendor = macosApp ? 'Contents/Frameworks' : `${resources}/vendor`;
  const docs = macosApp ? `${resources}/license` : 'license';
  function directory(name, permissions = directoryMode) {
    const parent = path.posix.dirname(name); if (parent !== '.' && !records.has(parent)) directory(parent);
    records.set(name, { kind: 'directory', mode: permissions });
  }
  function put(name, value) { const parent = path.posix.dirname(name); if (parent !== '.') directoryIfMissing(parent); records.set(name, value); }
  function directoryIfMissing(name) { if (!records.has(name)) directory(name); }
  const text = (name, value) => { const bytes = Buffer.from(value, 'utf8'); put(name, { kind: 'file', mode: fileMode, sha256: hash(bytes), bytes: bytes.length }); };
  const copy = (source, name) => put(name, fileRecord(source));
  // Darwin applies umask when creating symlinks; Linux links use mode 0777.
  const link = (name, target) => put(name, { kind: 'symlink', mode: process.platform === 'darwin' ? directoryMode : 0o777, target, live: true });
  function tree(source, destination, exclude = () => false) {
    directory(destination, mode(statSync(source)));
    for (const name of readdirSync(source)) {
      if (exclude(name)) continue;
      const file = path.join(source, name); const to = `${destination}/${name}`;
      if (statSync(file).isDirectory()) tree(file, to, exclude); else copy(file, to);
    }
  }
  directory(vendor); directoryIfMissing(`${resources}/vendor`);
  for (const name of ['bilikara-desktop-host', 'bilikara-updater']) copy(fixture, `${code}/${name}${suffix}`);
  tree(path.join(root, 'static'), `${resources}/static`, name => name === 'vendor');
  tree(path.join(root, 'static/vendor'), `${resources}/vendor`, name => ['LICENSE.txt', 'README.md'].includes(name));
  for (const name of ['LICENSE.txt', 'README.md']) {
    const source = path.join(root, 'static/vendor/signalsmith-stretch', name);
    if (existsSync(source)) copy(source, `${docs}/THIRD_PARTY_LICENSES/signalsmith-stretch/${name}`);
  }
  const version = environment.BILIKARA_VERSION.trim(); const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  text(`${resources}/APP_VERSION`, `${version}\n`);
  put(`${resources}/native-desktop.json`, { kind: 'file', mode: fileMode, json: {
    schema_version: 1, backend: 'rust', version, resource_layout: 'internal-v1',
    platform: { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform], arch, development,
  } });
  if (macosApp) put('Contents/Info.plist', { kind: 'file', mode: fileMode, plist: {
    CFBundleExecutable: 'bilikara-desktop-host', CFBundleIdentifier: 'com.bilikara.backend', CFBundleName: 'bilikara backend',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.8.0', CFBundleVersion: '0.8.0', LSUIElement: true,
  } });
  const tool = environment.PATH.split(path.delimiter).map(p => path.join(p, `BBDown${suffix}`)).find(p => existsSync(p));
  if (tool) { copy(tool, `${vendor}/BBDown${suffix}`); if (macosApp) link(`${resources}/vendor/BBDown`, '../../Frameworks/BBDown'); }
  if (process.platform === 'darwin') copy(path.join(root, `tools/aria2/macos-${arch}.json`), `${resources}/vendor/aria2-macos.json`);
  if (prefix) {
    const data = JSON.parse(readFileSync(path.join(prefix, 'bin/ffmpeg-runtime.json')));
    for (const name of data.runtime_files) {
      copy(path.join(prefix, 'bin', name), `${vendor}/${name}`);
      if (macosApp) link(`${resources}/vendor/${name}`, `../../Frameworks/${name}`);
    }
    const manifest = `${resources}/vendor/ffmpeg-runtime.json`;
    put(manifest, { kind: 'file', mode: fileMode, json: Object.fromEntries(
      ['schema_version', 'kind', 'version', 'target', 'runtime_files', 'build_run', 'build_attempt'].filter(key => key in data).map(key => [key, data[key]])) });
    if (macosApp) link(`${vendor}/ffmpeg-runtime.json`, '../Resources/vendor/ffmpeg-runtime.json');
    tree(path.join(prefix, 'licenses'), `${docs}/THIRD_PARTY_LICENSES/libav`);
    for (const name of readdirSync(path.join(prefix, 'source'))) {
      if (process.platform !== 'win32' || path.extname(name).toLowerCase() === '.asc') copy(path.join(prefix, 'source', name), `${docs}/THIRD_PARTY_SOURCES/${name}`);
    }
    const recipes = process.platform === 'win32' ? ['build-windows.sh', 'build-windows-libraries.sh', 'prepare-windows.ps1'] : ['build-posix.sh', 'build-posix-libraries.sh'];
    for (const name of ['probe.h', 'probe.c', 'pcm.c', 'remux.c', 'test_shim.c', 'windows_io.h', 'xtask.sh', 'REBUILD.md', 'fixtures/synthetic.h264', ...recipes]) {
      copy(path.join(root, 'media-libav', name), `${docs}/THIRD_PARTY_SOURCES/media-libav/${name}`);
    }
    for (const name of ['Cargo.toml', 'Cargo.lock']) copy(path.join(root, 'xtask', name), `${docs}/THIRD_PARTY_SOURCES/xtask/${name}`);
    tree(path.join(root, 'xtask/src'), `${docs}/THIRD_PARTY_SOURCES/xtask/src`);
    copy(path.join(root, 'LICENSE'), `${docs}/THIRD_PARTY_SOURCES/xtask/LICENSE`);
    copy(path.join(root, 'rust-toolchain.toml'), `${docs}/THIRD_PARTY_SOURCES/rust-toolchain.toml`);
    copy(path.join(root, 'third_party/BBDown-LICENSE.txt'), `${docs}/THIRD_PARTY_SOURCES/third_party/BBDown-LICENSE.txt`);
    copy(path.join(root, 'third_party/ebur128-LICENSE.txt'), `${docs}/THIRD_PARTY_SOURCES/third_party/ebur128-LICENSE.txt`);
  }
  if (compliance) {
    for (const name of ['LICENSE', 'LEGAL.md', 'THIRD_PARTY_NOTICES.md']) copy(path.join(root, name), `${docs}/${name}`);
    const licenses = `${docs}/THIRD_PARTY_LICENSES`;
    copy(path.join(root, 'third_party/BBDown-LICENSE.txt'), `${licenses}/BBDown-LICENSE.txt`);
    copy(path.join(root, 'third_party/ebur128-LICENSE.txt'), `${licenses}/ebur128-LICENSE.txt`);
    copy(environment.BILIKARA_FFMPEG_SOURCE_ARCHIVE, `${docs}/THIRD_PARTY_SOURCES/ffmpeg-9.0.1.tar.xz`);
    text(`${licenses}/bbdown-version.txt`, `${(environment.XTASK_FIXTURE_TOOL_VERSION || 'BBDown 1.6.3').replace(/\r\n|\r/g, '\n')}\n`);
    text(`${licenses}/libav-source.txt`, 'FFmpeg libraries (libav) redistribution notes\n\n'
      + 'This native product uses dynamically loaded libraries from the FFmpeg project.\n'
      + 'FFmpeg and ffprobe executables are not bundled. The library build disables\n'
      + 'programs, GPL and nonfree components; see libav/COPYING.LGPLv2.1 and libav/LICENSE.md.\n\n'
      + '- FFmpeg library version: 9.0.1\n- Official source URL: https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz\n'
      + `- Source SHA-256: ${environment.BILIKARA_FFMPEG_SOURCE_SHA256}\n`
      + '- Exact source archive: ../THIRD_PARTY_SOURCES/ffmpeg-9.0.1.tar.xz\n'
      + '- Build scripts and companion source: ../THIRD_PARTY_SOURCES/media-libav/\n'
      + '- Upstream legal information: https://ffmpeg.org/legal.html\n');
    let toolPath = realpathSync(tool);
    if (toolPath.startsWith('\\\\?\\UNC\\')) toolPath = `\\\\${toolPath.slice(8)}`;
    else if (toolPath.startsWith('\\\\?\\')) toolPath = toolPath.slice(4);
    let notice = 'BBDown redistribution notes\n\n'
      + 'The packaged runtime includes a pinned BBDown vendor executable and restores\n'
      + 'the writable runtime copy from that immutable vendor instead of polling releases.\n\n'
      + `- Bundled build path: ${toolPath}\n`;
    for (const [label, key] of [['Version', 'VERSION'], ['Upstream release commit', 'RELEASE_COMMIT'], ['Asset', 'ARCHIVE_NAME'], ['Source URL', 'SOURCE_URL'], ['Asset SHA-256', 'SHA256']]) {
      notice += `- ${label}: ${environment[`BILIKARA_BBDOWN_${key}`]?.trim() || 'not recorded'}\n`;
    }
    text(`${licenses}/bbdown-source.txt`, `${notice}- Upstream repository: https://github.com/nilaoda/BBDown\n- License: MIT; see BBDown-LICENSE.txt\n`);
  }
  if (shell && !macosApp) {
    copy(fixture, `bilikara-desktop${suffix}`);
    const launcher = process.platform === 'win32' ? '导入旧数据.cmd' : '导入旧数据.sh';
    text(launcher, process.platform === 'win32' ? '@echo off\r\n"%~dp0bilikara-desktop.exe" --import-legacy\r\n'
      : '#!/bin/sh\nset -eu\nhere=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$here/bilikara-desktop" --import-legacy\n');
    records.get(launcher).mode = process.platform === 'win32' ? fileMode : 0o755;
  }
  if (macosApp) put('Contents/_CodeSignature/CodeResources', { kind: 'file', mode: fileMode, signature: true });
  if (!macosApp) return compliance ? { backend: records } : records;
  const desktop = new Map([
    ['Contents', { kind: 'directory', mode: directoryMode }], ['Contents/MacOS', { kind: 'directory', mode: directoryMode }],
    ['Contents/MacOS/bilikara', fileRecord(fixture)],
    ['Contents/Info.plist', { kind: 'file', mode: fileMode, plist: { CFBundleExecutable: 'bilikara', CFBundleIdentifier: 'com.bilikara.app', CFBundlePackageType: 'APPL' } }],
    ['Contents/_CodeSignature', { kind: 'directory', mode: directoryMode }], ['Contents/_CodeSignature/CodeResources', { kind: 'file', mode: fileMode, signature: true }],
    ['Contents/Frameworks', { kind: 'directory', mode: directoryMode }], ['Contents/Frameworks/bilikara-backend.app', { kind: 'directory', mode: directoryMode }],
    ...[...records].map(([name, value]) => [`Contents/Frameworks/bilikara-backend.app/${name}`, value]),
  ]);
  return { backend: records, desktop };
}
