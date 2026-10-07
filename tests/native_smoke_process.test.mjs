import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapturedProcess } from './macos_smoke_process.mjs';
import { root } from './desktop_construction_support.mjs';
import { smokeTimeout, finderEnvironment } from './macos_tauri_smoke.mjs';

const fixture = process.env.BILIKARA_TEST_PROCESS_FIXTURE;
assert.ok(fixture, 'compiled native process fixture required; invoke npm run test:native-smoke');
const start = mode => new CapturedProcess([fixture, mode], root, process.env);
const ready = (name, line) => {if (name !== 'stdout') return null; try {const value = JSON.parse(line); return value.event === 'bilikara.ready' ? value : null;} catch {return null;}};

for (const mode of ['ready', 'delayed', 'stderr', 'malformed']) test(`native streaming reader handles ${mode} before readiness and drains both streams`, async () => {
  const capture = start(mode);
  try {
    assert.equal((await capture.waitForOutput(ready, 2)).port, 4);
    assert.ok(capture.output.stdout.includes('starting'));
  } finally {assert.equal(await capture.terminate(), true);}
  if (mode === 'stderr') assert.ok(capture.output.stderr.includes('warning'));
});
test('exit before readiness, idempotent cleanup and quiet deadlines are bounded', async () => {
  for (const mode of ['exit', 'done', 'waiting']) {
    const capture = start(mode), begun = performance.now();
    try {
      assert.equal(await capture.waitForOutput(ready, .2), null); assert.ok(performance.now() - begun < 1000);
      if (mode !== 'waiting') {assert.equal(await capture.waitForExit(1), true); assert.equal(capture.process.exitCode, mode === 'exit' ? 7 : 0);}
    } finally {assert.equal(await capture.terminate(), true); assert.equal(await capture.terminate(), true);}
  }
});
test('closed pipes return before the live process exits', {skip: process.platform === 'win32' ? 'POSIX close(1/2) fixture' : false}, async () => {
  const capture = start('closed'), begun = performance.now();
  try {assert.equal(await capture.waitForOutput(ready, 2), null); assert.ok(performance.now() - begun < 1000); assert.equal(capture.exited, false);}
  finally {assert.equal(await capture.terminate(), true);}
});
test('cleanup terminates the complete owned process group, also after its leader exits', {skip: process.platform === 'win32' ? 'POSIX process group contract' : false}, async () => {
  for (const mode of ['tree', 'leader-exits']) {
    const capture = start(mode);
    const child = await capture.waitForOutput((name, line) => name === 'stdout' && /^\d+\s*$/.test(line) ? Number(line.trim()) : null, 2);
    assert.ok(Number.isInteger(child));
    if (mode === 'leader-exits') {assert.equal(await capture.waitForExit(1), true); assert.equal(capture.groupExists(), true);}
    assert.equal(await capture.terminate(.1, 2), true);
    assert.equal(capture.groupExists(), false);
    assert.throws(() => process.kill(child, 0), error => error.code === 'ESRCH');
  }
});
test('permission refusal is failure and does not disguise a still-running process', {skip: process.platform === 'win32' ? 'POSIX signal permissions' : false}, async () => {
  const capture = start('waiting'), original = process.kill;
  try {
    process.kill = (pid, signal) => {if (pid === -capture.process.pid && signal !== 0) throw Object.assign(new Error('isolated fixture permission denial'), {code: 'EPERM'}); return original(pid, signal);};
    assert.equal(await capture.terminate(.1, .1), false); assert.equal(capture.exited, false);
    process.kill = (pid, signal) => {
      if (pid === -capture.process.pid && signal === 'SIGTERM') return true;
      if (pid === -capture.process.pid && signal === 'SIGKILL') throw Object.assign(new Error('isolated kill permission denial'), {code: 'EPERM'});
      return original(pid, signal);
    };
    assert.equal(await capture.terminate(.01, .1), false); assert.equal(capture.exited, false);
  } finally {process.kill = original; assert.equal(await capture.terminate(), true);}
});
test('signal refusal during natural exit succeeds only after the owned process and group disappear', {skip: process.platform === 'win32' ? 'POSIX signal permissions' : false}, async () => {
  const capture = start('delayed'), original = process.kill;
  let refused = 0;
  try {
    process.kill = (pid, signal) => {
      if (pid === -capture.process.pid && signal !== 0) {
        refused++;
        throw Object.assign(new Error('exiting fixture signal denial'), {code: 'EPERM'});
      }
      return original(pid, signal);
    };
    assert.equal(await capture.terminate(2, 2), true);
    assert.ok(refused > 0, 'exercise the signal refusal');
    assert.equal(capture.exited, true);
    assert.equal(capture.groupExists(), false);
    assert.equal(capture.process.exitCode, 0, 'the fixture exited naturally');
    assert.ok(capture.output.stdout.includes('bilikara.ready'));
  } finally {process.kill = original; assert.equal(await capture.terminate(), true);}
});
test('native shell deadlines and Finder-like environment retain exact field/limit semantics', () => {
  assert.equal(smokeTimeout({}), 90); assert.equal(smokeTimeout({BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS: '120.5'}), 120.5);
  for (const value of ['0', '-1', '301', 'nan', 'Infinity', 'not-a-number']) assert.throws(() => smokeTimeout({BILIKARA_TAURI_SMOKE_TIMEOUT_SECONDS: value}));
  assert.deepEqual(finderEnvironment('/Users/runner', '/tmp/finder-smoke', '/tmp/finder-smoke/desktop-startup.log'), {
    BILIKARA_DESKTOP_STARTUP_LOG: '/tmp/finder-smoke/desktop-startup.log', HOME: '/Users/runner', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', RUST_BACKTRACE: '1', TMPDIR: '/tmp/finder-smoke',
  });
});
