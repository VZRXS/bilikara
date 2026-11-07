import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';

const injected = readFileSync(new URL('../static/ios-presentation.js', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../static/android-presentation.js', import.meta.url), 'utf8');
function fixture({url = 'http://127.0.0.1:12345/', generation = 0, frame = false, pipe = true} = {}) {
  const sent = [], timers = new Map(), events = new EventTarget(), document = new EventTarget();
  let next = 0;
  const context = vm.createContext({URL, Uint8Array, crypto: webcrypto, Event, CustomEvent,
    location: new URL(url), document, setTimeout(fn) {const id = ++next; timers.set(id, fn); return id;},
    clearTimeout(id) {timers.delete(id);}, addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    webkit: pipe ? {messageHandlers:{bilikaraPresentation:{postMessage(raw) {sent.push(JSON.parse(raw));}}}} : {},
  });
  vm.runInContext(`globalThis.window=globalThis;globalThis.top=${frame ? '{}' : 'globalThis'};`, context);
  vm.runInContext(injected.replace('"__BILIKARA_PRESENTATION_ORIGIN__"','"http://127.0.0.1:12345"')
    .replace('__BILIKARA_PRESENTATION_GENERATION__', String(generation)), context);
  vm.runInContext(shared, context);
  const receiver = context.BilikaraIosPresentationReceiver;
  return {context, api:context.BilikaraNativePresentation, sent, events, timers,
    requests:() => sent.filter(r=>r.id),
    reply(request, data = null, documentId = request.document_id) {
      receiver.reply(documentId, {id:request.id, ok:true, data});
    },
    event(name, payload, documentId = sent.at(-1).document_id) {receiver.event(documentId,name,payload);},
  };
}

test('iOS presentation adapter only exists on native-created exact Host/audience frames', () => {
  for (const url of ['http://127.0.0.1:12345/remote','http://127.0.0.1:12345/controller.html',
    'http://127.0.0.1:12346/','http://localhost:12345/','http://127.0.0.1:12345/?redirect=1',
    'http://127.0.0.1:12345/#fragment','https://account.bilibili.com/']) {
    const page = fixture({url}); assert.equal(page.api,undefined,url); assert.equal(page.sent.length,0);
  }
  assert.equal(fixture({frame:true}).api,undefined);
  const audience=fixture({generation:3,url:'http://127.0.0.1:12345/controller.html?presentationGeneration=3'});
  assert.equal(audience.api.platform,'ios');
  assert.equal(fixture({generation:3,url:'http://127.0.0.1:12345/controller.html?presentationGeneration=2'}).api,undefined);
  assert.equal(fixture({generation:3,url:'http://127.0.0.1:12345/'}).api,undefined);
  assert.equal(audience.context.__TAURI__,undefined);
  assert.equal(audience.context.BilikaraAndroidPresentation,undefined);
});

test('shared adapter uses document-bound native replies, without exposing general IPC', async () => {
  const page=fixture(), request=page.api.invoke('get_presentation_displays'); let finished=false;
  request.then(()=>{finished=true;});
  const sent=page.requests()[0]; assert.match(sent.document_id,/^[a-f0-9]{32}$/);
  assert.equal(sent.schema_version,1); assert.equal(sent.command,'get_presentation_displays');
  assert.equal(page.sent.at(-2).command,'document');
  page.reply(sent,{},'b'.repeat(32)); await Promise.resolve(); assert.equal(finished,false);
  page.reply({...sent,id:'unrelated'},{}); await Promise.resolve(); assert.equal(finished,false);
  page.reply(sent,{displays:[]}); assert.equal((await request).displays.length,0);
  assert.equal(page.timers.size,0);
  await assert.rejects(page.api.invoke('open-bilibili-login'),/unsupported_command/);
  await assert.rejects(page.api.invoke('send_presentation_command'),/unsupported_command/);
  assert.equal(page.requests().length,1);
});

test('native events and real shared master envelopes retain role, generation and foreground', async () => {
  const page=fixture(), received=[];
  const unlisten=await page.api.listen('master-state',event=>received.push(event.payload));
  const envelope={protocol:1,type:'master-state',sequence:1,payload:{scene:{generation:4},clock:{paused:false}}};
  page.api.postMaster(envelope);
  const sent=page.sent.at(-1);assert.equal(sent.command,'master-state');assert.equal(sent.id,undefined);
  assert.deepEqual(sent.args,envelope);
  page.event('master-state',envelope,'0'.repeat(32)); await Promise.resolve();assert.equal(received.length,0);
  page.event('master-state',envelope); await Promise.resolve();assert.deepEqual(received,[envelope]);
  page.event('foreground',{foreground:false});assert.equal(page.api.isForeground(),false);
  page.event('output-diagnostics',{dropped_frames:2});assert.equal(page.api.diagnostics().output.dropped_frames,2);
  unlisten();page.event('master-state',envelope);await Promise.resolve();assert.equal(received.length,1);
});

test('retirement rejects pending calls; BFCache uses a fresh document and ignores old replies', async () => {
  const page=fixture(), pending=page.api.invoke('get_presentation_session'), old=page.requests()[0];
  page.events.dispatchEvent(new Event('pagehide'));await assert.rejects(pending,/display_page_closed/);
  assert.equal(page.sent.at(-1).command,'retire');assert.equal(page.timers.size,0);
  await assert.rejects(page.api.invoke('get_presentation_session'),/display_page_closed/);
  const restore=new Event('pageshow');Object.defineProperty(restore,'persisted',{value:true});page.events.dispatchEvent(restore);
  const fresh=page.api.invoke('get_presentation_session'), current=page.requests().at(-1);
  assert.notEqual(current.document_id,old.document_id);
  page.reply(old);page.reply(current,{generation:4});assert.equal((await fresh).generation,4);
});

test('timeouts, bounded pending calls and missing native pipe fail without leaking guards', async () => {
  const absent=fixture({pipe:false});await assert.rejects(absent.api.invoke('get_presentation_session'),/display_unavailable/);
  assert.equal(absent.timers.size,0);
  const page=fixture(), pending=Array.from({length:24},()=>page.api.invoke('get_presentation_session'));
  const outcomes=pending.map(p=>assert.rejects(p,/display_timeout/));
  await assert.rejects(page.api.invoke('get_presentation_session'),/display_busy/);
  const callbacks=[...page.timers.values()];page.timers.clear();for(const expire of callbacks)expire();
  await Promise.all(outcomes);assert.equal(page.requests().length,24);
});
