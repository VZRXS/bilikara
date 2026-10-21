// Synthetic receiver only; commands and lifecycle run in the actual Rust Host.
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {HttpClient,waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

const bootstrap=process.env.BILIKARA_TEST_PUREK_BOOTSTRAP;
const dlna=process.env.BILIKARA_TEST_PUREK_DLNA==='1';
assert.ok(bootstrap);
const client=new HttpClient(new URL(bootstrap).origin);await client.request(bootstrap);
const remote=new HttpClient(client.base);await remote.request('/remote');
const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&amp;','&');
const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
let uri='',transport='STOPPED',refuse=false,finish=false,sets=0,stops=0,heldPlay=false,holdPlay=true,releasePlay;
let emptyMetadataRetry=false;
const playGate=new Promise(resolve=>releasePlay=resolve);
const pulls=[],complete=[],actions=[];
const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks).toString('utf8');
  res.setHeader('Content-Type','text/xml');
  if(req.method==='GET'){
    assert.equal(req.url,'/description.xml','no QR or authorization endpoint exists');
    return res.end('<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:p3-fixture</UDN><friendlyName>Controller fixture</friendlyName><serviceList>'+['ConnectionManager','AVTransport'].map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
  }
  assert.equal(req.method,'POST');
  const action=String(req.headers.soapaction||'').split('#')[1]?.replaceAll('"','');actions.push(action);
  if(action==='SetDeviceAuthorization'){
    assert.equal(dlna,false,'ordinary DLNA has no vendor authorization action');
    return res.end(soap(action,'','ConnectionManager'));
  }
  if(action==='GetProtocolInfo')return res.end(soap(action,'<Source/><Sink>http-get:*:video/MP2T:*</Sink>','ConnectionManager'));
  assert.equal(req.url,'/AVTransport');
  assert.equal(req.headers.soapaction,`"urn:schemas-upnp-org:service:AVTransport:1#${action}"`);
  assert.match(body,/<InstanceID>0<\/InstanceID>/);
  assert.match(body,/xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/);
  assert.ok(!body.includes('DeviceIP')&&!body.includes('DeviceToken'));
  if(action==='Stop'){stops++;transport='STOPPED';return res.end(soap(action));}
  if(action==='SetAVTransportURI'){
    sets++;
    const metadata=decode(body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)[1]);
    if(dlna&&sets===1){
      assert.match(metadata,/<DIDL-Lite/);res.statusCode=500;
      return res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>714</errorCode><errorDescription>Illegal MIME-Type</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
    }
    if(dlna&&sets===2){assert.equal(metadata,'');emptyMetadataRetry=true;}
    else assert.match(metadata,/<DIDL-Lite/);
    uri=decode(body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)[1]);return res.end(soap(action));
  }
  if(action==='Play'){
    assert.match(body,/<Speed>1<\/Speed>/);
    if(holdPlay){heldPlay=true;await playGate;holdPlay=false;res.end(soap(action));return;}
    transport='PLAYING';const current=uri;res.end(soap(action));
    pulls.push(new Promise((resolve,reject)=>{
      const q=http.get(current,{timeout:5000},r=>{
        assert.equal(r.statusCode,200);let size=0;const chunks=[];
        r.on('data',b=>{size+=b.length;assert.ok(size<4*1024*1024);chunks.push(b);});
        r.on('error',reject);r.on('end',()=>{complete.push({uri:current,bytes:Buffer.concat(chunks)});if(finish&&uri===current)transport='STOPPED';resolve();});
      });q.on('timeout',()=>q.destroy(new Error('receiver deadline')));q.on('error',reject);
    }));return;
  }
  if(action==='GetTransportInfo'){
    if(refuse){res.statusCode=503;return res.end('fixture unavailable');}
    return res.end(soap(action,`<CurrentTransportState>${transport}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`));
  }
  assert.fail(`Unexpected SOAP action ${action}`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const state=()=>client.api('/api/state');
const status=async value=>waitFor(async()=>{const s=await state();return s.media_output.status===value&&s;},`controller ${value}`);
const command=async(action,extra={})=>{const s=await state();return remote.api('/api/player/control',{action,item_id:s.current_item.id,playback_generation:s.playback_generation,...extra});};
try{
  const local=`http://127.0.0.1:${server.address().port}`;
  if(dlna){
    const prepared=await client.api('/api/purek/prepare',{url:local+'/description.xml'});
    assert.equal(prepared.connection_type,'dlna');assert.equal(prepared.authorization_url,null);
  }else{
    const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',local);inner.searchParams.set('token','synthetic-only');inner.searchParams.set('name','Controller fixture');
    const qr=new URL('https://wx.chunk.cn/projection/login');qr.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));qr.searchParams.set('place_code','fixture');
    await client.api('/api/purek/prepare',{qr_url:qr.href});
  }
  const connected=await client.api('/api/purek/connect',{});
  assert.equal(connected.connection_type,dlna?'dlna':'purek');assert.equal(connected.room_name,'Controller fixture');
  assert.equal((await remote.request('/api/player/output',{target:'purek',experimental:true})).status,403);
  assert.equal((await client.request('/api/player/output',{target:'purek'})).status,400);
  const initial=await state();
  const claim={playback_generation:initial.playback_generation,item_incarnation_id:initial.current_item.item_incarnation_id,artifact_set_id:initial.current_item.artifact_set_id};
  assert.equal((await client.api('/api/player/claim-program',claim,{'X-Bilikara-Client':'controller-fixture'})).claimed,true);
  await client.api('/api/player/output',{target:'purek',experimental:true});
  await waitFor(()=>heldPlay,'deferred SOAP Play');
  await client.api('/api/player/restart-program',{});releasePlay();
  let s=await status('streaming');assert.ok(sets>=2,'obsolete SOAP completion is rolled back before new program starts');assert.equal(s.media_output.qualified,false);assert.equal(s.media_output.pipeline_level,'L1');
  assert.equal((await client.api('/api/player/claim-program',{playback_generation:s.playback_generation,item_incarnation_id:s.current_item.item_incarnation_id,artifact_set_id:s.current_item.artifact_set_id},{'X-Bilikara-Client':'controller-fixture'})).claimed,false);
  assert.equal((await client.request('/api/player/control-ack',{seq:1})).status,409);
  const publicState=await remote.api('/api/state');assert.equal(publicState.media_output.can_manage,false);assert.equal(publicState.purek,undefined);
  assert.ok(!JSON.stringify(publicState.media_output).includes('Controller fixture'));
  const first=uri;
  await command('pause');s=await status('paused');assert.equal(s.player_status.is_paused,true);assert.ok(stops>=2);
  await command('play');await status('streaming');assert.notEqual(uri,first);
  let previous=uri;await command('seek-absolute',{target_seconds:1});
  await waitFor(async()=>uri!==previous&&(await state()).media_output.status==='streaming','seek rebuild');
  await command('pause');await status('paused');previous=uri;
  await command('seek-absolute',{target_seconds:2});await delay(350);assert.equal(uri,previous,'paused seek keeps TV stopped');
  await command('play');await status('streaming');assert.notEqual(uri,previous);
  previous=uri;await client.api('/api/player/restart-program',{});
  await waitFor(async()=>uri!==previous&&(await state()).media_output.status==='streaming','same song restart');
  previous=uri;const before=sets;
  const epoch='abcdefghijklmnopqrstuv';
  await client.api('/api/internet-remote/peer/open',{peer_id:'controller-peer',epoch,profile:'controller'});
  const rpc=await client.api('/api/internet-remote/dispatch',{peer_id:'controller-peer',lane:'control',message:JSON.stringify({v:1,lane:'control',epoch,seq:1,id:randomUUID(),kind:'output.set_offset_mode',body:{offset_mode:'gradual'}})});
  assert.equal(rpc.data.media_output.offset_mode,'gradual');assert.equal(rpc.data.media_output.can_manage,false);
  await remote.api('/api/player/output',{offset_mode:'splice'});
  await remote.api('/api/player/output',{offset_mode:'gradual'});
  await remote.api('/api/player/key-shift',{key_shift:2});await remote.api('/api/player/volume',{volume_percent:70});
  s=await state();await remote.api('/api/player/audio-variant',{item_id:s.current_item.id,expected_item_incarnation_id:s.current_item.item_incarnation_id,variant_id:'instrumental'});
  await delay(250);assert.equal(uri,previous);assert.equal(sets,before);assert.equal((await state()).media_output.offset_mode,'gradual');
  await remote.api('/api/player/next',{playback_generation:(await state()).playback_generation});
  s=await waitFor(async()=>{const s=await state();return s.current_item?.id!==initial.current_item.id&&s.media_output.status==='streaming'&&s;},'next cached song');
  const second=s.current_item.id;refuse=true;
  await status('error');s=await state();assert.equal(s.media_output.target,'purek');assert.equal(s.media_output.requested_target,'purek');assert.equal(s.current_item.id,second);
  await delay(350);assert.equal((await state()).media_output.target,'purek','failure never resumes local playback');
  refuse=false;await client.api('/api/player/output',{target:'local'});
  s=await waitFor(async()=>{const s=await state();return s.media_output.target==='local'&&s;},'explicit local output');
  assert.equal(s.player_control_command.action,'seek-absolute');
  // Returning to TV clears pending local restoration and starts at a fresh IDR.
  await client.api('/api/player/restart-program',{});finish=true;
  await client.api('/api/player/output',{target:'purek',experimental:true});await status('streaming');
  const finalUri=uri;
  await waitFor(async()=>(await state()).current_item?.id==='purek-fixture-2','receiver EOF advances once',20000);
  s=await status('waiting');assert.equal(s.media_output.target,'purek');assert.notEqual(s.current_item.cache_status,'ready');
  const waitingSets=sets;await delay(300);assert.equal(sets,waitingSets,'uncached media stays waiting');
  await command('next-track');await waitFor(async()=>!(await state()).current_item,'empty queue');
  s=await status('waiting');assert.equal(s.player_status,null);
  const full=complete.find(x=>x.uri===finalUri);assert.ok(full);inspectTs(full.bytes,{videoFrames:144,channels:2,sampleRate:48000});
  assert.ok(s.session_played.some(x=>x.item_id===second&&x.threshold_reached),'network playback preserves history and rating eligibility');
  assert.ok(!actions.includes('Pause'),'unqualified Pause A is never used');
  assert.ok(!actions.includes('Seek'),'seek rebuilds the stream instead of depending on receiver seek');
  await client.api('/api/player/output',{target:'local'});await waitFor(async()=>(await state()).media_output.target==='local','idle local');
  await client.api('/api/purek/disconnect',{});await Promise.all(pulls);
  const counts=Object.fromEntries([...new Set(actions)].map(action=>[action,actions.filter(a=>a===action).length]));
  if(dlna)assert.equal(counts.SetDeviceAuthorization,undefined);
  writeFileSync(process.env.BILIKARA_TEST_PUREK_REPORT,JSON.stringify({connection_type:dlna?'dlna':'purek',qualified:false,
    actions:counts,empty_metadata_retry:emptyMetadataRetry,stream_bytes:full.bytes.length,video_frames:144,
    checks:['stale Play rollback','pause Stop','resume new URI','active seek new URI','paused seek held','restart new URI',
      'pitch/volume/audio/offset same URI','next cached song','SOAP failure holds output','explicit local return','EOF advances once','uncached waiting','empty queue']},null,2)+'\n','utf8');
  process.stdout.write('purek-node-receiver-ok\n');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
