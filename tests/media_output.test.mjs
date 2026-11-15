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
    append(...nodes){for(const node of nodes)if(node.className)this.children.set('.'+node.className,node);} prepend(){}
    addEventListener(key,fn){this.listeners[key]=fn;}
    click(){if(!this.disabled)this.listeners.click?.();}
    getClientRects(){return this.hidden||this.parentElement?.hidden?[]:[{}];}
  }
  const root=new Node(),page=new Node(),errors=[],observers=new Set(),scanButton=new Node(),scanTool=new Node(),scans=[];
  root.parentElement=page;root.dataset.mediaOutput='settings';
  // The real #purek-open already owns local camera / Remote invitation /
  // authorization and connected management. The output component must reuse it.
  scanButton.closest=selector=>selector==='.purek-scan-tool'?scanTool:null;
  scanButton.addEventListener('click',()=>scans.push('existing-scan-flow'));
  root.querySelector('select').options=[new Node(),new Node()];root.querySelector('.media-output-mode').firstElementChild=new Node();
  const context={BilikaraNativeOutput:{decoderKind:()=> 'mse'},document:{querySelectorAll:selector=>selector==='[data-media-output]'?[root]:[],getElementById:id=>id==='purek-open'?scanButton:null,createElement:()=>new Node()},getComputedStyle:()=>({visibility:'visible'}),
    MutationObserver:class{constructor(fn){this.fn=fn;}observe(){observers.add(this);}disconnect(){observers.delete(this);}}};
  context.window=context;vm.runInNewContext(readFileSync(new URL('../static/media-output.js',import.meta.url),'utf8'),context);
  const options={host:true,t:key=>key,onError:key=>errors.push(key),request:async()=>{throw Error('request failed');}};
  let data={media_output:{target:'local',requested_target:'local',status:'authorized',authorized:true,available:true,can_manage:true,offset_mode:'splice',busy:false}};
  const sync=patch=>{data={...data,...patch};context.BilikaraMediaOutput.sync(data,options);};sync();
  return {root,page,options,errors,sync,scanButton,scans,setDecoder:kind=>{context.BilikaraNativeOutput=kind?{decoderKind:()=>kind}:undefined;},output:patch=>sync({media_output:{...data.media_output,...patch}}),
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

test('IOS-R2-04b data hiding a pending group retires late failure before subsequent navigation',async()=>{
  const f=fixture();let reject;f.options.request=()=>new Promise((_,r)=>{reject=r;});
  f.node('.media-output-toggle').listeners.change();
  f.sync({media_output:null});assert.equal(f.root.hidden,true);
  f.output({target:'local',requested_target:'local',status:'authorized',authorized:true,available:true,can_manage:true,busy:false});
  assert.equal(f.root.hidden,false);
  reject(Error('late failure'));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.errors,['mediaOutput.error'],'the failure still reaches its toast owner');
  f.page.hidden=true;f.visibility();f.page.hidden=false;f.sync();
  assert.equal(f.node('.media-output-error').hidden,true);assert.notEqual(f.status(),'mediaOutput.actionFailed');
});

for(const available of [false,true])test(`R8 14.3 disconnected scan entry remains usable with companion available=${available}`,async()=>{
  const f=fixture(),requests=[];f.options.request=async(...args)=>requests.push(args);
  f.output({authorized:false,available,status:'local'});
  assert.equal(f.scanButton.hasAttribute('data-media-output-add-device'),true);
  assert.equal(f.scanButton.hidden,false);assert.equal(f.scanButton.disabled,false);
  assert.equal(f.status(),'mediaOutput.status.notConnected');
  assert.equal(f.node('.media-output-status').hidden,false);
  const toggle=f.node('.media-output-toggle');
  assert.equal(toggle.checked,false);assert.equal(toggle.disabled,true);
  assert.match(toggle.attrs.get('aria-label'),/mediaOutput.status.notConnected/);
  assert.equal(f.node('.media-output-targets').title,'mediaOutput.status.notConnected');
  toggle.checked=true;await f.fail();
  assert.equal(toggle.checked,false);assert.deepEqual(requests,[]);assert.deepEqual(f.scans,[],'switch never opens Scan/Manage');
  f.scanButton.click();assert.deepEqual(f.scans,['existing-scan-flow'],'entry retains the original scan handler');
  assert.deepEqual(requests,[],'entry does not claim an output target');
});

test('R8 14.3 connected devices retain their original action and explicit output switching',async()=>{
  const f=fixture(),requests=[];f.options.request=async(...args)=>requests.push(args);
  f.output({authorized:false,status:'local'});
  f.output({authorized:true,status:'authorized'});
  assert.equal(f.scanButton.hasAttribute('data-media-output-add-device'),false,'no disconnected entry after connection');
  assert.equal(f.scanButton.hidden,false,'the original Manage/Disconnect action remains mounted');
  const toggle=f.node('.media-output-toggle');assert.equal(toggle.disabled,false);
  toggle.checked=true;await f.fail();
  assert.equal(requests.length,1);assert.equal(requests[0][0],'/api/player/output');
  assert.equal(requests[0][1].target,'purek');assert.equal(requests[0][1].experimental,true);
  assert.deepEqual(f.scans,[]);
});

test('R8 14.3 an active standalone pipeline can still return to local without opening device management',async()=>{
  const f=fixture(),requests=[];f.options.request=async(...args)=>requests.push(args);
  f.output({authorized:false,target:'native',status:'streaming'});
  const toggle=f.node('.media-output-toggle');assert.equal(toggle.disabled,false);assert.equal(toggle.checked,true);
  toggle.checked=false;await f.fail();
  assert.equal(requests[0][1].target,'local');assert.deepEqual(f.scans,[]);
});

test('R8 14.3 disconnected status is localized in all three supported languages',()=>{
  const {languages}=JSON.parse(readFileSync(new URL('../static/i18n.json',import.meta.url),'utf8'));
  for(const [language,label] of [['zh','未连接设备'],['en','No device connected'],['ja','デバイス未接続']]){
    assert.equal(languages[language]['mediaOutput.status.notConnected'],label);
  }
});

test('standalone pipeline action starts native explicitly, guards duplicates, and can return to local',async()=>{
  const f=fixture(),requests=[];let release;
  f.options.request=(...args)=>{requests.push(args);return new Promise(resolve=>{release=resolve;});};
  f.output({authorized:false,target:'local',available:true});
  const button=f.node('.media-output-pipeline-test'),toggle=f.node('.media-output-toggle');
  assert.equal(button.hidden,false);assert.equal(button.disabled,false);
  assert.equal(button.textContent,'mediaOutput.pipelineTest');
  assert.equal(toggle.checked,false);assert.equal(toggle.disabled,true);
  button.click();button.click();
  assert.equal(requests.length,1);assert.equal(requests[0][0],'/api/player/output');
  assert.equal(requests[0][1].target,'native');assert.equal(requests[0][1].experimental,true);
  assert.equal(button.disabled,true);assert.equal(button.hasAttribute('aria-busy'),true);
  assert.equal(button.textContent,'mediaOutput.working');assert.deepEqual(f.scans,[]);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.hasAttribute('aria-busy'),false);assert.equal(button.disabled,false);
  f.output({target:'native',status:'streaming'});assert.equal(button.hidden,true);
  assert.equal(toggle.checked,true);assert.equal(toggle.disabled,false);
  toggle.checked=false;await f.fail();assert.equal(requests[1][1].target,'local');
  release();await new Promise(resolve=>setImmediate(resolve));
});

for(const [available,decoder] of [[false,'mse'],[true,'unavailable'],[true,null]])test(`standalone action is absent without companion/decoder: ${available}/${decoder}`,async()=>{
  const f=fixture(),requests=[];f.options.request=async(...args)=>requests.push(args);f.setDecoder(decoder);
  f.output({authorized:false,target:'local',available});
  const button=f.node('.media-output-pipeline-test');assert.equal(button.hidden,true);
  button.click();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(requests,[]);
  assert.equal(f.node('.media-output-toggle').disabled,true);assert.equal(f.node('.media-output-toggle').checked,false);
  assert.equal(f.node('.media-output-note').textContent,available?'mediaOutput.decoderUnavailable':'mediaOutput.backendUnavailable');
});

test('standalone action is absent when connected, rechecks capability, and keeps failure ownership',async()=>{
  const f=fixture(),button=f.node('.media-output-pipeline-test');assert.equal(button.hidden,true);
  f.output({authorized:false});assert.equal(button.hidden,false);
  f.output({authorized:true});assert.equal(button.hidden,true);
  f.output({authorized:false});f.setDecoder('unavailable');button.click();
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.errors,[],'lost decoder is checked before starting');
  f.setDecoder('native');f.sync();button.click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.errors,['mediaOutput.error']);assert.equal(button.hasAttribute('aria-busy'),false);
  assert.equal(f.node('.media-output-toggle').checked,false);assert.equal(f.node('.media-output-toggle').disabled,true);
});

test('standalone action has an explicit three-language test label',()=>{
  const {languages}=JSON.parse(readFileSync(new URL('../static/i18n.json',import.meta.url),'utf8'));
  for(const [language,label] of [['zh','管线测试'],['en','Test pipeline'],['ja','パイプラインテスト']]){
    assert.equal(languages[language]['mediaOutput.pipelineTest'],label);
  }
});
