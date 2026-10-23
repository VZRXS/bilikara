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
before(async()=>{if(process.platform==='linux')binary=await buildNativeAlpha();},{timeout:300000});
const posts=Array.from({length:612},(_,i)=>({bvid:'BV'+String(i+1).padStart(10,'0'),title:`Post ${i+1}`,
  owner_name:'Fixture UP',source_url:'https://www.bilibili.com/video/BV'+String(i+1).padStart(10,'0')}));

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

async function open(t,client,engine=chromium) {
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-source-pager-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const host=await RunningHost.start(binary,home,[home,path.join(root,'static')],isolatedEnvironment(home),true);
  t.after(()=>host.close());await host.api('/api/session-users/add',{name:'Fixture singer'});
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:client==='desktop'?{width:1280,height:800}:{width:393,height:844},hasTouch:client!=='desktop'});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(android=>{
    localStorage.setItem('bilikara.update.automatic','false');localStorage.setItem('bilikara.ui.language','zh');
    if(android)window.BilikaraHostWindow={postMessage(raw){if(['enter','exit'].includes(raw))return;
      const {id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}));}};
  },client==='android');
  const reads=[];let revision=0;
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==host.base)return route.abort();
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
  } else if(client==='desktop')await page.evaluate(()=>{document.documentElement.dataset.hostPlatform='desktop';});
  assert.match(await page.title(),/bilikara/);
  t.after(()=>assert.deepEqual(errors,[]));
  return {host,page,reads};
}

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
  const evidence=process.env.BILIKARA_PAGINATION_EVIDENCE;
  if(evidence)mkdirSync(evidence,{recursive:true});
  try {
    for(let expected=2;expected<=35;expected++){
      if(expected%5===0)await swipe(140);
      else await pager.locator('[data-page-action="next"]').tap();
      await page.waitForFunction(({selector,expected})=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').dataset.page===String(expected),{selector,expected});
      assert.equal(await results.locator('.search-result-title').first().textContent(),`Post ${(expected-1)*6+1}`);
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
    assert.equal(await results.locator('.search-result-title').first().textContent(),'Refreshed Post 205','The retained page is re-read, never a stale cache entry');
    if(evidence){await pager.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`${client}-page35-after-refresh.png`)});}
    // First/last and an entered page retain the numeric label on touch clients.
    for(const action of ['last','first']){
      await pager.locator(`[data-page-action="${action}"]`).tap();
      await page.waitForFunction(({selector,expected})=>document.querySelector(selector).closest('.result-page-viewport').parentElement.querySelector('.result-pager').dataset.page===String(expected),{selector,expected:action==='last'?102:1});
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
