// Current native Host + existing rendered browser contracts, local TLS only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { isolatedEnvironment } from './native_host_support.mjs';
import { localCertificate } from './local_tls_certificate.mjs';
import { videoFixture } from './video_service_fixture.mjs';

export async function ratingFixture(home) {
  const calls = [], failures = [], counts = { metadata: 0, profiles: 0 }, modes = { rating: 'success', append: 'success' }, held = new Map();
  const certs = await localCertificate(path.join(home, 'certs'), ['passport.bilibili.com', 'api.bilibili.com', 'api.kevinx96.icu']);
  const wait = async key => { const barrier = held.get(key); if (!barrier) return; let timer; try { await Promise.race([barrier.promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error('fixture gate timed out')),20000);})]); } finally {clearTimeout(timer);} };
  const respond = async (raw, headers = {}, payload) => {
    const parsed = new URL(raw, 'http://fixture.test'), name = parsed.pathname, query = parsed.searchParams;
    if (name === '/fixture/control') { for (const key of ['rating','append','metadata']) {
      if (query.has(key)) { held.get(key)?.release(); held.delete(key); if (query.get(key)==='hold') { let release; const promise=new Promise(resolve=>{release=resolve;}); held.set(key,{promise,release}); } }
      if (query.has(`${key}_mode`)) modes[key]=query.get(`${key}_mode`);
    } return {}; }
    if (name === '/fixture/stats') return { calls, counts, failures };
    if (['/rate-song','/batch-add'].includes(name)) {
      if (headers.cookie || headers.authorization) failures.push('private header on Catalog request');
      const expected = name === '/rate-song' ? ['session_user_name','play_id','bvid','score'] : ['records'];
      if (JSON.stringify(Object.keys(payload).sort())!==JSON.stringify(expected.sort())) failures.push('unexpected Catalog payload fields');
      if (name === '/batch-add' && (payload.records.length!==1 || JSON.stringify(Object.keys(payload.records[0]).sort())!==JSON.stringify(['mid','bvid','title','url','owner_name','owner_url','cover_url'].sort()))) failures.push('unexpected public metadata');
      const entry={path:name,body:payload,accepted:false}; calls.push(entry); const key=name==='/rate-song'?'rating':'append'; await wait(key); entry.accepted=modes[key]==='success';
      return {fixtureResponse:{status:modes[key]==='http_failure'?503:200,data:{success:entry.accepted,error:'fixture-private-upstream-text'}}};
    }
    if (name === '/x/web-interface/nav') return {code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+ 'b'.repeat(32)+'.png'}}};
    if (['/x/web-interface/wbi/view','/x/web-interface/view'].includes(name)) {counts.metadata++; await wait('metadata'); const bvid=query.get('bvid'); return {code:0,data:{aid:123,bvid,title:'Catalog fixture '+bvid.at(-1),pic:'',owner:{mid:42,name:'Fixture UP'},pages:[{page:1,cid:456,duration:90,part:'on vocal'}]}};}
    // Accepted owner enrichment is a bounded profile lookup, not a library refresh.
    if (name === '/x/space/wbi/acc/info') { assert.equal(query.get('mid'),'42'); counts.profiles++; return {code:0,data:{mid:42,name:'Fixture UP',face:''}}; }
    if (name === '/x/passport-login/web/qrcode/generate') return {code:0,data:{url:'https://account.bilibili.com/scan?token=synthetic',qrcode_key:'synthetic-key'}};
    if (name === '/x/passport-login/web/qrcode/poll') return {fixtureResponse:{data:{code:0,data:{code:0}},headers:{'Set-Cookie':['SESSDATA=synthetic-session; Domain=.bilibili.com; Path=/; Secure','bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/; Secure','b_nut=synthetic-nut; Domain=.bilibili.com; Path=/; Secure']}}};
    if (['space/wbi','d1/','admin/','gviz'].some(value=>name.includes(value))) failures.push('unauthorized background operation: '+name);
    return {fixtureResponse:{status:503,data:{error:'offline fixture'}}};
  };
  const fixture = await videoFixture((raw, headers)=>respond(raw,headers),certs, async (request, body) => {
    const result=await respond(request.url,request.headers,body); return result.fixtureResponse ?? {data:result};
  });
  return {...fixture,summary:()=>({calls,counts,failures,forwarded_external_requests:0}),release:()=>{for(const barrier of held.values())barrier.release();held.clear();}};
}

export async function runRatings(evidence, environment = process.env) {
  assert.equal(process.platform, 'linux', 'local native TLS browser fixture requires Linux SSL_CERT_FILE');
  const executable = await buildNativeHost();
  const home = mkdtempSync(path.join(root, '.tmp/ratings browser 中文 & ')); let fixture;
  mkdirSync(evidence,{recursive:true});
  try {
    fixture=await ratingFixture(home);
    const playwright=createRequire(import.meta.url)('playwright');
    const env={...isolatedEnvironment(home),...fixture.environment,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost',NODE_PATH:environment.NODE_PATH,CATALOG_FIXTURE_CONTROL:fixture.base,BILIKARA_CF_API_URL:'https://api.kevinx96.icu',BILIKARA_CATALOG_SHEETS_URL:'http://127.0.0.1:1/disabled.csv',BILIKARA_TEST_NATIVE_HOST:executable,BILIKARA_BROWSER_EXECUTABLE:environment.BILIKARA_BROWSER_EXECUTABLE||playwright.chromium.executablePath()};
    const result=await runNative(process.execPath,['tests/browser/native_ratings_catalog.cjs',path.resolve(evidence)],env,240000);
    const summary=fixture.summary(); writeFileSync(path.join(evidence,'fixture-summary.json'),JSON.stringify(summary,null,2)); assert.deepEqual(summary.failures,[]);
    assert.equal(result.status,0,result.stdout+result.stderr); return result;
  } finally {fixture?.release(); if(fixture)await fixture.close();rmSync(home,{recursive:true,force:true});}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length,3,'usage: node tests/run_native_ratings_catalog.mjs EVIDENCE_DIRECTORY');
  const result=await runRatings(path.resolve(process.argv[2])); process.stdout.write(result.stdout); process.stderr.write(result.stderr);
}
