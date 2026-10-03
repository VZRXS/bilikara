import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci-bundle.yml', import.meta.url), 'utf8');
const bundle = workflow.slice(workflow.indexOf('\n  bundle:'), workflow.indexOf('\n  android-bundle:'));
const steps = bundle.split(/\n      - /).slice(1);
const index = pattern => {
  const found = steps.findIndex(step => pattern.test(step));
  assert.notEqual(found, -1, `missing required bundle step: ${pattern}`);
  return found;
};

test('actual BBDown producer uses locked host-native xtask and keeps vendor/env interfaces', () => {
  const prepare = index(/cargo run --manifest-path xtask\/Cargo\.toml --locked --target host-tuple -- prepare-bbdown "\$bbdown_dir"/);
  assert.match(steps[prepare], /bbdown_dir="\$RUNNER_TEMP\/bilikara-bbdown-vendor"/);
  assert.match(steps[prepare], /printf '%s\\n' "\$bbdown_dir\/bin" >> "\$GITHUB_PATH"/);
  assert.match(steps[prepare], /cat "\$bbdown_dir\/metadata.env" >> "\$GITHUB_ENV"/);
  assert.match(steps[prepare], /--platform '\$\{\{ matrix\.slug \}\}' --arch '\$\{\{ matrix\.arch \}\}'/);
  assert.doesNotMatch(steps[prepare], /\bpython(?:3)?\b|\bpy\b|pip|prepare_bbdown_vendor\.py/);
  assert.equal(existsSync(new URL('../scripts/prepare_bbdown_vendor.py', import.meta.url)), false);
  assert.equal(existsSync(new URL('../tests/test_prepare_bbdown_vendor.py', import.meta.url)), false);
});

test('toolchain repair, pinned setup, build cache and native linker precede every xtask producer', () => {
  const repair = index(/rustup toolchain uninstall 1\.97\.0/);
  const rust = index(/rustup toolchain install\s/);
  const cache = index(/uses: Swatinem\/rust-cache@v2/);
  const msvc = index(/run: \.\/scripts\/setup_msvc\.ps1 -Arch '\$\{\{ matrix\.arch \}\}'/);
  assert.match(steps[repair], /if: runner.os == 'macOS'/);
  assert.match(steps[msvc], /if: runner.os == 'Windows'/);
  assert.ok(repair < rust && rust < cache);
  const firstProducer = index(/cargo run --manifest-path xtask\/Cargo\.toml/);
  assert.ok(cache < firstProducer && msvc < firstProducer);
  assert.match(steps[firstProducer], /-- prepare-bbdown /);
  assert.doesNotMatch(steps[rust], /RUSTUP_TOOLCHAIN=|rustup default/);
});

test('native packaging gates and unrelated Python verification remain present', () => {
  for (const gate of ['-- build-backend', '-- assemble-desktop', '--target host-tuple -- verify-native-desktop',
    'Verify extracted Windows bundle', 'Archive and verify round-trip macOS bundle',
    'codesign --verify --deep --strict', 'plutil -lint', 'actions/setup-python@v6',
    'requirements-packaging.txt']) assert.ok(bundle.includes(gate), gate);
  assert.match(workflow, /npm run test:desktop-build/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['test:desktop-build'].includes('tests/bbdown_prepare_entry.test.mjs'));
});

test('prepared native BBDown discovery executes after PATH/env publication and before expensive libav preparation', () => {
  const prepare = index(/-- prepare-bbdown /);
  const discover = index(/cargo test --manifest-path xtask\/Cargo\.toml --locked --target host-tuple prepared_bbdown_is_discoverable_from_native_environment -- --ignored/);
  const libraries = index(/run: bash media-libav\/build-windows\.sh/);
  assert.ok(prepare < discover && discover < libraries);
  assert.match(steps[discover], /BILIKARA_TEST_BBDOWN_DIR: \$\{\{ runner\.temp \}\}\/bilikara-bbdown-vendor/);
  assert.match(steps[discover], /shell: bash/);
  assert.doesNotMatch(steps[discover], /continue-on-error|\|\| true|if:.*Windows/);
});
