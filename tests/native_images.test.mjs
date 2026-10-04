import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeImages, buildNativeHost } from './native_runtime_artifacts.mjs';
import { RunningHost, HttpClient, isolatedEnvironment } from './native_host_support.mjs';
import { zipEntries, csvRows } from './native_export_support.mjs';

const binary = await buildNativeImages();
const homeFor = t => { const home = mkdtempSync(path.join(root, '.tmp/native images 中文 & ')); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };
async function checked(args, env, cwd) { const result = await runNative(binary, args, env, 90000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /[1-9]\d* passed; 0 failed/); }

test('actual native PNG/QR/export services use independent decoder and strict ABI expectations', async t => {
  const home = homeFor(t); await checked(['--skip', 'local_export_timezone', '--skip', 'configured_font_and_cwd_independence', '--skip', 'isolated_export_file'], isolatedEnvironment(home), home);
});
test('actual export honors OS local time including summer DST and configured copied font from unrelated cwd', async t => {
  const home = homeFor(t), base = isolatedEnvironment(home), font = path.join(home, 'Contents/Resources/static/fonts/SourceHanSans-VF.ttf');
  mkdirSync(path.dirname(font), { recursive: true }); copyFileSync(path.join(root, 'static/fonts/SourceHanSans-VF.ttf'), font);
  await checked(['--ignored', '--exact', 'configured_font_and_cwd_independence'], { ...base, BILIKARA_TEST_EXPORT_FONT: font }, home);
  const timestamp = new Date(1718000000 * 1000), pad = n => String(n).padStart(2, '0');
  const local = `${timestamp.getFullYear()}-${pad(timestamp.getMonth()+1)}-${pad(timestamp.getDate())} ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
  const cases = process.platform === 'win32' ? [[undefined, local]] : [['Asia/Tokyo', '2024-06-10 15:13:20'], ['America/New_York', '2024-06-10 02:13:20']];
  for (const [zone, expected] of cases) await checked(['--ignored', '--exact', 'local_export_timezone'], { ...base, ...(zone === undefined ? {} : { TZ: zone }), BILIKARA_TEST_EXPORT_TIME: expected }, home);
});

test('real Host and Remote image/history aliases and specific archived sessions remain isolated after restart', { timeout: 120000 }, async t => {
  const home = homeFor(t), legacy = path.join(home, 'legacy'), legacyData = path.join(legacy, 'data'), data = path.join(home, 'native');
  mkdirSync(path.join(legacyData, 'played_sessions'), { recursive: true });
  const row = (title, i) => ({ key: `${title}-${i}`, item_id: `${title}-${i}`, title: `${title} ${i}`, display_title: `${title} ${i}`, bvid: 'BV1xx411c7mD', aid: 1, cid: 2, page: 1, part_title: '', original_url: '', resolved_url: '', requester_name: 'Synthetic singer', played_at: 1718000000+i });
  const history = Array.from({ length: 81 }, (_, i) => ({ key:`history-${i}`, title: `History only ${i}`, display_title:`History only ${i}`, original_url:'', resolved_url:'', requested_at:1718000000+i }));
  const sessions = [['played-2024-06-10_00-00.json', 'Earlier only', 3], ['played-2024-06-11_00-00.json', 'Selected only', 1]];
  for (const [file, title, count] of sessions) writeFileSync(path.join(legacyData, 'played_sessions', file), JSON.stringify({ session_started_at: 1718000000, items: Array.from({ length: count }, (_, i) => row(title, i)) }));
  writeFileSync(path.join(legacyData, 'history.json'), JSON.stringify({ history }));
  writeFileSync(path.join(legacyData, 'played_sessions/played-2024-06-12_00-00.json'), JSON.stringify({ session_started_at:1718000300, items:[row('Current only',0)] }));
  writeFileSync(path.join(legacyData, 'playlist_backup.json'), JSON.stringify({ current_item: null, playlist: [], played_session: { file: 'played-2024-06-12_00-00.json', session_started_at:1718000300 }, updated_at:1718000400 }));
  const originals = new Map(sessions.map(([name]) => [name, readFileSync(path.join(legacyData, 'played_sessions', name))]));
  const executable = await buildNativeHost();
  let host;
  const decode = async (bytes, count) => { const file = path.join(home, 'actual image 中文.png'); writeFileSync(file, bytes); await checked(['--ignored', '--exact', 'isolated_export_file'], { ...isolatedEnvironment(home), BILIKARA_TEST_EXPORT_FILE: file, BILIKARA_TEST_EXPORT_ROWS: String(count) }, home); };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      host = await RunningHost.start(executable, home, ['--headless', '--no-browser', '--port', '0', '--import-from', legacy, '--data-dir', data, '--static-dir', path.join(root, 'static')]);
      await host.api('/api/session/startup-choice', { choice: 'continue' });
      const remote = new HttpClient(host.base); await remote.request('/remote');
      assert.equal((await remote.request('/api/playlist/export?format=image&source=history&page_size=80')).status, 403, 'unregistered Remote must pass its identity gate');
      await remote.api('/api/remote-identity/register', { name: `Export singer ${attempt}` });
      for (const client of [host, remote]) {
        for (const route of ['/api/playlist/export', '/api/history/export']) {
          const png = await client.request(`${route}?format=image&source=${sessions[1][0]}&page_size=80`); assert.equal(png.status, 200); assert.equal(png.headers['content-type'], 'image/png'); await decode(png.body, 1);
          const selected = await client.request(`${route}?format=csv&source=${sessions[1][0]}`); assert.equal(selected.status, 200); const csv = csvRows(selected.body); assert.equal(csv.length, 2); assert.ok(csv[1][1].startsWith('Selected only')); assert.ok(!selected.body.toString().includes('Earlier only')); assert.ok(!selected.body.toString().includes('History only'));
        }
        const zip = await client.request('/api/history/export?format=image&source=history&page_size=80'); assert.equal(zip.status, 200); assert.equal(zip.headers['content-type'], 'application/zip'); assert.match(zip.headers['content-disposition'], /bilikara-history-\d{8}-\d{6}\.zip"$/);
        const pages = [...zipEntries(zip.body)]; assert.equal(pages.length, 2); for (let index = 0; index < 2; index++) { assert.equal(pages[index][0], `bilikara-playlist-page-0${index+1}.png`); await decode(pages[index][1], index===0?80:1); }
        assert.equal((await client.request('/api/playlist/export?format=image&source=played-absent.json')).status, 404);
        assert.equal((await client.request('/api/playlist/export?format=image&source=../escape.json')).status, 400);
      }
      await host.close(); host = undefined;
    }
    for (const [name, bytes] of originals) assert.deepEqual(readFileSync(path.join(legacyData, 'played_sessions', name)), bytes);
  } finally { if (host) await host.close(); }
});
