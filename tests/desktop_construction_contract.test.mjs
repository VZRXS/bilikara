// Native command fixtures qualify construction contracts, not product startup.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ConstructionFixtures, digest, root, runNative } from './desktop_construction_support.mjs';
import { assertInventory, inventory, nativeTarget, suffix } from './desktop_construction_expectations.mjs';

let fixtures;
before(async () => { fixtures = await ConstructionFixtures.create(); });
after(() => { fixtures?.close(); });
function preparation(name, check) { test(`prepare: ${name}`, t => check(fixtures.scenario(t))); }
function release(name, check) { test(`release: ${name}`, t => check(fixtures.scenario(t, true))); }
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const opposite = target => target.startsWith('x86_64') ? target.replace('x86_64', 'aarch64') : target.replace('aarch64', 'x86_64');

test('POSIX inventory retains native symlink permissions and exact relative targets', {
  skip: process.platform === 'win32' ? 'POSIX package links; Windows directory layout has no such links' : false,
}, t => {
  const c = fixtures.scenario(t);
  const directory = path.join(c.directory, 'relative links'); mkdirSync(directory);
  writeFileSync(path.join(directory, 'target'), 'independent bytes');
  symlinkSync('target', path.join(directory, 'link'));
  assert.deepEqual(inventory(directory).get('link'), {
    kind: 'symlink', mode: process.platform === 'darwin' ? 0o777 & ~process.umask() : 0o777, target: 'target', live: true,
  });
});

test('macOS inventory normalizes signature envelopes and detects changed code bytes', {
  skip: process.platform !== 'darwin' ? 'Requires native Mach-O and codesign; not foreign-platform signing evidence' : false,
}, async t => {
  const c = fixtures.scenario(t);
  const directories = ['original', 'resealed'].map(name => path.join(c.directory, name));
  for (const [index, directory] of directories.entries()) {
    mkdirSync(directory);
    const binary = path.join(directory, 'code'); copyFileSync(fixtures.fixture, binary);
    const signed = await runNative('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier',
      index ? 'bilikara.construction.a.much.longer.bundle.identity' : 'fixture', binary]);
    assert.equal(signed.status, 0, signed.stderr);
  }
  const before = inventory(directories[0]);
  assertInventory(before, inventory(directories[1]));
  const changed = path.join(directories[1], 'code');
  const bytes = readFileSync(changed), marker = Buffer.from('BBDown 1.6.3');
  const offset = bytes.indexOf(marker); assert.ok(offset >= 0, 'independent native fixture must contain the tool version');
  bytes[offset + marker.length - 1] = '4'.charCodeAt(0); writeFileSync(changed, bytes);
  const signed = await runNative('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', changed]);
  assert.equal(signed.status, 0, signed.stderr);
  assert.throws(() => assertInventory(before, inventory(directories[1])), /product bytes\/metadata\/mode\/link: code/);
});

preparation('repeated staging preserves user data and replaces stale static resources', async c => {
  const { output, commands } = await c.checkPreparation();
  assert.equal(commands[0].filter(a => a === '--bin').length, 2);
  const data = path.join(output, 'runtime/data'); mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'sentinel'), 'never remove');
  const stale = path.join(output, '_internal/static/stale-generated-file'); writeFileSync(stale, 'remove');
  for (const name of [`bilikara-updater${suffix}`, 'static/desktop-startup.html']) assert.ok(existsSync(path.join(output, '_internal', name)));
  assert.equal(existsSync(path.join(output, '_internal/static/vendor')), false);
  const retained = new Map([...inventory(output)].filter(([name]) => name === 'runtime' || name.startsWith('runtime/')));
  await c.checkPreparation({}, [], undefined, retained);
  assert.equal(existsSync(stale), false); assert.equal(readFileSync(path.join(data, 'sentinel'), 'utf8'), 'never remove');
});

preparation('prepared inputs work for debug and explicit release, with strict BBDown pin', async c => {
  const prefix = c.prefix(); c.toolFixture();
  for (const debug of ['true', 'false', '0']) {
    const { output, commands } = await c.checkPreparation({ BILIKARA_LIBAV_PREFIX: prefix, TAURI_ENV_DEBUG: debug, BILIKARA_BBDOWN_VERSION: '1.6.3' });
    assert.equal(commands[0].includes('--release'), debug !== 'true');
    assert.equal(json(path.join(output, '_internal/native-desktop.json')).development, debug === 'true');
    assert.ok(existsSync(path.join(output, 'license/THIRD_PARTY_SOURCES/xtask/Cargo.toml')));
  }
  await c.checkPreparation({ BILIKARA_LIBAV_PREFIX: prefix, TAURI_ENV_DEBUG: 'false', BILIKARA_BBDOWN_VERSION: 'incorrect' }, [], 'does not match pinned');
  await c.checkPreparation({ BILIKARA_LIBAV_PREFIX: prefix, TAURI_ENV_DEBUG: 'false', BILIKARA_BBDOWN_VERSION: '1.6.3',
    XTASK_FIXTURE_TOOL_VERSION: 'BBDown 9.9.9' }, [], 'does not match pinned');
});

preparation('explicit and environment targets retain precedence; mobile hooks do nothing', async c => {
  const target = nativeTarget();
  await c.checkPreparation({ TAURI_ENV_TARGET_TRIPLE: target });
  const { commands } = await c.checkPreparation({ CARGO_BUILD_TARGET: target, TAURI_ENV_TARGET_TRIPLE: 'foreign' });
  assert.ok(commands[0].includes('--target'));
  await c.checkPreparation({ CARGO_BUILD_TARGET: 'foreign' }, ['--target', target]);
  await c.checkPreparation({}, ['--target=foreign', `--target=${target}`]);
  await c.checkPreparation({ TAURI_ENV_TARGET_TRIPLE: 'foreign' }, [], 'matching target');
  await c.checkPreparation({}, ['--target', 'foreign'], 'matching target');
  for (const platform of ['android', 'ios']) {
    const { output, commands: mobile } = await c.runPreparation(`mobile-${platform}`, {
      TAURI_ENV_PLATFORM: platform, BILIKARA_LIBAV_PREFIX: 'invalid', TAURI_ENV_DEBUG: 'false', CARGO_BUILD_TARGET: 'foreign',
    });
    assert.deepEqual(mobile, []); assert.equal(existsSync(output), false);
  }
});

preparation('metadata/custom shared Cargo directories and special paths work repeatedly', async c => {
  const outputs = [];
  for (const name of ['first', 'second']) {
    const env = { CARGO_TARGET_DIR: path.join(c.directory, `${name} shared Cargo 空 $() &`), CARGO_BUILD_TARGET: nativeTarget() };
    const { output } = await c.runPreparation(name, env); await c.runPreparation(name, env); outputs.push(output);
  }
  assertInventory(inventory(outputs[0]), inventory(outputs[1]));
});

preparation('bad prefix, tools, dependencies, provenance and manifest fail closed', async c => {
  await c.checkPreparation({ BILIKARA_LIBAV_PREFIX: 'relative' }, [], 'absolute same-build prefix');
  await c.checkPreparation({ TAURI_ENV_DEBUG: 'false' }, [], 'BILIKARA_LIBAV_PREFIX is required');
  const prefix = c.prefix(); const env = { BILIKARA_LIBAV_PREFIX: prefix };
  await c.checkPreparation({ ...env, TAURI_ENV_DEBUG: 'false' }, [], 'Prepare the pinned BBDown vendor');
  const manifestFile = path.join(prefix, 'bin/ffmpeg-runtime.json'); const manifest = json(manifestFile);
  for (const [changes, error] of [
    [{ version: '8.1.2' }, 'Invalid packaged FFmpeg manifest'],
    [{ runtime_files: [...manifest.runtime_files, '../bad.dll'] }, 'Invalid packaged runtime filename'],
    [{ runtime_files: [...manifest.runtime_files, manifest.runtime_files[0]] }, 'Incomplete packaged FFmpeg manifest'],
    [{ target: opposite(manifest.target) }, 'does not match the native package target'],
  ]) {
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, ...changes })); await c.checkPreparation(env, [], error);
  }
  writeFileSync(manifestFile, JSON.stringify(manifest));
  for (const [name, error] of [[`bin/${manifest.runtime_files[1]}`, 'dependency is missing'], ['build-info.json', 'provenance is incomplete']]) {
    const file = path.join(prefix, name); const bytes = readFileSync(file); rmSync(file);
    try { await c.checkPreparation(env, [], error); } finally { writeFileSync(file, bytes); }
  }
  writeFileSync(manifestFile, '{bad json'); await c.runPreparation('malformed', env, [], 'key must be a string');
});

preparation('trusted version override trims whitespace and rejects invalid labels', async c => {
  const { output } = await c.checkPreparation({ BILIKARA_VERSION: '  explicit+version  ', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' });
  assert.equal(readFileSync(path.join(output, '_internal/APP_VERSION'), 'utf8'), 'explicit+version\n');
  await c.checkPreparation({ BILIKARA_VERSION: 'invalid version' }, [], 'Invalid trusted build version');
});

preparation('native-only PATH builds/stages both binaries without application imports', async c => {
  const { output, commands } = await c.checkPreparation({ PATH: c.nativeOnlyPath() });
  assert.ok(existsSync(path.join(output, '_internal/native-desktop.json')));
  assert.equal(commands[0].filter(a => a === '--bin').length, 2);
  const manifest = readFileSync(path.join(root, 'xtask/Cargo.toml'), 'utf8');
  assert.doesNotMatch(manifest, /bilikara[-_]runtime\s*=/, 'build tool must not link the application Runtime');
  assert.equal(fixtures.compiledTargets.includes('bilikara_runtime'), false, 'actual compiled dependency graph must exclude Runtime, including aliases');
});

release('full entry builds release Host/updater and shell once with complete compliance', async c => {
  const { commands } = await c.checkRelease({ TAURI_ENV_DEBUG: 'true', TAURI_ENV_PLATFORM: 'android' });
  assert.ok(commands[0].includes('--release')); assert.ok(commands[0].includes('native-host'));
  assert.equal(commands[0].filter(a => a === '--bin').length, 2);
  assert.equal(commands.filter(a => a[0] === 'exec').length, 1);
  const resources = path.join(c.product, process.platform === 'darwin' ? 'Contents/Resources' : '_internal');
  assert.equal(json(path.join(resources, 'native-desktop.json')).development, false);
  const docs = process.platform === 'darwin' ? path.join(resources, 'license') : path.join(c.product, 'license');
  for (const name of ['ffmpeg-9.0.1.tar.xz', 'xtask/Cargo.toml']) assert.ok(existsSync(path.join(docs, 'THIRD_PARTY_SOURCES', name)));
  assert.equal(existsSync(path.join(resources, 'static/vendor')), false);
});

release('split CI assembly reuses the shell without a hidden Cargo or npm invocation', async c => {
  const { env } = await c.checkRelease({}, [], undefined, false);
  const { commands } = await c.checkRelease(); const final = process.platform === 'darwin' ? path.join(c.dist, 'bilikara-desktop.app') : c.product;
  const expected = inventory(final);
  const shell = path.join(c.directory, 'release/cargo outputs 空/src-tauri/release', process.platform === 'darwin' ? 'bundle/macos/bilikara.app' : `bilikara${suffix}`);
  writeFileSync(env.XTASK_FIXTURE_LOG, ''); await c.invoke('assemble-desktop', env, ['--shell', shell]);
  assert.equal(readFileSync(env.XTASK_FIXTURE_LOG, 'utf8'), '');
  assert.equal(commands.filter(a => a[0] === 'exec').length, 1); assertInventory(expected, inventory(final));
});

release('complete command succeeds on a controlled PATH without any Python executable', async c => {
  const { commands } = await c.checkRelease({ PATH: c.nativeOnlyPath() });
  assert.equal(commands.filter(a => a[0] === 'build').length, 1);
  assert.equal(commands.filter(a => a[0] === 'exec').length, 1);
  assert.ok(existsSync(c.product));
});

release('target precedence and repeated shared output paths preserve the contract', async c => {
  await c.checkRelease({ CARGO_BUILD_TARGET: 'foreign', TAURI_ENV_TARGET_TRIPLE: 'foreign' }, ['--target', nativeTarget()]);
  const { commands } = await c.checkRelease({ CARGO_BUILD_TARGET: nativeTarget() }); assert.ok(commands[0].includes('--target'));
  const env = { CARGO_TARGET_DIR: path.join(c.directory, 'shared Cargo target 空 $() &') };
  await c.checkRelease(env); await c.checkRelease(env); await c.checkRelease({ CARGO_BUILD_TARGET: 'foreign' }, [], 'matching target');
});

release('BBDown compliance preserves universal newline conversion', async c => {
  await c.checkRelease({ XTASK_FIXTURE_TOOL_VERSION: 'BBDown 1.6.3\r\nbanner\rline' });
});

release('required tool and complete prefix cannot fall back to development or system', async c => {
  await c.checkRelease({ BILIKARA_LIBAV_PREFIX: '', TAURI_ENV_DEBUG: 'true' }, [], 'BILIKARA_LIBAV_PREFIX is required');
  await c.checkRelease({ BILIKARA_LIBAV_PREFIX: 'relative' }, [], 'absolute same-build prefix');
  await c.checkRelease({ BILIKARA_LIBAV_PREFIX: path.join(c.directory, 'absent prefix') }, [], 'incomplete; no system fallback');
  await c.checkRelease({ BILIKARA_BBDOWN_VERSION: 'incorrect' }, [], 'does not match pinned');
  rmSync(path.join(c.bin, `BBDown${suffix}`)); await c.checkRelease({}, [], 'Prepare the pinned BBDown vendor');
});

release('invalid libraries, provenance, source digest, license and JSON are rejected', async c => {
  const file = path.join(c.prepared, 'bin/ffmpeg-runtime.json'); const manifest = json(file);
  for (const [changes, error] of [[{ kind: 'ffmpeg' }, 'Invalid packaged FFmpeg manifest'],
    [{ version: '8.1.2' }, 'Invalid packaged FFmpeg manifest'], [{ target: opposite(manifest.target) }, 'does not match the native package target'],
    [{ runtime_files: [...manifest.runtime_files, '../bad'] }, 'Invalid packaged runtime filename'],
    [{ runtime_files: [...manifest.runtime_files, manifest.runtime_files[0]] }, 'Incomplete packaged FFmpeg manifest']]) {
    writeFileSync(file, JSON.stringify({ ...manifest, ...changes })); await c.checkRelease({}, [], error);
  }
  writeFileSync(file, JSON.stringify(manifest));
  for (const [name, error] of [[`bin/${manifest.runtime_files[1]}`, 'dependency is missing'],
    ['source/ffmpeg-9.0.1.tar.xz', 'provenance is incomplete'], ['build-info.json', 'provenance is incomplete'],
    ['licenses/COPYING.LGPLv2.1', 'provenance is incomplete']]) {
    const input = path.join(c.prepared, name); const hidden = `${input}.hidden`; renameSync(input, hidden);
    try { await c.checkRelease({}, [], error); } finally { renameSync(hidden, input); }
  }
  await c.checkRelease({ BILIKARA_FFMPEG_SOURCE_SHA256: '0'.repeat(64) }, [], 'SHA-256 mismatch');
  await c.checkRelease({ BILIKARA_FFMPEG_SOURCE_ARCHIVE: path.join(c.directory, 'missing.tar.xz') }, [], 'source archive not found');
  await c.checkRelease({ BILIKARA_BBDOWN_LICENSE_FILE: path.join(c.directory, 'missing-license.txt') }, [], 'BBDown license file not found');
  writeFileSync(file, '{invalid'); await c.releasePath({}, [], 'key must be a string');
});

release('repeated construction preserves unrelated artifacts and refuses user data', async c => {
  const { env } = await c.checkRelease(); const unrelated = path.join(c.dist, 'unrelated-artifact'); writeFileSync(unrelated, 'preserve');
  await c.checkRelease(); assert.equal(readFileSync(unrelated, 'utf8'), 'preserve');
  const data = path.join(c.product, 'runtime/data'); mkdirSync(data, { recursive: true });
  const sentinel = path.join(data, 'sentinel'); writeFileSync(sentinel, 'user data is not generated output');
  const before = inventory(c.product); await c.invoke('build-backend', env, [], 'containing user data');
  assertInventory(before, inventory(c.product)); assert.equal(readFileSync(sentinel, 'utf8'), 'user data is not generated output');
});

release('assembly refuses debug/incompatible/version metadata and a missing updater', async c => {
  const { env } = await c.checkRelease({}, [], undefined, false);
  const resources = path.join(c.product, process.platform === 'darwin' ? 'Contents/Resources' : '_internal');
  const file = path.join(resources, 'native-desktop.json'); const original = readFileSync(file);
  for (const [changes, error] of [[{ development: true }, 'matching release backend'], [{ arch: 'foreign' }, 'matching release backend'],
    [{ version: 'wrong' }, 'version/manifest mismatch']]) {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...changes })); await c.invoke('assemble-desktop', env, ['--shell', c.fixture], error);
  }
  writeFileSync(file, original);
  const code = process.platform === 'darwin' ? path.join(c.product, 'Contents/MacOS') : resources;
  rmSync(path.join(code, `bilikara-updater${suffix}`));
  await c.invoke('assemble-desktop', env, ['--shell', c.fixture], process.platform === 'darwin'
    ? 'bilikara-updater (No such file or directory)' : 'os error 2');
});

release('cleanup refuses overlapping supplied tool/archive/license without changing bytes', async c => {
  const { env } = await c.checkRelease({}, [], undefined, false);
  for (const kind of ['tool', 'archive', 'license']) {
    const supplied = path.join(c.product, kind === 'tool' ? `BBDown${suffix}` : 'prepared input');
    copyFileSync(path.join(c.bin, `BBDown${suffix}`), supplied); const guarded = { ...env };
    if (kind === 'tool') guarded.PATH = `${c.product}${path.delimiter}${env.PATH}`;
    else if (kind === 'archive') { guarded.BILIKARA_FFMPEG_SOURCE_ARCHIVE = supplied; guarded.BILIKARA_FFMPEG_SOURCE_SHA256 = digest(readFileSync(supplied)); }
    else guarded.BILIKARA_BBDOWN_LICENSE_FILE = supplied;
    const before = inventory(c.product); await c.invoke('build-backend', guarded, [], 'overlaps a prepared input');
    assertInventory(before, inventory(c.product)); rmSync(supplied);
  }
});

test('driver timeout terminates the actual xtask and its blocked native Cargo descendant', async t => {
  const c = fixtures.scenario(t); const record = path.join(c.directory, 'blocked child.pid');
  const env = { ...c.environment, XTASK_FIXTURE_BLOCK_PID: record };
  await assert.rejects(runNative(c.tool, ['prepare-desktop'], env, 2_000), { code: 'ETIMEDOUT' });
  const pid = Number(readFileSync(record, 'utf8')); assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  function running() {
    try {
      if (process.platform === 'linux') return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      process.kill(pid, 0); return true;
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
  }
  for (let n = 0; n < 50 && running(); n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(running(), false, 'owned descendant still running after timeout cleanup');
});

test('one local/CI command executes these construction contracts after native bootstrap', () => {
  const pkg = json(path.join(root, 'package.json'));
  assert.equal(pkg.scripts['test:desktop-build'], 'node --test tests/desktop_prepare_entry.test.mjs tests/bbdown_prepare_entry.test.mjs tests/native_package_entry.test.mjs tests/desktop_construction_contract.test.mjs');
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  bundle:'));
  const command = job.indexOf('npm run test:desktop-build'); assert.ok(command >= 0);
  for (const prerequisite of ['actions/setup-node@v6', 'node-version: 24', 'rustup toolchain install', 'cargo build --manifest-path xtask/Cargo.toml --locked --target host-tuple']) {
    assert.ok(job.indexOf(prerequisite) >= 0 && job.indexOf(prerequisite) < command, prerequisite);
  }
  assert.equal(job.split('npm run test:desktop-build').length, 2, 'execute the suite once');
  assert.doesNotMatch(job, /node --test[^\n]*desktop_construction_contract|python[^\n]*(?:test_desktop_prepare_contract|test_desktop_release_contract)/);
  for (const file of ['tests/test_desktop_prepare_contract.py', 'tests/test_desktop_release_contract.py', 'tests/desktop_build_expectations.py']) {
    assert.equal(existsSync(path.join(root, file)), false, file);
  }
});
