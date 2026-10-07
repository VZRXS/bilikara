"use strict";
// Real relocated native backend/assets; desktop OS bridge and release status
// are fixtures. Rust route/transfer/preparation is covered by native HTTP tests.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),http=require("node:http");
const {spawn}=require("node:child_process"),{once}=require("node:events"),{createInterface}=require("node:readline"),{chromium}=require("playwright");
const [packageDir,evidenceDir]=process.argv.slice(2);
(async()=>{
 const evidence=path.resolve(evidenceDir);await fs.mkdir(evidence,{recursive:true});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"native-update-ui-"));
 const relocated=path.join(root,"package");await fs.cp(path.resolve(packageDir),relocated,{recursive:true});
 const empty=path.join(root,"empty-path");await fs.mkdir(empty);
 const env={...process.env,PATH:empty,BILIKARA_NATIVE_DATA_DIR:path.join(root,"native"),BILIKARA_SHUTDOWN_TOKEN:"fixture-private",HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"127.0.0.1,localhost"};
 const reports=path.join(root,"native","update-logs");
 for(const key of Object.keys(env)) if(/^(PYTHON|BILIKARA_(BILIBILI|DESKTOP|LIBAV)|BB_DOWN|ARIA2C)/.test(key)) delete env[key];
 let server,lines,browser,page,ready;
 const start=async()=>{
  server=spawn(path.join(relocated,"_internal","bilikara-desktop-host"),[],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
  let stderr="";server.stderr.on("data",d=>stderr=(stderr+d).slice(-3000));
  lines=createInterface({input:server.stdout});
  return JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error(stderr);})]));
 };
 try {
  // Enroll an isolated data root through the real Host before adding an update
  // marker. Existing non-native data must continue to be rejected at startup.
  ready=await start();
  const cookie=await new Promise((resolve,reject)=>{
   http.get(ready.bootstrapUrl,{headers:{"sec-fetch-mode":"navigate","sec-fetch-dest":"document"}},response=>{
    response.resume();
    const cookies=response.headers["set-cookie"];
    if(!cookies?.length) return reject(Error(`Bootstrap rejected: ${response.statusCode}`));
    resolve(cookies[0].split(";",1)[0]);
   }).on("error",reject);
  });
  for(const [route,body] of [["/api/session-users/add",{name:"Updater fixture"}],["/api/player/volume",{volume_percent:43}]]) {
   const response=await fetch(ready.baseUrl+route,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify(body)});
   assert.equal(response.status,200);await response.text();
  }
  const firstExit=once(server,"exit");
  await fetch(ready.baseUrl+"/api/app/shutdown",{method:"POST",headers:{"x-bilikara-shutdown-token":"fixture-private"}});
  assert.equal((await firstExit)[0],0);lines.close();ready=null;
  await fs.mkdir(reports,{recursive:true});
  await fs.writeFile(path.join(reports,"last-result.txt"),"operation=update-kept-restart\nresult=installed\nrelaunch=failed\n");
  await fs.writeFile(path.join(reports,"update-kept-restart.log"),"fixture: automatic reopening failed\n");
  ready=await start();
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
  await page.evaluate(()=>setLanguage("zh"));
  await page.locator('[data-session-choice="continue"]').click();
  await page.waitForFunction(()=>state.reportedLastInstall === "update-kept-restart");
  assert.equal(await page.evaluate(()=>state.data.player_settings.volume_percent),43);
  assert.ok((await page.evaluate(()=>state.data.session_users)).includes("Updater fixture"));
  // Pause state polling only for deterministic update presentation fixtures.
  // Rust tests separately assert authoritative route/status/SSE agreement.
  await page.evaluate(()=>{fetchState=async()=>{};});
  await page.locator("#work-rail-settings").click();
  // A kept helper outcome is shown once, with its log, however often status renders.
  const toastText=()=>page.evaluate(()=>{const n=document.getElementById("app-toast");return n.classList.contains("hidden")?"":n.textContent;});
  assert.equal(await page.evaluate(()=>state.data.app_update.last_install.relaunch_failed),true);
  assert.match(await toastText(),/自动重新打开失败/);
  assert.match(await toastText(),/update-kept-restart\.log/);
  await assert.rejects(fs.access(path.join(reports,"last-result.txt")));
  assert.match(await fs.readFile(path.join(reports,"update-kept-restart.log"),"utf8"),/reopening failed/);
  await page.evaluate(()=>{setAppMessage("");renderUpdatePreviewControl();renderUpdatePreviewControl();});
  assert.equal(await toastText(),"");
  await page.evaluate(()=>{state.data.app_update={...state.data.app_update,last_install:{operation:"update-fixture",result:"failed",log:"C:\\bilikara\\runtime\\data\\update-logs\\update-fixture.log"}};renderUpdatePreviewControl();});
  assert.match(await toastText(),/update-fixture\.log/);
  assert.equal(await page.locator("#app-toast").evaluate(n=>n.classList.contains("is-error")),true);
  await page.evaluate(()=>{setAppMessage("");renderUpdatePreviewControl();renderUpdatePreviewControl();});
  assert.equal(await toastText(),"");
  // Installed means file replacement, not a successful automatic restart.
  await page.evaluate(()=>{state.data.app_update={...state.data.app_update,current_version:"v0.8.0-preview.4",last_install:{operation:"update-restart-failed",result:"installed",relaunch_failed:true,log:"C:\\bilikara\\runtime\\data\\update-logs\\update-restart-failed.log"}};renderUpdatePreviewControl();});
  assert.match(await toastText(),/自动重新打开失败/);
  assert.match(await toastText(),/v0\.8\.0-preview\.4/);
  assert.equal(await page.locator("#app-toast").evaluate(n=>n.classList.contains("is-error")),true);
  await page.screenshot({path:path.join(evidence,"restart-failed.png"),mask:[page.locator(".remote-mini-control")]});
  await page.evaluate(()=>{setAppMessage("");renderUpdatePreviewControl();renderUpdatePreviewControl();});
  assert.equal(await toastText(),"");
  await page.evaluate(()=>{
   state.updateAutomaticEnabled=true;state.updatePreviewEnabled=false;
   state.data.app_update={state:"available",operation:6,include_preview:false,updated_at:10,update_action:"normal_upgrade",eligible_update:true,auto_update_supported:true,latest_version:"v0.8.1",message:"Fixture native package available"};renderUpdatePreviewControl();
  });
  await page.locator("#update-check-button").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#update-cancel-button").isVisible(),false);
  // The confirmation uses the UI language, never the Host's untranslated status message.
  await page.evaluate(()=>setLanguage("en"));
  await page.locator("#update-check-button").click();
  const prompt=await page.locator("#confirm-text").textContent();
  assert.equal(prompt,"A desktop update is available. The download is verified as a complete native package before installation; older Python packages cannot be installed. Download the update and restart the service automatically?");
  assert.doesNotMatch(prompt,/[\u3040-\u30ff\u4e00-\u9fff]|Fixture native package/);
  await page.locator("#confirm-ok").click();
  await page.evaluate(()=>setLanguage("zh"));
  await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="start_desktop_update"));
  assert.equal(await page.locator("#update-check-button").isDisabled(),true);
  // Cancel is a compact settings tool beside the update action, not an ordinary 44px control.
  // Measure at rest: the clicked update action is still leaving its hover lift.
  await page.mouse.move(0,0);await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=="running"));
  const tools=await page.evaluate(()=>["update-check-button","update-cancel-button"].map(id=>{const n=document.getElementById(id),s=getComputedStyle(n),r=n.getBoundingClientRect();
   return {height:r.height,radius:s.borderTopLeftRadius,font:`${s.fontSize}/${s.fontWeight}`,padding:`${s.paddingLeft} ${s.paddingRight}`,center:Math.round(r.top+r.height/2)};}));
  assert.deepEqual(tools[1],tools[0]);assert.deepEqual([tools[0].height,tools[0].radius,tools[0].font],[30,"999px","12px/700"]);
  await page.locator("#update-cancel-button").click();await page.waitForFunction(()=>updateBridgeCalls.some(c=>c.name==="cancel_desktop_update"));
  await page.waitForFunction(()=>getComputedStyle(document.getElementById("update-cancel-button")).display==="none");
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
