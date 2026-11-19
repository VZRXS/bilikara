import {desktopWorkflow, desktopPackages} from './ci_workflow_support.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = desktopWorkflow;
const bundle = desktopPackages;
// YAML comments (such as the deprecated BBDown steps) are not executable step text.
const steps = bundle.split(/\n      - /).slice(1)
  .map(step => step.split('\n').filter(line => !line.trim().startsWith('#')).join('\n'));
const index = pattern => {
  const found = steps.findIndex(step => pattern.test(step));
  assert.notEqual(found, -1, `missing required bundle step: ${pattern}`);
  return found;
};

// DEPRECATED (v0.9): BBDown is no longer packaged, so the bundle job no longer
// runs the BBDown producer. The former producer contract is kept as a comment;
// the xtask tool itself remains for reference/manual preparation.
// test('actual BBDown producer uses locked host-native xtask and keeps vendor/env interfaces', () => {
//   const prepare = index(/cargo run --manifest-path xtask\/Cargo\.toml --locked --target host-tuple -- prepare-bbdown "\$bbdown_dir"/);
//   assert.match(steps[prepare], /bbdown_dir="\$RUNNER_TEMP\/bilikara-bbdown-vendor"/);
//   assert.match(steps[prepare], /printf '%s\\n' "\$bbdown_dir\/bin" >> "\$GITHUB_PATH"/);
//   assert.match(steps[prepare], /cat "\$bbdown_dir\/metadata.env" >> "\$GITHUB_ENV"/);
//   assert.match(steps[prepare], /--platform '\$\{\{ inputs\.slug \}\}' --arch '\$\{\{ inputs\.arch \}\}'/);
//   assert.doesNotMatch(steps[prepare], /\bpython(?:3)?\b|\bpy\b|pip|prepare_bbdown_vendor\.py/);
//   assert.equal(existsSync(new URL('../scripts/prepare_bbdown_vendor.py', import.meta.url)), false);
//   assert.equal(existsSync(new URL('../tests/test_prepare_bbdown_vendor.py', import.meta.url)), false);
// });

test('deprecated BBDown producer is not an active bundle step while the xtask tool remains', () => {
  assert.equal(steps.findIndex(step => /-- prepare-bbdown /.test(step)), -1);
  assert.equal(steps.findIndex(step => /prepared_bbdown_is_discoverable_from_native_environment/.test(step)), -1);
  const xtask = readFileSync(new URL('../xtask/src/main.rs', import.meta.url), 'utf8');
  assert.match(xtask, /action == "prepare-bbdown"/);
  assert.equal(existsSync(new URL('../scripts/prepare_bbdown_vendor.py', import.meta.url)), false);
  assert.equal(existsSync(new URL('../tests/test_prepare_bbdown_vendor.py', import.meta.url)), false);
});

test('isolated pinned toolchain, build cache and native linker precede every xtask producer', () => {
  const rust = index(/uses: \.\/\.github\/actions\/rust-toolchain/);
  const toolchain = readFileSync(new URL('../.github/actions/rust-toolchain/action.yml', import.meta.url), 'utf8');
  const home = toolchain.indexOf('RUSTUP_HOME=%s/bilikara-ci-rustup');
  assert.ok(home >= 0 && home < toolchain.indexOf('rustup toolchain install'));
  assert.match(toolchain, /"\$RUNNER_TEMP" >> "\$GITHUB_ENV"/);
  assert.doesNotMatch(toolchain, /toolchain uninstall|RUSTUP_TOOLCHAIN=|rustup default/);
  const cache = index(/uses: Swatinem\/rust-cache@v2/);
  const msvc = index(/run: \.\/scripts\/setup_msvc\.ps1 -Arch '\$\{\{ inputs\.arch \}\}'/);
  assert.match(steps[msvc], /if: runner.os == 'Windows'/);
  assert.ok(rust < cache);
  const firstProducer = index(/cargo run --manifest-path xtask\/Cargo\.toml/);
  assert.ok(cache < firstProducer && msvc < firstProducer);
  // DEPRECATED (v0.9): the first producer is no longer prepare-bbdown.
  // assert.match(steps[firstProducer], /-- prepare-bbdown /);
  assert.doesNotMatch(steps[rust], /RUSTUP_TOOLCHAIN=|rustup default/);
});

test('native packaging gates and unrelated Python verification remain present', () => {
  for (const gate of ['-- build-backend', '-- assemble-desktop', '--target host-tuple -- verify-native-desktop',
    'Verify extracted Windows bundle', 'Archive and verify round-trip macOS bundle',
    'codesign --verify --deep --strict', 'plutil -lint']) assert.ok(bundle.includes(gate), gate);
  assert.doesNotMatch(bundle, /setup-python|pip install/);
  for (const required of ['actions/setup-python@v6', 'requirements-packaging.txt', 'python -m unittest discover -s tests -v']) assert.ok(workflow.includes(required), required);
  assert.match(workflow, /node scripts\/ci_tests\.mjs tooling/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['test:desktop-build'].includes('tests/bbdown_prepare_entry.test.mjs'));
});

// DEPRECATED (v0.9): BBDown discovery is no longer a bundle step.
// test('prepared native BBDown discovery executes after PATH/env publication and before expensive libav preparation', () => {
//   const prepare = index(/-- prepare-bbdown /);
//   const discover = index(/cargo test --manifest-path xtask\/Cargo\.toml --locked --target host-tuple prepared_bbdown_is_discoverable_from_native_environment -- --ignored/);
//   const libraries = index(/run: bash media-libav\/build-windows\.sh/);
//   assert.ok(prepare < discover && discover < libraries);
//   assert.match(steps[discover], /BILIKARA_TEST_BBDOWN_DIR: \$\{\{ runner\.temp \}\}\/bilikara-bbdown-vendor/);
//   assert.match(steps[discover], /shell: bash/);
//   assert.doesNotMatch(steps[discover], /continue-on-error|\|\| true|if:.*Windows/);
// });
