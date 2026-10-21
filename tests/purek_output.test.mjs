// Actual native libav + isolated Rust Host; Node is only a MediaRenderer and
// independent TS observer. No real room addresses, identities or credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {existsSync,mkdtempSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildPurekTests} from './native_runtime_artifacts.mjs';
import {runNative,root} from './desktop_construction_support.mjs';
import {HttpClient,isolatedEnvironment,waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
async function transfer(uri,method='GET'){
  return new Promise((resolve,reject)=>{
    const q=http.request(uri,{method,headers:{Range:'bytes=0-'},timeout:3000},r=>{
      let size=0;const chunks=[];r.on('data',b=>{size+=b.length;if(size>4*1024*1024)r.destroy();else chunks.push(b);});
      r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,bytes:Buffer.concat(chunks)}));
      r.on('error',()=>reject(new Error('fixture stream body failed')));
    });q.on('timeout',()=>q.destroy());q.on('error',()=>reject(new Error('fixture stream connection closed')));q.end();
  });
}
async function receiver(){
  const bootstrap=process.env.BILIKARA_TEST_PUREK_BOOTSTRAP;assert.ok(bootstrap);
  const client=new HttpClient(new URL(bootstrap).origin);assert.equal((await client.request(bootstrap)).status,200);
  let transport='STOPPED',uri='',setCount=0,playCount=0,stopCount=0,refuseInfo=false;
  const media=[],pulls=[];let faults=0;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type','text/xml');
    if(req.method==='GET')return res.end('<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:synthetic-renderer</UDN><friendlyName>Fixture receiver</friendlyName><serviceList>'+['ConnectionManager','AVTransport'].map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
    const action=String(req.headers.soapaction||'').split('#')[1]?.replaceAll('"','');
    if(action==='SetDeviceAuthorization')return res.end(soap(action,'','ConnectionManager'));
    if(action==='GetProtocolInfo')return res.end(soap(action,'<Source/><Sink>http-get:*:video/MP2T:*</Sink>','ConnectionManager'));
    if(action==='Stop'){stopCount++;transport='STOPPED';return res.end(soap(action));}
    if(action==='SetAVTransportURI'){
      setCount++;const metadata=decode(body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)[1]);
      if(faults===0){assert.match(metadata,/DIDL-Lite/);faults++;res.statusCode=500;return res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>synthetic fault</faultstring></s:Fault></s:Body></s:Envelope>');}
      uri=decode(body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)[1]);
      const head=await transfer(uri,'HEAD');assert.equal(head.status,200);assert.equal(head.headers['content-type'],'video/MP2T');assert.equal(head.headers['content-length'],undefined);
      return res.end(soap(action));
    }
    if(action==='Play'){
      playCount++;transport='PLAYING';res.end(soap(action));
      pulls.push(transfer(uri).then(result=>{assert.equal(result.status,200);media.push(result);}));return;
    }
    if(action==='GetTransportInfo'){
      if(refuseInfo){res.statusCode=503;return res.end('fixture unavailable');}
      return res.end(soap(action,`<CurrentTransportState>${transport}</CurrentTransportState>`));
    }
    assert.fail('unapproved renderer action');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const local=`http://127.0.0.1:${server.address().port}`;
    const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',local);inner.searchParams.set('token','synthetic-fixture-only');inner.searchParams.set('name','Fixture receiver');
    const qr=new URL('https://wx.chunk.cn/projection/login');qr.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));qr.searchParams.set('place_code','fixture');
    await client.api('/api/purek/prepare',{qr_url:qr.href});await client.api('/api/purek/connect',{});
    const initial=await client.api('/api/state');assert.equal(initial.current_item.cache_status,'ready');
    if(process.argv.includes('--receiver-l1')){
      const offset=value=>client.api('/api/player/av-delay-action',{type:'set_effective',effective_delay_ms:value});
      await offset(150);await client.api('/api/player/key-shift',{key_shift:-2});
      await client.api('/api/player/volume',{volume_percent:80});
      await client.api('/api/purek/output/start',{experimental:true,pipeline:'L1',framing:'chunked'});
      await waitFor(async()=>((await client.api('/api/purek/state')).output.status==='streaming'),'L1 actual bytes delivered');
      const state=await client.api('/api/purek/state'),first=uri;
      assert.equal(state.output.pipeline_level,'L1');assert.equal(state.output.capabilities.supports_runtime_av_offset,false);
      const change=async work=>{await work();await delay(120);};
      await change(()=>offset(0));await change(()=>offset(-150));
      await change(()=>client.api('/api/purek/output/set_offset_mode',{mode:'gradual'}));
      await change(()=>offset(150));await change(()=>offset(0));
      await change(()=>client.api('/api/player/audio-variant',{item_id:initial.current_item.id,expected_item_incarnation_id:initial.current_item.item_incarnation_id,variant_id:'instrumental'}));
      await change(()=>client.api('/api/player/key-shift',{key_shift:2}));
      await change(()=>client.api('/api/player/volume',{volume_percent:35,is_muted:true}));
      await change(()=>client.api('/api/player/volume',{is_muted:false}));
      await change(()=>client.api('/api/purek/output/set_offset_mode',{mode:'splice'}));
      const after=await client.api('/api/purek/state');assert.equal(after.output.status,'streaming');assert.equal(after.output.generation,state.output.generation);
      assert.equal(after.output.offset_mode,'splice');assert.equal(uri,first);assert.equal(setCount,2);assert.equal(playCount,1);
      const localState=await client.api('/api/state');assert.equal(localState.playback_generation,initial.playback_generation+1,'Local audio selection retains its existing program-generation change');
      assert.equal(localState.current_item.selected_audio_variant_id,'instrumental');
      await waitFor(()=>media.length===1,'full L1 body',12000);
      inspectTs(media[0].bytes,{videoFrames:144,channels:2,sampleRate:48000});
      await client.api('/api/player/restart-program',{});
      assert.equal((await client.api('/api/state')).current_item.id,initial.current_item.id);
      await waitFor(async()=>{const s=await client.api('/api/purek/state');return !s.busy&&s.output.last_error==='purek_output_context_changed';},'L1 same-song restart guard');
      try{assert.notEqual((await transfer(first,'HEAD')).status,200);}catch(e){assert.match(e.message,/fixture stream/);}
      await client.api('/api/purek/disconnect',{});await Promise.all(pulls);
      assert.ok(stopCount>=2);process.stdout.write('purek-node-receiver-ok\n');return;
    }
    assert.equal((await client.request('/api/purek/output/pause',{})).status,409);
    await client.api('/api/purek/output/stop',{});assert.equal(stopCount,0,'Idle output stop must not control unrelated receiver playback');
    assert.equal((await client.request('/api/purek/output/start',{})).status,400);
    assert.equal((await client.request('/api/purek/output/start',{experimental:true,framing:42})).status,400);
    const start=async framing=>{
      const previous=media.length;await client.api('/api/purek/output/start',{experimental:true,framing});
      await waitFor(async()=>((await client.api('/api/purek/state')).output.status==='streaming'),'native streaming status');
      await waitFor(()=>media.length>previous,'renderer pulled actual TS');
      inspectTs(media.at(-1).bytes);
      assert.equal(Boolean(media.at(-1).headers['transfer-encoding']),framing==='chunked');
      assert.equal((await client.api('/api/purek/state')).output.capabilities.supports_live_stream,false);
    };
    await start('close');assert.equal(faults,1);assert.equal(setCount,2);
    const first=uri;const firstGeneration=(await client.api('/api/purek/state')).output.generation;
    assert.equal((await client.request('/api/purek/output/start',{experimental:true})).status,409);
    await client.api('/api/purek/output/pause',{});assert.equal((await client.api('/api/purek/state')).output.status,'paused');
    try{assert.notEqual((await transfer(first,'HEAD')).status,200);}catch(error){assert.match(error.message,/fixture stream/);}
    await start('chunked');assert.ok((await client.api('/api/purek/state')).output.generation>firstGeneration);assert.notEqual(uri,first);
    const resumed=await client.api('/api/state');assert.equal(resumed.current_item.id,initial.current_item.id);assert.equal(resumed.playback_generation,initial.playback_generation);
    await client.api('/api/player/key-shift',{key_shift:1});
    await waitFor(async()=>{const s=await client.api('/api/purek/state');return !s.busy&&s.output.last_error==='purek_output_context_changed';},'L0 settings Stop completion');
    const before=setCount;assert.equal((await client.request('/api/purek/output/start',{experimental:true})).status,409);assert.equal(setCount,before,'L1 requirement fails before receiver URI changes');
    await client.api('/api/player/key-shift',{key_shift:0});await start('close');
    const previous=await client.api('/api/state');await client.api('/api/player/next',{playback_generation:previous.playback_generation});
    await waitFor(async()=>{const s=await client.api('/api/purek/state');return !s.busy&&s.output.status==='error';},'song change ends old stream and receiver Stop');
    await start('close');refuseInfo=true;
    await waitFor(async()=>{const s=await client.api('/api/purek/state');return !s.busy&&s.output.last_error==='purek_output_interrupted';},'transport interruption detection and Stop completion',10000);
    refuseInfo=false;await client.api('/api/purek/output/stop',{});
    await client.api('/api/player/next',{playback_generation:(await client.api('/api/state')).playback_generation});
    assert.equal((await client.api('/api/state')).current_item,null);
    assert.equal((await client.request('/api/purek/output/start',{experimental:true})).status,409);
    await client.api('/api/purek/disconnect',{});await Promise.all(pulls);
    assert.ok(playCount>=4&&stopCount>=playCount);process.stdout.write('purek-node-receiver-ok\n');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

if(process.argv.includes('--receiver')||process.argv.includes('--receiver-l1'))await receiver();
else test('P1 real native pipeline and isolated Node MediaRenderer',{timeout:180000},async t=>{
  const companion=process.env.BILIKARA_TEST_LIBAV_COMPANION;assert.ok(companion&&path.isAbsolute(companion)&&existsSync(companion),'actual P1 companion is required');
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-purek-p1-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=await buildPurekTests();const environment=isolatedEnvironment(home);
  environment.BILIKARA_TEST_LIBAV_COMPANION=companion;environment.BILIKARA_LIBAV_COMPANION=companion;
  environment.BILIKARA_TEST_PUREK_TS=path.join(home,'live.ts');
  const pipeline=await runNative(binary,['--exact','experimental_libav::live_ts::tests::real_pipeline_copy_and_native_ts_inspection','--ignored','--nocapture'],environment,30000);
  assert.equal(pipeline.status,0,pipeline.stdout+pipeline.stderr);inspectTs(readFileSync(environment.BILIKARA_TEST_PUREK_TS));
  const data=path.join(home,'data');mkdirSync(data);
  environment.BILIKARA_TEST_PUREK_HOME=data;environment.BILIKARA_TEST_NODE=process.execPath;
  environment.BILIKARA_CF_API_URL='';environment.BILIKARA_CATALOG_SHEETS_URL='';
  const result=await runNative(binary,['--exact','native_host::purek::tests::node_receiver_live_output_integration','--ignored','--nocapture'],environment,90000,root);
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/1 passed/);
});
