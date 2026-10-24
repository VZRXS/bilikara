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
      activeElement:{matches:()=>editing,closest:()=>null,scrollIntoView:()=>scrolls++}}),
  });
  vm.runInNewContext(source,context);
  const flush = () => {for(const [id,fn] of frames){frames.delete(id);fn();}};
  flush(); editing = true; viewport.height = 520;
  viewport.emit('resize'); viewport.emit('scroll'); context.document.emit('focusin');
  assert.equal(frames.size,1);
  flush();
  assert.equal(styles.get('--mobile-ime-height'),'324px');
  assert.equal(scrolls,1);
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
});

test('iOS viewport adapter leaves Android, desktop and ordinary pages alone', () => {
  for (const dataset of [{hostPlatform:'android',nativeHost:'true'}, {hostPlatform:'desktop',nativeHost:'true'},
    {hostPlatform:'ios'}, {}]) {
    const context = {document:{documentElement:{dataset}}};
    vm.runInNewContext(source,context);
    assert.equal(context.BilikaraIOSHost,undefined);
  }
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
