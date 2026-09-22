"use strict";
// Dedicated disposable emulator only. Uses the real APK/Presentation bridge;
// Playback mode uses synthetic HTTP/state fixtures, not persisted cache claims:
// native restart intentionally clears cache projections. This tests actual
// Android decoding + Kotlin bridge/windows, not Rust download/cache behaviour.
// NODE_PATH=<playwright modules> node tests/live_android_presentation.cjs CDP_URL OUTPUT_DIR [probe|playback]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {chromium} = require("playwright");
const [endpoint, directory, mode = "probe"] = process.argv.slice(2);
const adb = process.env.ANDROID_HOME + "/platform-tools/adb.exe";
const shell = (...args) => execFileSync(adb,["-s","emulator-5562","shell",...args],{encoding:"utf8"});

async function installPlaybackFixture(context, page) {
  const data = await page.evaluate(()=>structuredClone(state.data));
  assert.equal(data.current_item, null, "Use an empty disposable emulator; never intercept a user's session");
  assert.equal(data.playlist.length, 0);
  const video = await fs.readFile(path.join(directory,"fixture-video.mp4"));
  const audio = await fs.readFile(path.join(directory,"fixture-audio.m4a"));
  const items = ["first", "second"].map(id=>({
    id:`display-fixture-${id}`, item_incarnation_id:`display-fixture-${id}-instance`,
    artifact_set_id:`display-fixture-${id}-artifact`, selected_audio_variant_id:"original",
    title:`Offline display fixture ${id}`, display_title:`Offline display fixture ${id}`,
    requester_name:"Fixture", bvid:"", page:1, video_page:1,
    selected_pages:[1],selected_cids:[1],selected_durations:[90],selected_parts:["Original"],
    available_pages:[1],available_cids:[1],available_durations:[90],available_parts:["Original"],
    cache_status:"ready",cache_progress:1,cache_message:"Ready",
    video_media_url:`/media/display-fixture/${id}/video.mp4`,
    audio_variants:[{id:"original",label:"Original",page:1,audio_url:`/media/display-fixture/${id}/audio.m4a`}],
  }));
  data.state_revision += 1000; data.revision += 1000; data.playback_generation += 1;
  data.current_item=items[0]; data.playlist=[items[1]];
  data.session_flags={...data.session_flags,startup_choice_pending:false};
  const setProgram = () => {
    const item=data.current_item;
    data.playback_program=item ? Object.fromEntries(["item_id","item_incarnation_id","selected_audio_variant_id","artifact_set_id"]
      .map(key=>[key,key==="item_id"?item.id:item[key]])) : null;
  };
  setProgram();
  await context.route("**/media/display-fixture/**", async route=>{
    const bytes=route.request().url().endsWith(".mp4")?video:audio;
    const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||"");
    const start=range?Number(range[1]):0;
    const end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
    const headers={"Accept-Ranges":"bytes","Content-Type":bytes===video?"video/mp4":"audio/mp4"};
    if(range) headers["Content-Range"]=`bytes ${start}-${end}/${bytes.length}`;
    await route.fulfill({status:range?206:200,headers,body:bytes.subarray(start,end+1)});
  });
  await context.route("**/api/**", async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==="/api/player/claim-program") {
      return route.fulfill({json:{ok:true,data:{claimed:true}}});
    }
    if(url.pathname==="/api/player/next") {
      data.current_item=data.playlist.shift()||null;
      data.state_revision++;data.revision++;data.playback_generation++;setProgram();
    }
    await route.fulfill({json:{ok:true,data}});
  });
  await page.evaluate(()=>fetchState());
}

(async () => {
  const browser = await chromium.connectOverCDP(endpoint, {noDefaults:true});
  const context = browser.contexts()[0];
  const page = context.pages().find(p=>new URL(p.url()).pathname === "/");
  assert.ok(page,"Native Host WebView must be running");
  const errors=[];
  page.on("pageerror", error=>errors.push(error.message));
  await page.waitForFunction(()=>window.BilikaraAndroidPresentation && state.data);
  await page.waitForFunction(()=>state.presentationDisplayInfo);
  await page.evaluate(async()=>{
    if(state.presentationSession.phase!=="inactive") await deactivateLocalPresentation();
  });
  if (await page.locator("#native-session-choice").isVisible()) {
    await page.locator('[data-session-choice="continue"]').click();
  }
  if (mode === "playback") await installPlaybackFixture(context,page);
  await page.locator('#android-host-dock [data-android-page="my"]').click();
  if (await page.locator("#android-open-settings").isVisible()) await page.locator("#android-open-settings").click();
  if (await page.locator("#presentation-settings-toggle").getAttribute("aria-expanded") !== "true") {
    await page.locator("#presentation-settings-toggle").click();
  }
  await page.waitForFunction(()=>!state.presentationDisplayBusy);
  const displays=await page.evaluate(()=>state.presentationDisplayInfo);
  const target=displays.displays.find(d=>d.selectable);
  assert.ok(target,"Emulator must expose a Presentation display");
  await page.locator(`[data-presentation-display-id="${target.id}"]`).click();
  assert.equal(await page.locator(".android-display-settings").evaluate(section=>{
    const panel=section.querySelector(".presentation-output-panel");
    return panel.getBoundingClientRect().bottom<=section.getBoundingClientRect().bottom;
  }),true,"Expanded display settings must fit inside their section");
  await page.screenshot({path:path.join(directory,"android-display-settings.png")});
  await page.locator("#presentation-output-button").click();
  await page.waitForFunction(()=>state.presentationSession.phase==="active",null,{timeout:20000});
  await page.waitForTimeout(400); // New WebView target discovery, not a UI busy guard.
  const stage=context.pages().find(p=>p.url().includes("controller.html"));
  assert.ok(stage,"Native Presentation must create the shared stage WebView");
  await stage.waitForSelector("#controller-stage-frame");
  const result={mode,displays:displays.displays.map(({id,width,height,selectable})=>({id,width,height,selectable}))};

  if (mode === "playback") {
    await stage.waitForFunction(()=>document.querySelector("video")?.currentTime>0.5);
    assert.equal(await stage.locator("video").evaluate(v=>v.muted),true);
    assert.equal(await stage.locator("audio").count(),0);
    await page.locator('#android-host-dock [data-android-page="playback"]').click();
    const before=await stage.locator("video").evaluate(v=>v.currentTime);
    await page.locator("#presentation-host-forward").click();
    await stage.waitForFunction(before=>document.querySelector("video").currentTime>before+10,before);
    await page.waitForFunction(()=>{
      const s=state.hostPlaybackSession;
      return s && !s.seekSettling && !s.video.seeking && !s.audio.seeking && !s.video.paused && !s.audio.paused;
    });
    console.log("PASS seek settled and both Host tracks resumed");
    await page.locator("#presentation-host-play").click();
    await page.waitForFunction(()=>!state.localShouldBePlaying && !state.hostPlaybackSession.logicalPlayIntent);
    await stage.waitForFunction(()=>document.querySelector("video").paused);
    await page.locator("#presentation-host-play").click();
    await stage.waitForFunction(()=>!document.querySelector("video").paused);
    console.log("PASS pause/resume");
    const old=await stage.locator("video").getAttribute("src");
    await page.locator("#presentation-host-next").click();
    await stage.waitForFunction(old=>{
      const v=document.querySelector("video");return v && v.getAttribute("src")!==old && !v.paused;
    },old,{timeout:20000});
    // Native Activity callbacks, not synthetic document.hidden.
    shell("input","keyevent","3");
    // requestAnimationFrame stops while the Activity is hidden. Poll the actual
    // media property instead of relying on a foreground frame callback.
    await stage.waitForFunction(()=>document.querySelector("video").paused,null,{polling:100});
    shell("am","start","-n","com.bilikara.app.alpha/com.bilikara.app.MainActivity");
    await stage.waitForFunction(()=>!document.querySelector("video").paused);
    await stage.waitForFunction(()=>{
      const v=document.querySelector("video");
      return v && v.currentTime>2 && v.readyState>=3 && !v.seeking && v.videoWidth>0;
    });
    result.decodedImage=await stage.locator("video").evaluate(v=>{
      const canvas=document.createElement("canvas");canvas.width=32;canvas.height=18;
      const ctx=canvas.getContext("2d");ctx.drawImage(v,0,0,32,18);
      const pixels=ctx.getImageData(0,0,32,18).data;
      const rect=v.getBoundingClientRect(), style=getComputedStyle(v);
      return {width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,
        displayedWidth:rect.width,displayedHeight:rect.height,opacity:style.opacity,visibility:style.visibility,
        hasColor:[...pixels].some((value,index)=>index%4!==3 && value>32)};
    });
    assert.equal(result.decodedImage.hasColor,true,"External stage must decode an actual image, not just advance its clock");
    assert.ok(result.decodedImage.displayedWidth>0 && result.decodedImage.displayedHeight>0);
    assert.equal(result.decodedImage.opacity,"1");
    assert.equal(result.decodedImage.visibility,"visible");
    await stage.screenshot({path:path.join(directory,"android-audience-stage.png")});
    // WebView CDP screenshots can omit hardware video overlays. The emulator's
    // developer secondary-display overlay also appears in a native screencap.
    shell("screencap","-p","/data/local/tmp/bilikara-presentation-acceptance.png");
    execFileSync(adb,["-s","emulator-5562","pull","/data/local/tmp/bilikara-presentation-acceptance.png",
      path.join(directory,"android-native-display.png")]);
    result.playback="play/pause, seek, next song, native background/resume passed";
  }
  await page.evaluate(()=>BilikaraAndroidPresentation.refreshDiagnostics());
  result.diagnostics=await page.evaluate(()=>BilikaraAndroidPresentation.diagnostics());
  shell("settings","delete","global","overlay_display_devices");
  await page.waitForFunction(()=>state.presentationSession.phase==="inactive");
  assert.equal(await page.evaluate(()=>document.body.classList.contains("is-presentation-control-host")),false);
  result.disconnection="restored combined Host";
  result.errors=errors;
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(directory,`emulator-${mode}.json`),JSON.stringify(result,null,2));
  console.log(`PASS native Android ${mode}: activation and disconnection`);
  await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1;setTimeout(()=>process.exit(1),100);});
