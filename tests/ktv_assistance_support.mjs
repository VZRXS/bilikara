// Test transport and independent receiver fixture only. No product state/policy.
import assert from 'node:assert/strict';
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {rmSync} from 'node:fs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {root} from './desktop_construction_support.mjs';
import {RunningHost,isolatedEnvironment,HttpClient,waitFor} from './native_host_support.mjs';
export {HttpClient,waitFor};
export async function startHost(t,binary,alpha=false){
  const home=ownedDirectory('KTV assistance');let server;
  t.after(async()=>{try{if(server)await server.close();}finally{rmSync(home,{recursive:true,force:true});}});
  const launch=()=>RunningHost.start(binary,home,alpha?[home,path.join(root,'static')]:['--headless','--port','0','--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],isolatedEnvironment(home),alpha);
  server=await launch();
  return {server,home,async restart(){await server.close();server=await launch();return server;}};
}
export function roomQr(base='http://192.168.123.231',token='synthetic-ktv-private'){
  const inner=new URL('https://conn.dolphinstar.cn/Remote');inner.searchParams.set('url',base);inner.searchParams.set('token',token);inner.searchParams.set('name','Fixture room');
  const outer=new URL('https://wx.chunk.cn/projection/login');outer.searchParams.set('projection_url',Buffer.from(inner.href).toString('base64url'));outer.searchParams.set('place_code','fixture');return outer.href;
}
export function stream(client){
  const controller=new AbortController(),frames=[];let finished=false;
  const task=(async()=>{
    const response=await fetch(client.base+'/api/events',{headers:{Cookie:[...client.cookies].map(([k,v])=>`${k}=${v}`).join('; ')},signal:controller.signal});
    assert.equal(response.status,200);let buffer='';
    for await(const chunk of response.body){buffer+=Buffer.from(chunk).toString('utf8');let at;while((at=buffer.indexOf('\n\n'))>=0){const text=buffer.slice(0,at);buffer=buffer.slice(at+2);const type=text.match(/^event: (.+)$/m)?.[1],data=text.match(/^data: (.+)$/m)?.[1];if(data)frames.push({type,data:JSON.parse(data)});}}
  })().catch(error=>{if(error.name!=='AbortError')throw error;}).finally(()=>{finished=true;});
  return {frames,get finished(){return finished;},latest:type=>frames.filter(f=>f.type===type).at(-1)?.data,async close(){controller.abort();await task;},async ready(){return waitFor(()=>this.latest('ktv'),'private SSE connection frame');}};
}
const service='urn:schemas-upnp-org:service:ConnectionManager:1';
const soap=(action,fields='',namespace=service)=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${namespace}">${fields}</u:${action}Response></s:Body></s:Envelope>`;
export async function receiver(t){
  const ip=Object.values(networkInterfaces()).flat().find(x=>x?.family==='IPv4'&&!x.internal&&(/^(10\.|192\.168\.)/.test(x.address)||/^172\.(1[6-9]|2\d|3[01])\./.test(x.address)))?.address;
  assert.ok(ip,'a real private local interface is required for the production URL validator; loopback is not a product exception');
  const state={authorized:false,identity:'receiver-one',protocol:'http-get:*:video/MP2T:*',deny:false,actions:[],descriptions:0,hold:null};
  const server=http.createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts).toString('utf8');res.setHeader('content-type','text/xml');
    if(req.method==='GET'){state.descriptions++;return res.end(`<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:${state.identity}</UDN><friendlyName>Fixture receiver</friendlyName><serviceList><service><serviceType>${service}</serviceType><controlURL>/manager</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/transport</controlURL></service></serviceList></device></root>`);}
    const action=String(req.headers.soapaction||'').match(/#([^"\s]+)/)?.[1];state.actions.push(action);
    if(action==='SetDeviceAuthorization'){
      if(state.hold)await state.hold;
      if(state.deny&&body.includes('<Enable>1</Enable>'))return res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode></s:Fault></s:Body></s:Envelope>');
      assert.ok(body.includes('<Token>synthetic-ktv-private</Token>'));state.authorized=body.includes('<Enable>1</Enable>');return res.end(soap(action));
    }
    if(action==='GetProtocolInfo'){
      if(state.protocolError){res.statusCode=503;return res.end('Independent capability query failure');}
      return res.end(soap(action,`<Source/><Sink>${state.protocol}</Sink>`));
    }
    if(action==='Stop')return res.end(soap(action,'','urn:schemas-upnp-org:service:AVTransport:1'));
    res.statusCode=500;res.end('Unexpected action');
  });await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {state,base:`http://${ip}:${server.address().port}`,description:`http://${ip}:${server.address().port}/description.xml`};
}
export async function peer(server,id,name='Same singer',profile='controller',epoch='abcdefghijklmnopqrstuv'){
  await server.api('/api/internet-remote/peer/open',{peer_id:id,epoch,profile});let seq=0;
  const send=async(kind,body={})=>{
    const response=await server.request('/api/internet-remote/dispatch',{peer_id:id,lane:'control',message:JSON.stringify({v:1,lane:'control',epoch,seq:++seq,id:crypto.randomUUID(),kind,body})});
    const payload=JSON.parse(response.body);if(response.status>=400||payload.ok===false)throw Object.assign(new Error(payload.code),{status:response.status,code:payload.code});return payload.data?.data;
  };
  if(profile==='controller')await send('session.set_identity',{name});
  return {send,close:()=>server.api('/api/internet-remote/peer/close',{peer_id:id})};
}
