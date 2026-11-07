import assert from 'node:assert/strict';
import {test,before} from 'node:test';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildNativeHost} from './native_runtime_artifacts.mjs';
import {startHost,HttpClient,stream,waitFor,peer,roomQr,receiver} from './ktv_assistance_support.mjs';
let binary;before(async()=>{if(process.platform==='linux')binary=await buildNativeHost();},{timeout:300000});
const options={skip:process.platform!=='linux',timeout:90000};
async function check(phone,binding){
  const admitted=await phone.send('ktv.authorization.check',binding);
  assert.ok(['connecting','completed','error'].includes(admitted.session.status));
  return waitFor(async()=>{const view=await phone.send('ktv.status.get');return ['completed','error'].includes(view.session?.status)&&view;},'actual asynchronous receiver verification');
}

async function lanPhone(t,server,name='Same singer',registeredClient=null){
  const client=registeredClient||new HttpClient(server.base);
  if(!registeredClient){await client.request('/remote');await client.api('/api/remote-identity/register',{name});}
  const events=stream(client);t.after(()=>events.close());const frame=await events.ready();
  return {client,events,connection:frame.connection_id,close:()=>events.close(),async send(operation,fields={}){
    const response=await client.request('/api/ktv/remote',{connection_id:frame.connection_id,request:{operation,...fields}});
    const payload=JSON.parse(response.body);if(response.status>=400||!payload.ok)throw Object.assign(new Error(payload.code),{code:payload.code,status:response.status});return payload.data;
  }};
}

test('registered LAN and Internet peers are eligible and invitations stay exact-connection bound',options,async t=>{
  const {server}=await startHost(t,binary);
  const phone=new HttpClient(server.base);await phone.request('/remote');await phone.api('/api/remote-identity/register',{name:'Same singer'});
  const a=stream(phone),b=stream(phone);t.after(()=>a.close());t.after(()=>b.close());
  const first=await a.ready(),second=await b.ready();assert.notEqual(first.connection_id,second.connection_id);
  assert.equal(first.capabilities.scan,true);assert.equal(first.capabilities.submit,true);assert.equal(first.capabilities.resume,false);assert.equal(first.confidential,false);
  const guest=new HttpClient(server.base);await guest.request('/remote');const unregistered=stream(guest);t.after(()=>unregistered.close());const guestView=await unregistered.ready();
  assert.equal(guestView.capabilities.scan,false);
  const guestRequest={connection_id:guestView.connection_id,request:{operation:'ktv.scan.request'}};
  assert.equal((await guest.request('/api/ktv/remote',guestRequest)).status,409);
  assert.ok([401,403].includes((await new HttpClient(server.base).request('/api/ktv/remote',guestRequest)).status));
  assert.equal((await server.request('/api/ktv/host',{operation:'invite',connection_id:guestView.connection_id})).status,409);
  const one=await peer(server,'peer-one'),two=await peer(server,'peer-two');await peer(server,'viewer','Unused','viewer');
  const devices=(await server.api('/api/ktv/host')).devices;assert.equal(devices.length,4);assert.ok(devices.every(d=>d.name==='Same singer'));assert.equal(new Set(devices.map(d=>d.connection_id)).size,4);
  assert.equal(devices.filter(d=>d.transport==='lan'&&d.scan_eligible).length,2);assert.equal(devices.filter(d=>d.transport==='internet'&&d.scan_eligible).length,2);
  assert.equal((await phone.request('/api/ktv/host')).status,403);assert.equal((await phone.request('/api/ktv/internet-events')).status,403);
  const lanCall=async(operation,fields={})=>phone.api('/api/ktv/remote',{connection_id:second.connection_id,request:{operation,...fields}});
  const lanInvite=await server.api('/api/ktv/host',{operation:'invite',connection_id:second.connection_id});
  const lanBinding={request_id:lanInvite.session.request_id,host_epoch:second.host_epoch};
  assert.equal((await lanCall('ktv.scan.decline',lanBinding)).session.status,'declined');
  const transport=await phone.api('/api/ktv/remote',{connection_id:second.connection_id,request:{operation:'ktv.status.get'}},{'X-Forwarded-Proto':'https'});
  assert.equal(transport.confidential,false);assert.equal(transport.transport,'lan');
  const requested=await lanCall('ktv.scan.request');const bound={request_id:requested.session.request_id,host_epoch:second.host_epoch};
  assert.equal(requested.session.status,'approval_pending');
  assert.equal((await phone.request('/api/ktv/remote',{connection_id:second.connection_id,request:{operation:'ktv.scan.submit',...bound,url:roomQr()}})).status,409);
  await server.api('/api/ktv/host',{operation:'approve',...bound});
  assert.equal((await lanCall('ktv.scan.cancel',bound)).session.status,'canceled');
  assert.equal((await phone.request('/api/purek/prepare',{url:roomQr()})).status,403);
  const target=await two.send('ktv.status.get');assert.equal(target.capabilities.scan,true);
  const invite=await server.api('/api/ktv/host',{operation:'invite',connection_id:target.connection_id});
  const id=invite.session.request_id,epoch=target.host_epoch,binding={request_id:id,host_epoch:epoch};
  assert.equal((await two.send('ktv.status.get')).session.status,'pending');assert.equal((await one.send('ktv.status.get')).session,null);
  assert.equal(a.latest('ktv').session,null);assert.equal(b.latest('ktv').session,null);
  assert.equal((await guest.request('/api/ktv/remote',{connection_id:second.connection_id,request:{operation:'ktv.scan.accept',...binding}})).status,409,'another cookie cannot act as the LAN stream');
  await assert.rejects(one.send('ktv.scan.accept',binding),e=>e.code==='ktv_stale');
  assert.equal((await server.request('/api/ktv/host',{operation:'invite',connection_id:(await one.send('ktv.status.get')).connection_id})).status,409);
  for(const projection of[await phone.api('/api/state'),await server.api('/api/internet-remote/state')])assert.ok(!JSON.stringify(projection).includes(id));
  assert.equal((await two.send('ktv.scan.accept',binding)).session.status,'accepted');
  await assert.rejects(two.send('ktv.scan.accept',binding),e=>e.code==='ktv_stale');
  for(const url of[roomQr(),'http://192.168.1.8/description.xml','http://192.168.1.8/bearer-secret/description.xml']){
    const rejected=await phone.request('/api/ktv/remote',{connection_id:second.connection_id,request:{operation:'ktv.scan.submit',...binding,url}},{'X-Forwarded-Proto':'https'});
    assert.equal(rejected.status,409,'a LAN connection cannot use an Internet connection grant');
  }
  assert.equal((await server.api('/api/purek/state')).room_name,null);
  await b.close();await waitFor(async()=>(await server.api('/api/ktv/host')).devices.length===3,'retired LAN tab leaves only its exact presence');
  assert.equal((await two.send('ktv.status.get')).session.status,'accepted','unrelated LAN closure does not retire a secure grant');
  await two.close();assert.equal((await server.api('/api/ktv/host')).session.status,'disconnected');
});

for(const transport of ['internet','lan'])test(`${transport} requests require Host approval; real receiver authorization, identity and replacement checks own success`,options,async t=>{
  const {server,home}=await startHost(t,binary),tv=await receiver(t),phone=transport==='internet'?await peer(server,'phone'):await lanPhone(t,server);
  const logs=[];for(const pipe of [server.process.stdout,server.process.stderr])pipe.on('data',chunk=>logs.push(chunk));
  const initial=await phone.send('ktv.scan.request');assert.equal(initial.session.status,'approval_pending');const binding={request_id:initial.session.request_id,host_epoch:initial.host_epoch};
  await assert.rejects(phone.send('ktv.scan.submit',{...binding,url:roomQr(tv.base)}),e=>e.code==='ktv_stale');assert.equal((await server.api('/api/purek/state')).room_name,null);
  await server.api('/api/ktv/host',{operation:'approve',...binding});
  await assert.rejects(phone.send('ktv.scan.submit',{...binding,url:roomQr(tv.base).replace('wx.chunk.cn','evil.invalid')}),e=>e.code==='purek_description_invalid');
  const prepared=await phone.send('ktv.scan.submit',{...binding,url:roomQr(tv.base)});assert.equal(prepared.authorization_url,roomQr(tv.base));assert.equal(prepared.session.status,'authorization_pending');
  assert.equal(tv.state.actions.length,0,'scanning/authorization navigation never registers the receiver');
  for(const projection of [await server.api('/api/state'),await server.api('/api/internet-remote/state')])for(const secret of ['synthetic-ktv-private','projection_url',tv.description])assert.ok(!JSON.stringify(projection).includes(secret));
  tv.state.deny=true;let result=await check(phone,binding);assert.equal(result.session.status,'error');assert.equal(result.room.status,'error');assert.equal((await server.api('/api/purek/state')).connected,false);
  tv.state.deny=false;let releaseRetry;tv.state.hold=new Promise(resolve=>{releaseRetry=resolve;});t.after(()=>releaseRetry());
  const retry=await phone.send('ktv.authorization.check',binding);assert.equal(retry.session.status,'connecting');assert.equal(retry.session.error_code,null,'the current retry cannot advertise the previous authorization failure');assert.equal(retry.room.status,'connecting');
  tv.state.hold=null;releaseRetry();await waitFor(async()=>(await phone.send('ktv.status.get')).session.status==='completed','actual authorized retry completes');
  result=await phone.send('ktv.status.get');assert.equal(result.session.status,'completed');assert.equal((await server.api('/api/purek/state')).connected,true);
  assert.ok(tv.state.actions.includes('SetDeviceAuthorization'));assert.ok(tv.state.actions.includes('GetProtocolInfo'));assert.ok(tv.state.descriptions>=3,'actual receiver identity was re-read');
  await assert.rejects(phone.send('ktv.authorization.check',binding),e=>e.code==='ktv_stale');
  await assert.rejects(phone.send('ktv.scan.cancel',binding),e=>e.code==='ktv_stale');assert.equal(tv.state.authorized,true,'retiring a completed grant cannot disconnect the receiver');
  // Connected devices close both LAN and Internet scan grants. Host must disconnect.
  const current=await phone.send('ktv.status.get');assert.equal(current.capabilities.scan,false);assert.equal(current.capabilities.resume,false);
  await assert.rejects(phone.send('ktv.scan.request'),e=>e.code==='ktv_receiver_connected');
  assert.equal((await server.request('/api/ktv/host',{operation:'invite',connection_id:current.connection_id})).status,409);
  assert.equal(tv.state.authorized,true);
  await server.api('/api/purek/disconnect',{});assert.equal(tv.state.authorized,false);
  assert.equal((await phone.send('ktv.status.get')).capabilities.scan,true);
  const again=await phone.send('ktv.scan.request'),next={request_id:again.session.request_id,host_epoch:again.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...next});
  tv.state.actions=[];await phone.send('ktv.scan.submit',{...next,url:tv.description});result=await check(phone,next);
  assert.equal(result.room.connection_type,'dlna');assert.equal(result.session.status,'completed');assert.ok(!tv.state.actions.includes('SetDeviceAuthorization'),'ordinary DLNA never uses WeChat registration');
  assert.ok(tv.state.actions.includes('GetProtocolInfo'));
  tv.state.protocol='';await server.api('/api/purek/output/probe',{});assert.equal((await phone.send('ktv.status.get')).room.status,'capability_unverified');
  tv.state.protocol='http-get:*:audio/aac:*';await server.api('/api/purek/output/probe',{});assert.equal((await phone.send('ktv.status.get')).room.status,'capability_unverified');
  const advisory=(await server.api('/api/purek/state')).output;
  assert.equal(advisory.capabilities.protocol_info_state,'reported');
  assert.deepEqual(advisory.capabilities.sink_formats,[{mime:'audio/aac',profile:null}]);
  for(const [key,value]of Object.entries(advisory.capabilities))if(key.startsWith('supports_'))assert.equal(value,false);
  tv.state.protocolError=true;await server.api('/api/purek/output/probe',{});assert.equal((await phone.send('ktv.status.get')).room.status,'capability_unverified');assert.equal((await server.api('/api/purek/state')).connected,true,'a failed media query does not undo actual receiver authorization');
  for(const projection of [JSON.stringify(logs.map(x=>x.toString('utf8'))),JSON.stringify(phone.events?.frames||[]),JSON.stringify(await server.api('/api/ktv/internet-events'))])for(const secret of ['synthetic-ktv-private','projection_url',tv.description])assert.equal(projection.includes(secret),false,'credentials must not enter logs or event streams');
  const diagnostics=JSON.stringify(await server.api('/api/diagnostics/native'));assert.ok(!diagnostics.includes('synthetic-ktv-private'));assert.ok(!diagnostics.includes('projection_url'));
  for(const entry of readdirSync(home,{recursive:true,withFileTypes:true}).filter(x=>x.isFile())){
    const contents=readFileSync(path.join(entry.parentPath,entry.name));
    for(const secret of ['synthetic-ktv-private','projection_url',roomQr(tv.base),tv.description])assert.equal(contents.includes(Buffer.from(secret)),false,'receiver credentials must not enter persisted files');
  }
});

for(const transport of ['internet','lan'])test(`${transport} trusted Host retrieves an approved official link and completes the bound candidate`,options,async t=>{
  const {server,home}=await startHost(t,binary),tv=await receiver(t),phone=transport==='internet'?await peer(server,'handoff'):await lanPhone(t,server);
  const requested=await phone.send('ktv.scan.request'),binding={request_id:requested.session.request_id,host_epoch:requested.host_epoch};
  const link={operation:'authorization_link',...binding},checkRequest={operation:'check',...binding};
  assert.equal((await server.request('/api/ktv/host',link)).status,409,'an unapproved request has no readable candidate');
  await server.api('/api/ktv/host',{operation:'approve',...binding});
  assert.equal((await server.request('/api/ktv/host',link)).status,409,'approval alone has no scanned candidate');
  await phone.send('ktv.scan.submit',{...binding,url:roomQr(tv.base)});
  const before=await server.api('/api/ktv/host');
  assert.equal(before.candidate_owned,true);assert.equal(before.authorization_link_available,true);
  const remote=new HttpClient(server.base);await remote.request('/remote');
  for(const command of [link,checkRequest]){
    assert.equal((await remote.request('/api/ktv/host',command)).status,403);
    assert.equal((await new HttpClient(server.base).request('/api/ktv/host',command)).status,403);
  }
  const reply=await server.request('/api/ktv/host',link);
  assert.equal(reply.status,200);assert.equal(JSON.parse(reply.body).data.authorization_url,roomQr(tv.base));
  assert.match(reply.headers['cache-control'],/no-store/);
  assert.equal((await server.request('/api/ktv/host',{...link,host_epoch:'old-host'})).status,409);
  assert.equal((await server.request('/api/ktv/host',{...link,request_id:'old-request'})).status,409);
  assert.equal((await server.request('/api/ktv/host',{...link,url:roomQr(tv.base)})).status,400,'client-supplied links cannot override the stored candidate');
  assert.equal((await server.api('/api/ktv/host')).session.remaining_seconds<=before.session.remaining_seconds,true,'reading never renews the grant');
  assert.deepEqual(tv.state.actions,[],'retrieval never contacts or registers the receiver');
  const projections=[await server.api('/api/ktv/host'),await server.api('/api/state'),await remote.api('/api/state'),await server.api('/api/ktv/internet-events'),await server.api('/api/diagnostics/native'),phone.events?.frames||[]];
  for(const projection of projections)for(const secret of ['projection_url','synthetic-ktv-private',roomQr(tv.base),tv.description])assert.equal(JSON.stringify(projection).includes(secret),false);
  tv.state.deny=true;await server.api('/api/ktv/host',checkRequest);
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='error','Host sees actual registration denial');
  assert.equal((await server.api('/api/ktv/host',link)).authorization_url,roomQr(tv.base),'a failed official check remains explicitly retryable');
  tv.state.deny=false;await server.api('/api/ktv/host',checkRequest);
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='completed','trusted Host completes the bound asynchronous registration');
  assert.equal((await server.api('/api/purek/state')).connected,true);
  assert.equal((await server.api('/api/ktv/host')).authorization_link_available,false);
  assert.equal((await server.request('/api/ktv/host',link)).status,409);
  for(const entry of readdirSync(home,{recursive:true,withFileTypes:true}).filter(x=>x.isFile())){
    const contents=readFileSync(path.join(entry.parentPath,entry.name));
    assert.equal(contents.includes(Buffer.from(roomQr(tv.base))),false,'official links remain process-local');
  }
});

for(const transport of ['internet','lan'])test(`${transport} cancellation of in-flight receiver registration rolls back before another room can start`,options,async t=>{
  const {server}=await startHost(t,binary),tv=await receiver(t),phone=transport==='internet'?await peer(server,'phone'):await lanPhone(t,server);
  let value=await phone.send('ktv.scan.request');const bound={request_id:value.session.request_id,host_epoch:value.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...bound});await phone.send('ktv.scan.submit',{...bound,url:roomQr(tv.base)});
  let release;tv.state.hold=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const checking=await phone.send('ktv.authorization.check',bound);assert.equal(checking.session.status,'connecting');
  await waitFor(()=>tv.state.actions.includes('SetDeviceAuthorization'),'registration reached independent receiver');
  await server.api('/api/ktv/host',{operation:'cancel',...bound});assert.equal((await server.api('/api/purek/state')).busy,true,'rollback still owns the receiver lease');
  assert.equal((await server.api('/api/purek/state')).room_name,null,'the canceled candidate is no longer staged');
  assert.equal((await server.api('/api/internet-remote/state')).ktv_room.status,'disconnected');
  assert.equal((await server.request('/api/purek/prepare',{url:tv.description})).status,409,'rollback cannot be replaced by another room');
  tv.state.hold=null;release();
  await waitFor(async()=>!(await server.api('/api/purek/state')).busy,'retired I/O released its own lease');assert.equal(tv.state.authorized,false);
  assert.equal((await server.api('/api/purek/state')).connected,false);assert.equal((await server.api('/api/ktv/host')).session.status,'canceled');
  await server.api('/api/purek/prepare',{url:tv.description});
  await assert.rejects(phone.send('ktv.scan.cancel',bound),e=>e.code==='ktv_stale');
  assert.equal((await server.api('/api/purek/state')).connection_type,'dlna','late cancellation leaves unrelated Host-owned staging alone');
});

test('LAN disconnect discards private staging and a new connection cannot reclaim the old grant',options,async t=>{
  const {server}=await startHost(t,binary),tv=await receiver(t),a=await lanPhone(t,server),b=await lanPhone(t,server,'Same singer',a.client);
  const request=await a.send('ktv.scan.request'),old={request_id:request.session.request_id,host_epoch:request.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...old});
  await a.send('ktv.scan.submit',{...old,url:roomQr(tv.base)});
  assert.equal((await a.send('ktv.authorization.link.get',old)).authorization_url,roomQr(tv.base));
  assert.equal((await server.api('/api/ktv/host',{operation:'authorization_link',...old})).authorization_url,roomQr(tv.base));
  await assert.rejects(b.send('ktv.authorization.link.get',old),e=>e.code==='ktv_stale');
  await assert.rejects(a.send('ktv.authorization.check',{...old,host_epoch:'obsolete-epoch'}),e=>e.code==='ktv_stale');
  await a.close();await waitFor(async()=>(await server.api('/api/ktv/host')).session?.status==='disconnected','LAN stream retirement');
  assert.equal((await server.api('/api/purek/state')).room_name,null);
  assert.equal((await server.request('/api/ktv/host',{operation:'authorization_link',...old})).status,409,'a trusted Host cannot resurrect disconnected LAN staging');
  assert.equal((await b.send('ktv.status.get')).recovery_available,false);
  assert.equal((await b.send('ktv.status.get')).capabilities.resume,false);
  await assert.rejects(b.send('ktv.authorization.resume.request'),e=>e.code==='ktv_secure_transport_required');
  await assert.rejects(a.send('ktv.authorization.check',old),e=>e.code==='ktv_offline');
  const c=await lanPhone(t,server,'Same singer',a.client),next=await c.send('ktv.scan.request'),binding={request_id:next.session.request_id,host_epoch:next.host_epoch};
  assert.notEqual(next.connection_id,request.connection_id);
  await assert.rejects(c.send('ktv.scan.accept',old),e=>e.code==='ktv_stale');
  await server.api('/api/ktv/host',{operation:'approve',...binding});
  await assert.rejects(c.send('ktv.authorization.check',binding),e=>e.code==='ktv_scan_required');
  await c.send('ktv.scan.cancel',binding);
  const fresh=await c.send('ktv.scan.request'),registered={request_id:fresh.session.request_id,host_epoch:fresh.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...registered});
  await c.send('ktv.scan.submit',{...registered,url:roomQr(tv.base)});
  await server.api('/api/session-users/remove',{name:'Same singer'});
  assert.equal((await c.send('ktv.status.get')).capabilities.scan,false);
  assert.equal((await server.request('/api/ktv/host',{operation:'authorization_link',...registered})).status,409,'removed identity revokes Host link retrieval too');
  await assert.rejects(c.send('ktv.authorization.check',registered),e=>e.code==='ktv_stale');
  assert.equal((await server.api('/api/purek/state')).room_name,null);assert.deepEqual(tv.state.actions,[]);
});

test('A cancels X; a same-user tab with fresh Host approval cannot check X without its own scan',options,async t=>{
  const {server}=await startHost(t,binary),tv=await receiver(t),a=await peer(server,'tab-a'),b=await peer(server,'tab-b');
  assert.notEqual((await a.send('ktv.status.get')).connection_id,(await b.send('ktv.status.get')).connection_id);
  const first=await a.send('ktv.scan.request'),old={request_id:first.session.request_id,host_epoch:first.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...old});await a.send('ktv.scan.submit',{...old,url:roomQr(tv.base)});
  await a.send('ktv.scan.cancel',old);
  assert.equal((await server.api('/api/purek/state')).room_name,null);
  assert.equal((await server.api('/api/internet-remote/state')).ktv_room.status,'disconnected');
  const request=await b.send('ktv.scan.request'),bound={request_id:request.session.request_id,host_epoch:request.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...bound});
  await assert.rejects(b.send('ktv.authorization.check',bound),e=>e.code==='ktv_scan_required');
  await assert.rejects(b.send('ktv.authorization.link.get',bound),e=>e.code==='ktv_scan_required');
  await assert.rejects(a.send('ktv.authorization.check',old),e=>e.code==='ktv_stale');
  assert.equal((await b.send('ktv.status.get')).candidate_owned,false);
  assert.equal((await server.api('/api/purek/state')).connected,false);assert.deepEqual(tv.state.actions,[]);
  await b.send('ktv.scan.cancel',bound);await server.api('/api/purek/prepare',{url:tv.description});
  const fresh=await b.send('ktv.scan.request'),next={request_id:fresh.session.request_id,host_epoch:fresh.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...next});
  assert.equal((await server.api('/api/purek/state')).connection_type,'dlna','fresh approval preserves unrelated Host-owned staging');
  await assert.rejects(b.send('ktv.authorization.check',next),e=>e.code==='ktv_scan_required');
  await assert.rejects(b.send('ktv.authorization.link.get',next),e=>e.code==='ktv_scan_required');assert.deepEqual(tv.state.actions,[],'a nonempty room alone cannot authorize a fresh Remote');
});

test('disconnected staging needs separate explicit resume approval, even for the same username',options,async t=>{
  const {server}=await startHost(t,binary),tv=await receiver(t),a=await peer(server,'tab-a'),b=await peer(server,'tab-b');
  const request=await a.send('ktv.scan.request'),old={request_id:request.session.request_id,host_epoch:request.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...old});await a.send('ktv.scan.submit',{...old,url:roomQr(tv.base)});
  const originalRemaining=(await a.send('ktv.status.get')).session.remaining_seconds;
  await a.close();
  const recovery=await b.send('ktv.status.get');assert.equal(recovery.recovery_available,true);assert.equal(recovery.candidate_owned,false);assert.equal(recovery.room.status,'disconnected');
  assert.equal((await server.request('/api/ktv/host',{operation:'authorization_link',...old})).status,409,'parked Internet recovery is not a live authorization grant');
  // An unapproved request cannot erase somebody else's safely retained record.
  const scan=await b.send('ktv.scan.request'),scanBinding={request_id:scan.session.request_id,host_epoch:scan.host_epoch};
  await b.send('ktv.scan.cancel',scanBinding);assert.equal((await b.send('ktv.status.get')).recovery_available,true);
  const pending=await b.send('ktv.authorization.resume.request'),bound={request_id:pending.session.request_id,host_epoch:pending.host_epoch};
  assert.equal(pending.session.kind,'resume');assert.equal(pending.session.status,'approval_pending');
  await assert.rejects(b.send('ktv.authorization.check',bound),e=>e.code==='ktv_stale');
  await assert.rejects(b.send('ktv.authorization.link.get',bound),e=>e.code==='ktv_stale');
  assert.equal((await server.request('/api/ktv/host',{operation:'approve',...bound})).status,409,'ordinary scan approval cannot authorize recovery');
  assert.equal((await server.request('/api/ktv/host',{operation:'authorization_link',...bound})).status,409,'pending resume approval cannot read the parked link');
  assert.deepEqual(tv.state.actions,[]);
  await server.api('/api/ktv/host',{operation:'approve_resume',...bound});
  const resumed=await b.send('ktv.status.get');assert.equal(resumed.candidate_owned,true);assert.equal(resumed.recovery_available,false);assert.ok(resumed.session.remaining_seconds<=originalRemaining);
  assert.equal((await server.api('/api/ktv/host',{operation:'authorization_link',...bound})).authorization_url,roomQr(tv.base));
  assert.equal((await server.request('/api/ktv/host',{operation:'authorization_link',...old})).status,409,'old request IDs cannot read a newly approved binding');
  for(const projection of[await server.api('/api/internet-remote/state'),await server.api('/api/ktv/internet-events')])assert.ok(!JSON.stringify(projection).includes('projection_url'));
  assert.equal((await b.send('ktv.authorization.link.get',bound)).authorization_url,roomQr(tv.base));
  tv.state.deny=true;assert.equal((await check(b,bound)).session.status,'error');assert.equal((await server.api('/api/purek/state')).connected,false);
  tv.state.deny=false;assert.equal((await check(b,bound)).session.status,'completed');assert.equal((await server.api('/api/purek/state')).connected,true);
  assert.ok(tv.state.actions.includes('SetDeviceAuthorization'));assert.ok(tv.state.actions.includes('GetProtocolInfo'));
});

test('a fresh approved scan discards recovery instead of silently rebinding a prior candidate',options,async t=>{
  const {server}=await startHost(t,binary),tv=await receiver(t),a=await peer(server,'scan-a'),b=await peer(server,'scan-b');
  const first=await a.send('ktv.scan.request'),old={request_id:first.session.request_id,host_epoch:first.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...old});await a.send('ktv.scan.submit',{...old,url:roomQr(tv.base)});await a.close();
  assert.equal((await b.send('ktv.status.get')).recovery_available,true);
  const fresh=await b.send('ktv.scan.request'),bound={request_id:fresh.session.request_id,host_epoch:fresh.host_epoch};
  await server.api('/api/ktv/host',{operation:'approve',...bound});
  assert.equal((await server.api('/api/purek/state')).room_name,null);
  assert.equal((await b.send('ktv.status.get')).recovery_available,false);
  await assert.rejects(b.send('ktv.authorization.check',bound),e=>e.code==='ktv_scan_required');assert.deepEqual(tv.state.actions,[]);
});

test('the bundled QR decoder and complete license retain their independently pinned bytes',()=>{
  for(const [file,expected]of[['qr-decoder.js','bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859'],['qr-decoder.LICENSE','b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1']])assert.equal(createHash('sha256').update(readFileSync(new URL('../static/'+file,import.meta.url))).digest('hex'),expected);
});

test('real invitation deadline expires without an offline queue and rejects a late acceptance',options,async t=>{
  const {server}=await startHost(t,binary),phone=await peer(server,'expiry-phone'),view=await phone.send('ktv.status.get');
  await server.api('/api/ktv/host',{operation:'invite',connection_id:view.connection_id});
  const pending=await phone.send('ktv.status.get');assert.ok(pending.session.remaining_seconds>=55&&pending.session.remaining_seconds<=60);
  await waitFor(async()=>(await server.api('/api/ktv/host')).session.status==='expired','server monotonic invitation deadline',66000);
  await assert.rejects(phone.send('ktv.scan.accept',{request_id:pending.session.request_id,host_epoch:pending.host_epoch}),e=>e.code==='ktv_stale');
  assert.equal((await server.api('/api/purek/state')).room_name,null);
});

test('actual Host restart retires old epochs, grants and staged private credentials',options,async t=>{
  const fixture=await startHost(t,binary),phone=await peer(fixture.server,'restart-phone');
  const pending=await phone.send('ktv.scan.request'),bound={request_id:pending.session.request_id,host_epoch:pending.host_epoch};
  await fixture.server.api('/api/ktv/host',{operation:'approve',...bound});await phone.send('ktv.scan.submit',{...bound,url:roomQr()});
  const restarted=await fixture.restart();assert.equal((await restarted.api('/api/purek/state')).room_name,null);
  assert.equal((await restarted.request('/api/internet-remote/peer/open',{peer_id:'early',epoch:'abcdefghijklmnopqrstuv',profile:'controller'})).status,409,'existing startup-session consent remains required');
  await restarted.api('/api/session/startup-choice',{choice:'continue'});
  const next=await peer(restarted,'restart-phone'),current=await next.send('ktv.status.get');assert.notEqual(current.host_epoch,bound.host_epoch);assert.equal(current.session,null);
  assert.equal(current.recovery_available,false);await assert.rejects(next.send('ktv.authorization.resume.request'),e=>e.code==='ktv_resume_unavailable');
  await assert.rejects(next.send('ktv.authorization.check',bound),e=>e.code==='ktv_stale');
  assert.equal((await restarted.api('/api/purek/state')).connected,false);
});
