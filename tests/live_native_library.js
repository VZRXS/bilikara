"use strict";
// Offline shared-UI acceptance: real native HTTP and local library/settings.
// Only the cloud search response is stubbed; no online D1/Bilibili requests.
// node tests/live_native_library.js EXE PRIVATE_DIR [CHROME]
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, executablePath] = process.argv.slice(2);

async function run() {
  await fs.mkdir(directory, {recursive:true});
  const items = Array.from({length:221}, (_,n) => ({bvid:`BV${String(n).padStart(10,"0")}`,title:`卡拉 高达 ${n}`,mid:"123",owner_name:"Fixture",
    url:`https://www.bilibili.com/video/BV${String(n).padStart(10,"0")}`,fav_uid:"123",fav_folder_id:"456"}));
  for (const [name,data] of Object.entries({
    "gatcha_uids.json":{schema_version:2,uids:["123"],profiles:{}},
    "gatcha_cache.json":{schema_version:3,uids:{123:items},profiles:{}},
    "gatcha_favlist.json":{schema_version:2,uids:["123"],folders:[{id:"456",uid:"123",title:"卡拉",media_count:221}],items},
  })) await fs.writeFile(path.join(directory,name),JSON.stringify(data));
  const server = spawn(exe,[path.resolve(directory),path.resolve("static")],{stdio:["pipe","pipe","pipe"]});
  const lines = createInterface({input:server.stdout});
  server.stderr.on("data",() => {});
  let browser, page;
  try {
    const bootstrap = JSON.parse(await Promise.race([
      once(lines,"line").then(v=>v[0]), once(server,"exit").then(()=>{throw Error("Host exited");}),
    ])).bootstrap_url;
    browser = await chromium.launch({headless:true,executablePath});
    const context = await browser.newContext({viewport:{width:1100,height:850}});
    const errors = [];
    page = await context.newPage();
    page.on("pageerror",e=>errors.push(e.message));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/lark/search") return route.fulfill({json:{ok:true,data:{items:[items[220]]}}});
      if (url.pathname.startsWith("/api/d1/")) return route.fulfill({json:{ok:true,data:{items:[items[220]],tags:[],has_more:false,next_offset:1}}});
      if (url.hostname !== "127.0.0.1") return route.abort();
      return route.continue();
    });
    await page.goto(bootstrap);
    await page.waitForFunction(()=>state.data?.capabilities?.shared_search === true);
    await page.locator("#work-rail-request").click();
    await page.locator('[data-request-view="search"]').click();
    await page.locator("#lark-search-query").fill("高达");
    await page.locator("#lark-search-button").click();
    await page.waitForFunction(()=>document.querySelector("#lark-search-results")?.textContent.includes("高达 220"));
    await page.locator('[data-request-view="sources"]').click();
    await page.locator('#follow-up-grid [data-uid="123"]').click();
    await page.waitForFunction(()=>state.followBrowseData?.items.length===221);
    await page.locator('[data-sources-mode="favorites"]').click();
    await page.locator('#favlist-grid [data-folder-id="123:456"]').click();
    await page.waitForFunction(()=>state.favlistBrowseData?.items.length===221);
    await page.locator('[data-request-view="discover"]').click();
    assert.equal(await page.locator("#request-discover-panel").isVisible(),true);
    await page.locator("#work-rail-settings").click();
    await page.locator("#cache-settings-toggle").click();
    // Use the original shared preference control, not a native-only setting UI.
    await page.locator("#cache-quality-select").selectOption("1080P 高清");
    await page.waitForFunction(()=>state.data.cache_policy.video_quality==="1080P 高清");
    const saved=JSON.parse(await fs.readFile(path.join(directory,"native-preferences.json"),"utf8"));
    assert.equal(saved.cache.video_quality,"1080P 高清");
    await page.reload();
    await page.waitForFunction(()=>state.data?.cache_policy?.video_quality==="1080P 高清");
    const invite=await page.evaluate(()=>state.data.remote_access.local_url);
    const remoteContext=await browser.newContext({viewport:{width:412,height:850},isMobile:true,hasTouch:true});
    await remoteContext.route("**/*", route=>new URL(route.request().url()).hostname==="127.0.0.1" ? route.continue() : route.abort());
    const remote=await remoteContext.newPage();
    remote.on("pageerror",e=>errors.push(e.message));
    await remote.goto(invite);
    await remote.waitForFunction(()=>state.data?.capabilities?.gatcha===true);
    // Exercise the actual shared Remote paging functions and Rust router; UI
    // scrolling uses this same append path. No fake API result on these routes.
    await remote.evaluate(()=>loadFollowBrowse({uid:"123",query:""}));
    assert.equal(await remote.evaluate(()=>state.followBrowseData.items.length),100);
    await remote.evaluate(()=>loadFollowBrowse({uid:"123",query:"",append:true}));
    await remote.evaluate(()=>loadFollowBrowse({uid:"123",query:"",append:true}));
    assert.equal(await remote.evaluate(()=>state.followBrowseData.items.length),221);
    await remote.evaluate(()=>loadFavlistBrowse({folderId:"123:456",query:""}));
    await remote.evaluate(()=>loadFavlistBrowse({folderId:"123:456",query:"",append:true}));
    await remote.evaluate(()=>loadFavlistBrowse({folderId:"123:456",query:"",append:true}));
    assert.equal(await remote.evaluate(()=>state.favlistBrowseData.items.length),221);
    const candidate = await remote.evaluate(async()=> (await (await fetch("/api/gatcha/candidate")).json()).data);
    assert.ok(candidate.bvid.startsWith("BV"));
    const missingLogin = await context.request.post(new URL("/api/gatcha/uids/preview",bootstrap).href,{data:{uid:"123"}});
    assert.equal((await missingLogin.json()).code,"missing_cookie");
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(directory,"library-host.png")});
    console.log(JSON.stringify({passed:true,sharedSearchFixture:true,hostSources221:true,remotePagination221:true,nativeRandom:true,settingsPersisted:true,networkImportsRequireLogin:true,onlineD1Requests:0,errors}));
  } catch (error) {
    if (page) console.log(await page.evaluate(()=>({
      view:state.requestSubview,source:state.sourcesMode,follow:state.followBrowseData?.items?.length,
      favlist:state.favlistBrowseData?.items?.length,search:document.querySelector("#lark-search-message")?.textContent,
      results:document.querySelector("#lark-search-results")?.textContent,
    })).catch(()=>({})));
    throw error;
  } finally {
    if(browser) await browser.close();
    server.stdin.end("stop\n"); lines.close();
    if(server.exitCode===null) await once(server,"exit");
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
