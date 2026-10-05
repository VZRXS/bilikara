"use strict";
// Offline shared Host acceptance. Native preference RPC is stubbed here; actual
// Activity rotation/fullscreen/persistence must also be checked on Android.
// node tests/live_android_layout.cjs EXE PRIVATE_DIR VIDEO AUDIO CHROME
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {once}=require("node:events");
const {createInterface}=require("node:readline");
const fs=require("node:fs/promises");
const path=require("node:path");
const {chromium}=require("playwright");
const [exe,directory,video,audio,executablePath]=process.argv.slice(2);
(async()=>{
  const {isolatedEnvironment}=await import("./native_host_support.mjs");
  const server=spawn(exe,[path.resolve(directory),path.resolve("static"),path.resolve(video),path.resolve(audio)],{env:isolatedEnvironment(path.resolve(directory)),stdio:["pipe","pipe","pipe"]});
  let diagnostics="";
  const lines=createInterface({input:server.stdout});server.stderr.on("data",data=>{diagnostics=(diagnostics+data).slice(-16384);});
  let browser,page;
  try {
    const bootstrap=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error(diagnostics || "Host exited");})])).bootstrap_url;
    browser=await chromium.launch({headless:true,executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
    const context=await browser.newContext({viewport:{width:412,height:850},isMobile:true,hasTouch:true,locale:"zh-CN"});
    await context.addInitScript(()=>{
      let saved={layout:"auto",orientation:"system"};
      window.BilikaraHostWindow={postMessage(raw){
        if(["enter","exit"].includes(raw)) return;
        const {id,action,mode}=JSON.parse(raw);
        if(action==="set-layout") saved={...saved,layout:mode};
        if(action==="set-orientation") saved={...saved,orientation:mode};
        queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:saved})}));
      }};
    });
    await context.route("**/*",route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith("/api/d1/") || /\/api\/(catalog|gatcha)\/(search|status)/.test(url.pathname)) return route.fulfill({json:{ok:true,data:{items:[],tags:[],has_more:false}}});
      return url.hostname==="127.0.0.1" ? route.continue() : route.abort();
    });
    page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3);
    await page.evaluate(()=>{window.layoutTestMedia={video:document.querySelector("video"),audio:document.querySelector("audio"),draft:document.querySelector("#url-input")};});
    const assertMedia=async()=>{
      const result=await page.evaluate(()=>({sameVideo:layoutTestMedia.video===document.querySelector("video"),sameAudio:layoutTestMedia.audio===document.querySelector("audio"),sameInput:layoutTestMedia.draft===document.querySelector("#url-input"),videoPaused:layoutTestMedia.video.paused,audioPaused:layoutTestMedia.audio.paused}));
      assert.deepEqual(result,{sameVideo:true,sameAudio:true,sameInput:true,videoPaused:false,audioPaused:false});
      const before=await page.evaluate(()=>layoutTestMedia.video.currentTime);
      await page.waitForFunction(t=>layoutTestMedia.video.currentTime>t+0.2,before);
    };
    const dock=page.locator("#android-host-dock");
    await dock.locator('[data-android-page="request"]').click();
    await page.locator('[data-request-view="quick"]').click();
    await page.locator("#url-input").fill("saved layout search draft");
    const metrics=[];
    for(const [width,height,layout] of [[412,250,"portrait"],[844,390,"landscape"],[1024,768,"landscape"],[1280,800,"landscape"],[800,1280,"landscape"],[600,960,"portrait"],[412,850,"portrait"]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(mode=>document.documentElement.dataset.hostLayout===mode,layout);
      assert.equal(await dock.isVisible(),layout==="portrait");
      assert.equal(await page.locator("#work-rail").isVisible(),layout!=="portrait");
      assert.equal(await page.locator("#url-input").inputValue(),"saved layout search draft");
      await assertMedia();
      if(layout!=="portrait") {
        // The shared desktop rail toggles an already-selected narrow drawer.
        // Open it only when closed; a second click intentionally hides it.
        if(!await page.locator('[data-request-view="quick"]').isVisible()) await page.locator("#work-rail-request").click();
        await page.locator('[data-request-view="quick"]').click();
        await page.locator("#url-input").click({trial:true});
        assert.equal(await page.locator("#presentation-settings").evaluate(el=>!!el.closest(".topbar")),true);
      }
      const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,toolLayout:document.querySelector(".app-shell").dataset.narrowToolLayout}));
      assert.ok(bounds.scrollWidth<=width+1,JSON.stringify(bounds));metrics.push(bounds);
      await page.screenshot({path:path.join(directory,`auto-${width}-${height}.png`)});
    }
    await dock.locator('[data-android-page="my"]').click();await page.locator("#android-open-settings").click();
    assert.equal(await page.locator('[data-android-orientation-mode], [data-android-layout-mode]').count(),0);
    await page.setViewportSize({width:1280,height:800});
    await page.locator("#work-rail-settings").click();
    for(const locale of ["en","ja","zh"]) {
      await page.locator(`[data-language="${locale}"]`).click();
      assert.equal(await page.locator('[data-android-orientation-mode]').count(),0);
      await assertMedia();
      await page.screenshot({path:path.join(directory,`desktop-settings-${locale}.png`)});
    }
    await page.locator("#work-rail-users").click();
    await page.setViewportSize({width:412,height:850});
    await page.waitForFunction(()=>document.documentElement.dataset.hostPage==="users");
    await assertMedia();
    assert.deepEqual(errors,[]);
    const result={passed:true,metrics,automaticLayout:true,manualSelectors:false,translations:3,persistentMedia:true,persistentDraft:true,workspaceRestored:true};
    await fs.writeFile(path.join(directory,"result.json"),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } catch(error) {
    if(page) {
      await page.screenshot({path:path.join(directory,"failed.png")}).catch(()=>{});
      console.error(await page.evaluate(async()=>({platform:document.documentElement.dataset.hostPlatform,
        current:typeof state!=="undefined"?state.data?.current_item?.id:null,
        media:await Promise.all([...document.querySelectorAll('video,audio')].map(async node=>({tag:node.tagName,
          ready:node.readyState,time:node.currentTime,paused:node.paused,error:node.error?.code,
          codec:node.canPlayType(node.tagName==='VIDEO'?'video/mp4; codecs="avc1.42E01E"':'audio/mp4; codecs="mp4a.40.2"'),
          status:node.currentSrc?(await fetch(node.currentSrc,{method:'HEAD'})).status:null})))})).catch(()=>({})));
    }
    throw error;
  } finally {
    if(browser) await browser.close();server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null) await once(server,"exit");
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
