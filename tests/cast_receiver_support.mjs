// Independent loopback MediaRenderer for the real Rust Host. No product parser
// or state machine is imported; every action and media byte crosses HTTP.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {HttpClient,waitFor} from './native_host_support.mjs';

export const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
export const fault='<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
// Loopback aliases beyond 127.0.0.1: Linux/Windows accept all of 127/8, macOS
// lo0 needs `sudo ifconfig lo0 alias <address> up`. Without one the caller
// skips that peer-specific check with this reason; CI sets
// BILIKARA_REQUIRE_LOOPBACK_ALIAS=1 so a missing alias fails instead.
export async function loopbackAlias(address,purpose){
  const available=await new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(0,address,()=>server.close(()=>resolve(true)));});
  if(available)return true;
  const reason=`${purpose}: loopback alias ${address} is unavailable; on macOS run "sudo ifconfig lo0 alias ${address} up"`;
  if(process.env.BILIKARA_REQUIRE_LOOPBACK_ALIAS==='1')throw new Error(`${reason} (BILIKARA_REQUIRE_LOOPBACK_ALIAS=1)`);
  console.log(`skipped ${reason}`);return false;
}

export async function transfer(uri,{method='GET',headers={},localAddress,headersOnly=false,received}={}){
  return new Promise((resolve,reject)=>{
    const q=http.request(uri,{method,headers,localAddress,timeout:8000},r=>{
      if(headersOnly)resolve({status:r.statusCode,headers:r.headers});
      let size=0;const chunks=[];
      // `received` exposes the bytes delivered so far while the GET is open.
      r.on('data',b=>{size+=b.length;if(size>8*1024*1024)r.destroy(new Error('fixture media bound'));else{chunks.push(b);received?.push(b);}});
      r.on('error',e=>{e.message=`response ${method} ${headers.Range??'full'} ${localAddress??'default peer'}: ${e.message}`;reject(e);});r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,bytes:Buffer.concat(chunks)}));
    });q.on('timeout',()=>q.destroy(new Error('fixture transfer deadline')));q.on('error',e=>{e.message=`${method} ${headers.Range??'full'} ${localAddress??'default peer'}: ${e.message}`;reject(e);});q.end();
  });
}
export async function fixture(options={}){
  const bootstrap=process.env.BILIKARA_TEST_PUREK_BOOTSTRAP;assert.ok(bootstrap);
  const client=new HttpClient(new URL(bootstrap).origin);await client.request(bootstrap);
  const remote=new HttpClient(client.base);await remote.request('/remote');
  const f={client,remote,uri:'',transport:'STOPPED',position:0,duration:120,actions:[],bodies:[],media:[],received:new Map(),errors:[],pulls:[],releases:0,registrations:0,refuse:false,unsupported:false,options};
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks).toString();
      res.setHeader('Content-Type','text/xml');
      if(req.method==='GET'){
        assert.equal(req.url,'/description.xml');
        const services=options.avOnly?['AVTransport']:['ConnectionManager','AVTransport'];
        return res.end('<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:node-cast-fixture</UDN><friendlyName>Controller fixture</friendlyName><serviceList>'+services.map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
      }
      const action=String(req.headers.soapaction||'').split('#')[1]?.replaceAll('"','');f.actions.push(action);f.bodies.push(body);
      if(action==='SetDeviceAuthorization'){
        assert.ok(options.vendor,'ordinary DLNA cannot register with Pure K');
        if(body.includes('<Enable>0</Enable>'))f.releases++;else f.registrations++;
        return res.end(soap(action,'','ConnectionManager'));
      }
      if(action==='GetProtocolInfo'){
        assert.ok(!body.includes('DeviceToken'));
        if(options.query==='fault'){res.statusCode=500;return res.end(fault);}
        if(options.query==='http'){res.statusCode=404;return res.end('missing');}
        if(options.query==='legacy')return res.end('<Envelope><Body><GetProtocolInfoResponse><Sink/></GetProtocolInfoResponse></Body></Envelope>');
        return res.end(soap(action,`<Source/><Sink>${options.sink??'http-get:*:video/MP2T:*'}</Sink>`,'ConnectionManager'));
      }
      assert.equal(req.url,'/AVTransport');assert.match(body,/<InstanceID>0<\/InstanceID>/);
      assert.equal(req.headers.soapaction,`"urn:schemas-upnp-org:service:AVTransport:1#${action}"`);
      assert.ok(!body.includes('DeviceToken')&&!body.includes('DeviceIP'));
      if(action==='Stop'){f.transport='STOPPED';return res.end(soap(action));}
      if(action==='SetAVTransportURI'){
        const metadata=decode(body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)[1]);
        if(options.rejectUri || (options.rejectMetadata&&!f.retried&&metadata)){
          f.retried=true;res.statusCode=500;return res.end(fault);
        }
        if(options.rejectMetadata&&f.actions.filter(a=>a==='SetAVTransportURI').length===2)assert.equal(metadata,'');
        else assert.match(metadata,/DIDL-Lite/);
        f.uri=decode(body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)[1]);f.position=0;return res.end(soap(action));
      }
      if(action==='Play'){
        if(options.playGate)await options.playGate;
        f.transport='PLAYING';res.end(soap(action));
        if(options.pull!==false){const uri=f.uri,received=[];f.received.set(uri,received);f.pulls.push(transfer(uri,{received}).then(r=>{assert.equal(r.status,200);f.media.push({...r,uri});}).catch(e=>f.errors.push(e)));}return;
      }
      if(action==='Pause'){f.transport='PAUSED_PLAYBACK';return res.end(soap(action));}
      if(action==='Seek'){
        assert.match(body,/<Unit>REL_TIME<\/Unit>/);
        const time=body.match(/<Target>(.*?)<\/Target>/)[1].split(':').map(Number);f.position=time[0]*3600+time[1]*60+time[2];return res.end(soap(action));
      }
      if(action==='GetTransportInfo'||action==='GetPositionInfo'){
        if(f.refuse){res.destroy();return;}
        if(f.unsupported){res.statusCode=500;return res.end(fault);}
        const time=n=>[Math.floor(n/3600),Math.floor(n/60)%60,Math.floor(n)%60].map(v=>String(v).padStart(2,'0')).join(':');
        return res.end(soap(action,action==='GetTransportInfo'?`<CurrentTransportState>${f.transport}</CurrentTransportState>`:`<TrackDuration>${time(f.duration)}</TrackDuration><RelTime>${time(f.position)}</RelTime>`));
      }
      assert.fail(`Unexpected SOAP action ${action}`);
    }catch(e){f.errors.push(e);res.destroy();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  f.local=`http://127.0.0.1:${server.address().port}`;
  f.state=()=>client.api('/api/state');
  f.status=value=>waitFor(async()=>{const s=await f.state();return s.media_output.status===value&&!s.media_output.busy&&s;},`cast status ${value}`,20000);
  f.connect=async()=>{
    if(options.vendor){
      const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',f.local);inner.searchParams.set('token','synthetic-only');inner.searchParams.set('name','Controller fixture');
      const qr=new URL('https://wx.chunk.cn/projection/login');qr.searchParams.set('place_code','fixture');qr.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));
      await client.api('/api/purek/prepare',{qr_url:qr.href});
    }else await client.api('/api/purek/prepare',{url:f.local+'/description.xml'});
    return client.api('/api/cast/connect',{});
  };
  f.command=async(action,extra={})=>{const s=await f.state();return remote.api('/api/player/control',{action,item_id:s.current_item.id,playback_generation:s.playback_generation,...extra});};
  f.disconnect=async()=>{await client.api('/api/cast/disconnect',{});return waitFor(async()=>{const s=await f.state();return s.cast.phase==='idle'&&!s.cast.busy&&s;},'awaited disconnect');};
  f.close=async()=>{await f.disconnect();await Promise.all(f.pulls);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.deepEqual(f.errors,[]);};
  return f;
}
