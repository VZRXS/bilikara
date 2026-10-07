// Actual current Host offline entry; all data and environment roots are owned
// temporary fixtures. No media prefix, tool installation or live accounts.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('first-start inspection is silent for absent legacy records and skips discovery for native data', async t => {
  const { home, env } = fixture(t), target = path.join(home, 'new/runtime/data');
  const first = await offline(['--inspect-first-start', '--data-dir', target], home, env);
  assert.deepEqual(first.candidates, []); assert.equal(first.destination_status, 'missing');
  assert.equal(existsSync(path.dirname(target)), false, 'Detection must not initialize a checkpoint');
  const known = process.platform === 'win32' ? path.join(env.LOCALAPPDATA, 'bilikara')
    : path.join(home, process.platform === 'darwin' ? 'Library/Application Support/bilikara' : 'share/bilikara');
  oldData(known);
  assert.equal((await offline(['--inspect-first-start', '--data-dir', target], home, env)).candidates.length, 1);
  await offline(['--import-only', '--data-dir', target, '--import-from', known], home, env);
  const before = readFileSync(path.join(target, 'host-state.json'));
  const reopened = await offline(['--inspect-first-start', '--data-dir', target], home, env);
  assert.equal(reopened.destination_status, 'native'); assert.deepEqual(reopened.candidates, []);
  assert.deepEqual(readFileSync(path.join(target, 'host-state.json')), before);
  const nativeSource = await offline(['--inspect-legacy-import', '--data-dir', path.join(home, 'another/data'), '--import-from', path.dirname(target)], home, env);
  assert.deepEqual(nativeSource.candidates.map(p => realpathSync.native(p)), [realpathSync.native(path.dirname(target))]);
  assert.deepEqual(readFileSync(path.join(target, 'host-state.json')), before, 'Native-format inspection does not rewrite a checkpoint');
});

test('failed first-start conversion can proceed normally without rediscovery, with manual import available later', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'old runtime'), data = oldData(source);
  writeFileSync(path.join(data, 'history.json'), '{bad saved record');
  await offline(['--import-only', '--data-dir', data, '--import-from', source], home, env, false);
  const fresh = await offline(['--start-without-import', '--data-dir', data], home, env);
  assert.equal(fresh.completed, true); assert.ok(fresh.backup);
  assert.equal(readFileSync(path.join(fresh.backup, 'history.json'), 'utf8'), '{bad saved record');
  assert.deepEqual((await offline(['--inspect-first-start', '--data-dir', data], home, env)).candidates, []);
  const hostEnv = {...env}; delete hostEnv.BILIKARA_LIBAV_COMPANION;
  const host = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', data, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try {
    const state = await host.api('/api/state');
    assert.deepEqual(state.history, []); assert.deepEqual(state.session_users, []);
    // A fresh fallback must be usable, rather than merely printing success or
    // entering the resume-session gate intended for a populated checkpoint.
    await host.api('/api/session-users/add', {name: 'Normal startup works'});
    assert.deepEqual((await host.api('/api/state')).session_users, ['Normal startup works']);
  } finally { await host.close(); }
  const correct = path.join(home, 'correct runtime'); oldData(correct);
  const later = await offline(['--import-only', '--replace-native', '--remove-source', '--data-dir', data, '--import-from', correct], home, env);
  assert.equal(later.completed, true); assert.equal(existsSync(path.join(correct, 'data')), false);
  assert.ok(existsSync(path.join(later.source_backup, 'history.json')));
  assert.equal(readFileSync(path.join(fresh.backup, 'history.json'), 'utf8'), '{bad saved record', 'failed old data remains recoverable');
});

function dataInventory(folder, relative = '') {
  return readdirSync(path.join(folder, relative)).sort().flatMap(name => {
    if (!relative && name === 'host-state.lock') return [];
    const key = path.join(relative, name), file = path.join(folder, key), meta = lstatSync(file);
    assert.equal(meta.isSymbolicLink(), false);
    const row = {path: key, directory: meta.isDirectory(), mode: process.platform === 'win32' ? null : meta.mode & 0o777};
    return meta.isDirectory() ? [row, ...dataInventory(folder, key)] : [{...row, bytes: readFileSync(file).toString('base64')}];
  });
}

test('failed known AppData moves into the current legacy-backup and is absent even for another fresh installation', async t => {
  const {home, env} = fixture(t);
  const source = process.platform === 'win32' ? path.join(env.APPDATA, 'bilikara')
    : path.join(home, process.platform === 'darwin' ? 'Library/Application Support/bilikara' : 'share/bilikara');
  const data = oldData(source), target = path.join(home, 'new runtime 中文/data');
  writeFileSync(path.join(data, 'history.json'), '{broken original');
  mkdirSync(path.join(data, 'cache/nested'), {recursive: true});
  writeFileSync(path.join(data, 'cache/nested/exact.bin'), Buffer.from([0, 128, 255]));
  writeFileSync(path.join(source, 'unrelated-file'), 'untouched');
  const expected = dataInventory(data);
  await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env, false);
  const report = await offline(['--start-without-import', '--data-dir', target, '--import-from', source], home, env);
  assert.equal(report.completed, true); assert.equal(report.cleanup_warning, undefined);
  assert.equal(existsSync(data), false);
  assert.ok(path.relative(realpathSync.native(path.dirname(target)), realpathSync.native(report.source_backup)).startsWith(`legacy-backup${path.sep}`));
  assert.deepEqual(dataInventory(report.source_backup), expected);
  assert.equal(readFileSync(path.join(source, 'unrelated-file'), 'utf8'), 'untouched');
  const another = await offline(['--inspect-first-start', '--data-dir', path.join(home, 'another runtime/data')], home, env);
  assert.equal(another.destination_status, 'missing'); assert.deepEqual(another.candidates, []);
  const current = await offline(['--inspect-first-start', '--data-dir', target], home, env);
  assert.equal(current.destination_status, 'native'); assert.deepEqual(current.candidates, []);
});

test('new-format runtime is copied byte-for-byte with its cache and live identities, then moved from the old path', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'Preview 2 runtime 中文 & $()'), data = path.join(source, 'data');
  const target = path.join(home, 'new runtime/data');
  await offline(['--start-without-import', '--data-dir', data], home, env);
  const hostEnv = {...env}; delete hostEnv.BILIKARA_LIBAV_COMPANION;
  const host = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', data, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try {
    await host.api('/api/session-users/add', {name: 'Native identity 中文'});
    const error = await offline(['--import-only', '--remove-source', '--data-dir', target, '--import-from', source], home, env, false);
    assert.match(error, /owns|lock/i); assert.equal(existsSync(path.join(target, 'host-state.json')), false);
  } finally { await host.close(); }
  mkdirSync(path.join(data, 'cache/nested'), {recursive: true});
  writeFileSync(path.join(data, 'cache/nested/keep.bin'), Buffer.from([0, 1, 127, 128, 255]));
  writeFileSync(path.join(source, 'unrelated-installation-file'), 'untouched');
  const expected = dataInventory(data), checkpoint = readFileSync(path.join(data, 'host-state.json'));
  const report = await offline(['--import-only', '--remove-source', '--data-dir', target, '--import-from', source], home, env);
  assert.equal(report.completed, true); assert.equal(report.source_format, 'native'); assert.equal(report.cleanup_warning, undefined);
  assert.equal(existsSync(data), false); assert.deepEqual(dataInventory(target), expected);
  assert.deepEqual(dataInventory(report.source_backup), expected); assert.deepEqual(readFileSync(path.join(target, 'host-state.json')), checkpoint);
  assert.equal(readFileSync(path.join(source, 'unrelated-installation-file'), 'utf8'), 'untouched');
  const reopened = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', target, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try { assert.deepEqual((await reopened.api('/api/state')).session_users, ['Native identity 中文']); }
  finally { await reopened.close(); }
});

test('explicit tool imports after actual startup with a complete native backup and rejects a running Host', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'old runtime'), target = path.join(home, 'new/runtime/data');
  oldData(source); const hostEnv = { ...env }; delete hostEnv.BILIKARA_LIBAV_COMPANION;
  const host = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', target, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try {
    await host.api('/api/session-users/add', { name: 'New user preserved in backup' });
    const failure = await offline(['--import-only', '--replace-native', '--data-dir', target, '--import-from', source], home, env, false);
    assert.match(failure, /owns|lock/i);
  } finally { await host.close(); }
  const checkpoint = readFileSync(path.join(target, 'host-state.json'));
  writeFileSync(path.join(target, 'keep-user-file'), 'preserve this too');
  const report = await offline(['--import-only', '--replace-native', '--data-dir', target, '--import-from', source], home, env);
  assert.equal(report.completed, true); assert.ok(report.backup);
  assert.deepEqual(readFileSync(path.join(report.backup, 'host-state.json')), checkpoint);
  assert.equal(readFileSync(path.join(report.backup, 'keep-user-file'), 'utf8'), 'preserve this too');
  const restored = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', target, '--port', '0', '--headless', '--no-browser'], hostEnv);
  try { assert.deepEqual((await restored.api('/api/state')).session_users, ['小林', 'Alice']); }
  finally { await restored.close(); }
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

test('unified AppData records with mux paths and a backup retain history through native startup and export', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'old AppData 中文 & $()/bilikara');
  const data = path.join(source, 'data'); mkdirSync(data, { recursive: true });
  // The old monolithic writer saved both files. A backup alone is not a
  // split-file layout; only recognized obsolete media fields may be discarded.
  const song = { id: 'state-current', original_url: 'https://example.test/song', resolved_url: 'https://example.test/song',
    bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, title: 'Legacy song', part_title: 'P1', display_title: 'Legacy song',
    cover_url: '', embed_url: '', cache_status: 'ready', cache_progress: 100, cache_message: 'Cached',
    local_relative_path: '../../old-cache.mp4', local_media_url: 'file:///old-cache.mp4' };
  const history = [{ key: 'history-current', display_title: 'Legacy song', original_url: song.original_url,
    resolved_url: song.resolved_url, requested_at: 100, request_count: 3 },
  { key: 'history-previous', display_title: 'Earlier song', original_url: 'https://example.test/earlier',
    resolved_url: 'https://example.test/earlier', requested_at: 90, request_count: 2 }];
  writeFileSync(path.join(data, 'state.json'), JSON.stringify({ playback_mode: 'local', current_item: song,
    playlist: [], history, player_settings: { av_offset_ms: 150, volume_percent: 67 }, updated_at: 101 }));
  writeFileSync(path.join(data, 'playlist_backup.json'), JSON.stringify({ playback_mode: 'local',
    current_item: { ...song, id: 'backup-current' }, playlist: [{ ...song, id: 'backup-queued' }],
    history: [], updated_at: 102 }));
  const originals = ['state.json', 'playlist_backup.json'].map(name => [name, readFileSync(path.join(data, name))]);
  const target = path.join(home, 'new/runtime/data');
  const report = await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env);
  assert.equal(report.completed, true);
  for (const [name, bytes] of originals) assert.deepEqual(readFileSync(path.join(data, name)), bytes);
  const checkpoint = readFileSync(path.join(target, 'host-state.json'));
  const saved = JSON.parse(checkpoint).state;
  assert.equal(saved.current_item.id, 'backup-current'); assert.deepEqual(saved.playlist.map(i => i.id), ['backup-queued']);
  for (const item of [saved.current_item, ...saved.playlist]) {
    assert.equal(item.cache_status, 'pending'); assert.equal(item.video_relative_path, ''); assert.equal(item.video_media_url, '');
    assert.equal('local_relative_path' in item, false); assert.equal('local_media_url' in item, false);
  }
  assert.match(await offline(['--import-only', '--data-dir', target, '--import-from', source], home, env, false), /protected/);
  assert.deepEqual(readFileSync(path.join(target, 'host-state.json')), checkpoint);
  const hostEnv = { ...env }; delete hostEnv.BILIKARA_LIBAV_COMPANION;
  const host = await RunningHost.start(executable, home, ['--static-dir', path.join(root, 'static'), '--data-dir', target,
    '--port', '0', '--headless', '--no-browser'], hostEnv);
  try {
    const state = await host.api('/api/state');
    assert.deepEqual(state.history.map(h => [h.key, h.request_count]), [['history-current', 3], ['history-previous', 2]]);
    assert.equal(state.player_settings.volume_percent, 67);
    assert.equal(state.player_settings.av_offset_ms, 150);
    const response = await host.request('/api/playlist/export?format=csv&source=history');
    assert.equal(response.status, 200); const rows = csvRows(response.body);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.slice(1).map(row => [row[1], row[6]]), [['Earlier song', '2'], ['Legacy song', '3']]);
  } finally { await host.close(); }
});

test('offline mode rejects startup/network flags and unknown targets without overwriting files', async t => {
  const { home, env } = fixture(t), source = path.join(home, 'source'), target = path.join(home, 'data'); oldData(source);
  for (const args of [['--inspect-legacy-import', '--import-only'], ['--inspect-first-start', '--replace-native'], ['--inspect-first-start', '--import-from', source], ['--import-only', '--port', '0'], ['--inspect-legacy-import', '--import-from'], ['--import-only', '--data-dir', 'relative', '--import-from', source]]) {
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
