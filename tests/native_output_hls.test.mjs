import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

const source = readFileSync(new URL('../static/native-output.js', import.meta.url), 'utf8');

async function attach(period) {
  let player;
  class Hls {
    static Events = {ERROR:'error', FRAG_BUFFERED:'buffered', MANIFEST_PARSED:'manifest'};
    static isSupported() { return true; }
    listeners = new Map();
    levels = [];
    constructor() { player = this; }
    on(event, callback) { this.listeners.set(event, callback); }
    attachMedia() {}
    loadSource() {}
    startLoad() {}
    stopLoad() {}
    buffer(cc, start, end) { this.listeners.get('buffered')('buffered', {frag:{cc,start,end}}); }
  }
  const video = Object.assign(new EventTarget(), {
    currentTime:19, paused:true, ended:false, dataset:{},
    buffered:{length:1, start:()=>18, end:()=>24},
    canPlayType:()=>'', play:async()=>{video.paused=false;}, pause:()=>{video.paused=true;},
  });
  const window = {Hls};
  runInNewContext(source, {
    window, navigator:{vendor:''}, MediaSource:{isTypeSupported:()=>true},
    document:{createElement:()=>({}), head:{append:script=>script.onload()}},
  });
  const release = await window.BilikaraNativeOutput.attach(video, '/index.m3u8', {period});
  return {video,player,release};
}

test('late presentation notice retains an already buffered, completed incoming HLS period', async()=>{
  const {video,player,release} = await attach(3);
  player.buffer(3,19,20);
  release.pause();
  player.buffer(4,21,22);
  player.buffer(4,22,23);
  assert.equal(video.paused,true,'late buffer events do not restart a paused sink');
  const details = {live:false, endCC:4};
  player.levels = [{details}];
  let ended = 0;
  release.source('/index.m3u8', {period:4, ended:()=>ended++});
  assert.equal(player.levels[0].details,details,'keep the aligned manifest with ENDLIST');
  assert.equal(details.live,false,'the admitted period is already complete');
  assert.equal(video.currentTime,21,'enter the earliest retained fragment of the new period');
  assert.equal(video.dataset.nativeOutputPeriod,'4');
  assert.equal(video.paused,false);
  video.ended = true;
  video.dispatchEvent(new Event('ended'));
  assert.equal(ended,1);
});

test('reopening an older ENDLIST reloads with its alignment reference and waits for the new period', async()=>{
  const {video,player,release} = await attach(4);
  player.buffer(4,21,22);
  const details = {live:false, endCC:4};
  player.levels = [{details}];
  let ended = 0;
  release.source('/index.m3u8', {period:5, ended:()=>ended++});
  assert.equal(player.levels[0].details,details,'keep old sequence and timestamps for playlist merging');
  assert.equal(details.live,true,'allow hls.js to fetch the next generation');
  player.buffer(4,22,23);
  assert.equal(video.currentTime,21);
  assert.equal(video.paused,true);
  video.ended = true;
  video.dispatchEvent(new Event('ended'));
  assert.equal(ended,0,'a retired period cannot acknowledge the current EOS');
  video.ended = false;
  player.buffer(5,23,24);
  assert.equal(video.currentTime,23);
  assert.equal(video.dataset.nativeOutputPeriod,'5');
  assert.equal(video.paused,false);
});

test('the first fragment can finish appending while its selected period is paused', async()=>{
  const {video,player,release} = await attach(4);
  release.pause();
  player.buffer(4,21,22);
  assert.equal(video.paused,true);
  release.resume();
  assert.equal(video.currentTime,21);
  assert.equal(video.dataset.nativeOutputPeriod,'4');
  assert.equal(video.paused,false);
});
