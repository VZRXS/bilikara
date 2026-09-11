"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/android-playback.js", "utf8");

function fixture(android = true) {
  const listeners = {}, calls = [];
  const media = () => ({paused:false, ended:false, dataset:{playerItemId:"song"}, pause(){this.paused=true;}});
  const video = media(), audio = media();
  const session = {video, audio, logicalPlayIntent:true, readyCommitted:true, phase:"playing",
    playbackGeneration:1, seekResumeAfterSettle:true, seekResumePending:true, hiddenPauseTimer:9};
  const state = {data:{playback_generation:1, current_item:"song"}, hostPlaybackSession:session,
    localShouldBePlaying:true, localPlaybackStartGeneration:4};
  const document = {hidden:false, addEventListener(name, callback){listeners[name]=callback;}};
  const window = {clearTimeout(id){calls.push(["clear-timer",id]);}, addEventListener(name,cb){listeners[name]=cb;}};
  const context = {state, document, window, isAndroidNativePlaybackRuntime:()=>android,
    activeLocalPlayerElements:()=>({video,audio}),
    isCurrentHostPlaybackSession:(s,v,a)=>s===state.hostPlaybackSession && s.video===v && s.audio===a
      && s.playbackGeneration===state.data.playback_generation && !["retiring","retired"].includes(s.phase),
    shouldHoldCurrentItemForTransition:()=>false,
    clearSplitPlaybackStartupWatchdog:()=>calls.push(["clear-watchdog"]),
    scheduleSplitPlaybackStartupWatchdog:()=>calls.push(["arm-watchdog"]),
    clearAndroidAudioClockRecovery:()=>calls.push(["clear-audio-recovery"]),
    reportPlayerStatus:()=>{calls.push(["status"]);return true;},
    setSplitPlaybackIntent:(v,a,playing,{source})=>{
      if(window.BilikaraAndroidPlayback.interceptIntent(playing))return true;
      calls.push([source,playing]);
      session.logicalPlayIntent=state.localShouldBePlaying=playing;
      v.paused=a.paused=!playing;
      session.phase=playing?"playing":"paused";
      return true;
    }};
  vm.runInNewContext(source,context);
  const api=window.BilikaraAndroidPlayback;
  const hide=value=>{document.hidden=value;api.visibilityChanged();};
  return {context,state,session,video,audio,window,document,listeners,calls,api,hide};
}

assert.equal(fixture(false).api,undefined,"Desktop and web Remote must keep existing behavior");
{
  const f=fixture();
  f.hide(true);f.hide(true);f.api.blockStart();
  assert.ok(f.video.paused && f.audio.paused && !f.state.localShouldBePlaying);
  assert.equal(f.state.localPlaybackStartGeneration,5,"Invalidate late play completions only once");
  assert.equal(f.session.seekResumePending,false);
  assert.equal(f.session.hiddenPauseTimer,null);
  assert.equal(f.api.diagnostics().resume_pending,true);
  f.hide(false);f.hide(false);
  assert.equal(f.video.paused,false);
  assert.equal(f.calls.filter(c=>c[0]==="android-foreground-resume").length,1);
}
{
  const f=fixture();
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"user"});
  f.hide(true);f.hide(false);
  assert.equal(f.video.paused,true,"Do not resume a manual pause");
}
{
  const f=fixture();f.hide(true);
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"remote-pause"});
  f.hide(false);
  assert.equal(f.video.paused,true,"An explicit hidden pause cancels the resume lease");
}
{
  const f=fixture();f.hide(true);
  f.video.paused=false;
  f.listeners.play({target:f.video});
  assert.equal(f.video.paused,true,"Late native play events cannot resume background audio");
  f.hide(false);assert.equal(f.video.paused,false);
}
for(const invalidate of [f=>f.state.data.playback_generation++, f=>f.state.hostPlaybackSession={...f.session},
  f=>{f.session.phase="retired";},f=>{f.audio.ended=true;}]) {
  const f=fixture();f.hide(true);invalidate(f);f.hide(false);
  assert.equal(f.video.paused,true,"Do not resume a changed or ended playback session");
}
{
  const f=fixture();f.session.readyCommitted=false;
  f.hide(true);f.hide(false);
  assert.ok(f.calls.some(c=>c[0]==="arm-watchdog"),"Re-arm readiness checks after foregrounding during startup");
}
{
  const f=fixture();f.session.phase="needs-user-gesture";
  f.hide(true);f.hide(false);
  assert.equal(f.video.paused,true,"Foregrounding is not a browser user gesture");
}
{
  const f=fixture();f.hide(true);f.listeners.pagehide();f.hide(false);
  assert.equal(f.video.paused,true,"A destroyed page cannot carry an auto-resume lease");
}
console.log("PASS Android-only pause/resume, manual intent, late play, stale generation, startup and page teardown");
