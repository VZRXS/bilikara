// Actual current Host offline entry; all data and environment roots are owned
// temporary fixtures. No media prefix, tool installation or live accounts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { root, runNative } from './desktop_construction_support.mjs';
import { isolatedEnvironment, RunningHost } from './native_host_support.mjs';
import { csvRows } from './native_export_support.mjs';

let executable;
before(async () => { executable = await buildNativeHost(); });
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara import 中文 $() & '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...isolatedEnvironment(home), APPDATA: path.join(home, 'roaming'), BILIKARA_LIBAV_COMPANION: path.join(home, 'absent libav') };
  return { home, env };
}
function oldData(folder) {
  const data = path.join(folder, 'data'); mkdirSync(path.join(data, 'played_sessions'), { recursive: true });
  writeFileSync(path.join(data, 'player_state.json'), JSON.stringify({ playback_mode: 'local', player_settings: { av_offset_ms: 300, volume_percent: 64 } }));
  writeFileSync(path.join(data, 'session_users.json'), JSON.stringify({ session_users: ['小林', 'Alice'] }));
  const song = { key: 'old-song', item_id: 'old-item', display_title: 'Old song 中文', title: 'Old song 中文', part_title: 'P1', original_url: 'https://example.test/song', resolved_url: 'https://example.test/song', bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, played_at: 101, requester_name: 'Alice' };
  writeFileSync(path.join(data, 'history.json'), JSON.stringify({ history: [{ key: 'old-song', display_title: 'Old song 中文', original_url: 'https://example.test/song', resolved_url: 'https://example.test/song', requested_at: 100, request_count: 3 }] }));
  writeFileSync(path.join(data, 'played_sessions/played-old.json'), JSON.stringify({ session_started_at: 90, items: [song] }));
  return data;
}
async function offline(args, home, env, success = true) {
  const result = await runNative(executable, args, env, 30_000, home);
  assert.equal(result.status === 0, success, result.stderr);
  if (success) { assert.equal(result.stderr, ''); return JSON.parse(result.stdout); }
  assert.equal(result.stdout, '', 'failure must not emit a completion report');
  return result.stderr;
}

test('native inspection detects only known current-OS roots and is read-only', async t => {
  const { home, env } = fixture(t), target = path.join(home, 'new installation/runtime/data');
  const known = process.platform === 'win32'
    ? [path.join(env.LOCALAPPDATA, 'bilikara'), path.join(env.APPDATA, 'bilikara')]
    : [path.join(home, process.platform === 'darwin' ? 'Library/Application Support/bilikara' : 'share/bilikara')];
  for (const folder of [...known, path.join(home, 'unrelated')]) oldData(folder);
  const report = await offline(['--inspect-legacy-import', '--data-dir', target], home, env);
  assert.equal(report.schema_version, 1); assert.equal(report.destination_status, 'missing'); assert.equal(report.pending, false);
  // The native filesystem resolves Windows 8.3 aliases and extended paths.
  // Node's JavaScript realpath implementation can retain RUNNER~1 while the
  // actual Host reports the same directory's canonical long name.
  assert.deepEqual(report.candidates.map(p => realpathSync.native(p)).sort(), known.map(p => realpathSync.native(p)).sort());
  assert.equal(existsSync(path.dirname(target)), false);
  assert.equal(existsSync(path.join(home, 'share/bilikara/data/host-state.json')), false);
  const selections = [known[0], path.join(known[0], 'data')];
  if (process.platform === 'win32') {
    selections.push(path.toNamespacedPath(realpathSync.native(known[0])));
  }
  for (const selection of selections) {
    const selected = await offline(['--inspect-legacy-import', '--data-dir', target, '--import-from', selection], home, env);
    assert.deepEqual(selected.candidates.map(p => realpathSync.native(p)), [realpathSync.native(known[0])]);
  }
});

test('one-shot conversion keeps source bytes and existing native records, without tool/media prerequisites', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'old runtime 中文 & $()'), data = oldData(source);
  const target = path.join(home, 'new/runtime/data'), original = readFileSync(path.join(data, 'history.json'));
  const result = await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env);
  assert.equal(result.schema_version, 1); assert.equal(result.completed, true); assert.equal(result.backup, null);
  assert.equal(realpathSync.native(result.destination), realpathSync.native(target));
  assert.deepEqual(readFileSync(path.join(data, 'history.json')), original);
  const checkpoint = readFileSync(path.join(target, 'host-state.json'));
  assert.equal(JSON.parse(checkpoint).schema_version, 3);
  const failure = await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env, false);
  assert.match(failure, /protected/); assert.deepEqual(readFileSync(path.join(target, 'host-state.json')), checkpoint);
  // Start the real Host only after the offline command has exited. This checks
  // interpreted records at the supported HTTP/export boundary, not merely JSON.
  const hostEnv = { ...env }; delete hostEnv.BILIKARA_LIBAV_COMPANION;
  const host = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', target, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try {
    const state = await host.api('/api/state');
    assert.deepEqual(state.session_users, ['小林', 'Alice']);
    assert.equal(state.player_settings.av_offset_ms, 300);
    assert.equal(state.player_settings.av_delay.locked, true);
    assert.equal(state.player_settings.volume_percent, 64);
    const sessions = await host.api('/api/played-sessions'); assert.ok(sessions.some(s => s.id === 'played-old.json' && s.count === 1));
    const exported = await host.request('/api/playlist/export?format=csv&source=played-old.json');
    assert.equal(exported.status, 200); const rows = csvRows(exported.body); assert.equal(rows.length, 2);
    assert.ok(rows[1].includes('Old song 中文')); assert.ok(rows[1].includes('Alice'));
  } finally { await host.close(); }
});

test('in-place conversion retains exact backup and malformed data never reports success', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'in-place runtime'), target = oldData(source);
  const original = readFileSync(path.join(target, 'history.json'));
  const report = await offline(['--import-only', '--data-dir', target, '--import-from', target], home, env);
  assert.equal(report.completed, true); assert.ok(report.backup); assert.deepEqual(readFileSync(path.join(report.backup, 'history.json')), original);
  const broken = path.join(home, 'broken runtime'), brokenData = oldData(broken);
  writeFileSync(path.join(brokenData, 'history.json'), '{unfinished');
  assert.match(await offline(['--import-only', '--data-dir', brokenData, '--import-from', broken], home, env, false), /invalid/);
  assert.equal(readFileSync(path.join(brokenData, 'history.json'), 'utf8'), '{unfinished');
  assert.equal(existsSync(path.join(brokenData, 'host-state.json')), false);
  assert.equal(readdirSync(broken).some(n => n.endsWith('.bilikara-import.json')), false);
});

test('offline mode rejects startup/network flags and unknown targets without overwriting files', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'source'), target = path.join(home, 'data'); oldData(source);
  for (const args of [['--inspect-legacy-import', '--import-only'], ['--import-only', '--port', '0'], ['--inspect-legacy-import', '--import-from'], ['--import-only', '--data-dir', 'relative', '--import-from', source]]) {
    await offline(args, home, env, false);
  }
  mkdirSync(target); writeFileSync(path.join(target, 'unrelated.txt'), 'keep');
  assert.match(await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env, false), /unrecognized/);
  assert.equal(readFileSync(path.join(target, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(path.join(target, 'host-state.json')), false);
});

test('CI exercises actual import entry and native-feature recovery checks on the platform test matrix', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/ci-bundle.yml'), 'utf8');
  const matrix = workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  bundle:'));
  const steps = matrix.split(/\n      - /);
  const check = steps.findIndex(s => s.includes('npm run test:native-import'));
  assert.ok(check >= 0); assert.equal(matrix.split('npm run test:native-import').length - 1, 1);
  assert.ok(steps.findIndex(s => s.includes('rustup toolchain install')) < check);
  assert.ok(steps.findIndex(s => s.includes('npm ci')) < check);
  assert.ok(steps[check].includes('--features native-host --locked --target host-tuple --lib native_host::desktop_import'));
  assert.doesNotMatch(steps[check], /continue-on-error|if:|python|--port/);
});
