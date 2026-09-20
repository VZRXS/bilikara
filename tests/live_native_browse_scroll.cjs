"use strict";
// Offline real-scroll regression. Native UP/favorites APIs are real; catalog
// pages are fixtures so this test never spends the production D1 read budget.
// node tests/live_native_browse_scroll.cjs EXE PRIVATE_DIR [CHROME]
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, executablePath] = process.argv.slice(2);

(async () => {
  await fs.mkdir(directory, {recursive:true});
  const items = Array.from({length:221}, (_,n) => ({bvid:`BV${String(n).padStart(10,"0")}`,
    title:`Offline song ${n}`,mid:"123",owner_name:"Fixture",duration:123,
    url:`https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}`,fav_uid:"123",fav_folder_id:"456"}));
  for (const [name,data] of Object.entries({
    "gatcha_uids.json":{schema_version:2,uids:["123"],profiles:{}},
    "native-library-defaults.json":{schema_version:1},
    "gatcha_cache.json":{schema_version:3,uids:{123:items},profiles:{}},
    "gatcha_favlist.json":{schema_version:2,uids:["123"],folders:[{id:"456",uid:"123",title:"Offline folder",media_count:221}],items},
  })) await fs.writeFile(path.join(directory,name),JSON.stringify(data));
  const server=spawn(exe,[path.resolve(directory),path.resolve("static")],{stdio:["pipe","pipe","pipe"]});
  server.stderr.on("data",()=>{});
  const lines=createInterface({input:server.stdout});
  let browser;
  const failures=[], measurements={};
  try {
    const bootstrap=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited");})])).bootstrap_url;
    browser=await chromium.launch({headless:true,executablePath});
    const context=await browser.newContext({viewport:{width:392,height:817},isMobile:true,hasTouch:true,locale:"zh-CN"});
    await context.addInitScript(()=>Object.defineProperty(screen.orientation,"type",{configurable:true,get:()=>"portrait-primary"}));
    const requests=[];
    await context.route("**/*",route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith("/api/d1/")) {
        const offset=Number(url.searchParams.get("offset")||0);
        const limit=Math.min(100,Number(url.searchParams.get("limit")||100));
        requests.push({path:url.pathname,kind:url.searchParams.get("kind"),offset,limit});
        const data=url.pathname==="/api/d1/browse" && !url.searchParams.get("tag")
          ? {tags:[{tag:"Offline tag",count:221}],items:[],has_more:false}
          : {items:items.slice(offset,offset+limit),tags:[],offset,has_more:offset+limit<items.length,next_offset:Math.min(offset+limit,items.length)};
        return route.fulfill({json:{ok:true,data}});
      }
      return url.hostname==="127.0.0.1" ? route.continue() : route.abort();
    });
    const host=await context.newPage();
    await host.goto(bootstrap);
    await host.waitForFunction(()=>state.data?.capabilities?.gatcha && window.BilikaraAndroidHost?.isPortrait());
    const invite=await host.evaluate(()=>state.data.remote_access.local_url);
    const check=async(name,fn)=>{
      try { await fn(); measurements[name]={...measurements[name],passed:true}; }
      catch(e) { failures.push(`${name}: ${e.message}`); }
    };
    // Real input, not a direct paging function or a synthetic scroll event.
    const wheelToEnd=async(page,selector)=>{
      const box=await page.locator(selector).boundingBox();
      assert.ok(box && box.height>0,`${selector} has no viewport`);
      await page.mouse.move(box.x+box.width/2,Math.min(box.y+box.height/2,750));
      await page.mouse.wheel(0,100000);
    };
    await host.locator('[data-android-page="request"]').click();
    await host.locator('[data-request-view="sources"]').click();
    await host.locator('[data-sources-mode="favorites"]').click();
    await host.locator('#favlist-grid [data-folder-id="123:456"]').click();
    await host.waitForFunction(()=>state.favlistBrowseData?.items.length===221);
    await check("hostFavoritesScroll",async()=>{
      await wheelToEnd(host,"#request-sources-favorites-scroll");
      await host.waitForFunction(()=>{
        const last=document.querySelector("#favlist-song-results")?.lastElementChild;
        if(!last)return false;
        const r=last.getBoundingClientRect(),v=document.querySelector("#request-sources-favorites-scroll").getBoundingClientRect();
        return r.bottom<=v.bottom+1 && r.top>=v.top;
      },null,{timeout:4000});
    });
    measurements.hostFavoritesScroll=await host.evaluate(()=>Object.fromEntries(["request-sources-favorites-scroll","favlist-browser-view","favlist-items-view","favlist-song-results"].map(id=>{
      const e=document.getElementById(id),r=e.getBoundingClientRect();return [id,{height:r.height,scroll:e.scrollHeight,top:e.scrollTop,overflow:getComputedStyle(e).overflowY}];
    })));
    await host.screenshot({path:path.join(directory,"host-favorites.png")});

    const remote=await context.newPage();
    await remote.goto(invite);
    await remote.waitForFunction(()=>state.data?.capabilities?.gatcha);
    await remote.locator("#remote-identity-input").fill("Scroll tester");
    await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(()=>state.remoteIdentity?.registered);
    const primary=async()=>{const back=remote.locator("#remote-request-secondary-back");if(await back.isVisible())await back.click();};
    const pageAll=async(name,selector,count,initial=100)=>check(name,async()=>{
      assert.equal(await remote.evaluate(count),initial);
      const pager=remote.locator(selector).locator("xpath=following-sibling::nav[contains(@class, 'result-pager')]");
      const input=pager.locator("[data-page-input]");
      assert.equal(await remote.locator(`${selector} .search-result-item`).count(),4);
      assert.equal(await input.isVisible(),true);
      assert.equal(await pager.evaluate(el=>getComputedStyle(el).borderTopWidth),"0px");
      if (name === "remoteUp") {
        const touch = await context.newCDPSession(remote);
        for (const expected of [2,3,4,3,2]) {
          const current = Number(await pager.getAttribute("data-page"));
          await remote.locator(selector).evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 8));
          const box = await remote.locator(`${selector} .search-result-item`).first().boundingBox();
          const dx = expected > current ? -100 : 100;
          const x = dx < 0 ? box.x + box.width - 10 : box.x + 10;
          const y = Math.max(60, box.y + 40);
          await touch.send("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{x,y,id:1}]});
          for (let step = 1; step <= 6; step++) {
            await touch.send("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x:x+dx*step/6,y,id:1}]});
          }
          await touch.send("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
          await remote.waitForFunction(({selector,expected}) => document.querySelector(selector).nextElementSibling.dataset.page === String(expected), {selector,expected});
          const dots = await pager.locator("[data-dot-page]").evaluateAll(nodes => nodes.map(node => Number(node.dataset.dotPage)));
          assert.deepEqual(dots, expected === 4 || (current >= 3 && expected < current) ? [2,3,4] : [1,2,3]);
          assert.equal(await remote.locator(".song-detail-view:not(.hidden)").count(), 0);
        }
        await touch.detach();
      }
      for(const page of [26,27,56]) {
        await input.fill(String(page));
        await pager.focus();
        assert.equal(await input.inputValue(), String(page), "focus changes must preserve the entered page");
        await input.press("Enter");
        await remote.waitForFunction(({selector,page})=>{
          const grid=document.querySelector(selector);
          return grid.getAttribute("aria-busy")==="false"
            && grid.nextElementSibling.querySelector("input").value===String(page);
        },{selector,page});
        assert.equal(await remote.locator(`${selector} .search-result-item`).count(),page===56?1:4);
        assert.ok((await remote.locator(selector).textContent()).includes(`Offline song ${(page-1)*4}`));
      }
      await pager.focus();
      await pager.press("ArrowRight");
      assert.equal(await pager.getAttribute("data-page"),"56");
      // Scrolling a terminal page cannot issue an extra load.
      const before=requests.length;
      await wheelToEnd(remote,selector);
      await remote.waitForTimeout(200);
      assert.equal(requests.length,before);
      assert.equal(await remote.locator(selector).evaluate(el=>getComputedStyle(el).overflowY),"visible");
      measurements[name]={page:56,visibleItems:1,initialItems:await remote.evaluate(count)};
    });
    await remote.locator("#remote-request-sources-tab").click();
    await remote.locator('#sources-follow-grid [data-uid="123"]').click();
    await remote.waitForFunction(()=>state.followBrowseData?.items?.length===100);
    await pageAll("remoteUp", "#sources-follow-results",()=>state.followBrowseData.items.length);
    await primary();
    await remote.locator("#remote-request-sources-tab").click();
    await remote.locator('[data-remote-sources-mode="favorites"]').click();
    await remote.locator('#favlist-grid [data-folder-id="123:456"]').click();
    await remote.waitForFunction(()=>state.favlistBrowseData?.items?.length===100);
    await pageAll("remoteFavorites","#favlist-song-results",()=>state.favlistBrowseData.items.length);
    await primary();
    await remote.locator("#remote-request-discover-tab").click();
    await remote.locator("[data-category-browser-grid] [data-category-id]").first().click();
    await remote.waitForFunction(()=>state.categoryBrowseItems?.length===12);
    await pageAll("remoteCategories","[data-category-browse-results]",()=>state.categoryBrowseItems.length,12);
    for(const kind of ["name","artist"]) {
      await primary();
      await remote.locator("#remote-request-discover-tab").click();
      await remote.locator(`[data-remote-discover-mode="${kind}"]`).click();
      const panel=remote.locator(`#remote-discover-${kind}-panel`);
      await panel.locator('[data-letter="A"]').click();
      await panel.locator('[data-tag="Offline tag"]').click();
      await remote.waitForFunction(kind=>state.d1BrowseModes[kind]?.data?.items?.length===12,kind);
      const count=kind==="name" ? ()=>state.d1BrowseModes.name.data.items.length : ()=>state.d1BrowseModes.artist.data.items.length;
      await pageAll(`remote${kind}`,`#remote-discover-${kind}-panel [data-d1-browse-results]`,count,12);
    }
    await remote.screenshot({path:path.join(directory,"remote-browse.png")});
    console.log(JSON.stringify({measurements,requests,failures,onlineD1Requests:0}));
    assert.deepEqual(failures,[]);
  } finally {
    if(browser)await browser.close();
    server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null)await once(server,"exit");
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
