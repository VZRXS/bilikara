"use strict";
// Real native desktop and Android-host HTTP/AppState with the non-forwarding
// metadata/media/login fixture in run_desktop_rust_host.mjs. OS bridges are
// fixtures; this is browser evidence, not Android device or OS update evidence.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {spawn}=require("node:child_process"),{once}=require("node:events"),{createInterface}=require("node:readline");
const {chromium,firefox,webkit}=require("playwright");
// Use a codec-capable installed browser; neither path changes the served CSP
// or mocks Signalsmith. Active DSP can be required with BILIKARA_TEST_ACTIVE_PITCH.
const browserName=process.env.BILIKARA_TEST_BROWSER || "webkit";
assert.ok(["chromium","firefox","webkit"].includes(browserName));
const evidence=path.resolve(process.argv[2]);
const token="shared-ui-private-fixture";
(async()=>{
 await fs.mkdir(evidence,{recursive:true});
 const browser=await ({chromium,firefox,webkit}[browserName]).launch({headless:true,env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toLowerCase().includes("proxy"))),...(process.env.BILIKARA_BROWSER_EXECUTABLE?{executablePath:process.env.BILIKARA_BROWSER_EXECUTABLE}:{}),...(browserName==="firefox"?{firefoxUserPrefs:{"browser.chrome.site_icons":false,"browser.chrome.favicons":false}}:browserName==="chromium"?{args:["--autoplay-policy=no-user-gesture-required","--disable-background-networking"]}:{})});
 const summaries=[];
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),"shared-host-ui-"));
 try {for(const platform of ["desktop","android"]) {
  const home=path.join(temporary,platform+"-data");
  const exe=platform==="desktop"?process.env.BILIKARA_TEST_NATIVE_HOST:process.env.BILIKARA_TEST_NATIVE_ALPHA;
  assert.ok(path.isAbsolute(exe||""),"current Cargo-selected native Host artifact is required");
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
  const context=await browser.newContext({viewport:platform==="desktop"?{width:1440,height:1000}:{width:412,height:850},...(browserName==="chromium"?{isMobile:platform==="android"}:{}),hasTouch:platform==="android",locale:"zh-CN"});
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
  const errors=[],consoleErrors=[],browserWarnings=[],httpErrors=[],counts={};
  context.on("request",r=>{if(r.method()==="POST") {const key=new URL(r.url()).pathname;counts[key]=(counts[key]||0)+1;}});
  await context.route("**/*",route=>{
   const url=new URL(route.request().url());
   // Catalog background status is unrelated to these explicit Host actions.
   // Keep it offline, without triggering configured-source refreshes.
   if(url.pathname==="/api/gatcha/status")return route.fulfill({json:{ok:true,data:{state:"idle",items:[],sources:[]}}});
   return url.hostname==="127.0.0.1"?route.continue():route.abort();
  });
  const open=async()=>{
   page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{if(m.text()==='Viewport argument key "interactive-widget" not recognized and ignored.')browserWarnings.push(m.text());else if(["error","warning"].includes(m.type()))consoleErrors.push(m.text());});
   page.on("response",async r=>{if(r.status()>=400){let code;try{code=(await r.json()).code;}catch{}httpErrors.push({path:new URL(r.url()).pathname,status:r.status(),code});}});
   await page.goto(ready.url);await page.waitForFunction(platform=>typeof state!=="undefined" && state.hasValidStateResponse && (platform==="desktop"?document.documentElement.dataset.hostLayout==="landscape":Boolean(window.BilikaraHostLayout)),platform);
   assert.equal(await page.title(),"bilikara host");
  };
  const go=async name=>{
   const tray=page.locator('#stage-controls-toggle');
   if(await tray.isVisible() && await tray.getAttribute('aria-expanded')==='true')await page.locator('#stage-controls-close').click();
   const phone=platform==="android" && await page.evaluate(()=>BilikaraHostLayout.isPortrait());
   if(phone){
    if(name==='settings' && await page.locator('#host-workspace-settings').isVisible())return;
    await page.locator(`[data-android-page="${name==="settings"?"my":name}"]`).click();
    if(name==="settings")await page.locator("#android-open-settings").click();
   }
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
   for(const name of ["Layout Two","Layout Three"]) {
    await page.locator("#session-user-input").fill(name);
    await page.locator("#session-user-form button[type=submit]").click();
    await page.waitForFunction(name=>state.data.session_users.includes(name),name);
   }
   const sharedUser=page.locator('.session-user-badge[data-name="Shared Fixture"]');
   await page.evaluate(()=>{
    const badge=document.querySelector('.session-user-badge[data-name="Shared Fixture"]');
    window.sharedComponents={badge,toggle:badge.querySelector('.session-user-name'),actions:badge.querySelector('.android-user-actions'),
     account:document.querySelector('#host-account-settings'),delayParent:document.querySelector('#advance-delay-field').parentElement,
     sourceParent:document.querySelector('#cache-source-row').parentElement};
   });
   const componentViews=[];
   await page.locator('#session-user-input').fill('preserved user draft');
   await page.locator('#session-user-input').evaluate(e=>{e.focus();e.setSelectionRange(2,8);});
   for(const [requestedWidth,height] of [[1280,900],[800,900],[390,850],[390,320],[1280,900]]) {
    const width=platform==="desktop"?Math.max(700,requestedWidth):requestedWidth;
    await page.setViewportSize({width,height});
    await page.waitForFunction(({platform,width})=>platform==="android"?BilikaraHostLayout.isPortrait()===(width<700):document.documentElement.dataset.hostLayout==="landscape",{platform,width});
    await sharedUser.waitFor({state:'visible'});
    assert.equal(await page.locator('#session-user-input').inputValue(),'preserved user draft');
    assert.deepEqual(await page.locator('#session-user-input').evaluate(e=>[e.selectionStart,e.selectionEnd,document.activeElement===e]),[2,8,true]);
    const view=await page.evaluate(()=>{
     const c=sharedComponents,badge=document.querySelector('.session-user-badge[data-name="Shared Fixture"]'),style=getComputedStyle(badge);
     return {same:c.badge===badge&&c.toggle===badge.querySelector('.session-user-name')&&c.actions===badge.querySelector('.android-user-actions')
      &&c.account===document.querySelector('#host-account-settings')&&c.delayParent===document.querySelector('#advance-delay-field').parentElement
      &&c.sourceParent===document.querySelector('#cache-source-row').parentElement,
      toggle:badge.querySelector('.session-user-name').tagName,actions:[...badge.querySelectorAll('[data-user-action]')].map(b=>[b.dataset.userAction,b.getAttribute('aria-label')]),
      background:style.backgroundColor,color:style.color,overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    assert.equal(view.same,true,'Responsive layout must not reconstruct user controls or cache fields');
    assert.equal(view.toggle,'SPAN');assert.equal(view.overflow,false);
    assert.equal(await sharedUser.locator('.session-user-name').getAttribute('role'),'button');
    assert.equal(await sharedUser.locator('.session-user-name').getAttribute('tabindex'),'0');
    assert.deepEqual(view.actions,[['up','上移'],['down','下移'],['remove','删除']]);
    componentViews.push({width,height,...view});
    if(height===320) {
     const neighbor=page.locator('.session-user-badge[data-name="Layout Two"]');
     const neighborHeight=(await neighbor.boundingBox()).height;
     const coarse=await page.evaluate(()=>state.sessionUserEditor.coarse);
     if(!coarse)await page.locator('.session-user-mode-button[data-mode="rename"]').click();
     await sharedUser.locator('.session-user-name').click({timeout:5000});
     if(coarse)assert.equal(await sharedUser.locator('.session-user-name').getAttribute('aria-expanded'),'true');
     else await page.locator('.session-user-rename-panel').waitFor({state:'visible'});
     assert.ok(Math.abs((await neighbor.boundingBox()).height-neighborHeight)<1,'Opening one user must not stretch neighboring badges');
     await screenshot('short-viewport-user-actions');
     if(coarse)await sharedUser.locator('.session-user-name').click();
     else {
      await page.locator('.session-user-rename-panel .banner-close').click();
      await page.locator('.session-user-mode-button[data-mode="rename"]').click();
     }
     await page.locator('#session-user-input').evaluate(e=>{e.focus();e.setSelectionRange(2,8);});
    }
    await screenshot('shared-users-'+width+'x'+height);
   }
   await page.locator('#session-user-input').clear();
   const coarse=await page.evaluate(()=>state.sessionUserEditor.coarse);
   if(coarse)await sharedUser.locator('.session-user-name').click();
   else assert.equal(await sharedUser.getAttribute('draggable'),'true','fine pointers use the accepted drag control');
   const down=sharedUser.locator('[data-user-action="down"]');
   const move=async action=>{
    if(coarse)await sharedUser.locator(`[data-user-action="${action}"]`).click();
    else await sharedUser.dragTo(page.locator(`.session-user-badge[data-name="${action==='down'?'Layout Three':'Layout Two'}"]`),{targetPosition:{x:8,y:18}});
   };
   let resumeReorder;
   const reorderGate=new Promise(resolve=>{resumeReorder=resolve;});
   await page.route('**/api/session-users/edit',async route=>{await reorderGate;await route.continue();},{times:1});
   const reorderBefore=counts['/api/session-users/edit']||0;
   await move('down');await page.keyboard.press('Enter');
   assert.equal(await page.locator('.session-user-tools').getAttribute('aria-busy'),'true');
   assert.equal(counts['/api/session-users/edit']-reorderBefore,1);
   await page.setViewportSize({width:platform==='desktop'?700:390,height:850});await go('users');
   assert.equal(await down.isDisabled(),true);
   assert.equal(await page.evaluate(()=>sharedComponents.actions===document.querySelector('.session-user-badge[data-name="Shared Fixture"] .android-user-actions')),true);
   resumeReorder();
   await page.waitForFunction(()=>!state.sessionUserEditor.busy&&state.data.session_users[1]==='Shared Fixture');
   assert.equal(await page.locator('.session-user-tools').getAttribute('aria-busy'),null);
   // A service-error response is a local browser transport fixture; retry then
   // uses the real native route. No production endpoint is contacted.
   await page.route('**/api/session-users/edit',route=>route.fulfill({json:{ok:false,error:'Fixture reorder retry'}}),{times:1});
   const up=sharedUser.locator('[data-user-action="up"]');await move('up');
   await page.waitForFunction(()=>!state.sessionUserEditor.busy);
   await page.locator('.app-toast.is-error:not(.hidden)').filter({hasText:'Fixture reorder retry'}).waitFor({state:'visible'});
   assert.equal(await up.isDisabled(),false);assert.equal(await page.locator('.session-user-tools').getAttribute('aria-busy'),null);
   assert.equal(await page.evaluate(()=>state.data.session_users[1]),'Shared Fixture');
   await move('up');await page.waitForFunction(()=>!state.sessionUserEditor.busy&&state.data.session_users[0]==='Shared Fixture');
   assert.equal(counts['/api/session-users/edit']-reorderBefore,3);
   await page.setViewportSize(platform==='desktop'?{width:1440,height:1000}:{width:412,height:850});
   await go('users');
   // Common rail definitions feed compact labels/icons without duplicate IDs.
   const compactShared=await page.evaluate(()=>{
    const geometry=icon=>{
     const copy=icon.cloneNode(true);
     for(const [index,definition] of [...copy.querySelectorAll('[id]')].entries()) {
      const original=definition.id;definition.id=`shared-definition-${index}`;
      for(const reference of copy.querySelectorAll('[mask]'))if(reference.getAttribute('mask')===`url(#${original})`)reference.setAttribute('mask',`url(#${definition.id})`);
     }
     return copy.innerHTML;
    };
    return [...document.querySelectorAll('[data-shared-workspace]')].every(link=>{
    const source=document.querySelector(`[data-host-workspace="${link.dataset.sharedWorkspace}"]`);
    return link.textContent.trim()===source.querySelector('.work-rail-label').textContent.trim()
     &&(!link.hasAttribute('data-workspace-icon')||geometry(link.querySelector('svg'))===geometry(source.querySelector('svg')));
   });});
   if(platform==='android') assert.equal(compactShared,true,'Android compact actions reuse the shared rail labels and icons');
   else {
    assert.equal(await page.locator('#android-host-dock').isVisible(),false);
    assert.deepEqual(await page.locator('.work-rail-label').allTextContents(),['队列','历史','点歌','试试运气','本场用户','设置']);
    assert.equal(await page.locator('.work-rail-icon .work-rail-icon-fill').count(),6);
   }
   assert.equal(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);return new Set(ids).size===ids.length;}),true);
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
   await page.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted && state.hostPlaybackSession.playbackGeneration===state.data.playback_generation);
   const tray = page.locator("#stage-controls-toggle");
   if(await tray.isVisible() && await tray.getAttribute("aria-expanded")!=="true")await tray.click();
   const keyShiftResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/player/key-shift' && response.request().method()==='POST');
   assert.equal(await page.evaluate(()=>state.data.player_settings.key_shift),0);
   await page.locator('#key-shift-inc-button').click(); // real activation permits Web Audio
   assert.equal((await keyShiftResponse).status(),200);
   await page.waitForFunction(()=>state.data.player_settings.key_shift===1 && document.querySelector('#key-shift-inc-button').getAttribute('aria-busy')!=='true' && state.hostPlaybackSession?.readyCommitted);
   await page.waitForFunction(()=>state.hostPlaybackSession?.audio?.bilikaraPitch && state.audioContext);
   if(process.env.BILIKARA_TEST_ACTIVE_PITCH === "1") {
    await page.waitForFunction(()=>state.hostPlaybackSession.audio.bilikaraPitch.phase==="active" && state.hostPlaybackSession.audio.bilikaraPitch.applied===1,null,{timeout:20000});
   }
   // Real worklet loading is not stubbed. Some Linux Chromium installations
   // leave addModule pending; report that phase separately from active DSP.

   await page.evaluate(()=>{const video=document.querySelector("video"),audio=document.querySelector("audio");window.sharedOwnership={video,audio,videoParent:video.parentElement,audioParent:audio.parentElement,videoSrc:video.currentSrc,audioSrc:audio.currentSrc,startTime:video.currentTime,session:state.hostPlaybackSession,generation:state.data.playback_generation,program:JSON.stringify(state.data.playback_program),context:state.audioContext,pitch:state.hostPlaybackSession.audio.bilikaraPitch,input:document.querySelector("#url-input")};});
   const ownership=async()=>{
    const snapshot=await page.evaluate(()=>({video:sharedOwnership.video===document.querySelector("video"),audio:sharedOwnership.audio===document.querySelector("audio"),session:sharedOwnership.session===state.hostPlaybackSession,context:sharedOwnership.context===state.audioContext,pitch:sharedOwnership.pitch===state.hostPlaybackSession.audio.bilikaraPitch,input:sharedOwnership.input===document.querySelector("#url-input"),paused:document.querySelector("video").paused}));
    assert.deepEqual(snapshot,{video:true,audio:true,session:true,context:true,pitch:true,input:true,paused:false});
    assert.equal(await page.evaluate(()=>sharedOwnership.videoParent===sharedOwnership.video.parentElement&&sharedOwnership.audioParent===sharedOwnership.audio.parentElement&&sharedOwnership.videoSrc===sharedOwnership.video.currentSrc&&sharedOwnership.audioSrc===sharedOwnership.audio.currentSrc),true,'Layout must preserve the connected media parents and sources');
   };
   await ownership();
   await go("request");await page.locator('[data-request-view="search"]').click();
   await page.locator("#lark-search-query").fill("Desktop fixture");await page.locator("#lark-search-button").click();
   await page.waitForFunction(()=>document.querySelector("#lark-search-results .search-result-item"));
   await screenshot("search");
   await ownership();
   if(await page.locator('[data-request-back]:visible').count())await page.locator('[data-request-back]:visible').click();
   else await page.locator('[data-request-view="quick"]').click();
   await page.locator("#url-input").fill("preserved shared draft");
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
   assert.equal(await page.locator('[data-android-layout-mode]').count(),0);
   for(const width of [412,1440,412,1440]) {
    await page.setViewportSize({width,height:1000});
    await page.waitForFunction(({platform,width})=>platform==="android"?BilikaraHostLayout.isPortrait()===(width<700):document.documentElement.dataset.hostLayout==="landscape",{platform,width});await ownership();
    assert.equal(await page.locator('html').getAttribute('data-host-layout-mode'),platform==="android"?'auto':null);
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
   await page.waitForFunction(()=>sharedOwnership.video.currentTime>sharedOwnership.startTime+0.5);
   const pitchPhase = await page.evaluate(()=>state.hostPlaybackSession.audio.bilikaraPitch.phase);
   assert.ok(["loading","active"].includes(pitchPhase),pitchPhase);

   await page.close();await stop();
   // A genuine persisted restart uses the shared banner, without a modal backdrop.
   await launch();await open();await page.locator("#native-session-choice").waitFor({state:"visible"});
   assert.deepEqual(await page.locator("#native-session-choice").evaluate(node=>({
    tag:node.tagName,region:node.parentElement.id,banner:node.classList.contains("backup-banner"),
    modal:document.querySelector("dialog[open]")!==null,
   })),{tag:"SECTION",region:"critical-banner-region",banner:true,modal:false});
   await page.waitForFunction(()=>getComputedStyle(document.querySelector("#native-session-choice")).opacity==="1");
   assert.equal(await page.locator("#native-session-choice").evaluate(node=>{
    const style=getComputedStyle(node),shared=getComputedStyle(document.querySelector("#backup-banner"));
    return node.getBoundingClientRect().top<100 && style.backgroundColor===shared.backgroundColor
     && style.transitionDuration===shared.transitionDuration
     && getComputedStyle(node.querySelector(".backup-text")).fontSize===getComputedStyle(document.querySelector("#backup-text")).fontSize;
   }),true);
   await page.keyboard.press("Escape");
   assert.equal(await page.locator("#native-session-choice").isVisible(),true);
   const countdown=page.locator("#native-session-dismiss [data-session-countdown]");
   assert.equal(await page.locator("#native-session-choice .next-button").count(),0);
   await page.waitForFunction(()=>Number(document.querySelector("[data-session-countdown]").textContent)<10);
   await page.locator("#native-session-choice").hover();
   const pausedCountdown=await countdown.textContent();
   await page.waitForTimeout(1200);
   assert.equal(await countdown.textContent(),pausedCountdown);
   assert.equal(await page.locator("#native-session-dismiss .close-icon").isVisible(),true);
   // Frequent state/layout renders must neither reset nor resume a paused timer.
   await page.evaluate(()=>{for(let n=0;n<5;n++)render();});
   assert.equal(await countdown.textContent(),pausedCountdown);
   await screenshot("session-choice");const before=counts["/api/session/startup-choice"]||0;
   await page.mouse.move(0,200);
   await page.waitForFunction(previous=>Number(document.querySelector("[data-session-countdown]").textContent)<Number(previous),pausedCountdown);
   let releaseChoice;
   const choiceGate=new Promise(resolve=>{releaseChoice=resolve;});
   await page.route("**/api/session/startup-choice",async route=>{await choiceGate;await route.continue();});
   await page.locator('[data-session-choice="continue"]').click();
   assert.equal(await page.locator('[data-session-choice="continue"]').getAttribute("aria-busy"),"true");
   assert.equal(await page.locator('[data-session-choice="new"]').isDisabled(),true);
   await page.locator('[data-session-choice="continue"]').evaluate(button=>{button.click();button.click();});
   releaseChoice();
   await page.locator("#native-session-choice").waitFor({state:"hidden"});
   assert.equal(counts["/api/session/startup-choice"]-before,1);
   assert.equal(await page.evaluate(()=>state.data.session_users.includes("Shared Fixture")),true);
   const savedVolume=await page.evaluate(()=>state.data.player_settings.volume_percent);
   await page.close();await stop();await launch();await open();
   await page.locator("#native-session-choice").waitFor({state:"visible"});
   await page.locator('[data-session-choice="new"]').click();
   await page.locator("#native-session-choice").waitFor({state:"hidden"});
   assert.deepEqual(await page.evaluate(()=>state.data.session_users),[]);
   assert.equal(await page.evaluate(()=>state.data.player_settings.volume_percent),savedVolume);
   assert.equal(counts["/api/session/startup-choice"]-before,2);

   // An ignored banner resolves through the native command after ten seconds.
   // If that command fails, retain the saved session and wait for a user retry.
   await page.evaluate(()=>apiPostStateSnapshot("/api/session-users/add",{name:"Timed fixture"}));
   await page.close();await stop();await launch();await open();
   await page.locator("#native-session-choice").waitFor({state:"visible"});
   let attemptedChoices=0;
   await page.route("**/api/session/startup-choice",async route=>{
    attemptedChoices++;
    assert.equal(route.request().postDataJSON().choice,"new");
    if(attemptedChoices===1)return route.fulfill({json:{ok:false,error:"Offline choice failure fixture"}});
    await route.continue();
   });
   await page.mouse.move(0,200);
   await page.waitForFunction(()=>document.querySelector("#native-session-choice-error").textContent.includes("Offline choice failure fixture"),null,{timeout:15000});
   assert.equal(attemptedChoices,1);
   assert.deepEqual(await page.evaluate(()=>state.data.session_users),["Timed fixture"]);
   assert.equal(await page.locator("#native-session-dismiss").isEnabled(),true);
   await page.waitForTimeout(1200);
   assert.equal(attemptedChoices,1,"Failed timeout must not retry automatically");
   await page.locator("#native-session-dismiss").click();
   await page.locator("#native-session-choice").waitFor({state:"hidden"});
   assert.equal(attemptedChoices,2);
   assert.deepEqual(await page.evaluate(()=>state.data.session_users),[]);
   assert.equal(await page.evaluate(()=>state.data.player_settings.volume_percent),savedVolume);
   assert.equal(counts["/api/session/startup-choice"]-before,4);
   assert.deepEqual(errors,[]);assert.deepEqual(consoleErrors,[]);
   summaries.push({platform,passed:true,counts,consoleErrors,browserWarnings,osBridge:"fixture",renderedLayouts:true,componentViews,sharedUserActions:true,sharedNavigation:true,persistentMedia:true,pitchOwnerPreserved:true,pitchPhase,persistentSession:true,countdownPauseResume:true,closeStartsNew:true,timeoutAndRetry:true});
   await fs.writeFile(path.join(evidence,platform+'-completed.json'),JSON.stringify(summaries.at(-1),null,2));
  } catch(error){if(page){await screenshot("failed").catch(()=>{});console.error(JSON.stringify(await page.evaluate(()=>({phase:state.hostPlaybackSession?.phase,start:state.localPlaybackStartState,bootstrap:state.hostPlaybackBootstrapRestartPending,pageHidden:state.pageHidePlaybackRestartRequired,generation:state.data.playback_generation,program:JSON.stringify(state.data.playback_program),current:state.data.current_item&&{id:state.data.current_item.id,status:state.data.current_item.cache_status,artifact:state.data.current_item.artifact_set_id,url:state.data.current_item.video_media_url},savedMedia:window.sharedOwnership&&{time:sharedOwnership.video.currentTime,duration:sharedOwnership.video.duration,error:sharedOwnership.video.error?.code,connected:sharedOwnership.video.isConnected,generation:sharedOwnership.generation,program:sharedOwnership.program},media:Array.from(document.querySelectorAll("video,audio")).map(m=>({type:m.tagName,time:m.currentTime,duration:m.duration,ready:m.readyState,paused:m.paused,error:m.error?.code}))})).catch(()=>({}))),JSON.stringify({platform,errors,consoleErrors,httpErrors,counts}));}throw error;}
  finally {await context.close();if(child?.exitCode===null)await stop();}
 }} finally {await browser.close();await fs.rm(temporary,{recursive:true,force:true});}
 assert.deepEqual(summaries[0].componentViews.filter(view=>view.width>=800),summaries[1].componentViews.filter(view=>view.width>=800),'At the same desktop widths native desktop and Android profiles reuse user component structure and base colors');
 await fs.writeFile(path.join(evidence,"shared-ui-summary.json"),JSON.stringify(summaries,null,2));
 console.log("PASS shared desktop/Android native Host UI, layout, media ownership, login, requests, settings, updates and persisted session");
})().catch(error=>{console.error(error);process.exitCode=1;});
