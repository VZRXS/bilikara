import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { asciiString, companionName, json, ownedDirectory, root, runNative } from './libav_prerequisite_support.mjs';
import { executableOnPath } from './desktop_construction_support.mjs';

test('independent ASCII header expectation preserves quotes, controls, Unicode and surrogate pairs', () => {
  assert.equal(asciiString('a"\\\b\f\n\r\t\u0000中文😀'), '"a\\"\\\\\\b\\f\\n\\r\\t\\u0000\\u4e2d\\u6587\\ud83d\\ude00"');
});

test('required real-library entry fails for absent, invalid and incompatible inputs before bootstrap', async t => {
  const directory = ownedDirectory('libav required input'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const invalid = path.join(directory, 'bin', companionName); mkdirSync(path.dirname(invalid)); writeFileSync(invalid, 'not a native library');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['BILIKARA_TEST_LIBAV_COMPANION', 'NODE_TEST_CONTEXT'].includes(key.toUpperCase())));
  for (const supplied of [undefined, path.join(directory, 'missing', companionName), invalid]) {
    const result = await runNative(process.execPath, ['--test', 'tests/libav_prerequisite_contract.test.mjs'],
      { ...environment, ...(supplied ? { BILIKARA_TEST_LIBAV_COMPANION: supplied } : {}), CC: path.join(directory, 'compiler-must-not-run') }, 20_000);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /BILIKARA_TEST_LIBAV_COMPANION/);
    assert.doesNotMatch(result.stdout + result.stderr, /compiler-must-not-run|# skipped 5/);
  }
  if (process.platform === 'linux') {
    const foreign = Buffer.alloc(64); foreign.write('7f454c46', 0, 'hex'); foreign[4] = 2; foreign[5] = 1;
    foreign.writeUInt16LE(3, 16); foreign.writeUInt16LE(process.arch === 'arm64' ? 62 : 183, 18); writeFileSync(invalid, foreign);
    const result = await runNative(process.execPath, ['--test', 'tests/libav_prerequisite_contract.test.mjs'],
      { ...environment, BILIKARA_TEST_LIBAV_COMPANION: invalid }, 20_000);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /incompatible native companion architecture/);
  }
});

test('real local and CI entries keep required native validation after the prefix and wrapper checks independent', () => {
  const scripts = json(path.join(root, 'package.json')).scripts;
  assert.equal(scripts['test:libav-wrapper'], 'node --test tests/libav_xtask_wrapper.test.mjs tests/libav_prerequisite_entry.test.mjs');
  assert.equal(scripts['test:libav-prerequisites'], 'node --test tests/libav_prerequisite_contract.test.mjs');
  assert.ok(!scripts['test:desktop-build'].includes('libav_prerequisite_contract'), 'early desktop fixtures cannot become an all-skipped real-library gate');
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  bundle:'));
  const wrapper = job.indexOf('npm run test:libav-wrapper'), real = job.indexOf('npm run test:libav-prerequisites');
  const prefix = job.indexOf('echo "BILIKARA_TEST_LIBAV_COMPANION=');
  assert.ok(wrapper >= 0 && prefix > wrapper && real > prefix);
  for (const setup of ['actions/setup-node@v6', 'node-version: 24', 'rustup toolchain install', 'cargo build --manifest-path xtask/Cargo.toml --locked --target host-tuple']) assert.ok(job.indexOf(setup) >= 0 && job.indexOf(setup) < wrapper, setup);
  assert.ok(job.indexOf('bash media-libav/build-posix-libraries.sh') < prefix);
  assert.ok(job.indexOf('libav-companion --prefix') < prefix);
  const block = job.split(/^      - name:/m).find(step => step.includes('npm run test:libav-prerequisites'));
  assert.match(block, /if: runner.os == 'Linux'/); assert.match(block, /shell: bash/); assert.match(block, /set -euo pipefail\s+npm run test:libav-prerequisites/);
  assert.doesNotMatch(block, /\|\|\s*true|continue-on-error|python/);
  for (const command of ['npm run test:libav-wrapper', 'npm run test:libav-prerequisites']) assert.equal(job.split(command).length, 2, `run ${command} once`);
  for (const file of ['tests/test_libav_prerequisite_contract.py', 'tests/test_libav_xtask_wrapper.py']) assert.equal(existsSync(path.join(root, file)), false, `retire ${file}`);

  const bundle = workflow.slice(workflow.indexOf('\n  bundle:'), workflow.indexOf('\n  android:'));
  const regression = bundle.indexOf('BILIKARA_LIBAV_COMPANION="$companion" cargo test');
  assert.ok(regression > bundle.indexOf('bash media-libav/build-posix.sh'));
  assert.ok(regression > bundle.indexOf('./media-libav/prepare-windows.ps1'));
  assert.ok(regression < bundle.indexOf('-- build-backend'), 'check the freshly prepared native companion before construction');
  const native = bundle.split(/^      - name:/m).find(step => step.includes('reordered_video_preserves_nonzero_start'));
  assert.match(native, /set -euo pipefail/);
  assert.match(native, /--locked --target host-tuple --lib .* -- --exact --ignored/);
  assert.ok(native.includes('Windows) companion="$BILIKARA_LIBAV_PREFIX/bin/bilikara_media_libav.dll"'));
  assert.ok(native.includes('macOS) companion="$BILIKARA_LIBAV_PREFIX/bin/libbilikara_media_libav.dylib"'));
  assert.doesNotMatch(native, /continue-on-error|\|\|\s*true|python/);
});

test('actual required CI run block propagates failing npm and cannot hide it with a later success', async () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8').replace(/\r\n/g, '\n');
  const block = workflow.split(/^      - name:/m).find(step => step.includes('npm run test:libav-prerequisites'));
  const script = block.split('run: |\n')[1].split('\n\n')[0].replace(/^          /gm, '');
  const gitBash = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : undefined;
  const bash = gitBash && existsSync(gitBash) ? gitBash : executableOnPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
  assert.ok(bash, 'native Bash is required for CI failure-propagation verification');
  const result = await runNative(bash, ['--noprofile', '--norc', '-c', `npm() { printf '%s\\n' "$@" >&2; return 23; }\n${script}\nprintf 'unexpected later success'`], process.env, 20_000);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stderr, 'run\ntest:libav-prerequisites\n'); assert.equal(result.stdout, '');
});

test('actual timestamp gate passes the existing native companion path and preserves Cargo failures', async t => {
  const directory = ownedDirectory('timestamp gate'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prefix = path.join(directory, 'prefix'); mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8').replace(/\r\n/g, '\n');
  const block = workflow.split(/^      - name:/m).find(step => step.includes('reordered_video_preserves_nonzero_start'));
  const script = block.split('run: |\n')[1].split('\n\n')[0].replace(/^          /gm, '');
  const gitBash = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : undefined;
  const bash = gitBash && existsSync(gitBash) ? gitBash : executableOnPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
  assert.ok(bash, 'native Bash is required for the actual timestamp gate');
  const stub = `cargo() {
    node -e 'process.stdout.write(JSON.stringify({ companion: process.env.BILIKARA_LIBAV_COMPANION, args: process.argv.slice(1) }))' "$@"
    return "\${CARGO_STATUS:-0}"
  }\n`;
  const invoke = (os, status = 0) => runNative(bash, ['--noprofile', '--norc', '-c', stub + script + '\nprintf "unexpected later success"'],
    { ...process.env, RUNNER_OS: os, BILIKARA_LIBAV_PREFIX: prefix + path.sep + '.', CARGO_STATUS: String(status) }, 20_000, directory);
  const expectedArgs = ['test', '--manifest-path', 'rust-runtime/Cargo.toml', '--locked', '--target', 'host-tuple', '--lib',
    'experimental_libav::remux::package_tests::reordered_video_preserves_nonzero_start', '--', '--exact', '--ignored'];
  for (const [os, filename] of [['Windows', 'bilikara_media_libav.dll'], ['macOS', 'libbilikara_media_libav.dylib']]) {
    const companion = path.join(prefix, 'bin', filename); writeFileSync(companion, 'path fixture, not a native library');
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await invoke(os, 29);
      assert.equal(result.status, 29, result.stdout + result.stderr);
      const record = JSON.parse(result.stdout);
      assert.equal(record.companion, realpathSync.native(companion));
      assert.deepEqual(record.args, expectedArgs);
      if (process.platform === 'win32') assert.ok(!record.companion.includes('/'), 'Win32 library paths must have native separators');
    }
    rmSync(companion);
    const missing = await invoke(os);
    assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
    assert.equal(missing.stdout, '', 'a missing companion must fail before Cargo and any later command');
  }
  const unsupported = await invoke('Linux');
  assert.equal(unsupported.status, 1); assert.equal(unsupported.stdout, '');
});
