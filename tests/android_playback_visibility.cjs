"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("static/android-playback.js", "utf8");

function fixture(android = true, nativeBridge = false) {
  const listeners = {}, calls = [];
  const media = () => ({paused:false, ended:false, dataset:{playerItemId:"song"}, pause(){this.paused=true;}});
  const video = media(), audio = media();
  const session = {video, audio, logicalPlayIntent:true, readyCommitted:true, phase:"playing",
    playbackGeneration:1, seekResumeAfterSettle:true, seekResumePending:true, hiddenPauseTimer:9};
  const state = {data:{playback_generation:1, current_item:"song"}, hostPlaybackSession:session,
    localShouldBePlaying:true, localPlaybackStartGeneration:4};
  const document = {hidden:false, addEventListener(name, callback){listeners[name]=callback;}};
  const window = {clearTimeout(id){calls.push(["clear-timer",id]);}, addEventListener(name,cb){listeners[name]=cb;}};
  let foreground = true;
  if (nativeBridge) window.BilikaraAndroidPresentation = {
    isForeground:()=>foreground,
    listen:(name,callback)=>{listeners[`native-${name}`]=callback;},
  };
  const context = {state, document, window, isAndroidNativePlaybackRuntime:()=>android,
    activeLocalPlayerElements:()=>({video,audio}),
    isCurrentHostPlaybackSession:(s,v,a)=>s===state.hostPlaybackSession && s.video===v && s.audio===a
      && s.playbackGeneration===state.data.playback_generation && !["retiring","retired"].includes(s.phase),
    shouldHoldCurrentItemForTransition:()=>false,
    clearSplitPlaybackStartupWatchdog:()=>calls.push(["clear-watchdog"]),
    scheduleSplitPlaybackStartupWatchdog:()=>calls.push(["arm-watchdog"]),
    clearAndroidAudioClockRecovery:()=>calls.push(["clear-audio-recovery"]),
    reportPlayerStatus:()=>{calls.push(["status"]);return true;},
    clearPlayerFrameClickTimer:()=>calls.push(["clear-click"]),
    revealMountedPlayerControlsForUserInteraction:()=>calls.push(["reveal-controls"]),
    toggleMountedLocalPlayback:()=>{
      calls.push(["double-tap"]);
      context.setSplitPlaybackIntent(video,audio,!state.localShouldBePlaying,{source:"player-toggle-intent"});
    },
    setSplitPlaybackIntent:(v,a,playing,{source})=>{
      if(window.BilikaraAndroidPlayback.interceptIntent(playing,source))return true;
      calls.push([source,playing]);
      session.logicalPlayIntent=state.localShouldBePlaying=playing;
      v.paused=a.paused=!playing;
      session.phase=playing?"playing":"paused";
      return true;
    }};
  vm.runInNewContext(source,context);
  const api=window.BilikaraAndroidPlayback;
  const hide=value=>{document.hidden=value;api.visibilityChanged();};
  const setForeground = value=>{foreground=value;listeners["native-foreground"]();};
  return {context,state,session,video,audio,window,document,listeners,calls,api,hide,setForeground};
}

assert.equal(fixture(false).api,undefined,"Desktop and web Remote must keep existing behavior");
{
  const f=fixture(true,true);
  f.setForeground(false);
  assert.equal(f.document.hidden,false,"Native background can precede document visibility");
  assert.ok(f.video.paused && f.audio.paused && f.api.diagnostics().background);
  f.hide(true);f.setForeground(true);
  assert.equal(f.video.paused,true,"Both native Activity and DOM must be foreground");
  f.hide(false);
  assert.equal(f.video.paused,false);
  assert.equal(f.calls.filter(c=>c[0]==="android-foreground-resume").length,1);
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"user"});
  f.setForeground(false);f.setForeground(true);
  assert.equal(f.video.paused,true,"Native foreground must preserve manual pause");
}
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
{
  const f=fixture();
  f.listeners.pointerdown({target:f.video,pointerType:"touch",pointerId:7,isPrimary:true});
  assert.equal(f.api.isTouchingVideo(f.video),true);
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"native-video-pause-intent"});
  assert.equal(f.state.localShouldBePlaying,false,"Native pause still stops audio immediately");
  assert.equal(f.api.seekResumeIntent(f.video,f.audio),true,"Thumb-down pause preserves pre-scrub intent");
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"remote-pause"});
  assert.equal(f.api.seekResumeIntent(f.video,f.audio),false,"Remote pause during drag cancels auto-resume");
}
for(const finish of [f=>f.listeners.pointerup({pointerId:7}), f=>f.listeners.pointercancel({pointerId:7}),
  f=>f.state.data.playback_generation++, f=>f.state.hostPlaybackSession={...f.session},
  f=>f.hide(true), f=>f.listeners.pagehide()]) {
  const f=fixture();
  f.listeners.pointerdown({target:f.video,pointerType:"touch",pointerId:7});
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"native-video-pause-intent"});
  finish(f);
  assert.equal(f.api.isTouchingVideo(f.video),false,"A finished/retired gesture cannot affect the next seek");
  assert.equal(f.api.seekResumeIntent(f.video,f.audio),false);
}
{
  const f=fixture();
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"user"});
  f.listeners.pointerdown({target:f.video,pointerType:"touch",pointerId:7});
  f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"native-video-pause-intent"});
  assert.equal(f.api.seekResumeIntent(f.video,f.audio),false,"Dragging a paused song never invents a play intent");
}
function tapAt(f, time, {move=false, duration=50, target=f.video}={}) {
  const point={identifier:1,clientX:100,clientY:50};
  f.listeners.touchstart({target,timeStamp:time,touches:[point]});
  if(move) f.listeners.touchmove({touches:[{...point,clientX:130}]});
  const event={timeStamp:time+duration,touches:[],prevented:false,preventDefault(){this.prevented=true;}};
  f.listeners.touchend(event);
  return event;
}
{
  const f=fixture();
  assert.equal(tapAt(f,1000).prevented,false,"Single touch leaves native controls untouched");
  assert.equal(f.calls.some(c=>c[0]==="double-tap"),false);
  assert.equal(tapAt(f,1200).prevented,true,"Second stationary tap cancels the native double-tap seek action");
  assert.equal(f.calls.filter(c=>c[0]==="double-tap").length,1);
  assert.equal(f.state.localShouldBePlaying,false);
  tapAt(f,2000); tapAt(f,2200);
  assert.equal(f.state.localShouldBePlaying,true);
}
for(const invalidate of [f=>f.listeners.touchcancel(), f=>f.state.data.playback_generation++,
  f=>f.context.setSplitPlaybackIntent(f.video,f.audio,false,{source:"remote-pause"}),
  f=>f.api.seekResumeIntent(f.video,f.audio), f=>f.hide(true), f=>f.listeners.pagehide()]) {
  const f=fixture();tapAt(f,1000);invalidate(f);tapAt(f,1200);
  assert.equal(f.calls.some(c=>c[0]==="double-tap"),false,"Cancelled, native-control and retired taps cannot become a double tap");
}
for(const options of [{move:true},{duration:400},{target:{tagName:"BUTTON"}}]) {
  const f=fixture();tapAt(f,1000,options);tapAt(f,1500);
  assert.equal(f.calls.some(c=>c[0]==="double-tap"),false,"Drag/long press/other controls are not video double taps");
}
console.log("PASS Android visibility/touch leases, double taps, native controls, manual intent and stale generation");
