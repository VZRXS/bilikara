// REQUIRED actual-library checks. No optional all-skipped mode, fake Cargo or
// fabricated prefix. Windows/macOS package qualification is a separate gate.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asciiString, companionName, copyFile, copyTree, inventory, invoke, json, libraryVersions,
  nativeTarget, prepareRealInputs, runNative, runtimeNames, suffix, systemImports, testCompanionName } from './libav_prerequisite_support.mjs';

let inputs;
before(async () => { inputs = await prepareRealInputs(); }, { timeout: 420_000 });
after(() => {
  if (!inputs) return;
  try { assert.deepEqual(inventory(inputs.prefix), inputs.before, 'the supplied prepared prefix must remain unchanged'); }
  finally { rmSync(inputs.directory, { recursive: true, force: true }); }
});
const shimSuccess = 'shim: 4 groups passed (error mapping, negotiation, cancellation/cleanup, subordinate-open denial)';

test('actual companion/shim rebuild twice with pinned loaded facts and exact configuration header', { timeout: 400_000 }, async () => {
  const out = path.join(inputs.directory, 'Rust 产物');
  const names = [companionName, testCompanionName, 'build-info.json', 'build_config.h', `test_shim${suffix}`].sort();
  let previous;
  for (let n = 0; n < 2; n++) {
    const result = await invoke(inputs, ['libav-companion', '--prefix', inputs.prefix, '--out', out, '--test']);
    assert.ok(result.stdout.includes(shimSuccess), `--test must execute the real C shim: ${result.stdout}${result.stderr}`);
    const actual = readdirSync(out).sort();
    if (process.platform === 'win32') for (const name of names) assert.ok(actual.includes(name), name);
    else assert.deepEqual(actual, names);
    for (const name of names) assert.ok(lstatSync(path.join(out, name)).isFile(), name);
    if (process.platform !== 'win32') assert.ok(lstatSync(path.join(out, 'test_shim')).mode & 0o111, 'native shim executable mode');
    const facts = json(path.join(out, 'build-info.json'));
    assert.deepEqual(facts, { library_versions: libraryVersions, program_version: { version: '9.0.1', configuration: inputs.configuration } });
    assert.equal(readFileSync(path.join(out, 'build_config.h'), 'utf8'), `#define BM_BUILD_CONFIG ${asciiString(inputs.configuration)}\n`);
    if (previous) assert.deepEqual(facts, previous, 'repeat construction must preserve complete metadata');
    previous = facts;
  }
});

test('real compiler failure removes stale completion; foreign target fails explicitly', async () => {
  const out = path.join(inputs.directory, 'failed compiler'); mkdirSync(out);
  writeFileSync(path.join(out, 'build-info.json'), '{"old":true}', 'utf8');
  const overrides = process.platform === 'win32' ? { PATH: path.join(inputs.directory, 'absent tools') } : { CC: path.join(inputs.directory, 'absent compiler') };
  await invoke(inputs, ['libav-companion', '--prefix', inputs.prefix, '--out', out], false, overrides);
  assert.equal(existsSync(path.join(out, 'build-info.json')), false, 'failed compilation must invalidate old completion');
  const foreign = await invoke(inputs, ['libav-companion', '--prefix', inputs.prefix, '--out', out], false, { BILIKARA_LIBAV_TARGET: 'foreign-target' });
  assert.match(foreign.stderr, /target does not match the executing native runner/);
});

test('actual POSIX ASan/UBSan companion and C shim execute', {
  skip: process.platform === 'win32' ? 'POSIX sanitizer mode; Windows rejection remains covered by xtask prerequisite tests' : false,
  timeout: 200_000,
}, async () => {
  const result = await invoke(inputs, ['libav-companion', '--prefix', inputs.prefix, '--out', path.join(inputs.directory, 'sanitized'), '--test', '--sanitize']);
  assert.ok(result.stdout.includes(shimSuccess), result.stdout + result.stderr);
});

test('actual Linux ELF collection twice has complete relocatable closure and fresh metadata', {
  skip: process.platform !== 'linux' ? 'Requires native ELF inputs and inspection; no foreign-platform collection evidence' : false,
  timeout: 400_000,
}, async () => {
  const prefix = path.join(inputs.directory, 'new prefix');
  copyTree(path.join(inputs.prefix, 'lib'), path.join(prefix, 'lib'));
  mkdirSync(path.join(prefix, 'bin')); mkdirSync(path.join(prefix, 'driver'));
  for (const name of [companionName, testCompanionName]) copyFile(path.join(inputs.prefix, 'bin', name), path.join(prefix, 'bin', name));
  writeFileSync(path.join(prefix, 'bin/ffmpeg-runtime.json'), '{"stale":true}', 'utf8');
  const code = [...runtimeNames, testCompanionName].sort();
  let previous;
  for (let n = 0; n < 2; n++) {
    await invoke(inputs, ['libav-collect', '--prefix', prefix]);
    const data = json(path.join(prefix, 'bin/ffmpeg-runtime.json'));
    assert.deepEqual(Object.fromEntries(['schema_version', 'kind', 'version', 'target', 'runtime_files', 'build_run', 'build_attempt', 'drivers'].map(key => [key, data[key]])),
      { schema_version: 1, kind: 'libav', version: '9.0.1', target: nativeTarget(), runtime_files: runtimeNames, build_run: 'local', build_attempt: '1', drivers: {} });
    assert.deepEqual(Object.keys(data.binaries).sort(), code);
    assert.deepEqual(readdirSync(path.join(prefix, 'bin')).sort(), [...code, 'ffmpeg-runtime.json'].sort(), 'no stale/private executables in collected output');
    assert.ok(!data.runtime_files.includes(testCompanionName), 'fault-injection companion is build-only');
    for (const [name, facts] of Object.entries(data.binaries)) {
      const file = path.join(prefix, 'bin', name), stat = lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `materialized native code: ${name}`);
      // Lightweight CI prepares upstream lib/ plus the companions in bin/;
      // collection itself materializes the selected libraries into bin/.
      const source = path.join(inputs.prefix, [companionName, testCompanionName].includes(name) ? 'bin' : 'lib', name);
      assert.equal(stat.mode & 0o7777, lstatSync(realpathSync(source)).mode & 0o7777, `native mode: ${name}`);
      const inspected = await runNative('readelf', ['-h', '-d', '--wide', file], inputs.environment);
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.ok(inspected.stdout.includes('Library runpath: [$ORIGIN]'), inspected.stdout);
      const machine = inspected.stdout.match(/Machine:\s*([^\n]+)/)?.[1].trim();
      assert.equal(machine, process.arch === 'arm64' ? 'AArch64' : 'Advanced Micro Devices X86-64', 'actual ELF architecture');
      const imports = [...inspected.stdout.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match => match[1]);
      assert.deepEqual(facts, { machine: process.arch === 'arm64' ? 'arm64' : 'x64', imports });
      for (const dependency of imports) assert.ok(systemImports.has(dependency) || code.includes(dependency), `unpermitted system/private import: ${dependency}`);
    }
    if (previous) assert.deepEqual(data, previous);
    previous = data;
  }
});

test('actual Linux C-only cache round trip; ten invalid hits never mutate an existing prefix', {
  skip: process.platform !== 'linux' ? 'Actual native Linux upstream-cache round trip; native foreign cache tests remain separate' : false,
  timeout: 500_000,
}, async t => {
  const upstream = path.join(inputs.directory, 'upstream C only'), cache = path.join(inputs.directory, 'Rust cache');
  for (const directory of ['lib', 'include', 'share', 'source', 'licenses']) {
    copyTree(path.join(inputs.prefix, directory), path.join(upstream, directory), from => !['ffmpeg', 'ffprobe'].includes(path.basename(from)));
  }
  mkdirSync(path.join(upstream, 'records')); mkdirSync(path.join(upstream, 'bin'));
  for (const name of ['signature.log', 'configure.log', 'build.log', 'install.log', 'config.log', 'config.h', 'config_components.h', 'config.mak', 'libav-linker-flags.rsp']) {
    const source = path.join(inputs.prefix, 'records', name);
    if (existsSync(source) && lstatSync(source).isFile()) copyFile(source, path.join(upstream, 'records', name));
  }
  const overrides = { BILIKARA_LIBAV_PREFIX: inputs.prefix }, expected = inventory(upstream);
  await invoke(inputs, ['libav-cache', 'snapshot', upstream, cache], true, overrides);
  assert.deepEqual(inventory(cache, true), expected, 'all upstream bytes, paths, modes and links survive snapshot');
  const manifest = json(path.join(cache, 'cache-manifest.json'));
  assert.equal(manifest.schema_version, 3); assert.equal(manifest.target, nativeTarget());
  assert.match(manifest.key, new RegExp(`^libav-v3-Linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-[a-f0-9]{64}$`));
  assert.deepEqual(Object.keys(manifest.entries).sort(), [...expected.keys()].sort(), 'complete independently enumerated cache entries');
  for (const [name, record] of expected) {
    assert.ok(['bin', 'lib', 'include', 'share', 'source', 'licenses', 'records'].includes(name.split('/')[0]), name);
    assert.doesNotMatch(name, /(?:bilikara|test_shim|runtime-test|build-info\.json|build_config\.h|ffmpeg-runtime\.json|driver)/i);
    const { mode, ...link } = record;
    assert.deepEqual(manifest.entries[name], record.kind === 'link' ? link : record, `independent cache facts: ${name}`);
  }
  const restored = path.join(inputs.directory, 'restored C 产物');
  await invoke(inputs, ['libav-cache', 'restore', cache, restored], true, overrides);
  assert.deepEqual(inventory(restored), expected, 'all restored file bytes/modes/link targets');
  assert.equal(existsSync(path.join(restored, 'driver')), false);
  assert.equal(existsSync(path.join(restored, 'bin/build-info.json')), false);

  const destination = path.join(inputs.directory, 'existing output'); mkdirSync(path.join(destination, 'bin'), { recursive: true });
  writeFileSync(path.join(destination, 'build-info.json'), 'previous completion', 'utf8');
  writeFileSync(path.join(destination, 'bin/ffmpeg-runtime.json'), 'previous manifest', 'utf8');
  const before = inventory(destination);
  for (const scenario of ['content', 'target', 'toolchain', 'malformed', 'source', 'license', 'private', 'unsafe path', 'unsafe link', 'interrupted']) {
    await t.test(scenario, async () => {
      const bad = path.join(inputs.directory, `invalid cache ${scenario}`); copyTree(cache, bad);
      const completion = path.join(bad, 'cache-manifest.json'), data = json(completion);
      if (scenario === 'content') writeFileSync(path.join(bad, 'include/libavutil/avutil.h'), 'corruption');
      else if (scenario === 'target') data.target = 'foreign-target';
      else if (scenario === 'toolchain') data.key = 'wrong compiler/key';
      else if (['source', 'license'].includes(scenario)) {
        const name = scenario === 'source' ? 'source/ffmpeg-9.0.1.tar.xz' : 'licenses/COPYING.LGPLv2.1';
        unlinkSync(path.join(bad, name)); delete data.entries[name];
      } else if (scenario === 'private') {
        const names = readdirSync(path.join(bad, 'lib')).filter(name => name.startsWith('libswresample.so'));
        assert.ok(names.length, 'real private dependency must exist before corruption');
        for (const name of names) { delete data.entries[`lib/${name}`]; unlinkSync(path.join(bad, 'lib', name)); }
      } else if (scenario === 'unsafe path') data.entries['../user-data'] = { kind: 'file' };
      else if (scenario === 'unsafe link') {
        const link = path.join(bad, 'lib/libavcodec.so'); unlinkSync(link); symlinkSync(path.join(inputs.prefix, 'lib/libavcodec.so'), link);
      } else if (scenario === 'interrupted') unlinkSync(completion);
      if (scenario !== 'interrupted') writeFileSync(completion, scenario === 'malformed' ? '{broken' : JSON.stringify(data), 'utf8');
      await invoke(inputs, ['libav-cache', 'restore', bad, destination], false, overrides);
      assert.deepEqual(inventory(destination), before, `invalid declared ${scenario} cache must preserve the existing complete destination`);
    });
  }
});
