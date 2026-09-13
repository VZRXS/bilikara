"use strict";
// Native Host + real shared UI, offline media and transient QR decode failure.
// node tests/live_android_touch_feedback.js EXE PRIVATE_DIR VIDEO AUDIO [CHROME]
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, video, audio, executablePath] = process.argv.slice(2);

(async () => {
  await fs.mkdir(directory, {recursive:true});
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), path.resolve(video), path.resolve(audio)], {stdio:["pipe","pipe","pipe"], windowsHide:true});
  const lines = createInterface({input:server.stdout});
  server.stderr.on("data", () => {});
  let browser;
  try {
    const bootstrap = JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited");})])).bootstrap_url;
    browser = await chromium.launch({headless:true, executablePath, args:["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext({viewport:{width:393,height:820},isMobile:true,hasTouch:true});
    await context.addInitScript(() => Object.defineProperty(screen.orientation,"type",{configurable:true,get:()=>"portrait-primary"}));
    const blocked=[];
    await context.route("**/*", route => {
      if(new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      blocked.push(new URL(route.request().url()).hostname);
      return route.abort();
    });
    const page = await context.newPage();
    const errors=[];
    page.on("pageerror", e=>errors.push(e.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>window.BilikaraAndroidHost?.isPortrait() && state.data?.current_item?.cache_status === "ready");
    await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3);
    await page.locator("#player-fullscreen-button").tap();
    await page.waitForFunction(()=>isPlayerPanelFullscreen());
    // Tap the actual exit icon, not a programmatic button click.
    await page.locator(".fullscreen-exit-icon").tap();
    await page.waitForFunction(()=>!isPlayerPanelFullscreen(),null,{timeout:3000});
    const exitWorks = await page.evaluate(()=>!isPlayerPanelFullscreen());
    await page.locator("#player-fullscreen-button").tap();
    await page.waitForFunction(()=>isPlayerPanelFullscreen());
    await page.locator("#android-fullscreen-remote-button").tap();
    assert.equal(await page.evaluate(()=>isPlayerPanelFullscreen() && state.playerFullscreenRemotePinned),true);
    assert.equal(await page.locator("#android-fullscreen-remote-button").getAttribute("aria-expanded"),"true");
    await page.locator("#android-fullscreen-remote-button").tap();
    assert.equal(await page.locator("#android-fullscreen-remote-button").getAttribute("aria-expanded"),"false");
    // Decoder failure with an unchanged, valid native source. A regular state
    // render must not loop; an explicit reopen must recover with the same URL.
    await page.evaluate(()=>{elements.playerFullscreenRemoteQrImage.src="data:image/svg+xml;base64,YmFk";});
    await page.waitForFunction(()=>elements.playerFullscreenRemoteQrImage.dataset.qrState==="failed");
    await page.evaluate(()=>{state.remoteAccessRenderSignature="";renderRemoteAccess(state.data.remote_access);});
    assert.equal(await page.locator("#player-fullscreen-remote-qr-image").getAttribute("data-qr-state"),"failed");
    const diagnostics=await page.evaluate(()=>BilikaraAndroidHost.diagnosticsMarkdown());
    assert.ok(diagnostics.includes('"state": "failed"'));
    assert.ok(!diagnostics.includes("http://") && !diagnostics.includes("base64,"));
    const leaks=await page.evaluate(text=>text.includes(state.data.remote_access.qr_image) || text.includes(state.data.remote_access.local_url),diagnostics);
    assert.equal(leaks,false,"UI diagnostics must not leak native QR or access URL");
    await page.locator("#android-fullscreen-remote-button").tap();
    await page.waitForFunction(()=>elements.playerFullscreenRemoteQrImage.dataset.qrState==="loaded");
    // A source supplied later must invalidate the unchanged-address render cache.
    await page.evaluate(()=>{
      const qr=state.data.remote_access.qr_image;
      state.data.remote_access.qr_image="";
      renderRemoteAccess(state.data.remote_access);
      if(elements.playerFullscreenRemoteQrImage.dataset.qrState!=="missing-source") throw Error("Missing native source was not rendered");
      state.data.remote_access.qr_image=qr;
      renderRemoteAccess(state.data.remote_access);
    });
    await page.waitForFunction(()=>elements.playerFullscreenRemoteQrImage.dataset.qrState==="loaded");
    const qr = await page.locator("#player-fullscreen-remote-qr-image").evaluate(el=>({
      loaded:el.complete && el.naturalWidth>0,
      dataSvg:el.getAttribute("src")?.startsWith("data:image/svg+xml;base64,"),
      placeholder:document.querySelector("#player-fullscreen-remote-qr-placeholder").textContent,
    }));
    console.log(JSON.stringify({exitWorks,qr,explicitRetry:true,lateSource:true,safeDiagnostics:true,errors,blocked}));
    await page.screenshot({path:path.join(directory,"fullscreen.png")});
    await page.locator(".fullscreen-exit-icon").tap();
    await page.waitForFunction(()=>!isPlayerPanelFullscreen(),null,{timeout:3000});
    assert.equal(exitWorks,true,"Touching the exit icon must leave fullscreen on the first tap");
    assert.equal(qr.loaded,true,"Native LAN QR must load without external QR services");
    assert.deepEqual(errors,[]);
    assert.deepEqual(blocked,[],"Native QR rendering must not use external services");
  } finally {
    if(browser) await browser.close();
    server.stdin.end("stop\n"); lines.close();
    if(server.exitCode===null) await once(server,"exit");
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
