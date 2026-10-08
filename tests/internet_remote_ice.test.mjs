import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = name => readFileSync(new URL(`../static/${name}`, import.meta.url), 'utf8');
const candidate = index => ({ candidate: `candidate:${index} 1 udp 1 192.0.2.1 ${5000 + index} typ srflx`, sdpMid: '0', sdpMLineIndex: 0 });
const event = (type, values) => Object.assign(new Event(type), values);

// Transport boundaries/UI use isolated fixtures. Load the production owners
// verbatim; actual native dispatch and real RTC have a separate browser gate.
function ownerFixture(role) {
  class Peer extends EventTarget {
    constructor() {
      super();
      this.iceGatheringState = 'gathering';
      this.connectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.added = [];
    }
    createDataChannel(label) { return Object.assign(new EventTarget(), { label, readyState: 'connecting', close() {} }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { if (this.remoteGate) await this.remoteGate; this.remoteDescription = value; }
    async addIceCandidate(value) { assert.ok(this.remoteDescription, 'must wait for the remote description'); this.added.push(value); }
    close() { this.connectionState = 'closed'; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; this.frames = []; }
    send(value) { this.frames.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  }
  const storage = new Map();
  const sandbox = {
    console, crypto: webcrypto, TextEncoder, Event, CustomEvent, URLSearchParams, URL, Response, btoa, performance, AbortController,
    RTCPeerConnection: Peer, WebSocket: Socket,
    fetch: async () => { throw new Error('Unexpected HTTP request'); },
    location: { hash: `#room=${'R'.repeat(27)}&join=${'J'.repeat(43)}`, href: 'https://remote.example.test/remote.html', origin: 'https://remote.example.test', protocol: 'https:', hostname: 'remote.example.test' },
    localStorage: { getItem: key => storage.get(key) || '', setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {},
    // Deterministically reach the production gathering deadline; no long timers
    // or authentication retries escape this isolated fixture.
    setTimeout: (fn, ms) => ms === 8_000 ? setTimeout(fn, 1) : 0,
    clearTimeout, clearInterval, setInterval: () => 0,
    document: { readyState: 'loading', addEventListener() {}, documentElement: { dataset: {} } },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source('internet-remote-transport.js'), context);
  const host = role === 'host';
  const expose = host
    ? 'render = () => {}; setStatus = () => {}; window.owner = { state, peers, createPeer, connectSignaling, closePeer, queueState, handlePeerMessage }; })();'
    : 'global.owner = { state, acceptOffer, connectSignaling, resetPeer, request, handleDataMessage }; })(globalThis);';
  vm.runInContext(source(host ? 'internet-remote-host.js' : 'remote-transport-client.js')
    .replace(host ? /\}\)\(\);\s*$/u : /\}\)\(globalThis\);\s*$/u, expose), context);
  const owner = sandbox.owner;
  if (host) Object.assign(owner.state, { stopped: false, roomId: 'R'.repeat(27), hostToken: 'H'.repeat(43), hostPeerId: 'P'.repeat(22) });
  else owner.state.connectButton = { disabled: false, dataset: {}, hasAttribute: () => false, removeAttribute() {} };
  owner.connectSignaling();
  return { owner, sandbox, peerId: 'P'.repeat(22) };
}

for (const role of ['host', 'remote']) {
  test(`${role} sends candidates gathered after the SDP deadline`, async () => {
    const { owner, peerId } = ownerFixture(role);
    if (role === 'host') await owner.createPeer(peerId);
    else await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
    const peer = role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer;
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
    const frames = owner.state.socket.frames;
    assert.deepEqual(frames.map(frame => frame.type), [role === 'host' ? 'offer' : 'answer', 'candidate']);
    assert.deepEqual(frames[1].payload, candidate(1));
    const before = frames.length;
    if (role === 'host') owner.closePeer(peerId, false);
    else owner.resetPeer();
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(2) } }));
    assert.equal(frames.length, before, 'a retired peer must not signal for its replacement');
  });
}

test('Host queues early candidates until the answer is applied, then preserves order', async () => {
  const { owner, peerId } = ownerFixture('host');
  await owner.createPeer(peerId);
  const peer = owner.peers.get(peerId).pc;
  const socket = owner.state.socket;
  let release;
  peer.remoteGate = new Promise(resolve => { release = resolve; });
  const incoming = (type, payload) => socket.dispatchEvent(event('message', { data: JSON.stringify({ from: peerId, type, payload }) }));
  incoming('candidate', candidate(1));
  incoming('answer', { type: 'answer', sdp: 'v=0\r\n' });
  incoming('candidate', candidate(2));
  assert.deepEqual(peer.added, []);
  release(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1), candidate(2)]);
  incoming('candidate', candidate(3)); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1), candidate(2), candidate(3)]);
  owner.closePeer(peerId, false);
  incoming('candidate', candidate(4)); await tick();
  assert.equal(peer.added.length, 3);
});

test('Remote consumes trickled candidates only from its current signaling socket', async () => {
  const { owner } = ownerFixture('remote');
  const retired = owner.state.socket;
  owner.connectSignaling();
  await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
  const peer = owner.state.peer;
  const frame = JSON.stringify({ from: 'H'.repeat(22), type: 'candidate', payload: candidate(1) });
  retired.dispatchEvent(event('message', { data: frame }));
  await tick(); assert.equal(peer.added.length, 0);
  owner.state.socket.dispatchEvent(event('message', { data: frame }));
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(peer.added)), [candidate(1)]);
  owner.resetPeer();
});

test('retired Host signaling cannot expire the replacement room', () => {
  const { owner } = ownerFixture('host');
  const retired = owner.state.socket;
  owner.connectSignaling();
  const current = owner.state.socket;
  retired.dispatchEvent(event('close', { code: 4003 }));
  assert.equal(owner.state.socket, current);
  assert.equal(owner.state.expired, false);
  assert.equal(owner.state.stopped, false);
});

test('retired Remote signaling cannot overwrite the new connection status', () => {
  const { owner } = ownerFixture('remote');
  const retired = owner.state.socket;
  owner.connectSignaling();
  const initial = owner.state.connectionMessage;
  retired.dispatchEvent(event('open', {}));
  retired.dispatchEvent(event('error', {}));
  assert.equal(owner.state.connectionMessage, initial);
  assert.equal(owner.state.connectionIsError, false);
  owner.state.socket.dispatchEvent(event('open', {}));
  assert.equal(owner.state.connectionMessage, '等待 Host…');
});

test('candidate input and pre-answer queues are bounded, with no work for retired peers', async () => {
  const { sandbox } = ownerFixture('host');
  const peer = new sandbox.RTCPeerConnection();
  let current = true;
  const exchange = sandbox.BilikaraInternetTransport.createIceCandidateExchange(peer, {
    isCurrent: () => current, sendCandidate() {}, onError() { assert.fail('unexpected signaling failure'); },
  });
  for (const invalid of [null, 'candidate', {}, { candidate: 'x'.repeat(4097) }]) {
    await assert.rejects(exchange.addCandidate(invalid), /Invalid/);
  }
  for (let i = 0; i < 128; i++) await exchange.addCandidate(candidate(i));
  await assert.rejects(exchange.addCandidate(candidate(128)), /excessive/);
  assert.equal(peer.added.length, 0, 'no candidate can bypass description readiness');
  current = false;
  await exchange.addCandidate(candidate(129));
  await exchange.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\n' });
  assert.equal(peer.added.length, 0, 'retired queued work must not reach native ICE');
});

test('authenticated channels survive late ICE after signaling detaches', async () => {
  for (const role of ['host', 'remote']) {
    const { owner, peerId } = ownerFixture(role);
    if (role === 'host') await owner.createPeer(peerId);
    else await owner.acceptOffer({ type: 'offer', sdp: 'v=0\r\n' });
    const peer = role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer;
    if (role === 'host') owner.peers.get(peerId).authorized = true;
    else owner.state.authorized = true;
    const socket = owner.state.socket;
    socket.close();
    const before = socket.frames.length;
    peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
    assert.equal(socket.frames.length, before);
    assert.equal(peer.connectionState, 'new', 'late gathering must not close the live peer');
    assert.equal(role === 'host' ? owner.peers.get(peerId).pc : owner.state.peer, peer);
    // Avoid native peer-close I/O: only the connection-boundary fixture is used.
    if (role === 'host') owner.peers.get(peerId).authorized = false;
    else owner.state.authorized = false;
    if (role === 'host') owner.closePeer(peerId, false);
    else owner.resetPeer();
  }
});

test('SDP candidates remain sufficient for legacy peers; empty end markers and send failures are handled', async () => {
  const { sandbox } = ownerFixture('host');
  const peer = new sandbox.RTCPeerConnection();
  const sent = [], errors = [];
  const exchange = sandbox.BilikaraInternetTransport.createIceCandidateExchange(peer, {
    isCurrent: () => true,
    sendCandidate: value => { if (value.candidate === 'fail') throw new Error('socket closed'); sent.push(value); },
    onError: error => errors.push(error.message),
  });
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => candidate(1) } }));
  assert.deepEqual(sent, [], 'early candidates stay in the initial SDP, avoiding redundant signaling');
  exchange.descriptionSent();
  peer.dispatchEvent(event('icecandidate', { candidate: null }));
  const end = { candidate: '', sdpMid: '0', sdpMLineIndex: 0 };
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => end } }));
  peer.dispatchEvent(event('icecandidate', { candidate: { toJSON: () => ({ candidate: 'fail' }) } }));
  assert.deepEqual(sent, [end]); assert.deepEqual(errors, ['socket closed']);
  await exchange.setRemoteDescription({ type: 'answer', sdp: 'v=0\r\n' });
  await exchange.addCandidate(end);
  assert.deepEqual(peer.added, [end]);
});

test('Internet transfer uses an inclusive UTF-8 512KiB limit before any frame is sent', async () => {
  const { sandbox } = ownerFixture('host'), api = sandbox.BilikaraInternetTransport;
  assert.equal(api.maxMessageBytes, 524288);
  assert.equal(api.maxRequestBytes, 16384);
  for (const character of ['x', '界', '😀', '"', '\\']) {
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
    const available = 524288 - overhead;
    const encodedCharacter = Buffer.byteLength(JSON.stringify(character)) - 2;
    const payload = { text: character.repeat(Math.floor(available / encodedCharacter))
      + 'x'.repeat(available % encodedCharacter) };
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), 524288);
    const frames = [], channel = { readyState: 'open', bufferedAmount: 0, send: wire => frames.push(wire) };
    api.send(channel, payload);
    const decoder = new api.Decoder();
    assert.equal(JSON.stringify(frames.flatMap(frame => decoder.consume(frame))), JSON.stringify([payload]));
    assert.ok(frames.every(frame => Buffer.byteLength(frame) <= 12288));
    payload.text += 'x'; frames.length = 0;
    assert.throws(() => api.send(channel, payload), error => error.code === 'internet_remote_message_too_large');
    await assert.rejects(api.send(channel, payload, { buffered: true }), /too large/);
    assert.deepEqual(frames, []);
    assert.throws(() => decoder.consume(JSON.stringify({type:'__chunk',transfer_id:'large',index:0,total:2,total_bytes:524289,data:'x'})), /Invalid/);
    assert.equal(decoder.pending.size, 0);
  }
  const {Decoder}=api;
  assert.throws(()=>new Decoder().consume(JSON.stringify({type:'__chunk',transfer_id:'too-many',
    index:0,total:115,total_bytes:524288,data:'x'})),/Invalid/);
});

test('Public display clipping preserves queue prefixes, totals, identities and source state', () => {
  const {sandbox} = ownerFixture('host'), api = sandbox.BilikaraInternetTransport;
  const state = {revision:31,queue_version:'complete-queue-version',
    current_item:{id:'playing',audio_variants:[{id:'main',label:'伴奏'}]},
    session_user_entries:[{id:'stable-id',name:'Alice'}],
    playlist:Array.from({length:10000},(_,i)=>({id:`queue-${i}`,title:'中文😀'.repeat(30)})),
    history:Array.from({length:2000},(_,i)=>({bvid:`history-${i}`,title:'最近'.repeat(100)})),
    session_played:[{item_id:'previous',threshold_reached:true}],
  };
  const original = JSON.stringify(state);
  for (const message of [{type:'state',data:state},
    {type:'response',accepted:true,data:state},
    {type:'response',accepted:false,stale:true,data:{state}}]) {
    const reply = api.prepareDisplayMessage(message,{kind:'state.get',body:{}});
    assert.ok(Buffer.byteLength(JSON.stringify(reply))<=524288);
    const view = reply.data.state || reply.data;
    assert.ok(view.playlist.length>0 && view.playlist.length<10000);
    assert.ok(view.history.length>0 && view.history.length<2000);
    assert.deepEqual(view.playlist,state.playlist.slice(0,view.playlist.length));
    assert.deepEqual(view.history,state.history.slice(0,view.history.length));
    assert.equal(view.queue_version,state.queue_version); assert.equal(view.revision,31);
    assert.deepEqual(view.current_item,state.current_item);
    assert.deepEqual(view.session_user_entries,state.session_user_entries);
    assert.deepEqual(view.session_played,state.session_played);
    assert.equal(view.public_list_limits.playlist.total,10000);
    assert.equal(view.public_list_limits.playlist.shown,view.playlist.length);
    assert.equal(view.public_list_limits.history.total,2000);
  }
  assert.equal(JSON.stringify(state),original);
  const small={type:'state',data:{playlist:[{id:'small'}],history:[]}};
  assert.equal(api.prepareDisplayMessage(small),small);
});

test('Byte-limited catalog pages continue at the first omitted row without losing results', () => {
  const {sandbox} = ownerFixture('host'), api=sandbox.BilikaraInternetTransport;
  const all=Array.from({length:117},(_,i)=>({bvid:`BV${String(i).padStart(10,'0')}`,title:'界😀'.repeat(1500)}));
  for (const kind of ['catalog.search','catalog.browse','catalog.category_browse','gatcha.search','gatcha.browse','gatcha.favlist_browse']) {
    let offset=37, seen=[];
    while (offset<all.length) {
      const items=all.slice(offset,offset+80), data={items,offset,limit:80,
        next_offset:offset+items.length,has_more:offset+items.length<all.length,matched_count:all.length};
      const input={type:'response',accepted:true,data};
      const output=api.prepareDisplayMessage(input,{kind,body:{offset}});
      assert.ok(Buffer.byteLength(JSON.stringify(output))<=524288);
      assert.ok(output.data.items.length>0);
      assert.equal(output.data.next_offset,offset+output.data.items.length);
      assert.equal(output.data.matched_count,117);
      assert.equal(output.data.has_more,output.data.next_offset<117);
      if(output.data.items.length<items.length) assert.equal(output.data.public_list_limits.items.paged,true);
      seen.push(...output.data.items.map(item=>item.bvid));
      assert.equal(data.items.length,items.length);
      offset=output.data.next_offset;
    }
    assert.deepEqual(seen,all.slice(37).map(item=>item.bvid));
  }
  const immutable={type:'response',accepted:true,data:{uid_options:[{title:'界'.repeat(200000)}]}};
  assert.throws(()=>api.prepareDisplayMessage(immutable,{kind:'gatcha.pool_config_get'}),
    error=>error.code==='internet_remote_message_too_large');
  const oversizedCurrent={type:'state',data:{current_item:{title:'界'.repeat(200000)},playlist:[{id:'one'}],history:[]}};
  assert.throws(()=>api.prepareDisplayMessage(oversizedCurrent),error=>error.code==='internet_remote_message_too_large');
  const sparse={type:'response',data:{items:all.slice(0,80),offset:3,next_offset:99,has_more:true}};
  assert.throws(()=>api.prepareDisplayMessage(sparse,{kind:'catalog.search',body:{offset:3}}),
    error=>error.code==='internet_remote_message_too_large', 'Opaque/sparse continuations must not drop unseen rows');
  const alreadyCapped={type:'response',data:{items:all.slice(0,80),public_list_limits:{items:{total:103,shown:80}}}};
  const recapped=api.prepareDisplayMessage(alreadyCapped,{kind:'catalog.browse'});
  assert.equal(recapped.data.public_list_limits.items.total,103);
  assert.equal(recapped.data.public_list_limits.items.shown,recapped.data.items.length);
  assert.equal(recapped.data.public_list_limits.items.paged,false);
  for (const kind of ['gatcha.pool_config_get','gatcha.pool_config_set','gatcha.favlist_preview']) {
    for (const data of [{uid_options:[{id:'visible'}],public_list_limits:{uid_options:{total:259,shown:1}}},
      {cache:{uids:['42'],public_list_limits:{uids:{total:259,shown:1}}}}]) {
      assert.throws(()=>api.prepareDisplayMessage({type:'response',data},{kind}),
        error=>error.code==='internet_remote_source_list_incomplete');
    }
  }
  // Crossing 99 -> 100 adds a cursor byte. Independent envelope arithmetic
  // makes a two-row prefix one byte too large, so the safe prefix is one row.
  const rows=[{id:'a',title:''},{id:'b',title:'x'.repeat(200)},{id:'c',title:'x'.repeat(200)}];
  const twoRows={type:'response',data:{items:rows.slice(0,2),offset:99,next_offset:101,has_more:true,
    public_list_limits:{items:{total:3,shown:2,paged:true}}}};
  rows[0].title='x'.repeat(524289-Buffer.byteLength(JSON.stringify(twoRows)));
  assert.equal(Buffer.byteLength(JSON.stringify(twoRows)),524289);
  const edge=api.prepareDisplayMessage({type:'response',data:{items:rows,offset:99,next_offset:102,has_more:false}},
    {kind:'catalog.search',body:{offset:99}});
  assert.equal(edge.data.items.length,1); assert.equal(edge.data.next_offset,100);
  assert.equal(edge.data.has_more,true); assert.ok(Buffer.byteLength(JSON.stringify(edge))<=524288);
});

test('Localized list notices coalesce progress, retain totals and reject stale state notices', async () => {
  const dictionaries=JSON.parse(source('i18n.json')).languages;
  for (const messages of Object.values(dictionaries)) {
    const {owner,sandbox}=ownerFixture('remote'), notices=[], frames=[];
    owner.state.authorized=true;
    owner.state.bulk={readyState:'open',send:wire=>frames.push(JSON.parse(wire))};
    sandbox.dispatchEvent=event=>{if(event.type==='remote-operation-message') notices.push(event.detail);};
    sandbox.BilikaraRemoteTransport.localize(key=>messages[key]||key);
    const view={state_epoch:'native',revision:30,playlist:[{id:'one'}],history:[],
      public_list_limits:{playlist:{total:10000,shown:1}}};
    const emit=data=>owner.handleDataMessage({type:'state',data});
    emit(view);
    assert.equal(notices.length,1); assert.equal(notices[0].isError,false);
    assert.equal(notices[0].message,messages['internetRemote.listsLimited']
      .replace('{lists}',`${messages['internetRemote.queueList']} 1/10000`));
    emit({...view,revision:31}); emit({...view,revision:32,public_list_limits:{playlist:{total:9999,shown:1}}});
    assert.equal(notices.length,1, 'Progress and count changes must not flood the toast');
    emit({...view,revision:29,public_list_limits:{history:{total:600,shown:0}}});
    assert.equal(notices.length,1, 'An obsolete snapshot must not notify');
    emit({state_epoch:'native',revision:33,playlist:[{id:'one'}],history:[]});
    assert.equal(JSON.stringify(owner.state.remoteState.public_list_limits),'{}');
    emit({...view,revision:34}); assert.equal(notices.length,2);
    emit({...view,revision:35,public_list_limits:{playlist:{total:1,shown:1},injected:{total:100,shown:0}}});
    assert.equal(notices.length,2, 'Malformed/unknown markers are ignored');
    const read=async (offset,query='test',limited=true) => {
      const promise=owner.request('catalog.search',{query,offset,limit:80},'bulk');
      const data={items:[{bvid:'BV1xx411c7mD'}],offset,has_more:true,next_offset:offset+1,
        ...(limited?{public_list_limits:{items:{total:80,shown:1,paged:true}}}:{})};
      owner.handleDataMessage({type:'response',accepted:true,request_id:frames.at(-1).envelope.id,data});
      return (await promise).data;
    };
    const data=await read(0);
    assert.equal(data.next_offset,1); assert.equal(notices.length,3);
    assert.equal(notices.at(-1).message,messages['internetRemote.pageLimited'].replace('{shown}','1').replace('{total}','80'));
    await read(1); assert.equal(notices.length,3);
    await read(0,'other'); assert.equal(notices.length,4);
    await read(1,'other',false); await read(2,'other'); assert.equal(notices.length,5);
    const draft=owner.request('gatcha.pool_config_get',{},'bulk');
    owner.handleDataMessage({type:'response',accepted:false,request_id:frames.at(-1).envelope.id,
      code:'internet_remote_source_list_incomplete'});
    await assert.rejects(draft,error=>error.message===messages['internetRemote.sourceListIncomplete']);
    assert.equal(owner.state.pending.size,0); assert.equal(owner.state.authorized,true);
  }
});

test('Remote local-source deletion sends only the typed Host operation for UPs and favorites', async () => {
  const { owner, sandbox } = ownerFixture('remote'), frames = [];
  Object.assign(owner.state, { authorized: true, control: { readyState: 'open', send: wire => frames.push(JSON.parse(wire)) } });
  for (const target of [{ source: 'uid', id: '42' }, { source: 'favlist', id: '42:10' }]) {
    const response = sandbox.fetch('/api/gatcha/source/remove', { method: 'POST', body: JSON.stringify(target) });
    await tick();
    const frame = frames.at(-1);
    assert.equal(frame.envelope.kind, 'gatcha.source_remove');
    assert.deepEqual(frame.envelope.body, target);
    owner.handleDataMessage({ type: 'response', request_id: frame.envelope.id, accepted: true, data: { removed: true } });
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.removed, true);
    assert.equal(owner.state.pending.size, 0);
  }
  assert.equal(frames.length, 2, 'deletion must not trigger catalog or Bilibili RPCs');
});

test('Remote rejects oversized request parameters before sending and releases pending work', async () => {
  const { owner, sandbox } = ownerFixture('remote'), frames = [], notices = [];
  Object.assign(owner.state, { authorized: true, bulk: { readyState: 'open', send: wire => frames.push(wire) } });
  sandbox.dispatchEvent = event => notices.push(event);
  const folders = Array.from({length:64}, (_, i) => String(i + 1));
  const body = {uid:'42',folder_ids:folders,folder_titles:Object.fromEntries(folders.map(id => [id,'界'.repeat(96)]))};
  await assert.rejects(owner.request('gatcha.favlist_refresh', body, 'bulk'), error =>
    error.code === 'internet_remote_message_too_large' && /16KiB/.test(error.message));
  assert.deepEqual(frames, []); assert.equal(owner.state.pending.size, 0);
  assert.equal(owner.state.authorized, true);
  assert.equal(notices.at(-1).type, 'remote-operation-message');
  owner.state.control = owner.state.bulk;
  const rejected = await sandbox.fetch('/api/playlist/add',{method:'POST',body:JSON.stringify({
    url:'BV1xx411c7mD',selected_audio_pages:Array.from({length:10000}, (_,i)=>i+1),
  })});
  assert.equal(rejected.status,413); assert.equal((await rejected.json()).code,'internet_remote_message_too_large');
  assert.deepEqual(frames,[]); assert.equal(owner.state.pending.size,0);
  const next = sandbox.fetch('/api/playlist/add',{method:'POST',body:JSON.stringify({url:'BV1xx411c7mD'})});
  await tick();
  const nextEnvelope = JSON.parse(frames.at(-1)).envelope;
  owner.handleDataMessage({type:'response',request_id:nextEnvelope.id,accepted:true,data:{revision:1,playlist:[]}});
  assert.equal((await next).status,200, 'The rejected mutation releases its serialization turn');
  assert.equal(owner.state.pending.size,0);
  const request = owner.request('catalog.search', {query:'small',limit:20}, 'bulk');
  const envelope = JSON.parse(frames.at(-1)).envelope;
  owner.handleDataMessage({type:'response',request_id:envelope.id,accepted:true,data:{items:[]}});
  assert.equal(JSON.stringify((await request).data), '{"items":[]}');
  assert.equal(owner.state.pending.size, 0);
  // Unsupported file export is rejected locally, without any RPC/frame.
  const sent = frames.length;
  const response = await sandbox.fetch('/api/playlist/export?format=image');
  assert.equal(response.status, 501);
  assert.equal((await response.json()).code, 'internet_remote_unavailable');
  assert.equal(frames.length, sent);
});

test('Remote sizes and committed-result warnings use the active language without disconnecting', async () => {
  const { owner, sandbox } = ownerFixture('remote'), notices = [], frames = [];
  owner.state.authorized = true;
  owner.state.control = {readyState:'open',send:wire => frames.push(wire)};
  sandbox.dispatchEvent = event => notices.push(event);
  const languages = JSON.parse(source('i18n.json')).languages;
  for (const messages of Object.values(languages)) {
    sandbox.BilikaraRemoteTransport.localize(key => messages[key] || key);
    owner.handleDataMessage({type:'response',accepted:false,code:'internet_remote_message_too_large'});
    assert.equal(notices.at(-1).detail.message, messages['internetRemote.messageTooLarge'].replace('{limit}', '512'));
    const pending = owner.request('playlist.add', {catalog_item_id:'BV1xx411c7mD'});
    owner.handleDataMessage({type:'response',request_id:JSON.parse(frames.at(-1)).envelope.id,accepted:false,
      code:'internet_remote_message_too_large',completed:true});
    await assert.rejects(pending, error => error.completed === true && error.message ===
      messages['internetRemote.resultTooLarge'].replace('{limit}', '512'));
    assert.equal(owner.state.authorized, true); assert.equal(owner.state.pending.size, 0);
  }
});

async function openedHost() {
  const fixture = ownerFixture('host');
  await fixture.owner.createPeer(fixture.peerId);
  fixture.peer = fixture.owner.peers.get(fixture.peerId);
  fixture.peer.authorized = true; fixture.frames = [];
  for (const lane of ['bulk', 'control']) Object.assign(fixture.peer[lane], {
    readyState:'open',bufferedAmount:0,send:wire => fixture.frames.push({lane,wire})
  });
  return fixture;
}

test('Host sends limited state/read prefixes over real framing and keeps mutations available', async () => {
  const {owner,sandbox,peer,frames}=await openedHost(), decoder=new sandbox.BilikaraInternetTransport.Decoder();
  const large={revision:13,queue_version:'same-version',playlist:Array.from({length:3000},(_,i)=>({id:String(i),title:'界'.repeat(100)})),history:[]};
  owner.queueState(peer,large);
  for(let i=0;peer.stateSending && i<30;i++) await tick();
  assert.equal(peer.stateSending,false); assert.equal(peer.stateTooLarge,false);
  const decode=()=>frames.flatMap(frame=>decoder.consume(frame.wire));
  const snapshot=decode().at(-1);
  assert.equal(snapshot.type,'state'); assert.equal(snapshot.data.queue_version,'same-version');
  assert.ok(snapshot.data.playlist.length>0 && snapshot.data.playlist.length<3000);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.data.playlist)),large.playlist.slice(0,snapshot.data.playlist.length));
  assert.equal(snapshot.data.public_list_limits.playlist.total,3000);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=524288);
  frames.length=0; let dispatches=0;
  sandbox.fetch=async url=>{
    if(String(url).endsWith('/dispatch')) dispatches++;
    return new Response(JSON.stringify({ok:true,data:{accepted:true,data:large}}));
  };
  await owner.handlePeerMessage(peer,'control',{type:'request',lane:'control',envelope:{id:'allowed',kind:'playlist.move',seq:3}});
  assert.equal(dispatches,1); assert.equal(decode().at(-1).accepted,true);
  assert.equal(peer.authorized,true); assert.equal(large.playlist.length,3000);
  frames.length=0;
  sandbox.fetch=async()=>new Response(JSON.stringify({ok:true,data:{accepted:true,data:{items:large.playlist,
    offset:7,next_offset:3007,has_more:false,matched_count:3007}}}));
  await owner.handlePeerMessage(peer,'bulk',{type:'request',lane:'bulk',envelope:{id:'page',kind:'catalog.search',seq:4,body:{offset:7}}});
  const page=decode().at(-1);
  assert.equal(page.data.next_offset,7+page.data.items.length); assert.equal(page.data.has_more,true);
  assert.equal(page.data.matched_count,3007);
  frames.length=0;
  sandbox.fetch=async()=>new Response(JSON.stringify({ok:true,data:{accepted:true,data:{selected_folder_ids:['1'],
    public_list_limits:{selected_folder_ids:{total:300,shown:1}}}}}));
  await owner.handlePeerMessage(peer,'bulk',{type:'request',lane:'bulk',envelope:{id:'config',kind:'gatcha.pool_config_get',seq:5}});
  assert.equal(frames.length,1); assert.equal(decode()[0].code,'internet_remote_source_list_incomplete');
});

test('Host rejects oversized read results at source; committed writes have a distinct warning', async () => {
  const {owner,sandbox,peer,frames} = await openedHost();
  let requests = 0;
  sandbox.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ok:true,data:{accepted:true,data:{items:[{title:'界'.repeat(200000)}]}}}));
  };
  for (const kind of ['catalog.search','playlist.add']) {
    await owner.handlePeerMessage(peer,'bulk',{type:'request',lane:'bulk',envelope:{kind,id:kind,seq:1}});
    const reply = JSON.parse(frames.at(-1).wire);
    assert.equal(reply.code,'internet_remote_message_too_large');
    assert.equal(reply.request_id,kind); assert.equal(reply.completed,kind==='playlist.add');
    assert.equal(reply.data,undefined); assert.ok(Buffer.byteLength(frames.at(-1).wire)<1024);
  }
  assert.equal(requests,2); assert.equal(frames.length,2);
  assert.equal(peer.authorized,true);
  assert.ok(frames.every(frame => JSON.parse(frame.wire).type==='response'), 'No large chunk was uploaded');
});

test('Unclippable state warns once, refuses mutations before dispatch, then recovers', async () => {
  const {owner,sandbox,peer,frames} = await openedHost();
  const large = {current_item:{id:'playing',title:'界'.repeat(200000)},
    playlist:Array.from({length:10000}, (_,i) => ({id:String(i),title:'界'.repeat(100)}))};
  const finish = async () => {
    for(let i=0;peer.stateSending && i<20;i++) await tick();
    assert.equal(peer.stateSending,false);
  };
  owner.queueState(peer,large); await finish();
  owner.queueState(peer,large); await finish();
  assert.equal(frames.length,1); assert.equal(peer.stateTooLarge,true);
  let dispatches=0; sandbox.fetch = async () => {dispatches++;throw new Error('must not dispatch');};
  await owner.handlePeerMessage(peer,'control',{type:'request',lane:'control',envelope:{id:'blocked',kind:'playlist.add',seq:2}});
  assert.equal(dispatches,0); assert.equal(JSON.parse(frames.at(-1).wire).completed,false);
  const small={playlist:[{id:'one',title:'歌'}],history:[]};
  owner.queueState(peer,small); await finish();
  assert.equal(peer.stateTooLarge,false); assert.equal(peer.authorized,true);
  assert.deepEqual(JSON.parse(frames.at(-1).wire),{type:'state',data:small});
  assert.equal(large.playlist.length,10000, 'No silent truncation or mutation of the source');
});

test('Initial oversized state can be retried without stranding the page readiness waiter', async () => {
  const {owner,sandbox} = ownerFixture('remote');
  owner.state.overlay = {classList:{add(){},remove(){}}};
  owner.state.identity = 'Alice';
  let tooLarge = true, ready = false;
  void sandbox.BilikaraRemoteTransport.ready().then(() => { ready = true; });
  const attach = () => {
    const channel = {readyState:'open',close(){},send(wire) {
      const frame = JSON.parse(wire);
      if (frame.type !== 'request') return;
      const envelope = frame.envelope;
      queueMicrotask(() => owner.handleDataMessage(tooLarge
        ? {type:'response',request_id:envelope.id,accepted:false,code:'internet_remote_message_too_large'}
        : {type:'response',request_id:envelope.id,accepted:true,data:envelope.kind==='state.get'
          ? {revision:1,session_user_entries:[{id:'a',name:'Alice'}]}
          : {name:'Alice'}}));
    }};
    owner.state.control = channel; owner.state.bulk = channel;
  };
  attach(); owner.handleDataMessage({type:'auth.ok'}); await tick();
  assert.equal(ready,false); assert.equal(owner.state.pending.size,0);
  owner.resetPeer(); tooLarge = false;
  attach(); owner.handleDataMessage({type:'auth.ok'}); await tick();
  assert.equal(ready,true, 'The original page startup promise must resolve after a successful retry');
  assert.equal(owner.state.pending.size,0);
});
