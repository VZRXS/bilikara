"use strict";
// Real relocated native backend/assets; desktop OS bridge and release status
// are fixtures. Rust route/transfer/preparation is covered by native HTTP tests.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {spawn}=require("node:child_process"),{once}=require("node:events"),{createInterface}=require("node:readline"),{chromium}=require("playwright");
const [packageDir,evidenceDir]=process.argv.slice(2);
(async()=>{
 const evidence=path.resolve(evidenceDir);await fs.mkdir(evidence,{recursive:true});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"native-update-ui-"));
 const relocated=path.join(root,"package");await fs.cp(path.resolve(packageDir),relocated,{recursive:true});
 const empty=path.join(root,"empty-path");await fs.mkdir(empty);
 const env={...process.env,PATH:empty,BILIKARA_NATIVE_DATA_DIR:path.join(root,"native"),BILIKARA_SHUTDOWN_TOKEN:"fixture-private",HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"127.0.0.1,localhost"};
 for(const key of Object.keys(env)) if(/^(PYTHON|BILIKARA_(BILIBILI|DESKTOP|LIBAV)|BB_DOWN|ARIA2C)/.test(key)) delete env[key];
 const server=spawn(path.join(relocated,"bilikara-desktop-host"),[],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
 let stderr="";server.stderr.on("data",d=>stderr=(stderr+d).slice(-3000));
 const lines=createInterface({input:server.stdout});let browser,page,ready;
 try {
  ready=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error(stderr);})]));
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{
   localStorage.setItem("bilikara.update.automatic","false");
   window.updateBridgeCalls=[];
   window.__TAURI__={core:{invoke:async(name,args)=>{
    if(name === "get_host_layout") return "auto";
    updateBridgeCalls.push({name,args});
    if(name==="start_desktop_update") return {state:"downloading",operation:7,cancellable:true,include_preview:false};
    if(name==="cancel_desktop_update") return {state:"idle",requires_recheck:true,message:"Fixture update cancelled"};
    if(name==="open_external_web_url" || name==="apply_desktop_update") return {};
    throw Error("Unavailable fixture command");
   }}};
  });
  await context.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
  page=await context.newPage();const errors=[],consoleMessages=[];page.on("pageerror",e=>errors.push(e.message));
  page.on("console",m=>{if(["error","warning"].includes(m.type())) consoleMessages.push({type:m.type(),message:m.text()});});
  await page.goto(ready.bootstrapUrl);await page.waitForFunction(()=>state.hasValidStateResponse);
  assert.equal(await page.title(),"bilikara host");assert.equal(new URL(page.url()).pathname,"/");
  // Pause state polling only for deterministic update presentation fixtures.
  // Rust tests separately assert authoritative route/status/SSE agreement.
  await page.evaluate(()=>{fetchState=async()=>{};});
  await page.locator("#work-rail-settings").click();
  await page.evaluate(()=>{
   state.updateAutomaticEnabled=true;state.updatePreviewEnabled=false;
   state.data.app_update={state:"available",operation:6,include_preview:false,updated_at:10,update_action:"normal_upgrade",eligible_update:true,auto_update_supported:true,latest_version:"v0.8.1",message:"Fixture native package available"};renderUpdatePreviewControl();
  });
  await page.locator("#update-check-button").scrollIntoViewIfNeeded();
  await page.locator("#update-check-button").click();await page.locator("#confirm-ok").click();
  await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="start_desktop_update"));
  assert.equal(await page.locator("#update-check-button").isDisabled(),true);
  await page.locator("#update-cancel-button").click();await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="cancel_desktop_update"));
  await page.evaluate(()=>{
   state.data.app_update={state:"available",include_preview:false,updated_at:11,update_action:"normal_upgrade",eligible_update:true,auto_update_supported:false,latest_version:"v0.8.1",release_url:"https://github.com/VZRXS/bilikara/releases/tag/v0.8.1"};renderUpdatePreviewControl();
  });
  await page.locator("#update-check-button").click();await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="open_external_web_url"));assert.equal(new URL(page.url()).pathname,"/");
  await page.evaluate(()=>{state.data.app_update={...state.data.app_update,state:"prepared",operation:8,cancellable:true,message:"Fixture native package prepared"};renderUpdatePreviewControl();renderUpdatePreviewControl();});
  await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="apply_desktop_update"));
  const calls=await page.evaluate(()=>updateBridgeCalls.filter(c=>["start_desktop_update","cancel_desktop_update","apply_desktop_update","open_external_web_url"].includes(c.name)));
  for(const name of ["start_desktop_update","cancel_desktop_update","apply_desktop_update","open_external_web_url"]) assert.equal(calls.filter(c=>c.name===name).length,1);
  await page.screenshot({path:path.join(evidence,"desktop-update.png"),mask:[page.locator(".remote-mini-control")]});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,"summary.json"),JSON.stringify({passed:true,viewport:[1440,1000],bridge:"fixture",backend:"real relocated release Rust Host",calls,consoleErrors:errors,consoleMessages},null,2));
 } catch(error) {if(page)await page.screenshot({path:path.join(evidence,"failed.png")}).catch(()=>{});throw error;}
 finally {
  if(browser)await browser.close();
  if(ready)await fetch(ready.baseUrl+"/api/app/shutdown",{method:"POST",headers:{"x-bilikara-shutdown-token":"fixture-private"}}).catch(()=>{});
  if(server.exitCode===null){const timer=setTimeout(()=>server.kill("SIGKILL"),25000);await once(server,"exit");clearTimeout(timer);}
  lines.close();await fs.rm(root,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
