import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {keyboardInset} = require('../static/ios-host.js');
const source = readFileSync(new URL('../static/ios-host.js', import.meta.url), 'utf8');

test('iOS keyboard measurements distinguish editing, viewport panning and pinch zoom', () => {
  assert.equal(keyboardInset({height:520,offsetTop:0,scale:1},844,true),324);
  assert.equal(keyboardInset({height:520,offsetTop:40,scale:1},844,true),284);
  assert.equal(keyboardInset({height:520,offsetTop:0,scale:2},844,true),0);
  assert.equal(keyboardInset({height:520,offsetTop:0,scale:1},844,false),0);
  assert.equal(keyboardInset({height:900,offsetTop:0,scale:1},844,true),0);
  assert.equal(keyboardInset({height:NaN,offsetTop:0,scale:1},844,true),0);
  assert.equal(keyboardInset(null,844,true),0);
});

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {listeners,
    addEventListener(name, fn) {if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn);},
    removeEventListener(name, fn) {listeners.get(name)?.delete(fn);},
    emit(name) {for (const fn of listeners.get(name) || []) fn();},
  });
}

test('iOS viewport adaptation coalesces events and releases/reinstalls listeners without touching media', () => {
  const styles = new Map(), frames = new Map();
  const viewport = events({height:844,offsetTop:0,scale:1});
  let sequence = 0, editing = false, scrolls = 0;
  const context = events({visualViewport:viewport,innerHeight:844,
    requestAnimationFrame(fn) {frames.set(++sequence,fn);return sequence;},
    cancelAnimationFrame(id) {frames.delete(id);},
    document: events({documentElement:{dataset:{nativeHost:'true',hostPlatform:'ios'},style:{
      setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)}},
      activeElement:{matches:()=>editing,closest:()=>null,scrollIntoView:()=>scrolls++,
        getBoundingClientRect:()=>({top:80,bottom:120})}}),
  });
  vm.runInNewContext(source,context);
  const flush = () => {for(const [id,fn] of frames){frames.delete(id);fn();}};
  flush(); editing = true; viewport.height = 520;
  viewport.emit('resize'); viewport.emit('scroll'); context.document.emit('focusin');
  assert.equal(frames.size,1);
  flush();
  assert.equal(styles.get('--mobile-ime-height'),'324px');
  assert.equal(scrolls,0,'a top input fully above the keyboard must not scroll the page (IOS-09-09)');
  viewport.scale = 2; viewport.emit('resize'); flush();
  assert.equal(styles.get('--mobile-ime-height'),'0px');
  context.emit('pagehide');
  assert.equal(viewport.listeners.get('resize').size,0);
  assert.equal(context.document.listeners.get('focusin').size,0);
  assert.equal(styles.has('--mobile-ime-height'),false);
  context.emit('pageshow'); context.emit('pageshow');
  assert.equal(viewport.listeners.get('resize').size,1);
  assert.equal(context.document.listeners.get('focusin').size,1);
  viewport.scale = 1; flush();
  assert.equal(styles.get('--mobile-ime-height'),'324px');
  editing = false; context.document.emit('focusout'); flush();
  assert.equal(styles.get('--mobile-ime-height'),'0px');
  assert.equal(context.BilikaraIOSHost.diagnostics().keyboard_inset,0);
  assert.equal(scrolls,0);
});

test('iOS keyboard scrolls only an occluded field, by the minimum owner distance (IOS-09-09)', () => {
  const styles = new Map(), frames = new Map();
  const viewport = events({height:844,offsetTop:0,scale:1});
  let sequence = 0, intoView = 0;
  const body = {};
  const owner = {parentElement:body,scrollTop:0,scrollHeight:2000,clientHeight:700,
    getBoundingClientRect:()=>({top:0,bottom:700})}; // Scrollport extends under the keyboard.
  // Lower field at layout y 600..640 inside a real scroll owner.
  const field = {parentElement:owner,matches:()=>true,closest:()=>null,scrollIntoView:()=>intoView++,
    getBoundingClientRect:()=>({top:600-owner.scrollTop,bottom:640-owner.scrollTop})};
  const context = events({visualViewport:viewport,innerHeight:844,
    getComputedStyle:element=>({overflowY:element===owner?'auto':'visible',getPropertyValue:()=>''}),
    requestAnimationFrame(fn) {frames.set(++sequence,fn);return sequence;},
    cancelAnimationFrame(id) {frames.delete(id);},
    document: events({body,documentElement:{dataset:{nativeHost:'true',hostPlatform:'ios'},style:{
      setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key),getPropertyValue:key=>styles.get(key)||''}},
      activeElement:field}),
  });
  vm.runInNewContext(source,context);
  const flush = () => {for(const [id,fn] of frames){frames.delete(id);fn();}};
  flush();
  // (B) Keyboard covers y >= 520: bottom edge + 4px focus room must land on the keyboard edge.
  viewport.height = 520; viewport.emit('resize'); flush();
  assert.equal(styles.get('--mobile-ime-height'),'324px');
  assert.equal(owner.scrollTop,640+4-520,'minimal local scroll of the nearest owner');
  assert.equal(intoView,0,'no document-wide scrollIntoView when a real owner can scroll');
  viewport.emit('scroll'); context.document.emit('scroll'); flush();
  assert.equal(owner.scrollTop,124,'a now-visible field is not scrolled again');
  // (C) Dismissal adds no further offset.
  viewport.height = 844; viewport.emit('resize'); flush();
  assert.equal(styles.get('--mobile-ime-height'),'0px');
  assert.equal(owner.scrollTop,124); assert.equal(intoView,0);
  // WK native pan already shows the field (visual viewport 124..644): no double compensation.
  owner.scrollTop = 0; viewport.offsetTop = 124; viewport.height = 520; viewport.emit('resize'); flush();
  assert.equal(styles.get('--mobile-ime-height'),'200px');
  assert.equal(owner.scrollTop,0); assert.equal(intoView,0);
  // P0-UI-2: another field can be occluded while that same keyboard stays open.
  context.document.activeElement={...field,getBoundingClientRect:()=>({top:660-owner.scrollTop,bottom:700-owner.scrollTop})};
  context.document.emit('focusin');flush();
  assert.equal(owner.scrollTop,60,'focus changes must recheck visibility even when the inset stays 200px');
  assert.equal(intoView,0);
  context.document.activeElement=field;owner.scrollTop=0;
  // Without a scrollable owner the occluded field falls back to one nearest scrollIntoView.
  viewport.offsetTop = 0; viewport.height = 844; viewport.emit('resize'); flush();
  owner.scrollHeight = 700; viewport.height = 520; viewport.emit('resize'); flush();
  assert.equal(owner.scrollTop,0); assert.equal(intoView,1);
});

test('iOS viewport adapter leaves Android, desktop and ordinary pages alone', () => {
  for (const dataset of [{hostPlatform:'android',nativeHost:'true'}, {hostPlatform:'desktop',nativeHost:'true'},
    {hostPlatform:'ios'}, {}]) {
    const context = {document:{documentElement:{dataset}}};
    vm.runInNewContext(source,context);
    assert.equal(context.BilikaraIOSHost,undefined);
  }
});

test('iOS dock watches content/font geometry once and releases observers across page retirement', () => {
  const styles=new Map(),frames=new Map(),resizes=[],mutations=[];
  let height=14,sequence=0;
  const icon={tagName:'svg',scrollHeight:99,getClientRects:()=>[{}],getBoundingClientRect:()=>({height:24})};
  const label={tagName:'SPAN',get scrollHeight(){return height;},getClientRects:()=>[{}],getBoundingClientRect:()=>({height})};
  const dock={removeAttribute(){},getClientRects:()=>[{}],querySelectorAll:selector=>selector==='button'?[{children:[icon,label]}]:[icon,label]};
  const context=events({innerHeight:844,getComputedStyle:()=>({rowGap:'3px',paddingTop:'2px',paddingBottom:'2px'}),
    requestAnimationFrame(fn){frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),
    ResizeObserver:class{constructor(callback){this.callback=callback;this.nodes=new Set();resizes.push(this);}
      observe(node){this.nodes.add(node);}unobserve(node){this.nodes.delete(node);}disconnect(){this.nodes.clear();}},
    MutationObserver:class{constructor(callback){this.callback=callback;mutations.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}},
    document:events({activeElement:null,getElementById:()=>dock,documentElement:{dataset:{nativeHost:'true',hostPlatform:'ios',hostLayout:'portrait'},
      style:{setProperty:(key,value)=>styles.set(key,value),getPropertyValue:key=>styles.get(key)||'',removeProperty:key=>styles.delete(key)}}}),
  });
  vm.runInNewContext(source,context);
  const flush=()=>{for(const[id,fn]of frames){frames.delete(id);fn();}};
  flush();assert.equal(styles.get('--ios-dock-button-height'),'45px','SVG scroll overflow is not layout height');
  height=42;for(let i=0;i<100;i++){resizes[0].callback();mutations[0].callback();}
  assert.equal(frames.size,1);flush();assert.equal(styles.get('--ios-dock-button-height'),'73px');
  assert.equal(resizes[0].nodes.size,2);
  context.emit('pagehide');assert.equal(resizes[0].nodes.size,0);assert.equal(mutations[0].active,false);
  assert.equal(styles.has('--ios-dock-button-height'),false);
  resizes[0].callback();mutations[0].callback();
  assert.equal(frames.size,0,'retired callbacks cannot restore insets');
  assert.equal(resizes[0].nodes.size,0);
  context.emit('pageshow');context.emit('pageshow');flush();
  assert.equal(resizes.length,1);assert.equal(resizes[0].nodes.size,2);assert.equal(mutations[0].active,true);
});

test('Android system/export adapters require Android identity even when bridge-shaped objects exist', () => {
  for (const platform of ['ios','desktop',undefined]) for (const file of ['android-platform.js','android-export.js']) {
    const context = {document:{documentElement:{dataset:{nativeHost:'true',hostPlatform:platform}}},
      BilikaraHostPlatform:{postMessage(){assert.fail('foreign platform command');}},
      BilikaraHostExport:{postMessage(){assert.fail('foreign platform export');}}};
    vm.runInNewContext(readFileSync(new URL('../static/'+file,import.meta.url),'utf8'),context);
    assert.equal(context.BilikaraAndroidPlatform,undefined);
    assert.equal(context.BilikaraAndroidExport,undefined);
    assert.equal(context.document.documentElement.dataset.nativeExportReady,undefined);
  }
});

test('Android playback workarounds require both the native platform and the engine identity', () => {
  const app = readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
  const fragment = app.slice(app.indexOf('function isAndroidNativePlaybackRuntime()'),app.indexOf('function clearSplitAudioClockRecovery('));
  for (const [platform,ua,expected] of [['android','Android Chrome/133',true], ['ios','Android Chrome/133',false],
    ['ios','iPhone AppleWebKit/605.1.15',false], ['desktop','Android Chrome/133',false]]) {
    const context = {document:{documentElement:{dataset:{nativeHost:'true',hostPlatform:platform}}},navigator:{userAgent:ua}};
    assert.equal(vm.runInNewContext(fragment+'\nisAndroidNativePlaybackRuntime()',context),expected);
  }
});
