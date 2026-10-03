// Recording shell commands qualify PATH/argv/bootstrap behavior, not MSVC binaries.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executableOnPath, root, runNative } from './desktop_construction_support.mjs';

const portable = value => value.split(path.sep).join('/');
const initializer = path.join(root, 'scripts/msvc-bash-env.sh');
const gitBash = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : undefined;
const bash = gitBash && existsSync(gitBash) ? gitBash : executableOnPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
const arguments_ = ['space 中文', 'literal ; $(touch evaluated)', 'quote \' " ${HOME} `touch evaluated`', 'backslash \\'];

function script(file, contents) {
  writeFileSync(file, '#!/usr/bin/env bash\n' + contents, 'utf8');
  chmodSync(file, 0o755);
}
function fixture(t, arch) {
  assert.ok(bash, 'Bash is required for the MSVC startup regression');
  const directory = mkdtempSync(path.join(tmpdir(), 'bilikara-msvc-path-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = path.join(directory, 'selected tools 中文 $()');
  const selected = path.join(tools, 'bin', 'Host' + arch, arch);
  const shadow = path.join(directory, 'Git tools 中文');
  mkdirSync(selected, { recursive: true }); mkdirSync(shadow);
  script(path.join(selected, 'link.exe'), `printf '%s\\0' 'native-msvc ${arch}' "$PWD" "\${RUSTUP_TOOLCHAIN-}" "$@"\nexit "\${LINK_RECORD_EXIT:-0}"\n`);
  script(path.join(selected, 'cl.exe'), 'exit 0\n');
  script(path.join(shadow, 'link.exe'), "printf '%s\\n' 'wrong Git link selected' >&2\nexit 19\n");
  script(path.join(shadow, 'cargo'), 'link.exe "$@"\n');
  if (process.platform !== 'win32') {
    // cygpath is native on Windows. A POSIX sh stub must not load BASH_ENV
    // recursively while emulating that conversion on the other platforms.
    const converter = path.join(shadow, 'cygpath');
    writeFileSync(converter, '#!/bin/sh\ntest "$1" = -u || exit 23\nprintf \'%s\\n\' "$2"\n', 'utf8');
    chmodSync(converter, 0o755);
  }
  const originalPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  const env = { ...environment, PATH: portable(shadow) + ':' + originalPath,
    VCToolsInstallDir: portable(tools), VSCMD_ARG_HOST_ARCH: arch, VSCMD_ARG_TGT_ARCH: arch,
    RUSTUP_TOOLCHAIN: 'explicit-user-override', LINK_RECORD_EXIT: '0', BASH_ENV: portable(initializer) };
  // Native Windows PATH uses semicolons; Bash converts it before BASH_ENV runs.
  if (process.platform === 'win32') env.PATH = shadow + ';' + originalPath;
  return { directory, selected, shadow, env };
}
async function invoke(data, extraEnv = {}) {
  return runNative(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', 'cargo "$@"', 'MSVC path test', ...arguments_],
    { ...data.env, ...extraEnv }, 20_000, data.directory);
}

for (const arch of ['x64', 'arm64']) {
  test(`BASH_ENV places selected ${arch} tools before Git link without changing argv, cwd or toolchain`, async t => {
    const data = fixture(t, arch);
    const baseline = await invoke(data, { BASH_ENV: '' });
    assert.notEqual(baseline.status, 0, 'the shadow link must reproduce the startup failure');
    const result = await invoke(data);
    assert.equal(result.status, 0, result.stderr);
    const fields = result.stdout.split('\0'); assert.equal(fields.pop(), '');
    assert.equal(fields[0], `native-msvc ${arch}`);
    assert.equal(fields[1].split('/').at(-1), path.basename(data.directory));
    assert.equal(fields[2], 'explicit-user-override');
    assert.deepEqual(fields.slice(3), arguments_);
    assert.equal(result.stderr, '');
    assert.equal(existsSync(path.join(data.directory, 'evaluated')), false);
    const failed = await invoke(data, { LINK_RECORD_EXIT: '29' });
    assert.equal(failed.status, 29, failed.stderr);
    assert.match(failed.stdout, /native-msvc/);
  });
}

test('startup refuses missing MSVC environment or selected tools before Cargo can run', async t => {
  const data = fixture(t, 'x64');
  for (const change of [{ VCToolsInstallDir: '' }, { VSCMD_ARG_HOST_ARCH: '' }, { VSCMD_ARG_TGT_ARCH: '' }]) {
    const result = await invoke(data, change);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /Native MSVC environment is required/);
    assert.doesNotMatch(result.stderr, /wrong Git link/);
  }
  rmSync(path.join(data.selected, 'link.exe'));
  const missing = await invoke(data);
  assert.notEqual(missing.status, 0); assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /compiler\/linker are unavailable/);
});

test('actual Windows setup exports the initializer after architecture checks, with LF checkout and a live test caller', () => {
  const setup = readFileSync(path.join(root, 'scripts/setup_msvc.ps1'), 'utf8');
  assert.match(setup, /Join-Path \$PSScriptRoot 'msvc-bash-env\.sh'/);
  assert.match(setup, /"BASH_ENV=\$bashEnv" \| Out-File -FilePath \$env:GITHUB_ENV -Encoding utf8 -Append/);
  assert.ok(setup.indexOf('BASH_ENV=$bashEnv') > setup.indexOf("throw 'MSVC did not initialize"));
  assert.doesNotMatch(setup, /rustup default|RUSTUP_TOOLCHAIN=/);
  assert.match(readFileSync(path.join(root, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n'), /^scripts\/msvc-bash-env\.sh text eol=lf$/m);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['test:desktop-build'].includes('tests/msvc_bash_env.test.mjs'));
});

test('bundle CI executes the real MSVC header/path regression after native setup and before the libav recipe', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8');
  const bundle = workflow.slice(workflow.indexOf('\n  bundle:'), workflow.indexOf('\n  android-apk:'));
  const setup = bundle.indexOf("run: ./scripts/setup_msvc.ps1 -Arch");
  const probe = bundle.indexOf('cargo test --manifest-path xtask/Cargo.toml --locked --target host-tuple windows_msvc_companion_paths_compile_generated_header -- --ignored');
  const libraries = bundle.indexOf('run: bash media-libav/build-windows.sh');
  assert.ok(setup >= 0 && probe > setup && libraries > probe);
  const step = bundle.slice(bundle.lastIndexOf('      - name:', probe), bundle.indexOf('\n      - name:', probe));
  assert.ok(step.includes("if: runner.os == 'Windows'"));
  assert.ok(step.includes('shell: bash'));
  assert.doesNotMatch(step, /continue-on-error|\|\| true/);
});
