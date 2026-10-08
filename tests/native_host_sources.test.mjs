import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { isolatedEnvironment, RunningHost, waitFor } from './native_host_support.mjs';
import { videoFixture } from './video_service_fixture.mjs';

const executable = process.env.BILIKARA_TEST_NATIVE_PACKAGE || process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
assert.ok(path.isAbsolute(executable) && existsSync(executable), 'declared native Host must exist');
function seed() {
  const home = mkdtempSync(path.join(tmpdir(), 'native sources 中文 $() & ')), data = path.join(home, 'data'); mkdirSync(data);
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  for (const [name, value] of Object.entries({ 'native-library-defaults.json': { schema_version: 1 }, 'gatcha_uids.json': { schema_version: 2, uids: [], profiles: {} }, 'gatcha_cache.json': { schema_version: 3, uids: {}, profiles: {} }, 'gatcha_favlist.json': { schema_version: 2, folders: [], items: [] } })) writeFileSync(path.join(data, name), JSON.stringify(value));
  return { home, data };
}
const nav = { code: 0, data: { isLogin: true, wbi_img: { img_url: `https://i0.hdslb.com/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${'b'.repeat(32)}.png` } } };
async function idle(host) { return waitFor(async () => { const state = await host.api('/api/state'), queue = state.gatcha.source_queue; return !state.gatcha.background_busy && !queue.pending.length && !queue.active ? state : undefined; }, 'native source queue did not finish'); }
function publicPeer(host, peer = 'fixture-peer') {
  const epoch = 'abcdefghijklmnopqrstuv'; let seq = 0;
  return { async open(profile = 'controller') { await host.api('/api/internet-remote/peer/open', { peer_id: peer, epoch, profile }); }, async dispatch(kind, body) { const result = await host.api('/api/internet-remote/dispatch', { peer_id: peer, lane: 'control', message: JSON.stringify({ v: 1, lane: 'control', epoch, seq: ++seq, id: randomUUID(), kind, body }) }); assert.ok(!('_host_effect' in result)); assert.ok(!('entries' in (result.data || {}))); return result.data; } };
}

test('startup refresh overlaps foreground UP/favorites, shares a source and preserves both cache commits', { skip: process.platform !== 'linux' ? 'local TLS trust fixture requires native Linux' : false, timeout: 60000 }, async () => {
  const {home, data} = seed(); let host, backgroundEntered = false, releaseBackground;
  const background = new Promise(resolve => {releaseBackground = resolve;});
  writeFileSync(path.join(data, 'gatcha_uids.json'), JSON.stringify({schema_version:2,uids:['11'],profiles:{'11':{uid:'11',name:'Background',space_url:'https://space.bilibili.com/11'}}}));
  writeFileSync(path.join(data, 'BBDown.data'), 'SESSDATA=fixture; bili_jct=fixture', {mode:0o600});
  const fetched = [];
  const provider = await videoFixture(async target => {
    const url = new URL(target, 'https://api.bilibili.com'), uid = url.searchParams.get('mid');
    if(url.pathname.endsWith('/nav')) return nav;
    if(url.pathname.endsWith('/acc/info')) return {code:0,data:{mid:Number(uid),name:`UP ${uid}`,face:''}};
    if(url.pathname.endsWith('/arc/search')) {
      fetched.push(uid);
      if(uid==='11') {backgroundEntered=true; await background;}
      return {code:0,data:{list:{vlist:[{bvid:`BVTEST0000${uid}`,title:`karaoke ${uid}`,author:`UP ${uid}`,length:'1:30'}]}}};
    }
    if(url.pathname.endsWith('/list-all')) return {code:0,data:{list:[{id:456,title:'karaoke favorites',attr:0,media_count:1}]}};
    if(url.pathname.endsWith('/resource/list')) return {code:0,data:{medias:[{bvid:'BVFAV0000456',title:'Favorite',duration:90,upper:{mid:22,name:'UP 22'}}],has_more:false}};
    assert.fail(`unexpected overlap route ${url.pathname}`);
  });
  try {
    host = await RunningHost.start(executable,home,['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')],{...isolatedEnvironment(home),...provider.environment,BILIKARA_CF_API_URL:provider.base});
    await waitFor(()=>backgroundEntered,'startup source did not enter',5000);
    await host.api('/api/gatcha/uids/add',{uid:'22',queue:true});
    await waitFor(async()=> (await host.api('/api/gatcha/browse?uid=22')).items.length===1,'manual UP waited behind the whole startup batch',5000);
    const peer=publicPeer(host,'parallel-source-peer'); await peer.open(); await peer.dispatch('session.set_identity',{name:'Concurrent user'});
    await peer.dispatch('gatcha.favlist_refresh',{uid:'22',folder_ids:['456']});
    await waitFor(()=>JSON.parse(readFileSync(path.join(data,'gatcha_favlist.json'))).items.length===1,'public favorites waited behind startup',5000);
    let state=await host.api('/api/state');
    assert.equal(state.gatcha.background_busy,true);
    assert.equal(state.gatcha.last_result.rebuild.current_uid,'11','foreground completion hid background progress');
    await assert.rejects(host.api('/api/gatcha/refresh',{}),{status:409});
    await assert.rejects(host.api('/api/gatcha/source/remove',{source:'uid',id:'22'}),{status:409});
    await host.api('/api/gatcha/uids/add',{uid:'11',queue:true});
    await waitFor(async()=> (await host.api('/api/state')).gatcha.source_queue.active?.uid==='11','same-source follower was not admitted',5000);
    releaseBackground(); state=await idle(host);
    assert.deepEqual(fetched,['11','22'],'same startup/manual source was fetched twice');
    const saved=JSON.parse(readFileSync(path.join(data,'gatcha_cache.json')));
    assert.equal(saved.uids['11'][0].bvid,'BVTEST000011'); assert.equal(saved.uids['22'][0].bvid,'BVTEST000022');
    await waitFor(()=>provider.posts.flatMap(([,body])=>body.records||[]).length>=3,'missing independent source deltas',5000);
    const rows=provider.posts.flatMap(([,body])=>body.records||[]);
    for(const bvid of ['BVTEST000011','BVTEST000022','BVFAV0000456']) assert.equal(rows.filter(row=>row.bvid===bvid).length,1,'a reused source appended twice');
    assert.equal((await host.api('/api/gatcha/refresh',{})).started,true,'startup consumed manual cooldown'); await idle(host);
    await assert.rejects(host.api('/api/gatcha/refresh',{}),{status:429});
  } finally {releaseBackground(); if(host)await host.close(); await provider.close(); rmSync(home,{recursive:true,force:true});}
});

test('real UID/favorites preview and explicit selection preserve independent cached metadata and public folder boundaries', {skip:process.platform!=='linux'?'verified Linux local TLS fixture':false,timeout:60000},async()=>{
  const {home,data}=seed();let host;
  const profile={uid:'42',name:'example-up',space_url:'https://space.bilibili.com/42',avatar_url:'https://example.com/avatar.jpg'};
  writeFileSync(path.join(data,'gatcha_uids.json'),JSON.stringify({schema_version:2,uids:['42'],profiles:{'42':profile}}));
  writeFileSync(path.join(data,'gatcha_cache.json'),JSON.stringify({schema_version:3,uids:{'42':[{mid:'42',bvid:'BVOLD0000001',title:'old karaoke',url:'https://www.bilibili.com/video/BVOLD0000001'}]},profiles:{'42':profile}}));
  writeFileSync(path.join(data,'BBDown.data'),'SESSDATA=owned-preview; bili_jct=owned-preview',{mode:0o600});
  const folders=[{id:100,fid:10,title:'🎤 卡拉收藏',attr:0,media_count:2},{id:200,fid:20,title:'普通收藏',attr:0,media_count:1},{id:300,fid:30,title:'K private',attr:1,media_count:1}];
  const provider=await videoFixture(target=>{
    const url=new URL(target,'https://api.bilibili.com');
    if(url.pathname.endsWith('/nav'))return nav;
    if(url.pathname.endsWith('/acc/info'))return {code:0,data:{mid:42,name:'example-up',face:'https://example.com/avatar.jpg'}};
    if(url.pathname.endsWith('/arc/search'))return {code:0,data:{list:{vlist:[{bvid:'BVOLD0000001',title:'old karaoke',author:'example-up'}]}}};
    if(url.pathname.endsWith('/list-all'))return {code:0,data:{list:folders}};
    if(url.pathname.endsWith('/resource/list')){
      assert.equal(url.searchParams.get('media_id'),'200','only explicitly selected public ordinary-title folder is fetched');
      return {code:0,data:{info:{media_count:1},medias:[{bvid:'BVFAV0000200',title:'explicit selection',cover:'https://example.com/fav-cover.jpg',cnt_info:{play:42},duration:3661,upper:{mid:9,name:'fav-up'}},{bvid:'BVFAV0000200',title:'duplicate',upper:{mid:9}}],has_more:false}};
    }
    assert.fail('unexpected isolated preview route '+url.pathname);
  });
  try{
    host=await RunningHost.start(executable,home,['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')],{...isolatedEnvironment(home),...provider.environment,BILIKARA_CF_API_URL:provider.base});await idle(host);
    const uid=await host.api('/api/gatcha/uids/preview',{uid:'https://space.bilibili.com/42'});
    assert.equal(uid.uid,'42');assert.equal(uid.name,'example-up');assert.equal(uid.avatar_url,profile.avatar_url);assert.equal(uid.already_followed,true);assert.equal(uid.cache_mode,'incremental');assert.equal(uid.cache_mode_label,'最新');
    const preview=await host.api('/api/gatcha/favlist/preview',{uid:'42'});
    assert.equal(preview.folder_count,3);assert.equal(preview.public_folder_count,2);assert.deepEqual(preview.folders.map(folder=>folder.id),['100','200']);assert.deepEqual(preview.selected_folder_ids,['100']);assert.equal(preview.folders[1].selected,false);
    const refreshed=await host.api('/api/gatcha/favlist',{uid:'42',folder_ids:['200']});assert.equal(refreshed.folder_count,3);assert.equal(refreshed.matched_folder_count,1);assert.equal(refreshed.item_count,1);assert.equal('entries' in refreshed,false);await idle(host);
    const saved=JSON.parse(readFileSync(path.join(data,'gatcha_favlist.json')));
    assert.deepEqual(saved.folders.map(folder=>[folder.uid,folder.id,folder.title]),[['42','200','普通收藏']]);assert.equal(saved.items.length,1);assert.equal(saved.items[0].bvid,'BVFAV0000200');assert.equal(saved.items[0].cover_url,'https://example.com/fav-cover.jpg');assert.equal(saved.items[0].played_count,'42');assert.equal(saved.items[0].preserved_1,'3661');
    assert.ok(!provider.requests.some(target=>new URL(target,provider.base).searchParams.get('media_id')==='300'));
  }finally{if(host)await host.close();await provider.close();rmSync(home,{recursive:true,force:true});}
});

test('real cookie/append/review/cooldown/public Remote source flows preserve independent preferences', { skip: process.platform !== 'linux' ? 'local TLS trust fixture requires native Linux' : false, timeout: 300000 }, async () => {
  const { home, data } = seed(), videos = [{ bvid: 'BV1xx411c7mD', title: 'karaoke first', author: 'fixture', pic: '', length: '1:30' }];
  const provider = await videoFixture(target => {
    const url = new URL(target, 'https://api.bilibili.com'), uid = url.searchParams.get('mid') || '123';
    if (url.pathname.endsWith('/nav')) return nav;
    if (url.pathname.endsWith('/acc/info')) return { code: 0, data: { mid: uid, name: 'fixture', face: '' } };
    if (url.pathname.endsWith('/arc/search')) return { code: 0, data: { list: { vlist: videos } } };
    if (url.pathname.endsWith('/list-all')) return { code: 0, data: { list: [{ id: 456, title: 'karaoke favorites', media_count: 1 }] } };
    if (url.pathname.endsWith('/resource/list')) return { code: 0, data: { medias: [{ bvid: 'BV1yy411c7mD', title: 'karaoke favorite', duration: 90, upper: { mid: 123, name: 'fixture' } }], has_more: false } };
    assert.fail(`unexpected local provider request ${url.pathname}`);
  });
  let host;
  try {
    host = await RunningHost.start(executable, home, ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')], { ...isolatedEnvironment(home), ...provider.environment, BILIKARA_CF_API_URL: provider.base });
    for (const body of [{}, { sessdata: 'fixture' }, { bili_jct: 'fixture' }, { sessdata: 'a\nb', bili_jct: 'fixture' }]) await assert.rejects(host.api('/api/config/cookie', body), { status: 400 });
    const configured = JSON.parse((await host.request('/api/config/cookie', { sessdata: 'fixture', bili_jct: 'fixture' })).body); assert.equal(configured.message, '配置已实时生效'); assert.equal(configured.data.message, configured.message); await idle(host); assert.equal(existsSync(path.join(data, 'BBDown.data')), false); assert.deepEqual(provider.posts, []);
    const records = (count, required) => waitFor(() => { const rows = provider.posts.flatMap(([, body]) => body.records || []); return rows.length >= count && (!required || rows.some(row => row.bvid === required)) ? rows : undefined; }, 'missing local review candidates', 5000);
    const refresh = async request => { const deadline = performance.now() + 75000; while (true) { try { const result = await request(); assert.equal(result.started, true); return await idle(host); } catch (error) { assert.equal(error.status, 429); assert.equal(error.data.code, 'library_cooldown'); assert.ok(performance.now() < deadline, 'refresh did not admit after real cooldown'); await delay(1000); } } };
    assert.ok(!('entries' in await host.api('/api/gatcha/uids/add', { uid: '123' }))); assert.equal((await records(1))[0].bvid, videos[0].bvid);
    videos.unshift({ ...videos[0], bvid: 'BV1zz411c7mD', title: 'karaoke new' }); await refresh(() => host.api('/api/gatcha/refresh', {})); assert.deepEqual((await records(2)).map(row => row.bvid), ['BV1xx411c7mD', 'BV1zz411c7mD']);
    await refresh(() => host.api('/api/gatcha/refresh', {})); assert.equal((await records(2)).length, 2, 'unchanged refresh resubmitted review candidates');
    const peer = publicPeer(host); await peer.open(); await peer.dispatch('session.set_identity', { name: 'source fixture' });
    const fields = ['uid_weight', 'favlist_weight', 'excluded_uids', 'excluded_favlist_folders'], preferences = value => Object.fromEntries(fields.map(key => [key, value[key]])), original = preferences(await host.api('/api/gatcha/pool-config'));
    for (const [kind, body] of [['gatcha.pool_config_set', { uid_weight: 60, favlist_weight: 40, excluded_uids: [], excluded_favlist_folders: [] }], ['gatcha.uid_preview', { uid: '123' }], ['gatcha.uid_add', { uid: '123' }], ['gatcha.favlist_preview', { uid: '123' }], ['gatcha.favlist_refresh', { uid: '123', folder_ids: ['456'] }], ['gatcha.refresh', {}]]) { if (kind === 'gatcha.refresh') await refresh(() => peer.dispatch(kind, body)); else await peer.dispatch(kind, body); await idle(host); }
    assert.ok((await records(3, 'BV1yy411c7mD')).some(row => row.bvid === 'BV1yy411c7mD')); assert.equal((await peer.dispatch('gatcha.pool_config_get', {})).uid_weight, 60); assert.deepEqual(preferences(await host.api('/api/gatcha/pool-config')), original);
    await host.api('/api/config/cookie', {}); assert.equal(existsSync(path.join(data, 'BBDown.data')), false); const viewer = publicPeer(host, 'viewer'); await viewer.open('viewer'); await assert.rejects(viewer.dispatch('gatcha.uid_add', { uid: '123' }));
  } finally { if (host) await host.close(); await provider.close(); rmSync(home, { recursive: true, force: true }); }
});

test('busy manual/public additions deduplicate, preserve queue titles/order and continue after retries fail', { skip: process.platform !== 'linux' ? 'local TLS trust fixture requires native Linux' : false, timeout: 60000 }, async () => {
  const { home, data } = seed(), fetched = []; let entered = false, release; const barrier = new Promise(resolve => { release = resolve; });
  const provider = await videoFixture(async target => {
    const url = new URL(target, 'https://api.bilibili.com'), uid = url.searchParams.get('mid') || '123';
    if (url.pathname.endsWith('/nav')) return nav;
    if (url.pathname.endsWith('/acc/info')) return { code: 0, data: { mid: Number(uid), name: `UP ${uid}`, face: '' } };
    if (url.pathname.endsWith('/arc/search')) { fetched.push(uid); if (uid === '111') { entered = true; await barrier; } if (uid === '999') return { code: -403, message: 'fixture failed' }; return { code: 0, data: { list: { vlist: [{ bvid: 'BV1xx411c7mD', title: `karaoke ${uid}`, author: `UP ${uid}`, length: '1:30' }] } } }; }
    if (url.pathname.endsWith('/list-all')) return { code: 0, data: { list: [] } }; return { code: 0, data: {} };
  });
  let host;
  try {
    host = await RunningHost.start(executable, home, ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')], { ...isolatedEnvironment(home), ...provider.environment, BILIKARA_CF_API_URL: provider.base });
    await host.api('/api/config/cookie', { sessdata: 'fixture', bili_jct: 'fixture' }); await idle(host);
    assert.equal((await host.api('/api/gatcha/uids/add', { uid: '111', queue: true })).queued, true); await waitFor(() => entered, 'first actual queue job did not start', 5000); assert.ok('uid' in await host.api('/api/gatcha/uids/preview', { uid: '123' }));
    await host.api('/api/gatcha/uids/add', { uid: '999', queue: true }); const peer = publicPeer(host, 'queued-peer'); await peer.open(); await peer.dispatch('session.set_identity', { name: 'Queue tester' }); const queued = await peer.dispatch('gatcha.uid_add', { uid: '123' }); assert.equal(queued.queued, true); assert.equal(queued.duplicate, false); assert.equal((await host.api('/api/gatcha/uids/add', { uid: '123', queue: true })).duplicate, true);
    const state = await host.api('/api/internet-remote/state'); assert.ok(state.capabilities.source_queue && state.capabilities.source_queue_titles); assert.deepEqual(state.gatcha.source_queue.pending.map(v => v.uid), ['999', '123']);
    const titles = { '456': '🎤 我的收藏' }; await peer.dispatch('gatcha.favlist_refresh', { uid: '123', folder_ids: ['456'], folder_titles: titles }); for (const route of ['/api/state', '/api/internet-remote/state']) assert.deepEqual((await host.api(route)).gatcha.source_queue.pending.at(-1).folder_titles, titles);
    release(); const final = await idle(host); assert.equal(final.gatcha.source_queue.completed.uids, 3); assert.deepEqual(final.gatcha.source_queue.failed.map(v => v.uid), ['999']); assert.deepEqual(fetched, ['111', '999', '999', '999', '123']); assert.equal((await host.api('/api/gatcha/browse?uid=123')).items.length, 1);
  } finally { release(); if (host) await host.close(); await provider.close(); rmSync(home, { recursive: true, force: true }); }
});

test('real partial refresh retries failed UID before healthy UID and favorites without starvation', { skip: process.platform !== 'linux' ? 'local TLS trust fixture requires native Linux' : false, timeout: 60000 }, async () => {
  const { home, data } = seed(); let round = 1;
  writeFileSync(path.join(data, 'gatcha_uids.json'), JSON.stringify({ schema_version: 2, uids: ['1', '2'], profiles: Object.fromEntries(['1', '2'].map(uid => [uid, { uid, name: `Fixture ${uid}`, space_url: `https://space.bilibili.com/${uid}` }])) }));
  writeFileSync(path.join(data, 'gatcha_favlist.json'), JSON.stringify({ schema_version: 2, uid: '42', folders: [{ uid: '42', id: '100', title: 'Fixture favorites' }], items: [] })); writeFileSync(path.join(data, 'BBDown.data'), 'SESSDATA=synthetic; bili_jct=synthetic');
  const provider = await videoFixture(target => {
    const url = new URL(target, 'https://api.bilibili.com');
    if (url.pathname.endsWith('/nav')) return nav;
    if (url.pathname.endsWith('/arc/search')) { if (url.searchParams.get('mid') === '2') return { code: -101, message: 'synthetic permanent source failure' }; return { code: 0, data: { list: { vlist: Array.from({ length: round }, (_, i) => ({ bvid: `BVNEW000000${round - i}`, title: `karaoke new ${round - i}`, author: 'Fixture' })) } } }; }
    if (url.pathname.endsWith('/resource/list')) return { code: 0, data: { medias: Array.from({ length: round }, (_, i) => ({ bvid: `BVFAV000000${round - i}`, title: `Favorite ${round - i}`, upper: { mid: 42, name: 'Fixture' } })), has_more: false } }; return { code: 0, data: {} };
  });
  let host;
  try {
    host = await RunningHost.start(executable, home, ['--headless', '--port', '0', '--data-dir', data, '--static-dir', path.join(root, 'static')], { ...isolatedEnvironment(home), ...provider.environment, BILIKARA_CF_API_URL: '', BILIKARA_CATALOG_SHEETS_URL: '' });
    const finished = async () => { const state = await idle(host); assert.equal(state.gatcha.last_status, 'partial'); return JSON.parse(readFileSync(path.join(data, 'gatcha_cache.json'))); };
    const first = await finished(); assert.deepEqual(first.refresh_summary.uids.map(item => item.uid), ['1']); provider.requests.length = 0; round = 2;
    assert.equal((await host.api('/api/gatcha/refresh', {})).started, true); const second = await finished(); assert.deepEqual(second.refresh_summary.errors.map(item => item.uid), ['2']); assert.deepEqual(second.refresh_summary.uids.map(item => item.uid), ['1']); assert.equal(second.refresh_summary.total_count, 2); assert.equal(second.uids['1'][0].bvid, 'BVNEW0000002');
    assert.ok(JSON.parse(readFileSync(path.join(data, 'gatcha_favlist.json'))).items.some(item => item.bvid === 'BVFAV0000002')); assert.deepEqual(provider.requests.filter(url => url.includes('/arc/search')).map(url => new URL(url, provider.base).searchParams.get('mid')), ['2', '2', '2', '1']);
  } finally { if (host) await host.close(); await provider.close(); rmSync(home, { recursive: true, force: true }); }
});
