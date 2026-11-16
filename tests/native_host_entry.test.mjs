import {desktopWorkflow, desktopChecks} from './ci_workflow_support.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { root, runNative } from './desktop_construction_support.mjs';
import { csvRows } from './native_export_support.mjs';
import { acquire, exclusive, publish, reclaim, release } from './native_runtime_artifacts.mjs';

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

test('concurrent test files receive process-owned Cargo artifacts that a later uplift cannot remove', async () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'bilikara-artifacts-'));
  const exited = async () => { const child = spawn(process.execPath, ['-e', '']); await new Promise(resolve => child.once('exit', resolve)); return child.pid; };
  try {
    const examples = path.join(target, 'host', 'debug', 'examples'), suffix = process.platform === 'win32' ? '.exe' : '';
    const cargo = path.join(examples, `native_host_alpha${suffix}`);
    mkdirSync(examples, {recursive: true}); writeFileSync(cargo, 'first build');
    const dead = await exited(), stale = path.join(examples, `native_host_alpha.bilikara-test-${dead}-1${suffix}`);
    const live = path.join(examples, `native_host_alpha.bilikara-test-${process.ppid}-1${suffix}`), unrelated = path.join(examples, `native_host_alpha.bilikara-test-x${suffix}`);
    for (const file of [stale, live, unrelated]) writeFileSync(file, 'other');
    const first = publish(cargo, target), second = publish(cargo, target);
    assert.notEqual(first, second); assert.equal(path.dirname(first), examples, 'same parent keeps resource and current_exe semantics');
    assert.match(path.basename(first), new RegExp(`^native_host_alpha\\.bilikara-test-${process.pid}-\\d+${suffix.replace('.', '\\.')}$`));
    assert.equal(existsSync(stale), false, 'names owned by exited processes are reclaimed');
    assert.ok(existsSync(live) && existsSync(unrelated), 'live or nonmatching names are never removed');
    // Cargo's fresh-build uplift: remove the uplifted path, then link a new one.
    rmSync(cargo); assert.equal(readFileSync(first, 'utf8'), 'first build');
    writeFileSync(cargo, 'second build'); assert.equal(readFileSync(second, 'utf8'), 'first build');
    assert.equal(readFileSync(publish(cargo, target), 'utf8'), 'second build');
    // An exited process's name that Windows still holds as a running image (EBUSY/EPERM/EACCES) is kept
    // for a later attempt and never blocks the new publication; other removal errors still fail.
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const running = path.join(examples, `native_host_alpha.bilikara-test-${await exited()}-9${suffix}`);
      writeFileSync(running, 'orphaned Host');
      const fresh = publish(cargo, target, {remove: file => { if (file === running) throw Object.assign(Error(code), {code}); rmSync(file); }});
      assert.ok(existsSync(running) && existsSync(fresh), `${code}: the running name is kept and the new name is published`);
      rmSync(running);
    }
    const unreadable = path.join(examples, `native_host_alpha.bilikara-test-${await exited()}-9${suffix}`);
    writeFileSync(unreadable, 'orphaned Host');
    assert.throws(() => publish(cargo, target, {remove: () => { throw Object.assign(Error('device error'), {code: 'EIO'}); }}), /device error/);
    rmSync(unreadable);
    const outside = path.join(os.tmpdir(), `native_host_alpha-outside${suffix}`);
    assert.throws(() => publish(outside, target), /outside its target/);

    const events = [];
    const hold = name => exclusive(target, async () => { events.push(`${name}+`); await new Promise(resolve => setTimeout(resolve, 50)); events.push(`${name}-`); });
    await Promise.all([hold('a'), hold('b'), hold('c')]);
    assert.deepEqual(events.filter((_, index) => index % 2 === 0).map(event => event[0]), events.filter((_, index) => index % 2).map(event => event[0]), `holders never overlap: ${events}`);
    const lock = path.join(target, '.bilikara-test-artifacts.lock');
    assert.equal(existsSync(lock), false, 'the lock is released after its holder');
    await assert.rejects(exclusive(target, async () => { throw Error('build failed'); }), /build failed/);
    assert.equal(existsSync(lock), false, 'a failed build releases the lock');
    // A file that releases and immediately builds again (alpha, then Host) must not starve a waiting file.
    const turns = []; let stop = false;
    const greedy = (async () => { for (let n = 0; n < 40 && !stop; n++) await exclusive(target, async () => { turns.push('greedy'); await new Promise(resolve => setTimeout(resolve, 20)); }, {poll: 5}); })();
    await new Promise(resolve => setTimeout(resolve, 30));
    await exclusive(target, async () => { turns.push('waiter'); stop = true; }, {poll: 5});
    await greedy;
    assert.ok(turns.indexOf('waiter') >= 1 && turns.indexOf('waiter') <= 2, `the waiter is served next in FIFO order: ${turns}`);
    const queue = path.join(target, '.bilikara-test-artifacts.queue');
    assert.deepEqual(readdirSync(queue), [], 'every ticket leaves the queue');
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), String(await exited()));
    assert.equal(await exclusive(target, async () => 'reclaimed', {timeout: 5000}), 'reclaimed', 'a lock left by an exited process is reclaimed');
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), String(process.ppid));
    await assert.rejects(exclusive(target, async () => 'acquired', {timeout: 300, poll: 20}), /timed out waiting for the Cargo artifact lock/);
    assert.ok(existsSync(lock), 'a live holder keeps its lock');
    rmSync(lock, {recursive: true});
    // A late reclaimer that observed an older stale lock never removes the newer lock acquired since.
    const abandoned = `${await exited()}:abandoned`;
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), abandoned);
    assert.equal(reclaim(lock, abandoned), true, 'the first reclaimer moves the abandoned lock aside');
    assert.equal(acquire(lock, 'live:newer'), true); assert.equal(acquire(lock, 'second'), false, 'a held lock admits no second holder');
    assert.equal(reclaim(lock, abandoned), false, 'the late reclaimer backs off');
    assert.equal(readFileSync(path.join(lock, 'owner'), 'utf8'), 'live:newer'); assert.equal(existsSync(path.join(lock, 'reclaim')), false);
    release(lock); assert.equal(existsSync(lock), false);
    // Only the process holding an abandoned lock's exclusive claim may reclaim it.
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), abandoned); writeFileSync(path.join(lock, 'reclaim'), String(process.ppid));
    assert.equal(reclaim(lock, abandoned), false, 'another live reclaimer owns this instance'); assert.ok(existsSync(lock));
    rmSync(lock, {recursive: true});
    // Real concurrent processes contending for a lock left by an exited holder never overlap.
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), abandoned);
    const log = path.join(target, 'holders.log'), module = new URL('./native_runtime_artifacts.mjs', import.meta.url).href;
    const contender = `const {exclusive}=await import(${JSON.stringify(module)});const {appendFileSync}=await import('node:fs');
      await exclusive(${JSON.stringify(target)},async()=>{appendFileSync(${JSON.stringify(log)},'+'+process.pid+'\\n');await new Promise(r=>setTimeout(r,25));appendFileSync(${JSON.stringify(log)},'-'+process.pid+'\\n');},{poll:5,timeout:60000});`;
    const codes = await Promise.all(Array.from({length: 6}, () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender], {stdio: 'inherit'}); child.once('exit', resolve);
    })));
    assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
    const entries = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(entries.length, 12);
    for (let n = 0; n < entries.length; n += 2) assert.ok(entries[n][0] === '+' && entries[n + 1] === `-${entries[n].slice(1)}`, `holders never overlap: ${entries}`);
    rmSync(log); assert.equal(existsSync(lock), false);
    assert.deepEqual(readdirSync(target).filter(entry => entry.startsWith('.bilikara-test-artifacts.lock')), [], 'no staging directory or tombstone remains');
    // An exited process's ticket ahead in the queue is dropped instead of blocking the line.
    writeFileSync(path.join(queue, `${'0'.repeat(15)}-${String(await exited()).padStart(10, '0')}-000001`), '');
    assert.equal(await exclusive(target, async () => 'next', {timeout: 5000}), 'next');
    assert.deepEqual(readdirSync(queue), []);
    assert.deepEqual(readdirSync(target).sort(), ['.bilikara-test-artifacts.queue', 'host']);
  } finally {
    rmSync(target, {recursive: true, force: true});
  }
});

test('native business CI runs once after real Linux prerequisite export and never uses Python transport', () => {
  const workflow = desktopWorkflow.replace(/\r\n/g, '\n'), checks = desktopChecks;
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
  const ratings = 'node scripts/ci_tests.mjs shared';
  assert.equal(checks.split('\n').filter(line => line.trim() === ratings).length, 1);
  assert.ok(checks.indexOf('BILIKARA_TEST_LIBAV_COMPANION=') < checks.indexOf(ratings));
  const browser = checks.split(/\n      - /).find(step => step.includes(ratings));
  assert.match(browser, /if: runner.os == 'Linux'/);
  assert.match(browser, /set -euo pipefail/);
  assert.ok(checks.indexOf('playwright install --with-deps chromium webkit') < checks.indexOf(ratings));
  assert.doesNotMatch(browser, /python|continue-on-error|\|\| true/);
  assert.equal(scripts['test:native-ratings'], 'node --test tests/native_ratings_browser.test.mjs');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.playwright, '1.63.0');
  const steps = checks.split(/\n      - /).slice(1);
  const install = steps.findIndex(step => /\brun: npm ci\s*$/.test(step));
  assert.ok(install >= 0, 'install locked npm dependencies before any test or browser invocation');
  assert.ok(steps.findIndex(step => step.includes('uses: actions/setup-node@')) < install);
  for (const [index, step] of steps.entries()) {
    if (/(?:npm (run test:|exec -- playwright)|node scripts\/ci_tests\.mjs)/.test(step)) assert.ok(install < index, 'npm ci must precede its consumers');
  }
});
