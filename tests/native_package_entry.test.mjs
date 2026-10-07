import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(new URL('../.github/workflows/ci-bundle.yml', import.meta.url), 'utf8');
const bundle = workflow.slice(workflow.indexOf('\n  bundle:'), workflow.indexOf('\n  android-bundle:'));
const steps = bundle.split(/\n      - /).slice(1);
const verify = 'cargo run --manifest-path xtask/Cargo.toml --locked --target host-tuple -- verify-native-desktop';
const installed = 'cargo test --manifest-path xtask/Cargo.toml --locked --target host-tuple native_package::installed:: -- --ignored --nocapture';

test('both native gates verify the extracted artifact and then run actual installed regressions', () => {
  const gates = steps.filter(step => step.includes(verify));
  assert.equal(gates.length, 2);
  const windows = gates.find(step => step.includes("if: runner.os == 'Windows'"));
  const macos = gates.find(step => step.includes("if: runner.os == 'macOS'"));
  assert.match(windows, /\$backend = Join-Path \$env:RUNNER_TEMP 'Bilikara preview 空\/bilikara\/_internal\/bilikara-desktop-host.exe'/);
  assert.ok(windows.includes(`${verify} "$backend"`));
  assert.match(windows, /\$env:BILIKARA_TEST_NATIVE_PACKAGE = \$backend/);
  assert.equal((windows.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 2);
  assert.match(macos, /backend="\$GITHUB_WORKSPACE\/test_extract\/dist_release\/bilikara-desktop.app\/Contents\/Frameworks\/bilikara-backend.app\/Contents\/MacOS\/bilikara-desktop-host"/);
  assert.ok(macos.includes(`${verify} "$backend"`));
  assert.ok(macos.includes(`BILIKARA_TEST_NATIVE_PACKAGE="$backend" ${installed}`));
  for (const gate of gates) {
    assert.ok(gate.includes(installed));
    assert.ok(gate.indexOf(verify) < gate.indexOf(installed));
    assert.doesNotMatch(gate, /\bpython(?:3)?\b|-- build-|-- assemble-|-- prepare-/);
  }
  const extraction = steps.findIndex(step => step.includes('Expand-Archive -Path $env:BUNDLE_ARCHIVE'));
  const roundTrip = steps.findIndex(step => step.includes('ditto -x -k "$BUNDLE_ARCHIVE" test_extract/'));
  assert.ok(extraction >= 0 && extraction < steps.indexOf(windows));
  assert.ok(roundTrip >= 0 && roundTrip < steps.indexOf(macos));
  const rust = steps.findIndex(step => step.includes('rustup toolchain install'));
  const msvc = steps.findIndex(step => step.includes('./scripts/setup_msvc.ps1'));
  assert.ok(rust >= 0 && rust < steps.indexOf(windows) && rust < steps.indexOf(macos));
  assert.ok(msvc >= 0 && msvc < steps.indexOf(windows));
  assert.ok(bundle.includes("BILIKARA_EXPECT_RELEASE_VERSION: ${{ github.ref_type == 'tag' && github.ref_name || inputs.bundle_version || '' }}"));
  for (const required of ['codesign --verify --deep --strict', 'lipo -archs', 'plutil -lint', 'cmp README-macOS.txt']) assert.ok(bundle.includes(required), required);
  assert.doesNotMatch(bundle, /setup-python|pip install/);
  for (const required of ['actions/setup-python@v6', 'requirements-packaging.txt', 'python -m unittest discover -s tests -v']) assert.ok(workflow.includes(required), required);
});

test('real host-native verifier entry rejects missing and excess inputs without constructing a package', () => {
  const temp = mkdtempSync(join(tmpdir(), 'missing-native 空 '));
  try {
    for (const args of [[], [join(temp, 'absent Host')], [join(temp, 'absent Host'), '--repair']]) {
      const result = spawnSync('cargo', ['run', '--manifest-path', 'xtask/Cargo.toml', '--locked', '--target', 'host-tuple', '--', 'verify-native-desktop', ...args],
        { cwd: root, encoding: 'utf8', timeout: 120_000, env: process.env });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '', 'failed verifier emitted success output');
      assert.match(result.stderr, /Desktop task failed:/);
      assert.equal(existsSync(join(temp, 'absent Host')), false);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('old package/business drivers are retired; independent Node transport does no package repair', () => {
  for (const file of ['scripts/check_native_desktop_bundle.py', 'scripts/check_no_media_cli_bundle.py', 'tests/test_native_desktop_bundle.py']) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false, file);
  }
  const helper = readFileSync(new URL('./native_host_support.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /(?:function|class) (?:check|inspectPackage|packageRoot|resources)\(/);
  assert.equal(existsSync(new URL('./native_host_support.py', import.meta.url)), false);
  for (const name of ['test_native_desktop_admin', 'test_native_desktop_sources', 'test_native_source_queue', 'test_native_desktop_startup', 'test_native_compatibility_migration', 'test_native_recheck_regressions']) {
    assert.equal(existsSync(new URL(`./${name}.py`, import.meta.url)), false, name);
  }
  assert.match(workflow, /npm run test:desktop-build/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['test:desktop-build'].includes('tests/native_package_entry.test.mjs'));
});

test('installed regressions are explicitly unavailable by default and fail when requested without an artifact', () => {
  const env = { ...process.env };
  delete env.BILIKARA_TEST_NATIVE_PACKAGE;
  const base = ['test', '--manifest-path', 'xtask/Cargo.toml', '--locked', '--target', 'host-tuple', 'native_package::installed::installed_release_bootstrap_resources_sse_and_reopen', '--'];
  const omitted = spawnSync('cargo', [...base, '--nocapture'], { cwd: root, encoding: 'utf8', timeout: 120_000, env });
  assert.ifError(omitted.error);
  assert.equal(omitted.status, 0);
  assert.match(omitted.stdout, /0 passed; 0 failed; 1 ignored/);
  assert.match(omitted.stdout, /requires an actual release Host/);
  const requested = spawnSync('cargo', [...base, '--ignored', '--nocapture'], { cwd: root, encoding: 'utf8', timeout: 120_000, env });
  assert.ifError(requested.error);
  assert.notEqual(requested.status, 0);
  assert.match(requested.stderr, /Installed-package regression requires BILIKARA_TEST_NATIVE_PACKAGE/);
});
