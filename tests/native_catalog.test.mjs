// Real native HTTP and Internet adapters share the same Rust catalog service.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { root } from './desktop_construction_support.mjs';
import { buildNativeAlpha } from './native_runtime_artifacts.mjs';
import { HttpClient, RunningHost, isolatedEnvironment } from './native_host_support.mjs';

let executable;
before(async () => {executable = await buildNativeAlpha();});
const item = {bvid: 'BV1xx411c7mD', title: '歌曲, "日本語"\n🎶', mid: 42, owner_name: 'fixture', preserved_1: 3.5, tag_1: '动画'};

async function catalogFixture(home, handler) {
  const calls = [], sockets = new Set();
  const server = http.createServer((request, response) => {
    calls.push({method: request.method, path: request.url, headers: request.headers});
    const result = handler(new URL(request.url, 'http://fixture.test'), request);
    response.writeHead(result.status ?? 200, {'Content-Type': Buffer.isBuffer(result.body) ? 'text/csv' : 'application/json', ...result.headers});
    response.end(Buffer.isBuffer(result.body) ? result.body : JSON.stringify(result.body));
  });
  server.on('connection', socket => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  let host;
  return {calls, endpoint, async start(sheets = '') {
    const env = {...isolatedEnvironment(home), BILIKARA_CF_API_URL: endpoint, BILIKARA_CATALOG_SHEETS_URL: sheets};
    host = await RunningHost.start(executable, home, [path.join(home, 'data'), path.join(root, 'static')], env, true); return host;
  }, async close() {try {if (host) await host.close();} finally {for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));}}};
}

for (const source of ['cloudflare', 'sheets']) test(`native HTTP/Internet catalog ${source} preserves authorization, aliases, retired table selection and shared cache`, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'native catalog 中文 '));
  const fixture = await catalogFixture(home, url => source === 'cloudflare' ? url.searchParams.get('keyword') === 'denied' ? {status: 403, body: {error:'denied'}} : {body: [item]}
    : url.pathname === '/catalog.csv' ? {body: Buffer.from('bvid,title,url,mid,owner_name,tag_1\nBV1xx411c7mD,native,,42,fixture,动画\n')} : {status: 503, body: {}});
  try {
    const host = await fixture.start(source === 'sheets' ? fixture.endpoint + '/catalog.csv' : '');
    assert.equal((await new HttpClient(host.base).request('/api/catalog/search?q=native')).status, 403);
    const result = await host.api('/api/catalog/search?q=native&limit=80'); assert.equal(result.items[0].bvid, item.bvid);
    assert.deepEqual(Object.fromEntries(['bvid','title','source','tag_1','mid','owner_name'].map(key=>[key,result.items[0][key]])),{
      bvid:'BV1xx411c7mD',title:source==='sheets'?'native':'歌曲, "日本語"\n🎶',source,tag_1:'动画',mid:'42',owner_name:'fixture',
    });
    assert.deepEqual(await host.api('/api/lark/search?q=native&limit=80'), result);
    assert.equal((await host.request('/api/lark/search?q=native&table=1')).status, 410);
    const epoch = 'abcdefghijklmnopqrstuv';
    await host.api('/api/internet-remote/peer/open', {peer_id: 'catalog-fixture', epoch});
    const remote = await host.api('/api/internet-remote/dispatch', {peer_id: 'catalog-fixture', lane: 'bulk', message: JSON.stringify({v: 1, lane: 'bulk', epoch, seq: 1, id: randomUUID(), kind: 'catalog.search', body: {query: 'native', limit: 80}})});
    assert.equal(remote.data.items[0].bvid, item.bvid); assert.equal(remote.data.items[0].source, source);
    for(const key of ['bvid','source','tag_1','mid','owner_name']) assert.equal(remote.data.items[0][key],result.items[0][key]);
    // The accepted Internet projection removes control characters. The local
    // catalog preserves its complete title; do not normalize either away.
    assert.equal(remote.data.items[0].title,source==='sheets'?'native':'歌曲, "日本語"🎶');
    assert.equal(remote.data.items[0].catalog_item_id,'BV1xx411c7mD');assert.equal(Object.hasOwn(remote.data.items[0],'rank'),false);
    if(source==='sheets') {
      assert.equal(Object.hasOwn(remote.data.items[0],'preserved_1'),false);
      assert.match(result.exclusion_coverage,/unverified/);
      const other = await host.api('/api/internet-remote/dispatch', {peer_id:'catalog-fixture',lane:'bulk',message:JSON.stringify({v:1,lane:'bulk',epoch,seq:2,id:randomUUID(),kind:'catalog.search',body:{query:'动画',limit:80}})});
      assert.deepEqual(other.data.items,remote.data.items,'different keywords share the actual Sheets snapshot');
    } else assert.equal(remote.data.items[0].preserved_1,'3.5');
    assert.equal(fixture.calls.length, source === 'sheets' ? 2 : 1, 'both adapters share Rust caches');
    for (const call of fixture.calls) {assert.equal(call.method, 'GET'); assert.equal(call.headers.authorization, undefined); assert.equal(call.headers.cookie, undefined);}
    assert.equal((await host.request('/api/catalog/search?q=native&limit=99999')).status,400);
    if(source==='cloudflare') {
      const denied=await host.request('/api/internet-remote/dispatch',{peer_id:'catalog-fixture',lane:'bulk',message:JSON.stringify({v:1,lane:'bulk',epoch,seq:2,id:randomUUID(),kind:'catalog.search',body:{query:'denied',limit:80}})});
      assert.equal(denied.status,403);const error=JSON.parse(denied.body);assert.equal(error.ok,false);assert.equal(error.code,'catalog_forbidden');
    }
  } finally {await fixture.close(); rmSync(home, {recursive: true, force: true});}
});

test('real native catalog pages preserve exact counts, independent page contents and cache/offset failure boundaries', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'native catalog pages 中文 '));
  const items = Array.from({length: 221}, (_, index) => ({bvid: `BV${String(index).padStart(10, '0')}`, title: `Song ${index}`}));
  let mode = 'pages';
  const fixture = await catalogFixture(home, url => {
    assert.equal(url.pathname, '/search', 'no full table or count probe');
    const limit = Number(url.searchParams.get('limit')); assert.ok(limit <= 80);
    const offset = Number(url.searchParams.get('offset') || 0);
    return {body: mode === 'pages' ? {data: {items: items.slice(offset, offset + limit), offset, total: 221}} : [item]};
  });
  try {
    const host = await fixture.start();
    for (const offset of [0, 80, 160, 80, 0]) {
      const page = await host.api(`/api/catalog/search?q=Song&offset=${offset}&limit=80`);
      assert.equal(page.matched_count, 221); assert.equal(page.offset, offset); assert.equal(page.items.length, Math.min(80, 221 - offset));
      assert.equal(page.items[0].bvid, items[offset].bvid); assert.equal(page.has_more, offset < 160);
    }
    assert.equal(fixture.calls.length, 3); await host.api('/api/lark/search?q=Song&limit=80'); assert.equal(fixture.calls.length, 3);
    mode = 'legacy';
    const legacy = await host.api('/api/catalog/search?q=legacy&offset=0&limit=80'); assert.equal(Object.hasOwn(legacy, 'has_more'), false); assert.equal(Object.hasOwn(legacy, 'matched_count'), false);
    const unavailable = await host.request('/api/catalog/search?q=legacy&offset=80&limit=80');
    assert.equal(unavailable.status, 502); assert.equal(JSON.parse(unavailable.body).code, 'catalog_pagination_unavailable');
    assert.equal(fixture.calls.length, 5, 'no growing prefix retry or fallback');
    const count = fixture.calls.length;
    for (const query of ['offset=100001', 'limit=99999']) assert.equal((await host.request(`/api/catalog/search?q=legacy&${query}`)).status, 400);
    assert.equal(fixture.calls.length, count);
  } finally {await fixture.close(); rmSync(home, {recursive: true, force: true});}
});
