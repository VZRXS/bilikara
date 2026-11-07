// Sustained actual libav TS, not just an open GET. No receiver acceptance claim.
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {HttpClient,waitFor} from './native_host_support.mjs';

const client=new HttpClient(new URL(process.env.BILIKARA_TEST_PUREK_BOOTSTRAP).origin);
await client.request(process.env.BILIKARA_TEST_PUREK_BOOTSTRAP);
const dlna=process.env.BILIKARA_TEST_PUREK_DLNA==='1', eof=process.env.BILIKARA_TEST_PUREK_EOF==='1';
const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"');
let reported='STOPPED',uri='',bytes=0,stops=0,disconnect=false;
const sockets=new Set(),pulls=[],complete=[],actions=[];
const server=http.createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts).toString('utf8');
  res.setHeader('Content-Type','text/xml');
  if(req.method==='GET')return res.end('<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:monitor-fixture</UDN><friendlyName>Monitor fixture</friendlyName><serviceList>'+['ConnectionManager','AVTransport'].map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
  const action=String(req.headers.soapaction||'').split('#')[1]?.replaceAll('"','');actions.push({action,uri});
  if(action==='SetDeviceAuthorization')return res.end(soap(action,'','ConnectionManager'));
  if(action==='GetProtocolInfo')return res.end(soap(action,'<Source/><Sink>http-get:*:video/MP2T:*</Sink>','ConnectionManager'));
  if(action==='Stop'){stops++;return res.end(soap(action));}
  if(action==='SetAVTransportURI'){uri=decode(body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)[1]);return res.end(soap(action));}
  if(action==='Play'){
    res.end(soap(action));
    pulls.push(new Promise(resolve=>{
      const current=uri;const q=http.get(current,r=>{
        sockets.add(r);assert.equal(r.statusCode,200);
        let blocked=false;
        r.on('data',part=>{bytes+=part.length;if(disconnect)r.destroy();if(eof&&!blocked){blocked=true;r.pause();setTimeout(()=>r.resume(),400);}});
        r.on('end',()=>{complete.push(current);if(eof&&dlna&&current===uri)reported='STOPPED';});
        const done=()=>{sockets.delete(r);resolve();};r.on('end',done);r.on('close',done);r.on('error',done);
      });q.on('error',resolve);
    }));return;
  }
  if(action==='GetTransportInfo'){
    if(reported==='404'||reported==='503'){res.statusCode=Number(reported);return res.end('synthetic control status');}
    return res.end(soap(action,`<CurrentTransportState>${reported}</CurrentTransportState>`));
  }
  assert.fail(action);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const state=()=>client.api('/api/purek/state');
const status=value=>waitFor(async()=>{const s=await state();return !s.busy&&s.output.status===value&&s;},value,22000);
const start=async()=>{disconnect=false;bytes=0;await client.api('/api/purek/output/start',{experimental:true,pipeline:'L1'});await status('streaming');};
try{
  const local=`http://127.0.0.1:${server.address().port}`;
  if(dlna)await client.api('/api/purek/prepare',{url:local+'/description.xml'});
  else {
    const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',local);inner.searchParams.set('token','synthetic-only');inner.searchParams.set('name','Monitor fixture');
    const qr=new URL('https://wx.chunk.cn/projection/login');qr.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));qr.searchParams.set('place_code','fixture');
    await client.api('/api/purek/prepare',{qr_url:qr.href});
  }
  await client.api('/api/purek/connect',{});
  if(eof){
    reported='PLAYING';
    const initial=await client.api('/api/state');
    if(!dlna)await client.api('/api/player/output',{target:'purek',experimental:true});
    await waitFor(async()=>(await client.api('/api/state')).media_output.status==='streaming','managed sender started');
    const first=uri;
    await waitFor(()=>complete.includes(first),'actual first HTTP body ends');
    const ended=Date.now();
    const next=await waitFor(async()=>{const s=await client.api('/api/state');return s.current_item?.id!==initial.current_item.id&&s.media_output.status==='streaming'&&s;},'sender EOF normal finish',10000);
    assert.ok(Date.now()-ended<10000);
    assert.equal(next.current_item.id,'purek-fixture-1');
    const nextSet=actions.findIndex(a=>a.action==='SetAVTransportURI'&&a.uri===first);
    assert.ok(nextSet>=0&&actions.slice(0,nextSet).some(a=>a.action==='Stop'&&a.uri===first),'Stop precedes next URI publication');
    const second=uri;await waitFor(()=>complete.includes(second),'actual second HTTP body ends');
    // User Next within the settle window owns the transition; old EOF cannot
    // later skip the uncached item or overwrite its waiting state.
    await client.api('/api/player/next',{playback_generation:(await client.api('/api/state')).playback_generation});
    await waitFor(async()=>(await client.api('/api/state')).current_item?.id==='purek-fixture-2','user next during EOF settle');
    await delay(3000);
    const waiting=await client.api('/api/state');assert.equal(waiting.current_item.id,'purek-fixture-2');assert.equal(waiting.media_output.status,'waiting');
    await client.api('/api/player/output',{target:'local'});
    await client.api('/api/purek/disconnect',{});await Promise.all(pulls);
    process.stdout.write('purek-node-receiver-ok\n');
  } else {
  if(dlna){
    // The confirmed endpoint now starts automatically. Respect the same busy
    // guard as the Host UI before selecting this independent diagnostic path.
    await waitFor(async()=>(await client.api('/api/state')).media_output.busy===false,'automatic default finishes its current operation');
    await client.api('/api/player/output',{target:'local'});
    await waitFor(async()=>{const s=(await client.api('/api/state')).media_output;return s.target==='local'&&!s.busy;},'leave automatic default before explicit diagnostic trial');
  }
  await start();
  for(const contradictory of ['STOPPED','PAUSED_PLAYBACK','NO_MEDIA_PRESENT','404','NONSTANDARD']){
    reported=contradictory;const before=bytes;
    await delay(5000);
    assert.ok(bytes>before,`${contradictory}: actual received TS must advance`);
    assert.equal((await state()).output.status,'streaming',contradictory);
  }
  const oldUri=uri,oldStops=stops;
  await client.api('/api/purek/output/stop',{});await status('stopped');assert.ok(stops>oldStops);
  try { assert.notEqual((await fetch(oldUri,{method:'HEAD'})).status,200); } catch(error) { assert.equal(error.cause?.code,'ECONNREFUSED'); }
  reported='PLAYING';await start();disconnect=true;for(const socket of sockets)socket.destroy();
  assert.equal((await status('error')).output.last_error,'purek_output_interrupted');
  reported='503';await start();assert.equal((await status('error')).output.last_error,'purek_output_interrupted');
  await client.api('/api/purek/disconnect',{});await Promise.all(pulls);
  process.stdout.write('purek-node-receiver-ok\n');
  }
}finally{
  for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
