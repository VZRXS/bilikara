"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/android-host.js", "utf8");

function setup(native = true, orientationType = "portrait-primary") {
  class Node {
    constructor(id) { this.id=id; this.dataset={}; this.attrs={}; this.value="0"; this.style={setProperty(){}}; this.hidden=true; this.inert=false; this.listeners={}; this.children=[]; this.parentElement=null; this.classes=new Set();
      this.classList={toggle:(k,v)=>v?this.classes.add(k):this.classes.delete(k),remove:k=>this.classes.delete(k)}; }
    setAttribute(k,v) { this.attrs[k]=String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k,fn) { this.listeners[k]=fn; }
    append(node) { node.parentElement=this; }
    before(node) { node.parentElement=this.parentElement; }
    after(node) { node.parentElement=this.parentElement; }
    querySelectorAll(selector) { return this.children.filter(n=>selector==="button" || (selector.includes("data-request-view") ? n.dataset.requestView : selector.includes("workspace") ? n.dataset.androidWorkspace : n.dataset.androidPage)); }
    closest(selector) { return selector.includes("workspace") ? (this.dataset.androidWorkspace || this.dataset.requestView ? this:null) : (this.dataset.androidPage ? this:null); }
  }
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id)) nodes.set(id,new Node(id)); return nodes.get(id);};
  const dock=get("android-host-dock"), tools=get("android-page-tools");
  dock.children=["playback","queue","request","users","my"].map(p=>{const n=new Node(p);n.dataset.androidPage=p;return n;});
  tools.children=["queue","history","request","random"].map(p=>{const n=new Node(p);n.dataset.androidWorkspace=p;return n;});
  get("cache-settings").parentElement=get("top-controls");
  get("bbdown-status-row").parentElement=get("tool-list");
  get("bbdown-login-panel").parentElement=get("cache-panel");
  const requestTabs=get("shared-request-tabs");
  requestTabs.parentElement=get("request-header");
  requestTabs.children=["quick","search","discover","sources"].map(p=>{const n=new Node(p);n.dataset.requestView=p;return n;});
  const random=get("android-request-random");
  random.dataset.androidWorkspace="random";
  requestTabs.children.push(random);
  const root={dataset:{nativeHost:native?"true":"false"}};
  const state={activeHostWorkspace:"queue",requestSubview:"quick",cacheSettingsOpen:false};
  const elements={leftColumn:get("stage"),hostWorkspaceRegion:get("workspace")};
  const listeners={};
  const orientation={type:orientationType,addEventListener:(k,fn)=>{listeners.orientation=fn;}};
  const history={state:null,entries:[],replaceState(s){this.state=s;this.entries[this.entries.length-1]=s;},pushState(s){this.state=s;this.entries.push(s);}};
  const calls=[];
  const window={screen:{orientation},addEventListener:(k,fn)=>{listeners[k]=fn;},matchMedia:()=>({matches:true})};
  const context={window,history,state,elements,clearTimeout:()=>{},
    document:{documentElement:root,getElementById:get,querySelector:()=>requestTabs,createComment:()=>new Node("anchor"),addEventListener:()=>{}},
    syncCachePanelVisibility:()=>{},schedulePersistentStageMeasurement:()=>{},
    renderHostWorkspaceSelection:()=>window.BilikaraAndroidHost?.syncVisibility(),
    activateHostWorkspace:(name,{inputOrigin}={})=>{state.activeHostWorkspace=name;calls.push(name);window.BilikaraAndroidHost?.workspaceActivated(name,inputOrigin);window.BilikaraAndroidHost?.syncVisibility();},
  };
  vm.runInNewContext(source,context);
  const clickPage=name=>dock.listeners.click({target:dock.children.find(n=>n.dataset.androidPage===name)});
  const clickWorkspace=name=>tools.listeners.click({target:tools.children.find(n=>n.dataset.androidWorkspace===name)});
  return {root,window,orientation,listeners,history,nodes,get,dock,tools,state,elements,calls,context,clickPage,clickWorkspace};
}

const desktop=setup(false);
assert.equal(desktop.window.BilikaraAndroidHost,undefined);
assert.equal(desktop.get("cache-settings").parentElement.id,"top-controls");
assert.deepEqual(desktop.calls,[]);
const mobile=setup();
assert.equal(mobile.root.dataset.androidPage,"playback");
assert.equal(mobile.elements.hostWorkspaceRegion.hidden,true);
assert.equal(mobile.get("cache-settings").parentElement.id,"android-settings-slot");
mobile.clickPage("queue");
mobile.clickWorkspace("history");
assert.equal(mobile.state.activeHostWorkspace,"history");
mobile.clickPage("request");
mobile.clickWorkspace("random");
assert.equal(mobile.state.activeHostWorkspace,"random");
assert.equal(mobile.get("android-request-random").attrs["aria-selected"],"true");
assert.equal(mobile.get("shared-request-tabs").parentElement.id,"android-request-tabs");
assert.ok(mobile.get("shared-request-tabs").children.filter(n=>n.dataset.requestView).every(n=>n.attrs["aria-selected"]==="false"));
mobile.clickPage("playback");
mobile.clickPage("queue");
assert.equal(mobile.state.activeHostWorkspace,"history");
// SSE renders preserve the selected mobile page instead of selecting the old
// active workspace behind the player/My home on every state update.
mobile.clickPage("playback");
mobile.context.renderHostWorkspaceSelection();
assert.equal(mobile.root.dataset.androidPage,"playback");
mobile.context.activateHostWorkspace("users");
assert.equal(mobile.root.dataset.androidPage,"users");
mobile.clickPage("my");
assert.equal(mobile.window.BilikaraAndroidHost.settingsEmbedded(),true);
assert.equal(mobile.state.cacheSettingsOpen,true);
assert.equal(mobile.get("bbdown-status-row").parentElement.id,"android-account-slot");
mobile.get("android-open-settings").listeners.click();
assert.equal(mobile.window.BilikaraAndroidHost.settingsEmbedded(),false);
assert.equal(mobile.state.cacheSettingsOpen,false);
assert.equal(mobile.elements.hostWorkspaceRegion.hidden,false);
mobile.get("android-settings-back").listeners.click();
assert.equal(mobile.get("android-my-page").hidden,false);
assert.equal(mobile.state.cacheSettingsOpen,true);
assert.equal(mobile.history.state.androidHost.settings,false);
// Typing resizes the viewport, not the physical screen orientation.
mobile.window.innerWidth=412; mobile.window.innerHeight=220;
mobile.listeners.resize();
assert.equal(mobile.root.dataset.androidLayout,"portrait");
mobile.orientation.type="landscape-primary"; mobile.listeners.orientation();
assert.equal(mobile.dock.hidden,true);
assert.equal(mobile.elements.leftColumn.inert,false);
assert.equal(mobile.get("cache-settings").parentElement.id,"top-controls");
assert.equal(mobile.get("bbdown-status-row").parentElement.id,"tool-list");
assert.equal(mobile.get("bbdown-login-panel").parentElement.id,"cache-panel");
assert.equal(mobile.get("shared-request-tabs").parentElement.id,"request-header");
mobile.orientation.type="portrait-primary"; mobile.listeners.orientation();
assert.equal(mobile.dock.hidden,false);
assert.equal(mobile.root.dataset.androidPage,"my");
assert.equal(mobile.get("cache-settings").parentElement.id,"android-settings-slot");
mobile.listeners.popstate({state:{androidHost:{page:"request",requestView:"random",queueView:"history"}}});
assert.equal(mobile.root.dataset.androidPage,"request");
assert.equal(mobile.state.activeHostWorkspace,"random");
mobile.listeners.popstate({state:{androidHost:{page:"invalid"}}});
assert.equal(mobile.root.dataset.androidPage,"request");
console.log("PASS portrait navigation, shared settings, programmatic routing, rotation and keyboard");
