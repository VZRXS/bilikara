import { readSourceText } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, runNative, executableOnPath } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { archiveMetadata, serializeMetadata } from '../scripts/tool_asset_metadata.mjs';

const read = file => readSourceText(path.join(root, file));
const bundle = read('.github/workflows/ci-bundle.yml'), tools = read('.github/workflows/tool-assets.yml');
const recipe = read('scripts/build_portable_macos_aria2.sh');
const includes = (text, values) => { for (const value of values) assert.ok(text.includes(value), value); };
const excludes = (text, values) => { for (const value of values) assert.ok(!text.includes(value), value); };
function step(workflow, name) {
  const marker = `      - name: ${name}\n`; const at = workflow.indexOf(marker); assert.ok(at >= 0, name);
  return workflow.slice(at + marker.length).split('      - name:')[0];
}
function script(workflow, name) {
  const block = step(workflow, name); assert.ok(block.includes('run: |\n'));
  return block.split('run: |\n')[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}
const gitBash = process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : null;
const bash = gitBash && existsSync(gitBash) ? gitBash : executableOnPath(process.platform === 'win32' ? 'bash.exe' : 'bash');
const portable = file => file.split(path.sep).join('/');
const runBash = (body, directory, env = process.env) => runNative(bash,
  ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], env, 20_000, directory);

test('actual macOS backend gate executes the relative tool link and rejects permissions/missing binaries', {skip: process.platform === 'win32'}, async () => {
  assert.ok(bash); const directory = ownedDirectory('macOS backend gate');
  const contents = path.join(directory, 'dist/bilikara.app/Contents');
  try {
    for (const name of ['MacOS', 'Frameworks', 'Resources/vendor']) mkdirSync(path.join(contents, name), {recursive: true});
    for (const name of ['bilikara-desktop-host', 'bilikara-updater']) {
      const file = path.join(contents, 'MacOS', name); writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755);
    }
    writeFileSync(path.join(contents, 'Resources/native-desktop.json'), '{}');
    const tool = path.join(contents, 'Frameworks/BBDown');
    writeFileSync(tool, '#!/bin/sh\nprintf "%s\\n" "$*" > calls.log\n'); chmodSync(tool, 0o755);
    symlinkSync('../../Frameworks/BBDown', path.join(contents, 'Resources/vendor/BBDown'));
    const invoke = () => runBash(script(bundle, 'Verify native backend and bundled tools on macOS'), directory);
    let result = await invoke(); assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(directory, 'calls.log'), 'utf8'), '--help\n');
    chmodSync(tool, 0o644); assert.notEqual((await invoke()).status, 0);
    rmSync(tool); assert.notEqual((await invoke()).status, 0);
    writeFileSync(tool, '#!/bin/sh\nexit 0\n'); chmodSync(tool, 0o755); assert.equal((await invoke()).status, 0);
    rmSync(path.join(contents, 'MacOS/bilikara-updater')); assert.notEqual((await invoke()).status, 0);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('Rust caches/features retain distinct test/product ownership and compiler-artifact driver selection', () => {
  const testJob = bundle.split('\n  test:\n')[1].split('\n  bundle:\n')[0];
  const bundleJob = bundle.split('\n  bundle:\n')[1].split('\n  android-bundle:\n')[0];
  const namespace = job => job.split('shared-key:')[1].split('\n')[0].trim();
  assert.notEqual(namespace(testJob), namespace(bundleJob));
  includes(testJob, ['CARGO_PROFILE_DEV_DEBUG: "line-tables-only"']); excludes(bundle, ['CARGO_PROFILE_RELEASE_']);
  includes(read('xtask/src/main.rs'), ['"--features",\n            "native-host"']);
  for (const file of ['build-posix.sh', 'prepare-windows.ps1']) {
    includes(read(`media-libav/${file}`), ['libav-finish']); excludes(read(`media-libav/${file}`), ['rust-runtime/Cargo.toml']);
  }
  includes(read('xtask/src/libav_prepare.rs'), ['"--features",\n            "native-host"', '"--release",\n            "--locked"',
    'command.args(["--lib", "--no-run"])', 'command.args(["--example", "libav_metadata"])', 'record["reason"] == "compiler-artifact"']);
});

test('actual lightweight Linux prerequisite stops on each failure before exporting incomplete outputs', {skip: process.platform === 'win32'}, async () => {
  assert.ok(bash); const directory = ownedDirectory('Linux workflow prerequisite');
  try {
    const prefix = path.join(directory, 'prefix'), envFile = path.join(directory, 'environment'), log = path.join(directory, 'calls.log');
    const stub = `bash() { printf 'bash:%s\\n' "$*" >> calls.log; test "$FAIL_AT" != libraries; }
cargo() { printf 'cargo:%s\\n' "$*" >> calls.log; test "$FAIL_AT" != companion; }\n`;
    const expected = ['bash:media-libav/build-posix-libraries.sh', `cargo:run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- libav-companion --prefix ${prefix} --out ${prefix}/bin --test`];
    for (const failure of ['', 'libraries', 'companion']) {
      rmSync(log, {force: true}); rmSync(envFile, {force: true});
      const result = await runBash(stub + script(bundle, 'Build libav prerequisite for packaged media tests'), directory,
        {...process.env, BILIKARA_LIBAV_PREFIX: prefix, GITHUB_ENV: envFile, FAIL_AT: failure});
      assert.deepEqual(readFileSync(log, 'utf8').trimEnd().split('\n'), failure === 'libraries' ? expected.slice(0, 1) : expected);
      if (failure) { assert.notEqual(result.status, 0); assert.equal(existsSync(envFile), false); }
      else { assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(envFile, 'utf8').trim(), `BILIKARA_TEST_LIBAV_COMPANION=${prefix}/bin/libbilikara_media_libav.so`); }
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('actual Rust gate preserves compiler failure status and stops before later commands', async () => {
  assert.ok(bash); const directory = ownedDirectory('Rust workflow failure');
  try {
    for (const name of ['rust', 'rust-runtime', 'src-tauri']) mkdirSync(path.join(directory, name));
    const stub = `cargo() { printf '%s\\n' "\${PWD##*/}:$*" >> ../calls.log; if [ "$1" = clippy ]; then return 42; fi; return 0; }\n`;
    const result = await runBash(stub + script(bundle, 'Rust Checks and Build'), directory);
    assert.equal(result.status, 42, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(path.join(directory, 'calls.log'), 'utf8').trimEnd().split('\n'), ['rust:fmt --check', 'rust:clippy --all-targets --locked -- -D warnings']);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('actual naming script preserves all branch/tag/architecture archive and upload identities', async () => {
  assert.ok(bash); const block = step(bundle, 'Resolve bundle archive name');
  includes(block, ['BUNDLE_SLUG: ${{ matrix.slug }}', 'BUNDLE_ARCH: ${{ matrix.arch }}']);
  const upload = step(bundle, 'Upload native bundle');
  includes(upload, ['uses: actions/upload-artifact@v7', 'path: ${{ steps.bundle-name.outputs.archive_name }}', 'archive: false']);
  excludes(upload, ['if: always()', 'dist/']); excludes(bundle, ['Upload native libav diagnostics', 'diagnostics-${{ steps.bundle-name.outputs.artifact_name }}', 'dist/libav-build-records']);
  assert.ok(bundle.indexOf('Resolve bundle archive name') < bundle.indexOf('Build Windows libav'));
  for (const slug of ['windows', 'macos']) for (const arch of ['x64', 'arm64']) {
    for (const [type, ref, suffix] of [['branch', 'work/v0.8.0', `${slug}-${arch}-work-v0.8.0`], ['branch', 'v0.8.0', `${slug}-${arch}-v0.8.0`],
      ['tag', 'v0.8.0', `v0.8.0-${slug}-${arch}`], ['tag', 'v0.8.0-preview.1', `v0.8.0-preview.1-${slug}-${arch}`],
      ['branch', '', `${slug}-${arch}-local`], ['branch', '///', `${slug}-${arch}-local`]]) {
      const directory = ownedDirectory('bundle naming');
      try {
        const output = path.join(directory, 'output'), envFile = path.join(directory, 'env');
        const result = await runBash(script(bundle, 'Resolve bundle archive name'), directory, {...process.env,
          GITHUB_REF_TYPE: type, GITHUB_REF_NAME: ref, BUNDLE_SLUG: slug, BUNDLE_ARCH: arch, GITHUB_OUTPUT: portable(output), GITHUB_ENV: portable(envFile)});
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const name = 'bilikara-' + suffix;
        assert.equal(readFileSync(output, 'utf8'), `archive_name=${name}.zip\nartifact_name=${name}\n`);
        assert.equal(readFileSync(envFile, 'utf8'), `BUNDLE_ARCHIVE=${name}.zip\n`);
      } finally { rmSync(directory, {recursive: true, force: true}); }
    }
  }
});

test('ordinary bundle keeps tool pins/preparation/signature/package gates without publication credentials', () => {
  excludes(bundle, ['macos-aria2-tools', 'build_portable_macos_aria2.sh', 'build_portable_macos_ffmpeg.sh', 'Publish immutable aria2c', 'Publish immutable FFmpeg', 'choco install ffmpeg']);
  const job = bundle.split('\n  bundle:\n')[1].split('\n  mirror-release-r2:\n')[0];
  includes(job, ['needs: test', 'BILIKARA_REQUIRE_TAURI_SMOKE=1', 'node --test tests/macos_tauri_smoke.test.mjs']);
  excludes(job, ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'aws s3', '--tool-smoke', "& './libav-smoke.ps1'", 'BILIKARA_REQUIRE_BACKEND_SMOKE', 'setup-python', 'pip install']);
  includes(bundle, ['Build Windows libav libraries and companion', '--target host-tuple -- verify-native-desktop', 'Build POSIX libav libraries and companion',
    '--target host-tuple -- prepare-bbdown', 'Verify native backend and bundled tools on Windows', 'Verify native backend and bundled tools on macOS',
    'Locked aria2c metadata-only checks', 'BBDown', 'bilikara_media_libav.dll', 'bilikara-desktop-host.exe', 'native-desktop.json']);
  excludes(bundle, ['ilammy/msvc-dev-cmd', 'for ($attempt', 'Start-Sleep', 'scripts/prepare_bbdown_vendor.py', 'Verify clean BBDown runtime restore on Windows',
    'BILIKARA_REQUIRE_ARIA2_TOOL_SMOKE=1', 'Packaged portable FFmpeg checks', 'Running extracted portable FFmpeg checks']);
  for (const name of ['build-windows', 'build-posix']) includes(read(`media-libav/${name}-libraries.sh`), ['--disable-programs']);
  includes(bundle, ['--target host-tuple -- assemble-desktop', 'bilikara-backend.app', 'codesign --verify --deep --strict --verbose=4 "$embedded_backend"']);
  excludes(bundle, ['python scripts/embed_macos_backend.py']);
  includes(read('tests/macos_tauri_smoke.mjs'), ['isolated-app', 'candidate_type=macos-embedded-backend', "PATH: '/usr/bin:/bin:/usr/sbin:/sbin'", 'finderEnvironment(home, cwd, log)', "'/api/health'"]);
});

test('shared Rust release split, native libav callers and prerequisite ordering stay enforced', () => {
  const backend = '--target host-tuple -- build-backend', assembly = '--target host-tuple -- assemble-desktop';
  includes(bundle, [backend, assembly]); excludes(bundle, ['python build_bundle.py', '-- build-desktop']);
  for (const platform of ['Windows', 'macOS']) {
    assert.ok(bundle.indexOf(backend) < bundle.indexOf(`Verify native backend and bundled tools on ${platform}`));
    assert.ok(bundle.indexOf(`Build Tauri App on ${platform}`) < bundle.indexOf(assembly));
  }
  const job = bundle.split('\n  bundle:\n')[1].split('\n  android-bundle:\n')[0];
  assert.ok(job.indexOf('Setup Node.js') < job.indexOf('Build Tauri App on Windows'));
  includes(job, ['./xtask -> target', '--target host-tuple -- prepare-bbdown', '--target host-tuple -- libav-cache key', '--target host-tuple -- verify-native-desktop',
    'Verify extracted Windows bundle', 'Archive and verify round-trip macOS bundle', 'plutil -lint', '--verify --deep --strict', 'README-macOS.txt']);
  assert.equal(bundle.split('--target host-tuple -- libav-cache key').length - 1, 2);
  excludes(bundle, ['python scripts/libav_cache.py', 'python media-libav/build.py']);
  for (const name of ['build-posix-libraries.sh', 'build-posix.sh', 'build-windows-libraries.sh', 'build-windows.sh', 'prepare-windows.ps1', 'xtask.sh']) {
    excludes(read(`media-libav/${name}`), ['pythonLocation', 'python3', 'python -', 'python media-', 'libav_cache.py', 'build.py', 'windows_libav_preview.py']);
  }
  for (const name of ['build-posix-libraries.sh', 'build-windows-libraries.sh']) includes(read(`media-libav/${name}`), ['libav-cache restore', 'libav-cache snapshot', 'set -euo pipefail', 'FCF986EA15E6E293A5644F10B4322F04D67658D8']);
  includes(read('media-libav/xtask.sh'), ['--target host-tuple']);
  // Other live Python suites remain explicitly installed/discovered until their own replacement.
  includes(bundle, ['python -m unittest discover -s tests -v', 'setup-python']);
});

test('native matrices and assembly preserve prerequisites, extracted gates and tag-only publication', () => {
  const testJob = bundle.split('\n  test:\n')[1].split('\n  bundle:\n')[0];
  const job = bundle.split('\n  bundle:\n')[1].split('\n  android-bundle:\n')[0];
  assert.deepEqual(JSON.parse(testJob.match(/^        os: (.+)$/m)?.[1]),
    ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.deepEqual(JSON.parse(job.match(/^        include: (.+)$/m)?.[1]), [
    {os: 'windows-latest', label: 'Windows x64', slug: 'windows', arch: 'x64'},
    {os: 'windows-11-arm', label: 'Windows ARM64', slug: 'windows', arch: 'arm64'},
    {os: 'macos-latest', label: 'macOS ARM64', slug: 'macos', arch: 'arm64'},
    {os: 'macos-15-intel', label: 'macOS Intel', slug: 'macos', arch: 'x64'},
  ]);
  excludes(job, ["runner.os == 'Linux'", '--tool-smoke', "& './libav-smoke.ps1'",
    'BILIKARA_REQUIRE_BACKEND_SMOKE', 'strip_build_only_validation_payload']);
  excludes(bundle, ['windows_libav_preview', 'BILIKARA_WINDOWS_LIBAV_PREVIEW', 'Upload native libav diagnostics']);
  const steps = job.split(/\n      - /).slice(1);
  const position = text => {
    const matches = steps.map((body, index) => body.includes(text) ? index : -1).filter(index => index >= 0);
    assert.equal(matches.length, 1, `one actual caller: ${text}`); return matches[0];
  };
  for (const [before, after] of [
    ['./scripts/setup_msvc.ps1', 'bash media-libav/build-windows.sh'],
    ['bash media-libav/build-windows.sh', './media-libav/prepare-windows.ps1'],
    ['./media-libav/prepare-windows.ps1', '-- build-backend'],
    ['bash media-libav/build-posix.sh', '-- build-backend'],
    ['-- build-backend', 'tauri build --no-bundle'], ['-- build-backend', 'tauri build --bundles app'],
    ['tauri build --no-bundle', '-- assemble-desktop'], ['tauri build --bundles app', '-- assemble-desktop'],
    ['-- assemble-desktop', 'Compress-Archive -Path dist/bilikara'],
    ['-- assemble-desktop', 'ditto dist/bilikara-desktop.app dist_release/bilikara-desktop.app'],
    ['ditto dist/bilikara-desktop.app dist_release/bilikara-desktop.app', 'ditto -c -k --sequesterRsrc'],
    ['Compress-Archive -Path dist/bilikara', 'Expand-Archive -Path $env:BUNDLE_ARCHIVE'],
    ['Expand-Archive -Path $env:BUNDLE_ARCHIVE', "uses: actions/upload-artifact@v7"],
  ]) assert.ok(position(before) < position(after), `${before} before ${after}`);
  includes(job, ['BILIKARA_REQUIRE_TAURI_SMOKE=1', 'node --test tests/macos_tauri_smoke.test.mjs']);
  assert.equal(bundle.split("if: startsWith(github.ref, 'refs/tags/v')").length - 1, 3);
  includes(bundle, ['needs: [bundle, android-bundle]', 'Upload signed APK to GitHub Release']);
});

test('tool recipe/manual publication keep exact source and immutable transport rules with native metadata', () => {
  const trigger = tools.split('\non:\n')[1].split('\npermissions:\n')[0];
  includes(trigger, ['workflow_dispatch:']); excludes(trigger, ['push:', 'pull_request:', 'schedule:']);
  includes(tools, ['contents: read', 'R2_ACCESS_KEY_ID', "--if-none-match '*'", 'publication_status="reused"']);
  excludes(recipe, ['GITHUB_SHA', 'python']);
  includes(recipe, ['BUILD_RECIPE_REVISION="portable-macos-appletls-v2"', '${archive_sha256}.tar.gz', 'ARIA2_SOURCE_SHA256', '/usr/bin/otool -L', '/opt/homebrew/', '/usr/local/Cellar/', 'node "$script_dir/tool_asset_metadata.mjs" write']);
  includes(read('scripts/tool_asset_metadata.mjs'), ['schema_version: 2']);
  assert.ok(tools.indexOf('uses: actions/setup-node') < tools.indexOf('./scripts/build_portable_macos_aria2.sh'));
  excludes(tools, ['python -c']);
  includes(tools, ['python -m pip install --upgrade awscli']); // Third-party publication client only.
});

test('actual immutable publication script is exercised offline for reuse/upload/race/corruption/failure', {skip: process.platform === 'win32'}, async () => {
  assert.ok(bash);
  const stub = `aws() {
  printf '%s\\0' "$@" >> "$RUNNER_TEMP/aws-arguments"
  local key="" destination="" previous=""
  for value in "$@"; do
    if [ "$previous" = --key ]; then key="$value"; fi
    previous="$value"; destination="$value"
  done
  if [ "$2" = head-object ]; then
    if [ "$SCENARIO" = reused ] || [ "$SCENARIO" = corrupt ]; then return 0; fi
    if [ "$SCENARIO" = race ]; then
      if [ -f "$RUNNER_TEMP/head-record" ]; then return 0; fi
      touch "$RUNNER_TEMP/head-record"; return 1
    fi
    return 1
  elif [ "$2" = put-object ]; then
    if [ "$SCENARIO" = race ] || [ "$SCENARIO" = failed ]; then return 42; fi
    if [ "$SCENARIO" = metadata-failed ] && [ "$key" = metadata-key ]; then return 43; fi
    return 0
  elif [ "$2" = get-object ]; then
    # The destination precedes --endpoint-url in the real argument vector.
    local index=1
    for value in "$@"; do
      if [ "$value" = --endpoint-url ]; then break; fi
      destination="$value"; index=$((index + 1))
    done
    if [ "$SCENARIO" = corrupt ]; then printf corrupt > "$destination"
    elif [ "$key" = metadata-key ]; then cp "$RUNNER_TEMP/bilikara-portable-aria2/aria2-macos-arm64.json" "$destination"
    else cp "$RUNNER_TEMP/bilikara-portable-aria2/archive.tar.gz" "$destination"; fi
    return 0
  fi
  return 99
}\n`;
  for (const [scenario, expected] of [['reused', 0], ['uploaded', 0], ['race', 0], ['failed', 42], ['corrupt', 1], ['metadata-failed', 43]]) {
    const directory = ownedDirectory('offline tool publication');
    try {
      const output = path.join(directory, 'bilikara-portable-aria2'); mkdirSync(output);
      const archive = Buffer.from('independent archive bytes'); writeFileSync(path.join(output, 'archive.tar.gz'), archive);
      const sha = createHash('sha256').update(archive).digest('hex');
      writeFileSync(path.join(output, 'aria2-macos-arm64.json'), serializeMetadata(archiveMetadata(['arm64', 'archive.tar.gz', 'https://example.test/archive.tar.gz', sha,
        '1.37.0', 'https://example.test/source', 'a'.repeat(64), 'portable-macos-appletls-v2', 'archive-key', 'metadata-key'])));
      const result = await runBash(stub + script(tools, 'Publish immutable content-addressed aria2c asset'), root,
        {...process.env, RUNNER_TEMP: directory, TARGET_ARCH: 'arm64', SCENARIO: scenario, R2_ACCOUNT_ID: 'offline', R2_BUCKET: 'offline'});
      assert.equal(result.status, expected, `${scenario}: ${result.stdout}${result.stderr}`);
      const calls = readFileSync(path.join(directory, 'aws-arguments'), 'utf8').split('\0');
      if (scenario === 'uploaded' || scenario === 'race') assert.ok(calls.includes('--if-none-match') && calls.includes('*'));
      if (expected) assert.ok(!result.stdout.includes('aria2c publication status:'), 'failure must not emit publication success');
      else includes(result.stdout, [`publication status: ${scenario === 'race' ? 'reused-after-race' : scenario}`]);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  }
});
