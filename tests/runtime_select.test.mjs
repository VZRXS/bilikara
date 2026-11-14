import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const runtimeSource=readFileSync(new URL('../static/runtime-select.js',import.meta.url),'utf8');
const appSource=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const slice=(start,end)=>{
  const first=appSource.indexOf(start),last=appSource.indexOf(end,first);
  assert.ok(first>=0&&last>first,'actual renderer/listener source must exist');
  return appSource.slice(first,last);
};

// EventTarget supplies actual event delivery. The select fixture supplies only
// option/value storage for the shipped renderer, not native Picker behavior.
function fixture(platform='ios',popover=true) {
  class Select extends EventTarget {
    hidden=false; disabled=false; value=''; options=[]; dataset={};
    set innerHTML(value) { assert.equal(value,'');this.options=[]; }
    appendChild(option) { this.options.push(option); }
    get selectedOptions() { return this.options.filter(option=>option.value===this.value); }
  }
  const installed=[],created=[];
  const document={documentElement:{dataset:{hostPlatform:platform}},
    addEventListener:type=>installed.push(type),createElement:tag=>{
      created.push(tag);assert.equal(tag,'option','no button, popover or duplicate input');
      return {value:'',textContent:'',disabled:false};
    }};
  class HTMLElement {}
  if(popover) HTMLElement.prototype.showPopover=()=>assert.fail('native select does not use Popover');
  const window={addEventListener:type=>installed.push(type),visualViewport:{addEventListener:type=>installed.push(type)}};
  const elements={cacheQualitySelect:new Select(),cacheDownloadSourceSelect:new Select()};
  const state={language:'zh',cachePolicySaving:false,downloadSourcePreparing:false,data:{cache_policy:{}}};
  const writes=[];
  const context=vm.createContext({window,document,HTMLElement,elements,state,Event,
    formatQualityLabel:value=>state.language+':'+value,t:key=>state.language+':'+key,
    setCachePolicyPreference:async patch=>{writes.push({...patch});Object.assign(state.data.cache_policy,patch);},
    setDownloadSourcePreference:async value=>{writes.push({download_source:value});state.data.cache_policy.download_source=value;},
  });
  vm.runInContext(runtimeSource,context);
  const render=()=>vm.runInContext('renderCachePolicyControls(state.data.cache_policy)',context);
  const loadRenderer=()=>vm.runInContext(slice('function renderCachePolicyControls(','function isSafeHostSnapshotInteger('),context);
  const loadListeners=()=>vm.runInContext(slice('elements.cacheQualitySelect?.addEventListener("change"','elements.cacheHiresCheckbox?.addEventListener("change"'),context);
  return {window,document,elements,state,writes,installed,created,render,loadRenderer,loadListeners};
}

test('runtime select hooks leave original controls visible and install no input or popup handlers on any platform',()=>{
  for(const platform of ['ios','android','desktop']) for(const popover of [true,false]) {
    const f=fixture(platform,popover),api=f.window.BilikaraRuntimeSelect;
    assert.ok(Object.isFrozen(api));
    for(const select of Object.values(f.elements)) {
      select.value='unchanged';select.disabled=true;
      api.sync(select);api.close(true);api.sync(select);
      assert.equal(select.hidden,false);
      assert.equal(select.value,'unchanged');assert.equal(select.disabled,true);
      select.disabled=false;api.sync(select);
      assert.equal(select.disabled,false);
    }
    f.document.documentElement.dataset.hostPlatform='ios';
    api.sync(f.elements.cacheQualitySelect);api.sync(null);api.close();
    assert.deepEqual(f.installed,[],'no interception of native keyboard, pointer, focus or cancellation');
    assert.deepEqual(f.created,[],'no custom or duplicate controls');
  }
});

test('the actual cache renderer preserves select identity, localized options and independent pending disabled states',()=>{
  const f=fixture(),quality=f.elements.cacheQualitySelect,source=f.elements.cacheDownloadSourceSelect;
  f.loadRenderer();
  Object.assign(f.state.data.cache_policy,{video_quality:'720P',video_quality_choices:['1080P','720P'],
    download_source:'bbdown',download_source_choices:['bbdown','native']});
  f.render();
  assert.equal(quality.value,'720P');assert.equal(source.value,'bbdown');
  assert.deepEqual(source.options.map(option=>option.value),['native','bbdown']);
  const options=quality.options;
  f.state.cachePolicySaving=true;f.render();
  assert.equal(quality.disabled,true);assert.equal(source.disabled,true);
  assert.equal(quality.options,options,'pending changes do not replace unchanged native options');
  f.state.cachePolicySaving=false;f.state.downloadSourcePreparing=true;f.render();
  assert.equal(quality.disabled,false);assert.equal(source.disabled,true);
  f.state.downloadSourcePreparing=false;
  for(const language of ['en','ja','zh']) {
    f.state.language=language;f.render();
    assert.equal(quality.selectedOptions[0].textContent,language+':720P');
    assert.equal(quality.value,'720P');assert.equal(source.value,'bbdown');
    assert.equal(f.elements.cacheQualitySelect,quality);assert.equal(f.elements.cacheDownloadSourceSelect,source);
    assert.equal(quality.hidden,false);assert.equal(source.hidden,false);
    assert.equal(quality.disabled,false);assert.equal(source.disabled,false);
  }
  assert.ok(f.created.every(tag=>tag==='option'));assert.deepEqual(f.writes,[]);
});

test('native input and change events reach the existing quality/downloader handlers once without a mirrored value',async()=>{
  const f=fixture();f.loadRenderer();f.loadListeners();
  Object.assign(f.state.data.cache_policy,{video_quality:'1080P',video_quality_choices:['1080P','720P'],
    download_source:'native',download_source_choices:['native','bbdown']});
  f.render();
  for(const [select,value,expected] of [
    [f.elements.cacheQualitySelect,'720P',{video_quality:'720P'}],
    [f.elements.cacheDownloadSourceSelect,'bbdown',{download_source:'bbdown'}],
  ]) {
    const inputs=[],changes=[],count=f.writes.length;
    select.addEventListener('input',event=>inputs.push(event.target.value));
    select.addEventListener('change',event=>changes.push(event.target.value));
    select.value=value;
    f.window.BilikaraRuntimeSelect.sync(select);
    assert.equal(select.dispatchEvent(new Event('keydown',{cancelable:true})),true,'keyboard remains native');
    assert.equal(select.dispatchEvent(new Event('input',{bubbles:true,cancelable:true})),true);
    assert.equal(f.writes.length,count,'input does not synthesize a second change');
    select.dispatchEvent(new Event('change',{bubbles:true}));await Promise.resolve();
    assert.deepEqual(inputs,[value]);assert.deepEqual(changes,[value]);
    assert.equal(f.writes.length,count+1);assert.deepEqual(f.writes.at(-1),expected);
    f.render();f.window.BilikaraRuntimeSelect.close();
    select.dispatchEvent(new Event('change',{bubbles:true}));await Promise.resolve();
    assert.equal(f.writes.length,count+1,'unchanged completion retains the existing duplicate guard');
  }
});
