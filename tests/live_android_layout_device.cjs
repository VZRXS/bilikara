"use strict";
// Uses ONLY the disposable task emulator, never the first attached device.
// node tests/live_android_layout_device.cjs OUTPUT_DIR FIXTURE_VIDEO FIXTURE_AUDIO
const assert=require("node:assert/strict");
const {execFileSync}=require("node:child_process");
const path=require("node:path");
const fs=require("node:fs/promises");
const {chromium}=require("playwright");
const directory=path.resolve(process.argv[2]);
const adbPath=path.join(process.env.ANDROID_HOME,"platform-tools","adb.exe");
const device="emulator-5562",app="com.bilikara.app.alpha";
const adb=(...args)=>execFileSync(adbPath,["-s",device,...args],{encoding:"utf8",timeout:20000}).trim();
const delay=()=>new Promise(resolve=>setTimeout(resolve,300));
async function dismissImmersiveTutorial() {
  // First fullscreen can focus a SystemUI tutorial above the WebView. CDP
  // screenshots/clicks cannot see it; Back goes to that window, not the app.
  if(!adb("shell","dumpsys","window").split("\n").some(line=>line.includes("mCurrentFocus=") && line.includes("ImmersiveModeConfirmation"))) return;
  adb("shell","uiautomator","dump","/data/local/tmp/bilikara-layout-window.xml");
  const xml=adb("shell","cat","/data/local/tmp/bilikara-layout-window.xml");
  const ok=/resource-id="com.android.systemui:id\/ok"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  assert.ok(ok,"Only dismiss the known SystemUI full-screen tutorial, never an arbitrary dialog");
  adb("shell","input","tap",String(Math.round((Number(ok[1])+Number(ok[3]))/2)),String(Math.round((Number(ok[2])+Number(ok[4]))/2)));
  for(let i=0;i<30;i++) {
    await delay();
    if(adb("shell","dumpsys","window").split("\n").some(line=>line.includes("mCurrentFocus=") && line.includes(app))) return;
  }
  throw Error("App did not regain focus after the fullscreen tutorial");
}
async function installMedia(context,page) {
  // HTTP-only synthetic state: never write test songs/cache into the native DB.
  const data=await page.evaluate(()=>structuredClone(state.data));
  assert.equal(data.current_item,null);assert.equal(data.playlist.length,0);
  const video=await fs.readFile(process.argv[3]),audio=await fs.readFile(process.argv[4]);
  const item={id:"layout-fixture",item_incarnation_id:"layout-instance",artifact_set_id:"layout-artifact",selected_audio_variant_id:"original",
    title:"Offline layout fixture",display_title:"Offline layout fixture",requester_name:"Fixture",bvid:"",page:1,video_page:1,
    selected_pages:[1],selected_cids:[1],selected_durations:[90],selected_parts:["Original"],
    available_pages:[1],available_cids:[1],available_durations:[90],available_parts:["Original"],
    cache_status:"ready",cache_progress:1,cache_message:"Ready",video_media_url:"/media/layout-fixture/video.mp4",
    audio_variants:[{id:"original",label:"Original",page:1,audio_url:"/media/layout-fixture/audio.m4a"}]};
  data.current_item=item;data.state_revision+=1000;data.revision+=1000;data.playback_generation++;
  data.playback_program={item_id:item.id,item_incarnation_id:item.item_incarnation_id,artifact_set_id:item.artifact_set_id,selected_audio_variant_id:"original"};
  await context.route("**/media/layout-fixture/**",async route=>{
    const bytes=route.request().url().endsWith(".mp4")?video:audio;
    const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||"");
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
    const headers={"Accept-Ranges":"bytes","Content-Type":bytes===video?"video/mp4":"audio/mp4"};
    if(range) headers["Content-Range"]=`bytes ${start}-${end}/${bytes.length}`;
    await route.fulfill({status:range?206:200,headers,body:bytes.subarray(start,end+1)});
  });
  await context.route("**/api/**",route=>route.fulfill({json:{ok:true,data:route.request().url().includes("claim-program")?{claimed:true}:data}}));
  await page.evaluate(()=>fetchState());
  await page.waitForFunction(()=>document.querySelector("video")?.readyState>=2 && document.querySelector("audio")?.readyState>=2);
  // Arrange an explicit play intent for this synthetic scene. Autoplay policy
  // and the native video's own controls are not this window-lifecycle test.
  await page.evaluate(()=>{
    const {video,audio}=activeLocalPlayerElements();
    setSplitPlaybackIntent(video,audio,true,{userGesture:true,source:"layout-fixture-start"});
  });
  await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.2);
}
async function connect() {
  for(let i=0;i<80;i++) {
    try {
      const pid=adb("shell","pidof",app);
      if(pid && adb("shell","cat","/proc/net/unix").includes(`webview_devtools_remote_${pid}`)) {
        adb("forward","tcp:9238",`localabstract:webview_devtools_remote_${pid}`);
        const browser=await chromium.connectOverCDP("http://127.0.0.1:9238",{noDefaults:true});
        const page=browser.contexts()[0].pages().find(p=>new URL(p.url()).pathname==="/");
        if(page) { page.setDefaultTimeout(20000); return {browser,page}; }
        await browser.close();
      }
    } catch {} // Bounded wait while Activity/WebView starts.
    await delay();
  }
  throw Error("Emulator Host did not become available");
}
(async()=>{
  await fs.mkdir(directory,{recursive:true});
  adb("shell","am","start","-W","-n",`${app}/com.bilikara.app.MainActivity`);
  let {browser,page}=await connect();const errors=[];
  let phase="startup";
  const pageError=error=>errors.push({message:error.message,stack:error.stack,phase});
  try {
    page.on("pageerror",pageError);
    await page.waitForFunction(()=>window.BilikaraAndroidLayout?.client && !document.querySelector('button[data-android-layout-mode="auto"]').disabled && state.data);
    phase="layout-and-direction";
    assert.equal(await page.evaluate(()=>Boolean(state.data?.current_item) || (state.data?.playlist?.length || 0)>0),false,"Use an empty disposable emulator; never mutate a user's session");
    await page.evaluate(()=>{window.layoutDeviceSentinel={video:document.querySelector("video"),token:Math.random()};});
    const originalToken=await page.evaluate(()=>layoutDeviceSentinel.token);
    const originalUrl=page.url();
    const verifySame=async()=>assert.equal(await page.evaluate(token=>layoutDeviceSentinel.token===token && layoutDeviceSentinel.video===document.querySelector("video"),originalToken),true);
    const settings=async()=>{
      if(await page.locator("#android-host-dock").isVisible()) {
        await page.locator('[data-android-page="my"]').click();
        await page.locator("#android-open-settings").click();
      } else if(!await page.locator("#android-layout-switch").isVisible()) await page.locator("#work-rail-settings").click();
    };
    await settings();
    const choose=async(field,value)=>{
      await page.locator(`button[data-android-${field}-mode="${value}"]`).click();
      await page.waitForFunction(({field,value})=>document.querySelector(`button[data-android-${field}-mode="${value}"]`).getAttribute("aria-pressed")==="true",{field,value});
    };
    await choose("orientation","landscape");
    await page.waitForFunction(()=>innerWidth>innerHeight && document.documentElement.dataset.androidLayout==="landscape");
    await verifySame();
    assert.equal(await page.locator("#presentation-settings").evaluate(el=>!!el.closest(".topbar")),true);
    await settings();await choose("layout","phone");
    assert.equal(await page.locator("#android-host-dock").isVisible(),true);
    await verifySame();
    await page.screenshot({path:path.join(directory,"native-manual-phone-landscape.png")});
    const persisted=await page.evaluate(()=>BilikaraAndroidLayout.client.load());
    assert.deepEqual(persisted,{layout:"phone",orientation:"landscape"});
    await browser.close();
    adb("shell","am","force-stop",app);
    adb("shell","am","start","-W","-n",`${app}/com.bilikara.app.MainActivity`);
    phase="restart";
    ({browser,page}=await connect());page.on("pageerror",pageError);
    await page.waitForFunction(()=>window.BilikaraAndroidLayout?.client && document.documentElement.dataset.androidLayoutMode==="phone");
    assert.deepEqual(await page.evaluate(()=>BilikaraAndroidLayout.client.load()),persisted);
    assert.equal(await page.evaluate(()=>innerWidth>innerHeight),true);
    await settings();await choose("layout","auto");await settings();await choose("orientation","portrait");
    await page.waitForFunction(()=>innerWidth<innerHeight && document.documentElement.dataset.androidLayout==="portrait");
    await page.locator('[data-android-page="playback"]').click();
    phase="fullscreen-playback";
    await installMedia(browser.contexts()[0],page);
    const touch=await browser.contexts()[0].newCDPSession(page);
    const tapFullscreen=async()=>{
      const button=page.locator("#player-fullscreen-button");
      await button.scrollIntoViewIfNeeded();
      const box=await button.boundingBox();assert.ok(box);
      await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
      await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    };
    for(const exit of ["button","back"]) {
      await tapFullscreen();
      await page.waitForFunction(()=>!!document.fullscreenElement && innerWidth>innerHeight && !state.playerFullscreenTransitioning);
      // Native window-rotation animation is outside the DOM/Playwright's
      // stability check. Let its input surface catch up before a second tap.
      await page.waitForTimeout(500);
      await dismissImmersiveTutorial();
      console.log(`fullscreen exit via ${exit}`);
      if(exit==="button") await tapFullscreen();
      else adb("shell","input","keyevent","4");
      await page.waitForFunction(()=>!document.fullscreenElement && innerWidth<innerHeight);
      assert.equal((await page.evaluate(()=>BilikaraAndroidLayout.client.load())).orientation,"portrait");
      await page.waitForFunction(()=>!document.querySelector("video").paused && !document.querySelector("audio").paused);
    }
    await settings();await choose("orientation","system");
    await page.screenshot({path:path.join(directory,"native-settings.png")});
    const result={passed:errors.length===0,functionalChecksPassed:true,pageErrors:errors,actualRotation:true,sharedNodes:true,noReloadWhileSwitching:true,persistedAcrossProcess:true,originChangedAfterRestart:new URL(originalUrl).origin!==new URL(page.url()).origin,fullscreenRestoration:["button","Android Back"],preferences:await page.evaluate(()=>BilikaraAndroidLayout.client.load())};
    await fs.writeFile(path.join(directory,"result.json"),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    assert.deepEqual(errors,[],"Record, do not hide, any injection/application errors");
  } catch(error) {
    await page.screenshot({path:path.join(directory,"failed.png")}).catch(()=>{});
    console.log(await page.evaluate(()=>({width:innerWidth,height:innerHeight,root:{...document.documentElement.dataset},fullscreen:!!document.fullscreenElement,media:Array.from(document.querySelectorAll("video,audio")).map(el=>({tag:el.tagName,time:el.currentTime,paused:el.paused,ready:el.readyState,error:el.error?.code}))})).catch(()=>({})));
    throw error;
  } finally {await browser.close();adb("forward","--remove","tcp:9238");}
})().catch(error=>{console.error(error);process.exitCode=1;});
