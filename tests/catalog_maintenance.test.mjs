// Current Rust CLI, real verified TLS/WBI and local Worker only. No live upload.
import assert from 'node:assert/strict';
import {before, test} from 'node:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {buildCatalogMaintenance} from './native_runtime_artifacts.mjs';
import {root, runNative} from './desktop_construction_support.mjs';
import {isolatedEnvironment} from './native_host_support.mjs';
import {localCertificate} from './local_tls_certificate.mjs';
import {videoFixture} from './video_service_fixture.mjs';

let executable;
before(async()=>{executable=await buildCatalogMaintenance();});
const nav={code:0,data:{wbi_img:{img_url:`https://i0.hdslb.com/${'a'.repeat(32)}.png`,sub_url:`https://i0.hdslb.com/${'b'.repeat(32)}.png`}}};
const latest={bvid:'BVNEW0000001',title:'karaoke latest',author:'artist',mid:999,length:'1:30',pic:'https://fixture.invalid/cover.jpg',play:123};
const middle={...latest,bvid:'BVMID0000001',title:'カラオケ middle'};
const oldest={...latest,bvid:'BVOLD0000001',title:'伴奏 oldest'};
const expected={mid:'42',bvid:'BVMID0000001',title:'カラオケ middle',url:'https://www.bilibili.com/video/BVMID0000001',owner_name:'artist',owner_url:'https://space.bilibili.com/42',cover_url:'https://fixture.invalid/cover.jpg',played_count:'123',preserved_1:'90'};

async function fixture(run) {
  const home=mkdtempSync(path.join(os.tmpdir(),'catalog admin 中文 & $ '));
  const certificates=await localCertificate(path.join(home,'CA'),['api.bilibili.com']);
  const state={records:[{bvid:latest.bvid,mid:'42'},{bvid:oldest.bvid,mid:'42'}],videos:[latest,middle,oldest],total:3,apiFailures:0,exportReply:undefined,exportDelay:0,cookie:'SESSDATA=local-fixture',uploadReply:{success:true,attempted:1,added:1},calls:[]};
  const service=await videoFixture(async(target,headers)=>{
    const url=new URL(target,'https://api.bilibili.com');state.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),headers});
    if(url.pathname==='/export') {
      assert.equal(headers.authorization,'Bearer fixture-secret');assert.equal(headers.cookie,undefined);
      assert.equal(headers.accept,'application/json');assert.equal(headers['cache-control'],'no-store');assert.equal(headers.pragma,'no-cache');
      assert.equal(headers['user-agent'],'bilikara/fixture-version (+https://github.com/VZRXS/bilikara)');
      assert.equal(url.searchParams.get('all'),'1');assert.match(url.searchParams.get('_'),/^\d{13,}$/);
      if(state.exportDelay) await delay(state.exportDelay);
      return {fixtureResponse:state.exportReply??{data:state.records}};
    }
    assert.equal(headers.authorization,undefined,'administrator secret must not be sent to Bilibili');
    assert.equal(headers.cookie,state.cookie);
    if(url.pathname==='/x/web-interface/nav') return nav;
    if(url.pathname==='/x/space/wbi/arc/search') {
      assert.match(url.searchParams.get('w_rid'),/^[a-f0-9]{32}$/);assert.match(url.searchParams.get('wts'),/^\d+$/);
      assert.equal(url.searchParams.get('ps'),'50');assert.equal(url.searchParams.get('tid'),'0');assert.equal(url.searchParams.get('order'),'pubdate');assert.equal(url.searchParams.get('platform'),'web');
      if(state.apiFailures>0){state.apiFailures--;return {code:412,message:'isolated retry'};}
      return {code:0,data:{page:{count:state.total},list:{vlist:state.videos}}};
    }
    assert.fail(`unexpected local route ${url.pathname}`);
  },certificates,(request,body)=>{
    assert.equal(request.url,'/batch-add?sync_google=1');assert.equal(request.headers.authorization,'Bearer fixture-secret');assert.equal(request.headers.cookie,undefined);assert.equal(request.headers['content-type'],'application/json');
    assert.ok(Array.isArray(body.records));return {data:state.uploadReply};
  });
  writeFileSync(path.join(home,'uids 中文.json'),'{"uids":{"42":{},"99":{}}}');
  const environment={...isolatedEnvironment(home),...service.environment,BILIKARA_HOME:home,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1',BILIKARA_ADMIN_SECRET:'fixture-secret',BILIKARA_BILIBILI_COOKIE:'SESSDATA=local-fixture',BILIKARA_VERSION:'fixture-version'};
  const args=['--api-url',service.base,'--uid-source','uids 中文.json','--uid-mode','local','--limit-uids','1','--delay','0','--bili-retry-delay','0'];
  const execute=(more=[],env={})=>runNative(executable,[...args,...more],{...environment,...env},90000,home);
  try {await run({state,service,execute,environment,args,home});}finally{await service.close();rmSync(home,{recursive:true,force:true});}
}

test('real administrator CLI preserves WBI, source UID/extras, missing middle selection and authenticated upload', {skip:process.platform!=='linux'?'native Linux TLS fixture; native foreign execution remains separate':false,timeout:120000},async()=>{
  await fixture(async({state,service,execute,home})=>{
    const result=await execute();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/refreshed=1 skipped=0 failed=0/);assert.match(result.stdout,/entries=3 missing=1 d1_attempted=1 d1_added=1 d1_updated=0/);
    assert.deepEqual(service.posts,[['/batch-add?sync_google=1',{records:[expected]}]]);
    assert.equal(state.calls.filter(call=>call.path==='/export').length,1);
    assert.deepEqual(state.calls.filter(call=>call.path.endsWith('/arc/search')).map(call=>[call.query.mid,call.query.pn]),[['42','1'],['42','1']]);
    assert.ok(!result.stdout.includes('fixture-secret')&&!result.stderr.includes('SESSDATA='));
    service.posts.length=0;state.calls.length=0;
    const repeated=await execute(['--probe-mode','latest']);assert.equal(repeated.status,0,repeated.stderr);assert.match(repeated.stdout,/refreshed=0 skipped=1 failed=0/);assert.deepEqual(service.posts,[]);
    assert.equal(state.calls.filter(call=>call.path.endsWith('/arc/search')).length,1);
    const dry=await execute(['--dry-run','--upload-batch-size','1']);assert.equal(dry.status,0,dry.stderr);assert.match(dry.stdout,/d1_attempted=1 d1_added=0 d1_updated=0/);assert.deepEqual(service.posts,[]);
    const toolDir=path.join(home,'tools/bbdown');mkdirSync(toolDir,{recursive:true});
    const credentials=path.join(toolDir,'BBDown.data');writeFileSync(credentials,'SESSDATA=owned-file; bili_jct=owned-jct',{mode:0o600});state.cookie='SESSDATA=owned-file; bili_jct=owned-jct';
    const stored=await execute(['--probe-mode','latest']);assert.equal(stored.status,0,stored.stderr);assert.deepEqual(service.posts,[]);assert.equal(readFileSync(credentials,'utf8'),'SESSDATA=owned-file; bili_jct=owned-jct');
    writeFileSync(credentials,'invalid');state.cookie='SESSDATA=local-fixture';
    assert.equal((await execute(['--probe-mode','latest'])).status,0);
  });
});

test('real CLI retries, preserves filtered page and visible cap, rejects failed upload without false completion', {skip:process.platform!=='linux'?'native Linux TLS fixture':false,timeout:120000},async()=>{
  await fixture(async({state,service,execute})=>{
    state.apiFailures=1;state.uploadReply={success:false};
    const failed=await execute(['--bili-max-retries','1']);assert.equal(failed.status,1,failed.stderr);assert.match(failed.stdout,/refreshed=0 skipped=0 failed=1/);assert.match(failed.stderr,/attempt=1/);assert.equal(service.posts.length,1);
    assert.equal(state.calls.filter(call=>call.path.endsWith('/arc/search')).length,3);
    service.posts.length=0;state.total=8001;
    const capped=await execute(['--force']);assert.equal(capped.status,0,capped.stderr);assert.match(capped.stdout,/refreshed=0 skipped=1 failed=0/);assert.deepEqual(service.posts,[]);
    state.exportReply={data:{items:[]}};
    const badExport=await execute();assert.equal(badExport.status,2);assert.match(badExport.stderr,/invalid payload/);assert.deepEqual(service.posts,[]);
    state.exportReply={rawBody:Buffer.from('[{"bvid":"interrupted"')};
    const interrupted=await execute();assert.equal(interrupted.status,2);assert.match(interrupted.stderr,/invalid or interrupted JSON/);
    state.exportReply={status:401,data:{error:'fixture-secret must not appear in log'}};
    const denied=await execute();assert.equal(denied.status,2);assert.match(denied.stderr,/HTTP 401/);assert.ok(!denied.stderr.includes('fixture-secret'));
    state.exportDelay=250;state.exportReply=undefined;
    const deadline=await execute(['--export-timeout','0.05']);assert.equal(deadline.status,2);assert.match(deadline.stderr,/D1 transport failed/);assert.deepEqual(service.posts,[]);
  });
});

test('CLI entry preserves arguments, missing local/union inputs, bounded export and complete environment defaults', {skip:process.platform!=='linux'?'native Linux TLS fixture':false,timeout:120000},async()=>{
  await fixture(async({state,service,execute,environment,home})=>{
    const source=path.join(home,'uids 中文.json');const original=readFileSync(source);
    assert.equal((await execute(['--uid-source','missing local.json'])).status,2);
    state.records=[];
    const union=await execute(['--uid-source','missing local.json','--uid-mode','union','--export-limit','0']);assert.equal(union.status,0);assert.match(union.stdout,/No UID found/);assert.equal(state.calls.at(-1).query.limit,'1');assert.deepEqual(service.posts,[]);
    writeFileSync(source,'{"uids":42}');assert.equal((await execute()).status,1);writeFileSync(source,original);
    assert.equal((await execute([], {BILIKARA_ADMIN_SECRET:''})).status,2);
    state.exportReply={data:[],headers:{},status:200};
    const normal=await runNative('npm',['run','catalog:refresh','--','--api-url',service.base,'--uid-mode','d1','--delay','0'],{...process.env,...environment,HOME:process.env.HOME,PATH:process.env.PATH},300000,root);
    assert.equal(normal.status,0,normal.stderr);assert.match(normal.stdout,/No UID found/);
    const help=await runNative(executable,['--help'],environment,5000,home);assert.equal(help.status,0);assert.match(help.stdout,/--bili-max-retries/);assert.match(help.stdout,/--dry-run/);
    assert.deepEqual(readFileSync(source),original);assert.deepEqual(service.posts,[]);
  });
});

test('real entry and CI run the Rust maintenance artifact, and obsolete Python policy cannot return',()=>{
  const pkg=JSON.parse(readFileSync(path.join(root,'package.json')));
  assert.match(pkg.scripts['catalog:refresh'],/cargo run .*--manifest-path rust-runtime\/Cargo.toml --locked --target host-tuple --bin bilikara-catalog-refresh --$/);
  const workflow=readFileSync(path.join(root,'.github/workflows/ci-bundle.yml'),'utf8');assert.ok(workflow.includes('npm run test:catalog-maintenance'));
  const server=readFileSync(path.join(root,'bilikara/server.py'),'utf8');assert.ok(server.includes('from .rust_runtime import start_monthly_refresh_in_background'));assert.ok(!server.includes('from monthly_gatcha'));
  for(const retired of ['monthly_gatcha_d1_refresh.py','tests/test_monthly_gatcha_d1_refresh.py']) assert.equal(existsSync(path.join(root,retired)),false,'retired duplicate is absent: '+retired);
});
