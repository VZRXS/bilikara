/* Android visibility/touch adapter. The shared Host player owns media intent;
   these transient leases distinguish background/scrub pauses from user intent.
   Neither is persisted or reused for a replacement playback generation. */
(() => {
  "use strict";
  if (!isAndroidNativePlaybackRuntime()) return;
  let suspended = null;
  let touch = null;
  let tap = null;
  let lastTap = null;
  let applyingPause = false;
  let pauseCount = 0;
  let resumeCount = 0;

  function capture() {
    const session = state.hostPlaybackSession;
    const {video, audio} = activeLocalPlayerElements();
    return {session, video, audio, generation:state.data?.playback_generation,
      resume:Boolean(session && video && audio && session.logicalPlayIntent
        && !audio.ended && !["failed", "needs-user-gesture", "retiring", "retired"].includes(session.phase))};
  }

  function blockStart() {
    if (!document.hidden && window.BilikaraAndroidPresentation?.isForeground() !== false) return false;
    touch = null;
    tap = lastTap = null;
    if (!suspended) suspended = capture();
    if (applyingPause) return true;
    const session = state.hostPlaybackSession;
    const {video, audio} = activeLocalPlayerElements();
    if (!session || !video || !audio || !isCurrentHostPlaybackSession(session, video, audio)) return true;
    applyingPause = true;
    try {
      // Ignore old play() completions and seek/startup retries after suspension.
      // Repeated visibility/timeupdate events must not overwrite the lease.
      if (state.localShouldBePlaying || session.logicalPlayIntent || !video.paused || !audio.paused) {
        state.localPlaybackStartGeneration = Number(state.localPlaybackStartGeneration || 0) + 1;
        if (["failed", "needs-user-gesture"].includes(session.phase)) {
          session.logicalPlayIntent = false;
          state.localShouldBePlaying = false;
          video.dataset.bilikaraInternalPause = "true";
          video.pause();
          audio.pause();
        } else {
          setSplitPlaybackIntent(video, audio, false, {source:"android-background-pause"});
        }
        pauseCount++;
        reportPlayerStatus(video.dataset.playerItemId, video, session);
      }
      session.seekResumeAfterSettle = false;
      session.seekResumePending = false;
      clearSplitPlaybackStartupWatchdog(session);
      clearAndroidAudioClockRecovery(session);
      if (session.hiddenPauseTimer) window.clearTimeout(session.hiddenPauseTimer);
      session.hiddenPauseTimer = null;
      delete video.dataset.bilikaraInternalPlay;
    } finally { applyingPause = false; }
    return true;
  }

  function interceptIntent(shouldPlay, source) {
    tap = lastTap = null;
    // Native controls can pause on thumb-down, before the first seek/move.
    // Only that specific pause may retain the gesture's original play intent.
    // A Remote command or any explicit app intent replaces the saved intent.
    // Keep physical contact tracked so controls cannot disappear mid-drag.
    if (touch && source === "native-video-pause-intent") touch.nativePause = true;
    else if (touch) {touch.nativePause = false; touch.resume = Boolean(shouldPlay);}
    if (applyingPause) return false;
    if (!shouldPlay && suspended) suspended.resume = false;
    // Explicit play while backgrounded must not restart hidden playback.
    return blockStart();
  }

  function isTouchingVideo(video) {
    return Boolean(touch && touch.video === video && touch.generation === state.data?.playback_generation
      && isCurrentHostPlaybackSession(touch.session, touch.video, touch.audio));
  }

  function seekResumeIntent(video, audio) {
    tap = lastTap = null;
    return isTouchingVideo(video) && touch.audio === audio && touch.nativePause
      ? touch.resume : !video.paused || state.localShouldBePlaying;
  }

  document.addEventListener("pointerdown", event => {
    touch = null;
    const current = capture();
    if (event.pointerType !== "touch" || event.isPrimary === false || event.target !== current.video
      || !isCurrentHostPlaybackSession(current.session, current.video, current.audio)) return;
    touch = {...current, resume:state.localShouldBePlaying, pointerId:event.pointerId, nativePause:false};
  }, true);
  for (const name of ["pointerup", "pointercancel"]) {
    document.addEventListener(name, event => {
      if (touch?.pointerId === event.pointerId) touch = null;
    }, true);
  }

  // Android's native video UI can consume dblclick as its own seek gesture.
  // Recognize two stationary touches before that default action; never cancel
  // a single tap or a drag, so the native controls remain usable.
  document.addEventListener("touchstart", event => {
    tap = null;
    const current = capture();
    if (event.target !== current.video || event.touches.length !== 1
      || !isCurrentHostPlaybackSession(current.session, current.video, current.audio)) {
      lastTap = null;
      return;
    }
    const point = event.touches[0];
    tap = {...current, id:point.identifier, x:point.clientX, y:point.clientY, at:event.timeStamp};
  }, {capture:true, passive:true});
  document.addEventListener("touchmove", event => {
    const point = Array.from(event.touches).find(point => point.identifier === tap?.id);
    if (!point || Math.hypot(point.clientX - tap.x, point.clientY - tap.y) > 10) {
      tap = lastTap = null;
    }
  }, {capture:true, passive:true});
  document.addEventListener("touchcancel", () => {tap = lastTap = null;}, {capture:true, passive:true});
  document.addEventListener("touchend", event => {
    const current = tap;
    tap = null;
    if (!current || event.touches.length || event.timeStamp - current.at > 350
      || current.generation !== state.data?.playback_generation
      || !isCurrentHostPlaybackSession(current.session, current.video, current.audio)) {
      lastTap = null;
      return;
    }
    const previous = lastTap;
    lastTap = {...current, at:event.timeStamp};
    if (previous?.session !== current.session || previous.video !== current.video
      || event.timeStamp - previous.at > 350
      || Math.hypot(previous.x - current.x, previous.y - current.y) > 24) return;
    lastTap = null;
    event.preventDefault();
    clearPlayerFrameClickTimer();
    toggleMountedLocalPlayback();
    revealMountedPlayerControlsForUserInteraction();
  }, {capture:true, passive:false});

  function visibilityChanged() {
    if (blockStart()) return true;
    const previous = suspended;
    suspended = null;
    if (previous?.resume && previous.generation === state.data?.playback_generation
      && isCurrentHostPlaybackSession(previous.session, previous.video, previous.audio)
      && !previous.audio.ended && !shouldHoldCurrentItemForTransition(state.data?.current_item)) {
      resumeCount++;
      setSplitPlaybackIntent(previous.video, previous.audio, true, {source:"android-foreground-resume"});
      if (!previous.session.readyCommitted) {
        scheduleSplitPlaybackStartupWatchdog(previous.video, previous.audio);
      }
    }
    return true; // Android must never enter desktop's hidden-playback recovery.
  }

  window.BilikaraAndroidPlayback = {blockStart, interceptIntent, visibilityChanged, isTouchingVideo, seekResumeIntent,
    diagnostics:() => ({background:document.hidden || window.BilikaraAndroidPresentation?.isForeground() === false, resume_pending:Boolean(suspended?.resume),
      background_pauses:pauseCount, foreground_resumes:resumeCount})};
  // A native media play event can arrive after an in-flight play() was paused.
  document.addEventListener("play", event => {
    const session = state.hostPlaybackSession;
    if (event.target === session?.video || event.target === session?.audio) blockStart();
  }, true);
  window.addEventListener("pagehide", () => { suspended = null; touch = null; tap = lastTap = null; });
  window.BilikaraAndroidPresentation?.listen("foreground", () => visibilityChanged());
  if (document.hidden) blockStart();
})();
