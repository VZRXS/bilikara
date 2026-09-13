"use strict";
const assert=require("node:assert/strict"), {spawn}=require("node:child_process"), {once}=require("node:events");
const {createInterface}=require("node:readline"), fs=require("node:fs/promises"), path=require("node:path");
const {chromium}=require("playwright");
const [exe,directory,video,audio,executablePath]=process.argv.slice(2);
(async()=>{
  await fs.mkdir(directory,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath});
  let server,lines,context,page,url;
  async function stop(){if(context)await context.close();if(server){lines.close();server.stdin.end("stop\n");if(server.exitCode===null)await once(server,"exit");server=null;}}
  async function boot(fixture){
    server=spawn(exe,[path.resolve(directory),path.resolve("static"),...(fixture?[video,audio]:[])],{stdio:["pipe","pipe","pipe"]});
    server.stderr.on("data",()=>{});lines=createInterface({input:server.stdout});
    url=JSON.parse((await once(lines,"line"))[0]).bootstrap_url;
    context=await browser.newContext({viewport:{width:392,height:817},locale:"zh-CN",isMobile:true,hasTouch:true});
    await context.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
    page=await context.newPage();await page.goto(url);await page.waitForFunction(()=>state.data?.session_flags);
  }
  const get=async api=>{const response=await context.request.get(new URL(api,url).href);return {status:response.status(),body:await response.json()};};
  try{
    await boot(true);
    const before=(await get("/api/playlist/export-data?source=played")).body.data.rows;
    assert.equal(before.length,1);
    await stop();await boot(false);
    await page.locator('[data-session-choice="new"]').click();
    await page.waitForFunction(()=>!state.data.session_flags.startup_choice_pending);
    assert.deepEqual(await page.evaluate(()=>state.data.session_users),[]);
    assert.deepEqual((await get("/api/playlist/export-data?source=played")).body.data.rows,[]);
    const archives=(await get("/api/played-sessions")).body.data;
    assert.equal(archives.length,1);assert.equal(archives[0].count,1);
    const source=archives[0].id;
    assert.deepEqual((await get(`/api/playlist/export-data?source=${encodeURIComponent(source)}`)).body.data.rows,before);
    assert.equal((await get("/api/playlist/export-data?source=..%2fhost-state.json")).status,400);
    assert.equal((await get("/api/playlist/export-data?source=played-missing.json")).status,404);
    assert.equal(await page.evaluate(()=>fetchPlayedSessions()),true);
    assert.ok(await page.evaluate(source=>Array.from(elements.confirmSource.options).some(option=>option.value===source),source));
    await stop();await boot(false);
    assert.deepEqual((await get("/api/played-sessions")).body.data,archives);
    assert.deepEqual((await get(`/api/playlist/export-data?source=${encodeURIComponent(source)}`)).body.data.rows,before);
    console.log(JSON.stringify({passed:true,newSessionArchives:true,persistedAcrossRestarts:true,exportSourceSelector:true,pathValidation:true}));
  }finally{await stop();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
