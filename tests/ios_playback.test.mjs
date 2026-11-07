// Portable policy/source checks; they do not qualify an Apple audio device.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const volume=app.slice(app.indexOf('function applyMediaVolume('),app.indexOf('function setupAudioPitchShifter('));

test('iOS WebKit prepares its gain before playback; other engines retain native unity-range volume',()=>{
  for(const [platform,webkit] of [['ios',false],['ios',true],['android',false],['desktop',true]]){
    const connections=[],changes=[],context={document:{documentElement:{dataset:{nativeHost:'true',hostPlatform:platform}}},
      state:{localPlayerVolume:1,localPlayerMuted:false,audioContext:{currentTime:2}},
      isWebKitPlaybackRuntime:()=>webkit,
      ensureAudioPitchSource(media){connections.push(media);media.bilikaraPitchSource={};media.bilikaraVolumeGain={
        gain:{value:context.state.localPlayerVolume,setTargetAtTime(value){changes.push(value);}},bilikaraTarget:context.state.localPlayerVolume};return media.bilikaraPitchSource;},
      resumeAudioContextBestEffort(){},setAppMessage(){assert.fail('working gain must not report unavailable');},t:key=>key};
    vm.runInNewContext(volume,context);
    const media={volume:1,paused:true};
    context.applyMediaVolume(media);
    assert.equal(connections.length,platform==='ios'&&webkit?1:0,'Only iOS WebKit captures the paused element before first playback');
    media.paused=false;
    for(const value of [.25,0,1]){context.state.localPlayerVolume=value;context.applyMediaVolume(media);}
    assert.equal(connections.length,platform==='ios'?1:0);
    assert.equal(media.volume,1);
    if(platform==='ios')assert.deepEqual(changes,webkit?[.25,0,1]:[0,1]);
    context.state.localPlayerVolume=2;context.applyMediaVolume(media);
    assert.equal(connections.length,1,'Boost and attenuation share the same source');
    context.state.localPlayerMuted=true;context.applyMediaVolume(media);
    assert.equal(media.muted,true);
  }
});

test('unavailable iOS attenuation reports a failure once without inventing gain success',()=>{
  const errors=[],context={document:{documentElement:{dataset:{nativeHost:'true',hostPlatform:'ios'}}},
    state:{localPlayerVolume:.5,localPlayerMuted:false},console:{error(){}},
    ensureAudioPitchSource(){throw Error('unavailable');},setAppMessage:message=>errors.push(message),t:key=>key};
  vm.runInNewContext(volume,context);
  const media={volume:1,paused:false};
  context.applyMediaVolume(media);context.applyMediaVolume(media);
  assert.deepEqual(errors,['player.volumeUnavailable']);
  assert.equal(media.bilikaraPitchSource,undefined);
  assert.equal(media.bilikaraGainErrorReported,true);
});

test('media volume observation cannot replace gain intent on writable or read-only engines', () => {
  const source = app.slice(app.indexOf('function applyStoredVolumeToSplitPlayer('), app.indexOf('function syncSplitSeekAudioTarget('));
  for (const readonly of [false, true]) {
    let volume = 1;
    const state = {localPlayerVolume: .4, localPlayerMuted: false};
    const context = {state, recordPlaybackTrace() {}, persistLocalVolumePreferences() {assert.fail("observations cannot persist intent");}, renderVolumeControls() {}, frontendPlaybackMode() {},
      applyMediaVolume(audio) {audio.gain = state.localPlayerVolume; audio.muted = state.localPlayerMuted;}};
    vm.runInNewContext(source, context);
    const video = {get volume() {return volume;}, set volume(value) {if (!readonly) volume = value;}};
    const audio = {};
    context.applyStoredVolumeToSplitPlayer(video, audio);
    for (let i = 0; i < 10; i++) context.syncSplitPlayerVolumeFromVideo(video, audio);
    assert.equal(state.localPlayerVolume, .4);
    assert.equal(audio.gain, .4);
    if (!readonly) {
      video.volume = .3;
      context.syncSplitPlayerVolumeFromVideo(video, audio);
      assert.equal(state.localPlayerVolume, .4);
    }
    video.muted = true;
    context.syncSplitPlayerVolumeFromVideo(video, audio);
    assert.equal(audio.muted, false);
    assert.equal(state.localPlayerMuted, false);
  }
});

test('settings writes serialize and coalesce slider tails; a slow request cannot expire optimistic intent', async () => {
  const posted = [], releases = [];
  const state = {data: {current_item: {item_incarnation_id: 'song-a'}}, volumeSaveSeq: 0,
    localPlayerVolume: .8, playerSettingsEchoSuppressUntil: 0};
  const context = {state, Date, persistLocalVolumePreferences() {}, activeLocalPlayerElements: () => ({}),
    apiPost: (path, body) => new Promise((resolve, reject) => {posted.push({path, body}); releases.push({resolve, reject});})};
  vm.runInNewContext(app.slice(app.indexOf('function syncLocalPlayerSettingsFromSnapshot('), app.indexOf('function clientHeaders(')), context);
  const first = context.queueLocalPlayerSettingsWrite('/api/player/volume', {volume_percent: 30});
  const second = context.queueLocalPlayerSettingsWrite('/api/player/volume', {volume_percent: 50});
  const tail = context.queueLocalPlayerSettingsWrite('/api/player/volume', {volume_percent: 80, is_muted: false});
  assert.equal(posted.length, 1);
  context.syncLocalPlayerSettingsFromSnapshot({volume_percent: 100});
  assert.equal(state.localPlayerVolume, .8, 'pending writes guard snapshots even after 1800ms');
  releases[0].resolve({ack: 30}); await first;
  assert.equal(posted.length, 2);
  assert.equal(posted[1].body.volume_percent, 80);
  assert.equal(posted[1].body.expected_item_incarnation_id, 'song-a');
  releases[1].resolve({ack: 80}); await Promise.all([second, tail]);
  context.syncLocalPlayerSettingsFromSnapshot({volume_percent: 80});
  assert.equal(state.localPlayerVolume, .8);
  const pending = context.queueLocalPlayerSettingsWrite('/api/player/volume', {volume_percent: 20});
  const obsolete = context.queueLocalPlayerSettingsWrite('/api/player/key-shift', {key_shift: 3});
  state.data.current_item.item_incarnation_id = 'song-b';
  releases[2].resolve({ack: 20});
  assert.equal(await pending, null);
  assert.equal(await obsolete, null);
  assert.equal(posted.length, 3, 'old-song queued commands must never be sent');
});

test('mute-only tail retains prior manual intent and a failed write does not block later settings', async () => {
  const posted = [], releases = [], state = {data: {current_item: {item_incarnation_id: 'a'}}};
  const context = {state, apiPost: (path, body) => new Promise((resolve, reject) => {
    posted.push({path, body}); releases.push({resolve, reject});
  })};
  vm.runInNewContext(app.slice(app.indexOf('function queueLocalPlayerSettingsWrite('), app.indexOf('function clientHeaders(')), context);
  const first = context.queueLocalPlayerSettingsWrite('/api/player/key-shift', {key_shift: 3}).catch(() => null);
  const volume = context.queueLocalPlayerSettingsWrite('/api/player/volume', {volume_percent: 40, is_muted: false});
  const mute = context.queueLocalPlayerSettingsWrite('/api/player/volume', {is_muted: true});
  releases[0].reject(Error('failure')); await first;
  assert.equal(posted[1].body.volume_percent, 40);
  assert.equal(posted[1].body.is_muted, true);
  releases[1].resolve({ack: true}); await Promise.all([volume, mute]);
  assert.equal(state.playerSettingsWriteActive, null);
});

test('interrupted and suspended AudioContexts resume without replacing the source or context', () => {
  const source = app.slice(app.indexOf('function resumeAudioContextBestEffort('), app.indexOf('function ensureAudioPitchSource('));
  let resumed = 0;
  const audioContext = {state: 'interrupted', resume() {resumed++; return Promise.resolve();}};
  const context = {state: {audioContext}};
  vm.runInNewContext(source, context);
  for (const state of ['interrupted', 'suspended', 'running', 'closed']) {
    audioContext.state = state;
    context.resumeAudioContextBestEffort();
  }
  assert.equal(resumed, 2);
  assert.equal(context.state.audioContext, audioContext);
});

test('pending WebKit play promises require actual current-attempt decoder progress before startup can complete', () => {
  const source = app.slice(app.indexOf('function hasSplitPlaybackStartProgress('), app.indexOf('function syncSplitPlayer('));
  const state = {localShouldBePlaying: true, localPlaybackStartGeneration: 2, audioContext: {state: 'running'}};
  const context = {state};
  vm.runInNewContext(source, context);
  const session = {readyCommitted: true, startupProgressProbe: {generation: 2, videoTime: 3, audioTime: 2.8, frames: 20}};
  const video = {paused: false, seeking: false, readyState: 2, currentTime: 3.1, webkitDecodedFrameCount: 22};
  const audio = {paused: false, seeking: false, readyState: 2, currentTime: 2.9, bilikaraPitchSource: {}};
  assert.equal(context.hasSplitPlaybackStartProgress(session, video, audio), true);
  for (const alter of [() => {video.paused = true;}, () => {audio.seeking = true;},
    () => {video.webkitDecodedFrameCount = 21;}, () => {audio.currentTime = 2.8;}, () => {video.error = {};},
    () => {session.startupProgressProbe.generation = 1;}, () => {state.audioContext.state = 'suspended';}]) {
    const before = [structuredClone(session), structuredClone(video), structuredClone(audio), structuredClone(state)];
    alter(); assert.equal(context.hasSplitPlaybackStartProgress(session, video, audio), false);
    [session, video, audio, state].forEach((target, i) => {
      Object.keys(target).forEach(key => delete target[key]); Object.assign(target, before[i]);
    });
  }
});

test('iOS audio setup uses playback policy without activating on launch or enabling background execution',()=>{
  const audio=readFileSync(new URL('../src-tauri/src/ios_audio.rs',import.meta.url),'utf8');
  assert.match(audio,/AVAudioSessionCategoryPlayback/);
  assert.match(audio,/setCategory_error/);
  assert.doesNotMatch(audio,/\.setActive|PlayAndRecord|RecordPermission|setPreferredIOBufferDuration/);
  const ios=readFileSync(new URL('../src-tauri/src/ios.rs',import.meta.url),'utf8');
  assert.ok(ios.indexOf('mobile::start_diagnosed(') >= 0);
  assert.ok(ios.indexOf('ios_audio::configure()')<ios.indexOf('mobile::start_diagnosed('));
  assert.match(ios,/playback: "unverified"/);
  const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.ios.conf.json',import.meta.url),'utf8'));
  assert.equal(config.bundle.iOS.minimumSystemVersion,'15.0','Xcode 27 supported deployment floor, not device acceptance');
  assert.ok(config.bundle.iOS.frameworks.includes('AVFAudio'),'Rust staticlib dependencies must also be linked by the native Xcode target');
  const plist=readFileSync(new URL('../src-tauri/Info.ios.plist',import.meta.url),'utf8');
  assert.doesNotMatch(plist,/UIBackgroundModes|NSMicrophoneUsageDescription/);
});
