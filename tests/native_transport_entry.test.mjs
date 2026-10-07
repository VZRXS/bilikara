import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';

test('transport browser command validates arguments before building or starting a Host', async () => {
  for(const args of [[],['--output'],['--bad','ignored']]) {
    const checked=await runNative(process.execPath,['tests/run_native_transport.mjs',...args],process.env,10000);
    assert.notEqual(checked.status,0);assert.match(checked.stderr,/usage:|output directory required/);
    assert.doesNotMatch(checked.stderr,/Compiling|Host readiness/);
  }
});

test('normal transport gate runs once after actual native inputs and installed Chromium; old drivers are retired', () => {
  const workflow=readFileSync(path.join(root,'.github/workflows/ci-bundle.yml'),'utf8');
  const checks=workflow.slice(workflow.indexOf('\n  test:'),workflow.indexOf('\n  bundle:'));
  const command='npm run test:native-transport', entry='npm run test:native-transport-entry';
  for(const invocation of [command,entry]) assert.equal(checks.split('\n').filter(line=>line.trim()===invocation).length,1);
  const block=checks.split(/\n      - /).find(step=>step.split('\n').some(line=>line.trim()===command));
  assert.match(block,/if: runner.os == 'Linux'/);assert.match(block,/set -euo pipefail/);
  assert.ok(block.indexOf('playwright install --with-deps chromium webkit')<block.indexOf(command));
  assert.ok(checks.indexOf('BILIKARA_TEST_LIBAV_COMPANION=')<checks.indexOf(command));
  assert.doesNotMatch(block,/python|continue-on-error|\|\| true/);
  const scripts=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).scripts;
  assert.equal(scripts['test:native-transport'],'node --test tests/native_transport.test.mjs tests/native_transport_browser.test.mjs');
  assert.equal(scripts['test:native-transport-entry'],'node --test tests/native_transport_entry.test.mjs');
  for(const file of ['test_transport_concurrency.py','live_transport_concurrency.py']) assert.equal(existsSync(path.join(root,'tests',file)),false);
});
