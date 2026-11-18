import {readCiPlatformMatrix} from '../scripts/ci_scope.mjs';
import {desktopWorkflow, mobileWorkflow, desktopChecks, mobileChecks, desktopPackages, mobilePackages} from './ci_workflow_support.mjs';
import { readSourceText } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import {selectTargets} from '../scripts/ci_targets.mjs';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, runNative, executableOnPath } from './desktop_construction_support.mjs';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { archiveMetadata, serializeMetadata } from '../scripts/tool_asset_metadata.mjs';

const read = file => readSourceText(path.join(root, file));
const pipeline = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml'), manual = read('.github/workflows/bundle.yml');
const bundle = desktopWorkflow, tools = read('.github/workflows/tool-assets.yml');
const android = mobileWorkflow;
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
  const testJob = desktopChecks;
  const bundleJob = desktopPackages;
  const namespace = job => job.split('shared-key:')[1].split('\n')[0].trim();
  assert.notEqual(namespace(testJob), namespace(bundleJob));
  includes(testJob, ['CARGO_PROFILE_DEV_DEBUG: line-tables-only']); excludes(bundle, ['CARGO_PROFILE_RELEASE_']);
  includes(bundleJob, ['native-target: \'true\'',
    'tauri build --no-bundle --target "$CARGO_BUILD_TARGET" -- --locked',
    'tauri build --bundles app --target "$CARGO_BUILD_TARGET" -- --locked']);
  includes(step(bundleJob, 'Build Tauri App on Windows'), ['shell: bash', 'set -euo pipefail']);
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
    const result = await runBash(stub + script(bundle, 'Rust Checks and Build'), directory,
      {...process.env, RUNNER_OS: 'Linux', CI_SCOPE: 'full'});
    assert.equal(result.status, 42, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(path.join(directory, 'calls.log'), 'utf8').trimEnd().split('\n'), ['rust:fmt --check', 'rust:clippy --all-targets --locked -- -D warnings']);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('actual naming script preserves all branch/tag/architecture archive and upload identities', async () => {
  assert.ok(bash); const block = step(bundle, 'Resolve bundle archive name');
  includes(block, ['BUNDLE_SLUG: ${{ inputs.slug }}', 'BUNDLE_ARCH: ${{ inputs.arch }}']);
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
          GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567', GITHUB_REF_TYPE: type, GITHUB_REF_NAME: ref, BUNDLE_SLUG: slug, BUNDLE_ARCH: arch, GITHUB_OUTPUT: portable(output), GITHUB_ENV: portable(envFile)});
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const name = 'bilikara-' + suffix + (type === 'branch' ? '-0123456789ab' : '');
        assert.equal(readFileSync(output, 'utf8'), `archive_name=${name}.zip\nartifact_name=${name}\n`);
        assert.equal(readFileSync(envFile, 'utf8'), `BUNDLE_ARCHIVE=${name}.zip\n`);
      } finally { rmSync(directory, {recursive: true, force: true}); }
    }
  }
});

test('ordinary bundle keeps tool pins/preparation/signature/package gates without publication credentials', () => {
  excludes(bundle, ['macos-aria2-tools', 'build_portable_macos_aria2.sh', 'build_portable_macos_ffmpeg.sh', 'Publish immutable aria2c', 'Publish immutable FFmpeg', 'choco install ffmpeg']);
  const job = desktopPackages;
  excludes(job, ['needs: test']);
  includes(job, ["if: matrix.kind == 'desktop'", 'BILIKARA_REQUIRE_TAURI_SMOKE=1', 'node --test tests/macos_tauri_smoke.test.mjs']);
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
  const job = desktopPackages;
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
  const testJob = desktopChecks;
  const job = desktopPackages;
  assert.deepEqual(readCiPlatformMatrix(ci).include.filter(row => row.kind === 'desktop').map(row => row.os),
    ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.deepEqual(selectTargets('all').desktop.include, [
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
  assert.ok((bundle + android + pipeline).includes("if: startsWith(github.ref, 'refs/tags/v')"));
  includes(pipeline, ['needs: [checks, packages]', 'uses: ./.github/workflows/bundle.yml']);
  excludes(android, ['action-gh-release', 'Upload signed APK to GitHub Release']);
  excludes(bundle, ['action-gh-release', 'Upload bundle to GitHub Release']);
  includes(pipeline, ['collectRelease', 'prepareDraft', 'publishDraft', 'skip-decompress: true', 'digest-mismatch: error']);
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


test('one CI entry tests only; manual Bundle uses selected matrices without full tests', () => {
  const trigger = ci.split('\non:\n')[1].split('\npermissions:\n')[0];
  includes(trigger, ['pull_request:', 'workflow_dispatch:', 'feature/ios']);
  excludes(trigger, ['paths-ignore:', 'tags:']);
  for (const group of ['desktop', 'mobile']) {
    const checks = group === 'desktop' ? desktopChecks : mobileChecks;
    const packages = group === 'desktop' ? desktopPackages : mobilePackages;
    includes(checks, ["needs.preflight.outputs.scope == 'full'", `uses: ./.github/actions/${group}-checks`]);
    includes(packages, ['needs: plan', 'fromJSON(needs.plan.outputs.matrix)']);
    excludes(packages, ['needs: checks', 'needs: test', 'workflows/ci.yml']);
  }
  excludes(ci, ['secrets.', 'mode: bundle', 'tauri build']);
  includes(ci, ["if: failure()", 'fast-playback-linux', 'retention-days: 3']);
  includes(manual, ['default: All', 'ci_targets.mjs', 'ios_adhoc:']);
  const checks = mobileChecks;
  const packages = mobilePackages;
  excludes(checks, ['secrets.', 'Resolve APK and prepare signing', 'Build APK']);
  includes(checks, ['platform: ${{ matrix.label }}', 'runs-on: ${{ matrix.os }}',
    'cargo test --manifest-path rust-runtime/Cargo.toml --features native-host --locked',
    'BILIKARA_REQUIRE_ANDROID_SIGNING_TESTS=1']);
  assert.ok(readCiPlatformMatrix(ci).include.some(row => row.label === 'iOS' && row.os === 'xcode-27'));  includes(checks, ['npm run test:ios-bootstrap', 'npm run test:ios-build']);
  excludes(checks, ['npm run test:frontend', 'cargo test --manifest-path rust/Cargo.toml']);
  includes(bundle, ['node scripts/ci_tests.mjs shared']);
  includes(read('scripts/ci_targets.mjs'), ["platform: 'Android'", "rust_target: 'aarch64-linux-android'", "tauri_target: 'aarch64'"]);
  includes(packages, [
    'apksigner', 'zipalign', "format('android-apk-arm64-api36-ndk27.0.12077973-{0}-v1'", "&& 'release' || 'debug'"]);
  // The action ignores `key` alongside shared-key; pin identity in the actual
  // prefix used for both exact hits and partial restores.
  includes(checks, ["format('ios-check-aarch64-apple-ios-{0}-v1'", 'steps.ios-environment.outputs.sdk-key', './src-tauri -> target', './xtask -> target']);
  includes(packages, ["format('ios-app-{0}-{1}-debug-v1'", "format('ios-adhoc-aarch64-apple-ios-{0}-release-v1'"]);
  for (const cache of android.split(/^      - name:/m).filter(block => block.includes('uses: Swatinem/rust-cache@v2'))) {
    excludes(cache, ['\n          key:']);
  }
  includes(step(bundle, 'Prepare Linux runner SDK space'), ["if: runner.os == 'Linux'", 'ci_sdk_space.mjs desktop']);
  includes(step(checks, 'Prepare Android runner SDK space'), ["if: inputs.platform == 'Android'", 'ci_sdk_space.mjs android']);
  includes(step(packages, 'Prepare Android runner SDK space'), ["if: inputs.platform == 'Android'", 'ci_sdk_space.mjs android']);
  includes(step(packages, 'Cache Rust builds'), ['CARGO_PROFILE_DEV_DEBUG: line-tables-only']);
  includes(step(packages, 'Build APK'), ['CARGO_PROFILE_DEV_DEBUG: line-tables-only', 'df -h "$GITHUB_WORKSPACE"']);
  excludes(packages, ['cargo test --manifest-path', 'npm run test:frontend']);
  assert.ok(packages.indexOf('npm ci') < packages.indexOf('npm exec -- tauri android build'));
  const toolchain = read('.github/actions/rust-toolchain/action.yml');
  includes(toolchain, ['RUSTUP_HOME=%s/bilikara-ci-rustup', '"$RUNNER_TEMP"', 'rustup toolchain install', 'rustup toolchain list']);
  excludes(toolchain, ['toolchain uninstall', 'rustup default', 'RUSTUP_TOOLCHAIN=']);
  assert.equal(bundle.split('uses: ./.github/actions/rust-toolchain').length - 1, 2);
  assert.equal(android.split('uses: ./.github/actions/rust-toolchain').length - 1, 3);
  excludes(desktopPackages, ['needs: test']);
});

test('iOS mobile lane builds the device IPA without entering Android signing or release steps', () => {
  const checks = mobileChecks;
  const packages = mobilePackages;
  assert.equal(selectTargets('ios').mobile.include[0].rust_target, 'aarch64-apple-ios');
  assert.equal(selectTargets('ios').mobile.include[0].artifact_kind, 'device-arm64-unsigned');
  includes(packages, ['npm run ios:init -- --skip-targets-install']);
  excludes(packages, ['aarch64-apple-ios-sim', 'aarch64-sim', 'arm64-sim', 'simulator-arm64', 'IOSSIMULATOR']);
  const build = step(packages, 'Build iOS without signing credentials');
  includes(build, ["if: inputs.platform == 'iOS'", '--no-sign --ci', 'node scripts/ios.mjs build']);
  excludes(build, ['secrets.', 'APPLE_CERTIFICATE', 'APPLE_DEVELOPMENT_TEAM', 'ANDROID_']);
  for (const name of ['Setup Java', 'Setup Android SDK', 'Resolve Android libav C cache',
    'Restore Android libav C cache', 'Build actual Android media output', 'Verify actual Android media libraries and cache', 'Validate Android signing contract',
    'Use runner CPU count for Cargo', 'Install Android Rust target', 'Compile Android Runtime feature groups and shell with clippy']) {
    includes(step(checks, name), ["if: inputs.platform == 'Android'"]);
  }
  for (const name of ['Setup Java', 'Setup Android SDK', 'Prepare native YouTube binding generator',
    'Install pinned Android tools', 'Cache Rust builds', 'Resolve Android libav C cache', 'Restore Android libav C cache',
    'Cache Gradle dependencies', 'Build and verify Android media before signing', 'Resolve APK and prepare signing', 'Build APK',
    'Compile Android playback service tests', 'Stage and verify APK', 'Upload APK test artifact',
    'Upload corresponding Android libav source kit', 'Remove temporary signing file']) {
    includes(step(packages, name), ["inputs.platform == 'Android'"]);
  }
  const stage = step(packages, 'Stage iOS test artifact');
  includes(stage, ['plutil -lint', 'CFBundleIdentifier', 'NSAllowsArbitraryLoads', 'embedded.mobileprovision',
    'CFBundleShortVersionString', 'ios_release_version="${GITHUB_REF_NAME#v}"',
    'lipo -archs', 'vtool -show-build', 'ios_expected_platform=IOS',
    'ditto -x -k', 'cp "$ios_ipa"', 'SHA256SUMS', 'GITHUB_SHA']);
  const upload = step(packages, 'Upload iOS test artifact');
  includes(upload, ["if: inputs.platform == 'iOS'", 'actions/upload-artifact@v7', 'if-no-files-found: error']);
  excludes(upload, ['action-gh-release', 'secrets.']);
  const apple = read('.github/actions/ios-toolchain/action.yml');
  includes(apple, ['Xcode_27.1.app', 'xcodegen.zip', '/2.46.0/', 'shasum -a 256 --check',
    '4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806', '--max-filesize',
    'libclang.dylib', 'GITHUB_PATH', 'sdk-key=']);
  excludes(apple, ['brew install', 'releases/latest', 'APPLE_DEVELOPMENT_TEAM', 'secrets.']);
  excludes(apple, ['XCODE_XCCONFIG_FILE']);
  includes(read('scripts/ios-branding.mjs'), ['ASSETCATALOG_OTHER_FLAGS', '--standalone-icon-behavior all', "run('xcodegen'", "include: ['project.yml']"]);
  includes(read('scripts/ios-branding.mjs'), ['for (const scale of [2, 3])', 'regular(input)', "'ios_packaged_icon_mismatch'", "'Assets.car'"]);
});

// Ported from R2 A7 (bilikara 98329496, fa199fc2) onto next's composite actions.
test('Android media checker, APK gates and separate source kit run before signature inspection', () => {
  const kitName = 'sources/bilikara-android-libav-9.0.1-arm64-v8a-source-kit.zip';
  const readelf = 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf';
  const checks = mobileChecks, packages = mobilePackages;
  // Checks: real media output feeds the real-library cases (skipped otherwise) and the six-library checker.
  const build = step(checks, 'Build actual Android media output');
  includes(build, ['android-libav --ndk "$BILIKARA_TEST_ANDROID_NDK" --abi arm64-v8a --out "$RUNNER_TEMP/android-media-output"',
    '--cache "$BILIKARA_TEST_ANDROID_LIBAV_CACHE"', '--target host-tuple']);
  excludes(build, ['--cache-key', 'cache-hit']); // Companion always rebuilt, including C cache hits.
  const verify = step(checks, 'Verify actual Android media libraries and cache');
  includes(verify, ['BILIKARA_TEST_ANDROID_LIBAV_DIR: ${{ runner.temp }}/android-media-output/jniLibs/arm64-v8a',
    'export NDK_HOME="$BILIKARA_TEST_ANDROID_NDK"', 'npm run test:android-libav',
    'node scripts/android_media_check.mjs --media-output "$RUNNER_TEMP/android-media-output"', readelf,
    `--source-kit "$RUNNER_TEMP/android-media-output/${kitName}"`]);
  assert.ok(verify.indexOf('npm run test:android-libav') < verify.indexOf('android_media_check.mjs'));
  for (const name of ['Resolve Android libav C cache', 'Restore Android libav C cache', 'Build actual Android media output']) {
    assert.ok(checks.indexOf(`- name: ${name}`) < checks.indexOf('- name: Verify actual Android media libraries and cache'), name);
  }
  // test:android-libav includes the A4 sample pins and the A7 checker cases.
  const scripts = JSON.parse(read('package.json')).scripts;
  includes(scripts['test:android-libav'], ['tests/android_libav.test.mjs', 'tests/android_cast_samples.test.mjs']);
  includes(read('tests/android_libav.test.mjs'), ["import './android_media_check.test.mjs';", "import './android_libav_contract.test.mjs';"]);
  // Bundle: media is checked before signing preparation; the packaged APK before apksigner.
  const media = step(packages, 'Build and verify Android media before signing');
  includes(media, ['media="$GITHUB_WORKSPACE/src-tauri/gen/android/app/build/generated/bilikara-media/arm64-v8a"',
    '--out "$media" --cache "$BILIKARA_ANDROID_LIBAV_CACHE"', 'node scripts/android_media_check.mjs --media-output "$media"',
    `--source-kit "$media/${kitName}"`, readelf]);
  for (const name of ['Resolve Android libav C cache', 'Restore Android libav C cache', 'Build and verify Android media before signing']) {
    assert.ok(packages.indexOf(`- name: ${name}`) < packages.indexOf('- name: Resolve APK and prepare signing'), name);
  }
  const stage = step(packages, 'Stage and verify APK');
  includes(stage, [`kit="$GITHUB_WORKSPACE/src-tauri/gen/android/app/build/generated/bilikara-media/arm64-v8a/${kitName}"`,
    'node scripts/android_media_check.mjs --apk "$apk"', '--source-kit "$kit"',
    'verify-android-apk --ndk "$ANDROID_HOME/ndk/27.0.12077973" --abi "arm64-v8a" --apk "$apk" --source-kit "$kit"',
    'BILIKARA_TEST_ANDROID_APK="$apk"', 'BILIKARA_TEST_ANDROID_SOURCE_KIT="$kit"', 'npm run test:android-apk']);
  excludes(stage, ['bilikara.includeCastSamples=false', '--gradle-property']); // CI APKs require the default A4 sample.
  for (const gate of ['android_media_check.mjs --apk', 'verify-android-apk', 'npm run test:android-apk']) {
    assert.ok(stage.indexOf(gate) < stage.indexOf('apksigner'), gate);
  }
  assert.equal(packages.split('verify-android-apk').length - 1, 1, 'one APK verifier call, always with --source-kit');
  // Uploaded after the APK-bound checks, beside the APK, without a bilikara-* artifact name.
  const upload = step(packages, 'Upload corresponding Android libav source kit');
  includes(upload, ['uses: actions/upload-artifact@v7', 'name: android-libav-source-kit-arm64-v8a-${{ github.sha }}',
    `path: src-tauri/gen/android/app/build/generated/bilikara-media/arm64-v8a/${kitName}`, 'if-no-files-found: error']);
  excludes(upload, ['archive: false', 'name: bilikara-']);
  assert.ok(packages.indexOf('- name: Stage and verify APK') < packages.indexOf('- name: Upload corresponding Android libav source kit'));
  includes(stage, ['Sample B is required: CI never passes the Gradle sample opt-out', 'source_kit_sha256; distribute it alongside the APK']);
  // Release collection counts bilikara-* artifacts; the kit must stay outside that set.
  includes(read('scripts/ci_release.mjs'), ["row.name?.startsWith('bilikara-')", 'All six and only six package artifacts are required']);
});

// Ported from R2 A7 (bilikara 98329496, fa199fc2): PR-level CI compiles Android cfg code.
test('Android Checks cross-clippy both Runtime feature groups and the shell with the pinned NDK', () => {
  const checks = mobileChecks;
  const install = step(checks, 'Install pinned Android signing and media tools');
  includes(install, ['sudo apt-get install -y make gnupg gpgv libclang-dev', 'NDK_HOME=$ANDROID_HOME/ndk/27.0.12077973',
    'CC_aarch64_linux_android=$ndk/bin/aarch64-linux-android24-clang', 'CXX_aarch64_linux_android=', 'AR_aarch64_linux_android=$ndk/bin/llvm-ar',
    'CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$ndk/bin/aarch64-linux-android24-clang',
    'BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android=--target=aarch64-linux-android24 --sysroot=$ndk/sysroot -resource-dir=$ndk/lib/clang/18']);
  includes(step(checks, 'Install Android Rust target'), ['rustup target add aarch64-linux-android']);
  const clippy = step(checks, 'Compile Android Runtime feature groups and shell with clippy');
  includes(clippy, ["if: inputs.platform == 'Android'", 'set -euo pipefail',
    'cargo clippy --manifest-path rust-runtime/Cargo.toml --target aarch64-linux-android --lib --locked -- -D warnings',
    'cargo clippy --manifest-path rust-runtime/Cargo.toml --target aarch64-linux-android --lib --features native-host --locked -- -D warnings',
    'cargo clippy --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android --lib --locked -- -D warnings']);
  for (const name of ['Install pinned Android signing and media tools', 'Setup repository Rust toolchain', 'Install Android Rust target']) {
    assert.ok(checks.indexOf(`- name: ${name}`) < checks.indexOf('- name: Compile Android Runtime feature groups and shell with clippy'), name);
  }
  includes(step(checks, 'Use runner CPU count for Cargo'), ["if: inputs.platform == 'Android'", 'CARGO_BUILD_JOBS=$(nproc)', '>> "$GITHUB_ENV"']);
  assert.ok(checks.indexOf('- name: Use runner CPU count for Cargo') < checks.indexOf('- name: Setup repository Rust toolchain'));
  excludes(mobileWorkflow, ['CARGO_BUILD_JOBS: "8"']);
});

test('Linux desktop Checks run every R1 cast session/self-test real-companion case', () => {
  const linux = step(desktopChecks, 'Verify real libav prerequisite contracts');
  includes(linux, ["if: runner.os == 'Linux'", 'npm run test:purek-output', 'test -f "$BILIKARA_TEST_CAST_COMPANION"',
    'cargo test --manifest-path rust-runtime/Cargo.toml --locked --target host-tuple --lib --features native-host --',
    'native_host::cast_session:: --ignored --test-threads=1 2>&1 | tee "$cast_log"',
    String.raw`grep -Eq '^test result: ok\. 35 passed; 0 failed; 0 ignored;' "$cast_log"`]);
  const companion = step(desktopChecks, 'Build libav prerequisite for packaged media tests');
  includes(companion, ['libav-companion --prefix "$BILIKARA_LIBAV_PREFIX" --out "$BILIKARA_LIBAV_PREFIX/bin" --test',
    'BILIKARA_TEST_CAST_COMPANION=$BILIKARA_LIBAV_PREFIX/bin/libbilikara_media_libav_test.so" >> "$GITHUB_ENV"']);
  assert.ok(desktopChecks.indexOf('- name: Build libav prerequisite') < desktopChecks.indexOf('- name: Verify real libav prerequisite contracts'));
  // The exact CI count equals the ignored cases in the selected module tree.
  let count = 0;
  const walk = directory => {
    for (const entry of readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.rs')) count += (read(file).match(/^\s*#\[ignore\b/gm) ?? []).length;
    }
  };
  walk('rust-runtime/src/native_host/cast_session');
  assert.equal(count, 35, 'update the CI exact count together with the ignored cast_session cases');
});

test('lightweight performance summaries preserve artifact downloads and avoid a separate summary job', () => {
  for (const workflow of [ci, manual, pipeline, bundle, android]) excludes(workflow, ['\n  summary:', 'scripts/ci_summary.mjs', 'GITHUB_STEP_SUMMARY']);
  for (const workflow of [ci, bundle, android]) includes(workflow, ['uses: ./.github/actions/ci-diagnostics']);
  includes(read('scripts/ci_diagnostics.mjs'), ['listJobsForWorkflowRunAttempt', 'post-job steps', 'fresh artifacts reused']);
  includes(bundle, ['Log build caches', 'libav exact cache hit', 'Upload native bundle', 'retention-days: 7']);
  includes(android, ['Log Rust test cache', 'Log iOS build', 'Log Rust cache', 'add-job-summary: never', 'Upload APK test artifact', 'Upload iOS test artifact']);
});
