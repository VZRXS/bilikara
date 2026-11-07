import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app=readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('function diagnosticPlayerInfo('),app.indexOf('function internetRemoteDiagnosticsSnapshot('));
test('on-demand playback diagnostics compare delivered and applied commands without media addresses',()=>{
  const video={currentTime:42,playbackRate:1,paused:false,src:'https://private.example/video'},audio={currentTime:41.98,playbackRate:1,paused:false};
  const session={phase:'playing',playbackGeneration:9,readyCommitted:true,video,audio};
  const state={hostPlaybackSession:session,localShouldBePlaying:true,lastAppliedPlayerControlSeq:7,
    data:{player_control_command:{seq:8}},statePollInFlight:true,hasValidStateResponse:true};
  const diagnostic=vm.runInNewContext(source+';diagnosticPlayerInfo;',{
    state,window:{__TAURI__:{core:{invoke(){}}}},isCurrentHostPlaybackSession:value=>value===session,
    document:{hidden:false,querySelector:()=>({checked:false,disabled:true,closest:()=>({open:true})})},
  });
  const result=JSON.parse(JSON.stringify(diagnostic()));
  assert.equal(result.last_applied_control_seq,7);assert.equal(result.pending_control_seq,8);
  assert.equal(result.state_poll_in_flight,true);assert.equal(result.has_valid_state_response,true);
  assert.ok(!('event_source_state' in result));
  assert.equal(result.current_pair,true);assert.equal(result.video_time,42);assert.equal(result.audio_paused,false);
  assert.equal(result.automatic_disabled,true);assert.equal(result.volume_dialog_open,true);
  assert.ok(!JSON.stringify(result).includes('private.example'));
  state.hostPlaybackSession=null;
  const idle=diagnostic();assert.equal(idle.current_pair,false);assert.equal(idle.phase,'none');assert.equal(idle.audio_paused,true);
});

test('AV-delay recovery trace is automatic for eight seconds, bounded and contains only safe signal facts',()=>{
  const trace=app.slice(app.indexOf('function recordPlaybackTrace('),app.indexOf('function reportMediaDiagnostic('));
  let now=10000;
  const state={avDelayTraceUntil:18000,avDelayTraceSequence:3,avDelayTracePreviousOffset:-100,
    localShouldBePlaying:true,data:{player_settings:{av_offset_ms:100}},
    hostPlaybackSession:{logicalPlayIntent:true,audio:{src:'PRIVATE_AUDIO_URL',currentTime:20,readyState:4,
      bilikaraAudioClock:{holding:false,pending:false,resumeWanted:false,time:()=>20},
      bilikaraPitch:{snapshot:()=>({state:'active',applied:2})}},video:{currentTime:20.1,readyState:4,
      getVideoPlaybackQuality:()=>({totalVideoFrames:600,droppedVideoFrames:2})}},audioContext:{state:'running',currentTime:20}};
  const record=vm.runInNewContext(trace+';recordPlaybackTrace;',{state,Date:{now:()=>now}});
  record('av-delay-change','ui');
  for(let i=0;i<300;i++)record('seeked');
  assert.equal(state.playbackTrace.length,256);
  const last=state.playbackTrace.at(-1);assert.equal(last.logical_play_intent,true);
  assert.equal(last.av_delay_sequence,3);assert.equal(last.previous_offset_ms,-100);assert.equal(last.context_state,'running');
  assert.equal(last.pitch_phase,'active');assert.equal(last.dropped_frames,2);
  assert.ok(!JSON.stringify(state.playbackTrace).includes('PRIVATE'));
  now=18001;record('after-window');assert.equal(state.playbackTrace.at(-1).event,'seeked');
});
