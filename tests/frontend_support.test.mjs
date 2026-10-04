import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ownedDirectory } from './libav_prerequisite_support.mjs';
import { readSourceText, lockPackages, markupSummary, readUniqueJson, contains, hasContent, paired, subtract, splitLimited } from './frontend_contract_support.mjs';
import { runNodeScript } from './frontend_contract_support.mjs';

test('large frontend scripts use stdin with native cwd, UTF-8 and bounded real child execution', async () => {
  const directory = ownedDirectory('script stdin 中文 & $()');
  const expected = '中文 & $() \\\\ "';
  try {
    const script = `/*${'fixture 中文'.repeat(30_000)}*/
const fs = require('node:fs');
console.log(JSON.stringify({cwd: process.cwd(), text: ${JSON.stringify(expected)}, env: process.env.FRONTEND_SCRIPT_TEST}));`;
    assert.ok(script.length > 131072, 'exceeds both Windows and Linux inline argument limits');
    const result = await runNodeScript(script, 10_000, directory, { ...process.env, FRONTEND_SCRIPT_TEST: expected });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(directory), text: expected, env: expected });
    const failed = await runNodeScript("console.error('fixture failure');process.exitCode=17;");
    assert.equal(failed.status, 17); assert.match(failed.stderr, /fixture failure/);
    await assert.rejects(runNodeScript("require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(() => {}, 1000);", 1000, directory), { code: 'ETIMEDOUT' });
    const pid = Number(readFileSync(path.join(directory, 'child.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'timed-out script must be reaped');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('markup assertions retain order/boolean attributes/entities without reading comments as elements', () => {
  const result = markupSummary(`<!-- <video id="hidden"> --><button id='menu' disabled data-i18n-title="label&amp;more"></button><script src=/first.js></script><script src="/second.js"></script>`);
  assert.deepEqual(result.tags, ['button', 'script', 'script']);
  assert.deepEqual(result.ids, new Set(['menu'])); assert.deepEqual(result.scripts, ['/first.js', '/second.js']);
  assert.equal(result.elements[0][1].disabled, ''); assert.deepEqual(result.keys, new Set(['label&more']));
});

test('i18n catalog reader rejects duplicate keys at their own nesting depth and escaped equivalents', () => {
  const directory = ownedDirectory('unique catalog'); const file = path.join(directory, 'i18n.json');
  try {
    writeFileSync(file, '{"languages":{"en":{"key":"yes"},"zh":{"key":"是"}}}');
    assert.deepEqual(readUniqueJson(file), {languages: {en: {key: 'yes'}, zh: {key: '是'}}});
    for (const invalid of ['{"languages":{"en":{"key":"a","key":"b"}}}', '{"key":1,"k\\u0065y":2}', '{']) {
      writeFileSync(file, invalid); assert.throws(() => readUniqueJson(file));
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('frontend fixture collections retain deep membership, emptiness, pairing and complete split suffixes', () => {
  assert.equal(contains(['a', true], [['a', true]]), true); assert.equal(contains(['a', false], [['a', true]]), false);
  for (const empty of [[], new Set(), {}, '', false, 0]) assert.equal(hasContent(empty), false);
  assert.deepEqual(paired([1, 2, 3], ['a', 'b']), [[1, 'a'], [2, 'b']]);
  assert.deepEqual(subtract(new Set(['a', 'b']), new Set(['b'])), new Set(['a']));
  assert.equal(subtract(5, 2), 3);
  assert.deepEqual(splitLimited('first.second.third.fourth', '.', 2), ['first', 'second', 'third.fourth']);
});

// Windows checkouts may use CRLF; source contracts must retain exact step order
// and flags while artifact byte comparisons remain independent of this reader.
test('source contracts read LF/CRLF identically without erasing flags, Unicode or literal escapes', () => {
  const directory = ownedDirectory('source newlines 中文 &'), file = path.join(directory, 'workflow.txt');
  const expected = 'job:\n  run: |\n    cargo test --locked\n    npm run test:native-host\n# 中文 \\r\\n & $()\n';
  try {
    for (const bytes of [expected, expected.replace(/\n/g, '\r\n')]) {
      writeFileSync(file, bytes);
      assert.equal(readSourceText(file), expected);
      assert.ok(readSourceText(file).indexOf('cargo test --locked') < readSourceText(file).indexOf('npm run test:native-host'));
    }
    writeFileSync(file, expected.replace('--locked', '--offline'));
    assert.notEqual(readSourceText(file), expected);
    assert.throws(() => readSourceText(file, null), /UTF-8/);
    const lock = '[[package]]\nname = "fixture"\nversion = "1.2.3"\n';
    for (const bytes of [lock, lock.replace(/\n/g, '\r\n')]) {
      writeFileSync(file, bytes);
      assert.deepEqual(lockPackages(readSourceText(file)), {package: [{name: 'fixture', version: '1.2.3'}]});
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
