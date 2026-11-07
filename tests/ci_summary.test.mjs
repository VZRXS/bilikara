import assert from 'node:assert/strict';
import test from 'node:test';
import {renderCiSummary, writeCiSummary} from '../scripts/ci_summary.mjs';

const context = {repo: {owner: 'VZRXS', repo: 'bilikara-next'}, runId: 123,
  sha: 'a'.repeat(40), serverUrl: 'https://github.com'};
const results = {desktop: {result: 'success'}, mobile: {result: 'success'}};
const names = ['windows-x64.zip', 'windows-arm64.zip', 'macos-x64.zip', 'macos-arm64.zip',
  'android.apk', 'ios-device-unsigned.ipa', 'ios-simulator.zip', 'playback-diagnostics'];
const fixtures = () => names.map((name, index) => ({id: index + 1, name,
  size_in_bytes: 1024 * 1024, expired: false, attempt: index === 0 ? 2 : 1}));

test('one run-wide download list includes earlier attempts and paginated artifacts', async () => {
  const artifacts = fixtures();
  for (let index = 9; index <= 105; index++) artifacts.push({id: index,
    name: `diagnostic-${index}`, size_in_bytes: 10, expired: false});
  const original = structuredClone(artifacts);
  const endpoint = Symbol('listWorkflowRunArtifacts');
  let output = '', written = 0;
  await writeCiSummary({context, results,
    github: {rest: {actions: {listWorkflowRunArtifacts: endpoint}}, paginate: async (method, parameters) => {
      assert.equal(method, endpoint);
      assert.deepEqual(parameters, {owner: 'VZRXS', repo: 'bilikara-next', run_id: 123, per_page: 100});
      return artifacts;
    }},
    core: {summary: {addRaw(markdown) {output += markdown; return this;}, async write() {written++;}}},
  });
  assert.equal(written, 1);
  assert.match(output, /Artifacts \(105\)/);
  for (const [index, name] of names.entries()) {
    assert.ok(output.includes(`[${name}](https://github.com/VZRXS/bilikara-next/actions/runs/123/artifacts/${index + 1})`));
  }
  assert.ok(output.includes('/artifacts/105)'));
  assert.deepEqual(artifacts, original, 'summary must not mutate API data');
});

test('failed builds and empty/expired artifact lists remain explicit', () => {
  const failed = {...results, desktop: {result: 'failure'}};
  const empty = renderCiSummary({context, results: failed, artifacts: []});
  assert.match(empty, /Desktop \| failure/);
  assert.match(empty, /No artifacts were uploaded/);
  const artifacts = fixtures(); artifacts[0].expired = true;
  const output = renderCiSummary({context, results, artifacts});
  assert.match(output, /windows-x64.zip \| 1.0 MiB \| Expired/);
  assert.ok(!output.includes('/artifacts/1)'));
  assert.ok(output.includes('/artifacts/2)'));
});

test('artifact labels cannot inject Markdown links, columns or HTML', () => {
  const output = renderCiSummary({context, results, artifacts: [{id: 1,
    name: '[external](https://example.invalid)|<img>', size_in_bytes: 1, expired: false}]});
  assert.ok(output.includes('\\[external\\]\\(https://example.invalid\\)\\|&lt;img&gt;'));
  assert.ok(!output.includes('<img>'));
  assert.equal(output.split('\n').filter(line => line.startsWith('| [')).length, 1);
  for (const artifacts of [
    [{id: 0, name: 'bad', size_in_bytes: 1, expired: false}],
    [{id: 1, name: 'bad\nrow', size_in_bytes: 1, expired: false}],
    [{id: 1, name: 'bad', size_in_bytes: -1, expired: false}],
    [fixtures()[0], fixtures()[0]],
  ]) assert.throws(() => renderCiSummary({context, results, artifacts}));
});

test('GitHub API failures cannot be rendered as a successful empty result', async () => {
  let written = false;
  await assert.rejects(writeCiSummary({context, results,
    github: {rest: {actions: {listWorkflowRunArtifacts: {}}}, paginate: async () => {throw Error('API unavailable');}},
    core: {summary: {addRaw() {written = true; return this;}, async write() {written = true;}}},
  }), /API unavailable/);
  assert.equal(written, false);
});
