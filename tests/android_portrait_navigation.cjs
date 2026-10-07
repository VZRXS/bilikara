"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/host-layout.js", "utf8");
const {resolveLayout} = require("../static/host-layout-preferences.js");

function setup(native = true, orientationType = "portrait-primary", width = 412, client = null, platform = "android") {
  class Node {
    constructor(id) { this.id=id; this.dataset={}; this.attrs={}; this.value="0"; this.style={setProperty(key,value){this[key]=String(value);},removeProperty(key){const value=this[key] || "";delete this[key];return value;}}; this.hidden=true; this.inert=false; this.listeners={}; this.children=[]; this.parentElement=null; this.classes=new Set();
      this.classList={toggle:(k,v)=>v?this.classes.add(k):this.classes.delete(k),remove:k=>this.classes.delete(k)}; }
    setAttribute(k,v) { this.attrs[k]=String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(k,fn) { this.listeners[k]=fn; }
    detach() { if (this.parentElement) this.parentElement.children=this.parentElement.children.filter(n=>n!==this); }
    append(...nodes) { nodes.forEach(node => { node.detach(); node.parentElement=this; this.children.push(node); }); }
    prepend(node) { node.detach(); node.parentElement=this; this.children.unshift(node); }
    before(node) { node.detach(); node.parentElement=this.parentElement; if(this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this),0,node); }
    after(node) { node.detach(); node.parentElement=this.parentElement; if(this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this)+1,0,node); }
    contains(node) { return node===this || this.children.some(child=>child.contains(node)); }
    querySelectorAll(selector) { if (selector === ".session-user-badge") return []; return this.children.filter(n=>selector==="button" || (selector.includes("data-request-view") ? n.dataset.requestView : selector.includes("workspace") ? n.dataset.androidWorkspace : n.dataset.androidPage)); }
    closest(selector) { return selector==="button" ? this : selector.includes("workspace") ? (this.dataset.androidWorkspace || this.dataset.requestView ? this:null) : (this.dataset.androidPage ? this:null); }
  }
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id)) nodes.set(id,new Node(id)); return nodes.get(id);};
  const dock=get("android-host-dock"), tools=get("android-page-tools");
  dock.children=["playback","queue","request","users","my"].map(p=>{const n=new Node(p);n.dataset.androidPage=p;return n;});
  tools.children=["queue","history","request","random"].map(p=>{const n=new Node(p);n.dataset.androidWorkspace=p;return n;});
  get("top-controls").append(get("cache-settings"),get("presentation-settings"));
  get("cache-panel").append(get("host-account-settings"));
  get("cache-usage-side").append(get("bbdown-status-row"));
  get("host-account-settings").append(get("bbdown-login-panel"));
  const workspaceButtons = Object.entries({queue:"queue",history:"queue",request:"request",random:"request",users:"users",settings:"my"})
    .map(([workspace,page])=>{const n=get("work-rail-"+workspace);n.dataset.hostWorkspace=workspace;n.dataset.compactPage=page;return n;});
  for(const [id,attr,modes] of [["android-layout-switch","androidLayoutMode",["auto","desktop","phone"]],["android-orientation-switch","androidOrientationMode",["system","landscape","portrait"]]]) {
    get(id).append(...modes.map(mode=>{const button=new Node(mode);button.dataset[attr]=mode;return button;}));
  }
  const requestTabs=get("shared-request-tabs");
  get("request-header").append(requestTabs);
  requestTabs.children=["quick","search","discover","sources"].map(p=>{const n=new Node(p);n.dataset.requestView=p;return n;});
  const random=get("android-request-random");
  random.dataset.androidWorkspace="random";
  requestTabs.children.push(random);
  const root={dataset:{nativeHost:native?"true":"false",hostPlatform:native?platform:"desktop"}};
  const state={activeHostWorkspace:"queue",requestSubview:"quick",cacheSettingsOpen:false};
  const elements={leftColumn:get("stage"),hostWorkspaceRegion:get("workspace"),cachePanel:get("cache-panel")};
  const listeners={};
  const orientation={type:orientationType,addEventListener:(k,fn)=>{listeners.orientation=fn;}};
  const history={state:null,entries:[],replaceState(s){this.state=s;this.entries[this.entries.length-1]=s;},pushState(s){this.state=s;this.entries.push(s);}};
  const calls=[];
  const window={innerWidth:width,innerHeight:850,screen:{orientation},BilikaraLayoutPolicy:{resolveLayout},BilikaraHostWindowPreferences:{client,orientation:platform === "android"},addEventListener:(k,fn)=>{listeners[k]=fn;},matchMedia:()=>({matches:true})};
  const context={window,history,state,elements,clearTimeout:()=>{},t:key=>key,
    document:{querySelectorAll:selector=>selector==='[data-host-workspace]'?workspaceButtons:[],documentElement:root,getElementById:get,querySelector:selector=>selector.includes("settings-workspace-body") ? get("settings-body") : requestTabs,createElement:tag=>new Node(tag),createComment:()=>new Node("anchor"),addEventListener:()=>{}},
    syncSessionUserControls:()=>{},syncHostAccountPresentation:()=>{},
    syncCachePanelVisibility:()=>{},schedulePersistentStageMeasurement:()=>{},
    setAppMessage:message=>calls.push(message),
    renderHostWorkspaceSelection:()=>window.BilikaraHostLayout?.syncVisibility(),
    activateHostWorkspace:(name,{inputOrigin}={})=>{state.activeHostWorkspace=name;calls.push(name);window.BilikaraHostLayout?.workspaceActivated(name,inputOrigin);window.BilikaraHostLayout?.syncVisibility();},
  };
  vm.runInNewContext(source,context);
  const clickPage=name=>dock.listeners.click({target:dock.children.find(n=>n.dataset.androidPage===name)});
  const clickWorkspace=name=>tools.listeners.click({target:tools.children.find(n=>n.dataset.androidWorkspace===name)});
  return {root,window,orientation,listeners,history,nodes,get,dock,tools,state,elements,calls,context,clickPage,clickWorkspace};
}

const desktop=setup(false);
assert.equal(desktop.window.BilikaraHostLayout,undefined);
assert.equal(desktop.get("cache-settings").parentElement.id,"top-controls");
assert.deepEqual(desktop.calls,[]);
const nativeDesktop=setup(true,"landscape-primary",1280,null,"desktop");
assert.equal(nativeDesktop.window.BilikaraHostLayout,undefined);
assert.equal(nativeDesktop.root.dataset.hostLayout,"landscape");
assert.equal(nativeDesktop.get("presentation-settings").parentElement.id,"top-controls");
assert.equal(nativeDesktop.get("android-layout-settings").hidden,true);
assert.equal(nativeDesktop.get("android-orientation-settings").hidden,true);
for (const width of [320, 390, 600]) {
  const narrow=setup(true,"portrait-primary",width,null,"desktop");
  assert.equal(narrow.root.dataset.hostLayout,"landscape");
  assert.equal(narrow.window.BilikaraHostLayout,undefined);
  assert.equal(narrow.dock.hidden,true);
  for (const id of ["cache-settings", "presentation-settings"])
    assert.equal(narrow.get(id).parentElement.id,"top-controls");
  assert.equal(narrow.get("shared-request-tabs").parentElement.id,"request-header");
  assert.deepEqual(narrow.calls,[],"Resizing desktop must not navigate Android pages");
}
const mobile=setup();
assert.equal(mobile.get("presentation-settings").parentElement.className,"settings-section android-display-settings");
assert.equal(mobile.get("presentation-settings").parentElement.parentElement.id,"settings-body");
assert.equal(mobile.root.dataset.hostPage,"playback");
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
assert.equal(mobile.root.dataset.hostPage,"playback");
mobile.context.activateHostWorkspace("users");
assert.equal(mobile.root.dataset.hostPage,"users");
mobile.clickPage("my");
assert.equal(mobile.window.BilikaraHostLayout.settingsEmbedded(),true);
assert.equal(mobile.state.cacheSettingsOpen,true);
assert.equal(mobile.get("host-account-settings").parentElement.id,"android-account-slot");
assert.equal(mobile.get("bbdown-status-row").parentElement.id,"host-account-settings");
assert.equal(mobile.get("bbdown-login-panel").parentElement.id,"host-account-settings");
mobile.get("android-open-settings").listeners.click();
assert.equal(mobile.window.BilikaraHostLayout.settingsEmbedded(),false);
assert.equal(mobile.state.cacheSettingsOpen,false);
assert.equal(mobile.elements.hostWorkspaceRegion.hidden,false);
mobile.get("android-settings-back").listeners.click();
assert.equal(mobile.get("android-my-page").hidden,false);
assert.equal(mobile.state.cacheSettingsOpen,true);
assert.equal(mobile.history.state.hostLayout.settings,false);
// Typing resizes the viewport, not the physical screen orientation.
mobile.window.innerWidth=412; mobile.window.innerHeight=220;
mobile.listeners.resize();
assert.equal(mobile.root.dataset.hostLayout,"portrait");
mobile.window.innerWidth=850;
mobile.orientation.type="landscape-primary"; mobile.listeners.orientation();
assert.equal(mobile.dock.hidden,true);
assert.equal(mobile.elements.leftColumn.inert,false);
assert.equal(mobile.get("cache-settings").parentElement.id,"top-controls");
assert.equal(mobile.get("host-account-settings").parentElement.id,"cache-panel");
assert.equal(mobile.get("bbdown-status-row").parentElement.id,"cache-usage-side");
assert.equal(mobile.get("bbdown-login-panel").parentElement.id,"host-account-settings");
assert.equal(mobile.get("shared-request-tabs").parentElement.id,"request-header");
assert.equal(mobile.get("presentation-settings").parentElement.id,"top-controls");
Object.assign(mobile.elements.cachePanel.style,{position:"fixed",left:"120px",right:"auto",top:"64px","--fixture-token":"preserved"});
mobile.window.innerWidth=412;
mobile.orientation.type="portrait-primary"; mobile.listeners.orientation();
assert.equal(mobile.dock.hidden,false);
assert.equal(mobile.root.dataset.hostPage,"my");
assert.equal(mobile.get("cache-settings").parentElement.id,"android-settings-slot");
for(const property of ["position","left","right","top"]) assert.equal(mobile.elements.cachePanel.style[property],undefined,"Phone flow releases desktop popup geometry");
assert.equal(mobile.elements.cachePanel.style["--fixture-token"],"preserved","Unrelated inline styles are retained");
mobile.listeners.popstate({state:{hostLayout:{page:"request",requestView:"random",queueView:"history"}}});
assert.equal(mobile.root.dataset.hostPage,"request");
assert.equal(mobile.state.activeHostWorkspace,"random");
mobile.listeners.popstate({state:{hostLayout:{page:"invalid"}}});
assert.equal(mobile.root.dataset.hostPage,"request");

(async()=>{
  // Tablet portrait is wide enough for shared desktop UI. Split-window width,
  // not device orientation or IME height, selects the compact phone layout.
  const tablet=setup(true,"portrait-primary",800);
  assert.equal(tablet.dock.hidden,true);
  tablet.context.activateHostWorkspace("users");
  tablet.window.innerWidth=600;tablet.listeners.resize();
  assert.equal(tablet.root.dataset.hostPage,"users");
  assert.equal(tablet.dock.hidden,false);
  const writes=[];
  let finish;
  const client={load:()=>new Promise(resolve=>{finish=resolve;}),
    saveLayout:mode=>{writes.push(mode);throw Error('Retired layout selector must not write');},
    saveOrientation:mode=>{writes.push(mode);throw Error('Ordinary windows must follow system rotation');}};
  const automatic=setup(true,"portrait-primary",412,client);
  assert.equal(automatic.dock.hidden,false,"Layout is usable while native preferences load");
  assert.equal(automatic.get("android-orientation-switch").listeners.click,undefined);
  finish({layout:"desktop",orientation:"portrait"});await Promise.resolve();
  assert.equal(automatic.dock.hidden,false,"Former manual desktop preference cannot pin phone layout");
  assert.match(automatic.window.BilikaraHostLayout.diagnosticsMarkdown(),/requested_orientation.*system/);
  automatic.window.innerWidth=1280;automatic.orientation.type="landscape-primary";automatic.listeners.orientation();
  assert.equal(automatic.dock.hidden,true,"System rotation to a wide viewport uses the desktop layout");
  automatic.window.innerWidth=412;automatic.orientation.type="portrait-primary";automatic.listeners.orientation();
  assert.equal(automatic.dock.hidden,false,"System rotation back restores the phone layout");
  assert.deepEqual(writes,[],"Rotation does not write preferences or request a native orientation lock");
  const failed=setup(true,"portrait-primary",412,{load:async()=>{throw Error("disk");}});
  await Promise.resolve();await Promise.resolve();
  assert.equal(failed.dock.hidden,false,"Failed native preference reads cannot prevent responsive layout");
  assert.ok(failed.calls.includes("mobile.windowPreferenceFailed"),"Preference read failure stays actionable");
  console.log("PASS portrait navigation, shared settings, responsive layout, system rotation and native preference read failure");
})().catch(error=>{console.error(error);process.exitCode=1;});
