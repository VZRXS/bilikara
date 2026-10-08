import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import nativeTest, {before} from 'node:test';
function test(name,options,run){return nativeTest(name,options,async t=>{try{await run(t);}catch(error){console.error(name,error.stack);throw error;}});}
test.after=nativeTest.after;
import {chromium} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeHost, buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, HttpClient, isolatedEnvironment, waitFor} from './native_host_support.mjs';
import {localSignaling} from './local_signaling_fixture.mjs';

let executable, androidHost;
before(async () => {
  executable = process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
  androidHost = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
}, {timeout:300000});
const cleanups = new WeakMap();
function cleanup(t,action){
  if(!cleanups.has(t)){cleanups.set(t,[]);t.after(async()=>{
    let failure;
    for(const [index,action] of cleanups.get(t).reverse().entries())try{
      if(process.env.BILIKARA_SOURCE_TEST_DEBUG)console.log('Cleanup started',t.name,index);
      await action();
      if(process.env.BILIKARA_SOURCE_TEST_DEBUG)console.log('Cleanup finished',t.name,index);
    }catch(error){failure ||= error;}
    if(failure)throw failure;
  });}
  cleanups.get(t).push(action);
}
const sourceIds = Array.from({length:60}, (_,i) => String(42+i));
const bvid = 'BV1z84y1p7oS';
const snapshots = [], timings = [], sourceLayouts = [], completed = new WeakSet();
function save(data, file, value) {writeFileSync(path.join(data,file),JSON.stringify(value));}
function read(data, file) {return JSON.parse(readFileSync(path.join(data,file),'utf8'));}
async function fixture(t, {android=false, size=18} = {}) {
  const home = mkdtempSync(path.join(tmpdir(),'bilikara-source-editor-')), data=path.join(home,'data'); mkdirSync(data);
  writeFileSync(path.join(data,'.bilikara-desktop-rust-preview'),'desktop-rust-preview-v1\n');
  const ids=sourceIds.slice(0,size);
  save(data,'native-library-defaults.json',{schema_version:1});
  save(data,'gatcha_uids.json',{schema_version:2,uids:ids,profiles:Object.fromEntries(ids.map((id,i)=>[id,{name:`本地 UP ${i+1}`,avatar_url:'/fixture-avatar.png'}]))});
  save(data,'gatcha_cache.json',{schema_version:3,uids:Object.fromEntries(ids.map(id=>[id,[{bvid,title:`Shared song ${id}`}]]))});
  save(data,'gatcha_favlist.json',{schema_version:2,uids:['42'],folders:[{uid:'42',id:'10',title:'我的本地收藏',media_count:1},{uid:'42',id:'11',title:'独立收藏夹',media_count:1},{uid:'43',id:'10',title:'同编号其他 UP',media_count:1}],items:[{bvid,fav_uid:'42',fav_folder_id:'10'},{bvid,fav_uid:'42',fav_folder_id:'11'},{bvid,fav_uid:'43',fav_folder_id:'10'}]});
  let host;
  cleanup(t,async () => {try {if(host)await host.close();} finally {if(completed.has(t))rmSync(home,{recursive:true,force:true});else console.error('Source failure fixture retained:',home);}});
  const start=performance.now();
  host=await RunningHost.start(android?androidHost:executable,home,android?[data,path.join(root,'static')]:['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')],isolatedEnvironment(home),android);
  timings.push({name:android?'android-fixture-start':'desktop-fixture-start',ms:Math.round(performance.now()-start)});
  await host.api('/api/session-users/add',{name:'Fixture singer'});
  return {host,data,ids,async restart() {
    await host.close();
    host=await RunningHost.start(android?androidHost:executable,home,android?[data,path.join(root,'static')]:['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')],isolatedEnvironment(home),android);
    return host;
  }};
}
async function screenshot(page, name) {
  if (!process.env.BILIKARA_TEST_SCREENSHOT_DIR) return;
  const output=path.resolve(process.env.BILIKARA_TEST_SCREENSHOT_DIR);mkdirSync(output,{recursive:true});
  const file=path.join(output,name+'.png'); await page.screenshot({path:file});
  snapshots.push(file);
}
async function browser(t, host, {android=false, remote=false, origin=host.base, hasTouch=android||remote} = {}) {
  const instance=await chromium.launch({headless:process.env.BILIKARA_SOURCE_TEST_HEADED!=='1',args:['--disable-background-networking','--disable-features=WebRtcHideLocalIpsWithMdns'],...(process.platform==='win32'?{channel:'msedge'}:{})});
  cleanup(t,async()=>{if(!completed.has(t)&&process.env.BILIKARA_TEST_SCREENSHOT_DIR){for(const [i,p] of instance.contexts().flatMap(c=>c.pages()).entries())if(!p.isClosed())await screenshot(p,`failure-${t.name.includes('touch')?'touch':t.name.includes('public')?'public':'desktop'}-${i}`).catch(()=>{});}await instance.close();});
  const context=await instance.newContext({viewport:android||remote?{width:390,height:844}:{width:700,height:650},hasTouch,reducedMotion:'reduce',locale:'zh-CN'});
  if(!remote)await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:origin})));
  await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
  if(android)await context.addInitScript(()=>{
    window.BilikaraHostWindow={postMessage(raw){if(['enter','exit'].includes(raw))return;const {id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));}};
  });
  const requests={local:0,blocked:0,mutations:[]};
  context.on('request',request=>{
    const url=new URL(request.url());
    if([host.base,origin].includes(url.origin))requests.local++;
    if(url.pathname==='/api/gatcha/sources/edit')requests.mutations.push(request.postDataJSON());
  });
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(![host.base,origin].includes(url.origin)){requests.blocked++;return route.abort('blockedbyclient');}
    if(url.pathname==='/fixture-avatar.png')return route.fulfill({contentType:'image/png',body:readFileSync(path.join(root,'static/pic/icon.png'))});
    return route.continue();
  });
  const page=await context.newPage(), errors=[], consoleLogs=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['error','warning'].includes(message.type())&&consoleLogs.length<50)consoleLogs.push({type:message.type(),text:message.text().slice(0,300)});});
  await page.goto(origin+(remote?'/remote':'/'));
  await page.waitForFunction(()=>typeof state!=='undefined'&&Boolean(state.data));
  if(remote){
    await page.locator('#remote-identity-input').fill('Source Remote');
    await page.locator('#remote-identity-submit').click();
    await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  }
  await page.waitForFunction(()=>document.title.toLowerCase().includes('bilikara'));
  assert.match(await page.title(),/bilikara/iu);assert.equal(new URL(page.url()).origin,origin);
  await page.evaluate(()=>{window.sourceMediaNodes=[...document.querySelectorAll('video,audio')];});
  return {page,context,errors,requests,consoleLogs};
}
async function sources(page, android=false, remote=false) {
  if(remote)await page.locator('[data-remote-request-view="sources"]').click();
  else {
    if(android)await page.locator('[data-android-page="request"]').click();
    else await page.locator('[data-host-workspace="request"]').click();
    await page.locator('[data-request-view="sources"]').click();
  }
  await page.locator(remote?'#sources-follow-grid .follow-up-button':'#follow-up-grid .source-removal-card').first().waitFor({state:'visible'});
  if(!remote)await settleSourceFit(page);
}
async function settleSourceFit(page,source='uid') {
  await page.waitForFunction(source=>{
    const editor=sourceRemovalEditors.get(source);if(!editor?.active)return false;
    const grid=editor.grid,card=grid.firstElementChild,style=getComputedStyle(grid),pager=editor.panel.querySelector('.host-result-pager');
    if(!card||pager.hidden)return false;
    const size=BilikaraResultPager.fittedPageSize({columns:style.gridTemplateColumns.split(' ').length,
      height:editor.scroll.clientHeight,itemHeight:card.getBoundingClientRect().height,gap:parseFloat(style.rowGap)||0,
      padding:(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0)});
    return size!==null&&grid.children.length===Math.min(size,editor.records.length-(Number(pager.dataset.page)-1)*size);
  },source);
}
async function holdSource(page, card) {
  const source=await card.evaluate(node=>node.closest('#favlist-grid')?'favlist':'uid');
  await page.waitForFunction(source=>{const editor=sourceRemovalEditors.get(source);return editor?.active&&!editor.blocked;},source);
  await card.scrollIntoViewIfNeeded(); const box=await card.boundingBox(),session=await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
    await page.waitForFunction(()=>Boolean(document.querySelector('.source-select-mode[aria-pressed="true"]:not([hidden])')));
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  } finally { await session.detach(); }
}
async function enterSelection(page,grid,footer,android) {
  if(android)await holdSource(page,grid.locator('.source-removal-card .follow-up-button').first());
  else await footer.locator('.source-select-mode').click();
}
async function selectPage(grid,footer,android) {
  if(android){const cards=grid.locator('.source-checkbox:not(:checked)'),count=await cards.count();for(let index=0;index<count;index++)await cards.first().tap();}
  else await footer.locator('.source-select-page').click();
}
async function exitSelection(footer) { await footer.locator('.source-select-mode').click(); }
async function settleSourceCompletion(page,host) {
  // A committed HTTP result can precede its terminal SSE snapshot. Consume
  // that real completion and its queued browse read before starting the next
  // independent gesture; loading must still cancel an interrupted drag.
  const task=JSON.stringify((await host.api('/api/state')).gatcha?.last_result);
  await page.waitForFunction(task=>JSON.stringify(state.data?.gatcha?.last_result)===task,task);
  await page.waitForFunction(()=>!state.followBrowseLoading&&!state.favlistBrowseLoading
    &&!state.followBrowseReloadTimer&&!state.favlistBrowseReloadTimer);
}
async function dragRemoval(page,grid,footer,android=false,{outside=false,cancel=false,beforeDrop,shot}={}) {
  await page.evaluate(()=>{
    window.sourceDragTrace=[];
    if(window.sourceDragTraceInstalled)return;window.sourceDragTraceInstalled=true;
    for(const type of ['pointerdown','pointermove','pointercancel','gotpointercapture','lostpointercapture','dragstart','resize'])window.addEventListener(type,event=>{
      if(sourceDragTrace.length<30)sourceDragTrace.push({type,id:event.pointerId,target:event.target?.className||'',time:Math.round(event.timeStamp)});
    },true);
  });
  const checkbox=grid.locator('.source-checkbox:checked').first();await checkbox.scrollIntoViewIfNeeded();
  const box=await checkbox.boundingBox(),start={x:box.x+box.width/2,y:box.y+box.height/2};
  assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.matches('.source-checkbox'),start),true,'drag begins at the actual checkbox');
  const session=android?await page.context().newCDPSession(page):null;
  const touch=(type,p)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:p?[p]:[]});
  try {
    if(android){await touch('touchStart',start);await touch('touchMove',{x:start.x+8,y:start.y});}
    else {await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+8,start.y);}
    const trash=await footer.locator('.source-trash-slot').boundingBox(),end=outside?{x:1,y:1}:{x:trash.x+trash.width/2,y:trash.y+trash.height/2};
    if(android){for(let step=1;step<=6;step++){await touch('touchMove',{x:start.x+(end.x-start.x)*step/6,y:start.y+(end.y-start.y)*step/6});await page.waitForTimeout(16);}}
    else await page.mouse.move(end.x,end.y,{steps:6});
    const over=await footer.locator('.source-remove-selected').evaluate(node=>node.classList.contains('drag-over'));
    if(!over&&!outside)console.error('Source drag evidence',await page.evaluate(()=>({events:sourceDragTrace,editors:[...sourceRemovalEditors].map(([source,editor])=>({source,blocked:editor.blocked,pointer:editor.pointer&&{id:editor.pointer.id,kind:editor.pointer.kind,target:editor.pointer.target.className,overTrash:editor.pointer.overTrash},selected:[...editor.selected]}))})));
    assert.equal(over,!outside,'only a valid occupied drop target becomes solid');
    if(!outside){
      await page.waitForFunction(source=>{const node=document.querySelector(`.source-tools[data-source="${source}"] .source-remove-selected`);return node.classList.contains('drag-over')&&getComputedStyle(node).opacity==='1';},await footer.getAttribute('data-source'),{timeout:1500});
      const feedback=await footer.locator('.source-remove-selected').evaluate(node=>{const style=getComputedStyle(node);return {opacity:style.opacity,color:style.color,background:style.backgroundColor,blur:style.backdropFilter};});
      assert.equal(feedback.opacity,'1','drag-over feedback is visibly solid');assert.equal(feedback.color,'rgb(255, 255, 255)');
      assert.notEqual(feedback.background,'rgba(0, 0, 0, 0)');assert.match(feedback.blur,/blur\(/u);
    }
    if(shot)await screenshot(page,shot);
    if(beforeDrop)await beforeDrop();
    if(cancel==='pointer'&&android){await touch('touchCancel');return;}
    if(cancel)await page.keyboard.press('Escape');
    if(android)await touch('touchEnd');else await page.mouse.up();
  } finally { if(session)await session.detach(); }
}
async function assertMedia(page) {
  assert.equal(await page.evaluate(()=>{const now=[...document.querySelectorAll('video,audio')];return now.length===sourceMediaNodes.length&&now.every((n,i)=>n===sourceMediaNodes[i]);}),true);
}
async function remoteBrowseGestures(page, card) {
  const box=await card.boundingBox(),session=await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await page.waitForTimeout(650);await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await session.detach();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2+20,{steps:8});await page.mouse.up();
  await card.focus();await page.keyboard.press('Alt+ArrowDown');await page.keyboard.press('Escape');
  assert.equal(await page.locator('.source-tools, .source-checkbox, .source-order-handle').count(),0);
  assert.equal(await page.evaluate(()=>state.followBrowseSelectedUid),'');
}
async function footerBounds(page, source='uid') {
  const value=await page.evaluate(source=>{
    const footer=document.querySelector(`.source-tools[data-source="${source}"]`), panel=footer.closest('.source-mode-panel');
    const scroll=panel.querySelector('.source-browse-scroll');
    const box=n=>{const b=n.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,height:b.height};};
    const style=getComputedStyle(footer);
    const pager=panel.querySelector('.host-result-pager');
    return {footer:box(footer),scroll:box(scroll),panel:box(panel),pager:pager&&!pager.hidden?box(pager):null,editing:footer.querySelector('.source-select-mode').getAttribute('aria-pressed')==='true',hidden:footer.hidden,mobile:document.documentElement.dataset.hostPlatform==='android',position:style.position,background:style.backgroundColor,shadow:style.boxShadow,paddingBottom:parseFloat(getComputedStyle(panel).paddingBottom),window:innerHeight,dock:document.querySelector('#android-host-nav')?.getBoundingClientRect().top||innerHeight};
  },source);
  assert.equal(value.position,'absolute','tools never own a layout track on either Host');
  assert.equal(value.background,'rgba(0, 0, 0, 0)');assert.equal(value.shadow,'none','no full-width toolbar surface');
  if(value.hidden){assert.equal(value.footer.height,0,'ordinary mobile browsing reserves no toolbar space');return value;}
  if(value.pager&&!value.editing&&!value.mobile){
    assert.ok(value.footer.top>=value.pager.top&&value.footer.bottom<=value.pager.bottom+1,'desktop entry occupies the existing page chrome');
  }else{
    assert.ok(value.footer.top>=value.scroll.top&&value.footer.top<value.scroll.bottom,'editing tools overlay the existing viewport');
    if(value.pager)assert.ok(value.footer.bottom<=value.pager.top,'editing tools never cover pagination');
  }
  assert.ok(value.footer.bottom<=value.window+1,JSON.stringify(value));
  assert.ok(value.footer.bottom<=value.panel.bottom+1,JSON.stringify(value));
  assert.ok(value.footer.bottom<=value.dock+1,JSON.stringify(value));
  return value;
}
async function assertNativeSourceFrame(page, {source='uid', fits=true}={}) {
  const value=await page.evaluate(({source,fits})=>{
    const panel=document.querySelector(source==='uid'?'#request-sources-uids':'#request-sources-favorites');
    const scroll=panel.querySelector('.source-browse-scroll'),pager=panel.querySelector('.host-result-pager');
    const form=panel.querySelector('.source-uid-form'),inputs=[...form.children],rect=node=>{const b=node.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:b.width,height:b.height};};
    const body=rect(scroll),footer=rect(pager),cardNodes=[...panel.querySelectorAll('.source-removal-card')];
    return {panel:rect(panel),body,footer,external:pager.parentElement===panel&&!scroll.contains(pager),
      overflow:document.documentElement.scrollWidth>innerWidth+1,clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight,
      fields:inputs.map(node=>({...rect(node),fontSize:getComputedStyle(node).fontSize,radius:getComputedStyle(node).borderRadius})),refreshType:form.querySelector('.source-refresh-button')?.type,
      cards:fits?cardNodes.map(rect):[],reachable:[...pager.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node=>node.getClientRects().length&&getComputedStyle(node).pointerEvents!=='none').every(node=>{
        const b=rect(node);return node.contains(document.elementFromPoint((b.left+b.right)/2,(b.top+b.bottom)/2));
      })};
  },{source,fits});
  assert.equal(value.external,true,'native page navigation lives outside the scroll body');assert.equal(value.overflow,false);
  assert.ok(value.body.bottom<=value.footer.top-4,'the frame leaves one pagination gap');
  assert.ok(value.footer.bottom<=value.panel.bottom-12+1,'pagination stays inside the panel border');
  assert.equal(value.footer.height,52,'44px controls have just 4px above/below');assert.equal(value.reachable,true,'floating tools cannot intercept page controls');
  for(const field of value.fields){assert.equal(field.height,44);assert.equal(field.fontSize,'16px');assert.equal(field.radius,'14px');assert.ok(Math.abs(field.top-value.fields[0].top)<=1,'source actions stay on one row');}
  if(source==='uid')assert.equal(value.refreshType,'button','manual refresh never submits the UID form');
  if(fits){
    assert.ok(value.scrollHeight<=value.clientHeight+1,'ordinary fitted pages do not need scrolling');
    for(const card of value.cards)assert.ok(card.top>=value.body.top-1&&card.bottom<=value.body.bottom+1,'complete card rows fit inside the visible body');
  }
  return value;
}
async function sourceLayout(page, label) {
  const value=await page.evaluate(()=>{
    const panel=document.querySelector('#request-sources-uids'),scroll=panel.querySelector('.source-browse-scroll');
    const grid=panel.querySelector('.follow-up-grid'),pager=panel.querySelector('.result-pager');
    const box=node=>{const b=node.getBoundingClientRect();return {top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
    return {viewport:innerWidth,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      items:grid.querySelectorAll('.source-removal-card').length,page:pager.querySelector('[data-page-input]').value,
      panel:box(panel),scroll:box(scroll),grid:box(grid),pager:box(pager),
      clientHeight:scroll.clientHeight,scrollHeight:scroll.scrollHeight,scrollTop:scroll.scrollTop,
      paddingBottom:parseFloat(getComputedStyle(scroll).paddingBottom)};
  });
  sourceLayouts.push({label,...value});return value;
}
async function assertFullSourceCapacity(page) {
  const value=await page.evaluate(()=>{
    const editor=sourceRemovalEditors.get('uid'),grid=editor.grid,style=getComputedStyle(grid);
    const cards=[...grid.children],first=cards[0].getBoundingClientRect(),last=cards.at(-1).getBoundingClientRect();
    return {columns:style.gridTemplateColumns.split(' ').length,count:cards.length,total:editor.records.length,
      lastId:cards.at(-1).dataset.sourceId,finalId:editor.records.at(-1).id,height:first.height,
      nextBottom:last.bottom+first.height+parseFloat(style.rowGap),
      bottom:editor.scroll.getBoundingClientRect().bottom-parseFloat(style.paddingBottom)};
  });
  assert.equal(value.height,72,'more rows retain the shared compact card height');
  if(value.lastId!==value.finalId&&value.count+value.columns<=48){
    assert.ok(value.nextBottom>value.bottom+.5,'another complete row must not fit in unused visible space');
  }
}
async function assertNoSourceTextSelection(page) {
  const value=await page.evaluate(()=>({text:String(getSelection()),collapsed:getSelection().isCollapsed,
    targets:[...document.querySelectorAll('#follow-up-grid .source-removal-card, #follow-up-grid .source-removal-card *')].map(node=>({
      name:node.className,userSelect:getComputedStyle(node).userSelect,webkitUserSelect:getComputedStyle(node).webkitUserSelect,
    }))}));
  assert.equal(value.text,'','a genuine long press or drag must not create a text range');assert.equal(value.collapsed,true);
  for(const target of value.targets){assert.equal(target.userSelect,'none',target.name);assert.equal(target.webkitUserSelect,'none',target.name);}
}
async function selectionControls(page, session=false) {
  const selector=session?'.session-user-mode-button[data-mode="select"]':'.source-tools[data-source="uid"] .source-select-mode';
  await page.locator(selector).evaluate(async toggle=>{
    // Compare the rendered pressed state after its own color transition,
    // rather than comparing one control's first frame with another's end.
    getComputedStyle(toggle).borderColor;
    await Promise.all(toggle.getAnimations().map(animation=>animation.finished));
  });
  return page.evaluate(session=>{
    const toggle=document.querySelector(session?'.session-user-mode-button[data-mode="select"]':'.source-tools[data-source="uid"] .source-select-mode');
    const checkbox=document.querySelector(session?'.session-user-checkbox': '#follow-up-grid .source-checkbox');
    const trash=document.querySelector(session?'.session-user-trash':'.source-tools[data-source="uid"] .source-remove-selected');
    const slot=trash.parentElement,shape=node=>{const b=node.getBoundingClientRect(),s=getComputedStyle(node);return {width:b.width,height:b.height,radius:s.borderRadius};};
    return {toggle:shape(toggle),pressed:toggle.getAttribute('aria-pressed'),border:getComputedStyle(toggle).borderColor,
      color:getComputedStyle(toggle).color,icon:shape(toggle.querySelector('svg')),svg:toggle.querySelector('svg').outerHTML,
      checkbox:{...shape(checkbox),appearance:getComputedStyle(checkbox).appearance,accent:getComputedStyle(checkbox).accentColor},
      trash:shape(trash),slot:shape(slot)};
  },session);
}
const edit=async(host,source,action)=>host.api('/api/gatcha/sources/edit',{source,expected_version:(await host.api(source==='uid'?'/api/gatcha/browse':'/api/gatcha/favlist/browse')).source_order_version,edit:action});

test('native source editing validates a whole batch, Host capability, narrow version and legacy authorized removal', {timeout:60000},async t=>{
  const {host,data}=await fixture(t,{size:3}),guest=new HttpClient(host.base);await guest.request('/remote');
  const files=['gatcha_uids.json','gatcha_cache.json','gatcha_favlist.json'];
  const before=files.map(file=>readFileSync(path.join(data,file),'utf8'));
  const initial=await host.api('/api/gatcha/browse'),body={source:'uid',expected_version:initial.source_order_version,edit:{action:'remove',ids:['42','43']}};
  assert.ok((await guest.request('/api/gatcha/source/remove',{source:'uid',id:'42'})).status>=400);
  assert.equal((await guest.request('/api/gatcha/sources/edit',body)).status,403);
  await guest.api('/api/remote-identity/register',{name:'API Remote'});
  assert.equal((await guest.request('/api/gatcha/sources/edit',body)).status,403,'registered Remote remains unable to use new Host edit API');
  for(const invalid of [{...body,extra:true},{...body,edit:{...body.edit,extra:true}},{...body,edit:{action:'remove',ids:['42','42']}},{...body,edit:{action:'remove',ids:['42','999']}},{...body,edit:{action:'move',id:'42',before_id:'999'}},{...body,expected_version:'0'.repeat(64)}]){
    assert.ok((await host.request('/api/gatcha/sources/edit',invalid)).status>=400);
    assert.deepEqual(files.map(file=>readFileSync(path.join(data,file),'utf8')),before);
  }
  assert.equal(existsSync(path.join(data,'gatcha_source_order.json')),false);
  const stateBefore=await host.api('/api/state');
  assert.equal((await edit(host,'uid',{action:'move',id:'42',before_id:'42'})).changed,false);
  assert.equal((await host.api('/api/state')).revision,stateBefore.revision,'no-op does not publish AppState');
  const ordered=await edit(host,'uid',{action:'move',id:'44',before_id:'42'});assert.equal(ordered.changed,true);
  assert.deepEqual(read(data,'gatcha_uids.json').uids,['42','43','44']);
  assert.equal(readFileSync(path.join(data,'gatcha_cache.json'),'utf8'),before[1]);
  assert.equal((await host.request('/api/gatcha/sources/edit',body)).status,409,'captured version is stale');
  const result=await edit(host,'uid',{action:'remove',ids:['42','43']});
  assert.equal(result.committed,true);assert.equal(result.removed_source_count,2);assert.deepEqual(result.cleanup_pending,[]);
  assert.deepEqual(read(data,'gatcha_uids.json').uids,['44']);assert.ok(read(data,'gatcha_cache.json').uids['44']);
  assert.equal(readFileSync(path.join(data,'gatcha_favlist.json'),'utf8'),before[2]);
  await guest.api('/api/gatcha/source/remove',{source:'favlist',id:'42:10'});
  assert.deepEqual((await host.api('/api/gatcha/favlist/browse')).folders.map(v=>v.id),['42:11','43:10']);
  const final=await host.api('/api/state');assert.equal(final.gatcha.busy,false);
  for(const key of ['playlist','history','current_item','player_settings'])assert.deepEqual(final[key],stateBefore[key]);
  completed.add(t);
});

test('actual native restart retains independent display order and deliberately removed membership', {timeout:60000},async t=>{
  const f=await fixture(t,{size:3});
  await edit(f.host,'uid',{action:'move',id:'44',before_id:'42'});
  await edit(f.host,'favlist',{action:'move',id:'43:10',before_id:'42:10'});
  const result=await edit(f.host,'uid',{action:'remove',ids:['42','43']});
  assert.equal(result.committed,true);
  const files=['gatcha_uids.json','gatcha_cache.json','gatcha_favlist.json','gatcha_source_order.json'];
  const before=files.map(file=>readFileSync(path.join(f.data,file),'utf8'));
  const reopened=await f.restart();
  assert.deepEqual((await reopened.api('/api/gatcha/browse')).owners.map(row=>row.uid),['44']);
  assert.deepEqual((await reopened.api('/api/gatcha/favlist/browse')).folders.map(row=>row.id),['43:10','42:10','42:11']);
  assert.deepEqual(files.map(file=>readFileSync(path.join(f.data,file),'utf8')),before,'restart neither reseeds members nor rewrites display/cache files');
  completed.add(t);
});

test('Host reconciles committed batch cleanup failure and only retries explicit cleanup', {timeout:60000},async t=>{
  const {host,data}=await fixture(t,{size:3}),{page,requests,errors}=await browser(t,host);
  await sources(page);const footer=page.locator('.source-tools[data-source="uid"]');
  await footer.locator('.source-select-mode').click();
  await page.locator('[data-source-id="42"] .follow-up-button').click();
  await page.locator('[data-source-id="43"] .follow-up-button').click();
  // Real membership is committed by the native Host. This response contract
  // injects the already unit-tested post-commit failure for UI reconciliation;
  // it is not a claim of a browser-induced filesystem fault.
  await page.route('**/api/gatcha/sources/edit',async route=>{
    const native=await route.fetch(),body=await native.json();
    assert.equal(body.data.committed,true);body.data.cleanup_pending=['cache'];
    await route.fulfill({response:native,json:body});
  });
  await dragRemoval(page,page.locator('#follow-up-grid'),footer);await page.locator('#confirm-ok').click();
  await waitFor(async()=>!(await footer.locator('.source-select-mode').isDisabled()),'partial commit reconciled');
  assert.deepEqual(read(data,'gatcha_uids.json').uids,['44']);
  assert.equal(await page.locator('#follow-up-grid .source-removal-card').count(),1);
  assert.match(await page.locator('#app-toast').textContent(),/来源已移除.*清理/u);
  await page.unroute('**/api/gatcha/sources/edit');
  await footer.locator('.source-retry-cleanup').click();
  await footer.locator('.source-retry-cleanup').waitFor({state:'hidden'});
  assert.deepEqual(requests.mutations.map(body=>body.edit.action),['remove','cleanup']);
  assert.deepEqual(read(data,'gatcha_uids.json').uids,['44']);
  await assertMedia(page);assert.deepEqual(errors,[]);assert.equal(requests.blocked,0);
  completed.add(t);
});

test('mobile Host long press opens an overlay without moving cards; scroll, cancel, stale data and leaving retire holds',{timeout:120000},async t=>{
  const {host}=await fixture(t,{android:true}),{page,context,requests,errors}=await browser(t,host,{android:true});
  await sources(page,true);
  const footer=page.locator('.source-tools[data-source="uid"]'),card=page.locator('#follow-up-grid [data-source-id="42"] .follow-up-button');
  assert.equal(await footer.isVisible(),false);await footerBounds(page);
  await page.evaluate(()=>{window.sourceCardNodes=[...document.querySelector('#follow-up-grid [data-source-id="42"] .follow-up-button').childNodes];});
  await card.tap();await page.locator('#follow-up-items-view').waitFor({state:'visible'});
  await page.waitForTimeout(500);await page.locator('#follow-browse-back').tap();
  assert.equal(await card.evaluate(button=>button.childNodes.length===sourceCardNodes.length&&[...button.childNodes].every((node,index)=>node===sourceCardNodes[index])),true,'browse loading preserves the original name/count/avatar nodes');
  assert.equal(await footer.isVisible(),false,'quick tap navigates instead of entering selection');
  const session=await context.newCDPSession(page);cleanup(t,()=>session.detach());
  const point=async()=>{await card.scrollIntoViewIfNeeded();const box=await card.locator('.request-card-title-line').first().boundingBox();return {x:box.x+Math.min(18,box.width/2),y:box.y+box.height/2};};
  const start=async p=>session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});
  const cancel=async()=>session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  const snapshot=()=>page.evaluate(()=>{
    const scroll=document.querySelector('#request-sources-followed-scroll'),card=document.querySelector('#follow-up-grid [data-source-id="42"]');
    if(!card.querySelector('.follow-up-name')||!card.querySelector('.follow-up-count')||!card.querySelector('.follow-up-avatar'))throw new Error('source card name/count/avatar nodes were not preserved');
    const box=node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
    return {card:box(card),scroll:box(scroll),panel:box(scroll.closest('.source-mode-panel')),
      name:box(card.querySelector('.follow-up-name')),count:box(card.querySelector('.follow-up-count')),avatar:box(card.querySelector('.follow-up-avatar'))};
  });
  const wideLayoutBefore=await sourceLayout(page,'390-normal');await screenshot(page,'host-touch-390-normal');
  let p=await point();const wideBefore=await snapshot();await start(p);await page.waitForTimeout(180);await assertNoSourceTextSelection(page);
  await footer.waitFor({state:'visible'});await page.waitForTimeout(600);await assertNoSourceTextSelection(page);
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await assertNoSourceTextSelection(page);
  const wideDuring=await snapshot();for(const name of Object.keys(wideBefore))for(const key of Object.keys(wideBefore[name]))assert.ok(Math.abs(wideBefore[name][key]-wideDuring[name][key])<=1,`390px ${name}.${key} stays fixed`);
  const substitution=await page.locator('#follow-up-grid [data-source-id="42"]').evaluate(card=>{
    const checkbox=card.querySelector('.source-checkbox'),count=card.querySelector('.follow-up-count'),box=checkbox.getBoundingClientRect(),old=count.getBoundingClientRect();
    return {count:getComputedStyle(count).visibility,width:box.width,height:box.height,x:box.x-old.x,y:box.y-old.y,native:getComputedStyle(checkbox).appearance,nested:Boolean(checkbox.closest('button')),outline:getComputedStyle(card.querySelector('.follow-up-button')).outlineStyle};
  });
  assert.equal(substitution.count,'hidden');assert.equal(substitution.width,16);assert.equal(substitution.height,16);assert.equal(substitution.nested,false);
  assert.ok(['auto','checkbox'].includes(substitution.native));assert.ok(Math.abs(substitution.x)<=1&&Math.abs(substitution.y)<=1,'native checkbox occupies the old count position');
  assert.equal(substitution.outline,'none','selection uses the existing inner border, not a clipped external outline');
  assert.equal(await page.locator('#follow-up-grid').evaluate(grid=>getComputedStyle(grid).gridTemplateColumns.split(' ').length),3,'overlay keeps all three original columns');
  const wideLayoutDuring=await sourceLayout(page,'390-selection');
  for(const key of ['columns','items','page','panel','scroll','grid','pager','clientHeight'])assert.deepEqual(wideLayoutDuring[key],wideLayoutBefore[key],`full pages retain ${key} when tools appear`);
  assert.equal(wideLayoutDuring.items,18);assert.equal(wideLayoutDuring.page,'1');assert.equal(wideLayoutDuring.paddingBottom,64);
  assert.ok(wideLayoutDuring.scrollHeight>wideLayoutDuring.clientHeight,'additional complete rows keep temporary reach for covered editing targets');
  const checkbox=page.locator('#follow-up-grid [data-source-id="43"] .source-checkbox'),checkboxBox=await checkbox.boundingBox();
  await start({x:checkboxBox.x+checkboxBox.width/2,y:checkboxBox.y+checkboxBox.height/2});
  await page.waitForTimeout(750);await assertNoSourceTextSelection(page);
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await assertNoSourceTextSelection(page);
  if(await checkbox.isChecked())await checkbox.tap();
  await screenshot(page,'host-touch-390-overlay');
  await footer.locator('.source-select-mode').tap();await footer.waitFor({state:'hidden'});await page.waitForTimeout(100);
  const wideAfter=await snapshot();for(const name of Object.keys(wideBefore))for(const key of Object.keys(wideBefore[name]))assert.ok(Math.abs(wideBefore[name][key]-wideAfter[name][key])<=1,`390px ${name}.${key} stays fixed after Done`);
  await page.setViewportSize({width:320,height:640});
  await page.waitForFunction(()=>document.querySelectorAll('#follow-up-grid .source-removal-card').length===6);
  const narrowLayoutBefore=await sourceLayout(page,'320-normal');await screenshot(page,'host-touch-320-normal');
  assert.equal(narrowLayoutBefore.items,6);assert.equal(narrowLayoutBefore.columns,2);assert.equal(narrowLayoutBefore.page,'1');
  assert.equal(narrowLayoutBefore.paddingBottom,0);assert.equal(narrowLayoutBefore.scrollHeight,narrowLayoutBefore.clientHeight,'a shorter native window chooses fewer complete rows');
  p=await point();await start(p);
  for(let step=1;step<=4;step++){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.y-step*20}]});await page.waitForTimeout(20);}
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(500);
  assert.equal(await footer.isVisible(),false,'scroll gesture cancels the hold');
  p=await point();await start(p);await page.waitForTimeout(90);await cancel();await page.waitForTimeout(500);
  assert.equal(await footer.isVisible(),false,'pointer cancellation clears the pending timer');
  p=await point();const before=await snapshot();await start(p);await footer.waitFor({state:'visible'});
  await page.waitForTimeout(750);await assertNoSourceTextSelection(page);const during=await snapshot();
  for(const name of Object.keys(before))for(const key of Object.keys(before[name]))assert.ok(Math.abs(before[name][key]-during[name][key])<=1,`${name}.${key} stays fixed when the overlay appears`);
  assert.equal(await card.getAttribute('aria-pressed'),'true');
  const narrowLayoutDuring=await sourceLayout(page,'320-selection');assert.equal(narrowLayoutDuring.columns,2);assert.equal(narrowLayoutDuring.items,6);assert.equal(narrowLayoutDuring.page,'1');
  assert.equal(narrowLayoutDuring.paddingBottom,64);assert.ok(narrowLayoutDuring.scrollHeight>narrowLayoutBefore.scrollHeight,'covered cards gain temporary scroll reach');
  assert.deepEqual(narrowLayoutDuring.scroll,narrowLayoutBefore.scroll,'scroll reach never shrinks the viewport');
  await footerBounds(page);await screenshot(page,'host-touch-long-press-overlay');
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await card.getAttribute('aria-pressed'),'true','releasing a long hold does not unselect its card');
  assert.equal(await page.evaluate(()=>state.followBrowseSelectedUid),'');assert.equal(requests.mutations.length,0);
  assert.match(await footer.locator('.source-selection-count').textContent(),/1/u);
  assert.equal(await footer.locator('.source-select-page').isVisible(),false);
  assert.equal(await footer.locator('.source-clear-selection').isVisible(),false);
  await dragRemoval(page,page.locator('#follow-up-grid'),footer,true);await page.locator('#confirm-cancel').tap();
  assert.equal(requests.mutations.length,0,'canceling deletion leaves the selection intact');
  await footer.locator('.source-select-mode').tap();await footer.waitFor({state:'hidden'});
  assert.equal(await card.getAttribute('aria-pressed'),null);assert.equal(requests.mutations.length,0,'Done exits without deleting');
  const after=await snapshot();for(const name of Object.keys(before))for(const key of Object.keys(before[name]))assert.ok(Math.abs(before[name][key]-after[name][key])<=1,`${name}.${key} stays fixed after Done`);
  const narrowLayoutAfter=await sourceLayout(page,'320-done');assert.equal(narrowLayoutAfter.paddingBottom,0);assert.equal(narrowLayoutAfter.scrollHeight,narrowLayoutBefore.scrollHeight);
  await screenshot(page,'host-touch-after-done');
  await holdSource(page,card);const fixedPagerBefore=await page.locator('#request-sources-uids > .result-pager').boundingBox();
  const scrollTitle=await page.locator('#follow-up-grid .request-card-title-line').nth(2).boundingBox();
  const scrollPoint={x:scrollTitle.x+scrollTitle.width/2,y:scrollTitle.y+8};
  assert.equal(await page.evaluate(p=>Boolean(document.elementFromPoint(p.x,p.y)?.closest('.source-select-target,.source-tools')),scrollPoint),false,'scrolling starts on card text, outside the checkbox drag target');
  await start(scrollPoint);
  if(process.env.BILIKARA_SOURCE_TEST_DEBUG)console.log('Native scroll gesture',await page.evaluate(p=>{
    const editor=sourceRemovalEditors.get('uid'),scroll=editor.scroll,nodes=[];let node=document.elementFromPoint(p.x,p.y);
    while(node){const style=getComputedStyle(node);nodes.push({id:node.id,class:node.className,touchAction:style.touchAction,overflow:style.overflow,height:node.clientHeight,scrollHeight:node.scrollHeight});node=node.parentElement;}
    return {point:p,nodes,reach:scroll.closest('.source-mode-panel').className,hold:Boolean(editor.hold),pointer:editor.pointer&&{id:editor.pointer.id,kind:editor.pointer.kind,x:editor.pointer.x,y:editor.pointer.y}};
  },scrollPoint));
  for(let step=1;step<=6;step++){
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:scrollPoint.x,y:scrollPoint.y-step*15}]});
    await page.waitForTimeout(16);
  }
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('#request-sources-followed-scroll').scrollTop>0,null,{timeout:1500});
  assert.deepEqual(await page.locator('#request-sources-uids > .result-pager').boundingBox(),fixedPagerBefore,'the native footer never scrolls with the content');
  await page.locator('#request-sources-uids [data-page-action="next"]').tap();
  await page.waitForFunction(()=>document.querySelector('#request-sources-uids > .result-pager').dataset.page==='2');
  await assertNativeSourceFrame(page,{fits:false});
  await page.locator('#request-sources-uids [data-page-action="previous"]').tap();
  await page.waitForFunction(()=>document.querySelector('#request-sources-uids > .result-pager').dataset.page==='1');
  const bottomLayout=await sourceLayout(page,'320-scrolled-page-footer');assert.equal(bottomLayout.page,'1');assert.equal(bottomLayout.items,6);
  await screenshot(page,'host-touch-320-page-footer');
  await exitSelection(footer);
  p=await point();await start(p);await page.waitForTimeout(90);await edit(host,'uid',{action:'move',id:'44',before_id:'42'});
  // Consume the actual native browse revision before the hold deadline;
  // ordinary SSE completion reloads may be coalesced beyond that deadline.
  await page.evaluate(()=>loadFollowBrowse({keepQuery:true}));
  await page.waitForFunction(()=>state.followBrowseData.owners[0].uid==='44'&&!state.followBrowseLoading);
  await page.waitForTimeout(500);await cancel();assert.equal(await footer.isVisible(),false,'stale hold never selects a replacement order');
  p=await point();await start(p);await page.locator('[data-sources-mode="favorites"]').click();await page.waitForTimeout(500);await cancel();
  assert.equal(await page.locator('.source-select-mode[aria-pressed="true"]:visible').count(),0,'leaving the list retires the old hold');
  assert.equal(requests.mutations.length,0);await assertMedia(page);assert.deepEqual(errors,[]);assert.equal(requests.blocked,0);
  completed.add(t);
});

for(const android of [false,true])test(`${android?'Android':'desktop'} checkbox selection and inert trash require a current drag; cancel, stale version and Done do not remove`,{timeout:60000},async t=>{
  const {host}=await fixture(t,{android}),{page,requests,errors,consoleLogs}=await browser(t,host,{android,hasTouch:true});
  if(android)await page.setViewportSize({width:320,height:844});
  if(android)await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator(android?'[data-android-page="users"]':'[data-host-workspace="users"]').click();
  const sessionToggle=page.locator('.session-user-mode-button[data-mode="select"]');await sessionToggle.click();
  const sessionCheckbox=page.locator('.session-user-checkbox').first();await sessionCheckbox.check();
  const sessionControls=await selectionControls(page,true);await screenshot(page,android?'host-touch-session-selection':'host-desktop-session-selection');
  await sessionToggle.click();assert.equal(await sessionToggle.getAttribute('aria-pressed'),'false','Session Users uses its pressed toggle for completion');
  await sources(page,android);const grid=page.locator('#follow-up-grid'),footer=page.locator('.source-tools[data-source="uid"]');
  await enterSelection(page,grid,footer,android);
  const sourceControls=await selectionControls(page);assert.deepEqual(sourceControls,sessionControls,'both rendered Hosts share selection glyph, pressed palette, native checkbox and control/drop geometry');
  assert.deepEqual(sourceControls.toggle,{width:44,height:44,radius:'50%'});assert.equal(sourceControls.icon.width,20);
  assert.equal(sourceControls.checkbox.width,16);assert.equal(sourceControls.checkbox.height,16);
  assert.equal(sourceControls.slot.width,52);assert.equal(sourceControls.slot.height,52);
  const cardGeometry=await grid.locator('.follow-up-button').first().evaluate(button=>{
    const style=getComputedStyle(button),name=button.querySelector('.follow-up-name'),title=getComputedStyle(name),avatar=button.querySelector('.follow-up-avatar');
    return {height:button.getBoundingClientRect().height,radius:style.borderRadius,padding:style.paddingLeft,
      titleHeight:name.getBoundingClientRect().height,font:title.fontSize,line:title.lineHeight,avatar:avatar.getBoundingClientRect().width};
  });
  assert.deepEqual(cardGeometry,{height:72,radius:'16px',padding:'10px',titleHeight:32,font:'14px',line:'16px',avatar:24});
  const first=grid.locator('[data-source-id="42"] .source-checkbox'),second=grid.locator('[data-source-id="43"] .source-checkbox');
  if(!(await first.isChecked())){if(android)await first.tap();else await first.check();}
  await first.focus();await page.keyboard.press('Space');assert.equal(await first.isChecked(),false);
  await page.keyboard.press('Space');assert.equal(await first.isChecked(),true,'native keyboard activation updates selection once');
  assert.equal(await first.evaluate(input=>getComputedStyle(input).outlineStyle),'solid','native checkbox retains visible keyboard focus');
  if(android)await second.tap();else await second.check();
  assert.match(await footer.locator('.source-selection-count').textContent(),/2/u);
  assert.equal(await footer.locator('.source-finish-selection').count(),0,'the existing pressed icon is the only completion control');
  assert.equal(await footer.locator('.source-remove-selected').getAttribute('role'),'img','trash is not a clickable button');
  const trash=await footer.locator('.source-trash-slot').boundingBox();
  if(android)await page.touchscreen.tap(trash.x+trash.width/2,trash.y+trash.height/2);else await page.mouse.click(trash.x+trash.width/2,trash.y+trash.height/2);
  assert.equal(await page.locator('#confirm-popover').isVisible(),false);assert.equal(requests.mutations.length,0);
  assert.match(await footer.locator('.source-selection-count').textContent(),/2/u,'inert trash does not pass a tap to a covered card');
  await screenshot(page,android?'host-touch-checkbox-selection':'host-desktop-checkbox-selection');
  await dragRemoval(page,grid,footer,android,{outside:true});assert.equal(await page.locator('#confirm-popover').isVisible(),false);
  await dragRemoval(page,grid,footer,android,{cancel:android?'pointer':'escape',shot:android?'host-touch-trash-active':'host-desktop-trash-active'});assert.equal(await page.locator('#confirm-popover').isVisible(),false);
  await assertNoSourceTextSelection(page);
  if(!android){await dragRemoval(page,grid,footer,true,{cancel:'pointer'});assert.equal(await page.locator('#confirm-popover').isVisible(),false,'touch dragging on a desktop Host keeps the desktop workflow');}
  assert.equal(await footer.locator('.source-remove-selected').evaluate(node=>node.classList.contains('drag-over')),false,'cancel restores the translucent target');
  await dragRemoval(page,grid,footer,android,{beforeDrop:async()=>{
    await edit(host,'uid',{action:'move',id:'44',before_id:'42'});await page.evaluate(()=>loadFollowBrowse({keepQuery:true}));
    await page.waitForFunction(()=>state.followBrowseData.owners[0].uid==='44'&&!state.followBrowseLoading);
  }});
  assert.equal(await page.locator('#confirm-popover').isVisible(),false,'stale pointer cannot confirm a replacement revision');
  await dragRemoval(page,grid,footer,android);
  await page.locator('#confirm-popover').waitFor({state:'visible'});assert.match(await page.locator('#confirm-text').textContent(),/2/u);
  assert.equal(requests.mutations.length,0,'valid drop only opens confirmation');await page.locator('#confirm-cancel').click();
  await page.locator('#confirm-popover').waitFor({state:'hidden'});
  await exitSelection(footer);assert.equal(await grid.locator('.source-checkbox:visible').count(),0);
  assert.equal(await grid.locator('.follow-up-count').first().evaluate(node=>getComputedStyle(node).visibility),'visible');
  assert.equal(requests.mutations.length,0);assert.deepEqual(errors,[]);assert.deepEqual(consoleLogs,[]);assert.equal(requests.blocked,0);
  await footerBounds(page);await assertMedia(page);completed.add(t);
});

for(const android of [false,true])test(`${android?'mobile':'desktop'} native Source frame fits rows, preserves drafts and selections on resize, and keeps pagination outside scrolling`,{timeout:60000},async t=>{
  const {host}=await fixture(t,{android,size:54}),{page,requests,errors,consoleLogs}=await browser(t,host,{android,hasTouch:true});
  await sources(page,android);
  const panel=page.locator('#request-sources-uids'),grid=page.locator('#follow-up-grid'),footer=page.locator('.source-tools[data-source="uid"]');
  await page.locator('#modal-follow-uid-input').fill('123456');
  await page.evaluate(()=>{window.sourceFramePager=document.querySelector('#request-sources-uids > .host-result-pager');});
  const baseline=await sourceLayout(page,`${android?'mobile':'desktop'}-frame-baseline`);
  await assertNativeSourceFrame(page);await footerBounds(page);
  if(android)assert.equal(baseline.items,18);
  const sizes=android?[[320,844,12],[320,640,6],[390,844,18]]:[[700,600],[1000,900],[700,650]];
  for(const [width,height,count] of sizes){
    await page.setViewportSize({width,height});await settleSourceFit(page);
    const layout=await sourceLayout(page,`${android?'mobile':'desktop'}-frame-${width}x${height}`);
    await assertNativeSourceFrame(page);await assertFullSourceCapacity(page);await footerBounds(page);
    if(count)assert.equal(layout.items,count);
    if(!android&&width===1000)assert.ok(layout.items>baseline.items,'a larger desktop frame admits more complete rows');
    assert.equal(await page.locator('#modal-follow-uid-input').inputValue(),'123456','size changes preserve the UID draft');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.hostPlatform==='android'),android,'input capability and viewport do not change the Host platform');
    if(android)await screenshot(page,`host-mobile-frame-${width}x${height}`);
  }
  for(const language of ['en','ja','zh']){
    await page.evaluate(language=>setLanguage(language),language);await settleSourceFit(page);await assertNativeSourceFrame(page);
    assert.equal(await page.locator('#modal-follow-uid-input').inputValue(),'123456');
  }
  for(const theme of ['dark','blue','light']){
    await page.evaluate(theme=>applyTheme(theme),theme);await assertNativeSourceFrame(page);
  }
  await panel.locator('[data-page-action="next"]').click();
  await page.waitForFunction(()=>document.querySelector('#request-sources-uids > .host-result-pager').dataset.page==='2');
  const anchor=await grid.locator('.source-removal-card').first().getAttribute('data-source-id');
  await page.setViewportSize(android?{width:320,height:844}:{width:1000,height:900});await settleSourceFit(page);
  assert.equal(await grid.locator(`[data-source-id="${anchor}"]`).count(),1,'the former first item stays in the new visible page');
  const pageBefore=await panel.locator('.host-result-pager').getAttribute('data-page'),idsBefore=await grid.locator('.source-removal-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId));
  await host.api('/api/session-users/add',{name:'Unrelated fixture user'});
  await page.waitForFunction(()=>state.data.session_users?.length===2);
  assert.equal(await panel.locator('.host-result-pager').getAttribute('data-page'),pageBefore);
  assert.deepEqual(await grid.locator('.source-removal-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId)),idsBefore,'unrelated native snapshots retain page contents');
  await enterSelection(page,grid,footer,android);
  await grid.locator('.source-checkbox').nth(0).check();await grid.locator('.source-checkbox').nth(1).check();
  const selected=await page.evaluate(()=>[...sourceRemovalEditors.get('uid').selected]);assert.equal(selected.length,2);
  await page.setViewportSize(android?{width:390,height:640}:{width:700,height:600});await settleSourceFit(page);
  assert.deepEqual(await page.evaluate(()=>[...sourceRemovalEditors.get('uid').selected]),selected,'cross-page selections survive a capacity change');
  await assertNativeSourceFrame(page,{fits:false});await footerBounds(page);
  await panel.locator('[data-page-action="next"]').click();await settleSourceFit(page);
  assert.deepEqual(await page.evaluate(()=>[...sourceRemovalEditors.get('uid').selected]),selected,'fixed page navigation remains usable during selection');
  await panel.locator('[data-page-action="previous"]').click();await settleSourceFit(page);
  const visibleSelected=await grid.locator('.source-checkbox:checked').count();
  assert.ok(visibleSelected>0,'the resize case leaves an actual selected drag target on this page');
  {
    await dragRemoval(page,grid,footer,android,{beforeDrop:async()=>{
      await page.setViewportSize(android?{width:390,height:844}:{width:700,height:650});
      await page.waitForFunction(()=>sourceRemovalEditors.get('uid').pointer===null);
    }});
    await page.locator('#confirm-popover').waitFor({state:'hidden'});
    assert.equal(requests.mutations.length,0,'resize cancels an interrupted drag without opening confirmation or submitting');
  }
  await exitSelection(footer);await settleSourceFit(page);await assertNativeSourceFrame(page);
  assert.equal(await page.evaluate(()=>document.querySelector('#request-sources-uids > .host-result-pager')===sourceFramePager),true,'resizing keeps the shared pager node');
  await screenshot(page,android?'host-mobile-native-source-frame':'host-desktop-native-source-frame');
  await grid.locator('.follow-up-button').first().click();await page.locator('#follow-up-items-view').waitFor({state:'visible'});
  assert.equal(await panel.locator('.host-result-pager').isVisible(),false,'the source page footer does not leak into a detail view');
  await page.locator('#follow-browse-back').click();await settleSourceFit(page);await assertNativeSourceFrame(page);
  await page.locator('[data-sources-mode="favorites"]').click();await page.locator('#favlist-grid .source-removal-card').first().waitFor({state:'visible'});
  await settleSourceFit(page,'favlist');await assertNativeSourceFrame(page,{source:'favlist'});await footerBounds(page,'favlist');
  assert.equal(await panel.locator('.host-result-pager').isVisible(),false,'inactive source tabs do not reserve a footer');
  await assertMedia(page);assert.equal(requests.mutations.length,0);assert.equal(requests.blocked,0);assert.deepEqual(errors,[]);assert.deepEqual(consoleLogs,[]);
  if(android){
    const remote=await browser(t,host,{remote:true});await sources(remote.page,false,true);
    assert.equal(await remote.page.locator('#sources-follow-grid .follow-up-button').count(),12,'Remote retains its existing document page capacity');
    assert.equal(await remote.page.locator('.host-result-pager').count(),0,'Remote does not acquire native panel chrome');
    await remote.page.setViewportSize({width:320,height:844});
    for(const language of ['en','ja','zh']){
      await remote.page.evaluate(language=>setLanguage(language),language);
      const fields=await remote.page.locator('#sources-follow-uid-form').evaluate(form=>[...form.children].map(node=>{
        const b=node.getBoundingClientRect(),s=getComputedStyle(node);return {top:b.top,height:b.height,right:b.right,fontSize:s.fontSize,radius:s.borderRadius};
      }));
      assert.equal(fields.length,3);for(const field of fields){assert.equal(field.height,44);assert.equal(field.fontSize,'16px');assert.equal(field.radius,'14px');assert.ok(Math.abs(field.top-fields[0].top)<=1);assert.ok(field.right<=320);}
    }
    await screenshot(remote.page,'remote-shared-source-action-row');await assertMedia(remote.page);
    assert.equal(remote.requests.blocked,0);assert.equal(remote.requests.mutations.length,0);assert.deepEqual(remote.errors,[]);
  }
  completed.add(t);
});

test('mobile Host fits 360px and 320px Source frames through 640–1000px heights and keeps rows during selection',{timeout:90000},async t=>{
  const {host}=await fixture(t,{android:true,size:60}),{page,requests,errors}=await browser(t,host,{android:true});
  await sources(page,true);
  // Keep threshold checks alongside the minimum supported width and the
  // smaller fallback. Expected counts are independent of the fitting helper.
  for(const [width,height,count] of [[390,844,18],[320,844,12],[390,835,15],[390,845,18],[390,950,21],[390,1024,24]]){
    await page.setViewportSize({width,height});await settleSourceFit(page);
    const layout=await sourceLayout(page,`capacity-${width}x${height}`);
    assert.equal(layout.items,count,`${width}x${height} displays every available complete row`);
    await assertNativeSourceFrame(page);await assertFullSourceCapacity(page);await footerBounds(page);
  }
  await page.locator('#modal-follow-uid-input').fill('123456');
  for(const language of ['zh','en','ja']){
    await page.evaluate(language=>setLanguage(language),language);
    for(const [width,height,count] of [[360,640,6],[360,800,10],[360,1000,14],[320,640,6],[320,800,10],[320,1000,14],[390,844,18],[390,1000,21]]){
      await page.setViewportSize({width,height});await settleSourceFit(page);
      const normal=await sourceLayout(page,`${language}-capacity-${width}x${height}`);
      assert.equal(normal.items,count);
      await assertNativeSourceFrame(page);await assertFullSourceCapacity(page);await footerBounds(page);
      const first=page.locator('#follow-up-grid .source-removal-card').first(),cardBounds=await first.boundingBox();
      if(language==='zh'&&width!==390)await screenshot(page,`host-mobile-${width}x${height}`);
      await holdSource(page,page.locator('#follow-up-grid .follow-up-button').first());
      // A single matching frame can precede another ResizeObserver paint.
      // Observe real frames so a transient match cannot conceal lost rows.
      const frames=await page.evaluate(async()=>{
        const values=[];
        for(let frame=0;frame<12;frame++){
          await new Promise(requestAnimationFrame);
          const editor=sourceRemovalEditors.get('uid');
          values.push({count:editor.grid.children.length,columns:getComputedStyle(editor.grid).gridTemplateColumns.split(' ').length});
        }
        return values;
      });
      assert.ok(frames.every(frame=>frame.count===normal.items&&frame.columns===normal.columns),'selection retains every fitted row across paints');
      const selecting=await sourceLayout(page,`${language}-selection-${width}x${height}`);
      assert.deepEqual(selecting.scroll,normal.scroll,'floating selection tools preserve the body bounds');
      assert.deepEqual(selecting.pager,normal.pager,'selection tools preserve the frame footer');
      const selectedBounds=await first.boundingBox();
      for(const field of ['x','y','width','height'])assert.ok(Math.abs(selectedBounds[field]-cardBounds[field])<=1,`selection retains card ${field} even with a native scrollbar`);
      await assertNoSourceTextSelection(page);await assertNativeSourceFrame(page,{fits:false});await footerBounds(page);
      if(language==='zh'&&height===1000)await screenshot(page,`host-mobile-${width}x${height}-selected`);
      await exitSelection(page.locator('.source-tools[data-source="uid"]'));
      await settleSourceFit(page);await assertNativeSourceFrame(page);
      assert.equal(await page.locator('#modal-follow-uid-input').inputValue(),'123456');
    }
  }
  assert.equal(requests.mutations.length,0);assert.equal(requests.blocked,0);assert.deepEqual(errors,[]);
  await assertMedia(page);completed.add(t);
});

for(const android of [false,true])test(`${android?'touch portrait shared Android surface':'700px desktop Host'} has persistent order, selection across pages, one confirmation and one batch`,{timeout:120000},async t=>{
  const {host,data,ids}=await fixture(t,{android,size:android?30:18}),{page,requests,errors}=await browser(t,host,{android});
  await sources(page,android);
  const grid=page.locator('#follow-up-grid'),footer=page.locator('.source-tools[data-source="uid"]');
  const selectionControl=footer.locator('.source-select-mode');
  await assertNativeSourceFrame(page);
  assert.equal(await grid.locator('.source-order-handle, .source-checkbox:visible, .source-select-target:visible').count(),0);
  assert.equal(await footer.locator('.source-move-button, [data-source-move], .source-help, .cache-advanced-info-button').count(),0);
  const selectionStyle=await page.evaluate(()=>{
    const source=document.querySelector('.source-tools[data-source="uid"] .source-select-mode');
    const users=document.querySelector('.session-user-tools [data-mode="select"]');
    const properties=['width','height','minWidth','maxWidth','minHeight','padding','borderRadius','color'];
    const styles=button=>Object.fromEntries(properties.map(key=>[key,getComputedStyle(button)[key]]));
    return {sourceIcon:source.innerHTML,userIcon:users.innerHTML,source:styles(source),users:styles(users),label:source.getAttribute('aria-label')};
  });
  assert.equal(selectionStyle.sourceIcon,selectionStyle.userIcon,'same selection SVG as session users');
  assert.deepEqual(selectionStyle.source,selectionStyle.users,'same circular button geometry and glyph color; floating surface intentionally differs');
  assert.equal(selectionStyle.source.width,'44px');assert.equal(selectionStyle.source.height,'44px');
  assert.equal(selectionStyle.label,'多选');
  const geometry=await page.evaluate(()=>{
    const grid=document.querySelector('#follow-up-grid'),card=grid.querySelector('.source-removal-card'),button=card.querySelector('.follow-up-button');
    return {minimum:getComputedStyle(grid).getPropertyValue('--source-card-min-inline-size').trim(),
      originalMinimum:getComputedStyle(document.documentElement).getPropertyValue('--source-card-min-inline-size').trim(),
      cardWidth:card.offsetWidth,buttonWidth:button.offsetWidth,cardHeight:card.offsetHeight,buttonHeight:button.offsetHeight,
      children:[...card.children].filter(node=>node.getClientRects().length).length,cursor:getComputedStyle(button).cursor};
  });
  assert.equal(geometry.minimum,geometry.originalMinimum,'source grid uses its original shared minimum width');
  assert.equal(geometry.cardWidth,geometry.buttonWidth,'no extra management column reduces the card');
  assert.equal(geometry.cardHeight,geometry.buttonHeight);
  assert.equal(geometry.children,1,'ordinary card remains the only visible content');
  if(!android)assert.equal(geometry.cursor,'grab');
  await footerBounds(page);await screenshot(page,android?'host-touch-source-list':'host-desktop-source-list');
  await grid.locator('[data-source-id="42"] .follow-up-button').click();
  await page.locator('#follow-up-items-view').waitFor({state:'visible'});assert.equal(await footer.isVisible(),false);
  await page.locator('#follow-browse-back').click();await footer.waitFor({state:android?'hidden':'visible'});
  const handle=grid.locator('[data-source-id="43"] .follow-up-button'), target=grid.locator('[data-source-id="42"]');
  await handle.scrollIntoViewIfNeeded();
  const from=await handle.boundingBox(),to=await target.boundingBox();
  const start=performance.now();
  if(android){
    const mutations=requests.mutations.length,session=await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:from.x+22,y:from.y+22}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+22,y:from.y+12}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await session.detach();
    assert.equal(requests.mutations.length,mutations,'touch card keeps scrolling without an invisible drag target');
    assert.equal(await grid.locator('.is-dragging').count(),0);
    assert.equal(existsSync(path.join(data,'gatcha_source_order.json')),false);
  }
  // The shared touch layout also supports a mouse; visual touch grips remain
  // a separate placement decision. The real mouse now drags the card itself.
  await page.mouse.move(from.x+22,from.y+22);await page.mouse.down();await page.mouse.move(to.x+8,to.y+to.height/2,{steps:8});await page.mouse.up();
  await waitFor(()=>existsSync(path.join(data,'gatcha_source_order.json'))&&read(data,'gatcha_source_order.json').uid[0]==='43','real drag saves full order');
  await waitFor(async()=>!(await handle.isDisabled()),'move guard settled');
  timings.push({name:android?'portrait-mouse-drag-save':'mouse-drag-save',ms:Math.round(performance.now()-start)});
  assert.deepEqual(read(data,'gatcha_uids.json').uids,ids);
  await handle.focus();await page.keyboard.press('Alt+ArrowDown');
  await waitFor(()=>read(data,'gatcha_source_order.json').uid[0]==='42','keyboard alternative saves');
  await waitFor(async()=>!(await handle.isDisabled()),'keyboard move settled');
  await handle.focus();await page.keyboard.press('Alt+ArrowDown');
  await waitFor(()=>read(data,'gatcha_source_order.json').uid[2]==='43','keyboard reorder saves');
  await waitFor(async()=>!(await handle.isDisabled()),'keyboard move settled');
  await assertMedia(page);
  await page.reload();await sources(page,android);
  await page.evaluate(()=>{window.sourceMediaNodes=[...document.querySelectorAll('video,audio')];});
  assert.deepEqual(await grid.locator('.source-removal-card').evaluateAll(nodes=>nodes.slice(0,3).map(n=>n.dataset.sourceId)),['42','44','43']);
  await screenshot(page,android?'host-touch-reordered':'host-desktop-reordered');
  // Escape and invalid drop make no request. A new order received during capture cancels the old drag.
  const drag=grid.locator('.source-removal-card .follow-up-button').first();
  await drag.scrollIntoViewIfNeeded();const box=await drag.boundingBox();
  let calls=requests.mutations.length;
  assert.equal(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x+22,y+22)?.closest('.follow-up-button')),box),true,'drag starts inside the original card');
  await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(box.x+5,box.y+5);assert.equal(await grid.locator('.is-dragging').count(),1);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(requests.mutations.length,calls);
  assert.equal(await page.evaluate(()=>state.followBrowseSelectedUid),'','Escape cancels the card drag without opening the source');
  await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(1,1);await page.mouse.up();assert.equal(requests.mutations.length,calls);
  assert.equal(await page.evaluate(()=>state.followBrowseSelectedUid),'','invalid drop keeps the source list open');
  await page.mouse.move(box.x+22,box.y+22);await page.mouse.down();await page.mouse.move(box.x+5,box.y+5);assert.equal(await grid.locator('.is-dragging').count(),1);
  await edit(host,'uid',{action:'move',id:'44',before_id:'42'});
  await page.waitForFunction(()=>state.followBrowseData.owners[0].uid==='44'&&!state.followBrowseLoading);
  await page.mouse.up();assert.equal(requests.mutations.length,calls,'old captured order cannot overwrite replacement');
  await enterSelection(page,grid,footer,android);await selectPage(grid,footer,android);
  const selectedPageSize=await grid.locator('.source-removal-card').count();
  assert.equal(await footer.locator('.source-select-mode').getAttribute('aria-label'),'完成');
  assert.equal(await footer.locator('.source-select-mode').innerHTML(),selectionStyle.userIcon,'selection mode retains the same icon');
  assert.equal(await grid.locator('.follow-up-button[aria-pressed="true"]').count(),selectedPageSize);
  assert.equal(await grid.locator('.source-order-handle').count(),0);
  assert.equal(await grid.locator('.source-checkbox:checked').count(),selectedPageSize,'native checkbox state follows selection without another column');
  const selected=new Set(await grid.locator('.follow-up-button[aria-pressed="true"]').evaluateAll(nodes=>nodes.map(n=>n.closest('.source-removal-card').dataset.sourceId)));
  await page.locator('#request-sources-uids [data-page-action="next"]').click();
  await page.waitForFunction(()=>document.querySelector('#request-sources-uids .result-pager').dataset.page==='2');
  const offPage=grid.locator('.source-removal-card').first();const offId=await offPage.getAttribute('data-source-id');selected.add(offId);await offPage.locator('.follow-up-button').click();
  const selectedCount=new RegExp(String(selected.size),'u');
  assert.match(await footer.locator('.source-selection-count').textContent(),selectedCount);
  await screenshot(page,android?'host-touch-selection':'host-desktop-selection');
  assert.equal(await page.evaluate(()=>state.followBrowseSelectedUid),'');
  if(!android){
    await page.locator('#remote-mini-trigger').click();
    assert.equal(await page.locator('#remote-mini-trigger').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#remote-mini-trigger').getAttribute('aria-expanded'),'false','higher sharing menu owns Escape');
    assert.equal(await footer.locator('.source-select-mode').getAttribute('aria-pressed'),'true','closing a separate menu retains selection');
    assert.match(await footer.locator('.source-selection-count').textContent(),selectedCount);
  }
  await dragRemoval(page,grid,footer,android);await page.locator('#confirm-popover').waitFor({state:'visible'});
  assert.match(await page.locator('#confirm-text').textContent(),selectedCount);
  await page.waitForFunction(()=>{
    const panel=document.querySelector('#confirm-popover'),box=panel.getBoundingClientRect();
    return getComputedStyle(panel).opacity==='1'&&!panel.classList.contains('closing')
      &&document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('#confirm-popover')===panel;
  });
  await screenshot(page,android?'host-touch-batch-confirm':'host-desktop-batch-confirm');
  assert.equal(await page.evaluate(()=>state.confirmIntent?.type),'remove-sources');
  await page.keyboard.press('Escape');await page.locator('#confirm-popover').waitFor({state:'hidden'});assert.equal(requests.mutations.length,calls);
  assert.equal(await footer.locator('.source-select-mode').getAttribute('aria-pressed'),'true');
  // A rejected attempt preserves selections and the authoritative list.
  let attempts=0;
  await page.route('**/api/gatcha/sources/edit',route=>{attempts++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,code:'library_busy',error:'Fixture busy rejection'})});});
  await dragRemoval(page,grid,footer,android);await page.locator('#confirm-ok').click();
  await waitFor(async()=>!(await selectionControl.isDisabled()),'failed batch controls recover');
  assert.equal(attempts,1);assert.match(await footer.locator('.source-selection-count').textContent(),selectedCount);assert.equal(read(data,'gatcha_uids.json').uids.length,ids.length);
  await page.unroute('**/api/gatcha/sources/edit');
  let release,started=false;
  await page.route('**/api/gatcha/sources/edit',async route=>{attempts++;started=true;await new Promise(resolve=>release=resolve);await route.continue();});
  await dragRemoval(page,grid,footer,android);await page.locator('#confirm-ok').click();
  await waitFor(()=>started,'one native batch held');
  assert.equal(await grid.locator('.source-checkbox:not(:disabled)').count(),0,'pending batch disables every checkbox');
  assert.equal(await footer.locator('.source-remove-selected').getAttribute('aria-busy'),'true');
  await footer.locator('.source-remove-selected').dispatchEvent('click');assert.equal(attempts,2);
  release();await waitFor(()=>read(data,'gatcha_uids.json').uids.length===ids.length-selected.size,'one real batch committed');
  await waitFor(async()=>!(await selectionControl.isDisabled()),'committed batch controls recover');
  await page.unroute('**/api/gatcha/sources/edit');
  assert.deepEqual(new Set(read(data,'gatcha_uids.json').uids),new Set(ids.filter(id=>!selected.has(id))));
  assert.match(await footer.locator('.source-selection-count').textContent(),/0/u);
  assert.equal(await grid.getAttribute('inert'),null,'grid releases pending guard');
  await settleSourceCompletion(page,host);
  await exitSelection(footer,android);
  await page.locator('[data-sources-mode="favorites"]').click();
  await page.locator('#favlist-grid .source-removal-card').first().waitFor({state:'visible'});
  const favorites=page.locator('.source-tools[data-source="favlist"]');
  await enterSelection(page,page.locator('#favlist-grid'),favorites,android);await selectPage(page.locator('#favlist-grid'),favorites,android);
  await dragRemoval(page,page.locator('#favlist-grid'),favorites,android);await page.locator('#confirm-cancel').click();
  assert.equal(read(data,'gatcha_favlist.json').folders.length,3);
  await page.locator('#favlist-grid [data-source-id="43:10"] .follow-up-button').click();
  const folderRequests=requests.mutations.length;
  await dragRemoval(page,page.locator('#favlist-grid'),favorites,android);await page.locator('#confirm-ok').click();
  await waitFor(async()=>!(await favorites.locator('.source-select-mode').isDisabled()),'folder batch controls recover');
  assert.equal(requests.mutations.length,folderRequests+1,'folders also submit one bounded batch');
  assert.equal(requests.mutations.at(-1).source,'favlist');
  assert.deepEqual(new Set(requests.mutations.at(-1).edit.ids),new Set(['42:10','42:11']));
  assert.deepEqual(read(data,'gatcha_favlist.json').folders.map(row=>row.uid+':'+row.id),['43:10']);
  assert.deepEqual(read(data,'gatcha_favlist.json').items.map(row=>row.fav_uid+':'+row.fav_folder_id),['43:10'],'same BV in another owner folder survives');
  await settleSourceCompletion(page,host);
  await page.locator('[data-sources-mode="uids"]').click();await footer.waitFor({state:android?'hidden':'visible'});
  assert.equal(await footer.locator('.source-select-mode').getAttribute('aria-pressed'),'false');
  const settledRequests=requests.mutations.length;
  if(android)await page.setViewportSize({width:320,height:844});
  for(const language of ['en','ja','zh']){
    // Invoke the production language action; selection/confirmation still use
    // real controls. No DOM, labels or geometry are fabricated.
    await page.evaluate(language=>setLanguage(language),language);
    await settleSourceFit(page);
    await enterSelection(page,grid,footer,android);await selectPage(grid,footer,android);
    await dragRemoval(page,grid,footer,android);
    const dialog=await page.locator('#confirm-popover').boundingBox(), viewport=page.viewportSize();
    assert.ok(dialog.x>=0&&dialog.x+dialog.width<=viewport.width+1);
    for(const selector of ['#confirm-cancel','#confirm-ok']){
      const button=await page.locator(selector).boundingBox();
      assert.ok(button.x>=dialog.x&&button.x+button.width<=dialog.x+dialog.width+1,'localized actions stay inside confirmation');
    }
    await page.locator('#confirm-cancel').click();await exitSelection(footer,android);
    await footerBounds(page);
  }
  assert.equal(requests.mutations.length,settledRequests,'localized canceled confirmations send no mutation');
  await footerBounds(page);await assertMedia(page);assert.deepEqual(errors,[]);assert.equal(requests.blocked,0);
  if(process.env.BILIKARA_TEST_SCREENSHOT_DIR)writeFileSync(path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR,android?'touch-receipt.json':'desktop-receipt.json'),JSON.stringify({scope:android?'Linux native shared Host + real Chromium touch emulation; no Android device':'Linux native Host + real 700px Chromium',requests,reorderedIds:['42','44','43'],selected:[...selected],remaining:read(data,'gatcha_uids.json').uids,errors},null,2));
  completed.add(t);
});

test('LAN Remote browses saved order without editor assets or hold/drag/keyboard editing; legacy API invalidates an open detail', {timeout:90000},async t=>{
  const {host,data}=await fixture(t,{size:3});await edit(host,'uid',{action:'move',id:'44',before_id:'42'});
  const {page,requests,errors}=await browser(t,host,{remote:true});await sources(page,false,true);
  const grid=page.locator('#sources-follow-grid');
  assert.equal(await page.evaluate(()=>typeof window.BilikaraSourceRemoval),'undefined');
  assert.equal(await page.locator('.source-tools, .source-removal-card, .source-order-handle, .source-checkbox, .source-removal-delete, .source-removal-toggle').count(),0);
  assert.equal(await page.locator('[src*="source-removal"], [href*="source-removal"]').count(),0);
  assert.deepEqual(await grid.locator('.follow-up-button').evaluateAll(nodes=>nodes.map(n=>n.dataset.uid)),['44','42','43']);
  const card=grid.locator('[data-uid="42"]');await remoteBrowseGestures(page,card);
  assert.equal(requests.mutations.length,0);assert.equal(await page.locator('.source-tools').count(),0);
  assert.deepEqual(read(data,'gatcha_uids.json').uids,['42','43','44']);
  assert.deepEqual(read(data,'gatcha_source_order.json').uid,['44','42','43']);
  await screenshot(page,'remote-lan-sources');
  await card.click();await page.locator('#sources-follow-items-view').waitFor({state:'visible'});
  const before=read(data,'gatcha_favlist.json');
  // Deliberately invoke the retained authorized API from this Remote identity.
  const result=await page.evaluate(async()=>await apiPost('/api/gatcha/source/remove',{source:'uid',id:'42'}));assert.equal(result.removed,true);
  await page.waitForFunction(()=>!state.followBrowseSelectedUid&&!state.followBrowseLoading);
  assert.equal(await grid.locator('[data-uid="42"]').count(),0);
  assert.deepEqual(read(data,'gatcha_favlist.json'),before);
  assert.equal(await page.locator('#sources-follow-uid-input').isEnabled(),true);
  await page.locator('[data-remote-sources-mode="favorites"]').click();
  await page.locator('#favlist-grid .follow-up-button').first().waitFor({state:'visible'});
  assert.equal(await page.locator('#favlist-grid .follow-up-button').count(),3);
  assert.equal(await page.locator('#sources-favlist-uid-input').isEnabled(),true);
  await assertMedia(page);assert.deepEqual(errors,[]);assert.equal(requests.blocked,0);
  completed.add(t);
});

// Reuse the relay matrix's narrow signaling contract fixture, with no relay
// dependency. HTTP is local native routing and local static assets only.
async function publicService(t,host) {
  const sockets=new Set(),proxies=new Set(),counters={http:0,websocketConnections:0,signals:0,iceConfigs:0};let base;
  const service=http.createServer(async(request,response)=>{
    counters.http++;const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname==='/v1/rooms'&&request.method==='POST'){for await(const _ of request){}response.setHeader('content-type','application/json');return response.end(JSON.stringify({room_id:'R'.repeat(27),created_at:Date.now(),expires_at:Date.now()+3600000}));}
    if(pathname.startsWith('/v1/rooms/')&&request.method==='DELETE'){response.writeHead(204);return response.end();}
    const name=pathname.startsWith('/static/')?pathname.slice(8):pathname.slice(1);
    if(/^[a-z0-9_.-]+\.(?:js|css|html|json|ico)$/iu.test(name)&&existsSync(path.join(root,'static',name))){
      let bytes=readFileSync(path.join(root,'static',name));
      if(name==='internet-remote-host.js')bytes=Buffer.from(bytes.toString('utf8').replaceAll('https://rtc.kevinx96.icu',base));
      if(name==='internet-remote-transport.js'){
        const direct='iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }]';
        assert.ok(bytes.toString('utf8').includes(direct),'fixture must explicitly replace all public ICE servers');
        bytes=Buffer.from(bytes.toString('utf8').replace(direct,'iceServers: []'));
      }
      response.setHeader('content-type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream');return response.end(bytes);
    }
    const headers={...request.headers,host:new URL(host.base).host,origin:host.base};
    const proxy=http.request(new URL(request.url,host.base),{method:request.method,headers},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);});
    proxies.add(proxy);response.on('close',()=>{proxy.destroy();proxies.delete(proxy);});
    proxy.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();proxies.delete(proxy);});request.pipe(proxy);
  });
  service.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${service.address().port}`;
  const signaling=localSignaling(service,{counters});
  cleanup(t,async()=>{
    for(const proxy of proxies)proxy.destroy();
    if(process.env.BILIKARA_SOURCE_TEST_DEBUG)console.log('Public fixture closing signaling',signaling.lanes.size);
    await signaling.close();
    if(process.env.BILIKARA_SOURCE_TEST_DEBUG)console.log('Public fixture closing HTTP',sockets.size,proxies.size);
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>service.close(resolve));
  });
  return {base,counters,lanes:signaling.lanes};
}

test('public-mode Remote uses real native WebRTC lanes, saved browse order and legacy removal, with no hidden editor', {timeout:90000},async t=>{
  const {host,data}=await fixture(t,{size:3});await edit(host,'uid',{action:'move',id:'43',before_id:'42'});
  const service=await publicService(t,host),{page:hostPage,context,requests,errors}=await browser(t,host,{origin:service.base});
  await hostPage.locator('#remote-mini-trigger').click();
  if(await hostPage.locator('#internet-remote-disclosure').getAttribute('aria-expanded')!=='true')await hostPage.locator('#internet-remote-disclosure').click();await hostPage.locator('#internet-remote-password').fill('fixture-password');await hostPage.locator('#internet-remote-restart').click();
  const remote=await context.newPage();remote.on('pageerror',error=>errors.push(error.message));
  await remote.setViewportSize({width:390,height:844});
  await remote.goto(`${service.base}/remote.html#room=${'R'.repeat(27)}&join=${'J'.repeat(43)}&expires=${Date.now()+3600000}`);
  await remote.locator('#internet-join-identity').fill('Public source test');await remote.locator('#internet-join-password').fill('fixture-password');
  const start=performance.now();await remote.locator('.internet-remote-join-card button[type="submit"]').click();
  await waitFor(()=>service.counters.websocketConnections===2,'local public pair did not register',8000);
  await waitFor(()=>service.counters.signals>=2,'local offer/answer did not reach signaling',15000);
  console.log('Local signaling registration and negotiation',service.counters);
  try {
    await remote.waitForFunction(()=>BilikaraRemoteTransport.mode==='internet'&&state.data&&document.querySelector('.internet-remote-join-overlay')?.classList.contains('hidden'),null,{timeout:15000});
  } catch(error) {
    const diagnostics=await Promise.race([remote.evaluate(()=>({ui:document.querySelector('#remote-connection-status')?.textContent,transport:BilikaraInternetRemoteDiagnostics.getSnapshot()})),new Promise(resolve=>setTimeout(()=>resolve('browser evaluation unavailable'),1000))]);
    console.error('Local public fixture failed',JSON.stringify({diagnostics,counters:service.counters,requests,errors}));throw error;
  }
  timings.push({name:'public-direct-join',ms:Math.round(performance.now()-start)});
  await remote.evaluate(()=>{window.sourceMediaNodes=[...document.querySelectorAll('video,audio')];});
  await sources(remote,false,true);const grid=remote.locator('#sources-follow-grid');
  assert.deepEqual(await grid.locator('.follow-up-button').evaluateAll(nodes=>nodes.map(n=>n.dataset.uid)),['43','42','44']);
  assert.equal(await remote.evaluate(()=>typeof BilikaraSourceRemoval),'undefined');
  assert.equal(await remote.locator('.source-tools, .source-removal-card, .source-order-handle, .source-checkbox').count(),0);
  await remoteBrowseGestures(remote,grid.locator('[data-uid="42"]'));
  assert.deepEqual(read(data,'gatcha_source_order.json').uid,['43','42','44']);
  await remote.locator('#app-toast').waitFor({state:'hidden'});
  await screenshot(remote,'remote-public-local-webrtc-sources');
  await grid.locator('[data-uid="42"]').click();await remote.locator('#sources-follow-items-view').waitFor({state:'visible'});
  await edit(host,'uid',{action:'move',id:'44',before_id:'43'});
  await host.api('/api/gatcha/source/remove',{source:'uid',id:'42'});
  await remote.waitForFunction(()=>!state.followBrowseSelectedUid&&!state.followBrowseLoading&&state.followBrowseData.owners[0].uid==='44');
  // The public reply intentionally projects fields; verify the committed
  // native data rather than requiring a private HTTP result field.
  await remote.evaluate(async()=>await apiPost('/api/gatcha/source/remove',{source:'favlist',id:'42:10'}));
  assert.deepEqual(read(data,'gatcha_favlist.json').items.map(v=>v.fav_uid+':'+v.fav_folder_id),['42:11','43:10']);
  assert.equal(await remote.locator('#sources-follow-uid-input').isEnabled(),true);
  await assertMedia(remote);assert.deepEqual(errors,[]);assert.equal(requests.blocked,0);assert.equal(requests.mutations.length,0);
  const diagnostic=await remote.evaluate(()=>BilikaraInternetRemoteDiagnostics.getSnapshot());
  assert.ok(diagnostic.stages.some(row=>row.stage==='ready'));assert.equal(diagnostic.control_state,'open');assert.equal(diagnostic.bulk_state,'open');
  await remote.evaluate(()=>BilikaraRemoteTransport.disconnect());
  if(await hostPage.locator('#remote-mini-trigger').getAttribute('aria-expanded')!=='true')await hostPage.locator('#remote-mini-trigger').click();
  if(await hostPage.locator('#internet-remote-disclosure').getAttribute('aria-expanded')!=='true')await hostPage.locator('#internet-remote-disclosure').click();
  await hostPage.locator('#internet-remote-stop').click();
  await waitFor(()=>service.lanes.size===0,'owned room signaling did not retire after close',5000);
  if(process.env.BILIKARA_TEST_SCREENSHOT_DIR)writeFileSync(path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR,'public-remote-receipt.json'),JSON.stringify({scope:'Real Chromium WebRTC + actual Rust Host; shared local signaling contract fixture, no deployed Worker',counters:service.counters,requests,diagnostic,errors},null,2));
  completed.add(t);
});

test.after(()=>{
  if(process.env.BILIKARA_TEST_SCREENSHOT_DIR){
    writeFileSync(path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR,'timing-screenshots.json'),JSON.stringify({timings,screenshots:snapshots},null,2));
    writeFileSync(path.join(process.env.BILIKARA_TEST_SCREENSHOT_DIR,'source-ui-geometry.json'),JSON.stringify(sourceLayouts,null,2));
  }
});
