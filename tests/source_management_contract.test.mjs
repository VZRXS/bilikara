import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import {test} from 'node:test';
import {root} from './desktop_construction_support.mjs';
import {localSignaling} from './local_signaling_fixture.mjs';
const read = name => readFileSync(path.join(root,name),'utf8');

test('source completion observes coalesced same-second order changes once and ignores count-only updates',()=>{
  const context={window:{}};vm.runInNewContext(read('static/source-status.js'),context);
  const {takeCompletion}=context.window.BilikaraSourceStatus;
  const task={busy:false,last_status:'success',last_updated_at:100,last_message:'Order saved',last_result:{operation:'source_order',source_order_version:'a'.repeat(64)}};
  assert.equal(takeCompletion(task),false);
  const updated={...task,last_result:{...task.last_result,source_order_version:'b'.repeat(64)}};
  assert.equal(takeCompletion(updated),true);
  assert.equal(takeCompletion(updated),false);
  assert.equal(takeCompletion({...updated,last_result:{...updated.last_result,count:1000}}),false);
  assert.equal(takeCompletion({...updated,last_result:{operation:'remove_sources',source_order_version:'c'.repeat(64)}}),true);
});

test('Remote never loads or mounts the editor; legacy removal transport and shared pagination stay owned',()=>{
  const remote=read('static/remote.js'),html=read('static/remote.html'),sync=read('scripts/sync_internet_remote_assets.ps1');
  for(const source of [remote,html,sync])assert.doesNotMatch(source,/BilikaraSourceRemoval|source-removal\.(?:js|css)|sourceRemovalEditor/u);
  assert.match(read('static/remote-transport-client.js'),/gatcha\.source_remove/u);
  assert.match(html,/result-pagination\.js/u);
  const host=read('static/index.html');
  assert.ok(host.indexOf('/result-pagination.js')<host.indexOf('/source-removal.js'));
  assert.match(host,/source-removal\.css/u);
  for(const dictionary of Object.values(JSON.parse(read('static/i18n.json')).languages)){
    for(const key of ['selectMode','selectPage','selectedTotal','removeBatchConfirm','orderCard','longPressToSelect','selectSource','dragToRemove','orderUnavailable','removedCleanupPending','retryCleanup'])assert.equal(typeof dictionary['sources.'+key],'string');
  }
});

test('shared real WebSocket fixture handles Host leave and retires rejected application messages', {timeout:5000},async()=>{
  const sockets=new Set(),server=http.createServer();
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const counters={websocketConnections:0,signals:0},signaling=localSignaling(server,{counters});
  let closed=false;
  const connect=async role=>{
    const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}`,['bilikara-v1',`${role}.fixture.${role}-peer`]);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});return socket;
  };
  try {
    const host=await connect('host'),remote=await connect('remote');
    const remoteClosed=new Promise(resolve=>remote.onclose=resolve);
    host.send(JSON.stringify({type:'leave',to:'remote-peer',payload:{}}));
    assert.equal((await remoteClosed).code,1000);
    const rejected=new Promise(resolve=>host.onclose=resolve);
    host.send(JSON.stringify({type:'playlist.add',payload:{}}));
    assert.equal((await rejected).code,1008);
    closed=true;
    await assert.rejects(signaling.close(),/never relays application commands/u);
    assert.equal(signaling.lanes.size,0);
    assert.equal(counters.websocketConnections,2);
  } finally {
    for(const socket of sockets)socket.destroy();
    if(!closed)await signaling.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
