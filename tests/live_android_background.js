"use strict";
// Real Rust Host/media + synthetic browser visibility; no Bilibili requests.
// node tests/live_android_background.js EXE PRIVATE_DIR VIDEO AUDIO [CHROME]
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {once}=require("node:events");
const {createInterface}=require("node:readline");
const path=require("node:path");
const {chromium}=require("playwright");
const [exe,directory,video,audio,executablePath]=process.argv.slice(2);
(async()=>{
  const server=spawn(exe,[path.resolve(directory),path.resolve("static"),path.resolve(video),path.resolve(audio)],{stdio:["pipe","pipe","pipe"]});
  const lines=createInterface({input:server.stdout});
  server.stderr.on("data",()=>{});
  let browser;
  try {
    const bootstrap=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited");})])).bootstrap_url;
    browser=await chromium.launch({headless:true,executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
    const context=await browser.newContext({viewport:{width:412,height:850},isMobile:true,hasTouch:true,
      userAgent:"Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"});
    await context.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
    await context.addInitScript(()=>{
      window.testHidden=false;
      Object.defineProperty(document,"hidden",{configurable:true,get:()=>window.testHidden});
      Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>window.testHidden?"hidden":"visible"});
    });
    const page=await context.newPage(),errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>state.hostPlaybackSession?.phase==="playing" && document.querySelector("video").currentTime>0.3);
    const original=await page.locator("video").elementHandle();
    const hide=async value=>page.evaluate(hidden=>{
      window.testHidden=hidden; document.dispatchEvent(new Event("visibilitychange"));
    },value);
    const paused=()=>page.waitForFunction(()=>{
      const {video,audio}=state.hostPlaybackSession;
      return video.paused && audio.paused && !state.localShouldBePlaying;
    },null,{timeout:3000});
    const playing=()=>page.waitForFunction(()=>{
      const {video,audio}=activeLocalPlayerElements();
      return !video.paused && !audio.paused && state.localShouldBePlaying;
    });
    const intent=async value=>page.evaluate(shouldPlay=>{
      const {video,audio}=activeLocalPlayerElements();
      setSplitPlaybackIntent(video,audio,shouldPlay,{source:"test-explicit-user-intent",userGesture:true});
    },value);
    const assertStable=async()=>{
      const before=await page.evaluate(()=>{const {video,audio}=state.hostPlaybackSession;return [video.currentTime,audio.currentTime];});
      await page.waitForTimeout(350);
      const after=await page.evaluate(()=>{const {video,audio}=state.hostPlaybackSession;return [video.currentTime,audio.currentTime];});
      after.forEach((time,index)=>assert.ok(Math.abs(time-before[index])<0.05,`Background media advanced: ${before} -> ${after}`));
    };
    await hide(true); await paused(); await assertStable();
    await page.evaluate(()=>syncMountedLocalPlayer(true));
    await hide(true); // duplicate event must not forget the original playing intent
    await paused();
    await hide(false); await playing();
    // Background internal pause flags must not swallow the next native pause.
    await page.evaluate(()=>activeLocalPlayerElements().video.pause());
    await paused(); await intent(true); await playing();
    // Native autoplay events and a seek settling while hidden remain paused.
    await hide(true); await paused();
    await page.evaluate(async()=>{
      const {video,audio}=activeLocalPlayerElements();
      state.hostPlaybackSession.seekSettling=true;
      await Promise.allSettled([video.play(),audio.play()]);
      state.hostPlaybackSession.seekSettling=false;
    });
    await paused(); await assertStable();
    await hide(false); await playing();
    // Manual pause before leaving remains paused, even after repeated events.
    await intent(false); await paused();
    await hide(true); await hide(false); await paused(); await assertStable();
    // A Remote/manual pause while hidden cancels only the automatic resume.
    await intent(true); await playing(); await hide(true); await paused();
    await intent(false); await hide(false); await paused();
    // Late play() resolution after leaving cannot revive a cancelled attempt.
    await page.evaluate(()=>{
      const {audio}=activeLocalPlayerElements();
      const play=audio.play.bind(audio);
      window.restoreAudioPlay=()=>{audio.play=play;};
      audio.play=()=>play().then(()=>new Promise(resolve=>{window.releaseAudioPlay=resolve;}));
    });
    await intent(true);
    await page.waitForFunction(()=>typeof window.releaseAudioPlay==="function");
    await hide(true); await paused();
    await page.evaluate(()=>{window.releaseAudioPlay();window.restoreAudioPlay();});
    await assertStable();
    await hide(false); await playing();
    // A generation update received while away cannot resume an obsolete song.
    await hide(true); await paused();
    await page.evaluate(()=>{window.previousGeneration=state.data.playback_generation;state.data.playback_generation++;});
    await hide(false); await paused(); await assertStable();
    await page.evaluate(()=>{state.data.playback_generation=window.previousGeneration;});
    await intent(true); await playing();
    assert.equal(await original.evaluate(el=>el===document.querySelector("video") && el.isConnected),true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,backgroundPause:true,automaticResume:true,manualPausePreserved:true,
     hiddenPauseCancelsResume:true,latePlayResolution:true,generationGuard:true,mediaDomPreserved:true,onlineRequests:0}));
  } finally {
    if(browser)await browser.close();
    server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null)await once(server,"exit");
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
