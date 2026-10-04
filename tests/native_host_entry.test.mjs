import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
import { csvRows } from './native_export_support.mjs';

test('independent CSV reader preserves BOM, Unicode, quoted separators/newlines and escaped quotes', () => {
  assert.deepEqual(csvRows(Buffer.from('\uFEFFid,title\r\n1,"开场, ""合唱""\n第二行"\r\n2,last\r\n')),
    [['id', 'title'], ['1', '开场, "合唱"\n第二行'], ['2', 'last']]);
  assert.deepEqual(csvRows(Buffer.from('a,"",\n')), [['a', '', '']]);
  assert.deepEqual(csvRows(Buffer.from('a,b,')), [['a', 'b', '']]);
  assert.deepEqual(csvRows(Buffer.alloc(0)), []);
  assert.throws(() => csvRows(Buffer.from('a,"unfinished')));
});

test('independent large CSV oracle runs within a bounded heap without per-character string allocation', async () => {
  const module = new URL('./native_export_support.mjs', import.meta.url).href;
  const fixture = `import assert from 'node:assert/strict';
import { csvRows } from ${JSON.stringify(module)};
const title = 'x'.repeat(4096), bytes = Buffer.from(('0,"' + title + '",end\\n').repeat(9000));
assert.ok(bytes.length > 32 * 1024 * 1024);
const rows = csvRows(bytes);
assert.equal(rows.length, 9000);
for (const row of rows) assert.deepEqual(row, ['0', title, 'end']);
console.log('9000 complete rows');`;
  const checked = await runNative(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', fixture], process.env, 20000);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(checked.stdout.trim(), '9000 complete rows');
});

test('declared missing Host fails; no ambient/stale/fixture fallback', async () => {
  const env = { ...process.env, BILIKARA_TEST_NATIVE_PACKAGE: path.join(root, '.tmp', 'missing Host 中文 $() &') }; delete env.NODE_TEST_CONTEXT;
  for (const entry of ['native_host_business', 'native_host_sources', 'native_host_recheck']) {
    const result = await runNative(process.execPath, ['--test', `tests/${entry}.test.mjs`], env);
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /declared native Host must exist/);
  }
});

test('native business CI runs once after real Linux prerequisite export and never uses Python transport', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8').replace(/\r\n/g, '\n'), checks = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  bundle:'));
  const command = 'npm run test:native-host'; assert.equal(checks.split('\n').filter(line => line.trim() === command).length, 1);
  assert.ok(checks.indexOf('BILIKARA_TEST_LIBAV_COMPANION=') < checks.indexOf(`\n          ${command}\n`));
  const block = checks.split(/\n      - /).find(step => step.includes(`\n          ${command}\n`)); assert.match(block, /set -euo pipefail/); assert.doesNotMatch(block, /python|if: runner.os/);
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:native-host'], 'node --test tests/native_host_business.test.mjs tests/native_host_sources.test.mjs tests/native_host_recheck.test.mjs');
  const artifacts = readFileSync(path.join(root, 'tests/native_runtime_artifacts.mjs'), 'utf8'); assert.ok(artifacts.includes("'--locked', '--target', 'host-tuple', '--message-format=json'")); assert.ok(artifacts.includes("record.reason === 'compiler-artifact'"));
  for (const entry of ['test:native-http', 'test:native-catalog', 'test:native-qr', 'test:native-images', 'test:native-login', 'test:remote-load']) {
    const invocation = `npm run ${entry}`;
    assert.equal(checks.split('\n').filter(line => line.trim() === invocation).length, 1);
    assert.ok(checks.indexOf('BILIKARA_TEST_LIBAV_COMPANION=') < checks.indexOf(`\n          ${invocation}\n`));
    assert.match(scripts[entry], /^node --test tests\/[a-z_]+\.test\.mjs$/);
  }
  const ratings = 'npm run test:native-ratings';
  assert.equal(checks.split('\n').filter(line => line.trim() === ratings).length, 1);
  assert.ok(checks.indexOf('BILIKARA_TEST_LIBAV_COMPANION=') < checks.indexOf(ratings));
  const browser = checks.split(/\n      - /).find(step => step.includes(ratings));
  assert.match(browser, /if: runner.os == 'Linux'/);
  assert.match(browser, /set -euo pipefail/);
  assert.ok(browser.indexOf('playwright install --with-deps chromium webkit') < browser.indexOf(ratings));
  assert.doesNotMatch(browser, /python|continue-on-error|\|\| true/);
  assert.equal(scripts['test:native-ratings'], 'node --test tests/native_ratings_browser.test.mjs');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.playwright, '1.55.1');
  const steps = checks.split(/\n      - /).slice(1);
  const install = steps.findIndex(step => /\brun: npm ci\s*$/.test(step));
  assert.ok(install >= 0, 'install locked npm dependencies before any test or browser invocation');
  assert.ok(steps.findIndex(step => step.includes('uses: actions/setup-node@')) < install);
  for (const [index, step] of steps.entries()) {
    if (/npm (run test:|exec -- playwright)/.test(step)) assert.ok(install < index, 'npm ci must precede its consumers');
  }
});
