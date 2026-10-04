import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
