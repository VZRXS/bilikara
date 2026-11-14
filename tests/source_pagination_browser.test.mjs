import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test,{before} from 'node:test';
import {chromium,webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment,waitFor} from './native_host_support.mjs';

let binary;
before(async()=>{if(process.platform==='linux')binary=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha();},{timeout:300000});
const posts=Array.from({length:612},(_,i)=>({bvid:'BV'+String(i+1).padStart(10,'0'),title:`Post ${i+1}`,
  owner_name:'Fixture UP',source_url:'https://www.bilibili.com/video/BV'+String(i+1).padStart(10,'0')}));

async function settlePager(page) {
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity)
      .map(animation=>animation.finished.catch(()=>{})));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  });
}

async function pagerTargets(pager) {
  const value=await pager.evaluate(node=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const owns=(button,x,y)=>button.contains(document.elementFromPoint(x,y));
    const arrows=[...node.querySelectorAll('[data-page-action]')].filter(button=>button.getClientRects().length).map(button=>{
      const box=rect(button),x=(box.left+box.right)/2,y=(box.top+box.bottom)/2;
      // Probe both complete center axes, including the expanded target edges.
      // Rounded corners are deliberately not treated as rectangular ink.
      const horizontal=Array.from({length:Math.ceil(box.width)},(_,i)=>owns(button,box.left+i+.25,y));
      const vertical=Array.from({length:Math.ceil(box.height)},(_,i)=>owns(button,x,box.top+i+.25));
      return {action:button.dataset.pageAction,...box,hitWidth:horizontal.every(Boolean)?box.width:0,
        hitHeight:vertical.every(Boolean)?box.height:0};
    });
    const controls=rect(node.querySelector('.result-pager-controls')),input=node.querySelector('[data-page-input]');
    const frame=node.closest('.android-result-frame,.source-mode-panel')||node.parentElement;
    const contentViewports=[...frame.querySelectorAll('.result-page-viewport')].filter(viewport=>viewport.getClientRects().length).map(rect);
    const style=getComputedStyle(node);
    return {slot:rect(node),controls,arrows,input:rect(input),inputTarget:rect(input.parentElement),
      contentViewports,padding:[style.paddingTop,style.paddingBottom],viewport:innerWidth};
  });
  assert.equal(value.slot.height,52,JSON.stringify(value));
  assert.deepEqual(value.padding,['4px','4px']);
  assert.deepEqual(value.arrows.map(arrow=>arrow.action),value.viewport<375?['previous','next']:['first','previous','next','last']);
  assert.equal(value.input.height,32);assert.equal(value.inputTarget.height,44);
  assert.equal(value.contentViewports.length,1,'a visible pager has one active result viewport');
  assert.ok(value.controls.left>=value.slot.left-.5&&value.controls.right<=value.slot.right+.5,'all page controls fit inside the slot');
  for(const arrow of value.arrows){
    assert.ok(arrow.width>=44&&arrow.height>=44,JSON.stringify(arrow));
    assert.ok(arrow.hitWidth>=44&&arrow.hitHeight>=44,'each arrow has its own complete hit target: '+JSON.stringify(arrow));
    for(const viewport of value.contentViewports){
      const overlapWidth=Math.min(arrow.right,viewport.right)-Math.max(arrow.left,viewport.left);
      const overlapHeight=Math.min(arrow.bottom,viewport.bottom)-Math.max(arrow.top,viewport.top);
      assert.ok(overlapWidth<=.01||overlapHeight<=.01,'expanded arrow targets cannot intrude into the result viewport swipe region: '+JSON.stringify({arrow,viewport}));
    }
    for(const other of [...value.arrows.filter(other=>other!==arrow),value.inputTarget]){
      const overlap=Math.min(arrow.right,other.right)-Math.max(arrow.left,other.left);
      assert.ok(overlap<=.01,'arrow targets cannot overlap adjacent controls: '+JSON.stringify({arrow,other}));
    }
  }
  return value;
}

async function dragPageTarget(target, distance=-84) {
  return target.evaluate((node,distance)=>{
    const box=node.getBoundingClientRect(),x=box.left+box.width*.8,y=box.top+box.height/2;
    const emit=(type,dx)=>{
      const points=[{identifier:1,target:node,clientX:x+dx,clientY:y+2}];
      const event=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperties(event,{touches:{value:type==='touchend'?[]:points},changedTouches:{value:points}});
      node.dispatchEvent(event);return event.defaultPrevented;
    };
    emit('touchstart',0);emit('touchmove',Math.sign(distance)*16);
    const owned=emit('touchmove',distance);emit('touchend',distance);return owned;
  },distance);
}

for(const engine of [chromium,webkit])for(const client of ['android','ios','remote'])test(
  `${engine.name()} ${client} request pages share pager slots and Host bottom anchors [B2-G1-G2-G3]`,
  {skip:process.platform!=='linux',timeout:120000},async t=>{
    const {page}=await open(t,client,engine),remote=client==='remote';
    const owners=Array.from({length:60},(_,i)=>({uid:String(i+42),name:`Fixture UP ${i+1}`,count:posts.length}));
    const folders=owners.map(owner=>({...owner,id:`${owner.uid}:7`,folder_id:'7',title:`Fixture favorites ${owner.uid}`}));
    const tags=owners.map((owner,i)=>({tag:`A tag ${i+1}`,count:posts.length}));
    await page.context().route(/\/api\/(?:catalog\/search|gatcha\/search|d1\/(?:category-browse|browse)|gatcha\/(?:favlist\/)?browse)(?:\?|$)/,route=>{
      const url=new URL(route.request().url()),params=url.searchParams;
      const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||100);
      const source=url.pathname.endsWith('/browse')&&url.pathname.includes('/gatcha/');
      const selected=params.get(url.pathname.includes('/favlist/')?'folder_id':'uid')||'';
      const tagList=url.pathname==='/api/d1/browse'&&!params.get('tag');
      const items=tagList||source&&!selected?[]:posts.slice(offset,offset+limit);
      return route.fulfill({json:{ok:true,data:{owners,folders,tags,items,query:params.get('q')||'',
        kind:params.get('kind'),letter:params.get('letter'),tag:params.get('tag'),selected_uid:selected,selected_folder_id:selected,
        matched_count:posts.length,offset,next_offset:offset+items.length,has_more:Boolean(items.length&&offset+items.length<posts.length),
        source_order_version:'a'.repeat(64),source_order_editable:true,source_order_count:owners.length}}});
    });
    await page.evaluate(()=>{fetchState=async()=>{};state.eventSource?.close();});
    if(!remote)await page.locator('[data-android-page="request"]').click();
    const request=async view=>{
      if(!remote){const back=page.locator('[data-request-back]:visible');if(await back.count())await back.click();}
      await page.locator(`[${remote?'data-remote-request-view':'data-request-view'}="${view}"]`).click();
    };
    const capture=async scenario=>{
      const pager=page.locator('.result-pager:visible');await pager.waitFor({state:'visible'});
      await page.waitForFunction(()=>[...document.querySelectorAll('.result-pager')].filter(node=>node.getClientRects().length)
        .every(node=>node.getAttribute('aria-busy')==='false'));
      await settlePager(page);
      if(remote){await pager.evaluate(node=>node.scrollIntoView({block:'center'}));await settlePager(page);}
      const geometry=await pagerTargets(pager);
      const dockTop=await page.evaluate(()=>{
        const dock=document.getElementById('android-host-dock');
        return dock?.getClientRects().length?dock.getBoundingClientRect().top:innerHeight;
      });
      return {scenario,bottom:geometry.slot.bottom,dockGap:dockTop-geometry.slot.bottom};
    };
    for(const [width,height] of remote?[[320,844],[393,844]]:[[393,844],[1024,768]]){
      await page.setViewportSize({width,height});const samples=[];
      await request('search');
      for(const mode of ['shared','local']){
        await page.locator(`[${remote?'data-remote-search-mode':'data-search-mode'}="${mode}"]`).click();
        const input=page.locator(mode==='shared'?'#shared-search-query':'#search-query');
        await input.fill('fixture');await input.press('Enter');samples.push(await capture(`search-${mode}`));
      }
      await request('discover');
      await page.locator(`[${remote?'data-remote-discover-mode':'data-discover-mode'}="categories"]`).click();
      // The prior size may have left a category detail selected.
      const categoryBack=page.locator('[data-category-browse-back]:visible');if(await categoryBack.count())await categoryBack.click();
      samples.push(await capture('categories-home'));
      await page.locator('[data-category-id]:visible').first().click();samples.push(await capture('categories-results'));
      for(const kind of ['name','artist']){
        await page.locator(`[${remote?'data-remote-discover-mode':'data-discover-mode'}="${kind}"]`).click();
        // Restore alphabet navigation when repeating at another size.
        const back=page.locator('[data-d1-browse-back]:visible');
        for(let i=0;i<2&&await back.count();i++)await back.click();
        await page.locator('[data-letter="A"]:visible').click();samples.push(await capture(`${kind}-tags`));
        await page.locator('[data-d1-browse-tags]:visible .tag-browser-tag').first().click();samples.push(await capture(`${kind}-results`));
      }
      await request('sources');
      for(const mode of ['uids','favorites']){
        await page.locator(`[${remote?'data-remote-sources-mode':'data-sources-mode'}="${mode}"]`).click();
        const sourceBack=page.locator(mode==='favorites'?'#favlist-browse-back':remote?'#sources-follow-back':'#follow-browse-back');
        if(await sourceBack.isVisible())await sourceBack.click();
        samples.push(await capture(`sources-${mode}`));
        const grid=page.locator(mode==='favorites'?'#favlist-grid':remote?'#sources-follow-grid':'#follow-up-grid');
        const pager=page.locator('.result-pager:visible');
        const expectPage=async value=>{await waitFor(async()=>await pager.getAttribute('data-page')===String(value),`source page ${value}`);await settlePager(page);};
        const route=()=>page.evaluate(remote=>remote?`${state.remoteRequestView}.${state.remoteSourcesMode}`:BilikaraHostSubTabs.current(),remote);
        const owner=await route();
        // Click near the new 44px target's edge, outside its centered 20px icon.
        await pager.locator('[data-page-action="next"]').click({position:{x:2,y:22}});await expectPage(2);
        await pager.locator('[data-page-action="previous"]').click({position:{x:2,y:22}});await expectPage(1);
        assert.equal(await route(),owner,'expanded arrow clicks do not activate another tab');
        for(const target of [pager,pager.locator('[data-page-action="next"]')])for(const distance of [-84,84]){
          assert.equal(await dragPageTarget(target,distance),false,'footer drags do not acquire viewport paging');
          await settlePager(page);assert.equal(await pager.getAttribute('data-page'),'1','footer drags never turn a page');
          assert.equal(await route(),owner,'footer drags never switch a sub-tab');
        }
        // Exercise real pointer input too: releasing a drag outside an arrow
        // must not synthesize its ordinary short-press click.
        const next=await pager.locator('[data-page-action="next"]').boundingBox();
        for(const distance of [-84,84]){
          const x=next.x+next.width/2,y=next.y+next.height/2;
          await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+distance,y,{steps:6});await page.mouse.up();
          await settlePager(page);assert.equal(await pager.getAttribute('data-page'),'1','real footer pointer drags do not turn a page');
          assert.equal(await route(),owner,'real footer pointer drags do not switch a sub-tab');
        }
        assert.equal(await dragPageTarget(grid.locator('.follow-up-button').first()),true,'a short horizontal card drag belongs to the pager');
        await expectPage(2);assert.equal(await route(),owner,'the pager never transfers a content drag to a parent tab');
        assert.equal(await sourceBack.isVisible(),false,'dragging a browse button cannot also open its detail');
        await pager.locator('[data-page-action="previous"]').click();await expectPage(1);
        if(!remote){
          const tools=pager.locator('..').locator('.source-tools');await tools.locator('.source-select-mode').click();
          assert.equal(await dragPageTarget(grid.locator('.source-select-target').first()),false,'ignoreSwipe preserves the selection target owner');
          await settlePager(page);assert.equal(await pager.getAttribute('data-page'),'1');assert.equal(await route(),owner);
          await tools.locator('.source-select-mode').click();
        }
        await grid.locator('.follow-up-button').first().click();samples.push(await capture(`${mode}-detail`));
        await sourceBack.click();
      }
      if(!remote)for(const sample of samples){
        assert.ok(Math.abs(sample.bottom-samples[0].bottom)<=1,'every Host pager uses the same bottom anchor: '+JSON.stringify({width,height,client,samples}));
        assert.ok(Math.abs(sample.dockGap-samples[0].dockGap)<=1,'every Host pager keeps the same dock clearance: '+JSON.stringify({width,height,client,samples}));
      }
      if(width===320){
        const pager=page.locator('.result-pager:visible'),input=pager.locator('[data-page-input]');
        const expectPage=async value=>{await waitFor(async()=>await pager.getAttribute('data-page')===String(value),`compact page ${value}`);await settlePager(page);};
        await input.fill('3');await pager.locator('[data-page-go]').click();await expectPage(3);
        await pager.locator('[data-page-action="next"]').click();await expectPage(4);
        await pager.locator('[data-page-action="previous"]').click();await expectPage(3);
        const last=Math.ceil(owners.length/Number(await pager.getAttribute('data-page-size')));
        await pager.focus();await page.keyboard.press('End');await expectPage(last);
        await pager.focus();await page.keyboard.press('Home');await expectPage(1);
        await pagerTargets(pager);
      }
    }
  });

for(const engine of [chromium,webkit])for(const client of ['ios','remote'])test(
  `${engine.name()} ${client} cached result images survive turns and uncached pages commit after decode [IOS-09-11]`,
  {skip:process.platform!=='linux',timeout:90000},async t=>{
    const {page,host}=await open(t,client,engine),requests=[],pendingApi=[],pendingImages=[];
    let hold=false,holdOffset=null;
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#587ba0"/></svg>';
    page.on('request',request=>{const url=new URL(request.url());if(url.origin===host.base&&['/api/gatcha/browse','/test-covers/'].some(prefix=>url.pathname.startsWith(prefix)))requests.push(url.pathname+url.search);});
    await page.context().route('**/test-covers/**',route=>{
      const send=()=>route.fulfill({body:svg,contentType:'image/svg+xml'});
      if(hold)return new Promise(resolve=>pendingImages.push(async()=>{await send().catch(()=>{});resolve();}));
      return send();
    });
    const rows=posts.map((post,index)=>({...post,cover_url:`/test-covers/${index}.svg`,pic:`/test-covers/${index}.svg`}));
    await page.context().route('**/api/gatcha/browse*',route=>{
      const url=new URL(route.request().url()),selected=url.searchParams.get('uid')||'',offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100);
      const send=()=>route.fulfill({json:{ok:true,data:{owners:[{uid:'42',name:'Fixture UP',count:rows.length}],selected_uid:selected,query:'',items:selected?rows.slice(offset,offset+limit):[],matched_count:selected?rows.length:0,offset,next_offset:offset+limit,has_more:Boolean(selected&&offset+limit<rows.length)}}});
      if(hold&&selected&&offset===holdOffset)return new Promise(resolve=>pendingApi.push(async()=>{await send();resolve();}));
      return send();
    });
    const remote=client==='remote';
    if(!remote)await page.locator('[data-android-page="request"]').click();
    await page.locator(`[${remote?'data-remote-request-view':'data-request-view'}="sources"]`).click();
    await page.locator(remote?'#sources-follow-grid [data-uid="42"]':'#follow-up-grid [data-uid="42"]').click();
    const results=page.locator(remote?'#sources-follow-results':'#follow-song-results');
    const frame=results.locator('..').locator('..'),pager=frame.locator('.result-pager').last();
    const ready=()=>page.waitForFunction(selector=>{
      const node=document.querySelector(selector);return node?.children.length&&!node.inert&&[...node.querySelectorAll('img')].every(image=>image.complete&&image.naturalWidth>0);
    },remote?'#sources-follow-results':'#follow-song-results');
    await ready();
    await results.evaluate(n=>{
      window.firstPaintRows=[...n.children];window.firstPaintImages=[...n.querySelectorAll('img')];
      window.paintFrames={empty:0,dim:0,samples:0};
      const sample=()=>{if(n.getClientRects().length){paintFrames.samples++;if(!n.children.length)paintFrames.empty++;if(parseFloat(getComputedStyle(n).opacity)<.99)paintFrames.dim++;}window.paintSampler=requestAnimationFrame(sample);};sample();
    });
    const turn=async action=>{await pager.locator(`[data-page-action="${action}"]`).click();await ready();};
    const initialApi=requests.filter(url=>url.startsWith('/api/')).length;
    await turn('next');const imageCount=requests.filter(url=>url.startsWith('/test-covers/')).length;
    await turn('previous');
    assert.equal(await results.evaluate(n=>[...n.children].every((node,index)=>node===firstPaintRows[index])&&[...n.querySelectorAll('img')].every((image,index)=>image===firstPaintImages[index])),true);
    assert.equal(requests.filter(url=>url.startsWith('/test-covers/')).length,imageCount,'a reverse cache hit reuses the image nodes');
    assert.equal(requests.filter(url=>url.startsWith('/api/')).length,initialApi,'cached turns do not repeat a business read');
    hold=true;holdOffset=39*Number(await pager.getAttribute('data-page-size'));
    const editor=pager.locator('input[data-page-input]');await editor.fill('40');await editor.press('Enter');
    await waitFor(()=>pendingApi.length,'held real HTTP browse read');
    assert.equal(await results.evaluate(n=>n.firstElementChild===firstPaintRows[0]),true,'old page stays readable during the read');
    await pendingApi.shift()();await waitFor(()=>pendingImages.length,'target image decode requests');
    assert.equal(await results.evaluate(n=>n.firstElementChild===firstPaintRows[0]),true,'old page stays readable during image preparation');
    assert.equal(await pager.getAttribute('data-page'),'1','page metadata commits atomically with the prepared cards');
    assert.equal(await results.evaluate(n=>n.inert),true,'pending page controls retain their asynchronous guard');
    hold=false;for(const send of pendingImages.splice(0))await send();await ready();
    assert.equal(await pager.getAttribute('data-page'),'40');
    await page.emulateMedia({reducedMotion:'reduce'});await turn('previous');await turn('next');
    const stats=await results.evaluate(n=>{
      const pager=typeof remoteResultPagers==='undefined'?androidBrowsePages.get(n).pager:remoteResultPagers.get(n);
      cancelAnimationFrame(paintSampler);return{resources:pager.resources(),frames:paintFrames,animations:n.getAnimations().filter(a=>a.playState==='running').length};
    });
    assert.ok(stats.resources.pages<=3);assert.equal(stats.resources.preparing,false);
    assert.equal(stats.frames.empty,0);assert.equal(stats.frames.dim,0);assert.equal(stats.animations,0);
    // Returning to the source list retires image work as well as provider reads.
    hold=true;holdOffset=69*Number(await pager.getAttribute('data-page-size'));await editor.fill('70');await editor.press('Enter');
    await waitFor(()=>pendingApi.length,'second held provider read');await pendingApi.shift()();
    await waitFor(()=>pendingImages.length,'late page image preparation');
    await page.locator(remote?'#sources-follow-back':'#follow-browse-back').click();
    await page.locator(remote?'#sources-follow-grid [data-uid="42"]':'#follow-up-grid [data-uid="42"]').waitFor({state:'visible'});
    hold=false;for(const send of pendingImages.splice(0))await send();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await results.isVisible(),false,'late image completion cannot overwrite the returned source list');
    const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`paint-${engine.name()}-${client}.json`),JSON.stringify({stats,requests,fixture:'Actual Rust Host and shipped app/pager; controlled provider HTTP and image responses, not physical WebKit compositor acceptance'},null,2),'utf8');await page.screenshot({path:path.join(evidence,`paint-${engine.name()}-${client}.png`)});}
  });

for(const engine of [chromium,webkit])test(`${engine.name()} iOS source pages and browse rows fit without replacing unchanged avatars`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {page}=await open(t,'ios',engine);
  const owners=Array.from({length:60},(_,i)=>({uid:String(42+i),name:`测试 UP ${i+1}`,count:i+1,avatar_url:'/pic/icon.png'}));
  const folders=owners.map(v=>({...v,id:`${v.uid}:7`,folder_id:'7',title:`收藏夹 ${v.uid}`}));
  await page.context().route(/\/api\/gatcha\/(?:favlist\/)?browse(?:\?|$)/,route=>route.fulfill({json:{ok:true,data:{owners,folders,items:[],query:'',source_order_version:'a'.repeat(64),source_order_editable:true,source_order_count:60,has_more:false}}}));
  await page.evaluate(()=>{fetchState=async()=>{};state.eventSource?.close();});
  await page.locator('[data-android-page="request"]').click();await page.locator('[data-request-view="sources"]').click();
  for(const mode of ['uids','favorites']){
    await page.locator(`[data-sources-mode="${mode}"]`).click();
    const panel=page.locator(mode==='uids'?'#request-sources-uids':'#request-sources-favorites');
    const pager=panel.locator('.source-frame-footer .host-result-pager');
    await pager.waitFor({state:'visible'});
    const tools=panel.locator('.source-tools');
    const protectedStyles=await tools.evaluate(n=>[n,...n.querySelectorAll('*')].map(v=>({select:getComputedStyle(v).userSelect,tap:getComputedStyle(v).getPropertyValue('-webkit-tap-highlight-color'),callout:getComputedStyle(v).getPropertyValue('-webkit-touch-callout'),supported:CSS.supports('-webkit-touch-callout','none')})));
    for(const style of protectedStyles){assert.equal(style.select,'none');assert.equal(style.tap,'rgba(0, 0, 0, 0)');if(style.supported)assert.equal(style.callout,'none');}
    const slot=await tools.locator('.source-trash-slot').boundingBox();
    await page.mouse.move(slot.x+slot.width/2,slot.y+slot.height/2);await page.mouse.down();await page.waitForTimeout(750);await page.mouse.up();
    assert.equal(await page.evaluate(()=>getSelection().isCollapsed),true,'holding tool chrome must not select page text');
    assert.notEqual(await pager.locator('input').evaluate(n=>getComputedStyle(n).userSelect),'none');
    await page.waitForFunction(selector=>document.querySelector(selector+' .source-removal-card'),mode==='uids'?'#request-sources-uids':'#request-sources-favorites');
    const first=await panel.locator('.source-removal-card').first().getAttribute('data-source-id');
    await pager.locator('[data-page-action="next"]').click();
    await page.waitForFunction(({mode,first})=>document.querySelector((mode==='uids'?'#request-sources-uids':'#request-sources-favorites')+' .source-removal-card')?.dataset.sourceId!==first,{mode,first});
    assert.equal(await panel.locator('.source-browse-scroll').evaluate(n=>n.scrollHeight<=n.clientHeight+2),true);
    assert.equal(await panel.evaluate((n)=>{const a=n.querySelector('.source-removal-card img');window.savedSourceAvatar=a;return !!a;}),true);
    await page.evaluate(mode=>{for(let i=0;i<4;i++){
      const data=mode==='uids'?state.followBrowseData:state.favlistBrowseData;
      const key=mode==='uids'?'owners':'folders';data[key]=data[key].map(v=>({...v,last_updated_at:i}));
      if(mode==='uids')renderFollowBrowse();else renderFavlistBrowse();
    }},mode);
    assert.equal(await panel.evaluate(n=>n.querySelector('.source-removal-card img')===window.savedSourceAvatar),true,'background metadata retains the actual image node');
    const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
    if(evidence)await page.screenshot({path:path.join(evidence,`ios-${engine.name()}-${mode}-pages.png`)});
  }
  await page.context().route('**/api/d1/**',route=>route.fulfill({json:{ok:true,data:{tags:Array.from({length:100},(_,i)=>({tag:`A 标题 ${i+1}`,count:1})),items:[],has_more:false}}}));
  await page.locator('[data-request-back]:visible').click();
  await page.locator('[data-request-view="discover"]').click();await page.locator('[data-discover-mode="name"]').click();
  await page.locator('[data-letter="A"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.tag-browser-tags .tag-browser-tag').length>12);
  const geometry=await page.locator('.tag-browser-tags:visible').evaluate(n=>{const v=n.closest('.result-page-viewport'),r=n.lastElementChild.getBoundingClientRect(),p=v.getBoundingClientRect();return {bottom:r.bottom,limit:p.bottom,height:v.clientHeight,itemHeight:r.height,gap:getComputedStyle(n).rowGap,padding:getComputedStyle(n).paddingBottom,frame:n.closest('.android-result-frame').getBoundingClientRect().height};});
  assert.ok(geometry.bottom<=geometry.limit+1&&geometry.limit-geometry.bottom<geometry.itemHeight+parseFloat(geometry.gap),JSON.stringify(geometry));
  if(process.env.BILIKARA_PAGINATION_EVIDENCE)await page.screenshot({path:path.join(process.env.BILIKARA_PAGINATION_EVIDENCE,`ios-${engine.name()}-name-rows.png`)});
  await page.locator('[data-discover-mode="categories"]').click();
  let known=true;
  await page.context().route('**/api/d1/**',route=>route.fulfill({json:{ok:true,data:{items:posts.slice(0,8),has_more:true,next_offset:8,...(known?{matched_count:345}:{})}}}));
  await page.locator('[data-category-id]:visible').first().click();
  const category=page.locator('.category-browser-detail:visible');
  await page.waitForFunction(()=>!state.categoryBrowseLoading&&state.categoryBrowseMatchedCount===345);
  assert.match(await category.locator('.result-pager-items-total').innerText(),/345/);
  const style=await category.locator('.category-browser-tab.active').evaluate(n=>({shadow:getComputedStyle(n).boxShadow,font:getComputedStyle(n.querySelector('.category-browser-tab-name')).fontSize,height:n.getBoundingClientRect().height}));
  assert.deepEqual(style,{shadow:'none',font:'16px',height:44});
  if(process.env.BILIKARA_PAGINATION_EVIDENCE)await page.screenshot({path:path.join(process.env.BILIKARA_PAGINATION_EVIDENCE,`ios-${engine.name()}-category.png`)});
  for (const width of [320,375,393,430]) {
    await page.setViewportSize({width,height:1120});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const rows = await category.locator('[data-category-browse-results]').evaluate(node => {
      const viewport = node.closest('.result-page-viewport'), cards = [...node.children];
      const style = getComputedStyle(node), box = viewport.getBoundingClientRect();
      const rects = cards.map(card => card.getBoundingClientRect());
      return {height:viewport.clientHeight,card:rects[0].height,gap:parseFloat(style.rowGap)||0,
        padding:(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0),
        rows:new Set(rects.map(rect=>Math.round(rect.top))).size,
        complete:rects.every(rect=>rect.top>=box.top-1&&rect.bottom<=box.bottom+1)};
    });
    assert.equal(rows.complete, true, JSON.stringify({width,...rows}));
    if (rows.height >= rows.card*3+rows.gap*2+rows.padding) assert.ok(rows.rows>=3,JSON.stringify({width,...rows}));
  }
  known=false;await page.locator('[data-category-id]:visible').nth(1).click();
  await page.waitForFunction(()=>!state.categoryBrowseLoading&&state.categoryBrowseMatchedCount===null);
  assert.equal(await category.locator('.result-pager-items-total').isVisible(),false);
  assert.equal(await category.locator('.result-pager-total').isVisible(),false);
  assert.equal(await category.locator('[data-page-action="next"]').isEnabled(),true);
});

for(const engine of [chromium,webkit])test(`${engine.name()} Remote catalog loading stays readable and Back retires late replies`,{
  skip:process.platform!=='linux',timeout:90000,
},async t=>{
  const {page}=await open(t,'remote',engine),pending=[];
  await page.context().route('**/api/d1/**',route=>new Promise(resolve=>pending.push({
    async reply(data){await route.fulfill({json:{ok:true,data}});resolve();},
  })));
  const reply=async(index,data)=>{
    await waitFor(()=>pending[index],`catalog read ${index}`);
    await pending[index].reply(data);
  };
  const empty={items:[],tags:[],has_more:false,next_offset:0,matched_count:0};
  await page.locator('[data-remote-request-view="discover"]').click();
  await page.locator('[data-category-id]').first().click();
  const category=page.locator('#remote-discover-categories-panel');
  await page.waitForFunction(()=>state.categoryBrowseLoading);
  assert.match(await category.locator('[data-category-browse-results]').innerText(),/正在读取歌曲/);
  assert.equal(await category.locator('[data-category-browse-back]').isEnabled(),true);
  await category.locator('[data-category-browse-back]').click();
  await reply(0,{...empty,items:[{...posts[0],title:'Late category result'}]});
  await page.waitForFunction(()=>!state.categoryBrowseSelectedId&&!state.categoryBrowseLoading);
  assert.equal(await category.locator('[data-category-browser-home]').isVisible(),true);

  await page.locator('[data-remote-discover-mode="artist"]').click();
  const artist=page.locator('#remote-discover-artist-panel');
  await artist.locator('[data-letter="Y"]').click();
  await page.waitForFunction(()=>state.d1BrowseModes.artist.loading);
  assert.match(await artist.locator('[data-d1-browse-tags]').innerText(),/正在读取浏览索引/);
  assert.equal(await artist.locator('[data-d1-browse-back]').isEnabled(),true);
  await artist.locator('[data-d1-browse-back]').click();
  await reply(1,{...empty,tags:[{tag:'Late artist',count:1}]});
  await page.waitForFunction(()=>!state.d1BrowseModes.artist.letter&&!state.d1BrowseModes.artist.loading);
  assert.equal(await artist.locator('[data-d1-browse-alphabet]').isVisible(),true);

  await artist.locator('[data-letter="Y"]').click();
  const tags=Array.from({length:10},(_,i)=>({tag:i===9?'YOASOBI':`Y artist ${i}`,locale:'ja',count:3}));
  await reply(2,{...empty,tags});
  await artist.locator('[data-tag="YOASOBI"]').click();
  await page.waitForFunction(()=>state.d1BrowseModes.artist.loading&&state.d1BrowseModes.artist.tag==='YOASOBI');
  assert.match(await artist.locator('[data-d1-browse-results]').innerText(),/正在读取歌曲/);
  const geometry=await artist.evaluate(n=>({nav:n.querySelector('.tag-browser-nav').getBoundingClientRect().bottom,
    result:n.querySelector('[data-d1-browse-results]').getBoundingClientRect().top}));
  assert.ok(geometry.result-geometry.nav<32,`no empty track above artist results: ${JSON.stringify(geometry)}`);
  await artist.locator('[data-d1-browse-back]').click();
  await reply(3,{...empty,items:[{...posts[0],title:'Late YOASOBI result'}]});
  await reply(4,{...empty,tags});
  await page.waitForFunction(()=>!state.d1BrowseModes.artist.loading&&!state.d1BrowseModes.artist.tag);
  assert.equal(await artist.locator('[data-tag="YOASOBI"]').isVisible(),true);
  assert.equal(await artist.locator('[data-d1-browse-results]').isVisible(),false);
  await artist.locator('[data-tag="YOASOBI"]').click();
  await reply(5,empty);
  await page.waitForFunction(()=>!state.d1BrowseModes.artist.loading);
  assert.match(await artist.locator('[data-d1-browse-results]').innerText(),/没有匹配结果/);
  await artist.locator('[data-d1-browse-back]').click();
  await reply(6,{...empty,tags});
  await artist.locator('[data-d1-browse-back]').click();

  const owner={uid:'42',name:'Fixture UP',count:3};
  const folder={id:'42:7',folder_id:'7',title:'Fixture favorites',count:3};
  await page.context().route(/\/api\/gatcha\/(?:favlist\/)?browse(?:\?|$)/,route=>{
    const url=new URL(route.request().url()),favorites=url.pathname.includes('/favlist/');
    const selected=url.searchParams.get(favorites?'folder_id':'uid')||'';
    const data={...empty,owners:[owner],folders:[folder],selected_uid:favorites?'':selected,
      selected_folder_id:favorites?selected:'',query:'',items:selected?[posts[0]]:[]};
    if(!selected)return route.fulfill({json:{ok:true,data}});
    return new Promise(resolve=>pending.push({async reply(){await route.fulfill({json:{ok:true,data}});resolve();}}));
  });
  await page.locator('#remote-request-secondary-back').click();
  await page.locator('[data-remote-request-view="sources"]').click();
  for(const [index,mode,card,back,selectedState,loadingState] of [
    [7,'uids','#sources-follow-grid [data-uid="42"]','#sources-follow-back','followBrowseSelectedUid','followBrowseLoading'],
    [8,'favorites','#favlist-grid [data-folder-id="42:7"]','#favlist-browse-back','favlistBrowseSelectedFolderId','favlistBrowseLoading'],
  ]){
    await page.locator(`[data-remote-sources-mode="${mode}"]`).click();
    await page.locator(card).click();await waitFor(()=>pending[index],`${mode} detail read`);
    assert.equal(await page.locator(back).isEnabled(),true);
    await page.locator(back).click();await reply(index);
    await page.waitForFunction(({selectedState,loadingState})=>!state[selectedState]&&!state[loadingState],{selectedState,loadingState});
    assert.equal(await page.locator(card).isVisible(),true,'a late source reply must not reopen its detail');
  }
});

for(const engine of [chromium,webkit])test(`${engine.name()} phone songs keep at least three stable rows and prefetch the next database page`,{skip:process.platform!=='linux',timeout:90000},async t=>{
  const {page,errors}=await open(t,'ios',engine,{nativeDock:true}),reads=[];
  await page.context().route('**/api/gatcha/browse*',route=>{
    const url=new URL(route.request().url()),uid=url.searchParams.get('uid')||'',offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100);
    reads.push({uid,offset,limit});
    const length=offset===0?Math.min(12,limit):limit;
    return route.fulfill({json:{ok:true,data:{owners:[{uid:'42',name:'Fixture UP',count:posts.length}],selected_uid:uid,query:'',items:uid?posts.slice(offset,offset+length):[],matched_count:uid?posts.length:0,
      offset,next_offset:offset+length,has_more:Boolean(uid&&offset+length<posts.length)}}});
  });
  await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:2}})));await page.locator('[data-request-view="sources"]').click();
  await page.locator('#follow-up-grid [data-uid="42"]').click();
  const results=page.locator('#follow-song-results'),pager=results.locator('..').locator('..').locator('.result-pager');
  const size=async()=>Number(await pager.getAttribute('data-page-size'));
  await page.waitForFunction(()=>Number(document.querySelector('#follow-song-results')?.closest('.android-result-frame')?.querySelector('.result-pager').dataset.pageSize)>=6);
  const initialSize=await size();assert.equal(initialSize%2,0);assert.ok(initialSize>=6);
  await waitFor(()=>reads.some(r=>r.uid==='42'&&r.offset===initialSize*2),'automatic database read-ahead before a page turn');
  // Jump beyond the original provider batch. A successful commit must prefetch
  // neighboring database rows before a user requests the next page.
  await pager.locator('input').fill('40');await pager.locator('input').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#follow-song-results').closest('.android-result-frame').querySelector('.result-pager').dataset.page==='40');
  assert.ok(reads.some(r=>r.uid==='42'&&r.offset===39*initialSize&&r.limit>=initialSize*3),'the target read also caches the next two pages');
  await pager.locator('[data-page-action="next"]').click();
  await page.waitForFunction(()=>document.querySelector('#follow-song-results').closest('.android-result-frame').querySelector('.result-pager').dataset.page==='41');
  assert.equal(await size(),initialSize,'a different first song must not resize/reset the page model');
  assert.equal(reads.filter(r=>r.uid==='42'&&r.offset===40*initialSize).length,0,'the adjacent page is already cached; speculative reads may extend the window');
  assert.equal(reads.filter(r=>r.uid==='42'&&r.offset===39*initialSize).length,1,'the target batch is never re-read');
  for(const [action,target]of [['next',42],['next',43],['previous',42]]) {
    await pager.locator(`[data-page-action="${action}"]`).click();
    await page.waitForFunction(target=>document.querySelector('#follow-song-results').closest('.android-result-frame').querySelector('.result-pager').dataset.page===String(target),target);
    assert.equal(await size(),initialSize);
  }
  assert.equal(reads.filter(r=>r.uid==='42'&&r.offset===41*initialSize).length,0,'the bounded prefetch batch retains the immediately following page');
  const geometry=await pager.evaluate(n=>({bottom:n.getBoundingClientRect().bottom,viewport:innerHeight,
    dock:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-height')),
    rows:new Set([...document.querySelector('#follow-song-results').children].map(n=>Math.round(n.getBoundingClientRect().top))).size}));
  assert.ok(geometry.rows>=3,JSON.stringify(geometry));
  assert.ok(geometry.viewport-geometry.dock-geometry.bottom<=10,JSON.stringify(geometry));
  await page.setViewportSize({width:393,height:600});
  await page.waitForFunction(()=>Number(document.querySelector('#follow-song-results').closest('.android-result-frame').querySelector('.result-pager').dataset.pageSize)>=6);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.ok(await results.locator('..').evaluate(n=>n.scrollHeight>n.clientHeight),'a short phone keeps three rows with reachable vertical scrolling');
  const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`three-rows-${engine.name()}.png`)});}
  assert.deepEqual(errors,[]);
});

async function open(t,client,engine=chromium,{nativeDock=false}={}) {
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-source-pager-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const host=await RunningHost.start(binary,home,[home,path.join(process.env.BILIKARA_FEEDBACK_REFERENCE_ROOT||root,'static')],isolatedEnvironment(home),true);
  t.after(()=>host.close());await host.api('/api/session-users/add',{name:'Fixture singer'});
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:client==='desktop'?{width:1280,height:800}:{width:393,height:844},hasTouch:client!=='desktop'});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(({mobile,nativeDock})=>{
    localStorage.setItem('bilikara.update.automatic','false');localStorage.setItem('bilikara.ui.language','zh');
    if(nativeDock)window.BilikaraIosPlatform={syncDock:async()=>({height:83})};
    if(mobile)window.BilikaraHostWindow={postMessage(raw){if(['enter','exit'].includes(raw))return;
      const {id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));}};
  },{mobile:['android','ios'].includes(client),nativeDock});
  const reads=[];let revision=0;
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==host.base)return route.abort();
    if(client==='ios'&&url.pathname==='/'){
      const response=await route.fetch();
      return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});
    }
    if(url.pathname==='/api/gatcha/browse'){
      const uid=url.searchParams.get('uid')||'',offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100);
      if(uid==='42'&&offset===0&&reads.some(read=>read.uid==='42'&&read.offset===0))revision++;
      reads.push({uid,offset,limit});
      return route.fulfill({json:{ok:true,data:{owners:[{uid:'42',name:'Fixture UP',count:posts.length}],selected_uid:uid,
        query:url.searchParams.get('q')||'',items:uid?posts.slice(offset,offset+limit).map(post=>({...post,title:(revision?'Refreshed ':'')+post.title})):[],matched_count:uid?posts.length:0,
        offset,next_offset:offset+limit,has_more:Boolean(uid&&offset+limit<posts.length)}}});
    }
    if(url.pathname==='/api/gatcha/pool-config')return route.fulfill({json:{ok:true,data:{uid_weight:50,excluded_uids:[],excluded_favlist_folders:[],
      uid_options:[{uid:'42',name:'Fixture UP',count:612}],favlist_folder_options:[{id:'42:7',uid:'42',title:'Fixture favorites',count:24}]}}});
    return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.base+(client==='remote'?'/remote':''));
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.data?.session_user_entries?.length);
  if(client==='remote') {
    await page.locator('#remote-identity-input').fill('Pager tester');await page.locator('#remote-identity-submit').click();
    await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  } else if(client==='ios')await page.evaluate(()=>{document.documentElement.dataset.hostPlatform='ios';});
  else if(client==='desktop')await page.evaluate(()=>{document.documentElement.dataset.hostPlatform='desktop';});
  assert.match(await page.title(),/bilikara/);
  t.after(()=>assert.deepEqual(errors,[]));
  return {host,page,reads,errors};
}

for(const engine of [chromium,webkit])for(const [client,nativeDock] of [['android',false],['ios',false],['ios',true]])test(
  `${engine.name()} ${client} ${nativeDock?'native':'web'} source grid fits complete rows and retains record anchors [IOS-09-10] [B2-G7]`,
  {skip:process.platform!=='linux',timeout:90000},async t=>{
    const {page}=await open(t,client,engine,{nativeDock});
    let count=27;
    await page.context().route(/\/api\/gatcha\/(?:favlist\/)?browse(?:\?|$)/,route=>{
      const owners=Array.from({length:count},(_,i)=>({uid:String(i+42),name:`测试 UP ${i+1}`,count:i+1,avatar_url:'/pic/icon.png'}));
      const folders=owners.map(v=>({...v,id:`${v.uid}:7`,folder_id:'7',title:`收藏夹 ${v.uid}`}));
      return route.fulfill({json:{ok:true,data:{owners,folders,items:[],query:'',source_order_version:'a'.repeat(64),source_order_editable:true,source_order_count:count,has_more:false}}});
    });
    await page.evaluate(()=>{fetchState=async()=>{};state.eventSource?.close();});
    if(nativeDock)await page.evaluate(()=>dispatchEvent(new CustomEvent('bilikara:ios-dock-select',{detail:{index:2}})));
    else await page.locator('[data-android-page="request"]').click();
    await page.locator('[data-request-view="sources"]').click();
    const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));});
    const evidence=process.env.BILIKARA_CAPACITY_EVIDENCE,samples=[];
    for(const mode of ['uids','favorites']){
      await page.locator(`[data-sources-mode="${mode}"]`).click();
      const panel=page.locator(mode==='uids'?'#request-sources-uids':'#request-sources-favorites');
      const pager=panel.locator('.source-frame-footer .host-result-pager');
      for(count of [27,60]){
        await page.evaluate(mode=>mode==='uids'?loadFollowBrowse({uid:'',query:'',keepQuery:true}):loadFavlistBrowse({folderId:'',query:'',keepQuery:true}),mode);
        await pager.waitFor({state:'visible'});await settle();
        if(await pager.locator('[data-page-action="first"]').isEnabled()){await pager.locator('[data-page-action="first"]').click();await settle();}
        for(const font of [16,20]){
          const previousRows=new Map();
          for(const [width,height]of [[320,568],[375,667],[393,640],[393,720],[393,844],[393,852],[393,932],[430,1024],[1024,768]]){
            await page.setViewportSize({width,height});
            await page.evaluate(({client,font})=>{
              document.documentElement.style.fontSize=font+'px';
              if(client==='ios'){document.documentElement.style.setProperty('--ios-safe-top','59px');document.documentElement.style.setProperty('--ios-safe-bottom','34px');}
            },{client,font});
            await settle();
            const sample=await panel.evaluate(n=>{
              const rect=n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
              const q=s=>rect(n.querySelector(s)),grid=n.querySelector('.follow-up-grid'),style=getComputedStyle(grid);
              return {panel:rect(n),scroll:q('.source-browse-scroll'),viewport:q('.result-page-viewport'),grid:rect(grid),footer:q('.source-frame-footer'),tools:q('.source-tools'),pager:q('.host-result-pager'),dock:rect(document.getElementById('android-host-dock')),
                cards:[...grid.children].map(rect),fitHeight:n.querySelector('.source-browse-scroll').clientHeight,columns:style.gridTemplateColumns.split(' ').length,gap:parseFloat(style.rowGap),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom),pageSize:Number(n.querySelector('.host-result-pager').dataset.pageSize),
                targets:[...n.querySelectorAll('.source-tools button,.source-trash-slot,.host-result-pager button')].filter(n=>n.getClientRects().length).map(rect)};
            });
            const rows=new Set(sample.cards.map(r=>Math.round(r.top))).size;
            samples.push({mode,count,font,width,height,rows,...sample});
            if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,`source-capacity-${engine.name()}-${client}-${nativeDock?'native':'web'}.json`),JSON.stringify(samples,null,2));}
            assert.ok(sample.cards.every(r=>r.top>=sample.viewport.top-.5&&r.bottom<=Math.min(sample.viewport.bottom,sample.scroll.bottom)+.5),'all rendered source cards fit completely: '+JSON.stringify({mode,count,font,width,height,...sample}));
            const fittingRows=Math.max(1,Math.floor((sample.fitHeight-sample.padding+sample.gap+.5)/(sample.cards[0].height+sample.gap)));
            const capacity=sample.columns*Math.min(fittingRows,Math.floor(48/sample.columns));
            assert.equal(sample.pageSize,capacity,'every complete fitting row contributes capacity: '+JSON.stringify({width,height,font,mode,...sample}));
            if(sample.cards.length<count)assert.ok(sample.scroll.bottom-sample.grid.bottom<sample.cards[0].height+sample.gap,'the remaining space cannot hold another complete row');
            assert.ok(rows>=(previousRows.get(width)||0),'a taller viewport at the same width cannot lose a grid row');previousRows.set(width,rows);
            assert.ok(sample.scroll.bottom<=sample.footer.top&&sample.footer.bottom<=sample.dock.top,'cards and footer stay above the dock');
            assert.ok(sample.targets.every(r=>r.height>=44&&r.right<=sample.panel.right+.5&&r.left>=sample.panel.left-.5),'full tool and pager targets retain their bounds');
            assert.equal(sample.tools.height,52,'the approved trash slot is preserved');
            assert.equal(sample.pager.top-sample.tools.bottom,0,'the two inner insets replace the old footer gap');
            assert.equal(sample.footer.height,104,'52px tools and 52px pager have no extra gap');
            await pagerTargets(pager);
            if(sample.columns===3&&sample.scroll.height>=sample.cards[0].height*5+sample.gap*4+sample.padding)assert.ok(sample.pageSize>=15,'five fitting rows require at least 15 records per page');
            if(evidence&&font===16&&width===393)await page.screenshot({path:path.join(evidence,`sources-${engine.name()}-${client}-${nativeDock?'native':'web'}-${mode}-${height}.png`)});
          }
        }
        const bottom=(await pager.boundingBox()).y+52,tools=panel.locator('.source-tools');
        await tools.evaluate(node=>node.style.display='none');await settle();
        assert.equal(await tools.evaluate(node=>node.getBoundingClientRect().height),0,'an absent optional action slot consumes no height');
        assert.ok(Math.abs((await pager.boundingBox()).y+52-bottom)<=1,'hiding tools preserves the pager bottom anchor');
        await tools.evaluate(node=>node.style.removeProperty('display'));await settle();
        assert.ok(Math.abs((await pager.boundingBox()).y+52-bottom)<=1,'restoring tools preserves the pager bottom anchor');
        await pager.locator('[data-page-action="next"]').click();await settle();
        const anchor=await panel.locator('.source-removal-card').first().getAttribute('data-source-id');
        await panel.locator('.source-select-mode').click();
        await panel.locator('.source-removal-card').first().locator('.source-select-target').click();
        const input=panel.locator(mode==='uids'?'#modal-follow-uid-input':'#modal-favlist-uid-input');await input.fill('unsent capacity draft');
        for(const size of [{width:844,height:600},{width:393,height:852},{width:393,height:568},{width:430,height:1024}]){
          await page.setViewportSize(size);await settle();
          assert.ok((await panel.locator('.source-removal-card').evaluateAll(nodes=>nodes.map(n=>n.dataset.sourceId))).includes(anchor),'capacity cycles keep the same record in view');
          assert.equal(await panel.locator(`[data-source-id="${anchor}"] .source-checkbox`).isChecked(),true,'rotation/height changes retain the selected record in the visible page');
          assert.equal(await input.inputValue(),'unsent capacity draft');
        }
        await page.evaluate(mode=>{
          if(mode==='uids'){state.followBrowseData.owners.reverse();renderFollowBrowse();}
          else {state.favlistBrowseData.folders.reverse();renderFavlistBrowse();}
        },mode);await settle();
        assert.equal(await panel.locator(`[data-source-id="${anchor}"] .source-checkbox`).isChecked(),true,'sorting keeps the anchored source and its selection');
        await panel.locator('.source-select-mode').click();
      }
    }
  });

for(const client of ['desktop','android','ios','remote'])test(`${client} source details hide outer add rows and retain their drafts`,{
  skip:process.platform!=='linux',timeout:90000,
},async t=>{
  const {page}=await open(t,client);
  await page.context().route(/\/api\/gatcha\/(?:favlist\/)?browse(?:\?|$)/,route=>{
    const url=new URL(route.request().url()),favorites=url.pathname.includes('/favlist/');
    const selected=url.searchParams.get(favorites?'folder_id':'uid')||'';
    return route.fulfill({json:{ok:true,data:{owners:[{uid:'42',name:'Fixture UP',count:1}],
      folders:[{id:'42:7',folder_id:'42:7',title:'Fixture favorites',count:1}],
      selected_uid:favorites?'':selected,selected_folder_id:favorites?selected:'',
      items:selected?[posts[0]]:[],query:'',has_more:false}}});
  });
  if(client==='remote')await page.locator('[data-remote-request-view="sources"]').click();
  else if(['android','ios'].includes(client)){
    await page.locator('[data-android-page="request"]').click();await page.locator('[data-request-view="sources"]').click();
  }else{
    await page.locator('[data-host-workspace="request"]').click();await page.locator('[data-request-view="sources"]').click();
  }
  for(const mode of ['uids','favorites']){
    const remote=client==='remote',favorite=mode==='favorites';
    await page.locator(`[${remote?'data-remote-sources-mode':'data-sources-mode'}="${mode}"]`).click();
    const input=page.locator(remote?(favorite?'#sources-favlist-uid-input':'#sources-follow-uid-input')
      :(favorite?'#modal-favlist-uid-input':'#modal-follow-uid-input'));
    await input.fill(`unsent ${mode} draft`);
    const card=page.locator(favorite?'#favlist-grid [data-folder-id="42:7"]'
      :remote?'#sources-follow-grid [data-uid="42"]':'#follow-up-grid [data-uid="42"]');
    await card.click();
    const back=page.locator(favorite?'#favlist-browse-back':remote?'#sources-follow-back':'#follow-browse-back');
    await back.waitFor({state:'visible'});
    await page.waitForFunction(favorite=>!(favorite?state.favlistBrowseLoading:state.followBrowseLoading),favorite);
    assert.equal(await input.isVisible(),false,'outer add row is absent in detail');
    if(client!=='remote'){
      const geometry=await page.locator(favorite?'#request-sources-favorites':'#request-sources-uids').evaluate(panel=>{const r=panel.getBoundingClientRect(),scroller=panel.querySelector('.source-browse-scroll').getBoundingClientRect(),style=getComputedStyle(panel);return {rows:style.gridTemplateRows,gap:r.bottom-scroller.bottom,expected:parseFloat(style.paddingBottom)+parseFloat(style.borderBottomWidth)};});
      assert.ok(Math.abs(geometry.gap-geometry.expected)<=1,JSON.stringify(geometry));
    }
    const search=page.locator(favorite?'#favlist-search-form':remote?'#sources-follow-search-form':'#follow-search-form');
    await search.locator('..').locator('.browse-search-cancel').click();
    assert.equal(await search.locator('input').isVisible(),true,'detail retains its own search');
    const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${client}-${mode}-detail.png`)});}
    await search.locator('..').locator('.browse-search-cancel').click();
    await back.click();await card.waitFor({state:'visible'});
    assert.equal(await input.isVisible(),true);assert.equal(await input.inputValue(),`unsent ${mode} draft`);
  }
});

for(const client of ['remote','android'])test(`${client} UP post paging survives cache turnover and ordinary state updates`,{
  skip:process.platform!=='linux',timeout:90000,
},async t=>{
  const {host,page,reads}=await open(t,client);
  if(client==='remote')await page.locator('[data-remote-request-view="sources"]').click();
  else {
    await page.locator('[data-android-page="request"]').click();await page.locator('[data-request-view="sources"]').click();
  }
  await page.locator(client==='remote'?'[data-remote-sources-mode="uids"]':'[data-sources-mode="uids"]').click();
  await page.locator(client==='remote'?'#sources-follow-grid [data-uid="42"]':'#follow-up-grid [data-uid="42"]').click();
  const selector=client==='remote'?'#sources-follow-results':'#follow-song-results';
  const results=page.locator(selector),pager=results.locator('..').locator('..').locator('.result-pager');
  await results.locator('.search-result-item').first().waitFor();
  const cdp=await page.context().newCDPSession(page);t.after(()=>cdp.detach().catch(()=>{}));
  async function swipe(distance) {
    await results.locator('.search-result-item').first().scrollIntoViewIfNeeded();
    const box=await results.locator('.search-result-item').first().boundingBox(),x=box.x+box.width*.8,y=box.y+box.height*.45;
    await page.evaluate(()=>document.activeElement?.blur());
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(const fraction of [.2,.5,1])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-distance*fraction,y:y+2}]});
    assert.equal(await pager.evaluate(node=>node.classList.contains('is-interacting')),true,'A horizontal gesture shows swipe dots');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pageSize = Number(await pager.getAttribute('data-page-size'));
  assert.ok(pageSize > 0);
  assert.equal(await results.locator('.search-result-item').count(), pageSize);
  if (client === 'remote') assert.equal(pageSize, 6, 'Remote retains its six-song page');
  const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
  if(evidence)mkdirSync(evidence,{recursive:true});
  try {
    for(let expected=2;expected<=35;expected++){
      if(expected%5===0)await swipe(140);
      else await pager.locator('[data-page-action="next"]').tap();
      await page.waitForFunction(({selector,expected})=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').dataset.page===String(expected),{selector,expected});
      assert.equal(await results.locator('.search-result-title').first().textContent(),`Post ${(expected-1)*pageSize+1}`);
      if(expected%7===0){await host.api('/api/session-users/add',{name:`Other ${expected}`});
        await page.waitForFunction(expected=>state.data.session_users.includes(`Other ${expected}`),expected);
        assert.equal(await pager.getAttribute('data-page'),String(expected),'Unrelated SSE must preserve the current page');}
    }
    // This is the same reload used by background source-completion notices.
    // The query/UP is unchanged, and the initial batch does not include page 35.
    await page.evaluate(()=>loadFollowBrowse({uid:'42',query:'',keepQuery:true}));
    await page.waitForFunction(()=>!state.followBrowseLoading);
    assert.equal(await pager.getAttribute('data-page'),'35','A same-UP background reload must preserve the visible page');
    await page.waitForFunction(selector=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').getAttribute('aria-busy')==='false',selector);
    assert.equal(await results.locator('.search-result-title').first().textContent(),`Refreshed Post ${34*pageSize+1}`,'The retained page is re-read, never a stale cache entry');
    if(evidence){await pager.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`${client}-page35-after-refresh.png`)});}
    // First/last and an entered page retain the numeric label on touch clients.
    for(const action of ['last','first']){
      await pager.locator(`[data-page-action="${action}"]`).tap();
      await page.waitForFunction(({selector,expected})=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').dataset.page===String(expected),{selector,expected:action==='last'?Math.ceil(posts.length/pageSize):1});
      assert.equal(await pager.evaluate(node=>node.classList.contains('is-interacting')),false,'Explicit page jumps must not show swipe dots');
    }
    await pager.locator('[data-page-input]').fill('9');await pager.locator('[data-page-input]').press('Enter');
    await page.waitForFunction(selector=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').dataset.page==='9',selector);
    assert.equal(await pager.evaluate(node=>node.classList.contains('is-interacting')),false,'Entered pages also retain the numeric label');
    await swipe(30);
    await page.waitForFunction(selector=>!document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').classList.contains('is-interacting'),selector);
    assert.equal(await pager.getAttribute('data-page'),'9','A cancelled short swipe keeps its page and returns to numbers');
    await page.evaluate(()=>loadFollowBrowse({uid:'42',query:'new query',keepQuery:true}));
    assert.equal(await pager.getAttribute('data-page'),'1','A changed query starts at the first page');
  } finally {
    if(evidence){await page.screenshot({path:path.join(evidence,`${client}-posts.png`)});
      writeFileSync(path.join(evidence,`${client}-posts.json`),JSON.stringify({reads,page:await pager.getAttribute('data-page')},null,2)+'\n');}
  }
});

for(const client of ['desktop','android','remote'])test(`${client} pool bulk tools share compact pills without crowding headings`,{
  skip:process.platform!=='linux',timeout:60000,
},async t=>{
  const {page}=await open(t,client);
  if(client==='android')await page.locator('[data-android-page="request"]').click();
  if(client==='android')await page.locator('#android-request-random').click();
  else if(client==='ios')await page.evaluate(()=>{document.documentElement.dataset.hostPlatform='ios';});
  else if(client==='desktop')await page.locator('[data-host-workspace="random"]').click();
  await page.locator('#gatcha-pool-config-toggle').click();
  const dialog=page.locator(client==='remote'?'#gatcha-pool-config-sheet':'#gatcha-pool-config-modal');
  await dialog.waitFor({state:'visible'});
  await dialog.evaluate(node=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await dialog.evaluate(node=>Promise.allSettled(node.getAnimations({subtree:true}).map(animation=>animation.finished)));
  const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${client}-pool-initial.png`)});}
  for(const width of client==='desktop'?[1280,700]:[393,320])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:844});await page.evaluate(language=>setLanguage(language),language);
    const rows=await dialog.locator('.pool-config-list-head').evaluateAll(nodes=>nodes.map(node=>{
      const heading=node.querySelector('h3'),actions=node.querySelector('.pool-config-bulk-actions');
      const h=heading.getBoundingClientRect(),a=actions.getBoundingClientRect(),r=node.getBoundingClientRect();
      return {height:r.height,overlap:h.right>a.left&&h.left<a.right&&h.bottom>a.top&&h.top<a.bottom,within:a.right<=r.right+1,buttons:[...actions.children].map(button=>{
        const s=getComputedStyle(button),b=button.getBoundingClientRect();return {height:b.height,font:s.fontSize,weight:s.fontWeight,radius:s.borderRadius,clipped:button.scrollWidth>button.clientWidth};})};
    }));
    for(const row of rows){assert.equal(row.within,true);assert.equal(row.overlap,false);assert.ok(row.height<=63,JSON.stringify({client,width,language,row}));for(const b of row.buttons){
      assert.ok(Math.abs(b.height-30)<.01,JSON.stringify({client,width,language,row}));assert.equal(b.font,'12px');assert.equal(b.weight,'700');assert.equal(b.radius,'999px');assert.equal(b.clipped,false);
    }}
  }
  if(evidence){mkdirSync(evidence,{recursive:true});await page.setViewportSize({width:client==='desktop'?1280:393,height:844});await page.evaluate(()=>setLanguage('zh'));
    await page.screenshot({path:path.join(evidence,`${client}-pool.png`)});}
});
