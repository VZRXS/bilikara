import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {createRequire} from 'node:module';
const qrcode=createRequire(import.meta.url)('../static/qrcode-generator.js');
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {HttpClient, RunningHost, isolatedEnvironment} from './native_host_support.mjs';
let desktop, alpha;
before(async()=>{
  if(process.platform!=='linux')return;
  desktop=process.env.BILIKARA_TEST_NATIVE_HOST_BINARY||await buildNativeHost();
  alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();
},{timeout:300000});
function qr(base='http://192.168.123.231',token='synthetic-only-secret'){
  const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',base);inner.searchParams.set('token',token);inner.searchParams.set('name','Fixture room');
  const outer=new URL('https://wx.chunk.cn/projection/login');outer.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));outer.searchParams.set('place_code','fixture');return outer.href;
}
async function host(t, android=false){
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const env=isolatedEnvironment(home);env.BILIKARA_CF_API_URL='';env.BILIKARA_CATALOG_SHEETS_URL='';
  const server=await RunningHost.start(android?alpha:desktop,home,android?[home,path.join(root,'static')]:['--headless','--port','0','--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],env,android);
  t.after(()=>server.close());return {server,home};
}
test('Pure K API is Host-only, validates offline, and never persists the room token',{skip:process.platform!=='linux',timeout:60000},async t=>{
  const {server,home}=await host(t);
  const anonymous=new HttpClient(server.base);assert.equal((await anonymous.request('/api/purek/state')).status,403);
  const remote=new HttpClient(server.base);await remote.request('/remote');
  assert.equal((await remote.request('/api/purek/state')).status,403);
  assert.equal((await remote.request('/api/purek/prepare',{qr_url:qr()})).status,403);
  assert.equal((await remote.request('/api/purek/output/probe',{})).status,403);
  assert.equal((await server.request('/api/purek/output/probe',{})).status,409);
  assert.equal((await server.request('/api/purek/output/probe',{control_url:'http://example.invalid'})).status,400);
  assert.equal((await server.api('/api/purek/state')).connected,false);
  const ordered=await server.api('/api/purek/state');
  assert.ok(Number.isSafeInteger(ordered.revision));assert.equal(typeof ordered.state_epoch,'string');
  const output=(await server.api('/api/purek/state')).output;
  assert.equal(output.schema_version,1);assert.equal(output.status,'stopped');
  assert.equal(output.target_room_id,null);assert.equal(output.pipeline_level,null);
  assert.equal(output.capabilities.supports_live_stream,false);
  for(const bad of [qr('http://127.0.0.1'),qr('http://8.8.8.8'),qr('http://169.254.169.254'),qr('http://public.example'),qr().replace('wx.chunk.cn','evil.example')]){
    const response=await server.request('/api/purek/prepare',{qr_url:bad});assert.equal(response.status,400);assert.ok(!response.body.includes(Buffer.from('synthetic-only-secret')));
  }
  const prepared=await server.api('/api/purek/prepare',{qr_url:qr()});assert.equal(prepared.room_name,'Fixture room');assert.equal(prepared.authorization_url,qr());
  const snapshot=await server.api('/api/state');assert.equal(snapshot.purek.room_name,'Fixture room');assert.equal(snapshot.purek.connected,false);
  assert.equal(snapshot.purek.auto_discovery,false);assert.ok(!JSON.stringify(snapshot.purek).includes('secret'));assert.ok(!JSON.stringify(snapshot.purek).includes('projection_url'));
  const invalid=await server.request('/api/purek/preferences',{auto_discovery:'true'});assert.equal(invalid.status,400);
  await server.api('/api/purek/preferences',{auto_discovery:false});
  const files=readdirSync(path.join(home,'data'));assert.ok(files.includes('native-preferences.json'));
  assert.ok(!readFileSync(path.join(home,'data','native-preferences.json'),'utf8').includes('secret'));
  const disconnected=await server.api('/api/purek/disconnect',{});assert.equal(disconnected.room_name,null);
  assert.equal(disconnected.output.status,'stopped');assert.ok(disconnected.output.generation>output.generation);
  assert.equal((await server.request('/api/purek/connect',{})).status,409);
});

// Mobile Host and approved Remote QR/image acquisition are exercised through
// ktv_assistance_browser.test.mjs; the Host-only parser remains independent.
test('retained Host QR image decoder still accepts bounded grayscale data and rejects Remote callers', {skip:process.platform!=='linux',timeout:60000}, async t=>{
  const {server}=await host(t);const code=qrcode(0,'M');code.addData(qr());code.make();
  const modules=code.getModuleCount(),size=(modules+8)*4,pixels=Buffer.alloc(size*size,255);
  for(let y=0;y<modules;y++)for(let x=0;x<modules;x++)if(code.isDark(y,x))for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)pixels[((y+4)*4+dy)*size+(x+4)*4+dx]=0;
  const body={width:size,height:size,pixels:pixels.toString('base64')};
  const remote=new HttpClient(server.base);await remote.request('/remote');assert.equal((await remote.request('/api/purek/decode',{width:32,height:32,pixels:Buffer.alloc(32*32).toString('base64')})).status,403);
  assert.equal((await remote.request('/api/purek/decode',body)).status,413,'unprivileged image bodies retain the ordinary HTTP limit');
  assert.equal((await server.api('/api/purek/decode',body)).room_name,'Fixture room');
  assert.equal((await server.request('/api/purek/decode',{...body,pixels:'invalid'})).status,400);
});
