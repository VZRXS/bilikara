"use strict";
// Real native desktop and Android-host HTTP/AppState with the non-forwarding
// metadata/media/login fixture in run_desktop_rust_host.py. OS bridges are
// fixtures; this is browser evidence, not Android device or OS update evidence.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {spawn}=require("node:child_process"),{once}=require("node:events"),{createInterface}=require("node:readline");
const {chromium}=require("playwright");
const evidence=path.resolve(process.argv[2]);
const token="shared-ui-private-fixture";
(async()=>{
 await fs.mkdir(evidence,{recursive:true});
 const browser=await chromium.launch({headless:true,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toLowerCase().includes("proxy"))),...(process.env.BILIKARA_BROWSER_EXECUTABLE?{executablePath:process.env.BILIKARA_BROWSER_EXECUTABLE}:{}),args:["--autoplay-policy=no-user-gesture-required","--disable-background-networking"]});
 const summaries=[];
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),"shared-host-ui-"));
 try {for(const platform of ["desktop","android"]) {
  const home=path.join(temporary,platform+"-data");
  const exe=path.resolve(platform==="desktop"?"rust-runtime/target/debug/bilikara-desktop-host":"rust-runtime/target/debug/examples/native_host_alpha");
  let child,lines,page,ready,stderr="";
  const launch=async()=>{
   const args=platform==="desktop"?["--data-dir",home,"--static-dir",path.resolve("static")]:[home,path.resolve("static")];
   child=spawn(exe,args,{env:{...process.env,PATH:process.env.BILIKARA_TEST_APPLICATION_PATH,BILIKARA_SHUTDOWN_TOKEN:token},stdio:["pipe","pipe","pipe"]});
   lines=createInterface({input:child.stdout});child.stderr.on("data",d=>stderr=(stderr+d).slice(-2000));
   const info=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(child,"exit").then(()=>{throw Error(stderr);})]));
   ready={url:info.bootstrapUrl || info.bootstrap_url,base:info.baseUrl};
  };
  const stop=async()=>{
   if(child.exitCode===null) {
    if(platform==="desktop") await fetch(ready.base+"/api/app/shutdown",{method:"POST",headers:{"x-bilikara-shutdown-token":token}});
    else child.stdin.end("stop\n");
    const timer=setTimeout(()=>child.kill("SIGKILL"),25000);await once(child,"exit");clearTimeout(timer);
   }
   assert.equal(child.exitCode,0,stderr);lines.close();
  };
  const context=await browser.newContext({viewport:platform==="desktop"?{width:1440,height:1000}:{width:412,height:850},isMobile:platform==="android",hasTouch:platform==="android",locale:"zh-CN"});
  await context.addInitScript(platform=>{
   localStorage.setItem("bilikara.update.automatic","false");
   window.bridgeCalls=[];let saved={layout:"auto",orientation:"system"};
   if(platform==="android") {
    window.BilikaraHostWindow={postMessage(raw){
     if(["enter","exit"].includes(raw))return;
     const {id,action,mode}=JSON.parse(raw);bridgeCalls.push({action,mode});
     if(action==="set-layout")saved.layout=mode;
     if(action==="set-orientation")saved.orientation=mode;
     queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{...saved}})}));
    }};
   } else window.__TAURI__={core:{invoke:async(name,args)=>{
    if(name==="get_host_layout")return saved.layout;
    if(name==="set_host_layout"){saved.layout=args.mode;bridgeCalls.push({name,mode:args.mode});return saved.layout;}
    if(name==="set_window_chrome_theme" || name==="set_window_maximize_region")return;
    throw Error("Unsupported native bridge fixture");
   }}};
  },platform);
  const errors=[],consoleErrors=[],httpErrors=[],counts={};
  context.on("request",r=>{if(r.method()==="POST") {const key=new URL(r.url()).pathname;counts[key]=(counts[key]||0)+1;}});
  await context.route("**/*",route=>{
   const url=new URL(route.request().url());
   // Catalog background status is unrelated to these explicit Host actions.
   // Keep it offline, without triggering configured-source refreshes.
   if(url.pathname==="/api/gatcha/status")return route.fulfill({json:{ok:true,data:{state:"idle",items:[],sources:[]}}});
   return url.hostname==="127.0.0.1"?route.continue():route.abort();
  });
  const open=async()=>{
   page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(["error","warning"].includes(m.type()))consoleErrors.push(m.text());});
   page.on("response",async r=>{if(r.status()>=400){let code;try{code=(await r.json()).code;}catch{}httpErrors.push({path:new URL(r.url()).pathname,status:r.status(),code});}});
   await page.goto(ready.url);await page.waitForFunction(()=>state.hasValidStateResponse && window.BilikaraHostLayout);
   assert.equal(await page.title(),"bilikara host");
  };
  const go=async name=>{
   const phone=await page.evaluate(()=>BilikaraHostLayout.isPortrait());
   if(phone){await page.locator(`[data-android-page="${name==="settings"?"my":name}"]`).click();if(name==="settings")await page.locator("#android-open-settings").click();}
   else {
    if(await page.locator("#cache-panel").isVisible())await page.locator("#cache-settings-toggle").click();
    const panel=page.locator(`#host-workspace-${name}`);
    if(!await panel.isVisible())await page.locator(`#work-rail-${name}`).click();
   }
  };
  const screenshot=async name=>page.screenshot({path:path.join(evidence,platform+"-"+name+".png"),mask:[page.locator(".remote-mini-control"),page.locator("#bbdown-login-panel:visible")]});
  try {
   await launch();
   // Disable configured-source background refresh in the isolated fixture root.
   // Explicit login, metadata, media and search still use the real Rust routes.
   const uidsFile=path.join(home,"gatcha_uids.json");
   const uids=JSON.parse(await fs.readFile(uidsFile,"utf8"));uids.uids=[];uids.profiles={};await fs.writeFile(uidsFile,JSON.stringify(uids));
   await open();
   await go("users");await page.locator("#session-user-input").fill("Shared Fixture");
   const userBefore=counts["/api/session-users/add"]||0;
   await page.locator("#session-user-form button[type=submit]").click();
   await page.waitForFunction(()=>state.data.session_users.includes("Shared Fixture"));
   assert.equal(counts["/api/session-users/add"]-userBefore,1);
   if(platform==="android")await go("my");else await page.locator("#cache-settings-toggle").click();
   // Wide desktop may start its existing QR flow on popover open. Phone My
   // remains idle until the explicit shared login button is pressed.
   if(platform==="android") {
    assert.equal(counts["/api/bbdown/login/start"]||0,0);
    await page.locator("#bbdown-login-button").click();
   }
   await page.waitForFunction(()=>state.data?.bbdown?.login?.logged_in===true,null,{timeout:20000});
   assert.equal(counts["/api/bbdown/login/start"],1);
   await go("request");await page.locator('[data-request-view="quick"]').click();
   await page.locator("#requester-select").selectOption({label:"Shared Fixture"});
   await page.locator("#url-input").fill("https://www.bilibili.com/video/BV1xx411c7mD");
   const addBefore=counts["/api/playlist/add"]||0;
   await page.locator("#add-form button[type=submit]").click();
   await page.waitForFunction(()=>[state.data.current_item,...state.data.playlist].some(i=>i?.bvid==="BV1xx411c7mD"));
   assert.equal(counts["/api/playlist/add"]-addBefore,1);
   await page.waitForFunction(()=>state.data.current_item?.cache_status==="ready",null,{timeout:45000});
   if(platform==="android")await go("playback");
   await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3 || document.querySelector(".split-playback-start-overlay:not(.hidden)"),null,{timeout:20000});
   await page.waitForFunction(()=>Array.from(document.querySelectorAll("video,audio")).every(m=>m.readyState>=2),null,{timeout:20000});
   if(await page.locator(".split-playback-start-button").isVisible())await page.locator(".split-playback-start-button").click();
   await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3,null,{timeout:20000});
   const tray = page.locator("#stage-controls-toggle");
   if(await tray.isVisible() && await tray.getAttribute("aria-expanded")!=="true")await tray.click();
   await page.locator("#key-shift-input").fill("1");await page.locator("#key-shift-input").dispatchEvent("change");
   await page.waitForFunction(()=>state.hostPlaybackSession?.audio?.bilikaraPitch && state.audioContext);
   if(process.env.BILIKARA_TEST_ACTIVE_PITCH === "1") {
    await page.waitForFunction(()=>state.hostPlaybackSession.audio.bilikaraPitch.phase==="active" && state.hostPlaybackSession.audio.bilikaraPitch.applied===1,null,{timeout:20000});
   }
   // Real worklet loading is not stubbed. Some Linux Chromium installations
   // leave addModule pending; report that phase separately from active DSP.

   await page.evaluate(()=>{window.sharedOwnership={video:document.querySelector("video"),audio:document.querySelector("audio"),session:state.hostPlaybackSession,context:state.audioContext,pitch:state.hostPlaybackSession.audio.bilikaraPitch,input:document.querySelector("#url-input")};});
   const ownership=async()=>{
    const snapshot=await page.evaluate(()=>({video:sharedOwnership.video===document.querySelector("video"),audio:sharedOwnership.audio===document.querySelector("audio"),session:sharedOwnership.session===state.hostPlaybackSession,context:sharedOwnership.context===state.audioContext,pitch:sharedOwnership.pitch===state.hostPlaybackSession.audio.bilikaraPitch,input:sharedOwnership.input===document.querySelector("#url-input"),paused:document.querySelector("video").paused}));
    assert.deepEqual(snapshot,{video:true,audio:true,session:true,context:true,pitch:true,input:true,paused:false});
   };
   await go("request");await page.locator('[data-request-view="search"]').click();
   await page.locator("#lark-search-query").fill("Desktop fixture");await page.locator("#lark-search-button").click();
   await page.waitForFunction(()=>document.querySelector("#lark-search-results .search-result-item"));
   await screenshot("search");
   await page.locator('[data-request-view="quick"]').click();await page.locator("#url-input").fill("preserved shared draft");
   await page.locator("#url-input").evaluate(n=>{n.focus();n.setSelectionRange(4,12);});
   for(const [width,height] of platform==="android"?[[844,390],[412,850],[1280,800],[412,850]]:[[1120,800],[1440,1000]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(w=>document.documentElement.dataset.hostLayout===(w<700?"portrait":"landscape"),width);
    assert.equal(await page.locator("#url-input").inputValue(),"preserved shared draft");
    assert.deepEqual(await page.locator("#url-input").evaluate(n=>[n.selectionStart,n.selectionEnd]),[4,12]);
    assert.equal(await page.locator("#url-input").evaluate(n=>document.activeElement===n),true);
    await ownership();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await screenshot("layout-"+width+"x"+height);
   }
   await go("settings");
   for(const mode of ["phone","desktop","phone","auto"]) {
    await page.locator(`[data-android-layout-mode="${mode}"]`).click();
    await page.waitForFunction(m=>document.documentElement.dataset.hostLayoutMode===m,mode);await ownership();
    await go("settings");
   }
   assert.equal(await page.locator("#android-orientation-settings").isVisible(),platform==="android");
   // Existing common settings action, exactly once after repeated reparenting.
   const languageBefore=counts["/api/ui-language"]||0;
   await page.locator('[data-language="en"]').click();await page.waitForFunction(()=>state.language==="en");
   assert.equal(counts["/api/ui-language"]-languageBefore,1);
   await page.locator('[data-language="zh"]').click();await page.waitForFunction(()=>state.language==="zh");
   await page.locator("#update-check-button").scrollIntoViewIfNeeded();
   if(platform==="desktop") {
    await page.locator("#update-check-button").click();
    await page.waitForFunction(()=>state.data.app_update?.state==="available",null,{timeout:25000});
    assert.equal(await page.locator("#update-check-button").isDisabled(),false);
   } else {
    // APK result projection is a UI fixture, system signature/consent tests live
    // in HostUpdate. No Android package is downloaded or installed here.
    await page.evaluate(()=>{state.data.app_update={state:"available",include_preview:false,update_action:"normal_upgrade",eligible_update:true,auto_update_supported:false,latest_version:"v0.8.1",message:"Fixture APK requires signed package"};state.updateManualVisibleChannel="stable";renderUpdatePreviewControl();});
    await page.locator("#update-check-button").click();assert.equal(new URL(page.url()).pathname,"/");
   }
   await screenshot("settings");await ownership();
   const pitchPhase = await page.evaluate(()=>state.hostPlaybackSession.audio.bilikaraPitch.phase);
   assert.ok(["loading","active"].includes(pitchPhase),pitchPhase);

   await page.close();await stop();
   // A genuine persisted restart invokes the same native session dialog on both.
   await launch();await open();await page.locator("#android-session-choice").waitFor({state:"visible"});
   await screenshot("session-choice");const before=counts["/api/session/startup-choice"]||0;
   await page.locator('[data-session-choice="continue"]').click();
   await page.locator("#android-session-choice").waitFor({state:"hidden"});
   assert.equal(counts["/api/session/startup-choice"]-before,1);
   assert.equal(await page.evaluate(()=>state.data.session_users.includes("Shared Fixture")),true);
   assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
   summaries.push({platform,passed:true,counts,consoleErrors,osBridge:"fixture",renderedLayouts:true,persistentMedia:true,pitchOwnerPreserved:true,pitchPhase,persistentSession:true});
  } catch(error){if(page){await screenshot("failed").catch(()=>{});console.error(JSON.stringify(await page.evaluate(()=>({phase:state.hostPlaybackSession?.phase,start:state.localPlaybackStartState,media:Array.from(document.querySelectorAll("video,audio")).map(m=>({type:m.tagName,time:m.currentTime,ready:m.readyState,paused:m.paused,error:m.error?.code}))})).catch(()=>({}))),JSON.stringify({platform,errors,consoleErrors,httpErrors}));}throw error;}
  finally {await context.close();if(child?.exitCode===null)await stop();}
 }} finally {await browser.close();await fs.rm(temporary,{recursive:true,force:true});}
 await fs.writeFile(path.join(evidence,"shared-ui-summary.json"),JSON.stringify(summaries,null,2));
 console.log("PASS shared desktop/Android native Host UI, layout, media ownership, login, requests, settings, updates and persisted session");
})().catch(error=>{console.error(error);process.exitCode=1;});
