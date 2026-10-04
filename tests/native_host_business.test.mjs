import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { root, runNative } from './desktop_construction_support.mjs';
import { nativeTarget, suffix } from './desktop_construction_expectations.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { HttpClient, isolatedEnvironment, RunningHost, waitFor } from './native_host_support.mjs';
import { localServer, videoFixture } from './video_service_fixture.mjs';
import { csvRows, zipEntries } from './native_export_support.mjs';

const executable = process.env.BILIKARA_TEST_NATIVE_PACKAGE || process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
assert.ok(path.isAbsolute(executable) && existsSync(executable), 'declared native Host must exist');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function home(t) { const result = mkdtempSync(path.join(tmpdir(), 'native business 中文 $() & ')); t.after(() => rmSync(result, { recursive: true, force: true })); return result; }
const start = (directory, env = isolatedEnvironment(directory), assets = path.join(root, 'static')) => RunningHost.start(executable, directory, ['--headless', '--port', '0', '--data-dir', path.join(directory, 'data'), '--static-dir', assets], env);

test('real roster and fixed queue markers survive previous-session restart with fresh incarnations', { skip: process.platform !== 'linux' && 'local TLS fixture requires Linux native trust', timeout: 60000 }, async t => {
  const directory = home(t), data = path.join(directory, 'data'); mkdirSync(data);
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  for (const [name, value] of Object.entries({ 'native-library-defaults.json': {schema_version: 1}, 'gatcha_uids.json': {schema_version: 2, uids: [], profiles: {}} })) writeFileSync(path.join(data, name), JSON.stringify(value));
  const videos = ['BV1xx411c7mD', 'BV1z84y1p7oS', 'BV1tPC2BEEjq', 'BV1uq4y1a7Zo'];
  const provider = await videoFixture(raw => {
    const route = new URL(raw, 'https://api.bilibili.com');
    if (route.pathname.endsWith('/nav')) return {code: 0, data: {wbi_img: {img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png`}}};
    const bvid = route.searchParams.get('bvid'); assert.ok(videos.includes(bvid));
    return {code: 0, data: {aid: 100 + videos.indexOf(bvid), bvid, title: bvid, owner: {mid: 42, name: 'Fixture'}, pages: [{page: 1, cid: 200 + videos.indexOf(bvid), duration: 90, part: 'on vocal'}]}};
  });
  const environment = {...isolatedEnvironment(directory), ...provider.environment, BILIKARA_CF_API_URL: '', BILIKARA_CATALOG_SHEETS_URL: ''};
  let host;
  try {
    host = await start(directory, environment);
    for (const name of ['A', 'B', 'C']) await host.api('/api/session-users/add', {name});
    for (const [index, name] of ['A', 'A', 'B', 'C'].entries()) await host.api('/api/playlist/add', {url: `https://www.bilibili.com/video/${videos[index]}`, requester_name: name});
    const initial = await host.api('/api/state');
    const a1 = initial.playlist.find(row => row.bvid === videos[1]), c1 = initial.playlist.find(row => row.bvid === videos[3]);
    await host.api('/api/playlist/move-next', {item_id: c1.id});
    await host.api('/api/playlist/reorder', {item_id: a1.id, index: 1, expected_queue_version: (await host.api('/api/state')).queue_version});
    await host.api('/api/session-users/reorder', {name: 'C', index: 0}); await host.api('/api/session-users/remove', {name: 'B'});
    const expected = await host.api('/api/state');
    assert.deepEqual(expected.session_users, ['C', 'A']);
    assert.deepEqual(expected.playlist.map(row => [row.bvid, row.requester_name, row.queue_slot_type]), [[videos[3], 'C', 'priority'], [videos[1], 'A', 'manual'], [videos[2], 'B', 'cycle']]);
    await host.close(); host = await start(directory, environment);
    assert.equal((await host.api('/api/state')).session_flags.startup_choice_pending, true);
    const restored = await host.api('/api/session/startup-choice', {choice: 'continue'});
    assert.equal(restored.session_flags.startup_choice_pending, false);
    assert.deepEqual(restored.session_users, expected.session_users);
    assert.equal(restored.current_item.id, expected.current_item.id);
    assert.notEqual(restored.current_item.item_incarnation_id, expected.current_item.item_incarnation_id);
    assert.deepEqual(restored.playlist.map(row => [row.id, row.requester_name, row.queue_slot_type]), expected.playlist.map(row => [row.id, row.requester_name, row.queue_slot_type]));
    for (const row of restored.playlist) assert.notEqual(row.item_incarnation_id, expected.playlist.find(old => old.id === row.id).item_incarnation_id);
  } finally { if (host) await host.close(); await provider.close(); }
});

test('real add rejects an invalid position without changing the queue or publishing metadata', { skip: process.platform !== 'linux' && 'local TLS fixture requires Linux native trust' }, async t => {
  const directory = home(t), data = path.join(directory, 'data'); mkdirSync(data);
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  writeFileSync(path.join(data, 'gatcha_uids.json'), '{"schema_version":2,"uids":[],"profiles":{}}');
  writeFileSync(path.join(data, 'native-library-defaults.json'), '{"schema_version":1}');
  const provider = await videoFixture(raw => {
    const route = new URL(raw, 'https://api.bilibili.com');
    if (route.pathname.endsWith('/nav')) return { code: 0, data: { wbi_img: { img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png` } } };
    return { code: 0, data: { aid: 123, bvid: 'BV1xx411c7mD', title: 'Position fixture', owner: { mid: 42, name: 'Fixture' }, pages: [{ page: 1, cid: 456, duration: 90, part: 'on vocal' }] } };
  });
  const calls = [], worker = await localServer((request, body) => { calls.push([request.url, body]); return { data: { success: true } }; });
  let host;
  try {
    host = await start(directory, { ...isolatedEnvironment(directory), ...provider.environment, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', BILIKARA_CF_API_URL: worker.base, BILIKARA_CATALOG_SHEETS_URL: '' });
    await host.api('/api/session-users/add', { name: 'Fixture' });
    const body = { url: 'https://www.bilibili.com/video/BV1xx411c7mD', requester_name: 'Fixture', allow_repeat: true };
    const rejected = await host.request('/api/playlist/add', { ...body, position: 'bad' });
    assert.equal(rejected.status, 409); assert.equal(JSON.parse(rejected.body).code, 'invalid_position');
    const state = await host.api('/api/state'); assert.equal(state.current_item, null); assert.deepEqual(state.playlist, []); assert.deepEqual(calls, []);
    for (const position of [undefined, '', 'tail', 'next']) assert.equal((await host.request('/api/playlist/add', { ...body, ...(position === undefined ? {} : { position }) })).status, 200);
    await waitFor(() => calls.length === 4, 'accepted positions must publish exactly four records');
    assert.equal((await host.api('/api/state')).playlist.length, 3);
  } finally { if (host) await host.close(); await provider.close(); await worker.close(); }
});

test('real Host font failure preserves readiness/CSV, recovers image export, and shares prewarm', async t => {
  const directory = home(t), assets = path.join(directory, 'static'); cpSync(path.join(root, 'static'), assets, { recursive: true });
  const font = path.join(assets, 'fonts/SourceHanSans-VF.ttf'); writeFileSync(font, 'invalid-font-fixture');
  let host = await start(directory, undefined, assets);
  try {
    assert.equal((await host.api('/api/state')).cache_policy.download_source, 'native');
    const csv = await host.request('/api/playlist/export?format=csv&source=history&page_size=50'); assert.equal(csv.status, 200); assert.ok(csv.body.length);
    assert.equal((await host.request('/api/playlist/export?format=image&source=history&page_size=50')).status, 503);
    cpSync(path.join(root, 'static/fonts/SourceHanSans-VF.ttf'), font);
    assert.deepEqual((await host.request('/api/playlist/export?format=image&source=history&page_size=50')).body.subarray(0, 8), png);
  } finally { await host.close(); }
  host = await start(directory);
  try { assert.deepEqual((await host.request('/api/playlist/export?format=image&source=history&page_size=50')).body.subarray(0, 8), png); } finally { await host.close(); }
});

test('native tool probe does not hold readiness/diagnostics; selection and restart validate once', async t => {
  const directory = home(t), tool = path.join(directory, `aria2c${suffix}`);
  const compiled = await runNative('rustc', ['--edition=2024', '--target', nativeTarget(), path.join(root, 'tests/fixtures/startup_aria2.rs'), '-o', tool]); assert.equal(compiled.status, 0, compiled.stderr);
  const env = { ...isolatedEnvironment(directory), ARIA2C_PATH: tool }; let host = await start(directory, env);
  try {
    assert.equal((await host.api('/api/state')).cache_policy.download_source, 'native');
    await waitFor(() => existsSync(path.join(directory, 'calls')), 'actual tool probe was not started', 3000);
    assert.ok('markdown' in await host.api('/api/diagnostics/markdown', {})); writeFileSync(path.join(directory, 'release'), '');
    assert.equal((await host.api('/api/cache-downloader/status', { download_source: 'downkyi' })).ready, true);
    await host.api('/api/cache-policy', { download_source: 'downkyi' }); assert.equal((await host.api('/api/state')).cache_policy.download_source, 'downkyi');
    assert.deepEqual(readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n'), ['--version', '--help=#all']);
  } finally { writeFileSync(path.join(directory, 'release'), ''); await host.close(); }
  host = await start(directory, env);
  try { const policy = (await host.api('/api/state')).cache_policy; assert.equal(policy.download_source, 'downkyi'); assert.equal(policy.enabled, true); assert.deepEqual(readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n'), ['--version', '--help=#all', '--version', '--help=#all']); } finally { await host.close(); }
});

test('real administration rejects unauthorized/invalid writes, isolates Remote and supervises monthly jobs', async t => {
  const calls = []; let hold = false, entered = false, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const worker = await localServer(async (request, body) => {
    calls.push([request.url, body, request.headers.authorization]);
    if (request.method === 'GET') { assert.ok(request.url.startsWith('/export?')); assert.equal(request.headers.authorization, 'Bearer fixture-admin'); if (hold) { entered = true; await barrier; } return { data: [] }; }
    if (request.url === '/admin/verify') return { data: { verified: body.BILIKARA_ADMIN_SECRET === 'fixture-admin' } };
    if (request.url === '/admin/review/approve') return { data: { success: true, approved_bvids: body.bvids } };
    if (request.url === '/admin/blacklist/list' && body.query === 'reject-fixture') return { status: 403, data: { error: 'forbidden' } };
    return { data: { success: true, items: [], deleted: true, instance_id: 'fixture-tagger' } };
  });
  const directory = home(t), data = path.join(directory, 'data'); mkdirSync(data);
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n'); writeFileSync(path.join(data, 'gatcha_uids.json'), '{"schema_version":2,"uids":[],"profiles":{}}'); writeFileSync(path.join(data, 'native-library-defaults.json'), '{"schema_version":1}');
  const env = { ...isolatedEnvironment(directory), BILIKARA_CF_API_URL: worker.base, BILIKARA_CATALOG_SHEETS_URL: '' };
  let host;
  try {
    host = await start(directory, env); const snapshot = await host.api('/api/state'); assert.ok(snapshot.capabilities.catalog_write && snapshot.capabilities.maintenance);
    const secret = { BILIKARA_ADMIN_SECRET: 'fixture-admin' };
    for (const body of [{}, { BILIKARA_ADMIN_SECRET: 'wrong' }]) await assert.rejects(host.api('/api/admin-blacklist/list', body), { status: 403 });
    assert.ok(!calls.some(([route]) => route === '/admin/blacklist/list')); assert.equal((await host.api('/api/bilikara-secret/verify', secret)).verified, true);
    for (const bvids of [[], ['invalid']]) await assert.rejects(host.api('/api/admin-review/approve', { ...secret, bvids }), { status: 400 });
    assert.ok(!calls.some(([route]) => route === '/admin/review/approve'));
    const approved = await host.api('/api/admin-review/approve', { ...secret, bvids: ['BV1tPC2BEEjq'] }); assert.deepEqual(approved.approved_bvids, ['BV1tPC2BEEjq']); assert.equal(approved.approved, 1);
    for (const [route, fields] of [['admin-review/pending', {}], ['admin-review/reject', { bvid: 'BV1tPC2BEEjq' }], ['admin-blacklist/list', {}], ['admin-blacklist/restore', { bvid: 'BV1tPC2BEEjq' }], ['admin-tags/reset', { bvid: 'BV1tPC2BEEjq' }], ['admin-video/delete', { bvid: 'BV1tPC2BEEjq' }], ['admin-video/delete-mid', { mid: '123' }]]) await host.api(`/api/${route}`, { ...secret, ...fields });
    assert.equal((await host.request('/api/admin-maintenance/trigger', { ...secret, job: 'tagger-yomi' })).status, 202);
    await assert.rejects(host.api('/api/admin-blacklist/list', { ...secret, query: 'reject-fixture' }), { status: 403 });
    const remote = new HttpClient(host.base); assert.equal((await remote.request(snapshot.remote_access.local_url)).status, 200); assert.equal((await remote.request('/api/admin-blacklist/list', secret)).status, 403);
    hold = true; const response = await host.request('/api/admin-maintenance/trigger', { ...secret, job: 'monthly-d1-refresh' }); assert.equal(response.status, 202); assert.equal(JSON.parse(response.body).data.runner, 'local');
    await waitFor(() => entered, 'monthly job did not reach the local Worker', 5000);
    await assert.rejects(host.api('/api/admin-maintenance/trigger', { ...secret, job: 'monthly-d1-refresh' }), { status: 409 }); release();
    const log = path.join(data, 'logs/monthly-d1-refresh.log'); await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('"completed"'), 'monthly job did not complete', 5000); assert.ok(!readFileSync(log, 'utf8').includes('fixture-admin'));
    await host.api('/api/admin-maintenance/trigger', { ...secret, job: 'monthly-d1-refresh' }); assert.ok(calls.some(([route, , auth]) => route === '/admin/jobs/tagger-yomi' && auth === 'Bearer fixture-admin'));
  } finally { release(); if (host) await host.close(); await worker.close(); }
});

test('v1 storage/preferences migrate losslessly; Host/Remote paginated exports and identity survive restart', { timeout: 120000 }, async t => {
  const directory = home(t), data = path.join(directory, 'data'); mkdirSync(data);
  const entry = { key: 'song', item_id: 'song', display_title: '【卡拉OK】Song - P2', title: 'Song', part_title: 'P2', original_url: '', resolved_url: '', bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 2, played_at: 1, owner_name: 'Fixture owner' };
  const preferences = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`user:User-${i}`, { uid_weight: i % 100 }])); preferences['user:Large'] = { excluded_uids: Array.from({ length: 20000 }, (_, i) => String(10000000 + i)) };
  const seed = { session_started_at: 1, session_played_file: 'played.json', updated_at: 1, session_played: Array.from({ length: 51 }, (_, i) => ({ ...entry, key: `song-${i}` })), history: Array.from({ length: 10001 }, (_, i) => ({ ...Object.fromEntries(['display_title', 'title', 'part_title', 'original_url', 'resolved_url', 'owner_name'].map(k => [k, entry[k]])), key: `history-${i}`, requested_at: 1 })), gatcha_pool_preferences: preferences };
  const original = Buffer.from(JSON.stringify({ schema_version: 1, state: seed })), legacyPool = Buffer.from('{"uid_weight":17,"excluded_uids":["42"]}'); writeFileSync(path.join(data, 'host-state.json'), original); writeFileSync(path.join(data, 'gatcha_pool_config.json'), legacyPool);
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  // The selected loopback must actually exist on the executing OS. macOS does
  // not configure 127.0.0.2 by default; the reservation uses 127.0.0.1 too.
  const env = { ...isolatedEnvironment(directory), BILIKARA_HOST: '127.0.0.1', BILIKARA_PORT: String(port), BILIKARA_MAX_CACHE_ITEMS: '5', BB_DOWN_PATH: path.join(directory, 'missing-bbdown') };
  const launch = () => RunningHost.start(executable, directory, ['--data-dir', data, '--static-dir', path.join(root, 'static')], env);
  let host = await launch(), remote = new HttpClient(host.base), epoch, remoteToken;
  try {
    await remote.request('/remote'); remoteToken = [...remote.cookies.values()][0]; epoch = (await host.api('/api/state')).state_epoch; assert.ok(epoch); assert.equal(new URL(host.base).hostname, env.BILIKARA_HOST); assert.ok(host.base.endsWith(`:${port}`)); assert.equal((await host.api('/api/state')).cache_policy.max_cache_items, 5); assert.equal((await host.api('/api/gatcha/pool-config')).uid_weight, 17);
    await host.api('/api/session/startup-choice', { choice: 'continue' }); assert.equal((await remote.api('/api/remote-identity/register', { name: 'Migration singer' })).name, 'Migration singer'); await host.api('/api/cache-policy', { max_cache_items: 2 });
    for (const source of ['yt-dlp', 'ytdlp']) { const status = await host.api('/api/cache-downloader/status', { download_source: source }); assert.equal(status.enabled, false); assert.equal(status.state, 'disabled'); await assert.rejects(host.api('/api/cache-policy', { download_source: source }), error => error.status === 501 && error.data.code === 'cache_source_unavailable'); }
    for (const client of [host, remote]) for (const [size, mime, extension] of [[100, 'image/png', 'png'], [50, 'application/zip', 'zip']]) { const response = await client.request(`/api/playlist/export?format=image&source=played&page_size=${size}`); assert.equal(response.status, 200); assert.equal(response.headers['content-type'], mime); assert.match(response.headers['content-disposition'], new RegExp(`bilikara-played-\\d{8}-\\d{6}\\.${extension}"$`)); if (extension === 'png') assert.deepEqual(response.body.subarray(0, 8), png); else { const entries = zipEntries(response.body); assert.equal(entries.size, 2); for (const [name, bytes] of entries) { assert.ok(name.endsWith('.png')); assert.deepEqual(bytes.subarray(0, 8), png); } } }
    const rows = csvRows((await host.request('/api/playlist/export?format=csv&source=history')).body); assert.equal(rows.length, 10002); assert.ok(rows[0].includes('播放时间')); assert.ok(rows[1].includes(entry.display_title));
  } finally { await host.close(); }
  assert.deepEqual(readFileSync(path.join(data, 'host-state.v1.backup.json')), original); assert.deepEqual(readFileSync(path.join(data, 'gatcha_pool_config.legacy.backup.json')), legacyPool);
  const manifest = JSON.parse(readFileSync(path.join(data, 'host-state.json'))); assert.equal(manifest.schema_version, 3); const migrated = JSON.parse(Buffer.concat(manifest.records.gatcha_pool_preferences.map(name => readFileSync(path.join(data, 'host-records', name)))));
  for (const [key, value] of Object.entries(preferences)) assert.deepEqual(migrated[key], value); assert.equal(migrated[':default'].uid_weight, 17);
  function privateFiles(directory) { for (const entry of readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) privateFiles(file); else if (entry.isFile()) assert.ok(!readFileSync(file).includes(Buffer.from(remoteToken)), 'Remote token persisted'); } } privateFiles(data);
  host = await launch(); remote.base = host.base;
  try { assert.notEqual((await host.api('/api/state')).state_epoch, epoch); assert.equal((await host.api('/api/state')).cache_policy.max_cache_items, 2); assert.equal((await host.api('/api/gatcha/pool-config')).uid_weight, 17); await remote.request('/remote'); assert.equal((await remote.api('/api/remote-identity')).name, 'Migration singer'); } finally { await host.close(); }
});
