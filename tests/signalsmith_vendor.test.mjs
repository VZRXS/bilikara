import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adapt } from '../scripts/vendor_signalsmith.mjs';
import { root, runNative } from './desktop_construction_support.mjs';

test('pinned lifecycle adaptation preserves embedded bytes and every required independent guard', () => {
  const input = readFileSync(path.join(root, 'tests/fixtures/signalsmith-upstream-markers.txt'), 'utf8') + 'const wasmBytes = "FIXTURE_DSP_BYTES_unchanged";\n', output = adapt(input);
  assert.ok(output.startsWith('// Signalsmith Stretch Web 1.3.2, 57b93f4e9206a089a45387eaa39bdc9f310d3308; MIT. See README.md.\n'));
  for (const guard of ['WebAssembly.compile(binary)', 'this.destroyed = true', 'this.port.close()', 'if (this.destroyed) return false', 'this.configure()', 'options.outputChannelCount?.[0] || 2', 'signal?.aborted', "['error', 'wasm-init']", "signal?.addEventListener('abort'", '8000', "addEventListener('processorerror'", 'request.reject(reason)', 'requestMap[id].resolve(value)', "response('ready'", 'FIXTURE_DSP_BYTES_unchanged']) assert.ok(output.includes(guard), guard);
  assert.equal(output.split('WebAssembly.compile(binary)').length - 1, 1); assert.ok(!output.split('\n').some(line => /\s+$/.test(line)));
  assert.throws(() => adapt(input.replace('let pendingMessages = [];', 'let pendingMessages = null;')), /Unexpected upstream source/);
  assert.throws(() => adapt(input + '\nvar SignalsmithStretch = (() => {'), /Unexpected upstream source/);
  assert.throws(() => adapt(output), /Unexpected upstream source/);
});

test('native LF/CRLF source adaptation is identical and still rejects changed pinned markers', () => {
  const source = readFileSync(path.join(root, 'tests/fixtures/signalsmith-upstream-markers.txt'), 'utf8').replace(/\r\n/g, '\n')
    + 'const wasmBytes = "FIXTURE_DSP_BYTES_unchanged";\n';
  const expected = adapt(source);
  for (const input of [source, source.replace(/\n/g, '\r\n')]) {
    assert.equal(adapt(input), expected);
    assert.equal(adapt(input).split('FIXTURE_DSP_BYTES_unchanged').length - 1, 1);
    assert.throws(() => adapt(input.replace('let messageId', 'let changedMessageId')), /Unexpected upstream source/);
  }
});

test('invalid CLI source fails without damaging the existing valid asset', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'Signalsmith rebuild 中文 $() & ')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'invalid input.mjs'), asset = path.join(root, 'static/vendor/signalsmith-stretch/SignalsmithStretch.js'), before = readFileSync(asset); writeFileSync(source, 'invalid upstream');
  const result = await runNative(process.execPath, ['scripts/vendor_signalsmith.mjs', source]); assert.notEqual(result.status, 0); assert.match(result.stderr, /Unexpected upstream source/); assert.deepEqual(readFileSync(asset), before);
  const lifecycle = await runNative(process.execPath, ['tests/audio_pitch_lifecycle.cjs']); assert.equal(lifecycle.status, 0, lifecycle.stderr); const facts = JSON.parse(lifecycle.stdout.trim().split('\n').at(-1)); assert.equal(facts.live, 0); assert.equal(facts.cases, 12);
});
