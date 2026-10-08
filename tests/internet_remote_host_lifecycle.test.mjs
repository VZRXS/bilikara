import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';

// These fixtures exercise asynchronous ownership and local admission, not ICE.
// The relay integration gate separately uses real browser networking.
function fixture() {
  const timers = [], statuses = [], requests = [], provisions = [], allocations = new Map();
  class Channel extends EventTarget {
    constructor(label) { super(); this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.frames = []; }
    send(wire) { this.frames.push(JSON.parse(wire)); }
    close() { this.readyState = 'closed'; }
  }
  class Peer extends EventTarget {
    constructor(configuration) { super(); this.configuration = configuration; this.connectionState = 'new'; this.iceGatheringState = 'complete'; }
    createDataChannel(label) { return new Channel(label); }
    async createOffer() { return {type:'offer',sdp:'v=0\r\n'}; }
    async setLocalDescription(value) { this.localDescription = value; }
    close() { this.connectionState = 'closed'; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; this.frames = []; }
    send(wire) { this.frames.push(JSON.parse(wire)); }
    close() { this.readyState = 3; }
  }
  const sandbox = {
    crypto: webcrypto, RTCPeerConnection: Peer, WebSocket: Socket, TextEncoder, URL, AbortController,
    performance, Event, CustomEvent, console,
    location: {protocol:'http:',hostname:'127.0.0.1'},
    setTimeout(fn, ms) { const timer = {fn,ms,cleared:false}; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    document: {readyState:'loading',addEventListener(){}},
    async fetch(url, options) {
      const body = options?.body ? JSON.parse(options.body) : null;
      requests.push({url:String(url),body});
      if (String(url).endsWith('/peer/open')) {
        if (sandbox.admissionGate) await sandbox.admissionGate(body);
        if (sandbox.admissionError) return {ok:false,status:503,json:async()=>({ok:false,code:'runtime_unavailable',error:'unavailable'})};
        allocations.set(body.peer_id,body.epoch);
      } else if (String(url).endsWith('/peer/close')) allocations.delete(body.peer_id);
      return {ok:true,status:200,json:async()=>({ok:true,data:{state_epoch:'fixture',state_revision:1,playlist:[],history:[]}})};
    },
  };
  sandbox.window = sandbox;
  const transport = {
    iceConfiguration: {iceServers:[]},
    createIceProvisioning() { return {reset(){},configuration(){return transport.iceConfiguration;},accept(payload){provisions.push(payload);}}; },
    createConnectionDiagnostics() { return {stage(){},fail(){},channels(){},snapshot(){return {};},capture:async()=>{},dispose(){}}; },
    Decoder: class {consume(wire){return [JSON.parse(wire)];}},
    createIceCandidateExchange() { return {descriptionSent(){},setRemoteDescription:async()=>{},addCandidate:async()=>{}}; },
    waitForIceGathering: async()=>{}, waitForBufferedAmount:async()=>{},
    prepareDisplayMessage:value=>value, send(channel,value){channel.send(JSON.stringify(value));},
    constantTimeTextEqual:(left,right)=>left===right,
  };
  sandbox.BilikaraInternetTransport = transport;
  const context = vm.createContext(sandbox);
  const source = readFileSync(new URL('../static/internet-remote-host.js',import.meta.url),'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/u,
    'render = () => {}; setStatus = (message,tone) => window.statuses.push({message,tone}); window.owner = {state,peers,createPeer,closePeer,handlePeerMessage,connectSignaling}; })();'),context);
  sandbox.statuses = statuses;
  const {owner} = sandbox;
  Object.assign(owner.state,{stopped:false,roomId:'R'.repeat(27),hostToken:'H'.repeat(43),hostPeerId:'P'.repeat(22),password:'1234'});
  owner.connectSignaling();
  return {owner,sandbox,transport,timers,statuses,requests,provisions,allocations,peerId:'P'.repeat(22)};
}

async function createOpened(f) {
  await f.owner.createPeer(f.peerId);
  const peer = f.owner.peers.get(f.peerId);
  for (const lane of ['control','bulk']) peer[lane].readyState='open';
  return peer;
}

test('a queued failure from a retired Host peer cannot close its replacement',async()=>{
  const f=fixture(),old=await createOpened(f);
  let reject;
  old.queues.control=new Promise((_,fail)=>{reject=fail;});
  old.control.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify({type:'invalid'})}));
  const replacement=await createOpened(f);
  reject(new Error('late retired queue failure')); await tick();
  assert.equal(f.owner.peers.get(f.peerId),replacement);
  assert.equal(replacement.pc.connectionState,'new');
});

test('retired admission is closed before replacement admission and cannot claim success',async()=>{
  const f=fixture(),old=await createOpened(f),oldEpoch='A'.repeat(22),newEpoch='B'.repeat(22);
  let release;
  f.sandbox.admissionGate=body=>body.epoch===oldEpoch?new Promise(resolve=>{release=resolve;}):undefined;
  const pendingOld=f.owner.handlePeerMessage(old,'control',{type:'auth',password:'1234',epoch:oldEpoch});
  await tick(); assert.ok(release);
  f.owner.closePeer(f.peerId,false,old);
  const replacement=await createOpened(f);
  const pendingNew=f.owner.handlePeerMessage(replacement,'control',{type:'auth',password:'1234',epoch:newEpoch});
  release(); await Promise.all([pendingOld,pendingNew]); await tick();
  assert.equal(old.authorized,false);
  assert.equal(replacement.authorized,true);
  assert.equal(f.allocations.get(f.peerId),newEpoch);
  assert.deepEqual(f.requests.filter(row=>/\/peer\//u.test(row.url)).map(row=>[row.url,row.body.epoch||null]),[
    ['/api/internet-remote/peer/open',oldEpoch],['/api/internet-remote/peer/close',null],['/api/internet-remote/peer/open',newEpoch],
  ]);
  assert.equal(old.control.frames.some(frame=>frame.type==='auth.ok'),false);
});

test('Runtime admission failure is an explicit authentication outcome',async()=>{
  const f=fixture(),peer=await createOpened(f);
  f.sandbox.admissionError=true;
  await f.owner.handlePeerMessage(peer,'control',{type:'auth',password:'1234',epoch:'A'.repeat(22)});
  assert.deepEqual(peer.control.frames,[{type:'auth.failed',reason:'runtime_admission_failed'}]);
  assert.equal(f.owner.peers.has(f.peerId),false);
  assert.equal(peer.authorized,false);
});

test('Host transport and authentication deadlines begin at their own stages',async()=>{
  const f=fixture(); let release;
  f.transport.waitForIceGathering=()=>new Promise(resolve=>{release=resolve;});
  const pending=f.owner.createPeer(f.peerId); await tick();
  assert.equal(f.timers.filter(timer=>!timer.cleared&&timer.ms>=10000).length,0,'gathering must not consume the later connection/auth deadline');
  release(); await pending;
  const peer=f.owner.peers.get(f.peerId);
  const transportDeadline=f.timers.find(timer=>!timer.cleared&&timer.ms===20000);
  assert.ok(transportDeadline);
  peer.control.readyState='open'; peer.control.dispatchEvent(new Event('open'));
  peer.bulk.readyState='open'; peer.bulk.dispatchEvent(new Event('open'));
  assert.equal(transportDeadline.cleared,true);
  assert.ok(f.timers.find(timer=>!timer.cleared&&timer.ms===10000));
});

test('closing an ordered lane retires the peer even while ICE remains connected',async()=>{
  const f=fixture(),peer=await createOpened(f);
  peer.pc.connectionState='connected';
  peer.control.readyState='closed'; peer.control.dispatchEvent(new Event('close'));
  assert.equal(f.owner.peers.has(f.peerId),false);
  assert.equal(peer.pc.connectionState,'closed');
});

test('Host accepts ICE provisioning only from its current service socket',()=>{
  const f=fixture(),retired=f.owner.state.socket;
  f.owner.connectSignaling();
  const current=f.owner.state.socket,payload={expires_at:123,ice_servers:[]};
  const deliver=(socket,message)=>socket.dispatchEvent(Object.assign(new Event('message'),{data:JSON.stringify(message)}));
  deliver(retired,{type:'ice.config',payload});
  for(const from of [f.peerId,'',null]) deliver(current,{type:'ice.config',from,payload});
  for(const invalid of [null,[],123]) deliver(current,invalid);
  assert.deepEqual(f.provisions,[]);
  deliver(current,{type:'ice.config',payload});
  assert.deepEqual(JSON.parse(JSON.stringify(f.provisions)),[payload]);
  assert.equal(retired.readyState,3,'replacement signaling closes the owned retired socket');
});

test('already queued retired timeout/open callbacks cannot affect a replacement',async()=>{
  const f=fixture();
  await f.owner.createPeer(f.peerId);
  const old=f.owner.peers.get(f.peerId),deadline=f.timers.find(timer=>timer.ms===20000);
  const replacement=await createOpened(f),statusCount=f.statuses.length;
  // A timer already queued by the browser can run after clearTimeout.
  deadline.fn();
  old.control.readyState='open';old.bulk.readyState='open';
  old.control.dispatchEvent(new Event('open'));
  assert.equal(f.owner.peers.get(f.peerId),replacement);
  assert.equal(f.statuses.length,statusCount);
  assert.equal(old.control.frames.some(frame=>frame.type==='auth.required'),false);
});
