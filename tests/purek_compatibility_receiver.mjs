import assert from 'node:assert/strict';
import http from 'node:http';
import {writeFileSync} from 'node:fs';
import {HttpClient,waitFor} from './native_host_support.mjs';
import {inspectTs} from './purek_ts_observer.mjs';

const bootstrap=process.env.BILIKARA_TEST_PUREK_BOOTSTRAP;assert.ok(bootstrap);
const client=new HttpClient(new URL(bootstrap).origin);await client.request(bootstrap);
const remote=new HttpClient(client.base);await remote.request('/remote');
const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
const soap=(action,fields='',service='AVTransport')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1">${fields}</u:${action}Response></s:Body></s:Envelope>`;
const fault='<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
let current,uri='',transport='STOPPED',allowPull=false,playRequested=false,pull,actions=[];
const failures=[],report={qualified:false,played:[],refused:[],query_failure_preserved:true,no_premature_streaming:true,rejected_uri_held:false};
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const b of req)chunks.push(b);const body=Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type','text/xml');
    if(req.method==='GET')return res.end('<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:compatibility-fixture</UDN><friendlyName>Compatibility fixture</friendlyName><serviceList>'+ (current.name==='av-only'?['AVTransport']:['ConnectionManager','AVTransport']).map(s=>`<service><serviceType>urn:schemas-upnp-org:service:${s}:1</serviceType><controlURL>/${s}</controlURL></service>`).join('')+'</serviceList></device></root>');
    const action=String(req.headers.soapaction||'').split('#')[1]?.replaceAll('"','');actions.push(action);
    if(action==='SetDeviceAuthorization'){
      assert.equal(current.vendor,true);
      return res.end(soap(action,'','ConnectionManager'));
    }
    if(action==='GetProtocolInfo'){
      assert.equal(req.url,'/ConnectionManager');assert.ok(!body.includes('Token')&&!body.includes('synthetic-only'));
      if(current.name==='missing-action'||current.name==='reject-uri'){res.statusCode=500;return res.end(fault);}
      if(current.name==='http-error'){res.statusCode=404;return res.end('Not found');}
      if(current.name==='legacy-namespace')return res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><GetProtocolInfoResponse><Sink>http-get:*:video/MP2T:*</Sink></GetProtocolInfoResponse></s:Body></s:Envelope>');
      return res.end(soap(action,`<Source/><Sink>${current.sink}</Sink>`,'ConnectionManager'));
    }
    assert.equal(req.url,'/AVTransport');
    assert.match(body,/<InstanceID>0<\/InstanceID>/);
    if(action==='Stop'){transport='STOPPED';return res.end(soap(action));}
    if(action==='SetAVTransportURI'){
      if(current.name==='reject-uri'){res.statusCode=500;return res.end(fault);}
      const metadata=decode(body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/)[1]);
      assert.ok(metadata.includes(`protocolInfo="http-get:*:${current.mime||'video/MP2T'}:*"`));
      assert.ok(!metadata.includes('DLNA.ORG_PN='),'receiver profile is not a sender certification');
      uri=decode(body.match(/<CurrentURI>([\s\S]*?)<\/CurrentURI>/)[1]);return res.end(soap(action));
    }
    if(action==='Play'){
      playRequested=true;transport='PLAYING';res.end(soap(action));
      await waitFor(()=>allowPull,'explicit receiver pull');
      pull=new Promise((resolve,reject)=>{
        const q=http.get(uri,{timeout:8000},r=>{
          assert.equal(r.statusCode,200);assert.equal(r.headers['content-type'],current.mime||'video/MP2T');
          const chunks=[];let size=0;r.on('data',b=>{size+=b.length;assert.ok(size<4*1024*1024);chunks.push(b);});
          r.on('end',()=>resolve(Buffer.concat(chunks)));r.on('error',reject);
        });q.on('error',reject);q.on('timeout',()=>q.destroy(new Error('receiver timeout')));
      });
      return;
    }
    if(action==='GetTransportInfo')return res.end(soap(action,`<CurrentTransportState>${transport}</CurrentTransportState>`));
    assert.fail('unapproved receiver action');
  }catch(error){failures.push(error);res.destroy();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const local=`http://127.0.0.1:${server.address().port}`;
const cases=[
  {name:'ordinary',sink:'http-get:*:video/MP2T:*'},
  {name:'legacy-namespace',vendor:true,unknown:true},
  {name:'missing-action',vendor:true,unknown:true},
  {name:'http-error',unknown:true},
  {name:'empty',vendor:true,sink:'',unknown:true},
  {name:'wildcard',sink:'http-get:*:video/*:*'},
  {name:'av-only',unknown:true},
  {name:'iso-mpeg',sink:'http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5_ISO',mime:'video/mpeg'},
  {name:'audio-only',sink:'http-get:*:audio/aac:*',refused:true},
  {name:'rtsp-only',sink:'rtsp-rtp-udp:*:video/MP2T:*',refused:true},
  {name:'mp4-only',sink:'http-get:*:video/mp4:*',refused:true},
  {name:'ac3-only',sink:'http-get:*:video/MP2T:DLNA.ORG_PN=AVC_TS_HD_50_AC3',refused:true},
  {name:'ps-only',sink:'http-get:*:video/mpeg:DLNA.ORG_PN=MPEG_PS_PAL',refused:true},
  {name:'tts-192',sink:'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5',refused:true},
  {name:'reject-uri',vendor:true,unknown:true},
];
try{
  for(current of cases){
    actions=[];playRequested=false;allowPull=false;pull=null;
    if(current.vendor){
      const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',local);inner.searchParams.set('token','synthetic-only');
      const qr=new URL('https://wx.chunk.cn/projection/login');qr.searchParams.set('place_code','fixture');qr.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));
      await client.api('/api/purek/prepare',{qr_url:qr.href});
    }else await client.api('/api/purek/prepare',{url:local+'/description.xml'});
    const connected=await client.api('/api/purek/connect',{});
    assert.equal(connected.connected,true);
    assert.equal(connected.output.status==='unverified',Boolean(current.unknown),current.name);
    if(current.unknown){
      assert.deepEqual(connected.output.capabilities.sink_formats,[]);
      assert.equal(connected.output.capabilities.protocol_info_state,current.name==='empty'?'empty':'unavailable');
      if(current.name!=='empty')assert.ok(connected.output.capabilities.protocol_info_error);
    }
    assert.equal((await client.api('/api/state')).media_output.target,'local');
    assert.ok(!actions.includes('Play')&&!actions.includes('Stop')&&!actions.includes('SetAVTransportURI'),'connect never starts media');
    assert.equal((await remote.request('/api/player/output',{target:'purek',experimental:true})).status,403);
    assert.equal((await client.request('/api/player/output',{target:'purek'})).status,400);
    await client.api('/api/player/restart-program',{});
    if(current.refused){
      assert.equal((await client.request('/api/player/output',{target:'purek',experimental:true})).status,409);
      assert.ok(!actions.includes('SetAVTransportURI')&&!actions.includes('Play'));
      report.refused.push(current.name);
    }else{
      await client.api('/api/player/output',{target:'purek',experimental:true});
      if(current.name==='reject-uri'){
        await waitFor(async()=>(await client.api('/api/state')).media_output.status==='error','URI rejection');
        const state=await client.api('/api/state');assert.equal(state.media_output.target,'purek');assert.equal(state.media_output.desired_playing,false);
        assert.equal(state.media_output.qualified,false);assert.ok(!actions.includes('Play'));report.rejected_uri_held=true;
      }else{
        await waitFor(()=>playRequested,'real SOAP Play');
        assert.equal((await client.api('/api/state')).media_output.status,'starting','SOAP success alone is not streaming');
        allowPull=true;
        await waitFor(async()=>(await client.api('/api/state')).media_output.status==='streaming','actual media bytes');
        await waitFor(()=>pull,'receiver HTTP request');
        inspectTs(await pull,{videoFrames:144,channels:2,sampleRate:48000});
        const state=await client.api('/api/state');assert.equal(state.media_output.qualified,false);
        assert.equal(state.current_item.id,'purek-fixture-0');report.played.push(current.name);
      }
      await client.api('/api/player/output',{target:'local'});
      await waitFor(async()=>(await client.api('/api/state')).media_output.target==='local','explicit return');
    }
    await client.api('/api/purek/disconnect',{});
    assert.equal((await client.api('/api/purek/state')).output.capabilities.protocol_info_state,'not_checked');
    assert.deepEqual(failures,[]);
  }
  writeFileSync(process.env.BILIKARA_TEST_PUREK_REPORT,JSON.stringify(report,null,2)+'\n','utf8');
  process.stdout.write('purek-node-receiver-ok\n');
}finally{allowPull=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
