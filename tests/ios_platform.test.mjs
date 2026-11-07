import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../static/ios-platform.js', import.meta.url), 'utf8');
function fixture({url = 'http://127.0.0.1:12345/', frame = false, nativeFailure = false,http=false} = {}) {
  const sent = [], controls = [], timers = new Map(), timerDelays = new Map(), events = new EventTarget(), document = new EventTarget();
  document.visibilityState = 'visible';
  let next = 0;
  const context = vm.createContext({URL, Uint8Array, crypto: webcrypto, Event, CustomEvent,
    Response,AbortController,DOMException,TextEncoder,
    location: new URL(url), document, setTimeout(fn, delay) {const id = ++next; timers.set(id, fn); timerDelays.set(id, delay); return id;},
    clearTimeout(id) {timers.delete(id); timerDelays.delete(id);}, addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events), webkit: {messageHandlers: {bilikaraPlatform: {postMessage(value) {
      if (nativeFailure) throw new Error('private credential payload');
      const request = JSON.parse(value);
      (['document', 'retire'].includes(request.action) ? controls : sent).push(request);
    }}}}});
  vm.runInContext(`globalThis.top = ${frame ? '{}' : 'globalThis'};`, context);
  vm.runInContext(source.replace('"__BILIKARA_IOS_ORIGIN__"', '"http://127.0.0.1:12345"').replace('"__BILIKARA_IOS_HTTP__"',JSON.stringify(http?'enabled':'disabled')), context);
  return {api: context.BilikaraIosPlatform, sent, controls, timers, timerDelays, events, document,
    reply(request, changes = {}) {context.BilikaraIosPlatform._receive({...request, ok: true, data: {opened: true}, ...changes});}};
}

test('native edge input is document-bound, bounded and retired with the page', () => {
  const page = fixture(), received = [];
  page.events.addEventListener('bilikara:ios-back', event => received.push(event.detail));
  const data = {document_id: page.controls[0].document_id, phase: 'changed', progress: .25, velocity: 20};
  for (const changes of [{document_id:'b'.repeat(32)}, {phase:'commit'}, {progress:NaN}, {progress:2}, {velocity:10001}]) {
    page.api._backGesture({...data,...changes});
  }
  assert.equal(received.length, 0);
  page.api._backGesture(data);
  assert.equal(received[0].progress, .25);
  page.events.dispatchEvent(new Event('pagehide'));
  page.api._backGesture({...data,phase:'ended'});
  assert.equal(received.length, 1);
});

test('iOS adapter is absent on Remote/iframe/external/wrong-port/startup pages', () => {
  for (const url of ['http://127.0.0.1:12345/remote', 'http://127.0.0.1:12345/controller.html',
    'http://127.0.0.1:12346/', 'http://localhost:12345/', 'https://account.bilibili.com/login',
    'tauri://localhost/ios-startup.html', 'http://127.0.0.1:12345/?redirect=1']) {
    const page = fixture({url}); assert.equal(page.api, undefined, url); assert.equal(page.sent.length, 0);
  }
  assert.equal(fixture({frame: true}).api, undefined);
});

test('login request uses a bounded document identity and only an actual opened reply succeeds', async () => {
  const page = fixture(); let finished = false;
  const opening = page.api.openLoginLink('https://account.bilibili.com/login').then(() => {finished = true;});
  assert.equal(page.sent.length, 1);
  const message = page.sent[0];
  assert.equal(message.action, 'open-bilibili-login');
  assert.equal(message.schema_version, 1);
  assert.match(message.document_id, /^[a-f0-9]{32}$/);
  assert.equal(message.id, 1);
  page.reply(message, {document_id: 'b'.repeat(32)}); await Promise.resolve(); assert.equal(finished, false);
  page.reply(message, {id: 2}); await Promise.resolve(); assert.equal(finished, false);
  page.reply(message); await opening;
  assert.equal(page.timers.size, 0);
  const failed = page.api.openLoginLink('https://passport.bilibili.com/');
  page.reply(page.sent.at(-1), {data: {opened: false}});
  await assert.rejects(failed, /ios_platform_failed/);
});

test('timeouts and page retirement release guards and late replies cannot resolve another document', async () => {
  const page = fixture(); const opening = page.api.openLoginLink('https://account.bilibili.com/');
  const request = page.sent[0];
  page.timers.values().next().value();
  await assert.rejects(opening, /timeout/);
  assert.equal(page.sent.at(-1).action, 'cancel');
  page.reply(request);
  const pending = page.api.openLoginLink('https://account.bilibili.com/');
  page.events.dispatchEvent(new Event('pagehide'));
  await assert.rejects(pending, /retired/);
  await assert.rejects(page.api.openLoginLink('https://account.bilibili.com/'), /busy/);
  assert.equal(page.sent.filter(item => item.action === 'cancel').length, 2);
  const other = fixture(); const newRequest = other.api.openLoginLink('https://account.bilibili.com/');
  other.reply(request); other.reply(other.sent[0]); await newRequest;
});

test('returning from external login requests one state refresh; failures hide native payloads', async () => {
  const page = fixture(); let refresh = 0;const sources=[];
  page.events.addEventListener('bilikara:ios-login-return', event => {refresh++;sources.push(event.detail.source);});
  const opening = page.api.openLoginLink('https://account.bilibili.com/');
  page.document.visibilityState = 'hidden'; page.document.dispatchEvent(new Event('visibilitychange'));
  page.document.visibilityState = 'visible'; page.document.dispatchEvent(new Event('visibilitychange'));
  page.reply(page.sent[0]); await opening;
  page.events.dispatchEvent(new Event('focus'));
  assert.equal(refresh, 1);
  assert.deepEqual(sources,['visibilitychange']);
  const failed = fixture({nativeFailure: true});
  await assert.rejects(failed.api.openLoginLink('https://account.bilibili.com/'), error => {
    assert.equal(error.message, 'ios_platform_unavailable'); return true;
  });
  assert.equal(failed.timers.size, 0);
});

test('a BFCache restore creates a new document generation and cannot replay the old opener', async () => {
  const page = fixture(); const old = page.api.openLoginLink('https://account.bilibili.com/');
  const request = page.sent[0]; page.events.dispatchEvent(new Event('pagehide'));
  await assert.rejects(old, /retired/);
  assert.equal(page.api.available(), false);
  const event = new Event('pageshow'); Object.defineProperty(event, 'persisted', {value: true});
  page.events.dispatchEvent(event); assert.equal(page.api.available(), true);
  const fresh = page.api.openLoginLink('https://account.bilibili.com/');
  const current = page.sent.at(-1);
  assert.notEqual(current.document_id, request.document_id);
  assert.equal(current.id, 1);
  page.reply(request); page.reply(current); await fresh;
  assert.equal(page.sent.filter(row => row.action === 'open-bilibili-login').length, 2);
});

test('native adapter validates actual frame/controller/view identity and retains no strong WebView cycle', () => {
  const native = readFileSync(new URL('../src-tauri/src/ios_platform.rs', import.meta.url), 'utf8');
  for (const fact of ['frame.isMainFrame()', 'allows_origin', 'message, webView', 'userContentController()',
    'Weak<HostWebView>', 'openURL_options_completionHandler', 'deadline', 'login_url']) assert.ok(native.includes(fact), fact);
  assert.ok(!native.includes('openURL(&'));
  const startup = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/ios-startup.json', import.meta.url), 'utf8'));
  assert.equal(startup.remote, undefined);
  assert.deepEqual(startup.permissions, ['allow-ios-host-status']);
});

test('immersive fullscreen uses typed native replies and retires its document on pagehide', async () => {
  const page = fixture();
  assert.equal(page.controls[0].action, 'document');
  assert.equal(page.controls[0].id, 0);
  await assert.rejects(page.api.setPlayerFullscreen('true'), /request/);
  assert.equal(page.sent.length, 0);
  const entering = page.api.setPlayerFullscreen(true);
  const request = page.sent[0];
  assert.equal(request.action, 'set-player-fullscreen');
  assert.equal(request.active, true);
  page.reply(request, {data: {active: false}});
  await assert.rejects(entering, /failed/);
  const retry = page.api.setPlayerFullscreen(true);
  page.reply(page.sent.at(-1), {data: {active: true}}); await retry;
  let resets = 0;
  page.events.addEventListener('bilikara:ios-fullscreen-reset', () => {resets++;});
  const exit = page.api.setPlayerFullscreen(false);
  page.events.dispatchEvent(new Event('pagehide'));
  await assert.rejects(exit, /retired/);
  assert.equal(resets, 1);
  assert.equal(page.controls.at(-1).action, 'retire');
  assert.equal(page.controls.at(-1).document_id, request.document_id);
  assert.equal(page.timers.size, 0);
});


test('native dock selection is document-bound, bounded, and retired with its page', async () => {
  const page = fixture(); const selected = [];
  page.events.addEventListener('bilikara:ios-dock-select', event => selected.push(event.detail.index));
  const facts = {visible:true,selected:0,labels:['Play','Queue','Request','Users','My'],viewport_width:393,viewport_height:844,dark:false,accent:[200,80,55]};
  const pending = page.api.syncDock(facts);
  const request = page.sent.at(-1);
  assert.equal(request.action, 'sync-dock'); assert.deepEqual(request.dock, facts);
  for (const index of [-1,5,1.5,'1']) page.api._dockSelected({document_id:request.document_id,index});
  page.api._dockSelected({document_id:'b'.repeat(32),index:1});
  assert.deepEqual(selected, []);
  page.api._dockSelected({document_id:request.document_id,index:4});
  assert.deepEqual(selected, [4]);
  page.reply(request, {data:{height:83}}); assert.equal((await pending).height,83);
  page.events.dispatchEvent(new Event('pagehide'));
  page.api._dockSelected({document_id:request.document_id,index:0});
  assert.deepEqual(selected,[4]);
});


test('iOS export waits for the actual Files result, disarms its preparation deadline and distinguishes cancel/failure', async()=>{
  const page=fixture();
  const saving=page.api.saveHistory('image','history',50);
  const request=page.sent.at(-1);
  assert.equal(request.action,'save-history');assert.deepEqual(JSON.parse(JSON.stringify(request.export)),{format:'image',source:'history',pageSize:50});
  let finished=false;saving.then(()=>{finished=true;});
  page.reply(request,{data:{status:'choosing'}});await Promise.resolve();
  assert.equal(finished,false);assert.equal(page.timers.size,0);
  page.reply(request,{data:{status:'saved'}});assert.equal(await saving,true);
  const cancelled=page.api.saveHistory('csv','played',200);page.reply(page.sent.at(-1),{data:{status:'cancelled'}});assert.equal(await cancelled,false);
  const failed=page.api.saveHistory('image','history',50);page.reply(page.sent.at(-1),{data:{status:'failed',errorMessage:'Disk full'}});await assert.rejects(failed,/Disk full/);
  for(const args of [['png','history',50],['csv','../private',50],['image','history',1]])await assert.rejects(page.api.saveHistory(...args),/options/);
  const retired=page.api.saveHistory('csv','played',50);page.reply(page.sent.at(-1),{data:{status:'choosing'}});page.events.dispatchEvent(new Event('pagehide'));await assert.rejects(retired,/retired/);
});

test('video opener has a separate action and retains document cancellation without login refresh',async()=>{
  const page=fixture();let refresh=0;page.events.addEventListener('bilikara:ios-login-return',()=>refresh++);
  const opening=page.api.openBilibiliVideo('https://www.bilibili.com/video/BV1yyjzzCEQn?p=2');
  const request=page.sent[0];assert.equal(request.action,'open-bilibili-video');
  page.reply(request,{document_id:'f'.repeat(32)});assert.equal(page.timers.size,1);
  page.reply(request);await opening;
  page.document.visibilityState='hidden';page.document.dispatchEvent(new Event('visibilitychange'));
  page.document.visibilityState='visible';page.document.dispatchEvent(new Event('visibilitychange'));assert.equal(refresh,0);
  const pending=page.api.openBilibiliVideo('https://www.bilibili.com/video/BV1yyjzzCEQn');
  page.events.dispatchEvent(new Event('pagehide'));await assert.rejects(pending,/retired/);
  assert.equal(page.sent.at(-1).action,'cancel');
});

test('native JSON bridge has independent limits, cancellation and no second POST attempt',async()=>{
  const page=fixture({http:true}),controller=new AbortController();
  const request={method:'POST',path:'/api/player/control',client_id:'fixture',body:{action:'pause'}};
  const operation=page.api.requestJson(request,controller.signal);await Promise.resolve();
  const sent=page.sent.find(r=>r.action==='request-json');assert.ok(sent);assert.deepEqual(sent.json_request,request);
  controller.abort();await assert.rejects(operation,e=>e.name==='AbortError');
  assert.equal(page.sent.filter(r=>r.action==='request-json').length,1);
  assert.ok(page.sent.some(r=>r.action==='cancel'&&r.id===sent.id));
  page.reply(sent,{data:{status:200,body:{ok:true}}});
  const next=page.api.requestJson({...request,method:'GET',body:undefined});await Promise.resolve();
  const current=page.sent.at(-1);page.reply(current,{data:{status:409,body:{ok:false,code:'stale_program'}}});
  assert.deepEqual(await next,{status:409,body:{ok:false,code:'stale_program'}});
  assert.equal(page.timers.size,0);
});

test('only first scanner qualification receives its native work budget', async () => {
  for (const [request, deadline] of [
    [{method:'POST',path:'/api/player/automatic-volume',body:{action:'enable',enabled:true}},130000],
    [{method:'POST',path:'/api/player/automatic-volume',body:{action:'enable',enabled:false}},35000],
    [{method:'POST',path:'/api/player/automatic-volume',body:{action:'cancel',enabled:true}},35000],
    [{method:'POST',path:'/api/player/control',body:{action:'pause'}},35000],
    [{method:'GET',path:'/api/state'},35000],
  ]) {
    const page=fixture({http:true}), operation=page.api.requestJson(request);
    await Promise.resolve();
    assert.deepEqual([...page.timerDelays.values()],[deadline]);
    page.reply(page.sent.at(-1),{data:{status:200,body:{ok:true}}});
    assert.equal((await operation).status,200);
    assert.equal(page.timers.size,0);
    assert.equal(page.sent.filter(value=>value.action==='request-json').length,1);
  }
});
