import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, runNative, digest } from './desktop_construction_support.mjs';
import { nativeTarget, suffix } from './desktop_construction_expectations.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { isolatedEnvironment, RunningHost, waitFor } from './native_host_support.mjs';
import { videoFixture } from './video_service_fixture.mjs';
import { csvRows, zipEntries } from './native_export_support.mjs';

const executable = process.env.BILIKARA_TEST_NATIVE_PACKAGE || process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
assert.ok(path.isAbsolute(executable) && existsSync(executable), 'declared native Host must exist');
function home(t) { const directory = mkdtempSync(path.join(tmpdir(), 'native recheck 中文 $() & ')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
function start(directory, env, ...args) { return RunningHost.start(executable, directory, ['--headless', '--port', '0', '--data-dir', path.join(directory, 'data'), '--static-dir', path.join(root, 'static'), ...args], env); }
const linuxOnly = process.platform !== 'linux' ? 'local TLS trust fixture requires native Linux' : false;

test('real BBDown Dolby-only cache preserves independent ordered requested audio pages', { skip: linuxOnly, timeout: 120000 }, async t => {
  assert.ok(process.env.BILIKARA_TEST_LIBAV_COMPANION && existsSync(process.env.BILIKARA_TEST_LIBAV_COMPANION), 'required real native media companion is missing');
  const directory = home(t), control = path.join(directory, 'child'); mkdirSync(control); writeFileSync(path.join(control, 'mode'), 'dolby');
  const binary = path.join(directory, `BBDown${suffix}`), compiled = await runNative('rustc', ['--edition=2024', '--target', nativeTarget(), path.join(root, 'tests/bbdown_fixture.rs'), '-o', binary]); assert.equal(compiled.status, 0, compiled.stderr);
  const provider = await videoFixture(target => {
    const url = new URL(target, 'https://api.bilibili.com');
    if (url.pathname === '/x/web-interface/wbi/view') return { code: 0, data: { aid: 123, bvid: 'BV1xx411c7mD', title: 'Fixture', owner: { mid: 42, name: 'Fixture' }, pages: [{ page: 1, cid: 457, duration: 999, part: 'original' }, { page: 2, cid: 458, duration: 500, part: '' }] } };
    if (url.pathname.endsWith('/nav')) return { code: 0, data: { wbi_img: { img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png` } } };
    if (url.pathname === '/x/player/wbi/playurl') return { code: 0, data: { dash: { video: [{ id: 64, codecid: 7, baseUrl: 'https://api.bilibili.com/video.mp4', bandwidth: 10 }], audio: [], flac: null, dolby: { audio: [{ id: 30250, baseUrl: 'https://api.bilibili.com/audio-eac3.m4a' }] } } } };
    return { code: 0, data: {} };
  });
  let host;
  try {
    host = await start(directory, { ...isolatedEnvironment(directory), ...provider.environment, BILIKARA_CF_API_URL: '', BILIKARA_CATALOG_SHEETS_URL: '', BB_DOWN_PATH: binary, BILIKARA_BBDOWN_FIXTURE_ROOT: control, BILIKARA_BBDOWN_MEDIA: path.join(root, 'tests/fixtures/bbdown'), BILIKARA_BBDOWN_EXPECT_COOKIE: ';' });
    await host.api('/api/session-users/add', { name: 'Fixture' }); await host.api('/api/cache-policy', { download_source: 'bbdown', audio_hires: true });
    for (const [selected, page, label] of [[[2], 2, 'P2'], [[2, 1], 1, 'original']]) {
      const state = await host.api('/api/playlist/add', { url: 'https://www.bilibili.com/video/BV1xx411c7mD', requester_name: 'Fixture', selected_video_page: 1, selected_audio_pages: selected, allow_repeat: true }), id = (state.playlist.length ? state.playlist : [state.current_item]).at(-1).id;
      const item = await waitFor(async () => { const state = await host.api('/api/state'), item = [state.current_item, ...state.playlist].find(v => v && v.id === id); return ['ready', 'failed'].includes(item.cache_status) ? item : undefined; }, 'cache publication deadline', 25000);
      assert.equal(item.cache_status, 'ready', item.cache_message); assert.equal(item.video_page, 1); assert.deepEqual(item.audio_variants.map(v => v.page), selected); const chosen = item.audio_variants.find(v => v.id === item.selected_audio_variant_id); assert.equal(chosen.page, page); assert.equal(chosen.label, label); assert.ok(item.cache_message.includes(String(selected.length)));
    }
  } finally { if (host) await host.close(); await provider.close(); }
});

test('real >32MiB legacy history and 1001 archives import and reopen without loss or source mutation', { timeout: 120000 }, async t => {
  const directory = home(t), source = path.join(directory, 'legacy'), data = path.join(source, 'data'), archives = path.join(data, 'played_sessions'); mkdirSync(archives, { recursive: true });
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(archives, `played-${i}.json`), JSON.stringify({ session_started_at: i + 1, items: [] }));
  const entry = { display_title: 'x'.repeat(4096), title: 'Song', part_title: 'P1', original_url: '', resolved_url: '', requested_at: 1 }, history = path.join(data, 'history.json'); writeFileSync(history, JSON.stringify({ history: Array.from({ length: 9000 }, (_, i) => ({ ...entry, key: `song-${i}` })) })); assert.ok(statSync(history).size > 32 * 1024 * 1024); const before = digest(readFileSync(history));
  for (let n = 0; n < 2; n++) { const host = await start(directory, isolatedEnvironment(directory), '--import-from', source); try { assert.equal((await host.api('/api/played-sessions')).length, 1001); const response = await host.request('/api/playlist/export?format=csv&source=history'); assert.equal(response.status, 200); const rows = csvRows(response.body); assert.equal(rows.length, 9001); assert.ok(rows.at(-1).includes('x'.repeat(4096))); } finally { await host.close(); } }
  assert.equal(digest(readFileSync(history)), before); assert.equal(readdirSync(archives).filter(name => name.endsWith('.json')).length, 1001); assert.equal(JSON.parse(readFileSync(path.join(directory, 'data/host-state.json'))).schema_version, 3);
});

test('real diagnostic archive redacts system/home names without login environment', { skip: process.platform === 'win32' ? 'Unix account lookup boundary' : false }, async t => {
  const directory = home(t), env = isolatedEnvironment(directory), account = userInfo(); for (const key of ['USER', 'USERNAME', 'LOGNAME']) delete env[key]; const host = await start(directory, env);
  try { const log = path.join(directory, 'data/logs/host.log'); mkdirSync(path.dirname(log), { recursive: true }); const sentinels = [`/home/${account.username}/Documents/private.json`, `${account.homedir}/Documents/private.json`, `${directory}/private.json`]; writeFileSync(log, sentinels.join('\n')); const response = await host.request('/api/diagnostics/package', {}); assert.equal(response.status, 200); const redacted = zipEntries(response.body).get('logs/host.log').toString(); for (const value of sentinels) assert.ok(!redacted.includes(value)); assert.ok(redacted.includes('private.json')); } finally { await host.close(); }
});

for (const cooldown of [false, true]) test(cooldown ? 'cookie switch retains latest intent through real manual cooldown' : 'account switch cancels obsolete commit and runs latest login after busy', { skip: linuxOnly, timeout: 150000 }, async t => {
  const directory = home(t), certs = path.join(directory, 'certs'); mkdirSync(certs);
  async function openssl(...args) { const result = await runNative('openssl', args); assert.equal(result.status, 0, result.stderr); }
  await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Bilikara isolated test CA', '-keyout', path.join(certs, 'ca-key.pem'), '-out', path.join(certs, 'ca.pem'));
  await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.bilibili.com', '-keyout', path.join(certs, 'key.pem'), '-out', path.join(certs, 'leaf.csr'));
  const extensions = path.join(certs, 'extensions'); writeFileSync(extensions, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.bilibili.com,DNS:passport.bilibili.com\n');
  await openssl('x509', '-req', '-days', '2', '-in', path.join(certs, 'leaf.csr'), '-CA', path.join(certs, 'ca.pem'), '-CAkey', path.join(certs, 'ca-key.pem'), '-CAcreateserial', '-extfile', extensions, '-out', path.join(certs, 'cert.pem'));
  const data = path.join(directory, 'data'); mkdirSync(data);
  for (const [name, value] of Object.entries({ 'native-library-defaults.json': { schema_version: 1 }, 'gatcha_uids.json': { schema_version: 2, uids: ['1'], profiles: { '1': { uid: '1', name: 'Fixture', space_url: 'https://space.bilibili.com/1' } } }, 'gatcha_cache.json': { schema_version: 3, uids: {}, profiles: {} }, 'gatcha_favlist.json': { schema_version: 2, folders: [], items: [] } })) writeFileSync(path.join(data, name), JSON.stringify(value));
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n'); writeFileSync(path.join(data, 'BBDown.data'), 'DedeUserID=1; SESSDATA=account_a; bili_jct=account_a');
  const cookies = [], entered = { a: false, b: false, c: false }, release = {}, barriers = Object.fromEntries(['a', 'b', 'c'].map(k => [k, new Promise(resolve => { release[k] = resolve; })]));
  const provider = await videoFixture(async (target, headers) => {
    const url = new URL(target, 'https://api.bilibili.com');
    if (url.pathname.endsWith('/nav')) return { code: 0, data: { isLogin: true, wbi_img: { img_url: `https://example.invalid/${'a'.repeat(32)}.png`, sub_url: `https://example.invalid/${'b'.repeat(32)}.png` } } };
    if (url.pathname.endsWith('/acc/info')) return { code: 0, data: { mid: url.searchParams.get('mid') || '1', name: 'Fixture', face: '' } };
    if (url.pathname.endsWith('/arc/search')) { const cookie = headers.cookie || ''; cookies.push(cookie); const account = ['a', 'b', 'c'].find(k => cookie.includes(`account_${k}`)); assert.ok(account); entered[account] = true; let timer; try { await Promise.race([barriers[account], new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture release deadline')), 20000); })]); } finally { clearTimeout(timer); } return { code: 0, data: { list: { vlist: [{ bvid: `BV1xx411c7m${{ a: 'D', b: 'E', c: 'F' }[account]}`, title: `karaoke account ${account.toUpperCase()}`, author: 'Fixture' }] } } }; }
    if (url.pathname.endsWith('/generate')) return { code: 0, data: { url: 'https://passport.bilibili.com/scan?token=fixture', qrcode_key: 'fixture' } };
    if (url.pathname.endsWith('/poll')) return { fixtureResponse: { data: { code: 0, data: { code: 0 } }, headers: { 'Set-Cookie': ['DedeUserID=2', 'SESSDATA=account_b', 'bili_jct=account_b'].map(v => `${v}; Domain=.bilibili.com; Path=/; Secure`) } } };
    return { code: 0, data: {} };
  }, certs);
  let host;
  try {
    host = await start(directory, { ...isolatedEnvironment(directory), ...provider.environment, BILIKARA_CF_API_URL: '', BILIKARA_CATALOG_SHEETS_URL: '' }); await waitFor(() => entered.a, 'account A did not start', 10000);
    const state = () => host.api('/api/state'); const cache = () => JSON.parse(readFileSync(path.join(data, 'gatcha_cache.json')));
    if (cooldown) { release.a(); await waitFor(async () => !(await state()).gatcha.background_busy, 'initial login did not finish'); assert.equal((await host.api('/api/gatcha/refresh', {})).started, true); await waitFor(async () => cookies.length === 2 && !(await state()).gatcha.background_busy, 'manual refresh did not finish'); }
    await host.api('/api/bbdown/logout', {}); await host.api('/api/bbdown/login/start', { force: true }); await waitFor(() => existsSync(path.join(data, 'BBDown.data')) && readFileSync(path.join(data, 'BBDown.data'), 'utf8').includes('account_b'), 'login B did not persist'); release.a(); await waitFor(() => entered.b, 'new account refresh was dropped', 10000);
    if (cooldown) {
      assert.equal((await host.api('/api/config/cookie', { sessdata: 'account_c', bili_jct: 'account_c' })).message, '配置已实时生效'); release.b(); await waitFor(async () => !(await state()).gatcha.background_busy, 'obsolete B did not retire'); await delay(300); assert.equal(entered.c, false, 'cookie config bypassed manual cooldown');
      await assert.rejects(host.api('/api/gatcha/refresh', {}), error => error.data.code === 'library_cooldown'); await waitFor(() => entered.c, 'C intent lost during real cooldown', 75000); assert.equal(cache().uids['1'][0].title, 'karaoke account A'); release.c(); await waitFor(async () => (await state()).gatcha.last_status === 'success', 'C did not publish'); assert.deepEqual(new Set(cache().uids['1'].map(item => item.title)), new Set(['karaoke account A', 'karaoke account C'])); assert.equal(cookies.length, 4); for (const [i, account] of [...'aabc'].entries()) assert.ok(cookies[i].includes(`account_${account}`)); await assert.rejects(host.api('/api/gatcha/refresh', {}), error => error.data.code === 'library_cooldown');
    } else { assert.deepEqual(cache().uids['1'] || [], []); release.b(); await waitFor(async () => (await state()).gatcha.last_status === 'success', 'B did not publish'); assert.equal(cache().uids['1'][0].title, 'karaoke account B'); assert.equal(cookies.length, 2); assert.ok(cookies[0].includes('account_a') && cookies[1].includes('account_b')); }
  } finally { for (const resolve of Object.values(release)) resolve(); if (host) await host.close(); await provider.close(); }
});
