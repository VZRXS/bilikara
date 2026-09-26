'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

// Run against an already identified Remote. Synthetic snapshots exercise UI
// layout/cadence; real login/SSE and media cache checks are separate gates.
module.exports = async function checkPlaybackFollowup(page, output) {
  await page.evaluate(() => { closeEventStream(); fetchState = async () => {}; });
  const widths = [375, 320, 844, 1280];
  for (const width of widths) {
    await page.setViewportSize({width, height:width === 844 ? 390 : 690});
    await page.evaluate(() => {
      const item = state.data.current_item;
      Object.assign(item, {display_title:'はじまりは恋 - カナデ (夏吉ゆうこ) -『KANADE』OP',
        owner_name:'VZRXS', requester_name:'test', cache_status:'failed', cache_message:'测试失败',
        video_page:1, selected_pages:[1,3], selected_parts:['On vocal','Off vocal'], selected_cids:[1,3],
        available_pages:[1,2,3], available_parts:['On vocal','On vocal (guitar ver.)','Off vocal'], available_cids:[1,2,3]});
      render(); openPlaybackSheet();
    });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => {
      const rect = e => e.getBoundingClientRect();
      const panel = rect(elements.playbackSheetPanel), refresh = rect(elements.refreshButton);
      const buttons = [...document.querySelectorAll('.player-control-row button')];
      return {overflow:document.documentElement.scrollWidth > innerWidth,
        collapseBackground:getComputedStyle(elements.playbackSheetCollapse).backgroundColor,
        top:refresh.top - panel.top, right:panel.right - refresh.right,
        controls:buttons.map(b=>rect(b).height), cache:rect(elements.currentCacheState).height,
        title:document.querySelector('[data-playback-metadata-field="title"]').dataset,
        summary:rect(elements.playbackSheetSummary).height};
    });
    assert.equal(metrics.overflow, false);
    assert.equal(metrics.collapseBackground, 'rgba(0, 0, 0, 0)');
    assert(Math.abs(metrics.top-metrics.right) <= 1, JSON.stringify(metrics));
    assert(metrics.controls.every(n=>n===44), JSON.stringify(metrics));
    assert.equal(metrics.cache,20);
    assert(!await page.locator('.audio-variant-summary').count());
    assert(await page.locator('.audio-variant-bar > .audio-variant-list > button:visible').count());
    if (await page.locator('.audio-variant-toggle').isVisible()) {
      await page.locator('.audio-variant-toggle').click();
      assert.equal(await page.locator('#audio-variant-popover button:visible').count(),3);
      await page.locator('.audio-variant-toggle').click();
    }
    await page.screenshot({path:path.join(output,`remote-sheet-${width}.png`)});
    const readyHeight = await page.evaluate(async () => {
      state.data.current_item.cache_status='ready'; render();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return elements.playbackSheetSummary.getBoundingClientRect().height;
    });
    assert(Math.abs(readyHeight-metrics.summary) <= 1, `cache/owner shifts summary at ${width}: ${readyHeight} / ${metrics.summary}`);
    await page.evaluate(()=>closePlaybackSheet());
  }
  // Exactly two lines remain fully visible; longer titles scroll one line.
  await page.setViewportSize({width:375,height:690});
  await page.evaluate(()=>openPlaybackSheet());
  for (const [title, natural, visible] of [['测试歌曲',1,1],['这是一个正好需要显示两行的标题',2,2],['很长的歌曲名称'.repeat(12),true,1]]) {
    const layout=await page.evaluate(async title=>{
      state.data.current_item.display_title=title; render();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const field=document.querySelector('[data-playback-metadata-field="title"]');
      return {natural:Number(field.dataset.naturalLines),visible:Number(field.dataset.visibleLines),scrolling:field.classList.contains('is-marquee')};
    },title);
    if(natural===true)assert(layout.natural>2);else assert.equal(layout.natural,natural);
    assert.equal(layout.visible,visible);assert.equal(layout.scrolling,natural===true);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#current-title').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Progress paints at most once a second, but terminal transitions are immediate.
  const cadence=await page.evaluate(async()=>{
    window.clearTimeout(state.cacheProgressPaintTimer); state.cacheProgressPaintTimer=null;
    state.cacheProgressPaintIdentity=null;
    const original=renderCurrentPlaybackState, paints=[];
    renderCurrentPlaybackState=(...args)=>{paints.push(performance.now());original(...args);};
    try {
      state.data.current_item.cache_status='downloading';
      for(let n=0;n<15;n++) {state.data.current_item.cache_progress=n;renderCacheStatusOnly(state.data);await new Promise(r=>setTimeout(r,100));}
      const before=paints.length;
      state.data.current_item.cache_status='failed';renderCacheStatusOnly(state.data);
      return {before,terminal:paints.length-before,intervals:paints.slice(1,before).map((at,i)=>at-paints[i])};
    } finally {renderCurrentPlaybackState=original;}
  });
  assert.equal(cadence.before,2,JSON.stringify(cadence));assert.equal(cadence.terminal,1);
  assert(cadence.intervals.every(ms=>ms>=990),JSON.stringify(cadence));
  await page.evaluate(()=>closePlaybackSheet());
  // All three grids keep 12 cards per page regardless of the responsive columns.
  for(const width of [375,1280]) {
    await page.setViewportSize({width,height:900});
    for(const kind of ['uids','favorites','categories']) {
      const selector=await page.evaluate(kind=>{
        const entries=Array.from({length:40},(_,i)=>({uid:String(101+i),id:String(i+1),name:`UP ${i}`,title:`收藏夹 ${i}`,count:i}));
        if(kind==='categories') {activateRemoteRequestView('discover');activateRemoteDiscoverMode('categories');renderCategoryBrowseView();return '[data-category-browser-grid]';}
        activateRemoteRequestView('sources');activateRemoteSourcesMode(kind);
        if(kind==='uids'){state.followBrowseData={owners:entries,items:[]};state.followBrowseLoading=false;state.sourcesFollowBrowseRenderSignature='';renderSourcesFollowBrowse();return '#sources-follow-grid';}
        state.favlistBrowseData={folders:entries,items:[]};state.favlistBrowseLoading=false;state.favlistBrowseRenderSignature='';renderFavlistBrowse();return '#favlist-grid';
      },kind);
      const container=page.locator(selector);await container.waitFor({state:'visible'});
      const pager=container.locator('xpath=../following-sibling::*[contains(@class,"result-pager")]');
      assert.equal(await container.locator(':scope > button').count(),12);
      await pager.locator('[data-page-action="next"]').click();
      await page.waitForTimeout(260);assert.equal(await pager.getAttribute('data-page'),'2');
      const count=await container.locator(':scope > button').count();
      assert(count>0&&count<=12);
      await page.evaluate(()=>render());
      assert.equal(await pager.getAttribute('data-page'),'2','Unrelated snapshots preserve the page');
      await pager.locator('[data-page-action="previous"]').click();
      await page.waitForTimeout(260);assert.equal(await pager.getAttribute('data-page'),'1');
      assert.equal(await container.locator(':scope > button').count(),12);
      await page.evaluate(()=>window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await page.screenshot({path:path.join(output,`remote-${kind}-${width}.png`)});
    }
  }
  console.log('PASS: playback geometry, part pills, title wrap/marquee, progress cadence, pagination',cadence);
};
