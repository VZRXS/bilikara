// Portable policy/source checks; they do not qualify an Apple audio device.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const volume=app.slice(app.indexOf('function applyMediaVolume('),app.indexOf('function setupAudioPitchShifter('));

test('iOS attenuation and zero volume use one existing gain path, while desktop/Android keep native unity-range volume',()=>{
  for(const platform of ['ios','android','desktop']){
    const connections=[],changes=[],context={document:{documentElement:{dataset:{nativeHost:'true',hostPlatform:platform}}},
      state:{localPlayerVolume:1,localPlayerMuted:false,audioContext:{currentTime:2}},
      ensureAudioPitchSource(media){connections.push(media);media.bilikaraPitchSource={};media.bilikaraVolumeGain={
        gain:{value:context.state.localPlayerVolume,setTargetAtTime(value){changes.push(value);}},bilikaraTarget:context.state.localPlayerVolume};return media.bilikaraPitchSource;},
      resumeAudioContextBestEffort(){},setAppMessage(){assert.fail('working gain must not report unavailable');},t:key=>key};
    vm.runInNewContext(volume,context);
    const media={volume:1,paused:false};
    context.applyMediaVolume(media);
    assert.equal(connections.length,0,'Unity starts on native audio');
    for(const value of [.25,0,1]){context.state.localPlayerVolume=value;context.applyMediaVolume(media);}
    assert.equal(connections.length,platform==='ios'?1:0);
    assert.equal(media.volume,1);
    if(platform==='ios')assert.deepEqual(changes,[0,1]);
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

test('iOS audio setup uses playback policy without activating on launch or enabling background execution',()=>{
  const audio=readFileSync(new URL('../src-tauri/src/ios_audio.rs',import.meta.url),'utf8');
  assert.match(audio,/AVAudioSessionCategoryPlayback/);
  assert.match(audio,/setCategory_error/);
  assert.doesNotMatch(audio,/\.setActive|PlayAndRecord|RecordPermission|setPreferredIOBufferDuration/);
  const ios=readFileSync(new URL('../src-tauri/src/ios.rs',import.meta.url),'utf8');
  assert.ok(ios.indexOf('ios_audio::configure()')<ios.indexOf('mobile::start('));
  assert.match(ios,/playback: "unverified"/);
  const config=JSON.parse(readFileSync(new URL('../src-tauri/tauri.ios.conf.json',import.meta.url),'utf8'));
  assert.equal(config.bundle.iOS.minimumSystemVersion,'14.5','AVFAudio framework dependency floor, not device acceptance');
  const plist=readFileSync(new URL('../src-tauri/Info.ios.plist',import.meta.url),'utf8');
  assert.doesNotMatch(plist,/UIBackgroundModes|NSMicrophoneUsageDescription/);
});
