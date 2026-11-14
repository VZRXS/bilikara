import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Component behavior only; actual CSS visibility/navigation is checked by the
// existing real-Host media_output_browser suite.
function fixture() {
  class Node {
    constructor(){this.dataset={};this.attrs=new Map();this.children=new Map();this.listeners={};this.classList={add(){}};this.hidden=false;this.disabled=false;this.textContent='';}
    querySelector(key){if(!this.children.has(key))this.children.set(key,new Node());return this.children.get(key);}
    setAttribute(key,value){this.attrs.set(key,value);}
    removeAttribute(key){this.attrs.delete(key);}
    hasAttribute(key){return this.attrs.has(key);}
    append(){} prepend(){}
    addEventListener(key,fn){this.listeners[key]=fn;}
    getClientRects(){return this.hidden||this.parentElement?.hidden?[]:[{}];}
  }
  const root=new Node(),page=new Node(),errors=[],observers=new Set();root.parentElement=page;root.dataset.mediaOutput='settings';
  root.querySelector('select').options=[new Node(),new Node()];root.querySelector('.media-output-mode').firstElementChild=new Node();
  const context={document:{querySelectorAll:()=>[root],getElementById:()=>null,createElement:()=>new Node()},getComputedStyle:()=>({visibility:'visible'}),
    MutationObserver:class{constructor(fn){this.fn=fn;}observe(){observers.add(this);}disconnect(){observers.delete(this);}}};
  context.window=context;vm.runInNewContext(readFileSync(new URL('../static/media-output.js',import.meta.url),'utf8'),context);
  const options={host:true,t:key=>key,onError:key=>errors.push(key),request:async()=>{throw Error('request failed');}};
  let data={media_output:{target:'local',requested_target:'local',status:'authorized',authorized:true,available:true,can_manage:true,offset_mode:'splice',busy:false}};
  const sync=patch=>{data={...data,...patch};context.BilikaraMediaOutput.sync(data,options);};sync();
  return {root,page,options,errors,sync,output:patch=>sync({media_output:{...data.media_output,...patch}}),
    node:key=>root.querySelector(key),status:()=>root.querySelector('.media-output-status').textContent,
    fail:async()=>{await root.querySelector('.media-output-toggle').listeners.change();await new Promise(resolve=>setImmediate(resolve));},
    visibility:()=>{for(const observer of [...observers])observer.fn();}};
}

test('IOS-R2-04b retains actionable failure across progress, revisions and localization; relevant recovery retires it',async()=>{
  const f=fixture();await f.fail();assert.equal(f.status(),'mediaOutput.actionFailed');assert.deepEqual(f.errors,['mediaOutput.error']);
  f.sync({state_revision:2});f.output({position:12,measured_adjust_latency_ms:20,busy:false});
  assert.equal(f.status(),'mediaOutput.actionFailed');
  f.options.t=key=>'translated:'+key;f.sync();assert.equal(f.status(),'translated:mediaOutput.actionFailed');
  f.output({target:'native',status:'streaming'});assert.equal(f.status(),'translated:mediaOutput.status.streaming');
  assert.equal(f.node('.media-output-error').hidden,true);
});

test('IOS-R2-04b retry success clears local failure while server failures retain their existing owner',async()=>{
  const f=fixture();await f.fail();f.options.request=async()=>({});await f.fail();
  assert.equal(f.node('.media-output-error').hidden,true);
  f.output({status:'error',last_error:'purek_output_codec'});
  assert.equal(f.node('.media-output-error').hidden,false);assert.equal(f.node('.media-output-error').textContent,'mediaOutput.codec');
  f.page.hidden=true;f.visibility();f.page.hidden=false;f.sync();
  assert.equal(f.node('.media-output-error').hidden,false,'navigation does not erase authoritative backend errors');
});

test('IOS-R2-04b closing/re-entering a group and disabling output retire only its temporary error',async()=>{
  const f=fixture();await f.fail();f.page.hidden=true;f.visibility();f.page.hidden=false;f.sync();
  assert.equal(f.node('.media-output-error').hidden,true);assert.notEqual(f.status(),'mediaOutput.actionFailed');
  await f.fail();f.sync({media_output:null});f.output({target:'local',status:'stopped',can_manage:true});
  assert.equal(f.node('.media-output-error').hidden,true);
});

test('IOS-R2-04b a pending failure after closing/re-entering still reaches the toast without reviving the group error',async()=>{
  const f=fixture();let reject;f.options.request=()=>new Promise((_,r)=>{reject=r;});
  const toggle=f.node('.media-output-toggle');toggle.listeners.change();assert.equal(toggle.disabled,true);assert.equal(toggle.hasAttribute('aria-busy'),true);
  toggle.listeners.change();f.page.hidden=true;f.visibility();f.page.hidden=false;f.sync();
  reject({code:'purek_output_backend_unavailable'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.errors,['mediaOutput.backendUnavailable']);assert.equal(toggle.disabled,false);assert.equal(toggle.hasAttribute('aria-busy'),false);
  assert.equal(f.node('.media-output-error').hidden,true);assert.notEqual(f.status(),'mediaOutput.actionFailed');
});
