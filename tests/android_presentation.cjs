"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const sync = require("../static/presentation-sync.js");
const scenes = require("../static/presentation-scene.js");
const settle = () => new Promise(setImmediate);

async function bridgeTests() {
  const events = {}, sent = [], timers = new Map();
  let timer = 0;
  const window = {addEventListener:(name, fn) => { events[name] = fn; },
    BilikaraHostPresentation:{postMessage:raw => sent.push(JSON.parse(raw))}};
  const context = {window, setTimeout:fn => { timers.set(++timer, fn); return timer; },
    clearTimeout:id => timers.delete(id)};
  vm.runInNewContext(fs.readFileSync("static/android-presentation.js", "utf8"), context);
  const api = window.BilikaraAndroidPresentation;
  const pending = api.invoke("get_presentation_displays");
  assert.equal(sent[0].command, "get_presentation_displays");
  window.BilikaraHostPresentation.onmessage({data:JSON.stringify({id:sent[0].id,ok:true,data:{displays:[]}})});
  assert.equal((await pending).displays.length, 0);
  assert.equal(timers.size, 0);
  await assert.rejects(api.invoke("restart_application"), /unsupported_command/);
  const failed = api.invoke("activate_local_presentation", {displayId:"7"});
  const last = sent.at(-1);
  window.BilikaraHostPresentation.onmessage({data:JSON.stringify({id:last.id,ok:false,error:"display_unavailable"})});
  await assert.rejects(failed, /display_unavailable/);
  let session;
  const unlisten = await api.listen("bilikara-presentation-state", event => {session = event.payload;});
  events["bilikara-native-presentation"]({detail:{name:"bilikara-presentation-state",payload:{generation:8}}});
  await settle(); assert.equal(session.generation, 8);
  unlisten();
  events["bilikara-native-presentation"]({detail:{name:"bilikara-presentation-state",payload:{generation:9}}});
  await settle(); assert.equal(session.generation, 8);
  events["bilikara-native-presentation"]({detail:{name:"foreground",payload:{foreground:false}}});
  assert.equal(api.isForeground(), false);
  const envelope = {protocol:1,type:"master-state",payload:{scene:{generation:8}}};
  api.postMaster(envelope);
  assert.deepEqual(sent.at(-1).args, envelope);
  assert.equal(timers.size, 0, "Clock relay must not create pending RPC requests");
  const timeout = api.invoke("diagnostics");
  [...timers.values()][0]();
  await assert.rejects(timeout, /display_timeout/);
  const closed = api.invoke("get_presentation_session");
  events.pagehide(); await assert.rejects(closed, /display_page_closed/);
}

async function stageTests() {
  let now = 100000, foreground = true;
  const events = {}, listeners = {}, intervals = [], telemetry = [];
  const session = {mode:"localDualScreen",phase:"activating",generation:7,controllerReady:false,
    playbackAuthority:"host",mediaRendererOwner:"host"};
  class Element {
    constructor() {
      this.dataset = {}; this.children = []; this.style = {setProperty(){}};
      this.classList = {add(){},remove(){},toggle(){}}; this.listeners = {};
      this.paused = true; this.ended = false; this.readyState = 4; this.currentTime = 0;
      this.duration = 300; this.playbackRate = 1; this.scrollWidth = 20;
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute() {}
    removeAttribute(name) { if (name === "src") this.src = ""; }
    getBoundingClientRect() { return {width:20}; }
    querySelector(selector) { return selector === ".player-delay-overlay" ? null : new Element(); }
    replaceChildren(...children) { this.children = children; }
    appendChild(child) { this.children.push(child); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    load() { this.loaded = true; }
    getVideoPlaybackQuality() { return {droppedVideoFrames:2,totalVideoFrames:90}; }
  }
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const bridge = {
    invoke: async command => {
      if (command === "mark_presentation_controller_ready") Object.assign(session,{phase:"active",controllerReady:true});
      return {...session};
    },
    listen: async (name, fn) => {listeners[name]=fn;return()=>delete listeners[name];},
    isForeground:()=>foreground, reportOutput:data=>telemetry.push(data),
  };
  const window = {BilikaraAndroidPresentation:bridge,BilikaraPresentationSync:sync,
    BilikaraPresentationScene:scenes,BilikaraPresentationRenderer:{renderScene(){}},
    location:{search:"?presentationGeneration=7"},addEventListener:(name,fn)=>{events[name]=fn;},
    setInterval:fn=>intervals.push(fn),setTimeout:()=>1,clearTimeout(){}};
  const document = {getElementById:get,querySelector:get,querySelectorAll:()=>[],
    createElement:()=>new Element(),documentElement:{dataset:{}},body:new Element(),addEventListener(){}};
  vm.runInNewContext(fs.readFileSync("static/controller.js", "utf8"), {
    window,document,URLSearchParams,navigator:{languages:["en"]},Date:{now:()=>now},
    fetch:async()=>({ok:true,json:async()=>({languages:{en:{}}})}),
    localStorage:{setItem(){},removeItem(){},getItem(){return null;}},getComputedStyle:()=>({getPropertyValue:()=>"0"}),
  });
  await settle();
  assert.ok(listeners["master-state"], "Stage must subscribe to the Android transport");
  let sequence = 0;
  const send = (id,time,paused=false,generation=7) => listeners["master-state"]({payload:sync.makeEnvelope("master-state", {
    scene:{generation,revision:sequence,currentItemIdentity:id,videoUrl:`/media/${id}.mp4`,title:id},
    clock:{itemIdentity:id,mediaTime:time,paused,playbackRate:1,sampledAt:now},
    internetRemote:{active:true,qr_image:"data:image/svg+xml;base64,PHN2Zy8+"},
  }, {senderId:"host",sequence:++sequence,sentAt:now})});
  send("first",20);
  const frame = get("controller-stage-frame");
  const video = frame.children[0];
  assert.equal(video.muted,true);
  assert.equal(video.paused,false, JSON.stringify({session,error:get("controller-error").textContent,telemetry}));
  assert.equal(video.currentTime,20);
  assert.equal(get("controller-internet-remote-qr-image").src,"data:image/svg+xml;base64,PHN2Zy8+",
    "Native room QR is a local SVG and must reach the audience stage");
  send("second",40);
  const second = frame.children[0];
  assert.notEqual(video,second); assert.equal(video.paused,true); assert.equal(video.src,"");
  assert.equal(second.src,"/media/second.mp4"); assert.equal(second.currentTime,40);
  send("stale",10,false,6);
  assert.equal(frame.children[0],second,"Old display generations must not replace current playback");
  now += 3100; intervals[0]();
  assert.equal(second.paused,true,"No independent playback after the Host heartbeat stops");
  send("second",60); const resumed=frame.children[0]; assert.equal(resumed.paused,false);
  foreground=false; listeners.foreground({payload:{foreground:false}});
  assert.equal(resumed.paused,true);
  foreground=true; now+=500; send("second",70);
  assert.equal(frame.children[0].paused,false);
  send("second",70,true); assert.equal(frame.children[0].paused,true);
  assert.ok(telemetry.some(item=>item.stale));
  listeners["bilikara-presentation-state"]({payload:{session:{...session,generation:6}}});
  assert.equal(frame.children[0].paused,true,"Stale native session fails closed");
  events.pagehide();
}

(async()=>{await bridgeTests();await stageTests();console.log("PASS Android display bridge and shared stage lifecycle");})()
  .catch(error=>{console.error(error);process.exitCode=1;});
