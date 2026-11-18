// Actual isolated renderer + virtual PulseAudio/X11 outputs. No device claim.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,openSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {virtualOutputs} from '../research/media-gstreamer/environment.mjs';
import {runNative,root} from '../tests/desktop_construction_support.mjs';
import {pcmWindows,pcmPulseEvents} from '../research/pcm-observer.mjs';
import {startPcmMonitor,timingFixture} from '../research/av-timing.mjs';
import {validateGstNativeNext} from '../tests/media_gstreamer_bridge.mjs';
import {validateNativeTail,validateNativeTimeline} from '../tests/media_gstreamer_timing.mjs';
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
for(const key of ['--sdk','--binary','--video','--audio','--output'])assert.ok(args.includes(key),key);
const diagnosticClock = args.includes('--clock') ? value('--clock') : 'sink';
assert.ok(['sink', 'system'].includes(diagnosticClock), 'use --clock sink or system');
const directory=path.resolve(value('--output'));assert.ok(!directory.startsWith(root+path.sep));mkdirSync(directory,{recursive:true});
const lab=await virtualOutputs(value('--sdk'),path.join(directory,'virtual-outputs'));
const flac=path.join(directory,'track-880.flac');
let child,recording;const events=[];
try {
  const generated=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=880:sample_rate=44100:duration=90','-c:a','flac',flac],process.env,30000);assert.equal(generated.status,0,generated.stderr);
  let program={playback_generation:1,item_id:'fixture',item_incarnation_id:'fixture-i1',artifact_set_id:'fixture-a1',selected_audio_variant_id:'aac'};
  const manifest={program,video:path.resolve(value('--video')),audio:[path.resolve(value('--audio')),flac],pulse_server:lab.environment.PULSE_SERVER,pulse_device:'rounda',diagnostic_clock:diagnosticClock,diagnostic_replay_eos:true};
  const collectionFixture=path.join(directory,'two-audio-tracks.mkv');
  const muxed=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',manifest.video,'-i',manifest.audio[0],'-i',flac,'-map','0:v:0','-map','1:a:0','-map','2:a:0','-c','copy',collectionFixture],process.env,30000);
  assert.equal(muxed.status,0,muxed.stderr);manifest.collection_fixture=collectionFixture;
  const coded=await timingFixture(path.join(directory,'playbin-timecode'),60);
  manifest.timing_video=coded.video;manifest.timing_audio=path.join(directory,'coded.flac');
  const converted=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',coded.audio,'-ar','44100','-c:a','flac',manifest.timing_audio],process.env,30000);assert.equal(converted.status,0,converted.stderr);
  const file=path.join(directory,'manifest.json');writeFileSync(file,JSON.stringify(manifest,null,2));
  async function playbinProbe(){
    const pcmFile=path.join(directory,'playbin3-sink.f32le'),monitor=startPcmMonitor(path.resolve(value('--sdk')),lab.environment,pcmFile),timeline=[];
    await monitor.ready;
    const c=spawn(path.resolve(value('--binary')),[file,'--playbin3-probe'],{env:lab.environment});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);
    let pending='',malformedLines=0;
    c.stdout.on('data',b=>{
      pending+=b;
      while(pending.includes('\n')){
        const end=pending.indexOf('\n'),line=pending.slice(0,end);
        pending=pending.slice(end+1);
        try { timeline.push({...JSON.parse(line),receivedMs:performance.now()}); }
        catch { malformedLines++; }
      }
    });
    const exit=await new Promise((resolve,reject)=>{c.once('close',(code,signal)=>resolve({code,signal}));c.once('error',reject);});
    await monitor.stop();
    writeFileSync(path.join(directory,'playbin3.jsonl'),out);writeFileSync(path.join(directory,'playbin3.stderr'),err);
    assert.deepEqual(exit,{code:0,signal:null},'playbin3 probe process failed; see its captured output');
    assert.equal(malformedLines+Number(Boolean(pending.trim())),0,'playbin3 probe must emit complete JSON observations');
    const windows=pcmWindows(readFileSync(pcmFile),48000,2,.25),chunks=monitor.chunks;
    for(const w of windows){const frame=w.atSeconds*48000;const chunk=chunks.find(c=>c.endFrame>=frame);w.monotonicMs=chunk?chunk.atMs-(chunk.endFrame-frame)/48000*1000:null;}
    const checks=[];
    for(const [caseName,frequency]of [['independent-aac',440],['independent-flac-restored',880],['collection-selection',440]]) {
      const begin=timeline.find(e=>e.type==='playbin3-case'&&e.case===caseName).receivedMs;
      const matched=windows.some(w=>w.monotonicMs>begin+600&&w.monotonicMs<begin+1800&&w.rms>.02&&Math.abs(w.toneHz-frequency)<10);
      checks.push({case:caseName,frequency,status:matched?'PASS':'FAIL'});assert.ok(matched,'actual playbin3 selected sink PCM '+caseName);
    }
    const selected=timeline.find(e=>e.type==='playbin3-select-request'&&e.phase==='switch-to-second-and-pitch');assert.ok(selected,'real two-audio collection');
    assert.ok(windows.some(w=>w.monotonicMs>selected.receivedMs+300&&w.monotonicMs<selected.receivedMs+3000&&w.rms>.02&&Math.abs(w.toneHz-880*2**(2/12))<12),'selected second stream with real Signalsmith sink PCM');
    const restored=timeline.find(e=>e.type==='playbin3-case-result'&&e.case==='independent-flac-restored');
    assert.ok(restored.position_ns>=12e9&&restored.position_ns<20e9,'reopened player restored program position');
    // Raw PTS alone is insufficient: retain GstSegment mappings AND identify
    // the actual source second in sink PCM. Investigation can PASS while a
    // candidate capability is FAIL; never convert that into product admission.
    const codedSeek=timeline.find(e=>e.type==='playbin3-restore-seek'&&e.case==='independent-coded-restored');assert.ok(codedSeek);
    const pulses=pcmPulseEvents(readFileSync(pcmFile),chunks).pulses;
    const afterSeek=pulses.filter(p=>p.atMs>codedSeek.receivedMs+700&&p.atMs<codedSeek.receivedMs+3200);
    assert.ok(afterSeek.length>=2,'actual coded auxiliary PCM after seek');
    const expectedSource=pulses.filter(p=>p.atMs>codedSeek.receivedMs&&p.atMs<codedSeek.receivedMs+3200&&p.toneHz>=975&&p.toneHz<1175);
    const independentSeek={status:expectedSource.length>=2?'PASS':'FAIL',targetSeconds:12,afterSeek,expectedSourceSeconds:'12..15 (1000..1150Hz)',mapping:timeline.find(e=>e.type==='playbin3-case-result'&&e.case==='independent-coded-restored'),qualification:'SDK-specific auxiliary seek; a FAIL is a candidate blocker, not proof all GStreamer/SDKs lack the capability'};
    writeFileSync(path.join(directory,'playbin3-output-evidence.json'),JSON.stringify({timeline,windows,checks,independentSeek,physical:'DEVICE-UNVERIFIED',continuousTrackSwitch:'NOT QUALIFIED'},null,2));console.log(JSON.stringify({playbin3Investigation:'PASS',independentAuxiliarySeek:independentSeek.status}));return out;
  }
  await validateNativeTail(path.resolve(value('--binary')),path.resolve(value('--sdk')),lab.environment,
    path.join(directory,'custom-tail'),diagnosticClock);
  console.log(JSON.stringify({customTailPcm:'PASS',diagnosticClock}));
  await playbinProbe();
  const pcmFile=path.join(directory,'actual-sink-monitor.f32le');
  recording=spawn(path.join(path.resolve(value('--sdk')),'usr/bin/parec'),['--device=rounda.monitor','--raw','--format=float32le','--rate=48000','--channels=2'],{env:lab.environment,stdio:['ignore',openSync(pcmFile,'wx'),openSync(path.join(directory,'parec.stderr'),'wx')]});
  child=spawn(path.resolve(value('--binary')),[file],{env:lab.environment,stdio:['pipe','pipe',openSync(path.join(directory,'renderer.stderr'),'wx')]});
  let pending='';const start=performance.now();
  child.stdout.on('data',b=>{pending+=b;while(pending.includes('\n')){const end=pending.indexOf('\n');const event=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);events.push({...event,receivedMs:performance.now()-start});}});
  const finished=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
  async function wait(predicate,description,timeout=10000){const end=performance.now()+timeout;while(performance.now()<end){const result=predicate();if(result)return result;assert.equal(child.exitCode,null,'renderer exited: '+JSON.stringify(events));await delay(20);}assert.fail(description+': '+JSON.stringify(events.slice(-3)));}
  let seq=0;const actions=[];
  async function command(action,parameters={},expected=program){const id=++seq;child.stdin.write(JSON.stringify({action,expected_program:expected,seq:id,...parameters})+'\n');const response=await wait(()=>events.find(e=>e.seq===id),'command '+action);actions.push({...response,atMs:performance.now()-start});return response;}
  await wait(()=>events.some(e=>e.type==='sample'&&e.pcm_frames>=48000),'actual startup PCM progression');
  assert.ok(events.some(e=>e.type==='clock'));
  for(const surfaceToken of ['host','audience']) {
    const reassigned=await command('surface',{surfaceToken});assert.equal(reassigned.accepted,true);assert.equal(reassigned.clock_preserved,true);
    // set_window_handle accepts an assignment before a streaming frame arrives.
    // Confirm actual output rather than treating a fixed sleep as readiness.
    const deadline=performance.now()+5000;let colors=0;
    while(colors<=4&&performance.now()<deadline){await command('surfaceProbe');colors=events.filter(e=>e.type==='surface-observation').at(-1).colors;if(colors<=4)await delay(100);}
    assert.ok(colors>4,'actual native surface pixels');
  }
  await delay(1500);assert.equal((await command('pause')).accepted,true);
  await wait(()=>events.some(e=>e.type==='sample'&&e.state==='Paused'),'actual pipeline pause settlement');
  await delay(700);const paused=events.filter(e=>e.type==='sample').at(-1).position_ns;
  assert.equal((await command('diagnosticClockLost')).accepted,true);
  await delay(700);assert.ok(Math.abs(events.filter(e=>e.type==='sample').at(-1).position_ns-paused)<5e7,'paused pipeline clock');
  assert.equal(events.filter(e=>e.type==='sample').at(-1).state,'Paused','clock loss must not override explicit pause');
  assert.equal((await command('play')).accepted,true);await delay(1000);
  assert.equal((await command('seek',{seconds:12})).accepted,true);await wait(()=>events.some(e=>e.type==='sample'&&e.position_ns>12e9),'seek observed');
  for(const milliseconds of [100,-100,0]){assert.equal((await command('delay',{milliseconds})).accepted,true);await delay(800);}
  assert.equal((await command('pitch',{semitones:2})).accepted,true);await delay(2000);
  assert.equal((await command('volume',{gain:.5,muted:true})).accepted,true);await delay(1500);
  assert.equal((await command('volume',{gain:1,muted:false})).accepted,true);await delay(1500);
  const old=program;program={...program,playback_generation:2,selected_audio_variant_id:'flac'};
  assert.equal((await command('track',{index:1,program},old)).accepted,true);await delay(2000);
  assert.equal((await command('pause',{},old)).reason,'stale-program');
  assert.equal((await command('surface',{surfaceToken:'unknown-window'})).accepted,false);
  assert.equal((await command('seek',{seconds:88})).accepted,true);
  const firstEos = await wait(() => events.find(e => e.type === 'eos'), 'drained EOS', 12000);
  assert.deepEqual(firstEos.program, program);
  assert.equal(firstEos.message_seqnum, firstEos.seek_seqnum);
  assert.equal((await command('diagnosticReplayEos')).accepted, true);
  await wait(() => events.some(e => e.type === 'eos-ignored' && e.reason === 'duplicate'), 'duplicate EOS ignored');
  assert.equal((await command('seek',{seconds:5})).accepted,true);assert.equal((await command('play')).accepted,true);
  const resumedAt = actions.at(-1).atMs;
  const resumedSeek = events.findLast(e => e.type === 'seek-inputs' && e.accepted);
  // The pipeline position can come from the decoded audio branch before the
  // visible sink prerolls. Track selection requires the recovered video clock.
  await wait(() => events.some(e => e.type === 'sink-segment' && e.sink === 'video' && e.seqnum === resumedSeek.seqnum)
    && events.some(e => e.type === 'sample' && e.receivedMs > resumedAt && e.seek_seqnum === resumedSeek.seqnum
      && e.video_position_ns > 5e9 && e.video_position_ns < 10e9 && e.video_rendered > 0 && !e.eos),
  'same-program video sink recovery');
  const beforeReplay = events.filter(e => e.type === 'eos-ignored').length;
  assert.equal((await command('diagnosticReplayEos')).accepted, true);
  const ignoreAfterSeek = await wait(() => events.filter(e => e.type === 'eos-ignored').slice(beforeReplay)[0], 'old EOS ignored after same-program Seek');
  assert.equal(ignoreAfterSeek.reason, 'stale-segment');
  assert.equal(ignoreAfterSeek.message_seqnum, firstEos.message_seqnum);

  const nextTrack = {...program,playback_generation:3,selected_audio_variant_id:'aac'};
  assert.equal((await command('track',{index:0,program:nextTrack})).accepted,true);
  program = nextTrack;
  assert.equal((await command('diagnosticReplayEos')).accepted, true);
  const ignoreAfterTrack = await wait(() => events.filter(e => e.type === 'eos-ignored').slice(beforeReplay + 1)[0], 'old EOS ignored after track generation changed');
  assert.equal(ignoreAfterTrack.reason, 'stale-segment');
  assert.equal(ignoreAfterTrack.message_seqnum, firstEos.message_seqnum);
  assert.notEqual(ignoreAfterTrack.seek_seqnum, ignoreAfterSeek.seek_seqnum);
  assert.equal(events.filter(e => e.type === 'eos').length, 1);

  assert.equal((await command('seek',{seconds:88})).accepted,true);
  const secondEos = await wait(() => events.filter(e => e.type === 'eos')[1], 'new generation drains after stale EOS', 12000);
  assert.deepEqual(secondEos.program, program);
  assert.equal(secondEos.message_seqnum, secondEos.seek_seqnum);
  assert.notEqual(secondEos.message_seqnum, firstEos.message_seqnum);
  await command('stop');const result=await finished;assert.equal(result.code,0);assert.ok(events.some(e=>e.type==='disposed'));
  recording.kill('SIGTERM');await new Promise(resolve=>recording.once('exit',resolve));recording=null;
  writeFileSync(path.join(directory,'events.json'),JSON.stringify({evidenceClass:'LINUX-VIRTUAL-OUTPUT',events,actions,result},null,2));
  assert.deepEqual(events.filter(e=>e.type==='error'),[]);
  for (const seek of events.filter(e => e.type === 'seek-inputs' && e.accepted)) {
    const inputs = events.filter(e => e.type === 'source-seek' && e.seqnum === seek.seqnum).map(e => e.input);
    assert.deepEqual(inputs.sort(), ['audio-input-0', 'audio-input-1', 'video-input'],
      `each decoder receives exactly one Seek for ${seek.seqnum}`);
  }
  assert.ok(events.some(e=>e.type==='sample'&&e.pcm_frames>10000&&e.pcm_peak>.01),'processed PCM reached sink branch');
  // Audio-server monitor independently checks the real sink path, not appsink.
  const pcm=readFileSync(pcmFile);let nonzero=0,max=0;for(let i=0;i+4<=pcm.length;i+=4){const v=pcm.readFloatLE(i);assert.ok(Number.isFinite(v),'finite real sink PCM');if(Math.abs(v)>.001)nonzero++;max=Math.max(max,Math.abs(v));}
  assert.ok(max<.5,'synthetic low-level tone must not acquire a garbage/clipping tail');
  assert.ok(nonzero>4800&&max>.01,'actual PulseAudio sink monitor must contain audio');
  const windows=pcmWindows(pcm);
  writeFileSync(path.join(directory,'pcm-windows.json'),JSON.stringify(windows,null,2));
  for(const frequency of [440,440*2**(2/12),880*2**(2/12)]) {
    assert.ok(windows.some(w=>w.rms>.02&&Math.abs(w.toneHz-frequency)<8),`actual sink tone ${frequency}`);
  }
  assert.ok(windows.some(w=>w.rms<1e-6),'actual sink silence');
  const bridge=await validateGstNativeNext(path.resolve(value('--binary')),lab.environment,path.resolve(value('--video')),path.resolve(value('--audio')),path.join(directory,'native-host-bridge'),diagnosticClock);
  const timeline=await validateNativeTimeline(path.resolve(value('--binary')),path.resolve(value('--sdk')),lab.environment,coded.video,coded.audio,manifest.timing_audio,path.join(directory,'custom-timeline'),diagnosticClock);
  writeFileSync(path.join(directory,'result.json'),JSON.stringify({status:timeline.status,customFunctional:'PASS',diagnosticClock,staleEosReplay:'PASS',nonzeroSamples:nonzero,peak:max,monitorSeconds:pcm.length/8/48000,
    precisionSync:'NOT QUALIFIED physically; correlated virtual timeline recorded separately',virtualTimeline:timeline.status,surfaceReassignment:'X11-VIRTUAL-OUTPUT',nativeHostNext:bridge.status,
    eosToNextObservedMs:bridge.eosToNextObservedMs,continuity:bridge.continuity},null,2));
  console.log(JSON.stringify({status:timeline.status,customFunctional:'PASS',directory,commands:actions.length,monitorSeconds:pcm.length/8/48000}));
  if(timeline.status!=='PASS')process.exitCode=2;
}catch(error){
  writeFileSync(path.join(directory,'failure.txt'),String(error.stack));
  writeFileSync(path.join(directory,'failed-events.json'),JSON.stringify(events,null,2));
  await runNative('ffmpeg',['-hide_banner','-loglevel','error','-f','x11grab','-video_size','1920x1080','-i',lab.environment.DISPLAY,'-frames:v','1','-threads','2',path.join(directory,'failure-surface.png')],lab.environment,10000);
  throw error;
}
finally{child?.kill('SIGTERM');recording?.kill('SIGTERM');await lab.close();}
