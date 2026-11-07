import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const app = readFileSync(process.env.BILIKARA_V7_SOURCE || new URL('../static/app.js', import.meta.url), 'utf8');
const between = (start, end) => {const index = app.indexOf(start); return app.slice(app.slice(index - 6, index) === 'async ' ? index - 6 : index, app.indexOf(end));};

test('iOS display defaults survive unavailable accessory metadata and Scene attachment/reconnect',()=>{
  const state={presentationSession:{phase:'inactive'},presentationSelectionInitialized:false};
  const context={state,renderPresentationOutputControl(){}};
  vm.runInNewContext(between('function normalizePresentationDisplayInfo(', 'async function refreshPresentationDisplays('),context);
  const host={id:'ios-host',controller:true,builtIn:true,selectable:false,identityStable:true,identityQuality:'stable',width:393,height:844};
  const pending={id:'ios-external-accessory',selectable:true,identityStable:false,identityQuality:'pending',requiresConnection:true,identifiable:false};
  const publish=displays=>context.applyPresentationDisplayInfo({displays,controllerDisplayId:'ios-host',
    recommendedDisplayId:displays.find(d=>d.selectable)?.id||'',preferRecommendedOnDisconnect:true});
  publish([host]);assert.equal(state.presentationSelectionInitialized,false);
  publish([host,pending]);assert.equal(state.presentationSelectedDisplayId,pending.id);
  assert.equal(state.presentationDisplayInfo.displays[1].identifiable,false);
  assert.equal(state.presentationDisplayInfo.displays[1].identityStable,false);
  const scene={id:'scene-one',replacesDisplayId:pending.id,selectable:true,identityStable:true,identityQuality:'stable',width:1920,height:1080};
  publish([host,scene]);assert.equal(state.presentationSelectedDisplayId,scene.id);
  publish([host,pending]);assert.equal(state.presentationSelectedDisplayId,pending.id);
});

test('queued native video events cannot reverse the current pair intent after a seek/resume',()=>{
  const handlers={}, calls=[], session={}, video={paused:false,dataset:{}},audio={};
  const context={state:{localShouldBePlaying:true},session,video,audio,currentItem:{id:'current'},window:{},
    document:{hidden:false,documentElement:{dataset:{hostPlatform:'ios'}}},
    addMountedPlayerListener(media,type,callback){handlers[type]=callback;},
    holdLocalPlaybackForNetworkOutput:()=>false,isLocalAdvanceHoldingItem:()=>false,
    isSplitPlayerSeekSettling:()=>false,setSplitPlaybackIntent(v,a,intent){calls.push(intent);},
    synchronizeStartupPlayer(){},reportCurrentVideoStatus(){}};
  vm.runInNewContext(between('  addMountedPlayerListener(video, "play", () => {',
    '  addMountedPlayerListener(video, "seeking", () => {'),context);
  handlers.pause(); assert.deepEqual(calls,[],'stale pause must not silence a resumed pair');
  video.paused=true;handlers.play();assert.deepEqual(calls,[],'stale play must not undo pause');
  video.paused=false;handlers.play();video.paused=true;handlers.pause();
  assert.deepEqual(calls,[true,false],'current native controls still commit play/pause');
});

test('V7 playback trace is opt-in, bounded and excludes untrusted identity/text', () => {
  const state = {localPlayerVolume: .5, data: {player_settings: {volume_percent: 50}},
    hostPlaybackSession: {audio: {currentTime: 2, src: 'secret', error: {message: 'secret'}}, video: {volume: 1}}};
  const context = {state, Date};
  vm.runInNewContext(between('function recordPlaybackTrace(', 'function reportMediaDiagnostic('), context);
  context.recordPlaybackTrace('volumechange');
  assert.equal(state.playbackTrace, undefined);
  context.BILIKARA_PLAYBACK_TRACE = true;
  for (let i = 0; i < 300; i++) context.recordPlaybackTrace('volumechange', 'https://secret');
  assert.equal(state.playbackTrace.length, 256);
  assert.equal(state.playbackTrace[0].requested_volume, .5);
  assert.equal(state.playbackTrace[0].committed_volume, 50);
  assert.equal(state.playbackTrace[0].element_volume, 1);
  assert.ok(!JSON.stringify(state.playbackTrace).includes('secret'));
  context.recordPlaybackTrace('https://secret');
  assert.equal(state.playbackTrace.length, 256);
});


test('V7 delayed media changes and repeated ticks never persist or issue volume intent', () => {
  const state = {localPlayerVolume: .3, localPlayerMuted: false};
  const context = {state, recordPlaybackTrace() {}, persistLocalVolumePreferences() {assert.fail('feedback persistence');},
    renderVolumeControls() {}, frontendPlaybackMode() {}, applyMediaVolume() {}};
  vm.runInNewContext(between('function applyStoredVolumeToSplitPlayer(', 'function syncSplitSeekAudioTarget('), context);
  const video = {volume: 1, muted: false}, audio = {};
  context.applyStoredVolumeToSplitPlayer(video, audio);
  // Correct immediate readback, followed by a next-frame engine change.
  video.volume = 1; video.muted = true;
  for (let i = 0; i < 20; i++) context.syncSplitPlayerVolumeFromVideo(video, audio);
  assert.equal(state.localPlayerVolume, .3);
  assert.equal(state.localPlayerMuted, false);
});

test('V7 native control admission retires old sessions and observes iOS; desktop controls retain intent', async () => {
  const commands = [], state = {localPlayerVolume: .4, localPlayerMuted: false};
  const session = {}, context = {state, document: {documentElement: {dataset: {hostPlatform: 'ios'}}},
    recordPlaybackTrace() {}, isCurrentHostPlaybackSession: current => current === session,
    setLocalPlayerVolumeAndMuted: async (...args) => commands.push(args)};
  vm.runInNewContext(between('function syncSplitPlayerVolumeFromVideo(', 'function syncSplitSeekAudioTarget('), context);
  const video = {volume: .8, muted: true, controls: true, bilikaraAppliedNativeVolume: .4}, audio = {};
  context.handleNativePlayerVolumeChange(session, video, audio);
  assert.equal(commands.length, 0);
  context.document.documentElement.dataset.hostPlatform = 'desktop';
  context.handleNativePlayerVolumeChange({}, video, audio);
  assert.equal(commands.length, 0);
  context.handleNativePlayerVolumeChange(session, video, audio);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], .8); assert.equal(commands[0][1], true);
  context.handleNativePlayerVolumeChange(session, {...video, muted: false}, audio);
  assert.equal(commands.length, 1, 'repeat program event is not a command');
});

test('V7 delay operations retain order and still reconcile an SSE-before-HTTP acknowledgement', async () => {
  const posted = [], resolvers = [], applied = [], state = {data: {player_settings: {av_offset_ms: 0}}};
  const context = {state, document: {}, currentAvOffsetMs: () => state.data.player_settings.av_offset_ms,
    renderAvSyncControls() {}, frontendPlaybackMode() {}, render() {}, setAppMessage() {assert.fail('unexpected failure');},
    avDelayRequestTimeoutMs: 1000, queueLocalPlayerSettingsWrite(path, body) {
      posted.push(body); return new Promise(resolve => resolvers.push(resolve));
    }, acceptHostStateSnapshot() {return false;},
    resyncMountedLocalPlayerIfOffsetChanged(previous) {applied.push([previous, state.data.player_settings.av_offset_ms]);}};
  vm.runInNewContext(between('function dispatchAvDelayAction(', 'function updateCacheSliderFill('), context);
  const first = context.dispatchAvDelayAction({type: 'adjust', delta_ms: 200});
  const second = context.dispatchAvDelayAction({type: 'adjust', delta_ms: -400});
  const third = context.dispatchAvDelayAction({type: 'set_effective', effective_delay_ms: 500});
  await Promise.resolve(); assert.equal(posted.length, 1);
  state.data.player_settings.av_offset_ms = 200; // newer SSE already accepted
  resolvers.shift()({state: {}}); await first; await Promise.resolve();
  assert.equal(posted.length, 2); assert.equal(state.avOffsetSaving, true);
  state.data.player_settings.av_offset_ms = -200;
  resolvers.shift()({state: {}}); await second; await Promise.resolve();
  state.data.player_settings.av_offset_ms = 500;
  resolvers.shift()({state: {}}); await third;
  assert.equal(state.avOffsetSaving, false);
  assert.equal(posted[1].delta_ms, -400);
  assert.deepEqual(applied.map(pair => pair[1]), [200, -200, 500]);
});


test('V7 retired best-effort play promise cannot clear a newer native-play marker or block recovery', async () => {
  const state = {localPlaybackStartGeneration:1}, pending = [], failures = [];
  const context = {state, window:{}, mediaPlayPromisesInFlight:new WeakMap(), isWebKitPlaybackRuntime:()=>true,
    invokeMediaPlay(media) {media.dataset.bilikaraInternalPlay='true';return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
    isActiveSplitPlayer:()=>true, isPlaybackPolicyRejection:()=>true,
    requireSplitPlaybackUserGesture:()=>failures.push('stale-policy'), reportSplitSyncDiagnostic:()=>failures.push('stale-error')};
  vm.runInNewContext(between('function playMediaBestEffort(', 'function seekVideoForNavigation('), context);
  const video = {paused:true,ended:false,dataset:{}}, audio = {};
  assert.equal(context.playMediaBestEffort(video,{internalVideo:true,video,audio}),true);
  state.localPlaybackStartGeneration=2;
  assert.equal(context.playMediaBestEffort(video,{internalVideo:true,video,audio}),true);
  pending[0].reject(new Error('old rejection')); await Promise.resolve();
  assert.equal(video.dataset.bilikaraInternalPlay,'true'); assert.equal(failures.length,0);
  assert.equal(context.playMediaBestEffort(video,{internalVideo:true,video,audio}),false);
  pending[1].resolve(); await Promise.resolve();
  assert.equal(video.dataset.bilikaraInternalPlay,undefined);
});
