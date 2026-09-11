/* Android window visibility adapter. The shared Host player still owns media
   intent; this in-memory lease only remembers a pause caused by leaving the UI.
   It is never persisted or reused for a replacement playback generation. */
(() => {
  "use strict";
  if (!isAndroidNativePlaybackRuntime()) return;
  let suspended = null;
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
    if (!document.hidden) return false;
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

  function interceptIntent(shouldPlay) {
    if (applyingPause) return false;
    if (!shouldPlay && suspended) suspended.resume = false;
    // Explicit play while backgrounded must not restart hidden playback.
    return blockStart();
  }

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

  window.BilikaraAndroidPlayback = {blockStart, interceptIntent, visibilityChanged,
    diagnostics:() => ({background:document.hidden, resume_pending:Boolean(suspended?.resume),
      background_pauses:pauseCount, foreground_resumes:resumeCount})};
  // A native media play event can arrive after an in-flight play() was paused.
  document.addEventListener("play", event => {
    const session = state.hostPlaybackSession;
    if (event.target === session?.video || event.target === session?.audio) blockStart();
  }, true);
  window.addEventListener("pagehide", () => { suspended = null; });
  if (document.hidden) blockStart();
})();
