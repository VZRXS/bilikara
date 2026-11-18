// Independent CI package gate. No application modules or build-info ELF claims.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

export const mediaLibraries = ['libavformat.so', 'libavcodec.so', 'libavutil.so', 'libswresample.so', 'libbilikara_media_libav.so', 'libc++_shared.so'];
// Original, unstripped Google NDK 27.0.12077973 runtime bytes, per ABI.
export const ndkRuntimeSha256 = {
  'arm64-v8a': '46b51d661454b9cfaf42c1dc90893b5ad601b7a7ffc2e09d44bb3cc9d20e7ae2',
  x86_64: '936e1150309bdae86216f14e493f478d39e588095f1577105856da6d0f24f149',
};
const ndkVersion = '27.0.12077973';
export const sampleHash = '8624fbee0c7f4653e6f1c7c2f7a6de9aca5d2b3a3a729a218d7f740b9417aef3';
const sourceKit = abi => `bilikara-android-libav-9.0.1-${abi}-source-kit.zip`;
const sourceHash = 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635';
const signingFingerprint = 'FCF986EA15E6E293A5644F10B4322F04D67658D8';
const fail = message => { throw new Error(message); };

// APKs/source kits here are ordinary ZIPs (<512 MiB), not ZIP64. Read only
// selected entries, never extract archive-controlled paths into the filesystem.
export function zipReader(bytes) {
  if (bytes.length > 512 * 1024 * 1024) fail('ZIP exceeds package gate size bound');
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557)) fail('Missing ZIP end record');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) || bytes.readUInt16LE(end + 8) !== count || count === 65535 ||
      start + bytes.readUInt32LE(end + 12) > end) fail('Unsupported ZIP layout');
  const entries = new Map();
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail('Invalid ZIP central entry');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (offset + 46 + length + extra + comment > end) fail('Truncated ZIP central entry');
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (!name || name.includes('\\') || name.includes(':') || name.includes('\0') || name.startsWith('/') ||
        name.split('/').some(part => part === '..' || part === '.') || entries.has(name) || (mode & 0xf000) === 0xa000 ||
        flags & 1 || ![0, 8].includes(method)) fail(`Unsafe/duplicate/unsupported ZIP entry: ${name}`);
    entries.set(name, { flags, method, crc, compressed, size, local });
    offset += 46 + length + extra + comment;
  }
  if (offset !== start + bytes.readUInt32LE(end + 12)) fail('ZIP directory size mismatch');
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e || e.size > 128 * 1024 * 1024 || e.local + 30 > start || bytes.readUInt32LE(e.local) !== 0x04034b50) fail(`Invalid/missing ZIP payload: ${name}`);
      const length = bytes.readUInt16LE(e.local + 26), extra = bytes.readUInt16LE(e.local + 28);
      const data = e.local + 30 + length + extra;
      if (bytes.subarray(e.local + 30, e.local + 30 + length).toString('utf8') !== name ||
          bytes.readUInt16LE(e.local + 6) !== e.flags || bytes.readUInt16LE(e.local + 8) !== e.method || data + e.compressed > start) fail(`ZIP local entry mismatch: ${name}`);
      const encoded = bytes.subarray(data, data + e.compressed);
      const decoded = e.method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: Math.max(1, e.size) });
      if (decoded.length !== e.size || crc32(decoded) !== e.crc) fail(`ZIP size/CRC mismatch: ${name}`);
      return decoded;
    },
  };
}

export function verifyElf(text, name, abi, runtime = {}) {
  const cpp = name === 'libc++_shared.so';
  if (cpp && (runtime.ndk !== ndkVersion || runtime.sha256 !== ndkRuntimeSha256[abi])) fail('NDK libc++ runtime version/SHA-256 mismatch');
  const machine = { 'arm64-v8a': 'AArch64', x86_64: 'Advanced Micro Devices X86-64' }[abi];
  if (!machine || !text.split(/\r?\n/).some(line => /^\s*Machine:\s*(.*?)\s*$/.exec(line)?.[1] === machine)) fail(`${name}: ELF machine mismatch`);
  const hex = value => {
    if (!/^0x[0-9a-f]+$/i.test(value)) fail(`${name}: malformed ELF number`);
    return BigInt(value);
  };
  const loads = [], relros = [];
  const sonames = [], needed = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'LOAD' || fields[0] === 'GNU_RELRO') {
      if (fields.length < 8) fail(`${name}: incomplete ELF segment`);
      const address = hex(fields[2]), size = hex(fields[5]);
      if (address + size > 0xffffffffffffffffn) fail(`${name}: ELF segment overflow`);
      if (fields[0] === 'LOAD') {
        const align = hex(fields.at(-1));
        if (align < 16384n || (align & (align - 1n)) !== 0n || address % align !== hex(fields[1]) % align) fail(`${name}: LOAD alignment below 16 KiB or incongruent`);
        loads.push({ start: address, end: address + size, writable: fields.slice(6, -1).some(field => field.includes('W')) });
      } else {
        if (!size || (!cpp && (address + size) % 16384n)) fail(`${name}: GNU_RELRO end is not 16 KiB aligned`);
        relros.push({ start: address, end: address + size });
      }
    }
    if (/\((?:RPATH|RUNPATH|TEXTREL)\)/.test(line)) fail(`${name}: forbidden loader path/text relocation`);
    if (/\((?:SONAME|NEEDED)\)/.test(line)) {
      const value = /\[([^\]]+)\]/.exec(line)?.[1];
      if (!value) fail(`${name}: malformed dynamic name`);
      if (line.includes('(SONAME)')) sonames.push(value);
      else needed.push(value);
    }
  }
  if (loads.length < 2 || relros.length !== 1) fail(`${name}: missing LOAD/GNU_RELRO segments`);
  if (sonames.length !== 1 || sonames[0] !== name) fail(`${name}: SONAME must equal the unversioned filename`);
  for (const dependency of needed) {
    if (![...mediaLibraries, 'libc.so', 'libm.so', 'libdl.so'].includes(dependency)) fail(`${name}: undeclared NEEDED ${dependency}`);
  }
  const facts = { soname: name, needed, loads: loads.length, relro: true, minimumPageSize: 16384 };
  if (cpp) {
    // Official Android RELRO Example 4: only this pinned runtime may use an
    // unaligned LOAD tail, with no subsequent writable data on the same page.
    // https://developer.android.com/guide/practices/page-sizes#check-relro
    const { start, end } = relros[0], pageEnd = (end + 16383n) & ~16383n;
    if (pageEnd > 0xffffffffffffffffn || !loads.some(load => load.start <= start && load.end === end) ||
        loads.some(load => load.writable && load.end > end && load.start < pageEnd)) fail('Pinned NDK libc++ RELRO does not occupy an isolated LOAD tail');
    facts.ndk = ndkVersion;
    facts.sha256 = runtime.sha256;
    facts.relroAlignmentException = 'libc++_shared.so: RELRO alignment accepted by pinned NDK runtime exception';
  }
  return facts;
}

export function verifyPrivacy(bytes, name, { paths = [], username = '' } = {}) {
  if (bytes.subarray(0, 4).toString('hex') !== '7f454c46') fail(`${name}: missing ELF magic`);
  // libavutil's av_tempfile embeds this generic runtime mkstemp template.
  // Exempt only that complete C string, never arbitrary /tmp build paths.
  const text = bytes.toString('latin1').toLowerCase().replaceAll('\0/tmp/%sxxxxxx\0', '\0').replaceAll('\\', '/');
  const reject = () => fail(`${name}: contains build-machine path/username`);
  const markers = ['/users/', '/home/', '/root/', '/tmp/', '/private/var/', '/var/folders/',
    '/cygdrive/', '/opt/hostedtoolcache/', '/__w/', '/runner/_work/', '.android-libav-build-', '.android-libav-output-'];
  if (markers.some(marker => text.includes(marker)) || /\/(?:mnt\/[a-z]|[a-z]\/users)\//.test(text)) reject();
  const containsDirectory = directory => {
    let at = -1;
    while ((at = text.indexOf(directory, at + 1)) !== -1) {
      const next = text[at + directory.length];
      if (next === undefined || /[\s\0/'"`]/.test(next)) return true;
    }
    return false;
  };
  // A username is meaningful only in a home-path segment. Words such as root,
  // user, build, dev, ci and runner are ordinary symbols in valid libraries.
  if (username && ['/home/', '/users/'].some(base => containsDirectory(base + username.toLowerCase()))) reject();
  for (const value of paths.filter(Boolean)) {
    const portable = value.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
    if (!portable) continue;
    const forms = [portable], drive = /^([a-z]):(\/.*)$/.exec(portable);
    if (drive) forms.push(`/${drive[1]}${drive[2]}`, `/cygdrive/${drive[1]}${drive[2]}`, `/mnt/${drive[1]}${drive[2]}`);
    if (forms.some(containsDirectory)) reject();
  }
  if (name !== 'libc++_shared.so' && !text.includes('--prefix=/bilikara-android-libav')) fail(`${name}: missing fixed FFmpeg prefix`);
}

export function castSamplesIncluded(property = 'bilikara.includeCastSamples=true') {
  const value = /^bilikara\.includeCastSamples=(true|false)$/.exec(property);
  if (!value) fail('Expected Gradle property bilikara.includeCastSamples=true or false');
  return value[1] === 'true';
}

export function verifySample(reader, required = true) {
  const samples = reader.names.filter(name => name.startsWith('assets/') && path.posix.basename(name) === 'sample-b.ts');
  if (!samples.length) {
    if (required) fail('Required sample B asset is missing (bilikara.includeCastSamples=true)');
    return 'absent (not required for this input)';
  }
  if (samples.length !== 1) fail('Duplicate sample B assets');
  const bytes = reader.read(samples[0]);
  if (bytes.length !== 12_079_564 || createHash('sha256').update(bytes).digest('hex') !== sampleHash) fail('Sample B size/SHA-256 mismatch');
  return `${samples[0]} SHA-256 ${sampleHash}`;
}

function directoryReader(directory) {
  const names = [];
  function visit(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative + entry.name;
      if (entry.isDirectory()) visit(name + '/');
      else if (entry.isFile()) names.push(name);
      else fail(`Unexpected media output link: ${name}`);
    }
  }
  visit('');
  return { names, read: name => readFileSync(path.join(directory, name)) };
}

export function verifyLicenses(reader, abi, kit) {
  const base = `assets/bilikara-media/${abi}/`;
  for (const name of ['licenses/libav/COPYING.LGPLv2.1', 'licenses/libav/LICENSE.md', 'licenses/THIRD_PARTY_NOTICES.md', 'licenses/Signalsmith-Stretch.txt', 'licenses/Signalsmith-Linear.txt', 'licenses/Android-NDK-NOTICE.txt']) {
    if (!reader.read(base + name).length) fail(`Empty license: ${name}`);
  }
  const info = JSON.parse(reader.read(base + 'build-info.json').toString('utf8'));
  if (info.schema_version !== 1 || info.abi !== abi || info.ffmpeg !== '9.0.1' || info.ndk !== ndkVersion || info.signalsmith !== true || info.source_kit !== sourceKit(abi)) fail('Media build-info/source-kit mismatch');
  const notice = reader.read(base + 'licenses/libav-source.txt').toString('utf8');
  for (const required of ['FFmpeg 9.0.1', 'LGPL-2.1', `Source SHA-256: ${sourceHash}`, `Signing fingerprint: ${signingFingerprint}`,
    'Configuration:', sourceKit(abi), 'separately alongside this APK']) {
    if (!notice.includes(required)) fail(`Missing source-location/license notice: ${required}`);
  }
  if (reader.names.some(name => /source-kit\.zip$/.test(name))) fail('Source kit must be distributed separately from APK');
  if (path.basename(kit) !== sourceKit(abi)) fail('Incorrect separate source-kit filename');
  const kitBytes = readFileSync(kit);
  if (info.source_kit_sha256 !== createHash('sha256').update(kitBytes).digest('hex')) fail('Separate source-kit SHA-256 mismatch');
  const archive = zipReader(kitBytes);
  for (const name of ['source/ffmpeg-9.0.1.tar.xz', 'source/ffmpeg-9.0.1.tar.xz.asc', 'source/ffmpeg-devel.asc',
    'licenses/COPYING.LGPLv2.1', 'records/config.h', 'media-libav/probe.c', 'xtask/src/android_libav.rs',
    'xtask/Cargo.toml', 'xtask/Cargo.lock', 'rust-toolchain.toml', 'REBUILD-ANDROID.md',
    'media-libav/stretch.cpp', 'media-libav/live_audio.c', 'media-libav/live_ts.c',
    'media-libav/signalsmith/LICENSE.txt', 'media-libav/signalsmith/signalsmith-linear/LICENSE.txt']) {
    if (!archive.read(name).length) fail(`Missing/empty source-kit material: ${name}`);
  }
  const source = archive.read('source/ffmpeg-9.0.1.tar.xz');
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== sourceHash) {
    fail('Source-kit FFmpeg archive SHA-256 mismatch');
  }
  const manifest = JSON.parse(archive.read('media-libav/signalsmith/sources.json'));
  if (!Array.isArray(manifest.files) || manifest.files.length !== 22) fail('Missing DSP source inventory');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes(':') ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.path)) fail('Invalid DSP source name');
    seen.add(file.path);
    if (createHash('sha256').update(archive.read(`media-libav/signalsmith/${file.path}`)).digest('hex') !== file.sha256) fail('DSP source mismatch');
  }
  if (!notice.includes(digest)) fail('Source notice SHA-256 differs from distributed archive');
  return `${base}licenses/; separate source kit: ${kit}`;
}

export function checkMedia({ apk, mediaOutput, abi = 'arm64-v8a', readelf, sourceKit: kit, scratch, privacy = {}, gradleProperty }) {
  if (Boolean(apk) === Boolean(mediaOutput)) fail('Select exactly one of --apk or --media-output');
  if (!['arm64-v8a', 'x86_64'].includes(abi)) fail('Unsupported Android ABI');
  const requireSample = Boolean(apk) && castSamplesIncluded(gradleProperty);
  const source = apk ? zipReader(readFileSync(apk)) : directoryReader(mediaOutput);
  // Source kits belong beside the generated assets/JNI tree, never in APK.
  const reader = mediaOutput ? { ...source, names: source.names.filter(name => !name.startsWith('sources/')) } : source;
  const prefix = apk ? `lib/${abi}/` : `jniLibs/${abi}/`;
  const packaged = reader.names.filter(name => name.startsWith(prefix) && name.endsWith('.so')).map(name => name.slice(prefix.length));
  if (packaged.some(name => ![...mediaLibraries, ...(apk ? ['libbilikara_app.so'] : [])].includes(name)) ||
      mediaLibraries.some(name => !packaged.includes(name))) fail('Missing/unexpected media library inventory');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(path.join(scratch, 'android-media-check-'));
  try {
    const libraries = {};
    for (const name of mediaLibraries) {
      const bytes = reader.read(prefix + name);
      verifyPrivacy(bytes, name, privacy);
      const file = path.join(temporary, name);
      writeFileSync(file, bytes);
      const text = execFileSync(readelf, ['--wide', '--file-header', '--program-headers', '--dynamic', file], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
      libraries[name] = verifyElf(text, name, abi, { ndk: ndkVersion, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return { abi, input: apk || mediaOutput, libraries, licenses: verifyLicenses(reader, abi, kit), sample: verifySample(reader, requireSample) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const options = {};
  const keys = { '--apk': 'apk', '--media-output': 'mediaOutput', '--abi': 'abi', '--readelf': 'readelf', '--source-kit': 'sourceKit', '--scratch': 'scratch', '--gradle-property': 'gradleProperty' };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = keys[process.argv[i]], value = process.argv[i + 1];
    if (!key || !value || options[key]) fail('Invalid/duplicate package gate argument');
    options[key] = value;
  }
  for (const key of ['readelf', 'sourceKit']) if (!options[key] || !existsSync(options[key]) || !statSync(options[key]).isFile()) fail(`Missing ${key}`);
  options.scratch ||= path.resolve('.tmp');
  // Match Gradle's environment property and -P precedence; callers using -P
  // pass the same named property with --gradle-property to this verifier.
  const includeSamples = process.env['ORG_GRADLE_PROJECT_bilikara.includeCastSamples'];
  if (options.gradleProperty === undefined && includeSamples !== undefined) options.gradleProperty = `bilikara.includeCastSamples=${includeSamples}`;
  options.privacy = { paths: [process.cwd(), process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP, process.env.HOME, process.env.NDK_HOME], username: userInfo().username };
  console.log(JSON.stringify(checkMedia(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
