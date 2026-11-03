import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import {test} from 'node:test';
import {root} from './desktop_construction_support.mjs';
import {localSignaling} from './local_signaling_fixture.mjs';
const read = name => readFileSync(path.join(root,name),'utf8');

test('source insertion exposes both outer edges and requires deliberate row crossing',()=>{
  const context={window:{BilikaraSessionUserEditor:{trashIcon:''}}};
  vm.runInNewContext(read('static/source-removal.js'),context);
  const {dropPosition}=context.window.BilikaraSourceRemoval;
  const cards=[0,1,2].map(index=>({id:index,left:index*110,right:index*110+100}));
  const rows=[{top:0,bottom:72,cards},{top:80,bottom:152,cards},{top:160,bottom:232,cards}];
  assert.equal(dropPosition(rows,0,0,36).before,true);
  assert.equal(dropPosition(rows,0,320,36).before,false);
  assert.equal(dropPosition(rows,0,50,81).rowIndex,0,'just entering the next row does not jump');
  assert.equal(dropPosition(rows,0,50,96).rowIndex,1,'deliberately entering the row does switch');
  assert.equal(dropPosition(rows,1,50,71).rowIndex,1,'boundary jitter stays on the selected row');
  assert.equal(dropPosition(rows,1,50,56).rowIndex,0,'upward crossing uses the same dead band');
  assert.equal(dropPosition(rows,0,50,196).rowIndex,2,'a large movement can reach further rows');
});

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

test('only trusted pending folders retain an empty saved-library selection, with their shared title',()=>{
  const context={window:{}};vm.runInNewContext(read('static/source-status.js'),context);
  const {selectedFolderId,selectedFolder}=context.window.BilikaraSourceStatus;
  const task={source_queue:{active:{uid:'42',folder_ids:['12'],folder_titles:{12:'Fixture favorites'}},pending:[{uid:'43',folder_ids:['13']}]}};
  assert.equal(selectedFolderId(task,'','42:12'),'42:12');
  assert.equal(selectedFolderId(task,'','43:13'),'43:13');
  assert.equal(selectedFolderId(task,'','43:12'),'');
  assert.equal(selectedFolderId(task,'','99:99'),'');
  assert.equal(selectedFolderId({},'','42:12'),'');
  assert.equal(selectedFolderId({},'42:10','42:12'),'42:10');
  assert.equal(selectedFolder(task,[],'42:12').title,'Fixture favorites');
  assert.equal(selectedFolder(task,[{id:'42:12',title:'Saved title'}],'42:12').title,'Saved title');
  assert.equal(selectedFolder(task,[],'43:12'),null);
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
